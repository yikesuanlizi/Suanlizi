// P5：Workflow 脚本成本警告与历史脚本对比（纯函数，不依赖组件与网络）。
//
// 计划 §7 P5 要求「大任务警告和成本统计」「脚本保存、查看、对比、编辑后重新运行」：
// - 成本警告只读静态度量（agent 调用点、是否被循环/扇出放大），不改变批准语义；
// - 脚本对比按行做多重集差异，给出增删行数与差异行摘要（不伪造上下文行）。
//
// — Chinese: pure helpers for P5 cost warning and script diff.

export interface WorkflowScriptCost {
  agentCallSites: number;
  agentsInsideLoop: boolean;
  fanOutSites: number;
}

/** 触发大任务警告的 agent 调用点阈值（字面量调用点，不含循环放大）。 */
export const WORKFLOW_LARGE_TASK_AGENT_SITES = 5;

export interface WorkflowScriptDiff {
  added: number;
  removed: number;
  unchanged: number;
  identical: boolean;
  /** 差异行摘要（先加后删，最多 12 行），供 UI 直接展示。 */
  samples: Array<{ kind: 'added' | 'removed'; text: string }>;
}

/**
 * 大任务警告文案；无需警告时返回 null。
 * 循环/扇出内的 agent 调用会在运行时放大成 N 次，即使调用点很少也必须提示。
 */
export function workflowCostWarning(cost: WorkflowScriptCost | undefined, locale: 'zh' | 'en'): string | null {
  if (!cost) return null;
  const zh = locale !== 'en';
  const amplified = cost.agentsInsideLoop || cost.fanOutSites > 0;
  if (!amplified && cost.agentCallSites < WORKFLOW_LARGE_TASK_AGENT_SITES) return null;
  const sites = zh ? `Agent 调用点 ${cost.agentCallSites} 处` : `${cost.agentCallSites} agent call site(s)`;
  const fanOut = zh
    ? `、扇出点 ${cost.fanOutSites} 处`
    : `, ${cost.fanOutSites} fan-out site(s)`;
  const tail = amplified
    ? (zh ? '，agent 调用位于循环或 pipeline/parallel 内，实际次数会成倍放大' : ', agent() sits inside a loop or pipeline/parallel and will multiply at runtime')
    : (zh ? '，实际次数可能因循环放大超出预期' : ', loops may push the real count higher');
  return `${zh ? '大任务警告：' : 'Large-run warning: '}${sites}${fanOut}${tail}。`;
}

/**
 * 行级多重集差异：以「出现次数」比较两侧行集合，得到新增/删除行数与差异行样本。
 * 不输出行号与上下文，避免对未真做的逐行对齐产生误导。
 */
export function diffScripts(beforeScript: string, afterScript: string, maxSamples = 12): WorkflowScriptDiff {
  const before = toLines(beforeScript);
  const after = toLines(afterScript);
  const beforeCounts = countLines(before);
  const afterCounts = countLines(after);

  const removed: string[] = [];
  const added: string[] = [];
  for (const [line, count] of afterCounts) {
    const matched = beforeCounts.get(line) ?? 0;
    const extra = count - matched;
    if (extra > 0) added.push(...Array.from({ length: extra }, () => line));
  }
  for (const [line, count] of beforeCounts) {
    const matched = afterCounts.get(line) ?? 0;
    const extra = count - matched;
    if (extra > 0) removed.push(...Array.from({ length: extra }, () => line));
  }

  const samples = [
    ...added.slice(0, maxSamples).map((text) => ({ kind: 'added' as const, text })),
    ...removed.slice(0, Math.max(0, maxSamples - Math.min(added.length, maxSamples))).map((text) => ({ kind: 'removed' as const, text })),
  ];
  const identical = added.length === 0 && removed.length === 0;
  return {
    added: added.length,
    removed: removed.length,
    unchanged: before.length - removed.length,
    identical,
    samples,
  };
}

function toLines(script: string): string[] {
  return (script ?? '').split('\n').map((line) => line.trimEnd()).filter((line) => line.trim().length > 0);
}

function countLines(lines: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const line of lines) counts.set(line, (counts.get(line) ?? 0) + 1);
  return counts;
}
