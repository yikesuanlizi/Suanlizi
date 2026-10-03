import { describe, expect, it } from 'vitest';
import type { RunTraceEnvelope } from '@suanlizi/protocol';
import { traceSummary } from './traceFormatters.js';

describe('traceSummary', () => {
  it('summarizes MCP and skill resources with concrete names', () => {
    const base = {
      version: 2,
      eventId: 'trace-1',
      sequence: 1,
      runId: 'run-1',
      runKind: 'turn',
      threadId: 'thread-1',
      turnId: 'turn-1',
      category: 'tool',
      lifecycle: 'completed',
      level: 'info',
      occurredAt: '2026-07-23T00:00:00.000Z',
    } as const;

    expect(traceSummary({
      ...base,
      name: 'mcp.tool.completed',
      payload: { toolName: 'mcp_call_tool', callId: 'call-1', server: 'example-mcp', tool: 'search_code' },
    } as unknown as RunTraceEnvelope, true)).toBe('MCP · example-mcp / search_code');

    expect(traceSummary({
      ...base,
      name: 'skill.used',
      payload: { toolName: 'skills_add', callId: 'call-2', skillName: 'frontend-design' },
    } as unknown as RunTraceEnvelope, true)).toBe('Skill · frontend-design');
  });

  it('summarizes document file lifecycle events with source and artifact details', () => {
    const base = {
      version: 2,
      eventId: 'trace-file-1',
      sequence: 1,
      runId: 'run-1',
      runKind: 'turn',
      threadId: 'thread-1',
      turnId: 'turn-1',
      category: 'file',
      lifecycle: 'instant',
      level: 'info',
      occurredAt: '2026-07-23T00:00:00.000Z',
    } as const;

    expect(traceSummary({
      ...base,
      name: 'file.extract',
      payload: {
        action: 'extract',
        path: 'E:\\langchain\\dexin-agent\\brief.docx',
        artifactPath: 'E:\\langchain\\dexin-agent\\.suanlizi\\documents\\brief.txt',
        extractor: 'docx-text',
      },
    } as unknown as RunTraceEnvelope, true)).toBe('提取 · brief.docx → brief.txt · docx-text');

    expect(traceSummary({
      ...base,
      name: 'file.stale',
      payload: {
        action: 'stale',
        path: 'E:\\langchain\\dexin-agent\\_v1_decoded.txt',
        sourcePath: 'E:\\langchain\\dexin-agent\\brief.docx',
        staleReason: 'source_hash_changed',
      },
    } as unknown as RunTraceEnvelope, true)).toBe('过期 · brief.docx → _v1_decoded.txt · source_hash_changed');
  });

  it('summarizes approval decisions with access target and agent identity', () => {
    const summary = traceSummary({
      version: 2,
      eventId: 'trace-approval-1',
      sequence: 1,
      runId: 'run-1',
      runKind: 'turn',
      threadId: 'thread-1',
      turnId: 'turn-1',
      spanId: 'span-approval-1',
      category: 'approval',
      name: 'access.decision',
      lifecycle: 'instant',
      level: 'info',
      occurredAt: '2026-07-23T00:00:00.000Z',
      payload: {
        decision: 'prompt',
        source: 'approval_required',
        access: 'read',
        target: { kind: 'path', path: 'E:\\langchain\\outside.txt' },
        toolName: 'read_file',
        agentRole: 'Suanlizi 主控 Agent',
      },
    } as unknown as RunTraceEnvelope, true);

    expect(summary).toBe('请求临时授权 · read · read_file · E:\\langchain\\outside.txt · Suanlizi 主控 Agent · approval_required');
  });
});
