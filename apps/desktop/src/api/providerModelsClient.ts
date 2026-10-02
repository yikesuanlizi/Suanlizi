export interface ProviderModelList {
  provider: string;
  models: string[];
  error?: string;
}

export async function fetchProviderModels(
  input: { provider: string; baseUrl?: string },
  signal?: AbortSignal,
): Promise<ProviderModelList> {
  const response = await fetch('/api/provider-models', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider: input.provider.trim(), baseUrl: input.baseUrl?.trim() ?? '' }),
    signal,
  });
  const body = await response.json().catch(() => null) as (ProviderModelList & { error?: string }) | null;
  if (!response.ok || !body) {
    throw new Error(body?.error || '读取模型列表失败');
  }
  return body;
}