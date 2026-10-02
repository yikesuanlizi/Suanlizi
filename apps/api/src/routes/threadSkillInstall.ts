// 线程内 `/skills install` 处理器（从 server.ts 拆出，AGENTS §5：server.ts 只做路由装配）。
//
// 职责：把「安装 Skill」当作一次真实 turn 走完生命周期 —— 起 turn、落 items、发 SSE 事件、
// 收敛终态；失败也必须落可追溯的 error/tool_call 条目，不得只回 400。
// 行为与拆分前逐字一致，仅依赖改为显式注入。
// — Chinese: thread skill-install route handler extracted from server.ts.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ModelGateway } from '@suanlizi/model-gateway';
import type { ThreadEvent, ThreadId, ThreadItem, TurnMeta } from '@suanlizi/protocol';
import type { AgentRunConfig } from '../config/config.js';
import type { TenantRuntime } from '../runtime/tenantRuntime.js';
import { readJson, sendError, sendJson } from '../shared/http.js';
import { generateServerId } from '../shared/threadSerialization.js';
import {
  createSkillInstallFailureItems,
  createSkillInstallReply,
  skillInstallUrlsFromBody,
} from '../services/skillDraftService.js';
import { createSkillInstallTurnItems, installSkillsFromGitHubUrls } from '../services/skills.js';
import { shouldRetitleThread, titleFromInput } from '../services/threadTitle.js';

/** 按租户注入的 thread store（与 server.ts 的 tenantRuntime.storeForTenant 同型）。 */
type SkillInstallThreadStore = ReturnType<TenantRuntime['storeForTenant']>;

export interface ThreadSkillInstallDeps {
  req: IncomingMessage;
  res: ServerResponse;
  threadId: ThreadId;
  tenantId: string;
  store: SkillInstallThreadStore;
  getRunConfig: (threadId: ThreadId) => Promise<AgentRunConfig>;
  saveRunConfig: (threadId: ThreadId, patch: Partial<AgentRunConfig>) => Promise<AgentRunConfig>;
  createModel: (config: AgentRunConfig) => Promise<ModelGateway>;
  resetDefaultAgent: () => Promise<void> | void;
  publishEvent: (event: ThreadEvent) => void;
  publishCompletedItems: (threadId: ThreadId, turnId: string, items: ThreadItem[], tenantId: string) => void;
}

export async function handleThreadSkillInstall(deps: ThreadSkillInstallDeps): Promise<void> {
  const { req, res, threadId, tenantId, store } = deps;
  const body = await readJson<{ input?: string; url?: string; urls?: string[]; config?: Partial<AgentRunConfig> }>(req);
  const skillUrls = skillInstallUrlsFromBody(body);
  if (skillUrls.length === 0) {
    sendError(res, 400, 'Skill URL is required');
    return;
  }
  const config = body.config ? await deps.saveRunConfig(threadId, body.config) : await deps.getRunConfig(threadId);
  const thread = await store.getThread(threadId);
  if (!thread) {
    sendError(res, 404, 'Thread not found');
    return;
  }

  const inputText = body.input?.trim() || `/skills add ${skillUrls.join(' ')}`;
  if (shouldRetitleThread(thread.title)) {
    const nextTitle = titleFromInput(inputText) ?? inputText.slice(0, 60);
    await store.updateThreadMetadata(threadId, { title: nextTitle });
    deps.publishEvent({ type: 'thread.metadata.updated', threadId, title: nextTitle });
  }

  const turnId = generateServerId();
  const startedAt = new Date().toISOString();
  const skillsRunId = `run_${turnId}`;
  const turn: TurnMeta = {
    turnId,
    threadId,
    index: thread.turnCount,
    userInput: { type: 'text', text: inputText },
    status: 'running',
    startedAt,
    completedAt: null,
  };
  await store.saveTurn(turn);
  await store.updateThreadMetadata(threadId, { turnCount: thread.turnCount + 1 });
  deps.publishEvent({ type: 'turn.started', threadId, turnId, runId: skillsRunId, turnIndex: thread.turnCount });

  try {
    const result = await installSkillsFromGitHubUrls(config.skillsRoot, skillUrls);
    await deps.resetDefaultAgent();
    const model = await deps.createModel(config);
    const agentText = await createSkillInstallReply(model, result, inputText, config.locale);
    const items = createSkillInstallTurnItems({
      turnId,
      input: inputText,
      installUrls: skillUrls,
      installed: result.installed,
      skillsRoot: result.skillsRoot,
      agentText,
      timestamp: startedAt,
    });
    await store.appendItems(threadId, items);
    deps.publishCompletedItems(threadId, turnId, items, tenantId);
    turn.status = 'completed';
    turn.completedAt = new Date().toISOString();
    await store.saveTurn(turn);
    deps.publishEvent({ type: 'turn.completed', threadId, turnId, runId: skillsRunId, usage: null, status: 'completed' });
    sendJson(res, 200, { ok: true, items, ...result });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const items = createSkillInstallFailureItems(turnId, inputText, message, startedAt, skillUrls);
    await store.appendItems(threadId, items);
    deps.publishCompletedItems(threadId, turnId, items, tenantId);
    turn.status = 'failed';
    turn.completedAt = new Date().toISOString();
    await store.saveTurn(turn);
    deps.publishEvent({ type: 'turn.failed', threadId, turnId, runId: skillsRunId, error: { message } });
    sendError(res, 400, message);
  }
}
