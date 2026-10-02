// 内存 Fake Browser Runtime：基于站点定义的确定性浏览器仿真，用于测试与开发。
// — English: in-memory fake browser runtime — a deterministic browser simulation
//   driven by site definitions, used for tests and development.
// 核心原则：执行不等于成功——任何动作执行后必须验证后置条件并留下证据，
// 结果三态：committed（已验证）/ uncertain（副作用不明，禁止盲目重试）/ failed。
// — English: execution is not success — every action must verify its postcondition
//   and leave evidence: committed / uncertain (no blind retries) / failed.
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

// ─── 站点定义 ────────────────────────────────────────────────────────────────
// 元素定义：ref 为稳定标识（如 'link-result-1'），观测时映射为 [eN]。
// — English: element definitions — ref is a stable id mapped to [eN] on observation.
export interface FakeElementDefinition {
  ref: string;
  role?: string;
  name?: string;
  text?: string;
  href?: string; // link 目标；无 onAction 时 click 链接默认导航到 href
  visible?: boolean; // 默认 true
  enabled?: boolean; // 默认 true
}

export type FakeEffectKind =
  | 'navigate'
  | 'text_change'
  | 'add_element'
  | 'remove_element'
  | 'delay'
  | 'download'
  | 'none';

export interface FakeEffect {
  kind: FakeEffectKind;
  url?: string; // navigate 目标 URL（必须存在于 site.pages）/ download 来源 URL
  elementRef?: string; // text_change / remove_element 目标（稳定 ref）
  text?: string;
  element?: FakeElementDefinition; // add_element
  delayMs?: number; // delay
  suggestedName?: string; // download 建议文件名（默认 'download.bin'）
  mimeType?: string; // download 响应 MIME（可选透传）
  sizeBytes?: number; // download 响应大小（可选透传）
}

// 下载记录：每次 download 效果追加一条元数据到会话账本；页面状态不受影响。
// — English: download record — appended per download effect; page state is untouched.
export interface FakeDownloadRecord {
  url: string;
  suggestedName: string;
  mimeType?: string;
  sizeBytes?: number;
  at: number;
}

export interface FakePageDefinition {
  url: string;
  title: string;
  elements?: FakeElementDefinition[];
  content?: ContentBlock[];
  forms?: FormInfo[];
  captchaDetected?: boolean; // 默认 false
  authRequired?: boolean; // 默认 false
  // 动作副作用回调：返回单个或一组效果；返回 undefined 时按默认规则（click 链接 → navigate）。
  // — English: side-effect callback; returns effects, or undefined for default behavior.
  onAction?: (
    action: { kind: string; targetRef?: string; value?: unknown },
    page: { url: string; title: string; elements: FakeElementDefinition[] },
  ) => FakeEffect | FakeEffect[] | void;
}

export interface FakeSiteDefinition {
  startUrl: string;
  pages: FakePageDefinition[];
  defaultDelayMs?: number; // 每次动作的模拟耗时，默认 2ms
}

// ─── 可取消延时 ──────────────────────────────────────────────────────────────
// signal 已中止或中止发生时 reject(new Error('aborted'))。
// — English: cancellable delay — rejects with Error('aborted') when aborted.
export function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal !== undefined && signal.aborted) {
      reject(new Error('aborted'));
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      reject(new Error('aborted'));
    };
    timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

// ─── 运行时页面状态 ───────────────────────────────────────────────────────────
// 每个 pageId 一份：url/title/元素（含运行时增删）/内容/表单/标志/导航纪元。
// — English: per-page runtime state with its own navigation epoch.
interface FakePageState {
  url: string;
  title: string;
  elements: FakeElementDefinition[];
  content: ContentBlock[];
  forms: FormInfo[];
  captchaDetected: boolean;
  authRequired: boolean;
  navigationEpoch: number;
}

// 动作错误统一构造：带 actionId 的 ClassifiedError。
// — English: builds a ClassifiedError carrying the actionId.
function actionError(
  actionId: string,
  error: Omit<ClassifiedError, 'actionId'>,
): ClassifiedError {
  return { ...error, actionId };
}

// 单任务独占的 fake 会话句柄。
// — English: per-task fake session handle.
export class FakeSessionHandle implements BrowserSessionHandle {
  readonly sessionId: string;
  readonly taskId: string;

  private readonly site: FakeSiteDefinition;
  private readonly pages = new Map<string, FakePageState>();
  private activePageId: string;
  private closed = false;
  // 每次 observe 后重建：[eN] → 稳定 ref（按页面分别保存）。
  // — English: rebuilt on each observe — maps [eN] to the stable ref, per page.
  private readonly refMaps = new Map<string, Map<string, string>>();
  private readonly observeCounts = new Map<string, number>();
  // 本次会话的下载账本：applyEffect 的 download 效果逐条追加（页面不变）。
  // — English: session download ledger — appended by the download effect.
  private readonly downloads: FakeDownloadRecord[] = [];

  constructor(site: FakeSiteDefinition, taskId: string) {
    this.site = site;
    this.taskId = taskId;
    this.sessionId = `sess-${taskId}`;
    const startDef = site.pages.find((p) => p.url === site.startUrl);
    if (startDef === undefined) {
      throw new Error(`startUrl 不在 site.pages 中: ${site.startUrl}`);
    }
    this.pages.set('page-1', this.clonePage(startDef));
    this.activePageId = 'page-1';
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('session closed');
  }

  private get defaultDelayMs(): number {
    return this.site.defaultDelayMs ?? 2;
  }

  // 深拷贝页面定义（克隆元素/内容/表单数组，避免共享引用）。
  // — English: deep-ish copy of a page definition (clones element/content/form arrays).
  private clonePage(def: FakePageDefinition): FakePageState {
    return {
      url: def.url,
      title: def.title,
      elements: (def.elements ?? []).map((e) => ({ ...e })),
      content: (def.content ?? []).map((c) => ({ ...c })),
      forms: (def.forms ?? []).map((f) => ({ ...f, fields: f.fields.map((fd) => ({ ...fd })) })),
      captchaDetected: def.captchaDetected ?? false,
      authRequired: def.authRequired ?? false,
      navigationEpoch: 1,
    };
  }

  // 解析动作元素引用：只认观测时分配的 [eN] 映射（先查映射，缺失时按当前可见顺序重算）。
  // 不允许直接引用观测中未出现的稳定 ref——动作只能引用经过校验的观测结果。
  // — English: resolves an action element ref — only observation-assigned [eN] entries
  //   are accepted (map first, then recompute); unobserved stable refs are rejected.
  private resolveRef(pageId: string, ref: string): string | undefined {
    const mapped = this.refMaps.get(pageId)?.get(ref);
    if (mapped !== undefined) return mapped;
    const page = this.pages.get(pageId);
    if (page === undefined) return undefined;
    let n = 0;
    for (const el of page.elements) {
      if (el.visible === false) continue;
      n += 1;
      if (`[e${n}]` === ref) return el.ref;
    }
    return undefined;
  }

  // 按 ref 查找元素（供后置条件使用）：只按当前可见顺序反查 [eN]，稳定 ref 一律不匹配。
  // 隐藏元素不在观测/验证范围内——后置条件只能基于可见页面状态求值。
  // — English: finds an element by ref for postcondition checks — [eN] by visible order only;
  //   hidden elements never match (postconditions evaluate against the visible page).
  private findByRef(page: FakePageState, ref: string): FakeElementDefinition | undefined {
    let n = 0;
    for (const el of page.elements) {
      if (el.visible === false) continue;
      n += 1;
      if (`[e${n}]` === ref) return el;
    }
    return undefined;
  }

  // 重建 [eN] → 稳定 ref 映射（只包含可见元素，按定义顺序编号）。
  // — English: rebuilds the [eN] → stable ref map (visible elements only, in order).
  private rebuildRefMap(pageId: string): void {
    const page = this.pages.get(pageId);
    if (page === undefined) return;
    const map = new Map<string, string>();
    let n = 0;
    for (const el of page.elements) {
      if (el.visible === false) continue;
      n += 1;
      map.set(`[e${n}]`, el.ref);
    }
    this.refMaps.set(pageId, map);
  }

  // 本次会话的下载记录只读快照（与页面状态无关）。
  // — English: read-only snapshot of the session's download records.
  readDownloads(): FakeDownloadRecord[] {
    this.assertOpen();
    return this.downloads.map((d) => ({ ...d }));
  }

  currentPageGraph(): PageGraph {
    this.assertOpen();
    const nodes = [...this.pages.entries()].map(([pageId, p]) => ({
      pageId,
      url: p.url,
      title: p.title,
      state: (pageId === this.activePageId ? 'active' : 'background') as 'active' | 'background',
      navigationEpoch: p.navigationEpoch,
    }));
    return { activePageId: this.activePageId, pages: nodes };
  }

  async observe(input?: { signal?: AbortSignal; pageId?: string }): Promise<Observation> {
    this.assertOpen();
    const pageId = input?.pageId ?? this.activePageId;
    const page = this.pages.get(pageId);
    if (page === undefined) {
      throw {
        kind: 'element',
        code: 'PAGE_NOT_FOUND',
        message: '页面不存在',
        retryable: true,
      } satisfies ClassifiedError;
    }
    this.rebuildRefMap(pageId);
    const count = (this.observeCounts.get(pageId) ?? 0) + 1;
    this.observeCounts.set(pageId, count);
    const observationId = `obs-${this.taskId}-${page.navigationEpoch}-${count}`;
    const origin = new URL(page.url).origin;

    const elements: Observation['elements'] = [];
    let n = 0;
    for (const el of page.elements) {
      if (el.visible === false) continue;
      n += 1;
      const ref = `[e${n}]`;
      elements.push({
        ref,
        role: el.role,
        name: el.name,
        text: el.text,
        frameId: 'frame-main',
        visible: true,
        enabled: el.enabled ?? true,
        fingerprint: `fp:${el.ref}:${page.navigationEpoch}`,
        provenance: {
          trust: 'untrusted',
          source: 'dom',
          origin,
          pageId,
          observationId,
        },
      });
    }

    return {
      observationId,
      taskId: this.taskId,
      pageId,
      navigationEpoch: page.navigationEpoch,
      capturedAt: Date.now(),
      url: page.url,
      title: page.title,
      readiness: 'stable',
      elements,
      mainContent: page.content,
      forms: page.forms,
      network: { pendingRequests: 0, recentFailures: [] },
      pageState: { captchaDetected: page.captchaDetected, authRequired: page.authRequired },
    };
  }

  async navigate(input: { url: string; signal?: AbortSignal; pageId?: string }): Promise<Observation> {
    this.assertOpen();
    await abortableDelay(this.defaultDelayMs, input.signal);
    const pageId = input.pageId ?? this.activePageId;
    if (!this.pages.has(pageId)) {
      throw {
        kind: 'element',
        code: 'PAGE_NOT_FOUND',
        message: '页面不存在',
        retryable: true,
      } satisfies ClassifiedError;
    }
    if (!this.site.pages.some((p) => p.url === input.url)) {
      throw {
        kind: 'page',
        code: 'PAGE_NOT_FOUND',
        message: `目标页面不存在: ${input.url}`,
        retryable: true,
      } satisfies ClassifiedError;
    }
    this.activePageId = pageId;
    this.applyNavigate(pageId, input.url);
    return this.observe({ pageId });
  }

  // navigate 效果：目标 def 存在时在当前页面更新 url/title/元素/内容并 epoch++；
  // 旧 [eN] 映射作废。目标 def 不存在时静默跳过（由后置条件暴露）。
  // — English: navigate effect — updates the current page in place and bumps the epoch.
  private applyNavigate(pageId: string, url: string): void {
    const page = this.pages.get(pageId);
    if (page === undefined) return;
    const def = this.site.pages.find((p) => p.url === url);
    if (def === undefined) return;
    const clone = this.clonePage(def);
    page.url = clone.url;
    page.title = clone.title;
    page.elements = clone.elements;
    page.content = clone.content;
    page.forms = clone.forms;
    page.captchaDetected = clone.captchaDetected;
    page.authRequired = clone.authRequired;
    page.navigationEpoch += 1;
    this.refMaps.delete(pageId);
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
      return failed({
        kind: 'cancelled',
        code: 'ABORTED',
        message: '任务已取消',
        retryable: false,
      });
    }

    // 目标页面：intent.pageId 优先，回退到 activePage。
    // — English: target page — intent.pageId first, fall back to the active page.
    const pageId = this.pages.has(intent.pageId) ? intent.pageId : this.activePageId;
    const page = this.pages.get(pageId);
    if (page === undefined) {
      return failed({ kind: 'element', code: 'PAGE_NOT_FOUND', message: '页面不存在', retryable: true });
    }

    // 2. epoch 校验：旧观测引用拒绝。
    if (intent.expectedNavigationEpoch !== page.navigationEpoch) {
      return failed({
        kind: 'element',
        code: 'STALE_EPOCH',
        message: '观测已过期，请重新观测',
        retryable: true,
      });
    }

    // 3. 元素解析与状态校验。
    let targetStableRef: string | undefined;
    let targetElement: FakeElementDefinition | undefined;
    if (intent.targetRef !== undefined) {
      targetStableRef = this.resolveRef(pageId, intent.targetRef);
      if (targetStableRef === undefined) {
        return failed({ kind: 'element', code: 'ELEMENT_NOT_FOUND', message: '元素不存在', retryable: true });
      }
      targetElement = page.elements.find((e) => e.ref === targetStableRef);
      if (targetElement === undefined) {
        return failed({ kind: 'element', code: 'ELEMENT_NOT_FOUND', message: '元素不存在', retryable: true });
      }
      if (targetElement.visible === false) {
        return failed({ kind: 'element', code: 'ELEMENT_NOT_VISIBLE', message: '元素不可见', retryable: true });
      }
      if (
        targetElement.enabled === false &&
        (intent.kind === 'click' ||
          intent.kind === 'type' ||
          intent.kind === 'select' ||
          intent.kind === 'press' ||
          intent.kind === 'submit')
      ) {
        return failed({ kind: 'element', code: 'ELEMENT_DISABLED', message: '元素已禁用', retryable: true });
      }
    }

    const beforeEpoch = page.navigationEpoch;

    // 4. 模拟执行耗时（可取消）。
    try {
      await abortableDelay(this.defaultDelayMs, signal);
    } catch (err) {
      if (signal?.aborted) {
        return failed({ kind: 'cancelled', code: 'ABORTED', message: '任务已取消', retryable: false });
      }
      throw err;
    }

    // 5. 应用副作用：onAction 回调（或 click 链接默认导航）。
    const def = this.site.pages.find((p) => p.url === page.url);
    let effects: FakeEffect[] = [];
    const onActionResult = def?.onAction?.({
      kind: intent.kind,
      targetRef: targetStableRef,
      value: intent.arguments,
    }, { url: page.url, title: page.title, elements: page.elements });
    if (onActionResult !== undefined) {
      effects = Array.isArray(onActionResult) ? onActionResult : [onActionResult];
    } else if (intent.kind === 'click' && targetElement?.href !== undefined) {
      // 无 onAction（或返回 void）：click 链接默认导航。
      effects = [{ kind: 'navigate', url: targetElement.href }];
    } else if (intent.kind === 'download' && typeof intent.arguments.url === 'string') {
      // 无 onAction：download 动作默认构造下载效果——仅记录元数据，页面不变
      // （架构文档 11.2 下载管理在 fake 上的可执行验证）。
      // — English: without onAction a download action records download metadata
      //   (page untouched) — architecture §11.2 executable on the fake.
      effects = [
        {
          kind: 'download',
          url: intent.arguments.url,
          suggestedName:
            typeof intent.arguments.suggestedName === 'string' ? intent.arguments.suggestedName : 'download.bin',
          ...(typeof intent.arguments.mimeType === 'string' ? { mimeType: intent.arguments.mimeType } : {}),
          ...(typeof intent.arguments.sizeBytes === 'number' ? { sizeBytes: intent.arguments.sizeBytes } : {}),
        },
      ];
    } else if (intent.kind === 'navigate' && typeof intent.arguments.url === 'string') {
      // 无 onAction：navigate 动作默认按目标 URL 导航（与真实浏览器语义一致）。
      // — English: without onAction a navigate action defaults to navigating by URL.
      effects = [{ kind: 'navigate', url: intent.arguments.url }];
    }

    try {
      for (const effect of effects) {
        await this.applyEffect(pageId, page, effect, signal);
      }
    } catch (err) {
      if (signal?.aborted) {
        return failed({ kind: 'cancelled', code: 'ABORTED', message: '任务已取消', retryable: false });
      }
      throw err;
    }

    // 6. 验证后置条件（基于动作后的页面状态）；download_completed 的依据是
    // 本次动作是否产生了下载记录（hasDownload）。
    // — English: verify postconditions (against the page after the action);
    //   download_completed is judged by whether this action produced a download.
    const hasDownload = effects.some((e) => e.kind === 'download');
    const checks = this.evaluatePostconditions(page, beforeEpoch, intent.postcondition, hasDownload);
    const allPassed = checks.every((c) => c.passed);
    const evidence = {
      actionId,
      verifiedAt: Date.now(),
      observed: { url: page.url, title: page.title, navigationEpoch: page.navigationEpoch },
    };
    if (allPassed) {
      return {
        status: 'committed',
        evidence: {
          ...evidence,
          checks: [{ postcondition: JSON.stringify(intent.postcondition), passed: true }],
          // 下载动作的外部证据：本次会话累计第 N 次下载的 downloadId。
          // — English: download actions attach the session's Nth downloadId.
          ...(hasDownload
            ? { externalEvidence: { downloadId: `dl-${Date.now().toString(36)}-${this.downloads.length}` } }
            : {}),
        },
      };
    }
    return {
      status: 'uncertain',
      reason: '后置条件未满足',
      evidence: { ...evidence, checks },
    };
  }

  // 逐个应用效果。
  // — English: applies one effect.
  private async applyEffect(
    pageId: string,
    page: FakePageState,
    effect: FakeEffect,
    signal?: AbortSignal,
  ): Promise<void> {
    switch (effect.kind) {
      case 'navigate': {
        if (effect.url !== undefined) this.applyNavigate(pageId, effect.url);
        break;
      }
      case 'text_change': {
        if (effect.elementRef !== undefined && effect.text !== undefined) {
          const el = page.elements.find((e) => e.ref === effect.elementRef);
          if (el !== undefined) el.text = effect.text;
        }
        break;
      }
      case 'add_element': {
        if (effect.element !== undefined) page.elements.push({ ...effect.element });
        break;
      }
      case 'remove_element': {
        if (effect.elementRef !== undefined) {
          page.elements = page.elements.filter((e) => e.ref !== effect.elementRef);
        }
        break;
      }
      case 'delay': {
        await abortableDelay(effect.delayMs ?? this.defaultDelayMs, signal);
        break;
      }
      case 'download': {
        // 不做页面变化，仅把下载元数据记入会话账本。
        // — English: no page change — record the download metadata in the ledger.
        if (effect.url !== undefined) {
          this.downloads.push({
            url: effect.url,
            suggestedName: effect.suggestedName ?? 'download.bin',
            ...(effect.mimeType !== undefined ? { mimeType: effect.mimeType } : {}),
            ...(effect.sizeBytes !== undefined ? { sizeBytes: effect.sizeBytes } : {}),
            at: Date.now(),
          });
        }
        break;
      }
      case 'none':
      default:
        break;
    }
  }

  // 求值后置条件：返回逐项检查结果；download_completed 只对本次动作产生下载记录
  // 成立（hasDownload 由 act 依据效果列表计算，默认 false → 不通过）。
  // — English: evaluates the postcondition into per-item checks; download_completed
  //   passes only when this action produced a download record (hasDownload is
  //   computed by act from the effect list; default false → fails).
  private evaluatePostconditions(
    page: FakePageState,
    beforeEpoch: number,
    post: Postcondition,
    hasDownload = false,
  ): PostconditionCheck[] {
    const check = (passed: boolean, detail?: string): PostconditionCheck => ({
      postcondition: JSON.stringify(post),
      passed,
      ...(detail !== undefined ? { detail } : {}),
    });
    switch (post.kind) {
      case 'none':
        return [check(true)];
      case 'url_contains':
        return [check(page.url.includes(post.value))];
      case 'url_equals':
        return [check(page.url === post.value)];
      case 'navigation_epoch_changed':
        return [check(page.navigationEpoch !== beforeEpoch)];
      case 'element_appears': {
        const el = this.findByRef(page, post.ref);
        return [check(el !== undefined && el.visible !== false)];
      }
      case 'element_disappears':
        return [check(this.findByRef(page, post.ref) === undefined)];
      case 'element_text_contains': {
        const el = this.findByRef(page, post.ref);
        return [check(el !== undefined && el.text !== undefined && el.text.includes(post.value))];
      }
      case 'download_completed':
        return [check(hasDownload, hasDownload ? undefined : '本次动作未产生下载记录')];
      default:
        return [check(false, `未知后置条件: ${(post as { kind: string }).kind}`)];
    }
  }

  async close(_reason?: string): Promise<void> {
    this.assertOpen();
    this.closed = true;
  }
}

// ─── 运行时入口 ──────────────────────────────────────────────────────────────
// — English: runtime entry point.
export class FakeBrowserRuntime implements BrowserRuntimePort {
  readonly kind: 'fake' = 'fake' as const;
  private readonly site: FakeSiteDefinition;

  constructor(site: FakeSiteDefinition) {
    if (!site.pages.some((p) => p.url === site.startUrl)) {
      throw new Error(`startUrl 不在 site.pages 中: ${site.startUrl}`);
    }
    this.site = site;
  }

  async start(input: { taskId: string; signal?: AbortSignal }): Promise<BrowserSessionHandle> {
    return new FakeSessionHandle(this.site, input.taskId);
  }
}
