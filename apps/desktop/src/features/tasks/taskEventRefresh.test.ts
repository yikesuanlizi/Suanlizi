// P6：SSE 事件过滤纯函数测试（web；desktop 同构）。
import { describe, expect, it } from 'vitest';
import {
  shouldRefreshTasksFromEvent,
  shouldRefreshWorkflowRequests,
  shouldRefreshWorkflowRun,
  TASK_EVENT_REFRESH_DEBOUNCE_MS,
} from './taskEventRefresh.js';

const frame = (type: string, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ type, threadId: 'thread-1', ...extra });

describe('shouldRefreshTasksFromEvent', () => {
  it('task.* 与 workflow.* 事件触发刷新', () => {
    expect(shouldRefreshTasksFromEvent(frame('workflow.request.created', { runId: 'wfrun_1' }))).toBe(true);
    expect(shouldRefreshTasksFromEvent(frame('task.run.terminal', { runId: 'run-1' }))).toBe(true);
  });

  it('会话类事件与非法报文不触发（宁可少刷）', () => {
    expect(shouldRefreshTasksFromEvent(frame('item.completed'))).toBe(false);
    expect(shouldRefreshTasksFromEvent(frame('thread.metadata.updated'))).toBe(false);
    expect(shouldRefreshTasksFromEvent('')).toBe(false);
    expect(shouldRefreshTasksFromEvent('not json')).toBe(false);
    expect(shouldRefreshTasksFromEvent('[1,2]')).toBe(false);
    expect(shouldRefreshTasksFromEvent('{"threadId":"t"}')).toBe(false);
    expect(shouldRefreshTasksFromEvent(undefined)).toBe(false);
  });
});

describe('workflow 子集过滤', () => {
  it('待批准请求三事件才重拉 requests；批准后的进度只重拉运行结果', () => {
    expect(shouldRefreshWorkflowRequests(frame('workflow.request.created'))).toBe(true);
    expect(shouldRefreshWorkflowRequests(frame('workflow.request.approved'))).toBe(true);
    expect(shouldRefreshWorkflowRequests(frame('workflow.request.rejected'))).toBe(true);
    expect(shouldRefreshWorkflowRequests(frame('workflow.run.terminal'))).toBe(false);

    expect(shouldRefreshWorkflowRun(frame('workflow.run.updated'))).toBe(true);
    expect(shouldRefreshWorkflowRun(frame('workflow.run.terminal'))).toBe(true);
    expect(shouldRefreshWorkflowRun(frame('workflow.agent_call.terminal'))).toBe(true);
    expect(shouldRefreshWorkflowRun(frame('workflow.evidence.created'))).toBe(true);
    expect(shouldRefreshWorkflowRun(frame('workflow.agent_call.updated'))).toBe(false);
    expect(shouldRefreshWorkflowRun(frame('task.run.updated'))).toBe(false);
  });

  it('去抖窗口为正值（合并同一轮密集事件）', () => {
    expect(TASK_EVENT_REFRESH_DEBOUNCE_MS).toBeGreaterThan(0);
  });
});
