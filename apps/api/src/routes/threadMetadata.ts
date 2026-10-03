import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ThreadId, ThreadMeta, ThreadMode, ThreadTaskPreset } from '@suanlizi/protocol';
import type { ThreadStore } from '@suanlizi/storage';
import { readJson, sendError, sendJson } from '../shared/http.js';

// 规范化线程标题（空字符串、非字符串或空内容返回 null）
// — Chinese: normalize thread title patch (null if not a valid string)
export function normalizeThreadTitlePatch(body: { title?: unknown }): string | null {
  if (typeof body.title !== 'string') return null;
  const title = body.title.trim();
  return title.length > 0 ? title : null;
}

// 规范化线程标签（必须是 Record<string, string>，否则返回 null）
// — Chinese: normalize thread tags patch (must be Record<string, string> or null)
function normalizeThreadTagsPatch(body: { tags?: unknown }): Record<string, string> | null {
  if (!body.tags || typeof body.tags !== 'object' || Array.isArray(body.tags)) return null;
  const tags: Record<string, string> = {};
  for (const [key, value] of Object.entries(body.tags)) {
    if (typeof value === 'string') {
      tags[key] = value;
    }
  }
  return tags;
}

// 更新线程标题，返回更新后的线程元信息（若线程不存在则返回 null）
// — Chinese: update thread title and return updated thread meta (null if missing)
export async function updateThreadTitle(store: ThreadStore, threadId: ThreadId, title: string): Promise<ThreadMeta | null> {
  const thread = await store.getThread(threadId);
  if (!thread) return null;
  await store.updateThreadMetadata(threadId, { title });
  return store.getThread(threadId);
}

// 处理 PATCH /api/threads/:id — 更新线程标题和/或标签
// — Chinese: handle PATCH /api/threads/:id — update thread title and/or tags
export async function handlePatchThread(req: IncomingMessage, res: ServerResponse, store: ThreadStore, threadId: ThreadId): Promise<void> {
  const body = await readJson<{ title?: unknown; hasWorkspace?: unknown; workspaceRoot?: unknown; tags?: unknown; mode?: unknown; taskPreset?: unknown }>(req);
  const title = normalizeThreadTitlePatch(body);
  const hasWorkspace = typeof body.hasWorkspace === 'boolean' ? body.hasWorkspace : undefined;
  const workspaceRoot = typeof body.workspaceRoot === 'string' ? body.workspaceRoot.trim() : undefined;
  const tags = normalizeThreadTagsPatch(body);
  const mode = body.mode === 'chat' || body.mode === 'ops' ? body.mode as ThreadMode : undefined;
  const taskPreset = body.taskPreset === null || body.taskPreset === 'ops'
    ? (body.taskPreset === null ? null : 'ops') as ThreadTaskPreset | null
    : undefined;
  if (!title && hasWorkspace === undefined && workspaceRoot === undefined && !tags && !mode && body.taskPreset === undefined) {
    sendError(res, 400, 'Thread title, hasWorkspace, workspaceRoot, tags, mode, or taskPreset are required');
    return;
  }
  if (body.mode !== undefined && !mode) {
    sendError(res, 400, 'mode must be chat or ops');
    return;
  }
  if (body.taskPreset !== undefined && taskPreset === undefined) {
    sendError(res, 400, 'taskPreset must be ops or null');
    return;
  }
  const current = await store.getThread(threadId);
  if (!current) {
    sendError(res, 404, 'Thread not found');
    return;
  }
  await store.updateThreadMetadata(threadId, {
    ...(title ? { title } : {}),
    ...(hasWorkspace !== undefined ? { hasWorkspace } : {}),
    ...(workspaceRoot !== undefined ? { workspaceRoot } : {}),
    ...(tags ? { tags: { ...(current.tags ?? {}), ...tags } } : {}),
    ...(mode ? { mode } : {}),
    ...(body.taskPreset !== undefined ? { taskPreset } : {}),
  });
  const thread = await store.getThread(threadId);
  if (!thread) {
    sendError(res, 404, 'Thread not found');
    return;
  }
  sendJson(res, 200, { ok: true, thread });
}
