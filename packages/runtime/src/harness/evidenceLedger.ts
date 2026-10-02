// 证据收据索引层：不复制全量历史，只存索引和收据。
// 原始内容通过 itemId 从 ThreadStore.getItems() 获取。
//
// 借鉴 Reasonix evidence.Ledger，但：
// - 不做平行历史库
// - 支持从 ThreadStore items 重建（Gap 5: rebuildFromThreadItems）
// - 按 harnessRunId 过滤（实施点 2: item.harnessRunId 字段）
// - supportsCriteria 两层填充（Gap 8: deterministic + evaluator）

import type { ThreadId, ThreadItem, TurnId } from '@suanlizi/protocol';
import type {
  EvidenceReceipt,
  EvidenceReceiptKind,
  EvidenceReceiptRefs,
  EvidenceReceiptStatus,
  HarnessItemFields,
} from './types.js';

// ─── workflow_result 证据命名空间（计划 §11.3 + 盘点 §2/§4.4） ────────────────
/**
 * workflow_result 证据的 id 固定为 `wev_<runId>_<agentCallId>`；run 级（无单次 agent 调用）
 * 时末段用盘点 §2 冻结的 `run` 占位，即 `wev_<runId>_run`。该命名空间与 thread item 通道的
 * `ev_<itemId>` 完全隔离，前缀互斥（`ev_` 不可能等于 `wev_`），因此两个重建源可以共存于同一
 * ledger 而不互相覆盖。
 */
export const WORKFLOW_EVIDENCE_ID_PREFIX = 'wev_';
/** run 级 workflow 证据 id 的末段保留占位；agentCallId 不得取该值。 */
export const WORKFLOW_EVIDENCE_RUN_SEGMENT = 'run';

export function workflowEvidenceId(runId: string, agentCallId?: string): string {
  const trimmed = (agentCallId ?? '').trim();
  return `${WORKFLOW_EVIDENCE_ID_PREFIX}${runId}_${trimmed || WORKFLOW_EVIDENCE_RUN_SEGMENT}`;
}

export function isWorkflowEvidenceId(id: string): boolean {
  return id.startsWith(WORKFLOW_EVIDENCE_ID_PREFIX);
}

/**
 * `recordWorkflowResult` 的入参，同时充当可序列化的重建 seed（盘点 §4.4 清单第 4 项）：
 * 第二重建源只接受可序列化数组，不依赖存储包、不读 workflow_runs 表。
 * `agentCallId` 缺省表示 run 级证据（对应 `WorkflowEvidenceSource.kind === 'workflow_run'`）。
 */
export interface WorkflowResultEvidenceInput {
  runId: string;
  agentCallId?: string;
  summary: string;
  status: EvidenceReceiptStatus;
  refs?: EvidenceReceiptRefs;
  threadId?: ThreadId;
  harnessRunId?: string;
  supportsCriteria?: string[];
  timestamp?: string;
}

/** 把已物化的 workflow 证据降级为可持久化 seed，供存储层落库后再重建。 */
export function toWorkflowEvidenceSeed(receipt: EvidenceReceipt): WorkflowResultEvidenceInput {
  return {
    runId: receipt.refs.runId ?? '',
    agentCallId: receipt.refs.agentCallId,
    threadId: receipt.threadId,
    harnessRunId: receipt.harnessRunId,
    summary: receipt.summary,
    status: receipt.status,
    refs: { ...receipt.refs },
    supportsCriteria: [...receipt.supportsCriteria],
    timestamp: receipt.timestamp,
  };
}

/** kind 过滤谓词；不传 kinds 时全放行，保证旧调用签名与行为兼容。 */
export function evidenceKindFilter(
  kinds?: readonly EvidenceReceiptKind[],
): (receipt: EvidenceReceipt) => boolean {
  if (!kinds || kinds.length === 0) return () => true;
  const set = new Set<EvidenceReceiptKind>(kinds);
  return (receipt) => set.has(receipt.kind);
}

// ─── 辅助：从 ThreadItem 提取 harnessRunId（实施点 2） ────────────────────────
function getItemHarnessRunId(item: ThreadItem): string | undefined {
  const fields = item as unknown as HarnessItemFields;
  return fields.harnessRunId;
}

// ─── 辅助：从 ThreadItem 提取文本/路径/命令 ───────────────────────────────────

function extractItemPaths(item: ThreadItem): string[] {
  if (item.type === 'file_change') {
    return (item.changes ?? []).map(c => c.path);
  }
  return [];
}

function extractItemCommand(item: ThreadItem): string | undefined {
  if (item.type === 'command_execution') {
    return item.command;
  }
  return undefined;
}

function extractItemToolName(item: ThreadItem): string | undefined {
  if (item.type === 'tool_call') {
    return item.toolName;
  }
  if (item.type === 'mcp_tool_call') {
    return `${item.server}:${item.tool}`;
  }
  return undefined;
}

function basename(p: string): string {
  const parts = p.replace(/\\/g, '/').split('/');
  return parts[parts.length - 1] ?? p;
}

// ─── Gap 8: supportsCriteria deterministic 推导 ────────────────────────────────
// 规则 1：criterion 中提到路径/文件名，且 item 改了对应文件
// 规则 2：criterion 提到 test/build/lint/typecheck，且 item 是对应 verification command
// 规则 3：criterion 包含 tool name 关键词，且 item 是该 tool 调用
//
// 注意：isVerificationCommand 在 readinessCritic.ts 中定义；这里只做关键词匹配，
// 真正的 verification 判定由 ReadinessCritic.mutation_verified gate 完成。
function deriveSupportsCriteria(item: ThreadItem, criteria: string[]): string[] {
  const supported: string[] = [];
  const paths = extractItemPaths(item);
  const command = extractItemCommand(item);
  const toolName = extractItemToolName(item);

  for (const criterion of criteria) {
    const c = criterion.toLowerCase();

    // 规则 1：criterion 中提到路径/文件名，且 item 改了对应文件
    let matched = false;
    for (const p of paths) {
      const lower = p.toLowerCase();
      const base = basename(p).toLowerCase();
      if (c.includes(lower) || c.includes(base)) {
        supported.push(criterion);
        matched = true;
        break;
      }
    }
    if (matched) continue;

    // 规则 2：criterion 提到 test/build/lint/typecheck，且 item 是对应 command
    // （这里只做弱关键词匹配；严格 verification 由 ReadinessCritic 判定）
    if (/test|build|lint|typecheck/.test(c) && command) {
      if (/^(npm|pnpm|yarn|npx|tsc|vitest|jest|pytest|python|go|cargo|mvn|gradle|make|dotnet)\b/.test(command.trim())) {
        supported.push(criterion);
        continue;
      }
    }

    // 规则 3：criterion 包含 tool name 关键词，且 item 是该 tool 调用
    if (toolName && c.includes(toolName.toLowerCase())) {
      supported.push(criterion);
    }
  }
  return [...new Set(supported)];  // 去重
}

// ─── EvidenceLedger ───────────────────────────────────────────────────────────

export class EvidenceLedger {
  // receipts: id → EvidenceReceipt
  private receipts: Map<string, EvidenceReceipt> = new Map();
  // byThread: threadId → Set<receiptId>
  private byThread: Map<ThreadId, Set<string>> = new Map();
  // byTurn: turnId → Set<receiptId>
  private byTurn: Map<TurnId, Set<string>> = new Map();

  // 当前关联的 criteria（用于 deriveSupportsCriteria）
  private currentCriteria: string[] = [];

  /**
   * 设置当前验收标准，用于后续 recordItem 时推导 supportsCriteria。
   * 每次 harness iteration 开始前由 TaskHarnessEngine 调用。
   */
  setCriteria(criteria: string[]): void {
    this.currentCriteria = criteria;
  }

  /**
   * 从单个 ThreadItem 提取证据收据。
   * 不产生证据的 item 类型（user_message / reasoning / todo_list 等）返回 null。
   */
  recordItem(
    item: ThreadItem,
    threadId: ThreadId,
    harnessRunId: string,
  ): EvidenceReceipt | null {
    const receipt = this.buildReceipt(item, threadId, harnessRunId);
    if (!receipt) return null;

    this.receipts.set(receipt.id, receipt);
    if (!this.byThread.has(threadId)) this.byThread.set(threadId, new Set());
    this.byThread.get(threadId)!.add(receipt.id);
    if (receipt.turnId) {
      if (!this.byTurn.has(receipt.turnId)) this.byTurn.set(receipt.turnId, new Set());
      this.byTurn.get(receipt.turnId)!.add(receipt.id);
    }
    return receipt;
  }

  /**
   * 批量记录一个 turn 的所有 item。
   * 返回实际产生的证据收据（跳过不产生证据的 item）。
   */
  recordTurn(
    items: ThreadItem[],
    threadId: ThreadId,
    turnId: TurnId,
    harnessRunId: string,
  ): EvidenceReceipt[] {
    const out: EvidenceReceipt[] = [];
    for (const item of items) {
      // 实施点 2: 优先用 item.harnessRunId 校验（若存在则必须匹配）
      const itemRunId = getItemHarnessRunId(item);
      if (itemRunId && itemRunId !== harnessRunId) continue;

      const r = this.recordItem(item, threadId, harnessRunId);
      if (r) {
        // 确保 turnId 一致（buildReceipt 里可能已用 item.turnId）
        r.turnId = turnId;
        out.push(r);
      }
    }
    return out;
  }

  // ─── workflow_result 写入通道（计划 §11.3、盘点 §4.4 清单第 3 项） ────────────

  /**
   * 不经 ThreadItem 的第二写入通道：WorkflowRun 完成或某次 `agent()` 结构化输出通过 schema
   * 校验后调用。id 固定 `wev_<runId>_<agentCallId>`（run 级为 `wev_<runId>_run`），
   * 与 `ev_<itemId>` 命名空间互斥；turnId / itemId 故意缺省，refs 承载 runId + agentCallId。
   *
   * 同一 (runId, agentCallId) 重复写入是幂等的：保留原 timestamp / 已有 supportsCriteria，
   * 只刷新 status / summary / refs（用于 agent_call 终态回写）。
   */
  recordWorkflowResult(input: WorkflowResultEvidenceInput): EvidenceReceipt {
    const runId = (input.runId ?? '').trim();
    if (!runId) throw new Error('recordWorkflowResult: runId must be a non-empty string');
    const rawAgentCallId = (input.agentCallId ?? '').trim();
    if (rawAgentCallId === WORKFLOW_EVIDENCE_RUN_SEGMENT) {
      // 保留 sentinel，否则 (runId, agentCallId='run') 与 run 级证据 id 碰撞。
      throw new Error(
        `recordWorkflowResult: agentCallId must not be the reserved segment "${WORKFLOW_EVIDENCE_RUN_SEGMENT}"`,
      );
    }
    const agentCallId = rawAgentCallId || undefined;
    const id = workflowEvidenceId(runId, agentCallId);
    const threadId = input.threadId ?? '';
    const previous = this.receipts.get(id);

    const receipt: EvidenceReceipt = {
      id,
      threadId,
      sourceKind: 'workflow',
      kind: 'workflow_result',
      harnessRunId: input.harnessRunId ?? previous?.harnessRunId ?? '',
      summary: this.truncate(input.summary ?? '', 200),
      refs: {
        ...previous?.refs,
        ...input.refs,
        // runId / agentCallId 由 id 反向决定，不接受调用方覆盖，防止命名空间漂移。
        runId,
        agentCallId,
      },
      supportsCriteria: [
        ...new Set(input.supportsCriteria ?? previous?.supportsCriteria ?? []),
      ],
      status: input.status,
      timestamp: previous?.timestamp ?? input.timestamp ?? new Date().toISOString(),
    };

    this.receipts.set(id, receipt);
    if (threadId) {
      if (!this.byThread.has(threadId)) this.byThread.set(threadId, new Set());
      this.byThread.get(threadId)!.add(id);
    }
    // workflow 证据无 turnId，不进 byTurn 索引（recordItem 里也已按 `if (receipt.turnId)` 守卫）。
    return receipt;
  }

  // ─── 构造 receipt ──────────────────────────────────────────────────────────

  private buildReceipt(
    item: ThreadItem,
    threadId: ThreadId,
    harnessRunId: string,
  ): EvidenceReceipt | null {
    const id = `ev_${item.id}`;
    const timestamp = (item as { timestamp?: string }).timestamp ?? new Date().toISOString();
    const turnId = (item as { turnId?: string }).turnId ?? '';
    const supports = deriveSupportsCriteria(item, this.currentCriteria);

    switch (item.type) {
      case 'tool_call': {
        const status: EvidenceReceiptStatus =
          item.status === 'completed' ? 'passed' :
          item.status === 'failed' ? 'failed' : 'unknown';
        const kind: EvidenceReceiptKind = item.status === 'failed' ? 'error' : 'tool';
        return {
          id, threadId, turnId, itemId: item.id, harnessRunId,
          sourceKind: 'thread_item' as const,
          kind,
          summary: this.truncate(`${item.toolName}: ${this.stringifyResult(item.result)}`, 200),
          refs: { toolName: item.toolName },
          supportsCriteria: supports,
          status,
          timestamp,
        };
      }
      case 'command_execution': {
        const status: EvidenceReceiptStatus =
          item.status === 'completed' ? 'passed' :
          item.status === 'failed' ? 'failed' : 'unknown';
        const kind: EvidenceReceiptKind = item.status === 'failed' ? 'error' : 'command';
        return {
          id, threadId, turnId, itemId: item.id, harnessRunId,
          sourceKind: 'thread_item' as const,
          kind,
          summary: this.truncate(`${item.command}\n${item.aggregatedOutput ?? ''}`, 200),
          refs: { command: item.command },
          supportsCriteria: supports,
          status,
          timestamp,
        };
      }
      case 'file_change': {
        if (item.status !== 'completed') return null;
        const paths = (item.changes ?? []).map(c => c.path);
        return {
          id, threadId, turnId, itemId: item.id, harnessRunId,
          sourceKind: 'thread_item' as const,
          kind: 'file_change',
          summary: this.truncate(paths.join(', '), 200),
          refs: { path: paths[0] },
          supportsCriteria: supports,
          status: 'passed',
          timestamp,
        };
      }
      case 'mcp_tool_call': {
        const status: EvidenceReceiptStatus =
          item.status === 'completed' ? 'passed' :
          item.status === 'failed' ? 'failed' : 'unknown';
        const kind: EvidenceReceiptKind = item.status === 'failed' ? 'error' : 'mcp';
        return {
          id, threadId, turnId, itemId: item.id, harnessRunId,
          sourceKind: 'thread_item' as const,
          kind,
          summary: this.truncate(`${item.server}:${item.tool}`, 200),
          refs: { toolName: `${item.server}:${item.tool}` },
          supportsCriteria: supports,
          status,
          timestamp,
        };
      }
      case 'error': {
        return {
          id, threadId, turnId, itemId: item.id, harnessRunId,
          sourceKind: 'thread_item' as const,
          kind: 'error',
          summary: this.truncate(item.message, 200),
          refs: {},
          supportsCriteria: supports,
          status: 'failed',
          timestamp,
        };
      }
      default:
        // user_message / agent_message / reasoning / workflow_checkpoint / project_checkpoint /
        // rollback_conflict / context_compaction / web_search / todo_list / harness_continuation
        // 这些类型不产生证据
        return null;
    }
  }

  private truncate(s: string, max: number): string {
    if (s.length <= max) return s;
    return s.slice(0, max) + '…';
  }

  private stringifyResult(result: unknown): string {
    if (result === undefined || result === null) return '';
    if (typeof result === 'string') return result;
    try {
      return JSON.stringify(result).slice(0, 200);
    } catch {
      return String(result);
    }
  }

  // ─── 查询 API ──────────────────────────────────────────────────────────────

  hasSuccessfulCommand(command: string, sinceTurnId?: TurnId): boolean {
    for (const r of this.receipts.values()) {
      if (sinceTurnId && r.turnId && this.isTurnBefore(r.turnId, sinceTurnId)) continue;
      if (r.kind === 'command' && r.status === 'passed' && r.refs.command === command) {
        return true;
      }
    }
    return false;
  }

  hasSuccessfulWrite(paths: string[], sinceTurnId?: TurnId): boolean {
    const set = new Set(paths);
    for (const r of this.receipts.values()) {
      if (sinceTurnId && r.turnId && this.isTurnBefore(r.turnId, sinceTurnId)) continue;
      if (r.kind === 'file_change' && r.status === 'passed' && r.refs.path && set.has(r.refs.path)) {
        return true;
      }
    }
    return false;
  }

  hasSuccessfulReadOrWrite(paths: string[], sinceTurnId?: TurnId): boolean {
    // MVP: 等同 hasSuccessfulWrite；read 证据由 tool_call 类型承载
    return this.hasSuccessfulWrite(paths, sinceTurnId);
  }

  hasFailedTool(toolName: string, sinceTurnId?: TurnId): boolean {
    for (const r of this.receipts.values()) {
      if (sinceTurnId && r.turnId && this.isTurnBefore(r.turnId, sinceTurnId)) continue;
      if (r.status === 'failed' && r.refs.toolName === toolName) return true;
    }
    return false;
  }

  getEvidenceForCriteria(criteria: string): EvidenceReceipt[] {
    const out: EvidenceReceipt[] = [];
    for (const r of this.receipts.values()) {
      if (r.supportsCriteria.includes(criteria)) out.push(r);
    }
    return out;
  }

  getRecentEvidence(limit: number, opts?: { kinds?: readonly EvidenceReceiptKind[] }): EvidenceReceipt[] {
    // 盘点 §4.4 清单第 8 项：允许按 kind 过滤，避免 workflow_result 被 20 条窗口挤掉；
    // 不传 opts 时与旧签名完全等价（既有调用零回归）。
    const matches = evidenceKindFilter(opts?.kinds);
    const all = [...this.receipts.values()].filter(matches);
    all.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
    return all.slice(0, limit);
  }

  /** 只取 workflow 命名空间的证据（id 前缀 wev_）。 */
  getWorkflowEvidence(): EvidenceReceipt[] {
    return [...this.receipts.values()].filter((r) => isWorkflowEvidenceId(r.id));
  }

  getToolCallCount(toolName: string): number {
    let count = 0;
    for (const r of this.receipts.values()) {
      if (r.refs.toolName === toolName) count++;
    }
    return count;
  }

  getErrorCount(): number {
    let count = 0;
    for (const r of this.receipts.values()) {
      if (r.kind === 'error' || r.status === 'failed') count++;
    }
    return count;
  }

  getAll(): EvidenceReceipt[] {
    return [...this.receipts.values()];
  }

  size(): number {
    return this.receipts.size;
  }

  // ─── Gap 8: evaluator 反向更新 supportsCriteria ──────────────────────────

  /**
   * 由 GoalEvaluator 输出的 criteriaEvidenceMap 反向更新 receipt.supportsCriteria。
   * map: criterion → evidenceId[]
   */
  applyCriteriaMap(map: Record<string, string[]>): void {
    for (const [criterion, evidenceIds] of Object.entries(map)) {
      for (const eid of evidenceIds) {
        const r = this.receipts.get(eid);
        if (r && !r.supportsCriteria.includes(criterion)) {
          r.supportsCriteria.push(criterion);
        }
      }
    }
  }

  // ─── Gap 5: 从 ThreadStore items 重建 ledger ──────────────────────────────

  /**
   * 从 ThreadStore items 重建 ledger（服务重启或 resume 时调用）。
   * 实施点 2: 优先用 item.harnessRunId 字段过滤；若 item 没有该字段则跳过。
   *
   * @param threadId 线程 ID
   * @param store    ThreadStore 实例
   * @param harnessRunId 可选，只重建该 run 的证据
   */
  async rebuildFromThreadItems(
    threadId: ThreadId,
    store: { getItems(threadId: ThreadId): Promise<ThreadItem[]> },
    harnessRunId?: string,
  ): Promise<void> {
    this.receipts.clear();
    this.byThread.clear();
    this.byTurn.clear();

    const items = await store.getItems(threadId);
    for (const item of items) {
      const itemRunId = getItemHarnessRunId(item);
      // 实施点 2: 用 item.harnessRunId 字段直接过滤
      if (harnessRunId) {
        if (itemRunId !== harnessRunId) continue;
      }
      // harness_continuation 本身不作为证据
      if (item.type === 'harness_continuation') continue;

      this.recordItem(item, threadId, harnessRunId ?? itemRunId ?? '');
    }
  }

  // ─── 第二重建源：workflow_result（盘点 §4.4 清单第 4 项） ────────────────────

  /**
   * 从可序列化的 workflow 结果证据数组重建 `wev_` 命名空间那一部分。
   *
   * 调用顺序固定：先 `rebuildFromThreadItems()`（它清空全部索引），再本方法；
   * 本方法自身只替换 `wev_` 前缀的条目，不会误删 thread item 证据。
   * 入参是纯数据（如 storage 层 `workflow_runs` / `agent_calls` 表投影出的行），
   * 因此 runtime 侧不依赖任何存储包。
   */
  rebuildFromWorkflowResults(inputs: readonly WorkflowResultEvidenceInput[]): void {
    for (const receipt of [...this.receipts.values()]) {
      if (isWorkflowEvidenceId(receipt.id)) this.removeReceipt(receipt.id);
    }
    for (const input of inputs) this.recordWorkflowResult(input);
  }

  // ─── 内部工具 ──────────────────────────────────────────────────────────────

  /** 从所有索引中移除一条收据。 */
  private removeReceipt(id: string): void {
    const receipt = this.receipts.get(id);
    if (!receipt) return;
    this.receipts.delete(id);
    if (receipt.threadId) this.byThread.get(receipt.threadId)?.delete(id);
    if (receipt.turnId) this.byTurn.get(receipt.turnId)?.delete(id);
  }

  /** 简单的 turnId 顺序比较：MVP 假设 turnId 是递增字符串或 UUID。 */
  private isTurnBefore(a: TurnId, b: TurnId): boolean {
    return a < b;
  }
}
