// Agent 工作台状态管理：定义 AgentNode / StageNode / StageDetail 数据模型与 reducer
// 设计目标：从 ThreadItem timeline + ThreadChildInfo 树派生三列工作台所需状态

import type { ThreadChildInfo, ThreadItem } from '../../shared/types.js';
import { formatSuanliziErrorMessage } from '@suanlizi/protocol';

/** Agent 节点状态徽章 */
export type AgentStatus = 'idle' | 'running' | 'completed' | 'failed' | 'waiting';

/** 阶段状态 */
export type StageStatus = 'pending' | 'running' | 'completed' | 'failed';

/** 阶段类型：按 ThreadItem 类型映射 */
export type StageType =
  | 'planning' // 推理 / 规划：reasoning
  | 'tool_calling' // 工具调用：tool_call / mcp_tool_call / collab_tool_call / command_execution
  | 'model_invocation' // 模型调用：由 model.* event 触发（暂用 agent_message 占位）
  | 'file_operation' // 文件操作：file_change
  | 'web_research' // 网络研究：web_search
  | 'todo_management' // 待办管理：todo_list
  | 'error_handling' // 错误处理：error
  | 'compaction' // 上下文压缩：context_compaction
  | 'checkpoint' // 检查点：workflow_checkpoint / project_checkpoint
  | 'message' // 消息：user_message / agent_message
  | 'continuation'; // 续跑：harness_continuation / rollback_conflict

/** Agent 树节点 */
export interface AgentNode {
  id: string;
  name: string;
  role: string;
  status: AgentStatus;
  currentStep: string;
  tokenUsage: { used: number; limit: number };
  depth: number;
  parentId: string | null;
  children: AgentNode[];
  /** 该 agent 关联的原始 items（主 agent 取 runtimeItems，子 agent 取 child.items） */
  items: ThreadItem[];
  /** 来源行（用于状态徽章颜色复用 SubagentStatusRow.tone） */
  tone: 'running' | 'success' | 'warning' | 'danger' | 'muted';
  updatedAt: string;
}

/** 阶段节点 */
export interface StageNode {
  id: string;
  agentId: string;
  type: StageType;
  title: string;
  status: StageStatus;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  items: ThreadItem[];
  model?: string;
  tokenUsage?: { input: number; output: number; total: number };
}

/** 阶段详情 */
export interface StageDetail {
  stage: StageNode;
  input: unknown;
  output: unknown;
  durationMs?: number;
  tokenUsage?: { input: number; output: number; total: number };
  error?: string;
  itemId?: string;
}

/** 工作台状态 */
export interface AgentStageState {
  agents: AgentNode[];
  selectedAgentId: string | null;
  selectedStageId: string | null;
  expandedAgentIds: string[];
}

/** Reducer 动作 */
export type AgentStageAction =
  | { type: 'init'; agents: AgentNode[] }
  | { type: 'selectAgent'; agentId: string }
  | { type: 'selectStage'; stageId: string }
  | { type: 'toggleAgent'; agentId: string }
  | { type: 'expandAgent'; agentId: string }
  | { type: 'collapseAgent'; agentId: string };

/** ThreadItem.type → StageType 映射 */
const STAGE_TYPE_MAP: Record<string, StageType> = {
  user_message: 'message',
  agent_message: 'message',
  reasoning: 'planning',
  tool_call: 'tool_calling',
  mcp_tool_call: 'tool_calling',
  collab_tool_call: 'tool_calling',
  command_execution: 'tool_calling',
  file_change: 'file_operation',
  web_search: 'web_research',
  todo_list: 'todo_management',
  error: 'error_handling',
  context_compaction: 'compaction',
  workflow_checkpoint: 'checkpoint',
  project_checkpoint: 'checkpoint',
  rollback_conflict: 'continuation',
  harness_continuation: 'continuation',
};

/** 将 ThreadItem.type 映射为 StageType；未知类型回落到 message */
export function stageTypeFromItem(itemType: string): StageType {
  return STAGE_TYPE_MAP[itemType] ?? 'message';
}

/** 阶段类型 → 本地化标题 */
export function stageTypeLabel(type: StageType, locale: 'zh' | 'en'): string {
  const zh: Record<StageType, string> = {
    planning: '规划',
    tool_calling: '工具调用',
    model_invocation: '模型调用',
    file_operation: '文件操作',
    web_research: '网络研究',
    todo_management: '待办管理',
    error_handling: '错误处理',
    compaction: '上下文压缩',
    checkpoint: '检查点',
    message: '消息',
    continuation: '续跑',
  };
  const en: Record<StageType, string> = {
    planning: 'Planning',
    tool_calling: 'Tool',
    model_invocation: 'Model',
    file_operation: 'File',
    web_research: 'Web',
    todo_management: 'Todo',
    error_handling: 'Error',
    compaction: 'Compaction',
    checkpoint: 'Checkpoint',
    message: 'Message',
    continuation: 'Continuation',
  };
  return locale === 'zh' ? zh[type] : en[type];
}

/** Agent 状态 → 本地化文本 */
export function agentStatusLabel(status: AgentStatus, locale: 'zh' | 'en'): string {
  const zh: Record<AgentStatus, string> = {
    idle: '空闲',
    running: '运行中',
    completed: '已完成',
    failed: '失败',
    waiting: '等待中',
  };
  const en: Record<AgentStatus, string> = {
    idle: 'Idle',
    running: 'Running',
    completed: 'Completed',
    failed: 'Failed',
    waiting: 'Waiting',
  };
  return locale === 'zh' ? zh[status] : en[status];
}

/** 阶段状态 → 本地化文本 */
export function stageStatusLabel(status: StageStatus, locale: 'zh' | 'en'): string {
  const zh: Record<StageStatus, string> = {
    pending: '待执行',
    running: '运行中',
    completed: '已完成',
    failed: '失败',
  };
  const en: Record<StageStatus, string> = {
    pending: 'Pending',
    running: 'Running',
    completed: 'Completed',
    failed: 'Failed',
  };
  return locale === 'zh' ? zh[status] : en[status];
}

/** ThreadItem 状态 → StageStatus */
export function stageStatusFromItem(item: ThreadItem): StageStatus {
  // 错误优先：即使 status 是 completed，只要有 error 字段就视为失败
  if (item.error || item.status === 'failed' || item.status === 'error') return 'failed';
  const status = item.status;
  if (status === 'completed') return 'completed';
  if (status === 'running' || status === 'pending') return 'running';
  // 没有显式状态默认 completed（历史 item 通常是已完成）
  return status ? 'completed' : 'completed';
}

/** 从 ThreadItem 派生阶段标题 */
export function stageTitleFromItem(item: ThreadItem, locale: 'zh' | 'en'): string {
  const typeLabel = stageTypeLabel(stageTypeFromItem(item.type), locale);
  const detail = itemDetailText(item, locale);
  return detail ? `${typeLabel}: ${detail}` : typeLabel;
}

/** 提取 item 的简要描述文本 */
function itemDetailText(item: ThreadItem, locale: 'zh' | 'en' = 'zh'): string {
  if (item.type === 'tool_call' || item.type === 'mcp_tool_call') {
    return item.toolName || item.tool || '';
  }
  if (item.type === 'collab_tool_call') {
    return item.tool || '';
  }
  if (item.type === 'command_execution') {
    return item.command ? truncate(item.command, 40) : '';
  }
  if (item.type === 'file_change') {
    const paths = (item.changes ?? []).map((c) => c.path);
    return paths.length > 0 ? paths.join(', ') : '';
  }
  if (item.type === 'web_search') {
    return item.prompt || item.trigger || '';
  }
  if (item.type === 'todo_list') {
    const total = item.items?.length ?? 0;
    const done = item.items?.filter((i) => i.completed).length ?? 0;
    return total > 0 ? `${done}/${total}` : '';
  }
  if (item.type === 'error') {
    return item.error?.message ? truncate(formatSuanliziErrorMessage(item.info, item.error.message, locale), 40) : '';
  }
  if (item.type === 'context_compaction') {
    return item.summary ? String(item.summary).slice(0, 40) : '';
  }
  if (item.type === 'reasoning') {
    return item.text ? truncate(item.text, 40) : '';
  }
  if (item.type === 'agent_message' || item.type === 'user_message') {
    return item.text ? truncate(item.text, 40) : '';
  }
  if (item.type === 'workflow_checkpoint' || item.type === 'project_checkpoint') {
    return typeof item.turnCount === 'number' ? `#${item.turnCount}` : '';
  }
  return '';
}

function truncate(text: string, max: number): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

/** 从一组 ThreadItem 构建 StageNode 列表（按时间排序） */
export function buildStagesFromItems(agentId: string, items: ThreadItem[], locale: 'zh' | 'en'): StageNode[] {
  const sorted = [...items].sort((a, b) => {
    const ta = a.timestamp ? Date.parse(a.timestamp) : 0;
    const tb = b.timestamp ? Date.parse(b.timestamp) : 0;
    return ta - tb;
  });
  return sorted.map((item) => buildStageFromItem(agentId, item, locale));
}

/** 从单个 ThreadItem 构建 StageNode */
export function buildStageFromItem(agentId: string, item: ThreadItem, locale: 'zh' | 'en'): StageNode {
  const status = stageStatusFromItem(item);
  const startedAt = item.timestamp;
  const completedAt = status === 'completed' || status === 'failed' ? item.timestamp : undefined;
  const tokenUsage = extractTokenUsage(item);
  return {
    id: `${agentId}::${item.id}`,
    agentId,
    type: stageTypeFromItem(item.type),
    title: stageTitleFromItem(item, locale),
    status,
    startedAt,
    completedAt,
    items: [item],
    tokenUsage,
  };
}

/** 从 ThreadItem 提取 token 用量（若有） */
function extractTokenUsage(item: ThreadItem): { input: number; output: number; total: number } | undefined {
  if (typeof item.tokensBefore === 'number' || typeof item.tokensAfter === 'number') {
    const before = item.tokensBefore ?? 0;
    const after = item.tokensAfter ?? 0;
    return { input: before, output: Math.max(0, after - before), total: after };
  }
  return undefined;
}

/** 从 StageNode 构建 StageDetail */
export function buildStageDetail(stage: StageNode, locale: 'zh' | 'en' = 'zh'): StageDetail {
  const item = stage.items[0];
  if (!item) {
    return { stage, input: undefined, output: undefined };
  }
  return {
    stage,
    input: item.arguments ?? item.prompt ?? item.command ?? item.text,
    output: item.result ?? item.aggregatedOutput ?? item.text ?? item.summary,
    durationMs: stage.durationMs,
    tokenUsage: stage.tokenUsage,
    error: item.error?.message,
    itemId: item.id,
  };
}

/** 初始状态 */
export function initialAgentStageState(): AgentStageState {
  return {
    agents: [],
    selectedAgentId: null,
    selectedStageId: null,
    expandedAgentIds: [],
  };
}

/** 默认选中：第一个 agent 的最新阶段 */
export function pickDefaultSelection(agents: AgentNode[]): { agentId: string | null; stageId: string | null } {
  if (agents.length === 0) return { agentId: null, stageId: null };
  const first = agents[0];
  // 最新阶段 = items 最后一个（按时间排序后）
  const latestItem = first.items[first.items.length - 1];
  const stageId = latestItem ? `${first.id}::${latestItem.id}` : null;
  return { agentId: first.id, stageId };
}

/** Reducer */
export function agentStageReducer(state: AgentStageState, action: AgentStageAction): AgentStageState {
  switch (action.type) {
    case 'init': {
      const { agents } = action;
      // 保留已有选中（若仍存在），否则取默认
      const existingAgent = state.selectedAgentId ? agents.find((a) => a.id === state.selectedAgentId) : null;
      const existingStage = state.selectedStageId && existingAgent
        ? existingAgent.items.find((i) => `${existingAgent.id}::${i.id}` === state.selectedStageId)
        : null;
      if (existingAgent && existingStage) {
        return { ...state, agents };
      }
      const defaults = pickDefaultSelection(agents);
      // 默认展开所有有子节点的 agent
      const expanded = agents.filter((a) => a.children.length > 0).map((a) => a.id);
      return { agents, selectedAgentId: defaults.agentId, selectedStageId: defaults.stageId, expandedAgentIds: expanded };
    }
    case 'selectAgent': {
      const agent = state.agents.find((a) => a.id === action.agentId);
      if (!agent) return state;
      const latestItem = agent.items[agent.items.length - 1];
      const stageId = latestItem ? `${agent.id}::${latestItem.id}` : null;
      return { ...state, selectedAgentId: action.agentId, selectedStageId: stageId };
    }
    case 'selectStage':
      return { ...state, selectedStageId: action.stageId };
    case 'toggleAgent': {
      const exists = state.expandedAgentIds.includes(action.agentId);
      return {
        ...state,
        expandedAgentIds: exists
          ? state.expandedAgentIds.filter((id) => id !== action.agentId)
          : [...state.expandedAgentIds, action.agentId],
      };
    }
    case 'expandAgent':
      if (state.expandedAgentIds.includes(action.agentId)) return state;
      return { ...state, expandedAgentIds: [...state.expandedAgentIds, action.agentId] };
    case 'collapseAgent':
      return { ...state, expandedAgentIds: state.expandedAgentIds.filter((id) => id !== action.agentId) };
    default:
      return state;
  }
}

/** 派生当前选中的 AgentNode（null 表示未选中） */
export function selectSelectedAgent(state: AgentStageState): AgentNode | null {
  if (!state.selectedAgentId) return null;
  return findAgentById(state.agents, state.selectedAgentId);
}

/** 派生当前选中的 StageNode（null 表示未选中） */
export function selectSelectedStage(state: AgentStageState): StageNode | null {
  if (!state.selectedStageId) return null;
  const agent = selectSelectedAgent(state);
  if (!agent) return null;
  const itemId = state.selectedStageId.split('::').slice(1).join('::');
  const item = agent.items.find((i) => i.id === itemId);
  if (!item) return null;
  return buildStageFromItem(agent.id, item, 'zh'); // locale 由调用方决定，这里仅用于标题回退
}

/** 递归查找 agent */
export function findAgentById(agents: AgentNode[], id: string): AgentNode | null {
  for (const agent of agents) {
    if (agent.id === id) return agent;
    const found = findAgentById(agent.children, id);
    if (found) return found;
  }
  return null;
}

/** 派生指定 agent 的阶段列表 */
export function selectStagesForAgent(agent: AgentNode, locale: 'zh' | 'en'): StageNode[] {
  return buildStagesFromItems(agent.id, agent.items, locale);
}

/** 派生指定 stageId 的 StageDetail */
export function selectStageDetail(agent: AgentNode, stageId: string, locale: 'zh' | 'en'): StageDetail | null {
  const stages = selectStagesForAgent(agent, locale);
  const stage = stages.find((s) => s.id === stageId);
  if (!stage) return null;
  return buildStageDetail(stage, locale);
}

/** 工具：把 SubagentStatusRow.tone 映射成 AgentStatus */
export function agentStatusFromTone(tone: 'running' | 'success' | 'warning' | 'danger' | 'muted'): AgentStatus {
  if (tone === 'running') return 'running';
  if (tone === 'success') return 'completed';
  if (tone === 'danger') return 'failed';
  if (tone === 'warning') return 'waiting';
  return 'idle';
}

/** 工具：把 ThreadChildInfo 整理成 AgentNode 子树 */
export function buildAgentNodeFromChild(child: ThreadChildInfo, locale: 'zh' | 'en', depth: number): AgentNode {
  const items = child.items ?? [];
  const latest = items[items.length - 1];
  const tone: AgentNode['tone'] = child.state.status === 'running' ? 'running'
    : child.state.status === 'completed' ? 'success'
    : child.state.status === 'failed' ? 'danger'
    : child.edge.status === 'closed' ? 'muted'
    : 'muted';
  return {
    id: child.thread.threadId,
    name: child.thread.agentNickname || child.thread.title || child.thread.threadId,
    role: child.thread.agentRole || child.thread.title || '',
    status: agentStatusFromTone(tone),
    currentStep: latest ? stageTitleFromItem(latest, locale) : '',
    tokenUsage: { used: 0, limit: 0 },
    depth,
    parentId: child.thread.parentThreadId || null,
    children: [],
    items,
    tone,
    updatedAt: child.thread.updatedAt || '',
  };
}
