// 独立模型语义验收：GoalEvaluator
// 借鉴 DeerFlow evaluate_goal_completion — 独立非思考模型，fail-closed。
//
// Gap 8: criteriaEvidenceMap — evaluator 输出中声明 criteria 与 evidence id 对应关系。
//
// fail-closed 原则：模型解析失败 / 无法判定时，一律视为 not satisfied。

import type { GoalEvaluation, ThreadItem } from '@suanlizi/protocol';
import type {
  EvidenceReceipt,
  HarnessGoal,
  HarnessState,
} from './types.js';

// ─── ModelGateway 最小接口（避免依赖具体实现） ──────────────────────────────
export interface EvaluatorModelGateway {
  /**
   * 发送一次性 prompt 给模型，返回文本响应。
   * 不走工具循环，不产生 ThreadItem。
   */
  completeOnce(prompt: string, options?: {
    signal?: AbortSignal;
    modelName?: string;
  }): Promise<string>;
}

// ─── 评估结果解析错误 ─────────────────────────────────────────────────────────

export class GoalEvaluationParseError extends Error {
  constructor(message: string, public readonly raw: string) {
    super(message);
    this.name = 'GoalEvaluationParseError';
  }
}

// ─── GoalEvaluator ───────────────────────────────────────────────────────────

export class GoalEvaluator {
  constructor(
    private model: EvaluatorModelGateway,
    private evaluatorModelName?: string,
  ) {}

  /**
   * 评估当前 harness 状态是否达标。
   * 使用独立模型（非思考模型），fail-closed。
   */
  async evaluate(
    goal: HarnessGoal,
    state: HarnessState,
    recentItems: ThreadItem[],
    evidenceReceipts: EvidenceReceipt[],
    options?: { signal?: AbortSignal },
  ): Promise<GoalEvaluation> {
    const prompt = this.buildPrompt(goal, state, recentItems, evidenceReceipts);
    let raw: string;
    try {
      raw = await this.model.completeOnce(prompt, {
        signal: options?.signal,
        modelName: this.evaluatorModelName,
      });
    } catch (err) {
      // 模型调用失败：fail-closed，返回 continue
      return this.failClosed(goal, state, `evaluator model error: ${(err as Error).message}`);
    }

    try {
      return this.parseEvaluation(raw, goal, state, evidenceReceipts);
    } catch (err) {
      // 解析失败：fail-closed
      return this.failClosed(goal, state, `evaluation parse error: ${(err as Error).message}`);
    }
  }

  // ─── Prompt 构造 ───────────────────────────────────────────────────────────

  private buildPrompt(
    goal: HarnessGoal,
    state: HarnessState,
    recentItems: ThreadItem[],
    evidenceReceipts: EvidenceReceipt[],
  ): string {
    const lines: string[] = [];
    lines.push('You are a strict completion evaluator for an AI coding assistant.');
    lines.push('Decide whether the active goal is fully satisfied using ONLY the visible conversation evidence and evidence receipts.');
    lines.push('Fail-closed: if uncertain, return satisfied=false.');
    lines.push('');
    lines.push(`Goal: ${goal.objective}`);
    lines.push('');
    lines.push('Acceptance Criteria:');
    lines.push(...goal.acceptanceCriteria.map((c, i) => `${i + 1}. ${c}`));
    lines.push('');
    lines.push('Plan State:');
    if (state.plan.length === 0) {
      lines.push('—');
    } else {
      for (const node of state.plan) {
        lines.push(`- [${node.status}] ${node.id}: ${node.description}`);
      }
    }
    lines.push('');
    lines.push('Evidence Receipts:');
    if (evidenceReceipts.length === 0) {
      lines.push('—');
    } else {
      for (const r of evidenceReceipts) {
        const supports = r.supportsCriteria.length > 0 ? r.supportsCriteria.join(', ') : '—';
        lines.push(`- [${r.status}] ${r.kind}: ${r.summary} (supports: ${supports})`);
      }
    }
    lines.push('');
    lines.push('Recent Conversation (last 5 items):');
    const recent = recentItems.slice(-5);
    if (recent.length === 0) {
      lines.push('—');
    } else {
      for (const item of recent) {
        const text = this.itemSummary(item);
        lines.push(`- [${item.type}] ${text}`);
      }
    }
    lines.push('');
    lines.push('Respond with ONLY a JSON object (no markdown, no code fence) with the following fields:');
    lines.push('{');
    lines.push('  "satisfied": boolean,');
    lines.push('  "status": "satisfied" | "continue" | "needs_user_input" | "blocked",');
    lines.push('  "passedCriteria": string[],');
    lines.push('  "failedCriteria": string[],');
    lines.push('  "blocker": string (optional),');
    lines.push('  "nextHint": string (optional),');
    lines.push('  "evidenceSummary": string,');
    lines.push('  "reasoning": string,');
    lines.push('  "criteriaEvidenceMap": { "criterion": ["evidenceId1", ...] }');
    lines.push('}');
    return lines.join('\n');
  }

  private itemSummary(item: ThreadItem): string {
    if (item.type === 'agent_message' || item.type === 'user_message' || item.type === 'reasoning') {
      return (item.text ?? '').slice(0, 200);
    }
    if (item.type === 'command_execution') {
      return `${item.command} (exit ${item.exitCode})`;
    }
    if (item.type === 'tool_call') {
      return `${item.toolName} [${item.status}]`;
    }
    if (item.type === 'file_change') {
      return (item.changes ?? []).map(c => `${c.kind} ${c.path}`).join(', ');
    }
    if (item.type === 'error') {
      return item.message.slice(0, 200);
    }
    return `[${item.type}]`;
  }

  // ─── 解析 ───────────────────────────────────────────────────────────────────

  private parseEvaluation(
    raw: string,
    goal: HarnessGoal,
    state: HarnessState,
    evidenceReceipts: EvidenceReceipt[],
  ): GoalEvaluation {
    // 去除 markdown code fence
    let jsonStr = raw.trim();
    if (jsonStr.startsWith('```')) {
      jsonStr = jsonStr.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
    }

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(jsonStr);
    } catch {
      throw new GoalEvaluationParseError('evaluator output is not valid JSON', raw);
    }

    const satisfied = parsed.satisfied === true;
    const status = (parsed.status as string) ?? (satisfied ? 'satisfied' : 'continue');

    if (!['satisfied', 'continue', 'needs_user_input', 'blocked'].includes(status)) {
      throw new GoalEvaluationParseError(`invalid status: ${status}`, raw);
    }

    const passedCriteria = Array.isArray(parsed.passedCriteria)
      ? (parsed.passedCriteria as unknown[]).filter(s => typeof s === 'string') as string[]
      : [];
    const failedCriteria = Array.isArray(parsed.failedCriteria)
      ? (parsed.failedCriteria as unknown[]).filter(s => typeof s === 'string') as string[]
      : [];

    // 计算 progressSignature
    const newEvidenceIds = (state.lastEvaluation ? '' : 'first');
    const progressSignature = this.computeProgressSignature(failedCriteria, state, newEvidenceIds);

    // Gap 8 + P3 证据硬校验：criteriaEvidenceMap 只保留指向真实存在的 criterion 与
    // evidence id 的映射；出现任何非法引用时 fail-closed（satisfied 强制 false），
    // 防止模型凭空引用证据 id（计划 §7 P3 验收条款）。
    let criteriaEvidenceMap: Record<string, string[]> | undefined;
    let invalidEvidenceRefs = false;
    if (parsed.criteriaEvidenceMap && typeof parsed.criteriaEvidenceMap === 'object') {
      const validCriteria = new Set(goal.acceptanceCriteria);
      const validEvidenceIds = new Set(evidenceReceipts.map((r) => r.id));
      criteriaEvidenceMap = {};
      for (const [k, v] of Object.entries(parsed.criteriaEvidenceMap as Record<string, unknown>)) {
        if (!validCriteria.has(k)) {
          invalidEvidenceRefs = true;
          continue;
        }
        if (!Array.isArray(v)) continue;
        const ids: string[] = [];
        for (const id of v as unknown[]) {
          if (typeof id !== 'string') {
            invalidEvidenceRefs = true;
            continue;
          }
          if (!validEvidenceIds.has(id)) {
            invalidEvidenceRefs = true;
            continue;
          }
          ids.push(id);
        }
        criteriaEvidenceMap[k] = ids;
      }
    }

    if (invalidEvidenceRefs) {
      return {
        satisfied: false,
        status: 'continue',
        passedCriteria: [],
        failedCriteria: goal.acceptanceCriteria,
        blocker: 'evaluation rejected: criteriaEvidenceMap referenced unknown criteria or evidence ids',
        evidenceSummary: '',
        progressSignature: `invalid_criteria_evidence_map::${state.iteration}`,
        reasoning: 'Fail-closed: the evaluator output referenced criteria/evidence ids that do not exist; refusing to accept satisfaction.',
        criteriaEvidenceMap,
      };
    }

    return {
      satisfied,
      status: status as 'satisfied' | 'continue' | 'needs_user_input' | 'blocked',
      passedCriteria,
      failedCriteria,
      blocker: typeof parsed.blocker === 'string' ? parsed.blocker : undefined,
      nextHint: typeof parsed.nextHint === 'string' ? parsed.nextHint : undefined,
      evidenceSummary: typeof parsed.evidenceSummary === 'string' ? parsed.evidenceSummary : '',
      progressSignature,
      reasoning: typeof parsed.reasoning === 'string' ? parsed.reasoning : '',
      criteriaEvidenceMap,
    };
  }

  private computeProgressSignature(
    failedCriteria: string[],
    state: HarnessState,
    newEvidenceIds: string,
  ): string {
    // SHA256(failedCriteria.sort().join('|') + completedNodeIds.sort().join('|') + newEvidenceIds + lastBlocker)
    // MVP: 简单字符串拼接，不加密（足够检测无进展）
    const completedNodes = state.plan.filter(n => n.status === 'completed').map(n => n.id).sort().join('|');
    const failed = [...failedCriteria].sort().join('|');
    const blocker = state.lastEvaluation?.blocker ?? '';
    return `${failed}::${completedNodes}::${newEvidenceIds}::${blocker}`;
  }

  private failClosed(goal: HarnessGoal, state: HarnessState, reason: string): GoalEvaluation {
    return {
      satisfied: false,
      status: 'continue',
      passedCriteria: [],
      failedCriteria: goal.acceptanceCriteria,
      blocker: reason,
      evidenceSummary: '',
      progressSignature: `failclosed::${reason}`,
      reasoning: `Evaluator failed closed: ${reason}`,
    };
  }
}
