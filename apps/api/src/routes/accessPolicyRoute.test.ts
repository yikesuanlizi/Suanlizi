import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import type { ThreadId, ThreadMeta } from '@suanlizi/protocol';
import type { ThreadStore } from '@suanlizi/storage';
import { createConfigRepository } from '../config/config.js';
import { handleSettingsRoute } from './settingsRoute.js';
import { handleThreadRoutes } from './threadRoutes.js';
import type { ThreadRouteContext } from './threadRoutes.js';

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

class FakeStore {
  settings = new Map<string, unknown>();
  threads = new Map<ThreadId, ThreadMeta>();

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
}

function makeThread(threadId: ThreadId): ThreadMeta {
  return {
    threadId,
    title: 'Policy thread',
    workspaceRoot: process.cwd(),
    status: 'active',
    turnCount: 0,
    createdAt: '2026-07-27T00:00:00.000Z',
    updatedAt: '2026-07-27T00:00:00.000Z',
    archivedAt: null,
    ephemeral: false,
    tags: {},
  };
}

function splitSegments(pathname: string): string[] {
  return pathname.split('/').filter(Boolean);
}

describe('access policy routes', () => {
  it('persists global access policy without returning temporary grants', async () => {
    const store = new FakeStore();
    const repo = createConfigRepository(store as unknown as ThreadStore);
    const response = res();

    const handled = await handleSettingsRoute({
      req: req('PATCH', '/api/settings/access-policy', {
        accessPolicy: {
          mode: 'workspace',
          workspaceRoot: 'E:\\langchain\\Suanlizi',
          persistentRules: [
            {
              id: 'allow-docs',
              effect: 'allow',
              access: 'read',
              target: { kind: 'path', path: 'E:\\langchain\\dexin-agent' },
              scope: 'global',
            },
          ],
          temporaryGrants: [
            {
              id: 'temp-hidden',
              effect: 'allow',
              access: 'read',
              target: { kind: 'path', path: 'E:\\secret' },
              scope: 'session',
              createdAt: '2026-07-27T00:00:00.000Z',
            },
          ],
        },
      }),
      res: response,
      pathname: '/api/settings/access-policy',
      store: store as unknown as ThreadStore,
      getDefaultRunConfig: () => repo.getDefaultRunConfig(),
      saveDefaultRunConfig: (patch) => repo.saveDefaultRunConfig(patch),
      saveGlobalAccessPolicy: (policy) => repo.saveGlobalAccessPolicy(policy),
      resetDefaultAgent: vi.fn(),
    });

    expect(handled).toBe(true);
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      accessPolicy: {
        persistentRules: [expect.objectContaining({ id: 'allow-docs' })],
        temporaryGrants: [],
      },
    });
    await expect(repo.getGlobalAccessPolicy()).resolves.toMatchObject({
      persistentRules: [expect.objectContaining({ id: 'allow-docs' })],
      temporaryGrants: [],
    });
  });

  it('persists thread access policy through thread config route', async () => {
    const store = new FakeStore();
    const repo = createConfigRepository(store as unknown as ThreadStore);
    const threadId = 'thread-access-policy' as ThreadId;
    store.threads.set(threadId, makeThread(threadId));
    const parsed = new URL(`/api/threads/${threadId}/config`, 'http://localhost');
    const response = res();

    const ctx: ThreadRouteContext = {
      store: store as unknown as ThreadStore,
      tenantContext: { tenantId: 'default' },
      createTenantAgent: vi.fn() as never,
      getTenantDefaultAgent: vi.fn() as never,
      publishTenantEvent: vi.fn(),
      getThreadRunConfig: (id) => repo.getThreadRunConfig(id),
      saveThreadRunConfig: (id, patch) => repo.saveThreadRunConfig(id, patch),
      getThreadConfigOverrides: (id) => repo.getThreadConfigOverrides(id),
      updateThreadConfigOverrides: (id, input) => repo.updateThreadConfigOverrides(id, input),
      getThreadAccessPolicy: (id) => repo.getThreadAccessPolicy(id),
      saveThreadAccessPolicy: (id, policy) => repo.saveThreadAccessPolicy(id, policy),
      publicThreadRunConfig: (config, thread) => repo.publicThreadRunConfig(config, thread),
      closeThreadEventClients: vi.fn(),
    };

    const handled = await handleThreadRoutes(
      req('PATCH', parsed.pathname, {
        accessPolicy: {
          mode: 'workspace',
          workspaceRoot: 'E:\\langchain\\Suanlizi',
          persistentRules: [
            {
              id: 'deny-outside-write',
              effect: 'deny',
              access: 'write',
              target: { kind: 'path', path: 'E:\\langchain\\dexin-agent' },
              scope: 'thread',
            },
          ],
          temporaryGrants: [
            {
              id: 'temp-hidden',
              effect: 'allow',
              access: 'write',
              target: { kind: 'path', path: 'E:\\secret' },
              scope: 'session',
              createdAt: '2026-07-27T00:00:00.000Z',
            },
          ],
        },
      }),
      response,
      parsed,
      splitSegments(parsed.pathname),
      ctx,
    );

    expect(handled).toBe(true);
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      accessPolicy: {
        persistentRules: [expect.objectContaining({ id: 'deny-outside-write' })],
        temporaryGrants: [],
      },
    });
    await expect(repo.getThreadAccessPolicy(threadId)).resolves.toMatchObject({
      persistentRules: [expect.objectContaining({ id: 'deny-outside-write' })],
      temporaryGrants: [],
    });
  });
});
