import { z } from 'zod';
import type { AccessPolicyConfig } from './accessPolicy.js';
import { accessPolicyConfigSchema } from './accessPolicySchemas.js';

export type PermissionPresetId = 'read_only' | 'workspace' | 'danger_full_access';
export type WebSearchMode = 'auto' | 'on' | 'off';
export type ReasoningEffort = 'no' | 'medium' | 'high' | 'xhigh' | 'max';
export type RunProfile = 'cache_first' | 'runtime_os';
export type ApiMode = 'chat' | 'responses' | 'completion';
export type ReasoningMode = 'disabled' | 'auto' | 'adaptive' | 'enabled';

/** 归一历史输入和新 UI 的思考档：low 家族关闭思考，ultra 家族映射最高档。 */
export function normalizeReasoningEffort(value: unknown): ReasoningEffort | undefined {
  if (typeof value !== 'string') return undefined;
  const effort = value.trim().toLowerCase().replace(/[_-]+/g, '');
  if (!effort) return undefined;
  if (['no', 'low', 'none', 'off', 'disabled', 'false', 'minimal'].includes(effort)) return 'no';
  if (['ultra', 'maximum'].includes(effort)) return 'max';
  if (['medium', 'high', 'xhigh', 'max'].includes(effort)) return effort as ReasoningEffort;
  return undefined;
}

export interface ThreadRunConfigOverrides {
  workspaceRoot?: string;
  provider?: string;
  model?: string;
  baseUrl?: string;
  modelContextTokens?: number;
  modelMaxOutputTokens?: number;
  permissions?: PermissionPresetId;
  accessPolicy?: AccessPolicyConfig;
  webSearchMode?: WebSearchMode;
  reasoningEffort?: ReasoningEffort;
  runProfile?: RunProfile;
  /** 上下文压缩阈值：占模型上下文窗口的比例（0.3 ~ 0.95）。 */
  compactionThreshold?: number;
}

export const THREAD_RUN_CONFIG_KEYS = [
  'workspaceRoot',
  'provider',
  'model',
  'baseUrl',
  'modelContextTokens',
  'modelMaxOutputTokens',
  'permissions',
  'accessPolicy',
  'webSearchMode',
  'reasoningEffort',
  'runProfile',
  'compactionThreshold',
] as const;

export type ThreadRunConfigKey = typeof THREAD_RUN_CONFIG_KEYS[number];

export interface ThreadConfigUpdate {
  set?: ThreadRunConfigOverrides;
  unset?: ThreadRunConfigKey[];
}

const threadRunConfigOverridesSchemaLegacy = z.object({
  workspaceRoot: z.string().trim().min(1).optional(),
  provider: z.string().trim().min(1).optional(),
  model: z.string().trim().min(1).optional(),
  baseUrl: z.string().optional(),
  modelContextTokens: z.number().int().positive().optional(),
  modelMaxOutputTokens: z.number().int().positive().optional(),
  permissions: z.enum(['read_only', 'workspace', 'danger_full_access']).optional(),
  accessPolicy: accessPolicyConfigSchema.optional(),
  webSearchMode: z.enum(['auto', 'on', 'off']).optional(),
  reasoningEffort: z.preprocess(normalizeReasoningEffort, z.enum(['no', 'medium', 'high', 'xhigh', 'max']).optional()),
  runProfile: z.enum(['cache_first', 'runtime_os']).optional(),
  compactionThreshold: z.number().min(0.3).max(0.95).optional(),
}).strict();

export const threadConfigUpdateSchema = z.object({
  set: threadRunConfigOverridesSchemaLegacy.optional(),
  unset: z.array(z.enum(THREAD_RUN_CONFIG_KEYS)).max(THREAD_RUN_CONFIG_KEYS.length).optional(),
}).strict().superRefine((value, context) => {
  if (!value.set && !value.unset?.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'set or unset is required' });
  }
  for (const key of value.unset ?? []) {
    if (value.set && key in value.set) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: `cannot set and unset ${key}` });
    }
  }
});

export function threadRunConfigOverridesFrom(input: Record<string, unknown>): ThreadRunConfigOverrides {
  const result: ThreadRunConfigOverrides = {};
  for (const key of THREAD_RUN_CONFIG_KEYS) {
    const value = key === 'reasoningEffort'
      ? normalizeReasoningEffort(input[key])
      : input[key];
    if (typeof value === 'string') {
      (result as Record<string, string>)[key] = value.trim();
    } else if ((key === 'modelContextTokens' || key === 'modelMaxOutputTokens')
      && typeof value === 'number' && Number.isInteger(value) && value > 0) {
      (result as Record<string, number>)[key] = value;
    } else if (key === 'compactionThreshold'
      && typeof value === 'number' && Number.isFinite(value) && value > 0) {
      (result as Record<string, number>)[key] = Math.min(0.95, Math.max(0.3, value));
    } else if (key === 'accessPolicy' && value && typeof value === 'object' && !Array.isArray(value)) {
      result.accessPolicy = accessPolicyConfigSchema.parse(value);
    }
  }
  return result;
}

export interface ModelPresetConfig {
  provider: string;
  model: string;
  baseUrl: string;
  /** Explicit context window for custom or self-hosted models. */
  modelContextTokens?: number;
  /** Explicit maximum completion size for custom or self-hosted models. */
  modelMaxOutputTokens?: number;
}


export function modelPresetConfigFrom(input: Record<string, unknown>): ModelPresetConfig {
  const provider = typeof input.provider === 'string' ? input.provider.trim() : '';
  const model = typeof input.model === 'string' ? input.model.trim() : '';
  const baseUrl = typeof input.baseUrl === 'string' ? input.baseUrl.trim() : '';
  if (!provider || !model) {
    throw new Error('provider and model are required');
  }
  const modelContextTokens = positiveOptionalInteger(input.modelContextTokens);
  const modelMaxOutputTokens = positiveOptionalInteger(input.modelMaxOutputTokens);
  if (modelContextTokens && modelMaxOutputTokens && modelMaxOutputTokens > modelContextTokens) {
    throw new Error('modelMaxOutputTokens cannot exceed modelContextTokens');
  }
  return {
    provider,
    model,
    baseUrl,
    ...(modelContextTokens ? { modelContextTokens } : {}),
    ...(modelMaxOutputTokens ? { modelMaxOutputTokens } : {}),
  };
}

function positiveOptionalInteger(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
}

// ─── Explicit Configuration Scopes (for P0 Task 3 refactoring) ──────────────

export const threadOnlyRunConfigKeys = ['themeMode', 'themePrimaryColor'] as const;

export type ThreadOnlyRunConfigKey = typeof threadOnlyRunConfigKeys[number];

export const GlobalRunConfigDefaultsSchema = z.object({
  provider: z.string().default('openai'),
  model: z.string().default('gpt-4o'),
  baseUrl: z.string().default(''),
  apiMode: z.enum(['chat', 'responses', 'completion']).default('chat'),
  reasoningMode: z.enum(['disabled', 'auto', 'adaptive', 'enabled']).default('auto'),
  thinking: z.boolean().default(false),
  temperature: z.number().min(0).max(2).default(0.7),
  webSearchMode: z.enum(['auto', 'on', 'off']).default('auto'),
  webSearchMaxResults: z.number().int().min(1).max(20).default(5),
  maxSteps: z.number().int().min(1).max(100).default(25),
  planMode: z.enum(['disabled', 'on', 'auto']).default('auto'),
  includeMemory: z.boolean().default(true),
  modelContextTokens: z.number().int().positive().optional(),
  modelMaxOutputTokens: z.number().int().positive().optional(),
  customBaseUrl: z.string().default(''),
  customApiKey: z.string().default(''),
  accessPolicy: accessPolicyConfigSchema.default({}),
}).strip();

export type GlobalRunConfigDefaults = z.infer<typeof GlobalRunConfigDefaultsSchema>;

export const AppearanceConfigSchema = z.object({
  themeMode: z.enum(['light', 'dark', 'auto']).default('auto'),
  themePrimaryColor: z.string().default('6366f1'),
}).strip();

export type AppearanceConfig = z.infer<typeof AppearanceConfigSchema>;

export const NewThreadDefaultsConfigSchema = z.object({
  provider: z.string().trim().min(1).optional(),
  model: z.string().trim().min(1).optional(),
  baseUrl: z.string().optional(),
}).strip();

export type NewThreadDefaultsConfig = z.infer<typeof NewThreadDefaultsConfigSchema>;

export const ThreadModelOverridesSchema = z.object({
  provider: z.string().trim().min(1).optional(),
  model: z.string().trim().min(1).optional(),
  baseUrl: z.string().optional(),
}).strip();

export type ThreadModelOverrides = z.infer<typeof ThreadModelOverridesSchema>;

export const EMPTY_THREAD_MODEL_OVERRIDES: ThreadModelOverrides = {};

export interface ResolvedRunConfig {
  provider: string;
  model: string;
  baseUrl: string;
  apiMode: ApiMode;
  reasoningMode: ReasoningMode;
  thinking: boolean;
  temperature: number;
  webSearchMode: WebSearchMode;
  webSearchMaxResults: number;
  maxSteps: number;
  planMode: 'disabled' | 'on' | 'auto';
  includeMemory: boolean;
  modelContextTokens?: number;
  modelMaxOutputTokens?: number;
  customBaseUrl: string;
  customApiKey: string;
}

export interface CompositeConfigSnapshot {
  globalDefaults: GlobalRunConfigDefaults;
  appearance: AppearanceConfig;
  newThreadDefaults: NewThreadDefaultsConfig;
  activeThreadOverrides: ThreadModelOverrides;
}

const CompositeConfigSnapshotSchema = z.object({
  globalDefaults: GlobalRunConfigDefaultsSchema.default({}),
  appearance: AppearanceConfigSchema.default({}),
  newThreadDefaults: NewThreadDefaultsConfigSchema.default({}),
  activeThreadOverrides: ThreadModelOverridesSchema.default({}),
}).strip();

export function activeRunConfig(composite: CompositeConfigSnapshot): ResolvedRunConfig {
  const { globalDefaults, activeThreadOverrides } = composite;
  return {
    provider: activeThreadOverrides.provider ?? globalDefaults.provider,
    model: activeThreadOverrides.model ?? globalDefaults.model,
    baseUrl: activeThreadOverrides.baseUrl ?? globalDefaults.baseUrl,
    apiMode: globalDefaults.apiMode,
    reasoningMode: globalDefaults.reasoningMode,
    thinking: globalDefaults.thinking,
    temperature: globalDefaults.temperature,
    webSearchMode: globalDefaults.webSearchMode,
    webSearchMaxResults: globalDefaults.webSearchMaxResults,
    maxSteps: globalDefaults.maxSteps,
    planMode: globalDefaults.planMode,
    includeMemory: globalDefaults.includeMemory,
    modelContextTokens: globalDefaults.modelContextTokens,
    modelMaxOutputTokens: globalDefaults.modelMaxOutputTokens,
    customBaseUrl: globalDefaults.customBaseUrl,
    customApiKey: globalDefaults.customApiKey,
  };
}

export function parseCompositeConfigSnapshot(input: unknown): CompositeConfigSnapshot {
  return CompositeConfigSnapshotSchema.parse(input);
}

export const defaultGlobalRunConfigDefaults: GlobalRunConfigDefaults = GlobalRunConfigDefaultsSchema.parse({});
export const defaultAppearanceConfig: AppearanceConfig = AppearanceConfigSchema.parse({});
export const defaultNewThreadDefaultsConfig: NewThreadDefaultsConfig = NewThreadDefaultsConfigSchema.parse({});
export const defaultCompositeConfigSnapshot: CompositeConfigSnapshot = {
  globalDefaults: defaultGlobalRunConfigDefaults,
  appearance: defaultAppearanceConfig,
  newThreadDefaults: defaultNewThreadDefaultsConfig,
  activeThreadOverrides: EMPTY_THREAD_MODEL_OVERRIDES,
};
