import type { AccessPolicyConfig, ThreadConfigUpdate } from '@suanlizi/protocol';
import type { RunConfig } from '../../config/config.js';
import { globalRuntimePayload } from './configState.js';

type Fetcher = typeof fetch;

async function patchConfig(
  fetcher: Fetcher,
  url: string,
  config: Partial<RunConfig>,
): Promise<void> {
  const payload = globalRuntimePayload(config);
  const response = await fetcher(url, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ config: payload }),
  });
  if (!response.ok) {
    throw new Error(`Failed to patch config: ${response.status} ${response.statusText}`);
  }
}

export const saveGlobalDefaults = (
  config: Partial<RunConfig>,
  fetcher: Fetcher = fetch,
): Promise<void> => patchConfig(fetcher, '/api/settings', config);

export async function saveGlobalAccessPolicy(
  accessPolicy: AccessPolicyConfig,
  fetcher: Fetcher = fetch,
): Promise<AccessPolicyConfig> {
  const response = await fetcher('/api/settings/access-policy', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ accessPolicy }),
  });
  if (!response.ok) {
    throw new Error(`Failed to save global access policy: ${response.status} ${response.statusText}`);
  }
  const data = (await response.json()) as { accessPolicy?: AccessPolicyConfig };
  return data.accessPolicy ?? accessPolicy;
}

export async function saveActiveThreadConfig(
  threadId: string,
  update: ThreadConfigUpdate,
  fetcher: Fetcher = fetch,
): Promise<void> {
  const response = await fetcher(`/api/threads/${threadId}/config`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(update),
  });
  if (!response.ok) {
    throw new Error(`Failed to patch thread config: ${response.status} ${response.statusText}`);
  }
}
