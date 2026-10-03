import type {
  AccessPolicyConfig,
  PermissionPresetId as ProtocolPermissionPresetId,
  ReasoningEffort as ProtocolReasoningEffort,
  WebSearchMode as ProtocolWebSearchMode,
} from '@suanlizi/protocol';

export type PermissionPresetId = ProtocolPermissionPresetId;
export type Locale = 'zh' | 'en';
export type WebSearchMode = ProtocolWebSearchMode;
export type WebProviderMode = 'native_fetch' | 'firecrawl';
export type SecretSource = 'config' | 'env';
export type ReasoningEffort = ProtocolReasoningEffort;
export type ThemeMode = 'dark' | 'light' | 'system';export type UserAvatarId = 'asteroid' | 'rocket' | 'owl' | 'crystal' | 'paper-plane' | 'fox' | 'lightning' | 'mushroom' | 'custom';

export interface RunConfig {
  /** 工作区认证只看这个布尔标记；workspaceRoot 只是位置数据。 */
  hasWorkspace: boolean;
  workspaceRoot: string;
  provider: string;
  model: string;
  baseUrl: string;
  permissions: PermissionPresetId;
  accessPolicy: AccessPolicyConfig;
  dataDir: string;
  skillsRoot: string;
  webSearchMode: WebSearchMode;
  webProvider: WebProviderMode;
  webProviderKeySource: SecretSource;
  reasoningEffort: ReasoningEffort;
  maxIterations: number;
  maxActiveTasks: number;
  maxParallelReadonlyTools: number;
  maxSubagentDepth: number;
  modelContextTokens?: number;
  modelMaxOutputTokens?: number;
  modelTimeoutSeconds: number;
  streamIdleTimeoutSeconds: number;
  eventStreamReconnectLimit: number;
  offlineReconnectLimit: number;
  /** 上下文压缩阈值：占模型上下文窗口的比例（0.3 ~ 0.95）。 */
  compactionThreshold?: number;
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
    /** 仅控制 UI 面板可见性。 */
  monitorPanelVisible: boolean;
  systemMonitorSamplingEnabled: boolean;
  systemMonitorLogRecordingEnabled: boolean;
  systemMonitorGuardEnabled: boolean;
  systemMonitorThresholds: {
    cpuLight: number;
    cpuModerate: number;
    cpuSevere: number;
    memLight: number;
    memModerate: number;
    memSevere: number;
    diskSevereBytes: number;
  };
    toolTimeoutSeconds: number;
  memoryThresholdPercent: number;
  throttleNewTasks: boolean;
  themeMode: ThemeMode;
  /** 是否全局固定右侧活动/智能体标签；未设置时用对话级 pin 状态。 */
  workbenchPinnedTabs?: boolean;
  userAvatarId: UserAvatarId;
  customUserAvatarDataUrl: string;
  locale: Locale;
}

export const RUN_CONFIG_STORAGE_KEY = 'suanlizi.config';

const USER_FIELDS: Array<keyof RunConfig> = [
  'provider',
  'model',
  'baseUrl',
  'permissions',
  'locale',
  'hasWorkspace',
  'workspaceRoot',
  'dataDir',
  'skillsRoot',
  'webSearchMode',
  'webProvider',
  'webProviderKeySource',
  'reasoningEffort',
  'maxIterations',
  'maxActiveTasks',
  'maxParallelReadonlyTools',
  'maxSubagentDepth',
  'modelContextTokens',
  'modelMaxOutputTokens',
  'modelTimeoutSeconds',
  'streamIdleTimeoutSeconds',
  'eventStreamReconnectLimit',
  'offlineReconnectLimit',
  'compactionThreshold',
  'memoryEnabled',
  'autoExtractMemories',
  'useColdMemories',
  'memoryInjectLimit',
  'memoryTokenBudget',
  'episodeMemoryEnabled',
  'episodeInjectLimit',
  'episodeTokenBudget',
  'episodeSwitchCooldownTurns',
  'episodeSealIdleMinutes',
  'episodeColdAfterDays',
  'episodeFtsCandidateLimit',
  'episodeRerankEnabled',
  'monitorPanelVisible',
  'systemMonitorSamplingEnabled',
  'systemMonitorLogRecordingEnabled',
  'systemMonitorGuardEnabled',
  'systemMonitorThresholds',
  'toolTimeoutSeconds',
  'memoryThresholdPercent',
  'throttleNewTasks',
  'themeMode',
  'workbenchPinnedTabs',
  'userAvatarId',
  'customUserAvatarDataUrl',
];

export function mergeRunConfigDefaults(
  serverDefaults: Partial<RunConfig> | undefined,
  current: Partial<RunConfig>,
): RunConfig {
  const merged = {
    hasWorkspace: true,
    memoryEnabled: true,
    autoExtractMemories: true,
    useColdMemories: true,
    memoryInjectLimit: 6,
    memoryTokenBudget: 1200,
    episodeMemoryEnabled: true,
    episodeInjectLimit: 2,
    episodeTokenBudget: 800,
    episodeSwitchCooldownTurns: 2,
    episodeSealIdleMinutes: 20,
    episodeColdAfterDays: 7,
    episodeFtsCandidateLimit: 40,
    episodeRerankEnabled: false,
    monitorPanelVisible: true,
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
    maxIterations: 100,
    maxActiveTasks: 4,
    maxParallelReadonlyTools: 2,
    maxSubagentDepth: 1,
    modelTimeoutSeconds: 120,
    streamIdleTimeoutSeconds: 300,
    eventStreamReconnectLimit: 5,
    offlineReconnectLimit: 5,
    toolTimeoutSeconds: 120,
    memoryThresholdPercent: 85,
    throttleNewTasks: true,
    ...current,
    ...serverDefaults,
  } as RunConfig;
  for (const key of USER_FIELDS) {
    // Model limits are persisted by the API and must not be replaced by a
    // stale value restored from a previous thread/localStorage snapshot.
    if ((key === 'modelContextTokens' || key === 'modelMaxOutputTokens')
      && serverDefaults?.[key] !== undefined) {
      continue;
    }
    const value = current[key];
    if (value !== '' && value !== undefined) {
      (merged as Record<keyof RunConfig, RunConfig[keyof RunConfig]>)[key] = value;
    }
  }
  return merged;
}
