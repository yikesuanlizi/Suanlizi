// 目标状态管理：GoalTracker 维护 HarnessState，支持状态转换、无进展检测、续跑计数、
// 多 run 隔离（Gap 6）和 tags merge 持久化（实施点 1）。
//
// 借鉴 DeerFlow GoalState + Reasonix goalMachine。

import type { ThreadId, ThreadMeta } from '@suanlizi/protocol';
import type { GoalEvaluation } from '@suanlizi/protocol';
import type {
  HarnessPlanNode,
  HarnessState,
} from './types.js';

// ─── ThreadStore 最小接口（避免依赖具体实现） ─────────────────────────────────
export interface GoalTrackerStore {
  getThread(threadId: ThreadId): Promise<ThreadMeta | null>;
  updateThreadMetadata(
    threadId: ThreadId,
    patch: Partial<Pick<ThreadMeta, 'tags'>>,
  ): Promise<void>;
}

// ─── 常量 ────────────────────────────────────────────────────────────────────

const TAG_ACTIVE_RUN_ID = 'activeHarnessRunId';
const TAG_STATE_PREFIX = 'harnessState:';

function tagKeyForState(harnessRunId: string): string {
  return `${TAG_STATE_PREFIX}${harnessRunId}`;
}

function generateRunId(): string {
  return `hrun_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

// ─── GoalTracker ─────────────────────────────────────────────────────────────

export class GoalTracker {
  private state: HarnessState;
  private readonly threadId: ThreadId;
  private readonly harnessRunId: string;
  private readonly explicitHarnessRunId: string | undefined;

  constructor(threadId: ThreadId, harnessRunId?: string) {
    this.threadId = threadId;
    this.explicitHarnessRunId = harnessRunId;
    this.harnessRunId = harnessRunId ?? generateRunId();
    this.state = {
      harnessRunId: this.harnessRunId,
      goal: {
        objective: '',
        acceptanceCriteria: [],
        maxContinuations: 8,
        maxNoProgress: 2,
      },
      plan: [],
      activeNodeId: null,
      iteration: 0,
      noProgressCount: 0,
      lastEvaluation: null,
      lastProgressSignature: null,
      status: 'active',
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }

  // ─── 基本访问 ──────────────────────────────────────────────────────────────

  getHarnessRunId(): string {
    return this.harnessRunId;
  }

  getThreadId(): ThreadId {
    return this.threadId;
  }

  getState(): HarnessState {
    return this.state;
  }

  // ─── 目标设置 ──────────────────────────────────────────────────────────────

  setGoal(
    objective: string,
    acceptanceCriteria: string[],
    options?: { maxContinuations?: number; maxNoProgress?: number },
  ): void {
    this.state.goal = {
      objective,
      acceptanceCriteria,
      maxContinuations: options?.maxContinuations ?? 8,
      maxNoProgress: options?.maxNoProgress ?? 2,
    };
    this.state.iteration = 0;
    this.state.noProgressCount = 0;
    this.state.status = 'active';
    this.state.startedAt = new Date().toISOString();
    this.touch();
  }

  // ─── 评估记录与状态转换 ─────────────────────────────────────────────────────

  /**
   * 每次 iteration 后调用：记录评估结果，更新状态。
   * 返回最新状态。
   */
  recordEvaluation(evalResult: GoalEvaluation): HarnessState {
    this.state.lastEvaluation = evalResult;
    this.state.iteration += 1;

    // 无进展检测
    if (this.state.lastProgressSignature === evalResult.progressSignature) {
      this.state.noProgressCount += 1;
    } else {
      this.state.noProgressCount = 0;
      this.state.lastProgressSignature = evalResult.progressSignature;
    }

    // 状态转换
    if (evalResult.satisfied) {
      this.state.status = 'satisfied';
    } else if (evalResult.status === 'needs_user_input' || evalResult.status === 'blocked') {
      // 不直接转 blocked，由上层 TaskHarnessEngine 决定是否暂停
      // 这里只标记为 active，让 canContinue 判断
    }

    this.touch();
    return this.state;
  }

  // ─── 无进展与续跑判定 ──────────────────────────────────────────────────────

  checkNoProgress(): boolean {
    return this.state.noProgressCount >= this.state.goal.maxNoProgress;
  }

  canContinue(): boolean {
    if (this.state.status !== 'active') return false;
    if (this.state.iteration >= this.state.goal.maxContinuations) {
      this.state.status = 'max_continuations';
      return false;
    }
    if (this.checkNoProgress()) {
      this.state.status = 'no_progress';
      return false;
    }
    return true;
  }

  // ─── 终态标记 ──────────────────────────────────────────────────────────────

  markSatisfied(): void {
    this.state.status = 'satisfied';
    this.touch();
  }

  markBlocked(reason: string): void {
    this.state.status = 'blocked';
    if (this.state.lastEvaluation) {
      this.state.lastEvaluation.blocker = reason;
    }
    this.touch();
  }

  markMaxContinuations(): void {
    this.state.status = 'max_continuations';
    this.touch();
  }

  markNoProgress(): void {
    this.state.status = 'no_progress';
    this.touch();
  }

  markCancelled(): void {
    this.state.status = 'cancelled';
    this.touch();
  }

  // ─── Plan 管理 ─────────────────────────────────────────────────────────────

  updatePlan(nodes: HarnessPlanNode[]): void {
    this.state.plan = nodes;
    this.touch();
  }

  advanceNode(nodeId: string): void {
    for (const node of this.state.plan) {
      if (node.id === nodeId) {
        node.status = 'in_progress';
        this.state.activeNodeId = nodeId;
        break;
      }
    }
    this.touch();
  }

  completeNode(nodeId: string): void {
    for (const node of this.state.plan) {
      if (node.id === nodeId) {
        node.status = 'completed';
        if (this.state.activeNodeId === nodeId) {
          this.state.activeNodeId = null;
        }
        break;
      }
    }
    this.touch();
  }

  failNode(nodeId: string, reason: string): void {
    for (const node of this.state.plan) {
      if (node.id === nodeId) {
        node.status = 'failed';
        node.failureReason = reason;
        if (this.state.activeNodeId === nodeId) {
          this.state.activeNodeId = null;
        }
        break;
      }
    }
    this.touch();
  }

  // ─── 持久化（Gap 6 + 实施点 1） ─────────────────────────────────────────────

  /**
   * 持久化 HarnessState 到 thread.tags。
   *
   * Gap 6: 多 run 隔离 — 用 `harnessState:<runId>` 命名空间，`activeHarnessRunId` 互斥。
   * 实施点 1: tags merge — store.updateThreadMetadata 的 tags 是全量替换，必须先读后 merge。
   */
  async persist(store: GoalTrackerStore): Promise<void> {
    const thread = await store.getThread(this.threadId);
    const existingTags: Record<string, string> = thread?.tags ?? {};

    const harnessTags: Record<string, string> = {
      [tagKeyForState(this.harnessRunId)]: JSON.stringify(this.state),
    };
    if (this.state.status === 'active') {
      harnessTags[TAG_ACTIVE_RUN_ID] = this.harnessRunId;
    } else {
      harnessTags[TAG_ACTIVE_RUN_ID] = '';  // 清空 active
    }

    // 实施点 1: merge 而非替换，保留 runConfig/compactedSummary/memory 等原有 tags
    await store.updateThreadMetadata(this.threadId, {
      tags: { ...existingTags, ...harnessTags },
    });
  }

  /**
   * 从 thread.tags 恢复 HarnessState。
   * 返回 null 表示无 active harness run。
   */
  async load(store: GoalTrackerStore): Promise<HarnessState | null> {
    const thread = await store.getThread(this.threadId);
    if (!thread?.tags) return null;

    const activeRunId = thread.tags[TAG_ACTIVE_RUN_ID];
    const targetRunId = this.explicitHarnessRunId ?? activeRunId;
    if (!targetRunId) return null;

    const stateJson = thread.tags[tagKeyForState(targetRunId)];
    if (!stateJson) return null;

    try {
      const parsed = JSON.parse(stateJson) as HarnessState;
      this.state = parsed;
      // harnessRunId 字段以 state 内的为准（支持服务重启后用同一 runId 恢复）
      return this.state;
    } catch {
      return null;
    }
  }

  // ─── 互斥检查 ──────────────────────────────────────────────────────────────

  /**
   * 检查 thread 是否可以开启新的 harness run。
   * 返回 true 表示无 active run，可以开启。
   */
  static async canStartNewHarness(
    store: GoalTrackerStore,
    threadId: ThreadId,
  ): Promise<boolean> {
    const thread = await store.getThread(threadId);
    const activeRunId = thread?.tags?.[TAG_ACTIVE_RUN_ID];
    return !activeRunId;
  }

  // ─── 内部工具 ──────────────────────────────────────────────────────────────

  private touch(): void {
    this.state.updatedAt = new Date().toISOString();
  }
}

// 导出常量供测试与 route 使用
export const GOAL_TRACKER_TAG_ACTIVE_RUN_ID = TAG_ACTIVE_RUN_ID;
export const GOAL_TRACKER_TAG_STATE_PREFIX = TAG_STATE_PREFIX;
