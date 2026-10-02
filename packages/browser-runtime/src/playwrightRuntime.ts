// Playwright 浏览器运行时：桌面端 Node Sidecar 的实际浏览器宿主（架构文档 5.1/8/9）。
// — English: Playwright browser runtime — the real browser host for the desktop
//   Node sidecar (architecture docs §5.1/8/9).
// 设计要点：
//  1. 依赖隔离：playwright 包可能未安装，故通过「动态 import（变量形式）+ 可注入 loader」
//     隔离——tsc -b 不解析模块，vitest 注入 fake；loader 失败时 start() 拒绝并提示安装命令。
//  2. 鸭子类型：不 import 'playwright' 类型，运行时用最小本地接口（BrowserLike/PageLike/
//     LocatorLike…）从 unknown 窄化，窄化失败抛清晰错误。
//  3. 执行不等于成功：任何动作执行后必须验证后置条件并留下证据，
//     结果三态 committed（已验证）/ uncertain（副作用不明，禁止盲目重试）/ failed。
// — English: design notes — dynamic import (via a variable) + injectable loader
//   isolate the playwright dependency; duck-typed narrowing against minimal local
//   interfaces; every action verifies its postcondition (committed / uncertain / failed).
import type {
  ActionResult,
  BrowserSessionHandle,
  BrowserRuntimePort,
  PostconditionCheck,
} from './port.js';
import type {
  ActionIntent,
  ClassifiedError,
  ContentBlock,
  FormInfo,
  Observation,
  PageGraph,
  Postcondition,
} from '@suanlizi/protocol';

// ─── 可注入的 playwright 模块标识 ────────────────────────────────────────────
// 用变量而非字面量做动态 import：TS 对非字面量 import() 不做模块解析，
// 因此 playwright 未安装时 tsc -b 依然通过。
// — English: dynamic import via a variable bypasses TS module resolution, so
//   tsc -b passes even when playwright is not installed.
const PLAYWRIGHT_MODULE_ID = 'playwright';

export interface PlaywrightRuntimeOptions {
  // 可注入的 playwright 模块加载器：默认 () => import('playwright')；测试注入 fake。
  // — English: injectable playwright module loader; tests inject a fake.
  loader?: () => Promise<unknown>;
  headless?: boolean; // 默认 false（桌面端可见窗口）
  defaultTimeoutMs?: number; // 默认 30000
}

// ─── 鸭子类型最小接口（不依赖 playwright 类型） ─────────────────────────────
// — English: minimal duck-typed interfaces (no playwright type dependency).
interface BrowserLike {
  launch(options: { headless: boolean }): Promise<BrowserLikeInstance>;
}
interface BrowserLikeInstance {
  newContext(options?: Record<string, unknown>): Promise<ContextLike>;
  close(): Promise<void>;
}
interface ContextLike {
  newPage(): Promise<PageLike>;
  close(): Promise<void>;
}
interface PageLike {
  goto(url: string, options?: { timeout?: number }): Promise<{ url(): string }>;
  url(): string;
  title(): Promise<string>;
  evaluate(fn: unknown): Promise<unknown>;
  screenshot(options?: Record<string, unknown>): Promise<Uint8Array>;
  locator(selector: string): LocatorLike;
  close(): Promise<void>;
}
interface LocatorLike {
  count(): Promise<number>;
  nth(index: number): LocatorLike;
  click(options?: Record<string, unknown>): Promise<void>;
  fill(value: string): Promise<void>;
  selectOption(value: unknown): Promise<void>;
  press(key: string): Promise<void>;
  isVisible(): Promise<boolean>;
  isEnabled(): Promise<boolean>;
  textContent(): Promise<string | null>;
}

// 从 unknown 窄化到 BrowserLike；失败抛清晰错误。
// — English: narrows unknown to BrowserLike; throws a clear error on failure.
function narrowBrowser(mod: unknown): BrowserLike {
  if (mod === null || typeof mod !== 'object') {
    throw new Error('playwright 模块加载失败：加载结果不是对象（loader 未返回 playwright 模块）');
  }
  const candidate = mod as { launch?: unknown };
  if (typeof candidate.launch !== 'function') {
    throw new Error('playwright 模块加载失败：缺少 launch() 方法');
  }
  return mod as BrowserLike;
}

// ─── 页面快照提取脚本 ────────────────────────────────────────────────────────
// 在页面上下文执行（字符串脚本，自包含、无外部引用），返回可序列化数据而非 DOM 句柄：
//  elements：a[href]/button/input/select/textarea/[role=button/link] 的可交互元素快照；
//  content：h1-h3/p/li/a 文本块；forms：表单信息。
// 注意：tsconfig 无 DOM lib，脚本必须以字符串形式存在，且内部不用反引号/${}。
// — English: snapshot extraction script executed inside the page context; returns
//   serializable data (never DOM handles). Shared with ElectronWebContentsRuntime.
export const SNAPSHOT_SCRIPT = `(() => {
  const out = { elements: [], content: [], forms: [] };
  const seen = new Set();
  const selectors = ['a[href]', 'button', 'input', 'select', 'textarea', '[role="button"]', '[role="link"]'];
  let idx = 0;
  for (const sel of selectors) {
    for (const el of document.querySelectorAll(sel)) {
      if (seen.has(el)) continue;
      seen.add(el);
      idx += 1;
      const tag = el.tagName.toLowerCase();
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      const visible = rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
      let role = el.getAttribute('role');
      if (!role) {
        if (tag === 'a') role = 'link';
        else if (tag === 'button') role = 'button';
        else if (tag === 'input') role = el.type === 'submit' || el.type === 'button' ? 'button' : 'textbox';
        else if (tag === 'select') role = 'combobox';
        else if (tag === 'textarea') role = 'textbox';
      }
      let name = el.getAttribute('aria-label') || el.getAttribute('title') || '';
      if (!name) {
        const labelledBy = el.getAttribute('aria-labelledby');
        if (labelledBy) {
          const labelEl = document.getElementById(labelledBy);
          if (labelEl) name = (labelEl.textContent || '').trim();
        }
      }
      if (!name) name = (el.textContent || '').trim().slice(0, 100);
      const text = (el.textContent || '').trim().slice(0, 200);
      out.elements.push({
        index: idx,
        tag: tag,
        role: role || undefined,
        name: name || undefined,
        text: text || undefined,
        href: tag === 'a' ? el.getAttribute('href') || undefined : undefined,
        visible: visible,
        enabled: !el.disabled,
      });
    }
  }
  for (const el of document.querySelectorAll('h1, h2, h3, p, li, a')) {
    const tag = el.tagName.toLowerCase();
    const text = (el.textContent || '').trim().slice(0, 200);
    if (!text) continue;
    const type = tag === 'h1' || tag === 'h2' || tag === 'h3' ? 'heading' : tag === 'p' ? 'paragraph' : tag === 'li' ? 'list' : 'link';
    const block = { type: type, text: text };
    if (tag === 'a') {
      const href = el.getAttribute('href');
      if (href) block.href = href;
    }
    out.content.push(block);
  }
  let formIdx = 0;
  for (const el of document.querySelectorAll('form')) {
    formIdx += 1;
    const fields = [];
    for (const f of el.querySelectorAll('input, select, textarea')) {
      const fname = f.getAttribute('name') || f.getAttribute('id') || '';
      if (!fname) continue;
      fields.push({
        name: fname,
        fieldType: f.tagName.toLowerCase() === 'input' ? f.getAttribute('type') || 'text' : f.tagName.toLowerCase(),
        required: f.hasAttribute('required'),
      });
    }
    out.forms.push({
      formId: el.getAttribute('id') || el.getAttribute('name') || 'form-' + formIdx,
      action: el.getAttribute('action') || undefined,
      method: (el.getAttribute('method') || 'get').toLowerCase() === 'post' ? 'post' : 'get',
      fields: fields,
    });
  }
  return out;
})()`;

// 快照的宽松结构（evaluate 返回的是未知数据，逐字段窄化）。
// — English: loose snapshot shape — evaluate returns unknown, narrowed field by field.
interface RawElement {
  index?: number;
  tag?: string;
  role?: string;
  name?: string;
  text?: string;
  href?: string;
  visible?: boolean;
  enabled?: boolean;
}
interface RawSnapshot {
  elements?: RawElement[];
  content?: Array<{ type?: string; text?: string; href?: string }>;
  forms?: Array<{
    formId?: string;
    action?: string;
    method?: string;
    fields?: Array<{ name?: string; fieldType?: string; required?: boolean }>;
  }>;
}

// 元素引用信息：观测时 [eN] → 元素定位信息（会话内 Map）。
// — English: element ref info — [eN] → element locator info kept per session.
interface ElementRefInfo {
  pageId: string;
  index: number; // [eN] 中的 N（可见顺序）
  tag: string;
  name?: string;
}

// 取消哨兵：等待点检查 signal 后抛出，由 act/navigate 转为 cancelled 结果。
// — English: abort sentinel thrown at await points; act/navigate map it to cancelled.
class AbortError extends Error {
  constructor() {
    super('任务已取消');
    this.name = 'AbortError';
  }
}

function actionError(actionId: string, error: Omit<ClassifiedError, 'actionId'>): ClassifiedError {
  return { ...error, actionId };
}

function roleForTag(tag: string): string {
  switch (tag) {
    case 'a':
      return 'link';
    case 'button':
      return 'button';
    case 'input':
      return 'textbox';
    case 'select':
      return 'combobox';
    case 'textarea':
      return 'textbox';
    default:
      return tag;
  }
}

// 转义 :has-text("...") 内的引号与反斜杠。
// — English: escapes quotes and backslashes inside :has-text("...").
function escapeCssText(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function safeOrigin(url: string): string | undefined {
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'object' && err !== null) {
    const value = err as Record<string, unknown>;
    const message = typeof value.message === 'string' ? value.message : undefined;
    const code = typeof value.code === 'string' ? value.code : undefined;
    if (message && code) return `${code}: ${message}`;
    if (message) return message;
    if (code) return code;
    try {
      return JSON.stringify(value);
    } catch {
      return 'unknown browser runtime error';
    }
  }
  return String(err);
}

// ─── 会话句柄 ────────────────────────────────────────────────────────────────
// 单任务独占的 Playwright 会话：launch → newContext → newPage → goto('about:blank')。
// — English: per-task Playwright session handle.
class PlaywrightSessionHandle implements BrowserSessionHandle {
  readonly sessionId: string;
  readonly taskId: string;

  private readonly browser: BrowserLikeInstance;
  private readonly context: ContextLike;
  private readonly page: PageLike;
  private readonly defaultTimeoutMs: number;

  private navigationEpoch = 1;
  private observeCount = 0;
  private refMap = new Map<string, ElementRefInfo>();
  private cachedUrl: string;
  private cachedTitle: string;
  private closed = false;

  constructor(
    taskId: string,
    browser: BrowserLikeInstance,
    context: ContextLike,
    page: PageLike,
    defaultTimeoutMs: number,
    cachedTitle: string,
  ) {
    this.taskId = taskId;
    this.sessionId = `sess-${taskId}`;
    this.browser = browser;
    this.context = context;
    this.page = page;
    this.defaultTimeoutMs = defaultTimeoutMs;
    this.cachedUrl = page.url();
    this.cachedTitle = cachedTitle;
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('session closed');
  }

  private throwIfAborted(signal?: AbortSignal): void {
    if (signal?.aborted) throw new AbortError();
  }

  // 提取页面快照：evaluate 失败抛错（调用方决定转 failed/uncertain）。
  // — English: extracts the page snapshot; throws on evaluate failure.
  private async extractSnapshot(): Promise<RawSnapshot> {
    const raw = await this.page.evaluate(SNAPSHOT_SCRIPT);
    if (raw === null || typeof raw !== 'object') {
      throw new Error('页面快照提取失败：evaluate 返回非对象');
    }
    return raw as RawSnapshot;
  }

  // 同步缓存 url/title（currentPageGraph 是同步接口）。
  // — English: syncs cached url/title — currentPageGraph is synchronous.
  private async syncCache(): Promise<void> {
    this.cachedUrl = this.page.url();
    try {
      this.cachedTitle = await this.page.title();
    } catch {
      this.cachedTitle = '';
    }
  }

  private async captureScreenshotRef(url: string): Promise<string | undefined> {
    if (url === 'about:blank') return undefined;
    const bytes = await this.page.screenshot({
      type: 'jpeg',
      quality: 72,
      fullPage: false,
      animations: 'disabled',
      caret: 'hide',
      scale: 'css',
    });
    if (bytes.byteLength > 2 * 1024 * 1024) {
      throw {
        kind: 'page',
        code: 'SCREENSHOT_TOO_LARGE',
        message: '页面预览超过 2 MB 限制',
        retryable: true,
      } satisfies ClassifiedError;
    }
    return `data:image/jpeg;base64,${Buffer.from(bytes).toString('base64')}`;
  }

  currentPageGraph(): PageGraph {
    this.assertOpen();
    return {
      activePageId: 'page-1',
      pages: [
        {
          pageId: 'page-1',
          url: this.cachedUrl,
          title: this.cachedTitle,
          state: 'active',
          navigationEpoch: this.navigationEpoch,
        },
      ],
    };
  }

  async observe(input?: { signal?: AbortSignal; pageId?: string }): Promise<Observation> {
    this.assertOpen();
    const pageId = input?.pageId ?? 'page-1';
    if (pageId !== 'page-1') {
      throw {
        kind: 'element',
        code: 'PAGE_NOT_FOUND',
        message: '页面不存在',
        retryable: true,
      } satisfies ClassifiedError;
    }
    this.throwIfAborted(input?.signal);

    const snapshot = await this.extractSnapshot();
    const url = this.page.url();
    const title = await this.page.title();
    const screenshotRef = await this.captureScreenshotRef(url);
    this.cachedUrl = url;
    this.cachedTitle = title;

    const origin = safeOrigin(url);
    const epoch = this.navigationEpoch;
    const count = this.observeCount + 1;
    this.observeCount = count;
    const observationId = `obs-${this.taskId}-${epoch}-${count}`;

    // 只保留可见元素，按顺序分配 [e1]..[eN]，重建 ref → 定位信息映射。
    // — English: visible elements only, numbered [e1]..[eN]; rebuilds the ref map.
    const elements: Observation['elements'] = [];
    const refMap = new Map<string, ElementRefInfo>();
    let n = 0;
    for (const el of snapshot.elements ?? []) {
      if (el.visible === false) continue;
      n += 1;
      const ref = `[e${n}]`;
      refMap.set(ref, { pageId, index: n, tag: el.tag ?? 'unknown', name: el.name });
      elements.push({
        ref,
        role: el.role,
        name: el.name,
        text: el.text,
        frameId: 'frame-main',
        visible: true,
        enabled: el.enabled !== false,
        fingerprint: `fp:${n}:${epoch}`,
        provenance: { trust: 'untrusted', source: 'dom', origin, pageId, observationId },
      });
    }
    this.refMap = refMap;

    const contentTypes = new Set<ContentBlock['type']>(['heading', 'paragraph', 'list', 'link', 'table', 'other']);
    const mainContent: ContentBlock[] = [];
    for (const c of snapshot.content ?? []) {
      if (typeof c.text !== 'string') continue;
      const block: ContentBlock = {
        type: c.type !== undefined && contentTypes.has(c.type as ContentBlock['type'])
          ? (c.type as ContentBlock['type'])
          : 'other',
        text: c.text.slice(0, 200),
      };
      if (typeof c.href === 'string') block.href = c.href;
      mainContent.push(block);
    }

    const forms: FormInfo[] = [];
    for (const f of snapshot.forms ?? []) {
      if (typeof f.formId !== 'string') continue;
      const method = f.method === 'post' ? 'post' : f.method === 'get' ? 'get' : undefined;
      const form: FormInfo = {
        formId: f.formId,
        fields: (f.fields ?? [])
          .filter((fd) => typeof fd.name === 'string')
          .map((fd) => ({
            name: fd.name as string,
            ...(fd.fieldType !== undefined && typeof fd.fieldType === 'string' ? { fieldType: fd.fieldType } : {}),
            required: fd.required === true,
          })),
      };
      if (typeof f.action === 'string') form.action = f.action;
      if (method !== undefined) form.method = method;
      forms.push(form);
    }

    return {
      observationId,
      taskId: this.taskId,
      pageId,
      navigationEpoch: epoch,
      capturedAt: Date.now(),
      url,
      title,
      readiness: 'stable',
      ...(screenshotRef !== undefined ? { screenshotRef } : {}),
      elements,
      mainContent,
      forms,
      network: { pendingRequests: 0, recentFailures: [] },
      pageState: { captchaDetected: false, authRequired: false },
    };
  }

  async navigate(input: { url: string; signal?: AbortSignal; pageId?: string }): Promise<Observation> {
    this.assertOpen();
    if (input.pageId !== undefined && input.pageId !== 'page-1') {
      throw {
        kind: 'element',
        code: 'PAGE_NOT_FOUND',
        message: '页面不存在',
        retryable: true,
      } satisfies ClassifiedError;
    }
    this.throwIfAborted(input.signal);
    try {
      await this.page.goto(input.url, { timeout: this.defaultTimeoutMs });
    } catch (err) {
      if (err instanceof AbortError) throw err;
      throw {
        kind: 'page',
        code: 'NAV_FAILED',
        message: errorMessage(err),
        retryable: true,
      } satisfies ClassifiedError;
    }
    this.throwIfAborted(input.signal);
    this.navigationEpoch += 1;
    this.refMap.clear();
    await this.syncCache();
    return this.observe();
  }

  // 解析 [eN] → locator：按 role/name 或 tag:has-text 构造选择器，nth(0)，count()>0 才返回。
  // — English: resolves [eN] to a locator via role/name or tag:has-text selectors.
  private async resolveLocator(info: ElementRefInfo): Promise<LocatorLike | undefined> {
    const selectors: string[] = [];
    if (info.name !== undefined && info.name !== '') {
      const name = escapeCssText(info.name);
      if (info.tag === 'a' || info.tag === 'button') {
        selectors.push(`${info.tag}:has-text("${name}")`);
      } else {
        selectors.push(`[role="${roleForTag(info.tag)}"]:has-text("${name}")`);
      }
    }
    selectors.push(info.tag);
    for (const selector of selectors) {
      const locator = this.page.locator(selector).nth(0);
      try {
        if ((await locator.count()) > 0) return locator;
      } catch {
        // 选择器无效或查询失败：尝试下一个候选。
        // — English: invalid selector or query failure — try the next candidate.
      }
    }
    return undefined;
  }

  // 执行动作主体；异常（含 AbortError）向上抛，由 act 捕获分类。
  // — English: dispatches the action; exceptions bubble up to act for classification.
  private async dispatchAction(
    intent: ActionIntent,
    locator: LocatorLike | undefined,
    signal?: AbortSignal,
  ): Promise<void> {
    switch (intent.kind) {
      case 'click':
        await locator?.click();
        break;
      case 'type':
        await locator?.fill(String(intent.arguments.value ?? ''));
        break;
      case 'select':
        await locator?.selectOption(intent.arguments.value);
        break;
      case 'press':
        await locator?.press(String(intent.arguments.key ?? ''));
        break;
      case 'scroll': {
        const raw = Number(intent.arguments.distance ?? 500);
        const distance = Number.isFinite(raw) ? raw : 500;
        await this.page.evaluate(`window.scrollBy(0, ${distance})`);
        break;
      }
      case 'screenshot':
        // Phase 1 不做落盘：无副作用，screenshotRef 省略。
        // — English: no persistence in Phase 1 — screenshotRef is omitted.
        break;
      case 'wait':
        await this.abortableSleep(500, signal);
        break;
      case 'navigate': {
        const url = String(intent.arguments.url ?? '');
        this.throwIfAborted(signal);
        await this.page.goto(url, { timeout: this.defaultTimeoutMs });
        this.navigationEpoch += 1;
        this.refMap.clear();
        await this.syncCache();
        break;
      }
      default:
        throw new Error(`不支持的动作品类: ${intent.kind}`);
    }
  }

  // 可取消延时（act/navigate 的等待点）。
  // — English: cancellable sleep used at act/navigate wait points.
  private abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (signal?.aborted) {
        reject(new AbortError());
        return;
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      const onAbort = (): void => {
        if (timer !== undefined) clearTimeout(timer);
        reject(new AbortError());
      };
      timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  // 按当前可见顺序反查 [eN]（动作后的真实页面状态）。
  // — English: resolves [eN] against the current visible order (real page state).
  private async findElementByRef(ref: string): Promise<RawElement | undefined> {
    const match = /^\[e(\d+)\]$/.exec(ref);
    if (match === null) return undefined;
    const snapshot = await this.extractSnapshot();
    const visible = (snapshot.elements ?? []).filter((el) => el.visible !== false);
    return visible[Number(match[1]) - 1];
  }

  // 后置条件求值（基于 page.url()/title 与重新提取的真实页面状态）。
  // download_completed 在本运行时无法证明，恒不通过。
  // — English: postcondition evaluation against the real page state.
  private async evaluatePostconditions(post: Postcondition, beforeEpoch: number): Promise<PostconditionCheck[]> {
    const check = (passed: boolean, detail?: string): PostconditionCheck => ({
      postcondition: JSON.stringify(post),
      passed,
      ...(detail !== undefined ? { detail } : {}),
    });
    switch (post.kind) {
      case 'none':
        return [check(true)];
      case 'url_contains':
        return [check(this.page.url().includes(post.value))];
      case 'url_equals':
        return [check(this.page.url() === post.value)];
      case 'navigation_epoch_changed':
        return [check(this.navigationEpoch !== beforeEpoch)];
      case 'element_appears': {
        const el = await this.findElementByRef(post.ref);
        return [check(el !== undefined)];
      }
      case 'element_disappears': {
        const el = await this.findElementByRef(post.ref);
        return [check(el === undefined)];
      }
      case 'element_text_contains': {
        const el = await this.findElementByRef(post.ref);
        return [
          check(
            el !== undefined && el.text !== undefined && el.text.includes(post.value),
            el === undefined ? '元素不存在或不可见' : undefined,
          ),
        ];
      }
      case 'download_completed':
        return [check(false, 'Playwright 运行时无法证明下载完成')];
      default:
        return [check(false, `未知后置条件: ${(post as { kind: string }).kind}`)];
    }
  }

  async act(input: { intent: ActionIntent; signal?: AbortSignal }): Promise<ActionResult> {
    this.assertOpen();
    const { intent, signal } = input;
    const actionId = intent.actionId;
    const failed = (error: Omit<ClassifiedError, 'actionId'>): ActionResult => ({
      status: 'failed',
      error: actionError(actionId, error),
    });

    // 1. 已取消：直接失败。
    if (signal?.aborted) {
      return failed({ kind: 'cancelled', code: 'ABORTED', message: '任务已取消', retryable: false });
    }
    // 2. 页面与 epoch 校验：旧观测引用拒绝。
    if (intent.pageId !== 'page-1') {
      return failed({ kind: 'element', code: 'PAGE_NOT_FOUND', message: '页面不存在', retryable: true });
    }
    if (intent.expectedNavigationEpoch !== this.navigationEpoch) {
      return failed({ kind: 'element', code: 'STALE_EPOCH', message: '观测已过期，请重新观测', retryable: true });
    }

    const beforeEpoch = this.navigationEpoch;

    try {
      // 3. 元素解析与状态校验（targetRef 存在时）。
      let locator: LocatorLike | undefined;
      if (intent.targetRef !== undefined) {
        const info = this.refMap.get(intent.targetRef);
        if (info === undefined) {
          return failed({ kind: 'element', code: 'ELEMENT_NOT_FOUND', message: '元素不存在或已过期，请重新观测', retryable: true });
        }
        this.throwIfAborted(signal);
        locator = await this.resolveLocator(info);
        if (locator === undefined) {
          return failed({ kind: 'element', code: 'ELEMENT_NOT_FOUND', message: '元素不存在', retryable: true });
        }
        if (!(await locator.isVisible())) {
          return failed({ kind: 'element', code: 'ELEMENT_NOT_VISIBLE', message: '元素不可见', retryable: true });
        }
        const interactive =
          intent.kind === 'click' || intent.kind === 'type' || intent.kind === 'select' || intent.kind === 'press';
        if (interactive && !(await locator.isEnabled())) {
          return failed({ kind: 'element', code: 'ELEMENT_DISABLED', message: '元素已禁用', retryable: true });
        }
        this.throwIfAborted(signal);
      }

      // 4. 执行动作主体。
      const beforeUrl = this.page.url();
      await this.dispatchAction(intent, locator, signal);

      // 5. URL 变化视为导航：epoch++ 并作废旧引用（与 fake 的 click 链接导航语义一致）。
      // 注意：kind:'navigate' 已在 dispatchAction 内递增 epoch，这里排除以免双重递增。
      // — English: a URL change counts as navigation — bump epoch and invalidate refs.
      //   Note: kind:'navigate' already bumped the epoch inside dispatchAction.
      if (intent.kind !== 'navigate' && this.page.url() !== beforeUrl) {
        this.navigationEpoch += 1;
        this.refMap.clear();
      }
      this.throwIfAborted(signal);

      // 6. 验证后置条件（基于动作后的真实页面状态）；不盲目重试。
      const checks = await this.evaluatePostconditions(intent.postcondition, beforeEpoch);
      const allPassed = checks.every((c) => c.passed);
      const observed = { url: this.page.url(), title: await this.page.title(), navigationEpoch: this.navigationEpoch };
      if (allPassed) {
        return {
          status: 'committed',
          evidence: {
            actionId,
            verifiedAt: Date.now(),
            observed,
            checks: [{ postcondition: JSON.stringify(intent.postcondition), passed: true }],
          },
        };
      }
      return {
        status: 'uncertain',
        reason: '后置条件未满足',
        evidence: { actionId, verifiedAt: Date.now(), observed, checks },
      };
    } catch (err) {
      if (err instanceof AbortError || signal?.aborted) {
        return failed({ kind: 'cancelled', code: 'ABORTED', message: '任务已取消', retryable: false });
      }
      // goto 相关异常归为 page，其余为 element。
      // — English: goto-related failures classify as page, others as element.
      return failed({
        kind: intent.kind === 'navigate' ? 'page' : 'element',
        code: 'ACTION_FAILED',
        message: errorMessage(err),
        retryable: true,
      });
    }
  }

  async close(_reason?: string): Promise<void> {
    if (this.closed) return; // 幂等：重复 close 直接返回
    this.closed = true;
    // 关闭失败不阻止后续清理，也不向上抛（幂等且健壮）。
    // — English: close errors are swallowed — close is idempotent and robust.
    for (const closer of [() => this.page.close(), () => this.context.close(), () => this.browser.close()]) {
      try {
        await closer();
      } catch {
        // ignore
      }
    }
  }
}

// ─── 运行时入口 ──────────────────────────────────────────────────────────────
// — English: runtime entry point.
export class PlaywrightRuntime implements BrowserRuntimePort {
  readonly kind: 'playwright' = 'playwright' as const;
  private readonly loader: () => Promise<unknown>;
  private readonly headless: boolean;
  private readonly defaultTimeoutMs: number;

  constructor(options: PlaywrightRuntimeOptions = {}) {
    // playwright 包的顶层导出没有 launch()——chromium 命名空间才有（chromium.launch）。
    // 默认 loader 取 chromium 命名空间；测试仍可注入任意 fake。
    // — English: the playwright package's top-level exports have no launch() —
    //   only the chromium namespace does (chromium.launch). The default loader
    //   resolves the chromium namespace; tests may inject any fake.
    this.loader = options.loader ?? (async () => {
      const pw = (await import(PLAYWRIGHT_MODULE_ID)) as { chromium?: unknown };
      return pw.chromium ?? pw;
    });
    this.headless = options.headless ?? false;
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 30000;
  }

  async start(input: { taskId: string; signal?: AbortSignal }): Promise<BrowserSessionHandle> {
    if (input.signal?.aborted) throw new Error('任务已取消');
    let mod: unknown;
    try {
      mod = await this.loader();
    } catch (err) {
      // 保留原始失败原因；缺依赖只是其中一种可能，不能把二进制、权限或加载错误误报为未安装。
      // — English: retain the original cause. A missing dependency is only one possible
      // failure; binary, permission, and loader failures must not be misreported.
      throw new Error(`playwright 加载失败：${errorMessage(err)}。如尚未安装，请管理员执行 npm install playwright 并运行 npx playwright install chromium`);
    }
    const browser = narrowBrowser(mod);
    if (input.signal?.aborted) throw new Error('任务已取消');

    let launched: BrowserLikeInstance;
    let context: ContextLike;
    let page: PageLike;
    try {
      launched = await browser.launch({ headless: this.headless });
      context = await launched.newContext();
      page = await context.newPage();
      await page.goto('about:blank', { timeout: this.defaultTimeoutMs });
    } catch (err) {
      throw new Error(`浏览器启动失败: ${errorMessage(err)}`);
    }
    let cachedTitle = '';
    try {
      cachedTitle = await page.title();
    } catch {
      cachedTitle = '';
    }
    return new PlaywrightSessionHandle(input.taskId, launched, context, page, this.defaultTimeoutMs, cachedTitle);
  }
}
