// Workflow 脚本 Route（P4b）：脚本静态校验、批准后启动受限脚本运行、
// 运行结果 / AgentCall 查询与按 runId 取消。
//
// 路由约定（与 taskRoute 一致）：
//   POST   /api/tasks/:taskId/workflows/validate    静态校验 + meta 提取（批准界面展示）
//   POST   /api/tasks/:taskId/workflows/runs        批准后启动（立即返回 runId，后台执行）
//   GET    /api/workflows/runs/:runId/result        RunRecord + AgentCalls（含终态）
//   GET    /api/workflows/runs/:runId/agent-calls   AgentCall 列表
//   GET    /api/workflows/runs/:runId/evidence      P6：本次 Run 物化的 Evidence 引用列表
//   POST   /api/workflows/runs/:runId/cancel        取消运行中的 run（不存在/已终态 409）
//   POST   /api/tasks/:taskId/workflows/requests    P6：GoalRun 提议 → 落待批准请求（不执行）
//   GET    /api/tasks/:taskId/workflows/requests    P6：待批准请求列表
//   GET    /api/tasks/:taskId/workflows/scripts     P5：历史脚本（已运行脚本去重列表）
//   POST   /api/workflows/runs/:runId/approve       P6：批准待决请求 → 启动执行
//   POST   /api/workflows/runs/:runId/reject        P6：拒绝待决请求 → cancelled
//
// 服务端校验原则（§6.4「不信任客户端」）：
//   - runId / taskRunId / scriptHash / 时间戳全部服务端生成，strict schema 拒收多余字段；
//   - 脚本必须先通过静态校验才能创建 WorkflowRunRecord（WORKFLOW_SCRIPT_INVALID）；
//   - 取消语义由 service 层裁决：已注册的运行中 run 才能 abort，否则 409。
//
// — Chinese: P4b workflow script route (validate / start / result / cancel).

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { URL } from 'node:url';
import { z } from 'zod';
import { TaskError, type WorkflowRuntimeLimits } from '@suanlizi/protocol';
import {
  readJson, RequestBodyTooLargeError, sendJson,
} from '../shared/http.js';
import type {
  WorkflowScriptHistoryEntry,
  WorkflowScriptService,
  WorkflowScriptValidationView,
} from '../services/workflowScriptService.js';

// ─── 错误码 ──────────────────────────────────────────────────────────────────
// protocol 的 TASK_ERROR_CODES 覆盖状态机/存储层语义，本路由扩展「请求不合法」与
// 「服务端内部异常」两个稳定 code（与 taskRoute 扩展策略一致）。

export const WORKFLOW_ROUTE_ERROR_CODES = {
  /** 400 / 405：请求体、查询参数或方法不合法。/ Malformed body, query or method. */
  requestInvalid: 'WORKFLOW_REQUEST_INVALID',
  /** 500：服务端构造或存储层非预期异常。/ Unexpected server/store failure. */
  internal: 'WORKFLOW_INTERNAL_ERROR',
} as const;

export type WorkflowRouteErrorCode =
  | TaskError['code']
  | (typeof WORKFLOW_ROUTE_ERROR_CODES)[keyof typeof WORKFLOW_ROUTE_ERROR_CODES]
  | 'REQUEST_BODY_TOO_LARGE';

export interface WorkflowRouteErrorBody {
  error: {
    code: WorkflowRouteErrorCode;
    message: string;
    details?: Record<string, unknown>;
  };
}

// ─── 请求类型 ────────────────────────────────────────────────────────────────

/** POST /api/tasks/:taskId/workflows/validate 的请求体：仅 script。 */
export const validateWorkflowScriptRequestSchema = z
  .object({
    script: z.string().min(1),
  })
  .strict();

/**
 * POST /api/tasks/:taskId/workflows/runs 的请求体：script 必填，args/limits 可选。
 * limits 只允许显式覆盖六个限额字段，strict 拒收其它字段（runId 等一律服务端生成）。
 */
export const startWorkflowRunRequestSchema = z
  .object({
    script: z.string().min(1),
    args: z.unknown().optional(),
    /** P5：从既有 run 恢复，按稳定 agentCallId 复用已完成调用。 */
    resumeFromRunId: z.string().trim().min(1).optional(),
    limits: z
      .object({
        maxConcurrentAgents: z.number().int().positive().optional(),
        maxAgentsPerRun: z.number().int().positive().optional(),
        maxItemsPerPipeline: z.number().int().positive().optional(),
        maxTotalTokens: z.number().int().nonnegative().optional(),
        maxDurationMs: z.number().int().positive().optional(),
        requireApproval: z.boolean().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

/** P6：POST /api/tasks/:taskId/workflows/requests 的请求体（Goal 组合提议或独立 Dynamic Workflow）。 */
export const proposeWorkflowRunRequestSchema = z
  .object({
    goalRunId: z.string().trim().min(1).optional(),
    objective: z.string().trim().min(1),
    proposedScript: z.string().min(1),
    estimatedAgents: z.number().int().nonnegative().optional(),
    estimatedTokens: z.number().int().nonnegative().optional(),
    limits: z
      .object({
        maxConcurrentAgents: z.number().int().positive().optional(),
        maxAgentsPerRun: z.number().int().positive().optional(),
        maxItemsPerPipeline: z.number().int().positive().optional(),
        maxTotalTokens: z.number().int().nonnegative().optional(),
        maxDurationMs: z.number().int().positive().optional(),
        requireApproval: z.boolean().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

/** P6：POST /api/workflows/runs/:runId/reject 的请求体（reason 可选，允许空 body）。 */
export const rejectWorkflowRunRequestSchema = z
  .object({
    reason: z.string().trim().min(1).optional(),
  })
  .strict();

/**
 * P6/§14.10：POST /api/workflows/runs/:runId/approve 的请求体。
 * `script` 为编辑后脚本（可选）；服务端会重新做静态校验，不合法则 400 且请求保持 blocked。
 */
export const approveWorkflowRunRequestSchema = z
  .object({
    script: z.string().min(1).optional(),
  })
  .strict();

// ─── 响应类型 ────────────────────────────────────────────────────────────────

export interface WorkflowScriptValidationResponse {
  taskId: string;
  validation: WorkflowScriptValidationView;
}

/** GET /api/tasks/:taskId/workflows/scripts 的响应（P5 历史脚本）。 */
export interface WorkflowScriptsResponse {
  taskId: string;
  scripts: WorkflowScriptHistoryEntry[];
}

export interface StartWorkflowRunResponse {
  runId: string;
  taskRunId: string;
  status: 'running';
}

export interface WorkflowRunResultResponse {
  run: {
    id: string;
    taskRunId: string;
    scriptHash: string;
    args?: unknown;
    status: string;
    usage: { inputTokens: number; outputTokens: number; agentCallCount: number; durationMs: number };
    startedAt: string;
    updatedAt: string;
    completedAt?: string;
    /** P6：GoalRun 来源、run 级证据 id 与脚本终态结果（缺省表示手动发起 / 尚未物化 / 无返回）。 */
    goalRunId?: string;
    evidenceId?: string;
    result?: unknown;
  };
  agentCalls: Array<{
    id: string;
    label?: string;
    prompt: string;
    model?: string;
    status: string;
    result?: unknown;
    error?: string;
    inputTokens: number;
    outputTokens: number;
    startedAt?: string;
    completedAt?: string;
  }>;
}

// ─── 路由入口 ────────────────────────────────────────────────────────────────

export interface WorkflowScriptRouteOptions {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  segments: string[];
  service: WorkflowScriptService;
}

/** 返回 true 表示请求已被本路由消费（server.ts 装配点以此判断是否继续向后匹配）。 */
export async function handleWorkflowScriptRoute(options: WorkflowScriptRouteOptions): Promise<boolean> {
  const { req, res, url, segments, service } = options;
  const method = (req.method ?? 'GET').toUpperCase();

  try {
    // /api/tasks/:taskId/workflows/validate | /runs
    if (segments[0] === 'api' && segments[1] === 'tasks' && segments[3] === 'workflows' && segments.length === 5) {
      const taskId = decodeURIComponent(segments[2]);
      if (!taskId) {
        sendWorkflowError(res, 404, 'TASK_NOT_FOUND', 'empty task id', { path: url.pathname });
        return true;
      }
      const action = segments[4];
      if (action === 'validate' && method === 'POST') {
        await respondValidate(req, res, taskId, service);
        return true;
      }
      if (action === 'runs' && method === 'POST') {
        await respondStartRun(req, res, taskId, service);
        return true;
      }
      if (action === 'requests' && method === 'POST') {
        await respondProposeRun(req, res, taskId, service);
        return true;
      }
      if (action === 'requests' && method === 'GET') {
        const requests = await service.listRequests(taskId);
        sendJson(res, 200, { taskId, requests });
        return true;
      }
      if (action === 'scripts' && method === 'GET') {
        const scripts = await service.listScripts(taskId);
        sendJson(res, 200, { taskId, scripts } satisfies WorkflowScriptsResponse);
        return true;
      }
      sendMethodNotAllowed(res, method, url.pathname);
      return true;
    }

    // /api/workflows/runs/:runId[/result|/agent-calls|/cancel]
    if (segments[0] === 'api' && segments[1] === 'workflows' && segments[2] === 'runs' && segments.length >= 4 && segments.length <= 5) {
      const runId = decodeURIComponent(segments[3]);
      if (!runId) {
        sendWorkflowError(res, 404, 'WORKFLOW_RUN_NOT_FOUND', 'empty workflow run id', { path: url.pathname });
        return true;
      }
      if (segments.length === 5 && segments[4] === 'result' && method === 'GET') {
        await respondResult(res, runId, service);
        return true;
      }
      if (segments.length === 5 && segments[4] === 'agent-calls' && method === 'GET') {
        await respondAgentCalls(res, runId, service);
        return true;
      }
      if (segments.length === 5 && segments[4] === 'evidence' && method === 'GET') {
        const evidence = await service.getEvidence(runId);
        if (!evidence) {
          sendWorkflowError(res, 404, 'WORKFLOW_RUN_NOT_FOUND', `Workflow run ${runId} was not found`, { runId });
          return true;
        }
        sendJson(res, 200, evidence);
        return true;
      }
      if (segments.length === 5 && segments[4] === 'cancel' && method === 'POST') {
        await respondCancel(res, runId, service, url.pathname);
        return true;
      }
      if (segments.length === 5 && segments[4] === 'approve' && method === 'POST') {
        // 空 body 合法（批准原提案）；带 body 时只能是 { script }（§14.10 编辑后批准）。
        const raw = await readJson(req).catch((error: unknown) => {
          if (error instanceof RequestBodyTooLargeError) throw error;
          return {};
        });
        const body = approveWorkflowRunRequestSchema.parse(raw);
        const decided = await service.approveRun(runId, body.script ? { script: body.script } : {});
        sendJson(res, 202, decided);
        return true;
      }
      if (segments.length === 5 && segments[4] === 'reject' && method === 'POST') {
        const raw = await readJson(req).catch((error: unknown) => {
          if (error instanceof RequestBodyTooLargeError) throw error;
          return {};
        });
        const body = rejectWorkflowRunRequestSchema.parse(raw);
        const decided = await service.rejectRun(runId, body.reason);
        sendJson(res, 200, decided);
        return true;
      }
      sendMethodNotAllowed(res, method, url.pathname);
      return true;
    }

    return false;
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      sendWorkflowError(res, 413, 'REQUEST_BODY_TOO_LARGE', error.message);
      return true;
    }
    sendWorkflowFailure(res, error);
    return true;
  }
}

// ─── 处理器 ──────────────────────────────────────────────────────────────────

async function respondValidate(
  req: IncomingMessage,
  res: ServerResponse,
  taskId: string,
  service: WorkflowScriptService,
): Promise<void> {
  const body = validateWorkflowScriptRequestSchema.parse(await readJson(req));
  sendJson(res, 200, {
    taskId,
    validation: await service.validateForTask(taskId, body.script),
  } satisfies WorkflowScriptValidationResponse);
}

async function respondStartRun(
  req: IncomingMessage,
  res: ServerResponse,
  taskId: string,
  service: WorkflowScriptService,
): Promise<void> {
  const body = startWorkflowRunRequestSchema.parse(await readJson(req));
  const started = await service.startRun({
    taskId,
    script: body.script,
    ...(body.args !== undefined ? { args: body.args } : {}),
    ...(body.resumeFromRunId ? { resumeFromRunId: body.resumeFromRunId } : {}),
    ...(body.limits ? { limits: body.limits as Partial<WorkflowRuntimeLimits> } : {}),
  });
  sendJson(res, 202, started satisfies StartWorkflowRunResponse);
}

async function respondProposeRun(
  req: IncomingMessage,
  res: ServerResponse,
  taskId: string,
  service: WorkflowScriptService,
): Promise<void> {
  const body = proposeWorkflowRunRequestSchema.parse(await readJson(req));
  const proposed = await service.proposeRun({
    taskId,
    ...(body.goalRunId ? { goalRunId: body.goalRunId } : {}),
    objective: body.objective,
    proposedScript: body.proposedScript,
    ...(body.estimatedAgents !== undefined ? { estimatedAgents: body.estimatedAgents } : {}),
    ...(body.estimatedTokens !== undefined ? { estimatedTokens: body.estimatedTokens } : {}),
    ...(body.limits ? { limits: body.limits as Partial<WorkflowRuntimeLimits> } : {}),
  });
  sendJson(res, 202, proposed);
}

async function respondResult(res: ServerResponse, runId: string, service: WorkflowScriptService): Promise<void> {
  const view = await service.getResult(runId);
  if (!view) {
    sendWorkflowError(res, 404, 'WORKFLOW_RUN_NOT_FOUND', `Workflow run ${runId} was not found`, { runId });
    return;
  }
  sendJson(res, 200, {
    run: {
      id: view.run.id,
      taskRunId: view.run.taskRunId,
      scriptHash: view.run.scriptHash,
      ...(view.run.args !== undefined ? { args: view.run.args } : {}),
      status: view.run.status,
      usage: view.run.usage,
      startedAt: view.run.startedAt,
      updatedAt: view.run.updatedAt,
      ...(view.run.completedAt !== undefined ? { completedAt: view.run.completedAt } : {}),
      ...(view.run.goalRunId !== undefined ? { goalRunId: view.run.goalRunId } : {}),
      ...(view.run.evidenceId !== undefined ? { evidenceId: view.run.evidenceId } : {}),
      ...(view.run.result !== undefined ? { result: view.run.result } : {}),
    },
    agentCalls: view.agentCalls.map((call) => ({
      id: call.id,
      ...(call.label !== undefined ? { label: call.label } : {}),
      prompt: call.prompt,
      ...(call.model !== undefined ? { model: call.model } : {}),
      status: call.status,
      ...(call.result !== undefined ? { result: call.result } : {}),
      ...(call.error !== undefined ? { error: call.error } : {}),
      inputTokens: call.inputTokens,
      outputTokens: call.outputTokens,
      ...(call.startedAt !== undefined ? { startedAt: call.startedAt } : {}),
      ...(call.completedAt !== undefined ? { completedAt: call.completedAt } : {}),
      ...(call.evidenceId !== undefined ? { evidenceId: call.evidenceId } : {}),
    })),
  } satisfies WorkflowRunResultResponse);
}

async function respondAgentCalls(res: ServerResponse, runId: string, service: WorkflowScriptService): Promise<void> {
  const view = await service.getResult(runId);
  if (!view) {
    sendWorkflowError(res, 404, 'WORKFLOW_RUN_NOT_FOUND', `Workflow run ${runId} was not found`, { runId });
    return;
  }
  sendJson(res, 200, { runId, status: view.run.status, agentCalls: view.agentCalls });
}

async function respondCancel(
  res: ServerResponse,
  runId: string,
  service: WorkflowScriptService,
  path: string,
): Promise<void> {
  const cancelled = await service.cancelRun(runId);
  if (!cancelled) {
    sendWorkflowError(
      res,
      409,
      'WORKFLOW_RUN_NOT_FOUND',
      `Workflow run ${runId} is not running on this server (already finished or unknown)`,
      { runId, path },
    );
    return;
  }
  sendJson(res, 202, { runId, status: 'cancelling' });
}

// ─── 错误出口 ────────────────────────────────────────────────────────────────

function sendMethodNotAllowed(res: ServerResponse, method: string, path: string): void {
  sendWorkflowError(res, 405, WORKFLOW_ROUTE_ERROR_CODES.requestInvalid, `Method ${method} is not allowed on ${path}`, {
    method,
    path,
  });
}

/** 统一异常出口：TaskError 映射稳定 code 与 HTTP 状态，zod 校验失败收敛为 400。 */
function sendWorkflowFailure(res: ServerResponse, error: unknown): void {
  if (error instanceof TaskError) {
    sendWorkflowError(res, taskErrorStatus(error.code), error.code, error.message, error.details);
    return;
  }
  if (error instanceof z.ZodError) {
    const first = error.issues[0];
    sendWorkflowError(res, 400, WORKFLOW_ROUTE_ERROR_CODES.requestInvalid, first?.message ?? 'Invalid request body', {
      issues: error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
    });
    return;
  }
  sendWorkflowError(
    res,
    500,
    WORKFLOW_ROUTE_ERROR_CODES.internal,
    error instanceof Error ? error.message : String(error),
  );
}

function sendWorkflowError(
  res: ServerResponse,
  status: number,
  code: WorkflowRouteErrorCode,
  message: string,
  details?: Record<string, unknown>,
): void {
  sendJson(res, status, {
    error: { code, message, ...(details ? { details } : {}) },
  } satisfies WorkflowRouteErrorBody);
}

function taskErrorStatus(code: TaskError['code']): number {
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
    default:
      return 400;
  }
}
