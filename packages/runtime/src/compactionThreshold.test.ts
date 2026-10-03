import { describe, expect, it } from 'vitest';
import { compactionOptionsForThreshold, compactionOptionsForModelContext, normalizeCompactionThreshold, DEFAULT_COMPACTION_THRESHOLD } from './compactionPolicy.js';

describe('compaction threshold', () => {
  it('uses the user threshold as the hard ratio', () => {
    expect(compactionOptionsForThreshold(0.8).hardCompactRatio).toBe(0.8);
    expect(compactionOptionsForThreshold(0.6).hardCompactRatio).toBe(0.6);
  });

  it('keeps a soft ratio at or below the hard ratio', () => {
    for (const t of [0.3, 0.5, 0.8, 0.95]) {
      const o = compactionOptionsForThreshold(t);
      expect(o.softCompactRatio).toBeLessThanOrEqual(o.hardCompactRatio);
    }
  });

  it('clamps out-of-range thresholds', () => {
    expect(normalizeCompactionThreshold(0.1)).toBe(0.3);
    expect(normalizeCompactionThreshold(2)).toBe(0.95);
    expect(normalizeCompactionThreshold(undefined)).toBe(DEFAULT_COMPACTION_THRESHOLD);
    expect(normalizeCompactionThreshold(Number.NaN)).toBe(DEFAULT_COMPACTION_THRESHOLD);
  });

  it('carries the threshold through the model-context helper', () => {
    const o = compactionOptionsForModelContext(128000, 0.6) as { maxTokens?: number; hardCompactRatio: number };
    expect(o.maxTokens).toBe(128000);
    expect(o.hardCompactRatio).toBe(0.6);
  });

  it('uses one model-context policy without a profile switch', () => {
    expect(compactionOptionsForModelContext(100000)).toEqual({
      maxTokens: 100000,
      softCompactRatio: 0.5,
      hardCompactRatio: 0.8,
      strategy: 'llm',
    });
  });
});
