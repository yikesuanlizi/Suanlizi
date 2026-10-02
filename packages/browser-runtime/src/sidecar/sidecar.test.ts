// Node.js Sidecar 测试：JSONL 协议帧契约
// — English: Node.js sidecar tests — the JSONL protocol frame contract.
// 覆盖：start→navigate→observe→act 全链路（navigate/observe 返回完整 Observation
// 载荷，act 返回完整 ActionResult 三态）、重复 start、非法 intent、cancel 中止、
// 非法 JSON、重复 frameId 丢弃、deadline 过期、close 后 observe、未 start 操作，
// 以及注入 nextSeq 的序号契约。
// — English: covers the full start→navigate→observe→act flow (full Observation
//   payloads for navigate/observe, full three-state ActionResult for act),
//   duplicate start, invalid intent, cancellation, malformed JSON, duplicate
//   frameIds, expired deadlines, observe-after-close, not-started operations
//   and seq injection.
import { describe, expect, it } from 'vitest';
import type { ActionIntent } from '@suanlizi/protocol';
import type { FakeSiteDefinition } from '../fakeRuntime.js';
import { FakeBrowserRuntime } from '../fakeRuntime.js';
import { createSidecar } from './sidecar.js';
import type { SidecarHandle } from './sidecar.js';

// 内存 fake 站点：起始页 → 结果页（点击链接导航）。
// — English: in-memory fake site — start page → result page (link click navigates).
const site: FakeSiteDefinition = {
  startUrl: 'https://shop.example/start',
  defaultDelayMs: 2,
  pages: [
    {
      url: 'https://shop.example/start',
      title: 'Shop Start',
      elements: [
        {
          ref: 'link-result-1',
          role: 'link',
          name: '查看结果',
          text: '查看结果',
          href: 'https://shop.example/result',
        },
      ],
    },
    {
      url: 'https://shop.example/result',
      title: 'Shop Result',
      elements: [{ ref: 'result-item-1', role: 'listitem', name: '结果 1', text: '结果 1' }],
    },
  ],
};

// 构造 ActionIntent 的测试辅助函数。
// — English: test helper building an ActionIntent.
function makeIntent(overrides: Partial<ActionIntent> = {}): ActionIntent {
  return {
    actionId: 'act-1',
    taskId: 'task-1',
    pageId: 'page-1',
    observationId: 'obs-task-1-1-1',
    expectedNavigationEpoch: 1,
    kind: 'click',
    targetRef: '[e1]',
    arguments: {},
    rationale: '测试动作',
    effect: 'local',
    risk: 'low',
    postcondition: { kind: 'none' },
    ...overrides,
  };
}

// 构造一行 command 帧（JSONL）；extra 用于 deadline 等附加字段。
// — English: builds one command frame line; extra for fields like deadline.
function commandLine(
  frameId: string,
  action: string,
  payload: unknown,
  extra: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    version: '1.0.0',
    frameId,
    sessionId: 'unknown',
    seq: 1,
    timestamp: Date.now(),
    traceId: 'trace-1',
    type: 'command',
    action,
    payload,
    ...extra,
  });
}

// 解析返回的帧字符串。
// — English: parses a returned frame string.
function parseFrame(line: string): Record<string, unknown> {
  return JSON.parse(line) as Record<string, unknown>;
}

// 取帧 payload 的 Record 视图。
// — English: payload as a Record view.
function p(frame: Record<string, unknown>): Record<string, unknown> {
  const payload = frame.payload;
  return typeof payload === 'object' && payload !== null ? (payload as Record<string, unknown>) : {};
}

async function startSession(sidecar: SidecarHandle, frameId = 'f-start'): Promise<void> {
  await sidecar.handleLine(commandLine(frameId, 'session.start', { taskId: 'task-1' }));
}

describe('Sidecar', () => {
  it('start → navigate → observe → act 全链路（帧类型/action/载荷）', async () => {
    const sidecar = createSidecar({ runtime: new FakeBrowserRuntime(site) });

    // session.start → response ok { sessionId, taskId }
    const startFrames = await sidecar.handleLine(commandLine('f-start', 'session.start', { taskId: 'task-1' }));
    expect(startFrames).toHaveLength(1);
    const startResp = parseFrame(startFrames[0]!);
    expect(startResp.type).toBe('response');
    expect(startResp.action).toBe('session.start');
    expect(startResp.frameId).toBe('f-start'); // frameId 关联请求
    expect(startResp.seq).toBe(1); // 默认 nextSeq 从 1 递增
    expect(startResp.traceId).toBe('trace-1'); // traceId 透传
    expect(p(startResp)).toMatchObject({ sessionId: 'sess-task-1', taskId: 'task-1' });
    expect(sidecar.session).not.toBeNull();

    // browser.navigate → response ok（完整 Observation 原样返回）
    const navFrames = await sidecar.handleLine(
      commandLine('f-nav', 'browser.navigate', { url: 'https://shop.example/result' }),
    );
    expect(navFrames).toHaveLength(1);
    const navResp = parseFrame(navFrames[0]!);
    expect(navResp.type).toBe('response');
    expect(navResp.action).toBe('browser.navigate');
    expect(navResp.seq).toBe(2);
    const navPayload = p(navResp);
    expect(navPayload).toMatchObject({
      observationId: expect.any(String),
      taskId: 'task-1',
      pageId: 'page-1',
      navigationEpoch: 2,
      url: 'https://shop.example/result',
      title: 'Shop Result',
      readiness: 'stable',
    });
    // 完整 Observation：元素列表跨 IPC 原样传输（14.1：元素是必需数据）。
    // — English: full Observation — the element list crosses the IPC verbatim.
    const navElements = navPayload.elements as Array<Record<string, unknown>>;
    expect(navElements).toHaveLength(1);
    expect(navElements[0]).toMatchObject({ ref: '[e1]', role: 'listitem', name: '结果 1' });

    // browser.observe → response ok（同样完整 Observation）
    const obsFrames = await sidecar.handleLine(commandLine('f-obs', 'browser.observe', {}));
    expect(obsFrames).toHaveLength(1);
    const obsResp = parseFrame(obsFrames[0]!);
    expect(obsResp.type).toBe('response');
    expect(obsResp.action).toBe('browser.observe');
    const obsPayload = p(obsResp);
    expect(obsPayload).toMatchObject({
      url: 'https://shop.example/result',
      title: 'Shop Result',
      pageId: 'page-1',
      navigationEpoch: 2,
    });
    expect(obsPayload.elements).toHaveLength(1);
    const observationId = String(obsPayload.observationId);

    // browser.act → prepared 事件 + committed 事件 + response ok
    const actFrames = await sidecar.handleLine(
      commandLine('f-act', 'browser.act', {
        intent: makeIntent({
          observationId,
          expectedNavigationEpoch: 2,
          postcondition: { kind: 'url_contains', value: 'result' },
        }),
      }),
    );
    expect(actFrames).toHaveLength(3);
    const [prepared, outcome, actResp] = actFrames.map(parseFrame);
    expect(prepared.type).toBe('event');
    expect(prepared.action).toBe('browser.action_status');
    expect(p(prepared)).toMatchObject({ actionId: 'act-1', status: 'prepared' });
    expect(outcome.type).toBe('event');
    expect(p(outcome).status).toBe('committed');
    expect(actResp.type).toBe('response');
    expect(actResp.action).toBe('browser.act');
    expect(actResp.frameId).toBe('f-act');
    const actPayload = p(actResp);
    expect(actPayload.status).toBe('committed'); // 点击链接命中 url_contains 'result'
    const evidence = actPayload.evidence as Record<string, unknown>;
    expect(evidence.actionId).toBe('act-1');
    expect(typeof evidence.verifiedAt).toBe('number');
    expect(Array.isArray(evidence.checks)).toBe(true);
    expect((evidence.observed as Record<string, unknown>).url).toBe('https://shop.example/result');
  });

  it('重复 start → error ALREADY_STARTED', async () => {
    const sidecar = createSidecar({ runtime: new FakeBrowserRuntime(site) });
    await startSession(sidecar);
    const frames = await sidecar.handleLine(commandLine('f-2', 'session.start', { taskId: 'task-2' }));
    expect(frames).toHaveLength(1);
    const resp = parseFrame(frames[0]!);
    expect(resp.type).toBe('response');
    expect(resp.frameId).toBe('f-2');
    expect(p(resp)).toMatchObject({ code: 'ALREADY_STARTED', retryable: false });
  });

  it('非法 intent（缺 rationale）→ error BAD_INTENT', async () => {
    const sidecar = createSidecar({ runtime: new FakeBrowserRuntime(site) });
    await startSession(sidecar);
    const invalid = { ...makeIntent() };
    delete (invalid as Partial<ActionIntent>).rationale;
    const frames = await sidecar.handleLine(commandLine('f-2', 'browser.act', { intent: invalid }));
    expect(frames).toHaveLength(1);
    expect(p(parseFrame(frames[0]!)).code).toBe('BAD_INTENT');
  });

  it('cancel 帧中止慢动作 → 动作以 cancelled 失败', async () => {
    const slowSite: FakeSiteDefinition = {
      startUrl: 'https://slow.example/',
      defaultDelayMs: 2,
      pages: [
        {
          url: 'https://slow.example/',
          title: 'Slow Page',
          elements: [{ ref: 'btn-go', role: 'button', name: 'Go', text: 'Go' }],
          // 动作副作用延迟 200ms：为 cancel 留出窗口。
          // — English: 200ms side-effect delay — leaves a cancellation window.
          onAction: () => ({ kind: 'delay', delayMs: 200 }),
        },
      ],
    };
    const sidecar = createSidecar({ runtime: new FakeBrowserRuntime(slowSite) });
    await sidecar.handleLine(commandLine('f-1', 'session.start', { taskId: 'task-c' }));
    await sidecar.handleLine(commandLine('f-2', 'browser.observe', {}));

    // act 开始执行（不 await），随后立即发 cancel。
    // — English: start act without awaiting, then send cancel right away.
    const actPromise = sidecar.handleLine(
      commandLine('f-3', 'browser.act', {
        intent: makeIntent({ taskId: 'task-c', actionId: 'act-c' }),
      }),
    );
    const cancelFrames = await sidecar.handleLine(
      JSON.stringify({
        version: '1.0.0',
        frameId: 'f-4',
        sessionId: 'sess-task-c',
        seq: 1,
        timestamp: Date.now(),
        traceId: 'trace-c',
        type: 'cancel',
        action: 'cancel',
        payload: { actionId: 'act-c' },
      }),
    );
    // cancel 帧本身不产生输出帧。
    // — English: the cancel frame itself emits nothing.
    expect(cancelFrames).toHaveLength(0);

    const actFrames = await actPromise;
    expect(actFrames).toHaveLength(3);
    const [prepared, outcome, resp] = actFrames.map(parseFrame);
    expect(p(prepared).status).toBe('prepared');
    expect(p(outcome)).toMatchObject({ actionId: 'act-c', status: 'failed' });
    expect((p(outcome).error as Record<string, unknown>).kind).toBe('cancelled');
    expect(p(resp).status).toBe('failed');
    expect((p(resp).error as Record<string, unknown>).kind).toBe('cancelled');
  });

  it('非法 JSON 行 → error BAD_FRAME（message=invalid frame）', async () => {
    const sidecar = createSidecar({ runtime: new FakeBrowserRuntime(site) });
    const frames = await sidecar.handleLine('this is not json {{{');
    expect(frames).toHaveLength(1);
    const resp = parseFrame(frames[0]!);
    expect(resp.type).toBe('response');
    expect(p(resp)).toMatchObject({ code: 'BAD_FRAME', message: 'invalid frame' });
  });

  it('重复 frameId 丢弃：第二次无输出帧', async () => {
    const sidecar = createSidecar({ runtime: new FakeBrowserRuntime(site) });
    await startSession(sidecar);
    const line = commandLine('f-dup', 'browser.navigate', { url: 'https://shop.example/result' });
    const first = await sidecar.handleLine(line);
    expect(first).toHaveLength(1);
    const second = await sidecar.handleLine(line);
    expect(second).toHaveLength(0);
  });

  it('deadline 过期 → error DEADLINE（不执行）', async () => {
    const sidecar = createSidecar({ runtime: new FakeBrowserRuntime(site) });
    await startSession(sidecar);
    const frames = await sidecar.handleLine(
      commandLine('f-2', 'browser.navigate', { url: 'https://shop.example/result' }, {
        deadline: Date.now() - 1000,
      }),
    );
    expect(frames).toHaveLength(1);
    expect(p(parseFrame(frames[0]!)).code).toBe('DEADLINE');
  });

  it('session.close 后 observe → error 帧', async () => {
    const sidecar = createSidecar({ runtime: new FakeBrowserRuntime(site) });
    await startSession(sidecar);
    const closeFrames = await sidecar.handleLine(commandLine('f-2', 'session.close', {}));
    expect(closeFrames).toHaveLength(1);
    const closeResp = parseFrame(closeFrames[0]!);
    expect(closeResp.type).toBe('response');
    expect(closeResp.action).toBe('session.close');
    expect(sidecar.session).toBeNull();
    const obsFrames = await sidecar.handleLine(commandLine('f-3', 'browser.observe', {}));
    expect(obsFrames).toHaveLength(1);
    const obsResp = parseFrame(obsFrames[0]!);
    expect(obsResp.type).toBe('response');
    expect(typeof p(obsResp).code).toBe('string'); // error 帧存在
    expect(p(obsResp).code).toBe('NOT_STARTED');
  });

  it('未 start 时 navigate → error NOT_STARTED', async () => {
    const sidecar = createSidecar({ runtime: new FakeBrowserRuntime(site) });
    const frames = await sidecar.handleLine(
      commandLine('f-1', 'browser.navigate', { url: 'https://shop.example/result' }),
    );
    expect(frames).toHaveLength(1);
    const resp = parseFrame(frames[0]!);
    expect(resp.type).toBe('response');
    expect(p(resp).code).toBe('NOT_STARTED');
  });

  it('注入 nextSeq：输出帧使用注入的序号', async () => {
    let n = 100;
    const sidecar = createSidecar({
      runtime: new FakeBrowserRuntime(site),
      nextSeq: () => {
        n += 1;
        return n;
      },
    });
    const frames = await sidecar.handleLine(commandLine('f-1', 'session.start', { taskId: 'task-1' }));
    expect(parseFrame(frames[0]!).seq).toBe(101);
  });
});
