// workflow_result Evidence 承载通道测试（计划 §11.3 + 盘点 §4.4 清单第 1/2/3/4/8 项）。
//
// 本文件放在 task/ 目录下（本波次只允许在 task/ 新建文件），但被测对象是 harness 的
// EvidenceLedger —— 它验证的是 workflow 第二写入通道 / 第二重建源与 ev_ 命名空间的隔离。
import { describe, expect, it } from 'vitest';
import type { ItemId, ThreadItem, TurnId } from '@suanlizi/protocol';
import {
  EvidenceLedger,
  WORKFLOW_EVIDENCE_ID_PREFIX,
  WORKFLOW_EVIDENCE_RUN_SEGMENT,
  evidenceKindFilter,
  isWorkflowEvidenceId,
  toWorkflowEvidenceSeed,
  workflowEvidenceId,
} from '../harness/evidenceLedger.js';
import type { WorkflowResultEvidenceInput } from '../harness/evidenceLedger.js';

const THREAD = 'thread-wev';
const HRUN = 'hrun_wev';

function toolItem(id: string, toolName: string, turnId: TurnId, timestamp: string): ThreadItem {
  return {
    id,
    type: 'tool_call',
    turnId,
    toolName,
    args: {},
    result: 'ok',
    status: 'completed',
    timestamp,
    harnessRunId: HRUN,
  } as unknown as ThreadItem;
}

function fakeStore(items: ThreadItem[]) {
  return { getItems: async (_threadId: string) => items };
}

function workflowInput(overrides: Partial<WorkflowResultEvidenceInput> = {}): WorkflowResultEvidenceInput {
  return {
    runId: 'wfrun_1',
    agentCallId: 'call_1',
    summary: 'workflow agent 产出：已生成 taskLifecycle.ts',
    status: 'passed',
    threadId: THREAD,
    harnessRunId: HRUN,
    ...overrides,
  };
}

// ─── id 命名空间 ─────────────────────────────────────────────────────────────

describe('workflowEvidenceId', () => {
  it('agentCallId 存在时为 wev_<runId>_<agentCallId>；缺省时用冻结的 run 占位', () => {
    expect(workflowEvidenceId('wfrun_1', 'call_2')).toBe('wev_wfrun_1_call_2');
    expect(workflowEvidenceId('wfrun_1')).toBe(`wev_wfrun_1_${WORKFLOW_EVIDENCE_RUN_SEGMENT}`);
    expect(workflowEvidenceId('wfrun_1', '   ')).toBe(`wev_wfrun_1_${WORKFLOW_EVIDENCE_RUN_SEGMENT}`);
    expect(WORKFLOW_EVIDENCE_ID_PREFIX).toBe('wev_');
  });

  it('wev_ 与 ev_ 命名空间互斥，前缀判定不会互相误伤', () => {
    expect(isWorkflowEvidenceId(workflowEvidenceId('r', 'c'))).toBe(true);
    expect(isWorkflowEvidenceId('ev_item_1')).toBe(false);
    expect(isWorkflowEvidenceId(`wev_${'x'}`)).toBe(true);
    // thread item 通道的 id 永远不可能等于 workflow id
    expect(workflowEvidenceId('item_1', 'c')).not.toBe('ev_item_1');
  });
});

describe('evidenceKindFilter', () => {
  it('不传 kinds 时全放行（旧行为兼容）', () => {
    const keep = evidenceKindFilter();
    expect(keep({ kind: 'tool' } as never)).toBe(true);
    expect(keep({ kind: 'workflow_result' } as never)).toBe(true);
    expect(evidenceKindFilter([])({ kind: 'error' } as never)).toBe(true);
  });

  it('传 kinds 时只放行命中的 kind', () => {
    const keep = evidenceKindFilter(['workflow_result']);
    expect(keep({ kind: 'workflow_result' } as never)).toBe(true);
    expect(keep({ kind: 'tool' } as never)).toBe(false);
  });
});

// ─── recordWorkflowResult 写入通道 ───────────────────────────────────────────

describe('EvidenceLedger.recordWorkflowResult', () => {
  it('产出 workflow 证据：sourceKind/kind 正确，turnId 与 itemId 缺省', () => {
    const ledger = new EvidenceLedger();
    const receipt = ledger.recordWorkflowResult({
      ...workflowInput(),
      supportsCriteria: ['task/ 模块可运行'],
      refs: { path: 'packages/runtime/src/task/taskLifecycle.ts' },
    });

    expect(receipt.id).toBe('wev_wfrun_1_call_1');
    expect(receipt.sourceKind).toBe('workflow');
    expect(receipt.kind).toBe('workflow_result');
    expect(receipt.status).toBe('passed');
    expect(receipt.threadId).toBe(THREAD);
    expect(receipt.harnessRunId).toBe(HRUN);
    expect(receipt.turnId).toBeUndefined();
    expect(receipt.itemId).toBeUndefined();
    expect(receipt.supportsCriteria).toEqual(['task/ 模块可运行']);
    expect(receipt.refs).toMatchObject({
      path: 'packages/runtime/src/task/taskLifecycle.ts',
      runId: 'wfrun_1',
      agentCallId: 'call_1',
    });
    // 不污染 turn 索引：workflow 证据没有 turnId
    expect(ledger.getAll()).toHaveLength(1);
  });

  it('refs.runId / refs.agentCallId 由 id 反向决定，不接受调用方覆盖', () => {
    const ledger = new EvidenceLedger();
    const callLevel = ledger.recordWorkflowResult(
      workflowInput({ refs: { runId: 'spoofed', agentCallId: 'spoofed' } }),
    );
    expect(callLevel.refs.runId).toBe('wfrun_1');
    expect(callLevel.refs.agentCallId).toBe('call_1');

    // run 级证据：即使调用方在 refs 里塞 agentCallId，也必须被清空，避免与 call 级混淆
    const runLevel = ledger.recordWorkflowResult({
      ...workflowInput({ agentCallId: undefined }),
      refs: { agentCallId: 'sneaky' },
    });
    expect(runLevel.id).toBe('wev_wfrun_1_run');
    expect(runLevel.refs.agentCallId).toBeUndefined();
    expect(ledger.getWorkflowEvidence()).toHaveLength(2);
  });

  it('同一 (runId, agentCallId) 重复写入幂等：保留 timestamp，刷新 status/summary', () => {
    const ledger = new EvidenceLedger();
    const first = ledger.recordWorkflowResult(workflowInput({ timestamp: '2026-09-19T00:00:00.000Z' }));
    const second = ledger.recordWorkflowResult(
      workflowInput({ status: 'failed', summary: 'agent 输出未通过 schema 校验' }),
    );

    expect(second.id).toBe(first.id);
    expect(second.timestamp).toBe('2026-09-19T00:00:00.000Z');
    expect(second.status).toBe('failed');
    expect(second.summary).toBe('agent 输出未通过 schema 校验');
    expect(ledger.size()).toBe(1);
    // supportsCriteria 未被二次写入抹掉
    expect(second.supportsCriteria).toEqual([]);
  });

  it('保留已有 supportsCriteria（agent_call 终态回写场景）', () => {
    const ledger = new EvidenceLedger();
    ledger.recordWorkflowResult(workflowInput({ supportsCriteria: ['标准 A'] }));
    const refreshed = ledger.recordWorkflowResult(workflowInput({ status: 'failed' }));
    expect(refreshed.supportsCriteria).toEqual(['标准 A']);
  });

  it('runId 为空、agentCallId 取保留 sentinel 都是输入错误', () => {
    const ledger = new EvidenceLedger();
    expect(() => ledger.recordWorkflowResult(workflowInput({ runId: '   ' }))).toThrow(/runId/);
    expect(() =>
      ledger.recordWorkflowResult(workflowInput({ agentCallId: WORKFLOW_EVIDENCE_RUN_SEGMENT })),
    ).toThrow(/reserved segment/);
  });

  it('threadId 缺省时不建 thread 索引但仍写入 ledger', () => {
    const ledger = new EvidenceLedger();
    const receipt = ledger.recordWorkflowResult({
      runId: 'wfrun_x',
      summary: 's',
      status: 'unknown',
    });
    expect(receipt.threadId).toBe('');
    expect(receipt.id).toBe('wev_wfrun_x_run');
    expect(ledger.getAll()).toHaveLength(1);
  });
});

// ─── getRecentEvidence：kind 过滤 + 旧签名兼容 ───────────────────────────────

describe('getRecentEvidence kinds 过滤（盘点 §4.4 清单第 8 项）', () => {
  async function seeded() {
    const ledger = new EvidenceLedger();
    await ledger.rebuildFromThreadItems(THREAD, fakeStore([
      toolItem('i1', 'read_file', 'turn_1', '2026-09-19T00:03:00.000Z'),
      toolItem('i2', 'write_file', 'turn_1', '2026-09-19T00:02:00.000Z'),
      toolItem('i3', 'read_file', 'turn_1', '2026-09-19T00:01:00.000Z'),
    ]));
    ledger.recordWorkflowResult(workflowInput({ timestamp: '2026-09-19T00:00:30.000Z' }));
    return ledger;
  }

  it('不传 opts 时与旧签名等价：按时间倒序取窗口', async () => {
    const ledger = await seeded();
    const all = ledger.getRecentEvidence(2);
    expect(all.map((r) => r.id)).toEqual(['ev_i1', 'ev_i2']);
    expect(ledger.getRecentEvidence(10)).toHaveLength(4);
  });

  it('限定 kinds 后 workflow_result 不会被时间窗口挤掉', async () => {
    const ledger = await seeded();
    // workflow 证据时间最早：不带 kinds 时它会被窗口滤掉
    expect(ledger.getRecentEvidence(1).map((r) => r.id)).toEqual(['ev_i1']);
    expect(ledger.getRecentEvidence(2, { kinds: ['workflow_result'] }).map((r) => r.id)).toEqual([
      'wev_wfrun_1_call_1',
    ]);
    const kept = ledger.getRecentEvidence(20, { kinds: ['workflow_result'] });
    expect(kept.map((r) => r.id)).toEqual(['wev_wfrun_1_call_1']);
    const mixed = ledger.getRecentEvidence(20, { kinds: ['workflow_result', 'tool'] });
    expect(mixed).toHaveLength(4);
    expect(mixed[0].sourceKind).toBe('thread_item');
  });

  it('thread item 证据保持 sourceKind=thread_item 且 itemId/turnId 齐全（回归护栏）', async () => {
    const ledger = await seeded();
    const [first] = ledger.getRecentEvidence(1);
    expect(first?.sourceKind).toBe('thread_item');
    expect(first?.itemId as ItemId).toBe('i1');
    expect(first?.turnId).toBe('turn_1');
    expect(isWorkflowEvidenceId(first!.id)).toBe(false);
  });
});

// ─── 第二重建源 ──────────────────────────────────────────────────────────────

describe('rebuildFromWorkflowResults（盘点 §4.4 清单第 4 项）', () => {
  it('在 rebuildFromThreadItems 之后调用：两个命名空间共存，互不覆盖', async () => {
    const ledger = new EvidenceLedger();
    await ledger.rebuildFromThreadItems(THREAD, fakeStore([
      toolItem('i1', 'read_file', 'turn_1', '2026-09-19T00:03:00.000Z'),
    ]));
    ledger.rebuildFromWorkflowResults([
      workflowInput({ timestamp: '2026-09-19T00:04:00.000Z' }),
      { ...workflowInput({ agentCallId: undefined }), timestamp: '2026-09-19T00:05:00.000Z' },
    ]);

    const ids = ledger.getAll().map((r) => r.id).sort();
    expect(ids).toEqual(['ev_i1', 'wev_wfrun_1_call_1', 'wev_wfrun_1_run']);
    expect(ledger.getWorkflowEvidence().map((r) => r.id).sort()).toEqual([
      'wev_wfrun_1_call_1',
      'wev_wfrun_1_run',
    ]);
  });

  it('自身只替换 wev_ 条目：重复重建幂等，且不删 thread item 证据', async () => {
    const ledger = new EvidenceLedger();
    await ledger.rebuildFromThreadItems(THREAD, fakeStore([
      toolItem('i1', 'read_file', 'turn_1', '2026-09-19T00:03:00.000Z'),
    ]));
    ledger.rebuildFromWorkflowResults([workflowInput()]);
    ledger.rebuildFromWorkflowResults([workflowInput()]);
    expect(ledger.size()).toBe(2);

    // 输入收缩后，过期的 wev_ 条目被移除，ev_ 保留
    ledger.rebuildFromWorkflowResults([{ ...workflowInput(), agentCallId: undefined }]);
    expect(ledger.getAll().map((r) => r.id).sort()).toEqual(['ev_i1', 'wev_wfrun_1_run']);
  });

  it('空数组只清空 workflow 命名空间', async () => {
    const ledger = new EvidenceLedger();
    ledger.recordWorkflowResult(workflowInput());
    ledger.rebuildFromWorkflowResults([]);
    expect(ledger.getAll()).toEqual([]);
    expect(ledger.getWorkflowEvidence()).toEqual([]);
  });

  it('toWorkflowEvidenceSeed 往返：seed 重建出同一 id 与同一时间戳', () => {
    const ledger = new EvidenceLedger();
    const original = ledger.recordWorkflowResult({
      ...workflowInput(),
      timestamp: '2026-09-19T00:09:00.000Z',
      supportsCriteria: ['标准 B'],
    });
    const seed = toWorkflowEvidenceSeed(original);
    expect(seed).toMatchObject({
      runId: 'wfrun_1',
      agentCallId: 'call_1',
      threadId: THREAD,
      harnessRunId: HRUN,
      status: 'passed',
      timestamp: '2026-09-19T00:09:00.000Z',
    });

    const rebuilt = new EvidenceLedger();
    rebuilt.rebuildFromWorkflowResults([seed]);
    const [receipt] = rebuilt.getAll();
    expect(receipt?.id).toBe(original.id);
    expect(receipt?.timestamp).toBe(original.timestamp);
    expect(receipt?.supportsCriteria).toEqual(['标准 B']);
    expect(receipt?.sourceKind).toBe('workflow');
  });
});
