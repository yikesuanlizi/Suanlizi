import { describe, expect, it } from 'vitest';
import type { AgentDecisionRequest } from '@suanlizi/protocol';
import { ThreadStateManager } from './state.js';

const decision: AgentDecisionRequest = {
  requestId: 'decision-1',
  threadId: 'thread-1',
  turnId: 'turn-1',
  prompt: '选择方案',
  options: [{ id: 'one', action: 'way_one', label: '方式一' }],
  allowCustomInput: true,
  createdAt: '2026-08-23T00:00:00.000Z',
  status: 'pending',
};

describe('ThreadStateManager execution lifecycle', () => {
  it('keeps a stopping turn busy until its cancellation path reaches terminal', () => {
    const manager = new ThreadStateManager();
    manager.startTurn('thread-1', 'turn-1');
    manager.interruptTurn('thread-1', 'turn-1', 'stop-1');
    expect(manager.get('thread-1').status).toBe('stopping');
    expect(manager.isRunning('thread-1')).toBe(true);
    manager.completeInterruptedTurn('thread-1', 'turn-1');
    expect(manager.get('thread-1').status).toBe('terminal');
    expect(manager.isRunning('thread-1')).toBe(false);
  });

  it('round-trips waiting user input without changing the active turn', () => {
    const manager = new ThreadStateManager();
    manager.startTurn('thread-1', 'turn-1');
    expect(manager.waitForUserInput('thread-1', 'turn-1', decision)).toBe(true);
    expect(manager.get('thread-1')).toMatchObject({ status: 'waiting_user_input', activeTurnId: 'turn-1', pendingDecision: decision });
    expect(manager.resumeAfterUserInput('thread-1', 'turn-1')).toBe(true);
    expect(manager.get('thread-1')).toMatchObject({ status: 'running', activeTurnId: 'turn-1', pendingDecision: null });
  });
});
