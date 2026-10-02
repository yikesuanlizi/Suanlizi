import { describe, expect, it } from 'vitest';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type {
  EpisodeRecord,
  MemoryRecord,
  ThreadId,
  ThreadMeta,
  ThreadWorkingSetSnapshot,
  TurnMeta,
  UserInput,
} from '@suanlizi/protocol';
import type { ThreadStore } from '@suanlizi/storage';
import { handleMemoryRoute } from './memoryRoute.js';
import type { AgentRunConfig } from '../config/config.js';

function req(method: string, url: string, body?: unknown): IncomingMessage {
  const stream = Readable.from(body ? [Buffer.from(JSON.stringify(body), 'utf-8')] : []);
  return Object.assign(stream, { method, url }) as IncomingMessage;
}

function res(): ServerResponse & { status?: number; body?: unknown; ended?: boolean } {
  const output = {
    writeHead(status: number) {
      output.status = status;
      return output;
    },
    end(raw: string) {
      output.ended = true;
      output.body = raw ? JSON.parse(raw) : undefined;
    },
  } as unknown as ServerResponse & { status?: number; body?: unknown; ended?: boolean };
  return output;
}

async function route(method: string, url: string, body?: unknown, store?: FakeStore) {
  const parsed = new URL(url, 'http://localhost');
  const response = res();
  const activeStore = store ?? new FakeStore();
  const handled = await handleMemoryRoute({
    req: req(method, url, body),
    res: response,
    url: parsed,
    pathname: parsed.pathname,
    store: activeStore as unknown as ThreadStore,
    getDefaultRunConfig: async () => defaultConfig(),
    saveDefaultRunConfig: async (patch) => ({ ...defaultConfig(), ...patch }),
  });
  return { handled, response, store: activeStore };
}

function defaultConfig(): AgentRunConfig {
  return {
    workspaceRoot: process.cwd(),
    dataDir: process.cwd(),
    memoryEnabled: true,
    autoExtractMemories: false,
    useColdMemories: true,
    memoryInjectLimit: 2,
    memoryTokenBudget: 800,
    episodeMemoryEnabled: true,
    episodeInjectLimit: 2,
    episodeTokenBudget: 800,
    episodeSwitchCooldownTurns: 2,
    episodeSealIdleMinutes: 20,
    episodeColdAfterDays: 7,
    episodeFtsCandidateLimit: 40,
    episodeRerankEnabled: false,
  } as AgentRunConfig;
}

class FakeStore {
  threads = new Map<ThreadId, ThreadMeta>();
  turns = new Map<ThreadId, TurnMeta[]>();
  settings = new Map<string, unknown>();
  memories: MemoryRecord[] = [];
  episodes: EpisodeRecord[] = [];
  workingSets = new Map<ThreadId, ThreadWorkingSetSnapshot>();

  async getSetting<T = unknown>(key: string): Promise<T | null> {
    return (this.settings.get(key) as T) ?? null;
  }

  async setSetting<T = unknown>(key: string, value: T): Promise<void> {
    this.settings.set(key, value);
  }

  async getThread(threadId: ThreadId): Promise<ThreadMeta | null> {
    return this.threads.get(threadId) ?? null;
  }

  async updateThreadMetadata(threadId: ThreadId, patch: Partial<ThreadMeta>): Promise<void> {
    const current = this.threads.get(threadId);
    if (current) this.threads.set(threadId, { ...current, ...patch });
  }

  async getTurns(threadId: ThreadId): Promise<TurnMeta[]> {
    return this.turns.get(threadId) ?? [];
  }

  async saveTurn(turn: TurnMeta): Promise<void> {
    const list = this.turns.get(turn.threadId) ?? [];
    list.push(turn);
    this.turns.set(turn.threadId, list);
  }

  async listMemoryRecords(): Promise<MemoryRecord[]> {
    return this.memories.filter((m) => m.status === 'active');
  }

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

  async searchEpisodeRecords(query: string, options?: {
    threadId?: string;
    lifecycle?: Array<EpisodeRecord['lifecycle']>;
    temperature?: Array<EpisodeRecord['temperature']>;
  }): Promise<EpisodeRecord[]> {
    const tokens = query.toLowerCase().split(/\s+/).filter((t) => t !== 'or' && t.length > 0);
    return this.episodes.filter((e) => {
      if (options?.threadId && e.sourceThreadId !== options.threadId) return false;
      if (options?.lifecycle && !options.lifecycle.includes(e.lifecycle)) return false;
      if (options?.temperature && !options.temperature.includes(e.temperature)) return false;
      const haystack = [e.title, e.objective, e.summary, ...e.artifacts, ...e.keywords].join(' ').toLowerCase();
      return tokens.some((token) => haystack.includes(token.replace(/"/g, '')));
    });
  }

  async recordEpisodeUsage(id: string): Promise<void> {
    const episode = this.episodes.find((e) => e.id === id);
    if (episode) episode.usageCount += 1;
  }

  async saveThreadWorkingSet(snapshot: ThreadWorkingSetSnapshot): Promise<void> {
    this.workingSets.set(snapshot.threadId, { ...snapshot });
  }

  async getThreadWorkingSet(threadId: ThreadId): Promise<ThreadWorkingSetSnapshot | null> {
    return this.workingSets.get(threadId) ?? null;
  }

  async deleteThreadWorkingSet(threadId: ThreadId): Promise<void> {
    this.workingSets.delete(threadId);
  }
}

function makeThread(threadId: ThreadId): ThreadMeta {
  return {
    threadId,
    title: 'Test thread',
    workspaceRoot: process.cwd(),
    status: 'active',
    turnCount: 1,
    createdAt: '2026-06-20T00:00:00.000Z',
    updatedAt: '2026-06-20T00:00:00.000Z',
    archivedAt: null,
    ephemeral: false,
    tags: {},
  };
}

describe('memory route', () => {
  it('GET returns working set when threadId is provided', async () => {
    const store = new FakeStore();
    store.threads.set('thread-a', makeThread('thread-a'));
    store.workingSets.set('thread-a', {
      threadId: 'thread-a',
      generation: 3,
      activeEpisodeIds: ['ep-a'],
      injectedEpisodeIds: ['ep-a'],
      frozenPromptBlock: 'block',
      builtFromTurnId: 'turn-0',
      builtFromTurnIndex: 0,
      taskFingerprint: 'fp',
      createdAt: '2026-06-20T00:00:00.000Z',
      updatedAt: '2026-06-20T00:00:00.000Z',
    });

    const { response } = await route('GET', '/api/memories?threadId=thread-a', undefined, store);
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      workingSet: expect.objectContaining({ threadId: 'thread-a', generation: 3 }),
    });
  });

  it('sets and reads episode memory mode on a thread', async () => {
    const store = new FakeStore();
    store.threads.set('thread-mode', makeThread('thread-mode'));

    const setResp = await route('POST', '/api/memories/mode', { threadId: 'thread-mode', mode: 'disabled' }, store);
    expect(setResp.response.status).toBe(200);

    const thread = store.threads.get('thread-mode');
    expect(thread?.tags.episodeMemoryMode).toBe('disabled');
  });

  it('rejects rebuild without force when thread memory is polluted', async () => {
    const store = new FakeStore();
    store.threads.set('thread-polluted', { ...makeThread('thread-polluted'), tags: { episodeMemoryMode: 'polluted' } });
    store.turns.set('thread-polluted', [
      {
        turnId: 'turn-0',
        threadId: 'thread-polluted',
        index: 0,
        userInput: { type: 'text', text: 'hello' } as UserInput,
        status: 'completed',
        startedAt: '2026-06-20T00:00:00.000Z',
        completedAt: '2026-06-20T00:00:00.000Z',
      },
    ]);

    const noForce = await route('POST', '/api/memories/rebuild-working-set', { threadId: 'thread-polluted' }, store);
    expect(noForce.response.status).toBe(400);

    const withForce = await route('POST', '/api/memories/rebuild-working-set', { threadId: 'thread-polluted', force: true }, store);
    expect(withForce.response.status).toBe(200);
    expect(withForce.response.body).toMatchObject({ snapshot: expect.objectContaining({ threadId: 'thread-polluted' }) });
  });

  it('activate-episode promotes the episode and rebuilds the working set', async () => {
    const store = new FakeStore();
    store.threads.set('thread-activate', makeThread('thread-activate'));
    const now = '2026-06-20T00:00:00.000Z';
    const episode: EpisodeRecord = {
      tenantId: 'default',
      id: 'ep-activate',
      workspaceRoot: process.cwd(),
      sourceThreadId: 'thread-activate',
      sourceTurnStart: 'turn-0',
      sourceTurnEnd: 'turn-0',
      sourceTurnStartIndex: 0,
      sourceTurnEndIndex: 0,
      lifecycle: 'sealed',
      temperature: 'cold',
      title: 'Auth service',
      objective: 'Authentication service',
      summary: 'JWT auth',
      facts: [],
      decisions: [],
      artifacts: [],
      openTasks: [],
      entities: [],
      keywords: [],
      boundaryReason: 'task_switch',
      fingerprint: 'fp',
      topicKey: 'topic',
      usageCount: 0,
      lastActivatedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    store.episodes.push(episode);

    const { response } = await route('POST', '/api/memories/activate-episode', { episodeId: 'ep-activate' }, store);
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      episodeId: 'ep-activate',
      snapshot: expect.objectContaining({
        threadId: 'thread-activate',
        activeEpisodeIds: ['ep-activate'],
        frozenPromptBlock: expect.stringContaining('JWT auth'),
      }),
    });
    expect(store.episodes[0].temperature).toBe('warm');
  });
});
