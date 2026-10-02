// 上下文裁切核心：HarnessContextManager
// 负责构造每轮 iteration 的任务包（HarnessContextSlice），按预算裁切。
//
// Gap 4: 通过 renderHarnessContextSlice 渲染成文本，注入到 continuationInput.modeInstruction，
//        不塞 system prompt（避免打爆 cache prefix）。
// trimToBudget: 40k 预算分配 + 7 条裁切规则 + 动态调整。

import type { CompactionSummary, ThreadId, ThreadItem } from '@suanlizi/protocol';
import type {
  EvidenceReceipt,
  HarnessContextSlice,
} from './types.js';
import type { EvidenceLedger } from './evidenceLedger.js';
import type { GoalTracker } from './goalTracker.js';

// ─── ThreadStore 最小接口 ────────────────────────────────────────────────────
export interface HarnessContextStore {
  getRecentItems(threadId: ThreadId, maxItems?: number): Promise<ThreadItem[]>;
  // P6.3: getItems 签名与 ThreadStore.getItems 保持一致，支持 filter 对象
  // — Chinese: getItems signature aligned with ThreadStore.getItems, supports filter object
  getItems(
    threadId: ThreadId,
    filter?: {
      runId?: string;
      turnId?: string;
      type?: string;
      limit?: number;
      afterSequence?: number;
      beforeSequence?: number;
    },
  ): Promise<ThreadItem[]>;
}

// ─── token 估算（粗略，1 token ≈ 4 字符） ─────────────────────────────────────
export function estimateTokens(text: string | undefined | null): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

function estimateItemsTokens(items: ThreadItem[]): number {
  let total = 0;
  for (const item of items) {
    if (item.type === 'agent_message' || item.type === 'user_message' || item.type === 'reasoning') {
      total += estimateTokens(item.text);
    } else if (item.type === 'command_execution') {
      total += estimateTokens(item.command) + estimateTokens(item.aggregatedOutput);
    } else if (item.type === 'tool_call') {
      total += estimateTokens(item.toolName) + estimateTokens(JSON.stringify(item.result ?? ''));
    } else if (item.type === 'file_change') {
      total += estimateTokens((item.changes ?? []).map(c => c.path).join('\n'));
      total += estimateTokens(JSON.stringify(item.hunks ?? []));
    } else if (item.type === 'mcp_tool_call') {
      total += estimateTokens(`${item.server}:${item.tool}`);
      total += estimateTokens(JSON.stringify(item.result ?? ''));
    } else if (item.type === 'error') {
      total += estimateTokens(item.message);
    }
  }
  return total;
}

// ─── 裁切辅助函数 ────────────────────────────────────────────────────────────

function isItemRelatedToNode(item: ThreadItem, activeNodeId?: string): boolean {
  // MVP: 简单判断 — 如果 item 是 file_change 且改了含 activeNodeId 的路径
  if (!activeNodeId) return false;
  if (item.type === 'file_change') {
    return (item.changes ?? []).some(c => c.path.toLowerCase().includes(activeNodeId.toLowerCase()));
  }
  return false;
}

function relevanceScore(r: EvidenceReceipt): number {
  // 失败证据优先 > 通过证据 > 未知
  if (r.status === 'failed') return 3;
  if (r.status === 'passed') return 2;
  return 1;
}

function trimEvidenceRefs(refs: EvidenceReceipt[], budget: number): EvidenceReceipt[] {
  const sorted = [...refs].sort((a, b) => relevanceScore(b) - relevanceScore(a));
  const kept: EvidenceReceipt[] = [];
  let used = 0;
  for (const r of sorted) {
    const cost = estimateTokens(r.summary + (r.refs.path ?? '') + (r.refs.command ?? ''));
    if (used + cost > budget) {
      // 超预算：只保留 id + status（~10 token）
      kept.push({ ...r, summary: '[truncated]', refs: {} });
    } else {
      kept.push(r);
      used += cost;
    }
  }
  return kept;
}

function trimRecentItems(items: ThreadItem[], budget: number, activeNodeId?: string): ThreadItem[] {
  const kept: ThreadItem[] = [];
  let used = 0;

  // 倒序遍历，优先保留 activeNode 相关的 item
  const sorted = [...items].sort((a, b) => {
    const aRel = isItemRelatedToNode(a, activeNodeId) ? 1 : 0;
    const bRel = isItemRelatedToNode(b, activeNodeId) ? 1 : 0;
    if (aRel !== bRel) return bRel - aRel;
    const aTs = (a as { timestamp?: string }).timestamp ?? '';
    const bTs = (b as { timestamp?: string }).timestamp ?? '';
    return bTs.localeCompare(aTs);
  });

  for (const item of sorted) {
    // 规则 5: 旧 reasoning item 默认全部丢弃
    if (item.type === 'reasoning') continue;

    // 规则 7: agent_message 超过 1000 字符只保留前 500 + 后 500
    if (item.type === 'agent_message' && (item.text?.length ?? 0) > 1000) {
      const trimmed: ThreadItem = {
        ...item,
        text: (item.text ?? '').slice(0, 500) + '\n...[truncated]...\n' + (item.text ?? '').slice(-500),
      };
      const cost = 260;
      if (used + cost > budget) continue;
      kept.push(trimmed);
      used += cost;
      continue;
    }

    // 规则 2: command_execution 输出超过 400 字符只保留前 200 + 后 200
    if (item.type === 'command_execution' && (item.aggregatedOutput?.length ?? 0) > 400) {
      const trimmedItem: ThreadItem = {
        ...item,
        aggregatedOutput:
          (item.aggregatedOutput ?? '').slice(0, 200) +
          '\n...[truncated]...\n' +
          (item.aggregatedOutput ?? '').slice(-200),
      };
      const cost = 450;  // 近似
      if (used + cost > budget) continue;
      kept.push(trimmedItem);
      used += cost;
      continue;
    }

    // 规则 3: file_change 只保留 path + kind + summary，丢弃 hunks 整文件 diff
    if (item.type === 'file_change') {
      const trimmedItem: ThreadItem = {
        ...item,
        changes: (item.changes ?? []).map(c => ({
          path: c.path,
          kind: c.kind,
          summary: c.summary,
        })),
        hunks: undefined,  // 丢弃 hunks
      };
      const cost = 100;
      if (used + cost > budget) continue;
      kept.push(trimmedItem);
      used += cost;
      continue;
    }

    // 规则 6: tool_call 结果超过 500 字符只保留前 200 + 后 200
    if (item.type === 'tool_call') {
      const resultStr = item.result !== undefined ? JSON.stringify(item.result) : '';
      if (resultStr.length > 500) {
        const trimmedResult = resultStr.slice(0, 200) + '...[truncated]...' + resultStr.slice(-200);
        const trimmedItem: ThreadItem = {
          ...item,
          result: trimmedResult as unknown,
        };
        const cost = 260;
        if (used + cost > budget) continue;
        kept.push(trimmedItem);
        used += cost;
        continue;
      }
    }

    const cost = estimateItemsTokens([item]);
    if (used + cost > budget) continue;
    kept.push(item);
    used += cost;
  }
  return kept;
}

function trimSummary(summary: CompactionSummary | undefined, budget: number): CompactionSummary | undefined {
  if (!summary) return undefined;
  const totalTokens = estimateTokens(JSON.stringify(summary));
  if (totalTokens <= budget) return summary;

  // 超预算：只保留关键字段
  return {
    ...summary,
    toolResults: summary.toolResults.slice(0, Math.floor(budget * 2)),
    raw: summary.raw.slice(0, Math.floor(budget * 3)),
  };
}

// ─── HarnessContextManager ───────────────────────────────────────────────────

export class HarnessContextManager {
  constructor(
    private store: HarnessContextStore,
    private ledger: EvidenceLedger,
    private goalTracker: GoalTracker,
  ) {}

  /**
   * 每轮 iteration 构造任务包。
   * 1. 获取 HarnessState
   * 2. 从 ThreadStore.getRecentItems 取最近 item
   * 3. 按 evidence 相关度过滤（不是简单取最近 N 个）
   * 4. 从 EvidenceLedger 选择支撑 failedCriteria 的证据
   * 5. 组装 HarnessContextSlice
   * 6. trimToBudget 裁切到预算内
   */
  async buildIterationContext(
    threadId: ThreadId,
    budget: number,
  ): Promise<HarnessContextSlice> {
    const state = this.goalTracker.getState();

    // 2. 取最近 item（比 budget 稍多取，后续裁切）
    const recentItems = await this.store.getRecentItems(threadId, 60);

    // 3. 按相关度过滤
    const filteredItems = this.filterRelevantItems(recentItems, state.activeNodeId, state.plan);

    // 4. 选择证据
    const evidenceRefs = this.selectEvidenceForCriteria(
      state.lastEvaluation?.failedCriteria ?? state.goal.acceptanceCriteria,
      20,
    );

    // 5. 组装 slice
    const slice: HarnessContextSlice = {
      systemPrefix: '',  // 由 AgentLoop.buildMessages 填充，这里留空
      goal: state.goal.objective,
      acceptanceCriteria: state.goal.acceptanceCriteria,
      currentNode: state.plan.find(n => n.id === state.activeNodeId) ?? null,
      recentItems: filteredItems,
      failedCriteria: state.lastEvaluation?.failedCriteria ?? [],
      lastFailure: this.extractLastFailure(state),
      evidenceRefs,
      summary: undefined,  // MVP: 不从 thread.tags 读取 compactedSummary，由 AgentLoop 处理
      tokenBudget: budget,
    };

    // 6. 裁切
    return this.trimToBudget(slice, budget);
  }

  /**
   * 按验收标准选择相关证据。
   */
  selectEvidenceForCriteria(criteria: string[], maxItems: number): EvidenceReceipt[] {
    const out: EvidenceReceipt[] = [];
    const seen = new Set<string>();
    for (const c of criteria) {
      for (const r of this.ledger.getEvidenceForCriteria(c)) {
        if (seen.has(r.id)) continue;
        seen.add(r.id);
        out.push(r);
        if (out.length >= maxItems) return out;
      }
    }
    // 不足时用最近证据补足
    if (out.length < maxItems) {
      for (const r of this.ledger.getRecentEvidence(maxItems * 2)) {
        if (seen.has(r.id)) continue;
        seen.add(r.id);
        out.push(r);
        if (out.length >= maxItems) break;
      }
    }
    return out;
  }

  /**
   * 压缩已完成节点的上下文（标记为已压缩，下轮不再全量保留）。
   * MVP: 仅从 recentItems 中过滤掉已完成节点的旧 reasoning item。
   */
  compactCompletedIteration(_nodeId: string): void {
    // 实际过滤在 buildIterationContext 中按 activeNodeId 判断
    // 这里保留接口供未来扩展（例如写 tag 标记节点已压缩）
  }

  /**
   * 保留失败上下文（不压缩）。
   */
  retainFailureContext(_nodeId: string, _reason: string): void {
    // 失败节点的 item 在 filterRelevantItems 中优先保留
  }

  /**
   * 预算裁切 — 实施第九章 trimToBudget 细则。
   *
   * 预算分配（总预算默认 40k）：
   * - Stable / system: 不裁（由 AgentLoop 保证）
   * - Goal + criteria + active node: 不裁
   * - Failure context: 15%
   * - Evidence refs: 25%
   * - Recent relevant items: 35%
   * - Compacted narrative: 15%
   * - Reserve: 10%
   */
  trimToBudget(slice: HarnessContextSlice, maxTokens: number): HarnessContextSlice {
    const kept: HarnessContextSlice = { ...slice };

    // 1. 不可裁层：goal + acceptanceCriteria + active node
    let remaining = maxTokens;
    remaining -= estimateTokens(kept.goal);
    remaining -= estimateTokens(kept.acceptanceCriteria.join('\n'));
    if (kept.currentNode) {
      remaining -= estimateTokens(kept.currentNode.description);
    }
    if (remaining < 0) remaining = 0;

    // 2. Failure context：保留最近 1-2 轮（~15%）
    const failureBudget = Math.floor(maxTokens * 0.15);
    if (kept.lastFailure) {
      const failCost = estimateTokens(kept.lastFailure.reason);
      if (failCost > failureBudget) {
        kept.lastFailure = {
          node: kept.lastFailure.node,
          reason: kept.lastFailure.reason.slice(0, failureBudget * 3) + '…',
        };
      }
    }

    // 3. Evidence receipts：~25%
    const evidenceBudget = Math.floor(maxTokens * 0.25);
    kept.evidenceRefs = trimEvidenceRefs(kept.evidenceRefs, evidenceBudget);

    // 4. Recent items：~35%
    const recentBudget = Math.floor(maxTokens * 0.35);
    kept.recentItems = trimRecentItems(kept.recentItems, recentBudget, kept.currentNode?.id);

    // 5. Compacted narrative：~15%
    const narrativeBudget = Math.floor(maxTokens * 0.15);
    kept.summary = trimSummary(kept.summary, narrativeBudget);

    // 6. Reserve 10% 不动

    return kept;
  }

  // ─── 内部工具 ──────────────────────────────────────────────────────────────

  private filterRelevantItems(
    items: ThreadItem[],
    _activeNodeId: string | null,
    _plan: { id: string; status: string }[],
  ): ThreadItem[] {
    return items.filter((item) => {
      // 规则 4: 已完成节点的旧 item 优先丢弃（但保留 error / file_change 作为证据）
      // 规则 7: 旧 reasoning item 默认丢弃
      if (item.type === 'reasoning') return false;

      // harness_continuation 本身不进入上下文（它是注入指令的载体）
      if (item.type === 'harness_continuation') return false;

      // user_message 保留（作为对话起点）
      if (item.type === 'user_message') return true;

      // 其他 item 默认保留，后续 trimToBudget 会按预算裁切
      return true;
    });
  }

  private extractLastFailure(
    state: ReturnType<GoalTracker['getState']>,
  ): { node: string; reason: string } | undefined {
    if (!state.lastEvaluation) return undefined;
    if (state.lastEvaluation.failedCriteria.length === 0) return undefined;
    const failedNode = state.plan.find(n => n.status === 'failed');
    return {
      node: failedNode?.id ?? state.activeNodeId ?? 'unknown',
      reason: state.lastEvaluation.blocker ??
        state.lastEvaluation.failedCriteria.join('; '),
    };
  }
}

// ─── Gap 4: renderHarnessContextSlice — 注入模型的任务包渲染 ─────────────────
//
// 关键原则：
// - 不塞 system prompt（动态状态每轮变化，会打爆 cache prefix）
// - 放 hidden user/turn instruction（通过 modeInstruction 注入，走正常 turn 消息流）
// - EvidenceReceipt 只传 reference（id + summary + status），不传全量内容

export function renderHarnessContextSlice(slice: HarnessContextSlice): string {
  const lines: string[] = [];
  lines.push('[harness context]');
  lines.push('# Goal');
  lines.push(slice.goal || '(empty)');
  lines.push('');
  lines.push('# Acceptance Criteria');
  if (slice.acceptanceCriteria.length === 0) {
    lines.push('—');
  } else {
    lines.push(...slice.acceptanceCriteria.map((c, i) => `${i + 1}. ${c}`));
  }
  lines.push('');
  lines.push('# Current Plan Node');
  lines.push(slice.currentNode?.description ?? '—');
  lines.push('');
  lines.push('# Failed Criteria (focus here)');
  lines.push(slice.failedCriteria.length > 0 ? slice.failedCriteria.join(', ') : '—');
  lines.push('');
  lines.push('# Last Failure');
  if (slice.lastFailure) {
    lines.push(`node: ${slice.lastFailure.node}`);
    lines.push(`reason: ${slice.lastFailure.reason}`);
  } else {
    lines.push('—');
  }
  lines.push('');
  lines.push('# Evidence Receipts (references only, not full content)');
  if (slice.evidenceRefs.length === 0) {
    lines.push('—');
  } else {
    for (const r of slice.evidenceRefs) {
      const supports = r.supportsCriteria.length > 0 ? r.supportsCriteria.join(', ') : '—';
      const refInfo: string[] = [];
      if (r.refs.path) refInfo.push(`path=${r.refs.path}`);
      if (r.refs.command) refInfo.push(`cmd=${r.refs.command}`);
      if (r.refs.toolName) refInfo.push(`tool=${r.refs.toolName}`);
      const refStr = refInfo.length > 0 ? ` [${refInfo.join('; ')}]` : '';
      lines.push(`- [${r.status}] ${r.kind}: ${r.summary}${refStr} (supports: ${supports})`);
    }
  }
  lines.push('');
  lines.push('# Recent Progress Summary');
  if (slice.summary) {
    lines.push(`userGoal: ${slice.summary.userGoal}`);
    lines.push(`completedWork: ${slice.summary.completedWork}`);
    lines.push(`openTasks: ${slice.summary.openTasks}`);
  } else {
    lines.push('—');
  }
  lines.push('[/harness context]');
  return lines.join('\n');
}
