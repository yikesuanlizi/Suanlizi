// taskLifecycle 纯编排层测试：注入 fake TaskStorePort，不触碰任何存储实现。
import { describe, expect, it } from 'vitest';
import {
  TaskError,
  taskRunSchema,
  taskSchema,
  validateTaskVersion,
} from '@suanlizi/protocol';
import type {
  Task,
  TaskListFilter,
  TaskRun,
  TaskStorePort,
  WorkflowAgentCall,
  WorkflowRunRecord,
} from '@suanlizi/protocol';
import {
  applyTaskSyncFromRun,
  attachTaskEvidence,
  blockForUserInput,
  createRetryRun,
  createTaskWithRun,
  completeRun,
  findActiveTask,
  resolveUserInput,
  syncTaskFromRun,
  transitionRun,
} from './taskLifecycle.js';

// ─── fake TaskStorePort（乐观锁语义与 protocol 契约一致） ────────────────────

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

class FakeTaskStore implements TaskStorePort {
  tasks = new Map<string, Task>();
  runs = new Map<string, TaskRun>();
  updateTaskCalls = 0;
  updateRunCalls = 0;
  createRunCalls = 0;

  async createTask(task: Task): Promise<Task> {
    this.tasks.set(task.id, clone(task));
    return clone(task);
  }

  async getTask(id: string): Promise<Task | null> {
    const task = this.tasks.get(id);
    return task ? clone(task) : null;
  }

  async updateTask(
    id: string,
    patch: Partial<Omit<Task, 'id' | 'createdAt'>>,
    expectedVersion: number,
  ): Promise<Task> {
    const current = this.tasks.get(id);
    if (!current) throw new TaskError('TASK_NOT_FOUND', `task ${id} not found`, { taskId: id });
    validateTaskVersion(current.version, expectedVersion);
    if (patch.version !== undefined && patch.version !== current.version + 1) {
      throw new Error(`fake store: patch.version ${patch.version} must be ${current.version + 1}`);
    }
    const next = { ...current, ...patch } as Task;
    this.tasks.set(id, next);
    this.updateTaskCalls += 1;
    return clone(next);
  }

  async listTasks(filter?: TaskListFilter): Promise<Task[]> {
    return [...this.tasks.values()]
      .filter((task) => (filter?.threadId ? task.threadId === filter.threadId : true))
      .filter((task) => (filter?.status ? filter.status.includes(task.status) : true))
      .map((task) => clone(task));
  }

  async createRun(run: TaskRun): Promise<TaskRun> {
    this.createRunCalls += 1;
    this.runs.set(run.id, clone(run));
    return clone(run);
  }

  async getRun(id: string): Promise<TaskRun | null> {
    const run = this.runs.get(id);
    return run ? clone(run) : null;
  }

  async updateRun(
    id: string,
    patch: Partial<Omit<TaskRun, 'id' | 'taskId'>>,
    expectedVersion: number,
  ): Promise<TaskRun> {
    const current = this.runs.get(id);
    if (!current) {
      throw new TaskError('TASK_RUN_NOT_FOUND', `run ${id} not found`, { runId: id });
    }
    validateTaskVersion(current.version, expectedVersion);
    if (patch.version !== undefined && patch.version !== current.version + 1) {
      throw new Error(`fake store: patch.version ${patch.version} must be ${current.version + 1}`);
    }
    const next = { ...current, ...patch } as TaskRun;
    this.runs.set(id, next);
    this.updateRunCalls += 1;
    return clone(next);
  }

  async listRuns(taskId: string): Promise<TaskRun[]> {
    return [...this.runs.values()].filter((run) => run.taskId === taskId).map((run) => clone(run));
  }

  // Workflow 运行记录不在本波次 runtime 范围内，fake 只需满足接口形状。
  async upsertWorkflowRun(record: WorkflowRunRecord): Promise<WorkflowRunRecord> {
    return record;
  }

  async getWorkflowRun(_id: string): Promise<WorkflowRunRecord | null> {
    return null;
  }

  async listWorkflowRuns(_filter?: { goalRunId?: string }): Promise<WorkflowRunRecord[]> {
    return [];
  }

  async recordAgentCall(_runId: string, call: WorkflowAgentCall): Promise<WorkflowAgentCall> {
    return call;
  }

  async updateAgentCall(_runId: string, call: WorkflowAgentCall): Promise<WorkflowAgentCall> {
    return call;
  }

  async listAgentCalls(_runId: string): Promise<WorkflowAgentCall[]> {
    return [];
  }

  async recoverInterruptedRuns(_isLive: (run: TaskRun) => boolean): Promise<TaskRun[]> {
    return [];
  }
}

async function seed(store: FakeTaskStore = new FakeTaskStore()) {
  const { task, run } = await createTaskWithRun(store, {
    threadId: 'thread-1',
    objective: '把目标任务改造 P0 的 runtime 层落地',
    acceptanceCriteria: ['task/ 模块可运行', '测试全绿'],
    kind: 'goal',
    origin: 'explicit_goal',
    harnessRunId: 'hrun_1',
    ids: { taskId: 'task-1', runId: 'run-1' },
    now: '2026-09-19T00:00:00.000Z',
  });
  return { store, task, run };
}

async function expectTaskError(
  action: () => Promise<unknown>,
  code: ConstructorParameters<typeof TaskError>[0],
): Promise<TaskError> {
  try {
    await action();
  } catch (error) {
    expect(error).toBeInstanceOf(TaskError);
    expect((error as TaskError).code).toBe(code);
    return error as TaskError;
  }
  throw new Error(`expected TaskError(${code}) but nothing was thrown`);
}

// ─── createTaskWithRun ───────────────────────────────────────────────────────

describe('createTaskWithRun', () => {
  it('建 Task(pending, version 0) + 首个 Run(queued)，并回写 runIds/currentRunId', async () => {
    const store = new FakeTaskStore();
    const { task, run } = await createTaskWithRun(store, {
      threadId: 'thread-1',
      objective: '目标',
      acceptanceCriteria: ['标准 A', '标准 A', ' 标准 B '],
      kind: 'goal',
      origin: 'explicit_goal',
      harnessRunId: 'hrun_1',
    });

    expect(task.status).toBe('pending');
    expect(task.version).toBe(1); // 建 Task 时 0，挂上首个 Run 后 +1
    expect(task.interactionMode).toBe('supervised');
    expect(task.acceptanceCriteria).toEqual(['标准 A', '标准 B']);
    expect(task.runIds).toEqual([run.id]);
    expect(task.currentRunId).toBe(run.id);
    expect(task.completedAt).toBeUndefined();

    expect(run.status).toBe('queued');
    expect(run.version).toBe(0);
    expect(run.kind).toBe('goal');
    expect(run.harnessRunId).toBe('hrun_1');
    expect(run.workflowKind).toBeUndefined();

    // protocol zod 契约必须吃得住我们的产出
    expect(() => taskSchema.parse(task)).not.toThrow();
    expect(() => taskRunSchema.parse(run)).not.toThrow();
  });

  it('同 thread 已有非终态 Task 时抛 TASK_ACTIVE_EXISTS（先查询再建）', async () => {
    const { store, task } = await seed();
    await store.updateTask(task.id, { status: 'running', version: task.version + 1 }, task.version);

    const error = await expectTaskError(
      () =>
        createTaskWithRun(store, {
          threadId: 'thread-1',
          objective: '另一个目标',
          acceptanceCriteria: [],
          kind: 'goal',
          origin: 'explicit_goal',
        }),
      'TASK_ACTIVE_EXISTS',
    );
    expect(error.details?.taskId).toBe(task.id);
    // 未产生第二个 Task
    expect((await store.listTasks({ threadId: 'thread-1' })).length).toBe(1);
  });



  it('blocked Task 也算 active；终态 Task 不阻塞新 Task', async () => {
    const { store, task } = await seed();
    await store.updateTask(task.id, { status: 'blocked', version: task.version + 1 }, task.version);
    await expectTaskError(
      () =>
        createTaskWithRun(store, {
          threadId: 'thread-1',
          objective: '再来一个',
          acceptanceCriteria: [],
          kind: 'goal',
          origin: 'explicit_goal',
        }),
      'TASK_ACTIVE_EXISTS',
    );

    await store.updateTask(
      task.id,
      { status: 'cancelled', completedAt: '2026-09-19T01:00:00.000Z', version: task.version + 2 },
      task.version + 1,
    );
    const second = await createTaskWithRun(store, {
      threadId: 'thread-1',
      objective: '取消后允许新建',
      acceptanceCriteria: [],
      kind: 'goal',
      origin: 'explicit_goal',
      ids: { taskId: 'task-2', runId: 'run-2' },
    });
    expect(second.task.id).toBe('task-2');
    expect(await findActiveTask(store, 'thread-1')).not.toBeNull();
  });

  it('workflow kind 必须带 workflowKind；goal kind 不得带 workflow 字段（§14.8）', async () => {
    const store = new FakeTaskStore();
    await expect(
      createTaskWithRun(store, {
        threadId: 'thread-9',
        objective: '目标',
        acceptanceCriteria: [],
        kind: 'workflow',
        origin: 'explicit_workflow',
      }),
    ).rejects.toThrow(/workflowKind/);

    await expect(
      createTaskWithRun(store, {
        threadId: 'thread-9',
        objective: '目标',
        acceptanceCriteria: [],
        kind: 'goal',
          origin: 'explicit_goal',
          workflowKind: 'script',
      }),
    ).rejects.toThrow(/must not carry workflowRunId\/workflowKind/);

    const { run } = await createTaskWithRun(store, {
      threadId: 'thread-9',
      objective: '目标',
      acceptanceCriteria: [],
      kind: 'workflow',
      origin: 'explicit_workflow',
      workflowKind: 'script',
      workflowRunId: 'wfrun_1',
    });
    expect(run.kind).toBe('workflow');
    expect(run.workflowKind).toBe('script');
    expect(run.workflowRunId).toBe('wfrun_1');
    // 前两次调用在写库之前就被拒绝，因此只有第三次的 Task 落库
    expect(store.tasks.size).toBe(1);
  });

  it('objective 为空是输入错误而非协议错误', async () => {
    await expect(
      createTaskWithRun(new FakeTaskStore(), {
        threadId: 'thread-1',
        objective: '   ',
        acceptanceCriteria: [],
        kind: 'goal',
        origin: 'explicit_goal',
      }),
    ).rejects.toThrow(/objective/);
  });
});

// ─── transitionRun ──────────────────────────────────────────────────────────

describe('transitionRun', () => {
  it('queued → running 补 startedAt、写 error/checkpointId 并递增版本', async () => {
    const { store, run } = await seed();
    const next = await transitionRun(store, run.id, 'running', {
      checkpointId: '42',
      now: '2026-09-19T00:10:00.000Z',
    });

    expect(next.status).toBe('running');
    expect(next.version).toBe(1);
    expect(next.startedAt).toBe('2026-09-19T00:10:00.000Z');
    expect(next.checkpointId).toBe('42');
    expect(next.completedAt).toBeUndefined();
    expect(store.updateRunCalls).toBe(1);

    const failed = await transitionRun(store, next.id, 'failed', { error: 'boom' });
    expect(failed.error).toBe('boom');
    expect(failed.completedAt).toBeDefined();
    expect(failed.version).toBe(2);
  });

  it('非法迁移抛 TASK_INVALID_TRANSITION（queued → completed 不在迁移表里）', async () => {
    const { store, run } = await seed();
    const error = await expectTaskError(
      () => transitionRun(store, run.id, 'completed'),
      'TASK_INVALID_TRANSITION',
    );
    expect(error.details).toMatchObject({ from: 'queued', to: 'completed' });
    expect(store.updateRunCalls).toBe(0);
  });

  it('终态同标重复迁移幂等：直接返回，不二次写库', async () => {
    const { store, run } = await seed();
    const failed = await transitionRun(store, run.id, 'failed', { error: 'boom' });
    const writes = store.updateRunCalls;

    const again = await transitionRun(store, failed.id, 'failed', { error: 'boom again' });
    expect(again).toMatchObject({ status: 'failed', version: failed.version, error: 'boom' });
    expect(store.updateRunCalls).toBe(writes);
  });

  it('终态改投其他终态抛 TASK_TERMINAL_STATE', async () => {
    const { store, run } = await seed();
    await transitionRun(store, run.id, 'cancelled');
    const error = await expectTaskError(
      () => transitionRun(store, run.id, 'failed'),
      'TASK_TERMINAL_STATE',
    );
    expect(error.details).toMatchObject({ from: 'cancelled', to: 'failed' });
  });

  it('expectedVersion 不符抛 TASK_VERSION_CONFLICT，且不改 Run', async () => {
    const { store, run } = await seed();
    const error = await expectTaskError(
      () => transitionRun(store, run.id, 'running', { expectedVersion: 7 }),
      'TASK_VERSION_CONFLICT',
    );
    expect(error.details).toMatchObject({ actualVersion: 0, expectedVersion: 7 });
    expect((await store.getRun(run.id))?.status).toBe('queued');
  });

  it('未知 runId 抛 TASK_RUN_NOT_FOUND', async () => {
    await expectTaskError(
      () => transitionRun(new FakeTaskStore(), 'missing', 'running'),
      'TASK_RUN_NOT_FOUND',
    );
  });

  it('blocked → queued 是等待用户输入后的重新排队（§11.4）', async () => {
    const { store, run } = await seed();
    await transitionRun(store, run.id, 'blocked');
    const requeued = await transitionRun(store, run.id, 'queued');
    expect(requeued.status).toBe('queued');
  });
});

// ─── syncTaskFromRun（纯函数） ───────────────────────────────────────────────

describe('syncTaskFromRun', () => {
  const base: Task = {
    id: 'task-1',
    threadId: 'thread-1',
    objective: '目标',
    acceptanceCriteria: [],
    status: 'running',
    runIds: ['run-1'],
    currentRunId: 'run-1',
    origin: 'explicit_goal',
    evidenceIds: [],
    createdAt: '2026-09-19T00:00:00.000Z',
    updatedAt: '2026-09-19T00:00:00.000Z',
    version: 1,
  };

  function runWith(status: TaskRun['status']): TaskRun {
    return {
      id: 'run-1',
      taskId: 'task-1',
      threadId: 'thread-1',
      kind: 'goal',
      status,
      updatedAt: '2026-09-19T00:00:00.000Z',
      version: 0,
    };
  }

  it('failed / cancelled 推导同名终态', () => {
    expect(syncTaskFromRun(base, runWith('failed'))).toBe('failed');
    expect(syncTaskFromRun(base, runWith('cancelled'))).toBe('cancelled');
  });

  it('completed 的 Run 不推导 Task completed（验收在 P3 由 GoalTracker + Evidence gate 决定，§14.1）', () => {
    expect(syncTaskFromRun(base, runWith('completed'))).toBeNull();
  });

  it('blocked / interrupted 派生 blocked；queued / running / paused 派生 running', () => {
    expect(syncTaskFromRun(base, runWith('blocked'))).toBe('blocked');
    expect(syncTaskFromRun(base, runWith('interrupted'))).toBe('blocked');
    expect(syncTaskFromRun(base, runWith('queued'))).toBe('running');
    expect(syncTaskFromRun(base, runWith('running'))).toBe('running');
    expect(syncTaskFromRun(base, runWith('paused'))).toBe('running');
  });

  it('Task 已终态时不回退', () => {
    for (const status of ['completed', 'failed', 'cancelled'] as const) {
      const terminal = { ...base, status };
      expect(syncTaskFromRun(terminal, runWith('running'))).toBeNull();
    }
  });

  it('Run 不属于该 Task 时直接报错（防止跨 Task 串写）', () => {
    expect(() =>
      syncTaskFromRun(base, { ...runWith('failed'), taskId: 'other', id: 'run-x' }),
    ).toThrow(/does not belong/);
  });
});

describe('applyTaskSyncFromRun', () => {
  it('failed Run 把 Task 落 failed 终态并写 completedAt', async () => {
    const { store, task, run } = await seed();
    await transitionRun(store, run.id, 'running');
    const failed = await transitionRun(store, run.id, 'failed', { error: 'boom' });
    const synced = await applyTaskSyncFromRun(store, task, failed);

    expect(synced.status).toBe('failed');
    expect(synced.completedAt).toBeDefined();
    expect(synced.version).toBe(task.version + 1);
    // 幂等：再次同步不写库
    const calls = store.updateTaskCalls;
    expect((await applyTaskSyncFromRun(store, synced, failed)).status).toBe('failed');
    expect(store.updateTaskCalls).toBe(calls);
  });

  it('completed Run 不改变 Task 状态（保守推导；§14.1 验收在 P3）', async () => {
    const { store, task, run } = await seed();
    await transitionRun(store, run.id, 'running');
    const completed = await completeRun(store, run.id, {
      now: '2026-09-19T00:20:00.000Z',
    });
    const after = await applyTaskSyncFromRun(store, task, completed);
    expect(after.status).toBe(task.status);
    expect(after.version).toBe(task.version);
  });
});

// ─── completeRun（protocol 状态机无 completed 入边，本波次单点绕行） ──────────

describe('completeRun', () => {
  it('running → completed 写 completedAt 并递增版本，但不推 Task 终态', async () => {
    const { store, task, run } = await seed();
    await transitionRun(store, run.id, 'running');
    const completed = await completeRun(store, run.id, {
      now: '2026-09-19T00:30:00.000Z',
    });

    expect(completed.status).toBe('completed');
    expect(completed.version).toBe(2); // queued(0) → running(1) → completed(2)
    expect(completed.completedAt).toBe('2026-09-19T00:30:00.000Z');
    expect((await store.getTask(task.id))?.status).toBe('pending');

    // 幂等：重复完成不再写库
    const calls = store.updateRunCalls;
    const again = await completeRun(store, run.id);
    expect(again.version).toBe(2);
    expect(store.updateRunCalls).toBe(calls);
  });

  it('queued Run 拒绝完成（迁移表无 queued→completed 边）', async () => {
    const { store, run } = await seed();
    await expectTaskError(() => completeRun(store, run.id), 'TASK_INVALID_TRANSITION');
    // 先 running 再 completeRun 才是合法路径。
    await transitionRun(store, run.id, 'running');
    const forced = await completeRun(store, run.id);
    expect(forced.status).toBe('completed');
  });

  it('已是其他终态的 Run 不得改写为 completed', async () => {
    const { store, run } = await seed();
    const failed = await transitionRun(store, run.id, 'failed', { error: 'boom' });
    const error = await expectTaskError(() => completeRun(store, run.id), 'TASK_TERMINAL_STATE');
    expect(error.details?.from).toBe('failed');
    expect((await store.getRun(run.id))?.status).toBe(failed.status);
  });

  it('expectedVersion 不符时抛版本冲突且不写入', async () => {
    const { store, run } = await seed();
    await expectTaskError(
      () => completeRun(store, run.id, { expectedVersion: 99 }),
      'TASK_VERSION_CONFLICT',
    );
    expect(store.updateRunCalls).toBe(0);
  });

  it('transitionRun 支持 running → completed（协议补边后与 completeRun 等价）', async () => {
    const { store, run } = await seed();
    await transitionRun(store, run.id, 'running');
    const completed = await transitionRun(store, run.id, 'completed');
    expect(completed.status).toBe('completed');
    expect(completed.completedAt).toBeDefined();
    // 非活跃来源直落 completed 仍被拒。
    const { store: store2, run: run2 } = await seed(new FakeTaskStore());
    await expectTaskError(
      () => transitionRun(store2, run2.id, 'completed'),
      'TASK_INVALID_TRANSITION',
    );
  });
});

// ─── retry：只新建 Run ───────────────────────────────────────────────────────

describe('createRetryRun', () => {
  it('新建 queued Run 并追加 runIds，旧 Run 一字不改', async () => {
    const { store, task, run } = await seed();
    await transitionRun(store, run.id, 'running');
    await transitionRun(store, run.id, 'cancelled', { error: 'user cancelled' });
    const oldRunSnapshot = clone(await store.getRun(run.id));
    const callsBefore = store.updateRunCalls;

    const result = await createRetryRun(store, task.id, {
      ids: { runId: 'run-2' },
      harnessRunId: 'hrun_2',
      now: '2026-09-19T02:00:00.000Z',
    });

    expect(result.retriedRunId).toBe(run.id);
    expect(result.run).toMatchObject({
      id: 'run-2',
      taskId: task.id,
      kind: 'goal',
      status: 'queued',
      version: 0,
      harnessRunId: 'hrun_2',
    });
    expect(result.task.runIds).toEqual([run.id, 'run-2']);
    expect(result.task.currentRunId).toBe('run-2');
    expect(result.task.status).toBe('running'); // pending/blocked + queued run ⇒ running
    expect(store.updateRunCalls).toBe(callsBefore); // 旧 Run 未被改写
    expect(await store.getRun(run.id)).toEqual(oldRunSnapshot);
  });

  it('继承被重试 Run 的 kind/workflowKind，且不继承旧 workflowRunId', async () => {
    const store = new FakeTaskStore();
    const created = await createTaskWithRun(store, {
      threadId: 'thread-w',
      objective: '并行编排',
      acceptanceCriteria: [],
      kind: 'workflow',
      origin: 'explicit_workflow',
      workflowKind: 'blueprint',
      workflowRunId: 'wfrun_1',
      ids: { taskId: 'task-w', runId: 'run-w1' },
    });
    await transitionRun(store, created.run.id, 'failed', { error: 'x' });

    const retry = await createRetryRun(store, 'task-w');
    expect(retry.run).toMatchObject({ kind: 'workflow', workflowKind: 'blueprint', status: 'queued' });
    expect(retry.run.workflowRunId).toBeUndefined();
  });

  it('终态 Task 不能原地 retry（终态无出口），抛 TASK_TERMINAL_STATE', async () => {
    const { store, task, run } = await seed();
    await transitionRun(store, run.id, 'failed');
    const synced = await applyTaskSyncFromRun(store, task, (await store.getRun(run.id))!);
    expect(synced.status).toBe('failed');
    await expectTaskError(() => createRetryRun(store, task.id), 'TASK_TERMINAL_STATE');
  });

  it('仍有非终态 Run 时不能 retry', async () => {
    const { store, task, run } = await seed();
    await transitionRun(store, run.id, 'running');
    const error = await expectTaskError(() => createRetryRun(store, task.id), 'TASK_INVALID_TRANSITION');
    expect(error.details).toMatchObject({ runId: run.id, from: 'running' });
  });
});

// ─── PendingUserInput（§5.3） ────────────────────────────────────────────────

describe('blockForUserInput / resolveUserInput', () => {
  it('block 同时 block Run 与 Task，并落结构化问题（本地单用户无超时字段）', async () => {
    const { store, task, run } = await seed();
    await transitionRun(store, run.id, 'running');

    const blocked = await blockForUserInput(store, task, '要部署到哪个环境？', {
      options: ['staging', 'production'],
      now: '2026-09-19T03:00:00.000Z',
    });

    expect(blocked.task.status).toBe('blocked');
    expect(blocked.task.pendingInput).toMatchObject({
      question: '要部署到哪个环境？',
      options: ['staging', 'production'],
      freeText: true,
      askedAt: '2026-09-19T03:00:00.000Z',
    });
    expect(Object.keys(blocked.task.pendingInput!)).toEqual([
      'question',
      'options',
      'freeText',
      'askedAt',
    ]);
    expect((await store.getRun(run.id))?.status).toBe('blocked');
    expect(blocked.run?.status).toBe('blocked');
  });

  it('paused Run 不能直接 block（§11.4），只 block Task 层', async () => {
    const { store, task, run } = await seed();
    await transitionRun(store, run.id, 'running');
    await transitionRun(store, run.id, 'paused');

    const blocked = await blockForUserInput(store, task, '继续吗？');
    expect(blocked.task.status).toBe('blocked');
    expect(blocked.run).toBeNull();
    expect((await store.getRun(run.id))?.status).toBe('paused');
  });

  it('重复提问幂等：不再做状态迁移，只刷新问题', async () => {
    const { store, task, run } = await seed();
    const first = await blockForUserInput(store, task, '第一个问题');
    const second = await blockForUserInput(store, first.task, '改问这个');

    expect(second.task.status).toBe('blocked');
    expect(second.task.pendingInput?.question).toBe('改问这个');
    expect(second.task.version).toBe(first.task.version + 1);
    expect((await store.getRun(run.id))?.status).toBe('blocked');
  });

  it('终态 Task 不能提问', async () => {
    const { store, task, run } = await seed();
    await transitionRun(store, run.id, 'cancelled');
    const synced = await applyTaskSyncFromRun(store, task, (await store.getRun(run.id))!);
    await expectTaskError(
      () => blockForUserInput(store, synced, '还能问吗？'),
      'TASK_TERMINAL_STATE',
    );
  });

  it('resolve 默认把 blocked Run 重新排队并清空 pendingInput', async () => {
    const { store, task, run } = await seed();
    const blocked = await blockForUserInput(store, task, '选哪个？');

    const resolved = await resolveUserInput(store, blocked.task, 'production', {
      now: '2026-09-19T04:00:00.000Z',
    });

    expect(resolved.createdNewRun).toBe(false);
    expect(resolved.answer).toBe('production');
    expect(resolved.run.status).toBe('queued');
    expect(resolved.run.id).toBe(run.id);
    expect(resolved.task.status).toBe('running');
    expect(resolved.task.pendingInput).toBeUndefined();
    expect((await store.getTask(task.id))?.pendingInput).toBeUndefined();
  });

  it('Run 已终态时 resolve 走「新建 Run」路径，旧 Run 保持不变', async () => {
    const { store, task, run } = await seed();
    await transitionRun(store, run.id, 'running');
    const blocked = await blockForUserInput(store, { ...task, status: 'running' }, '需要确认');
    await transitionRun(store, run.id, 'cancelled');

    const resolved = await resolveUserInput(store, blocked.task, '算了，重来', {
      ids: { runId: 'run-new' },
    });

    expect(resolved.createdNewRun).toBe(true);
    expect(resolved.run.id).toBe('run-new');
    expect(resolved.task.status).toBe('running');
    expect(resolved.task.runIds).toEqual([run.id, 'run-new']);
    expect((await store.getRun(run.id))?.status).toBe('cancelled');
  });

  it('createNewRun=true 但旧 Run 仍 blocked（非终态）时拒绝，避免同 Task 两个活跃 Run', async () => {
    const { store, task } = await seed();
    const blocked = await blockForUserInput(store, task, '要哪个？');
    const error = await expectTaskError(
      () =>
        resolveUserInput(store, blocked.task, undefined, {
          createNewRun: true,
          ids: { runId: 'run-alt' },
        }),
      'TASK_INVALID_TRANSITION',
    );
    expect(error.details).toMatchObject({ from: 'blocked' });
    expect(store.createRunCalls).toBe(1); // 只有 seed 的首个 Run
  });

  it('非 blocked 的 Task 无可解之事', async () => {
    const { store, task } = await seed();
    const error = await expectTaskError(
      () => resolveUserInput(store, task, 'answer'),
      'TASK_INVALID_TRANSITION',
    );
    expect(error.details).toMatchObject({ from: 'pending', to: 'running' });
  });
});

// ─── Evidence 关联 ──────────────────────────────────────────────────────────

describe('attachTaskEvidence', () => {
  it('去重追加 evidenceIds，重复追加不写库', async () => {
    const { store, task } = await seed();
    const withEvidence = await attachTaskEvidence(store, task.id, ['wev_r1_c1', 'ev_i1', 'wev_r1_c1']);
    expect(withEvidence.evidenceIds).toEqual(['wev_r1_c1', 'ev_i1']);
    const calls = store.updateTaskCalls;
    const again = await attachTaskEvidence(store, task.id, ['wev_r1_c1']);
    expect(again.evidenceIds).toEqual(['wev_r1_c1', 'ev_i1']);
    expect(store.updateTaskCalls).toBe(calls);
  });
});
