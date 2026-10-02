import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import type { ThreadId, ThreadMeta } from '@suanlizi/protocol';
import type { ThreadStore } from '@suanlizi/storage';
import { ActiveRunRegistry } from '../runtime/activeRunRegistry.js';
import { handleThreadRoutes, type ThreadRouteContext } from './threadRoutes.js';

function request(): IncomingMessage {
  return Object.assign(Readable.from([]), { method: 'DELETE', url: '/api/threads/thread-delete', headers: {} }) as IncomingMessage;
}

function response(): ServerResponse & { status?: number; body?: unknown } {
  const output = {
    writeHead(status: number) { output.status = status; return output; },
    end(raw: string) { output.body = raw ? JSON.parse(raw) : undefined; },
  } as unknown as ServerResponse & { status?: number; body?: unknown };
  return output;
}

function thread(threadId: ThreadId): ThreadMeta {
  return {
    threadId,
    title: 'Delete me',
    workspaceRoot: process.cwd(),
    status: 'active',
    turnCount: 0,
    createdAt: '2026-09-07T00:00:00.000Z',
    updatedAt: '2026-09-07T00:00:00.000Z',
    archivedAt: null,
    ephemeral: false,
    tags: {},
  };
}

describe('thread deletion route', () => {
  it('waits for the active run to finish before removing persistent thread state', async () => {
    const threadId = 'thread-delete' as ThreadId;
    const meta = new Map<ThreadId, ThreadMeta>([[threadId, thread(threadId)]]);
    const deleted: string[] = [];
    const registry = new ActiveRunRegistry();
    const interrupt = vi.fn(async () => registry.finish('run-delete'));
    registry.register({ runId: 'run-delete', threadId, turnId: 'turn-delete', interrupt });
    const store = {
      getThread: vi.fn(async (id: ThreadId) => meta.get(id) ?? null),
      deleteThreadWorkingSet: vi.fn(async (id: ThreadId) => { deleted.push(`working:${id}`); }),
      deleteThread: vi.fn(async (id: ThreadId) => { deleted.push(`thread:${id}`); meta.delete(id); }),
      getSetting: vi.fn(async () => null),
      setSetting: vi.fn(async () => undefined),
    } as unknown as ThreadStore;
    const agent = {
      interrupt: vi.fn(),
      releaseLlamaSlot: vi.fn(),
    };
    const ctx: ThreadRouteContext = {
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
      activeRunRegistry: registry,
    };
    const res = response();
    const url = new URL(`http://localhost/api/threads/${threadId}`);
    await handleThreadRoutes(request(), res, url, ['api', 'threads', threadId], ctx);

    expect(interrupt).toHaveBeenCalledOnce();
    expect(agent.releaseLlamaSlot).toHaveBeenCalledWith(threadId);
    expect(deleted).toEqual([`working:${threadId}`, `thread:${threadId}`]);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, status: 'deleted' });
  });
});
