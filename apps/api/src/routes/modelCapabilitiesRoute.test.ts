import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import type { ModelContextProbe, TenantRuntime } from '../runtime/tenantRuntime.js';
import type { TenantContext } from '../shared/tenant.js';
import { handleModelCapabilitiesRoute } from './modelCapabilitiesRoute.js';

function request(method: string, url: string, body: unknown = {}): IncomingMessage {
  return Object.assign(Readable.from([JSON.stringify(body)]), { method, url }) as IncomingMessage;
}

function response(): ServerResponse & { status?: number; body?: unknown } {
  const output = {
    writeHead(status: number) { output.status = status; return output; },
    end(raw: string) { output.body = raw ? JSON.parse(raw) : undefined; },
  } as unknown as ServerResponse & { status?: number; body?: unknown };
  return output;
}

const tenantContext: TenantContext = { tenantId: 'default' };

describe('model capabilities route', () => {
  it('probes only the selected provider, model, and endpoint', async () => {
    const probe: ModelContextProbe = {
      provider: 'llama_cpp',
      contextTokens: 65_536,
      source: 'server',
      reachable: true,
    };
    const probeModelCapabilities = vi.fn(async () => probe);
    const runtime = { probeModelCapabilities } as unknown as TenantRuntime;
    const res = response();

    await expect(handleModelCapabilitiesRoute(
      request('POST', '/api/model-capabilities', {
        provider: 'llama_cpp',
        model: 'Qwythos-9B-v2-MTP-Q4_K_M.gguf',
        baseUrl: 'http://127.0.0.1:8080/v1',
        apiKey: 'must-not-be-forwarded',
      }),
      res,
      runtime,
      tenantContext,
    )).resolves.toBe(true);

    expect(res.status).toBe(200);
    expect(res.body).toEqual(probe);
    expect(probeModelCapabilities).toHaveBeenCalledWith({
      provider: 'llama_cpp',
      model: 'Qwythos-9B-v2-MTP-Q4_K_M.gguf',
      baseUrl: 'http://127.0.0.1:8080/v1',
    }, tenantContext);
  });

  it('rejects requests without provider and model', async () => {
    const probeModelCapabilities = vi.fn();
    const runtime = { probeModelCapabilities } as unknown as TenantRuntime;
    const res = response();

    await expect(handleModelCapabilitiesRoute(
      request('POST', '/api/model-capabilities', { provider: 'llama_cpp' }),
      res,
      runtime,
      tenantContext,
    )).resolves.toBe(true);

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Provider and model are required' });
    expect(probeModelCapabilities).not.toHaveBeenCalled();
  });

  it('ignores other methods and paths', async () => {
    const runtime = { probeModelCapabilities: vi.fn() } as unknown as TenantRuntime;
    const res = response();

    await expect(handleModelCapabilitiesRoute(
      request('GET', '/api/model-capabilities'),
      res,
      runtime,
      tenantContext,
    )).resolves.toBe(false);
  });
});
