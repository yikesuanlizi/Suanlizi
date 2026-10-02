// taskCenterModel 规则断言集 —— 与 Web 端保持同一套行为契约：状态标签/色调、进度、
// claimed vs verified、active 判定、排序、空态。两端各自独立实现，此文件锁定跨端一致的行为。
import { describe, expect, it } from 'vitest';
import type { PendingUserInput, Task, TaskRun, TaskRunState, TaskStatus, TaskStep, TaskStepStatus } from '@suanlizi/protocol';
import {
  allowedTaskActions,
  computeTaskProgress,
  countTaskEvidence,
  countTaskRuns,
  detailEmptyMessage,
  formatTaskProgress,
  hasVisibleTasks,
  isStepAcceptable,
  isTaskActive,
  isTaskConflictError,
  sortTasks,
  stepStatusLabel,
  stepStatusTone,
  taskActionLabel,
  taskStatusLabel,
  taskStatusTone,
  tasksEmptyMessage,
} from './taskCenterModel.js';

function step(status: TaskStepStatus, id = `s-${status}`): TaskStep {
  return { id, description: `step ${status}`, status, evidenceIds: status === 'verified' ? ['ev-1'] : [] };
}

function makeTask(overrides: Partial<Task> & { id: string }): Task {
  return {
    threadId: `thread-${overrides.id}`,
    objective: `objective ${overrides.id}`,
    acceptanceCriteria: [],
    status: 'pending',
    runIds: [],
    evidenceIds: [],
    createdAt: '2026-09-19T00:00:00.000Z',
    updatedAt: '2026-09-19T00:00:00.000Z',
    version: 0,
    ...overrides,
  };
}

describe('taskStatusLabel / taskStatusTone', () => {
  it('六个目标层状态映射为固定中文标签', () => {
    const expected: Record<TaskStatus, string> = {
      pending: '待处理',
      running: '运行中',
      blocked: '已阻塞',
      completed: '已完成',
      failed: '失败',
      cancelled: '已取消',
    };
    (Object.keys(expected) as TaskStatus[]).forEach((status) => {
      expect(taskStatusLabel(status, true)).toBe(expected[status]);
    });
  });

  it('英文标签在 zh=false 下生效', () => {
    expect(taskStatusLabel('running', false)).toBe('Running');
    expect(taskStatusLabel('blocked', false)).toBe('Blocked');
  });

  it('状态色调：running=active、blocked=warning、completed=success、failed=danger、cancelled=muted、pending=neutral', () => {
    expect(taskStatusTone('running')).toBe('active');
    expect(taskStatusTone('blocked')).toBe('warning');
    expect(taskStatusTone('completed')).toBe('success');
    expect(taskStatusTone('failed')).toBe('danger');
    expect(taskStatusTone('cancelled')).toBe('muted');
    expect(taskStatusTone('pending')).toBe('neutral');
  });
});

describe('stepStatusLabel / stepStatusTone', () => {
  it('六个步骤态映射为固定中文标签，claimed 与 verified 文案不同', () => {
    const expected: Record<TaskStepStatus, string> = {
      pending: '待执行',
      in_progress: '进行中',
      claimed: '自述完成',
      verified: '已验证',
      failed: '失败',
      skipped: '已跳过',
    };
    (Object.keys(expected) as TaskStepStatus[]).forEach((status) => {
      expect(stepStatusLabel(status, true)).toBe(expected[status]);
    });
    expect(stepStatusLabel('claimed', true)).not.toBe(stepStatusLabel('verified', true));
  });

  it('claimed=warning（可显示不可验收）、verified=success', () => {
    expect(stepStatusTone('claimed')).toBe('warning');
    expect(stepStatusTone('verified')).toBe('success');
    expect(stepStatusTone('in_progress')).toBe('active');
    expect(stepStatusTone('skipped')).toBe('muted');
  });
});

describe('isStepAcceptable (claimed vs verified)', () => {
  it('仅 verified 计入验收；claimed 不算', () => {
    expect(isStepAcceptable('verified')).toBe(true);
    expect(isStepAcceptable('claimed')).toBe(false);
    (['pending', 'in_progress', 'failed', 'skipped'] as TaskStepStatus[]).forEach((status) => {
      expect(isStepAcceptable(status)).toBe(false);
    });
  });
});

describe('computeTaskProgress / formatTaskProgress', () => {
  it('进度 = verified / 总步数，claimed 不计入分子', () => {
    const task = makeTask({
      id: 't-progress',
      latestPlan: {
        version: 1,
        createdAt: '2026-09-19T00:00:00.000Z',
        trigger: 'init',
        steps: [step('verified'), step('claimed'), step('verified'), step('in_progress'), step('pending'), step('skipped')],
      },
    });
    expect(computeTaskProgress(task)).toEqual({ verified: 2, total: 6, empty: false });
    expect(formatTaskProgress(task, true)).toBe('2/6 步骤（基于当前计划）');
    expect(formatTaskProgress(task, false)).toBe('2/6 steps (current plan)');
  });

  it('无计划或空步骤时进度为空，文本返回 null', () => {
    expect(computeTaskProgress(makeTask({ id: 't-noplan' }))).toEqual({ verified: 0, total: 0, empty: true });
    expect(formatTaskProgress(makeTask({ id: 't-noplan' }), true)).toBeNull();
  });
});

describe('isTaskActive', () => {
  it('非终态（pending/running/blocked）为活跃，终态（completed/failed/cancelled）为非活跃', () => {
    expect(isTaskActive(makeTask({ id: 'a', status: 'pending' }))).toBe(true);
    expect(isTaskActive(makeTask({ id: 'a', status: 'running' }))).toBe(true);
    expect(isTaskActive(makeTask({ id: 'a', status: 'blocked' }))).toBe(true);
    expect(isTaskActive(makeTask({ id: 'a', status: 'completed' }))).toBe(false);
    expect(isTaskActive(makeTask({ id: 'a', status: 'failed' }))).toBe(false);
    expect(isTaskActive(makeTask({ id: 'a', status: 'cancelled' }))).toBe(false);
  });
});

describe('sortTasks', () => {
  it('活跃任务排在终态之前', () => {
    const tasks = [
      makeTask({ id: 'done', status: 'completed', updatedAt: '2026-09-19T10:00:00.000Z' }),
      makeTask({ id: 'live', status: 'running', updatedAt: '2026-09-19T01:00:00.000Z' }),
    ];
    expect(sortTasks(tasks).map((task) => task.id)).toEqual(['live', 'done']);
  });

  it('同组内按 updatedAt 倒序，越近越前', () => {
    const tasks = [
      makeTask({ id: 'older', status: 'running', updatedAt: '2026-09-19T01:00:00.000Z' }),
      makeTask({ id: 'newer', status: 'running', updatedAt: '2026-09-19T09:00:00.000Z' }),
    ];
    expect(sortTasks(tasks).map((task) => task.id)).toEqual(['newer', 'older']);
  });

  it('updatedAt 相同时按 id 升序，保证稳定与确定性', () => {
    const same = '2026-09-19T05:00:00.000Z';
    const tasks = [
      makeTask({ id: 'b', status: 'running', updatedAt: same }),
      makeTask({ id: 'a', status: 'running', updatedAt: same }),
    ];
    expect(sortTasks(tasks).map((task) => task.id)).toEqual(['a', 'b']);
  });

  it('不修改入参数组（返回新数组）', () => {
    const tasks = [makeTask({ id: 'x', status: 'completed' }), makeTask({ id: 'y', status: 'running' })];
    const original = tasks.map((task) => task.id);
    sortTasks(tasks);
    expect(tasks.map((task) => task.id)).toEqual(original);
  });
});

describe('空态与统计', () => {
  it('hasVisibleTasks 仅在非空时为 true', () => {
    expect(hasVisibleTasks([])).toBe(false);
    expect(hasVisibleTasks([makeTask({ id: 'a' })])).toBe(true);
  });

  it('空态文案为中文默认，详情空态独立', () => {
    expect(tasksEmptyMessage(true)).toContain('任务');
    expect(tasksEmptyMessage(false)).toContain('task');
    expect(detailEmptyMessage(true)).toContain('选择');
  });

  it('countTaskRuns / countTaskEvidence 反映集合长度', () => {
    const task = makeTask({ id: 'c', runIds: ['r1', 'r2'], evidenceIds: ['e1'] });
    expect(countTaskRuns(task)).toBe(2);
    expect(countTaskEvidence(task)).toBe(1);
  });

  it('taskActionLabel 覆盖 7 个操作的中英文标签（与 Web 端同一套）', () => {
    expect(taskActionLabel('start', true)).toBe('启动 Goal');
    expect(taskActionLabel('pause', true)).toBe('暂停');
    expect(taskActionLabel('resume', true)).toBe('继续');
    expect(taskActionLabel('cancel', true)).toBe('取消');
    expect(taskActionLabel('retry', true)).toBe('重试');
    expect(taskActionLabel('redirect', true)).toBe('转向');
    expect(taskActionLabel('input', true)).toBe('提交回答');
    expect(taskActionLabel('start', false)).toBe('Start Goal');
    expect(taskActionLabel('input', false)).toBe('Submit answer');
  });
});

// ─── allowedTaskActions 全矩阵（与 Web 端行为一致，计划 §9.1） ──────────────────

function makeRun(status: TaskRunState, id = 'r1'): TaskRun {
  return {
    id,
    taskId: 't1',
    threadId: 'thread-t1',
    kind: 'goal',
    status,
    updatedAt: '2026-09-19T00:00:00.000Z',
    version: 0,
  };
}

const pendingInput: PendingUserInput = {
  question: '部署到哪个环境？',
  options: ['staging', 'production'],
  freeText: true,
  askedAt: '2026-09-19T00:00:00.000Z',
};

describe('allowedTaskActions 矩阵', () => {
  it('终态 Task 一律返回空集', () => {
    for (const status of ['completed', 'failed', 'cancelled'] as TaskStatus[]) {
      expect(allowedTaskActions({ status, currentRunId: 'r1' }, makeRun('completed'))).toEqual([]);
      expect(allowedTaskActions({ status }, null)).toEqual([]);
    }
  });

  it('pending 且无 currentRun → [start]', () => {
    expect(allowedTaskActions({ status: 'pending' }, null)).toEqual(['start']);
    expect(allowedTaskActions({ status: 'pending', currentRunId: undefined }, undefined)).toEqual(['start']);
  });

  it('run queued → [cancel]', () => {
    expect(allowedTaskActions({ status: 'running', currentRunId: 'r1' }, makeRun('queued'))).toEqual(['cancel']);
  });

  it('run running → [pause, cancel, redirect]', () => {
    expect(allowedTaskActions({ status: 'running', currentRunId: 'r1' }, makeRun('running'))).toEqual([
      'pause',
      'cancel',
      'redirect',
    ]);
  });

  it('run paused → [resume, cancel, redirect]', () => {
    expect(allowedTaskActions({ status: 'running', currentRunId: 'r1' }, makeRun('paused'))).toEqual([
      'resume',
      'cancel',
      'redirect',
    ]);
  });

  it('run interrupted → [resume, cancel]', () => {
    expect(allowedTaskActions({ status: 'running', currentRunId: 'r1' }, makeRun('interrupted'))).toEqual([
      'resume',
      'cancel',
    ]);
  });

  it('run blocked → [cancel]', () => {
    expect(allowedTaskActions({ status: 'running', currentRunId: 'r1' }, makeRun('blocked'))).toEqual(['cancel']);
  });

  it('run 终态且 Task 非终态 → [retry]', () => {
    for (const state of ['completed', 'failed', 'cancelled'] as TaskRunState[]) {
      expect(allowedTaskActions({ status: 'running', currentRunId: 'r1' }, makeRun(state))).toEqual(['retry']);
    }
  });

  it('blocked + pendingInput → 追加 input', () => {
    expect(allowedTaskActions({ status: 'blocked', currentRunId: 'r1', pendingInput }, makeRun('running'))).toEqual([
      'pause',
      'cancel',
      'redirect',
      'input',
    ]);
    expect(allowedTaskActions({ status: 'blocked', currentRunId: 'r1' }, makeRun('running'))).toEqual([
      'pause',
      'cancel',
      'redirect',
    ]);
  });

  it('blocked + run 终态 + pendingInput → [retry, input]', () => {
    expect(allowedTaskActions({ status: 'blocked', currentRunId: 'r1', pendingInput }, makeRun('failed'))).toEqual([
      'retry',
      'input',
    ]);
  });

  it('无 run 的 running/blocked Task 不含 run 相关操作', () => {
    expect(allowedTaskActions({ status: 'running' }, null)).toEqual([]);
    expect(allowedTaskActions({ status: 'blocked', pendingInput }, null)).toEqual(['input']);
  });
});

describe('isTaskConflictError', () => {
  it('HTTP 409 与冲突错误码判定为冲突', () => {
    expect(isTaskConflictError({ status: 409 })).toBe(true);
    expect(isTaskConflictError({ code: 'TASK_VERSION_CONFLICT' })).toBe(true);
    expect(isTaskConflictError({ code: 'TASK_INVALID_TRANSITION' })).toBe(true);
    expect(isTaskConflictError({ code: 'TASK_TERMINAL_STATE' })).toBe(true);
  });

  it('非冲突返回 false', () => {
    expect(isTaskConflictError({ status: 500, code: 'TASK_NOT_FOUND' })).toBe(false);
    expect(isTaskConflictError({ code: 'TASK_NOT_FOUND' })).toBe(false);
    expect(isTaskConflictError(new Error('boom'))).toBe(false);
    expect(isTaskConflictError(null)).toBe(false);
    expect(isTaskConflictError('string-error')).toBe(false);
  });
});
