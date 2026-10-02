import { describe, expect, it } from 'vitest';
import {
  DEFAULT_WORKFLOW_RUNTIME_LIMITS,
  TASK_EVENT_NAMES,
  TASK_RUN_STATES,
  TASK_RUN_TERMINAL_STATES,
  TASK_RUN_TRANSITIONS,
  TASK_STATUSES,
  TASK_STATUS_TRANSITIONS,
  TASK_STEP_STATUSES,
  TaskError,
  assertTaskRunTransition,
  canTransitionTaskRun,
  isTaskEventName,
  isTaskRunState,
  isTaskRunTerminalState,
  isTaskTerminalState,
  pendingUserInputSchema,
  replanPolicySchema,
  taskPlanVersionSchema,
  taskRunSchema,
  taskSchema,
  taskStepSchema,
  validateTaskVersion,
  workflowAgentCallSchema,
  workflowRunRecordSchema,
  workflowRuntimeLimitsSchema,
  workflowScriptRequestSchema,
} from './task.js';

const NOW = '2026-09-19T00:00:00.000Z';

function validTask(overrides: Record<string, unknown> = {}) {
  return {
    id: 'task-1',
    threadId: 'thread-1',
    objective: '把鉴权缺口审计清楚',
    acceptanceCriteria: ['所有缺口都有证据结论'],
    status: 'pending',
    runIds: [],
    evidenceIds: [],
    createdAt: NOW,
    updatedAt: NOW,
    version: 0,
    ...overrides,
  };
}

function validRun(overrides: Record<string, unknown> = {}) {
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

function validAgentCall(overrides: Record<string, unknown> = {}) {
  return {
    id: 'call-1',
    prompt: '审计 auth.ts',
    status: 'pending',
    inputTokens: 0,
    outputTokens: 0,
    ...overrides,
  };
}

function validRunRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: 'wf-1',
    taskRunId: 'run-1',
    script: "phase('发现文件')\nreturn []",
    scriptHash: 'sha256:abc',
    status: 'queued',
    agentCalls: [],
    usage: { inputTokens: 0, outputTokens: 0, agentCallCount: 0, durationMs: 0 },
    startedAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

describe('Task goal-layer status machine', () => {
  it('covers every declared status with an exhaustively typed transition row', () => {
    expect(Object.keys(TASK_STATUS_TRANSITIONS).sort()).toEqual([...TASK_STATUSES].sort());
    for (const from of TASK_STATUSES) {
      for (const to of TASK_STATUS_TRANSITIONS[from]) {
        expect(TASK_STATUSES).toContain(to);
      }
    }
  });

  it('keeps goal-layer terminal states without exits', () => {
    expect(TASK_STATUS_TRANSITIONS.completed).toEqual([]);
    expect(TASK_STATUS_TRANSITIONS.cancelled).toEqual([]);
    expect(TASK_STATUS_TRANSITIONS.failed).toEqual([]);
    expect(isTaskTerminalState('completed')).toBe(true);
    expect(isTaskTerminalState('running')).toBe(false);
  });

  it('matches the documented pending/running/blocked edges', () => {
    expect(TASK_STATUS_TRANSITIONS.pending).toEqual([
      'running',
      'blocked',
      'cancelled',
      'failed',
    ]);
    expect(TASK_STATUS_TRANSITIONS.running).toEqual([
      'blocked',
      'completed',
      'failed',
      'cancelled',
    ]);
    expect(TASK_STATUS_TRANSITIONS.blocked).toEqual(['running', 'cancelled', 'failed']);
  });
});

describe('TaskRun transition table (plan §11.4)', () => {
  it('equals the documented table exactly', () => {
    expect(TASK_RUN_TRANSITIONS).toEqual({
      queued: ['running', 'blocked', 'cancelled', 'failed', 'interrupted'],
      running: ['paused', 'blocked', 'cancelled', 'failed', 'completed', 'interrupted'],
      paused: ['running', 'cancelled', 'failed', 'interrupted'],
      blocked: ['queued', 'cancelled', 'failed', 'interrupted'],
      interrupted: ['running', 'queued', 'cancelled', 'failed'],
      completed: [],
      cancelled: [],
      failed: [],
    });
  });

  it('accepts and rejects every state pair consistently with the table', () => {
    const legal: Array<[string, string]> = [];
    let checkedPairs = 0;
    for (const from of TASK_RUN_STATES) {
      expect(Object.prototype.hasOwnProperty.call(TASK_RUN_TRANSITIONS, from)).toBe(true);
      for (const to of TASK_RUN_STATES) {
        checkedPairs += 1;
        const allowed = TASK_RUN_TRANSITIONS[from].includes(to);
        expect(canTransitionTaskRun(from, to)).toBe(allowed);
        if (allowed) legal.push([from, to]);
      }
    }
    // 8 states x 8 states
    expect(checkedPairs).toBe(64);
    expect(legal).toHaveLength(
      Object.values(TASK_RUN_TRANSITIONS).reduce((total, row) => total + row.length, 0),
    );
  });

  it('exposes only declared states and no self-loops', () => {
    for (const state of TASK_RUN_STATES) {
      expect(isTaskRunState(state)).toBe(true);
      expect(TASK_RUN_TRANSITIONS[state]).not.toContain(state);
    }
    expect(isTaskRunState('archived')).toBe(false);
  });

  it('has no exits from terminal states', () => {
    expect([...TASK_RUN_TERMINAL_STATES].sort()).toEqual(['cancelled', 'completed', 'failed']);
    for (const state of TASK_RUN_TERMINAL_STATES) {
      expect(isTaskRunTerminalState(state)).toBe(true);
      expect(TASK_RUN_TRANSITIONS[state]).toEqual([]);
      for (const to of TASK_RUN_STATES) {
        expect(canTransitionTaskRun(state, to)).toBe(false);
      }
    }
    expect(isTaskRunTerminalState('interrupted')).toBe(false);
    expect(isTaskRunTerminalState('blocked')).toBe(false);
  });

  it('treats blocked -> queued as re-queue after user input and keeps interrupted resumable', () => {
    expect(canTransitionTaskRun('blocked', 'queued')).toBe(true);
    expect(canTransitionTaskRun('blocked', 'running')).toBe(false);
    expect(canTransitionTaskRun('interrupted', 'running')).toBe(true);
    expect(canTransitionTaskRun('interrupted', 'queued')).toBe(true);
    expect(canTransitionTaskRun('interrupted', 'completed')).toBe(false);
    // 补边后的合法路径：成功落终态与恢复扫描标记 interrupted。
    expect(canTransitionTaskRun('running', 'completed')).toBe(true);
    expect(canTransitionTaskRun('running', 'interrupted')).toBe(true);
    expect(canTransitionTaskRun('queued', 'interrupted')).toBe(true);
    expect(canTransitionTaskRun('paused', 'interrupted')).toBe(true);
    expect(canTransitionTaskRun('blocked', 'interrupted')).toBe(true);
    // 仍然禁止的跳迁：未运行即完成、从非活跃态直落 completed。
    expect(canTransitionTaskRun('queued', 'completed')).toBe(false);
    expect(canTransitionTaskRun('paused', 'completed')).toBe(false);
    expect(canTransitionTaskRun('blocked', 'completed')).toBe(false);
    expect(canTransitionTaskRun('queued', 'paused')).toBe(false);
  });
});

describe('assertTaskRunTransition error codes', () => {
  it('does not throw for legal transitions', () => {
    expect(() => assertTaskRunTransition('queued', 'running')).not.toThrow();
    expect(() => assertTaskRunTransition('blocked', 'queued')).not.toThrow();
  });

  it('reports terminal states before illegal transitions', () => {
    try {
      assertTaskRunTransition('completed', 'running');
      throw new Error('expected assertTaskRunTransition to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(TaskError);
      expect(error).toMatchObject({
        name: 'TaskError',
        code: 'TASK_TERMINAL_STATE',
        details: { from: 'completed', to: 'running' },
      });
    }
    for (const state of TASK_RUN_TERMINAL_STATES) {
      expect(() => assertTaskRunTransition(state, 'cancelled')).toThrowError(TaskError);
    }
  });

  it('reports illegal non-terminal transitions with TASK_INVALID_TRANSITION', () => {
    try {
      assertTaskRunTransition('queued', 'paused');
      throw new Error('expected assertTaskRunTransition to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(TaskError);
      expect(error).toMatchObject({
        code: 'TASK_INVALID_TRANSITION',
        details: { from: 'queued', to: 'paused' },
      });
    }
  });
});

describe('validateTaskVersion optimistic lock', () => {
  it('accepts matching safe-integer versions', () => {
    expect(validateTaskVersion(0, 0)).toBe(true);
    expect(validateTaskVersion(7, 7)).toBe(true);
  });

  it('rejects conflicts and non-integer versions with TASK_VERSION_CONFLICT', () => {
    const cases: Array<[number, number]> = [
      [3, 2],
      [2, 3],
      [1.5, 1.5],
      [Number.NaN, Number.NaN],
    ];
    for (const [actual, expected] of cases) {
      try {
        validateTaskVersion(actual, expected);
        throw new Error('expected validateTaskVersion to throw');
      } catch (error) {
        expect(error).toBeInstanceOf(TaskError);
        expect(error).toMatchObject({
          code: 'TASK_VERSION_CONFLICT',
          details: { actualVersion: actual, expectedVersion: expected },
        });
      }
    }
  });
});

describe('Task and TaskRun schemas', () => {
  it('parses valid task/run payloads and keeps them strict', () => {
    expect(taskSchema.parse(validTask())).toMatchObject({ id: 'task-1', version: 0 });
    expect(
      taskSchema.parse(
        validTask({
          status: 'blocked',
          pendingInput: { question: '要包含测试文件吗？', options: ['是', '否'], freeText: true, askedAt: NOW },
          latestPlan: {
            version: 1,
            createdAt: NOW,
            trigger: 'replan',
            steps: [
              {
                id: 'step-1',
                description: '发现文件',
                status: 'verified',
                evidenceIds: ['ev-1'],
                dependsOn: ['step-0'],
              },
            ],
          },
        }),
      ),
    ).toMatchObject({ status: 'blocked', latestPlan: { trigger: 'replan' } });

    expect(taskRunSchema.parse(validRun())).toMatchObject({ kind: 'goal', status: 'queued' });
    expect(
      taskRunSchema.parse(
        validRun({
          kind: 'workflow',
          workflowKind: 'script',
          workflowRunId: 'wf-1',
          checkpointId: 'cp-1',
          status: 'interrupted',
        }),
      ),
    ).toMatchObject({ kind: 'workflow', workflowKind: 'script', status: 'interrupted' });
  });

  it('rejects missing fields, blank strings, illegal enums, negative versions and extra keys', () => {
    const missingVersion = validTask();
    delete (missingVersion as Record<string, unknown>).version;
    expect(() => taskSchema.parse(missingVersion)).toThrow();

    const missingRunIds = validTask();
    delete (missingRunIds as Record<string, unknown>).runIds;
    expect(() => taskSchema.parse(missingRunIds)).toThrow();

    expect(() => taskSchema.parse(validTask({ objective: '   ' }))).toThrow();
    expect(() => taskSchema.parse(validTask({ acceptanceCriteria: [''] }))).toThrow();
    expect(() => taskSchema.parse(validTask({ status: 'archived' }))).toThrow();
    expect(() => taskSchema.parse(validTask({ status: 'queued' }))).toThrow();
    expect(() => taskSchema.parse(validTask({ version: -1 }))).toThrow();
    expect(() => taskSchema.parse(validTask({ unexpected: true }))).toThrow();
    expect(() => taskSchema.parse(validTask({ task: {} }))).toThrow();

    const missingUpdatedAt = validRun();
    delete (missingUpdatedAt as Record<string, unknown>).updatedAt;
    expect(() => taskRunSchema.parse(missingUpdatedAt)).toThrow();
    expect(() => taskRunSchema.parse(validRun({ kind: 'blueprint' }))).toThrow();
    expect(() => taskRunSchema.parse(validRun({ workflowKind: 'goal' }))).toThrow();
    expect(() => taskRunSchema.parse(validRun({ status: 'pending' }))).toThrow();
    expect(() => taskRunSchema.parse(validRun({ checkpointId: '' }))).toThrow();
    expect(() => taskRunSchema.parse(validRun({ extra: 1 }))).toThrow();
  });
});

describe('Plan projection, input and policy schemas', () => {
  it('parses steps in every declared status and validates the six-state surface', () => {
    for (const status of TASK_STEP_STATUSES) {
      expect(
        taskStepSchema.parse(
          validStep({ status, evidenceIds: status === 'verified' ? ['ev-1'] : [] }),
        ),
      ).toMatchObject({ status });
    }
    expect(TASK_STEP_STATUSES).toEqual([
      'pending',
      'in_progress',
      'claimed',
      'verified',
      'failed',
      'skipped',
    ]);
  });

  function validStep(overrides: Record<string, unknown> = {}) {
    return {
      id: 'step-1',
      description: '并行审计',
      status: 'claimed',
      evidenceIds: [],
      ...overrides,
    };
  }

  it('validates plan versions and rejects unknown triggers, ids and extra keys', () => {
    expect(
      taskPlanVersionSchema.parse({
        version: 0,
        createdAt: NOW,
        trigger: 'init',
        steps: [validStep()],
      }),
    ).toMatchObject({ trigger: 'init' });
    expect(() =>
      taskPlanVersionSchema.parse({
        version: 0,
        createdAt: NOW,
        trigger: 'manual',
        steps: [],
      }),
    ).toThrow();
    expect(() =>
      taskPlanVersionSchema.parse({
        version: -1,
        createdAt: NOW,
        trigger: 'init',
        steps: [],
      }),
    ).toThrow();
    expect(() =>
      taskPlanVersionSchema.parse({
        version: 0,
        createdAt: NOW,
        trigger: 'init',
        steps: [validStep({ id: '' })],
      }),
    ).toThrow();
    expect(() =>
      taskPlanVersionSchema.parse({
        version: 0,
        createdAt: NOW,
        trigger: 'init',
        steps: [validStep({ status: 'done' })],
      }),
    ).toThrow();
    expect(() =>
      taskPlanVersionSchema.parse({
        version: 0,
        createdAt: NOW,
        trigger: 'init',
        steps: [validStep({ modelWantsVerified: true })],
      }),
    ).toThrow();
  });

  it('validates pending user input and replan policy', () => {
    expect(pendingUserInputSchema.parse({ question: '选哪个？', freeText: false, askedAt: NOW })).toMatchObject({
      freeText: false,
    });
    expect(() => pendingUserInputSchema.parse({ question: '选哪个？', askedAt: NOW })).toThrow();
    expect(() => pendingUserInputSchema.parse({ question: ' ', freeText: false, askedAt: NOW })).toThrow();
    expect(() =>
      pendingUserInputSchema.parse({ question: '选哪个？', freeText: false, askedAt: NOW, deadline: NOW }),
    ).toThrow();

    expect(
      replanPolicySchema.parse({ maxReplansPerTask: 3, minIntervalMs: 30_000, triggerThreshold: 2, tokenBudget: 200_000 }),
    ).toMatchObject({ maxReplansPerTask: 3 });
    expect(() =>
      replanPolicySchema.parse({ maxReplansPerTask: -1, minIntervalMs: 0, triggerThreshold: 2, tokenBudget: 0 }),
    ).toThrow();
    expect(() =>
      replanPolicySchema.parse({ maxReplansPerTask: 3, minIntervalMs: 0, triggerThreshold: 0, tokenBudget: 0 }),
    ).toThrow();
  });
});

describe('Workflow schemas and limits', () => {
  it('matches the documented first-version default runtime limits', () => {
    expect(DEFAULT_WORKFLOW_RUNTIME_LIMITS).toEqual({
      maxConcurrentAgents: 4,
      maxAgentsPerRun: 50,
      maxItemsPerPipeline: 500,
      maxTotalTokens: 2_000_000,
      maxDurationMs: 30 * 60_000,
      requireApproval: true,
    });
    expect(DEFAULT_WORKFLOW_RUNTIME_LIMITS.requireApproval).toBe(true);
    expect(() => workflowRuntimeLimitsSchema.parse(DEFAULT_WORKFLOW_RUNTIME_LIMITS)).not.toThrow();
  });

  it('allows maxTotalTokens 0 as unlimited but forbids zero concurrency', () => {
    expect(
      workflowRuntimeLimitsSchema.parse({
        ...DEFAULT_WORKFLOW_RUNTIME_LIMITS,
        maxTotalTokens: 0,
      }),
    ).toMatchObject({ maxTotalTokens: 0 });
    expect(() =>
      workflowRuntimeLimitsSchema.parse({
        ...DEFAULT_WORKFLOW_RUNTIME_LIMITS,
        maxConcurrentAgents: 0,
      }),
    ).toThrow();
    expect(() =>
      workflowRuntimeLimitsSchema.parse({
        ...DEFAULT_WORKFLOW_RUNTIME_LIMITS,
        requireApproval: 'yes',
      }),
    ).toThrow();
  });

  it('parses agent calls with evidence bridging and rejects unknown shapes', () => {
    expect(
      workflowAgentCallSchema.parse(validAgentCall({ status: 'completed', result: { files: ['a.ts'] } })),
    ).toMatchObject({ status: 'completed' });
    expect(
      workflowAgentCallSchema.parse(validAgentCall({ status: 'completed', evidenceId: 'ev-1', threadItemId: 'item-1' })),
    ).toMatchObject({ evidenceId: 'ev-1', threadItemId: 'item-1' });
    expect(workflowAgentCallSchema.parse(validAgentCall()).inputTokens).toBe(0);
    expect(() => workflowAgentCallSchema.parse(validAgentCall({ status: 'verified' }))).toThrow();
    expect(() => workflowAgentCallSchema.parse(validAgentCall({ prompt: '  ' }))).toThrow();
    expect(() => workflowAgentCallSchema.parse(validAgentCall({ outputTokens: -5 }))).toThrow();
    expect(() => workflowAgentCallSchema.parse(validAgentCall({ callPath: '0.1' }))).toThrow();
  });

  it('parses workflow run records and rejects missing usage or extra script fields', () => {
    expect(
      workflowRunRecordSchema.parse(
        validRunRecord({ status: 'running', agentCalls: [validAgentCall({ status: 'running' })], args: { files: ['a.ts'] } }),
      ),
    ).toMatchObject({ status: 'running', agentCalls: [{ id: 'call-1' }] });
    expect(() => workflowRunRecordSchema.parse(validRunRecord({ status: 'archived' }))).toThrow();
    expect(() => workflowRunRecordSchema.parse(validRunRecord({ script: '' }))).toThrow();
    const missingUsage = validRunRecord();
    delete (missingUsage as Record<string, unknown>).usage;
    expect(() => workflowRunRecordSchema.parse(missingUsage)).toThrow();
    expect(() => workflowRunRecordSchema.parse(validRunRecord({ resumeFrom: 'cache' }))).toThrow();
  });

  it('requires limits and estimated scale on script requests', () => {
    expect(
      workflowScriptRequestSchema.parse({
        taskId: 'task-1',
        goalRunId: 'run-1',
        objective: '并行审计全部文件',
        proposedScript: "phase('并行审计')",
        estimatedAgents: 12,
        estimatedTokens: 120_000,
        limits: DEFAULT_WORKFLOW_RUNTIME_LIMITS,
      }),
    ).toMatchObject({ estimatedAgents: 12 });
    const missingLimits = {
      taskId: 'task-1',
      goalRunId: 'run-1',
      objective: '并行审计全部文件',
      proposedScript: "phase('并行审计')",
      estimatedAgents: 12,
      estimatedTokens: 120_000,
    };
    expect(() => workflowScriptRequestSchema.parse(missingLimits)).toThrow();
    expect(() =>
      workflowScriptRequestSchema.parse({ ...missingLimits, limits: DEFAULT_WORKFLOW_RUNTIME_LIMITS, approved: true }),
    ).toThrow();
    expect(() =>
      workflowScriptRequestSchema.parse({
        ...missingLimits,
        limits: DEFAULT_WORKFLOW_RUNTIME_LIMITS,
        estimatedAgents: -1,
      }),
    ).toThrow();
  });
});

describe('Centralized event catalog (plan §14.9)', () => {
  it('declares unique dotted event names covering task, run, plan, input and workflow flows', () => {
    expect(new Set(TASK_EVENT_NAMES).size).toBe(TASK_EVENT_NAMES.length);
    for (const name of TASK_EVENT_NAMES) {
      expect(name).toMatch(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/);
      expect(isTaskEventName(name)).toBe(true);
    }
    expect(TASK_EVENT_NAMES).toContain('task.created');
    expect(TASK_EVENT_NAMES).toContain('task.run.terminal');
    expect(TASK_EVENT_NAMES).toContain('task.goal.evaluation.available');
    expect(TASK_EVENT_NAMES).toContain('task.plan.version.created');
    expect(TASK_EVENT_NAMES).toContain('task.user_input.required');
    expect(TASK_EVENT_NAMES).toContain('task.user_input.resolved');
    expect(TASK_EVENT_NAMES).toContain('workflow.request.created');
    expect(TASK_EVENT_NAMES).toContain('workflow.request.approved');
    expect(TASK_EVENT_NAMES).toContain('workflow.request.rejected');
    expect(TASK_EVENT_NAMES).toContain('workflow.run.terminal');
    expect(TASK_EVENT_NAMES).toContain('workflow.agent_call.updated');
    expect(TASK_EVENT_NAMES).toContain('workflow.agent_call.terminal');
    expect(TASK_EVENT_NAMES).toContain('workflow.result.created');
    expect(TASK_EVENT_NAMES).toContain('workflow.evidence.created');
    expect(isTaskEventName('task.deleted')).toBe(false);
    expect(TASK_EVENT_NAMES).toHaveLength(19);
  });
});
