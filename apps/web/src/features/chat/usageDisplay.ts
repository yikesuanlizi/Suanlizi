import type { Locale } from '../../config/config.js';
import type { ThreadUsage, Usage } from '../../shared/types.js';
import { resolveModelCapabilities, type ModelCapabilities, type ModelCapabilitySource } from '@suanlizi/protocol';

export { resolveModelCapabilities };

export interface TokenUsageSummary {
  totalInput: number;
  totalCached: number;
  totalOutput: number;
  hitRate?: number;
  cacheReported?: boolean;
  cacheLabel: string;
}

export function buildTokenUsageSummary(
  threadUsage: ThreadUsage | undefined | null,
  locale: Locale,
): TokenUsageSummary | null {
  if (!threadUsage) return null;
  const total = threadUsage.total;
  const inputTokens = Number(total.inputTokens ?? 0);
  const cachedInputTokens = Number(total.cachedInputTokens ?? 0);
  const outputTokens = Number(total.outputTokens ?? 0);
  if (!inputTokens && !cachedInputTokens && !outputTokens) return null;
  const cacheReported = total.cacheReported === true;
  const hitRate = cacheReported && inputTokens > 0 ? Math.round((cachedInputTokens / inputTokens) * 100) : undefined;
  return {
    totalInput: inputTokens,
    totalCached: cacheReported ? cachedInputTokens : 0,
    totalOutput: outputTokens,
    ...(hitRate === undefined ? {} : { hitRate }),
    ...(total.cacheReported === undefined ? {} : { cacheReported: total.cacheReported }),
    cacheLabel: locale === 'zh' ? '缓存' : 'cache',
  };
}

export function formatTokenSummary(total: Usage | undefined | null, locale: Locale): string {
  if (!total) return '';
  return formatUsageLine(total, locale);
}

export function formatThreadTokenSummary(threadUsage: ThreadUsage | undefined | null, locale: Locale): string {
  if (!threadUsage) return '';
  const last = threadUsage.turns.at(-1)?.usage;
  const total = threadUsage.total;
  if (!last) return formatUsageLine(total, locale);
  const lastText = formatUsageNumbers(last, locale);
  const totalText = formatUsageNumbers(total, locale, { omitCacheLabel: true });
  return locale === 'zh'
    ? `Token：本轮 ${lastText}；累计 ${totalText}`
    : `Tokens: turn ${lastText}; total ${totalText}`;
}

function formatUsageLine(total: Usage, locale: Locale): string {
  const inputTokens = Number(total.inputTokens ?? 0);
  const cachedInputTokens = Number(total.cachedInputTokens ?? 0);
  const outputTokens = Number(total.outputTokens ?? 0);
  if (!inputTokens && !cachedInputTokens && !outputTokens) return '';
  const cacheReported = total.cacheReported === true;
  const hitRate = cacheReported && inputTokens > 0 ? Math.round((cachedInputTokens / inputTokens) * 100) : 0;
  const cacheLabel = total.cacheStrategy === 'deepseek-native'
    ? (locale === 'zh' ? 'DeepSeek 缓存' : 'DeepSeek cache')
    : (locale === 'zh' ? '缓存' : 'cache');
  const cacheText = cacheReported
    ? (locale === 'zh'
      ? `${cacheLabel} ${cachedInputTokens}，命中率 ${hitRate ?? 0}%`
      : `${cacheLabel} ${cachedInputTokens}, hit ${hitRate ?? 0}%`)
    : (locale === 'zh' ? `${cacheLabel}未上报` : `${cacheLabel} unavailable`);
  return locale === 'zh'
    ? `Token：输入 ${inputTokens}，${cacheText}，输出 ${outputTokens}`
    : `Tokens: input ${inputTokens}, ${cacheText}, output ${outputTokens}`;
}

function formatUsageNumbers(
  usage: Usage,
  locale: Locale,
  options: { omitCacheLabel?: boolean } = {},
): string {
  const inputTokens = Number(usage.inputTokens ?? 0);
  const cachedInputTokens = Number(usage.cachedInputTokens ?? 0);
  const outputTokens = Number(usage.outputTokens ?? 0);
  const cacheReported = usage.cacheReported === true;
  const hitRate = cacheReported && inputTokens > 0 ? Math.round((cachedInputTokens / inputTokens) * 100) : 0;
  const cacheLabel = options.omitCacheLabel
    ? (locale === 'zh' ? '缓存' : 'cache')
    : usage.cacheStrategy === 'deepseek-native'
      ? (locale === 'zh' ? 'DeepSeek 缓存' : 'DeepSeek cache')
      : (locale === 'zh' ? '缓存' : 'cache');
  const cacheText = cacheReported
    ? (locale === 'zh'
      ? `${cacheLabel} ${cachedInputTokens}，命中率 ${hitRate ?? 0}%`
      : `${cacheLabel} ${cachedInputTokens}, hit ${hitRate ?? 0}%`)
    : (locale === 'zh' ? `${cacheLabel}未上报` : `${cacheLabel} unavailable`);
  return locale === 'zh'
    ? `输入 ${inputTokens}，${cacheText}，输出 ${outputTokens}`
    : `input ${inputTokens}, ${cacheText}, output ${outputTokens}`;
}

export function formatCacheDiagnostics(
  diagnostics: {
    stable?: boolean;
    reasons?: string[];
    shape?: { prefixHash?: string };
  } | null | undefined,
  locale: Locale,
): string {
  if (!diagnostics || diagnostics.stable !== false) return '';
  const reasons = diagnostics.reasons?.length ? diagnostics.reasons.join(locale === 'zh' ? '、' : ', ') : 'unknown';
  const hash = diagnostics.shape?.prefixHash ? ` · ${diagnostics.shape.prefixHash.slice(0, 8)}` : '';
  return locale === 'zh'
    ? `缓存前缀变化：${reasons}${hash}`
    : `Cache prefix changed: ${reasons}${hash}`;
}

export function formatCompactionPressure(
  pressure: {
    status?: string;
    estimatedTokens?: number;
    hardThreshold?: number;
  } | null | undefined,
  locale: Locale,
): string {
  if (!pressure || pressure.status !== 'soft') return '';
  const estimated = Number(pressure.estimatedTokens ?? 0);
  const hardThreshold = Number(pressure.hardThreshold ?? 0);
  return locale === 'zh'
    ? `上下文接近压缩阈值：${estimated}/${hardThreshold}`
    : `Context near compaction threshold: ${estimated}/${hardThreshold}`;
}

export interface ContextPressureSnapshot {
  status?: string;
  estimatedTokens?: number;
  maxTokens?: number;
  /** Runtime maxTokens may be an internal safety fallback; only use it when explicitly known. */
  windowKnown?: boolean;
  softThreshold?: number;
  hardThreshold?: number;
}

export interface DisplayContextPressure extends ContextPressureSnapshot {
  estimatedTokens: number;
  maxTokens: number;
  softThreshold?: number;
  hardThreshold?: number;
  windowSource: ModelCapabilitySource | 'runtime';
  windowLabel?: string;
}

export function resolveDisplayContextPressure(
  pressure: ContextPressureSnapshot | null | undefined,
  capabilities: ModelCapabilities | null | undefined,
): DisplayContextPressure | null {
  const runtimeMax = pressure?.windowKnown === true ? positiveNumber(pressure?.maxTokens) : undefined;
  const modelMax = positiveNumber(capabilities?.contextTokens);
  const maxTokens = modelMax ?? runtimeMax;
  if (!maxTokens) return null;
  const estimatedTokens = Math.max(0, Number(pressure?.estimatedTokens ?? 0));
  const softRatio = ratioFromThreshold(pressure?.softThreshold, runtimeMax) ?? 0.5;
  const hardRatio = ratioFromThreshold(pressure?.hardThreshold, runtimeMax) ?? 0.8;
  return {
    ...pressure,
    estimatedTokens,
    maxTokens,
    softThreshold: Math.round(maxTokens * softRatio),
    hardThreshold: Math.round(maxTokens * hardRatio),
    windowSource: modelMax ? capabilities?.contextSource ?? 'known-model' : 'runtime',
    windowLabel: modelMax ? capabilities?.displayName : undefined,
  };
}

export function hasContextPressure(pressure: { estimatedTokens?: number; maxTokens?: number } | null | undefined): boolean {
  return Boolean(pressure?.maxTokens && pressure.maxTokens > 0);
}

export function contextUsagePercent(pressure: { estimatedTokens?: number; maxTokens?: number } | null | undefined): number {
  const estimated = Number(pressure?.estimatedTokens ?? 0);
  const max = Number(pressure?.maxTokens ?? 0);
  if (max <= 0) return 0;
  return Math.min(100, Math.max(0, Math.round((estimated / max) * 100)));
}

export function cacheContextPercent(
  usage: { totalCached?: number } | null | undefined,
  pressure: { maxTokens?: number } | null | undefined,
): number {
  const cached = Number(usage?.totalCached ?? 0);
  const max = Number(pressure?.maxTokens ?? 0);
  if (max <= 0) return 0;
  return Math.min(100, Math.max(0, Math.round((cached / max) * 100)));
}

export function softThresholdPercent(pressure: { softThreshold?: number; maxTokens?: number } | null | undefined): number | null {
  const soft = positiveNumber(pressure?.softThreshold);
  const max = positiveNumber(pressure?.maxTokens);
  if (!soft || !max) return null;
  return Math.min(100, Math.max(0, (soft / max) * 100));
}

export function buildTokenTooltip(
  usage: { totalInput?: number; totalCached?: number; totalOutput?: number; hitRate?: number; cacheReported?: boolean } | null | undefined,
  pressure: DisplayContextPressure | null | undefined,
  locale: Locale,
): string {
  const parts: string[] = [];
  if (usage) {
    parts.push(locale === 'zh' ? `输入: ${usage.totalInput}` : `Input: ${usage.totalInput}`);
    parts.push(usage.cacheReported === true
      ? (locale === 'zh'
        ? `缓存命中: ${usage.totalCached} (${usage.hitRate ?? 0}%)`
        : `Cache hit: ${usage.totalCached} (${usage.hitRate ?? 0}%)`)
      : (locale === 'zh' ? '缓存未上报' : 'Cache unavailable'));
    parts.push(locale === 'zh' ? `输出: ${usage.totalOutput}` : `Output: ${usage.totalOutput}`);
  }
  if (pressure?.maxTokens) {
    if (parts.length) parts.push('—');
    parts.push(locale === 'zh'
      ? `上下文: ${formatCompactNumber(pressure.estimatedTokens ?? 0)} / ${formatCompactNumber(pressure.maxTokens)}`
      : `Context: ${formatCompactNumber(pressure.estimatedTokens ?? 0)} / ${formatCompactNumber(pressure.maxTokens)}`);
    if (pressure.windowLabel) {
      parts.push(locale === 'zh'
        ? `窗口来源: ${pressure.windowLabel}`
        : `Window source: ${pressure.windowLabel}`);
    }
    if (pressure.softThreshold) {
      parts.push(locale === 'zh'
        ? `软阈值: ${formatCompactNumber(pressure.softThreshold)}`
        : `Soft threshold: ${formatCompactNumber(pressure.softThreshold)}`);
    }
    if (pressure.hardThreshold) {
      parts.push(locale === 'zh'
        ? `硬阈值: ${formatCompactNumber(pressure.hardThreshold)}`
        : `Hard threshold: ${formatCompactNumber(pressure.hardThreshold)}`);
    }
  }
  return parts.join(' ');
}

export function formatCompactNumber(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return String(Math.round(value));
}

function ratioFromThreshold(threshold: number | undefined, maxTokens: number | undefined): number | undefined {
  if (!threshold || !maxTokens) return undefined;
  const ratio = threshold / maxTokens;
  if (!Number.isFinite(ratio) || ratio <= 0) return undefined;
  return Math.min(1, Math.max(0, ratio));
}

function positiveNumber(value: unknown): number | undefined {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return undefined;
  return numeric;
}
