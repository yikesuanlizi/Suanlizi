import { useEffect, useMemo, useRef, useState } from 'react';
import type { Locale } from '../../config/config.js';
import type { ThreadChildInfo, ThreadItem, ThreadMeta } from '../../shared/types.js';
import type { RunControlCapabilities, RunTraceEnvelope, RunTraceSummary } from '@suanlizi/protocol';
import type { ExternalPreviewRequest } from '../WorkspaceFilesPanel.js';
import { WorkspaceFilesPanel } from '../WorkspaceFilesPanel.js';
import { Icon } from '../Icon.js';
import { buildAgentWorkbench } from '../../features/agents/agentWorkbenchModel.js';
import { buildAgentStageRows, buildSubagentStatusRows } from '../../features/agents/subagents.js';
import { WorkbenchTabs, type WorkbenchTab } from './WorkbenchTabs.js';
import { LiveActivityHud } from './LiveActivityHud.js';
import { AgentInspector } from './AgentInspector.js';
import { AgentStagePanel } from '../AgentStagePanel.js';
import { TerminalPanel } from './TerminalPanel.js';
import type { OpsTaskSession } from '@suanlizi/protocol';
import { OpsTaskAnchorCard, type OpsAnchorAction } from '../OpsTaskAnchorCard.js';

export function WorkspaceWorkbench({
  activeThread,
  activeThreadId,
  busy,
  threadChildren,
  runtimeItems = [],
  recentTraces = [],
  taskRuntimeState: _taskRuntimeState,
  traceSummary,
  currentRunId,
  controlCapabilities,
  locale,
  workspaceRoot,
  externalPreviewRequest,
  activeTab,
  onTabChange,
  onJumpToMonitor,
  onInterrupt,
  onResume,
  onRollback,
  onToggleMemoryExcluded,
  onAddFileToConversation,
  responsiveMode,
  onCloseRequest,
  showOps = false,
  opsTask = null,
  opsTaskBusy = false,
  onOpsTaskAction,
}: {
  activeThread?: ThreadMeta | null;
  activeThreadId: string;
  busy: boolean;
  threadChildren: ThreadChildInfo[];
  runtimeItems?: ThreadItem[];
  recentTraces?: RunTraceEnvelope[];
  taskRuntimeState?: unknown;
  traceSummary?: RunTraceSummary | null;
  currentRunId?: string;
  controlCapabilities?: RunControlCapabilities;
  locale: Locale;
  workspaceRoot: string;
  externalPreviewRequest?: ExternalPreviewRequest | null;
  activeTab: WorkbenchTab;
  onTabChange(tab: WorkbenchTab): void;
  onJumpToMonitor?(opts: { runId?: string; eventId?: string; itemId?: string; threadId?: string }): void;
  onInterrupt?(): void;
  onResume?(): void;
  onRollback?(checkpointId?: string): void;
  onToggleMemoryExcluded?(excluded: boolean): void;
  onAddFileToConversation?(path: string): void;
  responsiveMode?: 'side' | 'overlay' | 'sheet';
  onCloseRequest?(): void;
  showOps?: boolean;
  opsTask?: OpsTaskSession | null;
  opsTaskBusy?: boolean;
  onOpsTaskAction?(action: OpsAnchorAction): void | Promise<void>;
}) {
  const zh = locale === 'zh';
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [terminalRoot, setTerminalRoot] = useState(workspaceRoot);
  const [filesPanelMounted, setFilesPanelMounted] = useState(false);
  const handledPreviewRequestKeyRef = useRef('');
  const hasActiveThread = Boolean(activeThreadId && activeThread);
  const opsVisible = hasActiveThread && showOps && Boolean(opsTask);
  const mainAgentThreadId = activeThreadId || 'main';

  useEffect(() => {
    if (opsVisible || activeTab !== 'ops') return;
    onTabChange('activity');
  }, [activeTab, onTabChange, opsVisible]);

  useEffect(() => {
    setSelectedAgentId(null);
  }, [activeThreadId]);

  useEffect(() => {
    setTerminalRoot(workspaceRoot);
  }, [workspaceRoot]);

  const handleOpenTerminalAt = (directory: string): void => {
    setTerminalRoot(directory || workspaceRoot);
    onTabChange('terminal');
  };

  useEffect(() => {
    if (!externalPreviewRequest?.path) return;
    const previewRequestKey = `${externalPreviewRequest.path}\u0000${externalPreviewRequest.nonce ?? ''}\u0000${externalPreviewRequest.pin ? '1' : '0'}`;
    if (handledPreviewRequestKeyRef.current === previewRequestKey) return;
    handledPreviewRequestKeyRef.current = previewRequestKey;
    if (activeTab !== 'files') {
      onTabChange('files');
    }
  }, [externalPreviewRequest?.nonce, externalPreviewRequest?.path, externalPreviewRequest?.pin, activeTab, onTabChange]);

  useEffect(() => {
    if (activeTab === 'files' || externalPreviewRequest?.path) {
      setFilesPanelMounted(true);
    }
  }, [activeTab, externalPreviewRequest?.path]);

  useEffect(() => {
    if (filesPanelMounted || !workspaceRoot) return;
    const idleWindow = window as Window & {
      cancelIdleCallback?: (id: number) => void;
      requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number;
    };
    let timeoutId: number | undefined;
    let idleId: number | undefined;
    const mountFilesPanel = () => setFilesPanelMounted(true);

    if (idleWindow.requestIdleCallback) {
      idleId = idleWindow.requestIdleCallback(mountFilesPanel, { timeout: 1400 });
    } else {
      timeoutId = window.setTimeout(mountFilesPanel, 700);
    }

    return () => {
      if (idleId !== undefined) idleWindow.cancelIdleCallback?.(idleId);
      if (timeoutId !== undefined) window.clearTimeout(timeoutId);
    };
  }, [filesPanelMounted, workspaceRoot]);

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

  const memoryExcluded = activeThread?.tags?.memoryExcluded === 'true';
  const shouldRenderFilesPanel = filesPanelMounted || activeTab === 'files' || Boolean(externalPreviewRequest?.path);

  const handleTabChange = (tab: WorkbenchTab) => {
    onTabChange(tab);
  };

  const handleSelectAgent = (threadId: string) => {
    setSelectedAgentId((current) => current === threadId ? null : threadId);
  };

  const handleJumpToAgentMonitor = (threadId: string) => {
    onJumpToMonitor?.({ threadId });
  };

  const handleJumpToTrace = (opts: { itemId: string; runId: string; eventId?: string }) => {
    onJumpToMonitor?.({ itemId: opts.itemId, eventId: opts.eventId, runId: opts.runId, threadId: activeThreadId });
  };

  return (
    <aside className={`eventPane workbenchPane workbench-${responsiveMode ?? 'side'}`}>
      <WorkbenchTabs
        activeTab={activeTab}
        onTabChange={handleTabChange}
        runningAgentCount={runningAgentCount}
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

        {opsVisible ? (
          <div
            className={workbenchPanelClassName('ops', activeTab)}
            data-state={activeTab === 'ops' ? 'active' : 'inactive'}
            aria-hidden={activeTab !== 'ops'}
            inert={activeTab !== 'ops'}
          >
            {opsTask ? <OpsTaskAnchorCard locale={locale} task={opsTask} busy={opsTaskBusy} onAction={(action) => onOpsTaskAction?.(action)} /> : null}
          </div>
        ) : null}

        <div
          className={workbenchPanelClassName('agents', activeTab)}
          data-state={activeTab === 'agents' ? 'active' : 'inactive'}
          aria-hidden={activeTab !== 'agents'}
          inert={activeTab !== 'agents'}
        >
          {hasActiveThread ? <div className="workbenchAgentTreeWrap">
            <AgentStagePanel
              locale={locale}
              rows={agentStageRows}
              selectedThreadId={selectedAgentId}
              onSelectAgent={handleSelectAgent}
            />
          </div> : null}
          {hasActiveThread && selectedNode ? (
            <div className="workbenchAgentInspectorWrap">
              <AgentInspector
                node={selectedNode}
                onJumpToMonitor={handleJumpToAgentMonitor}
                locale={locale}
              />
            </div>
          ) : null}
        </div>

        {shouldRenderFilesPanel ? (
          <div
            className={workbenchPanelClassName('files', activeTab)}
            data-state={activeTab === 'files' ? 'active' : 'inactive'}
            aria-hidden={activeTab !== 'files'}
            inert={activeTab !== 'files'}
          >
            <WorkspaceFilesPanel
              locale={locale}
              workspaceRoot={workspaceRoot}
              externalPreviewRequest={externalPreviewRequest}
              onOpenTerminalAt={handleOpenTerminalAt}
              onAddFileToConversation={onAddFileToConversation}
            />
          </div>
        ) : null}

        <div
          className={workbenchPanelClassName('terminal', activeTab)}
          data-state={activeTab === 'terminal' ? 'active' : 'inactive'}
          aria-hidden={activeTab !== 'terminal'}
          inert={activeTab !== 'terminal'}
        >
          <TerminalPanel active={activeTab === 'terminal'} locale={locale} workspaceRoot={terminalRoot} threadId={activeThreadId} />
        </div>
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
  const base = tab === 'activity' ? 'workbenchActivity' : tab === 'agents' ? 'workbenchAgents' : tab === 'ops' ? 'workbenchOps' : tab === 'terminal' ? 'workbenchTerminal' : 'workbenchFiles';
  return `${base} workbenchPanel${tab === activeTab ? ' active' : ' inactive'}`;
}
