/** 仅供用户选取并复制的上下文参考文本，不代表厂商或模型能力探测结果。 */
export interface ModelContextReference {
  model: string;
  contextTokens: number;
}

// 首次打开时的参考值。此后用户的完整列表独立持久化；删除预置项不会自动恢复。
export const DEFAULT_MODEL_CONTEXT_REFERENCES: readonly ModelContextReference[] = [
  // 这些是可编辑的参考项，不是厂商身份识别，也不是服务端能力声明。
  { model: 'gpt-g-luna', contextTokens: 1_000_000 },
  { model: 'gpt-6-luna', contextTokens: 1_000_000 },
  { model: 'gpt-6-sol', contextTokens: 1_000_000 },
  { model: 'deepseek-4.1-flash', contextTokens: 1_000_000 },
  { model: 'glm-5.3-flash', contextTokens: 202_752 },
  { model: 'deepseek-v4-pro', contextTokens: 1_000_000 },
  { model: 'deepseek-v4-flash', contextTokens: 1_000_000 },
  { model: 'glm-4.7-flash', contextTokens: 200_000 },
  { model: 'qwen3.8-flash', contextTokens: 1_000_000 },
  { model: 'moonshot-v1-128k', contextTokens: 128_000 },
];

export function modelContextReferenceFor(entries: readonly ModelContextReference[], model: string): ModelContextReference | undefined {
  const key = model.trim().toLocaleLowerCase();
  return key ? entries.find((entry) => entry.model.trim().toLocaleLowerCase() === key) : undefined;
}

/** 拒绝无效或重复条目，而不是静默删掉用户正在编辑的文本。 */
export function validateModelContextReferences(input: unknown): ModelContextReference[] {
  if (!Array.isArray(input) || input.length > 200) throw new Error('Invalid context reference list');
  const seen = new Set<string>();
  return input.map((entry: unknown) => {
    if (!entry || typeof entry !== 'object') throw new Error('Invalid context reference');
    const { model, contextTokens } = entry as Record<string, unknown>;
    if (typeof model !== 'string' || !model.trim() || model.trim().length > 200
      || typeof contextTokens !== 'number' || !Number.isSafeInteger(contextTokens)
      || contextTokens < 1 || contextTokens > 100_000_000) {
      throw new Error('A model name and a positive context length are required');
    }
    const key = model.trim().toLocaleLowerCase();
    if (seen.has(key)) throw new Error('Duplicate context reference model');
    seen.add(key);
    return { model: model.trim(), contextTokens };
  });
}

/** 选中模型时复制一次能力/参考值；此后修改参考列表不反写已配置模型。 */
export function assignedModelContextTokens(input: {
  model: string;
  configured?: number;
  probe?: { source?: 'server' | 'model' | 'unavailable'; contextTokens?: number };
  references: readonly ModelContextReference[];
}): number | undefined {
  if (input.configured !== undefined) return input.configured;
  if ((input.probe?.source === 'server' || input.probe?.source === 'model')
    && typeof input.probe.contextTokens === 'number' && Number.isSafeInteger(input.probe.contextTokens) && input.probe.contextTokens > 0) {
    return input.probe.contextTokens;
  }
  return modelContextReferenceFor(input.references, input.model)?.contextTokens;
}
