import { describe, expect, it } from 'vitest';
import { buildAgentStageRows, buildSubagentStatusRows } from './subagents.js';
import type { ThreadChildInfo } from '../../shared/types.js';

function child(overrides: Partial<ThreadChildInfo>): ThreadChildInfo {
  return {
    thread: {
      threadId: 'child',
      title: '检查项目结构',
      status: 'active',
      turnCount: 1,
      createdAt: '2026-06-10T00:00:00.000Z',
      updatedAt: '2026-06-10T00:01:00.000Z',
      parentThreadId: 'parent',
      agentNickname: 'reviewer',
      agentRole: '代码审查',
    },
    edge: {
      parentThreadId: 'parent',
      childThreadId: 'child',
      status: 'open',
      createdAt: '2026-06-10T00:00:00.000Z',
      updatedAt: '2026-06-10T00:01:00.000Z',
    },
    state: {
      threadId: 'child',
      status: 'running',
      checkpoint: null,
      resumable: false,
      stale: false,
    },
    latestTurn: {
      turnId: 'turn-child',
      userInput: { type: 'text', text: '检查项目结构' },
      status: 'running',
      startedAt: '2026-06-10T00:00:10.000Z',
      completedAt: null,
    },
    latestCollabItem: {
      id: 'collab-1',
      type: 'collab_tool_call',
      tool: 'spawn_agent',
      status: 'completed',
      receiverThreadId: 'child',
      prompt: '检查项目结构',
      agentStatus: 'running',
      timestamp: '2026-06-10T00:00:02.000Z',
    },
    ...overrides,
  };
}

describe('buildSubagentStatusRows', () => {
  it('returns no rows when there are no child agents', () => {
    expect(buildSubagentStatusRows([], 'zh')).toEqual([]);
  });

  it('builds recursive rows with localized status labels and depth', () => {
    const rows = buildSubagentStatusRows([
      child({}),
      child({
        thread: {
          ...child({}).thread,
          threadId: 'grandchild',
          title: '检查测试',
          parentThreadId: 'child',
          agentNickname: null,
          agentRole: '测试',
          updatedAt: '2026-06-10T00:02:00.000Z',
        },
        edge: {
          parentThreadId: 'child',
          childThreadId: 'grandchild',
          status: 'open',
          createdAt: '2026-06-10T00:01:00.000Z',
          updatedAt: '2026-06-10T00:02:00.000Z',
        },
        state: {
          threadId: 'grandchild',
          status: 'completed',
          checkpoint: null,
          resumable: false,
          stale: false,
        },
        latestTurn: {
          turnId: 'turn-grandchild',
          userInput: { type: 'text', text: '检查测试' },
          status: 'completed',
          startedAt: '2026-06-10T00:01:10.000Z',
          completedAt: '2026-06-10T00:02:00.000Z',
        },
        latestCollabItem: {
          id: 'collab-2',
          type: 'collab_tool_call',
          tool: 'wait',
          status: 'completed',
          receiverThreadId: 'grandchild',
          agentStatus: 'completed',
          timestamp: '2026-06-10T00:02:00.000Z',
        },
      }),
    ], 'zh');

    expect(rows.map((row) => ({
      id: row.threadId,
      depth: row.depth,
      label: row.statusLabel,
      tone: row.tone,
      action: row.latestAction,
    }))).toEqual([
      { id: 'child', depth: 0, label: '运行中', tone: 'running', action: '生成子 Agent' },
      { id: 'grandchild', depth: 1, label: '已完成', tone: 'success', action: '等待子 Agent' },
    ]);
  });

  it('shows closed child agents as muted closed rows', () => {
    const [row] = buildSubagentStatusRows([
      child({
        edge: {
          parentThreadId: 'parent',
          childThreadId: 'child',
          status: 'closed',
          createdAt: '2026-06-10T00:00:00.000Z',
          updatedAt: '2026-06-10T00:03:00.000Z',
        },
        state: {
          threadId: 'child',
          status: 'idle',
          checkpoint: null,
          resumable: false,
          stale: false,
        },
        latestTurn: null,
      }),
    ], 'en');

    expect(row).toMatchObject({
      statusLabel: 'Closed',
      tone: 'muted',
    });
  });

  it('builds stage rows with the main agent first', () => {
    const children = buildSubagentStatusRows([child({})], 'zh');
    expect(buildAgentStageRows({
      activeThreadTitle: '主任务',
      activeThreadId: 'parent',
      locale: 'zh',
      busy: true,
      children,
    }).map((row) => ({
      id: row.threadId,
      kind: row.kind,
      title: row.title,
      label: row.statusLabel,
    }))).toEqual([
      { id: 'parent', kind: 'main', title: 'Suanlizi 主控 Agent', label: '运行中' },
      { id: 'child', kind: 'child', title: 'reviewer', label: '运行中' },
    ]);
  });

  it('keeps the main agent identity and idle status independent of conversation title', () => {
    const [main] = buildAgentStageRows({
      activeThreadTitle: '你好',
      activeThreadId: 'parent',
      locale: 'zh',
      busy: false,
      children: [],
    });

    expect(main).toMatchObject({
      title: 'Suanlizi 主控 Agent',
      statusLabel: '待机中',
      latestAction: '等待指令',
    });
  });
});
