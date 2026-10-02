// GET /api/threads/:id/state 僵尸运行态回归测试。
// 症状：聊天在“进行中/停止中”卡住，重启也治不好。
// 根因：强杀进程会留下 running/stopping checkpoint，/state 用内存 idle + checkpoint 回推成活动态。
// 本文件锁定两条不变量：
//   1) 没有本进程运行句柄时，running/stopping 一律按终止态返回并顺手收敛；
//   2) waiting_user_input 是合法等待点，绝不能被当成僵尸清掉（否则冷启动无法续跑）。
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import type { Checkpoint, ThreadId, ThreadMeta } from '@suanlizi/protocol';
import type { ThreadStore } from '@suanlizi/storage';
import { handleThreadRoutes, type ThreadRouteContext } from './threadRoutes.js';

function thread(threadId: string): ThreadMeta {
  return {
    threadId,
    title: '僵尸态',
    workspaceRoot: process.cwd(),
    status: 'active',
    turnCount: 1,
    createdAt: '2026-09-22T00:00:00.000Z',
    updatedAt: '2026-09-22T00:00:00.000Z',
    archivedAt: null,
    ephemeral: false,
    tags: {},
  };
}

function request(): IncomingMessage {
  return Object.assign(Readable.from([]), {
    method: 'GET',
    url: '/api/threads/thread-zombie/state',
    headers: {},
  }) as IncomingMessage;
}

function response(): ServerResponse & { status?: number; body?: unknown } {
  const output = {
    writeHead(status: number) { output.status = status; return output; },
    end(raw: string) { output.body = raw ? JSON.parse(raw) : undefined; },
  } as unknown as ServerResponse & { status?: number; body?: unknown };
  return output;
}

/** 构造只实现 /state 路径所需能力的 store。 */
function makeStore(lastCheckpoint: Checkpoint | null) {
  const meta = thread('thread-zombie');
  const appended: Checkpoint[] = [];
  const store = {
    getThread: vi.fn(async (_id: ThreadId) => meta),
    getLastCheckpoint: vi.fn(async (_id: ThreadId) => lastCheckpoint),
    appendCheckpoint: vi.fn(async (_id: ThreadId, ckpt: Checkpoint) => { appended.push(ckpt); }),
  } as unknown as ThreadStore;
  return { store, appended };
}

/** 运行时状态由注入的 agent 提供，测试直接控制它声称的 status。 */
function makeContext(store: ThreadStore, state: Record<string, unknown>, registry: unknown): ThreadRouteContext {
  const agent = { getRuntimeState: vi.fn(async () => state) };
  return {
    store,
    tenantContext: { tenantId: 'default' },
    createTenantAgent: vi.fn() as never,
    getTenantDefaultAgent: vi.fn(async () => agent) as never,
    publishTenantEvent: vi.fn(),
    getThreadRunConfig: vi.fn() as never,
    saveThreadRunConfig: vi.fn() as never,
    getThreadConfigOverrides: vi.fn() as never,
    updateThreadConfigOverrides: vi.fn() as never,
    getThreadAccessPolicy: vi.fn() as never,
    saveThreadAccessPolicy: vi.fn() as never,
    publicThreadRunConfig: vi.fn() as never,
    closeThreadEventClients: vi.fn(),
    activeRunRegistry: registry as never,
  };
}

async function callState(ctx: ThreadRouteContext) {
  const res = response();
  const url = new URL('http://localhost/api/threads/thread-zombie/state');
  const handled = await handleThreadRoutes(request(), res, url, ['api', 'threads', 'thread-zombie', 'state'], ctx);
  return { handled, res };
}

describe('GET /api/threads/:id/state 僵尸运行态', () => {
  it('把无运行句柄的 running checkpoint 收敛成终止态，避免一直“进行中”', async () => {
    const checkpoint = {
      threadId: 'thread-zombie', turnId: 'turn-1', itemIndex: 3, timestamp: '2026-09-22T00:00:00.000Z',
      status: 'running', executionStatus: 'running',
    } as Checkpoint;
    const { store, appended } = makeStore(checkpoint);
    const ctx = makeContext(store, { threadId: 'thread-zombie', status: 'running', executionStatus: 'running', stale: false, resumable: false, checkpoint }, null);
    const { handled, res } = await callState(ctx);
    expect(handled).toBe(true);
    const state = (res.body as { state: Record<string, unknown> }).state;
    expect(state.status).toBe('terminal');
    expect(state.executionStatus).toBe('terminal');
    expect(state.resumable).toBe(false);
    expect(appended).toHaveLength(1);
    expect(appended[0]).toMatchObject({ status: 'interrupted', executionStatus: 'terminal' });
  });

  it('同样收敛 stopping 僵尸态，避免一直“停止中”', async () => {
    const checkpoint = {
      threadId: 'thread-zombie', turnId: 'turn-1', itemIndex: 3, timestamp: '2026-09-22T05:28:57.983Z',
      status: 'stopping', executionStatus: 'stopping', expiresAt: '2026-09-22T05:55:19.154Z',
    } as Checkpoint;
    const { store, appended } = makeStore(checkpoint);
    const ctx = makeContext(store, { threadId: 'thread-zombie', status: 'stopping', executionStatus: 'stopping', stale: false, resumable: false, checkpoint }, null);
    const { res } = await callState(ctx);
    const state = (res.body as { state: Record<string, unknown> }).state;
    expect(state.executionStatus).toBe('terminal');
    expect(appended[0]).toMatchObject({ status: 'interrupted' });
  });

  it('保留 waiting_user_input：冷启动后仍可由 decision 接口续跑', async () => {
    const checkpoint = {
      threadId: 'thread-zombie', turnId: 'turn-1', itemIndex: 1, timestamp: '2026-09-22T00:00:00.000Z',
      status: 'waiting_user_input', executionStatus: 'waiting_user_input',
    } as Checkpoint;
    const { store, appended } = makeStore(checkpoint);
    const state = { threadId: 'thread-zombie', status: 'waiting_user_input', executionStatus: 'waiting_user_input', stale: false, resumable: true, checkpoint };
    const ctx = makeContext(store, state, null);
    const { res } = await callState(ctx);
    const body = (res.body as { state: Record<string, unknown> }).state;
    expect(body.status).toBe('waiting_user_input');
    expect(body.executionStatus).toBe('waiting_user_input');
    expect(appended).toHaveLength(0);
  });

  it('本进程仍有运行句柄时不改写状态', async () => {
    const checkpoint = {
      threadId: 'thread-zombie', turnId: 'turn-1', itemIndex: 3, timestamp: '2026-09-22T00:00:00.000Z',
      status: 'running', executionStatus: 'running',
    } as Checkpoint;
    const { store, appended } = makeStore(checkpoint);
    const registry = { getByThreadId: vi.fn(() => ({ runId: 'run-live', threadId: 'thread-zombie', turnId: 'turn-1', interrupt: vi.fn() })) };
    const ctx = makeContext(store, { threadId: 'thread-zombie', status: 'running', executionStatus: 'running', stale: false, resumable: true, checkpoint }, registry);
    const { res } = await callState(ctx);
    const body = (res.body as { state: Record<string, unknown> }).state;
    expect(body.status).toBe('running');
    expect(appended).toHaveLength(0);
  });
});
