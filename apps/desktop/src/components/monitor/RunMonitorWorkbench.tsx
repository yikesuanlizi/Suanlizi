import { useEffect, useState, useCallback } from 'react';
import type { RunTraceCategory, RunTraceEnvelope } from '@suanlizi/protocol';
import type { RunRecord, ThreadWithRuns } from '../../shared/types.js';
import type { TracePageInfo } from '../../features/monitor/runMonitorState.js';
import { RunExplorer } from './RunExplorer.js';
import { TraceTimeline } from './TraceTimeline.js';
import { TraceInspector } from './TraceInspector.js';
import { SystemMonitorWidget } from './SystemMonitorWidget.js';
import type { SystemMonitorStatus } from '@suanlizi/protocol';

export interface RunMonitorWorkbenchProps {
  open: boolean;
  loading: boolean;
  loadError: string | null;
  runs: RunRecord[];
  traces: RunTraceEnvelope[];
  visibleTraces: RunTraceEnvelope[];
  threads: ThreadWithRuns[];
  selectedRunId: string;
  selectedRun: RunRecord | null;
  selectedEventId: string;
  traceFocusVersion: number;
  selectedTrace: RunTraceEnvelope | null;
  systemMonitorStatus?: SystemMonitorStatus | null;
  categoryFilter: RunTraceCategory[];
  errorsOnly: boolean;
  tracePage: TracePageInfo | null;
  expandedThreadId: string;
  autoRefresh: boolean;
  autoRefreshInterval: number;
  allCategories: RunTraceCategory[];
  zh: boolean;
  threadId: string;
  onClose(): void;
  onRefresh(): void;
  onControlRun(action: 'interrupt' | 'resume' | 'rollback', opts?: { checkpointId?: string }): void;
  onToggleThread(threadId: string): void;
  onSelectRun(runId: string): void;
  onSelectEvent(eventId: string): void;
  onToggleCategory(category: RunTraceCategory): void;
  onSetCategoryFilter(categories: RunTraceCategory[]): void;
  onSetErrorsOnly(value: boolean): void;
  onAutoRefreshChange(enabled: boolean): void;
  onAutoRefreshIntervalChange(ms: number): void;
  onLoadOlder(): void;
}

export function RunMonitorWorkbench(props: RunMonitorWorkbenchProps) {
  const {
    open,
    loading,
    loadError,
    runs,
    traces,
    visibleTraces,
    threads,
    selectedRunId,
    selectedRun,
    selectedEventId,
    traceFocusVersion,
    selectedTrace,
    systemMonitorStatus = null,
    categoryFilter,
    errorsOnly,
    tracePage,
    expandedThreadId,
    autoRefresh,
    autoRefreshInterval,
    allCategories,
    zh,
    threadId,
    onClose,
    onRefresh,
    onControlRun,
    onToggleThread,
    onSelectRun,
    onSelectEvent,
    onToggleCategory,
    onSetCategoryFilter,
    onSetErrorsOnly,
    onAutoRefreshChange,
    onAutoRefreshIntervalChange,
    onLoadOlder,
  } = props;

  const [activeView, setActiveView] = useState<'explorer' | 'timeline' | 'inspector'>('explorer');
  const [isMedium, setIsMedium] = useState(false);
  const [isNarrow, setIsNarrow] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    function onResize() {
      const w = window.innerWidth;
      setIsMedium(w < 1180 && w >= 768);
      setIsNarrow(w < 768);
    }
    onResize();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.stopPropagation();
        if (inspectorOpen && isMedium) {
          setInspectorOpen(false);
        } else {
          onClose();
        }
      }
    }
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open, onClose, inspectorOpen, isMedium]);

  useEffect(() => {
    if (selectedEventId) {
      if (isNarrow) setActiveView('inspector');
      else if (isMedium) setInspectorOpen(true);
    }
  }, [selectedEventId, isNarrow, isMedium]);

  const handleCopyJson = useCallback(() => {
    if (selectedTrace) {
      navigator.clipboard.writeText(JSON.stringify(selectedTrace, null, 2)).catch(() => {});
    }
  }, [selectedTrace]);

  const runningCount = runs.filter((r) => r.status === 'running').length;
  const failedCount = runs.filter((r) => r.status === 'failed' || r.status === 'blocked').length;
  const totalTokens = runs.reduce((sum, r) => sum + (r.inputTokens ?? 0) + (r.outputTokens ?? 0) + (r.reasoningOutputTokens ?? 0), 0);

  if (!open) return null;

  return (
    <div className="runMonitorWorkbench" role="dialog" aria-label={zh ? '运行监控工作台' : 'Run Monitor Workbench'}>
      <div className="runMonitorBackdrop" onClick={onClose} />
      <div className={`runMonitorPanel ${isNarrow ? 'runMonitorPanel--narrow' : isMedium ? 'runMonitorPanel--medium' : ''}`}>
        <div className="runMonitorHeader">
          <div className="runMonitorHeader__left">
            <h2 className="runMonitorHeader__title">{zh ? '运行监控' : 'Run Monitor'}</h2>
            <div className="runMonitorStats">
              <span className="runMonitorStat runMonitorStat--running">
                <span className="runMonitorStat__dot" style={{ backgroundColor: '#22c55e' }} />
                {zh ? `运行中 ${runningCount}` : `Running ${runningCount}`}
              </span>
              <span className="runMonitorStat runMonitorStat--failed">
                <span className="runMonitorStat__dot" style={{ backgroundColor: '#ef4444' }} />
                {zh ? `失败 ${failedCount}` : `Failed ${failedCount}`}
              </span>
              <span className="runMonitorStat">
                {zh ? `Token ${totalTokens.toLocaleString()}` : `${totalTokens.toLocaleString()} tokens`}
              </span>
            </div>
          </div>
          <div className="runMonitorHeader__center">
            {!isNarrow && (
              <>
                <label className="runMonitorToggle">
                  <input
                    type="checkbox"
                    checked={autoRefresh}
                    onChange={(e) => onAutoRefreshChange(e.target.checked)}
                  />
                  <span>{zh ? '自动刷新' : 'Auto-refresh'}</span>
                </label>
                {autoRefresh && (
                  <select
                    className="runMonitorInterval"
                    value={autoRefreshInterval}
                    onChange={(e) => onAutoRefreshIntervalChange(Number(e.target.value))}
                    aria-label={zh ? '刷新间隔' : 'Refresh interval'}
                  >
                    <option value={1000}>1s</option>
                    <option value={2000}>2s</option>
                    <option value={3000}>3s</option>
                    <option value={5000}>5s</option>
                    <option value={10000}>10s</option>
                  </select>
                )}
              </>
            )}
          </div>
          <div className="runMonitorHeader__right">
            <SystemMonitorWidget status={systemMonitorStatus} zh={zh} />
            <button
              type="button"
              className="runMonitorCloseBtn"
              onClick={onClose}
              aria-label={zh ? '关闭' : 'Close'}
            >
              ✕
            </button>
          </div>
        </div>

        {isNarrow && (
          <div className="runMonitorMobileTabs">
            <button
              type="button"
              className={`runMonitorTab ${activeView === 'explorer' ? 'runMonitorTab--active' : ''}`}
              onClick={() => setActiveView('explorer')}
            >
              {zh ? '运行列表' : 'Runs'}
            </button>
            <button
              type="button"
              className={`runMonitorTab ${activeView === 'timeline' ? 'runMonitorTab--active' : ''}`}
              onClick={() => setActiveView('timeline')}
            >
              {zh ? '时间线' : 'Timeline'}
            </button>
            <button
              type="button"
              className={`runMonitorTab ${activeView === 'inspector' ? 'runMonitorTab--active' : ''}`}
              onClick={() => setActiveView('inspector')}
            >
              {zh ? '详情' : 'Details'}
            </button>
          </div>
        )}

        <div className={`runMonitorBody ${isNarrow ? 'runMonitorBody--narrow' : isMedium ? 'runMonitorBody--medium' : ''}`}>
          {(!isNarrow || activeView === 'explorer') && (
            <RunExplorer
              threads={threads}
              runs={runs}
              selectedRunId={selectedRunId}
              expandedThreadId={expandedThreadId}
              loading={loading}
              loadError={loadError}
              threadId={threadId}
              zh={zh}
              onSelectRun={onSelectRun}
              onToggleThread={onToggleThread}
              onRefresh={onRefresh}
            />
          )}

          {(!isNarrow || activeView === 'timeline') && (
            <TraceTimeline
              traces={visibleTraces}
              visibleCount={visibleTraces.length}
              totalCount={traces.length}
              categoryFilter={categoryFilter}
              errorsOnly={errorsOnly}
              allCategories={allCategories}
              selectedEventId={selectedEventId}
              focusVersion={traceFocusVersion}
              selectedRun={selectedRun}
              hasMoreBefore={tracePage?.hasMoreBefore ?? false}
              loading={loading}
              zh={zh}
              onSelectEvent={onSelectEvent}
              onToggleCategory={onToggleCategory}
              onSetCategoryFilter={onSetCategoryFilter}
              onSetErrorsOnly={onSetErrorsOnly}
              onLoadOlder={onLoadOlder}
              controlCapabilities={selectedRun?.controlCapabilities}
              onControlRun={onControlRun}
            />
          )}

          {!isMedium && !isNarrow && (
            <TraceInspector
              selectedTrace={selectedTrace}
              selectedRun={selectedRun}
              zh={zh}
              onCopyJson={handleCopyJson}
            />
          )}
        </div>

        {isMedium && inspectorOpen && (
          <div className="runMonitorInspectorOverlay">
            <div className="runMonitorInspectorBackdrop" onClick={() => setInspectorOpen(false)} />
            <div className="runMonitorInspectorPanel">
              <TraceInspector
                selectedTrace={selectedTrace}
                selectedRun={selectedRun}
                zh={zh}
                onBack={() => setInspectorOpen(false)}
                onCopyJson={handleCopyJson}
              />
            </div>
          </div>
        )}

        {isNarrow && activeView === 'inspector' && (
          <div className="runMonitorMobileInspector">
            <TraceInspector
              selectedTrace={selectedTrace}
              selectedRun={selectedRun}
              zh={zh}
              onBack={() => setActiveView('timeline')}
              onCopyJson={handleCopyJson}
            />
          </div>
        )}
      </div>
    </div>
  );
}
