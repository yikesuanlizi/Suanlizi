import type { Locale } from '../../config/config.js';
import type { AgentStageRow, SubagentStatusRow, ThreadChildInfo } from '../../shared/types.js';

type StatusTone = SubagentStatusRow['tone'];

const statusTone: Record<string, StatusTone> = {
  running: 'running',
  completed: 'success',
  interrupted: 'warning',
  failed: 'danger',
  stale: 'warning',
  closed: 'muted',
  idle: 'muted',
  open: 'muted',
};

const statusLabels = {
  zh: {
    running: '运行中',
    completed: '已完成',
    interrupted: '已停止',
    failed: '失败',
    stale: '过期',
    closed: '已关闭',
    idle: '空闲',
    open: '已打开',
  },
  en: {
    running: 'Running',
    completed: 'Completed',
    interrupted: 'Interrupted',
    failed: 'Failed',
    stale: 'Stale',
    closed: 'Closed',
    idle: 'Idle',
    open: 'Open',
  },
} as const;

const actionLabels = {
  zh: {
    spawn_agent: '生成子 Agent',
    send_input: '发送输入',
    resume_agent: '恢复子 Agent',
    wait: '等待子 Agent',
    close_agent: '关闭子 Agent',
  },
  en: {
    spawn_agent: 'Spawned agent',
    send_input: 'Sent input',
    resume_agent: 'Resumed agent',
    wait: 'Waited',
    close_agent: 'Closed agent',
  },
} as const;

export function buildSubagentStatusRows(children: ThreadChildInfo[], locale: Locale): SubagentStatusRow[] {
  const byParent = new Map<string, ThreadChildInfo[]>();
  const childIds = new Set(children.map((child) => child.thread.threadId));
  for (const child of children) {
    const parentId = child.edge.parentThreadId || child.thread.parentThreadId || '';
    byParent.set(parentId, [...(byParent.get(parentId) ?? []), child]);
  }
  for (const siblings of byParent.values()) {
    siblings.sort((a, b) => rowUpdatedAt(b).localeCompare(rowUpdatedAt(a)));
  }

  const roots = children
    .filter((child) => !childIds.has(child.edge.parentThreadId))
    .sort((a, b) => rowUpdatedAt(b).localeCompare(rowUpdatedAt(a)));
  const rows: SubagentStatusRow[] = [];
  const seen = new Set<string>();
  const visit = (child: ThreadChildInfo, depth: number) => {
    if (seen.has(child.thread.threadId)) return;
    seen.add(child.thread.threadId);
    rows.push(toStatusRow(child, depth, locale));
    for (const nested of byParent.get(child.thread.threadId) ?? []) visit(nested, depth + 1);
  };
  for (const root of roots) visit(root, 0);
  for (const child of children.filter((item) => !seen.has(item.thread.threadId))) visit(child, 0);
  return rows;
}

export function buildAgentStageRows(options: {
  activeThreadId: string;
  activeThreadTitle: string;
  locale: Locale;
  busy: boolean;
  children: SubagentStatusRow[];
}): AgentStageRow[] {
  const mainStatus = options.busy ? 'running' : 'idle';
  const labels = statusLabels[options.locale];
  const mainAgentTitle = options.locale === 'zh' ? 'Suanlizi 主控 Agent' : 'Suanlizi Primary Agent';
  return [
    {
      kind: 'main',
      threadId: options.activeThreadId || 'main',
      parentThreadId: '',
      title: mainAgentTitle,
      role: options.locale === 'zh' ? '主 Agent' : 'Main Agent',
      depth: 0,
      status: mainStatus,
      statusLabel: options.busy
        ? labels[mainStatus]
        : (options.locale === 'zh' ? '待机中' : 'Standby'),
      tone: statusTone[mainStatus],
      latestAction: options.busy
        ? (options.locale === 'zh' ? '正在处理任务' : 'Working on task')
        : (options.locale === 'zh' ? '等待指令' : 'Awaiting command'),
      updatedAt: new Date().toISOString(),
    },
    ...options.children.map((row) => ({ ...row, kind: 'child' as const })),
  ];
}

function toStatusRow(child: ThreadChildInfo, depth: number, locale: Locale): SubagentStatusRow {
  const status = resolveStatus(child);
  const labels = statusLabels[locale];
  return {
    threadId: child.thread.threadId,
    parentThreadId: child.edge.parentThreadId,
    title: child.thread.agentNickname || child.thread.title || child.thread.agentRole || child.thread.threadId,
    role: child.thread.agentRole || child.thread.title || '',
    depth,
    status,
    statusLabel: labels[status as keyof typeof labels] ?? status,
    tone: statusTone[status] ?? 'muted',
    latestAction: latestAction(child, locale),
    updatedAt: rowUpdatedAt(child),
  };
}

function resolveStatus(child: ThreadChildInfo): string {
  if (child.state.status && child.state.status !== 'idle') return child.state.status;
  if (child.latestTurn?.status && child.latestTurn.status !== 'completed') return child.latestTurn.status;
  if (child.edge.status === 'closed') return 'closed';
  return child.latestTurn?.status ?? child.edge.status;
}

function latestAction(child: ThreadChildInfo, locale: Locale): string {
  const tool = child.latestCollabItem?.tool;
  if (tool && tool in actionLabels[locale]) {
    return actionLabels[locale][tool as keyof typeof actionLabels[typeof locale]];
  }
  if (child.latestTurn?.userInput) {
    const text = userInputText(child.latestTurn.userInput);
    if (text) return text;
  }
  return locale === 'zh' ? '等待状态更新' : 'Waiting for updates';
}

function userInputText(input: unknown): string {
  if (!input || typeof input !== 'object' || !('type' in input)) return '';
  const typed = input as { type?: string; text?: string };
  return typed.type === 'text' ? (typed.text ?? '') : '';
}

function rowUpdatedAt(child: ThreadChildInfo): string {
  return child.latestTurn?.completedAt
    ?? child.latestTurn?.startedAt
    ?? child.latestCollabItem?.timestamp
    ?? child.edge.updatedAt
    ?? child.thread.updatedAt
    ?? '';
}
