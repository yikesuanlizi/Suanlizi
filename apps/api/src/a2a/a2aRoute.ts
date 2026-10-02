// A2A HTTP 路由：将 JSON-RPC 请求转发给 SDK 的 JsonRpcTransportHandler
// 英文说明：A2A HTTP route — forwards JSON-RPC requests to SDK JsonRpcTransportHandler

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  DefaultRequestHandler,
  JsonRpcTransportHandler,
} from '@a2a-js/sdk/server';
import type { AgentCard, JSONRPCResponse } from '@a2a-js/sdk';
import { SuanliziAgentExecutor, SuanliziTaskStore, type AgentRuntimePort, type TaskStoreBackend } from '@suanlizi/protocol';
import { readJson, sendError, sendJson } from '../shared/http.js';

// SSE 响应头：与 @a2a-js/sdk 的 SSE_HEADERS 对齐
// X-Accel-Buffering: no 用于禁用 nginx 反向代理的缓冲，确保事件实时推送
// — Chinese: SSE headers aligned with SDK. X-Accel-Buffering disables nginx buffering.
const SSE_HEADERS: Record<string, string> = {
  'Content-Type': 'text/event-stream',
  'Cache-Control': 'no-cache',
  Connection: 'keep-alive',
  'X-Accel-Buffering': 'no',
};

/** 格式化普通 SSE 事件（data 行）。与 SDK formatSSEEvent 对齐。 */
// — Chinese: format normal SSE event (data line), aligned with SDK formatSSEEvent
function formatSSEEvent(event: unknown): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

/** 格式化 SSE 错误事件（event: error + data 行）。与 SDK formatSSEErrorEvent 对齐。 */
// — Chinese: format SSE error event (event: error + data line), aligned with SDK formatSSEErrorEvent
function formatSSEErrorEvent(error: unknown): string {
  return `event: error\ndata: ${JSON.stringify(error)}\n\n`;
}

/**
 * 从 JSON-RPC 请求体中提取 id 字段。
 * 客户端 _processSseEventData 会校验响应 id 必须等于原始请求 id，
 * 因此流式错误事件必须携带原始 id，否则客户端抛 ID mismatch。
 */
// — Chinese: extract JSON-RPC id from request body. Client validates response id matches.
function extractRequestId(body: unknown): string | number | null {
  if (body && typeof body === 'object' && 'id' in body) {
    const id = (body as { id: unknown }).id;
    if (typeof id === 'string' || typeof id === 'number') return id;
  }
  return null;
}

/**
 * A2AHandler 构造参数。
 * - agentCard: Agent 描述卡片
 * - threadStore: 租户隔离后的存储后端（TaskStoreBackend 端口，ThreadStore 结构兼容）
 * - agentFactory: 根据 threadId 返回 AgentRuntimePort（适配 AgentLoop）
 */
// — Chinese: A2AHandler options. threadStore is the tenant-scoped store (TaskStoreBackend port).
export interface A2AHandlerOptions {
  agentCard: AgentCard;
  threadStore: TaskStoreBackend;
  agentFactory: (threadId: string) => Promise<AgentRuntimePort>;
}

/** 已装配的 A2A 处理器：包含 JSON-RPC handler 和 AgentCard。 */
// — Chinese: assembled A2A handler with JSON-RPC handler and AgentCard.
export interface A2AHandler {
  jsonRpcHandler: JsonRpcTransportHandler;
  agentCard: AgentCard;
}

/**
 * 创建 A2A 处理器单例。
 *
 * 装配链路：
 *   SuanliziTaskStore（ThreadStore 适配）
 *   SuanliziAgentExecutor（AgentLoop 适配）
 *   DefaultRequestHandler（SDK 核心：消息分发、结果管理、事件消费）
 *   JsonRpcTransportHandler（JSON-RPC 协议解析）
 */
// — Chinese: create A2A handler singleton. Wires TaskStore, AgentExecutor, RequestHandler, TransportHandler.
export function createA2AHandler(options: A2AHandlerOptions): A2AHandler {
  const taskStore = new SuanliziTaskStore(options.threadStore);
  const agentExecutor = new SuanliziAgentExecutor({ agentFactory: options.agentFactory });
  const requestHandler = new DefaultRequestHandler(
    options.agentCard,
    taskStore,
    agentExecutor,
  );
  const jsonRpcHandler = new JsonRpcTransportHandler(requestHandler);
  return { jsonRpcHandler, agentCard: options.agentCard };
}

/**
 * 判断是否为 AsyncGenerator（流式响应）。
 */
// — Chinese: detect AsyncGenerator for streaming responses
function isAsyncGenerator(value: unknown): value is AsyncGenerator<JSONRPCResponse> {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof (value as AsyncGenerator<JSONRPCResponse>)[Symbol.asyncIterator] === 'function'
  );
}

/**
 * 处理 A2A HTTP 路由。
 *
 * 路由：
 *   POST /api/a2a         — JSON-RPC 入口（支持 message/send、message/stream 等）
 *   GET  /api/a2a/card    — 返回 AgentCard
 *
 * 流式方法（message/stream、tasks/resubscribe）返回 AsyncGenerator，
 * 以 SSE 形式输出；非流式方法返回单个 JSON-RPC 响应。
 */
// — Chinese: handle A2A HTTP routes. POST /api/a2a is JSON-RPC entry; GET /api/a2a/card returns AgentCard.
export async function handleA2ARoute(options: {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  segments: string[];
  handler: A2AHandler;
}): Promise<boolean> {
  const { req, res, segments, handler } = options;
  if (segments[0] !== 'api' || segments[1] !== 'a2a') return false;

  // GET /api/a2a/card — 返回 AgentCard
  if (req.method === 'GET' && segments[2] === 'card') {
    sendJson(res, 200, handler.agentCard);
    return true;
  }

  // POST /api/a2a — JSON-RPC 入口
  if (req.method !== 'POST') {
    sendError(res, 405, 'Method not allowed; use POST for JSON-RPC or GET /api/a2a/card for AgentCard');
    return true;
  }

  let body: unknown;
  try {
    body = await readJson<unknown>(req);
  } catch (parseError) {
    // JSON 解析失败：返回 JSON-RPC parse error（非 SSE）
    // — Chinese: JSON parse failure: return JSON-RPC parse error (non-SSE)
    const errEvent = {
      jsonrpc: '2.0' as const,
      id: null,
      error: {
        code: -32700,
        message: parseError instanceof Error ? parseError.message : 'Parse error',
      },
    };
    sendJson(res, 200, errEvent);
    return true;
  }

  const requestId = extractRequestId(body);

  let result: JSONRPCResponse | AsyncGenerator<JSONRPCResponse>;
  try {
    result = await handler.jsonRpcHandler.handle(body);
  } catch (handleError) {
    // handle() 内部通常会捕获异常并返回 error 响应，此处仅为兜底
    // — Chinese: handle() normally catches internally; this is a safety net
    const errEvent = {
      jsonrpc: '2.0' as const,
      id: requestId,
      error: {
        code: -32603,
        message: handleError instanceof Error ? handleError.message : String(handleError),
      },
    };
    sendJson(res, 200, errEvent);
    return true;
  }

  // 流式响应 — 以 SSE 输出
  if (isAsyncGenerator(result)) {
    res.writeHead(200, SSE_HEADERS);
    // 立即刷新响应头，确保客户端尽早进入 SSE 读取状态
    // — Chinese: flush headers immediately so client starts reading SSE
    res.flushHeaders();

    // 客户端断连检测：一旦客户端关闭连接就停止迭代 generator
    // — Chinese: detect client disconnect to stop iterating the generator
    let clientDisconnected = false;
    const onClose = (): void => {
      clientDisconnected = true;
    };
    req.on('close', onClose);

    try {
      for await (const event of result) {
        if (clientDisconnected) break;
        res.write(formatSSEEvent(event));
      }
    } catch (streamError) {
      // 流式过程中出错：
      // - 若 headers 未发送（理论上不会，但防御性处理），返回 JSON 错误
      // - 否则以 SSE error 事件发送，id 必须为原始请求 id（客户端会校验）
      // — Chinese: stream error: send SSE error event with original request id
      const errEvent = {
        jsonrpc: '2.0' as const,
        id: requestId,
        error: {
          code: -32603,
          message: streamError instanceof Error ? streamError.message : String(streamError),
        },
      };
      if (!res.headersSent) {
        sendJson(res, 500, errEvent);
      } else if (!clientDisconnected && !res.writableEnded) {
        res.write(formatSSEErrorEvent(errEvent));
      }
    } finally {
      req.off('close', onClose);
      if (!res.writableEnded) {
        res.end();
      }
    }
    return true;
  }

  // 单一响应
  sendJson(res, 200, result);
  return true;
}
