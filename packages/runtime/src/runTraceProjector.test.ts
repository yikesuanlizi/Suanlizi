import { describe, expect, it } from 'vitest';
import type { RunTraceEnvelope } from '@suanlizi/protocol';
import { RUN_TRACE_VERSION } from '@suanlizi/protocol';
import { projectRunTrace } from './runTraceProjector.js';

function event(overrides: Partial<RunTraceEnvelope>): RunTraceEnvelope {
  return {
    version: RUN_TRACE_VERSION,
    eventId: overrides.eventId ?? `event-${overrides.sequence ?? 1}`,
    sequence: overrides.sequence ?? 1,
    runId: 'run-a',
    runKind: 'turn',
    threadId: 'thread-a',
    turnId: 'turn-a',
    spanId: overrides.spanId ?? `span-${overrides.sequence ?? 1}`,
    category: 'turn',
    name: 'turn',
    lifecycle: 'started',
    level: 'info',
    occurredAt: '2026-07-21T00:00:00.000Z',
    payload: { status: 'running' },
    ...overrides,
  } as RunTraceEnvelope;
}

describe('projectRunTrace', () => {
  it('deterministically projects usage, tools, items, files, checkpoints, and errors', () => {
    const summary = projectRunTrace([
      event({ sequence: 6, category: 'error', lifecycle: 'instant', level: 'error', payload: { code: 'MODEL_FAIL', message: 'boom', retryable: false } }),
      event({ sequence: 1, lifecycle: 'started', occurredAt: '2026-07-21T00:00:00.000Z' }),
      event({ sequence: 3, category: 'tool', lifecycle: 'failed', durationMs: 10, payload: { toolName: 'shell', callId: 'call-1', exitCode: 1 } }),
      event({ sequence: 2, category: 'model', lifecycle: 'completed', durationMs: 20, payload: { provider: 'openai', model: 'gpt-5', attempt: 1, streaming: true, ttftMs: 7, inputTokens: 10, outputTokens: 20, cacheReadTokens: 3, cacheWriteTokens: 4 } }),
      event({ sequence: 4, category: 'item', itemId: 'item-1', lifecycle: 'completed', payload: { itemType: 'tool_call', status: 'failed' } }),
      event({ sequence: 5, category: 'file', lifecycle: 'completed', payload: { action: 'patch', path: 'src/a.ts', addedLines: 2, removedLines: 1 } }),
      event({ sequence: 7, category: 'checkpoint', lifecycle: 'completed', payload: { checkpointId: 'ck-1', turnCount: 1, itemIndex: 4, status: 'completed' } }),
      event({ sequence: 8, lifecycle: 'completed', occurredAt: '2026-07-21T00:00:05.000Z', durationMs: 5000, payload: { status: 'completed' } }),
    ]);

    expect(summary).toMatchObject({
      status: 'completed',
      startedAt: '2026-07-21T00:00:00.000Z',
      completedAt: '2026-07-21T00:00:05.000Z',
      durationMs: 5000,
      model: { calls: 1, inputTokens: 10, outputTokens: 20, cacheReadTokens: 3, cacheWriteTokens: 4, maxTtftMs: 7 },
      tools: { calls: 1, failed: 1, denied: 0 },
      items: { completed: 1, failed: 1, byType: { tool_call: 1 } },
      files: { changed: 1, addedLines: 2, removedLines: 1 },
      lastError: { code: 'MODEL_FAIL', message: 'boom' },
      lastCheckpointId: 'ck-1',
    });
  });

  it('deduplicates by eventId before counting', () => {
    const duplicate = event({ eventId: 'same', sequence: 1, category: 'tool', payload: { toolName: 'shell', callId: 'call-1' } });

    expect(projectRunTrace([duplicate, { ...duplicate, sequence: 2 }]).tools.calls).toBe(1);
  });

  it('counts document file lifecycle events separately from changed files', () => {
    const summary = projectRunTrace([
      event({ sequence: 1, category: 'file', name: 'document extracted', lifecycle: 'completed', payload: { action: 'extract', path: 'a.docx' } }),
      event({ sequence: 2, category: 'file', name: 'artifact stale', lifecycle: 'instant', payload: { action: 'stale', path: '.suanlizi/artifacts/documents/a.md', sourcePath: 'a.docx' } }),
      event({ sequence: 3, category: 'file', name: 'document refreshed', lifecycle: 'completed', payload: { action: 'refresh', path: 'a.docx' } }),
    ]);

    expect(summary.files).toMatchObject({
      reads: 0,
      changed: 0,
      extracted: 1,
      stale: 1,
      refreshed: 1,
    });
  });

  it('projects provider adapter diagnostics on model events', () => {
    const summary = projectRunTrace([
      event({
        sequence: 1,
        category: 'model',
        name: 'model.started',
        lifecycle: 'started',
        payload: {
          provider: 'minimax',
          providerId: 'minimax',
          model: 'MiniMax-M3',
          endpointFormat: 'anthropic_messages',
          transport: 'anthropic_messages',
          reasoningMode: 'minimax_anthropic_thinking',
          toolHistoryMode: 'anthropic_blocks',
          attempt: 1,
          streaming: true,
        },
      }),
      event({
        sequence: 2,
        category: 'model',
        name: 'model.completed',
        lifecycle: 'completed',
        payload: {
          provider: 'minimax',
          providerId: 'minimax',
          model: 'MiniMax-M3',
          endpointFormat: 'anthropic_messages',
          transport: 'anthropic_messages',
          reasoningMode: 'minimax_anthropic_thinking',
          toolHistoryMode: 'anthropic_blocks',
          attempt: 1,
          streaming: true,
          inputTokens: 10,
          outputTokens: 3,
        },
      }),
    ]);

    expect(summary.model).toMatchObject({
      calls: 1,
      providerId: 'minimax',
      model: 'MiniMax-M3',
      endpointFormat: 'anthropic_messages',
      transport: 'anthropic_messages',
      reasoningMode: 'minimax_anthropic_thinking',
      toolHistoryMode: 'anthropic_blocks',
    });
  });

  it('projects access policy approvals separately from ordinary tool calls', () => {
    const summary = projectRunTrace([
      event({
        sequence: 1,
        category: 'approval',
        name: 'access.decision',
        lifecycle: 'instant',
        payload: {
          decision: 'prompt',
          source: 'approval_required',
          access: 'read',
          target: { kind: 'path', path: 'E:\\langchain\\outside.txt' },
          toolName: 'read_file',
          agentThreadId: 'thread-a',
          agentRole: 'Suanlizi 主控 Agent',
        },
      }),
      event({
        sequence: 2,
        category: 'approval',
        name: 'approval.required',
        lifecycle: 'instant',
        payload: {
          requestId: 'approval-1',
          status: 'required',
          access: 'read',
          target: { kind: 'path', path: 'E:\\langchain\\outside.txt' },
          toolName: 'read_file',
        },
      }),
      event({
        sequence: 3,
        category: 'approval',
        name: 'access.temporary_grant',
        lifecycle: 'instant',
        payload: {
          requestId: 'approval-1',
          status: 'granted',
          scope: 'turn',
          grantId: 'temp-1',
          access: 'read',
          target: { kind: 'path', path: 'E:\\langchain\\outside.txt' },
          toolName: 'read_file',
        },
      }),
    ]);

    expect(summary.approvals).toEqual({
      decisions: 1,
      prompts: 1,
      allowed: 1,
      denied: 0,
    });
    expect(summary.tools.calls).toBe(0);
  });
});
