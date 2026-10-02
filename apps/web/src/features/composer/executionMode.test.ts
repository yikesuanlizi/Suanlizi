import { describe, expect, it } from 'vitest';
import { createInitialWorkflowScript, HIGH_AUTONOMY_OVERRIDES } from './executionMode.js';

describe('Composer execution modes', () => {
  it('uses the supported high-autonomy configuration for Goal and Dynamic Workflow', () => {
    expect(HIGH_AUTONOMY_OVERRIDES).toEqual({
      permissions: 'danger_full_access',
      reasoningEffort: 'max',
      runProfile: 'runtime_os',
    });
  });

  it('creates a reviewable restricted workflow script without interpolating raw objective text', () => {
    const script = createInitialWorkflowScript('检查 "报价" 并\n汇总');
    expect(script).toContain('export const meta =');
    expect(script).toContain('phase("执行");');
    expect(script).toContain('await agent(');
    expect(script).toContain('return { result };');
    expect(script).toContain('\\"报价\\"');
  });
});
