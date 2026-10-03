import { describe, expect, it } from 'vitest';
import { buildAgentWorkbench } from './agentWorkbenchModel.js';
import type { RunTraceEnvelope, RunTraceSummary } from '@suanlizi/protocol';
import type { ThreadChildInfo, ThreadItem } from '../../shared/types.js';

function makeThreadChild(overrides: Partial<ThreadChildInfo> = {}): ThreadChildInfo {
  return {
    thread: {
      threadId: 'child-1',
      title: 'Child Agent',
      status: 'idle',
      turnCount: 0,
      createdAt: '2025-01-01T00:00:00Z',
      updatedAt: '2025-01-01T00:01:00Z',
      agentRole: 'Researcher',
    },
    edge: {
      parentThreadId: 'main',
      childThreadId: 'child-1',
      status: 'open',
      createdAt: '2025-01-01T00:00:00Z',
      updatedAt: '2025-01-01T00:01:00Z',
    },
    state: {
      threadId: 'child-1',
      status: 'idle',
      checkpoint: null,
      resumable: false,
      stale: false,
    },
    latestTurn: null,
    latestCollabItem: null,
    items: [],
    ...overrides,
  } as ThreadChildInfo;
}

describe('buildAgentWorkbench', () => {
  it('无 child 时返回 [rootNode]', () => {
    const result = buildAgentWorkbench({
      mainThreadId: 'main',
      threadChildren: [],
      runtimeItems: [],
      busy: false,
      now: new Date('2025-01-01T00:02:00Z').getTime(),
      zh: false,
    });

    expect(result.rootNode).not.toBeNull();
    expect(result.rootNode!.threadId).toBe('main');
    expect(result.rootNode!.depth).toBe(0);
    expect(result.rootNode!.children).toHaveLength(0);
    expect(result.nodes).toHaveLength(1);
    expect(result.nodes[0].threadId).toBe('main');
  });

  it('child 深度和排序正确', () => {
    const child1 = makeThreadChild({
      thread: { threadId: 'depth-1', title: 'Depth 1', agentRole: 'Worker', status: 'idle', turnCount: 1, createdAt: '2025-01-01T00:00:00Z', updatedAt: '2025-01-01T00:01:00Z' },
      edge: { parentThreadId: 'main', childThreadId: 'depth-1', status: 'open', createdAt: '2025-01-01T00:00:00Z', updatedAt: '2025-01-01T00:01:00Z' },
      state: { threadId: 'depth-1', status: 'running', checkpoint: null, resumable: false, stale: false },
    });
    const child2 = makeThreadChild({
      thread: { threadId: 'depth-2', title: 'Depth 2', agentRole: 'Sub-worker', status: 'idle', turnCount: 0, createdAt: '2025-01-01T00:00:00Z', updatedAt: '2025-01-01T00:01:00Z' },
      edge: { parentThreadId: 'depth-1', childThreadId: 'depth-2', status: 'open', createdAt: '2025-01-01T00:00:00Z', updatedAt: '2025-01-01T00:01:00Z' },
      state: { threadId: 'depth-2', status: 'idle', checkpoint: null, resumable: false, stale: false },
    });

    const result = buildAgentWorkbench({
      mainThreadId: 'main',
      threadChildren: [child2, child1],
      runtimeItems: [],
      busy: true,
      now: new Date('2025-01-01T00:02:00Z').getTime(),
      zh: false,
    });

    expect(result.rootNode!.children).toHaveLength(1);
    expect(result.rootNode!.children[0].threadId).toBe('depth-1');
    expect(result.rootNode!.children[0].depth).toBe(1);
    expect(result.rootNode!.children[0].children[0].threadId).toBe('depth-2');
    expect(result.rootNode!.children[0].children[0].depth).toBe(2);
  });

  it('running/completed/failed/interrupted 状态映射正确', () => {
    const running = makeThreadChild({
      thread: { threadId: 'running-child', title: 'R', agentRole: 'Runner', status: 'running', turnCount: 1, createdAt: '2025-01-01T00:00:00Z', updatedAt: '2025-01-01T00:01:00Z' },
      edge: { parentThreadId: 'main', childThreadId: 'running-child', status: 'open', createdAt: '2025-01-01T00:00:00Z', updatedAt: '2025-01-01T00:01:00Z' },
      state: { threadId: 'running-child', status: 'running', checkpoint: null, resumable: false, stale: false },
    });
    const failed = makeThreadChild({
      thread: { threadId: 'failed-child', title: 'F', agentRole: 'Failer', status: 'failed', turnCount: 1, createdAt: '2025-01-01T00:00:00Z', updatedAt: '2025-01-01T00:01:00Z' },
      edge: { parentThreadId: 'main', childThreadId: 'failed-child', status: 'closed', createdAt: '2025-01-01T00:00:00Z', updatedAt: '2025-01-01T00:01:00Z' },
      state: { threadId: 'failed-child', status: 'failed', checkpoint: null, resumable: false, stale: false },
    });
    const completed = makeThreadChild({
      thread: { threadId: 'done-child', title: 'D', agentRole: 'Done', status: 'completed', turnCount: 1, createdAt: '2025-01-01T00:00:00Z', updatedAt: '2025-01-01T00:01:00Z' },
      edge: { parentThreadId: 'main', childThreadId: 'done-child', status: 'closed', createdAt: '2025-01-01T00:00:00Z', updatedAt: '2025-01-01T00:01:00Z' },
      state: { threadId: 'done-child', status: 'completed', checkpoint: null, resumable: false, stale: false },
      latestTurn: { turnId: 't1', userInput: null, status: 'completed', startedAt: '2025-01-01T00:00:00Z', completedAt: '2025-01-01T00:01:00Z' },
    });
    const interrupted = makeThreadChild({
      thread: { threadId: 'int-child', title: 'I', agentRole: 'Interrupter', status: 'interrupted', turnCount: 1, createdAt: '2025-01-01T00:00:00Z', updatedAt: '2025-01-01T00:01:00Z' },
      edge: { parentThreadId: 'main', childThreadId: 'int-child', status: 'open', createdAt: '2025-01-01T00:00:00Z', updatedAt: '2025-01-01T00:01:00Z' },
      state: { threadId: 'int-child', status: 'interrupted', checkpoint: null, resumable: false, stale: false },
    });

    const result = buildAgentWorkbench({
      mainThreadId: 'main',
      threadChildren: [running, failed, completed, interrupted],
      runtimeItems: [],
      busy: false,
      now: new Date('2025-01-01T00:02:00Z').getTime(),
      zh: false,
    });

    const statuses = Object.fromEntries(result.rootNode!.children.map(c => [c.threadId, c.status]));
    expect(statuses['running-child']).toBe('running');
    expect(statuses['failed-child']).toBe('failed');
    expect(statuses['done-child']).toBe('completed');
    expect(statuses['int-child']).toBe('interrupted');
  });

  it('error 优先于其他 phase', () => {
    const traceSummary: RunTraceSummary = {
      status: 'running',
      startedAt: '2025-01-01T00:00:00Z',
      currentSpan: { spanId: 's1', category: 'model', name: 'gpt-4' },
      model: { calls: 1, inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0 },
      tools: { calls: 0, failed: 0, denied: 0 },
      items: { started: 2, completed: 1, failed: 0, byType: {} },
      agents: { spawned: 0, running: 0, failed: 0 },
      files: { reads: 0, changed: 0, addedLines: 0, removedLines: 0, extracted: 0, reused: 0, stale: 0, refreshed: 0 },
      lastError: { code: 'ERR', message: 'Something went wrong' },
    };

    const result = buildAgentWorkbench({
      mainThreadId: 'main',
      threadChildren: [],
      traceSummary,
      runtimeItems: [],
      busy: true,
      zh: false,
    });

    expect(result.currentPhase.kind).toBe('error');
    expect(result.currentPhase.detail).toContain('Something went wrong');
  });

  it('elapsed 使用注入的 now 计算', () => {
    const startedAt = '2025-01-01T00:00:00Z';
    const now = new Date('2025-01-01T00:02:30Z').getTime();

    const traceSummary: RunTraceSummary = {
      status: 'running',
      startedAt,
      model: { calls: 1, inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0 },
      tools: { calls: 0, failed: 0, denied: 0 },
      items: { started: 1, completed: 0, failed: 0, byType: {} },
      agents: { spawned: 0, running: 0, failed: 0 },
      files: { reads: 0, changed: 0, addedLines: 0, removedLines: 0, extracted: 0, reused: 0, stale: 0, refreshed: 0 },
    };

    const result = buildAgentWorkbench({
      mainThreadId: 'main',
      threadChildren: [],
      traceSummary,
      runtimeItems: [],
      busy: true,
      now,
      zh: false,
    });

    expect(result.rootNode!.elapsedMs).toBe(150000);
  });

  it('500 items 线性遍历无异常', () => {
    const items: ThreadItem[] = Array.from({ length: 500 }, (_, i) => ({
      id: `item-${i}`,
      type: i % 3 === 0 ? 'tool_call' : 'file_change',
      toolName: i % 3 === 0 ? `tool-${i}` : undefined,
      changes: i % 3 !== 0 ? [{ path: `/file-${i}.txt`, kind: 'update', addedLines: 1, removedLines: 0 }] : undefined,
      timestamp: new Date(2025, 0, 1, 0, 0, i).toISOString(),
    }));

    const result = buildAgentWorkbench({
      mainThreadId: 'main',
      threadChildren: [],
      runtimeItems: items,
      busy: true,
      now: new Date('2025-01-01T00:10:00Z').getTime(),
      zh: false,
    });

    expect(result.rootNode).not.toBeNull();
    expect(result.recentEvents.length).toBeLessThanOrEqual(10);
    expect(result.rootNode!.toolCalls).toBeGreaterThan(0);
  });

  it('idle 状态下 currentPhase 为 idle', () => {
    const result = buildAgentWorkbench({
      mainThreadId: 'main',
      threadChildren: [],
      runtimeItems: [],
      busy: false,
      zh: false,
    });

    expect(result.currentPhase.kind).toBe('idle');
    expect(result.rootNode!.status).toBe('idle');
  });

  it('idle 状态有上一轮消息时保留上一轮完成态', () => {
    const result = buildAgentWorkbench({
      mainThreadId: 'main',
      threadChildren: [],
      runtimeItems: [
        { id: 'u1', type: 'user_message', text: '你好', timestamp: '2025-01-01T00:00:00Z' },
        { id: 'a1', type: 'agent_message', text: '上一轮回答已经完成', timestamp: '2025-01-01T00:01:00Z' },
      ],
      busy: false,
      zh: true,
    });

    expect(result.currentPhase.kind).toBe('model');
    expect(result.currentPhase.label).toBe('上轮已完成');
    expect(result.currentPhase.detail).toContain('上一轮回答');
  });

  it('busy 且无 currentSpan 时 currentPhase 为 idle(准备中)', () => {
    const traceSummary: RunTraceSummary = {
      status: 'running',
      model: { calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      tools: { calls: 0, failed: 0, denied: 0 },
      items: { started: 0, completed: 0, failed: 0, byType: {} },
      agents: { spawned: 0, running: 0, failed: 0 },
      files: { reads: 0, changed: 0, addedLines: 0, removedLines: 0, extracted: 0, reused: 0, stale: 0, refreshed: 0 },
    };

    const result = buildAgentWorkbench({
      mainThreadId: 'main',
      threadChildren: [],
      traceSummary,
      runtimeItems: [],
      busy: true,
      zh: false,
    });

    expect(result.currentPhase.kind).toBe('idle');
  });

  it('tool_call 在 runtimeItems 中派生 tool phase', () => {
    const items: ThreadItem[] = [
      { id: 'i1', type: 'tool_call', toolName: 'read_file', timestamp: '2025-01-01T00:00:00Z' },
    ];

    const result = buildAgentWorkbench({
      mainThreadId: 'main',
      threadChildren: [],
      runtimeItems: items,
      busy: true,
      zh: false,
    });

    expect(result.currentPhase.kind).toBe('tool');
    expect(result.currentPhase.detail).toContain('read_file');
  });

  it('最近事件直接携带资源和 Agent 身份', () => {
    const child = makeThreadChild({
      thread: {
        threadId: 'child-research',
        title: '资料子任务',
        agentRole: 'Research Agent',
        status: 'idle',
        turnCount: 1,
        createdAt: '2025-01-01T00:00:00Z',
        updatedAt: '2025-01-01T00:02:00Z',
      },
      edge: {
        parentThreadId: 'main',
        childThreadId: 'child-research',
        status: 'open',
        createdAt: '2025-01-01T00:00:00Z',
        updatedAt: '2025-01-01T00:02:00Z',
      },
      items: [{
        id: 'child-mcp-1',
        type: 'mcp_tool_call',
        server: 'example-mcp',
        tool: 'search_code',
        status: 'completed',
        timestamp: '2025-01-01T00:01:00Z',
      }],
    });

    const result = buildAgentWorkbench({
      mainThreadId: 'main',
      threadChildren: [child],
      runtimeItems: [{
        id: 'main-skill-1',
        type: 'tool_call',
        toolName: 'skills_add',
        arguments: { skillName: 'frontend-polish' },
        status: 'completed',
        timestamp: '2025-01-01T00:02:00Z',
      }],
      busy: false,
      zh: true,
      currentRunId: 'run-main',
    });

    expect(result.recentEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({
        itemId: 'main-skill-1',
        agent: expect.objectContaining({ label: 'Suanlizi 主控 Agent' }),
        resource: expect.objectContaining({ kind: 'Skill', label: 'frontend-polish' }),
      }),
      expect.objectContaining({
        itemId: 'child-mcp-1',
        agent: expect.objectContaining({ threadId: 'child-research', label: 'Research Agent' }),
        resource: expect.objectContaining({ kind: 'MCP', label: 'example-mcp / search_code' }),
      }),
    ]));
  });

  it('最近事件把 read_document 显示为具体文档资源', () => {
    const result = buildAgentWorkbench({
      mainThreadId: 'main',
      threadChildren: [],
      runtimeItems: [{
        id: 'read-doc-1',
        type: 'tool_call',
        toolName: 'read_document',
        result: {
          source: { path: 'E:\\langchain\\dexin-agent\\brief.docx' },
          artifact: { path: 'E:\\langchain\\dexin-agent\\.suanlizi\\documents\\brief.txt' },
        },
        status: 'completed',
        timestamp: '2025-01-01T00:02:00Z',
      }],
      busy: false,
      zh: true,
      currentRunId: 'run-main',
    });

    expect(result.recentEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({
        itemId: 'read-doc-1',
        resource: expect.objectContaining({ kind: 'Document', label: 'brief.docx' }),
      }),
    ]));
  });

  it('最近事件合并 trace 级授权决策并保留 Agent 和目标资源', () => {
    const child = makeThreadChild({
      thread: {
        threadId: 'child-research',
        title: '资料子任务',
        agentRole: 'Research Agent',
        status: 'idle',
        turnCount: 1,
        createdAt: '2025-01-01T00:00:00Z',
        updatedAt: '2025-01-01T00:02:00Z',
      },
      edge: {
        parentThreadId: 'main',
        childThreadId: 'child-research',
        status: 'open',
        createdAt: '2025-01-01T00:00:00Z',
        updatedAt: '2025-01-01T00:02:00Z',
      },
    });
    const approvalTrace = {
      version: 2,
      eventId: 'trace-approval-1',
      sequence: 1,
      runId: 'run-child',
      runKind: 'turn',
      threadId: 'child-research',
      turnId: 'turn-child',
      spanId: 'span-approval-1',
      category: 'approval',
      name: 'access.decision',
      lifecycle: 'instant',
      level: 'info',
      occurredAt: '2025-01-01T00:03:00Z',
      payload: {
        decision: 'prompt',
        source: 'approval_required',
        access: 'read',
        target: { kind: 'path', path: 'E:\\langchain\\outside.txt' },
        toolName: 'read_file',
        agentThreadId: 'child-research',
        agentRole: 'Research Agent',
      },
    } as unknown as RunTraceEnvelope;

    const result = buildAgentWorkbench({
      mainThreadId: 'main',
      threadChildren: [child],
      runtimeItems: [],
      recentTraces: [approvalTrace],
      busy: true,
      zh: true,
      currentRunId: 'run-main',
    });

    expect(result.recentEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({
        itemId: 'trace-approval-1',
        eventId: 'trace-approval-1',
        category: 'approval',
        agent: expect.objectContaining({ threadId: 'child-research', label: 'Research Agent' }),
        resource: expect.objectContaining({ kind: 'Document', label: 'outside.txt' }),
        summary: expect.stringContaining('请求临时授权'),
      }),
    ]));
  });
});
