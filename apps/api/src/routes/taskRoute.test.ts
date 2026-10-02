// taskRoute P0 单元测试：直调 handler，不启动 HTTP 服务，不依赖真实 SQLite。
// 存储侧使用 Map 版内存 TaskStorePort（含 version 冲突与状态迁移校验的简化版）。
// — Chinese: direct handler tests against an in-memory TaskStorePort (no HTTP server, no SQLite).

import { PassThrough } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  TaskError,
  canTransitionTaskStatus,
  taskSchema,
  type Task,
  type TaskListFilter,
  type TaskRun,
  type TaskStorePort,
  type WorkflowAgentCall,
  type WorkflowRunRecord,
} from '@suanlizi/protocol';
import { handleTaskRoute, type TaskRouteErrorBody, type TaskRouteOptions } from './taskRoute.js';
import type { TenantContext } from '../shared/tenant.js';
import type {
  TaskHarnessRegistry,
  TaskHarnessRunHandle,
  TaskLifecycleAgent,
} from '../services/taskLifecycleService.js';
import type { HarnessResult } from '@suanlizi/runtime';
import type { ThreadEvent } from '@suanlizi/protocol';

// ─── 内存 fake TaskStorePort ────────────────────────────────────────────────

class FakeTaskStore implements TaskStorePort {
  tasks = new Map<string, Task>();
  runs = new Map<string, TaskRun>();
  workflowRuns = new Map<string, WorkflowRunRecord>();
  agentCalls = new Map<string, WorkflowAgentCall[]>();

  /** 用于验证「存储层才是最终裁决者」：置为 true 时 updateTask 无条件抛出版本冲突。 */
  forceVersionConflict = false;

  async createTask(task: Task): Promise<Task> {
    const parsed = taskSchema.parse(task);
    this.tasks.set(parsed.id, parsed);
    return parsed;
  }

  async getTask(id: string): Promise<Task | null> {
    return this.tasks.get(id) ?? null;
  }

  async updateTask(
    id: string,
    patch: Partial<Omit<Task, 'id' | 'createdAt'>>,
    expectedVersion: number,
  ): Promise<Task> {
    const current = this.tasks.get(id);
    if (!current) throw new TaskError('TASK_NOT_FOUND', `Task ${id} was not found`, { taskId: id });
    if (this.forceVersionConflict || current.version !== expectedVersion) {
      throw new TaskError('TASK_VERSION_CONFLICT', `Task ${id} version conflict`, {
        taskId: id,
        expectedVersion,
        actualVersion: current.version,
      });
    }
    if (patch.status && patch.status !== current.status && !canTransitionTaskStatus(current.status, patch.status)) {
      throw new TaskError('TASK_INVALID_TRANSITION', `Task ${id} cannot transition to ${patch.status}`, {
        taskId: id,
        to: patch.status,
      });
    }
    const next = taskSchema.parse({ ...current, ...patch, version: current.version + 1 });
    this.tasks.set(id, next);
    return next;
  }

  async listTasks(filter?: TaskListFilter): Promise<Task[]> {
    return [...this.tasks.values()].filter((task) => {
      if (filter?.threadId && task.threadId !== filter.threadId) return false;
      if (filter?.status?.length && !filter.status.includes(task.status)) return false;
      const origin = task.origin === 'explicit_goal' || task.origin === 'explicit_workflow'
        ? task.origin
        : 'harness_shadow';
      if (filter?.origin?.length && !filter.origin.includes(origin)) return false;
      return true;
    });
  }

  async createRun(run: TaskRun): Promise<TaskRun> {
    this.runs.set(run.id, run);
    return run;
  }

  async getRun(id: string): Promise<TaskRun | null> {
    return this.runs.get(id) ?? null;
  }

  async updateRun(
    id: string,
    patch: Partial<Omit<TaskRun, 'id' | 'taskId'>>,
    expectedVersion: number,
  ): Promise<TaskRun> {
    const current = this.runs.get(id);
    if (!current) throw new TaskError('TASK_RUN_NOT_FOUND', `Task run ${id} was not found`, { runId: id });
    if (current.version !== expectedVersion) {
      throw new TaskError('TASK_VERSION_CONFLICT', `Task run ${id} version conflict`, {
        runId: id,
        expectedVersion,
        actualVersion: current.version,
      });
    }
    const next = { ...current, ...patch, version: current.version + 1 };
    this.runs.set(id, next);
    return next;
  }

  async listRuns(taskId: string): Promise<TaskRun[]> {
    return [...this.runs.values()].filter((run) => run.taskId === taskId);
  }

  async upsertWorkflowRun(record: WorkflowRunRecord): Promise<WorkflowRunRecord> {
    this.workflowRuns.set(record.id, record);
    return record;
  }

  async getWorkflowRun(id: string): Promise<WorkflowRunRecord | null> {
    return this.workflowRuns.get(id) ?? null;
  }

  async listWorkflowRuns(filter?: { goalRunId?: string }): Promise<WorkflowRunRecord[]> {
    const all = [...this.workflowRuns.values()];
    return filter?.goalRunId ? all.filter((run) => run.goalRunId === filter.goalRunId) : all;
  }

  async recordAgentCall(runId: string, call: WorkflowAgentCall): Promise<WorkflowAgentCall> {
    this.agentCalls.set(runId, [...(this.agentCalls.get(runId) ?? []), call]);
    return call;
  }

  async updateAgentCall(runId: string, call: WorkflowAgentCall): Promise<WorkflowAgentCall> {
    const calls = this.agentCalls.get(runId) ?? [];
    this.agentCalls.set(runId, calls.map((item) => (item.id === call.id ? call : item)));
    return call;
  }

  async listAgentCalls(runId: string): Promise<WorkflowAgentCall[]> {
    return this.agentCalls.get(runId) ?? [];
  }

  async recoverInterruptedRuns(): Promise<TaskRun[]> {
    return [];
  }
}

// ─── 请求/响应替件 ───────────────────────────────────────────────────────────

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

const tenantContext: TenantContext = { tenantId: 'task-test' };
const CLOCK = new Date('2026-09-19T08:00:00.000Z');

let idSeq = 0;

type LifecycleWiring = Pick<TaskRouteOptions, 'getAgent' | 'publishEvent' | 'registry' | 'goalStatus'>;

/** 可控的 fake agent + registry + 事件收集器，用于生命周期端点的接线测试。 */
function makeLifecycleHarness() {
  const calls = { runHarness: 0, resumeHarness: 0, interrupt: 0 };
  const agent: TaskLifecycleAgent = {
    runHarness: () => {
      calls.runHarness += 1;
      return new Promise<HarnessResult>(() => undefined);
    },
    resumeHarness: () => {
      calls.resumeHarness += 1;
      return new Promise<HarnessResult>(() => undefined);
    },
    interrupt: () => {
      calls.interrupt += 1;
      return true;
    },
  };
  const entries = new Map<string, TaskHarnessRunHandle>();
  let lastHandle: TaskHarnessRunHandle | undefined;
  const registry: TaskHarnessRegistry = {
    start: (params) => {
      const handle: TaskHarnessRunHandle = {
        harnessRunId: params.harnessRunId,
        threadId: params.threadId,
        runtimeStatus: 'running',
        promise: new Promise<unknown>(() => undefined),
      };
      entries.set(params.harnessRunId, handle);
      lastHandle = handle;
      void Promise.resolve(params.run(new AbortController().signal)).catch(() => undefined);
      return handle;
    },
    cancel: (runId) => {
      const handle = entries.get(runId);
      if (!handle) return false;
      handle.runtimeStatus = 'cancelled';
      if (lastHandle === handle) lastHandle = undefined;
      return true;
    },
    get: (runId) => entries.get(runId),
    activeRunForThread: () => lastHandle,
  };
  const events: ThreadEvent[] = [];
  const wiring: LifecycleWiring = {
    getAgent: async () => agent,
    publishEvent: (event) => {
      events.push(event);
    },
    registry,
  };
  return { wiring, calls, events };
}

async function invoke(
  store: TaskStorePort,
  method: string,
  path: string,
  body?: unknown,
  lifecycle?: LifecycleWiring,
): Promise<FakeResponse> {
  const url = new URL(`http://localhost${path}`);
  const res = response();
  const options: TaskRouteOptions = {
    req: request(method, path, body),
    res,
    url,
    segments: url.pathname.split('/').filter(Boolean),
    taskStore: store,
    tenantContext,
    now: () => CLOCK,
    idFactory: () => `task_test_${(idSeq += 1)}`,
    ...lifecycle,
  };
  const handled = await handleTaskRoute(options);
  expect(handled, `route should handle ${method} ${path}`).toBe(true);
  return res;
}

function errorOf(res: FakeResponse): TaskRouteErrorBody['error'] {
  return (res.body as TaskRouteErrorBody | undefined)?.error as TaskRouteErrorBody['error'];
}

function taskOf(res: FakeResponse): Task {
  return (res.body as { task: Task }).task;
}

function makeTask(overrides: Partial<Task> & { id: string; threadId: string }): Task {
  return taskSchema.parse({
    objective: 'seed objective',
    acceptanceCriteria: ['seed criterion'],
    status: 'pending',
    runIds: [],
    evidenceIds: [],
    createdAt: '2026-09-19T00:00:00.000Z',
    updatedAt: '2026-09-19T00:00:00.000Z',
    version: 0,
    ...overrides,
  });
}

function makeRun(overrides: Partial<TaskRun> & { id: string; taskId: string }): TaskRun {
  return {
    threadId: 'thread-1',
    kind: 'goal',
    status: 'queued',
    updatedAt: '2026-09-19T00:00:00.000Z',
    version: 0,
    ...overrides,
  };
}

const createBody = {
  threadId: 'thread-1',
  objective: 'ship goal tasks',
  acceptanceCriteria: ['api tests pass'],
};

beforeEach(() => {
  idSeq = 0;
});

// ─── 用例 ───────────────────────────────────────────────────────────────────

describe('taskRoute P0', () => {
  it('leaves non-task paths to other routes', async () => {
    const url = new URL('http://localhost/api/threads/thread-1');
    const handled = await handleTaskRoute({
      req: request('GET', '/api/threads/thread-1'),
      res: response(),
      url,
      segments: url.pathname.split('/').filter(Boolean),
      taskStore: new FakeTaskStore(),
      tenantContext,
    });
    expect(handled).toBe(false);
  });

  it('creates a task with server-owned fields and it stays queryable', async () => {
    const store = new FakeTaskStore();
    const created = await invoke(store, 'POST', '/api/tasks', createBody);
    expect(created.statusCode).toBe(201);
    const task = taskOf(created);
    expect(task).toMatchObject({
      id: 'task_test_1',
      threadId: 'thread-1',
      objective: 'ship goal tasks',
      acceptanceCriteria: ['api tests pass'],
      status: 'pending',
      runIds: [],
      evidenceIds: [],
      createdAt: CLOCK.toISOString(),
      updatedAt: CLOCK.toISOString(),
      version: 0,
      interactionMode: 'supervised',
      origin: 'explicit_goal',
    });

    const fetched = await invoke(store, 'GET', `/api/tasks/${task.id}`);
    expect(fetched.statusCode).toBe(200);
    expect(taskOf(fetched)).toEqual(task);

    const listed = await invoke(store, 'GET', '/api/tasks?threadId=thread-1');
    expect((listed.body as { tasks: Task[] }).tasks.map((item) => item.id)).toEqual([task.id]);
  });

  it('preserves the explicit Dynamic Workflow origin when requested by the user', async () => {
    const store = new FakeTaskStore();
    const created = await invoke(store, 'POST', '/api/tasks', {
      ...createBody,
      entryMode: 'workflow',
    });
    expect(created.statusCode).toBe(201);
    expect(taskOf(created).origin).toBe('explicit_workflow');

    const listed = await invoke(store, 'GET', '/api/tasks?origin=explicit_workflow');
    expect((listed.body as { tasks: Task[] }).tasks).toMatchObject([
      { id: taskOf(created).id, origin: 'explicit_workflow' },
    ]);
  });

  it('仅服务端可决定 Goal 来源，客户端不能把请求伪装成 Harness shadow', async () => {
    const store = new FakeTaskStore();
    const injectedOrigin = await invoke(store, 'POST', '/api/tasks', {
      ...createBody,
      origin: 'harness_shadow',
    });
    expect(injectedOrigin.statusCode).toBe(400);
    expect(errorOf(injectedOrigin).code).toBe('TASK_REQUEST_INVALID');
    expect(store.tasks.size).toBe(0);

    const created = await invoke(store, 'POST', '/api/tasks', createBody);
    expect(taskOf(created).origin).toBe('explicit_goal');
  });

  it('rejects client-supplied status on create with a structured 400', async () => {
    const store = new FakeTaskStore();
    const res = await invoke(store, 'POST', '/api/tasks', { ...createBody, status: 'completed' });
    expect(res.statusCode).toBe(400);
    expect(errorOf(res).code).toBe('TASK_REQUEST_INVALID');
    expect(errorOf(res).details).toMatchObject({ field: 'status' });
    expect(store.tasks.size).toBe(0);
  });

  it('rejects malformed create bodies', async () => {
    const store = new FakeTaskStore();

    const missing = await invoke(store, 'POST', '/api/tasks', { objective: 'no thread' });
    expect(missing.statusCode).toBe(400);
    expect(errorOf(missing).code).toBe('TASK_REQUEST_INVALID');
    expect(JSON.stringify(errorOf(missing).details)).toContain('threadId');

    const badCriteria = await invoke(store, 'POST', '/api/tasks', { ...createBody, acceptanceCriteria: 'nope' });
    expect(badCriteria.statusCode).toBe(400);

    const blankCriterion = await invoke(store, 'POST', '/api/tasks', {
      ...createBody,
      acceptanceCriteria: ['   '],
    });
    expect(blankCriterion.statusCode).toBe(400);

    const serverField = await invoke(store, 'POST', '/api/tasks', { ...createBody, version: 7 });
    expect(serverField.statusCode).toBe(400);

    const notJson = await invoke(store, 'POST', '/api/tasks', '{oops');
    expect(notJson.statusCode).toBe(400);
    expect(errorOf(notJson).code).toBe('TASK_REQUEST_INVALID');
  });

  it('refuses a second active task per thread but allows one after the first is terminal', async () => {
    const store = new FakeTaskStore();
    const first = await invoke(store, 'POST', '/api/tasks', createBody);
    expect(first.statusCode).toBe(201);

    const conflict = await invoke(store, 'POST', '/api/tasks', createBody);
    expect(conflict.statusCode).toBe(409);
    expect(errorOf(conflict).code).toBe('TASK_ACTIVE_EXISTS');
    expect(errorOf(conflict).details).toMatchObject({
      threadId: 'thread-1',
      taskId: taskOf(first).id,
    });

    await store.updateTask(taskOf(first).id, { status: 'cancelled' }, 0);
    const second = await invoke(store, 'POST', '/api/tasks', createBody);
    expect(second.statusCode).toBe(201);
    expect(taskOf(second).id).toBe('task_test_2');
  });

  it('answers 404 with TASK_NOT_FOUND for unknown ids, sub-routes and deep paths', async () => {
    const store = new FakeTaskStore();

    const missing = await invoke(store, 'GET', '/api/tasks/task_missing');
    expect(missing.statusCode).toBe(404);
    expect(errorOf(missing).code).toBe('TASK_NOT_FOUND');

    const unknownSegment = await invoke(store, 'GET', '/api/tasks/task_missing/lifecycle');
    expect(unknownSegment.statusCode).toBe(404);
    expect(errorOf(unknownSegment).code).toBe('TASK_NOT_FOUND');
    expect(errorOf(unknownSegment).details).toMatchObject({ segment: 'lifecycle' });

    const tooDeep = await invoke(store, 'GET', '/api/tasks/task_missing/runs/run-1/steps');
    expect(tooDeep.statusCode).toBe(404);
    expect(errorOf(tooDeep).code).toBe('TASK_NOT_FOUND');
  });

  it('returns 500 TASK_INTERNAL_ERROR for lifecycle actions when wiring is absent', async () => {
    const store = new FakeTaskStore();
    const created = await invoke(store, 'POST', '/api/tasks', createBody);
    const taskId = taskOf(created).id;

    for (const segment of ['pause', 'resume', 'cancel', 'retry', 'redirect', 'input', 'start']) {
      const res = await invoke(store, 'POST', `/api/tasks/${taskId}/${segment}`, {});
      expect(res.statusCode, segment).toBe(500);
      expect(errorOf(res).code, segment).toBe('TASK_INTERNAL_ERROR');
      expect(errorOf(res).details, segment).toMatchObject({ action: segment, taskId });
    }

    // 非生命周期段仍 404。
    const unknownSegment = await invoke(store, 'POST', `/api/tasks/${taskId}/teleport`, {});
    expect(unknownSegment.statusCode).toBe(404);
    expect(errorOf(unknownSegment).code).toBe('TASK_NOT_FOUND');
  });

  it('goal-status：未注入服务时 500，注入后 200 回传摘要，非 GET 405', async () => {
    const store = new FakeTaskStore();
    const created = await invoke(store, 'POST', '/api/tasks', createBody);
    const taskId = taskOf(created).id;

    const unwired = await invoke(store, 'GET', `/api/tasks/${taskId}/goal-status`);
    expect(unwired.statusCode).toBe(500);
    expect(errorOf(unwired).code).toBe('TASK_INTERNAL_ERROR');

    const wiring = {
      goalStatus: {
        readGoalStatus: async () => ({
          taskId,
          runId: 'goalrun-1',
          passedCriteria: ['一步已完成'],
          failedCriteria: ['还差一步'],
          blocker: '需要确认环境',
          evidenceIds: ['ev_1'],
        }),
        readGoalEvaluation: async () => null,
      },
    };
    const wired = await invoke(store, 'GET', `/api/tasks/${taskId}/goal-status`, undefined, wiring);
    expect(wired.statusCode).toBe(200);
    expect(wired.body).toMatchObject({
      taskId,
      runId: 'goalrun-1',
      blocker: '需要确认环境',
      evidenceIds: ['ev_1'],
    });

    const wrongMethod = await invoke(store, 'POST', `/api/tasks/${taskId}/goal-status`, {}, wiring);
    expect(wrongMethod.statusCode).toBe(405);
  });

  it('rejects non-POST methods on lifecycle segments with 405 (checked before wiring)', async () => {
    const store = new FakeTaskStore();
    const created = await invoke(store, 'POST', '/api/tasks', createBody);
    const taskId = taskOf(created).id;

    const getByGet = await invoke(store, 'GET', `/api/tasks/${taskId}/pause`);
    expect(getByGet.statusCode).toBe(405);
    expect(errorOf(getByGet).code).toBe('TASK_REQUEST_INVALID');

    const badMethod = await invoke(store, 'DELETE', '/api/tasks');
    expect(badMethod.statusCode).toBe(405);
    expect(errorOf(badMethod).code).toBe('TASK_REQUEST_INVALID');

    const badTaskMethod = await invoke(store, 'DELETE', `/api/tasks/${taskId}`);
    expect(badTaskMethod.statusCode).toBe(405);
  });

  it('filters the task list by threadId and comma-separated status', async () => {
    const store = new FakeTaskStore();
    await store.createTask(makeTask({ id: 'task-a', threadId: 'thread-1', status: 'pending' }));
    await store.createTask(makeTask({ id: 'task-b', threadId: 'thread-1', status: 'completed' }));
    await store.createTask(makeTask({ id: 'task-c', threadId: 'thread-2', status: 'blocked' }));

    const all = await invoke(store, 'GET', '/api/tasks');
    expect((all.body as { tasks: Task[] }).tasks).toHaveLength(3);

    const byThread = await invoke(store, 'GET', '/api/tasks?threadId=thread-1');
    expect((byThread.body as { tasks: Task[] }).tasks.map((item) => item.id)).toEqual(['task-a', 'task-b']);

    const byStatus = await invoke(store, 'GET', '/api/tasks?status=completed,blocked');
    expect((byStatus.body as { tasks: Task[] }).tasks.map((item) => item.id).sort()).toEqual(['task-b', 'task-c']);

    const combined = await invoke(store, 'GET', '/api/tasks?threadId=thread-1&status=pending');
    expect((combined.body as { tasks: Task[] }).tasks.map((item) => item.id)).toEqual(['task-a']);

    const invalid = await invoke(store, 'GET', '/api/tasks?status=archived');
    expect(invalid.statusCode).toBe(400);
    expect(errorOf(invalid).code).toBe('TASK_REQUEST_INVALID');
    expect(errorOf(invalid).details).toMatchObject({ field: 'status', received: 'archived' });
  });

  it('filters the task list by origin so Goal Center cannot receive Harness shadows', async () => {
    const store = new FakeTaskStore();
    await store.createTask(makeTask({ id: 'goal-1', threadId: 'thread-1', origin: 'explicit_goal' }));
    await store.createTask(makeTask({ id: 'shadow-1', threadId: 'thread-1', origin: 'harness_shadow' }));
    // Legacy data without origin is interpreted as a harness shadow as well.
    await store.createTask(makeTask({ id: 'legacy-1', threadId: 'thread-2' }));

    const goals = await invoke(store, 'GET', '/api/tasks?origin=explicit_goal');
    expect(goals.statusCode).toBe(200);
    expect((goals.body as { tasks: Task[] }).tasks.map((task) => task.id)).toEqual(['goal-1']);

    const shadows = await invoke(store, 'GET', '/api/tasks?origin=harness_shadow');
    expect((shadows.body as { tasks: Task[] }).tasks.map((task) => task.id).sort()).toEqual(['legacy-1', 'shadow-1']);

    const invalid = await invoke(store, 'GET', '/api/tasks?origin=ordinary_task');
    expect(invalid.statusCode).toBe(400);
    expect(errorOf(invalid).code).toBe('TASK_REQUEST_INVALID');
    expect(errorOf(invalid).details).toMatchObject({ field: 'origin', received: 'ordinary_task' });
  });

  it('lists task runs and reports 404 for unknown tasks', async () => {
    const store = new FakeTaskStore();
    const created = await invoke(store, 'POST', '/api/tasks', createBody);
    const taskId = taskOf(created).id;
    await store.createRun(makeRun({ id: 'run-1', taskId, status: 'running', harnessRunId: 'harness_1' }));
    await store.createRun(makeRun({ id: 'run-2', taskId, kind: 'workflow', workflowKind: 'script' }));
    await store.createRun(makeRun({ id: 'run-other', taskId: 'task-zzz' }));

    const runs = await invoke(store, 'GET', `/api/tasks/${taskId}/runs`);
    expect(runs.statusCode).toBe(200);
    expect((runs.body as { runs: TaskRun[] }).runs.map((item) => item.id).sort()).toEqual(['run-1', 'run-2']);
    expect((runs.body as { taskId: string }).taskId).toBe(taskId);

    const missing = await invoke(store, 'GET', '/api/tasks/task_missing/runs');
    expect(missing.statusCode).toBe(404);
    expect(errorOf(missing).code).toBe('TASK_NOT_FOUND');
  });

  it('projects persisted Workflow runs and evidence into list, detail, and evidence summaries', async () => {
    const store = new FakeTaskStore();
    const task = makeTask({ id: 'workflow-task', threadId: 'thread-workflow', origin: 'explicit_workflow' });
    await store.createTask(task);
    await store.createRun(makeRun({
      id: 'taskrun-workflow-1',
      taskId: task.id,
      threadId: task.threadId,
      kind: 'workflow',
      workflowKind: 'script',
      workflowRunId: 'wfrun-workflow-1',
    }));
    await store.upsertWorkflowRun({
      id: 'wfrun-workflow-1',
      taskRunId: 'taskrun-workflow-1',
      script: 'return { ok: true };',
      scriptHash: 'hash-workflow-1',
      status: 'completed',
      agentCalls: [],
      usage: { inputTokens: 0, outputTokens: 0, agentCallCount: 1, durationMs: 1 },
      startedAt: '2026-09-19T00:00:00.000Z',
      updatedAt: '2026-09-19T00:00:01.000Z',
      evidenceId: 'wev_wfrun-workflow-1_run',
    });
    await store.recordAgentCall('wfrun-workflow-1', {
      id: 'agent-call-1',
      prompt: 'inspect contacts app',
      status: 'completed',
      inputTokens: 1,
      outputTokens: 1,
      evidenceId: 'wev_wfrun-workflow-1_agent-call-1',
    });

    const listed = await invoke(store, 'GET', '/api/tasks?origin=explicit_workflow');
    const listedTask = (listed.body as { tasks: Task[] }).tasks[0];
    expect(listedTask).toMatchObject({
      id: task.id,
      runIds: ['taskrun-workflow-1'],
      evidenceIds: ['wev_wfrun-workflow-1_run', 'wev_wfrun-workflow-1_agent-call-1'],
    });

    const detail = await invoke(store, 'GET', '/api/tasks/' + task.id);
    expect(taskOf(detail)).toMatchObject({ runIds: listedTask?.runIds, evidenceIds: listedTask?.evidenceIds });

    const evidence = await invoke(store, 'GET', '/api/tasks/' + task.id + '/evidence');
    expect(evidence.body).toEqual({ taskId: task.id, evidenceIds: listedTask?.evidenceIds });
  });

  it('returns plan history from existing data only', async () => {
    const store = new FakeTaskStore();
    const created = await invoke(store, 'POST', '/api/tasks', createBody);
    const taskId = taskOf(created).id;
    await store.createRun(makeRun({ id: 'run-1', taskId }));

    const empty = await invoke(store, 'GET', `/api/tasks/${taskId}/plan-history`);
    expect(empty.statusCode).toBe(200);
    expect(empty.body).toMatchObject({
      taskId,
      versions: [],
      latestPlan: null,
      runIds: ['run-1'],
      historyIncomplete: true,
    });

    const plan = {
      version: 3,
      createdAt: '2026-09-19T07:00:00.000Z',
      trigger: 'replan' as const,
      steps: [
        {
          id: 'step-1',
          description: 'wire the route',
          status: 'claimed' as const,
          evidenceIds: ['wev_run-1_call-1'],
        },
      ],
    };
    await store.updateTask(taskId, { latestPlan: plan }, 0);

    const withPlan = await invoke(store, 'GET', `/api/tasks/${taskId}/plan-history`);
    expect(withPlan.statusCode).toBe(200);
    expect(withPlan.body).toMatchObject({
      versions: [plan],
      latestPlan: plan,
      runIds: ['run-1'],
    });
  });

  it('returns raw evidence ids on the P0 evidence endpoint', async () => {
    const store = new FakeTaskStore();
    const created = await invoke(store, 'POST', '/api/tasks', createBody);
    const taskId = taskOf(created).id;
    expect((await invoke(store, 'GET', `/api/tasks/${taskId}/evidence`)).body).toEqual({
      taskId,
      evidenceIds: [],
    });

    await store.updateTask(taskId, { evidenceIds: ['wev_run-1', 'ev_item-2'] }, 0);
    const res = await invoke(store, 'GET', `/api/tasks/${taskId}/evidence`);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ taskId, evidenceIds: ['wev_run-1', 'ev_item-2'] });

    const missing = await invoke(store, 'GET', '/api/tasks/task_missing/evidence');
    expect(missing.statusCode).toBe(404);
  });

  it('patches metadata under optimistic locking', async () => {
    const store = new FakeTaskStore();
    const created = await invoke(store, 'POST', '/api/tasks', createBody);
    const taskId = taskOf(created).id;

    const patched = await invoke(store, 'PATCH', `/api/tasks/${taskId}/metadata`, {
      objective: 'rescoped objective',
      acceptanceCriteria: ['criterion one', 'criterion two'],
      expectedVersion: 0,
    });
    expect(patched.statusCode).toBe(200);
    expect(taskOf(patched)).toMatchObject({
      objective: 'rescoped objective',
      acceptanceCriteria: ['criterion one', 'criterion two'],
      status: 'pending',
      version: 1,
      updatedAt: CLOCK.toISOString(),
    });

    const stale = await invoke(store, 'PATCH', `/api/tasks/${taskId}/metadata`, {
      objective: 'losing write',
      expectedVersion: 0,
    });
    expect(stale.statusCode).toBe(409);
    expect(errorOf(stale).code).toBe('TASK_VERSION_CONFLICT');
    expect(errorOf(stale).details).toMatchObject({ expectedVersion: 0, actualVersion: 1 });
    expect(taskOf(await invoke(store, 'GET', `/api/tasks/${taskId}`)).objective).toBe('rescoped objective');

    const wrongMethod = await invoke(store, 'POST', `/api/tasks/${taskId}/metadata`, {
      objective: 'x',
      expectedVersion: 1,
    });
    expect(wrongMethod.statusCode).toBe(405);
  });

  it('rejects metadata patches that touch status or unknown fields', async () => {
    const store = new FakeTaskStore();
    const created = await invoke(store, 'POST', '/api/tasks', createBody);
    const taskId = taskOf(created).id;

    const withStatus = await invoke(store, 'PATCH', `/api/tasks/${taskId}/metadata`, {
      status: 'completed',
      expectedVersion: 0,
    });
    expect(withStatus.statusCode).toBe(400);
    expect(errorOf(withStatus).details).toMatchObject({ field: 'status' });

    const unknownField = await invoke(store, 'PATCH', `/api/tasks/${taskId}/metadata`, {
      currentRunId: 'run-1',
      expectedVersion: 0,
    });
    expect(unknownField.statusCode).toBe(400);

    const noVersion = await invoke(store, 'PATCH', `/api/tasks/${taskId}/metadata`, {
      objective: 'no lock',
    });
    expect(noVersion.statusCode).toBe(400);
    expect(JSON.stringify(errorOf(noVersion).details)).toContain('expectedVersion');

    const nothingEditable = await invoke(store, 'PATCH', `/api/tasks/${taskId}/metadata`, {
      expectedVersion: 0,
    });
    expect(nothingEditable.statusCode).toBe(400);
    expect(errorOf(nothingEditable).code).toBe('TASK_REQUEST_INVALID');

    const missingTask = await invoke(store, 'PATCH', '/api/tasks/task_missing/metadata', {
      objective: 'orphan',
      expectedVersion: 0,
    });
    expect(missingTask.statusCode).toBe(404);
    expect(errorOf(missingTask).code).toBe('TASK_NOT_FOUND');
  });

  it('maps storage-side conflicts and invalid transitions to stable codes', async () => {
    const store = new FakeTaskStore();
    const created = await invoke(store, 'POST', '/api/tasks', createBody);
    const taskId = taskOf(created).id;

    // 路由层预检通过（版本一致），但存储层最终裁决为冲突：必须原样映射为 409。
    store.forceVersionConflict = true;
    const raced = await invoke(store, 'PATCH', `/api/tasks/${taskId}/metadata`, {
      objective: 'racing writer',
      expectedVersion: 0,
    });
    expect(raced.statusCode).toBe(409);
    expect(errorOf(raced).code).toBe('TASK_VERSION_CONFLICT');
    store.forceVersionConflict = false;

    // 终态 Task 的目标层迁移由存储层拒绝；路由不得静默吞掉。
    await store.updateTask(taskId, { status: 'running' }, 0);
    const running = await store.getTask(taskId);
    await store.updateTask(taskId, { status: 'completed' }, running?.version ?? 0);
    const terminal = await store.getTask(taskId);
    expect(terminal?.status).toBe('completed');
    const invalid = await store.updateTask(taskId, { status: 'running' }, terminal?.version ?? 0).catch((error) => error);
    expect(invalid).toBeInstanceOf(TaskError);
    expect((invalid as TaskError).code).toBe('TASK_INVALID_TRANSITION');

    const listTerminal = await invoke(store, 'GET', '/api/tasks?status=completed');
    expect((listTerminal.body as { tasks: Task[] }).tasks.map((item) => item.id)).toEqual([taskId]);
  });
});

// ─── P2 生命周期端点（接线，直调 handler）────────────────────────────────────

describe('taskRoute P2 lifecycle endpoints', () => {
  function bodyOf(res: FakeResponse): { task: Task; run?: TaskRun } {
    return res.body as { task: Task; run?: TaskRun };
  }

  it('POST :id/start → 202 { task, run } and moves the task to running', async () => {
    const store = new FakeTaskStore();
    const harness = makeLifecycleHarness();
    const created = await invoke(store, 'POST', '/api/tasks', createBody);
    const taskId = taskOf(created).id;

    const started = await invoke(store, 'POST', `/api/tasks/${taskId}/start`, {}, harness.wiring);
    expect(started.statusCode).toBe(202);
    expect(bodyOf(started).task.status).toBe('running');
    expect(bodyOf(started).run?.status).toBe('running');
    expect(harness.calls.runHarness).toBe(1);
    expect(harness.events.some((event) => event.type === 'task.run.updated')).toBe(true);
  });

  it('POST :id/pause then :id/resume returns 200 then 202 and drives the agent', async () => {
    const store = new FakeTaskStore();
    const harness = makeLifecycleHarness();
    const created = await invoke(store, 'POST', '/api/tasks', createBody);
    const taskId = taskOf(created).id;
    await invoke(store, 'POST', `/api/tasks/${taskId}/start`, {}, harness.wiring);

    const paused = await invoke(store, 'POST', `/api/tasks/${taskId}/pause`, { reason: 'brk' }, harness.wiring);
    expect(paused.statusCode).toBe(200);
    expect(bodyOf(paused).run?.status).toBe('paused');
    expect(harness.calls.interrupt).toBe(1);

    const resumed = await invoke(store, 'POST', `/api/tasks/${taskId}/resume`, {}, harness.wiring);
    expect(resumed.statusCode).toBe(202);
    expect(bodyOf(resumed).run?.status).toBe('running');
    // pause 只中止当前 harness，resume 再起一次真正的续跑 harness。
    expect(harness.calls.resumeHarness).toBe(1);
  });

  it('POST :id/cancel → 200 with cancelled run + task and a terminal event', async () => {
    const store = new FakeTaskStore();
    const harness = makeLifecycleHarness();
    const created = await invoke(store, 'POST', '/api/tasks', createBody);
    const taskId = taskOf(created).id;
    await invoke(store, 'POST', `/api/tasks/${taskId}/start`, {}, harness.wiring);

    const cancelled = await invoke(store, 'POST', `/api/tasks/${taskId}/cancel`, {}, harness.wiring);
    expect(cancelled.statusCode).toBe(200);
    expect(bodyOf(cancelled).run?.status).toBe('cancelled');
    expect(bodyOf(cancelled).task.status).toBe('cancelled');
    expect(harness.events.some((event) => event.type === 'task.run.terminal')).toBe(true);
  });

  it('POST :id/redirect → 202 with a fresh running run and cancelled predecessor', async () => {
    const store = new FakeTaskStore();
    const harness = makeLifecycleHarness();
    const created = await invoke(store, 'POST', '/api/tasks', createBody);
    const taskId = taskOf(created).id;
    const started = await invoke(store, 'POST', `/api/tasks/${taskId}/start`, {}, harness.wiring);
    const firstRunId = started.body as { run: TaskRun };

    const redirected = await invoke(store, 'POST', `/api/tasks/${taskId}/redirect`, { instruction: 'go left' }, harness.wiring);
    expect(redirected.statusCode).toBe(202);
    expect(bodyOf(redirected).run?.status).toBe('running');
    expect(bodyOf(redirected).run?.id).not.toBe(firstRunId.run.id);
    expect((await store.getRun(firstRunId.run.id))?.status).toBe('cancelled');
  });

  it('POST :id/input → 202 resolving a blocked task with an answer', async () => {
    const store = new FakeTaskStore();
    const harness = makeLifecycleHarness();
    await store.createTask({
      id: 'task-blocked',
      threadId: 'thread-9',
      objective: 'blocked goal',
      acceptanceCriteria: ['done'],
      status: 'blocked',
      runIds: ['run-blocked'],
      currentRunId: 'run-blocked',
      evidenceIds: [],
      pendingInput: { question: 'pick one', freeText: true, askedAt: '2026-09-19T07:00:00.000Z' },
      createdAt: '2026-09-19T00:00:00.000Z',
      updatedAt: '2026-09-19T00:00:00.000Z',
      version: 0,
      interactionMode: 'supervised',
      origin: 'explicit_goal',
    });
    await store.createRun({
      id: 'run-blocked',
      taskId: 'task-blocked',
      threadId: 'thread-9',
      kind: 'goal',
      status: 'blocked',
      updatedAt: '2026-09-19T00:00:00.000Z',
      version: 0,
    });

    const answered = await invoke(store, 'POST', '/api/tasks/task-blocked/input', { answer: 'option A' }, harness.wiring);
    expect(answered.statusCode).toBe(202);
    expect(bodyOf(answered).run?.status).toBe('running');
    expect(bodyOf(answered).task.pendingInput).toBeUndefined();
  });

  it('rejects empty redirect.instruction / input.answer with a strict 400', async () => {
    const store = new FakeTaskStore();
    const harness = makeLifecycleHarness();
    const created = await invoke(store, 'POST', '/api/tasks', createBody);
    const taskId = taskOf(created).id;
    await invoke(store, 'POST', `/api/tasks/${taskId}/start`, {}, harness.wiring);

    const badRedirect = await invoke(store, 'POST', `/api/tasks/${taskId}/redirect`, { instruction: '   ' }, harness.wiring);
    expect(badRedirect.statusCode).toBe(400);
    expect(errorOf(badRedirect).code).toBe('TASK_REQUEST_INVALID');

    const badInput = await invoke(store, 'POST', `/api/tasks/${taskId}/input`, {}, harness.wiring);
    expect(badInput.statusCode).toBe(400);
    expect(errorOf(badInput).code).toBe('TASK_REQUEST_INVALID');

    // strict：多余字段（含 status）直接 400。
    const extraField = await invoke(store, 'POST', `/api/tasks/${taskId}/redirect`, { instruction: 'ok', status: 'completed' }, harness.wiring);
    expect(extraField.statusCode).toBe(400);
    expect(errorOf(extraField).code).toBe('TASK_REQUEST_INVALID');
  });

  it('maps illegal preconditions to 409 and unknown ids to 404', async () => {
    const store = new FakeTaskStore();
    const harness = makeLifecycleHarness();
    const created = await invoke(store, 'POST', '/api/tasks', createBody);
    const taskId = taskOf(created).id;
    await invoke(store, 'POST', `/api/tasks/${taskId}/start`, {}, harness.wiring);

    // running 中再次 start → 非法前置 409。
    const again = await invoke(store, 'POST', `/api/tasks/${taskId}/start`, {}, harness.wiring);
    expect(again.statusCode).toBe(409);
    expect(errorOf(again).code).toBe('TASK_INVALID_TRANSITION');

    const missing = await invoke(store, 'POST', '/api/tasks/task_missing/start', {}, harness.wiring);
    expect(missing.statusCode).toBe(404);
    expect(errorOf(missing).code).toBe('TASK_NOT_FOUND');
  });
});
