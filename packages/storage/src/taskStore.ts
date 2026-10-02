// 目标任务存储层（P0）：tasks / task_runs / workflow_runs / workflow_agent_calls 四张表的
// SQLite 实现，落地 `@suanlizi/protocol` 的 TaskStorePort 契约（计划 §6.2 + §11.2 + §14.6）。
//
// 设计约束（盘点 §2 / §4.2）：
// - SQLite / WAL 是 Task、Run、WorkflowRun、AgentCall 的单一事实来源；thread.tags 只作缓存。
// - `task_runs` 不得成为第二套恢复真相：`recoverInterruptedRuns` 只镜像 Agent Checkpoint
//   （由注入的 `readCheckpoint(threadId)` 读取，缺省走现有 store 的 getLastCheckpoint）。
// - `TaskRun.checkpointId` 冻结编码为裸 `String(Checkpoint.turnId)`；恢复时必须断言
//   `ckpt.turnId === run.checkpointId`，不等视为被新 turn 取代 → interrupted，严禁 resume。
// - 所有更新方法带 `expectedVersion` 乐观锁，冲突抛 TaskError('TASK_VERSION_CONFLICT')；
//   状态迁移用 protocol 的 assertTaskRunTransition / assertTaskStatusTransition 服务端校验。
//
// 本模块只从 `./store.js` 做 type-only import（编译期擦除），运行时无循环依赖：
// store.ts 单向 import 本文件的 ensureTaskStoreSchema。
import type {
  Checkpoint,
  Task,
  TaskRun,
  TaskRunState,
  TaskStatus,
  WorkflowAgentCall,
  WorkflowRunRecord,
} from '@suanlizi/protocol';
import {
  TaskError,
  assertTaskRunTransition,
  assertTaskStatusTransition,
  isTaskRunTerminalState,
  validateTaskVersion,
} from '@suanlizi/protocol';
import type { TaskListFilter, TaskStorePort, WorkflowRunListFilter } from '@suanlizi/protocol';
import type { ThreadStore } from './store.js';

/** Narrow SQLite DB surface — structurally compatible with better-sqlite3. */
interface SqliteStatement {
  run(...params: unknown[]): void;
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}
interface SqliteDb {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
}

/** schema_migrations version reserved for the goal-task workflow store tables. */
export const TASK_STORE_MIGRATION_VERSION = 10;
export const TASK_STORE_MIGRATION_NAME = 'goal_task_workflow_store';

/**
 * 目标任务四张表的最终 DDL（计划 §6.2 基础上补齐 protocol 字段以支撑稳定往返）：
 * - tasks / task_runs 额外持久化 `version`（乐观锁，INTEGER NOT NULL DEFAULT 0）。
 * - task_runs 额外保存 `checkpoint_id TEXT`（裸 String(turnId)）与 `workflow_kind`（§14.8 数据层区分）。
 * - tasks 额外保存 `run_ids`（retry 追加历史 Run）、`interaction_mode`（§14.11 协议占位）与不可变来源 `origin`。
 * - workflow_agent_calls 额外保存 `evidence_id` / `thread_item_id`（§11.3 证据回流）。
 * JSON 字段一律以 TEXT 承载。
 */
const TASK_STORE_DDL = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL,
    objective TEXT NOT NULL,
    acceptance_criteria TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL,
    current_run_id TEXT,
    run_ids TEXT NOT NULL DEFAULT '[]',
    latest_plan TEXT,
    evidence_ids TEXT NOT NULL DEFAULT '[]',
    pending_input TEXT,
    interaction_mode TEXT,
    origin TEXT NOT NULL DEFAULT 'harness_shadow',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    completed_at TEXT,
    version INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_tasks_thread ON tasks(thread_id, status);

  CREATE TABLE IF NOT EXISTS task_runs (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    status TEXT NOT NULL,
    harness_run_id TEXT,
    workflow_run_id TEXT,
    workflow_kind TEXT,
    checkpoint_id TEXT,
    error TEXT,
    started_at TEXT,
    updated_at TEXT NOT NULL,
    completed_at TEXT,
    version INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_task_runs_task ON task_runs(task_id);
  CREATE INDEX IF NOT EXISTS idx_task_runs_status ON task_runs(status);

  CREATE TABLE IF NOT EXISTS workflow_runs (
    id TEXT PRIMARY KEY,
    task_run_id TEXT NOT NULL,
    script TEXT NOT NULL,
    script_hash TEXT NOT NULL,
    args TEXT,
    status TEXT NOT NULL,
    usage TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    completed_at TEXT,
    goal_run_id TEXT,
    evidence_id TEXT,
    result TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_workflow_runs_task_run ON workflow_runs(task_run_id);

  CREATE TABLE IF NOT EXISTS workflow_agent_calls (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    label TEXT,
    prompt TEXT NOT NULL,
    model TEXT,
    status TEXT NOT NULL,
    result TEXT,
    error TEXT,
    evidence_id TEXT,
    thread_item_id TEXT,
    result_hash TEXT,
    size_bytes INTEGER,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    started_at TEXT,
    completed_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_workflow_agent_calls_run ON workflow_agent_calls(run_id);
`;

/**
 * 幂等建表 + 注册 schema_migrations 版本号（复用项目现有版本号机制）。
 * 既被 LocalThreadStore.initSchema 迁移挂载点调用，也被 SqliteTaskStore 构造时兜底调用，
 * 保证任一入口都能独立确保表存在。CREATE TABLE IF NOT EXISTS 使重复执行结果一致。
 */
export function ensureTaskStoreSchema(db: SqliteDb, now: string = new Date().toISOString()): void {
  db.exec(TASK_STORE_DDL);
  // P6：旧库补列（CREATE TABLE IF NOT EXISTS 不会修改既有表）；幂等，已存在时跳过。
  const taskColumns = new Set(
    (db.prepare('PRAGMA table_info(tasks)').all() as Array<{ name: string }>).map((c) => c.name),
  );
  if (!taskColumns.has('origin')) {
    db.exec("ALTER TABLE tasks ADD COLUMN origin TEXT NOT NULL DEFAULT 'harness_shadow'");
  }
  // 历史与未知来源一律降级为内部影子记录，绝不误显示为用户入口任务。
  db.exec("UPDATE tasks SET origin = 'harness_shadow' WHERE origin IS NULL OR origin NOT IN ('explicit_goal', 'explicit_workflow', 'harness_shadow')");
  const workflowRunColumns = new Set(
    (db.prepare('PRAGMA table_info(workflow_runs)').all() as Array<{ name: string }>).map((c) => c.name),
  );
  if (!workflowRunColumns.has('goal_run_id')) db.exec('ALTER TABLE workflow_runs ADD COLUMN goal_run_id TEXT');
  if (!workflowRunColumns.has('evidence_id')) db.exec('ALTER TABLE workflow_runs ADD COLUMN evidence_id TEXT');
  if (!workflowRunColumns.has('result')) db.exec('ALTER TABLE workflow_runs ADD COLUMN result TEXT');
  const agentCallColumns = new Set(
    (db.prepare('PRAGMA table_info(workflow_agent_calls)').all() as Array<{ name: string }>).map((c) => c.name),
  );
  // §14.5：大结果句柄的结果指纹与字节大小（存量库幂等升级）。
  if (!agentCallColumns.has('result_hash')) db.exec('ALTER TABLE workflow_agent_calls ADD COLUMN result_hash TEXT');
  if (!agentCallColumns.has('size_bytes')) db.exec('ALTER TABLE workflow_agent_calls ADD COLUMN size_bytes INTEGER');
  db.prepare(
    'INSERT OR IGNORE INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)',
  ).run(TASK_STORE_MIGRATION_VERSION, TASK_STORE_MIGRATION_NAME, now);
}

/** SqliteTaskStore 依赖注入项。 */
export interface SqliteTaskStoreOptions {
  /**
   * 恢复真相读取入口，类型对齐 protocol Checkpoint。缺省时若给了 threadStore，
   * 走其 getLastCheckpoint；否则返回 null（无法镜像 checkpoint → 非终态一律 interrupted）。
   */
  readCheckpoint?: (threadId: string) => Promise<Checkpoint | null>;
  /** 现有 ThreadStore，用于缺省 readCheckpoint（getLastCheckpoint）。 */
  threadStore?: Pick<ThreadStore, 'getLastCheckpoint'>;
}

/**
 * SQLite 版 TaskStorePort。构造入参复用/包装 store.ts 注入的 db 句柄与 checkpoint 依赖，
 * 风格与 LocalThreadStore 一致。
 */
export class SqliteTaskStore implements TaskStorePort {
  private readonly db: SqliteDb;
  private readonly readCheckpoint: (threadId: string) => Promise<Checkpoint | null>;

  constructor(db: SqliteDb, options: SqliteTaskStoreOptions = {}) {
    this.db = db;
    if (options.readCheckpoint) {
      this.readCheckpoint = options.readCheckpoint;
    } else if (options.threadStore) {
      const threadStore = options.threadStore;
      this.readCheckpoint = (threadId) => threadStore.getLastCheckpoint(threadId);
    } else {
      this.readCheckpoint = async () => null;
    }
    // 兜底建表：即使未走 LocalThreadStore 装配点也能独立工作。
    ensureTaskStoreSchema(this.db);
  }

  // ─── Task ──────────────────────────────────────────────────────────────

  async createTask(task: Task): Promise<Task> {
    if (this.selectTask(task.id)) {
      throw new TaskError('TASK_ACTIVE_EXISTS', `Task ${task.id} already exists`, {
        taskId: task.id,
      });
    }
    this.db
      .prepare(
        `INSERT INTO tasks (
          id, thread_id, objective, acceptance_criteria, status, current_run_id, run_ids,
          latest_plan, evidence_ids, pending_input, interaction_mode, origin,
          created_at, updated_at, completed_at, version
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
      )
      .run(
        task.id,
        task.threadId,
        task.objective,
        JSON.stringify(task.acceptanceCriteria ?? []),
        task.status,
        task.currentRunId ?? null,
        JSON.stringify(task.runIds ?? []),
        jsonOrNull(task.latestPlan),
        JSON.stringify(task.evidenceIds ?? []),
        jsonOrNull(task.pendingInput),
        task.interactionMode ?? null,
        task.origin === 'explicit_goal' || task.origin === 'explicit_workflow'
          ? task.origin
          : 'harness_shadow',
        task.createdAt,
        task.updatedAt,
        task.completedAt ?? null,
      );
    return this.requireTask(task.id);
  }

  async getTask(id: string): Promise<Task | null> {
    const row = this.selectTask(id);
    return row ? rowToTask(row) : null;
  }

  async updateTask(
    id: string,
    patch: Partial<Omit<Task, 'id' | 'createdAt'>>,
    expectedVersion: number,
  ): Promise<Task> {
    const current = this.requireTaskRecord(id);
    validateTaskVersion(current.version, expectedVersion);
    if (patch.status !== undefined && patch.status !== current.status) {
      assertTaskStatusTransition(current.status, patch.status);
    }
    const sets: string[] = [];
    const params: unknown[] = [];
    const add = (column: string, value: unknown): void => {
      sets.push(`${column} = ?`);
      params.push(value);
    };
    // 可清字段用「键是否存在」而非「值是否 undefined」判定：调用方写 `field: undefined`
    // 是显式清空意图（如 resolveUserInput 清 pendingInput），仅靠 !== undefined 会把列留在旧值。
    const clears = (key: string): boolean => Object.prototype.hasOwnProperty.call(patch, key);
    if (patch.threadId !== undefined) add('thread_id', patch.threadId);
    if (patch.objective !== undefined) add('objective', patch.objective);
    if (patch.acceptanceCriteria !== undefined)
      add('acceptance_criteria', JSON.stringify(patch.acceptanceCriteria));
    if (patch.status !== undefined) add('status', patch.status);
    if (clears('currentRunId')) add('current_run_id', patch.currentRunId ?? null);
    if (patch.runIds !== undefined) add('run_ids', JSON.stringify(patch.runIds));
    if (clears('latestPlan')) add('latest_plan', jsonOrNull(patch.latestPlan));
    if (patch.evidenceIds !== undefined) add('evidence_ids', JSON.stringify(patch.evidenceIds));
    if (clears('pendingInput')) add('pending_input', jsonOrNull(patch.pendingInput));
    if (clears('interactionMode')) add('interaction_mode', patch.interactionMode ?? null);
    if (clears('completedAt')) add('completed_at', patch.completedAt ?? null);
    // version 由乐观锁统一管理：成功即 +1，updated_at 刷新为当前时刻。
    sets.push('version = version + 1');
    sets.push('updated_at = ?');
    params.push(new Date().toISOString());
    params.push(id);
    this.db
      .prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`)
      .run(...params);
    return this.requireTask(id);
  }

  async listTasks(filter: TaskListFilter = {}): Promise<Task[]> {
    const params: unknown[] = [];
    let sql = 'SELECT * FROM tasks WHERE 1 = 1';
    if (filter.threadId) {
      sql += ' AND thread_id = ?';
      params.push(filter.threadId);
    }
    if (filter.status && filter.status.length > 0) {
      sql += ` AND status IN (${filter.status.map(() => '?').join(', ')})`;
      params.push(...filter.status);
    }
    if (filter.origin && filter.origin.length > 0) {
      sql += ` AND origin IN (${filter.origin.map(() => '?').join(', ')})`;
      params.push(...filter.origin);
    }
    sql += ' ORDER BY updated_at DESC';
    const rows = this.db.prepare(sql).all(...params) as Record<string, unknown>[];
    return rows.map(rowToTask);
  }

  /** 一个 thread 同一时刻最多一个 active（非终态）Task 的辅助查询。 */
  async getActiveTask(threadId: string): Promise<Task | null> {
    const rows = this.db
      .prepare(
        `SELECT * FROM tasks WHERE thread_id = ?
         AND status NOT IN ('completed', 'cancelled', 'failed')
         ORDER BY updated_at DESC`,
      )
      .all(threadId) as Record<string, unknown>[];
    return rows.length > 0 ? rowToTask(rows[0]) : null;
  }

  // ─── TaskRun ───────────────────────────────────────────────────────────

  async createRun(run: TaskRun): Promise<TaskRun> {
    if (this.selectRun(run.id)) {
      throw new TaskError('TASK_ACTIVE_EXISTS', `Task run ${run.id} already exists`, {
        runId: run.id,
      });
    }
    this.db
      .prepare(
        `INSERT INTO task_runs (
          id, task_id, thread_id, kind, status, harness_run_id, workflow_run_id,
          workflow_kind, checkpoint_id, error, started_at, updated_at, completed_at, version
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
      )
      .run(
        run.id,
        run.taskId,
        run.threadId,
        run.kind,
        run.status,
        run.harnessRunId ?? null,
        run.workflowRunId ?? null,
        run.workflowKind ?? null,
        run.checkpointId ?? null,
        run.error ?? null,
        run.startedAt ?? null,
        run.updatedAt,
        run.completedAt ?? null,
      );
    return this.requireRun(run.id);
  }

  async getRun(id: string): Promise<TaskRun | null> {
    const row = this.selectRun(id);
    return row ? rowToRun(row) : null;
  }

  async updateRun(
    id: string,
    patch: Partial<Omit<TaskRun, 'id' | 'taskId'>>,
    expectedVersion: number,
  ): Promise<TaskRun> {
    const current = this.requireRunRecord(id);
    validateTaskVersion(current.version, expectedVersion);
    if (patch.status !== undefined && patch.status !== current.status) {
      assertTaskRunTransition(current.status, patch.status);
    }
    const sets: string[] = [];
    const params: unknown[] = [];
    const add = (column: string, value: unknown): void => {
      sets.push(`${column} = ?`);
      params.push(value);
    };
    if (patch.threadId !== undefined) add('thread_id', patch.threadId);
    if (patch.kind !== undefined) add('kind', patch.kind);
    if (patch.status !== undefined) add('status', patch.status);
    if (patch.harnessRunId !== undefined) add('harness_run_id', patch.harnessRunId ?? null);
    if (patch.workflowRunId !== undefined)
      add('workflow_run_id', patch.workflowRunId ?? null);
    if (patch.workflowKind !== undefined) add('workflow_kind', patch.workflowKind ?? null);
    if (patch.checkpointId !== undefined) add('checkpoint_id', patch.checkpointId ?? null);
    if (patch.error !== undefined) add('error', patch.error ?? null);
    if (patch.startedAt !== undefined) add('started_at', patch.startedAt ?? null);
    if (patch.completedAt !== undefined) add('completed_at', patch.completedAt ?? null);
    sets.push('version = version + 1');
    sets.push('updated_at = ?');
    params.push(new Date().toISOString());
    params.push(id);
    this.db
      .prepare(`UPDATE task_runs SET ${sets.join(', ')} WHERE id = ?`)
      .run(...params);
    return this.requireRun(id);
  }

  async listRuns(taskId: string): Promise<TaskRun[]> {
    const rows = this.db
      .prepare('SELECT * FROM task_runs WHERE task_id = ? ORDER BY rowid ASC')
      .all(taskId) as Record<string, unknown>[];
    return rows.map(rowToRun);
  }

  // ─── WorkflowRunRecord / AgentCall ─────────────────────────────────────

  async upsertWorkflowRun(record: WorkflowRunRecord): Promise<WorkflowRunRecord> {
    this.db
      .prepare(
        `INSERT INTO workflow_runs (
          id, task_run_id, script, script_hash, args, status, usage, created_at, updated_at, completed_at, goal_run_id, evidence_id, result
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          task_run_id = excluded.task_run_id,
          script = excluded.script,
          script_hash = excluded.script_hash,
          args = excluded.args,
          status = excluded.status,
          usage = excluded.usage,
          created_at = excluded.created_at,
          updated_at = excluded.updated_at,
          completed_at = excluded.completed_at,
          goal_run_id = excluded.goal_run_id,
          evidence_id = excluded.evidence_id,
          result = excluded.result`,
      )
      .run(
        record.id,
        record.taskRunId,
        record.script,
        record.scriptHash,
        jsonOrNull(record.args),
        record.status,
        JSON.stringify(record.usage),
        record.startedAt,
        record.updatedAt,
        record.completedAt ?? null,
        record.goalRunId ?? null,
        record.evidenceId ?? null,
        jsonOrNull(record.result),
      );
    // 若记录自带 agentCalls，则一并写入子表（INSERT OR REPLACE，按 id 幂等，不做删除以避免双写覆盖单独记录的调用）。
    for (const call of record.agentCalls ?? []) {
      await this.recordAgentCall(record.id, call);
    }
    return this.requireWorkflowRun(record.id);
  }

  async getWorkflowRun(id: string): Promise<WorkflowRunRecord | null> {
    const row = this.db
      .prepare('SELECT * FROM workflow_runs WHERE id = ?')
      .get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    return rowToWorkflowRun(row, await this.listAgentCalls(id));
  }

  async listWorkflowRuns(filter?: WorkflowRunListFilter): Promise<WorkflowRunRecord[]> {
    const rows = (
      filter?.goalRunId
        ? this.db.prepare('SELECT * FROM workflow_runs WHERE goal_run_id = ? ORDER BY rowid ASC').all(filter.goalRunId)
        : this.db.prepare('SELECT * FROM workflow_runs ORDER BY rowid ASC').all()
    ) as Record<string, unknown>[];
    const out: WorkflowRunRecord[] = [];
    for (const row of rows) {
      const id = String(row.id);
      out.push(rowToWorkflowRun(row, await this.listAgentCalls(id)));
    }
    return out;
  }

  async recordAgentCall(runId: string, call: WorkflowAgentCall): Promise<WorkflowAgentCall> {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO workflow_agent_calls (
          id, run_id, label, prompt, model, status, result, error, evidence_id, thread_item_id,
          result_hash, size_bytes,
          input_tokens, output_tokens, started_at, completed_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          run_id = excluded.run_id,
          label = excluded.label,
          prompt = excluded.prompt,
          model = excluded.model,
          status = excluded.status,
          result = excluded.result,
          error = excluded.error,
          evidence_id = excluded.evidence_id,
          thread_item_id = excluded.thread_item_id,
          result_hash = excluded.result_hash,
          size_bytes = excluded.size_bytes,
          input_tokens = excluded.input_tokens,
          output_tokens = excluded.output_tokens,
          started_at = excluded.started_at,
          completed_at = excluded.completed_at,
          updated_at = excluded.updated_at`,
      )
      .run(
        call.id,
        runId,
        call.label ?? null,
        call.prompt,
        call.model ?? null,
        call.status,
        jsonOrNull(call.result),
        call.error ?? null,
        call.evidenceId ?? null,
        call.threadItemId ?? null,
        call.resultHash ?? null,
        call.resultSize ?? null,
        call.inputTokens,
        call.outputTokens,
        call.startedAt ?? null,
        call.completedAt ?? null,
        now,
        now,
      );
    return this.requireAgentCall(call.id);
  }

  async updateAgentCall(runId: string, call: WorkflowAgentCall): Promise<WorkflowAgentCall> {
    if (!this.selectAgentCall(call.id)) {
      throw new TaskError(
        'WORKFLOW_RUN_NOT_FOUND',
        `Workflow agent call ${call.id} not found`,
        { workflowRunId: runId },
      );
    }
    return this.recordAgentCall(runId, call);
  }

  async listAgentCalls(runId: string): Promise<WorkflowAgentCall[]> {
    const rows = this.db
      .prepare('SELECT * FROM workflow_agent_calls WHERE run_id = ? ORDER BY rowid ASC')
      .all(runId) as Record<string, unknown>[];
    return rows.map(rowToAgentCall);
  }

  // ─── Recovery scan（计划 §11.2 / 盘点 §4.2，只镜像 Agent Checkpoint） ──────

  /**
   * 启动扫描：把非终态 task_runs 依据现有 Agent Checkpoint 回写为镜像状态。
   * 恢复真相只存在于 Agent Checkpoint，本方法不写第二份真相。回写走同一版本递增与 updated_at
   * 刷新；恢复路径保持 bypass 用户态迁移表（协议补边后大部分目标已在表内，但如
   * interrupted → completed 这类“对已标 interrupted 的 Run 事后按 checkpoint 终态补记”
   * 的镜像组合不在用户态迁移语义内，统一由恢复单点承担）。
   * 返回本次被改写的 run 列表。单进程假设：isLive 由调用方注入进程内活跃 controller 判据。
   */
  async recoverInterruptedRuns(isLive: (run: TaskRun) => boolean): Promise<TaskRun[]> {
    const rows = this.db
      .prepare(
        `SELECT * FROM task_runs
         WHERE status NOT IN ('completed', 'cancelled', 'failed')
         ORDER BY rowid ASC`,
      )
      .all() as Record<string, unknown>[];
    const changed: TaskRun[] = [];
    for (const row of rows) {
      const run = rowToRun(row);
      const ckpt = await this.readCheckpoint(run.threadId);
      const target = decideRecoveryTarget(run, ckpt, isLive);
      if (target === 'skip' || target === run.status) continue;
      changed.push(this.writeRunRecovery(run, target));
    }
    return changed;
  }

  /** 恢复回写：bypass 用户态迁移表，仅镜像 checkpoint，仍递增 version / 刷新 updated_at。 */
  private writeRunRecovery(run: TaskRun, target: TaskRunState): TaskRun {
    const now = new Date().toISOString();
    const sets = ['status = ?', 'version = version + 1', 'updated_at = ?'];
    const params: unknown[] = [target, now];
    if (isTaskRunTerminalState(target)) {
      sets.push('completed_at = ?');
      params.push(run.completedAt ?? now);
    }
    params.push(run.id);
    this.db
      .prepare(`UPDATE task_runs SET ${sets.join(', ')} WHERE id = ?`)
      .run(...params);
    return this.requireRun(run.id);
  }

  // ─── internal helpers ──────────────────────────────────────────────────

  private selectTask(id: string): Record<string, unknown> | undefined {
    return this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
  }

  private requireTaskRecord(id: string): Task {
    const row = this.selectTask(id);
    if (!row) throw new TaskError('TASK_NOT_FOUND', `Task ${id} not found`, { taskId: id });
    return rowToTask(row);
  }

  private requireTask(id: string): Task {
    return this.requireTaskRecord(id);
  }

  private selectRun(id: string): Record<string, unknown> | undefined {
    return this.db.prepare('SELECT * FROM task_runs WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
  }

  private requireRunRecord(id: string): TaskRun {
    const row = this.selectRun(id);
    if (!row) {
      throw new TaskError('TASK_RUN_NOT_FOUND', `Task run ${id} not found`, { runId: id });
    }
    return rowToRun(row);
  }

  private requireRun(id: string): TaskRun {
    return this.requireRunRecord(id);
  }

  private requireWorkflowRun(id: string): Promise<WorkflowRunRecord> {
    return this.getWorkflowRun(id).then((record) => {
      if (!record) {
        throw new TaskError('WORKFLOW_RUN_NOT_FOUND', `Workflow run ${id} not found`, {
          workflowRunId: id,
        });
      }
      return record;
    });
  }

  private selectAgentCall(id: string): Record<string, unknown> | undefined {
    return this.db.prepare('SELECT * FROM workflow_agent_calls WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
  }

  private requireAgentCall(id: string): WorkflowAgentCall {
    const row = this.selectAgentCall(id);
    if (!row) {
      throw new TaskError('WORKFLOW_RUN_NOT_FOUND', `Workflow agent call ${id} not found`, {});
    }
    return rowToAgentCall(row);
  }
}

/**
 * 恢复决策（盘点 §4.2 映射表）。返回目标 TaskRunState 或 'skip'（保持原状、不回写）。
 * 顺序：先判被取代 → 再判活跃跳过 → 无 checkpoint → terminal 回写 → waiting_user_input → 其余 interrupted。
 */
function decideRecoveryTarget(
  run: TaskRun,
  ckpt: Checkpoint | null,
  isLive: (run: TaskRun) => boolean,
): TaskRunState | 'skip' {
  // (1) checkpointId 为裸 String(turnId)；ckpt.turnId 不等 → 被新 turn 取代 → interrupted（严禁 resume）。
  if (ckpt && run.checkpointId && String(ckpt.turnId) !== String(run.checkpointId)) {
    return 'interrupted';
  }
  const status = ckpt?.status;
  const executionStatus = ckpt?.executionStatus;
  const runningActive = status === 'running' || executionStatus === 'running';
  const notExpired = !ckpt?.expiresAt || Date.now() < Date.parse(ckpt.expiresAt);
  // (2) running 且未过期且有活跃 controller → 跳过，交给在线执行继续。
  if (runningActive && notExpired && isLive(run)) {
    return 'skip';
  }
  // (3) 无 checkpoint → 崩溃遗留 → interrupted。
  if (!ckpt) {
    return 'interrupted';
  }
  // (4) terminal 状态 → 回写对应终态。
  if (status === 'completed' || status === 'terminal' || executionStatus === 'terminal') {
    return 'completed';
  }
  if (status === 'failed') {
    return 'failed';
  }
  if (status === 'interrupted' || status === 'stale') {
    return 'interrupted';
  }
  // (5) waiting_user_input → blocked。
  if (
    status === 'waiting_user_input' ||
    executionStatus === 'waiting_user_input' ||
    (ckpt.decisionRequest != null && ckpt.decisionRequest.status === 'pending')
  ) {
    return 'blocked';
  }
  // (6) running 但未活跃 / stopping / 其它中间态 → interrupted（不 resume，不写第二份真相）。
  return 'interrupted';
}

// ─── Row ↔ entity mappers ──────────────────────────────────────────────────

function rowToTask(row: Record<string, unknown>): Task {
  const task: Task = {
    id: String(row.id),
    threadId: String(row.thread_id),
    objective: String(row.objective),
    acceptanceCriteria: parseJsonArray(row.acceptance_criteria),
    status: row.status as TaskStatus,
    runIds: parseJsonArray(row.run_ids),
    evidenceIds: parseJsonArray(row.evidence_ids),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    version: Number(row.version ?? 0),
  };
  const currentRunId = row.current_run_id;
  if (currentRunId != null) task.currentRunId = String(currentRunId);
  const latestPlan = parseJsonObject<NonNullable<Task['latestPlan']>>(row.latest_plan);
  if (latestPlan) task.latestPlan = latestPlan;
  const pendingInput = parseJsonObject<NonNullable<Task['pendingInput']>>(row.pending_input);
  if (pendingInput) task.pendingInput = pendingInput;
  const completedAt = row.completed_at;
  if (completedAt != null) task.completedAt = String(completedAt);
  // 旧库无来源/非法来源只按影子记录解释，避免其泄漏进用户入口的运行观察。
  task.origin = row.origin === 'explicit_goal' || row.origin === 'explicit_workflow'
    ? row.origin
    : 'harness_shadow';
  const interactionMode = row.interaction_mode;
  if (interactionMode != null) {
    task.interactionMode = interactionMode as NonNullable<Task['interactionMode']>;
  }
  return task;
}

function rowToRun(row: Record<string, unknown>): TaskRun {
  const run: TaskRun = {
    id: String(row.id),
    taskId: String(row.task_id),
    threadId: String(row.thread_id),
    kind: row.kind as TaskRun['kind'],
    status: row.status as TaskRunState,
    updatedAt: String(row.updated_at),
    version: Number(row.version ?? 0),
  };
  if (row.harness_run_id != null) run.harnessRunId = String(row.harness_run_id);
  if (row.workflow_run_id != null) run.workflowRunId = String(row.workflow_run_id);
  if (row.workflow_kind != null) run.workflowKind = row.workflow_kind as TaskRun['workflowKind'];
  if (row.checkpoint_id != null) run.checkpointId = String(row.checkpoint_id);
  if (row.error != null) run.error = String(row.error);
  if (row.started_at != null) run.startedAt = String(row.started_at);
  if (row.completed_at != null) run.completedAt = String(row.completed_at);
  return run;
}

function rowToWorkflowRun(
  row: Record<string, unknown>,
  agentCalls: WorkflowAgentCall[],
): WorkflowRunRecord {
  return {
    id: String(row.id),
    taskRunId: String(row.task_run_id),
    script: String(row.script),
    scriptHash: String(row.script_hash),
    args: parseUnknown(row.args),
    status: row.status as WorkflowRunRecord['status'],
    agentCalls,
    usage: parseJsonObject<WorkflowRunRecord['usage']>(row.usage) ?? {
      inputTokens: 0,
      outputTokens: 0,
      agentCallCount: 0,
      durationMs: 0,
    },
    startedAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    completedAt: row.completed_at != null ? String(row.completed_at) : undefined,
    goalRunId: row.goal_run_id != null ? String(row.goal_run_id) : undefined,
    evidenceId: row.evidence_id != null ? String(row.evidence_id) : undefined,
    result: parseUnknown(row.result),
  };
}

function rowToAgentCall(row: Record<string, unknown>): WorkflowAgentCall {
  const call: WorkflowAgentCall = {
    id: String(row.id),
    prompt: String(row.prompt),
    status: row.status as WorkflowAgentCall['status'],
    inputTokens: Number(row.input_tokens ?? 0),
    outputTokens: Number(row.output_tokens ?? 0),
  };
  if (row.label != null) call.label = String(row.label);
  if (row.model != null) call.model = String(row.model);
  const result = parseUnknownSafe(row.result);
  if (result.found) call.result = result.value;
  if (row.error != null) call.error = String(row.error);
  if (row.evidence_id != null) call.evidenceId = String(row.evidence_id);
  if (row.thread_item_id != null) call.threadItemId = String(row.thread_item_id);
  if (row.result_hash != null) call.resultHash = String(row.result_hash);
  if (row.size_bytes != null) call.resultSize = Number(row.size_bytes);
  if (row.started_at != null) call.startedAt = String(row.started_at);
  if (row.completed_at != null) call.completedAt = String(row.completed_at);
  return call;
}

// ─── JSON helpers (JSON 字段以 TEXT 存储) ──────────────────────────────────

function jsonOrNull(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  return JSON.stringify(value);
}

function parseJsonArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value !== 'string' || value === '') return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function parseJsonObject<T>(value: unknown): T | undefined {
  if (value == null || value === '') return undefined;
  if (typeof value === 'object') return value as T;
  try {
    return JSON.parse(String(value)) as T;
  } catch {
    return undefined;
  }
}

/** 承载 args / result 这类 unknown：区分“缺省”与“存在（含 null）”。 */
function parseUnknown(value: unknown): unknown {
  return parseUnknownSafe(value).value;
}

function parseUnknownSafe(value: unknown): { found: boolean; value: unknown } {
  if (value == null) return { found: false, value: undefined };
  if (typeof value !== 'string') return { found: true, value };
  try {
    return { found: true, value: JSON.parse(value) };
  } catch {
    return { found: true, value };
  }
}
