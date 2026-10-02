import * as path from 'node:path';
import {
  buildEpisodePromptBlock,
  buildOrReuseWorkingSet,
  computeEpisodeIdentity,
  exportMemoryArtifacts,
  getEpisodeMemorySettings,
  getMemorySettings,
  getOpenEpisodeForThread,
  getThreadWorkingSetSnapshot,
  listEpisodeRecords,
  promoteEpisodeToWarm,
  saveThreadWorkingSetSnapshot,
  setEpisodeMemorySettings,
  setMemorySettings,
} from '@suanlizi/memory';
import type { EpisodeMemoryMode, ThreadId, UserInput } from '@suanlizi/protocol';
import type { ThreadStore } from '@suanlizi/storage';
import { readJson, sendError, sendJson } from '../shared/http.js';
import type { AgentRunConfig } from '../config/config.js';
import type { IncomingMessage, ServerResponse } from 'node:http';

// 记忆路由选项 — Chinese: memory route options
export interface MemoryRouteOptions {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  pathname: string;
  store: ThreadStore;
  getDefaultRunConfig(): Promise<AgentRunConfig>;
  saveDefaultRunConfig(configPatch: Partial<AgentRunConfig>): Promise<AgentRunConfig>;
}

const EPISODE_MEMORY_MODES: EpisodeMemoryMode[] = ['enabled', 'disabled', 'polluted'];

// 处理记忆相关路由（列表、设置更新、删除条目、导出、episode 管理）
// — Chinese: handle memory routes (list, settings, delete, export, episode management)
export async function handleMemoryRoute(options: MemoryRouteOptions): Promise<boolean> {
  const { req, res, url, pathname, store } = options;
  if (!pathname.startsWith('/api/memories')) return false;

  // GET /api/memories — 返回设置、冷记忆记录列表、episode 列表与当前 workingSet 快照
  // — Chinese: GET /api/memories — return settings + cold records + episodes + workingSet
  if (req.method === 'GET' && pathname === '/api/memories') {
    const config = await options.getDefaultRunConfig();
    const records = await store.listMemoryRecords?.({
      workspaceRoot: config.workspaceRoot,
    }) ?? [];
    const episodes = await listEpisodeRecords(store, { workspaceRoot: config.workspaceRoot });
    const settings = {
      ...(await getMemorySettings(store)),
      ...(await getEpisodeMemorySettings(store)),
      memoryEnabled: config.memoryEnabled,
      autoExtractMemories: config.autoExtractMemories,
      useColdMemories: config.useColdMemories,
      memoryInjectLimit: config.memoryInjectLimit,
      memoryTokenBudget: config.memoryTokenBudget,
      episodeMemoryEnabled: config.episodeMemoryEnabled,
      episodeInjectLimit: config.episodeInjectLimit,
      episodeTokenBudget: config.episodeTokenBudget,
      episodeSwitchCooldownTurns: config.episodeSwitchCooldownTurns,
      episodeSealIdleMinutes: config.episodeSealIdleMinutes,
      episodeColdAfterDays: config.episodeColdAfterDays,
      episodeFtsCandidateLimit: config.episodeFtsCandidateLimit,
      episodeRerankEnabled: config.episodeRerankEnabled,
    };
    const threadId = url.searchParams.get('threadId') as ThreadId | null;
    const workingSet = threadId ? await getThreadWorkingSetSnapshot(store, threadId) : null;
    sendJson(res, 200, {
      settings,
      records,
      episodes,
      workingSet,
    });
    return true;
  }

  // PATCH /api/memories/settings — 更新冷记忆与 episode 记忆设置
  // — Chinese: PATCH /api/memories/settings — update cold + episode memory settings
  if (req.method === 'PATCH' && pathname === '/api/memories/settings') {
    const body = await readJson<{ settings?: Partial<AgentRunConfig> }>(req);
    const settings = body.settings ?? {};
    const nextMemorySettings = await setMemorySettings(store, {
      memoryEnabled: settings.memoryEnabled,
      autoExtractMemories: settings.autoExtractMemories,
      useColdMemories: settings.useColdMemories,
      memoryInjectLimit: settings.memoryInjectLimit,
      memoryTokenBudget: settings.memoryTokenBudget,
    });
    const nextEpisodeSettings = await setEpisodeMemorySettings(store, {
      episodeMemoryEnabled: settings.episodeMemoryEnabled,
      episodeInjectLimit: settings.episodeInjectLimit,
      episodeTokenBudget: settings.episodeTokenBudget,
      episodeSwitchCooldownTurns: settings.episodeSwitchCooldownTurns,
      episodeSealIdleMinutes: settings.episodeSealIdleMinutes,
      episodeColdAfterDays: settings.episodeColdAfterDays,
      episodeFtsCandidateLimit: settings.episodeFtsCandidateLimit,
      episodeRerankEnabled: settings.episodeRerankEnabled,
    });
    const mergedSettings = { ...nextMemorySettings, ...nextEpisodeSettings };
    const config = await options.saveDefaultRunConfig(mergedSettings);
    sendJson(res, 200, { ok: true, settings: mergedSettings, config });
    return true;
  }

  // DELETE /api/memories/:id — 删除特定记忆条目
  // — Chinese: DELETE /api/memories/:id — delete a specific memory record
  if (req.method === 'DELETE' && pathname.startsWith('/api/memories/')) {
    const id = decodeURIComponent(pathname.slice('/api/memories/'.length));
    if (!id) {
      sendError(res, 400, 'Memory id is required');
      return true;
    }
    await store.deleteMemoryRecord?.(id);
    sendJson(res, 200, { ok: true });
    return true;
  }

  // POST /api/memories/export — 将记忆条目导出到本地目录
  // — Chinese: POST /api/memories/export — export memory records to local directory
  if (req.method === 'POST' && pathname === '/api/memories/export') {
    const config = await options.getDefaultRunConfig();
    const outputDir = path.join(config.dataDir, 'memories');
    const result = await exportMemoryArtifacts(store, outputDir);
    sendJson(res, 200, { ok: true, outputDir, ...result });
    return true;
  }

  // POST /api/memories/activate-episode — 将指定 episode 升温并激活为当前工作集
  // — Chinese: POST /api/memories/activate-episode — promote episode and activate it as the current working set
  if (req.method === 'POST' && pathname === '/api/memories/activate-episode') {
    const body = await readJson<{ episodeId?: string; threadId?: ThreadId }>(req);
    if (!body.episodeId) {
      sendError(res, 400, 'episodeId is required');
      return true;
    }
    await promoteEpisodeToWarm(store, body.episodeId);
    const episode = await store.getEpisodeRecord?.(body.episodeId);
    if (!episode) {
      sendError(res, 404, `Episode ${body.episodeId} not found`);
      return true;
    }
    const threadId = body.threadId ?? episode.sourceThreadId;
    const thread = await store.getThread(threadId);
    if (!thread) {
      sendError(res, 404, `Thread ${threadId} not found`);
      return true;
    }
    const existing = await getThreadWorkingSetSnapshot(store, threadId);
    const selectedArtifacts = thread.tags?.selectedArtifacts
      ? thread.tags.selectedArtifacts.split(',').map((s) => s.trim()).filter(Boolean)
      : [];
    const now = new Date().toISOString();
    const snapshot = {
      threadId,
      generation: (existing?.generation ?? 0) + 1,
      activeEpisodeIds: [episode.id],
      injectedEpisodeIds: [episode.id],
      frozenPromptBlock: buildEpisodePromptBlock([episode]),
      builtFromTurnId: existing?.builtFromTurnId ?? '',
      builtFromTurnIndex: existing?.builtFromTurnIndex ?? -1,
      taskFingerprint: existing?.taskFingerprint ?? '',
      episodeIdentity: computeEpisodeIdentity(episode, thread.tags?.activeGoal, selectedArtifacts),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    await saveThreadWorkingSetSnapshot(store, snapshot);
    sendJson(res, 200, { ok: true, episodeId: body.episodeId, threadId, snapshot });
    return true;
  }

  // POST /api/memories/rebuild-working-set — 为指定线程构建或复用 workingSet
  // — Chinese: POST /api/memories/rebuild-working-set — build or reuse thread working set
  if (req.method === 'POST' && pathname === '/api/memories/rebuild-working-set') {
    const body = await readJson<{
      threadId?: ThreadId;
      force?: boolean;
      userInput?: UserInput;
    }>(req);
    if (!body.threadId) {
      sendError(res, 400, 'threadId is required');
      return true;
    }
    const thread = await store.getThread(body.threadId);
    if (!thread) {
      sendError(res, 404, `Thread ${body.threadId} not found`);
      return true;
    }
    if (thread.tags?.episodeMemoryMode === 'polluted' && !body.force) {
      sendError(res, 400, "Thread memory is polluted; use force: true to rebuild");
      return true;
    }
    const turns = await store.getTurns(body.threadId);
    if (turns.length === 0) {
      sendError(res, 400, `Thread ${body.threadId} has no turns`);
      return true;
    }
    const latestTurn = turns[turns.length - 1];
    const userInput: UserInput = body.userInput ?? {
      type: 'text',
      text: thread.title || 'rebuild',
    };
    const currentSnapshot = await getThreadWorkingSetSnapshot(store, body.threadId);
    let snapshot = currentSnapshot;
    if (body.force || !currentSnapshot) {
      const settings = await getEpisodeMemorySettings(store);
      const openEpisode = await getOpenEpisodeForThread(store, body.threadId);
      const activeGoal = thread.tags?.activeGoal;
      const selectedArtifacts = thread.tags?.selectedArtifacts
        ? thread.tags.selectedArtifacts.split(',').map((s) => s.trim()).filter(Boolean)
        : undefined;
      const result = await buildOrReuseWorkingSet(
        store,
        thread,
        userInput,
        latestTurn.turnId,
        latestTurn.index,
        openEpisode,
        settings,
        activeGoal,
        selectedArtifacts,
      );
      snapshot = result.snapshot;
    }
    sendJson(res, 200, { ok: true, snapshot });
    return true;
  }

  // POST /api/memories/mode — 设置线程的 episodeMemoryMode 标签
  // — Chinese: POST /api/memories/mode — set episodeMemoryMode tag on thread
  if (req.method === 'POST' && pathname === '/api/memories/mode') {
    const body = await readJson<{
      threadId?: ThreadId;
      mode?: EpisodeMemoryMode;
    }>(req);
    if (!body.threadId) {
      sendError(res, 400, 'threadId is required');
      return true;
    }
    if (!body.mode || !EPISODE_MEMORY_MODES.includes(body.mode)) {
      sendError(res, 400, "mode must be 'enabled', 'disabled' or 'polluted'");
      return true;
    }
    const thread = await store.getThread(body.threadId);
    if (!thread) {
      sendError(res, 404, `Thread ${body.threadId} not found`);
      return true;
    }
    await store.updateThreadMetadata(body.threadId, {
      tags: { ...thread.tags, episodeMemoryMode: body.mode },
    });
    sendJson(res, 200, { ok: true });
    return true;
  }

  return false;
}
