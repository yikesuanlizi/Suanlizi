import { Readable } from 'node:stream';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '@suanlizi/storage';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const registry = vi.hoisted(() => ({ providers: [
  { id: 'openai', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', protocol: 'openai' },
  { id: 'custom_vendor', name: 'Vendor', baseUrl: 'https://api.vendor.example/v1', protocol: 'openai' },
] as Array<{ id: string; name: string; baseUrl: string; protocol: string; iconUrl?: string }> }));
vi.mock('@suanlizi/model-gateway', () => ({
  listAllProviders: () => registry.providers,
  addCustomProvider: (provider: typeof registry.providers[number]) => {
    const index = registry.providers.findIndex((item) => item.id === provider.id);
    registry.providers[index] = provider;
  },
  removeCustomProvider: vi.fn(),
}));

import { handleModelCatalogRoute } from './modelCatalogRoute.js';

async function request(method: string, path: string, body?: unknown, store: { getSetting?: (key: string) => Promise<unknown>; setSetting?: (key: string, value: unknown) => Promise<void> } = {}) {
  const req = Object.assign(Readable.from(body === undefined ? [] : [JSON.stringify(body)]), { method, headers: {} }) as IncomingMessage;
  let status = 0;
  let result = '';
  const res = {
    writeHead: (code: number) => { status = code; },
    end: (payload: string) => { result = payload; },
  } as unknown as ServerResponse;
  const handled = await handleModelCatalogRoute({
    req, res, pathname: path, segments: path.slice(1).split('/'),
    repo: {} as never, store: store as never, saveDefault: vi.fn(),
  });
  return { handled, status, data: JSON.parse(result) as { error?: string; provider?: { iconUrl?: string }; providers?: Array<{ iconUrl?: string }> } };
}

describe('model context reference list', () => {
  it('returns editable defaults and persists a replacement list independently', async () => {
    let stored: unknown = null;
    const store = {
      getSetting: vi.fn(async () => stored),
      setSetting: vi.fn(async (_key: string, value: unknown) => { stored = value; }),
    };
    const initial = await request('GET', '/api/model-context-references', undefined, store);
    expect(initial.status).toBe(200);
    expect(initial.data).toMatchObject({ entries: expect.arrayContaining([{ model: 'glm-5.3-flash', contextTokens: 202_752 }]) });
    const next = await request('PUT', '/api/model-context-references', { entries: [{ model: 'vendor-model', contextTokens: 65_536 }] }, store);
    expect(next.status).toBe(200);
    expect(next.data).toEqual({ entries: [{ model: 'vendor-model', contextTokens: 65_536 }] });
    const reloaded = await request('GET', '/api/model-context-references', undefined, store);
    expect(reloaded.data).toEqual({ entries: [{ model: 'vendor-model', contextTokens: 65_536 }] });
  });

  it('preserves an edited list, including an empty list, across SQLite reopen', async () => {
    const root = await mkdtemp(join(tmpdir(), 'suanlizi-model-context-'));
    try {
      const first = createStore(root);
      try {
        expect((await request('PUT', '/api/model-context-references', { entries: [{ model: 'local-name', contextTokens: 72_000 }] }, first.store)).status).toBe(200);
      } finally { (first.db as { close?: () => void }).close?.(); }
      const reopened = createStore(root);
      try {
        expect((await request('GET', '/api/model-context-references', undefined, reopened.store)).data).toEqual({ entries: [{ model: 'local-name', contextTokens: 72_000 }] });
        expect((await request('PUT', '/api/model-context-references', { entries: [] }, reopened.store)).status).toBe(200);
      } finally { (reopened.db as { close?: () => void }).close?.(); }
      const emptied = createStore(root);
      try { expect((await request('GET', '/api/model-context-references', undefined, emptied.store)).data).toEqual({ entries: [] }); }
      finally { (emptied.db as { close?: () => void }).close?.(); }
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('rejects duplicate or invalid entries', async () => {
    const store = { getSetting: vi.fn(async () => null), setSetting: vi.fn(async () => undefined) };
    const result = await request('PUT', '/api/model-context-references', { entries: [{ model: 'x', contextTokens: 1 }, { model: 'X', contextTokens: 2 }] }, store);
    expect(result.status).toBe(400);
    expect(store.setSetting).not.toHaveBeenCalled();
  });
});

describe('custom provider favicon update', () => {
  beforeEach(() => { registry.providers[1] = { id: 'custom_vendor', name: 'Vendor', baseUrl: 'https://api.vendor.example/v1', protocol: 'openai' }; });
  it('persists the selected favicon for existing custom vendors and returns it on reload', async () => {
    const patched = await request('PATCH', '/api/providers/custom_vendor', { iconUrl: 'https://vendor.example/favicon.svg' });
    expect(patched.status).toBe(200);
    expect(patched.data.provider?.iconUrl).toBe('https://vendor.example/favicon.svg');
    const loaded = await request('GET', '/api/providers');
    expect(loaded.data.providers?.[1]?.iconUrl).toBe('https://vendor.example/favicon.svg');
    expect((await request('PATCH', '/api/providers/custom_vendor', { iconUrl: '' })).data.provider?.iconUrl).toBeUndefined();
  });
  it('does not update built-in or removed providers', async () => {
    expect((await request('PATCH', '/api/providers/openai', { iconUrl: 'https://vendor.example/icon.ico' })).status).toBe(404);
    expect((await request('PATCH', '/api/providers/custom_missing', { iconUrl: 'https://vendor.example/icon.ico' })).status).toBe(404);
  });
  it('rejects invalid and non-image payloads without altering the provider', async () => {
    expect((await request('PATCH', '/api/providers/custom_vendor', { iconUrl: 'http://localhost/favicon.ico' })).status).toBe(400);
    expect((await request('PATCH', '/api/providers/custom_vendor', { iconUrl: 'data:image/svg+xml,<svg />' })).status).toBe(400);
    expect((await request('PATCH', '/api/providers/custom_vendor', {})).status).toBe(400);
    expect(registry.providers[1].iconUrl).toBeUndefined();
  });
});
