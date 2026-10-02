import { describe, expect, it } from 'vitest';
import { aggregateThreadUsage, usageFromThread } from './usage.js';

describe('usage aggregation', () => {
  it('sums parent and child usage while preserving turn details', () => {
    const parent = usageFromThread({
      threadId: 'parent',
      tags: {
        threadUsage: JSON.stringify({
          threadId: 'parent',
          total: { inputTokens: 100, cachedInputTokens: 40, outputTokens: 20, reasoningOutputTokens: 0 },
          turns: [{ turnId: 'p1', usage: { inputTokens: 100, cachedInputTokens: 40, outputTokens: 20, reasoningOutputTokens: 0 }, timestamp: '2026-06-10T00:00:00.000Z' }],
          updatedAt: '2026-06-10T00:00:00.000Z',
        }),
      },
    });
    const child = usageFromThread({
      threadId: 'child',
      tags: {
        threadUsage: JSON.stringify({
          threadId: 'child',
          total: { inputTokens: 50, cachedInputTokens: 30, outputTokens: 10, reasoningOutputTokens: 0 },
          turns: [{ turnId: 'c1', usage: { inputTokens: 50, cachedInputTokens: 30, outputTokens: 10, reasoningOutputTokens: 0 }, timestamp: '2026-06-10T00:01:00.000Z' }],
          updatedAt: '2026-06-10T00:01:00.000Z',
        }),
      },
    });

    expect(aggregateThreadUsage('parent', [parent, child])).toMatchObject({
      threadId: 'parent',
      total: {
        inputTokens: 150,
        cachedInputTokens: 70,
        outputTokens: 30,
        reasoningOutputTokens: 0,
      },
      turns: [
        expect.objectContaining({ turnId: 'p1' }),
        expect.objectContaining({ turnId: 'c1' }),
      ],
      includedThreadIds: ['parent', 'child'],
    });
  });

  it('aggregates cache reporting as a three-state value', () => {
    const make = (threadId: string, cacheReported?: boolean) => usageFromThread({
      threadId,
      tags: {
        threadUsage: JSON.stringify({
          threadId,
          total: { inputTokens: 10, cachedInputTokens: cacheReported === true ? 5 : 0, outputTokens: 1, reasoningOutputTokens: 0, ...(cacheReported === undefined ? {} : { cacheReported }) },
          turns: [],
          updatedAt: '2026-06-10T00:00:00.000Z',
        }),
      },
    });

    expect(aggregateThreadUsage('parent', [make('a', true), make('b', true)]).total.cacheReported).toBe(true);
    expect(aggregateThreadUsage('parent', [make('a', true), make('b', false)]).total.cacheReported).toBe(false);
    expect(aggregateThreadUsage('parent', [make('a'), make('b')]).total.cacheReported).toBeUndefined();
  });
});
