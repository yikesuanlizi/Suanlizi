import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import type { RunTraceCategory, RunTraceEnvelope, SystemMonitorStatus } from '@suanlizi/protocol';
import type { Locale } from '../../config/config.js';
import type { RunRecord, ThreadWithRuns } from '../../shared/types.js';
import type { EventDraft } from '../chat/threadView.js';
import { initialRunMonitorState, runMonitorReducer, selectSelectedTrace, type PendingTraceTarget, type TracePageInfo } from './runMonitorState.js';

const AUTO_REFRESH_KEY = 'suanlizi.runMonitor.autoRefresh';
const AUTO_REFRESH_INTERVAL_KEY = 'suanlizi.runMonitor.autoRefreshInterval';
const DEFAULT_REFRESH_INTERVAL = 3000;
const TRACE_FETCH_LIMIT = 200;

const ALL_CATEGORIES: RunTraceCategory[] = [
  'model', 'tool', 'approval', 'item', 'file', 'error', 'agent', 'checkpoint', 'control',
  'turn', 'iteration', 'context', 'memory', 'middleware', 'evidence', 'browser',
];

function buildTraceUrl(
  runId: string,
  params: { limit?: number; before?: number; after?: number; categories?: RunTraceCategory[]; errorsOnly?: boolean },
): string {
  const search = new URLSearchParams();
  if (params.limit) search.set('limit', String(params.limit));
  if (params.before != null) search.set('before', String(params.before));
  if (params.after != null) search.set('after', String(params.after));
  if (params.categories && params.categories.length > 0) {
    for (const c of params.categories) search.append('category', c);
  }
  if (params.errorsOnly) search.set('errorsOnly', '1');
  const qs = search.toString();
  return `/api/runs/${encodeURIComponent(runId)}/trace${qs ? `?${qs}` : ''}`;
}

interface TraceFetchResult {
  traces: RunTraceEnvelope[];
  page: TracePageInfo;
}

async function fetchTraces(
  runId: string,
  params: { limit?: number; before?: number; after?: number; categories?: RunTraceCategory[]; errorsOnly?: boolean; signal?: AbortSignal },
): Promise<TraceFetchResult> {
  const url = buildTraceUrl(runId, params);
  const response = await fetch(url, { signal: params.signal });
  if (!response.ok) return { traces: [], page: { hasMoreBefore: false, hasMoreAfter: false } };
  const data = (await response.json()) as { page?: { events?: RunTraceEnvelope[]; hasMoreBefore?: boolean; hasMoreAfter?: boolean; nextBefore?: number; nextAfter?: number } };
  const page = data.page;
  return {
    traces: page?.events ?? [],
    page: {
      hasMoreBefore: page?.hasMoreBefore ?? false,
      hasMoreAfter: page?.hasMoreAfter ?? false,
      nextBefore: page?.nextBefore,
      nextAfter: page?.nextAfter,
    },
  };
}

export function useRunMonitor(options: {
  threadId: string;
  threadIds?: string[];
  locale: Locale;
  addEvent(event: EventDraft): void;
}) {
  const { addEvent, locale, threadId, threadIds = [] } = options;
  const threadIdsKey = threadIds.join('\u0000');
  const zh = locale === 'zh';
  const [open, setOpen] = useState(false);
  const [state, dispatch] = useReducer(runMonitorReducer, initialRunMonitorState);
  const [systemMonitorStatus, setSystemMonitorStatus] = useState<SystemMonitorStatus | null>(null);
  const [autoRefresh, setAutoRefreshState] = useState(() => {
    try { return localStorage.getItem(AUTO_REFRESH_KEY) === '1'; } catch { return false; }
  });
  const [autoRefreshInterval, setAutoRefreshIntervalState] = useState(() => {
    try {
      const v = Number(localStorage.getItem(AUTO_REFRESH_INTERVAL_KEY));
      return v > 0 ? v : DEFAULT_REFRESH_INTERVAL;
    } catch { return DEFAULT_REFRESH_INTERVAL; }
  });
  const autoRefreshTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const requestIdRef = useRef(0);
  const stateRef = useRef(state);
  const skipNextOpenRefreshRef = useRef(false);
  stateRef.current = state;

  const filtersRef = useRef({ categoryFilter: state.categoryFilter, errorsOnly: state.errorsOnly });
  filtersRef.current = { categoryFilter: state.categoryFilter, errorsOnly: state.errorsOnly };

  const setAutoRefresh = useCallback((value: boolean) => {
    setAutoRefreshState(value);
    try {
      if (value) localStorage.setItem(AUTO_REFRESH_KEY, '1');
      else localStorage.removeItem(AUTO_REFRESH_KEY);
    } catch { /* ignore */ }
  }, []);

  const setAutoRefreshInterval = useCallback((ms: number) => {
    const v = Math.max(1000, ms);
    setAutoRefreshIntervalState(v);
    try { localStorage.setItem(AUTO_REFRESH_INTERVAL_KEY, String(v)); } catch { /* ignore */ }
  }, []);

  const toggleThread = useCallback((threadIdToToggle: string) => {
    dispatch({ type: 'toggle-thread', threadId: threadIdToToggle });
  }, []);

  const selectRun = useCallback((runId: string) => {
    dispatch({ type: 'select-run', runId });
  }, []);

  const selectEvent = useCallback((eventId: string) => {
    dispatch({ type: 'select-trace', eventId });
  }, []);

  const selectByItemId = useCallback((itemId: string) => {
    dispatch({ type: 'select-by-itemId', itemId });
  }, []);

  const toggleCategory = useCallback((category: RunTraceCategory) => {
    const current = stateRef.current.categoryFilter;
    const next = current.includes(category)
      ? current.filter((c) => c !== category)
      : [...current, category];
    dispatch({ type: 'set-category-filter', categories: next });
  }, []);

  const setCategoryFilter = useCallback((categories: RunTraceCategory[]) => {
    dispatch({ type: 'set-category-filter', categories });
  }, []);

  const setErrorsOnly = useCallback((value: boolean) => {
    dispatch({ type: 'toggle-errors-only', value });
  }, []);

  const fetchRunsData = useCallback(async (requestId: number, controller: AbortController): Promise<RunRecord[]> => {
    try {
      const threadsResponse = await fetch('/api/runs/threads', { signal: controller.signal });
      const scopedThreadIds: Set<string> | null = threadId ? new Set([threadId, ...threadIds]) : null;
      let nextThreads: ThreadWithRuns[] = [];
      if (threadsResponse.ok && !controller.signal.aborted) {
        const threadsData = (await threadsResponse.json()) as { threads?: ThreadWithRuns[] };
        const allThreads = threadsData.threads ?? [];
        if (scopedThreadIds) {
          let changed = true;
          while (changed) {
            changed = false;
            for (const thread of allThreads) {
              if (thread.parentThreadId && scopedThreadIds.has(thread.parentThreadId) && !scopedThreadIds.has(thread.threadId)) {
                scopedThreadIds.add(thread.threadId);
                changed = true;
              }
            }
          }
        }
        nextThreads = scopedThreadIds
          ? allThreads.filter((thread) => scopedThreadIds.has(thread.threadId))
          : allThreads;
      }
      dispatch({ type: 'threads.loaded', requestId, threads: nextThreads });
      if (controller.signal.aborted) return [];

      const validThreadIds = new Set(nextThreads.map((t) => t.threadId));
      const scopedRunIds = scopedThreadIds ? [...scopedThreadIds] : [];
      const runsUrl = scopedRunIds.length > 0
          ? ''
          : threadId
          ? `/api/runs?threadId=${encodeURIComponent(threadId)}&limit=80`
          : '/api/runs?limit=20';
      let allRuns: RunRecord[] = [];
      if (scopedRunIds.length > 0) {
        const responses = await Promise.all(scopedRunIds.map((id) =>
          fetch(`/api/runs?threadId=${encodeURIComponent(id)}&limit=80`, { signal: controller.signal }),
        ));
        const data = await Promise.all(responses.filter((response) => response.ok).map((response) => response.json() as Promise<{ runs?: RunRecord[] }>));
        allRuns = [...new Map(data.flatMap((entry) => entry.runs ?? []).map((run) => [run.runId, run])).values()];
      } else {
        const runsResponse = await fetch(runsUrl, { signal: controller.signal });
        if (controller.signal.aborted) return [];
        if (!runsResponse.ok) {
          dispatch({ type: 'load-error', requestId, message: `${zh ? 'API 请求失败' : 'API request failed'} (HTTP ${runsResponse.status})` });
          return [];
        }
        const runsData = (await runsResponse.json()) as { runs?: RunRecord[] };
        allRuns = runsData.runs ?? [];
      }
      if (controller.signal.aborted) return [];
      const nextRuns = threadId ? allRuns : allRuns.filter((run) => validThreadIds.has(run.threadId));
      dispatch({ type: 'runs.loaded', requestId, runs: nextRuns });
      return nextRuns;
    } catch (error) {
      if (controller.signal.aborted) return [];
      dispatch({ type: 'load-error', requestId, message: error instanceof Error ? error.message : String(error) });
      return [];
    }
  }, [threadId, threadIdsKey]);

  const loadTraceInitial = useCallback(async (runId: string, requestId: number, controller: AbortController) => {
    const { categoryFilter, errorsOnly } = filtersRef.current;
    const result = await fetchTraces(runId, {
      limit: TRACE_FETCH_LIMIT,
      categories: categoryFilter.length > 0 ? categoryFilter : undefined,
      errorsOnly: errorsOnly || undefined,
      signal: controller.signal,
    });
    if (controller.signal.aborted) return;
    dispatch({ type: 'traces.loaded', requestId, runId, traces: result.traces, page: result.page });
  }, []);

  const loadOlder = useCallback(async () => {
    const current = stateRef.current;
    if (!current.selectedRunId || !current.tracePage?.hasMoreBefore || current.loading) return;
    const firstSeq = current.traces[0]?.sequence;
    if (firstSeq == null) return;
    const controller = new AbortController();
    const requestId = ++requestIdRef.current;
    dispatch({ type: 'refresh.begin', requestId });
    try {
      const { categoryFilter, errorsOnly } = filtersRef.current;
      const result = await fetchTraces(current.selectedRunId, {
        limit: TRACE_FETCH_LIMIT,
        before: firstSeq,
        categories: categoryFilter.length > 0 ? categoryFilter : undefined,
        errorsOnly: errorsOnly || undefined,
        signal: controller.signal,
      });
      dispatch({ type: 'traces.prepend', requestId, runId: current.selectedRunId, traces: result.traces, page: result.page });
    } catch {
      // ignore
    } finally {
      dispatch({ type: 'refresh.done', requestId });
    }
  }, []);

  const refresh = useCallback(async (runId?: string, opts?: { autoExpandThread?: boolean }): Promise<RunRecord[]> => {
    abortControllerRef.current?.abort();
    const controller = new AbortController();
    abortControllerRef.current = controller;
    const currentRequestId = ++requestIdRef.current;
    dispatch({ type: 'refresh.begin', requestId: currentRequestId });

    try {
      const nextRuns = await fetchRunsData(currentRequestId, controller);
      if (controller.signal.aborted) return [];

      const prevSelectedId = runId || stateRef.current.selectedRunId;
      const runIds = new Set(nextRuns.map((r) => r.runId));
      const selectedAfterRuns = runIds.has(prevSelectedId)
        ? prevSelectedId
        : (nextRuns[0]?.runId ?? '');

      if (opts?.autoExpandThread && selectedAfterRuns) {
        const selectedRun = nextRuns.find((r) => r.runId === selectedAfterRuns);
        if (selectedRun && !stateRef.current.expandedThreadId) {
          dispatch({ type: 'toggle-thread', threadId: selectedRun.threadId });
        }
      }

      if (!selectedAfterRuns) {
        dispatch({ type: 'refresh.done', requestId: currentRequestId });
        return [];
      }

      if (runId && runId !== stateRef.current.selectedRunId) {
        dispatch({ type: 'select-run', runId });
      }

      await loadTraceInitial(selectedAfterRuns, currentRequestId, controller);
      return nextRuns;
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return [];
      throw error;
    } finally {
      dispatch({ type: 'refresh.done', requestId: currentRequestId });
      if (abortControllerRef.current === controller) {
        abortControllerRef.current = null;
      }
    }
  }, [fetchRunsData, loadTraceInitial]);

  const focusThread = useCallback(async (targetThreadId: string) => {
    skipNextOpenRefreshRef.current = true;
    setOpen(true);
    const runs = await refresh(undefined, { autoExpandThread: true });
    const targetRun = runs.find((run) => run.threadId === targetThreadId);
    if (targetRun) {
      dispatch({ type: 'select-run', runId: targetRun.runId });
      dispatch({ type: 'toggle-thread', threadId: targetThreadId });
    }
  }, [refresh]);

  const refreshIncremental = useCallback(async () => {
    const current = stateRef.current;
    if (!current.selectedRunId || current.loading) return;
    const lastSeq = current.traces[current.traces.length - 1]?.sequence;
    const controller = new AbortController();
    const requestId = ++requestIdRef.current;
    dispatch({ type: 'refresh.begin-silent', requestId });
    try {
      const { categoryFilter, errorsOnly } = filtersRef.current;
      if (lastSeq == null) {
        const result = await fetchTraces(current.selectedRunId, {
          limit: TRACE_FETCH_LIMIT,
          categories: categoryFilter.length > 0 ? categoryFilter : undefined,
          errorsOnly: errorsOnly || undefined,
          signal: controller.signal,
        });
        if (result.traces.length > 0 && !controller.signal.aborted) {
          dispatch({ type: 'traces.loaded', requestId, runId: current.selectedRunId, traces: result.traces, page: result.page });
        }
      } else {
        const result = await fetchTraces(current.selectedRunId, {
          limit: TRACE_FETCH_LIMIT,
          after: lastSeq,
          categories: categoryFilter.length > 0 ? categoryFilter : undefined,
          errorsOnly: errorsOnly || undefined,
          signal: controller.signal,
        });
        if (result.traces.length > 0 && !controller.signal.aborted) {
          dispatch({ type: 'traces.append', requestId, runId: current.selectedRunId, traces: result.traces, page: result.page });
        }
      }
      await fetchRunsData(requestId, controller);
    } catch {
      // ignore
    }
  }, [fetchRunsData]);

  const openDrawer = useCallback(() => {
    if (open) {
      void refresh(undefined, { autoExpandThread: true });
      return;
    }
    setOpen(true);
  }, [open, refresh]);

  const focusTraceTarget = useCallback((target: PendingTraceTarget) => {
    dispatch({ type: 'queue-trace-target', target });
    if (!open) {
      skipNextOpenRefreshRef.current = true;
      setOpen(true);
    }
    void refresh(target.runId || stateRef.current.selectedRunId || undefined, { autoExpandThread: true });
  }, [open, refresh]);

  const closeDrawer = useCallback(() => {
    setOpen(false);
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
  }, []);

  const refreshSystemMonitorStatus = useCallback(async () => {
    try {
      const response = await fetch('/api/system-monitor/status');
      if (!response.ok) {
        setSystemMonitorStatus(null);
        return;
      }
      const data = (await response.json()) as { status?: SystemMonitorStatus };
      setSystemMonitorStatus(data.status?.enabled ? data.status : null);
    } catch {
      setSystemMonitorStatus(null);
    }
  }, []);

  const controlRun = useCallback(async (
    action: 'interrupt' | 'resume' | 'rollback',
    run: RunRecord,
    opts?: { checkpointId?: string },
  ) => {
    const body: Record<string, unknown> = { action };
    if (opts?.checkpointId) body.checkpointId = opts.checkpointId;
    const response = await fetch(`/api/runs/${encodeURIComponent(run.runId)}/control`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const data = (await response.json().catch(() => ({}))) as { error?: string };
      addEvent({ kind: 'monitor', title: zh ? '控制动作失败' : 'Control failed', detail: data.error ?? action, tone: 'danger' });
      return;
    }
    addEvent({ kind: 'monitor', title: zh ? '控制动作已记录' : 'Control recorded', detail: action, tone: 'success' });
    await refresh(run.runId);
  }, [addEvent, zh, refresh]);

  useEffect(() => {
    if (open) {
      if (skipNextOpenRefreshRef.current) {
        skipNextOpenRefreshRef.current = false;
        return;
      }
      void refresh(undefined, { autoExpandThread: true });
    } else {
      abortControllerRef.current?.abort();
      abortControllerRef.current = null;
    }
  }, [open, refresh, threadId, threadIdsKey]);

  useEffect(() => {
    if (!open || !autoRefresh) {
      if (autoRefreshTimerRef.current) {
        clearInterval(autoRefreshTimerRef.current);
        autoRefreshTimerRef.current = null;
      }
      return;
    }
    autoRefreshTimerRef.current = setInterval(() => {
      void refreshIncremental();
    }, autoRefreshInterval);
    return () => {
      if (autoRefreshTimerRef.current) {
        clearInterval(autoRefreshTimerRef.current);
        autoRefreshTimerRef.current = null;
      }
    };
  }, [open, autoRefresh, autoRefreshInterval, refreshIncremental]);

  useEffect(() => {
    if (!open) {
      setSystemMonitorStatus(null);
      return;
    }
    void refreshSystemMonitorStatus();
    const timer = setInterval(() => void refreshSystemMonitorStatus(), 5000);
    return () => clearInterval(timer);
  }, [open, refreshSystemMonitorStatus]);

  useEffect(() => {
    return () => {
      abortControllerRef.current?.abort();
    };
  }, []);

  const selectedRun = state.runs.find((r) => r.runId === state.selectedRunId) ?? null;
  const selectedTrace = selectSelectedTrace(state);

  const visibleTraces = state.traces.filter((t) => {
    if (state.errorsOnly && t.level !== 'error' && t.category !== 'error' && t.lifecycle !== 'failed') return false;
    if (state.categoryFilter.length === 0) return true;
    return state.categoryFilter.includes(t.category);
  });

  return {
    open,
    loading: state.loading,
    loadError: state.loadError,
    runs: state.runs,
    events: state.events,
    traces: state.traces,
    visibleTraces,
    threads: state.threads,
    selectedRunId: state.selectedRunId,
    selectedRun,
    selectedEventId: state.selectedEventId,
    traceFocusVersion: state.traceFocusVersion,
    selectedTrace,
    systemMonitorStatus,
    categoryFilter: state.categoryFilter,
    errorsOnly: state.errorsOnly,
    tracePage: state.tracePage,
    expandedThreadId: state.expandedThreadId,
    autoRefresh,
    autoRefreshInterval,
    allCategories: ALL_CATEGORIES,
    zh,
    setAutoRefresh,
    setAutoRefreshInterval,
    setOpen,
    openDrawer,
    focusTraceTarget,
    closeDrawer,
    focusThread,
    refresh,
    controlRun,
    toggleThread,
    selectRun,
    selectEvent,
    selectByItemId,
    toggleCategory,
    setCategoryFilter,
    setErrorsOnly,
    loadOlder,
  };
}
