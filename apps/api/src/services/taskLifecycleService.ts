// TaskLifecycleService（计划 §7 P2 / §9.1 / §9.3 / §14.3）：目标任务生命周期编排。
//
// 职责边界：
//   1. 服务端唯一真相 —— 所有 Run/Task 状态迁移一律走 @suanlizi/runtime 的 taskLifecycle
//      （内部由 @suanlizi/protocol 迁移表 + 乐观锁校验），本模块不自建第二套迁移逻辑。
//   2. 固定顺序 —— 先迁移 task 表状态，再对 harness 施加 interrupt / abort / runHarness /
//      resumeHarness（§14.3）；取消双写 = agent.interrupt(threadId) + registry.cancel(runId)。
//   3. 每个操作成功后 publishEvent 发 §9.3 事件（task.run.updated / task.run.terminal，
//      事件名逐字取自 TASK_EVENT_NAMES）。
//
// 为什么不直接复用 taskShadowWriter.attachShadowTaskTracking：
//   影子 tracker 会把 registry 的 'cancelled' 无条件镜像成 Run 'cancelled'。pause 的语义是
//   running → paused（不是 cancelled 终态），但 pause 必须 interrupt + abort 当前 harness，
//   abort 会让 registry 条目变 'cancelled'、promise reject，若沿用 attachShadowTaskTracking，
//   tracker 会在 pause 之后把已置 'paused' 的 Run 覆盖成 'cancelled'（双写冲突）。
//   因此本模块用「带守卫的终态镜像」trackHarnessTerminal：settle 时重读 Run，仅当它仍是
//   'running' 才按 registry 终态镜像（自然 completed / failed）；已被 pause / cancel / block
//   抢先迁移出 running 的 Run 直接跳过，从根上避免 paused 被 tracker 覆盖成 cancelled。
//   新起 harness（start / retry / redirect / input / resume）时挂载该守卫镜像。
//
// — Chinese: lifecycle orchestration for goal tasks; transitions go through taskLifecycle
//   (single source of truth), harness ops are applied after DB transitions, and a guarded
//   terminal mirror replaces attachShadowTaskTracking so pause is never overridden by cancel.

import type {
  GoalEvaluation,
  Task,
  TaskOrigin,
  TaskRun,
  TaskStorePort,
  ThreadEvent,
  ThreadId,
  UserInput,
  WorkflowScriptRequest,
} from '@suanlizi/protocol';
import { TaskError, isTaskRunTerminalState } from '@suanlizi/protocol';
import {
  applyTaskSyncFromRun,
  completeRun,
  createRetryRun,
  resolveUserInput,
  transitionRun,
} from '@suanlizi/runtime';
import type { HarnessResult, HarnessWorkflowOptions, WorkflowResultEvidenceInput } from '@suanlizi/runtime';
import { harnessRuntimeRegistry } from './harnessRuntime.js';

// ─── 注入端口 ────────────────────────────────────────────────────────────────

/**
 * AgentLoop 在本服务里用到的最小方法面（runHarness / resumeHarness / interrupt）。
 * 真实 getAgent 返回的 AgentLoop 结构上满足本接口；测试注入 fake agent 即可计数断言。
 */
export interface TaskLifecycleAgent {
  runHarness(
    threadId: ThreadId,
    userInput: UserInput,
    options?: {
      goal?: string;
      acceptanceCriteria?: string[];
      maxContinuations?: number;
      signal?: AbortSignal;
      harnessRunId?: string;
      suspendSignal?: AbortSignal;
      workflow?: HarnessWorkflowOptions;
    },
  ): Promise<HarnessResult>;
  resumeHarness(threadId: ThreadId, options?: { signal?: AbortSignal; suspendSignal?: AbortSignal; harnessRunId?: string; workflow?: HarnessWorkflowOptions }): Promise<HarnessResult>;
  interrupt(threadId: ThreadId, requestId?: string): boolean;
}

export type TaskHarnessRuntimeStatus = 'running' | 'completed' | 'failed' | 'cancelled';

/** 与 HarnessRuntimeRegistry 条目对齐的最小运行面（便于测试注入 fake registry）。 */
export interface TaskHarnessRunHandle {
  harnessRunId: string;
  threadId: ThreadId;
  runtimeStatus: TaskHarnessRuntimeStatus;
  error?: string;
  promise: Promise<unknown>;
}

/** HarnessRuntimeRegistry 的结构子集；默认实现即进程单例 harnessRuntimeRegistry。 */
export interface TaskHarnessRegistry {
  start(params: {
    harnessRunId: string;
    threadId: ThreadId;
    tenantId: string;
    run: (signal: AbortSignal) => Promise<HarnessResult>;
  }): TaskHarnessRunHandle;
  cancel(runId: string, options?: { suspend?: boolean }): boolean;
  get(runId: string): TaskHarnessRunHandle | undefined;
  activeRunForThread(threadId: ThreadId): TaskHarnessRunHandle | undefined;
}

export interface TaskLifecycleDeps {
  taskStore: TaskStorePort;
  getAgent: (threadId?: ThreadId) => Promise<TaskLifecycleAgent>;
  /** 缺省用进程单例 harnessRuntimeRegistry；测试注入 fake registry。 */
  registry?: TaskHarnessRegistry;
  publishEvent: (event: ThreadEvent) => void;
  tenantId?: string;
  now?: () => Date;
  /** Run/Task id 生成器注入点（测试确定性）；缺省走 randomUUID。 */
  idFactory?: () => string;
  /** harnessRunId 生成器；默认与 harnessRoute.generateHarnessRunId 同款形态。 */
  harnessRunIdFactory?: () => string;
  logger?: { warn(message: string): void };
  /**
   * P6：Goal × Workflow 组合集成（server 装配注入）：提案转发到 workflowScriptService.proposeRun，
   * 证据投影从 workflow_runs/agent_calls 产出 wev_ seeds。未注入时 harness 行为零变化。
   */
  workflow?: TaskWorkflowIntegration;
  /**
   * 计划 §13.1：GoalRun 收口时读取最近一次 GoalEvaluation 以发
   * `task.goal.evaluation.available`（由 server 注入 goal-status 服务的读接口）。
   */
  readGoalEvaluation?: (params: { taskId: string; runId: string }) => Promise<GoalEvaluation | null>;
}

export interface TaskWorkflowIntegration {
  /** GoalRun 提案 → 落待批准请求（blocked）；预算拒绝抛 WORKFLOW_LIMIT_EXCEEDED。 */
  onRequest(request: WorkflowScriptRequest): Promise<{ runId: string }>;
  /** 把该 Task 历史 WorkflowRun 结果投影成 Evidence seeds（GoalEvaluator 只读 Evidence 消费）。 */
  evidenceProvider(taskId: string): Promise<WorkflowResultEvidenceInput[]>;
}

export interface TaskLifecycleResult {
  task: Task;
  run: TaskRun | null;
  /** 起新 harness 的迁移返回 202；纯状态迁移（pause / cancel）返回 200。 */
  httpStatus: 200 | 202;
}

export interface RedirectOptions {
  instruction: string;
  reason?: string;
}

export interface AnswerOptions {
  answer: string;
  reason?: string;
}

export interface TaskLifecycleService {
  start(taskId: string): Promise<TaskLifecycleResult>;
  pause(taskId: string, opts?: { reason?: string }): Promise<TaskLifecycleResult>;
  resume(taskId: string): Promise<TaskLifecycleResult>;
  cancel(taskId: string, opts?: { reason?: string }): Promise<TaskLifecycleResult>;
  retry(taskId: string): Promise<TaskLifecycleResult>;
  redirect(taskId: string, opts: RedirectOptions): Promise<TaskLifecycleResult>;
  input(taskId: string, opts: AnswerOptions): Promise<TaskLifecycleResult>;
}

// ─── id 生成（本地实现，避免依赖 harnessRoute 模块） ──────────────────────────

function defaultHarnessRunId(): string {
  return `harness_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

const defaultLogger = { warn: (message: string) => console.warn(message) };

// ─── 工厂 ────────────────────────────────────────────────────────────────────

export function createTaskLifecycleService(deps: TaskLifecycleDeps): TaskLifecycleService {
  const {
    taskStore,
    getAgent,
    registry = harnessRuntimeRegistry,
    publishEvent,
    tenantId = 'default',
    now = () => new Date(),
    harnessRunIdFactory = defaultHarnessRunId,
    logger = defaultLogger,
  } = deps;

  const isoNow = () => now().toISOString();

  // ── 内部小工具 ──────────────────────────────────────────────────────────

  async function requireTask(taskId: string): Promise<Task> {
    const task = await taskStore.getTask(taskId);
    if (!task) {
      throw new TaskError('TASK_NOT_FOUND', `task ${taskId} not found`, { taskId });
    }
    // Goal 生命周期端点绝不能接管普通 Harness 的内部影子镜像；
    // 只有用户显式创建的 Goal 才能 start / pause / resume / redirect 等。
    if (task.origin !== 'explicit_goal') {
      throw new TaskError(
        'TASK_INVALID_TRANSITION',
        `Goal lifecycle is available only for explicitly created Goals (task ${task.id})`,
        { taskId: task.id, origin: task.origin ?? 'harness_shadow' },
      );
    }
    return task;
  }

  /** Task.origin 为兼容旧数据可选；只有精确 Goal 来源才允许动态工作流注入。 */
  function effectiveTaskOrigin(task: Pick<Task, 'origin'>): TaskOrigin {
    return task.origin === 'explicit_goal' ? 'explicit_goal' : 'harness_shadow';
  }

  async function currentRun(task: Task): Promise<TaskRun | null> {
    if (!task.currentRunId) return null;
    return taskStore.getRun(task.currentRunId);
  }

  /** 扫描 task.runIds 是否仍有非终态 Run（同 thread 单活跃 Run 约束）。 */
  async function hasActiveRun(task: Task): Promise<boolean> {
    const runs = await taskStore.listRuns(task.id);
    return runs.some((run) => !isTaskRunTerminalState(run.status));
  }

  function preconditionFailure(task: Task, action: string, detail: string): TaskError {
    return new TaskError(
      'TASK_INVALID_TRANSITION',
      `cannot ${action} task ${task.id}: ${detail}`,
      { taskId: task.id, action, from: task.status },
    );
  }

  function textInput(text: string): UserInput {
    return { type: 'text', text };
  }

  function emitRunEvent(run: TaskRun, kind: 'updated' | 'terminal', reason?: string): void {
    const base = {
      threadId: run.threadId as ThreadId,
      taskId: run.taskId,
      runId: run.id,
      status: run.status as string,
      timestamp: isoNow(),
    };
    const event: ThreadEvent =
      kind === 'terminal'
        ? { type: 'task.run.terminal', ...base, ...(reason ? { reason } : {}) }
        : { type: 'task.run.updated', ...base, ...(reason ? { reason } : {}) };
    publishEvent(event);
  }

  /**
   * 带守卫的 harness 终态镜像：仅当 Run 仍是 running 才按 registry 终态落库并同步 Task。
   * 这是 pause 防覆盖的核心 —— pause 先把 Run 置 paused 再 abort，settle 时守卫看到非
   * running 即跳过，绝不把 paused 覆盖成 cancelled；cancel 同理（已是 cancelled 终态）。
   */
  function trackHarnessTerminal(
    entry: TaskHarnessRunHandle,
    handle: { taskId: string; runId: string },
  ): void {
    void (async () => {
      try {
        await entry.promise;
      } catch {
        // 终态以 entry.runtimeStatus 为准，promise reject 不额外处理。
      }
      try {
        const run = await taskStore.getRun(handle.runId);
        // 守卫：被生命周期操作抢先迁移出 running（paused / cancelled / blocked）时跳过。
        if (!run || run.status !== 'running') return;
        let settled: TaskRun | null = null;
        if (entry.runtimeStatus === 'completed') {
          settled = await completeRun(taskStore, run.id);
        } else if (entry.runtimeStatus === 'failed') {
          settled = await transitionRun(taskStore, run.id, 'failed', {
            error: entry.error ?? 'harness run failed',
          });
        } else if (entry.runtimeStatus === 'cancelled') {
          settled = await transitionRun(taskStore, run.id, 'cancelled', {
            error: entry.error ?? 'harness run cancelled',
          });
        }
        if (!settled) return;
        const task = await taskStore.getTask(handle.taskId);
        if (task) await applyTaskSyncFromRun(taskStore, task, settled);
        emitRunEvent(settled, 'terminal');
        await emitGoalEvaluation(settled);
      } catch (error) {
        logger.warn(
          `[tasks] lifecycle terminal mirror failed for run ${handle.runId}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    })();
  }

  /**
   * GoalRun 收口后补发 `task.goal.evaluation.available`（计划 §13.1）。
   * 读不到评估（未注入读接口、无 harnessState tags）时静默跳过：事件是增量信息，
   * 不得因它缺失而阻断终态写入；读取失败则记日志（不静默吞错）。
   */
  async function emitGoalEvaluation(run: TaskRun): Promise<void> {
    if (run.kind !== 'goal' || !deps.readGoalEvaluation) return;
    try {
      const evaluation = await deps.readGoalEvaluation({ taskId: run.taskId, runId: run.id });
      if (!evaluation) return;
      const event: ThreadEvent = {
        type: 'task.goal.evaluation.available',
        threadId: run.threadId as ThreadId,
        taskId: run.taskId,
        runId: run.id,
        satisfied: Boolean(evaluation.satisfied),
        status: String(evaluation.status ?? ''),
        passedCriteria: [...(evaluation.passedCriteria ?? [])],
        failedCriteria: [...(evaluation.failedCriteria ?? [])],
        timestamp: isoNow(),
      };
      publishEvent(event);
    } catch (error) {
      logger.warn(
        `[tasks] goal evaluation read failed for run ${run.id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /**
   * 起一个 goal harness 后台 run（start / retry / redirect / input / resume 共用）。
   * 顺序固定：调用前 Run 已在 task 表迁到 running；这里只 registry.start + 挂守卫镜像。
   */
  async function launchGoalHarness(params: {
    taskId: string;
    runId: string;
    /** 双保险：即使将来调用链放宽，也不得给 shadow harness 注入动态工作流解析器。 */
    origin: TaskOrigin;
    threadId: ThreadId;
    resume: boolean;
    userInput?: UserInput;
    goal?: string;
    acceptanceCriteria?: string[];
    /** 新建 Run 时由调用方预生成并写入 run.harnessRunId，保证 registry 与 DB 对齐。 */
    harnessRunId?: string;
    /** P2 生命周期修复（§21）：pause 的 suspend 意图信号（pause 调用点传新 controller.signal）。 */
    suspendSignal?: AbortSignal;
  }): Promise<TaskHarnessRunHandle> {
    const agent = await getAgent(params.threadId);
    const harnessRunId = params.harnessRunId ?? harnessRunIdFactory();
    // P6：注入 Goal × Workflow 组合选项（提案回调 + 历史证据预载）。
    const workflow: HarnessWorkflowOptions | undefined = params.origin === 'explicit_goal' && deps.workflow
      ? {
          taskId: params.taskId,
          goalRunId: params.runId,
          // TaskWorkflowIntegration 返回 { runId }；harness 侧只关心完成与否。
          onRequest: async (request) => {
            await deps.workflow!.onRequest(request);
          },
          evidenceProvider: () => deps.workflow!.evidenceProvider(params.taskId),
        }
      : undefined;
    const entry = registry.start({
      harnessRunId,
      threadId: params.threadId,
      tenantId,
      run: (signal) =>
        params.resume
          ? agent.resumeHarness(params.threadId, {
              signal,
              suspendSignal: params.suspendSignal,
              harnessRunId,
              workflow,
            })
          : agent.runHarness(params.threadId, params.userInput ?? textInput(''), {
              goal: params.goal,
              acceptanceCriteria: params.acceptanceCriteria,
              signal,
              suspendSignal: params.suspendSignal,
              harnessRunId,
              workflow,
            }),
    });
    trackHarnessTerminal(entry, { taskId: params.taskId, runId: params.runId });
    return entry;
  }

  /** 取消双写：先迁 task 表（由调用方完成），再 agent.interrupt + registry.cancel(abort)。 */
  async function interruptAndAbort(
    threadId: ThreadId,
    harnessRunId?: string,
    options?: { suspend?: boolean },
  ): Promise<void> {
    const agent = await getAgent(threadId);
    // §9.2 约定：本波不改 harnessRuntime.ts，故经 getAgent 直接调用 agent.interrupt 落
    // stopping checkpoint / pendingInterrupts，再由 registry.cancel 双写 abort + registry 终态。
    try {
      agent.interrupt(threadId);
    } catch (error) {
      logger.warn(
        `[tasks] agent.interrupt failed for thread ${threadId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    const target = harnessRunId ?? registry.activeRunForThread(threadId)?.harnessRunId;
    if (target) registry.cancel(target, options);
  }

  async function transitionToRunning(
    taskId: string,
    runId: string,
  ): Promise<{ task: Task; run: TaskRun }> {
    const run = await transitionRun(taskStore, runId, 'running');
    const task = await requireTask(taskId);
    const synced = await applyTaskSyncFromRun(taskStore, task, run);
    return { task: synced, run };
  }

  // ── 七个生命周期操作 ────────────────────────────────────────────────────

  async function start(taskId: string): Promise<TaskLifecycleResult> {
    const task = await requireTask(taskId);
    if (task.status !== 'pending') {
      throw preconditionFailure(task, 'start', `task status is ${task.status}, expected pending`);
    }
    if (task.currentRunId || (await hasActiveRun(task))) {
      throw new TaskError('TASK_ACTIVE_EXISTS', `task ${taskId} already has a current run`, {
        taskId,
        currentRunId: task.currentRunId,
      });
    }
    // pending Task 无 run：createRetryRun 用于在同 Task 上追加首个 queued goal Run。
    // 预生成 harnessRunId 并同时写入新 Run 记录与 registry，令 run.harnessRunId 真实可查，
    // 后续 pause / cancel / redirect 据此定位 harness，无需依赖 activeRunForThread 兜底。
    const harnessRunId = harnessRunIdFactory();
    const created = await createRetryRun(taskStore, taskId, { kind: 'goal', harnessRunId });
    // 先迁 task 表状态（queued → running），再起 harness。
    const { task: runningTask, run } = await transitionToRunning(taskId, created.run.id);
    await launchGoalHarness({
      taskId,
      runId: run.id,
      origin: effectiveTaskOrigin(runningTask),
      threadId: runningTask.threadId as ThreadId,
      resume: false,
      userInput: textInput(runningTask.objective),
      goal: runningTask.objective,
      acceptanceCriteria: runningTask.acceptanceCriteria,
      harnessRunId,
    });
    emitRunEvent(run, 'updated');
    return { task: await requireTask(taskId), run, httpStatus: 202 };
  }

  async function pause(taskId: string, opts: { reason?: string } = {}): Promise<TaskLifecycleResult> {
    const task = await requireTask(taskId);
    const run = await currentRun(task);
    if (!run) throw preconditionFailure(task, 'pause', 'no current run');
    if (run.status !== 'running') {
      throw preconditionFailure(task, 'pause', `current run ${run.id} is ${run.status}, expected running`);
    }
    // 先迁 task 表 running → paused（守卫镜像据此跳过 cancelled 覆盖），再只中止当前 harness。
    // registry 的 suspend reason 会被 engine 识别为“暂停而非终止”，保持 GoalTracker active；
    // 不在 pause 内启动第二个 harness，resume 时再用同一 harnessRunId 重新登记。
    const paused = await transitionRun(taskStore, run.id, 'paused');
    await interruptAndAbort(task.threadId as ThreadId, paused.harnessRunId, { suspend: true });
    emitRunEvent(paused, 'updated', opts.reason ?? 'user pause');
    return { task: await requireTask(taskId), run: paused, httpStatus: 200 };
  }

  async function resume(taskId: string): Promise<TaskLifecycleResult> {
    const task = await requireTask(taskId);
    const run = await currentRun(task);
    if (!run) throw preconditionFailure(task, 'resume', 'no current run');
    if (run.status !== 'paused' && run.status !== 'interrupted') {
      throw preconditionFailure(task, 'resume', `current run ${run.id} is ${run.status}, expected paused|interrupted`);
    }
    if (run.kind !== 'goal') {
      throw preconditionFailure(task, 'resume', `current run ${run.id} is kind=${run.kind}, expected goal`);
    }
    // 先迁 task 表 → running，再起 resumeHarness 后台登记。
    const running = await transitionRun(taskStore, run.id, 'running');
    const syncedTask = await taskStore.getTask(taskId);
    if (syncedTask) await applyTaskSyncFromRun(taskStore, syncedTask, running);
    await launchGoalHarness({
      taskId,
      runId: running.id,
      origin: effectiveTaskOrigin(task),
      threadId: task.threadId as ThreadId,
      resume: true,
      // P2 生命周期修复（§21）：显式传回原 harnessRunId。缺省时 launchGoalHarness 会登记
      // 新 id，而 engine 无 id 时读空 activeHarnessRunId tag 会抛「No active harness run」。
      harnessRunId: run.harnessRunId,
    });
    emitRunEvent(running, 'updated');
    return { task: await requireTask(taskId), run: running, httpStatus: 202 };
  }

  async function cancel(taskId: string, opts: { reason?: string } = {}): Promise<TaskLifecycleResult> {
    const task = await requireTask(taskId);
    const run = await currentRun(task);
    if (!run) {
      // 无 current run：Task 直接进 cancelled 终态（若尚未终态）。
      await cancelTaskWithoutRun(task, opts.reason ?? 'user cancel');
      return { task: await requireTask(taskId), run: null, httpStatus: 200 };
    }
    if (isTaskRunTerminalState(run.status)) {
      throw new TaskError('TASK_TERMINAL_STATE', `current run ${run.id} already ${run.status}`, {
        taskId,
        runId: run.id,
        from: run.status,
      });
    }
    // 先迁 task 表 → cancelled（带 error），再 interrupt + abort；守卫镜像看到终态跳过。
    const cancelled = await transitionRun(taskStore, run.id, 'cancelled', {
      error: opts.reason ?? 'user cancel',
    });
    const refreshed = await requireTask(taskId);
    const synced = await applyTaskSyncFromRun(taskStore, refreshed, cancelled);
    await interruptAndAbort(task.threadId as ThreadId, cancelled.harnessRunId);
    emitRunEvent(cancelled, 'terminal', opts.reason ?? 'user cancel');
    return { task: synced, run: cancelled, httpStatus: 200 };
  }

  async function cancelTaskWithoutRun(task: Task, _reason: string): Promise<Task> {
    if (task.status === 'cancelled') return task;
    const next = task.status === 'completed' || task.status === 'failed' ? 'failed' : 'cancelled';
    // Task 终态迁移由 protocol 裁决；pending/running/blocked → cancelled 合法。
    return taskStore.updateTask(
      task.id,
      { status: next, completedAt: isoNow(), updatedAt: isoNow(), version: task.version + 1 },
      task.version,
    );
  }

  async function retry(taskId: string): Promise<TaskLifecycleResult> {
    const task = await requireTask(taskId);
    if (task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled') {
      throw new TaskError('TASK_TERMINAL_STATE', `task ${taskId} is ${task.status}; terminal tasks cannot retry in place`, {
        taskId,
        from: task.status,
        to: 'pending',
      });
    }
    if (task.status !== 'running' && task.status !== 'blocked') {
      throw preconditionFailure(task, 'retry', `task status is ${task.status}, expected running|blocked`);
    }
    const run = await currentRun(task);
    if (!run || !isTaskRunTerminalState(run.status)) {
      throw preconditionFailure(task, 'retry', 'current run is not terminal; cancel it first');
    }
    const harnessRunId = harnessRunIdFactory();
    const created = await createRetryRun(taskStore, taskId, { harnessRunId });
    const { task: runningTask, run: newRun } = await transitionToRunning(taskId, created.run.id);
    await launchGoalHarness({
      taskId,
      runId: newRun.id,
      origin: effectiveTaskOrigin(runningTask),
      threadId: runningTask.threadId as ThreadId,
      resume: false,
      userInput: textInput(runningTask.objective),
      goal: runningTask.objective,
      acceptanceCriteria: runningTask.acceptanceCriteria,
      harnessRunId,
    });
    emitRunEvent(newRun, 'updated');
    return { task: await requireTask(taskId), run: newRun, httpStatus: 202 };
  }

  async function redirect(taskId: string, opts: RedirectOptions): Promise<TaskLifecycleResult> {
    const instruction = (opts.instruction ?? '').trim();
    if (!instruction) {
      throw new TaskError('TASK_INVALID_TRANSITION', 'redirect requires a non-empty instruction', { taskId });
    }
    const task = await requireTask(taskId);
    const run = await currentRun(task);
    if (!run || (run.status !== 'running' && run.status !== 'paused')) {
      throw preconditionFailure(task, 'redirect', 'current run must be running or paused');
    }
    // 先 cancel 当前 Run（仅 Run 层，不把 Task 同步成 cancelled 终态，否则无法新建 Run）。
    const cancelled = await transitionRun(taskStore, run.id, 'cancelled', {
      error: opts.reason ?? 'redirected by user',
    });
    await interruptAndAbort(task.threadId as ThreadId, cancelled.harnessRunId);
    emitRunEvent(cancelled, 'terminal', opts.reason ?? 'redirected by user');
    // 再在同一 Task 上新建 queued Run → running，并以 instruction 为 userInput 起 harness。
    const harnessRunId = harnessRunIdFactory();
    const created = await createRetryRun(taskStore, taskId, { harnessRunId });
    const { task: runningTask, run: newRun } = await transitionToRunning(taskId, created.run.id);
    await launchGoalHarness({
      taskId,
      runId: newRun.id,
      origin: effectiveTaskOrigin(runningTask),
      threadId: runningTask.threadId as ThreadId,
      resume: false,
      userInput: textInput(instruction),
      goal: runningTask.objective,
      acceptanceCriteria: runningTask.acceptanceCriteria,
      harnessRunId,
    });
    emitRunEvent(newRun, 'updated', 'redirected');
    return { task: await requireTask(taskId), run: newRun, httpStatus: 202 };
  }

  async function input(taskId: string, opts: AnswerOptions): Promise<TaskLifecycleResult> {
    const answer = (opts.answer ?? '').trim();
    if (!answer) {
      throw new TaskError('TASK_INVALID_TRANSITION', 'input requires a non-empty answer', { taskId });
    }
    const task = await requireTask(taskId);
    if (task.status !== 'blocked' || !task.pendingInput) {
      throw preconditionFailure(task, 'input', 'task is not blocked with a pending input');
    }
    // resolveUserInput：Run blocked → queued，清 pendingInput，Task → running。
    const resolved = await resolveUserInput(taskStore, task.id, answer);
    const run = resolved.run;
    // queued → running 后以 answer 为起跑输入起新 harness。
    const running = await transitionRun(taskStore, run.id, 'running');
    const refreshed = await requireTask(taskId);
    const synced = await applyTaskSyncFromRun(taskStore, refreshed, running);
    await launchGoalHarness({
      taskId,
      runId: running.id,
      origin: effectiveTaskOrigin(synced),
      threadId: synced.threadId as ThreadId,
      resume: false,
      userInput: textInput(answer),
      goal: synced.objective,
      acceptanceCriteria: synced.acceptanceCriteria,
    });
    emitRunEvent(running, 'updated');
    return { task: await requireTask(taskId), run: running, httpStatus: 202 };
  }

  return { start, pause, resume, cancel, retry, redirect, input };
}

// 供路由层做 action 白名单校验的稳定集合（顺序即 §9.1 端点顺序）。
export const TASK_LIFECYCLE_ACTIONS = [
  'start',
  'pause',
  'resume',
  'cancel',
  'retry',
  'redirect',
  'input',
] as const satisfies readonly (keyof TaskLifecycleService)[];

export type TaskLifecycleAction = (typeof TASK_LIFECYCLE_ACTIONS)[number];

