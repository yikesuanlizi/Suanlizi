import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  transitionOpsTask,
  type OpsTaskSession,
  type OpsTaskState,
} from '@suanlizi/protocol';
import {
  LocalAdapter,
  LocalCommandAdapter,
  LocalTestError,
  OpsTaskRunner,
  ReplayAdapter,
  buildLocalTestEnvironment,
  resolveLocalTest,
} from './opsTaskRunner.js';
import type { OpsTaskEvent } from '../routes/opsRoute.js';

function makeTask(overrides: Partial<OpsTaskSession> = {}): OpsTaskSession {
  return {
    spec: {
      taskId: 'ops-runner-test',
      threadId: 'thread-runner-test',
      presetId: 'ops',
      workspaceRoot: tmpdir(),
      environmentId: 'replay-test',
      target: { hostIds: [] },
      policyProfile: 'ops_readonly',
      budgets: {
        maxAdapterCalls: 10,
        maxConcurrentCalls: 1,
        maxOutputBytes: 100_000,
        maxWallTimeMs: 10_000,
      },
      acceptanceCriteria: ['collect snapshot'],
      allowLocalPatchProposal: false,
      allowLocalTest: false,
    },
    state: 'queued',
    currentPhase: 'observe',
    hypothesisIds: [],
    evidenceIds: [],
    checkpointSequence: 0,
    taskVersion: 0,
    sequence: 0,
    ...overrides,
  };
}

function harness(task: OpsTaskSession, events: OpsTaskEvent[]) {
  return {
    tenantId: 'runner-test',
    taskId: task.spec.taskId,
    getTask: async () => task,
    transition: async (to: OpsTaskState, payload?: Record<string, unknown>) => {
      const previous = task.state;
      task = transitionOpsTask(task, to);
      events.push({
        type: 'ops.task.transitioned',
        taskId: task.spec.taskId,
        threadId: task.spec.threadId,
        from: previous,
        to,
        taskVersion: task.taskVersion,
        sequence: task.sequence,
        occurredAt: new Date().toISOString(),
        payload,
      });
      return task;
    },
    patch: async (update: (current: OpsTaskSession) => OpsTaskSession, eventType: OpsTaskEvent['type'], payload?: Record<string, unknown>) => {
      const previous = task;
      task = { ...update(task), sequence: task.sequence + 1 };
      events.push({
        type: eventType,
        taskId: task.spec.taskId,
        threadId: task.spec.threadId,
        from: previous.state,
        to: task.state,
        taskVersion: task.taskVersion,
        sequence: task.sequence,
        occurredAt: new Date().toISOString(),
        payload,
      });
      return task;
    },
    appendEvent: async (type: OpsTaskEvent['type'], payload?: Record<string, unknown>) => {
      events.push({
        type,
        taskId: task.spec.taskId,
        threadId: task.spec.threadId,
        from: task.state,
        to: task.state,
        taskVersion: task.taskVersion,
        sequence: task.sequence,
        occurredAt: new Date().toISOString(),
        payload,
      });
    },
    get snapshot() {
      return task;
    },
  };
}

describe('OpsTaskRunner', () => {
  it('does not pass parent process credentials into local test processes', () => {
    const previous = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = 'should-not-leak';
    try {
      const environment = buildLocalTestEnvironment('workspace.typecheck');
      expect(environment.SUANLIZI_OPS_TEST).toBe('workspace.typecheck');
      expect(environment.OPENAI_API_KEY).toBeUndefined();
    } finally {
      if (previous === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previous;
    }
  });

  it('only resolves registered tests and rejects caller-supplied arguments', () => {
    expect(resolveLocalTest('workspace.typecheck', [])).toMatchObject({ testId: 'workspace.typecheck' });
    expect(() => resolveLocalTest('rm -rf /', [])).toThrowError(LocalTestError);
    expect(() => resolveLocalTest('workspace.typecheck', ['--project', 'other'])).toThrowError(LocalTestError);
  });

  it('does not pretend a missing workspace test executable is available', async () => {
    const root = await mkdtemp(join(tmpdir(), 'suanlizi-ops-test-unavailable-'));
    try {
      await expect(new LocalCommandAdapter().runTest({
        workspaceRoot: root,
        testId: 'workspace.typecheck',
        args: [],
        timeoutMs: 1000,
        maxOutputBytes: 4096,
      }, new AbortController().signal)).rejects.toMatchObject({ code: 'OPS_TEST_NOT_AVAILABLE' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('runs ReplayAdapter through all phases and stores redacted evidence summary', async () => {
    const task = makeTask();
    const events: OpsTaskEvent[] = [];
    const hooks = harness(task, events);
    const runner = new OpsTaskRunner();
    runner.start({
      ...hooks,
      adapter: new ReplayAdapter({ 'ops-runner-test': 'token=sk-12345678901234567890\nservice healthy' }),
    });
    await runner.wait('runner-test', task.spec.taskId);

    expect(hooks.snapshot.state).toBe('completed');
    expect(hooks.snapshot.currentPhase).toBe('conclude');
    expect(hooks.snapshot.evidenceIds).toHaveLength(1);
    expect(events.map((event) => event.payload?.phase).filter(Boolean)).toEqual(
      expect.arrayContaining(['observe', 'hypothesize', 'investigate', 'verify', 'conclude']),
    );
    const evidence = events.find((event) => event.type === 'ops.task.evidence');
    expect(evidence?.payload).toMatchObject({ summary: expect.stringContaining('[REDACTED]') });
    expect(typeof evidence?.payload?.expiresAt).toBe('string');
    expect(evidence?.payload).not.toMatchObject({ summary: expect.stringContaining('sk-12345678901234567890') });
  });

  it('reads local workspace without executing a command', async () => {
    const root = await mkdtemp(join(tmpdir(), 'suanlizi-ops-local-'));
    try {
      const task = makeTask({ spec: { ...makeTask().spec, workspaceRoot: root, environmentId: 'local' } });
      const observation = await new LocalAdapter().observe(task, new AbortController().signal);
      expect(observation.source).toBe('local');
      expect(observation.content).toContain(`Workspace: ${root}`);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('stops on pause/cancel without converting the task to failed', async () => {
    const task = makeTask();
    const events: OpsTaskEvent[] = [];
    const hooks = harness(task, events);
    const runner = new OpsTaskRunner();
    const adapter = {
      id: 'blocking-fixture',
      observe: async (_task: OpsTaskSession, signal: AbortSignal) => await new Promise<never>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      }),
    };
    runner.start({ ...hooks, adapter });
    for (let attempt = 0; attempt < 20 && hooks.snapshot.state !== 'running'; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    await hooks.transition('paused');
    expect(runner.cancel('runner-test', task.spec.taskId)).toBe(true);
    await runner.wait('runner-test', task.spec.taskId);
    expect(hooks.snapshot.state).toBe('paused');
    expect(events.some((event) => event.type === 'ops.task.failed')).toBe(false);
  });

  it('enforces the whole-task wall-time deadline while an adapter is still pending', async () => {
    const task = makeTask({
      spec: {
        ...makeTask().spec,
        budgets: {
          ...makeTask().spec.budgets,
          maxWallTimeMs: 25,
        },
      },
    });
    const events: OpsTaskEvent[] = [];
    const hooks = harness(task, events);
    const runner = new OpsTaskRunner();
    runner.start({
      ...hooks,
      adapter: {
        id: 'deadline-fixture',
        observe: async () => await new Promise<never>(() => undefined),
      },
    });
    await runner.wait('runner-test', task.spec.taskId);

    expect(hooks.snapshot.state).toBe('failed');
    expect(events).toContainEqual(expect.objectContaining({
      type: 'ops.task.failed',
      payload: expect.objectContaining({ code: 'OPS_TASK_TIMEOUT' }),
    }));
  });

  it('adds resumed execution time to the prior wall-time budget usage', async () => {
    const base = makeTask();
    const task = makeTask({
      budgetUsage: { adapterCalls: 0, inputTokens: 0, outputBytes: 0, wallTimeMs: 50 },
      spec: { ...base.spec, budgets: { ...base.spec.budgets, maxWallTimeMs: 10_000 } },
    });
    const events: OpsTaskEvent[] = [];
    const hooks = harness(task, events);
    const runner = new OpsTaskRunner();
    runner.start({ ...hooks, adapter: new ReplayAdapter({ [task.spec.taskId]: 'healthy' }) });
    await runner.wait('runner-test', task.spec.taskId);

    expect(hooks.snapshot.state).toBe('completed');
    expect(hooks.snapshot.budgetUsage?.wallTimeMs).toBeGreaterThanOrEqual(50);
  });

  it('finishes queued tests when task cancellation skips their FIFO entry', async () => {
    const task = makeTask({
      testRuns: [{ testRunId: 'test-queued', testId: 'workspace.typecheck', args: [], status: 'queued' }],
    });
    const events: OpsTaskEvent[] = [];
    const hooks = harness(task, events);
    const runner = new OpsTaskRunner();
    const adapter = {
      id: 'blocking-fixture',
      observe: async (_task: OpsTaskSession, signal: AbortSignal) => await new Promise<never>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      }),
    };
    runner.start({ ...hooks, adapter });
    runner.startLocalTest({ ...hooks }, {
      testRunId: 'test-queued',
      testId: 'workspace.typecheck',
      args: [],
      timeoutMs: 1_000,
    });
    for (let attempt = 0; attempt < 20 && hooks.snapshot.state !== 'running'; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    runner.cancel('runner-test', task.spec.taskId);
    await runner.wait('runner-test', task.spec.taskId);

    expect(hooks.snapshot.testRuns?.[0]).toMatchObject({
      status: 'cancelled',
      errorCode: 'OPS_TEST_CANCELLED',
    });
  });

  it('rejects execution when the current thread workspace changes', async () => {
    const task = makeTask({ spec: { ...makeTask().spec, environmentId: 'local' } });
    const events: OpsTaskEvent[] = [];
    const hooks = harness(task, events);
    let observed = false;
    const runner = new OpsTaskRunner();
    runner.start({
      ...hooks,
      assertWorkspaceScope: async () => {
        throw Object.assign(new Error('workspace changed'), { code: 'OPS_SCOPE_REQUIRED' });
      },
      adapter: {
        id: 'must-not-run',
        observe: async () => {
          observed = true;
          return { source: 'local', content: 'unexpected' };
        },
      },
    });
    await runner.wait('runner-test', task.spec.taskId);

    expect(observed).toBe(false);
    expect(hooks.snapshot.state).toBe('failed');
    expect(events).toContainEqual(expect.objectContaining({
      type: 'ops.task.failed',
      payload: expect.objectContaining({ code: 'OPS_SCOPE_REQUIRED' }),
    }));
  });
});
