// 影子写期对账测试（计划 §14.6）：验证「只读 thread.tags、只写 task 表、幂等、不复活终态」。
// 使用内存 fake threadStore + 共享的 fake TaskStorePort（apps/api/src/testing/fakeTaskStore.ts），
// 不起 HTTP 服务、不依赖 SQLite。
import { describe, expect, it } from 'vitest';
import type { Checkpoint, ThreadMeta } from '@suanlizi/protocol';
import { GoalTracker } from '@suanlizi/runtime';
import { FakeTaskStore } from '../testing/fakeTaskStore.js';
import {
  ACTIVE_HARNESS_RUN_ID_TAG,
  HARNESS_STATE_TAG_PREFIX,
  deriveDesiredRunState,
  findTransitionPath,
  harnessStateTagKey,
  reconcileTasksFromTags,
  type ReconcileReport,
} from './taskReconcile.js';

const NOW = '2026-09-19T10:00:00.000Z';

function makeThreadMeta(threadId: string, tags: Record<string, string>): ThreadMeta {
  return {
    threadId,
    title: `thread ${threadId}`,
    workspaceRoot: '/tmp/suanlizi-test',
    status: 'active',
    turnCount: 1,
    createdAt: NOW,
    updatedAt: NOW,
    archivedAt: null,
    ephemeral: false,
    tags,
  };
}

/**
 * 内存 fake 线程存储：读方法满足对账所需的 `ReconcileThreadStore` 形状，
 * 同时**故意保留** `updateThreadMetadata` / `appendItems` 写方法并记录调用次数 ——
 * 用例据此断言对账从未改写 tags。
 */
class FakeThreadStore {
  threads = new Map<string, ThreadMeta>();
  checkpoints = new Map<string, Checkpoint | null>();
  writeCalls: string[] = [];

  addThread(threadId: string, tags: Record<string, string> = {}): void {
    this.threads.set(threadId, makeThreadMeta(threadId, tags));
  }

  setCheckpoint(threadId: string, checkpoint: Checkpoint | null): void {
    this.checkpoints.set(threadId, checkpoint);
  }

  tagsSnapshot(): Record<string, Record<string, string>> {
    const snapshot: Record<string, Record<string, string>> = {};
    for (const [threadId, meta] of [...this.threads.entries()].sort((a, b) =>
      a[0] < b[0] ? -1 : 1,
    )) {
      snapshot[threadId] = { ...(meta.tags ?? {}) };
    }
    return snapshot;
  }

  async getThread(threadId: string): Promise<ThreadMeta | null> {
    const meta = this.threads.get(threadId);
    return meta ? structuredClone(meta) : null;
  }

  async getLastCheckpoint(threadId: string): Promise<Checkpoint | null> {
    return this.checkpoints.get(threadId) ?? null;
  }

  // ─── 以下写方法不属于对账的注入面；保留只为断言「零调用」 ──────────────────
  async updateThreadMetadata(threadId: string, patch: { tags?: Record<string, string> }): Promise<void> {
    this.writeCalls.push(`updateThreadMetadata:${threadId}`);
    const meta = this.threads.get(threadId);
    if (meta && patch.tags) this.threads.set(threadId, { ...meta, tags: patch.tags });
  }

  async appendItems(threadId: string): Promise<void> {
    this.writeCalls.push(`appendItems:${threadId}`);
  }
}

/** 构造 harnessState:* 标签值（形态与 runtime/harness/goalTracker.ts 的 HarnessState 一致）。 */
function harnessStateJson(input: {
  runId: string;
  status: string;
  objective?: string;
  criteria?: string[];
  blocker?: string;
  updatedAt?: string;
}): string {
  return JSON.stringify({
    harnessRunId: input.runId,
    goal: {
      objective: input.objective ?? '梳理任务系统 P0',
      acceptanceCriteria: input.criteria ?? ['能查询到 Task'],
      maxContinuations: 8,
      maxNoProgress: 2,
    },
    plan: [],
    activeNodeId: null,
    iteration: 1,
    noProgressCount: 0,
    lastEvaluation: input.blocker
      ? {
          satisfied: false,
          status: 'blocked',
          passedCriteria: [],
          failedCriteria: [],
          blocker: input.blocker,
          evidenceSummary: '',
          progressSignature: 'sig',
          reasoning: '',
        }
      : null,
    lastProgressSignature: 'sig',
    status: input.status,
    startedAt: '2026-09-19T09:00:00.000Z',
    updatedAt: input.updatedAt ?? '2026-09-19T09:30:00.000Z',
  });
}

function harnessTags(input: {
  runId: string;
  status: string;
  active?: boolean;
  objective?: string;
  criteria?: string[];
  blocker?: string;
  updatedAt?: string;
  extra?: Record<string, string>;
}): Record<string, string> {
  return {
    [harnessStateTagKey(input.runId)]: harnessStateJson(input),
    [ACTIVE_HARNESS_RUN_ID_TAG]: input.active === false ? '' : input.runId,
    ...(input.extra ?? {}),
  };
}

function runningCheckpoint(threadId: string, turnId = '7'): Checkpoint {
  return {
    threadId,
    turnId,
    itemIndex: 3,
    timestamp: NOW,
    status: 'running',
    executionStatus: 'running',
    expiresAt: '2099-01-01T00:00:00.000Z',
  };
}

async function reconcile(
  threads: FakeThreadStore,
  taskStore: FakeTaskStore,
  overrides: { isLive?: (input: { threadId: string; harnessRunId: string }) => boolean } = {},
) {
  const warnings: string[] = [];
  const report = await reconcileTasksFromTags({
    threadStore: threads,
    taskStore,
    listThreads: async () => [...threads.threads.values()],
    now: NOW,
    logger: { warn: (message) => warnings.push(message) },
    ...overrides,
  });
  return { report, warnings };
}

function itemFor(report: ReconcileReport, harnessRunId: string) {
  const items = report.items.filter((item) => item.harnessRunId === harnessRunId);
  expect(items.length).toBe(1);
  return items[0];
}

async function runOfTaskStore(taskStore: FakeTaskStore, harnessRunId: string) {
  const runs = [...taskStore.runs.values()].filter((run) => run.harnessRunId === harnessRunId);
  expect(runs.length).toBe(1);
  return runs[0];
}

describe('reconcileTasksFromTags —— 缺失补建', () => {
  it('active harness + 未过期 running checkpoint → 建 goal Task/Run 并推进到 running', async () => {
    const threads = new FakeThreadStore();
    threads.addThread('t1', harnessTags({ runId: 'h1', status: 'active' }));
    threads.setCheckpoint('t1', runningCheckpoint('t1'));
    const taskStore = new FakeTaskStore();

    const { report } = await reconcile(threads, taskStore);

    expect(report.created).toBe(1);
    expect(report.updated).toBe(0);
    expect(report.conflicts).toBe(0);
    expect(itemFor(report, 'h1').reason).toBe('missing-task-run');

    const run = await runOfTaskStore(taskStore, 'h1');
    expect(run.kind).toBe('goal');
    expect(run.workflowKind).toBeUndefined();
    expect(run.status).toBe('running');
    expect(run.harnessRunId).toBe('h1');
    expect(run.checkpointId).toBe('7');
    expect(run.startedAt).toBe(NOW);

    const task = await taskStore.getTask(run.taskId);
    expect(task?.objective).toBe('梳理任务系统 P0');
    expect(task?.acceptanceCriteria).toEqual(['能查询到 Task']);
    expect(task?.status).toBe('running');
    expect(task?.currentRunId).toBe(run.id);
    expect(task?.threadId).toBe('t1');
  });

  it('harness satisfied → task run completed（补建也沿迁移表 queued→running→completed）', async () => {
    const threads = new FakeThreadStore();
    threads.addThread('t1', harnessTags({ runId: 'h1', status: 'satisfied', active: false }));
    const taskStore = new FakeTaskStore();

    const { report } = await reconcile(threads, taskStore);

    expect(report.created).toBe(1);
    const run = await runOfTaskStore(taskStore, 'h1');
    expect(run.status).toBe('completed');
    expect(run.completedAt).toBe(NOW);
  });

  it('harness blocked → task run blocked 并带 blocker 原因', async () => {
    const threads = new FakeThreadStore();
    threads.addThread(
      't1',
      harnessTags({ runId: 'h1', status: 'blocked', active: false, blocker: '需要用户确认部署环境' }),
    );
    const taskStore = new FakeTaskStore();

    await reconcile(threads, taskStore);

    const run = await runOfTaskStore(taskStore, 'h1');
    expect(run.status).toBe('blocked');
    expect(run.error).toContain('需要用户确认部署环境');
    expect((await taskStore.getTask(run.taskId))?.status).toBe('blocked');
  });

  it('checkpoint 缺失且非活跃 run → interrupted（崩溃遗留，不判 failed）', async () => {
    const threads = new FakeThreadStore();
    threads.addThread('t1', harnessTags({ runId: 'h1', status: 'active', active: false }));
    threads.setCheckpoint('t1', null);
    const taskStore = new FakeTaskStore();

    await reconcile(threads, taskStore);

    const run = await runOfTaskStore(taskStore, 'h1');
    expect(run.status).toBe('interrupted');
    // §7.1 风险 4：interrupted 的 Task 层表现为等待接管，而不是目标失败。
    expect((await taskStore.getTask(run.taskId))?.status).toBe('blocked');
  });

  it('同一线程的多个 harness run：历史 run 先收敛，新 run 复用同一 active Task', async () => {
    const threads = new FakeThreadStore();
    threads.addThread(
      't1',
      {
        [harnessStateTagKey('h1')]: harnessStateJson({ runId: 'h1', status: 'satisfied', updatedAt: '2026-09-19T08:00:00.000Z' }),
        [harnessStateTagKey('h2')]: harnessStateJson({ runId: 'h2', status: 'active', objective: '第二个目标', updatedAt: '2026-09-19T09:00:00.000Z' }),
        [ACTIVE_HARNESS_RUN_ID_TAG]: 'h2',
      },
    );
    threads.setCheckpoint('t1', runningCheckpoint('t1'));
    const taskStore = new FakeTaskStore();

    const { report } = await reconcile(threads, taskStore);

    expect(report.created).toBe(2);
    expect(taskStore.tasks.size).toBe(1); // 一个 thread 最多一个 active Task（§5.1）
    const oldRun = await runOfTaskStore(taskStore, 'h1');
    const newRun = await runOfTaskStore(taskStore, 'h2');
    expect(oldRun.status).toBe('completed');
    expect(newRun.status).toBe('running');
    expect(newRun.taskId).toBe(oldRun.taskId);
    const task = await taskStore.getTask(oldRun.taskId);
    expect(task?.runIds).toEqual([oldRun.id, newRun.id]);
    expect(task?.currentRunId).toBe(newRun.id);
  });
});

describe('reconcileTasksFromTags —— 幂等与前向修正', () => {
  it('存在且不落后 → skipped(up-to-date)，零写入（version 不变）', async () => {
    const threads = new FakeThreadStore();
    threads.addThread('t1', harnessTags({ runId: 'h1', status: 'active' }));
    threads.setCheckpoint('t1', runningCheckpoint('t1'));
    const taskStore = new FakeTaskStore();

    await reconcile(threads, taskStore);
    const before = await runOfTaskStore(taskStore, 'h1');
    const second = await reconcile(threads, taskStore);

    expect(second.report.created).toBe(0);
    expect(second.report.updated).toBe(0);
    expect(second.report.skipped).toBe(1);
    expect(itemFor(second.report, 'h1').reason).toBe('up-to-date');
    const after = await runOfTaskStore(taskStore, 'h1');
    expect(after.version).toBe(before.version);
    expect(after.status).toBe('running');
  });

  it('重复执行幂等：终态与全部行内容不变', async () => {
    const threads = new FakeThreadStore();
    threads.addThread('t1', harnessTags({ runId: 'h1', status: 'satisfied', active: false }));
    threads.addThread('t2', harnessTags({ runId: 'h2', status: 'blocked', active: false, blocker: '等待批准' }));
    const taskStore = new FakeTaskStore();

    await reconcile(threads, taskStore);
    const firstTasks = [...taskStore.tasks.values()].map((task) => ({ ...task }));
    const firstRuns = [...taskStore.runs.values()].map((run) => ({ ...run }));

    const second = await reconcile(threads, taskStore);
    const third = await reconcile(threads, taskStore);

    expect(second.report.created).toBe(0);
    expect(second.report.updated).toBe(0);
    expect(third.report.created).toBe(0);
    expect(third.report.updated).toBe(0);
    expect([...taskStore.tasks.values()]).toEqual(firstTasks);
    expect([...taskStore.runs.values()]).toEqual(firstRuns);
  });

  it('落后时只做前向修正（queued → interrupted），不改写 tags', async () => {
    const threads = new FakeThreadStore();
    threads.addThread('t1', harnessTags({ runId: 'h1', status: 'active', active: false }));
    const taskStore = new FakeTaskStore();

    await reconcile(threads, taskStore);
    const run = await runOfTaskStore(taskStore, 'h1');
    // 新进程里该 run 既不是 activeHarnessRunId、又没有 checkpoint → 崩溃遗留 → interrupted
    expect(run.status).toBe('interrupted');
    // Task 层同步为 blocked（等待接管），第二次对账不再产生任何写入
    expect((await taskStore.getTask(run.taskId))?.status).toBe('blocked');
    const second = await reconcile(threads, taskStore);
    expect(second.report.skipped).toBe(1);
    expect(second.report.conflicts).toBe(0);
  });

  it('既有 Run 已终态而 tags 说还在跑 → 不复活，保持 completed', async () => {
    const threads = new FakeThreadStore();
    threads.addThread('t1', harnessTags({ runId: 'h1', status: 'active' }));
    threads.setCheckpoint('t1', runningCheckpoint('t1'));
    const taskStore = new FakeTaskStore();
    await reconcile(threads, taskStore);
    const created = await runOfTaskStore(taskStore, 'h1');
    expect(created.status).toBe('running');
    // 影子写已把 Run 落成 completed；tags 与 checkpoint 仍显示在跑（迟到的快照）
    const settled = await taskStore.updateRun(created.id, { status: 'completed' }, created.version);

    const { report } = await reconcile(threads, taskStore);

    const after = await taskStore.getRun(created.id);
    expect(after?.status).toBe('completed');
    expect(after?.version).toBe(settled.version);
    expect(itemFor(report, 'h1').reason).toBe('terminal-run-not-revived');
  });

  it('乐观锁冲突记 conflict 并跳过，不覆盖并发写入', async () => {
    const threads = new FakeThreadStore();
    threads.addThread('t1', harnessTags({ runId: 'h1', status: 'blocked', active: false }));
    const taskStore = new FakeTaskStore();
    await reconcile(threads, taskStore);
    const run = await runOfTaskStore(taskStore, 'h1');
    expect(run.status).toBe('blocked');

    // tags 推进到 satisfied（应前向修正），但并发方已抬高了 Run 的 version
    threads.addThread('t1', harnessTags({ runId: 'h1', status: 'satisfied', active: false }));
    const realGetRun = taskStore.getRun.bind(taskStore);
    let stubbed = false;
    taskStore.getRun = async (id: string) => {
      const value = await realGetRun(id);
      if (value && !stubbed) {
        stubbed = true;
        return { ...value, version: value.version + 10 };
      }
      return value;
    };

    const { report } = await reconcile(threads, taskStore);

    expect(report.conflicts).toBe(1);
    expect(report.created).toBe(0);
    expect(report.updated).toBe(0);
    expect(itemFor(report, 'h1').reason).toBe('version-conflict');
    expect(stubbed).toBe(true);
    expect((await realGetRun(run.id))?.status).toBe('blocked');
  });
});

describe('reconcileTasksFromTags —— 容错与不中断整轮', () => {
  it('非法 JSON 的 tags 值记 conflict，其它线程继续处理', async () => {
    const threads = new FakeThreadStore();
    threads.addThread('t1', {
      [harnessStateTagKey('h1')]: '{ not json',
      [ACTIVE_HARNESS_RUN_ID_TAG]: 'h1',
    });
    threads.addThread('t2', harnessTags({ runId: 'h2', status: 'satisfied', active: false }));
    const taskStore = new FakeTaskStore();

    const { report, warnings } = await reconcile(threads, taskStore);

    expect(report.conflicts).toBe(1);
    expect(report.created).toBe(1);
    expect(itemFor(report, 'h1').reason).toBe('invalid-harness-state-tag');
    expect(warnings.some((line) => line.includes('reconcile conflict'))).toBe(true);
    expect(taskStore.runs.size).toBe(1);
  });

  it('activeHarnessRunId 指向不存在的状态键 → skipped，不建任何行', async () => {
    const threads = new FakeThreadStore();
    threads.addThread('t1', { [ACTIVE_HARNESS_RUN_ID_TAG]: 'ghost' });
    const taskStore = new FakeTaskStore();

    const { report } = await reconcile(threads, taskStore);

    expect(report.harnessRunsScanned).toBe(1);
    expect(report.skipped).toBe(1);
    expect(itemFor(report, 'ghost').reason).toBe('active-run-without-state-tag');
    expect(taskStore.tasks.size).toBe(0);
    expect(taskStore.runs.size).toBe(0);
  });

  it('objective 为空无法建 Task → conflict 并继续下一线程', async () => {
    const threads = new FakeThreadStore();
    threads.addThread('t1', harnessTags({ runId: 'h1', status: 'active', objective: '   ' }));
    threads.addThread('t2', harnessTags({ runId: 'h2', status: 'satisfied', active: false }));
    const taskStore = new FakeTaskStore();

    const { report } = await reconcile(threads, taskStore);

    expect(report.conflicts).toBe(1);
    expect(report.created).toBe(1);
    expect(itemFor(report, 'h1').reason).toBe('objective-missing');
  });

  it('单线程写库异常不中断整轮', async () => {
    const threads = new FakeThreadStore();
    threads.addThread('t1', harnessTags({ runId: 'h1', status: 'active' }));
    threads.addThread('t2', harnessTags({ runId: 'h2', status: 'satisfied', active: false }));
    const taskStore = new FakeTaskStore();
    const realListTasks = taskStore.listTasks.bind(taskStore);
    taskStore.listTasks = async (filter) => {
      if (filter?.threadId === 't1') throw new Error('db down');
      return realListTasks(filter);
    };

    const { report } = await reconcile(threads, taskStore);

    expect(report.conflicts).toBe(1);
    expect(report.created).toBe(1);
    expect(itemFor(report, 'h1').reason).toBe('write-failed');
    expect((await runOfTaskStore(taskStore, 'h2')).status).toBe('completed');
  });

  it('listThreads 失败 → 一条 thread-scan-failed，函数不抛出', async () => {
    const threads = new FakeThreadStore();
    const taskStore = new FakeTaskStore();
    const report = await reconcileTasksFromTags({
      threadStore: threads,
      taskStore,
      listThreads: async () => {
        throw new Error('cannot enumerate threads');
      },
      now: NOW,
    });
    expect(report.conflicts).toBe(1);
    expect(report.items[0]?.reason).toBe('thread-scan-failed');
    expect(report.threadsScanned).toBe(0);
  });

  it('getLastCheckpoint 抛错时按无 checkpoint 继续，不记 conflict', async () => {
    const threads = new FakeThreadStore();
    threads.addThread('t1', harnessTags({ runId: 'h1', status: 'active', active: false }));
    threads.getLastCheckpoint = async () => {
      throw new Error('rollout missing');
    };
    const taskStore = new FakeTaskStore();

    const { report, warnings } = await reconcile(threads, taskStore);

    expect(report.conflicts).toBe(0);
    expect(report.created).toBe(1);
    expect((await runOfTaskStore(taskStore, 'h1')).status).toBe('interrupted');
    expect(warnings.some((line) => line.includes('cannot read checkpoint'))).toBe(true);
  });
});

describe('reconcileTasksFromTags —— 只写 task 表，绝不改写 tags', () => {
  it('混合场景执行后 tags 完全不变且写方法零调用', async () => {
    const threads = new FakeThreadStore();
    threads.addThread('t1', harnessTags({ runId: 'h1', status: 'satisfied', active: false, extra: { runConfig: '{"a":1}' } }));
    threads.addThread('t2', harnessTags({ runId: 'h2', status: 'active' }));
    threads.setCheckpoint('t2', runningCheckpoint('t2', '11'));
    threads.addThread('t3', harnessTags({ runId: 'h3', status: 'no_progress', active: false }));
    const taskStore = new FakeTaskStore();
    const before = threads.tagsSnapshot();

    for (let pass = 0; pass < 3; pass += 1) {
      await reconcile(threads, taskStore);
    }

    expect(threads.tagsSnapshot()).toEqual(before);
    expect(threads.writeCalls).toEqual([]);
    // 关键：对账确实写了 task 表（否则上面的断言是空转）
    expect(taskStore.runs.size).toBe(3);
    expect([...taskStore.runs.values()].map((run) => run.status).sort()).toEqual(
      ['completed', 'interrupted', 'running'],
    );
  });

  it('前缀常量与 GoalTracker.persist 的真实写入兼容', async () => {
    const threads = new FakeThreadStore();
    threads.addThread('t1', {});
    threads.setCheckpoint('t1', runningCheckpoint('t1'));
    const tracker = new GoalTracker('t1', 'hrun_tracker_1');
    tracker.setGoal('由 GoalTracker 写入的目标', ['GoalTracker 标准']);
    await tracker.persist(threads);

    expect(harnessStateTagKey('hrun_tracker_1')).toBe(`${HARNESS_STATE_TAG_PREFIX}hrun_tracker_1`);
    expect(threads.threads.get('t1')?.tags[ACTIVE_HARNESS_RUN_ID_TAG]).toBe('hrun_tracker_1');

    const taskStore = new FakeTaskStore();
    const { report } = await reconcile(threads, taskStore);
    expect(report.created).toBe(1);
    const run = await runOfTaskStore(taskStore, 'hrun_tracker_1');
    expect(run.status).toBe('running');
    expect((await taskStore.getTask(run.taskId))?.objective).toBe('由 GoalTracker 写入的目标');
  });
});

describe('状态派生与迁移寻路', () => {
  it('deriveDesiredRunState 覆盖 harness 终态与 checkpoint 分支', () => {
    const base = { now: NOW, isActiveRun: true, live: true, checkpoint: runningCheckpoint('t1') };
    expect(deriveDesiredRunState({ ...base, harnessStatus: 'satisfied' })).toBe('completed');
    expect(deriveDesiredRunState({ ...base, harnessStatus: 'cancelled' })).toBe('cancelled');
    expect(deriveDesiredRunState({ ...base, harnessStatus: 'blocked' })).toBe('blocked');
    expect(deriveDesiredRunState({ ...base, harnessStatus: 'no_progress' })).toBe('interrupted');
    expect(deriveDesiredRunState({ ...base, harnessStatus: 'max_continuations' })).toBe('interrupted');
    expect(deriveDesiredRunState({ ...base, harnessStatus: 'active' })).toBe('running');
    expect(deriveDesiredRunState({ ...base, harnessStatus: 'active', live: false })).toBe('interrupted');
    expect(
      deriveDesiredRunState({ ...base, harnessStatus: 'active', existingCheckpointId: '99' }),
    ).toBe('interrupted');
    expect(
      deriveDesiredRunState({
        ...base,
        harnessStatus: 'active',
        checkpoint: { threadId: 't1', turnId: '7', itemIndex: 0, timestamp: NOW, status: 'waiting_user_input' },
      }),
    ).toBe('blocked');
    expect(
      deriveDesiredRunState({
        ...base,
        harnessStatus: 'active',
        checkpoint: { threadId: 't1', turnId: '7', itemIndex: 0, timestamp: NOW, status: 'stopping' },
      }),
    ).toBe('interrupted');
    expect(
      deriveDesiredRunState({
        ...base,
        harnessStatus: 'active',
        checkpoint: { ...runningCheckpoint('t1'), expiresAt: '2000-01-01T00:00:00.000Z' },
      }),
    ).toBe('interrupted');
    expect(
      deriveDesiredRunState({
        ...base,
        harnessStatus: 'active',
        checkpoint: { threadId: 't1', turnId: '7', itemIndex: 0, timestamp: NOW, status: 'failed' },
      }),
    ).toBe('failed');
    expect(deriveDesiredRunState({ ...base, harnessStatus: 'active', checkpoint: null })).toBe('running');
  });

  it('findTransitionPath 只用协议迁移表且确定', () => {
    expect(findTransitionPath('queued', 'queued')).toEqual([]);
    expect(findTransitionPath('queued', 'completed')).toEqual(['running', 'completed']);
    expect(findTransitionPath('running', 'interrupted')).toEqual(['interrupted']);
    expect(findTransitionPath('blocked', 'completed')).toEqual(['queued', 'running', 'completed']);
    expect(findTransitionPath('completed', 'running')).toBeNull();
    expect(findTransitionPath('cancelled', 'interrupted')).toBeNull();
  });
});
