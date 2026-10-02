import { describe, expect, it } from 'vitest';
import { resolveModelCapabilities } from './modelCapabilities.js';

describe('resolveModelCapabilities', () => {
  it('uses explicit configured context tokens before model heuristics', () => {
    expect(resolveModelCapabilities({
      provider: 'minimax',
      model: 'MiniMax-M3',
      modelContextTokens: 128_000,
      modelMaxOutputTokens: 16_000,
    })).toMatchObject({
      contextTokens: 128_000,
      maxOutputTokens: 16_000,
      contextSource: 'configured',
      outputSource: 'configured',
    });
  });

  it('recognizes MiniMax M3 even when routed through OpenAI-compatible config', () => {
    expect(resolveModelCapabilities({
      provider: 'openai_compatible',
      model: 'MiniMax-M3',
      baseUrl: 'https://api.minimaxi.com/anthropic/v1',
    })).toMatchObject({
      contextTokens: 1_000_000,
      contextSource: 'known-model',
      matchedRule: 'minimax-m3',
    });
  });

  it('recognizes DeepSeek V4 million-token models', () => {
    expect(resolveModelCapabilities({
      provider: 'deepseek',
      model: 'deepseek-v4-pro',
    })).toMatchObject({
      contextTokens: 1_000_000,
      maxOutputTokens: 384_000,
      matchedRule: 'deepseek-v4',
    });
  });

  it('recognizes GLM 4.7 through custom Gitee-compatible routing', () => {
    expect(resolveModelCapabilities({
      provider: 'openai_compatible',
      model: 'GLM-4.7-Flash',
      baseUrl: 'https://ai.gitee.com/v1',
    })).toMatchObject({
      contextTokens: 200_000,
      maxOutputTokens: 128_000,
      matchedRule: 'glm-4.7',
    });
  });

  it('recognizes Gitee Qwen3.8 Flash as a million-token model', () => {
    expect(resolveModelCapabilities({
      provider: 'openai_compatible',
      model: 'qwen3.8-flash',
      baseUrl: 'https://ai.gitee.com/v1',
    })).toMatchObject({
      contextTokens: 1_000_000,
      contextSource: 'known-model',
      matchedRule: 'gitee-qwen3.8-flash-1m',
    });
  });

  it('recognizes Gitee Qwen3.8 27B as 256K without treating all Gitee models as 1M', () => {
    expect(resolveModelCapabilities({
      provider: 'openai_compatible',
      model: 'qwen3.8-27b',
      baseUrl: 'https://ai.gitee.com/v1',
    })).toMatchObject({
      contextTokens: 262_144,
      matchedRule: 'gitee-qwen3.8-27b-256k',
    });
    expect(resolveModelCapabilities({
      provider: 'openai_compatible',
      model: 'some-gitee-model',
      baseUrl: 'https://ai.gitee.com/v1',
    })).toMatchObject({
      contextTokens: undefined,
      contextSource: 'unknown',
    });
  });

  it('recognizes dated Gitee DeepSeek V4 Flash models', () => {
    expect(resolveModelCapabilities({
      provider: 'openai_compatible',
      model: 'deepseek-v4-flash-0731',
      baseUrl: 'https://ai.gitee.com/v1',
    })).toMatchObject({
      contextTokens: 1_000_000,
      maxOutputTokens: 384_000,
      matchedRule: 'gitee-deepseek-v4-1m',
    });
  });

  it('leaves unknown local models unresolved instead of pretending a fixed window', () => {
    expect(resolveModelCapabilities({
      provider: 'ollama',
      model: 'some-local-model',
    })).toMatchObject({
      contextTokens: undefined,
      contextSource: 'unknown',
    });
  });
});
