// planProjection 纯函数测试（计划 §14.7 要求覆盖：模型引用不存在 id / 自带 id / 非法状态被拒；
// claimed-verified 派生全表；diff 正确；ReplanGate 冷却与预算；skipped 不可由模型声明）。
import { describe, expect, it } from 'vitest';
import { TaskError, DEFAULT_REPLAN_POLICY } from '@suanlizi/protocol';
import type { TaskPlanVersion, TaskStep } from '@suanlizi/protocol';
import type { HarnessPlanNode } from '../harness/types.js';
import {
  ReplanGate,
  SYSTEM_STEP_ID_PATTERN,
  claimedSignatures,
  claimedStallExceeded,
  deriveStepId,
  deriveStepStatus,
  diffPlans,
  isPlanDiffEmpty,
  isSystemStepId,
  planDiffSummary,
  projectPlan,
  projectPlanWithDiff,
  stableHashHex,
  stepProgressSignature,
  trackClaimedProgress,
} from './planProjection.js';

// ─── 测试夹具 ────────────────────────────────────────────────────────────────

function node(overrides: Partial<HarnessPlanNode> & { id: string }): HarnessPlanNode {
  return {
    description: `步骤 ${overrides.id}`,
    status: 'pending',
    evidenceIds: [],
    ...overrides,
  };
}

function plan(steps: TaskStep[], version = 0, trigger: TaskPlanVersion['trigger'] = 'init'): TaskPlanVersion {
  return { version, createdAt: '2026-09-19T00:00:00.000Z', trigger, steps };
}

function expectTaskError(action: () => unknown, code: TaskErrorCodeLike): TaskError {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(TaskError);
    expect((error as TaskError).code).toBe(code);
    return error as TaskError;
  }
  throw new Error(`expected TaskError(${code}) but nothing was thrown`);
}

type TaskErrorCodeLike = ConstructorParameters<typeof TaskError>[0];

const NOW = '2026-09-19T00:00:00.000Z';

// ─── 系统 step id 规则 ───────────────────────────────────────────────────────

describe('deriveStepId', () => {
  it('同一 localId 跨版本派生出完全相同的系统 id（稳定映射）', () => {
    const first = deriveStepId('node-1');
    const later = deriveStepId('node-1');
    expect(first).toBe(later);
    expect(isSystemStepId(first)).toBe(true);
    expect(SYSTEM_STEP_ID_PATTERN.test(first)).toBe(true);
    expect(first.startsWith('step_')).toBe(true);
  });

  it('不同 localId 派生不同系统 id；模型 localId 不会直接成为 TaskStep.id', () => {
    expect(deriveStepId('node-1')).not.toBe(deriveStepId('node-2'));
    expect(deriveStepId('node-1')).not.toBe('node-1');
  });

  it('已是系统 id 时原样返回（幂等）', () => {
    const id = deriveStepId('node-7');
    expect(deriveStepId(id)).toBe(id);
  });

  it('散列函数确定性且不依赖运行环境', () => {
    expect(stableHashHex('abc')).toBe(stableHashHex('abc'));
    expect(stableHashHex('abc')).toHaveLength(16);
    expect(stableHashHex('abc')).not.toBe(stableHashHex('abd'));
  });

  it('空 localId 直接报错', () => {
    expect(() => deriveStepId('   ')).toThrow(/non-empty/);
  });
});

// ─── projectPlan：id 治理 ────────────────────────────────────────────────────

describe('projectPlan id 治理（§14.2 / §12.2）', () => {
  it('首版：模型 localId 只作映射，输出系统 id 且 trigger/version 正确', () => {
    const result = projectPlan([node({ id: '1' }), node({ id: '2' })], {
      validEvidenceIds: new Set<string>(),
      trigger: 'init',
      now: NOW,
    });

    expect(result).toMatchObject({ version: 0, createdAt: NOW, trigger: 'init' });
    expect(result.steps.map((step) => step.id)).toEqual([deriveStepId('1'), deriveStepId('2')]);
    expect(result.steps.every((step) => isSystemStepId(step.id))).toBe(true);
  });

  it('模型引用 priorVersion 中不存在的 id → TASK_PLAN_UNKNOWN_STEP_ID', () => {
    const foreign = deriveStepId('never-published');
    expectTaskError(
      () =>
        projectPlan([node({ id: foreign })], {
          priorVersion: plan([{ id: deriveStepId('1'), description: 'x', status: 'pending', evidenceIds: [] }]),
          validEvidenceIds: new Set<string>(),
          trigger: 'replan',
        }),
      'TASK_PLAN_UNKNOWN_STEP_ID',
    );
    const error = expectTaskError(
      () =>
        projectPlan([node({ id: 'step_0000000000000000' })], {
          priorVersion: plan([]),
          validEvidenceIds: new Set<string>(),
          trigger: 'replan',
        }),
      'TASK_PLAN_UNKNOWN_STEP_ID',
    );
    expect(error.details?.stepId).toBe('step_0000000000000000');
  });

  it('模型自带 step_ 命名空间的 id（hash 不合法）→ TASK_PLAN_STEP_ID_CONFLICT', () => {
    const error = expectTaskError(
      () =>
        projectPlan([node({ id: 'step_mine' })], {
          priorVersion: plan([]),
          validEvidenceIds: new Set<string>(),
          trigger: 'replan',
        }),
      'TASK_PLAN_STEP_ID_CONFLICT',
    );
    expect(error.details?.stepId).toBe('step_mine');
  });

  it('模型自带/修改系统 id 保留字段 → TASK_PLAN_STEP_ID_CONFLICT', () => {
    expectTaskError(
      () =>
        projectPlan([{ ...node({ id: '1' }), stepId: 'step_deadbeefdeadbeef' } as never], {
          priorVersion: plan([]),
          validEvidenceIds: new Set<string>(),
          trigger: 'replan',
        }),
      'TASK_PLAN_STEP_ID_CONFLICT',
    );
    expectTaskError(
      () =>
        projectPlan([{ ...node({ id: '1' }), systemId: 'whatever' } as never], {
          priorVersion: plan([]),
          validEvidenceIds: new Set<string>(),
          trigger: 'replan',
        }),
      'TASK_PLAN_STEP_ID_CONFLICT',
    );
  });

  it('显式引用 prior 的系统 id 合法，且与 localId 派生结果撞车时判为冲突', () => {
    const priorId = deriveStepId('1');
    const referenced = projectPlan([node({ id: priorId, status: 'in_progress' })], {
      priorVersion: plan([{ id: priorId, description: '步骤 1', status: 'pending', evidenceIds: [] }]),
      validEvidenceIds: new Set<string>(),
      trigger: 'replan',
      now: NOW,
    });
    expect(referenced.steps[0]?.id).toBe(priorId);
    expect(referenced.steps[0]?.status).toBe('in_progress');

    expectTaskError(
      () =>
        projectPlan([node({ id: priorId }), node({ id: '1' })], {
          priorVersion: plan([{ id: priorId, description: '步骤 1', status: 'pending', evidenceIds: [] }]),
          validEvidenceIds: new Set<string>(),
          trigger: 'replan',
        }),
      'TASK_PLAN_STEP_ID_CONFLICT',
    );
  });

  it('同一 localId 跨版本保持稳定，新版本号递增', () => {
    const v0 = projectPlan([node({ id: '1', status: 'in_progress' }), node({ id: '2' })], {
      validEvidenceIds: new Set<string>(),
      trigger: 'init',
      now: NOW,
    });
    const v1 = projectPlan(
      [node({ id: '1', status: 'completed', evidenceIds: ['ev_a'] }), node({ id: '2' }), node({ id: '3' })],
      {
        priorVersion: v0,
        validEvidenceIds: new Set(['ev_a']),
        trigger: 'replan',
        now: '2026-09-19T00:05:00.000Z',
      },
    );

    expect(v1.version).toBe(1);
    expect(v1.steps[0].id).toBe(v0.steps[0].id);
    expect(v1.steps[1].id).toBe(v0.steps[1].id);
    expect(v1.steps[0].status).toBe('verified');
    // 时间戳一旦派生就继承，不被后续版本重刷
    expect(v1.steps[0].startedAt).toBe(NOW);
  });

  it('模型未给 id 的新步骤按描述派生，位置变化不影响 id', () => {
    const withIds = projectPlan(
      [{ ...node({ id: '' }), description: '无 id 的新步骤' } as HarnessPlanNode],
      { validEvidenceIds: new Set<string>(), trigger: 'init', now: NOW },
    );
    const reordered = projectPlan(
      [node({ id: 'a' }), { ...node({ id: '' }), description: '无 id 的新步骤' } as HarnessPlanNode],
      { validEvidenceIds: new Set<string>(), trigger: 'init', now: NOW },
    );
    expect(withIds.steps[0].id).toBe(reordered.steps[1].id);
    expect(isSystemStepId(withIds.steps[0].id)).toBe(true);
  });
});

// ─── projectPlan：状态派生全表（§14.2） ──────────────────────────────────────

describe('deriveStepStatus §14.2 映射表', () => {
  const valid = new Set(['ev_a', 'wev_r1_c1']);

  it('pending / in_progress / failed 原样映射', () => {
    expect(deriveStepStatus(node({ id: '1', status: 'pending' }), { validEvidenceIds: valid })).toBe('pending');
    expect(
      deriveStepStatus(node({ id: '1', status: 'in_progress', evidenceIds: ['ev_a'] }), {
        validEvidenceIds: valid,
      }),
    ).toBe('in_progress');
    expect(
      deriveStepStatus(node({ id: '1', status: 'failed', evidenceIds: ['ev_a'] }), {
        validEvidenceIds: valid,
      }),
    ).toBe('failed');
  });

  it('completed + 全有效证据 → verified；空/无效/混合证据 → claimed', () => {
    expect(
      deriveStepStatus(node({ id: '1', status: 'completed', evidenceIds: ['ev_a'] }), {
        validEvidenceIds: valid,
      }),
    ).toBe('verified');
    expect(
      deriveStepStatus(node({ id: '1', status: 'completed' }), { validEvidenceIds: valid }),
    ).toBe('claimed');
    expect(
      deriveStepStatus(node({ id: '1', status: 'completed', evidenceIds: ['ev_ghost'] }), {
        validEvidenceIds: valid,
      }),
    ).toBe('claimed');
    expect(
      deriveStepStatus(node({ id: '1', status: 'completed', evidenceIds: ['ev_a', 'ev_ghost'] }), {
        validEvidenceIds: valid,
      }),
    ).toBe('claimed');
  });

  it('模型声明 completed 永远不会直接产出 verified 之外的「验收级」状态：verified 只由证据有效性派生', () => {
    const result = projectPlan([node({ id: '1', status: 'completed', evidenceIds: ['ev_a'] })], {
      validEvidenceIds: new Set<string>(), // 这一版里 ev_a 无效
      trigger: 'init',
      now: NOW,
    });
    expect(result.steps[0].status).toBe('claimed');
    expect(result.steps[0].evidenceIds).toEqual(['ev_a']); // 无效证据保留原样，供 §14.4 纠错
  });

  it('skipped 只能由显式 opts 注入（localId 或系统 id 皆可），模型无法声明', () => {
    const result = projectPlan(
      [node({ id: '1', status: 'pending' }), node({ id: '2', status: 'completed', evidenceIds: ['ev_a'] })],
      {
        validEvidenceIds: new Set(['ev_a']),
        trigger: 'redirect',
        skippedLocalIds: ['1', deriveStepId('2')],
        now: NOW,
      },
    );
    expect(result.steps.map((step) => step.status)).toEqual(['skipped', 'skipped']);
    expect(result.steps[1].completedAt).toBe(NOW);

    expectTaskError(
      () =>
        projectPlan([node({ id: '1', status: 'skipped' as HarnessPlanNode['status'] })], {
          validEvidenceIds: new Set<string>(),
          trigger: 'replan',
        }),
      'TASK_INVALID_TRANSITION',
    );
    expectTaskError(
      () =>
        projectPlan([node({ id: '1', status: 'verified' as HarnessPlanNode['status'] })], {
          validEvidenceIds: new Set<string>(),
          trigger: 'replan',
        }),
      'TASK_INVALID_TRANSITION',
    );
    expectTaskError(
      () => projectPlan([node({ id: '1', status: '' as HarnessPlanNode['status'] })], {
        validEvidenceIds: new Set<string>(),
        trigger: 'replan',
      }),
      'TASK_INVALID_TRANSITION',
    );
  });

  it('projectPlan 端到端产出六态全集', () => {
    const result = projectPlan(
      [
        node({ id: 'p', status: 'pending' }),
        node({ id: 'i', status: 'in_progress' }),
        node({ id: 'c', status: 'completed', evidenceIds: ['ev_a'] }),
        node({ id: 'k', status: 'completed', evidenceIds: [] }),
        node({ id: 'f', status: 'failed', failureReason: '权限不足' }),
        node({ id: 's', status: 'completed', evidenceIds: ['ev_a'] }),
      ],
      {
        validEvidenceIds: new Set(['ev_a']),
        trigger: 'failure',
        skippedLocalIds: ['s'],
        now: NOW,
      },
    );
    expect(result.steps.map((step) => step.status)).toEqual([
      'pending',
      'in_progress',
      'verified',
      'claimed',
      'failed',
      'skipped',
    ]);
    expect(result.steps[4].failureReason).toBe('权限不足');
    expect(result.trigger).toBe('failure');
  });

  it('空描述节点是输入错误', () => {
    expect(() =>
      projectPlan([node({ id: '1', description: '   ' })], {
        validEvidenceIds: new Set<string>(),
        trigger: 'init',
      }),
    ).toThrow(/empty description/);
  });
});

// ─── diff ───────────────────────────────────────────────────────────────────

describe('diffPlans', () => {
  const idA = deriveStepId('a');
  const idB = deriveStepId('b');

  it('首版全部 added，prev 缺省视为空计划', () => {
    const v0 = projectPlan([node({ id: 'a' }), node({ id: 'b' })], {
      validEvidenceIds: new Set<string>(),
      trigger: 'init',
      now: NOW,
    });
    const diff = diffPlans(undefined, v0);
    expect(diff.added.map((step) => step.id)).toEqual([idA, idB]);
    expect(diff.removed).toEqual([]);
    expect(diff.modified).toEqual([]);
    expect(planDiffSummary(diff)).toEqual({ added: 2, removed: 0, modified: 0 });
    expect(isPlanDiffEmpty(diff)).toBe(false);
  });

  it('added / removed / modified 三类同时正确', () => {
    const v0 = plan([
      { id: idA, description: 'A', status: 'pending', evidenceIds: [] },
      { id: idB, description: 'B', status: 'in_progress', evidenceIds: [] },
    ]);
    const v1 = projectPlan(
      [node({ id: 'a', status: 'completed', evidenceIds: ['ev_a'] }), node({ id: 'c', description: 'C' })],
      { priorVersion: v0, validEvidenceIds: new Set(['ev_a']), trigger: 'replan', now: '2026-09-19T01:00:00.000Z' },
    );

    const diff = diffPlans(v0, v1);
    expect(diff.added.map((step) => step.id)).toEqual([deriveStepId('c')]);
    expect(diff.removed.map((step) => step.id)).toEqual([idB]);
    expect(diff.modified).toHaveLength(1);
    expect(diff.modified[0]).toMatchObject({
      stepId: idA,
      from: 'pending',
      to: 'verified',
      changedFields: ['status', 'description', 'evidenceIds'],
    });
    expect(projectPlanWithDiff([], { priorVersion: v0, validEvidenceIds: new Set(), trigger: 'replan' }).diff.removed)
      .toHaveLength(2);
  });

  it('只有 evidenceIds 变化也算 modified', () => {
    const v0 = plan([{ id: idA, description: 'A', status: 'claimed', evidenceIds: [] }]);
    const v1 = plan([{ id: idA, description: 'A', status: 'claimed', evidenceIds: ['ev_a'] }], 1, 'replan');
    const diff = diffPlans(v0, v1);
    expect(diff.modified[0]?.changedFields).toEqual(['evidenceIds']);
  });

  it('完全一致时 diff 为空', () => {
    const v0 = plan([{ id: idA, description: 'A', status: 'pending', evidenceIds: [] }]);
    const v1 = plan([{ id: idA, description: 'A', status: 'pending', evidenceIds: [] }], 1, 'replan');
    expect(isPlanDiffEmpty(diffPlans(v0, v1))).toBe(true);
  });
});

// ─── ReplanGate（§5.2 预算 / 冷却 / 阈值） ───────────────────────────────────

describe('ReplanGate', () => {
  const policy = { maxReplansPerTask: 2, minIntervalMs: 30_000, triggerThreshold: 2, tokenBudget: 1000 };

  it('缺省策略取 protocol 的 DEFAULT_REPLAN_POLICY', () => {
    const gate = new ReplanGate();
    expect(gate.policy).toEqual(DEFAULT_REPLAN_POLICY);
  });

  it('停滞信号未达阈值 → trigger_not_met', () => {
    const gate = new ReplanGate(policy);
    const decision = gate.allowReplan({ noProgressCount: 1 }, 1_000_000);
    expect(decision).toMatchObject({ allowed: false, reason: 'trigger_not_met', remainingReplans: 2 });
  });

  it('达阈值且预算/冷却均满足 → allowed', () => {
    const gate = new ReplanGate(policy);
    const decision = gate.allowReplan({ noProgressCount: 2 }, 1_000_000);
    expect(decision.allowed).toBe(true);
    expect(decision.reason).toBe('allowed');
  });

  it('冷却窗口内拒绝并给出 retryAfterMs', () => {
    const gate = new ReplanGate(policy);
    const history = { attempts: [{ atMs: 1_000_000, trigger: 'replan' as const, tokensUsed: 10 }], noProgressCount: 5 };
    const decision = gate.allowReplan(history, 1_020_000);
    expect(decision).toMatchObject({ allowed: false, reason: 'cooldown', remainingReplans: 1 });
    expect(decision.retryAfterMs).toBe(10_000);
    expect(gate.allowReplan(history, 1_030_000).allowed).toBe(true);
  });

  it('预算用尽 → budget_exhausted（优先于冷却）', () => {
    const gate = new ReplanGate(policy);
    const history = {
      attempts: [
        { atMs: 900_000, trigger: 'replan' as const },
        { atMs: 1_000_000, trigger: 'failure' as const },
      ],
      noProgressCount: 9,
    };
    expect(gate.allowReplan(history, 1_000_001)).toMatchObject({
      allowed: false,
      reason: 'budget_exhausted',
      remainingReplans: 0,
    });
  });

  it('token 预算用尽 → token_budget_exhausted', () => {
    const gate = new ReplanGate(policy);
    const decision = gate.allowReplan(
      { attempts: [{ atMs: 1, trigger: 'replan' }], noProgressCount: 3, tokensUsed: 1000 },
      5_000_000,
    );
    expect(decision).toMatchObject({ allowed: false, reason: 'token_budget_exhausted' });
  });

  it('tokensUsed 缺省由 attempts 求和', () => {
    const gate = new ReplanGate({ ...policy, maxReplansPerTask: 5 });
    const decision = gate.allowReplan(
      { attempts: [{ atMs: 1, trigger: 'replan' as const, tokensUsed: 1000 }], noProgressCount: 3 },
      5_000_000,
    );
    expect(decision.reason).toBe('token_budget_exhausted');
  });

  it('withAttempt 不可变地累加历史；now 支持 ISO 字符串与 Date', () => {
    // 预算拉到 5，避开 budget_exhausted 对 allowed 的干扰
    const gate = new ReplanGate({ ...policy, maxReplansPerTask: 5 });
    const history = ReplanGate.withAttempt(
      ReplanGate.withAttempt({ noProgressCount: 2 }, { atMs: 1_000_000, trigger: 'replan', tokensUsed: 5 }),
      { atMs: 1_050_000, trigger: 'failure', tokensUsed: 7 },
    );
    expect(history.attempts).toHaveLength(2);
    expect(history.tokensUsed).toBe(12);
    expect(
      gate.allowReplan({ ...history, noProgressCount: 3 }, new Date(1_080_000).getTime()).allowed,
    ).toBe(true);
    expect(gate.allowReplan({ noProgressCount: 3 }, '1970-01-01T00:18:00.000Z').allowed).toBe(true);
    expect(() => gate.allowReplan({}, 'not-a-time')).toThrow(/invalid "now"/);
  });

  it('非法策略被 protocol 的 zod 契约拒绝', () => {
    expect(() => new ReplanGate({ maxReplansPerTask: -1 })).toThrow();
    expect(() => new ReplanGate({ triggerThreshold: 0 })).toThrow();
  });
});

// ─── claimed 纠错路径计数（§14.4） ───────────────────────────────────────────

describe('trackClaimedProgress', () => {
  const idA = deriveStepId('a');
  const idB = deriveStepId('b');

  function claimedPlan(evidenceIds: string[]): TaskPlanVersion {
    return plan([
      { id: idA, description: 'A', status: 'claimed', evidenceIds },
      { id: idB, description: 'B', status: 'verified', evidenceIds: ['ev_a'] },
    ]);
  }

  it('只有 claimed 步骤进入签名集合', () => {
    const signatures = claimedSignatures(claimedPlan([]));
    expect(Object.keys(signatures)).toEqual([idA]);
    expect(signatures[idA]).toBe(stepProgressSignature(claimedPlan([]).steps[0]));
  });

  it('首轮建基线：noProgressCount 为 0', () => {
    const snapshot = trackClaimedProgress(null, claimedSignatures(claimedPlan([])));
    expect(snapshot).toMatchObject({ progressed: false, noProgressCount: 0 });
    expect(snapshot.counters[idA]).toBeUndefined();
  });

  it('签名不变则累加，per-step counter 与 staleStepIds 同步', () => {
    const first = trackClaimedProgress(null, claimedSignatures(claimedPlan([])));
    const second = trackClaimedProgress(first, claimedSignatures(claimedPlan([])));
    const third = trackClaimedProgress(second, claimedSignatures(claimedPlan([])));

    expect(second.noProgressCount).toBe(1);
    expect(third.noProgressCount).toBe(2);
    expect(third.counters[idA]).toBe(2);
    expect(third.staleStepIds).toEqual([idA]);
    expect(claimedStallExceeded(third, idA, 2)).toBe(true);
    expect(claimedStallExceeded(third, idA, 3)).toBe(false);
  });

  it('补上有效证据（claimed → verified）视为有进展，计数清零', () => {
    const first = trackClaimedProgress(null, claimedSignatures(claimedPlan([])));
    const second = trackClaimedProgress(first, claimedSignatures(claimedPlan([])));
    const upgraded = trackClaimedProgress(second, claimedSignatures(claimedPlan(['ev_a'])));

    expect(second.noProgressCount).toBe(1);
    expect(upgraded.progressed).toBe(true);
    expect(upgraded.noProgressCount).toBe(0);
    expect(upgraded.counters).toEqual({});
    // claimed 集合清空本身是一次变化（progressed），计数不累加
    expect(trackClaimedProgress(upgraded, {}).noProgressCount).toBe(0);
    // 持续没有任何 claimed 步骤 ⇒ 停滞信号不成立（不伪造无进展）
    const empty = trackClaimedProgress(null, {});
    expect(empty.noProgressCount).toBe(0);
    expect(trackClaimedProgress(empty, {}).noProgressCount).toBe(0);
    expect(trackClaimedProgress(empty, {}).counters).toEqual({});
  });

  it('证据集合顺序不同但内容相同 ⇒ 签名一致（顺序无关）', () => {
    const stepOne: TaskStep = {
      id: idA,
      description: 'A',
      status: 'claimed',
      evidenceIds: ['ev_x', 'ev_y'],
    };
    const stepTwo: TaskStep = { ...stepOne, evidenceIds: ['ev_y', 'ev_x'] };
    expect(stepProgressSignature(stepOne)).toBe(stepProgressSignature(stepTwo));
  });
});
