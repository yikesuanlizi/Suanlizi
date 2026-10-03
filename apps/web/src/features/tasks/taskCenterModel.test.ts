import { describe, expect, it } from 'vitest';
import type { PendingUserInput, Task, TaskPlanVersion, TaskRun, TaskRunState, TaskStatus, TaskStep } from '@suanlizi/protocol';
import {
  allowedTaskActions,
  computeStepProgress,
  countEvidence,
  countRuns,
  findActiveTask,
  formatStepProgress,
  getEmptyListText,
  getRunStateView,
  getStepEvidenceHint,
  getStepStatusView,
  getTaskActionLabel,
  getTaskStatusView,
  isActiveTask,
  isStepAwaitingEvidence,
  isTaskConflictError,
  isTaskListEmpty,
  resolveCurrentRun,
  sortTasksByUpdatedDesc,
} from './taskCenterModel.js';

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
    origin: 'harness_shadow',
    ...overrides,
  };
}

function makeStep(id: string, status: TaskStep['status']): TaskStep {
  return { id, description: `step ${id}`, status, evidenceIds: status === 'verified' ? [`ev-${id}`] : [] };
}

function makePlan(steps: TaskStep[]): TaskPlanVersion {
  return { version: 1, createdAt: '2026-09-19T00:00:00.000Z', trigger: 'init', steps };
}

describe('taskCenterModel · 状态映射', () => {
  it('Task 状态默认中文标签与 tone', () => {
    expect(getTaskStatusView('pending')).toEqual({ label: '待处理', tone: 'neutral' });
    expect(getTaskStatusView('running')).toEqual({ label: '进行中', tone: 'active' });
    expect(getTaskStatusView('blocked')).toEqual({ label: '待补充', tone: 'warning' });
    expect(getTaskStatusView('completed')).toEqual({ label: '已完成', tone: 'success' });
    expect(getTaskStatusView('failed')).toEqual({ label: '失败', tone: 'danger' });
    expect(getTaskStatusView('cancelled')).toEqual({ label: '已取消', tone: 'neutral' });
  });

  it('英文 locale 返回英文标签', () => {
    expect(getTaskStatusView('running', 'en').label).toBe('Running');
    expect(getStepStatusView('verified', 'en').label).toBe('Verified');
    expect(getRunStateView('interrupted', 'en')).toEqual({ label: 'Interrupted', tone: 'warning' });
  });

  it('步骤状态映射覆盖 claimed/verified', () => {
    expect(getStepStatusView('claimed')).toEqual({ label: '自述完成', tone: 'warning' });
    expect(getStepStatusView('verified')).toEqual({ label: '已验证', tone: 'success' });
  });
});

describe('taskCenterModel · claimed vs verified', () => {
  it('claimed 步骤标注待补证据，verified 不标注', () => {
    expect(isStepAwaitingEvidence({ status: 'claimed' })).toBe(true);
    expect(getStepEvidenceHint({ status: 'claimed' })).toBe('待补证据');
    expect(isStepAwaitingEvidence({ status: 'verified' })).toBe(false);
    expect(getStepEvidenceHint({ status: 'verified' })).toBe('');
  });
});

describe('taskCenterModel · 进度计数', () => {
  it('仅 verified 计为完成，分母为当前计划总步数', () => {
    const plan = makePlan([
      makeStep('s1', 'verified'),
      makeStep('s2', 'claimed'),
      makeStep('s3', 'in_progress'),
      makeStep('s4', 'pending'),
      makeStep('s5', 'failed'),
      makeStep('s6', 'verified'),
    ]);
    const progress = computeStepProgress(plan);
    expect(progress).toEqual({ verified: 2, total: 6, claimed: 1 });
    expect(formatStepProgress(progress)).toBe('2/6 步');
  });

  it('claimed 不计入完成，且带 claimed 计数', () => {
    const plan = makePlan([makeStep('s1', 'claimed'), makeStep('s2', 'claimed')]);
    expect(computeStepProgress(plan)).toEqual({ verified: 0, total: 2, claimed: 2 });
  });

  it('无计划时给出中性占位而非伪造 0/0', () => {
    expect(computeStepProgress(undefined)).toEqual({ verified: 0, total: 0, claimed: 0 });
    expect(formatStepProgress({ verified: 0, total: 0, claimed: 0 })).toBe('暂无计划步骤');
  });
});

describe('taskCenterModel · active 判定与查找', () => {
  it('非终态为 active，终态非 active', () => {
    expect(isActiveTask({ status: 'running' })).toBe(true);
    expect(isActiveTask({ status: 'blocked' })).toBe(true);
    expect(isActiveTask({ status: 'completed' })).toBe(false);
    expect(isActiveTask({ status: 'failed' })).toBe(false);
    expect(isActiveTask({ status: 'cancelled' })).toBe(false);
  });

  it('findActiveTask 返回最近更新的非终态任务', () => {
    const tasks = [
      makeTask({ id: 'a', status: 'completed', updatedAt: '2026-09-19T10:00:00.000Z' }),
      makeTask({ id: 'b', status: 'running', updatedAt: '2026-09-19T09:00:00.000Z' }),
      makeTask({ id: 'c', status: 'blocked', updatedAt: '2026-09-19T11:00:00.000Z' }),
    ];
    expect(findActiveTask(tasks)?.id).toBe('c');
  });

  it('全终态时 findActiveTask 返回 null', () => {
    const tasks = [makeTask({ id: 'a', status: 'failed' })];
    expect(findActiveTask(tasks)).toBeNull();
  });
});

describe('taskCenterModel · 排序与空态', () => {
  it('按 updatedAt 倒序且不修改入参', () => {
    const tasks = [
      makeTask({ id: 'old', updatedAt: '2026-09-18T00:00:00.000Z' }),
      makeTask({ id: 'new', updatedAt: '2026-09-20T00:00:00.000Z' }),
      makeTask({ id: 'mid', updatedAt: '2026-09-19T00:00:00.000Z' }),
    ];
    const sorted = sortTasksByUpdatedDesc(tasks);
    expect(sorted.map((task) => task.id)).toEqual(['new', 'mid', 'old']);
    expect(tasks.map((task) => task.id)).toEqual(['old', 'new', 'mid']);
  });

  it('空态判定与文案', () => {
    expect(isTaskListEmpty([])).toBe(true);
    expect(isTaskListEmpty(undefined)).toBe(true);
    expect(isTaskListEmpty([makeTask({ id: 'a' })])).toBe(false);
    expect(getEmptyListText()).toContain('暂无目标或动态工作流');
    expect(getEmptyListText('en')).toContain('No Goal or Dynamic Workflow yet');
  });
});

describe('taskCenterModel · 详情派生', () => {
  const run = (id: string, status: TaskRun['status'] = 'completed'): TaskRun => ({
    id,
    taskId: 'a',
    threadId: 'thread-a',
    kind: 'goal',
    status,
    updatedAt: '2026-09-19T00:00:00.000Z',
    version: 0,
  });

  it('resolveCurrentRun 命中与未命中', () => {
    const runs = [run('r1'), run('r2', 'running')];
    expect(resolveCurrentRun({ currentRunId: 'r2' }, runs)?.id).toBe('r2');
    expect(resolveCurrentRun({ currentRunId: 'missing' }, runs)).toBeNull();
    expect(resolveCurrentRun({}, runs)).toBeNull();
    expect(resolveCurrentRun({ currentRunId: 'r1' }, undefined)).toBeNull();
  });

  it('countRuns 优先用 runs，否则用 runIds；countEvidence 统计证据', () => {
    expect(countRuns({ runIds: ['r1', 'r2'] }, [run('r1')])).toBe(1);
    expect(countRuns({ runIds: ['r1', 'r2'] })).toBe(2);
    expect(countEvidence({ evidenceIds: ['e1', 'e2', 'e3'] })).toBe(3);
  });

  it('getTaskActionLabel 覆盖 7 个操作的中英文标签', () => {
    expect(getTaskActionLabel('start')).toBe('启动 Goal');
    expect(getTaskActionLabel('pause')).toBe('暂停');
    expect(getTaskActionLabel('resume')).toBe('继续');
    expect(getTaskActionLabel('cancel')).toBe('取消');
    expect(getTaskActionLabel('retry')).toBe('重试');
    expect(getTaskActionLabel('redirect')).toBe('转向');
    expect(getTaskActionLabel('input')).toBe('提交回答');
    expect(getTaskActionLabel('start', 'en')).toBe('Start Goal');
    expect(getTaskActionLabel('input', 'en')).toBe('Submit answer');
  });
});

// ─── allowedTaskActions 全矩阵（计划 §9.1 前置状态） ────────────────────────────

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

describe('taskCenterModel · allowedTaskActions 矩阵', () => {
  it('终态 Task 一律返回空集（按钮隐藏而非禁用报错）', () => {
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

  it('run paused → [resume, cancel, redirect]（§9.1 redirect 前置含 paused）', () => {
    expect(allowedTaskActions({ status: 'running', currentRunId: 'r1' }, makeRun('paused'))).toEqual([
      'resume',
      'cancel',
      'redirect',
    ]);
  });

  it('run interrupted → [resume, cancel]（非终态、不可 redirect）', () => {
    expect(allowedTaskActions({ status: 'running', currentRunId: 'r1' }, makeRun('interrupted'))).toEqual([
      'resume',
      'cancel',
    ]);
  });

  it('run blocked → [cancel]（无 pause/resume/redirect/retry）', () => {
    expect(allowedTaskActions({ status: 'running', currentRunId: 'r1' }, makeRun('blocked'))).toEqual(['cancel']);
  });

  it('run 终态且 Task 非终态 → [retry]', () => {
    for (const state of ['completed', 'failed', 'cancelled'] as TaskRunState[]) {
      expect(allowedTaskActions({ status: 'running', currentRunId: 'r1' }, makeRun(state))).toEqual(['retry']);
    }
  });

  it('Task blocked 且 pendingInput 存在 → 追加 input（由待补充卡片就近提交）', () => {
    expect(allowedTaskActions({ status: 'blocked', currentRunId: 'r1', pendingInput }, makeRun('running'))).toEqual([
      'pause',
      'cancel',
      'redirect',
      'input',
    ]);
    // 无 pendingInput 时不追加 input
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

  it('无 run 的 running/blocked Task 不含 run 相关操作（仅 start/input 分支）', () => {
    expect(allowedTaskActions({ status: 'running' }, null)).toEqual([]);
    expect(allowedTaskActions({ status: 'blocked', pendingInput }, null)).toEqual(['input']);
  });
});

describe('taskCenterModel · isTaskConflictError', () => {
  it('HTTP 409 判定为冲突', () => {
    expect(isTaskConflictError({ status: 409 })).toBe(true);
  });

  it('冲突错误码判定为冲突', () => {
    expect(isTaskConflictError({ code: 'TASK_VERSION_CONFLICT' })).toBe(true);
    expect(isTaskConflictError({ code: 'TASK_INVALID_TRANSITION' })).toBe(true);
    expect(isTaskConflictError({ code: 'TASK_TERMINAL_STATE' })).toBe(true);
  });

  it('非冲突（其它 code / status / 非对象）返回 false', () => {
    expect(isTaskConflictError({ status: 500, code: 'TASK_NOT_FOUND' })).toBe(false);
    expect(isTaskConflictError({ code: 'TASK_NOT_FOUND' })).toBe(false);
    expect(isTaskConflictError(new Error('boom'))).toBe(false);
    expect(isTaskConflictError(null)).toBe(false);
    expect(isTaskConflictError(undefined)).toBe(false);
    expect(isTaskConflictError('string-error')).toBe(false);
  });
});
