// runTaskAction 编排测试（无 React、无网络）：锁定「成功刷新 / 409 冲突自动刷新 / 其它错误不刷新」三条路径。
// 这是两端抽屉/容器共用的操作内核，点击→提交→刷新的行为在此以注入 spy 覆盖。
import { describe, expect, it, vi } from 'vitest';
import { TaskApiError } from '../../api/taskClient.js';
import { runTaskAction, TASK_CONFLICT_MESSAGE } from './taskActionFlow.js';

describe('runTaskAction', () => {
  it('成功：提交一次后刷新一次，返回 ok', async () => {
    const submit = vi.fn(async () => ({ ok: true }));
    const reload = vi.fn(async () => {});
    const outcome = await runTaskAction({ submit, reload });
    expect(submit).toHaveBeenCalledTimes(1);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(outcome).toEqual({ status: 'ok' });
  });

  it('409 冲突（status=409）：刷新并重载后返回 conflict + 统一提示', async () => {
    const submit = vi.fn(async () => {
      throw new TaskApiError('conflict', 409, 'TASK_VERSION_CONFLICT');
    });
    const reload = vi.fn(async () => {});
    const outcome = await runTaskAction({ submit, reload });
    expect(reload).toHaveBeenCalledTimes(1);
    expect(outcome).toEqual({ status: 'conflict', message: TASK_CONFLICT_MESSAGE });
  });

  it('前置不符（code=TASK_INVALID_TRANSITION）也按冲突刷新', async () => {
    const submit = vi.fn(async () => {
      throw new TaskApiError('invalid transition', 409, 'TASK_INVALID_TRANSITION');
    });
    const reload = vi.fn(async () => {});
    const outcome = await runTaskAction({ submit, reload });
    expect(reload).toHaveBeenCalledTimes(1);
    expect(outcome.status).toBe('conflict');
  });

  it('非冲突错误：不刷新，返回 error + 原始 message', async () => {
    const submit = vi.fn(async () => {
      throw new TaskApiError('server blew up', 500, 'TASK_REQUEST_FAILED');
    });
    const reload = vi.fn(async () => {});
    const outcome = await runTaskAction({ submit, reload });
    expect(reload).not.toHaveBeenCalled();
    expect(outcome).toEqual({ status: 'error', message: 'server blew up' });
  });

  it('非 Error 抛出时以 String(error) 承载 message', async () => {
    const submit = vi.fn(async () => {
      throw 'plain-string-failure';
    });
    const outcome = await runTaskAction({ submit, reload: async () => {} });
    expect(outcome).toEqual({ status: 'error', message: 'plain-string-failure' });
  });
});
