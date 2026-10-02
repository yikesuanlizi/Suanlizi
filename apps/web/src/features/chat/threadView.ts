import type { Locale } from '../../config/config.js';
import { formatSuanliziErrorMessage, type SuanliziErrorInfo } from '@suanlizi/protocol';

export interface ThreadItemLike {
  id: string;
  type: string;
  turnId?: string;
  text?: string;
  toolName?: string;
  command?: string;
  server?: string;
  tool?: string;
  status?: string;
  prompt?: string;
  receiverThreadId?: string;
  newThreadId?: string;
  agentStatus?: string;
  timestamp?: string;
  completedAt?: string | null;
  exitCode?: number | null;
  changes?: Array<{ path: string; kind: string }>;
  trigger?: string;
  compactedTurnIds?: string[];
  retainedTurnIds?: string[];
  tokensBefore?: number;
  tokensAfter?: number;
  error?: { message: string; code?: string };
  info?: SuanliziErrorInfo;
  message?: string;
  query?: string;
  intent?: string;
  channels?: Array<{ name: string; hitCount: number }>;
  selectedEvidence?: Array<{ id: string }>;
}

export interface TurnLike {
  turnId: string;
  userInput: unknown;
  startedAt?: string;
  status?: string;
  completedAt?: string | null;
}

export type TranscriptGroup =
  | { kind: 'user'; item: ThreadItemLike }
  | {
      kind: 'assistant';
      id: string;
      turnId?: string;
      items: ThreadItemLike[];
      status?: string;
      timestamp?: string;
      completedAt?: string | null;
    };

export interface EventDraft {
  key?: string;
  kind: string;
  title: string;
  detail: string;
  tone: 'neutral' | 'running' | 'success' | 'warning' | 'danger';
}

export interface EventRenderLike extends EventDraft {
  id?: number;
  timestamp?: string;
}

export function eventRenderKey(event: EventRenderLike): string {
  return event.key ?? [event.kind, event.title, event.detail, event.tone].join('\n');
}

export function mergeThreadItems<T extends ThreadItemLike>(current: T[], incoming: T[]): T[] {
  const order: string[] = [];
  const byId = new Map<string, T>();
  const semanticAliases = new Map<string, string>();

  for (const item of [...current, ...incoming]) {
    const idKey = item.id ? `id:${item.id}` : undefined;
    const semanticKey = semanticItemKey(item);
    // Prefer a stable item id when a lifecycle update changes the item type,
    // but allow an SSE error and its persisted copy to share a semantic key.
    const key = (idKey && byId.has(idKey) ? idKey : undefined)
      ?? semanticAliases.get(semanticKey)
      ?? idKey
      ?? semanticKey;
    const existing = byId.get(key);
    // Error items are terminal evidence for a turn. A late lifecycle update
    // for the same id must never downgrade or replace that evidence.
    if (existing && isErrorItem(existing) && !isErrorItem(item)) continue;
    if (!byId.has(key)) {
      order.push(key);
    }
    byId.set(key, mergeItemVersion(existing, item));
    if (idKey) byId.set(idKey, byId.get(key)!);
    semanticAliases.set(semanticKey, key);
  }

  return order.map((key) => byId.get(key)!);
}

/**
 * Terminal failures can arrive once from SSE and again from the persisted
 * snapshot with different generated ids. Collapse only identical errors from
 * the same turn; distinct failures remain visible for auditability.
 */
function semanticItemKey(item: ThreadItemLike): string {
  if (item.type !== 'error' || !item.turnId) return itemKey(item);
 const message = [item.message, item.text, item.error?.message]
   .find((value): value is string => typeof value === 'string' && value.trim().length > 0)
   ?.replace(/\s+/g, ' ')
   .trim() ?? '';
  const code = item.error && typeof item.error === 'object' && typeof (item.error as { code?: unknown }).code === 'string'
    ? (item.error as { code: string }).code.trim()
    : '';
  return message ? `error:${item.turnId}:${code}:${message}` : itemKey(item);
}

export function applyAgentMessageDelta<T extends ThreadItemLike>(
  current: T[],
  event: { itemId?: string; delta?: string; turnId?: string; threadId?: string },
): T[] {
  if (!event.itemId || typeof event.delta !== 'string' || event.delta.length === 0) return current;
  let found = false;
  const next = current.map((item) => {
    if (item.id !== event.itemId) return item;
    found = true;
    if (isErrorItem(item)) return item;
    if (item.status && item.status !== 'in_progress') return item;
    return { ...item, turnId: item.turnId ?? event.turnId, text: `${item.text ?? ''}${event.delta}` };
  });
  if (found) return next;
  return [...next, { id: event.itemId, type: 'agent_message', turnId: event.turnId, status: 'in_progress', text: event.delta, timestamp: new Date().toISOString() } as T];
}

export function removeThreadItem<T extends ThreadItemLike>(current: T[], itemId?: string): T[] {
  if (!itemId) return current;
  return current.filter((item) => item.id !== itemId || isErrorItem(item));
}

function isErrorItem(item: ThreadItemLike): boolean {
  return item.type === 'error';
}

export function withSyntheticUserMessages<T extends ThreadItemLike>(
  turns: TurnLike[],
  items: T[],
): ThreadItemLike[] {
  const turnIdsWithUserMessage = new Set(
    items.filter((item) => item.type === 'user_message').map((item) => item.turnId),
  );
  const consumed = new Set<string>();
  const ordered: ThreadItemLike[] = [];
  for (const turn of turns) {
    if (!turnIdsWithUserMessage.has(turn.turnId)) {
      ordered.push({
        id: `${turn.turnId}_user`,
        type: 'user_message',
        turnId: turn.turnId,
        text: userInputText(turn.userInput),
        timestamp: 'startedAt' in turn && typeof turn.startedAt === 'string' ? turn.startedAt : undefined,
      });
    }
    for (const item of items) {
      if (item.turnId === turn.turnId) {
        ordered.push(item);
        consumed.add(item.id);
      }
    }
  }
  ordered.push(...items.filter((item) => !consumed.has(item.id)));
  return mergeThreadItems([], ordered);
}

export function groupTranscriptItems<T extends ThreadItemLike>(
  items: T[],
  turns: TurnLike[] = [],
): TranscriptGroup[] {
  const turnStatus = new Map(turns.map((turn) => [turn.turnId, turn.status]));
  const userByTurn = new Map<string, ThreadItemLike>();
  const assistantItemsByTurn = new Map<string, ThreadItemLike[]>();
  const turnOrder: string[] = [];
  const unscoped: ThreadItemLike[] = [];
  for (const item of items) {
    if (!isTranscriptItem(item)) continue;
    const key = item.turnId;
    if (!key) { unscoped.push(item); continue; }
    if (!turnOrder.includes(key)) turnOrder.push(key);
    if (item.type === 'user_message') userByTurn.set(key, item);
    else {
      const existing = assistantItemsByTurn.get(key) ?? [];
      existing.push(item);
      assistantItemsByTurn.set(key, existing);
    }
  }
  const orderedTurnIds = [
    ...turns.map((turn) => turn.turnId).filter((turnId) => turnOrder.includes(turnId)),
    ...turnOrder.filter((turnId) => !turns.some((turn) => turn.turnId === turnId)),
  ];
  const groups: TranscriptGroup[] = [];
  for (const turnId of orderedTurnIds) {
    const user = userByTurn.get(turnId);
    if (user) groups.push({ kind: 'user', item: user });
    const assistantItems = assistantItemsByTurn.get(turnId);
    if (!assistantItems?.length) continue;
    const orderedItems = orderItemsByTimestamp(assistantItems);
    const group: Extract<TranscriptGroup, { kind: 'assistant' }> = {
      kind: 'assistant', id: `assistant:${turnId}`, turnId, items: orderedItems,
      status: turnStatus.get(turnId), timestamp: orderedItems.find((item) => item.timestamp)?.timestamp,
      completedAt: turns.find((turn) => turn.turnId === turnId)?.completedAt ?? null,
    };
    if (orderedItems.some((item) => item.status === 'in_progress')) group.status = 'running';
    groups.push(group);
  }
  for (const item of unscoped) groups.push({ kind: 'assistant', id: `assistant:item:${item.id}`, items: [item], status: item.status, timestamp: item.timestamp });
  return groups;
}

function mergeItemVersion<T extends ThreadItemLike>(existing: T | undefined, incoming: T): T {
  if (!existing) return incoming;
  // Event/snapshot payloads are partial in practice. Do not let an omitted
  // field (or a stale non-terminal status) erase the live item currently on
  // screen while a turn is streaming or being persisted.
  const merged = { ...existing } as T;
  for (const [key, value] of Object.entries(incoming)) {
    if (value !== undefined) {
      (merged as Record<string, unknown>)[key] = value;
    }
  }
  // `timestamp` is the stable creation time. Completion belongs in
  // `completedAt`; accepting a later lifecycle timestamp here makes a tool
  // jump past the final answer when its terminal event arrives.
  if (existing.timestamp) merged.timestamp = existing.timestamp;
  if (existing.turnId) merged.turnId = existing.turnId;
  if (isTerminalStatus(existing.status) && !isTerminalStatus(incoming.status)) {
    merged.status = existing.status;
  }
  if (existing.type === 'agent_message' && incoming.type === 'agent_message' && (existing.text ?? '').length > (incoming.text ?? '').length) {
    merged.text = existing.text;
  }
  if (existing.completedAt && !incoming.completedAt) merged.completedAt = existing.completedAt;
  return merged;
}

function isTerminalStatus(status: string | undefined): boolean {
  return status === 'completed'
    || status === 'failed'
    || status === 'cancelled'
    || status === 'canceled'
    || status === 'interrupted'
    || status === 'timed_out'
    || status === 'timeout'
    || status === 'rejected';
}

function orderItemsByTimestamp<T extends ThreadItemLike>(items: T[]): T[] {
  return items
    .map((item, index) => ({
      item,
      index,
      timestamp: item.timestamp ? Date.parse(item.timestamp) : Number.NaN,
      ordinal: itemOrdinal(item.id),
    }))
    .sort((a, b) => {
      // Runtime item ids encode the model/tool emission ordinal. Prefer it
      // whenever available so late lifecycle updates cannot move a tool after
      // the final assistant output merely because their timestamps changed.
      if (Number.isFinite(a.ordinal) && Number.isFinite(b.ordinal) && a.ordinal !== b.ordinal) return a.ordinal - b.ordinal;
      if (Number.isFinite(a.timestamp) && Number.isFinite(b.timestamp) && a.timestamp !== b.timestamp) return a.timestamp - b.timestamp;
      if (Number.isFinite(a.timestamp) !== Number.isFinite(b.timestamp)) return Number.isFinite(a.timestamp) ? -1 : 1;
      if (Number.isFinite(a.ordinal) && Number.isFinite(b.ordinal) && a.ordinal !== b.ordinal) return a.ordinal - b.ordinal;
      return a.index - b.index;
    })
    .map(({ item }) => item);
}

function itemOrdinal(id: string): number {
  const match = /_item_(\d+)$/.exec(id);
  return match ? Number(match[1]) : Number.NaN;
}

function isTranscriptItem(item: ThreadItemLike): boolean {
  return item.type !== 'workflow_checkpoint'
    && item.type !== 'project_checkpoint'
    && item.type !== 'context_compaction'
    && item.type !== 'harness_continuation';
}

export function describeEvent(event: Record<string, unknown>, locale: Locale): EventDraft | null {
  const type = String(event.type ?? '');
  const zh = locale === 'zh';

  if (type === 'turn.started') {
    const index = Number(event.turnIndex ?? 0) + 1;
    return {
      key: 'turn:lifecycle',
      kind: type,
      title: zh ? `第 ${index} 轮开始` : `Turn ${index} started`,
      detail: zh ? 'Agent 已接收消息，正在组织上下文。' : 'The agent accepted the message and is preparing context.',
      tone: 'running',
    };
  }

  if (type === 'turn.completed') {
    if (event.status === 'interrupted') {
      return {
        key: 'turn:lifecycle',
        kind: type,
        title: zh ? '已停止' : 'Interrupted',
        detail: zh ? '当前回复已停止。' : 'The current turn was stopped.',
        tone: 'warning',
      };
    }
    const usage = event.usage as Record<string, unknown> | null | undefined;
    const tokenText = usage && typeof usage === 'object'
      ? tokenUsageText(usage, locale)
      : (zh ? '本轮已完成。' : 'Turn completed.');
    return {
      key: 'turn:lifecycle',
      kind: type,
      title: zh ? '回复完成' : 'Turn completed',
      detail: tokenText,
      tone: 'success',
    };
  }

  if (type === 'thread.token_usage.updated') {
    const usage = event.usage as { total?: Record<string, unknown> } | undefined;
    return {
      key: type,
      kind: type,
      title: zh ? 'Token 已更新' : 'Token usage updated',
      detail: usage?.total ? tokenUsageText(usage.total, locale) : (zh ? '累计 token 已更新。' : 'Usage totals updated.'),
      tone: 'neutral',
    };
  }

  if (type === 'turn.diff.updated') {
    return {
      key: type,
      kind: type,
      title: zh ? '文件差异已更新' : 'Diff updated',
      detail: zh ? '本轮文件变更已更新。' : 'The current turn diff was updated.',
      tone: 'neutral',
    };
  }

  if (type === 'approval.resolved') {
    const approved = event.approved === true;
    return {
      key: `${type}:${String(event.requestId ?? '')}`,
      kind: type,
      title: approved ? (zh ? '审批已通过' : 'Approval accepted') : (zh ? '审批已拒绝' : 'Approval denied'),
      detail: String(event.reason ?? ''),
      tone: approved ? 'success' : 'warning',
    };
  }

  if (type === 'model.retry') {
    const attempt = Number(event.attempt ?? 0);
    const maxAttempts = Number(event.maxAttempts ?? 0);
    const rawRetryError = event.status ? `HTTP ${String(event.status)}` : String(event.error ?? '');
    const status = event.status ? rawRetryError : formatSuanliziErrorMessage(undefined, rawRetryError, locale);
    return {
      key: `${type}:${String(event.turnId ?? '')}:${attempt}`,
      kind: type,
      title: zh ? '模型重试' : 'Model retry',
      detail: zh
        ? `第 ${attempt}/${maxAttempts} 次请求失败，稍后重试。${status}`
        : `Attempt ${attempt}/${maxAttempts} failed; retrying shortly. ${status}`,
      tone: 'warning',
    };
  }

  if (type === 'context.token_estimate.updated') {
    const estimate = event.estimate as { inputTokens?: number; messageCount?: number } | undefined;
    const tokens = Number(estimate?.inputTokens ?? 0);
    const messages = Number(estimate?.messageCount ?? 0);
    return {
      key: `${type}:${String(event.turnId ?? '')}`,
      kind: type,
      title: zh ? '上下文估算' : 'Context estimate',
      detail: zh ? `约 ${tokens} token，${messages} 条消息。` : `About ${tokens} tokens across ${messages} messages.`,
      tone: 'neutral',
    };
  }

  if (type === 'turn.failed') {
    const error = event.error as { message?: string } | undefined;
    const info = event.error && typeof event.error === 'object' ? (event.error as { info?: SuanliziErrorInfo }).info : undefined;
    const detail = formatSuanliziErrorMessage(info, error?.message, locale);
    return {
      key: type,
      kind: type,
      title: zh ? '回复失败' : 'Turn failed',
      detail,
      tone: 'danger',
    };
  }

  if (type === 'model.output.rejected') {
    const message = typeof event.message === 'string'
      ? event.message
      : (event.error as { message?: string } | undefined)?.message;
    const info = event.error && typeof event.error === 'object' ? (event.error as { info?: SuanliziErrorInfo }).info : undefined;
    return {
      key: type + ':' + String(event.turnId ?? ''),
      kind: type,
      title: zh ? '模型输出格式错误' : 'Model output format error',
      detail: formatSuanliziErrorMessage(info, message ?? 'model.output.rejected', locale),
      tone: 'warning',
    };
  }

  if (type === 'stream.error') {
    const message = typeof event.message === 'string'
      ? event.message
      : (event.error as { message?: string } | undefined)?.message;
    const recoverable = event.recoverable === true;
    const info = event.error && typeof event.error === 'object' ? (event.error as { info?: SuanliziErrorInfo }).info : undefined;
    return {
      key: type + ':' + String(event.turnId ?? ''),
      kind: type,
      title: recoverable ? (zh ? '模型流中断' : 'Model stream interrupted') : (zh ? '模型流失败' : 'Model stream failed'),
      detail: formatSuanliziErrorMessage(info, message, locale),
      tone: recoverable ? 'warning' : 'danger',
    };
  }

  if (type === 'approval.required') {
    return {
      key: `${type}:${String(event.requestId ?? '')}`,
      kind: type,
      title: zh ? '等待批准' : 'Approval required',
      detail: String(event.description ?? (zh ? '需要确认后才能继续。' : 'Confirmation is required before continuing.')),
      tone: 'warning',
    };
  }

  if ((type === 'item.started' || type === 'item.updated' || type === 'item.completed') && isThreadItem(event.item)) {
    if (event.item.type === 'agent_message' && type !== 'item.completed') return null;
    if (event.item.type === 'user_message') return null;
    return describeItemEvent(type, event.item, locale);
  }

  if (type === 'thread.compacted') {
    return {
      key: type,
      kind: type,
      title: zh ? '上下文已压缩' : 'Context compacted',
      detail: zh ? '旧对话已汇总进压缩上下文。' : 'Older turns were summarized into compacted context.',
      tone: 'success',
    };
  }

  if (type === 'thread.resumed') {
    return {
      key: type,
      kind: type,
      title: zh ? '继续运行' : 'Resumed',
      detail: zh ? '已从检查点恢复当前对话。' : 'The thread resumed from checkpoint.',
      tone: 'running',
    };
  }

  return null;
}

export function itemHeading(item: ThreadItemLike, locale: Locale): { title: string; detail: string } {
  const zh = locale === 'zh';
  switch (item.type) {
    case 'agent_message':
      return {
        title: zh ? 'Agent 回复' : 'Agent reply',
        detail: zh ? '模型生成的最终回复。' : 'Final response from the model.',
      };
    case 'user_message':
      return {
        title: zh ? '你' : 'You',
        detail: item.text ?? '',
      };
    case 'reasoning':
      return {
        title: zh ? '推理摘要' : 'Reasoning',
        detail: item.text ?? '',
      };
    case 'command_execution':
      return {
        title: zh ? '命令执行' : 'Command',
        detail: item.command ?? '',
      };
    case 'tool_call':
      return {
        title: zh ? '工具调用' : 'Tool call',
        detail: item.toolName ?? '',
      };
    case 'collab_tool_call':
      return {
        title: zh ? '协作工具' : 'Collaboration',
        detail: [item.tool, item.agentStatus].filter(Boolean).join(' · '),
      };
    case 'mcp_tool_call':
      return {
        title: zh ? 'MCP 工具' : 'MCP tool',
        detail: [item.server, item.tool].filter(Boolean).join(' / '),
      };
    case 'file_change':
      return {
        title: zh ? '文件变更' : 'File changes',
        detail: item.changes?.map((change) => `${change.kind} ${change.path}`).join(', ') ?? '',
      };
    case 'context_compaction':
      return {
        title: zh ? '上下文压缩' : 'Context compaction',
        detail: zh
          ? `${item.trigger === 'auto' ? '自动' : '手动'} · ${item.compactedTurnIds?.length ?? 0} 轮`
          : `${item.trigger === 'auto' ? 'Auto' : 'Manual'} · ${item.compactedTurnIds?.length ?? 0} turns`,
      };
    case 'web_search':
      return {
        title: zh ? '网页搜索' : 'Web search',
        detail: item.text ?? '',
      };
    case 'rollback_conflict':
      return {
        title: zh ? '回滚冲突' : 'Rollback conflict',
        detail: item.message ?? '',
      };
    case 'error':
      return {
        title: zh ? '错误' : 'Error',
        detail: formatSuanliziErrorMessage(item.info, item.message ?? item.error?.message, locale),
      };
    default:
      return {
        title: item.type,
        detail: '',
      };
  }
}

function userInputText(input: unknown): string {
  if (input && typeof input === 'object' && 'type' in input) {
    const typed = input as { type?: string; text?: string; parts?: unknown[] };
    if (typed.type === 'text') return typed.text ?? '';
    if (typed.type === 'multimodal') {
      return (typed.parts ?? [])
        .map((part) => {
          if (part && typeof part === 'object' && 'type' in part) {
            const inputPart = part as { type?: string; text?: string; path?: string };
            if (inputPart.type === 'text') return inputPart.text ?? '';
            if (inputPart.type === 'image_url') return '[image]';
            if (inputPart.type === 'image_path') return `[image: ${inputPart.path ?? ''}]`;
          }
          return '';
        })
        .filter(Boolean)
        .join('\n');
    }
  }
  return '';
}

function describeItemEvent(type: string, item: ThreadItemLike, locale: Locale): EventDraft {
  const zh = locale === 'zh';
  const heading = itemHeading(item, locale);
  const completed = type === 'item.completed';
  const running = type === 'item.started' || type === 'item.updated';
  const hasError = item.type === 'error' || Boolean(item.error) || item.status === 'failed';
  const suffix = completed
    ? (zh ? '完成' : 'completed')
    : (zh ? '进行中' : 'running');

    return {
      key: eventKey(item),
      kind: type,
    title: `${heading.title}${zh ? '：' : ': '}${suffix}`,
    detail: itemDetail(item, locale) || heading.detail || (running ? (zh ? '正在处理。' : 'In progress.') : ''),
    tone: hasError ? 'danger' : completed ? 'success' : 'running',
  };
}

export function eventKey(item: ThreadItemLike): string {
  return `item:${item.id}`;
}

function itemDetail(item: ThreadItemLike, locale: Locale): string {
  const zh = locale === 'zh';
  if (item.type === 'error') return formatSuanliziErrorMessage(item.info, item.message ?? item.error?.message, locale);
  if (item.error?.message) return formatSuanliziErrorMessage(item.info, item.error.message, locale);
  if (item.type === 'agent_message') {
    return zh ? '已收到模型回复。' : 'Received model reply.';
  }
  if (item.type === 'command_execution') {
    const status = item.status ? ` · ${item.status}` : '';
    const exit = item.exitCode === null || item.exitCode === undefined ? '' : ` · exit ${item.exitCode}`;
    return `${item.command ?? ''}${status}${exit}`.trim();
  }
  if (item.type === 'tool_call') {
    return [item.toolName, item.status].filter(Boolean).join(' · ');
  }
  if (item.type === 'collab_tool_call') {
    return [item.tool, item.receiverThreadId ?? item.newThreadId, item.agentStatus ?? item.status].filter(Boolean).join(' · ');
  }
  if (item.type === 'mcp_tool_call') {
    return [[item.server, item.tool].filter(Boolean).join(' / '), item.status].filter(Boolean).join(' · ');
  }
  if (item.type === 'file_change') {
    return item.changes?.map((change) => `${change.kind} ${change.path}`).join(', ') ?? '';
  }
  if (item.type === 'context_compaction') {
    const before = Number(item.tokensBefore ?? 0);
    const after = Number(item.tokensAfter ?? 0);
    return zh ? `压缩 ${item.compactedTurnIds?.length ?? 0} 轮 · ${before} -> ${after} tokens` : `Compacted ${item.compactedTurnIds?.length ?? 0} turns · ${before} -> ${after} tokens`;
  }
  return item.message ?? item.text ?? '';
}

function tokenUsageText(usage: Record<string, unknown>, locale: Locale): string {
  const zh = locale === 'zh';
  const input = Number(usage.inputTokens ?? usage.input_tokens ?? 0);
  const cached = Number(usage.cachedInputTokens ?? usage.cached_input_tokens ?? 0);
  const output = Number(usage.outputTokens ?? usage.output_tokens ?? 0);
  const cacheReported = usage.cacheReported === true || usage.cache_reported === true;
  if (!input && !cached && !output) return zh ? '本轮已完成。' : 'Turn completed.';
  return zh
    ? `Token：输入 ${input}，缓存命中 ${cacheReported ? cached : 0}，输出 ${output}。`
    : `Tokens: input ${input}, cached ${cacheReported ? cached : 0}, output ${output}.`;
}

function isThreadItem(value: unknown): value is ThreadItemLike {
  return Boolean(value && typeof value === 'object' && 'type' in value && 'id' in value);
}

export function itemKey(item: ThreadItemLike): string {
  if (item.id) {
    return `item:${item.id}`;
  }
  const discriminator = item.text ?? item.toolName ?? item.command ?? item.message ?? '';
  const timestamp = item.timestamp ?? Math.random().toString(36).slice(2);
  return `synthetic:${item.turnId ?? ''}:${item.type}:${discriminator}:${timestamp}`;
}
