import type { IncomingMessage, ServerResponse } from 'node:http';
import { addCustomProvider, listAllProviders, removeCustomProvider } from '@suanlizi/model-gateway';
import type { ThreadStore } from '@suanlizi/storage';
import { DEFAULT_MODEL_CONTEXT_REFERENCES, validateModelContextReferences, validProviderIconUrl } from '@suanlizi/protocol';
import { type AgentRunConfig, type createConfigRepository } from '../config/config.js';
import { readJson, sendError, sendJson } from '../shared/http.js';
import { reconcileRemovedModelSelection } from '../services/modelCatalogService.js';

type ConfigRepository = ReturnType<typeof createConfigRepository>;

export async function handleModelCatalogRoute(input: {
  req: IncomingMessage;
  res: ServerResponse;
  pathname: string;
  segments: string[];
  repo: ConfigRepository;
  store: ThreadStore;
  saveDefault: (patch: Partial<AgentRunConfig>) => Promise<unknown>;
}): Promise<boolean> {
  const { req, res, pathname, segments, repo, store, saveDefault } = input;
  // 参考列表与 provider / model preset 独立。PUT 保存完整快照，空数组表示用户删空。
  if (pathname === '/api/model-context-references' && req.method === 'GET') {
    const saved = await store.getSetting<unknown>('model_context_references');
    let entries = DEFAULT_MODEL_CONTEXT_REFERENCES;
    if (saved !== null) {
      try { entries = validateModelContextReferences(saved); } catch { /* 损坏的旧值不能污染设置页，回到内置参考列表。 */ }
    }
    sendJson(res, 200, { entries });
    return true;
  }
  if (pathname === '/api/model-context-references' && req.method === 'PUT') {
    try {
      const body = await readJson<{ entries?: unknown }>(req, { maxBytes: 64 * 1024 });
      const entries = validateModelContextReferences(body.entries);
      await store.setSetting('model_context_references', entries);
      sendJson(res, 200, { entries });
    } catch (error) {
      sendError(res, 400, error instanceof Error ? error.message : String(error));
    }
    return true;
  }
  if (req.method === 'GET' && pathname === '/api/providers') {
    sendJson(res, 200, { providers: listAllProviders() });
    return true;
  }

  if (req.method === 'POST' && pathname === '/api/providers') {
    try {
      const body = await readJson<{ name?: string; baseUrl?: string; protocol?: 'openai' | 'anthropic'; iconUrl?: string }>(req);
      const name = (body.name ?? '').trim();
      if (!name) {
        sendError(res, 400, 'Provider name is required');
        return true;
      }
      const baseUrl = (body.baseUrl ?? '').trim() || 'http://localhost:8080/v1';
      const protocol: 'openai' | 'anthropic' = body.protocol === 'anthropic' ? 'anthropic' : 'openai';
      const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 32) || 'custom';
      let id = `custom_${slug}`;
      const existing = listAllProviders();
      let n = 1;
      while (existing.some((provider) => provider.id === id)) id = `custom_${slug}_${++n}`;
      const iconUrl = typeof body.iconUrl === 'string' ? body.iconUrl.trim() : '';
      const validIcon = iconUrl === '' || validProviderIconUrl(iconUrl);
      if (!validIcon) {
        sendError(res, 400, 'Invalid provider iconUrl');
        return true;
      }
      addCustomProvider({
        id, name, baseUrl, apiKeyEnvVar: '', protocol, isLocal: false,
        description: `Custom provider: ${name}`,
        ...(iconUrl ? { iconUrl } : {}),
      });
      sendJson(res, 200, { ok: true, provider: listAllProviders().find((provider) => provider.id === id) });
    } catch (error) {
      sendError(res, 400, error instanceof Error ? error.message : String(error));
    }
    return true;
  }

  if (req.method === 'PATCH' && segments[0] === 'api' && segments[1] === 'providers' && segments.length === 3) {
    const provider = listAllProviders().find((item) => item.id === segments[2] && item.id.startsWith('custom_'));
    if (!provider) {
      sendError(res, 404, 'Custom provider not found');
      return true;
    }
    try {
      const body = await readJson<{ iconUrl?: unknown }>(req, { maxBytes: 80 * 1024 });
      if (typeof body.iconUrl !== 'string') {
        sendError(res, 400, 'Provider iconUrl is required');
        return true;
      }
      const iconUrl = body.iconUrl.trim();
      if (iconUrl && !validProviderIconUrl(iconUrl)) {
        sendError(res, 400, 'Invalid provider iconUrl');
        return true;
      }
      const { iconUrl: _previousIcon, ...withoutIcon } = provider;
      addCustomProvider({ ...withoutIcon, ...(iconUrl ? { iconUrl } : {}) });
      sendJson(res, 200, { ok: true, provider: listAllProviders().find((item) => item.id === provider.id) });
    } catch (error) {
      sendError(res, 400, error instanceof Error ? error.message : String(error));
    }
    return true;
  }

  if (req.method === 'DELETE' && segments[0] === 'api' && segments[1] === 'providers' && segments.length === 3) {
    const providerId = segments[2];
    if (!listAllProviders().some((provider) => provider.id === providerId && providerId.startsWith('custom_'))) {
      sendError(res, 404, 'Custom provider not found');
      return true;
    }
    for (const preset of (await repo.listModelPresets()).filter((item) => item.config.provider === providerId)) {
      await repo.deleteModelPreset(preset.id);
    }
    const presets = await repo.listModelPresets();
    await reconcileRemovedModelSelection({ repo, store, removed: { providerId }, remaining: presets, saveDefault });
    if (!removeCustomProvider(providerId)) throw new Error('Custom provider delete failed');
    sendJson(res, 200, { ok: true, providers: listAllProviders(), presets });
    return true;
  }

  if (req.method === 'GET' && pathname === '/api/model-presets') {
    sendJson(res, 200, { presets: await repo.listModelPresets() });
    return true;
  }
  if (req.method === 'POST' && pathname === '/api/model-presets') {
    const body = await readJson<{ id?: string; name?: string; config?: Partial<AgentRunConfig> }>(req);
    sendJson(res, 200, await repo.upsertModelPreset(body));
    return true;
  }
  if (req.method === 'DELETE' && segments[0] === 'api' && segments[1] === 'model-presets' && segments.length === 3) {
    const deleted = (await repo.listModelPresets()).find((preset) => preset.id === segments[2]);
    if (!deleted) {
      sendError(res, 404, 'Model preset not found');
      return true;
    }
    const presets = await repo.deleteModelPreset(deleted.id);
    await reconcileRemovedModelSelection({
      repo, store, removed: { providerId: deleted.config.provider, model: deleted.config.model },
      remaining: presets, saveDefault,
    });
    if (deleted.config.provider.startsWith('custom_') && !presets.some((preset) => preset.config.provider === deleted.config.provider)) {
      removeCustomProvider(deleted.config.provider);
    }
    sendJson(res, 200, { ok: true, presets, providers: listAllProviders() });
    return true;
  }
  return false;
}
