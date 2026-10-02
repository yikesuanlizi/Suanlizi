// 浏览器任务指标聚合测试（架构文档 16.2）：事件序列折叠、空输入、元素引用
// 失效的两种来源（errors 列表与 task.failed 事件）、预算耗尽、分母为零时的
// 通过率、totalSteps 取最后一个 budget.updated
// — English: browser task metrics aggregation tests (architecture §16.2) —
//   event folding, empty input, both stale-ref sources (errors list and
//   task.failed events), budget exhaustion, zero-denominator pass rate,
//   totalSteps taken from the last budget.updated
import { describe, expect, it } from 'vitest';
import type { BrowserTaskEvent, ClassifiedError } from '@suanlizi/protocol';
import { aggregateBrowserMetrics } from './metrics.js';

const TASK_ID = 'task-metrics-1';

// 事件构造 helper（只填写聚合关心的字段）。
// — English: event factory helpers (only fields the aggregation cares about).
let seq = 0;

function created(createdAt = '2025-01-01T00:00:00.000Z'): BrowserTaskEvent {
  return { type: 'task.created', taskId: TASK_ID, goal: '指标聚合测试任务', createdAt };
}

function budgetUpdated(steps: number): BrowserTaskEvent {
  return {
    type: 'budget.updated',
    taskId: TASK_ID,
    usage: {
      steps,
      tokens: 0,
      replans: 0,
      consecutiveFailures: 0,
      externalWrites: 0,
      downloadBytes: 0,
      startedAt: Date.parse('2025-01-01T00:00:00.000Z'),
    },
    updatedAt: '2025-01-01T00:00:01.000Z',
  };
}

function completed(outcome: 'committed' | 'uncertain' | 'failed', completedAt: string): BrowserTaskEvent {
  seq += 1;
  return {
    type: 'action.completed',
    taskId: TASK_ID,
    actionId: `action-${seq}`,
    outcome,
    evidenceRefs: [],
    completedAt,
  };
}

function humanRequested(): BrowserTaskEvent {
  seq += 1;
  return {
    type: 'human.requested',
    taskId: TASK_ID,
    request: {
      requestId: `req-${seq}`,
      taskId: TASK_ID,
      type: 'confirm',
      prompt: '确认继续？',
      timeoutMs: 60_000,
      onTimeout: 'abort',
    },
  };
}

function taskFailed(failure: ClassifiedError, failedAt = '2025-01-01T00:00:07.000Z'): BrowserTaskEvent {
  return { type: 'task.failed', taskId: TASK_ID, failure, failedAt };
}

function taskCompleted(completedAt = '2025-01-01T00:01:00.000Z'): BrowserTaskEvent {
  return { type: 'task.completed', taskId: TASK_ID, completedAt };
}

function elementError(code: string): ClassifiedError {
  return { kind: 'element', code, message: `元素引用失效：${code}`, retryable: true };
}

describe('aggregateBrowserMetrics', () => {
  it('事件序列 → 各计数、verificationPassRate=0.6、approvalsRequested=2、durationMs>0', () => {
    const events: BrowserTaskEvent[] = [
      created(),
      budgetUpdated(5),
      completed('committed', '2025-01-01T00:00:02.000Z'),
      completed('committed', '2025-01-01T00:00:03.000Z'),
      completed('committed', '2025-01-01T00:00:04.000Z'),
      completed('uncertain', '2025-01-01T00:00:05.000Z'),
      completed('failed', '2025-01-01T00:00:06.000Z'),
      humanRequested(),
      humanRequested(),
      taskCompleted(),
    ];

    const m = aggregateBrowserMetrics({ taskId: TASK_ID, events });

    expect(m.taskId).toBe(TASK_ID);
    expect(m.totalSteps).toBe(5);
    expect(m.committed).toBe(3);
    expect(m.uncertain).toBe(1);
    expect(m.failed).toBe(1);
    expect(m.staleRefFailures).toBe(0);
    expect(m.verificationPassRate).toBe(0.6);
    expect(m.approvalsRequested).toBe(2);
    expect(m.budgetExceeded).toBe(false);
    expect(m.startedAt).toBe(Date.parse('2025-01-01T00:00:00.000Z'));
    expect(m.finishedAt).toBe(Date.parse('2025-01-01T00:01:00.000Z'));
    expect(m.durationMs).toBe(60_000);
    expect(m.durationMs).toBeGreaterThan(0);
  });

  it('空事件 → 全 0、passRate=1、无时间', () => {
    const m = aggregateBrowserMetrics({ taskId: TASK_ID, events: [] });

    expect(m.totalSteps).toBe(0);
    expect(m.committed).toBe(0);
    expect(m.uncertain).toBe(0);
    expect(m.failed).toBe(0);
    expect(m.staleRefFailures).toBe(0);
    expect(m.verificationPassRate).toBe(1);
    expect(m.approvalsRequested).toBe(0);
    expect(m.budgetExceeded).toBe(false);
    expect(m.startedAt).toBeUndefined();
    expect(m.finishedAt).toBeUndefined();
    expect(m.durationMs).toBeUndefined();
  });

  it('errors 中 STALE_EPOCH 与 ELEMENT_NOT_FOUND 各一 → staleRefFailures=2', () => {
    const errors: ClassifiedError[] = [elementError('STALE_EPOCH'), elementError('ELEMENT_NOT_FOUND')];

    const m = aggregateBrowserMetrics({ taskId: TASK_ID, events: [], errors });

    expect(m.staleRefFailures).toBe(2);
  });

  it('task.failed 的 failure.code=STALE_EPOCH 也可计数（事件来源）', () => {
    const events: BrowserTaskEvent[] = [taskFailed(elementError('STALE_EPOCH'))];

    const m = aggregateBrowserMetrics({ taskId: TASK_ID, events });

    expect(m.staleRefFailures).toBe(1);
  });

  it('errors 含 kind=budget → budgetExceeded=true', () => {
    const errors: ClassifiedError[] = [
      { kind: 'budget', code: 'BUDGET_EXCEEDED', message: '步骤预算耗尽', retryable: false },
    ];

    const m = aggregateBrowserMetrics({ taskId: TASK_ID, events: [], errors });

    expect(m.budgetExceeded).toBe(true);
  });

  it('task.failed 的 failure.kind=budget → budgetExceeded=true（事件来源）', () => {
    const events: BrowserTaskEvent[] = [
      taskFailed({ kind: 'budget', code: 'BUDGET_EXCEEDED', message: '步骤预算耗尽', retryable: false }),
    ];

    const m = aggregateBrowserMetrics({ taskId: TASK_ID, events });

    expect(m.budgetExceeded).toBe(true);
  });

  it('分母为 0（无动作）→ verificationPassRate=1', () => {
    const events: BrowserTaskEvent[] = [created(), humanRequested(), taskCompleted()];

    const m = aggregateBrowserMetrics({ taskId: TASK_ID, events });

    expect(m.committed).toBe(0);
    expect(m.uncertain).toBe(0);
    expect(m.failed).toBe(0);
    expect(m.verificationPassRate).toBe(1);
  });

  it('totalSteps 取最后一个 budget.updated 的 steps', () => {
    const events: BrowserTaskEvent[] = [budgetUpdated(3), budgetUpdated(7)];

    const m = aggregateBrowserMetrics({ taskId: TASK_ID, events });

    expect(m.totalSteps).toBe(7);
  });
});
