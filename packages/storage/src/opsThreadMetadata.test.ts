import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from './index.js';
import type { ThreadMeta } from '@suanlizi/protocol';

function thread(overrides: Partial<ThreadMeta> = {}): ThreadMeta {
  const now = '2026-08-19T00:00:00.000Z';
  return {
    threadId: 'ops-thread-1',
    title: 'Ops thread',
    workspaceRoot: 'D:/workspace',
    status: 'active',
    turnCount: 0,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    ephemeral: false,
    tags: {},
    ...overrides,
  };
}

describe('Thread Ops entrance metadata persistence', () => {
  it('persists mode and taskPreset through the storage boundary', async () => {
    const { store } = createStore(mkdtempSync(join(tmpdir(), 'suanlizi-ops-thread-')));
    await store.createThread(thread({ mode: 'ops', taskPreset: 'ops' }));

    await expect(store.getThread('ops-thread-1')).resolves.toMatchObject({
      mode: 'ops',
      taskPreset: 'ops',
    });

    await store.updateThreadMetadata('ops-thread-1', { mode: 'chat', taskPreset: null });
    await expect(store.getThread('ops-thread-1')).resolves.toMatchObject({
      mode: 'chat',
      taskPreset: null,
    });
  });
});
