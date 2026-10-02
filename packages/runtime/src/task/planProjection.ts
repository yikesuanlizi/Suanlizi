// 计划投影纯函数层（计划 §14.2、§12.2、§5.2、§14.4）。
//
// 职责：把 Harness 的 `HarnessPlanNode[]`（四态、模型自己维护的节点 id）投影成
// `TaskPlanVersion`（六态、系统分配的稳定 step id），并产出 diff 供上层记事件。
//
// 设计约束：
// 1. **不接存储**：全部是纯函数，入参出参都是可序列化数据；`TaskStorePort` 只出现在
//    `taskLifecycle.ts`，本模块连协议端口都不依赖，便于 P3 直接接进 GoalTracker 链路。
// 2. **不扩 HarnessPlanNode 状态**（§14.2）：六态只存在于投影/验收层，由本模块派生；
//    模型声明的 `completed` 永远不会被直接写成 `verified`。
// 3. **skipped 不可由模型声明**（§14.2）：只能通过显式 `opts.skippedLocalIds`
//    （用户 redirect / 明确策略）注入，否则拒绝。
// 4. **P3 接线点**：`GoalTracker.updatePlan(nodes)` 目前直接接收模型节点，缺少稳定 id 校验与
//    补发能力（§12.2）。P3 的接线顺序固定为
//    `Harness continuation plan snapshot → projectPlan（本模块 normalize + 校验 + 补发 id）
//     → diffPlans（记 task.plan.version.created）→ GoalTracker.updatePlan(normalized)`。
//    本波次**不修改 goalTracker**，也不在此写第二套 GoalEvaluator（§14.1：GoalTracker /
//    GoalEvaluation 仍是评估状态的唯一载体，证据硬校验作为 recordEvaluation 之前的 gate 在 P3 落地）。

import {
  DEFAULT_REPLAN_POLICY,
  TaskError,
  replanPolicySchema,
} from '@suanlizi/protocol';
import type {
  ReplanPolicy,
  TaskPlanTrigger,
  TaskPlanVersion,
  TaskStep,
  TaskStepStatus,
} from '@suanlizi/protocol';
import type { HarnessPlanNode, HarnessPlanNodeStatus } from '../harness/types.js';

// ─── 系统 step id 规则 ───────────────────────────────────────────────────────

export const STEP_ID_PREFIX = 'step_';
export const STEP_ID_HASH_LENGTH = 16;

/** 规范化的系统 step id 形状：`step_` + 16 位小写十六进制。 */
export const SYSTEM_STEP_ID_PATTERN: RegExp = new RegExp(
  `^${STEP_ID_PREFIX}[0-9a-f]{${STEP_ID_HASH_LENGTH}}$`,
);

/**
 * 稳定 id 规则（§14.2 / §12.2「新步骤补发系统 id、已有步骤只能通过 id 引用」）：
 *
 * - 模型节点自带的 `id` 只作 **localId**，永远不会直接成为 `TaskStep.id`；
 * - `TaskStep.id = "step_" + stableHash16(localId)`，**与 planVersion 无关**，
 *   因此同一 localId 在 v0/v1/v2… 派生出的系统 id 完全相同 ⇒ 跨版本稳定；
 * - replan 时模型沿用同一 localId（Harness todo 节点 id 本就跨 iteration 不变），
 *   投影结果自动落在同一系统 id 上，无需额外映射表；
 * - 模型若直接引用我们发出去的系统 id（`step_<16hex>`），按 §12.2 视为显式引用，原样沿用，
 *   但该 id 必须存在于 priorVersion，否则抛 `TASK_PLAN_UNKNOWN_STEP_ID`；
 * - 模型若自带 `step_` 前缀但 hash 不合法、或引用与 localId 派生结果撞车、或携带
 *   `stepId` / `systemId` 保留字段 ⇒ 视为伪造/篡改系统 id，抛 `TASK_PLAN_STEP_ID_CONFLICT`。
 */
export function isSystemStepId(value: string): boolean {
  return SYSTEM_STEP_ID_PATTERN.test(value);
}

function fnv1a32(input: string, seed: number): number {
  let hash = seed >>> 0;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** 无第三方依赖的确定性散列（双 FNV-1a 拼接，避免 node:crypto 依赖与平台差异）。 */
export function stableHashHex(input: string, length: number = STEP_ID_HASH_LENGTH): string {
  const a = fnv1a32(input, 0x811c9dc5).toString(16).padStart(8, '0');
  const b = fnv1a32(`\u0001${input}`, 0x9e3779b9).toString(16).padStart(8, '0');
  const c = fnv1a32(`${input}\u0002`, 0x85ebca6b).toString(16).padStart(8, '0');
  const d = fnv1a32(`${input}\u0003`, 0xc2b2ae35).toString(16).padStart(8, '0');
  return `${a}${b}${c}${d}`.slice(0, Math.max(1, length));
}

export function normalizeLocalId(localId: string): string {
  return (localId ?? '').trim();
}

/** localId → 系统 step id 的确定性映射（幂等；已是系统 id 时原样返回）。 */
export function deriveStepId(localId: string): string {
  const normalized = normalizeLocalId(localId);
  if (!normalized) {
    throw new Error('deriveStepId: localId must be a non-empty string');
  }
  if (isSystemStepId(normalized)) return normalized;
  return `${STEP_ID_PREFIX}${stableHashHex(normalized)}`;
}

/** 模型未给出 id 的新步骤：用描述派生稳定 localId，避免位置漂移导致 id 变化。 */
function anonymousLocalId(description: string, index: number): string {
  const trimmed = (description ?? '').trim();
  return trimmed ? `anon:${trimmed}` : `anon:#${index}`;
}

// ─── 状态派生（§14.2 映射表） ────────────────────────────────────────────────

const HARNESS_PLAN_NODE_STATUSES: readonly HarnessPlanNodeStatus[] = [
  'pending',
  'in_progress',
  'completed',
  'failed',
];

export interface DeriveStepStatusContext {
  validEvidenceIds: ReadonlySet<string>;
  /** 用户 redirect / 明确策略显式跳过（模型无法表达）。 */
  skipped?: boolean;
  stepId?: string;
}

function uniqueNonEmpty(values: readonly string[] | undefined): string[] {
  return [
    ...new Set(
      (values ?? []).map((value) => (typeof value === 'string' ? value.trim() : '')).filter((value) => value.length > 0),
    ),
  ];
}

/**
 * §14.2 映射表的唯一实现：
 *
 * | HarnessPlanNode.status | Evidence 结果                        | TaskStep.status |
 * |------------------------|--------------------------------------|-----------------|
 * | pending                | -                                    | pending         |
 * | in_progress            | -                                    | in_progress     |
 * | completed              | evidenceIds 非空且全部有效           | verified        |
 * | completed              | 无证据或存在无效证据                 | claimed         |
 * | failed                 | -                                    | failed          |
 * | -                      | 用户或系统显式跳过（opts 注入）      | skipped         |
 *
 * 其他任何入参状态（模型幻觉出 `skipped` / `verified` / 未知字符串）一律拒绝：
 * HarnessPlanNode 保持四态、投影层不接受模型自述的六态。
 */
export function deriveStepStatus(
  node: Pick<HarnessPlanNode, 'status' | 'evidenceIds'>,
  ctx: DeriveStepStatusContext,
): TaskStepStatus {
  const status = (node as { status?: unknown }).status as HarnessPlanNodeStatus | undefined;
  if (!status || !HARNESS_PLAN_NODE_STATUSES.includes(status)) {
    throw new TaskError(
      'TASK_INVALID_TRANSITION',
      `plan node status ${JSON.stringify(status ?? null)} is not a HarnessPlanNode status; ` +
        'skipped/verified are projection-layer states and must never be model-declared',
      { from: String(status ?? ''), to: 'TaskStepStatus', stepId: ctx.stepId },
    );
  }
  // 显式 skip 优先，但只对合法的四态节点生效（非法状态在上面已被拒绝）。
  if (ctx.skipped) return 'skipped';

  const evidenceIds = uniqueNonEmpty(node.evidenceIds);
  switch (status) {
    case 'pending':
      return 'pending';
    case 'in_progress':
      return 'in_progress';
    case 'failed':
      return 'failed';
    case 'completed': {
      const allValid =
        evidenceIds.length > 0 && evidenceIds.every((id) => ctx.validEvidenceIds.has(id));
      // 模型声明 completed ⇒ 最多给 claimed；verified 只由证据有效性派生。
      return allValid ? 'verified' : 'claimed';
    }
    default:
      return 'pending';
  }
}

// ─── projectPlan ─────────────────────────────────────────────────────────────

/** 模型可能塞进保留字段（`stepId` / `systemId`）的输入形态；显式声明以便类型层也能拦。 */
export type ProjectablePlanNode = HarnessPlanNode & {
  stepId?: unknown;
  systemId?: unknown;
};

export interface ProjectPlanOptions {
  /** 上一版计划投影；用于 id 引用校验与 localId→系统 id 的沿用。 */
  priorVersion?: TaskPlanVersion | null;
  /** 有效 Evidence id 集合（`verified` 判定唯一依据）。 */
  validEvidenceIds: ReadonlySet<string> | readonly string[];
  trigger: TaskPlanTrigger;
  /** 只有用户 redirect / 明确策略可传入；元素可是 localId 或系统 step id。 */
  skippedLocalIds?: Iterable<string>;
  /** 计划版本时间戳（缺省 new Date().toISOString()）。 */
  now?: string;
  /** 覆盖自动派生的版本号（默认 `prior.version + 1`，无 prior 为 0）。 */
  version?: number;
}

function toIdSet(ids: ReadonlySet<string> | readonly string[]): Set<string> {
  return ids instanceof Set ? new Set(ids) : new Set(ids ?? []);
}

function emptyBaseline(): TaskPlanVersion {
  return { version: -1, createdAt: '', trigger: 'init', steps: [] };
}

/**
 * 把 Harness 计划投影为一个 `TaskPlanVersion`（纯函数，不接存储）。
 */
export function projectPlan(
  harnessPlan: readonly ProjectablePlanNode[],
  opts: ProjectPlanOptions,
): TaskPlanVersion {
  const validEvidenceIds = toIdSet(opts.validEvidenceIds ?? []);
  const skipped = new Set(
    uniqueNonEmpty([...(opts.skippedLocalIds ?? [])].map((value) => String(value))),
  );
  const prior = opts.priorVersion ?? null;
  const priorById = new Map<string, TaskStep>();
  if (prior) for (const step of prior.steps) priorById.set(step.id, step);

  const version = opts.version ?? (prior ? prior.version + 1 : 0);
  if (!Number.isSafeInteger(version) || version < 0) {
    throw new Error(`projectPlan: invalid plan version ${String(opts.version)}`);
  }
  const now = opts.now ?? new Date().toISOString();
  const steps: TaskStep[] = [];
  const claimedIds = new Set<string>();

  (harnessPlan ?? []).forEach((node, index) => {
    if (!node || typeof node !== 'object') {
      throw new Error(`projectPlan: plan node at index ${index} is not an object`);
    }
    // 1) 保留字段：系统 id 不得由模型自带/修改。
    if (node.stepId !== undefined || node.systemId !== undefined) {
      throw new TaskError(
        'TASK_PLAN_STEP_ID_CONFLICT',
        `plan node at index ${index} carries the reserved system id field (stepId/systemId); ` +
          'system step ids are assigned by the projection layer only',
        { stepId: String(node.stepId ?? node.systemId ?? '') },
      );
    }

    // 2) localId → 系统 id。
    const rawId = normalizeLocalId(String((node as HarnessPlanNode).id ?? ''));
    const localId = rawId || anonymousLocalId(node.description, index);
    let systemId: string;
    if (isSystemStepId(rawId)) {
      if (!priorById.has(rawId)) {
        throw new TaskError(
          'TASK_PLAN_UNKNOWN_STEP_ID',
          `plan references step id "${rawId}" that does not exist in the previous plan version`,
          { stepId: rawId },
        );
      }
      systemId = rawId;
    } else if (rawId.startsWith(STEP_ID_PREFIX)) {
      // 形状像系统 id 但 hash 不合法 ⇒ 模型伪造系统 id 命名空间。
      throw new TaskError(
        'TASK_PLAN_STEP_ID_CONFLICT',
        `plan node id "${rawId}" uses the reserved "${STEP_ID_PREFIX}" namespace; ` +
          'the model may only supply a local id, the projection layer assigns the system id',
        { stepId: rawId },
      );
    } else {
      systemId = deriveStepId(localId);
    }

    if (claimedIds.has(systemId)) {
      throw new TaskError(
        'TASK_PLAN_STEP_ID_CONFLICT',
        `plan produced duplicate step id "${systemId}" (local id "${localId}")`,
        { stepId: systemId },
      );
    }
    claimedIds.add(systemId);

    // 3) 状态派生（§14.2）。
    const skipRequested = skipped.has(localId) || skipped.has(systemId) || skipped.has(rawId);
    const status = deriveStepStatus(node, { validEvidenceIds, skipped: skipRequested, stepId: systemId });
    const evidenceIds = uniqueNonEmpty(node.evidenceIds);
    const description = (node.description ?? '').trim();
    if (!description) {
      throw new Error(`projectPlan: plan node "${systemId}" has an empty description`);
    }

    const priorStep = priorById.get(systemId);
    const done = status === 'verified' || status === 'claimed' || status === 'skipped' || status === 'failed';
    const step: TaskStep = {
      id: systemId,
      description,
      status,
      evidenceIds,
    };
    const failureReason = (node.failureReason ?? '').trim();
    if (status === 'failed' && failureReason) step.failureReason = failureReason;
    else if (priorStep?.failureReason && priorStep.status === 'failed' && status === 'failed') {
      step.failureReason = priorStep.failureReason;
    }
    if (status === 'in_progress' || done) {
      step.startedAt = priorStep?.startedAt ?? now;
    }
    if (done) step.completedAt = priorStep?.completedAt ?? now;
    if (priorStep?.dependsOn) step.dependsOn = [...priorStep.dependsOn];

    steps.push(step);
  });

  return { version, createdAt: now, trigger: opts.trigger, steps };
}

export interface ProjectPlanWithDiffResult {
  plan: TaskPlanVersion;
  diff: PlanProjectionDiff;
}

/** `projectPlan` + `diffPlans` 的便捷组合，供上层直接记 `task.plan.version.created` 事件。 */
export function projectPlanWithDiff(
  harnessPlan: readonly ProjectablePlanNode[],
  opts: ProjectPlanOptions,
): ProjectPlanWithDiffResult {
  const plan = projectPlan(harnessPlan, opts);
  return { plan, diff: diffPlans(opts.priorVersion ?? null, plan) };
}

// ─── diff（供上层记事件） ────────────────────────────────────────────────────

export type PlanStepChangedField = 'status' | 'description' | 'evidenceIds';

export interface PlanStepModification {
  stepId: string;
  from: TaskStepStatus;
  to: TaskStepStatus;
  changedFields: PlanStepChangedField[];
  prior: TaskStep;
  next: TaskStep;
}

export interface PlanProjectionDiff {
  added: TaskStep[];
  removed: TaskStep[];
  modified: PlanStepModification[];
}

function sameStringList(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const setA = new Set(a);
  return b.every((value) => setA.has(value));
}

/**
 * 计划版本间 diff（纯函数）。`prev` 缺省视为空计划（首版全部为 added）。
 * `removed` 只表示「从投影快照里消失」，不做级联删除；验收层仍以 Evidence 为准。
 */
export function diffPlans(
  prev: TaskPlanVersion | null | undefined,
  next: TaskPlanVersion,
): PlanProjectionDiff {
  const baseline = prev ?? emptyBaseline();
  const prevById = new Map<string, TaskStep>();
  for (const step of baseline.steps) prevById.set(step.id, step);
  const nextIds = new Set(next.steps.map((step) => step.id));

  const added: TaskStep[] = [];
  const modified: PlanStepModification[] = [];
  for (const step of next.steps) {
    const priorStep = prevById.get(step.id);
    if (!priorStep) {
      added.push(step);
      continue;
    }
    const changedFields: PlanStepChangedField[] = [];
    if (priorStep.status !== step.status) changedFields.push('status');
    if (priorStep.description !== step.description) changedFields.push('description');
    if (!sameStringList(priorStep.evidenceIds, step.evidenceIds)) changedFields.push('evidenceIds');
    if (changedFields.length > 0) {
      modified.push({
        stepId: step.id,
        from: priorStep.status,
        to: step.status,
        changedFields,
        prior: priorStep,
        next: step,
      });
    }
  }

  const removed = baseline.steps.filter((step) => !nextIds.has(step.id));
  return { added, removed, modified };
}

export function isPlanDiffEmpty(diff: PlanProjectionDiff): boolean {
  return diff.added.length === 0 && diff.removed.length === 0 && diff.modified.length === 0;
}

/** diff 的事件摘要（§14.9 `task.plan.version.created` 的 payload 友好形态）。 */
export function planDiffSummary(diff: PlanProjectionDiff): {
  added: number;
  removed: number;
  modified: number;
} {
  return { added: diff.added.length, removed: diff.removed.length, modified: diff.modified.length };
}

// ─── replan 治理（§5.2 预算 / 冷却 / 阈值） ──────────────────────────────────

export interface ReplanAttempt {
  /** epoch ms，便于与 `minIntervalMs` 直接比较。 */
  atMs: number;
  trigger: TaskPlanTrigger;
  /** 本次 replan 消耗（用于 tokenBudget 对账）。 */
  tokensUsed?: number;
}

export interface ReplanHistory {
  attempts?: readonly ReplanAttempt[];
  /** 连续无进展次数（来自 GoalTracker 或 `trackClaimedProgress`）。 */
  noProgressCount?: number;
  /** 连续 claimed（自述完成但缺证据）次数，§14.4。 */
  claimedStreak?: number;
  /** 已累计 replan 消耗（缺省由 attempts[].tokensUsed 求和）。 */
  tokensUsed?: number;
}

export type ReplanDenyReason =
  | 'budget_exhausted'
  | 'cooldown'
  | 'trigger_not_met'
  | 'token_budget_exhausted';

export interface ReplanDecision {
  allowed: boolean;
  reason: ReplanDenyReason | 'allowed';
  detail: string;
  /** 冷却类拒绝：还需等待多少毫秒。 */
  retryAfterMs?: number;
  /** 剩余可用 replan 次数。 */
  remainingReplans: number;
}

function toEpochMs(value: number | string | Date): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return value;
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : NaN;
  }
  return parsed;
}

/**
 * Replan 治理纯决策器（无副作用、无时钟：`now` 一律外部注入，便于测试）。
 * 预算/冷却/阈值全部来自 protocol 的 `ReplanPolicy`，默认值取 `DEFAULT_REPLAN_POLICY`。
 */
export class ReplanGate {
  readonly policy: ReplanPolicy;

  constructor(policy?: Partial<ReplanPolicy>) {
    const merged: ReplanPolicy = {
      maxReplansPerTask: policy?.maxReplansPerTask ?? DEFAULT_REPLAN_POLICY.maxReplansPerTask,
      minIntervalMs: policy?.minIntervalMs ?? DEFAULT_REPLAN_POLICY.minIntervalMs,
      triggerThreshold: policy?.triggerThreshold ?? DEFAULT_REPLAN_POLICY.triggerThreshold,
      tokenBudget: policy?.tokenBudget ?? DEFAULT_REPLAN_POLICY.tokenBudget,
    };
    // 复用 protocol 的 zod 契约，避免这里长出第二套字段校验规则。
    this.policy = replanPolicySchema.parse(merged);
  }

  /** 判定此刻是否允许 replan；不做任何写入，history 由调用方维护。 */
  allowReplan(history: ReplanHistory = {}, now: number | string | Date = Date.now()): ReplanDecision {
    const attempts = [...(history.attempts ?? [])].sort((a, b) => a.atMs - b.atMs);
    const remaining = this.policy.maxReplansPerTask - attempts.length;
    const atMs = toEpochMs(now);
    if (!Number.isFinite(atMs)) {
      throw new Error(`ReplanGate.allowReplan: invalid "now" value ${String(now)}`);
    }

    const base = { remainingReplans: Math.max(0, remaining) };

    if (attempts.length >= this.policy.maxReplansPerTask) {
      return {
        ...base,
        allowed: false,
        reason: 'budget_exhausted',
        detail: `replan budget exhausted: ${attempts.length}/${this.policy.maxReplansPerTask}`,
      };
    }

    if (attempts.length > 0 && this.policy.minIntervalMs > 0) {
      const last = attempts[attempts.length - 1];
      const elapsed = atMs - last.atMs;
      if (elapsed < this.policy.minIntervalMs) {
        return {
          ...base,
          allowed: false,
          reason: 'cooldown',
          detail: `replan cooldown active: last replan ${elapsed}ms ago < ${this.policy.minIntervalMs}ms`,
          retryAfterMs: this.policy.minIntervalMs - elapsed,
        };
      }
    }

    const tokensUsed =
      history.tokensUsed ?? attempts.reduce((total, attempt) => total + (attempt.tokensUsed ?? 0), 0);
    if (this.policy.tokenBudget > 0 && tokensUsed >= this.policy.tokenBudget) {
      return {
        ...base,
        allowed: false,
        reason: 'token_budget_exhausted',
        detail: `replan token budget exhausted: ${tokensUsed}/${this.policy.tokenBudget}`,
      };
    }

    const stallSignal = Math.max(history.noProgressCount ?? 0, history.claimedStreak ?? 0);
    if (stallSignal < this.policy.triggerThreshold) {
      return {
        ...base,
        allowed: false,
        reason: 'trigger_not_met',
        detail: `replan trigger not met: stall signal ${stallSignal} < ${this.policy.triggerThreshold}`,
      };
    }

    return {
      ...base,
      allowed: true,
      reason: 'allowed',
      detail: `replan allowed: ${attempts.length}/${this.policy.maxReplansPerTask} used`,
    };
  }

  /** 记录一次已发生的 replan（返回新 history，不修改入参）。 */
  static withAttempt(history: ReplanHistory, attempt: ReplanAttempt): ReplanHistory {
    const attempts = [...(history.attempts ?? []), attempt];
    const tokensUsed = attempts.reduce((total, item) => total + (item.tokensUsed ?? 0), 0);
    return { ...history, attempts, tokensUsed };
  }
}

export function createReplanGate(policy?: Partial<ReplanPolicy>): ReplanGate {
  return new ReplanGate(policy);
}

// ─── claimed 纠错路径的 noProgress 计数（§14.4 纯函数） ──────────────────────

/** stepId → 进展签名（status + evidenceIds + description 的稳定摘要）。 */
export type StepSignatures = Record<string, string>;

export interface ClaimedProgressSnapshot {
  /** 上一次观测到的签名，用于下次比较。 */
  signatures: StepSignatures;
  /** stepId → 连续无进展次数（签名未变化）。 */
  counters: Record<string, number>;
  /** 整体连续无进展次数（签名集合完全没变时 +1，任何变化都清零）。 */
  noProgressCount: number;
}

export interface ClaimedProgressResult extends ClaimedProgressSnapshot {
  progressed: boolean;
  /** 本次与上次签名完全一致的 stepId 集合。 */
  staleStepIds: string[];
  /** 本次参与统计（claimed）的 stepId 集合。 */
  trackedStepIds: string[];
}

/** 单个步骤的进展签名：状态 + 证据集合 + 描述。 */
export function stepProgressSignature(
  step: Pick<TaskStep, 'id' | 'status' | 'evidenceIds' | 'description'>,
): string {
  const evidence = [...uniqueNonEmpty(step.evidenceIds)].sort().join(',');
  return `${step.status}|${step.description.trim()}|[${evidence}]`;
}

/** 取计划里所有 `claimed` 步骤的签名单（§14.4：只有可显示不可验收的步骤才计入）。 */
export function claimedSignatures(plan: TaskPlanVersion | null | undefined): StepSignatures {
  const signatures: StepSignatures = {};
  for (const step of plan?.steps ?? []) {
    if (step.status === 'claimed') signatures[step.id] = stepProgressSignature(step);
  }
  return signatures;
}

function signaturesEqual(a: StepSignatures, b: StepSignatures): boolean {
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  return keysA.every((key) => a[key] === b[key]);
}

/**
 * §14.4 的 noProgress 计数纯函数：把「签名是否变化」转成连续无进展次数，供 Goal gate 决定
 * `continue → 计入 noProgressCount → 达阈值转 blocked` 的纠错路径，禁止无限重试。
 *
 * @param prevSignatures 上一次快照（首轮传 null）
 * @param currentSignatures 本次 `claimedSignatures(plan)` 的结果
 */
export function trackClaimedProgress(
  prevSignatures: ClaimedProgressSnapshot | null | undefined,
  currentSignatures: StepSignatures,
): ClaimedProgressResult {
  const current: StepSignatures = { ...(currentSignatures ?? {}) };
  const prev = prevSignatures?.signatures ?? {};
  const prevCounters = prevSignatures?.counters ?? {};
  const progressed = prevSignatures ? !signaturesEqual(prev, current) : false;

  const counters: Record<string, number> = {};
  const staleStepIds: string[] = [];
  for (const [stepId, signature] of Object.entries(current)) {
    const unchanged = Object.prototype.hasOwnProperty.call(prev, stepId) && prev[stepId] === signature;
    // 第一次「签名未变」计 1，与整体 noProgressCount 同调。
    const nextCount = unchanged ? (prevCounters[stepId] ?? 0) + 1 : 0;
    if (nextCount > 0) counters[stepId] = nextCount;
    if (unchanged) staleStepIds.push(stepId);
  }

  // 没有任何 claimed 步骤时，claimed 停滞信号不成立（本函数只度量 §14.4 的
  // 「可显示不可验收」步骤进展）；整体无进展计数归 GoalTracker，不在此伪造。
  const nothingTracked = Object.keys(current).length === 0;
  const noProgressCount = !prevSignatures
    ? 0
    : progressed || nothingTracked
      ? 0
      : (prevSignatures.noProgressCount ?? 0) + 1;

  return {
    progressed,
    signatures: current,
    counters,
    noProgressCount,
    staleStepIds,
    trackedStepIds: Object.keys(current),
  };
}

/** 判定某步是否已达到「连续 claimed 无进展」阈值（§14.4 第 3 步转 blocked）。 */
export function claimedStallExceeded(
  snapshot: ClaimedProgressSnapshot,
  stepId: string,
  threshold: number,
): boolean {
  return (snapshot.counters[stepId] ?? 0) >= threshold;
}
