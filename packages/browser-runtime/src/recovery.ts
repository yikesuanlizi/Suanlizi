// 错误恢复策略：分类错误 → 恢复决策（架构文档 9.4 错误分类与恢复矩阵）
// — English: error recovery policy — classified error → recovery decision
//   (architecture doc 9.4 error classification & recovery matrix)
// 恢复原则：transient 有上限退避重试；element 重新观测；page 人工接管/中止；
// llm 修复重试不超 2 次；policy 不重试；budget 挂起请求继续授权；
// side_effect 对账不能盲目重试；cancelled 直接结束。
// 本模块只做纯函数决策，不含任何定时器 / DOM 实现。
import type { ActionEffect, ClassifiedError } from '@suanlizi/protocol';

// 恢复动作：重试 / 重新观测 / 重新规划 / 对账 / 中止
// — English: recovery actions — retry / reobserve / replan / reconcile / abort
export type RecoveryAction = 'retry' | 'reobserve' | 'replan' | 'reconcile' | 'abort';

export interface RecoveryDecision {
  action: RecoveryAction;
  /** retry 前的退避延迟（毫秒）；仅 retry 决策设置 */
  delayMs?: number;
  /** 用户可读说明 */
  reason: string;
  /** 是否允许重试（与 action 一致的便捷标志） */
  retryable: boolean;
}

export interface RecoveryContext {
  /** 已尝试次数（0 开始） */
  attempts: number;
  /** transient 重试上限，默认 3 */
  maxRetries?: number;
  /** 退避基数（毫秒），默认 500 */
  baseDelayMs?: number;
  /** 动作副作用类别（uncertain 判定用） */
  effect?: ActionEffect;
}

// transient 退避上限：8 秒
// — English: transient backoff cap: 8 seconds
export const MAX_BACKOFF_MS = 8000;
// llm 修复重试上限：2 次
// — English: llm repair retry cap: 2 attempts
export const LLM_MAX_RETRIES = 2;
// transient 默认重试上限：3 次
// — English: transient default retry cap: 3 attempts
export const DEFAULT_MAX_RETRIES = 3;
// 默认退避基数：500ms
// — English: default backoff base: 500ms
export const DEFAULT_BASE_DELAY_MS = 500;

/**
 * 指数退避：min(baseDelayMs * 2^attempt, 8000)；baseDelayMs 默认 500。
 * — English: exponential backoff — min(baseDelayMs * 2^attempt, 8000).
 */
export function nextRetryDelayMs(attempt: number, baseDelayMs: number = DEFAULT_BASE_DELAY_MS): number {
  const raw = baseDelayMs * 2 ** attempt;
  return Math.min(raw, MAX_BACKOFF_MS);
}

/**
 * 恢复矩阵：按 error.kind 给出恢复决策（架构文档 9.4）。
 * 注意：决策只看 kind，忽略 ClassifiedError.retryable 输入字段——矩阵即权威。
 * — English: recovery matrix keyed by error.kind (doc 9.4). The input's
 *   retryable field is ignored — the matrix is authoritative.
 */
export function decideRecovery(error: ClassifiedError, context?: RecoveryContext): RecoveryDecision {
  const ctx = context ?? { attempts: 0 };
  const attempts = ctx.attempts;
  const maxRetries = ctx.maxRetries ?? DEFAULT_MAX_RETRIES;
  const baseDelayMs = ctx.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;

  switch (error.kind) {
    case 'transient':
      if (attempts < maxRetries) {
        return {
          action: 'retry',
          delayMs: nextRetryDelayMs(attempts, baseDelayMs),
          reason: '临时故障，退避重试',
          retryable: true,
        };
      }
      return { action: 'replan', reason: '重试次数已达上限，重新规划', retryable: false };
    case 'element':
      return { action: 'reobserve', reason: '元素引用失效，重新观测后重试', retryable: true };
    case 'page':
      return { action: 'abort', reason: '页面级故障（登录过期/风控/CAPTCHA），需人工接管', retryable: false };
    case 'llm':
      if (attempts < LLM_MAX_RETRIES) {
        return { action: 'retry', delayMs: 0, reason: '模型输出异常，修复后重试', retryable: true };
      }
      return { action: 'replan', reason: '模型连续失败，换策略重规划', retryable: false };
    case 'policy':
      return { action: 'abort', reason: '策略拒绝，不重试，向用户说明', retryable: false };
    case 'budget':
      return { action: 'replan', reason: '预算耗尽，挂起并请求继续授权', retryable: false };
    case 'side_effect':
      return { action: 'reconcile', reason: '副作用结果不明，对账后再决定', retryable: false };
    case 'cancelled':
      return { action: 'abort', reason: '任务已取消', retryable: false };
    default:
      // 未知 kind（类型上不可达，运行期防御）——保守中止。
      // — English: unknown kind (unreachable in types, runtime defense) — abort conservatively.
      return { action: 'abort', reason: '未知错误，保守中止', retryable: false };
  }
}

/**
 * uncertain 的恢复原则（架构文档 9.3/10.2）：外部副作用
 * （external_reversible/external_irreversible）结果不明时绝不盲目重试
 * （返回 false——需对账）；local/none/undefined → true（可重新观测后重试）。
 * — English: uncertain recovery principle (doc 9.3/10.2) — never blindly retry
 *   when an external side effect's outcome is unknown (false — reconcile first);
 *   local/none/undefined → true (safe to re-observe and retry).
 */
export function shouldRetryUncertain(effect?: ActionEffect): boolean {
  return effect !== 'external_reversible' && effect !== 'external_irreversible';
}
