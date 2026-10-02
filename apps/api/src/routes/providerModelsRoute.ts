import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AgentRunConfig } from '../config/config.js';
import type { TenantRuntime } from '../runtime/tenantRuntime.js';
import type { TenantContext } from '../shared/tenant.js';
import { readJson, sendError, sendJson } from '../shared/http.js';

type ProviderModelsInput = Pick<AgentRunConfig, 'provider' | 'model' | 'baseUrl'>;

function providerModelsPatch(input: Partial<ProviderModelsInput>): Partial<ProviderModelsInput> {
  return {
    ...(typeof input.provider === 'string' ? { provider: input.provider.trim() } : {}),
    ...(typeof input.model === 'string' ? { model: input.model.trim() } : {}),
    ...(typeof input.baseUrl === 'string' ? { baseUrl: input.baseUrl.trim() } : {}),
  };
}

export async function handleProviderModelsRoute(
  req: IncomingMessage,
  res: ServerResponse,
  runtime: TenantRuntime,
  tenantContext: TenantContext,
): Promise<boolean> {
  if (req.method !== 'POST' || req.url?.split('?')[0] !== '/api/provider-models') return false;

  try {
    const body = await readJson<{ provider?: string; model?: string; baseUrl?: string; config?: Partial<ProviderModelsInput> }>(req);
    const input = body.config ?? body;
    const patch: Partial<ProviderModelsInput> = providerModelsPatch(input);
    if (!patch.model) patch.model = 'model-list';
    if (!patch.provider) {
      sendError(res, 400, 'Provider is required');
      return true;
    }
    const payload: Pick<AgentRunConfig, 'provider' | 'model' | 'baseUrl'> = {
      provider: patch.provider,
      model: patch.model,
      ...(patch.baseUrl !== undefined ? { baseUrl: patch.baseUrl } : {}),
    };
    sendJson(res, 200, await runtime.listProviderModels(payload, tenantContext));
  } catch (error) {
    sendError(res, 400, error instanceof Error ? error.message : String(error));
  }
  return true;
}
