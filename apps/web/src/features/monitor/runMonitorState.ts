import type { RunTraceCategory, RunTraceEnvelope, ThreadItem, TurnMeta } from '@suanlizi/protocol';
import type { RunEvent, RunRecord, ThreadWithRuns } from '../../shared/types.js';

export interface TracePageInfo {
  hasMoreBefore: boolean;
  hasMoreAfter: boolean;
  nextBefore?: number;
  nextAfter?: number;
}

export interface PendingTraceTarget {
  runId?: string;
  eventId?: string;
  itemId?: string;
}

export interface RunMonitorState {
  runs: RunRecord[];
  events: RunEvent[];
  traces: RunTraceEnvelope[];
  threads: ThreadWithRuns[];
  selectedRunId: string;
  expandedThreadId: string;
  activeRequestId: number;
  loading: boolean;
  loadError: string | null;
  items: ThreadItem[];
  selectedItemId: string;
  inspectorItem: ThreadItem | null;
  itemFilter: string;
  turns: TurnMeta[];
  turnFilter: string;
  selectedEventId: string;
  traceFocusVersion: number;
  categoryFilter: RunTraceCategory[];
  errorsOnly: boolean;
  tracePage: TracePageInfo | null;
  pendingTraceTarget: PendingTraceTarget | null;
}

export const initialRunMonitorState: RunMonitorState = {
  runs: [],
  events: [],
  traces: [],
  threads: [],
  selectedRunId: '',
  expandedThreadId: '',
  activeRequestId: 0,
  loading: false,
  loadError: null,
  items: [],
  selectedItemId: '',
  inspectorItem: null,
  itemFilter: '',
  turns: [],
  turnFilter: '',
  selectedEventId: '',
  traceFocusVersion: 0,
  categoryFilter: [],
  errorsOnly: false,
  tracePage: null,
  pendingTraceTarget: null,
};

export type RunMonitorAction =
  | { type: 'refresh.begin'; requestId: number }
  | { type: 'refresh.begin-silent'; requestId: number }
  | { type: 'threads.loaded'; requestId: number; threads: ThreadWithRuns[] }
  | { type: 'runs.loaded'; requestId: number; runs: RunRecord[] }
  | { type: 'events.loaded'; requestId: number; runId: string; events: RunEvent[] }
  | { type: 'traces.loaded'; requestId: number; runId: string; traces: RunTraceEnvelope[]; page?: TracePageInfo }
  | { type: 'traces.append'; requestId: number; runId: string; traces: RunTraceEnvelope[]; page?: TracePageInfo }
  | { type: 'traces.prepend'; requestId: number; runId: string; traces: RunTraceEnvelope[]; page?: TracePageInfo }
  | { type: 'trace-page.loaded'; requestId: number; page: TracePageInfo }
  | { type: 'items.loaded'; requestId: number; runId: string; items: ThreadItem[]; total: number }
  | { type: 'turns.loaded'; requestId: number; runId: string; turns: TurnMeta[] }
  | { type: 'select-run'; runId: string }
  | { type: 'select-item'; itemId: string }
  | { type: 'select-trace'; eventId: string }
  | { type: 'select-by-itemId'; itemId: string }
  | { type: 'queue-trace-target'; target: PendingTraceTarget }
  | { type: 'set-item-filter'; filter: string }
  | { type: 'set-turn-filter'; filter: string }
  | { type: 'set-category-filter'; categories: RunTraceCategory[] }
  | { type: 'toggle-errors-only'; value: boolean }
  | { type: 'clear-items' }
  | { type: 'toggle-thread'; threadId: string }
  | { type: 'load-error'; requestId: number; message: string }
  | { type: 'refresh.done'; requestId: number };

function mergeTraces(existing: RunTraceEnvelope[], incoming: RunTraceEnvelope[], mode: 'append' | 'prepend' | 'replace'): RunTraceEnvelope[] {
  if (mode === 'replace') {
    return [...incoming].sort((a, b) => a.sequence - b.sequence);
  }
  const seen = new Set<string>();
  const result: RunTraceEnvelope[] = [];
  const base = mode === 'prepend' ? [...incoming, ...existing] : [...existing, ...incoming];
  for (const t of base) {
    if (!seen.has(t.eventId)) {
      seen.add(t.eventId);
      result.push(t);
    }
  }
  return result.sort((a, b) => a.sequence - b.sequence);
}

function targetMatchesRun(target: PendingTraceTarget | null, runId: string): boolean {
  if (!target) return false;
  return !target.runId || target.runId === runId;
}

function resolveTraceTarget(traces: RunTraceEnvelope[], target: PendingTraceTarget | null, runId: string): string {
  if (!targetMatchesRun(target, runId)) return '';
  if (target?.eventId && traces.some((t) => t.eventId === target.eventId)) {
    return target.eventId;
  }
  if (target?.itemId) {
    return traces.find((t) => t.itemId === target.itemId)?.eventId ?? '';
  }
  return '';
}

function applyTraceSelection(
  state: RunMonitorState,
  runId: string,
  traces: RunTraceEnvelope[],
): Pick<RunMonitorState, 'selectedEventId' | 'pendingTraceTarget' | 'traceFocusVersion'> {
  const queuedEventId = resolveTraceTarget(traces, state.pendingTraceTarget, runId);
  if (queuedEventId) {
    return {
      selectedEventId: queuedEventId,
      pendingTraceTarget: null,
      traceFocusVersion: state.traceFocusVersion + 1,
    };
  }
  return {
    selectedEventId: traces.some((t) => t.eventId === state.selectedEventId) ? state.selectedEventId : '',
    pendingTraceTarget: state.pendingTraceTarget,
    traceFocusVersion: state.traceFocusVersion,
  };
}

export function runMonitorReducer(state: RunMonitorState, action: RunMonitorAction): RunMonitorState {
  switch (action.type) {
    case 'refresh.begin': {
      return {
        ...state,
        activeRequestId: action.requestId,
        loading: true,
        loadError: null,
      };
    }
    case 'refresh.begin-silent': {
      return {
        ...state,
        activeRequestId: action.requestId,
      };
    }
    case 'threads.loaded': {
      if (action.requestId !== state.activeRequestId) return state;
      return {
        ...state,
        loadError: null,
        threads: action.threads,
      };
    }
    case 'runs.loaded': {
      if (action.requestId !== state.activeRequestId) return state;
      const runIds = new Set(action.runs.map((r) => r.runId));
      const pendingRunId = state.pendingTraceTarget?.runId;
      const pendingRunExists = pendingRunId ? runIds.has(pendingRunId) : false;
      const selectedStillExists = state.selectedRunId !== '' && runIds.has(state.selectedRunId);
      const nextSelectedRunId = pendingRunExists && pendingRunId
        ? pendingRunId
        : selectedStillExists
          ? state.selectedRunId
          : (action.runs[0]?.runId ?? '');
      const selectedChanged = state.selectedRunId !== nextSelectedRunId;
      return {
        ...state,
        runs: action.runs,
        selectedRunId: nextSelectedRunId,
        events: selectedChanged ? [] : state.events,
        traces: selectedChanged ? [] : state.traces,
        items: selectedChanged ? [] : state.items,
        selectedItemId: selectedChanged ? '' : state.selectedItemId,
        inspectorItem: selectedChanged ? null : state.inspectorItem,
        turns: selectedChanged ? [] : state.turns,
        turnFilter: selectedChanged ? '' : state.turnFilter,
        selectedEventId: selectedChanged ? '' : state.selectedEventId,
        traceFocusVersion: state.traceFocusVersion,
        tracePage: selectedChanged ? null : state.tracePage,
        pendingTraceTarget: state.pendingTraceTarget,
      };
    }
    case 'events.loaded': {
      if (action.requestId !== state.activeRequestId) return state;
      if (action.runId !== state.selectedRunId) return state;
      return {
        ...state,
        events: action.events,
      };
    }
    case 'traces.loaded': {
      if (action.requestId !== state.activeRequestId) return state;
      if (action.runId !== state.selectedRunId) return state;
      const traces = mergeTraces(state.traces, action.traces, 'replace');
      const selection = applyTraceSelection(state, action.runId, traces);
      return {
        ...state,
        traces,
        tracePage: action.page ?? null,
        ...selection,
      };
    }
    case 'traces.append': {
      if (action.requestId !== state.activeRequestId) return state;
      if (action.runId !== state.selectedRunId) return state;
      const traces = mergeTraces(state.traces, action.traces, 'append');
      const selection = applyTraceSelection(state, action.runId, traces);
      return {
        ...state,
        traces,
        tracePage: action.page ? { ...state.tracePage, ...action.page, hasMoreBefore: state.tracePage?.hasMoreBefore ?? false } : state.tracePage,
        ...selection,
      };
    }
    case 'traces.prepend': {
      if (action.requestId !== state.activeRequestId) return state;
      if (action.runId !== state.selectedRunId) return state;
      const traces = mergeTraces(state.traces, action.traces, 'prepend');
      const selection = applyTraceSelection(state, action.runId, traces);
      return {
        ...state,
        traces,
        tracePage: action.page ? { ...state.tracePage, ...action.page, hasMoreAfter: state.tracePage?.hasMoreAfter ?? false } : state.tracePage,
        ...selection,
      };
    }
    case 'trace-page.loaded': {
      if (action.requestId !== state.activeRequestId) return state;
      return {
        ...state,
        tracePage: action.page,
      };
    }
    case 'items.loaded': {
      if (action.requestId !== state.activeRequestId) return state;
      if (action.runId !== state.selectedRunId) return state;
      const nextItems = action.items;
      const stillSelected = state.selectedItemId !== ''
        && nextItems.some((it) => it.id === state.selectedItemId);
      return {
        ...state,
        items: nextItems,
        selectedItemId: stillSelected ? state.selectedItemId : '',
        inspectorItem: stillSelected
          ? nextItems.find((it) => it.id === state.selectedItemId) ?? null
          : null,
      };
    }
    case 'turns.loaded': {
      if (action.requestId !== state.activeRequestId) return state;
      if (action.runId !== state.selectedRunId) return state;
      return {
        ...state,
        turns: action.turns,
      };
    }
    case 'select-run': {
      if (action.runId === state.selectedRunId) return state;
      return {
        ...state,
        selectedRunId: action.runId,
        events: [],
        traces: [],
        items: [],
        selectedItemId: '',
        inspectorItem: null,
        turns: [],
        turnFilter: '',
        selectedEventId: '',
        traceFocusVersion: state.traceFocusVersion,
        categoryFilter: [],
        errorsOnly: false,
        tracePage: null,
        pendingTraceTarget: targetMatchesRun(state.pendingTraceTarget, action.runId) ? state.pendingTraceTarget : null,
      };
    }
    case 'select-item': {
      const found = state.items.find((it) => it.id === action.itemId) ?? null;
      if (action.itemId === state.selectedItemId && found === state.inspectorItem) return state;
      return {
        ...state,
        selectedItemId: action.itemId,
        inspectorItem: found,
      };
    }
    case 'select-trace': {
      if (action.eventId === state.selectedEventId) return state;
      return {
        ...state,
        selectedEventId: action.eventId,
        traceFocusVersion: state.traceFocusVersion + 1,
        pendingTraceTarget: null,
      };
    }
    case 'select-by-itemId': {
      const found = state.traces.find((t) => t.itemId === action.itemId);
      if (found) {
        return {
          ...state,
          selectedEventId: found.eventId,
          traceFocusVersion: state.traceFocusVersion + 1,
          pendingTraceTarget: null,
        };
      }
      const nextTarget = { runId: state.selectedRunId || undefined, itemId: action.itemId };
      if (
        state.selectedEventId === ''
        && state.pendingTraceTarget?.itemId === nextTarget.itemId
        && state.pendingTraceTarget?.runId === nextTarget.runId
      ) {
        return state;
      }
      return {
        ...state,
        selectedEventId: '',
        pendingTraceTarget: nextTarget,
      };
    }
    case 'queue-trace-target': {
      const nextRunId = action.target.runId ?? state.selectedRunId;
      const runChanged = Boolean(action.target.runId && action.target.runId !== state.selectedRunId);
      const nextTraces = runChanged ? [] : state.traces;
      const nextEventId = resolveTraceTarget(nextTraces, action.target, nextRunId);
      const shouldFocus = Boolean(nextEventId);
      return {
        ...state,
        selectedRunId: nextRunId,
        events: runChanged ? [] : state.events,
        traces: nextTraces,
        items: runChanged ? [] : state.items,
        selectedItemId: runChanged ? '' : state.selectedItemId,
        inspectorItem: runChanged ? null : state.inspectorItem,
        turns: runChanged ? [] : state.turns,
        turnFilter: runChanged ? '' : state.turnFilter,
        selectedEventId: nextEventId,
        traceFocusVersion: shouldFocus ? state.traceFocusVersion + 1 : state.traceFocusVersion,
        categoryFilter: [],
        errorsOnly: false,
        tracePage: runChanged ? null : state.tracePage,
        pendingTraceTarget: nextEventId ? null : action.target,
      };
    }
    case 'set-item-filter': {
      if (action.filter === state.itemFilter) return state;
      return {
        ...state,
        itemFilter: action.filter,
      };
    }
    case 'set-turn-filter': {
      if (action.filter === state.turnFilter) return state;
      return {
        ...state,
        turnFilter: action.filter,
      };
    }
    case 'set-category-filter': {
      return {
        ...state,
        categoryFilter: action.categories,
      };
    }
    case 'toggle-errors-only': {
      return {
        ...state,
        errorsOnly: action.value,
      };
    }
    case 'clear-items': {
      if (state.items.length === 0 && state.selectedItemId === '' && state.inspectorItem === null) {
        return state;
      }
      return {
        ...state,
        items: [],
        selectedItemId: '',
        inspectorItem: null,
      };
    }
    case 'toggle-thread': {
      return {
        ...state,
        expandedThreadId: state.expandedThreadId === action.threadId ? '' : action.threadId,
      };
    }
    case 'load-error': {
      if (action.requestId !== state.activeRequestId) return state;
      return {
        ...state,
        loading: false,
        loadError: action.message,
      };
    }
    case 'refresh.done': {
      if (action.requestId !== state.activeRequestId) return state;
      return {
        ...state,
        loading: false,
      };
    }
    default:
      return state;
  }
}

export function selectSelectedTrace(state: RunMonitorState): RunTraceEnvelope | null {
  if (!state.selectedEventId) return null;
  return state.traces.find((t) => t.eventId === state.selectedEventId) ?? null;
}
