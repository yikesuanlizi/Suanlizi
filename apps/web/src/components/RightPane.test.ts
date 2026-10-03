import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { RightPane } from './RightPane.js';

const here = dirname(fileURLToPath(import.meta.url));

describe('RightPane', () => {
  it('renders workbench tabs (activity/agents/files)', () => {
    const html = renderToStaticMarkup(React.createElement(RightPane, {
      activeTab: 'activity',
      activeThreadId: 'thread_1',
      activeThreadTitle: 'Test Thread',
      busy: false,
      threadChildren: [],
      runtimeItems: [],
      activeThread: {
        threadId: 'thread_1',
        title: 'Test Thread',
        status: 'idle',
        turnCount: 0,
        createdAt: '2026-07-18T00:00:00.000Z',
        updatedAt: '2026-07-18T00:00:00.000Z',
      },
      locale: 'zh',
      workspaceRoot: 'E:/langchain',
      onTabChange: vi.fn(),
      onToggleMemoryExcluded: vi.fn(),
    }));

    expect(html).toContain('活动');
    expect(html).toContain('智能体');
    expect(html).toContain('文件');
  });

  it('renders activity tab with idle state when not busy', () => {
    const html = renderToStaticMarkup(React.createElement(RightPane, {
      activeTab: 'activity',
      activeThreadId: 'thread_1',
      activeThreadTitle: 'Test',
      busy: false,
      threadChildren: [],
      runtimeItems: [],
      activeThread: {
        threadId: 'thread_1',
        title: 'Test',
        status: 'idle',
        turnCount: 0,
        createdAt: '2026-07-18T00:00:00.000Z',
        updatedAt: '2026-07-18T00:00:00.000Z',
      },
      locale: 'zh',
      workspaceRoot: 'E:/langchain',
      onTabChange: vi.fn(),
    }));

    expect(html).toContain('等待开始');
  });

  it('renders agents tab content', () => {
    const html = renderToStaticMarkup(React.createElement(RightPane, {
      activeTab: 'agents',
      activeThreadId: 'thread_1',
      activeThreadTitle: 'Test',
      busy: false,
      threadChildren: [],
      runtimeItems: [],
      activeThread: {
        threadId: 'thread_1',
        title: 'Test',
        status: 'idle',
        turnCount: 0,
        createdAt: '2026-07-18T00:00:00.000Z',
        updatedAt: '2026-07-18T00:00:00.000Z',
      },
      locale: 'zh',
      workspaceRoot: 'E:/langchain',
      onTabChange: vi.fn(),
    }));

    expect(html).toContain('主控 Agent');
    expect(html).toContain('查看主 Agent 详情');
    expect(html).not.toContain('在监控中查看');
    expect(html).not.toContain('深度');
  });

  it('keeps the agent info button meaningful by not rendering inspector until an agent is selected', () => {
    const workbenchSource = readFileSync(join(here, 'workbench', 'WorkspaceWorkbench.tsx'), 'utf-8');
    const agentStageSource = readFileSync(join(here, 'AgentStagePanel.tsx'), 'utf-8');

    expect(workbenchSource).toContain("const mainAgentThreadId = activeThreadId || 'main'");
    expect(workbenchSource).toContain('mainThreadId: mainAgentThreadId');
    expect(workbenchSource).toContain('if (!selectedAgentId) return null');
    expect(workbenchSource).toContain('setSelectedAgentId((current) => current === threadId ? null : threadId)');
    expect(workbenchSource).toContain('hasActiveThread && selectedNode ? (');
    expect(agentStageSource).toContain('aria-pressed={selectedThreadId === mainRow.threadId}');
    expect(agentStageSource).toContain('收起主 Agent 详情');
  });

  it('passes item trace jumps through to monitor instead of transcript-only scrolling', () => {
    const mainSource = readFileSync(join(here, '..', 'main.tsx'), 'utf-8');
    const workbenchSource = readFileSync(join(here, 'workbench', 'WorkspaceWorkbench.tsx'), 'utf-8');

    expect(mainSource).toContain('if (itemId && !runId && !eventId && !threadId)');
    expect(workbenchSource).toContain('onJumpToMonitor?.({ itemId: opts.itemId, eventId: opts.eventId, runId: opts.runId, threadId: activeThreadId })');
  });

  it('does not keep forcing the files tab after the same external preview request was handled', () => {
    const workbenchSource = readFileSync(join(here, 'workbench', 'WorkspaceWorkbench.tsx'), 'utf-8');

    expect(workbenchSource).toContain('handledPreviewRequestKeyRef');
    expect(workbenchSource).toContain('if (handledPreviewRequestKeyRef.current === previewRequestKey) return');
    expect(workbenchSource).not.toContain("}, [externalPreviewRequest, activeTab, onTabChange]);");
  });

  it('wraps each workbench tab body in a motion-aware panel', () => {
    const workbenchSource = readFileSync(join(here, 'workbench', 'WorkspaceWorkbench.tsx'), 'utf-8');
    const styles = readFileSync(join(here, '..', 'styles.css'), 'utf-8');

    expect(workbenchSource).toContain('function workbenchPanelClassName');
    expect(workbenchSource).toContain("className={workbenchPanelClassName('activity', activeTab)}");
    expect(workbenchSource).toContain("className={workbenchPanelClassName('agents', activeTab)}");
    expect(workbenchSource).toContain("className={workbenchPanelClassName('files', activeTab)}");
    expect(styles).toContain('.workbenchPanel');
    expect(styles).toContain('@keyframes workbenchPanelIn');
  });

  it('keeps the files panel warm-mounted after first open instead of remounting the heavy tree', () => {
    const workbenchSource = readFileSync(join(here, 'workbench', 'WorkspaceWorkbench.tsx'), 'utf-8');
    const styles = readFileSync(join(here, '..', 'styles.css'), 'utf-8');

    expect(workbenchSource).toContain('const [filesPanelMounted, setFilesPanelMounted]');
    expect(workbenchSource).toContain('requestIdleCallback');
    expect(workbenchSource).toContain("if (activeTab === 'files' || externalPreviewRequest?.path)");
    expect(workbenchSource).toContain("const shouldRenderFilesPanel = filesPanelMounted || activeTab === 'files' || Boolean(externalPreviewRequest?.path)");
    expect(workbenchSource).toContain("aria-hidden={activeTab !== 'files'}");
    expect(workbenchSource).toContain("workbenchPanel${tab === activeTab ? ' active' : ' inactive'}");
    expect(styles).toContain('.workbenchPanel.inactive');
    expect(styles).toContain('position: absolute;');
    const inactivePanel = styles.slice(styles.lastIndexOf('.workbenchPanel.inactive {'), styles.indexOf('}', styles.lastIndexOf('.workbenchPanel.inactive {')));
    expect(workbenchSource).toContain("inert={activeTab !== 'files'}");
    expect(inactivePanel).toContain('pointer-events: none;');
    expect(inactivePanel).toContain('transform: translate3d(8px, 0, 0);');
    expect(inactivePanel).not.toContain('visibility: hidden;');
    expect(styles).toContain('opacity: 0;');
    expect(styles).not.toContain('.workbenchPanel.inactive {\n  display: none;');
    expect(styles).toContain('.workbenchFiles.workbenchPanel');
    expect(styles).toContain('contain: layout paint style;');
  });

  it('keeps workbench tab state local but reports lightweight sizing mode to the app shell', () => {
    const mainSource = readFileSync(join(here, '..', 'main.tsx'), 'utf-8');
    const rightPaneSource = readFileSync(join(here, 'RightPane.tsx'), 'utf-8');

    expect(rightPaneSource).toContain('useState<RightPaneTab>');
    expect(rightPaneSource).toContain('localStorage.getItem(rightPaneStorageKey(normalized))');
    expect(rightPaneSource).toContain('localStorage.setItem(rightPaneStorageKey(threadScope), tab)');
    expect(mainSource).not.toContain('setRightPaneTab');
    expect(mainSource).toContain("setRightPaneSizingMode(rightPaneSizingModeForTab(tab))");
    expect(mainSource).toContain("function rightPaneSizingModeForTab(tab: string)");
    expect(mainSource).not.toContain('onTabChange={setRightPaneTab}');
  });

  it('shows resource details inside recent activity events instead of a separate resource block', () => {
    const html = renderToStaticMarkup(React.createElement(RightPane, {
      activeTab: 'activity',
      activeThreadId: 'thread_1',
      activeThreadTitle: 'Test',
      busy: false,
      threadChildren: [],
      runtimeItems: [
        {
          id: 'mcp-1',
          type: 'mcp_tool_call',
          server: 'example-mcp',
          tool: 'search_code',
          status: 'completed',
          timestamp: '2026-07-23T00:00:00.000Z',
        },
        {
          id: 'skill-1',
          type: 'tool_call',
          toolName: 'skills_add',
          arguments: { skillName: 'frontend-design' },
          status: 'completed',
          timestamp: '2026-07-23T00:00:01.000Z',
        },
        {
          id: 'shell-1',
          type: 'command_execution',
          command: 'npm test',
          status: 'completed',
          timestamp: '2026-07-23T00:00:02.000Z',
        },
      ],
      activeThread: {
        threadId: 'thread_1',
        title: 'Test',
        status: 'idle',
        turnCount: 0,
        createdAt: '2026-07-18T00:00:00.000Z',
        updatedAt: '2026-07-18T00:00:00.000Z',
      },
      locale: 'zh',
      workspaceRoot: 'E:/langchain',
      onTabChange: vi.fn(),
    }));

    expect(html).not.toContain('资源使用');
    expect(html).toContain('最近事件');
    expect(html).toContain('Suanlizi 主控 Agent');
    expect(html).toContain('MCP');
    expect(html).toContain('example-mcp / search_code');
    expect(html).toContain('Skill');
    expect(html).toContain('frontend-design');
    expect(html).toContain('Shell');
    expect(html).toContain('npm test');
  });

  it('keeps exact event-to-trace linkage and original animated agent entry points', () => {
    const workbenchSource = readFileSync(join(here, 'workbench', 'WorkspaceWorkbench.tsx'), 'utf-8');
    const liveActivitySource = readFileSync(join(here, 'workbench', 'LiveActivityHud.tsx'), 'utf-8');
    const agentStageSource = readFileSync(join(here, 'AgentStagePanel.tsx'), 'utf-8');

    expect(workbenchSource).toContain('onJumpToMonitor?.({ itemId: opts.itemId, eventId: opts.eventId, runId: opts.runId, threadId: activeThreadId })');
    expect(liveActivitySource).toContain('onJumpToTrace?.({ itemId: event.itemId, runId: event.runId, eventId: event.eventId })');
    expect(agentStageSource).toContain('<RobotMoodIcon variant="main"');
    expect(agentStageSource).toContain('InteractiveMainRobot');
  });
});
