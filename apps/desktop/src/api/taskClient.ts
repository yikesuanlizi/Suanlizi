// 任务中心 API 客户端（P1 只读）：封装 /api/tasks 查询族，类型复用 @suanlizi/protocol。
// — English: read-only task-center client for P1; wraps the /api/tasks query surface and reuses
//   the @suanlizi/protocol Task / TaskRun / TaskPlanVersion types.
//
// 访问方式确认：desktop 端与 web 端一致，走相对路径 `fetch('/api/...')`（同源，由 Electron
// 主进程 / Vite 代理到本地 API），与 knowledgeClient / threadConfigClient / OpsTaskInspector 完全同构。
// desktopBridge / IPC 只承载 Electron 原生能力（打开文件、浏览器 tab、系统目录），不承载 HTTP 业务
// API，因此这里不得改用 bridge，也不得绕过相对路径拼绝对地址。
import {
  isTaskStatus,
  type Task,
  type TaskGoalStatusResponse,
  type TaskRun,
  type TaskPlanVersion,
  type TaskOrigin,
  type TaskStatus,
} from '@suanlizi/protocol';

// GET /api/tasks 查询过滤条件：threadId 精确匹配会话，status 为允许的目标层状态集合。
export interface TaskListFilter {
  threadId?: string;
  status?: TaskStatus[];
  /** Goal Center 固定传 explicit_goal；内部影子记录不能进入 UI。 */
  origin?: TaskOrigin[];
}

/** POST /api/tasks —— 创建一个待启动的 Goal 或 Dynamic Workflow 任务。 */
export interface CreateTaskInput {
  threadId: string;
  objective: string;
  acceptanceCriteria: string[];
  /** 用户入口模式；不暴露 protocol 内部 origin。 */
  entryMode?: 'goal' | 'workflow';
}

// 计划投影历史响应（对齐 apps/api/src/routes/taskRoute.ts 的 TaskPlanHistoryResponse）。
export interface TaskPlanHistory {
  taskId: string;
  versions: TaskPlanVersion[];
  latestPlan: TaskPlanVersion | null;
  runIds: string[];
  historyIncomplete: boolean;
}

// 任务请求错误：携带服务端稳定 code，便于 UI 给出可操作提示而非泛化失败。
export class TaskRequestError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: Record<string, unknown>;

  constructor(message: string, options: { status: number; code: string; details?: Record<string, unknown> }) {
    super(message);
    this.name = 'TaskRequestError';
    this.status = options.status;
    this.code = options.code;
    this.details = options.details;
  }
}

// 统一读取 JSON 并解析响应体；非 2xx 或后端缺失任务时抛出可操作错误。
async function readJson<T>(response: Response, fallbackMessage: string): Promise<T> {
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = (data as { error?: { code?: string; message?: string; details?: Record<string, unknown> } }).error;
    throw new TaskRequestError(
      error?.message ?? `${fallbackMessage}（${describeStatus(response.status, error?.code)}）`,
      {
        status: response.status,
        code: error?.code ?? 'TASK_REQUEST_FAILED',
        details: error?.details,
      },
    );
  }
  return data as T;
}

// 将 HTTP 状态与后端 code 归一为一句可操作的中文说明。
function describeStatus(status: number, code?: string): string {
  if (status === 404 || code === 'TASK_NOT_FOUND') return '任务不存在或已被清理';
  if (status === 400 || code === 'TASK_REQUEST_INVALID') return '查询参数不合法';
  if (status === 409) return '任务状态冲突，请刷新后重试';
  if (status >= 500) return '服务端暂时无法处理任务请求';
  return `请求失败 ${status}`;
}

// 拼接列表查询串：仅附加非空过滤，status 支持逗号分隔多值（与后端 readStatusFilter 对齐）。
function buildListQuery(filter?: TaskListFilter): string {
  const params = new URLSearchParams();
  const threadId = filter?.threadId?.trim();
  if (threadId) params.set('threadId', threadId);
  const statuses = (filter?.status ?? []).filter((value): value is TaskStatus => isTaskStatus(value));
  if (statuses.length > 0) params.set('status', Array.from(new Set(statuses)).join(','));
  const origins = (filter?.origin ?? []).filter((value): value is TaskOrigin => value === 'explicit_goal' || value === 'explicit_workflow' || value === 'harness_shadow');
  if (origins.length > 0) params.set('origin', Array.from(new Set(origins)).join(','));
  const query = params.toString();
  return query ? `?${query}` : '';
}

/** POST /api/tasks —— 创建待启动的 Goal 或 Dynamic Workflow 任务。 */
export async function createTask(input: CreateTaskInput, init?: RequestInit): Promise<Task> {
  const threadId = input.threadId?.trim();
  const objective = input.objective?.trim();
  const acceptanceCriteria = input.acceptanceCriteria.map((item) => item.trim()).filter(Boolean);
  if (!threadId || !objective) {
    throw new TaskRequestError('关联会话和目标不能为空', { status: 400, code: 'TASK_REQUEST_INVALID' });
  }
  const response = await fetch('/api/tasks', {
    ...init,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    body: JSON.stringify({
      threadId,
      objective,
      acceptanceCriteria,
      ...(input.entryMode ? { entryMode: input.entryMode } : {}),
    }),
  });
  const data = await readJson<{ task?: Task }>(response, '创建目标任务失败');
  if (!data.task) throw new TaskRequestError('创建任务响应缺少任务对象', { status: response.status, code: 'TASK_INTERNAL_ERROR' });
  return data.task;
}

// GET /api/tasks —— 返回任务列表（?threadId=&status=）。
export async function listTasks(filter?: TaskListFilter, init?: RequestInit): Promise<Task[]> {
  const response = await fetch(`/api/tasks${buildListQuery(filter)}`, { ...init, method: 'GET' });
  const data = await readJson<{ tasks?: Task[] }>(response, '获取任务列表失败');
  return Array.isArray(data.tasks) ? data.tasks : [];
}

// GET /api/tasks/:id —— 返回单个任务详情。
export async function getTask(taskId: string, init?: RequestInit): Promise<Task> {
  const id = requireId(taskId);
  const response = await fetch(`/api/tasks/${encodeURIComponent(id)}`, { ...init, method: 'GET' });
  const data = await readJson<{ task?: Task }>(response, '获取任务详情失败');
  if (!data.task) {
    throw new TaskRequestError('任务详情响应缺少任务对象', { status: response.status, code: 'TASK_INTERNAL_ERROR' });
  }
  return data.task;
}

// GET /api/tasks/:id/runs —— 返回任务的历史 Run 列表。
export async function listTaskRuns(taskId: string, init?: RequestInit): Promise<TaskRun[]> {
  const id = requireId(taskId);
  const response = await fetch(`/api/tasks/${encodeURIComponent(id)}/runs`, { ...init, method: 'GET' });
  const data = await readJson<{ runs?: TaskRun[] }>(response, '获取任务运行记录失败');
  return Array.isArray(data.runs) ? data.runs : [];
}

// GET /api/tasks/:id/plan-history —— 返回计划版本投影（P0 仅 latestPlan + historyIncomplete 标记）。
export async function getTaskPlanHistory(taskId: string, init?: RequestInit): Promise<TaskPlanHistory> {
  const id = requireId(taskId);
  const response = await fetch(`/api/tasks/${encodeURIComponent(id)}/plan-history`, { ...init, method: 'GET' });
  const data = await readJson<Partial<TaskPlanHistory>>(response, '获取任务计划历史失败');
  return {
    taskId: data.taskId ?? id,
    versions: Array.isArray(data.versions) ? data.versions : [],
    latestPlan: data.latestPlan ?? null,
    runIds: Array.isArray(data.runIds) ? data.runIds : [],
    historyIncomplete: data.historyIncomplete === true,
  };
}

// GET /api/tasks/:id/evidence —— 返回证据 id 原文集合（P0 不做 Evidence 正文聚合）。
export async function listTaskEvidenceIds(taskId: string, init?: RequestInit): Promise<string[]> {
  const id = requireId(taskId);
  const response = await fetch(`/api/tasks/${encodeURIComponent(id)}/evidence`, { ...init, method: 'GET' });
  const data = await readJson<{ evidenceIds?: string[] }>(response, '获取任务证据失败');
  return Array.isArray(data.evidenceIds) ? data.evidenceIds : [];
}

// GET /api/tasks/:id/goal-status —— 最近一次 GoalEvaluation 摘要（P3 §13.1，只读）。
export async function fetchTaskGoalStatus(taskId: string, init?: RequestInit): Promise<TaskGoalStatusResponse> {
  const id = requireId(taskId);
  const response = await fetch(`/api/tasks/${encodeURIComponent(id)}/goal-status`, { ...init, method: 'GET' });
  return readJson<TaskGoalStatusResponse>(response, '获取目标状态失败');
}

// 校验任务 id 非空，避免因空串拼出 /api/tasks/ 这种歧义路由再回来排查。
function requireId(taskId: string): string {
  const id = taskId?.trim();
  if (!id) {
    throw new TaskRequestError('任务 id 为空，无法发起查询', { status: 400, code: 'TASK_REQUEST_INVALID' });
  }
  return id;
}

// P2 生命周期操作（§9.1）：POST /api/tasks/:id/<action>，成功响应 { task, run? }。
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

// 统一 POST：无 body 的端点直接提交，带 body 的（redirect/input）附 JSON。
async function postTaskAction(
  taskId: string,
  action: TaskActionKind,
  body?: Record<string, string>,
  init?: RequestInit,
): Promise<TaskActionResult> {
  const id = requireId(taskId);
  const response = await fetch(`/api/tasks/${encodeURIComponent(id)}/${action}`, {
    ...init,
    method: 'POST',
    ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
  });
  const data = await readJson<Partial<TaskActionResult>>(response, `任务${action}操作失败`);
  if (!data.task) {
    throw new TaskRequestError('操作响应缺少任务对象', { status: response.status, code: 'TASK_INTERNAL_ERROR' });
  }
  return { task: data.task, run: data.run };
}

// POST :id/start —— 启动（Task pending 且无 currentRun）。
export function startTask(taskId: string, init?: RequestInit): Promise<TaskActionResult> {
  return postTaskAction(taskId, 'start', undefined, init);
}

// POST :id/pause —— 暂停（currentRun running）。
export function pauseTask(taskId: string, init?: RequestInit): Promise<TaskActionResult> {
  return postTaskAction(taskId, 'pause', undefined, init);
}

// POST :id/resume —— 继续（currentRun paused/interrupted）。
export function resumeTask(taskId: string, init?: RequestInit): Promise<TaskActionResult> {
  return postTaskAction(taskId, 'resume', undefined, init);
}

// POST :id/cancel —— 取消（currentRun 非终态）。
export function cancelTask(taskId: string, init?: RequestInit): Promise<TaskActionResult> {
  return postTaskAction(taskId, 'cancel', undefined, init);
}

// POST :id/retry —— 重试（Task 非终态且 currentRun 终态）。
export function retryTask(taskId: string, init?: RequestInit): Promise<TaskActionResult> {
  return postTaskAction(taskId, 'retry', undefined, init);
}

// POST :id/redirect —— 转向（currentRun running/paused），body { instruction } 非空。
export function redirectTask(taskId: string, instruction: string, init?: RequestInit): Promise<TaskActionResult> {
  return postTaskAction(taskId, 'redirect', { instruction }, init);
}

// POST :id/input —— 提交回答（Task blocked 且有 pendingInput），body { answer }。
export function submitTaskInput(taskId: string, answer: string, init?: RequestInit): Promise<TaskActionResult> {
  return postTaskAction(taskId, 'input', { answer }, init);
}
