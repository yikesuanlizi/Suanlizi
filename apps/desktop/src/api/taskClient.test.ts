// desktop 任务客户端测试（无 HTTP 服务）：以 stub 全局 fetch 校验 P2 生命周期 POST 的
// URL/method/body/头，以及非 2xx 错误解析（携带稳定 code，供 isTaskConflictError 判定 409）。
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Task } from '@suanlizi/protocol';
import {
  TaskRequestError,
  cancelTask,
  getTask,
  pauseTask,
  redirectTask,
  resumeTask,
  retryTask,
  startTask,
  submitTaskInput,
} from './taskClient.js';

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
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('desktop taskClient · P2 生命周期 POST', () => {
  it('startTask 发 POST /api/tasks/:id/start，无 body，返回 { task }', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ task: { ...sampleTask, status: 'running' } }));
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

  it('redirectTask 携带 JSON body { instruction } 与 Content-Type 头', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ task: sampleTask }));
    vi.stubGlobal('fetch', fetchMock);
    await redirectTask('t1', '改为只部署预发');
    const [url, init] = (fetchMock.mock.calls as unknown as [string, RequestInit][])[0];
    expect(url).toBe('/api/tasks/t1/redirect');
    expect(JSON.parse(String(init.body))).toEqual({ instruction: '改为只部署预发' });
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
  });

  it('submitTaskInput 携带 JSON body { answer }', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ task: sampleTask }));
    vi.stubGlobal('fetch', fetchMock);
    await submitTaskInput('t1', 'staging');
    const [url, init] = (fetchMock.mock.calls as unknown as [string, RequestInit][])[0];
    expect(url).toBe('/api/tasks/t1/input');
    expect(JSON.parse(String(init.body))).toEqual({ answer: 'staging' });
  });

  it('POST 成功响应缺少 task 字段时抛 TASK_INTERNAL_ERROR', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ run: null })));
    await expect(startTask('t1')).rejects.toMatchObject({ code: 'TASK_INTERNAL_ERROR' });
  });

  it('POST 非 2xx 抛 TaskRequestError 并携带服务端 code（供 409 冲突判定）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ error: { code: 'TASK_VERSION_CONFLICT', message: '版本冲突' } }, 409)),
    );
    await expect(pauseTask('t1')).rejects.toBeInstanceOf(TaskRequestError);
    await expect(pauseTask('t1')).rejects.toMatchObject({ status: 409, code: 'TASK_VERSION_CONFLICT' });
  });

  it('空任务 id 直接抛可操作错误，不发请求', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(startTask('  ')).rejects.toMatchObject({ status: 400, code: 'TASK_REQUEST_INVALID' });
    await expect(getTask('')).rejects.toMatchObject({ code: 'TASK_REQUEST_INVALID' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
