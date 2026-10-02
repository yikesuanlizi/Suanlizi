export interface BusySnapshotTurn {
  turnId: string;
  status?: string | null;
}

export interface BusySnapshotDecisionInput {
  turns: BusySnapshotTurn[];
  runtimeStatus?: string | null;
  reconcileBusy?: boolean;
  knownTurnIds?: ReadonlySet<string>;
  terminalTurnId?: string | null;
  requestEpoch?: number;
  watchEpoch?: number;
}

export interface BusySnapshotDecision {
  /** Stale reconciliation polls may merge items, but must not change lifecycle state. */
  applyLifecycle: boolean;
  busy: boolean;
  clearPreparingTurn: boolean;
}

const ACTIVE_RUNTIME_STATUSES = new Set(['running', 'stopping', 'waiting_user_input']);

/**
 * POST /turn can remain in flight after the turn has already reached storage.
 * Reconciliation uses the persisted turn list as the source of truth: once a
 * new turn exists and no turn is running, the composer must be released even
 * if the older POST response or runtime status is still stale.
 */
export function resolveSnapshotBusy(input: BusySnapshotDecisionInput): BusySnapshotDecision {
  const reconcileRequested = input.reconcileBusy === true;
  const epochCurrent = input.requestEpoch === undefined
    || input.watchEpoch === undefined
    || input.requestEpoch === input.watchEpoch;
  if (!epochCurrent) {
    return { applyLifecycle: false, busy: false, clearPreparingTurn: false };
  }

  const turns = input.turns ?? [];
  const runningTurns = turns.filter((turn) => turn.status === 'running');
  const otherRunningTurn = input.terminalTurnId
    ? runningTurns.some((turn) => turn.turnId !== input.terminalTurnId)
    : false;
  if (input.terminalTurnId && !otherRunningTurn) {
    return { applyLifecycle: true, busy: false, clearPreparingTurn: true };
  }
  if (!reconcileRequested) {
    return { applyLifecycle: true, busy: ACTIVE_RUNTIME_STATUSES.has(input.runtimeStatus ?? ''), clearPreparingTurn: false };
  }
  if (ACTIVE_RUNTIME_STATUSES.has(input.runtimeStatus ?? '')) {
    return { applyLifecycle: true, busy: true, clearPreparingTurn: false };
  }
  const knownTurnIds = input.knownTurnIds ?? new Set<string>();
  if (!turns.some((turn) => !knownTurnIds.has(turn.turnId))) {
    return { applyLifecycle: true, busy: true, clearPreparingTurn: false };
  }
  return { applyLifecycle: true, busy: false, clearPreparingTurn: true };
}
