import { describe, expect, it } from 'vitest';
import type { ThreadItem, ThreadMeta, ThreadRuntimeState, ThreadSpawnEdge, TurnMeta } from '@suanlizi/protocol';
import type { ThreadStore } from '@suanlizi/storage';
import { buildThreadChildInfos } from './threadChildren.js';

class ChildStore implements ThreadStore {
  threads = new Map<string, ThreadMeta>();
  edges: ThreadSpawnEdge[] = [];
  turns = new Map<string, TurnMeta[]>();
  items = new Map<string, ThreadItem[]>();

  async appendItems(threadId: string, items: ThreadItem[]): Promise<void> {
    this.items.set(threadId, [...(this.items.get(threadId) ?? []), ...items]);
  }

  async updateThreadMetadata(): Promise<void> {}

  async createThread(meta: ThreadMeta): Promise<void> {
    this.threads.set(meta.threadId, meta);
  }

  async getThread(threadId: string): Promise<ThreadMeta | null> {
    return this.threads.get(threadId) ?? null;
  }

  async listThreads(): Promise<ThreadMeta[]> {
    return [...this.threads.values()];
  }

  async deleteThread(): Promise<void> {}

  async getItems(threadId: string): Promise<ThreadItem[]> {
    return this.items.get(threadId) ?? [];
  }

  async getTurns(threadId: string): Promise<TurnMeta[]> {
    return this.turns.get(threadId) ?? [];
  }

  async saveTurn(turn: TurnMeta): Promise<void> {
    this.turns.set(turn.threadId, [...(this.turns.get(turn.threadId) ?? []), turn]);
  }

  async getRecentItems(threadId: string): Promise<ThreadItem[]> {
    return this.items.get(threadId) ?? [];
  }

  async getLastCheckpoint(): Promise<null> {
    return null;
  }

  async appendCheckpoint(): Promise<void> {}

  async getSetting<T = unknown>(): Promise<T | null> {
    return null;
  }

  async setSetting(): Promise<void> {}

  async upsertThreadSpawnEdge(edge: ThreadSpawnEdge): Promise<void> {
    this.edges.push(edge);
  }

  async setThreadSpawnEdgeStatus(): Promise<void> {}

  async listThreadSpawnChildren(parentThreadId: string): Promise<ThreadSpawnEdge[]> {
    return this.edges.filter((edge) => edge.parentThreadId === parentThreadId);
  }

  async listThreadSpawnDescendants(parentThreadId: string): Promise<ThreadSpawnEdge[]> {
    const result: ThreadSpawnEdge[] = [];
    const visit = (id: string) => {
      for (const edge of this.edges.filter((candidate) => candidate.parentThreadId === id)) {
        result.push(edge);
        visit(edge.childThreadId);
      }
    };
    visit(parentThreadId);
    return result;
  }

  async createRunRecord(): Promise<void> {}
  async updateRunRecord(): Promise<void> {}
  async appendRunEvent(): Promise<void> {}
  async listRunRecords(): Promise<never[]> { return []; }
  async listRunEvents(): Promise<never[]> { return []; }
  async upsertRunFeedback(): Promise<void> {}
  async listRunFeedback(): Promise<never[]> { return []; }
}

function thread(threadId: string, parentThreadId?: string): ThreadMeta {
  return {
    threadId,
    title: threadId,
    workspaceRoot: process.cwd(),
    status: 'active',
    turnCount: 1,
    createdAt: '2026-06-10T00:00:00.000Z',
    updatedAt: '2026-06-10T00:01:00.000Z',
    archivedAt: null,
    ephemeral: false,
    tags: {},
    parentThreadId,
    agentNickname: parentThreadId ? 'worker' : undefined,
    agentRole: parentThreadId ? 'reviewer' : undefined,
  };
}

describe('buildThreadChildInfos', () => {
  it('returns recursive child thread state, latest turn, and latest collaboration item', async () => {
    const store = new ChildStore();
    await store.createThread(thread('parent'));
    await store.createThread(thread('child', 'parent'));
    await store.createThread(thread('grandchild', 'child'));
    await store.upsertThreadSpawnEdge({
      parentThreadId: 'parent',
      childThreadId: 'child',
      status: 'open',
      createdAt: '2026-06-10T00:00:00.000Z',
      updatedAt: '2026-06-10T00:01:00.000Z',
    });
    await store.upsertThreadSpawnEdge({
      parentThreadId: 'child',
      childThreadId: 'grandchild',
      status: 'closed',
      createdAt: '2026-06-10T00:01:00.000Z',
      updatedAt: '2026-06-10T00:02:00.000Z',
    });
    await store.saveTurn({
      turnId: 'old',
      threadId: 'child',
      index: 0,
      userInput: { type: 'text', text: 'old' },
      status: 'completed',
      startedAt: '2026-06-10T00:00:00.000Z',
      completedAt: '2026-06-10T00:00:30.000Z',
    });
    await store.saveTurn({
      turnId: 'latest',
      threadId: 'child',
      index: 1,
      userInput: { type: 'text', text: 'latest' },
      status: 'running',
      startedAt: '2026-06-10T00:01:00.000Z',
      completedAt: null,
    });
    await store.appendItems('parent', [
      {
        id: 'collab-old',
        type: 'collab_tool_call',
        turnId: 'turn-parent',
        tool: 'spawn_agent',
        status: 'completed',
        senderThreadId: 'parent',
        receiverThreadId: 'child',
        agentStatus: 'running',
        timestamp: '2026-06-10T00:00:01.000Z',
      },
    ]);
    await store.appendItems('child', [
      {
        id: 'child-tool',
        type: 'tool_call',
        turnId: 'latest',
        toolName: 'read_file',
        arguments: { path: 'package.json' },
        status: 'completed',
        timestamp: '2026-06-10T00:01:10.000Z',
      },
      {
        id: 'child-answer',
        type: 'agent_message',
        turnId: 'latest',
        text: '检查完成',
        timestamp: '2026-06-10T00:01:20.000Z',
      },
    ]);

    const rows = await buildThreadChildInfos({
      parentThreadId: 'parent',
      recursive: true,
      store,
      getRuntimeState: async (threadId): Promise<ThreadRuntimeState> => ({
        threadId,
        status: threadId === 'child' ? 'running' : 'idle',
        checkpoint: null,
        resumable: false,
        stale: false,
      }),
    });

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      thread: { threadId: 'child' },
      edge: { status: 'open' },
      state: { status: 'running' },
      latestTurn: { turnId: 'latest', status: 'running' },
      latestCollabItem: { id: 'collab-old', tool: 'spawn_agent' },
      items: [
        { id: 'child-tool', type: 'tool_call' },
        { id: 'child-answer', type: 'agent_message' },
      ],
    });
    expect(rows[1]).toMatchObject({
      thread: { threadId: 'grandchild' },
      edge: { status: 'closed' },
      latestTurn: null,
      latestCollabItem: null,
    });
  });
});
