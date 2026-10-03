import type { AccessPolicyConfig, ThreadRunConfigOverrides } from '@suanlizi/protocol';

export type ThreadConfigOverrides = Pick<
  ThreadRunConfigOverrides,
  'provider' | 'model' | 'baseUrl' | 'modelContextTokens' | 'modelMaxOutputTokens' | 'permissions' | 'reasoningEffort' | 'compactionThreshold'
>;

export interface ThreadConfigResponse {
  overrides: ThreadConfigOverrides;
  accessPolicy?: AccessPolicyConfig | null;
}

export async function fetchThreadConfigOverrides(threadId: string): Promise<ThreadConfigOverrides> {
  const response = await fetch(`/api/threads/${threadId}/config`);
  if (!response.ok) {
    return {};
  }
  const data = (await response.json()) as ThreadConfigResponse;
  return data.overrides ?? {};
}

export async function patchThreadConfigOverrides(
  threadId: string,
  overrides: ThreadConfigOverrides,
): Promise<ThreadConfigOverrides> {
  const payload: Record<string, unknown> = { ...overrides };
  for (const key of ['modelContextTokens', 'modelMaxOutputTokens'] as const) {
    if (Object.hasOwn(overrides, key) && overrides[key] === undefined) {
      payload[key] = null;
    }
  }
  const response = await fetch(`/api/threads/${threadId}/config`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ overrides: payload }),
  });
  if (!response.ok) {
    throw new Error('Failed to patch thread config overrides');
  }
  const data = (await response.json()) as ThreadConfigResponse;
  return data.overrides ?? {};
}

export async function fetchThreadAccessPolicy(threadId: string): Promise<AccessPolicyConfig | null> {
  const response = await fetch(`/api/threads/${threadId}/config`);
  if (!response.ok) {
    return null;
  }
  const data = (await response.json()) as ThreadConfigResponse;
  return data.accessPolicy ?? null;
}

export async function patchThreadAccessPolicy(
  threadId: string,
  accessPolicy: AccessPolicyConfig,
): Promise<AccessPolicyConfig | null> {
  const response = await fetch(`/api/threads/${threadId}/config`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ accessPolicy }),
  });
  if (!response.ok) {
    throw new Error('Failed to patch thread access policy');
  }
  const data = (await response.json()) as ThreadConfigResponse;
  return data.accessPolicy ?? null;
}
