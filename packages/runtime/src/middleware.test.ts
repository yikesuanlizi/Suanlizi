import { describe, expect, it } from 'vitest';
import type { RuntimeMiddleware, RuntimeModelRequest, RuntimeToolRequest, RuntimeTurnContext } from './middleware.js';
import { composeRuntimeMiddleware, createDynamicContextMiddleware, createStabilityMiddleware } from './middleware.js';

function runtimeContext(overrides: Partial<RuntimeTurnContext> = {}): RuntimeTurnContext {
  return {
    tenantId: 'default',
    threadId: 'thread-middleware',
    turnId: 'turn-middleware',
    thread: {
      threadId: 'thread-middleware',
      title: 'middleware',
      workspaceRoot: process.cwd(),
      status: 'active',
      turnCount: 1,
      createdAt: '2026-06-10T00:00:00.000Z',
      updatedAt: '2026-06-10T00:00:00.000Z',
      archivedAt: null,
      ephemeral: false,
      tags: {},
    },
    userInput: { type: 'text', text: 'hello' },
    workspaceRoot: process.cwd(),
    locale: 'zh',
    webSearchMode: 'auto',
    runtimeState: { threadId: 'thread-middleware', status: 'idle', resumable: false, stale: false, checkpoint: null },
    checkpoint: {
      threadId: 'thread-middleware',
      turnId: 'turn-middleware',
      itemIndex: 0,
      timestamp: '2026-06-10T00:00:00.000Z',
    },
    collectedItems: [],
    store: {
      listThreadSpawnDescendants: async () => [],
      getRecentItems: async () => [],
    } as never,
    stateManager: {} as never,
    emit: () => {},
    permissions: { level: 'workspace_write', networkAllowed: true },
    maxSubagents: 4,
    ...overrides,
  };
}

function toolRequest(toolName: string, args: Record<string, unknown> = {}): RuntimeToolRequest {
  return {
    toolCall: {
      id: `call_${toolName}`,
      type: 'function',
      function: { name: toolName, arguments: JSON.stringify(args) },
    },
    requestedToolName: toolName,
    toolName,
    args,
    toolContext: {
      threadId: 'thread-middleware',
      turnId: 'turn-middleware',
      workspaceRoot: process.cwd(),
      approved: false,
    },
  };
}

describe('composeRuntimeMiddleware', () => {
  it('passes beforeModel request changes through each middleware in registration order', async () => {
    const order: string[] = [];
    const request: RuntimeModelRequest = { messages: [{ role: 'system', content: 'base' }] };
    const middleware: RuntimeMiddleware[] = [
      {
        beforeModel: (_ctx, current) => {
          order.push(`first sees ${current.messages.length}`);
          return { ...current, messages: [...current.messages, { role: 'user', content: 'first' }] };
        },
      },
      {
        beforeModel: (_ctx, current) => {
          order.push(`second sees ${current.messages.length}`);
          return { ...current, messages: [...current.messages, { role: 'user', content: 'second' }] };
        },
      },
    ];

    const next = await composeRuntimeMiddleware(middleware).beforeModel(runtimeContext(), request);

    expect(order).toEqual(['first sees 1', 'second sees 2']);
    expect(next.messages.map((message) => message.content)).toEqual(['base', 'first', 'second']);
  });

  it('wraps model and tool calls with earlier middleware on the outside', async () => {
    const order: string[] = [];
    const middleware: RuntimeMiddleware[] = [
      {
        wrapModel: async (_ctx, request, next) => {
          order.push('model first before');
          const response = await next(request);
          order.push('model first after');
          return response;
        },
        wrapTool: async (_ctx, request, next) => {
          order.push('tool first before');
          const response = await next(request);
          order.push('tool first after');
          return response;
        },
      },
      {
        wrapModel: async (_ctx, request, next) => {
          order.push('model second before');
          const response = await next(request);
          order.push('model second after');
          return response;
        },
        wrapTool: async (_ctx, request, next) => {
          order.push('tool second before');
          const response = await next(request);
          order.push('tool second after');
          return response;
        },
      },
    ];
    const composed = composeRuntimeMiddleware(middleware);

    await composed.wrapModel(runtimeContext(), { messages: [] }, async () => {
      order.push('model core');
      return { message: { role: 'assistant', content: 'ok' }, usage: null };
    });
    await composed.wrapTool(runtimeContext(), toolRequest('current_time'), async () => {
      order.push('tool core');
      return { output: 'ok', status: 'completed' };
    });

    expect(order).toEqual([
      'model first before',
      'model second before',
      'model core',
      'model second after',
      'model first after',
      'tool first before',
      'tool second before',
      'tool core',
      'tool second after',
      'tool first after',
    ]);
  });

  it('stops beforeTool at the first short-circuit response', async () => {
    const order: string[] = [];
    const composed = composeRuntimeMiddleware([
      {
        beforeTool: () => {
          order.push('first');
          return { output: 'blocked', status: 'failed' };
        },
      },
      {
        beforeTool: () => {
          order.push('second');
        },
      },
    ]);

    const response = await composed.beforeTool(runtimeContext(), toolRequest('current_time'));

    expect(response).toMatchObject({ output: 'blocked', status: 'failed' });
    expect(order).toEqual(['first']);
  });
});

describe('createDynamicContextMiddleware', () => {
  it('merges dynamic context into the first system message for llama.cpp-compatible templates', async () => {
    const middleware = createDynamicContextMiddleware();
    const ctx = runtimeContext({ turnId: 'turn-dynamic-system' });
    await middleware.beforeTurn?.(ctx);

    const request: RuntimeModelRequest = {
      messages: [
        { role: 'system', content: 'base instructions' },
        { role: 'user', content: 'hello' },
      ],
    };
    await middleware.beforeModel?.(ctx, request);

    expect(request.messages[0]?.role).toBe('system');
    expect(request.messages.filter((message) => message.role === 'system')).toHaveLength(1);
    expect(String(request.messages[0]?.content)).toContain('base instructions');
    expect(String(request.messages[0]?.content)).toContain('<dynamic_context>');
    expect(request.messages[1]).toMatchObject({ role: 'user', content: 'hello' });
  });

  it('moves dynamic context to index zero when a request has no system message', async () => {
    const middleware = createDynamicContextMiddleware();
    const ctx = runtimeContext({ turnId: 'turn-dynamic-system-no-base' });
    await middleware.beforeTurn?.(ctx);

    const request: RuntimeModelRequest = { messages: [{ role: 'user', content: 'hello' }] };
    await middleware.beforeModel?.(ctx, request);

    expect(request.messages[0]?.role).toBe('system');
    expect(request.messages.filter((message) => message.role === 'system')).toHaveLength(1);
    expect(request.messages[1]).toMatchObject({ role: 'user', content: 'hello' });
  });
});

describe('createStabilityMiddleware', () => {
  it('normalizes repeated web_search queries and resets web budget after the turn', async () => {
    const middleware = createStabilityMiddleware({
      maxRepeatedToolCalls: 10,
      maxConsecutiveToolErrors: 10,
      maxWebSearchCallsPerTurn: 10,
      maxDuplicateWebSearchQueryPerTurn: 1,
    });
    const ctx = runtimeContext({ turnId: 'turn-web-budget' });

    expect(await middleware.beforeTool?.(ctx, toolRequest('web_search', { action: 'open_page', url: 'https://example.com' }))).toBeUndefined();
    expect(await middleware.beforeTool?.(ctx, toolRequest('web_search', { query: ' Suanlizi   Runtime ' }))).toBeUndefined();
    expect(await middleware.beforeTool?.(ctx, toolRequest('web_search', { query: 'suanlizi runtime' }))).toMatchObject({
      status: 'failed',
      error: { code: 'WEB_SEARCH_LIMIT_REACHED' },
      disableWebSearch: true,
    });
    await middleware.afterTurn?.(ctx, { status: 'completed', usage: null });

    expect(await middleware.beforeTool?.(runtimeContext({ turnId: 'turn-web-budget-next' }), toolRequest('web_search', { query: 'suanlizi runtime' }))).toBeUndefined();
  });

  it('allows closed child edges and rejects only open subagent descendants at the limit', async () => {
    const middleware = createStabilityMiddleware({
      maxRepeatedToolCalls: 10,
      maxConsecutiveToolErrors: 10,
      maxWebSearchCallsPerTurn: 10,
      maxDuplicateWebSearchQueryPerTurn: 10,
    });

    const closedOnly = runtimeContext({
      maxSubagents: 1,
      store: {
        listThreadSpawnDescendants: async (_threadId: string, status?: string) => (
          status === 'open' ? [] : [{ parentThreadId: 'thread-middleware', childThreadId: 'closed-child', status: 'closed' }]
        ),
      } as never,
    });
    const atLimit = runtimeContext({
      maxSubagents: 1,
      store: {
        listThreadSpawnDescendants: async () => [
          { parentThreadId: 'thread-middleware', childThreadId: 'open-child', status: 'open' },
        ],
      } as never,
    });

    expect(await middleware.beforeTool?.(closedOnly, toolRequest('spawn_agent', { prompt: 'work' }))).toBeUndefined();
    expect(await middleware.beforeTool?.(atLimit, toolRequest('spawn_agent', { prompt: 'work' }))).toMatchObject({
      status: 'failed',
      error: { code: 'SUBAGENT_LIMIT_REACHED' },
    });
  });
});
