import type { CompactOptions } from '@suanlizi/memory';

/** Runtime OS 是唯一的运行模式。 */
/** 统一的压缩策略：LLM 摘要 + 固定软/硬阈值。 */
export const COMPACTION_SOFT_RATIO = 0.5;
export const COMPACTION_HARD_RATIO = 0.8;

/** 用户可调的压缩阈值：占模型上下文窗口的比例（0.3 ~ 0.95）。 */
export const DEFAULT_COMPACTION_THRESHOLD = COMPACTION_HARD_RATIO;
export const MIN_COMPACTION_THRESHOLD = 0.3;
export const MAX_COMPACTION_THRESHOLD = 0.95;

export function normalizeCompactionThreshold(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_COMPACTION_THRESHOLD;
  const clamped = Math.min(MAX_COMPACTION_THRESHOLD, Math.max(MIN_COMPACTION_THRESHOLD, parsed));
  return Math.round(clamped * 100) / 100;
}

/**
 * 压缩选项：硬阈值 = 用户设置的压缩阈值；软阈值按比例前移到 0.625 * hard，
 * 这样“达到阈值就压缩”的直觉成立，同时在接近阈值时提前给出压力提示。
 */
export function defaultCompactionOptions(): Pick<CompactOptions, 'softCompactRatio' | 'hardCompactRatio' | 'strategy'> {
  return {
    softCompactRatio: COMPACTION_SOFT_RATIO,
    hardCompactRatio: COMPACTION_HARD_RATIO,
    strategy: 'llm',
  };
}

/** 按用户设置的阈值产出压缩选项。 */
export function compactionOptionsForThreshold(
  threshold: unknown,
): Pick<CompactOptions, 'softCompactRatio' | 'hardCompactRatio' | 'strategy'> {
  const hardCompactRatio = normalizeCompactionThreshold(threshold);
  // 软阈值是硬阈值的 80%，但必须严格小于硬阈值，且不高于默认软阈值，
  // 避免阈值设置得较低时出现“软阈值高于硬阈值”的矛盾。
  const softCompactRatio = Math.min(
    COMPACTION_SOFT_RATIO,
    hardCompactRatio,
    Math.round(hardCompactRatio * 0.8 * 100) / 100,
  );
  return { softCompactRatio, hardCompactRatio, strategy: 'llm' };
}

export function compactionOptionsForModelContext(
  modelContextTokens: number | undefined,
  compactionThreshold?: number,
): Pick<CompactOptions, 'maxTokens' | 'softCompactRatio' | 'hardCompactRatio' | 'strategy'> | Pick<CompactOptions, 'softCompactRatio' | 'hardCompactRatio' | 'strategy'> {
  const base = compactionThreshold === undefined
    ? defaultCompactionOptions()
    : compactionOptionsForThreshold(compactionThreshold);
  const maxTokens = positiveInteger(modelContextTokens);
  return maxTokens ? { ...base, maxTokens } : base;
}

export function contextBudget(): number {
  return 8000;
}

function positiveInteger(value: number | undefined): number | undefined {
  if (!Number.isFinite(value) || !value || value <= 0) return undefined;
  return Math.floor(value);
}
