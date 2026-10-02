// 通用任务状态机原语：与具体业务解耦，供 OpsTask 与未来的 Task / TaskRun 共用。
// 注意：本模块暂不经 index.ts 聚合导出，由使用方按路径直接引用（index.ts 由并行任务负责）。
// Generic task state-machine primitives, decoupled from any concrete domain so OpsTask and the
// upcoming Task / TaskRun can share one source of truth for transitions, terminal states,
// optimistic locking and idempotent retry derivation.
// NOTE: this module is intentionally NOT re-exported through index.ts yet; consumers import it by
// path. index.ts is owned by a parallel workstream.

/**
 * 状态机的唯一迁移表：每个状态映射到它允许到达的后继状态集合。
 * The single allowed-transition table: each state maps to the set of states it may reach.
 */
export type TransitionTable<S extends string> = Readonly<Record<S, readonly S[]>>;

/** 迁移非法性的类别：终态优先于普通非法迁移。 */
/** Category of an illegal transition; terminal wins over a plain invalid transition. */
export type TransitionErrorKind = 'terminal' | 'invalid';

/** 传递给 errorFactory 的迁移上下文。 */
/** The transition context handed to the error factory. */
export interface TransitionErrorContext<S extends string> {
  kind: TransitionErrorKind;
  from: S;
  to: S;
}

/** 通用状态机 helper 集合。 */
/** The generic state-machine helper bundle. */
export interface TransitionHelpers<S extends string> {
  /** 判断任意字符串是否为合法状态。 */
  isState: (value: string) => value is S;
  /** 判断状态是否为终态。 */
  isTerminalState: (state: S) => boolean;
  /** 判断 from → to 是否在迁移表内。 */
  canTransition: (from: S, to: S) => boolean;
  /** 断言迁移合法；非法时抛出 errorFactory 构造的错误。 */
  assertTransition: (from: S, to: S) => void;
}

export interface CreateTransitionHelpersInput<S extends string> {
  states: readonly S[];
  transitions: TransitionTable<S>;
  terminalStates: Iterable<S>;
  /** 由使用方决定错误类型、错误码与错误文案；工厂只负责在正确的时机调用。 */
  /** The caller owns the error type / code / message; the factory only calls it at the right moment. */
  errorFactory: (context: TransitionErrorContext<S>) => Error;
}

/**
 * 构建一组与业务无关的状态迁移 helper。
 * 行为契约与 OpsTask 现有实现保持一致：`assertTransition` 先判定终态（terminal），
 * 再判定普通非法迁移（invalid），终态优先。
 *
 * Build business-agnostic transition helpers. Behaviour matches the existing OpsTask
 * implementation exactly: `assertTransition` reports terminal-state errors first, then plain
 * invalid-transition errors.
 */
export function createTransitionHelpers<S extends string>(
  input: CreateTransitionHelpersInput<S>,
): TransitionHelpers<S> {
  const terminalSet: ReadonlySet<S> = new Set(input.terminalStates);

  const isState = (value: string): value is S =>
    (input.states as readonly string[]).includes(value);

  const isTerminalState = (state: S): boolean => terminalSet.has(state);

  const canTransition = (from: S, to: S): boolean => input.transitions[from].includes(to);

  const assertTransition = (from: S, to: S): void => {
    // 终态优先：终态出口先报 TERMINAL，其余非法迁移再报 INVALID。
    // Terminal wins first: a terminal source reports the TERMINAL error, otherwise INVALID.
    if (isTerminalState(from)) {
      throw input.errorFactory({ kind: 'terminal', from, to });
    }
    if (!canTransition(from, to)) {
      throw input.errorFactory({ kind: 'invalid', from, to });
    }
  };

  return { isState, isTerminalState, canTransition, assertTransition };
}

/** 乐观锁冲突上下文。 */
/** Optimistic-lock conflict context. */
export interface VersionConflictContext {
  actual: number;
  expected: number;
}

/** 由使用方构造的版本冲突错误。 */
/** The version-conflict error built by the caller. */
export type VersionConflictHandler = (context: VersionConflictContext) => Error;

/**
 * 版本是否匹配：两侧都必须是安全整数且严格相等。
 * 语义与 OpsTask 的 `Number.isSafeInteger(a) && Number.isSafeInteger(b) && a === b` 完全一致。
 * Whether two versions match: both must be safe integers and strictly equal — identical to the
 * semantics already used by OpsTask.
 */
export function isVersionMatch(actual: number, expected: number): boolean {
  return Number.isSafeInteger(actual) && Number.isSafeInteger(expected) && actual === expected;
}

/**
 * 通用乐观锁校验：匹配返回 true，否则抛出 onConflict 构造的错误。
 * 失败触发条件是 {@link isVersionMatch} 的严格取反，与 OpsTask 保持一致。
 * Generic optimistic-lock check: returns true on match, otherwise throws the error built by
 * `onConflict`. The failure trigger is the exact negation of {@link isVersionMatch}, matching
 * OpsTask.
 */
export function validateVersion(
  actual: number,
  expected: number,
  onConflict: VersionConflictHandler,
): true {
  if (!isVersionMatch(actual, expected)) {
    throw onConflict({ actual, expected });
  }
  return true;
}

/** 重试 id 校验上下文。 */
/** Retry-id validation context. */
export interface RetryIdContext {
  taskId: string;
  parentTaskId: string;
}

/** 重试 id 非法时构造的错误。 */
/** The error built when the retry id is invalid. */
export type RetryIdConflictHandler = (context: RetryIdContext) => Error;

/**
 * 重试 id 是否合法：新 id 必须非空且不等于父 id（幂等重试的基本前提）。
 * Whether a retry id is valid: the new id must be non-empty and differ from the parent id — the
 * baseline precondition for an idempotent retry.
 */
export function isRetryIdValid(taskId: string, parentTaskId: string): boolean {
  return Boolean(taskId) && taskId !== parentTaskId;
}

export interface DeriveRetrySpecInput<Source, Result> {
  /** 作为父任务 id 来源，用于 id 合法性校验。 */
  parentId: string;
  /** 本次重试分配的新 id。 */
  newId: string;
  /** id 非法时构造错误（由使用方决定错误码与文案）。 */
  onInvalidId: RetryIdConflictHandler;
  /** id 合法后，由使用方把源对象映射为重试结果对象。 */
  build: (source: Source) => Result;
}

/**
 * 通用幂等重试派生原语：先校验新 id 合法，再把源规格映射为重试规格。
 * 具体的字段拷贝语义留给使用方的 `build` 决定，工厂本身不假设任何业务字段。
 * Generic idempotent retry derivation: validate the new id first, then let the caller's `build`
 * map the source into the retry result. The factory assumes no domain-specific fields.
 */
export function deriveRetrySpec<Source, Result>(
  source: Source,
  input: DeriveRetrySpecInput<Source, Result>,
): Result {
  if (!isRetryIdValid(input.newId, input.parentId)) {
    throw input.onInvalidId({ taskId: input.newId, parentTaskId: input.parentId });
  }
  return input.build(source);
}
