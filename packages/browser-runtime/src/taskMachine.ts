// 浏览器任务状态机：append-only 事件折叠为任务状态（纯函数），
// 以及带预算校验、取消信号、检查点/恢复的机器封装。
// — English: browser task state machine — append-only events fold into
//   task state (pure function), plus a machine wrapper with budget
//   validation, abort signal handling and checkpoint/restore.
// 状态由事件派生：checkpoint 只保存事件序列，state 由 fold 重建。
// — English: state is derived from events — a checkpoint is just the event
//   list; state is rebuilt by folding.
import type {
  ActionRecord,
  BrowserTaskEvent,
  BrowserTaskState,
  ClassifiedError,
  HumanRequest,
  PlanStep,
  TaskBudget,
  TaskUsage,
} from '@suanlizi/protocol';

// 默认任务预算：步数/令牌/重规划/连续失败/时长/外部写入/下载字节上限
// — English: default task budget — step/token/replan/consecutive-failure/duration/write/download caps
export const DEFAULT_TASK_BUDGET: TaskBudget = {
  maxSteps: 50,
  maxTokens: 200000,
  maxReplans: 3,
  maxConsecutiveFailures: 3,
  maxDurationMs: 30 * 60 * 1000,
  maxExternalWrites: 3,
  maxDownloadBytes: 50 * 1024 * 1024,
};

// 初始用量：全部为 0，startedAt 未设置（0 表示未开始，时长校验跳过）
// — English: zeroed usage — startedAt 0 means not started (duration check skipped)
export function emptyTaskUsage(): TaskUsage {
  return {
    steps: 0,
    tokens: 0,
    replans: 0,
    consecutiveFailures: 0,
    externalWrites: 0,
    downloadBytes: 0,
    startedAt: 0,
  };
}

// 初始状态：status=planning、plan 为空、usage 全 0（taskId/goal 在 task.created 时填充）
// — English: initial state — status planning, empty plan, zeroed usage
//   (taskId/goal are filled in by task.created)
export function initialTaskState(budget: TaskBudget = DEFAULT_TASK_BUDGET): BrowserTaskState {
  return { taskId: '', goal: '', status: 'planning', plan: [], budget, usage: emptyTaskUsage() };
}

const TERMINAL_STATUSES: ReadonlySet<BrowserTaskState['status']> = new Set(['completed', 'cancelled', 'failed']);

function isTerminal(status: BrowserTaskState['status']): boolean {
  return TERMINAL_STATUSES.has(status);
}

// 单事件折叠（宽容实现）：终态后的事件忽略、重复 task.created 忽略，
// 非法顺序不抛错——严格校验由 BrowserTaskMachine.apply 负责。
// — English: single-event fold (lenient) — events after a terminal state are
//   ignored, duplicate task.created is ignored; invalid sequences do not
//   throw here — strict validation lives in BrowserTaskMachine.apply.
export function foldBrowserTaskEvent(state: BrowserTaskState, event: BrowserTaskEvent): BrowserTaskState {
  if (isTerminal(state.status)) return state;
  switch (event.type) {
    case 'task.created':
      if (state.taskId !== '') return state;
      return {
        ...state,
        taskId: event.taskId,
        goal: event.goal,
        status: 'running',
        // startedAt 从事件时间恢复，保证 checkpoint/restore 后时长预算依然生效
        // — English: startedAt is restored from the event time so duration budget survives restore
        usage: { ...state.usage, startedAt: Date.parse(event.createdAt) || 0 },
      };
    case 'plan.updated':
      return { ...state, plan: event.plan };
    case 'observation.accepted':
      return { ...state, activePageId: event.pageId };
    case 'action.prepared':
    case 'action.uncertain':
      // prepared/uncertain 不改变任务状态（recentAction 由调用方管理）
      // — English: prepared/uncertain do not change task state
      return state;
    case 'action.completed':
      return {
        ...state,
        usage: {
          ...state.usage,
          consecutiveFailures: event.outcome === 'committed' ? 0 : state.usage.consecutiveFailures + 1,
        },
      };
    case 'human.requested':
      return { ...state, status: 'waiting', wait: { kind: 'human', requestId: event.request.requestId, since: Date.now() } };
    case 'human.resolved':
      return { ...state, status: 'running', wait: undefined };
    case 'budget.updated':
      return { ...state, usage: event.usage };
    case 'task.paused':
      return { ...state, status: 'paused' };
    case 'task.cancelled':
      return { ...state, status: 'cancelled' };
    case 'task.failed':
      return { ...state, status: 'failed', failure: event.failure };
    case 'task.completed':
      return { ...state, status: 'completed' };
    default: {
      // 穷尽检查：新增事件类型时必须在此处理
      // — English: exhaustiveness — new event types must be handled here
      const _exhaustive: never = event;
      return state;
    }
  }
}

// 按序折叠事件列表为状态（纯函数）。initial 缺省为全默认初始状态，
// 传入 initial 可从已有状态继续折叠。
// — English: fold an event list into state (pure). Without initial, defaults
//   to the all-default initial state; pass initial to continue from existing state.
export function foldBrowserTaskEvents(events: BrowserTaskEvent[], initial?: BrowserTaskState): BrowserTaskState {
  let state = initial ?? initialTaskState();
  for (const event of events) {
    state = foldBrowserTaskEvent(state, event);
  }
  return state;
}

// 预算超限错误：resource 为第一个超限的 usage 字段名
// 注意：不使用构造器参数属性（Node strip-only 模式不支持该语法）。
// — English: budget exceeded error — resource names the first over-limit usage
//   field. NOTE: parameter properties are avoided (unsupported by Node's
//   strip-only TypeScript mode).
export class BudgetExceededError extends Error {
  readonly resource: keyof TaskUsage;

  constructor(resource: keyof TaskUsage) {
    super(`budget exceeded: ${resource}`);
    this.name = 'BudgetExceededError';
    this.resource = resource;
  }
}

// reserve 可增量消耗的计数字段（consecutiveFailures 由 completeAction 管理，startedAt 由 start 设置）
// — English: counter fields reservable via reserve()
//   (consecutiveFailures is managed by completeAction, startedAt by start)
const USAGE_COUNTER_KEYS = ['steps', 'tokens', 'replans', 'externalWrites', 'downloadBytes'] as const;

export interface BrowserTaskMachineInput {
  taskId: string;
  goal: string;
  budget?: TaskBudget;
  signal?: AbortSignal;
}

// 浏览器任务状态机：事件 append-only，状态增量维护并可由事件序列重建。
// — English: browser task machine — append-only events, state maintained
//   incrementally and rebuildable from the event list.
export class BrowserTaskMachine {
  readonly #taskId: string;
  readonly #goal: string;
  readonly #initial: BrowserTaskState;
  #state: BrowserTaskState;
  #events: BrowserTaskEvent[] = [];

  constructor(input: BrowserTaskMachineInput) {
    this.#taskId = input.taskId;
    this.#goal = input.goal;
    this.#initial = initialTaskState(input.budget);
    this.#state = this.#initial;
    if (input.signal?.aborted) {
      // 构造时已中止：直接置终态，不发事件（避免 first-event 校验拦截）。
      // — English: already aborted at construction — enter the terminal state directly without an event.
      this.#state = { ...this.#state, status: 'cancelled' };
    } else if (input.signal) {
      input.signal.addEventListener('abort', () => this.cancel('任务被中止'), { once: true });
    }
  }

  // 当前状态快照（浅拷贝，防止外部直接改写内部状态）
  // — English: current state snapshot (shallow copy)
  get state(): BrowserTaskState {
    return { ...this.#state };
  }

  get events(): readonly BrowserTaskEvent[] {
    return this.#events.slice();
  }

  // 应用事件：校验非法转换后折叠进状态。违反规则抛 Error。
  // — English: apply an event — validate illegal transitions, then fold into state
  apply(event: BrowserTaskEvent): void {
    // 终态之后任何事件都非法
    // — English: nothing may be applied after a terminal state
    if (isTerminal(this.#state.status)) {
      throw new Error('terminal state');
    }
    // 事件 taskId 必须与机器一致
    // — English: event taskId must match the machine's taskId
    if ('taskId' in event && event.taskId !== this.#taskId) {
      throw new Error(`event taskId mismatch: ${event.taskId}`);
    }
    // 第一个事件必须是 task.created
    // — English: the first event must be task.created
    if (this.#state.taskId === '' && event.type !== 'task.created') {
      throw new Error('first event must be task.created');
    }
    // budget.updated 不能伪造：新 usage 只能非负递增且不超预算
    // — English: budget.updated cannot be forged — usage must grow non-negatively within budget
    if (event.type === 'budget.updated') {
      this.#assertValidUsageUpdate(event.usage);
    }
    // action.completed 不能绕过连续失败预算（便捷方法之外直接 apply 同样受限）
    // — English: action.completed cannot bypass the consecutive-failure budget
    if (event.type === 'action.completed' && event.outcome !== 'committed') {
      const next = this.#state.usage.consecutiveFailures + 1;
      if (next > this.#state.budget.maxConsecutiveFailures) {
        throw new BudgetExceededError('consecutiveFailures');
      }
    }
    switch (event.type) {
      case 'task.paused':
        if (this.#state.status !== 'planning' && this.#state.status !== 'running') {
          throw new Error(`task.paused requires planning|running, got ${this.#state.status}`);
        }
        break;
      case 'human.requested':
        if (this.#state.status !== 'running') {
          throw new Error(`human.requested requires running, got ${this.#state.status}`);
        }
        break;
      case 'human.resolved':
        if (this.#state.status !== 'waiting') {
          throw new Error(`human.resolved requires waiting, got ${this.#state.status}`);
        }
        break;
      case 'task.completed':
        if (this.#state.status !== 'running') {
          throw new Error(`task.completed requires running, got ${this.#state.status}`);
        }
        break;
      default:
        break;
    }
    this.#state = foldBrowserTaskEvent(this.#state, event);
    this.#events.push(event);
  }

  // 便捷方法：task.created（折叠后即 running，startedAt 从事件时间恢复）
  // — English: convenience — task.created folds to running with startedAt from the event
  start(): void {
    this.apply({ type: 'task.created', taskId: this.#taskId, goal: this.#goal, createdAt: new Date().toISOString() });
  }

  updatePlan(plan: PlanStep[]): void {
    this.apply({ type: 'plan.updated', taskId: this.#taskId, plan, updatedAt: new Date().toISOString() });
  }

  acceptObservation(input: { observationId: string; pageId: string; navigationEpoch: number; elementCount: number }): void {
    this.apply({
      type: 'observation.accepted',
      taskId: this.#taskId,
      observationId: input.observationId,
      pageId: input.pageId,
      navigationEpoch: input.navigationEpoch,
      elementCount: input.elementCount,
      acceptedAt: new Date().toISOString(),
    });
  }

  prepareAction(record: ActionRecord): void {
    this.apply({ type: 'action.prepared', taskId: this.#taskId, record, preparedAt: new Date().toISOString() });
  }

  completeAction(input: { actionId: string; outcome: 'committed' | 'uncertain' | 'failed'; evidenceRefs: string[] }): void {
    // 连续失败预算：失败/不确定递增后超过上限则拒绝（禁止无限重试）
    // — English: consecutive-failure budget — exceeding the cap after failed/uncertain is rejected
    if (input.outcome !== 'committed') {
      const next = this.#state.usage.consecutiveFailures + 1;
      if (next > this.#state.budget.maxConsecutiveFailures) {
        throw new BudgetExceededError('consecutiveFailures');
      }
    }
    this.apply({
      type: 'action.completed',
      taskId: this.#taskId,
      actionId: input.actionId,
      outcome: input.outcome,
      evidenceRefs: input.evidenceRefs,
      completedAt: new Date().toISOString(),
    });
  }

  requestHuman(request: HumanRequest): void {
    this.apply({ type: 'human.requested', taskId: this.#taskId, request });
  }

  resolveHuman(input: { requestId: string; approved: boolean; reason?: string }): void {
    this.apply({
      type: 'human.resolved',
      taskId: this.#taskId,
      requestId: input.requestId,
      approved: input.approved,
      reason: input.reason,
      resolvedAt: new Date().toISOString(),
    });
  }

  pause(reason?: string): void {
    this.apply({ type: 'task.paused', taskId: this.#taskId, reason, pausedAt: new Date().toISOString() });
  }

  // 幂等：已处于终态时静默忽略
  // — English: idempotent — silently ignored once terminal
  cancel(reason?: string): void {
    if (isTerminal(this.#state.status)) return;
    this.apply({ type: 'task.cancelled', taskId: this.#taskId, reason, cancelledAt: new Date().toISOString() });
  }

  fail(failure: ClassifiedError): void {
    this.apply({ type: 'task.failed', taskId: this.#taskId, failure, failedAt: new Date().toISOString() });
  }

  complete(summary?: string): void {
    this.apply({ type: 'task.completed', taskId: this.#taskId, summary, completedAt: new Date().toISOString() });
  }

  // 预算增量校验：对 usage 增量后的各项计数与时长进行上限检查。
  // durationMs 用 Date.now()-usage.startedAt（startedAt 为 0 时跳过）。
  // — English: incremental budget check against all caps; duration uses
  //   Date.now()-usage.startedAt (skipped when startedAt is 0).
  canReserve(usage: Partial<TaskUsage>): boolean {
    return this.#exceededResource(usage) === null;
  }

  // 增量记账：超预算抛 BudgetExceededError（resource 为超限字段名）；
  // 成功后通过 budget.updated 事件落账。
  // — English: incremental accounting — throws BudgetExceededError on
  //   over-budget (resource = over-limit field); success is persisted via budget.updated.
  reserve(usage: Partial<TaskUsage>): void {
    // 负增量拒绝：usage 只能消耗不能回退
    // — English: negative deltas are rejected — usage only ever grows
    for (const key of USAGE_COUNTER_KEYS) {
      const delta = usage[key];
      if (delta !== undefined && delta < 0) {
        throw new Error(`negative usage delta: ${key}`);
      }
    }
    const exceeded = this.#exceededResource(usage);
    if (exceeded !== null) {
      throw new BudgetExceededError(exceeded);
    }
    const next: TaskUsage = { ...this.#state.usage };
    for (const key of USAGE_COUNTER_KEYS) {
      const delta = usage[key];
      if (delta !== undefined) {
        next[key] += delta;
      }
    }
    this.apply({ type: 'budget.updated', taskId: this.#taskId, usage: next, updatedAt: new Date().toISOString() });
  }

  // 检查点：事件序列即检查点；state 为当前真实状态快照
  // （构造即取消的无事件终态不进入事件序列，restore 后由调用方按需处理）。
  // — English: checkpoint — the event list is the checkpoint; state is the live snapshot
  //   (a construction-time cancellation has no events and is not restored as cancelled).
  checkpoint(): { events: BrowserTaskEvent[]; state: BrowserTaskState } {
    return { events: this.#events.slice(), state: { ...this.#state } };
  }

  // 从检查点恢复：跳过 apply 校验（事件序列视为已校验），直接折叠重建状态。
  // — English: restore from a checkpoint — skip apply validation (events are
  //   treated as already-validated) and rebuild state by folding.
  static restore(input: { taskId: string; goal: string; budget?: TaskBudget; events: BrowserTaskEvent[] }): BrowserTaskMachine {
    const machine = new BrowserTaskMachine({ taskId: input.taskId, goal: input.goal, budget: input.budget });
    let state = machine.#initial;
    for (const event of input.events) {
      state = foldBrowserTaskEvent(state, event);
    }
    machine.#state = state;
    machine.#events = input.events.slice();
    return machine;
  }

  // 返回第一个超限字段名（无超限返回 null）；duration 超限以 startedAt 标识
  // — English: first over-limit field name, or null; duration overflow is flagged as startedAt
  #exceededResource(usage: Partial<TaskUsage>): keyof TaskUsage | null {
    const current = this.#state.usage;
    const budget = this.#state.budget;
    const next = {
      steps: current.steps + (usage.steps ?? 0),
      tokens: current.tokens + (usage.tokens ?? 0),
      replans: current.replans + (usage.replans ?? 0),
      externalWrites: current.externalWrites + (usage.externalWrites ?? 0),
      downloadBytes: current.downloadBytes + (usage.downloadBytes ?? 0),
    };
    if (next.steps > budget.maxSteps) return 'steps';
    if (next.tokens > budget.maxTokens) return 'tokens';
    if (next.replans > budget.maxReplans) return 'replans';
    if (next.externalWrites > budget.maxExternalWrites) return 'externalWrites';
    if (next.downloadBytes > budget.maxDownloadBytes) return 'downloadBytes';
    if (current.startedAt > 0 && Date.now() - current.startedAt > budget.maxDurationMs) return 'startedAt';
    return null;
  }

  // budget.updated 事件防伪：新 usage 相对当前只能非负递增且逐项不超预算；
  // startedAt 只能前进（置 0 伪造会永久绕过时长预算）。
  // — English: anti-forgery for budget.updated — usage must grow non-negatively within budget;
  //   startedAt may only move forward (forging 0 would bypass the duration budget).
  #assertValidUsageUpdate(next: TaskUsage): void {
    const current = this.#state.usage;
    const budget = this.#state.budget;
    if (next.steps < current.steps || next.tokens < current.tokens || next.replans < current.replans
      || next.externalWrites < current.externalWrites || next.downloadBytes < current.downloadBytes
      || next.consecutiveFailures < current.consecutiveFailures
      || next.startedAt < current.startedAt) {
      throw new Error('budget.updated cannot decrease usage');
    }
    if (next.steps > budget.maxSteps) throw new BudgetExceededError('steps');
    if (next.tokens > budget.maxTokens) throw new BudgetExceededError('tokens');
    if (next.replans > budget.maxReplans) throw new BudgetExceededError('replans');
    if (next.externalWrites > budget.maxExternalWrites) throw new BudgetExceededError('externalWrites');
    if (next.downloadBytes > budget.maxDownloadBytes) throw new BudgetExceededError('downloadBytes');
    if (next.consecutiveFailures > budget.maxConsecutiveFailures) throw new BudgetExceededError('consecutiveFailures');
  }
}
