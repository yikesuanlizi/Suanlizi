import { randomUUID } from 'node:crypto';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Locale } from '@suanlizi/i18n';
import {
  DEFAULT_EPISODE_MEMORY_SETTINGS,
  DEFAULT_MEMORY_SETTINGS,
  normalizeEpisodeMemorySettings,
  normalizeMemorySettings,
} from '@suanlizi/memory';
import { normalizeCompactionThreshold } from '@suanlizi/runtime';
import {
  accessPolicyConfigSchema,
  modelPresetConfigFrom,
  normalizeAccessPolicyConfig,
  normalizeReasoningEffort,
  redactAccessPolicyForPublicConfig,
  type AccessPolicyConfig,
  type ModelPresetConfig,
  type PermissionPresetId,
  type ReasoningEffort,
  type ThreadId,
  type ThreadRunConfigOverrides,
  type WebSearchMode,
} from '@suanlizi/protocol';
import type { ThreadStore } from '@suanlizi/storage';
import { resolveAppDataRoot } from './appData.js';
import { MCP_SERVERS_KEY, normalizeMcpServers, type McpServerConfig } from './mcp.js';

// 网页提供者模式：原生 fetch | firecrawl — Chinese: web provider mode
export type WebProviderMode = 'native_fetch' | 'firecrawl';
// 密钥来源：项目配置 | 环境变量 — Chinese: secret source
export type SecretSource = 'config' | 'env';
// 界面主题：深色 | 浅色 | 跟随系统 — Chinese: UI theme mode
export type ThemeMode = 'dark' | 'light' | 'system';
export type { PermissionPresetId, ReasoningEffort, WebSearchMode } from '@suanlizi/protocol';

// Codex 风格的子 Agent 角色档案（以 agent_type 为键） — Chinese: agent role profiles
export type AgentRoleProfiles = Record<string, {
  description?: string;
  instructions?: string;
  systemPrompt?: string;
  skills?: string[];
  allowedSkills?: string[];
  allowedTools?: string[];
  blockedTools?: string[];
  serviceTier?: string;
  maxSubagents?: number;
  maxSubagentDepth?: number;
}>;

export interface AgentRunConfig {
  /** 工作区认证只看这个布尔标记；workspaceRoot 只是位置数据。 */
  hasWorkspace: boolean;
  workspaceRoot: string;
  provider: string;
  model: string;
  baseUrl?: string;
  apiKey?: string;
  /** Permission preset id: 'read_only' | 'workspace' | 'danger_full_access'. */
  /** 中文：权限预设 id */
  permissions: PermissionPresetId;
  /** Persistent access policy. Temporary grants are runtime-only and never persisted. */
  /** 中文：持久访问策略。临时授权仅属于运行时，禁止持久化。 */
  accessPolicy: AccessPolicyConfig;
  dataDir: string;
  /** Single user-level directory containing skill subdirectories with SKILL.md. */
  /** 中文：存放 SKILL.md 子目录的根目录 */
  skillsRoot: string;
  /** Controls when the future web_search extension should be exposed to a turn. */
  /** 中文：控制何时在一个回合中暴露 web_search 扩展 */
  webSearchMode: WebSearchMode;
  /** Which web reader/search backend should power the model-visible web_search tool. */
  /** 中文：作为模型可见 web_search 工具的后端 */
  webProvider: WebProviderMode;
  /** Firecrawl key source: project settings database or system environment. */
  /** 中文：Firecrawl 密钥来源 — 项目配置或系统环境变量 */
  webProviderKeySource: SecretSource;
  /** Simplified reasoning effort selector shown in the composer. */
  /** 中文：在 composer 中展示的简化推理力度选项 */
  reasoningEffort: ReasoningEffort;
  /** 每个回合允许 Agent 循环的最大迭代次数。 */
  maxIterations: number;
  /** 全局同时运行的顶层任务数；同一线程仍由 runtime 保证串行。 */
  maxActiveTasks?: number;
  /** 每个 Agent 步骤允许并行的只读工具数；写入和浏览器工具始终串行。 */
  maxParallelReadonlyTools?: number;
  /** 子 Agent 最大嵌套深度，服务端硬上限为 2。 */
  maxSubagentDepth?: number;
  /** Optional explicit context window override for the selected model. */
  /** 中文：当前模型上下文窗口的显式覆盖；为空时按 provider/model 自动推导 */
  modelContextTokens?: number;
  /** Optional explicit max output token override for the selected model. */
  /** 中文：当前模型最大输出 token 的显式覆盖；为空时按 provider/model 自动推导 */
  modelMaxOutputTokens?: number;
  /** 模型单次响应超时（秒）；覆盖 model-gateway 的默认 120 秒。 */
  modelTimeoutSeconds?: number;
  /** 模型流式空闲超时（秒）；每收到一帧都会重置。 */
  streamIdleTimeoutSeconds?: number;
  /** 事件流正常断开后允许的重连次数；0 表示不重连。 */
  eventStreamReconnectLimit?: number;
  /** 浏览器离线状态下的重连次数；0 表示不重连。 */
  offlineReconnectLimit?: number;
  /** 单次工具执行超时（秒）；覆盖内置工具默认值。 */
  toolTimeoutSeconds?: number;
  /** 上下文压缩阈值：占模型上下文窗口的比例（0.3 ~ 0.95）。 */
  compactionThreshold?: number;
  /** Codex-style subagent role profiles keyed by agent_type. */
  /** 中文：以 agent_type 为键的 Codex 风格子 Agent 角色档案 */
  agentRoles?: AgentRoleProfiles;
  memoryEnabled: boolean;
  autoExtractMemories: boolean;
  useColdMemories: boolean;
  memoryInjectLimit: number;
  memoryTokenBudget: number;
  episodeMemoryEnabled: boolean;
  episodeInjectLimit: number;
  episodeTokenBudget: number;
  episodeSwitchCooldownTurns: number;
  episodeSealIdleMinutes: number;
  episodeColdAfterDays: number;
  episodeFtsCandidateLimit: number;
  episodeRerankEnabled: boolean;
  /** Whether system monitor (CPU/memory/disk) throttling is enabled. */
  /** 中文：是否启用系统监控（CPU/内存/磁盘）限流 */
  systemMonitorSamplingEnabled?: boolean;
  /** 是否把监控事件写入运行轨迹。 */
  systemMonitorLogRecordingEnabled?: boolean;
  /** 是否根据阈值对工具和子 Agent 自动限流。仅在采样开启时生效。 */
  systemMonitorGuardEnabled?: boolean;
  /** 系统监控阈值；字段保持稳定以便桌面/接口直接传输。 */
  systemMonitorThresholds?: {
    cpuLight: number;
    cpuModerate: number;
    cpuSevere: number;
    memLight: number;
    memModerate: number;
    memSevere: number;
    diskSevereBytes: number;
  };
  themeMode: ThemeMode;
  locale?: Locale;
}

export interface TurnRequest {
  input: string;
  modeInstruction?: string;
  config?: Partial<AgentRunConfig>;
  images?: Array<{ name: string; dataUrl: string }>;
}

// API 密钥状态 — Chinese: api key state
export interface ApiKeyState {
  providerId: string;
  envVar: string;
  defaultEnvVar?: string;
  envVarCandidates?: string[];
  configured: boolean;
  source: 'env' | 'config' | null;
  masked: string | null;
}

// 模型预设 — Chinese: model preset
export interface ModelPreset {
  id: string;
  name: string;
  config: ModelPresetConfig;
  createdAt: string;
  updatedAt: string;
}

export const DEFAULT_RUN_CONFIG_KEY = 'runConfig.default';
export const MODEL_PRESETS_KEY = 'modelPresets';
export const WEB_PROVIDER_SECRETS_KEY = 'webProvider.secrets.v1';
export const ACCESS_POLICY_KEY = 'accessPolicy.v1';
export const THREAD_CONFIG_KEY_PREFIX = 'thread-config:';
export const THREAD_CONFIG_OVERRIDES_KEY_PREFIX = 'thread-config-overrides:';
export const THREAD_ACCESS_POLICY_KEY_PREFIX = 'thread-access-policy:';
// A2A 协议配置存储 key — Chinese: A2A protocol config storage key
export const A2A_CONFIG_KEY = 'suanlizi.a2aConfig';

// 当前对话可以覆盖的运行选择。模型字段之外的选择必须跟随线程保存，
// 否则切换线程时会被全局配置或线程旧快照覆盖。
export type ThreadConfigOverrides = Pick<
  ThreadRunConfigOverrides,
  'hasWorkspace' | 'provider' | 'model' | 'baseUrl' | 'modelContextTokens' | 'modelMaxOutputTokens' | 'permissions' | 'reasoningEffort' | 'compactionThreshold'
>;

// modelContextTokens/modelMaxOutputTokens are valid only in the dedicated
// thread override store. Tags are also written by ordinary turn requests, so
// never treat a tagged value as an explicit model-window choice.
const THREAD_TAG_OVERRIDE_KEYS: Array<keyof ThreadConfigOverrides> = [
  'provider',
  'model',
  'baseUrl',
  'permissions',
  'reasoningEffort',
  'compactionThreshold',
];

export interface WebProviderSecrets {
  firecrawlApiKey?: string;
}

// A2A 协议配置 — Chinese: A2A protocol configuration
export interface A2ARemoteAgent {
  url: string;
  name?: string;
  addedAt: string;
}

export interface A2AConfig {
  // 启用 A2A Server（对外暴露 Agent） — Chinese: enable A2A server (expose agent externally)
  enabled: boolean;
  // 启用 A2A Client（调用外部 Agent） — Chinese: enable A2A client (call external agents)
  clientEnabled: boolean;
  // 已注册的远程 Agent 列表 — Chinese: registered remote agent list
  remotes: A2ARemoteAgent[];
}

export const DEFAULT_A2A_CONFIG: A2AConfig = {
  enabled: false,
  clientEnabled: false,
  remotes: [],
};

// 规范化 A2A 配置：补全缺省字段、过滤无效条目 — Chinese: normalize A2A config
export function normalizeA2AConfig(input: unknown): A2AConfig {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ...DEFAULT_A2A_CONFIG };
  }
  const raw = input as Partial<A2AConfig>;
  const remotes: A2ARemoteAgent[] = [];
  if (Array.isArray(raw.remotes)) {
    for (const item of raw.remotes) {
      if (!item || typeof item !== 'object') continue;
      const candidate = item as Partial<A2ARemoteAgent>;
      const url = typeof candidate.url === 'string' ? candidate.url.trim() : '';
      if (!url) continue;
      const name = typeof candidate.name === 'string' && candidate.name.trim()
        ? candidate.name.trim()
        : undefined;
      const addedAt = typeof candidate.addedAt === 'string' && candidate.addedAt
        ? candidate.addedAt
        : new Date().toISOString();
      remotes.push({ url, name, addedAt });
    }
  }
  return {
    enabled: Boolean(raw.enabled),
    clientEnabled: Boolean(raw.clientEnabled),
    remotes,
  };
}

// 返回给前端的公开 A2A 配置（当前无敏感字段，直接返回） — Chinese: public A2A config
export function publicA2AConfig(config: A2AConfig): A2AConfig {
  return normalizeA2AConfig(config);
}

export interface PublicWebProviderConfig {
  firecrawl: {
    configured: boolean;
    source: SecretSource | null;
    masked: string | null;
    envVar: 'FIRECRAWL_API_KEY';
  };
}

export interface WebProviderRuntimeConfig {
  provider: WebProviderMode;
  firecrawl: { apiKey?: string; baseUrl?: string };
  source: SecretSource | null;
}

export const defaultConfig: AgentRunConfig = {
  hasWorkspace: true,
  workspaceRoot: process.cwd(),
  provider: 'ollama',
  model: 'qwen2.5-coder:7b',
  baseUrl: '',
  permissions: 'workspace',
  accessPolicy: {
    mode: 'workspace',
    workspaceRoot: '',
    persistentRules: [],
    temporaryGrants: [],
  },
  dataDir: resolveAppDataRoot(),
  skillsRoot: path.join(os.homedir(), '.suanlizi', 'skills'),
  webSearchMode: 'auto',
  webProvider: 'native_fetch',
  webProviderKeySource: 'config',
  reasoningEffort: 'medium',
  maxIterations: 100,
  maxActiveTasks: 4,
  maxParallelReadonlyTools: 2,
  maxSubagentDepth: 1,
  modelTimeoutSeconds: 120,
  streamIdleTimeoutSeconds: 300,
  eventStreamReconnectLimit: 5,
  offlineReconnectLimit: 5,
  toolTimeoutSeconds: 120,
  compactionThreshold: 0.8,
  themeMode: 'light',
  agentRoles: {},
  memoryEnabled: DEFAULT_MEMORY_SETTINGS.memoryEnabled,
  autoExtractMemories: DEFAULT_MEMORY_SETTINGS.autoExtractMemories,
  useColdMemories: DEFAULT_MEMORY_SETTINGS.useColdMemories,
  memoryInjectLimit: DEFAULT_MEMORY_SETTINGS.memoryInjectLimit,
  memoryTokenBudget: DEFAULT_MEMORY_SETTINGS.memoryTokenBudget,
  episodeMemoryEnabled: DEFAULT_EPISODE_MEMORY_SETTINGS.episodeMemoryEnabled,
  episodeInjectLimit: DEFAULT_EPISODE_MEMORY_SETTINGS.episodeInjectLimit,
  episodeTokenBudget: DEFAULT_EPISODE_MEMORY_SETTINGS.episodeTokenBudget,
  episodeSwitchCooldownTurns: DEFAULT_EPISODE_MEMORY_SETTINGS.episodeSwitchCooldownTurns,
  episodeSealIdleMinutes: DEFAULT_EPISODE_MEMORY_SETTINGS.episodeSealIdleMinutes,
  episodeColdAfterDays: DEFAULT_EPISODE_MEMORY_SETTINGS.episodeColdAfterDays,
  episodeFtsCandidateLimit: DEFAULT_EPISODE_MEMORY_SETTINGS.episodeFtsCandidateLimit,
  episodeRerankEnabled: DEFAULT_EPISODE_MEMORY_SETTINGS.episodeRerankEnabled,
  systemMonitorSamplingEnabled: false,
  systemMonitorLogRecordingEnabled: false,
  systemMonitorGuardEnabled: false,
  systemMonitorThresholds: {
    cpuLight: 85,
    cpuModerate: 92,
    cpuSevere: 97,
    memLight: 82,
    memModerate: 90,
    memSevere: 95,
    diskSevereBytes: 500 * 1024 * 1024,
  },
};

export function hiddenChatWorkspaceRoot(dataDir: string): string {
  return path.join(path.resolve(dataDir), 'chat-workspace');
}

export function resolveConfig(patch: Partial<AgentRunConfig> = {}): AgentRunConfig {
  const merged = { ...defaultConfig, ...patch } as AgentRunConfig;
  // 是否有工作区只看显式布尔标记；旧数据没有该字段时只能表示“初始有工作区”。
  merged.hasWorkspace = merged.hasWorkspace !== false;
  // 无工作区时路径只是可能残留的位置数据，禁止 resolve 成进程 cwd。
  merged.workspaceRoot = merged.hasWorkspace ? path.resolve(merged.workspaceRoot) : '';
  merged.dataDir = path.resolve(merged.dataDir);
  if (!merged.skillsRoot) {
    merged.skillsRoot = defaultConfig.skillsRoot;
  }
  merged.skillsRoot = path.resolve(merged.skillsRoot);
  if (!['auto', 'on', 'off'].includes(merged.webSearchMode)) {
    merged.webSearchMode = defaultConfig.webSearchMode;
  }
  if (!['native_fetch', 'firecrawl'].includes(merged.webProvider)) {
    merged.webProvider = defaultConfig.webProvider;
  }
  if (!['config', 'env'].includes(merged.webProviderKeySource)) {
    merged.webProviderKeySource = defaultConfig.webProviderKeySource;
  }
  merged.reasoningEffort = normalizeReasoningEffort(merged.reasoningEffort) ?? defaultConfig.reasoningEffort;
  const maxIterations = Number(merged.maxIterations);
  merged.maxIterations = Number.isFinite(maxIterations)
    ? Math.max(1, Math.min(1000, Math.floor(maxIterations)))
    : defaultConfig.maxIterations;
  const maxActiveTasks = Number(merged.maxActiveTasks);
  merged.maxActiveTasks = Number.isFinite(maxActiveTasks)
    ? Math.max(1, Math.min(64, Math.floor(maxActiveTasks)))
    : defaultConfig.maxActiveTasks;
  const maxParallelReadonlyTools = Number(merged.maxParallelReadonlyTools);
  merged.maxParallelReadonlyTools = Number.isFinite(maxParallelReadonlyTools)
    ? Math.max(1, Math.min(16, Math.floor(maxParallelReadonlyTools)))
    : defaultConfig.maxParallelReadonlyTools;
  const maxSubagentDepth = Number(merged.maxSubagentDepth);
  merged.maxSubagentDepth = Number.isFinite(maxSubagentDepth)
    ? Math.max(1, Math.min(2, Math.floor(maxSubagentDepth)))
    : defaultConfig.maxSubagentDepth;
  normalizeOptionalPositiveIntegerField(merged, 'modelContextTokens');
  normalizeOptionalPositiveIntegerField(merged, 'modelMaxOutputTokens');
  const modelTimeoutSeconds = Number(merged.modelTimeoutSeconds);
  const streamIdleTimeoutSeconds = Number(merged.streamIdleTimeoutSeconds);
  merged.streamIdleTimeoutSeconds = Number.isFinite(streamIdleTimeoutSeconds)
    ? Math.max(5, Math.min(3600, Math.floor(streamIdleTimeoutSeconds)))

    : defaultConfig.streamIdleTimeoutSeconds;
  const eventStreamReconnectLimit = Number(merged.eventStreamReconnectLimit);
  merged.eventStreamReconnectLimit = Number.isFinite(eventStreamReconnectLimit)
    ? Math.max(0, Math.min(20, Math.floor(eventStreamReconnectLimit)))
    : defaultConfig.eventStreamReconnectLimit;
  const offlineReconnectLimit = Number(merged.offlineReconnectLimit);
  merged.offlineReconnectLimit = Number.isFinite(offlineReconnectLimit)
    ? Math.max(0, Math.min(20, Math.floor(offlineReconnectLimit)))
    : defaultConfig.offlineReconnectLimit;
  merged.modelTimeoutSeconds = Number.isFinite(modelTimeoutSeconds)
    ? Math.max(10, Math.min(3600, Math.floor(modelTimeoutSeconds)))
    : defaultConfig.modelTimeoutSeconds;
  const toolTimeoutSeconds = Number(merged.toolTimeoutSeconds);
  merged.toolTimeoutSeconds = Number.isFinite(toolTimeoutSeconds)
    ? Math.max(10, Math.min(600, Math.floor(toolTimeoutSeconds)))
    : defaultConfig.toolTimeoutSeconds;
  // 压缩阈值：越界值收敛到允许区间，非法值回退默认。
  merged.compactionThreshold = normalizeCompactionThreshold(merged.compactionThreshold);
  if (!['dark', 'light', 'system'].includes(merged.themeMode)) {
    merged.themeMode = defaultConfig.themeMode;
  }
  if (!merged.agentRoles || typeof merged.agentRoles !== 'object' || Array.isArray(merged.agentRoles)) {
    merged.agentRoles = {};
  }
  const memory = normalizeMemorySettings({
    memoryEnabled: merged.memoryEnabled,
    autoExtractMemories: merged.autoExtractMemories,
    useColdMemories: merged.useColdMemories,
    memoryInjectLimit: merged.memoryInjectLimit,
    memoryTokenBudget: merged.memoryTokenBudget,
  });
  merged.memoryEnabled = memory.memoryEnabled;
  merged.autoExtractMemories = memory.autoExtractMemories;
  merged.useColdMemories = memory.useColdMemories;
  merged.memoryInjectLimit = memory.memoryInjectLimit;
  merged.memoryTokenBudget = memory.memoryTokenBudget;
  const episode = normalizeEpisodeMemorySettings({
    episodeMemoryEnabled: merged.episodeMemoryEnabled,
    episodeInjectLimit: merged.episodeInjectLimit,
    episodeTokenBudget: merged.episodeTokenBudget,
    episodeSwitchCooldownTurns: merged.episodeSwitchCooldownTurns,
    episodeSealIdleMinutes: merged.episodeSealIdleMinutes,
    episodeColdAfterDays: merged.episodeColdAfterDays,
    episodeFtsCandidateLimit: merged.episodeFtsCandidateLimit,
    episodeRerankEnabled: merged.episodeRerankEnabled,
  });
  merged.episodeMemoryEnabled = episode.episodeMemoryEnabled;
  merged.episodeInjectLimit = episode.episodeInjectLimit;
  merged.episodeTokenBudget = episode.episodeTokenBudget;
  merged.episodeSwitchCooldownTurns = episode.episodeSwitchCooldownTurns;
  merged.episodeSealIdleMinutes = episode.episodeSealIdleMinutes;
  merged.episodeColdAfterDays = episode.episodeColdAfterDays;
  merged.episodeFtsCandidateLimit = episode.episodeFtsCandidateLimit;
  merged.episodeRerankEnabled = episode.episodeRerankEnabled;
  merged.systemMonitorSamplingEnabled = merged.systemMonitorSamplingEnabled === true;
  merged.systemMonitorLogRecordingEnabled = merged.systemMonitorLogRecordingEnabled === true;
  merged.systemMonitorGuardEnabled = merged.systemMonitorGuardEnabled === true;
  const defaultThresholds = defaultConfig.systemMonitorThresholds ?? {
    cpuLight: 85,
    cpuModerate: 92,
    cpuSevere: 97,
    memLight: 82,
    memModerate: 90,
    memSevere: 95,
    diskSevereBytes: 500 * 1024 * 1024,
  };
  if (!merged.systemMonitorThresholds || typeof merged.systemMonitorThresholds !== 'object') {
    merged.systemMonitorThresholds = { ...defaultThresholds };
  } else {
    const thresholds = merged.systemMonitorThresholds;
    merged.systemMonitorThresholds = {
      cpuLight: boundedThreshold(thresholds.cpuLight, defaultThresholds.cpuLight),
      cpuModerate: boundedThreshold(thresholds.cpuModerate, defaultThresholds.cpuModerate),
      cpuSevere: boundedThreshold(thresholds.cpuSevere, defaultThresholds.cpuSevere),
      memLight: boundedThreshold(thresholds.memLight, defaultThresholds.memLight),
      memModerate: boundedThreshold(thresholds.memModerate, defaultThresholds.memModerate),
      memSevere: boundedThreshold(thresholds.memSevere, defaultThresholds.memSevere),
      diskSevereBytes: boundedThreshold(thresholds.diskSevereBytes, defaultThresholds.diskSevereBytes, 1, 1024 ** 5),
    };
  }
  const inputPolicy = normalizeAccessPolicyConfig(merged.accessPolicy);
  const modeFromPermissions = merged.permissions === 'danger_full_access'
    ? 'danger_full_access'
    : merged.permissions === 'read_only'
      ? 'chat'
      : inputPolicy.mode;
  merged.accessPolicy = normalizeAccessPolicyConfig({
    ...inputPolicy,
    mode: modeFromPermissions,
    workspaceRoot: merged.hasWorkspace
      ? (inputPolicy.workspaceRoot || merged.workspaceRoot)
      : '',
    temporaryGrants: [],
  });
  if (!merged.hasWorkspace && merged.permissions !== 'danger_full_access') {
    merged.accessPolicy.mode = 'chat';
  }
  return merged;
}

function normalizeOptionalPositiveIntegerField(
  config: Partial<Record<'modelContextTokens' | 'modelMaxOutputTokens', number>>,
  field: 'modelContextTokens' | 'modelMaxOutputTokens',
): void {
  const value = Number(config[field]);
  if (!Number.isFinite(value) || value <= 0) {
    delete config[field];
    return;
  }
  config[field] = Math.floor(value);
}

function boundedThreshold(value: unknown, fallback: number, min = 1, max = 100): number {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : fallback;
}

export function publicRunConfig(config: AgentRunConfig): AgentRunConfig {
  const { apiKey: _apiKey, ...publicConfig } = config;
  return {
    ...publicConfig,
    accessPolicy: redactAccessPolicyForPublicConfig(config.accessPolicy),
  };
}

export function resolveWebProviderRuntimeConfig(
  config: Partial<Pick<AgentRunConfig, 'webProvider' | 'webProviderKeySource'>>,
  secrets: WebProviderSecrets = {},
  env: Partial<Pick<NodeJS.ProcessEnv, 'FIRECRAWL_API_KEY' | 'FIRECRAWL_BASE_URL'>> = process.env,
): WebProviderRuntimeConfig {
  const resolved = resolveConfig(config);
  const provider = resolved.webProvider;
  const source = provider === 'firecrawl' ? resolved.webProviderKeySource : null;
  const apiKey = source === 'env' ? env.FIRECRAWL_API_KEY : secrets.firecrawlApiKey;
  return {
    provider,
    firecrawl: {
      apiKey,
      baseUrl: env.FIRECRAWL_BASE_URL,
    },
    source,
  };
}

export function publicWebProviderConfig(
  secrets: WebProviderSecrets = {},
  env: Partial<Pick<NodeJS.ProcessEnv, 'FIRECRAWL_API_KEY'>> = process.env,
): PublicWebProviderConfig {
  const configKey = secrets.firecrawlApiKey?.trim();
  const envKey = env.FIRECRAWL_API_KEY?.trim();
  const source: SecretSource | null = configKey ? 'config' : envKey ? 'env' : null;
  const key = configKey || envKey || '';
  return {
    firecrawl: {
      configured: Boolean(key),
      source,
      masked: key ? maskSecret(key) : null,
      envVar: 'FIRECRAWL_API_KEY',
    },
  };
}

function maskSecret(value: string): string {
  if (value.length <= 8) return '••••';
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

export function createConfigRepository(store: ThreadStore) {
  const UI_ONLY_FIELDS = ['themeMode', 'userAvatarId', 'customUserAvatarDataUrl'] as const;
  // PATCH 请求可能在用户快速切换下拉项时并发到达。按线程串行化读-改-写，
  // 避免后到的局部 patch 把先到的字段覆盖掉。
  const threadConfigOverrideQueues = new Map<string, Promise<ThreadConfigOverrides>>();

  function stripThreadOnlyGlobalAppearance(config: Partial<AgentRunConfig>): Partial<AgentRunConfig> {
    const { themeMode: _themeMode, ...threadConfig } = config;
    const result = { ...threadConfig } as Record<string, unknown>;
    for (const field of UI_ONLY_FIELDS) {
      delete result[field];
    }
    return result as Partial<AgentRunConfig>;
  }

  function assertNoUiFields(configPatch: Record<string, unknown>): void {
    for (const field of UI_ONLY_FIELDS) {
      if (field in configPatch) {
        throw new Error(`Field "${field}" is UI-only and cannot be set via server API`);
      }
    }
  }

  // 预设名只作为兜底：优先使用客户端传入的真实厂商显示名，
  // 绝不把 openai_compatible 这类协议 id 暴露给用户。
  function modelPresetName(config: ModelPresetConfig, fallbackName?: string): string {
    if (fallbackName?.trim()) return fallbackName.trim();
    return config.model.trim() || 'Model preset';
  }

  function normalizePersistentAccessPolicy(input: unknown): AccessPolicyConfig {
    const parsed = accessPolicyConfigSchema.parse(input ?? {});
    return normalizeAccessPolicyConfig({
      ...parsed,
      temporaryGrants: [],
    });
  }

  async function listModelPresets(): Promise<ModelPreset[]> {
    const stored = await store.getSetting<ModelPreset[]>(MODEL_PRESETS_KEY);
    return Array.isArray(stored) ? stored : [];
  }

  async function upsertModelPreset(input: {
    id?: string;
    name?: string;
    config?: Record<string, unknown>;
  }): Promise<{ preset: ModelPreset; presets: ModelPreset[] }> {
    const safeConfig = modelPresetConfigFrom(input.config ?? {});
    const presets = await listModelPresets();
    const id = input.id?.trim() || randomUUID();
    const existing = presets.find((preset) => preset.id === id);
    const now = new Date().toISOString();
    const preset: ModelPreset = {
      id,
      name: input.name?.trim() || existing?.name || modelPresetName(safeConfig),
      config: safeConfig,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    const next = existing
      ? presets.map((item) => (item.id === id ? preset : item))
      : [preset, ...presets];
    await store.setSetting(MODEL_PRESETS_KEY, next);
    return { preset, presets: next };
  }

  async function deleteModelPreset(id: string): Promise<ModelPreset[]> {
    const presets = await listModelPresets();
    const next = presets.filter((preset) => preset.id !== id);
    await store.setSetting(MODEL_PRESETS_KEY, next);
    return next;
  }

  async function listMcpServers(): Promise<McpServerConfig[]> {
    return normalizeMcpServers(await store.getSetting<unknown>(MCP_SERVERS_KEY));
  }

  async function saveMcpServers(servers: unknown): Promise<McpServerConfig[]> {
    const next = normalizeMcpServers(servers);
    await store.setSetting(MCP_SERVERS_KEY, next);
    return next;
  }

  async function getDefaultRunConfig(): Promise<AgentRunConfig> {
    const stored = await store.getSetting<Partial<AgentRunConfig>>(DEFAULT_RUN_CONFIG_KEY);
    return resolveConfig(stored ?? {});
  }

  async function saveDefaultRunConfig(configPatch: Partial<AgentRunConfig>): Promise<AgentRunConfig> {
    const current = await getDefaultRunConfig();
    const next = resolveConfig({ ...current, ...configPatch });
    await store.setSetting(DEFAULT_RUN_CONFIG_KEY, publicRunConfig(next));
    return next;
  }

  async function getGlobalAccessPolicy(): Promise<AccessPolicyConfig> {
    const stored = await store.getSetting<Partial<AccessPolicyConfig>>(ACCESS_POLICY_KEY);
    if (stored) return normalizePersistentAccessPolicy(stored);
    const config = await getDefaultRunConfig();
    return normalizePersistentAccessPolicy(config.accessPolicy);
  }

  async function saveGlobalAccessPolicy(input: unknown): Promise<AccessPolicyConfig> {
    const current = await getDefaultRunConfig();
    const nextPolicy = normalizePersistentAccessPolicy(input);
    const next = await saveDefaultRunConfig({ ...current, accessPolicy: nextPolicy });
    await store.setSetting(ACCESS_POLICY_KEY, next.accessPolicy);
    return next.accessPolicy;
  }

  function readThreadRunConfig(thread: { tags?: Record<string, string> }): Partial<AgentRunConfig> | null {
    const raw = thread.tags?.runConfig;
    if (!raw) return null;
    try {
      const { skillsRoot: _skillsRoot, ...config } = JSON.parse(raw) as Partial<AgentRunConfig>;
      const sanitized = stripThreadOnlyGlobalAppearance(config);
      if (Object.keys(sanitized).some((key) => !THREAD_TAG_OVERRIDE_KEYS.includes(key as keyof ThreadConfigOverrides))) return null;
      return sanitized;
    } catch {
      return null;
    }
  }

  function isPlainChatThread(thread: { tags?: Record<string, string> } | null): boolean {
    return thread?.tags?.conversationKind === 'chat';
  }

  function applyThreadKindRuntimeWorkspace(config: AgentRunConfig, thread: { tags?: Record<string, string> } | null): AgentRunConfig {
    if (!isPlainChatThread(thread)) return config;
    return { ...config, workspaceRoot: hiddenChatWorkspaceRoot(config.dataDir) };
  }

  function publicThreadRunConfig(config: AgentRunConfig, thread: { tags?: Record<string, string> } | null): AgentRunConfig {
    const publicConfig = publicRunConfig(config);
    return isPlainChatThread(thread) ? { ...publicConfig, hasWorkspace: false, workspaceRoot: '' } : publicConfig;
  }

  async function getThreadRunConfig(threadId: ThreadId): Promise<AgentRunConfig> {
    const thread = await store.getThread(threadId);
    const threadConfig = thread ? readThreadRunConfig(thread) : null;
    const overrides = await getThreadConfigOverrides(threadId);
    const base = await getDefaultRunConfig();
    const globalAccessPolicy = await getGlobalAccessPolicy();
    const threadAccessPolicy = await getThreadAccessPolicy(threadId);
    // Ops/task threads carry their selected workspace on ThreadMeta. Keep that
    // metadata as the runtime default unless an explicit thread access policy
    // has a different root; otherwise a newly created task silently falls back
    // to the global workspace and its harness operates on the wrong repository.
    const hasWorkspace = !isPlainChatThread(thread)
      && threadConfig?.hasWorkspace !== false
      && overrides.hasWorkspace !== false
      && (thread?.hasWorkspace !== false);
    const workspaceRoot = hasWorkspace
      ? path.resolve(
          threadAccessPolicy?.workspaceRoot
            || thread?.workspaceRoot?.trim()
            || globalAccessPolicy.workspaceRoot
            || base.workspaceRoot,
        )
      : '';
    const accessPolicy = normalizePersistentAccessPolicy({
      ...(threadAccessPolicy ?? globalAccessPolicy),
      mode: threadAccessPolicy?.mode ?? globalAccessPolicy.mode,
      workspaceRoot,
      persistentRules: [
        ...globalAccessPolicy.persistentRules,
        ...(threadAccessPolicy?.persistentRules ?? []),
      ],
      temporaryGrants: [],
    });
    return applyThreadKindRuntimeWorkspace(
      resolveConfig({
        ...base,
        ...(threadConfig ?? {}),
        ...overrides,
        hasWorkspace,
        workspaceRoot,
        accessPolicy,
      }),
      thread,
    );
  }

  async function saveThreadRunConfig(
    threadId: ThreadId,
    configPatch: Partial<AgentRunConfig>,
  ): Promise<AgentRunConfig> {
    assertNoUiFields(configPatch as Record<string, unknown>);
    const thread = await store.getThread(threadId);
    if (!thread) throw new Error(`Thread ${threadId} not found`);
    if (configPatch.accessPolicy) {
      await saveThreadAccessPolicy(threadId, configPatch.accessPolicy);
    }
    const base = await getDefaultRunConfig();
    const current = { ...base, ...(readThreadRunConfig(thread) ?? {}) };
    const safePatch = isPlainChatThread(thread) && configPatch.workspaceRoot === ''
      ? { ...configPatch, workspaceRoot: current.workspaceRoot }
      : configPatch;
    const next = applyThreadKindRuntimeWorkspace(resolveConfig({ ...current, ...safePatch }), thread);
    const publicConfig = publicRunConfig(next);
    const threadConfig: Partial<ThreadConfigOverrides> = {};
    for (const key of THREAD_TAG_OVERRIDE_KEYS) {
      const value = publicConfig[key];
      if (value !== undefined && value !== base[key]) threadConfig[key] = value as never;
    }
    await store.updateThreadMetadata(threadId, {
      tags: { ...thread.tags, runConfig: JSON.stringify(threadConfig) },
    });
    return next;
  }

  function threadConfigOverridesKey(threadId: string): string {
    return `${THREAD_CONFIG_OVERRIDES_KEY_PREFIX}${threadId}`;
  }

  function threadAccessPolicyKey(threadId: string): string {
    return `${THREAD_ACCESS_POLICY_KEY_PREFIX}${threadId}`;
  }

  function threadConfigOverridesFrom(input: Record<string, unknown>): ThreadConfigOverrides {
    const result: ThreadConfigOverrides = {};
    if (typeof input.provider === 'string') result.provider = input.provider.trim();
    if (typeof input.model === 'string') result.model = input.model.trim();
    if (typeof input.baseUrl === 'string') result.baseUrl = input.baseUrl.trim();
    if (typeof input.modelContextTokens === 'number' && Number.isInteger(input.modelContextTokens) && input.modelContextTokens > 0) {
      result.modelContextTokens = input.modelContextTokens;
    }
    if (typeof input.modelMaxOutputTokens === 'number' && Number.isInteger(input.modelMaxOutputTokens) && input.modelMaxOutputTokens > 0) {
      result.modelMaxOutputTokens = input.modelMaxOutputTokens;
    }
    if (input.permissions === 'read_only' || input.permissions === 'workspace' || input.permissions === 'danger_full_access') {
      result.permissions = input.permissions;
    }
    const effort = normalizeReasoningEffort(input.reasoningEffort);
    if (effort) result.reasoningEffort = effort;
    if (typeof input.compactionThreshold === 'number') {
      result.compactionThreshold = normalizeCompactionThreshold(input.compactionThreshold);
    }
    return result;
  }

  async function getThreadConfigOverrides(threadId: string): Promise<ThreadConfigOverrides> {
    const stored = await store.getSetting<Record<string, unknown>>(threadConfigOverridesKey(threadId));
    if (!stored) return {};
    return threadConfigOverridesFrom(stored);
  }

  async function updateThreadConfigOverrides(
    threadId: string,
    input: Record<string, unknown>,
  ): Promise<ThreadConfigOverrides> {
    const previous = threadConfigOverrideQueues.get(threadId) ?? Promise.resolve({});
    const operation = previous.catch(() => ({})).then(async () => {
      const current = await getThreadConfigOverrides(threadId);
      const safe = threadConfigOverridesFrom(input);
      const merged = threadConfigOverridesFrom({ ...current, ...safe });
      for (const key of ['modelContextTokens', 'modelMaxOutputTokens'] as const) {
        if (Object.hasOwn(input, key) && input[key] === null) {
          delete merged[key];
        }
      }
      await store.setSetting(threadConfigOverridesKey(threadId), merged);
      return merged;
    });
    threadConfigOverrideQueues.set(threadId, operation);
    try {
      return await operation;
    } finally {
      if (threadConfigOverrideQueues.get(threadId) === operation) {
        threadConfigOverrideQueues.delete(threadId);
      }
    }
  }

  async function getThreadAccessPolicy(threadId: string): Promise<AccessPolicyConfig | null> {
    const stored = await store.getSetting<Partial<AccessPolicyConfig>>(threadAccessPolicyKey(threadId));
    return stored ? normalizePersistentAccessPolicy(stored) : null;
  }

  async function saveThreadAccessPolicy(threadId: string, input: unknown): Promise<AccessPolicyConfig> {
    const safe = normalizePersistentAccessPolicy(input);
    await store.setSetting(threadAccessPolicyKey(threadId), safe);
    return safe;
  }

  return {
    deleteModelPreset,
    getDefaultRunConfig,
    getGlobalAccessPolicy,
    getThreadAccessPolicy,
    getThreadConfigOverrides,
    getThreadRunConfig,
    listMcpServers,
    listModelPresets,
    saveDefaultRunConfig,
    saveGlobalAccessPolicy,
    saveMcpServers,
    saveThreadAccessPolicy,
    saveThreadRunConfig,
    publicThreadRunConfig,
    updateThreadConfigOverrides,
    upsertModelPreset,
  };
}
