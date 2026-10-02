/**
 * 模型请求在单次尝试或流式读取期间超过配置的超时时间。
 *
 * 这是 model-gateway 的基础错误类型，不依赖 runtime，方便 runtime、API
 * 和桌面端在不解析底层 DOMException 文案的情况下识别超时。
 */
export class ModelRequestTimeoutError extends Error {
  readonly code = 'MODEL_REQUEST_TIMEOUT';
  readonly detail?: string;

  constructor(readonly timeoutMs: number, options?: { cause?: unknown; detail?: string }) {
    const causeMessage = options?.cause instanceof Error
      ? options.cause.message
      : typeof options?.detail === 'string' ? options.detail : undefined;
    super(`Model request timed out after ${timeoutMs}ms${causeMessage ? `: ${causeMessage}` : ''}`);
    this.name = 'ModelRequestTimeoutError';
    if (causeMessage) this.detail = causeMessage;
    if (options && 'cause' in options) {
      (this as Error & { cause?: unknown }).cause = options.cause;
    }
  }
}

export function isModelRequestTimeoutError(error: unknown): error is ModelRequestTimeoutError {
  return error instanceof ModelRequestTimeoutError
    || (Boolean(error)
      && typeof error === 'object'
      && (error as { code?: unknown }).code === 'MODEL_REQUEST_TIMEOUT');
}
