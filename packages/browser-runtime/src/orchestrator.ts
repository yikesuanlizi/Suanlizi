// 浏览器任务编排器：把 Phase 0/1 已交付的件串成完整闭环的复用组件
// （架构文档 §7 决策与执行循环：策略→预算→账本 prepare→执行→验证→
//  commit/uncertain/failed→TaskEvent+Trace→继续/挂起/结束）。
// — English: browser task orchestrator — a reusable component wiring the
//   delivered Phase 0/1 pieces into one closed loop (architecture §7 decision
//   & execution cycle: policy → budget → ledger prepare → execute → verify →
//   commit/uncertain/failed → TaskEvent+Trace → continue/pause/finish).
// 本包只依赖 @suanlizi/protocol 与本包内部件；不持有任何 UI/桌面端逻辑，
// 审批确认通过注入的 resolveApproval 回调交给宿主（Phase 1 桌面端）。
// — English: depends only on @suanlizi/protocol and this package's own pieces;
//   approval confirmation is delegated to the host via resolveApproval.
// 错误恢复策略（架构文档 §9.4）：transient 有上限退避重试、element 重新观测、
// policy 不重试、side_effect/uncertain 对账不能盲目重试——runAction 在
// failed/uncertain 时给出 recovery 建议；runActionWithRetry 实现带安全重试的
// 执行（§7 决策循环的「重规划/重试」出口）。
// — English: error recovery policy (architecture §9.4): transient retries with
//   capped backoff, element re-observes, policy never retries, side_effect /
//   uncertain must reconcile before retrying — runAction attaches a recovery
//   suggestion on failed/uncertain; runActionWithRetry executes with safe
//   retries (the §7 replan/retry exit of the decision loop).
import type {
  ActionIntent,
  ActionRecord,
  ApprovalRequest,
  BrowserTaskEvent,
  BrowserTaskState,
  HumanRequest,
  Observation,
} from '@suanlizi/protocol';
import { evaluateDownload, type DownloadSpec } from './download.js';
import type { BrowserPolicyEngine } from './policy.js';
import type { BrowserTaskMachine } from './taskMachine.js';
import { BudgetExceededError } from './taskMachine.js';
import type { BrowserTraceRecorder } from './trace.js';
import { decideRecovery, shouldRetryUncertain, type RecoveryAction } from './recovery.js';
import type { ActionResult, BrowserRuntimePort, BrowserSessionHandle } from './port.js';
import type { ProgressEntry, ProgressSource } from './progress.js';
import { projectProgress } from './progress.js';

// 任务终态集合（与 taskMachine 内部集合一致）：机器已终态时事件流冻结，
// 编排器对后续落账优雅降级（跳过），预算错误仍然上抛。
// — English: terminal task statuses (mirrors taskMachine's set) — once the
//   machine is terminal its event stream is frozen; ledger writes degrade
//   gracefully, while budget errors still propagate.
const TERMINAL_STATUSES: ReadonlySet<BrowserTaskState['status']> = new Set(['completed', 'cancelled', 'failed']);

// 可取消延时：signal 中止时 reject（runActionWithRetry 的重试退避等待用）。
// — English: cancellable delay — rejects when the signal aborts (used for the
//   retry backoff wait in runActionWithRetry).
function cancellableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('aborted'));
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      reject(new Error('aborted'));
    };
    timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

// 编排器依赖注入：全部为已交付件，编排器只负责串联与收尾。
// — English: orchestrator dependencies — all delivered pieces; the orchestrator wires them.
export interface OrchestratorDeps {
  runtime: BrowserRuntimePort;
  policyEngine: BrowserPolicyEngine;
  machine: BrowserTaskMachine;
  trace?: BrowserTraceRecorder; // 可选
  // 进度投影回调（用 projectProgress 逐条投影动作相关事件）
  // — English: progress projection callback (projectProgress per entry)
  onProgress?: (entry: ProgressEntry) => void;
  // 每个动作后回调（事件快照 + 状态快照）
  // — English: called after every action with event/state snapshots
  onCheckpoint?: (ck: { events: BrowserTaskEvent[]; state: BrowserTaskState }) => void;
  // confirm 时先通知（UI 展示）
  // — English: notified first on confirm (for UI presentation)
  onApprovalRequest?: (request: ApprovalRequest) => void;
  // Phase 1 桌面端注入 UI 确认；缺省 = 始终拒绝
  // — English: injected by the Phase 1 desktop for UI confirmation; default = always deny
  resolveApproval?: (request: ApprovalRequest) => Promise<boolean>;
}

// 恢复建议：失败/uncertain 动作给调用方的下一步指引（架构文档 §9.4 恢复矩阵）。
// — English: recovery suggestion — next-step guidance for a failed or uncertain
//   action (architecture §9.4 recovery matrix).
export interface RecoverySuggestion {
  action: RecoveryAction; // retry | reobserve | replan | reconcile | abort
  delayMs?: number; // retry 前的退避延迟（毫秒）
  reason: string;
  retryable: boolean;
}

// 动作结果（调用方可读）：三态 outcome + 运行时结果 + 策略决策
// — English: action result — three-state outcome + runtime result + policy decision.
export interface OrchestratorActionResult {
  outcome: 'committed' | 'uncertain' | 'failed';
  result: ActionResult;
  decision: 'allowed' | 'confirmed' | 'denied';
  approvalRequest?: ApprovalRequest; // decision='confirmed' 时记录
  // 失败/uncertain 时的恢复建议（调用方可据此重试/重规划/对账/中止）
  // — English: recovery suggestion on failed/uncertain (retry/replan/reconcile/abort).
  recovery?: RecoverySuggestion;
}

export class BrowserTaskOrchestrator {
  readonly #deps: OrchestratorDeps;
  readonly #machine: BrowserTaskMachine;
  readonly #policyEngine: BrowserPolicyEngine;
  readonly #runtime: BrowserRuntimePort;
  readonly #trace: BrowserTraceRecorder | undefined;
  #session: BrowserSessionHandle | undefined;
  #lastObservation: Observation | undefined;
  #actionSeq = 0;
  #closed = false;
  // 待处理的人工接管请求（requestHuman 记录、resolveHuman 校验并清除）；
  // 同一时刻至多一个 pending human request。
  // — English: the in-flight human takeover request (set by requestHuman,
  //   validated and cleared by resolveHuman); at most one pending at a time.
  #pendingHumanRequestId: string | undefined = undefined;
  // 按 actionId 的尝试计数：committed 清零、failed/uncertain 递增
  // （decideRecovery 的退避/上限依据）。
  // — English: per-actionId attempt counter — reset on committed, incremented
  //   on failed/uncertain (backoff/cap input to decideRecovery).
  #actionAttempts = new Map<string, number>();

  constructor(deps: OrchestratorDeps) {
    this.#deps = deps;
    this.#runtime = deps.runtime;
    this.#policyEngine = deps.policyEngine;
    this.#machine = deps.machine;
    this.#trace = deps.trace;
  }

  // 当前任务状态快照（转发机器状态）。
  // — English: current task state snapshot (forwards the machine state).
  state(): BrowserTaskState {
    return this.#machine.state;
  }

  // 启动：machine.start + runtime.start + 首次 observe 并 acceptObservation。
  // — English: start — machine.start + runtime.start + first observe/acceptObservation.
  async start(input?: { signal?: AbortSignal }): Promise<Observation> {
    const signal = input?.signal;
    this.#machine.start();
    // task.created 进度投影（createdAt 与机器事件保持一致）
    // — English: project task.created with the machine event's timestamp
    const created = [...this.#machine.events]
      .reverse()
      .find((e): e is Extract<BrowserTaskEvent, { type: 'task.created' }> => e.type === 'task.created');
    this.#emitProgress([{ type: 'task.created', createdAt: created?.createdAt ?? new Date().toISOString() }]);
    this.#session = await this.#runtime.start({ taskId: this.#machine.state.taskId, signal });
    const obs = await this.#session.observe({ signal });
    this.#acceptObservation(obs);
    return obs;
  }

  // 观测：session.observe + machine.acceptObservation + trace.observed。
  // — English: observe — session.observe + machine.acceptObservation + trace.observed.
  async observe(input?: { signal?: AbortSignal }): Promise<Observation> {
    const obs = await this.#requireSession().observe({ signal: input?.signal });
    this.#acceptObservation(obs);
    return obs;
  }

  // 导航：runAction 特例——构造 navigate intent（effect 'none'、risk 'low'、
  // postcondition url_contains url）后走同一管道；返回新观测。
  // — English: navigate — a runAction special case: builds a navigate intent
  //   (effect 'none', risk 'low', postcondition url_contains url) that goes
  //   through the same pipeline; returns the new observation.
  async navigate(input: { url: string; signal?: AbortSignal }): Promise<Observation> {
    const last = this.#lastObservation;
    if (last === undefined) {
      throw new Error('orchestrator not started: call start() first');
    }
    const intent: ActionIntent = {
      actionId: `nav-${++this.#actionSeq}`,
      taskId: this.#machine.state.taskId,
      pageId: last.pageId,
      observationId: last.observationId,
      expectedNavigationEpoch: last.navigationEpoch,
      kind: 'navigate',
      arguments: { url: input.url },
      rationale: `导航到 ${input.url}`,
      effect: 'none',
      risk: 'low',
      postcondition: { kind: 'url_contains', value: input.url },
    };
    // 失败/被拒时页面不变，仍返回最新观测，由调用方结合事件流判断。
    // — English: on failure/denial the page is unchanged; the latest
    //   observation is still returned and the caller reads the event stream.
    await this.runAction({ intent, signal: input.signal });
    return this.observe({ signal: input.signal });
  }

  // 地址栏属于用户明确输入，不是 Agent 根据网页内容或模型输出生成的动作。
  // 它只允许 http/https，并保持与 Agent 导航分离：后者必须继续经过策略与审批。
  async navigateFromUser(input: { url: string; signal?: AbortSignal }): Promise<Observation> {
    let target: URL;
    try {
      target = new URL(input.url);
    } catch {
      throw { code: 'USER_NAVIGATION_URL_BLOCKED', message: '地址无效', retryable: false };
    }
    if (target.protocol !== 'http:' && target.protocol !== 'https:') {
      throw { code: 'USER_NAVIGATION_URL_BLOCKED', message: '地址栏仅支持 http 或 https 地址', retryable: false };
    }
    const observation = await this.#requireSession().navigate({ url: target.toString(), signal: input.signal });
    this.#acceptObservation(observation);
    return observation;
  }

  // 动作管道（严格按序，见文件头注释的 §7 循环）。
  // — English: the action pipeline (strict order, see §7 loop in the header).
  async runAction(input: { intent: ActionIntent; signal?: AbortSignal }): Promise<OrchestratorActionResult> {
    const { intent, signal } = input;
    const session = this.#requireSession();
    const machine = this.#machine;
    const trace = this.#trace;

    // 0) 终态守卫：任务已取消/完成/失败后不接受新动作（返回 failed 而非抛异常）。
    // — English: terminal guard — no new actions after cancellation/completion/failure.
    const status = machine.state.status;
    if (status === 'cancelled' || status === 'completed' || status === 'failed') {
      const result: ActionResult = {
        status: 'failed',
        error: {
          kind: 'cancelled',
          code: 'ABORTED',
          message: `任务已处于终态（${status}）`,
          retryable: false,
          actionId: intent.actionId,
        },
      };
      trace?.actionFinished({ actionId: intent.actionId, outcome: 'failed', errorCode: result.error.code, actionKind: intent.kind });
      const terminalRecovery = this.#recoveryFor(result, intent);
      return {
        outcome: 'failed',
        result,
        decision: 'denied',
        ...(terminalRecovery !== undefined ? { recovery: terminalRecovery } : {}),
      };
    }

    // 1) 前置：预算预留（超限抛 BudgetExceededError，调用方捕获后应中止任务）。
    // — English: reserve the step budget first (over-budget throws BudgetExceededError).
    machine.reserve({ steps: 1 });

    // 2) 策略：deny 直接失败；confirm 征求批准（缺省拒绝）；allow 放行。
    // — English: policy gate — deny fails fast, confirm asks for approval, allow proceeds.
    const pageUrl = this.#lastObservation?.url;
    const decision = await this.#policyEngine.evaluate(intent, pageUrl !== undefined ? { pageUrl } : undefined);

    let decisionKind: 'allowed' | 'confirmed' | 'denied' = 'allowed';
    let approvalRequest: ApprovalRequest | undefined;

    if (decision.kind === 'deny') {
      trace?.policy({
        actionId: intent.actionId,
        actionKind: intent.kind,
        outcome: 'denied',
        risk: intent.risk,
        effect: intent.effect,
        reason: decision.reason,
      });
      const result = this.#policyFailure(intent, decision.reason);
      this.#applyGuard(() => machine.completeAction({ actionId: intent.actionId, outcome: 'failed', evidenceRefs: [] }));
      this.#finishRunAction(intent, result);
      const denyRecovery = this.#recoveryFor(result, intent);
      return {
        outcome: 'failed',
        result,
        decision: 'denied',
        ...(denyRecovery !== undefined ? { recovery: denyRecovery } : {}),
      };
    }

    if (decision.kind === 'confirm') {
      approvalRequest = decision.approvalRequest;
      this.#deps.onApprovalRequest?.(approvalRequest);
      const approved = (await this.#deps.resolveApproval?.(approvalRequest)) ?? false;
      if (!approved) {
        const reason = approvalRequest.justification ?? decision.reason;
        trace?.policy({
          actionId: intent.actionId,
          actionKind: intent.kind,
          outcome: 'denied',
          risk: intent.risk,
          effect: intent.effect,
          reason,
        });
        const result = this.#policyFailure(intent, reason);
        this.#applyGuard(() => machine.completeAction({ actionId: intent.actionId, outcome: 'failed', evidenceRefs: [] }));
        this.#finishRunAction(intent, result);
        const deniedRecovery = this.#recoveryFor(result, intent);
        return {
          outcome: 'failed',
          result,
          decision: 'denied',
          ...(deniedRecovery !== undefined ? { recovery: deniedRecovery } : {}),
        };
      }
      decisionKind = 'confirmed';
      // 批准后按放行记录（trace.policy 的 outcome 只接受 allowed/confirm/denied）。
      // — English: an approved confirm is recorded as allowed.
      trace?.policy({
        actionId: intent.actionId,
        actionKind: intent.kind,
        outcome: 'allowed',
        risk: intent.risk,
        effect: intent.effect,
        reason: '已批准',
      });
    } else {
      trace?.policy({
        actionId: intent.actionId,
        actionKind: intent.kind,
        outcome: 'allowed',
        risk: intent.risk,
        effect: intent.effect,
      });
    }

    // 2b) 下载预检（架构文档 11.2 + Phase 2『下载可追踪、可取消、可限制』的纯函数部分）：
    // 策略放行后、账本 prepare 前，download 意图经 evaluateDownload 裁决——检查
    // 同源、扩展名/MIME 白名单与大小上限（上限联动任务预算 maxDownloadBytes）。
    // 拒绝 → 不执行：直接落账 failed + trace.actionFinished（errorCode 为下载策略
    // 稳定错误码），返回 failed 且不附 recovery（下载策略拒绝不重试）；放行 → 继续原管道。
    // — English: download preflight (architecture §11.2 + Phase 2 "downloads
    //   trackable, cancellable, rate-limited" pure-function part) — after policy
    //   allows, before the ledger prepares, download intents go through
    //   evaluateDownload: same-origin, extension/MIME whitelists, and the size
    //   cap (tied to the task budget maxDownloadBytes). Deny → no execution:
    //   settle failed + trace.actionFinished (download-policy error code) and
    //   return failed without a recovery suggestion (download-policy denials are
    //   never retried); allow → the original pipeline continues.
    if (intent.kind === 'download') {
      const spec: DownloadSpec = {
        url: String(intent.arguments.url ?? ''),
        suggestedName: String(intent.arguments.suggestedName ?? 'download.bin'),
        mimeType: typeof intent.arguments.mimeType === 'string' ? intent.arguments.mimeType : undefined,
        sizeBytes: typeof intent.arguments.sizeBytes === 'number' ? intent.arguments.sizeBytes : undefined,
        sourceOrigin: this.#sourceOriginOf(pageUrl),
      };
      const verdict = evaluateDownload(spec, { maxBytes: machine.state.budget.maxDownloadBytes });
      if (verdict.kind === 'deny') {
        this.#applyGuard(() => machine.completeAction({ actionId: intent.actionId, outcome: 'failed', evidenceRefs: [] }));
        trace?.actionFinished({
          actionId: intent.actionId,
          actionKind: intent.kind,
          outcome: 'failed',
          errorCode: verdict.code,
        });
        const result: ActionResult = {
          status: 'failed',
          error: {
            kind: 'policy',
            code: verdict.code,
            message: verdict.reason,
            retryable: false,
            actionId: intent.actionId,
          },
        };
        this.#finishRunAction(intent, result);
        return {
          outcome: 'failed',
          result,
          decision: decisionKind,
          ...(decisionKind === 'confirmed' ? { approvalRequest } : {}),
        };
      }
    }

    // 3) 账本：执行前先记录意图（副作用账本，崩溃恢复的依据）。
    // — English: ledger — record the intent before executing (crash-recovery basis).
    const record = this.#buildLedgerRecord(intent);
    this.#applyGuard(() => machine.prepareAction(record));

    // 4) Trace：动作开始（execute 阶段）。
    // — English: trace the action start (execute phase).
    trace?.actionStarted({ actionId: intent.actionId, actionKind: intent.kind, risk: intent.risk, effect: intent.effect });

    // 5) 执行：运行时执行动作并验证后置条件；异常转 failed。
    // — English: execute via the runtime session; exceptions become failed.
    let result: ActionResult;
    try {
      result = await session.act({ intent, signal });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      result = {
        status: 'failed',
        error: { kind: 'transient', code: 'ORCHESTRATION', message, retryable: true, actionId: intent.actionId },
      };
    }

    // 5b) 恢复建议：必须在尝试计数递增（第 6 步）之前基于本次尝试前的计数计算，
    // 否则首次失败会被当作第 2 次尝试（退避/上限 off-by-one）。
    // — English: the recovery suggestion must be computed from the pre-increment
    //   attempt count (before step 6), otherwise the first failure would be
    //   mistaken for attempt #2 (backoff/cap off-by-one).
    const recovery = this.#recoveryFor(result, intent);

    // 6) 落账 + Trace 验证阶段 + 尝试计数维护（committed 清零 / failed、uncertain 递增，
    // 在 completeAction 后执行，作为 decideRecovery 的退避与上限依据）。
    // — English: settle the ledger, trace the verify phase, and maintain the
    //   attempt counter (reset on committed / increment on failed, uncertain —
    //   after completeAction; backoff & cap input to decideRecovery).
    switch (result.status) {
      case 'committed':
        this.#applyGuard(() =>
          machine.completeAction({
            actionId: intent.actionId,
            outcome: 'committed',
            evidenceRefs: result.evidence.checks?.map((c) => c.postcondition) ?? [],
          }),
        );
        trace?.actionFinished({ actionId: intent.actionId, actionKind: intent.kind, outcome: 'committed', verificationPassed: true });
        this.#actionAttempts.set(intent.actionId, 0);
        break;
      case 'uncertain':
        this.#applyGuard(() => machine.completeAction({ actionId: intent.actionId, outcome: 'uncertain', evidenceRefs: [] }));
        trace?.actionFinished({ actionId: intent.actionId, actionKind: intent.kind, outcome: 'uncertain', verificationPassed: false });
        this.#actionAttempts.set(intent.actionId, (this.#actionAttempts.get(intent.actionId) ?? 0) + 1);
        break;
      case 'failed':
        this.#applyGuard(() => machine.completeAction({ actionId: intent.actionId, outcome: 'failed', evidenceRefs: [] }));
        trace?.actionFinished({ actionId: intent.actionId, actionKind: intent.kind, outcome: 'failed', errorCode: result.error.code });
        this.#actionAttempts.set(intent.actionId, (this.#actionAttempts.get(intent.actionId) ?? 0) + 1);
        break;
    }

    // 7) 副作用账本预算：外部写动作 committed 后记账（externalWrites/downloadBytes 计入
    // 任务预算并随 checkpoint 持久化——仅靠 policyEngine 进程内计数会在崩溃恢复后归零）。
    // — English: external-write budget — committed external writes/downloads are
    //   metered into the task budget and persist via checkpoints (process-local
    //   counters in the policy engine reset after a crash restore).
    if (result.status === 'committed') {
      if (intent.effect === 'external_reversible' || intent.effect === 'external_irreversible') {
        this.#applyGuard(() => machine.reserve({ externalWrites: 1 }));
        this.#policyEngine.noteExternalWrite(intent);
      }
      if (intent.kind === 'download') {
        const sizeBytes = typeof intent.arguments.sizeBytes === 'number' ? intent.arguments.sizeBytes : 0;
        this.#applyGuard(() => machine.reserve({ downloadBytes: sizeBytes }));
      }
    }

    // 8) 收尾：检查点 + 用户进度投影。
    // — English: wrap up — checkpoint + user progress projection.
    this.#finishRunAction(intent, result);

    // 9) 返回（失败/uncertain 附带恢复建议；recovery 已在第 5b 步计算）。
    // — English: return (with the recovery suggestion computed in step 5b).
    return {
      outcome: result.status,
      result,
      decision: decisionKind,
      ...(decisionKind === 'confirmed' ? { approvalRequest } : {}),
      ...(recovery !== undefined ? { recovery } : {}),
    };
  }

  // 带安全重试的动作执行（架构文档 §9.4 恢复矩阵 + §7 决策循环的「重规划/重试」出口）：
  // - 仅 recovery.action='retry' 且 retryable 时自动重试（transient/llm），
  //   重试前等待 recovery.delayMs（可中断：setTimeout + signal 监听）。
  // - 'reobserve'（element 类）不自动重试——调用方重新观测后再次调用
  //   runAction（编排器不自动观测）；recovery 建议原样返回。
  // - 'reconcile'/'abort'/'replan' 绝不自动重试，原样返回。
  // - 外部副作用（external_reversible/external_irreversible）的 failed/uncertain
  //   永不自动重试（shouldRetryUncertain 语义；即使 recovery 说 retry）。
  // - 重试达到上限（maxRetries=3）仍失败：返回最后一次结果，
  //   recovery.action 改为 'replan'。
  // — English: action execution with safe retries (architecture §9.4 recovery
  //   matrix + §7 replan/retry exit): only recovery.action='retry' && retryable
  //   auto-retries (transient/llm) after an interruptible delayMs wait;
  //   'reobserve' (element class) is NOT auto-retried — the caller re-observes
  //   and calls runAction again (no auto-observation here); 'reconcile'/'abort'/
  //   'replan' never auto-retry and pass through unchanged; external_* side
  //   effects never auto-retry on failed/uncertain (shouldRetryUncertain
  //   semantics, even when recovery says retry); when the retry cap
  //   (maxRetries=3) is reached the last result is returned with
  //   recovery.action='replan'.
  async runActionWithRetry(input: { intent: ActionIntent; signal?: AbortSignal }): Promise<OrchestratorActionResult> {
    const { intent, signal } = input;
    const maxRetries = 3;
    let retries = 0;
    for (;;) {
      // 每次尝试由 runAction 自身维护尝试计数（#actionAttempts）。
      // — English: each attempt is counted inside runAction (#actionAttempts).
      const result = await this.runAction({ intent, signal });
      if (result.outcome === 'committed') return result;
      // 外部副作用失败/结果不明：永不自动重试（shouldRetryUncertain 语义）。
      // — English: external side effects — never auto-retry, even if the
      //   recovery suggestion says retry.
      if (intent.effect === 'external_reversible' || intent.effect === 'external_irreversible') {
        return result;
      }
      const recovery = result.recovery;
      if (recovery === undefined || recovery.action !== 'retry' || !recovery.retryable) {
        return result;
      }
      if (retries >= maxRetries) {
        // 重试上限：返回最后一次结果并把 recovery 改为 replan。
        // — English: retry cap reached — surface the last result as replan.
        return { ...result, recovery: { action: 'replan', reason: '重试次数已达上限，重新规划', retryable: false } };
      }
      retries += 1;
      await cancellableSleep(recovery.delayMs ?? 0, signal);
    }
  }

  // 发起人工接管请求（架构文档 §6.1 WaitState / §10.3 HumanRequest）：CAPTCHA/
  // 认证/输入/确认等不在策略引擎内的接管场景（CAPTCHA 默认路径为人工接管，
  // 不自动规避）。machine 进入 waiting（wait.kind='human'）。
  // 与 runAction 的 confirm 路径互不干扰：confirm 走注入的 resolveApproval 回调
  // （策略引擎内确认）；requestHuman/resolveHuman 是独立的显式等待协议。
  // 简化：不记录 trace span，仅通过 onProgress 投影 human.requested 条目
  // （tone warn，文本含 request.prompt）。
  // — English: issue a human takeover request (architecture §6.1 WaitState /
  //   §10.3 HumanRequest) for CAPTCHA/auth/input/confirm scenarios outside the
  //   policy engine (CAPTCHA defaults to human takeover, never auto-bypassed).
  //   The machine enters waiting (wait.kind='human'). This is independent of
  //   runAction's confirm path (which uses the injected resolveApproval
  //   callback): requestHuman/resolveHuman is a separate explicit wait
  //   protocol. Simplified: no trace span — only a human.requested progress
  //   entry (tone warn, text carries request.prompt).
  async requestHuman(input: { request: HumanRequest }): Promise<void> {
    const { request } = input;
    // 终态守卫：人工接管发生在运行中，终态后拒绝请求是显式异常（与 runAction
    // 的降级返回不同，这里直接抛错）。
    // — English: terminal guard — takeover happens mid-run; requesting after a
    //   terminal state is an explicit error (unlike runAction's degraded return).
    if (TERMINAL_STATUSES.has(this.#machine.state.status)) {
      throw new Error('terminal state');
    }
    // requestId/taskId 必须与 machine 一致：taskId 匹配机器；requestId 不得与
    // 当前待处理请求冲突（同一时刻至多一个 pending human request）。
    // — English: requestId/taskId must agree with the machine — taskId must
    //   match the machine's; requestId must not clash with an in-flight
    //   request (at most one pending human request at a time).
    if (request.taskId !== this.#machine.state.taskId) {
      throw new Error(`human request taskId mismatch: ${request.taskId}`);
    }
    if (this.#pendingHumanRequestId !== undefined) {
      throw new Error(`human request already pending: ${this.#pendingHumanRequestId}`);
    }
    // 状态变化：machine.requestHuman（内部发 human.requested 事件，要求 running）。
    // — English: state change — machine.requestHuman emits human.requested (requires running).
    this.#machine.requestHuman(request);
    this.#pendingHumanRequestId = request.requestId;
    // 进度投影：human.requested 条目（tone warn，文本含 prompt）。
    // — English: progress projection — a human.requested entry (tone warn, prompt in text).
    this.#emitProgress([{ type: 'human.requested', prompt: request.prompt, at: Date.now() }]);
  }

  // 解决人工接管：machine.resolveHuman（发 human.resolved 事件，状态回 running，
  // wait 清除）。requestId 必须匹配 #pendingHumanRequestId —— taskMachine 的
  // resolveHuman 不校验 requestId，校验放在编排器。
  // — English: resolve a human takeover — machine.resolveHuman emits
  //   human.resolved (back to running, wait cleared). requestId must match
  //   #pendingHumanRequestId — taskMachine's resolveHuman does not validate
  //   requestId, so the check lives here in the orchestrator.
  async resolveHuman(input: { requestId: string; approved: boolean; reason?: string }): Promise<void> {
    // requestId 校验：无待处理请求或 id 不匹配均为显式错误。
    // — English: requestId validation — no pending request or a mismatched id is an explicit error.
    if (this.#pendingHumanRequestId !== input.requestId) {
      throw new Error(`no pending human request for requestId: ${input.requestId}`);
    }
    // 状态变化：machine.resolveHuman（内部要求 waiting；抛错时 pending 保留）。
    // — English: state change — machine.resolveHuman (requires waiting; pending is kept on error).
    this.#machine.resolveHuman({ requestId: input.requestId, approved: input.approved, reason: input.reason });
    this.#pendingHumanRequestId = undefined;
    // 进度投影：human.resolved（approved→ok '已确认'；拒绝→info '已拒绝，Agent 将调整方案'）。
    // — English: progress projection — human.resolved (approved→ok '已确认';
    //   rejected→info '已拒绝，Agent 将调整方案').
    this.#emitProgress([{ type: 'human.resolved', approved: input.approved, at: Date.now() }]);
  }

  // 取消：任务级——machine.cancel；会话保持，调用方自行 close。
  // — English: cancel — task level only (machine.cancel); the session stays
  //   open for the caller to close.
  async cancel(reason?: string): Promise<void> {
    this.#machine.cancel(reason);
  }

  // 关闭：session.close + machine 终态（未终态则 cancel）。幂等。
  // — English: close — session.close + machine terminal state (cancel if not
  //   terminal). Idempotent.
  async close(reason?: string): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    if (!TERMINAL_STATUSES.has(this.#machine.state.status)) {
      this.#machine.cancel(reason ?? '编排器关闭');
    }
    await this.#session?.close(reason);
  }

  // 恢复建议（架构文档 §9.4）：committed 无建议；uncertain 按副作用类别
  // （外部副作用 → reconcile 对账，否则 → reobserve）；failed 走 decideRecovery
  // 恢复矩阵（transient/llm 有上限退避重试、element 重新观测、policy/page/
  // cancelled 中止、side_effect 对账、budget 重规划）。
  // — English: recovery suggestion (§9.4) — none for committed; uncertain is
  //   split by side-effect class (external → reconcile, else → reobserve);
  //   failed follows the decideRecovery matrix (transient/llm capped backoff
  //   retry, element reobserve, policy/page/cancelled abort, side_effect
  //   reconcile, budget replan).
  #recoveryFor(result: ActionResult, intent: ActionIntent): RecoverySuggestion | undefined {
    if (result.status === 'committed') return undefined;
    if (result.status === 'uncertain') {
      return shouldRetryUncertain(intent.effect)
        ? { action: 'reobserve', reason: '后置条件未满足，重新观测后重试', retryable: true }
        : { action: 'reconcile', reason: '外部副作用结果不明，对账后再决定', retryable: false };
    }
    return decideRecovery(result.error, {
      attempts: this.#actionAttempts.get(intent.actionId) ?? 0,
      effect: intent.effect,
    });
  }

  // 策略失败结果：POLICY_DENIED 分类错误（不执行动作）。
  // — English: policy failure result — a POLICY_DENIED classified error (no execution).
  #policyFailure(intent: ActionIntent, reason: string): ActionResult {
    return {
      status: 'failed',
      error: { kind: 'policy', code: 'POLICY_DENIED', message: reason, retryable: false, actionId: intent.actionId },
    };
  }

  // 最近观测页面 url 的 origin（解析失败返回 ''）——下载预检的同源上下文。
  // — English: origin of the latest observed page url ('' when unparseable) —
  //   the same-origin context for the download preflight.
  #sourceOriginOf(url: string | undefined): string {
    try {
      return new URL(url ?? '').origin;
    } catch {
      return '';
    }
  }

  // 副作用账本记录：preState 取自最近观测；targetFingerprint 从观测元素映射。
  // — English: ledger record — preState from the latest observation, fingerprint
  //   resolved from the observed elements.
  #buildLedgerRecord(intent: ActionIntent): ActionRecord {
    const last = this.#lastObservation;
    const targetFingerprint = intent.targetRef !== undefined
      ? last?.elements.find((el) => el.ref === intent.targetRef)?.fingerprint
      : undefined;
    return {
      actionId: intent.actionId,
      taskId: intent.taskId,
      actionDigest: `sha256:${intent.actionId}`,
      effect: intent.effect,
      status: 'prepared',
      preState: {
        pageId: last?.pageId ?? intent.pageId,
        url: last?.url ?? '',
        observationId: last?.observationId ?? intent.observationId,
        navigationEpoch: last?.navigationEpoch ?? intent.expectedNavigationEpoch,
        ...(targetFingerprint !== undefined ? { targetFingerprint } : {}),
      },
      expectedPostcondition: intent.postcondition,
      preparedAt: Date.now(),
      evidenceRefs: [],
    };
  }

  // 事件写入守卫：机器已终态（如取消）时事件流冻结，落账静默跳过；
  // 预算错误（BudgetExceededError）仍然上抛，调用方据此中止任务。
  // — English: event-write guard — once the machine is terminal the event
  //   stream is frozen and ledger writes are skipped silently; budget errors
  //   still propagate for the caller to abort.
  #applyGuard(fn: () => void): void {
    try {
      fn();
    } catch (err) {
      if (err instanceof BudgetExceededError) throw err;
      if (TERMINAL_STATUSES.has(this.#machine.state.status)) return;
      throw err;
    }
  }

  // 收尾：onCheckpoint（事件快照 + 状态快照）+ onProgress 逐条投影本动作事件。
  // — English: wrap-up — onCheckpoint (event/state snapshots) + per-entry
  //   onProgress projection of this action's events.
  #finishRunAction(intent: ActionIntent, result: ActionResult): void {
    this.#deps.onCheckpoint?.(this.#machine.checkpoint());
    const sources: ProgressSource[] = [];
    // 只有真正进入账本的路径才投影 action.prepared（deny 路径无 prepared 事件）。
    // — English: project action.prepared only when the ledger recorded it (deny paths have none).
    if (this.#machine.events.some((e) => e.type === 'action.prepared' && e.record.actionId === intent.actionId)) {
      sources.push({ type: 'action.prepared', actionKind: intent.kind, at: Date.now() });
    }
    if (result.status === 'failed') {
      sources.push({ type: 'action.completed', outcome: 'failed', errorCode: result.error.code, at: Date.now() });
    } else if (result.status === 'uncertain') {
      sources.push({ type: 'action.completed', outcome: 'uncertain', at: Date.now() });
    } else {
      sources.push({ type: 'action.completed', outcome: 'committed', at: Date.now() });
    }
    this.#emitProgress(sources);
  }

  // 进度投影：projectProgress 纯函数逐条映射后回调。
  // — English: progress projection — map via projectProgress then call back per entry.
  #emitProgress(sources: readonly ProgressSource[]): void {
    const onProgress = this.#deps.onProgress;
    if (onProgress === undefined) return;
    for (const entry of projectProgress(sources)) {
      onProgress(entry);
    }
  }

  // 接受观测：机器记账 + trace + 进度（observation.accepted）。
  // — English: accept an observation — machine ledger + trace + progress.
  #acceptObservation(obs: Observation): void {
    this.#machine.acceptObservation({
      observationId: obs.observationId,
      pageId: obs.pageId,
      navigationEpoch: obs.navigationEpoch,
      elementCount: obs.elements.length,
    });
    this.#trace?.observed({
      pageId: obs.pageId,
      observationId: obs.observationId,
      url: obs.url,
      elementCount: obs.elements.length,
    });
    this.#lastObservation = obs;
    this.#emitProgress([{ type: 'observation.accepted', elementCount: obs.elements.length, at: obs.capturedAt }]);
  }

  #requireSession(): BrowserSessionHandle {
    if (this.#session === undefined) {
      throw new Error('orchestrator not started: call start() first');
    }
    return this.#session;
  }
}
