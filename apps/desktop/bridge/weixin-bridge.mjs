import { randomBytes, randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import os from 'node:os';

const requireFromHere = createRequire(import.meta.url);
const PORT = Number(process.env.SUANLIZI_WEIXIN_BRIDGE_PORT || 18790);
const API_URL = (process.env.SUANLIZI_API_URL || 'http://127.0.0.1:4127').replace(/\/+$/, '');
const STATE_ROOT = process.env.SUANLIZI_WEIXIN_STATE_DIR || join(os.homedir(), '.suanlizi', 'weixin-bridge');
const LOG_DIR = process.env.SUANLIZI_LOG_DIR || join(os.homedir(), '.suanlizi', 'logs');
const BRIDGE_LOG_PATH = join(LOG_DIR, 'weixin-bridge.log');
const WEIXIN_PLUGIN_ID = 'openclaw-weixin';
const WEIXIN_API_BASE_URL = 'https://ilinkai.weixin.qq.com';
const WEIXIN_CDN_BASE_URL = 'https://novac2c.cdn.weixin.qq.com/c2c';
const WEIXIN_DEFAULT_BOT_TYPE = '3';
const LOGIN_TTL_MS = 5 * 60_000;
const QR_LONG_POLL_TIMEOUT_MS = 35_000;
const DEFAULT_LONG_POLL_TIMEOUT_MS = 35_000;
const DEFAULT_API_TIMEOUT_MS = 15_000;
const RETRY_DELAY_MS = 2_000;
const BACKOFF_DELAY_MS = 30_000;
const WEIXIN_ACK_ENABLED = process.env.SUANLIZI_WEIXIN_ACK !== '0';
const WEIXIN_ACK_TEXT = process.env.SUANLIZI_WEIXIN_ACK_TEXT || '已收到，正在处理。';
const MessageType = { BOT: 2 };
const MessageItemType = { TEXT: 1, VOICE: 3 };
const MessageState = { FINISH: 2 };

let packageInfoCache = null;
const activeLogins = new Map();
const contextTokenStore = new Map();
const monitors = new Map();
const monitorDiagnostics = new Map();

function log(...args) {
  console.log('[weixin-bridge]', ...args);
  void appendBridgeLog('info', args.map((arg) => typeof arg === 'string' ? arg : JSON.stringify(arg)).join(' '));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function appendBridgeLog(level, message, meta = {}) {
  try {
    await mkdir(LOG_DIR, { recursive: true });
    const line = `${JSON.stringify({
      time: nowIso(),
      level,
      message,
      ...sanitizeLogMeta(meta),
    })}\n`;
    await appendFile(BRIDGE_LOG_PATH, line, 'utf8');
  } catch {
    // Logging must never break bridge polling.
  }
}

function sanitizeLogMeta(value) {
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => sanitizeLogMeta(item));
  if (!value || typeof value !== 'object') return value;
  const output = {};
  for (const [key, raw] of Object.entries(value)) {
    if (/token|authorization/i.test(key)) {
      output[key] = '[redacted]';
    } else if (typeof raw === 'string') {
      output[key] = raw.length > 500 ? `${raw.slice(0, 500)}...` : raw;
    } else {
      output[key] = sanitizeLogMeta(raw);
    }
  }
  return output;
}

function logMessageShape(message) {
  const record = asRecord(message);
  return {
    keys: Object.keys(record),
    message_type: record.message_type,
    message_id: record.message_id,
    from_user_id: record.from_user_id,
    item_list: Array.isArray(record.item_list)
      ? record.item_list.slice(0, 3).map((item) => {
          const itemRecord = asRecord(item);
          return {
            keys: Object.keys(itemRecord),
            type: itemRecord.type,
            text_item_keys: Object.keys(asRecord(itemRecord.text_item)),
            voice_item_keys: Object.keys(asRecord(itemRecord.voice_item)),
          };
        })
      : record.item_list,
  };
}

function nowIso() {
  return new Date().toISOString();
}

function monitorDiag(accountId) {
  const normalized = normalizeAccountId(accountId);
  const existing = monitorDiagnostics.get(normalized);
  if (existing) return existing;
  const created = {
    accountId: normalized,
    running: false,
    pollCount: 0,
    messageCount: 0,
    webhookCount: 0,
    skippedInitialCount: 0,
    lastPollAt: '',
    lastMessageAt: '',
    lastWebhookAt: '',
    lastError: '',
    lastInboundText: '',
    lastWebhookResult: '',
  };
  monitorDiagnostics.set(normalized, created);
  return created;
}

function updateMonitorDiag(accountId, patch) {
  const current = monitorDiag(accountId);
  monitorDiagnostics.set(current.accountId, { ...current, ...patch });
}

function asRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : {};
}

function recordString(record, key) {
  const value = record[key];
  return typeof value === 'string' ? value.trim() : '';
}

function resolvePackagePath(packageName, subpath) {
  try {
    return requireFromHere.resolve(`${packageName}/${subpath}`);
  } catch {
    return null;
  }
}

function resolveWeixinPluginRoot() {
  const packageJson = resolvePackagePath('@tencent-weixin/openclaw-weixin', 'package.json');
  return packageJson ? dirname(packageJson) : null;
}

function readWeixinPackageInfo() {
  if (packageInfoCache) return packageInfoCache;
  const packageJson = resolvePackagePath('@tencent-weixin/openclaw-weixin', 'package.json');
  if (!packageJson) {
    throw new Error('Built-in WeChat login component is missing. Install @tencent-weixin/openclaw-weixin in @suanlizi/desktop.');
  }
  const parsed = JSON.parse(readFileSync(packageJson, 'utf8'));
  packageInfoCache = {
    version: typeof parsed.version === 'string' ? parsed.version : '0.0.0',
    appId: typeof parsed.ilink_appid === 'string' ? parsed.ilink_appid : 'bot',
  };
  return packageInfoCache;
}

function buildClientVersion(version) {
  const [major = 0, minor = 0, patch = 0] = version
    .split('.')
    .map((part) => Number.parseInt(part, 10))
    .map((part) => Number.isFinite(part) ? part : 0);
  return ((major & 0xff) << 16) | ((minor & 0xff) << 8) | (patch & 0xff);
}

function buildBaseInfo() {
  const info = readWeixinPackageInfo();
  return {
    channel_version: info.version,
    bot_agent: `Suanlizi/${process.env.npm_package_version || '0.1.0'}`,
  };
}

function randomWechatUin() {
  const uint32 = randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(uint32), 'utf8').toString('base64');
}

function buildCommonHeaders() {
  const info = readWeixinPackageInfo();
  return {
    'iLink-App-Id': info.appId,
    'iLink-App-ClientVersion': String(buildClientVersion(info.version)),
  };
}

function buildHeaders(token) {
  return {
    'Content-Type': 'application/json',
    AuthorizationType: 'ilink_bot_token',
    'X-WECHAT-UIN': randomWechatUin(),
    ...buildCommonHeaders(),
    ...(token?.trim() ? { Authorization: `Bearer ${token.trim()}` } : {}),
  };
}

async function readJsonResponse(res) {
  const text = await res.text();
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return { message: text.trim() || res.statusText };
  }
}

async function apiGet(baseUrl, endpoint, timeoutMs, label) {
  const res = await fetch(new URL(endpoint, `${baseUrl.replace(/\/+$/, '')}/`).toString(), {
    headers: buildHeaders(),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const data = await readJsonResponse(res);
  if (!res.ok) throw new Error(`${label} ${res.status}: ${recordString(data, 'message') || JSON.stringify(data)}`);
  return data;
}

async function apiPost(baseUrl, endpoint, body, options = {}) {
  const res = await fetch(new URL(endpoint, `${baseUrl.replace(/\/+$/, '')}/`).toString(), {
    method: 'POST',
    headers: buildHeaders(options.token),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_API_TIMEOUT_MS),
  });
  const data = await readJsonResponse(res);
  if (!res.ok) throw new Error(`${options.label || 'apiPost'} ${res.status}: ${recordString(data, 'message') || JSON.stringify(data)}`);
  return data;
}

function weixinStateDir() {
  return join(STATE_ROOT, WEIXIN_PLUGIN_ID);
}

function accountsIndexPath() {
  return join(weixinStateDir(), 'accounts.json');
}

function accountsDir() {
  return join(weixinStateDir(), 'accounts');
}

function accountPath(accountId) {
  return join(accountsDir(), `${accountId}.json`);
}

function syncBufPath(accountId) {
  return join(accountsDir(), `${accountId}.sync.json`);
}

function contextTokensPath(accountId) {
  return join(accountsDir(), `${accountId}.context-tokens.json`);
}

function isBlockedObjectKey(value) {
  return value === '__proto__' || value === 'prototype' || value === 'constructor';
}

function normalizeAccountId(value) {
  const trimmed = value.trim();
  if (!trimmed) return 'default';
  const lowered = trimmed.toLowerCase();
  const normalized = /^[a-z0-9][a-z0-9_-]{0,63}$/i.test(trimmed)
    ? lowered
    : lowered.replace(/[^a-z0-9_-]+/g, '-').replace(/^-+/, '').replace(/-+$/, '').slice(0, 64);
  return normalized && !isBlockedObjectKey(normalized) ? normalized : 'default';
}

async function ensureStateDirs() {
  await mkdir(accountsDir(), { recursive: true });
}

async function readJsonFile(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'));
}

async function writeJsonIfChanged(filePath, value) {
  const next = `${JSON.stringify(value, null, 2)}\n`;
  try {
    if ((await readFile(filePath, 'utf8')) === next) return;
  } catch {
    // create below
  }
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, next, 'utf8');
}

async function listIndexedWeixinAccountIds() {
  try {
    const parsed = await readJsonFile(accountsIndexPath());
    return Array.isArray(parsed) ? parsed.filter((id) => typeof id === 'string' && id.trim()) : [];
  } catch {
    return [];
  }
}

async function registerWeixinAccountId(accountId) {
  await ensureStateDirs();
  const existing = await listIndexedWeixinAccountIds();
  if (!existing.includes(accountId)) await writeJsonIfChanged(accountsIndexPath(), [...existing, accountId]);
}

async function unregisterWeixinAccountId(accountId) {
  const existing = await listIndexedWeixinAccountIds();
  const next = existing.filter((id) => id !== accountId);
  if (next.length !== existing.length) await writeJsonIfChanged(accountsIndexPath(), next);
}

async function loadWeixinAccountData(accountId) {
  try {
    return asRecord(await readJsonFile(accountPath(accountId)));
  } catch {
    return null;
  }
}

async function saveWeixinAccount(accountId, update) {
  await ensureStateDirs();
  const existing = await loadWeixinAccountData(accountId) ?? {};
  const token = update.token?.trim() || existing.token?.trim();
  const baseUrl = update.baseUrl?.trim() || existing.baseUrl?.trim();
  const userId = update.userId !== undefined ? update.userId.trim() || undefined : existing.userId?.trim() || undefined;
  await writeJsonIfChanged(accountPath(accountId), {
    ...(token ? { token, savedAt: new Date().toISOString() } : {}),
    ...(baseUrl ? { baseUrl } : {}),
    ...(userId ? { userId } : {}),
  });
  await registerWeixinAccountId(accountId);
}

async function clearWeixinAccount(accountId) {
  for (const filePath of [accountPath(accountId), syncBufPath(accountId), contextTokensPath(accountId)]) {
    try { await unlink(filePath); } catch { /* ignore */ }
  }
  await unregisterWeixinAccountId(accountId);
}

async function clearStaleAccountsForUserId(currentAccountId, userId) {
  if (!userId.trim()) return;
  for (const id of await listIndexedWeixinAccountIds()) {
    if (id === currentAccountId) continue;
    const data = await loadWeixinAccountData(id);
    if (data?.userId?.trim() === userId) await clearWeixinAccount(id);
  }
}

async function resolveWeixinAccount(accountId) {
  const id = normalizeAccountId(accountId);
  const data = await loadWeixinAccountData(id);
  const token = data?.token?.trim();
  return {
    accountId: id,
    baseUrl: data?.baseUrl?.trim() || WEIXIN_API_BASE_URL,
    cdnBaseUrl: WEIXIN_CDN_BASE_URL,
    token,
    configured: Boolean(token),
    userId: data?.userId?.trim() || undefined,
  };
}

async function localTokenList() {
  const ids = await listIndexedWeixinAccountIds();
  const tokens = [];
  for (let index = ids.length - 1; index >= 0 && tokens.length < 10; index -= 1) {
    const data = await loadWeixinAccountData(ids[index]);
    const token = data?.token?.trim();
    if (token) tokens.push(token);
  }
  return tokens;
}

async function fetchQRCode(botType = WEIXIN_DEFAULT_BOT_TYPE) {
  return apiPost(
    WEIXIN_API_BASE_URL,
    `ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(botType)}`,
    { local_token_list: await localTokenList() },
    { label: 'fetchQRCode' },
  );
}

async function pollQRStatus(baseUrl, qrcode) {
  try {
    return await apiGet(baseUrl, `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`, QR_LONG_POLL_TIMEOUT_MS, 'pollQRStatus');
  } catch (error) {
    if (error instanceof Error && error.name === 'TimeoutError') return { status: 'wait' };
    log('QR status polling failed; retrying.', error instanceof Error ? error.message : String(error));
    return { status: 'wait' };
  }
}

function isLoginFresh(login) {
  return Date.now() - login.startedAt < LOGIN_TTL_MS;
}

function purgeExpiredLogins() {
  for (const [key, login] of activeLogins) {
    if (!isLoginFresh(login)) activeLogins.delete(key);
  }
}

async function startWeixinLogin(params) {
  readWeixinPackageInfo();
  purgeExpiredLogins();
  const force = params.force === true;
  const sessionKey = recordString(params, 'accountId') || randomUUID();
  const existing = activeLogins.get(sessionKey);
  if (!force && existing && isLoginFresh(existing) && existing.qrcodeUrl) {
    return { qrcode: existing.qrcodeUrl, qrUrl: existing.qrcodeUrl, qrDataUrl: existing.qrcodeUrl, sessionKey, message: '二维码已显示，请用手机微信扫描。' };
  }
  const qr = await fetchQRCode(recordString(params, 'botType') || WEIXIN_DEFAULT_BOT_TYPE);
  const qrcode = recordString(qr, 'qrcode');
  const qrcodeUrl = recordString(qr, 'qrcode_img_content') || recordString(qr, 'qrcodeUrl');
  if (!qrcode || !qrcodeUrl) throw new Error(recordString(qr, 'message') || 'WeChat QR response is incomplete.');
  activeLogins.set(sessionKey, { sessionKey, qrcode, qrcodeUrl, startedAt: Date.now(), currentApiBaseUrl: WEIXIN_API_BASE_URL });
  return { qrcode: qrcodeUrl, qrUrl: qrcodeUrl, qrDataUrl: qrcodeUrl, sessionKey, message: '用手机微信扫描二维码，以继续连接。' };
}

async function waitForWeixinLogin(params) {
  const sessionKey = recordString(params, 'accountId') || recordString(params, 'sessionKey');
  const login = activeLogins.get(sessionKey);
  if (!login) return { connected: false, message: '当前没有进行中的登录，请先发起登录。' };
  if (!isLoginFresh(login)) {
    activeLogins.delete(sessionKey);
    return { connected: false, message: '二维码已过期，请重新生成。' };
  }
  const timeoutMs = Math.max(Number(params.timeoutMs) || 480_000, 1_000);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = await pollQRStatus(login.currentApiBaseUrl ?? WEIXIN_API_BASE_URL, login.qrcode);
    switch (recordString(status, 'status')) {
      case 'wait':
      case 'scaned':
        break;
      case 'need_verifycode':
        return { connected: false, message: '微信要求输入手机端验证码。当前登录流程暂不支持验证码，请重新生成二维码后再试。' };
      case 'expired':
        activeLogins.delete(sessionKey);
        return { connected: false, message: '二维码已过期，请重新生成。' };
      case 'verify_code_blocked':
        activeLogins.delete(sessionKey);
        return { connected: false, message: '多次输入错误，连接流程已停止。请稍后再试。' };
      case 'binded_redirect':
        activeLogins.delete(sessionKey);
        return { connected: true, alreadyConnected: true, accountId: normalizeAccountId(sessionKey), sessionKey, message: '已连接过此 Suanlizi，无需重复连接。' };
      case 'scaned_but_redirect': {
        const redirectHost = recordString(status, 'redirect_host');
        if (redirectHost) login.currentApiBaseUrl = `https://${redirectHost}`;
        break;
      }
      case 'confirmed': {
        const rawAccountId = recordString(status, 'ilink_bot_id');
        const token = recordString(status, 'bot_token');
        if (!rawAccountId || !token) {
          activeLogins.delete(sessionKey);
          return { connected: false, message: '登录失败：服务器未返回完整账号信息。' };
        }
        const accountId = normalizeAccountId(rawAccountId);
        const baseUrl = recordString(status, 'baseurl') || WEIXIN_API_BASE_URL;
        const userId = recordString(status, 'ilink_user_id');
        await saveWeixinAccount(accountId, { token, baseUrl, userId });
        await clearStaleAccountsForUserId(accountId, userId);
        activeLogins.delete(sessionKey);
        return { connected: true, accountId, sessionKey, baseUrl, userId, message: '已将此 Suanlizi 连接到微信。' };
      }
    }
    await sleep(1_000);
  }
  return { connected: false, sessionKey, message: '等待手机微信确认。' };
}

function contextTokenKey(accountId, userId) {
  return `${accountId}:${userId}`;
}

async function persistContextTokens(accountId) {
  const prefix = `${accountId}:`;
  const tokens = {};
  for (const [key, value] of contextTokenStore) {
    if (key.startsWith(prefix)) tokens[key.slice(prefix.length)] = value;
  }
  await writeJsonIfChanged(contextTokensPath(accountId), tokens);
}

async function restoreContextTokens(accountId) {
  try {
    const tokens = asRecord(await readJsonFile(contextTokensPath(accountId)));
    for (const [userId, token] of Object.entries(tokens)) {
      if (typeof token === 'string') contextTokenStore.set(contextTokenKey(accountId, userId), token);
    }
  } catch {
    // no persisted tokens yet
  }
}

async function setContextToken(accountId, userId, token) {
  contextTokenStore.set(contextTokenKey(accountId, userId), token);
  await persistContextTokens(accountId);
}

function getContextToken(accountId, userId) {
  return contextTokenStore.get(contextTokenKey(accountId, userId));
}

async function getUpdates(account, getUpdatesBuf, timeoutMs) {
  try {
    return await apiPost(
      account.baseUrl,
      'ilink/bot/getupdates',
      { get_updates_buf: getUpdatesBuf, base_info: buildBaseInfo() },
      { token: account.token, timeoutMs, label: 'getUpdates' },
    );
  } catch (error) {
    if (error instanceof Error && error.name === 'TimeoutError') return { ret: 0, msgs: [], get_updates_buf: getUpdatesBuf };
    throw error;
  }
}

async function notifyStart(account) {
  await apiPost(
    account.baseUrl,
    'ilink/bot/msg/notifystart',
    { base_info: buildBaseInfo() },
    { token: account.token, timeoutMs: 10_000, label: 'notifyStart' },
  );
}

async function notifyStop(account) {
  await apiPost(
    account.baseUrl,
    'ilink/bot/msg/notifystop',
    { base_info: buildBaseInfo() },
    { token: account.token, timeoutMs: 10_000, label: 'notifyStop' },
  );
}

async function sendMessageWeixin(params) {
  const messageId = `suanlizi-weixin-${randomUUID()}`;
  await appendBridgeLog('info', 'send WeChat message request', {
    accountId: params.account.accountId,
    to: params.to,
    textPreview: String(params.text ?? '').slice(0, 240),
    length: String(params.text ?? '').length,
    hasContextToken: Boolean(params.contextToken),
  });
  await apiPost(
    params.account.baseUrl,
    'ilink/bot/sendmessage',
    {
      msg: {
        from_user_id: '',
        to_user_id: params.to,
        client_id: messageId,
        message_type: MessageType.BOT,
        message_state: MessageState.FINISH,
        item_list: [{ type: MessageItemType.TEXT, text_item: { text: params.text } }],
        context_token: params.contextToken,
      },
      base_info: buildBaseInfo(),
    },
    { token: params.account.token, timeoutMs: params.timeoutMs ?? DEFAULT_API_TIMEOUT_MS, label: 'sendMessage' },
  );
  await appendBridgeLog('info', 'send WeChat message completed', {
    accountId: params.account.accountId,
    to: params.to,
    messageId,
  });
  return { messageId };
}

function textFromItemList(itemList) {
  if (!Array.isArray(itemList)) return '';
  for (const item of itemList) {
    const record = asRecord(item);
    if (record.type === MessageItemType.TEXT) {
      const text = asRecord(record.text_item).text;
      if (text != null) return String(text).trim();
    }
    if (record.type === MessageItemType.VOICE) {
      const text = asRecord(record.voice_item).text;
      if (text != null) return String(text).trim();
    }
  }
  return '';
}

async function postToSuanliziWebhook(message, accountId) {
  const text = textFromItemList(message.item_list);
  if (!text) {
    await appendBridgeLog('warn', 'skip message without text', { accountId, message: logMessageShape(message) });
    return;
  }
  const from = message.from_user_id != null ? String(message.from_user_id).trim() : '';
  const messageId = message.message_id != null && String(message.message_id).trim()
    ? String(message.message_id).trim()
    : `suanlizi-weixin-${randomUUID()}`;
  const body = {
    provider: 'weixin',
    platform: 'weixin',
    text,
    chatId: from,
    userId: from,
    userName: from || 'WeChat',
    senderId: from,
    senderName: from || 'WeChat',
    messageId,
    chatType: 'dm',
    accountId,
  };
  await appendBridgeLog('info', 'post inbound message to Suanlizi', {
    accountId,
    apiUrl: API_URL,
    body,
    source: logMessageShape(message),
  });
  updateMonitorDiag(accountId, {
    lastInboundText: text.slice(0, 120),
    lastMessageAt: nowIso(),
  });
  if (WEIXIN_ACK_ENABLED && from) {
    try {
      const account = await resolveWeixinAccount(accountId);
      if (account.configured && account.token?.trim()) {
        await restoreContextTokens(account.accountId);
        await sendMessageWeixin({
          account,
          to: from,
          text: WEIXIN_ACK_TEXT,
          contextToken: getContextToken(account.accountId, from),
          timeoutMs: 8_000,
        });
        await appendBridgeLog('info', 'sent Weixin processing ack', {
          accountId,
          to: from,
        });
      }
    } catch (error) {
      await appendBridgeLog('error', 'failed to send Weixin processing ack', {
        accountId,
        to: from,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  const res = await fetch(`${API_URL}/api/bot/weixin/webhook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(650_000),
  });
  const data = await readJsonResponse(res);
  await appendBridgeLog(res.ok && data.ok !== false ? 'info' : 'error', 'Suanlizi webhook response', {
    accountId,
    status: res.status,
    data,
  });
  if (!res.ok || data.ok === false) throw new Error(recordString(data, 'message') || recordString(data, 'error') || `Suanlizi webhook HTTP ${res.status}`);
  const reply = recordString(asRecord(data.result), 'reply');
  if (reply) {
    try {
      const account = await resolveWeixinAccount(accountId);
      if (!account.configured || !account.token?.trim()) {
        throw new Error(`WeChat account is not configured: ${accountId}`);
      }
      await restoreContextTokens(account.accountId);
      // Keep the final answer as one WeChat response. We do not split long replies into
      // many bubbles because that makes the remote assistant hard to read.
      const result = await sendMessageWeixin({
        account,
        to: from,
        text: reply,
        contextToken: getContextToken(account.accountId, from),
      });
      await appendBridgeLog('info', 'sent Suanlizi reply to WeChat', {
        accountId,
        to: from,
        length: reply.length,
        messageId: result.messageId,
      });
    } catch (error) {
      await appendBridgeLog('error', 'failed to send Suanlizi reply to WeChat', {
        accountId,
        to: from,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  updateMonitorDiag(accountId, {
    webhookCount: monitorDiag(accountId).webhookCount + 1,
    lastWebhookAt: nowIso(),
    lastWebhookResult: recordString(asRecord(data.result), 'status') || 'ok',
    lastError: '',
  });
  return data;
}

async function monitorWeixinAccount(accountId, signal, options = {}) {
  const account = await resolveWeixinAccount(accountId);
  if (!account.configured || !account.token?.trim()) throw new Error(`WeChat account is not configured: ${accountId}`);
  updateMonitorDiag(account.accountId, { running: true, lastError: '' });
  await restoreContextTokens(account.accountId);
  let getUpdatesBuf = '';
  try {
    const sync = asRecord(await readJsonFile(syncBufPath(account.accountId)));
    getUpdatesBuf = recordString(sync, 'get_updates_buf') || recordString(sync, 'getUpdatesBuf');
  } catch {
    // first sync
  }
  try {
    await notifyStart(account);
    updateMonitorDiag(account.accountId, { notifyStartedAt: nowIso(), notifyStartError: '' });
  } catch (error) {
    log('notifyStart failed; continuing monitor', account.accountId, error instanceof Error ? error.message : String(error));
    updateMonitorDiag(account.accountId, {
      notifyStartError: error instanceof Error ? error.message : String(error),
    });
  }
  let skipInitialMessages = options.syncHistory === false && !getUpdatesBuf;
  let nextTimeoutMs = DEFAULT_LONG_POLL_TIMEOUT_MS;
  let consecutiveFailures = 0;
  try {
    while (!signal.aborted) {
      try {
        const resp = await getUpdates(account, getUpdatesBuf, nextTimeoutMs);
        updateMonitorDiag(account.accountId, {
          pollCount: monitorDiag(account.accountId).pollCount + 1,
          lastPollAt: nowIso(),
        });
        if (typeof resp.longpolling_timeout_ms === 'number' && resp.longpolling_timeout_ms > 0) nextTimeoutMs = resp.longpolling_timeout_ms;
        const ret = Number(resp.ret ?? 0);
        const errcode = Number(resp.errcode ?? 0);
        if (ret !== 0 || errcode !== 0) {
          consecutiveFailures += 1;
          await sleep(consecutiveFailures >= 3 ? BACKOFF_DELAY_MS : RETRY_DELAY_MS);
          if (consecutiveFailures >= 3) consecutiveFailures = 0;
          continue;
        }
        consecutiveFailures = 0;
        const nextBuf = typeof resp.get_updates_buf === 'string' ? resp.get_updates_buf : '';
        if (nextBuf) {
          getUpdatesBuf = nextBuf;
          await writeJsonIfChanged(syncBufPath(account.accountId), { get_updates_buf: getUpdatesBuf });
        }
        const messages = Array.isArray(resp.msgs) ? resp.msgs : [];
        if (skipInitialMessages) {
          skipInitialMessages = false;
          updateMonitorDiag(account.accountId, {
            skippedInitialCount: monitorDiag(account.accountId).skippedInitialCount + messages.length,
          });
          continue;
        }
        for (const message of messages) {
          if (signal.aborted) return;
          if (message.message_type === MessageType.BOT) continue;
          const from = message.from_user_id != null ? String(message.from_user_id).trim() : '';
          if (!from) continue;
          if (message.context_token) await setContextToken(account.accountId, from, message.context_token);
          updateMonitorDiag(account.accountId, {
            messageCount: monitorDiag(account.accountId).messageCount + 1,
            lastMessageAt: nowIso(),
          });
          await postToSuanliziWebhook(message, account.accountId);
        }
      } catch (error) {
        if (signal.aborted) return;
        log('monitor iteration failed', account.accountId, error instanceof Error ? error.message : String(error));
        updateMonitorDiag(account.accountId, {
          lastError: error instanceof Error ? error.message : String(error),
        });
        consecutiveFailures += 1;
        await sleep(consecutiveFailures >= 3 ? BACKOFF_DELAY_MS : RETRY_DELAY_MS);
        if (consecutiveFailures >= 3) consecutiveFailures = 0;
      }
    }
  } finally {
    updateMonitorDiag(account.accountId, { running: false, stoppedAt: nowIso() });
    try {
      await notifyStop(account);
    } catch {
      // best effort
    }
  }
}

function startAccountMonitor(accountId, options = {}) {
  const normalized = normalizeAccountId(accountId);
  const existing = monitors.get(normalized);
  if (existing && !existing.controller.signal.aborted) return;
  const controller = new AbortController();
  updateMonitorDiag(normalized, { running: true, startedAt: nowIso(), lastError: '' });
  const promise = monitorWeixinAccount(normalized, controller.signal, options)
    .catch((error) => {
      if (!controller.signal.aborted) log('monitor stopped', normalized, error instanceof Error ? error.message : String(error));
      updateMonitorDiag(normalized, {
        running: false,
        lastError: error instanceof Error ? error.message : String(error),
      });
    })
    .finally(() => {
      if (monitors.get(normalized)?.controller === controller) monitors.delete(normalized);
      updateMonitorDiag(normalized, { running: false, stoppedAt: nowIso() });
    });
  monitors.set(normalized, { accountId: normalized, controller, promise });
}

async function startWeixinChannels(params) {
  const requestedAccountId = recordString(params, 'accountId');
  const syncHistory = params.syncHistory !== false;
  const accountIds = requestedAccountId ? [normalizeAccountId(requestedAccountId)] : await listIndexedWeixinAccountIds();
  for (const accountId of accountIds) startAccountMonitor(accountId, { syncHistory });
  return { started: accountIds };
}

async function stopWeixinChannels(params) {
  const requestedAccountId = recordString(params, 'accountId');
  const targets = requestedAccountId ? [normalizeAccountId(requestedAccountId)] : [...monitors.keys()];
  for (const accountId of targets) {
    monitors.get(accountId)?.controller.abort();
    monitors.delete(accountId);
  }
  return { stopped: targets };
}

async function statusWeixinChannels() {
  const accounts = await listIndexedWeixinAccountIds();
  const active = [...monitors.keys()];
  for (const accountId of accounts) {
    monitorDiag(accountId);
  }
  return {
    apiUrl: API_URL,
    accounts,
    active,
    monitors: [...monitorDiagnostics.values()].map((diag) => ({
      ...diag,
      running: monitors.has(diag.accountId) && diag.running !== false,
    })),
  };
}

async function logoutWeixinAccounts(params) {
  const requestedAccountId = recordString(params, 'accountId');
  const targets = requestedAccountId ? [normalizeAccountId(requestedAccountId)] : await listIndexedWeixinAccountIds();
  await stopWeixinChannels({ accountId: requestedAccountId });
  for (const accountId of targets) {
    for (const key of [...contextTokenStore.keys()]) {
      if (key.startsWith(`${accountId}:`)) contextTokenStore.delete(key);
    }
    await clearWeixinAccount(accountId);
  }
  return { loggedOut: targets };
}

async function sendBridgeMessage(params) {
  const accountId = normalizeAccountId(recordString(params, 'accountId'));
  const to = recordString(params, 'to');
  const text = recordString(params, 'text');
  await appendBridgeLog('info', 'bridge rpc web.message.send received', {
    accountId,
    to,
    length: text.length,
    textPreview: text.slice(0, 240),
  });
  if (!accountId) return { ok: false, message: 'WeChat account id is missing.' };
  if (!to) return { ok: false, message: 'WeChat recipient is missing.' };
  if (!text) return { ok: false, message: 'Message is empty.' };
  const account = await resolveWeixinAccount(accountId);
  if (!account.configured || !account.token?.trim()) {
    await appendBridgeLog('error', 'bridge rpc web.message.send rejected: account not configured', { accountId, to });
    return { ok: false, message: 'WeChat account is not configured.' };
  }
  await restoreContextTokens(account.accountId);
  const result = await sendMessageWeixin({ account, to, text, contextToken: recordString(params, 'contextToken') || getContextToken(account.accountId, to) });
  await appendBridgeLog('info', 'bridge rpc web.message.send completed', { accountId, to, messageId: result.messageId });
  return { ok: true, messageId: result.messageId };
}

async function dispatchRpc(method, params) {
  switch (method) {
    case 'web.login.start':
      return startWeixinLogin(params);
    case 'web.login.wait':
      return waitForWeixinLogin(params);
    case 'channels.start':
      return startWeixinChannels(params);
    case 'channels.status':
      return statusWeixinChannels();
    case 'channels.stop':
      return stopWeixinChannels(params);
    case 'web.message.send':
      return sendBridgeMessage(params);
    case 'accounts.list':
      return { accounts: await listIndexedWeixinAccountIds() };
    case 'accounts.logout':
      return logoutWeixinAccounts(params);
    default:
      throw new Error(`Unknown WeChat bridge method: ${method}`);
  }
}

async function readRequestBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

function writeJson(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(`${JSON.stringify(body)}\n`);
}

async function handleBridgeRequest(request, response) {
  try {
    const url = new URL(request.url || '/', `http://127.0.0.1:${PORT}`);
    if (request.method === 'GET' && url.pathname === '/health') {
      writeJson(response, 200, { ok: true, status: 'live', managed: true });
      return;
    }
    if (request.method !== 'POST' || url.pathname !== '/api/v1/admin/rpc') {
      writeJson(response, 404, { ok: false, message: 'Not found' });
      return;
    }
    const body = asRecord(JSON.parse(await readRequestBody(request)));
    const id = body.id ?? null;
    const method = recordString(body, 'method');
    const params = asRecord(body.params);
    if (!method) throw new Error('JSON-RPC method is required.');
    const result = await dispatchRpc(method, params);
    writeJson(response, 200, { jsonrpc: '2.0', id, ok: true, result });
  } catch (error) {
    writeJson(response, 200, {
      jsonrpc: '2.0',
      id: null,
      ok: false,
      error: { message: error instanceof Error ? error.message : String(error) },
    });
  }
}

async function main() {
  if (!resolveWeixinPluginRoot()) {
    throw new Error('Built-in WeChat login component is missing. Install @tencent-weixin/openclaw-weixin in @suanlizi/desktop.');
  }
  await ensureStateDirs();
  const server = createHttpServer((request, response) => {
    void handleBridgeRequest(request, response);
  });
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen({ host: '127.0.0.1', port: PORT }, resolve);
    });
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'EADDRINUSE') {
      const live = await isExistingBridgeLive();
      const hint = live
        ? `A WeChat bridge is already running on port ${PORT}. Stop the old desktop dev process or kill the old node bridge before starting Suanlizi again.`
        : `Port ${PORT} is already in use by another non-Suanlizi process. Set SUANLIZI_WEIXIN_BRIDGE_PORT to another port or close the process using that port.`;
      throw new Error(hint);
    }
    throw error;
  }
  log(`started on http://127.0.0.1:${PORT}/api/v1/admin/rpc`);
  await startWeixinChannels({});
  const stop = () => {
    for (const monitor of monitors.values()) monitor.controller.abort();
    server.close();
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

async function isExistingBridgeLive() {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/health`, { signal: AbortSignal.timeout(1_500) });
    const data = await readJsonResponse(res);
    return res.ok && data.managed === true && (data.ok === true || data.status === 'live' || data.status === 'ok');
  } catch {
    return false;
  }
}

main().catch((error) => {
  console.error('[weixin-bridge] failed:', error instanceof Error ? error.message : String(error));
  process.exit(1);
});
