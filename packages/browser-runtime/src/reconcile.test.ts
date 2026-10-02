// 副作用对账单元测试：覆盖架构文档 10.2 的四条裁决规则
// — English: side-effect reconciliation unit tests — covers the four verdict
//   rules of architecture doc 10.2 (external evidence, page evidence for
//   external/local effects, non-pending status, and no-evidence fallback).
import { describe, expect, it } from 'vitest';
import type { ActionRecord } from '@suanlizi/protocol';
import { reconcileAction } from './reconcile.js';

// 构造最小 ActionRecord（默认：提交订单，外部不可逆副作用，结果 uncertain）
// — English: builds a minimal ActionRecord (submit order, external irreversible, uncertain).
function makeRecord(overrides: Partial<ActionRecord> = {}): ActionRecord {
  return {
    actionId: 'act-submit-order',
    taskId: 'task-1',
    actionDigest: 'sha256:test',
    effect: 'external_irreversible',
    status: 'uncertain',
    preState: {
      pageId: 'p1',
      url: 'https://shop.example.com/checkout',
      observationId: 'obs-1',
      navigationEpoch: 1,
    },
    expectedPostcondition: { kind: 'url_contains', value: 'success' },
    preparedAt: 1000,
    evidenceRefs: [],
    ...overrides,
  };
}

describe('reconcileAction 规则 2：外部证据', () => {
  it('外部订单号证据 → reconciled（retrySafe false）', () => {
    const r = reconcileAction({
      record: makeRecord(),
      evidence: { external: [{ type: 'order_no', value: 'SO20240101-0001' }] },
    });
    expect(r.verdict).toBe('reconciled');
    expect(r.retrySafe).toBe(false);
    expect(r.detail.length).toBeGreaterThan(0);
  });
});

describe('reconcileAction 规则 3：页面证据（外部副作用）', () => {
  it('提交订单 + postcondition url_contains success + 页面 URL 含 success → reconciled', () => {
    const r = reconcileAction({
      record: makeRecord(),
      evidence: { page: { url: 'https://shop.example.com/order/success?no=123' } },
    });
    expect(r.verdict).toBe('reconciled');
    expect(r.retrySafe).toBe(false);
  });

  it('提交订单 + successMarker false + formStillEditable true → not_executed（retrySafe true）', () => {
    const r = reconcileAction({
      record: makeRecord(),
      evidence: { page: { successMarker: false, formStillEditable: true } },
    });
    expect(r.verdict).toBe('not_executed');
    expect(r.retrySafe).toBe(true);
  });

  it('提交订单 + 页面状态不明（无 success 无 editable 信息）→ still_uncertain', () => {
    const r = reconcileAction({
      record: makeRecord(),
      evidence: { page: { url: 'https://shop.example.com/checkout' } },
    });
    expect(r.verdict).toBe('still_uncertain');
    expect(r.retrySafe).toBe(false);
  });
});

describe('reconcileAction 规则 4：无证据', () => {
  it('无任何证据 → still_uncertain（挂起请求用户处理）', () => {
    const r = reconcileAction({ record: makeRecord() });
    expect(r.verdict).toBe('still_uncertain');
    expect(r.retrySafe).toBe(false);
  });
});

describe('reconcileAction 规则 1：非待对账状态', () => {
  it('status=committed → 直接 reconciled（非待对账）', () => {
    const r = reconcileAction({ record: makeRecord({ status: 'committed' }) });
    expect(r.verdict).toBe('reconciled');
    expect(r.retrySafe).toBe(false);
  });

  it('status=aborted → still_uncertain（非待对账，按现状处理）', () => {
    const r = reconcileAction({ record: makeRecord({ status: 'aborted' }) });
    expect(r.verdict).toBe('still_uncertain');
    expect(r.retrySafe).toBe(false);
  });
});

describe('reconcileAction 规则 3：页面证据（local/none）', () => {
  it('local 效果 + URL 未变化 → not_executed（retrySafe true）', () => {
    const r = reconcileAction({
      record: makeRecord({ effect: 'local' }),
      evidence: { page: { url: 'https://shop.example.com/checkout' } },
    });
    expect(r.verdict).toBe('not_executed');
    expect(r.retrySafe).toBe(true);
  });
});
