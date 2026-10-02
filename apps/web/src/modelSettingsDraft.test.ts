import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import * as settingsDrawerModule from './components/SettingsDrawer.js';
import { modelDraftAfterDeletion } from './components/settings/shared.js';
import { modelEnvVarForProvider, modelKeySourceForProvider } from './features/settings/useSettingsController.js';

const here = dirname(fileURLToPath(import.meta.url));

describe('model deletion editor fallback', () => {
  it('does not restore a deleted custom vendor from stale config or presets', () => {
    const current = { provider: 'custom_gone', model: 'glm-5.3-flash', baseUrl: 'https://gone.test/v1' };
    const providers = [{ id: 'ollama' }, { id: 'custom_gone' }, { id: 'deepseek' }] as never;
    const presets = [
      { id: 'old', config: current },
      { id: 'kept', config: { provider: 'deepseek', model: 'deepseek-4.1-flash', baseUrl: '' } },
    ] as never;
    expect(modelDraftAfterDeletion(current, providers, presets, { providerId: 'custom_gone' })).toMatchObject({
      provider: 'deepseek', model: 'deepseek-4.1-flash',
    });
  });
});

describe('model settings draft state', () => {
  it('removes the draft / apply / edit half-states entirely', () => {
    const webModels = readFileSync(join(here, 'components', 'settings', 'ModelsPage.tsx'), 'utf-8');
    const controller = readFileSync(join(here, 'features', 'settings', 'useSettingsController.ts'), 'utf-8');

    // 不再有草稿、应用、开始编辑、取消修改这类半成品交互
    for (const banned of ['恢复草稿', '保存为草稿', '保存为正式预设', '开始编辑', '取消修改', 'modelApplyButton']) {
      expect(webModels).not.toContain(banned);
    }
    // 新建/编辑只有一条显式提交链：保存预设后应用同一份配置。
    expect(webModels).toContain('handleSaveModelConfig(persistedPresetIdRef.current)');
    expect(webModels).toContain('handleSetCurrentModelConfig(saved.config)');
    // 选择即生效
    expect(controller).toContain('selectPreset');
  });

  it('auto-detects context without asking for a manual length', () => {
    const models = readFileSync(join(here, 'components', 'settings', 'ModelsPage.tsx'), 'utf-8');
    const controller = readFileSync(join(here, 'features', 'settings', 'useSettingsController.ts'), 'utf-8');
    expect(models).toContain("fetch('/api/model-capabilities'");
    expect(models).toContain('无法识别');
    expect(models).not.toContain('输入 Token 数');
    expect(controller).toContain('modelContextTokens: undefined');
  });

  it('edits model settings in a draft before applying them as the current config', () => {
    const source = readFileSync(join(here, 'features', 'settings', 'useSettingsController.ts'), 'utf-8');
    const models = readFileSync(join(here, 'components', 'settings', 'ModelsPage.tsx'), 'utf-8');

    // modelConfigDraft state 与应用函数已迁到 useSettingsController
    expect(source).toContain('const [modelConfigDraft, setModelConfigDraft]');
    expect(source).toContain('handleSetCurrentModelConfig');
    expect(source).toContain('defaultModelForProvider(provider, current.model)');
    // 输入框绑定已迁到 ModelsPage.tsx
    expect(models).toContain('value={providerSelectValue}');
    expect(models).toContain('value={modelConfigDraft.model}');
    expect(models).toContain('value={modelConfigDraft.baseUrl}');
    expect(models).toContain("className={['modelProviderSelect', providerDirty].filter(Boolean).join(' ')}");
    expect(models).not.toContain('value={config.model} onChange={(event) => setConfig({ ...config, model: event.target.value })}');
    expect(models).not.toContain('value={config.baseUrl} onChange={(event) => setConfig({ ...config, baseUrl: event.target.value })}');
  });

  it('keeps model presets inside the model page as draft loaders instead of a separate settings page', () => {
    const source = readFileSync(join(here, 'features', 'settings', 'useSettingsController.ts'), 'utf-8');
    const drawer = readFileSync(join(here, 'components', 'SettingsDrawer.tsx'), 'utf-8');
    const models = readFileSync(join(here, 'components', 'settings', 'ModelsPage.tsx'), 'utf-8');

    // 加载 preset 进 draft 的回调在 controller 中，UI 在 ModelsPage 中
    expect(source).toContain('loadModelPresetIntoDraft');
    expect(models).toContain('presets.map((preset)');
    expect(models).toContain('<DropdownSelect');
    expect(drawer).not.toContain("{ id: 'presets'");
    expect(drawer).not.toContain("activeSection === 'presets'");
  });

  it('keeps preset selection explicit so duplicate configs never flip to another preset', () => {
    const models = readFileSync(join(here, 'components', 'settings', 'ModelsPage.tsx'), 'utf-8');

    expect(models).toContain('persistedPresetIdRef.current');
    expect(models).toContain('const saved = await handleSaveModelConfig(persistedPresetIdRef.current)');
    expect(models).toContain('if (saved.id) persistedPresetIdRef.current = saved.id');
  });

  it('keeps delete action wired for model presets', () => {
    const main = readFileSync(join(here, 'main.tsx'), 'utf-8');
    const drawer = readFileSync(join(here, 'components', 'SettingsDrawer.tsx'), 'utf-8');
    const models = readFileSync(join(here, 'components', 'settings', 'ModelsPage.tsx'), 'utf-8');

    expect(main).toContain("fetch(`/api/model-presets/${encodeURIComponent(presetId)}`");
    expect(drawer).toContain('deleteModelPreset={deleteModelPreset}');
    expect(models).toContain('handleDeletePreset');
    expect(models).toContain('miniIconButton danger');
  });

  it('lets users edit a provider environment variable without exposing batch env writes', () => {
    const source = readFileSync(join(here, 'features', 'settings', 'useSettingsController.ts'), 'utf-8');
    const models = readFileSync(join(here, 'components', 'settings', 'ModelsPage.tsx'), 'utf-8');

    // env var state 与保存编排已迁到 useSettingsController
    expect(source).toContain('modelEnvVarDraft');
    expect(source).toContain('modelEnvVarOptions');
    expect(source).not.toContain('modelEnvBatchText');
    expect(source).not.toContain('saveEnvironmentVariables');
    expect(source).toContain('/api/keys/env-vars');
    expect(source).toContain('setModelEnvVarRemoteOptions');
    expect(source).toContain('dirtyFields.modelKeySource');
    // 输入与候选 datalist UI 已迁到 ModelsPage.tsx
    expect(models).toContain('list="model-env-var-options"');
    expect(models).toContain('modelEnvVarDraft');
    expect(models).toContain("if (source === 'env' && !modelEnvVarDraft.trim())");
    expect(models).not.toContain('批量设置环境变量');
    expect(models).not.toContain('一次性设置环境变量');
  });

  it('keeps model key source independent from web search key source', () => {
    const source = readFileSync(join(here, 'features', 'settings', 'useSettingsController.ts'), 'utf-8');

    expect(source).not.toContain('useState<SecretSource>(config.webProviderKeySource)');
    expect(source).toContain("useState<SecretSource>('env')");
  });

  it('creates OpenAI-compatible custom providers before saving credentials or applying config', () => {
    const source = readFileSync(join(here, 'features', 'settings', 'useSettingsController.ts'), 'utf-8');

    expect(source).toContain("fetch('/api/providers'");
    expect(source).toContain('Failed to create custom provider');
    expect(source).toContain('setCustomProviderName');
    expect(source).toContain('return newProvider.id');
  });

  it('rejects stale custom provider ids instead of resurrecting a deleted vendor', () => {
    const source = readFileSync(join(here, 'features', 'settings', 'useSettingsController.ts'), 'utf-8');

    expect(source).toContain("modelConfigDraft.provider.startsWith('custom_') && !existingDraftProvider");
    expect(source).toContain('该厂商已删除');
    expect(source).not.toContain('missingLegacyCustomProvider');
  });

  it('surfaces provider env-var save failures instead of pretending settings were applied', () => {
    const source = readFileSync(join(here, 'main.tsx'), 'utf-8');

    expect(source).toContain("const detail = await response.text().catch(() => '');");
    expect(source).toContain('const reason = parseProviderEnvVarSaveFailure(detail);');
    expect(source).toContain("throw new Error(reason ? `Provider env var save failed: ${reason}` : 'Provider env var save failed');");
  });

  it('shows apply-setting failures in the model card instead of only the hidden shell live region', () => {
    const source = readFileSync(join(here, 'features', 'settings', 'useSettingsController.ts'), 'utf-8');

    expect(source).toContain("setModelKeyNotice('');");
    expect(source).toContain("setModelKeyNotice(locale === 'zh' ? '设置已应用。' : 'Settings applied.');");
    expect(source).toContain('setModelKeyNotice(formatSuanliziErrorMessage(undefined, error instanceof Error ? error.message : String(error), locale));');
  });

  it('defaults remote custom providers without an env var to saved-key mode', () => {
    const provider = {
      id: 'custom_ai_gitee_glm_4_7_flash',
      name: 'ai.gitee',
      baseUrl: 'https://ai.gitee.com/v1',
      apiKeyEnvVar: '',
      protocol: 'openai' as const,
      isLocal: false,
    };

    const source = modelKeySourceForProvider(provider, undefined);

    expect(source).toBe('config');
    expect(modelEnvVarForProvider(provider, undefined, source)).toBe('');
  });

  it('keeps configured provider key source authoritative over provider defaults', () => {
    const provider = {
      id: 'openai',
      name: 'OpenAI',
      baseUrl: 'https://api.openai.com/v1',
      apiKeyEnvVar: 'OPENAI_API_KEY',
      protocol: 'openai' as const,
      isLocal: false,
    };
    const keyState = {
      providerId: 'openai',
      envVar: 'OPENAI_API_KEY',
      configured: true,
      source: 'config' as const,
      masked: 'sk-...test',
    };

    const source = modelKeySourceForProvider(provider, keyState);

    expect(source).toBe('config');
    expect(modelEnvVarForProvider(provider, keyState, source)).toBe('');
  });

  it('does not create a provider, save credentials, or post a preset after naming is cancelled', async () => {
    type SaveModelPresetDraft = (operations: {
      requestName: () => Promise<string | null>;
      ensureProvider: () => Promise<string | null>;
      saveProviderKey: (providerId?: string) => Promise<void>;
      saveProviderEnvVar: (providerId?: string) => Promise<void>;
      savePreset: (name: string, config: { provider: string; model: string; baseUrl: string }) => Promise<void>;
      presetConfig: { provider: string; model: string; baseUrl: string };
    }) => Promise<void>;
    const saveModelPresetDraft = (settingsDrawerModule as unknown as {
      saveModelPresetDraft?: SaveModelPresetDraft;
    }).saveModelPresetDraft;
    const requestName = vi.fn(async () => null);
    const ensureProvider = vi.fn(async () => 'custom-provider');
    const saveProviderKey = vi.fn(async () => undefined);
    const saveProviderEnvVar = vi.fn(async () => undefined);
    const savePreset = vi.fn(async () => undefined);

    expect(saveModelPresetDraft).toBeTypeOf('function');
    if (!saveModelPresetDraft) return;

    await saveModelPresetDraft({
      requestName,
      ensureProvider,
      saveProviderKey,
      saveProviderEnvVar,
      savePreset,
      presetConfig: { provider: 'openai_compatible', model: 'custom-model', baseUrl: '' },
    });

    expect(requestName).toHaveBeenCalledTimes(1);
    expect(ensureProvider).toHaveBeenCalledTimes(0);
    expect(saveProviderKey).toHaveBeenCalledTimes(0);
    expect(saveProviderEnvVar).toHaveBeenCalledTimes(0);
    expect(savePreset).toHaveBeenCalledTimes(0);
  });

  it('uses saveModelPresetDraft helper in handleSaveModelConfig', () => {
    const source = readFileSync(join(here, 'features', 'settings', 'useSettingsController.ts'), 'utf-8');
    // P2.3 接线：handleSaveModelConfig 应该调用 saveModelPresetDraft 而不是内联逻辑
    expect(source).toContain('saveModelPresetDraft(');
    expect(source).toContain('await saveModelPresetDraft({');
    // 不应该再保留旧的内联 saveModelPreset 直接调用
    expect(source).not.toMatch(/await saveModelPreset\(name, presetConfig\);/);
  });

  it('persists config with correct body format using settingsClient and threadConfigClient', () => {
    const source = readFileSync(join(here, 'features', 'settings', 'useSettingsController.ts'), 'utf-8');
    // P2.3 修复：使用 saveGlobalDefaults（来自 settingsClient）
    expect(source).toContain('saveGlobalDefaults({ ...config, ...nextConfig })');
    expect(source).toContain('const nextConfig = {');
    expect(source).toContain('provider: savedConfig.provider.trim()');
    expect(source).toContain('model: savedConfig.model.trim()');
    expect(source).toContain("baseUrl: (savedConfig.baseUrl || '').trim()");
    // P2.3 修复：使用 patchThreadConfigOverrides（来自 threadConfigClient）
    expect(source).toContain('patchThreadConfigOverrides(');
    // 不应该有错误的 body 格式（仅匹配 fetch body，不误伤 localStorage 写入）
    expect(source).not.toContain('body: JSON.stringify({ config }),');
    expect(source).not.toMatch(/body:\s*JSON\.stringify\(\{\s*provider:\s*config\.provider/);
  });

  it('marks direct model draft edits dirty so sticky save can run', () => {
    const source = readFileSync(join(here, 'components', 'SettingsDrawer.tsx'), 'utf-8');
    const models = readFileSync(join(here, 'components', 'settings', 'ModelsPage.tsx'), 'utf-8');

    expect(source).toContain('markDirty={controller.markDirty}');
    expect(models).toContain("markDirty('model', true)");
    expect(models).toContain("markDirty('baseUrl', true)");
    expect(models).toContain("markDirty('modelEnvVar', true)");
    expect(models).toContain("markDirty('apiKey', true)");
  });

  it('hydrates modelConfigDraft from server on scope change', () => {
    const source = readFileSync(join(here, 'features', 'settings', 'useSettingsController.ts'), 'utf-8');
    // P2.3 hydrate：作用域切换时从对应源拉取
    expect(source).toContain('hydrateFromScope(scope)');
    expect(source).toContain('void hydrateFromScope(scope);');
    expect(source).toContain('}, [scope, activeThreadId]);');
    expect(source).not.toContain('}, [scope, hydrateFromScope]);');
    expect(source).toContain('fetchThreadConfigOverrides(activeThreadId)');
    expect(source).toContain('localStorage.getItem(RUN_CONFIG_STORAGE_KEY)');
  });

  it('regenerates the latest answer with the model selected before rollback reloads thread config', () => {
    const webMain = readFileSync(join(here, 'main.tsx'), 'utf-8');
    const desktopMain = readFileSync(join(here, '..', '..', 'desktop', 'src', 'main.tsx'), 'utf-8');

    for (const source of [webMain, desktopMain]) {
      expect(source).toContain('configOverride?: Partial<RunConfig>');
      expect(source).toContain('const requestConfig = options.configOverride');
      expect(source).toContain('runtimeConfigPayload(globalConfigRef.current)');
      expect(source).toContain('const regenerateConfig = { ...threadApiConfig };');
      expect(source).toContain("await sendMessage(undefined, userText, { imagesOverride: [], clearComposerImages: false, configOverride: regenerateConfig });");
    }
  });
});
