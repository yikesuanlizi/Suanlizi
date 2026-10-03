import type { EventDraft } from '../features/chat/threadView.js';
import type { AccessRequest, AgentDecisionRequest, ModelPresetConfig, SuanliziErrorInfo, TemporaryAccessScope, ThreadMode, ThreadTaskPreset, ThreadExecutionStatus } from '@suanlizi/protocol';

export type { ModelPresetConfig } from '@suanlizi/protocol';

export interface McpConfig {
  id: string;
  name: string;
  command: string;
  args: string;
  enabled: boolean;
  sourceKind?: 'command' | 'url';
  sourceUrl?: string;
  sourceHint?: string;
}

export interface McpServerStatus {
  id: string;
  name: string;
  enabled: boolean;
  status: 'disabled' | 'configured' | 'starting' | 'running' | 'failed' | 'dead';
  serverInfo?: { name?: string; version?: string; title?: string };
  error?: string;
  toolCount: number;
  tools: Array<{ name: string; description?: string; namespacedName?: string }>;
  stderr?: string;
}

export interface ThreadMeta {
  threadId: string;
  hasWorkspace?: boolean;
  mode?: ThreadMode;
  taskPreset?: ThreadTaskPreset | null;
  title: string;
  workspaceRoot?: string;
  status: string;
  turnCount: number;
  createdAt: string;
  updatedAt: string;
  tags?: Record<string, string>;
  parentThreadId?: string | null;
  agentNickname?: string | null;
  agentRole?: string | null;
}

export interface MemoryRecord {
  id: string;
  type: 'preference' | 'project_fact' | 'workflow_pattern' | 'failure_lesson' | 'environment_note';
  text: string;
  status: 'active' | 'deleted';
  scope: 'global' | 'workspace' | 'thread';
  sourceThreadId?: string;
  sourceTurnIds: string[];
  workspaceRoot?: string;
  tags: string[];
  confidence: number;
  usageCount: number;
  lastUsedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ThreadSpawnEdge {
  parentThreadId: string;
  childThreadId: string;
  status: 'open' | 'closed';
  createdAt: string;
  updatedAt: string;
}

export interface ThreadRuntimeState {
  threadId: string;
  status: 'idle' | 'running' | 'stopping' | 'waiting_user_input' | 'terminal' | 'completed' | 'interrupted' | 'failed' | 'stale';
  checkpoint: unknown | null;
  resumable: boolean;
  stale: boolean;
  executionStatus?: ThreadExecutionStatus;
  terminalStatus?: 'completed' | 'failed' | 'interrupted';
  decisionRequest?: AgentDecisionRequest | null;
}

export interface ThreadItem {
  id: string;
  type: string;
  turnId?: string;
  text?: string;
  toolName?: string;
  command?: string;
  aggregatedOutput?: string;
  server?: string;
  tool?: string;
  exitCode?: number | null;
  changes?: Array<{
    path: string;
    kind: string;
    hunks?: Array<{ startLine?: number; endLine?: number; addedLines: number; removedLines: number; summary?: string }>;
    addedLines?: number;
    removedLines?: number;
    summary?: string;
  }>;
  hunks?: Array<{ path: string; startLine?: number; endLine?: number; addedLines: number; removedLines: number; summary?: string }>;
  summary?: unknown;
  trigger?: string;
  compactedTurnIds?: string[];
  retainedTurnIds?: string[];
  items?: Array<{ text: string; completed: boolean }>;
  tokensBefore?: number;
  tokensAfter?: number;
  arguments?: unknown;
  result?: unknown;
  error?: { message: string };
  info?: SuanliziErrorInfo;
  detail?: string;
  status?: string;
  message?: string;
  timestamp?: string;
  /** Item lifecycle completion timestamp used for stable elapsed-time display. */
  completedAt?: string | null;
  senderThreadId?: string;
  receiverThreadId?: string;
  newThreadId?: string;
  prompt?: string;
  agentStatus?: string;
  workflow?: unknown;
  attachments?: Array<{ name: string; path: string; mimeType?: string; url?: string }>;
  /** 远程 Agent 状态轨迹（仅 spawn_remote_agent 工具） */
  remoteStatusTrail?: Array<{ timestamp: string; state: string; text?: string }>;
  /** 远程 Agent 中间文本流（仅 spawn_remote_agent 工具） */
  remoteTextStream?: Array<{ timestamp: string; text: string }>;
  /** 回合序号（workflow_checkpoint / project_checkpoint / rollback_conflict 条目使用） */
  turnCount?: number;
  /** 工作区根路径（project_checkpoint 条目使用） */
  workspaceRoot?: string;
  /** 工程级检查点文件快照（project_checkpoint 条目使用） */
  files?: Array<{
    path: string;
    kind: 'add' | 'delete' | 'update';
    beforeContent: string | null;
    afterContent: string | null;
    beforeHash: string | null;
    afterHash: string | null;
  }>;
  // 实施点 2：harness turn 产生的 items 标记字段（可选，仅 harness 自主循环产生）
  harnessRunId?: string;
  harnessIteration?: number;
  // harness 续跑条目字段（type === 'harness_continuation'，UI 不显示）
  objective?: string;
  instruction?: string;
  evaluation?: unknown;
  visibleToUser?: boolean;
}

export interface TurnMeta {
  turnId: string;
  userInput: unknown;
  status?: string;
  startedAt?: string;
  completedAt?: string | null;
}

export interface ThreadChildInfo {
  thread: ThreadMeta;
  edge: ThreadSpawnEdge;
  state: ThreadRuntimeState;
  latestTurn: TurnMeta | null;
  latestCollabItem: ThreadItem | null;
  items?: ThreadItem[];
}

export interface SubagentStatusRow {
  threadId: string;
  parentThreadId: string;
  title: string;
  role: string;
  depth: number;
  status: string;
  statusLabel: string;
  tone: 'running' | 'success' | 'warning' | 'danger' | 'muted';
  latestAction: string;
  updatedAt: string;
}

export interface AgentStageRow extends SubagentStatusRow {
  kind: 'main' | 'child';
}

export interface WorkspaceFileEntry {
  name: string;
  path: string;
  kind: 'directory' | 'file';
  size: number;
  updatedAt: string;
  extension?: string;
}

export interface WorkspaceFilePreview {
  root: string;
  path: string;
  name: string;
  size: number;
  updatedAt: string;
  previewType: 'text' | 'markdown' | 'html' | 'image' | 'pdf' | 'office' | 'binary';
  mimeType: string;
  rawUrl?: string;
  truncated: boolean;
  text: string;
  binary: boolean;
}

export interface Usage {
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens?: number;
  cacheReported?: boolean;
  outputTokens: number;
  reasoningOutputTokens: number;
  cacheStrategy?: 'deepseek-native' | 'openai-compatible' | 'anthropic-cache-control' | 'mixed';
}

export interface ThreadUsage {
  threadId: string;
  total: Usage;
  turns: Array<{ turnId: string; usage: Usage; timestamp: string }>;
  updatedAt: string;
}

export interface EventLine {
  id: number;
  key?: string;
  kind: string;
  title: string;
  detail: string;
  tone: EventDraft['tone'];
  timestamp: string;
}

export type RunStatus = 'pending' | 'running' | 'completed' | 'failed' | 'interrupted' | 'blocked';
export type RunKind = 'turn' | 'model' | 'tool' | 'workflow' | 'subagent' | 'middleware' | 'checkpoint' | 'control';
export type RunCaller = 'lead_agent' | 'subagent' | 'middleware' | 'tool' | 'workflow';

/** 按 thread 分组的运行统计（运行监控左面板用）— Chinese: thread-grouped run stats */
export interface ThreadWithRuns {
  threadId: string;
  title: string;
  tenantId: string;
  status: string;
  runCount: number;
  lastActiveAt: string;
  parentThreadId?: string | null;
  agentNickname?: string | null;
  agentRole?: string | null;
}

export interface ControlCapability {
  enabled: boolean;
  reason?: string;
}

export interface RunControlCapabilities {
  interrupt: ControlCapability;
  resume: ControlCapability;
  rollback: ControlCapability & { checkpointIds?: string[] };
}

export interface RunRecord {
  runId: string;
  tenantId: string;
  threadId: string;
  turnId?: string | null;
  parentRunId?: string | null;
  workflowId?: string | null;
  workflowNodeId?: string | null;
  kind: RunKind;
  status: RunStatus;
  title?: string | null;
  caller: RunCaller;
  activeStep?: string | null;
  model?: string | null;
  error?: string | null;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  toolCallCount: number;
  modelCallCount: number;
  subagentCount: number;
  middlewareEventCount: number;
  firstHumanMessage?: string | null;
  lastAiMessage?: string | null;
  startedAt: string;
  updatedAt: string;
  completedAt?: string | null;
  metadata?: Record<string, unknown>;
  controlCapabilities?: RunControlCapabilities;
}

export interface RunEvent {
  eventId: string;
  runId: string;
  tenantId: string;
  threadId: string;
  turnId?: string | null;
  parentRunId?: string | null;
  workflowId?: string | null;
  workflowNodeId?: string | null;
  sequence: number;
  category: RunKind | 'approval' | 'compaction' | 'rollback' | 'memory';
  type: string;
  level: 'debug' | 'info' | 'warning' | 'error';
  message: string;
  toolName?: string | null;
  model?: string | null;
  durationMs?: number | null;
  metadata?: Record<string, unknown>;
  createdAt: string;
}

export interface ApprovalRequest {
  requestId: string;
  threadId: string;
  turnId: string;
  itemId: string;
  kind: 'command' | 'file_write' | 'tool_call' | 'network';
  description: string;
  payload: unknown;
  decision: 'prompt' | 'forbidden';
  justification?: string;
  accessRequest?: AccessRequest;
  temporaryGrantOptions?: Array<{ scope: TemporaryAccessScope; label: string }>;
}

export interface ProviderEntry {
  id: string;
  name: string;
  baseUrl: string;
  apiKeyEnvVar: string;
  protocol: 'openai' | 'anthropic';
  isLocal: boolean;
  description?: string;
  iconUrl?: string;
}

export interface ApiKeyState {
  providerId: string;
  envVar: string;
  defaultEnvVar?: string;
  envVarCandidates?: string[];
  configured: boolean;
  source: 'env' | 'config' | null;
  masked: string | null;
}

export interface WebProviderPublicConfig {
  firecrawl: {
    configured: boolean;
    source: 'env' | 'config' | null;
    masked: string | null;
    envVar: 'FIRECRAWL_API_KEY';
  };
}

export interface ModelPreset {
  id: string;
  name: string;
  config: ModelPresetConfig;
  createdAt: string;
  updatedAt: string;
}

export interface SkillDraft {
  name: string;
  description: string;
  body: string;
  source?: 'model' | 'template';
  error?: string;
}

export interface SkillEntry {
  name: string;
  description: string;
  sourcePath: string;
}

export interface BotPlatformConfig {
  enabled: boolean;
}

export type WeixinBridgeMode = 'desktop_managed' | 'external_rpc';
export type DingtalkConnectionMode = 'stream' | 'webhook';

export interface WeixinBotConfig extends BotPlatformConfig {
  bridgeMode: WeixinBridgeMode;
  bridgeUrl: string;
  accountId: string;
  activeThreadId: string;
  autoStartMonitor: boolean;
  syncHistoryOnConnect: boolean;
}

export interface DingtalkBotConfig extends BotPlatformConfig {
  connectionMode: DingtalkConnectionMode;
  clientId: string;
  clientSecret: string;
  robotCode: string;
  cardTemplateId: string;
  targetGroupName: string;
  targetGroupConversationId: string;
  targetGroupSessionWebhook: string;
  lastDetectedGroupConversationId: string;
  lastDetectedGroupSessionWebhook: string;
  lastDetectedGroupAt: string;
  allowedUsers: string[];
  webhookSecret: string;
  activeThreadId: string;
  autoStart: boolean;
}

// 钉钉 CLI (dws) 配置 — 与机器人搭配使用
export interface DwsCliConfig {
  enabled: boolean;
  binaryPath: string;
  clientId: string;
  clientSecret: string;
}

export interface BotConfig {
  weixin: WeixinBotConfig;
  feishu: BotPlatformConfig;
  dingtalk: DingtalkBotConfig;
  dwsCli: DwsCliConfig;
  qq: BotPlatformConfig;
}

export interface BotStatus {
  weixin?: {
    enabled?: boolean;
    bridgeMode?: WeixinBridgeMode;
    bridgeUrl?: string;
    connected?: boolean;
    autoStartMonitor?: boolean;
    syncHistoryOnConnect?: boolean;
    bridge?: 'online' | 'offline';
    bridgeStatus?: {
      apiUrl?: string;
      accounts?: string[];
      active?: string[];
      monitors?: Array<{
        accountId?: string;
        running?: boolean;
        pollCount?: number;
        messageCount?: number;
        webhookCount?: number;
        skippedInitialCount?: number;
        lastPollAt?: string;
        lastMessageAt?: string;
        lastWebhookAt?: string;
        lastError?: string;
        lastInboundText?: string;
        lastWebhookResult?: string;
      }>;
      error?: string;
    };
    error?: string;
  };
  feishu?: { enabled?: boolean; status?: string };
  dingtalk?: {
    enabled?: boolean;
    connectionMode?: DingtalkConnectionMode;
    configured?: boolean;
    tokenValid?: boolean;
    streamRunning?: boolean;
    robotCode?: string;
    targetGroupConfigured?: boolean;
    targetGroupName?: string;
    targetGroupConversationId?: string;
    targetGroupSessionWebhookConfigured?: boolean;
    lastDetectedGroupConversationId?: string;
    lastDetectedGroupSessionWebhookConfigured?: boolean;
    lastDetectedGroupAt?: string;
    allowedUsersCount?: number;
    autoStart?: boolean;
    error?: string;
  };
  qq?: { enabled?: boolean; status?: string };
}
