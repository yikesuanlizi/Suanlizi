import type { AppDialogState } from '../../components/Dialogs.js';
import type { Locale } from '../../config/config.js';
import type { ThreadMeta } from '../../shared/types.js';
import { formatSuanliziErrorMessage } from '@suanlizi/protocol';

export const WORKSPACE_ROOTS_STORAGE_KEY = 'suanlizi.workspaceRoots.v1';
export const MAX_REMEMBERED_WORKSPACE_ROOTS = 30;

export type ThreadActivityState = 'idle' | 'running' | 'unread';

export interface WorkspaceThreadGroup {
  context: string;
  /** 只在本地记住、可被用户移除；来自当前工作区或线程的分组不允许误删。 */
  pinned?: boolean;
  label: string;
  threads: ThreadMeta[];
  workspaceRoot: string;
}

export interface PlainChatThreadGroup {
  threads: ThreadMeta[];
}

export async function pickWorkspaceRoot(): Promise<string | null> {
  const response = await fetch('/api/workspaces/pick', { method: 'POST' });
  const data = (await response.json().catch(() => ({}))) as {
    cancelled?: boolean;
    error?: string;
    workspaceRoot?: string;
  };
  if (!response.ok) {
    throw new Error(data.error ?? 'No native directory picker is available in this environment.');
  }
  const workspaceRoot = data.workspaceRoot?.trim();
  return data.cancelled || !workspaceRoot ? null : workspaceRoot;
}

/** Native directory authorization for personal knowledge sources. The picker
 * is shared with the workspace UI, but the selected directory is not attached
 * to a workspace or thread. */
export async function pickAuthorizedDirectory(): Promise<string | null> {
  return pickWorkspaceRoot();
}

export function workspacePickerStatus(locale: Locale): string {
  return locale === 'zh' ? '选择工作目录' : 'Selecting workspace';
}

export function workspacePickerNotice(locale: Locale, error: unknown): AppDialogState {
  return {
    kind: 'decision',
    title: locale === 'zh' ? '无法选择目录' : 'Cannot select directory',
    message: formatSuanliziErrorMessage(undefined, error instanceof Error ? error.message : String(error), locale),
    actionLabel: locale === 'zh' ? '知道了' : 'OK',
    cancelLabel: locale === 'zh' ? '关闭' : 'Close',
    resolve: () => {},
  };
}

export function normalizeWorkspaceRoot(value?: string | null): string {
  const trimmed = value?.trim() ?? '';
  if (!trimmed) return '';
  const stripped = trimmed.replace(/[\\/]+$/, '');
  if (!stripped && /^[\\/]+$/.test(trimmed)) return trimmed[0] === '\\' ? '\\' : '/';
  if (/^[A-Za-z]:$/.test(stripped)) return `${stripped}\\`;
  return stripped || trimmed;
}

export function workspaceKey(value: string): string {
  return normalizeWorkspaceRoot(value).replace(/\\/g, '/').toLowerCase();
}

export function workspaceLabelFromPath(value: string, locale: Locale = 'zh'): string {
  const normalized = normalizeWorkspaceRoot(value);
  if (!normalized) return locale === 'zh' ? '对话' : 'Chats';
  return normalized;
}

export function compactWorkspaceRoots(values: readonly (string | null | undefined)[]): string[] {
  const seen = new Set<string>();
  const roots: string[] = [];
  for (const value of values) {
    const normalized = normalizeWorkspaceRoot(value);
    if (!normalized) continue;
    const key = workspaceKey(normalized);
    if (seen.has(key)) continue;
    seen.add(key);
    roots.push(normalized);
  }
  return roots.slice(0, MAX_REMEMBERED_WORKSPACE_ROOTS);
}

export function readRememberedWorkspaceRoots(): string[] {
  try {
    const raw = globalThis.localStorage?.getItem(WORKSPACE_ROOTS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? compactWorkspaceRoots(parsed.filter((item): item is string => typeof item === 'string')) : [];
  } catch {
    return [];
  }
}

export function saveRememberedWorkspaceRoots(roots: readonly string[]): string[] {
  const compacted = compactWorkspaceRoots(roots);
  globalThis.localStorage?.setItem(WORKSPACE_ROOTS_STORAGE_KEY, JSON.stringify(compacted));
  return compacted;
}

export function rememberWorkspaceRoots(current: readonly string[], roots: readonly (string | null | undefined)[]): string[] {
  return saveRememberedWorkspaceRoots(compactWorkspaceRoots([...roots, ...current]));
}

export function forgetWorkspaceRoot(current: readonly string[], root: string): string[] {
  const key = workspaceKey(root);
  return saveRememberedWorkspaceRoots(current.filter((item) => workspaceKey(item) !== key));
}

/** 移除工作区时只按显式工作区线程删除；路径仅是位置数据。 */
export function threadsInWorkspace(threads: readonly ThreadMeta[], workspaceRoot: string): ThreadMeta[] {
  const target = workspaceKey(workspaceRoot);
  if (!target) return [];
  const childrenByParent = new Map<string, ThreadMeta[]>();
  for (const thread of threads) {
    const parentId = thread.parentThreadId;
    if (!parentId) continue;
    const list = childrenByParent.get(parentId) ?? [];
    list.push(thread);
    childrenByParent.set(parentId, list);
  }
  const selected = new Set<string>();
  const visit = (thread: ThreadMeta) => {
    if (selected.has(thread.threadId)) return;
    selected.add(thread.threadId);
    for (const child of childrenByParent.get(thread.threadId) ?? []) visit(child);
  };
  for (const thread of threads) {
    if (thread.hasWorkspace === false) continue;
    if (workspaceKey(thread.workspaceRoot ?? '') === target) visit(thread);
  }
  return threads.filter((thread) => selected.has(thread.threadId));
}

export function isPlainChatThread(thread: ThreadMeta): boolean {
  // hasWorkspace=false 时 workspaceRoot 只能当残留位置数据，不能再归入工作区。
  return !thread.parentThreadId
    && (thread.hasWorkspace === false
      || !normalizeWorkspaceRoot(thread.workspaceRoot)
      || thread.tags?.conversationKind === 'chat');
}

export function buildPlainChatThreads(options: {
  searchQuery?: string;
  threads: ThreadMeta[];
}): ThreadMeta[] {
  const query = (options.searchQuery ?? '').trim().toLowerCase();
  return options.threads
    .filter(isPlainChatThread)
    .filter((thread) => {
      if (!query) return true;
      return [thread.title, thread.threadId, thread.status].join('\n').toLowerCase().includes(query);
    })
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function buildWorkspaceThreadGroups(options: {
  currentWorkspaceRoot?: string;
  locale?: Locale;
  rememberedRoots?: string[];
  searchQuery?: string;
  threads: ThreadMeta[];
}): WorkspaceThreadGroup[] {
  const locale = options.locale ?? 'zh';
  const currentRoot = normalizeWorkspaceRoot(options.currentWorkspaceRoot);
  const query = (options.searchQuery ?? '').trim().toLowerCase();
  const map = new Map<string, WorkspaceThreadGroup>();
  const ensureGroup = (workspaceRoot: string): WorkspaceThreadGroup => {
    const normalized = normalizeWorkspaceRoot(workspaceRoot);
    const key = workspaceKey(normalized);
    const existing = map.get(key);
    if (existing) return existing;
    const group = {
      workspaceRoot: normalized,
      label: workspaceLabelFromPath(normalized, locale),
      context: '',
      threads: [],
    };
    map.set(key, group);
    return group;
  };

  for (const thread of options.threads) {
    if (thread.parentThreadId || isPlainChatThread(thread)) continue;
    const root = normalizeWorkspaceRoot(thread.workspaceRoot);
    if (!root) continue;
    ensureGroup(root).threads.push(thread);
  }

  for (const root of compactWorkspaceRoots([currentRoot, ...(options.rememberedRoots ?? [])])) {
    ensureGroup(root);
  }

  for (const group of map.values()) {
    group.threads.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  const pinnedKeys = new Set(compactWorkspaceRoots(options.rememberedRoots ?? []).map(workspaceKey));
  const groups = Array.from(map.values()).filter((group) => {
    if (!query) return true;
    const groupHaystack = [group.workspaceRoot, group.label, group.context].join('\n').toLowerCase();
    const matchingThreads = group.threads.filter((thread) => [
      thread.title,
      thread.threadId,
      thread.status,
    ].join('\n').toLowerCase().includes(query));
    if (groupHaystack.includes(query)) return true;
    group.threads = matchingThreads;
    return matchingThreads.length > 0;
  });

  // 当前线程切换会同步其工作区配置；不能再用 currentRoot 调整顺序，
  // 否则选中任意对话都会把整个工作区组顶到列表第一项。
  // 组顺序只由稳定的工作区名称决定，选择只改变行的 active 状态。
  for (const group of groups) group.pinned = pinnedKeys.has(workspaceKey(group.workspaceRoot));
  return groups.sort((a, b) => a.label.localeCompare(b.label));
}
