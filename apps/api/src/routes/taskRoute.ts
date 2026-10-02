// Task Route（P0）：目标任务的基础 CRUD 与查询。
// 对应计划 §6.4 / §13.1 与盘点文档 §2（TaskStorePort 冻结契约）。
//
// 路由约定（与 workflowRoute / harnessRoute / opsRoute 一致）：
//   GET    /api/tasks                      列表（?threadId=&status=pending,running）
//   GET    /api/tasks/:id                  详情
//   POST   /api/tasks                      创建（服务端生成 id / 时间戳 / version=0 / status=pending）
//   GET    /api/tasks/:id/runs             Run 列表
//   GET    /api/tasks/:id/plan-history     计划版本投影（P0 只能给出 task.latestPlan）
//   GET    /api/tasks/:id/evidence         Task 与 WorkflowRun / AgentCall 的证据 id 摘要
//   GET    /api/tasks/:id/goal-status      最近一次 GoalEvaluation 摘要（P3 §13.1，只读）
//   PATCH  /api/tasks/:id/metadata         仅 objective / acceptanceCriteria，带 expectedVersion 乐观锁
//
// P2 才引入的生命周期端点（start / pause / resume / cancel / retry / redirect / input）与
// P3 的 goal-status 已接线（goal-status 依赖注入的 goalStatus 服务，未注入时 500）。
//
// 服务端校验原则（§6.4「不信任客户端」）：
//   - status 没有任何写入入口：create / patch body 一旦出现 status 直接 400。
//   - id、version、createdAt、updatedAt 全部由服务端生成或维护，strict schema 拒收多余字段。
//   - 乐观锁在路由层先校验一次（409 早失败），存储层仍是最终裁决者（updateTask 再抛 TASK_VERSION_CONFLICT）。
//
// — Chinese: P0 task route (basic CRUD + queries). Lifecycle endpoints belong to P2.
//   Everything is validated server-side; status has no write entry point on this route.

import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { URL } from 'node:url';
import { z } from 'zod';
import {
  TaskError,
  isTaskTerminalState,
  taskSchema,
  taskOriginSchema,
  taskStatusSchema,
  validateTaskVersion,
  type GoalEvaluation,
  type Task,
  type TaskListFilter,
  type TaskOrigin,
  type TaskErrorCode,
  type TaskPlanVersion,
  type TaskRun,
  type TaskStatus,
  type TaskStorePort,
  type ThreadEvent,
  type ThreadId,
} from '@suanlizi/protocol';
import { readJson, RequestBodyTooLargeError, sendJson } from '../shared/http.js';
import type { TenantContext } from '../shared/tenant.js';
import {
  createTaskLifecycleService,
  TASK_LIFECYCLE_ACTIONS,
  type TaskHarnessRegistry,
  type TaskLifecycleAction,
  type TaskLifecycleAgent,
  type TaskLifecycleResult,
  type TaskWorkflowIntegration,
} from '../services/taskLifecycleService.js';
import type { TaskGoalStatusService } from '../services/taskGoalStatusService.js';
import { projectTaskSummary } from '../services/taskSummaryProjection.js';

// ─── 错误码 ──────────────────────────────────────────────────────────────────
// protocol 的 TASK_ERROR_CODES 只覆盖状态机/存储层语义，缺少「请求本身不合法」和
// 「服务端内部异常」两类，因此本路由扩展两个稳定 code（不得复用 400 表达迁移冲突）。
// The protocol error-code enum has no "malformed request" / "internal failure" member, so this
// route adds two stable codes; wave 3 may promote them into @suanlizi/protocol.

export const TASK_ROUTE_ERROR_CODES = {
  /** 400 / 405：请求体、查询参数或方法不合法。/ Malformed body, query or method. */
  requestInvalid: 'TASK_REQUEST_INVALID',
  /** 500：服务端构造或存储层非预期异常。/ Unexpected server/store failure. */
  internal: 'TASK_INTERNAL_ERROR',
} as const;

export type TaskRouteErrorCode =
  | TaskErrorCode
  | (typeof TASK_ROUTE_ERROR_CODES)[keyof typeof TASK_ROUTE_ERROR_CODES]
  // shared/http 的体积上限错误码，原样透传以保持 code 字段稳定。
  | 'REQUEST_BODY_TOO_LARGE';

export interface TaskRouteErrorBody {
  error: {
    code: TaskRouteErrorCode;
    message: string;
    details?: Record<string, unknown>;
  };
}

// ─── 请求类型 ────────────────────────────────────────────────────────────────

const idField = z.string().trim().min(1);
const criteriaField = z.array(z.string().trim().min(1));

/**
 * POST /api/tasks 的请求体。strict：多余字段（含 id / version / createdAt / status）一律拒绝。
 * acceptanceCriteria 必须存在且每条为非空字符串；允许空数组（与 protocol taskSchema 一致），
 * 是否可验收由 P3 的证据硬校验裁决。
 */
export const createTaskRequestSchema = z
  .object({
    threadId: idField,
    objective: z.string().trim().min(1),
    acceptanceCriteria: criteriaField,
    /** 用户入口，不直接暴露不可变的 protocol origin。 */
    entryMode: z.enum(['goal', 'workflow']).optional(),
  })
  .strict();

/**
 * PATCH /api/tasks/:id/metadata 的请求体。仅 objective / acceptanceCriteria 两个可编辑字段，
 * 必须带 expectedVersion；其它字段（含 status）一律拒绝。
 */
export const updateTaskMetadataRequestSchema = z
  .object({
    objective: z.string().trim().min(1).optional(),
    acceptanceCriteria: criteriaField.optional(),
    expectedVersion: z.number().int().nonnegative(),
  })
  .strict();

// ─── 生命周期请求体（§9.1）──────────────────────────────────────────────────
// 均为 strict：多余字段（含 status / id / version）一律 400。可选 reason 供事件携带。
// start / resume / retry 无业务入参，只允许可选 reason。

const lifecycleReason = z.object({ reason: z.string().trim().min(1).optional() }).strict();

/** POST :id/start | :id/resume | :id/retry —— 无业务入参，仅可选 reason。 */
export const lifecycleStartRequestSchema = lifecycleReason;
/** POST :id/pause | :id/cancel —— 仅可选 reason。 */
export const lifecycleReasonRequestSchema = lifecycleReason;
/** POST :id/redirect —— instruction 必填非空。 */
export const lifecycleRedirectRequestSchema = z
  .object({
    instruction: z.string().trim().min(1),
    reason: z.string().trim().min(1).optional(),
  })
  .strict();
/** POST :id/input —— answer 必填非空。 */
export const lifecycleInputRequestSchema = z
  .object({
    answer: z.string().trim().min(1),
    reason: z.string().trim().min(1).optional(),
  })
  .strict();

// ─── 响应类型 ────────────────────────────────────────────────────────────────

export interface TaskListResponse {
  tasks: Task[];
}

export interface TaskDetailResponse {
  task: Task;
}

export interface TaskCreateResponse {
  task: Task;
}

export interface TaskRunsResponse {
  taskId: string;
  runs: TaskRun[];
}

export interface TaskPlanHistoryResponse {
  taskId: string;
  /** 已知计划版本，按 version 升序；P0 最多一条（task.latestPlan）。 */
  versions: TaskPlanVersion[];
  latestPlan: TaskPlanVersion | null;
  /** task_runs 关联键：P3 计划版本落库后按 run 关联历史，不在 P0 伪造版本条目。 */
  runIds: string[];
  /** task_plan_versions 表属 P3；此处显式声明历史不完整，供 UI 决定是否提示。 */
  historyIncomplete: boolean;
}

export interface TaskEvidenceResponse {
  taskId: string;
  evidenceIds: string[];
}

/** 生命周期端点成功响应：{ task, run? }（run 为 null 时省略，对齐 §9.1）。 */
export interface TaskLifecycleResponse {
  task: Task;
  run?: TaskRun;
}

// ─── handler 选项 ────────────────────────────────────────────────────────────

export interface TaskRouteOptions {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  segments: string[];
  /** TaskStorePort 由调用方按租户注入（SQLite / WAL 为单一事实来源，计划 §6.2）。 */
  taskStore: TaskStorePort;
  /**
   * P0 不读取：租户隔离由注入的 taskStore 实例承担；保留参数以对齐其它路由的装配签名，
   * P2 生命周期端点在此做权限与配额校验。
   * / Unused in P0; kept for assembly symmetry and P2 authorization.
   */
  tenantContext: TenantContext;
  /** 可注入时钟与 id 生成器，便于测试确定性；默认 Date.now + randomUUID。 */
  now?: () => Date;
  idFactory?: () => string;
  /**
   * P2 生命周期端点依赖（计划 §9.1 / §14.3）：均由 server.ts 按租户装配注入。
   * 未注入时生命周期端点返回 500 TASK_INTERNAL_ERROR（视为未接线），CRUD / 查询不受影响。
   * / Lifecycle deps; absent wiring yields 500 TASK_INTERNAL_ERROR on those endpoints only.
   */
  getAgent?: (threadId?: ThreadId) => Promise<TaskLifecycleAgent>;
  publishEvent?: (event: ThreadEvent) => void;
  registry?: TaskHarnessRegistry;
  /** P6：Goal × Workflow 组合集成（提案转发 + 证据预载），由 server.ts 装配注入。 */
  workflow?: TaskWorkflowIntegration;
  /** P3 §13.1：goal-status 读取服务（最近一次 GoalEvaluation 摘要）；未注入时该端点 500。 */
  goalStatus?: TaskGoalStatusService;
  /** 计划 §13.1：GoalRun 收口时发 task.goal.evaluation.available 的读接口（通常由 goalStatus 服务提供）。 */
  readGoalEvaluation?: (params: { taskId: string; runId: string }) => Promise<GoalEvaluation | null>;
}

// ─── 主入口 ──────────────────────────────────────────────────────────────────

/**
 * 返回 true 表示本路由已接管该请求（含错误响应）；false 表示路径不属于 /api/tasks。
 */
export async function handleTaskRoute(options: TaskRouteOptions): Promise<boolean> {
  const { req, res, url, segments, taskStore } = options;
  if (segments[0] !== 'api' || segments[1] !== 'tasks') return false;

  const method = (req.method ?? 'GET').toUpperCase();

  try {
    // /api/tasks
    if (segments.length === 2) {
      if (method === 'GET') {
        await respondTaskList(res, url, taskStore);
        return true;
      }
      if (method === 'POST') {
        await respondTaskCreate(req, res, taskStore, options);
        return true;
      }
      sendMethodNotAllowed(res, method, url.pathname);
      return true;
    }

    // /api/tasks/:id
    if (segments.length === 3) {
      const taskId = decodeURIComponent(segments[2]);
      if (!taskId) {
        sendTaskNotFound(res, url.pathname, 'empty task id');
        return true;
      }
      if (method === 'GET') {
        const task = await taskStore.getTask(taskId);
        if (!task) {
          sendTaskError(res, 404, 'TASK_NOT_FOUND', `Task ${taskId} was not found`, { taskId });
          return true;
        }
        sendJson(res, 200, { task: await projectTaskSummary(task, taskStore) } satisfies TaskDetailResponse);
        return true;
      }
      sendMethodNotAllowed(res, method, url.pathname);
      return true;
    }

    // /api/tasks/:id/<sub>
    const taskId = decodeURIComponent(segments[2]);
    const sub = segments[3];
    if (!taskId || !sub) {
      sendTaskNotFound(res, url.pathname, 'incomplete task path');
      return true;
    }

    if (segments.length === 4) {
      switch (sub) {
        case 'runs':
          if (method !== 'GET') {
            sendMethodNotAllowed(res, method, url.pathname);
            return true;
          }
          await respondTaskRuns(res, taskId, taskStore);
          return true;
        case 'plan-history':
          if (method !== 'GET') {
            sendMethodNotAllowed(res, method, url.pathname);
            return true;
          }
          await respondTaskPlanHistory(res, taskId, taskStore);
          return true;
        case 'evidence':
          if (method !== 'GET') {
            sendMethodNotAllowed(res, method, url.pathname);
            return true;
          }
          await respondTaskEvidence(res, taskId, taskStore);
          return true;
        case 'goal-status':
          // P3 §13.1：最近一次 GoalEvaluation 摘要（只读 harnessState tags + task 表）。
          if (method !== 'GET') {
            sendMethodNotAllowed(res, method, url.pathname);
            return true;
          }
          if (!options.goalStatus) {
            sendTaskError(
              res,
              500,
              TASK_ROUTE_ERROR_CODES.internal,
              'goal-status is not wired on this server',
              { taskId, action: 'goal-status' },
            );
            return true;
          }
          await respondGoalStatus(res, taskId, options);
          return true;
        case 'metadata':
          if (method !== 'PATCH') {
            sendMethodNotAllowed(res, method, url.pathname);
            return true;
          }
          await respondTaskMetadata(req, res, taskId, taskStore, options);
          return true;
        default: {
          // P2 生命周期端点（start/pause/resume/cancel/retry/redirect/input）：命中则接管，
          // 否则退回未知段 404。
          if (isLifecycleAction(sub)) {
            await respondTaskLifecycle(req, res, url, method, sub, taskId, taskStore, options);
            return true;
          }
          sendTaskNotFound(res, url.pathname, `unknown task sub-route "${sub}"`, { taskId, segment: sub });
          return true;
        }
      }
    }

    // /api/tasks/:id/<sub>/<extra...> —— P0 无更深路由。
    sendTaskNotFound(res, url.pathname, 'unknown task path', { taskId, segment: sub });
    return true;
  } catch (error) {
    sendTaskFailure(res, error);
    return true;
  }
}

// ─── GET /api/tasks ──────────────────────────────────────────────────────────

async function respondTaskList(res: ServerResponse, url: URL, taskStore: TaskStorePort): Promise<void> {
  const threadId = readThreadIdFilter(url);
  const statusFilter = readStatusFilter(url);
  if (statusFilter.invalid !== undefined) {
    sendTaskError(
      res,
      400,
      TASK_ROUTE_ERROR_CODES.requestInvalid,
      `Invalid status filter "${statusFilter.invalid}". Allowed values: pending, running, blocked, completed, failed, cancelled.`,
      { field: 'status', received: statusFilter.invalid },
    );
    return;
  }
  const originFilter = readOriginFilter(url);
  if (originFilter.invalid !== undefined) {
    sendTaskError(
      res,
      400,
      TASK_ROUTE_ERROR_CODES.requestInvalid,
      `Invalid origin filter "${originFilter.invalid}". Allowed values: explicit_goal, explicit_workflow, harness_shadow.`,
      { field: 'origin', received: originFilter.invalid },
    );
    return;
  }
  const filter: TaskListFilter = {};
  if (threadId) filter.threadId = threadId;
  if (statusFilter.statuses?.length) filter.status = statusFilter.statuses;
  if (originFilter.origins?.length) filter.origin = originFilter.origins;
  const tasks = await taskStore.listTasks(Object.keys(filter).length ? filter : undefined);
  const projectedTasks = await Promise.all(tasks.map((task) => projectTaskSummary(task, taskStore)));
  sendJson(res, 200, { tasks: projectedTasks } satisfies TaskListResponse);
}

function readThreadIdFilter(url: URL): string | undefined {
  const raw = url.searchParams.get('threadId');
  if (raw === null) return undefined;
  const value = raw.trim();
  return value ? value : undefined;
}

function readStatusFilter(url: URL): { statuses?: TaskStatus[]; invalid?: string } {
  const tokens = url.searchParams
    .getAll('status')
    .flatMap((value) => value.split(','))
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  if (!tokens.length) return {};
  const statuses: TaskStatus[] = [];
  for (const token of tokens) {
    const parsed = taskStatusSchema.safeParse(token);
    if (!parsed.success) return { invalid: token };
    if (!statuses.includes(parsed.data)) statuses.push(parsed.data);
  }
  return { statuses };
}

/** `origin` 是服务端筛选边界：Goal Center 只请求 explicit_goal，影子记录永不混入。 */
function readOriginFilter(url: URL): { origins?: TaskOrigin[]; invalid?: string } {
  const tokens = url.searchParams
    .getAll('origin')
    .flatMap((value) => value.split(','))
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  if (!tokens.length) return {};
  const origins: TaskOrigin[] = [];
  for (const token of tokens) {
    const parsed = taskOriginSchema.safeParse(token);
    if (!parsed.success) return { invalid: token };
    if (!origins.includes(parsed.data)) origins.push(parsed.data);
  }
  return { origins };
}

// ─── POST /api/tasks ─────────────────────────────────────────────────────────

async function respondTaskCreate(
  req: IncomingMessage,
  res: ServerResponse,
  taskStore: TaskStorePort,
  options: TaskRouteOptions,
): Promise<void> {
  const raw = await readRequestBody(res, req);
  if (raw === undefined) return;

  if (typeof raw === 'object' && raw !== null && 'status' in (raw as Record<string, unknown>)) {
    sendStatusFieldRejected(res, 'POST /api/tasks');
    return;
  }
  const parsed = createTaskRequestSchema.safeParse(raw);
  if (!parsed.success) {
    sendZodFailure(res, parsed.error, 'POST /api/tasks request');
    return;
  }
  const { threadId, objective, acceptanceCriteria, entryMode } = parsed.data;

  // 一个 thread 同一时刻最多一个非终态显式用户入口任务（Goal 或 Dynamic Workflow）；
  // 普通 Harness 影子记录不参与。这样同一上下文不会被两个自主运行相互污染。
  const existing = await taskStore.listTasks({ threadId, origin: ['explicit_goal', 'explicit_workflow'] });
  const active = existing.find((task) => !isTaskTerminalState(task.status));
  if (active) {
    sendTaskError(res, 409, 'TASK_ACTIVE_EXISTS', `Thread ${threadId} already has an active task`, {
      threadId,
      taskId: active.id,
      taskStatus: active.status,
    });
    return;
  }

  const nowIso = (options.now?.() ?? new Date()).toISOString();
  const candidate: Task = {
    id: options.idFactory?.() ?? `task_${randomUUID()}`,
    threadId,
    objective,
    acceptanceCriteria,
    // status 由服务端固定为 pending，客户端无写入入口。
    status: 'pending',
    runIds: [],
    evidenceIds: [],
    createdAt: nowIso,
    updatedAt: nowIso,
    version: 0,
    // 计划 §14.11：第一版行为恒为 supervised，不接受客户端放宽。
    interactionMode: 'supervised',
    // 只有此端点创建用户明确要求的 Goal / Dynamic Workflow，客户端不能伪造 protocol origin。
    origin: entryMode === 'workflow' ? 'explicit_workflow' : 'explicit_goal',
  };
  // 双保险：服务端构造结果必须满足 protocol 的 taskSchema，避免路由与契约漂移。
  const validated = taskSchema.safeParse(candidate);
  if (!validated.success) {
    sendTaskError(
      res,
      500,
      TASK_ROUTE_ERROR_CODES.internal,
      'Server-constructed task failed protocol validation',
      { issues: validated.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`) },
    );
    return;
  }

  const created = await taskStore.createTask(validated.data);
  sendJson(res, 201, { task: created } satisfies TaskCreateResponse);
}

// ─── GET /api/tasks/:id/runs ─────────────────────────────────────────────────

async function respondTaskRuns(res: ServerResponse, taskId: string, taskStore: TaskStorePort): Promise<void> {
  const task = await requireTask(res, taskId, taskStore);
  if (!task) return;
  const runs = await taskStore.listRuns(task.id);
  sendJson(res, 200, { taskId: task.id, runs } satisfies TaskRunsResponse);
}

// ─── GET /api/tasks/:id/plan-history ─────────────────────────────────────────

/**
 * P0 真实数据面：计划版本历史表（task_plan_versions）属 §6.3 / P3，尚未落地。
 * 这里只返回 task.latestPlan 这一个已存在版本，并带上 runIds 作为将来的关联键；
 * 无数据时返回 versions: []，绝不合成占位版本。
 */
async function respondTaskPlanHistory(
  res: ServerResponse,
  taskId: string,
  taskStore: TaskStorePort,
): Promise<void> {
  const task = await requireTask(res, taskId, taskStore);
  if (!task) return;
  const runs = await taskStore.listRuns(task.id);
  const versions: TaskPlanVersion[] = task.latestPlan ? [task.latestPlan] : [];
  sendJson(res, 200, {
    taskId: task.id,
    versions,
    latestPlan: task.latestPlan ?? null,
    runIds: runs.map((run) => run.id),
    historyIncomplete: true,
  } satisfies TaskPlanHistoryResponse);
}

// ─── GET /api/tasks/:id/evidence ─────────────────────────────────────────────

/**
 * 汇总 Task 本身以及关联 WorkflowRun / AgentCall 上已经物化的 Evidence id。
 * 只返回持久化引用，不在此拼造 Evidence 正文。
 */
async function respondTaskEvidence(res: ServerResponse, taskId: string, taskStore: TaskStorePort): Promise<void> {
  const task = await requireTask(res, taskId, taskStore);
  if (!task) return;
  const projected = await projectTaskSummary(task, taskStore);
  sendJson(res, 200, {
    taskId: task.id,
    evidenceIds: projected.evidenceIds,
  } satisfies TaskEvidenceResponse);
}

// ─── GET /api/tasks/:id/goal-status ──────────────────────────────────────────

async function respondGoalStatus(res: ServerResponse, taskId: string, options: TaskRouteOptions): Promise<void> {
  const status = await options.goalStatus!.readGoalStatus(taskId);
  sendJson(res, 200, status);
}

// ─── PATCH /api/tasks/:id/metadata ───────────────────────────────────────────

async function respondTaskMetadata(
  req: IncomingMessage,
  res: ServerResponse,
  taskId: string,
  taskStore: TaskStorePort,
  options: TaskRouteOptions,
): Promise<void> {
  const raw = await readRequestBody(res, req);
  if (raw === undefined) return;

  if (typeof raw === 'object' && raw !== null && 'status' in (raw as Record<string, unknown>)) {
    sendStatusFieldRejected(res, 'PATCH /api/tasks/:id/metadata');
    return;
  }
  const parsed = updateTaskMetadataRequestSchema.safeParse(raw);
  if (!parsed.success) {
    sendZodFailure(res, parsed.error, 'PATCH /api/tasks/:id/metadata request');
    return;
  }
  const { objective, acceptanceCriteria, expectedVersion } = parsed.data;
  if (objective === undefined && acceptanceCriteria === undefined) {
    sendTaskError(
      res,
      400,
      TASK_ROUTE_ERROR_CODES.requestInvalid,
      'At least one of "objective" or "acceptanceCriteria" must be provided',
      { fields: ['objective', 'acceptanceCriteria'] },
    );
    return;
  }

  const task = await requireTask(res, taskId, taskStore);
  if (!task) return;

  // 路由层先做乐观锁校验（早失败 + 稳定 409），存储层仍是最终裁决者。
  try {
    validateTaskVersion(task.version, expectedVersion);
  } catch (error) {
    sendTaskFailure(res, error);
    return;
  }

  const patch: Partial<Omit<Task, 'id' | 'createdAt'>> = {
    updatedAt: (options.now?.() ?? new Date()).toISOString(),
  };
  if (objective !== undefined) patch.objective = objective;
  if (acceptanceCriteria !== undefined) patch.acceptanceCriteria = acceptanceCriteria;

  const updated = await taskStore.updateTask(task.id, patch, expectedVersion);
  sendJson(res, 200, { task: updated } satisfies TaskDetailResponse);
}

// ─── P2 生命周期端点（§9.1）───────────────────────────────────────────────────

function isLifecycleAction(sub: string): sub is TaskLifecycleAction {
  return (TASK_LIFECYCLE_ACTIONS as readonly string[]).includes(sub);
}

/**
 * POST /api/tasks/:id/<action>：七个生命周期操作的统一入口。
 * 顺序：方法校验 → 接线检查 → 读体 + zod strict 校验 → 委派 taskLifecycleService →
 * 按 result.httpStatus 返回 { task, run? }。service 抛出的 TaskError 由 handleTaskRoute
 * 外层 try/catch 的 sendTaskFailure 统一映射（非法前置 409 + 稳定 code）。
 */
async function respondTaskLifecycle(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  method: string,
  action: TaskLifecycleAction,
  taskId: string,
  taskStore: TaskStorePort,
  options: TaskRouteOptions,
): Promise<void> {
  if (method !== 'POST') {
    sendMethodNotAllowed(res, method, url.pathname);
    return;
  }
  const { getAgent, publishEvent } = options;
  if (!getAgent || !publishEvent) {
    sendTaskError(
      res,
      500,
      TASK_ROUTE_ERROR_CODES.internal,
      `task lifecycle action "${action}" is not wired on this server`,
      { action, taskId },
    );
    return;
  }

  const raw = await readRequestBody(res, req);
  if (raw === undefined) return;

  let result: TaskLifecycleResult;
  switch (action) {
    case 'start': {
      const parsed = lifecycleStartRequestSchema.safeParse(raw);
      if (!parsed.success) {
        sendZodFailure(res, parsed.error, `POST :id/${action} request`);
        return;
      }
      result = await serviceOf(options, taskStore).start(taskId);
      break;
    }
    case 'resume': {
      const parsed = lifecycleStartRequestSchema.safeParse(raw);
      if (!parsed.success) {
        sendZodFailure(res, parsed.error, `POST :id/${action} request`);
        return;
      }
      result = await serviceOf(options, taskStore).resume(taskId);
      break;
    }
    case 'retry': {
      const parsed = lifecycleStartRequestSchema.safeParse(raw);
      if (!parsed.success) {
        sendZodFailure(res, parsed.error, `POST :id/${action} request`);
        return;
      }
      result = await serviceOf(options, taskStore).retry(taskId);
      break;
    }
    case 'pause': {
      const parsed = lifecycleReasonRequestSchema.safeParse(raw);
      if (!parsed.success) {
        sendZodFailure(res, parsed.error, `POST :id/${action} request`);
        return;
      }
      result = await serviceOf(options, taskStore).pause(taskId, parsed.data);
      break;
    }
    case 'cancel': {
      const parsed = lifecycleReasonRequestSchema.safeParse(raw);
      if (!parsed.success) {
        sendZodFailure(res, parsed.error, `POST :id/${action} request`);
        return;
      }
      result = await serviceOf(options, taskStore).cancel(taskId, parsed.data);
      break;
    }
    case 'redirect': {
      const parsed = lifecycleRedirectRequestSchema.safeParse(raw);
      if (!parsed.success) {
        sendZodFailure(res, parsed.error, `POST :id/${action} request`);
        return;
      }
      result = await serviceOf(options, taskStore).redirect(taskId, parsed.data);
      break;
    }
    case 'input': {
      const parsed = lifecycleInputRequestSchema.safeParse(raw);
      if (!parsed.success) {
        sendZodFailure(res, parsed.error, `POST :id/${action} request`);
        return;
      }
      result = await serviceOf(options, taskStore).input(taskId, parsed.data);
      break;
    }
    default: {
      const exhaustive: never = action;
      throw new Error(`unhandled task lifecycle action: ${String(exhaustive)}`);
    }
  }

  sendJson(
    res,
    result.httpStatus,
    { task: result.task, ...(result.run ? { run: result.run } : {}) } satisfies TaskLifecycleResponse,
  );
}

/** 按请求级注入装配生命周期服务（registry / tenantId / now 透传）。 */
function serviceOf(options: TaskRouteOptions, taskStore: TaskStorePort) {
  return createTaskLifecycleService({
    taskStore,
    getAgent: options.getAgent!,
    publishEvent: options.publishEvent!,
    registry: options.registry,
    tenantId: options.tenantContext.tenantId,
    now: options.now,
    ...(options.workflow ? { workflow: options.workflow } : {}),
    ...(options.readGoalEvaluation ? { readGoalEvaluation: options.readGoalEvaluation } : {}),
  });
}

// ─── 公共辅助 ────────────────────────────────────────────────────────────────

async function requireTask(
  res: ServerResponse,
  taskId: string,
  taskStore: TaskStorePort,
): Promise<Task | null> {
  const task = await taskStore.getTask(taskId);
  if (!task) {
    sendTaskError(res, 404, 'TASK_NOT_FOUND', `Task ${taskId} was not found`, { taskId });
    return null;
  }
  return task;
}

async function readRequestBody(res: ServerResponse, req: IncomingMessage): Promise<unknown | undefined> {
  try {
    return await readJson<unknown>(req);
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      sendJson(res, 413, {
        error: { code: error.code, message: error.message },
      } satisfies TaskRouteErrorBody);
      return undefined;
    }
    sendTaskError(
      res,
      400,
      TASK_ROUTE_ERROR_CODES.requestInvalid,
      `Request body is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
    return undefined;
  }
}

function sendStatusFieldRejected(res: ServerResponse, entry: string): void {
  sendTaskError(
    res,
    400,
    TASK_ROUTE_ERROR_CODES.requestInvalid,
    '"status" cannot be set by the client; it is owned by the server-side task state machine',
    { field: 'status', entry, allowed: false },
  );
}

function sendZodFailure(res: ServerResponse, error: z.ZodError, entry: string): void {
  const issues = error.issues.map((issue) => ({
    field: issue.path.join('.') || '(root)',
    message: issue.message,
    code: issue.code,
  }));
  const first = issues[0];
  sendTaskError(
    res,
    400,
    TASK_ROUTE_ERROR_CODES.requestInvalid,
    `Invalid ${entry}: ${first ? `${first.field} - ${first.message}` : 'request payload rejected'}`,
    { entry, issues },
  );
}

function sendMethodNotAllowed(res: ServerResponse, method: string, path: string): void {
  sendTaskError(
    res,
    405,
    TASK_ROUTE_ERROR_CODES.requestInvalid,
    `Method ${method} is not allowed on ${path}`,
    { method, path },
  );
}

function sendTaskNotFound(
  res: ServerResponse,
  path: string,
  reason: string,
  details?: Record<string, unknown>,
): void {
  sendTaskError(res, 404, 'TASK_NOT_FOUND', `Task route not found: ${reason}`, { path, ...(details ?? {}) });
}

/**
 * 统一异常出口：TaskError 映射稳定 code 与 HTTP 状态，其它异常收敛为 500。
 */
function sendTaskFailure(res: ServerResponse, error: unknown): void {
  if (error instanceof TaskError) {
    sendTaskError(res, taskErrorStatus(error.code), error.code, error.message, error.details);
    return;
  }
  sendTaskError(
    res,
    500,
    TASK_ROUTE_ERROR_CODES.internal,
    error instanceof Error ? error.message : String(error),
  );
}

function sendTaskError(
  res: ServerResponse,
  status: number,
  code: TaskRouteErrorCode,
  message: string,
  details?: Record<string, unknown>,
): void {
  sendJson(res, status, {
    error: { code, message, ...(details ? { details } : {}) },
  } satisfies TaskRouteErrorBody);
}

/** TaskError.code → HTTP 状态；找不到就按客户端错误处理。 */
function taskErrorStatus(code: TaskErrorCode): number {
  switch (code) {
    case 'TASK_NOT_FOUND':
    case 'TASK_RUN_NOT_FOUND':
    case 'WORKFLOW_RUN_NOT_FOUND':
      return 404;
    case 'TASK_VERSION_CONFLICT':
    case 'TASK_ACTIVE_EXISTS':
    case 'TASK_INVALID_TRANSITION':
    case 'TASK_TERMINAL_STATE':
      return 409;
    case 'WORKFLOW_APPROVAL_REQUIRED':
      return 403;
    case 'WORKFLOW_LIMIT_EXCEEDED':
    case 'WORKFLOW_EVIDENCE_MATERIALIZATION_FAILED':
      return 500;
    default:
      return 400;
  }
}
