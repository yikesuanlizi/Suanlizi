// Thread 子路由聚合器：把 /api/threads/:id/* 的路由分发从 server.ts 抽离，
// 让 server.ts 聚焦于顶层装配（≤780 行架构守卫）。
// — Chinese: thread sub-route aggregator to keep server.ts focused on top-level wiring

import type { IncomingMessage, ServerResponse } from 'node:http';
import { URL } from 'node:url';
import type { ThreadStore } from '@suanlizi/storage';
import type { AgentLoop } from '@suanlizi/runtime';
import type { ModelGateway } from '@suanlizi/model-gateway';
import { agentDecisionResponseSchema, type ThreadEvent, type ThreadId, type TaskStorePort } from '@suanlizi/protocol';
import { redactAccessPolicyForPublicConfig, type AccessPolicyConfig } from '@suanlizi/protocol';
import type { AgentRunConfig, ThreadConfigOverrides } from '../config/config.js';
import { readJson, sendError, sendJson } from '../shared/http.js';
import type { TenantContext } from '../shared/tenant.js';
import type { ActiveRunRegistry } from '../runtime/activeRunRegistry.js';
import { buildThreadChildInfos } from '../services/threadChildren.js';
import { usageForThreadTree, usageFromThread } from '../services/usage.js';
import { clearRemoteBotBindingsForDeletedThread } from './threadDeletion.js';
import { handlePatchThread } from './threadMetadata.js';
import { handleWorkflowRoute } from './workflowRoute.js';
import { handleHarnessRoute } from './harnessRoute.js';

// thread 路由需要的上下文（由 server.ts 的 route 函数闭包注入）
// — Chinese: context injected from server.ts route closure
export interface ThreadRouteContext {
  store: ThreadStore;
  tenantContext: TenantContext;
  createTenantAgent: (config?: Partial<AgentRunConfig>) => Promise<{ agent: AgentLoop; model: ModelGateway; config: AgentRunConfig }>;
  getTenantDefaultAgent: () => Promise<AgentLoop>;
  publishTenantEvent: (event: ThreadEvent) => void;
  getThreadRunConfig: (threadId: ThreadId) => Promise<AgentRunConfig>;
  saveThreadRunConfig: (threadId: ThreadId, config: Partial<AgentRunConfig>) => Promise<AgentRunConfig>;
  getThreadConfigOverrides: (threadId: string) => Promise<ThreadConfigOverrides>;
  updateThreadConfigOverrides: (threadId: string, input: Record<string, unknown>) => Promise<ThreadConfigOverrides>;
  getThreadAccessPolicy: (threadId: string) => Promise<AccessPolicyConfig | null>;
  saveThreadAccessPolicy: (threadId: string, input: unknown) => Promise<AccessPolicyConfig>;
  publicThreadRunConfig: (config: AgentRunConfig, thread: { tags?: Record<string, string> } | null) => AgentRunConfig;
  closeThreadEventClients: (threadId: ThreadId, tenantId: string) => void;
  activeRunRegistry?: ActiveRunRegistry;
  /** 目标任务影子写端口（计划 §14.6 影子写期）；缺省时 harness 不写 task 表。 */
  taskStore?: TaskStorePort;
}

const THREAD_DELETE_WAIT_MS = 5_000;
const deletingThreads = new Set<string>();

/**
 * 处理 /api/threads/:id/* 的所有子路由。
 * 返回 true 表示已处理；false 表示不匹配（交由上层继续路由）。
 */
export async function handleThreadRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  segments: string[],
  ctx: ThreadRouteContext,
): Promise<boolean> {
  if (!(segments[0] === 'api' && segments[1] === 'threads' && segments[2])) return false;
  const threadId = segments[2] as ThreadId;
  const { store, tenantContext, createTenantAgent, getTenantDefaultAgent, publishTenantEvent } = ctx;

  // workflow 子路由
  if (await handleWorkflowRoute({
    req, res, segments, store,
    createPlannerModel: async () => (await createTenantAgent()).model,
  })) return true;

  // harness 子路由：start/status/cancel
  if (await handleHarnessRoute({
    req, res, url, segments, store, tenantContext,
    taskStore: ctx.taskStore,
    createAgent: async (config) => (await createTenantAgent(config)).agent,
    publishEvent: publishTenantEvent,
    getThreadRunConfig: ctx.getThreadRunConfig,
  })) return true;

  // GET /api/threads/:id — 线程详情
  if (req.method === 'GET' && segments.length === 3) {
    const thread = await store.getThread(threadId);
    if (!thread) { sendError(res, 404, 'Thread not found'); return true; }
    const turns = await store.getTurns(threadId);
    const items = await store.getItems(threadId);
    const config = await ctx.getThreadRunConfig(threadId);
    const includeChildrenUsage = url.searchParams.get('includeChildren') === '1';
    sendJson(res, 200, {
      thread, turns, items,
      config: ctx.publicThreadRunConfig(config, thread),
      usage: includeChildrenUsage ? await usageForThreadTree(store, threadId) : usageFromThread(thread),
    });
    return true;
  }

  // GET /api/threads/:id/usage
  if (req.method === 'GET' && segments[3] === 'usage') {
    const thread = await store.getThread(threadId);
    if (!thread) { sendError(res, 404, 'Thread not found'); return true; }
    const includeChildrenUsage = url.searchParams.get('includeChildren') === '1';
    sendJson(res, 200, { usage: includeChildrenUsage ? await usageForThreadTree(store, threadId) : usageFromThread(thread) });
    return true;
  }

  // GET /api/threads/:id/children
  if (req.method === 'GET' && segments[3] === 'children') {
    const thread = await store.getThread(threadId);
    if (!thread) { sendError(res, 404, 'Thread not found'); return true; }
    const recursive = url.searchParams.get('recursive') === '1';
    const agent = await getTenantDefaultAgent();
    const children = await buildThreadChildInfos({
      parentThreadId: threadId, recursive, store,
      getRuntimeState: (childThreadId) => agent.getRuntimeState(childThreadId),
    });
    sendJson(res, 200, { threadId, children });
    return true;
  }

  // DELETE /api/threads/:id
  if (req.method === 'DELETE' && segments.length === 3) {
    const deleteKey = `${tenantContext.tenantId}:${threadId}`;
    if (deletingThreads.has(deleteKey)) {
      sendError(res, 409, 'THREAD_DELETE_IN_PROGRESS');
      return true;
    }
    const thread = await store.getThread(threadId);
    if (!thread) { sendError(res, 404, 'Thread not found'); return true; }
    deletingThreads.add(deleteKey);
    try {
      const agent = await getTenantDefaultAgent();
      const active = ctx.activeRunRegistry?.getByThreadId(threadId);
      if (active) await active.interrupt();
      else agent.interrupt(threadId);
      const idle = ctx.activeRunRegistry
        ? await ctx.activeRunRegistry.waitForThreadIdle(threadId, THREAD_DELETE_WAIT_MS)
        : true;
      if (!idle) {
        sendError(res, 409, 'THREAD_DELETE_TIMEOUT');
        return true;
      }
      agent.releaseLlamaSlot(threadId);
      ctx.closeThreadEventClients(threadId, tenantContext.tenantId);
      await store.deleteThreadWorkingSet?.(threadId);
      await store.deleteThread(threadId);
      await clearRemoteBotBindingsForDeletedThread(store, threadId);
      sendJson(res, 200, { ok: true, status: 'deleted' });
    } finally {
      deletingThreads.delete(deleteKey);
    }
    return true;
  }

  // PATCH /api/threads/:id
  if (req.method === 'PATCH' && segments.length === 3) {
    await handlePatchThread(req, res, store, threadId);
    return true;
  }

  // GET /api/threads/:id/config
  if (req.method === 'GET' && segments[3] === 'config' && segments.length === 4) {
    const thread = await store.getThread(threadId);
    if (!thread) { sendError(res, 404, 'Thread not found'); return true; }
    const overrides = await ctx.getThreadConfigOverrides(threadId);
    const accessPolicy = await ctx.getThreadAccessPolicy(threadId);
    sendJson(res, 200, {
      overrides,
      accessPolicy: accessPolicy ? redactAccessPolicyForPublicConfig(accessPolicy) : null,
    });
    return true;
  }

  // PATCH /api/threads/:id/config
  if (req.method === 'PATCH' && segments[3] === 'config' && segments.length === 4) {
    const thread = await store.getThread(threadId);
    if (!thread) { sendError(res, 404, 'Thread not found'); return true; }
    const body = await readJson<{ overrides?: Record<string, unknown>; accessPolicy?: unknown }>(req);
    const overrides = await ctx.updateThreadConfigOverrides(threadId, body.overrides ?? {});
    const accessPolicy = body.accessPolicy === undefined
      ? undefined
      : redactAccessPolicyForPublicConfig(await ctx.saveThreadAccessPolicy(threadId, body.accessPolicy));
    sendJson(res, 200, { overrides, accessPolicy });
    return true;
  }

  // GET /api/threads/:id/state
  if (req.method === 'GET' && segments[3] === 'state') {
    const agent = await getTenantDefaultAgent();
    const thread = await store.getThread(threadId);
    const state = await agent.getRuntimeState(threadId);
    // 第二道防线：checkpoint 声称在跑/停止，但本进程没有对应运行句柄，且运行时已判定过期，
    // 说明是上次进程遗留的僵尸运行态（强杀/崩溃），按终止态返回并顺手收敛。
    // 不能把 waiting_user_input 当作僵尸：那是合法的可恢复等待点，冷启动后仍要经
    // POST /api/threads/:id/decision 续跑（见 AgentLoop.resolveUserDecision 的 persistedWaiting 分支）。
    const live = ctx.activeRunRegistry?.getByThreadId(threadId) ?? null;
    const claimedZombie = state.status === 'running' || state.status === 'stopping' || state.stale;
    if (!live && claimedZombie) {
      const checkpoint = await store.getLastCheckpoint(threadId).catch(() => null);
      if (checkpoint) {
        await store.appendCheckpoint(threadId, {
          ...checkpoint,
          status: 'interrupted',
          executionStatus: 'terminal',
          expiresAt: undefined,
        }).catch(() => undefined);
      }
      sendJson(res, 200, {
        state: {
          ...state,
          status: 'terminal',
          executionStatus: 'terminal',
          resumable: false,
          stale: true,
          checkpoint: state.checkpoint ? { ...state.checkpoint, status: 'interrupted', executionStatus: 'terminal' } : null,
        },
        usage: usageFromThread(thread),
      });
      return true;
    }
    sendJson(res, 200, { state, usage: usageFromThread(thread) });
    return true;
  }

  // POST /api/threads/:id/decision：Agent 决策请求的独立接管入口，不混用权限审批。
  if (req.method === 'POST' && segments[3] === 'decision') {
    const body = await readJson<{
      requestId?: string;
      action?: 'way_one' | 'way_two' | 'custom_input' | 'cancel' | 'confirm';
      optionId?: string;
      customInput?: string;
    }>(req);
    if (!body.requestId || !body.action) {
      sendError(res, 400, 'Decision requestId and action are required');
      return true;
    }
    const parsedResponse = agentDecisionResponseSchema.safeParse({
      requestId: body.requestId,
      action: body.action,
      ...(body.optionId ? { optionId: body.optionId } : {}),
      ...(body.customInput !== undefined ? { customInput: body.customInput } : {}),
    });
    if (!parsedResponse.success) {
      sendError(res, 400, 'Invalid decision response');
      return true;
    }
    const response = parsedResponse.data;
    const active = ctx.activeRunRegistry?.getByThreadId(threadId);
    const agent = await getTenantDefaultAgent();
    const result = active?.resolveDecision
      ? await active.resolveDecision(response)
      : await agent.resolveUserDecision(threadId, response);
    if (!result.accepted) {
      sendError(res, 409, 'Decision request is no longer pending');
      return true;
    }
    sendJson(res, 200, { ok: true, ...result });
    return true;
  }

  // GET /api/threads/:id/context-pressure
  if (req.method === 'GET' && segments[3] === 'context-pressure') {
    const thread = await store.getThread(threadId);
    if (!thread) { sendError(res, 404, 'Thread not found'); return true; }
    // Context pressure is thread-scoped. The default agent carries global
    // settings and can report a stale window (for example 24K) when this
    // thread explicitly uses 64K. Build the lightweight thread-configured
    // agent so the pressure calculation and compaction thresholds agree with
    // the turn that will actually run.
    const threadConfig = await ctx.getThreadRunConfig(threadId);
    const agent = (await createTenantAgent(threadConfig)).agent;
    const pressure = await agent.getContextPressure(threadId);
    sendJson(res, 200, { pressure });
    return true;
  }

  return false;
}
