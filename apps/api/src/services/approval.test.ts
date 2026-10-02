import { describe, expect, it, vi } from 'vitest';
import type { ApprovalRequest } from '@suanlizi/protocol';
import { WebApprovalBroker } from './approval.js';

function approvalRequest(requestId = 'approval-1'): ApprovalRequest {
  return {
    requestId,
    threadId: 'thread-1',
    turnId: 'turn-1',
    itemId: 'item-1',
    kind: 'command',
    description: 'Run command',
    payload: { command: 'npm run build' },
    decision: 'prompt',
  };
}

describe('WebApprovalBroker', () => {
  it('keeps pending approval requests until a decision resolves them', async () => {
    const broker = new WebApprovalBroker();
    const pending = broker.requestApproval(approvalRequest());

    expect(broker.listPending()).toHaveLength(1);
    expect(broker.listPending()[0]?.requestId).toBe('approval-1');

    expect(broker.decide('approval-1', true, 'looks good')).toBe(true);
    await expect(pending).resolves.toEqual({ approved: true, reason: 'looks good' });
    expect(broker.listPending()).toHaveLength(0);
  });

  it('returns false when deciding an unknown request', () => {
    const broker = new WebApprovalBroker();

    expect(broker.decide('missing', false)).toBe(false);
  });

  it('retains persistent approval scope for the runtime after the API saves its rule', async () => {
    const broker = new WebApprovalBroker();
    const pending = broker.requestApproval(approvalRequest('approval-persistent'));

    expect(broker.getPending('approval-persistent')?.requestId).toBe('approval-persistent');
    expect(broker.decideWithScope('approval-persistent', true, 'allow similar', 'tool_call', 'workspace')).toBe(true);
    await expect(pending).resolves.toEqual({
      approved: true,
      reason: 'allow similar',
      temporaryScope: 'tool_call',
      persistentScope: 'workspace',
    });
  });

  it('uses a 60 second default timeout and records approval history', async () => {
    vi.useFakeTimers();
    try {
      const broker = new WebApprovalBroker();
      const pending = broker.requestApproval(approvalRequest('approval-timeout'));

      await vi.advanceTimersByTimeAsync(59_999);
      expect(broker.listPending()).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(1);
      await expect(pending).resolves.toEqual({ approved: false, reason: 'approval timeout' });
      expect(broker.listPending()).toHaveLength(0);
      expect(broker.listHistory()).toEqual([
        expect.objectContaining({
          requestId: 'approval-timeout',
          approved: false,
          reason: 'approval timeout',
          status: 'timeout',
        }),
      ]);
    } finally {
      vi.useRealTimers();
    }
  });
});
