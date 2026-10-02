// 热上下文紧凑化测试（架构文档 13.1/13.2）：元素引用表与内容块截断、单行注入
// 格式、动作历史配对摘要、错误摘要、凭证/内部字段不进入上下文、空输入边界
// — English: hot-context sliming tests (architecture §13.1/§13.2) — element ref
//   and content block truncation, single-line injection format, action history
//   pairing summaries, error summaries, credentials/internal fields never enter
//   context, and empty-input edges
import { describe, expect, it } from 'vitest';
import type {
  ActionRecord,
  BrowserTaskEvent,
  ClassifiedError,
  InteractableElement,
  Observation,
} from '@suanlizi/protocol';
import {
  buildSlimContextState,
  slimErrors,
  slimHistory,
  slimObservationContext,
} from './contextSlim.js';

// ─── 测试构造工具 ──────────────────────────────────────────────────────────
// — English: test fixtures

function makeObs(overrides: Partial<Observation> = {}): Observation {
  return {
    observationId: 'obs-1',
    taskId: 'task-1',
    pageId: 'page-1',
    navigationEpoch: 3,
    capturedAt: 1_700_000_000_000,
    url: 'https://example.com/login',
    title: '登录',
    readiness: 'stable',
    elements: [],
    mainContent: [],
    forms: [],
    network: { pendingRequests: 0, recentFailures: [] },
    pageState: { captchaDetected: false, authRequired: false },
    ...overrides,
  };
}

function makeElement(
  ref: string,
  visible: boolean,
  enabled: boolean,
  text?: string,
): InteractableElement {
  return {
    ref,
    role: 'link',
    name: '链接',
    text,
    frameId: 'frame-0',
    visible,
    enabled,
    fingerprint: `fp-${ref}`,
    provenance: { trust: 'untrusted', source: 'dom' },
  };
}

// 协议 1.7 的 ActionRecord 无 kind 字段；测试按契约用类型扩展携带 kind
// — English: ActionRecord in protocol 1.7 has no kind field; tests carry kind
//   via a type extension, as the contract expects
type PreparedRecord = ActionRecord & { kind?: string };

function makePrepared(actionId: string, kind: string): BrowserTaskEvent {
  const record: PreparedRecord = {
    actionId,
    taskId: 'task-1',
    actionDigest: `digest-${actionId}`,
    effect: 'local',
    status: 'prepared',
    preState: {
      pageId: 'page-1',
      url: 'https://example.com/login',
      observationId: 'obs-1',
      navigationEpoch: 3,
    },
    expectedPostcondition: { kind: 'none' },
    preparedAt: 1_700_000_001_000,
    evidenceRefs: [],
    kind,
  };
  return {
    type: 'action.prepared',
    taskId: 'task-1',
    record,
    preparedAt: new Date(1_700_000_001_000).toISOString(),
  };
}

function makeCompleted(
  actionId: string,
  outcome: 'committed' | 'uncertain' | 'failed',
): BrowserTaskEvent {
  return {
    type: 'action.completed',
    taskId: 'task-1',
    actionId,
    outcome,
    evidenceRefs: [],
    completedAt: new Date(1_700_000_002_000).toISOString(),
  };
}

describe('buildSlimContextState', () => {
  it('页面字段透传、flags 透传、provenance 恒为 untrusted/dom', () => {
    const obs = makeObs({
      pageState: { captchaDetected: true, authRequired: true },
      elements: [makeElement('[e1]', true, true)],
    });
    const state = buildSlimContextState(obs);

    expect(state.pageId).toBe('page-1');
    expect(state.url).toBe('https://example.com/login');
    expect(state.title).toBe('登录');
    expect(state.navigationEpoch).toBe(3);
    expect(state.readiness).toBe('stable');
    expect(state.flags).toEqual({ captchaDetected: true, authRequired: true });
    expect(state.provenance).toEqual({ trust: 'untrusted', source: 'dom' });
  });

  it('元素截断：maxElements=2 时只保留前 2 个（观测顺序）', () => {
    const obs = makeObs({
      elements: [
        makeElement('[e1]', true, true),
        makeElement('[e2]', true, true),
        makeElement('[e3]', true, true),
        makeElement('[e4]', true, true),
      ],
    });
    const state = buildSlimContextState(obs, { maxElements: 2 });

    expect(state.elements.map((e) => e.ref)).toEqual(['[e1]', '[e2]']);
  });

  it('只保留可见元素，且只投影 ref/role/name/text/enabled', () => {
    const obs = makeObs({
      elements: [makeElement('[e1]', true, true), makeElement('[e2]', false, true)],
    });
    const state = buildSlimContextState(obs);

    expect(state.elements.map((e) => e.ref)).toEqual(['[e1]']);
    expect(state.elements[0]).toEqual({
      ref: '[e1]',
      role: 'link',
      name: '链接',
      text: undefined,
      enabled: true,
    });
  });

  it('元素 text 截断到 80 字符（省略号）、内容块按 maxBlockChars 截断', () => {
    const obs = makeObs({
      elements: [makeElement('[e1]', true, true, '字'.repeat(120))],
      mainContent: [
        { type: 'paragraph', text: '块'.repeat(250) },
        { type: 'paragraph', text: '第二块' },
      ],
    });
    const state = buildSlimContextState(obs, { maxBlockChars: 50 });

    expect(state.elements[0].text).toBe('字'.repeat(80) + '…');
    expect(state.content[0]).toBe('块'.repeat(50) + '…');
    // 未超 maxContentBlocks，两块都在
    expect(state.content).toHaveLength(2);
  });

  it('内容块数量截断：maxContentBlocks 生效', () => {
    const obs = makeObs({
      mainContent: Array.from({ length: 5 }, (_, i) => ({
        type: 'paragraph' as const,
        text: `块${i}`,
      })),
    });
    const state = buildSlimContextState(obs, { maxContentBlocks: 2 });

    expect(state.content).toEqual(['块0', '块1']);
  });

  it('多行文本被压平为单行', () => {
    const obs = makeObs({
      mainContent: [{ type: 'paragraph', text: '第一行\n\n  第二行' }],
    });
    const state = buildSlimContextState(obs);

    expect(state.content).toEqual(['第一行 第二行']);
  });
});

describe('slimObservationContext', () => {
  it('输出 [page]/[elements]/[content] 三段，含禁用标记', () => {
    const obs = makeObs({
      navigationEpoch: 7,
      title: '搜索结果',
      pageState: { captchaDetected: true, authRequired: false },
      elements: [
        { ...makeElement('[e1]', true, true, '结果一'), role: 'link', name: '结果一' },
        { ...makeElement('[e2]', true, false, '已禁用'), role: 'button', name: '已禁用' },
      ],
      mainContent: [{ type: 'paragraph', text: '正文第一段' }],
    });
    const text = slimObservationContext(obs);

    expect(text).toContain(
      '[page] https://example.com/login | 搜索结果 | epoch=7 | readiness=stable | captcha=1 auth=0',
    );
    expect(text).toContain('[elements] 2');
    expect(text).toContain('  [e1] link 结果一 结果一');
    expect(text).toContain('  [e2] button 已禁用 已禁用 （禁用）');
    expect(text).toContain('[content] 1');
    expect(text).toContain('  正文第一段');
  });

  it('无 content 时省略 [content] 段；无元素时省略 [elements] 段', () => {
    const withElements = slimObservationContext(
      makeObs({ elements: [makeElement('[e1]', true, true)] }),
    );
    expect(withElements).not.toContain('[content]');
    expect(withElements).toContain('[elements] 1');
    expect(withElements).toContain('  [e1] link 链接');

    const bare = slimObservationContext(makeObs());
    expect(bare).not.toContain('[elements]');
    expect(bare).not.toContain('[content]');
  });

  it('元素与内容块文本截断使用省略号', () => {
    const obs = makeObs({
      elements: [makeElement('[e1]', true, true, 'x'.repeat(120))],
      mainContent: [{ type: 'paragraph', text: 'y'.repeat(300) }],
    });
    const text = slimObservationContext(obs, { maxBlockChars: 20 });

    expect(text).toContain('  [e1] link 链接 ' + 'x'.repeat(80) + '…');
    expect(text).toContain('  ' + 'y'.repeat(20) + '…');
  });

  it('凭证/内部字段永不进入上下文（13.2）：输出不含未投影字段与未定义字符串', () => {
    const obs = makeObs({
      elements: [
        {
          ...makeElement('[e1]', true, true, 'Welcome back, Alice'),
          frameId: 'FRAME_SENTINEL',
          fingerprint: 'FP_SENTINEL_9x',
        },
      ],
      mainContent: [{ type: 'paragraph', text: '页面正文保持紧凑' }],
    });
    const text = slimObservationContext(obs);

    // 内部字段（frameId/fingerprint）不投影
    expect(text).not.toContain('FRAME_SENTINEL');
    expect(text).not.toContain('FP_SENTINEL_9x');
    // 未定义于任何元素/块的字符串不会凭空出现
    expect(text).not.toContain('NEVER_DEFINED_SENTINEL');
    // 元素文本本身保留（已投影字段），但 Observation 无 value 字段
    expect(text).toContain('Welcome back, Alice');
    expect(obs).not.toHaveProperty('value');
  });
});

describe('slimHistory', () => {
  it('prepared + completed 配对 → 摘要行；缺 completed → running', () => {
    const events: BrowserTaskEvent[] = [
      makePrepared('a1', 'click'),
      makePrepared('a2', 'navigate'),
      makeCompleted('a1', 'committed'),
      makeCompleted('a2', 'uncertain'),
      makePrepared('a3', 'submit'),
    ];

    expect(slimHistory(events)).toEqual([
      'a1 click → committed',
      'a2 navigate → uncertain',
      'a3 submit → running',
    ]);
  });

  it('failed 结果如实反映', () => {
    const events: BrowserTaskEvent[] = [
      makePrepared('a1', 'click'),
      makeCompleted('a1', 'failed'),
    ];

    expect(slimHistory(events)).toEqual(['a1 click → failed']);
  });

  it('max 截断取最近（末尾）', () => {
    const events: BrowserTaskEvent[] = [
      makePrepared('a1', 'click'),
      makePrepared('a2', 'navigate'),
      makePrepared('a3', 'submit'),
      makeCompleted('a1', 'committed'),
      makeCompleted('a2', 'uncertain'),
      makeCompleted('a3', 'failed'),
    ];

    expect(slimHistory(events, 2)).toEqual([
      'a2 navigate → uncertain',
      'a3 submit → failed',
    ]);
  });

  it('completed 无对应 prepared（恢复场景）被忽略', () => {
    expect(slimHistory([makeCompleted('ghost', 'failed')])).toEqual([]);
  });

  it('无事件 → 空数组', () => {
    expect(slimHistory([])).toEqual([]);
  });
});

describe('slimErrors', () => {
  it('格式 [kind] code: message', () => {
    const errors: ClassifiedError[] = [
      { kind: 'element', code: 'E_NOT_FOUND', message: '目标元素不存在', retryable: true },
      { kind: 'transient', code: 'E_TIMEOUT', message: '等待超时', retryable: true, actionId: 'a1' },
      { kind: 'policy', code: 'E_DENIED', message: '超出授权范围', retryable: false },
    ];

    expect(slimErrors(errors)).toEqual([
      '[element] E_NOT_FOUND: 目标元素不存在',
      '[transient] E_TIMEOUT: 等待超时',
      '[policy] E_DENIED: 超出授权范围',
    ]);
  });

  it('max 截断取最近（末尾）', () => {
    const errors: ClassifiedError[] = Array.from({ length: 4 }, (_, i) => ({
      kind: 'element' as const,
      code: `E${i + 1}`,
      message: `m${i + 1}`,
      retryable: true,
    }));

    expect(slimErrors(errors, 2)).toEqual(['[element] E3: m3', '[element] E4: m4']);
  });

  it('无错误 → 空数组', () => {
    expect(slimErrors([])).toEqual([]);
  });
});

describe('URL 清洗（13.2 凭证规则）', () => {
  it('页面 URL 携带 code/token 查询参数时，上下文不含敏感值', () => {
    const state = buildSlimContextState(makeObs({ url: 'https://example.com/oauth/callback?code=abc123&state=x#frag' }));

    expect(state.url).toBe('https://example.com/oauth/callback');
    expect(JSON.stringify(state)).not.toContain('abc123');
    expect(JSON.stringify(state)).not.toContain('frag');

    const text = slimObservationContext(makeObs({ url: 'https://example.com/oauth/callback?code=abc123' }));
    expect(text).not.toContain('abc123');
    expect(text).toContain('https://example.com/oauth/callback');
  });

  it('URL userinfo 凭据不进上下文', () => {
    const state = buildSlimContextState(makeObs({ url: 'https://user:secret@example.com/' }));
    expect(JSON.stringify(state)).not.toContain('secret');
  });
});

describe('空输入边界', () => {
  it('空元素/空内容 → 空数组，页面字段仍透传', () => {
    const state = buildSlimContextState(makeObs());

    expect(state.elements).toEqual([]);
    expect(state.content).toEqual([]);
    expect(state.pageId).toBe('page-1');
    expect(state.flags).toEqual({ captchaDetected: false, authRequired: false });
  });

  it('空 obs 的注入文本只有 [page] 一行', () => {
    const text = slimObservationContext(makeObs());
    const lines = text.split('\n');

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('[page]');
  });
});
