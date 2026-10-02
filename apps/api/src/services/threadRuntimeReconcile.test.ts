import { describe, expect, it, vi } from 'vitest';
import type { Checkpoint, TurnMeta } from '@suanlizi/protocol';
import { reconcileThreadRuntimeOnStartup } from './threadRuntimeReconcile.js';

function checkpoint(over: Partial<Checkpoint> = {}): Checkpoint {
  return {
    threadId: 't1',
    turnId: 'turn-1',
    itemIndex: 0,
    timestamp: '2026-09-22T00:00:00.000Z',
    generation: 1,
    status: 'running',
    executionStatus: 'running',
    ...over,
  } as Checkpoint;
}

function turn(over: Partial<TurnMeta> = {}): TurnMeta {
  return {
    turnId: 'turn-1',
    threadId: 't1',
    index: 0,
    userInput: { type: 'text', text: 'hi' },
    status: 'running',
    startedAt: '2026-09-22T00:00:00.000Z',
    completedAt: null,
    ...over,
  } as TurnMeta;
}

function storeWith(
  threads: string[],
  checkpoints: Record<string, Checkpoint | null>,
  turns: Record<string, TurnMeta[]> = {},
) {
  const saved: Array<{ threadId: string; status: unknown }> = [];
  const savedTurns: Array<{ threadId: string; turnId: string; status: string; completedAt: string | null }> = [];
  // 让 fake 真正持久化写入，这样幂等性才有意义。
  const current: Record<string, Checkpoint | null> = { ...checkpoints };
  const currentTurns: Record<string, TurnMeta[]> = {};
  for (const [threadId, rows] of Object.entries(turns)) currentTurns[threadId] = rows.map((row) => ({ ...row }));
  return {
    saved,
    savedTurns,
    store: {
      listThreads: vi.fn(async () => threads.map((threadId) => ({ threadId }))),
      getLastCheckpoint: vi.fn(async (threadId: string) => current[threadId] ?? null),
      appendCheckpoint: vi.fn(async (threadId: string, ckpt: Checkpoint) => {
        current[threadId] = ckpt;
        saved.push({ threadId, status: ckpt.status });
      }),
      getTurns: vi.fn(async (threadId: string) => currentTurns[threadId] ?? []),
      saveTurn: vi.fn(async (row: TurnMeta) => {
        const rows = currentTurns[row.threadId] ?? [];
        currentTurns[row.threadId] = rows.map((item) => (item.turnId === row.turnId ? { ...row } : item));
        savedTurns.push({
          threadId: row.threadId, turnId: row.turnId, status: row.status, completedAt: row.completedAt,
        });
      }),
    } as never,
  };
}

describe('reconcileThreadRuntimeOnStartup', () => {
  it('converges leftover running checkpoints to interrupted when no live run exists', async () => {
    const { store, saved } = storeWith(['t1'], { t1: checkpoint() });
    const report = await reconcileThreadRuntimeOnStartup({
      threadStore: store,
      isThreadLive: () => false,
      log: () => undefined,
      warn: () => undefined,
    });
    expect(report.interrupted).toBe(1);
    expect(saved).toEqual([{ threadId: 't1', status: 'interrupted' }]);
  });

  it('leaves checkpoints of live threads untouched', async () => {
    const { store, saved } = storeWith(['t1'], { t1: checkpoint() });
    const report = await reconcileThreadRuntimeOnStartup({
      threadStore: store,
      isThreadLive: () => true,
      log: () => undefined,
      warn: () => undefined,
    });
    expect(report.interrupted).toBe(0);
    expect(saved).toHaveLength(0);
  });

  it('ignores already-terminal checkpoints', async () => {
    const terminal = checkpoint({ status: 'terminal', executionStatus: 'terminal' });
    const { store, saved } = storeWith(['t1'], { t1: terminal });
    const report = await reconcileThreadRuntimeOnStartup({
      threadStore: store,
      isThreadLive: () => false,
      log: () => undefined,
      warn: () => undefined,
    });
    expect(report.interrupted).toBe(0);
    expect(saved).toHaveLength(0);
  });

  it('also converges stopping checkpoints', async () => {
    const stopping = checkpoint({ status: 'stopping', executionStatus: 'stopping' });
    const { store, saved } = storeWith(['t1'], { t1: stopping });
    const report = await reconcileThreadRuntimeOnStartup({
      threadStore: store,
      isThreadLive: () => false,
      log: () => undefined,
      warn: () => undefined,
    });
    expect(report.interrupted).toBe(1);
    expect(saved[0].status).toBe('interrupted');
  });

  it('is idempotent: a second run changes nothing', async () => {
    const { store, saved } = storeWith(['t1'], { t1: checkpoint() });
    await reconcileThreadRuntimeOnStartup({ threadStore: store, isThreadLive: () => false, log: () => undefined, warn: () => undefined });
    const first = saved.length;
    const second = await reconcileThreadRuntimeOnStartup({ threadStore: store, isThreadLive: () => false, log: () => undefined, warn: () => undefined });
    expect(first).toBe(1);
    expect(second.interrupted).toBe(0);
    expect(second.turnsInterrupted).toBe(0);
  });
  it('also converges leftover running turn rows so snapshots stop reporting 进行中', async () => {
    const { store, savedTurns } = storeWith(
      ['t1'],
      { t1: checkpoint() },
      { t1: [turn({ turnId: 'turn-done', status: 'completed' }), turn({ turnId: 'turn-stuck', status: 'running' })] },
    );
    const report = await reconcileThreadRuntimeOnStartup({
      threadStore: store, isThreadLive: () => false, log: () => undefined, warn: () => undefined,
    });
    expect(report.turnsInterrupted).toBe(1);
    expect(savedTurns).toHaveLength(1);
    expect(savedTurns[0]).toMatchObject({ threadId: 't1', turnId: 'turn-stuck', status: 'interrupted' });
    expect(savedTurns[0].completedAt).toBeTruthy();
  });

  it('honours the injected completedAt when converging turn rows', async () => {
    const fixed = '2026-06-10T10:00:00.000Z';
    const { store, savedTurns } = storeWith(
      ['t1'], { t1: checkpoint() }, { t1: [turn({ turnId: 'turn-stuck' })] },
    );
    await reconcileThreadRuntimeOnStartup({
      threadStore: store, isThreadLive: () => false, completedAt: fixed, log: () => undefined, warn: () => undefined,
    });
    expect(savedTurns[0].completedAt).toBe(fixed);
  });

  it('does not touch turn rows of live threads', async () => {
    const { store, savedTurns } = storeWith(
      ['t1'], { t1: checkpoint() }, { t1: [turn({ status: 'running' })] },
    );
    const report = await reconcileThreadRuntimeOnStartup({
      threadStore: store, isThreadLive: () => true, log: () => undefined, warn: () => undefined,
    });
    expect(report.turnsInterrupted).toBe(0);
    expect(savedTurns).toHaveLength(0);
  });

  it('keeps waiting_user_input checkpoints so a cold start can still resume them', async () => {
    const waiting = checkpoint({ status: 'waiting_user_input', executionStatus: 'waiting_user_input' });
    const { store, saved } = storeWith(['t1'], { t1: waiting });
    const report = await reconcileThreadRuntimeOnStartup({
      threadStore: store, isThreadLive: () => false, log: () => undefined, warn: () => undefined,
    });
    expect(report.interrupted).toBe(0);
    expect(saved).toHaveLength(0);
  });
});
