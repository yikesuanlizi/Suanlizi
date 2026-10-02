// 任务中心只读 API 客户端：封装 GET /api/tasks 系列的查询端点。
// Task-center read-only API client: wraps the GET /api/tasks query endpoints.
//
// 契约来源（不得在此伪造数据）：apps/api/src/routes/taskRoute.ts 的 P0 响应体。
// - GET /api/tasks?threadId=&status=        -> { tasks: Task[] }
// - GET /api/tasks/:id                       -> { task: Task }
// - GET /api/tasks/:id/runs                  -> { taskId, runs: TaskRun[] }
// - GET /api/tasks/:id/plan-history          -> { taskId, versions, latestPlan, runIds, historyIncomplete }
// - GET /api/tasks/:id/evidence              -> { taskId, evidenceIds }
// - GET /api/tasks/:id/goal-status           -> TaskGoalStatusResponse（最近一次 GoalEvaluation 摘要）
// 统一错误体：{ error: { code, message, details? } }。非 2xx 或网络失败一律抛可操作错误。
// — Chinese: mirrors the real P0 route contract; never returns fake data on failure.

import type { Task, TaskGoalStatusResponse, TaskOrigin, TaskPlanVersion, TaskRun, TaskStatus } from '@suanlizi/protocol';

/** 相对路径基座；与 threadConfigClient 一致，走同源 `/api`。 */
const API_BASE = '/api';

/**
 * P2 生命周期操作：POST /api/tasks/:id/<action>（§9.1）。
 * redirect/input 需要 body；成功响应统一 { task, run? }。
 */
export type TaskActionKind =
  | 'start'
  | 'pause'
  | 'resume'
  | 'cancel'
  | 'retry'
  | 'redirect'
  | 'input';

export interface TaskActionResult {
  task: Task;
  run?: TaskRun;
}

export interface TaskListResult {
  tasks: Task[];
}

export interface TaskDetailResult {
  task: Task;
}

export interface TaskRunsResult {
  taskId: string;
  runs: TaskRun[];
}

export interface TaskPlanHistoryResult {
  taskId: string;
  versions: TaskPlanVersion[];
  latestPlan: TaskPlanVersion | null;
  runIds: string[];
  historyIncomplete: boolean;
}

export interface TaskEvidenceResult {
  taskId: string;
  evidenceIds: string[];
}

/** 列表查询过滤条件；status 支持单值或数组（数组按逗号拼接，与路由解析对齐）。 */
export interface TaskListQuery {
  threadId?: string;
  status?: TaskStatus | TaskStatus[];
  /** Goal Center 固定传 explicit_goal；内部影子记录不能进入 UI。 */
  origin?: TaskOrigin | TaskOrigin[];
}

/** POST /api/tasks —— 创建一个待启动的 Goal 或 Dynamic Workflow 任务。 */
export interface CreateTaskInput {
  threadId: string;
  objective: string;
  acceptanceCriteria: string[];
  /** 用户入口模式；不暴露 protocol 内部 origin。 */
  entryMode?: 'goal' | 'workflow';
}

/**
 * 任务 API 错误：携带 HTTP status、服务端稳定 code 与 details，供 UI 显示可操作提示。
 * Task API error carrying status, stable server code and details for actionable UI messages.
 */
export class TaskApiError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly details?: Record<string, unknown>;

  constructor(message: string, status: number, code?: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'TaskApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

interface ErrorBody {
  error?: {
    code?: string;
    message?: string;
    details?: Record<string, unknown>;
  };
}

function buildListQuery(query: TaskListQuery | undefined): string {
  const params = new URLSearchParams();
  if (query?.threadId) params.set('threadId', query.threadId);
  if (query?.status) {
    params.set('status', Array.isArray(query.status) ? query.status.join(',') : query.status);
  }
  if (query?.origin) {
    params.set('origin', Array.isArray(query.origin) ? query.origin.join(',') : query.origin);
  }
  const encoded = params.toString();
  return encoded ? `?${encoded}` : '';
}

/**
 * 统一 JSON 请求：网络异常与超时抛出可操作错误；非 2xx 解析服务端错误体后抛出；
 * 成功返回反序列化后的数据。绝不吞错或返回占位假数据。
 */
export async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const url = `${API_BASE}${path}`;
  const headers: Record<string, string> = {
    Accept: 'application/json',
    ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
  };
  let response: Response;
  try {
    response = await fetch(url, { ...init, headers });
  } catch (cause) {
    throw new TaskApiError(
      `无法连接任务服务（${path}）。请检查网络或服务是否运行后重试。`,
      0,
      'NETWORK_ERROR',
      { url, cause: cause instanceof Error ? cause.message : String(cause) },
    );
  }

  if (!response.ok) {
    const code = response.status === 404 ? 'TASK_NOT_FOUND' : undefined;
    let message = `任务请求失败（HTTP ${response.status}）：${path}`;
    let details: Record<string, unknown> | undefined;
    try {
      const body = (await response.json()) as ErrorBody;
      if (body?.error) {
        message = body.error.message ?? message;
        details = body.error.details;
        throw new TaskApiError(message, response.status, body.error.code ?? code, details);
      }
    } catch (error) {
      if (error instanceof TaskApiError) throw error;
      // 响应体不是预期 JSON：落到下面的兜底错误。
    }
    throw new TaskApiError(message, response.status, code, details);
  }

  try {
    return (await response.json()) as T;
  } catch (cause) {
    throw new TaskApiError(
      `任务响应解析失败（${path}）：返回内容不是有效 JSON。`,
      response.status,
      'INVALID_RESPONSE',
      { url, cause: cause instanceof Error ? cause.message : String(cause) },
    );
  }
}

/** POST /api/tasks —— 创建待启动的 Goal 或 Dynamic Workflow 任务。 */
export function createTask(input: CreateTaskInput): Promise<Task> {
  const threadId = input.threadId?.trim();
  const objective = input.objective?.trim();
  const acceptanceCriteria = input.acceptanceCriteria.map((item) => item.trim()).filter(Boolean);
  if (!threadId || !objective) {
    return Promise.reject(new TaskApiError('关联会话和目标不能为空', 400, 'TASK_REQUEST_INVALID'));
  }
  return requestJson<{ task: Task }>('/tasks', {
    method: 'POST',
    body: JSON.stringify({
      threadId,
      objective,
      acceptanceCriteria,
      ...(input.entryMode ? { entryMode: input.entryMode } : {}),
    }),
  }).then((data) => {
    if (!data.task) throw new TaskApiError('创建任务响应缺少任务对象', 500, 'TASK_INTERNAL_ERROR');
    return data.task;
  });
}

/** GET /api/tasks?threadId=&status= —— 任务列表。 */
export function fetchTasks(query?: TaskListQuery): Promise<TaskListResult> {
  return requestJson<TaskListResult>(`/tasks${buildListQuery(query)}`);
}

/** GET /api/tasks/:id —— 任务详情。 */
export function fetchTask(taskId: string): Promise<TaskDetailResult> {
  return requestJson<TaskDetailResult>(`/tasks/${encodeURIComponent(taskId)}`);
}

/** GET /api/tasks/:id/runs —— 任务的 Run 历史。 */
export function fetchTaskRuns(taskId: string): Promise<TaskRunsResult> {
  return requestJson<TaskRunsResult>(`/tasks/${encodeURIComponent(taskId)}/runs`);
}

/** GET /api/tasks/:id/plan-history —— 计划版本投影。 */
export function fetchTaskPlanHistory(taskId: string): Promise<TaskPlanHistoryResult> {
  return requestJson<TaskPlanHistoryResult>(`/tasks/${encodeURIComponent(taskId)}/plan-history`);
}

/** GET /api/tasks/:id/evidence —— 证据 id 原文。 */
export function fetchTaskEvidence(taskId: string): Promise<TaskEvidenceResult> {
  return requestJson<TaskEvidenceResult>(`/tasks/${encodeURIComponent(taskId)}/evidence`);
}

/** GET /api/tasks/:id/goal-status —— 最近一次 GoalEvaluation 摘要（P3 §13.1）。 */
export function fetchTaskGoalStatus(taskId: string): Promise<TaskGoalStatusResponse> {
  return requestJson<TaskGoalStatusResponse>(`/tasks/${encodeURIComponent(taskId)}/goal-status`);
}

/** 发起一个生命周期 POST 操作；action 无 body（start/pause/resume/cancel/retry）。 */
async function postTaskAction(taskId: string, action: TaskActionKind, body?: Record<string, string>): Promise<TaskActionResult> {
  return requestJson<TaskActionResult>(
    `/tasks/${encodeURIComponent(taskId)}/${action}`,
    body ? { method: 'POST', body: JSON.stringify(body) } : { method: 'POST' },
  );
}

/** POST /api/tasks/:id/start —— 启动（Task pending 且无 currentRun）。 */
export function startTask(taskId: string): Promise<TaskActionResult> {
  return postTaskAction(taskId, 'start');
}

/** POST /api/tasks/:id/pause —— 暂停（currentRun running）。 */
export function pauseTask(taskId: string): Promise<TaskActionResult> {
  return postTaskAction(taskId, 'pause');
}

/** POST /api/tasks/:id/resume —— 继续（currentRun paused/interrupted）。 */
export function resumeTask(taskId: string): Promise<TaskActionResult> {
  return postTaskAction(taskId, 'resume');
}

/** POST /api/tasks/:id/cancel —— 取消（currentRun 非终态）。 */
export function cancelTask(taskId: string): Promise<TaskActionResult> {
  return postTaskAction(taskId, 'cancel');
}

/** POST /api/tasks/:id/retry —— 重试（Task 非终态且 currentRun 终态）。 */
export function retryTask(taskId: string): Promise<TaskActionResult> {
  return postTaskAction(taskId, 'retry');
}

/** POST /api/tasks/:id/redirect —— 转向（currentRun running/paused），body { instruction } 非空。 */
export function redirectTask(taskId: string, instruction: string): Promise<TaskActionResult> {
  return postTaskAction(taskId, 'redirect', { instruction });
}

/** POST /api/tasks/:id/input —— 提交回答（Task blocked 且有 pendingInput），body { answer }。 */
export function submitTaskInput(taskId: string, answer: string): Promise<TaskActionResult> {
  return postTaskAction(taskId, 'input', { answer });
}
