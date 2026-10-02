// 影子写服务测试：验证 harness run 启动/终态与 Task/TaskRun 影子镜像的一致性。
// 使用共享内存 fake TaskStorePort（带 protocol 迁移表与乐观锁校验），不起 HTTP、不依赖 SQLite。
import { describe, expect, it } from 'vitest';
import {
  attachShadowTaskTracking,
  shadowTaskForHarnessStart,
  type ShadowLogger,
  type ShadowRunObservation,
} from './taskShadowWriter.js';
import { FakeTaskStore } from '../testing/fakeTaskStore.js';

function makeLogger() {
  const warnings: string[] = [];
  const logger: ShadowLogger = { warn: (message) => warnings.push(message) };
  return { logger, warnings };
}

async function startShadow(store: FakeTaskStore, overrides: Partial<Parameters<typeof shadowTaskForHarnessStart>[0]> = {}) {
  const { logger, warnings } = makeLogger();
  const handle = await shadowTaskForHarnessStart({
    taskStore: store,
    threadId: 'thread-1',
    harnessRunId: 'harness_1',
    goal: '梳理任务系统 P0',
    acceptanceCriteria: ['能查询到 Task'],
    logger,
    ...overrides,
  });
  return { handle, logger, warnings };
}

function settleEntry(status: ShadowRunObservation['runtimeStatus'], error?: string): ShadowRunObservation & {
  resolve: () => void;
  reject: (err: unknown) => void;
} {
  let resolve!: () => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<unknown>((res, rej) => {
    resolve = () => res(undefined);
    reject = rej;
  });
  const entry: ShadowRunObservation & { resolve: () => void; reject: (err: unknown) => void } = {
    runtimeStatus: 'running',
    promise,
    resolve,
    reject,
  };
  // registry 在 promise settle 前改写 runtimeStatus
  void promise.then(
    () => { if (status === 'completed') entry.runtimeStatus = status; },
    () => { entry.runtimeStatus = status === 'failed' ? 'failed' : status; },
  );
  if (error) entry.error = error;
  return entry;
}

const flush = () => new Promise((resolvePending) => setTimeout(resolvePending, 0));

describe('shadowTaskForHarnessStart', () => {
  it('创建影子 Task+goal Run 并推进到 running', async () => {
    const store = new FakeTaskStore();
    const { handle } = await startShadow(store);
    expect(handle).not.toBeNull();
    const task = await store.getTask(handle!.taskId);
    expect(task?.status).toBe('running');
    expect(task?.objective).toBe('梳理任务系统 P0');
    expect(task?.acceptanceCriteria).toEqual(['能查询到 Task']);
    const run = await store.getRun(handle!.runId);
    expect(run?.status).toBe('running');
    expect(run?.kind).toBe('goal');
    expect(run?.harnessRunId).toBe('harness_1');
    expect(run?.workflowKind).toBeUndefined();
  });

  it('objective 取 input 回退；两者皆空时跳过且不写库', async () => {
    const store = new FakeTaskStore();
    const byInput = await startShadow(store, { goal: undefined, input: ' 用输入文本作为目标 ' });
    expect((await store.getTask(byInput.handle!.taskId))?.objective).toBe('用输入文本作为目标');

    const emptyStore = new FakeTaskStore();
    const { warnings } = await startShadow(emptyStore, { goal: undefined, input: '   ' });
    expect(warnings.length).toBe(1);
    expect(emptyStore.tasks.size).toBe(0);
    expect(emptyStore.runs.size).toBe(0);
  });

  it('遗留 active Task 的未终态 Run 被 supersede 为 cancelled 后新建 Task', async () => {
    const store = new FakeTaskStore();
    const first = await startShadow(store);
    // 模拟旧 run 未落终态就又启动新 harness：直接第二次 start。
    const second = await startShadow(store, { harnessRunId: 'harness_2', goal: '第二个目标' });
    expect(second.handle).not.toBeNull();
    const oldRun = await store.getRun(first.handle!.runId);
    expect(oldRun?.status).toBe('cancelled');
    const oldTask = await store.getTask(first.handle!.taskId);
    expect(oldTask?.status).toBe('cancelled');
    const active = await store.listTasks({ threadId: 'thread-1', status: ['running'] });
    expect(active.map((task) => task.id)).toEqual([second.handle!.taskId]);
  });

  it('影子写内部失败被吞掉：返回 null 并记 warning，不抛出', async () => {
    const store = new FakeTaskStore();
    store.createTask = async () => {
      throw new Error('db down');
    };
    const { logger, warnings } = makeLogger();
    const handle = await shadowTaskForHarnessStart({
      taskStore: store,
      threadId: 'thread-x',
      harnessRunId: 'harness_boom',
      goal: '目标',
      logger,
    });
    expect(handle).toBeNull();
    expect(warnings.some((line) => line.includes('shadow write failed'))).toBe(true);
  });
});

describe('attachShadowTaskTracking', () => {
  it('completed：Run 落 completed，Task 保守停在 running（验收在 P3）', async () => {
    const store = new FakeTaskStore();
    const { handle } = await startShadow(store);
    const entry = settleEntry('completed');
    attachShadowTaskTracking({ taskStore: store, handle: handle!, entry, logger: makeLogger().logger });
    entry.resolve();
    await flush();
    expect((await store.getRun(handle!.runId))?.status).toBe('completed');
    expect((await store.getTask(handle!.taskId))?.status).toBe('running');
  });

  it('failed：Run failed 且 Task 推导 failed', async () => {
    const store = new FakeTaskStore();
    const { handle } = await startShadow(store);
    const entry = settleEntry('failed', 'model exploded');
    attachShadowTaskTracking({ taskStore: store, handle: handle!, entry });
    entry.reject(new Error('model exploded'));
    await flush();
    const run = await store.getRun(handle!.runId);
    expect(run?.status).toBe('failed');
    expect(run?.error).toBe('model exploded');
    expect((await store.getTask(handle!.taskId))?.status).toBe('failed');
  });

  it('cancelled：Run cancelled 且 Task 推导 cancelled', async () => {
    const store = new FakeTaskStore();
    const { handle } = await startShadow(store);
    const entry = settleEntry('cancelled');
    attachShadowTaskTracking({ taskStore: store, handle: handle!, entry });
    entry.reject(new Error('aborted'));
    await flush();
    expect((await store.getRun(handle!.runId))?.status).toBe('cancelled');
    expect((await store.getTask(handle!.taskId))?.status).toBe('cancelled');
  });

  it('Run 已是终态时不重复写入（幂等）', async () => {
    const store = new FakeTaskStore();
    const { handle } = await startShadow(store);
    const before = await store.getRun(handle!.runId);
    const entry = settleEntry('completed');
    attachShadowTaskTracking({ taskStore: store, handle: handle!, entry });
    entry.resolve();
    await flush();
    // 第一次 settle 落 completed；再挂一个追踪不得再改版本。
    const after = await store.getRun(handle!.runId);
    expect(after?.status).toBe('completed');
    expect(after!.version).toBe(before!.version + 1);
    const secondEntry = settleEntry('failed', 'late failure');
    attachShadowTaskTracking({ taskStore: store, handle: handle!, entry: secondEntry });
    secondEntry.reject(new Error('late failure'));
    await flush();
    const unchanged = await store.getRun(handle!.runId);
    expect(unchanged?.status).toBe('completed');
    expect(unchanged?.version).toBe(after!.version);
  });

  it('终态同步失败只记 warning，不抛出', async () => {
    const store = new FakeTaskStore();
    const { handle } = await startShadow(store);
    // queued→completed 非法（Run 被强制退回 queued 模拟异常路径）：先把 run 状态改回 queued 不可行，
    // 改为让 updateRun 抛错。
    store.updateRun = async () => {
      throw new Error('write conflict');
    };
    const { logger, warnings } = makeLogger();
    const entry = settleEntry('completed');
    attachShadowTaskTracking({ taskStore: store, handle: handle!, entry, logger });
    entry.resolve();
    await flush();
    expect(warnings.some((line) => line.includes('shadow terminal sync failed'))).toBe(true);
  });
});
