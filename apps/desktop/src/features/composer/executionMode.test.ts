import { describe, expect, it } from 'vitest';
import { HIGH_AUTONOMY_OVERRIDES, createInitialWorkflowScript } from './executionMode.js';

describe('executionMode', () => {
  it('uses the supported high-autonomy defaults for Goal and Dynamic Workflow', () => {
    expect(HIGH_AUTONOMY_OVERRIDES).toEqual({
      permissions: 'danger_full_access',
      reasoningEffort: 'max',
      runProfile: 'runtime_os',
    });
  });

  it('creates an inspectable restricted workflow proposal', () => {
    const script = createInitialWorkflowScript('整理并验证测试结果');
    expect(script).toContain('export const meta');
    expect(script).toContain('phase("执行")');
    expect(script).toContain('await agent("整理并验证测试结果"');
    expect(script).toContain('return { result };');
  });
});
