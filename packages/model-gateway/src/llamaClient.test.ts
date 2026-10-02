import { afterEach, describe, expect, it } from 'vitest';
import { LlamaCppClient, normalizeLlamaUrls } from './llamaClient.js';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('normalizeLlamaUrls', () => {
  it('accepts a server root and derives the two llama-server endpoint bases', () => {
    expect(normalizeLlamaUrls('http://127.0.0.1:8080/')).toEqual({
      serverBaseUrl: 'http://127.0.0.1:8080',
      apiBaseUrl: 'http://127.0.0.1:8080/v1',
    });
  });

  it('does not duplicate /v1 when the configured URL already includes it', () => {
    expect(normalizeLlamaUrls('http://127.0.0.1:8080/v1/')).toEqual({
      serverBaseUrl: 'http://127.0.0.1:8080',
      apiBaseUrl: 'http://127.0.0.1:8080/v1',
    });
  });

  it('preserves a reverse-proxy path while keeping management routes at its root', () => {
    expect(normalizeLlamaUrls('https://llama.example.test/models/v1')).toEqual({
      serverBaseUrl: 'https://llama.example.test/models',
      apiBaseUrl: 'https://llama.example.test/models/v1',
    });
  });
});

describe('LlamaCppClient', () => {
  it('routes management endpoints and chat to the correct URL bases', async () => {
    const urls: string[] = [];
    const requests: RequestInit[] = [];
    globalThis.fetch = async (url, init) => {
      urls.push(String(url));
      requests.push(init ?? {});
      return new Response(JSON.stringify({ data: [{ id: 'Qwen3' }] }), { status: 200 });
    };
    const client = new LlamaCppClient({
      baseUrl: 'http://127.0.0.1:8080',
      headers: { Authorization: 'Bearer test' },
    });

    await client.getProps();
    await client.getMetrics();
    await client.getSlots();
    await client.getModels();
    await client.chat({ model: 'Qwen3', messages: [{ role: 'user', content: 'hello' }], stream: false });

    expect(urls).toEqual([
      'http://127.0.0.1:8080/props',
      'http://127.0.0.1:8080/metrics',
      'http://127.0.0.1:8080/slots',
      'http://127.0.0.1:8080/v1/models',
      'http://127.0.0.1:8080/v1/chat/completions',
    ]);
    expect(requests.at(-1)?.headers).toEqual({
      Authorization: 'Bearer test',
      'Content-Type': 'application/json',
    });
  });

  it('keeps provider diagnostics readable for failed chat responses', async () => {
    globalThis.fetch = async () => new Response(JSON.stringify({
      error: { code: 400, message: 'Jinja Exception: System message must be at the beginning.' },
    }), { status: 400 });
    const client = new LlamaCppClient({ baseUrl: 'http://127.0.0.1:8080/v1', retry: { maxAttempts: 1 } });

    await expect(client.chat({ model: 'Qwen3', messages: [], stream: false }))
      .rejects.toThrow('llama.cpp gateway error (400): Jinja Exception: System message must be at the beginning.');
  });

  it('stops retrying promptly when the caller aborts', async () => {
    const controller = new AbortController();
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      return new Response('busy', { status: 503 });
    };
    const client = new LlamaCppClient({
      baseUrl: 'http://127.0.0.1:8080',
      retry: { maxAttempts: 3, initialDelayMs: 50, maxDelayMs: 50 },
    });
    const pending = client.getMetrics({ signal: controller.signal });
    controller.abort(new Error('cancelled'));
    await expect(pending).rejects.toBeTruthy();
    expect(calls).toBe(1);
  });

  it('recreates the timeout signal for each retry and exposes a typed timeout', async () => {
    const signals: AbortSignal[] = [];
    globalThis.fetch = async (_url, init) => {
      const signal = init?.signal as AbortSignal;
      signals.push(signal);
      throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    };
    const client = new LlamaCppClient({
      baseUrl: 'http://127.0.0.1:8080',
      timeoutMs: 10,
      retry: { maxAttempts: 2, initialDelayMs: 0, maxDelayMs: 0 },
    });

    await expect(client.getMetrics()).rejects.toMatchObject({ code: 'MODEL_REQUEST_TIMEOUT', timeoutMs: 10 });
    expect(signals).toHaveLength(2);
    expect(signals[0]).not.toBe(signals[1]);
  });
});
