// Agent 工作台 hook：从 runtimeItems + threadChildren + busy 派生 AgentNode[] 树并管理选中状态
// 数据源：
//   - runtimeItems（主 agent timeline，由 SSE /api/runs/:runId/items 推送）
//   - threadChildren（子 agent 列表，含每个子 agent 自己的 items）
//   - busy（主 agent 是否运行中）

import { useEffect, useMemo, useReducer } from 'react';
import type { Locale } from '../../config/config.js';
import type { ThreadChildInfo, ThreadItem } from '../../shared/types.js';
import {
  agentStageReducer,
  buildAgentNodeFromChild,
  initialAgentStageState,
  type AgentNode,
  type AgentStageState,
} from './agentStageReducer.js';
import { buildSubagentStatusRows } from './subagents.js';

/** 构建 AgentNode[] 树 */
export function buildAgentTree(options: {
  activeThreadId: string;
  activeThreadTitle: string;
  busy: boolean;
  children: ThreadChildInfo[];
  runtimeItems: ThreadItem[];
  locale: Locale;
}): AgentNode[] {
  const { activeThreadId, busy, children, runtimeItems, locale } = options;

  // 主 Agent 节点：使用 runtimeItems 作为它的 items
  const mainTone: AgentNode['tone'] = busy ? 'running' : 'muted';
  const latestMainItem = runtimeItems[runtimeItems.length - 1];
  const mainAgent: AgentNode = {
    id: activeThreadId || 'main',
    name: locale === 'zh' ? 'Suanlizi 主控 Agent' : 'Suanlizi Primary Agent',
    role: locale === 'zh' ? '主 Agent' : 'Main Agent',
    status: busy ? 'running' : 'idle',
    currentStep: latestMainItem
      ? stageTitleBrief(latestMainItem, locale)
      : (busy
        ? (locale === 'zh' ? '正在处理任务' : 'Working on task')
        : (locale === 'zh' ? '等待指令' : 'Awaiting command')),
    tokenUsage: { used: 0, limit: 0 },
    depth: 0,
    parentId: null,
    children: [],
    items: runtimeItems,
    tone: mainTone,
    updatedAt: new Date().toISOString(),
  };

  if (children.length === 0) return [mainAgent];

  // 子 agent 行（复用现有排序逻辑）
  const subagentRows = buildSubagentStatusRows(children, locale);
  const childById = new Map<string, ThreadChildInfo>();
  for (const child of children) childById.set(child.thread.threadId, child);

  // 构建 child AgentNode（保持 depth）
  const childNodes = subagentRows.map((row) => {
    const child = childById.get(row.threadId);
    const items = child?.items ?? [];
    const latest = items[items.length - 1];
    const node: AgentNode = {
      id: row.threadId,
      name: row.title,
      role: row.role,
      status: agentStatusFromToneLocal(row.tone),
      currentStep: latest ? stageTitleBrief(latest, locale) : row.latestAction,
      tokenUsage: { used: 0, limit: 0 },
      depth: row.depth + 1,
      parentId: row.parentThreadId || activeThreadId,
      children: [],
      items,
      tone: row.tone,
      updatedAt: row.updatedAt,
    };
    return node;
  });

  // 按 parent 嵌套到主 agent 或其他子 agent
  const nodeById = new Map<string, AgentNode>();
  nodeById.set(mainAgent.id, mainAgent);
  for (const node of childNodes) nodeById.set(node.id, node);

  for (const node of childNodes) {
    const parent = node.parentId ? nodeById.get(node.parentId) : null;
    if (parent) parent.children.push(node);
    else mainAgent.children.push(node);
  }

  return [mainAgent];
}

/** 把 ThreadItem 转成简短阶段描述（用于 currentStep） */
function stageTitleBrief(item: ThreadItem, locale: Locale): string {
  if (item.type === 'tool_call' || item.type === 'mcp_tool_call') {
    return locale === 'zh' ? `调用工具: ${item.toolName || item.tool || ''}` : `Tool: ${item.toolName || item.tool || ''}`;
  }
  if (item.type === 'collab_tool_call') {
    return locale === 'zh' ? `协作工具: ${item.tool || ''}` : `Collab: ${item.tool || ''}`;
  }
  if (item.type === 'command_execution') {
    return locale === 'zh' ? `执行命令: ${item.command || ''}` : `Command: ${item.command || ''}`;
  }
  if (item.type === 'file_change') {
    const paths = (item.changes ?? []).map((c) => c.path);
    return locale === 'zh' ? `文件变更: ${paths.join(', ')}` : `File: ${paths.join(', ')}`;
  }
  if (item.type === 'web_search') {
    return locale === 'zh' ? `网络搜索: ${item.prompt || item.trigger || ''}` : `Search: ${item.prompt || item.trigger || ''}`;
  }
  if (item.type === 'reasoning') {
    return locale === 'zh' ? '规划中' : 'Planning';
  }
  if (item.type === 'agent_message') {
    return locale === 'zh' ? '回复中' : 'Replying';
  }
  if (item.type === 'error') {
    return locale === 'zh' ? '错误' : 'Error';
  }
  return item.type;
}

function agentStatusFromToneLocal(tone: 'running' | 'success' | 'warning' | 'danger' | 'muted'): AgentNode['status'] {
  if (tone === 'running') return 'running';
  if (tone === 'success') return 'completed';
  if (tone === 'danger') return 'failed';
  if (tone === 'warning') return 'waiting';
  return 'idle';
}

/** useAgentStage：输入原始数据 → 输出 AgentNode[] 树 + 选中状态 + dispatch */
export function useAgentStage(options: {
  activeThreadId: string;
  activeThreadTitle: string;
  busy: boolean;
  children: ThreadChildInfo[];
  runtimeItems: ThreadItem[];
  locale: Locale;
}): {
  state: AgentStageState;
  agents: AgentNode[];
  dispatch: React.Dispatch<Parameters<typeof agentStageReducer>[1]>;
} {
  const agents = useMemo(
    () => buildAgentTree(options),
    [options.activeThreadId, options.activeThreadTitle, options.busy, options.children, options.runtimeItems, options.locale],
  );

  const [state, dispatch] = useReducer(agentStageReducer, undefined, initialAgentStageState);

  // 当 agents 引用变化时，重新 init（保留 reducer 内部的"保留已有选中"逻辑）
  useEffect(() => {
    dispatch({ type: 'init', agents });
  }, [agents]);

  return { state, agents, dispatch };
}

/** 仅用于单元测试的导出 */
export { buildAgentNodeFromChild };
