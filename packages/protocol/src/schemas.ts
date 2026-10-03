// 引入 zod：用于声明式数据校验，与 types.ts 的 TypeScript 类型一一对应
import { z } from 'zod';
import {
  accessEffectSchema,
  accessRequestSchema,
  accessRuleScopeSchema,
  temporaryAccessScopeSchema,
} from './accessPolicySchemas.js';
import { knowledgeCheckpointSummarySchema } from './fileKnowledgeSchemas.js';
import { opsTaskPresetSchema } from './opsTask.js';

// ─── Primitives ──────────────────────────────────────────────────────────────
// 基础 ID schema：threadId/turnId/itemId 都要求非空字符串
export const threadIdSchema = z.string().min(1);
export const turnIdSchema = z.string().min(1);
export const itemIdSchema = z.string().min(1);

// ─── Thread ──────────────────────────────────────────────────────────────────
// 线程状态枚举
export const threadStatusSchema = z.enum(['active', 'archived', 'compacted']);
export const threadModeSchema = z.enum(['chat', 'ops']);
export const threadTaskPresetSchema = opsTaskPresetSchema;

// 线程元信息 schema
export const threadMetaSchema = z.object({
  threadId: threadIdSchema,
  mode: threadModeSchema.optional(),
  taskPreset: threadTaskPresetSchema.nullable().optional(),
  tenantId: z.string().optional(),
  title: z.string(),
  workspaceRoot: z.string(),
  status: threadStatusSchema,
  turnCount: z.number().int().min(0),
  createdAt: z.string(),
  updatedAt: z.string(),
  archivedAt: z.string().nullable(),
  ephemeral: z.boolean(),
  tags: z.record(z.string(), z.string()),
  parentThreadId: threadIdSchema.nullable().optional(),
  agentNickname: z.string().nullable().optional(),
  agentRole: z.string().nullable().optional(),
});

// 父子线程派生边状态
export const threadSpawnEdgeStatusSchema = z.enum(['open', 'closed']);

// 父子线程派生边 schema
export const threadSpawnEdgeSchema = z.object({
  tenantId: z.string().optional(),
  parentThreadId: threadIdSchema,
  childThreadId: threadIdSchema,
  status: threadSpawnEdgeStatusSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
});

// ─── Turn ────────────────────────────────────────────────────────────────────
// 回合状态枚举
export const turnStatusSchema = z.enum([
  'running',
  'completed',
  'failed',
  'cancelled',
  'interrupted',
]);

// 纯文本输入 schema
export const textInputSchema = z.object({
  type: z.literal('text'),
  text: z.string(),
  modeInstruction: z.string().optional(),
});

// 多模态输入的部件 schema（按 type 判别）
export const inputPartSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({
    type: z.literal('image_url'),
    image_url: z.object({
      url: z.string(),
      detail: z.enum(['low', 'high']).optional(),
    }),
  }),
  z.object({
    type: z.literal('image_path'),
    path: z.string(),
    name: z.string().optional(),
    mimeType: z.string().optional(),
    url: z.string().optional(),
  }),
]);

// 多模态输入 schema
export const multimodalInputSchema = z.object({
  type: z.literal('multimodal'),
  parts: z.array(inputPartSchema),
  modeInstruction: z.string().optional(),
});

// 用户输入总 schema：text / multimodal 二选一
export const userInputSchema = z.discriminatedUnion('type', [
  textInputSchema,
  multimodalInputSchema,
]);

// 回合元信息 schema
export const turnMetaSchema = z.object({
  turnId: turnIdSchema,
  threadId: threadIdSchema,
  index: z.number().int().min(0),
  userInput: userInputSchema,
  status: turnStatusSchema,
  startedAt: z.string(),
  completedAt: z.string().nullable(),
});

// ─── Items ───────────────────────────────────────────────────────────────────
// 命令状态枚举
export const commandStatusSchema = z.enum(['in_progress', 'completed', 'failed']);
// 补丁应用状态
export const patchApplyStatusSchema = z.enum(['completed', 'failed']);
// 补丁变更类型
export const patchChangeKindSchema = z.enum(['add', 'delete', 'update']);

// 通用工件引用 schema
export const artifactRefSchema = z.object({
  kind: z.enum(['file_segment', 'tool_result', 'mcp_result']),
  path: z.string().optional(),
  startLine: z.number().int().min(1).optional(),
  endLine: z.number().int().min(1).optional(),
  sha256: z.string().optional(),
  excerpt: z.string().optional(),
  sourceToolCallId: itemIdSchema.optional(),
});

// 文件变更 hunk schema
export const fileChangeHunkSchema = z.object({
  path: z.string(),
  startLine: z.number().int().min(1).optional(),
  endLine: z.number().int().min(1).optional(),
  addedLines: z.number().int().min(0),
  removedLines: z.number().int().min(0),
  // 实际新增/删除的行内容（不含 +/- 前缀）；字段缺失时降级为空数组
  // — English: actual added/removed line content (without +/- prefix); absent when unavailable
  addedLinesContent: z.array(z.string()).optional(),
  removedLinesContent: z.array(z.string()).optional(),
  summary: z.string().optional(),
});

// 文件更新变更单元 schema
export const fileUpdateChangeSchema = z.object({
  path: z.string(),
  kind: patchChangeKindSchema,
  hunks: z.array(fileChangeHunkSchema).optional(),
  addedLines: z.number().int().min(0).optional(),
  removedLines: z.number().int().min(0).optional(),
  summary: z.string().optional(),
});

// 待办项 schema
export const todoItemEntrySchema = z.object({
  text: z.string(),
  completed: z.boolean(),
});

export const providerAssistantFrameSchema = z.discriminatedUnion('format', [
  z.object({
    format: z.literal('openai_chat'),
    content: z.string().nullable(),
    toolCalls: z.array(z.unknown()).optional(),
    reasoningContent: z.string().optional(),
    reasoningDetails: z.array(z.unknown()).optional(),
  }),
  z.object({
    format: z.literal('openai_responses'),
    outputItems: z.array(z.unknown()),
  }),
  z.object({
    format: z.literal('anthropic_messages'),
    contentBlocks: z.array(z.unknown()),
  }),
]);

export const providerToolCallFrameSchema = z.object({
  format: z.enum(['openai_chat', 'openai_responses', 'anthropic_messages']),
  id: z.string(),
  name: z.string(),
  arguments: z.unknown(),
  raw: z.unknown().optional(),
});

// 智能体消息条目 schema
export const agentMessageItemSchema = z.object({
  id: itemIdSchema,
  type: z.literal('agent_message'),
  turnId: turnIdSchema,
  text: z.string(),
  structuredOutput: z.unknown().optional(),
  providerFrame: providerAssistantFrameSchema.optional(),
  timestamp: z.string().optional(),
  // 实施点 2：harness turn 产生的普通 items 打 harnessRunId 标记
  harnessRunId: z.string().optional(),
  harnessIteration: z.number().int().min(0).optional(),
  attachments: z
    .array(
      z.object({
        name: z.string(),
        path: z.string(),
        mimeType: z.string().optional(),
        url: z.string().optional(),
      }),
    )
    .optional(),
});

// 用户消息条目 schema
export const userMessageItemSchema = z.object({
  id: itemIdSchema,
  type: z.literal('user_message'),
  turnId: turnIdSchema,
  text: z.string(),
  timestamp: z.string().optional(),
  // 实施点 2：harness 续跑作为 user-side 输入时也打标记（保留兼容）
  harnessRunId: z.string().optional(),
  harnessIteration: z.number().int().min(0).optional(),
});

// 推理条目 schema
export const reasoningItemSchema = z.object({
  id: itemIdSchema,
  type: z.literal('reasoning'),
  turnId: turnIdSchema,
  text: z.string(),
  providerFrameRef: z.string().optional(),
  timestamp: z.string().optional(),
  completedAt: z.string().optional(),
  harnessRunId: z.string().optional(),
  harnessIteration: z.number().int().min(0).optional(),
});

// 命令执行条目 schema
export const commandExecutionItemSchema = z.object({
  id: itemIdSchema,
  type: z.literal('command_execution'),
  turnId: turnIdSchema,
  command: z.string(),
  aggregatedOutput: z.string(),
  exitCode: z.number().nullable(),
  status: commandStatusSchema,
  timestamp: z.string().optional(),
  completedAt: z.string().optional(),
  harnessRunId: z.string().optional(),
  harnessIteration: z.number().int().min(0).optional(),
});

// 文件变更条目 schema
export const fileChangeItemSchema = z.object({
  id: itemIdSchema,
  type: z.literal('file_change'),
  turnId: turnIdSchema,
  changes: z.array(fileUpdateChangeSchema),
  hunks: z.array(fileChangeHunkSchema).optional(),
  summary: z.string().optional(),
  status: patchApplyStatusSchema,
  timestamp: z.string().optional(),
  completedAt: z.string().optional(),
  harnessRunId: z.string().optional(),
  harnessIteration: z.number().int().min(0).optional(),
});

// 工作流检查点条目 schema
export const workflowCheckpointItemSchema = z.object({
  id: itemIdSchema,
  type: z.literal('workflow_checkpoint'),
  turnId: turnIdSchema,
  turnCount: z.number().int().min(0),
  workflow: z.unknown(),
  timestamp: z.string().optional(),
  harnessRunId: z.string().optional(),
  harnessIteration: z.number().int().min(0).optional(),
});

// 工程级检查点里的单文件快照 schema
export const projectFileCheckpointSchema = z.object({
  path: z.string(),
  kind: patchChangeKindSchema,
  beforeContent: z.string().nullable(),
  afterContent: z.string().nullable(),
  beforeHash: z.string().nullable(),
  afterHash: z.string().nullable(),
});

// 工程级检查点条目 schema
export const projectCheckpointItemSchema = z.object({
  id: itemIdSchema,
  type: z.literal('project_checkpoint'),
  turnId: turnIdSchema,
  turnCount: z.number().int().min(0),
  workspaceRoot: z.string(),
  files: z.array(projectFileCheckpointSchema),
  knowledge: knowledgeCheckpointSummarySchema.optional(),
  timestamp: z.string().optional(),
  harnessRunId: z.string().optional(),
  harnessIteration: z.number().int().min(0).optional(),
});

// 回滚冲突条目 schema
export const rollbackConflictItemSchema = z.object({
  id: itemIdSchema,
  type: z.literal('rollback_conflict'),
  turnId: turnIdSchema,
  turnCount: z.number().int().min(0),
  message: z.string(),
  conflicts: z.array(
    z.object({
      path: z.string(),
      reason: z.string(),
      expectedHash: z.string().nullable().optional(),
      actualHash: z.string().nullable().optional(),
    }),
  ),
  timestamp: z.string().optional(),
  harnessRunId: z.string().optional(),
  harnessIteration: z.number().int().min(0).optional(),
});

// 上下文压缩摘要 schema
export const compactionSummarySchema = z.object({
  userGoal: z.string(),
  completedWork: z.string(),
  keyConstraints: z.string(),
  filesAndArtifacts: z.string(),
  toolResults: z.string(),
  subagentResults: z.string(),
  openTasks: z.string(),
  risks: z.string(),
  raw: z.string(),
});

// 压缩策略 schema
export const compactionStrategySchema = z.enum(['llm', 'local']);

// 已压缩区间 schema
export const compactedRangeSchema = z.object({
  compactedTurnIds: z.array(turnIdSchema),
  retainedTurnIds: z.array(turnIdSchema),
  compactionItemId: itemIdSchema,
  summary: z.string(),
  tokensBefore: z.number().int().min(0),
  tokensAfter: z.number().int().min(0),
  createdAt: z.string(),
  trigger: z.enum(['manual', 'auto']),
  strategy: compactionStrategySchema,
});

// 上下文压缩事件条目 schema
export const contextCompactionItemSchema = z.object({
  id: itemIdSchema,
  type: z.literal('context_compaction'),
  turnId: turnIdSchema,
  status: commandStatusSchema,
  trigger: z.enum(['manual', 'auto']),
  compactedTurnIds: z.array(turnIdSchema),
  retainedTurnIds: z.array(turnIdSchema),
  summary: compactionSummarySchema.optional(),
  tokensBefore: z.number().int().min(0),
  tokensAfter: z.number().int().min(0),
  error: z.object({ message: z.string(), code: z.string().optional() }).optional(),
  timestamp: z.string().optional(),
  completedAt: z.string().optional(),
  harnessRunId: z.string().optional(),
  harnessIteration: z.number().int().min(0).optional(),
});

// 通用工具调用条目 schema
export const toolCallItemSchema = z.object({
  id: itemIdSchema,
  type: z.literal('tool_call'),
  turnId: turnIdSchema,
  toolName: z.string(),
  arguments: z.record(z.string(), z.unknown()),
  modelToolCallId: z.string().optional(),
  modelToolName: z.string().optional(),
  providerToolCall: providerToolCallFrameSchema.optional(),
  result: z.unknown().optional(),
  error: z.object({ message: z.string(), code: z.string().optional() }).optional(),
  status: commandStatusSchema,
  timestamp: z.string().optional(),
  completedAt: z.string().optional(),
  harnessRunId: z.string().optional(),
  harnessIteration: z.number().int().min(0).optional(),
});

// 协作工具调用条目 schema
export const collabToolCallItemSchema = z.object({
  id: itemIdSchema,
  type: z.literal('collab_tool_call'),
  turnId: turnIdSchema,
  tool: z.enum([
    'spawn_agent',
    'send_input',
    'send_message',
    'followup_task',
    'resume_agent',
    'wait',
    'wait_agent',
    'list_agents',
    'close_agent',
  ]),
  modelToolCallId: z.string().optional(),
  modelToolName: z.string().optional(),
  providerToolCall: providerToolCallFrameSchema.optional(),
  status: commandStatusSchema,
  senderThreadId: threadIdSchema,
  receiverThreadId: threadIdSchema.optional(),
  newThreadId: threadIdSchema.optional(),
  prompt: z.string().optional(),
  agentStatus: z.string().optional(),
  result: z.unknown().optional(),
  error: z.object({ message: z.string(), code: z.string().optional() }).optional(),
  timestamp: z.string().optional(),
  completedAt: z.string().optional(),
  harnessRunId: z.string().optional(),
  harnessIteration: z.number().int().min(0).optional(),
});

// MCP 工具调用条目 schema
export const mcpToolCallItemSchema = z.object({
  id: itemIdSchema,
  type: z.literal('mcp_tool_call'),
  turnId: turnIdSchema,
  server: z.string(),
  tool: z.string(),
  arguments: z.unknown(),
  modelToolCallId: z.string().optional(),
  modelToolName: z.string().optional(),
  providerToolCall: providerToolCallFrameSchema.optional(),
  result: z
    .object({
      content: z.array(z.unknown()),
      structuredContent: z.unknown(),
    })
    .optional(),
  error: z.object({ message: z.string(), code: z.string().optional() }).optional(),
  status: commandStatusSchema,
  timestamp: z.string().optional(),
  completedAt: z.string().optional(),
  harnessRunId: z.string().optional(),
  harnessIteration: z.number().int().min(0).optional(),
});

// Web 搜索条目 schema
export const webSearchItemSchema = z.object({
  id: itemIdSchema,
  type: z.literal('web_search'),
  turnId: turnIdSchema,
  query: z.string(),
  timestamp: z.string().optional(),
  harnessRunId: z.string().optional(),
  harnessIteration: z.number().int().min(0).optional(),
});

// 待办清单条目 schema
export const todoListItemSchema = z.object({
  id: itemIdSchema,
  type: z.literal('todo_list'),
  turnId: turnIdSchema,
  items: z.array(todoItemEntrySchema),
  timestamp: z.string().optional(),
  harnessRunId: z.string().optional(),
  harnessIteration: z.number().int().min(0).optional(),
});

// 错误条目 schema
export const errorItemSchema = z.object({
  id: itemIdSchema,
  type: z.literal('error'),
  turnId: turnIdSchema,
  message: z.string(),
  info: z.lazy(() => suanliziErrorInfoSchema).optional(),
  detail: z.string().optional(),
  recoverable: z.boolean().optional(),
  timestamp: z.string().optional(),
  harnessRunId: z.string().optional(),
  harnessIteration: z.number().int().min(0).optional(),
});

// ─── Harness ─────────────────────────────────────────────────────────────────
// Harness 续跑条目可见性：永远 false（不伪装成 user_message）
// — English: Harness continuation item visibility: always false
export const harnessItemVisibilitySchema = z.literal(false);

// 目标评估状态枚举
export const goalEvaluationStatusSchema = z.enum([
  'satisfied',
  'continue',
  'needs_user_input',
  'blocked',
]);

// 目标评估结果 schema（对应 types.ts 的 GoalEvaluation）
// — English: goal evaluation result schema, fail-closed by evaluator
export const goalEvaluationSchema = z.object({
  satisfied: z.boolean(),
  status: goalEvaluationStatusSchema,
  passedCriteria: z.array(z.string()),
  failedCriteria: z.array(z.string()),
  blocker: z.string().optional(),
  nextHint: z.string().optional(),
  evidenceSummary: z.string(),
  progressSignature: z.string(),
  reasoning: z.string(),
  // Gap 8: 验收标准到证据 ID 的映射
  criteriaEvidenceMap: z.record(z.string(), z.array(z.string())).optional(),
});

// Harness 续跑条目 schema：UI 不显示，run monitor 可审计
// — English: harness continuation item schema: hidden from UI, auditable via run monitor
export const harnessContinuationItemSchema = z.object({
  id: itemIdSchema,
  type: z.literal('harness_continuation'),
  turnId: turnIdSchema.optional(),
  // 实施点 2：标识本次 harness run，用于关联同一次自主循环产生的所有 items
  harnessRunId: z.string(),
  // 续跑迭代次数（0 = 首次，1+ = 后续隐藏续跑）
  iteration: z.number().int().min(0),
  objective: z.string(),
  instruction: z.string(),
  evaluation: goalEvaluationSchema,
  visibleToUser: harnessItemVisibilitySchema,
  timestamp: z.string(),
});

// 条目总 schema：按 type 判别
export const threadItemSchema = z.discriminatedUnion('type', [
  userMessageItemSchema,
  agentMessageItemSchema,
  reasoningItemSchema,
  commandExecutionItemSchema,
  fileChangeItemSchema,
  workflowCheckpointItemSchema,
  projectCheckpointItemSchema,
  rollbackConflictItemSchema,
  contextCompactionItemSchema,
  toolCallItemSchema,
  collabToolCallItemSchema,
  mcpToolCallItemSchema,
  webSearchItemSchema,
  todoListItemSchema,
  errorItemSchema,
  harnessContinuationItemSchema,
]);

// ─── Events ──────────────────────────────────────────────────────────────────
// Suanlizi 错误信息 schema
export const suanliziErrorInfoSchema = z.object({
  kind: z.enum([
    'ContextWindowExceeded',
    'UsageLimitExceeded',
    'ServerOverloaded',
    'HttpConnectionFailed',
    'ResponseStreamConnectionFailed',
    'InternalServerError',
    'Unauthorized',
    'BadRequest',
    'SandboxError',
    'ResponseStreamDisconnected',
    'ResponseTooManyFailedAttempts',
    'ActiveTurnNotSteerable',
    'ThreadRollbackFailed',
    'Other',
  ]),
  httpStatusCode: z.number().int().optional(),
  turnKind: z.string().optional(),
  reason: z.enum(['timeout', 'cancelled', 'network', 'provider', 'protocol']).optional(),
  timeoutMs: z.number().int().positive().optional(),
});

// 单回合 token 用量 schema
export const usageSchema = z.object({
  inputTokens: z.number().int().min(0),
  cachedInputTokens: z.number().int().min(0),
  cacheReported: z.boolean().optional(),
  cacheWriteTokens: z.number().int().min(0).optional(),
  outputTokens: z.number().int().min(0),
  reasoningOutputTokens: z.number().int().min(0),
  cacheStrategy: z
    .enum(['deepseek-native', 'openai-compatible', 'anthropic-cache-control', 'mixed'])
    .optional(),
});

// 单回合用量记录 schema
export const turnUsageSchema = z.object({
  turnId: turnIdSchema,
  usage: usageSchema,
  timestamp: z.string(),
});

// 线程级累计用量 schema
export const threadUsageSchema = z.object({
  threadId: threadIdSchema,
  total: usageSchema,
  turns: z.array(turnUsageSchema),
  updatedAt: z.string(),
  includedThreadIds: z.array(threadIdSchema).optional(),
});

// 线程已创建事件 schema
export const threadStartedEventSchema = z.object({
  type: z.literal('thread.started'),
  threadId: threadIdSchema,
  thread: threadMetaSchema,
});

// 回合开始事件 schema
export const turnStartedEventSchema = z.object({
  type: z.literal('turn.started'),
  threadId: threadIdSchema,
  turnId: turnIdSchema,
  runId: z.string(),
  turnIndex: z.number().int().min(0),
});

// 回合完成事件 schema
export const turnCompletedEventSchema = z.object({
  type: z.literal('turn.completed'),
  threadId: threadIdSchema,
  turnId: turnIdSchema,
  runId: z.string(),
  usage: usageSchema.nullable(),
  status: z.enum(['completed', 'interrupted']).optional(),
});

export const threadRuntimeUpdatedEventSchema = z.object({
  type: z.literal('thread.runtime.updated'),
  threadId: threadIdSchema,
  turnId: turnIdSchema.optional(),
  runId: z.string().optional(),
  status: z.enum(['idle', 'running', 'stopping', 'waiting_user_input', 'terminal']),
  terminalStatus: z.enum(['completed', 'failed', 'interrupted']).optional(),
  decisionRequest: z.unknown().optional(),
});

export const agentDecisionRequestedEventSchema = z.object({
  type: z.literal('agent.decision.requested'),
  threadId: threadIdSchema,
  turnId: turnIdSchema,
  request: z.unknown(),
});

export const agentDecisionResolvedEventSchema = z.object({
  type: z.literal('agent.decision.resolved'),
  threadId: threadIdSchema,
  turnId: turnIdSchema,
  requestId: z.string().min(1),
  action: z.enum(['way_one', 'way_two', 'custom_input', 'cancel', 'confirm']),
  optionId: z.string().optional(),
  customInput: z.string().optional(),
});

// 回合失败事件 schema
export const turnFailedEventSchema = z.object({
  type: z.literal('turn.failed'),
  threadId: threadIdSchema,
  turnId: turnIdSchema,
  runId: z.string(),
  error: z.object({ message: z.string(), info: suanliziErrorInfoSchema.optional() }),
});

// 警告事件 schema
export const warningEventSchema = z.object({
  type: z.literal('warning'),
  threadId: threadIdSchema.optional(),
  turnId: turnIdSchema.optional(),
  message: z.string(),
  info: suanliziErrorInfoSchema.optional(),
});

// 流式错误事件 schema
export const streamErrorEventSchema = z.object({
  type: z.literal('stream.error'),
  threadId: threadIdSchema,
  turnId: turnIdSchema,
  message: z.string(),
  recoverable: z.boolean(),
  error: z.object({ message: z.string(), info: suanliziErrorInfoSchema.optional() }),
  additionalDetails: z.string().optional(),
});

// 模型输出被拒绝事件 schema
export const modelOutputRejectedEventSchema = z.object({
  type: z.literal('model.output.rejected'),
  threadId: threadIdSchema,
  turnId: turnIdSchema,
  message: z.string(),
  error: z.object({ message: z.string(), info: suanliziErrorInfoSchema.optional() }),
});

// 条目开始/更新/完成事件 schema
export const itemStartedEventSchema = z.object({
  type: z.literal('item.started'),
  threadId: threadIdSchema,
  turnId: turnIdSchema,
  item: threadItemSchema,
});

export const itemUpdatedEventSchema = z.object({
  type: z.literal('item.updated'),
  threadId: threadIdSchema,
  turnId: turnIdSchema,
  item: threadItemSchema,
});

export const itemCompletedEventSchema = z.object({
  type: z.literal('item.completed'),
  threadId: threadIdSchema,
  turnId: turnIdSchema,
  item: threadItemSchema,
});

export const itemDiscardedEventSchema = z.object({
  type: z.literal('item.discarded'),
  threadId: threadIdSchema,
  turnId: turnIdSchema,
  itemId: itemIdSchema,
});

// 智能体消息流式增量事件 schema
export const agentMessageDeltaEventSchema = z.object({
  type: z.literal('agent_message.delta'),
  threadId: threadIdSchema,
  turnId: turnIdSchema,
  itemId: itemIdSchema,
  delta: z.string(),
});

// 命令输出流式增量事件 schema
export const commandOutputDeltaEventSchema = z.object({
  type: z.literal('command_output.delta'),
  threadId: threadIdSchema,
  turnId: turnIdSchema,
  itemId: itemIdSchema,
  delta: z.string(),
});

// token 用量更新事件 schema
export const tokenUsageUpdatedEventSchema = z.object({
  type: z.literal('thread.token_usage.updated'),
  threadId: threadIdSchema,
  usage: threadUsageSchema,
});

// 回合 diff 更新事件 schema
export const turnDiffUpdatedEventSchema = z.object({
  type: z.literal('turn.diff.updated'),
  threadId: threadIdSchema,
  turnId: turnIdSchema,
  diff: z.string(),
});

// 子代理事件 schema
export const childAgentEventSchema = z.object({
  type: z.literal('child_agent.event'),
  threadId: threadIdSchema,
  childThreadId: threadIdSchema,
  agentNickname: z.string().nullable().optional(),
  agentRole: z.string().nullable().optional(),
  event: z.record(z.string(), z.unknown()),
});

// 缓存诊断事件 schema
export const cacheDiagnosticsEventSchema = z.object({
  type: z.literal('cache.diagnostics'),
  threadId: threadIdSchema,
  turnId: turnIdSchema,
  shape: z.object({
    systemHash: z.string(),
    toolsHash: z.string(),
    prefixHash: z.string(),
  }),
  stable: z.boolean(),
  reasons: z.array(z.enum(['system', 'tools'])),
});

// 模型重试事件 schema
export const modelRetryEventSchema = z.object({
  type: z.literal('model.retry'),
  threadId: threadIdSchema,
  turnId: turnIdSchema,
  attempt: z.number().int().positive(),
  maxAttempts: z.number().int().positive(),
  delayMs: z.number().int().nonnegative(),
  status: z.number().int().optional(),
  error: z.string().optional(),
});

// 上下文 token 估算更新事件 schema
export const contextTokenEstimateUpdatedEventSchema = z.object({
  type: z.literal('context.token_estimate.updated'),
  threadId: threadIdSchema,
  turnId: turnIdSchema,
  estimate: z.object({
    inputTokens: z.number().int().nonnegative(),
    messageCount: z.number().int().nonnegative(),
    imageCount: z.number().int().nonnegative(),
    charCount: z.number().int().nonnegative(),
  }),
});

// 上下文压缩压力事件 schema
export const contextCompactionPressureEventSchema = z.object({
  type: z.literal('context.compaction_pressure'),
  threadId: threadIdSchema,
  turnId: turnIdSchema,
  pressure: z.object({
    estimatedTokens: z.number().nonnegative(),
    maxTokens: z.number().nonnegative(),
    softThreshold: z.number().nonnegative(),
    hardThreshold: z.number().nonnegative(),
    ratio: z.number().nonnegative(),
    windowKnown: z.boolean().optional(),
    status: z.enum(['ok', 'soft', 'hard']),
    window: z
      .object({
        ordinal: z.number().int().positive(),
        prefillInputTokens: z.number().int().nonnegative().nullable(),
      })
      .optional(),
  }),
});

// 审批已处理事件 schema
export const approvalResolvedEventSchema = z.object({
  type: z.literal('approval.resolved'),
  threadId: threadIdSchema,
  turnId: turnIdSchema,
  requestId: z.string(),
  approved: z.boolean(),
  reason: z.string().optional(),
  status: z.enum(['approved', 'denied', 'timeout']),
});

// 需要人工审批事件 schema
export const approvalRequiredEventSchema = z.object({
  type: z.literal('approval.required'),
  threadId: threadIdSchema,
  turnId: turnIdSchema,
  itemId: itemIdSchema,
  requestId: z.string(),
  kind: z.enum(['command', 'file_write', 'tool_call', 'network']),
  description: z.string(),
  payload: z.unknown(),
  decision: z.enum(['prompt', 'forbidden']),
  justification: z.string().optional(),
  accessRequest: accessRequestSchema.optional(),
  temporaryGrantOptions: z
    .array(
      z.object({
        scope: temporaryAccessScopeSchema,
        label: z.string(),
      }),
    )
    .optional(),
  matchedRule: z
    .object({
      id: z.string(),
      scope: z.union([accessRuleScopeSchema, temporaryAccessScopeSchema]),
      effect: accessEffectSchema,
    })
    .optional(),
});

// 上下文压缩完成事件 schema
export const compactedEventSchema = z.object({
  type: z.literal('thread.compacted'),
  threadId: threadIdSchema,
  compactedTurns: z.number().int().min(0),
  tokensBefore: z.number().int().min(0),
  tokensAfter: z.number().int().min(0),
});

// 上下文压缩 V2 事件 schema
export const contextCompactedV2EventSchema = z.object({
  type: z.literal('thread.compacted.v2'),
  threadId: threadIdSchema,
  turnId: turnIdSchema,
  phase: z.enum(['started', 'completed', 'failed']),
  trigger: z.enum(['manual', 'auto']),
  strategy: z.enum(['llm', 'local']).optional(),
  compactedTurns: z.number().int().min(0).optional(),
  tokensBefore: z.number().int().min(0).optional(),
  tokensAfter: z.number().int().min(0).optional(),
  item: z.object({ id: itemIdSchema }).passthrough().optional(),
  error: z.object({ message: z.string(), info: suanliziErrorInfoSchema.optional() }).optional(),
});

// 线程回滚完成事件 schema
export const threadRollbackCompletedEventSchema = z.object({
  type: z.literal('thread.rollback.completed'),
  threadId: threadIdSchema,
  turnId: turnIdSchema.optional(),
  checkpointTurnCount: z.number().int().min(0),
});

// 线程回滚失败事件 schema
export const threadRollbackFailedEventSchema = z.object({
  type: z.literal('thread.rollback.failed'),
  threadId: threadIdSchema,
  turnId: turnIdSchema.optional(),
  error: z.object({ message: z.string(), info: suanliziErrorInfoSchema.optional() }),
});

// 线程恢复事件 schema
export const resumedEventSchema = z.object({
  type: z.literal('thread.resumed'),
  threadId: threadIdSchema,
  turnIndex: z.number().int().min(0),
});

// Episode 工作集重建事件 schema
export const episodeWorkingSetRebuiltEventSchema = z.object({
  type: z.literal('episode.working_set_rebuilt'),
  threadId: threadIdSchema,
  turnId: turnIdSchema,
  generation: z.number().int().min(0),
  activeEpisodeIds: z.array(z.string()),
  frozenPromptBlock: z.string(),
});

// 不可恢复错误事件 schema
export const errorEventSchema = z.object({
  type: z.literal('error'),
  message: z.string(),
});

// ─── Task Runtime 事件（第 2 步：事件骨架） ─────────────────────────────────
// 与 types.ts 中 TaskRuntimeUpdatedEvent 等四个接口一一对应。
// 只发 metadata，不发完整 prompt / chunk content。
// — English: skeleton events for task runtime, metadata-only

// 当前 turn / runtime phase 变化
export const taskRuntimeUpdatedEventSchema = z.object({
  type: z.literal('task.runtime.updated'),
  threadId: threadIdSchema,
  turnId: turnIdSchema.optional(),
  phase: z.enum(['before_turn', 'model', 'tool', 'compact', 'after_turn', 'idle']),
  status: z.enum(['running', 'completed', 'failed', 'interrupted']),
  compactionThreshold: z.number().min(0.3).max(0.95).optional(),
  checkpoint: z.boolean().optional(),
  resumable: z.boolean().optional(),
  timestamp: z.string(),
});

// AgentContext.cognition.task 变化
export const taskCognitionUpdatedEventSchema = z.object({
  type: z.literal('task.cognition.updated'),
  threadId: threadIdSchema,
  turnId: turnIdSchema.optional(),
  cognition: z.object({
    goal: z.string(),
    constraints: z.array(z.string()),
    knownFacts: z.array(z.string()),
    unknowns: z.array(z.string()),
    risks: z.array(z.string()),
    confidence: z.number().min(0).max(1),
    verificationCriteria: z.array(z.string()),
  }),
  timestamp: z.string(),
});

// ContextEngine 本轮注入了哪些 chunk（只发 metadata，不发 content）
export const taskContextUpdatedEventSchema = z.object({
  type: z.literal('task.context.updated'),
  threadId: threadIdSchema,
  turnId: turnIdSchema,
  chunks: z.array(
    z.object({
      id: z.string(),
      source: z.string(),
      tokens: z.number().int().min(0),
      priority: z.number(),
      truncated: z.boolean(),
      summary: z.string(),
    }),
  ),
  usedTokens: z.number().int().min(0),
  remainingTokens: z.number().int().min(0),
  timestamp: z.string(),
});

// 长运行 / continuation 状态变化（兼容 harness loop，但不叫 harness）
export const taskLoopUpdatedEventSchema = z.object({
  type: z.literal('task.loop.updated'),
  threadId: threadIdSchema,
  turnId: turnIdSchema.optional(),
  loopId: z.string().optional(),
  iteration: z.number().int().min(0),
  maxIterations: z.number().int().min(0),
  noProgressCount: z.number().int().min(0),
  continuationReason: z.string().optional(),
  status: z.enum(['active', 'satisfied', 'blocked', 'no_progress', 'max_continuations']),
  timestamp: z.string(),
});

// 线程事件总 schema：按 type 判别
export const threadEventSchema = z.discriminatedUnion('type', [
  threadStartedEventSchema,
  turnStartedEventSchema,
  turnCompletedEventSchema,
  turnFailedEventSchema,
  threadRuntimeUpdatedEventSchema,
  agentDecisionRequestedEventSchema,
  agentDecisionResolvedEventSchema,
  warningEventSchema,
  streamErrorEventSchema,
  modelOutputRejectedEventSchema,
  itemStartedEventSchema,
  itemUpdatedEventSchema,
  itemCompletedEventSchema,
  itemDiscardedEventSchema,
  agentMessageDeltaEventSchema,
  commandOutputDeltaEventSchema,
  tokenUsageUpdatedEventSchema,
  turnDiffUpdatedEventSchema,
  childAgentEventSchema,
  cacheDiagnosticsEventSchema,
  modelRetryEventSchema,
  contextTokenEstimateUpdatedEventSchema,
  contextCompactionPressureEventSchema,
  approvalResolvedEventSchema,
  approvalRequiredEventSchema,
  compactedEventSchema,
  contextCompactedV2EventSchema,
  threadRollbackCompletedEventSchema,
  threadRollbackFailedEventSchema,
  resumedEventSchema,
  episodeWorkingSetRebuiltEventSchema,
  taskRuntimeUpdatedEventSchema,
  taskCognitionUpdatedEventSchema,
  taskContextUpdatedEventSchema,
  taskLoopUpdatedEventSchema,
  errorEventSchema,
]);

// ─── JSON-RPC ────────────────────────────────────────────────────────────────
// JSON-RPC 错误对象 schema
export const jsonRpcErrorSchema = z.object({
  code: z.number().int(),
  message: z.string(),
  data: z.unknown().optional(),
});

// JSON-RPC 请求 schema
export const jsonRpcRequestSchema = z.object({
  jsonrpc: z.literal('2.0'),
  id: z.union([z.string(), z.number()]),
  method: z.string(),
  params: z.unknown().optional(),
});

// JSON-RPC 响应 schema
export const jsonRpcResponseSchema = z.object({
  jsonrpc: z.literal('2.0'),
  id: z.union([z.string(), z.number()]),
  result: z.unknown().optional(),
  error: jsonRpcErrorSchema.optional(),
});

// JSON-RPC 通知 schema
export const jsonRpcNotificationSchema = z.object({
  jsonrpc: z.literal('2.0'),
  method: z.string(),
  params: z.unknown().optional(),
});

// JSON-RPC 消息总 schema：method 为任意字符串，无法用 discriminatedUnion，改用 union
// — Chinese: JSON-RPC message schema: method is arbitrary string, cannot use discriminatedUnion, use union instead
export const jsonRpcMessageSchema = z.union([jsonRpcRequestSchema, jsonRpcNotificationSchema]);

// ─── Approval ────────────────────────────────────────────────────────────────
// 审批请求 schema
export const approvalRequestSchema = z.object({
  requestId: z.string(),
  threadId: threadIdSchema,
  turnId: turnIdSchema,
  itemId: itemIdSchema,
  kind: z.enum(['command', 'file_write', 'tool_call', 'network']),
  description: z.string(),
  payload: z.unknown(),
  decision: z.enum(['prompt', 'forbidden']),
  justification: z.string().optional(),
  accessRequest: accessRequestSchema.optional(),
  temporaryGrantOptions: z
    .array(
      z.object({
        scope: temporaryAccessScopeSchema,
        label: z.string(),
      }),
    )
    .optional(),
  matchedRule: z
    .object({
      id: z.string(),
      scope: z.union([accessRuleScopeSchema, temporaryAccessScopeSchema]),
      effect: accessEffectSchema,
    })
    .optional(),
});

// 检查点状态 schema
export const checkpointStatusSchema = z.enum([
  'running',
  'stopping',
  'waiting_user_input',
  'terminal',
  'completed',
  'interrupted',
  'failed',
  'stale',
]);

// 审批响应 schema
export const approvalResponseSchema = z.object({
  requestId: z.string(),
  approved: z.boolean(),
  reason: z.string().optional(),
  temporaryScope: temporaryAccessScopeSchema.optional(),
  persistentScope: accessRuleScopeSchema.optional(),
});
