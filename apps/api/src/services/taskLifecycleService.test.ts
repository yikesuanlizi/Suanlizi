// TaskLifecycleService 单元测试（计划 §7 P2 / §9.1 / §9.3 / §14.3）：
//   - fake agent（runHarness/resumeHarness/interrupt 计数）+ fake registry + 共享内存 FakeTaskStore；
//   - 覆盖七个生命周期操作的成功路径、非法前置（409 语义）、乐观锁冲突、事件发布；
//   - 专门断言 pause 防覆盖：abort 触发 registry 'cancelled' 后，守卫镜像不得把 paused 覆盖成 cancelled。
// 不起 HTTP 服务、不依赖 SQLite。
// — Chinese: lifecycle orchestration tests with fake agent/registry over the shared in-memory store.

import { describe, expect, it } from 'vitest';
import { TaskError, type GoalEvaluation, type Task, type TaskRun, type ThreadEvent } from '@suanlizi/protocol';
import type { HarnessResult } from '@suanlizi/runtime';
import { FakeTaskStore } from '../testing/fakeTaskStore.js';
import {
  createTaskLifecycleService,
  type TaskHarnessRegistry,
  type TaskHarnessRunHandle,
  type TaskHarnessRuntimeStatus,
  type TaskLifecycleAgent,
} from './taskLifecycleService.js';

// ─── fake registry：可控终态镜像，验证守卫行为 ──────────────────────────────

interface RegistryEntry {
  handle: TaskHarnessRunHandle;
  resolve: (value?: unknown) => void;
  controller: AbortController;
}

class FakeRegistry implements TaskHarnessRegistry {
  entries = new Map<string, RegistryEntry>();
  active?: TaskHarnessRunHandle;
  startCount = 0;
  cancelCount = 0;

  start(params: {
    harnessRunId: string;
    threadId: string;
    tenantId: string;
    run: (signal: AbortSignal) => Promise<HarnessResult>;
  }): TaskHarnessRunHandle {
    this.startCount += 1;
    let resolve!: (value?: unknown) => void;
    const promise = new Promise<unknown>((res) => {
      resolve = res;
    });
    const controller = new AbortController();
    const handle: TaskHarnessRunHandle = {
      harnessRunId: params.harnessRunId,
      threadId: params.threadId,
      runtimeStatus: 'running',
      promise,
    };
    this.entries.set(params.harnessRunId, { handle, resolve, controller });
    this.active = handle;
    // 与真实 registry 一致：执行 run 回调，令 fake agent 的计数被触发。
    void params.run(controller.signal).then(
      () => undefined,
      () => undefined,
    );
    return handle;
  }

  cancel(runId: string): boolean {
    this.cancelCount += 1;
    const entry = this.entries.get(runId);
    if (!entry) return false;
    entry.handle.runtimeStatus = 'cancelled';
    entry.controller.abort();
    entry.resolve();
    if (this.active === entry.handle) this.active = undefined;
    return true;
  }

  get(runId: string): TaskHarnessRunHandle | undefined {
    return this.entries.get(runId)?.handle;
  }

  activeRunForThread(threadId: string): TaskHarnessRunHandle | undefined {
    return this.active && this.active.threadId === threadId ? this.active : undefined;
  }

  /** 测试辅助：模拟 harness 自然结束（completed / failed）。 */
  settle(runId: string, status: TaskHarnessRuntimeStatus, error?: string): void {
    const entry = this.entries.get(runId);
    if (!entry) return;
    entry.handle.runtimeStatus = status;
    if (error) entry.handle.error = error;
    entry.resolve();
    if (this.active === entry.handle) this.active = undefined;
  }

  lastHandle(): TaskHarnessRunHandle | undefined {
    const all = [...this.entries.values()];
    return all[all.length - 1]?.handle;
  }
}

function makeFakeAgent() {
  const calls = { runHarness: 0, resumeHarness: 0, interrupt: 0 };
  const agent: TaskLifecycleAgent = {
    runHarness: () => {
      calls.runHarness += 1;
      // 永不 settle，模拟长时间运行的 goal harness（终态由 registry 决定）。
      return new Promise<HarnessResult>(() => undefined);
    },
    resumeHarness: () => {
      calls.resumeHarness += 1;
      return new Promise<HarnessResult>(() => undefined);
    },
    interrupt: () => {
      calls.interrupt += 1;
      return true;
    },
  };
  return { agent, calls };
}

const drain = () => new Promise((resolve) => setTimeout(resolve, 0));

function seedTask(store: FakeTaskStore, overrides: Partial<Task> & { id: string; threadId: string }): Task {
  const task: Task = {
    objective: 'ship goal tasks',
    acceptanceCriteria: ['api tests pass'],
    status: 'pending',
    runIds: [],
    evidenceIds: [],
    createdAt: '2026-09-19T00:00:00.000Z',
    updatedAt: '2026-09-19T00:00:00.000Z',
    version: 0,
    interactionMode: 'supervised',
    // 生命周期服务只服务于用户显式创建的 Goal；未指定时让既有正向用例保持这个语义。
    origin: 'explicit_goal',
    ...overrides,
  };
  void store.createTask(task);
  return task;
}

function seedRun(store: FakeTaskStore, overrides: Partial<TaskRun> & { id: string; taskId: string }): TaskRun {
  const run: TaskRun = {
    threadId: 'thread-1',
    kind: 'goal',
    status: 'queued',
    updatedAt: '2026-09-19T00:00:00.000Z',
    version: 0,
    ...overrides,
  };
  void store.createRun(run);
  return run;
}

function setup(deps: Partial<Pick<Parameters<typeof createTaskLifecycleService>[0], 'readGoalEvaluation'>> = {}) {
  const store = new FakeTaskStore();
  const registry = new FakeRegistry();
  const { agent, calls } = makeFakeAgent();
  const events: ThreadEvent[] = [];
  const service = createTaskLifecycleService({
    taskStore: store,
    getAgent: async () => agent,
    registry,
    publishEvent: (event) => events.push(event),
    tenantId: 'task-test',
    now: () => new Date('2026-09-19T08:00:00.000Z'),
    harnessRunIdFactory: () => `harness_${(registry.startCount).toString(36)}`,
    ...deps,
  });
  return { store, registry, agent, calls, events, service };
}

// ─── Goal 来源隔离 ───────────────────────────────────────────────────────────

describe('taskLifecycleService Goal 来源隔离', () => {
  it('Harness shadow 不能走 Goal 生命周期，也不会启动 harness', async () => {
    const { store, registry, calls, service } = setup();
    seedTask(store, { id: 'task-shadow', threadId: 'thread-1', origin: 'harness_shadow' });

    const error = await service.start('task-shadow').catch((reason) => reason);
    expect(error).toBeInstanceOf(TaskError);
    expect((error as TaskError).code).toBe('TASK_INVALID_TRANSITION');
    expect((error as TaskError).details).toMatchObject({ taskId: 'task-shadow', origin: 'harness_shadow' });
    expect(calls.runHarness).toBe(0);
    expect(calls.resumeHarness).toBe(0);
    expect(registry.startCount).toBe(0);
  });
});

// ─── start ───────────────────────────────────────────────────────────────────

describe('taskLifecycleService goal 评估事件（§13.1）', () => {
  const EVALUATION = {
    satisfied: true,
    status: 'satisfied',
    passedCriteria: ['完成一步'],
    failedCriteria: [],
    evidenceSummary: 'ok',
    reasoning: 'done',
    progressSignature: 'sig-1',
    criteriaEvidenceMap: {},
  } as unknown as GoalEvaluation;

  it('GoalRun 收口且读到 GoalEvaluation 时发 task.goal.evaluation.available', async () => {
    const asked: Array<{ taskId: string; runId: string }> = [];
    const { store, registry, events, service } = setup({
      readGoalEvaluation: async (params) => {
        asked.push(params);
        return EVALUATION;
      },
    });
    seedTask(store, { id: 'task-1', threadId: 'thread-1' });
    const started = await service.start('task-1');
    const runId = started.run?.id ?? '';

    registry.settle(registry.lastHandle()!.harnessRunId, 'completed');
    await drain();

    expect(events.map((event) => event.type)).toContain('task.run.terminal');
    const event = events.find((item) => item.type === 'task.goal.evaluation.available') as
      | Extract<ThreadEvent, { type: 'task.goal.evaluation.available' }>
      | undefined;
    expect(event).toBeDefined();
    expect(event?.taskId).toBe('task-1');
    expect(event?.runId).toBe(runId);
    expect(event?.satisfied).toBe(true);
    expect(event?.passedCriteria).toEqual(['完成一步']);
    expect(asked).toEqual([{ taskId: 'task-1', runId }]);
  });

  it('读不到评估时不发事件，但终态照旧落库', async () => {
    const { store, registry, events, service } = setup({ readGoalEvaluation: async () => null });
    seedTask(store, { id: 'task-1', threadId: 'thread-1' });
    const started = await service.start('task-1');

    registry.settle(registry.lastHandle()!.harnessRunId, 'completed');
    await drain();

    expect(events.some((event) => event.type === 'task.goal.evaluation.available')).toBe(false);
    expect((await store.getRun(started.run?.id ?? ''))?.status).toBe('completed');
  });

  it('评估读取失败只记日志，不阻断终态写入', async () => {
    const { store, registry, events, service } = setup({
      readGoalEvaluation: async () => { throw new Error('tags unreadable'); },
    });
    seedTask(store, { id: 'task-1', threadId: 'thread-1' });
    const started = await service.start('task-1');

    registry.settle(registry.lastHandle()!.harnessRunId, 'completed');
    await drain();

    expect(events.some((event) => event.type === 'task.goal.evaluation.available')).toBe(false);
    expect((await store.getRun(started.run?.id ?? ''))?.status).toBe('completed');
  });
});

describe('taskLifecycleService.start', () => {
  it('pending Task 起首个 goal Run，落 running 并起 harness + 发 updated 事件', async () => {
    const { store, registry, calls, events, service } = setup();
    seedTask(store, { id: 'task-1', threadId: 'thread-1' });

    const result = await service.start('task-1');
    expect(result.httpStatus).toBe(202);
    expect(result.task.status).toBe('running');
    expect(result.run?.status).toBe('running');
    expect(result.run?.kind).toBe('goal');
    expect(result.run?.harnessRunId).toBeTruthy();
    expect(calls.runHarness).toBe(1);
    expect(registry.startCount).toBe(1);

    const updated = events.filter((event) => event.type === 'task.run.updated');
    expect(updated).toHaveLength(1);
    expect((updated[0] as { runId: string }).runId).toBe(result.run?.id);
    expect((updated[0] as { status: string }).status).toBe('running');
  });

  it('已有非终态 Run 或 Task 非 pending 时拒绝（非法前置 409）', async () => {
    const { store, service } = setup();
    seedTask(store, { id: 'task-1', threadId: 'thread-1', status: 'running' });
    const err = await service.start('task-1').catch((error) => error);
    expect(err).toBeInstanceOf(TaskError);
    expect((err as TaskError).code).toBe('TASK_INVALID_TRANSITION');
  });

  it('乐观锁冲突映射为 TASK_VERSION_CONFLICT', async () => {
    const store = new (class extends FakeTaskStore {
      conflict = false;
      async updateTask(...args: Parameters<FakeTaskStore['updateTask']>): Promise<Task> {
        if (this.conflict) {
          throw new TaskError('TASK_VERSION_CONFLICT', 'forced conflict', { taskId: args[0] });
        }
        return super.updateTask(...args);
      }
    })();
    seedTask(store, { id: 'task-1', threadId: 'thread-1' });
    store.conflict = true;
    const { service } = (() => {
      const registry = new FakeRegistry();
      const { agent } = makeFakeAgent();
      return {
        service: createTaskLifecycleService({
          taskStore: store,
          getAgent: async () => agent,
          registry,
          publishEvent: () => undefined,
        }),
      };
    })();
    const err = await service.start('task-1').catch((error) => error);
    expect(err).toBeInstanceOf(TaskError);
    expect((err as TaskError).code).toBe('TASK_VERSION_CONFLICT');
  });
});

// ─── pause（防覆盖核心）─────────────────────────────────────────────────────

describe('taskLifecycleService.pause', () => {
  it('running → paused：先迁状态再 interrupt+abort，且不写 cancelled 终态', async () => {
    const { store, registry, calls, events, service } = setup();
    seedTask(store, { id: 'task-1', threadId: 'thread-1' });
    const started = await service.start('task-1');
    const runId = started.run!.id;
    const handle = registry.lastHandle()!;
    events.length = 0;

    const result = await service.pause('task-1', { reason: 'take a break' });
    expect(result.httpStatus).toBe(200);
    expect(result.run?.status).toBe('paused');
    expect(calls.interrupt).toBe(1);
    expect(registry.cancelCount).toBe(1);
    expect((events[0] as { type: string }).type).toBe('task.run.updated');
    expect((events[0] as { status: string }).status).toBe('paused');

    // 关键：abort 让 registry 条目变 cancelled；守卫镜像 settle 时看到 paused 必须跳过。
    await drain();
    const afterFlush = await store.getRun(runId);
    expect(afterFlush?.status).toBe('paused');
    expect(handle.runtimeStatus).toBe('cancelled'); // registry 侧确为 cancelled，但 Run 未被覆盖
    expect(events.filter((event) => event.type === 'task.run.terminal')).toHaveLength(0);
  });

  it('非 running 的 Run 不能 pause（非法前置）', async () => {
    const { store, service } = setup();
    seedTask(store, { id: 'task-1', threadId: 'thread-1', status: 'running', currentRunId: 'run-1' });
    seedRun(store, { id: 'run-1', taskId: 'task-1', status: 'paused' });
    const err = await service.pause('task-1').catch((error) => error);
    expect(err).toBeInstanceOf(TaskError);
    expect((err as TaskError).code).toBe('TASK_INVALID_TRANSITION');
  });
});

// ─── resume ──────────────────────────────────────────────────────────────────

describe('taskLifecycleService.resume', () => {
  it('paused → running 并起 resumeHarness', async () => {
    const { store, registry, calls, service } = setup();
    seedTask(store, { id: 'task-1', threadId: 'thread-1' });
    await service.start('task-1');
    await service.pause('task-1');
    expect(calls.interrupt).toBe(1);
    const before = calls.resumeHarness;

    const result = await service.resume('task-1');
    expect(result.httpStatus).toBe(202);
    expect(result.run?.status).toBe('running');
    expect(calls.resumeHarness).toBe(before + 1);
    expect(registry.startCount).toBe(2); // start + resume 各登记一次；pause 只中止当前 harness
  });

  it('running 状态不能 resume（非法前置）', async () => {
    const { store, service } = setup();
    seedTask(store, { id: 'task-1', threadId: 'thread-1' });
    await service.start('task-1');
    const err = await service.resume('task-1').catch((error) => error);
    expect(err).toBeInstanceOf(TaskError);
    expect((err as TaskError).code).toBe('TASK_INVALID_TRANSITION');
  });
});

// ─── cancel ──────────────────────────────────────────────────────────────────

describe('taskLifecycleService.cancel', () => {
  it('非终态 Run → cancelled，Task 同步 cancelled，发 terminal 事件', async () => {
    const { store, registry, calls, events, service } = setup();
    seedTask(store, { id: 'task-1', threadId: 'thread-1' });
    await service.start('task-1');
    events.length = 0;

    const result = await service.cancel('task-1', { reason: 'abort it' });
    expect(result.httpStatus).toBe(200);
    expect(result.run?.status).toBe('cancelled');
    expect(result.task.status).toBe('cancelled');
    expect(calls.interrupt).toBe(1);
    expect(registry.cancelCount).toBe(1);
    const terminal = events.filter((event) => event.type === 'task.run.terminal');
    expect(terminal).toHaveLength(1);
    expect((terminal[0] as { status: string }).status).toBe('cancelled');

    // 守卫镜像看到 cancelled 终态跳过，不产生第二次 terminal 事件。
    await drain();
    expect(events.filter((event) => event.type === 'task.run.terminal')).toHaveLength(1);
  });

  it('已终态的 current run 不能 cancel（TASK_TERMINAL_STATE）', async () => {
    const { store, service } = setup();
    seedTask(store, { id: 'task-1', threadId: 'thread-1', status: 'running', currentRunId: 'run-1' });
    seedRun(store, { id: 'run-1', taskId: 'task-1', status: 'completed' });
    const err = await service.cancel('task-1').catch((error) => error);
    expect(err).toBeInstanceOf(TaskError);
    expect((err as TaskError).code).toBe('TASK_TERMINAL_STATE');
  });
});

// ─── retry ───────────────────────────────────────────────────────────────────

describe('taskLifecycleService.retry', () => {
  it('Task running 且 current Run 终态时新建 queued→running Run', async () => {
    const { store, registry, calls, service } = setup();
    seedTask(store, { id: 'task-1', threadId: 'thread-1' });
    const started = await service.start('task-1');
    const firstRunId = started.run!.id;
    // 模拟 harness 自然完成：守卫把 Run 迁 completed，Task 保持 running（completed 不推导终态）。
    registry.settle(registry.lastHandle()!.harnessRunId, 'completed');
    await drain();
    expect((await store.getRun(firstRunId))?.status).toBe('completed');
    const runningTask = await store.getTask('task-1');
    expect(runningTask?.status).toBe('running');
    const harnessCallsBefore = calls.runHarness;

    const result = await service.retry('task-1');
    expect(result.httpStatus).toBe(202);
    expect(result.run?.id).not.toBe(firstRunId);
    expect(result.run?.status).toBe('running');
    expect(calls.runHarness).toBe(harnessCallsBefore + 1);
  });

  it('终态 Task 不得原地 retry（TASK_TERMINAL_STATE）', async () => {
    const { store, service } = setup();
    seedTask(store, { id: 'task-1', threadId: 'thread-1', status: 'cancelled' });
    const err = await service.retry('task-1').catch((error) => error);
    expect(err).toBeInstanceOf(TaskError);
    expect((err as TaskError).code).toBe('TASK_TERMINAL_STATE');
  });
});

// ─── redirect ────────────────────────────────────────────────────────────────

describe('taskLifecycleService.redirect', () => {
  it('cancel 当前 Run 并以 instruction 起新 Run，发 terminal + updated 两事件', async () => {
    const { store, registry, calls, events, service } = setup();
    seedTask(store, { id: 'task-1', threadId: 'thread-1' });
    const started = await service.start('task-1');
    const firstRunId = started.run!.id;
    events.length = 0;
    const harnessCallsBefore = calls.runHarness;

    const result = await service.redirect('task-1', { instruction: 'new direction' });
    expect(result.httpStatus).toBe(202);
    expect(result.run?.id).not.toBe(firstRunId);
    expect(result.run?.status).toBe('running');
    expect((await store.getRun(firstRunId))?.status).toBe('cancelled');
    expect(calls.runHarness).toBe(harnessCallsBefore + 1);
    expect(registry.cancelCount).toBe(1);
    // Task 不被同步成 cancelled（redirect 后仍 running，否则无法新建 Run）。
    expect(result.task.status).toBe('running');

    expect(events.map((event) => event.type)).toEqual(['task.run.terminal', 'task.run.updated']);
  });

  it('instruction 为空 / 无 running|paused Run 时拒绝', async () => {
    const { store, service } = setup();
    seedTask(store, { id: 'task-1', threadId: 'thread-1', status: 'running', currentRunId: 'run-1' });
    seedRun(store, { id: 'run-1', taskId: 'task-1', status: 'completed' });
    const err = await service.redirect('task-1', { instruction: 'x' }).catch((error) => error);
    expect(err).toBeInstanceOf(TaskError);
    expect((err as TaskError).code).toBe('TASK_INVALID_TRANSITION');
  });
});

// ─── input ───────────────────────────────────────────────────────────────────

describe('taskLifecycleService.input', () => {
  it('blocked + pendingInput 时 resolveUserInput → queued → running，answer 起跑', async () => {
    const { store, calls, events, service } = setup();
    seedTask(store, {
      id: 'task-1',
      threadId: 'thread-1',
      status: 'blocked',
      currentRunId: 'run-1',
      pendingInput: { question: 'which option?', freeText: true, askedAt: '2026-09-19T07:00:00.000Z' },
    });
    seedRun(store, { id: 'run-1', taskId: 'task-1', status: 'blocked' });
    const harnessBefore = calls.runHarness;

    const result = await service.input('task-1', { answer: 'option A' });
    expect(result.httpStatus).toBe(202);
    expect(result.run?.status).toBe('running');
    expect(result.task.status).toBe('running');
    expect(result.task.pendingInput).toBeUndefined();
    expect(calls.runHarness).toBe(harnessBefore + 1);
    expect(events.some((event) => event.type === 'task.run.updated')).toBe(true);
  });

  it('非 blocked / 无 pendingInput 时拒绝', async () => {
    const { store, service } = setup();
    seedTask(store, { id: 'task-1', threadId: 'thread-1', status: 'running', currentRunId: 'run-1' });
    seedRun(store, { id: 'run-1', taskId: 'task-1', status: 'running' });
    const err = await service.input('task-1', { answer: 'x' }).catch((error) => error);
    expect(err).toBeInstanceOf(TaskError);
    expect((err as TaskError).code).toBe('TASK_INVALID_TRANSITION');
  });

  it('answer 为空时拒绝', async () => {
    const { store, service } = setup();
    seedTask(store, {
      id: 'task-1',
      threadId: 'thread-1',
      status: 'blocked',
      currentRunId: 'run-1',
      pendingInput: { question: 'q?', freeText: true, askedAt: '2026-09-19T07:00:00.000Z' },
    });
    seedRun(store, { id: 'run-1', taskId: 'task-1', status: 'blocked' });
    const err = await service.input('task-1', { answer: '   ' }).catch((error) => error);
    expect(err).toBeInstanceOf(TaskError);
    expect((err as TaskError).code).toBe('TASK_INVALID_TRANSITION');
  });
});
