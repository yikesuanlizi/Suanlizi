// Ops 任务协议：状态机、作用域契约、乐观锁和重试关系。
// Ops task protocol: state machine, scoped task contract, optimistic locking, and retries.
// 状态迁移/乐观锁/重试 id 的通用逻辑复用自 taskStateMachine.ts；本文件的公共 API 保持不变。
// The generic transition / optimistic-lock / retry-id logic is reused from taskStateMachine.ts;
// this module's public API is unchanged.
import { z } from 'zod';
import {
  createTransitionHelpers,
  deriveRetrySpec,
  isVersionMatch,
  validateVersion,
  type TransitionErrorContext,
} from './taskStateMachine.js';

/** Ops 任务的完整生命周期状态。 */
export const OPS_TASK_STATES = [
  'draft',
  'queued',
  'running',
  'paused',
  'waiting_confirmation',
  'verifying',
  'completed',
  'blocked',
  'cancelled',
  'failed',
] as const;

export type OpsTaskState = (typeof OPS_TASK_STATES)[number];

/** Agent Loop 在 Ops 任务中的阶段。 */
export const OPS_TASK_PHASES = [
  'observe',
  'hypothesize',
  'investigate',
  'verify',
  'conclude',
] as const;
export type OpsTaskPhase = (typeof OPS_TASK_PHASES)[number];

export const OPS_TASK_PRESETS = ['ops'] as const;
export type OpsTaskPresetId = (typeof OPS_TASK_PRESETS)[number];

export const OPS_TASK_POLICY_PROFILES = ['ops_readonly'] as const;
export type OpsTaskPolicyProfile = (typeof OPS_TASK_POLICY_PROFILES)[number];

/** 状态机的唯一允许迁移表。终态故意没有任何出口。 */
export const OPS_TASK_TRANSITIONS: Readonly<Record<OpsTaskState, readonly OpsTaskState[]>> = {
  draft: ['queued', 'blocked', 'cancelled'],
  queued: ['running', 'blocked', 'cancelled', 'failed'],
  running: ['paused', 'waiting_confirmation', 'verifying', 'blocked', 'cancelled', 'failed'],
  paused: ['running', 'cancelled', 'failed'],
  blocked: ['queued', 'cancelled', 'failed'],
  waiting_confirmation: ['verifying', 'running', 'cancelled', 'failed'],
  verifying: ['completed', 'running', 'waiting_confirmation', 'blocked', 'cancelled', 'failed'],
  completed: [],
  cancelled: [],
  failed: [],
};

export const OPS_TASK_TERMINAL_STATES: ReadonlySet<OpsTaskState> = new Set([
  'completed',
  'cancelled',
  'failed',
]);

export function isOpsTaskState(value: string): value is OpsTaskState {
  return opsTaskTransitionHelpers.isState(value);
}

export function isOpsTaskTerminalState(state: OpsTaskState): boolean {
  return opsTaskTransitionHelpers.isTerminalState(state);
}

export function canTransitionOpsTaskState(from: OpsTaskState, to: OpsTaskState): boolean {
  return opsTaskTransitionHelpers.canTransition(from, to);
}

// Alias kept for callers that describe a transition as a generic state-machine check.
export const isValidOpsTaskTransition = canTransitionOpsTaskState;
export const canTransitionOpsTask = canTransitionOpsTaskState;
export const OPS_TASK_TRANSITION_MAP = OPS_TASK_TRANSITIONS;
export const OPS_TASK_TERMINAL_STATE_SET = OPS_TASK_TERMINAL_STATES;

export const OPS_TASK_ERROR_CODES = [
  'OPS_TASK_NOT_FOUND',
  'OPS_INVALID_TRANSITION',
  'OPS_TERMINAL_STATE',
  'OPS_VERSION_CONFLICT',
  'OPS_SCOPE_REQUIRED',
  'OPS_CONFIRMATION_REQUIRED',
  'OPS_IDEMPOTENCY_CONFLICT',
  'OPS_ACTIVE_TASK_EXISTS',
  'OPS_TEST_NOT_ALLOWED',
  'OPS_TEST_NOT_FOUND',
  'OPS_TEST_ARGUMENTS_INVALID',
  'OPS_TEST_NOT_AVAILABLE',
  'OPS_TEST_ALREADY_RUNNING',
  'OPS_TEST_BUDGET_EXCEEDED',
  'OPS_TEST_TIMEOUT',
  'OPS_TEST_CANCELLED',
  'OPS_TEST_EXECUTION_FAILED',
  'OPS_TEST_REDACTION_FAILED',
  'OPS_TASK_TIMEOUT',
  'OPS_KNOWLEDGE_REQUIRED',
  'OPS_KNOWLEDGE_NOT_READY',
  'OPS_KNOWLEDGE_SYNC_FAILED',
] as const;

export type OpsTaskErrorCode = (typeof OPS_TASK_ERROR_CODES)[number];

export interface OpsTaskErrorDetails {
  from?: OpsTaskState;
  to?: OpsTaskState;
  actualVersion?: number;
  expectedVersion?: number;
  taskId?: string;
  parentTaskId?: string;
  [key: string]: unknown;
}

/** 带稳定机器可读错误码的 Ops 协议错误。 */
export class OpsTaskError extends Error {
  readonly code: OpsTaskErrorCode;
  readonly details?: Readonly<OpsTaskErrorDetails>;

  constructor(code: OpsTaskErrorCode, message: string, details?: OpsTaskErrorDetails) {
    super(message);
    this.name = 'OpsTaskError';
    this.code = code;
    this.details = details;
  }
}

// 基于通用状态机原语构建的 Ops 迁移 helper；errorFactory 产出与历史完全一致的错误码与文案。
// Ops transition helpers built on the generic primitives; errorFactory reproduces the exact
// historical error codes and messages.
const opsTaskTransitionHelpers = createTransitionHelpers<OpsTaskState>({
  states: OPS_TASK_STATES,
  transitions: OPS_TASK_TRANSITIONS,
  terminalStates: OPS_TASK_TERMINAL_STATES,
  errorFactory: ({ kind, from, to }: TransitionErrorContext<OpsTaskState>) =>
    kind === 'terminal'
      ? new OpsTaskError(
          'OPS_TERMINAL_STATE',
          `Ops task in terminal state ${from} cannot transition to ${to}`,
          { from, to },
        )
      : new OpsTaskError(
          'OPS_INVALID_TRANSITION',
          `Ops task cannot transition from ${from} to ${to}`,
          { from, to },
        ),
});

/** 检查并断言状态迁移合法；终态优先返回 OPS_TERMINAL_STATE。 */
export function assertOpsTaskTransition(from: OpsTaskState, to: OpsTaskState): void {
  opsTaskTransitionHelpers.assertTransition(from, to);
}

/** 用于 API 层乐观锁的版本一致性校验。成功时返回 true，失败时抛出稳定错误。 */
export function validateOpsTaskVersion(actualVersion: number, expectedVersion: number): true {
  return validateVersion(actualVersion, expectedVersion, ({ actual, expected }) =>
    new OpsTaskError(
      'OPS_VERSION_CONFLICT',
      `Ops task version conflict: expected ${expected}, got ${actual}`,
      { actualVersion: actual, expectedVersion: expected },
    ),
  );
}

export const assertOpsTaskVersion = validateOpsTaskVersion;

export function isOpsTaskVersionMatch(actualVersion: number, expectedVersion: number): boolean {
  return isVersionMatch(actualVersion, expectedVersion);
}

export interface OpsTaskTarget {
  hostIds: string[];
  serviceNames?: string[];
  containerNames?: string[];
  timeRange?: { from: string; to: string };
}

export interface OpsTaskBudgets {
  maxAdapterCalls: number;
  maxConcurrentCalls: number;
  maxOutputBytes: number;
  maxInputTokens?: number;
  maxWallTimeMs: number;
}

export interface OpsKnowledgeScope {
  knowledgeBaseIds: string[];
  snapshotIds: string[];
  indexVersion?: string;
  /** 服务端在排队前生成的固定检索收据；模型不能自行替换。 */
  queryReceiptId?: string;
  maxHits?: number;
  maxContextTokens?: number;
}

/** 创建任务时冻结的作用域、预算和权限声明。 */
export interface OpsTaskSpec {
  taskId: string;
  threadId: string;
  parentTaskId?: string;
  presetId: OpsTaskPresetId;
  knowledgeScope?: OpsKnowledgeScope;
  workspaceRoot: string;
  environmentId: string;
  target: OpsTaskTarget;
  policyProfile: OpsTaskPolicyProfile;
  budgets: OpsTaskBudgets;
  acceptanceCriteria: string[];
  allowLocalPatchProposal: boolean;
  allowLocalTest: boolean;
}

export interface OpsTaskClaim {
  text: string;
  status: 'supported' | 'contradicted' | 'unverified';
  evidenceIds: string[];
  supportLevel?: 'low' | 'medium' | 'high';
}

export interface OpsTaskConclusion {
  summary: string;
  claims: OpsTaskClaim[];
  recommendedActions?: string[];
}

/** Evidence is immutable task output metadata; content is always redacted before persistence. */
export interface OpsTaskEvidence {
  id: string;
  source: 'replay' | 'local' | 'ssh' | 'service' | 'log';
  sourceRef?: string;
  status: 'complete' | 'partial' | 'timed_out' | 'stale';
  contentHash: string;
  summary: string;
  observedAt: string;
  /** Evidence remains immutable; stale is represented by status after this instant. */
  expiresAt?: string;
  detectorVersion: string;
  redactionVersion?: string;
}

export interface OpsTaskBudgetUsage {
  adapterCalls: number;
  inputTokens: number;
  outputBytes: number;
  wallTimeMs: number;
}

export const OPS_TASK_TEST_STATUSES = [
  'queued',
  'running',
  'completed',
  'failed',
  'timed_out',
  'cancelled',
] as const;
export type OpsTaskTestStatus = (typeof OPS_TASK_TEST_STATUSES)[number];

/** Only a registered test id is persisted; no command text is ever stored. */
export interface OpsTaskTestRun {
  testRunId: string;
  testId: string;
  args: string[];
  status: OpsTaskTestStatus;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  /** Raw stdout/stderr bytes observed before redaction/truncation. */
  outputBytes?: number;
  exitCode?: number | null;
  timedOut?: boolean;
  truncated?: boolean;
  outputSummary?: string;
  errorSummary?: string;
  errorCode?: string;
}

export interface OpsTaskPatchProposal {
  id: string;
  summary: string;
  diff: string;
  status: 'proposed' | 'approved' | 'rejected' | 'applied';
  createdAt: string;
  decidedAt?: string;
}

/** OpsTaskSession 是 RunRecord 之上的任务投影。 */
export interface OpsTaskSession {
  spec: OpsTaskSpec;
  state: OpsTaskState;
  currentPhase: OpsTaskPhase;
  hypothesisIds: string[];
  evidenceIds: string[];
  checkpointSequence: number;
  /** 每次成功迁移递增；初始任务版本为 0。 */
  taskVersion: number;
  /** 最后一次状态迁移/任务事件的单调序号。 */
  sequence: number;
  lastError?: string;
  finalConclusion?: OpsTaskConclusion;
  evidence?: OpsTaskEvidence[];
  budgetUsage?: OpsTaskBudgetUsage;
  testRuns?: OpsTaskTestRun[];
  patchProposal?: OpsTaskPatchProposal;
}

export interface OpsTaskTransitionEvent {
  taskId: string;
  threadId: string;
  from: OpsTaskState;
  to: OpsTaskState;
  taskVersion: number;
  sequence: number;
  occurredAt: string;
  reason?: string;
}

export interface OpsTaskTransitionOptions {
  expectedTaskVersion?: number;
  sequence?: number;
}

/** 对任务投影执行一次状态迁移并递增 taskVersion；输入对象不会被修改。 */
export function transitionOpsTask(
  task: OpsTaskSession,
  to: OpsTaskState,
  options: OpsTaskTransitionOptions | number = {},
): OpsTaskSession {
  const normalizedOptions: OpsTaskTransitionOptions =
    typeof options === 'number' ? { expectedTaskVersion: options } : options;
  if (normalizedOptions.expectedTaskVersion !== undefined) {
    validateOpsTaskVersion(task.taskVersion, normalizedOptions.expectedTaskVersion);
  }
  assertOpsTaskTransition(task.state, to);
  return {
    ...task,
    state: to,
    taskVersion: task.taskVersion + 1,
    sequence: normalizedOptions.sequence ?? task.sequence + 1,
  };
}

// More explicit alias for stores that model the operation as a state-only transition.
export const transitionOpsTaskState = transitionOpsTask;

export interface OpsTaskRetryRequest {
  /** 新任务 ID；不得与 parentTaskId 相同。 */
  taskId: string;
  parentTaskId: string;
  expectedParentTaskVersion?: number;
}

export type OpsTaskRetrySpec = Omit<OpsTaskSpec, 'taskId' | 'parentTaskId'> & {
  taskId: string;
  parentTaskId: string;
};

/** 从既有规格派生重试规格；不会改变原规格或复制历史证据。 */
export function createOpsTaskRetrySpec(source: OpsTaskSpec, taskId: string): OpsTaskRetrySpec {
  return deriveRetrySpec<OpsTaskSpec, OpsTaskRetrySpec>(source, {
    parentId: source.taskId,
    newId: taskId,
    onInvalidId: ({ taskId: rejectedId, parentTaskId }) =>
      new OpsTaskError('OPS_INVALID_TRANSITION', 'Retry taskId must be a new non-empty id', {
        taskId: rejectedId,
        parentTaskId,
      }),
    build: (src) => ({ ...src, taskId, parentTaskId: src.taskId }),
  });
}

/** 终态任务不能原地恢复，重试必须创建一个新的 draft 任务。 */
export function createOpsTaskRetry(
  source: OpsTaskSession,
  request: OpsTaskRetryRequest,
): OpsTaskSession {
  if (!isOpsTaskTerminalState(source.state)) {
    throw new OpsTaskError(
      'OPS_INVALID_TRANSITION',
      `Only terminal Ops tasks can be retried; current state is ${source.state}`,
      { from: source.state, taskId: source.spec.taskId },
    );
  }
  if (
    !request.taskId ||
    request.taskId === request.parentTaskId ||
    request.parentTaskId !== source.spec.taskId
  ) {
    throw new OpsTaskError(
      'OPS_INVALID_TRANSITION',
      'Retry taskId must be new and parentTaskId must reference the source task',
      { taskId: request.taskId, parentTaskId: request.parentTaskId },
    );
  }
  if (request.expectedParentTaskVersion !== undefined) {
    validateOpsTaskVersion(source.taskVersion, request.expectedParentTaskVersion);
  }
  return {
    spec: createOpsTaskRetrySpec(source.spec, request.taskId),
    state: 'draft',
    currentPhase: 'observe',
    hypothesisIds: [],
    evidenceIds: [],
    checkpointSequence: 0,
    taskVersion: 0,
    sequence: 0,
  };
}

// ─── Zod schemas ────────────────────────────────────────────────────────────

export const opsTaskStateSchema = z.enum(OPS_TASK_STATES);
export const opsTaskPhaseSchema = z.enum(OPS_TASK_PHASES);
export const opsTaskTestStatusSchema = z.enum(OPS_TASK_TEST_STATUSES);
export const opsTaskPresetSchema = z.enum(OPS_TASK_PRESETS);
export const opsTaskPolicyProfileSchema = z.enum(OPS_TASK_POLICY_PROFILES);

const opsTaskTargetSchema = z
  .object({
    hostIds: z.array(z.string().trim().min(1)),
    serviceNames: z.array(z.string().trim().min(1)).optional(),
    containerNames: z.array(z.string().trim().min(1)).optional(),
    timeRange: z
      .object({
        from: z.string().trim().min(1),
        to: z.string().trim().min(1),
      })
      .strict()
      .optional(),
  })
  .strict();

const opsKnowledgeScopeSchema = z.object({
  knowledgeBaseIds: z.array(z.string().trim().min(1)),
  snapshotIds: z.array(z.string().trim().min(1)),
  indexVersion: z.string().trim().min(1).optional(),
  queryReceiptId: z.string().trim().min(1).optional(),
  maxHits: z.number().int().positive().max(100).optional(),
  maxContextTokens: z.number().int().positive().max(1_000_000).optional(),
}).strict();

const opsTaskBudgetsSchema = z
  .object({
    maxAdapterCalls: z.number().int().positive(),
    maxConcurrentCalls: z.number().int().positive(),
    maxOutputBytes: z.number().int().positive(),
    maxInputTokens: z.number().int().positive().optional(),
    maxWallTimeMs: z.number().int().positive(),
  })
  .strict();

export const opsTaskSpecSchema = z
  .object({
    taskId: z.string().trim().min(1),
    threadId: z.string().trim().min(1),
    parentTaskId: z.string().trim().min(1).optional(),
    presetId: opsTaskPresetSchema,
    knowledgeScope: opsKnowledgeScopeSchema.optional(),
    workspaceRoot: z.string().trim().min(1),
    environmentId: z.string().trim().min(1),
    target: opsTaskTargetSchema,
    policyProfile: opsTaskPolicyProfileSchema,
    budgets: opsTaskBudgetsSchema,
    acceptanceCriteria: z.array(z.string().trim().min(1)),
    allowLocalPatchProposal: z.boolean(),
    allowLocalTest: z.boolean(),
  })
  .strict();

const opsTaskClaimSchema = z
  .object({
    text: z.string().trim().min(1),
    status: z.enum(['supported', 'contradicted', 'unverified']),
    evidenceIds: z.array(z.string().trim().min(1)),
    supportLevel: z.enum(['low', 'medium', 'high']).optional(),
  })
  .strict();

const opsTaskConclusionSchema = z
  .object({
    summary: z.string().trim().min(1),
    claims: z.array(opsTaskClaimSchema),
    recommendedActions: z.array(z.string().trim().min(1)).optional(),
  })
  .strict();

const opsTaskEvidenceSchema = z
  .object({
    id: z.string().trim().min(1),
    source: z.enum(['replay', 'local', 'ssh', 'service', 'log']),
    sourceRef: z.string().optional(),
    status: z.enum(['complete', 'partial', 'timed_out', 'stale']),
    contentHash: z.string().trim().min(1),
    summary: z.string(),
    observedAt: z.string().trim().min(1),
    expiresAt: z.string().trim().min(1).optional(),
    detectorVersion: z.string().trim().min(1),
    redactionVersion: z.string().optional(),
  })
  .strict();

const opsTaskBudgetUsageSchema = z
  .object({
    adapterCalls: z.number().int().nonnegative(),
    inputTokens: z.number().int().nonnegative(),
    outputBytes: z.number().int().nonnegative(),
    wallTimeMs: z.number().int().nonnegative(),
  })
  .strict();

const opsTaskTestRunSchema = z
  .object({
    testRunId: z.string().trim().min(1),
    testId: z.string().trim().min(1),
    args: z.array(z.string().max(256)).max(16),
    status: opsTaskTestStatusSchema,
    startedAt: z.string().trim().min(1).optional(),
    completedAt: z.string().trim().min(1).optional(),
    durationMs: z.number().int().nonnegative().optional(),
    outputBytes: z.number().int().nonnegative().optional(),
    exitCode: z.number().int().nullable().optional(),
    timedOut: z.boolean().optional(),
    truncated: z.boolean().optional(),
    outputSummary: z.string().max(12000).optional(),
    errorSummary: z.string().max(12000).optional(),
    errorCode: z.string().trim().min(1).optional(),
  })
  .strict();

const opsTaskPatchProposalSchema = z
  .object({
    id: z.string().trim().min(1),
    summary: z.string().trim().min(1),
    diff: z.string(),
    status: z.enum(['proposed', 'approved', 'rejected', 'applied']),
    createdAt: z.string().trim().min(1),
    decidedAt: z.string().optional(),
  })
  .strict();

export const opsTaskSessionSchema = z
  .object({
    spec: opsTaskSpecSchema,
    state: opsTaskStateSchema,
    currentPhase: opsTaskPhaseSchema,
    hypothesisIds: z.array(z.string().trim().min(1)),
    evidenceIds: z.array(z.string().trim().min(1)),
    checkpointSequence: z.number().int().nonnegative(),
    taskVersion: z.number().int().nonnegative(),
    sequence: z.number().int().nonnegative(),
    lastError: z.string().optional(),
    finalConclusion: opsTaskConclusionSchema.optional(),
    evidence: z.array(opsTaskEvidenceSchema).optional(),
    budgetUsage: opsTaskBudgetUsageSchema.optional(),
    testRuns: z.array(opsTaskTestRunSchema).max(100).optional(),
    patchProposal: opsTaskPatchProposalSchema.optional(),
  })
  .strict();

export const opsTaskTransitionEventSchema = z
  .object({
    taskId: z.string().trim().min(1),
    threadId: z.string().trim().min(1),
    from: opsTaskStateSchema,
    to: opsTaskStateSchema,
    taskVersion: z.number().int().nonnegative(),
    sequence: z.number().int().nonnegative(),
    occurredAt: z.string().trim().min(1),
    reason: z.string().optional(),
  })
  .strict();
