// BrowserWorkbench：承载真实 WebContentsView 的浏览器工作台（Phase 2）。
// 不再使用截图数据 URL —— 页面直接以 WebContentsView 呈现，Renderer 只做
// 标签栏/地址栏/导航按钮/容器 bounds 上报（ResizeObserver → setBounds）。
// — English: BrowserWorkbench hosts the real WebContentsView (Phase 2). No more
//   screenshot data URLs — the page renders as a WebContentsView; the renderer
//   only manages tabs/address bar/nav buttons and reports the container bounds.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Icon } from './Icon.js';

// preload typed API 局部结构（electron 目录独立编译边界）。
// — English: local structural shape of the preload typed API.
interface BrowserTabState {
  tabId: string;
  url: string;
  title: string;
  visible: boolean;
  loading: boolean;
  openedBy?: 'user' | 'agent';
  threadId?: string;
  favicon?: string;
}

type BrowserEvent =
  | { type: 'tab-created'; tabId: string; url: string; openedBy?: 'user' | 'agent'; threadId?: string }
  | { type: 'tab-closed'; tabId: string }
  | { type: 'tab-visible'; tabId: string; visible: boolean; threadId?: string }
  | { type: 'did-navigate'; tabId: string; url: string; threadId?: string }
  | { type: 'page-title'; tabId: string; title: string; threadId?: string }
  | { type: 'loading'; tabId: string; loading: boolean; threadId?: string };

interface BrowserApi {
  createTab(input: { url: string; bounds: { x: number; y: number; width: number; height: number }; openedBy?: 'user' | 'agent'; threadId?: string }): Promise<BrowserTabState>;
  closeTab(input: { tabId: string; threadId: string }): Promise<void>;
  hideAllTabs(input?: { threadId?: string }): Promise<void>;
  activateTab(input: { tabId: string; threadId?: string }): Promise<void>;
  setBounds(input: { tabId: string; threadId: string; bounds: { x: number; y: number; width: number; height: number } }): Promise<void>;
  navigate(input: { tabId: string; threadId: string; url: string }): Promise<void>;
  back(input: { tabId: string; threadId: string }): Promise<boolean>;
  forward(input: { tabId: string; threadId: string }): Promise<boolean>;
  reload(input: { tabId: string; threadId: string }): Promise<void>;
  stop(input: { tabId: string; threadId: string }): Promise<void>;
  listTabs(input?: { threadId?: string }): Promise<BrowserTabState[]>;
  subscribe(handler: (event: BrowserEvent) => void): () => void;
}

function getBrowserApi(): BrowserApi | undefined {
  const api = (window as unknown as { suanliziDesktop?: { browser?: BrowserApi } }).suanliziDesktop?.browser;
  return api ?? undefined;
}

const DEFAULT_URL = 'about:blank';
const BROWSER_SESSION_STORAGE_KEY = 'suanlizi.browser.session.v1';

interface PersistedBrowserSession {
  tabs: Array<{ url: string; title?: string; openedBy?: 'user' | 'agent' }>;
  activeIndex: number;
}

function browserSessionStorageKey(threadId: string): string {
  return `${BROWSER_SESSION_STORAGE_KEY}:${encodeURIComponent(threadId || 'unscoped')}`;
}

function readStoredBrowserSession(threadId: string): PersistedBrowserSession | null {
  try {
    const raw = localStorage.getItem(browserSessionStorageKey(threadId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PersistedBrowserSession>;
    const tabs = Array.isArray(parsed.tabs)
      ? parsed.tabs.filter((tab): tab is { url: string; title?: string; openedBy?: 'user' | 'agent' } => (
        Boolean(tab) && typeof tab === 'object' && typeof tab.url === 'string' && tab.url.trim() !== ''
      )).slice(0, 12)
      : [];
    if (tabs.length === 0) return null;
    const activeIndex = typeof parsed.activeIndex === 'number'
      ? Math.max(0, Math.min(tabs.length - 1, Math.floor(parsed.activeIndex)))
      : 0;
    return { tabs, activeIndex };
  } catch {
    return null;
  }
}

function writeStoredBrowserSession(threadId: string, tabs: BrowserTabState[], activeTabId: string | null): void {
  try {
    const activeIndex = Math.max(0, tabs.findIndex((tab) => tab.tabId === activeTabId));
    localStorage.setItem(browserSessionStorageKey(threadId), JSON.stringify({
      tabs: tabs.map((tab) => ({ url: tab.url || DEFAULT_URL, title: tab.title, openedBy: tab.openedBy })),
      activeIndex,
    } satisfies PersistedBrowserSession));
  } catch {
    // Browser session metadata is best effort; native views remain authoritative.
  }
}

// 无协议 URL 规范化：localhost/回环/IP 补 http://（本地服务基本都是 http），
// 域名才补 https://。之前一律 https:// 导致 localhost:5173 之类 SSL 失败。
// — English: URL normalization without a scheme — localhost/loopback/IPs get
//   http:// (local services are almost always http); only domains default to
//   https://. Everything used to become https://, which broke localhost:5173.
export function normalizeBrowserUrl(input: string): string {
  const url = input.trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) return url;
  const hostPart = url.split(/[/?#]/)[0] ?? '';
  if (
    /^(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(:\d+)?$/.test(hostPart) ||
    /^\d{1,3}(\.\d{1,3}){3}(:\d+)?$/.test(hostPart)
  ) {
    return `http://${url}`;
  }
  return `https://${url}`;
}

export function BrowserWorkbench({
  active = true,
  threadId = '',
  navigationRequest,
}: {
  active?: boolean;
  threadId?: string;
  navigationRequest?: { url: string; nonce: number; threadId?: string } | null;
}) {
  const apiRef = useRef<BrowserApi | undefined>(undefined);
  const [tabs, setTabs] = useState<BrowserTabState[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [address, setAddress] = useState('');
  const [loading, setLoading] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const initialTabRequestedRef = useRef(false);
  const browserStateHydratedRef = useRef(false);
  const [browserReady, setBrowserReady] = useState(false);
  const appliedNavigationNonceRef = useRef(0);
  const [rendererOverlayVisible, setRendererOverlayVisible] = useState(false);
  const effectiveActive = active && !rendererOverlayVisible;
  const activeRef = useRef(effectiveActive);
  const threadScope = threadId.trim();

  useEffect(() => {
    activeRef.current = effectiveActive;
  }, [effectiveActive]);

  // Native WebContentsView sits above Renderer pixels. Watch generic modal
  // surfaces as well as the explicit app state passed by the parent, so a new
  // help/preview dialog cannot accidentally be covered by a live web page.
  useEffect(() => {
    const readOverlayState = (): void => {
      const visible = Boolean(document.querySelector(
        '.settingsLayer, .dialogLayer, [role="dialog"][aria-modal="true"]',
      ));
      setRendererOverlayVisible((current) => current === visible ? current : visible);
    };
    readOverlayState();
    const observer = new MutationObserver(readOverlayState);
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class', 'aria-modal'],
    });
    return () => observer.disconnect();
  }, []);

  // 初始化：获取 API、订阅事件、恢复既有标签。
  // — English: init — grab the API, subscribe to events, restore existing tabs.
  useEffect(() => {
    const api = getBrowserApi();
    if (!api) return;
    apiRef.current = api;
    let cancelled = false;
    initialTabRequestedRef.current = false;
    browserStateHydratedRef.current = false;
    setBrowserReady(false);
    setTabs([]);
    setActiveTabId(null);
    setAddress('');
    setLoading(false);
    let layoutRetry = 0;
    const createInitialTab = (): void => {
      if (cancelled || initialTabRequestedRef.current) return;
      const container = containerRef.current;
      if (!container) return;
      const rect = container.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1) {
        layoutRetry = window.requestAnimationFrame(createInitialTab);
        return;
      }
      initialTabRequestedRef.current = true;
      void api.createTab({
        url: DEFAULT_URL,
        threadId: threadScope || undefined,
        bounds: {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        },
      });
    };
    const restoreOrCreateTabs = (): void => {
      if (cancelled || initialTabRequestedRef.current) return;
      const container = containerRef.current;
      if (!container) return;
      const rect = container.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1) {
        layoutRetry = window.requestAnimationFrame(restoreOrCreateTabs);
        return;
      }
      initialTabRequestedRef.current = true;
      const saved = readStoredBrowserSession(threadScope);
      if (!saved) {
        initialTabRequestedRef.current = false;
        createInitialTab();
        return;
      }
      void (async () => {
        const created: BrowserTabState[] = [];
        for (const savedTab of saved.tabs) {
          if (cancelled) return;
          try {
            created.push(await api.createTab({
              url: savedTab.url,
              openedBy: savedTab.openedBy,
              threadId: threadScope || undefined,
              bounds: {
                x: Math.round(rect.x),
                y: Math.round(rect.y),
                width: Math.round(rect.width),
                height: Math.round(rect.height),
              },
            }));
          } catch {
            // Skip stale or invalid saved pages and continue restoring others.
          }
        }
        const active = created[saved.activeIndex] ?? created[0];
        if (active) {
          setActiveTabId(active.tabId);
          setAddress(active.url);
          setLoading(active.loading);
          if (activeRef.current) void api.activateTab({ tabId: active.tabId, threadId: threadScope || undefined });
        }
      })();
    };
    if (!threadScope) {
      setBrowserReady(true);
      return () => {
        cancelled = true;
        window.cancelAnimationFrame(layoutRetry);
      };
    }
    void api.listTabs({ threadId: threadScope }).then((existing) => {
      if (cancelled) return;
      browserStateHydratedRef.current = true;
      setBrowserReady(true);
      setTabs(existing);
      if (existing.length > 0) {
        const active = existing.find((tab) => tab.visible) ?? existing[0];
        setActiveTabId(active.tabId);
        setAddress(active.url);
        setLoading(active.loading);
        if (activeRef.current) void api.activateTab({ tabId: active.tabId, threadId: threadScope || undefined });
      } else {
        restoreOrCreateTabs();
      }
    });
    const unsubscribe = api.subscribe((event) => {
      if (threadScope && event.type !== 'tab-closed' && event.threadId !== threadScope) return;
      switch (event.type) {
        case 'tab-created':
          setTabs((prev) => [...prev, { tabId: event.tabId, url: event.url, title: '', visible: true, loading: true, openedBy: event.openedBy, threadId: event.threadId }]);
          setActiveTabId(event.tabId);
          setAddress(event.url);
          break;
        case 'tab-visible':
          setTabs((prev) => prev.map((tab) => (tab.tabId === event.tabId ? { ...tab, visible: event.visible } : tab)));
          // A queued Agent action can reactivate the native view while a modal
          // is still open. Remove it again without destroying the tab/session.
          if (event.visible && !activeRef.current) void api.hideAllTabs({ threadId: threadScope });
          break;
        case 'tab-closed':
          setTabs((prev) => prev.filter((t) => t.tabId !== event.tabId));
          setActiveTabId((current) => (current === event.tabId ? null : current));
          break;
        case 'did-navigate':
          setTabs((prev) => prev.map((t) => (t.tabId === event.tabId ? { ...t, url: event.url } : t)));
          setActiveTabId((current) => {
            if (current === event.tabId) setAddress(event.url);
            return current;
          });
          break;
        case 'page-title':
          setTabs((prev) => prev.map((t) => (t.tabId === event.tabId ? { ...t, title: event.title } : t)));
          break;
        case 'loading':
          setTabs((prev) => prev.map((t) => (t.tabId === event.tabId ? { ...t, loading: event.loading } : t)));
          setActiveTabId((current) => {
            if (current === event.tabId) setLoading(event.loading);
            return current;
          });
          break;
        default:
          break;
      }
    });
    return () => {
      cancelled = true;
      window.cancelAnimationFrame(layoutRetry);
      unsubscribe();
      // 右侧栏收起会卸载 React 工作台；仅隐藏原生 View，页面及 Agent pageId
      // 绑定由主进程保留，避免再次打开时退回 about:blank。
      if (threadScope) void api.hideAllTabs({ threadId: threadScope });
    };
  }, [threadScope]);

  useEffect(() => {
    const request = navigationRequest;
    const api = apiRef.current;
    if (
      !browserReady
      || !request?.url
      || !api
      || (request.threadId !== undefined && request.threadId !== threadScope)
      || appliedNavigationNonceRef.current === request.nonce
    ) return;
    const container = containerRef.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return;
    appliedNavigationNonceRef.current = request.nonce;
    const bounds = {
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    };
    const currentTabId = activeTabId ?? tabs[0]?.tabId;
    void (async () => {
      if (currentTabId) {
        await api.navigate({ tabId: currentTabId, threadId: threadScope, url: request.url });
        setActiveTabId(currentTabId);
        setAddress(request.url);
        if (effectiveActive) await api.activateTab({ tabId: currentTabId, threadId: threadScope || undefined });
        return;
      }
      const created = await api.createTab({ url: request.url, bounds, openedBy: 'user', threadId: threadScope || undefined });
      setActiveTabId(created.tabId);
      setAddress(created.url || request.url);
      setLoading(created.loading);
    })().catch(() => {
      appliedNavigationNonceRef.current = 0;
    });
  }, [activeTabId, browserReady, effectiveActive, navigationRequest, tabs, threadScope]);

  useEffect(() => {
    if (!browserStateHydratedRef.current) return;
    writeStoredBrowserSession(threadScope, tabs, activeTabId);
  }, [tabs, activeTabId, threadScope]);

  // 原生 WebContentsView 不属于 React 的层叠上下文。切换到文件、活动或任意
  // 模态层时必须从 Main 的 contentView 移除它，否则会压在 Renderer UI 之上。
  useEffect(() => {
    const api = apiRef.current;
    if (!api) return;
    if (!effectiveActive) {
      if (threadScope) void api.hideAllTabs({ threadId: threadScope });
      return;
    }
    const tabId = activeTabId ?? tabs[0]?.tabId;
    if (!tabId) return;
    void api.activateTab({ tabId, threadId: threadScope || undefined });
    const frame = window.requestAnimationFrame(() => reportBrowserBounds(api, containerRef.current, tabId, threadScope));
    return () => window.cancelAnimationFrame(frame);
  }, [effectiveActive, activeTabId, tabs, threadScope]);

  // 容器尺寸变化 → 上报 bounds（Main 设置 View 布局）。
  // — English: container resize → report bounds (Main lays out the view).
  useEffect(() => {
    const api = apiRef.current;
    const container = containerRef.current;
    if (!api || !container) return;
    const report = (): void => reportBrowserBounds(api, container, activeTabId, threadScope);
    const observer = new ResizeObserver(report);
    observer.observe(container);
    window.addEventListener('resize', report);
    report();
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', report);
    };
  }, [effectiveActive, activeTabId, threadScope]);

  const createTab = useCallback(() => {
    const api = apiRef.current;
    const container = containerRef.current;
    if (!api || !container) return;
    const rect = container.getBoundingClientRect();
    void api.createTab({
      url: DEFAULT_URL,
      openedBy: 'user',
      threadId: threadScope || undefined,
      bounds: {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      },
    });
  }, [threadScope]);

  const submitAddress = useCallback(() => {
    const api = apiRef.current;
    const container = containerRef.current;
    const url = address.trim();
    if (!api || url === '') return;
    const normalized = normalizeBrowserUrl(url);
    // 无标签时直接创建并导航（用户打开面板即可输入网址，不必先建标签）。
    // — English: with no tab yet, create one and navigate directly (the address
    //   bar works right after opening the panel).
    if (!activeTabId) {
      if (!container) return;
      const rect = container.getBoundingClientRect();
      void api.createTab({
        url: normalized,
        openedBy: 'user',
        threadId: threadScope || undefined,
        bounds: {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        },
      });
      return;
    }
    void api.navigate({ tabId: activeTabId, threadId: threadScope, url: normalized });
  }, [activeTabId, address, threadScope]);

  const activateTab = useCallback(
    (tabId: string) => {
      const api = apiRef.current;
      if (!api) return;
      setActiveTabId(tabId);
      void api.activateTab({ tabId, threadId: threadScope || undefined });
      const tab = tabs.find((t) => t.tabId === tabId);
      setAddress(tab?.url ?? '');
      setLoading(tab?.loading ?? false);
    },
    [tabs, threadScope],
  );

  const closeTab = useCallback((tabId: string) => {
    const api = apiRef.current;
    if (!api) return;
    void api.closeTab({ tabId, threadId: threadScope });
  }, [threadScope]);

  const callNav = useCallback(
    (fn: (api: BrowserApi) => Promise<unknown>) => {
      const api = apiRef.current;
      if (!api || !activeTabId) return;
      void fn(api);
    },
    [activeTabId, threadScope],
  );

  const activeTitle = tabs.find((t) => t.tabId === activeTabId)?.title ?? '';

  return (
    <section className="browserWorkbench" data-testid="browserWorkbench">
      <div className="browserToolbar">
      <button type="button" className="browserToolbarButton" aria-label="后退" onClick={() => callNav((a) => a.back({ tabId: activeTabId!, threadId: threadScope }))} disabled={!activeTabId}>
          <Icon name="chevronLeft" />
        </button>
        <button type="button" className="browserToolbarButton" aria-label="前进" onClick={() => callNav((a) => a.forward({ tabId: activeTabId!, threadId: threadScope }))} disabled={!activeTabId}>
          <Icon name="chevronRight" />
        </button>
        <button type="button" className="browserToolbarButton" aria-label="刷新" onClick={() => callNav((a) => (loading ? a.stop({ tabId: activeTabId!, threadId: threadScope }) : a.reload({ tabId: activeTabId!, threadId: threadScope })))} disabled={!activeTabId}>
          <Icon name={loading ? 'stop' : 'refresh'} />
        </button>
        <input
          className="browserAddress"
          aria-label="地址栏"
          value={address}
          onChange={(event) => setAddress(event.target.value)}
          onFocus={(event) => event.currentTarget.select()}
          onKeyDown={(event) => {
            if (event.key === 'Enter') submitAddress();
          }}
          placeholder="输入网址，Enter 打开"
        />
        <button type="button" className="browserToolbarButton" aria-label="新建标签" onClick={createTab}>
          <Icon name="plus" />
        </button>
      </div>
      <div className="browserTabStrip" role="tablist" data-testid="browserTabStrip">
        {tabs.map((tab) => (
          <button
            key={tab.tabId}
            type="button"
            role="tab"
            aria-selected={tab.tabId === activeTabId}
            className={`browserTab${tab.tabId === activeTabId ? ' active' : ''}`}
            onClick={() => activateTab(tab.tabId)}
          >
            <span className="browserTabTitle">{tab.title || tab.url || '新标签'}</span>
            <span
              className="browserTabClose"
              role="button"
              aria-label="关闭标签"
              onClick={(event) => {
                event.stopPropagation();
                closeTab(tab.tabId);
              }}
            >
              ×
            </span>
          </button>
        ))}
        {tabs.length === 0 ? (
          <button type="button" className="browserTab browserTabEmpty" onClick={createTab}>
            新建标签
          </button>
        ) : null}
      </div>
      <div className="browserViewContainer" ref={containerRef} data-testid="browserViewContainer">
        {activeTitle && tabs.length > 0 ? <span className="browserViewTitleHint">{activeTitle}</span> : null}
      </div>
    </section>
  );
}

function reportBrowserBounds(api: BrowserApi, container: HTMLDivElement | null, tabId: string | null, threadId: string): void {
  if (!container || !tabId || !threadId) return;
  const rect = container.getBoundingClientRect();
  if (rect.width < 1 || rect.height < 1) return;
  void api.setBounds({
    tabId,
    threadId,
    bounds: {
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    },
  });
}
