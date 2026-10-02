// P6：GoalRun 产出 WorkflowScriptRequest 的提取层（计划 §12.1）。
// 模型在 turn 输出中用 ```workflow 围栏承载 JSON 提案；本模块只做提取与静态预检，
// 不触发运行 —— 提案必须经 API 层落库 + 用户批准（workflowScriptService.proposeRun / approveRun）。
//
// — English: extract a ```workflow proposal block from model turn output into a
//   WorkflowScriptRequest; execution still requires explicit user approval upstream.

import type { ThreadItem, WorkflowRuntimeLimits, WorkflowScriptRequest } from '@suanlizi/protocol';
import { DEFAULT_WORKFLOW_RUNTIME_LIMITS } from '@suanlizi/protocol';
import { validateWorkflowScript } from '../workflowScript/validator.js';

export const WORKFLOW_PROPOSAL_BLOCK_LANGUAGE = 'workflow';

/** 续跑注入的工作流提案提示（仅当 run 配置了 workflow 选项时附加）。 */
export const WORKFLOW_CONTINUATION_HINT = [
  '',
  '[workflow] 如果剩余工作适合大规模并行子代理编排（批量文件处理、批量评审、批量转换），',
  '你可以在回复末尾输出一个 ' + '```' + WORKFLOW_PROPOSAL_BLOCK_LANGUAGE + ' 代码块，内容为 JSON：',
  '{"objective": "...", "script": "受限编排脚本", "estimatedAgents": 8, "estimatedTokens": 120000}',
  '脚本语法遵循受限运行时（agent/pipeline/parallel/phase/log）；提案将交用户批准后执行，本轮到此为止。',
].join('\n');

export interface WorkflowProposalContext {
  taskId: string;
  goalRunId: string;
  limits?: Partial<WorkflowRuntimeLimits>;
}

export interface WorkflowProposalExtraction {
  request: WorkflowScriptRequest | null;
  /** 提案块存在但非法时的原因；无提案块时为 undefined。 */
  error?: string;
}

interface RawWorkflowProposal {
  objective?: unknown;
  script?: unknown;
  estimatedAgents?: unknown;
  estimatedTokens?: unknown;
}

/**
 * 从 turn 输出提取最后一条 agent_message 中的 ```workflow 提案（与 plan 块同惯用法）。
 * 无提案块返回 { request: null }；提案非法返回 error（fail-closed，由调用方收口为 blocker）。
 */
export function extractWorkflowProposal(
  items: readonly ThreadItem[],
  ctx: WorkflowProposalContext,
): WorkflowProposalExtraction {
  const marker = '```' + WORKFLOW_PROPOSAL_BLOCK_LANGUAGE;
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i];
    if (item?.type !== 'agent_message') continue;
    const text = item.text ?? '';
    const start = text.indexOf(marker);
    if (start < 0) continue;
    const bodyStart = start + marker.length;
    const end = text.indexOf('```', bodyStart);
    if (end < 0) return { request: null, error: 'workflow proposal block is not closed' };
    return parseWorkflowProposal(text.slice(bodyStart, end).trim(), ctx);
  }
  return { request: null };
}

function parseWorkflowProposal(json: string, ctx: WorkflowProposalContext): WorkflowProposalExtraction {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    return { request: null, error: `workflow proposal is not valid JSON: ${(err as Error).message}` };
  }
  const raw = parsed as RawWorkflowProposal;
  if (typeof raw.objective !== 'string' || !raw.objective.trim()) {
    return { request: null, error: 'workflow proposal requires a non-empty objective' };
  }
  if (typeof raw.script !== 'string' || !raw.script.trim()) {
    return { request: null, error: 'workflow proposal requires a non-empty script' };
  }
  const validation = validateWorkflowScript(raw.script);
  if (!validation.ok) {
    return {
      request: null,
      error: `workflow proposal failed static validation: ${validation.diagnostics.map((d) => `${d.code}:${d.message}`).join('; ')}`,
    };
  }
  return {
    request: {
      taskId: ctx.taskId,
      goalRunId: ctx.goalRunId,
      objective: raw.objective.trim(),
      proposedScript: raw.script,
      estimatedAgents: toPositiveInt(raw.estimatedAgents, 1),
      estimatedTokens: toPositiveInt(raw.estimatedTokens, 0),
      limits: { ...DEFAULT_WORKFLOW_RUNTIME_LIMITS, ...ctx.limits },
    },
  };
}

function toPositiveInt(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.floor(value));
}
