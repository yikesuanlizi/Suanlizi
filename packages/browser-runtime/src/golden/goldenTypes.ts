// 黄金任务框架类型：第一层『本地固定站点』——确定性站点定义 + 脚本化步骤，
// 回归验证浏览器运行时的观测/动作/断言闭环（架构文档 16.1 第一层 + Phase 0 遗留）。
// — English: golden task framework types — layer one 'local pinned sites':
//   deterministic site definitions + scripted steps that regression-verify the
//   browser runtime's observe/act/assert loop (architecture doc §16.1 + Phase 0).
import type { Postcondition } from '@suanlizi/protocol';
import type { FakeSiteDefinition } from '../fakeRuntime.js';

// 黄金断言：对 runner 缓存的最新观测（latestObservation）求值。
// 所有已设置字段全部匹配才通过；字段缺省视为不检查（kind 仅作语义标签）。
// — English: golden assertion — evaluated against the runner's cached latest
//   observation. Every set field must match; unset fields are not checked
//   (kind is a semantic label only).
export interface GoldenAssert {
  kind: 'observation' | 'url' | 'content' | 'elements';
  pageUrlContains?: string; // url 断言：观测 url 包含该子串
  titleContains?: string; // 标题断言：观测标题包含该子串
  contentContains?: string; // mainContent 文本断言：拼接后的正文包含该子串
  elementCountAtLeast?: number; // 可交互元素数量下限
  hasElementText?: string; // 任一元素 text 包含该子串
  hasElementRole?: string; // 任一元素 role 等于该值
}

// 黄金步骤：navigate / act / observe / assert 四选一（其余字段置空）。
// 步骤顺序执行；runner 在每步结束后维护 latestObservation——
// act.targetRef 的 [eN] 引用基于『上一步结束时的观测』：先 navigate/observe
// 的步骤使用新观测；跨页导航后旧页引用自动失效，由运行时以 STALE_EPOCH /
// ELEMENT_NOT_FOUND 拒绝。
// — English: golden step — exactly one of navigate / act / observe / assert.
// Steps run in order; the runner keeps latestObservation refreshed after every
// step, so act.targetRef [eN] refs point at the newest observation — a step that
// navigates first sees the new page's refs, and stale cross-page refs are
// rejected by the runtime with STALE_EPOCH / ELEMENT_NOT_FOUND.
export interface GoldenStep {
  id: string;
  description: string; // 人类可读步骤描述（也是进度文案来源）
  navigate?: { url: string };
  act?: {
    kind: string;
    targetRef?: string;
    value?: unknown;
    // 显式参数（download 等动作需要 url/suggestedName/sizeBytes 等）；与 value 合并进 ActionIntent.arguments
    // — English: explicit arguments (download needs url/suggestedName/sizeBytes);
    //   merged with value into ActionIntent.arguments
    arguments?: Record<string, unknown>;
    postcondition: Postcondition;
    effect?: 'none' | 'local' | 'external_reversible' | 'external_irreversible';
    risk?: 'low' | 'medium' | 'high' | 'critical';
    rationale?: string;
  };
  observe?: {};
  assert?: GoldenAssert;
}

// 黄金任务：目标 + 专属固定站点 + 步骤脚本。站点必须自洽：
// startUrl 在 pages 中、navigate/href 目标都存在、onAction 效果与断言一致。
// — English: golden task — goal + dedicated pinned site + step script. The site
//   must be self-consistent: startUrl in pages, navigate/href targets exist,
//   onAction effects match the assertions.
export interface GoldenTask {
  id: string;
  name: string;
  goal: string;
  site: FakeSiteDefinition;
  steps: GoldenStep[];
}

// 单步结果；只有已执行的步骤会进入 GoldenTaskResult.steps（失败即中止）。
// — English: per-step result; only executed steps appear in the result
//   (the run aborts on the first failure).
export interface GoldenStepResult {
  id: string;
  status: 'passed' | 'failed';
  detail: string;
}

// 任务总结果：passed=false 时 failedStepId 指向首个失败步骤。
// — English: overall task result; failedStepId points at the first failed step.
export interface GoldenTaskResult {
  taskId: string;
  passed: boolean;
  steps: GoldenStepResult[];
  startedAt: number;
  finishedAt: number;
  failedStepId?: string;
}
