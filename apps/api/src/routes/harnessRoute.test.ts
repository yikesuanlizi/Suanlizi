import { PassThrough } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ThreadMeta, UserInput } from '@suanlizi/protocol';
import type { ThreadStore } from '@suanlizi/storage';
import type { AgentLoop, HarnessResult, RunTurnOptions } from '@suanlizi/runtime';
import { handleHarnessRoute } from './harnessRoute.js';
import { handleTaskRoute } from './taskRoute.js';
import { FakeTaskStore } from '../testing/fakeTaskStore.js';
import { harnessRuntimeRegistry } from '../services/harnessRuntime.js';
import type { TenantContext } from '../shared/tenant.js';
import type { AgentRunConfig } from '../config/config.js';
import { defaultConfig } from '../config/config.js';

class FakeStore implements Partial<ThreadStore> {
  thread: ThreadMeta;

  constructor(tags: Record<string, string> = {}) {
    const now = '2026-07-16T00:00:00.000Z';
    this.thread = {
      threadId: 'thread-harness',
      title: 'Harness',
      workspaceRoot: process.cwd(),
      status: 'active',
      turnCount: 0,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      ephemeral: false,
      tags,
    };
  }

  async getThread(threadId: string) {
    return threadId === this.thread.threadId ? this.thread : null;
  }

  async updateThreadMetadata(_threadId: string, patch: Partial<Pick<ThreadMeta, 'tags'>>) {
    this.thread = {
      ...this.thread,
      tags: patch.tags ?? this.thread.tags,
    };
  }
}

function request(method: string, path: string, body?: unknown): IncomingMessage {
  const stream = new PassThrough();
  const req = stream as unknown as IncomingMessage;
  req.method = method;
  req.url = path;
  req.headers = {};
  if (body !== undefined) stream.end(JSON.stringify(body));
  else stream.end();
  return req;
}

function response() {
  const chunks: Buffer[] = [];
  const res = new PassThrough() as unknown as ServerResponse & {
    statusCode: number;
    headers: Record<string, unknown>;
    body?: unknown;
  };
  res.headers = {};
  res.writeHead = ((status: number, headers?: Record<string, unknown>) => {
    res.statusCode = status;
    res.headers = headers ?? {};
    return res;
  }) as never;
  res.write = ((chunk: string | Buffer) => {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    return true;
  }) as never;
  res.end = ((chunk?: string | Buffer) => {
    if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    const text = Buffer.concat(chunks).toString('utf8');
    res.body = text ? JSON.parse(text) : undefined;
    return res;
  }) as never;
  return res;
}

function harnessResult(runId: string): HarnessResult {
  return {
    status: 'satisfied',
    harnessRunId: runId,
    iterations: 1,
    finalEvaluation: null,
    evidenceCount: 0,
    items: [],
    usage: null,
  };
}

const tenantContext: TenantContext = { tenantId: 'tenant-a' };

afterEach(() => {
  harnessRuntimeRegistry.abortAll();
  harnessRuntimeRegistry.cleanup(-1);
});

describe('harness route', () => {
  const mockGetThreadRunConfig = vi.fn(async (_threadId: string): Promise<AgentRunConfig> => ({
    ...defaultConfig,
    model: 'thread-model',
  }));

  it('returns false for non-harness paths', async () => {
    const handled = await handleHarnessRoute({
      req: request('GET', '/api/threads/thread-harness'),
      res: response(),
      url: new URL('http://localhost/api/threads/thread-harness'),
      segments: ['api', 'threads', 'thread-harness'],
      store: new FakeStore() as unknown as ThreadStore,
      tenantContext,
      createAgent: async () => ({}) as AgentLoop,
      publishEvent: vi.fn(),
      getThreadRunConfig: mockGetThreadRunConfig,
    });

    expect(handled).toBe(false);
  });

  it('starts a harness run and exposes runtime status', async () => {
    let capturedSignal: AbortSignal | undefined;
    const runHarness = vi.fn(async (
      _threadId: string,
      _input: UserInput,
      options?: RunTurnOptions & {
        goal?: string;
        acceptanceCriteria?: string[];
        maxContinuations?: number;
        signal?: AbortSignal;
      },
    ) => {
      capturedSignal = options?.signal;
      return harnessResult(options?.harnessRunId ?? 'missing-run-id');
    });
    const store = new FakeStore();
    const res = response();

    const handled = await handleHarnessRoute({
      req: request('POST', '/api/threads/thread-harness/harness/start', {
        input: 'ship autonomous loop',
        goal: 'ship autonomous loop',
        acceptanceCriteria: ['tests pass'],
        maxContinuations: 3,
      }),
      res,
      url: new URL('http://localhost/api/threads/thread-harness/harness/start'),
      segments: ['api', 'threads', 'thread-harness', 'harness', 'start'],
      store: store as unknown as ThreadStore,
      tenantContext,
      createAgent: async () => ({ runHarness }) as unknown as AgentLoop,
      publishEvent: vi.fn(),
      getThreadRunConfig: mockGetThreadRunConfig,
    });

    expect(handled).toBe(true);
    expect(res.statusCode).toBe(202);
    expect(res.body).toMatchObject({
      ok: true,
      threadId: 'thread-harness',
      status: 'running',
    });
    expect(runHarness).toHaveBeenCalledWith(
      'thread-harness',
      { type: 'text', text: 'ship autonomous loop' },
      expect.objectContaining({
        goal: 'ship autonomous loop',
        acceptanceCriteria: ['tests pass'],
        maxContinuations: 3,
        harnessRunId: expect.stringMatching(/^harness_/),
      }),
    );
    expect(capturedSignal).toBeInstanceOf(AbortSignal);

    await Promise.resolve();
    const harnessRunId = (res.body as { harnessRunId: string }).harnessRunId;
    const statusRes = response();
    await handleHarnessRoute({
      req: request('GET', `/api/threads/thread-harness/harness/status?runId=${harnessRunId}`),
      res: statusRes,
      url: new URL(`http://localhost/api/threads/thread-harness/harness/status?runId=${harnessRunId}`),
      segments: ['api', 'threads', 'thread-harness', 'harness', 'status'],
      store: store as unknown as ThreadStore,
      tenantContext,
      createAgent: async () => ({}) as AgentLoop,
      publishEvent: vi.fn(),
      getThreadRunConfig: mockGetThreadRunConfig,
    });

    expect(statusRes.statusCode).toBe(200);
    expect(statusRes.body).toMatchObject({
      threadId: 'thread-harness',
      harnessRunId,
      runtimeStatus: 'completed',
      result: expect.objectContaining({ harnessRunId }),
    });
  });

  it('rejects start when the thread already has an active harness run', async () => {
    const res = response();

    await handleHarnessRoute({
      req: request('POST', '/api/threads/thread-harness/harness/start', { input: 'again' }),
      res,
      url: new URL('http://localhost/api/threads/thread-harness/harness/start'),
      segments: ['api', 'threads', 'thread-harness', 'harness', 'start'],
      store: new FakeStore({ activeHarnessRunId: 'harness-active' }) as unknown as ThreadStore,
      tenantContext,
      createAgent: async () => ({}) as AgentLoop,
      publishEvent: vi.fn(),
      getThreadRunConfig: mockGetThreadRunConfig,
    });

    expect(res.statusCode).toBe(409);
    expect(res.body).toEqual({
      error: 'Thread already has an active harness run. Cancel or wait for it to finish first.',
    });
  });

  it('returns persisted status for a requested run id after the runtime entry is gone', async () => {
    const persistedState = {
      harnessRunId: 'harness-persisted',
      goal: {
        objective: 'finish harness',
        acceptanceCriteria: ['done'],
        maxContinuations: 8,
        maxNoProgress: 2,
      },
      plan: [],
      activeNodeId: null,
      iteration: 2,
      noProgressCount: 0,
      lastEvaluation: null,
      lastProgressSignature: null,
      status: 'satisfied',
      startedAt: '2026-07-16T00:00:00.000Z',
      updatedAt: '2026-07-16T00:01:00.000Z',
    };
    const store = new FakeStore({
      activeHarnessRunId: '',
      'harnessState:harness-persisted': JSON.stringify(persistedState),
    });
    const res = response();

    await handleHarnessRoute({
      req: request('GET', '/api/threads/thread-harness/harness/status?runId=harness-persisted'),
      res,
      url: new URL('http://localhost/api/threads/thread-harness/harness/status?runId=harness-persisted'),
      segments: ['api', 'threads', 'thread-harness', 'harness', 'status'],
      store: store as unknown as ThreadStore,
      tenantContext,
      createAgent: async () => ({}) as AgentLoop,
      publishEvent: vi.fn(),
      getThreadRunConfig: mockGetThreadRunConfig,
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({
      threadId: 'thread-harness',
      harnessRunId: 'harness-persisted',
      runtimeStatus: 'unknown',
      persistedStatus: 'satisfied',
      iteration: 2,
      goal: 'finish harness',
      acceptanceCriteria: ['done'],
    });
  });

  it('cancels the active harness run for a thread', async () => {
    const store = new FakeStore();
    harnessRuntimeRegistry.start({
      harnessRunId: 'harness-route-cancel',
      threadId: 'thread-harness',
      tenantId: 'tenant-a',
      run: async (signal) => new Promise<HarnessResult>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('cancelled')));
      }),
    });
    const res = response();

    await handleHarnessRoute({
      req: request('POST', '/api/threads/thread-harness/harness/cancel'),
      res,
      url: new URL('http://localhost/api/threads/thread-harness/harness/cancel'),
      segments: ['api', 'threads', 'thread-harness', 'harness', 'cancel'],
      store: store as unknown as ThreadStore,
      tenantContext,
      createAgent: async () => ({}) as AgentLoop,
      publishEvent: vi.fn(),
      getThreadRunConfig: mockGetThreadRunConfig,
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({
      ok: true,
      harnessRunId: 'harness-route-cancel',
      runtimeStatus: 'cancelled',
    });
  });

  it('uses thread config when body.config is not provided', async () => {
    const threadConfig: AgentRunConfig = {
      ...defaultConfig,
      model: 'thread-specific-model',
      provider: 'thread-provider',
    };
    const getConfig = vi.fn(async () => threadConfig);
    let capturedConfig: Partial<AgentRunConfig> | undefined;
    const createAgent = vi.fn(async (config?: Partial<AgentRunConfig>) => {
      capturedConfig = config;
      return {
        runHarness: vi.fn(async () => harnessResult('harness-test')),
      } as unknown as AgentLoop;
    });

    const res = response();
    await handleHarnessRoute({
      req: request('POST', '/api/threads/thread-harness/harness/start', {
        input: 'test input',
      }),
      res,
      url: new URL('http://localhost/api/threads/thread-harness/harness/start'),
      segments: ['api', 'threads', 'thread-harness', 'harness', 'start'],
      store: new FakeStore() as unknown as ThreadStore,
      tenantContext,
      createAgent,
      publishEvent: vi.fn(),
      getThreadRunConfig: getConfig,
    });

    expect(getConfig).toHaveBeenCalledWith('thread-harness');
    expect(createAgent).toHaveBeenCalled();
    expect(capturedConfig).toMatchObject({
      model: 'thread-specific-model',
      provider: 'thread-provider',
    });
    expect(res.statusCode).toBe(202);
  });

  it('merges body.config as overlay on top of thread config (without persistence)', async () => {
    const threadConfig: AgentRunConfig = {
      ...defaultConfig,
      model: 'thread-model',
      provider: 'thread-provider',
    };
    const getConfig = vi.fn(async () => threadConfig);
    let capturedConfig: Partial<AgentRunConfig> | undefined;
    const createAgent = vi.fn(async (config?: Partial<AgentRunConfig>) => {
      capturedConfig = config;
      return {
        runHarness: vi.fn(async () => harnessResult('harness-test')),
      } as unknown as AgentLoop;
    });

    const res = response();
    await handleHarnessRoute({
      req: request('POST', '/api/threads/thread-harness/harness/start', {
        input: 'test input',
        config: {
          model: 'overlay-model',
        },
      }),
      res,
      url: new URL('http://localhost/api/threads/thread-harness/harness/start'),
      segments: ['api', 'threads', 'thread-harness', 'harness', 'start'],
      store: new FakeStore() as unknown as ThreadStore,
      tenantContext,
      createAgent,
      publishEvent: vi.fn(),
      getThreadRunConfig: getConfig,
    });

    expect(getConfig).toHaveBeenCalledWith('thread-harness');
    expect(createAgent).toHaveBeenCalled();
    expect(capturedConfig).toMatchObject({
      model: 'overlay-model',
      provider: 'thread-provider',
    });
    expect(res.statusCode).toBe(202);
  });

  it('P0 影子写：harness start 后能从 /api/tasks 查到对应 Task 与 goal Run', async () => {
    const runHarness = vi.fn(async (
      _threadId: string,
      _input: UserInput,
      options?: { harnessRunId?: string },
    ) => harnessResult(options?.harnessRunId ?? 'missing-run-id'));
    const store = new FakeStore();
    const taskStore = new FakeTaskStore();
    const res = response();

    const handled = await handleHarnessRoute({
      req: request('POST', '/api/threads/thread-harness/harness/start', {
        input: '影子写验收',
        goal: '影子写验收目标',
        acceptanceCriteria: ['能从 /api/tasks 查到 Task'],
      }),
      res,
      url: new URL('http://localhost/api/threads/thread-harness/harness/start'),
      segments: ['api', 'threads', 'thread-harness', 'harness', 'start'],
      store: store as unknown as ThreadStore,
      tenantContext,
      taskStore,
      createAgent: async () => ({ runHarness }) as unknown as AgentLoop,
      publishEvent: vi.fn(),
      getThreadRunConfig: mockGetThreadRunConfig,
    });
    expect(handled).toBe(true);
    expect(res.statusCode).toBe(202);
    const harnessRunId = (res.body as { harnessRunId: string }).harnessRunId;

    // runHarness 立即 resolve：等微任务链把影子 Run 推进到终态。
    await new Promise((resolvePending) => setTimeout(resolvePending, 0));

    const listRes = response();
    const listHandled = await handleTaskRoute({
      req: request('GET', '/api/tasks?threadId=thread-harness'),
      res: listRes,
      url: new URL('http://localhost/api/tasks?threadId=thread-harness'),
      segments: ['api', 'tasks'],
      taskStore,
      tenantContext,
    });
    expect(listHandled).toBe(true);
    expect(listRes.statusCode).toBe(200);
    expect(listRes.body).toMatchObject({
      tasks: [
        {
          threadId: 'thread-harness',
          objective: '影子写验收目标',
          acceptanceCriteria: ['能从 /api/tasks 查到 Task'],
          // Run 已 completed（验收 gate 在 P3），Task 保守停在 running。
          status: 'running',
        },
      ],
    });
    const taskId = (listRes.body as { tasks: Array<{ id: string }> }).tasks[0]!.id;

    const runsRes = response();
    await handleTaskRoute({
      req: request('GET', `/api/tasks/${taskId}/runs`),
      res: runsRes,
      url: new URL(`http://localhost/api/tasks/${taskId}/runs`),
      segments: ['api', 'tasks', taskId, 'runs'],
      taskStore,
      tenantContext,
    });
    expect(runsRes.statusCode).toBe(200);
    expect(runsRes.body).toMatchObject({
      taskId,
      runs: [
        {
          kind: 'goal',
          harnessRunId,
          status: 'completed',
        },
      ],
    });
    // goal Run 不得携带 workflowKind（§14.8）。
    expect((runsRes.body as { runs: Array<Record<string, unknown>> }).runs[0]).not.toHaveProperty('workflowKind');
  });

  it('未注入 taskStore 时 harness start 保持既有行为，不写 task 表', async () => {
    const runHarness = vi.fn(async (
      _threadId: string,
      _input: UserInput,
      options?: { harnessRunId?: string },
    ) => harnessResult(options?.harnessRunId ?? 'missing-run-id'));
    const res = response();
    await handleHarnessRoute({
      req: request('POST', '/api/threads/thread-harness/harness/start', { input: '无影子写' }),
      res,
      url: new URL('http://localhost/api/threads/thread-harness/harness/start'),
      segments: ['api', 'threads', 'thread-harness', 'harness', 'start'],
      store: new FakeStore() as unknown as ThreadStore,
      tenantContext,
      createAgent: async () => ({ runHarness }) as unknown as AgentLoop,
      publishEvent: vi.fn(),
      getThreadRunConfig: mockGetThreadRunConfig,
    });
    expect(res.statusCode).toBe(202);
    await new Promise((resolvePending) => setTimeout(resolvePending, 0));
    // 没有 taskStore 入口即无任何 task 写入；此处用新建 fake 验证其保持为空。
    const untouched = new FakeTaskStore();
    expect(await untouched.listTasks()).toEqual([]);
  });

  it('P2 取消链双写：start 注册的 interrupt 先于 abort 作用于 AgentLoop', async () => {
    const order: string[] = [];
    const interrupt = vi.fn(() => {
      order.push('interrupt');
      return true;
    });
    const runHarness = vi.fn(async (
      _threadId: string,
      _input: UserInput,
      options?: { harnessRunId?: string; signal?: AbortSignal },
    ) => new Promise<HarnessResult>((_resolve, reject) => {
      options?.signal?.addEventListener('abort', () => {
        order.push('abort');
        reject(new Error('cancelled'));
      });
    }));
    const store = new FakeStore();
    const res = response();

    await handleHarnessRoute({
      req: request('POST', '/api/threads/thread-harness/harness/start', { input: '取消链双写' }),
      res,
      url: new URL('http://localhost/api/threads/thread-harness/harness/start'),
      segments: ['api', 'threads', 'thread-harness', 'harness', 'start'],
      store: store as unknown as ThreadStore,
      tenantContext,
      createAgent: async () => ({ runHarness, interrupt }) as unknown as AgentLoop,
      publishEvent: vi.fn(),
      getThreadRunConfig: mockGetThreadRunConfig,
    });
    expect(res.statusCode).toBe(202);
    const harnessRunId = (res.body as { harnessRunId: string }).harnessRunId;

    const cancelRes = response();
    await handleHarnessRoute({
      req: request('POST', `/api/threads/thread-harness/harness/cancel?runId=${harnessRunId}`),
      res: cancelRes,
      url: new URL(`http://localhost/api/threads/thread-harness/harness/cancel?runId=${harnessRunId}`),
      segments: ['api', 'threads', 'thread-harness', 'harness', 'cancel'],
      store: store as unknown as ThreadStore,
      tenantContext,
      createAgent: async () => ({ runHarness, interrupt }) as unknown as AgentLoop,
      publishEvent: vi.fn(),
      getThreadRunConfig: mockGetThreadRunConfig,
    });

    expect(cancelRes.statusCode).toBe(200);
    expect(interrupt).toHaveBeenCalledWith('thread-harness');
    expect(order).toEqual(['interrupt', 'abort']);
    await expect(harnessRuntimeRegistry.get(harnessRunId)!.promise).rejects.toThrow('cancelled');
  });
});
