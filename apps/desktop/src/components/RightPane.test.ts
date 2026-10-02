import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { RightPane } from './RightPane.js';

const here = dirname(fileURLToPath(import.meta.url));

describe('RightPane', () => {
  it('keeps the workbench empty and utility controls disabled without a selected thread', () => {
    const html = renderToStaticMarkup(React.createElement(RightPane, {
      activeTab: 'browser',
      activeThreadId: '',
      activeThreadTitle: '',
      activeThread: null,
      busy: false,
      threadChildren: [],
      runtimeItems: [],
      locale: 'zh',
      workspaceRoot: 'D:/remembered/project',
      onTabChange: vi.fn(),
    }));

    expect(html).toContain('活动');
    expect(html).toContain('智能体');
    expect(html).toContain('disabled=""');
    expect(html).not.toContain('workbenchDynamicTab');
    expect(html).not.toContain('browserWorkbench');
    expect(html).not.toContain('workspaceFiles');
    expect(html).not.toContain('terminalPanel');
  });

  it('renders only fixed tabs at startup and keeps utilities behind the add menu', () => {
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
    expect(html).toContain('workbenchUtilityTabs');
    expect(html).not.toContain('workbenchDynamicTab');
    expect(html).not.toContain('browserPanel');
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

  it('does not open the Ops tab from historical thread metadata alone', () => {
    const html = renderToStaticMarkup(React.createElement(RightPane, {
      activeTab: 'activity',
      activeThreadId: 'thread_ops',
      activeThreadTitle: 'Ops',
      busy: false,
      threadChildren: [],
      activeThread: {
        threadId: 'thread_ops',
        title: 'Ops',
        mode: 'ops',
        taskPreset: 'ops',
        status: 'idle',
        turnCount: 0,
        createdAt: '2026-07-18T00:00:00.000Z',
        updatedAt: '2026-07-18T00:00:00.000Z',
      },
      locale: 'zh',
      workspaceRoot: 'E:/langchain',
      onTabChange: vi.fn(),
    }));

    expect(html).not.toContain('运维');
  });

  it('keeps the agent info button meaningful by showing cards until an agent is selected', () => {
    const workbenchSource = readFileSync(join(here, 'workbench', 'WorkspaceWorkbench.tsx'), 'utf-8');
    const agentStageSource = readFileSync(join(here, 'AgentStagePanel.tsx'), 'utf-8');
    const detailSource = readFileSync(join(here, 'workbench', 'AgentConversationView.tsx'), 'utf-8');

    expect(workbenchSource).toContain("const mainAgentThreadId = activeThreadId || 'main'");
    expect(workbenchSource).toContain('mainThreadId: mainAgentThreadId');
    expect(workbenchSource).toContain('if (!selectedAgentId) return null');
    expect(workbenchSource).toContain('setSelectedAgentId((current) => current === threadId ? null : threadId)');
    // 卡片视图与详情视图互斥：选中节点才渲染详情，否则渲染卡片
    // — Chinese: card and detail views are mutually exclusive
    expect(workbenchSource).toContain('selectedNode ? (');
    expect(workbenchSource).toContain('<AgentConversationView');
    expect(workbenchSource).toContain('<AgentStagePanel');
    expect(workbenchSource).toContain('onBack={() => setSelectedAgentId(null)}');
    // 主卡片的 info 按钮保留"查看主 Agent 详情"入口
    // — Chinese: the hero card keeps its info button as the main-agent detail entry
    expect(agentStageSource).toContain('查看主 Agent 详情');
    // 详情视图必须提供返回卡片的出口，且为只读（无输入框）
    // — Chinese: the detail view offers a back button and stays read-only
    expect(detailSource).toContain('onBack');
    expect(detailSource).toContain('返回卡片');
    expect(detailSource).toContain('<ItemView');
    expect(detailSource).not.toContain('textarea');
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

  it('keeps the Ops inspector in its own conditional fixed tab', () => {
    const workbenchSource = readFileSync(join(here, 'workbench', 'WorkspaceWorkbench.tsx'), 'utf-8');

    expect(workbenchSource).toContain("opsVisible ? (");
    expect(workbenchSource).toContain("workbenchPanelClassName('ops', activeTab)");
    expect(workbenchSource).toContain('data-testid="ops-workbench-panel"');
    expect(workbenchSource).toContain('<OpsTaskInspector');
    expect(workbenchSource).toContain('opsWorkbenchEmpty');
  });

  it('guards mode writes and Ops task state by thread before rendering or mutating', () => {
    const mainSource = readFileSync(join(here, '..', 'main.tsx'), 'utf-8');

    expect(mainSource).toContain('opsStartGenerationRef');
    expect(mainSource).toContain('isCurrentStart');
    expect(mainSource).toContain('requestThreadId');
    expect(mainSource).toContain('opsTaskDetail?.task.spec.threadId === threadId');
    expect(mainSource).toContain('opsTaskAnchor?.threadId === threadId');
    expect(mainSource).toContain('const opsSessionActive = Boolean(currentOpsTaskDetail || currentOpsTaskAnchor)');
    expect(mainSource).toContain("Only a live or blocked task reopens the Ops surface");
    expect(mainSource).toContain("if (!opsKnowledgeScope?.knowledgeBaseIds.length)");
    expect(mainSource).toContain('setItems((current) => mergeIncomingItems(current, [{ id: `ops_error_');
  });

  it('keeps Ops as an explicit composer submission mode rather than a right-pane creation control', () => {
    const mainSource = readFileSync(join(here, '..', 'main.tsx'), 'utf-8');
    const composerSource = readFileSync(join(here, 'ComposerBar.tsx'), 'utf-8');

    expect(mainSource).toContain('showOps={hasActiveThread && opsSessionActive}');
    expect(composerSource).toContain('modeIndicatorOps');
    expect(composerSource).toContain("executionMode === 'ops'");
    expect(composerSource).not.toContain('executionModeSelect');
    expect(composerSource).not.toContain('onThreadModeChange');
  });

  it('mounts file and browser panels only while their dynamic tabs are open', () => {
    const workbenchSource = readFileSync(join(here, 'workbench', 'WorkspaceWorkbench.tsx'), 'utf-8');
    const styles = readFileSync(join(here, '..', 'styles.css'), 'utf-8');

    expect(workbenchSource).toContain("const shouldRenderFilesPanel = hasActiveThread && openUtilityTabs.includes('files');");
    expect(workbenchSource).toContain("const shouldRenderBrowserWorkbench = hasActiveThread && openUtilityTabs.includes('browser');");
    expect(workbenchSource).not.toContain('filesPanelMounted');
    expect(workbenchSource).not.toContain('requestIdleCallback');
    expect(workbenchSource).toContain("aria-hidden={activeTab !== 'files'}");
    expect(workbenchSource).toContain("aria-hidden={activeTab !== 'browser'}");
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

  it('persists dynamic tabs per thread without injecting the previous active tab on scope changes', () => {
    const mainSource = readFileSync(join(here, '..', 'main.tsx'), 'utf-8');
    const rightPaneSource = readFileSync(join(here, 'RightPane.tsx'), 'utf-8');

    expect(rightPaneSource).toContain('useState<RightPaneTab>');
    expect(rightPaneSource).toContain('const [openUtilityTabs, setOpenUtilityTabs]');
    expect(rightPaneSource).toContain('readStoredWorkbenchState(threadScope)');
    expect(rightPaneSource).toContain('writeStoredWorkbenchState({');
    expect(rightPaneSource).toContain('if (previous === contextKey) return;');
    expect(rightPaneSource).toContain('setOpenUtilityTabs(stored.openUtilityTabs);');
    const contextSwitchEffect = rightPaneSource.slice(
      rightPaneSource.indexOf('if (previous === null || previous === contextKey) return;'),
      rightPaneSource.indexOf('useEffect(() => {\n    if (hasActiveThread) return;'),
    );
    expect(contextSwitchEffect).not.toContain('initialUtility');
    expect(rightPaneSource).toContain('const nextActiveTab: RightPaneTab');
    expect(rightPaneSource).toContain('onTabChange?.(nextActiveTab)');
    expect(mainSource).not.toContain('setRightPaneTab');
    expect(mainSource).toContain("setRightPaneSizingMode(rightPaneSizingModeForTab(tab))");
    expect(mainSource).not.toContain('onTabChange={setRightPaneTab}');
    expect(mainSource).toContain('readStoredWorkbenchVisibility(threadId)');
    expect(mainSource).toContain('pendingAgentRequestTaskIds()');
    expect(mainSource).toContain('event.taskId !== threadId');
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
          server: 'gitnexus',
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
    expect(html).toContain('gitnexus / search_code');
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
