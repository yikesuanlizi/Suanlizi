// P6：workflowScriptWiring 装配层测试 —— 证据投影（projectWorkflowEvidenceSeeds）
// 与 Goal × Workflow 集成工厂（taskWorkflowIntegrationForTenant）。
//
// — Chinese: P6 wiring-layer tests for evidence projection and integration factory.

import { describe, expect, it, vi } from 'vitest';
import type { Task, ThreadEvent, WorkflowRunRecord } from '@suanlizi/protocol';
import { FakeTaskStore } from '../testing/fakeTaskStore.js';
import {
  projectWorkflowEvidenceSeeds,
  taskWorkflowIntegrationForTenant,
  workflowScriptServiceForTenant,
} from './workflowScriptWiring.js';

class WorkflowAwareStore extends FakeTaskStore {
  workflowRuns = new Map<string, WorkflowRunRecord>();

  override async upsertWorkflowRun(record: WorkflowRunRecord): Promise<WorkflowRunRecord> {
    this.workflowRuns.set(record.id, structuredClone(record));
    return structuredClone(record);
  }

  override async getWorkflowRun(id: string): Promise<WorkflowRunRecord | null> {
    const record = this.workflowRuns.get(id);
    return record ? structuredClone(record) : null;
  }
}

const VALID_SCRIPT = [
  'export const meta = { name: "demo", description: "demo flow", phases: ["p1"] };',
  'phase("p1");',
  'const found = await agent("list files", { label: "lister" });',
  'return { files: found.files };',
].join('\n');

function workflowTaskRun(id: string, workflowRunId: string, status: 'running' | 'completed' | 'blocked' | 'failed') {
  return {
    id,
    taskId: 'task-wf-1',
    threadId: 'thread-wf-1',
    kind: 'workflow' as const,
    workflowKind: 'script' as const,
    status,
    workflowRunId,
    startedAt: '2026-09-20T00:00:00.000Z',
    updatedAt: '2026-09-20T00:00:00.000Z',
    version: 0,
  };
}

describe('projectWorkflowEvidenceSeeds（P6）', () => {
  it('completed workflow 记录 → agentCall 级 + run 级 seeds；blocked/failed 不投影', async () => {
    const store = new WorkflowAwareStore();
    // goal run（不投影）+ completed workflow + blocked 请求 + failed 运行。
    await store.createRun({
      id: 'goalrun-1',
      taskId: 'task-wf-1',
      threadId: 'thread-wf-1',
      kind: 'goal',
      status: 'running',
      startedAt: '2026-09-20T00:00:00.000Z',
      updatedAt: '2026-09-20T00:00:00.000Z',
      version: 0,
    });
    await store.createRun(workflowTaskRun('taskrun-done', 'wfrun-done', 'completed'));
    await store.createRun(workflowTaskRun('taskrun-blocked', 'wfrun-blocked', 'blocked'));
    await store.createRun(workflowTaskRun('taskrun-failed', 'wfrun-failed', 'failed'));
    await store.upsertWorkflowRun({
      id: 'wfrun-done',
      taskRunId: 'taskrun-done',
      script: VALID_SCRIPT,
      scriptHash: 'hash-done',
      status: 'completed',
      goalRunId: 'goalrun-1',
      evidenceId: 'wev_wfrun-done_run',
      result: { files: ['a.ts'], count: 1 },
      agentCalls: [{
        id: 'call-1',
        label: 'lister',
        prompt: 'list files',
        status: 'completed',
        result: { files: ['a.ts'] },
        inputTokens: 10,
        outputTokens: 5,
        completedAt: '2026-09-20T01:00:00.000Z',
        evidenceId: 'wev_wfrun-done_call-1',
      }],
      usage: { inputTokens: 10, outputTokens: 5, agentCallCount: 1, durationMs: 5 },
      startedAt: '2026-09-20T00:00:00.000Z',
      updatedAt: '2026-09-20T01:00:00.000Z',
      completedAt: '2026-09-20T01:00:00.000Z',
    } as never);
    await store.upsertWorkflowRun({
      id: 'wfrun-blocked',
      taskRunId: 'taskrun-blocked',
      script: VALID_SCRIPT,
      scriptHash: 'hash-b',
      status: 'blocked',
      goalRunId: 'goalrun-1',
      agentCalls: [],
      usage: { inputTokens: 0, outputTokens: 0, agentCallCount: 0, durationMs: 0 },
      startedAt: '2026-09-20T00:00:00.000Z',
      updatedAt: '2026-09-20T00:00:00.000Z',
    } as never);
    await store.upsertWorkflowRun({
      id: 'wfrun-failed',
      taskRunId: 'taskrun-failed',
      script: VALID_SCRIPT,
      scriptHash: 'hash-f',
      status: 'failed',
      goalRunId: 'goalrun-1',
      agentCalls: [],
      usage: { inputTokens: 0, outputTokens: 0, agentCallCount: 0, durationMs: 0 },
      startedAt: '2026-09-20T00:00:00.000Z',
      updatedAt: '2026-09-20T00:00:00.000Z',
    } as never);

    const seeds = await projectWorkflowEvidenceSeeds(store, 'task-wf-1');
    // 1 个 agentCall 级 seed + 1 个 run 级 seed；blocked/failed/goal 不投影。
    expect(seeds).toHaveLength(2);
    const callSeed = seeds.find((seed) => seed.agentCallId === 'call-1');
    expect(callSeed?.runId).toBe('wfrun-done');
    expect(callSeed?.status).toBe('passed');
    expect(callSeed?.summary).toContain('lister');
    expect(callSeed?.summary).toContain('a.ts');
    const runSeed = seeds.find((seed) => !seed.agentCallId);
    expect(runSeed?.runId).toBe('wfrun-done');
    expect(runSeed?.summary).toContain('wfrun-done');
    expect(runSeed?.summary).toContain('count');
  });

  it('无 workflow 记录 / 未知 taskId → 空 seeds（零变化路径）', async () => {
    const store = new WorkflowAwareStore();
    expect(await projectWorkflowEvidenceSeeds(store, 'task-empty')).toEqual([]);
  });
});

// 集成工厂依赖按租户缓存的 service（进程级 Map），此处仅验证工厂可装配且回调转发；
// proposeRun / evidenceProvider 的完整行为已由 service 层测试覆盖。
describe('taskWorkflowIntegrationForTenant（P6）', () => {
  it('工厂装配后 onRequest/evidenceProvider 均为可调用函数（结构契约）', async () => {
    const { taskWorkflowIntegrationForTenant } = await import('./workflowScriptWiring.js');
    const integration = taskWorkflowIntegrationForTenant(
      { tenantId: 'default' } as never,
      {
        taskStore: new FakeTaskStore(),
        publishEvent: (_event: ThreadEvent, _tenantId: string) => {},
        createTenantAgent: async () => {
          throw new Error('not used in wiring contract test');
        },
      },
    );
    expect(typeof integration.onRequest).toBe('function');
    expect(typeof integration.evidenceProvider).toBe('function');
    expect(await integration.evidenceProvider('task-none')).toEqual([]);
  });
});

// ─── P6 生产续跑链：提案 → pendingInput → 批准 → 证据 → GoalRun 续跑 ───────────

class ChainFakeStore extends FakeTaskStore {
  workflowRuns = new Map<string, WorkflowRunRecord>();

  override async upsertWorkflowRun(record: WorkflowRunRecord): Promise<WorkflowRunRecord> {
    this.workflowRuns.set(record.id, structuredClone(record));
    return structuredClone(record);
  }

  override async getWorkflowRun(id: string): Promise<WorkflowRunRecord | null> {
    const record = this.workflowRuns.get(id);
    return record ? structuredClone(record) : null;
  }

  override async listWorkflowRuns(filter?: { goalRunId?: string }): Promise<WorkflowRunRecord[]> {
    const all = [...this.workflowRuns.values()];
    const matched = filter?.goalRunId ? all.filter((r) => r.goalRunId === filter.goalRunId) : all;
    return matched.map((r) => structuredClone(r));
  }
}

describe('taskWorkflowIntegrationForTenant P6 续跑链', () => {
  it('onRequest 落 pendingInput；批准后执行完成→证据物化→GoalRun 经 input 续跑新 harness', async () => {
    const store = new ChainFakeStore();
    const task: Task = {
      id: 'task-chain',
      threadId: 'thread-chain',
      origin: 'explicit_goal',
      objective: '批量整理仓库',
      acceptanceCriteria: ['完成整理'],
      status: 'running',
      runIds: ['goalrun-chain'],
      currentRunId: 'goalrun-chain',
      evidenceIds: [],
      createdAt: '2026-09-20T00:00:00.000Z',
      updatedAt: '2026-09-20T00:00:00.000Z',
      version: 0,
      interactionMode: 'supervised',
    };
    await store.createTask(task);
    await store.createRun({
      id: 'goalrun-chain',
      taskId: 'task-chain',
      threadId: 'thread-chain',
      kind: 'goal',
      status: 'running',
      startedAt: '2026-09-20T00:00:00.000Z',
      updatedAt: '2026-09-20T00:00:00.000Z',
      version: 0,
    });

    const runHarness = vi.fn(async () => ({ status: 'satisfied', iterations: 1 }));
    const fakeAgent = {
      // executor 需要一条 agent_message 才能产出结果（见 workflowScriptWiring.createExecutor）。
      runTurn: async () => ({
        items: [{
          id: 'item-agent-1',
          type: 'agent_message',
          turnId: 'turn-agent-1',
          text: '{"files":["a.ts"]}',
          status: 'completed',
          timestamp: '2026-09-20T00:00:00.000Z',
        }],
        usage: null,
      }),
      runHarness,
      resumeHarness: async () => ({ status: 'satisfied', iterations: 1 }),
      interrupt: () => true,
    };
    const tenantId = 'p6-chain-tenant';
    const events: ThreadEvent[] = [];
    const deps = {
      taskStore: store,
      publishEvent: (event: ThreadEvent) => { events.push(event); },
      createTenantAgent: async () => ({ agent: fakeAgent as never }),
    };
    const integration = taskWorkflowIntegrationForTenant({ tenantId } as never, deps);

    const proposed = await integration.onRequest({
      taskId: 'task-chain',
      goalRunId: 'goalrun-chain',
      objective: '批量扫描并整理文件',
      proposedScript: VALID_SCRIPT,
      estimatedAgents: 1,
      estimatedTokens: 100,
      limits: {
        maxConcurrentAgents: 2,
        maxAgentsPerRun: 4,
        maxItemsPerPipeline: 4,
        maxTotalTokens: 100000,
        maxDurationMs: 60000,
        requireApproval: true,
      },
    });

    // 1) 待批准请求落库 + GoalRun/Task block + pendingInput。
    expect(proposed.runId).toBeTruthy();
    expect(store.workflowRuns.get(proposed.runId)?.status).toBe('blocked');
    expect((await store.getRun('goalrun-chain'))?.status).toBe('blocked');
    const blockedTask = await store.getTask('task-chain');
    expect(blockedTask?.status).toBe('blocked');
    expect(blockedTask?.pendingInput?.question).toContain('批量扫描并整理文件');
    expect(events.some((event) => event.type === 'workflow.request.created')).toBe(true);

    // 2) 批准→后台执行完成→证据物化。
    const service = workflowScriptServiceForTenant({ tenantId } as never, deps);
    await service.approveRun(proposed.runId);
    for (let i = 0; i < 8; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
    expect(store.workflowRuns.get(proposed.runId)?.status).toBe('completed');
    expect(store.workflowRuns.get(proposed.runId)?.evidenceId).toBe(`wev_${proposed.runId}_run`);

    // 3) 自动续跑：input 通道把 GoalRun 重新排队并起新 harness。
    for (let i = 0; i < 8; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
    expect(runHarness).toHaveBeenCalledTimes(1);
    const resumedRun = await store.getRun('goalrun-chain');
    expect(resumedRun?.status).toBe('completed');
    expect((await store.getTask('task-chain'))?.pendingInput).toBeUndefined();
  });
});
