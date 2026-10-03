// P3 §13.1 goal-status 读取服务测试：只读 task 表与 harnessState tags，tags 按不可信输入解析。
import { describe, expect, it } from 'vitest';
import { TaskError, type Task, type TaskRun } from '@suanlizi/protocol';
import { FakeTaskStore } from '../testing/fakeTaskStore.js';
import { createTaskGoalStatusService } from './taskGoalStatusService.js';

function seedTask(store: FakeTaskStore, overrides: Partial<Task> = {}): Task {
  const task: Task = {
    id: 'task-gs',
    threadId: 'thread-gs',
    objective: 'goal status',
    acceptanceCriteria: ['done'],
    status: 'running',
    runIds: ['goalrun-gs'],
    currentRunId: 'goalrun-gs',
    evidenceIds: ['ev_item_1'],
    createdAt: '2026-09-20T00:00:00.000Z',
    updatedAt: '2026-09-20T00:00:00.000Z',
    version: 0,
    origin: 'explicit_goal',
    interactionMode: 'supervised',
    ...overrides,
  };
  void store.createTask(task);
  return task;
}

function seedGoalRun(store: FakeTaskStore, harnessRunId?: string): TaskRun {
  const run: TaskRun = {
    id: 'goalrun-gs',
    taskId: 'task-gs',
    threadId: 'thread-gs',
    kind: 'goal',
    status: 'running',
    ...(harnessRunId ? { harnessRunId } : {}),
    startedAt: '2026-09-20T00:00:00.000Z',
    updatedAt: '2026-09-20T00:00:00.000Z',
    version: 0,
  };
  void store.createRun(run);
  return run;
}

function reader(tags: Record<string, string>) {
  return { getThread: async () => ({ tags }) };
}

const EVALUATION = {
  satisfied: false,
  status: 'continue',
  passedCriteria: ['已完成的一步'],
  failedCriteria: ['还差一步'],
  evidenceSummary: 'summary',
  reasoning: 'keep going',
  progressSignature: 'sig-1',
  blocker: '需要用户提供部署环境',
};

describe('createTaskGoalStatusService', () => {
  it('task 不存在 → TASK_NOT_FOUND', async () => {
    const service = createTaskGoalStatusService({ taskStore: new FakeTaskStore(), threadStore: reader({}) });
    const error = await service.readGoalStatus('missing').catch((cause) => cause);
    expect(error).toBeInstanceOf(TaskError);
    expect((error as TaskError).code).toBe('TASK_NOT_FOUND');
  });

  it('有 harnessState 时返回评估摘要、通过/未过标准与 blocker，并带上 Task 证据 id', async () => {
    const store = new FakeTaskStore();
    seedTask(store);
    seedGoalRun(store, 'hrun-1');
    const service = createTaskGoalStatusService({
      taskStore: store,
      threadStore: reader({ 'harnessState:hrun-1': JSON.stringify({ status: 'active', lastEvaluation: EVALUATION }) }),
    });
    const status = await service.readGoalStatus('task-gs');
    expect(status).toMatchObject({
      taskId: 'task-gs',
      runId: 'goalrun-gs',
      passedCriteria: ['已完成的一步'],
      failedCriteria: ['还差一步'],
      blocker: '需要用户提供部署环境',
      evidenceIds: ['ev_item_1'],
    });
    expect(status.evaluation).toMatchObject({ satisfied: false, status: 'continue' });
  });

  it('tags 缺 harnessState / JSON 非法 / 无 goal run 时如实返回空摘要，不伪造评估', async () => {
    const store = new FakeTaskStore();
    seedTask(store);
    seedGoalRun(store, 'hrun-2');
    const broken = createTaskGoalStatusService({
      taskStore: store,
      threadStore: reader({ 'harnessState:hrun-2': '{not json' }),
    });
    expect(await broken.readGoalStatus('task-gs')).toMatchObject({ runId: 'goalrun-gs', passedCriteria: [] });
    expect((await broken.readGoalStatus('task-gs')).evaluation).toBeUndefined();

    const emptyTags = createTaskGoalStatusService({ taskStore: store, threadStore: reader({}) });
    expect((await emptyTags.readGoalStatus('task-gs')).evaluation).toBeUndefined();

    const noRun = new FakeTaskStore();
    seedTask(noRun, { runIds: [], currentRunId: undefined });
    const service = createTaskGoalStatusService({ taskStore: noRun, threadStore: reader({}) });
    const status = await service.readGoalStatus('task-gs');
    expect(status.runId).toBeUndefined();
    expect(status.evidenceIds).toEqual(['ev_item_1']);
  });

  it('只有 workflow run 时不作为 goal run 返回', async () => {
    const store = new FakeTaskStore();
    seedTask(store, { runIds: [], currentRunId: undefined });
    void store.createRun({
      id: 'taskrun-wf',
      taskId: 'task-gs',
      threadId: 'thread-gs',
      kind: 'workflow',
      workflowKind: 'script',
      status: 'completed',
      startedAt: '2026-09-20T00:00:00.000Z',
      updatedAt: '2026-09-20T00:00:00.000Z',
      version: 0,
    });
    const service = createTaskGoalStatusService({ taskStore: store, threadStore: reader({}) });
    expect((await service.readGoalStatus('task-gs')).runId).toBeUndefined();
  });
});
