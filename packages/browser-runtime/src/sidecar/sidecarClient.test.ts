// SidecarClient 测试：与真实 Sidecar（createSidecar）对聊的端到端 JSONL 客户端契约
// — English: SidecarClient tests — the end-to-end JSONL client contract against
//   a real Sidecar (createSidecar) over an in-memory transport.
// 覆盖：start→navigate→observe→act→close 全链路、browser.action_status 事件
// 转发、act 取消（cancel 帧）、命令超时、非法响应载荷（BAD_RESPONSE）与
// close 后会话关闭错误。
// — English: covers the full start→navigate→observe→act→close flow,
//   browser.action_status forwarding, act cancellation (cancel frame), command
//   timeout, invalid response payloads (BAD_RESPONSE) and post-close errors.
import { describe, expect, it } from 'vitest';
import type { ActionIntent } from '@suanlizi/protocol';
import type { FakeSiteDefinition } from '../fakeRuntime.js';
import { FakeBrowserRuntime } from '../fakeRuntime.js';
import { createSidecar } from './sidecar.js';
import type { SidecarHandle } from './sidecar.js';
import { createSidecarClient } from './sidecarClient.js';
import type { SidecarTransport } from './sidecarClient.js';
import { ipcCodec } from '../ipc/codec.js';
import type { ProtocolFrame } from '../ipc/ipcTypes.js';

// 内存 transport：sendLine 把行交给 sidecarHandle.handleLine，返回的帧字符串
// 数组逐行回灌 onLine handler；close 置标志。muted 模拟无响应对端。
// — English: in-memory transport — sendLine feeds sidecarHandle.handleLine and
//   the returned frame strings are replayed to onLine; close sets a flag.
//   mute mode simulates an unresponsive peer.
class MemoryTransport implements SidecarTransport {
  private handler: ((line: string) => void) | null = null;
  private muted = false;
  closed = false;

  constructor(private readonly sidecar: SidecarHandle) {}

  sendLine(line: string): void {
    if (this.closed || this.muted) return;
    void this.sidecar.handleLine(line).then((frames) => {
      for (const frame of frames) this.handler?.(frame);
    });
  }

  onLine(handler: (line: string) => void): void {
    this.handler = handler;
  }

  close(): void {
    this.closed = true;
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
  }
}

// 记录型 transport：记录所有发送行（解析后），供 cancel 帧断言。
// — English: recording transport — records all sent lines (parsed), used to
//   assert the cancel frame was sent.
class RecordingTransport extends MemoryTransport {
  readonly sentFrames: ProtocolFrame[] = [];

  constructor(sidecar: SidecarHandle) {
    super(sidecar);
  }

  sendLine(line: string): void {
    const frame = ipcCodec.decodeLine(line);
    if (frame !== null) this.sentFrames.push(frame);
    super.sendLine(line);
  }
}

// 拦截 transport：可对指定命令注入伪造响应（不经过 sidecar），用于非法载荷测试。
// — English: intercepting transport — injects forged responses for selected
//   commands (bypassing the sidecar), used for invalid-payload tests.
class InterceptingTransport implements SidecarTransport {
  private handler: ((line: string) => void) | null = null;
  closed = false;

  constructor(
    private readonly sidecar: SidecarHandle,
    private readonly inject: (frame: ProtocolFrame) => string[] | null | undefined,
  ) {}

  sendLine(line: string): void {
    const frame = ipcCodec.decodeLine(line);
    if (frame !== null) {
      const injected = this.inject(frame);
      if (injected !== null && injected !== undefined) {
        for (const f of injected) this.handler?.(f);
        return;
      }
    }
    void this.sidecar.handleLine(line).then((frames) => {
      for (const f of frames) this.handler?.(f);
    });
  }

  onLine(handler: (line: string) => void): void {
    this.handler = handler;
  }

  close(): void {
    this.closed = true;
  }
}

// 内存 fake 站点：列表页 → 详情页（点击链接导航）。
// — English: in-memory fake site — list page → detail page (link click navigates).
const site: FakeSiteDefinition = {
  startUrl: 'https://example.com/list',
  defaultDelayMs: 2,
  pages: [
    {
      url: 'https://example.com/list',
      title: 'Example List',
      elements: [
        {
          ref: 'link-detail',
          role: 'link',
          name: '查看详情',
          text: '查看详情',
          href: 'https://example.com/detail',
        },
        { ref: 'item-1', role: 'listitem', name: '条目 1', text: '条目 1' },
      ],
    },
    {
      url: 'https://example.com/detail',
      title: 'Example Detail',
      elements: [{ ref: 'detail-title', role: 'heading', name: '详情页', text: '详情页' }],
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
    observationId: 'obs-1',
    expectedNavigationEpoch: 1,
    kind: 'click',
    targetRef: '[e1]',
    arguments: {},
    rationale: '测试动作',
    effect: 'local',
    risk: 'low',
    postcondition: { kind: 'url_contains', value: 'detail' },
    ...overrides,
  };
}

describe('SidecarClient', () => {
  it('全链路：start → navigate → observe → act → close', async () => {
    const sidecar = createSidecar({ runtime: new FakeBrowserRuntime(site), log: () => {} });
    const transport = new MemoryTransport(sidecar);
    const client = await createSidecarClient({ taskId: 'task-1', transport });

    expect(client.taskId).toBe('task-1');
    expect(client.sessionId).toBe('sess-task-1');

    // navigate → 完整 Observation（元素 [e1] 存在）。
    // — English: navigate → full Observation (element [e1] present).
    const nav = await client.navigate({ url: 'https://example.com/list' });
    expect(nav.url).toBe('https://example.com/list');
    expect(nav.title).toBe('Example List');
    expect(nav.taskId).toBe('task-1');
    expect(nav.readiness).toBe('stable');
    expect(nav.elements.length).toBeGreaterThan(0);
    expect(nav.elements[0]!.ref).toBe('[e1]');
    expect(nav.elements[0]!.role).toBe('link');
    expect(nav.elements[0]!.name).toBe('查看详情');

    // observe → 完整 Observation。
    const obs = await client.observe();
    expect(obs.pageId).toBe('page-1');
    expect(obs.elements.map((e) => e.ref)).toEqual(['[e1]', '[e2]']);
    expect(obs.observationId).not.toBe(nav.observationId);
    expect(typeof obs.capturedAt).toBe('number');

    // currentPageGraph 基于最近一次 Observation。
    const graph = client.currentPageGraph();
    expect(graph.activePageId).toBe('page-1');
    expect(graph.pages).toHaveLength(1);
    expect(graph.pages[0]).toMatchObject({
      pageId: 'page-1',
      url: 'https://example.com/list',
      title: 'Example List',
      state: 'active',
      navigationEpoch: obs.navigationEpoch,
    });

    const remoteGraph = await client.listPages();
    expect(remoteGraph).toEqual(graph);

    // act：click [e1] → 详情页，postcondition url_contains 'detail' 通过。
    const result = await client.act({
      intent: makeIntent({
        actionId: 'act-1',
        observationId: obs.observationId,
        expectedNavigationEpoch: obs.navigationEpoch,
        postcondition: { kind: 'url_contains', value: 'detail' },
      }),
    });
    expect(result.status).toBe('committed');
    if (result.status === 'committed') {
      expect(result.evidence.actionId).toBe('act-1');
      expect(typeof result.evidence.verifiedAt).toBe('number');
      expect(result.evidence.observed?.url).toBe('https://example.com/detail');
    }

    // close：等 session.close 响应后关闭 transport。
    await client.close('done');
    expect(transport.closed).toBe(true);
  });

  it('事件转发：act 期间 onActionStatus 收到 prepared 与 committed', async () => {
    const sidecar = createSidecar({ runtime: new FakeBrowserRuntime(site), log: () => {} });
    const transport = new MemoryTransport(sidecar);
    const statuses: Array<Record<string, unknown>> = [];
    const client = await createSidecarClient({
      taskId: 'task-2',
      transport,
      onActionStatus: (payload) => statuses.push(payload as Record<string, unknown>),
    });
    const obs = await client.observe();

    const result = await client.act({
      intent: makeIntent({
        actionId: 'act-2',
        observationId: obs.observationId,
        expectedNavigationEpoch: obs.navigationEpoch,
      }),
    });
    expect(result.status).toBe('committed');

    // 事件与响应走同一批帧：prepared 与 committed 各至少一次，actionId 正确。
    // — English: events and the response arrive in the same frame batch —
    //   prepared and committed each at least once, with the right actionId.
    expect(statuses.length).toBeGreaterThanOrEqual(2);
    const prepared = statuses.find((s) => s.status === 'prepared');
    expect(prepared).toBeDefined();
    expect(prepared?.actionId).toBe('act-2');
    expect(statuses.some((s) => s.status === 'committed')).toBe(true);
  });

  it('navigate 透传 pageId，未知页面不会回退到根页面', async () => {
    const sidecar = createSidecar({ runtime: new FakeBrowserRuntime(site), log: () => {} });
    const transport = new MemoryTransport(sidecar);
    const client = await createSidecarClient({ taskId: 'task-page', transport });

    await expect(client.navigate({ url: 'https://example.com/list', pageId: 'popup-1' })).rejects.toMatchObject({
      code: 'PAGE_NOT_FOUND',
      retryable: true,
    });
  });

  it('取消：abort 触发 cancel 帧 → act 返回 failed kind=cancelled', async () => {
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
    const sidecar = createSidecar({ runtime: new FakeBrowserRuntime(slowSite), log: () => {} });
    const transport = new MemoryTransport(sidecar);
    const client = await createSidecarClient({ taskId: 'task-c', transport, timeoutMs: 5000 });
    const obs = await client.observe();

    // act 开始（不 await），随后 abort → client 发 cancel 帧。
    // — English: start act without awaiting, then abort — the client sends a cancel frame.
    const controller = new AbortController();
    const actPromise = client.act({
      intent: makeIntent({
        taskId: 'task-c',
        actionId: 'act-c',
        observationId: obs.observationId,
        expectedNavigationEpoch: obs.navigationEpoch,
        postcondition: { kind: 'none' },
      }),
      signal: controller.signal,
    });
    controller.abort();

    const result = await actPromise;
    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.error.kind).toBe('cancelled');
      expect(result.error.code).toBe('ABORTED');
    }
  });

  it('client signal 触发 cancel 帧并收到 cancelled 失败', async () => {
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
    const sidecar = createSidecar({ runtime: new FakeBrowserRuntime(slowSite), log: () => {} });
    // 记录型 transport：断言 client 确实发出了 cancel 帧。
    // — English: recording transport — asserts the client really sent a cancel frame.
    const transport = new RecordingTransport(sidecar);
    const controller = new AbortController();
    const client = await createSidecarClient({
      taskId: 'task-csig',
      transport,
      signal: controller.signal, // client 级 signal（非方法级）
      timeoutMs: 5000,
    });
    const obs = await client.observe();

    // act 开始（不 await），随后 abort client signal → client 发 cancel 帧。
    // — English: start act without awaiting, then abort the client signal —
    //   the client sends a cancel frame.
    const actPromise = client.act({
      intent: makeIntent({
        taskId: 'task-csig',
        actionId: 'act-csig',
        observationId: obs.observationId,
        expectedNavigationEpoch: obs.navigationEpoch,
        postcondition: { kind: 'none' },
      }),
    });
    controller.abort();

    const result = await actPromise;
    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.error.kind).toBe('cancelled');
      expect(result.error.code).toBe('ABORTED');
    }

    // transport 收到过 cancel 帧（payload { actionId }）。
    const cancelFrames = transport.sentFrames.filter((f) => f.type === 'cancel');
    expect(cancelFrames.length).toBeGreaterThanOrEqual(1);
    expect(cancelFrames[0]!.payload).toMatchObject({ actionId: 'act-csig' });
  });

  it('超时：timeoutMs 内无响应 → transient SIDECAR_TIMEOUT', async () => {
    const sidecar = createSidecar({ runtime: new FakeBrowserRuntime(site), log: () => {} });
    const transport = new MemoryTransport(sidecar);
    const client = await createSidecarClient({ taskId: 'task-4', transport, timeoutMs: 30 });
    // 静默：navigate 帧不再转发给 sidecar，无任何响应。
    // — English: mute — the navigate frame never reaches the sidecar.
    transport.setMuted(true);
    await expect(client.navigate({ url: 'https://example.com/list' })).rejects.toMatchObject({
      kind: 'transient',
      code: 'SIDECAR_TIMEOUT',
      retryable: true,
    });
  });

  it('非法响应载荷 → BAD_RESPONSE（observe 与 act）', async () => {
    const sidecar = createSidecar({ runtime: new FakeBrowserRuntime(site), log: () => {} });
    // 对 observe/act 注入缺字段（或形状非法）的 ok 响应。
    // — English: inject ok responses with missing fields (or illegal shapes).
    const transport = new InterceptingTransport(sidecar, (frame) => {
      if (frame.type !== 'command') return undefined;
      const payload =
        frame.action === 'browser.observe'
          ? { url: 'https://example.com/list' } // 缺 title/elements/…
          : frame.action === 'browser.act'
            ? { foo: 1 } // 无 status 三态
            : undefined;
      if (payload === undefined) return undefined;
      const resp = ipcCodec.makeFrame({
        sessionId: frame.sessionId,
        seq: 900,
        type: 'response',
        action: frame.action,
        payload,
        traceId: frame.traceId,
        frameId: frame.frameId,
      });
      return [ipcCodec.encode(resp)];
    });
    const client = await createSidecarClient({ taskId: 'task-5', transport });

    await expect(client.observe()).rejects.toMatchObject({ code: 'BAD_RESPONSE' });
    await expect(client.act({ intent: makeIntent() })).rejects.toMatchObject({ code: 'BAD_RESPONSE' });
  });

  it('close 后 observe/navigate/act → SESSION_CLOSED', async () => {
    const sidecar = createSidecar({ runtime: new FakeBrowserRuntime(site), log: () => {} });
    const transport = new MemoryTransport(sidecar);
    const client = await createSidecarClient({ taskId: 'task-6', transport });
    await client.close();
    expect(transport.closed).toBe(true);

    await expect(client.observe()).rejects.toMatchObject({ code: 'SESSION_CLOSED' });
    await expect(client.navigate({ url: 'https://example.com/list' })).rejects.toMatchObject({
      code: 'SESSION_CLOSED',
    });
    await expect(client.act({ intent: makeIntent() })).rejects.toMatchObject({ code: 'SESSION_CLOSED' });
  });
});
