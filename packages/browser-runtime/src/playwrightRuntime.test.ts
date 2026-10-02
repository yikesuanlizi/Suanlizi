// PlaywrightRuntime 测试：用注入的 fake loader（内存浏览器树）覆盖观测契约、
// 动作闭环、纪元校验、后置条件验证、取消传播与幂等关闭。
// — English: PlaywrightRuntime tests — an injected fake loader (in-memory browser
//   tree) covers observation contract, action loop, epoch validation,
//   postcondition verification, cancellation and idempotent close.
import { describe, expect, it } from 'vitest';
import type { ActionIntent } from '@suanlizi/protocol';
import { PlaywrightRuntime } from './playwrightRuntime.js';

// ─── 内存 fake 浏览器（鸭子类型实现 playwright 最小接口） ────────────────────
// — English: in-memory fake browser — duck-typed implementation of the minimal
//   playwright interfaces used by the runtime.
interface FakeRouteElement {
  tag: string;
  role?: string;
  name?: string;
  text?: string;
  href?: string;
  visible?: boolean;
  enabled?: boolean;
  onClick?: () => void; // 模拟点击副作用（默认 a 链接导航到 href）
}
interface FakeRoute {
  url: string;
  title: string;
  elements: FakeRouteElement[];
  content?: Array<{ type: string; text: string; href?: string }>;
  forms?: Array<{ formId: string; action?: string; method?: 'get' | 'post'; fields: Array<{ name: string; fieldType?: string; required: boolean }> }>;
}

// 解析 Playwright 选择器（本项目只生成 tag / [role=...] / :has-text 组合）。
// — English: parses the selectors this runtime generates.
function parseSelector(selector: string): { tag?: string; role?: string; text?: string } {
  const hasText = /:has-text\("((?:[^"\\]|\\.)*)"\)/.exec(selector);
  const text = hasText === null ? undefined : hasText[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  const roleMatch = /^\[role="([^"]+)"\]/.exec(selector);
  if (roleMatch !== null) return { role: roleMatch[1], text };
  const tagMatch = /^([a-zA-Z][a-zA-Z0-9]*)/.exec(selector);
  return { tag: tagMatch === null ? undefined : tagMatch[1], text };
}

class FakeLocatorImpl {
  constructor(
    private readonly page: FakePageImpl,
    private readonly selector: string,
    private readonly index = 0,
  ) {}

  private matches(): FakeRouteElement[] {
    const { tag, role, text } = parseSelector(this.selector);
    return this.page.currentElements().filter((el) => {
      if (tag !== undefined && el.tag !== tag) return false;
      if (role !== undefined && el.role !== role) return false;
      if (text !== undefined && !(el.text ?? '').includes(text)) return false;
      return true;
    });
  }

  async count(): Promise<number> {
    return this.matches().length;
  }

  nth(i: number): FakeLocatorImpl {
    return new FakeLocatorImpl(this.page, this.selector, i);
  }

  private one(): FakeRouteElement {
    const el = this.matches()[this.index];
    if (el === undefined) throw new Error('locator resolved to 0 elements');
    return el;
  }

  async click(): Promise<void> {
    const el = this.one();
    // 模拟真实点击耗时：供取消测试在「执行中」触发 abort。
    // — English: simulated click latency — lets cancellation tests abort mid-action.
    if (this.page.clickDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.page.clickDelayMs));
    }
    if (el.onClick !== undefined) {
      el.onClick();
      return;
    }
    if (el.tag === 'a' && el.href !== undefined) await this.page.goto(el.href);
  }

  async fill(value: string): Promise<void> {
    this.one().text = value;
  }

  async selectOption(value: unknown): Promise<void> {
    this.one().text = String(value);
  }

  async press(key: string): Promise<void> {
    this.one().text = key;
  }

  async isVisible(): Promise<boolean> {
    const el = this.matches()[this.index];
    return el !== undefined && el.visible !== false;
  }

  async isEnabled(): Promise<boolean> {
    const el = this.matches()[this.index];
    return el === undefined || el.enabled !== false;
  }

  async textContent(): Promise<string | null> {
    const el = this.matches()[this.index];
    return el === undefined ? null : (el.text ?? null);
  }
}

class FakePageImpl {
  // 注意：字段名不能与同名方法冲突（类字段会遮蔽原型方法），因此用 currentUrl/currentTitle。
  // — English: field names must not shadow same-named methods (class fields win over prototype methods).
  private currentUrl = 'about:blank';
  private currentTitle = '';
  readonly gotoCalls: string[] = [];
  readonly scrollCalls: number[] = [];
  clickDelayMs = 0;

  constructor(private readonly routes: FakeRoute[]) {}

  private get currentRoute(): FakeRoute | undefined {
    return this.routes.find((r) => r.url === this.currentUrl);
  }

  currentElements(): FakeRouteElement[] {
    return this.currentRoute?.elements ?? [];
  }

  async goto(url: string): Promise<{ url(): string }> {
    this.gotoCalls.push(url);
    if (url === 'about:blank') {
      this.currentUrl = url;
      this.currentTitle = '';
      return { url: () => url };
    }
    const route = this.routes.find((r) => r.url === url);
    if (route === undefined) throw new Error(`net::ERR_NAME_NOT_RESOLVED ${url}`);
    this.currentUrl = route.url;
    this.currentTitle = route.title;
    return { url: () => this.currentUrl };
  }

  url(): string {
    return this.currentUrl;
  }

  async title(): Promise<string> {
    return this.currentTitle;
  }

  async screenshot(): Promise<Uint8Array> {
    return Buffer.from('fake-jpeg');
  }

  // evaluate：scrollBy 脚本记录调用；其余按快照脚本语义返回可序列化快照。
  // — English: scrollBy scripts are recorded; anything else returns a snapshot.
  async evaluate(fn: unknown): Promise<unknown> {
    const script = String(fn);
    if (script.includes('scrollBy')) {
      const m = /scrollBy\(0,\s*(\d+)\)/.exec(script);
      this.scrollCalls.push(m === null ? 0 : Number(m[1]));
      return undefined;
    }
    return {
      elements: this.currentElements().map((el, i) => ({
        index: i + 1,
        tag: el.tag,
        role: el.role,
        name: el.name,
        text: el.text,
        href: el.href,
        visible: el.visible !== false,
        enabled: el.enabled !== false,
      })),
      content: this.currentRoute?.content ?? [],
      forms: this.currentRoute?.forms ?? [],
    };
  }

  locator(selector: string): FakeLocatorImpl {
    return new FakeLocatorImpl(this, selector);
  }

  async close(): Promise<void> {}
}

class FakeContextImpl {
  readonly pages: FakePageImpl[] = [];
  closeCalls = 0;

  constructor(private readonly routes: FakeRoute[]) {}

  async newPage(): Promise<FakePageImpl> {
    const page = new FakePageImpl(this.routes);
    this.pages.push(page);
    return page;
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
  }
}

// 同时扮演 BrowserLike（launch）与 BrowserLikeInstance（newContext/close）。
// — English: plays both BrowserLike (launch) and BrowserLikeInstance roles.
class FakeBrowserImpl {
  readonly launchCalls: Array<{ headless: boolean }> = [];
  readonly contexts: FakeContextImpl[] = [];
  closeCalls = 0;

  constructor(private readonly routes: FakeRoute[]) {}

  async launch(options: { headless: boolean }): Promise<FakeBrowserImpl> {
    this.launchCalls.push(options);
    return this;
  }

  async newContext(): Promise<FakeContextImpl> {
    const context = new FakeContextImpl(this.routes);
    this.contexts.push(context);
    return context;
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
  }
}

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
    effect: 'none',
    risk: 'low',
    postcondition: { kind: 'none' },
    ...overrides,
  };
}

// 测试站点：列表页（链接 + 按钮）与详情页。
// — English: test site — a list page (link + button) and a detail page.
function testSite(): FakeRoute[] {
  return [
    {
      url: 'https://example.com/list',
      title: '列表页',
      elements: [
        { tag: 'a', role: 'link', name: '结果一', text: '结果一', href: 'https://example.com/detail' },
        { tag: 'button', role: 'button', name: '提交', text: '提交' },
      ],
      content: [{ type: 'heading', text: '示例列表' }],
      forms: [{ formId: 'f1', method: 'get', fields: [{ name: 'q', fieldType: 'text', required: false }] }],
    },
    {
      url: 'https://example.com/detail',
      title: '详情页',
      elements: [{ tag: 'a', role: 'link', name: '返回列表', text: '返回列表', href: 'https://example.com/list' }],
      content: [{ type: 'paragraph', text: '详情内容' }],
    },
  ];
}

describe('PlaywrightRuntime', () => {
  it('start→navigate→observe：Observation 字段正确（[eN] 分配、provenance、epoch 递增）', async () => {
    const fakeBrowser = new FakeBrowserImpl(testSite());
    const runtime = new PlaywrightRuntime({ loader: async () => fakeBrowser, headless: true });
    const session = await runtime.start({ taskId: 'task-1' });

    expect(session.sessionId).toBe('sess-task-1');
    expect(session.taskId).toBe('task-1');
    expect(fakeBrowser.launchCalls).toEqual([{ headless: true }]);
    expect(fakeBrowser.contexts[0].pages[0].gotoCalls).toEqual(['about:blank']);

    // start 后（epoch 1）：单页图。
    const graph0 = session.currentPageGraph();
    expect(graph0.activePageId).toBe('page-1');
    expect(graph0.pages).toEqual([
      { pageId: 'page-1', url: 'about:blank', title: '', state: 'active', navigationEpoch: 1 },
    ]);

    const obs = await session.navigate({ url: 'https://example.com/list' });
    expect(obs.observationId).toBe('obs-task-1-2-1');
    expect(obs.taskId).toBe('task-1');
    expect(obs.pageId).toBe('page-1');
    expect(obs.navigationEpoch).toBe(2);
    expect(obs.url).toBe('https://example.com/list');
    expect(obs.title).toBe('列表页');
    expect(obs.readiness).toBe('stable');
    expect(obs.screenshotRef).toBe('data:image/jpeg;base64,ZmFrZS1qcGVn');
    expect(obs.network).toEqual({ pendingRequests: 0, recentFailures: [] });
    expect(obs.pageState).toEqual({ captchaDetected: false, authRequired: false });

    expect(obs.elements.map((e) => e.ref)).toEqual(['[e1]', '[e2]']);
    expect(obs.elements[0]).toMatchObject({
      role: 'link',
      name: '结果一',
      text: '结果一',
      frameId: 'frame-main',
      visible: true,
      enabled: true,
    });
    expect(obs.elements[0].fingerprint).toBe('fp:1:2');
    expect(obs.elements[0].provenance).toEqual({
      trust: 'untrusted',
      source: 'dom',
      origin: 'https://example.com',
      pageId: 'page-1',
      observationId: 'obs-task-1-2-1',
    });
    expect(obs.elements[1]).toMatchObject({ role: 'button', name: '提交', enabled: true });
    expect(obs.elements[1].fingerprint).toBe('fp:2:2');

    expect(obs.mainContent).toEqual([{ type: 'heading', text: '示例列表' }]);
    expect(obs.forms).toEqual([
      { formId: 'f1', method: 'get', fields: [{ name: 'q', fieldType: 'text', required: false }] },
    ]);

    const graph = session.currentPageGraph();
    expect(graph.pages[0]).toMatchObject({ url: 'https://example.com/list', title: '列表页', navigationEpoch: 2 });

    await session.close();
  });

  it('闭环：observe→click（链接导航）→ url_contains 后置条件命中 → committed', async () => {
    const fakeBrowser = new FakeBrowserImpl(testSite());
    const runtime = new PlaywrightRuntime({ loader: async () => fakeBrowser });
    const session = await runtime.start({ taskId: 'task-1' });
    await session.navigate({ url: 'https://example.com/list' });
    const obs = await session.observe();
    expect(obs.elements.map((e) => e.ref)).toEqual(['[e1]', '[e2]']);

    const result = await session.act({
      intent: makeIntent({
        expectedNavigationEpoch: 2,
        kind: 'click',
        targetRef: '[e1]',
        postcondition: { kind: 'url_contains', value: 'example.com/detail' },
      }),
    });

    expect(result.status).toBe('committed');
    if (result.status === 'committed') {
      expect(result.evidence.checks).toEqual([
        { postcondition: JSON.stringify({ kind: 'url_contains', value: 'example.com/detail' }), passed: true },
      ]);
      expect(result.evidence.observed).toMatchObject({ url: 'https://example.com/detail', title: '详情页' });
      // 链接点击导航：epoch 递增，旧引用作废。
      expect(result.evidence.observed?.navigationEpoch).toBe(3);
    }

    const obs2 = await session.observe();
    expect(obs2.url).toBe('https://example.com/detail');
    expect(obs2.navigationEpoch).toBe(3);
    expect(obs2.elements.map((e) => e.ref)).toEqual(['[e1]']);
    expect(obs2.elements[0].name).toBe('返回列表');

    await session.close();
  });

  it('act 内 navigate 动作：epoch 仅递增一次，新 epoch 引用可用', async () => {
    const fakeBrowser = new FakeBrowserImpl(testSite());
    const runtime = new PlaywrightRuntime({ loader: async () => fakeBrowser });
    const session = await runtime.start({ taskId: 'task-1' });
    await session.observe(); // epoch 1，url about:blank

    const result = await session.act({
      intent: makeIntent({
        kind: 'navigate',
        targetRef: undefined,
        arguments: { url: 'https://example.com/list' },
        postcondition: { kind: 'url_contains', value: 'example.com/list' },
      }),
    });
    expect(result.status).toBe('committed');
    if (result.status === 'committed') {
      // navigate 动作 epoch 只 +1（与 navigate() 方法语义一致，无双重递增）。
      expect(result.evidence.observed?.navigationEpoch).toBe(2);
    }

    // 新 epoch 引用可用：不触发 STALE_EPOCH。
    const obs2 = await session.observe();
    expect(obs2.navigationEpoch).toBe(2);
    expect(obs2.elements.map((e) => e.ref)).toEqual(['[e1]', '[e2]']);
    const click = await session.act({
      intent: makeIntent({
        expectedNavigationEpoch: 2,
        kind: 'click',
        targetRef: '[e1]',
        postcondition: { kind: 'url_contains', value: 'example.com/detail' },
      }),
    });
    expect(click.status).toBe('committed');

    await session.close();
  });

  it('旧引用拒绝：navigate 后（epoch++）用旧 epoch intent → failed STALE_EPOCH', async () => {
    const fakeBrowser = new FakeBrowserImpl(testSite());
    const runtime = new PlaywrightRuntime({ loader: async () => fakeBrowser });
    const session = await runtime.start({ taskId: 'task-1' });
    await session.navigate({ url: 'https://example.com/list' });
    // navigate 后 epoch = 2，用 epoch 1 的旧观测引用 → 拒绝。
    const result = await session.act({
      intent: makeIntent({ expectedNavigationEpoch: 1, kind: 'click', targetRef: '[e1]' }),
    });
    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.error).toMatchObject({ kind: 'element', code: 'STALE_EPOCH', retryable: true });
    }
    await session.close();
  });

  it('loader 注入 reject（模拟未安装）→ start() rejects 且 message 含 playwright', async () => {
    const runtime = new PlaywrightRuntime({
      loader: async () => {
        throw new Error('Cannot find module playwright');
      },
    });
    await expect(runtime.start({ taskId: 'task-1' })).rejects.toThrow(/playwright/);
  });

  it('loader 抛出结构化异常时保留 message，而不是退化为 [object Object]', async () => {
    const runtime = new PlaywrightRuntime({
      loader: async () => {
        throw { code: 'BROWSER_BINARY_MISSING', message: 'Chromium executable was not found' };
      },
    });
    await expect(runtime.start({ taskId: 'task-1' })).rejects.toThrow('BROWSER_BINARY_MISSING: Chromium executable was not found');
  });

  it('loader 返回非 playwright 对象 → start() rejects 且报清晰错误', async () => {
    const runtime = new PlaywrightRuntime({ loader: async () => ({ notABrowser: true }) });
    await expect(runtime.start({ taskId: 'task-1' })).rejects.toThrow(/playwright/);
  });

  it('后置条件不满足 → uncertain（逐项检查证据，不盲目重试）', async () => {
    const fakeBrowser = new FakeBrowserImpl(testSite());
    const runtime = new PlaywrightRuntime({ loader: async () => fakeBrowser });
    const session = await runtime.start({ taskId: 'task-1' });
    await session.navigate({ url: 'https://example.com/list' });
    await session.observe();

    const result = await session.act({
      intent: makeIntent({
        expectedNavigationEpoch: 2,
        kind: 'click',
        targetRef: '[e1]',
        postcondition: { kind: 'url_contains', value: 'https://example.com/other' },
      }),
    });

    expect(result.status).toBe('uncertain');
    if (result.status === 'uncertain') {
      expect(result.reason).toBe('后置条件未满足');
      expect(result.evidence.checks).toEqual([
        {
          postcondition: JSON.stringify({ kind: 'url_contains', value: 'https://example.com/other' }),
          passed: false,
        },
      ]);
      // 动作实际发生了（导航到 detail），只是后置条件不满足。
      expect(result.evidence.observed?.url).toBe('https://example.com/detail');
    }
    await session.close();
  });

  it('取消：act 执行中 signal.abort → failed cancelled（fake click 内模拟延迟）', async () => {
    const fakeBrowser = new FakeBrowserImpl(testSite());
    const runtime = new PlaywrightRuntime({ loader: async () => fakeBrowser });
    const session = await runtime.start({ taskId: 'task-1' });
    await session.navigate({ url: 'https://example.com/list' });
    await session.observe();

    const page = fakeBrowser.contexts[0].pages[0];
    page.clickDelayMs = 80; // click 执行中模拟耗时

    const controller = new AbortController();
    const actPromise = session.act({
      intent: makeIntent({
        expectedNavigationEpoch: 2,
        kind: 'click',
        targetRef: '[e1]',
        postcondition: { kind: 'url_contains', value: 'example.com/detail' },
      }),
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 20);

    const result = await actPromise;
    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.error).toMatchObject({ kind: 'cancelled', code: 'ABORTED', retryable: false });
    }
    await session.close();
  });

  it('close 幂等：重复 close 不抛、底层只关闭一次', async () => {
    const fakeBrowser = new FakeBrowserImpl(testSite());
    const runtime = new PlaywrightRuntime({ loader: async () => fakeBrowser });
    const session = await runtime.start({ taskId: 'task-1' });

    await session.close();
    await session.close();
    expect(fakeBrowser.closeCalls).toBe(1);
    expect(fakeBrowser.contexts[0].closeCalls).toBe(1);
    // 关闭后 observe 拒绝。
    await expect(session.observe()).rejects.toThrow(/closed/);
  });
});
