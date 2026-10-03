import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ThreadStore } from '@suanlizi/storage';
import type { ThreadEvent, ThreadMeta } from '@suanlizi/protocol';
import type { AgentRunConfig } from '../config/config.js';
import { handleBotRoute, shutdownAllDingtalkClients } from './botRoute.js';
import { BOT_CONFIG_KEY, DEFAULT_BOT_CONFIG } from '../config/botConfig.js';
import { DEFAULT_EPISODE_MEMORY_SETTINGS } from '@suanlizi/memory';

class BotRouteStore implements Partial<ThreadStore> {
  settings = new Map<string, unknown>();
  threads = new Map<string, ThreadMeta>();
  createdThreads: string[] = [];

  async getSetting<T = unknown>(key: string): Promise<T | null> {
    return (this.settings.get(key) as T | undefined) ?? null;
  }

  async setSetting(key: string, value: unknown): Promise<void> {
    this.settings.set(key, value);
  }

  async createThread(meta: { threadId: string }): Promise<void> {
    this.createdThreads.push(meta.threadId);
  }

  async getThread(threadId: string): Promise<ThreadMeta | null> {
    return this.threads.get(threadId) ?? null;
  }
}

function threadMeta(threadId: string, title = threadId): ThreadMeta {
  return {
    threadId,
    title,
    workspaceRoot: '',
    status: 'active',
    turnCount: 0,
    createdAt: '2026-06-11T00:00:00.000Z',
    updatedAt: '2026-06-11T00:00:00.000Z',
    archivedAt: null,
    ephemeral: false,
    tags: {},
  };
}

function req(method: string, path: string, body?: unknown): IncomingMessage {
  const chunks = body === undefined ? [] : [JSON.stringify(body)];
  return Object.assign(Readable.from(chunks), { method, url: path }) as IncomingMessage;
}

function res(): ServerResponse & { status?: number; body?: unknown } {
  const output = {
    writeHead(status: number) {
      output.status = status;
      return output;
    },
    end(raw: string) {
      output.body = raw ? JSON.parse(raw) : undefined;
    },
  } as unknown as ServerResponse & { status?: number; body?: unknown };
  return output;
}

function routePath(path: string) {
  const url = new URL(path, 'http://localhost');
  return { url, segments: url.pathname.split('/').filter(Boolean) };
}

const runConfig: AgentRunConfig = {
  hasWorkspace: true,
  workspaceRoot: 'E:\\langchain',
  provider: 'openai',
  model: 'test',
  baseUrl: '',
  permissions: 'workspace',
  accessPolicy: {
    mode: 'workspace',
    workspaceRoot: 'E:\\langchain',
    persistentRules: [],
    temporaryGrants: [],
  },
  dataDir: 'E:\\langchain\\.suanlizi',
  skillsRoot: 'C:\\Users\\test\\.suanlizi\\skills',
  webSearchMode: 'auto',
  webProvider: 'native_fetch',
  webProviderKeySource: 'config',
  reasoningEffort: 'medium',
  themeMode: 'light',
  memoryEnabled: true,
  autoExtractMemories: true,
  useColdMemories: true,
  memoryInjectLimit: 6,
  memoryTokenBudget: 1200,
  episodeMemoryEnabled: DEFAULT_EPISODE_MEMORY_SETTINGS.episodeMemoryEnabled,
  episodeInjectLimit: DEFAULT_EPISODE_MEMORY_SETTINGS.episodeInjectLimit,
  episodeTokenBudget: DEFAULT_EPISODE_MEMORY_SETTINGS.episodeTokenBudget,
  episodeSwitchCooldownTurns: DEFAULT_EPISODE_MEMORY_SETTINGS.episodeSwitchCooldownTurns,
  episodeSealIdleMinutes: DEFAULT_EPISODE_MEMORY_SETTINGS.episodeSealIdleMinutes,
  episodeColdAfterDays: DEFAULT_EPISODE_MEMORY_SETTINGS.episodeColdAfterDays,
  episodeFtsCandidateLimit: DEFAULT_EPISODE_MEMORY_SETTINGS.episodeFtsCandidateLimit,
  episodeRerankEnabled: DEFAULT_EPISODE_MEMORY_SETTINGS.episodeRerankEnabled,
      locale: 'zh',
      maxIterations: 100,
};

describe('bot route', () => {
  it('saves bot config and returns a masked public config', async () => {
    const store = new BotRouteStore();
    const response = res();
    const path = routePath('/api/bot/config');

    const handled = await handleBotRoute({
      req: req('PATCH', '/api/bot/config', { config: { weixin: { enabled: true, accountId: 'wx_account_123456' } } }),
      res: response,
      url: path.url,
      segments: path.segments,
      store: store as unknown as ThreadStore,
      getDefaultRunConfig: async () => runConfig,
      createAgent: vi.fn(),
    });

    expect(handled).toBe(true);
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ config: { weixin: { accountId: 'wx_a...3456' } } });
    expect(store.settings.get('bot.config.v1')).toMatchObject({ weixin: { accountId: 'wx_account_123456' } });
  });

  it('binds Weixin to the requested thread without clearing the logged-in account', async () => {
    const store = new BotRouteStore();
    store.settings.set('bot.config.v1', {
      ...DEFAULT_BOT_CONFIG,
      weixin: { ...DEFAULT_BOT_CONFIG.weixin, enabled: true, accountId: 'wx_account_123456', activeThreadId: 'old_thread' },
    });
    const response = res();
    const path = routePath('/api/bot/config');

    await handleBotRoute({
      req: req('PATCH', '/api/bot/config', { config: { weixin: { enabled: true, activeThreadId: 'thread_current' } } }),
      res: response,
      url: path.url,
      segments: path.segments,
      store: store as unknown as ThreadStore,
      getDefaultRunConfig: async () => runConfig,
      createAgent: vi.fn(),
    });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      config: { weixin: { accountId: 'wx_a...3456', activeThreadId: 'thread_current' } },
    });
    expect(store.settings.get('bot.config.v1')).toMatchObject({
      weixin: { accountId: 'wx_account_123456', activeThreadId: 'thread_current' },
    });
  });

  it('accepts the personal desktop Weixin bridge in local mode', async () => {
    const store = new BotRouteStore();
    const response = res();
    const path = routePath('/api/bot/config');

    await handleBotRoute({
      req: req('PATCH', '/api/bot/config', { config: { weixin: { enabled: true, bridgeMode: 'desktop_managed' } } }),
      res: response,
      url: path.url,
      segments: path.segments,
      store: store as unknown as ThreadStore,
      getDefaultRunConfig: async () => runConfig,
      createAgent: vi.fn(),
    });

    expect(response.status).toBe(200);
    expect(store.settings.get('bot.config.v1')).toMatchObject({ weixin: { enabled: true, bridgeMode: 'desktop_managed' } });
  });

  it('allows external RPC Weixin mode', async () => {
    const store = new BotRouteStore();
    const response = res();
    const path = routePath('/api/bot/config');

    await handleBotRoute({
      req: req('PATCH', '/api/bot/config', {
        config: {
          weixin: {
            enabled: true,
            bridgeMode: 'external_rpc',
            bridgeUrl: 'https://bot-gateway.example.com/rpc',
          },
        },
      }),
      res: response,
      url: path.url,
      segments: path.segments,
      store: store as unknown as ThreadStore,
      getDefaultRunConfig: async () => runConfig,
      createAgent: vi.fn(),
    });

    expect(response.status).toBe(200);
    expect(store.settings.get('bot.config.v1')).toMatchObject({
      weixin: {
        enabled: true,
        bridgeMode: 'external_rpc',
        bridgeUrl: 'https://bot-gateway.example.com/rpc',
      },
    });
  });

  it('reports Weixin bridge mode and monitor preference in status', async () => {
    const store = new BotRouteStore();
    store.settings.set('bot.config.v1', {
      ...DEFAULT_BOT_CONFIG,
      weixin: {
        ...DEFAULT_BOT_CONFIG.weixin,
        enabled: true,
        bridgeMode: 'desktop_managed',
        autoStartMonitor: false,
        syncHistoryOnConnect: true,
      },
    });
    const response = res();
    const path = routePath('/api/bot/status');

    await handleBotRoute({
      req: req('GET', '/api/bot/status'),
      res: response,
      url: path.url,
      segments: path.segments,
      store: store as unknown as ThreadStore,
      getDefaultRunConfig: async () => runConfig,
      createAgent: vi.fn(),
      createWeixinClient: () => ({ health: vi.fn(async () => ({ ok: true, managed: true })) } as never),
    });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      status: {
        weixin: {
          enabled: true,
          bridgeMode: 'desktop_managed',
          autoStartMonitor: false,
          syncHistoryOnConnect: true,
          bridge: 'online',
        },
      },
    });
  });

  it('does not treat an unmanaged service on the Weixin port as the Suanlizi desktop bridge', async () => {
    const store = new BotRouteStore();
    store.settings.set('bot.config.v1', {
      ...DEFAULT_BOT_CONFIG,
      weixin: {
        ...DEFAULT_BOT_CONFIG.weixin,
        enabled: true,
        bridgeMode: 'desktop_managed',
      },
    });
    const response = res();
    const path = routePath('/api/bot/status');

    await handleBotRoute({
      req: req('GET', '/api/bot/status'),
      res: response,
      url: path.url,
      segments: path.segments,
      store: store as unknown as ThreadStore,
      getDefaultRunConfig: async () => runConfig,
      createAgent: vi.fn(),
      createWeixinClient: () => ({
        health: vi.fn(async () => ({ ok: true, status: 'live' })),
      } as never),
    });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      status: {
        weixin: {
          bridge: 'offline',
          error: expect.stringContaining('non-Suanlizi service'),
        },
      },
    });
  });

  it('reports desktop Weixin bridge status in local mode', async () => {
    const store = new BotRouteStore();
    store.settings.set('bot.config.v1', {
      ...DEFAULT_BOT_CONFIG,
      weixin: {
        ...DEFAULT_BOT_CONFIG.weixin,
        enabled: true,
        bridgeMode: 'desktop_managed',
      },
    });
    const response = res();
    const path = routePath('/api/bot/status');
    const health = vi.fn(async () => ({ ok: true, managed: true }));

    await handleBotRoute({
      req: req('GET', '/api/bot/status'),
      res: response,
      url: path.url,
      segments: path.segments,
      store: store as unknown as ThreadStore,
      getDefaultRunConfig: async () => runConfig,
      createAgent: vi.fn(),
      createWeixinClient: () => ({ health } as never),
    });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      status: {
        weixin: {
          bridge: 'online',
        },
      },
    });
    expect(health).toHaveBeenCalled();
  });

  it('restores a desktop-managed Weixin account from bridge status', async () => {
    const store = new BotRouteStore();
    store.settings.set('bot.config.v1', {
      ...DEFAULT_BOT_CONFIG,
      weixin: {
        ...DEFAULT_BOT_CONFIG.weixin,
        enabled: true,
        accountId: '',
      },
    });
    const response = res();
    const path = routePath('/api/bot/status');

    await handleBotRoute({
      req: req('GET', '/api/bot/status'),
      res: response,
      url: path.url,
      segments: path.segments,
      store: store as unknown as ThreadStore,
      getDefaultRunConfig: async () => runConfig,
      createAgent: vi.fn(),
      createWeixinClient: () => ({
        health: vi.fn(async () => ({ ok: true, managed: true })),
        status: vi.fn(async () => ({ accounts: ['wx_restored'], monitors: [] })),
      } as never),
    });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      config: { weixin: { accountId: 'wx_r...ored' } },
      status: { weixin: { connected: true } },
    });
    expect(store.settings.get('bot.config.v1')).toMatchObject({
      weixin: { accountId: 'wx_restored' },
    });
  });

  it('starts Weixin monitor after a successful login when enabled', async () => {
    const store = new BotRouteStore();
    store.settings.set('bot.config.v1', {
      ...DEFAULT_BOT_CONFIG,
      weixin: { ...DEFAULT_BOT_CONFIG.weixin, autoStartMonitor: true },
    });
    const startMonitor = vi.fn(async () => ({ started: ['wx_1'] }));
    const response = res();
    const path = routePath('/api/bot/weixin/login/wait');

    await handleBotRoute({
      req: req('POST', '/api/bot/weixin/login/wait', { sessionKey: 'login_1' }),
      res: response,
      url: path.url,
      segments: path.segments,
      store: store as unknown as ThreadStore,
      getDefaultRunConfig: async () => runConfig,
      createAgent: vi.fn(),
      createWeixinClient: () => ({
        waitLogin: vi.fn(async () => ({ connected: true, accountId: 'wx_1' })),
        startMonitor,
      } as never),
    });

    expect(response.status).toBe(200);
    expect(store.settings.get('bot.config.v1')).toMatchObject({ weixin: { enabled: true, accountId: 'wx_1' } });
    expect(startMonitor).toHaveBeenCalledWith('wx_1', { syncHistory: true });
  });

  it('returns a structured result instead of 500 when Weixin login start fails', async () => {
    const store = new BotRouteStore();
    const response = res();
    const path = routePath('/api/bot/weixin/login/start');

    await handleBotRoute({
      req: req('POST', '/api/bot/weixin/login/start', { threadId: 'thread_1' }),
      res: response,
      url: path.url,
      segments: path.segments,
      store: store as unknown as ThreadStore,
      getDefaultRunConfig: async () => runConfig,
      createAgent: vi.fn(),
      createWeixinClient: () => ({
        startLogin: vi.fn(async () => {
          throw new Error('fetch failed');
        }),
      } as never),
    });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      ok: false,
      result: { message: expect.stringContaining('微信桥接服务不可用') },
    });
  });

  it('returns a structured result instead of 500 when Weixin login wait fails', async () => {
    const store = new BotRouteStore();
    const response = res();
    const path = routePath('/api/bot/weixin/login/wait');

    await handleBotRoute({
      req: req('POST', '/api/bot/weixin/login/wait', { sessionKey: 'login_1' }),
      res: response,
      url: path.url,
      segments: path.segments,
      store: store as unknown as ThreadStore,
      getDefaultRunConfig: async () => runConfig,
      createAgent: vi.fn(),
      createWeixinClient: () => ({
        waitLogin: vi.fn(async () => {
          throw new Error('已连接过此 OpenClaw');
        }),
      } as never),
    });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      ok: false,
      result: {
        connected: false,
        message: expect.stringContaining('无需重复扫码'),
      },
    });
  });

  it('logs out Weixin and clears the stored account', async () => {
    const store = new BotRouteStore();
    store.settings.set('bot.config.v1', {
      ...DEFAULT_BOT_CONFIG,
      weixin: { ...DEFAULT_BOT_CONFIG.weixin, enabled: true, accountId: 'wx_1', activeThreadId: 'thread_1' },
    });
    const stopMonitor = vi.fn(async () => ({ stopped: ['wx_1'] }));
    const logout = vi.fn(async () => ({ loggedOut: ['wx_1'] }));
    const response = res();
    const path = routePath('/api/bot/weixin/logout');

    await handleBotRoute({
      req: req('POST', '/api/bot/weixin/logout'),
      res: response,
      url: path.url,
      segments: path.segments,
      store: store as unknown as ThreadStore,
      getDefaultRunConfig: async () => runConfig,
      createAgent: vi.fn(),
      createWeixinClient: () => ({ stopMonitor, logout } as never),
    });

    expect(response.status).toBe(200);
    expect(stopMonitor).toHaveBeenCalledWith('wx_1');
    expect(logout).toHaveBeenCalledWith('wx_1');
    expect(store.settings.get('bot.config.v1')).toMatchObject({
      weixin: { enabled: false, accountId: '', activeThreadId: '' },
    });
  });

  it('runs a Weixin inbound message through BotGateway', async () => {
    const store = new BotRouteStore();
    store.settings.set('bot.config.v1', {
      ...DEFAULT_BOT_CONFIG,
      weixin: { ...DEFAULT_BOT_CONFIG.weixin, enabled: true, accountId: 'wx_account' },
    });
    const sendMessage = vi.fn(async () => ({ ok: true, messageId: 'sent_1' }));
    const published: ThreadEvent[] = [];
    const response = res();
    const path = routePath('/api/bot/weixin/message');

    await handleBotRoute({
      req: req('POST', '/api/bot/weixin/message', {
        chatId: 'friend_a',
        userId: 'friend_a',
        userName: '张三',
        text: '你好',
        messageId: 'msg_1',
        chatType: 'dm',
      }),
      res: response,
      url: path.url,
      segments: path.segments,
      store: store as unknown as ThreadStore,
      getDefaultRunConfig: async () => runConfig,
      createAgent: async () => ({
        agent: {
          getRuntimeState: () => ({ status: 'idle' }),
          runTurn: vi.fn(async () => ({
            items: [{ type: 'agent_message' as const, text: '收到', id: 'a', turnId: 't' }],
            usage: null,
          })),
        },
      }),
      createWeixinClient: () => ({ sendMessage } as never),
      publishEvent: (event) => published.push(event),
      createId: () => 'thread_bot',
      now: () => '2026-06-11T00:00:00.000Z',
    });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ result: { status: 'completed', threadId: 'thread_bot' } });
    expect(sendMessage).toHaveBeenCalledWith({ accountId: 'wx_account', to: 'friend_a', text: '收到' });
    expect(published).toEqual([
      expect.objectContaining({ type: 'item.completed', threadId: 'thread_bot', turnId: 't' }),
      expect.objectContaining({ type: 'turn.completed', threadId: 'thread_bot', turnId: 't', status: 'completed' }),
    ]);
  });

  it('routes Weixin inbound messages to the currently bound Suanlizi thread', async () => {
    const store = new BotRouteStore();
    store.threads.set('thread_bound', threadMeta('thread_bound', '绑定对话'));
    store.settings.set('bot.config.v1', {
      ...DEFAULT_BOT_CONFIG,
      weixin: { ...DEFAULT_BOT_CONFIG.weixin, enabled: true, accountId: 'wx_account', activeThreadId: 'thread_bound' },
    });
    const runTurn = vi.fn(async () => ({
      items: [{ type: 'agent_message' as const, text: '绑定对话收到', id: 'a', turnId: 't' }],
      usage: null,
    }));
    const response = res();
    const path = routePath('/api/bot/weixin/webhook');

    await handleBotRoute({
      req: req('POST', '/api/bot/weixin/webhook', {
        chatId: 'friend_a',
        senderId: 'friend_a',
        senderName: '张三',
        text: '进入当前绑定对话',
        messageId: 'msg_bound',
        chatType: 'dm',
        accountId: 'wx_account',
      }),
      res: response,
      url: path.url,
      segments: path.segments,
      store: store as unknown as ThreadStore,
      getDefaultRunConfig: async () => runConfig,
      createAgent: async () => ({
        agent: {
          getRuntimeState: () => ({ status: 'idle' }),
          runTurn,
        },
      }),
      createWeixinClient: () => ({ sendMessage: vi.fn() } as never),
      now: () => '2026-06-11T00:00:00.000Z',
    });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ result: { status: 'completed', threadId: 'thread_bound', reply: '绑定对话收到' } });
    expect(runTurn).toHaveBeenCalledWith('thread_bound', { type: 'text', text: '进入当前绑定对话' });
  });

  it('creates a pure chat and updates activeThreadId when the Weixin binding points to a deleted thread', async () => {
    const store = new BotRouteStore();
    store.settings.set('bot.config.v1', {
      ...DEFAULT_BOT_CONFIG,
      weixin: { ...DEFAULT_BOT_CONFIG.weixin, enabled: true, accountId: 'wx_account', activeThreadId: 'thread_deleted' },
    });
    const runTurn = vi.fn(async () => ({
      items: [{ type: 'agent_message' as const, text: '新纯对话收到', id: 'a', turnId: 't' }],
      usage: null,
    }));
    const response = res();
    const path = routePath('/api/bot/weixin/webhook');

    await handleBotRoute({
      req: req('POST', '/api/bot/weixin/webhook', {
        chatId: 'friend_a',
        senderId: 'friend_a',
        senderName: '张三',
        text: '绑定已删除后继续',
        messageId: 'msg_deleted_binding',
        chatType: 'dm',
        accountId: 'wx_account',
      }),
      res: response,
      url: path.url,
      segments: path.segments,
      store: store as unknown as ThreadStore,
      getDefaultRunConfig: async () => runConfig,
      createAgent: async () => ({
        agent: {
          getRuntimeState: () => ({ status: 'idle' }),
          runTurn,
        },
      }),
      createWeixinClient: () => ({ sendMessage: vi.fn() } as never),
      createId: () => 'thread_weixin_new',
      now: () => '2026-06-11T00:00:00.000Z',
    });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ result: { status: 'completed', threadId: 'thread_weixin_new', reply: '新纯对话收到' } });
    expect(runTurn).toHaveBeenCalledWith('thread_weixin_new', { type: 'text', text: '绑定已删除后继续' });
    expect(store.settings.get('bot.config.v1')).toMatchObject({
      weixin: { accountId: 'wx_account', activeThreadId: 'thread_weixin_new' },
    });
  });

  it('uses the bound thread run config for Weixin turns', async () => {
    const store = new BotRouteStore();
    store.threads.set('thread_bound', threadMeta('thread_bound', '绑定对话'));
    store.settings.set('bot.config.v1', {
      ...DEFAULT_BOT_CONFIG,
      weixin: { ...DEFAULT_BOT_CONFIG.weixin, enabled: true, accountId: 'wx_account', activeThreadId: 'thread_bound' },
    });
    const createAgent = vi.fn(async () => ({
      agent: {
        getRuntimeState: () => ({ status: 'idle' }),
        runTurn: vi.fn(async () => ({
          items: [{ type: 'agent_message' as const, text: '使用线程配置', id: 'a', turnId: 't' }],
          usage: null,
        })),
      },
    }));
    const response = res();
    const path = routePath('/api/bot/weixin/webhook');

    await handleBotRoute({
      req: req('POST', '/api/bot/weixin/webhook', {
        chatId: 'friend_a',
        senderId: 'friend_a',
        text: '看配置',
        messageId: 'msg_config',
        chatType: 'dm',
        accountId: 'wx_account',
      }),
      res: response,
      url: path.url,
      segments: path.segments,
      store: store as unknown as ThreadStore,
      getDefaultRunConfig: async () => runConfig,
      getThreadRunConfig: async () => ({ ...runConfig, model: 'thread-model', permissions: 'read_only' }),
      createAgent,
      createWeixinClient: () => ({ sendMessage: vi.fn() } as never),
      now: () => '2026-06-11T00:00:00.000Z',
    });

    expect(response.status).toBe(200);
    expect(createAgent).toHaveBeenCalledWith(expect.objectContaining({
      model: 'thread-model',
      permissions: 'read_only',
    }));
  });

  it('accepts bridge webhook messages and falls back to inbound account id for replies', async () => {
    const store = new BotRouteStore();
    store.settings.set('bot.config.v1', {
      ...DEFAULT_BOT_CONFIG,
      weixin: { ...DEFAULT_BOT_CONFIG.weixin, enabled: true, accountId: '' },
    });
    const sendMessage = vi.fn(async () => ({ ok: true, messageId: 'sent_1' }));
    const response = res();
    const path = routePath('/api/bot/weixin/webhook');

    await handleBotRoute({
      req: req('POST', '/api/bot/weixin/webhook', {
        chatId: 'friend_a',
        senderId: 'friend_a',
        senderName: '张三',
        text: '你好',
        messageId: 'msg_1',
        chatType: 'dm',
        accountId: 'wx_from_bridge',
      }),
      res: response,
      url: path.url,
      segments: path.segments,
      store: store as unknown as ThreadStore,
      getDefaultRunConfig: async () => runConfig,
      createAgent: async () => ({
        agent: {
          getRuntimeState: () => ({ status: 'idle' }),
          runTurn: vi.fn(async () => ({
            items: [{ type: 'agent_message' as const, text: '收到', id: 'a', turnId: 't' }],
            usage: null,
          })),
        },
      }),
      createWeixinClient: () => ({ sendMessage } as never),
      createId: () => 'thread_bot',
      now: () => '2026-06-11T00:00:00.000Z',
    });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ result: { status: 'completed', threadId: 'thread_bot', reply: '收到' } });
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('accepts numeric Weixin message ids from the bridge', async () => {
    const store = new BotRouteStore();
    store.settings.set('bot.config.v1', {
      ...DEFAULT_BOT_CONFIG,
      weixin: { ...DEFAULT_BOT_CONFIG.weixin, enabled: true, accountId: 'wx_account' },
    });
    const sendMessage = vi.fn(async () => ({ ok: true, messageId: 'sent_1' }));
    const response = res();
    const path = routePath('/api/bot/weixin/webhook');

    await handleBotRoute({
      req: req('POST', '/api/bot/weixin/webhook', {
        chatId: 12345,
        userId: 12345,
        text: '你好',
        messageId: 987654321,
        chatType: 'dm',
        accountId: 'wx_account',
      }),
      res: response,
      url: path.url,
      segments: path.segments,
      store: store as unknown as ThreadStore,
      getDefaultRunConfig: async () => runConfig,
      createAgent: async () => ({
        agent: {
          getRuntimeState: () => ({ status: 'idle' }),
          runTurn: vi.fn(async () => ({
            items: [{ type: 'agent_message' as const, text: '收到', id: 'a', turnId: 't' }],
            usage: null,
          })),
        },
      }),
      createWeixinClient: () => ({ sendMessage } as never),
      createId: () => 'thread_bot',
      now: () => '2026-06-11T00:00:00.000Z',
    });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ result: { status: 'completed', threadId: 'thread_bot', reply: '收到' } });
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('routes DingTalk DM group-send requests through an agent-visible tool instead of keyword forwarding', async () => {
    shutdownAllDingtalkClients();
    const store = new BotRouteStore();
    store.settings.set(BOT_CONFIG_KEY, {
      ...DEFAULT_BOT_CONFIG,
      dingtalk: {
        ...DEFAULT_BOT_CONFIG.dingtalk,
        enabled: true,
        connectionMode: 'webhook',
        clientId: 'ding_app_key',
        clientSecret: 'ding_app_secret',
        robotCode: 'ding_robot',
        targetGroupName: '打完我去打DD·',
        targetGroupConversationId: 'cid_group_target',
      },
    });
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const href = String(url);
      if (href.endsWith('/v1.0/oauth2/accessToken')) {
        return new Response(JSON.stringify({ accessToken: 'token_1', expireIn: 7200 }), { status: 200 });
      }
      if (href.endsWith('/v1.0/robot/oToMessages/batchSend')) {
        return new Response(JSON.stringify({ processQueryKey: 'dm_reply' }), { status: 200 });
      }
      throw new Error(`unexpected fetch ${href}`);
    });
    const runTurn = vi.fn(async () => ({
      items: [{ type: 'agent_message' as const, text: '我已经通过工具发送到目标群。', id: 'a', turnId: 't' }],
      usage: null,
    }));
    const createAgent = vi.fn(async (config) => ({
      agent: {
        getRuntimeState: () => ({ status: 'idle' }),
        runTurn,
      },
      debugConfig: config,
    }));
    const response = res();
    const path = routePath('/api/bot/dingtalk/webhook');

    await handleBotRoute({
      req: req('POST', '/api/bot/dingtalk/webhook', {
        msgtype: 'text',
        text: { content: '发到群“打完我去打DD·”一条消息：“安博威的爸爸”' },
        msgId: 'msg_forward_1',
        conversationType: '1',
        conversationId: 'cid_dm_ignored',
        senderStaffId: 'staff_1',
        senderNick: '张三',
      }),
      res: response,
      url: path.url,
      segments: path.segments,
      store: store as unknown as ThreadStore,
      getDefaultRunConfig: async () => runConfig,
      createAgent,
    });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ result: { status: 'completed', reply: '我已经通过工具发送到目标群。' } });
    expect(runTurn).toHaveBeenCalledWith(expect.any(String), {
      type: 'text',
      text: '发到群“打完我去打DD·”一条消息：“安博威的爸爸”',
    });
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/v1.0/robot/groupMessages/send'))).toBe(false);
    const agentConfig = createAgent.mock.calls
      .map((call) => call[0] as Record<string, unknown>)
      .find((config) => config.systemPromptSuffix);
    expect(agentConfig).toBeTruthy();
    const runtimeConfig = agentConfig!;
    expect(runtimeConfig.systemPromptSuffix).toEqual(expect.stringContaining('dingtalk'));
    expect(runtimeConfig.systemPromptSuffix).toEqual(expect.stringContaining('send_message'));
    expect(runtimeConfig.systemPromptSuffix).toEqual(expect.stringContaining('不要搜索代码'));
    const tools = runtimeConfig.tools as { get(name: string): unknown } | undefined;
    expect(tools?.get('dingtalk')).toBeTruthy();
    expect(tools?.get('dingtalk_forward_to_group')).toBeUndefined();
    expect(tools?.get('current_time')).toBeTruthy();
    expect(tools?.get('read_file')).toBeUndefined();
    expect(tools?.get('search_content')).toBeUndefined();
    expect(tools?.get('web_search')).toBeUndefined();
    expect(tools?.get('shell_command')).toBeUndefined();
    expect(tools?.get('apply_patch')).toBeUndefined();
    fetchMock.mockRestore();
    shutdownAllDingtalkClients();
  });

  it('relinks DingTalk DM sessions to the configured active Suanlizi thread', async () => {
    shutdownAllDingtalkClients();
    const store = new BotRouteStore();
    store.threads.set('thread_current', threadMeta('thread_current', '当前钉钉对话'));
    store.threads.set('thread_old', threadMeta('thread_old', '旧钉钉对话'));
    store.settings.set('bot.sessions.v1', {
      sessions: [{
        key: 'account:ding_app_key:dingtalk:dm:staff_1',
        platform: 'dingtalk',
        chatId: 'staff_1',
        chatType: 'dm',
        threadId: 'thread_old',
        title: '旧钉钉对话',
        createdAt: '2026-06-11T00:00:00.000Z',
        updatedAt: '2026-06-11T00:00:00.000Z',
      }],
    });
    store.settings.set(BOT_CONFIG_KEY, {
      ...DEFAULT_BOT_CONFIG,
      dingtalk: {
        ...DEFAULT_BOT_CONFIG.dingtalk,
        enabled: true,
        connectionMode: 'webhook',
        clientId: 'ding_app_key',
        clientSecret: 'ding_app_secret',
        robotCode: 'ding_robot',
        activeThreadId: 'thread_current',
      },
    });
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const href = String(url);
      if (href.endsWith('/v1.0/oauth2/accessToken')) {
        return new Response(JSON.stringify({ accessToken: 'token_1', expireIn: 7200 }), { status: 200 });
      }
      if (href.endsWith('/v1.0/robot/oToMessages/batchSend')) {
        return new Response(JSON.stringify({ processQueryKey: 'dm_reply' }), { status: 200 });
      }
      throw new Error(`unexpected fetch ${href}`);
    });
    const runTurn = vi.fn(async () => ({
      items: [{ type: 'agent_message' as const, text: '当前对话收到', id: 'a', turnId: 't' }],
      usage: null,
    }));
    const createAgent = vi.fn(async () => ({
      agent: {
        getRuntimeState: () => ({ status: 'idle' }),
        runTurn,
      },
    }));
    const response = res();
    const path = routePath('/api/bot/dingtalk/webhook');

    await handleBotRoute({
      req: req('POST', '/api/bot/dingtalk/webhook', {
        msgtype: 'text',
        text: { content: '这条应该进新绑定的 Suanlizi 对话' },
        msgId: 'msg_ding_relink',
        conversationType: '1',
        senderStaffId: 'staff_1',
        senderNick: '张三',
      }),
      res: response,
      url: path.url,
      segments: path.segments,
      store: store as unknown as ThreadStore,
      getDefaultRunConfig: async () => runConfig,
      createAgent,
      now: () => '2026-06-11T01:00:00.000Z',
    });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ result: { status: 'completed', threadId: 'thread_current' } });
    expect(runTurn).toHaveBeenCalledWith('thread_current', {
      type: 'text',
      text: '这条应该进新绑定的 Suanlizi 对话',
    });
    expect(store.settings.get('bot.sessions.v1')).toMatchObject({
      sessions: [expect.objectContaining({
        key: 'account:ding_app_key:dingtalk:dm:staff_1',
        threadId: 'thread_current',
        title: '当前钉钉对话',
      })],
    });
    fetchMock.mockRestore();
    shutdownAllDingtalkClients();
  });

  it('lets the DingTalk agent tool send to the configured target group', async () => {
    shutdownAllDingtalkClients();
    const store = new BotRouteStore();
    store.settings.set(BOT_CONFIG_KEY, {
      ...DEFAULT_BOT_CONFIG,
      dingtalk: {
        ...DEFAULT_BOT_CONFIG.dingtalk,
        enabled: true,
        connectionMode: 'webhook',
        clientId: 'ding_app_key',
        clientSecret: 'ding_app_secret',
        robotCode: 'ding_robot',
        targetGroupName: '打完我去打DD·',
        targetGroupConversationId: 'cid_group_target',
      },
    });
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, _init) => {
      const href = String(url);
      if (href.endsWith('/v1.0/oauth2/accessToken')) {
        return new Response(JSON.stringify({ accessToken: 'token_1', expireIn: 7200 }), { status: 200 });
      }
      if (href.endsWith('/v1.0/robot/groupMessages/send')) {
        return new Response(JSON.stringify({ processQueryKey: 'group_sent' }), { status: 200 });
      }
      throw new Error(`unexpected fetch ${href}`);
    });
    const createAgent = vi.fn(async (config) => {
      const tools = config.tools as { execute(name: string, args: Record<string, unknown>, ctx: Record<string, unknown>): Promise<unknown> };
      const toolResult = await tools.execute('dingtalk', { action: 'send_message', message: '安博威的爸爸', mentions: [] }, {
        workspaceRoot: '',
        threadId: 'thread_ding',
        turnId: 'turn_1',
        approved: false,
      });
      return {
        agent: {
          getRuntimeState: () => ({ status: 'idle' }),
          runTurn: vi.fn(async () => ({
            items: [{ type: 'agent_message' as const, text: `工具结果：${JSON.stringify(toolResult)}`, id: 'a', turnId: 't' }],
            usage: null,
          })),
        },
      };
    });
    const response = res();
    const path = routePath('/api/bot/dingtalk/webhook');

    await handleBotRoute({
      req: req('POST', '/api/bot/dingtalk/webhook', {
        msgtype: 'text',
        text: { content: '发到群“打完我去打DD·”一条消息：“安博威的爸爸”' },
        msgId: 'msg_forward_tool',
        conversationType: '1',
        senderStaffId: 'staff_1',
      }),
      res: response,
      url: path.url,
      segments: path.segments,
      store: store as unknown as ThreadStore,
      getDefaultRunConfig: async () => runConfig,
      createAgent,
    });

    expect(response.status).toBe(200);
    expect(createAgent).toHaveBeenCalled();
    const groupCall = fetchMock.mock.calls.find(([url]) => String(url).includes('/v1.0/robot/groupMessages/send'));
    expect(groupCall).toBeTruthy();
    expect(JSON.parse(String(groupCall?.[1]?.body ?? '{}'))).toMatchObject({
      openConversationId: 'cid_group_target',
      robotCode: 'ding_robot',
      msgKey: 'sampleMarkdown',
      msgParam: JSON.stringify({ title: 'Suanlizi', text: '安博威的爸爸' }),
    });
    const reply = (response.body as { result?: { reply?: string } }).result?.reply ?? '';
    expect(reply).not.toContain('cid_group_target');
    expect(reply).not.toContain('group_sent');
    expect(reply).not.toContain('processQueryKey');
    expect(reply).not.toContain('messageId');
    fetchMock.mockRestore();
    shutdownAllDingtalkClients();
  });

  it('lets DingTalk DM follow-up requests forward the recent DM attachment to the configured group', async () => {
    shutdownAllDingtalkClients();
    const store = new BotRouteStore();
    store.settings.set(BOT_CONFIG_KEY, {
      ...DEFAULT_BOT_CONFIG,
      dingtalk: {
        ...DEFAULT_BOT_CONFIG.dingtalk,
        enabled: true,
        connectionMode: 'webhook',
        clientId: 'ding_app_key',
        clientSecret: 'ding_app_secret',
        robotCode: 'ding_robot',
        targetGroupName: '打完我去打DD·',
        targetGroupConversationId: 'cid_group_target',
      },
    });
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      const href = String(url);
      if (href.endsWith('/v1.0/oauth2/accessToken')) {
        return new Response(JSON.stringify({ accessToken: 'token_1', expireIn: 7200 }), { status: 200 });
      }
      if (href.endsWith('/v1.0/robot/oToMessages/batchSend')) {
        return new Response(JSON.stringify({ processQueryKey: 'dm_reply' }), { status: 200 });
      }
      if (href.endsWith('/v1.0/robot/messageFiles/download')) {
        const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
        expect(body).toMatchObject({ downloadCode: 'download-code-1', robotCode: 'ding_robot' });
        return new Response(JSON.stringify({ downloadUrl: 'https://files.example.test/file-1' }), { status: 200 });
      }
      if (href === 'https://files.example.test/file-1') {
        return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
      }
      if (href.startsWith('https://oapi.dingtalk.com/gettoken')) {
        return new Response(JSON.stringify({ errcode: 0, access_token: 'oapi-token', expires_in: 7200 }), { status: 200 });
      }
      if (href.startsWith('https://oapi.dingtalk.com/media/upload')) {
        return new Response(JSON.stringify({ errcode: 0, media_id: 'media_file_1' }), { status: 200 });
      }
      if (href.endsWith('/v1.0/robot/groupMessages/send')) {
        return new Response(JSON.stringify({ processQueryKey: 'group_file_sent' }), { status: 200 });
      }
      throw new Error(`unexpected fetch ${href}`);
    });
    const createAgent = vi.fn(async (config) => {
      const tools = config.tools as { execute(name: string, args: Record<string, unknown>, ctx: Record<string, unknown>): Promise<unknown> };
      return {
        agent: {
          getRuntimeState: () => ({ status: 'idle' }),
          runTurn: vi.fn(async (_threadId: string, input: { type: 'text'; text: string }) => {
            if (input.text.includes('发群')) {
              const toolResult = await tools.execute('dingtalk', {
                action: 'send_message',
                fileMode: 'current_message_files',
                message: '',
              }, {
                workspaceRoot: '',
                threadId: 'thread_ding',
                turnId: 'turn_1',
                approved: false,
              });
              return {
                items: [{ type: 'agent_message' as const, text: `工具结果：${JSON.stringify(toolResult)}`, id: 'a', turnId: 't' }],
                usage: null,
              };
            }
            return {
              items: [{ type: 'agent_message' as const, text: '收到文件', id: 'a', turnId: 't' }],
              usage: null,
            };
          }),
        },
      };
    });
    const path = routePath('/api/bot/dingtalk/webhook');

    await handleBotRoute({
      req: req('POST', '/api/bot/dingtalk/webhook', {
        msgtype: 'file',
        msgId: 'msg_file_1',
        conversationType: '1',
        senderStaffId: 'staff_1',
        senderNick: '张三',
        fileContent: {
          fileName: '方案.pdf',
          fileSize: 3,
          downloadCode: 'download-code-1',
          mimeType: 'application/pdf',
        },
      }),
      res: res(),
      url: path.url,
      segments: path.segments,
      store: store as unknown as ThreadStore,
      getDefaultRunConfig: async () => runConfig,
      createAgent,
      createId: () => 'thread_ding',
    });
    const response = res();
    await handleBotRoute({
      req: req('POST', '/api/bot/dingtalk/webhook', {
        msgtype: 'text',
        text: { content: '把这个文件发群里' },
        msgId: 'msg_file_forward_1',
        conversationType: '1',
        senderStaffId: 'staff_1',
        senderNick: '张三',
      }),
      res: response,
      url: path.url,
      segments: path.segments,
      store: store as unknown as ThreadStore,
      getDefaultRunConfig: async () => runConfig,
      createAgent,
      createId: () => 'thread_ding',
    });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ result: { status: 'completed' } });
    const groupSendCall = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/v1.0/robot/groupMessages/send'));
    expect(groupSendCall).toBeTruthy();
    const groupBody = JSON.parse(String(groupSendCall?.[1]?.body)) as Record<string, unknown>;
    expect(groupBody).toMatchObject({
      openConversationId: 'cid_group_target',
      msgKey: 'sampleFile',
      robotCode: 'ding_robot',
    });
    expect(JSON.parse(String(groupBody.msgParam))).toMatchObject({
      fileUrl: 'media_file_1',
      fileName: '方案.pdf',
      fileSize: '3',
    });
    fetchMock.mockRestore();
    shutdownAllDingtalkClients();
  });

  it('does not echo internal DingTalk tool redaction text back to the user', async () => {
    shutdownAllDingtalkClients();
    const store = new BotRouteStore();
    store.settings.set(BOT_CONFIG_KEY, {
      ...DEFAULT_BOT_CONFIG,
      dingtalk: {
        ...DEFAULT_BOT_CONFIG.dingtalk,
        enabled: true,
        connectionMode: 'webhook',
        clientId: 'ding_app_key',
        clientSecret: 'ding_app_secret',
        robotCode: 'ding_robot',
        targetGroupName: '打完我去打DD·',
        targetGroupConversationId: 'cid_group_target',
      },
    });
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const href = String(url);
      if (href.endsWith('/v1.0/oauth2/accessToken')) {
        return new Response(JSON.stringify({ accessToken: 'token_1', expireIn: 7200 }), { status: 200 });
      }
      if (href.endsWith('/v1.0/robot/oToMessages/batchSend')) {
        return new Response(JSON.stringify({ processQueryKey: 'dm_reply' }), { status: 200 });
      }
      throw new Error(`unexpected fetch ${href}`);
    });
    const createAgent = vi.fn(async () => ({
      agent: {
        getRuntimeState: () => ({ status: 'idle' }),
        runTurn: vi.fn(async () => ({
          items: [{
            type: 'agent_message' as const,
            text: [
              '好的，马上发！',
              '',
              '[Tool dingtalk completed]',
              'DingTalk tool result redacted. Do not reuse this prior tool call or reveal internal routing details.',
              '',
              '已发送！在群里艾特了安博巍。',
            ].join('\n'),
            id: 'a',
            turnId: 't',
          }],
          usage: null,
        })),
      },
    }));
    const response = res();
    const path = routePath('/api/bot/dingtalk/webhook');

    await handleBotRoute({
      req: req('POST', '/api/bot/dingtalk/webhook', {
        msgtype: 'text',
        text: { content: '群里@一下安博巍，消息是“收到爸爸的艾特了吗”' },
        msgId: 'msg_forward_redaction_leak',
        conversationType: '1',
        conversationId: 'cid_dm',
        senderStaffId: 'staff_1',
        senderNick: '安博巍',
      }),
      res: response,
      url: path.url,
      segments: path.segments,
      store: store as unknown as ThreadStore,
      getDefaultRunConfig: async () => runConfig,
      createAgent,
    });

    const reply = (response.body as { result?: { reply?: string } }).result?.reply ?? '';
    expect(reply).not.toContain('[Tool dingtalk');
    expect(reply).not.toContain('DingTalk tool result redacted');
    expect(reply).not.toContain('internal routing');
    expect(reply).toBe('已发送！在群里艾特了安博巍。');
    fetchMock.mockRestore();
    shutdownAllDingtalkClients();
  });

  it('does not inject stale DingTalk group-send payloads into an unrelated current turn', async () => {
    shutdownAllDingtalkClients();
    const store = new BotRouteStore();
    store.settings.set(BOT_CONFIG_KEY, {
      ...DEFAULT_BOT_CONFIG,
      dingtalk: {
        ...DEFAULT_BOT_CONFIG.dingtalk,
        enabled: true,
        connectionMode: 'webhook',
        clientId: 'ding_app_key',
        clientSecret: 'ding_app_secret',
        robotCode: 'ding_robot',
        targetGroupName: '打完我去打DD·',
        targetGroupConversationId: 'cid_group_target',
      },
    });
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const href = String(url);
      if (href.endsWith('/v1.0/oauth2/accessToken')) {
        return new Response(JSON.stringify({ accessToken: 'token_1', expireIn: 7200 }), { status: 200 });
      }
      if (href.endsWith('/v1.0/robot/oToMessages/batchSend')) {
        return new Response(JSON.stringify({ processQueryKey: 'dm_reply' }), { status: 200 });
      }
      throw new Error(`unexpected fetch ${href}`);
    });
    const createAgent = vi.fn(async (config: Record<string, unknown>) => {
      const tools = config.tools as { get(name: string): unknown } | undefined;
      expect(tools?.get('dingtalk')).toBeTruthy();
      expect(String(config.systemPromptSuffix)).not.toContain('安博威的爸爸');
      return {
        agent: {
          getRuntimeState: () => ({ status: 'idle' }),
          runTurn: vi.fn(async () => ({
            items: [{ type: 'agent_message' as const, text: '现在是北京时间 2026年6月27日 周六 晚上 23:05。', id: 'a', turnId: 't' }],
            usage: null,
          })),
        },
      };
    });
    const response = res();
    const path = routePath('/api/bot/dingtalk/webhook');

    await handleBotRoute({
      req: req('POST', '/api/bot/dingtalk/webhook', {
        msgtype: 'text',
        text: { content: '现在几点了？' },
        msgId: 'msg_time_only',
        conversationType: '1',
        senderStaffId: 'staff_1',
      }),
      res: response,
      url: path.url,
      segments: path.segments,
      store: store as unknown as ThreadStore,
      getDefaultRunConfig: async () => runConfig,
      createAgent,
    });

    expect(response.status).toBe(200);
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/v1.0/robot/groupMessages/send'))).toBe(false);
    fetchMock.mockRestore();
    shutdownAllDingtalkClients();
  });

  it('records a detected DingTalk group conversation id from group mentions', async () => {
    shutdownAllDingtalkClients();
    const store = new BotRouteStore();
    store.settings.set(BOT_CONFIG_KEY, {
      ...DEFAULT_BOT_CONFIG,
      dingtalk: {
        ...DEFAULT_BOT_CONFIG.dingtalk,
        enabled: true,
        connectionMode: 'webhook',
        clientId: 'ding_app_key',
        clientSecret: 'ding_app_secret',
        robotCode: 'ding_robot',
      },
    });
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const href = String(url);
      if (href.endsWith('/v1.0/oauth2/accessToken')) {
        return new Response(JSON.stringify({ accessToken: 'token_1', expireIn: 7200 }), { status: 200 });
      }
      if (href.endsWith('/v1.0/robot/groupMessages/send')) {
        return new Response(JSON.stringify({ processQueryKey: 'group_reply' }), { status: 200 });
      }
      throw new Error(`unexpected fetch ${href}`);
    });
    const response = res();
    const path = routePath('/api/bot/dingtalk/webhook');

    await handleBotRoute({
      req: req('POST', '/api/bot/dingtalk/webhook', {
        msgtype: 'text',
        text: { content: '@机器人 记一下这个群' },
        msgId: 'msg_group_detect',
        conversationType: '2',
        conversationId: 'cid_group_detected',
        sessionWebhook: 'https://oapi.dingtalk.com/robot/send?access_token=session-token',
        senderStaffId: 'staff_1',
        chatbotUserId: 'bot_user',
        atUsers: [{ dingtalkId: 'bot_user', staffId: 'bot_staff' }],
      }),
      res: response,
      url: path.url,
      segments: path.segments,
      store: store as unknown as ThreadStore,
      getDefaultRunConfig: async () => runConfig,
      createAgent: async () => ({
        agent: {
          getRuntimeState: () => ({ status: 'idle' }),
          runTurn: vi.fn(async () => ({
            items: [{ type: 'agent_message' as const, text: '已记录', id: 'a', turnId: 't' }],
            usage: null,
          })),
        },
      }),
      createId: () => 'thread_ding_group',
      now: () => '2026-06-27T00:00:00.000Z',
    });

    expect(response.status).toBe(200);
    expect(store.settings.get(BOT_CONFIG_KEY)).toMatchObject({
      dingtalk: {
        targetGroupConversationId: 'cid_group_detected',
        targetGroupSessionWebhook: 'https://oapi.dingtalk.com/robot/send?access_token=session-token',
        lastDetectedGroupConversationId: 'cid_group_detected',
        lastDetectedGroupSessionWebhook: 'https://oapi.dingtalk.com/robot/send?access_token=session-token',
        lastDetectedGroupAt: '2026-06-27T00:00:00.000Z',
      },
    });
    fetchMock.mockRestore();
    shutdownAllDingtalkClients();
  });

  it('unified dingtalk tool includes dws capabilities when dwsCli is enabled', async () => {
    shutdownAllDingtalkClients();
    const store = new BotRouteStore();
    store.settings.set(BOT_CONFIG_KEY, {
      ...DEFAULT_BOT_CONFIG,
      dingtalk: {
        ...DEFAULT_BOT_CONFIG.dingtalk,
        enabled: true,
        connectionMode: 'webhook',
        clientId: 'ding_app_key',
        clientSecret: 'ding_app_secret',
        robotCode: 'ding_robot',
        targetGroupName: '测试群',
        targetGroupConversationId: 'cid_group_target',
      },
      dwsCli: {
        enabled: true,
        binaryPath: '/usr/local/bin/dws',
        clientId: 'dws_client_id',
        clientSecret: 'dws_client_secret',
      },
    });
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const href = String(url);
      if (href.endsWith('/v1.0/oauth2/accessToken')) {
        return new Response(JSON.stringify({ accessToken: 'token_1', expireIn: 7200 }), { status: 200 });
      }
      if (href.endsWith('/v1.0/robot/oToMessages/batchSend')) {
        return new Response(JSON.stringify({ processQueryKey: 'dm_reply' }), { status: 200 });
      }
      throw new Error(`unexpected fetch ${href}`);
    });
    const runTurn = vi.fn(async () => ({
      items: [{ type: 'agent_message' as const, text: '好的，我来执行 dws 命令。', id: 'a', turnId: 't' }],
      usage: null,
    }));
    const createAgent = vi.fn(async (config) => ({
      agent: {
        getRuntimeState: () => ({ status: 'idle' }),
        runTurn,
      },
      debugConfig: config,
    }));
    const response = res();
    const path = routePath('/api/bot/dingtalk/webhook');

    await handleBotRoute({
      req: req('POST', '/api/bot/dingtalk/webhook', {
        msgtype: 'text',
        text: { content: '用 dws 查一下今天的日程' },
        msgId: 'msg_dws_1',
        conversationType: '1',
        conversationId: 'cid_dm_test',
        senderStaffId: 'staff_1',
        senderNick: '测试用户',
      }),
      res: response,
      url: path.url,
      segments: path.segments,
      store: store as unknown as ThreadStore,
      getDefaultRunConfig: async () => runConfig,
      createAgent,
    });

    expect(response.status).toBe(200);
    const agentConfig = createAgent.mock.calls
      .map((call) => call[0] as Record<string, unknown>)
      .find((config) => config.systemPromptSuffix);
    expect(agentConfig).toBeTruthy();
    const runtimeConfig = agentConfig!;
    const tools = runtimeConfig.tools as { get(name: string): { parameters: Record<string, unknown> } | undefined } | undefined;

    // 验证只有一个统一的 dingtalk 工具，没有独立的 dws 工具
    expect(tools?.get('dingtalk')).toBeTruthy();
    expect(tools?.get('dws_exec')).toBeUndefined();
    expect(tools?.get('dws_schema')).toBeUndefined();
    expect(tools?.get('dws_auth_status')).toBeUndefined();
    expect(tools?.get('dingtalk_forward_to_group')).toBeUndefined();

    // 验证统一工具包含 dws 相关参数
    const dingtalkTool = tools?.get('dingtalk');
    expect(dingtalkTool?.parameters).toBeTruthy();
    const params = dingtalkTool!.parameters as { properties?: Record<string, { enum?: string[] }> };
    expect(params.properties?.action).toBeTruthy();
    expect(params.properties?.dwsArgs).toBeTruthy();
    expect(params.properties?.dwsDryRun).toBeTruthy();
    expect(params.properties?.dwsJq).toBeTruthy();
    expect(params.properties?.dwsToolPath).toBeTruthy();

    // 验证系统提示中包含 dws 相关说明
    expect(runtimeConfig.systemPromptSuffix).toEqual(expect.stringContaining('企业数据操作'));
    expect(runtimeConfig.systemPromptSuffix).toEqual(expect.stringContaining('dws_exec'));

    // 验证 current_time 仍然存在
    expect(tools?.get('current_time')).toBeTruthy();

    fetchMock.mockRestore();
    shutdownAllDingtalkClients();
  });

  it('unified dingtalk tool works with send_message when dwsCli is disabled', async () => {
    shutdownAllDingtalkClients();
    const store = new BotRouteStore();
    store.settings.set(BOT_CONFIG_KEY, {
      ...DEFAULT_BOT_CONFIG,
      dingtalk: {
        ...DEFAULT_BOT_CONFIG.dingtalk,
        enabled: true,
        connectionMode: 'webhook',
        clientId: 'ding_app_key',
        clientSecret: 'ding_app_secret',
        robotCode: 'ding_robot',
        targetGroupName: '测试群',
        targetGroupConversationId: 'cid_group_target',
      },
      dwsCli: {
        enabled: false,
        binaryPath: '',
        clientId: '',
        clientSecret: '',
      },
    });
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const href = String(url);
      if (href.endsWith('/v1.0/oauth2/accessToken')) {
        return new Response(JSON.stringify({ accessToken: 'token_1', expireIn: 7200 }), { status: 200 });
      }
      if (href.endsWith('/v1.0/robot/oToMessages/batchSend')) {
        return new Response(JSON.stringify({ processQueryKey: 'dm_reply' }), { status: 200 });
      }
      throw new Error(`unexpected fetch ${href}`);
    });
    const runTurn = vi.fn(async () => ({
      items: [{ type: 'agent_message' as const, text: '好的。', id: 'a', turnId: 't' }],
      usage: null,
    }));
    const createAgent = vi.fn(async (config) => ({
      agent: {
        getRuntimeState: () => ({ status: 'idle' }),
        runTurn,
      },
      debugConfig: config,
    }));
    const response = res();
    const path = routePath('/api/bot/dingtalk/webhook');

    await handleBotRoute({
      req: req('POST', '/api/bot/dingtalk/webhook', {
        msgtype: 'text',
        text: { content: '你好' },
        msgId: 'msg_dws_disabled_1',
        conversationType: '1',
        conversationId: 'cid_dm_test2',
        senderStaffId: 'staff_1',
        senderNick: '测试用户',
      }),
      res: response,
      url: path.url,
      segments: path.segments,
      store: store as unknown as ThreadStore,
      getDefaultRunConfig: async () => runConfig,
      createAgent,
    });

    expect(response.status).toBe(200);
    const agentConfig = createAgent.mock.calls
      .map((call) => call[0] as Record<string, unknown>)
      .find((config) => config.systemPromptSuffix);
    expect(agentConfig).toBeTruthy();
    const runtimeConfig = agentConfig!;
    const tools = runtimeConfig.tools as { get(name: string): { parameters: Record<string, unknown> } | undefined } | undefined;

    // 验证只有一个统一的 dingtalk 工具，没有独立的 dws 工具
    expect(tools?.get('dingtalk')).toBeTruthy();
    expect(tools?.get('dws_exec')).toBeUndefined();
    expect(tools?.get('dws_schema')).toBeUndefined();
    expect(tools?.get('dws_auth_status')).toBeUndefined();
    expect(tools?.get('dingtalk_forward_to_group')).toBeUndefined();

    // 验证统一工具包含 send_message 和 dws 相关参数
    const dingtalkTool = tools?.get('dingtalk');
    expect(dingtalkTool?.parameters).toBeTruthy();
    const params = dingtalkTool!.parameters as { properties?: Record<string, { enum?: string[] }> };
    expect(params.properties?.action).toBeTruthy();
    const actionEnum = params.properties?.action?.enum ?? [];
    expect(actionEnum).toContain('send_message');
    expect(actionEnum).toContain('dws_exec');
    expect(actionEnum).toContain('dws_schema');
    expect(actionEnum).toContain('dws_auth_status');
    expect(params.properties?.message).toBeTruthy();
    expect(params.properties?.mentions).toBeTruthy();
    expect(params.properties?.dwsArgs).toBeTruthy();
    expect(params.properties?.dwsDryRun).toBeTruthy();
    expect(params.properties?.dwsJq).toBeTruthy();

    // 验证系统提示中包含 dws 相关说明
    expect(runtimeConfig.systemPromptSuffix).toEqual(expect.stringContaining('企业数据操作'));
    expect(runtimeConfig.systemPromptSuffix).toEqual(expect.stringContaining('dws_exec'));

    // 验证 current_time 仍然存在
    expect(tools?.get('current_time')).toBeTruthy();

    fetchMock.mockRestore();
    shutdownAllDingtalkClients();
  });

  it('unified dingtalk tool is injected into group chat agent (Stream mode scenario)', async () => {
    shutdownAllDingtalkClients();
    const store = new BotRouteStore();
    store.settings.set(BOT_CONFIG_KEY, {
      ...DEFAULT_BOT_CONFIG,
      dingtalk: {
        ...DEFAULT_BOT_CONFIG.dingtalk,
        enabled: true,
        connectionMode: 'webhook',
        clientId: 'ding_app_key',
        clientSecret: 'ding_app_secret',
        robotCode: 'ding_robot',
        targetGroupName: '测试群',
        targetGroupConversationId: 'cid_group_target',
      },
      dwsCli: {
        enabled: true,
        binaryPath: '/usr/local/bin/dws',
        clientId: 'dws_client_id',
        clientSecret: 'dws_client_secret',
      },
    });
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const href = String(url);
      if (href.endsWith('/v1.0/oauth2/accessToken')) {
        return new Response(JSON.stringify({ accessToken: 'token_1', expireIn: 7200 }), { status: 200 });
      }
      if (href.endsWith('/v1.0/robot/groupMessages/send')) {
        return new Response(JSON.stringify({ processQueryKey: 'group_reply' }), { status: 200 });
      }
      throw new Error(`unexpected fetch ${href}`);
    });
    const runTurn = vi.fn(async () => ({
      items: [{ type: 'agent_message' as const, text: '好的，我来用 dws 查查。', id: 'a', turnId: 't' }],
      usage: null,
    }));
    const createAgent = vi.fn(async (config) => ({
      agent: {
        getRuntimeState: () => ({ status: 'idle' }),
        runTurn,
      },
      debugConfig: config,
    }));
    const response = res();
    const path = routePath('/api/bot/dingtalk/webhook');

    await handleBotRoute({
      req: req('POST', '/api/bot/dingtalk/webhook', {
        msgtype: 'text',
        text: { content: '@机器人 用dws查一下今天谁请假了' },
        msgId: 'msg_group_dws_1',
        conversationType: '2',
        conversationId: 'cid_group_target',
        sessionWebhook: 'https://oapi.dingtalk.com/robot/send?access_token=session-token',
        senderStaffId: 'staff_1',
        senderNick: '张三',
        chatbotUserId: 'bot_user',
        atUsers: [{ dingtalkId: 'bot_user', staffId: 'bot_staff' }],
      }),
      res: response,
      url: path.url,
      segments: path.segments,
      store: store as unknown as ThreadStore,
      getDefaultRunConfig: async () => runConfig,
      createAgent,
      createId: () => 'thread_group_dws_test',
      now: () => '2026-07-03T00:00:00.000Z',
    });

    expect(response.status).toBe(200);
    const agentConfig = createAgent.mock.calls
      .map((call) => call[0] as Record<string, unknown>)
      .find((config) => config.systemPromptSuffix);
    expect(agentConfig).toBeTruthy();
    const runtimeConfig = agentConfig!;
    const tools = runtimeConfig.tools as { get(name: string): { parameters: Record<string, unknown> } | undefined } | undefined;

    // 验证群聊场景下只有一个统一的 dingtalk 工具
    expect(tools?.get('dingtalk')).toBeTruthy();
    expect(tools?.get('dws_exec')).toBeUndefined();
    expect(tools?.get('dingtalk_forward_to_group')).toBeUndefined();

    // 验证统一工具包含 dws 相关参数（Stream/Webhook 模式工具注入逻辑相同，都走 createDingtalkAgentTools）
    const dingtalkTool = tools?.get('dingtalk');
    expect(dingtalkTool?.parameters).toBeTruthy();
    const params = dingtalkTool!.parameters as { properties?: Record<string, { enum?: string[] }> };
    const actionEnum = params.properties?.action?.enum ?? [];
    expect(actionEnum).toContain('send_message');
    expect(actionEnum).toContain('dws_exec');

    // 验证系统提示中包含 dws 相关说明
    expect(runtimeConfig.systemPromptSuffix).toEqual(expect.stringContaining('企业数据操作'));
    expect(runtimeConfig.systemPromptSuffix).toEqual(expect.stringContaining('dws_exec'));
    expect(runtimeConfig.systemPromptSuffix).toEqual(expect.stringContaining('搜索联系人、管理日程、待办、AI表格、文档、考勤等'));

    // 验证 current_time 仍然存在
    expect(tools?.get('current_time')).toBeTruthy();

    fetchMock.mockRestore();
    shutdownAllDingtalkClients();
  });
});
