// Workflow 脚本 service + route 测试（P4b）。
// 覆盖：静态校验视图、startRun 非法前置（task 不存在 / 脚本不合法）、
// 批准启动（TaskRun kind='workflow' 落库、后台执行不阻塞、终态落 RunRecord + TaskRun + 事件）、
// schema 校验失败可追踪、取消穿透、以及路由层 HTTP 语义（200/202/400/404/409、strict schema）。
//
// — Chinese: P4b workflow script service + route tests with a workflow-capable fake store.

import { PassThrough } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it } from 'vitest';
import {
  TaskError,
  type Task,
  type TaskRun,
  type ThreadEvent,
  type WorkflowAgentCall,
  type WorkflowRunListFilter,
  type WorkflowRunRecord,
} from '@suanlizi/protocol';
import { FakeTaskStore } from '../testing/fakeTaskStore.js';
import { createWorkflowScriptService, type WorkflowScriptService } from '../services/workflowScriptService.js';
import { handleWorkflowScriptRoute } from './workflowScriptRoute.js';

const CLOCK = new Date('2026-09-20T08:00:00.000Z');
const tick = () => CLOCK.getTime();

// ─── fake store ──────────────────────────────────────────────────────────────

class WorkflowFakeStore extends FakeTaskStore {
  workflowRuns = new Map<string, WorkflowRunRecord>();
  agentCallsByRun = new Map<string, WorkflowAgentCall[]>();

  override async upsertWorkflowRun(record: WorkflowRunRecord): Promise<WorkflowRunRecord> {
    this.workflowRuns.set(record.id, structuredClone(record));
    return structuredClone(record);
  }

  override async getWorkflowRun(id: string): Promise<WorkflowRunRecord | null> {
    const record = this.workflowRuns.get(id);
    if (!record) return null;
    // 与真实 SqliteTaskStore 一致：agentCalls 子表才是调用级真相，
    // 否则服务层写 run 级字段时碰不到的内联副本会被误当成空列表。
    const merged = structuredClone(record);
    merged.agentCalls = structuredClone(this.agentCallsByRun.get(id) ?? []);
    return merged;
  }

  override async recordAgentCall(runId: string, call: WorkflowAgentCall): Promise<WorkflowAgentCall> {
    const list = this.agentCallsByRun.get(runId) ?? [];
    list.push(structuredClone(call));
    this.agentCallsByRun.set(runId, list);
    return structuredClone(call);
  }

  override async updateAgentCall(runId: string, call: WorkflowAgentCall): Promise<WorkflowAgentCall> {
    const list = this.agentCallsByRun.get(runId) ?? [];
    const index = list.findIndex((existing) => existing.id === call.id);
    if (index >= 0) list[index] = structuredClone(call);
    else list.push(structuredClone(call));
    this.agentCallsByRun.set(runId, list);
    return structuredClone(call);
  }

  override async listAgentCalls(runId: string): Promise<WorkflowAgentCall[]> {
    return structuredClone(this.agentCallsByRun.get(runId) ?? []);
  }
}

const VALID_SCRIPT = [
  'export const meta = { name: "demo", description: "demo flow", phases: ["p1"] };',
  'phase("p1");',
  'const found = await agent("list files", { label: "lister" });',
  "log('collected');",
  'return { files: found.files, count: found.files.length };',
].join('\n');

const IMPORT_SCRIPT = "import fs from 'node:fs';\nreturn {};";

/** 与 VALID_SCRIPT 不同但同样合法的脚本（用于全局串行断言）。 */
const OTHER_SCRIPT = [
  'export const meta = { name: "other", description: "other flow", phases: ["p1"] };',
  'phase("p1");',
  "const found = await agent('count lines');",
  'return { total: found.total };',
].join('\n');

function seedTask(store: FakeTaskStore): Task {
  const task: Task = {
    id: 'task-wf-1',
    threadId: 'thread-wf-1',
    objective: 'run a workflow',
    acceptanceCriteria: ['done'],
    status: 'pending',
    runIds: [],
    evidenceIds: [],
    createdAt: '2026-09-20T00:00:00.000Z',
    updatedAt: '2026-09-20T00:00:00.000Z',
    version: 0,
    interactionMode: 'supervised',
    origin: 'explicit_goal',
  };
  void store.createTask(task);
  return task;
}

/** 受控 executor：手动 resolve / reject，并在 signal abort 时 reject（与真实 runTurn 取消链一致）。 */
function makeDeferredExecutor() {
  let resolveNext!: (value: { result: unknown; inputTokens: number; outputTokens: number }) => void;
  let rejectNext!: (error: unknown) => void;
  const pending = new Promise<{ result: unknown; inputTokens: number; outputTokens: number }>((resolve, reject) => {
    resolveNext = resolve;
    rejectNext = reject;
  });
  const calls: Array<{ prompt: string; callId: string; schema?: Record<string, unknown>; signal: AbortSignal }> = [];
  const executor = async (input: { prompt: string; callId: string; schema?: Record<string, unknown>; signal: AbortSignal }) => {
    calls.push({ prompt: input.prompt, callId: input.callId, ...(input.schema ? { schema: input.schema } : {}), signal: input.signal });
    input.signal.addEventListener(
      'abort',
      () => rejectNext(new Error(`aborted: ${input.callId}`)),
      { once: true },
    );
    return pending;
  };
  return { executor, calls, resolveNext, rejectNext };
}

interface ServiceHarness {
  store: WorkflowFakeStore;
  events: ThreadEvent[];
  service: WorkflowScriptService;
}

function makeService(executorOptions?: {
  executor?: ReturnType<typeof makeDeferredExecutor>['executor'];
  now?: () => number;
}): ServiceHarness {
  const store = new WorkflowFakeStore();
  seedTask(store);
  const events: ThreadEvent[] = [];
  const service = createWorkflowScriptService({
    taskStore: store,
    publishEvent: (event) => events.push(event),
    createExecutor: async () => executorOptions?.executor ?? (async () => ({ result: { files: ['a.ts'] }, inputTokens: 10, outputTokens: 5 })),
    ...(executorOptions?.now ? { now: executorOptions.now } : {}),
  });
  return { store, events, service };
}

const drain = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

// ─── service ─────────────────────────────────────────────────────────────────

describe('workflowScriptService.validate', () => {
  it('合法脚本返回 ok + meta；非法脚本返回诊断码', () => {
    const { service } = makeService();
    const ok = service.validate(VALID_SCRIPT);
    expect(ok.ok).toBe(true);
    expect(ok.meta?.name).toBe('demo');
    expect(ok.meta?.phases).toEqual(['p1']);
    // P5：成本度量随校验视图返回（大任务警告依据）。
    expect(ok.cost).toEqual({ agentCallSites: 1, agentsInsideLoop: false, fanOutSites: 0 });

    const bad = service.validate(IMPORT_SCRIPT);
    expect(bad.ok).toBe(false);
    expect(bad.diagnostics.some((d) => d.code === 'import_forbidden')).toBe(true);
    expect(bad.cost).toBeUndefined();
  });
});

describe('workflowScriptService.listScripts（P5 历史脚本）', () => {
  it('按 scriptHash 去重保留最新一次，新→旧排序；无 workflow 记录时为空', async () => {
    const { service } = makeService({ now: tick });
    expect(await service.listScripts('task-wf-1')).toEqual([]);

    const first = await service.startRun({ taskId: 'task-wf-1', script: VALID_SCRIPT });
    await drain();
    await drain();
    // 同脚本再跑一次（上一次已终态，不触发重复拒绝）→ 同 hash 只保留一条。
    const second = await service.startRun({ taskId: 'task-wf-1', script: VALID_SCRIPT });
    await drain();
    await drain();
    const edited = await service.startRun({ taskId: 'task-wf-1', script: VALID_SCRIPT.replace('list files', 'list all files') });
    await drain();
    await drain();

    const scripts = await service.listScripts('task-wf-1');
    expect(scripts).toHaveLength(2);
    expect(scripts.some((entry) => entry.runId === first.runId || entry.runId === second.runId)).toBe(true);
    const editedEntry = scripts.find((entry) => entry.runId === edited.runId);
    expect(editedEntry?.script).toContain('list all files');
    expect(editedEntry?.status).toBe('completed');
    expect(editedEntry?.usage.agentCallCount).toBe(1);
    // 去重后只剩两条不同脚本（hash 唯一），且本次编辑版在其中。
    expect(new Set(scripts.map((entry) => entry.scriptHash)).size).toBe(2);
    expect(scripts.some((entry) => entry.script.includes('list all files'))).toBe(true);
  });

  it('路由 GET /api/tasks/:taskId/workflows/scripts → 200 + 去重列表', async () => {
    const { service } = makeService({ now: tick });
    await service.startRun({ taskId: 'task-wf-1', script: VALID_SCRIPT });
    await drain();
    await drain();
    const res = response();
    const handled = await invoke(request('GET', '/api/tasks/task-wf-1/workflows/scripts'), res, service);
    expect(handled).toBe(true);
    expect(res.statusCode).toBe(200);
    const body = res.body as { taskId: string; scripts: Array<{ runId: string; scriptHash: string }> };
    expect(body.taskId).toBe('task-wf-1');
    expect(body.scripts).toHaveLength(1);
    expect(body.scripts[0]?.scriptHash).toHaveLength(64);
  });
});

describe('workflowScriptService.startRun', () => {
  it('task 不存在 → TASK_NOT_FOUND', async () => {
    const { service } = makeService();
    const error = await service.startRun({ taskId: 'missing', script: VALID_SCRIPT }).catch((e) => e);
    expect(error).toBeInstanceOf(TaskError);
    expect((error as TaskError).code).toBe('TASK_NOT_FOUND');
  });

  it('脚本不合法 → WORKFLOW_SCRIPT_INVALID 且不落 Run', async () => {
    const { store, service } = makeService();
    const error = await service.startRun({ taskId: 'task-wf-1', script: IMPORT_SCRIPT }).catch((e) => e);
    expect(error).toBeInstanceOf(TaskError);
    expect((error as TaskError).code).toBe('WORKFLOW_SCRIPT_INVALID');
    expect(store.workflowRuns.size).toBe(0);
  });

  it('批准启动：立即返回 runId、TaskRun kind=workflow 落库、运行中不阻塞、终态落 RunRecord + terminal 事件', async () => {
    const deferred = makeDeferredExecutor();
    const { store, events, service } = makeService({ executor: deferred.executor, now: tick });

    const started = await service.startRun({ taskId: 'task-wf-1', script: VALID_SCRIPT });
    expect(started.status).toBe('running');
    expect(started.runId).toBeTruthy();
    expect(started.taskRunId).toBeTruthy();

    // executor 仍挂起：run 处于 running，startRun 早已 resolve（不阻塞主会话）。
    const runningRecord = store.workflowRuns.get(started.runId);
    expect(runningRecord?.status).toBe('running');
    const taskRun = await store.getRun(started.taskRunId);
    expect(taskRun?.kind).toBe('workflow');
    expect(taskRun?.workflowKind).toBe('script');
    expect(taskRun?.workflowRunId).toBe(started.runId);

    // 放行 executor → 终态落库 + 事件闭环。
    deferred.resolveNext({ result: { files: ['a.ts', 'b.ts'] }, inputTokens: 12, outputTokens: 7 });
    await drain();
    await drain();

    const finalRecord = store.workflowRuns.get(started.runId);
    expect(finalRecord?.status).toBe('completed');
    expect(finalRecord?.usage.agentCallCount).toBe(1);
    expect(finalRecord?.usage.inputTokens).toBe(12);
    const calls = await store.listAgentCalls(started.runId);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.status).toBe('completed');
    expect((calls[0]?.result as { files: string[] }).files).toEqual(['a.ts', 'b.ts']);

    const settledRun = await store.getRun(started.taskRunId);
    expect(settledRun?.status).toBe('completed');

    const statuses = events
      .filter((event): event is Extract<ThreadEvent, { type: 'workflow.run.updated' }> => event.type === 'workflow.run.updated')
      .filter((event) => event.runId === started.runId)
      .map((event) => event.status);
    expect(statuses[0]).toBe('queued');
    expect(statuses).toContain('running');
    expect(events.some((event) => event.type === 'workflow.run.terminal' && (event as { runId: string }).runId === started.runId)).toBe(true);
  });

  it('schema 校验失败 → agent call failed + run failed + 事件可追踪', async () => {
    const { store, events, service } = makeService({
      executor: async () => ({ result: { wrong: true }, inputTokens: 3, outputTokens: 2 }),
      now: tick,
    });
    const script = [
      'export const meta = { name: "s", description: "s", phases: ["p1"] };',
      'return await agent("produce structured", {',
      '  schema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },',
      '});',
    ].join('\n');
    const started = await service.startRun({ taskId: 'task-wf-1', script });
    await drain();
    await drain();

    const finalRecord = store.workflowRuns.get(started.runId);
    expect(finalRecord?.status).toBe('failed');
    const calls = await store.listAgentCalls(started.runId);
    expect(calls[0]?.status).toBe('failed');
    expect(events.some((event) => event.type === 'workflow.run.terminal' && (event as { status: string }).status === 'failed')).toBe(true);
  });

  it('运行中 cancelRun 穿透取消 → run cancelled + terminal 事件；未知 runId 返回 false', async () => {
    const deferred = makeDeferredExecutor();
    const { store, events, service } = makeService({ executor: deferred.executor, now: tick });
    const started = await service.startRun({ taskId: 'task-wf-1', script: VALID_SCRIPT });

    // 让 runtime 进入 agent() 并持久化 running 状态后再取消。
    await drain();
    await expect(service.cancelRun('wfrun_unknown')).resolves.toBe(false);
    await expect(service.cancelRun(started.runId)).resolves.toBe(true);
    await drain();
    await drain();

    const finalRecord = store.workflowRuns.get(started.runId);
    expect(finalRecord?.status).toBe('cancelled');
    const calls = await store.listAgentCalls(started.runId);
    expect(calls[0]?.status).toBe('cancelled');
    expect(
      events.some(
        (event) =>
          event.type === 'workflow.run.terminal'
          && (event as { runId: string; status: string }).runId === started.runId
          && (event as { status: string }).status === 'cancelled',
      ),
    ).toBe(true);
  });
});

// ─── route ───────────────────────────────────────────────────────────────────

function request(method: string, path: string, body?: unknown): IncomingMessage {
  const stream = new PassThrough();
  const req = stream as unknown as IncomingMessage;
  req.method = method;
  req.url = path;
  req.headers = {};
  if (body === undefined) stream.end();
  else stream.end(typeof body === 'string' ? body : JSON.stringify(body));
  return req;
}

interface FakeResponse extends ServerResponse {
  statusCode: number;
  body?: unknown;
}

function response(): FakeResponse {
  const chunks: Buffer[] = [];
  const res = new PassThrough() as unknown as FakeResponse;
  res.statusCode = 200;
  res.writeHead = ((status: number) => {
    res.statusCode = status;
    return res;
  }) as never;
  res.end = ((chunk?: string | Buffer) => {
    if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    const raw = Buffer.concat(chunks).toString('utf8');
    (res as unknown as { body?: unknown }).body = raw ? JSON.parse(raw) : undefined;
    return res;
  }) as never;
  return res;
}

async function invoke(req: IncomingMessage, res: FakeResponse, service: WorkflowScriptService): Promise<boolean> {
  const url = new URL(`http://localhost${req.url ?? '/'}`);
  const segments = url.pathname.split('/').filter(Boolean);
  return handleWorkflowScriptRoute({ req, res, url, segments, service });
}

describe('workflowScriptRoute', () => {
  it('POST validate → 200 + 诊断视图；非法脚本 ok=false', async () => {
    const { service } = makeService();
    const res = response();
    await invoke(request('POST', '/api/tasks/task-wf-1/workflows/validate', { script: IMPORT_SCRIPT }), res, service);
    expect(res.statusCode).toBe(200);
    expect((res.body as { validation: { ok: boolean } }).validation.ok).toBe(false);
  });

  it('POST validate 只允许显式 Goal：shadow 返回 409，不存在 Goal 返回 404', async () => {
    const { store, service } = makeService();
    const shadow = store.tasks.get('task-wf-1');
    if (!shadow) throw new Error('seed task missing');
    store.tasks.set(shadow.id, { ...shadow, origin: 'harness_shadow' });

    const shadowResponse = response();
    await invoke(request('POST', '/api/tasks/task-wf-1/workflows/validate', { script: VALID_SCRIPT }), shadowResponse, service);
    expect(shadowResponse.statusCode).toBe(409);
    expect((shadowResponse.body as { error: { code: string } }).error.code).toBe('TASK_INVALID_TRANSITION');

    const missingResponse = response();
    await invoke(request('POST', '/api/tasks/task-missing/workflows/validate', { script: VALID_SCRIPT }), missingResponse, service);
    expect(missingResponse.statusCode).toBe(404);
    expect((missingResponse.body as { error: { code: string } }).error.code).toBe('TASK_NOT_FOUND');
  });

  it('POST runs → 202 + runId/taskRunId；strict schema 拒收多余字段', async () => {
    const { service } = makeService({ now: tick });
    const res = response();
    await invoke(request('POST', '/api/tasks/task-wf-1/workflows/runs', { script: VALID_SCRIPT, runId: 'hack' }), res, service);
    expect(res.statusCode).toBe(400);
    expect((res.body as { error: { code: string } }).error.code).toBe('WORKFLOW_REQUEST_INVALID');
  });

  it('GET result 未知 runId → 404 WORKFLOW_RUN_NOT_FOUND', async () => {
    const { service } = makeService();
    const res = response();
    await invoke(request('GET', '/api/workflows/runs/unknown/result'), res, service);
    expect(res.statusCode).toBe(404);
    expect((res.body as { error: { code: string } }).error.code).toBe('WORKFLOW_RUN_NOT_FOUND');
  });

  it('POST runs → 202 后 GET result 返回 run + agentCalls；cancel 运行中 202 / 未知 409', async () => {
    const deferred = makeDeferredExecutor();
    const { service } = makeService({ executor: deferred.executor, now: tick });

    const startRes = response();
    await invoke(request('POST', '/api/tasks/task-wf-1/workflows/runs', { script: VALID_SCRIPT }), startRes, service);
    expect(startRes.statusCode).toBe(202);
    const { runId, taskRunId } = startRes.body as { runId: string; taskRunId: string };
    expect(runId).toBeTruthy();
    expect(taskRunId).toBeTruthy();

    // 让 runtime 进入 agent() 后再取消，保证 agentCall 已创建且可追踪。
    await drain();
    const cancelRes = response();
    await invoke(request('POST', `/api/workflows/runs/${runId}/cancel`), cancelRes, service);
    expect(cancelRes.statusCode).toBe(202);
    await drain();
    await drain();

    const cancelAgain = response();
    await invoke(request('POST', `/api/workflows/runs/${runId}/cancel`), cancelAgain, service);
    expect(cancelAgain.statusCode).toBe(409);

    const resultRes = response();
    await invoke(request('GET', `/api/workflows/runs/${runId}/result`), resultRes, service);
    expect(resultRes.statusCode).toBe(200);
    const body = resultRes.body as { run: { status: string }; agentCalls: Array<{ status: string }> };
    expect(body.run.status).toBe('cancelled');
    expect(body.agentCalls[0]?.status).toBe('cancelled');
  });

  it('未知路径返回 false（不吞路由）', async () => {
    const { service } = makeService();
    const res = response();
    const handled = await invoke(request('GET', '/api/other'), res, service);
    expect(handled).toBe(false);
  });

  it('P6：GET result 暴露 evidenceId / result 与 AgentCall 证据引用', async () => {
    const { service } = makeService({ now: tick });
    const startRes = response();
    await invoke(request('POST', '/api/tasks/task-wf-1/workflows/runs', { script: VALID_SCRIPT }), startRes, service);
    const { runId } = startRes.body as { runId: string };
    await drain();
    await drain();
    await drain();

    const resultRes = response();
    await invoke(request('GET', `/api/workflows/runs/${runId}/result`), resultRes, service);
    expect(resultRes.statusCode).toBe(200);
    const body = resultRes.body as {
      run: { status: string; evidenceId?: string; result?: unknown; goalRunId?: string };
      agentCalls: Array<{ evidenceId?: string }>;
    };
    expect(body.run.status).toBe('completed');
    expect(body.run.evidenceId).toBe(`wev_${runId}_run`);
    expect(body.run.result).toEqual({ files: ['a.ts'], count: 1 });
    // 手动发起的 run 无 GoalRun 来源，不得伪造 goalRunId。
    expect(body.run.goalRunId).toBeUndefined();
    expect(body.agentCalls[0]?.evidenceId).toMatch(/^wev_/);
  });
});

// ─── P6：Goal × Workflow 组合 ───────────────────────────────────────────────

/** P6 fake store：listWorkflowRuns 按 goalRunId 过滤 + 可控的物化写失败。 */
class P6FakeStore extends WorkflowFakeStore {
  failEvidenceWrite = false;

  override async upsertWorkflowRun(record: WorkflowRunRecord): Promise<WorkflowRunRecord> {
    if (this.failEvidenceWrite && record.evidenceId) throw new Error('disk full');
    return super.upsertWorkflowRun(record);
  }

  override async listWorkflowRuns(filter?: WorkflowRunListFilter): Promise<WorkflowRunRecord[]> {
    const all = [...this.workflowRuns.values()];
    const matched = filter?.goalRunId ? all.filter((record) => record.goalRunId === filter.goalRunId) : all;
    return matched.map((record) => structuredClone(record));
  }
}

function seedGoalRun(store: FakeTaskStore, id = 'goalrun-1'): TaskRun {
  const run: TaskRun = {
    id,
    taskId: 'task-wf-1',
    threadId: 'thread-wf-1',
    kind: 'goal',
    status: 'running',
    startedAt: '2026-09-20T00:00:00.000Z',
    updatedAt: '2026-09-20T00:00:00.000Z',
    version: 0,
  };
  void store.createRun(run);
  return run;
}

interface P6Harness {
  store: P6FakeStore;
  events: ThreadEvent[];
  service: WorkflowScriptService;
  goalResumes: Array<{ taskId: string; goalRunId: string; workflowRunId: string }>;
}

function makeP6Service(executorOptions?: {
  executor?: ReturnType<typeof makeDeferredExecutor>['executor'];
  maxWorkflowRunsPerGoal?: number;
  failEvidenceWrite?: boolean;
  now?: () => number;
}): P6Harness {
  const store = new P6FakeStore();
  if (executorOptions?.failEvidenceWrite) store.failEvidenceWrite = true;
  seedTask(store);
  seedGoalRun(store);
  const events: ThreadEvent[] = [];
  const goalResumes: P6Harness['goalResumes'] = [];
  const service = createWorkflowScriptService({
    taskStore: store,
    publishEvent: (event) => events.push(event),
    createExecutor: async () => executorOptions?.executor ?? (async () => ({ result: { files: ['a.ts'] }, inputTokens: 10, outputTokens: 5 })),
    ...(executorOptions?.maxWorkflowRunsPerGoal ? { maxWorkflowRunsPerGoal: executorOptions.maxWorkflowRunsPerGoal } : {}),
    ...(executorOptions?.now ? { now: executorOptions.now } : {}),
    onGoalResume: async (ctx) => {
      goalResumes.push(ctx);
    },
  });
  return { store, events, service, goalResumes };
}

describe('workflowScriptService P6 Goal×Workflow', () => {
  it('拒绝 Harness shadow 经过任意 Dynamic Workflow 入口或按 runId 回读', async () => {
    const { store, service } = makeP6Service({ now: tick });
    // 先在显式 Goal 上制造一个待批准提案，再把存储中的来源模拟成历史 shadow，
    // 以覆盖 approve/reject/result/evidence/cancel 等只拿 runId 的入口。
    const proposed = await service.proposeRun({
      taskId: 'task-wf-1',
      goalRunId: 'goalrun-1',
      objective: 'collect files',
      proposedScript: VALID_SCRIPT,
    });
    const task = store.tasks.get('task-wf-1');
    if (!task) throw new Error('seed task missing');
    store.tasks.set(task.id, { ...task, origin: 'harness_shadow' });

    const expectGoalOnly = async (operation: Promise<unknown>) => {
      const error = await operation.catch((reason) => reason);
      expect(error).toBeInstanceOf(TaskError);
      expect((error as TaskError).code).toBe('TASK_INVALID_TRANSITION');
    };

    await expectGoalOnly(service.startRun({ taskId: task.id, script: VALID_SCRIPT }));
    await expectGoalOnly(service.proposeRun({
      taskId: task.id,
      goalRunId: 'goalrun-1',
      objective: 'retry through shadow',
      proposedScript: VALID_SCRIPT,
    }));
    await expectGoalOnly(service.listScripts(task.id));
    await expectGoalOnly(service.listRequests(task.id));
    await expectGoalOnly(service.approveRun(proposed.runId));
    await expectGoalOnly(service.rejectRun(proposed.runId));
    await expectGoalOnly(service.getResult(proposed.runId));
    await expectGoalOnly(service.getEvidence(proposed.runId));
    await expectGoalOnly(service.cancelRun(proposed.runId));

    expect((await store.getRun(proposed.taskRunId))?.status).toBe('blocked');
    expect(store.workflowRuns.get(proposed.runId)?.status).toBe('blocked');
  });

  it('proposeRun：校验 + 预算通过 → blocked RunRecord/TaskRun 落库 + request.created 事件', async () => {
    const { store, events, service } = makeP6Service({ now: tick });
    const proposed = await service.proposeRun({
      taskId: 'task-wf-1',
      goalRunId: 'goalrun-1',
      objective: 'collect files',
      proposedScript: VALID_SCRIPT,
      estimatedAgents: 1,
      estimatedTokens: 100,
    });
    expect(proposed.status).toBe('blocked');
    const record = store.workflowRuns.get(proposed.runId);
    expect(record?.status).toBe('blocked');
    expect(record?.goalRunId).toBe('goalrun-1');
    const taskRun = await store.getRun(proposed.taskRunId);
    expect(taskRun?.kind).toBe('workflow');
    expect(taskRun?.status).toBe('blocked');
    expect(
      events.some(
        (event) =>
          event.type === 'workflow.request.created'
          && (event as { runId: string }).runId === proposed.runId
          && (event as { goalRunId: string }).goalRunId === 'goalrun-1',
      ),
    ).toBe(true);
  });

  it('proposeRun 前置拒绝：非法脚本 → WORKFLOW_SCRIPT_INVALID；goal run 不存在 → TASK_RUN_NOT_FOUND', async () => {
    const { store, service } = makeP6Service();
    const bad = await service
      .proposeRun({ taskId: 'task-wf-1', goalRunId: 'goalrun-1', objective: 'x', proposedScript: IMPORT_SCRIPT })
      .catch((e) => e);
    expect((bad as TaskError).code).toBe('WORKFLOW_SCRIPT_INVALID');
    const missing = await service
      .proposeRun({ taskId: 'task-wf-1', goalRunId: 'goalrun-missing', objective: 'x', proposedScript: VALID_SCRIPT })
      .catch((e) => e);
    expect((missing as TaskError).code).toBe('TASK_RUN_NOT_FOUND');
    expect(store.workflowRuns.size).toBe(0);
  });

  it('预算：maxWorkflowRunsPerGoal=1 时第二次提案 → WORKFLOW_LIMIT_EXCEEDED', async () => {
    const { service } = makeP6Service({ maxWorkflowRunsPerGoal: 1 });
    await service.proposeRun({ taskId: 'task-wf-1', goalRunId: 'goalrun-1', objective: 'a', proposedScript: VALID_SCRIPT });
    const error = await service
      .proposeRun({ taskId: 'task-wf-1', goalRunId: 'goalrun-1', objective: 'b', proposedScript: VALID_SCRIPT })
      .catch((e) => e);
    expect(error).toBeInstanceOf(TaskError);
    expect((error as TaskError).code).toBe('WORKFLOW_LIMIT_EXCEEDED');
  });

  it('rejectRun：blocked → cancelled 双写 + rejected 事件；重复拒绝 → TASK_INVALID_TRANSITION', async () => {
    const { store, events, service } = makeP6Service({ now: tick });
    const proposed = await service.proposeRun({
      taskId: 'task-wf-1',
      goalRunId: 'goalrun-1',
      objective: 'collect files',
      proposedScript: VALID_SCRIPT,
    });
    const decided = await service.rejectRun(proposed.runId, 'not needed');
    expect(decided.status).toBe('rejected');
    expect(store.workflowRuns.get(proposed.runId)?.status).toBe('cancelled');
    expect((await store.getRun(proposed.taskRunId))?.status).toBe('cancelled');
    expect(
      events.some(
        (event) =>
          event.type === 'workflow.request.rejected'
          && (event as { runId: string }).runId === proposed.runId
          && (event as { reason?: string }).reason === 'not needed',
      ),
    ).toBe(true);
    const again = await service.rejectRun(proposed.runId).catch((e) => e);
    expect((again as TaskError).code).toBe('TASK_INVALID_TRANSITION');
  });

  it('listRequests 只返回 blocked 请求；批准/拒绝后不再出现', async () => {
    const { service } = makeP6Service();
    expect(await service.listRequests('task-wf-1')).toHaveLength(0);
    const first = await service.proposeRun({ taskId: 'task-wf-1', goalRunId: 'goalrun-1', objective: 'a', proposedScript: VALID_SCRIPT });
    const second = await service.proposeRun({ taskId: 'task-wf-1', goalRunId: 'goalrun-1', objective: 'b', proposedScript: VALID_SCRIPT });
    const pending = await service.listRequests('task-wf-1');
    expect(pending.map((record) => record.id).sort()).toEqual([first.runId, second.runId].sort());
    await service.rejectRun(first.runId);
    expect((await service.listRequests('task-wf-1')).map((record) => record.id)).toEqual([second.runId]);
  });

  it('approveRun：blocked → queued → 执行完成 → 证据物化 + 续跑钩子', async () => {
    const deferred = makeDeferredExecutor();
    const { store, events, service, goalResumes } = makeP6Service({ executor: deferred.executor, now: tick });
    const proposed = await service.proposeRun({
      taskId: 'task-wf-1',
      goalRunId: 'goalrun-1',
      objective: 'collect files',
      proposedScript: VALID_SCRIPT,
    });
    const decided = await service.approveRun(proposed.runId);
    expect(decided.status).toBe('approved');
    // 放行 executor → 终态 + 证据物化。
    deferred.resolveNext({ result: { files: ['a.ts', 'b.ts'] }, inputTokens: 12, outputTokens: 7 });
    await drain();
    await drain();
    await drain();

    const record = store.workflowRuns.get(proposed.runId);
    expect(record?.status).toBe('completed');
    expect(record?.evidenceId).toBe(`wev_${proposed.runId}_run`);
    expect(record?.result).toEqual({ files: ['a.ts', 'b.ts'], count: 2 });
    const calls = await store.listAgentCalls(proposed.runId);
    expect(calls[0]?.evidenceId).toBe(`wev_${proposed.runId}_${calls[0]?.id}`);
    expect((await store.getRun(proposed.taskRunId))?.status).toBe('completed');
    expect(
      events.some(
        (event) =>
          event.type === 'workflow.evidence.created'
          && (event as { runId: string }).runId === proposed.runId,
      ),
    ).toBe(true);
    // §13.1：结果回填必须产生 workflow.result.created（调用级 + run 级），且先于 evidence 事件。
    const resultEvents = events.filter((event) => event.type === 'workflow.result.created') as Array<{
      runId: string; agentCallId?: string; resultHash: string; size: number; type: string;
    }>;
    expect(resultEvents.length).toBeGreaterThanOrEqual(2);
    expect(resultEvents.some((event) => event.agentCallId === calls[0]?.id)).toBe(true);
    expect(resultEvents.some((event) => !event.agentCallId && event.runId === proposed.runId)).toBe(true);
    expect(resultEvents[0]?.resultHash).toMatch(/^[0-9a-f]{16}$/);
    expect(resultEvents[0]?.size).toBeGreaterThan(0);
    expect(events.findIndex((event) => event.type === 'workflow.result.created'))
      .toBeLessThan(events.findIndex((event) => event.type === 'workflow.evidence.created'));
    expect(goalResumes).toEqual([
      { taskId: 'task-wf-1', goalRunId: 'goalrun-1', workflowRunId: proposed.runId },
    ]);

    // P6：Evidence 视图同时包含调用级与 run 级引用，并回指 GoalRun 来源。
    const evidence = await service.getEvidence(proposed.runId);
    expect(evidence?.goalRunId).toBe('goalrun-1');
    expect(evidence?.runEvidenceId).toBe(`wev_${proposed.runId}_run`);
    expect(evidence?.evidenceIds).toContain(`wev_${proposed.runId}_run`);
    expect(evidence?.evidenceIds.length).toBeGreaterThanOrEqual(2);
    expect((await service.getEvidence('wfrun_missing'))).toBeNull();

    const evidenceRes = response();
    await invoke(request('GET', `/api/workflows/runs/${proposed.runId}/evidence`), evidenceRes, service);
    expect(evidenceRes.statusCode).toBe(200);
    expect((evidenceRes.body as { evidenceIds: string[] }).evidenceIds.length).toBeGreaterThanOrEqual(2);

    const evidenceMissing = response();
    await invoke(request('GET', '/api/workflows/runs/wfrun_missing/evidence'), evidenceMissing, service);
    expect(evidenceMissing.statusCode).toBe(404);
    expect((evidenceMissing.body as { error: { code: string } }).error.code).toBe('WORKFLOW_RUN_NOT_FOUND');
  });

  it('证据物化失败 → run/TaskRun fail-fast 落 failed，不触发续跑钩子', async () => {
    const deferred = makeDeferredExecutor();
    const { store, events, service, goalResumes } = makeP6Service({
      executor: deferred.executor,
      now: tick,
      failEvidenceWrite: true,
    });
    const proposed = await service.proposeRun({
      taskId: 'task-wf-1',
      goalRunId: 'goalrun-1',
      objective: 'collect files',
      proposedScript: VALID_SCRIPT,
    });
    await service.approveRun(proposed.runId);
    deferred.resolveNext({ result: { files: ['a.ts'] }, inputTokens: 3, outputTokens: 2 });
    await drain();
    await drain();
    await drain();

    const record = store.workflowRuns.get(proposed.runId);
    expect(record?.status).toBe('failed');
    expect(record?.evidenceId).toBeUndefined();
    expect((await store.getRun(proposed.taskRunId))?.status).toBe('failed');
    expect(
      events.some(
        (event) =>
          event.type === 'workflow.run.terminal'
          && (event as { runId: string; status: string }).runId === proposed.runId
          && (event as { status: string }).status === 'failed',
      ),
    ).toBe(true);
    expect(goalResumes).toEqual([]);
  });
});

// ─── P5 恢复与复用 ───────────────────────────────────────────────────────────

describe('workflowScriptService P5 恢复与复用', () => {
  it('同脚本运行中重复启动 → TASK_ACTIVE_EXISTS', async () => {
    const deferred = makeDeferredExecutor();
    const { service } = makeService({ executor: deferred.executor, now: tick });
    await service.startRun({ taskId: 'task-wf-1', script: VALID_SCRIPT });
    const error = await service.startRun({ taskId: 'task-wf-1', script: VALID_SCRIPT }).catch((e) => e);
    expect(error).toBeInstanceOf(TaskError);
    expect((error as TaskError).code).toBe('TASK_ACTIVE_EXISTS');
    deferred.resolveNext({ result: { files: [] }, inputTokens: 1, outputTokens: 1 });
    await drain();
  });

  it('§14.10 编辑后批准：非法编辑被静态校验拒绝且请求保持 blocked；合法编辑则连同新 scriptHash 固化', async () => {
    const { store, service } = makeService({ now: tick });
    seedGoalRun(store, 'goalrun_edit');
    const proposed = await service.proposeRun({
      taskId: 'task-wf-1',
      goalRunId: 'goalrun_edit',
      objective: 'edit then approve',
      proposedScript: VALID_SCRIPT,
    });
    const originalHash = store.workflowRuns.get(proposed.runId)!.scriptHash;

    // 非法编辑（import）：必须拒绝，且不得迁移任何状态。
    const invalid = await service.approveRun(proposed.runId, { script: IMPORT_SCRIPT }).catch((e) => e);
    expect(invalid).toBeInstanceOf(TaskError);
    expect((invalid as TaskError).code).toBe('WORKFLOW_SCRIPT_INVALID');
    expect(store.workflowRuns.get(proposed.runId)?.status).toBe('blocked');
    expect((await store.getRun(proposed.taskRunId))?.status).toBe('blocked');
    expect(store.workflowRuns.get(proposed.runId)?.scriptHash).toBe(originalHash);

    // 合法编辑：批准后内容与 hash 固化为新值。
    const edited = OTHER_SCRIPT;
    const decided = await service.approveRun(proposed.runId, { script: edited });
    expect(decided.status).toBe('approved');
    expect(decided.scriptEdited).toBe(true);
    expect(decided.scriptHash).not.toBe(originalHash);
    expect(decided.scriptHash).toHaveLength(64);
    await drain();
    await drain();
    const record = store.workflowRuns.get(proposed.runId)!;
    expect(record.script).toBe(edited);
    expect(record.scriptHash).toBe(decided.scriptHash);
    expect(record.status).toBe('completed');
    // 实际跑的是编辑后的脚本：count lines 提示词出现在调用记录里。
    const calls = await store.listAgentCalls(proposed.runId);
    expect(calls[0]?.prompt).toBe('count lines');
  });

  it('§14.11 全局串行：不同脚本也不能并发；前一个终态后可再启动', async () => {
    const deferred = makeDeferredExecutor();
    const { store, service } = makeService({ executor: deferred.executor, now: tick });
    const first = await service.startRun({ taskId: 'task-wf-1', script: VALID_SCRIPT });

    const blocked = await service.startRun({ taskId: 'task-wf-1', script: OTHER_SCRIPT }).catch((e) => e);
    expect(blocked).toBeInstanceOf(TaskError);
    expect((blocked as TaskError).code).toBe('TASK_ACTIVE_EXISTS');
    expect((blocked as TaskError).details).toMatchObject({ activeRuns: 1 });
    // 被拒的启动不得留下任何记录。
    expect(store.workflowRuns.size).toBe(1);
    expect(await service.listRequests('task-wf-1')).toEqual([]);

    // 前一个 run 终态后同一脚本可正常启动。
    deferred.resolveNext({ result: { total: 7 }, inputTokens: 2, outputTokens: 1 });
    await drain();
    await drain();
    const second = await service.startRun({ taskId: 'task-wf-1', script: OTHER_SCRIPT });
    expect(second.runId).toBeTruthy();
    expect(second.runId).not.toBe(first.runId);
    await drain();
    await drain();
    expect(store.workflowRuns.get(second.runId)?.status).toBe('completed');
  });

  it('§14.11 已有运行中 run 时批准请求：报错且请求保持 blocked（不造 queued 半状态）', async () => {
    const deferred = makeDeferredExecutor();
    const { store, service } = makeService({ executor: deferred.executor, now: tick });
    seedGoalRun(store, 'goalrun_serial');
    await service.startRun({ taskId: 'task-wf-1', script: VALID_SCRIPT });

    const proposed = await service.proposeRun({
      taskId: 'task-wf-1',
      goalRunId: 'goalrun_serial',
      objective: 'sequential approve',
      proposedScript: OTHER_SCRIPT,
    });
    const error = await service.approveRun(proposed.runId).catch((e) => e);
    expect((error as TaskError).code).toBe('TASK_ACTIVE_EXISTS');
    expect(store.workflowRuns.get(proposed.runId)?.status).toBe('blocked');
    expect((await store.getRun(proposed.taskRunId))?.status).toBe('blocked');

    deferred.resolveNext({ result: { files: [] }, inputTokens: 1, outputTokens: 1 });
    await drain();
    await drain();
    // 前一个结束后，同一个请求可以正常批准。
    const approved = await service.approveRun(proposed.runId);
    expect(approved.status).toBe('approved');
    await drain();
    await drain();
    expect(store.workflowRuns.get(proposed.runId)?.status).toBe('completed');
  });

  it('resumeFromRunId 只能复用同一显式 Goal，拒绝其他 Goal 与 Harness shadow 的历史 run', async () => {
    const { store, service } = makeService({ now: tick });

    for (const origin of ['explicit_goal', 'harness_shadow'] as const) {
      const suffix = origin === 'explicit_goal' ? 'other-goal' : 'shadow';
      const taskId = `task-wf-${suffix}`;
      const taskRunId = `taskrun-${suffix}`;
      const workflowRunId = `wfrun-${suffix}`;
      await store.createTask({
        id: taskId,
        threadId: `thread-wf-${suffix}`,
        objective: `foreign ${origin}`,
        acceptanceCriteria: [],
        status: 'pending',
        runIds: [taskRunId],
        evidenceIds: [],
        createdAt: '2026-09-20T00:00:00.000Z',
        updatedAt: '2026-09-20T00:00:00.000Z',
        version: 0,
        interactionMode: 'supervised',
        origin,
      });
      await store.createRun({
        id: taskRunId,
        taskId,
        threadId: `thread-wf-${suffix}`,
        kind: 'workflow',
        workflowKind: 'script',
        workflowRunId,
        status: 'completed',
        startedAt: '2026-09-20T00:00:00.000Z',
        updatedAt: '2026-09-20T00:00:00.000Z',
        completedAt: '2026-09-20T00:01:00.000Z',
        version: 0,
      });
      await store.upsertWorkflowRun({
        id: workflowRunId,
        taskRunId,
        script: VALID_SCRIPT,
        scriptHash: `foreign-${suffix}`,
        status: 'completed',
        agentCalls: [],
        usage: { inputTokens: 0, outputTokens: 0, agentCallCount: 0, durationMs: 0 },
        startedAt: '2026-09-20T00:00:00.000Z',
        updatedAt: '2026-09-20T00:01:00.000Z',
        completedAt: '2026-09-20T00:01:00.000Z',
      });

      const error = await service.startRun({
        taskId: 'task-wf-1',
        script: VALID_SCRIPT,
        resumeFromRunId: workflowRunId,
      }).catch((reason) => reason);
      expect(error).toBeInstanceOf(TaskError);
      expect((error as TaskError).code).toBe('TASK_INVALID_TRANSITION');
      expect((error as TaskError).details).toMatchObject({
        taskId: 'task-wf-1',
        workflowRunId,
        priorTaskId: taskId,
      });
    }
    // 两次拒绝均发生在创建新 TaskRun / WorkflowRun 前。
    expect(store.workflowRuns.size).toBe(2);
  });

  it('resumeFromRunId 不存在 → WORKFLOW_RUN_NOT_FOUND', async () => {
    const { service } = makeService({ now: tick });
    const error = await service.startRun({ taskId: 'task-wf-1', script: VALID_SCRIPT, resumeFromRunId: 'wfrun_missing' }).catch((e) => e);
    expect(error).toBeInstanceOf(TaskError);
    expect((error as TaskError).code).toBe('WORKFLOW_RUN_NOT_FOUND');
  });

  it('恢复运行：已完成且未受影响的 AgentCall 直接复用（不调 executor、不增 token），脚本变化的重跑', async () => {
    let calls = 0;
    const { store, service } = makeService({
      executor: async () => {
        calls += 1;
        return { result: { files: [`f${calls}`] }, inputTokens: 10, outputTokens: 5 };
      },
      now: tick,
    });

    // 第一次运行：agent 调用真实执行。
    const first = await service.startRun({ taskId: 'task-wf-1', script: VALID_SCRIPT });
    await drain();
    await drain();
    expect(calls).toBe(1);
    const priorCalls = await store.listAgentCalls(first.runId);
    expect(priorCalls[0]?.result).toEqual({ files: ['f1'] });

    // 同脚本恢复：稳定 agentCallId 命中 → 直接复用，不调 executor。
    const resumed = await service.startRun({ taskId: 'task-wf-1', script: VALID_SCRIPT, resumeFromRunId: first.runId });
    await drain();
    await drain();
    expect(calls).toBe(1);
    const resumedCalls = await store.listAgentCalls(resumed.runId);
    expect(resumedCalls[0]?.result).toEqual({ files: ['f1'] });
    const resumedRecord = store.workflowRuns.get(resumed.runId);
    expect(resumedRecord?.usage.agentCallCount).toBe(0);
    expect(resumedRecord?.usage.inputTokens).toBe(0);

    // 脚本变化（prompt 不同）→ 不复用，重跑。
    const edited = VALID_SCRIPT.replace('list files', 'list all files');
    const rerun = await service.startRun({ taskId: 'task-wf-1', script: edited, resumeFromRunId: first.runId });
    await drain();
    await drain();
    expect(calls).toBe(2);
    const rerunRecord = store.workflowRuns.get(rerun.runId);
    expect(rerunRecord?.usage.inputTokens).toBe(10);
  });
});
