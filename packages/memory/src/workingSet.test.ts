import { describe, expect, it } from 'vitest';
import type { EpisodeRecord, ThreadMeta, UserInput } from '@suanlizi/protocol';
import type { ThreadStore } from '@suanlizi/storage';
import {
  buildOrReuseWorkingSet,
  computeTaskFingerprint,
  emptyWorkingSetSnapshot,
  getThreadWorkingSetSnapshot,
  saveThreadWorkingSetSnapshot,
} from './workingSet.js';

class WorkingSetStore implements ThreadStore {
  episodes: EpisodeRecord[] = [];
  workingSets: Map<string, import('@suanlizi/protocol').ThreadWorkingSetSnapshot> = new Map();

  async appendItems(): Promise<void> {}

  async upsertEpisodeRecord(record: EpisodeRecord): Promise<void> {
    const index = this.episodes.findIndex((e) => e.id === record.id);
    if (index >= 0) this.episodes[index] = record;
    else this.episodes.push(record);
  }

  async getEpisodeRecord(id: string): Promise<EpisodeRecord | null> {
    return this.episodes.find((e) => e.id === id) ?? null;
  }

  async listEpisodeRecords(options?: {
    threadId?: string;
    lifecycle?: Array<EpisodeRecord['lifecycle']>;
    temperature?: Array<EpisodeRecord['temperature']>;
  }): Promise<EpisodeRecord[]> {
    return this.episodes.filter((e) => {
      if (options?.threadId && e.sourceThreadId !== options.threadId) return false;
      if (options?.lifecycle && !options.lifecycle.includes(e.lifecycle)) return false;
      if (options?.temperature && !options.temperature.includes(e.temperature)) return false;
      return true;
    });
  }

  async searchEpisodeRecords(_query: string, options?: object): Promise<EpisodeRecord[]> {
    return this.listEpisodeRecords(options as { threadId?: string });
  }

  async recordEpisodeUsage(id: string): Promise<void> {
    const episode = this.episodes.find((e) => e.id === id);
    if (episode) episode.usageCount += 1;
  }

  async saveThreadWorkingSet(snapshot: import('@suanlizi/protocol').ThreadWorkingSetSnapshot): Promise<void> {
    this.workingSets.set(snapshot.threadId, { ...snapshot });
  }

  async getThreadWorkingSet(threadId: string): Promise<import('@suanlizi/protocol').ThreadWorkingSetSnapshot | null> {
    return this.workingSets.get(threadId) ?? null;
  }

  async deleteThreadWorkingSet(threadId: string): Promise<void> {
    this.workingSets.delete(threadId);
  }

  async getSetting<T = unknown>(): Promise<T | null> { return null; }
  async setSetting(): Promise<void> {}
  async getThread(): Promise<null> { return null; }
  async createThread(): Promise<void> {}
  async updateThreadMetadata(): Promise<void> {}
  async listThreads(): Promise<never[]> { return []; }
  async deleteThread(): Promise<void> {}
  async getItems(): Promise<never[]> { return []; }
  async getRecentItems(): Promise<never[]> { return []; }
  async getTurns(): Promise<never[]> { return []; }
  async saveTurn(): Promise<void> {}
  async getLastCheckpoint(): Promise<null> { return null; }
  async appendCheckpoint(): Promise<void> {}
  async appendRollbackMarker(): Promise<void> {}
  async upsertThreadSpawnEdge(): Promise<void> {}
  async setThreadSpawnEdgeStatus(): Promise<void> {}
  async listThreadSpawnChildren(): Promise<never[]> { return []; }
  async listThreadSpawnDescendants(): Promise<never[]> { return []; }
  async createRunRecord?(): Promise<void> {}
  async updateRunRecord?(): Promise<void> {}
  async appendRunEvent?(): Promise<void> {}
  async listRunRecords?(): Promise<never[]> { return []; }
  async listRunEvents?(): Promise<never[]> { return []; }
  async upsertRunFeedback?(): Promise<void> {}
  async listRunFeedback?(): Promise<never[]> { return []; }
}

function makeThread(threadId: string): ThreadMeta {
  return {
    threadId,
    title: 'test thread',
    workspaceRoot: 'E:/langchain/Suanlizi',
    status: 'active',
    turnCount: 1,
    createdAt: '2026-06-20T00:00:00.000Z',
    updatedAt: '2026-06-20T00:00:00.000Z',
    archivedAt: null,
    ephemeral: false,
    tags: {},
  };
}

const settings = {
  episodeMemoryEnabled: true,
  episodeInjectLimit: 2,
  episodeTokenBudget: 800,
  episodeSwitchCooldownTurns: 2,
  episodeSealIdleMinutes: 20,
  episodeColdAfterDays: 7,
  episodeFtsCandidateLimit: 40,
  episodeRerankEnabled: false,
};

describe('working set helpers', () => {
  it('computes deterministic task fingerprints', () => {
    const a = computeTaskFingerprint('hello world', 'goal');
    const b = computeTaskFingerprint('world hello', 'goal');
    expect(a).toHaveLength(24);
    expect(a).toBe(b);
  });

  it('returns an empty snapshot for a thread id', () => {
    const snapshot = emptyWorkingSetSnapshot('thread-1');
    expect(snapshot.threadId).toBe('thread-1');
    expect(snapshot.generation).toBe(0);
    expect(snapshot.activeEpisodeIds).toEqual([]);
  });

  it('saves and retrieves a working set snapshot', async () => {
    const store = new WorkingSetStore();
    const snapshot = emptyWorkingSetSnapshot('thread-1');
    await saveThreadWorkingSetSnapshot(store, snapshot);
    const loaded = await getThreadWorkingSetSnapshot(store, 'thread-1');
    expect(loaded).toEqual(expect.objectContaining({ threadId: 'thread-1' }));
  });

  it('builds a working set on the first turn and creates an open episode', async () => {
    const store = new WorkingSetStore();
    const thread = makeThread('thread-1');
    const userInput: UserInput = { type: 'text', text: 'Add episode memory tests' };
    const result = await buildOrReuseWorkingSet(
      store,
      thread,
      userInput,
      'turn-0',
      0,
      null,
      settings,
    );

    expect(result.rebuilt).toBe(true);
    expect(result.openEpisode).not.toBeNull();
    expect(result.snapshot.activeEpisodeIds).toEqual([]);
    expect(result.snapshot.frozenPromptBlock).toBe('');
    expect(result.snapshot.taskFingerprint).toBe(computeTaskFingerprint('Add episode memory tests', undefined));
  });

  it('reuses a working set when the task fingerprint matches', async () => {
    const store = new WorkingSetStore();
    const thread = makeThread('thread-1');
    const userInput: UserInput = { type: 'text', text: 'Continue the same task' };

    const first = await buildOrReuseWorkingSet(store, thread, userInput, 'turn-0', 0, null, settings);
    const second = await buildOrReuseWorkingSet(
      store,
      thread,
      userInput,
      'turn-1',
      1,
      first.openEpisode,
      settings,
    );

    expect(second.rebuilt).toBe(false);
    expect(second.snapshot.generation).toBe(first.snapshot.generation);
  });

  it('rebuilds after the cooldown when the fingerprint changes but keeps the same episode', async () => {
    const store = new WorkingSetStore();
    const thread = makeThread('thread-1');
    const firstInput: UserInput = { type: 'text', text: 'Fix the login bug' };
    const secondInput: UserInput = { type: 'text', text: 'Can you fix the bug in login' };

    const first = await buildOrReuseWorkingSet(store, thread, firstInput, 'turn-0', 0, null, {
      ...settings,
      episodeSwitchCooldownTurns: 0,
    });
    const second = await buildOrReuseWorkingSet(
      store,
      thread,
      secondInput,
      'turn-1',
      1,
      first.openEpisode,
      { ...settings, episodeSwitchCooldownTurns: 0 },
    );

    expect(second.rebuilt).toBe(true);
    expect(second.snapshot.generation).toBeGreaterThan(first.snapshot.generation);
    expect(second.openEpisode?.id).toBe(first.openEpisode?.id);
    expect(second.switchReason).toBe('cooldown_rebuild_only');
  });

  it('does not cut a new episode when the user rephrases the same task after cooldown', async () => {
    const store = new WorkingSetStore();
    const thread = makeThread('thread-1');
    const firstInput: UserInput = { type: 'text', text: 'Fix the login bug' };
    const secondInput: UserInput = { type: 'text', text: 'Can you fix the bug in login' };

    const first = await buildOrReuseWorkingSet(store, thread, firstInput, 'turn-0', 0, null, {
      ...settings,
      episodeSwitchCooldownTurns: 0,
    });
    const second = await buildOrReuseWorkingSet(
      store,
      thread,
      secondInput,
      'turn-1',
      1,
      first.openEpisode,
      { ...settings, episodeSwitchCooldownTurns: 0 },
    );

    expect(second.rebuilt).toBe(true);
    expect(second.openEpisode?.id).toBe(first.openEpisode?.id);
    expect(second.switchReason).toBe('cooldown_rebuild_only');
  });

  it('seals and creates a new episode only on explicit task switch', async () => {
    const store = new WorkingSetStore();
    const thread = makeThread('thread-1');
    const firstInput: UserInput = { type: 'text', text: 'Fix the login bug' };
    const secondInput: UserInput = { type: 'text', text: 'Switch to a new task: refactor database' };

    const first = await buildOrReuseWorkingSet(store, thread, firstInput, 'turn-0', 0, null, {
      ...settings,
      episodeSwitchCooldownTurns: 0,
    });
    const second = await buildOrReuseWorkingSet(
      store,
      thread,
      secondInput,
      'turn-1',
      1,
      first.openEpisode,
      { ...settings, episodeSwitchCooldownTurns: 0 },
    );

    expect(second.rebuilt).toBe(true);
    expect(second.openEpisode?.id).not.toBe(first.openEpisode?.id);
    expect(second.openEpisode?.lifecycle).toBe('open');
    expect(second.switchReason).toBe('explicit_user_switch');

    const episodes = await store.listEpisodeRecords({ threadId: 'thread-1' });
    expect(episodes.some((e) => e.lifecycle === 'sealed')).toBe(true);
    expect(episodes.some((e) => e.lifecycle === 'open')).toBe(true);
  });

  it('seals and creates a new episode on a clear implicit topic switch after cooldown', async () => {
    const store = new WorkingSetStore();
    const thread = makeThread('thread-implicit-switch');
    const firstInput: UserInput = { type: 'text', text: 'Fix the login bug in auth middleware' };
    const secondInput: UserInput = { type: 'text', text: 'Design a pricing page with plan cards' };

    const first = await buildOrReuseWorkingSet(store, thread, firstInput, 'turn-0', 0, null, {
      ...settings,
      episodeSwitchCooldownTurns: 0,
    });
    const second = await buildOrReuseWorkingSet(
      store,
      thread,
      secondInput,
      'turn-1',
      1,
      first.openEpisode,
      { ...settings, episodeSwitchCooldownTurns: 0 },
    );

    expect(second.rebuilt).toBe(true);
    expect(second.switchReason).toBe('implicit_topic_switch');
    expect(second.openEpisode?.id).not.toBe(first.openEpisode?.id);

    const episodes = await store.listEpisodeRecords({ threadId: 'thread-implicit-switch' });
    expect(episodes.find((e) => e.id === first.openEpisode?.id)?.lifecycle).toBe('sealed');
    expect(episodes.find((e) => e.id === second.openEpisode?.id)?.lifecycle).toBe('open');
  });

  it('keeps episode identity stable when active goal and artifacts do not change', async () => {
    const store = new WorkingSetStore();
    const thread = makeThread('thread-1');
    const userInput: UserInput = { type: 'text', text: 'Work on auth' };

    const first = await buildOrReuseWorkingSet(store, thread, userInput, 'turn-0', 0, null, settings);
    const second = await buildOrReuseWorkingSet(
      store,
      thread,
      { type: 'text', text: 'Continue auth work' },
      'turn-1',
      3,
      first.openEpisode,
      { ...settings, episodeSwitchCooldownTurns: 2 },
    );

    expect(second.snapshot.episodeIdentity).toBe(first.snapshot.episodeIdentity);
  });
});
