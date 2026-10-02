export type ModelCapabilitySource = 'configured' | 'known-model' | 'unknown';

export interface ModelCapabilityInput {
  provider?: string;
  model?: string;
  baseUrl?: string;
  modelContextTokens?: number;
  modelMaxOutputTokens?: number;
}

export interface ModelCapabilities {
  provider: string;
  model: string;
  baseUrl: string;
  contextTokens?: number;
  maxOutputTokens?: number;
  contextSource: ModelCapabilitySource;
  outputSource: ModelCapabilitySource;
  matchedRule?: string;
  displayName: string;
}

interface ModelCapabilityRule {
  id: string;
  displayName: string;
  contextTokens: number;
  maxOutputTokens?: number;
  provider?: RegExp;
  model?: RegExp;
  baseUrl?: RegExp;
}

const MODEL_CAPABILITY_RULES: ModelCapabilityRule[] = [
  {
    id: 'deepseek-v4',
    displayName: 'DeepSeek V4',
    provider: /^deepseek$/,
    model: /^deepseek-v4-(?:pro|flash)$/i,
    contextTokens: 1_000_000,
    maxOutputTokens: 384_000,
  },
  {
    id: 'minimax-m3',
    displayName: 'MiniMax M3',
    provider: /^(?:minimax|openai_compatible)$/,
    model: /^minimax-m3$/i,
    baseUrl: /minimax/i,
    contextTokens: 1_000_000,
  },
  {
    id: 'minimax-m2.5',
    displayName: 'MiniMax M2.5',
    provider: /^minimax$/,
    model: /^minimax-m2\.?5/i,
    contextTokens: 196_608,
  },
  {
    id: 'glm-4.7',
    displayName: 'GLM-4.7',
    provider: /^(?:zhipu|glm|zai|openai_compatible|giteeai)$/,
    model: /^glm-4\.7/i,
    baseUrl: /(?:bigmodel|z\.ai|gitee)/i,
    contextTokens: 200_000,
    maxOutputTokens: 128_000,
  },
  {
    id: 'glm-5',
    displayName: 'GLM-5',
    provider: /^(?:zhipu|glm|zai)$/,
    model: /^glm-5/i,
    baseUrl: /(?:bigmodel|z\.ai)/i,
    contextTokens: 202_752,
  },
  {
    id: 'qwen-1m',
    displayName: 'Qwen 1M',
    provider: /^(?:qwen|dashscope|alibaba)$/,
    model: /^(?:qwen3-coder-(?:plus|flash)|qwen3\.[5-7]-plus|qwen2\.5-.+1m)$/i,
    baseUrl: /dashscope|aliyun|alibabacloud/i,
    contextTokens: 1_000_000,
  },
  {
    id: 'gitee-qwen3.8-flash-1m',
    displayName: 'Gitee Qwen3.8 Flash 1M',
    provider: /^(?:openai_compatible|giteeai)$/,
    model: /^qwen3.8-flash$/i,
    baseUrl: /ai.gitee.com(?:\/v1)?/i,
    contextTokens: 1_000_000,
  },
  {
    id: 'gitee-qwen3.8-27b-256k',
    displayName: 'Gitee Qwen3.8 27B 256K',
    provider: /^(?:openai_compatible|giteeai)$/,
    model: /^(?:qwen\/)?qwen3.8-27b(?::[^\s]+)?$/i,
    baseUrl: /ai.gitee.com(?:\/v1)?/i,
    contextTokens: 262_144,
  },
  {
    id: 'gitee-deepseek-v4-1m',
    displayName: 'Gitee DeepSeek V4 1M',
    provider: /^(?:openai_compatible|giteeai)$/,
    model: /^deepseek-v4-(?:pro|flash)(?:-\d{4,})?$/i,
    baseUrl: /ai.gitee.com(?:\/v1)?/i,
    contextTokens: 1_000_000,
    maxOutputTokens: 384_000,
  },
  {
    id: 'qwen-256k',
    displayName: 'Qwen 256K',
    provider: /^(?:qwen|dashscope|alibaba)$/,
    model: /^(?:qwen3-coder-(?:next|480b|30b)|qwen3-max-2026-01-23)/i,
    contextTokens: 262_144,
  },
  {
    id: 'qwen3.8-256k',
    displayName: 'Qwen3.8 256K',
    provider: /^(?:huggingface|hf)$/,
    model: /^(?:qwen\/)?qwen3\.8-27b(?::[^\s]+)?$/i,
    contextTokens: 262_144,
  },
  {
    id: 'kimi-k2',
    displayName: 'Kimi K2',
    provider: /^(?:kimi|moonshot)$/,
    model: /^kimi-k2/i,
    baseUrl: /moonshot|kimi/i,
    contextTokens: 262_144,
  },
  {
    id: 'moonshot-128k',
    displayName: 'Moonshot 128K',
    provider: /^(?:kimi|moonshot)$/,
    model: /^moonshot-v1-128k/i,
    contextTokens: 128_000,
  },
  {
    id: 'moonshot-32k',
    displayName: 'Moonshot 32K',
    provider: /^(?:kimi|moonshot)$/,
    model: /^moonshot-v1-32k/i,
    contextTokens: 32_000,
  },
  {
    id: 'moonshot-8k',
    displayName: 'Moonshot 8K',
    provider: /^(?:kimi|moonshot)$/,
    model: /^moonshot-v1-8k/i,
    contextTokens: 8_000,
  },
  {
    id: 'claude-200k',
    displayName: 'Claude 200K',
    provider: /^anthropic$/,
    model: /^claude/i,
    contextTokens: 200_000,
  },
];

export function resolveModelCapabilities(input: ModelCapabilityInput): ModelCapabilities {
  const provider = normalizeProvider(input.provider ?? '');
  const model = (input.model ?? '').trim();
  const baseUrl = (input.baseUrl ?? '').trim();
  const configuredContextTokens = positiveInt(input.modelContextTokens);
  const configuredOutputTokens = positiveInt(input.modelMaxOutputTokens);
  const rule = matchModelCapabilityRule(provider, model, baseUrl);
  const contextTokens = configuredContextTokens ?? rule?.contextTokens;
  const maxOutputTokens = configuredOutputTokens ?? rule?.maxOutputTokens;
  return {
    provider,
    model,
    baseUrl,
    contextTokens,
    maxOutputTokens,
    contextSource: configuredContextTokens ? 'configured' : rule ? 'known-model' : 'unknown',
    outputSource: configuredOutputTokens ? 'configured' : rule?.maxOutputTokens ? 'known-model' : 'unknown',
    matchedRule: rule?.id,
    displayName: rule?.displayName ?? (model || provider || 'Unknown model'),
  };
}

function matchModelCapabilityRule(provider: string, model: string, baseUrl: string): ModelCapabilityRule | undefined {
  const normalizedModel = model.trim();
  const normalizedBaseUrl = baseUrl.trim();
  return MODEL_CAPABILITY_RULES.find((rule) => {
    if (rule.provider && !rule.provider.test(provider)) return false;
    if (rule.model && !rule.model.test(normalizedModel)) return false;
    if (rule.baseUrl && !rule.baseUrl.test(normalizedBaseUrl)) return false;
    return Boolean(rule.provider || rule.model || rule.baseUrl);
  });
}

function normalizeProvider(provider: string): string {
  const normalized = provider.trim().toLowerCase();
  const aliases: Record<string, string> = {
    alibaba: 'qwen',
    dashscope: 'qwen',
    glm: 'zhipu',
    moonshot: 'kimi',
    zai: 'zhipu',
    'z-ai': 'zhipu',
    'z.ai': 'zhipu',
  };
  return aliases[normalized] ?? normalized;
}

function positiveInt(value: unknown): number | undefined {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return undefined;
  return Math.floor(numeric);
}
