import { describe, expect, it } from 'vitest';
import {
  canTransitionOpsTaskState,
  assertOpsTaskTransition,
  isOpsTaskState,
  isOpsTaskTerminalState,
  OPS_TASK_STATES,
  OPS_TASK_TRANSITIONS,
  OPS_TASK_TERMINAL_STATES,
  OpsTaskError,
  type OpsTaskState,
} from './opsTask.js';
import {
  createTransitionHelpers,
  deriveRetrySpec,
  isRetryIdValid,
  isVersionMatch,
  validateVersion,
  type TransitionErrorContext,
  type TransitionTable,
} from './taskStateMachine.js';

// 一个与业务无关的最小状态机，用于验证通用工厂本身。
// A minimal business-agnostic machine used to exercise the generic factory in isolation.
const MACHINE_STATES = ['a', 'b', 'done'] as const;
type MachineState = (typeof MACHINE_STATES)[number];

const MACHINE_TRANSITIONS: TransitionTable<MachineState> = {
  a: ['b'],
  b: ['a', 'done'],
  done: [],
};
const MACHINE_TERMINAL_STATES: ReadonlySet<MachineState> = new Set<MachineState>(['done']);

class MachineError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'MachineError';
  }
}

function machineErrorFactory({ kind, from, to }: TransitionErrorContext<MachineState>): Error {
  return kind === 'terminal'
    ? new MachineError('TERMINAL', `terminal ${from} cannot go to ${to}`)
    : new MachineError('INVALID', `cannot go from ${from} to ${to}`);
}

const machine = createTransitionHelpers<MachineState>({
  states: MACHINE_STATES,
  transitions: MACHINE_TRANSITIONS,
  terminalStates: MACHINE_TERMINAL_STATES,
  errorFactory: machineErrorFactory,
});

describe('generic transition helpers', () => {
  it('recognises states and terminal states', () => {
    expect(machine.isState('a')).toBe(true);
    expect(machine.isState('unknown')).toBe(false);
    expect(machine.isTerminalState('done')).toBe(true);
    expect(machine.isTerminalState('a')).toBe(false);
  });

  it('accepts legal transitions and rejects illegal ones', () => {
    expect(machine.canTransition('a', 'b')).toBe(true);
    expect(machine.canTransition('a', 'done')).toBe(false);
    expect(machine.canTransition('b', 'a')).toBe(true);
    expect(() => machine.assertTransition('a', 'b')).not.toThrow();
    expect(() => machine.assertTransition('a', 'done')).toThrowError(MachineError);
  });

  it('reports the terminal error before the invalid error', () => {
    try {
      machine.assertTransition('done', 'a');
      throw new Error('expected assertTransition to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(MachineError);
      expect((error as MachineError).code).toBe('TERMINAL');
    }
    // 非终态但非法的迁移应报 INVALID。
    // A non-terminal but illegal transition reports INVALID.
    try {
      machine.assertTransition('a', 'done');
      throw new Error('expected assertTransition to throw');
    } catch (error) {
      expect((error as MachineError).code).toBe('INVALID');
    }
  });
});

describe('generic optimistic lock and retry primitives', () => {
  it('matches safe integers only', () => {
    expect(isVersionMatch(3, 3)).toBe(true);
    expect(isVersionMatch(3, 2)).toBe(false);
    expect(isVersionMatch(Number.MAX_SAFE_INTEGER + 1, Number.MAX_SAFE_INTEGER + 1)).toBe(false);
    expect(isVersionMatch(1.5, 1.5)).toBe(false);
  });

  it('throws the caller-built conflict error', () => {
    expect(validateVersion(3, 3, () => new Error('never'))).toBe(true);
    expect(() =>
      validateVersion(3, 2, ({ actual, expected }) => new Error(`conflict ${actual}/${expected}`)),
    ).toThrow('conflict 3/2');
  });

  it('validates retry ids', () => {
    expect(isRetryIdValid('new', 'parent')).toBe(true);
    expect(isRetryIdValid('', 'parent')).toBe(false);
    expect(isRetryIdValid('parent', 'parent')).toBe(false);
  });

  it('derives a retry result only for a fresh id', () => {
    const source = { id: 'parent', value: 7 };
    expect(() =>
      deriveRetrySpec(source, {
        parentId: 'parent',
        newId: 'parent',
        onInvalidId: () => new Error('bad id'),
        build: (src) => ({ ...src, id: 'parent' }),
      }),
    ).toThrow('bad id');
    expect(
      deriveRetrySpec(source, {
        parentId: 'parent',
        newId: 'child',
        onInvalidId: () => new Error('bad id'),
        build: (src) => ({ ...src, id: 'child', parent: src.id }),
      }),
    ).toMatchObject({ id: 'child', parent: 'parent', value: 7 });
  });
});

// 关键一致性断言：用 OpsTask 的表实例化通用 helper 后，必须与 opsTask.ts 直接导出的函数逐状态对
// 完全一致（合法/非法迁移、终态优先、错误码与错误文案）。这是"零回归"契约的机器证明。
// The pivotal parity assertion: helpers instantiated with the OpsTask table must behave exactly
// like the functions opsTask.ts exports directly, across every state pair (legal / illegal,
// terminal-first, error code and message). This is the machine-checked zero-regression contract.
describe('OpsTask table instantiated through the generic factory matches opsTask.ts directly', () => {
  const opsHelpers = createTransitionHelpers<OpsTaskState>({
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

  it('isState / isTerminalState agree with the direct exports', () => {
    const probes = [...OPS_TASK_STATES, 'nope', '', 'OPS'];
    for (const probe of probes) {
      expect(opsHelpers.isState(probe)).toBe(isOpsTaskState(probe));
    }
    for (const state of OPS_TASK_STATES) {
      expect(opsHelpers.isTerminalState(state)).toBe(isOpsTaskTerminalState(state));
    }
  });

  it('canTransition agrees with the direct export across every pair', () => {
    for (const from of OPS_TASK_STATES) {
      for (const to of OPS_TASK_STATES) {
        expect(opsHelpers.canTransition(from, to)).toBe(canTransitionOpsTaskState(from, to));
      }
    }
  });

  it('assertTransition throws the same code and message as assertOpsTaskTransition', () => {
    const capture = (fn: () => void): { code?: string; message?: string } => {
      try {
        fn();
        return {};
      } catch (error) {
        const e = error as OpsTaskError;
        return { code: e.code, message: e.message };
      }
    };
    for (const from of OPS_TASK_STATES) {
      for (const to of OPS_TASK_STATES) {
        expect(capture(() => opsHelpers.assertTransition(from, to))).toEqual(
          capture(() => assertOpsTaskTransition(from, to)),
        );
      }
    }
  });
});
