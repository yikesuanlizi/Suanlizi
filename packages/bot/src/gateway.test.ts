import { describe, expect, it, vi } from 'vitest';
import type { ThreadMeta } from '@suanlizi/protocol';
import type { ThreadStore } from '@suanlizi/storage';
import { BotGateway } from './index.js';

class MemoryBotStore implements Partial<ThreadStore> {
  settings = new Map<string, unknown>();
  threads = new Map<string, ThreadMeta>();

  async getSetting<T = unknown>(key: string): Promise<T | null> {
    return (this.settings.get(key) as T | undefined) ?? null;
  }

  async setSetting(key: string, value: unknown): Promise<void> {
    this.settings.set(key, value);
  }

  async createThread(meta: ThreadMeta): Promise<void> {
    this.threads.set(meta.threadId, meta);
  }

  async getThread(threadId: string): Promise<ThreadMeta | null> {
    return this.threads.get(threadId) ?? null;
  }
}

describe('BotGateway', () => {
  it('creates one Suanlizi thread per WeChat dm session and sends the final reply', async () => {
    const store = new MemoryBotStore();
    const send = vi.fn(async () => {});
    const runTurn = vi.fn(async () => ({ text: '处理完成' }));
    const gateway = new BotGateway({
      store: store as unknown as ThreadStore,
      runTurn,
      send,
      now: () => '2026-06-11T00:00:00.000Z',
      createId: () => 'thread_1',
      defaultWorkspaceRoot: 'E:\\langchain',
      locale: 'zh',
    });

    const result = await gateway.handleMessage({
      platform: 'weixin',
      chatType: 'dm',
      chatId: 'friend_a',
      userId: 'friend_a',
      userName: '张三',
      text: '帮我看一下项目',
      messageId: 'msg_1',
    });

    expect(result).toMatchObject({ status: 'completed', threadId: 'thread_1' });
    expect(runTurn).toHaveBeenCalledWith('thread_1', '帮我看一下项目', expect.any(Object));
    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      platform: 'weixin',
      chatId: 'friend_a',
      text: '处理完成',
    }));

    await gateway.handleMessage({
      platform: 'weixin',
      chatType: 'dm',
      chatId: 'friend_a',
      userId: 'friend_a',
      userName: '张三',
      text: '继续',
      messageId: 'msg_2',
    });
    expect(runTurn).toHaveBeenLastCalledWith('thread_1', '继续', expect.any(Object));
  });

  it('deduplicates repeated platform message ids before running the agent', async () => {
    const store = new MemoryBotStore();
    const runTurn = vi.fn(async () => ({ text: 'ok' }));
    const gateway = new BotGateway({
      store: store as unknown as ThreadStore,
      runTurn,
      send: vi.fn(async () => {}),
      now: () => '2026-06-11T00:00:00.000Z',
      createId: () => 'thread_1',
      defaultWorkspaceRoot: 'E:\\langchain',
      locale: 'zh',
    });
    const message = {
      platform: 'weixin' as const,
      chatType: 'dm' as const,
      chatId: 'friend_a',
      userId: 'friend_a',
      userName: '张三',
      text: '重复消息',
      messageId: 'same_msg',
    };

    await gateway.handleMessage(message);
    const duplicate = await gateway.handleMessage(message);

    expect(duplicate.status).toBe('duplicate');
    expect(runTurn).toHaveBeenCalledTimes(1);
  });

  it('scopes Weixin sessions and dedupe by tenant and bot account', async () => {
    const store = new MemoryBotStore();
    const send = vi.fn(async () => {});
    const runTurn = vi.fn(async () => ({ text: 'ok' }));
    let nextId = 0;
    const createId = () => `thread_${++nextId}`;

    const tenantA = new BotGateway({
      store: store as unknown as ThreadStore,
      runTurn,
      send,
      now: () => '2026-06-11T00:00:00.000Z',
      createId,
      defaultWorkspaceRoot: '',
      locale: 'zh',
      tenantId: 'tenantA',
      botAccountId: 'wx_account_a',
    });
    const tenantB = new BotGateway({
      store: store as unknown as ThreadStore,
      runTurn,
      send,
      now: () => '2026-06-11T00:00:01.000Z',
      createId,
      defaultWorkspaceRoot: '',
      locale: 'zh',
      tenantId: 'tenantB',
      botAccountId: 'wx_account_b',
    });
    const message = {
      platform: 'weixin' as const,
      chatType: 'dm' as const,
      chatId: 'friend_a',
      userId: 'friend_a',
      userName: '张三',
      text: '同一平台消息',
      messageId: 'same_msg',
    };

    const resultA = await tenantA.handleMessage(message);
    const resultB = await tenantB.handleMessage(message);

    expect(resultA).toMatchObject({ status: 'completed', threadId: 'thread_1' });
    expect(resultB).toMatchObject({ status: 'completed', threadId: 'thread_2' });
    expect(runTurn).toHaveBeenCalledTimes(2);
    expect(store.settings.get('bot.sessions.v1')).toMatchObject({
      sessions: expect.arrayContaining([
        expect.objectContaining({ key: 'tenant:tenantA:account:wx_account_a:weixin:dm:friend_a', threadId: 'thread_1' }),
        expect.objectContaining({ key: 'tenant:tenantB:account:wx_account_b:weixin:dm:friend_a', threadId: 'thread_2' }),
      ]),
    });
    expect(store.settings.get('bot.dedupe.v1')).toMatchObject({
      entries: expect.arrayContaining([
        expect.objectContaining({ key: 'tenant:tenantA:account:wx_account_a:weixin:same_msg' }),
        expect.objectContaining({ key: 'tenant:tenantB:account:wx_account_b:weixin:same_msg' }),
      ]),
    });
    expect(store.threads.get('thread_1')).toMatchObject({
      tenantId: 'tenantA',
      tags: {
        botPlatform: 'weixin',
        botSessionKey: 'tenant:tenantA:account:wx_account_a:weixin:dm:friend_a',
        botTenantId: 'tenantA',
        botAccountId: 'wx_account_a',
      },
    });
  });

  it('relinks an existing Weixin session to the preferred Suanlizi thread', async () => {
    const store = new MemoryBotStore();
    store.threads.set('thread_current', {
      threadId: 'thread_current',
      title: '当前桌面对话',
      workspaceRoot: '',
      status: 'active',
      turnCount: 0,
      createdAt: '2026-06-11T00:00:00.000Z',
      updatedAt: '2026-06-11T00:00:00.000Z',
      archivedAt: null,
      ephemeral: false,
      tags: {},
    });
    store.settings.set('bot.sessions.v1', {
      sessions: [{
        key: 'weixin:dm:friend_a',
        platform: 'weixin',
        chatId: 'friend_a',
        chatType: 'dm',
        threadId: 'thread_old',
        title: '旧对话',
        createdAt: '2026-06-11T00:00:00.000Z',
        updatedAt: '2026-06-11T00:00:00.000Z',
      }],
    });
    const runTurn = vi.fn(async () => ({ text: '已写入当前对话' }));
    const gateway = new BotGateway({
      store: store as unknown as ThreadStore,
      runTurn,
      send: vi.fn(async () => {}),
      preferredThreadId: 'thread_current',
      now: () => '2026-06-11T01:00:00.000Z',
      defaultWorkspaceRoot: '',
      locale: 'zh',
    });

    const result = await gateway.handleMessage({
      platform: 'weixin',
      chatType: 'dm',
      chatId: 'friend_a',
      userId: 'friend_a',
      userName: '张三',
      text: '这条应该进当前对话',
      messageId: 'msg_relink',
    });

    expect(result).toMatchObject({ status: 'completed', threadId: 'thread_current' });
    expect(runTurn).toHaveBeenCalledWith('thread_current', '这条应该进当前对话', expect.any(Object));
    expect(store.settings.get('bot.sessions.v1')).toMatchObject({
      sessions: [expect.objectContaining({ key: 'weixin:dm:friend_a', threadId: 'thread_current' })],
    });
  });

  it('can keep remote sessions independent even when a preferred thread is configured', async () => {
    const store = new MemoryBotStore();
    store.threads.set('thread_current', {
      threadId: 'thread_current',
      title: '当前桌面对话',
      workspaceRoot: '',
      status: 'active',
      turnCount: 0,
      createdAt: '2026-06-11T00:00:00.000Z',
      updatedAt: '2026-06-11T00:00:00.000Z',
      archivedAt: null,
      ephemeral: false,
      tags: {},
    });
    const runTurn = vi.fn(async () => ({ text: 'ok' }));
    let nextId = 0;
    const gateway = new BotGateway({
      store: store as unknown as ThreadStore,
      runTurn,
      send: vi.fn(async () => {}),
      preferredThreadId: 'thread_current',
      usePreferredThreadForSessions: false,
      now: () => '2026-06-11T01:00:00.000Z',
      createId: () => `thread_dingtalk_${++nextId}`,
      defaultWorkspaceRoot: '',
      locale: 'zh',
    });

    await gateway.handleMessage({
      platform: 'dingtalk',
      chatType: 'dm',
      chatId: 'user_a',
      userId: 'user_a',
      userName: '用户 A',
      text: '单聊任务',
      messageId: 'msg_dm',
    });
    await gateway.handleMessage({
      platform: 'dingtalk',
      chatType: 'group',
      chatId: 'group_a',
      userId: 'user_b',
      userName: '用户 B',
      text: '群里任务',
      messageId: 'msg_group',
    });

    expect(runTurn).toHaveBeenNthCalledWith(1, 'thread_dingtalk_1', '单聊任务', expect.any(Object));
    expect(runTurn).toHaveBeenNthCalledWith(2, 'thread_dingtalk_2', '群里任务', expect.any(Object));
    expect(store.settings.get('bot.sessions.v1')).toMatchObject({
      sessions: expect.arrayContaining([
        expect.objectContaining({ key: 'dingtalk:dm:user_a', threadId: 'thread_dingtalk_1' }),
        expect.objectContaining({ key: 'dingtalk:group:group_a', threadId: 'thread_dingtalk_2' }),
      ]),
    });
  });

  it('does not reuse a Weixin session whose Suanlizi thread was deleted', async () => {
    const store = new MemoryBotStore();
    store.settings.set('bot.sessions.v1', {
      sessions: [{
        key: 'weixin:dm:friend_a',
        platform: 'weixin',
        chatId: 'friend_a',
        chatType: 'dm',
        threadId: 'thread_deleted',
        title: '旧对话',
        createdAt: '2026-06-11T00:00:00.000Z',
        updatedAt: '2026-06-11T00:00:00.000Z',
      }],
    });
    const runTurn = vi.fn(async () => ({ text: '新对话收到' }));
    const gateway = new BotGateway({
      store: store as unknown as ThreadStore,
      runTurn,
      send: vi.fn(async () => {}),
      now: () => '2026-06-11T01:00:00.000Z',
      createId: () => 'thread_new',
      defaultWorkspaceRoot: '',
      defaultThreadTitle: '微信远程助手',
      singleBindingMode: true,
      locale: 'zh',
    });

    const result = await gateway.handleMessage({
      platform: 'weixin',
      chatType: 'dm',
      chatId: 'friend_a',
      userId: 'friend_a',
      userName: '张三',
      text: '绑定丢了也要继续',
      messageId: 'msg_recover_deleted',
    });

    expect(result).toMatchObject({ status: 'completed', threadId: 'thread_new' });
    expect(runTurn).toHaveBeenCalledWith('thread_new', '绑定丢了也要继续', expect.any(Object));
    expect(store.threads.get('thread_new')).toMatchObject({
      threadId: 'thread_new',
      title: '微信远程助手',
      workspaceRoot: '',
      tags: { botPlatform: 'weixin', botSessionKey: 'weixin:dm:friend_a' },
    });
    expect(store.settings.get('bot.sessions.v1')).toMatchObject({
      sessions: [expect.objectContaining({ key: 'weixin:dm:friend_a', threadId: 'thread_new' })],
    });
  });

  it('returns a busy reply when the session thread is already running', async () => {
    const store = new MemoryBotStore();
    store.settings.set('bot.sessions.v1', {
      sessions: [{
        key: 'weixin:group:room_1',
        platform: 'weixin',
        chatId: 'room_1',
        chatType: 'group',
        threadId: 'thread_busy',
        title: '项目群',
        createdAt: '2026-06-11T00:00:00.000Z',
        updatedAt: '2026-06-11T00:00:00.000Z',
      }],
    });
    const send = vi.fn(async () => {});
    const gateway = new BotGateway({
      store: store as unknown as ThreadStore,
      runTurn: vi.fn(async () => ({ text: 'never' })),
      send,
      isThreadRunning: () => true,
      now: () => '2026-06-11T00:00:00.000Z',
      createId: () => 'thread_busy',
      defaultWorkspaceRoot: 'E:\\langchain',
      locale: 'zh',
    });

    const result = await gateway.handleMessage({
      platform: 'weixin',
      chatType: 'group',
      chatId: 'room_1',
      userId: 'friend_a',
      userName: '张三',
      text: '新的任务',
      messageId: 'msg_busy',
    });

    expect(result.status).toBe('busy');
    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      chatId: 'room_1',
      text: expect.stringContaining('上一条'),
    }));
  });
});
