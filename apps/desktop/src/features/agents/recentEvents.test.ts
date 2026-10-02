
import { describe, expect, it } from 'vitest';
import type { ThreadItem } from '../../shared/types.js';
import { deriveRecentEvents, reconcileRecentEvents, type RecentEvent } from './recentEvents.js';

const agent = { threadId: 'main', label: 'Suanlizi', depth: 0 };

function errorEvent(overrides: Partial<RecentEvent> = {}): RecentEvent {
  return {
    itemId: 'error-item',
    runId: 'run-1',
    category: 'error',
    name: 'provider',
    level: 'error',
    status: 'failed',
    summary: '模型响应超时',
    detail: 'HTTP 504 upstream timeout',
    occurredAt: '2025-01-01T00:00:01Z',
    agent,
    ...overrides,
  };
}

describe('reconcileRecentEvents', () => {
  it('merges repeated run errors and keeps the earliest time and richest detail', () => {
    const events = [
      errorEvent({ itemId: 'error-1', occurredAt: '2025-01-01T00:00:02Z', detail: 'HTTP 504 upstream timeout' }),
      errorEvent({ itemId: 'trace-2', eventId: 'trace-2', occurredAt: '2025-01-01T00:00:01Z', detail: 'HTTP 504 upstream timeout' }),

    ];
    expect(reconcileRecentEvents(events)).toHaveLength(1);
    expect(reconcileRecentEvents(events)[0]).toMatchObject({
      occurredAt: '2025-01-01T00:00:01Z',
      detail: 'HTTP 504 upstream timeout',
    });
  });

  it('drops a failed tool row that only duplicates a detailed run error', () => {
    const events = [
      errorEvent({ itemId: 'error-1' }),
      errorEvent({
        itemId: 'tool-1', category: 'tool', name: 'browser_click', level: 'error',
        summary: 'browser_click failed', detail: undefined,
      }),
    ];
    expect(reconcileRecentEvents(events)).toHaveLength(1);
    expect(reconcileRecentEvents(events)[0].itemId).toBe('error-1');
  });

  it('keeps distinct failures and orders by time', () => {
    const events = [
      errorEvent({ itemId: 'second', runId: 'run-2', occurredAt: '2025-01-01T00:00:02Z' }),
      errorEvent({ itemId: 'first', occurredAt: '2025-01-01T00:00:01Z' }),
    ];
    expect(reconcileRecentEvents(events).map(event => event.itemId)).toEqual(['first', 'second']);
  });
});

describe('deriveRecentEvents', () => {
  it('omits reasoning items and does not use a long body as the row title', () => {
    const reasoning: ThreadItem = {
      id: 'reason-1',
      type: 'reasoning',
      text: 'Current state: - [e12] now shows a very long thought that must stay out of the activity list',
      timestamp: '2025-01-01T00:00:01Z',
      status: 'completed',
    };
    const note: ThreadItem = {
      id: 'note-1',
      type: 'file_change',
      text: 'x'.repeat(180),
      timestamp: '2025-01-01T00:00:02Z',
      status: 'completed',
    };
    const tool: ThreadItem = {
      id: 'tool-1',
      type: 'tool_call',
      toolName: 'browser_observe',
      timestamp: '2025-01-01T00:00:03Z',
      status: 'completed',
    };
    const events = deriveRecentEvents('main', [], [reasoning, note, tool], [], 'run-1', true);
    expect(events.map((event) => event.itemId)).toEqual(['note-1', 'tool-1']);
    expect(events[0]).toMatchObject({ name: 'file_change' });
    expect(events[0]?.summary).toHaveLength(180);
    expect(events[1]).toMatchObject({ name: 'browser_observe', summary: 'browser_observe' });
    expect(events.some((event) => event.name.includes('Current state') || event.summary.includes('Current state'))).toBe(false);
  });
});
