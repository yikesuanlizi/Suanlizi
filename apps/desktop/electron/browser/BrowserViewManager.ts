// BrowserViewManager：管理 WebContentsView 生命周期（创建/布局/显示/隐藏/销毁）。
// 用户与 Agent 操作的是同一个 View——远程页面绝不挂载 Suanlizi preload，也不获得
// 任何 Suanlizi IPC（架构文档 §3.3 / 迁移计划 §3.1）。
// — English: BrowserViewManager owns WebContentsView lifecycle
//   (create/layout/show/hide/destroy). Users and the agent operate the SAME view;
//   remote pages never get the Suanlizi preload or any Suanlizi IPC.
import { app, BaseWindow, session, WebContentsView } from 'electron';
import { mkdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { pageDeclaredIconUrl, validProviderIconUrl, type PageGraph } from '@suanlizi/protocol';
import type { BrowserDesktopEvent, BrowserTabState, CreateBrowserTabInput, BrowserViewBounds } from '../contracts/browserTypes.js';
import { BrowserEngineAdapter } from './BrowserEngineAdapter.js';

// 独立 session partition：不复用用户日常 Chrome profile（迁移计划 §3.3）。
// — English: a dedicated session partition — never reuses the user's daily Chrome profile.
const SESSION_PARTITION = 'persist:suanlizi-browser';

interface ManagedView {
  tabId: string;
  view: WebContentsView;
  url: string;
  title: string;
  visible: boolean;
  loading: boolean;
  openedBy: 'user' | 'agent';
  threadId?: string;
  favicon?: string;
  faviconFromPageLink?: boolean;
  navigationEpoch: number;
  containerBounds: BrowserViewBounds;
}

export interface BrowserDownloadReceipt {
  filename: string;
  path: string;
  totalBytes: number;
}

interface BrowserDownloadWaiter {
  resolve: (receipt: BrowserDownloadReceipt) => void;
  reject: (reason: Error) => void;
}

interface BrowserTabWaiter {
  taskId: string;
  resolve: () => void;
  reject: (reason: Error) => void;
}

function isDevToolsShortcut(input: Electron.Input): boolean {
  if (input.type !== 'keyDown') return false;
  const key = String(input.key ?? '').toLowerCase();
  const code = String((input as Electron.Input & { code?: string }).code ?? '').toLowerCase();
  const modifier = input.control === true || input.meta === true;
  return key === 'f12' || code === 'f12' || (modifier && input.shift === true && key === 'i');
}

function toggleDevTools(target: Electron.WebContents, scope: string): void {
  try {
    const opened = target.isDevToolsOpened();
    if (opened) {
      target.closeDevTools();
    } else {
      target.openDevTools({ mode: 'detach', activate: true, title: `Suanlizi ${scope} console` });
    }
    console.log(`[browser:${scope}] DevTools ${opened ? 'closed' : 'opened'}`);
  } catch (error) {
    console.error(`[browser:${scope}] DevTools toggle failed:`, error);
  }
}

export class BrowserViewManager {
  private readonly views = new Map<string, ManagedView>();
  private readonly host: BaseWindow;
  private readonly emit: (event: BrowserDesktopEvent) => void;
  private nextId = 1;
  private readonly agentTabByTask = new Map<string, string>();
  private readonly agentTaskByTab = new Map<string, string>();
  private readonly agentPopupTabsByTask = new Map<string, Set<string>>();
  private readonly popupParentByTab = new Map<string, string>();
  private readonly downloadWaiterByTab = new Map<string, BrowserDownloadWaiter>();
  private readonly browserTabWaiters = new Set<BrowserTabWaiter>();
  private readonly pendingBrowserRequestTasks = new Set<string>();
  // 同一线程必须严格串行，避免同一页面的 CDP 输入交叉；不同线程不应互相
  // 阻塞，因为它们拥有各自的根标签和页面树。
  private readonly agentOperationTailByTask = new Map<string, Promise<void>>();
  // 当前活动标签（用户可见 View；Agent 会话绑定它）。
  // — English: the currently active tab (the user-visible view the agent
  //   session binds to).
  private activeTabId: string | null = null;

  constructor(deps: { host: BaseWindow; emit: (event: BrowserDesktopEvent) => void }) {
    this.host = deps.host;
    this.emit = deps.emit;
    this.hardenBrowserSession();
  }

  // 浏览器会话加固 + 下载管理（单一持久化 partition 会话，Phase 4）。
  // — English: browser session hardening + download management (the single
  //   persistent partition session, Phase 4).
  private hardenBrowserSession(): void {
    const browserSession = session.fromPartition(SESSION_PARTITION);

    // 权限：只放行必要权限，其余一律拒绝（无定位/摄像头/麦克风/通知）。
    // — English: allow only essential permissions; deny everything else.
    browserSession.setPermissionRequestHandler((_wc, permission, callback) => {
      const allowed = new Set(['fullscreen', 'clipboard-sanitized-write', 'clipboard-read']);
      callback(allowed.has(permission));
    });
    browserSession.setPermissionCheckHandler((_wc, permission) => {
      const allowed = new Set(['fullscreen', 'clipboard-sanitized-write', 'clipboard-read']);
      return allowed.has(permission);
    });

    // 下载：默认保存到系统下载目录；进度/完成/失败事件转发 UI。
    // — English: downloads save to the system downloads folder; progress / done /
    //   failed events forward to the UI.
    browserSession.on('will-download', (_event, item, webContents) => {
      const tabId = this.tabIdFor(webContents);
      const filename = basename(item.getFilename()) || 'download';
      const ownerTaskId = this.agentTaskByTab.get(tabId);
      const safeTaskId = ownerTaskId?.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 96) || 'manual';
      const downloadDir = join(app.getPath('downloads'), 'Suanlizi', safeTaskId);
      mkdirSync(downloadDir, { recursive: true });
      const savePath = join(downloadDir, `${Date.now()}-${filename}`);
      this.emit({ type: 'download-started', tabId, filename });
      item.setSavePath(savePath);
      item.on('updated', (_e, state) => {
        if (state === 'interrupted') {
          this.rejectDownloadWaiter(tabId, new Error(`download interrupted: ${filename}`));
          this.emit({ type: 'download-failed', tabId, filename });
        } else {
          this.emit({
            type: 'download-progress',
            tabId,
            filename,
            receivedBytes: item.getReceivedBytes(),
            totalBytes: item.getTotalBytes(),
          });
        }
      });
      item.on('done', (_e, state) => {
        if (state === 'completed') {
          this.resolveDownloadWaiter(tabId, { filename, path: savePath, totalBytes: item.getTotalBytes() });
          this.emit({ type: 'download-completed', tabId, filename });
        } else {
          this.rejectDownloadWaiter(tabId, new Error(`download failed: ${filename}`));
          this.emit({ type: 'download-failed', tabId, filename });
        }
      });
    });
  }

  // 按 webContents 反查 tabId（下载/权限事件归属）。
  // — English: reverse-map a webContents to its tabId.
  private tabIdFor(webContents: Electron.WebContents): string {
    for (const [tabId, managed] of this.views) {
      if (managed.view.webContents === webContents) return tabId;
    }
    return '';
  }

  waitForNextDownload(tabId: string, input: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<BrowserDownloadReceipt> {
    if (!this.views.has(tabId)) return Promise.reject(new Error(`unknown tab: ${tabId}`));
    if (this.downloadWaiterByTab.has(tabId)) return Promise.reject(new Error(`download already pending for tab: ${tabId}`));
    const timeoutMs = input.timeoutMs ?? 30_000;
    return new Promise<BrowserDownloadReceipt>((resolve, reject) => {
      let settled = false;
      const timeout = setTimeout(() => finish(new Error('download timed out')), timeoutMs);
      timeout.unref?.();
      const onAbort = (): void => finish(new Error('download aborted'));
      const cleanup = (): void => {
        clearTimeout(timeout);
        input.signal?.removeEventListener('abort', onAbort);
        this.downloadWaiterByTab.delete(tabId);
      };
      const finish = (result: BrowserDownloadReceipt | Error): void => {
        if (settled) return;
        settled = true;
        cleanup();
        if (result instanceof Error) reject(result);
        else resolve(result);
      };
      if (input.signal?.aborted) {
        finish(new Error('download aborted'));
        return;
      }
      input.signal?.addEventListener('abort', onAbort, { once: true });
      this.downloadWaiterByTab.set(tabId, {
        resolve: (receipt) => finish(receipt),
        reject: (reason) => finish(reason),
      });
    });
  }

  private resolveDownloadWaiter(tabId: string, receipt: BrowserDownloadReceipt): void {
    this.downloadWaiterByTab.get(tabId)?.resolve(receipt);
  }

  private rejectDownloadWaiter(tabId: string, reason: Error): void {
    this.downloadWaiterByTab.get(tabId)?.reject(reason);
  }

  // 创建并挂载 View，返回 tabId。远程页面无 preload、无 Node 权限。
  // — English: creates and mounts the view; remote pages have no preload/Node access.
  createTab(input: CreateBrowserTabInput, openedBy?: 'user' | 'agent'): BrowserTabState {
    const tabId = `tab-${this.nextId++}`;
    const source = openedBy ?? input.openedBy ?? (this.pendingBrowserRequestTasks.size > 0 ? 'agent' : 'user');
    const view = new WebContentsView({
      webPreferences: {
        partition: SESSION_PARTITION,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        // 关键：远程页面不挂载 Suanlizi preload（架构文档 §3.3）。
        // — English: critical — remote pages never mount the Suanlizi preload.
        preload: undefined,
      },
    });
    const managed: ManagedView = {
      tabId,
      view,
      url: input.url,
      title: '',
      visible: true,
      loading: true,
      openedBy: source,
      threadId: input.threadId,
      navigationEpoch: 0,
      containerBounds: input.bounds,
    };
    this.views.set(tabId, managed);
    this.activeTabId = tabId;
    this.host.contentView.addChildView(view);
    this.setBounds(tabId, input.bounds);
    this.resolveBrowserTabWaiters(managed.threadId);

    // 页面生命周期事件 → Renderer（Phase 2 子集：loading/title/favicon/navigation/crash）。
    // — English: page lifecycle events → Renderer (Phase 2 subset).
    view.webContents.on('did-start-loading', () => {
      managed.loading = true;
      this.emit({ type: 'loading', tabId, loading: true, threadId: managed.threadId });
    });
    view.webContents.on('did-stop-loading', () => {
      managed.loading = false;
      this.emit({ type: 'loading', tabId, loading: false, threadId: managed.threadId });
    });
    view.webContents.on('did-navigate', (_event, url) => {
      managed.url = url;
      managed.navigationEpoch += 1;
      managed.favicon = undefined;
      managed.faviconFromPageLink = false;
      this.emit({ type: 'favicon', tabId, favicon: undefined });
      this.emit({ type: 'did-navigate', tabId, url, threadId: managed.threadId });
    });
    view.webContents.on('page-title-updated', (_event, title) => {
      managed.title = title;
      this.emit({ type: 'page-title', tabId, title, threadId: managed.threadId });
    });
    view.webContents.on('page-favicon-updated', (_event, favicons: string[]) => {
      // Chromium 的事件作为备选；DOM 中实际声明的图标 link 更可靠。
      const favicon = favicons.find(validProviderIconUrl);
      if (!managed.faviconFromPageLink && favicon) {
        managed.favicon = favicon;
        this.emit({ type: 'favicon', tabId, favicon });
      }
      // SPA 在初始加载之后也可能切换 icon；事件到达时再读取一次 link。
      void this.refreshDeclaredFavicon(managed);
    });
    view.webContents.on('did-finish-load', () => { void this.refreshDeclaredFavicon(managed); });
    // F12 → DevTools（用户可见网页的调试入口；与 Chrome 习惯一致）。
    // — English: F12 toggles DevTools for the user-visible page (Chrome habit).
    view.webContents.on('before-input-event', (event, input) => {
      if (isDevToolsShortcut(input)) {
        event.preventDefault();
        toggleDevTools(view.webContents, `tab ${tabId}`);
      }
    });
    // 页面 console 日志 → Renderer 事件（BrowserWorkbench 可展示）+ Main 终端。
    // Electron 32+ 的 console-message 是 event 对象签名（level/message/lineNumber/sourceId）。
    // — English: page console messages → renderer event + Main terminal.
    //   Electron 32+ uses the event-object signature for console-message.
    view.webContents.on('console-message', (event) => {
      const params = event as unknown as {
        level?: 'info' | 'warning' | 'error' | 'debug';
        message?: string;
        lineNumber?: number;
        sourceId?: string;
      };
      const level = (params.level === 'warning' || params.level === 'error' ? params.level : 'info') as 'info' | 'warning' | 'error';
      const message = params.message ?? '';
      const line = params.lineNumber ?? 0;
      const sourceId = params.sourceId ?? '';
      const text = `${message} (${sourceId}:${line})`;
      this.emit({ type: 'console', tabId, level, message: text });
      console.log(`[browser:${tabId}] ${text}`);
    });
    view.webContents.on('render-process-gone', (_event, details) => {
      if (details.reason !== 'clean-exit') {
        this.emit({ type: 'page-crashed', tabId });
      }
    });
    view.webContents.on('destroyed', () => {
      this.emit({ type: 'tab-closed', tabId });
    });

    // popup：在新标签打开（禁止独立窗口）。
    // — English: popups open as new tabs (standalone windows are blocked).
    view.webContents.setWindowOpenHandler(({ url }) => {
      const popup = this.createTab({ url, bounds: managed.containerBounds, threadId: managed.threadId }, managed.openedBy);
      const ownerTaskId = this.agentTaskByTab.get(tabId);
      if (ownerTaskId !== undefined) {
        this.agentTaskByTab.set(popup.tabId, ownerTaskId);
        const popupTabs = this.agentPopupTabsByTask.get(ownerTaskId) ?? new Set<string>();
        popupTabs.add(popup.tabId);
        this.agentPopupTabsByTask.set(ownerTaskId, popupTabs);
        this.popupParentByTab.set(popup.tabId, tabId);
      }
      return { action: 'deny' };
    });

    void view.webContents.loadURL(input.url).catch((err: unknown) => {
      // 加载失败由 did-fail-load 等事件呈现；这里仅记录。
      // — English: load failures surface via did-fail-load; log here only.
      console.error(`[browser] loadURL failed for ${tabId}: ${String(err)}`);
    });
    this.emit({ type: 'tab-created', tabId, url: input.url, openedBy: source, threadId: managed.threadId });
    return this.stateOf(managed);
  }

  private async refreshDeclaredFavicon(managed: ManagedView): Promise<void> {
    const epoch = managed.navigationEpoch;
    const pageUrl = managed.url;
    try {
      // 仅读取远程页面的 link 元数据；不在远程页面注入 Suanlizi preload/IPC。
      const result = await managed.view.webContents.executeJavaScript(`({
        baseUri: document.baseURI,
        links: Array.from(document.querySelectorAll('link[rel]')).filter(link => /icon/i.test(link.rel)).slice(0, 64).map(link => ({
          rel: link.rel, href: link.getAttribute('href') || '', type: link.type
        }))
      })`) as { baseUri?: unknown; links?: unknown };
      if (this.views.get(managed.tabId) !== managed || managed.navigationEpoch !== epoch || managed.url !== pageUrl) return;
      if (typeof result?.baseUri !== 'string' || !Array.isArray(result.links)) return;
      const links = result.links.filter((link): link is { rel: string; href: string; type?: string } =>
        typeof link === 'object' && link !== null
        && typeof link.rel === 'string' && link.rel.length < 128
        && typeof link.href === 'string' && link.href.length < 2048
        && (link.type === undefined || typeof link.type === 'string'));
      const favicon = pageDeclaredIconUrl(pageUrl, result.baseUri, links);
      if (favicon) {
        managed.favicon = favicon;
        managed.faviconFromPageLink = true;
        this.emit({ type: 'favicon', tabId: managed.tabId, favicon });
      }
    } catch {
      // CSP / navigation / destroyed tab: preserve a valid Electron favicon, never guess /favicon.ico.
    }
  }

  // 网页四周留边距 + 圆角（视觉上与 Electron 窗口融合更好看）。
  // — English: the web page gets an inset margin and rounded corners so it
  //   blends nicely with the Electron window.
  private static readonly VIEW_INSET = 16;
  private static readonly VIEW_RADIUS = 16;

  setBounds(tabId: string, bounds: BrowserViewBounds, threadId?: string): void {
    if (threadId !== undefined) this.assertTabScope(tabId, threadId);
    const managed = this.views.get(tabId);
    if (managed === undefined) throw new Error(`unknown tab: ${tabId}`);
    const inset = BrowserViewManager.VIEW_INSET;
    managed.containerBounds = bounds;
    const padded: BrowserViewBounds = {
      x: bounds.x + inset,
      y: bounds.y + inset,
      width: Math.max(bounds.width - inset * 2, 1),
      height: Math.max(bounds.height - inset * 2, 1),
    };
    managed.view.setBounds(padded);
    try {
      managed.view.setBorderRadius(BrowserViewManager.VIEW_RADIUS);
    } catch {
      // 老版本 Electron 无 setBorderRadius——忽略（仅影响圆角）。
      // — English: older Electron lacks setBorderRadius — ignore (corners only).
    }
  }

  hasTab(tabId: string): boolean {
    return this.views.has(tabId);
  }

  /** Renderer-driven operations must provide the owning thread scope. */
  assertTabScope(tabId: string, threadId?: string): void {
    const managed = this.views.get(tabId);
    if (managed === undefined) throw new Error(`unknown tab: ${tabId}`);
    const scope = threadId?.trim();
    if (!scope || !managed.threadId || managed.threadId !== scope) {
      throw new Error(`browser tab is outside thread scope: ${tabId}`);
    }
  }

  setVisible(tabId: string, visible: boolean, threadId?: string): void {
    if (threadId !== undefined) this.assertTabScope(tabId, threadId);
    const managed = this.views.get(tabId);
    if (managed === undefined) throw new Error(`unknown tab: ${tabId}`);
    managed.visible = visible;
    if (visible) {
      this.host.contentView.addChildView(managed.view);
    } else {
      this.host.contentView.removeChildView(managed.view);
    }
    this.emit({ type: 'tab-visible', tabId, visible, threadId: managed.threadId });
  }

  navigate(tabId: string, url: string, threadId?: string): void {
    if (threadId !== undefined) this.assertTabScope(tabId, threadId);
    const managed = this.views.get(tabId);
    if (managed === undefined) throw new Error(`unknown tab: ${tabId}`);
    // 底层兜底规范化：无协议时 localhost/回环/IP 补 http://（与 UI/BrowserTool 一致）。
    // — English: bottom-line URL normalization — localhost/loopback/IPs get
    //   http:// when the scheme is missing (same as UI/BrowserTool).
    const normalized = /^[a-z][a-z0-9+.-]*:\/\//i.test(url)
      ? url
      : /^(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(:\d+)?$|^\d{1,3}(\.\d{1,3}){3}(:\d+)?$/.test(url.split(/[/?#]/)[0] ?? '')
        ? `http://${url}`
        : `https://${url}`;
    managed.url = normalized;
    void managed.view.webContents.loadURL(normalized);
  }

  // 激活标签：隐藏其余 View，目标保持可见并置于最前（不抢其它面板焦点）。
  // — English: activate a tab — hide the others, keep the target visible and on
  //   top (no focus stealing from other panels).
  activateTab(tabId: string, threadId?: string): void {
    const target = this.views.get(tabId);
    if (target === undefined) throw new Error(`unknown tab: ${tabId}`);
    const scope = threadId?.trim();
    if (threadId !== undefined) this.assertTabScope(tabId, scope);
    this.activeTabId = tabId;
    for (const managed of this.views.values()) {
      const visible = managed.tabId === tabId;
      if (visible !== managed.visible) {
        managed.visible = visible;
        if (visible) {
          this.host.contentView.addChildView(managed.view);
        } else {
          this.host.contentView.removeChildView(managed.view);
        }
        this.emit({ type: 'tab-visible', tabId: managed.tabId, visible, threadId: managed.threadId });
      }
    }
  }

  // 前进/后退：返回是否成功（导航历史可用）。
  // — English: back/forward — returns whether the navigation happened.
  back(tabId: string, threadId?: string): boolean {
    if (threadId !== undefined) this.assertTabScope(tabId, threadId);
    const managed = this.views.get(tabId);
    if (managed === undefined) throw new Error(`unknown tab: ${tabId}`);
    if (!managed.view.webContents.navigationHistory.canGoBack()) return false;
    managed.view.webContents.navigationHistory.goBack();
    return true;
  }

  forward(tabId: string, threadId?: string): boolean {
    if (threadId !== undefined) this.assertTabScope(tabId, threadId);
    const managed = this.views.get(tabId);
    if (managed === undefined) throw new Error(`unknown tab: ${tabId}`);
    if (!managed.view.webContents.navigationHistory.canGoForward()) return false;
    managed.view.webContents.navigationHistory.goForward();
    return true;
  }

  reload(tabId: string, threadId?: string): void {
    if (threadId !== undefined) this.assertTabScope(tabId, threadId);
    const managed = this.views.get(tabId);
    if (managed === undefined) throw new Error(`unknown tab: ${tabId}`);
    managed.view.webContents.reload();
  }

  stop(tabId: string, threadId?: string): void {
    if (threadId !== undefined) this.assertTabScope(tabId, threadId);
    const managed = this.views.get(tabId);
    if (managed === undefined) throw new Error(`unknown tab: ${tabId}`);
    managed.view.webContents.stop();
  }

  focus(tabId: string, threadId?: string): void {
    if (threadId !== undefined) this.assertTabScope(tabId, threadId);
    const managed = this.views.get(tabId);
    if (managed === undefined) throw new Error(`unknown tab: ${tabId}`);
    managed.view.webContents.focus();
  }

  toggleDevTools(tabId: string, threadId?: string): void {
    if (threadId !== undefined) this.assertTabScope(tabId, threadId);
    const managed = this.views.get(tabId);
    if (managed === undefined) throw new Error(`unknown tab: ${tabId}`);
    toggleDevTools(managed.view.webContents, `tab ${tabId}`);
  }

  viewFor(tabId: string): WebContentsView {
    const managed = this.views.get(tabId);
    if (managed === undefined) throw new Error(`unknown tab: ${tabId}`);
    return managed.view;
  }

  // 统一 CDP Adapter 缓存（按 webContents.id）：同一 View 永远只有一个 adapter，
  // 避免两个 debugger 附着同一 target（ElectronWebContentsRuntime 与 UI IPC 共用）。
  // — English: unified CDP adapter cache (keyed by webContents.id) — one adapter
  //   per view, shared by ElectronWebContentsRuntime and the UI IPC.
  adapterForView(view: WebContentsView): BrowserEngineAdapter {
    const id = view.webContents.id;
    let adapter = this.adapters.get(id);
    if (adapter === undefined) {
      adapter = new BrowserEngineAdapter(view);
      this.adapters.set(id, adapter);
    }
    return adapter;
  }

  // 关闭标签时释放 CDP adapter（视图销毁后不再附着）。
  // — English: release the CDP adapter when the tab closes.
  private readonly adapters = new Map<number, BrowserEngineAdapter>();

  listTabs(threadId?: string): BrowserTabState[] {
    const scope = threadId?.trim();
    return [...this.views.values()]
      .filter((managed) => !scope || managed.threadId === scope)
      .map((m) => this.stateOf(m));
  }

  // 隐藏工作台只移除原生 View，不销毁标签或 Agent 的 pageId 绑定。
  // 这样用户可以收起右侧栏，Agent 后续仍能继续操作同一页面。
  hideAll(threadId?: string): void {
    const scope = threadId?.trim();
    for (const managed of this.views.values()) {
      if (scope && managed.threadId !== scope) continue;
      if (!managed.visible) continue;
      managed.visible = false;
      this.host.contentView.removeChildView(managed.view);
      this.emit({ type: 'tab-visible', tabId: managed.tabId, visible: false, threadId: managed.threadId });
    }
  }

  // 关闭标签立即回收 View；不存在不可见页面持续占用。
  // — English: closing a tab recycles its view immediately.
  destroy(tabId: string, threadId?: string): void {
    const managed = this.views.get(tabId);
    if (managed === undefined) return;
    if (threadId !== undefined) this.assertTabScope(tabId, threadId);
    this.rejectDownloadWaiter(tabId, new Error('browser tab closed'));
    const ownerTaskId = this.agentTaskByTab.get(tabId);
    if (ownerTaskId !== undefined) {
      this.agentTaskByTab.delete(tabId);
      this.agentPopupTabsByTask.get(ownerTaskId)?.delete(tabId);
      this.popupParentByTab.delete(tabId);
      if (this.agentTabByTask.get(ownerTaskId) === tabId) {
        this.agentTabByTask.delete(ownerTaskId);
        for (const popupTabId of this.agentPopupTabsByTask.get(ownerTaskId) ?? []) {
          this.agentTaskByTab.delete(popupTabId);
          this.popupParentByTab.delete(popupTabId);
        }
        this.agentPopupTabsByTask.delete(ownerTaskId);
      }
    }
    this.views.delete(tabId);
    this.host.contentView.removeChildView(managed.view);
    this.adapters.get(managed.view.webContents.id)?.detach();
    this.adapters.delete(managed.view.webContents.id);
    if (!managed.view.webContents.isDestroyed()) {
      managed.view.webContents.close();
    }
  }

  // 退出时回收全部 View（无残留进程）。
  // — English: recycle every view on shutdown (no residual processes).
  dispose(): void {
    this.rejectBrowserTabWaiters(new Error('browser manager disposed'));
    for (const tabId of [...this.views.keys()]) {
      this.destroy(tabId);
    }
  }

  // 关闭浏览器面板时回收全部 View（React 卸载不会销毁原生 View，必须显式清理，
  // 否则页面残留在窗口上）。
  // — English: recycle every view when the browser panel closes (React unmount
  //   does not destroy native views — without this the page stays on screen).
  // 当前活动标签（无活动标签时回退第一个）。Agent 会话绑定用户可见的 View。
  // — English: the active tab (falls back to the first); the agent session
  //   binds the user-visible view.
  activeTabOrFirst(): { tabId: string; view: WebContentsView } {
    const tabs = this.listTabs();
    if (tabs.length === 0) throw new Error('no browser tab open');
    const tabId = this.activeTabId !== null && tabs.some((t) => t.tabId === this.activeTabId)
      ? this.activeTabId
      : tabs[0].tabId;
    return { tabId, view: this.viewFor(tabId) };
  }

  private tabsForTask(taskId: string): ManagedView[] {
    // A browser page is never implicitly claimed across threads. Older tabs
    // without a scope remain user-visible legacy state, but cannot become an
    // agent target until the renderer recreates them with an explicit scope.
    return [...this.views.values()].filter((managed) => managed.threadId === taskId);
  }

  private waitForBrowserTab(taskId: string, input: { signal?: AbortSignal } = {}): Promise<void> {
    if (this.tabsForTask(taskId).length > 0) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      let finish: (reason?: Error) => void = () => undefined;
      const waiter: BrowserTabWaiter = {
        taskId,
        resolve: () => finish(),
        reject: (reason) => finish(reason),
      };
      const timeout = setTimeout(() => finish(new Error('浏览器工作台未在 30 秒内就绪')), 30_000);
      timeout.unref?.();
      const onAbort = (): void => finish(new Error('等待浏览器工作台时已取消'));
      const cleanup = (): void => {
        clearTimeout(timeout);
        input.signal?.removeEventListener('abort', onAbort);
        this.browserTabWaiters.delete(waiter);
      };
      finish = (reason?: Error): void => {
        if (settled) return;
        settled = true;
        cleanup();
        this.pendingBrowserRequestTasks.delete(taskId);
        if (reason !== undefined) {
          reject(reason);
        } else resolve();
      };
      if (input.signal?.aborted) {
        finish(new Error('等待浏览器工作台时已取消'));
        return;
      }
      this.browserTabWaiters.add(waiter);
      this.pendingBrowserRequestTasks.add(taskId);
      input.signal?.addEventListener('abort', onAbort, { once: true });
      this.emit({ type: 'agent-browser-requested', taskId });
    });
  }

  hasPendingAgentBrowserRequest(): boolean {
    return this.pendingBrowserRequestTasks.size > 0;
  }

  pendingAgentBrowserRequestTaskIds(): string[] {
    return [...this.pendingBrowserRequestTasks];
  }

  private resolveBrowserTabWaiters(threadId?: string): void {
    const scope = threadId?.trim();
    if (!scope) return;
    for (const waiter of [...this.browserTabWaiters]) {
      if (waiter.taskId !== scope) continue;
      waiter.resolve();
    }
  }

  private rejectBrowserTabWaiters(reason: Error): void {
    this.pendingBrowserRequestTasks.clear();
    for (const waiter of [...this.browserTabWaiters]) {
      waiter.reject(reason);
    }
  }

  async acquireAgentTab(taskId: string, input: { signal?: AbortSignal } = {}): Promise<{ tabId: string; view: WebContentsView }> {
    const existingTabId = this.agentTabByTask.get(taskId);
    if (existingTabId !== undefined && this.views.has(existingTabId)) {
      return { tabId: existingTabId, view: this.viewFor(existingTabId) };
    }

    await this.waitForBrowserTab(taskId, input);
    const candidates = this.tabsForTask(taskId);
    if (candidates.length === 0) throw new Error(`no browser tab open for task: ${taskId}`);
    const activeState = candidates.find((tab) => tab.tabId === this.activeTabId) ?? candidates[0];
    const active = { tabId: activeState.tabId, view: this.viewFor(activeState.tabId) };
    const activeManaged = this.views.get(active.tabId);
    if (activeManaged === undefined) throw new Error(`unknown tab: ${active.tabId}`);
    if (!this.agentTaskByTab.has(active.tabId)) {
      this.agentTabByTask.set(taskId, active.tabId);
      this.agentTaskByTab.set(active.tabId, taskId);
      return active;
    }

    const tab = this.createTab({ url: 'about:blank', bounds: activeManaged.containerBounds, threadId: taskId }, 'agent');
    this.activateTab(tab.tabId, taskId);
    this.agentTabByTask.set(taskId, tab.tabId);
    this.agentTaskByTab.set(tab.tabId, taskId);
    return { tabId: tab.tabId, view: this.viewFor(tab.tabId) };
  }

  agentTabForPage(taskId: string, pageId?: string): { tabId: string; view: WebContentsView } {
    const rootTabId = this.agentTabByTask.get(taskId);
    if (rootTabId === undefined || !this.views.has(rootTabId)) {
      throw new Error(`browser tab unavailable for task: ${taskId}`);
    }
    const tabId = pageId ?? rootTabId;
    const isTaskPage = tabId === rootTabId || this.agentPopupTabsByTask.get(taskId)?.has(tabId) === true;
    if (!isTaskPage || !this.views.has(tabId)) {
      throw new Error(`browser page unavailable for task: ${taskId}`);
    }
    return { tabId, view: this.viewFor(tabId) };
  }

  agentPageGraph(taskId: string): PageGraph {
    const rootTabId = this.agentTabByTask.get(taskId);
    if (rootTabId === undefined || !this.views.has(rootTabId)) {
      throw new Error(`browser tab unavailable for task: ${taskId}`);
    }
    const tabIds = [rootTabId, ...(this.agentPopupTabsByTask.get(taskId) ?? [])]
      .filter((tabId) => this.views.has(tabId));
    const activePageId = this.activeTabId !== null && tabIds.includes(this.activeTabId)
      ? this.activeTabId
      : rootTabId;
    return {
      activePageId,
      pages: tabIds.map((tabId) => {
        const managed = this.views.get(tabId)!;
        const openerPageId = this.popupParentByTab.get(tabId);
        return {
          pageId: tabId,
          ...(openerPageId === undefined ? {} : { openerPageId }),
          openedBy: managed.openedBy,
          url: managed.url,
          title: managed.title,
          state: tabId === activePageId ? 'active' : 'background',
          navigationEpoch: managed.navigationEpoch,
        };
      }),
    };
  }

  async runAgentOperation<T>(taskId: string, pageId: string | undefined, operation: () => Promise<T>): Promise<T> {
    let release: () => void = () => undefined;
    const previous = this.agentOperationTailByTask.get(taskId) ?? Promise.resolve();
    const tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.agentOperationTailByTask.set(taskId, tail);
    await previous;
    try {
      const page = this.agentTabForPage(taskId, pageId);
      if (!this.views.get(page.tabId)?.visible) {
        // 收起的工作台不会终止会话；下一次 Agent 操作会请求 Renderer 恢复它。
        this.emit({ type: 'agent-browser-requested', taskId });
      }
      this.activateTab(page.tabId, taskId);
      return await operation();
    } finally {
      release();
      if (this.agentOperationTailByTask.get(taskId) === tail) {
        this.agentOperationTailByTask.delete(taskId);
      }
    }
  }

  destroyAll(): void {
    this.dispose();
  }

  destroyThreadTabs(threadId: string): void {
    const scope = threadId.trim();
    if (!scope) return;
    for (const [tabId, managed] of this.views) {
      if (managed.threadId === scope) this.destroy(tabId, scope);
    }
  }

  private stateOf(managed: ManagedView): BrowserTabState {
    return {
      tabId: managed.tabId,
      url: managed.url,
      title: managed.title,
      visible: managed.visible,
      loading: managed.loading,
      openedBy: managed.openedBy,
      threadId: managed.threadId,
      favicon: managed.favicon,
    };
  }
}
