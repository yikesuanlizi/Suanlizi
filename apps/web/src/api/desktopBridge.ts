import type { ProviderBrowserTab } from '@suanlizi/protocol';

// 标准 Web 页面没有枚举其他浏览器 Tab 的权限；由站点 favicon 回退和手动 URL 处理。
export async function listBrowserTabFavicons(_input?: { threadId?: string }): Promise<ProviderBrowserTab[]> {
  return [];
}

export async function readActiveBrowserTabFavicon(_input?: { threadId?: string; baseUrl?: string }): Promise<string | null> {
  return null;
}
