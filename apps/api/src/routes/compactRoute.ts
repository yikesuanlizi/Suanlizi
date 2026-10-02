import type { IncomingMessage, ServerResponse } from 'node:http';
import { compactThread } from '@suanlizi/memory';
import { compactionOptionsForModelContext } from '@suanlizi/runtime';
import type { ModelGateway } from '@suanlizi/model-gateway';
import type { ThreadStore } from '@suanlizi/storage';
import { resolveModelCapabilities, type Checkpoint, type CheckpointStatus, type ThreadEvent, type ThreadId, type ThreadItem, type TurnId, type TurnMeta } from '@suanlizi/protocol';
import { readJson, sendError, sendJson } from '../shared/http.js';
import type { AgentRunConfig } from '../config/config.js';

function compactCheckpoint(
  threadId: ThreadId,
  turnId: TurnId,
  itemIndex: number,
  status: CheckpointStatus,
): Checkpoint {
  return {
    threadId,
    turnId,
    itemIndex,
    status,
    timestamp: new Date().toISOString(),
  };
}

// 处理线程压缩：创建新的 turn 并将压缩后的内容作为 item 发布
// — Chinese: handle thread compaction: create a new turn and publish compacted items
export async function handleCompactThread(options: {
  req: IncomingMessage;
  res: ServerResponse;
  threadId: ThreadId;
  store: ThreadStore;
  getThreadRunConfig(threadId: ThreadId): Promise<AgentRunConfig>;
  saveThreadRunConfig(threadId: ThreadId, config: Partial<AgentRunConfig>): Promise<AgentRunConfig>;
  createModel(config: AgentRunConfig): Promise<ModelGateway>;
  publishEvent(event: ThreadEvent): void;
  generateId(): string;
}): Promise<void> {
  const body = await readJson<{ config?: Partial<AgentRunConfig>; mode?: 'manual' | 'auto'; strategy?: 'llm' | 'local' }>(options.req);
  const config = body.config
    ? await options.saveThreadRunConfig(options.threadId, body.config)
    : await options.getThreadRunConfig(options.threadId);
  const model = await options.createModel(config);
  // Manual compaction must use the same model window and run profile as the
  // agent turn. Previously this route omitted all policy options, so the
  // memory package fell back to its unrelated 40K default.
  const capabilities = resolveModelCapabilities({
    provider: config.provider,
    model: config.model,
    baseUrl: config.baseUrl,
    modelContextTokens: config.modelContextTokens,
    modelMaxOutputTokens: config.modelMaxOutputTokens,
  });
  let contextTokens = config.modelContextTokens ?? capabilities.contextTokens;
  const llamaModel = model as ModelGateway & {
    getProfile?: () => { id?: string };
    getLlamaContextTokens?: () => Promise<number | undefined>;
  };
  if (llamaModel.getProfile?.().id === 'llama_cpp' && llamaModel.getLlamaContextTokens) {
    const serverContext = await llamaModel.getLlamaContextTokens();
    if (serverContext) contextTokens = contextTokens ? Math.min(contextTokens, serverContext) : serverContext;
  }
  const compactionOptions = compactionOptionsForModelContext(
    config.runProfile,
    contextTokens,
  );
  const thread = await options.store.getThread(options.threadId);
  if (!thread) {
    sendError(options.res, 404, 'Thread not found');
    return;
  }

  // 创建一个新的 turn 条目（用于包装压缩结果）
  // — Chinese: create a new turn entry to wrap compaction results
  const turnId = options.generateId();
  const startedAt = new Date().toISOString();
  const turn: TurnMeta = {
    turnId,
    threadId: options.threadId,
    index: thread.turnCount,
    userInput: { type: 'text', text: '/compact' },
    status: 'running',
    startedAt,
    completedAt: null,
  };
  await options.store.saveTurn(turn);
  await options.store.updateThreadMetadata(options.threadId, { turnCount: thread.turnCount + 1 });
  await options.store.appendCheckpoint(options.threadId, compactCheckpoint(options.threadId, turnId, 0, 'running'));
  const compactRunId = `run_${turnId}`;
  options.publishEvent({ type: 'turn.started', threadId: options.threadId, turnId, runId: compactRunId, turnIndex: thread.turnCount });
  const userItem: ThreadItem = {
    id: `${turnId}_item_0`,
    type: 'user_message',
    turnId,
    text: config.locale === 'zh' ? '主动压缩上下文' : 'Compact the conversation context',
    timestamp: startedAt,
  };
  await options.store.appendItems(options.threadId, [userItem]);
  options.publishEvent({ type: 'item.started', threadId: options.threadId, turnId, item: userItem });
  options.publishEvent({ type: 'item.completed', threadId: options.threadId, turnId, item: userItem });

  try {
    const result = await compactThread(options.threadId, options.store, model, {
      ...compactionOptions,
      trigger: body.mode ?? 'manual',
      compactionTurnId: turnId,
      strategy: body.strategy ?? 'llm',
    });
    if (result.item) {
      options.publishEvent({ type: 'item.started', threadId: options.threadId, turnId, item: result.item });
      options.publishEvent({ type: 'item.completed', threadId: options.threadId, turnId, item: result.item });
      options.publishEvent({
        type: 'thread.compacted',
        threadId: options.threadId,
        compactedTurns: result.compactedTurns,
        tokensBefore: result.tokensBefore,
        tokensAfter: result.tokensAfter,
      });
    }
    const released = Math.max(0, result.tokensBefore - result.tokensAfter);
    const agentItem: ThreadItem = {
      id: `${turnId}_item_2`,
      type: 'agent_message',
      turnId,
      text: config.locale === 'zh'
        ? result.compactedTurns > 0
          ? `上下文压缩完成。已整理 ${result.compactedTurns} 轮，${result.tokensBefore.toLocaleString()} -> ${result.tokensAfter.toLocaleString()} tokens，释放 ${released.toLocaleString()} tokens。后续对话将使用压缩后的上下文继续。`
          : '当前没有可压缩的旧对话，未改变上下文。'
        : result.compactedTurns > 0
          ? `Context compaction completed. ${result.compactedTurns} turns were condensed from ${result.tokensBefore.toLocaleString()} to ${result.tokensAfter.toLocaleString()} tokens, releasing ${released.toLocaleString()} tokens. The next turn will continue with the compacted context.`
          : 'There were no older turns available to compact, so the context was unchanged.',
      timestamp: new Date().toISOString(),
    };
    await options.store.appendItems(options.threadId, [agentItem]);
    options.publishEvent({ type: 'item.started', threadId: options.threadId, turnId, item: agentItem });
    options.publishEvent({ type: 'item.completed', threadId: options.threadId, turnId, item: agentItem });
    turn.status = 'completed';
    turn.completedAt = new Date().toISOString();
    await options.store.saveTurn(turn);
    const itemIndex = (await options.store.getItems(options.threadId)).length;
    await options.store.appendCheckpoint(options.threadId, compactCheckpoint(options.threadId, turnId, itemIndex, 'completed'));
    options.publishEvent({ type: 'turn.completed', threadId: options.threadId, turnId, runId: compactRunId, usage: null, status: 'completed' });
    sendJson(options.res, 200, result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const errorItem: ThreadItem = {
      id: `${turnId}_item_error`,
      type: 'error',
      turnId,
      message,
      timestamp: new Date().toISOString(),
    };
    await options.store.appendItems(options.threadId, [errorItem]);
    options.publishEvent({ type: 'item.completed', threadId: options.threadId, turnId, item: errorItem });
    turn.status = 'failed';
    turn.completedAt = new Date().toISOString();
    await options.store.saveTurn(turn);
    const itemIndex = (await options.store.getItems(options.threadId)).length;
    await options.store.appendCheckpoint(options.threadId, compactCheckpoint(options.threadId, turnId, itemIndex, 'failed'));
    options.publishEvent({ type: 'turn.failed', threadId: options.threadId, turnId, runId: compactRunId, error: { message } });
    sendError(options.res, 500, message);
  }
}
