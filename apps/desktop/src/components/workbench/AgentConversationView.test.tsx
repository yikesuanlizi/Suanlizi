import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { AgentConversationView } from './AgentConversationView.js';
import type { AgentWorkbenchNode } from '../../features/agents/agentWorkbenchModel.js';

const baseNode: AgentWorkbenchNode = {
  threadId: 'child-1',
  depth: 1,
  role: 'researcher',
  status: 'running',
  startedAt: '2026-09-14T00:00:00.000Z',
  updatedAt: '2026-09-14T00:01:00.000Z',
  elapsedMs: 60_000,
  toolCalls: 3,
  tokens: 1200,
  children: [],
};

describe('AgentConversationView', () => {
  it('renders instruction, timeline items, and a back button', () => {
    const html = renderToStaticMarkup(React.createElement(AgentConversationView, {
      node: baseNode,
      items: [
        { id: 'u1', type: 'user_message', turnId: 't1', text: '调研一下缓存策略', status: 'completed' },
        { id: 'tool-1', type: 'tool_call', turnId: 't1', toolName: 'search_content', arguments: { pattern: 'cache' }, status: 'completed' },
        { id: 'a1', type: 'agent_message', turnId: 't1', text: '完成调研', status: 'completed' },
      ],
      instruction: '调研 Redis 缓存策略',
      locale: 'zh',
      onBack: vi.fn(),
    }));

    expect(html).toContain('指令');
    expect(html).toContain('调研 Redis 缓存策略');
    expect(html).toContain('返回卡片');
    expect(html).toContain('search_content');
    expect(html).toContain('完成调研');
    expect(html).toContain('agentDetailView');
  });

  it('shows an empty state when the agent has no activity yet', () => {
    const html = renderToStaticMarkup(React.createElement(AgentConversationView, {
      node: baseNode,
      items: [],
      instruction: '任务',
      locale: 'zh',
      onBack: vi.fn(),
    }));

    expect(html).toContain('暂无活动记录');
  });

  it('renders the agent status badge and tool-call footer', () => {
    const html = renderToStaticMarkup(React.createElement(AgentConversationView, {
      node: baseNode,
      items: [],
      locale: 'zh',
      onBack: vi.fn(),
    }));

    expect(html).toContain('运行中');
    expect(html).toContain('agentDetailFooter');
    expect(html).toContain('<strong>3</strong>');
  });
});
