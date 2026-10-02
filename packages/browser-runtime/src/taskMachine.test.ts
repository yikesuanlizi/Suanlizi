// 浏览器任务状态机测试：折叠、非法转换、预算、取消、检查点/恢复、连续失败、人工接管
// — English: browser task state machine tests — folding, illegal transitions,
//   budget, cancellation, checkpoint/restore, consecutive failures, human takeover
import { describe, expect, it } from 'vitest';
import type { ActionRecord, BrowserTaskEvent, HumanRequest, PlanStep } from '@suanlizi/protocol';
import {
  BudgetExceededError,
  BrowserTaskMachine,
  DEFAULT_TASK_BUDGET,
  foldBrowserTaskEvents,
} from './taskMachine.js';

const PLAN: PlanStep[] = [
  { stepId: 's1', description: 'open target page', status: 'running' },
  { stepId: 's2', description: 'fill the form', status: 'pending' },
];

function makeRecord(actionId: string): ActionRecord {
  return {
    actionId,
    taskId: 'task-1',
    actionDigest: 'sha256:deadbeef',
    effect: 'local',
    status: 'prepared',
    preState: {
      pageId: 'p1',
      url: 'https://example.com',
      observationId: 'obs-1',
      navigationEpoch: 1,
    },
    expectedPostcondition: { kind: 'navigation_epoch_changed' },
    preparedAt: 1_700_000_000_000,
    evidenceRefs: [],
  };
}

describe('foldBrowserTaskEvents', () => {
  it('按序折叠事件为状态，终态后的事件忽略', () => {
    const events: BrowserTaskEvent[] = [
      { type: 'task.created', taskId: 'task-1', goal: 'do the thing', createdAt: '2026-01-01T00:00:00.000Z' },
      { type: 'plan.updated', taskId: 'task-1', plan: PLAN, updatedAt: '2026-01-01T00:00:01.000Z' },
      { type: 'action.completed', taskId: 'task-1', actionId: 'a1', outcome: 'failed', evidenceRefs: [], completedAt: '2026-01-01T00:00:02.000Z' },
      { type: 'task.completed', taskId: 'task-1', summary: 'done', completedAt: '2026-01-01T00:00:03.000Z' },
      // 终态之后的事件被忽略
      // — English: events after the terminal state are ignored
      { type: 'task.cancelled', taskId: 'task-1', reason: 'too late', cancelledAt: '2026-01-01T00:00:04.000Z' },
    ];
    const state = foldBrowserTaskEvents(events);
    expect(state.status).toBe('completed');
    expect(state.taskId).toBe('task-1');
    expect(state.plan).toEqual(PLAN);
    expect(state.usage.consecutiveFailures).toBe(1);
    expect(state.usage.steps).toBe(0);
  });

  it('initial 参数支持从已有状态继续折叠', () => {
    const seed: BrowserTaskEvent[] = [
      { type: 'task.created', taskId: 'task-1', goal: 'g', createdAt: '2026-01-01T00:00:00.000Z' },
    ];
    const base = foldBrowserTaskEvents(seed);
    const more: BrowserTaskEvent[] = [
      { type: 'plan.updated', taskId: 'task-1', plan: PLAN, updatedAt: '2026-01-01T00:00:01.000Z' },
    ];
    const state = foldBrowserTaskEvents(more, base);
    expect(state.taskId).toBe('task-1');
    expect(state.status).toBe('running');
    expect(state.plan).toEqual(PLAN);
  });
});

describe('BrowserTaskMachine', () => {
  it('完整事件序列：start→reserve→updatePlan→observe→prepare→complete(committed)→complete', () => {
    const machine = new BrowserTaskMachine({ taskId: 'task-1', goal: 'do the thing' });
    machine.start();
    machine.reserve({ steps: 1 });
    machine.updatePlan(PLAN);
    machine.acceptObservation({ observationId: 'obs-1', pageId: 'p1', navigationEpoch: 1, elementCount: 5 });
    machine.prepareAction(makeRecord('act-1'));
    machine.completeAction({ actionId: 'act-1', outcome: 'committed', evidenceRefs: ['ev-1'] });
    machine.complete('done');

    const state = machine.state;
    expect(state.status).toBe('completed');
    expect(state.taskId).toBe('task-1');
    expect(state.goal).toBe('do the thing');
    // usage.steps 由 reserve 设置
    // — English: usage.steps is set by reserve
    expect(state.usage.steps).toBe(1);
    expect(state.usage.consecutiveFailures).toBe(0);
    expect(state.plan).toEqual(PLAN);
    expect(state.failure).toBeUndefined();
    expect(machine.events.map((e) => e.type)).toEqual([
      'task.created',
      'budget.updated',
      'plan.updated',
      'observation.accepted',
      'action.prepared',
      'action.completed',
      'task.completed',
    ]);
  });

  it('非法转换抛错：无 task.created、终态后 apply、cancel 后 completeAction', () => {
    // 无 task.created 先 updatePlan
    // — English: updatePlan before task.created
    const machine = new BrowserTaskMachine({ taskId: 'task-1', goal: 'g' });
    expect(() => machine.updatePlan(PLAN)).toThrow(/task\.created/);

    // completed 终态后再 apply
    // — English: apply after completed
    const finished = new BrowserTaskMachine({ taskId: 'task-1', goal: 'g' });
    finished.start();
    finished.complete('done');
    expect(finished.state.status).toBe('completed');
    expect(() => finished.updatePlan(PLAN)).toThrow('terminal state');
    expect(() => finished.reserve({ steps: 1 })).toThrow('terminal state');

    // cancel 后 completeAction（apply 层面）
    // — English: completeAction after cancel
    const cancelled = new BrowserTaskMachine({ taskId: 'task-1', goal: 'g' });
    cancelled.start();
    cancelled.cancel('enough');
    expect(cancelled.state.status).toBe('cancelled');
    expect(() => cancelled.completeAction({ actionId: 'a1', outcome: 'committed', evidenceRefs: [] })).toThrow('terminal state');
  });

  it('预算：maxSteps=2 时第二次超额 reserve 抛 BudgetExceededError(resource=steps)', () => {
    const machine = new BrowserTaskMachine({
      taskId: 'task-1',
      goal: 'g',
      budget: { ...DEFAULT_TASK_BUDGET, maxSteps: 2 },
    });
    machine.start();
    machine.reserve({ steps: 2 });
    expect(machine.state.usage.steps).toBe(2);
    expect(machine.canReserve({ steps: 1 })).toBe(false);

    let error: unknown;
    try {
      machine.reserve({ steps: 1 });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(BudgetExceededError);
    expect((error as BudgetExceededError).resource).toBe('steps');
    // 失败不落账
    // — English: failed reservation does not change usage
    expect(machine.state.usage.steps).toBe(2);
  });

  it('取消：cancel() 置终态且幂等；AbortSignal abort 自动取消', () => {
    const machine = new BrowserTaskMachine({ taskId: 'task-1', goal: 'g' });
    machine.start();
    machine.cancel('enough');
    expect(machine.state.status).toBe('cancelled');
    // 幂等：已终态静默忽略
    // — English: idempotent — silently ignored when terminal
    expect(() => machine.cancel('again')).not.toThrow();
    expect(machine.state.status).toBe('cancelled');

    const controller = new AbortController();
    const aborted = new BrowserTaskMachine({ taskId: 'task-1', goal: 'g', signal: controller.signal });
    aborted.start();
    expect(aborted.state.status).toBe('running');
    controller.abort();
    expect(aborted.state.status).toBe('cancelled');
  });

  it('构造时传入已 aborted 的 signal：直接进入 cancelled 终态且不抛错', () => {
    const controller = new AbortController();
    controller.abort();
    const machine = new BrowserTaskMachine({ taskId: 'task-1', goal: 'g', signal: controller.signal });
    expect(machine.state.status).toBe('cancelled');
    // 终态后所有操作被拒绝
    // — English: everything is rejected after the terminal state
    expect(() => machine.start()).toThrow('terminal state');
  });

  it('maxConsecutiveFailures 预算：连续失败超过上限抛 BudgetExceededError', () => {
    const machine = new BrowserTaskMachine({
      taskId: 'task-1',
      goal: 'g',
      budget: { ...DEFAULT_TASK_BUDGET, maxConsecutiveFailures: 2 },
    });
    machine.start();
    machine.completeAction({ actionId: 'a1', outcome: 'failed', evidenceRefs: [] });
    machine.completeAction({ actionId: 'a2', outcome: 'failed', evidenceRefs: [] });
    expect(machine.state.usage.consecutiveFailures).toBe(2);
    expect(() => machine.completeAction({ actionId: 'a3', outcome: 'failed', evidenceRefs: [] }))
      .toThrow(BudgetExceededError);
    // committed 先清零后可继续失败
    // — English: a committed outcome resets the counter and failures may resume
    machine.completeAction({ actionId: 'a4', outcome: 'committed', evidenceRefs: [] });
    machine.completeAction({ actionId: 'a5', outcome: 'failed', evidenceRefs: [] });
    expect(machine.state.usage.consecutiveFailures).toBe(1);
  });

  it('budget.updated 防伪：回退 usage 或超限的事件被拒绝', () => {
    const machine = new BrowserTaskMachine({ taskId: 'task-1', goal: 'g' });
    machine.start();
    machine.reserve({ steps: 1 });
    // 伪造回退：steps 从 1 变 0
    // — English: forged rollback — steps from 1 back to 0
    expect(() => machine.apply({
      type: 'budget.updated',
      taskId: 'task-1',
      usage: { steps: 0, tokens: 0, replans: 0, consecutiveFailures: 0, externalWrites: 0, downloadBytes: 0, startedAt: 0 },
      updatedAt: '2026-01-01T00:00:00.000Z',
    })).toThrow(/cannot decrease/);
    // 伪造超限（startedAt 保持当前值，只让 steps 超限）
    // — English: forged over-budget (startedAt kept, only steps exceeds)
    expect(() => machine.apply({
      type: 'budget.updated',
      taskId: 'task-1',
      usage: { steps: 1000, tokens: 0, replans: 0, consecutiveFailures: 0, externalWrites: 0, downloadBytes: 0, startedAt: machine.state.usage.startedAt },
      updatedAt: '2026-01-01T00:00:00.000Z',
    })).toThrow(BudgetExceededError);
    // 伪造 startedAt 回退（置 0 会永久绕过时长预算）
    // — English: forged startedAt rollback would bypass the duration budget
    const current = machine.state.usage;
    expect(() => machine.apply({
      type: 'budget.updated',
      taskId: 'task-1',
      usage: { ...current, startedAt: 0 },
      updatedAt: '2026-01-01T00:00:00.000Z',
    })).toThrow(/cannot decrease/);
    expect(machine.state.usage.steps).toBe(1);
  });

  it('直接 apply action.completed(failed) 同样受连续失败预算约束', () => {
    const machine = new BrowserTaskMachine({
      taskId: 'task-1',
      goal: 'g',
      budget: { ...DEFAULT_TASK_BUDGET, maxConsecutiveFailures: 1 },
    });
    machine.start();
    machine.completeAction({ actionId: 'a1', outcome: 'failed', evidenceRefs: [] });
    // 绕过便捷方法直接注入
    // — English: bypass the convenience method and inject the event directly
    expect(() => machine.apply({
      type: 'action.completed',
      taskId: 'task-1',
      actionId: 'a2',
      outcome: 'failed',
      evidenceRefs: [],
      completedAt: '2026-01-01T00:00:00.000Z',
    })).toThrow(BudgetExceededError);
  });

  it('reserve 拒绝负增量；事件 taskId 不匹配被拒绝', () => {
    const machine = new BrowserTaskMachine({ taskId: 'task-1', goal: 'g' });
    machine.start();
    expect(() => machine.reserve({ steps: -1 })).toThrow(/negative/);
    expect(() => machine.apply({
      type: 'plan.updated',
      taskId: 'other-task',
      plan: [],
      updatedAt: '2026-01-01T00:00:00.000Z',
    })).toThrow(/taskId mismatch/);
    expect(machine.state.usage.steps).toBe(0);
  });

  it('checkpoint/restore：状态等价、running 与 startedAt 恢复、可继续操作', () => {
    const machine = new BrowserTaskMachine({ taskId: 'task-1', goal: 'g' });
    machine.start();
    machine.reserve({ steps: 1 });
    machine.updatePlan(PLAN);
    machine.completeAction({ actionId: 'a1', outcome: 'committed', evidenceRefs: [] });

    const checkpoint = machine.checkpoint();
    const restored = BrowserTaskMachine.restore({ taskId: 'task-1', goal: 'g', events: checkpoint.events });

    expect(restored.events).toEqual(checkpoint.events);
    expect(restored.state).toEqual(checkpoint.state);
    // task.created 折叠为 running，startedAt 从事件时间恢复（时长预算恢复后依然生效）
    // — English: task.created folds to running; startedAt restored from the event
    expect(restored.state.status).toBe('running');
    expect(restored.state.usage.startedAt).toBeGreaterThan(0);
    expect(restored.state.usage.startedAt).toBe(checkpoint.state.usage.startedAt);

    // 恢复后继续 reserve / completeAction 正常
    // — English: reserve / completeAction keep working after restore
    restored.reserve({ steps: 1 });
    restored.completeAction({ actionId: 'a2', outcome: 'failed', evidenceRefs: [] });
    expect(restored.state.usage.steps).toBe(2);
    expect(restored.state.usage.consecutiveFailures).toBe(1);
  });

  it('consecutiveFailures：连续 failed 递增，committed 清零', () => {
    const machine = new BrowserTaskMachine({ taskId: 'task-1', goal: 'g' });
    machine.start();
    machine.completeAction({ actionId: 'a1', outcome: 'failed', evidenceRefs: [] });
    machine.completeAction({ actionId: 'a2', outcome: 'failed', evidenceRefs: [] });
    expect(machine.state.usage.consecutiveFailures).toBe(2);
    machine.completeAction({ actionId: 'a3', outcome: 'committed', evidenceRefs: [] });
    expect(machine.state.usage.consecutiveFailures).toBe(0);
  });

  it('human 流程：requestHuman→waiting+wait.human；resolveHuman(approved:false)→running 且清除 wait', () => {
    const machine = new BrowserTaskMachine({ taskId: 'task-1', goal: 'g' });
    machine.start();
    const request: HumanRequest = {
      requestId: 'req-1',
      taskId: 'task-1',
      type: 'confirm',
      prompt: 'Proceed with the irreversible action?',
      timeoutMs: 30_000,
      onTimeout: 'extend',
    };
    machine.requestHuman(request);
    expect(machine.state.status).toBe('waiting');
    expect(machine.state.wait).toMatchObject({ kind: 'human', requestId: 'req-1' });
    expect(machine.state.wait?.since).toBeGreaterThan(0);

    machine.resolveHuman({ requestId: 'req-1', approved: false, reason: 'not now' });
    expect(machine.state.status).toBe('running');
    expect(machine.state.wait).toBeUndefined();
  });
});
