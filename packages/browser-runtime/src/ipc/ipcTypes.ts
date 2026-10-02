// 浏览器运行时 IPC 协议层：Rust Host ↔ Node Sidecar 的 JSONL 帧协议（架构文档 14.1）
// — English: browser runtime IPC protocol layer — JSONL frame protocol between
//   the Rust host and the Node sidecar (architecture doc §14.1)
// Phase 1 只交付协议层（类型/schema/codec）；Sidecar 事件循环由独立任务实现，
// 严格按本模块导出的接口调用。编码约束：sidecar stdout 每行一帧，日志不得混入 stdout。
// — English: Phase 1 ships the protocol layer only (types/schemas/codec); the
//   sidecar event loop is implemented by a separate task against these exports.
import type { ActionIntent } from '@suanlizi/protocol';

// 协议版本：与帧 schema 的 z.literal 绑定，破坏性变更时递增。
// — English: protocol version — bound to z.literal in the frame schema.
export const IPC_VERSION = '1.0.0' as const;

// 帧类型：command（Host→Sidecar，需响应）、event（Sidecar→Host 通知）、
// response（command 的应答）、cancel（取消进行中的 command）。
// — English: frame types — command (Host→Sidecar, requires a response),
//   event (Sidecar→Host notification), response (reply to a command), cancel.
export type IpcFrameType = 'command' | 'event' | 'response' | 'cancel';

// 通用帧信封：所有类型共用同一结构。本层只声明通用字段；
// action 与 payload 的匹配由 ipcSchemas.ts 中对应的 command/event/response schema 校验。
// — English: common frame envelope shared by all types; action/payload
//   matching is validated by the per-type schemas in ipcSchemas.ts.
export interface ProtocolFrame<T = unknown> {
  version: string;
  frameId: string;       // 全局唯一帧号，消费者按此幂等（at-least-once）
  sessionId: string;     // 会话 ID（单任务独占的浏览器会话）
  seq: number;           // 会话内单调递增，消费方按 frameId 幂等
  timestamp: number;     // epoch ms
  traceId: string;       // 分布式追踪 ID，跨进程关联
  spanId?: string;       // 可选的追踪 span
  type: IpcFrameType;
  action: string;
  deadline?: number;     // epoch ms，command 超时
  payload: T;
}

// ─── 命令：Host → Sidecar ───────────────────────────────────────────────────
// — English: commands — Host to Sidecar
export type IpcCommand =
  | { action: 'session.start'; payload: { taskId: string } }
  | { action: 'session.close'; payload: { reason?: string } }
  | { action: 'browser.navigate'; payload: { url: string; pageId?: string } }
  | { action: 'browser.observe'; payload: { pageId?: string } }
  | { action: 'browser.page_graph'; payload: Record<string, never> }
  | { action: 'browser.act'; payload: { intent: ActionIntent } };

// ─── 事件：Sidecar → Host（异步通知） ───────────────────────────────────────
// — English: events — Sidecar to Host (async notifications)
export type IpcEvent =
  | {
      action: 'browser.observed';
      payload: { observationId: string; pageId: string; url: string; elementCount: number };
    }
  | {
      action: 'browser.action_status';
      payload: { actionId: string; status: 'prepared' | 'executing' | 'committed' | 'uncertain' | 'failed' };
    };

// ─── 响应：command 的应答 ────────────────────────────────────────────────────
// — English: responses — replies to commands
export type IpcResponse =
  | { action: 'ok'; payload: { result: unknown } }
  | { action: 'error'; payload: { code: string; message: string; retryable: boolean; kind?: string } };

// 帧信封：保留最外层对象形态，便于未来扩展（如协议头/签名）而不破坏单行 JSON。
// — English: frame envelope — keeps an outer object shape for future
//   extensions (headers/signatures) without breaking single-line JSON.
export interface IpcEnvelope {
  frame: ProtocolFrame;
}

// 编解码器契约：Sidecar 循环只依赖此接口。
// — English: codec contract — the sidecar loop depends only on this interface.
export interface IpcCodec {
  // 编码为单行 JSON（无换行），供 JSONL stdout 输出。
  // — English: encode to single-line JSON (no newline) for JSONL stdout.
  encode(frame: ProtocolFrame): string;
  // 解码一行；非法 JSON / schema 校验失败返回 null（不抛、不写日志）。
  // — English: decode one line; invalid JSON / schema failure returns null.
  decodeLine(line: string): ProtocolFrame | null;
  // 构造帧：未传 frameId 时自动生成 fr-${sessionId}-${seq}；
  // seq 由调用方维护（codec 不保存状态，Sidecar 负责）。
  // — English: build a frame — frameId defaults to fr-${sessionId}-${seq};
  //   seq is maintained by the caller (the codec is stateless).
  makeFrame(input: {
    sessionId: string;
    seq: number;
    type: IpcFrameType;
    action: string;
    payload: unknown;
    traceId: string;
    spanId?: string;
    frameId?: string;
    deadline?: number;
  }): ProtocolFrame;
}
