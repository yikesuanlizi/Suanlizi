import { describe, expect, it } from 'vitest';
import type { HarnessResult } from '@suanlizi/runtime';
import { HarnessRuntimeRegistry } from './harnessRuntime.js';

function harnessResult(runId: string): HarnessResult {
  return {
    status: 'satisfied',
    harnessRunId: runId,
    iterations: 1,
    finalEvaluation: null,
    evidenceCount: 0,
    items: [],
    usage: null,
  };
}

describe('HarnessRuntimeRegistry', () => {
  it('tracks a completed harness run', async () => {
    const registry = new HarnessRuntimeRegistry();
    const entry = registry.start({
      harnessRunId: 'harness-complete',
      threadId: 'thread-a',
      tenantId: 'tenant-a',
      run: async () => harnessResult('harness-complete'),
    });

    expect(entry.runtimeStatus).toBe('running');
    await expect(entry.promise).resolves.toMatchObject({ status: 'satisfied' });
    await Promise.resolve();

    expect(registry.get('harness-complete')).toMatchObject({
      runtimeStatus: 'completed',
      result: expect.objectContaining({ harnessRunId: 'harness-complete' }),
    });
    expect(registry.activeRunForThread('thread-a')).toBeUndefined();
  });

  it('cancels a running harness run with its abort signal', async () => {
    const registry = new HarnessRuntimeRegistry();
    let aborted = false;
    const entry = registry.start({
      harnessRunId: 'harness-cancel',
      threadId: 'thread-a',
      tenantId: 'tenant-a',
      run: async (signal) => new Promise<HarnessResult>((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          aborted = true;
          reject(new Error('aborted'));
        });
      }),
    });

    expect(registry.activeRunForThread('thread-a')).toBe(entry);
    expect(registry.cancel('harness-cancel')).toBe(true);
    await expect(entry.promise).rejects.toThrow('aborted');

    expect(aborted).toBe(true);
    expect(entry.runtimeStatus).toBe('cancelled');
    expect(registry.cancel('harness-cancel')).toBe(false);
  });

  it('cleans up finished runs while keeping active runs', async () => {
    const registry = new HarnessRuntimeRegistry();
    const completed = registry.start({
      harnessRunId: 'harness-old',
      threadId: 'thread-a',
      tenantId: 'tenant-a',
      run: async () => harnessResult('harness-old'),
    });
    registry.start({
      harnessRunId: 'harness-active',
      threadId: 'thread-a',
      tenantId: 'tenant-a',
      run: async () => new Promise<HarnessResult>(() => undefined),
    });

    await completed.promise;
    await Promise.resolve();
    registry.cleanup(-1);

    expect(registry.get('harness-old')).toBeUndefined();
    expect(registry.get('harness-active')).toMatchObject({ runtimeStatus: 'running' });
    registry.abortAll();
  });

  // ─── P2 取消链双写（计划 §9.2 / 盘点 §4.1）────────────────────────────────

  /** 一个永不结束、只在 abort 时 reject 的 run，并记录 abort 事件发生的顺序。 */
  function pendingRun(order: string[]) {
    return (signal: AbortSignal) => new Promise<HarnessResult>((_resolve, reject) => {
      signal.addEventListener('abort', () => {
        order.push('abort');
        reject(new Error('aborted'));
      });
    });
  }

  it('cancel() invokes interrupt before aborting the signal', async () => {
    const registry = new HarnessRuntimeRegistry();
    const order: string[] = [];
    const entry = registry.start({
      harnessRunId: 'harness-double-write',
      threadId: 'thread-a',
      tenantId: 'tenant-a',
      interrupt: () => order.push('interrupt'),
      run: pendingRun(order),
    });

    expect(registry.cancel('harness-double-write')).toBe(true);
    expect(order).toEqual(['interrupt', 'abort']);
    expect(entry.runtimeStatus).toBe('cancelled');
    await expect(entry.promise).rejects.toThrow('aborted');
    // 返回语义不变：已结束的二跳仍返回 false
    expect(registry.cancel('harness-double-write')).toBe(false);
  });

  it('cancelByThread() interrupts every running entry of the thread before abort', async () => {
    const registry = new HarnessRuntimeRegistry();
    const order: string[] = [];
    const first = registry.start({
      harnessRunId: 'harness-bt-1',
      threadId: 'thread-b',
      tenantId: 'tenant-a',
      interrupt: () => order.push('interrupt:1'),
      run: pendingRun(order),
    });
    registry.start({
      harnessRunId: 'harness-bt-2',
      threadId: 'thread-b',
      tenantId: 'tenant-a',
      interrupt: () => order.push('interrupt:2'),
      run: pendingRun(order),
    });
    // 其他 thread 的 run 不得被动
    const other = registry.start({
      harnessRunId: 'harness-bt-3',
      threadId: 'thread-c',
      tenantId: 'tenant-a',
      interrupt: () => order.push('interrupt:other'),
      run: pendingRun(order),
    });

    expect(registry.cancelByThread('thread-b')).toBe(2);
    expect(order.filter((step) => step.startsWith('interrupt')))
      .toEqual(['interrupt:1', 'interrupt:2']);
    expect(order.filter((step) => step === 'abort')).toHaveLength(2);
    // 每个条目都是先 interrupt 再 abort
    expect(order.slice(0, 2)).toEqual(['interrupt:1', 'abort']);
    expect(first.runtimeStatus).toBe('cancelled');
    expect(other.runtimeStatus).toBe('running');
    registry.abortAll();
    await Promise.allSettled([first.promise, other.promise]);
  });

  it('abortAll() interrupts running entries before aborting them', async () => {
    const registry = new HarnessRuntimeRegistry();
    const order: string[] = [];
    const entry = registry.start({
      harnessRunId: 'harness-abort-all',
      threadId: 'thread-a',
      tenantId: 'tenant-a',
      interrupt: () => order.push('interrupt'),
      run: pendingRun(order),
    });

    registry.abortAll();
    expect(order).toEqual(['interrupt', 'abort']);
    expect(entry.runtimeStatus).toBe('cancelled');
    await expect(entry.promise).rejects.toThrow('aborted');
  });

  it('still aborts when the interrupt callback throws (best-effort double write)', async () => {
    const registry = new HarnessRuntimeRegistry();
    const order: string[] = [];
    const entry = registry.start({
      harnessRunId: 'harness-interrupt-throws',
      threadId: 'thread-a',
      tenantId: 'tenant-a',
      interrupt: () => {
        order.push('interrupt');
        throw new Error('interrupt exploded');
      },
      run: pendingRun(order),
    });

    expect(registry.cancel('harness-interrupt-throws')).toBe(true);
    expect(order).toEqual(['interrupt', 'abort']);
    await expect(entry.promise).rejects.toThrow('aborted');
  });
});
