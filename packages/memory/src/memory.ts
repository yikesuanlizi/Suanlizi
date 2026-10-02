import type {
  CompactedRange,
  CompactionStrategy,
  CompactionSummary,
  ContextCompactionItem,
  ThreadId,
  ThreadItem,
  TurnMeta,
  ThreadMeta,
} from '@suanlizi/protocol';
import type { ThreadStore } from '@suanlizi/storage';
import type { ModelGateway } from '@suanlizi/model-gateway';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

// ─── Compaction ─────────────────────────────────────────────────────────────
// 压缩功能相关常量：本地摘要摘录字符数与 Codex Memento 风格压缩提示词
const LOCAL_COMPACTION_EXCERPT_CHARS = 40;
// CODEX_MEMENTO_COMPACTION_PROMPT — Codex Memento 风格的上下文检查点压缩提示词：
//   你正在执行 Codex Memento 风格的上下文检查点压缩。
//   为另一个将要恢复 Suanlizi 任务的 LLM 创建一份简明、结构化的交接摘要。
//   严格使用三个带中文标签和冒号的顶级分区：当前进度、关键上下文、待办事项。
//   当前进度：覆盖目标、已完成工作和关键决策。
//   关键上下文：覆盖重要约束、用户偏好、文件/产物、工具结果和子代理结论。
//   待办事项：覆盖剩余工作、具体的下一步、风险和阻塞点。
//   优先使用具体细节而非笼统描述，以便下一个 LLM 无需重阅完整的压缩历史即可继续。
const CODEX_MEMENTO_COMPACTION_PROMPT = [
  'You are performing a Codex Memento style context checkpoint compaction.',
  'Create a concise, structured handoff summary for another LLM that will resume the Suanlizi task.',
  '',
  'Use exactly these three top-level sections with Chinese labels and colons:',
  '当前进度：',
  '关键上下文：',
  '待办事项：',
  '',
  '当前进度 should cover the goal, completed work, and key decisions.',
  '关键上下文 should cover important constraints, user preferences, files/artifacts, tool results, and sub-agent conclusions.',
  '待办事项 should cover remaining work, concrete next steps, risks, and blockers.',
  'Prefer concrete details over generic prose so the next LLM can continue without rereading the full compacted history.',
].join('\n');
// PRIMARY_COMPACTION_LABELS — 压缩摘要的主分区标签（中英文），用于解析生成的摘要文本
const PRIMARY_COMPACTION_LABELS = [
  '当前进度',
  'Current progress',
  '关键上下文',
  'Key context',
  '待办事项',
  'Todo',
  'Next steps',
] as const;

export interface CompactOptions {
  /** Maximum tokens before triggering compaction. */
  // 触发压缩前的最大 token 数
  maxTokens: number;
  /** Approximate tokens per character (conservative estimate). */
  // 每个字符的大致 token 数（保守估算）
  tokensPerChar: number;
  /** Minimum number of turns to keep uncompacted at the tail. */
  // 尾部保留不压缩的最小回合数
  keepRecentTurns: number;
  /** Whether the compaction was user-triggered or automatic. */
  // 压缩是用户触发还是自动触发
  trigger: 'manual' | 'auto';
  /** Active turn that owns the context_compaction item. */
  // 持有 context_compaction 条目的活动回合
  compactionTurnId?: string;
  /** Preallocated context_compaction item id for started/completed lifecycle events. */
  // 为 started/completed 生命周期事件预先分配的 context_compaction 条目 id
  compactionItemId?: string;
  /** Summary strategy: LLM summary or deterministic local trimming. */
  // 摘要策略：LLM 摘要或确定性本地裁剪
  strategy: CompactionStrategy;
  /** Ratio at which the runtime should surface pressure but avoid compaction. */
  // 运行时应提示压力但避免压缩的阈值比例
  softCompactRatio: number;
  /** Ratio at which automatic compaction is allowed to reset the cache prefix. */
  // 允许自动压缩重置缓存前缀的阈值比例
  hardCompactRatio: number;
  /** Force compaction when the runtime-visible message window, not rollout items, hit the threshold. */
  // 当运行时可见的消息窗口（而非 rollout 条目）达到阈值时强制压缩
  force?: boolean;
  /** Runtime-visible token estimate used for audit when force is true. */
  // force 为 true 时用于审计的运行时可见 token 估算值
  tokensBeforeOverride?: number;
}

const DEFAULT_COMPACT_OPTIONS: CompactOptions = {
  maxTokens: 40_000,
  tokensPerChar: 0.25,
  keepRecentTurns: 3,
  trigger: 'manual',
  strategy: 'llm',
  softCompactRatio: 0.5,
  hardCompactRatio: 0.8,
};

/**
 * Check whether a thread's items exceed the token budget.
 * Uses a rough character-count heuristic.
 */
// 检查线程条目是否超出 token 预算；使用粗略的字符计数启发式
export function shouldCompact(
  items: ThreadItem[],
  opts: Partial<CompactOptions> = {},
): boolean {
  return getCompactionPressure(items, opts).status === 'hard';
}

function estimateMemoryTextTokens(text: string): number {
  if (!text) return 0;
  let cjk = 0;
  let other = 0;
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    if ((code >= 0x3040 && code <= 0x30ff)
      || (code >= 0x3400 && code <= 0x9fff)
      || (code >= 0xf900 && code <= 0xfaff)) cjk += 1;
    else other += 1;
  }
  return Math.ceil(cjk * 1.5 + other / 4);
}

export function getCompactionPressure(
  items: ThreadItem[],
  opts: Partial<CompactOptions> = {},
): {
  estimatedTokens: number;
  maxTokens: number;
  softThreshold: number;
  hardThreshold: number;
  ratio: number;
  status: 'ok' | 'soft' | 'hard';
} {
  const resolved = { ...DEFAULT_COMPACT_OPTIONS, ...opts };
  const estimatedTokens = items.reduce((sum, item) => {
    const text = extractItemText(item);
    // Keep custom rates as a lower bound for compatibility, but use a denser
    // estimate for CJK/code-heavy content so compaction happens before the
    // provider tokenizer rejects the request.
    return sum + Math.max(text.length * resolved.tokensPerChar, estimateMemoryTextTokens(text));
  }, 0);
  const softThreshold = resolved.maxTokens * resolved.softCompactRatio;
  const hardThreshold = resolved.maxTokens * resolved.hardCompactRatio;
  return {
    estimatedTokens,
    maxTokens: resolved.maxTokens,
    softThreshold,
    hardThreshold,
    ratio: resolved.maxTokens > 0 ? estimatedTokens / resolved.maxTokens : 1,
    status: estimatedTokens >= hardThreshold ? 'hard' : estimatedTokens >= softThreshold ? 'soft' : 'ok',
  };
}

/** Extract all text from a thread item for token estimation. */
// 从线程条目中提取所有文本，用于 token 估算
function extractItemText(item: ThreadItem): string {
  switch (item.type) {
    case 'agent_message':
      return item.text;
    case 'reasoning':
      return item.text;
    case 'command_execution':
      return item.command + '\n' + item.aggregatedOutput;
    case 'tool_call':
      return JSON.stringify(item.arguments) + '\n' + JSON.stringify(item.result ?? '');
    case 'mcp_tool_call':
      return JSON.stringify(item.arguments);
    case 'file_change':
      return item.changes.map((c) => `${c.kind}: ${c.path}`).join('\n');
    case 'context_compaction':
      return item.summary?.raw ?? '';
    case 'web_search':
      return item.query;
    case 'todo_list':
      return item.items.map((t) => `[${t.completed ? 'x' : ' '}] ${t.text}`).join('\n');
    case 'error':
      return item.message;
    default:
      return '';
  }
}

function isEffectiveCompactionItem(item: ThreadItem, compactedTurnIds: Set<string>): boolean {
  return !item.turnId || !compactedTurnIds.has(item.turnId) || item.type === 'context_compaction';
}

function messageContentToText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (part && typeof part === 'object' && 'text' in part) {
          return String((part as { text: unknown }).text);
        }
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

/**
 * Compact thread history: summarize old turns and return a compacted context.
 * The model-gateway is used to generate a structured summary of the early turns.
 */
// 压缩线程历史：总结早期回合并返回压缩后的上下文；使用 model-gateway 生成早期回合的结构化摘要
export async function compactThread(
  threadId: ThreadId,
  store: ThreadStore,
  model: ModelGateway,
  opts: Partial<CompactOptions> = {},
): Promise<{
  compactedTurns: number;
  summary: string;
  tokensBefore: number;
  tokensAfter: number;
  item?: ContextCompactionItem;
}> {
  const resolved = { ...DEFAULT_COMPACT_OPTIONS, ...opts };
  const items = await store.getRecentItems(threadId, 200);
  const thread = await store.getThread(threadId);
  const previousCompactedTurnIds = new Set(parseCompactedRanges(thread?.tags?.compactedRanges)
    .flatMap((range) => range.compactedTurnIds));
  const effectiveItems = items.filter((item) => isEffectiveCompactionItem(item, previousCompactedTurnIds));

  const tokensBefore = resolved.tokensBeforeOverride ?? effectiveItems.reduce((sum, item) => {
    const text = extractItemText(item);
    return sum + Math.max(text.length * resolved.tokensPerChar, estimateMemoryTextTokens(text));
  }, 0);
  const pressure = getCompactionPressure(effectiveItems, resolved);

  if (!resolved.force && (resolved.trigger === 'auto' ? pressure.status !== 'hard' : tokensBefore <= resolved.maxTokens)) {
    return { compactedTurns: 0, summary: '', tokensBefore, tokensAfter: tokensBefore };
  }

  // Build a summary prompt — 构建摘要提示词
  const turns = await store.getTurns(threadId);
  const compactableTurns = turns
    .filter((turn) => turn.status !== 'running' && !previousCompactedTurnIds.has(turn.turnId))
    .slice(0, -resolved.keepRecentTurns);
  if (compactableTurns.length === 0) {
    return { compactedTurns: 0, summary: '', tokensBefore, tokensAfter: tokensBefore };
  }
  const compactedTurnIds = compactableTurns.map((turn) => turn.turnId);
  const retainedTurnIds = turns
    .filter((turn) => !compactedTurnIds.includes(turn.turnId))
    .map((turn) => turn.turnId);

  const allItems = await store.getItems(threadId);
  const conversationText = buildCompactionConversationText(compactableTurns, allItems, resolved);

  let degradedCompaction: { message: string; code: string } | undefined;
  const modelSummary = resolved.strategy === 'local'
    ? ''
    : await (async () => {
        try {
          return messageContentToText((await model.chat({
            messages: [
              {
                role: 'system',
                content: CODEX_MEMENTO_COMPACTION_PROMPT,
              },
              { role: 'user', content: conversationText },
            ],
            max_tokens: 1000,
          })).choices[0]?.message?.content).trim();
        } catch (error) {
          // Automatic compaction must not make the thread unusable when the
          // provider returns an HTML error page or otherwise invalid response.
          // Fall back to the deterministic local summary and record degradation.
          // — Chinese: 自动压缩不能因模型摘要失败而阻塞后续对话；降级为本地摘要并记录原因。
          degradedCompaction = {
            message: error instanceof Error ? error.message : String(error),
            code: 'COMPACTION_LLM_FALLBACK_LOCAL',
          };
          return '';
        }
      })();
  const summary = resolved.strategy === 'local' || !modelSummary
    ? buildLocalCompactionSummary(compactableTurns, allItems)
    : modelSummary;
  const structuredSummary = parseCompactionSummary(summary);
  const retainedTurnIdSet = new Set(retainedTurnIds);
  const retainedChars = allItems.reduce((sum, item) => (
    item.turnId && retainedTurnIdSet.has(item.turnId) ? sum + extractItemText(item).length : sum
  ), 0);
  const estimatedTokensAfter = Math.ceil(
    Math.max(summary.length * resolved.tokensPerChar, estimateMemoryTextTokens(summary))
    + Math.max(retainedChars * resolved.tokensPerChar, estimateMemoryTextTokens(allItems
      .filter((item) => item.turnId && retainedTurnIdSet.has(item.turnId))
      .map(extractItemText)
      .join('\n'))),
  );
  // A summary is itself a compressed representation. Cap the reported size at
  // the pre-compaction estimate so a conservative CJK estimate cannot make a
  // successful compaction look larger and immediately retrigger compaction.
  const tokensAfter = Math.max(0, Math.min(Math.ceil(tokensBefore) - 1, estimatedTokensAfter));
  const now = new Date().toISOString();
  const item: ContextCompactionItem = {
    id: resolved.compactionItemId ?? `compact_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    type: 'context_compaction',
    turnId: resolved.compactionTurnId ?? compactedTurnIds.at(-1) ?? turns.at(-1)?.turnId ?? `compact_${Date.now()}`,
    status: 'completed',
    trigger: resolved.trigger,
    compactedTurnIds,
    retainedTurnIds,
    summary: structuredSummary,
    tokensBefore: Math.ceil(tokensBefore),
    tokensAfter,
    ...(degradedCompaction ? { degraded: true, error: degradedCompaction } : {}),
    timestamp: now,
  };

  // Update metadata without dropping per-thread runConfig stored in tags.
  // 更新元数据，且不丢弃存放在 tags 中的每线程 runConfig
  const previousRanges = parseCompactedRanges(thread?.tags?.compactedRanges);
  const nextRange: CompactedRange = {
    compactedTurnIds,
    retainedTurnIds,
    compactionItemId: item.id,
    summary,
    tokensBefore: Math.ceil(tokensBefore),
    tokensAfter,
    createdAt: now,
    trigger: resolved.trigger,
    strategy: resolved.strategy,
    ...(degradedCompaction ? { strategy: 'local' satisfies CompactionStrategy } : {}),
  };
  await store.updateThreadMetadata(threadId, {
    status: 'compacted',
    tags: {
      ...(thread?.tags ?? {}),
      compactedSummary: summary,
      compactedRanges: JSON.stringify([...previousRanges, nextRange]),
    },
  });
  await store.appendItems(threadId, [item]);

  return {
    compactedTurns: compactableTurns.length,
    summary,
    tokensBefore: Math.ceil(tokensBefore),
    tokensAfter,
    item,
  };
}

function buildCompactionConversationText(
  turns: TurnMeta[],
  allItems: ThreadItem[],
  opts: CompactOptions,
): string {
  const maxChars = Math.max(4000, Math.floor((opts.maxTokens * 0.6) / opts.tokensPerChar));
  const lines: string[] = [];
  let used = 0;
  for (const turn of turns) {
    const turnItems = allItems
      .filter((item) => item.turnId === turn.turnId)
      .map((item) => `${item.type}: ${extractItemText(item)}`)
      .join('\n');
    let block = `Turn ${turn.index}: ${JSON.stringify(turn.userInput)}\n${turnItems}`;
    const remaining = maxChars - used;
    if (remaining <= 0) break;
    if (block.length > remaining) {
      block = `${block.slice(0, Math.max(0, remaining - 80))}\n[compaction input truncated]`;
    }
    lines.push(block);
    used += block.length;
    if (used >= maxChars) break;
  }
  return lines.join('\n');
}

function buildLocalCompactionSummary(turns: TurnMeta[], allItems: ThreadItem[]): string {
  const userInputs = turns
    .map(turnUserInputText)
    .filter(Boolean)
    .slice(0, 5);
  const lines = turns.slice(0, 8).map((turn) => {
    const text = allItems
      .filter((item) => item.turnId === turn.turnId)
      .map(extractItemText)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
    const excerpt = text.length > LOCAL_COMPACTION_EXCERPT_CHARS
      ? `${text.slice(0, LOCAL_COMPACTION_EXCERPT_CHARS)}...`
      : text;
    const user = turnUserInputText(turn);
    return `T${turn.index}: ${user}${excerpt ? ` -> ${excerpt}` : ''}`;
  });
  if (turns.length > 8) lines.push(`...${turns.length - 8} more`);
  return [
    '当前进度：',
    `- ${userInputs.length > 0 ? userInputs.join(' | ') : '从已压缩历史继续任务。'}`,
    `- 本地压缩 ${turns.length} 轮，保留了早期用户输入与条目摘录。`,
    '关键上下文：',
    `- ${lines.join(' | ')}`,
    '待办事项：',
    '- 继续当前请求。',
  ].join('\n');
}

function turnUserInputText(turn: TurnMeta): string {
  return turn.userInput.type === 'text' ? turn.userInput.text : '[multimodal]';
}

function parseCompactedRanges(raw: string | undefined): CompactedRange[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed as CompactedRange[] : [];
  } catch {
    return [];
  }
}

function parseCompactionSummary(raw: string): CompactionSummary {
  const normalized = raw.trim();
  const currentProgress = primarySection(normalized, ['当前进度', 'Current progress']);
  const keyContext = primarySection(normalized, ['关键上下文', 'Key context']);
  const todo = primarySection(normalized, ['待办事项', 'Todo', 'Next steps']);
  return {
    userGoal: currentProgress || normalized,
    completedWork: currentProgress,
    keyConstraints: keyContext,
    filesAndArtifacts: '',
    toolResults: '',
    subagentResults: '',
    openTasks: todo,
    risks: '',
    raw: normalized,
  };
}

function primarySection(raw: string, labels: string[]): string {
  const labelPattern = labels.map(escapeRegExp).join('|');
  const stopPattern = PRIMARY_COMPACTION_LABELS.map(escapeRegExp).join('|');
  const match = raw.match(new RegExp(`(?:^|\\n)[^\\S\\n]*(?:${labelPattern})[^\\S\\n]*[:：][^\\S\\n]*([\\s\\S]*?)(?=\\n[^\\S\\n]*(?:${stopPattern})[^\\S\\n]*[:：]|$)`, 'i'));
  return match?.[1]?.trim() ?? '';
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ─── Resume ─────────────────────────────────────────────────────────────────
export interface ResumeResult {
  thread: ThreadMeta;
  turns: TurnMeta[];
  recentItems: ThreadItem[];
}

/** Resume a thread from storage with full context. */
// 从存储中恢复线程并带上完整上下文
export async function resumeThread(
  threadId: ThreadId,
  store: ThreadStore,
): Promise<ResumeResult | null> {
  const thread = await store.getThread(threadId);
  if (!thread) return null;
  const turns = await store.getTurns(threadId);
  const recentItems = await store.getRecentItems(threadId, 200);
  return { thread, turns, recentItems };
}

// ─── Fork ───────────────────────────────────────────────────────────────────
/** Create a new thread as a copy of an existing one. */
// 创建一个新线程作为现有线程的副本（分支）
export async function forkThread(
  sourceThreadId: ThreadId,
  store: ThreadStore,
  _workspaceRoot: string,
): Promise<ThreadMeta> {
  const source = await store.getThread(sourceThreadId);
  if (!source) throw new Error(`Source thread ${sourceThreadId} not found`);

  const newId = generateId();
  const now = new Date().toISOString();
  const meta: ThreadMeta = {
    ...source,
    threadId: newId,
    title: `${source.title} (fork)`,
    turnCount: source.turnCount,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    tags: { ...source.tags, forkedFrom: sourceThreadId },
  };

  await store.createThread(meta);

  // Copy items — 复制条目
  const items = await store.getItems(sourceThreadId);
  if (items.length > 0) {
    await store.appendItems(newId, items);
  }

  // Copy turns — 复制回合
  const turns = await store.getTurns(sourceThreadId);
  for (const turn of turns) {
    await store.saveTurn({ ...turn, threadId: newId });
  }

  return meta;
}

// ─── Rollback ───────────────────────────────────────────────────────────────
/** Roll back the last N turns of a thread. Does NOT mutate JSONL — only updates metadata. */
// 回滚线程的最后 N 个回合；不修改 JSONL，仅更新元数据
export async function rollbackTurns(
  threadId: ThreadId,
  store: ThreadStore,
  count: number = 1,
): Promise<{ removedTurns: number }> {
  if (!Number.isFinite(count) || count <= 0) {
    throw new Error('rollback count must be >= 1');
  }
  const normalizedCount = Math.floor(count);
  const thread = await store.getThread(threadId);
  const turns = await store.getTurns(threadId);
  const activeCount = thread?.turnCount ?? turns.length;
  const activeTurns = turns.slice(0, activeCount);
  const toRemove = Math.min(normalizedCount, activeTurns.length);
  const newCount = activeTurns.length - toRemove;
  const itemsBeforeRollback = await store.getItems(threadId);
  const activeTurnIdsAfterRollback = new Set(activeTurns.slice(0, newCount).map((turn) => turn.turnId));
  const itemsAfterRollback = itemsBeforeRollback.filter((item) => isItemActiveAfterRollback(item, activeTurnIdsAfterRollback, newCount));
  const latestWorkflowCheckpoint = [...itemsAfterRollback].reverse().find(isWorkflowCheckpointItem);
  const tags = { ...(thread?.tags ?? {}) };
  if (latestWorkflowCheckpoint) {
    tags.workflow = JSON.stringify(latestWorkflowCheckpoint.workflow);
  } else if ('workflow' in tags && itemsBeforeRollback.some(isWorkflowCheckpointItem)) {
    delete tags.workflow;
  }
  pruneCompactionTags(tags, activeTurnIdsAfterRollback);

  await store.appendRollbackMarker?.(threadId, {
    count: normalizedCount,
    remainingTurnCount: newCount,
    createdAt: new Date().toISOString(),
  });

  await store.updateThreadMetadata(threadId, {
    turnCount: newCount,
    tags,
    updatedAt: new Date().toISOString(),
  });
  await store.deleteTurnsAfter?.(threadId, newCount);

  const conflicts = await restoreProjectCheckpoints(
    itemsBeforeRollback
      .filter(isProjectCheckpointItem)
      .filter((item) => item.turnCount > newCount)
      .reverse(),
    thread?.workspaceRoot ?? '',
  );
  if (conflicts.length > 0) {
    const conflictItem: ThreadItem = {
      id: `rollback_conflict_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      type: 'rollback_conflict',
      turnId: activeTurns[Math.max(0, newCount - 1)]?.turnId ?? `rollback_${threadId}`,
      turnCount: newCount,
      message: 'Rollback skipped file restore for paths with conflicts.',
      conflicts,
      timestamp: new Date().toISOString(),
    };
    await store.appendItems(threadId, [conflictItem]);
  }

  return { removedTurns: toRemove };
}

function pruneCompactionTags(tags: Record<string, string>, activeTurnIds: Set<string>): void {
  const ranges = parseCompactedRanges(tags.compactedRanges);
  if (ranges.length === 0) return;
  const retained = ranges.filter((range) => (
    [...range.compactedTurnIds, ...range.retainedTurnIds].every((turnId) => activeTurnIds.has(turnId))
  ));
  if (retained.length === 0) {
    delete tags.compactedSummary;
    delete tags.compactedRanges;
    return;
  }
  tags.compactedRanges = JSON.stringify(retained);
  tags.compactedSummary = retained.at(-1)?.summary ?? tags.compactedSummary;
}

function isWorkflowCheckpointItem(item: ThreadItem): item is Extract<ThreadItem, { type: 'workflow_checkpoint' }> {
  return item.type === 'workflow_checkpoint';
}

function isProjectCheckpointItem(item: ThreadItem): item is Extract<ThreadItem, { type: 'project_checkpoint' }> {
  return item.type === 'project_checkpoint';
}

function isItemActiveAfterRollback(item: ThreadItem, activeTurnIds: Set<string>, turnCount: number): boolean {
  const checkpoint = item as ThreadItem & { turnCount?: unknown };
  if (
    (item.type === 'workflow_checkpoint' || item.type === 'project_checkpoint' || item.type === 'rollback_conflict')
    && typeof checkpoint.turnCount === 'number'
  ) {
    return checkpoint.turnCount <= turnCount;
  }
  return typeof item.turnId === 'string' && activeTurnIds.has(item.turnId);
}

async function restoreProjectCheckpoints(
  checkpoints: Array<Extract<ThreadItem, { type: 'project_checkpoint' }>>,
  fallbackWorkspaceRoot: string,
): Promise<Array<{ path: string; reason: string; expectedHash?: string | null; actualHash?: string | null }>> {
  const conflicts: Array<{ path: string; reason: string; expectedHash?: string | null; actualHash?: string | null }> = [];
  for (const checkpoint of checkpoints) {
    const workspaceRoot = checkpoint.workspaceRoot || fallbackWorkspaceRoot;
    for (const file of [...checkpoint.files].reverse()) {
      const absolutePath = safeWorkspacePath(workspaceRoot, file.path);
      if (!absolutePath) {
        conflicts.push({ path: file.path, reason: 'path is outside workspace root' });
        continue;
      }
      const current = await readFileIfExists(absolutePath);
      const currentHash = current === null ? null : sha256(current);
      if (file.afterHash !== currentHash) {
        conflicts.push({
          path: file.path,
          reason: 'current file hash does not match checkpoint afterHash',
          expectedHash: file.afterHash,
          actualHash: currentHash,
        });
        continue;
      }
      if (file.kind === 'add') {
        await fs.rm(absolutePath, { force: true });
      } else if (file.beforeContent === null) {
        await fs.rm(absolutePath, { force: true });
      } else {
        await fs.mkdir(path.dirname(absolutePath), { recursive: true });
        await fs.writeFile(absolutePath, file.beforeContent, 'utf-8');
      }
    }
  }
  return conflicts;
}

function safeWorkspacePath(workspaceRoot: string, filePath: string): string | null {
  if (!workspaceRoot.trim()) return null;
  const root = path.resolve(workspaceRoot);
  const absolutePath = path.resolve(root, filePath);
  const relative = path.relative(root, absolutePath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return null;
  return absolutePath;
}

async function readFileIfExists(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, 'utf-8');
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? null : Promise.reject(error);
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

// ─── Helpers ────────────────────────────────────────────────────────────────
function generateId(): string {
  return `thread_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}
