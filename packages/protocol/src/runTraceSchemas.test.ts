// RunTrace Zod schema 独立测试：每个 category 的 strict payload、判别联合、派生 schema
// — English: RunTrace Zod schema tests — strict payloads per category, discriminated union, derived schemas
import { describe, expect, it } from 'vitest';
import { RUN_TRACE_VERSION } from './runTrace.js';
import {
  runTraceEnvelopeSchema,
  runTraceEnvelopeSchemasByCategory,
  runTracePayloadSchemaMap,
  runTraceDraftSchema,
  runTraceObservationSchema,
  runTracePageSchema,
  runTraceSummarySchema,
  runTraceStatusSchema,
  runTraceCategorySchema,
  runTraceRunKindSchema,
  runTraceLifecycleSchema,
  runTraceLevelSchema,
} from './runTraceSchemas.js';

// 构造一个完整的 turn envelope，便于复用
// — English: build a valid turn envelope for reuse
function makeTurnEnvelope(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: RUN_TRACE_VERSION,
    eventId: 'evt-turn-1',
    sequence: 1,
    runId: 'run-1',
    runKind: 'turn',
    threadId: 'thread-1',
    turnId: 'turn-1',
    spanId: 'span-turn-1',
    category: 'turn',
    name: 'turn.started',
    lifecycle: 'started',
    level: 'info',
    occurredAt: '2026-07-20T00:00:00.000Z',
    payload: { status: 'running', inputItemCount: 3 },
    ...overrides,
  };
}

describe('RunTrace schema — 基础枚举', () => {
  it('runTraceCategorySchema 包含全部 16 个 category', () => {
    const categories = runTraceCategorySchema.options;
    expect(categories).toEqual([
      'turn', 'iteration', 'context', 'memory', 'middleware',
      'model', 'tool', 'item', 'agent', 'file',
      'checkpoint', 'evidence', 'approval', 'error', 'control', 'browser',
    ]);
  });

  it('runTraceRunKindSchema 包含 4 个 runKind', () => {
    expect(runTraceRunKindSchema.options).toEqual(['turn', 'control', 'workflow', 'subagent']);
  });

  it('runTraceLifecycleSchema 包含 5 个 lifecycle', () => {
    expect(runTraceLifecycleSchema.options).toEqual(['instant', 'started', 'completed', 'failed', 'discarded']);
  });

  it('runTraceLevelSchema 包含 4 个 level', () => {
    expect(runTraceLevelSchema.options).toEqual(['debug', 'info', 'warning', 'error']);
  });

  it('runTraceStatusSchema 包含 6 个 status', () => {
    expect(runTraceStatusSchema.options).toEqual(['pending', 'running', 'completed', 'failed', 'interrupted', 'blocked']);
  });
});

describe('RunTrace schema — payload strict 校验', () => {
  it('runTracePayloadSchemaMap 包含 16 个 payload schema', () => {
    const keys = Object.keys(runTracePayloadSchemaMap);
    expect(keys).toHaveLength(16);
    expect(keys.sort()).toEqual([
      'agent', 'approval', 'browser', 'checkpoint', 'context', 'control', 'error', 'evidence',
      'file', 'item', 'iteration', 'memory', 'middleware', 'model',
      'tool', 'turn',
    ]);
  });

  it('model payload 多了未知字段会被拒绝', () => {
    const result = runTracePayloadSchemaMap.model.safeParse({
      provider: 'openai',
      model: 'gpt-4o',
      attempt: 1,
      streaming: true,
      bogus: 'unknown',
    });
    expect(result.success).toBe(false);
  });

  it('tool payload 多了未知字段会被拒绝', () => {
    const result = runTracePayloadSchemaMap.tool.safeParse({
      toolName: 'search',
      callId: 'call-1',
      unexpected: true,
    });
    expect(result.success).toBe(false);
  });

  it('tool payload 接受结构化资源身份字段', () => {
    const result = runTracePayloadSchemaMap.tool.safeParse({
      toolName: 'mcp_call_tool',
      callId: 'call-1',
      resourceKind: 'mcp',
      server: 'example-mcp',
      tool: 'search_code',
    });
    expect(result.success).toBe(true);
  });

  it('approval payload 接受访问策略决策字段并拒绝未知字段', () => {
    const accepted = runTracePayloadSchemaMap.approval.safeParse({
      decision: 'prompt',
      source: 'approval_required',
      requestId: 'approval-1',
      status: 'required',
      access: 'read',
      target: { kind: 'path', path: 'E:\\langchain\\outside.txt' },
      toolName: 'read_file',
      agentThreadId: 'thread-1',
      agentRole: 'Suanlizi 主控 Agent',
    });
    const rejected = runTracePayloadSchemaMap.approval.safeParse({
      decision: 'prompt',
      unknownField: true,
    });

    expect(accepted.success).toBe(true);
    expect(rejected.success).toBe(false);
  });

  it('context payload 缺 sourceCounts 会被拒绝', () => {
    const result = runTracePayloadSchemaMap.context.safeParse({
      phase: 'assembled',
      // sourceCounts 缺失
      omittedContent: true,
    });
    expect(result.success).toBe(false);
  });

  it('memory payload 缺 omittedContent 会被拒绝', () => {
    const result = runTracePayloadSchemaMap.memory.safeParse({
      phase: 'search',
      recordCount: 3,
      // omittedContent 缺失
    });
    expect(result.success).toBe(false);
  });

  it('checkpoint payload status 必须是合法 CheckpointStatus', () => {
    const ok = runTracePayloadSchemaMap.checkpoint.safeParse({
      checkpointId: 'cp-1',
      turnCount: 1,
      itemIndex: 0,
      status: 'completed',
    });
    expect(ok.success).toBe(true);
    const bad = runTracePayloadSchemaMap.checkpoint.safeParse({
      checkpointId: 'cp-1',
      turnCount: 1,
      itemIndex: 0,
      status: 'invalid_status',
    });
    expect(bad.success).toBe(false);
  });

  it('control payload outcome 必须是 4 个合法值之一', () => {
    for (const outcome of ['requested', 'accepted', 'rejected', 'completed']) {
      const result = runTracePayloadSchemaMap.control.safeParse({
        action: 'interrupt',
        outcome,
      });
      expect(result.success).toBe(true);
    }
    const bad = runTracePayloadSchemaMap.control.safeParse({
      action: 'interrupt',
      outcome: 'unknown',
    });
    expect(bad.success).toBe(false);
  });

  it('item payload itemType 必须是 16 个 ThreadItem type 之一', () => {
    const valid = runTracePayloadSchemaMap.item.safeParse({ itemType: 'user_message' });
    expect(valid.success).toBe(true);
    const invalid = runTracePayloadSchemaMap.item.safeParse({ itemType: 'unknown_type' });
    expect(invalid.success).toBe(false);
  });

  it('agent payload action 必须是 5 个合法值之一', () => {
    for (const action of ['spawn', 'started', 'joined', 'failed', 'interrupted']) {
      const result = runTracePayloadSchemaMap.agent.safeParse({
        agentThreadId: 'thread-2',
        role: 'sub',
        action,
      });
      expect(result.success).toBe(true);
    }
    const bad = runTracePayloadSchemaMap.agent.safeParse({
      agentThreadId: 'thread-2',
      role: 'sub',
      action: 'paused',
    });
    expect(bad.success).toBe(false);
  });

  it('file payload action 必须是合法值之一', () => {
    for (const action of ['read', 'write', 'patch', 'delete', 'checkpoint', 'extract', 'stale', 'refresh', 'reuse']) {
      const result = runTracePayloadSchemaMap.file.safeParse({
        action,
        path: '/tmp/x',
      });
      expect(result.success).toBe(true);
    }
    const bad = runTracePayloadSchemaMap.file.safeParse({ action: 'append', path: '/tmp/x' });
    expect(bad.success).toBe(false);
  });

  it('accepts document lifecycle file trace payloads', () => {
    const parsed = runTraceEnvelopeSchema.parse({
      version: 2,
      eventId: 'event-1',
      sequence: 1,
      runId: 'run-1',
      runKind: 'turn',
      threadId: 'thread-1',
      turnId: 'turn-1',
      spanId: 'span-1',
      category: 'file',
      name: 'document refreshed',
      lifecycle: 'completed',
      level: 'info',
      occurredAt: '2026-07-23T08:00:00.000Z',
      payload: {
        action: 'refresh',
        path: 'docs/a.docx',
        sourcePath: 'docs/a.docx',
        artifactPath: '.suanlizi/artifacts/documents/abc.md',
        sha256: 'a'.repeat(64),
        artifactSha256: 'b'.repeat(64),
        staleReason: 'source_hash_changed',
        contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        extractor: 'docx-text',
      },
    });

    expect((parsed.payload as { action: string }).action).toBe('refresh');
  });
});

describe('RunTrace schema — envelope strict 校验', () => {
  it('envelope 顶层多了未知字段会被拒绝', () => {
    const event = makeTurnEnvelope({ surprise: true });
    expect(() => runTraceEnvelopeSchema.parse(event)).toThrow();
  });

  it('合法 turn envelope 通过 schema', () => {
    const event = makeTurnEnvelope();
    expect(() => runTraceEnvelopeSchema.parse(event)).not.toThrow();
  });

  it('runTraceEnvelopeSchemasByCategory.turn 与 runTraceEnvelopeSchema 行为一致', () => {
    const event = makeTurnEnvelope();
    expect(runTraceEnvelopeSchemasByCategory.turn.parse(event)).toEqual(event);
  });

  it('每个 category 的 envelope schema 都拒绝未知字段', () => {
    const categories = Object.keys(runTraceEnvelopeSchemasByCategory) as Array<keyof typeof runTraceEnvelopeSchemasByCategory>;
    for (const category of categories) {
      const schema = runTraceEnvelopeSchemasByCategory[category];
      // 任何 category 的 envelope 都不允许多余字段
      const badEvent = { ...makeTurnEnvelope({ category, payload: undefined }), surprise: true };
      expect(() => schema.parse(badEvent)).toThrow();
    }
  });
});

describe('RunTrace schema — discriminated union 判别', () => {
  it('不合法的 category 会被拒绝', () => {
    const event = makeTurnEnvelope({ category: 'invalid_category' });
    expect(() => runTraceEnvelopeSchema.parse(event)).toThrow();
  });

  it('category=model 时 payload 必须匹配 model schema', () => {
    const event = makeTurnEnvelope({
      category: 'model',
      name: 'model.call',
      payload: { provider: 'openai', model: 'gpt-4o', attempt: 1, streaming: true },
    });
    expect(() => runTraceEnvelopeSchema.parse(event)).not.toThrow();
  });

  it('category=model 时 payload 是 tool 形状会被拒绝', () => {
    const event = makeTurnEnvelope({
      category: 'model',
      name: 'model.bad',
      payload: { toolName: 'search', callId: 'call-1' },
    });
    expect(() => runTraceEnvelopeSchema.parse(event)).toThrow();
  });
});

describe('RunTrace schema — 派生 schema', () => {
  it('runTraceDraftSchema 接受无 storage identity 的 envelope', () => {
    const draft = {
      runId: 'run-1',
      runKind: 'turn',
      threadId: 'thread-1',
      turnId: 'turn-1',
      spanId: 'span-1',
      category: 'turn',
      name: 'turn.started',
      lifecycle: 'started',
      level: 'info',
      occurredAt: '2026-07-20T00:00:00.000Z',
      payload: { status: 'running' },
    };
    expect(() => runTraceDraftSchema.parse(draft)).not.toThrow();
  });

  it('runTraceDraftSchema 拒绝包含 eventId 的事件', () => {
    const draft = {
      version: RUN_TRACE_VERSION,
      eventId: 'evt-1',
      sequence: 1,
      runId: 'run-1',
      runKind: 'turn' as const,
      threadId: 'thread-1',
      turnId: 'turn-1',
      spanId: 'span-1',
      category: 'turn' as const,
      name: 'turn.started',
      lifecycle: 'started' as const,
      level: 'info' as const,
      occurredAt: '2026-07-20T00:00:00.000Z',
      payload: { status: 'running' },
    };
    expect(() => runTraceDraftSchema.parse(draft)).toThrow();
  });

  it('runTraceObservationSchema 接受无 run context 的事件', () => {
    // observation 保留 runKind（不属于 run context），仅去掉 runId/parentRunId/threadId/turnId
    // — English: observation keeps runKind (not part of run context); only runId/parentRunId/threadId/turnId are removed
    const observation = {
      runKind: 'turn',
      spanId: 'span-1',
      category: 'model',
      name: 'model.call',
      lifecycle: 'completed',
      level: 'info',
      occurredAt: '2026-07-20T00:00:00.000Z',
      durationMs: 100,
      payload: { provider: 'openai', model: 'gpt-4o', attempt: 1, streaming: true },
    };
    expect(() => runTraceObservationSchema.parse(observation)).not.toThrow();
  });
});

describe('RunTrace schema — RunTracePage', () => {
  it('runTracePageSchema 接受合法 page', () => {
    const page = {
      events: [makeTurnEnvelope() as never],
      hasMoreBefore: false,
      hasMoreAfter: true,
      nextAfter: 100,
    };
    expect(() => runTracePageSchema.parse(page)).not.toThrow();
  });

  it('runTracePageSchema 拒绝缺 hasMoreBefore 的 page', () => {
    const page = {
      events: [],
      hasMoreAfter: false,
    };
    expect(() => runTracePageSchema.parse(page)).toThrow();
  });

  it('runTracePageSchema 拒绝未知字段', () => {
    const page = {
      events: [],
      hasMoreBefore: false,
      hasMoreAfter: false,
      unknownField: true,
    };
    expect(() => runTracePageSchema.parse(page)).toThrow();
  });
});

describe('RunTrace schema — RunTraceSummary', () => {
  it('runTraceSummarySchema 接受合法 summary', () => {
    const summary = {
      status: 'running',
      model: { calls: 1, inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0 },
      tools: { calls: 2, failed: 0, denied: 0 },
      items: { started: 5, completed: 4, failed: 1, byType: { user_message: 3, tool_call: 2 } },
      agents: { spawned: 0, running: 0, failed: 0 },
      files: { reads: 0, changed: 0, addedLines: 0, removedLines: 0, extracted: 0, reused: 0, stale: 0, refreshed: 0 },
    };
    expect(() => runTraceSummarySchema.parse(summary)).not.toThrow();
  });

  it('runTraceSummarySchema 接受带 lastError 的 summary', () => {
    const summary = {
      status: 'failed',
      model: { calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      tools: { calls: 0, failed: 0, denied: 0 },
      items: { started: 0, completed: 0, failed: 0, byType: {} },
      agents: { spawned: 0, running: 0, failed: 0 },
      files: { reads: 0, changed: 0, addedLines: 0, removedLines: 0, extracted: 0, reused: 0, stale: 0, refreshed: 0 },
      lastError: { code: 'INTERNAL', message: 'oops' },
    };
    expect(() => runTraceSummarySchema.parse(summary)).not.toThrow();
  });

  it('runTraceSummarySchema 拒绝未知字段', () => {
    const summary = {
      status: 'running',
      model: { calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      tools: { calls: 0, failed: 0, denied: 0 },
      items: { started: 0, completed: 0, failed: 0, byType: {} },
      agents: { spawned: 0, running: 0, failed: 0 },
      files: { reads: 0, changed: 0, addedLines: 0, removedLines: 0, extracted: 0, reused: 0, stale: 0, refreshed: 0 },
      bogus: true,
    };
    expect(() => runTraceSummarySchema.parse(summary)).toThrow();
  });
});
