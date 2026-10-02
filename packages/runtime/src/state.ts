import type { AgentDecisionRequest, ThreadId, TurnId, ItemId, Checkpoint } from '@suanlizi/protocol';

// 方便外部再导出
// Re-export for convenience
export type { Checkpoint };
export type { CheckpointLine } from '@suanlizi/protocol';

// ─── TurnSummary ────────────────────────────────────────────────────────────
/**
 * Per-turn runtime accumulation.
 * Tracks what happened during the current (or most recent) turn
 * without requiring a full item replay.
 * 每个 turn 的运行时汇总；记录当前或最近一个 turn 中发生的事件，避免回放全部 item。
 */
export interface TurnSummary {
  /** ISO-8601 when the turn started. */
  /** turn 启动时的 ISO-8601 时间戳。 */
  startedAt: string | null;
  /** Set of command ids that have started execution. */
  /** 已启动执行的 command id 集合。 */
  commandExecutionsStarted: Set<string>;
  /** Last error encountered during this turn, if any. */
  /** 本轮 turn 最近一次错误（如存在）。 */
  lastError: TurnError | null;
}

export interface TurnError {
  message: string;
  /** Item that caused the error, if applicable. */
  /** 导致错误的 item id（如适用）。 */
  itemId?: ItemId;
  /** ISO-8601 timestamp. */
  /** ISO-8601 时间戳。 */
  timestamp: string;
}

export interface AutoCompactWindow {
  /** Codex-style monotonically increasing compacted context window ordinal. */
  /** Codex 风格单调递增的上下文窗口序号，用来标记本次压缩窗口。 */
  ordinal: number;
  /** First server-reported input token count observed inside this window. */
  /** 本窗口内首次记录的服务端上报输入 token 数；用于基线审计。 */
  prefillInputTokens: number | null;
}

// ─── ThreadState ────────────────────────────────────────────────────────────
/**
 * Per-thread runtime state.
 *
 * Lives in memory (not persisted). On resume, rebuilt from storage.
 * The `status` field is the authoritative state for the thread's execution.
 * 每个 thread 的运行时状态；保存在内存中，不持久化。恢复时从存储重建。
 * status 字段是该线程执行状态的唯一可信来源。
 */
export type ThreadStatus = 'idle' | 'running' | 'stopping' | 'waiting_user_input' | 'terminal' | 'interrupted' | 'completed' | 'failed';

export interface ThreadState {
  /** Current execution status. */
  /** 当前执行状态。 */
  status: ThreadStatus;
  /** The turn currently executing, if any. */
  /** 当前正在执行的 turn id（如存在）。 */
  activeTurnId: TurnId | null;
  /** AbortController for the active turn — set to cancel. */
  /** 当前 turn 的 AbortController；调用 abort 可中断当前执行。 */
  cancelController: AbortController | null;
  /**
   * Monotonic generation counter — increments each time a new turn starts.
   * Listener generation marker for checkpoint freshness.
   * 单调递增的生成计数器；每次新 turn 启动时 +1，用于检查点新鲜度的监听器标记。
   */
  generation: number;
  /** Queue of pending interrupt request IDs. */
  /** 待处理的中断请求 id 队列。 */
  pendingInterrupts: string[];
  /** Pending rollback request, if any. */
  /** 待处理的回滚请求（如存在）。 */
  pendingRollback: TurnId | null;
  /** Auto-compaction window state for token baselines and audit explanations. */
  /** 自动压缩窗口状态，用于 token 基线计算和审计说明。 */
  autoCompactWindow: AutoCompactWindow;
  /** Accumulated summary of the current/last turn. */
  /** 当前/最近一次 turn 的累积摘要。 */
  turnSummary: TurnSummary;
  /** Last checkpoint written to JSONL. */
  /** 已写入 JSONL 的最后一个检查点。 */
  lastCheckpoint: Checkpoint | null;
  /** Last terminal turn ID (completed or failed). */
  /** 最后一次终止的 turn id（成功完成或失败）。 */
  lastTerminalTurnId: TurnId | null;
  terminalStatus: 'completed' | 'failed' | 'interrupted' | null;
  /** Persisted user-decision request currently blocking this turn. */
  pendingDecision: AgentDecisionRequest | null;
}

/** Create a fresh ThreadState. */
/** 创建一个全新的 ThreadState。 */
export function createThreadState(): ThreadState {
  return {
    status: 'idle',
    activeTurnId: null,
    cancelController: null,
    generation: 0,
    pendingInterrupts: [],
    pendingRollback: null,
    autoCompactWindow: { ordinal: 1, prefillInputTokens: null },
    turnSummary: createTurnSummary(),
    lastCheckpoint: null,
    lastTerminalTurnId: null,
    terminalStatus: null,
    pendingDecision: null,
  };
}

// 创建一个空的 TurnSummary
export function createTurnSummary(): TurnSummary {
  return {
    startedAt: null,
    commandExecutionsStarted: new Set(),
    lastError: null,
  };
}

// ─── ThreadStateManager ─────────────────────────────────────────────────────
/**
 * Manages per-thread runtime state. Single source of truth for thread
 * execution status, active turns, and checkpoint tracking.
 *
 * Process-local thread state manager.
 * 管理每个 thread 的运行时状态；是执行状态、活跃 turn、检查点追踪的唯一真相来源，运行于进程内。
 */
export class ThreadStateManager {
  private states: Map<ThreadId, ThreadState> = new Map();

  /** Get or create state for a thread. */
  /** 获取或初始化一个 thread 的运行时状态。 */
  get(threadId: ThreadId): ThreadState {
    let state = this.states.get(threadId);
    if (!state) {
      state = createThreadState();
      this.states.set(threadId, state);
    }
    return state;
  }

  /** Replace state entirely (e.g. on resume from storage). */
  /** 整体替换某个 thread 的状态（例如从存储恢复时）。 */
  set(threadId: ThreadId, state: ThreadState): void {
    this.states.set(threadId, state);
  }

  /** Remove state (thread archived / evicted). */
  /** 删除某个 thread 的状态（归档或淘汰）。 */
  remove(threadId: ThreadId): void {
    this.states.delete(threadId);
  }

  /** Check if a thread has an active running turn. */
  /** 判断某个 thread 是否存在运行中的 turn。 */
  isRunning(threadId: ThreadId): boolean {
    const state = this.get(threadId);
    return Boolean(state.activeTurnId) && ['running', 'stopping', 'waiting_user_input'].includes(state.status);
  }

  /** Transition to running and set up cancel controller. */
  /** 迁移到 running 状态并创建新的 AbortController。 */
  startTurn(threadId: ThreadId, turnId: TurnId): AbortController {
    const state = this.get(threadId);
    // Cancel any previous controller
    // 取消任何先前存在的 controller
    if (state.cancelController) {
      state.cancelController.abort();
    }
    state.status = 'running';
    state.terminalStatus = null;
    state.activeTurnId = turnId;
    state.generation += 1;
    state.cancelController = new AbortController();
    state.turnSummary = createTurnSummary();
    state.pendingDecision = null;
    state.turnSummary.startedAt = new Date().toISOString();
    return state.cancelController;
  }

  /** Transition to completed. */
  /** 迁移到 completed 状态。 */
  completeTurn(threadId: ThreadId, turnId: TurnId): void {
    const state = this.get(threadId);
    if (state.activeTurnId === turnId) {
      state.status = 'terminal';
      state.terminalStatus = 'completed';
      state.activeTurnId = null;
      state.lastTerminalTurnId = turnId;
      state.cancelController = null;
      state.pendingDecision = null;
    }
  }

  /** Transition to interrupted after the running task has observed cancellation. */
  /** 在运行任务观察到取消后，迁移到 interrupted 状态。 */
  completeInterruptedTurn(threadId: ThreadId, turnId: TurnId): void {
    const state = this.get(threadId);
    if (state.activeTurnId === turnId) {
      state.status = 'terminal';
      state.terminalStatus = 'interrupted';
      state.activeTurnId = null;
      state.lastTerminalTurnId = turnId;
      state.cancelController = null;
      state.pendingDecision = null;
    }
  }

  /** Transition to failed. */
  /** 迁移到 failed 状态。 */
  failTurn(threadId: ThreadId, turnId: TurnId, error: TurnError): void {
    const state = this.get(threadId);
    if (state.activeTurnId === turnId) {
      state.status = 'terminal';
      state.terminalStatus = 'failed';
      state.activeTurnId = null;
      state.lastTerminalTurnId = turnId;
      state.turnSummary.lastError = error;
      state.cancelController = null;
      state.pendingDecision = null;
    }
  }

  /** Transition to interrupted (turn was cancelled mid-flight). */
  /** 迁移到 interrupted 状态（turn 在执行中被取消）。 */
  interruptTurn(threadId: ThreadId, turnId: TurnId, requestId: string): void {
    const state = this.get(threadId);
    if (state.activeTurnId === turnId && ['running', 'waiting_user_input'].includes(state.status)) {
      state.status = 'stopping';
      state.pendingInterrupts.push(requestId);
      if (state.cancelController) {
        state.cancelController.abort();
      }
    }
  }

  /** Transition a turn into a durable wait-for-user-input state. */
  waitForUserInput(threadId: ThreadId, turnId: TurnId, request: AgentDecisionRequest): boolean {
    const state = this.get(threadId);
    if (state.activeTurnId !== turnId || !['running', 'waiting_user_input'].includes(state.status)) return false;
    state.status = 'waiting_user_input';
    state.pendingDecision = request;
    return true;
  }

  /** Resume the same turn after a decision is received; generation is stable. */
  resumeAfterUserInput(threadId: ThreadId, turnId: TurnId): boolean {
    const state = this.get(threadId);
    if (state.activeTurnId !== turnId || state.status !== 'waiting_user_input') return false;
    state.status = 'running';
    state.pendingDecision = null;
    return true;
  }

  /** Clear pending interrupts after they've been handled. */
  /** 处理完 pendingInterrupts 后清空队列。 */
  clearPendingInterrupts(threadId: ThreadId): void {
    this.get(threadId).pendingInterrupts = [];
  }

  // 开始一次回滚请求；若已存在 pending rollback 则返回 false 表示冲突
  beginRollback(threadId: ThreadId, requestId: string): boolean {
    const state = this.get(threadId);
    if (state.pendingRollback) return false;
    state.pendingRollback = requestId;
    return true;
  }

  // 结束一次回滚请求；不传 requestId 时强制清空；传 requestId 时仅在匹配时清空
  finishRollback(threadId: ThreadId, requestId?: string): void {
    const state = this.get(threadId);
    if (!requestId || state.pendingRollback === requestId) {
      state.pendingRollback = null;
    }
  }

  // 记录本窗口首次上报的输入 token 数；已存在的不覆盖，保持基线稳定
  recordAutoCompactWindowPrefill(threadId: ThreadId, inputTokens: number): void {
    const state = this.get(threadId);
    if (state.autoCompactWindow.prefillInputTokens === null) {
      state.autoCompactWindow.prefillInputTokens = inputTokens;
    }
  }

  // 开启下一个自动压缩上下文窗口：序号 +1，并重置 token 基线
  startNextAutoCompactWindow(threadId: ThreadId): AutoCompactWindow {
    const state = this.get(threadId);
    state.autoCompactWindow = {
      ordinal: state.autoCompactWindow.ordinal + 1,
      prefillInputTokens: null,
    };
    return state.autoCompactWindow;
  }

  /** Record a command execution start in the turn summary. */
  /** 在 turn summary 中记录一个 command 已开始执行。 */
  noteCommandStarted(threadId: ThreadId, commandId: string): void {
    this.get(threadId).turnSummary.commandExecutionsStarted.add(commandId);
  }

  /** Write a checkpoint for the current turn. */
  /** 为当前 turn 写入一个检查点引用。 */
  setCheckpoint(threadId: ThreadId, checkpoint: Checkpoint): void {
    this.get(threadId).lastCheckpoint = checkpoint;
  }

  /** Delete the state for a thread. */
  /** 删除某个 thread 的状态（同时中断其控制器）。 */
  delete(threadId: ThreadId): void {
    const state = this.states.get(threadId);
    if (state?.cancelController) {
      state.cancelController.abort();
    }
    this.states.delete(threadId);
  }

  /** Delete all states (shutdown). */
  /** 清空所有 thread 状态（进程关闭时使用）。 */
  deleteAll(): void {
    for (const [, state] of this.states) {
      if (state.cancelController) {
        state.cancelController.abort();
      }
    }
    this.states.clear();
  }

  // ─── Singleton ──────────────────────────────────────────────────────────
  private static _instance: ThreadStateManager | null = null;

  /** Get or create the process-level singleton. */
  /** 获取或创建进程级单例。 */
  static instance(): ThreadStateManager {
    if (!ThreadStateManager._instance) {
      ThreadStateManager._instance = new ThreadStateManager();
    }
    return ThreadStateManager._instance;
  }

  /** Reset the singleton (for tests). */
  /** 重置单例（测试用）。 */
  static resetInstance(): void {
    if (ThreadStateManager._instance) {
      ThreadStateManager._instance.deleteAll();
      ThreadStateManager._instance = null;
    }
  }
}
