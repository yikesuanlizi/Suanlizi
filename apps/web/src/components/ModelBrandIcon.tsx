import React from 'react';
import { modelBrandSvg } from './modelBrandSvg.js';
import { validProviderIconUrl } from '@suanlizi/protocol';

type BrandKey = keyof typeof modelBrandSvg;

const MODEL_BRAND_MATCHERS: Array<[BrandKey, RegExp]> = [
  ['deepseek', /deepseek/],
  ['zhipu', /(?:glm|zhipu)/],
  ['kimi', /(?:kimi|moonshot)/],
  ['qwen', /(?:qwen|tongyi|dashscope)/],
  ['baidu', /(?:ernie|baidu|wenxin)/],
  ['doubao', /doubao/],
  ['openai', /(?:gpt|openai)/],
  ['meta', /(?:llama|meta)/],
  ['anthropic', /(?:claude|anthropic)/],
  ['gemini', /(?:gemini|google)/],
  ['mistral', /mistral/],
  ['perplexity', /(?:sonar|perplexity)/],
  ['grok', /(?:grok|xai)/],
  ['minimax', /minimax/],
  ['nvidia', /(?:nvidia|nemotron)/],
  ['huggingface', /(?:hugging[ _-]?face|hf[ _-]?inference)/],
  ['giteeai', /(?:gitee|giteeai)/],
  ['siliconcloud', /(?:silicon[ _-]?cloud|siliconflow)/],
  ['vllm', /vllm/],
  ['ollama', /ollama/],
  ['lmstudio', /(?:lm[ _-]?studio)/],
];

const PROVIDER_BRANDS: Record<string, BrandKey> = {
  openai: 'openai',
  deepseek: 'deepseek',
  zhipu: 'zhipu',
  kimi: 'kimi',
  moonshot: 'kimi',
  qwen: 'qwen',
  dashscope: 'qwen',
  baidu: 'baidu',
  volcengine: 'volcengine',
  siliconflow: 'siliconcloud',
  siliconcloud: 'siliconcloud',
  vllm: 'vllm',
  gitee: 'giteeai',
  giteeai: 'giteeai',
  groq: 'groq',
  together: 'together',
  openrouter: 'openrouter',
  huggingface: 'huggingface',
  hf: 'huggingface',
  nvidia: 'nvidia',
  nim: 'nvidia',
  'nvidia-nim': 'nvidia',
  gemini: 'gemini',
  google: 'gemini',
  mistral: 'mistral',
  perplexity: 'perplexity',
  xai: 'grok',
  anthropic: 'anthropic',
  minimax: 'minimax',
  ollama: 'ollama',
  lmstudio: 'lmstudio',
  llama_cpp: 'meta',
  'llama.cpp': 'meta',
  'llama-cpp': 'meta',
  llamacpp: 'meta',
};

/**
 * 品牌图标只用于明确接入的内置厂商。
 * 自定义/通用兼容端点是独立渠道，禁止根据模型名猜测成智谱、OpenAI 等厂商。
 */
export function modelBrandKey(model?: string, provider?: string): BrandKey | undefined {
  const normalizedProvider = provider?.trim().toLowerCase() ?? '';
  if (normalizedProvider === 'openai_compatible' || normalizedProvider.startsWith('custom_')) {
    return undefined;
  }

  const byProvider = PROVIDER_BRANDS[normalizedProvider];
  if (byProvider) return byProvider;

  // 已标明但不认识的 provider 可能仍是第三方端点，不能再用模型名反推品牌。
  if (normalizedProvider) return undefined;

  const normalizedModel = model?.trim().toLowerCase() ?? '';
  const byModel = MODEL_BRAND_MATCHERS.find(([, pattern]) => pattern.test(normalizedModel));
  if (byModel) return byModel[0];
  return undefined;
}

// LobeHub Icons: @lobehub/icons-static-svg v1.94.0 (MIT).
// 图标以本地 data URL 按需内置；自定义厂商只使用实际保存的站点图标。
export function ModelBrandIcon({ model, provider, iconUrl }: { model?: string; provider?: string; iconUrl?: string; providerName?: string; baseUrl?: string }) {
  const isCustom = (provider ?? '').trim().toLowerCase().startsWith('custom_');
  const customIconUrl = iconUrl && validProviderIconUrl(iconUrl) ? iconUrl : undefined;
  const imageUrl = customIconUrl;
  const [faviconFailed, setFaviconFailed] = React.useState(false);
  React.useEffect(() => { setFaviconFailed(false); }, [imageUrl]);
  if (imageUrl && !faviconFailed) {
    return <img alt="" aria-hidden="true" className="modelBrandIcon brand-custom" referrerPolicy="no-referrer" onError={() => setFaviconFailed(true)} src={imageUrl} />;
  }

  // 无真实站点图标时留空，不使用通用图标，也不推断品牌。
  if (isCustom) return null;

  const brandKey = modelBrandKey(model, provider);
  if (!brandKey) return null;

  return <img alt="" aria-hidden="true" className={`modelBrandIcon brand-${brandKey}`} src={modelBrandSvg[brandKey]} />;
}
