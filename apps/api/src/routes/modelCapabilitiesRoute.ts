import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AgentRunConfig } from '../config/config.js';
import type { TenantRuntime } from '../runtime/tenantRuntime.js';
import type { TenantContext } from '../shared/tenant.js';
import { readJson, sendError, sendJson } from '../shared/http.js';

type ModelProbeInput = Pick<AgentRunConfig, 'provider' | 'model' | 'baseUrl'>;

function modelProbePatch(input: Partial<ModelProbeInput>): Partial<ModelProbeInput> {
  return {
    ...(typeof input.provider === 'string' ? { provider: input.provider.trim() } : {}),
    ...(typeof input.model === 'string' ? { model: input.model.trim() } : {}),
    ...(typeof input.baseUrl === 'string' ? { baseUrl: input.baseUrl.trim() } : {}),
  };
}

export async function handleModelCapabilitiesRoute(
  req: IncomingMessage,
  res: ServerResponse,
  runtime: TenantRuntime,
  tenantContext: TenantContext,
): Promise<boolean> {
  if (req.method !== 'POST' || req.url?.split('?')[0] !== '/api/model-capabilities') return false;

  try {
    const body = await readJson<{ provider?: string; model?: string; baseUrl?: string; config?: Partial<ModelProbeInput> }>(req);
    const input = body.config ?? body;
    const patch = modelProbePatch(input);
    if (!patch.provider || !patch.model) {
      sendError(res, 400, 'Provider and model are required');
      return true;
    }
    sendJson(res, 200, await runtime.probeModelCapabilities(patch, tenantContext));
  } catch (error) {
    sendError(res, 400, error instanceof Error ? error.message : String(error));
  }
  return true;
}
