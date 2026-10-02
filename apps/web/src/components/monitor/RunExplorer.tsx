import type { ReactNode } from 'react';
import type { RunRecord, ThreadWithRuns } from '../../shared/types.js';
import { formatRelativeTime, runStatusColor, runStatusLabel } from '../../features/monitor/traceFormatters.js';

interface RunExplorerProps {
  threads: ThreadWithRuns[];
  runs: RunRecord[];
  selectedRunId: string;
  expandedThreadId: string;
  loading: boolean;
  loadError: string | null;
  threadId: string;
  zh: boolean;
  onSelectRun(runId: string): void;
  onToggleThread(threadId: string): void;
  onRefresh(): void;
}

export function RunExplorer({
  threads,
  runs,
  selectedRunId,
  expandedThreadId,
  loading,
  loadError,
  threadId,
  zh,
  onSelectRun,
  onToggleThread,
  onRefresh,
}: RunExplorerProps) {
  const runsByThread = new Map<string, RunRecord[]>();
  for (const run of runs) {
    const arr = runsByThread.get(run.threadId) ?? [];
    arr.push(run);
    runsByThread.set(run.threadId, arr);
  }

  const threadById = new Map(threads.map((thread) => [thread.threadId, thread]));
  const childrenByThread = new Map<string, ThreadWithRuns[]>();
  for (const thread of threads) {
    const parentId = thread.parentThreadId ?? '';
    if (!parentId || !threadById.has(parentId)) continue;
    const children = childrenByThread.get(parentId) ?? [];
    children.push(thread);
    childrenByThread.set(parentId, children);
  }
  for (const children of childrenByThread.values()) {
    children.sort((a, b) => b.lastActiveAt.localeCompare(a.lastActiveAt));
  }
  const rootThreads = threads.filter((thread) => {
    const parentId = thread.parentThreadId ?? '';
    return !parentId || !threadById.has(parentId);
  });

  function renderThreadGroup(thread: ThreadWithRuns, depth = 0): ReactNode {
    const threadRuns = runsByThread.get(thread.threadId) ?? [];
    const isExpanded = expandedThreadId === thread.threadId;
    const children = childrenByThread.get(thread.threadId) ?? [];
    const childCount = children.length;
    const agentLabel = thread.agentNickname?.trim() || thread.agentRole?.trim() || (zh ? '子 Agent' : 'Sub-agent');
    return (
      <div key={thread.threadId} className={`runThreadGroup${depth > 0 ? ' runThreadGroup--child' : ''}`} data-thread-depth={depth}>
        <button
          type="button"
          className={`runThreadGroup__header${depth > 0 ? ' runThreadGroup__header--child' : ''}`}
          onClick={() => onToggleThread(thread.threadId)}
          aria-expanded={isExpanded}
          aria-label={depth > 0 ? `${zh ? '子 Agent' : 'Sub-agent'}: ${thread.title || agentLabel}` : thread.title}
        >
          <span className="runThreadGroup__caret">{depth > 0 ? '↳' : (isExpanded ? '▼' : '▶')}</span>
          <span className="runThreadGroup__title" title={thread.title}>
            {thread.title || (zh ? '未命名对话' : 'Untitled')}
          </span>
          {depth > 0 ? (
            <span className="runThreadGroup__agentMarker" title={thread.agentRole ?? undefined}>
              {zh ? `子 Agent · ${agentLabel}` : `Sub-agent · ${agentLabel}`}
            </span>
          ) : childCount > 0 ? (
            <span className="runThreadGroup__agentMarker">
              {zh ? `${childCount} 个子 Agent` : `${childCount} sub-agent${childCount === 1 ? '' : 's'}`}
            </span>
          ) : null}
          <span className="runThreadGroup__count">{threadRuns.length}</span>
        </button>
        {isExpanded && threadRuns.length > 0 && (
          <div className="runThreadGroup__runs">
            {threadRuns.map((run) => (
              <RunEntry
                key={run.runId}
                run={run}
                selected={run.runId === selectedRunId}
                zh={zh}
                onSelect={() => onSelectRun(run.runId)}
              />
            ))}
          </div>
        )}
        {children.length > 0 ? (
          <div className="runThreadGroup__children">
            {children.map((child) => renderThreadGroup(child, depth + 1))}
          </div>
        ) : null}
      </div>
    );
  }

  const groupedByThread = threadId ? threads.length > 0 : true;
  const showEmpty = runs.length === 0 && threads.length === 0;

  return (
    <div className="runExplorer">
      <div className="runExplorer__header">
        <h3 className="runExplorer__title">{zh ? '最近运行' : 'Recent Runs'}</h3>
        <button
          type="button"
          className="runExplorer__refresh"
          onClick={onRefresh}
          disabled={loading}
          aria-label={zh ? '刷新' : 'Refresh'}
          title={zh ? '刷新' : 'Refresh'}
        >
          {loading ? '⟳' : '↻'}
        </button>
      </div>
      <div className="runExplorer__body">
        {showEmpty && loadError ? (
          <div className="runExplorer__empty">
            <p>{zh ? '监控数据加载失败' : 'Failed to load runs'}</p>
            <p className="runExplorer__emptyHint">
              {zh ? '请检查 API 是否在运行' : 'Check that the API is running'}
            </p>
            <button type="button" className="runExplorer__retry" onClick={onRefresh}>{zh ? '重试' : 'Retry'}</button>
          </div>
        ) : showEmpty ? (
          <div className="runExplorer__empty">
            <p>{zh ? '暂无运行记录' : 'No runs yet'}</p>
            <p className="runExplorer__emptyHint">
              {zh ? '启动一次对话后会在这里显示' : 'Start a conversation to see runs here'}
            </p>
          </div>
        ) : groupedByThread ? (
          <div className="runExplorer__threads">
            {rootThreads.map((thread) => renderThreadGroup(thread))}
          </div>
        ) : (
          <div className="runExplorer__flat">
            {runs.map((run) => (
              <RunEntry
                key={run.runId}
                run={run}
                selected={run.runId === selectedRunId}
                zh={zh}
                onSelect={() => onSelectRun(run.runId)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function RunEntry({
  run,
  selected,
  zh,
  onSelect,
}: {
  run: RunRecord;
  selected: boolean;
  zh: boolean;
  onSelect(): void;
}) {
  const statusColor = runStatusColor(run.status);
  return (
    <button
      type="button"
      className={`runEntry ${selected ? 'runEntry--selected' : ''}`}
      onClick={onSelect}
      aria-selected={selected}
    >
      <span className="runEntry__status" style={{ backgroundColor: statusColor }} title={runStatusLabel(run.status, zh)} />
      <div className="runEntry__content">
        <div className="runEntry__title">{run.title || run.runId.slice(0, 12)}</div>
        <div className="runEntry__meta">
          <span className="runEntry__kind">{run.kind}</span>
          {run.activeStep && <span className="runEntry__step">{run.activeStep}</span>}
        </div>
        <div className="runEntry__time">{formatRelativeTime(run.updatedAt || run.startedAt, zh)}</div>
      </div>
    </button>
  );
}
