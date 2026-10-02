import { describe, expect, it } from 'vitest';
import { buildAgentTree } from './useAgentStage.js';
import type { ThreadChildInfo, ThreadItem } from '../../shared/types.js';

// 构造子 Agent 信息
function makeChild(overrides: Partial<ThreadChildInfo> & { thread: ThreadChildInfo['thread']; edge: ThreadChildInfo['edge']; state: ThreadChildInfo['state'] }): ThreadChildInfo {
  return {
    latestTurn: null,
    latestCollabItem: null,
    items: [],
    ...overrides,
  };
}

function makeItem(overrides: Partial<ThreadItem> & { id: string; type: string }): ThreadItem {
  return {
    status: 'completed',
    timestamp: '2026-07-18T00:00:00.000Z',
    ...overrides,
  };
}

describe('buildAgentTree', () => {
  it('returns a single main agent when there are no children', () => {
    const runtimeItems: ThreadItem[] = [makeItem({ id: 'r1', type: 'tool_call', toolName: 'read_file' })];
    const agents = buildAgentTree({
      activeThreadId: 'thread_main',
      activeThreadTitle: '主任务',
      busy: false,
      children: [],
      runtimeItems,
      locale: 'zh',
    });
    expect(agents).toHaveLength(1);
    const main = agents[0];
    expect(main.id).toBe('thread_main');
    expect(main.name).toBe('Suanlizi 主控 Agent');
    expect(main.role).toBe('主 Agent');
    expect(main.depth).toBe(0);
    expect(main.parentId).toBeNull();
    expect(main.children).toEqual([]);
    // runtimeItems 直接作为主 agent 的 items
    expect(main.items).toBe(runtimeItems);
    // 非 busy 状态下为 idle
    expect(main.status).toBe('idle');
    expect(main.tone).toBe('muted');
  });

  it('marks the main agent as running when busy=true', () => {
    const agents = buildAgentTree({
      activeThreadId: 'main',
      activeThreadTitle: '',
      busy: true,
      children: [],
      runtimeItems: [],
      locale: 'zh',
    });
    expect(agents[0].status).toBe('running');
    expect(agents[0].tone).toBe('running');
    expect(agents[0].currentStep).toBe('正在处理任务');
  });

  it('nests child agents under the main agent when parent is the active thread', () => {
    const childItem = makeItem({ id: 'c_i1', type: 'tool_call', toolName: 'search' });
    const child = makeChild({
      thread: {
        threadId: 'child_a',
        title: '检查项目结构',
        status: 'running',
        turnCount: 1,
        createdAt: '2026-07-18T00:00:00.000Z',
        updatedAt: '2026-07-18T00:01:00.000Z',
        parentThreadId: 'thread_main',
        agentNickname: 'reviewer',
        agentRole: '代码审查',
      },
      edge: {
        parentThreadId: 'thread_main',
        childThreadId: 'child_a',
        status: 'open',
        createdAt: '2026-07-18T00:00:00.000Z',
        updatedAt: '2026-07-18T00:01:00.000Z',
      },
      state: {
        threadId: 'child_a',
        status: 'running',
        checkpoint: null,
        resumable: false,
        stale: false,
      },
      items: [childItem],
    });

    const agents = buildAgentTree({
      activeThreadId: 'thread_main',
      activeThreadTitle: '主任务',
      busy: true,
      children: [child],
      runtimeItems: [makeItem({ id: 'm1', type: 'reasoning', text: 'planning' })],
      locale: 'zh',
    });

    expect(agents).toHaveLength(1);
    const main = agents[0];
    expect(main.id).toBe('thread_main');
    expect(main.children).toHaveLength(1);
    const nested = main.children[0];
    expect(nested.id).toBe('child_a');
    expect(nested.parentId).toBe('thread_main');
    expect(nested.depth).toBe(1);
    expect(nested.items).toEqual([childItem]);
    // 子 agent 状态从 ThreadChildInfo.state.status 派生
    expect(nested.status).toBe('running');
    expect(nested.tone).toBe('running');
  });

  it('localizes main agent name and currentStep based on locale', () => {
    const agentsZh = buildAgentTree({
      activeThreadId: 'main',
      activeThreadTitle: '',
      busy: true,
      children: [],
      runtimeItems: [],
      locale: 'zh',
    });
    expect(agentsZh[0].name).toBe('Suanlizi 主控 Agent');
    expect(agentsZh[0].currentStep).toBe('正在处理任务');

    const agentsEn = buildAgentTree({
      activeThreadId: 'main',
      activeThreadTitle: '',
      busy: true,
      children: [],
      runtimeItems: [],
      locale: 'en',
    });
    expect(agentsEn[0].name).toBe('Suanlizi Primary Agent');
    expect(agentsEn[0].currentStep).toBe('Working on task');
  });
});
