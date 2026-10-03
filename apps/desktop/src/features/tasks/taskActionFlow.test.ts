// runTaskAction 编排测试（无 React、无网络）：锁定成功刷新 / 409 冲突自动刷新 / 其它错误不刷新，
// 并以注入 fake api + mock fetch 覆盖 desktop 端「点击操作 → 提交 POST → 刷新」的完整链路。
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Task } from '@suanlizi/protocol';
import { TaskRequestError } from '../../api/taskClient.js';
import { runTaskAction, TASK_CONFLICT_MESSAGE } from './taskActionFlow.js';

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
}

const sampleTask: Task = {
  id: 't1',
  threadId: 'thread-1',
  objective: '示例目标',
  acceptanceCriteria: [],
  status: 'running',
  runIds: [],
  evidenceIds: [],
  createdAt: '2026-09-19T00:00:00.000Z',
  updatedAt: '2026-09-19T00:00:00.000Z',
  version: 0,
  origin: 'harness_shadow',
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('runTaskAction', () => {
  it('成功：提交一次后刷新一次，返回 ok', async () => {
    const submit = vi.fn(async () => ({ ok: true }));
    const reload = vi.fn(async () => {});
    const outcome = await runTaskAction({ submit, reload });
    expect(submit).toHaveBeenCalledTimes(1);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(outcome).toEqual({ status: 'ok' });
  });

  it('409 冲突：刷新后返回 conflict + 统一提示', async () => {
    const submit = vi.fn(async () => {
      throw new TaskRequestError('conflict', { status: 409, code: 'TASK_VERSION_CONFLICT' });
    });
    const reload = vi.fn(async () => {});
    const outcome = await runTaskAction({ submit, reload });
    expect(reload).toHaveBeenCalledTimes(1);
    expect(outcome).toEqual({ status: 'conflict', message: TASK_CONFLICT_MESSAGE });
  });

  it('非冲突错误：不刷新，返回 error + 原始 message', async () => {
    const submit = vi.fn(async () => {
      throw new TaskRequestError('server blew up', { status: 500, code: 'TASK_REQUEST_FAILED' });
    });
    const reload = vi.fn(async () => {});
    const outcome = await runTaskAction({ submit, reload });
    expect(reload).not.toHaveBeenCalled();
    expect(outcome).toEqual({ status: 'error', message: 'server blew up' });
  });
});

describe('runTaskAction · api 注入 + fetch（desktop 点击链路）', () => {
  it('submit 经 fake api.runAction 触发 POST fetch，成功后 reload 被调用一次', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ task: { ...sampleTask, status: 'paused' }, run: null }));
    vi.stubGlobal('fetch', fetchMock);

    // fake api 注入：runAction 直接走相对 /api fetch（与 defaultApi 契约一致）
    const api = {
      runAction: async (taskId: string, action: string) => {
        const response = await fetch(`/api/tasks/${encodeURIComponent(taskId)}/${action}`, { method: 'POST' });
        return (await response.json()) as { task: Task };
      },
    };
    const reload = vi.fn(async () => {});

    const outcome = await runTaskAction({
      submit: () => api.runAction('t1', 'pause'),
      reload,
    });

    expect(outcome).toEqual({ status: 'ok' });
    expect(reload).toHaveBeenCalledTimes(1);
    const [url, init] = (fetchMock.mock.calls as unknown as [string, RequestInit][])[0];
    expect(url).toBe('/api/tasks/t1/pause');
    expect(init.method).toBe('POST');
  });

  it('提交返回 409 → 视为冲突并自动 reload（刷新链路）', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ error: { code: 'TASK_VERSION_CONFLICT', message: 'version conflict' } }, 409),
    );
    vi.stubGlobal('fetch', fetchMock);

    const reload = vi.fn(async () => {});
    const outcome = await runTaskAction({
      submit: async () => {
        const response = await fetch('/api/tasks/t1/resume', { method: 'POST' });
        if (!response.ok) {
          const body = (await response.json()) as { error: { code: string; message: string } };
          throw new TaskRequestError(body.error.message, { status: response.status, code: body.error.code });
        }
        return response.json();
      },
      reload,
    });

    expect(reload).toHaveBeenCalledTimes(1);
    expect(outcome).toEqual({ status: 'conflict', message: TASK_CONFLICT_MESSAGE });
    expect(String((fetchMock.mock.calls as unknown as [string][])[0][0])).toBe('/api/tasks/t1/resume');
  });
});
