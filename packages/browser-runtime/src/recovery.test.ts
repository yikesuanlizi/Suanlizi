// 错误恢复策略单元测试：覆盖恢复矩阵全部 8 类错误 + uncertain 原则 + 指数退避
// — English: recovery policy unit tests — full 8-kind recovery matrix,
//   uncertain principle and exponential backoff
import { describe, expect, it } from 'vitest';
import type { ClassifiedError, ClassifiedErrorKind } from '@suanlizi/protocol';
import {
  decideRecovery,
  nextRetryDelayMs,
  shouldRetryUncertain,
  type RecoveryDecision,
} from './recovery.js';

// 构造最小 ClassifiedError
// — English: builds a minimal ClassifiedError.
function err(kind: ClassifiedErrorKind): ClassifiedError {
  return {
    kind,
    code: `E_${kind.toUpperCase()}`,
    message: '测试错误',
    retryable: kind === 'transient' || kind === 'llm' || kind === 'element',
  };
}

describe('decideRecovery 恢复矩阵（8 类错误）', () => {
  it('transient：重试上限内退避重试，达到上限后重新规划', () => {
    const d0 = decideRecovery(err('transient'), { attempts: 0 });
    expect(d0.action).toBe('retry');
    expect(d0.delayMs).toBe(500);
    expect(d0.reason).toBe('临时故障，退避重试');
    expect(d0.retryable).toBe(true);

    const dMax = decideRecovery(err('transient'), { attempts: 3 });
    expect(dMax.action).toBe('replan');
    expect(dMax.reason).toBe('重试次数已达上限，重新规划');
    expect(dMax.retryable).toBe(false);
    expect(dMax.delayMs).toBeUndefined();
  });

  it('element：重新观测后重试', () => {
    const d = decideRecovery(err('element'), { attempts: 5 });
    expect(d.action).toBe('reobserve');
    expect(d.reason).toBe('元素引用失效，重新观测后重试');
    expect(d.retryable).toBe(true);
  });

  it('page：人工接管 / 中止，不重试', () => {
    const d = decideRecovery(err('page'));
    expect(d.action).toBe('abort');
    expect(d.reason).toBe('页面级故障（登录过期/风控/CAPTCHA），需人工接管');
    expect(d.retryable).toBe(false);
  });

  it('llm：修复重试不超 2 次，超过后换策略重规划', () => {
    const d0 = decideRecovery(err('llm'), { attempts: 0 });
    expect(d0.action).toBe('retry');
    expect(d0.delayMs).toBe(0);
    expect(d0.reason).toBe('模型输出异常，修复后重试');
    expect(d0.retryable).toBe(true);

    const d2 = decideRecovery(err('llm'), { attempts: 2 });
    expect(d2.action).toBe('replan');
    expect(d2.reason).toBe('模型连续失败，换策略重规划');
    expect(d2.retryable).toBe(false);
  });

  it('policy：不重试，向用户说明', () => {
    const d = decideRecovery(err('policy'));
    expect(d.action).toBe('abort');
    expect(d.reason).toBe('策略拒绝，不重试，向用户说明');
    expect(d.retryable).toBe(false);
  });

  it('budget：挂起并请求继续授权（重新规划路径）', () => {
    const d = decideRecovery(err('budget'));
    expect(d.action).toBe('replan');
    expect(d.reason).toBe('预算耗尽，挂起并请求继续授权');
    expect(d.retryable).toBe(false);
  });

  it('side_effect：对账后再决定，不盲目重试', () => {
    const d = decideRecovery(err('side_effect'));
    expect(d.action).toBe('reconcile');
    expect(d.reason).toBe('副作用结果不明，对账后再决定');
    expect(d.retryable).toBe(false);
  });

  it('cancelled：直接结束', () => {
    const d = decideRecovery(err('cancelled'));
    expect(d.action).toBe('abort');
    expect(d.reason).toBe('任务已取消');
    expect(d.retryable).toBe(false);
  });
});

describe('decideRecovery transient 退避', () => {
  it('attempts 0/1/2 → delayMs 500/1000/2000', () => {
    expect(decideRecovery(err('transient'), { attempts: 0 }).delayMs).toBe(500);
    expect(decideRecovery(err('transient'), { attempts: 1 }).delayMs).toBe(1000);
    expect(decideRecovery(err('transient'), { attempts: 2 }).delayMs).toBe(2000);
  });

  it('attempts 达到 maxRetries 后 replan（默认上限 3）', () => {
    expect(decideRecovery(err('transient'), { attempts: 2 }).action).toBe('retry');
    expect(decideRecovery(err('transient'), { attempts: 3 }).action).toBe('replan');
    expect(decideRecovery(err('transient'), { attempts: 9 }).action).toBe('replan');
  });

  it('自定义 baseDelayMs / maxRetries 生效', () => {
    const d = decideRecovery(err('transient'), { attempts: 1, baseDelayMs: 100, maxRetries: 5 });
    expect(d.delayMs).toBe(200);
    expect(d.action).toBe('retry');

    expect(decideRecovery(err('transient'), { attempts: 5, maxRetries: 5 }).action).toBe('replan');
  });

  it('无 context 时按默认值（attempts=0, maxRetries=3, baseDelayMs=500）', () => {
    const d = decideRecovery(err('transient'));
    expect(d.action).toBe('retry');
    expect(d.delayMs).toBe(500);
    expect(d.retryable).toBe(true);
  });
});

describe('decideRecovery llm 上限', () => {
  it('attempts 0/1 → retry（上限 2 次）', () => {
    expect(decideRecovery(err('llm'), { attempts: 0 }).action).toBe('retry');
    expect(decideRecovery(err('llm'), { attempts: 1 }).action).toBe('retry');
  });

  it('attempts 2 → replan', () => {
    expect(decideRecovery(err('llm'), { attempts: 2 }).action).toBe('replan');
    expect(decideRecovery(err('llm'), { attempts: 3 }).action).toBe('replan');
  });

  it('llm 上限与 maxRetries 无关（固定 2 次）', () => {
    expect(decideRecovery(err('llm'), { attempts: 2, maxRetries: 9 }).action).toBe('replan');
  });
});

describe('shouldRetryUncertain uncertain 恢复原则', () => {
  it('外部副作用结果不明 → 不盲目重试（需对账）', () => {
    expect(shouldRetryUncertain('external_reversible')).toBe(false);
    expect(shouldRetryUncertain('external_irreversible')).toBe(false);
  });

  it('local / none / undefined → 可重新观测后重试', () => {
    expect(shouldRetryUncertain('none')).toBe(true);
    expect(shouldRetryUncertain('local')).toBe(true);
    expect(shouldRetryUncertain(undefined)).toBe(true);
  });
});

describe('nextRetryDelayMs 指数退避', () => {
  it('按 2 的幂增长：0/1/2 → 500/1000/2000', () => {
    expect(nextRetryDelayMs(0)).toBe(500);
    expect(nextRetryDelayMs(1)).toBe(1000);
    expect(nextRetryDelayMs(2)).toBe(2000);
  });

  it('上限 8000ms（attempt 足够大时封顶）', () => {
    expect(nextRetryDelayMs(4)).toBe(8000);
    expect(nextRetryDelayMs(10)).toBe(8000);
    expect(nextRetryDelayMs(100)).toBe(8000);
  });

  it('自定义 baseDelayMs 生效', () => {
    expect(nextRetryDelayMs(1, 100)).toBe(200);
    expect(nextRetryDelayMs(10, 100)).toBe(8000);
  });
});

describe('decideRecovery 未知 kind 保守处理', () => {
  it('未知 kind（as never 传入）→ abort，忽略输入 retryable', () => {
    const unknown = { kind: 'unknown_kind' as never, code: 'E_UNKNOWN', message: '未知错误', retryable: true };
    const d: RecoveryDecision = decideRecovery(unknown);
    expect(d.action).toBe('abort');
    expect(d.reason).toBe('未知错误，保守中止');
    expect(d.retryable).toBe(false);
  });
});
