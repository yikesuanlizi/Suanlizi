import type { ThreadStore } from '@suanlizi/storage';
import type { ModelPreset } from '../config/config.js';
import { defaultConfig, type AgentRunConfig, type ThreadConfigOverrides, type createConfigRepository } from '../config/config.js';

type ConfigRepository = ReturnType<typeof createConfigRepository>;
type RemovedSelection = { providerId: string; model?: string };

function matches(config: { provider?: string; model?: string }, removed: RemovedSelection): boolean {
  return config.provider === removed.providerId
    && (removed.model === undefined || config.model === removed.model);
}

/** 删除模型/厂商后，清除所有持久化的失效选型，而非只修复当前浏览器标签。 */
export async function reconcileRemovedModelSelection(input: {
  repo: ConfigRepository;
  store: ThreadStore;
  removed: RemovedSelection;
  remaining: ModelPreset[];
  saveDefault: (patch: Partial<AgentRunConfig>) => Promise<unknown>;
}): Promise<void> {
  const { repo, store, removed, remaining, saveDefault } = input;
  const fallback = remaining.find((preset) => !matches(preset.config, removed))?.config ?? defaultConfig;
  const patch: ThreadConfigOverrides = {
    provider: fallback.provider,
    model: fallback.model,
    baseUrl: fallback.baseUrl,
  };
  const tokenPatch = {
    ...patch,
    modelContextTokens: fallback.modelContextTokens ?? null,
    modelMaxOutputTokens: fallback.modelMaxOutputTokens ?? null,
  };
  // 更新显式覆盖和旧 tags；继承全局设置的线程会自然跟随新的默认模型。
  for (const thread of await store.listThreads()) {
    const override = await repo.getThreadConfigOverrides(thread.threadId);
    if (matches(override, removed)) {
      await repo.updateThreadConfigOverrides(thread.threadId, tokenPatch);
    }
    const raw = thread.tags?.runConfig;
    if (!raw) continue;
    let tagged: Record<string, unknown>;
    try {
      tagged = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      // 损坏标签由配置仓库原有读取路径处理。
      continue;
    }
    if (!matches(tagged as { provider?: string; model?: string }, removed)) continue;
    const next = { ...tagged, ...patch };
    delete next.modelContextTokens;
    delete next.modelMaxOutputTokens;
    await store.updateThreadMetadata(thread.threadId, {
      tags: { ...thread.tags, runConfig: JSON.stringify(next) },
    });
  }
  if (matches(await repo.getDefaultRunConfig(), removed)) {
    await saveDefault(tokenPatch as Partial<AgentRunConfig>);
  }
}

/** 仅在 API 接受请求之前运行：清除已删除预设遗留的无模型厂商。 */
export async function pruneOrphanCustomProviders(input: {
  listPresets: () => Promise<ModelPreset[]>;
  listProviders: () => Array<{ id: string }>;
  removeProvider: (id: string) => boolean;
  onRemoved: (id: string, remaining: ModelPreset[]) => Promise<void>;
}): Promise<string[]> {
  const presets = await input.listPresets();
  const used = new Set(presets.map((preset) => preset.config.provider));
  const orphans = input.listProviders()
    .filter((provider) => provider.id.startsWith('custom_') && !used.has(provider.id))
    .map((provider) => provider.id);
  for (const id of orphans) {
    await input.onRemoved(id, presets);
    input.removeProvider(id);
  }
  return orphans;
}
