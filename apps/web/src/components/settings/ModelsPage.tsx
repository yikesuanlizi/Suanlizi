// 设置面板：模型页（provider、API key、model preset、env var）
// P3：按设置工作台样例结构组织：page header + section + chip + form-grid
import React from 'react';
import { createPortal } from 'react-dom';
import type { Locale, SecretSource, RunConfig } from '../../config/config.js';
import { assignedModelContextTokens, isGuessedProviderIcon, matchingProviderTabFavicon, modelContextReferenceFor, validProviderIconUrl, type ModelContextReference, type ModelPresetConfig, type ProviderBrowserTab } from '@suanlizi/protocol';
import type { ApiKeyState, ModelPreset, ProviderEntry } from '../../shared/types.js';
import { t } from '../../shared/i18n.js';
import { Icon } from '../Icon.js';
import { ModelBrandIcon } from '../ModelBrandIcon.js';
import { DropdownSelect, type DropdownOption } from '../DropdownSelect.js';
import { ConfirmPanel } from './ConfirmPanel.js';
import { fetchModelContextReferences } from '../../api/modelContextReferencesClient.js';
import { fetchProviderModels } from '../../api/providerModelsClient.js';
import { mergeModelSuggestions } from '../../features/settings/modelSuggestions.js';
import { ModelContextReferencesPanel } from './ModelContextReferencesPanel.js';
import { SettingsPageHeader } from './SettingsPageHeader.js';
import { SectionHeader } from './SectionHeader.js';
import { modelPresetDisplayName, modelPresetMatchesRunConfig, normalizeModelConfigDraftForSettings, providerDropdownOptions, type ModelConfigDraft, type ModelPresetSaveResult } from './shared.js';

export interface ModelsPageProps {
  locale: Locale;
  config: RunConfig;
  modelConfigDraft: ModelConfigDraft;
  setModelConfigDraft: React.Dispatch<React.SetStateAction<ModelConfigDraft>>;
  providers: ProviderEntry[];
  keyStates: ApiKeyState[];
  modelPresets: ModelPreset[];
  deleteModelPreset: (presetId: string) => Promise<void>;
  deleteCustomProvider: (providerId: string) => Promise<void>;
  listProviderIconTabs: () => Promise<ProviderBrowserTab[]>;
  saveProviderIcon: (providerId: string, iconUrl: string) => Promise<void>;
  apiKeyDraft: string;
  setApiKeyDraft: React.Dispatch<React.SetStateAction<string>>;
  modelKeySource: SecretSource;
  setModelKeySource: React.Dispatch<React.SetStateAction<SecretSource>>;
  showSavedModelKey: boolean;
  setShowSavedModelKey: React.Dispatch<React.SetStateAction<boolean>>;
  modelKeyNotice: string;
  setModelKeyNotice: React.Dispatch<React.SetStateAction<string>>;
  hasSavedModelKey: boolean;
  hasConfiguredModelEnvVar: boolean;
  modelEnvVarDraft: string;
  setModelEnvVarDraft: React.Dispatch<React.SetStateAction<string>>;
  modelEnvVarOptions: string[];
  customProviderName: string;
  setCustomProviderName: React.Dispatch<React.SetStateAction<string>>;
  selectModelProviderDraft: (providerId: string) => void;
  loadModelPresetIntoDraft: (presetId: string) => void;
  selectPreset: (presetId: string) => Promise<void>;
  startNewModelPreset: () => void;
  handleSaveModelConfig: (presetId?: string, contextTokens?: number) => Promise<ModelPresetSaveResult | null>;
  handleSetCurrentModelConfig: (savedConfig: ModelPresetConfig) => Promise<boolean>;
  onReset: (deleted?: { providerId: string; model?: string }) => void;
  markDirty: (field: string, dirty: boolean) => void;
  dirtyFields: Record<string, boolean>;
}

function imageLoads(url: string): Promise<boolean> {
  return new Promise((resolve) => {
    const image = new Image();
    image.referrerPolicy = 'no-referrer';
    const timer = window.setTimeout(() => finish(false), 5000);
    function finish(loaded: boolean) {
      window.clearTimeout(timer);
      image.onload = null;
      image.onerror = null;
      resolve(loaded);
    }
    image.onload = () => finish(true);
    image.onerror = () => finish(false);
    image.src = url;
  });
}

export function ModelsPage({
  locale,
  config,
  modelConfigDraft,
  setModelConfigDraft,
  providers,
  keyStates,
  modelPresets,
  deleteModelPreset,
  deleteCustomProvider,
  listProviderIconTabs,
  saveProviderIcon,
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
  selectPreset,
  startNewModelPreset,
  handleSaveModelConfig,
  handleSetCurrentModelConfig,
  onReset,
  markDirty,
  dirtyFields,
}: ModelsPageProps) {
  const selectedProvider = providers.find((provider) => provider.id === modelConfigDraft.provider);
  const selectedKeyState = keyStates.find((state) => state.providerId === modelConfigDraft.provider);
  // 下拉框直接使用真实 provider id：已注册的自定义厂商显示自己的名字，
  // 只有选择通用项时才进入“新建自定义厂商”的状态。
  const providerSelectValue = modelConfigDraft.provider;
  const isNewCustomVendor = providerSelectValue === 'openai_compatible';
  const displayedCustomProviderName = customProviderName || (isNewCustomVendor ? '' : (selectedProvider?.name ?? ''));
  const matchedCurrentPreset = modelPresets.find((preset) => modelPresetMatchesRunConfig(preset, config));
  const groupedPresets = Array.from(modelPresets.reduce((groups, preset) => {
    const providerId = preset.config.provider;
    const existing = groups.get(providerId) ?? [];
    existing.push(preset);
    groups.set(providerId, existing);
    return groups;
  }, new Map<string, ModelPreset[]>()).entries()).map(([providerId, presets]) => ({ providerId, presets }));
  const modelListId = React.useId();
  const availableProviders = providers.filter((provider) => !provider.id.startsWith('custom_') || modelPresets.some((preset) => preset.config.provider === provider.id));
  const presetModels = modelPresets.filter((preset) => preset.config.provider === modelConfigDraft.provider)
    .map((preset) => preset.config.model);
  const [providerModels, setProviderModels] = React.useState<{ provider: string; baseUrl: string; models: string[] } | null>(null);
  const [providerModelsError, setProviderModelsError] = React.useState(false);
  const [referenceEntries, setReferenceEntries] = React.useState<ModelContextReference[] | null>(null);
  const [referenceEditorOpen, setReferenceEditorOpen] = React.useState(false);
  const modelSuggestions = mergeModelSuggestions({
    presetModels,
    remoteModels: providerModels?.models,
    remoteReady: providerModels?.provider === modelConfigDraft.provider
      && providerModels?.baseUrl === modelConfigDraft.baseUrl && !providerModelsError,
  });
  React.useEffect(() => {
    const controller = new AbortController();
    void fetchModelContextReferences(controller.signal).then((entries) => {
      if (!controller.signal.aborted) setReferenceEntries(entries);
    }).catch(() => { /* 保持未加载：提交时重试读取，避免把离线内置值当成已保存列表。 */ });
    return () => controller.abort();
  }, []);
  const selectedReference = modelContextReferenceFor(referenceEntries ?? [], modelConfigDraft.model);
  const [deletingPresetId, setDeletingPresetId] = React.useState('');
  const [pendingDeletePreset, setPendingDeletePreset] = React.useState<ModelPreset | null>(null);
  const [pendingDeleteProvider, setPendingDeleteProvider] = React.useState<string | null>(null);
  const [busyAction, setBusyAction] = React.useState(false);
  const [iconEditorProvider, setIconEditorProvider] = React.useState<ProviderEntry | null>(null);
  const [iconDraft, setIconDraft] = React.useState('');
  const [iconTabs, setIconTabs] = React.useState<ProviderBrowserTab[]>([]);
  const [iconError, setIconError] = React.useState('');
  const [iconSaving, setIconSaving] = React.useState(false);
  const iconRequestRef = React.useRef(0);
  const iconSaveLockRef = React.useRef(false);
  // React state 在同一事件循环内不能可靠拦住双击；同步锁保证一次提交只有一条保存链。
  const submitLockRef = React.useRef(false);
  // 保存成功后记住 preset id；应用失败重试时更新原记录，不再新建重复项。
  const persistedPresetIdRef = React.useRef<string | undefined>(undefined);

  const envVarName = modelEnvVarDraft.trim() || selectedProvider?.apiKeyEnvVar || selectedKeyState?.envVar || '';
  const credentialStatus = modelKeySource === 'env'
    ? (!envVarName ? 'missing-name' : !hasConfiguredModelEnvVar ? 'missing-env' : 'ok')
    : (!hasSavedModelKey ? 'missing-key' : 'ok');

  function savedModelKeyPlaceholder() {
    if (!hasSavedModelKey) return locale === 'zh' ? '未保存密钥' : 'No saved key';
    if (showSavedModelKey) return selectedKeyState?.masked ?? (locale === 'zh' ? '已保存密钥' : 'Saved key');
    return '••••••••••••••••';
  }

  const providerDirty = dirtyFields.provider ? 'fieldDirty' : '';
  const modelDirty = dirtyFields.model ? 'fieldDirty' : '';
  const baseUrlDirty = dirtyFields.baseUrl ? 'fieldDirty' : '';
  const envVarDirty = dirtyFields.modelEnvVar ? 'fieldDirty' : '';

  // 模型只有“新建/编辑/删除”；面板关闭不会自动保存，也没有草稿回写链。
  const [isCreating, setIsCreating] = React.useState(false);
  const [editingPresetId, setEditingPresetId] = React.useState<string | null>(null);
  const panelOpen = isCreating || editingPresetId !== null;
  const contextProbeKey = JSON.stringify([
    modelConfigDraft.provider.trim(), modelConfigDraft.model.trim(), modelConfigDraft.baseUrl.trim(),
  ]);
  const [contextInputDraft, setContextInputDraft] = React.useState<string | null>(null);
  const [contextProbe, setContextProbe] = React.useState<{
    key: string; contextTokens?: number; source?: 'server' | 'model' | 'unavailable'; pending: boolean;
  } | null>(null);
  React.useEffect(() => {
    if (!panelOpen || !modelConfigDraft.provider.trim() || !modelConfigDraft.model.trim()) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setContextProbe({ key: contextProbeKey, pending: true });
      const timeout = window.setTimeout(() => controller.abort(), 12_000);
      void fetch('/api/model-capabilities', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: modelConfigDraft.provider.trim(), model: modelConfigDraft.model.trim(), baseUrl: modelConfigDraft.baseUrl.trim() }),
        signal: controller.signal,
      }).then(async (response) => {
        if (!response.ok) throw new Error('probe failed');
        return response.json() as Promise<{ contextTokens?: number; source?: 'server' | 'model' | 'unavailable' }>;
      }).then((result) => {
        if (!controller.signal.aborted) setContextProbe({ key: contextProbeKey, contextTokens: result.contextTokens, source: result.source, pending: false });
      }).catch(() => {
        if (!controller.signal.aborted) setContextProbe({ key: contextProbeKey, source: 'unavailable', pending: false });
      }).finally(() => window.clearTimeout(timeout));
    }, 350);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [panelOpen, contextProbeKey]);
  const activeContextProbe = contextProbe?.key === contextProbeKey ? contextProbe : null;
  const probeContextTokens = activeContextProbe?.source === 'server' || activeContextProbe?.source === 'model'
    ? activeContextProbe.contextTokens : undefined;
  const displayedContextTokens = modelConfigDraft.modelContextTokens ?? probeContextTokens ?? selectedReference?.contextTokens;
  const contextSourceLabel = modelConfigDraft.modelContextTokens ? (locale === 'zh' ? '此模型配置' : 'This model')
    : activeContextProbe?.source === 'server' ? (locale === 'zh' ? '服务端' : 'Server')
      : activeContextProbe?.source === 'model' ? (locale === 'zh' ? '已知模型' : 'Known model')
        : selectedReference ? (locale === 'zh' ? '参考值' : 'Reference')
          : (locale === 'zh' ? '未识别' : 'Unknown');

  React.useEffect(() => {
    if (!panelOpen || !modelConfigDraft.provider.trim()) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setProviderModels(null);
      setProviderModelsError(false);
      fetchProviderModels({
        provider: modelConfigDraft.provider,
        baseUrl: modelConfigDraft.baseUrl,
      }, controller.signal).then((result) => {
        if (!controller.signal.aborted) {
          setProviderModels({ provider: result.provider, baseUrl: modelConfigDraft.baseUrl, models: result.models });
        }
      }).catch(() => {
        if (!controller.signal.aborted) setProviderModelsError(true);
      });
    }, 350);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [panelOpen, modelConfigDraft.provider, modelConfigDraft.baseUrl]);


  function beginCreate(providerId?: string) {
    if (submitLockRef.current) return;
    persistedPresetIdRef.current = undefined;
    setContextProbe(null);
    setContextInputDraft(null);
    setIsCreating(true);
    setEditingPresetId(null);
    setCustomProviderName('');
    setModelKeyNotice('');
    startNewModelPreset();
    if (providerId) {
      selectModelProviderDraft(providerId);
      const provider = providers.find((item) => item.id === providerId);
      setModelConfigDraft((current) => ({ ...current, provider: providerId, model: '', baseUrl: provider?.baseUrl ?? '', modelContextTokens: undefined }));
    }
  }

  function beginEdit(preset: ModelPreset) {
    if (submitLockRef.current) return;
    persistedPresetIdRef.current = preset.id;
    setContextProbe(null);
    setContextInputDraft(null);
    setIsCreating(false);
    setEditingPresetId(preset.id);
    loadModelPresetIntoDraft(preset.id);
    setModelKeyNotice('');
  }

  function closePanel(force = false) {
    if (!force && submitLockRef.current) return;
    setIsCreating(false);
    setEditingPresetId(null);
    setContextInputDraft(null);
    persistedPresetIdRef.current = undefined;
    setModelKeyNotice('');
  }

  async function submitPanel() {
    if (submitLockRef.current || busyAction) return;
    if (!modelConfigDraft.provider.trim() || !modelConfigDraft.model.trim()) {
      setModelKeyNotice(locale === 'zh' ? '请填写模型提供方与模型名称。' : 'Provider and model are required.');
      return;
    }
    if (modelConfigDraft.modelContextTokens !== undefined
      && (!Number.isSafeInteger(modelConfigDraft.modelContextTokens) || modelConfigDraft.modelContextTokens < 1 || modelConfigDraft.modelContextTokens > 100_000_000)) {
      setModelKeyNotice(locale === 'zh' ? '上下文长度必须是 1 至 100000000 的整数。' : 'Context length must be an integer from 1 to 100000000.');
      return;
    }
    if (isNewCustomVendor && !customProviderName.trim()) {
      setModelKeyNotice(locale === 'zh' ? '请填写厂商名称。' : 'Vendor name is required.');
      return;
    }
    submitLockRef.current = true;
    setBusyAction(true);
    try {
      let probe = activeContextProbe?.pending ? null : activeContextProbe;
      if (!modelConfigDraft.modelContextTokens && !probe) {
        try {
          const response = await fetch('/api/model-capabilities', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ provider: modelConfigDraft.provider.trim(), model: modelConfigDraft.model.trim(), baseUrl: modelConfigDraft.baseUrl.trim() }),
            signal: AbortSignal.timeout(12_000),
          });
          if (response.ok) probe = await response.json() as typeof activeContextProbe;
        } catch { /* 端点不可用时只允许显式参考或手动配置，不猜测模型上限。 */ }
      }
      let references = referenceEntries;
      if (references === null) {
        try { references = await fetchModelContextReferences(); setReferenceEntries(references); }
        catch { references = []; }
      }
      const assignedContext = assignedModelContextTokens({
        model: modelConfigDraft.model, configured: modelConfigDraft.modelContextTokens,
        probe: probe ?? undefined, references,
      });
      const saved = await handleSaveModelConfig(persistedPresetIdRef.current, assignedContext);
      if (!saved) return;
      if (saved.id) persistedPresetIdRef.current = saved.id;
      const applied = await handleSetCurrentModelConfig(saved.config);
      if (applied) closePanel(true);
    } catch (error) {
      setModelKeyNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setBusyAction(false);
      submitLockRef.current = false;
    }
  }

  async function handleDeletePreset() {
    if (!pendingDeletePreset) return;
    try {
      setDeletingPresetId(pendingDeletePreset.id);
      await deleteModelPreset(pendingDeletePreset.id);
      // 删除后回落到仍然存在的预设或当前生效配置，绝不留下半截状态。
      const remaining = modelPresets.filter((preset) => preset.id !== pendingDeletePreset.id);
      const fallback = remaining.find((preset) => modelPresetMatchesRunConfig(preset, config)) ?? remaining[0];
      if (fallback) loadModelPresetIntoDraft(fallback.id);
      else onReset({ providerId: pendingDeletePreset.config.provider, model: pendingDeletePreset.config.model });
      setPendingDeletePreset(null);
    } catch (error) {
      setModelKeyNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setDeletingPresetId('');
    }
  }
  async function handleDeleteProvider() {
    if (!pendingDeleteProvider) return;
    setBusyAction(true);
    try {
      await deleteCustomProvider(pendingDeleteProvider);
      if (modelConfigDraft.provider === pendingDeleteProvider) onReset({ providerId: pendingDeleteProvider });
      setPendingDeleteProvider(null);
    } catch (error) {
      setModelKeyNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setBusyAction(false);
    }
  }

  async function openIconEditor(provider: ProviderEntry) {
    const request = ++iconRequestRef.current;
    setIconEditorProvider(provider);
    setIconDraft(provider.iconUrl ?? '');
    setIconTabs([]);
    setIconError('');
    try {
      const tabs = await listProviderIconTabs();
      if (request !== iconRequestRef.current) return;
      setIconTabs(tabs);
      // 匹配 API 站点的 Tab 可以预填；跨站点图标必须由用户亲自点击选择。
      if (!provider.iconUrl || isGuessedProviderIcon(provider.baseUrl, provider.iconUrl)) {
        const matched = matchingProviderTabFavicon(provider.baseUrl, tabs);
        if (matched) setIconDraft(matched);
      }
    } catch {
      if (request === iconRequestRef.current) setIconError(locale === 'zh' ? '读取浏览器 Tab 失败，可手动填写图标地址。' : 'Could not read browser tabs. Enter an icon URL.');
    }
  }

  function closeIconEditor() {
    ++iconRequestRef.current;
    setIconEditorProvider(null);
  }

  async function submitIcon() {
    if (!iconEditorProvider || iconSaveLockRef.current) return;
    const url = iconDraft.trim();
    if (url && !validProviderIconUrl(url)) {
      setIconError(locale === 'zh' ? '请输入 HTTPS 图片地址或受支持的图片 data URL。' : 'Enter an HTTPS image URL or a supported image data URL.');
      return;
    }
    iconSaveLockRef.current = true;
    setIconSaving(true);
    setIconError('');
    try {
      if (url && !(await imageLoads(url))) {
        setIconError(locale === 'zh' ? '图标无法加载，请填写网页实际使用的图标地址。' : 'Icon cannot be loaded. Enter the URL used by the website.');
        return;
      }
      await saveProviderIcon(iconEditorProvider.id, url);
      closeIconEditor();
    } catch (error) {
      setIconError(error instanceof Error ? error.message : String(error));
    } finally {
      iconSaveLockRef.current = false;
      setIconSaving(false);
    }
  }

  // 弹窗挂载到 settingsLayer：脱离设置内容区的滚动裁剪，保证阴影完整。
  const editorPortalTarget = panelOpen && typeof document !== 'undefined'
    ? (document.querySelector('.settingsLayer') ?? document.body)
    : null;

  return (
    <section className="settingsSection modelSettingsPanel" id="settings-models">
      <SettingsPageHeader
        title={locale === 'zh' ? '模型' : 'Model'}
        actions={[{
          label: locale === 'zh' ? '上下文参考' : 'Context references',
          icon: <Icon name="fileText" />,
          title: locale === 'zh' ? '编辑上下文参考' : 'Edit context references',
          disabled: busyAction,
          onClick: () => setReferenceEditorOpen(true),
        }, {
          label: locale === 'zh' ? '新建模型配置' : 'New model configuration',
          icon: <Icon name="plus" />,
          primary: true,
          disabled: busyAction,
          onClick: () => beginCreate(),
        }]}
      />

      {panelOpen ? createPortal((
        <div className="modelEditorLayer" role="presentation">
          <button className="modelEditorScrim" aria-label={locale === 'zh' ? '取消' : 'Cancel'} onClick={() => closePanel()} type="button" disabled={busyAction} />
          <div className="modelEditorPanel" role="dialog" aria-modal="true" aria-label={isCreating ? (locale === 'zh' ? '新建模型配置' : 'New model configuration') : (locale === 'zh' ? '修改模型配置' : 'Edit model configuration')}>
            <header className="modelEditorHeader">
              <h3>{isCreating ? (locale === 'zh' ? '新建模型配置' : 'New model configuration') : (locale === 'zh' ? '修改模型配置' : 'Edit model configuration')}</h3>
              <button className="miniIconButton" type="button" title={locale === 'zh' ? '关闭' : 'Close'} aria-label={locale === 'zh' ? '关闭' : 'Close'} onClick={() => closePanel()} disabled={busyAction}>
                <Icon name="x" />
              </button>
            </header>

          <div className="settingsFormGrid three modelEditorFormFrame">
            <label className="settingsField">
              <span className="settingsFieldLabel">{t(locale, 'provider')}</span>
              <DropdownSelect
                className={['modelProviderSelect', providerDirty].filter(Boolean).join(' ')}
                value={providerSelectValue}
                onChange={selectModelProviderDraft}
                options={providerDropdownOptions(availableProviders, locale)}
              />
            </label>
            {isNewCustomVendor ? (
              <label className="settingsField">
                <span className="settingsFieldLabel">{locale === 'zh' ? '厂商名称' : 'Vendor name'}</span>
                <input
                  placeholder={locale === 'zh' ? '例如：ai.gitee、OpenRouter、LMStudio' : 'e.g. ai.gitee, OpenRouter, LMStudio'}
                  value={displayedCustomProviderName}
                  onChange={(event) => { setCustomProviderName(event.target.value); markDirty('provider', true); }}
                />
              </label>
            ) : null}
            <label className={['settingsField', modelDirty].filter(Boolean).join(' ')}>
              <span className="settingsFieldLabel">{t(locale, 'model')}</span>
              <input
                list={modelListId}
                value={modelConfigDraft.model}
                onChange={(event) => {
                  setContextInputDraft(null);
                  setModelConfigDraft((current) => ({ ...current, model: event.target.value, modelContextTokens: undefined }));
                  markDirty('model', true);
                  markDirty('modelContextTokens', false);
                }}
              />
              <datalist id={modelListId}>{modelSuggestions.map((name) => <option key={name} value={name} />)}</datalist>
            </label>
            <label className={['settingsField', baseUrlDirty].filter(Boolean).join(' ')}>
              <span className="settingsFieldLabel">{t(locale, 'baseUrl')}</span>
              <input
                placeholder="provider default"
                value={modelConfigDraft.baseUrl}
                onChange={(event) => {
                  setModelConfigDraft((current) => ({ ...current, baseUrl: event.target.value }));
                  markDirty('baseUrl', true);
                }}
              />
            </label>
            <label className="settingsField modelContextField">
              <span className="settingsFieldLabel">
                {locale === 'zh' ? '上下文长度' : 'Context length'}
                <span className="modelContextSource">{contextSourceLabel}</span>
              </span>
              <span className="modelContextInputWrap">
                <input aria-label={locale === 'zh' ? '此模型的上下文长度' : 'Context length for this model'} type="number" min="1" max="100000000" step="1"
                  placeholder={activeContextProbe?.pending ? (locale === 'zh' ? '识别中…' : 'Detecting…') : (locale === 'zh' ? '未识别' : 'Unknown')}
                  value={contextInputDraft ?? displayedContextTokens ?? ''}
                  onChange={(event) => {
                    setContextInputDraft(event.target.value);
                    const value = event.target.value === '' ? undefined : Number(event.target.value);
                    setModelConfigDraft((current) => ({ ...current, modelContextTokens: value }));
                    markDirty('modelContextTokens', true);
                  }} onBlur={() => { if (contextInputDraft === '') setContextInputDraft(null); }} />
              </span>
            </label>
            <label className="settingsField">
              <span className="settingsFieldLabel">{locale === 'zh' ? '密钥来源' : 'Key source'}</span>
              <DropdownSelect<SecretSource>
                value={modelKeySource}
                onChange={(source) => {
                  markDirty('modelKeySource', true);
                  setModelKeySource(source);
                  if (source === 'env' && !modelEnvVarDraft.trim()) {
                    setModelEnvVarDraft(selectedKeyState?.envVar || selectedProvider?.apiKeyEnvVar || '');
                  }
                  setApiKeyDraft('');
                  setShowSavedModelKey(false);
                }}
                options={[
                  { value: 'env', label: locale === 'zh' ? '环境变量' : 'Environment' },
                  { value: 'config', label: locale === 'zh' ? '已保存密钥' : 'Saved key' },
                ]}
              />
            </label>
            {modelKeySource === 'env' ? (
              <label className={['settingsField', envVarDirty].filter(Boolean).join(' ')}>
                <span className="settingsFieldLabel">
                  {locale === 'zh' ? '环境变量名' : 'Env var name'}
                  {credentialStatus !== 'ok' ? (
                    <span className={'settingsInlineStatusIcon ' + (credentialStatus === 'missing-name' ? 'warning' : 'danger')} title={credentialStatus === 'missing-name' ? (locale === 'zh' ? '未指定环境变量' : 'Environment variable is not specified') : (locale === 'zh' ? '未发现环境变量' : 'Environment variable not found')}>
                      <Icon name={credentialStatus === 'missing-name' ? 'alertTriangle' : 'alert'} />
                    </span>
                  ) : null}
                </span>
                <input
                  list="model-env-var-options"
                  value={modelEnvVarDraft}
                  onChange={(event) => { setModelEnvVarDraft(event.target.value); markDirty('modelEnvVar', true); }}
                  placeholder={selectedProvider?.apiKeyEnvVar || 'OPENAI_API_KEY'}
                />
                <datalist id="model-env-var-options">
                  {modelEnvVarOptions.map((envVar) => <option key={envVar} value={envVar} />)}
                </datalist>
              </label>
            ) : (
              <label className="settingsField">
                <span className="settingsFieldLabel">{locale === 'zh' ? '已保存密钥' : 'Saved key'}</span>
                <div className="settingsInputWithSuffix">
                  <input
                    placeholder={savedModelKeyPlaceholder()}
                    value={apiKeyDraft}
                    onChange={(event) => { setApiKeyDraft(event.target.value); markDirty('apiKey', true); }}
                    type={showSavedModelKey ? 'text' : 'password'}
                  />
                  <button
                    aria-label={showSavedModelKey ? (locale === 'zh' ? '隐藏密钥' : 'Hide key') : (locale === 'zh' ? '显示密钥' : 'Show key')}
                    className="miniIconButton"
                    onClick={() => setShowSavedModelKey((current) => !current)}
                    type="button"
                  >
                    <Icon name={showSavedModelKey ? 'eyeOff' : 'eye'} />
                  </button>
                </div>
              </label>
            )}
          </div>

          {modelKeyNotice ? <p className="settingsNotice">{modelKeyNotice}</p> : null}

            <div className="modelEditorActions">
              <button className="textButton" type="button" onClick={() => closePanel()} disabled={busyAction}>
                {locale === 'zh' ? '取消' : 'Cancel'}
              </button>
              <button className="solidButton" type="button" onClick={() => void submitPanel()} disabled={busyAction}>
                {isCreating ? (locale === 'zh' ? '创建' : 'Create') : (locale === 'zh' ? '保存修改' : 'Save changes')}
              </button>
            </div>
          </div>
        </div>
      ), editorPortalTarget ?? document.body) : null}

      <div className="settingsSectionBlock modelPresetSection">
        <div className="modelPresetList">
          {modelPresets.length === 0 ? (
            <p className="modelPresetEmpty">{locale === 'zh' ? '暂无模型，点击右上角加号新建。' : 'No models yet. Use the plus icon to add one.'}</p>
          ) : groupedPresets.map(({ providerId, presets }) => {
            const provider = providers.find((item) => item.id === providerId);
            return (
              <div className="modelProviderGroup" key={providerId}>
                <div className="modelProviderRow">
                  <span className="modelPresetRowIcon"><ModelBrandIcon model={presets[0].config.model} provider={providerId} providerName={provider?.name} iconUrl={provider?.iconUrl} baseUrl={provider?.baseUrl} /></span>
                  <strong>{provider?.name ?? providerId}</strong>
                  <span className="modelProviderCount">{presets.length}</span>
                  <span className="modelProviderActions">
                  <button className="miniIconButton" type="button" title={locale === 'zh' ? '添加模型' : 'Add model'} aria-label={locale === 'zh' ? '为' + (provider?.name ?? providerId) + '添加模型' : 'Add model to ' + (provider?.name ?? providerId)} onClick={() => beginCreate(providerId)}><Icon name="plus" /></button>
                  {providerId.startsWith('custom_') && provider ? <button className="miniIconButton" type="button" title={locale === 'zh' ? '设置厂商图标' : 'Set provider icon'} aria-label={locale === 'zh' ? '设置 ' + provider.name + ' 的图标' : 'Set icon for ' + provider.name} onClick={() => void openIconEditor(provider)}><Icon name="images" /></button> : null}
                  {providerId.startsWith('custom_') ? <button className="miniIconButton danger" type="button" title={locale === 'zh' ? '删除厂商' : 'Delete provider'} aria-label={locale === 'zh' ? '删除厂商 ' + (provider?.name ?? providerId) : 'Delete provider ' + (provider?.name ?? providerId)} onClick={() => setPendingDeleteProvider(providerId)}><Icon name="trash" /></button> : null}
                  </span>
                </div>
                {presets.map((preset) => {
                  const isActive = matchedCurrentPreset?.id === preset.id;
                  const rowLabel = modelPresetDisplayName(preset, providers);
                  return (
                    <div className={['modelPresetRow', isActive ? 'active' : '', editingPresetId === preset.id ? 'editing' : ''].filter(Boolean).join(' ')} key={preset.id}>
                      <span className="modelPresetRowText"><strong>{preset.config.model}</strong></span>
                      {isActive ? <span className="modelPresetRowBadge">{locale === 'zh' ? '使用中' : 'In use'}</span> : null}
                      <span className="modelPresetRowActions">
                        <button className="miniIconButton" type="button" title={locale === 'zh' ? '修改' : 'Edit'} aria-label={locale === 'zh' ? '修改 ' + rowLabel : 'Edit ' + rowLabel} onClick={() => beginEdit(preset)}><Icon name="pen" /></button>
                        <button className="miniIconButton danger" type="button" disabled={deletingPresetId === preset.id} title={locale === 'zh' ? '删除' : 'Delete'} aria-label={locale === 'zh' ? '删除 ' + rowLabel : 'Delete ' + rowLabel} onClick={() => setPendingDeletePreset(preset)}><Icon name="trash" /></button>
                      </span>
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>

      {referenceEditorOpen && typeof document !== 'undefined' ? createPortal((
        <ModelContextReferencesPanel locale={locale} onClose={() => setReferenceEditorOpen(false)} onSaved={setReferenceEntries} />
      ), document.querySelector('.settingsLayer') ?? document.body) : null}

      {iconEditorProvider && typeof document !== 'undefined' ? createPortal((
        <div className="modelEditorLayer" role="presentation">
          <button className="modelEditorScrim" type="button" aria-label={locale === 'zh' ? '取消' : 'Cancel'} onClick={closeIconEditor} disabled={iconSaving} />
          <div className="modelEditorPanel modelIconEditorPanel" role="dialog" aria-modal="true" aria-label={locale === 'zh' ? '厂商图标' : 'Provider icon'}>
            <header className="modelEditorHeader">
              <h3>{iconEditorProvider.name} · {locale === 'zh' ? '图标' : 'Icon'}</h3>
              <button className="miniIconButton" type="button" aria-label={locale === 'zh' ? '关闭' : 'Close'} onClick={closeIconEditor} disabled={iconSaving}><Icon name="x" /></button>
            </header>
            <label className="settingsField">
              <span className="settingsFieldLabel">{locale === 'zh' ? '图标 URL' : 'Icon URL'}</span>
              <input value={iconDraft} onChange={(event) => setIconDraft(event.target.value)} placeholder="https://…/brand/icon.svg" />
            </label>
            {iconTabs.length > 0 ? (
              <div className="modelIconCandidates">
                {iconTabs.map((tab) => (
                  <button className="modelIconCandidate" type="button" key={tab.url} onClick={() => setIconDraft(tab.favicon ?? '')}>
                    <img alt="" src={tab.favicon} referrerPolicy="no-referrer" />
                    <span>{tab.title || new URL(tab.url).hostname}</span>
                    <small>{new URL(tab.url).hostname}</small>
                  </button>
                ))}
              </div>
            ) : <p className="modelIconEmpty">{locale === 'zh' ? '没有可用的内置浏览器 Tab，可填写厂商图标地址。' : 'No browser tabs with icons. Enter the provider icon URL.'}</p>}
            {iconError ? <p className="settingsNotice" role="alert">{iconError}</p> : null}
            <div className="modelEditorActions">
              <button className="textButton" type="button" onClick={closeIconEditor} disabled={iconSaving}>{locale === 'zh' ? '取消' : 'Cancel'}</button>
              <button className="solidButton" type="button" onClick={() => void submitIcon()} disabled={iconSaving}>{locale === 'zh' ? '保存图标' : 'Save icon'}</button>
            </div>
          </div>
        </div>
      ), document.querySelector('.settingsLayer') ?? document.body) : null}

      <ConfirmPanel
        locale={locale}
        open={Boolean(pendingDeleteProvider)}
        title={locale === 'zh' ? '删除厂商及其所有模型？' : 'Delete provider and all its models?'}
        description={providers.find((item) => item.id === pendingDeleteProvider)?.name}
        confirmLabel={locale === 'zh' ? '删除' : 'Delete'}
        cancelLabel={locale === 'zh' ? '取消' : 'Cancel'}
        tone="danger"
        busy={busyAction}
        onCancel={() => setPendingDeleteProvider(null)}
        onConfirm={() => void handleDeleteProvider()}
      />
      <ConfirmPanel
        locale={locale}
        open={Boolean(pendingDeletePreset)}
        title={locale === 'zh' ? '删除这个配置？' : 'Delete this configuration?'}
        description={pendingDeletePreset ? (locale === 'zh'
          ? '「' + pendingDeletePreset.name + '」会从列表中移除。'
          : '"' + pendingDeletePreset.name + '" will be removed from the list.') : undefined}
        confirmLabel={locale === 'zh' ? '删除' : 'Delete'}
        cancelLabel={locale === 'zh' ? '取消' : 'Cancel'}
        tone="danger"
        busy={Boolean(pendingDeletePreset && deletingPresetId === pendingDeletePreset.id)}
        onCancel={() => setPendingDeletePreset(null)}
        onConfirm={() => void handleDeletePreset()}
      />
    </section>
  );
}