// 浏览器会话状态机与 storageState 序列化（架构文档 11.1 BrowserSession / 11.3 会话租约）
// — English: browser session state machine and storageState serialization
//   (architecture doc 11.1 BrowserSession / 11.3 session lease)
// state 为 starting/active/suspended/closing/closed/failed；authStatus 为
// logged_in/logged_out/unknown。首期只承诺恢复 cookies 与可序列化的 localStorage。
// — English: state is starting/active/suspended/closing/closed/failed; authStatus
//   is logged_in/logged_out/unknown. Phase 1 only promises restoring cookies and
//   serializable localStorage.
// 本模块只做纯函数状态决策与数据清洗，不含任何 Playwright / DOM 实现；
// storageState 存储层保留真实 cookie 值，脱敏发生在展示层（文档 4.4/4.6）。
// — English: pure state-machine and sanitization logic only — no Playwright/DOM;
//   the storage layer keeps real cookie values, redaction happens at the UI layer.
import type { PageGraph } from '@suanlizi/protocol';

// ─── 会话状态与认证状态 ────────────────────────────────────────────────────────
// — English: session state and auth status
export type BrowserSessionStateKind =
  | 'starting'
  | 'active'
  | 'suspended'
  | 'closing'
  | 'closed'
  | 'failed';

export type SessionAuthStatus = 'logged_in' | 'logged_out' | 'unknown';

// ─── storageState（cookies + localStorage，首期可恢复范围） ──────────────────
// — English: storageState — cookies + localStorage (phase-1 restorable scope)
// 存储层保留真实 value（会话恢复需要）；脱敏在展示层完成。
// — English: the storage layer keeps real values (needed for session restore);
//   redaction happens at the presentation layer.
export interface StorageCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires?: number; // epoch ms
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: 'Strict' | 'Lax' | 'None';
}

export interface StorageLocalStorage {
  origin: string;
  items: Array<{ key: string; value: string }>;
}

export interface StorageState {
  version: 1;
  cookies: StorageCookie[];
  localStorage: StorageLocalStorage[];
  capturedAt: number;
}

export interface BrowserSessionState {
  sessionId: string;
  taskId: string;
  state: BrowserSessionStateKind;
  authStatus: SessionAuthStatus;
  pageGraph?: PageGraph;
  storageState?: StorageState;
  createdAt: number;
  lastActiveAt: number;
}

// ─── 状态转换 ──────────────────────────────────────────────────────────────────
// 合法转换表（架构文档 11.1）：
// starting → active | failed
// active → suspended | closing | failed
// suspended → active | closing | failed
// closing → closed | failed
// closed / failed 为终态（无出边）。
// — English: legal transition table (architecture doc 11.1) — closed/failed are
//   terminal states with no outgoing edges.
const ALLOWED_TRANSITIONS: Readonly<Record<BrowserSessionStateKind, readonly BrowserSessionStateKind[]>> = {
  starting: ['active', 'failed'],
  active: ['suspended', 'closing', 'failed'],
  suspended: ['active', 'closing', 'failed'],
  closing: ['closed', 'failed'],
  closed: [],
  failed: [],
};

export function canTransitionSessionState(
  from: BrowserSessionStateKind,
  to: BrowserSessionStateKind,
): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

// 合法转换返回新对象（不可变）并更新 state；除进入 closing/closed 外同步更新
// lastActiveAt。非法转换抛 Error，错误消息包含 from -> to 描述，原对象不变。
// — English: legal transitions return a new (immutable) session and update state;
//   lastActiveAt refreshes except when entering closing/closed. Illegal
//   transitions throw an Error naming from -> to; the input object is untouched.
export function transitionSessionState(
  session: BrowserSessionState,
  to: BrowserSessionStateKind,
): BrowserSessionState {
  if (!canTransitionSessionState(session.state, to)) {
    throw new Error(`Illegal browser session state transition: ${session.state} -> ${to}`);
  }
  const refreshLastActiveAt = to !== 'closing' && to !== 'closed';
  return {
    ...session,
    state: to,
    ...(refreshLastActiveAt ? { lastActiveAt: Date.now() } : {}),
  };
}

// ─── storageState 序列化与校验 ────────────────────────────────────────────────
// — English: storageState serialization and validation
const STORAGE_STATE_VERSION = 1;

const SAME_SITE_VALUES: ReadonlySet<string> = new Set(['Strict', 'Lax', 'None']);

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// 清洗单条 cookie：name/value/domain/path 非空字符串、expires 可缺省数字、
// httpOnly/secure 可缺省布尔、sameSite 可缺省枚举；否则返回 null（条目丢弃）。
// — English: sanitize one cookie — name/value/domain/path non-empty strings,
//   optional expires number, optional httpOnly/secure booleans, optional sameSite
//   enum; otherwise null (entry dropped).
function sanitizeCookie(input: unknown): StorageCookie | null {
  if (!isRecord(input)) return null;
  const name = input.name;
  const value = input.value;
  const domain = input.domain;
  const path = input.path;
  const expires = input.expires;
  const httpOnly = input.httpOnly;
  const secure = input.secure;
  const sameSite = input.sameSite;

  if (
    !isNonEmptyString(name) ||
    !isNonEmptyString(value) ||
    !isNonEmptyString(domain) ||
    !isNonEmptyString(path)
  ) {
    return null;
  }

  const cookie: StorageCookie = { name, value, domain, path };
  if (expires !== undefined) {
    if (!isFiniteNumber(expires)) return null;
    cookie.expires = expires;
  }
  if (httpOnly !== undefined) {
    if (typeof httpOnly !== 'boolean') return null;
    cookie.httpOnly = httpOnly;
  }
  if (secure !== undefined) {
    if (typeof secure !== 'boolean') return null;
    cookie.secure = secure;
  }
  if (sameSite !== undefined) {
    if (typeof sameSite !== 'string' || !SAME_SITE_VALUES.has(sameSite)) return null;
    cookie.sameSite = sameSite as StorageCookie['sameSite'];
  }
  return cookie;
}

// 清洗单个 origin 的 localStorage：origin 非空字符串、items 必须为数组；
// 数组内非法 item（key 非空字符串、value 字符串）逐个丢弃。
// — English: sanitize one origin's localStorage — origin non-empty string, items
//   must be an array; invalid items (key non-empty string, value string) dropped.
function sanitizeLocalStorageEntry(input: unknown): StorageLocalStorage | null {
  if (!isRecord(input)) return null;
  const origin = input.origin;
  const items = input.items;
  if (!isNonEmptyString(origin) || !Array.isArray(items)) return null;

  const cleanedItems: Array<{ key: string; value: string }> = [];
  for (const item of items) {
    if (!isRecord(item)) continue;
    const key = item.key;
    const value = item.value;
    if (!isNonEmptyString(key) || typeof value !== 'string') continue;
    cleanedItems.push({ key, value });
  }
  return { origin, items: cleanedItems };
}

// 校验 storageState：非对象 / version 不符 / cookies|localStorage 非数组 /
// capturedAt 非有限数字 → null；条目级非法数据逐个丢弃并返回清洗后的对象。
// — English: validate storageState — non-object, wrong version, non-array
//   cookies|localStorage or non-finite capturedAt yield null; invalid entries are
//   dropped and a cleaned object is returned.
export function sanitizeStorageState(input: unknown): StorageState | null {
  if (!isRecord(input)) return null;
  if (input.version !== STORAGE_STATE_VERSION) return null;
  if (!Array.isArray(input.cookies) || !Array.isArray(input.localStorage)) return null;
  const capturedAt = input.capturedAt;
  if (!isFiniteNumber(capturedAt)) return null;

  const cookies: StorageCookie[] = [];
  for (const cookie of input.cookies) {
    const cleaned = sanitizeCookie(cookie);
    if (cleaned !== null) cookies.push(cleaned);
  }

  const localStorage: StorageLocalStorage[] = [];
  for (const entry of input.localStorage) {
    const cleaned = sanitizeLocalStorageEntry(entry);
    if (cleaned !== null) localStorage.push(cleaned);
  }

  return {
    version: STORAGE_STATE_VERSION,
    cookies,
    localStorage,
    capturedAt,
  };
}

// 单行 JSON 序列化（storage 层保留真实值，脱敏在展示层）。
// — English: single-line JSON serialization (real values kept for restore;
//   redaction happens at the presentation layer).
export function serializeStorageState(state: StorageState): string {
  return JSON.stringify(state);
}

// 反序列化：非法 JSON / 缺字段 / 版本不符返回 null，不抛异常；
// 条目级非法数据按 sanitizeStorageState 的清洗规则丢弃。
// — English: deserialize — invalid JSON, missing fields or version mismatch yield
//   null without throwing; invalid entries are dropped via sanitizeStorageState.
export function deserializeStorageState(raw: string): StorageState | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return sanitizeStorageState(parsed);
}

// ─── 会话摘要（Trace / UI 用，不含敏感值） ──────────────────────────────────
// cookie 只计数、localStorage 只列 origin、不暴露任何 value（文档 4.4/4.6）。
// — English: session summary for Trace/UI — cookie counts only, localStorage
//   origins only, never any value (doc 4.4/4.6).
export function summarizeSession(session: BrowserSessionState): {
  sessionId: string;
  state: BrowserSessionStateKind;
  authStatus: SessionAuthStatus;
  pageCount: number;
  cookieCount: number;
  localStorageOrigins: string[];
  activePageUrl?: string;
} {
  const graph = session.pageGraph;
  const storage = session.storageState;
  const summary: {
    sessionId: string;
    state: BrowserSessionStateKind;
    authStatus: SessionAuthStatus;
    pageCount: number;
    cookieCount: number;
    localStorageOrigins: string[];
    activePageUrl?: string;
  } = {
    sessionId: session.sessionId,
    state: session.state,
    authStatus: session.authStatus,
    pageCount: graph?.pages.length ?? 0,
    cookieCount: storage?.cookies.length ?? 0,
    localStorageOrigins: storage?.localStorage.map((entry) => entry.origin) ?? [],
  };
  if (graph !== undefined) {
    const activePage = graph.pages.find((page) => page.pageId === graph.activePageId);
    if (activePage !== undefined) {
      summary.activePageUrl = activePage.url;
    }
  }
  return summary;
}
