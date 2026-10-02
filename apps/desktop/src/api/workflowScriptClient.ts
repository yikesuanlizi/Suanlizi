// Workflow 脚本 API 客户端（P4b/P6，desktop）：脚本校验、批准启动、运行结果 /
// AgentCall 查询、取消，以及 P6 待批准请求列表 / 批准 / 拒绝。
//
// 契约来源：apps/api/src/routes/workflowScriptRoute.ts 的响应体（不得在此伪造数据）。
// - POST /api/tasks/:taskId/workflows/validate   -> { taskId, validation }
// - POST /api/tasks/:taskId/workflows/runs       -> { runId, taskRunId, status }
// - GET  /api/workflows/runs/:runId/result       -> { run, agentCalls }
// - POST /api/workflows/runs/:runId/cancel       -> { runId, status }
// - GET  /api/tasks/:taskId/workflows/requests   -> { taskId, requests }（P6）
// - POST /api/workflows/runs/:runId/approve      -> { runId, taskRunId, goalRunId, status }（P6）
// - POST /api/workflows/runs/:runId/reject       -> { runId, taskRunId, goalRunId, status }（P6）
//
// desktop 与 web 的差异仅在错误类型：本端复用 api/taskClient.ts 的 TaskRequestError。
// — Chinese: mirrors the P4b/P6 workflow script route contract on desktop.

import type { WorkflowAgentCall, WorkflowUsage } from '@suanlizi/protocol';
import { TaskRequestError } from './taskClient.js';

export interface WorkflowScriptDiagnostic {
  code: string;
  message: string;
  line?: number;
}

export interface WorkflowScriptValidation {
  ok: boolean;
  diagnostics: WorkflowScriptDiagnostic[];
  meta?: { name: string; description: string; phases: string[] };
  /** P5：静态成本度量（大任务警告依据）。 */
  cost?: { agentCallSites: number; agentsInsideLoop: boolean; fanOutSites: number };
}

export interface WorkflowScriptValidationResult {
  taskId: string;
  validation: WorkflowScriptValidation;
}

export interface WorkflowRunStartResult {
  runId: string;
  taskRunId: string;
  status: 'running';
}

export interface WorkflowRunResult {
  run: {
    id: string;
    taskRunId: string;
    scriptHash: string;
    args?: unknown;
    status: string;
    usage: WorkflowUsage;
    startedAt: string;
    updatedAt: string;
    completedAt?: string;
    /** P6：GoalRun 来源 / run 级证据 id / 脚本终态结果。 */
    goalRunId?: string;
    evidenceId?: string;
    result?: unknown;
  };
  agentCalls: Array<
    Pick<
      WorkflowAgentCall,
      'id' | 'prompt' | 'inputTokens' | 'outputTokens'
    > & {
      label?: string;
      model?: string;
      status: string;
      result?: unknown;
      error?: string;
      startedAt?: string;
      completedAt?: string;
      evidenceId?: string;
    }
  >;
}

export interface WorkflowRunCancelResult {
  runId: string;
  status: 'cancelling';
}

/** 终态集合：轮询在终态停止（与 protocol WORKFLOW_RUN_TERMINAL_STATUSES 对齐）。 */
export const WORKFLOW_TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled']);

// 统一请求：相对路径 `/api/...`（同源，由 Electron 主进程 / Vite 代理到本地 API）。
async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
    ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
  };
  const response = await fetch(`/api${path}`, { ...init, headers });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    const error = (data as { error?: { code?: string; message?: string; details?: Record<string, unknown> } }).error;
    throw new TaskRequestError(error?.message ?? `请求失败（HTTP ${response.status}）：${path}`, {
      status: response.status,
      code: error?.code ?? 'TASK_REQUEST_FAILED',
      details: error?.details,
    });
  }
  return response.json() as Promise<T>;
}

/** POST /api/tasks/:taskId/workflows/validate —— 静态校验 + meta 提取（批准界面）。 */
export function validateWorkflowScript(taskId: string, script: string): Promise<WorkflowScriptValidationResult> {
  return requestJson<WorkflowScriptValidationResult>(
    `/tasks/${encodeURIComponent(taskId)}/workflows/validate`,
    { method: 'POST', body: JSON.stringify({ script }) },
  );
}

/** POST /api/tasks/:taskId/workflows/runs —— 批准后启动（立即返回 runId，后台执行）。 */
export function startWorkflowRun(
  taskId: string,
  script: string,
  args?: unknown,
  resumeFromRunId?: string,
): Promise<WorkflowRunStartResult> {
  const body: Record<string, unknown> = { script };
  if (args !== undefined) body.args = args;
  if (resumeFromRunId) body.resumeFromRunId = resumeFromRunId;
  return requestJson<WorkflowRunStartResult>(
    `/tasks/${encodeURIComponent(taskId)}/workflows/runs`,
    { method: 'POST', body: JSON.stringify(body) },
  );
}

/** GET /api/workflows/runs/:runId/result —— RunRecord + AgentCalls（含终态）；字段缺失时归一。 */
export async function fetchWorkflowRunResult(runId: string): Promise<WorkflowRunResult> {
  const data = await requestJson<WorkflowRunResult>(`/workflows/runs/${encodeURIComponent(runId)}/result`);
  if (!data || typeof data !== 'object' || !data.run) {
    throw new TaskRequestError(`工作流运行 ${runId} 响应缺少 run 字段`, { status: 0, code: 'MALFORMED_RESPONSE' });
  }
  return { run: data.run, agentCalls: Array.isArray(data.agentCalls) ? data.agentCalls : [] };
}

/** P6：GET /api/workflows/runs/:runId/evidence —— 本次 Run 物化的 Evidence 引用列表。 */
export interface WorkflowRunEvidenceView {
  runId: string;
  taskRunId: string;
  status: string;
  goalRunId?: string;
  runEvidenceId?: string;
  evidenceIds: string[];
  result?: unknown;
}

export function fetchWorkflowRunEvidence(runId: string): Promise<WorkflowRunEvidenceView> {
  return requestJson<WorkflowRunEvidenceView>(`/workflows/runs/${encodeURIComponent(runId)}/evidence`);
}

/** POST /api/workflows/runs/:runId/cancel —— 取消运行中的 run；未运行时服务端返回 409。 */
export async function cancelWorkflowRun(runId: string): Promise<WorkflowRunCancelResult> {
  try {
    return await requestJson<WorkflowRunCancelResult>(
      `/workflows/runs/${encodeURIComponent(runId)}/cancel`,
      { method: 'POST' },
    );
  } catch (error) {
    if (error instanceof TaskRequestError && error.status === 409) {
      throw new TaskRequestError('该运行不在执行中（已完成或已取消），无需取消。', {
        status: error.status,
        code: error.code,
        details: error.details,
      });
    }
    throw error;
  }
}

// ─── P6：Goal × Workflow 与独立 Dynamic Workflow 待批准请求 ─────────────────────────────────────────

/** GET /tasks/:id/workflows/requests 返回的待批准记录（WorkflowRunRecord 子集）。 */
export interface WorkflowPendingRequest {
  id: string;
  taskRunId: string;
  goalRunId?: string;
  script: string;
  status: string;
  startedAt: string;
  updatedAt: string;
}

export interface WorkflowRequestsResult {
  taskId: string;
  requests: WorkflowPendingRequest[];
}

export interface ProposeWorkflowRunInput {
  /** Goal × Workflow 组合时传入；独立 Dynamic Workflow 不传。 */
  goalRunId?: string;
  objective: string;
  proposedScript: string;
  estimatedAgents?: number;
  estimatedTokens?: number;
}

/** 创建待审阅的脚本模板；不会直接执行。 */
export function proposeWorkflowRun(taskId: string, input: ProposeWorkflowRunInput): Promise<WorkflowPendingRequest> {
  return requestJson<WorkflowPendingRequest>(
    `/tasks/${encodeURIComponent(taskId)}/workflows/requests`,
    { method: 'POST', body: JSON.stringify(input) },
  );
}


/** approve / reject 的返回（WorkflowRequestDecisionView）。 */
export interface WorkflowRequestDecision {
  runId: string;
  taskRunId: string;
  goalRunId?: string;
  status: 'approved' | 'rejected';
  /** §14.10：批准的是编辑后脚本时为 true。 */
  scriptEdited?: boolean;
  /** 批准后固化的 scriptHash（编辑批准时会变）。 */
  scriptHash?: string;
}

/** GET /api/tasks/:taskId/workflows/requests —— 待批准请求列表（缺失字段归一为空数组）。 */
export async function fetchWorkflowRequests(taskId: string): Promise<WorkflowRequestsResult> {
  const data = await requestJson<Partial<WorkflowRequestsResult>>(
    `/tasks/${encodeURIComponent(taskId)}/workflows/requests`,
  );
  return { taskId, requests: Array.isArray(data.requests) ? data.requests : [] };
}

/**
 * POST /api/workflows/runs/:runId/approve —— 批准待决请求 → 启动执行。
 * 传 `script` 即批准编辑后的脚本（服务端会重新静态校验）；不传则批准原提案（§14.10）。
 */
export function approveWorkflowRequest(runId: string, script?: string): Promise<WorkflowRequestDecision> {
  return requestJson<WorkflowRequestDecision>(
    `/workflows/runs/${encodeURIComponent(runId)}/approve`,
    { method: 'POST', body: JSON.stringify(script && script.trim() ? { script } : {}) },
  );
}

/** POST /api/workflows/runs/:runId/reject —— 拒绝待决请求 → cancelled。 */
export function rejectWorkflowRequest(runId: string, reason?: string): Promise<WorkflowRequestDecision> {
  return requestJson<WorkflowRequestDecision>(
    `/workflows/runs/${encodeURIComponent(runId)}/reject`,
    { method: 'POST', body: JSON.stringify(reason ? { reason } : {}) },
  );
}

// ─── P5：历史脚本（保存 / 查看 / 对比 / 编辑后重跑的数据源） ───────────────────

export interface WorkflowScriptHistoryEntry {
  runId: string;
  taskRunId: string;
  scriptHash: string;
  script: string;
  status: string;
  startedAt: string;
  completedAt?: string;
  usage: WorkflowUsage;
  evidenceId?: string;
}

export interface WorkflowScriptsResult {
  taskId: string;
  scripts: WorkflowScriptHistoryEntry[];
}

/**
 * GET /api/tasks/:taskId/workflows/scripts —— 已运行脚本去重列表（新→旧）。
 * 缺字段时归一为空列表，避免 `undefined` 塑进列表状态后读 `.length` 崩渲染。
 */
export async function fetchWorkflowScripts(taskId: string): Promise<WorkflowScriptsResult> {
  const data = await requestJson<Partial<WorkflowScriptsResult>>(
    `/tasks/${encodeURIComponent(taskId)}/workflows/scripts`,
  );
  return { taskId, scripts: Array.isArray(data.scripts) ? data.scripts : [] };
}
