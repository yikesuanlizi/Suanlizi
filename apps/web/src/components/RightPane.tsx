import { useCallback, useEffect, useRef, useState } from 'react';
import type { Locale } from '../config/config.js';
import type { ThreadChildInfo, ThreadItem, ThreadMeta } from '../shared/types.js';
import type { TaskRuntimeMonitorState } from '../features/monitor/taskRuntimeMonitor.js';
import type { RunControlCapabilities, RunTraceEnvelope, RunTraceSummary } from '@suanlizi/protocol';
import type { OpsTaskSession } from '@suanlizi/protocol';
import type { OpsAnchorAction } from './OpsTaskAnchorCard.js';
import type { ExternalPreviewRequest } from './WorkspaceFilesPanel.js';
import { WorkspaceWorkbench } from './workbench/WorkspaceWorkbench.js';
import type { WorkbenchTab } from './workbench/WorkbenchTabs.js';

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
  onAddFileToConversation,
  showOps = false,
  opsTask = null,
  opsTaskBusy = false,
  onOpsTaskAction,
}: {
  activeTab?: RightPaneTab;
  activeThreadId: string;
  activeThreadTitle: string;
  activeThread?: ThreadMeta | null;
  busy: boolean;
  threadChildren: ThreadChildInfo[];
  locale: Locale;
  workspaceRoot: string;
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
  onAddFileToConversation?(path: string): void;
  showOps?: boolean;
  opsTask?: OpsTaskSession | null;
  opsTaskBusy?: boolean;
  onOpsTaskAction?(action: OpsAnchorAction): void | Promise<void>;
}) {
  void activeThreadTitle;
  void taskRuntimeState;
  const hasActiveThread = Boolean(activeThreadId && activeThread);
  const threadScope = hasActiveThread ? activeThreadId.trim() : '';
  const [activeTab, setActiveTab] = useState<RightPaneTab>(() => (
    hasActiveThread ? (initialActiveTab ?? readStoredRightPaneTab(threadScope)) : 'activity'
  ));
  const contextKey = `${activeThreadId}::${workspaceRoot}`;
  const previousContextKeyRef = useRef<string | null>(null);
  const contextChanged = previousContextKeyRef.current !== null && previousContextKeyRef.current !== contextKey;

  useEffect(() => {
    const previous = previousContextKeyRef.current;
    previousContextKeyRef.current = contextKey;
    if (previous === contextKey) return;
    const nextTab = threadScope ? readStoredRightPaneTab(threadScope) : 'activity';
    setActiveTab(nextTab);
    onTabChange?.(nextTab);
  }, [contextKey, onTabChange, threadScope]);

  const handleTabChange = useCallback((tab: RightPaneTab) => {
    if (!threadScope) return;
    setActiveTab(tab);
    try {
      localStorage.setItem(rightPaneStorageKey(threadScope), tab);
    } catch { /* best-effort local UI preference */ }
    onTabChange?.(tab);
  }, [onTabChange, threadScope]);

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
      workspaceRoot={workspaceRoot}
      externalPreviewRequest={externalPreviewRequest}
      activeTab={contextChanged ? 'activity' : activeTab}
      onTabChange={handleTabChange}
      onJumpToMonitor={onJumpToMonitor}
      onInterrupt={onInterrupt}
      onResume={onResume}
      onRollback={onRollback}
      onToggleMemoryExcluded={onToggleMemoryExcluded}
      onAddFileToConversation={onAddFileToConversation}
      responsiveMode={responsiveMode}
      onCloseRequest={onCloseRequest}
      showOps={showOps}
      opsTask={opsTask}
      opsTaskBusy={opsTaskBusy}
      onOpsTaskAction={onOpsTaskAction}
    />
  );
}

function rightPaneStorageKey(scope: string): string {
  return `nexus.rightPane.tab:${encodeURIComponent(scope)}`;
}

function readStoredRightPaneTab(scope?: string): RightPaneTab {
  const normalized = scope?.trim();
  if (!normalized) return 'activity';
  try {
    const stored = localStorage.getItem(rightPaneStorageKey(normalized));
    if (stored === 'files' || stored === 'agents' || stored === 'activity' || stored === 'terminal' || stored === 'ops') return stored;
    if (stored === 'status') return 'activity';
  } catch { /* best-effort local UI preference */ }
  return 'activity';
}
