// IPC 参数校验（迁移计划 §7）：所有 handler 入口统一校验，拒绝形状不合法的输入。
// Phase 1 为最小形状校验；接入共享 Zod Schema 后这里只保留收口。
// — English: IPC arg validation (§7) — every handler entry validates its input
//   shape. Phase 1 keeps minimal shape checks; shared Zod schemas arrive later.
export interface BoundsLike {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('参数必须是对象');
  }
  return value as Record<string, unknown>;
}

export function requireString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== 'string' || value === '') {
    throw new Error(`${key} 必须为非空字符串`);
  }
  return value;
}

export function requireNumber(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${key} 必须为有限数字`);
  }
  return value;
}

export function requireBoolean(record: Record<string, unknown>, key: string): boolean {
  const value = record[key];
  if (typeof value !== 'boolean') {
    throw new Error(`${key} 必须为布尔值`);
  }
  return value;
}

export function requireBounds(value: unknown): BoundsLike {
  const record = asRecord(value);
  const bounds: BoundsLike = {
    x: requireNumber(record, 'x'),
    y: requireNumber(record, 'y'),
    width: requireNumber(record, 'width'),
    height: requireNumber(record, 'height'),
  };
  return bounds;
}

export interface CreateTabInputValidated {
  url: string;
  bounds: BoundsLike;
  openedBy?: 'user' | 'agent';
  threadId?: string;
}

export function validateCreateTab(input: unknown): CreateTabInputValidated {
  const record = asRecord(input);
  const openedBy = record.openedBy === 'user' || record.openedBy === 'agent' ? record.openedBy : undefined;
  const threadId = typeof record.threadId === 'string' && record.threadId.trim() ? record.threadId.trim() : undefined;
  return { url: requireString(record, 'url'), bounds: requireBounds(record.bounds), openedBy, threadId };
}

export interface ListTabsInput {
  threadId?: string;
}

export function validateListTabs(input: unknown): ListTabsInput {
  if (input === undefined || input === null) return {};
  const record = asRecord(input);
  return { threadId: typeof record.threadId === 'string' && record.threadId.trim() ? record.threadId.trim() : undefined };
}

export interface TabIdInput {
  tabId: string;
  threadId?: string;
}

export interface ScopedTabIdInput extends TabIdInput {
  threadId?: string;
}

export function validateTabId(input: unknown): TabIdInput {
  const record = asRecord(input);
  const threadId = typeof record.threadId === 'string' && record.threadId.trim() ? record.threadId.trim() : undefined;
  return { tabId: requireString(record, 'tabId'), threadId };
}

export function validateScopedTabId(input: unknown): ScopedTabIdInput {
  const record = asRecord(input);
  const threadId = typeof record.threadId === 'string' && record.threadId.trim() ? record.threadId.trim() : undefined;
  return { tabId: requireString(record, 'tabId'), threadId };
}

export function requireThreadScope(threadId: string | undefined): string {
  const scope = threadId?.trim();
  if (!scope) throw new Error('threadId 必须为非空字符串');
  return scope;
}

export interface TabBoundsInput extends TabIdInput {
  bounds: BoundsLike;
}

export function validateTabBounds(input: unknown): TabBoundsInput {
  const record = asRecord(input);
  const threadId = typeof record.threadId === 'string' && record.threadId.trim() ? record.threadId.trim() : undefined;
  return { tabId: requireString(record, 'tabId'), threadId, bounds: requireBounds(record.bounds) };
}

export interface TabVisibleInput extends TabIdInput {
  visible: boolean;
}

export function validateTabVisible(input: unknown): TabVisibleInput {
  const record = asRecord(input);
  const threadId = typeof record.threadId === 'string' && record.threadId.trim() ? record.threadId.trim() : undefined;
  return { tabId: requireString(record, 'tabId'), threadId, visible: requireBoolean(record, 'visible') };
}

export interface NavigateInput extends TabIdInput {
  url: string;
}

export function validateNavigate(input: unknown): NavigateInput {
  const record = asRecord(input);
  const threadId = typeof record.threadId === 'string' && record.threadId.trim() ? record.threadId.trim() : undefined;
  return { tabId: requireString(record, 'tabId'), threadId, url: requireString(record, 'url') };
}

export interface EvaluateInput extends TabIdInput {
  expression: string;
}

export function validateEvaluate(input: unknown): EvaluateInput {
  const record = asRecord(input);
  const threadId = typeof record.threadId === 'string' && record.threadId.trim() ? record.threadId.trim() : undefined;
  return { tabId: requireString(record, 'tabId'), threadId, expression: requireString(record, 'expression') };
}

export interface ClickInput extends TabIdInput {
  x: number;
  y: number;
}

export function validateClick(input: unknown): ClickInput {
  const record = asRecord(input);
  const threadId = typeof record.threadId === 'string' && record.threadId.trim() ? record.threadId.trim() : undefined;
  return { tabId: requireString(record, 'tabId'), threadId, x: requireNumber(record, 'x'), y: requireNumber(record, 'y') };
}

export interface InsertTextInput extends TabIdInput {
  text: string;
}

export function validateInsertText(input: unknown): InsertTextInput {
  const record = asRecord(input);
  const threadId = typeof record.threadId === 'string' && record.threadId.trim() ? record.threadId.trim() : undefined;
  return { tabId: requireString(record, 'tabId'), threadId, text: requireString(record, 'text') };
}
