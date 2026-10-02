// P3 证据硬校验 gate 测试（计划 §7 P3 验收条款）：
// - GoalEvaluator 的 criteriaEvidenceMap：引用不存在的 criterion / evidence id → fail-closed；
// - ReadinessCritic：kind 白名单外的证据不得支撑 criteria / mutation 验收。
import { describe, expect, it } from 'vitest';
import type { ThreadItem } from '@suanlizi/protocol';
import { GoalEvaluator, type EvaluatorModelGateway } from './goalEvaluator.js';
import { ReadinessCritic } from './readinessCritic.js';
import type { EvidenceLedger } from './evidenceLedger.js';
import type { EvidenceReceipt, HarnessState } from './types.js';

function makeState(): HarnessState {
  return {
    harnessRunId: 'hrun_test',
    goal: {
      objective: '完成功能',
      acceptanceCriteria: ['测试通过', '文档更新'],
      maxContinuations: 8,
      maxNoProgress: 2,
    },
    plan: [],
    activeNodeId: null,
    iteration: 1,
    noProgressCount: 0,
    lastEvaluation: null,
    lastProgressSignature: null,
    status: 'active',
    startedAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function receipt(id: string, kind: EvidenceReceipt['kind'] = 'command'): EvidenceReceipt {
  return {
    id,
    threadId: 't1' as never,
    sourceKind: 'thread_item',
    harnessRunId: '',
    kind,
    summary: id,
    refs: {},
    supportsCriteria: [],
    status: 'passed',
    timestamp: '2026-01-01T00:00:00.000Z',
  };
}

function evaluatorReturning(raw: string): GoalEvaluator {
  const gateway: EvaluatorModelGateway = {
    async completeOnce() {
      return raw;
    },
  };
  return new GoalEvaluator(gateway);
}

describe('GoalEvaluator criteriaEvidenceMap 硬校验', () => {
  const validRaw = JSON.stringify({
    satisfied: true,
    status: 'satisfied',
    passedCriteria: ['测试通过'],
    failedCriteria: [],
    criteriaEvidenceMap: { '测试通过': ['ev_1'] },
  });

  it('合法引用（criterion 与 evidence id 均存在）→ 正常 satisfied', async () => {
    const evaluator = evaluatorReturning(validRaw);
    const evaluation = await evaluator.evaluate(
      makeState().goal,
      makeState(),
      [] as ThreadItem[],
      [receipt('ev_1')],
    );
    expect(evaluation.satisfied).toBe(true);
    expect(evaluation.criteriaEvidenceMap).toEqual({ '测试通过': ['ev_1'] });
  });

  it('引用不存在的 evidence id → fail-closed（satisfied 强制 false）', async () => {
    const raw = JSON.stringify({
      satisfied: true,
      status: 'satisfied',
      passedCriteria: ['测试通过'],
      failedCriteria: [],
      criteriaEvidenceMap: { '测试通过': ['ev_ghost'] },
    });
    const evaluator = evaluatorReturning(raw);
    const evaluation = await evaluator.evaluate(
      makeState().goal,
      makeState(),
      [] as ThreadItem[],
      [receipt('ev_1')],
    );
    expect(evaluation.satisfied).toBe(false);
    expect(evaluation.status).toBe('continue');
    expect(evaluation.blocker).toContain('unknown criteria or evidence ids');
  });

  it('引用不存在的 criterion → fail-closed', async () => {
    const raw = JSON.stringify({
      satisfied: true,
      status: 'satisfied',
      passedCriteria: [],
      failedCriteria: [],
      criteriaEvidenceMap: { '不存在的标准': ['ev_1'] },
    });
    const evaluator = evaluatorReturning(raw);
    const evaluation = await evaluator.evaluate(
      makeState().goal,
      makeState(),
      [] as ThreadItem[],
      [receipt('ev_1')],
    );
    expect(evaluation.satisfied).toBe(false);
  });

  it('无 criteriaEvidenceMap 的输出不受影响', async () => {
    const raw = JSON.stringify({ satisfied: true, status: 'satisfied', passedCriteria: ['测试通过'], failedCriteria: [] });
    const evaluator = evaluatorReturning(raw);
    const evaluation = await evaluator.evaluate(
      makeState().goal,
      makeState(),
      [] as ThreadItem[],
      [receipt('ev_1')],
    );
    expect(evaluation.satisfied).toBe(true);
    expect(evaluation.criteriaEvidenceMap).toBeUndefined();
  });
});

// ─── ReadinessCritic kind 白名单 ─────────────────────────────────────────────

function makeCritic(receipts: EvidenceReceipt[]): ReadinessCritic {
  const goalTracker = {
    getState: () => makeState(),
  } as unknown as ConstructorParameters<typeof ReadinessCritic>[1];
  const ledger = {
    size: () => receipts.length,
    getRecentEvidence: () => receipts,
    getEvidenceForCriteria: () => receipts,
  } as unknown as EvidenceLedger;
  return new ReadinessCritic(ledger, goalTracker);
}

describe('ReadinessCritic kind 白名单', () => {
  it('criteria_evidence：白名单内 kind 的证据可支撑', () => {
    const critic = makeCritic([receipt('ev_1', 'command')]);
    const result = critic.check([]);
    const gate = result.failedGates.find((g) => g.name === 'criteria_evidence');
    expect(gate).toBeUndefined();
  });

  it('criteria_evidence：伪造 kind（不在白名单）不得支撑', () => {
    const forged = { ...receipt('ev_x'), kind: 'model_claim' } as unknown as EvidenceReceipt;
    const critic = makeCritic([forged]);
    const result = critic.check([]);
    const gate = result.failedGates.find((g) => g.name === 'criteria_evidence');
    expect(gate).toBeDefined();
    expect(gate!.passed).toBe(false);
  });

  it('mutation_verified：非白名单 kind 的 command 收据不作为 verification', () => {
    const forged = { ...receipt('ev_x', 'command'), kind: 'fake' } as unknown as EvidenceReceipt;
    const critic = makeCritic([forged]);
    const items = [
      { type: 'file_change', status: 'completed', changes: [{ kind: 'edit', path: 'a.ts' }] },
    ] as unknown as ThreadItem[];
    const result = critic.check(items);
    const gate = result.failedGates.find((g) => g.name === 'mutation_verified');
    expect(gate).toBeDefined();
  });
});
