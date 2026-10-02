// Harness Route：跨 turn 自主循环 API（start / status / cancel）。
// 路由约定（与 workflowRoute 一致）：
//   POST   /api/threads/:id/harness/start    启动 harness run（立即返回 harnessRunId）
//   GET    /api/threads/:id/harness/status    查询 harness 状态（支持 ?runId= 指定）
//   POST   /api/threads/:id/harness/cancel    取消运行中 harness run（支持 ?runId= 指定）
//
// 设计要点：
//   - Gap 1: 调用方预生成 harnessRunId → API 立即返回 202 Accepted
//   - runHarness 在后台进行（通过 HarnessRuntimeRegistry 注册）
//   - status: 优先从 registry 读运行时状态，回退到 GoalTracker.load 读持久化状态
//   - cancel: 先 agent.interrupt(threadId) 再 abortController.abort()（盘点 §4.1 P2 双写），
//     runHarness 会退出循环并落 cancelled 终态，registry 标记为 cancelled
// — Chinese: harness route — start/status/cancel for cross-turn autonomous loops

import type { IncomingMessage, ServerResponse } from 'node:http';
import { URL } from 'node:url';
import type { ThreadStore } from '@suanlizi/storage';
import type { ThreadEvent, ThreadId, TaskStorePort, UserInput } from '@suanlizi/protocol';
import type { AgentLoop, HarnessResult } from '@suanlizi/runtime';
import { GoalTracker } from '@suanlizi/runtime';
import { readJson, sendError, sendJson } from '../shared/http.js';
import type { AgentRunConfig } from '../config/config.js';
import type { TenantContext } from '../shared/tenant.js';
import {
  attachShadowTaskTracking,
  shadowTaskForHarnessStart,
} from '../services/taskShadowWriter.js';
import {
  harnessRuntimeRegistry,
  type HarnessRunEntry,
  type HarnessRuntimeStatus,
} from '../services/harnessRuntime.js';

// ─── harness run ID 生成 ──────────────────────────────────────────────────
// 预生成 ID（Gap 1）：API 先返回，runHarness 后续用同一 ID

export function generateHarnessRunId(): string {
  return `harness_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

// ─── start 路由的请求/响应类型 ────────────────────────────────────────────

export interface HarnessStartRequest {
  input?: string;
  goal?: string;
  acceptanceCriteria?: string[];
  maxContinuations?: number;
  config?: Partial<AgentRunConfig>;
}

export interface HarnessStartResponse {
  ok: true;
  harnessRunId: string;
  threadId: ThreadId;
  status: HarnessRuntimeStatus;
  startedAt: string;
}

// ─── status 路由的响应类型 ─────────────────────────────────────────────────

export interface HarnessStatusResponse {
  threadId: ThreadId;
  harnessRunId: string;
  /** 运行时状态（registry 跟踪）：running / completed / failed / cancelled / unknown */
  runtimeStatus: HarnessRuntimeStatus | 'unknown';
  /** 持久化状态（GoalTracker 从 thread.tags 读取）：active / satisfied / blocked / max_continuations / no_progress / cancelled */
  persistedStatus?: string;
  iteration?: number;
  goal?: string;
  acceptanceCriteria?: string[];
  lastEvaluation?: unknown;
  startedAt?: string;
  updatedAt?: string;
  completedAt?: string;
  /** 终态结果（completed 时填充） */
  result?: HarnessResult;
  error?: string;
}

// ─── cancel 路由的响应类型 ─────────────────────────────────────────────────

export interface HarnessCancelResponse {
  ok: boolean;
  harnessRunId: string;
  runtimeStatus: HarnessRuntimeStatus | 'unknown';
  message?: string;
}

// ─── 主路由分发函数 ───────────────────────────────────────────────────────

/**
 * Harness 路由分发：
 *   segments[0..3] = ['api', 'threads', :id, 'harness']
 *   segments[4] = action（start / status / cancel）
 *
 * 返回 true 表示已处理请求；false 表示不匹配（交由上层继续路由）。
 */
export async function handleHarnessRoute(options: {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  segments: string[];
  store: ThreadStore;
  tenantContext: TenantContext;
  /** 目标任务影子写端口（计划 §14.6）；缺省时不写 task 表。 */
  taskStore?: TaskStorePort;
  createAgent: (config?: Partial<AgentRunConfig>) => Promise<AgentLoop>;
  publishEvent: (event: ThreadEvent) => void;
  getThreadRunConfig: (threadId: string) => Promise<AgentRunConfig>;
}): Promise<boolean> {
  const { req, res, url, segments, store, tenantContext, taskStore, createAgent, publishEvent, getThreadRunConfig } = options;

  // 匹配 /api/threads/:id/harness/...
  const isHarnessPath =
    segments.length >= 5 &&
    segments[0] === 'api' &&
    segments[1] === 'threads' &&
    segments[3] === 'harness';
  if (!isHarnessPath) return false;

  const threadId = segments[2] as ThreadId;
  const action = segments[4];

  // 校验 thread 存在
  const thread = await store.getThread(threadId);
  if (!thread) {
    sendError(res, 404, 'Thread not found');
    return true;
  }

  if (action === 'start' && req.method === 'POST') {
    await handleHarnessStart({ req, res, threadId, store, tenantContext, taskStore, createAgent, publishEvent, getThreadRunConfig });
    return true;
  }

  if (action === 'status' && req.method === 'GET') {
    await handleHarnessStatus({ res, url, threadId, store });
    return true;
  }

  if (action === 'cancel' && req.method === 'POST') {
    await handleHarnessCancel({ res, url, threadId });
    return true;
  }

  return false;
}

// ─── POST /api/threads/:id/harness/start ─────────────────────────────────

async function handleHarnessStart(options: {
  req: IncomingMessage;
  res: ServerResponse;
  threadId: ThreadId;
  store: ThreadStore;
  tenantContext: TenantContext;
  taskStore?: TaskStorePort;
  createAgent: (config?: Partial<AgentRunConfig>) => Promise<AgentLoop>;
  publishEvent: (event: ThreadEvent) => void;
  getThreadRunConfig: (threadId: string) => Promise<AgentRunConfig>;
}): Promise<void> {
  const { req, res, threadId, store, tenantContext, taskStore, createAgent, publishEvent, getThreadRunConfig } = options;
  const body = await readJson<HarnessStartRequest>(req);

  // 校验输入
  const inputText = body.input?.trim();
  if (!inputText && !body.goal) {
    sendError(res, 400, 'Either "input" or "goal" is required');
    return;
  }

  // 互斥检查（Gap 6）：同一 thread 不能同时有两个 active harness run
  if (!(await GoalTracker.canStartNewHarness(store, threadId))) {
    sendError(res, 409, 'Thread already has an active harness run. Cancel or wait for it to finish first.');
    return;
  }

  // 预生成 harnessRunId（Gap 1）
  const harnessRunId = generateHarnessRunId();
  const startedAt = new Date().toISOString();

  // 构造 user input（若仅传 goal，则用 goal 文本作为 input）
  const userInput: UserInput = {
    type: 'text',
    text: inputText ?? body.goal ?? '',
  };

  // 获取线程配置作为 base，body.config 作为本次 run 的临时 overlay（不持久化）
  const threadConfig = await getThreadRunConfig(threadId);
  const runConfig = body.config ? { ...threadConfig, ...body.config } : threadConfig;

  // 预解析配置（先于后台启动，便于早期失败）
  const agent = await createAgent(runConfig);

  // 发布 harness.started 事件（前端可订阅）
  publishEvent({
    type: 'thread.metadata.updated',
    threadId,
    // 通过 metadata 事件携带 harnessRunId 让前端感知启动
  } as ThreadEvent);

  // 在 registry 中注册并启动后台 run
  // — English: register and start background run via registry
  let entry: HarnessRunEntry;
  try {
    entry = harnessRuntimeRegistry.start({
      harnessRunId,
      threadId,
      tenantId: tenantContext.tenantId,
      // P2 取消链双写（计划 §9.2）：cancel 时先 interrupt AgentLoop（落 stopping
      // checkpoint / pendingInterrupts / thread.runtime.updated），再 abort signal。
      // — English: cancel = interrupt + abort; registry invokes this before aborting.
      interrupt: () => {
        agent.interrupt(threadId);
      },
      run: async (signal) => {
        const result = await agent.runHarness(threadId, userInput, {
          goal: body.goal,
          acceptanceCriteria: body.acceptanceCriteria,
          maxContinuations: body.maxContinuations,
          signal,
          harnessRunId,
        });
        // 完成后发布 harness 终态事件（前端可据此刷新 UI）
        publishEvent({
          type: 'thread.metadata.updated',
          threadId,
        } as ThreadEvent);
        return result;
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    sendError(res, 500, `Failed to start harness: ${message}`);
    return;
  }

  // 影子写：自动创建 Task + goal TaskRun，并镜像终态（计划 §14.6；best-effort，失败不影响 run）。
  if (taskStore) {
    const shadow = await shadowTaskForHarnessStart({
      taskStore,
      threadId,
      harnessRunId,
      goal: body.goal,
      input: inputText,
      acceptanceCriteria: body.acceptanceCriteria,
    });
    if (shadow) {
      attachShadowTaskTracking({ taskStore, handle: shadow, entry });
    }
  }

  // 立即返回 202 Accepted + harnessRunId
  const response: HarnessStartResponse = {
    ok: true,
    harnessRunId,
    threadId,
    status: 'running',
    startedAt,
  };
  sendJson(res, 202, response);
}

// ─── GET /api/threads/:id/harness/status ───────────────────────────────────

async function handleHarnessStatus(options: {
  res: ServerResponse;
  url: URL;
  threadId: ThreadId;
  store: ThreadStore;
}): Promise<void> {
  const { res, url, threadId, store } = options;

  // 支持查询参数 ?runId=xxx 指定具体 run；不传则取当前 active run
  const requestedRunId = url.searchParams.get('runId') ?? undefined;

  // 优先从 registry 读运行时条目
  let entry: HarnessRunEntry | undefined;
  if (requestedRunId) {
    entry = harnessRuntimeRegistry.get(requestedRunId);
  } else {
    // 未指定 runId：取该 thread 的当前 active run（若无则取最新一条）
    entry = harnessRuntimeRegistry.activeRunForThread(threadId)
      ?? harnessRuntimeRegistry.listByThread(threadId).at(-1);
  }

  // 回退到持久化状态：从 thread.tags 读取 GoalTracker 状态
  // 即使进程重启（registry 为空），也能从持久化状态返回信息
  // — English: fall back to persisted state in thread.tags for cross-restart status
  const tracker = new GoalTracker(threadId, requestedRunId);
  const persistedState = await tracker.load(store).catch(() => null);

  if (!entry && !persistedState) {
    sendError(res, 404, requestedRunId
      ? `Harness run ${requestedRunId} not found`
      : 'No harness run found for this thread');
    return;
  }

  // 合并运行时 + 持久化信息
  const response: HarnessStatusResponse = {
    threadId,
    harnessRunId: entry?.harnessRunId ?? persistedState?.harnessRunId ?? requestedRunId ?? '',
    runtimeStatus: entry?.runtimeStatus ?? 'unknown',
  };

  if (persistedState) {
    response.persistedStatus = persistedState.status;
    response.iteration = persistedState.iteration;
    response.goal = persistedState.goal.objective;
    response.acceptanceCriteria = persistedState.goal.acceptanceCriteria;
    response.lastEvaluation = persistedState.lastEvaluation;
    response.startedAt = persistedState.startedAt;
    response.updatedAt = persistedState.updatedAt as unknown as string | undefined;
  }

  if (entry) {
    response.startedAt = entry.startedAt;
    if (entry.completedAt) response.completedAt = entry.completedAt;
    if (entry.runtimeStatus === 'completed' && entry.result) {
      response.result = entry.result;
    }
    if (entry.runtimeStatus === 'failed' || entry.runtimeStatus === 'cancelled') {
      response.error = entry.error ?? (entry.runtimeStatus === 'cancelled' ? 'Harness run cancelled' : 'Unknown error');
    }
  }

  sendJson(res, 200, response);
}

// ─── POST /api/threads/:id/harness/cancel ────────────────────────────────

async function handleHarnessCancel(options: {
  res: ServerResponse;
  url: URL;
  threadId: ThreadId;
}): Promise<void> {
  const { res, url, threadId } = options;

  // 支持查询参数 ?runId=xxx；不传则取消该 thread 的当前 active run
  const requestedRunId = url.searchParams.get('runId') ?? undefined;

  let targetRunId: string | undefined = requestedRunId;
  if (!targetRunId) {
    const active = harnessRuntimeRegistry.activeRunForThread(threadId);
    targetRunId = active?.harnessRunId;
  }

  if (!targetRunId) {
    const response: HarnessCancelResponse = {
      ok: false,
      harnessRunId: requestedRunId ?? '',
      runtimeStatus: 'unknown',
      message: 'No active harness run to cancel for this thread',
    };
    sendJson(res, 404, response);
    return;
  }

  const cancelled = harnessRuntimeRegistry.cancel(targetRunId);
  const entry = harnessRuntimeRegistry.get(targetRunId);

  const response: HarnessCancelResponse = {
    ok: cancelled,
    harnessRunId: targetRunId,
    runtimeStatus: entry?.runtimeStatus ?? 'unknown',
    message: cancelled
      ? 'Harness run cancellation triggered'
      : 'Harness run already finished or not found',
  };

  sendJson(res, cancelled ? 200 : 409, response);
}
