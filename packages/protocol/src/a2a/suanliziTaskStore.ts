// A2A TaskStore 适配层：将 A2A Task 映射为 Suanlizi ThreadMeta 并存储
// 英文说明：A2A TaskStore adapter — maps A2A Task to Suanlizi ThreadMeta and persists via ThreadStore

import type { TaskStore, ServerCallContext } from '@a2a-js/sdk/server';
import type { Task, Message, TaskState, Part, TextPart } from '@a2a-js/sdk';
import type { ThreadMeta, ThreadItem, UserMessageItem, AgentMessageItem } from '../types.js';

/**
 * TaskStoreBackend — SuanliziTaskStore 所需的最小存储端口。
 *
 * 在 @suanlizi/protocol 中定义该端口而非直接 import @suanlizi/storage，
 * 以避免 protocol → storage 的 project reference 依赖（protocol 是底层包）。
 * apps/api 层将 ThreadStore（结构兼容）直接传入即可。
 */
// — Chinese: TaskStoreBackend — minimal storage port for SuanliziTaskStore.
// Defined here to avoid protocol → storage dependency. ThreadStore is structurally compatible.
export interface TaskStoreBackend {
  getThread(threadId: string): Promise<ThreadMeta | null>;
  createThread(meta: ThreadMeta): Promise<void>;
  updateThreadMetadata(threadId: string, patch: Partial<ThreadMeta>): Promise<void>;
  getItems(threadId: string): Promise<ThreadItem[]>;
}

// 线程 tags 中存储 A2A 状态的键名
// — Chinese: key names for storing A2A state in thread tags
const A2A_STATE_TAG = 'a2aState';
const A2A_CONTEXT_ID_TAG = 'a2aContextId';

const VALID_TASK_STATES: TaskState[] = [
  'submitted',
  'working',
  'input-required',
  'completed',
  'canceled',
  'failed',
  'rejected',
  'auth-required',
  'unknown',
];

function isValidTaskState(state: string): state is TaskState {
  return (VALID_TASK_STATES as string[]).includes(state);
}

function threadToTaskState(thread: ThreadMeta): TaskState {
  const state = thread.tags[A2A_STATE_TAG];
  if (state && isValidTaskState(state)) return state;
  return 'unknown';
}

/** 从 A2A Message 的 parts 中提取纯文本 */
// — Chinese: extract plain text from A2A Message parts
function extractTextFromParts(parts: Part[]): string | null {
  const texts: string[] = [];
  for (const part of parts) {
    if (part.kind === 'text') {
      texts.push((part as TextPart).text);
    }
  }
  return texts.length > 0 ? texts.join('\n') : null;
}

/** 从历史消息中提取第一条用户消息作为标题 */
// — Chinese: derive thread title from first user message in history
function deriveTitleFromHistory(history: Message[] | undefined): string {
  if (!history || history.length === 0) return 'A2A Task';
  const firstUser = history.find((m) => m.role === 'user');
  if (!firstUser) return 'A2A Task';
  const text = extractTextFromParts(firstUser.parts);
  if (!text) return 'A2A Task';
  const normalized = text.replace(/\s+/g, ' ').trim();
  return normalized.length <= 60 ? normalized : `${normalized.slice(0, 60)}...`;
}

/** 将 Suanlizi ThreadItem 转换为 A2A Message */
// — Chinese: convert Suanlizi ThreadItem to A2A Message
function threadItemToMessage(item: ThreadItem, threadId: string): Message | null {
  if (item.type === 'user_message') {
    const userItem = item as UserMessageItem;
    return {
      kind: 'message',
      messageId: userItem.id,
      role: 'user',
      taskId: threadId,
      parts: [{ kind: 'text', text: userItem.text }],
      timestamp: userItem.timestamp,
    } as Message & { timestamp?: string };
  }
  if (item.type === 'agent_message') {
    const agentItem = item as AgentMessageItem;
    return {
      kind: 'message',
      messageId: agentItem.id,
      role: 'agent',
      taskId: threadId,
      parts: [{ kind: 'text', text: agentItem.text }],
      timestamp: agentItem.timestamp,
    } as Message & { timestamp?: string };
  }
  return null;
}

/**
 * SuanliziTaskStore — 实现 @a2a-js/sdk 的 TaskStore 接口。
 *
 * 映射关系：
 * - A2A Task.id         → Suanlizi ThreadMeta.threadId
 * - A2A Task.status.state → 存储在 ThreadMeta.tags[a2aState]
 * - A2A Task.contextId   → 存储在 ThreadMeta.tags[a2aContextId]
 * - A2A Task.history     → 从 ThreadStore 的 ThreadItem[]（user_message / agent_message）重建
 *
 * 注意：save 不直接写入 ThreadItem（由 AgentLoop.runTurn 负责追加），
 * 仅更新线程元信息（tags 中的 A2A 状态）。
 */
// — Chinese: SuanliziTaskStore implements the SDK TaskStore interface.
// Maps A2A Task to Suanlizi Thread and persists state in thread tags.
export class SuanliziTaskStore implements TaskStore {
  constructor(private readonly store: TaskStoreBackend) {}

  async save(task: Task, _context?: ServerCallContext): Promise<void> {
    const threadId = task.id;
    const a2aState = task.status.state;
    const a2aContextId = task.contextId;
    const existing = await this.store.getThread(threadId);

    if (!existing) {
      // 新线程：从 A2A Task 创建 Suanlizi Thread
      // — Chinese: new thread — create from A2A Task
      const now = task.status.timestamp ?? new Date().toISOString();
      const meta: ThreadMeta = {
        threadId,
        title: deriveTitleFromHistory(task.history),
        workspaceRoot: '',
        status: 'active',
        turnCount: 0,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        ephemeral: false,
        tags: {
          [A2A_STATE_TAG]: a2aState,
          [A2A_CONTEXT_ID_TAG]: a2aContextId,
        },
      };
      await this.store.createThread(meta);
      return;
    }

    // 已有线程：仅更新 A2A 状态标签
    // — Chinese: existing thread — update A2A state tags only
    const tags: Record<string, string> = { ...existing.tags };
    tags[A2A_STATE_TAG] = a2aState;
    if (a2aContextId) tags[A2A_CONTEXT_ID_TAG] = a2aContextId;
    await this.store.updateThreadMetadata(threadId, { tags });
  }

  async load(taskId: string, _context?: ServerCallContext): Promise<Task | undefined> {
    const thread = await this.store.getThread(taskId);
    if (!thread) return undefined;

    const items = await this.store.getItems(taskId);
    const history: Message[] = [];
    for (const item of items) {
      const msg = threadItemToMessage(item, taskId);
      if (msg) history.push(msg);
    }

    const state = threadToTaskState(thread);
    const contextId = thread.tags[A2A_CONTEXT_ID_TAG] ?? taskId;

    const task: Task = {
      kind: 'task',
      id: taskId,
      contextId,
      status: {
        state,
        timestamp: thread.updatedAt,
      },
      history: history.length > 0 ? history : undefined,
    };

    return task;
  }
}
