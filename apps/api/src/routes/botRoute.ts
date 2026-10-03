import type { IncomingMessage, ServerResponse } from 'node:http';
import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { BotGateway, DingtalkAICardStream, DingtalkClient, WeixinBridgeClient, type BotInboundMessage, type DingtalkInboundMessage, type DingtalkMessageAttachment } from '@suanlizi/bot';
import type { ThreadEvent, ThreadItem, Usage } from '@suanlizi/protocol';
import type { ThreadStore } from '@suanlizi/storage';
import { currentTimeTool, ToolRegistry } from '@suanlizi/tools';
import {
  DINGTALK_TOOL_NAME,
  createDingtalkForwardTools,
  dingtalkForwardingSystemPrompt,
} from '../services/dingtalkForwardTool.js';
import { readJson, sendError, sendJson } from '../shared/http.js';
import type { AgentRunConfig } from '../config/config.js';
import { resolveAppLogDir } from '../config/appData.js';
import type { AgentCreateConfig } from '../runtime/tenantRuntime.js';
import type { ActiveRunRegistry } from '../runtime/activeRunRegistry.js';
import {
  BOT_CONFIG_KEY,
  DEFAULT_BOT_CONFIG,
  DEFAULT_WEIXIN_BRIDGE_URL,
  mergeBotConfig,
  normalizeBotConfig,
  publicBotConfig,
  type BotConfig,
} from '../config/botConfig.js';
import { bindWeixinActiveThreadIfMissing } from './threadDeletion.js';

const BOT_LOG_DIR = resolveAppLogDir();
const WEIXIN_BOT_LOG_PATH = path.join(BOT_LOG_DIR, 'weixin-bot.log');

interface MinimalAgent {
  runTurn(threadId: string, input: { type: 'text'; text: string }): Promise<{ items: ThreadItem[]; usage: unknown }>;
  getRuntimeState(threadId: string): { status?: string } | Promise<{ status?: string }>;
  onEvent?(listener: (event: unknown) => void): void;
}

interface WeixinClientLike {
  health(): Promise<unknown>;
  status?(): Promise<unknown>;
  startLogin(): Promise<unknown>;
  waitLogin(sessionKey: string): Promise<{ connected?: boolean; accountId?: string }>;
  startMonitor(accountId: string, options?: { syncHistory?: boolean }): Promise<unknown>;
  stopMonitor(accountId?: string): Promise<unknown>;
  logout(accountId?: string): Promise<unknown>;
  sendMessage(params: { accountId: string; to: string; text: string; contextToken?: string }): Promise<unknown>;
}

export interface BotRouteOptions {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  segments: string[];
  store: ThreadStore;
  getDefaultRunConfig(): Promise<AgentRunConfig>;
  getThreadRunConfig?(threadId: string): Promise<AgentRunConfig>;
  createAgent(config: AgentCreateConfig): Promise<{ agent: MinimalAgent }>;
  createWeixinClient?(config: BotConfig): WeixinClientLike;
  createId?(): string;
  now?(): string;
  tenantId?: string;
  publishEvent?(event: ThreadEvent): void;
  activeRunRegistry?: ActiveRunRegistry;
}

async function runTopLevelBotTurn(
  options: BotRouteOptions,
  agent: MinimalAgent,
  threadId: string,
  input: { type: 'text'; text: string },
  maxActiveTasks: number,
): Promise<{ items: ThreadItem[]; usage: unknown }> {
  const reservationId = `bot:${threadId}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
  const registry = options.activeRunRegistry;
  if (registry && !registry.tryReserveTopLevel(reservationId, maxActiveTasks)) {
    throw new Error(`Maximum active top-level tasks reached (${maxActiveTasks}).`);
  }
  try {
    return await agent.runTurn(threadId, input);
  } finally {
    registry?.releaseTopLevel(reservationId);
  }
}

// 机器人路由处理（配置读取/更新、状态、微信登录/登out、消息/测试发送等）
// — Chinese: handle bot routes (config, status, WeChat login, messages, test send)
export async function handleBotRoute(options: BotRouteOptions): Promise<boolean> {
  const { req, res, segments } = options;
  if (segments[0] !== 'api' || segments[1] !== 'bot') return false;

  // 懒启动：第一次访问本租户的 bot 接口时，若配置了 autoStart+stream 则自动建立 Stream 连接
  // Chinese translation: lazy-start dingtalk stream on first bot API access for this tenant
  void autoStartDingtalkForTenant(options).catch(() => { /* best effort */ });

  // GET /api/bot/config — 获取公开的机器人配置
  // — Chinese: get public bot config
  if (req.method === 'GET' && segments[2] === 'config') {
    sendJson(res, 200, { config: publicBotConfig(await readBotConfig(options.store)) });
    return true;
  }

  // PATCH /api/bot/config — 更新机器人配置（同时验证桌面桥接限制）
  // — Chinese: update bot config (with desktop bridge validation)
  if (req.method === 'PATCH' && segments[2] === 'config') {
    const body = await readJson<{ config?: unknown }>(req);
    const current = await readBotConfig(options.store);
    const next = mergeBotConfig(current, body.config ?? {});
    const violation = personalWeixinBridgeViolation(options, next);
    if (violation) {
      sendJson(res, 400, { ok: false, code: 'PersonalWeixinBridgeUnsupported', error: violation });
      return true;
    }
    await options.store.setSetting(BOT_CONFIG_KEY, next);
    // 钉钉配置变更时销毁旧 client，下次使用会按新配置重建；若开启了 autoStart 且是 stream 模式则自动重连
    // Chinese translation: evict stale dingtalk client on config change; auto-reconnect if autoStart + stream
    if (dingtalkConfigRequiresRebuild(current.dingtalk, next.dingtalk)) {
      await evictDingtalkClient(options);
      if (next.dingtalk.enabled && next.dingtalk.autoStart && next.dingtalk.connectionMode === 'stream'
        && next.dingtalk.clientId && next.dingtalk.clientSecret) {
        void autoStartDingtalkForTenant(options).catch((err) => {
          void appendDingtalkBotLog('error', 'dingtalk auto-restart after config change failed', {
            tenantId: options.tenantId,
            error: err instanceof Error ? err.message : String(err),
          });
        });
      }
    }
    sendJson(res, 200, { ok: true, config: publicBotConfig(next) });
    return true;
  }

  // GET /api/bot/status — 返回微信桥接状态以及其他平台状态
  // — Chinese: return WeChat bridge status and other platform status
  if (req.method === 'GET' && segments[2] === 'status') {
    let config = await readBotConfig(options.store);
    let bridgeStatus: unknown;
    const status: Record<string, unknown> = {
      weixin: {
        enabled: config.weixin.enabled,
        bridgeMode: config.weixin.bridgeMode,
        bridgeUrl: config.weixin.bridgeUrl,
        connected: Boolean(config.weixin.accountId),
        autoStartMonitor: config.weixin.autoStartMonitor,
        syncHistoryOnConnect: config.weixin.syncHistoryOnConnect,
      },
      feishu: { enabled: config.feishu.enabled, status: 'pending' },
      dingtalk: { enabled: config.dingtalk.enabled, status: 'pending' },
      qq: { enabled: config.qq.enabled, status: 'pending' },
    };
    const violation = personalWeixinBridgeViolation(options, config);
    if (config.weixin.enabled && violation) {
      status.weixin = {
        ...status.weixin as Record<string, unknown>,
        bridge: 'unsupported',
        error: violation,
      };
    } else if (config.weixin.enabled) {
      try {
        const client = createWeixinClient(options, config);
        const health = await client.health();
        if (config.weixin.bridgeMode === 'desktop_managed' && !isManagedDesktopBridgeHealth(health)) {
          // 桌面桥接端口被非 Suanlizi 服务占用 — Chinese: bridge port occupied by non-Suanlizi service
          throw new Error('The configured Weixin bridge port is occupied by a non-Suanlizi service.');
        }
        bridgeStatus = await client.status?.().catch((error) => ({
          error: error instanceof Error ? error.message : String(error),
        }));
        const restoredAccountId = config.weixin.accountId || firstBridgeAccountId(bridgeStatus);
        if (!config.weixin.accountId && restoredAccountId) {
          // 自动从桌面桥接恢复微信账户
          // — Chinese: auto restore WeChat account from desktop bridge
          config = mergeBotConfig(config, { weixin: { enabled: true, accountId: restoredAccountId } });
          await options.store.setSetting(BOT_CONFIG_KEY, config);
          await appendWeixinBotLog('info', 'restored Weixin account from desktop bridge', {
            accountId: restoredAccountId,
          });
        }
        status.weixin = { ...status.weixin as Record<string, unknown>, bridge: 'online', bridgeStatus };
      } catch (error) {
        status.weixin = {
          ...status.weixin as Record<string, unknown>,
          bridge: 'offline',
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }
    status.weixin = {
      ...status.weixin as Record<string, unknown>,
      enabled: config.weixin.enabled,
      connected: Boolean(config.weixin.accountId),
    };

    // 钉钉状态检查
    if (config.dingtalk.enabled && config.dingtalk.clientId && config.dingtalk.clientSecret) {
      try {
        const dingClient = getOrCreateDingtalkClient(options, config);
        const health = await dingClient.healthCheck();
        const dtStatus: Record<string, unknown> = {
          enabled: true,
          connectionMode: config.dingtalk.connectionMode,
          robotCode: config.dingtalk.robotCode || config.dingtalk.clientId.slice(0, 6) + '...',
          configured: Boolean(config.dingtalk.clientId && config.dingtalk.clientSecret),
          targetGroupConfigured: Boolean(config.dingtalk.targetGroupConversationId),
          targetGroupName: config.dingtalk.targetGroupName,
          targetGroupConversationId: config.dingtalk.targetGroupConversationId,
          targetGroupSessionWebhookConfigured: Boolean(config.dingtalk.targetGroupSessionWebhook),
          lastDetectedGroupConversationId: config.dingtalk.lastDetectedGroupConversationId,
          lastDetectedGroupSessionWebhookConfigured: Boolean(config.dingtalk.lastDetectedGroupSessionWebhook),
          lastDetectedGroupAt: config.dingtalk.lastDetectedGroupAt,
          tokenValid: health.tokenValid,
          streamRunning: dingClient.isStreamRunning,
          allowedUsersCount: config.dingtalk.allowedUsers.length,
          autoStart: config.dingtalk.autoStart,
        };
        if (health.error) dtStatus.error = health.error;
        status.dingtalk = dtStatus;
      } catch (error) {
        status.dingtalk = {
          enabled: config.dingtalk.enabled,
          connectionMode: config.dingtalk.connectionMode,
          configured: Boolean(config.dingtalk.clientId && config.dingtalk.clientSecret),
          targetGroupConfigured: Boolean(config.dingtalk.targetGroupConversationId),
          targetGroupName: config.dingtalk.targetGroupName,
          targetGroupConversationId: config.dingtalk.targetGroupConversationId,
          targetGroupSessionWebhookConfigured: Boolean(config.dingtalk.targetGroupSessionWebhook),
          lastDetectedGroupConversationId: config.dingtalk.lastDetectedGroupConversationId,
          lastDetectedGroupSessionWebhookConfigured: Boolean(config.dingtalk.lastDetectedGroupSessionWebhook),
          lastDetectedGroupAt: config.dingtalk.lastDetectedGroupAt,
          tokenValid: false,
          streamRunning: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    } else {
      status.dingtalk = {
        enabled: config.dingtalk.enabled,
        connectionMode: config.dingtalk.connectionMode,
        configured: Boolean(config.dingtalk.clientId && config.dingtalk.clientSecret),
        targetGroupConfigured: Boolean(config.dingtalk.targetGroupConversationId),
        targetGroupName: config.dingtalk.targetGroupName,
        targetGroupConversationId: config.dingtalk.targetGroupConversationId,
        targetGroupSessionWebhookConfigured: Boolean(config.dingtalk.targetGroupSessionWebhook),
        lastDetectedGroupConversationId: config.dingtalk.lastDetectedGroupConversationId,
        lastDetectedGroupSessionWebhookConfigured: Boolean(config.dingtalk.lastDetectedGroupSessionWebhook),
        lastDetectedGroupAt: config.dingtalk.lastDetectedGroupAt,
        tokenValid: false,
        streamRunning: false,
      };
    }

    sendJson(res, 200, { config: publicBotConfig(config), status });
    return true;
  }

  // POST /api/bot/dingtalk/start — 启动钉钉 Stream 连接
  if (req.method === 'POST' && segments[2] === 'dingtalk' && segments[3] === 'start') {
    const config = await readBotConfig(options.store);
    if (!config.dingtalk.enabled || !config.dingtalk.clientId || !config.dingtalk.clientSecret) {
      sendJson(res, 400, { ok: false, code: 'DingtalkNotConfigured', error: '钉钉机器人未配置或未启用' });
      return true;
    }
    const client = getOrCreateDingtalkClient(options, config);
    const result = await client.startStream();
    await appendDingtalkBotLog('info', 'dingtalk stream start', {
      tenantId: options.tenantId,
      connected: result.connected,
      error: result.error,
    });
    sendJson(res, 200, { ok: result.connected, result });
    return true;
  }

  // POST /api/bot/dingtalk/stop — 停止钉钉 Stream 连接
  if (req.method === 'POST' && segments[2] === 'dingtalk' && segments[3] === 'stop') {
    const client = getDingtalkClient(options);
    if (client) client.stopStream();
    await appendDingtalkBotLog('info', 'dingtalk stream stop', { tenantId: options.tenantId });
    sendJson(res, 200, { ok: true });
    return true;
  }

  // POST /api/bot/dingtalk/test — 测试发送钉钉消息
  if (req.method === 'POST' && segments[2] === 'dingtalk' && segments[3] === 'test') {
    const body = await readJson<{ conversationId?: string; conversationType?: string; text?: string }>(req);
    const config = await readBotConfig(options.store);
    if (!config.dingtalk.enabled || !config.dingtalk.clientId || !config.dingtalk.clientSecret) {
      sendJson(res, 400, { ok: false, error: '钉钉机器人未配置' });
      return true;
    }
    const convId = body.conversationId?.trim();
    const text = body.text?.trim() || 'Suanlizi 钉钉机器人测试消息';
    const convType = body.conversationType === 'group' ? '2' : '1';
    if (!convId) {
      sendError(res, 400, 'conversationId is required');
      return true;
    }
    const client = getOrCreateDingtalkClient(options, config);
    const cardTemplateId = config.dingtalk.cardTemplateId?.trim();
    let result: import('@suanlizi/bot').DingtalkSendResult;
    if (cardTemplateId) {
      result = await client.replyWithAICardMarkdown({
        conversationType: convType,
        conversationId: convId,
        cardTemplateId,
        markdown: text,
      });
      if (!result.ok) {
        result = await client.sendMarkdown({ conversationType: convType, conversationId: convId, text });
      }
    } else {
      result = await client.sendMarkdown({
        conversationType: convType,
        conversationId: convId,
        text,
      });
    }
    sendJson(res, 200, { ok: result.ok, result });
    return true;
  }

  // POST /api/bot/dingtalk/webhook — 接收钉钉 Webhook 回调（webhook 模式）
  if (req.method === 'POST' && segments[2] === 'dingtalk' && segments[3] === 'webhook') {
    const config = await readBotConfig(options.store);
    if (config.dingtalk.connectionMode !== 'webhook') {
      sendJson(res, 200, { ok: false, reason: 'webhook mode not enabled' });
      return true;
    }
    if (!config.dingtalk.enabled || !config.dingtalk.clientId || !config.dingtalk.clientSecret) {
      sendError(res, 400, 'DingTalk not configured');
      return true;
    }

    // 签名校验：仅当显式配置了 webhookSecret 时才强制校验（HMAC-SHA256 + Base64 + URL-encode）
    // 未配置 webhookSecret 视为开发模式，跳过签名校验（强烈建议生产环境配置）
    // Chinese translation: enforce signature verification only when webhookSecret is configured
    if (config.dingtalk.webhookSecret) {
      const timestamp = String(req.headers['x-dingtalk-timestamp'] ?? req.headers.timestamp ?? '');
      const signHeader = String(req.headers['x-dingtalk-sign'] ?? req.headers.sign ?? '');
      if (!timestamp || !signHeader) {
        sendError(res, 401, 'Missing signature headers');
        return true;
      }
      const ts = Number(timestamp);
      if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > 3600_000) {
        sendError(res, 401, 'Signature timestamp expired');
        return true;
      }
      const expected = crypto
        .createHmac('sha256', config.dingtalk.webhookSecret)
        .update(`${timestamp}\n${config.dingtalk.webhookSecret}`, 'utf8')
        .digest('base64');
      const expectedEnc = encodeURIComponent(expected);
      const candidates = [signHeader];
      try { candidates.push(decodeURIComponent(signHeader)); } catch { /* ignore */ }
      const matched = candidates.some((candidate) => {
        const bufA = Buffer.from(candidate);
        const bufB = Buffer.from(expected);
        const bufC = Buffer.from(expectedEnc);
        if (bufA.length === bufB.length && crypto.timingSafeEqual(bufA, bufB)) return true;
        if (bufA.length === bufC.length && crypto.timingSafeEqual(bufA, bufC)) return true;
        return false;
      });
      if (!matched) {
        sendError(res, 401, 'Invalid signature');
        return true;
      }
    }

    const raw = await readJson<Record<string, unknown>>(req);
    await appendDingtalkBotLog('info', 'dingtalk webhook received', {
      tenantId: options.tenantId,
      keys: Object.keys(raw),
    });
    const client = getOrCreateDingtalkClient(options, config);
    const dingMsg = client.parseWebhookEvent(raw);
    if (!dingMsg) {
      sendJson(res, 200, { ok: true });
      return true;
    }
    if (!isDingtalkUserAllowed(config, dingMsg.senderStaffId)) {
      sendJson(res, 200, { ok: true, reason: 'user not in allowlist' });
      return true;
    }
    const result = await processDingtalkInbound(options, config, dingMsg, client);
    sendJson(res, 200, { ok: true, result });
    return true;
  }

  // 除微信、钉钉外无其他平台实现
  if (segments[2] !== 'weixin' && segments[2] !== 'dingtalk') {
    sendError(res, 404, 'Bot platform not found');
    return true;
  }

  if (segments[2] === 'dingtalk') {
    sendError(res, 404, 'DingTalk route not found');
    return true;
  }

  // POST /api/bot/weixin/login/start — 启动登录流程（可选绑定线程）
  // — Chinese: start login (optional thread binding)
  if (req.method === 'POST' && segments[3] === 'login' && segments[4] === 'start') {
    const body = await readJson<{ threadId?: string | null }>(req);
    const current = await readBotConfig(options.store);
    const next = mergeBotConfig(current, { weixin: { enabled: true, activeThreadId: body.threadId?.trim() ?? '' } });
    const violation = personalWeixinBridgeViolation(options, next);
    if (violation) {
      sendJson(res, 400, { ok: false, code: 'PersonalWeixinBridgeUnsupported', error: violation });
      return true;
    }
    await options.store.setSetting(BOT_CONFIG_KEY, next);
    try {
      const result = await createWeixinClient(options, next).startLogin();
      sendJson(res, 200, { ok: true, result });
    } catch (error) {
      sendJson(res, 200, {
        ok: false,
        result: { message: weixinBridgeErrorMessage(error) },
      });
    }
    return true;
  }

  // POST /api/bot/weixin/login/wait — 等待扫码登录完成，记录账号 id
  // — Chinese: wait for login to complete, record account id
  if (req.method === 'POST' && segments[3] === 'login' && segments[4] === 'wait') {
    const body = await readJson<{ sessionKey?: string }>(req);
    const sessionKey = body.sessionKey?.trim();
    if (!sessionKey) {
      sendError(res, 400, 'sessionKey is required');
      return true;
    }
    const current = await readBotConfig(options.store);
    const violation = personalWeixinBridgeViolation(options, current);
    if (violation) {
      sendJson(res, 400, { ok: false, code: 'PersonalWeixinBridgeUnsupported', error: violation });
      return true;
    }
    let result: Awaited<ReturnType<WeixinClientLike['waitLogin']>>;
    try {
      result = await createWeixinClient(options, current).waitLogin(sessionKey);
    } catch (error) {
      sendJson(res, 200, {
        ok: false,
        result: {
          connected: false,
          message: weixinBridgeErrorMessage(error),
        },
      });
      return true;
    }
    if (result.connected && result.accountId) {
      const next = mergeBotConfig(current, { weixin: { enabled: true, accountId: result.accountId } });
      await options.store.setSetting(BOT_CONFIG_KEY, next);
      if (next.weixin.autoStartMonitor) {
        await createWeixinClient(options, next).startMonitor(result.accountId, {
          syncHistory: next.weixin.syncHistoryOnConnect,
        });
      }
    }
    sendJson(res, 200, { ok: true, result });
    return true;
  }

  // POST /api/bot/weixin/logout — 停止监控并登出，清空 accountId / activeThreadId
  // — Chinese: logout, stop monitoring and clear accountId / activeThreadId
  if (req.method === 'POST' && segments[3] === 'logout') {
    const current = await readBotConfig(options.store);
    const violation = personalWeixinBridgeViolation(options, current);
    if (violation) {
      sendJson(res, 400, { ok: false, code: 'PersonalWeixinBridgeUnsupported', error: violation });
      return true;
    }
    const accountId = current.weixin.accountId;
    const client = createWeixinClient(options, current);
    let bridgeError = '';
    try {
      if (accountId) {
        await client.stopMonitor(accountId);
        await client.logout(accountId);
      } else {
        await client.stopMonitor();
        await client.logout();
      }
    } catch (error) {
      bridgeError = error instanceof Error ? error.message : String(error);
    }
    const next = mergeBotConfig(current, {
      weixin: {
        enabled: false,
        accountId: '',
        activeThreadId: '',
      },
    });
    await options.store.setSetting(BOT_CONFIG_KEY, next);
    sendJson(res, 200, { ok: true, config: publicBotConfig(next), warning: bridgeError || undefined });
    return true;
  }

  // POST /api/bot/weixin/(message|webhook) — 接收消息并触发 Agent 回复
  // — Chinese: receive message and trigger Agent reply
  if (req.method === 'POST' && (segments[3] === 'message' || segments[3] === 'webhook')) {
    const raw = await readJson<Record<string, unknown>>(req);
    await appendWeixinBotLog('info', 'inbound request received', {
      route: segments[3],
      raw: summarizeWeixinRaw(raw),
    });
    const message = normalizeWeixinInbound(raw);
    if (!message) {
      await appendWeixinBotLog('error', 'invalid inbound message', {
        route: segments[3],
        raw: summarizeWeixinRaw(raw),
      });
      sendError(res, 400, 'Invalid Weixin message');
      return true;
    }
    const config = await readBotConfig(options.store);
    const violation = personalWeixinBridgeViolation(options, config);
    if (violation) {
      sendJson(res, 400, { ok: false, code: 'PersonalWeixinBridgeUnsupported', error: violation });
      return true;
    }
    // 入站消息中的账号或通过当前配置中的 accountId 回复
    // — Chinese: reply through inbound accountId or current config.accountId
    const inboundAccountId = normalizeText(raw.accountId) || normalizeText(asRecord(raw.message).accountId);
    const replyAccountId = config.weixin.accountId || inboundAccountId;
    const defaultRunConfig = await options.getDefaultRunConfig();
    const botDefaultRunConfig = {
      ...defaultRunConfig,
      workspaceRoot: '',
    };
    const client = createWeixinClient(options, config);
    // 通过桌面桥接 webhook 路由的消息，不直接发送回复（让桥接自身处理）
    // — Chinese: webhook route defers sending to the bridge itself
    const replyViaBridgeWebhook = segments[3] === 'webhook';
    const gateway = new BotGateway({
      store: options.store,
      defaultWorkspaceRoot: botDefaultRunConfig.workspaceRoot,
      preferredThreadId: config.weixin.activeThreadId,
      defaultThreadTitle: botDefaultRunConfig.locale === 'en' ? 'WeChat Remote Assistant' : '微信远程助手',
      singleBindingMode: true,
      locale: botDefaultRunConfig.locale ?? 'zh',
      tenantId: options.tenantId,
      botAccountId: replyAccountId,
      createId: options.createId,
      now: options.now,
      isThreadRunning: async (threadId) => {
        const { agent } = await options.createAgent(await runConfigForThread(options, threadId, botDefaultRunConfig));
        const state = await agent.getRuntimeState(threadId);
        return state.status === 'running';
      },
      runTurn: async (threadId, text) => {
        const runConfig = await runConfigForThread(options, threadId, botDefaultRunConfig);
        const { agent } = await options.createAgent(runConfig);
        const result = await runTopLevelBotTurn(options, agent, threadId, { type: 'text', text }, runConfig.maxActiveTasks ?? 4);
        publishBotTurnEvents(options, threadId, result.items, result.usage);
        return { text: latestAgentText(result.items) };
      },
      send: async (outbound) => {
        if (replyViaBridgeWebhook) {
          await appendWeixinBotLog('info', 'defer Weixin reply to desktop bridge webhook response', {
            route: segments[3],
            chatId: outbound.chatId,
            threadId: outbound.threadId,
            length: outbound.text.length,
          });
          return;
        }
        if (!replyAccountId) throw new Error('Weixin account is not connected');
        await client.sendMessage({
          accountId: replyAccountId,
          to: outbound.chatId,
          text: outbound.text,
        });
      },
    });
    const result = await gateway.handleMessage(message);
    if (result.threadId) {
      await bindWeixinActiveThreadIfMissing(options.store, result.threadId);
    }
    await appendWeixinBotLog('info', 'inbound request handled', {
      route: segments[3],
      message: {
        chatId: message.chatId,
        userId: message.userId,
        messageId: message.messageId,
        textPreview: message.text.slice(0, 120),
      },
      result: {
        status: result.status,
        threadId: result.threadId,
        error: result.error,
      },
    });
    sendJson(res, 200, { ok: true, result });
    return true;
  }

  // POST /api/bot/weixin/test-send — 测试发送消息到指定 chatId
  // — Chinese: test sending message to a chatId
  if (req.method === 'POST' && segments[3] === 'test-send') {
    const body = await readJson<{ chatId?: string; text?: string; accountId?: string }>(req);
    const chatId = body.chatId?.trim();
    const text = body.text?.trim();
    if (!chatId || !text) {
      sendError(res, 400, 'chatId and text are required');
      return true;
    }
    const config = await readBotConfig(options.store);
    const violation = personalWeixinBridgeViolation(options, config);
    if (violation) {
      sendJson(res, 400, { ok: false, code: 'PersonalWeixinBridgeUnsupported', error: violation });
      return true;
    }
    const accountId = body.accountId?.trim() || config.weixin.accountId;
    if (!accountId) {
      sendError(res, 400, 'Weixin account is not connected');
      return true;
    }
    const result = await createWeixinClient(options, config).sendMessage({ accountId, to: chatId, text });
    sendJson(res, 200, { ok: true, result });
    return true;
  }

  sendError(res, 404, 'Bot route not found');
  return true;
}

// 发布回合事件（item.completed 和 turn.completed）
// — Chinese: publish turn events (item.completed + turn.completed)
function publishBotTurnEvents(
  options: BotRouteOptions,
  threadId: string,
  items: ThreadItem[],
  usage: unknown,
): void {
  if (!options.publishEvent || items.length === 0) return;
  const fallbackTurnId = items.find((item) => item.turnId)?.turnId;
  for (const item of items) {
    const turnId = item.turnId ?? fallbackTurnId;
    if (!turnId) continue;
    options.publishEvent({ type: 'item.completed', threadId, turnId, item });
  }
  if (fallbackTurnId) {
    options.publishEvent({
      type: 'turn.completed',
      threadId,
      turnId: fallbackTurnId,
      runId: `run_${fallbackTurnId}`,
      usage: normalizeUsageForEvent(usage),
      status: 'completed',
    });
  }
}

// 标准化 usage 对象以用于事件 — Chinese: normalize usage for event
function normalizeUsageForEvent(value: unknown): Usage | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Partial<Record<keyof Usage, unknown>>;
  return typeof record.inputTokens === 'number'
    && typeof record.cachedInputTokens === 'number'
    && typeof record.outputTokens === 'number'
    && typeof record.reasoningOutputTokens === 'number'
    ? record as Usage
    : null;
}

// 读取存储的机器人配置。
export async function readBotConfig(store: ThreadStore): Promise<BotConfig> {
  return normalizeBotConfig(await store.getSetting<unknown>(BOT_CONFIG_KEY) ?? DEFAULT_BOT_CONFIG);
}

// 创建微信客户端（优先使用选项中的 createWeixinClient，否则使用默认的 HTTP 桥接客户端）
// — Chinese: create WeChat client (prefer injected createWeixinClient or default HTTP bridge client)
function createWeixinClient(options: BotRouteOptions, config: BotConfig): WeixinClientLike {
  return options.createWeixinClient?.(config) ?? new WeixinBridgeClient({ rpcUrl: config.weixin.bridgeUrl });
}

function personalWeixinBridgeViolation(_options: BotRouteOptions, _config: BotConfig): string {
  return '';
}

// 获取或构建线程的运行时配置 — Chinese: get or build thread runtime config
async function runConfigForThread(
  options: BotRouteOptions,
  threadId: string,
  fallback: AgentRunConfig,
): Promise<AgentRunConfig> {
  if (!options.getThreadRunConfig) return fallback;
  try {
    return await options.getThreadRunConfig(threadId);
  } catch {
    return fallback;
  }
}

// 规范化入站消息（统一字段，包含 chatId/userId/text/messageId 等）
// — Chinese: normalize inbound message (normalize fields like chatId/userId/text/messageId)
function normalizeWeixinInbound(raw: Record<string, unknown>): BotInboundMessage | null {
  const text = normalizeText(raw.text) || normalizeText(asRecord(raw.message).text);
  const chatId = normalizeText(raw.chatId) || normalizeText(raw.fromUserId) || normalizeText(raw.from) || normalizeText(raw.senderId);
  const userId = normalizeText(raw.userId) || normalizeText(raw.senderId) || normalizeText(raw.sender) || chatId;
  const messageId = normalizeText(raw.messageId) || normalizeText(raw.id) || normalizeText(asRecord(raw.message).messageId);
  if (!text || !chatId || !userId || !messageId) return null;
  const chatType = raw.chatType === 'group' ? 'group' : 'dm';
  return {
    platform: 'weixin',
    chatType,
    chatId,
    userId,
    userName: normalizeText(raw.userName) || normalizeText(raw.senderName) || userId,
    text,
    messageId,
    threadId: normalizeText(raw.threadId) || undefined,
  };
}

// 获取最新的 agent 消息文本 — Chinese: get the latest agent message text
function latestAgentText(items: ThreadItem[]): string {
  return [...items].reverse().find((item) => item.type === 'agent_message')?.text ?? '';
}

function normalizeText(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return '';
}

// 将未知值转换为对象记录 — Chinese: coerce unknown value to record
function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

// 从桥接状态获取第一个账号 id（如 accounts 数组）
// — Chinese: get first account id from bridge status accounts array
function firstBridgeAccountId(status: unknown): string {
  const accounts = asRecord(status).accounts;
  if (!Array.isArray(accounts)) return '';
  const first = accounts.find((account) => typeof account === 'string' && account.trim());
  return typeof first === 'string' ? first.trim() : '';
}

// 判断 health 响应是否对应托管桌面桥接
// — Chinese: check if health response corresponds to managed desktop bridge
function isManagedDesktopBridgeHealth(health: unknown): boolean {
  return asRecord(health).managed === true;
}

// 追加机器人日志条目 — Chinese: append WeChat bot log entry
async function appendWeixinBotLog(level: 'info' | 'error', message: string, meta: Record<string, unknown> = {}): Promise<void> {
  try {
    await mkdir(BOT_LOG_DIR, { recursive: true });
    const safeMeta = sanitizeLogMeta(meta);
    await appendFile(WEIXIN_BOT_LOG_PATH, `${JSON.stringify({
      time: new Date().toISOString(),
      level,
      message,
      ...safeMeta,
    })}\n`, 'utf8');
  } catch {
    // 日志绝不能中断 webhook 处理
    // — Chinese: logging must never break bot webhook handling
  }
}

// 摘要用于日志记录的原始请求体，脱敏且截断
// — Chinese: summarize raw request body for logging, with truncation and redaction
function summarizeWeixinRaw(raw: Record<string, unknown>): Record<string, unknown> {
  const nested = asRecord(raw.message);
  return {
    keys: Object.keys(raw),
    text: previewLogValue(raw.text ?? nested.text),
    chatId: previewLogValue(raw.chatId),
    fromUserId: previewLogValue(raw.fromUserId),
    from: previewLogValue(raw.from),
    senderId: previewLogValue(raw.senderId),
    userId: previewLogValue(raw.userId),
    messageId: previewLogValue(raw.messageId),
    id: previewLogValue(raw.id),
    accountId: previewLogValue(raw.accountId ?? nested.accountId),
    messageKeys: Object.keys(nested),
  };
}

// 预截断的日志值预览（字符串 240 字，数字/布尔保持原样，其他省略类型）
// — Chinese: truncated log value preview (strings 240, numbers/bool kept as-is, otherwise omitted
function previewLogValue(value: unknown): unknown {
  if (typeof value === 'string') return value.length > 240 ? `${value.slice(0, 240)}...` : value;
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  return value == null ? undefined : typeof value;
}

// 清理日志元：隐藏 token/authorization 等敏感字段 — Chinese: sanitize log meta by redacting tokens/authorization
function sanitizeLogMeta(value: Record<string, unknown>): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value)) {
    output[key] = /token|authorization/i.test(key) ? '[redacted]' : sanitizeLogValue(raw);
  }
  return output;
}

// 递归清理日志值（保留数组但限制长度，对象继续递归清理，其他保持原值）
// — Chinese: recursively sanitize log values
function sanitizeLogValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => sanitizeLogValue(item));
  if (!value || typeof value !== 'object') return value;
  return sanitizeLogMeta(value as Record<string, unknown>);
}

// 将错误消息转换为中文可读消息 — Chinese: map error to user-friendly message
function weixinBridgeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/fetch failed|ECONNREFUSED|ENOTFOUND|health HTTP 404|Not found/i.test(message)) {
    // 连接失败 — Chinese: connection failure
    return '微信桥接服务不可用。请确认 Suanlizi Desktop 已启动且微信桥接组件正在运行。';
  }
  if (message.includes('已连接过此') || /already connected/i.test(message)) {
    // 账号已连接 — Chinese: already connected
    return '这个微信账号已连接过 Suanlizi，无需重复扫码。';
  }
  return message || '微信桥接返回了未知错误。';
}

// ===== 钉钉辅助函数 =====

const DINGTALK_BOT_LOG_PATH = path.join(BOT_LOG_DIR, 'dingtalk-bot.log');

const dingtalkClients = new Map<string, DingtalkClient>();
const dingtalkAutoStartAttempted = new Set<string>();
const DINGTALK_GROUP_MEMBER_CACHE_KEY = 'bot.dingtalk.groupMembers.v1';
const DINGTALK_DM_ATTACHMENT_CACHE_KEY = 'bot.dingtalk.dmAttachments.v1';

function dingtalkClientKey(options: BotRouteOptions): string {
  return options.tenantId?.trim() || 'default';
}

function getDingtalkClient(options: BotRouteOptions): DingtalkClient | null {
  return dingtalkClients.get(dingtalkClientKey(options)) ?? null;
}

// 判断钉钉配置中的关键字段是否变化，需要重建 client 或重启 stream
// Chinese translation: detect dingtalk config changes that require client rebuild
function dingtalkConfigRequiresRebuild(prev: BotConfig['dingtalk'], next: BotConfig['dingtalk']): boolean {
  return prev.clientId !== next.clientId
    || prev.clientSecret !== next.clientSecret
    || prev.robotCode !== next.robotCode
    || prev.connectionMode !== next.connectionMode
    || prev.enabled !== next.enabled
    || prev.allowedUsers.join(',') !== next.allowedUsers.join(',')
    || prev.activeThreadId !== next.activeThreadId
    || prev.autoStart !== next.autoStart
    || (prev.cardTemplateId ?? '') !== (next.cardTemplateId ?? '');
}

// 销毁并移除指定租户的钉钉 client（停止 Stream 连接）
// Chinese translation: destroy dingtalk client for tenant, stopping stream connection
async function evictDingtalkClient(options: BotRouteOptions): Promise<void> {
  const key = dingtalkClientKey(options);
  const client = dingtalkClients.get(key);
  if (client) {
    try { await client.stopStream(); } catch { /* ignore */ }
    dingtalkClients.delete(key);
  }
  dingtalkAutoStartAttempted.delete(key);
}

function getOrCreateDingtalkClient(options: BotRouteOptions, config: Pick<BotConfig, 'dingtalk'>): DingtalkClient {
  const key = dingtalkClientKey(options);
  let client = dingtalkClients.get(key);
  if (client) return client;
  client = new DingtalkClient({
    clientId: config.dingtalk.clientId,
    clientSecret: config.dingtalk.clientSecret,
    robotCode: config.dingtalk.robotCode,
  });
  client.setMessageHandler((msg) => handleDingtalkInbound(options, config, msg, client!));
  dingtalkClients.set(key, client);
  return client;
}

async function handleDingtalkInbound(
  options: BotRouteOptions,
  _config: { dingtalk: { clientId: string; clientSecret: string; robotCode: string; connectionMode: string; allowedUsers: string[]; activeThreadId?: string } },
  dingMsg: DingtalkInboundMessage,
  client: DingtalkClient,
): Promise<void> {
  const config = await readBotConfig(options.store);
  await processDingtalkInbound(options, config, dingMsg, client);
}

async function processDingtalkInbound(
  options: BotRouteOptions,
  config: BotConfigLike,
  dingMsg: DingtalkInboundMessage,
  client: DingtalkClient,
): Promise<{ status: string; threadId?: string; error?: string }> {
  const message = dingtalkToBotMessage(dingMsg);
  if (!isDingtalkUserAllowed(config, dingMsg.senderStaffId)) return { status: 'ignored' };
  await appendDingtalkBotLog('info', 'dingtalk inbound received', {
    tenantId: options.tenantId,
    chatId: message.chatId,
    userId: message.userId,
    userName: message.userName,
    textPreview: message.text.slice(0, 120),
  });
  const latestConfig = await rememberDingtalkGroupConversation(options, config, message);
  await rememberDingtalkGroupMember(options, message);
  await rememberDingtalkDmAttachments(options, message);
  return dispatchDingtalkMessage(options, latestConfig, message, client);
}

interface BotConfigLike {
  dingtalk: {
    enabled?: boolean;
    clientId: string;
    clientSecret: string;
    robotCode: string;
    connectionMode: string;
    allowedUsers: string[];
    activeThreadId?: string;
    cardTemplateId?: string;
    targetGroupName?: string;
    targetGroupConversationId?: string;
    targetGroupSessionWebhook?: string;
    lastDetectedGroupConversationId?: string;
    lastDetectedGroupSessionWebhook?: string;
    lastDetectedGroupAt?: string;
    webhookSecret?: string;
    autoStart?: boolean;
  };
  dwsCli?: {
    enabled: boolean;
    binaryPath: string;
    clientId: string;
    clientSecret: string;
  };
}

async function rememberDingtalkGroupConversation(
  options: BotRouteOptions,
  config: BotConfigLike,
  message: BotInboundMessage,
): Promise<BotConfigLike> {
  if (message.chatType !== 'group' || !message.chatId.trim()) return config;
  const current = await readBotConfig(options.store);
  const detectedAt = options.now?.() ?? new Date().toISOString();
  const patch: Partial<BotConfig['dingtalk']> = {
    lastDetectedGroupConversationId: message.chatId,
    lastDetectedGroupAt: detectedAt,
  };
  const sessionWebhook = typeof message.metadata?.sessionWebhook === 'string'
    ? message.metadata.sessionWebhook.trim()
    : '';
  if (sessionWebhook) {
    patch.lastDetectedGroupSessionWebhook = sessionWebhook;
  }
  if (!current.dingtalk.targetGroupConversationId.trim()) {
    patch.targetGroupConversationId = message.chatId;
    if (sessionWebhook) {
      patch.targetGroupSessionWebhook = sessionWebhook;
    }
  } else if (current.dingtalk.targetGroupConversationId === message.chatId && sessionWebhook) {
    patch.targetGroupSessionWebhook = sessionWebhook;
  }
  if (current.dingtalk.lastDetectedGroupConversationId === message.chatId
    && current.dingtalk.targetGroupConversationId.trim()
    && (!sessionWebhook || current.dingtalk.lastDetectedGroupSessionWebhook === sessionWebhook)
    && (current.dingtalk.targetGroupConversationId !== message.chatId || !sessionWebhook || current.dingtalk.targetGroupSessionWebhook === sessionWebhook)) {
    return current;
  }
  const next = mergeBotConfig(current, { dingtalk: patch });
  await options.store.setSetting(BOT_CONFIG_KEY, next);
  await appendDingtalkBotLog('info', 'dingtalk group conversation detected', {
    tenantId: options.tenantId,
    conversationId: message.chatId,
    targetGroupConversationId: next.dingtalk.targetGroupConversationId,
    sessionWebhookDetected: Boolean(sessionWebhook),
    targetGroupSessionWebhookConfigured: Boolean(next.dingtalk.targetGroupSessionWebhook),
    matchedTarget: !current.dingtalk.targetGroupConversationId || current.dingtalk.targetGroupConversationId === message.chatId,
  });
  return next;
}

function createDingtalkAgentTools(
  config: BotConfigLike,
  client: DingtalkClient,
  message: BotInboundMessage,
  mentionUsers: Array<{ staffId: string; name?: string }>,
  currentAttachments: DingtalkMessageAttachment[],
): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(currentTimeTool);
  let defaultSource: 'dingtalk_dm' | 'dingtalk_group_mention' | 'suanlizi_chat' = 'suanlizi_chat';
  if (message.platform === 'dingtalk') {
    defaultSource = message.chatType === 'dm' ? 'dingtalk_dm' : 'dingtalk_group_mention';
  }
  for (const tool of createDingtalkForwardTools({
    getConfig: () => config as BotConfig,
    createClient: () => client,
    currentUserText: message.text,
    mentionUsers,
    currentAttachments,
    defaultSource,
  })) {
    registry.register(tool);
  }
  return registry;
}

interface DingtalkDmAttachmentCache {
  entries: Record<string, {
    attachments: DingtalkMessageAttachment[];
    updatedAt: string;
  }>;
}

async function readDingtalkDmAttachmentCache(options: BotRouteOptions): Promise<DingtalkDmAttachmentCache> {
  const stored = await options.store.getSetting<DingtalkDmAttachmentCache>(DINGTALK_DM_ATTACHMENT_CACHE_KEY);
  return { entries: stored?.entries && typeof stored.entries === 'object' ? stored.entries : {} };
}

async function rememberDingtalkDmAttachments(options: BotRouteOptions, message: BotInboundMessage): Promise<void> {
  if (message.platform !== 'dingtalk' || message.chatType !== 'dm' || !message.attachments?.length) return;
  const key = message.userId.trim();
  if (!key) return;
  const cache = await readDingtalkDmAttachmentCache(options);
  cache.entries[key] = {
    attachments: message.attachments,
    updatedAt: options.now?.() ?? new Date().toISOString(),
  };
  await options.store.setSetting(DINGTALK_DM_ATTACHMENT_CACHE_KEY, cache);
}

async function recentDingtalkDmAttachments(options: BotRouteOptions, message: BotInboundMessage): Promise<DingtalkMessageAttachment[]> {
  if (message.platform !== 'dingtalk' || message.chatType !== 'dm') return [];
  if (message.attachments?.length) return message.attachments;
  const key = message.userId.trim();
  if (!key) return [];
  const cache = await readDingtalkDmAttachmentCache(options);
  return cache.entries[key]?.attachments ?? [];
}

interface DingtalkGroupMemberCache {
  groups: Record<string, {
    members: Array<{ staffId: string; name: string; updatedAt: string }>;
  }>;
}

async function readDingtalkGroupMemberCache(options: BotRouteOptions): Promise<DingtalkGroupMemberCache> {
  const stored = await options.store.getSetting<DingtalkGroupMemberCache>(DINGTALK_GROUP_MEMBER_CACHE_KEY);
  return { groups: stored?.groups && typeof stored.groups === 'object' ? stored.groups : {} };
}

async function rememberDingtalkGroupMember(options: BotRouteOptions, message: BotInboundMessage): Promise<void> {
  if (message.chatType !== 'group') return;
  const staffId = message.userId.trim();
  const name = message.userName.trim();
  const groupId = message.chatId.trim();
  if (!staffId || !name || !groupId) return;
  const cache = await readDingtalkGroupMemberCache(options);
  const group = cache.groups[groupId] ?? { members: [] };
  const updatedAt = options.now?.() ?? new Date().toISOString();
  const nextMembers = [
    { staffId, name, updatedAt },
    ...group.members.filter((member) => member.staffId !== staffId && member.name !== name),
  ].slice(0, 500);
  await options.store.setSetting(DINGTALK_GROUP_MEMBER_CACHE_KEY, {
    groups: {
      ...cache.groups,
      [groupId]: { members: nextMembers },
    },
  });
}

async function knownDingtalkMentionUsers(
  options: BotRouteOptions,
  config: BotConfigLike,
  message: BotInboundMessage,
): Promise<Array<{ staffId: string; name?: string }>> {
  const users = [{ staffId: message.userId, name: message.userName }];
  const targetGroupId = config.dingtalk.targetGroupConversationId?.trim();
  if (!targetGroupId) return users;
  const cache = await readDingtalkGroupMemberCache(options);
  const cached = cache.groups[targetGroupId]?.members ?? [];
  for (const member of cached) {
    users.push({ staffId: member.staffId, name: member.name });
  }
  return users;
}

// 拼装钉钉 Agent 的 system prompt — Chinese: assemble DingTalk agent system prompt
function dingtalkAgentPrompt(config: BotConfigLike, locale: string): string {
  const targetGroupName = config.dingtalk.targetGroupName?.trim() || '未命名群';
  const targetConfigured = Boolean(config.dingtalk.targetGroupConversationId?.trim());
  if (locale === 'en') {
    return [
      '## DingTalk Remote Assistant Tools',
      'You are handling a DingTalk remote-assistant conversation.',
      `Configured target group: ${targetConfigured ? targetGroupName : 'not configured'}.`,
      dingtalkForwardingSystemPrompt(locale),
      `Only call ${DINGTALK_TOOL_NAME} for the current user message. Never repeat or reuse earlier tool calls from chat history.`,
    ].join('\n');
  }
  return [
    '## 钉钉远程助手工具',
    '你正在处理钉钉远程助手会话。',
    `已配置目标群：${targetConfigured ? targetGroupName : '未配置'}`,
    dingtalkForwardingSystemPrompt(locale),
    `只允许针对当前用户消息调用 ${DINGTALK_TOOL_NAME}，绝不要复用或重复执行历史消息里的工具调用。`,
  ].join('\n');
}

async function dispatchDingtalkMessage(
  options: BotRouteOptions,
  config: BotConfigLike,
  message: BotInboundMessage,
  client: DingtalkClient,
): Promise<{ status: string; threadId?: string; error?: string }> {
  const defaultRunConfig = await options.getDefaultRunConfig();
  const botDefaultRunConfig = {
    ...defaultRunConfig,
    workspaceRoot: '',
  };
  const locale = botDefaultRunConfig.locale ?? 'zh';
  const mentionUsers = await knownDingtalkMentionUsers(options, config, message);
  const currentAttachments = await recentDingtalkDmAttachments(options, message);
  const withDingtalkAgentRuntime = (baseConfig: AgentRunConfig): AgentCreateConfig => ({
    ...baseConfig,
    tools: createDingtalkAgentTools(config, client, message, mentionUsers, currentAttachments),
    systemPromptSuffix: dingtalkAgentPrompt(config, locale),
  });

  // 预先根据入站消息决定会话目标（chatType 决定单聊/群聊，chatId 是目标会话）
  const conversationType = message.chatType === 'group' ? '2' : '1';
  const conversationId = message.chatId;
  const cardTemplateId = config.dingtalk.cardTemplateId?.trim();
  const cardStream = cardTemplateId ? new DingtalkAICardStream(client, {
    cardTemplateId,
    conversationType,
    conversationId,
    thinkingText: locale === 'en' ? 'Thinking...' : '思考中...',
    throttleMs: 400,
    errorFallbackText: locale === 'en' ? 'Failed to generate reply.' : '回复生成失败。',
  }) : null;

  const gateway = new BotGateway({
    store: options.store,
    defaultWorkspaceRoot: botDefaultRunConfig.workspaceRoot,
    preferredThreadId: config.dingtalk.activeThreadId,
    defaultThreadTitle: locale === 'en' ? 'DingTalk Assistant' : '钉钉助手',
    singleBindingMode: false,
    locale,
    tenantId: options.tenantId,
    botAccountId: config.dingtalk.clientId,
    createId: options.createId,
    now: options.now,
    isThreadRunning: async (threadId) => {
      const runConfig = await runConfigForThread(options, threadId, botDefaultRunConfig);
      const { agent } = await options.createAgent(withDingtalkAgentRuntime(runConfig));
      const state = await agent.getRuntimeState(threadId);
      return state.status === 'running';
    },
    runTurn: async (threadId, text) => {
      const runConfig = await runConfigForThread(options, threadId, botDefaultRunConfig);
      const { agent } = await options.createAgent(withDingtalkAgentRuntime(runConfig));
      let deltaListener: ((event: unknown) => void) | null = null;
      if (cardStream && typeof agent.onEvent === 'function') {
        deltaListener = (event: unknown) => {
          const evt = event as { type?: string; delta?: string };
          if (evt?.type === 'agent_message.delta' && typeof evt.delta === 'string') {
            cardStream.append(evt.delta);
          }
        };
        agent.onEvent(deltaListener);
      }
      try {
        const result = await runTopLevelBotTurn(options, agent, threadId, { type: 'text', text }, runConfig.maxActiveTasks ?? 4);
        publishBotTurnEvents(options, threadId, result.items, result.usage);
        return { text: sanitizeDingtalkAgentReply(latestAgentText(result.items), locale) };
      } finally {
        deltaListener = null;
      }
    },
    send: async (outbound) => {
      // 只有当卡片已启动（active 或 finalized）时才 finalize；
      // pending 表示没有收到过任何 delta（例如 runTurn 返回空文本、或卡片创建失败前的错误路径），直接走 markdown。
      // Chinese translation: only finalize when the card was actually started (lazily triggered by deltas).
      const useCard = cardStream && (cardStream.status === 'active' || cardStream.status === 'finalized');
      if (useCard) {
        const ok = await cardStream!.finalize(outbound.text).catch(() => false);
        if (ok) return;
        await appendDingtalkBotLog('info', 'AI card finalize failed, falling back to markdown', {
          tenantId: options.tenantId,
          error: cardStream!.error,
        });
      }
      const ct = outbound.metadata?.conversationType === 'group' ? '2' : '1';
      await client.sendMarkdown({
        conversationType: ct,
        conversationId: outbound.chatId,
        text: outbound.text,
      });
    },
  });

  try {
    return await gateway.handleMessage(message);
  } catch (err) {
    if (cardStream && cardStream.status !== 'finalized' && cardStream.status !== 'failed') {
      await cardStream.abort(err instanceof Error ? err.message : String(err)).catch(() => { /* ignore */ });
    }
    throw err;
  }
}

function dingtalkToBotMessage(msg: DingtalkInboundMessage): BotInboundMessage {
  const chatType = msg.conversationType === '2' ? 'group' : 'dm';
  return {
    platform: 'dingtalk',
    chatType,
    chatId: msg.conversationId,
    userId: msg.senderStaffId,
    userName: msg.senderNick || msg.senderStaffId,
    text: msg.text,
    messageId: msg.messageId,
    attachments: msg.attachments,
    metadata: {
      conversationType: chatType,
      conversationId: msg.conversationId,
      sessionWebhook: msg.sessionWebhook,
      attachments: msg.attachments,
    },
  };
}

function sanitizeDingtalkAgentReply(text: string, locale: string): string {
  const cleaned = text
    .replace(
      /\n?\[Tool dingtalk [^\]]+\]\s*\nDingTalk tool result redacted\. Do not reuse this prior tool call or reveal internal routing details\.\n?/g,
      '\n',
    )
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (cleaned === text.trim()) return cleaned;
  const lines = cleaned.split(/\n+/).map((line) => line.trim()).filter(Boolean);
  const resultLine = [...lines].reverse().find((line) => (
    /已发送|发送失败|sent|failed/i.test(line)
  ));
  return resultLine ?? (locale === 'en' ? 'Sent.' : '已发送。');
}

function isDingtalkUserAllowed(config: BotConfigLike, userId: string): boolean {
  const allowed = config.dingtalk.allowedUsers;
  if (!allowed || allowed.length === 0) return true;
  return allowed.includes(userId);
}

async function appendDingtalkBotLog(level: 'info' | 'error', message: string, meta: Record<string, unknown> = {}): Promise<void> {
  try {
    await mkdir(BOT_LOG_DIR, { recursive: true });
    const safeMeta = sanitizeLogMeta(meta);
    await appendFile(DINGTALK_BOT_LOG_PATH, `${JSON.stringify({
      time: new Date().toISOString(),
      level,
      message,
      ...safeMeta,
    })}\n`, 'utf8');
  } catch {
    // 日志绝不能中断 webhook 处理
  }
}

// 停止所有租户的钉钉 Stream 连接（供 graceful shutdown 使用）
export function shutdownAllDingtalkClients(): void {
  for (const [, client] of dingtalkClients) {
    try { client.stopStream(); } catch { /* ignore */ }
  }
  dingtalkClients.clear();
  dingtalkAutoStartAttempted.clear();
}

// 自动启动指定租户配置中标记了 autoStart 的钉钉 Stream
// 可接受部分 options（缺省字段会使用安全 fallback），用于启动钩子和懒启动两种场景
// Chinese translation: auto-start dingtalk stream for tenant; tolerates partial options for boot/lazy-start
export async function autoStartDingtalkForTenant(
  options: Partial<BotRouteOptions> & Pick<BotRouteOptions, 'store' | 'getDefaultRunConfig' | 'createAgent'>,
): Promise<void> {
  const store = options.store;
  const config = await readBotConfig(store);
  if (!config.dingtalk.enabled || !config.dingtalk.autoStart) return;
  if (config.dingtalk.connectionMode !== 'stream') return;
  if (!config.dingtalk.clientId || !config.dingtalk.clientSecret) return;
  const tenantId = options.tenantId?.trim() || 'default';
  if (dingtalkAutoStartAttempted.has(tenantId)) return;
  dingtalkAutoStartAttempted.add(tenantId);
  const fullOptions: BotRouteOptions = {
    req: options.req ?? null as unknown as IncomingMessage,
    res: options.res ?? null as unknown as ServerResponse,
    url: options.url ?? new URL('http://localhost'),
    segments: options.segments ?? [],
    store,
    getDefaultRunConfig: options.getDefaultRunConfig,
    getThreadRunConfig: options.getThreadRunConfig,
    createAgent: options.createAgent as BotRouteOptions['createAgent'],
    createWeixinClient: options.createWeixinClient,
    createId: options.createId ?? (() => `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`),
    now: options.now ?? (() => new Date().toISOString()),
    tenantId,
    publishEvent: options.publishEvent,
  };
  const client = getOrCreateDingtalkClient(fullOptions, config);
  if (!client.isStreamRunning) {
    const result = await client.startStream();
    if (result.connected) {
      await appendDingtalkBotLog('info', 'dingtalk auto-started', { tenantId, trigger: options.req ? 'lazy' : 'boot' });
    } else {
      await appendDingtalkBotLog('error', 'dingtalk auto-start failed', { tenantId, error: result.error });
    }
  }
}
