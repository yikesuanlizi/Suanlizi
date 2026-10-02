// 浏览器运行时 IPC 协议层测试：往返、单行约束、容错（返回 null 不抛）、
// 四类帧、browser.act 的 intent 校验、frameId 幂等、一行一帧约束
// — English: browser runtime IPC protocol tests — round-trip, single-line
//   constraint, fault tolerance (null, no throw), all four frame types,
//   browser.act intent validation, frameId idempotency, one-frame-per-line
import { describe, expect, it } from 'vitest';
import type { ActionIntent } from '@suanlizi/protocol';
import { ipcCodec, isDuplicateFrame, makeFrameId } from './codec.js';
import { parseIpcCommand, parseIpcEvent, parseIpcResponse } from './ipcSchemas.js';
import { IPC_VERSION } from './ipcTypes.js';
import type { ProtocolFrame } from './ipcTypes.js';

// 构造合法 ActionIntent（actionIntentSchema 全字段校验，targetRef 匹配 [e\d]+）
// — English: build a valid ActionIntent satisfying actionIntentSchema
function makeIntent(overrides: Partial<ActionIntent> = {}): ActionIntent {
  return {
    actionId: 'act-1',
    taskId: 'task-1',
    pageId: 'p1',
    observationId: 'obs-1',
    expectedNavigationEpoch: 3,
    kind: 'click',
    targetRef: '[e1]',
    arguments: { x: 1 },
    rationale: 'ipc round-trip test',
    effect: 'local',
    risk: 'low',
    postcondition: { kind: 'none' },
    ...overrides,
  };
}

function observedFrame(seq: number): ProtocolFrame {
  return ipcCodec.makeFrame({
    sessionId: 's-1',
    seq,
    type: 'event',
    action: 'browser.observed',
    payload: { observationId: 'o-1', pageId: 'p1', url: 'https://example.com', elementCount: 3 },
    traceId: 'tr-1',
  });
}

describe('ipcCodec', () => {
  it('makeFrame→encode→decodeLine 往返保持全部字段（含 spanId/deadline/自动 frameId）', () => {
    const frame = ipcCodec.makeFrame({
      sessionId: 's-1',
      seq: 7,
      type: 'command',
      action: 'browser.act',
      payload: { intent: makeIntent() },
      traceId: 'tr-abc',
      spanId: 'sp-1',
      deadline: Date.now() + 30_000,
    });
    const decoded = ipcCodec.decodeLine(ipcCodec.encode(frame));
    expect(decoded).not.toBeNull();
    expect(decoded).toEqual(frame);
    expect(decoded!.version).toBe(IPC_VERSION);
    // 未传 frameId 时自动生成 fr-${sessionId}-${seq}
    // — English: frameId defaults to fr-${sessionId}-${seq}
    expect(decoded!.frameId).toBe('fr-s-1-7');
  });

  it('encode 输出不含换行符（单行 JSON，stdout 纯净约束）', () => {
    const frame = ipcCodec.makeFrame({
      sessionId: 's-1',
      seq: 1,
      type: 'response',
      action: 'ok',
      payload: { result: { url: 'https://example.com', note: 'line1\nline2' } },
      traceId: 'tr-1',
    });
    const encoded = ipcCodec.encode(frame);
    expect(encoded).not.toMatch(/[\n\r]/);
    expect(encoded.split('\n')).toHaveLength(1);
  });

  it('decodeLine 对非法 JSON / 错误版本 / 缺字段返回 null 且不抛', () => {
    // 非法 JSON、版本不符（z.literal 拒绝）、缺帧字段、标量 JSON、空串
    // — English: invalid JSON, version mismatch, missing fields, scalar JSON, empty string
    const badLines = ['not json', '{"version":"bad"}', '{"version":"1.0.0"}', '42', ''];
    for (const line of badLines) {
      expect(() => ipcCodec.decodeLine(line)).not.toThrow();
      expect(ipcCodec.decodeLine(line)).toBeNull();
    }
  });

  it('四种帧类型（command/event/response/cancel）都能往返；cancel payload 为 { reason?, actionId? }', () => {
    const frames: ProtocolFrame[] = [
      ipcCodec.makeFrame({
        sessionId: 's-1', seq: 1, type: 'command', action: 'session.start',
        payload: { taskId: 't-1' }, traceId: 'tr-1',
      }),
      observedFrame(2),
      ipcCodec.makeFrame({
        sessionId: 's-1', seq: 3, type: 'response', action: 'error',
        payload: { code: 'E_TIMEOUT', message: 'page load timed out', retryable: true, kind: 'transient' },
        traceId: 'tr-1',
      }),
      ipcCodec.makeFrame({
        sessionId: 's-1', seq: 4, type: 'cancel', action: 'browser.cancel',
        payload: { reason: 'user-abort', actionId: 'act-9' }, traceId: 'tr-1',
      }),
    ];
    for (const frame of frames) {
      const decoded = ipcCodec.decodeLine(ipcCodec.encode(frame));
      expect(decoded).not.toBeNull();
      expect(decoded).toEqual(frame);
    }
  });

  it('parseIpcCommand 对 browser.act 的 payload.intent 使用 actionIntentSchema 校验（非法 intent 返回 null）', () => {
    const valid = ipcCodec.makeFrame({
      sessionId: 's-1', seq: 1, type: 'command', action: 'browser.act',
      payload: { intent: makeIntent() }, traceId: 'tr-1',
    });
    const parsed = parseIpcCommand(valid);
    expect(parsed).not.toBeNull();
    // 显式收窄判别联合，strict 下才能访问 payload.intent
    // — English: narrow the discriminated union explicitly for strict TS
    if (parsed === null || parsed.action !== 'browser.act') {
      throw new Error('expected a valid browser.act command');
    }
    expect(parsed.payload.intent.actionId).toBe('act-1');

    // 非法 kind（不在 BrowserActionKind 枚举内）
    // — English: invalid kind (not in the BrowserActionKind enum)
    const badKind = ipcCodec.makeFrame({
      sessionId: 's-1', seq: 2, type: 'command', action: 'browser.act',
      payload: { intent: makeIntent({ kind: 'fly' as ActionIntent['kind'] }) }, traceId: 'tr-1',
    });
    expect(parseIpcCommand(badKind)).toBeNull();

    // 缺少必填字段（去掉 actionId）
    // — English: missing required field (actionId removed)
    const { actionId: _omitted, ...rest } = makeIntent();
    const missingField = ipcCodec.makeFrame({
      sessionId: 's-1', seq: 3, type: 'command', action: 'browser.act',
      payload: { intent: rest as ActionIntent }, traceId: 'tr-1',
    });
    expect(parseIpcCommand(missingField)).toBeNull();

    // 未知 action 与非法 event/response 同样返回 null
    // — English: unknown action and invalid event/response also return null
    expect(parseIpcCommand({ action: 'browser.fly', payload: {} })).toBeNull();
    expect(parseIpcEvent(observedFrame(4))).not.toBeNull();
    expect(parseIpcEvent({ action: 'browser.observed', payload: { pageId: 'p1' } })).toBeNull();
    expect(parseIpcResponse({ action: 'ok', payload: { result: 1 } })).not.toBeNull();
    expect(parseIpcResponse({ action: 'ok', payload: {} })).toBeNull();
  });

  it('isDuplicateFrame 按 frameId 判重：同 frameId 第二次为 true，不同 frameId 为 false', () => {
    const seen = new Set<string>();
    const a = ipcCodec.makeFrame({
      sessionId: 's-1', seq: 1, type: 'command', action: 'browser.observe',
      payload: {}, traceId: 'tr-1',
    });
    const b = ipcCodec.makeFrame({
      sessionId: 's-1', seq: 2, type: 'command', action: 'browser.observe',
      payload: {}, traceId: 'tr-1',
    });
    expect(a.frameId).toBe(makeFrameId('s-1', 1));
    expect(isDuplicateFrame(a, seen)).toBe(false);
    expect(isDuplicateFrame(a, seen)).toBe(true);
    expect(isDuplicateFrame(b, seen)).toBe(false);
  });

  it('含换行的行 decodeLine 返回 null（一行一帧约束）', () => {
    const encoded = ipcCodec.encode(observedFrame(1));
    expect(ipcCodec.decodeLine(`${encoded}\n`)).toBeNull();
    expect(ipcCodec.decodeLine(`\n${encoded}`)).toBeNull();
    expect(ipcCodec.decodeLine(`{"a":1}\n{"b":2}`)).toBeNull();
  });
});
