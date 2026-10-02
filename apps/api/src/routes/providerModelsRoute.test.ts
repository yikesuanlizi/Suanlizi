
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import type { ProviderModelList, TenantRuntime } from '../runtime/tenantRuntime.js';
import type { TenantContext } from '../shared/tenant.js';
import { handleProviderModelsRoute } from './providerModelsRoute.js';

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

describe('provider models route', () => {
  it('lists models without forwarding or returning a provider API key', async () => {
    const list: ProviderModelList = { provider: 'openai_compatible', models: ['model-a', 'model-b'] };
    const listProviderModels = vi.fn(async () => list);
    const runtime = { listProviderModels } as unknown as TenantRuntime;
    const res = response();

    await expect(handleProviderModelsRoute(
      request('POST', '/api/provider-models', {
        provider: 'openai_compatible',
        baseUrl: 'https://api.example.test/v1',
        apiKey: 'must-not-be-forwarded',
      }),
      res,
      runtime,
      tenantContext,
    )).resolves.toBe(true);

    expect(res.status).toBe(200);
    expect(res.body).toEqual(list);
    expect(listProviderModels).toHaveBeenCalledWith({
      provider: 'openai_compatible',
      model: 'model-list',
      baseUrl: 'https://api.example.test/v1',
    }, tenantContext);
  });

  it('requires a provider and ignores other methods', async () => {
    const listProviderModels = vi.fn();
    const runtime = { listProviderModels } as unknown as TenantRuntime;
    const missing = response();
    await expect(handleProviderModelsRoute(request('POST', '/api/provider-models', {}), missing, runtime, tenantContext)).resolves.toBe(true);
    expect(missing.status).toBe(400);
    const rejected = response();
    await expect(handleProviderModelsRoute(request('GET', '/api/provider-models'), rejected, runtime, tenantContext)).resolves.toBe(false);
    expect(listProviderModels).not.toHaveBeenCalled();
  });
});
