import { useEffect, useMemo, useRef, useState } from 'react';
import type { Locale } from '../../config/config.js';
import type { ThreadChildInfo, ThreadItem, ThreadMeta } from '../../shared/types.js';
import type { RunControlCapabilities, RunTraceEnvelope, RunTraceSummary } from '@suanlizi/protocol';
import type { ExternalPreviewRequest } from '../WorkspaceFilesPanel.js';
import { WorkspaceFilesPanel } from '../WorkspaceFilesPanel.js';
import { Icon } from '../Icon.js';
import { buildAgentWorkbench } from '../../features/agents/agentWorkbenchModel.js';
import { buildAgentStageRows, buildSubagentStatusRows } from '../../features/agents/subagents.js';
import {
  isTerminalUtilityWorkbenchTab,
  WorkbenchTabs,
  type PinnableWorkbenchTab,
  type UtilityWorkbenchTab,
  type UtilityWorkbenchTabKind,
  type WorkbenchTab,
} from './WorkbenchTabs.js';
import { LiveActivityHud } from './LiveActivityHud.js';
import { AgentConversationView } from './AgentConversationView.js';
import { CommandTerminalPane } from './CommandTerminalPane.js';
import { AgentStagePanel } from '../AgentStagePanel.js';
import { BrowserWorkbench } from '../BrowserWorkbench.js';
import { TerminalPanel } from './TerminalPanel.js';
import { OpsTaskInspector, type OpsTaskTimelineEvent } from './OpsTaskInspector.js';
import { OpsKnowledgeStatus } from './OpsKnowledgeStatus.js';
import type { KnowledgeScopeSelection } from '../../api/knowledgeClient.js';
import type { OpsTaskSession } from '@suanlizi/protocol';

export function WorkspaceWorkbench({
  activeThread,
  activeThreadId,
  busy,
  threadChildren,
  runtimeItems = [],
  recentTraces = [],
  traceSummary,
  currentRunId,
  controlCapabilities,
  locale,
  workspaceRoot,
  terminalWorkspaceRoot,
  externalPreviewRequest,
  activeTab,
  onTabChange,
  pinnedTabs = ['activity', 'agents'],
  onTogglePinnedTab,
  openUtilityTabs,
  onOpenUtilityTab,
  onCloseUtilityTab,
  onJumpToMonitor,
  onInterrupt,
  onResume,
  onRollback,
  onToggleMemoryExcluded,
  onOpenSystemLocation,
  onAddFileToConversation,
  responsiveMode,
  onCloseRequest,
  agentDetailRequest,
  onOpenCommandTerminal,
  suspendBrowser = false,
  showOps = false,
  opsTask = null,
  opsTaskEvents = [],
  opsTaskBusy = false,
  opsKnowledgeScope = null,
  onOpsKnowledgeScopeChange,
  onOpsTaskAction,
  onOpsRunTest,
  onOpsSaveIncident,
}: {
  activeThread?: ThreadMeta | null;
  activeThreadId: string;
  busy: boolean;
  threadChildren: ThreadChildInfo[];
  runtimeItems?: ThreadItem[];
  recentTraces?: RunTraceEnvelope[];
  traceSummary?: RunTraceSummary | null;
  currentRunId?: string;
  controlCapabilities?: RunControlCapabilities;
  locale: Locale;
  workspaceRoot: string;
  terminalWorkspaceRoot?: string;
  externalPreviewRequest?: ExternalPreviewRequest | null;
  activeTab: WorkbenchTab;
  onTabChange(tab: WorkbenchTab): void;
  pinnedTabs?: PinnableWorkbenchTab[];
  onTogglePinnedTab?(tab: PinnableWorkbenchTab): void;
  openUtilityTabs: UtilityWorkbenchTab[];
  onOpenUtilityTab(tab: UtilityWorkbenchTabKind): UtilityWorkbenchTab;
  onCloseUtilityTab(tab: UtilityWorkbenchTab): void;
  onJumpToMonitor?(opts: { runId?: string; eventId?: string; itemId?: string; threadId?: string }): void;
  onInterrupt?(): void;
  onResume?(): void;
  onRollback?(checkpointId?: string): void;
  onToggleMemoryExcluded?(excluded: boolean): void;
  onOpenSystemLocation?(path: string): void;
  onAddFileToConversation?(path: string): void;
  responsiveMode?: 'side' | 'overlay' | 'sheet';
  onCloseRequest?(): void;
  /** 气泡/卡片点击打开 agent 详情的请求；nonce 变化时选中对应 agent 进入详情视图 */
  // — Chinese: agent detail request; a nonce change selects the agent and opens the detail view
  agentDetailRequest?: { threadId: string; nonce: number } | null;
  /** 注册"打开命令终端面板"的回调，供气泡命令块调用 */
  // — Chinese: register the open-command-terminal handler for bubble command blocks
  onOpenCommandTerminal?(handler: (itemId: string) => void): void;
  suspendBrowser?: boolean;
  showOps?: boolean;
  opsTask?: OpsTaskSession | null;
  opsTaskEvents?: OpsTaskTimelineEvent[];
  opsTaskBusy?: boolean;
  opsKnowledgeScope?: KnowledgeScopeSelection | null;
  onOpsKnowledgeScopeChange?(selection: KnowledgeScopeSelection | null): void;
  onOpsTaskAction?(action: 'pause' | 'resume' | 'cancel' | 'confirm' | 'reject_continue' | 'propose_patch' | 'approve_patch' | 'reject_patch'): void;
  onOpsRunTest?(testId: string): void;
  onOpsSaveIncident?(): void;
}) {
  const zh = locale === 'zh';
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [terminalRoots, setTerminalRoots] = useState<Record<string, string>>({});
  // 命令终端预览：气泡命令块"终端"按钮选中的命令条目 id（null = 面板关闭）
  // — Chinese: command-terminal preview state — the selected command item id (null = closed)
  const [commandTerminalItemId, setCommandTerminalItemId] = useState<string | null>(null);
  const [browserNavigationRequest, setBrowserNavigationRequest] = useState<{ url: string; nonce: number; threadId: string } | null>(null);
  const browserNavigationNonceRef = useRef(0);
  const handledPreviewRequestKeyRef = useRef('');
  const hasActiveThread = Boolean(activeThreadId && activeThread);
  // A persisted thread mode is only historical metadata. Render Ops only
  // when the caller has an explicit active session or task detail.
  const opsVisible = hasActiveThread && (showOps || Boolean(opsTask));
  const mainAgentThreadId = activeThreadId || 'main';

  useEffect(() => {
    setSelectedAgentId(null);
  }, [activeThreadId]);

  // agent 详情请求 → 若该 agent 在节点树中，选中并进入详情视图
  // — Chinese: agent detail request → select the agent (if present) and open its detail view
  const handledAgentDetailNonceRef = useRef(0);
  useEffect(() => {
    if (!agentDetailRequest || agentDetailRequest.nonce === handledAgentDetailNonceRef.current) return;
    handledAgentDetailNonceRef.current = agentDetailRequest.nonce;
    if (!hasActiveThread) return;
    setSelectedAgentId((current) => current === agentDetailRequest.threadId ? current : agentDetailRequest.threadId);
  }, [agentDetailRequest, hasActiveThread]);

  useEffect(() => {
    setTerminalRoots({});
    // Navigation and preview requests belong to one thread/workspace. Clear
    // both on every scope change so a new thread cannot consume stale work.
    setBrowserNavigationRequest(null);
    setCommandTerminalItemId(null);
    handledPreviewRequestKeyRef.current = '';
  }, [activeThreadId, hasActiveThread, terminalWorkspaceRoot, workspaceRoot]);

  // 气泡命令块"终端"按钮 → 打开右侧命令终端面板并选中该命令
  // — Chinese: bubble "Terminal" button → open the right command-terminal pane
  const handlePreviewCommand = (itemId: string): void => {
    if (!hasActiveThread) return;
    setCommandTerminalItemId(itemId);
  };

  // 把打开回调注册给上层（气泡里的命令块经此触发）
  // — Chinese: register the open handler upward so bubble command blocks can trigger it
  useEffect(() => {
    onOpenCommandTerminal?.(handlePreviewCommand);
  }, [onOpenCommandTerminal]);

  const handleOpenTerminalAt = (directory: string): void => {
    if (!hasActiveThread) return;
    const tabId = onOpenUtilityTab('terminal');
    setTerminalRoots((current) => ({
      ...current,
      [tabId]: directory || terminalWorkspaceRoot || workspaceRoot,
    }));
  };

  const handleOpenHtmlInBrowser = (path: string): void => {
    if (!hasActiveThread || !workspaceRoot || !path) return;
    const url = workspaceFileToUrl(workspaceRoot, path);
    browserNavigationNonceRef.current += 1;
    setBrowserNavigationRequest({ url, nonce: browserNavigationNonceRef.current, threadId: activeThreadId });
    onOpenUtilityTab('browser');
  };

  useEffect(() => {
    if (!hasActiveThread || !externalPreviewRequest?.path) return;
    if (externalPreviewRequest.threadId && externalPreviewRequest.threadId !== activeThreadId) return;
    const previewRequestKey = `${externalPreviewRequest.path}\u0000${externalPreviewRequest.nonce ?? ''}\u0000${externalPreviewRequest.pin ? '1' : '0'}`;
    if (handledPreviewRequestKeyRef.current === previewRequestKey) return;
    handledPreviewRequestKeyRef.current = previewRequestKey;
    if (activeTab !== 'files') {
      onOpenUtilityTab('files');
    }
  }, [externalPreviewRequest?.nonce, externalPreviewRequest?.path, externalPreviewRequest?.pin, externalPreviewRequest?.threadId, activeThreadId, activeTab, hasActiveThread, onOpenUtilityTab]);

  const workbench = useMemo(() => buildAgentWorkbench({
    mainThreadId: mainAgentThreadId,
    threadChildren,
    traceSummary,
    runtimeItems,
    recentTraces,
    busy,
    zh,
    currentRunId,
  }), [mainAgentThreadId, threadChildren, traceSummary, runtimeItems, recentTraces, busy, zh, currentRunId]);

  const agentStageRows = useMemo(() => buildAgentStageRows({
    activeThreadId: mainAgentThreadId,
    activeThreadTitle: activeThread?.title ?? '',
    locale,
    busy,
    children: buildSubagentStatusRows(threadChildren, locale),
  }), [mainAgentThreadId, activeThread?.title, locale, busy, threadChildren]);

  const runningAgentCount = useMemo(() => {
    return workbench.nodes.filter(n => n.status === 'running' || n.status === 'waiting').length;
  }, [workbench.nodes]);

  const selectedNode = useMemo(() => {
    if (!selectedAgentId) return null;
    return workbench.nodes.find(n => n.threadId === selectedAgentId) ?? null;
  }, [workbench.nodes, selectedAgentId]);

  // 详情视图数据：子 agent 取 child.items，主 agent 取 runtimeItems
  // — Chinese: detail-view data — child.items for sub-agents, runtimeItems for the primary agent
  const selectedAgentItems = useMemo<ThreadItem[]>(() => {
    if (!selectedAgentId) return [];
    if (selectedAgentId === mainAgentThreadId) return runtimeItems;
    return threadChildren.find((child) => child.thread.threadId === selectedAgentId)?.items ?? [];
  }, [selectedAgentId, mainAgentThreadId, runtimeItems, threadChildren]);

  const selectedAgentInstruction = useMemo(() => {
    if (!selectedAgentId || selectedAgentId === mainAgentThreadId) return undefined;
    const child = threadChildren.find((entry) => entry.thread.threadId === selectedAgentId);
    if (!child) return undefined;
    const turnInput = child.latestTurn?.userInput;
    if (turnInput && typeof turnInput === 'object' && 'type' in turnInput && (turnInput as { type?: string; text?: string }).type === 'text') {
      const text = (turnInput as { text?: string }).text;
      if (text?.trim()) return text;
    }
    return child.latestCollabItem?.prompt ?? undefined;
  }, [selectedAgentId, mainAgentThreadId, threadChildren]);

  const memoryExcluded = activeThread?.tags?.memoryExcluded === 'true';
  const shouldRenderFilesPanel = hasActiveThread && openUtilityTabs.includes('files');
  const shouldRenderBrowserWorkbench = hasActiveThread && openUtilityTabs.includes('browser');
  const terminalTabs = hasActiveThread ? openUtilityTabs.filter(isTerminalUtilityWorkbenchTab) : [];

  const handleTabChange = (tab: WorkbenchTab) => {
    onTabChange(tab);
  };

  const handleSelectAgent = (threadId: string) => {
    setSelectedAgentId((current) => current === threadId ? null : threadId);
  };

  const handleJumpToTrace = (opts: { itemId: string; runId: string; eventId?: string }) => {
    onJumpToMonitor?.({ itemId: opts.itemId, eventId: opts.eventId, runId: opts.runId, threadId: activeThreadId });
  };

  return (
    <aside className={`eventPane workbenchPane workbench-${responsiveMode ?? 'side'}`}>
      <WorkbenchTabs
        activeTab={activeTab}
        onTabChange={handleTabChange}
        pinnedTabs={pinnedTabs}
        onTogglePinnedTab={onTogglePinnedTab}
        openUtilityTabs={hasActiveThread ? openUtilityTabs : []}
        onOpenUtilityTab={onOpenUtilityTab}
        onCloseUtilityTab={onCloseUtilityTab}
        runningAgentCount={hasActiveThread ? runningAgentCount : 0}
        utilitiesEnabled={hasActiveThread}
        showOps={opsVisible}
        locale={locale}
      />

      {responsiveMode === 'overlay' || responsiveMode === 'sheet' ? (
        <button
          type="button"
          className="workbenchCloseBtn"
          onClick={onCloseRequest}
          aria-label={zh ? '关闭' : 'Close'}
        >
          <Icon name="x" />
        </button>
      ) : null}

      <div className="workbenchContent">
        <div
          className={workbenchPanelClassName('activity', activeTab)}
          data-state={activeTab === 'activity' ? 'active' : 'inactive'}
          aria-hidden={activeTab !== 'activity'}
          inert={activeTab !== 'activity'}
        >
          {hasActiveThread ? <LiveActivityHud
            traceSummary={traceSummary}
            currentPhase={workbench.currentPhase}
            recentEvents={workbench.recentEvents}
            controlCapabilities={controlCapabilities}
            busy={busy}
            onInterrupt={onInterrupt}
            onResume={onResume}
            onRollback={onRollback}
            onJumpToTrace={handleJumpToTrace}
            locale={locale}
          /> : null}
        </div>

        <div
          className={workbenchPanelClassName('agents', activeTab)}
          data-state={activeTab === 'agents' ? 'active' : 'inactive'}
          aria-hidden={activeTab !== 'agents'}
          inert={activeTab !== 'agents'}
        >
          {hasActiveThread ? (
            // 卡片视图与详情视图互斥显示：点卡片/气泡名字进详情，"返回卡片"回列表
            // — Chinese: card view and detail view are mutually exclusive; a card or
            //   bubble name opens the detail, "back" returns to the cards.
            selectedNode ? (
              <div className="workbenchAgentDetailWrap">
                <AgentConversationView
                  locale={locale}
                  node={selectedNode}
                  items={selectedAgentItems}
                  instruction={selectedAgentInstruction}
                  onBack={() => setSelectedAgentId(null)}
                />
              </div>
            ) : (
              <div className="workbenchAgentTreeWrap">
                <AgentStagePanel
                  locale={locale}
                  rows={agentStageRows}
                  selectedThreadId={selectedAgentId}
                  onSelectAgent={handleSelectAgent}
                />
              </div>
            )
          ) : null}
        </div>

        {opsVisible ? (
          <div
            className={workbenchPanelClassName('ops', activeTab)}
            data-state={activeTab === 'ops' ? 'active' : 'inactive'}
            data-testid="ops-workbench-panel"
            aria-hidden={activeTab !== 'ops'}
            inert={activeTab !== 'ops'}
          >
            <OpsKnowledgeStatus locale={locale} mode="select" value={opsKnowledgeScope} onChange={onOpsKnowledgeScopeChange} />
            {hasActiveThread && opsTask ? (
              <OpsTaskInspector
                locale={locale}
                task={opsTask}
                events={opsTaskEvents}
                busy={opsTaskBusy}
                onAction={onOpsTaskAction}
                onRunTest={onOpsRunTest}
                onSaveIncident={onOpsSaveIncident}
              />
            ) : (
              <div className="opsWorkbenchEmpty">
                <Icon name="monitor" />
                <strong>{zh ? '运维工作台' : 'Ops workbench'}</strong>
                <span>{zh ? '启动一次 Ops 运维调查后，任务详情会显示在这里。' : 'Start an Ops investigation to see task details here.'}</span>
              </div>
            )}
          </div>
        ) : null}

        {commandTerminalItemId ? (
          <div className="workbenchCommandTerminal">
            <CommandTerminalPane
              locale={locale}
              items={runtimeItems}
              selectedItemId={commandTerminalItemId}
              onSelectItem={setCommandTerminalItemId}
              onClose={() => setCommandTerminalItemId(null)}
            />
          </div>
        ) : null}

        {shouldRenderFilesPanel ? (
          <div
            className={workbenchPanelClassName('files', activeTab)}
            data-state={activeTab === 'files' ? 'active' : 'inactive'}
            aria-hidden={activeTab !== 'files'}
            inert={activeTab !== 'files'}
          >
            <WorkspaceFilesPanel
              locale={locale}
              workspaceRoot={hasActiveThread ? workspaceRoot : ''}
              externalPreviewRequest={externalPreviewRequest}
              onOpenTerminalAt={handleOpenTerminalAt}
              onOpenSystemLocation={onOpenSystemLocation}
              onOpenHtmlInBrowser={handleOpenHtmlInBrowser}
              onAddFileToConversation={onAddFileToConversation}
            />
          </div>
        ) : null}

        {shouldRenderBrowserWorkbench ? (
          <div
            className={workbenchPanelClassName('browser', activeTab)}
            data-state={activeTab === 'browser' ? 'active' : 'inactive'}
            aria-hidden={activeTab !== 'browser'}
            inert={activeTab !== 'browser'}
          >
            <BrowserWorkbench
              active={activeTab === 'browser' && !suspendBrowser}
              threadId={activeThreadId}
              navigationRequest={browserNavigationRequest}
            />
          </div>
        ) : null}

        {terminalTabs.map((tabId) => (
          <div
            className={workbenchPanelClassName(tabId, activeTab)}
            data-state={activeTab === tabId ? 'active' : 'inactive'}
            aria-hidden={activeTab !== tabId}
            inert={activeTab !== tabId}
            key={tabId}
          >
            <TerminalPanel
              active={activeTab === tabId}
              locale={locale}
              threadId={activeThreadId}
              workspaceRoot={terminalRoots[tabId] ?? (hasActiveThread ? terminalWorkspaceRoot ?? workspaceRoot : '')}
            />
          </div>
        ))}
      </div>

      {activeThread && onToggleMemoryExcluded ? (
        <div className="workbenchFooter">
          <label className="toggle">
            <input
              checked={memoryExcluded}
              onChange={(event) => onToggleMemoryExcluded(event.target.checked)}
              type="checkbox"
            />
            <span className="settingRow">
              <span className="settingLabel">
                {zh ? '此线程不生成记忆' : 'Exclude from memory'}
                <span className="settingHelpIcon">
                  <Icon name="question" />
                </span>
              </span>
              <span className="settingTooltip">
                <strong>{zh ? '此线程不生成记忆' : 'Exclude from memory extraction'}</strong>
                {zh
                  ? '开启后，这个对话的内容不会被提取到长期记忆库里。'
                  : 'When enabled, this conversation won\'t be saved to long-term memory.'}
              </span>
            </span>
          </label>
        </div>
      ) : null}
    </aside>
  );
}

function workbenchPanelClassName(tab: WorkbenchTab, activeTab: WorkbenchTab): string {
  const base = tab === 'activity' ? 'workbenchActivity' : tab === 'agents' ? 'workbenchAgents' : tab === 'ops' ? 'workbenchOps' : tab === 'browser' ? 'workbenchBrowser' : isTerminalUtilityWorkbenchTab(tab) ? 'workbenchTerminal' : 'workbenchFiles';
  return `${base} workbenchPanel${tab === activeTab ? ' active' : ' inactive'}`;
}

/** Build a local file URL so the Electron WebContentsView can resolve relative assets. */
function workspaceFileToUrl(workspaceRoot: string, relativePath: string): string {
  const root = workspaceRoot.trim().replace(/[\\/]+$/, '');
  const safeRelativePath = relativePath
    .replace(/\\/g, '/')
    .split('/')
    .filter((segment) => segment !== '' && segment !== '.' && segment !== '..')
    .join('/');
  const absolutePath = `${root}/${safeRelativePath}`.replace(/\\/g, '/');
  const withLeadingSlash = absolutePath.startsWith('/') ? absolutePath : `/${absolutePath}`;
  const encodedPath = withLeadingSlash
    .split('/')
    .map((segment, index) => index === 0 ? '' : encodeURIComponent(segment).replace(/%3A/gi, ':'))
    .join('/');
  return `file://${encodedPath}`;
}
