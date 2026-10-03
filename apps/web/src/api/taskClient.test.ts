import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  TaskApiError,
  cancelTask,
  fetchTask,
  fetchTaskEvidence,
  fetchTaskPlanHistory,
  fetchTaskRuns,
  fetchTasks,
  pauseTask,
  redirectTask,
  resumeTask,
  retryTask,
  startTask,
  submitTaskInput,
} from './taskClient.js';
import type { Task } from '@suanlizi/protocol';

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
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

describe('taskClient', () => {
  it('GET /api/tasks 拼接 threadId 与 status 查询并返回 tasks', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ tasks: [sampleTask] }));
    vi.stubGlobal('fetch', fetchMock);
    const result = await fetchTasks({ threadId: 'thread-1', status: ['running', 'blocked'] });
    expect(result.tasks).toHaveLength(1);
    const url = String((fetchMock.mock.calls as unknown as unknown[][])[0][0]);
    expect(url).toContain('/api/tasks?');
    expect(url).toContain('threadId=thread-1');
    expect(url).toContain('status=running%2Cblocked');
  });

  it('GET /api/tasks/:id 返回 task', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ task: sampleTask })));
    const result = await fetchTask('t1');
    expect(result.task.id).toBe('t1');
  });

  it('GET /api/tasks/:id/runs 返回 runs', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ taskId: 't1', runs: [] })));
    const result = await fetchTaskRuns('t1');
    expect(result.runs).toEqual([]);
  });

  it('GET plan-history 透传 historyIncomplete', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ taskId: 't1', versions: [], latestPlan: null, runIds: [], historyIncomplete: true })),
    );
    const result = await fetchTaskPlanHistory('t1');
    expect(result.historyIncomplete).toBe(true);
    expect(result.latestPlan).toBeNull();
  });

  it('GET evidence 返回 evidenceIds', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ taskId: 't1', evidenceIds: ['e1'] })));
    const result = await fetchTaskEvidence('t1');
    expect(result.evidenceIds).toEqual(['e1']);
  });

  it('非 2xx 抛 TaskApiError 并携带服务端 code/message', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ error: { code: 'TASK_NOT_FOUND', message: 'Task t9 was not found', details: { taskId: 't9' } } }, 404)),
    );
    await expect(fetchTask('t9')).rejects.toBeInstanceOf(TaskApiError);
    await expect(fetchTask('t9')).rejects.toMatchObject({
      status: 404,
      code: 'TASK_NOT_FOUND',
      message: 'Task t9 was not found',
    });
  });

  it('网络失败抛可操作错误而非假数据', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('network down');
    }));
    await expect(fetchTasks()).rejects.toBeInstanceOf(TaskApiError);
    await expect(fetchTasks()).rejects.toMatchObject({ status: 0, code: 'NETWORK_ERROR' });
  });

  it('非 JSON 成功响应抛解析错误', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error('not json');
      },
    } as unknown as Response)));
    await expect(fetchTasks()).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });

  describe('P2 生命周期 POST（§9.1）', () => {
    it('startTask 发 POST /api/tasks/:id/start，无 body，返回 { task, run? }', async () => {
      const fetchMock = vi.fn(async () => jsonResponse({ task: sampleTask }));
      vi.stubGlobal('fetch', fetchMock);
      const result = await startTask('t1');
      expect(result.task.id).toBe('t1');
      const [url, init] = (fetchMock.mock.calls as unknown as [string, RequestInit][])[0];
      expect(url).toBe('/api/tasks/t1/start');
      expect(init.method).toBe('POST');
      expect(init.body).toBeUndefined();
    });

    it('pause/resume/cancel/retry 各自映射到对应动作段', async () => {
      const cases: Array<[() => Promise<unknown>, string]> = [
        [() => pauseTask('t1'), 'pause'],
        [() => resumeTask('t1'), 'resume'],
        [() => cancelTask('t1'), 'cancel'],
        [() => retryTask('t1'), 'retry'],
      ];
      for (const [call, segment] of cases) {
        const fetchMock = vi.fn(async () => jsonResponse({ task: sampleTask }));
        vi.stubGlobal('fetch', fetchMock);
        await call();
        const [url, init] = (fetchMock.mock.calls as unknown as [string, RequestInit][])[0];
        expect(url).toBe(`/api/tasks/t1/${segment}`);
        expect(init.method).toBe('POST');
        vi.unstubAllGlobals();
      }
    });

    it('redirectTask 携带 JSON body { instruction } 与 Content-Type', async () => {
      const fetchMock = vi.fn(async () => jsonResponse({ task: sampleTask }));
      vi.stubGlobal('fetch', fetchMock);
      await redirectTask('t1', '改为只部署预发');
      const [url, init] = (fetchMock.mock.calls as unknown as [string, RequestInit][])[0];
      expect(url).toBe('/api/tasks/t1/redirect');
      expect(init.method).toBe('POST');
      expect(JSON.parse(String(init.body))).toEqual({ instruction: '改为只部署预发' });
      const headers = init.headers as Record<string, string>;
      expect(headers['Content-Type']).toBe('application/json');
    });

    it('submitTaskInput 携带 JSON body { answer }', async () => {
      const fetchMock = vi.fn(async () => jsonResponse({ task: sampleTask }));
      vi.stubGlobal('fetch', fetchMock);
      await submitTaskInput('t1', 'staging');
      const [url, init] = (fetchMock.mock.calls as unknown as [string, RequestInit][])[0];
      expect(url).toBe('/api/tasks/t1/input');
      expect(JSON.parse(String(init.body))).toEqual({ answer: 'staging' });
    });

    it('任务 id 经 URL 编码', async () => {
      const fetchMock = vi.fn(async () => jsonResponse({ task: sampleTask }));
      vi.stubGlobal('fetch', fetchMock);
      await startTask('a/b');
      expect((fetchMock.mock.calls as unknown as [string][])[0][0]).toBe('/api/tasks/a%2Fb/start');
    });

    it('POST 非 2xx 抛 TaskApiError 并携带服务端 code（供 409 冲突判定）', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => jsonResponse({ error: { code: 'TASK_VERSION_CONFLICT', message: '版本冲突', details: { actualVersion: 2, expectedVersion: 1 } } }, 409)),
      );
      await expect(pauseTask('t1')).rejects.toBeInstanceOf(TaskApiError);
      await expect(pauseTask('t1')).rejects.toMatchObject({
        status: 409,
        code: 'TASK_VERSION_CONFLICT',
        message: '版本冲突',
      });
    });
  });
});
