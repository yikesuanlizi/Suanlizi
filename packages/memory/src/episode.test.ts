import { describe, expect, it } from 'vitest';
import type { EpisodeRecord, ThreadId } from '@suanlizi/protocol';
import type { ThreadStore } from '@suanlizi/storage';
import {
  createEpisodeRecord,
  sealEpisode,
  updateEpisodeFromTurn,
  getOpenEpisodeForThread,
  saveEpisodeRecord,
  recordEpisodeUsage,
  invalidateEpisodesByTurnRange,
  demoteColdEpisodes,
  promoteEpisodeToWarm,
  pruneStaleEpisodes,
  buildEpisodePromptBlock,
} from './episode.js';

class EpisodeStore implements ThreadStore {
  episodes: EpisodeRecord[] = [];

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
    threadId?: ThreadId;
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
    return this.listEpisodeRecords(options as { threadId?: ThreadId });
  }

  async recordEpisodeUsage(id: string, usedAt: string): Promise<void> {
    const episode = this.episodes.find((e) => e.id === id);
    if (!episode) return;
    episode.usageCount += 1;
    episode.lastActivatedAt = usedAt;
    episode.updatedAt = usedAt;
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

describe('episode record lifecycle', () => {
  it('creates an open warm episode with a stable fingerprint and topic key', () => {
    const now = new Date('2026-06-20T00:00:00.000Z');
    const episode = createEpisodeRecord(
      {
        workspaceRoot: 'E:/langchain/Suanlizi',
        sourceThreadId: 'thread-1',
        sourceTurnStart: 'turn-0',
        sourceTurnEnd: 'turn-0',
        sourceTurnStartIndex: 0,
        sourceTurnEndIndex: 0,
        objective: 'Implement episode memory',
      },
      now,
    );

    expect(episode.lifecycle).toBe('open');
    expect(episode.temperature).toBe('warm');
    expect(episode.objective).toBe('Implement episode memory');
    expect(episode.title).toBe('Implement episode memory');
    expect(episode.fingerprint).toHaveLength(24);
    expect(episode.topicKey).toHaveLength(24);
    expect(episode.fingerprint).toBe(episode.fingerprint);
  });

  it('seals an open episode and is idempotent for already-sealed episodes', () => {
    const episode = createEpisodeRecord({
      workspaceRoot: 'E:/langchain/Suanlizi',
      sourceThreadId: 'thread-1',
      sourceTurnStart: 'turn-0',
      sourceTurnEnd: 'turn-0',
      sourceTurnStartIndex: 0,
      sourceTurnEndIndex: 0,
    });
    const sealed = sealEpisode(episode, 'task_switch');
    expect(sealed.lifecycle).toBe('sealed');
    expect(sealed.boundaryReason).toBe('task_switch');
    expect(sealEpisode(sealed, 'ignored').lifecycle).toBe('sealed');
  });

  it('updates an episode from turn content', () => {
    const episode = createEpisodeRecord({
      workspaceRoot: 'E:/langchain/Suanlizi',
      sourceThreadId: 'thread-1',
      sourceTurnStart: 'turn-0',
      sourceTurnEnd: 'turn-0',
      sourceTurnStartIndex: 0,
      sourceTurnEndIndex: 0,
      objective: 'Add tests',
    });

    const updated = updateEpisodeFromTurn(
      episode,
      'turn-1',
      1,
      'I decided to use vitest and create a file at src/episode.ts.\n- use vitest\n- keep tests fast',
      'OK, I will add tests for episode memory.',
      [
        { type: 'file_change', path: 'src/episode.ts' },
        { type: 'todo_list', items: [{ text: 'write tests', completed: false }] },
      ],
    );

    expect(updated.sourceTurnEnd).toBe('turn-1');
    expect(updated.sourceTurnEndIndex).toBe(1);
    expect(updated.facts.length).toBeGreaterThan(0);
    expect(updated.decisions.length).toBeGreaterThan(0);
    expect(updated.entities).toContain('src/episode.ts');
    expect(updated.artifacts).toContain('src/episode.ts');
    expect(updated.openTasks).toContain('write tests');
    expect(updated.keywords.length).toBeGreaterThan(0);
    expect(updated.summary).toContain('Add tests');
  });
});

describe('episode persistence helpers', () => {
  it('returns the only open episode for a thread', async () => {
    const store = new EpisodeStore();
    const episode = createEpisodeRecord({
      workspaceRoot: 'E:/langchain/Suanlizi',
      sourceThreadId: 'thread-1',
      sourceTurnStart: 'turn-0',
      sourceTurnEnd: 'turn-0',
      sourceTurnStartIndex: 0,
      sourceTurnEndIndex: 0,
    });
    await saveEpisodeRecord(store, episode);
    await expect(getOpenEpisodeForThread(store, 'thread-1')).resolves.toEqual(
      expect.objectContaining({ id: episode.id, lifecycle: 'open' }),
    );
  });

  it('records usage and promotes cold episodes', async () => {
    const store = new EpisodeStore();
    const episode = createEpisodeRecord({
      workspaceRoot: 'E:/langchain/Suanlizi',
      sourceThreadId: 'thread-1',
      sourceTurnStart: 'turn-0',
      sourceTurnEnd: 'turn-0',
      sourceTurnStartIndex: 0,
      sourceTurnEndIndex: 0,
    });
    episode.temperature = 'cold';
    await saveEpisodeRecord(store, episode);

    await recordEpisodeUsage(store, episode.id, '2026-06-20T00:00:00.000Z');
    const used = await store.getEpisodeRecord(episode.id);
    expect(used?.usageCount).toBe(1);

    await promoteEpisodeToWarm(store, episode.id);
    const warm = await store.getEpisodeRecord(episode.id);
    expect(warm?.temperature).toBe('warm');
  });

  it('invalidates episodes by turn range on rollback', async () => {
    const store = new EpisodeStore();
    const ep1 = createEpisodeRecord({
      workspaceRoot: 'E:/langchain/Suanlizi',
      sourceThreadId: 'thread-1',
      sourceTurnStart: 'turn-0',
      sourceTurnEnd: 'turn-2',
      sourceTurnStartIndex: 0,
      sourceTurnEndIndex: 2,
    });
    const ep2 = createEpisodeRecord({
      workspaceRoot: 'E:/langchain/Suanlizi',
      sourceThreadId: 'thread-1',
      sourceTurnStart: 'turn-2',
      sourceTurnEnd: 'turn-4',
      sourceTurnStartIndex: 2,
      sourceTurnEndIndex: 4,
    });
    await saveEpisodeRecord(store, ep1);
    await saveEpisodeRecord(store, ep2);

    const result = await invalidateEpisodesByTurnRange(store, 'thread-1', 2);
    expect(result.rolledBack).toContain(ep2.id);
    expect(result.stale).toContain(ep1.id);

    const afterEp1 = await store.getEpisodeRecord(ep1.id);
    const afterEp2 = await store.getEpisodeRecord(ep2.id);
    expect(afterEp1?.lifecycle).toBe('stale');
    expect(afterEp2?.lifecycle).toBe('rolled_back');
  });

  it('demotes sealed warm episodes without open tasks after a cooldown', async () => {
    const store = new EpisodeStore();
    const old = createEpisodeRecord(
      {
        workspaceRoot: 'E:/langchain/Suanlizi',
        sourceThreadId: 'thread-1',
        sourceTurnStart: 'turn-0',
        sourceTurnEnd: 'turn-0',
        sourceTurnStartIndex: 0,
        sourceTurnEndIndex: 0,
      },
      new Date('2026-06-01T00:00:00.000Z'),
    );
    old.lifecycle = 'sealed';
    old.temperature = 'warm';
    old.updatedAt = '2026-06-01T00:00:00.000Z';
    await saveEpisodeRecord(store, old);

    const demoted = await demoteColdEpisodes(store, 7, new Date('2026-06-20T00:00:00.000Z'));
    expect(demoted).toBe(1);
    const cold = await store.getEpisodeRecord(old.id);
    expect(cold?.temperature).toBe('cold');
  });

  it('marks old stale unused episodes as rolled back during pruning', async () => {
    const store = new EpisodeStore();
    const stale = createEpisodeRecord(
      {
        workspaceRoot: 'E:/langchain/Suanlizi',
        sourceThreadId: 'thread-1',
        sourceTurnStart: 'turn-0',
        sourceTurnEnd: 'turn-0',
        sourceTurnStartIndex: 0,
        sourceTurnEndIndex: 0,
      },
      new Date('2025-01-01T00:00:00.000Z'),
    );
    stale.lifecycle = 'stale';
    stale.temperature = 'cold';
    stale.updatedAt = '2025-01-01T00:00:00.000Z';
    const used = { ...stale, id: 'ep_used', usageCount: 2, lastActivatedAt: '2026-06-01T00:00:00.000Z' };
    await saveEpisodeRecord(store, stale);
    await saveEpisodeRecord(store, used);

    const result = await pruneStaleEpisodes(store, {
      staleAfterDays: 90,
      now: new Date('2026-06-20T00:00:00.000Z'),
    });

    expect(result.rolledBack).toEqual([stale.id]);
    expect((await store.getEpisodeRecord(stale.id))?.lifecycle).toBe('rolled_back');
    expect((await store.getEpisodeRecord(used.id))?.lifecycle).toBe('stale');
  });
});

describe('episode prompt block', () => {
  it('renders a non-empty block for active episodes', () => {
    const episode = createEpisodeRecord({
      workspaceRoot: 'E:/langchain/Suanlizi',
      sourceThreadId: 'thread-1',
      sourceTurnStart: 'turn-0',
      sourceTurnEnd: 'turn-0',
      sourceTurnStartIndex: 0,
      sourceTurnEndIndex: 0,
      objective: 'Test prompt block',
    });
    episode.summary = 'Testing episode injection';
    episode.facts = ['fact one'];
    const block = buildEpisodePromptBlock([episode]);
    expect(block).toContain('Episode Recall');
    expect(block).toContain(episode.id);
    expect(block).toContain('Testing episode injection');
  });

  it('returns an empty string for no episodes', () => {
    expect(buildEpisodePromptBlock([])).toBe('');
  });
});
