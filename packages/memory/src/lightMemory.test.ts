import { describe, expect, it } from 'vitest';
import type { ThreadStore } from '@suanlizi/storage';
import {
  deleteLightMemory,
  flushLightMemoryQueue,
  listLightMemories,
  queueLightMemory,
  setLightMemoryEnabled,
} from './lightMemory.js';

function memoryStore(): ThreadStore {
  const settings = new Map<string, unknown>();
  return {
    async getSetting<T = unknown>(key: string): Promise<T | null> {
      return (settings.get(key) as T | undefined) ?? null;
    },
    async setSetting(key: string, value: unknown): Promise<void> {
      settings.set(key, value);
    },
  } as ThreadStore;
}

describe('light memory', () => {
  it('queues and debounces local memories before flushing', async () => {
    const store = memoryStore();
    const now = new Date('2026-06-15T00:00:00.000Z');

    await queueLightMemory(store, ' User prefers concise Chinese summaries. ', {
      now,
      debounceMs: 1000,
      sourceThreadId: 'thread-1',
    });
    await queueLightMemory(store, 'user   prefers concise chinese summaries.', {
      now: new Date(now.getTime() + 100),
      debounceMs: 1000,
      sourceThreadId: 'thread-1',
    });

    expect(await listLightMemories(store)).toEqual([]);
    await flushLightMemoryQueue(store, new Date(now.getTime() + 1100));

    expect(await listLightMemories(store)).toEqual([
      expect.objectContaining({
        text: 'user prefers concise chinese summaries.',
        sourceThreadId: 'thread-1',
      }),
    ]);
  });

  it('can be disabled and supports deletion', async () => {
    const store = memoryStore();
    await setLightMemoryEnabled(store, false);
    await queueLightMemory(store, 'Remember this', { now: new Date('2026-06-15T00:00:00.000Z') });
    await flushLightMemoryQueue(store, new Date('2026-06-15T00:01:00.000Z'));
    expect(await listLightMemories(store)).toEqual([]);

    await setLightMemoryEnabled(store, true);
    await queueLightMemory(store, 'Remember this', {
      now: new Date('2026-06-15T00:02:00.000Z'),
      debounceMs: 0,
    });
    const flushed = await flushLightMemoryQueue(store, new Date('2026-06-15T00:02:00.000Z'));
    expect(flushed.entries).toHaveLength(1);

    await deleteLightMemory(store, flushed.entries[0]!.id);
    expect(await listLightMemories(store)).toEqual([]);
  });
});
