import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  listAllProviders,
  listApiKeyEnvVarCandidates,
  readApiKeyEnvironmentValue,
  removeApiKey,
  resolveApiKey,
  resolveProviderApiKeyEnvVar,
  saveApiKey,
  saveProviderApiKeyEnvVar,
  saveRuntimeEnvironmentVariables,
} from '@suanlizi/model-gateway';
import type { ApiKeyState } from '../config/config.js';
import { readJson, sendError, sendJson } from '../shared/http.js';

function maskKey(key: string): string {
  return key.length > 8 ? `${key.slice(0, 4)}...${key.slice(-4)}` : '****';
}

export function listApiKeyStates(): ApiKeyState[] {
  return listAllProviders()
    .map((provider) => {
      const key = resolveApiKey(provider.id);
      const envCandidates = listApiKeyEnvVarCandidates(provider.id);
      const preferredEnvVar = resolveProviderApiKeyEnvVar(provider.id);
      const envSearchOrder = [...new Set([
        preferredEnvVar,
        ...envCandidates,
      ].filter((candidate): candidate is string => Boolean(candidate?.trim())))];
      const configuredEnvVar = envSearchOrder.find((candidate) => Boolean(readApiKeyEnvironmentValue(candidate)));
      const envVar = configuredEnvVar ?? preferredEnvVar;
      return {
        providerId: provider.id,
        envVar,
        defaultEnvVar: provider.apiKeyEnvVar,
        envVarCandidates: envCandidates,
        configured: Boolean(key),
        source: key ? (configuredEnvVar ? 'env' : 'config') : null,
        masked: key ? maskKey(key) : null,
      };
    });
}

export async function handleKeysRoute(
  req: IncomingMessage,
  res: ServerResponse,
  segments: string[],
  pathname: string,
): Promise<boolean> {
  if (req.method === 'GET' && pathname === '/api/keys') {
    sendJson(res, 200, { keys: listApiKeyStates() });
    return true;
  }
  if (req.method === 'GET' && pathname === '/api/keys/env-vars') {
    sendJson(res, 200, { envVars: listApiKeyEnvVarCandidates() });
    return true;
  }
  if (req.method === 'PATCH' && pathname === '/api/keys/env') {
    const body = await readJson<{ variables?: Record<string, string>; text?: string }>(req);
    const variables = {
      ...parseEnvAssignmentText(body.text ?? ''),
      ...(body.variables ?? {}),
    };
    try {
      saveRuntimeEnvironmentVariables(variables);
    } catch (error) {
      sendError(res, 400, error instanceof Error ? error.message : String(error));
      return true;
    }
    sendJson(res, 200, { ok: true, keys: listApiKeyStates(), envVars: listApiKeyEnvVarCandidates() });
    return true;
  }
  if (req.method === 'PATCH' && segments[0] === 'api' && segments[1] === 'keys' && segments[2] && segments[3] === 'env-var') {
    const body = await readJson<{ envVar?: string }>(req);
    try {
      saveProviderApiKeyEnvVar(segments[2], body.envVar ?? '');
    } catch (error) {
      sendError(res, 400, error instanceof Error ? error.message : String(error));
      return true;
    }
    sendJson(res, 200, { ok: true, keys: listApiKeyStates() });
    return true;
  }
  if (req.method === 'POST' && segments[0] === 'api' && segments[1] === 'keys' && segments[2]) {
    const body = await readJson<{ apiKey?: string }>(req);
    const apiKey = body.apiKey?.trim();
    if (!apiKey) {
      sendError(res, 400, 'API key is required');
      return true;
    }
    saveApiKey(segments[2], apiKey);
    sendJson(res, 200, { ok: true, keys: listApiKeyStates() });
    return true;
  }
  if (req.method === 'DELETE' && segments[0] === 'api' && segments[1] === 'keys' && segments[2]) {
    removeApiKey(segments[2]);
    sendJson(res, 200, { ok: true, keys: listApiKeyStates() });
    return true;
  }
  return false;
}

function parseEnvAssignmentText(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim().replace(/^['"]|['"]$/g, '');
    if (key && value) result[key] = value;
  }
  return result;
}
