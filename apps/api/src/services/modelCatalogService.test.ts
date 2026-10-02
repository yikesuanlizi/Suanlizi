import type { ThreadStore } from '@suanlizi/storage';
import type { ThreadMeta } from '@suanlizi/protocol';
import { describe, expect, it, vi } from 'vitest';
import { createConfigRepository, type ModelPreset } from '../config/config.js';
import { pruneOrphanCustomProviders, reconcileRemovedModelSelection } from './modelCatalogService.js';

class MemoryStore {
  settings = new Map<string, unknown>();
  threads = new Map<string, ThreadMeta>();
  async getSetting<T>(key: string): Promise<T | null> { return (this.settings.get(key) as T) ?? null; }
  async setSetting<T>(key: string, value: T): Promise<void> { this.settings.set(key, value); }
  async listThreads(): Promise<ThreadMeta[]> { return [...this.threads.values()]; }
  async updateThreadMetadata(id: string, patch: Partial<ThreadMeta>): Promise<void> {
    const thread = this.threads.get(id);
    if (thread) this.threads.set(id, { ...thread, ...patch });
  }
}

function thread(id: string, tags: Record<string, string> = {}): ThreadMeta {
  return {
    threadId: id, title: id, workspaceRoot: '', status: 'active', turnCount: 0,
    createdAt: '2026-01-01', updatedAt: '2026-01-01', archivedAt: null, ephemeral: false, tags,
  };
}

const preset = (id: string, provider: string, model: string): ModelPreset => ({
  id, name: model, config: { provider, model, baseUrl: '' },
  createdAt: '2026-01-01', updatedAt: '2026-01-01',
});

describe('model catalog cleanup', () => {
  it('prunes only historical unreferenced custom vendors before accepting requests', async () => {
    const removeProvider = vi.fn(() => true);
    const onRemoved = vi.fn(async () => undefined);
    const remaining = [preset('a', 'custom_vendor', 'glm-5.3-flash'), preset('b', 'custom_vendor', 'deepseek-4.1-flash')];
    const result = await pruneOrphanCustomProviders({
      listPresets: async () => remaining,
      listProviders: () => [{ id: 'custom_vendor' }, { id: 'custom_orphan' }, { id: 'openai' }],
      removeProvider, onRemoved,
    });
    expect(result).toEqual(['custom_orphan']);
    expect(removeProvider).toHaveBeenCalledExactlyOnceWith('custom_orphan');
    expect(onRemoved).toHaveBeenCalledWith('custom_orphan', remaining);
  });

  it('preserves records if reading presets fails, rather than deleting a live vendor', async () => {
    const removeProvider = vi.fn(() => true);
    await expect(pruneOrphanCustomProviders({
      listPresets: async () => { throw new Error('storage unavailable'); },
      listProviders: () => [{ id: 'custom_vendor' }],
      removeProvider, onRemoved: async () => undefined,
    })).rejects.toThrow('storage unavailable');
    expect(removeProvider).not.toHaveBeenCalled();
  });

  it('repairs global, explicit thread overrides and old tags after vendor deletion', async () => {
    const store = new MemoryStore();
    const repo = createConfigRepository(store as unknown as ThreadStore);
    await repo.saveDefaultRunConfig({ provider: 'custom_gone', model: 'glm-5.3-flash', baseUrl: 'https://gone.test/v1', modelContextTokens: 40_000 });
    store.threads.set('override', thread('override'));
    store.threads.set('tagged', thread('tagged', { runConfig: JSON.stringify({ provider: 'custom_gone', model: 'glm-5.3-flash' }) }));
    await repo.updateThreadConfigOverrides('override', {
      provider: 'custom_gone', model: 'glm-5.3-flash', modelContextTokens: 40_000,
    });
    const saveDefault = (patch: Parameters<typeof repo.saveDefaultRunConfig>[0]) => repo.saveDefaultRunConfig(patch);
    await reconcileRemovedModelSelection({
      repo, store: store as unknown as ThreadStore, removed: { providerId: 'custom_gone' },
      remaining: [preset('p', 'deepseek', 'deepseek-4.1-flash')], saveDefault,
    });
    expect(await repo.getDefaultRunConfig()).toMatchObject({ provider: 'deepseek', model: 'deepseek-4.1-flash' });
    expect((await repo.getDefaultRunConfig()).modelContextTokens).toBeUndefined();
    expect(await repo.getThreadConfigOverrides('override')).toMatchObject({ provider: 'deepseek', model: 'deepseek-4.1-flash' });
    expect((await repo.getThreadConfigOverrides('override')).modelContextTokens).toBeUndefined();
    expect(JSON.parse(store.threads.get('tagged')?.tags?.runConfig ?? '{}')).toMatchObject({ provider: 'deepseek', model: 'deepseek-4.1-flash' });
  });
});
