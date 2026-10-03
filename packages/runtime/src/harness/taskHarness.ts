// TaskHarnessEngine: 组装 HarnessLoop 主循环。
// 在 AgentLoop 之上构建跨 turn 自主循环：
//   Goal → Plan → Execute (AgentLoop.runTurn) → Critique → Replan → Verify
//
// Gap 3: runTurn(threadId, input, signal?, options?) — Step 10b 扩展后启用
// Gap 4: buildIterationContext → renderHarnessContextSlice → modeInstruction 注入
// Gap 5: resume 时 rebuildFromThreadItems 重建 ledger
// Gap 6: 互斥检查 canStartNewHarness
// Gap 9: hidden continuation 副作用通过 RunTurnOptions 控制

import type {
  GoalEvaluation,
  ThreadId,
  ThreadItem,
  UserInput,
  WorkflowScriptRequest,
} from '@suanlizi/protocol';
import type { ExperienceEngine } from '@suanlizi/context';
import type {
  HarnessConfig,
  HarnessResult,
  HarnessState,
  ReadinessResult,
  RunTurnOptions,
  StormBreakerResult,
} from './types.js';
import { DEFAULT_HARNESS_CONFIG } from './types.js';
import { EvidenceLedger, type WorkflowResultEvidenceInput } from './evidenceLedger.js';
import {
  GoalTracker,
  type GoalTrackerStore,
} from './goalTracker.js';
import { StormBreaker } from './stormBreaker.js';
import {
  HarnessContextManager,
  renderHarnessContextSlice,
  type HarnessContextStore,
} from './harnessContext.js';
import { ReadinessCritic } from './readinessCritic.js';
import { GoalEvaluator, type EvaluatorModelGateway } from './goalEvaluator.js';
import {
  extractPlanFromItems,
  HarnessPlanSync,
  toHarnessNodes,
  validEvidenceIdsFromReceipts,
} from './planSync.js';
import { extractWorkflowProposal, WORKFLOW_CONTINUATION_HINT } from './workflowProposal.js';

// HarnessRuntimeRegistry 用于区分 pause 与真正 cancel 的稳定 abort reason。
// runtime 通过 registry abort reason 区分暂停与真正取消。
const SUSPEND_ABORT_TYPE = 'suanlizi-harness-suspend';

function isSuspendAbort(signal?: AbortSignal): boolean {
  if (!signal?.aborted) return false;
  const reason: unknown = signal.reason;
  return Boolean(
    reason &&
      typeof reason === 'object' &&
      (reason as { type?: unknown }).type === SUSPEND_ABORT_TYPE,
  );
}

// ─── AgentLoop 最小接口（避免循环依赖） ─────────────────────────────────────
// 真实 AgentLoop 在 Step 10b 会扩展 runTurn 为 4 参数签名。
// 这里定义接口兼容 3 参数（现有）和 4 参数（Step 10b 后）两种调用方式。

export interface HarnessAgentLoop {
  /**
   * Gap 3: runTurn(threadId, userInput, signal?, options?)
   * Step 10b 前只接受 3 参数；Step 10b 后扩展为 4 参数。
   * TaskHarnessEngine 统一用 4 参数调用，Step 10b 前 options 字段会被忽略。
   */
  runTurn(
    threadId: ThreadId,
    userInput: UserInput,
    signal?: AbortSignal,
    options?: RunTurnOptions,
  ): Promise<{ items: ThreadItem[]; usage: import('@suanlizi/protocol').Usage | null }>;

  /**
   * P2: 同步 harness 的 goal/constraints/criteria 到 AgentContext.cognition.task
   */
  updateTaskCognition?(
    threadId: ThreadId,
    update: Partial<{
      goal: string;
      constraints: string[];
      verificationCriteria: string[];
    }>,
  ): void;
}

// ─── P6：Goal × Workflow 组合选项 ───────────────────────────────────────────

/**
 * GoalRun 与 WorkflowRun 的组合选项（计划 §12）。
 * 通过 runHarness/resumeHarness 的 options 传入；缺省时 harness 行为零变化。
 */
export interface HarnessWorkflowOptions {
  /** 所属 Task id：提案与证据都归属该任务。 */
  taskId: string;
  /** goal 侧 TaskRun id：写入 WorkflowScriptRequest.goalRunId，服务端按它归集预算。 */
  goalRunId: string;
  /**
   * 提案回调：API 层负责静态校验后落 blocked 请求并发事件；抛错（如预算拒绝）
   * 由 harness 收口为 blocker（fail-closed，不匿名吞掉）。
   */
  onRequest: (request: WorkflowScriptRequest) => void | Promise<void>;
  /** 证据预载：把历史 workflow_result seeds 物化进 ledger（GoalEvaluator 只读 Evidence 消费）。 */
  evidenceProvider?: (threadId: ThreadId) => Promise<WorkflowResultEvidenceInput[]>;
}

// ─── 辅助：构造续跑输入 ─────────────────────────────────────────────────────

function makeContinuationInput(
  evalResult: GoalEvaluation,
  state: HarnessState,
  contextSliceText: string,
  planSuffix = '',
): UserInput {
  const text = buildContinuationText(evalResult, state) + planSuffix;
  return {
    type: 'text',
    text,
    // Gap 4: 把 HarnessContextSlice 渲染文本注入 modeInstruction
    // 不塞 system prompt（避免打爆 cache prefix）
    modeInstruction: contextSliceText,
  };
}

function buildContinuationText(evalResult: GoalEvaluation, state: HarnessState): string {
  const lines: string[] = [];
  lines.push('[harness continuation]');
  lines.push(`Iteration: ${state.iteration + 1}`);
  lines.push(`Objective: ${state.goal.objective}`);
  lines.push('');
  if (evalResult.satisfied) {
    lines.push('Previous evaluation: satisfied. Please finalize.');
  } else {
    lines.push('Previous evaluation: not yet satisfied.');
    if (evalResult.failedCriteria.length > 0) {
      lines.push(`Failed criteria:`);
      for (const c of evalResult.failedCriteria) {
        lines.push(`- ${c}`);
      }
    }
    if (evalResult.blocker) {
      lines.push(`Blocker: ${evalResult.blocker}`);
    }
    if (evalResult.nextHint) {
      lines.push(`Next hint: ${evalResult.nextHint}`);
    }
  }
  lines.push('');
  lines.push('Continue working on the goal. Do not ask for user input unless blocked.');
  return lines.join('\n');
}

function makeRetryInput(retryInstruction: string): UserInput {
  return {
    type: 'text',
    text: `[readiness retry]\n${retryInstruction}`,
  };
}

function makeStormInput(stormResult: StormBreakerResult): UserInput {
  return {
    type: 'text',
    text: `[storm breaker]\n${stormResult.instruction ?? 'Change your approach and try a different strategy.'}`,
  };
}

function readinessEvaluation(readiness: ReadinessResult, state: HarnessState): GoalEvaluation {
  const failedGateSummary = readiness.failedGates
    .map((g) => `${g.name}:${g.detail}`)
    .join('|');
  return {
    satisfied: false,
    status: 'continue',
    passedCriteria: [],
    failedCriteria: state.goal.acceptanceCriteria,
    blocker: readiness.retryInstruction,
    evidenceSummary: '',
    progressSignature: `readiness::${failedGateSummary}`,
    reasoning: `Readiness gates failed: ${failedGateSummary}`,
  };
}

// ─── 简单 goal / criteria 提取（MVP 占位） ──────────────────────────────────

function extractGoalFromInput(userInput: UserInput): string {
  if (userInput.type === 'text') {
    return userInput.text.slice(0, 500);
  }
  if (userInput.type === 'multimodal') {
    const textPart = userInput.parts.find(p => p.type === 'text');
    if (textPart && textPart.type === 'text') return textPart.text.slice(0, 500);
  }
  return '(unknown goal)';
}

async function deriveCriteriaFromInput(userInput: UserInput): Promise<string[]> {
  // MVP 占位：从输入中简单提取
  // 生产环境应由 TaskHarnessEngine 配置的 criteriaDeriver 提供
  const text = userInput.type === 'text'
    ? userInput.text
    : (userInput.type === 'multimodal'
        ? userInput.parts.filter(p => p.type === 'text').map(p => p.type === 'text' ? p.text : '').join(' ')
        : '');
  // 简单启发：把句子拆成 criteria（MVP）
  const sentences = text.split(/[。.\n]/).map(s => s.trim()).filter(s => s.length > 5);
  if (sentences.length === 0) return ['任务完成'];
  return sentences.slice(0, 5);
}

// ─── TaskHarnessEngine ───────────────────────────────────────────────────────

export interface HarnessStateChangeCallback {
  (event: {
    threadId: ThreadId;
    harnessRunId: string;
    state: HarnessState;
    evaluation?: GoalEvaluation;
    evidenceCount: number;
  }): void;
}

export class TaskHarnessEngine {
  private readonly experienceEngine?: ExperienceEngine;
  private onStateChange?: HarnessStateChangeCallback;
  constructor(
    private agentLoop: HarnessAgentLoop,
    private model: EvaluatorModelGateway,
    private store: GoalTrackerStore & HarnessContextStore,
    private config: HarnessConfig = DEFAULT_HARNESS_CONFIG,
    experienceEngine?: ExperienceEngine,
    onStateChange?: HarnessStateChangeCallback,
  ) {
    this.experienceEngine = experienceEngine;
    this.onStateChange = onStateChange;
  }

  private notifyStateChange(
    threadId: ThreadId,
    goalTracker: GoalTracker,
    ledger: EvidenceLedger,
    evaluation?: GoalEvaluation,
  ): void {
    if (!this.onStateChange) return;
    try {
      this.onStateChange({
        threadId,
        harnessRunId: goalTracker.getHarnessRunId(),
        state: goalTracker.getState(),
        evaluation,
        evidenceCount: ledger.size(),
      });
    } catch {
      // swallow callback errors
    }
  }

  /**
   * 启动 harness run。
   *
   * 流程：
   * 1. 互斥检查（Gap 6）
   * 2. 初始化 GoalTracker / EvidenceLedger / HarnessContextManager / StormBreaker / ReadinessCritic / GoalEvaluator
   * 3. 第一轮：正常 runTurn（用户输入）
   * 4. 自主循环：readiness → storm → evaluator → replanner → continuation
   * 5. 到达 max_continuations 或无进展时暂停
   */
  async runHarness(
    threadId: ThreadId,
    userInput: UserInput,
    options?: {
      goal?: string;
      acceptanceCriteria?: string[];
      maxContinuations?: number;
      signal?: AbortSignal;
      /** Gap 1: 调用方预生成的 harnessRunId，用于 API 立即返回 */
      harnessRunId?: string;
      /** P6：Goal × Workflow 组合选项；缺省时行为零变化。 */
      workflow?: HarnessWorkflowOptions;
    },
  ): Promise<HarnessResult> {
    const signal = options?.signal;
    // Gap 1: 支持调用方预生成 harnessRunId，使 API 可立即返回
    // — English: accept caller-provided harnessRunId so API can return immediately
    const goalTracker = new GoalTracker(threadId, options?.harnessRunId);
    const ledger = new EvidenceLedger();
    const contextMgr = new HarnessContextManager(this.store, ledger, goalTracker);
    const stormBreaker = new StormBreaker({
      threshold: this.config.stormThreshold,
      blockedThreshold: this.config.stormBlockedThreshold,
    });
    const readinessCritic = new ReadinessCritic(ledger, goalTracker);
    const evaluator = new GoalEvaluator(this.model, this.config.evaluatorModelName);
    const harnessRunId = goalTracker.getHarnessRunId();
    // P3：计划投影接线 — 首版计划直通投影，后续模型计划受 ReplanGate 预算/冷却治理。
    const planSync = new HarnessPlanSync();

    // Gap 6: 互斥检查
    if (!(await GoalTracker.canStartNewHarness(this.store, threadId))) {
      throw new Error('Thread already has an active harness run. Cancel or wait for it to finish first.');
    }

    // 1. 设置 goal
    const objective = options?.goal ?? extractGoalFromInput(userInput);
    const criteria = options?.acceptanceCriteria ?? await deriveCriteriaFromInput(userInput);
    goalTracker.setGoal(objective, criteria, {
      maxContinuations: options?.maxContinuations ?? this.config.maxContinuations,
      maxNoProgress: this.config.maxNoProgress,
    });
    ledger.setCriteria(criteria);
    await goalTracker.persist(this.store);
    this.notifyStateChange(threadId, goalTracker, ledger);
    // P6：预载历史 workflow 证据，GoalEvaluator 从 Evidence 消费 Workflow 结构化结果（§12）。
    await this.preloadWorkflowEvidence(threadId, ledger, harnessRunId, options?.workflow);

    // P2: 同步 goal/criteria 到 AgentContext.cognition.task，供 TaskContextProvider 使用
    this.agentLoop.updateTaskCognition?.(threadId, {
      goal: objective,
      verificationCriteria: criteria,
    });

    // P2 取消链：首轮 + 自主循环整体包 try/catch/finally，
    // abort 或异常退出时也保证 GoalTracker 终态与 ledger 汇总落盘一次（不留 active/running 孤儿）。
    // — English: the whole continuation loop is wrapped so that cancellation / errors still
    //   settle a traceable terminal state into thread.tags.
    let result: { items: ThreadItem[]; usage: import('@suanlizi/protocol').Usage | null } = {
      items: [],
      usage: null,
    };
    let loopError: unknown;
    try {
      // 2. 第一轮：正常 runTurn（用户输入）
      result = await this.agentLoop.runTurn(threadId, userInput, signal);
      ledger.recordTurn(result.items, threadId, '', harnessRunId);
      this.syncPlanFromTurn(result.items, ledger, goalTracker, planSync);
      this.notifyStateChange(threadId, goalTracker, ledger);
      // P6：本轮输出携带 workflow 提案 → 交 API 层落批准请求，GoalRun 收口为 blocked。
      if (await this.handleWorkflowProposal(threadId, result.items, goalTracker, ledger, options?.workflow)) {
        return this.buildResult('blocked', goalTracker, ledger, result, threadId);
      }

      // 3. 自主循环
      while (goalTracker.canContinue()) {
        // P2 取消链：signal abort 后立刻退出续跑循环（不再发起新 turn / 新评估）
        if (signal?.aborted) break;

        // 3a. Readiness gate（确定性规则）
        const stormCheck = stormBreaker.check(result.items);
        const readiness = readinessCritic.check(result.items, stormCheck);
        if (!readiness.passed) {
          const eval_ = readinessEvaluation(readiness, goalTracker.getState());
          goalTracker.recordEvaluation(eval_);
          await goalTracker.persist(this.store);
          this.notifyStateChange(threadId, goalTracker, ledger, eval_);
          if (goalTracker.checkNoProgress()) {
            goalTracker.markNoProgress();
            await goalTracker.persist(this.store);
            this.notifyStateChange(threadId, goalTracker, ledger, eval_);
            return this.buildResult('no_progress', goalTracker, ledger, result, threadId);
          }
          if (!goalTracker.canContinue()) {
            const status = goalTracker.getState().status;
            await goalTracker.persist(this.store);
            this.notifyStateChange(threadId, goalTracker, ledger, eval_);
            if (status === 'max_continuations') {
              return this.buildResult('max_continuations', goalTracker, ledger, result, threadId);
            }
            return this.buildResult('no_progress', goalTracker, ledger, result, threadId);
          }
          // 注入 retry instruction，继续 AgentLoop
          const retryInput = makeRetryInput(readiness.retryInstruction ?? 'readiness gate failed');
          result = await this.agentLoop.runTurn(threadId, retryInput, signal, {
            source: 'harness',
            visibleToUser: false,
            harnessRunId,
            harnessIteration: goalTracker.getState().iteration,
            skipColdMemory: true,
            extractMemory: false,
          });
          ledger.recordTurn(result.items, threadId, '', harnessRunId);
          this.syncPlanFromTurn(result.items, ledger, goalTracker, planSync);
          if (await this.handleWorkflowProposal(threadId, result.items, goalTracker, ledger, options?.workflow)) {
            return this.buildResult('blocked', goalTracker, ledger, result, threadId);
          }
          continue;
        }

        // 3b. Storm breaker
        if (stormCheck.triggered) {
          const stormInput = makeStormInput(stormCheck);
          result = await this.agentLoop.runTurn(threadId, stormInput, signal, {
            source: 'harness',
            visibleToUser: false,
            harnessRunId,
            harnessIteration: goalTracker.getState().iteration,
            skipColdMemory: true,
            extractMemory: false,
          });
          ledger.recordTurn(result.items, threadId, '', harnessRunId);
          this.syncPlanFromTurn(result.items, ledger, goalTracker, planSync);
          if (await this.handleWorkflowProposal(threadId, result.items, goalTracker, ledger, options?.workflow)) {
            return this.buildResult('blocked', goalTracker, ledger, result, threadId);
          }
          continue;
        }

        // 3c. Goal evaluation（独立模型）
        const eval_ = await evaluator.evaluate(
          goalTracker.getState().goal,
          goalTracker.getState(),
          result.items,
          ledger.getRecentEvidence(20),
          { signal },
        );

        // 3d. Gap 8: 反向更新 ledger 的 supportsCriteria
        if (eval_.criteriaEvidenceMap) {
          ledger.applyCriteriaMap(eval_.criteriaEvidenceMap);
        }

        // 3e. 记录评估，更新状态
        goalTracker.recordEvaluation(eval_);
        await goalTracker.persist(this.store);
        this.notifyStateChange(threadId, goalTracker, ledger, eval_);

        // 3f. 判定
        if (eval_.satisfied || eval_.status === 'satisfied') {
          goalTracker.markSatisfied();
          await goalTracker.persist(this.store);
          this.notifyStateChange(threadId, goalTracker, ledger, eval_);
          return this.buildResult('satisfied', goalTracker, ledger, result, threadId);
        }
        if (eval_.status === 'needs_user_input' || eval_.status === 'blocked') {
          goalTracker.markBlocked(eval_.blocker ?? eval_.status);
          await goalTracker.persist(this.store);
          this.notifyStateChange(threadId, goalTracker, ledger, eval_);
          return this.buildResult('blocked', goalTracker, ledger, result, threadId);
        }

        // 3g. 无进展检测
        if (goalTracker.checkNoProgress()) {
          goalTracker.markNoProgress();
          await goalTracker.persist(this.store);
          this.notifyStateChange(threadId, goalTracker, ledger, eval_);
          return this.buildResult('no_progress', goalTracker, ledger, result, threadId);
        }

        // 3h. 到达上限
        if (!goalTracker.canContinue()) {
          const status = goalTracker.getState().status;
          await goalTracker.persist(this.store);
          this.notifyStateChange(threadId, goalTracker, ledger, eval_);
          if (status === 'max_continuations') {
            return this.buildResult('max_continuations', goalTracker, ledger, result, threadId);
          }
          return this.buildResult('no_progress', goalTracker, ledger, result, threadId);
        }

        // 3i. 隐藏续跑 — 注意必须传 signal 作为第三参数（Gap 3）
        const slice = await contextMgr.buildIterationContext(threadId, this.config.contextBudget);
        const contextSliceText = renderHarnessContextSlice(slice);
        // P3 §14.4：claimed 步骤连续无进展时向模型下达可操作纠错指令，禁止无限重试。
        const claimProgress = planSync.claimProgress();
        const planSuffix = claimProgress.noProgressCount > 0
          ? `\n[plan] ${claimProgress.noProgressCount} consecutive iterations without claimed-step progress ` +
            `(${claimProgress.staleStepIds.length} claimed step(s) unchanged). ` +
            'Claimed steps only become verified with valid passing evidence; produce evidence or revise the plan.'
          : '';
        const continuationInput = makeContinuationInput(eval_, goalTracker.getState(), contextSliceText, planSuffix + (options?.workflow ? WORKFLOW_CONTINUATION_HINT : ''));

        result = await this.agentLoop.runTurn(
          threadId,
          continuationInput,
          signal,
          {
            source: 'harness',
            visibleToUser: false,
            harnessRunId,
            harnessIteration: goalTracker.getState().iteration,
            skipColdMemory: true,
            extractMemory: false,
          },
        );
        ledger.recordTurn(result.items, threadId, '', harnessRunId);
        this.syncPlanFromTurn(result.items, ledger, goalTracker, planSync);
        if (await this.handleWorkflowProposal(threadId, result.items, goalTracker, ledger, options?.workflow)) {
          return this.buildResult('blocked', goalTracker, ledger, result, threadId);
        }
        this.notifyStateChange(threadId, goalTracker, ledger, eval_);
      }

      // P2 取消链：abort 在循环顶部退出且尚未收敛出 active → 落 cancelled 可追溯终态。
      // 已经因迭代上限 / 无进展收敛的情况仍按原结论返回（不覆盖真实终态）。
      if (signal?.aborted && goalTracker.getState().status === 'active') {
        await this.settleTerminalState(threadId, goalTracker, ledger, { aborted: true, signal });
        return this.buildResult('cancelled', goalTracker, ledger, result, threadId);
      }

      // 4. 到达上限
      const finalStatus = goalTracker.getState().status;
      await goalTracker.persist(this.store);
      this.notifyStateChange(threadId, goalTracker, ledger);
      if (finalStatus === 'max_continuations') {
        return this.buildResult('max_continuations', goalTracker, ledger, result, threadId);
      }
      if (finalStatus === 'no_progress') {
        return this.buildResult('no_progress', goalTracker, ledger, result, threadId);
      }
      return this.buildResult('blocked', goalTracker, ledger, result, threadId);
    } catch (err) {
      // P2 取消链：abort 引发的抛错（runTurn / evaluator）收敛为 cancelled 终态，
      // 调用方拿到可追溯结果而不是未捕获拒绝；非取消异常保持原有抛出语义。
      if (signal?.aborted && goalTracker.getState().status === 'active') {
        await this.settleTerminalState(threadId, goalTracker, ledger, { aborted: true, signal });
        return this.buildResult('cancelled', goalTracker, ledger, result, threadId);
      }
      loopError = err;
      throw err;
    } finally {
      // P2 取消链兜底：循环因 abort / 异常退出且仍处 active 时补写终态并广播汇总。
      await this.settleTerminalState(threadId, goalTracker, ledger, {
        aborted: !!signal?.aborted,
        signal,
        error: loopError,
      });
    }
  }

  /**
   * P2 取消链：把仍处 active 的 harness 循环收口到可追溯终态。
   *   - abort → cancelled（引擎既有语义，GoalTracker.markCancelled）
   *   - 异常 → blocked（附错误摘要）
   * 已处于终态时直接返回：正常 return 路径都已在返回前 persist，不能覆盖真实结论。
   * persist 失败被吞掉 —— finally 里二次抛错会盖掉循环的原始错误。
   * — English: settle an unfinished harness loop to a traceable terminal state.
   */
  private async settleTerminalState(
    threadId: ThreadId,
    goalTracker: GoalTracker,
    ledger: EvidenceLedger,
    reason: { aborted: boolean; signal?: AbortSignal; error?: unknown },
  ): Promise<void> {
    if (goalTracker.getState().status !== 'active') return;
    // P2 生命周期修复：pause 的 suspend 意图不落 cancelled 终态，保持 active + activeHarnessRunId，
    // 让后续 resumeHarness（显式 harnessRunId）可以从同一状态续跑（§21）。
    if (reason.aborted && isSuspendAbort(reason.signal)) {
      await goalTracker.persist(this.store);
      this.notifyStateChange(threadId, goalTracker, ledger);
      return;
    }
    if (reason.aborted) {
      goalTracker.markCancelled();
    } else {
      const message = reason.error instanceof Error
        ? reason.error.message
        : String(reason.error ?? 'harness loop exited without terminal state');
      goalTracker.markBlocked(`harness error: ${message}`);
    }
    try {
      await goalTracker.persist(this.store);
    } catch {
      // swallow：终态持久化失败不再二次抛出
    }
    this.notifyStateChange(threadId, goalTracker, ledger);
  }

  // ─── resume harness run（Gap 5） ─────────────────────────────────────────────

  /**
   * 从已有的 thread.tags 恢复 harness state，并重建 ledger。
   * 如果 state.status !== 'active'，直接返回当前状态。
   * 否则继续 harness loop。
   */
  async resumeHarness(
    threadId: ThreadId,
    options?: { signal?: AbortSignal; workflow?: HarnessWorkflowOptions; harnessRunId?: string },
  ): Promise<HarnessResult> {
    const goalTracker = new GoalTracker(threadId, options?.harnessRunId);
    const state = await goalTracker.load(this.store);
    if (!state) {
      throw new Error('No active harness run found for this thread.');
    }
    if (state.status !== 'active') {
      // 已结束，返回当前状态
      const ledger = new EvidenceLedger();
      await ledger.rebuildFromThreadItems(threadId, this.store, state.harnessRunId);
      return {
        status: state.status as HarnessResult['status'],
        harnessRunId: state.harnessRunId,
        iterations: state.iteration,
        finalEvaluation: state.lastEvaluation,
        evidenceCount: ledger.size(),
        items: [],
        usage: null,
      };
    }

    // 重建 ledger
    const ledger = new EvidenceLedger();
    await ledger.rebuildFromThreadItems(threadId, this.store, state.harnessRunId);
    ledger.setCriteria(state.goal.acceptanceCriteria);
    // P6：续跑同样预载历史 workflow 证据（GoalRun → WorkflowRun → GoalRun 链路）。
    await this.preloadWorkflowEvidence(threadId, ledger, state.harnessRunId, options?.workflow);

    // 重新构造各组件
    const contextMgr = new HarnessContextManager(this.store, ledger, goalTracker);
    const stormBreaker = new StormBreaker({
      threshold: this.config.stormThreshold,
      blockedThreshold: this.config.stormBlockedThreshold,
    });
    const readinessCritic = new ReadinessCritic(ledger, goalTracker);
    const evaluator = new GoalEvaluator(this.model, this.config.evaluatorModelName);
    const harnessRunId = goalTracker.getHarnessRunId();
    // P3：续跑恢复计划先验（completed 保守映射为 claimed，verified 由证据重判）。
    const planSync = new HarnessPlanSync();
    planSync.restorePriorFromHarnessNodes(state.plan);

    // 取最近 items 作为上下文
    const recentItems = await this.store.getRecentItems(threadId, 60);
    let result = { items: recentItems, usage: null as import('@suanlizi/protocol').Usage | null };

    // 继续 harness loop
    // P2 取消链：与 runHarness 同构 —— 循环整体包 try/catch/finally，
    // abort / 异常退出时仍把 GoalTracker 终态与 ledger 汇总落盘一次。
    const signal = options?.signal;
    let loopError: unknown;
    try {
      while (goalTracker.canContinue()) {
        // P2 取消链：signal abort 后立刻退出续跑循环
        if (signal?.aborted) break;

        const stormCheck = stormBreaker.check(result.items);
        const readiness = readinessCritic.check(result.items, stormCheck);
        if (!readiness.passed) {
          const eval_ = readinessEvaluation(readiness, goalTracker.getState());
          goalTracker.recordEvaluation(eval_);
          await goalTracker.persist(this.store);
          this.notifyStateChange(threadId, goalTracker, ledger, eval_);
          if (goalTracker.checkNoProgress()) {
            goalTracker.markNoProgress();
            await goalTracker.persist(this.store);
            this.notifyStateChange(threadId, goalTracker, ledger, eval_);
            return this.buildResult('no_progress', goalTracker, ledger, result, threadId);
          }
          if (!goalTracker.canContinue()) {
            await goalTracker.persist(this.store);
            const status = goalTracker.getState().status;
            this.notifyStateChange(threadId, goalTracker, ledger, eval_);
            if (status === 'max_continuations') {
              return this.buildResult('max_continuations', goalTracker, ledger, result, threadId);
            }
            return this.buildResult('no_progress', goalTracker, ledger, result, threadId);
          }
          const retryInput = makeRetryInput(readiness.retryInstruction ?? 'readiness gate failed');
          result = await this.agentLoop.runTurn(threadId, retryInput, options?.signal, {
            source: 'harness',
            visibleToUser: false,
            harnessRunId,
            harnessIteration: goalTracker.getState().iteration,
            skipColdMemory: true,
            extractMemory: false,
          });
          ledger.recordTurn(result.items, threadId, '', harnessRunId);
          this.syncPlanFromTurn(result.items, ledger, goalTracker, planSync);
          if (await this.handleWorkflowProposal(threadId, result.items, goalTracker, ledger, options?.workflow)) {
            return this.buildResult('blocked', goalTracker, ledger, result, threadId);
          }
          continue;
        }

        if (stormCheck.triggered) {
          const stormInput = makeStormInput(stormCheck);
          result = await this.agentLoop.runTurn(threadId, stormInput, options?.signal, {
            source: 'harness',
            visibleToUser: false,
            harnessRunId,
            harnessIteration: goalTracker.getState().iteration,
            skipColdMemory: true,
            extractMemory: false,
          });
          ledger.recordTurn(result.items, threadId, '', harnessRunId);
          this.syncPlanFromTurn(result.items, ledger, goalTracker, planSync);
          if (await this.handleWorkflowProposal(threadId, result.items, goalTracker, ledger, options?.workflow)) {
            return this.buildResult('blocked', goalTracker, ledger, result, threadId);
          }
          continue;
        }

        const eval_ = await evaluator.evaluate(
          goalTracker.getState().goal,
          goalTracker.getState(),
          result.items,
          ledger.getRecentEvidence(20),
          { signal: options?.signal },
        );
        if (eval_.criteriaEvidenceMap) {
          ledger.applyCriteriaMap(eval_.criteriaEvidenceMap);
        }
        goalTracker.recordEvaluation(eval_);
        await goalTracker.persist(this.store);

        if (eval_.satisfied || eval_.status === 'satisfied') {
          goalTracker.markSatisfied();
          await goalTracker.persist(this.store);
          return this.buildResult('satisfied', goalTracker, ledger, result, threadId);
        }
        if (eval_.status === 'needs_user_input' || eval_.status === 'blocked') {
          goalTracker.markBlocked(eval_.blocker ?? eval_.status);
          await goalTracker.persist(this.store);
          return this.buildResult('blocked', goalTracker, ledger, result, threadId);
        }
        if (goalTracker.checkNoProgress()) {
          goalTracker.markNoProgress();
          await goalTracker.persist(this.store);
          return this.buildResult('no_progress', goalTracker, ledger, result, threadId);
        }
        if (!goalTracker.canContinue()) {
          await goalTracker.persist(this.store);
          const status = goalTracker.getState().status;
          if (status === 'max_continuations') {
            return this.buildResult('max_continuations', goalTracker, ledger, result, threadId);
          }
          return this.buildResult('no_progress', goalTracker, ledger, result, threadId);
        }

        const slice = await contextMgr.buildIterationContext(threadId, this.config.contextBudget);
        const contextSliceText = renderHarnessContextSlice(slice);
        // P3 §14.4：claimed 无进展纠错（与 runHarness 同构）。
        const claimProgress = planSync.claimProgress();
        const planSuffix = claimProgress.noProgressCount > 0
          ? `\n[plan] ${claimProgress.noProgressCount} consecutive iterations without claimed-step progress ` +
            `(${claimProgress.staleStepIds.length} claimed step(s) unchanged). ` +
            'Claimed steps only become verified with valid passing evidence; produce evidence or revise the plan.'
          : '';
        const continuationInput = makeContinuationInput(eval_, goalTracker.getState(), contextSliceText, planSuffix + (options?.workflow ? WORKFLOW_CONTINUATION_HINT : ''));
        result = await this.agentLoop.runTurn(
          threadId,
          continuationInput,
          options?.signal,
          {
            source: 'harness',
            visibleToUser: false,
            harnessRunId,
            harnessIteration: goalTracker.getState().iteration,
            skipColdMemory: true,
            extractMemory: false,
          },
        );
        ledger.recordTurn(result.items, threadId, '', harnessRunId);
        this.syncPlanFromTurn(result.items, ledger, goalTracker, planSync);
        if (await this.handleWorkflowProposal(threadId, result.items, goalTracker, ledger, options?.workflow)) {
          return this.buildResult('blocked', goalTracker, ledger, result, threadId);
        }
      }

      // P2 取消链：resume 续跑被 abort → cancelled 可追溯终态（不留 active 孤儿）
      if (signal?.aborted && goalTracker.getState().status === 'active') {
        await this.settleTerminalState(threadId, goalTracker, ledger, { aborted: true, signal });
        return this.buildResult('cancelled', goalTracker, ledger, result, threadId);
      }

      await goalTracker.persist(this.store);
      const finalStatus = goalTracker.getState().status;
      if (finalStatus === 'max_continuations') {
        return this.buildResult('max_continuations', goalTracker, ledger, result, threadId);
      }
      return this.buildResult('no_progress', goalTracker, ledger, result, threadId);
    } catch (err) {
      // P2 取消链：abort 引发的抛错收敛为 cancelled，不留未捕获拒绝
      if (signal?.aborted && goalTracker.getState().status === 'active') {
        await this.settleTerminalState(threadId, goalTracker, ledger, { aborted: true, signal });
        return this.buildResult('cancelled', goalTracker, ledger, result, threadId);
      }
      loopError = err;
      throw err;
    } finally {
      await this.settleTerminalState(threadId, goalTracker, ledger, {
        aborted: !!signal?.aborted,
        signal,
          error: loopError,
      });
    }
  }

  // ─── P6：Goal × Workflow 组合接线 ──────────────────────────────────────────

  /**
   * 预载历史 workflow 证据：把 API 层投影出的 wev_ seeds 物化进 ledger，
   * GoalEvaluator 通过 getRecentEvidence / criteriaEvidenceMap 只读 Evidence 消费（§12）。
   * 预载失败不阻塞目标推进：证据读取问题不应直接崩掉 GoalRun。
   */
  private async preloadWorkflowEvidence(
    threadId: ThreadId,
    ledger: EvidenceLedger,
    harnessRunId: string,
    workflow?: HarnessWorkflowOptions,
  ): Promise<void> {
    if (!workflow?.evidenceProvider) return;
    try {
      const seeds = await workflow.evidenceProvider(threadId);
      if (seeds.length > 0) {
        ledger.rebuildFromWorkflowResults(seeds.map((seed) => ({ ...seed, harnessRunId })));
      }
    } catch {
      // swallow：预载失败保持 ledger 仅含 thread item 证据。
    }
  }

  /**
   * 检查本轮输出中的 workflow 提案（P6 §12.1）。
   * 命中合法提案 → 调 onRequest 落批准请求，GoalRun 收口为 blocked（等待用户批准）；
   * 提案非法 / onRequest 抛错（预算拒绝等）→ 同样收口为 blocked + blocker（fail-closed）。
   * 返回 true 表示 harness 循环应立即返回 blocked 结果。
   */
  private async handleWorkflowProposal(
    threadId: ThreadId,
    items: ThreadItem[],
    goalTracker: GoalTracker,
    ledger: EvidenceLedger,
    workflow: HarnessWorkflowOptions | undefined,
  ): Promise<boolean> {
    if (!workflow) return false;
    const extraction = extractWorkflowProposal(items, { taskId: workflow.taskId, goalRunId: workflow.goalRunId });
    if (!extraction.request && !extraction.error) return false;
    if (extraction.request) {
      try {
        await workflow.onRequest(extraction.request);
      } catch (error) {
        goalTracker.markBlocked(`workflow request rejected: ${error instanceof Error ? error.message : String(error)}`);
        await goalTracker.persist(this.store).catch(() => {});
        this.notifyStateChange(threadId, goalTracker, ledger);
        return true;
      }
    }
    goalTracker.markBlocked(
      extraction.request
        ? `workflow request pending approval: ${extraction.request.objective}`
        : `workflow proposal rejected: ${extraction.error}`,
    );
    await goalTracker.persist(this.store).catch(() => {});
    this.notifyStateChange(threadId, goalTracker, ledger);
    return true;
  }

  // ─── 结果构造 ──────────────────────────────────────────────────────────────

  /**
   * P3 计划投影接线：从本轮 turn 输出提取模型计划（```plan 代码块），首版直通投影，
   * 后续版本过 ReplanGate；投影成功后回写 GoalTracker 并持久化。投影被拒/被冷却拒绝时
   * 保留上一版计划（fail-closed），不中断 harness 循环。
   */
  private syncPlanFromTurn(
    items: ThreadItem[],
    ledger: EvidenceLedger,
    goalTracker: GoalTracker,
    planSync: HarnessPlanSync,
  ): void {
    const extraction = extractPlanFromItems(items);
    if (!extraction) return;
    if (extraction.error) {
      // 模型计划块非法：fail-closed 保留旧计划；把拒绝原因注入 blocker 供续跑纠错。
      const state = goalTracker.getState();
      if (state.lastEvaluation && !state.lastEvaluation.blocker) {
        state.lastEvaluation.blocker = `plan rejected: ${extraction.error}`;
      }
      return;
    }
    const outcome = planSync.applyModelPlan(extraction.nodes, {
      validEvidenceIds: validEvidenceIdsFromReceipts(ledger.getRecentEvidence(200)),
      nowMs: Date.now(),
      noProgressCount: goalTracker.getState().noProgressCount,
    });
    if (outcome.applied) {
      goalTracker.updatePlan(toHarnessNodes(outcome.plan));
    }
  }

  private async buildResult(
    status: HarnessResult['status'],
    goalTracker: GoalTracker,
    ledger: EvidenceLedger,
    lastResult: { items: ThreadItem[]; usage: import('@suanlizi/protocol').Usage | null },
    threadId: ThreadId,
  ): Promise<HarnessResult> {
    const state = goalTracker.getState();
    const result: HarnessResult = {
      status,
      harnessRunId: goalTracker.getHarnessRunId(),
      iterations: state.iteration,
      finalEvaluation: state.lastEvaluation,
      evidenceCount: ledger.size(),
      items: lastResult.items,
      usage: lastResult.usage,
    };

    this.recordExperience(status, state, ledger, threadId).catch(() => {});
    return result;
  }

  private async recordExperience(
    status: HarnessResult['status'],
    state: ReturnType<GoalTracker['getState']>,
    ledger: EvidenceLedger,
    threadId: ThreadId,
  ): Promise<void> {
    if (!this.experienceEngine) return;

    try {
      if (status === 'satisfied') {
        const passed = state.lastEvaluation?.passedCriteria ?? [];
        await this.experienceEngine.recordSuccess({
          toolNames: ['harness_loop'],
          taskSummary: state.goal.objective,
          steps: ['plan', 'execute', 'evaluate', 'verify'],
          threadId,
          attempts: state.iteration,
          reasoning: passed.length > 0 ? `Satisfied with ${passed.length} criteria passed` : undefined,
        });
      } else {
        const recent = ledger.getRecentEvidence(10);
        const blockerPhrases = recent
          .filter((r) => r.status === 'failed' || r.kind === 'error')
          .map((r) => r.summary)
          .slice(0, 3);
        await this.experienceEngine.recordFailure({
          errorMessage: status === 'blocked'
            ? (blockerPhrases.join('; ') || 'Blocker detected with no actionable evidence')
            : `Failed after ${state.iteration} iterations with status ${status}`,
          symptoms: blockerPhrases.length > 0 ? blockerPhrases : [status],
          resolutionSteps: [],
          threadId,
          iterations: state.iteration,
        });
      }
    } catch {
    }
  }
}
