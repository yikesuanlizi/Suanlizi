import { describe, expect, it } from 'vitest';
import type { ThreadId, ThreadMeta } from '@suanlizi/protocol';
import type { ThreadStore } from '@suanlizi/storage';
import { normalizeThreadTitlePatch, updateThreadTitle } from './threadMetadata.js';

function thread(threadId: string): ThreadMeta {
  return {
    threadId,
    title: 'Old',
    workspaceRoot: '',
    status: 'active',
    turnCount: 0,
    createdAt: '2026-06-10T00:00:00.000Z',
    updatedAt: '2026-06-10T00:00:00.000Z',
    archivedAt: null,
    ephemeral: false,
    tags: {},
  };
}

class FakeStore implements Partial<ThreadStore> {
  threads = new Map<ThreadId, ThreadMeta>();

  async getThread(threadId: ThreadId): Promise<ThreadMeta | null> {
    return this.threads.get(threadId) ?? null;
  }

  async updateThreadMetadata(threadId: ThreadId, patch: Partial<Pick<ThreadMeta, 'title'>>): Promise<void> {
    const current = this.threads.get(threadId);
    if (current && patch.title !== undefined) this.threads.set(threadId, { ...current, title: patch.title });
  }
}

describe('thread metadata patch', () => {
  it('requires a non-empty title', () => {
    expect(normalizeThreadTitlePatch({ title: '  新标题  ' })).toBe('新标题');
    expect(normalizeThreadTitlePatch({ title: '   ' })).toBeNull();
    expect(normalizeThreadTitlePatch({})).toBeNull();
  });

  it('updates an existing thread title and returns null for missing threads', async () => {
    const store = new FakeStore();
    store.threads.set('a', thread('a'));

    await expect(updateThreadTitle(store as unknown as ThreadStore, 'a', 'New')).resolves.toMatchObject({ title: 'New' });
    await expect(updateThreadTitle(store as unknown as ThreadStore, 'missing', 'New')).resolves.toBeNull();
  });
});
