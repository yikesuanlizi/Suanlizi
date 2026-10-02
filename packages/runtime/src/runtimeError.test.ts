import { describe, expect, it } from 'vitest';
import { formatSuanliziErrorMessage } from '@suanlizi/protocol';
import { affectsTurnStatus, toSuanliziErrorInfo } from './runtimeError.js';

describe('runtime error classification', () => {
  it('classifies model timeout as response stream disconnected', () => {
    expect(toSuanliziErrorInfo(new Error('The operation was aborted due to timeout'))).toMatchObject({
      kind: 'ResponseStreamDisconnected',
      reason: 'timeout',
    });
  });

  it('keeps a typed model timeout reason and renders an actionable message', () => {
    const error = Object.assign(new Error('Model request timed out after 10000ms'), {
      code: 'MODEL_REQUEST_TIMEOUT',
      timeoutMs: 10_000,
    });
    const info = toSuanliziErrorInfo(error);
    expect(info).toMatchObject({ kind: 'ResponseStreamDisconnected', reason: 'timeout', timeoutMs: 10_000 });
    expect(formatSuanliziErrorMessage(info, error.message, 'zh')).toContain('模型响应超时（10 秒）');
  });

  it('classifies common HTTP status codes', () => {
    expect(toSuanliziErrorInfo(Object.assign(new Error('HTTP 401'), { status: 401 }))).toMatchObject({ kind: 'Unauthorized' });
    expect(toSuanliziErrorInfo(Object.assign(new Error('HTTP 429'), { status: 429 }))).toMatchObject({ kind: 'UsageLimitExceeded' });
    expect(toSuanliziErrorInfo(Object.assign(new Error('HTTP 500'), { status: 500 }))).toMatchObject({ kind: 'InternalServerError' });
  });

  it('keeps rollback/control marker errors from failing the turn status', () => {
    expect(affectsTurnStatus({ kind: 'ThreadRollbackFailed' })).toBe(false);
    expect(affectsTurnStatus({ kind: 'ActiveTurnNotSteerable' })).toBe(false);
    expect(affectsTurnStatus({ kind: 'ResponseStreamDisconnected' })).toBe(true);
  });

  it('does not treat a caller AbortError as a recoverable stream failure', () => {
    const error = new DOMException('The operation was aborted', 'AbortError');
    expect(toSuanliziErrorInfo(error)).toMatchObject({ reason: 'cancelled' });
  });
});
