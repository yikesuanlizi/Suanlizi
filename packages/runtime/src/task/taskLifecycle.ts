// Task / TaskRun 生命周期纯编排（计划 §5.1、§5.3、§6.3、§11.4、§14.1）。
//
// 设计约束：
// 1. 只依赖注入的 `TaskStorePort`（类型来自 `@suanlizi/protocol`），**绝不 import @suanlizi/storage**，
//    保持 `protocol → storage/runtime → api` 的单向依赖（盘点 §2 冻结契约）。
// 2. 状态迁移规则一律走 `@suanlizi/protocol` 的 `assertTaskRunTransition` /
//    `assertTaskStatusTransition` / `validateTaskVersion`，本模块不另起第二套迁移表（§11.1/§11.4）。
// 3. 一个 Thread 同一时刻最多一个 active Task：创建前必须 `listTasks` 查询（服务端校验，
//    不信任调用方传入的状态），冲突抛 `TASK_ACTIVE_EXISTS`（§5.1）。
// 4. retry 只新建 queued Run 并追加 `runIds`，绝不修改旧 Run 的终态（§5.1 / §11.4）。
// 5. 本模块不做第二套 GoalEvaluator（§14.1）：GoalTracker / GoalEvaluation 仍是评估唯一载体，
//    Run→Task 的终态推导只覆盖 failed / cancelled，`completed` Run 是否让 Task completed
//    由 P3 接入的验收 gate（acceptanceCriteria + Evidence 硬校验）决定。
//
// 事件：终态事件 `task.run.terminal` 等（§14.9 集中事件目录）由上层 API/SSE 依据本模块返回值
// 记录，本模块不持有事件总线，避免与 `taskRuntimeEvents` 双写。

import {
  TaskError,
  assertTaskRunTransition,
  assertTaskStatusTransition,
  canTransitionTaskRun,
  isTaskRunTerminalState,
  isTaskTerminalState,
  validateTaskVersion,
} from '@suanlizi/protocol';
import type {
  PendingUserInput,
  Task,
  TaskInteractionMode,
  TaskOrigin,
  TaskRun,
  TaskRunKind,
  TaskRunState,
  TaskStatus,
  TaskStorePort,
  WorkflowKind,
} from '@suanlizi/protocol';

// ─── 常量与小工具 ────────────────────────────────────────────────────────────

/** 非终态 Task 状态集合（active 冲突检测用；与 protocol 的终态集合互补）。 */
export const TASK_NON_TERMINAL_STATUSES: readonly TaskStatus[] = [
  'pending',
  'running',
  'blocked',
];

function nowIso(): string {
  return new Date().toISOString();
}

let idSequence = 0;

function randomToken(): string {
  return Math.random().toString(36).slice(2, 8);
}

/** Task id 生成器（可通过入参覆盖，保证测试确定性）。 */
export function newTaskId(): string {
  idSequence += 1;
  return `task_${Date.now().toString(36)}_${idSequence.toString(36)}${randomToken()}`;
}

/** TaskRun id 生成器（可通过入参覆盖，保证测试确定性）。 */
export function newRunId(): string {
  idSequence += 1;
  return `run_${Date.now().toString(36)}_${idSequence.toString(36)}${randomToken()}`;
}

function normalizeCriteria(criteria: readonly string[] | undefined): string[] {
  return uniqueNonEmpty(criteria);
}

function uniqueNonEmpty(values: readonly string[] | undefined): string[] {
  return [...new Set((values ?? []).map((value) => value.trim()).filter((value) => value.length > 0))];
}

/** 兼容旧数据：只有精确的 explicit_goal 是 Goal，其余缺失/非法来源一律按 Harness shadow 处理。 */
export function effectiveTaskOrigin(task: Pick<Task, 'origin'>): TaskOrigin {
  return task.origin === 'explicit_goal' ? 'explicit_goal' : 'harness_shadow';
}

/** Run 的字段形状校验：goal / workflow 的关联字段互斥（§14.8 子类型必须可区分）。 */
function assertRunShape(input: {
  kind: TaskRunKind;
  harnessRunId?: string;
  workflowRunId?: string;
  workflowKind?: WorkflowKind;
}): void {
  if (input.kind !== 'goal' && input.kind !== 'workflow') {
    throw new Error(`invalid TaskRunKind: ${String(input.kind)}`);
  }
  if (input.kind === 'goal') {
    if (input.workflowKind !== undefined || input.workflowRunId !== undefined) {
      throw new Error("goal runs must not carry workflowRunId/workflowKind (§14.8: workflowKind is only meaningful for kind='workflow')");
    }
    return;
  }
  if (!input.workflowKind) {
    throw new Error("workflow runs must declare workflowKind ('blueprint' | 'script') (§14.8)");
  }
}

async function requireTask(port: TaskStorePort, taskId: string): Promise<Task> {
  const task = await port.getTask(taskId);
  if (!task) {
    throw new TaskError('TASK_NOT_FOUND', `task ${taskId} not found`, { taskId });
  }
  return task;
}

async function requireRun(port: TaskStorePort, runId: string): Promise<TaskRun> {
  const run = await port.getRun(runId);
  if (!run) {
    throw new TaskError('TASK_RUN_NOT_FOUND', `task run ${runId} not found`, { runId });
  }
  return run;
}

/**
 * 查询同 thread 内的 active Task（服务端校验入口，§5.1）。
 * 先用端口的 status 过滤，再本地按终态集合复核 —— 端口实现忽略过滤时也不会漏判。
 */
export async function findActiveTask(
  port: TaskStorePort,
  threadId: string,
  origin?: TaskOrigin,
): Promise<Task | null> {
  const listed = await port.listTasks({
    threadId,
    status: TASK_NON_TERMINAL_STATUSES,
    ...(origin ? { origin: [origin] } : {}),
  });
  for (const task of listed ?? []) {
    if (task.threadId !== threadId) continue;
    if (origin && effectiveTaskOrigin(task) !== origin) continue;
    if (isTaskTerminalState(task.status)) continue;
    return task;
  }
  return null;
}

// ─── 创建：Task(pending, v0) + 首个 Run(queued) ──────────────────────────────

export interface CreateTaskWithRunInput {
  threadId: string;
  objective: string;
  acceptanceCriteria: string[];
  kind: TaskRunKind;
  /** kind='goal' 时关联既有 Harness run id。 */
  harnessRunId?: string;
  /** kind='workflow' 时关联 WorkflowRunRecord id。 */
  workflowRunId?: string;
  /** kind='workflow' 时的子类型。 */
  workflowKind?: WorkflowKind;
  /** 协议占位，第一版固定 supervised（§14.11）。 */
  interactionMode?: TaskInteractionMode;
  /** 来源不可变：普通 Harness 留在影子记录，用户 Goal 显式写入。 */
  origin?: TaskOrigin;
  /** 确定性 id 注入点（测试 / 上层 id 生成器）。 */
  ids?: { taskId?: string; runId?: string };
  now?: string;
}

export interface CreateTaskWithRunResult {
  task: Task;
  run: TaskRun;
}

/**
 * 建 Task（`pending`, `version: 0`）+ 首个 Run（`queued`, `version: 0`），并把 runId 回写进
 * `runIds` / `currentRunId`。同一 thread 已有非终态 Task 时抛 `TaskError('TASK_ACTIVE_EXISTS')`。
 *
 * 注意 Task 仍是 `pending`：Task 进入 `running` 由首个 Run 真正起跑时通过
 * `applyTaskSyncFromRun` 推导，避免「创建了但没跑」被误报为运行中。
 */
export async function createTaskWithRun(
  port: TaskStorePort,
  input: CreateTaskWithRunInput,
): Promise<CreateTaskWithRunResult> {
  const objective = (input.objective ?? '').trim();
  if (!objective) {
    throw new Error('createTaskWithRun: objective must be a non-empty string');
  }
  const threadId = (input.threadId ?? '').trim();
  if (!threadId) {
    throw new Error('createTaskWithRun: threadId must be a non-empty string');
  }
  assertRunShape(input);

  const now = input.now ?? nowIso();
  const origin = input.origin ?? 'harness_shadow';
  const active = await findActiveTask(port, threadId, origin);
  if (active) {
    throw new TaskError(
      'TASK_ACTIVE_EXISTS',
      `thread ${threadId} already has an active task ${active.id} (${active.status})`,
      { threadId, taskId: active.id, from: active.status, to: 'pending' },
    );
  }

  const createdTask = await port.createTask({
    id: input.ids?.taskId ?? newTaskId(),
    threadId,
    objective,
    acceptanceCriteria: normalizeCriteria(input.acceptanceCriteria),
    status: 'pending',
    runIds: [],
    evidenceIds: [],
    createdAt: now,
    updatedAt: now,
    version: 0,
    interactionMode: input.interactionMode ?? 'supervised',
    origin,
  });

  const run = await port.createRun({
    id: input.ids?.runId ?? newRunId(),
    taskId: createdTask.id,
    threadId,
    kind: input.kind,
    status: 'queued',
    harnessRunId: input.harnessRunId,
    workflowRunId: input.workflowRunId,
    workflowKind: input.workflowKind,
    updatedAt: now,
    version: 0,
  });

  const task = await port.updateTask(
    createdTask.id,
    {
      runIds: [run.id],
      currentRunId: run.id,
      updatedAt: now,
      version: createdTask.version + 1,
    },
    createdTask.version,
  );

  return { task, run };
}

// ─── Run 迁移（终态幂等单点） ────────────────────────────────────────────────

export interface TransitionRunOptions {
  /** 乐观锁期望版本；缺省用刚读到的 run.version（等价于「无并发前提的单向推进」）。 */
  expectedVersion?: number;
  error?: string;
  checkpointId?: string;
  /** Evidence 关联由上层写入 Task.evidenceIds；这里只做过程态迁移。 */
  now?: string;
}

/**
 * 校验并推进一次 TaskRun 迁移。
 *
 * - 迁移合法性只由 protocol 的 `assertTaskRunTransition` 决定（终态抛 `TASK_TERMINAL_STATE`，
 *   其余非法组合抛 `TASK_INVALID_TRANSITION`）。
 * - **终态迁移幂等单点**：目标态与当前态相同直接返回既有 Run，不再写库，因此
 *   「重复 cancel / 重复 fail / 重启后补记终态」不会产生第二次终态写入或版本抖动。
 * - 进入终态时补 `completedAt`，进入 running 且缺 `startedAt` 时补 `startedAt`。
 */
export async function transitionRun(
  port: TaskStorePort,
  runId: string,
  to: TaskRunState,
  opts: TransitionRunOptions = {},
): Promise<TaskRun> {
  const run = await requireRun(port, runId);

  if (opts.expectedVersion !== undefined) {
    validateTaskVersion(run.version, opts.expectedVersion);
  }

  // 幂等单点：同态直接返回，不重复写。
  if (run.status === to) return run;

  // 非法迁移 / 终态无出口 —— 由 protocol 抛稳定错误码。
  assertTaskRunTransition(run.status, to);

  const now = opts.now ?? nowIso();
  const terminal = isTaskRunTerminalState(to);
  const patch: Partial<Omit<TaskRun, 'id' | 'taskId'>> = {
    status: to,
    updatedAt: now,
    version: run.version + 1,
  };
  if (opts.error !== undefined) patch.error = opts.error;
  if (opts.checkpointId !== undefined) patch.checkpointId = opts.checkpointId;
  if (to === 'running' && !run.startedAt) patch.startedAt = now;
  if (terminal) patch.completedAt = now;

  return port.updateRun(runId, patch, run.version);
}

/** 读取并迁移（供 API 层按 id 直接驱动）。 */
export async function transitionRunOfTask(
  port: TaskStorePort,
  taskId: string,
  to: TaskRunState,
  opts: TransitionRunOptions = {},
): Promise<TaskRun> {
  const task = await requireTask(port, taskId);
  if (!task.currentRunId) {
    throw new TaskError('TASK_RUN_NOT_FOUND', `task ${taskId} has no current run`, { taskId });
  }
  return transitionRun(port, task.currentRunId, to, opts);
}

// ─── Run 完成写入（收敛入口，合法性仍完全由迁移表决定） ─────────────────────────

export interface CompleteRunOptions {
  expectedVersion?: number;
  now?: string;
}

/**
 * 把一个 `running` Run 写为 `completed`。
 *
 * 协议补边后（`running -> completed` 已在 `TASK_RUN_TRANSITIONS` 内），本函数不再
 * 绕过状态机，只是 `transitionRun` 的收敛入口：
 * 1. 乐观锁、幂等单点、completedAt 补写均由 `transitionRun` 统一处理；
 * 2. 非 `running` 来源（queued/paused/blocked/interrupted）一律被迁移表拒为
 *    `TASK_INVALID_TRANSITION`，终态来源拒为 `TASK_TERMINAL_STATE`；
 * 3. **不推导 Task.completed** —— Run 完成不等于目标达成，Task 终态由 §14.1 的
 *    GoalTracker 验收链路（P3 gate）决定，`syncTaskFromRun` 对 completed Run 一律返回 null。
 */
export async function completeRun(
  port: TaskStorePort,
  runId: string,
  opts: CompleteRunOptions = {},
): Promise<TaskRun> {
  return transitionRun(port, runId, 'completed', opts);
}

// ─── Run → Task 终态推导（纯函数） ───────────────────────────────────────────

/**
 * Run 过程态 → Task 目标态的保守推导（§5.1「Task 管终态、Run 管过程态」）。
 *
 * | Run 状态              | 推导出的 Task 状态 | 说明 |
 * |-----------------------|--------------------|------|
 * | failed                | failed             | 执行失败即目标失败（同名终态） |
 * | cancelled             | cancelled          | 用户取消即目标取消（同名终态） |
 * | completed             | **null（不推导）** | Run completed 只代表一次执行正常结束，不等于验收通过；Task completed 必须由 P3 接入的 GoalEvaluator + Evidence gate 判定（§14.1：GoalTracker 仍是评估唯一载体，本模块不做第二套 GoalEvaluator） |
 * | blocked               | blocked            | 等待用户输入 / 外部条件 |
 * | interrupted           | blocked            | §11.2 恢复真相在 Agent Checkpoint，Task 层表现为需要接管 |
 * | queued / running / paused | running          | 派生的「进行中」聚合态 |
 *
 * Task 已处于终态时一律返回 `null`：终态无出口（protocol `TASK_STATUS_TRANSITIONS`），
 * 只能由新 Run / 新 Task 继续。
 */
export function syncTaskFromRun(task: Task, run: TaskRun): TaskStatus | null {
  if (isTaskTerminalState(task.status)) return null;
  if (run.taskId !== task.id) {
    throw new Error(`syncTaskFromRun: run ${run.id} does not belong to task ${task.id}`);
  }
  switch (run.status) {
    case 'failed':
      return 'failed';
    case 'cancelled':
      return 'cancelled';
    case 'completed':
      // 见上表：验收在 P3 接入，这里保守不推导终态。
      return null;
    case 'blocked':
    case 'interrupted':
      return 'blocked';
    case 'queued':
    case 'running':
    case 'paused':
      return 'running';
    default:
      return null;
  }
}

/**
 * 把 `syncTaskFromRun` 的推导结果落库（同态不写；非法迁移由 protocol 抛错）。
 * 返回未变化的同一个 task 对象以便上层链式调用。
 */
export async function applyTaskSyncFromRun(
  port: TaskStorePort,
  task: Task,
  run: TaskRun,
  opts: { now?: string } = {},
): Promise<Task> {
  const next = syncTaskFromRun(task, run);
  if (!next || next === task.status) return task;
  assertTaskStatusTransition(task.status, next);
  const now = opts.now ?? nowIso();
  const patch: Partial<Omit<Task, 'id' | 'createdAt'>> = {
    status: next,
    updatedAt: now,
    version: task.version + 1,
  };
  if (isTaskTerminalState(next)) patch.completedAt = now;
  return port.updateTask(task.id, patch, task.version);
}

/** 一步式：迁移 Run 后立刻按推导同步 Task 层（不含验收语义）。 */
export async function transitionRunAndSyncTask(
  port: TaskStorePort,
  runId: string,
  to: TaskRunState,
  opts: TransitionRunOptions = {},
): Promise<{ run: TaskRun; task: Task }> {
  const run = await transitionRun(port, runId, to, opts);
  const task = await requireTask(port, run.taskId);
  const synced = await applyTaskSyncFromRun(port, task, run, opts);
  return { run, task: synced };
}

// ─── retry：只新建 Run ───────────────────────────────────────────────────────

export interface CreateRetryRunOptions {
  /** 缺省继承被重试 Run 的 kind / workflowKind。 */
  kind?: TaskRunKind;
  workflowKind?: WorkflowKind;
  /** 新 Run 关联的新 harness/workflow run；不继承旧 Run 的关联（那是上一次执行的产物）。 */
  harnessRunId?: string;
  workflowRunId?: string;
  ids?: { runId?: string };
  now?: string;
}

export interface CreateRetryRunResult {
  task: Task;
  run: TaskRun;
  /** 被重试的旧 Run id（可能没有，例如从未跑起来的 Task）。 */
  retriedRunId?: string;
}

/**
 * retry = 新建一个 `queued` Run 并把它追加进 `task.runIds` / 指为 `currentRunId`，
 * **绝不修改旧 Run**（§5.1 / §11.4「retry 只创建新 Run，不修改旧 Run 终态」）。
 *
 * 约束：
 * - 终态 Task（completed / failed / cancelled）没有出口 ⇒ 抛 `TASK_TERMINAL_STATE`，
 *   需要继续做的必须由上层创建新 Task（P2 任务中心接管）。
 * - 仍有非终态 Run 时抛 `TASK_INVALID_TRANSITION`，避免同一 Task 下两个活跃 Run。
 */
export async function createRetryRun(
  port: TaskStorePort,
  taskId: string,
  opts: CreateRetryRunOptions = {},
): Promise<CreateRetryRunResult> {
  const task = await requireTask(port, taskId);
  if (isTaskTerminalState(task.status)) {
    throw new TaskError(
      'TASK_TERMINAL_STATE',
      `task ${taskId} is ${task.status}; a terminal task cannot be retried in place (create a new task)`,
      { taskId, from: task.status, to: 'pending' },
    );
  }

  const runs = await port.listRuns(taskId);
  const current = task.currentRunId ? runs.find((r) => r.id === task.currentRunId) : undefined;
  if (current && !isTaskRunTerminalState(current.status)) {
    throw new TaskError(
      'TASK_INVALID_TRANSITION',
      `task ${taskId} still has a non-terminal run ${current.id} (${current.status}); cancel it before retry`,
      { taskId, runId: current.id, from: current.status, to: 'queued' },
    );
  }
  const base = current ?? runs[runs.length - 1];
  const kind: TaskRunKind = opts.kind ?? base?.kind ?? 'goal';
  const workflowKind =
    kind === 'workflow' ? (opts.workflowKind ?? base?.workflowKind ?? 'script') : undefined;
  assertRunShape({ kind, workflowKind, workflowRunId: opts.workflowRunId });

  const now = opts.now ?? nowIso();
  const run = await port.createRun({
    id: opts.ids?.runId ?? newRunId(),
    taskId,
    threadId: task.threadId,
    kind,
    status: 'queued',
    harnessRunId: opts.harnessRunId,
    workflowRunId: opts.workflowRunId,
    workflowKind,
    updatedAt: now,
    version: 0,
  });

  const derived = syncTaskFromRun(task, run);
  if (derived && derived !== task.status) assertTaskStatusTransition(task.status, derived);

  const updated = await port.updateTask(
    taskId,
    {
      runIds: uniqueNonEmpty([...task.runIds, run.id]),
      currentRunId: run.id,
      status: derived ?? task.status,
      updatedAt: now,
      version: task.version + 1,
    },
    task.version,
  );

  return { task: updated, run, retriedRunId: current?.id };
}

// ─── PendingUserInput（§5.3：本地单用户，不超时） ────────────────────────────

export interface BlockForUserInputOptions {
  options?: string[];
  /** 是否接受自由文本回复，默认 true（本地单用户）。 */
  freeText?: boolean;
  /** 指定要一并 block 的 Run；缺省用 `task.currentRunId`。 */
  runId?: string;
  now?: string;
}

export interface BlockForUserInputResult {
  task: Task;
  pendingInput: PendingUserInput;
  /** 被同步 block 的 Run；Run 状态不允许 block（如 `paused`）时为 null。 */
  run: TaskRun | null;
}

/**
 * Task block + 结构化问题落库（§5.3）。
 *
 * - 本地单用户场景**不做超时自动推进**：`PendingUserInput` 只有 `askedAt`，没有 deadline，
 *   本模块也不注册任何定时器。
 * - Run 侧尽力同步：`queued / running / interrupted → blocked` 合法（§11.4）；
 *   `paused` 按迁移表不能直接 block，此时只 block Task 层，返回 `run: null`。
 * - 重复提问（同 Task 已 blocked）是幂等的：只刷新 `pendingInput`，不再做状态迁移。
 */
export async function blockForUserInput(
  port: TaskStorePort,
  task: Task | string,
  question: string,
  opts: BlockForUserInputOptions = {},
): Promise<BlockForUserInputResult> {
  const loaded = typeof task === 'string' ? await requireTask(port, task) : task;
  if (isTaskTerminalState(loaded.status)) {
    throw new TaskError(
      'TASK_TERMINAL_STATE',
      `task ${loaded.id} is ${loaded.status}; a terminal task cannot ask for user input`,
      { taskId: loaded.id, from: loaded.status, to: 'blocked' },
    );
  }
  const trimmed = (question ?? '').trim();
  if (!trimmed) {
    throw new Error('blockForUserInput: question must be a non-empty string');
  }

  const now = opts.now ?? nowIso();
  const pendingInput: PendingUserInput = {
    question: trimmed,
    options: normalizeCriteria(opts.options).length > 0 ? normalizeCriteria(opts.options) : undefined,
    freeText: opts.freeText ?? true,
    askedAt: now,
  };

  // Run 侧同步 block（允许失败时跳过）。
  let run: TaskRun | null = null;
  const targetRunId = opts.runId ?? loaded.currentRunId;
  if (targetRunId) {
    const candidate = await port.getRun(targetRunId);
    if (candidate && !isTaskRunTerminalState(candidate.status) && candidate.status !== 'blocked') {
      if (canTransitionTaskRun(candidate.status, 'blocked')) {
        run = await transitionRun(port, candidate.id, 'blocked', { now });
      }
    } else if (candidate) {
      run = candidate.status === 'blocked' ? candidate : null;
    }
  }

  const patch: Partial<Omit<Task, 'id' | 'createdAt'>> = {
    pendingInput,
    updatedAt: now,
    version: loaded.version + 1,
  };
  if (loaded.status !== 'blocked') {
    assertTaskStatusTransition(loaded.status, 'blocked');
    patch.status = 'blocked';
  }

  const updated = await port.updateTask(loaded.id, patch, loaded.version);
  return { task: updated, pendingInput, run };
}

export interface ResolveUserInputOptions {
  /** 强制「用户回复后创建新 Run」（默认在当前 blocked Run 上重新排队）。 */
  createNewRun?: boolean;
  /** 新 Run 的确定性 id / 关联。 */
  ids?: { runId?: string };
  harnessRunId?: string;
  workflowRunId?: string;
  workflowKind?: WorkflowKind;
  /** 恢复时核对的 Agent Checkpoint（§11.2：恢复真相在 Checkpoint，这里只镜像）。 */
  checkpointId?: string;
  now?: string;
}

export interface ResolveUserInputResult {
  task: Task;
  run: TaskRun;
  /** 用户回复原文；持久化为用户消息由 API/UI 层负责（P2），本模块只解阻塞。 */
  answer?: string;
  /** 本次是否新建了 Run（false 表示把原 blocked Run 重新排队）。 */
  createdNewRun: boolean;
}

/**
 * 解阻塞（§5.3）：`blocked → queued` 恢复当前 Run，或在没有可恢复 Run 时新建 Run。
 * Task 侧 `blocked → running`，并清空 `pendingInput`。
 */
export async function resolveUserInput(
  port: TaskStorePort,
  task: Task | string,
  answer?: string,
  opts: ResolveUserInputOptions = {},
): Promise<ResolveUserInputResult> {
  const loaded = typeof task === 'string' ? await requireTask(port, task) : task;
  let latest = loaded;
  if (latest.status !== 'blocked') {
    throw new TaskError(
      'TASK_INVALID_TRANSITION',
      `task ${latest.id} is ${latest.status}, not blocked; nothing to resolve`,
      { taskId: latest.id, from: latest.status, to: 'running' },
    );
  }
  const now = opts.now ?? nowIso();

  let run: TaskRun;
  let createdNewRun = false;
  const current = latest.currentRunId ? await port.getRun(latest.currentRunId) : null;
  if (!opts.createNewRun && current && current.status === 'blocked') {
    run = await transitionRun(port, current.id, 'queued', {
      checkpointId: opts.checkpointId,
      now,
    });
  } else {
    if (current && !isTaskRunTerminalState(current.status)) {
      // 当前 Run 还在跑（既非 blocked 也非终态），不能另起第二个活跃 Run。
      throw new TaskError(
        'TASK_INVALID_TRANSITION',
        `task ${latest.id} has a non-terminal run ${current.id} (${current.status}); cannot start a new run`,
        { taskId: latest.id, runId: current.id, from: current.status, to: 'queued' },
      );
    }
    const retried = await createRetryRun(port, latest.id, {
      ids: opts.ids,
      harnessRunId: opts.harnessRunId,
      workflowRunId: opts.workflowRunId,
      workflowKind: opts.workflowKind,
      now,
    });
    run = retried.run;
    createdNewRun = true;
    // createRetryRun 可能已经推过 Task 状态，这里以最新快照为准。
    latest = await requireTask(port, latest.id);
  }

  // 清空 pendingInput 并回到 running。
  const patch: Partial<Omit<Task, 'id' | 'createdAt'>> = {
    pendingInput: undefined,
    updatedAt: now,
    version: latest.version + 1,
  };
  if (latest.status !== 'running') {
    assertTaskStatusTransition(latest.status, 'running');
    patch.status = 'running';
  }
  const updated = await port.updateTask(latest.id, patch, latest.version);
  return { task: updated, run, answer, createdNewRun };
}

/** Task 证据集合追加（Evidence 物化后由上层回写；去重、不改状态）。 */
export async function attachTaskEvidence(
  port: TaskStorePort,
  taskId: string,
  evidenceIds: readonly string[],
  opts: { now?: string } = {},
): Promise<Task> {
  const task = await requireTask(port, taskId);
  const merged = uniqueNonEmpty([...task.evidenceIds, ...evidenceIds]);
  if (merged.length === task.evidenceIds.length) return task;
  return port.updateTask(taskId, {
    evidenceIds: merged,
    updatedAt: opts.now ?? nowIso(),
    version: task.version + 1,
  }, task.version);
}
