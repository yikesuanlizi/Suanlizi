// TaskStore 端口契约：Task / TaskRun / WorkflowRunRecord / WorkflowAgentCall 的持久化接口。
// TaskStore port contract: persistence interface for Task / TaskRun / WorkflowRunRecord / WorkflowAgentCall.
//
// 之所以放在 protocol 层，是为了让 storage（实现）、runtime（编排调用）、api（路由与恢复扫描）
// 三方都只依赖这一份稳定契约，保持 `protocol → storage/runtime → api` 的单向依赖，
// 避免 runtime 反向依赖 storage。本模块只放类型，不放任何 SQLite/存储实现逻辑。
// This module is types-only. It exists so storage (impl), runtime (orchestration) and api
// (routes & recovery scan) all depend on a single stable contract without runtime importing storage.
import type {
  Task,
  TaskRun,
  TaskOrigin,
  TaskStatus,
  WorkflowAgentCall,
  WorkflowRunRecord,
} from './task.js';

/** 任务查询过滤器；未提供的维度不参与筛选。/ Task query filter; omitted dimensions are not filtered. */
export interface TaskListFilter {
  threadId?: string;
  status?: readonly TaskStatus[];
  /** 默认不过滤；Goal Center 只传 explicit_goal。 */
  origin?: readonly TaskOrigin[];
}

/** WorkflowRun 查询过滤器；未提供的维度不参与筛选。/ Workflow run query filter. */
export interface WorkflowRunListFilter {
  /** P6：按 GoalRun 来源筛选（预算治理与证据投影）。 */
  goalRunId?: string;
}

/**
 * TaskStore 端口。SQLite / WAL 是 Task、Run、WorkflowRun、AgentCall 的单一事实来源（计划 §6.2）。
 * 所有更新方法必须带 `expectedVersion` 乐观锁；冲突时抛出 `@suanlizi/protocol` 的 `TaskError`
 * （code = `TASK_VERSION_CONFLICT`），非法迁移抛 `TASK_INVALID_TRANSITION` / `TASK_TERMINAL_STATE`。
 */
export interface TaskStorePort {
  // ─── Task ──────────────────────────────────────────────────────────────
  createTask(task: Task): Promise<Task>;
  getTask(id: string): Promise<Task | null>;
  updateTask(id: string, patch: Partial<Omit<Task, 'id' | 'createdAt' | 'origin'>>, expectedVersion: number): Promise<Task>;
  listTasks(filter?: TaskListFilter): Promise<Task[]>;

  // ─── TaskRun ───────────────────────────────────────────────────────────
  createRun(run: TaskRun): Promise<TaskRun>;
  getRun(id: string): Promise<TaskRun | null>;
  updateRun(id: string, patch: Partial<Omit<TaskRun, 'id' | 'taskId'>>, expectedVersion: number): Promise<TaskRun>;
  listRuns(taskId: string): Promise<TaskRun[]>;

  // ─── WorkflowRunRecord / AgentCall ─────────────────────────────────────
  upsertWorkflowRun(record: WorkflowRunRecord): Promise<WorkflowRunRecord>;
  getWorkflowRun(id: string): Promise<WorkflowRunRecord | null>;
  /** P6：按过滤器列出 WorkflowRun（缺省全量；goalRunId 用于预算治理）。 */
  listWorkflowRuns(filter?: WorkflowRunListFilter): Promise<WorkflowRunRecord[]>;
  recordAgentCall(runId: string, call: WorkflowAgentCall): Promise<WorkflowAgentCall>;
  updateAgentCall(runId: string, call: WorkflowAgentCall): Promise<WorkflowAgentCall>;
  listAgentCalls(runId: string): Promise<WorkflowAgentCall[]>;

  /**
   * 启动扫描：把非终态 Run 按现有 Agent Checkpoint 决定恢复或标记 `interrupted`。
   * `isLive` 由调用方（API 恢复扫描）注入进程内存活判据；返回本次被改写的 Run 列表。
   * 恢复真相以 Agent Checkpoint 为准，本方法只镜像（计划 §11.2）。
   */
  recoverInterruptedRuns(isLive: (run: TaskRun) => boolean): Promise<TaskRun[]>;
}
