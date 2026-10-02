import type { RunConfig } from './config.js';
import type { McpConfig } from '../shared/types.js';

export const defaultConfig: RunConfig = {
  provider: 'ollama',
  model: 'qwen2.5-coder:7b',
  baseUrl: '',
  workspaceRoot: '',
  permissions: 'workspace',
  accessPolicy: {
    mode: 'workspace',
    workspaceRoot: '',
    persistentRules: [],
    temporaryGrants: [],
  },
  dataDir: '',
  skillsRoot: '',
  webSearchMode: 'auto',
  webProvider: 'native_fetch',
  webProviderKeySource: 'config',
  reasoningEffort: 'medium',
  maxIterations: 100,
  maxActiveTasks: 4,
  maxParallelReadonlyTools: 2,
  maxSubagentDepth: 1,
  modelTimeoutSeconds: 120,
  runProfile: 'runtime_os',
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
  systemMonitorEnabled: false,
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
  maxConcurrency: 4,
  toolTimeoutSeconds: 120,
  memoryThresholdPercent: 85,
  throttleNewTasks: true,
  themeMode: 'light',
  userAvatarId: 'asteroid',
  customUserAvatarDataUrl: '',
  locale: 'zh',
};

export const defaultMcps: McpConfig[] = [];

export function emptyMcp(): McpConfig {
  return { id: '', name: '', command: '', args: '', enabled: true };
}
