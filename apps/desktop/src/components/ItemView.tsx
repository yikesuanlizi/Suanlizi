import type React from 'react';
import { formatSuanliziErrorMessage } from '@suanlizi/protocol';
import { ErrorNotice } from '../features/chat/ErrorNotice.js';
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Locale } from '../config/config.js';
import { Icon } from './Icon.js';
import { formatTimestamp } from '../shared/i18n.js';
import { itemHeading } from '../features/chat/threadView.js';
import { normalizeMarkdownForDisplay } from '../features/chat/markdownText.js';
import { buildTurnFileSummary, type TurnChangedFileSummaryEntry, type TurnFileSummaryEntry } from '../features/chat/turnFileSummary.js';
import type { ThreadItem } from '../shared/types.js';
import { childActivityForCollabItem, type SubagentDirectoryEntry } from '../features/agents/subagentActivity.js';
import { RobotMoodIcon, type RobotMoodVariant } from './RobotMoodIcon.js';
import { UserAvatar } from './UserAvatar.js';
// 英文说明: DiffView renders red/green line-level diffs for file_change items
// 中文说明: DiffView 渲染 file_change 条目的红绿行级 diff
import { DiffView, type DiffViewHunk } from './DiffView.js';

export interface AssistantTurnGroup {
  turnId?: string;
  items: ThreadItem[];
  status?: string;
  timestamp?: string;
  completedAt?: string | null;
}

// 终态只能使用已持久化的结束点；只有实时运行态才读取当前时间。
// — English: terminal durations use a persisted endpoint; Date.now is only
//   read for a live in-progress item.
export function resolveElapsedMs(startIso: string | undefined, endIso?: string | null): number | null {
  if (!startIso || !endIso) return null;
  const start = Date.parse(startIso);
  const end = Date.parse(endIso);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return end >= start ? end - start : null;
}

function useElapsedMs(startIso: string | undefined, status: string, endIso?: string | null): number | null {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    if (status !== 'in_progress' || !startIso) return undefined;
    const update = () => setNow(Date.now());
    update();
    const timer = window.setInterval(update, 1000);
    return () => window.clearInterval(timer);
  }, [startIso, status]);
  if (!startIso) return null;
  if (status === 'in_progress') {
    const start = Date.parse(startIso);
    return now === null || !Number.isFinite(start) ? null : Math.max(0, now - start);
  }
  return resolveElapsedMs(startIso, endIso);
}

/** Find a stable end point for an item without changing persisted history. */
export function terminalTimestampForItem(
  item: ThreadItem,
  items: ThreadItem[] = [],
  turnCompletedAt?: string | null,
  assistantTimestamp?: string,
): string | null {
  const start = item.timestamp ? Date.parse(item.timestamp) : Number.NaN;
  const isAfterStart = (value: string | null | undefined): value is string => {
    const parsed = value ? Date.parse(value) : Number.NaN;
    return Number.isFinite(parsed) && (!Number.isFinite(start) || parsed > start);
  };
  const completedCandidates = items
    .map((candidate) => (candidate as ThreadItem & { completedAt?: string | null }).completedAt)
    .filter(isAfterStart)
    .sort((a, b) => Date.parse(a) - Date.parse(b));
  if (completedCandidates.length > 0) return completedCandidates.at(-1) ?? null;
  const laterStart = items
    .slice(Math.max(0, items.indexOf(item) + 1))
    .map((candidate) => candidate.timestamp)
    .filter(isAfterStart)
    .sort((a, b) => Date.parse(a) - Date.parse(b))
    .at(-1);
  if (laterStart) return laterStart;
  if (isAfterStart(turnCompletedAt)) return turnCompletedAt;
  if (isAfterStart(assistantTimestamp)) return assistantTimestamp;
  return null;
}

function formatElapsed(ms: number): string {
  if (ms < 1000) return '<1s';
  // 命令/子 Agent 可能运行几十分钟甚至更久，分/小时级要可读。
  // — Chinese: long-running commands can take minutes or hours; format accordingly.
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return seconds > 0 ? `${minutes}m${seconds}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  return restMinutes > 0 ? `${hours}h${restMinutes}m` : `${hours}h`;
}

function isTimedItem(item: ThreadItem): boolean {
  return item.type === 'tool_call'
    || item.type === 'collab_tool_call'
    || item.type === 'mcp_tool_call'
    || item.type === 'command_execution'
    || item.type === 'context_compaction'
    || item.type === 'file_change';
}

export function ItemView({
  item,
  locale,
  canRollback,
  onBranch,
  onCopy,
  onRollback,
  onPreviewFile,
  onOpenFile,
  userAvatarId,
  customUserAvatarDataUrl,
  childActivityByThread = {},
  directory = {},
  onOpenAgent,
  onPreviewCommand,
}: {
  item: ThreadItem;
  locale: Locale;
  canRollback?: boolean;
  onBranch?: (turnId: string) => void;
  onCopy?: (text: string) => void;
  onRollback?: (turnId: string) => void;
  /** 点击"预览"按钮时调用，参数为文件路径 */
  // — Chinese: called when "preview" button is clicked, with file path as argument
  onPreviewFile?: (path: string) => void;
  /** 点击"在编辑器中打开"按钮时调用，参数为文件路径（仅桌面端） */
  // — Chinese: called when "open in editor" is clicked, with file path (desktop only)
  onOpenFile?: (path: string) => void;
  userAvatarId?: string;
  customUserAvatarDataUrl?: string;
  childActivityByThread?: Record<string, ThreadItem[]>;
  /** threadId → 子 agent 目录条目（label/status/currentAction），供 Agent 行展示 */
  directory?: Record<string, SubagentDirectoryEntry>;
  /** 点击气泡里的 agent 名字时调用，打开右侧详情 */
  onOpenAgent?: (threadId: string) => void;
  /** 点击命令块的"终端"按钮时调用：右侧命令终端面板实时观看该命令输出 */
  onPreviewCommand?: (itemId: string) => void;
}) {
  const heading = itemHeading(item, locale);
  const timedItem = isTimedItem(item);
  // Keep this hook unconditional so a streamed row can update lifecycle
  // fields without changing the hook order of its list component.
  const elapsedMs = useElapsedMs(
    item.timestamp,
    timedItem ? item.status ?? 'completed' : 'completed',
    terminalTimestampForItem(item, [item], (item as ThreadItem & { completedAt?: string | null }).completedAt),
  );
  if (item.type === 'user_message') {
    return (
      <MessageFrame
        align="user"
        item={item}
        locale={locale}
        text={item.text ?? ''}
        action="rollback"
        onCopy={onCopy}
        onRollback={onRollback}
        showTurnAction={canRollback ?? true}
        userAvatarId={userAvatarId}
        customUserAvatarDataUrl={customUserAvatarDataUrl}
      >
        <article className="message user"><RichMessageText text={item.text ?? ''} onCopy={onCopy} /><PersistedAttachments attachments={item.attachments} /></article>
      </MessageFrame>
    );
  }
  if (item.type === 'agent_message') {
    const text = sanitizeAgentMessageTextForDisplay(item.text ?? '', locale);
    return (
      <MessageFrame
        align="agent"
        item={item}
        locale={locale}
        text={text}
        action="branch"
        onBranch={onBranch}
        onCopy={onCopy}
      >
        <article className="message agent">
          <RichMessageText showStreamingOutputIcon={item.status === 'in_progress' && Boolean(text.trim())} text={text} onCopy={onCopy} />
        </article>
      </MessageFrame>
    );
  }
  if (item.type === 'reasoning') {
    return <ReasoningDetails item={item} locale={locale} onCopy={onCopy} active={item.status === 'in_progress'} />;
  }
  if (
    item.type === 'tool_call'
    || item.type === 'mcp_tool_call'
    || item.type === 'context_compaction'
  ) {
    const toolSummary = summarizeToolItem(item, locale);
  // 完成后的折叠行只保留工具名和状态，不泄露具体命令/路径；展开详情仍可查看完整调用。
  // — English: collapsed completed rows show the tool label only; details remain expandable.
  const completedOnly = item.status !== 'in_progress';
  if (completedOnly) {
    toolSummary.value = '';
    toolSummary.meta = '';
  }
    return (
      <details className="message tool" open={item.status === 'in_progress' ? true : undefined}>
        <summary className="toolSummary">
          {toolSummary.status ? <span className={`toolSummaryStatus ${item.status ?? ''}`} title={locale === 'zh' ? '工具状态' : 'Tool status'} aria-label={locale === 'zh' ? '工具状态' : 'Tool status'}>{toolSummary.status}</span> : null}
          <span className="toolSummaryMain">
            <strong className="toolSummaryName">{toolSummary.name}</strong>
            {toolSummary.value ? <span className="toolSummaryValue">{toolSummary.value}</span> : null}
            {toolSummary.meta ? <span className="toolSummaryMeta">{toolSummary.meta}</span> : null}
          </span>
          {elapsedMs !== null ? <span className="toolElapsed" title={locale === 'zh' ? '调用时长' : 'elapsed'}>{formatElapsed(elapsedMs)}</span> : null}
        </summary>
        <ToolItemActions item={item} locale={locale} onPreviewFile={onPreviewFile} onOpenFile={onOpenFile} />
        <pre>{formatItemPayload(item)}</pre>
      </details>
    );
  }
  if (item.type === 'command_execution') {
    return (
      <CommandExecutionBlock
        elapsedMs={elapsedMs}
        item={item}
        locale={locale}
        onOpenFile={onOpenFile}
        onPreviewCommand={onPreviewCommand}
        onPreviewFile={onPreviewFile}
      />
    );
  }
  if (item.type === 'file_change') {
    // 英文说明: shared/types ThreadItem.hunks omits addedLinesContent/removedLinesContent;
    // 中文说明: shared/types 的 ThreadItem.hunks 未声明行内容字段，运行时携带，用类型断言对齐
    const hunks = (item.hunks ?? []) as DiffViewHunk[];
    return (
      <details className="message tool" open={item.status === 'in_progress' ? true : undefined}>
        <summary>
          {formatToolStatus(item.status, locale) ? <span className={`toolSummaryStatus ${item.status ?? ''}`} title={locale === 'zh' ? '工具状态' : 'Tool status'} aria-label={locale === 'zh' ? '工具状态' : 'Tool status'}>{formatToolStatus(item.status, locale)}</span> : null}
          <strong>{heading.title}</strong>
          <span>{heading.detail}</span>
        </summary>
        <ToolItemActions item={item} locale={locale} onPreviewFile={onPreviewFile} onOpenFile={onOpenFile} />
        <DiffView hunks={hunks} locale={locale} />
      </details>
    );
  }
  if (item.type === 'rollback_conflict') {
    return <RollbackConflictBlock item={item} locale={locale} />;
  }
  if (item.type === 'error') {
    const rawErrorText = item.message ?? item.text ?? item.error?.message ?? '';
    return (
      <MessageFrame
        align="agent"
        item={item}
        locale={locale}
        text={rawErrorText}
        action="branch"
        onBranch={onBranch}
        onCopy={onCopy}
      >
        <ErrorNotice
          info={item.info}
          message={rawErrorText}
          detail={item.detail}
          locale={locale}
          className="message error"
        />
      </MessageFrame>
    );
  }
  if (item.type === 'collab_tool_call') {
    return (
      <AgentTurnRow
        item={item}
        locale={locale}
        directory={directory}
        childActivity={childActivityForCollabItem(item, childActivityByThread)}
        onOpenAgent={onOpenAgent}
      />
    );
  }
  return <InternalItemDetails item={item} locale={locale} />;
}

function PersistedAttachments({ attachments }: { attachments?: Array<{ name: string; path: string; mimeType?: string; url?: string }> }) {
  if (!attachments?.length) return null;
  return <div className="persistedAttachmentStrip">{attachments.map((attachment) => attachment.url ? <img key={attachment.path} src={attachment.url} alt={attachment.name} title={attachment.name} /> : <span key={attachment.path}>{attachment.name}</span>)}</div>;
}

/** 等待回合首个可见事件时的轻量状态；收到思考、工具或回复后由主流程移除。 */
export function TurnPreparingIndicator({ locale }: { locale: Locale }) {
  return (
    <div className="turnPreparingBlock" role="status" aria-live="polite">
      <span className="turnPreparingIndicator">
        <span className="turnPreparingDots" aria-hidden="true"><i /><i /><i /></span>
        <span>{locale === 'zh' ? '正在准备回复…' : 'Preparing response…'}</span>
      </span>
    </div>
  );
}

export function AssistantTurnView({
  group,
  locale,
  canRegenerate = false,
  onBranch,
  onCopy,
  onRegenerate,
  onPreviewFile,
  onOpenFile,
  childActivityByThread = {},
  workspaceRoot = '',
  directory = {},
  onOpenAgent,
  onPreviewCommand,
}: {
  group: AssistantTurnGroup;
  locale: Locale;
  canRegenerate?: boolean;
  onBranch?: (turnId: string) => void;
  onCopy?: (text: string) => void;
  onRegenerate?: (turnId: string) => void;
  /** 点击"预览"按钮时调用，参数为文件路径 */
  // — Chinese: called when "preview" button is clicked, with file path as argument
  onPreviewFile?: (path: string) => void;
  /** 点击"在编辑器中打开"按钮时调用，参数为文件路径（仅桌面端） */
  // — Chinese: called when "open in editor" is clicked, with file path (desktop only)
  onOpenFile?: (path: string) => void;
  childActivityByThread?: Record<string, ThreadItem[]>;
  workspaceRoot?: string;
  /** threadId → 子 agent 目录条目，供气泡底部 Agent 行展示 */
  directory?: Record<string, SubagentDirectoryEntry>;
  /** 点击气泡里的 agent 名字时调用，打开右侧详情 */
  onOpenAgent?: (threadId: string) => void;
  /** 点击命令块的"终端"按钮时调用：右侧命令终端面板实时观看该命令输出 */
  onPreviewCommand?: (itemId: string) => void;
}) {
  const agentText = group.items
    .filter((item) => item.type === 'agent_message' && item.text)
    .map((item) => sanitizeAgentMessageTextForDisplay(item.text ?? '', locale))
    .join('\n\n');
  const errorText = group.items
    .filter((item) => item.type === 'error')
    .map((item) => item.message ?? item.text ?? item.error?.message ?? '')
    .filter(Boolean)
    .join('\n\n');
  const text = agentText || errorText;
  const timestamp = group.timestamp ?? group.items.find((item) => item.timestamp)?.timestamp ?? new Date().toISOString();
  const assistantTimestamp = [...group.items].reverse().find((item) => item.type === 'agent_message' && item.timestamp)?.timestamp;
  const hasRunningItem = group.items.some((item) => item.status === 'in_progress');
  const live = group.status === 'running' || hasRunningItem;
  const agentItems = group.items.filter((item) => item.type === 'agent_message' && item.text);
  const streamingAgentItemId = [...agentItems].reverse().find((item) => item.status === 'in_progress')?.id
    ?? (live ? agentItems.at(-1)?.id : undefined);
  // 只展开当前正在运行的思考/工具块；开始下一个块后，前一个自动收起。
  const activeExpandableId = live
    ? [...group.items].reverse().find((item) => {
        if (item.type === 'reasoning') {
          // The latest reasoning block stays active through its completed event;
          // otherwise the panel flashes closed before the next model/tool output.
          const status = (item as ThreadItem & { status?: string }).status;
          return !status || status === 'in_progress';
        }
        return isToolItem(item) && item.status === 'in_progress';
      })?.id
    : undefined;
  return (
    <MessageFrame
      align="agent"
      item={{
        id: `assistant-${group.turnId ?? group.items[0]?.id ?? 'turn'}`,
        type: 'agent_message',
        turnId: group.turnId,
        text,
        status: live ? 'in_progress' : group.status,
        timestamp,
      }}
      locale={locale}
      text={text}
      action="branch"
      onBranch={onBranch}
      onCopy={onCopy}
      onRegenerate={onRegenerate}
      showActionRow={Boolean(text.trim())}
      showRegenerate={canRegenerate}
    >
      <article className="message agent assistantTurnBubble">
        {group.items.map((item, index) => {
          if (item.type === 'agent_message') {
            const itemText = sanitizeAgentMessageTextForDisplay(item.text ?? '', locale);
            return itemText ? (
              <RichMessageText
                className="assistantTurnText"
                key={item.id}
                showStreamingOutputIcon={item.id === streamingAgentItemId}
                text={itemText}
                onCopy={onCopy}
              />
            ) : null;
          }
          if (item.type === 'reasoning') {
            // 回合进行中所有思考块保持展开（固定比例高度内滚动），
            // 回合结束才统一折叠；active 只决定当前流式块的高亮。
            // — Chinese: while the turn is live, every reasoning block stays open
            //   (scrolling inside a capped height); they fold together when the turn ends.
            return <ReasoningDetails item={item} key={item.id} locale={locale} onCopy={onCopy} active={item.id === activeExpandableId} keepOpen={false} endIso={terminalTimestampForItem(item, group.items, group.completedAt, assistantTimestamp)} />;
          }
          if (
            isToolItem(item)
          ) {
            // 同一回合内即使夹着思考块或子 Agent 行，工具也归并为一个批次；
            // 子 Agent 行仍按桌面端专用样式单独展示。
            // — Chinese: group every tool item in the turn, even when reasoning
            //   blocks or agent rows appear between tool calls.
            if (index !== group.items.findIndex((candidate) => isToolItem(candidate))) return null;
            const batch = collectTurnToolItems(group.items);
            return (
              <ToolBatchDetails
                childActivityByThread={childActivityByThread}
                items={batch}
                key={`tool-batch-${item.id}`}
                locale={locale}
                activeId={activeExpandableId}
                completedAt={group.completedAt}
                assistantTimestamp={assistantTimestamp}
                onPreviewFile={onPreviewFile}
                onOpenFile={onOpenFile}
                onPreviewCommand={onPreviewCommand}
              />
            );
          }
          if (item.type === 'command_execution') {
            return <CommandExecutionBlock
              elapsedMs={useElapsedMs(
                item.timestamp,
                item.status ?? 'completed',
                terminalTimestampForItem(item, group.items, group.completedAt, assistantTimestamp),
              )}
              item={item}
              key={item.id}
              locale={locale}
              onOpenFile={onOpenFile}
              onPreviewCommand={onPreviewCommand}
              onPreviewFile={onPreviewFile}
            />;
          }
          if (item.type === 'rollback_conflict') {
            return <RollbackConflictBlock item={item} locale={locale} key={item.id} />;
          }
          if (item.type === 'collab_tool_call') {
            return <AgentTurnRow
              childActivity={childActivityForCollabItem(item, childActivityByThread)}
              directory={directory}
              item={item}
              key={item.id}
              locale={locale}
              onOpenAgent={onOpenAgent}
            />;
          }
          if (item.type === 'error') {
            return (
              <ErrorNotice
                info={item.info}
                message={item.message ?? item.text ?? item.error?.message}
                detail={item.detail}
                locale={locale}
                className="assistantTurnError"
                key={item.id}
              />
            );
          }
          return <InternalItemDetails item={item} key={item.id} locale={locale} />;
        })}
        {!live ? <TurnFileSummaryBlock items={group.items as ThreadItem[]} locale={locale} onPreviewFile={onPreviewFile} workspaceRoot={workspaceRoot} /> : null}
      </article>
    </MessageFrame>
  );
}

/** 运行中只展示最新完成段落的首行，避免每个 delta 都驱动完整 Markdown 重排。 */
function latestCompletedParagraphFirstLine(text: string): string {
  const paragraphs = text.split(/\n{2,}/).map((part) => part.trim()).filter(Boolean);
  const latest = paragraphs.at(-1) ?? '';
  const line = latest.split(/\n/).map((part) => part.trim()).find(Boolean) ?? '';
  return line.replace(/[#>*`~\[\]]/g, '').trim();
}
function ReasoningDetails({
  item,
  locale,
  onCopy,
  active = false,
  endIso,
  keepOpen = false,
}: {
  item: ThreadItem;
  locale: Locale;
  onCopy?: (text: string) => void;
  active?: boolean;
  endIso?: string | null;
  /** 手动展开优先；思考段落结束后默认回到摘要行。 */
  // — Chinese: manual expansion wins; a finished reasoning segment returns to
  //   its lightweight summary line unless the user explicitly opened it.
  keepOpen?: boolean;
}) {
  const text = item.text?.trim() ?? '';
  const [userExpanded, setUserExpanded] = useState(false);
  // 思考时长（实时/冻结），跟在 THINK 小字后面。
  // — English: reasoning elapsed (live/frozen), right after the THINK label.
  const elapsedMs = useElapsedMs(
    item.timestamp,
    item.status ?? 'completed',
    (item as ThreadItem & { completedAt?: string | null }).completedAt ?? endIso,
  );
  const isCompactionProgress = item.id.startsWith('compaction-progress:');
  const isLive = active || keepOpen;
  const expanded = userExpanded;
  const liveSummary = isLive && !expanded ? latestCompletedParagraphFirstLine(text) : '';
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const userScrolledRef = useRef(false);
  const lastTextLengthRef = useRef(text.length);
  // 展开时的纯文本追加仍自动跟随；用户手动上滑后停止跟随。
  // — Chinese: auto-follow expanded plain-text streaming; user scrolling wins.
  useEffect(() => {
    const body = bodyRef.current;
    if (!body || !isLive || !expanded) return;
    if (text.length === lastTextLengthRef.current) return;
    lastTextLengthRef.current = text.length;
    if (userScrolledRef.current) return;
    body.scrollTop = body.scrollHeight;
  }, [text, isLive, expanded]);
  useEffect(() => {
    if (!isLive) userScrolledRef.current = false;
  }, [isLive]);
  const handleBodyScroll = () => {
    const body = bodyRef.current;
    if (!body) return;
    const distanceFromBottom = body.scrollHeight - body.scrollTop - body.clientHeight;
    userScrolledRef.current = distanceFromBottom > 24;
  };
  const compactionLabel = item.status === 'in_progress'
    ? (locale === 'zh' ? '上下文正在压缩' : 'Compacting context')
    : item.status === 'failed'
      ? (locale === 'zh' ? '上下文压缩失败' : 'Context compaction failed')
      : (locale === 'zh' ? '上下文压缩完成' : 'Context compaction completed');
  return (
    <details
      className="reasoningDetails"
      data-running={isLive ? 'true' : undefined}
      data-expanded={expanded ? 'true' : undefined}
      open={expanded || undefined}
      onToggle={(event) => setUserExpanded(event.currentTarget.open)}
    >
      <summary>
        {isCompactionProgress ? (
          <span className="reasoningElapsed">{compactionLabel}</span>
        ) : elapsedMs !== null ? (
          <span className="reasoningElapsed">
            {locale === 'zh' ? `思考 ${formatElapsed(elapsedMs)}` : `think ${formatElapsed(elapsedMs)}`}
          </span>
        ) : null}
        {liveSummary ? <span className="reasoningPreview">{liveSummary}</span> : null}
      </summary>
      {expanded && text ? (
        isLive
          ? <div className="reasoningDetailsBody reasoningPlainText" ref={bodyRef} onScroll={handleBodyScroll}>{text}</div>
          : <div className="reasoningDetailsBody"><RichMessageText text={text} onCopy={onCopy} /></div>
      ) : null}
    </details>
  );
}
function isToolItem(item: ThreadItem | undefined): boolean {
  return Boolean(item && (
    item.type === 'tool_call'
    || item.type === 'mcp_tool_call'
    || item.type === 'context_compaction'
    || item.type === 'file_change'
  ));
}

/** collab_tool_call 是子 Agent 委派条目，从工具批拆出，在气泡正文底部单独渲染。 */
export function isAgentItem(item: ThreadItem | undefined): boolean {
  return Boolean(item && item.type === 'collab_tool_call');
}

/**
 * 命令执行块：命令本身始终可见（摘要行不折叠），只有输出可以收起。
 * 长输出默认折叠显示前几行，展开后自动滚动跟随；失败时摘要行直接带出错误摘要。
 * — Chinese: the command line itself never folds; only its output folds.
 */
type AnsiSpan = { text: string; className?: string };

/** 解析常用 ANSI 颜色码，终端命令输出按原色渲染，其他控制序列剔除。 */
function parseAnsiText(text: string): AnsiSpan[] {
  const spans: AnsiSpan[] = [];
  const pattern = /\u001b\[([0-9;]*)m/g;
  let cursor = 0;
  let className = '';
  let match: RegExpExecArray | null;
  const append = (chunk: string): void => {
    if (!chunk) return;
    spans.push(className ? { text: chunk, className } : { text: chunk });
  };
  while ((match = pattern.exec(text)) !== null) {
    append(text.slice(cursor, match.index));
    cursor = match.index + match[0].length;
    const codes = match[1].split(';').filter(Boolean).map(Number);
    if (codes.length === 0 || codes.some((code) => code === 0)) {
      className = '';
      continue;
    }
    const colorNames: Record<number, string> = { 30: 'black', 31: 'red', 32: 'green', 33: 'yellow', 34: 'blue', 35: 'magenta', 36: 'cyan', 37: 'white' };
    const nextClasses: string[] = [];
    for (const code of codes) {
      if (code === 1 || code === 2 || code === 3) nextClasses.push('bold');
      else if (code === 4) nextClasses.push('underline');
      else if (code >= 90 && code <= 97) nextClasses.push(`fg-${colorNames[code - 60] ?? 'white'}`);
      else if (code >= 30 && code <= 37) nextClasses.push(`fg-${colorNames[code] ?? ''}`);
    }
    className = nextClasses.filter(Boolean).join(' ');
  }
  append(text.slice(cursor));
  return spans.filter((span) => span.text.length > 0).slice(0, 2400);
}

function AnsiOutput({ className, output, preRef, onScroll }: {
  className?: string;
  output: string;
  preRef?: React.RefObject<HTMLPreElement | null>;
  onScroll?: () => void;
}) {
  const spans = useMemo(() => parseAnsiText(output), [output]);
  return (
    <pre className={className} ref={preRef} onScroll={onScroll}>
      {spans.length > 0
        ? spans.map((span, index) => span.className
          ? <span className={span.className} key={index}>{span.text}</span>
          : <span key={index}>{span.text}</span>)
        : output}
    </pre>
  );
}

function ToolRunningMark({ label }: { label: string }) {
  return (
    <span className="toolSummaryStatus in_progress" title={label} aria-label={label}>
      <span aria-hidden="true" className="statusSpinner" />
    </span>
  );
}

function CommandExecutionBlock({
  item,
  locale,
  elapsedMs,
  onPreviewFile,
  onOpenFile,
  onPreviewCommand,
}: {
  item: ThreadItem;
  locale: Locale;
  elapsedMs: number | null;
  onPreviewFile?: (path: string) => void;
  onOpenFile?: (path: string) => void;
  /** 点击"终端预览"时调用：把命令输出投到右侧命令终端面板实时观看。 */
  // — Chinese: open the command's live output in the right command-terminal pane.
  onPreviewCommand?: (itemId: string) => void;
}) {
  const zh = locale === 'zh';
  const failureSummary = toolFailureSummary(item, locale);
  const command = String(item.command ?? '').trim();
  // 流式预览优先：进行中的命令用 liveOutput（实时增量），完成后用最终 aggregatedOutput。
  // — Chinese: prefer the live streaming buffer while running; the final
  //   aggregated output is authoritative once completed.
  const output = String((item as ThreadItem & { liveOutput?: string }).liveOutput ?? item.aggregatedOutput ?? '').replace(/\s+$/, '');
  const outputLines = output ? output.split(/\r?\n/) : [];
  const COLLAPSED_LINE_COUNT = 8;
  const statusLabel = formatToolStatus(item.status, locale);
  const outputRef = useRef<HTMLPreElement | null>(null);
  const userScrolledRef = useRef(false);
  // 终端式跟随：输出增量时自动滚到底；用户上滑后停止跟随，滚回底部恢复。
  // — Chinese: auto-follow the tail like a terminal; user scroll-up pauses following.
  useEffect(() => {
    const pre = outputRef.current;
    if (!pre) return;
    if (userScrolledRef.current) return;
    pre.scrollTop = pre.scrollHeight;
  }, [output]);
  const handleOutputScroll = () => {
    const pre = outputRef.current;
    if (!pre) return;
    const distanceFromBottom = pre.scrollHeight - pre.scrollTop - pre.clientHeight;
    userScrolledRef.current = distanceFromBottom > 24;
  };
  return (
    <div className={`commandExecBlock${item.status === 'failed' ? ' failed' : ''}`} data-status={item.status ?? undefined}>
      <div className="commandExecHead">
        {item.status === 'in_progress'
          ? <ToolRunningMark label={zh ? '运行中' : 'Running'} />
          : statusLabel ? <span aria-hidden="true" className={`toolSummaryStatus ${item.status ?? ''}`}>{statusLabel}</span> : null}
        <code className="commandExecCmd" title={command}>{command || (zh ? '(空命令)' : '(empty command)')}</code>
        {elapsedMs !== null ? (
          <span className="toolElapsed">
            {item.status === 'in_progress'
              ? (zh ? `已用时 ${formatElapsed(elapsedMs)}` : `${formatElapsed(elapsedMs)} elapsed`)
              : (zh ? `用时 ${formatElapsed(elapsedMs)}` : formatElapsed(elapsedMs))}
          </span>
        ) : null}
        {onPreviewCommand && output ? (
          <button
            type="button"
            className="commandExecPreviewBtn"
            title={zh ? '在右侧终端面板查看' : 'View in the right terminal pane'}
            aria-label={zh ? '在右侧终端面板查看' : 'View in the right terminal pane'}
            onClick={() => onPreviewCommand(item.id)}
          >
            <Icon name="terminal" />
            <span>{zh ? '终端' : 'Terminal'}</span>
          </button>
        ) : null}
      </div>
      {failureSummary ? <div className="toolSummaryError" title={failureSummary}>{failureSummary}</div> : null}
      {outputLines.length > 0 ? (
        outputLines.length > COLLAPSED_LINE_COUNT ? (
          <details className="commandExecOutput" open={item.status === 'in_progress' ? true : undefined}>
            <summary>
              <span>{zh ? `输出 ${outputLines.length} 行` : `${outputLines.length} lines`}</span>
              <span className="commandExecOutputPeek" aria-hidden="true">{outputLines.slice(0, COLLAPSED_LINE_COUNT).join(' ⏎ ')} …</span>
            </summary>
            <AnsiOutput output={output} preRef={outputRef} onScroll={handleOutputScroll} />
          </details>
        ) : (
          <AnsiOutput className="commandExecOutputShort" output={output} preRef={outputRef} onScroll={handleOutputScroll} />
        )
      ) : item.status === 'in_progress' ? (
        <div className="commandExecPending">{zh ? '等待输出…' : 'Waiting for output…'}</div>
      ) : null}
      {item.exitCode != null && item.exitCode !== 0 ? (
        <div className="commandExecExit">{zh ? `退出码 ${item.exitCode}` : `exit code ${item.exitCode}`}</div>
      ) : null}
      <ToolItemActions item={item} locale={locale} onPreviewFile={onPreviewFile} onOpenFile={onOpenFile} />
    </div>
  );
}

function ToolBatchDetails({
  childActivityByThread,
  items,
  locale,
  activeId,
  completedAt,
  assistantTimestamp,
  onPreviewFile,
  onOpenFile,
  onPreviewCommand,
}: {
  childActivityByThread: Record<string, ThreadItem[]>;
  items: ThreadItem[];
  locale: Locale;
  activeId?: string;
  completedAt?: string | null;
  assistantTimestamp?: string;
  onPreviewFile?: (path: string) => void;
  onOpenFile?: (path: string) => void;
  onPreviewCommand?: (itemId: string) => void;
}) {
  // 批统计：工具数量 + 批总时长（首工具开始 → 末工具完成/实时）。
  // 思考时长显示在 THINK 折叠旁（ReasoningDetails），不混入工具批。
  // — English: batch stats — tool count and total batch elapsed (first tool
  //   start → last tool finish or now). Thinking time lives next to the THINK
  //   fold (ReasoningDetails), not inside the tool batch.
  const anyRunning = items.some((item) => item.status === 'in_progress');
  const batchEndIso = items[0]
    ? terminalTimestampForItem(items[0], items, completedAt, assistantTimestamp)
    : null;
  const batchElapsedMs = useElapsedMs(items[0]?.timestamp, anyRunning ? 'in_progress' : 'completed', batchEndIso);
  const zh = locale === 'zh';
  const stats = batchElapsedMs !== null
    ? (zh ? `共 ${items.length} 个 · ${formatElapsed(batchElapsedMs)}` : `${items.length} calls · ${formatElapsed(batchElapsedMs)}`)
    : (zh ? `共 ${items.length} 个` : `${items.length} calls`);
  const failedCount = items.filter((item) => item.status === 'failed').length;
  const failureStats = failedCount > 0 ? (zh ? ` · ${failedCount} 个失败` : ` · ${failedCount} failed`) : '';
  return (
    <details className="toolBatchDetails" open={Boolean(activeId && items.some((item) => item.id === activeId)) || anyRunning ? true : undefined}>
      <summary aria-label={zh ? `${items.length} 个工具调用` : `${items.length} tool calls`}>
        <span aria-hidden="true" className="toolBatchIcon"><Icon name="wrench" /></span>
        <span aria-hidden="true" className="toolBatchStats">{stats}{failureStats}</span>
        <span aria-hidden="true" className="toolBatchChevron"><Icon name="chevronRight" /></span>
      </summary>
      <div className="toolBatchItems">
        {items.map((item) => (
          <ToolDetails
            childItems={childActivityForCollabItem(item, childActivityByThread)}
            item={item}
            key={item.id}
            locale={locale}
            compact
            active={item.id === activeId}
            completedAt={completedAt}
            assistantTimestamp={assistantTimestamp}
            onPreviewFile={onPreviewFile}
            onOpenFile={onOpenFile}
            onPreviewCommand={onPreviewCommand}
          />
        ))}
      </div>
    </details>
  );
}

function InternalItemDetails({ item, locale }: { item: ThreadItem; locale: Locale }) {
  const heading = itemHeading(item, locale);
  return (
    <details className="internalItemDetails">
      <summary>
        <strong>{heading.title}</strong>
        {heading.detail ? <span>{heading.detail}</span> : null}
      </summary>
      <pre>{formatItemPayload(item)}</pre>
    </details>
  );
}

function TurnFileSummaryBlock({
  items,
  locale,
  onPreviewFile,
  workspaceRoot,
}: {
  items: ThreadItem[];
  locale: Locale;
  onPreviewFile?: (path: string) => void;
  workspaceRoot: string;
}) {
  const summary = buildTurnFileSummary(items as unknown as Array<Record<string, unknown>>, workspaceRoot);
  const rows = [
    ...summary.readFiles.map((entry) => ({ kind: 'read' as const, entry })),
    ...summary.changedFiles.map((entry) => ({ kind: 'changed' as const, entry })),
  ];
  if (rows.length === 0) return null;
  const visibleRows = rows.slice(0, 3);
  const hiddenRows = rows.slice(3);
  const zh = locale === 'zh';
  return (
    <section className="turnFileSummary" aria-label={zh ? '本轮涉及文件' : 'Files touched in this turn'}>
      <div className="turnFileSummaryHeader">
        <strong>{zh ? '涉及文件' : 'Files'}</strong>
        <span>{zh ? `阅读 ${summary.readFiles.length} · 修改 ${summary.changedFiles.length}` : `read ${summary.readFiles.length} · changed ${summary.changedFiles.length}`}</span>
      </div>
      <div className="turnFileSummaryRows">
        {visibleRows.map((row) => (
          <TurnFileSummaryRow key={`${row.kind}:${row.entry.path}`} kind={row.kind} entry={row.entry} locale={locale} onPreviewFile={onPreviewFile} />
        ))}
      </div>
      {hiddenRows.length > 0 ? (
        <details className="turnFileSummaryMore">
          <summary>{zh ? `展开其余 ${hiddenRows.length} 个文件` : `Show ${hiddenRows.length} more files`}</summary>
          <div className="turnFileSummaryRows">
            {hiddenRows.map((row) => (
              <TurnFileSummaryRow key={`${row.kind}:${row.entry.path}`} kind={row.kind} entry={row.entry} locale={locale} onPreviewFile={onPreviewFile} />
            ))}
          </div>
        </details>
      ) : null}
    </section>
  );
}

function TurnFileSummaryRow({
  entry,
  kind,
  locale,
  onPreviewFile,
}: {
  entry: TurnFileSummaryEntry | TurnChangedFileSummaryEntry;
  kind: 'read' | 'changed';
  locale: Locale;
  onPreviewFile?: (path: string) => void;
}) {
  const zh = locale === 'zh';
  const changed = kind === 'changed' ? entry as TurnChangedFileSummaryEntry : null;
  const previewLabel = `${zh ? '预览文件' : 'Preview file'} ${entry.path}`;
  return (
    <div className="turnFileSummaryRow">
      <span className={kind === 'changed' ? 'turnFileSummaryBadge changed' : 'turnFileSummaryBadge'}>
        {kind === 'changed' ? (zh ? '修改文件' : 'changed') : (zh ? '阅读文件' : 'read')}
      </span>
      {onPreviewFile ? (
        <button
          type="button"
          className="turnFileSummaryPath"
          title={entry.path}
          aria-label={previewLabel}
          onClick={() => onPreviewFile(entry.path)}
        >
          <code>{entry.path}</code>
        </button>
      ) : (
        <code className="turnFileSummaryPathText" title={entry.path}>{entry.path}</code>
      )}
      {changed ? (
        <span className="turnFileSummaryStats">
          <span className="added">+{changed.addedLines}</span>
          <span className="removed">-{changed.removedLines}</span>
        </span>
      ) : null}
    </div>
  );
}

export function sanitizeAgentMessageTextForDisplay(text: string, locale: Locale): string {
  const toolTagIndex = findPlainTextToolTagIndex(text);
  if (toolTagIndex < 0) return text;
  const prefix = text.slice(0, toolTagIndex).trimEnd();
  const note = locale === 'zh'
    ? '[已隐藏模型误输出的文本工具调用；后续版本会要求模型用结构化 tool call 重试。]'
    : '[A plain-text tool call emitted by the model was hidden; newer runs will retry with structured tool calls.]';
  return prefix ? `${prefix}\n\n${note}` : note;
}

function findPlainTextToolTagIndex(text: string): number {
  const normalized = text.replace(/｜/g, '|');
  const tagMatch = /<\|+(?:DSML\|+)?(?:tool_calls|invoke|parameter)/i.exec(normalized);
  const giteeMatch = /\[工具调用\][\s\S]{0,4000}?(?:名称|name)\s*[:：]\s*[\w./:-]+[\s\S]{0,4000}?(?:参数|arguments?|args)\s*[:：]/i.exec(text);
  const indices = [tagMatch?.index, giteeMatch?.index].filter((value): value is number => value !== undefined);
  return indices.length > 0 ? Math.min(...indices) : -1;
}

function RichMessageText({
  className,
  onCopy,
  showStreamingOutputIcon = false,
  text,
}: {
  className?: string;
  onCopy?: (text: string) => void;
  showStreamingOutputIcon?: boolean;
  text: string;
}) {
  const parts = splitFencedCode(text);
  if (parts.length === 1 && parts[0]?.kind === 'text') {
    return (
      <div className={streamingTextClassName(className ?? 'messageText', showStreamingOutputIcon)}>
        {showStreamingOutputIcon ? <StreamingOutputIcon /> : null}
        <MarkdownMessageText text={text} />
      </div>
    );
  }
  return (
    <div className={className ? `${className} richMessageText` : 'richMessageText'}>
      {parts.map((part, index) => {
        if (part.kind === 'code') {
          return (
            <CodeBlock
              code={part.code}
              key={`${part.kind}-${index}`}
              language={part.language}
              onCopy={onCopy}
            />
          );
        }
        const showIcon = showStreamingOutputIcon && index === firstTextPartIndex(parts);
        return part.text ? (
          <div className={streamingTextClassName('messageText', showIcon)} key={`${part.kind}-${index}`}>
            {showIcon ? <StreamingOutputIcon /> : null}
            <MarkdownMessageText text={part.text} />
          </div>
        ) : null;
      })}
    </div>
  );
}

function MarkdownMessageText({ text }: { text: string }) {
  return (
    <div className="markdownMessageText">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>
        {normalizeMarkdownForDisplay(text)}
      </ReactMarkdown>
    </div>
  );
}

function streamingTextClassName(baseClassName: string, showStreamingOutputIcon: boolean): string {
  return showStreamingOutputIcon ? `${baseClassName} streamingOutputLine` : baseClassName;
}

function firstTextPartIndex(parts: Array<{ kind: 'text'; text: string } | { kind: 'code'; language: string; code: string }>): number {
  return parts.findIndex((part) => part.kind === 'text' && part.text.trim());
}

function StreamingOutputIcon() {
  return (
    <span className="streamingOutputIcon" aria-hidden="true">
      <svg viewBox="-15 -30 150 170">
        <ellipse cx="48" cy="120" rx="24" ry="5" fill="#cbd5e1">
          <animate attributeName="rx" values="24; 20; 24" dur="1s" repeatCount="indefinite" />
        </ellipse>
        <g>
          <animateTransform attributeName="transform" type="translate" values="0,-2; 0,2; 0,-2" dur="1s" repeatCount="indefinite" />
          <path d="M18 62 L8 66" stroke="#0f172a" strokeWidth="5" strokeLinecap="round" fill="none" />
          <circle cx="6" cy="67" r="7" fill="#fff" stroke="#0f172a" strokeWidth="4" />
          <rect x="9" y="54" width="11" height="9" rx="2" fill="#6366f1" stroke="#0f172a" strokeWidth="2.5" />
          <rect x="16" y="36" width="50" height="56" rx="16" fill="#c7d2fe" stroke="#0f172a" strokeWidth="5" />
          <path d="M36 36 L33 17" stroke="#0f172a" strokeWidth="5" strokeLinecap="round" />
          <circle cx="32" cy="15" r="6" fill="#ef4444" stroke="#0f172a" strokeWidth="4">
            <animate attributeName="fill" values="#ef4444; #fca5a5; #ef4444" dur="0.3s" repeatCount="indefinite" />
          </circle>
          <rect x="23" y="46" width="36" height="26" rx="8" fill="#0f172a" />
          <line x1="29" y1="57" x2="37" y2="57" stroke="#818cf8" strokeWidth="3" strokeLinecap="round" />
          <line x1="45" y1="57" x2="53" y2="57" stroke="#818cf8" strokeWidth="3" strokeLinecap="round" />
          <line x1="37" y1="65" x2="45" y2="65" stroke="#818cf8" strokeWidth="3" strokeLinecap="round" />
          <g>
            <animateTransform attributeName="transform" type="translate" values="0,-4; 0,4; 0,-4" dur="0.35s" repeatCount="indefinite" />
            <path d="M66 58 L78 64" stroke="#0f172a" strokeWidth="5" strokeLinecap="round" fill="none" />
            <circle cx="80" cy="65" r="7" fill="#fff" stroke="#0f172a" strokeWidth="4" />
          </g>
        </g>
        <g>
          <line x1="82" y1="88" x2="82" y2="100" stroke="#0f172a" strokeWidth="4" strokeLinecap="round" />
          <line x1="118" y1="88" x2="118" y2="100" stroke="#0f172a" strokeWidth="4" strokeLinecap="round" />
          <circle cx="82" cy="82" r="8" fill="#64748b" stroke="#0f172a" strokeWidth="4">
            <animateTransform attributeName="transform" type="rotate" from="0 82 82" to="360 82 82" dur="0.3s" repeatCount="indefinite" />
          </circle>
          <circle cx="118" cy="82" r="8" fill="#64748b" stroke="#0f172a" strokeWidth="4">
            <animateTransform attributeName="transform" type="rotate" from="0 118 82" to="360 118 82" dur="0.3s" repeatCount="indefinite" />
          </circle>
          <line x1="76" y1="82" x2="88" y2="82" stroke="#0f172a" strokeWidth="2" opacity="0.4">
            <animateTransform attributeName="transform" type="rotate" from="0 82 82" to="360 82 82" dur="0.3s" repeatCount="indefinite" />
          </line>
          <line x1="112" y1="82" x2="124" y2="82" stroke="#0f172a" strokeWidth="2" opacity="0.4">
            <animateTransform attributeName="transform" type="rotate" from="0 118 82" to="360 118 82" dur="0.3s" repeatCount="indefinite" />
          </line>
          <rect x="82" y="74" width="36" height="3" rx="1.5" fill="#0f172a" />
          <rect x="82" y="87" width="36" height="3" rx="1.5" fill="#0f172a" />
          <g>
            <line x1="86" y1="74" x2="86" y2="90" stroke="#94a3b8" strokeWidth="2.5">
              <animate attributeName="x1" values="86; 122; 86" dur="0.3s" repeatCount="indefinite" />
              <animate attributeName="x2" values="86; 122; 86" dur="0.3s" repeatCount="indefinite" />
            </line>
            <line x1="94" y1="74" x2="94" y2="90" stroke="#94a3b8" strokeWidth="2.5">
              <animate attributeName="x1" values="94; 86; 94" dur="0.3s" repeatCount="indefinite" />
              <animate attributeName="x2" values="94; 86; 94" dur="0.3s" repeatCount="indefinite" />
            </line>
            <line x1="102" y1="74" x2="102" y2="90" stroke="#94a3b8" strokeWidth="2.5">
              <animate attributeName="x1" values="102; 94; 102" dur="0.3s" repeatCount="indefinite" />
              <animate attributeName="x2" values="102; 94; 102" dur="0.3s" repeatCount="indefinite" />
            </line>
            <line x1="110" y1="74" x2="110" y2="90" stroke="#94a3b8" strokeWidth="2.5">
              <animate attributeName="x1" values="110; 102; 110" dur="0.3s" repeatCount="indefinite" />
              <animate attributeName="x2" values="110; 102; 110" dur="0.3s" repeatCount="indefinite" />
            </line>
          </g>
        </g>
        <g>
          <rect x="84" y="65" width="11" height="9" rx="2" fill="#6366f1" stroke="#0f172a" strokeWidth="2.5">
            <animate attributeName="x" values="84; 115; 115" keyTimes="0; 0.85; 1" dur="0.6s" repeatCount="indefinite" />
            <animate attributeName="opacity" values="1; 1; 0" keyTimes="0; 0.85; 1" dur="0.6s" repeatCount="indefinite" />
          </rect>
          <rect x="84" y="65" width="11" height="9" rx="2" fill="#818cf8" stroke="#0f172a" strokeWidth="2.5">
            <animate attributeName="x" values="84; 115; 115" keyTimes="0; 0.85; 1" dur="0.6s" begin="0.3s" repeatCount="indefinite" />
            <animate attributeName="opacity" values="1; 1; 0" keyTimes="0; 0.85; 1" dur="0.6s" begin="0.3s" repeatCount="indefinite" />
          </rect>
        </g>
      </svg>
    </span>
  );
}

function CodeBlock({
  code,
  language,
  onCopy,
}: {
  code: string;
  language: string;
  onCopy?: (text: string) => void;
}) {
  return (
    <figure className="codeBlock">
      <figcaption>
        <span>{language || 'code'}</span>
        <button
          className="codeCopyButton"
          type="button"
          title="Copy code"
          aria-label="Copy code"
          onClick={() => onCopy?.(code)}
        >
          <Icon name="copy" />
        </button>
      </figcaption>
      <pre><code>{code}</code></pre>
    </figure>
  );
}

function splitFencedCode(text: string): Array<{ kind: 'text'; text: string } | { kind: 'code'; language: string; code: string }> {
  const parts: Array<{ kind: 'text'; text: string } | { kind: 'code'; language: string; code: string }> = [];
  const pattern = /```([^\n`]*)\n([\s\S]*?)```/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push({ kind: 'text', text: text.slice(lastIndex, match.index).trimEnd() });
    }
    parts.push({
      kind: 'code',
      language: match[1]?.trim() ?? '',
      code: match[2]?.replace(/\n$/, '') ?? '',
    });
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length) {
    parts.push({ kind: 'text', text: text.slice(lastIndex).trimStart() });
  }
  return parts.length > 0 ? parts : [{ kind: 'text', text }];
}

export interface ToolSummary {
  name: string;
  value: string;
  meta: string;
  status: string;
}

export function summarizeToolItem(item: ThreadItem, locale: Locale): ToolSummary {
  const args = readObject(item.arguments);
  const status = formatToolStatus(item.status, locale);
  if (item.type === 'command_execution') {
    return {
      name: 'shell_command',
      value: truncateInline(String(item.command ?? args.command ?? ''), 120),
      meta: typeof args.cwd === 'string' ? truncateInline(args.cwd, 80) : '',
      status,
    };
  }
  if (item.type === 'mcp_tool_call') {
    return {
      name: [item.server, item.tool].filter(Boolean).join(' / ') || 'mcp_tool',
      value: truncateInline(firstArgValue(args, ['query', 'pattern', 'url', 'path', 'filePath', 'command', 'name']), 120),
      meta: summarizeRemainingArgs(args, ['query', 'pattern', 'url', 'path', 'filePath', 'command', 'name']),
      status,
    };
  }
  if (item.type === 'collab_tool_call') {
    // 中文注释：协作工具的本地化名 + 远程 Agent URL 标记
    // Chinese: localized name for collab tool + remote agent URL marker
    const isRemote = item.tool === 'spawn_remote_agent';
    const nameMap: Record<string, string> = locale === 'zh'
      ? {
          spawn_agent: '生成子 Agent',
          send_input: '发送输入',
          resume_agent: '恢复子 Agent',
          wait: '等待子 Agent',
          list_agents: '列出子 Agent',
          close_agent: '关闭子 Agent',
          spawn_remote_agent: '调用远程 Agent',
        }
      : {
          spawn_agent: 'Spawn Agent',
          send_input: 'Send Input',
          resume_agent: 'Resume Agent',
          wait: 'Wait Agent',
          list_agents: 'List Agents',
          close_agent: 'Close Agent',
          spawn_remote_agent: 'Remote Agent',
        };
    const label = nameMap[item.tool as string] ?? item.tool ?? 'collab_tool';
    const valueSource = item.prompt ?? (isRemote ? item.receiverThreadId : item.newThreadId) ?? '';
    const metaSource = isRemote
      ? (item.receiverThreadId ?? '')
      : (item.agentStatus ?? item.receiverThreadId ?? item.newThreadId ?? '');
    return {
      name: label,
      value: truncateInline(String(valueSource), 120),
      meta: truncateInline(String(metaSource), 100),
      status,
    };
  }
  if (item.type === 'context_compaction') {
    const turns = item.compactedTurnIds?.length ?? 0;
    return {
      name: locale === 'zh' ? '上下文压缩' : 'context_compaction',
      value: locale === 'zh'
        ? `${item.trigger === 'auto' ? '自动' : '手动'} · ${turns} 轮`
        : `${item.trigger === 'auto' ? 'auto' : 'manual'} · ${turns} turns`,
      meta: `${Number(item.tokensBefore ?? 0)} -> ${Number(item.tokensAfter ?? 0)} tokens`,
      status,
    };
  }

  const name = item.toolName ?? 'tool';
  const valueKeys = preferredValueKeys(name);
  const metaKeys = preferredMetaKeys(name);
  const meta = name === 'search_content'
    ? firstArgValue(args, metaKeys)
    : summarizePickedArgs(args, metaKeys);
  return {
    name,
    value: truncateInline(firstArgValue(args, valueKeys), 120),
    meta: truncateInline(meta || summarizeRemainingArgs(args, valueKeys), 100),
    status,
  };
}

interface RollbackConflictEntry {
  path: string;
  reason: string;
  expectedHash?: string | null;
  actualHash?: string | null;
}

function readRollbackConflicts(item: ThreadItem): RollbackConflictEntry[] {
  // ThreadItem 接口未声明 conflicts 字段，运行时 rollback_conflict 条目会携带该字段
  // — Chinese: ThreadItem doesn't declare conflicts; rollback_conflict items carry it at runtime
  const conflicts = (item as unknown as { conflicts?: RollbackConflictEntry[] }).conflicts;
  return Array.isArray(conflicts) ? conflicts : [];
}

function RollbackConflictBlock({ item, locale }: { item: ThreadItem; locale: Locale }) {
  const heading = itemHeading(item, locale);
  const conflicts = readRollbackConflicts(item);
  const zh = locale === 'zh';
  return (
    <article className="message rollbackConflict">
      <strong>{heading.title}</strong>
      {item.message ? <p className="rollbackConflictMessage">{item.message}</p> : null}
      {conflicts.length > 0 ? (
        <ul className="rollbackConflictList">
          {conflicts.map((entry, index) => (
            <li className="rollbackConflictItem" key={`${entry.path}-${index}`}>
              <span className="rollbackConflictPath">{entry.path}</span>
              <span className="rollbackConflictReason">{entry.reason}</span>
              {entry.expectedHash || entry.actualHash ? (
                <span className="rollbackConflictHashes">
                  {entry.expectedHash ? <span>{zh ? '期望' : 'expected'}: {entry.expectedHash}</span> : null}
                  {entry.actualHash ? <span>{zh ? '实际' : 'actual'}: {entry.actualHash}</span> : null}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </article>
  );
}

function ToolDetails({
  childItems = [],
  compact = false,
  item,
  locale,
  onPreviewFile,
  onOpenFile,
  onPreviewCommand,
  completedAt,
  assistantTimestamp,
  active = false,
}: {
  childItems?: ThreadItem[];
  compact?: boolean;
  item: ThreadItem;
  locale: Locale;
  onPreviewFile?: (path: string) => void;
  onOpenFile?: (path: string) => void;
  onPreviewCommand?: (itemId: string) => void;
  completedAt?: string | null;
  assistantTimestamp?: string;
  active?: boolean;
}) {
  const heading = itemHeading(item, locale);
      const failureSummary = toolFailureSummary(item, locale);
  const elapsedMs = useElapsedMs(
    item.timestamp,
    item.status ?? 'completed',
    terminalTimestampForItem(
      item,
      [item],
      (item as ThreadItem & { completedAt?: string | null }).completedAt ?? completedAt,
      assistantTimestamp,
    ),
  );
  if (item.type === 'command_execution') {
    return <CommandExecutionBlock
      elapsedMs={elapsedMs}
      item={item}
      locale={locale}
      onOpenFile={onOpenFile}
      onPreviewCommand={onPreviewCommand}
      onPreviewFile={onPreviewFile}
    />;
  }
  if (item.type === 'file_change') {
    // 英文说明: shared/types ThreadItem.hunks omits addedLinesContent/removedLinesContent;
    // 中文说明: shared/types 的 ThreadItem.hunks 未声明行内容字段，运行时携带，用类型断言对齐
    const hunks = (item.hunks ?? []) as DiffViewHunk[];
    return (
      <details className={compact ? 'message tool inlineTool' : 'message tool'} open={active ? true : undefined}>
        <summary className="toolSummary">
          {formatToolStatus(item.status, locale) ? <span className={`toolSummaryStatus ${item.status ?? ''}`} title={locale === 'zh' ? '工具状态' : 'Tool status'} aria-label={locale === 'zh' ? '工具状态' : 'Tool status'}>{formatToolStatus(item.status, locale)}</span> : null}
          <span className="toolSummaryMain"><strong className="toolSummaryName">{heading.title}</strong><span className="toolSummaryValue">{heading.detail}</span></span>
          {failureSummary ? <span className="toolSummaryError" title={failureSummary}>{failureSummary}</span> : null}
          {elapsedMs !== null ? <span className="toolElapsed" title={locale === 'zh' ? '调用时长' : 'elapsed'}>{formatElapsed(elapsedMs)}</span> : null}
        </summary>
        <ToolItemActions item={item} locale={locale} onPreviewFile={onPreviewFile} onOpenFile={onOpenFile} />
        <DiffView hunks={hunks} locale={locale} />
      </details>
    );
  }
  const toolSummary = summarizeToolItem(item, locale);
  return (
    <details className={compact ? 'message tool inlineTool' : 'message tool'} open={active ? true : undefined}>
      <summary className="toolSummary">
        {toolSummary.status ? <span className={`toolSummaryStatus ${item.status ?? ''}`} title={locale === 'zh' ? '工具状态' : 'Tool status'} aria-label={locale === 'zh' ? '工具状态' : 'Tool status'}>{toolSummary.status}</span> : null}
        <span className="toolSummaryMain">
          <strong className="toolSummaryName">{toolSummary.name}</strong>
          {toolSummary.value ? <span className="toolSummaryValue">{toolSummary.value}</span> : null}
          {toolSummary.meta ? <span className="toolSummaryMeta">{toolSummary.meta}</span> : null}
          {failureSummary ? <span className="toolSummaryError" title={failureSummary}>{failureSummary}</span> : null}
        </span>
        {elapsedMs !== null ? (
          <span className="toolElapsed" title={locale === 'zh' ? '调用时长' : 'elapsed'}>
            {item.status === 'in_progress'
              ? (locale === 'zh' ? `已用时 ${formatElapsed(elapsedMs)}` : `${formatElapsed(elapsedMs)} elapsed`)
              : (locale === 'zh' ? `用时 ${formatElapsed(elapsedMs)}` : `${formatElapsed(elapsedMs)}`)}
          </span>
        ) : null}
      </summary>
      <RemoteAgentStream item={item} locale={locale} />
      <ToolItemActions item={item} locale={locale} onPreviewFile={onPreviewFile} onOpenFile={onOpenFile} />
      <ToolPayloadDetails item={item} locale={locale} />
      <ChildActivityList items={childItems} locale={locale} />
    </details>
  );
}

/**
 * 远程 Agent 中间状态展示：
 * - 状态轨迹（remoteStatusTrail）：working → input-required → completed 的时间线
 * - 中间文本流（remoteTextStream）：远程 Agent 流式返回的中间文本片段
 * 仅对 spawn_remote_agent 工具有效，其他工具直接返回 null。
 */
// — Chinese: remote agent intermediate state display. Status trail + text stream.
// Only effective for spawn_remote_agent tool.
function RemoteAgentStream({ item, locale }: { item: ThreadItem; locale: Locale }) {
  if (item.type !== 'collab_tool_call' || item.tool !== 'spawn_remote_agent') return null;
  const trail = item.remoteStatusTrail ?? [];
  const textStream = item.remoteTextStream ?? [];
  if (trail.length === 0 && textStream.length === 0) return null;

  const stateLabel = (state: string): { text: string; className: string } => {
    switch (state) {
      case 'working':
        return { text: locale === 'zh' ? '运行中' : 'working', className: 'remoteStatusState working' };
      case 'input-required':
        return { text: locale === 'zh' ? '等待输入' : 'input-required', className: 'remoteStatusState inputRequired' };
      case 'completed':
        return { text: locale === 'zh' ? '已完成' : 'completed', className: 'remoteStatusState completed' };
      case 'failed':
      case 'canceled':
      case 'rejected':
        return { text: locale === 'zh' ? `失败(${state})` : `failed(${state})`, className: 'remoteStatusState failed' };
      default:
        return { text: state, className: 'remoteStatusState' };
    }
  };

  return (
    <div className="remoteAgentStream">
      {trail.length > 0 ? (
        <div className="remoteStatusTrail">
          <div className="remoteStreamHeader">
            {locale === 'zh' ? '状态轨迹' : 'Status trail'}
          </div>
          {trail.map((entry, idx) => {
            const label = stateLabel(entry.state);
            return (
              <div className="remoteStatusEntry" key={`trail-${idx}`}>
                <span className={label.className}>{label.text}</span>
                <span className="remoteStatusTime">{entry.timestamp}</span>
                {entry.text ? <span className="remoteStatusText">{entry.text}</span> : null}
              </div>
            );
          })}
        </div>
      ) : null}
      {textStream.length > 0 ? (
        <div className="remoteTextStream">
          <div className="remoteStreamHeader">
            {locale === 'zh' ? '中间文本流' : 'Intermediate text stream'}
          </div>
          {textStream.map((chunk, idx) => (
            <p className="remoteTextChunk" key={`text-${idx}`}>{chunk.text}</p>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function ChildActivityList({ items, locale }: { items: ThreadItem[]; locale: Locale }) {
  if (items.length === 0) return null;
  return (
    <div className="childActivity">
      <div className="childActivityHeader">{locale === 'zh' ? '子 Agent 活动' : 'Child agent activity'}</div>
      {items.map((item) => {
        if (item.type === 'agent_message') {
          return <p className="childActivityText" key={item.id}>{item.text}</p>;
        }
        if (item.type === 'reasoning') {
          // 中文注释：子 agent 的推理过程，默认折叠，灰色文本
          // — Chinese: child agent reasoning, collapsed by default, gray text
          const text = item.text ?? '';
          if (!text.trim()) return null;
          return (
            <details className="childActivityReasoning" key={item.id}>
              <summary>
                <Icon name="spark" />
                <span>{locale === 'zh' ? '推理过程' : 'Reasoning'}</span>
              </summary>
              <p className="childActivityReasoningText">{text}</p>
            </details>
          );
        }
        if (item.type === 'error') {
          return (
            <ErrorNotice
              info={item.info}
              message={item.message ?? item.text ?? item.error?.message}
              detail={item.detail}
              locale={locale}
              className="childActivityError"
              key={item.id}
            />
          );
        }
        return <ToolDetails item={item} locale={locale} key={item.id} compact />;
      })}
    </div>
  );
}

function MessageFrame({
  align,
  children,
  item,
  locale,
  action,
  onBranch,
  onCopy,
  onRollback,
  onRegenerate,
  showActionRow = true,
  showTurnAction = true,
  showRegenerate = false,
  text,
  userAvatarId,
  customUserAvatarDataUrl,
}: {
  align: 'agent' | 'user';
  children: React.ReactNode;
  item: ThreadItem;
  locale: Locale;
  action: 'branch' | 'rollback';
  onBranch?: (turnId: string) => void;
  onCopy?: (text: string) => void;
  onRollback?: (turnId: string) => void;
  onRegenerate?: (turnId: string) => void;
  showActionRow?: boolean;
  showTurnAction?: boolean;
  showRegenerate?: boolean;
  text: string;
  userAvatarId?: string;
  customUserAvatarDataUrl?: string;
}) {
  const timestamp = item.timestamp ?? new Date().toISOString();
  const actionTitle = action === 'branch'
    ? (locale === 'zh' ? '从这里分支对话' : 'Branch from here')
    : (locale === 'zh' ? '回退到这里' : 'Rollback to here');
  const regenerateTitle = locale === 'zh' ? '重新回答' : 'Regenerate response';
  const runAction = action === 'branch' ? onBranch : onRollback;
  const showActions = showActionRow && item.status !== 'in_progress';
  const moodVariant = messageMoodVariant(item);
  return (
    <div className={align === 'user' ? 'messageBlock user' : 'messageBlock agent'}>
      {align === 'agent' ? (
        <div className={['messageAgentAvatar', moodVariant].join(' ')} aria-hidden="true">
          <RobotMoodIcon variant={moodVariant} />
        </div>
      ) : null}
      {children}
      {align === 'user' ? (
        <div className="messageUserAvatar" aria-hidden="true">
          <UserAvatar avatarId={userAvatarId} customDataUrl={customUserAvatarDataUrl} size="sm" />
        </div>
      ) : null}
      {showActions ? (
      <div className="messageActions">
        <time className="messageTimestamp">{formatTimestamp(timestamp, locale)}</time>
        <button
          className="messageActionButton"
          title={locale === 'zh' ? '复制' : 'Copy'}
          aria-label={locale === 'zh' ? '复制' : 'Copy'}
          onClick={() => onCopy?.(text)}
        >
          <Icon name="copy" />
        </button>
        {showTurnAction && item.turnId ? (
          <button
            className="messageActionButton"
            title={actionTitle}
            aria-label={actionTitle}
            onClick={() => runAction?.(item.turnId!)}
          >
            <Icon name={action === 'branch' ? 'branch' : 'pen'} />
          </button>
        ) : null}
        {showRegenerate && item.turnId ? (
          <button
            className="messageActionButton"
            title={regenerateTitle}
            aria-label={regenerateTitle}
            onClick={() => onRegenerate?.(item.turnId!)}
          >
            <Icon name="refresh" />
          </button>
        ) : null}
      </div>
      ) : null}
    </div>
  );
}

function messageMoodVariant(item: ThreadItem): RobotMoodVariant {
  // 进行中不再播放 working/thinking 头像动画——流式输出旁已有 StreamingOutputIcon，
  // 避免同一气泡两个"思考"动画重复。失败/取消保留警示表情。
  // — English: no working/thinking avatar animation while in progress — the
  //   StreamingOutputIcon next to the streaming text is the single thinking
  //   indicator, so two animations never duplicate in one bubble. Failed /
  //   cancelled keep their alert face.
  if (item.status === 'in_progress') return 'idle';
  if (item.status === 'completed') return 'idle';
  if (item.status === 'failed' || item.status === 'cancelled') return 'thinking';
  return 'idle';
}

/**
 * 工具条目操作按钮：从 item 中提取文件路径，渲染"预览"和"在编辑器中打开"按钮。
 * — Chinese: tool item action buttons — extract file paths from item, render "preview" and "open in editor" buttons.
 */
function ToolItemActions({
  item,
  locale,
  onPreviewFile,
  onOpenFile,
}: {
  item: ThreadItem;
  locale: Locale;
  onPreviewFile?: (path: string) => void;
  onOpenFile?: (path: string) => void;
}) {
  const filePaths = extractFilePaths(item);
  if (filePaths.length === 0 || (!onPreviewFile && !onOpenFile)) return null;
  return (
    <div className="toolItemActions">
      {filePaths.map((filePath, index) => (
        <div className="toolItemFilePath" key={`${filePath}-${index}`}>
          <span className="toolItemFilePathLabel" title={filePath}>{filePath}</span>
          {onPreviewFile ? (
            <button
              className="toolItemActionButton"
              type="button"
              title={locale === 'zh' ? '在右侧预览' : 'Preview in right panel'}
              onClick={() => onPreviewFile(filePath)}
            >
              <Icon name="eye" />
              <span>{locale === 'zh' ? '预览' : 'Preview'}</span>
            </button>
          ) : null}
          {onOpenFile ? (
            <button
              className="toolItemActionButton"
              type="button"
              title={locale === 'zh' ? '在系统编辑器中打开' : 'Open in system editor'}
              onClick={() => onOpenFile(filePath)}
            >
              <Icon name="folderCode" />
              <span>{locale === 'zh' ? '打开' : 'Open'}</span>
            </button>
          ) : null}
        </div>
      ))}
    </div>
  );
}

/** 工具展开详情：原生行式参数/结果，不显示参数 JSON。 */
function ToolPayloadDetails({ item, locale }: { item: ThreadItem; locale: Locale }) {
  const args = readObject(item.arguments);
  const rows = Object.entries(args)
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .slice(0, 12);
  const result = item.type === 'tool_call' || item.type === 'mcp_tool_call'
    ? (typeof item.result === 'string'
      ? item.result
      : item.result ? JSON.stringify(item.result, null, 2) : '')
    : '';
  const error = item.error?.message ?? '';
  if (rows.length === 0 && !result && !error) return null;
  return (
    <div className="toolPayloadDetails">
      {rows.map(([key, value]) => {
        const text = key === 'command' || key === 'patch'
          ? formatArgValue(value, key)
          : formatArgValue(value, key);
        return (
          <div className="toolPayloadRow" key={key}>
            <span className="toolPayloadKey">{key}</span>
            <pre className="toolPayloadValue">{text}</pre>
          </div>
        );
      })}
      {result ? (
        <div className="toolPayloadRow">
          <span className="toolPayloadKey">{locale === 'zh' ? '结果' : 'Result'}</span>
          <pre className="toolPayloadValue">{result}</pre>
        </div>
      ) : null}
      {error ? (
        <div className="toolPayloadRow">
          <span className="toolPayloadKey">{locale === 'zh' ? '错误' : 'Error'}</span>
          <pre className="toolPayloadValue">{error}</pre>
        </div>
      ) : null}
    </div>
  );
}

/**
 * 从工具条目中提取文件路径列表。
 * — Chinese: extract file path list from a tool item.
 */
function extractFilePaths(item: ThreadItem): string[] {
  if (item.type === 'file_change') {
    return (item.changes ?? []).map((change) => change.path).filter((p) => typeof p === 'string' && p.trim());
  }
  if (item.type === 'tool_call' || item.type === 'mcp_tool_call') {
    const args = readObject(item.arguments);
    const path = firstArgValue(args, ['filePath', 'path']);
    return path ? [path] : [];
  }
  return [];
}

function formatItemPayload(item: ThreadItem): string {
  if (item.type === 'command_execution') {
    return String(item.aggregatedOutput ?? item.result ?? item.error?.message ?? item.arguments ?? '');
  }
  const payload = item.result ?? item.error ?? item.arguments ?? item;
  return typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2);
}

function preferredValueKeys(toolName: string): string[] {
  switch (toolName) {
    case 'search_content':
      return ['pattern', 'query', 'text'];
    case 'read_file':
    case 'write_file':
      return ['filePath', 'path'];
    case 'shell_command':
      return ['command'];
    case 'apply_patch':
      return ['patch'];
    case 'current_time':
      return ['timeZone', 'locale'];
    case 'web_search':
      return ['action', 'url', 'query', 'queries', 'pattern'];
    default:
      return ['query', 'pattern', 'filePath', 'path', 'command', 'url', 'name', 'text'];
  }
}

function preferredMetaKeys(toolName: string): string[] {
  switch (toolName) {
    case 'search_content':
      return ['path', 'fileTypes'];
    case 'read_file':
      return ['offset', 'limit'];
    case 'write_file':
      return ['content'];
    case 'shell_command':
      return ['cwd'];
    default:
      return [];
  }
}

function readObject(value: unknown): Record<string, unknown> {
  if (!value) return {};
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as unknown;
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
    } catch {
      return {};
    }
  }
  return typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function firstArgValue(args: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    if (!(key in args)) continue;
    const value = formatArgValue(args[key], key);
    if (value) return value;
  }
  return '';
}

function summarizeRemainingArgs(args: Record<string, unknown>, skipKeys: string[]): string {
  const skip = new Set(skipKeys);
  return Object.entries(args)
    .filter(([key, value]) => !skip.has(key) && value !== undefined && value !== null && value !== '')
    .slice(0, 2)
    .map(([key, value]) => `${key} ${formatArgValue(value, key)}`)
    .join(' · ');
}

function summarizePickedArgs(args: Record<string, unknown>, keys: string[]): string {
  return keys
    .filter((key) => args[key] !== undefined && args[key] !== null && args[key] !== '')
    .slice(0, 2)
    .map((key) => `${key} ${formatArgValue(args[key], key)}`)
    .join(' · ');
}

function formatArgValue(value: unknown, key = ''): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') {
    const text = value.trim();
    if (!text) return '';
    if (key === 'content' || key === 'patch') return `${text.length} chars`;
    return text;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map((entry) => formatArgValue(entry)).filter(Boolean).join(', ');
  return JSON.stringify(value);
}

function formatToolStatus(status: string | undefined, locale: Locale): string {
  if (!status) return '';
  if (status === 'completed') return '✓';
  if (status === 'in_progress') return '•';
  if (status === 'failed') return '!';
  if (status === 'cancelled' || status === 'canceled') return '×';
  return locale === 'zh' ? '•' : '•';
}

function toolFailureSummary(item: ThreadItem, locale: Locale): string {
  if (!('status' in item) || item.status !== 'failed') return '';
  const candidate = item as ThreadItem & {
    error?: { message?: string };
    aggregatedOutput?: string;
    exitCode?: number | null;
  };
  const message = candidate.error?.message?.trim();
  if (message) {
    const code = (candidate.error as { code?: string } | undefined)?.code?.trim();
    return truncateInline(formatSuanliziErrorMessage((item as ThreadItem & { info?: Parameters<typeof formatSuanliziErrorMessage>[0] }).info, code ? `${code}: ${message}` : message, locale), 180);
  }
  const output = typeof candidate.aggregatedOutput === 'string'
    ? candidate.aggregatedOutput.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).at(-1) ?? ''
    : '';
  if (output) return truncateInline(output, 180);
  if (candidate.exitCode !== undefined && candidate.exitCode !== null) {
    return locale === 'zh' ? `退出码 ${candidate.exitCode}` : `exit code ${candidate.exitCode}`;
  }
  return locale === 'zh' ? '工具调用失败' : 'Tool call failed';
}

function collectTurnToolItems(items: ThreadItem[]): ThreadItem[] {
  return items.filter((item) => isToolItem(item));
}

/** collab_tool_call 状态点颜色（与 workbench AgentTree 的语义一致） */
function agentStatusColor(status: string | undefined): string {
  if (status === 'running') return '#22c55e';
  if (status === 'failed') return '#ef4444';
  if (status === 'interrupted' || status === 'stale' || status === 'waiting') return '#f97316';
  return '#94a3b8';
}

function isAgentRowLive(item: ThreadItem): boolean {
  return item.status === 'in_progress' || item.agentStatus === 'running';
}

/**
 * 气泡底部的子 Agent 行：进行中渲染为常显 live 行（不折叠，长正文也不会被掩盖），
 * 已完成渲染为紧凑 chip。点击 agent 名字 → 打开右侧详情视图。
 * — Chinese: sub-agent row at the bottom of an assistant bubble; live rows stay
 *   expanded, finished agents collapse to a chip. Clicking the name opens the
 *   right-hand detail view.
 */
function AgentTurnRow({
  item,
  locale,
  directory,
  childActivity,
  onOpenAgent,
}: {
  item: ThreadItem;
  locale: Locale;
  directory: Record<string, SubagentDirectoryEntry>;
  childActivity: ThreadItem[];
  onOpenAgent?: (threadId: string) => void;
}) {
  const zh = locale === 'zh';
  const threadId = item.newThreadId ?? item.receiverThreadId ?? '';
  const entry = threadId ? directory[threadId] : undefined;
  const label = entry?.label || item.prompt?.replace(/\s+/g, ' ').slice(0, 24) || (zh ? '子 Agent' : 'Sub-agent');
  const live = isAgentRowLive(item);
  const status = entry?.status ?? (live ? 'running' : item.agentStatus ?? item.status);
  const elapsedMs = useElapsedMs(item.timestamp, live ? 'in_progress' : 'completed', (item as ThreadItem & { completedAt?: string | null }).completedAt);
  const latestActivity = childActivity[childActivity.length - 1];
  const currentAction = live
    ? (entry?.currentAction || summarizeChildActivity(latestActivity, zh))
    : summarizeChildActivity(latestActivity, zh) || item.prompt?.replace(/\s+/g, ' ').slice(0, 80) || '';
  const instruction = item.prompt?.replace(/\s+/g, ' ').trim();
  const nameButton = threadId && onOpenAgent ? (
    <button
      type="button"
      className="agentNameButton"
      title={zh ? '查看该 Agent 详情' : 'View agent details'}
      aria-label={zh ? `查看 ${label} 详情` : `View ${label} details`}
      onClick={() => onOpenAgent(threadId)}
    >
      {label}
    </button>
  ) : <strong className="agentNameText">{label}</strong>;

  if (live) {
    return (
      <div className="turnAgentSection" data-agent-status={status}>
        <div className="turnAgentLiveRow" role="status" aria-live="polite">
          <span className="turnAgentStatusDot" style={{ backgroundColor: agentStatusColor(status) }} aria-hidden="true" />
          {nameButton}
          <span className="turnAgentAction" title={instruction || currentAction}>{currentAction || (zh ? '运行中…' : 'Running…')}</span>
          {elapsedMs !== null ? <span className="toolElapsed">{formatElapsed(elapsedMs)}</span> : null}
          <span className="turnAgentSpinner" aria-hidden="true"><i /><i /><i /></span>
        </div>
      </div>
    );
  }

  const failed = status === 'failed' || item.status === 'failed';
  return (
    <div className="turnAgentSection" data-agent-status={status}>
      <div className={`turnAgentChip${failed ? ' failed' : ''}`}>
        <span className="turnAgentStatusDot" style={{ backgroundColor: agentStatusColor(status) }} aria-hidden="true" />
        {nameButton}
        {currentAction ? <span className="turnAgentAction" title={currentAction}>{currentAction}</span> : null}
        {elapsedMs !== null ? <span className="toolElapsed">{formatElapsed(elapsedMs)}</span> : null}
        {failed ? <span className="turnAgentFailedBadge">{zh ? '失败' : 'Failed'}</span> : null}
      </div>
      <RemoteAgentTrail item={item} locale={locale} />
    </div>
  );
}

/** 远程 Agent（spawn_remote_agent）的状态轨迹：收进小折叠，避免挤占正文。 */
function RemoteAgentTrail({ item, locale }: { item: ThreadItem; locale: Locale }) {
  if (item.type !== 'collab_tool_call' || item.tool !== 'spawn_remote_agent') return null;
  const trail = item.remoteStatusTrail ?? [];
  if (trail.length === 0) return null;
  const zh = locale === 'zh';
  return (
    <details className="turnAgentRemoteTrail">
      <summary>{zh ? `状态轨迹（${trail.length}）` : `Status trail (${trail.length})`}</summary>
      {trail.map((entry, index) => (
        <div className="turnAgentRemoteTrailEntry" key={`trail-${index}`}>
          <span className="turnAgentRemoteTrailState">{entry.state}</span>
          <span className="turnAgentRemoteTrailTime">{entry.timestamp}</span>
          {entry.text ? <span className="turnAgentRemoteTrailText">{entry.text}</span> : null}
        </div>
      ))}
    </details>
  );
}

function summarizeChildActivity(item: ThreadItem | undefined, zh: boolean): string {
  if (!item) return '';
  switch (item.type) {
    case 'tool_call':
      return item.toolName || '';
    case 'mcp_tool_call':
      return `${item.server || 'mcp'}:${item.tool || 'tool'}`;
    case 'command_execution':
      return item.command?.replace(/\s+/g, ' ').slice(0, 60) || '';
    case 'file_change': {
      const firstPath = item.changes?.[0]?.path;
      const name = firstPath ? firstPath.split(/[/\\]/).pop() : '';
      return item.changes && item.changes.length > 1 && name ? `${name} +${item.changes.length - 1}` : (name || '');
    }
    case 'agent_message':
      return item.text?.replace(/\s+/g, ' ').trim().slice(0, 60) || '';
    case 'reasoning':
      return zh ? '思考中…' : 'Thinking…';
    case 'error':
      return item.error?.message || item.message || (zh ? '出错' : 'Error');
    default:
      return '';
  }
}

function truncateInline(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 1)}...`;
}
