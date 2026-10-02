import type { RetryPolicy } from '@suanlizi/protocol';
import type { ChatCompletionRequest, ModelRetryNotice } from './types.js';
import { ModelRequestTimeoutError } from './errors.js';

/**
 * llama-server exposes management endpoints at the server root and chat
 * completions below /v1. Keep that distinction out of ModelGateway.
 */
export interface LlamaCppClientOptions {
  /** Root URL or a URL ending in /v1. Both forms are accepted. */
  baseUrl: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
  retry?: Partial<RetryPolicy>;
}

export interface LlamaCppRequestOptions {
  signal?: AbortSignal;
  onRetry?: (notice: ModelRetryNotice) => void | Promise<void>;
}

export class LlamaCppClient {
  readonly serverBaseUrl: string;
  readonly apiBaseUrl: string;

  private readonly headers: Record<string, string>;
  private readonly timeoutMs: number;
  private readonly retry: Required<RetryPolicy>;

  constructor(options: LlamaCppClientOptions) {
    const urls = normalizeLlamaUrls(options.baseUrl);
    this.serverBaseUrl = urls.serverBaseUrl;
    this.apiBaseUrl = urls.apiBaseUrl;
    this.headers = { ...options.headers };
    this.timeoutMs = positiveTimeout(options.timeoutMs, 120_000);
    this.retry = {
      maxAttempts: positiveInteger(options.retry?.maxAttempts, 3),
      initialDelayMs: nonNegativeInteger(options.retry?.initialDelayMs, 300),
      maxDelayMs: nonNegativeInteger(options.retry?.maxDelayMs, 3_000),
    };
  }

  /** llama-server metadata, including effective slot context and templates. */
  getProps(options?: LlamaCppRequestOptions): Promise<Response> {
    return this.request(`${this.serverBaseUrl}/props`, { method: 'GET' }, options, 5_000);
  }

  /** llama-server Prometheus metrics. */
  getMetrics(options?: LlamaCppRequestOptions): Promise<Response> {
    return this.request(`${this.serverBaseUrl}/metrics`, { method: 'GET' }, options);
  }

  /** llama-server slot state, useful for cache/slot diagnostics. */
  getSlots(options?: LlamaCppRequestOptions): Promise<Response> {
    return this.request(`${this.serverBaseUrl}/slots`, { method: 'GET' }, options);
  }

  /** OpenAI-compatible model listing. */
  getModels(options?: LlamaCppRequestOptions): Promise<Response> {
    return this.request(`${this.apiBaseUrl}/models`, { method: 'GET' }, options, 5_000);
  }

  /** OpenAI-compatible chat endpoint; SSE parsing remains in ModelGateway. */
  async chat(body: ChatCompletionRequest, options?: LlamaCppRequestOptions): Promise<Response> {
    const response = await this.request(`${this.apiBaseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }, options);
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`llama.cpp gateway error (${response.status}): ${formatErrorBody(text)}`);
    }
    return response;
  }

  /** llama-server Responses API endpoint. The caller handles status-specific fallback. */
  responses(body: Record<string, unknown>, options?: LlamaCppRequestOptions): Promise<Response> {
    return this.request(`${this.apiBaseUrl}/responses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }, options);
  }

  private async request(
    url: string,
    init: RequestInit,
    options: LlamaCppRequestOptions | undefined,
    requestTimeoutMs = this.timeoutMs,
  ): Promise<Response> {
    const requestInit: RequestInit = {
      ...init,
      headers: { ...this.headers, ...init.headers },
    };

    let lastError: unknown;
    for (let attempt = 1; attempt <= this.retry.maxAttempts; attempt += 1) {
      // 每次尝试独立计时，避免第一次超时后重试立即复用已过期 signal。
      const attemptSignal = withTimeoutSignal(options?.signal, requestTimeoutMs);
      try {
        const response = await fetch(url, { ...requestInit, signal: attemptSignal });
        if (!isRetryableStatus(response.status) || attempt >= this.retry.maxAttempts) return response;
        lastError = new HttpRetryError(response.status);
      } catch (error) {
        if (options?.signal?.aborted) throw error;
        lastError = isTimeoutAbort(attemptSignal, error)
          ? new ModelRequestTimeoutError(requestTimeoutMs, { cause: error })
          : error;
        if (!isRetryableFetchError(error) || attempt >= this.retry.maxAttempts) throw lastError;
      }

      const delayMs = Math.min(
        this.retry.maxDelayMs,
        this.retry.initialDelayMs * 2 ** Math.max(0, attempt - 1),
      );
      await options?.onRetry?.({
        attempt,
        maxAttempts: this.retry.maxAttempts,
        delayMs,
        status: lastError instanceof HttpRetryError ? lastError.status : undefined,
        error: lastError instanceof Error && !(lastError instanceof HttpRetryError) ? lastError.message : undefined,
      });
      // 重试等待不应继续占用上一轮请求的超时预算；只响应调用方主动取消。
      await abortableSleep(delayMs, options?.signal);
      if (options?.signal?.aborted) throw options.signal.reason ?? new DOMException('The operation was aborted', 'AbortError');
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }
}

export function normalizeLlamaUrls(baseUrl: string): { serverBaseUrl: string; apiBaseUrl: string } {
  const input = baseUrl.trim();
  if (!input) throw new Error('llama.cpp base URL is required');
  const parsed = new URL(input);
  const pathname = parsed.pathname.replace(/\/+$/, '');
  const hasV1 = pathname === '/v1' || pathname.endsWith('/v1');
  const serverPath = hasV1 ? pathname.slice(0, -3).replace(/\/+$/, '') : pathname;
  const origin = parsed.origin;
  const serverBaseUrl = `${origin}${serverPath}` || origin;
  const apiBaseUrl = hasV1 ? `${origin}${pathname}` : `${origin}${pathname}/v1`;
  return { serverBaseUrl, apiBaseUrl };
}

function withTimeoutSignal(parent: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  if (!parent) return timeout;
  if (parent.aborted) return parent;
  const controller = new AbortController();
  const abortFromParent = () => controller.abort(parent.reason);
  const abortFromTimeout = () => controller.abort(timeout.reason);
  parent.addEventListener('abort', abortFromParent, { once: true });
  timeout.addEventListener('abort', abortFromTimeout, { once: true });
  return controller.signal;
}

function isTimeoutAbort(signal: AbortSignal, error: unknown): boolean {
  if (signal.aborted && isTimeoutReason(signal.reason)) return true;
  if (error instanceof DOMException && error.name === 'TimeoutError') return true;
  return error instanceof Error && /aborted.*timeout|timeout/i.test(error.message);
}

function isTimeoutReason(reason: unknown): boolean {
  return reason instanceof DOMException && reason.name === 'TimeoutError'
    || reason instanceof Error && /timeout/i.test(reason.message);
}

class HttpRetryError extends Error {
  constructor(readonly status: number) {
    super(`retryable HTTP ${status}`);
  }
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}

function isRetryableFetchError(error: unknown): boolean {
  if (error instanceof DOMException && error.name === 'TimeoutError') return true;
  if (error instanceof Error) return !/401|403|400|unauthorized|forbidden/i.test(error.message);
  return true;
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) {
    signal?.throwIfAborted();
    return Promise.resolve();
  }
  if (!signal) return new Promise((resolve) => setTimeout(resolve, ms));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new DOMException('The operation was aborted', 'AbortError'));
    };
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
  });
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isInteger(value) ? Math.max(1, value as number) : fallback;
}

function nonNegativeInteger(value: number | undefined, fallback: number): number {
  return Number.isInteger(value) ? Math.max(0, value as number) : fallback;
}

function positiveTimeout(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && (value ?? 0) > 0 ? value as number : fallback;
}

function formatErrorBody(body: string): string {
  const trimmed = body.trim();
  if (!trimmed) return 'No error details returned by the provider.';
  try {
    const parsed = JSON.parse(trimmed) as { error?: unknown; message?: unknown };
    if (typeof parsed.error === 'string' && parsed.error.trim()) return parsed.error.trim().slice(0, 500);
    if (parsed.error && typeof parsed.error === 'object' && typeof (parsed.error as { message?: unknown }).message === 'string') {
      const message = (parsed.error as { message: string }).message.trim();
      if (message) return message.slice(0, 500);
    }
    if (typeof parsed.message === 'string' && parsed.message.trim()) return parsed.message.trim().slice(0, 500);
  } catch {
    // Plain-text server errors are already useful diagnostics.
  }
  return trimmed.slice(0, 500);
}
