import { describe, expect, it } from 'vitest';
import type { EpisodeRecord } from '@suanlizi/protocol';
import type { ThreadStore } from '@suanlizi/storage';
import { buildEpisodeSearchTerms, retrieveEpisodesForWorkingSet } from './episodeRetrieval.js';
import { createEpisodeRecord, saveEpisodeRecord } from './episode.js';

class RetrievalStore implements ThreadStore {
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
    threadId?: string;
    lifecycle?: Array<EpisodeRecord['lifecycle']>;
    temperature?: Array<EpisodeRecord['temperature']>;
    excludeEpisodeIds?: string[];
  }): Promise<EpisodeRecord[]> {
    return this.episodes.filter((e) => {
      if (options?.threadId && e.sourceThreadId !== options.threadId) return false;
      if (options?.lifecycle && !options.lifecycle.includes(e.lifecycle)) return false;
      if (options?.temperature && !options.temperature.includes(e.temperature)) return false;
      if (options?.excludeEpisodeIds?.includes(e.id)) return false;
      return true;
    });
  }

  async searchEpisodeRecords(query: string, options?: object): Promise<EpisodeRecord[]> {
    const opts = options as { excludeEpisodeIds?: string[] };
    const tokens = query
      .toLowerCase()
      .split(/\s+or\s+/)
      .map((t) => t.replace(/^"|"$/g, '').trim())
      .filter(Boolean);
    return this.episodes.filter((e) => {
      if (opts?.excludeEpisodeIds?.includes(e.id)) return false;
      const haystack = [
        e.title,
        e.objective,
        e.summary,
        ...e.facts,
        ...e.decisions,
        ...e.artifacts,
        ...e.keywords,
      ]
        .join(' ')
        .toLowerCase();
      return tokens.some((token) => haystack.includes(token));
    });
  }

  async recordEpisodeUsage(id: string): Promise<void> {
    const episode = this.episodes.find((e) => e.id === id);
    if (episode) episode.usageCount += 1;
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

describe('episode retrieval', () => {
  it('returns empty results when no episodes exist', async () => {
    const store = new RetrievalStore();
    const results = await retrieveEpisodesForWorkingSet(
      store,
      {
        threadId: 'thread-1',
        currentTurnId: 'turn-0',
        workspaceRoot: 'E:/langchain/Suanlizi',
        userInput: 'hello',
        taskFingerprint: 'abc',
      },
      { ftsCandidateLimit: 10, injectLimit: 2, tokenBudget: 800, rerankEnabled: false },
    );
    expect(results).toEqual([]);
  });

  it('ranks an explicitly referenced episode highest', async () => {
    const store = new RetrievalStore();
    const ep1 = createEpisodeRecord({
      workspaceRoot: 'E:/langchain/Suanlizi',
      sourceThreadId: 'other-thread',
      sourceTurnStart: 'turn-0',
      sourceTurnEnd: 'turn-0',
      sourceTurnStartIndex: 0,
      sourceTurnEndIndex: 0,
      objective: 'Authentication service',
      title: 'Auth service',
    });
    ep1.lifecycle = 'sealed';
    ep1.summary = 'Implemented JWT auth';
    const ep2 = createEpisodeRecord({
      workspaceRoot: 'E:/langchain/Suanlizi',
      sourceThreadId: 'other-thread',
      sourceTurnStart: 'turn-1',
      sourceTurnEnd: 'turn-1',
      sourceTurnStartIndex: 1,
      sourceTurnEndIndex: 1,
      objective: 'Database migration',
      title: 'DB migration',
    });
    ep2.lifecycle = 'sealed';
    ep2.summary = 'Ran Postgres migration';
    await saveEpisodeRecord(store, ep1);
    await saveEpisodeRecord(store, ep2);

    const results = await retrieveEpisodesForWorkingSet(
      store,
      {
        threadId: 'thread-1',
        currentTurnId: 'turn-0',
        workspaceRoot: 'E:/langchain/Suanlizi',
        userInput: 'Tell me about the Auth service',
        taskFingerprint: 'auth',
      },
      { ftsCandidateLimit: 10, injectLimit: 2, tokenBudget: 800, rerankEnabled: false },
    );

    expect(results.length).toBe(1);
    expect(results[0].episode.id).toBe(ep1.id);
    expect(results[0].reason).toContain('explicit');
  });

  it('excludes already injected episodes', async () => {
    const store = new RetrievalStore();
    const ep = createEpisodeRecord({
      workspaceRoot: 'E:/langchain/Suanlizi',
      sourceThreadId: 'other-thread',
      sourceTurnStart: 'turn-0',
      sourceTurnEnd: 'turn-0',
      sourceTurnStartIndex: 0,
      sourceTurnEndIndex: 0,
      objective: 'Shared utility',
    });
    ep.lifecycle = 'sealed';
    ep.summary = 'utility work';
    await saveEpisodeRecord(store, ep);

    const results = await retrieveEpisodesForWorkingSet(
      store,
      {
        threadId: 'thread-1',
        currentTurnId: 'turn-0',
        workspaceRoot: 'E:/langchain/Suanlizi',
        userInput: 'utility',
        taskFingerprint: 'utility',
        injectedEpisodeIds: [ep.id],
      },
      { ftsCandidateLimit: 10, injectLimit: 2, tokenBudget: 800, rerankEnabled: false },
    );

    expect(results.find((r) => r.episode.id === ep.id)).toBeUndefined();
  });

  it('builds safe search terms from Windows paths and file paths', () => {
    const terms = buildEpisodeSearchTerms('E:/langchain/Suanlizi/src/foo.ts');
    expect(terms).toContain('langchain');
    expect(terms).toContain('suanlizi');
    expect(terms).toContain('src');
    expect(terms).toContain('foo');
    expect(terms).toContain('foo.ts');
    expect(terms).not.toContain('E:');
  });

  it('builds safe search terms from colon queries without FTS operators', () => {
    const terms = buildEpisodeSearchTerms('a:b');
    expect(terms).toContain('a');
    expect(terms).toContain('b');
    expect(terms).not.toContain('a:b');
  });

  it('recalls episodes from path-like user input', async () => {
    const store = new RetrievalStore();
    const ep = createEpisodeRecord({
      workspaceRoot: 'E:/langchain/Suanlizi',
      sourceThreadId: 'other-thread',
      sourceTurnStart: 'turn-0',
      sourceTurnEnd: 'turn-0',
      sourceTurnStartIndex: 0,
      sourceTurnEndIndex: 0,
      objective: 'Fix src/foo.ts',
    });
    ep.lifecycle = 'sealed';
    ep.summary = 'Worked on src/foo.ts';
    ep.artifacts = ['src/foo.ts'];
    await saveEpisodeRecord(store, ep);

    const results = await retrieveEpisodesForWorkingSet(
      store,
      {
        threadId: 'thread-1',
        currentTurnId: 'turn-0',
        workspaceRoot: 'E:/langchain/Suanlizi',
        userInput: 'E:/langchain/Suanlizi/src/foo.ts',
        taskFingerprint: 'path',
      },
      { ftsCandidateLimit: 10, injectLimit: 2, tokenBudget: 800, rerankEnabled: false },
    );

    expect(results.length).toBeGreaterThan(0);
    expect(results[0].episode.id).toBe(ep.id);
    expect(results[0].reason).toContain('explicit');
  });
});
