import type { KnowledgeCheckpointSummary } from './fileKnowledge.js';
import type {
  AccessEffect,
  AccessRequest,
  AccessRuleScope,
  PersistentAccessScope,
  TemporaryAccessScope,
} from './accessPolicy.js';
import type { OpsTaskPresetId } from './opsTask.js';
import type { AgentDecisionAction, AgentDecisionRequest, ThreadExecutionStatus } from './threadInteraction.js';

// ─── Thread ──────────────────────────────────────────────────────────────────
// Thread（线程/会话）：代表一次完整的对话，由若干个 Turn 组成
/** Unique identifier for a thread. */
// 线程唯一 ID，全局字符串
export type ThreadId = string;

/** 线程当前的交互入口；不改变底层 runProfile。 */
export type ThreadMode = 'chat' | 'ops';

/** 线程最近选择的 Ops 任务预设；未进入 Ops 时为空。 */
export type ThreadTaskPreset = OpsTaskPresetId;
export type ThreadTaskPresetId = ThreadTaskPreset;

/** Thread metadata persisted in SQLite. */
// 线程元信息，持久化到 SQLite
export interface ThreadMeta {
  threadId: ThreadId;
  /** 当前线程入口模式，旧数据缺失时按 chat 处理。 */
  mode?: ThreadMode;
  /** 当前线程关联的 Ops 任务预设，普通聊天线程通常为空。 */
  taskPreset?: ThreadTaskPreset | null;
  /** Legacy SQLite partition key retained for local data migration compatibility. */
  // 旧 SQLite 分区字段，仅用于本地数据迁移兼容，运行时固定为 default
  tenantId?: string;
  /** Human-readable title (may be auto-generated). */
  // 人类可读的标题（可自动生成）
  title: string;
  /** Workspace root for this thread. */
  // 本线程的工作区根目录
  workspaceRoot: string;
  /** Current status. */
  // 当前状态
  status: ThreadStatus;
  /** Number of turns in this thread. */
  // 本线程已执行的回合数
  turnCount: number;
  /** ISO-8601 */
  // 创建时间（ISO-8601 格式）
  createdAt: string;
  /** ISO-8601 */
  // 最近一次更新时间（ISO-8601 格式）
  updatedAt: string;
  /** ISO-8601, null if never archived. */
  // 归档时间（ISO-8601），未归档时为 null
  archivedAt: string | null;
  /** Whether this thread is ephemeral (in-memory only). */
  // 是否为临时线程（只存内存，不落盘）
  ephemeral: boolean;
  /** Arbitrary key-value tags. */
  // 自定义键值标签
  tags: Record<string, string>;
  /** Parent thread ID when this thread was spawned as a subagent. */
  // 父线程 ID：当前线程如果是子代理时，记录其父线程
  parentThreadId?: ThreadId | null;
  /** Human-friendly nickname for a spawned subagent. */
  // 子代理的人类友好昵称
  agentNickname?: string | null;
  /** Role label/purpose for a spawned subagent. */
  // 子代理的角色标签/用途
  agentRole?: string | null;
}

// 线程状态枚举：active（活跃）/ archived（已归档）/ compacted（已压缩）
export type ThreadStatus = 'active' | 'archived' | 'compacted';

// 父子线程派生关系的状态：open（开放）/ closed（已关闭）
export type ThreadSpawnEdgeStatus = 'open' | 'closed';

// 父子线程的派生关系边：描述一个子线程由哪个父线程生成
export interface ThreadSpawnEdge {
  tenantId?: string;
  parentThreadId: ThreadId;
  childThreadId: ThreadId;
  status: ThreadSpawnEdgeStatus;
  /** ISO-8601 */
  // 边创建时间
  createdAt: string;
  /** ISO-8601 */
  // 边最近更新时间
  updatedAt: string;
}

// ─── Turn ────────────────────────────────────────────────────────────────────
// Turn（回合）：线程内的一次用户输入与多轮模型/工具交互
export type TurnId = string;

// 回合元信息
export interface TurnMeta {
  turnId: TurnId;
  threadId: ThreadId;
  /** Zero-based index within the thread. */
  // 在线程内的回合序号（从 0 开始）
  index: number;
  /** The user input that started this turn. */
  // 触发本回合的用户输入
  userInput: UserInput;
  status: TurnStatus;
  /** ISO-8601 */
  // 开始时间
  startedAt: string;
  /** ISO-8601, null while still running. */
  // 完成时间，运行中时为 null
  completedAt: string | null;
}

// 回合状态：running（进行中）/ completed（已完成）/ failed（失败）/ cancelled（已取消）/ interrupted（被打断）
export type TurnStatus = 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted';

/** A single user input. */
// 一次用户输入：纯文本或多模态
export type UserInput = TextInput | MultimodalInput;

// 纯文本输入
export interface TextInput {
  type: 'text';
  text: string;
  /** One-shot instruction injected for this turn only. */
  // 本回合一次性注入的临时指令（不持久化）
  modeInstruction?: string;
}

// 多模态输入：可包含文本、图片等
export interface MultimodalInput {
  type: 'multimodal';
  parts: InputPart[];
  /** One-shot instruction injected for this turn only. */
  // 本回合一次性注入的临时指令
  modeInstruction?: string;
}

// 多模态输入的部件：文本 / 在线图片 / 本地图片路径
export type InputPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string; detail?: 'low' | 'high' } }
  | { type: 'image_path'; path: string; name?: string; mimeType?: string; url?: string };

// ─── Item ────────────────────────────────────────────────────────────────────
// Item（条目）：回合内的最小可记录单元，存到 JSONL 持久化
/** Unique item identifier within a thread. */
// 条目唯一 ID，在线程内唯一
export type ItemId = string;

/** All item types — the canonical persisted item union. */
// 所有条目类型的并集，持久化时按 type 字段区分
export type ThreadItem =
  | UserMessageItem
  | AgentMessageItem
  | ReasoningItem
  | CommandExecutionItem
  | FileChangeItem
  | WorkflowCheckpointItem
  | ProjectCheckpointItem
  | RollbackConflictItem
  | ContextCompactionItem
  | ToolCallItem
  | CollabToolCallItem
  | McpToolCallItem
  | WebSearchItem
  | TodoListItem
  | ErrorItem
  | HarnessContinuationItem;

// 用户消息条目：来自用户的输入
export interface UserMessageItem {
  id: ItemId;
  type: 'user_message';
  turnId: TurnId;
  text: string;
  /** ISO-8601 timestamp used by transcript action rows. */
  // 时间戳（ISO-8601），用于会话转录
  timestamp?: string;
  /** 实施点 2：harness 续跑作为 user-side 输入时也打标记 */
  harnessRunId?: string;
  harnessIteration?: number;
  /** P6.3: 关联的 runId，用于 run monitor timeline 严格按 run 过滤 */
  // — Chinese: associated runId for strict run-scoped timeline filtering
  runId?: string;
  attachments?: Array<{ name: string; path: string; mimeType?: string; url?: string }>;
}

export type ProviderAssistantFrame =
  | {
      format: 'openai_chat';
      content: string | null;
      toolCalls?: unknown[];
      reasoningContent?: string;
      reasoningDetails?: unknown[];
    }
  | {
      format: 'openai_responses';
      outputItems: unknown[];
    }
  | {
      format: 'anthropic_messages';
      contentBlocks: unknown[];
    };

export interface ProviderToolCallFrame {
  format: 'openai_chat' | 'openai_responses' | 'anthropic_messages';
  id: string;
  name: string;
  arguments: unknown;
  raw?: unknown;
}

// 智能体消息条目：来自模型的回复
export interface AgentMessageItem {
  id: ItemId;
  type: 'agent_message';
  turnId: TurnId;
  text: string;
  /** Optional structured output (JSON). */
  // 可选的结构化输出（JSON）
  structuredOutput?: unknown;
  /** Provider-native assistant response frame used for structured history replay. */
  // 用于结构化历史回放的 provider 原生 assistant 响应帧
  providerFrame?: ProviderAssistantFrame;
  /** ISO-8601 timestamp used by transcript action rows. */
  // 时间戳（ISO-8601）
  timestamp?: string;
  /** 实施点 2：harness turn 产生的普通 items 打 harnessRunId 标记 */
  harnessRunId?: string;
  harnessIteration?: number;
  /** P6.3: 关联的 runId，用于 run monitor timeline 严格按 run 过滤 */
  // — Chinese: associated runId for strict run-scoped timeline filtering
  runId?: string;
  /** Set when runtime discarded a plain-text tool-call placeholder before persistence. */
  rejectedReason?: string;
}

// 推理过程条目：模型的思考过程（chain-of-thought）
export interface ReasoningItem {
  id: ItemId;
  type: 'reasoning';
  turnId: TurnId;
  text: string;
  /** Optional provider frame id associated with this reasoning item. */
  // 关联的 provider frame id，避免把推理文本直接回灌给模型
  providerFrameRef?: string;
  timestamp?: string;
  /** ISO-8601 completion time for stable reasoning-duration rendering. */
  completedAt?: string;
  harnessRunId?: string;
  harnessIteration?: number;
  /** P6.3: 关联的 runId，用于 run monitor timeline 严格按 run 过滤 */
  // — Chinese: associated runId for strict run-scoped timeline filtering
  runId?: string;
}

// 命令执行状态：in_progress（进行中）/ completed（已完成）/ failed（失败）
export type CommandStatus = 'in_progress' | 'completed' | 'failed';

// shell 命令执行条目
export interface CommandExecutionItem {
  id: ItemId;
  type: 'command_execution';
  turnId: TurnId;
  command: string;
  aggregatedOutput: string;
  exitCode: number | null;
  status: CommandStatus;
  timestamp?: string;
  /** ISO-8601 completion time for reliable elapsed-time rendering. */
  completedAt?: string;
  harnessRunId?: string;
  harnessIteration?: number;
  /** P6.3: 关联的 runId，用于 run monitor timeline 严格按 run 过滤 */
  // — Chinese: associated runId for strict run-scoped timeline filtering
  runId?: string;
}

// 补丁变更类型：add（新增）/ delete（删除）/ update（更新）
export type PatchChangeKind = 'add' | 'delete' | 'update';
// 补丁应用状态：completed（成功）/ failed（失败）
export type PatchApplyStatus = 'completed' | 'failed';

// 单个文件变更 hunk（差异段）
export interface FileChangeHunk {
  path: string;
  startLine?: number;
  endLine?: number;
  addedLines: number;
  removedLines: number;
  // 实际新增的行内容（不含 '+' 前缀）；旧数据无此字段时降级为空数组
  addedLinesContent: string[];
  // 实际删除的行内容（不含 '-' 前缀）；旧数据无此字段时降级为空数组
  removedLinesContent: string[];
  summary?: string;
}

// 文件更新变更单元
export interface FileUpdateChange {
  path: string;
  kind: PatchChangeKind;
  hunks?: FileChangeHunk[];
  addedLines?: number;
  removedLines?: number;
  summary?: string;
}

// 文件变更条目：一次工具调用可能产生多处文件变更
export interface FileChangeItem {
  id: ItemId;
  type: 'file_change';
  turnId: TurnId;
  changes: FileUpdateChange[];
  hunks?: FileChangeHunk[];
  summary?: string;
  status: PatchApplyStatus;
  timestamp?: string;
  /** ISO-8601 completion time for reliable elapsed-time rendering. */
  completedAt?: string;
  harnessRunId?: string;
  harnessIteration?: number;
  /** P6.3: 关联的 runId，用于 run monitor timeline 严格按 run 过滤 */
  // — Chinese: associated runId for strict run-scoped timeline filtering
  runId?: string;
}

// 工作流检查点条目：用于工作流的回放/恢复
export interface WorkflowCheckpointItem {
  id: ItemId;
  type: 'workflow_checkpoint';
  turnId: TurnId;
  turnCount: number;
  workflow: unknown;
  timestamp?: string;
  harnessRunId?: string;
  harnessIteration?: number;
  /** P6.3: 关联的 runId，用于 run monitor timeline 严格按 run 过滤 */
  // — Chinese: associated runId for strict run-scoped timeline filtering
  runId?: string;
}

// 工程级检查点里的单个文件快照
export interface ProjectFileCheckpoint {
  path: string;
  kind: PatchChangeKind;
  beforeContent: string | null;
  afterContent: string | null;
  beforeHash: string | null;
  afterHash: string | null;
}

// 工程级检查点条目：记录某回合下所有被改动文件的快照
export interface ProjectCheckpointItem {
  id: ItemId;
  type: 'project_checkpoint';
  turnId: TurnId;
  turnCount: number;
  workspaceRoot: string;
  files: ProjectFileCheckpoint[];
  knowledge?: KnowledgeCheckpointSummary;
  timestamp?: string;
  harnessRunId?: string;
  harnessIteration?: number;
  /** P6.3: 关联的 runId，用于 run monitor timeline 严格按 run 过滤 */
  // — Chinese: associated runId for strict run-scoped timeline filtering
  runId?: string;
}

// 回滚冲突条目：回滚时遇到文件被修改、哈希不一致等冲突
export interface RollbackConflictItem {
  id: ItemId;
  type: 'rollback_conflict';
  turnId: TurnId;
  turnCount: number;
  message: string;
  conflicts: Array<{
    path: string;
    reason: string;
    expectedHash?: string | null;
    actualHash?: string | null;
  }>;
  timestamp?: string;
  harnessRunId?: string;
  harnessIteration?: number;
  /** P6.3: 关联的 runId，用于 run monitor timeline 严格按 run 过滤 */
  // — Chinese: associated runId for strict run-scoped timeline filtering
  runId?: string;
}

// 通用工件引用：跨线程/跨工具的轻量指针，避免传递大段内容
export interface ArtifactRef {
  kind: 'file_segment' | 'tool_result' | 'mcp_result';
  path?: string;
  startLine?: number;
  endLine?: number;
  sha256?: string;
  excerpt?: string;
  sourceToolCallId?: ItemId;
}

// 文件片段引用：精确定位到文件某一段
export interface FileSegmentRef extends ArtifactRef {
  kind: 'file_segment';
  path: string;
  startLine: number;
  endLine: number;
}

// 上下文压缩摘要：把多轮对话压缩为固定字段的结构化摘要
export interface CompactionSummary {
  userGoal: string; // 用户目标
  completedWork: string; // 已完成工作
  keyConstraints: string; // 关键约束
  filesAndArtifacts: string; // 涉及的文件与工件
  toolResults: string; // 工具调用结果
  subagentResults: string; // 子代理结果
  openTasks: string; // 待办任务
  risks: string; // 风险点
  raw: string; // 原始摘要
}

// 上下文压缩计划：哪些回合要被压缩、哪些保留
export interface CompactionPlan {
  compactedTurnIds: TurnId[];
  retainedTurnIds: TurnId[];
  tokensBefore: number;
  tokensAfterEstimate: number;
  trigger: 'manual' | 'auto';
}

// 压缩策略：llm（用模型生成摘要）/ local（本地规则摘要）
export type CompactionStrategy = 'llm' | 'local';

// 已压缩区间：记录压缩后的状态以便回看
export interface CompactedRange {
  compactedTurnIds: TurnId[];
  retainedTurnIds: TurnId[];
  compactionItemId: ItemId;
  summary: string;
  tokensBefore: number;
  tokensAfter: number;
  createdAt: string;
  trigger: 'manual' | 'auto';
  strategy: CompactionStrategy;
}

// 上下文压缩事件条目：写入到 JSONL 的压缩记录
export interface ContextCompactionItem {
  id: ItemId;
  type: 'context_compaction';
  turnId: TurnId;
  status: CommandStatus;
  trigger: 'manual' | 'auto';
  compactedTurnIds: TurnId[];
  retainedTurnIds: TurnId[];
  summary?: CompactionSummary;
  tokensBefore: number;
  tokensAfter: number;
  error?: { message: string; code?: string };
  timestamp?: string;
  harnessRunId?: string;
  harnessIteration?: number;
  /** P6.3: 关联的 runId，用于 run monitor timeline 严格按 run 过滤 */
  // — Chinese: associated runId for strict run-scoped timeline filtering
  runId?: string;
}

// 记忆记录类型：偏好/项目事实/工作流模式/失败教训/环境备注
export type MemoryRecordType =
  | 'preference'
  | 'project_fact'
  | 'workflow_pattern'
  | 'failure_lesson'
  | 'environment_note';

// 记忆记录状态：active（启用）/ deleted（已删除）
export type MemoryRecordStatus = 'active' | 'deleted';
// 记忆作用域：global（全局）/ workspace（工作区）/ thread（线程）
export type MemoryRecordScope = 'global' | 'workspace' | 'thread';

// 记忆记录：从长期记忆中检索出的单元
export interface MemoryRecord {
  tenantId?: string;
  id: string;
  type: MemoryRecordType;
  text: string;
  status: MemoryRecordStatus;
  scope: MemoryRecordScope;
  sourceThreadId?: ThreadId;
  sourceTurnIds: TurnId[];
  workspaceRoot?: string;
  tags: string[];
  confidence: number;
  usageCount: number;
  lastUsedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

// 记忆检索选项
export interface MemorySearchOptions {
  workspaceRoot?: string;
  limit?: number;
  types?: MemoryRecordType[];
}

// ─── Episode Memory ─────────────────────────────────────────────────────────
// Episode（任务段）记忆：把一段连续的回合打包成可检索、可切换的上下文单元

export type EpisodeLifecycle = 'open' | 'sealed' | 'stale' | 'rolled_back';
export type EpisodeTemperature = 'warm' | 'cold';
export type ThreadMemoryMode = 'enabled' | 'disabled' | 'polluted';

export interface EpisodeRecord {
  tenantId?: string;
  id: string;
  workspaceRoot: string;
  sourceThreadId: ThreadId;
  sourceTurnStart: TurnId;
  sourceTurnEnd: TurnId;
  sourceTurnStartIndex: number;
  sourceTurnEndIndex: number;
  lifecycle: EpisodeLifecycle;
  temperature: EpisodeTemperature;
  title: string;
  objective: string;
  summary: string;
  facts: string[];
  decisions: string[];
  artifacts: string[];
  openTasks: string[];
  entities: string[];
  keywords: string[];
  boundaryReason: string;
  fingerprint: string;
  topicKey: string;
  usageCount: number;
  lastActivatedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ThreadWorkingSetSnapshot {
  threadId: ThreadId;
  generation: number;
  activeEpisodeIds: string[];
  injectedEpisodeIds: string[];
  frozenPromptBlock: string;
  builtFromTurnId: TurnId;
  builtFromTurnIndex: number;
  taskFingerprint: string;
  /** Stable identity of the active task segment (objective + goal + artifacts). */
  episodeIdentity?: string;
  createdAt: string;
  updatedAt: string;
}

export type EpisodeMemoryMode = 'enabled' | 'disabled' | 'polluted';

export interface EpisodeSearchOptions {
  workspaceRoot?: string;
  threadId?: ThreadId;
  lifecycle?: EpisodeLifecycle[];
  temperature?: EpisodeTemperature[];
  limit?: number;
  tokenBudget?: number;
  excludeEpisodeIds?: string[];
  activeEpisodeIds?: string[];
  injectedEpisodeIds?: string[];
}

export interface EpisodeSearchResult {
  score: number;
  reason: string;
  episode: EpisodeRecord;
}

/** Generic tool call (non-MCP tools registered in the local OS). */
// 通用工具调用条目：MCP 之外的本地工具调用
export interface ToolCallItem {
  id: ItemId;
  type: 'tool_call';
  turnId: TurnId;
  toolName: string;
  arguments: Record<string, unknown>;
  /** Model-provided tool call id; distinct from Suanlizi item id. */
  // 模型返回的 tool call id，不等于 Suanlizi item id
  modelToolCallId?: string;
  modelToolName?: string;
  providerToolCall?: ProviderToolCallFrame;
  result?: unknown;
  error?: { message: string; code?: string };
  status: CommandStatus;
  timestamp?: string;
  /** ISO-8601 completion time; absent only while the call is running. */
  completedAt?: string;
  harnessRunId?: string;
  harnessIteration?: number;
  /** P6.3: 关联的 runId，用于 run monitor timeline 严格按 run 过滤 */
  // — Chinese: associated runId for strict run-scoped timeline filtering
  runId?: string;
}

// 协作类工具名：spawn_agent / send_input / wait 等子代理协作原语
export type CollabToolName =
  | 'spawn_agent'
  | 'send_input'
  | 'send_message'
  | 'followup_task'
  | 'resume_agent'
  | 'wait'
  | 'wait_agent'
  | 'list_agents'
  | 'close_agent'
  | 'spawn_remote_agent';

// 协作工具调用条目：记录一次子代理协作动作
export interface CollabToolCallItem {
  id: ItemId;
  type: 'collab_tool_call';
  turnId: TurnId;
  tool: CollabToolName;
  modelToolCallId?: string;
  modelToolName?: string;
  providerToolCall?: ProviderToolCallFrame;
  status: CommandStatus;
  senderThreadId: ThreadId;
  receiverThreadId?: ThreadId;
  newThreadId?: ThreadId;
  prompt?: string;
  agentStatus?: ThreadSpawnEdgeStatus | TurnStatus | 'running';
  result?: unknown;
  error?: { message: string; code?: string };
  timestamp?: string;
  /** ISO-8601 completion time; absent only while the call is running. */
  completedAt?: string;
  /**
   * 远程 Agent 调用专用：状态变化轨迹。
   * 每次 status-update 事件追加一条，记录状态、时间戳、中间文本（若有）。
   * 前端用于展示 working → input-required → completed 的过程。
   */
  // — Chinese: remote agent status trail. One entry per status-update event.
  remoteStatusTrail?: RemoteAgentStatusEntry[];
  /**
   * 远程 Agent 调用专用：中间文本片段流。
   * 每次 status-update.message 携带的中间文本追加一条，前端以流式消息形式展示。
   * 与 remoteStatusTrail 互补：trail 记录状态，stream 记录文本。
   */
  // — Chinese: remote agent intermediate text stream. One entry per status-update.message.
  remoteTextStream?: RemoteAgentTextChunk[];
  harnessRunId?: string;
  harnessIteration?: number;
  /** P6.3: 关联的 runId，用于 run monitor timeline 严格按 run 过滤 */
  // — Chinese: associated runId for strict run-scoped timeline filtering
  runId?: string;
}

/** 远程 Agent 状态轨迹条目。 */
// — Chinese: remote agent status trail entry
export interface RemoteAgentStatusEntry {
  /** ISO-8601 时间戳 */
  timestamp: string;
  /** A2A TaskState：working / input-required / completed / failed / canceled 等 */
  state: string;
  /** 状态附带的中间文本（来自 status.message.parts.text），可选 */
  text?: string;
}

/** 远程 Agent 中间文本片段。 */
// — Chinese: remote agent intermediate text chunk
export interface RemoteAgentTextChunk {
  /** ISO-8601 时间戳 */
  timestamp: string;
  /** 文本内容 */
  text: string;
}

// 智能体交接信封：父代理把任务交给子代理时携带的上下文包
export interface AgentTransferEnvelope {
  schemaVersion: 1;
  senderThreadId: ThreadId;
  receiverThreadId: ThreadId;
  role: string;
  nickname: string;
  task: string;
  locale: string;
  webSearchMode: string;
  permissions: {
    level: string;
    networkAllowed: boolean;
    presetId?: string;
  };
  constraints: Array<{
    layer:
      | 'project_agents_md'
      | 'thread_config'
      | 'parent_delegation'
      | 'skills_mcp_web_search'
      | 'subagent_role';
    text: string;
  }>;
  contextRefs: ArtifactRef[];
  artifacts: ArtifactRef[];
  summary: string;
  limits: {
    maxSubagents: number;
    largePayloadPolicy: 'artifact_refs';
  };
}

// MCP 工具调用条目：调用 MCP 服务器上的工具
export interface McpToolCallItem {
  id: ItemId;
  type: 'mcp_tool_call';
  turnId: TurnId;
  server: string;
  tool: string;
  arguments: unknown;
  modelToolCallId?: string;
  modelToolName?: string;
  providerToolCall?: ProviderToolCallFrame;
  result?: {
    content: unknown[];
    structuredContent: unknown;
  };
  error?: { message: string; code?: string };
  status: CommandStatus;
  timestamp?: string;
  /** ISO-8601 completion time; absent only while the call is running. */
  completedAt?: string;
  harnessRunId?: string;
  harnessIteration?: number;
  /** P6.3: 关联的 runId，用于 run monitor timeline 严格按 run 过滤 */
  // — Chinese: associated runId for strict run-scoped timeline filtering
  runId?: string;
}

// Web 搜索条目：记录一次网络搜索动作
export interface WebSearchItem {
  id: ItemId;
  type: 'web_search';
  turnId: TurnId;
  query: string;
  timestamp?: string;
  harnessRunId?: string;
  harnessIteration?: number;
  /** P6.3: 关联的 runId，用于 run monitor timeline 严格按 run 过滤 */
  // — Chinese: associated runId for strict run-scoped timeline filtering
  runId?: string;
}

// 待办条目项
export interface TodoItemEntry {
  text: string;
  completed: boolean;
}

// 待办清单条目：模型维护的 to-do 列表
export interface TodoListItem {
  id: ItemId;
  type: 'todo_list';
  turnId: TurnId;
  items: TodoItemEntry[];
  timestamp?: string;
  harnessRunId?: string;
  harnessIteration?: number;
  /** P6.3: 关联的 runId，用于 run monitor timeline 严格按 run 过滤 */
  // — Chinese: associated runId for strict run-scoped timeline filtering
  runId?: string;
}

// 错误条目：在回合内出现的可恢复/不可恢复错误
export interface ErrorItem {
  id: ItemId;
  type: 'error';
  turnId: TurnId;
  message: string;
  info?: SuanliziErrorInfo;
  detail?: string;
  recoverable?: boolean;
  timestamp?: string;
  harnessRunId?: string;
  harnessIteration?: number;
  /** P6.3: 关联的 runId，用于 run monitor timeline 严格按 run 过滤 */
  // — Chinese: associated runId for strict run-scoped timeline filtering
  runId?: string;
}

// ─── Events ──────────────────────────────────────────────────────────────────
// Events（事件）：运行时对外推送的所有流式事件类型

// Suanlizi 错误分类：用于错误处理与重试策略
export type SuanliziErrorKind =
  | 'ContextWindowExceeded' // 上下文窗口超出
  | 'UsageLimitExceeded' // 用量上限
  | 'ServerOverloaded' // 服务端过载
  | 'HttpConnectionFailed' // HTTP 连接失败
  | 'ResponseStreamConnectionFailed' // 流式响应连接失败
  | 'InternalServerError' // 服务端内部错误
  | 'Unauthorized' // 未授权
  | 'BadRequest' // 错误请求
  | 'SandboxError' // 沙箱错误
  | 'ResponseStreamDisconnected' // 流式响应中断
  | 'ResponseTooManyFailedAttempts' // 重试次数耗尽
  | 'ActiveTurnNotSteerable' // 活跃回合不可被引导
  | 'ThreadRollbackFailed' // 线程回滚失败
  | 'Other'; // 其它

// 错误附加信息
export interface SuanliziErrorInfo {
  kind: SuanliziErrorKind;
  httpStatusCode?: number; // HTTP 状态码
  turnKind?: string; // 触发错误的回合类型
  /** 更细的原因，用于区分超时、主动取消和 provider/协议错误。 */
  reason?: 'timeout' | 'cancelled' | 'network' | 'provider' | 'protocol';
  /** 触发超时的配置值（毫秒），仅在 reason=timeout 时提供。 */
  timeoutMs?: number;
}

/** Token usage for a turn. */
// 单回合 token 用量统计
export interface Usage {
  inputTokens: number; // 输入 token
  cachedInputTokens: number; // 命中缓存的输入 token
  /** Provider-reported prompt-cache creation tokens, when available. */
  cacheWriteTokens?: number;
  /** Whether the provider explicitly reported the cache count. */
  cacheReported?: boolean;
  outputTokens: number; // 输出 token
  reasoningOutputTokens: number; // 推理过程 token
  cacheStrategy?: 'deepseek-native' | 'openai-compatible' | 'anthropic-cache-control' | 'mixed';
}

// 单回合用量记录
export interface TurnUsage {
  turnId: TurnId;
  usage: Usage;
  timestamp: string;
}

// 线程级累计用量：包含每个回合与总计
export interface ThreadUsage {
  threadId: ThreadId;
  total: Usage;
  turns: TurnUsage[];
  updatedAt: string;
  includedThreadIds?: ThreadId[]; // 跨线程汇总时列出包含的线程
}

// 重试策略：指数退避 + 上下限
export interface RetryPolicy {
  maxAttempts: number; // 最大尝试次数
  initialDelayMs: number; // 初始退避毫秒
  maxDelayMs: number; // 最大退避毫秒
}

// 模型重试事件：流式上报让前端展示
export interface ModelRetryEvent {
  type: 'model.retry';
  threadId: ThreadId;
  turnId: TurnId;
  attempt: number; // 当前重试次数
  maxAttempts: number; // 最大重试次数
  delayMs: number; // 本次等待毫秒
  status?: number; // 上次失败的 HTTP 状态码
  error?: string; // 上次失败原因
}

// 上下文 token 估算更新事件：用于前端展示上下文使用率
export interface ContextTokenEstimateUpdatedEvent {
  type: 'context.token_estimate.updated';
  threadId: ThreadId;
  turnId: TurnId;
  estimate: {
    inputTokens: number; // 估算的输入 token
    messageCount: number; // 消息数
    imageCount: number; // 图片数
    charCount: number; // 字符数
  };
}

// 上下文压缩压力事件：分级提示 ok/soft/hard
export interface ContextCompactionPressureEvent {
  type: 'context.compaction_pressure';
  threadId: ThreadId;
  turnId: TurnId;
  pressure: {
    estimatedTokens: number; // 估算 token
    maxTokens: number; // 上下文窗口
    softThreshold: number; // 软阈值（提示）
    hardThreshold: number; // 硬阈值（强制压缩）
    ratio: number; // 占用比例
    /** 是否来自真实模型上下文配置；false 时 maxTokens 可能只是运行时安全 fallback。 */
    windowKnown?: boolean;
    status: 'ok' | 'soft' | 'hard';
    window?: {
      ordinal: number; // 窗口序号
      prefillInputTokens: number | null; // 预填 token
    };
  };
}

// 审批日志条目：记录一次审批请求与最终结果
export interface ApprovalLogEntry {
  requestId: string;
  threadId: ThreadId;
  turnId: TurnId;
  itemId: ItemId;
  kind: ApprovalRequest['kind'];
  description: string;
  approved: boolean;
  reason?: string;
  status: 'approved' | 'denied' | 'timeout';
  requestedAt: string;
  resolvedAt: string;
}

// 子代理事件：把子线程事件透传到父线程
export interface ChildAgentEvent {
  type: 'child_agent.event';
  threadId: ThreadId;
  childThreadId: ThreadId;
  agentNickname?: string | null;
  agentRole?: string | null;
  event: Record<string, unknown>;
}

// 缓存诊断事件：system / tools 哈希变化时上报
export interface CacheDiagnosticsEvent {
  type: 'cache.diagnostics';
  threadId: ThreadId;
  turnId: TurnId;
  shape: {
    systemHash: string; // 系统提示哈希
    toolsHash: string; // 工具 schema 哈希
    prefixHash: string; // 前缀哈希
  };
  stable: boolean; // 是否稳定
  reasons: Array<'system' | 'tools'>; // 不稳定原因
}

/** Union of all streaming events. */
// 所有流式事件的并集，type 字段是判别式
export type ThreadEvent =
  | ThreadStartedEvent
  | TurnStartedEvent
  | TurnCompletedEvent
  | TurnFailedEvent
  | ThreadRuntimeUpdatedEvent
  | AgentDecisionRequestedEvent
  | AgentDecisionResolvedEvent
  | WarningEvent
  | StreamErrorEvent
  | ModelOutputRejectedEvent
  | ItemStartedEvent
  | ItemUpdatedEvent
  | ItemCompletedEvent
  | ItemDiscardedEvent
  | AgentMessageDeltaEvent
  | CommandOutputDeltaEvent
  | TokenUsageUpdatedEvent
  | TurnDiffUpdatedEvent
  | ModelRetryEvent
  | ContextTokenEstimateUpdatedEvent
  | ContextCompactionPressureEvent
  | ApprovalResolvedEvent
  | ApprovalRequiredEvent
  | CompactedEvent
  | ContextCompactedV2Event
  | ThreadRollbackCompletedEvent
  | ThreadRollbackFailedEvent
  | ResumedEvent
  | EpisodeWorkingSetRebuiltEvent
  | ChildAgentEvent
  | CacheDiagnosticsEvent
  | ThreadMetadataUpdatedEvent
  | HarnessStateUpdatedEvent
  | TaskRuntimeUpdatedEvent
  | TaskRunUpdatedEvent
  | TaskRunTerminalEvent
  | WorkflowRunUpdatedEvent
  | WorkflowRunTerminalEvent
  | WorkflowAgentCallUpdatedEvent
  | WorkflowAgentCallTerminalEvent
  | WorkflowRequestCreatedEvent
  | WorkflowRequestDecidedEvent
  | WorkflowEvidenceCreatedEvent
  | WorkflowResultCreatedEvent
  | TaskGoalEvaluationAvailableEvent
  | TaskCognitionUpdatedEvent
  | TaskContextUpdatedEvent
  | TaskLoopUpdatedEvent
  | ErrorEvent;

// 线程已创建事件
export interface ThreadStartedEvent {
  type: 'thread.started';
  threadId: ThreadId;
  thread: ThreadMeta;
}

// 线程元数据更新事件：标题、状态等变更
export interface ThreadMetadataUpdatedEvent {
  type: 'thread.metadata.updated';
  threadId: ThreadId;
  title?: string;
  status?: string;
}

// 回合开始事件
export interface TurnStartedEvent {
  type: 'turn.started';
  threadId: ThreadId;
  turnId: TurnId;
  runId: string;
  turnIndex: number;
}

// 回合完成事件
export interface TurnCompletedEvent {
  type: 'turn.completed';
  threadId: ThreadId;
  turnId: TurnId;
  runId: string;
  usage: Usage | null;
  status?: 'completed' | 'interrupted';
}

// 回合失败事件
export interface TurnFailedEvent {
  type: 'turn.failed';
  threadId: ThreadId;
  turnId: TurnId;
  runId: string;
  error: { message: string; info?: SuanliziErrorInfo };
}

export interface ThreadRuntimeUpdatedEvent {
  type: 'thread.runtime.updated';
  threadId: ThreadId;
  turnId?: TurnId;
  runId?: string;
  status: ThreadExecutionStatus;
  terminalStatus?: 'completed' | 'failed' | 'interrupted';
  decisionRequest?: AgentDecisionRequest | null;
}

export interface AgentDecisionRequestedEvent {
  type: 'agent.decision.requested';
  threadId: ThreadId;
  turnId: TurnId;
  request: AgentDecisionRequest;
}

export interface AgentDecisionResolvedEvent {
  type: 'agent.decision.resolved';
  threadId: ThreadId;
  turnId: TurnId;
  requestId: string;
  action: AgentDecisionAction;
  optionId?: string;
  customInput?: string;
}

// 通用警告事件
export interface WarningEvent {
  type: 'warning';
  threadId?: ThreadId;
  turnId?: TurnId;
  message: string;
  info?: SuanliziErrorInfo;
}

// 流式响应错误事件
export interface StreamErrorEvent {
  type: 'stream.error';
  threadId: ThreadId;
  turnId: TurnId;
  message: string;
  recoverable: boolean;
  error: { message: string; info?: SuanliziErrorInfo };
  additionalDetails?: string;
}

// 模型输出被拒绝事件：模型产出违反协议时触发
export interface ModelOutputRejectedEvent {
  type: 'model.output.rejected';
  threadId: ThreadId;
  turnId: TurnId;
  message: string;
  error: { message: string; info?: SuanliziErrorInfo };
}

// 条目开始事件
export interface ItemStartedEvent {
  type: 'item.started';
  threadId: ThreadId;
  turnId: TurnId;
  item: ThreadItem;
}

// 条目更新事件（流式内容追加）
export interface ItemUpdatedEvent {
  type: 'item.updated';
  threadId: ThreadId;
  turnId: TurnId;
  item: ThreadItem;
}

// 条目完成事件
export interface ItemCompletedEvent {
  type: 'item.completed';
  threadId: ThreadId;
  turnId: TurnId;
  item: ThreadItem;
}

// 条目丢弃事件：撤回流式阶段产生、但最终不应保留的临时条目
export interface ItemDiscardedEvent {
  type: 'item.discarded';
  threadId: ThreadId;
  turnId: TurnId;
  itemId: ItemId;
}

/** Streaming text delta from the agent. */
// 模型消息流式增量
export interface AgentMessageDeltaEvent {
  type: 'agent_message.delta';
  threadId: ThreadId;
  turnId: TurnId;
  itemId: ItemId;
  delta: string;
}

/** Streaming output from a running command. */
// shell 命令输出流式增量
export interface CommandOutputDeltaEvent {
  type: 'command_output.delta';
  threadId: ThreadId;
  turnId: TurnId;
  itemId: ItemId;
  delta: string;
}

// 线程 token 用量更新事件
export interface TokenUsageUpdatedEvent {
  type: 'thread.token_usage.updated';
  threadId: ThreadId;
  usage: ThreadUsage;
}

// 回合文件 diff 增量更新事件
export interface TurnDiffUpdatedEvent {
  type: 'turn.diff.updated';
  threadId: ThreadId;
  turnId: TurnId;
  diff: string;
}

// 审批已处理事件
export interface ApprovalResolvedEvent {
  type: 'approval.resolved';
  threadId: ThreadId;
  turnId: TurnId;
  requestId: string;
  approved: boolean;
  reason?: string;
  status: ApprovalLogEntry['status'];
}

/** HITL approval is needed before executing a command/tool. */
// 需要人工审批事件：执行命令/工具前下发到前端
export interface ApprovalRequiredEvent {
  type: 'approval.required';
  threadId: ThreadId;
  turnId: TurnId;
  itemId: ItemId;
  requestId: string;
  /** What needs approval. */
  // 待审批类型
  kind: 'command' | 'file_write' | 'tool_call' | 'network';
  /** Human-readable description. */
  // 人类可读描述
  description: string;
  /** The raw command or tool arguments. */
  // 待执行的命令或工具参数原文
  payload: unknown;
  /** The sandbox decision that triggered this. */
  // 沙箱做出的决策：提示审批 / 直接禁止
  decision: 'prompt' | 'forbidden';
  /** Optional justification from the policy. */
  // 策略层的解释（可选）
  justification?: string;
  /** Structured access request that triggered the approval. */
  // 触发本次审批的结构化访问请求
  accessRequest?: AccessRequest;
  /** Runtime-only temporary grant scopes the user may choose from. */
  // 可选择的临时授权范围；不写持久设置
  temporaryGrantOptions?: Array<{
    scope: TemporaryAccessScope;
    label: string;
  }>;
  /** Policy rule that produced this decision, when applicable. */
  // 命中的权限规则（如有）
  matchedRule?: {
    id: string;
    scope: AccessRuleScope | TemporaryAccessScope;
    effect: AccessEffect;
  };
}

/** Emitted when context is compacted mid-conversation. */
// 上下文压缩完成事件（旧版）
export interface CompactedEvent {
  type: 'thread.compacted';
  threadId: ThreadId;
  /** Number of turns summarized. */
  compactedTurns: number;
  /** Token count before compaction. */
  tokensBefore: number;
  /** Token count after compaction. */
  tokensAfter: number;
}

// 上下文压缩 V2 事件：分阶段上报 started/completed/failed
export interface ContextCompactedV2Event {
  type: 'thread.compacted.v2';
  threadId: ThreadId;
  turnId: TurnId;
  phase: 'started' | 'completed' | 'failed';
  trigger: 'manual' | 'auto';
  strategy?: CompactionStrategy;
  compactedTurns?: number;
  tokensBefore?: number;
  tokensAfter?: number;
  item?: { id: ItemId } & Partial<ContextCompactionItem>;
  error?: { message: string; info?: SuanliziErrorInfo };
}

// 线程回滚完成事件
export interface ThreadRollbackCompletedEvent {
  type: 'thread.rollback.completed';
  threadId: ThreadId;
  turnId?: TurnId;
  checkpointTurnCount: number;
}

// 线程回滚失败事件
export interface ThreadRollbackFailedEvent {
  type: 'thread.rollback.failed';
  threadId: ThreadId;
  turnId?: TurnId;
  error: { message: string; info?: SuanliziErrorInfo };
}

/** Emitted when a thread is resumed from storage. */
// 线程从存储恢复事件
export interface ResumedEvent {
  type: 'thread.resumed';
  threadId: ThreadId;
  turnIndex: number;
}

/** Emitted when the episode working set is rebuilt for a turn. */
// Episode 工作集重建事件
export interface EpisodeWorkingSetRebuiltEvent {
  type: 'episode.working_set_rebuilt';
  threadId: ThreadId;
  turnId: TurnId;
  generation: number;
  activeEpisodeIds: string[];
  frozenPromptBlock: string;
}

/** Unrecoverable error. */
// 不可恢复错误事件
export interface ErrorEvent {
  type: 'error';
  message: string;
}

export interface HarnessStateUpdatedEvent {
  type: 'harness.state.updated';
  threadId: ThreadId;
  harnessRunId: string;
  status: 'active' | 'satisfied' | 'blocked' | 'max_continuations' | 'no_progress' | 'cancelled';
  iteration: number;
  maxContinuations: number;
  noProgressCount: number;
  maxNoProgress: number;
  goal: string;
  acceptanceCriteria: string[];
  satisfied: boolean;
  blocker?: string;
  failedCriteria: string[];
  evidenceCount: number;
  planNodes: Array<{
    id: string;
    description: string;
    status: 'pending' | 'in_progress' | 'completed' | 'failed';
  }>;
  activeNodeId: string | null;
  nextHint?: string;
  startedAt: string;
  updatedAt: string;
}

// ─── Task Runtime 事件（第 2 步：事件骨架，前端只接收不入 UI） ────────────
// 这组事件让 runtime 底座能把"当前任务正在发生什么"发出来。
// 前端暂时只接收入 state，不做复杂展示；后续第 4-7 步才接 UI。
//
// 重要约束：
// - 不发完整 system prompt
// - 不发完整 context chunk content，只发 metadata
// - 普通聊天也会发 task.runtime.updated，但不代表进入 harness
// - task.loop.updated 兼容 harness loop，但不叫 harness
// ----------------------------------------------------------------

// 当前 turn / runtime phase 变化
export interface TaskRuntimeUpdatedEvent {
  type: 'task.runtime.updated';
  threadId: ThreadId;
  turnId?: TurnId;
  phase: 'before_turn' | 'model' | 'tool' | 'compact' | 'after_turn' | 'idle';
  status: 'running' | 'completed' | 'failed' | 'interrupted';
  runProfile: 'cache_first' | 'runtime_os';
  /** 上下文压缩阈值：占模型上下文窗口的比例。 */
  compactionThreshold?: number;
  checkpoint?: boolean;
  resumable?: boolean;
  timestamp: string;
}

// AgentContext.cognition.task 变化（update_cognition / harness goal / TaskContextProvider）
export interface TaskCognitionUpdatedEvent {
  type: 'task.cognition.updated';
  threadId: ThreadId;
  turnId?: TurnId;
  cognition: {
    goal: string;
    constraints: string[];
    knownFacts: string[];
    unknowns: string[];
    risks: string[];
    confidence: number;
    verificationCriteria: string[];
  };
  timestamp: string;
}

// ContextEngine 本轮注入了哪些 chunk（只发 metadata，不发 content）
export interface TaskContextUpdatedEvent {
  type: 'task.context.updated';
  threadId: ThreadId;
  turnId: TurnId;
  chunks: Array<{
    id: string;
    source: string;
    tokens: number;
    priority: number;
    truncated: boolean;
    summary: string;
  }>;
  usedTokens: number;
  remainingTokens: number;
  timestamp: string;
}

// 目标任务 Run 生命周期事件（计划 §7 P2 / §9.3）。
// 事件名逐字取自 task.ts 的 TASK_EVENT_NAMES（'task.run.updated' / 'task.run.terminal'），
// 不发明新事件名。payload 只携带 threadId/taskId/runId/status/reason?，供 SSE 增量刷新；
// SSE 断线后前端靠 GET /api/tasks 重拉全量真相（§9.3）。
// 注意：task.ts 只 import 本文件的 GoalEvaluation，本文件不得反向 import task.ts（避免循环），
// 因此 status 用 string 承载 TaskRunState，由消费方按 taskRunStateSchema 收窄。
// — Chinese: goal-task run lifecycle events; event names come verbatim from TASK_EVENT_NAMES.

export interface TaskRunUpdatedEvent {
  type: 'task.run.updated';
  threadId: ThreadId;
  taskId: string;
  runId: string;
  status: string;
  reason?: string;
  timestamp: string;
}

export interface TaskRunTerminalEvent {
  type: 'task.run.terminal';
  threadId: ThreadId;
  taskId: string;
  runId: string;
  status: string;
  reason?: string;
  timestamp: string;
}

// Workflow 脚本运行事件（计划 §14.9：事件名逐字取自 task.ts TASK_EVENT_NAMES 的 workflow.* 族）。
// 注意 types.ts 不得反向 import task.ts（循环依赖）：agentCall 用结构子集承载（status 用 string），
// 完整记录由 GET /api/workflows/runs/:id/agent-calls 提供；SSE 断线后靠 result 端点重拉全量真相。
export interface WorkflowUsageSummary {
  inputTokens: number;
  outputTokens: number;
  agentCallCount: number;
  durationMs: number;
}

export interface WorkflowRunUpdatedEvent {
  type: 'workflow.run.updated';
  threadId?: ThreadId;
  taskId: string;
  runId: string;
  status: string;
  phase?: string;
  usage?: WorkflowUsageSummary;
  timestamp: string;
}

export interface WorkflowRunTerminalEvent {
  type: 'workflow.run.terminal';
  threadId?: ThreadId;
  taskId: string;
  runId: string;
  status: string;
  reason?: string;
  usage?: WorkflowUsageSummary;
  timestamp: string;
}

export interface WorkflowAgentCallUpdatedEvent {
  type: 'workflow.agent_call.updated';
  threadId?: ThreadId;
  taskId: string;
  runId: string;
  agentCall: { id: string; status: string; label?: string; phase?: string };
  timestamp: string;
}

export interface WorkflowAgentCallTerminalEvent {
  type: 'workflow.agent_call.terminal';
  threadId?: ThreadId;
  taskId: string;
  runId: string;
  agentCall: { id: string; status: string; label?: string; phase?: string; error?: string };
  timestamp: string;
}

// P6：GoalRun 或用户显式创建的 Script Workflow 请求待批准（§12.1）；批准/拒绝共用 decided 事件。
export interface WorkflowRequestCreatedEvent {
  type: 'workflow.request.created';
  threadId?: ThreadId;
  taskId: string;
  runId: string;
  /** Goal 触发时关联外层 GoalRun；独立 Dynamic Workflow 没有该字段。 */
  goalRunId?: string;
  objective: string;
  estimatedAgents: number;
  estimatedTokens: number;
  timestamp: string;
}

export interface WorkflowRequestDecidedEvent {
  type: 'workflow.request.approved' | 'workflow.request.rejected';
  threadId?: ThreadId;
  taskId: string;
  runId: string;
  /** Goal 触发时关联外层 GoalRun；独立 Dynamic Workflow 没有该字段。 */
  goalRunId?: string;
  reason?: string;
  timestamp: string;
}

// P6：WorkflowRun 结果已物化为 Evidence（wev_ 命名空间）。
export interface WorkflowEvidenceCreatedEvent {
  type: 'workflow.evidence.created';
  threadId?: ThreadId;
  taskId: string;
  runId: string;
  evidenceIds: string[];
  timestamp: string;
}

/**
 * 计划 §13.1：Workflow 结果回填必须产生 `workflow.result.created`（先于 evidence 事件）。
 * 只携带摘要与内容指纹，不内联大结果正文（§14.5 内存边界）。
 */
export interface WorkflowResultCreatedEvent {
  type: 'workflow.result.created';
  threadId?: ThreadId;
  taskId: string;
  runId: string;
  agentCallId?: string;
  resultHash: string;
  size: number;
  timestamp: string;
}

/**
 * 计划 §13.1 / §14.9：GoalEvaluator 产出可展示的目标评估时发本事件；
 * 同样只带摘要字段，完整 evaluation 由 `GET /api/tasks/:id/goal-status` 按需读取。
 */
export interface TaskGoalEvaluationAvailableEvent {
  type: 'task.goal.evaluation.available';
  threadId?: ThreadId;
  taskId: string;
  runId: string;
  satisfied: boolean;
  status: string;
  passedCriteria: string[];
  failedCriteria: string[];
  timestamp: string;
}

// 长运行 / continuation 状态变化（兼容 harness loop，但不叫 harness）
export interface TaskLoopUpdatedEvent {
  type: 'task.loop.updated';
  threadId: ThreadId;
  turnId?: TurnId;
  loopId?: string;
  iteration: number;
  maxIterations: number;
  noProgressCount: number;
  continuationReason?: string;
  status: 'active' | 'satisfied' | 'blocked' | 'no_progress' | 'max_continuations';
  timestamp: string;
}

// ─── JSON-RPC Transport ──────────────────────────────────────────────────────
// JSON-RPC 传输层：本地 API 服务的请求/响应/通知协议
export type JsonRpcMessage = JsonRpcRequest | JsonRpcResponse | JsonRpcNotification;

// JSON-RPC 2.0 请求
export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: string | number;
  method: string;
  params?: unknown;
}

// JSON-RPC 2.0 响应
export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number;
  result?: unknown;
  error?: JsonRpcError;
}

// JSON-RPC 2.0 通知（无 id，无需响应）
export interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}

// JSON-RPC 错误对象
export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

// ─── Approval ────────────────────────────────────────────────────────────────
// Approval（审批）：人机审批协议

// 审批请求
export interface ApprovalRequest {
  requestId: string;
  threadId: ThreadId;
  turnId: TurnId;
  itemId: ItemId;
  kind: 'command' | 'file_write' | 'tool_call' | 'network';
  description: string;
  payload: unknown;
  decision: 'prompt' | 'forbidden';
  justification?: string;
  accessRequest?: AccessRequest;
  temporaryGrantOptions?: Array<{
    scope: TemporaryAccessScope;
    label: string;
  }>;
  matchedRule?: {
    id: string;
    scope: AccessRuleScope | TemporaryAccessScope;
    effect: AccessEffect;
  };
}

// 审批响应
export interface ApprovalResponse {
  requestId: string;
  approved: boolean;
  reason?: string;
  temporaryScope?: TemporaryAccessScope;
  persistentScope?: PersistentAccessScope;
}

// ─── System Monitor ──────────────────────────────────────────────────────────
// 系统监控：检测主机 CPU/内存/磁盘状态，辅助 agent 做性能限流决策
// — Chinese: system monitor: detect host CPU/memory/disk, assist agent throttling

/** 限流级别：从低到高，agent 按级别递减并发/委派能力。 */
// — Chinese: throttle level: ascending severity, agent degrades capabilities per level
export type SystemMonitorLevel = 'none' | 'light' | 'moderate' | 'severe';

/** 一次系统采样快照。 */
// — Chinese: one system sample snapshot
export interface SystemMonitorSnapshot {
  /** ISO-8601 采样时间戳 */
  timestamp: string;
  /** CPU 总体使用率（百分比 0-100） */
  cpuUsage: number;
  /** CPU 核心数 */
  cpuCount: number;
  /** 内存总用量（字节） */
  memTotal: number;
  /** 内存已用量（字节） */
  memUsed: number;
  /** 内存使用率（百分比 0-100） */
  memUsage: number;
  /** 磁盘信息（C 盘等） */
  disks: Array<{
    /** 挂载点/盘符（如 C:、/） */
    mount: string;
    /** 总容量（字节） */
    size: number;
    /** 已用容量（字节） */
    used: number;
    /** 可用容量（字节） */
    available: number;
    /** 使用率（百分比 0-100） */
    usage: number;
  }>;
  /** 系统平均负载（1/5/15 分钟）— Windows 上可能不可用 */
  loadAvg?: [number, number, number];
}

/** 完整监控状态：快照 + 限流级别 + 建议。 */
// — Chinese: full monitor status: snapshot + throttle level + recommendation
export interface SystemMonitorStatus {
  /** 当前快照 */
  snapshot: SystemMonitorSnapshot;
  /** 当前限流级别 */
  level: SystemMonitorLevel;
  /** 人类可读的建议（给 agent 参考） */
  recommendation: string;
  /** 监控是否已启用 */
  enabled: boolean;
}

/**
 * 系统监控模块接口（供 ToolContext 使用，避免 tools 包依赖 runtime）。
 * runtime 里的 SystemMonitor 类实现此接口。
 */
// — Chinese: system monitor interface for ToolContext, decouples tools from runtime
export interface SystemMonitorInterface {
  /** 获取当前监控状态（快照 + 级别 + 建议） */
  getStatus(): SystemMonitorStatus;
  /** 监控是否已启用 */
  isEnabled(): boolean;
}

// ─── Checkpoint ─────────────────────────────────────────────────────────────
// Checkpoint（检查点）：JSONL rollout 中的恢复位标

/** Checkpoint marking resume position in JSONL rollout. */
// 检查点：标记恢复位置
export interface Checkpoint {
  threadId: ThreadId;
  turnId: TurnId;
  itemIndex: number;
  timestamp: string;
  generation?: number;
  status?: CheckpointStatus;
  expiresAt?: string;
  /** 用户决策等待点；与 checkpoint 一起持久化，支持冷启动恢复。 */
  decisionRequest?: AgentDecisionRequest;
  executionStatus?: ThreadExecutionStatus;
}

// JSONL 中的检查点行
export interface CheckpointLine {
  type: 'checkpoint';
  threadId: ThreadId;
  turnId: TurnId;
  itemIndex: number;
  timestamp: string;
  generation?: number;
  status?: CheckpointStatus;
  expiresAt?: string;
  executionStatus?: ThreadExecutionStatus;
  decisionRequest?: AgentDecisionRequest;
}

// 检查点状态：包含停止确认和等待用户输入的持久化中间态。
export type CheckpointStatus = 'running' | 'stopping' | 'waiting_user_input' | 'terminal' | 'completed' | 'interrupted' | 'failed' | 'stale';

// 线程运行时状态：用于恢复决策
export interface ThreadRuntimeState {
  threadId: ThreadId;
  status: 'idle' | 'running' | 'stopping' | 'waiting_user_input' | 'terminal' | 'completed' | 'interrupted' | 'failed' | 'stale';
  checkpoint: Checkpoint | null;
  resumable: boolean;
  stale: boolean;
  /** 线程执行生命周期，独立于历史兼容的 status 字段。 */
  executionStatus?: ThreadExecutionStatus;
  terminalStatus?: 'completed' | 'failed' | 'interrupted';
  decisionRequest?: AgentDecisionRequest | null;
}

// ─── Harness ─────────────────────────────────────────────────────────────────
// Harness（任务引擎）：AgentLoop 外层的跨 turn 自主循环
// 包含 Goal → Plan → Execute → Critique → Replan → Verify 闭环

// Harness 续跑条目可见性：永远不可见（不伪装成 user_message）
export type HarnessItemVisibility = false;

// 目标评估状态：satisfied（达标）/ continue（继续）/ needs_user_input（需要用户输入）/ blocked（阻塞）
export type GoalEvaluationStatus = 'satisfied' | 'continue' | 'needs_user_input' | 'blocked';

// 目标评估结果：由独立模型（GoalEvaluator）输出，fail-closed
export interface GoalEvaluation {
  satisfied: boolean; // 是否达标
  status: GoalEvaluationStatus;
  passedCriteria: string[]; // 已达标的验收标准
  failedCriteria: string[]; // 未达标的验收标准
  blocker?: string; // 阻塞原因
  nextHint?: string; // 下一步提示
  evidenceSummary: string; // 证据摘要
  progressSignature: string; // 进度签名（用于无进展检测）
  reasoning: string; // 推理过程
  /** Gap 8: criteria → evidenceId[] 映射，由 evaluator 声明。 */
  // Gap 8: 验收标准到证据 ID 的映射，由 evaluator 声明
  criteriaEvidenceMap?: Record<string, string[]>;
}

// Harness 续跑条目：不伪装成 user_message，UI 不显示，run monitor 可审计
export interface HarnessContinuationItem {
  id: ItemId;
  type: 'harness_continuation';
  turnId?: TurnId;
  /** 标识本次 harness run，用于关联同一次自主循环产生的所有 items。 */
  // 本次 harness run 的 ID，用于关联同一次自主循环产生的所有 items
  harnessRunId: string;
  /** 第几次续跑（0 = 首次，1+ = 后续隐藏续跑）。 */
  // 续跑迭代次数（0 表示首次，1+ 表示后续隐藏续跑）
  iteration: number;
  objective: string; // 本次 harness 的目标
  instruction: string; // 给模型的续跑指令
  evaluation: GoalEvaluation; // 上次评估结果
  visibleToUser: HarnessItemVisibility; // 永远 false
  timestamp: string;
  /** P2: AgentContext 快照，用于续跑/恢复时还原认知状态 */
  agentContext?: unknown;
  /** P6.3: 关联的 runId，用于 run monitor timeline 严格按 run 过滤 */
  // — Chinese: associated runId for strict run-scoped timeline filtering
  runId?: string;
}
