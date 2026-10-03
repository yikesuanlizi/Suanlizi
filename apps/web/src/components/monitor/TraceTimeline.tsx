import { useEffect, useMemo, useRef, type Ref } from 'react';
import type { RunTraceCategory, RunTraceEnvelope } from '@suanlizi/protocol';
import type { RunControlCapabilities, RunRecord } from '../../shared/types.js';
import { TraceFilters } from './TraceFilters.js';
import {
  formatAbsoluteTime,
  formatDuration,
  formatRelativeTime,
  runStatusColor,
  runStatusLabel,
  traceCategoryLabel,
  traceIcon,
  traceLifecycleDot,
  traceSummary,
} from '../../features/monitor/traceFormatters.js';

interface TraceTimelineProps {
  traces: RunTraceEnvelope[];
  visibleCount: number;
  totalCount: number;
  categoryFilter: RunTraceCategory[];
  errorsOnly: boolean;
  allCategories: RunTraceCategory[];
  selectedEventId: string;
  focusVersion: number;
  selectedRun: RunRecord | null;
  hasMoreBefore: boolean;
  loading: boolean;
  zh: boolean;
  onSelectEvent(eventId: string): void;
  onToggleCategory(category: RunTraceCategory): void;
  onSetCategoryFilter(categories: RunTraceCategory[]): void;
  onSetErrorsOnly(value: boolean): void;
  onLoadOlder(): void;
  controlCapabilities?: RunControlCapabilities;
  onControlRun(action: 'interrupt' | 'resume' | 'rollback', opts?: { checkpointId?: string }): void;
}

export function TraceTimeline({
  traces,
  visibleCount,
  totalCount,
  categoryFilter,
  errorsOnly,
  allCategories,
  selectedEventId,
  focusVersion,
  selectedRun,
  hasMoreBefore,
  loading,
  zh,
  onSelectEvent,
  onToggleCategory,
  onSetCategoryFilter,
  onSetErrorsOnly,
  onLoadOlder,
  controlCapabilities,
  onControlRun,
}: TraceTimelineProps) {
  const selectedRowRef = useRef<HTMLButtonElement | null>(null);
  const displayTraces = useMemo(
    () => [...traces].sort((a, b) => b.sequence - a.sequence),
    [traces],
  );

  useEffect(() => {
    if (!selectedEventId) return;
    const row = selectedRowRef.current;
    if (!row) return;
    const frame = window.requestAnimationFrame(() => {
      row.scrollIntoView({ block: 'center', behavior: 'smooth' });
      row.classList.remove('traceRow--jumped');
      void row.offsetWidth;
      row.classList.add('traceRow--jumped');
    });
    const timer = window.setTimeout(() => {
      row.classList.remove('traceRow--jumped');
    }, 1600);
    return () => {
      window.cancelAnimationFrame(frame);
      window.clearTimeout(timer);
    };
  }, [selectedEventId, focusVersion]);

  return (
    <div className="traceTimeline">
      <div className="traceTimeline__header">
        {selectedRun ? (
          <div className="traceTimeline__runInfo">
            <span className="traceTimeline__runStatus" style={{ backgroundColor: runStatusColor(selectedRun.status) }} />
            <span className="traceTimeline__runTitle">{selectedRun.title || selectedRun.runId.slice(0, 12)}</span>
            <span className="traceTimeline__runStatusLabel">{runStatusLabel(selectedRun.status, zh)}</span>
            <span className="traceTimeline__runTime">{formatRelativeTime(selectedRun.updatedAt || selectedRun.startedAt, zh)}</span>
          </div>
        ) : (
          <div className="traceTimeline__runInfo">
            <span className="traceTimeline__runTitle">{zh ? '选择一个运行' : 'Select a run'}</span>
          </div>
        )}
      </div>
      <TraceFilters
        categories={allCategories}
        selectedCategories={categoryFilter}
        errorsOnly={errorsOnly}
        zh={zh}
        onToggleCategory={onToggleCategory}
        onSetCategoryFilter={onSetCategoryFilter}
        onToggleErrorsOnly={() => onSetErrorsOnly(!errorsOnly)}
      />
      <div className="traceTimeline__body">
        {displayTraces.length === 0 ? (
          <div className="traceTimeline__empty">
            {zh ? '暂无 trace 数据' : 'No trace data'}
          </div>
        ) : (
          <div className="traceList">
            {displayTraces.map((trace) => {
              const selected = trace.eventId === selectedEventId;
              return (
                <TraceRow
                  key={trace.eventId}
                  rowRef={selected ? selectedRowRef : undefined}
                  trace={trace}
                  selected={selected}
                  zh={zh}
                  onSelect={() => onSelectEvent(trace.eventId)}
                />
              );
            })}
          </div>
        )}
        {hasMoreBefore && (
          <button
            type="button"
            className="traceLoadMore"
            onClick={onLoadOlder}
            disabled={loading}
          >
            {loading ? (zh ? '加载中…' : 'Loading…') : (zh ? '加载更早' : 'Load older')}
          </button>
        )}
      </div>
      <div className="traceTimeline__footer">
        {zh ? `显示 ${visibleCount} 条 / 共 ${totalCount} 条` : `Showing ${visibleCount} / ${totalCount}`}
      </div>
    </div>
  );
}

function TraceRow({
  rowRef,
  trace,
  selected,
  zh,
  onSelect,
}: {
  rowRef?: Ref<HTMLButtonElement>;
  trace: RunTraceEnvelope;
  selected: boolean;
  zh: boolean;
  onSelect(): void;
}) {
  const dot = traceLifecycleDot(trace.lifecycle);
  return (
    <button
      ref={rowRef}
      type="button"
      className={`traceRow ${selected ? 'traceRow--selected' : ''}`}
      data-event-id={trace.eventId}
      onClick={onSelect}
      aria-selected={selected}
    >
      <span className="traceRow__icon">{traceIcon(trace.category)}</span>
      <span className="traceRow__category">{traceCategoryLabel(trace.category, zh)}</span>
      <span className="traceRow__lifecycle" style={{ color: dot.color }} title={trace.lifecycle}>{dot.label}</span>
      <div className="traceRow__content">
        <div className="traceRow__name">{trace.name}</div>
        <div className="traceRow__summary">{traceSummary(trace, zh)}</div>
      </div>
      <div className="traceRow__meta">
        {trace.durationMs != null && (
          <span className="traceRow__duration">{formatDuration(trace.durationMs)}</span>
        )}
        <span className="traceRow__time">{formatAbsoluteTime(trace.occurredAt)}</span>
      </div>
    </button>
  );
}
