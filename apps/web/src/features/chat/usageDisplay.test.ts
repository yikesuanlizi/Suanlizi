import { describe, expect, it } from 'vitest';
import { buildTokenTooltip, buildTokenUsageSummary, cacheContextPercent, contextUsagePercent, formatCacheDiagnostics, formatCompactionPressure, formatThreadTokenSummary, formatTokenSummary, resolveDisplayContextPressure } from './usageDisplay.js';

describe('formatTokenSummary', () => {
  it('does not expose cached tokens or a hit rate when the report is unknown', () => {
    expect(buildTokenUsageSummary({
      threadId: 'thread-unknown-cache',
      total: { inputTokens: 100, cachedInputTokens: 50, outputTokens: 20, reasoningOutputTokens: 0 },
      turns: [],
      updatedAt: '2026-06-11T00:00:00.000Z',
    }, 'zh')).toEqual({ totalCached: 0, totalOutput: 20, totalInput: 100, cacheLabel: '缓存' });
  });

  it('uses the stable cache-hit label when the provider omits a cache field', () => {
    expect(formatTokenSummary({
      inputTokens: 100,
      cachedInputTokens: 0,
      outputTokens: 20,
      reasoningOutputTokens: 0,
    }, 'zh')).toContain('缓存未上报');
  });

  it('shows cached input tokens and hit rate in Chinese', () => {
    expect(formatTokenSummary({
      inputTokens: 100,
      cachedInputTokens: 80,
      outputTokens: 20,
      reasoningOutputTokens: 0,
      cacheReported: true,
    }, 'zh')).toBe('Token：输入 100，缓存 80，命中率 80%，输出 20');
  });

  it('names DeepSeek cache hits when the usage carries a DeepSeek strategy', () => {
    expect(formatTokenSummary({
      inputTokens: 100,
      cachedInputTokens: 80,
      outputTokens: 20,
      reasoningOutputTokens: 0,
      cacheStrategy: 'deepseek-native',
      cacheReported: true,
    }, 'zh')).toBe('Token：输入 100，DeepSeek 缓存 80，命中率 80%，输出 20');
  });

  it('keeps English token text compact', () => {
    expect(formatTokenSummary({
      inputTokens: 50,
      cachedInputTokens: 0,
      outputTokens: 10,
      reasoningOutputTokens: 0,
      cacheReported: true,
    }, 'en')).toBe('Tokens: input 50, cache 0, hit 0%, output 10');
  });

  it('separates latest turn cache hit rate from cumulative usage', () => {
    expect(formatThreadTokenSummary({
      threadId: 'thread-1',
      turns: [
        {
          turnId: 'turn-1',
          timestamp: '2026-06-11T00:00:00.000Z',
          usage: {
            inputTokens: 100,
            cachedInputTokens: 50,
            outputTokens: 10,
            reasoningOutputTokens: 0,
            cacheStrategy: 'deepseek-native',
            cacheReported: true,
          },
        },
        {
          turnId: 'turn-2',
          timestamp: '2026-06-11T00:01:00.000Z',
          usage: {
            inputTokens: 100,
            cachedInputTokens: 90,
            outputTokens: 12,
            reasoningOutputTokens: 0,
            cacheStrategy: 'deepseek-native',
            cacheReported: true,
          },
        },
      ],
      total: {
        inputTokens: 200,
        cachedInputTokens: 140,
        outputTokens: 22,
        reasoningOutputTokens: 0,
        cacheStrategy: 'deepseek-native',
        cacheReported: true,
      },
      updatedAt: '2026-06-11T00:01:00.000Z',
    }, 'zh')).toBe('Token：本轮 输入 100，DeepSeek 缓存 90，命中率 90%，输出 12；累计 输入 200，缓存 140，命中率 70%，输出 22');
  });

  it('formats cache diagnostics without exposing long hashes', () => {
    expect(formatCacheDiagnostics({
      stable: false,
      reasons: ['system', 'tools'],
      shape: { prefixHash: 'abcdef1234567890' },
    }, 'zh')).toBe('缓存前缀变化：system、tools · abcdef12');
  });

  it('formats soft compaction pressure as a warning', () => {
    expect(formatCompactionPressure({
      status: 'soft',
      estimatedTokens: 600,
      hardThreshold: 800,
    }, 'zh')).toBe('上下文接近压缩阈值：600/800');
  });

  it('ignores an internal runtime fallback window when the window is not known', () => {
    expect(resolveDisplayContextPressure({
      estimatedTokens: 40_000,
      maxTokens: 40_000,
      windowKnown: false,
    }, null)).toBeNull();
  });

  it('uses an explicitly known runtime window', () => {
    const pressure = resolveDisplayContextPressure({
      estimatedTokens: 10_000,
      maxTokens: 100_000,
      windowKnown: true,
    }, null);

    expect(pressure).toMatchObject({ maxTokens: 100_000, windowSource: 'runtime' });
  });

  it('uses model capabilities to correct stale runtime context window display', () => {
    const pressure = resolveDisplayContextPressure({
      estimatedTokens: 40_000,
      maxTokens: 40_000,
      softThreshold: 20_000,
      hardThreshold: 32_000,
    }, {
      provider: 'minimax',
      model: 'MiniMax-M3',
      baseUrl: '',
      contextTokens: 1_000_000,
      contextSource: 'known-model',
      outputSource: 'unknown',
      displayName: 'MiniMax M3',
    });

    expect(pressure).toMatchObject({
      estimatedTokens: 40_000,
      maxTokens: 1_000_000,
      softThreshold: 500_000,
      hardThreshold: 800_000,
      windowSource: 'known-model',
    });
    expect(contextUsagePercent(pressure)).toBe(4);
    expect(cacheContextPercent({ totalCached: 120_000 }, pressure)).toBe(12);
    expect(buildTokenTooltip(null, pressure, 'zh')).toContain('窗口来源: MiniMax M3');
  });
});
