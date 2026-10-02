import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  Checkpoint,
  Task,
  TaskRun,
  WorkflowAgentCall,
  WorkflowRunRecord,
} from '@suanlizi/protocol';
import { createStore } from './index.js';
import { SqliteTaskStore } from './taskStore.js';

const NOW = '2026-09-19T00:00:00.000Z';

/** Build a fresh SQLite-backed store + a SqliteTaskStore over the same db handle. */
function makeTaskStore(
  options: ConstructorParameters<typeof SqliteTaskStore>[1] = {},
): { taskStore: SqliteTaskStore; close: () => void } {
  const { db } = createStore(mkdtempSync(join(tmpdir(), 'suanlizi-task-store-')));
  const taskStore = new SqliteTaskStore(db as never, options);
  return { taskStore, close: () => undefined };
}

function baseTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    threadId: 'thread-1',
    objective: 'Ship the goal-task storage layer',
    acceptanceCriteria: ['four tables exist', 'optimistic lock works'],
    status: 'pending',
    runIds: [],
    evidenceIds: [],
    createdAt: NOW,
    updatedAt: NOW,
    version: 0,
    ...overrides,
  };
}

function baseRun(overrides: Partial<TaskRun> = {}): TaskRun {
  return {
    id: 'run-1',
    taskId: 'task-1',
    threadId: 'thread-1',
    kind: 'goal',
    status: 'queued',
    updatedAt: NOW,
    version: 0,
    ...overrides,
  };
}

function checkpoint(overrides: Partial<Checkpoint> & { threadId: string; turnId: string }): Checkpoint {
  return {
    itemIndex: 0,
    timestamp: NOW,
    ...overrides,
  } as Checkpoint;
}

function futureIso(): string {
  return new Date(Date.now() + 60_000).toISOString();
}

function pastIso(): string {
  return new Date(Date.now() - 60_000).toISOString();
}

// ─── Task CRUD / terminal / optimistic lock ────────────────────────────────
describe('SqliteTaskStore tasks', () => {
  it('creates, reads, updates through valid transitions, and reaches terminal state', async () => {
    const { taskStore } = makeTaskStore();

    const created = await taskStore.createTask(baseTask());
    expect(created.version).toBe(0);
    await expect(taskStore.getTask('task-1')).resolves.toEqual(created);

    const running = await taskStore.updateTask('task-1', { status: 'running' }, 0);
    expect(running.status).toBe('running');
    expect(running.version).toBe(1);

    const completed = await taskStore.updateTask(
      'task-1',
      { status: 'completed', completedAt: NOW },
      1,
    );
    expect(completed.status).toBe('completed');
    expect(completed.version).toBe(2);
    expect(completed.completedAt).toBe(NOW);

    // terminal Task has no exit
    await expect(
      taskStore.updateTask('task-1', { status: 'running' }, 2),
    ).rejects.toMatchObject({ code: 'TASK_TERMINAL_STATE' });
  });

  it('throws TASK_ACTIVE_EXISTS when the id is reused', async () => {
    const { taskStore } = makeTaskStore();
    await taskStore.createTask(baseTask());
    await expect(taskStore.createTask(baseTask())).rejects.toMatchObject({
      code: 'TASK_ACTIVE_EXISTS',
    });
  });

  it('rejects optimistic-lock conflicts with TASK_VERSION_CONFLICT', async () => {
    const { taskStore } = makeTaskStore();
    await taskStore.createTask(baseTask());
    await expect(
      taskStore.updateTask('task-1', { status: 'running' }, 42),
    ).rejects.toMatchObject({ code: 'TASK_VERSION_CONFLICT' });
    // unchanged
    await expect(taskStore.getTask('task-1')).resolves.toMatchObject({ version: 0 });
  });

  it('rejects illegal Task status transitions with TASK_INVALID_TRANSITION', async () => {
    const { taskStore } = makeTaskStore();
    await taskStore.createTask(baseTask());
    // pending -> completed is not an allowed edge
    await expect(
      taskStore.updateTask('task-1', { status: 'completed' }, 0),
    ).rejects.toMatchObject({ code: 'TASK_INVALID_TRANSITION' });
  });

  it('显式写入 undefined 才清空可清列（pendingInput），缺省键不得覆盖旧值', async () => {
    const { taskStore } = makeTaskStore();
    await taskStore.createTask(
      baseTask({
        status: 'blocked',
        pendingInput: { question: '选哪个环境？', freeText: true, askedAt: NOW },
      }),
    );
    // 只改无关字段：pendingInput 必须保留。
    await taskStore.updateTask('task-1', { objective: '改名' }, 0);
    await expect(taskStore.getTask('task-1')).resolves.toMatchObject({
      pendingInput: { question: '选哪个环境？' },
    });
    // resolveUserInput 语义：显式 `pendingInput: undefined` 必须落为 NULL，否则旧问题会永远挂在 UI 上。
    const cleared = await taskStore.updateTask(
      'task-1',
      { status: 'running', pendingInput: undefined },
      1,
    );
    expect(cleared.pendingInput).toBeUndefined();
    await expect(taskStore.getTask('task-1')).resolves.toMatchObject({ status: 'running' });
    expect((await taskStore.getTask('task-1'))?.pendingInput).toBeUndefined();
  });

  it('preserves explicit Dynamic Workflow origins at the store boundary', async () => {
    const { taskStore } = makeTaskStore();
    await taskStore.createTask(baseTask({ id: 'workflow-1', origin: 'explicit_workflow' }));

    await expect(taskStore.getTask('workflow-1')).resolves.toMatchObject({
      id: 'workflow-1',
      origin: 'explicit_workflow',
    });
    await expect(taskStore.listTasks({ origin: ['explicit_workflow'] })).resolves.toMatchObject([
      { id: 'workflow-1', origin: 'explicit_workflow' },
    ]);
    await expect(taskStore.listTasks({ origin: ['harness_shadow'] })).resolves.toEqual([]);
  });

  it('defaults legacy or invalid origins to harness shadows and filters explicit Goals at the store boundary', async () => {
    const { taskStore } = makeTaskStore();
    await taskStore.createTask(baseTask({ id: 'goal-1', origin: 'explicit_goal' }));
    // 缺失来源是旧数据语义，必须保守地落到 shadow，不得进入 Goal UI。
    await taskStore.createTask(baseTask({ id: 'legacy-1' }));
    // 存储层也不信任运行时绕过 TypeScript 的非法值。
    await taskStore.createTask(baseTask({ id: 'invalid-1', origin: 'untrusted_source' as never }));

    await expect(taskStore.getTask('legacy-1')).resolves.toMatchObject({ origin: 'harness_shadow' });
    await expect(taskStore.getTask('invalid-1')).resolves.toMatchObject({ origin: 'harness_shadow' });
    await expect(taskStore.listTasks({ origin: ['explicit_goal'] })).resolves.toMatchObject([
      { id: 'goal-1', origin: 'explicit_goal' },
    ]);
    const shadowTasks = await taskStore.listTasks({ origin: ['harness_shadow'] });
    expect(shadowTasks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'invalid-1', origin: 'harness_shadow' }),
      expect.objectContaining({ id: 'legacy-1', origin: 'harness_shadow' }),
    ]));
  });

  it('lists and filters tasks; resolves the active task for a thread', async () => {
    const { taskStore } = makeTaskStore();
    await taskStore.createTask(baseTask({ id: 'task-a', threadId: 'thread-a' }));
    await taskStore.createTask(baseTask({ id: 'task-b', threadId: 'thread-b', status: 'completed' }));

    await expect(taskStore.listTasks({ threadId: 'thread-a' })).resolves.toMatchObject([
      { id: 'task-a' },
    ]);
    await expect(taskStore.listTasks({ status: ['completed'] })).resolves.toMatchObject([
      { id: 'task-b' },
    ]);
    await expect(taskStore.getActiveTask('thread-a')).resolves.toMatchObject({ id: 'task-a' });
    await expect(taskStore.getActiveTask('thread-b')).resolves.toBeNull();
  });
});

// ─── TaskRun transitions / retry ───────────────────────────────────────────
describe('SqliteTaskStore runs', () => {
  it('accepts running -> completed (协议补边后的合法成功路径)', async () => {
    const { taskStore } = makeTaskStore();
    await taskStore.createRun(baseRun({ status: 'running' }));
    const updated = await taskStore.updateRun('run-1', { status: 'completed' }, 0);
    expect(updated.status).toBe('completed');
    expect(updated.version).toBe(1);
  });

  it('rejects queued -> completed because TASK_RUN_TRANSITIONS has no such edge', async () => {
    const { taskStore } = makeTaskStore();
    await taskStore.createRun(baseRun({ status: 'queued' }));
    await expect(
      taskStore.updateRun('run-1', { status: 'completed' }, 0),
    ).rejects.toMatchObject({ code: 'TASK_INVALID_TRANSITION' });
  });

  it('accepts blocked -> queued (re-queue after user input)', async () => {
    const { taskStore } = makeTaskStore();
    await taskStore.createRun(baseRun({ status: 'blocked' }));
    const updated = await taskStore.updateRun('run-1', { status: 'queued' }, 0);
    expect(updated.status).toBe('queued');
    expect(updated.version).toBe(1);
  });

  it('throws TASK_VERSION_CONFLICT on stale run version', async () => {
    const { taskStore } = makeTaskStore();
    await taskStore.createRun(baseRun({ status: 'running' }));
    await expect(
      taskStore.updateRun('run-1', { status: 'blocked' }, 7),
    ).rejects.toMatchObject({ code: 'TASK_VERSION_CONFLICT' });
  });

  it('throws TASK_ACTIVE_EXISTS when the run id is reused', async () => {
    const { taskStore } = makeTaskStore();
    await taskStore.createRun(baseRun());
    await expect(taskStore.createRun(baseRun())).rejects.toMatchObject({
      code: 'TASK_ACTIVE_EXISTS',
    });
  });

  it('models retry as a brand-new run without touching the old terminal run', async () => {
    const { taskStore } = makeTaskStore();
    await taskStore.createRun(baseRun({ id: 'run-old', status: 'running' }));
    const failed = await taskStore.updateRun('run-old', { status: 'failed', error: 'boom' }, 0);
    expect(failed.status).toBe('failed');

    // retry: insert a fresh run, never revive the old one
    const retry = await taskStore.createRun(
      baseRun({ id: 'run-new', status: 'queued', checkpointId: '9' }),
    );
    expect(retry.version).toBe(0);

    const oldAgain = await taskStore.getRun('run-old');
    expect(oldAgain).toMatchObject({ status: 'failed', version: 1 });
    await expect(taskStore.listRuns('task-1')).resolves.toMatchObject([
      { id: 'run-old' },
      { id: 'run-new' },
    ]);
  });
});

// ─── Workflow run / agent call round-trip ──────────────────────────────────
describe('SqliteTaskStore workflow runs', () => {
  it('round-trips a workflow run and its agent calls with stable JSON fields', async () => {
    const { taskStore } = makeTaskStore();

    const record: WorkflowRunRecord = {
      id: 'wfrun-1',
      taskRunId: 'run-1',
      script: "phase('a'); const r = await agent('x'); return r;",
      scriptHash: 'hash-abc',
      args: { files: ['a.ts', 'b.ts'], nested: { ok: true } },
      status: 'running',
      agentCalls: [],
      usage: { inputTokens: 120, outputTokens: 48, agentCallCount: 1, durationMs: 1500 },
      startedAt: NOW,
      updatedAt: NOW,
    };

    const upserted = await taskStore.upsertWorkflowRun(record);
    expect(upserted.args).toEqual(record.args);
    expect(upserted.usage).toEqual(record.usage);
    await expect(taskStore.getWorkflowRun('wfrun-1')).resolves.toMatchObject({
      id: 'wfrun-1',
      scriptHash: 'hash-abc',
    });

    const call: WorkflowAgentCall = {
      id: 'call-1',
      label: 'audit a.ts',
      prompt: 'audit a.ts',
      model: 'doubao',
      status: 'completed',
      result: { file: 'a.ts', risk: 'high', evidence: ['line 12'] },
      inputTokens: 100,
      outputTokens: 40,
      evidenceId: 'wev_wfrun-1_call-1',
      startedAt: NOW,
      completedAt: NOW,
      // §14.5：大结果句柄的结果指纹与字节大小必须能往返。
      resultHash: 'a1b2c3d4e5f60718',
      resultSize: 12345,
    };
    const recorded = await taskStore.recordAgentCall('wfrun-1', call);
    expect(recorded.result).toEqual(call.result);
    expect(recorded.evidenceId).toBe('wev_wfrun-1_call-1');
    expect(recorded.resultHash).toBe('a1b2c3d4e5f60718');
    expect(recorded.resultSize).toBe(12345);

    await expect(taskStore.listAgentCalls('wfrun-1')).resolves.toEqual([call]);
    // the JSON result object survives the TEXT round-trip verbatim
    const loaded = await taskStore.getWorkflowRun('wfrun-1');
    expect(loaded?.agentCalls).toEqual([call]);

    // update the call (schema-consistent re-serialize)
    await taskStore.updateAgentCall('wfrun-1', { ...call, status: 'failed', error: 'nope' });
    await expect(taskStore.listAgentCalls('wfrun-1')).resolves.toMatchObject([
      { id: 'call-1', status: 'failed', error: 'nope' },
    ]);
  });

  it('persists agent calls supplied inline on the record', async () => {
    const { taskStore } = makeTaskStore();
    await taskStore.upsertWorkflowRun({
      id: 'wfrun-2',
      taskRunId: 'run-2',
      script: 'return 1',
      scriptHash: 'h2',
      status: 'queued',
      agentCalls: [
        { id: 'c1', prompt: 'p', status: 'pending', inputTokens: 0, outputTokens: 0 },
      ],
      usage: { inputTokens: 0, outputTokens: 0, agentCallCount: 0, durationMs: 0 },
      startedAt: NOW,
      updatedAt: NOW,
    });
    await expect(taskStore.listAgentCalls('wfrun-2')).resolves.toMatchObject([{ id: 'c1' }]);
  });

  it('P6：goalRunId / evidenceId / result 三列 round-trip + listWorkflowRuns 按 goalRunId 过滤', async () => {
    const { taskStore } = makeTaskStore();
    const record: WorkflowRunRecord = {
      id: 'wfrun-g1',
      taskRunId: 'run-g1',
      script: 'return { ok: true }',
      scriptHash: 'hash-g1',
      status: 'completed',
      goalRunId: 'goalrun-1',
      evidenceId: 'wev_wfrun-g1_run',
      result: { ok: true, files: ['a.ts'] },
      agentCalls: [],
      usage: { inputTokens: 5, outputTokens: 2, agentCallCount: 0, durationMs: 10 },
      startedAt: NOW,
      updatedAt: NOW,
      completedAt: NOW,
    };
    await taskStore.upsertWorkflowRun(record);
    await expect(taskStore.getWorkflowRun('wfrun-g1')).resolves.toEqual(record);

    await taskStore.upsertWorkflowRun({ ...record, id: 'wfrun-g2', taskRunId: 'run-g2', goalRunId: 'goalrun-2' });
    await taskStore.upsertWorkflowRun({ ...record, id: 'wfrun-manual', taskRunId: 'run-m', goalRunId: undefined, evidenceId: undefined, result: undefined, completedAt: undefined });
    await expect(taskStore.listWorkflowRuns({ goalRunId: 'goalrun-1' })).resolves.toMatchObject([
      { id: 'wfrun-g1', goalRunId: 'goalrun-1', evidenceId: 'wev_wfrun-g1_run' },
    ]);
    await expect(taskStore.listWorkflowRuns()).resolves.toHaveLength(3);
    // 手动 run（无 goalRunId）不被任何 goal 过滤命中。
    await expect(taskStore.listWorkflowRuns({ goalRunId: 'goalrun-3' })).resolves.toEqual([]);
  });
});

// ─── recoverInterruptedRuns — six branches (§14.7) ─────────────────────────
describe('SqliteTaskStore.recoverInterruptedRuns', () => {
  it('skips a still-live running run (has an active controller)', async () => {
    const readCheckpoint = async () =>
      checkpoint({ threadId: 'thread-1', turnId: '7', status: 'running', expiresAt: futureIso() });
    const { taskStore } = makeTaskStore({ readCheckpoint });
    await taskStore.createRun(baseRun({ status: 'running', checkpointId: '7' }));

    const changed = await taskStore.recoverInterruptedRuns(() => true);
    expect(changed).toEqual([]);
    await expect(taskStore.getRun('run-1')).resolves.toMatchObject({
      status: 'running',
      version: 0,
    });
  });

  it('marks a stale/expired running run as interrupted', async () => {
    const readCheckpoint = async () =>
      checkpoint({ threadId: 'thread-1', turnId: '7', status: 'running', expiresAt: pastIso() });
    const { taskStore } = makeTaskStore({ readCheckpoint });
    await taskStore.createRun(baseRun({ status: 'running', checkpointId: '7' }));

    const changed = await taskStore.recoverInterruptedRuns(() => false);
    expect(changed.map((r) => r.id)).toEqual(['run-1']);
    await expect(taskStore.getRun('run-1')).resolves.toMatchObject({ status: 'interrupted' });
  });

  it('maps a waiting_user_input checkpoint to blocked', async () => {
    const readCheckpoint = async () =>
      checkpoint({ threadId: 'thread-1', turnId: '7', status: 'waiting_user_input' });
    const { taskStore } = makeTaskStore({ readCheckpoint });
    await taskStore.createRun(baseRun({ status: 'running', checkpointId: '7' }));

    await taskStore.recoverInterruptedRuns(() => false);
    await expect(taskStore.getRun('run-1')).resolves.toMatchObject({ status: 'blocked' });
  });

  it('mirrors a terminal checkpoint back to a terminal run state', async () => {
    const readCheckpoint = async () =>
      checkpoint({ threadId: 'thread-1', turnId: '7', status: 'completed' });
    const { taskStore } = makeTaskStore({ readCheckpoint });
    await taskStore.createRun(baseRun({ status: 'running', checkpointId: '7' }));

    await taskStore.recoverInterruptedRuns(() => false);
    const run = await taskStore.getRun('run-1');
    expect(run?.status).toBe('completed');
    expect(run?.completedAt).toBeTruthy();
  });

  it('treats a checkpoint superseded by a newer turn as interrupted (never resume)', async () => {
    // run pinned to turn 7, but the thread advanced to turn 9
    const readCheckpoint = async () =>
      checkpoint({ threadId: 'thread-1', turnId: '9', status: 'running', expiresAt: futureIso() });
    const { taskStore } = makeTaskStore({ readCheckpoint });
    await taskStore.createRun(baseRun({ status: 'running', checkpointId: '7' }));

    await taskStore.recoverInterruptedRuns(() => true);
    await expect(taskStore.getRun('run-1')).resolves.toMatchObject({ status: 'interrupted' });
  });

  it('marks a run with no checkpoint as interrupted', async () => {
    const readCheckpoint = async () => null;
    const { taskStore } = makeTaskStore({ readCheckpoint });
    await taskStore.createRun(baseRun({ status: 'running', checkpointId: '7' }));

    const changed = await taskStore.recoverInterruptedRuns(() => false);
    expect(changed.map((r) => r.id)).toEqual(['run-1']);
    await expect(taskStore.getRun('run-1')).resolves.toMatchObject({ status: 'interrupted' });
  });

  it('leaves terminal runs untouched and never writes a second recovery truth', async () => {
    const readCheckpoint = async () => null;
    const { taskStore } = makeTaskStore({ readCheckpoint });
    await taskStore.createRun(baseRun({ id: 'run-done', status: 'completed' }));
    const changed = await taskStore.recoverInterruptedRuns(() => false);
    expect(changed).toEqual([]);
    await expect(taskStore.getRun('run-done')).resolves.toMatchObject({
      status: 'completed',
      version: 0,
    });
  });
});
