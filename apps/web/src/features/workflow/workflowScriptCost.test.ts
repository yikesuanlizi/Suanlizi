// P5：成本警告与脚本对比纯函数测试（web；desktop 同构）。
import { describe, expect, it } from 'vitest';
import {
  diffScripts,
  workflowCostWarning,
  WORKFLOW_LARGE_TASK_AGENT_SITES,
} from './workflowScriptCost.js';

describe('workflowCostWarning', () => {
  it('无度量、小任务（无放大且调用点少）时不警告', () => {
    expect(workflowCostWarning(undefined, 'zh')).toBeNull();
    expect(workflowCostWarning({ agentCallSites: 2, agentsInsideLoop: false, fanOutSites: 0 }, 'zh')).toBeNull();
    // 阈值 - 1 不警告，达到阈值才警告。
    expect(workflowCostWarning({ agentCallSites: WORKFLOW_LARGE_TASK_AGENT_SITES - 1, agentsInsideLoop: false, fanOutSites: 0 }, 'zh')).toBeNull();
    expect(workflowCostWarning({ agentCallSites: WORKFLOW_LARGE_TASK_AGENT_SITES, agentsInsideLoop: false, fanOutSites: 0 }, 'zh')).not.toBeNull();
  });

  it('agent 调用在循环/扇出内 → 即使调用点少也警告', () => {
    const zh = workflowCostWarning({ agentCallSites: 1, agentsInsideLoop: true, fanOutSites: 1 }, 'zh');
    expect(zh).toContain('大任务警告');
    expect(zh).toContain('成倍放大');
    const en = workflowCostWarning({ agentCallSites: 1, agentsInsideLoop: false, fanOutSites: 2 }, 'en');
    expect(en).toContain('Large-run warning');
    expect(en).toContain('2 fan-out site(s)');
  });

  it('调用点达到阈值 → 警告（中英各一份文案）', () => {
    const warning = workflowCostWarning(
      { agentCallSites: WORKFLOW_LARGE_TASK_AGENT_SITES, agentsInsideLoop: false, fanOutSites: 0 },
      'zh',
    );
    expect(warning).toContain(`Agent 调用点 ${WORKFLOW_LARGE_TASK_AGENT_SITES} 处`);
  });
});

describe('diffScripts', () => {
  it('完全相同 → identical，无差异样本', () => {
    const diff = diffScripts("phase('p1');\nreturn 1;", "phase('p1');\nreturn 1;");
    expect(diff.identical).toBe(true);
    expect(diff.added).toBe(0);
    expect(diff.removed).toBe(0);
    expect(diff.samples).toEqual([]);
  });

  it('编辑后重跑：新增行与删除行分别计数', () => {
    const before = ["phase('p1');", 'const a = await agent("old prompt");', 'return a;'].join('\n');
    const after = ["phase('p1');", 'const a = await agent("new prompt");', 'return a;'].join('\n');
    const diff = diffScripts(before, after);
    expect(diff.identical).toBe(false);
    expect(diff.added).toBe(1);
    expect(diff.removed).toBe(1);
    expect(diff.unchanged).toBe(2);
    expect(diff.samples.map((sample) => sample.kind)).toEqual(['added', 'removed']);
    expect(diff.samples[0]?.text).toContain('new prompt');
    expect(diff.samples[1]?.text).toContain('old prompt');
  });

  it('重复行按出现次数比较（不做行号对齐，不虚报差异）', () => {
    const diff = diffScripts('log("x");\nlog("x");\nlog("x");', 'log("x");\nlog("x");');
    expect(diff.added).toBe(0);
    expect(diff.removed).toBe(1);
  });

  it('空行与尾随空白不参与比较；空输入不抛错', () => {
    expect(diffScripts('', '').identical).toBe(true);
    expect(diffScripts('  \n', '').identical).toBe(true);
    const diff = diffScripts('return 1;   ', 'return 2;');
    expect(diff.removed).toBe(1);
  });

  it('样本上限可配置，计数不受截断影响', () => {
    const before = Array.from({ length: 20 }, (_, index) => `log("b${index}");`).join('\n');
    const after = Array.from({ length: 20 }, (_, index) => `log("a${index}");`).join('\n');
    const diff = diffScripts(before, after, 3);
    expect(diff.added).toBe(20);
    expect(diff.removed).toBe(20);
    expect(diff.samples.length).toBeLessThanOrEqual(3);
  });
});
