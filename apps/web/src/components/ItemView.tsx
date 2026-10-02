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
import { childActivityForCollabItem } from '../features/agents/subagentActivity.js';
import { RobotMoodIcon, type RobotMoodVariant } from './RobotMoodIcon.js';
import { UserAvatar } from './UserAvatar.js';
// 英文说明: DiffView renders red/green line-level diffs for file_change items
// 中文说明: DiffView 渲染 file_change 条目的红绿行级 diff
import { DiffView, type DiffViewHunk } from './DiffView.js';
import { parseGitNexusResult } from './gitNexusResult.js';
// 英文说明: GitNexusResultView 依赖 @xyflow/react，用 React.lazy 避免首包加载图组件
// 中文说明: GitNexusResultView 依赖 @xyflow/react，用 React.lazy 避免首包加载图组件
const GitNexusResultView = lazy(() =>
  import('./GitNexusResultView.js').then(m => ({ default: m.GitNexusResultView })),
);

export interface AssistantTurnGroup {
  turnId?: string;
  items: ThreadItem[];
  status?: string;
  timestamp?: string;
  completedAt?: string | null;
}

// 实时/冻结时长：in_progress 时每秒刷新（now - start）；非进行中首次观测时
// 冻结，避免 rerender 抖动（会话内稳定）。
// — English: live/frozen elapsed time — refreshes every second while
//   in_progress; freezes on the first non-running observation so re-renders
//   cannot jitter it (stable within the session).
function resolveElapsedMs(startIso: string | undefined, endIso?: string | null): number | null {
  if (!startIso || !endIso) return null;
  const start = Date.parse(startIso);
  const end = Date.parse(endIso);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  return end - start;
}

function useElapsedMs(startIso: string | undefined, status: string, endIso?: string | null): number | null {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    if (!startIso || status !== 'in_progress') return undefined;
    const update = () => setNow(Date.now());
    update();
    const timer = window.setInterval(update, 1000);
    return () => window.clearInterval(timer);
  }, [startIso, status]);
  if (!startIso) return null;
  if (status !== 'in_progress') return resolveElapsedMs(startIso, endIso);
  const start = Date.parse(startIso);
  return now === null || !Number.isFinite(start) ? null : Math.max(0, now - start);
}

function formatElapsed(ms: number): string {
  if (ms < 1000) return '<1s';
  return `${Math.max(1, Math.round(ms / 1000))}s`;
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
}) {
  const heading = itemHeading(item, locale);
  const gitNexusView = useGitNexusView(item);
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
    || item.type === 'collab_tool_call'
    || item.type === 'mcp_tool_call'
    || item.type === 'command_execution'
    || item.type === 'context_compaction'
  ) {
    const toolSummary = summarizeToolItem(item, locale);
    // 完成后的折叠行只保留工具名和状态，不泄露具体命令/路径；展开详情仍可查看完整调用。
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
        {gitNexusView
          ? <Suspense fallback={null}><GitNexusResultView data={gitNexusView} locale={locale} /></Suspense>
          : <pre>{formatItemPayload(item)}</pre>}
      </details>
    );
  }
  if (item.type === 'file_change') {
    // 英文说明: shared/types ThreadItem.hunks omits addedLinesContent/removedLinesContent;
    // 中文说明: shared/types 的 ThreadItem.hunks 未声明行内容字段，运行时携带，用类型断言对齐
    const hunks = (item.hunks ?? []) as DiffViewHunk[];
    return (
      <details className="message tool" open={item.status === 'in_progress' ? true : undefined}>
        <summary className="toolSummary">
          {formatToolStatus(item.status, locale) ? <span className={`toolSummaryStatus ${item.status ?? ''}`} title={locale === 'zh' ? '工具状态' : 'Tool status'} aria-label={locale === 'zh' ? '工具状态' : 'Tool status'}>{formatToolStatus(item.status, locale)}</span> : null}
          <span className="toolSummaryMain"><strong className="toolSummaryName">{heading.title}</strong><span className="toolSummaryValue">{heading.detail}</span></span>
          {elapsedMs !== null ? <span className="toolElapsed" title={locale === 'zh' ? '调用时长' : 'elapsed'}>{formatElapsed(elapsedMs)}</span> : null}
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
  // 只让当前正在运行的思考/工具块展开；一旦下一个块开始，前一个块自动收起，
  // 避免长回合把输入框和最新回答推到视口之外。
  const activeExpandableId = live
    ? [...group.items].reverse().find((item) => {
        if (item.type === 'reasoning') {
          // The latest reasoning block stays active through its completed event;
          // otherwise the panel flashes closed before the next model/tool output.
          const status = (item as ThreadItem & { status?: string }).status;
          return !status || status === 'in_progress' || Boolean(item.completedAt);
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
            return <ReasoningDetails item={item} key={item.id} locale={locale} onCopy={onCopy} active={item.id === activeExpandableId} keepOpen={false} />;
          }
          if (
            isToolItem(item)
          ) {
            if (isToolItem(group.items[index - 1])) return null;
            const batch = takeContiguousToolItems(group.items, index);
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
              />
            );
          }
          if (item.type === 'rollback_conflict') {
            return <RollbackConflictBlock item={item} locale={locale} key={item.id} />;
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
        <TurnFileSummaryBlock items={group.items as ThreadItem[]} locale={locale} onPreviewFile={onPreviewFile} workspaceRoot={workspaceRoot} />
      </article>
    </MessageFrame>
  );
}

function ReasoningDetails({
  item,
  locale,
  onCopy,
  active = false,
  keepOpen = false,
}: {
  item: ThreadItem;
  locale: Locale;
  onCopy?: (text: string) => void;
  active?: boolean;
  keepOpen?: boolean;
}) {
  const text = item.text?.trim();
  if (!text) return <InternalItemDetails item={item} locale={locale} />;
  // 思考时长（实时/冻结），跟在 THINK 小字后面。
  // — English: reasoning elapsed (live/frozen), right after the THINK label.
  const elapsedMs = useElapsedMs(
    item.timestamp,
    item.status ?? 'completed',
    (item as ThreadItem & { completedAt?: string | null }).completedAt,
  );
  const isCompactionProgress = item.id.startsWith('compaction-progress:');
  // 父级统一决定当前活跃块；否则上一个仍未收到终态的块会继续展开。
  const isLive = active || keepOpen;
  const compactionLabel = item.status === 'in_progress'
    ? (locale === 'zh' ? '上下文正在压缩' : 'Compacting context')
    : item.status === 'failed'
      ? (locale === 'zh' ? '上下文压缩失败' : 'Context compaction failed')
      : (locale === 'zh' ? '上下文压缩完成' : 'Context compaction completed');
  return (
    <details
      className="reasoningDetails"
      data-running={isLive ? 'true' : undefined}
      open={isLive ? true : undefined}
    >
      <summary>
        {isCompactionProgress ? (
          <span className="reasoningElapsed">{compactionLabel}</span>
        ) : elapsedMs !== null ? (
          <span className="reasoningElapsed">
            {locale === 'zh' ? `思考 ${formatElapsed(elapsedMs)}` : `think ${formatElapsed(elapsedMs)}`}
          </span>
        ) : null}
      </summary>
      <div className="reasoningDetailsBody"><RichMessageText text={text} onCopy={onCopy} /></div>
    </details>
  );
}

function isToolItem(item: ThreadItem | undefined): boolean {
  return Boolean(item && (
    item.type === 'tool_call'
    || item.type === 'collab_tool_call'
    || item.type === 'mcp_tool_call'
    || item.type === 'command_execution'
    || item.type === 'context_compaction'
    || item.type === 'file_change'
  ));
}

function terminalTimestampForItem(item: ThreadItem, items: ThreadItem[], turnCompletedAt?: string | null, assistantTimestamp?: string): string | null {
  const start = item.timestamp ? Date.parse(item.timestamp) : Number.NaN;
  const isAfterStart = (value: string | null | undefined): value is string => {
    const parsed = value ? Date.parse(value) : Number.NaN;
    return Number.isFinite(parsed) && (!Number.isFinite(start) || parsed > start);
  };
  // A batch ends at the last completed tool, never at the next tool's start.
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

function ToolBatchDetails({
  childActivityByThread,
  items,
  locale,
  activeId,
  completedAt,
  assistantTimestamp,
  onPreviewFile,
  onOpenFile,
}: {
  childActivityByThread: Record<string, ThreadItem[]>;
  items: ThreadItem[];
  locale: Locale;
  activeId?: string;
  completedAt?: string | null;
  assistantTimestamp?: string;
  onPreviewFile?: (path: string) => void;
  onOpenFile?: (path: string) => void;
}) {
  // 批统计：工具数量 + 批总时长（首工具开始 → 末工具完成/实时）。
  // 思考时长显示在 THINK 折叠旁（ReasoningDetails），不混入工具批。
  // — English: batch stats — tool count and total batch elapsed (first tool
  //   start → last tool finish or now). Thinking time lives next to the THINK
  //   fold (ReasoningDetails), not inside the tool batch.
  const anyRunning = items.some((item) => item.status === 'in_progress');
  const batchEnd = anyRunning ? null : terminalTimestampForItem(items[0], items, completedAt, assistantTimestamp);
  const batchElapsedMs = useElapsedMs(items[0]?.timestamp, anyRunning ? 'in_progress' : 'completed', batchEnd);
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
    ? '[已隐藏模型误输出的文本工具调用；本轮已要求模型改用结构化工具调用。]'
    : '[A plain-text tool call emitted by the model was hidden; this turn requested structured tool calls.]';
  return prefix ? prefix + '\n\n' + note : note;
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
  completedAt?: string | null;
  assistantTimestamp?: string;
  active?: boolean;
}) {
  const heading = itemHeading(item, locale);
  const gitNexusView = useGitNexusView(item);
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
      {gitNexusView
        ? <Suspense fallback={null}><GitNexusResultView data={gitNexusView} locale={locale} /></Suspense>
        : <pre>{formatItemPayload(item)}</pre>}
      <ChildActivityList items={childItems} locale={locale} />
    </details>
  );
}

function useGitNexusView(item: ThreadItem) {
  return useMemo(
    () => item.type === 'mcp_tool_call' ? parseGitNexusResult(item) : null,
    [
      item.type,
      item.type === 'mcp_tool_call' ? item.server : undefined,
      item.type === 'mcp_tool_call' ? item.tool : undefined,
      item.type === 'mcp_tool_call' ? item.arguments : undefined,
      item.type === 'mcp_tool_call' ? item.result : undefined,
    ],
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

function takeContiguousToolItems(items: ThreadItem[], start: number): ThreadItem[] {
  const batch: ThreadItem[] = [];
  for (let index = start; index < items.length && isToolItem(items[index]); index += 1) batch.push(items[index]);
  return batch;
}

function truncateInline(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 1)}...`;
}
