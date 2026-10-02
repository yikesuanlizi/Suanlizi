// A2A handler 的按租户单例注册表（从 server.ts 拆出，§5：server.ts 只做路由装配）。
// — Chinese: per-tenant A2A handler registry extracted from server.ts.

import type { IncomingMessage } from 'node:http';
import {
  buildAgentCard,
  type AgentRuntimePort,
  type ThreadEvent,
  type ThreadId,
  type ThreadItem,
} from '@suanlizi/protocol';
import { createA2AHandler, type A2AHandler } from '../a2a/a2aRoute.js';
import type { TenantContext } from '../shared/tenant.js';

type A2ARouteDeps = Parameters<typeof createA2AHandler>[0];

export interface A2AHandlerRegistryDeps {
  /** 按租户取 thread store（与 server.ts 的 tenantRuntime.storeForTenant 同型）。 */
  storeForTenant: (tenantContext: TenantContext) => A2ARouteDeps['threadStore'];
  /** 按租户取缺省 AgentLoop，并适配到 A2A 端口。 */
  createRuntimePort: (tenantContext: TenantContext) => Promise<AgentRuntimePort>;
}

/** AgentLoop 在 A2A 端口里用到的最小方法面。 */
export interface A2AAgentLike {
  runTurn(
    threadId: ThreadId,
    input: { type: 'text'; text: string },
    signal?: AbortSignal,
  ): Promise<{ items: ThreadItem[] }>;
  interrupt(threadId: ThreadId): boolean;
  onEvent(listener: (event: ThreadEvent) => void): () => void;
}

/**
 * 将 AgentLoop 适配到 A2A AgentRuntimePort：onEvent 返回 unsubscribe，
 * runTurn 返回 { items, usage }，端口只取 { items }。
 */
export function adaptAgentLoopToPort(agent: A2AAgentLike): AgentRuntimePort {
  return {
    runTurn: (threadId, input, signal) => agent.runTurn(threadId, input, signal),
    interrupt: (threadId) => agent.interrupt(threadId),
    onEvent: (listener) => agent.onEvent(listener),
  };
}

export interface A2AHandlerRegistry {
  handler(tenantContext: TenantContext, req: IncomingMessage): A2AHandler;
}

export function createA2AHandlerRegistry(deps: A2AHandlerRegistryDeps): A2AHandlerRegistry {
  const handlers = new Map<string, A2AHandler>();

  function handler(tenantContext: TenantContext, req: IncomingMessage): A2AHandler {
    const cached = handlers.get(tenantContext.tenantId);
    if (cached) return cached;
    const agentCard = buildAgentCard({
      name: 'Suanlizi',
      description: 'Suanlizi Agent OS — A2A endpoint powered by AgentLoop runtime',
      url: `${resolveA2ABaseUrl(req)}/api/a2a`,
      version: '0.3.0',
      // 本地实例不启用远程认证。
      securityScheme: 'none',
    });
    const created = createA2AHandler({
      agentCard,
      threadStore: deps.storeForTenant(tenantContext),
      agentFactory: async () => deps.createRuntimePort(tenantContext),
    });
    handlers.set(tenantContext.tenantId, created);
    return created;
  }

  return { handler };
}

/** 推导 A2A 端点基础 URL（支持 SUANLIZI_A2A_BASE_URL 环境变量覆盖）。 */
// — Chinese: resolve A2A endpoint base URL (overridable via SUANLIZI_A2A_BASE_URL)
export function resolveA2ABaseUrl(req: IncomingMessage): string {
  const envBase = process.env.SUANLIZI_A2A_BASE_URL;
  if (envBase) return envBase.replace(/\/$/, '');
  const proto = (req.headers['x-forwarded-proto'] as string | undefined) ?? 'http';
  const host = req.headers.host ?? `localhost:${process.env.SUANLIZI_API_PORT ?? '4127'}`;
  return `${proto}://${host}`;
}
