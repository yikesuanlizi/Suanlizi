import { matchingProviderTabFavicon, validProviderIconUrl, type ProviderBrowserTab } from '@suanlizi/protocol';
// 桌面桥（迁移计划 Phase 1）：从 Tauri invoke 切换到 Electron preload typed API
// （window.suanliziDesktop）。Web 环境无 preload 时保持原有降级语义。
// — English: desktop bridge (Phase 1) — switched from Tauri invoke to the Electron
//   preload typed API (window.suanliziDesktop). The old fallback semantics remain in
//   web environments where the preload is absent.
export interface DesktopCapabilities {
  desktop: boolean;
  weixinBridge: {
    managedAvailable: boolean;
    rpcUrl: string;
    reason?: 'not_bundled' | 'unsupported' | string;
  };
}

// preload 暴露的 typed API 结构（与 electron/preload/index.ts 的 SuanliziDesktopApi 对应；
// electron 目录是独立 CJS 编译边界，这里保持局部结构类型）。
// — English: the preload-exposed typed API shape (mirrors SuanliziDesktopApi in
//   electron/preload/index.ts; the electron dir is a separate CJS build boundary,
//   so the shape is declared locally).
interface DesktopBrowserTab extends ProviderBrowserTab {}

interface DesktopBrowserBridge {
  subscribe?(handler: (event: { type: string; favicon?: string }) => void): () => void;
  listTabs?(input?: { threadId?: string }): Promise<DesktopBrowserTab[]>;
}

interface SuanliziDesktopBridge {
  desktop?: {
    capabilities?(): Promise<DesktopCapabilities>;
    openPath?(path: string): Promise<boolean>;
    showItemInFolder?(path: string): Promise<void>;
  };
  browser?: DesktopBrowserBridge;
}

declare global {
  interface Window {
    suanliziDesktop?: SuanliziDesktopBridge;
  }
}

// 向桌面端（Electron Main）查询能力信息：当前环境是否为桌面端、微信桥接是否可用等。
// — English: queries the desktop side (Electron Main) for capabilities.
export async function readDesktopCapabilities(): Promise<DesktopCapabilities> {
  const desktopApi = window.suanliziDesktop?.desktop;
  if (!desktopApi?.capabilities) return fallbackCapabilities('unsupported');
  try {
    return await desktopApi.capabilities();
  } catch {
    return fallbackCapabilities('unsupported');
  }
}

// 构造一个表示"当前环境不具备桌面端能力"的 fallback 对象。
// — English: builds a fallback object for "no desktop capabilities in this environment".
function fallbackCapabilities(reason: DesktopCapabilities['weixinBridge']['reason']): DesktopCapabilities {
  return {
    desktop: false,
    weixinBridge: {
      managedAvailable: false,
      rpcUrl: '',
      reason,
    },
  };
}

/**
 * 在系统默认编辑器中打开文件（或目录）。
 * 仅桌面端（Electron Main）可用，Web 端调用返回 false。
 * — English: open a file (or directory) in the system default editor.
 * Only available on desktop (Electron Main); returns false on web.
 */
export async function openInSystemEditor(filePath: string): Promise<boolean> {
  const openPath = window.suanliziDesktop?.desktop?.openPath;
  if (!openPath) return false;
  try {
    return await openPath(filePath);
  } catch {
    return false;
  }
}

/** 在系统文件管理器中显示并选中目标文件（或打开目标目录）。 */
export async function showItemInSystemFolder(filePath: string): Promise<boolean> {
  const showItemInFolder = window.suanliziDesktop?.desktop?.showItemInFolder;
  if (!showItemInFolder) return false;
  try {
    await showItemInFolder(filePath);
    return true;
  } catch {
    return false;
  }
}


/** 列出当前线程内有安全 favicon 的 Tab，供用户明确选择跨站点图标。 */
export async function listBrowserTabFavicons(input?: { threadId?: string }): Promise<ProviderBrowserTab[]> {
  const listTabs = window.suanliziDesktop?.browser?.listTabs;
  if (!listTabs) return [];
  try {
    const threadId = input?.threadId?.trim();
    if (!threadId) return [];
    const tabs = await listTabs({ threadId });
    return tabs.filter((tab) => validProviderIconUrl(tab.favicon ?? '') && /^https?:\/\//.test(tab.url));
  } catch {
    return [];
  }
}

/** 自动关联仅使用与厂商 API 地址同站点的内置浏览器 Tab。 */
export async function readActiveBrowserTabFavicon(input?: { threadId?: string; baseUrl?: string }): Promise<string | null> {
  if (!input?.baseUrl) return null;
  return matchingProviderTabFavicon(input.baseUrl, await listBrowserTabFavicons(input));
}
