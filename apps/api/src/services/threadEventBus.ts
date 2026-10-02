// SSE 事件总线：按 (tenant, thread) 维护订阅者与可回放历史（从 server.ts 拆出，§5）。
// server.ts 只保留路由装配；事件广播、终态关闭与回放缓冲集中在本模块，
// 便于断线恢复语义（history + sequence）保持单一实现。
// — Chinese: SSE fan-out bus extracted from server.ts (publish / close / replay history).

import type { ServerResponse } from 'node:http';
import type { ThreadEvent, ThreadId, ThreadItem } from '@suanlizi/protocol';
import { ThreadEventHistory } from '../shared/threadEventHistory.js';
import { DEFAULT_TENANT_ID, tenantEventKey } from '../shared/tenant.js';

export interface ThreadEventBus {
  /** 广播一个线程事件；无 threadId 的事件（如全局状态）直接忽略。 */
  publishEvent(event: ThreadEvent, tenantId?: string): void;
  /** 逐条广播 turn 产物（item.completed），供 SSE 客户端增量渲染。 */
  publishCompletedItems(threadId: ThreadId, turnId: string, items: ThreadItem[], tenantId?: string): void;
  /** 关闭某线程的全部订阅并清理回放缓冲（线程被删除/归档时调用）。 */
  closeThreadEventClients(threadId: ThreadId, tenantId?: string): void;
  /** 订阅表与回放缓冲：仍由 server.ts 的 SSE 端点直接挂接新客户端。 */
  clients: Map<string, Set<ServerResponse>>;
  history: ThreadEventHistory;
}

export function createThreadEventBus(historyLimit = 500): ThreadEventBus {
  const clients = new Map<string, Set<ServerResponse>>();
  const history = new ThreadEventHistory(historyLimit);

  function publishEvent(event: ThreadEvent, tenantId: string = DEFAULT_TENANT_ID): void {
    const threadId = 'threadId' in event ? event.threadId : undefined;
    if (!threadId) return;
    const entry = history.append(tenantId, threadId, event);
    const subscribers = clients.get(tenantEventKey(tenantId, threadId));
    if (!subscribers) return;
    const line = `id: ${entry.sequence}\ndata: ${JSON.stringify({ ...event, sequence: entry.sequence, isReplay: false })}\n\n`;
    for (const client of subscribers) {
      try {
        client.write(line);
      } catch {
        subscribers.delete(client);
      }
    }
    if (subscribers.size === 0) clients.delete(tenantEventKey(tenantId, threadId));
  }

  function publishCompletedItems(
    threadId: ThreadId,
    turnId: string,
    items: ThreadItem[],
    tenantId: string = DEFAULT_TENANT_ID,
  ): void {
    for (const item of items) {
      publishEvent({ type: 'item.completed', threadId, turnId, item }, tenantId);
    }
  }

  function closeThreadEventClients(threadId: ThreadId, tenantId: string = DEFAULT_TENANT_ID): void {
    const key = tenantEventKey(tenantId, threadId);
    const subscribers = clients.get(key);
    if (subscribers) {
      for (const client of subscribers) {
        client.end();
      }
      clients.delete(key);
    }
    history.clearThread(tenantId, threadId);
  }

  return { publishEvent, publishCompletedItems, closeThreadEventClients, clients, history };
}
