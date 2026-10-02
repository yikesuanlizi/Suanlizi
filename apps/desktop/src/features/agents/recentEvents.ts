import { formatSuanliziErrorMessage, normalizeErrorFingerprint, presentSuanliziError } from '@suanlizi/protocol';
import type { RunTraceCategory, RunTraceEnvelope } from '@suanlizi/protocol';
import type { ThreadChildInfo, ThreadItem } from '../../shared/types.js';
import { traceSummary } from '../monitor/traceFormatters.js';
import { resourceUsageFromItem, resourceUsageFromTrace } from './agentResources.js';
import type { AgentResourceKind } from './agentResources.js';

export interface RecentTraceEvent {
  itemId: string;
  eventId?: string;
  runId: string;
  category: RunTraceCategory;
  name: string;
  level: 'debug' | 'info' | 'warning' | 'error';
  status?: 'completed' | 'in_progress' | 'failed' | 'cancelled' | 'canceled';
  summary: string;
  detail?: string;
  occurredAt: string;
  agent: { threadId: string; label: string; depth: number };
  resource?: { kind: AgentResourceKind; label: string };
}

export interface RecentEvent {
  agent: RecentTraceEvent['agent'];
  category: RecentTraceEvent['category'];
  detail?: string;
  eventId?: string;
  itemId: string;
  level: RecentTraceEvent['level'];
  name: string;
  occurredAt: string;
  runId: string;
  resource?: RecentTraceEvent['resource'];
  status?: RecentTraceEvent['status'];
  summary: string;
}

const EXCLUDED_TYPES = new Set(['user_message', 'agent_message', 'thinking', 'reasoning']);
const EVENT_LIMIT = 10;
const ACTIVITY_TEXT_LIMIT = 2000;
const ACTIVITY_SUMMARY_LIMIT = 80;

function clipActivityText(value: string | undefined): string | undefined {
  const text = value?.trim();
  if (!text) return undefined;
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length <= ACTIVITY_TEXT_LIMIT) return normalized;
  return `${normalized.slice(0, ACTIVITY_TEXT_LIMIT)}…`;
}

function clipActivitySummary(value: string | undefined): string | undefined {
  const text = clipActivityText(value);
  if (!text) return undefined;
  return text.length <= ACTIVITY_SUMMARY_LIMIT ? text : `${text.slice(0, ACTIVITY_SUMMARY_LIMIT)}…`;
}

/** 把同一 run 的重复错误和失败工具行合并成一条，保留最早时间和最完整的原始响应。 */
export function reconcileRecentEvents(events: RecentEvent[]): RecentEvent[] {
  const merged = new Map<string, RecentEvent>();
  for (const event of events) {
    const key = event.level === 'error' || event.category === 'error'
      ? [event.agent.threadId, event.runId, normalizeErrorFingerprint(event.detail || event.summary)].join('\u0000')
      : recentEventDedupeKey(event);
    const current = merged.get(key);
    if (!current) {
      merged.set(key, { ...event });
      continue;
    }
    merged.set(key, mergeRecentEvent(current, event));
  }

  // A failed tool without its own response duplicates the run error; drop it
  // when that error already carries a provider/tool detail.
  for (const [key, event] of [...merged]) {
    if (event.category !== 'tool' || event.level !== 'error') continue;
    if (event.detail || event.status !== 'failed') continue;
    const hasDetailedError = [...merged.values()].some(candidate => candidate !== event
      && (candidate.category === 'error' || candidate.level === 'error')
      && candidate.agent.threadId === event.agent.threadId
      && candidate.runId === event.runId
      && Boolean(candidate.detail));
    if (hasDetailedError) merged.delete(key);
  }

  return [...merged.values()]
    .sort((a, b) => a.occurredAt.localeCompare(b.occurredAt) || a.itemId.localeCompare(b.itemId))
    .slice(-EVENT_LIMIT);
}

function mergeRecentEvent(a: RecentEvent, b: RecentEvent): RecentEvent {
  return {
    ...a,
    eventId: a.eventId ?? b.eventId,
    detail: chooseDetail(a.detail, b.detail),
    status: chooseStatus(a.status, b.status),
    summary: chooseSummary(a.summary, b.summary),
    occurredAt: [a.occurredAt, b.occurredAt].sort()[0] || a.occurredAt,
    resource: a.resource ?? b.resource,
  };
}

function chooseDetail(a?: string, b?: string): string | undefined {
  if (!a) return b;
  if (!b) return a;
  return a.length >= b.length ? a : b;
}

function chooseSummary(a: string, b: string): string {
  if (!a) return b;
  if (!b) return a;
  return a.localeCompare(b, undefined, { sensitivity: 'base' }) === 0 ? a : (a.length <= b.length ? a : b);
}

function chooseStatus(
  a?: RecentEvent['status'],
  b?: RecentEvent['status'],
): RecentEvent['status'] {
  const rank: Record<NonNullable<RecentEvent['status']>, number> = {
    failed: 4, cancelled: 3, canceled: 3, in_progress: 2, completed: 1,
  };
  if (!a) return b;
  if (!b) return a;
  return rank[a] >= rank[b] ? a : b;
}

function recentEventDedupeKey(event: RecentEvent): string {
  if (event.eventId && event.itemId !== event.eventId) return `item:${event.itemId}`;
  if (event.eventId) return `trace:${event.eventId}`;
  return `item:${event.itemId}`;
}

function shouldShowTraceInActivity(trace: RunTraceEnvelope): boolean {
  if (trace.category === 'tool' && trace.name.startsWith('tool.batch.')) return false;
  return trace.category === 'model'
    || trace.category === 'tool'
    || trace.category === 'file'
    || trace.category === 'approval'
    || trace.category === 'agent'
    || trace.category === 'checkpoint'
    || trace.category === 'evidence'
    || trace.category === 'control'
    || trace.category === 'error';
}

function errorDetailFromItem(item: ThreadItem): string | undefined {
  return presentSuanliziError(
    item.info,
    item.message ?? item.text ?? item.error?.message,
  ).detail;
}

function eventFromItem(item: ThreadItem, agent: RecentTraceEvent['agent'], currentRunId?: string): RecentEvent | null {
  if (EXCLUDED_TYPES.has(item.type)) return null;
  let category: RunTraceCategory = 'item';
  let level: RecentEvent['level'] = 'info';
  if (item.type === 'error' || item.status === 'failed') {
    category = 'error';
    level = 'error';
  } else if (item.type === 'tool_call' || item.type === 'mcp_tool_call' || item.type === 'collab_tool_call'
    || item.type === 'command_execution' || item.type === 'web_search') {
    category = 'tool';
  } else if (item.type === 'file_change') category = 'file';
  else if (item.type === 'project_checkpoint' || item.type === 'workflow_checkpoint') category = 'checkpoint';

  const failed = item.type === 'error' || item.status === 'failed';
  const summary = failed
    ? clipActivityText(formatSuanliziErrorMessage(item.info, item.message ?? item.text ?? item.error?.message)) ?? itemLabel(item)
    : itemActivitySummary(item);
  const detail = failed ? errorDetailFromItem(item) : clipActivityText(toolDetail(item));
  const resource = resourceUsageFromItem(item);
  const status = item.status === 'completed' || item.status === 'in_progress' || item.status === 'failed'
    || item.status === 'cancelled' || item.status === 'canceled' ? item.status : undefined;
  return {
    itemId: item.id,
    runId: (item as { runId?: string }).runId || currentRunId || '',
    category, name: itemLabel(item), level, status, summary, detail, resource: resource ?? undefined,
    occurredAt: item.timestamp || new Date().toISOString(), agent,
  };
}

function eventFromTrace(trace: RunTraceEnvelope, mainThreadId: string, childAgents: Map<string, RecentTraceEvent['agent']>, currentRunId?: string): RecentEvent | null {
  if (!shouldShowTraceInActivity(trace)) return null;
  const payload = trace.payload as Record<string, unknown>;
  const detail = trace.category === 'error' && typeof payload.message === 'string' && payload.message.trim()
    ? clipActivityText(payload.message)
    : undefined;
  const resource = resourceUsageFromTrace(trace);
  const statusValue = payload.status;
  const status = typeof statusValue === 'string'
    && ['completed', 'in_progress', 'failed', 'cancelled', 'canceled'].includes(statusValue)
    ? statusValue as RecentEvent['status']
    : trace.level === 'error' ? 'failed' : undefined;
  return {
    itemId: trace.itemId ?? trace.eventId,
    eventId: trace.eventId,
    runId: trace.runId || currentRunId || '',
    category: trace.category,
    name: clipActivitySummary(traceSummary(trace, true)) || trace.name,
    level: trace.level,
    status,
    summary: clipActivitySummary(traceSummary(trace, true)) || trace.name,
    detail,
    resource: resource ?? undefined,
    occurredAt: trace.occurredAt,
    agent: agentForTrace(trace, mainThreadId, childAgents),
  };
}

function agentForTrace(
  trace: RunTraceEnvelope,
  mainThreadId: string,
  childAgents: Map<string, RecentTraceEvent['agent']>,
): RecentEvent['agent'] {
  const payload = trace.payload as Record<string, unknown>;
  const payloadThreadId = typeof payload.agentThreadId === 'string' ? payload.agentThreadId : '';
  const payloadRole = typeof payload.agentRole === 'string' ? payload.agentRole
    : typeof payload.role === 'string' ? payload.role : '';
  const threadId = payloadThreadId || trace.threadId || mainThreadId;
  if (threadId === mainThreadId) return { threadId, label: payloadRole || 'Suanlizi 主控 Agent', depth: 0 };
  const child = childAgents.get(threadId);
  if (child) return payloadRole ? { ...child, label: payloadRole } : child;
  return { threadId, label: payloadRole || '子 Agent', depth: 1 };
}

function toolDetail(item: ThreadItem): string | undefined {
  const own = item.error?.message?.trim();
  if (own) return own;
  if (typeof item.aggregatedOutput === 'string' && item.aggregatedOutput.trim()) return item.aggregatedOutput.trim();
  return undefined;
}

function itemLabel(item: ThreadItem): string {
  const resource = item.toolName || item.command;
  if (resource) return resource;
  return item.type;
}

function itemActivitySummary(item: ThreadItem): string {
  if (item.toolName || item.command) return itemLabel(item);
  return clipActivityText(item.message || item.text) || itemLabel(item);
}

export function deriveRecentEvents(
  mainThreadId: string,
  threadChildren: ThreadChildInfo[],
  runtimeItems: ThreadItem[],
  recentTraces: RunTraceEnvelope[],
  currentRunId: string | undefined,
  zh: boolean,
): RecentTraceEvent[] {
  void zh;
  const childAgents = new Map<string, RecentTraceEvent['agent']>();
  for (const child of threadChildren) {
    childAgents.set(child.thread.threadId, {
      threadId: child.thread.threadId,
      label: child.thread.agentRole || child.thread.title || '子 Agent',
      depth: 1,
    });
  }

  const mainAgent: RecentTraceEvent['agent'] = { threadId: mainThreadId, label: 'Suanlizi 主控 Agent', depth: 0 };
  const events: RecentEvent[] = [];
  for (const item of runtimeItems) {
    const event = eventFromItem(item, mainAgent, currentRunId);
    if (event) events.push(event);
  }
  for (const child of threadChildren) {
    const agent = childAgents.get(child.thread.threadId) ?? { threadId: child.thread.threadId, label: '子 Agent', depth: 1 };
    for (const item of child.items ?? []) {
      const event = eventFromItem(item, agent, currentRunId);
      if (event) events.push(event);
    }
  }
  for (const trace of recentTraces) {
    const event = eventFromTrace(trace, mainThreadId, childAgents, currentRunId);
    if (event) events.push(event);
  }
  return reconcileRecentEvents(events);
}
