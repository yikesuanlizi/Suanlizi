// 浏览器运行时 IPC 协议 Schema：与 ipcTypes.ts 同步，全部 .strict()
// — English: browser runtime IPC protocol schemas, synced with ipcTypes.ts, all .strict()
// 协议帧层只校验通用字段（version/frameId/sessionId/seq/timestamp/traceId/
// spanId/type/action/deadline/payload）；command/event/response 的 action 与
// payload 匹配由各自 schema 校验，经 parseIpc* 便捷函数分发（失败返回 null）。
// — English: the frame schema validates only common fields; action/payload
//   matching is handled by the command/event/response schemas, dispatched via
//   the parseIpc* helpers (null on failure).
import { z } from 'zod';
import { actionIntentSchema } from '@suanlizi/protocol';
import { IPC_VERSION } from './ipcTypes.js';
import type { IpcCommand, IpcEvent, IpcResponse, ProtocolFrame } from './ipcTypes.js';

// 通用帧 schema：校验 version===IPC_VERSION（z.literal）与全部通用字段。
// — English: common frame schema — validates version===IPC_VERSION (z.literal)
//   plus all common fields.
// zod 3 会把 output 为 unknown 的字段推断为可选，与 ProtocolFrame 的必填 payload 冲突；
// 运行时行为正确（缺 payload 拒绝），类型上在此断言对齐。
// — English: zod 3 infers unknown-typed fields as optional, conflicting with the
//   required payload in ProtocolFrame; runtime behavior is correct, so align types here.
export const protocolFrameSchema = z.object({
  version: z.literal(IPC_VERSION),
  frameId: z.string().min(1),
  sessionId: z.string().min(1),
  seq: z.number().int().min(0),
  timestamp: z.number().int().min(0),
  traceId: z.string().min(1),
  spanId: z.string().min(1).optional(),
  type: z.enum(['command', 'event', 'response', 'cancel']),
  action: z.string().min(1),
  deadline: z.number().int().min(0).optional(),
  // zod 3 对未知字段缺失宽容，缺失时 refine 收到 undefined——以此强制 payload 必填
  // — English: zod 3 tolerates missing unknown fields (refine receives undefined); enforce presence here
  payload: z.unknown().refine((p) => p !== undefined, { message: 'payload is required' }),
}).strict() as unknown as z.ZodType<ProtocolFrame>;

// ─── 命令 schema：按 action 判别 ────────────────────────────────────────────
// — English: command schema — discriminated on action
export const ipcCommandSchema: z.ZodType<IpcCommand> = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('session.start'),
    payload: z.object({ taskId: z.string().min(1) }).strict(),
  }).strict(),
  z.object({
    action: z.literal('session.close'),
    payload: z.object({ reason: z.string().optional() }).strict(),
  }).strict(),
  z.object({
    action: z.literal('browser.navigate'),
    payload: z.object({ url: z.string().min(1), pageId: z.string().optional() }).strict(),
  }).strict(),
  z.object({
    action: z.literal('browser.observe'),
    payload: z.object({ pageId: z.string().optional() }).strict(),
  }).strict(),
  z.object({
    action: z.literal('browser.page_graph'),
    payload: z.object({}).strict(),
  }).strict(),
  z.object({
    action: z.literal('browser.act'),
    payload: z.object({ intent: actionIntentSchema }).strict(),
  }).strict(),
]);

// ─── 事件 schema：按 action 判别 ────────────────────────────────────────────
// — English: event schema — discriminated on action
export const ipcEventSchema: z.ZodType<IpcEvent> = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('browser.observed'),
    payload: z.object({
      observationId: z.string().min(1),
      pageId: z.string().min(1),
      url: z.string().min(1),
      elementCount: z.number().int().min(0),
    }).strict(),
  }).strict(),
  z.object({
    action: z.literal('browser.action_status'),
    payload: z.object({
      actionId: z.string().min(1),
      status: z.enum(['prepared', 'executing', 'committed', 'uncertain', 'failed']),
    }).strict(),
  }).strict(),
]);

// ─── 响应 schema：按 action 判别 ────────────────────────────────────────────
// — English: response schema — discriminated on action
// 同上：z.custom 保证 result 键必填，类型断言对齐 IpcResponse。
// — English: z.custom keeps result required; type assertion aligns with IpcResponse.
export const ipcResponseSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('ok'),
    // z.unknown() 对缺失字段宽容，refine 强制 result 键存在
    // — English: refine enforces the result key (zod 3 tolerates missing unknown fields)
    payload: z.object({
      result: z.unknown().refine((p) => p !== undefined, { message: 'result is required' }),
    }).strict(),
  }).strict(),
  z.object({
    action: z.literal('error'),
    payload: z.object({
      code: z.string().min(1),
      message: z.string().min(1),
      retryable: z.boolean(),
      kind: z.string().optional(),
    }).strict(),
  }).strict(),
]) as unknown as z.ZodType<IpcResponse>;

// 从任意输入提取 { action, payload } 候选：同时接受完整帧与
// { action, payload } 对象（strict schema 只校验候选，不误拒完整帧）。
// — English: extract an { action, payload } candidate from arbitrary input —
//   accepts both full frames and bare { action, payload } objects.
function extractActionPayload(input: unknown): { action: string; payload: unknown } | null {
  if (typeof input !== 'object' || input === null) return null;
  const record = input as Record<string, unknown>;
  if (typeof record.action !== 'string') return null;
  return { action: record.action, payload: record.payload };
}

// 校验 command 的 action 与 payload 匹配（browser.act 复用 actionIntentSchema）。
// — English: validate command action/payload pairing (browser.act reuses actionIntentSchema).
export function parseIpcCommand(input: unknown): IpcCommand | null {
  const candidate = extractActionPayload(input);
  if (candidate === null) return null;
  const parsed = ipcCommandSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

// 校验 event 的 action 与 payload 匹配。
// — English: validate event action/payload pairing.
export function parseIpcEvent(input: unknown): IpcEvent | null {
  const candidate = extractActionPayload(input);
  if (candidate === null) return null;
  const parsed = ipcEventSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

// 校验 response 的 action 与 payload 匹配。
// — English: validate response action/payload pairing.
export function parseIpcResponse(input: unknown): IpcResponse | null {
  const candidate = extractActionPayload(input);
  if (candidate === null) return null;
  const parsed = ipcResponseSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}
