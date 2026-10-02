export type WebProviderId = 'native_fetch' | 'firecrawl';

export interface WebProviderCapabilities {
  search: boolean;
  openPage: boolean;
  findInPage: boolean;
  dynamicRender?: boolean;
}

export interface WebSearchRequest {
  query: string;
  maxResults?: number;
  signal?: AbortSignal;
}

export interface WebOpenPageRequest {
  url: string;
  signal?: AbortSignal;
}

export interface WebFindInPageRequest extends WebOpenPageRequest {
  pattern: string;
}

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
  provider: WebProviderId;
}

export interface WebPageResult {
  provider: WebProviderId;
  url: string;
  finalUrl?: string;
  status?: number;
  statusText?: string;
  contentType?: string;
  title?: string;
  text: string;
  truncated: boolean;
  metadata?: Record<string, unknown>;
}

export interface WebFindResult {
  provider: WebProviderId;
  url: string;
  title?: string;
  matches: Array<{ line: string; lineNumber: number }>;
}

export interface WebProvider {
  id: WebProviderId;
  capabilities: WebProviderCapabilities;
  search?(request: WebSearchRequest): Promise<WebSearchResult[]>;
  openPage?(request: WebOpenPageRequest): Promise<WebPageResult>;
  findInPage?(request: WebFindInPageRequest): Promise<WebFindResult>;
}

export interface FirecrawlProviderOptions {
  apiKey?: string;
  baseUrl?: string;
}

export interface WebProviderRouterOptions {
  provider?: 'native' | 'native_fetch' | 'firecrawl';
  firecrawl?: FirecrawlProviderOptions;
}

const DEFAULT_MAX_PAGE_CHARS = 16_000;

export class NativeFetchWebProvider implements WebProvider {
  readonly id = 'native_fetch' as const;
  readonly capabilities = { search: true, openPage: true, findInPage: true };

  async search(request: WebSearchRequest): Promise<WebSearchResult[]> {
    const maxResults = normalizeMaxResults(request.maxResults);
    const failures: string[] = [];
    for (const source of SEARCH_SOURCES) {
      try {
        const response = await fetch(source.url(request.query), {
          headers: {
            'user-agent': 'Mozilla/5.0 Suanlizi/0.1',
            accept: 'text/html,application/xhtml+xml',
          },
          signal: request.signal,
        });
        if (!response.ok) {
          throw new Error(`HTTP ${response.status} ${response.statusText}`.trim());
        }
        const html = await response.text();
        const results = source.parse(html).map((result) => ({ ...result, provider: this.id }));
        if (results.length > 0) return dedupeSearchResults(results).slice(0, maxResults);
        failures.push(`${source.name}: no results parsed`);
      } catch (err) {
        failures.push(`${source.name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (failures.length > 0) throw new Error(failures.join('; '));
    return [];
  }

  async openPage(request: WebOpenPageRequest): Promise<WebPageResult> {
    const url = parsePublicHttpUrl(request.url);
    const response = await fetch(url.toString(), {
      headers: {
        'user-agent': 'Mozilla/5.0 Suanlizi/0.1',
        accept: 'text/html,application/xhtml+xml,text/plain,text/markdown,application/json;q=0.9,*/*;q=0.5',
      },
      signal: request.signal,
    });
    const contentType = response.headers.get('content-type') ?? '';
    const body = await response.text();
    const extracted = extractReadableText(body, contentType);
    const limited = limitText(extracted.text, DEFAULT_MAX_PAGE_CHARS);
    return {
      provider: this.id,
      url: url.toString(),
      finalUrl: response.url || url.toString(),
      status: response.status,
      statusText: response.statusText,
      contentType,
      title: extracted.title,
      text: limited.text,
      truncated: limited.truncated,
    };
  }
}

export class FirecrawlWebProvider implements WebProvider {
  readonly id = 'firecrawl' as const;
  readonly capabilities = { search: true, openPage: true, findInPage: true, dynamicRender: true };
  private readonly apiKey?: string;
  private readonly baseUrl: string;

  constructor(options: FirecrawlProviderOptions = {}) {
    this.apiKey = options.apiKey;
    this.baseUrl = stripTrailingSlash(options.baseUrl ?? 'https://api.firecrawl.dev');
  }

  async search(request: WebSearchRequest): Promise<WebSearchResult[]> {
    this.requireApiKey();
    const maxResults = normalizeMaxResults(request.maxResults);
    const json = await this.postJson('/v1/search', {
      query: request.query,
      limit: maxResults,
      scrapeOptions: { formats: ['markdown'], onlyMainContent: true },
    }, request.signal);
    const data = Array.isArray(json.data) ? json.data : Array.isArray(json.results) ? json.results : [];
    return data.flatMap((entry: unknown) => {
      if (!entry || typeof entry !== 'object') return [];
      const record = entry as Record<string, unknown>;
      const title = stringValue(record.title) || stringValue(record.name) || stringValue(record.url);
      const url = stringValue(record.url) || stringValue(record.sourceURL);
      if (!title || !url) return [];
      return [{
        title,
        url,
        snippet: stringValue(record.description) || stringValue(record.snippet) || stringValue(record.markdown),
        provider: this.id,
      }];
    });
  }

  async openPage(request: WebOpenPageRequest): Promise<WebPageResult> {
    this.requireApiKey();
    const url = parsePublicHttpUrl(request.url);
    const json = await this.postJson('/v1/scrape', {
      url: url.toString(),
      formats: ['markdown'],
      onlyMainContent: true,
    }, request.signal);
    const data = objectValue(json.data) ?? json;
    const metadata = objectValue(data.metadata) ?? objectValue(data.metadataJson) ?? {};
    const text = stringValue(data.markdown) || stringValue(data.content) || stringValue(data.text) || '';
    const limited = limitText(text.trim(), DEFAULT_MAX_PAGE_CHARS);
    return {
      provider: this.id,
      url: url.toString(),
      finalUrl: stringValue(metadata.sourceURL) || stringValue(metadata.url),
      status: typeof data.statusCode === 'number' ? data.statusCode : undefined,
      contentType: stringValue(metadata.contentType),
      title: stringValue(metadata.title) || stringValue(data.title),
      text: limited.text,
      truncated: limited.truncated,
      metadata,
    };
  }

  private async postJson(path: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
      signal,
    });
    let json: unknown;
    try {
      json = await response.json();
    } catch {
      json = {};
    }
    if (!response.ok) {
      const message = objectValue(json)?.error ?? objectValue(json)?.message ?? response.statusText;
      throw new Error(`Firecrawl failed: HTTP ${response.status} ${String(message)}`.trim());
    }
    return objectValue(json) ?? {};
  }

  private requireApiKey(): void {
    if (!this.apiKey) throw new Error('Firecrawl API key is required');
  }
}

export class WebProviderRouter {
  private readonly native: NativeFetchWebProvider;
  private readonly firecrawl: FirecrawlWebProvider;
  private readonly provider: NonNullable<WebProviderRouterOptions['provider']>;

  constructor(options: WebProviderRouterOptions = {}) {
    this.provider = options.provider ?? 'native_fetch';
    this.native = new NativeFetchWebProvider();
    this.firecrawl = new FirecrawlWebProvider(options.firecrawl);
  }

  async search(request: WebSearchRequest): Promise<WebSearchResult[]> {
    return this.selectedProvider('search').search!(request);
  }

  async openPage(request: WebOpenPageRequest): Promise<WebPageResult> {
    return this.selectedProvider('openPage').openPage!(request);
  }

  async findInPage(request: WebFindInPageRequest): Promise<WebFindResult> {
    const page = await this.openPage(request);
    const matches = findLines(page.text, request.pattern);
    return {
      provider: page.provider,
      url: page.finalUrl ?? page.url,
      title: page.title,
      matches,
    };
  }

  private selectedProvider(capability: keyof WebProviderCapabilities): WebProvider {
    const provider = this.provider;
    if (provider === 'firecrawl') return this.ensureCapability(this.firecrawl, capability);
    return this.ensureCapability(this.native, capability);
  }

  private ensureCapability(provider: WebProvider, capability: keyof WebProviderCapabilities): WebProvider {
    if (!provider.capabilities[capability]) {
      throw new Error(`Web provider ${provider.id} does not support ${String(capability)}`);
    }
    return provider;
  }
}

export function extractReadableText(raw: string, contentType: string | undefined): { title?: string; text: string } {
  if (!contentType?.toLowerCase().includes('html') && !looksLikeHtml(raw)) {
    return { text: raw.trim() };
  }
  const title = extractHtmlTitle(raw);
  const withoutNoise = raw
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<svg\b[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<template\b[\s\S]*?<\/template>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ');
  const withBreaks = withoutNoise
    .replace(/<(?:br|hr)\b[^>]*>/gi, '\n')
    .replace(/<\/(?:p|div|section|article|header|footer|main|aside|li|tr|h[1-6])>/gi, '\n');
  return {
    title,
    text: decodeHtml(withBreaks.replace(/<[^>]*>/g, ' '))
      .split('\n')
      .map((line) => line.replace(/[ \t]+/g, ' ').replace(/\s+([.,!?;:])/g, '$1').trim())
      .filter(Boolean)
      .join('\n'),
  };
}

function parsePublicHttpUrl(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error('url must be a valid HTTP/HTTPS URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('only http and https URLs are supported');
  }
  if (isPrivateOrLocalHostname(url.hostname)) {
    throw new Error('private or local URLs are blocked for web access');
  }
  return url;
}

function isPrivateOrLocalHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true;
  if (host === '::1' || host === '0:0:0:0:0:0:0:1' || host === 'fc00::' || host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80:')) return true;
  const parts = host.split('.').map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b, c, d] = parts;
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 100 && b === 100 && c === 100 && d === 200) return true;
  return false;
}

interface SearchSource {
  name: string;
  url: (query: string) => string;
  parse: (html: string) => Array<Omit<WebSearchResult, 'provider'>>;
}

const SEARCH_SOURCES: SearchSource[] = [
  {
    name: 'DuckDuckGo',
    url: (query) => `https://duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
    parse: parseDuckDuckGoResults,
  },
  {
    name: 'Bing',
    url: (query) => `https://www.bing.com/search?q=${encodeURIComponent(query)}`,
    parse: parseBingResults,
  },
];

function parseDuckDuckGoResults(html: string): Array<Omit<WebSearchResult, 'provider'>> {
  const results: Array<Omit<WebSearchResult, 'provider'>> = [];
  const blockRegex = /<div[^>]+class="[^"]*\bresult\b[^"]*"[^>]*>([\s\S]*?)(?=<div[^>]+class="[^"]*\bresult\b|<\/body>|$)/gi;
  const fallbackRegex = /<a[^>]+class="[^"]*\bresult__a\b[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:<(?:a|div)[^>]+class="[^"]*\bresult__snippet\b[^"]*"[^>]*>([\s\S]*?)<\/(?:a|div)>|$)/gi;
  for (const match of html.matchAll(blockRegex)) {
    const block = match[1] ?? '';
    const linkMatch = block.match(/<a[^>]+class="[^"]*\bresult__a\b[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!linkMatch) continue;
    const snippetMatch = block.match(/<(?:a|div)[^>]+class="[^"]*\bresult__snippet\b[^"]*"[^>]*>([\s\S]*?)<\/(?:a|div)>/i);
    const result = normalizeSearchResult(linkMatch[2] ?? '', linkMatch[1] ?? '', snippetMatch?.[1] ?? '');
    if (result) results.push(result);
  }
  if (results.length > 0) return dedupeSearchResults(results);
  for (const match of html.matchAll(fallbackRegex)) {
    const result = normalizeSearchResult(match[2] ?? '', match[1] ?? '', match[3] ?? '');
    if (result) results.push(result);
  }
  return dedupeSearchResults(results);
}

function parseBingResults(html: string): Array<Omit<WebSearchResult, 'provider'>> {
  const results: Array<Omit<WebSearchResult, 'provider'>> = [];
  const blockRegex = /<li[^>]+class="[^"]*\bb_algo\b[^"]*"[^>]*>([\s\S]*?)(?=<li[^>]+class="[^"]*\bb_algo\b|<\/ol>|$)/gi;
  for (const match of html.matchAll(blockRegex)) {
    const block = match[1] ?? '';
    const linkMatch = block.match(/<h2[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>\s*<\/h2>/i);
    if (!linkMatch) continue;
    const snippetMatch = block.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
    const result = normalizeSearchResult(linkMatch[2] ?? '', linkMatch[1] ?? '', snippetMatch?.[1] ?? '');
    if (result) results.push(result);
  }
  return dedupeSearchResults(results);
}

function normalizeSearchResult(titleHtml: string, urlHtml: string, snippetHtml: string): Omit<WebSearchResult, 'provider'> | null {
  const title = cleanHtml(titleHtml);
  const url = normalizeDuckDuckGoUrl(decodeHtml(urlHtml));
  const snippet = cleanHtml(snippetHtml);
  if (!title || !url) return null;
  return { title, url, snippet };
}

function findLines(text: string, pattern: string): Array<{ line: string; lineNumber: number }> {
  const needle = pattern.toLowerCase();
  return text
    .split('\n')
    .map((line, index) => ({ line, lineNumber: index + 1 }))
    .filter((entry) => entry.line.toLowerCase().includes(needle))
    .slice(0, 20);
}

function normalizeMaxResults(value: number | undefined): number {
  return Number.isFinite(value) ? Math.min(8, Math.max(1, Math.floor(value ?? 5))) : 5;
}

function extractHtmlTitle(html: string): string | undefined {
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
  const cleaned = title ? cleanHtml(title) : '';
  return cleaned || undefined;
}

function looksLikeHtml(value: string): boolean {
  const lower = value.slice(0, 1000).toLowerCase();
  return lower.includes('<!doctype html') || lower.includes('<html') || lower.includes('<body');
}

function limitText(text: string, maxLength: number): { text: string; truncated: boolean } {
  if (text.length <= maxLength) return { text, truncated: false };
  return { text: `${text.slice(0, maxLength)}\n... [truncated ${text.length - maxLength} chars]`, truncated: true };
}

function cleanHtml(value: string): string {
  return decodeHtml(value.replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .replace(/\s+([.,!?;:])/g, '$1')
    .trim();
}

function decodeHtml(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number.parseInt(code, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&ensp;/g, ' ')
    .replace(/&emsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function normalizeDuckDuckGoUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl.startsWith('//') ? `https:${rawUrl}` : rawUrl, 'https://duckduckgo.com');
    const redirected = url.searchParams.get('uddg');
    return redirected ? decodeURIComponent(redirected) : url.toString();
  } catch {
    return rawUrl;
  }
}

function dedupeSearchResults<T extends { url: string }>(results: T[]): T[] {
  const seen = new Set<string>();
  return results.filter((result) => {
    if (seen.has(result.url)) return false;
    seen.add(result.url);
    return true;
  });
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
