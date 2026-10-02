// 能力层（架构文档 12.1 能力分层 + 12.2 自愈降级）：
// 任务目标 → 业务能力 → 浏览器动作 → Playwright Primitive。每个能力带版本、
// 输入 Schema、输出摘要、权限需求（requiredGrant）、预算预估（estimatedCost）、
// 默认副作用类别与后置条件；健康度按『最近连续非 committed』判定降级与停用，
// 而非只看最终成功——确定性能力失败后应走 重新观测 → LLM 修复 → 重规划 的自愈
// 链路，超过阈值（连续 3 次降级、连续 5 次停用）即停用并告警（12.2）。
// — English: capability layer (architecture §12.1 capability layering +
//   §12.2 self-healing degradation): task goal → business capability →
//   browser action → Playwright primitive. Every capability carries a
//   version, input schema, output summary, grant requirement (requiredGrant),
//   cost estimate (estimatedCost), default effect/risk and postcondition.
//   Health is judged by the most recent run of consecutive non-committed
//   outcomes, not by final success alone — deterministic failures must flow
//   through re-observe → LLM repair → re-plan, and past the threshold
//   (degraded at 3 consecutive, disabled at 5) the capability is disabled
//   with an alert (§12.2).
// 本模块只声明能力目录与纯函数健康度聚合，不含任何 Playwright / DOM 实现。
// — English: this module declares the capability catalog and pure health
//   aggregation only; no Playwright / DOM implementation.

import type { AccessKind, ActionEffect, ActionRisk, Postcondition } from '@suanlizi/protocol';

// ─── 能力名 ──────────────────────────────────────────────────────────────────
// 与 BrowserActionKind 对齐的子集（submit 由 click 组合实现，不单列能力）。
// — English: aligned subset of BrowserActionKind (submit is composed from
//   click, not a standalone capability).
export type CapabilityName =
  | 'browser.navigate'
  | 'browser.observe'
  | 'browser.click'
  | 'browser.type'
  | 'browser.select'
  | 'browser.press'
  | 'browser.scroll'
  | 'browser.screenshot'
  | 'browser.download'
  | 'browser.wait';

// 权限需求：执行该能力所需的最小 AccessKind 与工具目标（供授权包络编译）。
// — English: grant requirement — minimal AccessKind and tool target needed
//   (compiled into the authorization envelope).
export interface CapabilityGrantRequirement {
  access: AccessKind; // 'read' | 'write' | 'network' | 'tool_call' 等
  target: { kind: 'tool'; toolName: string }; // 如 'browser.click'
}

// 预算预估：规划器按此分配步数/token 预算。
// — English: cost estimate — planner budgets steps/tokens from this.
export interface CapabilityCost {
  steps: number; // 预估步数（estimated steps）
  tokens: number; // 预估 token（estimated tokens）
}

// 能力定义：版本化契约，任何变更必须升版本号。
// — English: capability definition — a versioned contract; any change must
//   bump the version.
export interface CapabilityDefinition {
  name: CapabilityName;
  version: string; // 语义版本，如 '1.0.0'（semver, e.g. '1.0.0'）
  description: string; // 中文一句话说明（one-line Chinese description）
  // 简化输入 Schema（JSON Schema 形状的轻量替代）
  // — English: lightweight input schema (JSON Schema-shaped alternative)
  inputFields: Array<{
    name: string;
    type: 'string' | 'number' | 'boolean' | 'object';
    required: boolean;
    description: string;
  }>;
  outputSummary: string; // 输出描述（output summary）
  requiredGrant: CapabilityGrantRequirement;
  estimatedCost: CapabilityCost;
  effect: ActionEffect; // 默认副作用类别（default side-effect category）
  risk: ActionRisk; // 默认风险等级（default risk level）
  defaultPostcondition: Postcondition; // 默认后置条件（default postcondition）
}

// ─── 能力注册表（12.1 全量注册 10 个能力） ──────────────────────────────────
// defaultPostcondition 中的 '{url}' 为占位符：执行时由调用方用实际输入实例化。
// — English: '{url}' in defaultPostcondition is a placeholder, instantiated
//   by the caller with the actual input at execution time.
export const BROWSER_CAPABILITIES: readonly CapabilityDefinition[] = [
  {
    name: 'browser.navigate',
    version: '1.0.0',
    description: '导航到指定 URL 并等待页面就绪',
    inputFields: [
      { name: 'url', type: 'string', required: true, description: '目标 URL（http/https）' },
    ],
    outputSummary: '导航结果与就绪后的页面摘要（URL / 标题 / 就绪状态）',
    requiredGrant: { access: 'network', target: { kind: 'tool', toolName: 'browser.navigate' } },
    estimatedCost: { steps: 2, tokens: 500 },
    effect: 'none',
    risk: 'low',
    defaultPostcondition: { kind: 'url_contains', value: '{url}' },
  },
  {
    name: 'browser.observe',
    version: '1.0.0',
    description: '观测当前页面并产出带 navigationEpoch 的快照',
    inputFields: [],
    outputSummary: 'Observation（URL / 标题 / 可交互元素 / 表单 / 网络 / 页面状态）',
    requiredGrant: { access: 'read', target: { kind: 'tool', toolName: 'browser.observe' } },
    estimatedCost: { steps: 1, tokens: 800 },
    effect: 'none',
    risk: 'low',
    defaultPostcondition: { kind: 'none' },
  },
  {
    name: 'browser.click',
    version: '1.0.0',
    description: '点击观测结果中的目标元素',
    inputFields: [
      { name: 'targetRef', type: 'string', required: true, description: '观测结果中的元素引用 ref' },
    ],
    outputSummary: '点击后的页面状态与副作用账本记录',
    requiredGrant: { access: 'tool_call', target: { kind: 'tool', toolName: 'browser.click' } },
    estimatedCost: { steps: 1, tokens: 150 },
    effect: 'local',
    risk: 'low',
    // 点击的具体后置条件由调用方按意图给出，默认不假设成功。
    // — English: the concrete postcondition is supplied by the caller per
    //   intent; default assumes nothing succeeded.
    defaultPostcondition: { kind: 'none' },
  },
  {
    name: 'browser.type',
    version: '1.0.0',
    description: '向目标输入框输入文本',
    inputFields: [
      { name: 'targetRef', type: 'string', required: true, description: '目标输入框元素引用 ref' },
      { name: 'value', type: 'string', required: true, description: '要输入的文本' },
    ],
    outputSummary: '输入后的页面状态与副作用账本记录',
    requiredGrant: { access: 'tool_call', target: { kind: 'tool', toolName: 'browser.type' } },
    estimatedCost: { steps: 1, tokens: 150 },
    effect: 'local',
    risk: 'medium',
    defaultPostcondition: { kind: 'none' },
  },
  {
    name: 'browser.select',
    version: '1.0.0',
    description: '在下拉选择框中选择指定选项',
    inputFields: [
      { name: 'targetRef', type: 'string', required: true, description: '目标 select 元素引用 ref' },
      { name: 'value', type: 'string', required: true, description: '要选中的选项值' },
    ],
    outputSummary: '选择后的页面状态与副作用账本记录',
    requiredGrant: { access: 'tool_call', target: { kind: 'tool', toolName: 'browser.select' } },
    estimatedCost: { steps: 1, tokens: 150 },
    effect: 'local',
    risk: 'low',
    defaultPostcondition: { kind: 'none' },
  },
  {
    name: 'browser.press',
    version: '1.0.0',
    description: '在目标元素上按键（如 Enter、Tab）',
    inputFields: [
      { name: 'targetRef', type: 'string', required: true, description: '目标元素引用 ref' },
      { name: 'key', type: 'string', required: true, description: '按键名（Playwright Keyboard key 约定）' },
    ],
    outputSummary: '按键后的页面状态与副作用账本记录',
    requiredGrant: { access: 'tool_call', target: { kind: 'tool', toolName: 'browser.press' } },
    estimatedCost: { steps: 1, tokens: 120 },
    effect: 'local',
    risk: 'low',
    defaultPostcondition: { kind: 'none' },
  },
  {
    name: 'browser.scroll',
    version: '1.0.0',
    description: '滚动页面或目标容器到指定位置',
    inputFields: [
      { name: 'targetRef', type: 'string', required: false, description: '目标容器元素引用 ref（缺省滚动视口）' },
      { name: 'delta', type: 'number', required: true, description: '滚动偏移量（像素，正数向下）' },
    ],
    outputSummary: '滚动后的页面状态与副作用账本记录',
    requiredGrant: { access: 'tool_call', target: { kind: 'tool', toolName: 'browser.scroll' } },
    estimatedCost: { steps: 1, tokens: 120 },
    effect: 'local',
    risk: 'low',
    defaultPostcondition: { kind: 'none' },
  },
  {
    name: 'browser.screenshot',
    version: '1.0.0',
    description: '截取当前页面截图并记录证据引用',
    inputFields: [],
    outputSummary: '截图证据引用（screenshotRef）',
    requiredGrant: { access: 'tool_call', target: { kind: 'tool', toolName: 'browser.screenshot' } },
    estimatedCost: { steps: 1, tokens: 300 },
    effect: 'local',
    risk: 'low',
    defaultPostcondition: { kind: 'none' },
  },
  {
    name: 'browser.download',
    version: '1.0.0',
    description: '下载指定 URL 文件到任务隔离目录并记录证据',
    inputFields: [
      { name: 'url', type: 'string', required: true, description: '下载来源 URL' },
    ],
    outputSummary: 'downloadId 与隔离相对路径（downloads/<id>/<file>）',
    requiredGrant: { access: 'network', target: { kind: 'tool', toolName: 'browser.download' } },
    estimatedCost: { steps: 2, tokens: 300 },
    effect: 'external_reversible',
    risk: 'medium',
    defaultPostcondition: { kind: 'download_completed' },
  },
  {
    name: 'browser.wait',
    version: '1.0.0',
    description: '等待页面/元素稳定或指定超时',
    inputFields: [
      { name: 'timeoutMs', type: 'number', required: true, description: '等待超时毫秒数' },
    ],
    outputSummary: '等待结果（稳定 / 超时）',
    requiredGrant: { access: 'tool_call', target: { kind: 'tool', toolName: 'browser.wait' } },
    estimatedCost: { steps: 1, tokens: 80 },
    effect: 'none',
    risk: 'low',
    defaultPostcondition: { kind: 'none' },
  },
];

// 按名称查找能力；未知名称返回 undefined，大小写敏感。
// — English: look up a capability by name; unknown names return undefined,
//   lookup is case-sensitive.
export function getCapability(name: string): CapabilityDefinition | undefined {
  return BROWSER_CAPABILITIES.find((c) => c.name === name);
}

// ─── 能力健康度（12.2） ──────────────────────────────────────────────────────
// 一次能力执行的结果：不能只依据『最终成功』评价能力，uncertain（执行后
// 状态不明，需账本对账）与 failed 都计入非 committed。
// — English: one capability execution outcome — health must not rely on
//   final success alone; uncertain (needs ledger reconciliation) and failed
//   both count as non-committed.
export interface CapabilityOutcome {
  outcome: 'committed' | 'uncertain' | 'failed';
  errorCode?: string; // 失败/不确定的错误码（STALE_EPOCH、ELEMENT_*、NETWORK 等）
  requiredApproval?: boolean; // 本次执行是否走了用户确认（human approval）
  steps?: number; // 本次消耗步数（缺省 1；defaults to 1）
}

// 能力健康度聚合：窗口内统计 + 最近连续非 committed 判定降级/停用。
// — English: aggregated capability health — in-window statistics plus
//   degradation/disablement from the most recent consecutive non-committed
//   run (12.2 threshold: 3 → degraded, 5 → disabled).
export interface CapabilityHealth {
  name: string;
  attempts: number;
  successRate: number; // committed/attempts，保留 3 位小数；attempts=0 → 1
  uncertainRate: number; // uncertain/attempts，保留 3 位小数
  staleRefRate: number; // errorCode 匹配 /STALE_EPOCH|ELEMENT_/ 的占比
  avgSteps: number; // 平均步数，1 位小数
  humanTakeoverRate: number; // requiredApproval=true 占比，保留 3 位小数
  degraded: boolean; // 最近 3 次连续非 committed → true
  disabled: boolean; // 最近 5 次连续非 committed → true（12.2 停用并告警）
}

// 三位小数舍入（0.333333 → 0.333）；英文注释略。
function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

// 一位小数舍入；英文注释略。
function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

// 聚合能力健康度。degraded/disabled 只看『最近连续』：从末尾向前数连续非
// committed 的次数 >= 3 → degraded；>= 5 → disabled（12.2 阈值）。
// — English: aggregate capability health. degraded/disabled consider only
//   the most recent consecutive run: counting backward from the tail,
//   non-committed count >= 3 → degraded; >= 5 → disabled (§12.2 threshold).
export function aggregateCapabilityHealth(input: {
  name: string;
  outcomes: CapabilityOutcome[];
}): CapabilityHealth {
  const { name, outcomes } = input;
  const attempts = outcomes.length;

  // 无样本：按健康处理，successRate 约定为 1。
  // — English: no samples — treated as healthy; successRate is 1 by contract.
  if (attempts === 0) {
    return {
      name,
      attempts: 0,
      successRate: 1,
      uncertainRate: 0,
      staleRefRate: 0,
      avgSteps: 0,
      humanTakeoverRate: 0,
      degraded: false,
      disabled: false,
    };
  }

  let committed = 0;
  let uncertain = 0;
  let staleRef = 0;
  let approved = 0;
  let totalSteps = 0;
  for (const o of outcomes) {
    if (o.outcome === 'committed') {
      committed += 1;
    } else if (o.outcome === 'uncertain') {
      uncertain += 1;
    }
    // 过期引用/元素类错误：errorCode 匹配 STALE_EPOCH 或 ELEMENT_ 前缀。
    // — English: stale-ref / element-class errors match STALE_EPOCH or ELEMENT_.
    if (o.errorCode !== undefined && /STALE_EPOCH|ELEMENT_/.test(o.errorCode)) {
      staleRef += 1;
    }
    if (o.requiredApproval === true) {
      approved += 1;
    }
    totalSteps += o.steps ?? 1;
  }

  // 最近连续非 committed：从末尾向前数，遇到 committed 即停。
  // — English: most recent consecutive non-committed run, counting backward
  //   from the tail until a committed outcome is hit.
  let consecutiveNonCommitted = 0;
  for (let i = outcomes.length - 1; i >= 0; i--) {
    if (outcomes[i]?.outcome === 'committed') {
      break;
    }
    consecutiveNonCommitted += 1;
  }

  return {
    name,
    attempts,
    successRate: round3(committed / attempts),
    uncertainRate: round3(uncertain / attempts),
    staleRefRate: round3(staleRef / attempts),
    avgSteps: round1(totalSteps / attempts),
    humanTakeoverRate: round3(approved / attempts),
    degraded: consecutiveNonCommitted >= 3,
    disabled: consecutiveNonCommitted >= 5,
  };
}
