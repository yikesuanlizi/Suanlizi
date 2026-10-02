import { useCallback, useEffect, useRef, useState } from 'react';
import type { Locale } from '../config/config.js';
import type { ThreadChildInfo, ThreadItem, ThreadMeta } from '../shared/types.js';
import type { TaskRuntimeMonitorState } from '../features/monitor/taskRuntimeMonitor.js';
import type { RunControlCapabilities, RunTraceEnvelope, RunTraceSummary } from '@suanlizi/protocol';
import type { ExternalPreviewRequest } from './WorkspaceFilesPanel.js';
import { WorkspaceWorkbench } from './workbench/WorkspaceWorkbench.js';
import {
  createTerminalUtilityWorkbenchTab,
  isUtilityWorkbenchTab,
  type UtilityWorkbenchTab,
  type UtilityWorkbenchTabKind,
  type WorkbenchTab,
} from './workbench/WorkbenchTabs.js';
import { readStoredWorkbenchState, writeStoredWorkbenchState } from './workbench/workbenchState.js';
import { showItemInSystemFolder } from '../api/desktopBridge.js';
import type { OpsTaskSession } from '@suanlizi/protocol';
import type { OpsTaskTimelineEvent } from './workbench/OpsTaskInspector.js';
import type { KnowledgeScopeSelection } from '../api/knowledgeClient.js';

export type RightPaneTab = WorkbenchTab;

export function RightPane({
  activeTab: initialActiveTab,
  activeThreadId,
  activeThreadTitle,
  activeThread,
  busy,
  threadChildren,
  locale,
  workspaceRoot,
  terminalWorkspaceRoot,
  onTabChange,
  onToggleMemoryExcluded,
  externalPreviewRequest,
  taskRuntimeState,
  runtimeItems = [],
  onJumpToMonitor,
  traceSummary,
  currentRunId,
  controlCapabilities,
  recentTraces,
  onInterrupt,
  onResume,
  onRollback,
  responsiveMode,
  onCloseRequest,
  agentDetailRequest,
  onOpenCommandTerminal,
  onAddFileToConversation,
  browserRequestVersion = 0,
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
  activeTab?: RightPaneTab;
  activeThreadId: string;
  activeThreadTitle: string;
  activeThread?: ThreadMeta | null;
  busy: boolean;
  threadChildren: ThreadChildInfo[];
  locale: Locale;
  workspaceRoot: string;
  terminalWorkspaceRoot?: string;
  onTabChange?(tab: RightPaneTab): void;
  onToggleMemoryExcluded?(excluded: boolean): void;
  externalPreviewRequest?: ExternalPreviewRequest | null;
  taskRuntimeState?: TaskRuntimeMonitorState;
  runtimeItems?: ThreadItem[];
  onJumpToMonitor?(opts: { runId?: string; eventId?: string; itemId?: string; threadId?: string }): void;
  traceSummary?: RunTraceSummary | null;
  currentRunId?: string;
  controlCapabilities?: RunControlCapabilities;
  recentTraces?: RunTraceEnvelope[];
  onInterrupt?(): void;
  onResume?(): void;
  onRollback?(checkpointId?: string): void;
  responsiveMode?: 'side' | 'overlay' | 'sheet';
  onCloseRequest?(): void;
  /** 气泡/卡片点击打开 agent 详情的请求；nonce 变化触发 agents tab + 选中联动 */
  // — Chinese: request to open an agent detail; a nonce change switches to the agents tab
  agentDetailRequest?: { threadId: string; nonce: number } | null;
  /** 注册"打开命令终端面板"的回调，供气泡命令块调用 */
  // — Chinese: register the open-command-terminal handler for bubble command blocks
  onOpenCommandTerminal?(handler: (itemId: string) => void): void;
  onAddFileToConversation?(path: string): void;
  browserRequestVersion?: number;
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
  void activeThreadTitle;
  void taskRuntimeState;
  const hasActiveThread = Boolean(activeThreadId && activeThread);
  const threadScope = hasActiveThread ? activeThreadId.trim() : '';
  const initialWorkbenchState = threadScope
    ? readStoredWorkbenchState(threadScope)
    : { activeTab: 'activity' as RightPaneTab, openUtilityTabs: [] as UtilityWorkbenchTab[] };
  const [activeTab, setActiveTab] = useState<RightPaneTab>(() => (
    hasActiveThread ? (initialActiveTab ?? initialWorkbenchState.activeTab) : 'activity'
  ));
  const [openUtilityTabs, setOpenUtilityTabs] = useState<UtilityWorkbenchTab[]>(() => {
    if (!hasActiveThread) return [];
    const stored = initialWorkbenchState;
    const initialUtility = initialActiveTab && isUtilityWorkbenchTab(initialActiveTab) ? [initialActiveTab] : [];
    return [...new Set([...stored.openUtilityTabs, ...initialUtility])];
  });
  const contextKey = `${activeThreadId}::${workspaceRoot}::${terminalWorkspaceRoot ?? ''}`;
  const previousContextKeyRef = useRef<string | null>(null);
  const contextChanged = previousContextKeyRef.current !== null && previousContextKeyRef.current !== contextKey;
  const handledBrowserRequestVersion = useRef(0);
  // Ops is an explicit task surface. Historical thread metadata must not
  // open the workbench when the user merely opens or switches conversations.
  const opsVisible = hasActiveThread && (showOps || Boolean(opsTask));

  useEffect(() => {
    const previous = previousContextKeyRef.current;
    previousContextKeyRef.current = contextKey;
    // `initialActiveTab` belongs to the first mounted context. Reusing it
    // after a thread/workspace switch would inject the previous thread's
    // browser/files/terminal tab into the new scope.
    if (previous === contextKey) return;
    const stored = threadScope
      ? readStoredWorkbenchState(threadScope)
      : { activeTab: 'activity' as RightPaneTab, openUtilityTabs: [] as UtilityWorkbenchTab[] };
    setActiveTab(stored.activeTab);
    setOpenUtilityTabs(stored.openUtilityTabs);
    onTabChange?.(stored.activeTab);
  }, [contextKey, onTabChange, threadScope]);

  useEffect(() => {
    if (hasActiveThread) return;
    setActiveTab('activity');
    setOpenUtilityTabs([]);
  }, [hasActiveThread]);

  useEffect(() => {
    if (opsVisible || activeTab !== 'ops') return;
    setActiveTab('activity');
    const stored = readStoredWorkbenchState(threadScope);
    writeStoredWorkbenchState({ ...stored, activeTab: 'activity' }, threadScope);
    onTabChange?.('activity');
  }, [activeTab, onTabChange, opsVisible, threadScope]);

  const handleTabChange = useCallback((tab: RightPaneTab) => {
    if (!hasActiveThread && isUtilityWorkbenchTab(tab)) return;
    if (isUtilityWorkbenchTab(tab)) {
      setOpenUtilityTabs((tabs) => tabs.includes(tab) ? tabs : [...tabs, tab]);
    }
    setActiveTab(tab);
    const stored = readStoredWorkbenchState(threadScope);
    writeStoredWorkbenchState({
      activeTab: tab,
      openUtilityTabs: isUtilityWorkbenchTab(tab) ? [...new Set([...stored.openUtilityTabs, tab])] : stored.openUtilityTabs,
    }, threadScope);
    onTabChange?.(tab);
  }, [hasActiveThread, onTabChange, threadScope]);

  useEffect(() => {
    if (browserRequestVersion === 0 || browserRequestVersion === handledBrowserRequestVersion.current) return;
    handledBrowserRequestVersion.current = browserRequestVersion;
    handleTabChange('browser');
  }, [browserRequestVersion, handleTabChange]);

  // agent 详情请求（气泡名字/卡片点击/自动弹出）→ 切到智能体 tab 并下传选中请求
  // — Chinese: agent detail request → switch to the agents tab and pass the selection down
  const handledAgentDetailNonceRef = useRef(0);
  useEffect(() => {
    if (!agentDetailRequest || agentDetailRequest.nonce === handledAgentDetailNonceRef.current) return;
    handledAgentDetailNonceRef.current = agentDetailRequest.nonce;
    if (hasActiveThread) handleTabChange('agents');
  }, [agentDetailRequest, handleTabChange, hasActiveThread]);

  const handleOpenUtilityTab = useCallback((kind: UtilityWorkbenchTabKind): UtilityWorkbenchTab => {
    const tab = kind === 'terminal' ? createTerminalUtilityWorkbenchTab() : kind;
    if (!hasActiveThread) return tab;
    setOpenUtilityTabs((tabs) => tabs.includes(tab) ? tabs : [...tabs, tab]);
    setActiveTab(tab);
    const stored = readStoredWorkbenchState(threadScope);
    writeStoredWorkbenchState({
      activeTab: tab,
      openUtilityTabs: [...new Set([...stored.openUtilityTabs, tab])],
    }, threadScope);
    onTabChange?.(tab);
    return tab;
  }, [hasActiveThread, onTabChange, threadScope]);

  const handleCloseUtilityTab = useCallback((tab: UtilityWorkbenchTab) => {
    if (!hasActiveThread || !threadScope) return;
    const tabIndex = openUtilityTabs.indexOf(tab);
    const remainingUtilityTabs = openUtilityTabs.filter((item) => item !== tab);
    const nextActiveTab: RightPaneTab = activeTab === tab
      ? remainingUtilityTabs[tabIndex] ?? remainingUtilityTabs[tabIndex - 1] ?? 'activity'
      : activeTab;

    setOpenUtilityTabs(remainingUtilityTabs);
    writeStoredWorkbenchState({
      activeTab: nextActiveTab,
      openUtilityTabs: remainingUtilityTabs,
    }, threadScope);
    if (activeTab !== tab) return;
    setActiveTab(nextActiveTab);
    onTabChange?.(nextActiveTab);
  }, [activeTab, hasActiveThread, onTabChange, openUtilityTabs, threadScope]);

  return (
    <WorkspaceWorkbench
      activeThread={activeThread}
      activeThreadId={activeThreadId}
      busy={busy}
      threadChildren={threadChildren}
      runtimeItems={runtimeItems}
      recentTraces={recentTraces}
      traceSummary={traceSummary}
      currentRunId={currentRunId}
      controlCapabilities={controlCapabilities}
      locale={locale}
      workspaceRoot={hasActiveThread ? workspaceRoot : ''}
      terminalWorkspaceRoot={hasActiveThread ? terminalWorkspaceRoot : undefined}
      externalPreviewRequest={externalPreviewRequest}
      activeTab={contextChanged ? 'activity' : activeTab}
      onTabChange={handleTabChange}
      openUtilityTabs={hasActiveThread && !contextChanged ? openUtilityTabs : []}
      onOpenUtilityTab={handleOpenUtilityTab}
      onCloseUtilityTab={handleCloseUtilityTab}
      onOpenSystemLocation={(path) => { void showItemInSystemFolder(path); }}
      onAddFileToConversation={onAddFileToConversation}
      onJumpToMonitor={onJumpToMonitor}
      onInterrupt={onInterrupt}
      onResume={onResume}
      onRollback={onRollback}
      onToggleMemoryExcluded={onToggleMemoryExcluded}
      responsiveMode={responsiveMode}
      onCloseRequest={onCloseRequest}
      agentDetailRequest={agentDetailRequest}
      onOpenCommandTerminal={onOpenCommandTerminal}
      suspendBrowser={suspendBrowser}
      showOps={opsVisible}
      opsTask={opsTask}
      opsTaskEvents={opsTaskEvents}
      opsTaskBusy={opsTaskBusy}
      opsKnowledgeScope={opsKnowledgeScope}
      onOpsKnowledgeScopeChange={onOpsKnowledgeScopeChange}
      onOpsTaskAction={onOpsTaskAction}
      onOpsRunTest={onOpsRunTest}
      onOpsSaveIncident={onOpsSaveIncident}
    />
  );
}
