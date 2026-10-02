/**
 * Lexical Wiki search adapted from atomicstrata/llm-wiki-compiler.
 *
 * Source: src/viewer/search.ts at commit 3e17bcfe8b50f24c14c6bcda0cb9224d94fd8206
 * Repository: https://github.com/atomicstrata/llm-wiki-compiler
 * License: MIT (see packages/wiki-core/LICENSE-THIRD-PARTY.md)
 *
 * Only the viewer's pure title/body search was extracted. The compiler's
 * embeddings, vector stores, semantic retrieval and provider integrations are
 * intentionally excluded from Suanlizi.
 */

const MAX_QUERY_LENGTH = 200;
const MAX_RESULTS = 50;
const SNIPPET_RADIUS = 60;
const SNIPPET_ELLIPSIS = '…';

export type WikiSearchMatch = 'title' | 'body';

export interface WikiSearchPage {
  id: string;
  title: string;
  body: string;
  /** Stable secondary ordering key, usually relative path + chunk ordinal. */
  sortKey?: string;
}

export interface WikiSearchResult {
  id: string;
  title: string;
  snippet: string;
  matchedIn: WikiSearchMatch;
  /** Number of query-token occurrences, with title matches weighted first. */
  score: number;
  sortKey?: string;
}

export function tokenizeWikiQuery(rawQuery: string): string[] {
  if (typeof rawQuery !== 'string') return [];
  const trimmed = rawQuery.trim();
  if (trimmed.length === 0) return [];
  return trimmed.slice(0, MAX_QUERY_LENGTH).toLowerCase().split(/\s+/).filter(Boolean);
}

/**
 * Search a frozen page/chunk collection using the pulled Wiki viewer
 * semantics: whitespace tokenization, multi-token AND, title priority, stable
 * ordering and cleaned inline-Markdown snippets.
 */
export function searchWikiPages(
  pages: ReadonlyArray<WikiSearchPage>,
  rawQuery: string,
): { results: WikiSearchResult[] } {
  const tokens = tokenizeWikiQuery(rawQuery);
  if (tokens.length === 0) return { results: [] };
  const matches: WikiSearchResult[] = [];
  for (const page of pages) {
    const result = matchPage(page, tokens);
    if (result) matches.push(result);
  }
  matches.sort(compareResults);
  return { results: matches.slice(0, MAX_RESULTS) };
}

function matchPage(page: WikiSearchPage, tokens: string[]): WikiSearchResult | null {
  const titleLower = page.title.toLowerCase();
  const bodyLower = page.body.toLowerCase();
  for (const token of tokens) {
    if (!titleLower.includes(token) && !bodyLower.includes(token)) return null;
  }
  const allInTitle = tokens.every((token) => titleLower.includes(token));
  const matchedIn: WikiSearchMatch = allInTitle ? 'title' : 'body';
  const snippet = allInTitle
    ? page.title
    : buildBodySnippet(page.body, bodyLower, tokens);
  const score = tokens.reduce(
    (total, token) => total + countOccurrences(allInTitle ? titleLower : bodyLower, token),
    0,
  );
  return {
    id: page.id,
    title: page.title,
    snippet,
    matchedIn,
    score: allInTitle ? score + tokens.length : score,
    ...(page.sortKey !== undefined ? { sortKey: page.sortKey } : {}),
  };
}

function countOccurrences(text: string, token: string): number {
  let count = 0;
  let offset = 0;
  while (offset < text.length) {
    const index = text.indexOf(token, offset);
    if (index < 0) break;
    count += 1;
    offset = index + Math.max(token.length, 1);
  }
  return count;
}

function buildBodySnippet(body: string, bodyLower: string, tokens: string[]): string {
  const matchPos = earliestTokenPosition(bodyLower, tokens);
  const start = Math.max(0, matchPos - SNIPPET_RADIUS);
  const end = Math.min(body.length, matchPos + SNIPPET_RADIUS);
  const cleaned = stripInlineMarkdownNoise(body.slice(start, end)).replace(/\s+/g, ' ').trim();
  const prefix = start > 0 ? SNIPPET_ELLIPSIS : '';
  const suffix = end < body.length ? SNIPPET_ELLIPSIS : '';
  return `${prefix}${cleaned}${suffix}`;
}

function stripInlineMarkdownNoise(text: string): string {
  return text
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\[\[([^\]|\n]+)\|([^\]\n]+)\]\]/g, '$2')
    .replace(/\[\[([^\]\n]+)\]\]/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/(?<!\w)\*([^*\n]+)\*(?!\w)/g, '$1')
    .replace(/(?<!\w)_([^_\n]+)_(?!\w)/g, '$1')
    .replace(/`([^`\n]+)`/g, '$1')
    .replace(/~~([^~\n]+)~~/g, '$1');
}

function earliestTokenPosition(bodyLower: string, tokens: string[]): number {
  let earliest = bodyLower.length;
  for (const token of tokens) {
    const index = bodyLower.indexOf(token);
    if (index >= 0 && index < earliest) earliest = index;
  }
  return earliest;
}

function compareResults(a: WikiSearchResult, b: WikiSearchResult): number {
  if (a.matchedIn !== b.matchedIn) return a.matchedIn === 'title' ? -1 : 1;
  if (a.matchedIn === 'body' && a.score !== b.score) return b.score - a.score;
  return (a.sortKey ?? a.title).localeCompare(b.sortKey ?? b.title);
}
