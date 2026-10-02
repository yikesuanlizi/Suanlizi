// P3 计划投影接线层测试（计划 §7 P3 验收条款）：
// - 模型引用不存在 id / 伪造系统 id / 非法状态 → 投影被拒，保留上一版（fail-closed）；
// - claimed 无法升级 verified，除非存在有效（passed）Evidence；
// - ReplanGate 预算/冷却/触发阈值在接线层真实生效；
// - ```plan 提取覆盖正常、非法 JSON、未闭合、保留字段。
import { describe, expect, it } from 'vitest';
import type { ThreadItem } from '@suanlizi/protocol';
import { TaskError } from '@suanlizi/protocol';
import type { EvidenceReceipt } from './types.js';
import {
  extractPlanFromItems,
  HarnessPlanSync,
  toHarnessNodes,
  validEvidenceIdsFromReceipts,
} from './planSync.js';

function agentMessage(text: string): ThreadItem {
  return { type: 'agent_message', text } as unknown as ThreadItem;
}

function receipt(id: string, status: EvidenceReceipt['status'] = 'passed'): EvidenceReceipt {
  return {
    id,
    threadId: 't1' as never,
    sourceKind: 'thread_item',
    harnessRunId: '',
    kind: 'command',
    summary: id,
    refs: {},
    supportsCriteria: [],
    status,
    timestamp: '2026-01-01T00:00:00.000Z',
  };
}

function baseOpts(evidence: string[] = []) {
  return {
    validEvidenceIds: new Set(evidence),
    nowMs: 1_000_000,
    noProgressCount: 2,
  };
}

describe('extractPlanFromItems', () => {
  it('无计划块返回 null', () => {
    expect(extractPlanFromItems([agentMessage('普通回复')])).toBeNull();
  });

  it('合法计划块解析为节点（localId 可省略）', () => {
    const items = [
      agentMessage('前置讨论'),
      agentMessage('```plan\n[{"id":"auth","description":"实现登录","status":"in_progress"}]\n```'),
    ];
    const result = extractPlanFromItems(items);
    expect(result).not.toBeNull();
    expect(result!.error).toBeUndefined();
    expect(result!.nodes).toHaveLength(1);
    expect(result!.nodes[0]).toMatchObject({ id: 'auth', description: '实现登录', status: 'in_progress' });
  });

  it('非法 JSON 返回 error 且不抛出', () => {
    const result = extractPlanFromItems([agentMessage('```plan\n{not json}\n```')]);
    expect(result).not.toBeNull();
    expect(result!.error).toContain('not valid JSON');
  });

  it('未闭合代码块返回 error', () => {
    const result = extractPlanFromItems([agentMessage('```plan\n[{"description":"x"}]')]);
    expect(result!.error).toContain('not closed');
  });

  it('携带保留系统 id 字段被拒绝', () => {
    const result = extractPlanFromItems([
      agentMessage('```plan\n[{"description":"x","stepId":"step_abc"}]\n```'),
    ]);
    expect(result!.error).toContain('reserved system id');
  });
});

describe('validEvidenceIdsFromReceipts', () => {
  it('只收 passed 收据；failed/unknown 不算有效证据', () => {
    const ids = validEvidenceIdsFromReceipts([
      receipt('ev_a', 'passed'),
      receipt('ev_b', 'failed'),
      receipt('ev_c', 'unknown'),
      receipt('', 'passed'),
    ]);
    expect(ids.has('ev_a')).toBe(true);
    expect(ids.has('ev_b')).toBe(false);
    expect(ids.has('ev_c')).toBe(false);
    expect(ids.has('')).toBe(false);
  });
});

describe('HarnessPlanSync.applyModelPlan', () => {
  it('首版计划直通投影（trigger=init，不消耗 replan 预算）', () => {
    const sync = new HarnessPlanSync();
    const outcome = sync.applyModelPlan(
      [{ id: 'a', description: '步骤A', status: 'completed', evidenceIds: ['ev_1'] }],
      baseOpts(['ev_1']),
    );
    expect(outcome.applied).toBe(true);
    if (outcome.applied) {
      expect(outcome.first).toBe(true);
      expect(outcome.plan.version).toBe(0);
      expect(outcome.plan.steps[0].status).toBe('verified');
    }
    // 首版后历史为空：未记录任何 replan attempt。
    expect(sync.getReplanHistory().attempts ?? []).toHaveLength(0);
  });

  it('模型声明 completed 但无有效证据 → 只能 claimed（§14.4）', () => {
    const sync = new HarnessPlanSync();
    const outcome = sync.applyModelPlan(
      [{ id: 'a', description: '步骤A', status: 'completed', evidenceIds: [] }],
      baseOpts(['ev_1']),
    );
    expect(outcome.applied).toBe(true);
    if (outcome.applied) expect(outcome.plan.steps[0].status).toBe('claimed');
  });

  it('failed 证据不得支撑 verified', () => {
    const sync = new HarnessPlanSync();
    const outcome = sync.applyModelPlan(
      [{ id: 'a', description: '步骤A', status: 'completed', evidenceIds: ['ev_bad'] }],
      baseOpts([]),
    );
    expect(outcome.applied).toBe(true);
    if (outcome.applied) expect(outcome.plan.steps[0].status).toBe('claimed');
  });

  it('后续计划触发阈值未满足 → denied（trigger_not_met），不消耗预算', () => {
    const sync = new HarnessPlanSync();
    sync.applyModelPlan(
      [{ id: 'a', description: '步骤A', status: 'pending', evidenceIds: [] }],
      baseOpts(),
    );
    const second = sync.applyModelPlan(
      [{ id: 'a', description: '步骤A改', status: 'pending', evidenceIds: [] }],
      { validEvidenceIds: new Set<string>(), nowMs: 2_000_000, noProgressCount: 0, claimedStreak: 0 },
    );
    expect(second.applied).toBe(false);
    if (!second.applied && second.reason === 'denied') {
      expect(second.decision.reason).toBe('trigger_not_met');
    }
    expect(sync.getReplanHistory().attempts ?? []).toHaveLength(0);
  });

  it('模型引用不存在 step id → rejected（fail-closed 保留上一版）', () => {
    const sync = new HarnessPlanSync();
    const first = sync.applyModelPlan(
      [{ id: 'a', description: '步骤A', status: 'pending', evidenceIds: [] }],
      baseOpts(),
    );
    expect(first.applied).toBe(true);
    const second = sync.applyModelPlan(
      [{ id: 'step_deadbeefdeadbeef', description: '伪造系统 id', status: 'pending', evidenceIds: [] }],
      { validEvidenceIds: new Set<string>(), nowMs: 2_000_000, noProgressCount: 5 },
    );
    expect(second.applied).toBe(false);
    if (!second.applied && second.reason === 'rejected') {
      expect(second.error).toContain('TASK_PLAN_UNKNOWN_STEP_ID');
    }
    // 上一版保留。
    expect(sync.getPriorVersion()?.steps[0].description).toBe('步骤A');
  });

  it('伪造 step_ 命名空间 → rejected（TASK_PLAN_STEP_ID_CONFLICT）', () => {
    const sync = new HarnessPlanSync();
    sync.applyModelPlan(
      [{ id: 'a', description: '步骤A', status: 'pending', evidenceIds: [] }],
      baseOpts(),
    );
    const second = sync.applyModelPlan(
      [{ id: 'step_notahash', description: '冒充系统 id', status: 'pending', evidenceIds: [] }],
      { validEvidenceIds: new Set<string>(), nowMs: 2_000_000, noProgressCount: 5 },
    );
    expect(second.applied).toBe(false);
    if (!second.applied && second.reason === 'rejected') {
      expect(second.error).toContain('TASK_PLAN_STEP_ID_CONFLICT');
    }
  });

  it('内容完全一致的计划 → unchanged，不消耗预算', () => {
    const sync = new HarnessPlanSync();
    const nodes = [{ id: 'a', description: '步骤A', status: 'pending' as const, evidenceIds: [] as string[] }];
    sync.applyModelPlan(nodes, baseOpts());
    const second = sync.applyModelPlan(nodes, {
      validEvidenceIds: new Set<string>(),
      nowMs: 2_000_000,
      noProgressCount: 5,
    });
    expect(second.applied).toBe(false);
    if (!second.applied) expect(second.reason).toBe('unchanged');
    expect(sync.getReplanHistory().attempts ?? []).toHaveLength(0);
  });

  it('replan 预算耗尽 → denied（budget_exhausted）', () => {
    const sync = new HarnessPlanSync();
    sync.applyModelPlan(
      [{ id: 'a', description: '步骤A', status: 'pending', evidenceIds: [] }],
      baseOpts(),
    );
    // 依次提交 3 次会消耗全部默认预算（3），间隔与 stall 信号均满足。
    for (let i = 0; i < 3; i += 1) {
      const outcome = sync.applyModelPlan(
        [{ id: 'a', description: `步骤A v${i + 2}`, status: 'pending', evidenceIds: [] }],
        { validEvidenceIds: new Set<string>(), nowMs: 2_000_000 + i * 60_000, noProgressCount: 5 },
      );
      expect(outcome.applied).toBe(true);
    }
    const fifth = sync.applyModelPlan(
      [{ id: 'a', description: '步骤A v5', status: 'pending', evidenceIds: [] }],
      { validEvidenceIds: new Set<string>(), nowMs: 5_000_000, noProgressCount: 5 },
    );
    expect(fifth.applied).toBe(false);
    if (!fifth.applied && fifth.reason === 'denied') {
      expect(fifth.decision.reason).toBe('budget_exhausted');
    }
  });

  it('claimProgress：签名未变的 claimed 步骤累计 stall，签名变化清零', () => {
    const sync = new HarnessPlanSync();
    sync.applyModelPlan(
      [{ id: 'a', description: '步骤A', status: 'completed', evidenceIds: [] }],
      baseOpts(),
    );
    const first = sync.claimProgress();
    expect(first.progressed).toBe(false); // 首次快照不判进展
    expect(first.trackedStepIds).toHaveLength(1);

    // 第二次观测同一签名 → stall 计数 1。
    const second = sync.claimProgress();
    expect(second.progressed).toBe(false);
    expect(second.noProgressCount).toBe(1);

    // 计划变化（补上有效证据 → verified，不再是 claimed）→ tracked 集合为空。
    sync.applyModelPlan(
      [{ id: 'a', description: '步骤A', status: 'completed', evidenceIds: ['ev_1'] }],
      { validEvidenceIds: new Set(['ev_1']), nowMs: 2_000_000, noProgressCount: 5 },
    );
    const third = sync.claimProgress();
    expect(third.trackedStepIds).toHaveLength(0);
    expect(third.noProgressCount).toBe(0);
  });
});

describe('toHarnessNodes', () => {
  it('verified/claimed/skipped 回映射为 completed，failed/pending 原样', () => {
    const sync = new HarnessPlanSync();
    sync.applyModelPlan(
      [
        { id: 'a', description: 'A', status: 'completed', evidenceIds: ['ev_1'] },
        { id: 'b', description: 'B', status: 'completed', evidenceIds: [] },
        { id: 'c', description: 'C', status: 'pending', evidenceIds: [] },
        { id: 'd', description: 'D', status: 'failed', evidenceIds: [] },
      ],
      baseOpts(['ev_1']),
    );
    const version = sync.getPriorVersion();
    if (!version) throw new TaskError('TASK_NOT_FOUND', 'plan missing');
    // skipped 由用户 redirect 注入，这里直接改投影版本模拟。
    version.steps[2].status = 'skipped';
    const nodes = toHarnessNodes(version);
    expect(nodes.map((n) => n.status)).toEqual(['completed', 'completed', 'completed', 'failed']);
    expect(nodes[0].id).toBe(version.steps[0].id);
  });
});
