// Suanlizi runtime 包总入口：对外导出 AgentLoop、状态管理、中间件、工具治理、MCP、工作流等核心类型与函数。
// 本文件仅做 re-export，不新增逻辑。

// ─── Agent 主循环 ─────────────────────────────────────────────────────
export { AgentLoop } from './agent.js';
export type {
  AgentConfig,
  AgentRoleProfile,
  AgentRoleProfiles,
  ResolvedAgentRoleProfile,
  ToolBindingMode,
} from './agent.js';

// ─── A2A 远程 Agent 客户端 ─────────────────────────────────────────────
// 封装 @a2a-js/sdk，让 Suanlizi Agent 能调用外部 A2A Agent
export { RemoteAgentClient } from './a2aClient/remoteAgentClient.js';
export type { RemoteAgentResult, RemoteAgentStreamEvent } from './a2aClient/remoteAgentClient.js';
export { REMOTE_AGENT_TOOL } from './a2aClient/remoteAgentTool.js';

// ─── 工具治理 ──────────────────────────────────────────────────────────
export type { ToolGovernanceConfig } from './toolGovernance.js';

// ─── Workflow 受限脚本运行时（P4） ─────────────────────────────────────
export {
  validateWorkflowScript,
  WORKFLOW_API_NAMES,
  WORKFLOW_VALUE_NAMES,
  WORKFLOW_SCRIPT_MAX_LENGTH,
  WorkflowScriptRuntime,
  WorkflowStructuredOutputError,
  WORKFLOW_RESULT_HANDLE_THRESHOLD_BYTES,
  WORKFLOW_RESULT_PAGE_DEFAULT_CHARS,
  WORKFLOW_RESULT_PAGE_MAX_CHARS,
  validateStructuredOutput,
  WORKFLOW_SCRIPT_GENERATION_PROMPT,
} from './workflowScript/index.js';
export type {
  WorkflowScriptDiagnostic,
  WorkflowScriptMeta,
  WorkflowScriptCostMetrics,
  WorkflowScriptValidationResult,
  WorkflowAgentExecutor,
  WorkflowAgentOptions,
  WorkflowRuntimeEvent,
  WorkflowScriptRunResult,
  WorkflowResultHandle,
  WorkflowResultPage,
  SchemaValidationResult,
} from './workflowScript/index.js';

// ─── MCP 客户端与运行时管理 ────────────────────────────────────────────
export {
  McpRuntimeManager,
  McpStdioClient,
  mcpNamespacedToolName,
  mcpToolDisplayName,
  normalizeMcpServerId,
  parseMcpNamespacedToolName,
} from './mcpClient.js';
export type {
  McpCallToolResult,
  McpServerConfig,
  McpServerRuntimeStatus,
  McpServerStatusView,
  McpToolInfo,
} from './mcpClient.js';

// ─── 线程状态管理 ──────────────────────────────────────────────────────
export { ThreadStateManager, createThreadState, createTurnSummary } from './state.js';
export type { ThreadState, ThreadStatus, TurnSummary, TurnError, Checkpoint, CheckpointLine } from './state.js';

// ─── 运行时中间件 ──────────────────────────────────────────────────────
export { composeRuntimeMiddleware } from './middleware.js';

// Context compaction policy is shared by the runtime and API control route so
// manual compaction uses the same window/strategy as automatic compaction.
export {
  compactionOptionsForModelContext,
  contextBudget,
  defaultCompactionOptions,
  compactionOptionsForThreshold,
  normalizeCompactionThreshold,
  DEFAULT_COMPACTION_THRESHOLD,
  MIN_COMPACTION_THRESHOLD,
  MAX_COMPACTION_THRESHOLD,
} from './compactionPolicy.js';

// ─── 模型输出合法性校验 ────────────────────────────────────────────────
export { leaksToolProtocol, validateModelOutputItems, validateThreadItemsForPersistence } from './modelOutput.js';

// ─── 错误类型与诊断 ────────────────────────────────────────────────────
export { SuanliziRuntimeError, affectsTurnStatus, isRecoverableStreamError, toSuanliziErrorInfo } from './runtimeError.js';

// ─── Guardian 安全审查 ────────────────────────────────────────────────────
export { createGuardianMiddleware } from './guardian.js';
export type { ModelOutputItem, ValidatedModelOutput } from './modelOutput.js';
export type {
  GuardianAssessment,
  GuardianAuthorization,
  GuardianConfig,
  GuardianReviewMode,
  GuardianReviewRequest,
  GuardianReviewer,
  GuardianRiskLevel,
  GuardianTranscriptEntry,
} from './guardian.js';

// ─── 系统监控（CPU/内存/磁盘） ──────────────────────────────────────────
// — Chinese: system monitor (CPU/memory/disk) for agent performance throttling
export { SystemMonitor, DEFAULT_SYSTEM_MONITOR_CONFIG, createEmptySystemMonitorStatus } from './systemMonitor.js';
export type { SystemMonitorConfig, SystemMonitorListener } from './systemMonitor.js';

// ─── Run Trace V2 基础件 ─────────────────────────────────────────────────
// — Chinese: Run Trace V2 primitives for redaction, projection, and session writing
export { redactTracePayload } from './runTraceRedaction.js';
export type { TraceRedactionOptions } from './runTraceRedaction.js';
export {
  SECRET_REDACTION_VERSION,
  SecretRedactor,
  redactSecrets,
} from './secretRedactor.js';
export type {
  EvidenceAttempt,
  RedactionSource,
  SecretRedactionContext,
  SecretRedactionFailure,
  SecretRedactionFailureCode,
  SecretRedactionMetadata,
  SecretRedactionResult,
  SecretRedactionSuccess,
  SecretRedactorOptions,
  SecretRuleId,
} from './secretRedactor.js';
export { projectRunTrace } from './runTraceProjector.js';
export { RunTraceSession } from './runTraceSession.js';
export type { RunTraceSink } from './runTraceSession.js';
export {
  buildRuntimeAccessPolicy,
  evaluateAccessRequest,
  mergePersistentRules,
  temporaryGrantMatches,
} from './accessPolicy.js';

// ─── Task Harness Engine（跨 turn 自主循环） ─────────────────────────────
// — Chinese: Task Harness Engine — verifiable/pausable/resumable autonomous loop
export {
  DEFAULT_HARNESS_CONFIG,
  EvidenceLedger,
  GoalTracker,
  GoalEvaluator,
  GoalEvaluationParseError,
  HarnessContextManager,
  ReadinessCritic,
  StormBreaker,
  TaskHarnessEngine,
  estimateTokens,
  isVerificationCommand,
  renderHarnessContextSlice,
} from './harness/index.js';
export type {
  ContinuationInput,
  CriteriaDeriver,
  EvaluatorModelGateway,
  EvidenceReceipt,
  EvidenceReceiptKind,
  EvidenceReceiptRefs,
  EvidenceReceiptSourceKind,
  EvidenceReceiptStatus,
  GoalEvaluation,
  GoalEvaluationStatus,
  GoalExtractor,
  HarnessAgentLoop,
  HarnessConfig,
  HarnessContextSlice,
  HarnessContextStore,
  HarnessContinuationItem,
  HarnessGoal,
  HarnessItemFields,
  HarnessItemVisibility,
  HarnessPlanNode,
  HarnessPlanNodeStatus,
  HarnessResult,
  HarnessResultStatus,
  HarnessState,
  HarnessStatus,
  HarnessWorkflowOptions,
  ReadinessGate,
  ReadinessGateName,
  ReadinessResult,
  RunTurnOptions,
  RunTurnSource,
  StormBreakerResult,
} from './harness/index.js';

// ─── 工作流（Workflow）蓝图定义与执行 ───────────────────────────────────
export {
  assertValidWorkflowDefinition,
  blockWorkflowNode,
  blockWorkflowStep,
  completeWorkflowNode,
  completeWorkflowStep,
  compileWorkflowBlueprint,
  createDefaultWorkflowComponentRegistry,
  createBuiltinWorkflowComponentRegistry,
  createToolWorkflowComponent,
  createWorkflowDefinitionFromGoal,
  createWorkflowComponentRegistryFromTools,
  createWorkflowRegistryWithUserComponents,
  createWorkflowRunFromDefinition,
  createWorkflowRun,
  executeWorkflowNode,
  failWorkflowNode,
  failWorkflowStep,
  renderWorkflowTemplate,
  normalizeWorkflowSnapshot,
  normalizeUserWorkflowComponent,
  planWorkflowDefinitionFromGoal,
  publishWorkflowSnapshot,
  replanWorkflow,
  resumeWorkflowRun,
  retryWorkflowNode,
  runNextWorkflowNodes,
  runWorkflowNode,
  runnableWorkflowNodes,
  runnableWorkflowSteps,
  startWorkflowNode,
  startWorkflowStep,
  updateWorkflowNodeContract,
  WorkflowComponentRegistry,
} from './workflow.js';
export type {
  RuntimeMiddleware,
  RuntimeModelRequest,
  RuntimeModelResponse,
  RuntimeToolRequest,
  RuntimeToolResponse,
  RuntimeTurnContext,
} from './middleware.js';
export type {
  WorkflowApprovalMode,
  WorkflowBlueprintCompileResult,
  WorkflowBlueprintDiagnostic,
  WorkflowComponentDefinition,
  WorkflowComponentField,
  WorkflowComponentFieldKind,
  WorkflowComponentSource,
  WorkflowDefinition,
  WorkflowEdge,
  WorkflowEvent,
  WorkflowExecutionRun,
  WorkflowExecutorKind,
  WorkflowGraphDefinition,
  WorkflowLayoutDefinition,
  WorkflowNode,
  WorkflowNodeExecutor,
  WorkflowNodeExecutorContext,
  WorkflowNodeExecutorResult,
  WorkflowNodeExecutors,
  WorkflowNodeRun,
  WorkflowPlannerModel,
  WorkflowRun,
  WorkflowRuntimeAction,
  WorkflowRuntimeContext,
  WorkflowRuntimeOptions,
  WorkflowRuntimeResult,
  BlueprintRunStatus,
  WorkflowSnapshot,
  WorkflowStep,
  WorkflowStepStatus,
  WorkflowVariableDefinition,
  WorkflowVariableNamespace,
  WorkflowVariablePool,
  WorkflowVersionSummary,
} from './workflow.js';

// ─── 目标任务生命周期（Task/TaskRun 纯编排，计划 §5.1/§5.2/§5.3） ───────────
// — Chinese: Task lifecycle — pure orchestration over an injected TaskStorePort (no storage import)
// 命名说明：本波次与 @suanlizi/protocol 的契约类型（Task/TaskRun/TaskStep/TaskPlanVersion）不重名，
// 因此无需别名；若未来撞名，请在此处用 `as taskXxx` 显式别名而不是改名。
export {
  applyTaskSyncFromRun,
  attachTaskEvidence,
  blockForUserInput,
  completeRun,
  createRetryRun,
  createTaskWithRun,
  findActiveTask,
  newRunId,
  newTaskId,
  resolveUserInput,
  syncTaskFromRun,
  TASK_NON_TERMINAL_STATUSES,
  transitionRun,
  transitionRunAndSyncTask,
  transitionRunOfTask,
} from './task/taskLifecycle.js';
export type {
  BlockForUserInputOptions,
  BlockForUserInputResult,
  CreateRetryRunOptions,
  CreateRetryRunResult,
  CreateTaskWithRunInput,
  CreateTaskWithRunResult,
  CompleteRunOptions,
  ResolveUserInputOptions,
  ResolveUserInputResult,
  TransitionRunOptions,
} from './task/taskLifecycle.js';

// ─── 计划投影与 Replan 治理（计划 §14.2/§12.2/§14.4） ────────────────────────
// — Chinese: Harness plan → TaskPlanVersion projection, diff, replan gate, claimed-progress tracker
export {
  claimedSignatures,
  claimedStallExceeded,
  createReplanGate,
  deriveStepId,
  deriveStepStatus,
  diffPlans,
  isPlanDiffEmpty,
  isSystemStepId,
  normalizeLocalId,
  planDiffSummary,
  projectPlan,
  projectPlanWithDiff,
  ReplanGate,
  STEP_ID_HASH_LENGTH,
  STEP_ID_PREFIX,
  stableHashHex,
  stepProgressSignature,
  SYSTEM_STEP_ID_PATTERN,
  trackClaimedProgress,
} from './task/planProjection.js';
export type {
  ClaimedProgressResult,
  ClaimedProgressSnapshot,
  DeriveStepStatusContext,
  PlanProjectionDiff,
  ProjectablePlanNode,
  ProjectPlanOptions,
  ProjectPlanWithDiffResult,
  PlanStepChangedField,
  PlanStepModification,
  ReplanAttempt,
  ReplanDecision,
  ReplanDenyReason,
  ReplanHistory,
  StepSignatures,
} from './task/planProjection.js';

// ─── workflow_result Evidence 承载通道（计划 §11.3 + 盘点 §4.4） ─────────────
// — Chinese: second evidence channel/source for workflow results, `wev_` namespace
export {
  evidenceKindFilter,
  isWorkflowEvidenceId,
  toWorkflowEvidenceSeed,
  workflowEvidenceId,
  WORKFLOW_EVIDENCE_ID_PREFIX,
  WORKFLOW_EVIDENCE_RUN_SEGMENT,
} from './harness/evidenceLedger.js';
export type { WorkflowResultEvidenceInput } from './harness/evidenceLedger.js';

// Runtime 包的版本号，供外部诊断与日志输出使用。
export const RUNTIME_VERSION = '0.1.0';
