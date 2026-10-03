import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Locale, RunConfig, SecretSource } from '../../config/config.js';
import { t } from '../../shared/i18n.js';
import { RUN_CONFIG_STORAGE_KEY } from '../../config/config.js';
import type { ApiKeyState, ModelPreset, ModelPresetConfig, ProviderEntry } from '../../shared/types.js';
import { RUNTIME_SETTING_KEYS, defaultModelForProvider, modelConfigDraftFromConfig, modelDraftAfterDeletion, modelPresetMatchesRunConfig, saveModelPresetDraft, type ModelConfigDraft, type ModelPresetSaveResult } from '../../components/settings/shared.js';
import type { MonitorSettingsPatch } from '../../components/settings/MonitorPage.js';
import { saveGlobalDefaults } from './settingsClient.js';
import { fetchThreadConfigOverrides, patchThreadConfigOverrides } from '../../api/threadConfigClient.js';
import { listBrowserTabFavicons, readActiveBrowserTabFavicon } from '../../api/desktopBridge.js';
import { isGuessedProviderIcon, type ProviderBrowserTab } from '@suanlizi/protocol';
import type { SettingsScope, SettingsScopeInfo, SettingsSaveState } from '../../components/settings/SettingsShell.js';
import { formatSuanliziErrorMessage } from '@suanlizi/protocol';

export interface UseSettingsControllerOptions {
  locale: Locale;
  config: RunConfig;
  activeThreadId: string;
  providers: ProviderEntry[];
  keyStates: ApiKeyState[];
  modelPresets: ModelPreset[];
  requestModelPresetName: (defaultName: string) => Promise<string | null>;
  saveModelPreset: (name: string, presetConfig: ModelPresetConfig, presetId?: string) => Promise<string | ModelPreset | void>;
  saveProviderKey: (providerId: string, apiKey: string) => Promise<void>;
  saveProviderEnvVar: (providerId: string, envVar: string) => Promise<void>;
  saveThreadModelOverrides: (overrides: {
    provider: string;
    model: string;
    baseUrl: string;
    modelContextTokens?: number;
    modelMaxOutputTokens?: number;
  }) => Promise<void>;
  saveGlobalModelConfig: (config: RunConfig) => void;
  setConfig: React.Dispatch<React.SetStateAction<RunConfig>>;
  refreshProviders: () => Promise<void>;
  refreshKeyStates: () => Promise<void>;
  onClose?: () => void;
}

export interface UseSettingsControllerResult {
  scope: SettingsScope;
  setScope: (s: SettingsScope) => void;
  scopeInfo: SettingsScopeInfo;
  saveLabel: string;
  saveState: SettingsSaveState;
  handleSave: () => void;
  handleSaveRuntimeSettings: () => Promise<void>;
  selectPreset: (presetId: string) => Promise<void>;
  handleSaveMonitorSettings: (patch?: MonitorSettingsPatch) => Promise<void>;
  handleCancel: () => Promise<void>;
  markDirty: (field: string, dirty: boolean) => void;
  dirtyFields: Record<string, boolean>;
  modelConfigDraft: ModelConfigDraft;
  setModelConfigDraft: React.Dispatch<React.SetStateAction<ModelConfigDraft>>;
  apiKeyDraft: string;
  setApiKeyDraft: React.Dispatch<React.SetStateAction<string>>;
  modelKeySource: SecretSource;
  setModelKeySource: React.Dispatch<React.SetStateAction<SecretSource>>;
  showSavedModelKey: boolean;
  setShowSavedModelKey: React.Dispatch<React.SetStateAction<boolean>>;
  modelKeyNotice: string;
  hasSavedModelKey: boolean;
  hasConfiguredModelEnvVar: boolean;
  setModelKeyNotice: React.Dispatch<React.SetStateAction<string>>;
  modelEnvVarDraft: string;
  setModelEnvVarDraft: React.Dispatch<React.SetStateAction<string>>;
  modelEnvVarOptions: string[];
  customProviderName: string;
  setCustomProviderName: React.Dispatch<React.SetStateAction<string>>;
  selectModelProviderDraft: (providerId: string) => void;
  loadModelPresetIntoDraft: (presetId: string) => void;
  startNewModelPreset: () => void;
  ensureCustomProvider: () => Promise<string | null>;
  handleSaveModelConfig: (presetId?: string, contextTokens?: number) => Promise<ModelPresetSaveResult | null>;
  listProviderIconTabs: () => Promise<ProviderBrowserTab[]>;
  saveProviderIcon: (providerId: string, iconUrl: string) => Promise<void>;
  handleSetCurrentModelConfig: (savedConfig: ModelPresetConfig) => Promise<boolean>;
  resetModelDraft: (deleted?: { providerId: string; model?: string }) => void;
}

export function modelKeySourceForProvider(provider: ProviderEntry | undefined, keyState: ApiKeyState | undefined): SecretSource {
  if (keyState?.source === 'config' || keyState?.source === 'env') return keyState.source;
  if (provider?.apiKeyEnvVar?.trim()) return 'env';
  if (provider && !provider.isLocal) return 'config';
  return 'env';
}

export function modelEnvVarForProvider(
  provider: ProviderEntry | undefined,
  keyState: ApiKeyState | undefined,
  source: SecretSource,
): string {
  if (source !== 'env') return '';
  return keyState?.envVar || provider?.apiKeyEnvVar || '';
}

export function useSettingsController(options: UseSettingsControllerOptions): UseSettingsControllerResult {
  const {
    locale,
    config,
    activeThreadId,
    providers,
    keyStates,
    modelPresets,
    requestModelPresetName,
    saveModelPreset,
    saveProviderKey,
    saveProviderEnvVar,
    saveThreadModelOverrides: _saveThreadModelOverrides,
    saveGlobalModelConfig: _saveGlobalModelConfig,
    setConfig,
    refreshProviders,
    refreshKeyStates,
    onClose,
  } = options;

  const [scope, setScopeState] = useState<SettingsScope>('global');
  const [dirtyFields, setDirtyFields] = useState<Record<string, boolean>>({});
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedToastAt, setSavedToastAt] = useState<number | null>(null);

  const [modelConfigDraft, setModelConfigDraft] = useState<ModelConfigDraft>(() => modelConfigDraftFromConfig(config));
  const [apiKeyDraft, setApiKeyDraft] = useState('');
  const [modelKeySource, setModelKeySource] = useState<SecretSource>('env');
  const [showSavedModelKey, setShowSavedModelKey] = useState(false);
  const [modelKeyNotice, setModelKeyNotice] = useState('');
  const [modelEnvVarDraft, setModelEnvVarDraft] = useState('');
  const [modelEnvVarRemoteOptions, setModelEnvVarRemoteOptions] = useState<string[]>([]);
  const [customProviderName, setCustomProviderName] = useState('');
  const [savedKeyProviders, setSavedKeyProviders] = useState<Set<string>>(() => new Set());
  const [savedEnvVars, setSavedEnvVars] = useState<Record<string, string>>({});
  // 抑制自动保存：切换预设期间不要把旧字段写回新预设。
  const autoSaveSuppressRef = useRef(false);

  const selectedKeyState = useMemo(
    () => keyStates.find((state) => state.providerId === modelConfigDraft.provider),
    [keyStates, modelConfigDraft.provider],
  );
  const hasSavedModelKey = modelKeySource === 'config' && (
    (selectedKeyState?.configured === true && selectedKeyState.source === 'config')
    || savedKeyProviders.has(modelConfigDraft.provider)
  );
  const hasConfiguredModelEnvVar = modelKeySource === 'env' && (
    (selectedKeyState?.configured === true && selectedKeyState.source === 'env')
    || Boolean(savedEnvVars[modelConfigDraft.provider])
  );

  const [_threadOverrides, setThreadOverrides] = useState<{ provider?: string; model?: string; baseUrl?: string }>({});

  const modelEnvVarOptions = useMemo(() => {
    const selected = providers.find((p) => p.id === modelConfigDraft.provider);
    const fromKeyState = keyStates.find((k) => k.providerId === modelConfigDraft.provider);
    const options = new Set<string>();
    if (selected?.apiKeyEnvVar) options.add(selected.apiKeyEnvVar);
    if (fromKeyState?.envVar) options.add(fromKeyState.envVar);
    if (fromKeyState?.defaultEnvVar) options.add(fromKeyState.defaultEnvVar);
    for (const envVar of fromKeyState?.envVarCandidates ?? []) options.add(envVar);
    for (const envVar of modelEnvVarRemoteOptions) options.add(envVar);
    options.add('OPENAI_API_KEY');
    options.add('DEEPSEEK_API_KEY');
    options.add('ZHIPU_API_KEY');
    options.add('MOONSHOT_API_KEY');
    options.add('DASHSCOPE_API_KEY');
    options.add('ANTHROPIC_API_KEY');
    options.add('GOOGLE_API_KEY');
    return Array.from(options).filter((value) => value.trim()).sort((a, b) => a.localeCompare(b));
  }, [providers, keyStates, modelConfigDraft.provider, modelEnvVarRemoteOptions]);

  const hydrateFromScope = useCallback(async (nextScope: SettingsScope) => {
    setDirtyFields({});
    setSaveError(null);
    setSavedToastAt(null);
    setModelKeyNotice('');
    setApiKeyDraft('');

    let draft: ModelConfigDraft;
    let keySource: SecretSource;
    let envVar = '';

    if (nextScope === 'global') {
      try {
        const response = await fetch('/api/settings');
        if (response.ok) {
          const data = (await response.json()) as { config?: Partial<RunConfig> };
          const serverConfig = data.config;
          draft = serverConfig ? {
            provider: serverConfig.provider ?? config.provider,
            model: serverConfig.model ?? config.model,
            baseUrl: serverConfig.baseUrl ?? config.baseUrl,
            // Omitted means not configured; never inherit an active
            // thread override into the global editor.
            modelContextTokens: serverConfig.modelContextTokens,
            modelMaxOutputTokens: serverConfig.modelMaxOutputTokens,
          } : modelConfigDraftFromConfig(config);
        } else {
          draft = modelConfigDraftFromConfig(config);
        }
      } catch {
        draft = modelConfigDraftFromConfig(config);
      }
    } else if (nextScope === 'currentThread' && activeThreadId) {
      try {
        const overrides = await fetchThreadConfigOverrides(activeThreadId);
        setThreadOverrides(overrides);
        const hasModelIdentityOverride = overrides.provider !== undefined
          || overrides.model !== undefined
          || overrides.baseUrl !== undefined;
        draft = {
          provider: overrides.provider ?? config.provider,
          model: overrides.model ?? config.model,
          baseUrl: overrides.baseUrl ?? config.baseUrl,
          modelContextTokens: overrides.modelContextTokens
            ?? (hasModelIdentityOverride ? undefined : config.modelContextTokens),
          modelMaxOutputTokens: overrides.modelMaxOutputTokens
            ?? (hasModelIdentityOverride ? undefined : config.modelMaxOutputTokens),
        };
      } catch {
        draft = modelConfigDraftFromConfig(config);
      }
    } else if (nextScope === 'newThread') {
      try {
        const stored = localStorage.getItem(RUN_CONFIG_STORAGE_KEY);
        if (stored) {
          const parsed = JSON.parse(stored) as Partial<RunConfig>;
          const hasModelIdentityOverride = parsed.provider !== undefined
            || parsed.model !== undefined
            || parsed.baseUrl !== undefined;
          draft = {
            provider: parsed.provider ?? config.provider,
            model: parsed.model ?? config.model,
            baseUrl: parsed.baseUrl ?? config.baseUrl,
            modelContextTokens: parsed.modelContextTokens
              ?? (hasModelIdentityOverride ? undefined : config.modelContextTokens),
            modelMaxOutputTokens: parsed.modelMaxOutputTokens
              ?? (hasModelIdentityOverride ? undefined : config.modelMaxOutputTokens),
          };
        } else {
          draft = modelConfigDraftFromConfig(config);
        }
      } catch {
        draft = modelConfigDraftFromConfig(config);
      }
    } else {
      draft = modelConfigDraftFromConfig(config);
    }

    const provider = providers.find((p) => p.id === draft.provider);
    const keyState = keyStates.find((k) => k.providerId === draft.provider);
    keySource = modelKeySourceForProvider(provider, keyState);
    envVar = modelEnvVarForProvider(provider, keyState, keySource);

    setModelConfigDraft(draft);
    setModelKeySource(keySource);
    setModelEnvVarDraft(envVar);
    setCustomProviderName(draft.provider.startsWith('custom_') ? '' : '');
  }, [config, activeThreadId, providers, keyStates]);

  useEffect(() => {
    void hydrateFromScope(scope);
    // Keep this effect scoped to real context changes. Saving refreshes keyStates/providers;
    // rehydrating on those refreshes would wipe the just-selected env-var draft.
  }, [scope, activeThreadId]);

  useEffect(() => {
    if (dirtyFields.modelKeySource || dirtyFields.modelEnvVar || dirtyFields.apiKey) return;
    const selectedProvider = providers.find((p) => p.id === modelConfigDraft.provider);
    if (modelKeySource === 'env' && selectedProvider?.apiKeyEnvVar && !modelEnvVarDraft) {
      setModelEnvVarDraft(selectedProvider.apiKeyEnvVar);
    }
  }, [
    dirtyFields.modelKeySource,
    dirtyFields.modelEnvVar,
    dirtyFields.apiKey,
    modelConfigDraft.provider,
    providers,
    modelEnvVarDraft,
    modelKeySource,
  ]);

  const markDirty = useCallback((field: string, dirty: boolean) => {
    setDirtyFields((current) => {
      if (current[field] === dirty) return current;
      const next = { ...current };
      if (dirty) {
        next[field] = true;
      } else {
        delete next[field];
      }
      return next;
    });
  }, []);

  const dirty = Object.keys(dirtyFields).length > 0;

  const saveState: SettingsSaveState = useMemo(() => ({
    dirty,
    saving,
    error: saveError,
    savedToastAt,
  }), [dirty, saving, saveError, savedToastAt]);

  const currentThreadAvailable = Boolean(activeThreadId);

  const setScope = useCallback((next: SettingsScope) => {
    setScopeState(next);
    setDirtyFields({});
    setSaveError(null);
    setSavedToastAt(null);
  }, []);

  const scopeInfo: SettingsScopeInfo = useMemo(() => ({
    value: scope,
    onChange: setScope,
    currentThreadAvailable,
  }), [scope, currentThreadAvailable]);

  const saveLabel = t(locale, 'save');

  const selectModelProviderDraft = useCallback((providerId: string) => {
    const provider = providers.find((p) => p.id === providerId);
    setModelConfigDraft((current) => {
      return {
        ...current,
        provider: providerId,
        model: defaultModelForProvider(provider, current.model),
        baseUrl: providerId === 'openai_compatible' ? '' : (provider?.baseUrl ?? current.baseUrl),
        // The selected endpoint is authoritative. Clear the old model's
        // window so the server can probe the actual limit.
        modelContextTokens: undefined,
        modelMaxOutputTokens: undefined,
      };
    });
    if (providerId !== 'openai_compatible') {
      setCustomProviderName('');
    }
    markDirty('provider', true);
    markDirty('model', true);
    markDirty('modelContextTokens', false);
    markDirty('modelMaxOutputTokens', true);
    setApiKeyDraft('');
    setShowSavedModelKey(false);
    const keyState = keyStates.find((state) => state.providerId === providerId);
    const nextSource = modelKeySourceForProvider(provider, keyState);
    setModelKeySource(nextSource);
    setModelEnvVarDraft(modelEnvVarForProvider(provider, keyState, nextSource));
  }, [providers, keyStates, markDirty]);

  const ensureCustomProvider = useCallback(async (): Promise<string | null> => {
    const existingDraftProvider = providers.find((provider) => provider.id === modelConfigDraft.provider);
    if (modelConfigDraft.provider.startsWith('custom_') && !existingDraftProvider) {
      throw new Error(locale === 'zh' ? '该厂商已删除，请重新选择厂商。' : 'This provider was deleted. Choose another provider.');
    }
    if (modelConfigDraft.provider !== 'openai_compatible') return modelConfigDraft.provider;
    const name = customProviderName.trim();
    if (!name) throw new Error(locale === 'zh' ? '请填写厂商名称。' : 'Vendor name is required.');
    if (name === 'OpenAI-compatible') return 'openai_compatible';
    const existing = providers.find((provider) => (
      provider.id.startsWith('custom_')
      && provider.name.trim().toLowerCase() === name.toLowerCase()
      && provider.baseUrl.trim() === modelConfigDraft.baseUrl.trim()
    ));
    if (existing) return existing.id;
    const faviconUrl = await readActiveBrowserTabFavicon({ threadId: activeThreadId || undefined, baseUrl: modelConfigDraft.baseUrl });
    const response = await fetch('/api/providers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name,
        baseUrl: modelConfigDraft.baseUrl,
        protocol: 'openai',
        ...(faviconUrl ? { iconUrl: faviconUrl } : {}),
      }),
    });
    if (!response.ok) {
      const err = await response.text().catch(() => '');
      throw new Error(`Failed to create custom provider: ${err.slice(0, 200)}`);
    }
    const data = (await response.json()) as { provider?: ProviderEntry };
    const newProvider = data.provider;
    if (!newProvider?.id) return modelConfigDraft.provider;
    await refreshProviders();
    setCustomProviderName('');
    return newProvider.id;
  }, [modelConfigDraft.provider, modelConfigDraft.baseUrl, customProviderName, providers, refreshProviders]);

  async function listProviderIconTabs(): Promise<ProviderBrowserTab[]> {
    return listBrowserTabFavicons({ threadId: activeThreadId || undefined });
  }

  async function saveProviderIcon(providerId: string, iconUrl: string): Promise<void> {
    const response = await fetch(`/api/providers/${encodeURIComponent(providerId)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ iconUrl }),
    });
    if (!response.ok) {
      const error = await response.json().catch(() => ({})) as { error?: string };
      throw new Error(error.error ?? (locale === 'zh' ? '图标保存失败' : 'Failed to save icon'));
    }
    await refreshProviders();
  }

  const saveModelKeyDraftIfNeeded = useCallback(async (providerId?: string) => {
    const targetProvider = providerId ?? modelConfigDraft.provider;
    if (modelKeySource === 'config' && apiKeyDraft.trim()) {
      await saveProviderKey(targetProvider, apiKeyDraft.trim());
      setSavedKeyProviders((current) => current.has(targetProvider) ? current : new Set(current).add(targetProvider));
    }
  }, [modelKeySource, apiKeyDraft, modelConfigDraft.provider, saveProviderKey]);

  const saveModelEnvVarDraftIfNeeded = useCallback(async (providerId?: string) => {
    const targetProvider = providerId ?? modelConfigDraft.provider;
    if (modelKeySource === 'env' && modelEnvVarDraft.trim()) {
      await saveProviderEnvVar(targetProvider, modelEnvVarDraft.trim());
      setSavedEnvVars((current) => ({ ...current, [targetProvider]: modelEnvVarDraft.trim() }));
    }
  }, [modelKeySource, modelEnvVarDraft, modelConfigDraft.provider, saveProviderEnvVar]);

  const loadModelPresetIntoDraft = useCallback((presetId: string) => {
    if (presetId === '__draft__' || presetId === '__new__') return;
    const preset = modelPresets.find((p) => p.id === presetId);
    if (!preset) return;
    setModelConfigDraft({
      provider: preset.config.provider.trim(),
      model: preset.config.model.trim(),
      baseUrl: (preset.config.baseUrl || '').trim(),
      modelContextTokens: preset.config.modelContextTokens,
      modelMaxOutputTokens: preset.config.modelMaxOutputTokens,
    });
    const providerId = preset.config.provider.trim();
    const provider = providers.find((p) => p.id === providerId);
    const keyState = keyStates.find((k) => k.providerId === providerId);
    const nextSource = modelKeySourceForProvider(provider, keyState);
    setModelKeySource(nextSource);
    setModelEnvVarDraft(modelEnvVarForProvider(provider, keyState, nextSource));
    // Loading a preset is also the cancellation baseline. Clear any secret
    // draft and provider-specific edits from the previous preset.
    setApiKeyDraft('');
    setShowSavedModelKey(false);
    setCustomProviderName('');
    setModelKeyNotice('');
    markDirty('provider', false);
    markDirty('model', false);
    markDirty('baseUrl', false);
    markDirty('modelContextTokens', false);
    markDirty('modelMaxOutputTokens', false);
    markDirty('apiKey', false);
    markDirty('modelEnvVar', false);
    markDirty('modelKeySource', false);
  }, [modelPresets, providers, keyStates, markDirty]);

  const startNewModelPreset = useCallback(() => {
    const providerId = providers.some((item) => item.id === modelConfigDraft.provider)
      ? modelConfigDraft.provider
      : providers.some((item) => item.id === config.provider) ? config.provider : 'ollama';
    const provider = providers.find((item) => item.id === providerId);
    const keyState = keyStates.find((state) => state.providerId === providerId);
    const nextSource = modelKeySourceForProvider(provider, keyState);
    setModelConfigDraft({
      provider: providerId,
      model: '',
      baseUrl: '',
      modelContextTokens: undefined,
      modelMaxOutputTokens: undefined,
    });
    setApiKeyDraft('');
    setModelEnvVarDraft('');
    setCustomProviderName('');
    setModelKeySource(nextSource);
    setShowSavedModelKey(false);
    setModelKeyNotice('');
    setDirtyFields((current) => {
      const next = { ...current };
      for (const field of ['provider', 'model', 'baseUrl', 'modelContextTokens', 'modelMaxOutputTokens', 'apiKey', 'modelEnvVar', 'modelKeySource']) delete next[field];
      return next;
    });
  }, [modelConfigDraft.provider, config.provider, providers, keyStates]);

  useEffect(() => {
    fetch('/api/keys/env-vars')
      .then((response) => response.ok ? response.json() : null)
      .then((data: { envVars?: string[] } | null) => setModelEnvVarRemoteOptions(data?.envVars ?? []))
      .catch(() => setModelEnvVarRemoteOptions([]));
  }, []);

  const handleSaveModelConfig = useCallback(async (presetId?: string, contextTokens?: number): Promise<ModelPresetSaveResult | null> => {
    try {
      setModelKeyNotice('');
      const saved = await saveModelPresetDraft({
        requestName: () => {
          // 名称始终由真实厂商名 + 模型推导，避免把 openai_compatible 之类的
          // 协议 id 暴露给用户；新建时自动去重，不再弹命名框。
          const provider = providers.find((item) => item.id === modelConfigDraft.provider);
          const providerName = provider?.name
            ?? customProviderName.trim()
            ?? modelConfigDraft.provider.replace(/^custom_/, '').replace(/_/g, '.');
          const base = [providerName, modelConfigDraft.model.trim()].filter(Boolean).join(' / ') || modelConfigDraft.model.trim() || 'Model preset';
          if (presetId) return Promise.resolve(base);
          const taken = new Set(modelPresets.map((preset) => preset.name));
          if (!taken.has(base)) return Promise.resolve(base);
          let index = 2;
          while (taken.has(`${base} ${index}`)) index += 1;
          return Promise.resolve(`${base} ${index}`);
        },
        ensureProvider: ensureCustomProvider,
        saveProviderKey: saveModelKeyDraftIfNeeded,
        saveProviderEnvVar: saveModelEnvVarDraftIfNeeded,
        savePreset: saveModelPreset,
        presetConfig: {
          provider: modelConfigDraft.provider.trim(),
          model: modelConfigDraft.model.trim(),
          baseUrl: modelConfigDraft.baseUrl.trim(),
          modelContextTokens: contextTokens,
          modelMaxOutputTokens: modelConfigDraft.modelMaxOutputTokens,
        },
        presetId,
      });
      if (!saved) return null;
      if (saved.config) {
        setModelConfigDraft({
          provider: saved.config.provider.trim(),
          model: saved.config.model.trim(),
          baseUrl: (saved.config.baseUrl || '').trim(),
          modelContextTokens: saved.config.modelContextTokens,
          modelMaxOutputTokens: saved.config.modelMaxOutputTokens,
        });
      }
      setApiKeyDraft('');
      markDirty('provider', false);
      markDirty('model', false);
      markDirty('baseUrl', false);
      markDirty('modelContextTokens', false);
      markDirty('modelMaxOutputTokens', false);
      markDirty('apiKey', false);
      markDirty('modelEnvVar', false);
      markDirty('modelKeySource', false);
      setModelKeyNotice(locale === 'zh' ? '预设已保存。' : 'Preset saved.');
      await refreshKeyStates();
      return saved;
    } catch (error) {
      setModelKeyNotice(formatSuanliziErrorMessage(undefined, error instanceof Error ? error.message : String(error), locale));
      return null;
    }
  }, [
    modelConfigDraft,
    modelPresets,
    requestModelPresetName,
    ensureCustomProvider,
    saveModelKeyDraftIfNeeded,
    saveModelEnvVarDraftIfNeeded,
    saveModelPreset,
    refreshKeyStates,
    markDirty,
    locale,
  ]);

  const handleSetCurrentModelConfig = useCallback(async (savedConfig: ModelPresetConfig): Promise<boolean> => {
    try {
      setSaving(true);
      setSaveError(null);
      setModelKeyNotice('');
      // 模型预设保存阶段已经完成厂商、密钥和预设持久化；此处只应用。
      const nextConfig = {
        provider: savedConfig.provider.trim(),
        model: savedConfig.model.trim(),
        baseUrl: (savedConfig.baseUrl || '').trim(),
        modelContextTokens: savedConfig.modelContextTokens,
        modelMaxOutputTokens: savedConfig.modelMaxOutputTokens,
      };
      if (scope === 'global') {
        await saveGlobalDefaults({ ...config, ...nextConfig });
        _saveGlobalModelConfig({ ...config, ...nextConfig });
      } else if (scope === 'currentThread' && activeThreadId) {
        const updated = await patchThreadConfigOverrides(activeThreadId, nextConfig);
        setThreadOverrides(updated);
        setConfig((current) => ({ ...current, ...nextConfig }));
      } else if (scope === 'newThread') {
        const stored = localStorage.getItem(RUN_CONFIG_STORAGE_KEY);
        const base = stored ? JSON.parse(stored) as Partial<RunConfig> : {};
        localStorage.setItem(RUN_CONFIG_STORAGE_KEY, JSON.stringify({ ...base, ...nextConfig }));
      }
      setApiKeyDraft('');
      setDirtyFields({});
      setSavedToastAt(Date.now());
      setModelKeyNotice(locale === 'zh' ? '设置已应用。' : 'Settings applied.');
      await refreshKeyStates();
      setTimeout(() => setSavedToastAt(null), 2000);
      return true;
    } catch (error) {
      const message = formatSuanliziErrorMessage(undefined, error instanceof Error ? error.message : String(error), locale);
      setSaveError(message);
      setModelKeyNotice(message);
      return false;
    } finally {
      setSaving(false);
    }
  }, [scope, activeThreadId, config, locale, refreshKeyStates, saveGlobalDefaults, _saveGlobalModelConfig, setConfig]);

  // 运行参数页保存：修复此前“保存按钮只写模型字段”的半截逻辑——
  // 压缩阈值等运行字段过去既没有进全局默认值，也没有进线程覆盖，等于设置白填。
  const handleSaveRuntimeSettings = useCallback(async () => {
    if (saving) return;
    setSaving(true);
    setSaveError(null);
    try {
      const runtimePatch: Partial<RunConfig> = {};
      for (const key of RUNTIME_SETTING_KEYS) {
        const value = config[key];
        if (value !== undefined) (runtimePatch as Record<string, unknown>)[key] = value;
      }
      // 进程级上限（迭代/并发/超时）只有全局配置能表达；压缩阈值支持线程覆盖。
      const { compactionThreshold, ...processWide } = runtimePatch;
      if (scope === 'currentThread' && activeThreadId) {
        if (compactionThreshold !== undefined) {
          const updated = await patchThreadConfigOverrides(activeThreadId, { compactionThreshold });
          setThreadOverrides(updated);
        }
        if (Object.keys(processWide).length > 0) await saveGlobalDefaults(processWide);
      } else if (scope === 'newThread') {
        if (compactionThreshold !== undefined) {
          const stored = localStorage.getItem(RUN_CONFIG_STORAGE_KEY);
          const base = stored ? JSON.parse(stored) as Partial<RunConfig> : {};
          localStorage.setItem(RUN_CONFIG_STORAGE_KEY, JSON.stringify({ ...base, compactionThreshold }));
        }
        if (Object.keys(processWide).length > 0) await saveGlobalDefaults(processWide);
      } else {
        await saveGlobalDefaults(runtimePatch);
      }
      setConfig((current) => ({ ...current, ...runtimePatch }));
      for (const key of RUNTIME_SETTING_KEYS) markDirty(String(key), false);
      setSavedToastAt(Date.now());
      setTimeout(() => setSavedToastAt(null), 2000);
    } catch (error) {
      setSaveError(formatSuanliziErrorMessage(undefined, error instanceof Error ? error.message : String(error), locale));
    } finally {
      setSaving(false);
    }
  }, [activeThreadId, config, locale, markDirty, saving, saveGlobalDefaults, setConfig]);

  const handleSave = useCallback(() => {
    // 模型只通过新建/编辑弹窗提交；保留空操作兼容 SettingsShell 的旧契约。
  }, []);

  // 选择预设即生效：加载配置并立刻写入当前作用域，无需再点“应用”。
  const selectPreset = useCallback(async (presetId: string) => {
    const preset = modelPresets.find((item) => item.id === presetId);
    if (!preset) return;
    // 先把字段切到该预设，避免自动保存把旧值写回新预设。
    autoSaveSuppressRef.current = true;
    loadModelPresetIntoDraft(presetId);
    autoSaveSuppressRef.current = false;
    const nextConfig = {
      provider: preset.config.provider.trim(),
      model: preset.config.model.trim(),
      baseUrl: (preset.config.baseUrl || '').trim(),
      modelContextTokens: preset.config.modelContextTokens,
      modelMaxOutputTokens: preset.config.modelMaxOutputTokens,
    };
    try {
      setSaving(true);
      if (scope === 'global') {
        await saveGlobalDefaults(nextConfig);
        _saveGlobalModelConfig({ ...config, ...nextConfig });
      } else if (scope === 'currentThread' && activeThreadId) {
        const updated = await patchThreadConfigOverrides(activeThreadId, nextConfig);
        setThreadOverrides(updated);
        setConfig((current) => ({ ...current, ...nextConfig }));
      }
      setSavedToastAt(Date.now());
      setTimeout(() => setSavedToastAt(null), 2000);
    } catch (error) {
      setModelKeyNotice(formatSuanliziErrorMessage(undefined, error instanceof Error ? error.message : String(error), locale));
    } finally {
      setSaving(false);
    }
  }, [modelPresets, loadModelPresetIntoDraft, scope, activeThreadId, saveGlobalDefaults, _saveGlobalModelConfig, _saveThreadModelOverrides, patchThreadConfigOverrides, setConfig, config, locale]);


  const handleSaveMonitorSettings = useCallback(async (patch: MonitorSettingsPatch = {}) => {
    if (saving) return;
    setSaving(true);
    setSaveError(null);
    try {
      // Monitor controls are global runtime settings, so persist them through
      // the settings API instead of the model-draft save path.
      const samplingEnabled = patch.systemMonitorSamplingEnabled ?? config.systemMonitorSamplingEnabled;
      const monitorPatch = {
        monitorPanelVisible: patch.monitorPanelVisible ?? config.monitorPanelVisible,
        systemMonitorSamplingEnabled: samplingEnabled,
        systemMonitorLogRecordingEnabled: patch.systemMonitorLogRecordingEnabled ?? config.systemMonitorLogRecordingEnabled,
        systemMonitorGuardEnabled: patch.systemMonitorGuardEnabled ?? config.systemMonitorGuardEnabled,
        systemMonitorThresholds: patch.systemMonitorThresholds ?? config.systemMonitorThresholds,
      };
      await saveGlobalDefaults(monitorPatch);
      setConfig((current) => ({ ...current, ...monitorPatch }));
      const changedFields = Object.keys(patch).length > 0
        ? Object.keys(patch)
        : ['monitorPanelVisible', 'systemMonitorSamplingEnabled', 'systemMonitorLogRecordingEnabled', 'systemMonitorGuardEnabled', 'systemMonitorThresholds'];
      for (const field of changedFields) markDirty(field, false);
      setSavedToastAt(Date.now());
      setTimeout(() => setSavedToastAt(null), 2000);
    } catch (error) {
      setSaveError(formatSuanliziErrorMessage(undefined, error instanceof Error ? error.message : String(error), locale));
    } finally {
      setSaving(false);
    }
  }, [config, markDirty, saving, setConfig]);

  const handleCancel = useCallback(async () => {
    await hydrateFromScope(scope);
    if (onClose) onClose();
  }, [hydrateFromScope, scope, onClose]);

  const resetModelDraft = useCallback((deleted?: { providerId: string; model?: string }) => {
    const currentDraft = modelDraftAfterDeletion(modelConfigDraftFromConfig(config), providers, modelPresets, deleted);
    const currentProvider = providers.find((provider) => provider.id === currentDraft.provider);
    const currentKeyState = keyStates.find((state) => state.providerId === currentDraft.provider);
    const currentSource = modelKeySourceForProvider(currentProvider, currentKeyState);
    setModelConfigDraft(currentDraft);
    setApiKeyDraft('');
    setModelKeySource(currentSource);
    setModelEnvVarDraft(modelEnvVarForProvider(currentProvider, currentKeyState, currentSource));
    setCustomProviderName('');
    setShowSavedModelKey(false);
    setDirtyFields((current) => {
      const next = { ...current };
      delete next.provider;
      delete next.model;
      delete next.baseUrl;
      delete next.modelContextTokens;
      delete next.modelMaxOutputTokens;
      delete next.modelKeySource;
      delete next.modelEnvVar;
      delete next.apiKey;
      return next;
    });
  }, [config, providers, keyStates, modelPresets]);

  return {
    scope,
    setScope,
    scopeInfo,
    saveLabel,
    saveState,
    handleSave,
    handleSaveRuntimeSettings,
    selectPreset,
    handleSaveMonitorSettings,
    handleCancel,
    markDirty,
    dirtyFields,
    modelConfigDraft,
    setModelConfigDraft,
    apiKeyDraft,
    setApiKeyDraft,
    modelKeySource,
    setModelKeySource,
    showSavedModelKey,
    setShowSavedModelKey,
    modelKeyNotice,
    setModelKeyNotice,
    hasSavedModelKey,
    hasConfiguredModelEnvVar,
    modelEnvVarDraft,
    setModelEnvVarDraft,
    modelEnvVarOptions,
    customProviderName,
    setCustomProviderName,
    selectModelProviderDraft,
    loadModelPresetIntoDraft,
    startNewModelPreset,
    ensureCustomProvider,
    handleSaveModelConfig,
    listProviderIconTabs,
    saveProviderIcon,
    handleSetCurrentModelConfig,
    resetModelDraft,
  };
}
