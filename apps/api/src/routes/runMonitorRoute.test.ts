import { PassThrough } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import type { RunEvent, RunRecord, ThreadStore } from '@suanlizi/storage';
import type { RunTraceEnvelope, RunTracePage, ThreadItem, TurnMeta } from '@suanlizi/protocol';
import { handleRunMonitorRoute } from './runMonitorRoute.js';
import type { TenantContext } from '../shared/tenant.js';
import { ActiveRunRegistry } from '../runtime/activeRunRegistry.js';

class FakeStore implements Partial<ThreadStore> {
  runs: RunRecord[] = [
    {
      runId: 'run-a',
      tenantId: 'tenantA',
      threadId: 'thread-a',
      turnId: 'turn-a',
      kind: 'turn',
      status: 'running',
      caller: 'lead_agent',
      inputTokens: 1,
      cachedInputTokens: 0,
      outputTokens: 2,
      reasoningOutputTokens: 0,
      toolCallCount: 1,
      modelCallCount: 1,
      subagentCount: 0,
      middlewareEventCount: 0,
      startedAt: '2026-06-16T00:00:00.000Z',
      updatedAt: '2026-06-16T00:00:01.000Z',
    },
    {
      runId: 'run-b',
      tenantId: 'tenantA',
      threadId: 'thread-a',
      turnId: 'turn-b',
      kind: 'turn',
      status: 'running',
      caller: 'lead_agent',
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      reasoningOutputTokens: 0,
      toolCallCount: 0,
      modelCallCount: 0,
      subagentCount: 0,
      middlewareEventCount: 0,
      startedAt: '2026-06-16T00:00:10.000Z',
      updatedAt: '2026-06-16T00:00:11.000Z',
    },
  ];
  events: RunEvent[] = [{
    eventId: 'event-a',
    runId: 'run-a',
    tenantId: 'tenantA',
    threadId: 'thread-a',
    sequence: 1,
    category: 'turn',
    type: 'turn.started',
    level: 'info',
    message: 'started',
    metadata: {},
    createdAt: '2026-06-16T00:00:00.000Z',
  }];
  traces: RunTraceEnvelope[] = [
    {
      version: 2,
      eventId: 'trace-1',
      sequence: 1,
      runId: 'run-a',
      runKind: 'turn',
      threadId: 'thread-a',
      turnId: 'turn-a',
      spanId: 'span:run-a:item:1',
      category: 'item',
      name: 'item.user_message',
      lifecycle: 'completed',
      level: 'info',
      occurredAt: '2026-06-16T00:00:00.000Z',
      payload: { itemType: 'user_message', status: 'completed' },
    },
    {
      version: 2,
      eventId: 'trace-2',
      sequence: 2,
      runId: 'run-a',
      runKind: 'turn',
      threadId: 'thread-a',
      turnId: 'turn-a',
      spanId: 'span:run-a:model:1',
      category: 'model',
      name: 'model.openai',
      lifecycle: 'completed',
      level: 'info',
      occurredAt: '2026-06-16T00:00:01.000Z',
      payload: { provider: 'openai', model: 'gpt-5', attempt: 1, streaming: true, inputTokens: 11, outputTokens: 7 },
    },
    {
      version: 2,
      eventId: 'trace-3',
      sequence: 3,
      runId: 'run-a',
      runKind: 'turn',
      threadId: 'thread-a',
      turnId: 'turn-a',
      spanId: 'span:run-a:error:1',
      category: 'error',
      name: 'tool.error',
      lifecycle: 'instant',
      level: 'error',
      occurredAt: '2026-06-16T00:00:02.000Z',
      payload: { code: 'TOOL_FAILED', message: 'tool failed', retryable: false },
    },
  ];
  // P6.3：items 携带 runId 字段，用于验证严格按 runId 过滤 — Chinese: items carry runId for strict run-scoped filter tests
  items: ThreadItem[] = [
    { id: 'item-1', type: 'user_message', turnId: 'turn-a', runId: 'run-a', text: 'hello', timestamp: '2026-06-16T00:00:00.000Z' } as ThreadItem,
    { id: 'item-2', type: 'agent_message', turnId: 'turn-a', runId: 'run-a', text: 'hi there', timestamp: '2026-06-16T00:00:01.000Z' } as ThreadItem,
    { id: 'item-3', type: 'tool_call', turnId: 'turn-a', runId: 'run-a', toolName: 'search', arguments: {}, status: 'completed', timestamp: '2026-06-16T00:00:02.000Z' } as ThreadItem,
    { id: 'item-4', type: 'user_message', turnId: 'turn-b', runId: 'run-b', text: 'next turn', timestamp: '2026-06-16T00:00:10.000Z' } as ThreadItem,
    { id: 'item-5', type: 'agent_message', turnId: 'turn-b', runId: 'run-b', text: 'reply', timestamp: '2026-06-16T00:00:11.000Z' } as ThreadItem,
  ];
  turns: TurnMeta[] = [
    { turnId: 'turn-a', threadId: 'thread-a', index: 0, userInput: { type: 'text', text: 'hello' }, status: 'running', startedAt: '2026-06-16T00:00:00.000Z', completedAt: null },
    { turnId: 'turn-b', threadId: 'thread-a', index: 1, userInput: { type: 'text', text: 'next turn' }, status: 'completed', startedAt: '2026-06-16T00:00:10.000Z', completedAt: '2026-06-16T00:00:11.000Z' },
  ];
  updates: Array<{ runId: string; patch: Partial<RunRecord> }> = [];
  appended: RunEvent[] = [];

  async listRunRecords() {
    return this.runs;
  }

  async getRunRecord(runId: string) {
    return this.runs.find((r) => r.runId === runId) ?? null;
  }

  async listRunEvents(runId: string, filter: { category?: string; type?: string; afterSequence?: number; beforeSequence?: number; limit?: number } = {}) {
    let result = this.events.filter((event) => event.runId === runId);
    if (filter.category) result = result.filter((e) => e.category === filter.category);
    if (filter.type) result = result.filter((e) => e.type === filter.type);
    if (filter.afterSequence !== undefined) result = result.filter((e) => e.sequence > filter.afterSequence!);
    if (filter.beforeSequence !== undefined) result = result.filter((e) => e.sequence < filter.beforeSequence!);
    result.sort((a, b) => a.sequence - b.sequence);
    if (filter.limit) result = result.slice(0, filter.limit);
    return result;
  }

  async listRunTraceEvents(runId: string, query: { before?: number; after?: number; limit?: number; categories?: string[]; errorsOnly?: boolean } = {}): Promise<RunTracePage> {
    let events = this.traces.filter((event) => event.runId === runId);
    if (query.categories && query.categories.length > 0) {
      events = events.filter((event) => query.categories!.includes(event.category));
    }
    if (query.errorsOnly) {
      events = events.filter((event) => event.category === 'error' || event.level === 'error');
    }
    if (query.after !== undefined) events = events.filter((event) => event.sequence > query.after!);
    if (query.before !== undefined) events = events.filter((event) => event.sequence < query.before!);
    if (query.limit !== undefined) events = events.slice(0, query.limit);
    return {
      events,
      hasMoreBefore: false,
      hasMoreAfter: false,
      nextBefore: events[0]?.sequence,
      nextAfter: events.at(-1)?.sequence,
    };
  }

  // P6.3：FakeStore.getItems 支持 filter 参数，模拟 store 层严格过滤 — Chinese: FakeStore.getItems supports filter param mirroring store-level strict filter
  async getItems(
    threadId: string,
    filter?: {
      runId?: string;
      turnId?: string;
      type?: string;
      limit?: number;
      afterSequence?: number;
      beforeSequence?: number;
    },
  ): Promise<ThreadItem[]> {
    if (threadId !== 'thread-a') return [];
    let result = this.items;
    if (filter?.runId) result = result.filter((i) => (i as { runId?: string }).runId === filter.runId);
    if (filter?.turnId) result = result.filter((i) => i.turnId === filter.turnId);
    if (filter?.type) result = result.filter((i) => i.type === filter.type);
    // cursor 分页基于 array index（模拟 LocalThreadStore 行索引语义）
    if (filter?.afterSequence !== undefined) result = result.filter((_, idx) => idx > filter.afterSequence!);
    if (filter?.beforeSequence !== undefined) result = result.filter((_, idx) => idx < filter.beforeSequence!);
    if (filter?.limit !== undefined) result = result.slice(-filter.limit);
    return result;
  }

  async getTurns(threadId: string): Promise<TurnMeta[]> {
    return threadId === 'thread-a' ? this.turns : [];
  }

  async updateRunRecord(runId: string, patch: Partial<RunRecord>) {
    this.updates.push({ runId, patch });
  }

  async appendRunEvent(event: RunEvent) {
    this.appended.push(event);
  }
}

function request(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): IncomingMessage {
  const stream = new PassThrough();
  const req = stream as unknown as IncomingMessage;
  req.method = method;
  req.url = path;
  req.headers = headers;
  if (body !== undefined) stream.end(JSON.stringify(body));
  else stream.end();
  return req;
}

function response() {
  const chunks: Buffer[] = [];
  const res = new PassThrough() as unknown as ServerResponse & { statusCode: number; headers: Record<string, unknown>; body?: unknown };
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

const tenantContext: TenantContext = { tenantId: 'tenantA' };

describe('run monitor route', () => {
  it('lists current tenant runs with control capabilities', async () => {
    const store = new FakeStore();
    const res = response();

    const handled = await handleRunMonitorRoute({
      req: request('GET', '/api/runs?threadId=thread-a'),
      res,
      url: new URL('http://localhost/api/runs?threadId=thread-a'),
      segments: ['api', 'runs'],
      store: store as unknown as ThreadStore,
      tenantContext,
    });

    expect(handled).toBe(true);
    expect(res.statusCode).toBe(200);
    // RunControlCapabilities 现在为嵌套结构：interrupt/resume/rollback
    // — English: RunControlCapabilities is now nested: interrupt/resume/rollback
    expect(res.body).toEqual({
      runs: store.runs.map((r) => ({
        ...r,
        controlCapabilities: {
          interrupt: { enabled: false, reason: 'run is not active' },
          resume: { enabled: false, reason: 'run is not in a resumable state' },
          rollback: { enabled: true, checkpointIds: [] },
        },
      })),
    });

    const eventsRes = response();
    await handleRunMonitorRoute({
      req: request('GET', '/api/runs/run-a/events'),
      res: eventsRes,
      url: new URL('http://localhost/api/runs/run-a/events'),
      segments: ['api', 'runs', 'run-a', 'events'],
      store: store as unknown as ThreadStore,
      tenantContext,
    });
    expect(eventsRes.body).toEqual({ events: store.events });
  });

  it('returns item-level run trace with cursor and category filters', async () => {
    const store = new FakeStore();
    const res = response();

    await handleRunMonitorRoute({
      req: request('GET', '/api/runs/run-a/trace?after=1&limit=10&category=model&category=error&errorsOnly=false'),
      res,
      url: new URL('http://localhost/api/runs/run-a/trace?after=1&limit=10&category=model&category=error&errorsOnly=false'),
      segments: ['api', 'runs', 'run-a', 'trace'],
      store: store as unknown as ThreadStore,
      tenantContext,
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      runId: 'run-a',
      threadId: 'thread-a',
      page: {
        events: [store.traces[1], store.traces[2]],
        hasMoreBefore: false,
        hasMoreAfter: false,
        nextBefore: 2,
        nextAfter: 3,
      },
    });
  });

  it('returns 404 for trace requests outside the current tenant scope', async () => {
    const res = response();

    await handleRunMonitorRoute({
      req: request('GET', '/api/runs/missing-run/trace'),
      res,
      url: new URL('http://localhost/api/runs/missing-run/trace'),
      segments: ['api', 'runs', 'missing-run', 'trace'],
      store: new FakeStore() as unknown as ThreadStore,
      tenantContext,
    });

    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({ error: 'Run not found' });
  });

  it('lists runs with interrupt.enabled=true when run is active in registry', async () => {
    const store = new FakeStore();
    const registry = new ActiveRunRegistry();
    registry.register({
      runId: 'run-a',
      threadId: 'thread-a',
      turnId: 'turn-a',
      interrupt: () => {},
    });
    const res = response();

    await handleRunMonitorRoute({
      req: request('GET', '/api/runs'),
      res,
      url: new URL('http://localhost/api/runs'),
      segments: ['api', 'runs'],
      store: store as unknown as ThreadStore,
      tenantContext,
      activeRunRegistry: registry,
    });

    // run-a 在 registry 中活跃 → interrupt.enabled=true
    // — English: run-a is active in registry → interrupt.enabled=true
    expect((res.body as { runs: Array<{ controlCapabilities: { interrupt: { enabled: boolean } } }> }).runs[0].controlCapabilities.interrupt.enabled).toBe(true);
  });

  it('rejects threadId in control request body', async () => {
    const store = new FakeStore();
    const res = response();

    await handleRunMonitorRoute({
      req: request('POST', '/api/runs/run-a/control', { action: 'interrupt', threadId: 'thread-a' }),
      res,
      url: new URL('http://localhost/api/runs/run-a/control'),
      segments: ['api', 'runs', 'run-a', 'control'],
      store: store as unknown as ThreadStore,
      tenantContext,
    });

    expect(res.statusCode).toBe(400);
    expect((res.body as { error: string }).error).toContain('threadId');
  });

  it('interrupts via ActiveRunRegistry and records event', async () => {
    const store = new FakeStore();
    const interruptFn = vi.fn(async () => {});
    const registry = new ActiveRunRegistry();
    registry.register({
      runId: 'run-a',
      threadId: 'thread-a',
      turnId: 'turn-a',
      interrupt: interruptFn,
    });
    const onControlRun = vi.fn();
    const res = response();

    await handleRunMonitorRoute({
      req: request('POST', '/api/runs/run-a/control', { action: 'interrupt' }),
      res,
      url: new URL('http://localhost/api/runs/run-a/control'),
      segments: ['api', 'runs', 'run-a', 'control'],
      store: store as unknown as ThreadStore,
      tenantContext,
      activeRunRegistry: registry,
      onControlRun,
    });

    expect(interruptFn).toHaveBeenCalled();
    expect(onControlRun).not.toHaveBeenCalled();
    expect(store.appended).toEqual([
      expect.objectContaining({
        runId: 'run-a',
        category: 'control',
        type: 'control.interrupt',
        tenantId: 'tenantA',
        threadId: 'thread-a',
      }),
    ]);
    expect(res.statusCode).toBe(200);
    // 响应形状为 RunControlResult：targetRunId/controlRunId/threadId/action/accepted
    // — English: response shape is RunControlResult
    expect(res.body).toMatchObject({
      targetRunId: 'run-a',
      controlRunId: expect.any(String),
      threadId: 'thread-a',
      action: 'interrupt',
      accepted: true,
    });
  });

  it('returns 404 for unknown run', async () => {
    const store = new FakeStore();
    const res = response();

    await handleRunMonitorRoute({
      req: request('POST', '/api/runs/nonexistent/control', { action: 'interrupt' }),
      res,
      url: new URL('http://localhost/api/runs/nonexistent/control'),
      segments: ['api', 'runs', 'nonexistent', 'control'],
      store: store as unknown as ThreadStore,
      tenantContext,
    });

    expect(res.statusCode).toBe(404);
  });

  it('returns 409 with reason=RUN_NOT_ACTIVE when run not in registry', async () => {
    const store = new FakeStore();
    const registry = new ActiveRunRegistry();
    const res = response();

    await handleRunMonitorRoute({
      req: request('POST', '/api/runs/run-a/control', { action: 'interrupt' }),
      res,
      url: new URL('http://localhost/api/runs/run-a/control'),
      segments: ['api', 'runs', 'run-a', 'control'],
      store: store as unknown as ThreadStore,
      tenantContext,
      activeRunRegistry: registry,
    });

    // 响应改为 RunControlResult：accepted=false，reason=RUN_NOT_ACTIVE
    // — English: response is now RunControlResult with accepted=false and reason=RUN_NOT_ACTIVE
    expect(res.statusCode).toBe(409);
    expect(res.body).toMatchObject({
      targetRunId: 'run-a',
      threadId: 'thread-a',
      action: 'interrupt',
      accepted: false,
      reason: 'RUN_NOT_ACTIVE',
    });
  });

  it('delegates resume/rollback to onControlRun with threadId from run record', async () => {
    const store = new FakeStore();
    const onControlRun = vi.fn(async () => ({ rolledBack: true }));
    const res = response();

    await handleRunMonitorRoute({
      // rollback 分支必须传 checkpointId（discriminated union 强制要求）
      // — English: rollback branch must carry checkpointId (required by discriminated union)
      req: request('POST', '/api/runs/run-a/control', { action: 'rollback', checkpointId: 'cp-1' }),
      res,
      url: new URL('http://localhost/api/runs/run-a/control'),
      segments: ['api', 'runs', 'run-a', 'control'],
      store: store as unknown as ThreadStore,
      tenantContext,
      onControlRun,
    });

    expect(onControlRun).toHaveBeenCalledWith('rollback', expect.objectContaining({
      runId: 'run-a',
      threadId: 'thread-a',
      checkpointId: 'cp-1',
    }));
    expect(res.statusCode).toBe(200);
    // 响应形状为 RunControlResult
    // — English: response shape is RunControlResult
    expect(res.body).toMatchObject({
      targetRunId: 'run-a',
      threadId: 'thread-a',
      action: 'rollback',
      accepted: true,
    });
  });

  it('records failed rollback control actions as monitor events', async () => {
    const store = new FakeStore();
    const res = response();

    await handleRunMonitorRoute({
      // rollback 必须传 checkpointId；onControlRun 抛出错误模拟失败
      // — English: rollback requires checkpointId; onControlRun throws to simulate failure
      req: request('POST', '/api/runs/run-a/control', { action: 'rollback', checkpointId: 'cp-1' }),
      res,
      url: new URL('http://localhost/api/runs/run-a/control'),
      segments: ['api', 'runs', 'run-a', 'control'],
      store: store as unknown as ThreadStore,
      tenantContext,
      onControlRun: async () => {
        throw new Error('Thread is running');
      },
    });

    expect(res.statusCode).toBe(409);
    expect(store.appended).toEqual([
      expect.objectContaining({
        runId: 'run-a',
        category: 'control',
        type: 'control.rollback',
        level: 'error',
        metadata: expect.objectContaining({ status: 'failed', error: 'Thread is running' }),
      }),
    ]);
    // 响应为 RunControlResult：accepted=false，reason=错误消息
    // — English: response is RunControlResult with accepted=false and reason=error message
    expect(res.body).toMatchObject({
      targetRunId: 'run-a',
      threadId: 'thread-a',
      action: 'rollback',
      accepted: false,
      reason: 'Thread is running',
    });
  });

  it('rejects rollback without checkpointId', async () => {
    const store = new FakeStore();
    const res = response();

    await handleRunMonitorRoute({
      // rollback 缺少 checkpointId → schema 校验失败
      // — English: rollback missing checkpointId → schema validation fails
      req: request('POST', '/api/runs/run-a/control', { action: 'rollback' }),
      res,
      url: new URL('http://localhost/api/runs/run-a/control'),
      segments: ['api', 'runs', 'run-a', 'control'],
      store: store as unknown as ThreadStore,
      tenantContext,
      onControlRun: vi.fn(),
    });

    expect(res.statusCode).toBe(400);
    // Zod schema 错误：checkpointId 字段必填
    // — English: Zod schema error: checkpointId is required
    expect((res.body as { error: string }).error).toContain('checkpointId');
  });

  it('GET /api/runs/:runId/items returns item timeline for the run', async () => {
    const store = new FakeStore();
    const res = response();

    await handleRunMonitorRoute({
      req: request('GET', '/api/runs/run-a/items'),
      res,
      url: new URL('http://localhost/api/runs/run-a/items'),
      segments: ['api', 'runs', 'run-a', 'items'],
      store: store as unknown as ThreadStore,
      tenantContext,
    });

    expect(res.statusCode).toBe(200);
    const body = res.body as { items: ThreadItem[]; runId: string; threadId: string; total: number; nextCursor: string | null };
    expect(body.runId).toBe('run-a');
    expect(body.threadId).toBe('thread-a');
    expect(body.total).toBe(3);
    expect(body.items).toHaveLength(3);
    expect(body.items.map((i) => i.type)).toEqual(['user_message', 'agent_message', 'tool_call']);
    expect(body.nextCursor).toBeNull();
  });

  it('GET /api/runs/:runId/items filters by item type', async () => {
    const store = new FakeStore();
    const res = response();

    await handleRunMonitorRoute({
      req: request('GET', '/api/runs/run-a/items?type=tool_call'),
      res,
      url: new URL('http://localhost/api/runs/run-a/items?type=tool_call'),
      segments: ['api', 'runs', 'run-a', 'items'],
      store: store as unknown as ThreadStore,
      tenantContext,
    });

    expect(res.statusCode).toBe(200);
    const body = res.body as { items: ThreadItem[]; total: number };
    expect(body.total).toBe(1);
    expect(body.items[0].type).toBe('tool_call');
  });

  it('GET /api/runs/:runId/items returns 404 for unknown run', async () => {
    const store = new FakeStore();
    const res = response();

    await handleRunMonitorRoute({
      req: request('GET', '/api/runs/nonexistent/items'),
      res,
      url: new URL('http://localhost/api/runs/nonexistent/items'),
      segments: ['api', 'runs', 'nonexistent', 'items'],
      store: store as unknown as ThreadStore,
      tenantContext,
    });

    expect(res.statusCode).toBe(404);
  });

  it('GET /api/runs/:runId/events supports type filter and cursor', async () => {
    const store = new FakeStore();
    store.events = [
      { eventId: 'e1', runId: 'run-a', tenantId: 'tenantA', threadId: 'thread-a', sequence: 1, category: 'turn', type: 'turn.started', level: 'info', message: 's', metadata: {}, createdAt: '2026-06-16T00:00:00.000Z' },
      { eventId: 'e2', runId: 'run-a', tenantId: 'tenantA', threadId: 'thread-a', sequence: 2, category: 'item', type: 'item.started', level: 'info', message: 'i', metadata: {}, createdAt: '2026-06-16T00:00:01.000Z' },
      { eventId: 'e3', runId: 'run-a', tenantId: 'tenantA', threadId: 'thread-a', sequence: 3, category: 'item', type: 'item.completed', level: 'info', message: 'i', metadata: {}, createdAt: '2026-06-16T00:00:02.000Z' },
    ];
    const res = response();

    await handleRunMonitorRoute({
      req: request('GET', '/api/runs/run-a/events?category=item&after=1'),
      res,
      url: new URL('http://localhost/api/runs/run-a/events?category=item&after=1'),
      segments: ['api', 'runs', 'run-a', 'events'],
      store: store as unknown as ThreadStore,
      tenantContext,
    });

    expect(res.statusCode).toBe(200);
    const body = res.body as { events: RunEvent[] };
    expect(body.events).toHaveLength(2);
    expect(body.events.map((e) => e.type)).toEqual(['item.started', 'item.completed']);
  });

  // P6.3：以下为严格按 runId 关联的新增测试 — Chinese: new tests for strict runId-scoped association
  it('GET /api/runs/:runId/items strictly filters by runId and does not mix different runs', async () => {
    const store = new FakeStore();
    const resA = response();
    await handleRunMonitorRoute({
      req: request('GET', '/api/runs/run-a/items'),
      res: resA,
      url: new URL('http://localhost/api/runs/run-a/items'),
      segments: ['api', 'runs', 'run-a', 'items'],
      store: store as unknown as ThreadStore,
      tenantContext,
    });
    expect(resA.statusCode).toBe(200);
    const bodyA = resA.body as { items: ThreadItem[]; total: number; runId: string };
    expect(bodyA.runId).toBe('run-a');
    expect(bodyA.total).toBe(3);
    expect(bodyA.items.map((i) => i.id)).toEqual(['item-1', 'item-2', 'item-3']);
    // 所有返回的 item 都属于 run-a，不混入 run-b 的 item
    expect(bodyA.items.every((i) => (i as { runId?: string }).runId === 'run-a')).toBe(true);

    const resB = response();
    await handleRunMonitorRoute({
      req: request('GET', '/api/runs/run-b/items'),
      res: resB,
      url: new URL('http://localhost/api/runs/run-b/items'),
      segments: ['api', 'runs', 'run-b', 'items'],
      store: store as unknown as ThreadStore,
      tenantContext,
    });
    expect(resB.statusCode).toBe(200);
    const bodyB = resB.body as { items: ThreadItem[]; total: number; runId: string };
    expect(bodyB.runId).toBe('run-b');
    expect(bodyB.total).toBe(2);
    expect(bodyB.items.map((i) => i.id)).toEqual(['item-4', 'item-5']);
    expect(bodyB.items.every((i) => (i as { runId?: string }).runId === 'run-b')).toBe(true);
  });

  it('GET /api/runs/:runId/items filters by turnId via store filter', async () => {
    const store = new FakeStore();
    const res = response();
    // 通过 type=user_message + runId=run-b 验证 turnId 隐式过滤（run-b 关联 turn-b）
    await handleRunMonitorRoute({
      req: request('GET', '/api/runs/run-b/items?type=user_message'),
      res,
      url: new URL('http://localhost/api/runs/run-b/items?type=user_message'),
      segments: ['api', 'runs', 'run-b', 'items'],
      store: store as unknown as ThreadStore,
      tenantContext,
    });
    expect(res.statusCode).toBe(200);
    const body = res.body as { items: ThreadItem[]; total: number };
    expect(body.total).toBe(1);
    expect(body.items[0].id).toBe('item-4');
    expect(body.items[0].turnId).toBe('turn-b');
  });

  it('GET /api/runs/:runId/items filters by explicit turnId query param', async () => {
    const store = new FakeStore();
    // run-a 关联 turn-a，但 store 中 items 同时包含 turn-a 和 turn-b 的项
    // 显式传 turnId=turn-a 应只返回 turn-a 的 item（共 3 个）
    const res = response();
    await handleRunMonitorRoute({
      req: request('GET', '/api/runs/run-a/items?turnId=turn-a'),
      res,
      url: new URL('http://localhost/api/runs/run-a/items?turnId=turn-a'),
      segments: ['api', 'runs', 'run-a', 'items'],
      store: store as unknown as ThreadStore,
      tenantContext,
    });
    expect(res.statusCode).toBe(200);
    const body = res.body as { items: ThreadItem[]; total: number };
    expect(body.total).toBe(3);
    expect(body.items.every((i) => i.turnId === 'turn-a')).toBe(true);
    expect(body.items.map((i) => i.id)).toEqual(['item-1', 'item-2', 'item-3']);
  });

  it('GET /api/runs/:runId/items supports cursor pagination with after param', async () => {
    const store = new FakeStore();
    // after=0 应该跳过 item-1（array index 0），返回 item-2..item-5，再按 runId=run-a 过滤剩 item-2, item-3
    const res = response();
    await handleRunMonitorRoute({
      req: request('GET', '/api/runs/run-a/items?after=0'),
      res,
      url: new URL('http://localhost/api/runs/run-a/items?after=0'),
      segments: ['api', 'runs', 'run-a', 'items'],
      store: store as unknown as ThreadStore,
      tenantContext,
    });
    expect(res.statusCode).toBe(200);
    const body = res.body as { items: ThreadItem[]; total: number };
    // FakeStore 中 after=0 过滤后剩 item-2..item-5（4 个），再按 runId=run-a 过滤剩 item-2, item-3（2 个）
    expect(body.total).toBe(2);
    expect(body.items.map((i) => i.id)).toEqual(['item-2', 'item-3']);
  });

  it('GET /api/runs/:runId/items supports cursor pagination with before param', async () => {
    const store = new FakeStore();
    // before=3 应该只取 array index < 3 的 item（item-1, item-2, item-3），再按 runId=run-a 过滤仍为 3 个
    const res = response();
    await handleRunMonitorRoute({
      req: request('GET', '/api/runs/run-a/items?before=3'),
      res,
      url: new URL('http://localhost/api/runs/run-a/items?before=3'),
      segments: ['api', 'runs', 'run-a', 'items'],
      store: store as unknown as ThreadStore,
      tenantContext,
    });
    expect(res.statusCode).toBe(200);
    const body = res.body as { items: ThreadItem[]; total: number };
    expect(body.total).toBe(3);
    expect(body.items.map((i) => i.id)).toEqual(['item-1', 'item-2', 'item-3']);
  });

  it('GET /api/runs/:runId/items returns nextCursor when total exceeds limit', async () => {
    const store = new FakeStore();
    const res = response();
    await handleRunMonitorRoute({
      req: request('GET', '/api/runs/run-a/items?limit=2'),
      res,
      url: new URL('http://localhost/api/runs/run-a/items?limit=2'),
      segments: ['api', 'runs', 'run-a', 'items'],
      store: store as unknown as ThreadStore,
      tenantContext,
    });
    expect(res.statusCode).toBe(200);
    const body = res.body as { items: ThreadItem[]; total: number; nextCursor: number | null };
    expect(body.total).toBe(3);
    expect(body.items).toHaveLength(2);
    expect(body.items.map((i) => i.id)).toEqual(['item-2', 'item-3']);
    // total=3 > limit=2，nextCursor 应为 1（total - items.length = 3 - 2）
    expect(body.nextCursor).toBe(1);
  });

  it('GET /api/runs/:runId/turns lists turns associated with the run', async () => {
    const store = new FakeStore();
    const res = response();
    await handleRunMonitorRoute({
      req: request('GET', '/api/runs/run-a/turns'),
      res,
      url: new URL('http://localhost/api/runs/run-a/turns'),
      segments: ['api', 'runs', 'run-a', 'turns'],
      store: store as unknown as ThreadStore,
      tenantContext,
    });
    expect(res.statusCode).toBe(200);
    const body = res.body as { turns: TurnMeta[]; runId: string; threadId: string };
    expect(body.runId).toBe('run-a');
    expect(body.threadId).toBe('thread-a');
    // run-a 关联 turn-a，只返回 turn-a，不混入 turn-b
    expect(body.turns).toHaveLength(1);
    expect(body.turns[0].turnId).toBe('turn-a');
  });

  it('GET /api/runs/:runId/turns returns 404 for unknown run', async () => {
    const store = new FakeStore();
    const res = response();
    await handleRunMonitorRoute({
      req: request('GET', '/api/runs/nonexistent/turns'),
      res,
      url: new URL('http://localhost/api/runs/nonexistent/turns'),
      segments: ['api', 'runs', 'nonexistent', 'turns'],
      store: store as unknown as ThreadStore,
      tenantContext,
    });
    expect(res.statusCode).toBe(404);
  });

  it('GET /api/runs/:runId/turns returns empty for control run with null turnId', async () => {
    const store = new FakeStore();
    // 临时构造一个 turnId 为 null 的 control run
    store.runs = [{
      runId: 'run-control',
      tenantId: 'tenantA',
      threadId: 'thread-a',
      turnId: null,
      kind: 'control',
      status: 'running',
      caller: 'lead_agent',
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      reasoningOutputTokens: 0,
      toolCallCount: 0,
      modelCallCount: 0,
      subagentCount: 0,
      middlewareEventCount: 0,
      startedAt: '2026-06-16T00:00:00.000Z',
      updatedAt: '2026-06-16T00:00:01.000Z',
    }];
    const res = response();
    await handleRunMonitorRoute({
      req: request('GET', '/api/runs/run-control/turns'),
      res,
      url: new URL('http://localhost/api/runs/run-control/turns'),
      segments: ['api', 'runs', 'run-control', 'turns'],
      store: store as unknown as ThreadStore,
      tenantContext,
    });
    expect(res.statusCode).toBe(200);
    const body = res.body as { turns: TurnMeta[] };
    expect(body.turns).toEqual([]);
  });
});
