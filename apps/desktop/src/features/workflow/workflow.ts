import type { ThreadItem, ThreadMeta } from '../../shared/types.js';
import { formatSuanliziErrorMessage } from '@suanlizi/protocol';

export const THREAD_WORKFLOW_TAG = 'workflow';
export const THREAD_WORKFLOW_PROJECT_TAG = 'workflowProject';

export type WorkflowNodeStatus = 'pending' | 'running' | 'completed' | 'failed' | 'blocked';
export type WorkflowRunStatus = 'planned' | 'running' | 'completed' | 'failed' | 'blocked' | 'cancelled';
export type WorkflowApprovalMode = 'none' | 'required';
export type WorkflowExecutorKind = 'prompt' | 'tool' | 'subagent' | 'human' | 'condition' | 'code' | 'template' | 'parameter_extractor' | 'control';
export type WorkflowComponentFieldKind = 'text' | 'textarea' | 'number' | 'checkbox' | 'select' | 'json';
export type WorkflowVariableNamespace = 'sys' | 'input' | 'node' | 'workflow' | 'env';
export type WorkflowBlueprintDiagnosticSeverity = 'error' | 'warning' | 'info';

export interface WorkflowComponentField {
  name: string;
  label: string;
  kind: WorkflowComponentFieldKind;
  description?: string;
  required?: boolean;
  options?: string[];
}

export interface WorkflowComponentDefinition {
  type: string;
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  defaultPrompt: string;
  executorKind: WorkflowExecutorKind;
  source?: 'builtin' | 'tool' | 'mcp' | 'skill' | 'subagent' | 'prompt';
  toolName?: string;
  sealed?: boolean;
  requiresApproval?: boolean;
  ui?: { fields: WorkflowComponentField[] };
}

export interface WorkflowNode {
  id: string;
  componentType: string;
  title: string;
  prompt: string;
  inputRequirements: string;
  outputRequirements: string;
  dependsOn: string[];
  approval: WorkflowApprovalMode;
  params?: Record<string, unknown>;
  config?: Record<string, unknown>;
}

export interface WorkflowDefinition {
  id: string;
  goal: string;
  version: number;
  source: 'model' | 'user' | 'template';
  nodes: WorkflowNode[];
  edges: Array<{ from: string; to: string; condition?: string }>;
  graph?: {
    version: 1;
    entryNodeId: string;
    terminalNodeIds: string[];
    loopBoundaries?: Array<{ loopNodeId: string; bodyEntryNodeId: string; bodyExitNodeId: string }>;
  };
  variables?: {
    namespaces: Record<WorkflowVariableNamespace, Array<{
      namespace: WorkflowVariableNamespace;
      name: string;
      description: string;
      valueType: 'string' | 'number' | 'boolean' | 'json' | 'array' | 'object';
      sensitive?: boolean;
      readonly?: boolean;
    }>>;
  };
  ui?: { layout?: { nodes?: Record<string, { x: number; y: number }>; viewport?: { x: number; y: number; scale: number } } };
  createdAt: string;
  updatedAt: string;
}

export interface WorkflowNodeRun {
  nodeId: string;
  status: WorkflowNodeStatus;
  result?: string;
  error?: string;
  blockedReason?: string;
}

export interface WorkflowRun {
  id: string;
  workflowId: string;
  goal: string;
  status: WorkflowRunStatus;
  nodeRuns: WorkflowNodeRun[];
  createdAt: string;
  updatedAt: string;
}

export interface WorkflowSnapshot {
  definition: WorkflowDefinition;
  run: WorkflowRun;
  publishedDefinition?: WorkflowDefinition | null;
  publication?: { status: 'draft' | 'published'; publishedVersion?: number; publishedAt?: string; lastTestRunId?: string };
  history?: Array<{ version: number; status: 'draft' | 'published' | 'test'; changelog?: string; definitionId: string; runId?: string; createdAt: string }>;
}

export interface WorkflowBlueprintDiagnostic {
  severity: WorkflowBlueprintDiagnosticSeverity;
  code: string;
  message: string;
  nodeId?: string;
}

export interface WorkflowBlueprintCompileResult {
  ok: boolean;
  diagnostics: WorkflowBlueprintDiagnostic[];
  entryNodeIds: string[];
  terminalNodeIds: string[];
  topology: string[];
  runnableNodeIds: string[];
  missingInputs: string[];
  referencedVariables: string[];
}

export interface WorkflowPlanDraft {
  kind: 'workflow_draft';
  goal: string;
  workflow: WorkflowSnapshot;
  components: WorkflowComponentDefinition[];
  items?: ThreadItem[];
  blueprint?: WorkflowBlueprintCompileResult;
}

export type WorkflowNodePatch = Partial<Pick<WorkflowNode, 'componentType' | 'title' | 'prompt' | 'inputRequirements' | 'outputRequirements' | 'dependsOn' | 'approval' | 'params'>>;

export function parseThreadWorkflow(thread: ThreadMeta | undefined | null): WorkflowSnapshot | null {
  const raw = thread?.tags?.[THREAD_WORKFLOW_TAG];
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as WorkflowSnapshot;
    if (!parsed.definition?.id || !Array.isArray(parsed.definition.nodes) || !parsed.run?.id) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function isWorkflowProjectThread(thread: ThreadMeta | undefined | null): boolean {
  return Boolean(thread?.tags?.[THREAD_WORKFLOW_PROJECT_TAG] || thread?.tags?.[THREAD_WORKFLOW_TAG]);
}

export function workflowThreadTitleFromGoal(goal: string, fallback = 'Untitled workflow project'): string {
  const normalized = goal.split(/\r?\n/)[0]?.replace(/\s+/g, ' ').trim() ?? '';
  return (normalized || fallback).slice(0, 60);
}

export function isUntitledWorkflowProjectTitle(title: string | undefined | null): boolean {
  const normalized = title?.trim();
  return !normalized || normalized === '未命名工作流项目' || normalized === 'Untitled workflow project';
}

export function createEmptyWorkflowSnapshot(goal = '', now = new Date()): WorkflowSnapshot {
  const timestamp = now.toISOString();
  const id = `workflow_def_${now.getTime()}`;
  return {
    definition: {
      id,
      goal,
      version: 1,
      source: 'user',
      nodes: [],
      edges: [],
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    run: {
      id: `workflow_run_${now.getTime()}`,
      workflowId: id,
      goal,
      status: 'planned',
      nodeRuns: [],
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    publication: { status: 'draft' },
    publishedDefinition: null,
    history: [],
  };
}

export function parseWorkflowCheckpointItems(items: ThreadItem[]): WorkflowSnapshot | null {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item?.type !== 'workflow_checkpoint') continue;
    const candidate = item.workflow as WorkflowSnapshot | undefined;
    if (candidate?.definition?.id && Array.isArray(candidate.definition.nodes) && candidate.run?.id) {
      return candidate;
    }
  }
  return null;
}

export function updateWorkflowNodeDraft(snapshot: WorkflowSnapshot, nodeId: string, patch: WorkflowNodePatch): WorkflowSnapshot {
  return {
    ...snapshot,
    definition: {
      ...snapshot.definition,
      version: snapshot.definition.version + 1,
      updatedAt: new Date().toISOString(),
      nodes: snapshot.definition.nodes.map((node) => node.id === nodeId ? {
        ...node,
        ...patch,
        id: node.id,
        componentType: node.componentType,
      } : node),
    },
  };
}

export function workflowNodeDependencyText(node: WorkflowNode): string {
  return node.dependsOn.length ? node.dependsOn.join(', ') : 'entry';
}

export function workflowNodeStatus(snapshot: WorkflowSnapshot, nodeId: string): WorkflowNodeStatus {
  return snapshot.run.nodeRuns.find((nodeRun) => nodeRun.nodeId === nodeId)?.status ?? 'pending';
}

export async function loadThreadWorkflow(threadId: string): Promise<{ workflow?: WorkflowSnapshot | null; components?: WorkflowComponentDefinition[]; blueprint?: WorkflowBlueprintCompileResult | null; error?: string }> {
  const response = await fetch(`/api/threads/${threadId}/workflow`);
  const data = (await response.json()) as { workflow?: WorkflowSnapshot | null; components?: WorkflowComponentDefinition[]; blueprint?: WorkflowBlueprintCompileResult | null; error?: string };
  if (!response.ok) throw new Error(data.error ?? 'Workflow load failed');
  return data;
}

export async function planThreadWorkflow(threadId: string, goal: string): Promise<{ thread?: ThreadMeta; workflow?: WorkflowSnapshot; components?: WorkflowComponentDefinition[]; error?: string }> {
  const response = await fetch(`/api/threads/${threadId}/workflow/plan`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ goal }),
  });
  const data = (await response.json()) as { thread?: ThreadMeta; workflow?: WorkflowSnapshot; components?: WorkflowComponentDefinition[]; error?: string };
  if (!response.ok) throw new Error(data.error ?? 'Workflow planning failed');
  return data;
}

export async function planWorkflowDraft(goal: string, threadId?: string): Promise<WorkflowPlanDraft> {
  const response = await fetch(threadId ? `/api/threads/${threadId}/workflow/plan-draft` : '/api/workflow/plan-draft', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ goal }),
  });
  const data = (await response.json()) as { workflow?: WorkflowSnapshot; components?: WorkflowComponentDefinition[]; blueprint?: WorkflowBlueprintCompileResult; items?: ThreadItem[]; error?: string };
  if (!response.ok || !data.workflow) throw new Error(data.error ?? 'Workflow planning failed');
  return { kind: 'workflow_draft', goal, workflow: data.workflow, components: data.components ?? [], blueprint: data.blueprint, items: data.items };
}

export function createWorkflowDraftUserItem(goal: string, turnId: string, now = new Date()): ThreadItem {
  return { id: `${turnId}_user`, type: 'user_message', turnId, text: goal, timestamp: now.toISOString() };
}

export function createWorkflowDraftReplyItem(draft: WorkflowPlanDraft, locale: 'zh' | 'en', turnId: string, now = new Date()): ThreadItem {
  const nodes = draft.workflow.definition.nodes.filter((node) => node.componentType !== 'start' && node.componentType !== 'end');
  const titles = nodes.slice(0, 6).map((node, index) => `${index + 1}. ${node.title}`).join(locale === 'zh' ? '；' : '; ');
  const firstRequirements = nodes.slice(0, 3).map((node) => node.inputRequirements).filter(Boolean).join('\n');
  const missingInputs = draft.blueprint?.missingInputs?.slice(0, 4) ?? [];
  const zh = locale === 'zh';
  const text = zh
    ? `我已在右侧生成 ${nodes.length} 个步骤的工作流草案。这还是静态定义，不会自动运行；保存草案后才会成为当前工作流项目的快照。\n\n关键节点：${titles || '暂无节点'}\n\n我保留的具体要求：\n${firstRequirements || draft.goal}${missingInputs.length ? `\n\n仍需补充：\n${missingInputs.join('\n')}` : ''}`
    : `I generated a ${nodes.length}-step workflow draft on the right. This is still a static definition and will not run automatically; saving it only creates the workflow snapshot.\n\nKey nodes: ${titles || 'No nodes'}\n\nCaptured requirements:\n${firstRequirements || draft.goal}${missingInputs.length ? `\n\nStill needed:\n${missingInputs.join('\n')}` : ''}`;
  return { id: `${turnId}_assistant`, type: 'agent_message', turnId, text, timestamp: now.toISOString() };
}

export function createWorkflowDraftErrorItem(message: string, locale: 'zh' | 'en', turnId: string, now = new Date()): ThreadItem {
  return {
    id: `${turnId}_assistant`,
    type: 'agent_message',
    turnId,
    text: locale === 'zh'
      ? `工作流草案生成失败：${formatSuanliziErrorMessage(undefined, message, locale)}`
      : `Workflow draft planning failed: ${formatSuanliziErrorMessage(undefined, message, locale)}`,
    timestamp: now.toISOString(),
  };
}

export async function saveThreadWorkflow(threadId: string, workflow: WorkflowSnapshot): Promise<{ thread?: ThreadMeta; workflow?: WorkflowSnapshot; components?: WorkflowComponentDefinition[]; blueprint?: WorkflowBlueprintCompileResult | null; error?: string }> {
  const response = await fetch(`/api/threads/${threadId}/workflow`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ workflow }),
  });
  const data = (await response.json()) as { thread?: ThreadMeta; workflow?: WorkflowSnapshot; components?: WorkflowComponentDefinition[]; blueprint?: WorkflowBlueprintCompileResult | null; error?: string };
  if (!response.ok) throw new Error(data.error ?? 'Workflow save failed');
  return data;
}

export type WorkflowRuntimeAction = 'run' | 'test_run' | 'publish' | 'resume' | 'cancel' | 'retry_node';

export async function controlThreadWorkflow(
  threadId: string,
  action: WorkflowRuntimeAction,
  options: { nodeId?: string; runId?: string; input?: Record<string, unknown> } = {},
): Promise<{ ok?: boolean; thread?: ThreadMeta; workflow?: WorkflowSnapshot; components?: WorkflowComponentDefinition[]; blueprint?: WorkflowBlueprintCompileResult | null; events?: unknown[]; error?: string }> {
  const path = action === 'retry_node'
    ? `/api/threads/${threadId}/workflow/nodes/${encodeURIComponent(options.nodeId ?? '')}/retry`
    : action === 'test_run'
      ? `/api/threads/${threadId}/workflow/test-run`
      : action === 'publish'
        ? `/api/threads/${threadId}/workflow/publish`
    : action === 'resume' || action === 'cancel'
      ? `/api/threads/${threadId}/workflow/runs/${encodeURIComponent(options.runId ?? '')}/${action}`
      : `/api/threads/${threadId}/workflow/run`;
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ input: options.input }),
  });
  const data = (await response.json()) as { ok?: boolean; thread?: ThreadMeta; workflow?: WorkflowSnapshot; components?: WorkflowComponentDefinition[]; blueprint?: WorkflowBlueprintCompileResult | null; events?: unknown[]; error?: string };
  if (!response.ok || data.ok === false) throw new Error(data.error ?? 'Workflow runtime action failed');
  return data;
}

export async function createWorkflowThread(goal: string, workspaceRoot: string): Promise<ThreadMeta> {
  const response = await fetch('/api/threads', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title: goal.slice(0, 60),
      config: { workspaceRoot, runProfile: 'runtime_os', reasoningEffort: 'high' },
      conversationKind: 'project',
      workflowProject: true,
    }),
  });
  const data = (await response.json()) as { thread?: ThreadMeta; error?: string };
  if (!response.ok || !data.thread) throw new Error(data.error ?? 'Create thread failed');
  return data.thread;
}
