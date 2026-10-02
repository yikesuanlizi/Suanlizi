// Workflow 脚本服务（计划 P4b）：静态校验、批准后启动受限脚本运行、AgentCall/RunRecord
// 持久化与 protocol workflow.* 事件发布、按 runId 取消。
//
// 职责边界：
// - 静态校验 / 限额 / 取消穿透 / AgentCall 落库全部在 @suanlizi/runtime 的 WorkflowScriptRuntime；
// - 本服务负责任务侧装配：创建 kind='workflow' 的 TaskRun（§14.8）、生成 scriptHash、
//   创建 WorkflowRunRecord、把 runtime 事件映射为 ThreadEvent（types.ts workflow.* 族）、
//   维护 runId → AbortController 的进程内取消注册表；
// - 子代理执行器由 server.ts 注入（走既有 AgentLoop 工具与权限治理，计划 §5.4）。
//
// — English: P4b service wiring WorkflowScriptRuntime to TaskStorePort + SSE events + cancel.

import { createHash, randomUUID } from 'node:crypto';
import {
  DEFAULT_GOAL_BUDGET_POLICY,
  DEFAULT_WORKFLOW_RUNTIME_LIMITS,
  TaskError,
  isWorkflowRunTerminalStatus,
  type Task,
  type TaskRun,
  type TaskStorePort,
  type ThreadEvent,
  type ThreadId,
  type WorkflowAgentCall,
  type WorkflowRuntimeLimits,
  type WorkflowRunRecord,
  type WorkflowUsageSummary,
} from '@suanlizi/protocol';
import {
  WorkflowScriptRuntime,
  validateWorkflowScript,
  workflowEvidenceId,
  type WorkflowAgentExecutor,
  type WorkflowScriptCostMetrics,
  type WorkflowRuntimeEvent,
} from '@suanlizi/runtime';

export interface WorkflowScriptServiceDeps {
  taskStore: Pick<
    TaskStorePort,
    | 'getTask'
    | 'createRun'
    | 'getRun'
    | 'updateRun'
    | 'listRuns'
    | 'upsertWorkflowRun'
    | 'getWorkflowRun'
    | 'listWorkflowRuns'
    | 'recordAgentCall'
    | 'updateAgentCall'
    | 'listAgentCalls'
  >;
  publishEvent: (event: ThreadEvent) => void;
  /**
   * 子代理执行器工厂：按任务线程注入真实模型/工具执行（走既有权限治理）。
   * 测试可直接注入受控 executor。
   */
  createExecutor: (ctx: { taskId: string; threadId: ThreadId; workflowRunId: string }) => Promise<WorkflowAgentExecutor>;
  /** P6：Goal 预算上限；缺省取 protocol DEFAULT_GOAL_BUDGET_POLICY.maxWorkflowRunsPerGoal。 */
  maxWorkflowRunsPerGoal?: number;
  /**
   * P6：Goal 触发的 Workflow 完成且证据物化成功后的自动续跑钩子（GoalRun → WorkflowRun → GoalRun）。
   * 实现失败只记录不阻断（Workflow 终态不受影响）。
   */
  onGoalResume?: (ctx: { taskId: string; goalRunId: string; workflowRunId: string }) => Promise<void> | void;
  /** 续跑钩子失败只不阻断终态，但必须可追溯（§6：不得静默吞错）。 */
  logger?: { warn(message: string): void };
  now?: () => number;
}

export interface WorkflowScriptValidationView {
  ok: boolean;
  diagnostics: ReturnType<typeof validateWorkflowScript>['diagnostics'];
  meta?: { name: string; description: string; phases: string[] };
  /** P5：静态成本度量（大任务警告依据，不参与放行判定）。 */
  cost?: WorkflowScriptCostMetrics;
}

/** P5：历史脚本条目（从已落库的 workflow run 投影，同一脚本只保留最新一次）。 */
export interface WorkflowScriptHistoryEntry {
  runId: string;
  taskRunId: string;
  scriptHash: string;
  script: string;
  status: string;
  startedAt: string;
  completedAt?: string;
  usage: WorkflowRunRecord['usage'];
  evidenceId?: string;
}

export interface StartWorkflowRunResult {
  runId: string;
  taskRunId: string;
  status: 'running';
}

export interface WorkflowRunResultView {
  run: WorkflowRunRecord;
  agentCalls: WorkflowAgentCall[];
}

/** P6：`GET /api/workflows/runs/:id/evidence` 的视图（Evidence 引用列表 + 脚本终态结果）。 */
export interface WorkflowRunEvidenceView {
  runId: string;
  taskRunId: string;
  status: WorkflowRunRecord['status'];
  goalRunId?: string;
  runEvidenceId?: string;
  evidenceIds: string[];
  result?: unknown;
}

/** P6：proposeRun 的返回（待批准请求）。 */
export interface WorkflowRequestView {
  runId: string;
  taskRunId: string;
  goalRunId?: string;
  status: 'blocked';
}

/** P6：approveRun / rejectRun 的返回。 */
export interface WorkflowRequestDecisionView {
  runId: string;
  taskRunId: string;
  goalRunId?: string;
  status: 'approved' | 'rejected';
  /** §14.10：批准的是编辑后脚本时返回 true，并回显固化后的 scriptHash。 */
  scriptEdited?: boolean;
  scriptHash?: string;
}

/** 结果指纹：只外发 hash 与字节大小，不把大结果正文塑进 SSE（§14.5 内存边界）。 */
function resultFingerprint(value: unknown): { resultHash: string; size: number } {
  let serialized: string;
  try {
    serialized = JSON.stringify(value) ?? String(value);
  } catch {
    serialized = String(value);
  }
  return {
    resultHash: createHash('sha256').update(serialized).digest('hex').slice(0, 16),
    size: Buffer.byteLength(serialized, 'utf8'),
  };
}

export function createWorkflowScriptService(deps: WorkflowScriptServiceDeps) {
  const { taskStore, publishEvent, createExecutor } = deps;
  const now = deps.now ?? (() => Date.now());
  /** 进程内取消注册表：runId → AbortController + scriptHash（与 harnessRuntimeRegistry 同型语义）。 */
  const controllers = new Map<string, { controller: AbortController; scriptHash: string }>();

  /** 校验脚本并提取 meta + 成本度量（批准界面展示）。纯函数仅供内部复用。 */
  function validate(script: string): WorkflowScriptValidationView {
    const result = validateWorkflowScript(script);
    return { ok: result.ok, diagnostics: result.diagnostics, meta: result.meta, ...(result.cost ? { cost: result.cost } : {}) };
  }

  /**
   * task-scoped 静态校验：HTTP/API 边界必须先确认这是用户显式创建的 Goal 或 Dynamic Workflow，
   * 防止普通 Harness shadow 借 validate 伪装成 Dynamic Workflow 入口。
   */
  async function validateForTask(taskId: string, script: string): Promise<WorkflowScriptValidationView> {
    assertExplicitUserTask(await requireTaskForRun(taskId));
    return validate(script);
  }

  /**
   * P5：列出该 Task 已保存（已运行）的历史脚本，按 scriptHash 去保留最新一次。
   * 脚本正文本就随 WorkflowRunRecord 落库，不引入第二份存储。
   */
  async function listScripts(taskId: string): Promise<WorkflowScriptHistoryEntry[]> {
    assertExplicitUserTask(await requireTaskForRun(taskId));
    const runs = await taskStore.listRuns(taskId);
    const byHash = new Map<string, WorkflowScriptHistoryEntry>();
    for (const run of runs) {
      if (run.kind !== 'workflow' || !run.workflowRunId) continue;
      const record = await taskStore.getWorkflowRun(run.workflowRunId);
      if (!record) continue;
      byHash.set(record.scriptHash, {
        runId: record.id,
        taskRunId: record.taskRunId,
        scriptHash: record.scriptHash,
        script: record.script,
        status: record.status,
        startedAt: record.startedAt,
        ...(record.completedAt !== undefined ? { completedAt: record.completedAt } : {}),
        usage: record.usage,
        ...(record.evidenceId !== undefined ? { evidenceId: record.evidenceId } : {}),
      });
    }
    return [...byHash.values()].sort((left, right) => right.startedAt.localeCompare(left.startedAt));
  }

  /**
   * 启动一次受批准的脚本运行：
   * 1. Task 必须存在；脚本必须先通过静态校验（WORKFLOW_SCRIPT_INVALID）；
   * 2. 创建 kind='workflow' 的 TaskRun（queued）→ WorkflowRunRecord（queued）；
   * 3. 立即返回 runId，后台执行（不阻塞主会话），终态落 TaskRun + RunRecord + 事件。
   */
  async function startRun(input: {
    taskId: string;
    script: string;
    args?: unknown;
    limits?: Partial<WorkflowRuntimeLimits>;
    /** P5：从既有 run 恢复——已完成且未受影响的 AgentCall 直接复用，其余重跑。 */
    resumeFromRunId?: string;
  }): Promise<StartWorkflowRunResult> {
    const task = await taskStore.getTask(input.taskId);
    if (!task) {
      throw new TaskError('TASK_NOT_FOUND', `Task ${input.taskId} not found`, { taskId: input.taskId });
    }
    assertExplicitUserTask(task);
    const validation = validateWorkflowScript(input.script);
    if (!validation.ok) {
      throw new TaskError(
        'WORKFLOW_SCRIPT_INVALID',
        `Workflow script failed static validation: ${validation.diagnostics.map((d) => `${d.code}:${d.message}`).join('; ')}`,
        { taskId: input.taskId, diagnostics: validation.diagnostics },
      );
    }

    const timestamp = new Date(now()).toISOString();
    const workflowRunId = `wfrun_${now()}_${randomUUID().slice(0, 8)}`;
    const taskRunId = `taskrun_${now()}_${randomUUID().slice(0, 8)}`;
    const scriptHash = createHash('sha256').update(input.script).digest('hex');

    // P5 恢复：只能复用同一个显式 Goal 的历史 AgentCall；禁止跨 Goal 或 shadow 越权复用。
    let resumeAgentCalls: WorkflowAgentCall[] | undefined;
    if (input.resumeFromRunId) {
      const prior = await taskStore.getWorkflowRun(input.resumeFromRunId);
      if (!prior) {
        throw new TaskError('WORKFLOW_RUN_NOT_FOUND', `Workflow run ${input.resumeFromRunId} was not found`, {
          taskId: input.taskId,
          workflowRunId: input.resumeFromRunId,
        });
      }
      const priorTaskRun = await requireWorkflowTaskRun(prior.taskRunId);
      if (priorTaskRun.taskId !== input.taskId) {
        throw new TaskError(
          'TASK_INVALID_TRANSITION',
          `Workflow run ${input.resumeFromRunId} does not belong to Goal ${input.taskId}`,
          {
            taskId: input.taskId,
            workflowRunId: input.resumeFromRunId,
            priorTaskId: priorTaskRun.taskId,
          },
        );
      }
      // 与当前 taskId 一致仍明确检查来源，避免历史 shadow 数据或异常关联被复用。
      assertExplicitUserTask(await requireTaskForRun(priorTaskRun.taskId));
      resumeAgentCalls = prior.agentCalls;
    }

    // §14.11 资源竞态对策：第一版全局同时只允许一个 WorkflowRun 在跑；
    // 同一脚本重复启动额外给出更具体的提示。两处写入（run 记录 + TaskRun）前必须完成检查。
    assertNoActiveRun(scriptHash, { taskId: input.taskId });

    // kind='workflow' 的 TaskRun：workflowKind='script'（§14.8），workflowRunId 关联记录。
    const taskRun: TaskRun = {
      id: taskRunId,
      taskId: input.taskId,
      threadId: task.threadId,
      kind: 'workflow',
      workflowKind: 'script',
      status: 'queued',
      workflowRunId,
      startedAt: timestamp,
      updatedAt: timestamp,
      version: 0,
    };
    await taskStore.createRun(taskRun);

    const record: WorkflowRunRecord = {
      id: workflowRunId,
      taskRunId,
      script: input.script,
      scriptHash,
      args: input.args,
      status: 'queued',
      agentCalls: [],
      usage: { inputTokens: 0, outputTokens: 0, agentCallCount: 0, durationMs: 0 },
      startedAt: timestamp,
      updatedAt: timestamp,
    };
    await taskStore.upsertWorkflowRun(record);
    publishEvent({
      type: 'workflow.run.updated',
      threadId: task.threadId,
      taskId: input.taskId,
      runId: workflowRunId,
      status: 'queued',
      timestamp,
    });

    // 启动执行：queued → running + 后台 runtime（与 approveRun 共用同一装配）。
    return launchRun({ task, taskId: input.taskId, script: input.script, args: input.args, limits: input.limits, resumeAgentCalls, taskRun, record });
  }

  // ─── P6：Goal × Workflow 请求链路（§12.1：提案 → 批准/拒绝 → 执行） ─────────

  /**
   * GoalRun 侧提议一次 Workflow：静态校验 + 预算检查后落 blocked 请求（不执行），
   * 发出 workflow.request.created 事件等待用户批准。
   */
  async function proposeRun(input: {
    taskId: string;
    /** Goal 组合链路必填；独立 Dynamic Workflow 必须不传。 */
    goalRunId?: string;
    objective: string;
    proposedScript: string;
    estimatedAgents?: number;
    estimatedTokens?: number;
    limits?: Partial<WorkflowRuntimeLimits>;
  }): Promise<WorkflowRequestView> {
    const foundTask = await taskStore.getTask(input.taskId);
    if (!foundTask) {
      throw new TaskError('TASK_NOT_FOUND', `Task ${input.taskId} not found`, { taskId: input.taskId });
    }
    const task = assertExplicitUserTask(foundTask);

    // Goal × Workflow：必须绑定同一个 GoalRun，并消耗 Goal 专属预算。
    // 独立 Dynamic Workflow：没有 GoalRun，也不能伪造一个来绕过来源语义。
    if (task.origin === 'explicit_goal') {
      if (!input.goalRunId) {
        throw new TaskError('TASK_RUN_NOT_FOUND', `Goal task ${input.taskId} requires a goalRunId for a workflow request`, { taskId: input.taskId });
      }
      const goalRun = await taskStore.getRun(input.goalRunId);
      if (!goalRun || goalRun.taskId !== input.taskId || goalRun.kind !== 'goal') {
        throw new TaskError('TASK_RUN_NOT_FOUND', `Goal run ${input.goalRunId} not found for task ${input.taskId}`, {
          taskId: input.taskId,
          runId: input.goalRunId,
        });
      }
      await assertGoalBudget(input.taskId, input.goalRunId);
    } else if (input.goalRunId) {
      throw new TaskError('TASK_INVALID_TRANSITION', `Independent Dynamic Workflow ${input.taskId} cannot be attached to a Goal run`, {
        taskId: input.taskId,
        goalRunId: input.goalRunId,
      });
    }

    const validation = validateWorkflowScript(input.proposedScript);
    if (!validation.ok) {
      throw new TaskError(
        'WORKFLOW_SCRIPT_INVALID',
        `Workflow script failed static validation: ${validation.diagnostics.map((d) => `${d.code}:${d.message}`).join('; ')}`,
        { taskId: input.taskId, diagnostics: validation.diagnostics },
      );
    }

    const timestamp = new Date(now()).toISOString();
    const workflowRunId = `wfrun_${now()}_${randomUUID().slice(0, 8)}`;
    const taskRunId = `taskrun_${now()}_${randomUUID().slice(0, 8)}`;
    const scriptHash = createHash('sha256').update(input.proposedScript).digest('hex');

    const taskRun: TaskRun = {
      id: taskRunId,
      taskId: input.taskId,
      threadId: task.threadId,
      kind: 'workflow',
      workflowKind: 'script',
      status: 'blocked',
      workflowRunId,
      startedAt: timestamp,
      updatedAt: timestamp,
      version: 0,
    };
    await taskStore.createRun(taskRun);
    const record: WorkflowRunRecord = {
      id: workflowRunId,
      taskRunId,
      script: input.proposedScript,
      scriptHash,
      status: 'blocked',
      ...(input.goalRunId ? { goalRunId: input.goalRunId } : {}),
      agentCalls: [],
      usage: { inputTokens: 0, outputTokens: 0, agentCallCount: 0, durationMs: 0 },
      startedAt: timestamp,
      updatedAt: timestamp,
    };
    await taskStore.upsertWorkflowRun(record);
    publishEvent({
      type: 'workflow.request.created',
      threadId: task.threadId,
      taskId: input.taskId,
      runId: workflowRunId,
      ...(input.goalRunId ? { goalRunId: input.goalRunId } : {}),
      objective: input.objective,
      estimatedAgents: input.estimatedAgents ?? 0,
      estimatedTokens: input.estimatedTokens ?? 0,
      timestamp,
    });
    return {
      runId: workflowRunId,
      taskRunId,
      ...(input.goalRunId ? { goalRunId: input.goalRunId } : {}),
      status: 'blocked',
    };
  }

  /**
   * 批准待决请求：blocked → queued → 启动执行（与 startRun 共用 launchRun 装配）。
   * 批准时重新校验预算（提案后可能已并行批准其他请求）。
   * §14.10：用户可以编辑脚本后再批准，但编辑版必须重新通过静态校验；
   * 批准后脚本内容与 scriptHash 固化，不得运行时变更。
   */
  async function approveRun(
    runId: string,
    options: { script?: string } = {},
  ): Promise<WorkflowRequestDecisionView> {
    const record = await requireBlockedRequest(runId);
    const taskRun = await requireWorkflowTaskRun(record.taskRunId);
    const task = assertExplicitUserTask(await requireTaskForRun(taskRun.taskId));
    if (record.goalRunId) {
      const max = deps.maxWorkflowRunsPerGoal ?? DEFAULT_GOAL_BUDGET_POLICY.maxWorkflowRunsPerGoal;
      const existing = await taskStore.listWorkflowRuns({ goalRunId: record.goalRunId });
      if (existing.length > max) {
        throw new TaskError('WORKFLOW_LIMIT_EXCEEDED', `Goal 已超过 maxWorkflowRunsPerGoal 上限（${max}），拒绝批准。`, {
          taskId: taskRun.taskId,
          workflowRunId: runId,
        });
      }
    }

    const timestamp = new Date(now()).toISOString();
    // §14.10：编辑后的脚本先重新过静态校验（失败不得迁移任何状态），通过后连同新 hash 一起固化。
    const editedScript =
      typeof options.script === 'string' && options.script.trim() && options.script !== record.script
        ? options.script
        : undefined;
    let approvedRecord = record;
    if (editedScript) {
      const validation = validateWorkflowScript(editedScript);
      if (!validation.ok) {
        throw new TaskError(
          'WORKFLOW_SCRIPT_INVALID',
          `编辑后的脚本未通过静态校验：${validation.diagnostics.map((d) => `${d.code}:${d.message}`).join('; ')}`,
          { workflowRunId: runId, diagnostics: validation.diagnostics },
        );
      }
      approvedRecord = {
        ...record,
        script: editedScript,
        scriptHash: createHash('sha256').update(editedScript).digest('hex'),
      };
    }
    // 先查全局串行闸门：已有 run 在跑时保持请求为 blocked，用户稍后可重试批准（不留下 queued 半状态）。
    assertNoActiveRun(approvedRecord.scriptHash, { taskId: taskRun.taskId, workflowRunId: runId });
    // TaskRun blocked → queued（launchRun 内再 queued → running；协议迁移表无 `blocked → running` 直达边）。
    const queuedTaskRun = await taskStore.updateRun(taskRun.id, { status: 'queued', updatedAt: timestamp }, taskRun.version);
    const queuedRecord: WorkflowRunRecord = { ...approvedRecord, status: 'queued', updatedAt: timestamp };
    await taskStore.upsertWorkflowRun(queuedRecord);
    publishEvent({
      type: 'workflow.request.approved',
      threadId: task.threadId,
      taskId: taskRun.taskId,
      runId,
      ...(record.goalRunId ? { goalRunId: record.goalRunId } : {}),
      timestamp,
    });
    publishEvent({
      type: 'workflow.run.updated',
      threadId: task.threadId,
      taskId: taskRun.taskId,
      runId,
      status: 'queued',
      timestamp,
    });
    await launchRun({ task, taskId: taskRun.taskId, script: approvedRecord.script, args: approvedRecord.args, limits: undefined, resumeAgentCalls: undefined, taskRun: queuedTaskRun, record: queuedRecord });
    return {
      runId,
      taskRunId: taskRun.id,
      ...(record.goalRunId ? { goalRunId: record.goalRunId } : {}),
      status: 'approved',
      ...(editedScript ? { scriptEdited: true } : {}),
      scriptHash: approvedRecord.scriptHash,
    };
  }

  /** 拒绝待决请求：RunRecord blocked → cancelled，TaskRun blocked → cancelled，发 rejected 事件。 */
  async function rejectRun(runId: string, reason?: string): Promise<WorkflowRequestDecisionView> {
    const record = await requireBlockedRequest(runId);
    const taskRun = await requireWorkflowTaskRun(record.taskRunId);
    const task = assertExplicitUserTask(await requireTaskForRun(taskRun.taskId));
    const timestamp = new Date(now()).toISOString();
    await taskStore.upsertWorkflowRun({ ...record, status: 'cancelled', completedAt: timestamp, updatedAt: timestamp });
    await taskStore.updateRun(
      taskRun.id,
      { status: 'cancelled', error: reason ?? 'workflow request rejected', updatedAt: timestamp, completedAt: timestamp },
      taskRun.version,
    );
    publishEvent({
      type: 'workflow.request.rejected',
      threadId: task.threadId,
      taskId: taskRun.taskId,
      runId,
      ...(record.goalRunId ? { goalRunId: record.goalRunId } : {}),
      ...(reason !== undefined ? { reason } : {}),
      timestamp,
    });
    publishEvent({
      type: 'workflow.run.terminal',
      threadId: task.threadId,
      taskId: taskRun.taskId,
      runId,
      status: 'cancelled',
      reason: reason ?? 'workflow request rejected',
      timestamp,
    });
    return { runId, taskRunId: taskRun.id, ...(record.goalRunId ? { goalRunId: record.goalRunId } : {}), status: 'rejected' };
  }

  /** 列出某 Task 仍待批准的 workflow 请求（RunRecord status=blocked）。 */
  async function listRequests(taskId: string): Promise<WorkflowRunRecord[]> {
    assertExplicitUserTask(await requireTaskForRun(taskId));
    const runs = await taskStore.listRuns(taskId);
    const out: WorkflowRunRecord[] = [];
    for (const run of runs) {
      if (run.kind !== 'workflow' || !run.workflowRunId) continue;
      const record = await taskStore.getWorkflowRun(run.workflowRunId);
      if (record?.status === 'blocked') out.push(record);
    }
    return out;
  }

  /**
   * 所有以 workflowRunId 访问的路径也必须回溯到显式用户 Task 来源。
   * 否则历史 shadow 记录能绕过 taskId 级 gate，被普通 Agent 当作动态工作流读取或取消。
   */
  async function requireExplicitUserWorkflowRun(runId: string): Promise<WorkflowRunRecord | null> {
    const record = await taskStore.getWorkflowRun(runId);
    if (!record) return null;
    const taskRun = await taskStore.getRun(record.taskRunId);
    if (!taskRun) return null;
    assertExplicitUserTask(await requireTaskForRun(taskRun.taskId));
    return record;
  }

  /** 取消运行中的显式 Dynamic Workflow；不存在或已终态返回 false。 */
  async function cancelRun(runId: string): Promise<boolean> {
    const record = await requireExplicitUserWorkflowRun(runId);
    if (!record) return false;
    const entry = controllers.get(runId);
    if (!entry) return false;
    entry.controller.abort();
    return true;
  }

  /** GET /api/workflows/runs/:id/result —— 显式 Dynamic Workflow 的 RunRecord + AgentCalls（含终态）。 */
  async function getResult(runId: string): Promise<WorkflowRunResultView | null> {
    const run = await requireExplicitUserWorkflowRun(runId);
    if (!run) return null;
    const agentCalls = await taskStore.listAgentCalls(runId);
    return { run, agentCalls };
  }

  /**
   * GET /api/workflows/runs/:id/evidence（计划 §13.1）—— 本次 Run 物化出的 Evidence 引用列表。
   * 只读已落库真相；尚未物化时 evidenceIds 为空，不伪造引用。
   */
  async function getEvidence(runId: string): Promise<WorkflowRunEvidenceView | null> {
    const run = await requireExplicitUserWorkflowRun(runId);
    if (!run) return null;
    const agentCalls = await taskStore.listAgentCalls(runId);
    const evidenceIds = agentCalls
      .map((call) => call.evidenceId)
      .filter((value): value is string => typeof value === 'string' && value.length > 0);
    if (run.evidenceId) evidenceIds.push(run.evidenceId);
    return {
      runId: run.id,
      taskRunId: run.taskRunId,
      status: run.status,
      ...(run.goalRunId !== undefined ? { goalRunId: run.goalRunId } : {}),
      ...(run.evidenceId !== undefined ? { runEvidenceId: run.evidenceId } : {}),
      evidenceIds,
      ...(run.result !== undefined ? { result: run.result } : {}),
    };
  }

  /**
   * P5：进程重启后，把非终态 WorkflowRunRecord 标记 interrupted（§5.5 恢复模型）。
   * 脚本运行状态只存在于进程内闭包，进程退出后不可能续跑；
   * TaskRun 镜像由 recoverInterruptedRuns 统一回写，这里只补 WorkflowRunRecord。
   */
  async function markWorkflowRunsInterrupted(runIds: readonly string[]): Promise<number> {
    let changed = 0;
    for (const runId of runIds) {
      try {
        const record = await taskStore.getWorkflowRun(runId);
        if (!record || isWorkflowRunTerminalStatus(record.status)) continue;
        const timestamp = new Date(now()).toISOString();
        await taskStore.upsertWorkflowRun({ ...record, status: 'interrupted', updatedAt: timestamp });
        changed += 1;
      } catch {
        // 单个失败不阻断其余恢复。
      }
    }
    return changed;
  }

  // ─── 内部装配 ──────────────────────────────────────────────────────────────

  /**
   * 启动执行（startRun / approveRun 共用）：queued → running、后台 runtime、
   * 完成 → P6 证据物化（fail-fast）→ 终态落库 + 事件 → Goal 触发时自动续跑钩子。
   */
  async function launchRun(ctx: {
    task: Task;
    taskId: string;
    script: string;
    args?: unknown;
    limits?: Partial<WorkflowRuntimeLimits>;
    resumeAgentCalls?: WorkflowAgentCall[];
    taskRun: TaskRun;
    record: WorkflowRunRecord;
  }): Promise<StartWorkflowRunResult> {
    const { task, taskId, script, args, limits, resumeAgentCalls, taskRun, record } = ctx;
    const workflowRunId = record.id;
    const taskRunId = taskRun.id;
    const scriptHash = record.scriptHash;

    // queued → running（TaskRun 走状态机；RunRecord 由 runtime 启动时再次落 running）。
    const runningTaskRun = await taskStore.updateRun(taskRunId, { status: 'running', updatedAt: new Date(now()).toISOString() }, taskRun.version);
    void runningTaskRun;
    await taskStore.upsertWorkflowRun({ ...record, status: 'running', updatedAt: new Date(now()).toISOString() });

    // 后台执行：不 await —— 运行中不阻塞主会话（P4 验收项）。
    const executor = await createExecutor({ taskId, threadId: task.threadId, workflowRunId });
    const runtime = new WorkflowScriptRuntime({
      script,
      scriptHash,
      runId: workflowRunId,
      taskRunId,
      args,
      limits: { ...DEFAULT_WORKFLOW_RUNTIME_LIMITS, ...limits },
      executor,
      store: taskStore,
      onEvent: (event) => publishWorkflowEvent(event, taskId, task.threadId),
      signal: registerController(workflowRunId, scriptHash),
      resumeAgentCalls,
      now,
    });
    void runtime.run()
      .then(async (result) => {
        if (result.status === 'completed') {
          // P6 fail-fast：先物化 Evidence；失败时 run 必须落 failed，不得静默降级。
          const settled = await taskStore.getWorkflowRun(workflowRunId);
          if (settled) {
            try {
              await materializeWorkflowEvidence(taskId, task.threadId, settled, result.value);
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              await failMaterialization(taskId, task.threadId, taskRunId, workflowRunId, settled, message, result.usage);
              return;
            }
          }
        }
        await settleTaskRun(taskId, task.threadId, taskRunId, workflowRunId, result.status, result.error, result.usage);
        if (result.status === 'completed' && record.goalRunId) {
          try {
            await deps.onGoalResume?.({ taskId, goalRunId: record.goalRunId, workflowRunId });
          } catch (error) {
            // 自动续跑失败不影响 Workflow 终态；但必须记账，否则用户无法得知目标未续上。
            const message = error instanceof Error ? error.message : String(error);
            deps.logger?.warn(
              `[workflows] goal resume failed for goal run ${record.goalRunId} after ${workflowRunId}: ${message}`,
            );
          }
        }
      })
      .catch((error) => {
        // runtime.run 正常路径不 reject；防御：异常也必须落终态。
        const message = error instanceof Error ? error.message : String(error);
        void settleTaskRun(taskId, task.threadId, taskRunId, workflowRunId, 'failed', message);
      })
      .finally(() => controllers.delete(workflowRunId));

    return { runId: workflowRunId, taskRunId, status: 'running' };
  }

  /**
   * §14.11：全局串行闸门 —— 已有任一 WorkflowRun 在运行时拒绝新启动（第一版不带队列）。
   * 必须在创建任何记录/迁移状态之前调用，否则失败会留下永久 queued/blocked 的半状态。
   */
  function assertNoActiveRun(scriptHash: string, context: { taskId: string; workflowRunId?: string }): void {
    if (controllers.size === 0) return;
    const sameScript = [...controllers.values()].some((entry) => entry.scriptHash === scriptHash);
    throw new TaskError(
      'TASK_ACTIVE_EXISTS',
      sameScript
        ? '同一脚本的 Workflow 运行仍在进行中，请等待完成或取消后再启动。'
        : `已有 ${controllers.size} 个 Workflow 运行在进行中；第一版全局串行（同时只允许一个 WorkflowRun），请等待完成或取消后再启动。`,
      { taskId: context.taskId, ...(context.workflowRunId ? { workflowRunId: context.workflowRunId } : {}), activeRuns: controllers.size },
    );
  }

  /** Goal 预算校验（提案时 >= 上限拒绝；批准时防御性 > 上限拒绝）。 */
  async function assertGoalBudget(taskId: string, goalRunId: string): Promise<void> {
    const max = deps.maxWorkflowRunsPerGoal ?? DEFAULT_GOAL_BUDGET_POLICY.maxWorkflowRunsPerGoal;
    const existing = await taskStore.listWorkflowRuns({ goalRunId });
    if (existing.length >= max) {
      throw new TaskError(
        'WORKFLOW_LIMIT_EXCEEDED',
        `Goal 已达到 maxWorkflowRunsPerGoal 上限（${max}），拒绝新的 Workflow 请求。`,
        { taskId, workflowRunId: goalRunId },
      );
    }
  }

  /**
   * P6：把 run 终态结果物化到 Evidence（计划 §11.3）：
   * 每个完成的 AgentCall 设置 evidenceId（wev_<runId>_<callId>），run 级补 wev_<runId>_run，
   * 并发出 workflow.evidence.created。重复物化幂等（已带 evidenceId 的 call 跳过）。
   */
  async function materializeWorkflowEvidence(
    taskId: string,
    threadId: ThreadId,
    record: WorkflowRunRecord,
    value: unknown,
  ): Promise<void> {
    try {
      const timestamp = new Date(now()).toISOString();
      const evidenceIds: string[] = [];
      const calls = await taskStore.listAgentCalls(record.id);
      for (const call of calls) {
        if (call.status !== 'completed' || call.result === undefined || call.evidenceId) continue;
        const evidenceId = workflowEvidenceId(record.id, call.id);
        // 计划 §13.1：结果回填先产 result.created（只带指纹与大小），再产 evidence.created。
        publishEvent({
          type: 'workflow.result.created',
          threadId,
          taskId,
          runId: record.id,
          agentCallId: call.id,
          ...resultFingerprint(call.result),
          timestamp,
        });
        await taskStore.updateAgentCall(record.id, { ...call, evidenceId });
        evidenceIds.push(evidenceId);
      }
      const runEvidenceId = workflowEvidenceId(record.id);
      publishEvent({
        type: 'workflow.result.created',
        threadId,
        taskId,
        runId: record.id,
        ...resultFingerprint(value),
        timestamp: new Date(now()).toISOString(),
      });
      // agentCalls 置空：子表才是调用级真相，否则内联副本会反向覆盖上面刚写入的 per-call evidenceId。
      await taskStore.upsertWorkflowRun({
        ...record,
        agentCalls: [],
        result: value,
        evidenceId: runEvidenceId,
        updatedAt: timestamp,
      });
      evidenceIds.push(runEvidenceId);
      publishEvent({
        type: 'workflow.evidence.created',
        threadId,
        taskId,
        runId: record.id,
        evidenceIds,
        timestamp: new Date(now()).toISOString(),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new TaskError(
        'WORKFLOW_EVIDENCE_MATERIALIZATION_FAILED',
        `Workflow 证据物化失败：${message}`,
        { taskId, workflowRunId: record.id },
      );
    }
  }

  /** 证据物化失败：RunRecord → failed + TaskRun/终态事件（不抛出，由后台链收口）。 */
  async function failMaterialization(
    taskId: string,
    threadId: ThreadId,
    taskRunId: string,
    workflowRunId: string,
    record: WorkflowRunRecord,
    message: string,
    usage?: WorkflowUsageSummary,
  ): Promise<void> {
    const timestamp = new Date(now()).toISOString();
    try {
      await taskStore.upsertWorkflowRun({ ...record, status: 'failed', updatedAt: timestamp, completedAt: timestamp });
    } catch {
      // 终态写失败不再二次抛出。
    }
    await settleTaskRun(taskId, threadId, taskRunId, workflowRunId, 'failed', `workflow evidence materialization failed: ${message}`, usage);
  }

  async function requireBlockedRequest(runId: string): Promise<WorkflowRunRecord> {
    const record = await taskStore.getWorkflowRun(runId);
    if (!record) {
      throw new TaskError('WORKFLOW_RUN_NOT_FOUND', `Workflow run ${runId} was not found`, { workflowRunId: runId });
    }
    if (record.status !== 'blocked') {
      throw new TaskError('TASK_INVALID_TRANSITION', `workflow run ${runId} is ${record.status}, expected blocked`, {
        workflowRunId: runId,
        from: record.status,
      });
    }
    return record;
  }

  async function requireWorkflowTaskRun(taskRunId: string): Promise<TaskRun> {
    const taskRun = await taskStore.getRun(taskRunId);
    if (!taskRun) {
      throw new TaskError('TASK_RUN_NOT_FOUND', `Task run ${taskRunId} not found`, { runId: taskRunId });
    }
    return taskRun;
  }

  async function requireTaskForRun(taskId: string): Promise<Task> {
    const task = await taskStore.getTask(taskId);
    if (!task) {
      throw new TaskError('TASK_NOT_FOUND', `Task ${taskId} not found`, { taskId });
    }
    return task;
  }

  /** Dynamic Workflow 只允许用户显式入口；普通 Harness shadow 永远不能借 API 进入。 */
  function assertExplicitUserTask(task: Task): Task {
    if (task.origin !== 'explicit_goal' && task.origin !== 'explicit_workflow') {
      throw new TaskError(
        'TASK_INVALID_TRANSITION',
        `Dynamic Workflow is available only for explicitly created Goals or Dynamic Workflows (task ${task.id})`,
        { taskId: task.id, origin: task.origin ?? 'harness_shadow' },
      );
    }
    return task;
  }

  /** 仅 Goal × Workflow 组合链路可用；独立 Dynamic Workflow 不应假装绑定 GoalRun。 */
  function assertExplicitGoalTask(task: Task): Task {
    assertExplicitUserTask(task);
    if (task.origin !== 'explicit_goal') {
      throw new TaskError(
        'TASK_INVALID_TRANSITION',
        `Goal-only operation requires an explicitly created Goal (task ${task.id})`,
        { taskId: task.id, origin: task.origin },
      );
    }
    return task;
  }

  function registerController(runId: string, scriptHash: string): AbortSignal {
    const controller = new AbortController();
    controllers.set(runId, { controller, scriptHash });
    return controller.signal;
  }

  function publishWorkflowEvent(event: WorkflowRuntimeEvent, taskId: string, threadId: ThreadId): void {
    const timestamp = new Date(now()).toISOString();
    if (event.type === 'workflow.phase' || event.type === 'workflow.log') {
      // phase/log 映射为 run.updated 的增量刷新（协议目录不单列 phase/log 事件名）。
      publishEvent({
        type: 'workflow.run.updated',
        threadId,
        taskId,
        runId: event.runId ?? '',
        status: 'running',
        phase: event.phase,
        timestamp,
      });
      return;
    }
    const agentCall = event.agentCall;
    const summary = {
      id: agentCall?.id ?? '',
      status: agentCall?.status ?? 'unknown',
      label: agentCall?.label,
      phase: event.phase,
      ...(agentCall?.error !== undefined ? { error: agentCall.error } : {}),
    };
    if (event.type === 'workflow.agent_call.updated') {
      publishEvent({ type: 'workflow.agent_call.updated', threadId, taskId, runId: event.runId ?? '', agentCall: summary, timestamp });
    } else {
      publishEvent({ type: 'workflow.agent_call.terminal', threadId, taskId, runId: event.runId ?? '', agentCall: summary, timestamp });
    }
  }

  /** 终态落 TaskRun（状态机迁移）+ workflow.run.terminal 事件；RunRecord 终态由 runtime 落。 */
  async function settleTaskRun(
    taskId: string,
    threadId: ThreadId,
    taskRunId: string,
    workflowRunId: string,
    status: 'completed' | 'failed' | 'cancelled',
    error: string | undefined,
    usage?: WorkflowUsageSummary,
  ): Promise<void> {
    const timestamp = new Date(now()).toISOString();
    const terminalStatus: 'completed' | 'failed' | 'cancelled' = status;
    try {
      const run = await taskStore.getRun(taskRunId);
      if (run) {
        await taskStore.updateRun(
          taskRunId,
          {
            status: terminalStatus,
            updatedAt: timestamp,
            completedAt: timestamp,
            ...(error !== undefined ? { error } : {}),
          },
          run.version,
        );
      }
    } catch {
      // 终态写失败不再二次抛出（与 harness settleTerminalState 容错一致）。
    }
    // run.updated（携带 usage/终态前状态）之后必须跟 terminal 事件（§14.9 每个终态必须有事件）。
    publishEvent({
      type: 'workflow.run.updated',
      threadId,
      taskId,
      runId: workflowRunId,
      status: terminalStatus,
      usage,
      timestamp,
    });
    publishEvent({
      type: 'workflow.run.terminal',
      threadId,
      taskId,
      runId: workflowRunId,
      status: terminalStatus,
      ...(error !== undefined ? { reason: error } : {}),
      usage,
      timestamp,
    });
  }

  return { validate, validateForTask, startRun, proposeRun, approveRun, rejectRun, listRequests, listScripts, cancelRun, getResult, getEvidence, markWorkflowRunsInterrupted };
}

export type WorkflowScriptService = ReturnType<typeof createWorkflowScriptService>;
