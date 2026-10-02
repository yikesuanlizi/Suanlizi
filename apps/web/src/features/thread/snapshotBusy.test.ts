
import { describe, expect, it } from 'vitest';
import { resolveSnapshotBusy } from './snapshotBusy.js';

const turns = [
  { turnId: 'old', status: 'completed' },
  { turnId: 'new', status: 'completed' },
];

describe('resolveSnapshotBusy', () => {
  it('releases the composer once reconciliation finds a completed new turn', () => {
    expect(resolveSnapshotBusy({
      turns,
      runtimeStatus: 'idle',
      reconcileBusy: true,
      knownTurnIds: new Set(['old']),
      requestEpoch: 2,
      watchEpoch: 2,
    })).toEqual({ applyLifecycle: true, busy: false, clearPreparingTurn: true });
  });

  it('ignores lifecycle updates from an older request epoch', () => {
    expect(resolveSnapshotBusy({
      turns,
      runtimeStatus: 'running',
      reconcileBusy: true,
      knownTurnIds: new Set(['old']),
      requestEpoch: 2,
      watchEpoch: 3,
    })).toEqual({ applyLifecycle: false, busy: false, clearPreparingTurn: false });
  });


  it('releases busy when a terminal turn has no other running turn', () => {
    expect(resolveSnapshotBusy({
      turns,
      terminalTurnId: 'new',
      reconcileBusy: true,
      knownTurnIds: new Set(['old']),
    })).toEqual({ applyLifecycle: true, busy: false, clearPreparingTurn: true });
  });


  it('keeps normal loading tied to runtime state', () => {
    expect(resolveSnapshotBusy({ turns: [], runtimeStatus: 'idle' }).busy).toBe(false);
    expect(resolveSnapshotBusy({ turns: [], runtimeStatus: 'running' }).busy).toBe(true);
  });
});
