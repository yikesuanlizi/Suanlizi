import { useState } from 'react';
import { presentSuanliziError } from '@suanlizi/protocol';
import type { Locale } from '../../config/config.js';
import { formatDuration, formatRelativeTime, runStatusColor, runStatusLabel, traceIcon } from '../../features/monitor/traceFormatters.js';
import type { CurrentPhase, RecentTraceEvent } from '../../features/agents/agentWorkbenchModel.js';
import type { RunControlCapabilities, RunTraceSummary } from '@suanlizi/protocol';

const PHASE_ICONS: Record<string, string> = {
  model: '🧠',
  tool: '🔧',
  approval: '⚠️',
  file: '📁',
  checkpoint: '📍',
  idle: '💤',
  error: '❌',
};

export function LiveActivityHud({
  traceSummary,
  currentPhase,
  recentEvents,
  controlCapabilities,
  busy,
  onInterrupt,
  onResume,
  onRollback,
  onJumpToTrace,
  locale,
}: {
  traceSummary?: RunTraceSummary | null;
  currentPhase: CurrentPhase;
  recentEvents: RecentTraceEvent[];
  controlCapabilities?: RunControlCapabilities;
  busy: boolean;
  onInterrupt?(): void;
  onResume?(): void;
  onRollback?(checkpointId?: string): void;
  onJumpToTrace?(opts: { itemId: string; runId: string; eventId?: string }): void;
  locale: Locale;
}) {
  const zh = locale === 'zh';
  const [errorExpanded, setErrorExpanded] = useState(false);
  const [expandedEventId, setExpandedEventId] = useState<string | null>(null);

  const runStatus = traceSummary?.status ?? (busy ? 'running' : 'idle');
  const statusColor = runStatusColor(runStatus);
  const statusLabel = runStatusLabel(runStatus, zh);
  const duration = traceSummary?.durationMs;
  const startedAt = traceSummary?.startedAt;

  const model = traceSummary?.model;
 const tools = traceSummary?.tools;
  const presentedError = traceSummary?.lastError
    ? presentSuanliziError(undefined, `${traceSummary.lastError.code}: ${traceSummary.lastError.message}`, locale)
    : undefined;
  const errorSummary = presentedError?.summary ?? '';
  const errorDetail = presentedError?.detail;

  const interruptCap = controlCapabilities?.interrupt;
  const resumeCap = controlCapabilities?.resume;
  const rollbackCap = controlCapabilities?.rollback;

  const isColdIdle = !busy
    && runStatus === 'idle'
    && !traceSummary
    && recentEvents.length === 0
    && currentPhase.kind === 'idle'
    && !currentPhase.detail;

  return (
    <div className="liveActivityHud">
      <div className="liveActivityHeader">
        <div className="liveActivityStatus">
          <span className="liveActivityStatusDot" style={{ backgroundColor: statusColor }} />
          <strong>{statusLabel}</strong>
        </div>
        <div className="liveActivityMeta">
          {duration != null ? <span>{formatDuration(duration)}</span> : null}
          {startedAt ? <span>{formatRelativeTime(startedAt, zh)}</span> : null}
        </div>
      </div>

      {isColdIdle ? (
        <div className="liveActivityIdle">
          <p>{zh ? '等待开始…' : 'Waiting to start…'}</p>
          <span>{zh ? '发送消息后，活动将显示在这里' : 'Activity will appear here after you send a message'}</span>
        </div>
      ) : (
        <>
          <div className={`liveActivityPhase phase-${currentPhase.kind}`}>
            <span className="liveActivityPhaseIcon">{PHASE_ICONS[currentPhase.kind] ?? '•'}</span>
            <div className="liveActivityPhaseText">
              <strong>{currentPhase.label}</strong>
              {currentPhase.detail ? <span>{currentPhase.detail}</span> : null}
            </div>
          </div>

          {traceSummary?.lastError ? (
            <div className="liveActivityError">
              <button
                type="button"
                className="liveActivityErrorToggle"
                onClick={() => setErrorExpanded(v => !v)}
                aria-expanded={errorExpanded}
              >
                <span>❌ {errorSummary}</span>
                <span className="liveActivityErrorExpand">{errorExpanded ? '▾' : '▸'}</span>
              </button>
              {errorExpanded ? (
                <div className="liveActivityErrorDetail">
                  {errorDetail}
                </div>
              ) : null}
            </div>
          ) : null}

          {traceSummary?.lastCheckpointId ? (
            <div className="liveActivityCheckpoint">
              <span>📍 {zh ? '检查点' : 'Checkpoint'}</span>
              <code>{traceSummary.lastCheckpointId.slice(0, 16)}</code>
            </div>
          ) : null}

          <div className="liveActivityMetrics">
            {model && model.calls > 0 ? (
              <div className="liveActivityMetricGroup">
                <h4>{zh ? '模型' : 'Model'}</h4>
                <div className="liveActivityMetricGrid">
                  <MetricCell label={zh ? '调用' : 'Calls'} value={model.calls} />
                  <MetricCell label={zh ? '输入' : 'Input'} value={formatCompactNum(model.inputTokens)} />
                  <MetricCell label={zh ? '输出' : 'Output'} value={formatCompactNum(model.outputTokens)} />
                  {model.cacheReadTokens > 0 ? <MetricCell label={zh ? '缓存' : 'Cache'} value={formatCompactNum(model.cacheReadTokens)} /> : null}
                  {model.maxTtftMs != null ? <MetricCell label="TTFT" value={formatDuration(model.maxTtftMs)} /> : null}
                </div>
              </div>
            ) : null}

            {tools && tools.calls > 0 ? (
              <div className="liveActivityMetricGroup">
                <h4>{zh ? '工具' : 'Tools'}</h4>
                <div className="liveActivityMetricGrid">
                  <MetricCell label={zh ? '调用' : 'Calls'} value={tools.calls} />
                  {tools.failed > 0 ? <MetricCell label={zh ? '失败' : 'Failed'} value={tools.failed} danger /> : null}
                  {tools.denied > 0 ? <MetricCell label={zh ? '拒绝' : 'Denied'} value={tools.denied} warning /> : null}
                </div>
              </div>
            ) : null}
          </div>

          <div className="liveActivityControls">
            {interruptCap ? (
              <button
                type="button"
                className="controlButton controlButtonDanger"
                disabled={!interruptCap.enabled}
                title={interruptCap.reason}
                onClick={onInterrupt}
              >
                {zh ? '中断' : 'Interrupt'}
              </button>
            ) : null}
            {resumeCap ? (
              <button
                type="button"
                className="controlButton"
                disabled={!resumeCap.enabled}
                title={resumeCap.reason}
                onClick={onResume}
              >
                {zh ? '恢复' : 'Resume'}
              </button>
            ) : null}
            {rollbackCap ? (
              <button
                type="button"
                className="controlButton controlButtonWarning"
                disabled={!rollbackCap.enabled}
                title={rollbackCap.reason}
                onClick={() => onRollback?.(rollbackCap.checkpointIds?.[rollbackCap.checkpointIds.length - 1])}
              >
                {zh ? '回滚' : 'Rollback'}
              </button>
            ) : null}
          </div>

          {recentEvents.length > 0 ? (
            <div className="liveActivityRecent">
              <h4>{zh ? '最近事件' : 'Recent events'}</h4>
              <div className="liveActivityEventList">
                {recentEvents.slice(-8).reverse().map(event => (
                  <div
                    key={event.eventId ?? event.itemId}
                    className={`liveActivityEvent level-${event.level}${expandedEventId === (event.eventId ?? event.itemId) ? ' expanded' : ''}`}
                  >
                    <span className="liveActivityEventIcon">{traceIcon(event.category)}</span>
                    <span className="liveActivityEventText">
                      <span className="liveActivityEventName">
                        <span className="liveActivityEventAgent" title={event.agent.label}>{event.agent.label}</span>
                        {event.status ? (
                          <span
                            className={`liveActivityEventStatus status-${event.status}`}
                            title={statusDescription(event.status, zh)}
                            aria-label={statusDescription(event.status, zh)}
                          >
                            {statusMarker(event.status)}
                          </span>
                        ) : null}
                        {event.resource ? (
                          <span className={`liveActivityEventResource resource-${event.resource.kind.toLowerCase()}`}>
                            <span className="liveActivityEventResourceKind">{event.resource.kind}</span>
                            <span className="liveActivityEventResourceLabel" title={event.resource.label}>{event.resource.label}</span>
                          </span>
                        ) : (
                          <span className="liveActivityEventTitle" title={event.name}>{event.name}</span>
                        )}
                      </span>
                      <span className="liveActivityEventDetail">
                        <span className="liveActivityEventSummary" title={event.summary}>{event.summary}</span>
                        <span className="liveActivityEventTime">{formatRelativeTime(event.occurredAt, zh)}</span>
                      </span>
                    </span>
                    <span className="liveActivityEventActions">
                      <button
                        type="button"
                        className="liveActivityEventJump"
                        onClick={() => onJumpToTrace?.({ itemId: event.itemId, runId: event.runId, eventId: event.eventId })}
                      >
                        {zh ? '定位' : 'Go'}
                      </button>
                      {event.detail ? (
                        <button
                          type="button"
                          className="liveActivityEventDetailToggle"
                          onClick={() => setExpandedEventId(current => current === (event.eventId ?? event.itemId) ? null : (event.eventId ?? event.itemId))}
                          aria-expanded={expandedEventId === (event.eventId ?? event.itemId)}
                        >
                          {expandedEventId === (event.eventId ?? event.itemId) ? (zh ? '收起' : 'Hide') : (zh ? '详情' : 'Detail')}
                        </button>
                      ) : null}
                    </span>
                    {expandedEventId === (event.eventId ?? event.itemId) && event.detail ? (
                      <pre className="liveActivityEventRaw">{event.detail}</pre>
                    ) : null}
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}

function MetricCell({ label, value, danger, warning }: { label: string; value: string | number; danger?: boolean; warning?: boolean }) {
  return (
    <div className="liveActivityMetric">
      <span className="liveActivityMetricLabel">{label}</span>
      <strong className={danger ? 'liveActivityMetricDanger' : warning ? 'liveActivityMetricWarning' : ''}>{value}</strong>
    </div>
  );
}

function formatCompactNum(n: number): string {
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return String(n);
}

function statusMarker(status: RecentTraceEvent['status']): string {
  if (status === 'completed') return '✓';
  if (status === 'failed') return '!';
  if (status === 'cancelled' || status === 'canceled') return '×';
  if (status === 'in_progress') return '•';
  return '';
}

function statusDescription(status: RecentTraceEvent['status'], zh: boolean): string {
  if (status === 'completed') return zh ? '已完成' : 'Completed';
  if (status === 'failed') return zh ? '失败' : 'Failed';
  if (status === 'cancelled' || status === 'canceled') return zh ? '已取消' : 'Cancelled';
  if (status === 'in_progress') return zh ? '进行中' : 'In progress';
  return zh ? '事件状态' : 'Event status';
}
