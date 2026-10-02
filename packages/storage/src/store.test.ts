import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from './index.js';
import type { ThreadMeta, TurnMeta } from '@suanlizi/protocol';

describe('LocalThreadStore settings', () => {
  it('persists arbitrary JSON settings by key', async () => {
    const { store } = createStore(mkdtempSync(join(tmpdir(), 'suanlizi-storage-')));

    await store.setSetting('runConfig.default', {
      provider: 'volcengine',
      model: 'doubao-seed-1.6',
    });

    await expect(store.getSetting('runConfig.default')).resolves.toEqual({
      provider: 'volcengine',
      model: 'doubao-seed-1.6',
    });
  });

  it('scopes tenant settings while preserving default tenant reads', async () => {
    const { store } = createStore(mkdtempSync(join(tmpdir(), 'suanlizi-storage-')));
    const tenantA = store.scope!('tenantA');
    const tenantB = store.scope!('tenantB');

    await tenantA.setSetting('runConfig.default', { model: 'a-model' });
    await tenantB.setSetting('runConfig.default', { model: 'b-model' });

    await expect(tenantA.getSetting('runConfig.default')).resolves.toEqual({ model: 'a-model' });
    await expect(tenantB.getSetting('runConfig.default')).resolves.toEqual({ model: 'b-model' });
    await expect(store.getSetting('runConfig.default')).resolves.toBeNull();
  });

  it('keeps auth token registry global across tenant scopes', async () => {
    const { store } = createStore(mkdtempSync(join(tmpdir(), 'suanlizi-storage-')));
    const tenantA = store.scope!('tenantA');

    await store.setSetting('auth.tokens.v1', { tokens: [{ id: 'token-a' }] });

    await expect(tenantA.getSetting('auth.tokens.v1')).resolves.toEqual({ tokens: [{ id: 'token-a' }] });
    await tenantA.setSetting('auth.tokens.v1', { tokens: [{ id: 'token-b' }] });
    await expect(store.getSetting('auth.tokens.v1')).resolves.toEqual({ tokens: [{ id: 'token-b' }] });
  });
});

describe('LocalThreadStore cold memories', () => {
  it('persists, searches, uses, deletes, and tenant-scopes memory records', async () => {
    const { store } = createStore(mkdtempSync(join(tmpdir(), 'suanlizi-storage-memory-')));
    const tenantA = store.scope!('tenantA');
    const tenantB = store.scope!('tenantB');
    const now = '2026-06-19T00:00:00.000Z';

    await tenantA.upsertMemoryRecord!({
      id: 'mem-a',
      type: 'preference',
      text: '用户偏好中文总结。',
      status: 'active',
      scope: 'global',
      sourceThreadId: 'thread-a',
      sourceTurnIds: ['turn-a'],
      workspaceRoot: 'E:/langchain/Suanlizi',
      tags: ['language'],
      confidence: 0.9,
      usageCount: 0,
      lastUsedAt: null,
      createdAt: now,
      updatedAt: now,
    });

    await expect(tenantA.searchMemoryRecords!('中文', { workspaceRoot: 'E:/langchain/Suanlizi' })).resolves.toEqual([
      expect.objectContaining({ id: 'mem-a', tenantId: 'tenantA' }),
    ]);
    await expect(tenantB.searchMemoryRecords!('中文')).resolves.toEqual([]);

    await tenantA.recordMemoryUsage!('mem-a', '2026-06-19T00:01:00.000Z');
    await expect(tenantA.listMemoryRecords!()).resolves.toEqual([
      expect.objectContaining({ usageCount: 1, lastUsedAt: '2026-06-19T00:01:00.000Z' }),
    ]);

    await tenantA.deleteMemoryRecord!('mem-a');
    await expect(tenantA.listMemoryRecords!()).resolves.toEqual([]);
  });
});

describe('LocalThreadStore episode memories', () => {
  it('persists, searches, uses, and tenant-scopes episode records', async () => {
    const { store } = createStore(mkdtempSync(join(tmpdir(), 'suanlizi-storage-episode-')));
    const tenantA = store.scope!('tenantA');
    const tenantB = store.scope!('tenantB');
    const now = '2026-06-20T00:00:00.000Z';

    await tenantA.upsertEpisodeRecord!({
      id: 'ep-a',
      workspaceRoot: 'E:/langchain/Suanlizi',
      sourceThreadId: 'thread-a',
      sourceTurnStart: 'turn-0',
      sourceTurnEnd: 'turn-0',
      sourceTurnStartIndex: 0,
      sourceTurnEndIndex: 0,
      lifecycle: 'sealed',
      temperature: 'warm',
      title: 'Auth service',
      objective: 'Build authentication',
      summary: 'JWT auth implemented',
      facts: [],
      decisions: [],
      artifacts: [],
      openTasks: [],
      entities: [],
      keywords: ['auth', 'jwt'],
      boundaryReason: 'task_switch',
      fingerprint: 'fp-a',
      topicKey: 'topic-a',
      usageCount: 0,
      lastActivatedAt: null,
      createdAt: now,
      updatedAt: now,
    });

    await expect(tenantA.searchEpisodeRecords!('auth', { workspaceRoot: 'E:/langchain/Suanlizi' })).resolves.toEqual([
      expect.objectContaining({ id: 'ep-a', tenantId: 'tenantA' }),
    ]);
    await expect(tenantB.searchEpisodeRecords!('auth')).resolves.toEqual([]);

    await tenantA.recordEpisodeUsage!('ep-a', '2026-06-20T00:01:00.000Z');
    await expect(tenantA.listEpisodeRecords!()).resolves.toEqual([
      expect.objectContaining({ usageCount: 1, lastActivatedAt: '2026-06-20T00:01:00.000Z' }),
    ]);
  });

  it('saves and retrieves a thread working set snapshot', async () => {
    const { store } = createStore(mkdtempSync(join(tmpdir(), 'suanlizi-storage-ws-')));
    const now = '2026-06-20T00:00:00.000Z';

    await store.saveThreadWorkingSet!({
      threadId: 'thread-a',
      generation: 1,
      activeEpisodeIds: ['ep-a'],
      injectedEpisodeIds: ['ep-a'],
      frozenPromptBlock: 'episode block',
      builtFromTurnId: 'turn-0',
      builtFromTurnIndex: 0,
      taskFingerprint: 'fp',
      createdAt: now,
      updatedAt: now,
    });

    const loaded = await store.getThreadWorkingSet!('thread-a');
    expect(loaded).toEqual(expect.objectContaining({ threadId: 'thread-a', generation: 1, frozenPromptBlock: 'episode block' }));
  });
});

describe('LocalThreadStore threads', () => {
  it('persists tenant-scoped run records, events, progress, and feedback', async () => {
    const { store } = createStore(mkdtempSync(join(tmpdir(), 'suanlizi-storage-')));
    const tenantA = store.scope!('tenantA');
    const tenantB = store.scope!('tenantB');
    const now = '2026-06-16T00:00:00.000Z';

    await tenantA.createRunRecord!({
      runId: 'run-a',
      tenantId: 'client-ignored',
      threadId: 'thread-a',
      turnId: 'turn-a',
      kind: 'turn',
      status: 'running',
      title: 'Run A',
      caller: 'lead_agent',
      activeStep: 'model',
      inputTokens: 1,
      cachedInputTokens: 0,
      outputTokens: 2,
      reasoningOutputTokens: 0,
      toolCallCount: 1,
      modelCallCount: 1,
      subagentCount: 0,
      middlewareEventCount: 1,
      startedAt: now,
      updatedAt: now,
    });
    await tenantA.appendRunEvent!({
      eventId: 'event-a',
      runId: 'run-a',
      tenantId: 'client-ignored',
      threadId: 'thread-a',
      turnId: 'turn-a',
      sequence: 1,
      category: 'model',
      type: 'model.started',
      level: 'info',
      message: 'model started',
      metadata: { provider: 'test' },
      createdAt: now,
    });
    await tenantA.updateRunRecord!('run-a', {
      status: 'completed',
      activeStep: 'done',
      completedAt: '2026-06-16T00:00:01.000Z',
      outputTokens: 3,
    });
    await tenantA.upsertRunFeedback!({
      feedbackId: 'feedback-a',
      runId: 'run-a',
      tenantId: 'client-ignored',
      threadId: 'thread-a',
      rating: 1,
      comment: 'useful',
      createdAt: now,
      updatedAt: now,
    });

    await expect(tenantA.listRunRecords!({ threadId: 'thread-a' })).resolves.toEqual([
      expect.objectContaining({
        runId: 'run-a',
        tenantId: 'tenantA',
        status: 'completed',
        activeStep: 'done',
        outputTokens: 3,
      }),
    ]);
    await expect(tenantA.listRunEvents!('run-a')).resolves.toEqual([
      expect.objectContaining({
        eventId: 'event-a',
        tenantId: 'tenantA',
        category: 'model',
        metadata: { provider: 'test' },
      }),
    ]);
    await expect(tenantA.listRunFeedback!('run-a')).resolves.toEqual([
      expect.objectContaining({
        feedbackId: 'feedback-a',
        tenantId: 'tenantA',
        comment: 'useful',
      }),
    ]);
    await expect(tenantB.listRunRecords!()).resolves.toEqual([]);
    await expect(tenantB.listRunEvents!('run-a')).resolves.toEqual([]);
  });

  it('persists thread spawn edges and lists children by open/closed status', async () => {
    const { store } = createStore(mkdtempSync(join(tmpdir(), 'suanlizi-storage-')));
    const now = new Date().toISOString();
    const parent: ThreadMeta = {
      threadId: 'thread-parent',
      title: 'Parent',
      workspaceRoot: process.cwd(),
      status: 'active',
      turnCount: 0,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      ephemeral: false,
      tags: {},
    };
    const child: ThreadMeta = {
      ...parent,
      threadId: 'thread-child',
      title: 'Child',
      parentThreadId: parent.threadId,
      agentNickname: 'worker',
      agentRole: 'reviewer',
    };

    await store.createThread(parent);
    await store.createThread(child);
    await store.upsertThreadSpawnEdge({
      parentThreadId: parent.threadId,
      childThreadId: child.threadId,
      status: 'open',
      createdAt: now,
      updatedAt: now,
    });

    await expect(store.listThreadSpawnChildren(parent.threadId)).resolves.toEqual([
      expect.objectContaining({
        parentThreadId: parent.threadId,
        childThreadId: child.threadId,
        status: 'open',
      }),
    ]);

    await store.setThreadSpawnEdgeStatus(parent.threadId, child.threadId, 'closed');

    await expect(store.listThreadSpawnChildren(parent.threadId, 'open')).resolves.toEqual([]);
    await expect(store.listThreadSpawnChildren(parent.threadId, 'closed')).resolves.toEqual([
      expect.objectContaining({
        childThreadId: child.threadId,
        status: 'closed',
      }),
    ]);
  });

  it('isolates threads and spawn edges by tenant scope', async () => {
    const { store } = createStore(mkdtempSync(join(tmpdir(), 'suanlizi-storage-')));
    const tenantA = store.scope!('tenantA');
    const tenantB = store.scope!('tenantB');
    const now = new Date().toISOString();
    const base: ThreadMeta = {
      threadId: 'thread-shared-title-a',
      title: 'Same visible title',
      workspaceRoot: process.cwd(),
      status: 'active',
      turnCount: 0,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      ephemeral: false,
      tags: {},
    };
    const threadA = { ...base, threadId: 'thread-tenant-a' };
    const childA = { ...base, threadId: 'thread-tenant-a-child', parentThreadId: threadA.threadId };
    const threadB = { ...base, threadId: 'thread-tenant-b' };

    await tenantA.createThread(threadA);
    await tenantA.createThread(childA);
    await tenantA.upsertThreadSpawnEdge({
      tenantId: 'ignored-client-value',
      parentThreadId: threadA.threadId,
      childThreadId: childA.threadId,
      status: 'open',
      createdAt: now,
      updatedAt: now,
    });
    await tenantB.createThread(threadB);

    await expect(tenantA.listThreads()).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ threadId: threadA.threadId, tenantId: 'tenantA' }),
      expect.objectContaining({ threadId: childA.threadId, tenantId: 'tenantA' }),
    ]));
    await expect(tenantB.listThreads()).resolves.toEqual([
      expect.objectContaining({ threadId: threadB.threadId, tenantId: 'tenantB' }),
    ]);
    await expect(tenantA.getThread(threadB.threadId)).resolves.toBeNull();
    await expect(tenantB.getThread(threadA.threadId)).resolves.toBeNull();
    await expect(tenantA.listThreadSpawnChildren(threadA.threadId, 'open')).resolves.toEqual([
      expect.objectContaining({ childThreadId: childA.threadId, tenantId: 'tenantA' }),
    ]);
    await expect(tenantB.listThreadSpawnChildren(threadA.threadId, 'open')).resolves.toEqual([]);
  });

  it('uses tenant rollout paths and reads legacy default rollouts compatibly', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'suanlizi-storage-'));
    const { store } = createStore(dataDir);
    const tenantA = store.scope!('tenantA');

    await tenantA.appendItems('thread-rollout-tenant', [
      { id: 'item-a', type: 'agent_message', turnId: 'turn-a', text: 'tenant item' },
    ]);

    expect(existsSync(join(dataDir, 'tenants', 'tenantA', 'rollouts', 'thread-rollout-tenant.jsonl'))).toBe(true);
    expect(existsSync(join(dataDir, 'rollouts', 'thread-rollout-tenant.jsonl'))).toBe(false);
    await expect(tenantA.getItems('thread-rollout-tenant')).resolves.toEqual([
      expect.objectContaining({ id: 'item-a' }),
    ]);
    await expect(store.getItems('thread-rollout-tenant')).resolves.toEqual([]);

    mkdirSync(join(dataDir, 'rollouts'), { recursive: true });
    writeFileSync(
      join(dataDir, 'rollouts', 'thread-legacy-default.jsonl'),
      `${JSON.stringify({ id: 'legacy-item', type: 'agent_message', turnId: 'turn-legacy', text: 'legacy' })}
`,
      'utf-8',
    );
    await expect(store.getItems('thread-legacy-default')).resolves.toEqual([
      expect.objectContaining({ id: 'legacy-item' }),
    ]);
  });

  it('recovers missing thread and turn metadata from rollout JSONL', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'suanlizi-storage-'));
    const threadId = 'thread-recover-test';
    const turnId = 'turn-recover-test';
    const now = '2026-06-08T10:00:00.000Z';

    mkdirSync(join(dataDir, 'rollouts'), { recursive: true });
    writeFileSync(
      join(dataDir, 'rollouts', `${threadId}.jsonl`),
      [
        JSON.stringify({
          type: '__checkpoint__',
          threadId,
          turnId,
          itemIndex: 0,
          timestamp: now,
        }),
        JSON.stringify({
          id: `${turnId}_item_0`,
          type: 'user_message',
          turnId,
          text: '恢复这个旧会话',
        }),
        JSON.stringify({
          id: `${turnId}_item_1`,
          type: 'agent_message',
          turnId,
          text: '已恢复。',
        }),
        '',
      ].join('\n'),
      'utf-8',
    );

    const { store } = createStore(dataDir);

    await expect(store.listThreads()).resolves.toMatchObject([
      {
        threadId,
        title: '恢复这个旧会话',
        status: 'active',
        turnCount: 1,
      },
    ]);
    await expect(store.getTurns(threadId)).resolves.toMatchObject([
      {
        turnId,
        threadId,
        index: 0,
        userInput: { type: 'text', text: '恢复这个旧会话' },
        status: 'completed',
      },
    ]);
    await expect(store.getItems(threadId)).resolves.toHaveLength(2);
  });

  it('deletes thread metadata, turns, and rollout items', async () => {
    const { store } = createStore(mkdtempSync(join(tmpdir(), 'suanlizi-storage-')));
    const now = new Date().toISOString();
    const thread: ThreadMeta = {
      threadId: 'thread-delete-test',
      title: 'Delete me',
      workspaceRoot: process.cwd(),
      status: 'active',
      turnCount: 1,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      ephemeral: false,
      tags: {},
    };
    const turn: TurnMeta = {
      turnId: 'turn-delete-test',
      threadId: thread.threadId,
      index: 0,
      userInput: { type: 'text', text: 'hello' },
      status: 'completed',
      startedAt: now,
      completedAt: now,
    };

    await store.createThread(thread);
    await store.saveTurn(turn);
    await store.appendItems(thread.threadId, [
      {
        id: 'item-delete-test',
        type: 'agent_message',
        turnId: turn.turnId,
        text: 'ok',
      },
    ]);

    await store.deleteThread(thread.threadId);

    await expect(store.getThread(thread.threadId)).resolves.toBeNull();
    await expect(store.getTurns(thread.threadId)).resolves.toEqual([]);
    await expect(store.getItems(thread.threadId)).resolves.toEqual([]);
  });

  it('filters turns and rollout items to the active checkpoint turn count', async () => {
    const { store } = createStore(mkdtempSync(join(tmpdir(), 'suanlizi-storage-')));
    const now = new Date().toISOString();
    const thread: ThreadMeta = {
      threadId: 'thread-active-turns',
      title: 'Active turns',
      workspaceRoot: process.cwd(),
      status: 'active',
      turnCount: 1,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      ephemeral: false,
      tags: {},
    };
    await store.createThread(thread);
    await store.saveTurn({ turnId: 'turn-0', threadId: thread.threadId, index: 0, userInput: { type: 'text', text: 'first' }, status: 'completed', startedAt: now, completedAt: now });
    await store.saveTurn({ turnId: 'turn-1', threadId: thread.threadId, index: 1, userInput: { type: 'text', text: 'future' }, status: 'completed', startedAt: now, completedAt: now });
    await store.appendItems(thread.threadId, [
      { id: 'item-active', type: 'agent_message', turnId: 'turn-0', text: 'visible' },
      { id: 'item-future', type: 'agent_message', turnId: 'turn-1', text: 'hidden' },
      { id: 'workflow-current', type: 'workflow_checkpoint', turnId: 'turn-0', turnCount: 1, workflow: { definition: { goal: 'visible' } } },
      { id: 'workflow-future', type: 'workflow_checkpoint', turnId: 'turn-1', turnCount: 2, workflow: { definition: { goal: 'hidden' } } },
    ]);

    await expect(store.getTurns(thread.threadId)).resolves.toEqual([
      expect.objectContaining({ turnId: 'turn-0' }),
    ]);
    await expect(store.getItems(thread.threadId)).resolves.toEqual([
      expect.objectContaining({ id: 'item-active' }),
      expect.objectContaining({ id: 'workflow-current' }),
    ]);
  });

  it('persists rollback markers without exposing them as thread items', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'suanlizi-storage-'));
    const { store } = createStore(dataDir);
    const threadId = 'thread-rollback-marker';

    await store.appendItems(threadId, [
      { id: 'visible-item', type: 'agent_message', turnId: 'turn-0', text: 'visible' },
    ]);
    await store.appendRollbackMarker!(threadId, { count: 2, remainingTurnCount: 1 });

    const rollout = readFileSync(join(dataDir, 'tenants', 'default', 'rollouts', `${threadId}.jsonl`), 'utf-8');
    expect(rollout).toContain('__rollback__');
    await expect(store.getItems(threadId)).resolves.toEqual([
      expect.objectContaining({ id: 'visible-item' }),
    ]);
  });

  it('prunes stale turns so new turns do not resurrect history', async () => {
    const { store } = createStore(mkdtempSync(join(tmpdir(), 'suanlizi-storage-rollback-')));
    const now = '2026-07-19T00:00:00.000Z';
    const thread: ThreadMeta = {
      threadId: 'thread-rollback-reuse',
      title: 'Rollback reuse',
      workspaceRoot: process.cwd(),
      status: 'active',
      turnCount: 3,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      ephemeral: false,
      tags: {},
    };
    await store.createThread(thread);

    const turns: TurnMeta[] = [
      { turnId: 'turn-0', threadId: thread.threadId, index: 0, userInput: { type: 'text', text: 'first' }, status: 'completed', startedAt: now, completedAt: now },
      { turnId: 'turn-1', threadId: thread.threadId, index: 1, userInput: { type: 'text', text: 'second' }, status: 'completed', startedAt: now, completedAt: now },
      { turnId: 'turn-2', threadId: thread.threadId, index: 2, userInput: { type: 'text', text: 'stale third' }, status: 'completed', startedAt: now, completedAt: now },
    ];
    for (const turn of turns) {
      await store.saveTurn(turn);
    }
    await store.appendItems(thread.threadId, [
      { id: 'turn-0-user', type: 'user_message', turnId: 'turn-0', text: 'first' },
      { id: 'turn-0-agent', type: 'agent_message', turnId: 'turn-0', text: 'reply 0' },
      { id: 'turn-1-user', type: 'user_message', turnId: 'turn-1', text: 'second' },
      { id: 'turn-1-agent', type: 'agent_message', turnId: 'turn-1', text: 'reply 1' },
      { id: 'turn-2-user', type: 'user_message', turnId: 'turn-2', text: 'stale third' },
      { id: 'turn-2-agent', type: 'agent_message', turnId: 'turn-2', text: 'reply 2' },
    ]);

    await store.deleteTurnsAfter!(thread.threadId, 2);
    await store.saveTurn({
      turnId: 'turn-2-new',
      threadId: thread.threadId,
      index: 2,
      userInput: { type: 'text', text: 'new third' },
      status: 'completed',
      startedAt: now,
      completedAt: now,
    });
    await store.appendItems(thread.threadId, [
      { id: 'turn-2-new-user', type: 'user_message', turnId: 'turn-2-new', text: 'new third' },
      { id: 'turn-2-new-agent', type: 'agent_message', turnId: 'turn-2-new', text: 'reply new' },
    ]);

    await expect(store.getTurns(thread.threadId)).resolves.toEqual([
      expect.objectContaining({ turnId: 'turn-0', index: 0 }),
      expect.objectContaining({ turnId: 'turn-1', index: 1 }),
      expect.objectContaining({ turnId: 'turn-2-new', index: 2 }),
    ]);
    await expect(store.getItems(thread.threadId)).resolves.toEqual([
      expect.objectContaining({ id: 'turn-0-user', turnId: 'turn-0' }),
      expect.objectContaining({ id: 'turn-0-agent', turnId: 'turn-0' }),
      expect.objectContaining({ id: 'turn-1-user', turnId: 'turn-1' }),
      expect.objectContaining({ id: 'turn-1-agent', turnId: 'turn-1' }),
      expect.objectContaining({ id: 'turn-2-new-user', turnId: 'turn-2-new' }),
      expect.objectContaining({ id: 'turn-2-new-agent', turnId: 'turn-2-new' }),
    ]);
  });

  it('records schema migrations so future upgrades are explicit', async () => {
    const { store } = createStore(mkdtempSync(join(tmpdir(), 'suanlizi-storage-')));

    await expect(store.getSetting('storage.schemaVersion')).resolves.toEqual({
      version: 6,
    });
  });

  it('isolates thread working sets by tenant scope', async () => {
    const { store } = createStore(mkdtempSync(join(tmpdir(), 'suanlizi-storage-ws-tenant-')));
    const tenantA = store.scope!('tenantA');
    const tenantB = store.scope!('tenantB');
    const now = '2026-06-20T00:00:00.000Z';

    await tenantA.saveThreadWorkingSet!({
      threadId: 'thread-shared',
      generation: 1,
      activeEpisodeIds: ['ep-a'],
      injectedEpisodeIds: ['ep-a'],
      frozenPromptBlock: 'tenant-a-block',
      builtFromTurnId: 'turn-0',
      builtFromTurnIndex: 0,
      taskFingerprint: 'fp-a',
      createdAt: now,
      updatedAt: now,
    });

    await tenantB.saveThreadWorkingSet!({
      threadId: 'thread-shared',
      generation: 2,
      activeEpisodeIds: ['ep-b'],
      injectedEpisodeIds: ['ep-b'],
      frozenPromptBlock: 'tenant-b-block',
      builtFromTurnId: 'turn-0',
      builtFromTurnIndex: 0,
      taskFingerprint: 'fp-b',
      createdAt: now,
      updatedAt: now,
    });

    const loadedA = await tenantA.getThreadWorkingSet!('thread-shared');
    const loadedB = await tenantB.getThreadWorkingSet!('thread-shared');
    expect(loadedA?.frozenPromptBlock).toBe('tenant-a-block');
    expect(loadedB?.frozenPromptBlock).toBe('tenant-b-block');

    await tenantA.deleteThreadWorkingSet!('thread-shared');
    await expect(tenantA.getThreadWorkingSet!('thread-shared')).resolves.toBeNull();
    await expect(tenantB.getThreadWorkingSet!('thread-shared')).resolves.not.toBeNull();
  });

  it('searches episodes with paths and colons without FTS syntax errors', async () => {
    const { store } = createStore(mkdtempSync(join(tmpdir(), 'suanlizi-storage-fts-')));
    const now = '2026-06-20T00:00:00.000Z';

    await store.upsertEpisodeRecord!({
      id: 'ep-path',
      workspaceRoot: 'E:/langchain/Suanlizi',
      sourceThreadId: 'thread-fts',
      sourceTurnStart: 'turn-0',
      sourceTurnEnd: 'turn-0',
      sourceTurnStartIndex: 0,
      sourceTurnEndIndex: 0,
      lifecycle: 'sealed',
      temperature: 'warm',
      title: 'Path episode',
      objective: 'Fix src/foo.ts',
      summary: 'Worked on E:/langchain/Suanlizi/src/foo.ts and src/bar.ts',
      facts: [],
      decisions: [],
      artifacts: ['src/foo.ts'],
      openTasks: [],
      entities: [],
      keywords: ['foo'],
      boundaryReason: 'task_switch',
      fingerprint: 'fp-path',
      topicKey: 'topic-path',
      usageCount: 0,
      lastActivatedAt: null,
      createdAt: now,
      updatedAt: now,
    });

    await expect(store.searchEpisodeRecords!('E:/langchain/Suanlizi/src/foo.ts')).resolves.toEqual([
      expect.objectContaining({ id: 'ep-path' }),
    ]);
    await expect(store.searchEpisodeRecords!('src/foo.ts')).resolves.toEqual([
      expect.objectContaining({ id: 'ep-path' }),
    ]);
    await expect(store.searchEpisodeRecords!('a:b')).resolves.toEqual([]);
  });

  it('compacts rollout JSONL before the latest checkpoint item index', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'suanlizi-storage-'));
    const { store } = createStore(dataDir);
    const threadId = 'thread-rollout-compact';
    const now = new Date().toISOString();
    await store.appendItems(threadId, [
      { id: 'old-user', type: 'user_message', turnId: 'turn-old', text: 'old' },
      { id: 'old-agent', type: 'agent_message', turnId: 'turn-old', text: 'old reply' },
    ]);
    await store.appendCheckpoint(threadId, {
      threadId,
      turnId: 'turn-new',
      generation: 1,
      itemIndex: 2,
      status: 'completed',
      timestamp: now,
    });
    await store.appendItems(threadId, [
      { id: 'new-user', type: 'user_message', turnId: 'turn-new', text: 'new' },
      { id: 'new-agent', type: 'agent_message', turnId: 'turn-new', text: 'new reply' },
    ]);

    const result = await store.compactRollout!(threadId);

    expect(result.removedItems).toBe(2);
    await expect(store.getItems(threadId)).resolves.toEqual([
      expect.objectContaining({ id: 'new-user' }),
      expect.objectContaining({ id: 'new-agent' }),
    ]);
    expect(readFileSync(join(dataDir, 'tenants', 'default', 'rollouts', `${threadId}.jsonl`), 'utf-8')).toContain('__checkpoint__');
  });
}, 15_000);
