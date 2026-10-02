// Workflow 脚本服务装配（P4b）：把 createWorkflowScriptService 绑定到租户 AgentLoop。
//
// 独立成模块的原因：server.ts 只做路由装配与共享接线（serverStructure 行数约束），
// 子代理执行器的 runTurn 适配细节（结构化输出指令、harness 来源、冷记忆豁免）放这里。
// service 持有 runId → AbortController 取消注册表，必须按租户进程级缓存，
// 每请求新建会丢失取消能力。
//
// — English: per-tenant WorkflowScriptService factory wiring runTurn as the agent executor.

import type {
  AgentMessageItem,
  TaskStorePort,
  ThreadEvent,
  ThreadId,
  ThreadItem,
  Usage,
  UserInput,
} from '@suanlizi/protocol';
import type { WorkflowResultEvidenceInput } from '@suanlizi/runtime';
import { blockForUserInput } from '@suanlizi/runtime';
import type { TenantContext } from '../shared/tenant.js';
import { createWorkflowScriptService, type WorkflowScriptService } from './workflowScriptService.js';
import { harnessRuntimeRegistry } from './harnessRuntime.js';
import {
  createTaskLifecycleService,
  type TaskLifecycleAgent,
  type TaskWorkflowIntegration,
} from './taskLifecycleService.js';

/** 子代理执行面：AgentLoop.runTurn 的结构子集（便于测试注入 fake agent）。 */
export interface WorkflowSubAgent {
  runTurn(
    threadId: ThreadId,
    userInput: UserInput,
    signal?: AbortSignal,
    options?: {
      source?: 'user' | 'harness';
      visibleToUser?: boolean;
      harnessRunId?: string;
      skipColdMemory?: boolean;
      extractMemory?: boolean;
    },
  ): Promise<{ items: ThreadItem[]; usage: Usage | null }>;
}

export interface WorkflowScriptWiringDeps {
  taskStore: TaskStorePort;
  /** 与 server.ts publishEvent 同型：tenantId 作为第二参数。 */
  publishEvent: (event: ThreadEvent, tenantId: string) => void;
  createTenantAgent: () => Promise<{ agent: WorkflowSubAgent }>;
}

const services = new Map<string, WorkflowScriptService>();

/**
 * P6：Goal 自动续跑钩子（按租户懒建生命周期服务）。
 * Workflow 完成且证据已物化后，把 blocked 的 GoalRun 经 `input` 通道重新排队并起新 harness，
 * 新 harness 会预载刚物化的 Evidence（GoalRun → WorkflowRun → GoalRun，计划 §12.1）。
 * GoalRun 已被用户取消 / 终态时 input() 抛错，由 service 层 swallow，不影响 Workflow 终态。
 */
async function continueGoalAfterWorkflow(
  tenantContext: TenantContext,
  deps: WorkflowScriptWiringDeps,
  ctx: { taskId: string; goalRunId: string; workflowRunId: string },
): Promise<void> {
  const lifecycle = createTaskLifecycleService({
    taskStore: deps.taskStore,
    getAgent: async () => (await deps.createTenantAgent()).agent as unknown as TaskLifecycleAgent,
    publishEvent: (event) => deps.publishEvent(event, tenantContext.tenantId),
    registry: harnessRuntimeRegistry,
    tenantId: tenantContext.tenantId,
    workflow: taskWorkflowIntegrationForTenant(tenantContext, deps),
  });
  await lifecycle.input(ctx.taskId, {
    answer: `Workflow ${ctx.workflowRunId} 已完成并物化证据，请基于 Evidence 继续推进目标。`,
  });
}

export function workflowScriptServiceForTenant(
  tenantContext: TenantContext,
  deps: WorkflowScriptWiringDeps,
): WorkflowScriptService {
  const existing = services.get(tenantContext.tenantId);
  if (existing) return existing;
  const service = createWorkflowScriptService({
    taskStore: deps.taskStore,
    publishEvent: (event) => deps.publishEvent(event, tenantContext.tenantId),
    onGoalResume: (ctx) => continueGoalAfterWorkflow(tenantContext, deps, ctx),
    logger: { warn: (message) => console.warn(message) },
    createExecutor: async ({ threadId, workflowRunId }) => {
      const { agent } = await deps.createTenantAgent();
      return async (input) => {
        const prompt = input.schema
          ? `${input.prompt}\n\n[结构化输出要求] 最终回复必须是一个符合以下 JSON Schema 的 JSON 对象，不要包含其它文字或代码围栏：\n${JSON.stringify(input.schema)}`
          : input.prompt;
        const { items, usage } = await agent.runTurn(threadId, { type: 'text', text: prompt }, input.signal, {
          source: 'harness',
          visibleToUser: false,
          skipColdMemory: true,
          extractMemory: false,
          harnessRunId: workflowRunId,
        });
        const message = [...items]
          .reverse()
          .find((item): item is AgentMessageItem => item.type === 'agent_message');
        if (!message) {
          throw new Error(`Workflow agent call ${input.callId} produced no agent message`);
        }
        return {
          result: message.structuredOutput ?? message.text,
          inputTokens: usage?.inputTokens ?? 0,
          outputTokens: usage?.outputTokens ?? 0,
        };
      };
    },
  });
  services.set(tenantContext.tenantId, service);
  return service;
}

// ─── P6：Goal × Workflow 组合集成（server.ts 装配到 handleTaskRoute） ─────────

/** 把任意结果安全地压成单行摘要（外部不可信数据只进 Evidence refs，不进模型上下文）。 */
function summarizeResult(value: unknown): string {
  if (value === undefined) return '(no result)';
  let text: string;
  try {
    text = typeof value === 'string' ? value : JSON.stringify(value);
  } catch {
    text = String(value);
  }
  return text.replace(/\s+/g, ' ').slice(0, 400);
}

/**
 * 把某 Task 历史 WorkflowRun 结果投影成 Evidence seeds（GoalEvaluator 只读 Evidence 消费）。
 * 仅取 completed 记录：每个已完成的 AgentCall 一条 run 内 seed，再加一条 run 级 seed
 * （summary 携带脚本 return 终态结果）。失败链路由 evidenceLedger 物化时的 fail-fast 保证。
 */
export async function projectWorkflowEvidenceSeeds(
  taskStore: TaskStorePort,
  taskId: string,
): Promise<WorkflowResultEvidenceInput[]> {
  const runs = await taskStore.listRuns(taskId);
  const seeds: WorkflowResultEvidenceInput[] = [];
  for (const run of runs) {
    if (run.kind !== 'workflow' || !run.workflowRunId) continue;
    const record = await taskStore.getWorkflowRun(run.workflowRunId);
    if (!record || record.status !== 'completed') continue;
    for (const call of record.agentCalls) {
      if (call.status !== 'completed') continue;
      seeds.push({
        runId: record.id,
        agentCallId: call.id,
        summary: `${call.label ?? 'agent'}: ${summarizeResult(call.result)}`,
        status: 'passed',
        timestamp: call.completedAt ?? record.completedAt ?? record.updatedAt,
      });
    }
    seeds.push({
      runId: record.id,
      summary: `workflow run ${record.id} completed: ${summarizeResult(record.result)}`,
      status: 'passed',
      timestamp: record.completedAt ?? record.updatedAt,
    });
  }
  return seeds;
}

/**
 * P6：Task 生命周期服务的 workflow 集成注入。
 * onRequest 转发到按租户缓存的 WorkflowScriptService.proposeRun（校验 + 预算 + blocked 落库），
 * 并把 GoalRun 就近 block 住写明待确认问题（批准后可自动续跑，用户也可先手动推进）；
 * evidenceProvider 把历史 workflow 结果投影成 wev_ seeds 供 harness 预载。
 */
export function taskWorkflowIntegrationForTenant(
  tenantContext: TenantContext,
  deps: WorkflowScriptWiringDeps,
): TaskWorkflowIntegration {
  const service = workflowScriptServiceForTenant(tenantContext, deps);
  return {
    onRequest: async (request) => {
      const proposed = await service.proposeRun(request);
      // GoalRun 收口为 blocked + pendingInput：既给用户可操作的问题，也是后续续跑的输入通道。
      await blockForUserInput(deps.taskStore, request.taskId, PROPOSAL_QUESTION(request.objective, proposed.runId), {
        runId: request.goalRunId,
      });
      return proposed;
    },
    evidenceProvider: (taskId) => projectWorkflowEvidenceSeeds(deps.taskStore, taskId),
  };
}

function PROPOSAL_QUESTION(objective: string, runId: string): string {
  return `目标提议了一个 Workflow（${objective}，请求 ${runId}），待你在「工作流」面板批准或拒绝；批准后会自动执行并基于结果继续目标。`;
}
