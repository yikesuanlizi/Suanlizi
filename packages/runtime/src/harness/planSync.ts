// P3 计划投影接线层（计划 §7 P3 / §14.2 / §14.4）：
// 1. 从模型 turn 输出中提取计划块（```plan 代码块，JSON）；
// 2. 首版计划直接投影为 TaskPlanVersion（系统分配 step id，trigger=init）；
// 3. 模型后续新计划先过 ReplanGate（预算/冷却/触发阈值），再 projectPlanWithDiff 产出
//    added/removed/modified diff；投影被拒（引用不存在 id / 伪造系统 id / 非法状态）时
//    fail-closed：保留上一版计划，把拒绝原因上抛给调用方注入续跑指令；
// 4. claimed/verified 派生完全由 planProjection 依据有效 Evidence id 集合裁决，
//    本模块只负责把「有效证据 id 集合」从 EvidenceLedger 传进去，不另立第二套判定。
//
// 本模块不直接改 GoalTracker（避免循环依赖）；调用方（TaskHarnessEngine）拿到
// `toHarnessNodes()` 的结果后自行 `goalTracker.updatePlan` 并持久化。

import type { ThreadItem } from '@suanlizi/protocol';
import { TaskError } from '@suanlizi/protocol';
import type { TaskPlanTrigger, TaskPlanVersion } from '@suanlizi/protocol';
import {
  claimedSignatures,
  projectPlanWithDiff,
  ReplanGate,
  trackClaimedProgress,
  type ClaimedProgressSnapshot,
  type PlanProjectionDiff,
  type ReplanDecision,
  type ReplanHistory,
} from '../task/planProjection.js';
import { isWorkflowEvidenceId } from './evidenceLedger.js';
import type {
  EvidenceReceipt,
  HarnessPlanNode,
  HarnessPlanNodeStatus,
} from './types.js';

// ─── 计划提取 ────────────────────────────────────────────────────────────────

export const PLAN_BLOCK_LANGUAGE = 'plan';

/** HARNESS_PLAN_NODE_STATUSES 的镜像；为避免循环导入在此窄化声明。 */
const NODE_STATUSES: readonly HarnessPlanNodeStatus[] = [
  'pending',
  'in_progress',
  'completed',
  'failed',
];

export interface PlanExtractionResult {
  nodes: HarnessPlanNode[];
  /** 提取/解析失败原因；成功时为空。 */
  error?: string;
}

/** 从 ```plan 代码块解析模型计划；块不存在返回 null，块存在但非法返回 error（fail-closed）。 */
export function extractPlanFromItems(items: readonly ThreadItem[]): PlanExtractionResult | null {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i];
    if (item?.type !== 'agent_message') continue;
    const text = item.text ?? '';
    const marker = '```' + PLAN_BLOCK_LANGUAGE;
    const start = text.indexOf(marker);
    if (start < 0) continue;
    const bodyStart = start + marker.length;
    const end = text.indexOf('```', bodyStart);
    if (end < 0) return { nodes: [], error: 'plan block is not closed' };
    const json = text.slice(bodyStart, end).trim();
    return parsePlanBlock(json);
  }
  return null;
}

function parsePlanBlock(json: string): PlanExtractionResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    return { nodes: [], error: `plan block is not valid JSON: ${(err as Error).message}` };
  }
  const rawSteps = Array.isArray(parsed)
    ? parsed
    : (parsed as { steps?: unknown })?.steps;
  if (!Array.isArray(rawSteps) || rawSteps.length === 0) {
    return { nodes: [], error: 'plan block must be a non-empty array of steps' };
  }

  const nodes: HarnessPlanNode[] = [];
  for (let index = 0; index < rawSteps.length; index += 1) {
    const entry = rawSteps[index] as Record<string, unknown> | null;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      return { nodes: [], error: `plan step at index ${index} is not an object` };
    }
    const description = typeof entry.description === 'string' ? entry.description.trim() : '';
    if (!description) {
      return { nodes: [], error: `plan step at index ${index} is missing a description` };
    }
    const status = typeof entry.status === 'string' && NODE_STATUSES.includes(entry.status as HarnessPlanNodeStatus)
      ? (entry.status as HarnessPlanNodeStatus)
      : 'pending';
    // 保留字段（stepId/systemId）在 projectPlan 层被拒绝；这里提前拦截并给出可读原因。
    if (entry.stepId !== undefined || entry.systemId !== undefined) {
      return { nodes: [], error: `plan step at index ${index} carries the reserved system id field` };
    }
    nodes.push({
      // 模型可带 localId（非系统命名空间）；缺省时 projectPlan 用 description 匿名派生。
      id: typeof entry.id === 'string' ? entry.id : '',
      description,
      status,
      evidenceIds: Array.isArray(entry.evidenceIds)
        ? (entry.evidenceIds as unknown[]).filter((v): v is string => typeof v === 'string')
        : [],
      ...(typeof entry.failureReason === 'string' ? { failureReason: entry.failureReason } : {}),
    });
  }
  return { nodes };
}

// ─── 有效证据 id 集合 ────────────────────────────────────────────────────────

/**
 * verified 派生的唯一依据（§14.4）：ledger 中 `passed` 的收据 id（thread_item 与
 * workflow 证据同权）。failed/unknown 证据不得支撑 verified。
 */
export function validEvidenceIdsFromReceipts(receipts: readonly EvidenceReceipt[]): Set<string> {
  const ids = new Set<string>();
  for (const receipt of receipts) {
    if (receipt.status !== 'passed') continue;
    if (!receipt.id) continue;
    ids.add(receipt.id);
    // workflow 证据同时接受其规范 id 形态（wev_run_...），保持 ledger 产出的原值即可。
    if (isWorkflowEvidenceId(receipt.id)) continue;
  }
  return ids;
}

// ─── TaskPlanVersion → HarnessPlanNode 回投影 ───────────────────────────────

/**
 * 把投影后的计划版本回映射为 GoalTracker 的四态节点。
 * verified/claimed → completed（进展语义一致）；skipped → completed（不再执行，
 * 不得阻塞 todo_complete gate）；pending/in_progress/failed 原样保留。
 */
export function toHarnessNodes(version: TaskPlanVersion): HarnessPlanNode[] {
  return version.steps.map((step) => ({
    id: step.id,
    description: step.description,
    status: step.status === 'failed' ? 'failed' : step.status === 'pending' ? 'pending' : step.status === 'in_progress' ? 'in_progress' : 'completed',
    evidenceIds: [...step.evidenceIds],
    ...(step.failureReason ? { failureReason: step.failureReason } : {}),
  }));
}

// ─── HarnessPlanSync ─────────────────────────────────────────────────────────

export interface ApplyModelPlanOptions {
  /** ledger passed 收据 id 集合（verified 判定唯一依据）。 */
  validEvidenceIds: ReadonlySet<string>;
  /** epoch ms（ReplanGate 冷却对账用）。 */
  nowMs: number;
  /** GoalTracker 连续无进展次数（replan 触发阈值信号之一）。 */
  noProgressCount?: number;
  /** claimed 步骤连续无进展次数（replan 触发阈值信号之二，来自 claimProgress）。 */
  claimedStreak?: number;
}

export type ApplyModelPlanResult =
  | { applied: true; plan: TaskPlanVersion; diff: PlanProjectionDiff; first: boolean }
  | { applied: false; reason: 'denied'; decision: ReplanDecision }
  | { applied: false; reason: 'rejected'; error: string }
  | { applied: false; reason: 'unchanged' };

export class HarnessPlanSync {
  private readonly gate: ReplanGate;
  private history: ReplanHistory = {};
  private prior: TaskPlanVersion | null = null;
  private claimedSnapshot: ClaimedProgressSnapshot | null = null;

  constructor(gate?: ReplanGate) {
    this.gate = gate ?? createDefaultReplanGate();
  }

  getPriorVersion(): TaskPlanVersion | null {
    return this.prior;
  }

  getReplanHistory(): ReplanHistory {
    return this.history;
  }

  /**
   * 进程重启后从持久化的 HarnessPlanNode[] 重建先验版本（保守映射：completed→claimed，
   * verified 与否留待下一轮投影按当时有效证据重判）。空计划不动作；已有先验时不覆盖。
   */
  restorePriorFromHarnessNodes(nodes: readonly HarnessPlanNode[]): void {
    if (this.prior !== null || nodes.length === 0) return;
    this.prior = {
      version: 0,
      createdAt: new Date().toISOString(),
      trigger: 'init',
      steps: nodes.map((node) => ({
        id: node.id,
        description: node.description,
        status: node.status === 'failed'
          ? 'failed'
          : node.status === 'in_progress'
            ? 'in_progress'
            : node.status === 'completed'
              ? 'claimed'
              : 'pending',
        evidenceIds: [...node.evidenceIds],
        ...(node.failureReason ? { failureReason: node.failureReason } : {}),
      })),
    };
  }

  /**
   * 提交模型新计划。
   * - 首版（prior 为空）直通投影，不消耗 replan 预算（trigger=init）；
   * - 后续版本必须过 ReplanGate（预算/冷却/触发阈值），再经投影层校验与 diff。
   */
  applyModelPlan(nodes: readonly HarnessPlanNode[], opts: ApplyModelPlanOptions): ApplyModelPlanResult {
    const first = this.prior === null;
    let trigger: TaskPlanTrigger = first ? 'init' : 'replan';

    if (!first) {
      const decision = this.gate.allowReplan(
        {
          ...this.history,
          noProgressCount: opts.noProgressCount ?? this.history.noProgressCount,
          claimedStreak: opts.claimedStreak ?? this.history.claimedStreak,
        },
        opts.nowMs,
      );
      if (!decision.allowed) {
        return { applied: false, reason: 'denied', decision };
      }
    }

    let plan: TaskPlanVersion;
    let diff: PlanProjectionDiff;
    try {
      const projected = projectPlanWithDiff(nodes, {
        priorVersion: this.prior,
        validEvidenceIds: opts.validEvidenceIds,
        trigger,
      });
      plan = projected.plan;
      diff = projected.diff;
    } catch (err) {
      // fail-closed：投影被拒（引用不存在 id / 伪造系统 id / 非法状态等）→ 保留上一版。
      const message = err instanceof TaskError
        ? `${err.code}: ${err.message}`
        : `plan projection failed: ${(err as Error).message}`;
      return { applied: false, reason: 'rejected', error: message };
    }

    if (!first && diff.added.length === 0 && diff.removed.length === 0 && diff.modified.length === 0) {
      return { applied: false, reason: 'unchanged' };
    }

    this.prior = plan;
    if (!first) {
      this.history = ReplanGate.withAttempt(this.history, {
        atMs: opts.nowMs,
        trigger,
        tokensUsed: 0,
      });
    }
    return { applied: true, plan, diff, first };
  }

  /**
   * claimed 步骤进展跟踪（§14.4）：每轮迭代观测一次（由调用方保证每轮只调一次），
   * 签名未变的 claimed 步骤累计 stall 计数；计划版本变化 ⇒ 签名集合变化 ⇒ 自动清零。
   */
  claimProgress() {
    const result = trackClaimedProgress(this.claimedSnapshot, claimedSignatures(this.prior));
    this.claimedSnapshot = {
      signatures: result.signatures,
      counters: result.counters,
      noProgressCount: result.noProgressCount,
    };
    return result;
  }
}

function createDefaultReplanGate(): ReplanGate {
  // 触发阈值默认走 protocol 的 DEFAULT_REPLAN_POLICY；harness 循环的迭代间隔即冷却尺度，
  // 这里保持库默认值，测试可通过构造参数注入更小的策略。
  return new ReplanGate();
}
