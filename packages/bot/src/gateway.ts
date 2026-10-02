import type { ThreadMeta } from '@suanlizi/protocol';
import type { ThreadStore } from '@suanlizi/storage';
import type {
  BotDedupeState,
  BotInboundMessage,
  BotOutboundMessage,
  BotRunContext,
  BotRunResult,
  BotSession,
  BotSessionState,
  BotTurnResult,
} from './types.js';

export const BOT_SESSIONS_KEY = 'bot.sessions.v1';
export const BOT_DEDUPE_KEY = 'bot.dedupe.v1';

export interface BotGatewayOptions {
  store: ThreadStore;
  runTurn(threadId: string, text: string, context: BotRunContext): Promise<BotRunResult>;
  send(message: BotOutboundMessage): Promise<void>;
  isThreadRunning?(threadId: string): boolean | Promise<boolean>;
  now?(): string;
  createId?(): string;
  defaultWorkspaceRoot: string;
  preferredThreadId?: string;
  defaultThreadTitle?: string;
  singleBindingMode?: boolean;
  usePreferredThreadForSessions?: boolean;
  locale?: 'zh' | 'en';
  dedupeTtlMs?: number;
  tenantId?: string;
  botAccountId?: string;
}

export class BotGateway {
  private readonly store: ThreadStore;
  private readonly runTurn: BotGatewayOptions['runTurn'];
  private readonly send: BotGatewayOptions['send'];
  private readonly isThreadRunning: NonNullable<BotGatewayOptions['isThreadRunning']>;
  private readonly now: NonNullable<BotGatewayOptions['now']>;
  private readonly createId: NonNullable<BotGatewayOptions['createId']>;
  private readonly defaultWorkspaceRoot: string;
  private readonly preferredThreadId: string;
  private readonly defaultThreadTitle: string;
  private readonly singleBindingMode: boolean;
  private readonly usePreferredThreadForSessions: boolean;
  private readonly locale: 'zh' | 'en';
  private readonly dedupeTtlMs: number;
  private readonly tenantId: string;
  private readonly botAccountId: string;

  constructor(options: BotGatewayOptions) {
    this.store = options.store;
    this.runTurn = options.runTurn;
    this.send = options.send;
    this.isThreadRunning = options.isThreadRunning ?? (() => false);
    this.now = options.now ?? (() => new Date().toISOString());
    this.createId = options.createId ?? (() => `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
    this.defaultWorkspaceRoot = options.defaultWorkspaceRoot;
    this.preferredThreadId = options.preferredThreadId?.trim() ?? '';
    this.defaultThreadTitle = options.defaultThreadTitle?.trim() ?? '';
    this.singleBindingMode = options.singleBindingMode === true;
    this.usePreferredThreadForSessions = options.usePreferredThreadForSessions !== false;
    this.locale = options.locale ?? 'zh';
    this.dedupeTtlMs = options.dedupeTtlMs ?? 24 * 60 * 60 * 1000;
    this.tenantId = options.tenantId?.trim() || 'default';
    this.botAccountId = options.botAccountId?.trim() ?? '';
  }

  async handleMessage(message: BotInboundMessage): Promise<BotTurnResult> {
    const trimmed = message.text.trim();
    if (!trimmed) return { status: 'failed', error: this.locale === 'zh' ? '消息为空' : 'Message is empty' };

    if (await this.hasSeen(message)) {
      return { status: 'duplicate' };
    }
    await this.markSeen(message);

    const session = await this.resolveSession(message);
    if (await this.isThreadRunning(session.threadId)) {
      const reply = this.locale === 'zh'
        ? '上一条消息还在处理中，请稍后再发。'
        : 'The previous message is still running. Please try again shortly.';
      await this.send({
        platform: message.platform,
        chatId: message.chatId,
        text: reply,
        threadId: session.threadId,
        metadata: message.metadata,
      });
      return { status: 'busy', threadId: session.threadId, reply };
    }

    try {
      const result = await this.runTurn(session.threadId, trimmed, {
        platform: message.platform,
        chatId: message.chatId,
        chatType: message.chatType,
        userId: message.userId,
        userName: message.userName,
        messageId: message.messageId,
        sessionKey: session.key,
      });
      const reply = result.text.trim() || (this.locale === 'zh' ? '已完成。' : 'Done.');
      await this.send({
        platform: message.platform,
        chatId: message.chatId,
        text: reply,
        threadId: session.threadId,
        metadata: message.metadata,
      });
      await this.touchSession(session.key);
      return { status: 'completed', threadId: session.threadId, reply };
    } catch (error) {
      const err = error instanceof Error ? error.message : String(error);
      const reply = this.locale === 'zh' ? `处理失败：${err}` : `Failed: ${err}`;
      await this.send({
        platform: message.platform,
        chatId: message.chatId,
        text: reply,
        threadId: session.threadId,
        metadata: message.metadata,
      });
      return { status: 'failed', threadId: session.threadId, error: err, reply };
    }
  }

  private sessionKey(message: Pick<BotInboundMessage, 'platform' | 'chatType' | 'chatId' | 'threadId'>): string {
    const topic = message.threadId?.trim();
    const base = topic
      ? `${message.platform}:${message.chatType}:${message.chatId}:${topic}`
      : `${message.platform}:${message.chatType}:${message.chatId}`;
    return this.scopeKey(base);
  }

  private dedupeKey(message: Pick<BotInboundMessage, 'platform' | 'messageId'>): string {
    return this.scopeKey(`${message.platform}:${message.messageId}`);
  }

  private scopeKey(base: string): string {
    const prefix: string[] = [];
    if (this.tenantId !== 'default') prefix.push(`tenant:${this.tenantId}`);
    if (this.botAccountId) prefix.push(`account:${this.botAccountId}`);
    return prefix.length ? `${prefix.join(':')}:${base}` : base;
  }

  private async readSessions(): Promise<BotSessionState> {
    const stored = await this.store.getSetting<BotSessionState>(BOT_SESSIONS_KEY);
    return { sessions: Array.isArray(stored?.sessions) ? stored.sessions : [] };
  }

  private async writeSessions(state: BotSessionState): Promise<void> {
    await this.store.setSetting(BOT_SESSIONS_KEY, state);
  }

  private async resolveSession(message: BotInboundMessage): Promise<BotSession> {
    const key = this.sessionKey(message);
    const state = await this.readSessions();
    const existing = state.sessions.find((session) => session.key === key);
    const preferredThread = this.usePreferredThreadForSessions && this.preferredThreadId
      ? await this.store.getThread(this.preferredThreadId)
      : null;
    if (existing) {
      if (preferredThread && existing.threadId !== preferredThread.threadId) {
        const relinked: BotSession = {
          ...existing,
          threadId: preferredThread.threadId,
          title: preferredThread.title || existing.title,
          updatedAt: this.now(),
        };
        await this.writeSessions({
          sessions: state.sessions.map((session) => session.key === key ? relinked : session),
        });
        return relinked;
      }
      if (preferredThread) return existing;
      const existingThread = await this.store.getThread(existing.threadId);
      if (existingThread && !this.singleBindingMode) {
        return existing;
      }
      return this.createOrReplaceSessionThread(state, existing, message, key);
    }

    if (preferredThread) {
      const now = this.now();
      const title = this.titleForMessage(message);
      const session: BotSession = {
        key,
        platform: message.platform,
        chatId: message.chatId,
        chatType: message.chatType,
        threadId: preferredThread.threadId,
        title: preferredThread.title || title,
        createdAt: now,
        updatedAt: now,
      };
      state.sessions.unshift(session);
      await this.writeSessions(state);
      return session;
    }
    return this.createOrReplaceSessionThread(state, null, message, key);
  }

  private async createOrReplaceSessionThread(
    state: BotSessionState,
    existing: BotSession | null,
    message: BotInboundMessage,
    key: string,
  ): Promise<BotSession> {
    const now = this.now();
    const title = this.titleForMessage(message);
    const threadId = this.createId();
    const thread: ThreadMeta = {
      threadId,
      tenantId: this.tenantId,
      title,
      workspaceRoot: this.defaultWorkspaceRoot,
      status: 'active',
      turnCount: 0,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      ephemeral: false,
      tags: {
        botPlatform: message.platform,
        botSessionKey: key,
        botTenantId: this.tenantId,
        ...(this.botAccountId ? { botAccountId: this.botAccountId } : {}),
      },
    };
    await this.store.createThread(thread);

    const session: BotSession = {
      key,
      platform: message.platform,
      chatId: message.chatId,
      chatType: message.chatType,
      threadId,
      title,
      createdAt: now,
      updatedAt: now,
    };
    const sessions = existing
      ? state.sessions.map((item) => item.key === key ? session : item)
      : [session, ...state.sessions];
    await this.writeSessions({ sessions });
    return session;
  }

  private async touchSession(key: string): Promise<void> {
    const state = await this.readSessions();
    const next = state.sessions.map((session) => (
      session.key === key ? { ...session, updatedAt: this.now() } : session
    ));
    await this.writeSessions({ sessions: next });
  }

  private titleForMessage(message: BotInboundMessage): string {
    if (this.defaultThreadTitle) return this.defaultThreadTitle;
    if (message.chatType === 'group') return message.chatId || '微信群';
    return message.userName.trim() || message.userId || '微信联系人';
  }

  private async readDedupe(): Promise<BotDedupeState> {
    const stored = await this.store.getSetting<BotDedupeState>(BOT_DEDUPE_KEY);
    return { entries: Array.isArray(stored?.entries) ? stored.entries : [] };
  }

  private async hasSeen(message: BotInboundMessage): Promise<boolean> {
    const state = await this.readDedupe();
    const key = this.dedupeKey(message);
    return state.entries.some((entry) => entry.key === key);
  }

  private async markSeen(message: BotInboundMessage): Promise<void> {
    const state = await this.readDedupe();
    const now = this.now();
    const cutoff = Date.parse(now) - this.dedupeTtlMs;
    const key = this.dedupeKey(message);
    const entries = state.entries
      .filter((entry) => Date.parse(entry.seenAt) >= cutoff && entry.key !== key)
      .slice(0, 999);
    entries.unshift({ key, seenAt: now });
    await this.store.setSetting(BOT_DEDUPE_KEY, { entries });
  }
}
