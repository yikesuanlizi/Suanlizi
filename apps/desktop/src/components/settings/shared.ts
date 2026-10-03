// 设置面板共享辅助：模型草稿匹配、Provider 下拉分组、卡片图标映射等
import type { Locale, RunConfig } from '../../config/config.js';
import type { McpServerStatus, ModelPreset, ProviderEntry } from '../../shared/types.js';
import type { ModelPresetConfig } from '@suanlizi/protocol';
import type { DropdownOption } from '../DropdownSelect.js';
import type { IconName } from '../Icon.js';
import type { RecommendedMcp, RecommendedSkill } from '../../features/settings/pluginCatalog.js';
import type React from 'react';
import { ProviderBrandIcon } from './ProviderBrandIcon.js';
import { t } from '../../shared/i18n.js';

export type ModelConfigDraft = Pick<RunConfig, 'provider' | 'model' | 'baseUrl' | 'modelContextTokens' | 'modelMaxOutputTokens'>;

export type ModelPresetSaveResult = { id?: string; config: ModelPresetConfig };

// 用 preset 匹配当前 RunConfig，用于标识当前正在使用的预设
export function modelPresetMatchesRunConfig(preset: ModelPreset, config: RunConfig): boolean {
  const entries = Object.entries(preset.config) as Array<[keyof RunConfig, RunConfig[keyof RunConfig] | undefined]>;
  return entries.length > 0 && entries.every(([key, value]) => {
    // 手填窗口不决定“使用中”标记；重新选择时会清掉它。
    if (key === 'modelContextTokens') return true;
    if (key === 'modelMaxOutputTokens') {
      return config[key] === value;
    }
    return value === undefined || config[key] === value;
  });
}

// 预设显示名：始终由真实厂商名与模型名推导，绝不暴露 openai_compatible 之类的协议名。
// 历史预设即使存储名过时，也会显示成当前厂商名。
export function modelPresetDisplayName(preset: ModelPreset, providers: ProviderEntry[]): string {
  const provider = providers.find((item) => item.id === preset.config.provider);
  const providerName = provider?.name
    ?? preset.config.provider.replace(/^custom_/, '').replace(/_/g, '.');
  return [providerName, preset.config.model].filter(Boolean).join(' / ');
}

// 从 RunConfig 初始化模型草稿
export function modelConfigDraftFromConfig(config: RunConfig): ModelConfigDraft {
  return {
    provider: config.provider,
    model: config.model,
    baseUrl: config.baseUrl,
    modelContextTokens: config.modelContextTokens,
    modelMaxOutputTokens: config.modelMaxOutputTokens,
  };
}

/** 删除后的编辑器不能再指向已移除的模型或厂商。 */
export function modelDraftAfterDeletion(
  current: ModelConfigDraft,
  providers: ProviderEntry[],
  presets: ModelPreset[],
  deleted?: { providerId: string; model?: string },
): ModelConfigDraft {
  const isDeleted = (providerId: string, model: string) => deleted?.providerId === providerId
    && (deleted.model === undefined || deleted.model === model);
  const exists = (providerId: string) => providers.some((provider) => provider.id === providerId);
  if (exists(current.provider) && !isDeleted(current.provider, current.model)) return current;
  const fallback = presets.find((preset) => exists(preset.config.provider)
    && !isDeleted(preset.config.provider, preset.config.model))?.config;
  return fallback ? {
    provider: fallback.provider,
    model: fallback.model,
    baseUrl: fallback.baseUrl,
    modelContextTokens: fallback.modelContextTokens,
    modelMaxOutputTokens: fallback.modelMaxOutputTokens,
  } : { provider: 'ollama', model: 'qwen2.5-coder:7b', baseUrl: '' };
}

export function normalizeModelConfigDraftForSettings(
  draft: ModelConfigDraft,
  providers: ProviderEntry[],
): { customProviderName: string; draft: ModelConfigDraft; keyProviderId: string } {
  if (!draft.provider.startsWith('custom_')) {
    return { customProviderName: '', draft, keyProviderId: draft.provider };
  }
  const provider = providers.find((item) => item.id === draft.provider);
  return {
    customProviderName: provider?.name ?? draft.provider.replace(/^custom_/, '').replace(/_/g, '.'),
    draft: {
      provider: 'openai_compatible',
      model: draft.model,
      baseUrl: draft.baseUrl || provider?.baseUrl || '',
      modelContextTokens: draft.modelContextTokens,
      modelMaxOutputTokens: draft.modelMaxOutputTokens,
    },
    keyProviderId: draft.provider,
  };
}

const DEFAULT_MODEL_BY_PROVIDER: Record<string, string> = {
  openai: 'gpt-4o',
  deepseek: 'deepseek-v4-pro',
  zhipu: 'glm-4-plus',
  kimi: 'moonshot-v1-8k',
  qwen: 'qwen-plus',
  baidu: 'ernie-4.0-turbo-8k',
  volcengine: 'doubao-seed-1-6',
  siliconflow: 'deepseek-ai/DeepSeek-V3',
  giteeai: 'Qwen/Qwen2.5-72B-Instruct',
  groq: 'llama-3.3-70b-versatile',
  together: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
  openrouter: 'openai/gpt-4o',
  huggingface: 'meta-llama/Llama-3.3-70B-Instruct',
  nvidia: 'meta/llama-3.3-70b-instruct',
  gemini: 'gemini-2.0-flash',
  mistral: 'mistral-large-latest',
  perplexity: 'sonar-pro',
  xai: 'grok-2-latest',
  anthropic: 'claude-3-5-sonnet-latest',
  minimax: 'MiniMax-M3',
  openai_compatible: 'custom-model',
  ollama: 'llama3.1',
  lmstudio: 'local-model',
  vllm: 'local-model',
  llama_cpp: 'local-model',
};

export function defaultModelForProvider(provider: ProviderEntry | undefined, currentModel: string): string {
  if (!provider) return currentModel;
  if (provider.id.startsWith('custom_')) return currentModel;
  return DEFAULT_MODEL_BY_PROVIDER[provider.id] ?? currentModel;
}

// 「运行参数」页可保存的字段。压缩阈值支持线程覆盖，其余是进程级上限，只能写全局配置。
// — English: runtime-settings fields persisted by the Runtime page save action.
export const RUNTIME_SETTING_KEYS = [
  'maxIterations',
  'maxActiveTasks',
  'maxParallelReadonlyTools',
  'maxSubagentDepth',
  'toolTimeoutSeconds',
  'modelTimeoutSeconds',
  'streamIdleTimeoutSeconds',
  'eventStreamReconnectLimit',
  'offlineReconnectLimit',
  'compactionThreshold',
] as const satisfies ReadonlyArray<keyof RunConfig>;
// Provider 下拉分组：自定义 / 本地 / 中国 / 国际 / 通用。已注册的 custom_* 作为独立厂商展示。
// 自定义厂商图标通过独立 tsx 组件渲染，保持 shared.ts 无 JSX。
// English: custom provider icons are rendered by a separate tsx component.
const customProviderIcon = (provider: ProviderEntry): React.ReactNode =>
  ProviderBrandIcon({ provider });

export function providerDropdownOptions(providers: ProviderEntry[], locale: Locale): Array<DropdownOption<string>> {
  const custom = providers.filter((provider) => provider.id.startsWith('custom_'));
  const local = providers.filter((provider) => provider.isLocal && provider.id !== 'openai_compatible' && !provider.id.startsWith('custom_'));
  const generic = providers.filter((provider) => provider.id === 'openai_compatible');
  const chinaIDs = new Set(['deepseek', 'zhipu', 'kimi', 'qwen', 'baidu', 'volcengine', 'siliconflow', 'minimax']);
  const china = providers.filter((provider) => chinaIDs.has(provider.id));
  const global = providers.filter((provider) => !provider.isLocal && !chinaIDs.has(provider.id) && !provider.id.startsWith('custom_'));
  const map = (group: string, provider: ProviderEntry): DropdownOption<string> => ({
    group,
    value: provider.id,
    label: provider.name,
    icon: customProviderIcon(provider),
  });
  // 通用 OpenAI 兼容项在界面上表达为“新建自定义厂商”的动作入口，
  // 不再把协议名 OpenAI-compatible 暴露给用户。
  const customEntry: DropdownOption<string> = {
    group: t(locale, 'customProvider'),
    value: 'openai_compatible',
    label: t(locale, 'newCustomVendor'),
    icon: customProviderIcon(generic[0] ?? { id: 'openai_compatible' } as ProviderEntry),
  };
  return [
    ...custom.map((provider) => map(t(locale, 'customProvider'), provider)),
    ...local.map((provider) => map(t(locale, 'localProvider'), provider)),
    ...china.map((provider) => map(t(locale, 'remoteChina'), provider)),
    ...global.map((provider) => map(t(locale, 'remoteGlobal'), provider)),
    ...(generic.length > 0 ? [customEntry] : []),
  ];
}

// P2.3 保存模型预设草稿的统一编排函数（与 web 共享语义）
export async function saveModelPresetDraft(input: {
  requestName: () => Promise<string | null>;
  ensureProvider: () => Promise<string | null>;
  saveProviderKey: (providerId?: string) => Promise<void>;
  saveProviderEnvVar: (providerId?: string) => Promise<void>;
  savePreset: (name: string, config: ModelPresetConfig, presetId?: string) => Promise<string | ModelPreset | void>;
  presetConfig: ModelPresetConfig;
  presetId?: string;
  status?: 'draft' | 'published';
}): Promise<ModelPresetSaveResult | null> {
  const name = await input.requestName();
  if (name === null) return null;
  const targetProviderId = await input.ensureProvider();
  const resolvedProviderId = targetProviderId ?? input.presetConfig.provider;
  await input.saveProviderKey(resolvedProviderId);
  await input.saveProviderEnvVar(resolvedProviderId);
  const resolvedConfig: ModelPresetConfig = {
    provider: resolvedProviderId,
    model: input.presetConfig.model.trim(),
    baseUrl: input.presetConfig.baseUrl.trim(),
    modelContextTokens: input.presetConfig.modelContextTokens,
    modelMaxOutputTokens: input.presetConfig.modelMaxOutputTokens,
  };
  const savedId = await input.savePreset(name, resolvedConfig, input.presetId);
  if (typeof savedId === 'string') return { id: savedId, config: resolvedConfig };
  if (savedId && typeof savedId === 'object') return { id: savedId.id, config: savedId.config ?? resolvedConfig };
  return { config: resolvedConfig };
}

// 插件中心顶部 tab 图标
export function pluginNavIcon(tab: 'recommended' | 'mcp' | 'skills' | 'web'): IconName {
  switch (tab) {
    case 'recommended':
      return 'spark';
    case 'mcp':
      return 'panel';
    case 'skills':
      return 'workflow';
    case 'web':
      return 'search';
  }
}

export function recommendedCardVisual(item: RecommendedSkill | RecommendedMcp): { icon: IconName; bg: string } {
  const id = item.id.toLowerCase();
  if (id.includes('playwright')) return { icon: item.type === 'mcp' ? 'puppet' : 'browser', bg: '#a7f3d0' };
  if (id.includes('browser')) return { icon: 'browser', bg: '#bae6fd' };
  if (id.includes('filesystem')) return { icon: 'folder', bg: '#fef3c7' };
  if (id.includes('figma')) return { icon: 'layers', bg: '#e9d5ff' };
  if (id.includes('code-review')) return { icon: 'review', bg: '#bae6fd' };
  if (id.includes('bug-hunt')) return { icon: 'activity', bg: '#fed7aa' };
  if (id.includes('frontend-design')) return { icon: 'browser', bg: '#a7f3d0' };
  if (id.includes('frontend-polish')) return { icon: 'spark', bg: '#e9d5ff' };
  if (id.includes('release-notes')) return { icon: 'doc', bg: '#fecdd3' };
  return item.type === 'mcp'
    ? { icon: 'panel', bg: '#bae6fd' }
    : { icon: 'workflow', bg: '#fef3c7' };
}

export function skillCardVisual(name: string): { icon: IconName; bg: string } {
  const key = name.toLowerCase();
  if (key.includes('review')) return { icon: 'review', bg: '#bae6fd' };
  if (key.includes('sql')) return { icon: 'sql', bg: '#fef3c7' };
  if (key.includes('doc') || key.includes('release')) return { icon: 'doc', bg: '#fecdd3' };
  if (key.includes('mermaid')) return { icon: 'mermaid', bg: '#a7f3d0' };
  if (key.includes('translate')) return { icon: 'translate', bg: '#e9d5ff' };
  if (key.includes('playwright') || key.includes('browser')) return { icon: 'browser', bg: '#a7f3d0' };
  if (key.includes('bug') || key.includes('hunt')) return { icon: 'activity', bg: '#fed7aa' };
  if (key.includes('frontend')) return { icon: 'spark', bg: '#e9d5ff' };
  return { icon: 'workflow', bg: '#fef3c7' };
}

export function webToolCardVisual(id: string): { icon: IconName; bg: string } {
  if (id === 'firecrawl') return { icon: 'search', bg: '#bae6fd' };
  return { icon: 'browser', bg: '#a7f3d0' };
}

export function mcpCardVisual(name: string): { icon: IconName; bg: string } {
  const key = name.toLowerCase();
  if (key.includes('github')) return { icon: 'github', bg: '#bae6fd' };
  if (key.includes('file')) return { icon: 'folder', bg: '#fef3c7' };
  if (key.includes('slack')) return { icon: 'message', bg: '#fecdd3' };
  if (key.includes('postgres') || key.includes('pg')) return { icon: 'database', bg: '#a7f3d0' };
  if (key.includes('puppet') || key.includes('playwright')) return { icon: 'puppet', bg: '#fed7aa' };
  if (key.includes('memory')) return { icon: 'memoryChip', bg: '#e9d5ff' };
  if (key.includes('figma')) return { icon: 'layers', bg: '#e9d5ff' };
  if (key.includes('browser')) return { icon: 'browser', bg: '#bae6fd' };
  return { icon: 'panel', bg: '#bae6fd' };
}

// MCP 状态文本与色调
export function mcpStatusText(
  status: McpServerStatus | undefined,
  enabled: boolean,
  locale: Locale,
): { label: string; dot: string; tone: 'ok' | 'warn' | 'danger' | 'muted' } {
  if (!enabled || !status || status.status === 'disabled') {
    return { label: locale === 'zh' ? '已禁用' : 'Disabled', dot: '○', tone: 'muted' };
  }
  if (status.status === 'configured') {
    return { label: locale === 'zh' ? '已启用 · 待启动' : 'Enabled · Standby', dot: '●', tone: 'warn' };
  }
  if (status.status === 'running') {
    const tools = locale === 'zh' ? `${status.toolCount} 个工具` : `${status.toolCount} tools`;
    return { label: `${locale === 'zh' ? '运行中' : 'Running'} · ${tools}`, dot: '●', tone: 'ok' };
  }
  if (status.status === 'starting') {
    return { label: locale === 'zh' ? '启动中' : 'Starting', dot: '●', tone: 'warn' };
  }
  const label = status.status === 'dead'
    ? (locale === 'zh' ? '已崩溃' : 'Dead')
    : (locale === 'zh' ? '启动失败' : 'Failed');
  return { label, dot: '●', tone: 'danger' };
}
