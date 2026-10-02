// P6 全链路 e2e（计划 §7 P6「全链路 API 测试」）：真实 node:http 监听临时端口 + 真实
// SqliteTaskStore + 生产装配函数（workflowScriptServiceForTenant / taskWorkflowIntegrationForTenant），
// 覆盖 GoalRun 提案 → 待批准请求 → 批准执行 → Evidence 物化 → GoalRun 续跑，
// 以及非法脚本 / 未知批准目标的 HTTP 失败语义。
// 服务只在测试进程内监听并在用例结束时 close，不留任何常驻服务。
// — Chinese: in-process HTTP + real SQLite end-to-end coverage of the P6 chain.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createStore } from '@suanlizi/storage';
import type { HarnessResult } from '@suanlizi/runtime';
import type { Task, TaskRun, ThreadEvent, TaskStorePort, Usage } from '@suanlizi/protocol';
import { handleTaskRoute } from './taskRoute.js';
import { handleWorkflowScriptRoute } from './workflowScriptRoute.js';
import { createTaskGoalStatusService } from '../services/taskGoalStatusService.js';
import {
  taskWorkflowIntegrationForTenant,
  workflowScriptServiceForTenant,
} from '../services/workflowScriptWiring.js';

const SCRIPT = [
  'export const meta = { name: "e2e-audit", description: "e2e", phases: ["p1"] };',
  'phase("p1");',
  'const found = await agent("list files", {',
  '  label: "lister",',
  "  schema: { type: 'object', properties: { files: { type: 'array', items: { type: 'string' } } }, required: ['files'] }",
  '});',
  'return { files: found.files };',
].join('\n');

const INVALID_SCRIPT = "import fs from 'node:fs';\nreturn {};";

interface Harness {
  events: ThreadEvent[];
  close(): Promise<void>;
  request(method: string, path: string, body?: unknown): Promise<{ status: number; body: unknown }>;
}

/**
 * 假 AgentLoop：runTurn 充当 workflow 子代理执行器；runHarness 模拟模型输出 ```workflow 提案，
 * 提案所需 taskId/goalRunId 一律取生产注入的 HarnessWorkflowOptions（不自行编造上下文）。
 */
function makeFakeAgent(counter: { proposals: number }) {
  const satisfied: HarnessResult = { status: 'satisfied' } as HarnessResult;
  const blocked: HarnessResult = { status: 'blocked' } as HarnessResult;
  const agent = {
    runTurn: async () => ({
      items: [{
        id: 'item_e2e_agent',
        type: 'agent_message',
        turnId: 'turn_e2e_agent',
        text: '{"files":["a.ts","b.ts"]}',
        // 带 schema 的子代理调用以 structuredOutput 作为结果（与生产提取链一致）。
        structuredOutput: { files: ['a.ts', 'b.ts'] },
        status: 'completed',
        timestamp: '2026-09-20T00:00:00.000Z',
      }],
      usage: { inputTokens: 30, outputTokens: 12 } as unknown as Usage,
    }),
    runHarness: async (
      _threadId: string,
      _input: unknown,
      options?: { workflow?: { taskId: string; goalRunId: string; onRequest(request: unknown): Promise<unknown> } },
    ) => {
      const workflow = options?.workflow;
      // 只在首次 GoalRun 提案；续跑后的第二个 GoalRun 直接收敛（否则会再堆一个待批准请求）。
      if (!workflow || counter.proposals > 0) return satisfied;
      counter.proposals += 1;
      await workflow.onRequest({
        taskId: workflow.taskId,
        goalRunId: workflow.goalRunId,
        objective: '批量审计仓库文件',
        proposedScript: SCRIPT,
        estimatedAgents: 1,
        estimatedTokens: 5000,
        limits: {
          maxConcurrentAgents: 2,
          maxAgentsPerRun: 4,
          maxItemsPerPipeline: 10,
          maxTotalTokens: 100_000,
          maxDurationMs: 60_000,
          requireApproval: true,
        },
      });
      return blocked;
    },
    resumeHarness: async () => satisfied,
    interrupt: () => true,
  };
  return agent;
}

async function startHarness(options: { propose: boolean }): Promise<Harness> {
  const { taskStore } = createStore(mkdtempSync(join(tmpdir(), 'suanlizi-p6-e2e-')));
  const store = taskStore as unknown as TaskStorePort;
  const tenantContext = { tenantId: `e2e-${Math.random().toString(36).slice(2, 10)}` };
  const events: ThreadEvent[] = [];
  const counter = { proposals: 0 };
  const agent = makeFakeAgent(counter);
  const fakeAgent = options.propose
    ? agent
    : { ...agent, runHarness: async () => ({ status: 'satisfied' }) };
  const deps = {
    taskStore: store,
    publishEvent: (event: ThreadEvent) => { events.push(event); },
    createTenantAgent: async () => ({ agent: fakeAgent as never }),
  };
  const service = workflowScriptServiceForTenant(tenantContext as never, deps);
  const integration = taskWorkflowIntegrationForTenant(tenantContext as never, deps);

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const segments = url.pathname.split('/').filter(Boolean);
    void (async () => {
      if (await handleWorkflowScriptRoute({ req, res, url, segments, service })) return;
      if (await handleTaskRoute({
        req,
        res,
        url,
        segments,
        taskStore: store,
        tenantContext: tenantContext as never,
        getAgent: async () => fakeAgent as never,
        publishEvent: (event: ThreadEvent) => { events.push(event); },
        workflow: integration,
        goalStatus: createTaskGoalStatusService({
          taskStore: store,
          // fake agent 不写 harnessState tags；只验证端点接线与只读语义。
          threadStore: { getThread: async () => null },
        }),
      })) return;
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'no route' } }));
    })().catch((error: unknown) => {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'E2E_INTERNAL', message: String(error) } }));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test server did not bind');
  const base = `http://127.0.0.1:${address.port}`;

  return {
    events,
    close: () => new Promise<void>((resolve) => { server.close(() => resolve()); }),
    request: async (method, path, body) => {
      const response = await fetch(`${base}${path}`, {
        method,
        ...(body === undefined
          ? {}
          : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
      });
      const text = await response.text();
      return { status: response.status, body: text ? JSON.parse(text) : undefined };
    },
  };
}

/** 让后台链（runtime.run → 证据物化 → 续跑）在真实计时器上跑完。 */
const settle = async (rounds = 20): Promise<void> => {
  for (let index = 0; index < rounds; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

const taskOf = (body: unknown): Task => (body as { task: Task }).task;
const runOf = (body: unknown): TaskRun | undefined => (body as { run?: TaskRun }).run;

describe('P6 Goal × Workflow 全链路 e2e（真实 HTTP + 真实 SQLite）', () => {
  let harness: Harness | undefined;

  afterEach(async () => {
    await harness?.close();
    harness = undefined;
  });

  it('提案 → 待批准请求 → 批准执行 → 证据物化 → GoalRun 续跑收敛', async () => {
    harness = await startHarness({ propose: true });

    // 1) 建任务（真实 POST /api/tasks）。
    const created = await harness.request('POST', '/api/tasks', {
      threadId: 'thread-e2e',
      objective: '批量审计仓库文件',
      acceptanceCriteria: ['产出审计结果证据'],
    });
    expect([200, 201]).toContain(created.status);
    const taskId = taskOf(created.body).id;

    // 2) 启动 GoalRun：harness 经生产注入的 workflow.onRequest 走真实提案链路。
    const start = await harness.request('POST', `/api/tasks/${taskId}/start`, {});
    expect([200, 202]).toContain(start.status);
    const goalRunId = runOf(start.body)?.id ?? '';
    expect(goalRunId).toBeTruthy();
    await settle();

    // 3) 待批准请求从真实库读回；Task blocked 且带 pendingInput。
    const requests = await harness.request('GET', `/api/tasks/${taskId}/workflows/requests`);
    expect(requests.status).toBe(200);
    const pending = (requests.body as { requests: Array<{ id: string; status: string; goalRunId?: string }> }).requests;
    expect(pending).toHaveLength(1);
    expect(pending[0]?.status).toBe('blocked');
    expect(pending[0]?.goalRunId).toBe(goalRunId);

    const blockedTask = await harness.request('GET', `/api/tasks/${taskId}`);
    expect(taskOf(blockedTask.body).status).toBe('blocked');
    expect(taskOf(blockedTask.body).pendingInput?.question).toContain('批量审计仓库文件');

    // 4) 批准 → 后台真实执行（fake executor）→ 证据物化落库。
    const workflowRunId = pending[0]?.id ?? '';
    const approved = await harness.request('POST', `/api/workflows/runs/${workflowRunId}/approve`);
    expect([200, 202]).toContain(approved.status);
    await settle(40);

    const result = await harness.request('GET', `/api/workflows/runs/${workflowRunId}/result`);
    const resultBody = result.body as {
      run: { status: string; evidenceId?: string; result?: unknown };
      agentCalls: Array<{ evidenceId?: string; status: string }>;
    };
    expect(resultBody.run.status).toBe('completed');
    expect(resultBody.run.evidenceId).toBe(`wev_${workflowRunId}_run`);
    expect(resultBody.run.result).toEqual({ files: ['a.ts', 'b.ts'] });
    expect(resultBody.agentCalls[0]?.evidenceId).toMatch(/^wev_/);

    // 5) 自动续跑：GoalRun 经 input 通道重新排队并起新 harness（第二次不再提案）→ 两个 Run 均落终态。
    // 注：按 §14.3 syncTaskFromRun，“Run completed” 保守不推导 Task 终态（验收属显式动作），
    // 所以 Task 停在 running；e2e 只断言不残留 pendingInput、不留下未完成 Run。
    await settle(40);
    const finalTask = taskOf((await harness.request('GET', `/api/tasks/${taskId}`)).body);
    const runs = (await harness.request('GET', `/api/tasks/${taskId}/runs`)).body as { runs: TaskRun[] };
    expect(finalTask.pendingInput ?? undefined).toBeUndefined();
    expect(finalTask.status).toBe('running');
    const goalRun = runs.runs.find((run) => run.kind === 'goal');
    expect(goalRun?.status).toBe('completed');
    expect(runs.runs.find((run) => run.kind === 'workflow')?.status).toBe('completed');

    // 6) 历史脚本端点从真实库读回刚跑过的脚本（P5）。
    const scripts = await harness.request('GET', `/api/tasks/${taskId}/workflows/scripts`);
    const scriptList = (scripts.body as { scripts: Array<{ script: string; status: string }> }).scripts;
    expect(scriptList).toHaveLength(1);
    expect(scriptList[0]?.script).toContain('e2e-audit');

    // 6b) Evidence 端点（计划 §13.1）：回指 run 级与调用级证据，并带 GoalRun 来源。
    const evidence = await harness.request('GET', `/api/workflows/runs/${workflowRunId}/evidence`);
    expect(evidence.status).toBe(200);
    const evidenceBody = evidence.body as { runId: string; evidenceIds: string[]; goalRunId?: string; runEvidenceId?: string };
    expect(evidenceBody.runId).toBe(workflowRunId);
    expect(evidenceBody.goalRunId).toBe(goalRunId);
    expect(evidenceBody.runEvidenceId).toBe(`wev_${workflowRunId}_run`);
    expect(evidenceBody.evidenceIds).toContain(`wev_${workflowRunId}_run`);
    expect(evidenceBody.evidenceIds.length).toBeGreaterThanOrEqual(2);

    // TaskCenter 摘要必须从真实 TaskRun / WorkflowRun / AgentCall 记录聚合运行与证据。
    const taskSummary = taskOf((await harness.request('GET', `/api/tasks/${taskId}`)).body);
    expect(taskSummary.runIds).toEqual(runs.runs.map((run) => run.id));
    for (const evidenceId of evidenceBody.evidenceIds) expect(taskSummary.evidenceIds).toContain(evidenceId);
    const taskList = await harness.request('GET', `/api/tasks?origin=explicit_goal`);
    const listedTask = (taskList.body as { tasks: Task[] }).tasks.find((task) => task.id === taskId);
    expect(listedTask?.runIds).toEqual(taskSummary.runIds);
    expect(listedTask?.evidenceIds).toEqual(taskSummary.evidenceIds);
    const taskEvidence = await harness.request('GET', `/api/tasks/${taskId}/evidence`);
    expect((taskEvidence.body as { evidenceIds: string[] }).evidenceIds).toEqual(taskSummary.evidenceIds);

    // 6d) goal-status（计划 §13.1）：返回当前 GoalRun 摘要；无 tags 评估时不得伪造。
    const goalStatus = await harness.request('GET', `/api/tasks/${taskId}/goal-status`);
    expect(goalStatus.status).toBe(200);
    const statusBody = goalStatus.body as { taskId: string; runId?: string; evaluation?: unknown; passedCriteria: string[] };
    expect(statusBody.taskId).toBe(taskId);
    expect(statusBody.runId).toBe(goalRunId);
    expect(statusBody.evaluation).toBeUndefined();
    expect(statusBody.passedCriteria).toEqual([]);

    // 7) 事件闭环：请求、批准、结果回填、证据、终态事件都经 publishEvent 发出。
    const types = harness.events.map((event) => event.type);
    expect(types).toContain('workflow.request.created');
    expect(types).toContain('workflow.request.approved');
    expect(types).toContain('workflow.result.created');
    expect(types).toContain('workflow.evidence.created');
    expect(types.filter((type) => type === 'workflow.run.terminal')).toHaveLength(1);
  });

  it('失败路径：非法脚本 400 WORKFLOW_SCRIPT_INVALID、未知 run 批准 404、未知路径不吞 404', async () => {
    harness = await startHarness({ propose: false });
    const created = await harness.request('POST', '/api/tasks', {
      threadId: 'thread-e2e-fail',
      objective: '失败路径',
      acceptanceCriteria: ['x'],
    });
    const taskId = taskOf(created.body).id;
    const start = await harness.request('POST', `/api/tasks/${taskId}/start`, {});
    const goalRunId = runOf(start.body)?.id ?? '';
    expect(goalRunId).toBeTruthy();
    await settle();
    const invalid = await harness.request('POST', `/api/tasks/${taskId}/workflows/requests`, {
      goalRunId,
      objective: 'oops',
      proposedScript: INVALID_SCRIPT,
      estimatedAgents: 1,
      estimatedTokens: 10,
    });
    expect(invalid.status).toBe(400);
    expect((invalid.body as { error: { code: string } }).error.code).toBe('WORKFLOW_SCRIPT_INVALID');

    const missingGoal = await harness.request('POST', `/api/tasks/${taskId}/workflows/requests`, {
      goalRunId: 'goalrun-does-not-exist',
      objective: 'oops',
      proposedScript: SCRIPT,
      estimatedAgents: 1,
      estimatedTokens: 10,
    });
    expect(missingGoal.status).toBe(404);
    expect((missingGoal.body as { error: { code: string } }).error.code).toBe('TASK_RUN_NOT_FOUND');

    const ghostApprove = await harness.request('POST', '/api/workflows/runs/wfrun_missing/approve');
    expect(ghostApprove.status).toBe(404);
    expect((ghostApprove.body as { error: { code: string } }).error.code).toBe('WORKFLOW_RUN_NOT_FOUND');

    const unknownPath = await harness.request('GET', '/api/nope');
    expect(unknownPath.status).toBe(404);
    expect((unknownPath.body as { error: { code: string } }).error.code).toBe('NOT_FOUND');

    // 非法脚本不得留下任何 workflow 记录。
    const requests = await harness.request('GET', `/api/tasks/${taskId}/workflows/requests`);
    expect((requests.body as { requests: unknown[] }).requests).toEqual([]);
  });
});
