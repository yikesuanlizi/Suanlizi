// 热上下文紧凑化：把页面观测压缩为 LLM 热上下文可注入的最小表示。
// 设计依据：架构文档 13.1 上下文分层 —— 热上下文优先保留元素引用表、关键事实、
// 来源与验证结果；页面原文不无限追加，超出容量直接截断丢弃。
// 安全边界：13.2 凭证永不进入上下文 —— 本模块只投影观测中的
// ref/role/name/text/enabled 与页面级元数据；Observation 无 value 字段，
// 元素内部字段（frameId/fingerprint）与内容 provenance 一律不注入。
// — English: hot-context sliming — compress page observations into the minimal
//   representation injectable into the LLM hot context. Architecture doc §13.1
//   context layering: the hot context keeps element refs, key facts, sources
//   and verification results; raw page text is never appended unbounded — it is
//   truncated and dropped past capacity. Security boundary §13.2: credentials
//   never enter context — only ref/role/name/text/enabled plus page-level
//   metadata are projected; Observation has no value field, and internal element
//   fields (frameId/fingerprint) as well as content provenance are never injected.
// 本模块为纯函数实现，不含任何 DOM / 浏览器实现。
import type {
  ActionRecord,
  BrowserTaskEvent,
  ClassifiedError,
  Observation,
} from '@suanlizi/protocol';
import { stripSensitiveUrl } from './urlSafe.js';

// 默认容量：元素引用表 30、内容块 10、单块 200 字符
// — English: default capacities — 30 element refs, 10 content blocks, 200 chars per block
const DEFAULT_MAX_ELEMENTS = 30;
const DEFAULT_MAX_CONTENT_BLOCKS = 10;
const DEFAULT_MAX_BLOCK_CHARS = 200;
// 元素单行文本硬上限（契约固定 80）
// — English: hard cap for a single element text line (fixed at 80 by contract)
const MAX_ELEMENT_TEXT_CHARS = 80;

export interface SlimContextOptions {
  maxElements?: number; // 默认 30（元素引用表上限）
  maxContentBlocks?: number; // 默认 10（内容块上限）
  maxBlockChars?: number; // 默认 200（单块文本截断）
}

export interface SlimElement {
  ref: string;
  role?: string;
  name?: string;
  text?: string;
  enabled: boolean;
}

export interface SlimContextState {
  pageId: string;
  url: string;
  title: string;
  navigationEpoch: number;
  readiness: string;
  elements: SlimElement[]; // [eN] 引用表（观测顺序、截断到 maxElements）
  content: string[]; // 内容块文本（截断到 maxContentBlocks × maxBlockChars）
  flags: { captchaDetected: boolean; authRequired: boolean };
  provenance: { trust: string; source: string }; // 页面内容永远 untrusted/dom
}

// 压平为单行：换行与连续空白 → 单个空格
// — English: flatten to a single line — newlines and whitespace runs → one space
function flatten(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

// 截断并追加省略号
// — English: truncate and append an ellipsis
function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + '…';
}

/**
 * 构建紧凑上下文状态：元素只保留可见（obs.elements 上游已过滤可见，此处再防御性
 * 过滤）中的 ref/role/name/text/enabled，text 截断到 80 字符；内容块文本截断；
 * flags 透传；provenance 恒为 { trust:'untrusted', source:'dom' }。
 * — English: builds the slim context state — only visible elements are kept
 *   (obs.elements is pre-filtered upstream; a defensive filter is applied here),
 *   projecting ref/role/name/text/enabled with text truncated to 80 chars;
 *   content blocks are truncated; flags pass through; provenance is always
 *   { trust:'untrusted', source:'dom' }.
 */
export function buildSlimContextState(
  obs: Observation,
  opts: SlimContextOptions = {},
): SlimContextState {
  const maxElements = opts.maxElements ?? DEFAULT_MAX_ELEMENTS;
  const maxContentBlocks = opts.maxContentBlocks ?? DEFAULT_MAX_CONTENT_BLOCKS;
  const maxBlockChars = opts.maxBlockChars ?? DEFAULT_MAX_BLOCK_CHARS;

  const elements: SlimElement[] = obs.elements
    .filter((element) => element.visible)
    .slice(0, maxElements)
    .map((element) => ({
      ref: element.ref,
      role: element.role,
      name: element.name,
      text:
        element.text === undefined
          ? undefined
          : truncate(flatten(element.text), MAX_ELEMENT_TEXT_CHARS),
      enabled: element.enabled,
    }));

  const content: string[] = obs.mainContent
    .slice(0, maxContentBlocks)
    .map((block) => truncate(flatten(block.text), maxBlockChars));

  return {
    pageId: obs.pageId,
    // 页面 URL 可能携带 code/token 查询参数，进入 LLM 上下文前必须清洗（13.2 凭证规则）。
    // — English: page URLs may carry code/token query params — sanitize before
    //   entering the LLM context (§13.2 credential rules).
    url: stripSensitiveUrl(obs.url) ?? '',
    title: obs.title,
    navigationEpoch: obs.navigationEpoch,
    readiness: obs.readiness,
    elements,
    content,
    flags: {
      captchaDetected: obs.pageState.captchaDetected,
      authRequired: obs.pageState.authRequired,
    },
    // 页面内容一律视为不可信 DOM 数据（架构文档 13.2）
    // — English: page content is always untrusted DOM data (architecture doc §13.2)
    provenance: { trust: 'untrusted', source: 'dom' },
  };
}

/**
 * 紧凑单行文本（LLM 热上下文注入用）：
 * [page] <url> | <title> | epoch=<n> | readiness=<r> | captcha=<0|1> auth=<0|1>
 * [elements] <count> + 每元素一行（ref + role + name + text + 可选“（禁用）”）
 * [content] <blockCount> + 每块一行；无元素/无内容时整段省略。
 * — English: single-line compact text for LLM hot-context injection — a [page]
 *   line, an [elements] section (one line per element: ref + role + name + text
 *   plus an optional “（禁用）” disabled marker) and a [content] section; empty
 *   sections are omitted entirely.
 */
export function slimObservationContext(
  obs: Observation,
  opts: SlimContextOptions = {},
): string {
  const state = buildSlimContextState(obs, opts);
  const lines: string[] = [
    `[page] ${state.url} | ${state.title} | epoch=${state.navigationEpoch} | readiness=${state.readiness} | captcha=${state.flags.captchaDetected ? 1 : 0} auth=${state.flags.authRequired ? 1 : 0}`,
  ];

  if (state.elements.length > 0) {
    lines.push(`[elements] ${state.elements.length}`);
    for (const element of state.elements) {
      const line =
        element.ref +
        (element.role ? ` ${element.role}` : '') +
        (element.name ? ` ${element.name}` : '') +
        (element.text ? ` ${element.text}` : '') +
        (element.enabled ? '' : ' （禁用）');
      lines.push(`  ${line}`);
    }
  }

  if (state.content.length > 0) {
    lines.push(`[content] ${state.content.length}`);
    for (const block of state.content) {
      lines.push(`  ${block}`);
    }
  }

  return lines.join('\n');
}

/**
 * 最近动作历史摘要（温上下文）：把 action.prepared / action.completed 事件按
 * actionId 配对为单行摘要；无 completed 显示 '→ running'；取最近 max 条。
 * — English: recent action history summary (warm context) — pairs
 *   action.prepared / action.completed events by actionId into one-line
 *   summaries; missing completed shows '→ running'; keeps the most recent max.
 */
export function slimHistory(
  events: ReadonlyArray<BrowserTaskEvent>,
  max = 6,
): string[] {
  // actionId → { kind, outcome? }；Map 保持 prepared 出现顺序
  // — English: actionId → { kind, outcome? }; Map preserves prepared order
  const byAction = new Map<
    string,
    { kind: string; outcome?: 'committed' | 'uncertain' | 'failed' }
  >();
  for (const event of events) {
    if (event.type === 'action.prepared') {
      // 协议 1.7 的 ActionRecord 未携带 kind 字段；按契约从 record.kind 读取，
      // 缺失时回退 'unknown'
      // — English: ActionRecord in protocol 1.7 carries no kind field; read
      //   record.kind per contract, falling back to 'unknown'
      const record = event.record as ActionRecord & { kind?: string };
      byAction.set(record.actionId, { kind: record.kind ?? 'unknown' });
    } else if (event.type === 'action.completed') {
      const entry = byAction.get(event.actionId);
      if (entry) entry.outcome = event.outcome;
    }
  }

  const lines: string[] = [];
  for (const [actionId, entry] of byAction) {
    lines.push(`${actionId} ${entry.kind} → ${entry.outcome ?? 'running'}`);
  }
  return lines.slice(-max);
}

/**
 * 未解决风险与错误摘要：每行 `[<kind>] <code>: <message>`；取最近 max 条；
 * 无错误返回空数组。
 * — English: unresolved risk and error summary — one line per error in the form
 *   `[<kind>] <code>: <message>`; keeps the most recent max; empty input → [].
 */
export function slimErrors(
  errors: ReadonlyArray<ClassifiedError>,
  max = 3,
): string[] {
  return errors.slice(-max).map((error) => `[${error.kind}] ${error.code}: ${error.message}`);
}
