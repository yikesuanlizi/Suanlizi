import type { SuanliziErrorInfo } from '@suanlizi/protocol';

// Suanlizi 运行时统一错误类型；info 字段携带语义化错误分类，便于上层决策
export class SuanliziRuntimeError extends Error {
  readonly info: SuanliziErrorInfo;

  constructor(message: string, info: SuanliziErrorInfo, options?: { cause?: unknown }) {
    super(message);
    this.name = 'SuanliziRuntimeError';
    this.info = info;
    if (options && 'cause' in options) {
      (this as Error & { cause?: unknown }).cause = options.cause;
    }
  }
}

// 将任意错误对象转换成标准化的 SuanliziErrorInfo；基于错误消息和状态码推断错误分类（上下文超限、限流、未授权、服务端错误、沙箱错误、回滚失败等
export function toSuanliziErrorInfo(error: unknown): SuanliziErrorInfo {
  if (error instanceof SuanliziRuntimeError) return error.info;
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();
  const code = error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined;
  let timeoutMs = error && typeof error === 'object' ? (error as { timeoutMs?: unknown }).timeoutMs : undefined;
  const status = httpStatusFromError(error) ?? httpStatusFromMessage(message);
  if (code === 'MODEL_REQUEST_TIMEOUT') {
    return {
      kind: 'ResponseStreamDisconnected',
      reason: 'timeout',
      timeoutMs: Number.isFinite(timeoutMs) && Number(timeoutMs) > 0 ? Number(timeoutMs) : parseTimeoutMs(message),
      httpStatusCode: status,
    };
  }
  if (typeof timeoutMs !== 'number' && /^(?:model request|model response)/i.test(message)) {
    const parsed = parseTimeoutMs(message);
    if (parsed) timeoutMs = parsed;
  }
  if (lower.includes('context') && lower.includes('window')) return { kind: 'ContextWindowExceeded' };
  if (lower.includes('usage limit') || lower.includes('rate limit') || status === 429) return { kind: 'UsageLimitExceeded' };
  if (status === 401 || status === 403) return { kind: 'Unauthorized', httpStatusCode: status };
  if (status === 400) return { kind: 'BadRequest', httpStatusCode: status };
  if (status === 500 || status === 502 || status === 503 || status === 504) {
    return status === 503 ? { kind: 'ServerOverloaded', httpStatusCode: status } : { kind: 'InternalServerError', httpStatusCode: status };
  }
  if (lower.includes('timeout') || lower.includes('aborted due to timeout') || lower.includes('stream disconnected')) {
    return {
      kind: 'ResponseStreamDisconnected',
      ...(lower.includes('timeout') || lower.includes('aborted due to timeout') ? { reason: 'timeout' as const } : {}),
      httpStatusCode: status,
    };
  }
  if (lower.includes('abort') && (error as Error | undefined)?.name === 'AbortError') {
    return { kind: 'ResponseStreamDisconnected', reason: 'cancelled', httpStatusCode: status };
  }
  if (lower.includes('connection') || lower.includes('network')) return { kind: 'HttpConnectionFailed', reason: 'network', httpStatusCode: status };
  if (lower.includes('sandbox')) return { kind: 'SandboxError' };
  if (lower.includes('rollback')) return { kind: 'ThreadRollbackFailed' };
  if (lower.includes('too many failed attempts')) return { kind: 'ResponseTooManyFailedAttempts', httpStatusCode: status };
  return { kind: 'Other' };
}

// 判断错误是否会影响当前 turn 状态；ThreadRollbackFailed / ActiveTurnNotSteerable 仅影响控制流程，不中断常规 turn
export function affectsTurnStatus(info: SuanliziErrorInfo): boolean {
  return info.kind !== 'ThreadRollbackFailed' && info.kind !== 'ActiveTurnNotSteerable';
}

// 判断是否可恢复的流式错误；响应流断开或服务端过载通常可重试
export function isRecoverableStreamError(error: unknown): boolean {
  const info = toSuanliziErrorInfo(error);
  return (info.kind === 'ResponseStreamDisconnected' && info.reason !== 'cancelled') || info.kind === 'ServerOverloaded';
}

// 从错误对象自身提取 status/statusCode/httpStatusCode 字段；未找到则返回 undefined
function parseTimeoutMs(message: string): number | undefined {
  const match = /after\s+(\d+)\s*ms\b/i.exec(message);
  if (!match) return undefined;
  const value = Number(match[1]);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

function httpStatusFromError(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const value = (error as { status?: unknown; statusCode?: unknown; httpStatusCode?: unknown }).status
    ?? (error as { statusCode?: unknown }).statusCode
    ?? (error as { httpStatusCode?: unknown }).httpStatusCode;
  return typeof value === 'number' ? value : undefined;
}

// 从错误消息文本中提取 HTTP 状态码（匹配形如 "HTTP 429" 或 "status 503"）
function httpStatusFromMessage(message: string): number | undefined {
  const match = /\bHTTP\s+(\d{3})\b/i.exec(message) ?? /\bstatus\s+(\d{3})\b/i.exec(message);
  return match ? Number(match[1]) : undefined;
}
