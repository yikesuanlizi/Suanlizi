import { describe, expect, it } from 'vitest';
import { initialRunMonitorState, runMonitorReducer, type RunMonitorState } from './runMonitorState.js';
import type { RunEvent, RunRecord } from '../../shared/types.js';
import type { RunTraceEnvelope } from '@suanlizi/protocol';

function makeRun(runId: string): RunRecord {
  return {
    runId,
    tenantId: 't1',
    threadId: 'th1',
    kind: 'turn',
    status: 'completed',
    caller: 'lead_agent',
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    toolCallCount: 0,
    modelCallCount: 0,
    subagentCount: 0,
    middlewareEventCount: 0,
    startedAt: '2025-01-01T00:00:00Z',
    updatedAt: '2025-01-01T00:00:00Z',
  };
}

function makeEvent(eventId: string, runId: string): RunEvent {
  return {
    eventId,
    runId,
    tenantId: 't1',
    threadId: 'th1',
    sequence: 0,
    category: 'turn',
    type: 'run.started',
    level: 'info',
    message: 'test',
    createdAt: '2025-01-01T00:00:00Z',
  };
}

function makeTrace(eventId: string, runId: string, itemId?: string): RunTraceEnvelope {
  return {
    version: 2,
    eventId,
    sequence: Number(eventId.replace(/\D/g, '')) || 1,
    runId,
    runKind: 'turn',
    threadId: 'th1',
    spanId: `span-${eventId}`,
    itemId,
    category: 'tool',
    name: `trace-${eventId}`,
    lifecycle: 'completed',
    level: 'info',
    occurredAt: '2025-01-01T00:00:00Z',
    payload: {
      toolName: 'read_file',
      callId: `call-${eventId}`,
    },
  };
}

describe('runMonitorReducer', () => {
  it('preserves an explicitly selected historical run after refresh', () => {
    let state = initialRunMonitorState;
    state = runMonitorReducer(state, { type: 'refresh.begin', requestId: 1 });
    state = runMonitorReducer(state, {
      type: 'runs.loaded',
      requestId: 1,
      runs: [makeRun('run-old')],
    });
    state = runMonitorReducer(state, { type: 'refresh.done', requestId: 1 });
    state = runMonitorReducer(state, { type: 'select-run', runId: 'run-old' });
    expect(state.selectedRunId).toBe('run-old');

    state = runMonitorReducer(state, { type: 'refresh.begin', requestId: 2 });
    state = runMonitorReducer(state, {
      type: 'runs.loaded',
      requestId: 2,
      runs: [makeRun('run-new'), makeRun('run-old')],
    });

    expect(state.selectedRunId).toBe('run-old');
  });

  it('ignores a stale events response', () => {
    let state: RunMonitorState = {
      ...initialRunMonitorState,
      selectedRunId: 'run-b',
      activeRequestId: 4,
      runs: [makeRun('run-a'), makeRun('run-b')],
    };

    state = runMonitorReducer(state, {
      type: 'events.loaded',
      requestId: 3,
      runId: 'run-a',
      events: [makeEvent('evt-stale', 'run-a')],
    });

    expect(state.events).toEqual([]);
  });

  it('selects first run when selected run no longer exists after refresh', () => {
    let state = initialRunMonitorState;
    state = runMonitorReducer(state, { type: 'refresh.begin', requestId: 1 });
    state = runMonitorReducer(state, {
      type: 'runs.loaded',
      requestId: 1,
      runs: [makeRun('run-1'), makeRun('run-2')],
    });
    state = runMonitorReducer(state, { type: 'select-run', runId: 'run-2' });
    state = runMonitorReducer(state, { type: 'refresh.done', requestId: 1 });
    expect(state.selectedRunId).toBe('run-2');

    state = runMonitorReducer(state, { type: 'refresh.begin', requestId: 2 });
    state = runMonitorReducer(state, {
      type: 'runs.loaded',
      requestId: 2,
      runs: [makeRun('run-3'), makeRun('run-4')],
    });

    expect(state.selectedRunId).toBe('run-3');
    expect(state.events).toEqual([]);
  });

  it('ignores stale runs.loaded response (wrong requestId)', () => {
    let state: RunMonitorState = { ...initialRunMonitorState, activeRequestId: 5, runs: [makeRun('existing')] };
    state = runMonitorReducer(state, {
      type: 'runs.loaded',
      requestId: 3,
      runs: [makeRun('stale')],
    });
    expect(state.runs).toEqual([makeRun('existing')]);
  });

  it('ignores events.loaded for wrong runId even with correct requestId', () => {
    let state: RunMonitorState = {
      ...initialRunMonitorState,
      selectedRunId: 'run-current',
      activeRequestId: 10,
    };
    state = runMonitorReducer(state, {
      type: 'events.loaded',
      requestId: 10,
      runId: 'run-other',
      events: [makeEvent('evt1', 'run-other')],
    });
    expect(state.events).toEqual([]);
  });

  it('applies events.loaded when both requestId and runId match', () => {
    const events = [makeEvent('evt1', 'run-current')];
    let state: RunMonitorState = {
      ...initialRunMonitorState,
      selectedRunId: 'run-current',
      activeRequestId: 10,
    };
    state = runMonitorReducer(state, {
      type: 'events.loaded',
      requestId: 10,
      runId: 'run-current',
      events,
    });
    expect(state.events).toEqual(events);
  });

  it('select-run clears events and updates selectedRunId', () => {
    let state: RunMonitorState = {
      ...initialRunMonitorState,
      selectedRunId: 'run-a',
      events: [makeEvent('evt1', 'run-a')],
    };
    state = runMonitorReducer(state, { type: 'select-run', runId: 'run-b' });
    expect(state.selectedRunId).toBe('run-b');
    expect(state.events).toEqual([]);
  });

  it('toggle-thread toggles expandedThreadId', () => {
    let state = initialRunMonitorState;
    state = runMonitorReducer(state, { type: 'toggle-thread', threadId: 'th1' });
    expect(state.expandedThreadId).toBe('th1');
    state = runMonitorReducer(state, { type: 'toggle-thread', threadId: 'th1' });
    expect(state.expandedThreadId).toBe('');
    state = runMonitorReducer(state, { type: 'toggle-thread', threadId: 'th2' });
    expect(state.expandedThreadId).toBe('th2');
  });

  it('refresh.begin increments activeRequestId and sets loading', () => {
    const state = runMonitorReducer(initialRunMonitorState, { type: 'refresh.begin', requestId: 1 });
    expect(state.activeRequestId).toBe(1);
    expect(state.loading).toBe(true);
  });

  it('refresh.done clears loading only when requestId matches', () => {
    let state = runMonitorReducer(initialRunMonitorState, { type: 'refresh.begin', requestId: 1 });
    expect(state.loading).toBe(true);
    state = runMonitorReducer(state, { type: 'refresh.done', requestId: 99 });
    expect(state.loading).toBe(true);
    state = runMonitorReducer(state, { type: 'refresh.done', requestId: 1 });
    expect(state.loading).toBe(false);
  });

  it('resolves a queued trace target by itemId after traces load', () => {
    let state: RunMonitorState = {
      ...initialRunMonitorState,
      selectedRunId: 'run-a',
      activeRequestId: 1,
    };

    state = runMonitorReducer(state, {
      type: 'queue-trace-target',
      target: { runId: 'run-a', itemId: 'item-target' },
    });
    expect(state.selectedEventId).toBe('');

    state = runMonitorReducer(state, {
      type: 'traces.loaded',
      requestId: 1,
      runId: 'run-a',
      traces: [
        makeTrace('evt-1', 'run-a', 'item-other'),
        makeTrace('evt-2', 'run-a', 'item-target'),
      ],
    });

    expect(state.selectedEventId).toBe('evt-2');
    expect(state.pendingTraceTarget).toBeNull();
    expect(state.traceFocusVersion).toBe(1);
  });

  it('resolves a queued trace target by eventId after traces load', () => {
    let state: RunMonitorState = {
      ...initialRunMonitorState,
      selectedRunId: 'run-b',
      activeRequestId: 2,
    };

    state = runMonitorReducer(state, {
      type: 'queue-trace-target',
      target: { runId: 'run-b', eventId: 'evt-9' },
    });
    state = runMonitorReducer(state, {
      type: 'traces.loaded',
      requestId: 2,
      runId: 'run-b',
      traces: [
        makeTrace('evt-8', 'run-b'),
        makeTrace('evt-9', 'run-b'),
      ],
    });

    expect(state.selectedEventId).toBe('evt-9');
    expect(state.pendingTraceTarget).toBeNull();
    expect(state.traceFocusVersion).toBe(1);
  });

  it('select-by-itemId also queues when the trace is not loaded yet', () => {
    let state: RunMonitorState = {
      ...initialRunMonitorState,
      selectedRunId: 'run-c',
      activeRequestId: 3,
    };

    state = runMonitorReducer(state, {
      type: 'select-by-itemId',
      itemId: 'item-late',
    });
    expect(state.pendingTraceTarget).toEqual({ runId: 'run-c', itemId: 'item-late' });

    state = runMonitorReducer(state, {
      type: 'traces.loaded',
      requestId: 3,
      runId: 'run-c',
      traces: [makeTrace('evt-10', 'run-c', 'item-late')],
    });

    expect(state.selectedEventId).toBe('evt-10');
    expect(state.pendingTraceTarget).toBeNull();
    expect(state.traceFocusVersion).toBe(1);
  });

  it('re-triggers trace focus when the same selected event is queued again', () => {
    let state: RunMonitorState = {
      ...initialRunMonitorState,
      selectedRunId: 'run-d',
      traces: [makeTrace('evt-20', 'run-d', 'item-repeat')],
      selectedEventId: 'evt-20',
      traceFocusVersion: 4,
    };

    state = runMonitorReducer(state, {
      type: 'queue-trace-target',
      target: { runId: 'run-d', eventId: 'evt-20' },
    });

    expect(state.selectedEventId).toBe('evt-20');
    expect(state.pendingTraceTarget).toBeNull();
    expect(state.traceFocusVersion).toBe(5);
  });
});
