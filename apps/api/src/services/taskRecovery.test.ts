// startTaskRunRecovery 收口测试：确认它调用恢复扫描、按结果记日志，且吞掉底层异常。
import { describe, expect, it, vi } from 'vitest';
import type { TaskRun, TaskStorePort } from '@suanlizi/protocol';
import { startTaskRunRecovery } from './taskRecovery.js';

function storeReturning(result: TaskRun[] | Error): TaskStorePort {
  return {
    recoverInterruptedRuns: vi.fn(async () => {
      if (result instanceof Error) throw result;
      return result;
    }),
  } as unknown as TaskStorePort;
}

describe('startTaskRunRecovery', () => {
  it('被改写的 run 数 >0 时记一条日志', async () => {
    const log = vi.fn();
    const warn = vi.fn();
    const store = storeReturning([{ id: 'run-1' }, { id: 'run-2' }] as TaskRun[]);
    await startTaskRunRecovery({ taskStore: store, isLive: () => false, log, warn });
    expect(store.recoverInterruptedRuns).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('2'));
    expect(warn).not.toHaveBeenCalled();
  });

  it('无改写时不记成功日志', async () => {
    const log = vi.fn();
    const warn = vi.fn();
    await startTaskRunRecovery({ taskStore: storeReturning([]), isLive: () => false, log, warn });
    expect(log).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it('底层异常被吞掉并转成 warn，不向调用方抛出', async () => {
    const log = vi.fn();
    const warn = vi.fn();
    const promise = startTaskRunRecovery({
      taskStore: storeReturning(new Error('checkpoint read failed')),
      isLive: () => true,
      log,
      warn,
    });
    await expect(promise).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('checkpoint read failed'));
  });
});
