import type { CompactOptions } from '@suanlizi/memory';

/**
 * 运行模式已收敛：不再提供「缓存优先 / 长运行」两档 profile。
 *
 * 两档的唯一实际差异是压缩时机与摘要策略，用一个用户可调的
 * 「上下文压缩阈值」表达即可，避免暴露无意义的运行模式选择。
 *
 * 历史配置里的 'cache_first' / 'runtime_os' / 'harness' 全部归一为同一策略，
 * 保证旧数据不会因为类型收紧而崩。
 */
export type RunProfile = 'cache_first' | 'runtime_os';

/** 归一化：任何历史值都落到统一策略，不再区分两档。 */
export function normalizeRunProfile(_value?: unknown): RunProfile {
  return 'runtime_os';
}

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
export function compactionOptionsForRunProfile(_profile?: RunProfile): Pick<CompactOptions, 'softCompactRatio' | 'hardCompactRatio' | 'strategy'> {
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
  profile: RunProfile,
  modelContextTokens: number | undefined,
  compactionThreshold?: number,
): Pick<CompactOptions, 'maxTokens' | 'softCompactRatio' | 'hardCompactRatio' | 'strategy'> | Pick<CompactOptions, 'softCompactRatio' | 'hardCompactRatio' | 'strategy'> {
  const base = compactionThreshold === undefined
    ? compactionOptionsForRunProfile(profile)
    : compactionOptionsForThreshold(compactionThreshold);
  const maxTokens = positiveInteger(modelContextTokens);
  return maxTokens ? { ...base, maxTokens } : base;
}

export function contextBudgetForRunProfile(_profile?: RunProfile): number {
  return 8000;
}

function positiveInteger(value: number | undefined): number | undefined {
  if (!Number.isFinite(value) || !value || value <= 0) return undefined;
  return Math.floor(value);
}
