// Phase 0 最小共享类型：electron 目录不跨包依赖（CJS 边界），内联浏览器契约类型。
// Phase 3 接入 browser-runtime 时改为共享协议 Schema。
// — English: Phase 0 minimal shared types — the electron dir stays package-free
//   (CJS boundary); Phase 3 wires the shared protocol schemas.
export interface BrowserViewBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CreateBrowserTabInput {
  url: string;
  bounds: BrowserViewBounds;
  openedBy?: 'user' | 'agent';
  /** Thread scope for user-visible tabs; prevents cross-thread page reuse. */
  threadId?: string;
}

export interface BrowserTabState {
  tabId: string;
  url: string;
  title: string;
  visible: boolean;
  loading: boolean;
  openedBy?: 'user' | 'agent';
  threadId?: string;
  favicon?: string;
}

export interface BrowserNavigateInput {
  tabId: string;
  url: string;
  threadId?: string;
}

export interface BrowserEvaluateInput {
  tabId: string;
  expression: string;
  threadId?: string;
}

export interface BrowserClickInput {
  tabId: string;
  x: number;
  y: number;
  threadId?: string;
}

export type BrowserDesktopEvent =
  | { type: 'agent-browser-requested'; taskId: string }
  | { type: 'tab-created'; tabId: string; url: string; openedBy?: 'user' | 'agent'; threadId?: string }
  | { type: 'tab-closed'; tabId: string }
  | { type: 'tab-visible'; tabId: string; visible: boolean; threadId?: string }
  | { type: 'did-navigate'; tabId: string; url: string; threadId?: string }
  | { type: 'page-title'; tabId: string; title: string; threadId?: string }
  | { type: 'loading'; tabId: string; loading: boolean; threadId?: string }
  | { type: 'favicon'; tabId: string; favicon?: string }
  | { type: 'page-crashed'; tabId: string }
  | { type: 'download-started'; tabId: string; filename: string }
  | { type: 'download-progress'; tabId: string; filename: string; receivedBytes: number; totalBytes: number }
  | { type: 'download-completed'; tabId: string; filename: string }
  | { type: 'download-failed'; tabId: string; filename: string }
  | { type: 'console'; tabId: string; level: 'info' | 'warning' | 'error'; message: string };

// 桌面能力（迁移计划 Phase 1：替换 Tauri desktop_capabilities）。
// — English: desktop capabilities (Phase 1 — replaces Tauri desktop_capabilities).
export interface DesktopCapabilitiesContract {
  desktop: boolean;
  weixinBridge: {
    managedAvailable: boolean;
    rpcUrl: string;
    reason?: string;
  };
}

// 窗口控制状态事件（TitleBar 最大最小化图标）。
// — English: window-control state events (TitleBar maximize icon).
export interface WindowControlEvent {
  maximized: boolean;
}
