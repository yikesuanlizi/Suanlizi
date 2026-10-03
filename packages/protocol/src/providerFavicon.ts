/** 自定义厂商图标只按站点关联，不从模型名称猜测品牌。 */
export interface ProviderBrowserTab {
  url: string;
  title?: string;
  favicon?: string;
  visible?: boolean;
}

export function validProviderIconUrl(value: string): boolean {
  if (!value || value.length > 64 * 1024) return false;
  if (/^data:image\/(?:png|jpeg|gif|webp|x-icon|vnd\.microsoft\.icon);base64,[a-z\d+/]+={0,2}$/i.test(value)) return true;
  if (value.length > 2048) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password;
  } catch {
    return false;
  }
}

function siteHost(value: string): string | null {
  try {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return null;
    return url.hostname.toLowerCase().replace(/^(?:www|api)\./, '');
  } catch {
    return null;
  }
}

/** 只匹配同域或常见 www/api 子域；不同域名必须由用户明确选择。 */
export function matchingProviderTabFavicon(baseUrl: string, tabs: ProviderBrowserTab[]): string | null {
  const host = siteHost(baseUrl);
  if (!host) return null;
  const matching = tabs.filter((tab) => siteHost(tab.url) === host && validProviderIconUrl(tab.favicon ?? ''));
  matching.sort((a, b) => Number(Boolean(b.visible)) - Number(Boolean(a.visible)));
  return matching[0]?.favicon ?? null;
}

/** 从页面真正声明的图标 link 解析 URL；canonical 不是图标，不能当作 fallback。 */
export function pageDeclaredIconUrl(
  pageUrl: string,
  baseUri: string,
  links: ReadonlyArray<{ rel: string; href: string; type?: string }>,
): string | null {
  try {
    const page = new URL(pageUrl);
    const base = new URL(baseUri, page);
    if (!['http:', 'https:'].includes(page.protocol) || !['http:', 'https:'].includes(base.protocol)) return null;
    const candidates = links.flatMap((link, index) => {
      const rels = link.rel.toLowerCase().split(/\s+/);
      const icon = rels.includes('icon');
      // rel 可以是 shortcut icon、mask-icon、apple-touch-icon-precomposed 等；
      // 只看 rel 标记，不靠 href 文件名猜测。
      if (!rels.some((rel) => rel.includes('icon')) || !link.href.trim()) return [];
      try {
        const url = new URL(link.href.trim(), base).href;
        if (!validProviderIconUrl(url)) return [];
        // 标准 rel=icon 的 SVG 优先；其他包含 icon 的 link 按页面顺序作为备选。
        const priority = icon ? (link.type?.toLowerCase() === 'image/svg+xml' || /\.svg(?:[?#]|$)/i.test(url) ? 0 : 1) : 2;
        return [{ url, priority, index }];
      } catch {
        return [];
      }
    });
    candidates.sort((a, b) => a.priority - b.priority || a.index - b.index);
    return candidates[0]?.url ?? null;
  } catch {
    return null;
  }
}

/** UI 在未读取网页前猜出的 API origin/favicon.ico；允许被真实 Tab 图标替换。 */
export function isGuessedProviderIcon(baseUrl: string, iconUrl?: string): boolean {
  if (!iconUrl) return false;
  try {
    const base = new URL(baseUrl);
    return new URL(iconUrl).href === new URL('/favicon.ico', base.origin).href;
  } catch {
    return false;
  }
}
