import { describe, expect, it, vi } from 'vitest';
import type { ThreadStore } from '@suanlizi/storage';
import type { ThreadMeta, TurnMeta } from '@suanlizi/protocol';
import { markRunningTurnsInterrupted } from './shutdown.js';

describe('markRunningTurnsInterrupted', () => {
  it('marks running turns interrupted before shutdown', async () => {
    const now = '2026-06-10T10:00:00.000Z';
    const thread: ThreadMeta = {
      threadId: 'thread-1',
      title: 'Active',
      workspaceRoot: process.cwd(),
      status: 'active',
      turnCount: 2,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      ephemeral: false,
      tags: {},
    };
    const turns: TurnMeta[] = [
      {
        turnId: 'turn-running',
        threadId: thread.threadId,
        index: 0,
        userInput: { type: 'text', text: 'run' },
        status: 'running',
        startedAt: now,
        completedAt: null,
      },
      {
        turnId: 'turn-complete',
        threadId: thread.threadId,
        index: 1,
        userInput: { type: 'text', text: 'done' },
        status: 'completed',
        startedAt: now,
        completedAt: now,
      },
    ];
    const saveTurn = vi.fn(async () => undefined);
    const store = {
      listThreads: async () => [thread],
      getTurns: async () => turns,
      saveTurn,
    } as unknown as ThreadStore;

    await expect(markRunningTurnsInterrupted(store, now)).resolves.toBe(1);
    expect(saveTurn).toHaveBeenCalledWith(expect.objectContaining({
      turnId: 'turn-running',
      status: 'interrupted',
      completedAt: now,
    }));
  });
});
