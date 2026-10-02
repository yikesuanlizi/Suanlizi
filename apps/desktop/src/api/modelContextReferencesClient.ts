import {
  assignedModelContextTokens,
  validateModelContextReferences,
  type ModelContextReference,
} from '@suanlizi/protocol';

export async function fetchModelContextReferences(signal?: AbortSignal): Promise<ModelContextReference[]> {
  const response = await fetch('/api/model-context-references', { signal });
  if (!response.ok) throw new Error('读取上下文参考列表失败');
  const body = await response.json() as { entries: unknown };
  return validateModelContextReferences(body.entries);
}

/** 仅在模型切换时赋值；参考列表后续变化不会反写已经选中的模型。 */
export async function contextTokensForSelectedModel(input: {
  provider: string;
  model: string;
  baseUrl: string;
  modelContextTokens?: number;
}): Promise<number | undefined> {
  if (input.modelContextTokens !== undefined) return input.modelContextTokens;
  let probe: { source?: 'server' | 'model' | 'unavailable'; contextTokens?: number } | undefined;
  try {
    const response = await fetch('/api/model-capabilities', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: input.provider, model: input.model, baseUrl: input.baseUrl }),
      signal: AbortSignal.timeout(12_000),
    });
    if (response.ok) probe = await response.json() as typeof probe;
  } catch { /* 无法探测时使用独立的参考列表。 */ }
  if (probe?.source === 'server' || probe?.source === 'model') {
    const recognized = assignedModelContextTokens({ model: input.model, probe, references: [] });
    if (recognized !== undefined) return recognized;
  }
  try {
    return assignedModelContextTokens({ model: input.model, references: await fetchModelContextReferences() });
  } catch { return undefined; }
}
