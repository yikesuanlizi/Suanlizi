import type { ThreadChildInfo, ThreadItem } from '../../shared/types.js';
import { resolveStatus, userInputText } from './subagents.js';

/** 气泡 Agent 行 / 详情联动用的子 agent 目录条目 */
export interface SubagentDirectoryEntry {
  threadId: string;
  label: string;
  role: string;
  status: string;
  currentAction: string;
  startedAt?: string;
}

const activityTypes = new Set([
  'agent_message',
  'reasoning',
  'tool_call',
  'command_execution',
  'file_change',
  'context_compaction',
  'collab_tool_call',
  'mcp_tool_call',
  'web_search',
  'error',
]);

export function isChildActivityItem(item: ThreadItem): boolean {
  return activityTypes.has(item.type);
}

export function buildChildActivityByThread(children: ThreadChildInfo[]): Record<string, ThreadItem[]> {
  const result: Record<string, ThreadItem[]> = {};
  for (const child of children) {
    const items = (child.items ?? []).filter(isChildActivityItem);
    if (items.length > 0) result[child.thread.threadId] = items;
  }
  return result;
}

export function childActivityForCollabItem(
  item: ThreadItem,
  byThread: Record<string, ThreadItem[]>,
): ThreadItem[] {
  if (item.type !== 'collab_tool_call') return [];
  const target = item.receiverThreadId ?? item.newThreadId;
  return target ? (byThread[target] ?? []) : [];
}

function directoryActionLabel(item: ThreadItem): string {
  switch (item.type) {
    case 'tool_call':
      return item.toolName || 'tool';
    case 'mcp_tool_call':
      return `${item.server || 'mcp'}:${item.tool || 'tool'}`;
    case 'collab_tool_call':
      return item.tool || 'collab_tool';
    case 'command_execution':
      return item.command || 'command';
    case 'file_change': {
      const firstPath = item.changes?.[0]?.path;
      return firstPath ? firstPath.split(/[/\\]/).pop() || firstPath : 'file change';
    }
    case 'agent_message':
      return item.text?.replace(/\s+/g, ' ').trim().slice(0, 60) || 'reply';
    case 'reasoning':
      return 'thinking';
    case 'error':
      return item.error?.message || item.message || 'error';
    default:
      return item.type;
  }
}

/** 从 threadChildren 派生 threadId → 目录条目，供气泡 Agent 行展示与右侧详情联动。 */
export function buildSubagentDirectory(children: ThreadChildInfo[]): Record<string, SubagentDirectoryEntry> {
  const result: Record<string, SubagentDirectoryEntry> = {};
  for (const child of children) {
    const items = child.items ?? [];
    const latest = items[items.length - 1];
    // 标签优先用任务标题（spawn 时从 prompt 生成），比角色名更能区分多个子 agent。
    // — Chinese: prefer the task title so multiple sub-agents are distinguishable.
    const taskTitle = child.thread.title || child.thread.agentNickname || child.thread.agentRole || child.thread.threadId;
    const roleLabel = child.thread.agentNickname && child.thread.agentNickname !== taskTitle
      ? child.thread.agentNickname
      : (child.thread.agentRole || '');
    result[child.thread.threadId] = {
      threadId: child.thread.threadId,
      label: taskTitle,
      role: roleLabel,
      status: resolveStatus(child),
      currentAction: latest ? directoryActionLabel(latest) : (userInputText(child.latestTurn?.userInput) ? 'queued' : ''),
      startedAt: child.latestTurn?.startedAt ?? child.edge.createdAt ?? undefined,
    };
  }
  return result;
}
