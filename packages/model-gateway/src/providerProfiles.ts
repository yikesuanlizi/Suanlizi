import { getProvider, normalizeProviderId, resolveProviderApiKeyEnvVars } from './providers.js';
import type { ModelConfig } from './types.js';

export type ModelEndpointFormat =
  | 'chat_completions'
  | 'responses'
  | 'anthropic_messages'
  | 'custom_endpoint';

export type ModelTransportId =
  | 'openai_chat_completions'
  | 'openai_responses'
  | 'anthropic_messages';

export type ToolHistoryMode =
  | 'openai_chat'
  | 'openai_responses'
  | 'anthropic_blocks';

export type ReasoningMode =
  | 'none'
  | 'deepseek_reasoning_content'
  | 'minimax_anthropic_thinking'
  | 'minimax_openai_reasoning_details'
  | 'anthropic_thinking'
  | 'openai_responses_items';

export type ProviderCacheMode =
  | 'none'
  | 'deepseek_native'
  | 'openai_prompt_details'
  | 'anthropic_cache_control';

export interface ProviderProfile {
  id: string;
  displayName: string;
  baseUrl: string;
  apiKeyEnvVars: string[];
  endpointFormat: ModelEndpointFormat;
  transport: ModelTransportId;
  toolHistoryMode: ToolHistoryMode;
  reasoningMode: ReasoningMode;
  cacheMode: ProviderCacheMode;
}

const KNOWN_PROFILES: Record<string, Omit<ProviderProfile, 'baseUrl' | 'apiKeyEnvVars'>> = {
  openai: {
    id: 'openai',
    displayName: 'OpenAI',
    endpointFormat: 'responses',
    transport: 'openai_responses',
    toolHistoryMode: 'openai_responses',
    reasoningMode: 'openai_responses_items',
    cacheMode: 'openai_prompt_details',
  },
  deepseek: {
    id: 'deepseek',
    displayName: 'DeepSeek',
    endpointFormat: 'chat_completions',
    transport: 'openai_chat_completions',
    toolHistoryMode: 'openai_chat',
    reasoningMode: 'deepseek_reasoning_content',
    cacheMode: 'deepseek_native',
  },
  anthropic: {
    id: 'anthropic',
    displayName: 'Anthropic',
    endpointFormat: 'anthropic_messages',
    transport: 'anthropic_messages',
    toolHistoryMode: 'anthropic_blocks',
    reasoningMode: 'anthropic_thinking',
    cacheMode: 'anthropic_cache_control',
  },
  minimax: {
    id: 'minimax',
    displayName: 'MiniMax',
    endpointFormat: 'anthropic_messages',
    transport: 'anthropic_messages',
    toolHistoryMode: 'anthropic_blocks',
    reasoningMode: 'minimax_anthropic_thinking',
    cacheMode: 'anthropic_cache_control',
  },
  gemini: {
    id: 'gemini',
    displayName: 'Google Gemini',
    endpointFormat: 'chat_completions',
    transport: 'openai_chat_completions',
    toolHistoryMode: 'openai_chat',
    reasoningMode: 'none',
    cacheMode: 'openai_prompt_details',
  },
  ollama: {
    id: 'ollama',
    displayName: 'Ollama',
    endpointFormat: 'responses',
    transport: 'openai_responses',
    toolHistoryMode: 'openai_responses',
    reasoningMode: 'openai_responses_items',
    cacheMode: 'openai_prompt_details',
  },
  lmstudio: {
    id: 'lmstudio',
    displayName: 'LM Studio',
    endpointFormat: 'responses',
    transport: 'openai_responses',
    toolHistoryMode: 'openai_responses',
    reasoningMode: 'openai_responses_items',
    cacheMode: 'openai_prompt_details',
  },
  vllm: {
    id: 'vllm',
    displayName: 'vLLM',
    endpointFormat: 'responses',
    transport: 'openai_responses',
    toolHistoryMode: 'openai_responses',
    reasoningMode: 'openai_responses_items',
    cacheMode: 'openai_prompt_details',
  },
  mistral: {
    id: 'mistral',
    displayName: 'Mistral AI',
    endpointFormat: 'chat_completions',
    transport: 'openai_chat_completions',
    toolHistoryMode: 'openai_chat',
    reasoningMode: 'none',
    cacheMode: 'openai_prompt_details',
  },
  perplexity: {
    id: 'perplexity',
    displayName: 'Perplexity',
    endpointFormat: 'chat_completions',
    transport: 'openai_chat_completions',
    toolHistoryMode: 'openai_chat',
    reasoningMode: 'none',
    cacheMode: 'openai_prompt_details',
  },
  xai: {
    id: 'xai',
    displayName: 'xAI',
    endpointFormat: 'responses',
    transport: 'openai_responses',
    toolHistoryMode: 'openai_responses',
    reasoningMode: 'openai_responses_items',
    cacheMode: 'openai_prompt_details',
  },
  qwen: {
    id: 'qwen',
    displayName: '通义千问 (Qwen)',
    endpointFormat: 'chat_completions',
    transport: 'openai_chat_completions',
    toolHistoryMode: 'openai_chat',
    reasoningMode: 'none',
    cacheMode: 'openai_prompt_details',
  },
  zhipu: {
    id: 'zhipu',
    displayName: '智谱 (ZhipuAI)',
    endpointFormat: 'chat_completions',
    transport: 'openai_chat_completions',
    toolHistoryMode: 'openai_chat',
    reasoningMode: 'none',
    cacheMode: 'openai_prompt_details',
  },
  kimi: {
    id: 'kimi',
    displayName: 'Kimi (Moonshot)',
    endpointFormat: 'chat_completions',
    transport: 'openai_chat_completions',
    toolHistoryMode: 'openai_chat',
    reasoningMode: 'none',
    cacheMode: 'openai_prompt_details',
  },
  volcengine: {
    id: 'volcengine',
    displayName: '火山引擎 Ark',
    endpointFormat: 'chat_completions',
    transport: 'openai_chat_completions',
    toolHistoryMode: 'openai_chat',
    reasoningMode: 'none',
    cacheMode: 'openai_prompt_details',
  },
  baidu: {
    id: 'baidu',
    displayName: '百度文心 (ERNIE)',
    endpointFormat: 'chat_completions',
    transport: 'openai_chat_completions',
    toolHistoryMode: 'openai_chat',
    reasoningMode: 'none',
    cacheMode: 'openai_prompt_details',
  },
  siliconflow: {
    id: 'siliconflow',
    displayName: '硅基流动 (SiliconFlow)',
    endpointFormat: 'chat_completions',
    transport: 'openai_chat_completions',
    toolHistoryMode: 'openai_chat',
    reasoningMode: 'none',
    cacheMode: 'openai_prompt_details',
  },
  giteeai: {
    id: 'giteeai',
    displayName: 'Gitee AI',
    endpointFormat: 'chat_completions',
    transport: 'openai_chat_completions',
    toolHistoryMode: 'openai_chat',
    reasoningMode: 'none',
    cacheMode: 'openai_prompt_details',
  },
  groq: {
    id: 'groq',
    displayName: 'Groq',
    endpointFormat: 'responses',
    transport: 'openai_responses',
    toolHistoryMode: 'openai_responses',
    reasoningMode: 'openai_responses_items',
    cacheMode: 'openai_prompt_details',
  },
  together: {
    id: 'together',
    displayName: 'Together AI',
    endpointFormat: 'chat_completions',
    transport: 'openai_chat_completions',
    toolHistoryMode: 'openai_chat',
    reasoningMode: 'none',
    cacheMode: 'openai_prompt_details',
  },
  openrouter: {
    id: 'openrouter',
    displayName: 'OpenRouter',
    endpointFormat: 'responses',
    transport: 'openai_responses',
    toolHistoryMode: 'openai_responses',
    reasoningMode: 'openai_responses_items',
    cacheMode: 'openai_prompt_details',
  },
  huggingface: {
    id: 'huggingface',
    displayName: 'Hugging Face',
    endpointFormat: 'responses',
    transport: 'openai_responses',
    toolHistoryMode: 'openai_responses',
    reasoningMode: 'openai_responses_items',
    cacheMode: 'openai_prompt_details',
  },
  nvidia: {
    id: 'nvidia',
    displayName: 'NVIDIA NIM',
    endpointFormat: 'chat_completions',
    transport: 'openai_chat_completions',
    toolHistoryMode: 'openai_chat',
    reasoningMode: 'none',
    cacheMode: 'openai_prompt_details',
  },
  llama_cpp: {
    id: 'llama_cpp',
    displayName: 'llama.cpp',
    endpointFormat: 'responses',
    transport: 'openai_responses',
    toolHistoryMode: 'openai_responses',
    reasoningMode: 'openai_responses_items',
    cacheMode: 'openai_prompt_details',
  },
};

export function getProviderProfile(providerId: string): ProviderProfile | undefined {
  const normalized = normalizeProviderId(providerId);
  const base = KNOWN_PROFILES[normalized];
  if (!base) return undefined;
  const provider = getProvider(normalized);
  return {
    ...base,
    baseUrl: provider?.baseUrl ?? '',
    apiKeyEnvVars: resolveProviderApiKeyEnvVars(normalized),
  };
}

export function resolveProviderProfile(config: Pick<ModelConfig, 'provider' | 'baseUrl' | 'model'>): ProviderProfile {
  const known = getProviderProfile(config.provider);
  if (known) {
    const profile = {
      ...known,
      baseUrl: config.baseUrl?.trim() || known.baseUrl,
    };
    return applyModelTransport(profile, config.model);
  }
  const provider = getProvider(config.provider);
  const baseUrl = config.baseUrl?.trim() || provider?.baseUrl || '';
  const providerName = config.provider.trim();
  const anthropic = provider?.protocol === 'anthropic';
  return {
    id: providerName || 'openai_compatible',
    displayName: provider?.name ?? (providerName || 'OpenAI-compatible'),
    baseUrl,
    apiKeyEnvVars: provider ? resolveProviderApiKeyEnvVars(provider.id) : [],
    endpointFormat: anthropic ? 'anthropic_messages' : 'chat_completions',
    transport: anthropic ? 'anthropic_messages' : 'openai_chat_completions',
    toolHistoryMode: anthropic ? 'anthropic_blocks' : 'openai_chat',
    reasoningMode: 'none',
    cacheMode: anthropic ? 'anthropic_cache_control' : 'openai_prompt_details',
  };
}

/** DeepSeek and Kimi expose Responses only for selected model families. */
function applyModelTransport(profile: ProviderProfile, model: string): ProviderProfile {
  const normalizedModel = model.trim().toLowerCase();
  const responsesSupported = profile.id === 'deepseek'
    ? isDeepSeekResponsesModel(normalizedModel)
    : profile.id === 'kimi'
      ? normalizedModel === 'kimi-k3'
      : true;
  if (!['deepseek', 'kimi'].includes(profile.id)) return profile;
  if (responsesSupported) {
    return {
      ...profile,
      endpointFormat: 'responses',
      transport: 'openai_responses',
      toolHistoryMode: 'openai_responses',
      reasoningMode: 'openai_responses_items',
    };
  }
  return {
    ...profile,
    endpointFormat: 'chat_completions',
    transport: 'openai_chat_completions',
    toolHistoryMode: 'openai_chat',
    reasoningMode: profile.id === 'deepseek' ? 'deepseek_reasoning_content' : 'none',
  };
}

/** DeepSeek Responses is limited to the published v4 model aliases. */
function isDeepSeekResponsesModel(model: string): boolean {
  const match = /^(deepseek-v4-(?:flash|pro|flash-vision-exp))(?:[-_.:]v?\d+(?:[.-]\d+)*)?$/.exec(model);
  return match !== null;
}
