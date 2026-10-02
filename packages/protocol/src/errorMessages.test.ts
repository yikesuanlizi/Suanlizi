import { describe, expect, it } from 'vitest';
import { formatSuanliziErrorMessage, normalizeErrorFingerprint, presentSuanliziError } from './errorMessages.js';

describe('formatSuanliziErrorMessage', () => {
  it('hides internal tool governance codes behind actionable messages', () => {
    expect(formatSuanliziErrorMessage(undefined, 'TOOL_LOOP_DETECTED', 'zh')).toContain('重复工具调用');
    expect(formatSuanliziErrorMessage(undefined, 'TOOL_ERROR_LIMIT_REACHED', 'zh')).toContain('连续失败');
    expect(formatSuanliziErrorMessage(undefined, 'TOOL_GOVERNANCE_FINAL_RESPONSE_REJECTED', 'zh')).toContain('工具治理');
    expect(formatSuanliziErrorMessage(undefined, 'SUBAGENT_LIMIT_REACHED', 'zh')).toContain('子智能体');
    expect(formatSuanliziErrorMessage(undefined, 'Permission denied', 'zh')).toContain('没有权限');
    expect(formatSuanliziErrorMessage(undefined, 'The operation was aborted', 'zh')).toContain('已停止');
    expect(formatSuanliziErrorMessage(undefined, 'The operation was aborted due to timeout', 'zh')).toContain('超时');
  });
  it('formats a raw timeout for the toast path', () => {
    expect(formatSuanliziErrorMessage(undefined, 'The operation was aborted due to timeout', 'zh'))
      .toContain('操作超时');
    expect(formatSuanliziErrorMessage(undefined, 'The operation was aborted due to timeout', 'en'))
      .toContain('operation timed out');
  });
  it('formats structured Ops and request-boundary codes instead of leaking internal codes', () => {
    expect(formatSuanliziErrorMessage(undefined, 'OPS_KNOWLEDGE_REQUIRED: Select a knowledge base', 'zh'))
      .toContain('选择个人知识库');
    expect(formatSuanliziErrorMessage(undefined, 'MAX_ACTIVE_TASKS_REACHED: Maximum active top-level tasks reached (4)', 'zh'))
      .toContain('活动任务');
    expect(formatSuanliziErrorMessage(undefined, 'REQUEST_BODY_TOO_LARGE: Request body exceeds the 1048576 byte limit', 'zh'))
      .toContain('请求内容过大');
  });

  it('infers common provider statuses when info is missing', () => {
    expect(formatSuanliziErrorMessage(undefined, 'OpenAI gateway error (401)', 'zh'))
      .toContain('未授权');
    expect(formatSuanliziErrorMessage(undefined, 'HTTP 429: rate limit exceeded', 'zh'))
      .toContain('限流');
    expect(formatSuanliziErrorMessage(undefined, 'HTTP 503 service unavailable', 'zh'))
      .toContain('过载');
  });

  it('does not call an explicitly classified error a different kind', () => {
    expect(formatSuanliziErrorMessage({ kind: 'BadRequest' }, 'HTTP 503', 'zh'))
      .toContain('拒绝了请求');
  });
});

describe('presentSuanliziError', () => {
  it('keeps provider detail separate from the actionable summary', () => {
    const raw = 'HTTP 429: upstream request failed with request id req_123';
    expect(presentSuanliziError(undefined, raw, 'zh')).toEqual({
      summary: expect.stringContaining('限流'),
      detail: raw,
    });
  });

  it('does not repeat a raw message that already equals the summary', () => {
    const raw = '模型服务暂时过载，请稍后重试。';
    expect(presentSuanliziError(undefined, raw, 'zh')).toEqual({ summary: raw });
  });

  it('builds stable fingerprints for duplicate provider responses', () => {
    expect(normalizeErrorFingerprint('HTTP 429: Rate Limit')).toBe(normalizeErrorFingerprint('http 429:  rate  limit'));
  });
});
