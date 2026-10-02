import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Locale, RunConfig, SecretSource } from '../../config/config.js';
import { RUN_CONFIG_STORAGE_KEY } from '../../config/config.js';
import { t } from '../../shared/i18n.js';
import type { ApiKeyState, ModelPreset, ModelPresetConfig, ProviderEntry } from '../../shared/types.js';
import { RUNTIME_SETTING_KEYS, defaultModelForProvider, modelConfigDraftFromConfig, modelDraftAfterDeletion, saveModelPresetDraft, type ModelConfigDraft, type ModelPresetSaveResult } from '../../components/settings/shared.js';
import type { MonitorSettingsPatch } from '../../components/settings/MonitorPage.js';
import { saveGlobalDefaults } from './settingsClient.js';
import { fetchThreadConfigOverrides, patchThreadConfigOverrides } from '../../api/threadConfigClient.js';
import type { SettingsScope, SettingsScopeInfo, SettingsSaveState } from '../../components/settings/SettingsShell.js';
import { formatSuanliziErrorMessage } from '@suanlizi/protocol';
import { listBrowserTabFavicons, readActiveBrowserTabFavicon } from '../../api/desktopBridge.js';
import { isLegacyGuessedProviderIcon, matchingProviderTabFavicon, type ProviderBrowserTab } from '@suanlizi/protocol';

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
  saveState: SettingsSaveState;
  handleSave: () => void;
  handleSaveRuntimeSettings: () => Promise<void>;
  selectPreset: (presetId: string) => Promise<void>;
  handleSaveMonitorSettings: (patch?: MonitorSettingsPatch) => Promise<void>;
  handleCancel: () => void;
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
  handleSaveModelConfig: (presetId?: string, contextTokens?: number) => Promise<ModelPresetSaveResult | null>;
  listProviderIconTabs: () => Promise<ProviderBrowserTab[]>;
  saveProviderIcon: (providerId: string, iconUrl: string) => Promise<void>;
  resetModelDraft: (deleted?: { providerId: string; model?: string }) => void;
  handleSetCurrentModelConfig: (savedConfig: ModelPresetConfig) => Promise<boolean>;
  saveLabel: string;
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

  const selectedProvider = useMemo(
    () => providers.find((provider) => provider.id === modelConfigDraft.provider),
    [providers, modelConfigDraft.provider],
  );
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

  const modelEnvVarOptions = useMemo(() => [...new Set([
    selectedKeyState?.envVar,
    selectedKeyState?.defaultEnvVar,
    selectedProvider?.apiKeyEnvVar,
    ...(selectedKeyState?.envVarCandidates ?? []),
    ...modelEnvVarRemoteOptions,
  ].filter((value): value is string => Boolean(value?.trim())))], [selectedKeyState, selectedProvider, modelEnvVarRemoteOptions]);

  const scopeInfo: SettingsScopeInfo = useMemo(() => ({
    value: scope,
    onChange: (next) => {
      setScopeState(next);
      setDirtyFields({});
      setSaveError(null);
      setSavedToastAt(null);
    },
    currentThreadAvailable: Boolean(activeThreadId),
  }), [scope, activeThreadId]);

  const saveState: SettingsSaveState = useMemo(() => ({
    dirty: Object.values(dirtyFields).some(Boolean),
    saving,
    error: saveError,
    savedToastAt,
  }), [dirtyFields, saving, saveError, savedToastAt]);

  const markDirty = useCallback((field: string, dirty: boolean) => {
    setDirtyFields((current) => (current[field] === dirty ? current : { ...current, [field]: dirty }));
  }, []);

  const setScope = useCallback((s: SettingsScope) => {
    setScopeState(s);
    setDirtyFields({});
    setSaveError(null);
    setSavedToastAt(null);
  }, []);

  async function hydrateFromServer(targetScope: SettingsScope) {
    try {
      let nextDraft: ModelConfigDraft | null = null;
      if (targetScope === 'global') {
        const response = await fetch('/api/settings');
        if (!response.ok) return;
        const data = (await response.json()) as { config?: Partial<RunConfig> };
        if (data.config) {
          nextDraft = {
            provider: data.config.provider ?? config.provider,
            model: data.config.model ?? config.model,
            baseUrl: data.config.baseUrl ?? config.baseUrl,
            // An omitted server value means automatic detection. Do not fall
            // back to the active thread's model limit in the global editor.
            modelContextTokens: data.config.modelContextTokens,
            modelMaxOutputTokens: data.config.modelMaxOutputTokens,
          };
        }
      } else if (targetScope === 'currentThread' && activeThreadId) {
        const overrides = await fetchThreadConfigOverrides(activeThreadId);
        nextDraft = {
          provider: overrides.provider ?? config.provider,
          model: overrides.model ?? config.model,
          baseUrl: overrides.baseUrl ?? config.baseUrl,
          modelContextTokens: overrides.modelContextTokens ?? config.modelContextTokens,
          modelMaxOutputTokens: overrides.modelMaxOutputTokens ?? config.modelMaxOutputTokens,
        };
      } else if (targetScope === 'newThread') {
        try {
          const stored = window.localStorage.getItem('suanlizi.newThread.config');
          if (stored) {
          const parsed = JSON.parse(stored) as {
            provider?: string;
            model?: string;
            baseUrl?: string;
            modelContextTokens?: number;
            modelMaxOutputTokens?: number;
          };
          nextDraft = {
            provider: parsed.provider ?? config.provider,
            model: parsed.model ?? config.model,
            baseUrl: parsed.baseUrl ?? config.baseUrl,
            modelContextTokens: parsed.modelContextTokens ?? config.modelContextTokens,
            modelMaxOutputTokens: parsed.modelMaxOutputTokens ?? config.modelMaxOutputTokens,
            };
          }
        } catch {
          // silently ignore
        }
      }
      if (nextDraft) {
        const provider = providers.find((item) => item.id === nextDraft.provider);
        const keyState = keyStates.find((state) => state.providerId === nextDraft.provider);
        const nextSource = modelKeySourceForProvider(provider, keyState);
        setModelConfigDraft(nextDraft);
        setModelKeySource(nextSource);
        setModelEnvVarDraft(modelEnvVarForProvider(provider, keyState, nextSource));
      }
      setDirtyFields({});
      setSaveError(null);
    } catch (error) {
      setSaveError(formatSuanliziErrorMessage(undefined, error instanceof Error ? error.message : String(error), locale));
    }
  }

  async function ensureCustomProvider(): Promise<string | null> {
    const existingDraftProvider = providers.find((provider) => provider.id === modelConfigDraft.provider);
    if (modelConfigDraft.provider.startsWith('custom_') && !existingDraftProvider) {
      throw new Error(locale === 'zh' ? '该厂商已删除，请重新选择厂商。' : 'This provider was deleted. Choose another provider.');
    }
    if (modelConfigDraft.provider !== 'openai_compatible') return modelConfigDraft.provider;
    const name = customProviderName.trim();
    if (!name) throw new Error(locale === 'zh' ? '请填写厂商名称。' : 'Vendor name is required.');
    if (name === 'OpenAI-compatible') return modelConfigDraft.provider;
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
  }

  // 设置打开后新页面才加载完图标时，再尝试同线程匹配；不轮询，也不读跨线程 Tab。
  const [iconTabEpoch, setIconTabEpoch] = useState(0);
  useEffect(() => window.suanliziDesktop?.browser?.subscribe?.((event) => {
    if (event?.type === 'favicon' && event.favicon) setIconTabEpoch((value) => value + 1);
  }), []);

  // 已有自定义厂商也能在打开设置时补录：仅匹配当前线程、同站点 Tab。
  useEffect(() => {
    if (!activeThreadId || !providers.some((provider) => provider.id.startsWith('custom_') && (!provider.iconUrl || isLegacyGuessedProviderIcon(provider.baseUrl, provider.iconUrl)))) return;
    let cancelled = false;
    void listBrowserTabFavicons({ threadId: activeThreadId }).then(async (tabs) => {
      let updated = false;
      for (const provider of providers) {
        if (cancelled || !provider.id.startsWith('custom_') || (provider.iconUrl && !isLegacyGuessedProviderIcon(provider.baseUrl, provider.iconUrl))) continue;
        const iconUrl = matchingProviderTabFavicon(provider.baseUrl, tabs);
        if (!iconUrl || iconUrl === provider.iconUrl) continue;
        const response = await fetch(`/api/providers/${encodeURIComponent(provider.id)}`, {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ iconUrl }),
        });
        if (response.ok) updated = true;
      }
      if (updated && !cancelled) await refreshProviders();
    }).catch(() => { /* 浏览器未就绪时保持中性图标，可手动重试。 */ });
    return () => { cancelled = true; };
  }, [activeThreadId, providers, refreshProviders, iconTabEpoch]);

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

  async function saveModelKeyDraftIfNeeded(providerId?: string) {
    if (modelKeySource !== 'config') return;
    const nextKey = apiKeyDraft.trim();
    if (!nextKey) return;
    await saveProviderKey(providerId ?? modelConfigDraft.provider, nextKey);
    const targetProvider = providerId ?? modelConfigDraft.provider;
    setSavedKeyProviders((current) => current.has(targetProvider) ? current : new Set(current).add(targetProvider));
    setApiKeyDraft('');
  }

  async function saveModelEnvVarDraftIfNeeded(providerId?: string) {
    if (modelKeySource !== 'env') return;
    const envVar = modelEnvVarDraft.trim();
    if (!envVar) return;
    await saveProviderEnvVar(providerId ?? modelConfigDraft.provider, envVar);
    const targetProvider = providerId ?? modelConfigDraft.provider;
    setSavedEnvVars((current) => ({ ...current, [targetProvider]: envVar }));
    setModelEnvVarRemoteOptions((current) => current.includes(envVar) ? current : [...current, envVar].sort((a, b) => a.localeCompare(b)));
  }

  async function persistConfig() {
    setSaving(true);
    setSaveError(null);
    try {
      const targetProviderId = await ensureCustomProvider();
      const resolvedProviderId = targetProviderId ?? modelConfigDraft.provider;
      await saveModelKeyDraftIfNeeded(resolvedProviderId);
      await saveModelEnvVarDraftIfNeeded(resolvedProviderId);
      const modelPatch = {
        provider: resolvedProviderId,
        model: modelConfigDraft.model,
        baseUrl: modelConfigDraft.baseUrl || '',
        modelContextTokens: undefined,
        modelMaxOutputTokens: modelConfigDraft.modelMaxOutputTokens,
      };
      const effectiveConfig = { ...config, ...modelPatch };
      if (scope === 'global') {
        await saveGlobalDefaults(effectiveConfig);
        // Keep the global snapshot in sync while a thread override is shown;
        // otherwise a later thread switch can restore the stale local value.
        _saveGlobalModelConfig(effectiveConfig);
      } else if (scope === 'currentThread' && activeThreadId) {
        await patchThreadConfigOverrides(activeThreadId, modelPatch);
        setConfig(effectiveConfig);
      } else if (scope === 'newThread') {
        try {
          window.localStorage.setItem('suanlizi.newThread.config', JSON.stringify(modelPatch));
        } catch {
          // silently ignore
        }
      }
      setDirtyFields({});
      setSavedToastAt(Date.now());
      window.setTimeout(() => setSavedToastAt(null), 2000);
      await Promise.all([refreshProviders(), refreshKeyStates()]);
    } catch (error) {
      setSaveError(formatSuanliziErrorMessage(undefined, error instanceof Error ? error.message : String(error), locale));
    } finally {
      setSaving(false);
    }
  }

  // 运行参数页保存：压缩阈值等字段此前完全没有落盘路径（保存按钮只写模型字段）。
  // 压缩阈值支持线程覆盖；其余是进程级上限，只有全局默认值能表达。
  async function handleSaveRuntimeSettings(): Promise<void> {
    if (saving) return;
    setSaving(true);
    setSaveError(null);
    try {
      const runtimePatch: Partial<RunConfig> = {};
      for (const key of RUNTIME_SETTING_KEYS) {
        const value = config[key];
        if (value !== undefined) (runtimePatch as Record<string, unknown>)[key] = value;
      }
      const { compactionThreshold, ...processWide } = runtimePatch;
      if (scope === 'currentThread' && activeThreadId) {
        if (compactionThreshold !== undefined) {
          await patchThreadConfigOverrides(activeThreadId, { compactionThreshold });
        }
        if (Object.keys(processWide).length > 0) await saveGlobalDefaults(processWide);
      } else if (scope === 'newThread') {
        if (compactionThreshold !== undefined) {
          const stored = window.localStorage.getItem(RUN_CONFIG_STORAGE_KEY);
          const base = stored ? JSON.parse(stored) as Partial<RunConfig> : {};
          window.localStorage.setItem(RUN_CONFIG_STORAGE_KEY, JSON.stringify({ ...base, compactionThreshold }));
        }
        if (Object.keys(processWide).length > 0) await saveGlobalDefaults(processWide);
      } else {
        await saveGlobalDefaults(runtimePatch);
      }
      setConfig((current) => ({ ...current, ...runtimePatch }));
      for (const key of RUNTIME_SETTING_KEYS) markDirty(String(key), false);
      setSavedToastAt(Date.now());
      window.setTimeout(() => setSavedToastAt(null), 2000);
    } catch (error) {
      setSaveError(formatSuanliziErrorMessage(undefined, error instanceof Error ? error.message : String(error), locale));
    } finally {
      setSaving(false);
    }
  }

  const handleSave = useCallback(() => {
    // 模型只通过新建/编辑弹窗提交；设置外壳的旧保存入口不再写模型。
  }, []);

  // 选择预设即生效：切换后立刻写入当前作用域。
  async function selectPreset(presetId: string) {
    const preset = modelPresets.find((item) => item.id === presetId);
    if (!preset) return;
    loadModelPresetIntoDraft(presetId);
    const modelPatch = {
      provider: preset.config.provider.trim(),
      model: preset.config.model.trim(),
      baseUrl: (preset.config.baseUrl || '').trim(),
      modelContextTokens: preset.config.modelContextTokens,
      modelMaxOutputTokens: preset.config.modelMaxOutputTokens,
    };
    try {
      setSaving(true);
      if (scope === 'global') {
        await saveGlobalDefaults({ ...config, ...modelPatch });
        _saveGlobalModelConfig({ ...config, ...modelPatch });
      } else if (scope === 'currentThread' && activeThreadId) {
        await patchThreadConfigOverrides(activeThreadId, modelPatch);
        setConfig({ ...config, ...modelPatch });
      } else {
        window.localStorage.setItem('suanlizi.newThread.config', JSON.stringify(modelPatch));
      }
      setSavedToastAt(Date.now());
      window.setTimeout(() => setSavedToastAt(null), 2000);
    } catch (error) {
      setModelKeyNotice(formatSuanliziErrorMessage(undefined, error instanceof Error ? error.message : String(error), locale));
    } finally {
      setSaving(false);
    }
  }

  function handleCancel() {
    onClose?.();
  }

  function selectModelProviderDraft(providerId: string) {
    const normalizedProviderId = providerId === 'doubao' ? 'volcengine' : providerId;
    const provider = providers.find((item) => item.id === normalizedProviderId);
    setModelConfigDraft((current) => ({
      ...current,
      provider: normalizedProviderId,
      model: defaultModelForProvider(provider, current.model),
      baseUrl: providerId === 'openai_compatible' ? '' : (provider?.baseUrl ?? current.baseUrl),
      // The selected endpoint is authoritative. Clear the old model's
      // window so the server can probe the actual limit.
      modelContextTokens: undefined,
      modelMaxOutputTokens: undefined,
    }));
    if (normalizedProviderId !== 'openai_compatible') {
      setCustomProviderName('');
    }
    markDirty('provider', true);
    markDirty('model', true);
    markDirty('baseUrl', true);
    markDirty('modelContextTokens', false);
    markDirty('modelMaxOutputTokens', true);
    setApiKeyDraft('');
    setShowSavedModelKey(false);
    const keyState = keyStates.find((state) => state.providerId === normalizedProviderId);
    const nextSource = modelKeySourceForProvider(provider, keyState);
    setModelKeySource(nextSource);
    setModelEnvVarDraft(modelEnvVarForProvider(provider, keyState, nextSource));
  }

  function loadModelPresetIntoDraft(presetId: string) {
    if (presetId === '__draft__' || presetId === '__new__') return;
    const preset = modelPresets.find((item) => item.id === presetId);
    if (!preset) return;
    setModelConfigDraft((current) => ({
      ...current,
      provider: (preset.config.provider ?? current.provider).trim(),
      model: (preset.config.model ?? current.model).trim(),
      baseUrl: (preset.config.baseUrl ?? current.baseUrl).trim(),
      modelContextTokens: preset.config.modelContextTokens,
      modelMaxOutputTokens: preset.config.modelMaxOutputTokens,
    }));
    const providerId = preset.config.provider.trim();
    const provider = providers.find((item) => item.id === providerId);
    const keyState = keyStates.find((state) => state.providerId === providerId);
    const nextSource = modelKeySourceForProvider(provider, keyState);
    setModelKeySource(nextSource);
    setModelEnvVarDraft(modelEnvVarForProvider(provider, keyState, nextSource));
    // A preset load establishes a clean baseline. Never carry a secret draft
    // or provider-specific text from the previously selected preset.
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
  }

  function startNewModelPreset() {
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
  }

  async function handleSaveModelConfig(presetId?: string, contextTokens?: number): Promise<ModelPresetSaveResult | null> {
    const saved = await saveModelPresetDraft({
    requestName: () => {
      // 名称始终由真实厂商名 + 模型推导，绝不暴露 openai_compatible；
      // 新建时自动去重，不再弹命名框。
      const provider = providers.find((item) => item.id === modelConfigDraft.provider);
      const providerName = provider?.name
        ?? customProviderName.trim()
        ?? modelConfigDraft.provider.replace(/^custom_/, '').replace(/_/g, '.');
      const base = [providerName, modelConfigDraft.model.trim()].filter(Boolean).join(' / ') || 'Model preset';
      const existing = presetId ? modelPresets.find((preset) => preset.id === presetId) : undefined;
      if (existing) return Promise.resolve(existing.name);
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
        baseUrl: (modelConfigDraft.baseUrl || '').trim(),
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
    await Promise.all([refreshProviders(), refreshKeyStates()]);
    markDirty('provider', false);
    markDirty('model', false);
    markDirty('baseUrl', false);
    markDirty('modelContextTokens', false);
    markDirty('modelMaxOutputTokens', false);
    markDirty('apiKey', false);
    markDirty('modelEnvVar', false);
    markDirty('modelKeySource', false);
    return saved;
  }

  function resetModelDraft(deleted?: { providerId: string; model?: string }) {
    const currentDraft = modelDraftAfterDeletion(modelConfigDraftFromConfig(config), providers, modelPresets, deleted);
    const currentProvider = providers.find((provider) => provider.id === currentDraft.provider);
    const currentKeyState = keyStates.find((state) => state.providerId === currentDraft.provider);
    const currentSource = modelKeySourceForProvider(currentProvider, currentKeyState);
    setModelConfigDraft(currentDraft);
    setCustomProviderName('');
    setApiKeyDraft('');
    setModelKeySource(currentSource);
    setModelEnvVarDraft(modelEnvVarForProvider(currentProvider, currentKeyState, currentSource));
    setShowSavedModelKey(false);
    setModelKeyNotice('');
    setDirtyFields((current) => {
      const next = { ...current };
      for (const field of ['provider', 'model', 'baseUrl', 'modelContextTokens', 'modelMaxOutputTokens', 'apiKey', 'modelEnvVar', 'modelKeySource']) delete next[field];
      return next;
    });
  }

  async function handleSetCurrentModelConfig(savedConfig: ModelPresetConfig): Promise<boolean> {
    setSaving(true);
    setSaveError(null);
    setModelKeyNotice('');
    try {
      // 模型预设已经在 handleSaveModelConfig 中完成厂商、密钥和预设持久化。
      // 这里仅把同一份已保存配置应用到当前作用域，禁止第二次注册/保存。
      const modelPatch = {
        provider: savedConfig.provider.trim(),
        model: savedConfig.model.trim(),
        baseUrl: (savedConfig.baseUrl || '').trim(),
        modelContextTokens: savedConfig.modelContextTokens,
        modelMaxOutputTokens: savedConfig.modelMaxOutputTokens,
      };
      const effectiveConfig = { ...config, ...modelPatch };
      if (scope === 'global') {
        await saveGlobalDefaults(effectiveConfig);
        _saveGlobalModelConfig(effectiveConfig);
      } else if (scope === 'currentThread' && activeThreadId) {
        await patchThreadConfigOverrides(activeThreadId, modelPatch);
        setConfig(effectiveConfig);
      } else if (scope === 'newThread') {
        try {
          window.localStorage.setItem('suanlizi.newThread.config', JSON.stringify(modelPatch));
        } catch {
          // silently ignore
        }
      }
      setDirtyFields((current) => {
        const next = { ...current };
        for (const field of ['provider', 'model', 'baseUrl', 'modelContextTokens', 'modelMaxOutputTokens', 'apiKey', 'modelEnvVar', 'modelKeySource']) delete next[field];
        return next;
      });
      setSavedToastAt(Date.now());
      window.setTimeout(() => setSavedToastAt(null), 2000);
      await Promise.all([refreshProviders(), refreshKeyStates()]);
      return true;
    } catch (error) {
      const message = formatSuanliziErrorMessage(undefined, error instanceof Error ? error.message : String(error), locale);
      setSaveError(message);
      setModelKeyNotice(message);
      return false;
    } finally {
      setSaving(false);
    }
  }

  async function handleSaveMonitorSettings(patch: MonitorSettingsPatch = {}) {
    if (saving) return;
    setSaving(true);
    setSaveError(null);
    try {
      // Monitor controls are global runtime settings, independent from the
      // model draft currently shown on the agent settings page.
      const samplingEnabled = patch.systemMonitorSamplingEnabled ?? config.systemMonitorSamplingEnabled;
      const monitorPatch = {
        monitorPanelVisible: patch.monitorPanelVisible ?? config.monitorPanelVisible,
        systemMonitorEnabled: samplingEnabled,
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
      window.setTimeout(() => setSavedToastAt(null), 2000);
    } catch (error) {
      setSaveError(formatSuanliziErrorMessage(undefined, error instanceof Error ? error.message : String(error), locale));
    } finally {
      setSaving(false);
    }
  }

  useEffect(() => {
    // Global settings are hydrated from /api/settings below. Re-syncing from
    // the effective config here would reintroduce an active thread override.
    if (scope === 'global') return;
    setModelConfigDraft(modelConfigDraftFromConfig(config));
  }, [config.provider, config.model, config.baseUrl, config.modelContextTokens, config.modelMaxOutputTokens, scope]);

  useEffect(() => {
    if (dirtyFields.modelKeySource || dirtyFields.modelEnvVar || dirtyFields.apiKey) return;
    if (modelKeySource === 'config' && savedKeyProviders.has(modelConfigDraft.provider)) return;
    if (modelKeySource === 'env' && savedEnvVars[modelConfigDraft.provider]) return;
    const nextSource = modelKeySourceForProvider(selectedProvider, selectedKeyState);
    setModelKeySource(nextSource);
    setModelEnvVarDraft(modelEnvVarForProvider(selectedProvider, selectedKeyState, nextSource));
    setApiKeyDraft('');
    setShowSavedModelKey(false);
    setModelKeyNotice('');
  }, [
    modelConfigDraft.provider,
    selectedKeyState?.envVar,
    selectedKeyState?.source,
    selectedProvider?.apiKeyEnvVar,
    selectedProvider?.isLocal,
    modelKeySource,
    savedKeyProviders,
    savedEnvVars,
    dirtyFields.modelKeySource,
    dirtyFields.modelEnvVar,
    dirtyFields.apiKey,
  ]);

  useEffect(() => {
    fetch('/api/keys/env-vars')
      .then((response) => response.ok ? response.json() : null)
      .then((data: { envVars?: string[] } | null) => setModelEnvVarRemoteOptions(data?.envVars ?? []))
      .catch(() => setModelEnvVarRemoteOptions([]));
  }, []);

  useEffect(() => {
    void hydrateFromServer(scope);
  }, [scope, activeThreadId]);

  const saveLabel = useMemo(() => t(locale, 'save'), [locale]);

  return {
    scope,
    setScope,
    scopeInfo,
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
    handleSaveModelConfig,
    listProviderIconTabs,
    saveProviderIcon,
    resetModelDraft,
    handleSetCurrentModelConfig,
    saveLabel,
  };
}
