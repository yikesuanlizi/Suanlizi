// 机器人配置存储键 — Chinese: bot config storage key
export const BOT_CONFIG_KEY = 'bot.config.v1';
// 遗留微信桥接 URL 默认值 — Chinese: legacy WeChat bridge URL default
export const LEGACY_WEIXIN_BRIDGE_URL = 'http://127.0.0.1:18790/api/v1/admin/rpc';
// 微信桥接默认 URL（动态推断） — Chinese: WeChat bridge default URL (dynamic)
export const DEFAULT_WEIXIN_BRIDGE_URL = defaultWeixinBridgeUrl();

export interface BotPlatformConfig {
  enabled: boolean;
}

// 微信桥接模式：桌面托管 | 外部 RPC — Chinese: WeChat bridge mode
export type WeixinBridgeMode = 'desktop_managed' | 'external_rpc';

// 钉钉连接模式：Stream Push（无需公网IP） | Webhook（需公网回调）
export type DingtalkConnectionMode = 'stream' | 'webhook';

export interface WeixinBotConfig extends BotPlatformConfig {
  bridgeMode: WeixinBridgeMode;
  bridgeUrl: string;
  accountId: string;
  activeThreadId: string;
  autoStartMonitor: boolean;
  syncHistoryOnConnect: boolean;
}

export interface DingtalkBotConfig extends BotPlatformConfig {
  connectionMode: DingtalkConnectionMode;
  clientId: string;
  clientSecret: string;
  robotCode: string;
  cardTemplateId: string;
  targetGroupName: string;
  targetGroupConversationId: string;
  targetGroupSessionWebhook: string;
  lastDetectedGroupConversationId: string;
  lastDetectedGroupSessionWebhook: string;
  lastDetectedGroupAt: string;
  allowedUsers: string[];
  webhookSecret: string;
  activeThreadId: string;
  autoStart: boolean;
}

// 钉钉 CLI (dws) 配置 — 与机器人搭配使用，Agent 通过 CLI 主动操作钉钉企业数据
// Chinese: DingTalk CLI (dws) config — works alongside the bot, Agent proactively operates DingTalk enterprise data
export interface DwsCliConfig {
  enabled: boolean;
  /** dws 可执行文件路径，留空则用 PATH 中的 dws */
  binaryPath: string;
  /** OAuth 自建应用 AppKey（留空则用交互式登录） */
  clientId: string;
  /** OAuth 自建应用 AppSecret */
  clientSecret: string;
}

export interface BotConfig {
  weixin: WeixinBotConfig;
  feishu: BotPlatformConfig;
  dingtalk: DingtalkBotConfig;
  dwsCli: DwsCliConfig;
  qq: BotPlatformConfig;
}

// 机器人默认配置 — Chinese: default bot configuration
export const DEFAULT_BOT_CONFIG: BotConfig = {
  weixin: {
    enabled: false,
    bridgeMode: 'desktop_managed',
    bridgeUrl: DEFAULT_WEIXIN_BRIDGE_URL,
    accountId: '',
    activeThreadId: '',
    autoStartMonitor: true,
    syncHistoryOnConnect: true,
  },
  feishu: { enabled: false },
  dingtalk: {
    enabled: false,
    connectionMode: 'stream',
    clientId: '',
    clientSecret: '',
    robotCode: '',
    cardTemplateId: '',
    targetGroupName: '',
    targetGroupConversationId: '',
    targetGroupSessionWebhook: '',
    lastDetectedGroupConversationId: '',
    lastDetectedGroupSessionWebhook: '',
    lastDetectedGroupAt: '',
    allowedUsers: [],
    webhookSecret: '',
    activeThreadId: '',
    autoStart: true,
  },
  qq: { enabled: false },
  dwsCli: {
    enabled: false,
    binaryPath: '',
    clientId: '',
    clientSecret: '',
  },
};

// 规范化外部输入的机器人配置 — Chinese: normalize incoming bot config
export function normalizeBotConfig(input: unknown): BotConfig {
  const raw = asRecord(input);
  const weixin = asRecord(raw.weixin);
  const dingtalk = asRecord(raw.dingtalk);
  return {
    weixin: {
      enabled: normalizeBoolean(weixin.enabled, DEFAULT_BOT_CONFIG.weixin.enabled),
      bridgeMode: normalizeWeixinBridgeMode(weixin.bridgeMode),
      bridgeUrl: normalizeWeixinBridgeUrl(weixin.bridgeUrl),
      accountId: normalizeString(weixin.accountId, DEFAULT_BOT_CONFIG.weixin.accountId),
      activeThreadId: normalizeString(weixin.activeThreadId, DEFAULT_BOT_CONFIG.weixin.activeThreadId),
      autoStartMonitor: normalizeBoolean(weixin.autoStartMonitor, DEFAULT_BOT_CONFIG.weixin.autoStartMonitor),
      syncHistoryOnConnect: normalizeBoolean(weixin.syncHistoryOnConnect, DEFAULT_BOT_CONFIG.weixin.syncHistoryOnConnect),
    },
    feishu: normalizeSimplePlatform(raw.feishu),
    dingtalk: {
      enabled: normalizeBoolean(dingtalk.enabled, DEFAULT_BOT_CONFIG.dingtalk.enabled),
      connectionMode: normalizeDingtalkConnectionMode(dingtalk.connectionMode),
      clientId: normalizeString(dingtalk.clientId, DEFAULT_BOT_CONFIG.dingtalk.clientId),
      clientSecret: normalizeString(dingtalk.clientSecret, DEFAULT_BOT_CONFIG.dingtalk.clientSecret),
      robotCode: normalizeString(dingtalk.robotCode, DEFAULT_BOT_CONFIG.dingtalk.robotCode),
      cardTemplateId: normalizeString(dingtalk.cardTemplateId, DEFAULT_BOT_CONFIG.dingtalk.cardTemplateId),
      targetGroupName: normalizeString(dingtalk.targetGroupName, DEFAULT_BOT_CONFIG.dingtalk.targetGroupName),
      targetGroupConversationId: normalizeString(dingtalk.targetGroupConversationId, DEFAULT_BOT_CONFIG.dingtalk.targetGroupConversationId),
      targetGroupSessionWebhook: normalizeString(dingtalk.targetGroupSessionWebhook, DEFAULT_BOT_CONFIG.dingtalk.targetGroupSessionWebhook),
      lastDetectedGroupConversationId: normalizeString(dingtalk.lastDetectedGroupConversationId, DEFAULT_BOT_CONFIG.dingtalk.lastDetectedGroupConversationId),
      lastDetectedGroupSessionWebhook: normalizeString(dingtalk.lastDetectedGroupSessionWebhook, DEFAULT_BOT_CONFIG.dingtalk.lastDetectedGroupSessionWebhook),
      lastDetectedGroupAt: normalizeString(dingtalk.lastDetectedGroupAt, DEFAULT_BOT_CONFIG.dingtalk.lastDetectedGroupAt),
      allowedUsers: normalizeStringArray(dingtalk.allowedUsers, DEFAULT_BOT_CONFIG.dingtalk.allowedUsers),
      webhookSecret: normalizeString(dingtalk.webhookSecret, DEFAULT_BOT_CONFIG.dingtalk.webhookSecret),
      activeThreadId: normalizeString(dingtalk.activeThreadId, DEFAULT_BOT_CONFIG.dingtalk.activeThreadId),
      autoStart: normalizeBoolean(dingtalk.autoStart, DEFAULT_BOT_CONFIG.dingtalk.autoStart),
    },
    qq: normalizeSimplePlatform(raw.qq),
    dwsCli: normalizeDwsCliConfig(raw.dwsCli),
  };
}

// 输出面向公众的机器人配置（隐藏敏感字段） — Chinese: public bot config (hides secrets)
export function publicBotConfig(config: BotConfig): BotConfig {
  return {
    ...config,
    weixin: {
      ...config.weixin,
      accountId: maskSecret(config.weixin.accountId),
    },
    dingtalk: {
      ...config.dingtalk,
      clientId: maskSecret(config.dingtalk.clientId),
      clientSecret: maskSecret(config.dingtalk.clientSecret),
      targetGroupSessionWebhook: maskSecret(config.dingtalk.targetGroupSessionWebhook),
      lastDetectedGroupSessionWebhook: maskSecret(config.dingtalk.lastDetectedGroupSessionWebhook),
      webhookSecret: maskSecret(config.dingtalk.webhookSecret),
    },
    dwsCli: {
      ...config.dwsCli,
      clientSecret: maskSecret(config.dwsCli.clientSecret),
    },
  };
}

// 合并当前配置与用户提供的补丁 — Chinese: merge current config with user patch
export function mergeBotConfig(current: BotConfig, patch: unknown): BotConfig {
  const raw = asRecord(patch);
  const rawWeixin = asRecord(raw.weixin);
  const rawDingtalk = asRecord(raw.dingtalk);
  const weixinPatch = {
    ...rawWeixin,
  } as Record<string, unknown>;
  if (Object.prototype.hasOwnProperty.call(rawWeixin, 'accountId')) {
    // 若账户 ID 已是掩码格式，则保留原值 — Chinese: if accountId is masked, keep original
    weixinPatch.accountId = isMaskedValue(rawWeixin.accountId)
      ? current.weixin.accountId
      : rawWeixin.accountId;
  }
  const dingtalkPatch = { ...rawDingtalk } as Record<string, unknown>;
  if (Object.prototype.hasOwnProperty.call(rawDingtalk, 'clientId')) {
    dingtalkPatch.clientId = isMaskedValue(rawDingtalk.clientId)
      ? current.dingtalk.clientId
      : rawDingtalk.clientId;
  }
  if (Object.prototype.hasOwnProperty.call(rawDingtalk, 'clientSecret')) {
    dingtalkPatch.clientSecret = isMaskedValue(rawDingtalk.clientSecret)
      ? current.dingtalk.clientSecret
      : rawDingtalk.clientSecret;
  }
  if (Object.prototype.hasOwnProperty.call(rawDingtalk, 'webhookSecret')) {
    dingtalkPatch.webhookSecret = isMaskedValue(rawDingtalk.webhookSecret)
      ? current.dingtalk.webhookSecret
      : rawDingtalk.webhookSecret;
  }
  if (Object.prototype.hasOwnProperty.call(rawDingtalk, 'targetGroupSessionWebhook')) {
    dingtalkPatch.targetGroupSessionWebhook = isMaskedValue(rawDingtalk.targetGroupSessionWebhook)
      ? current.dingtalk.targetGroupSessionWebhook
      : rawDingtalk.targetGroupSessionWebhook;
  }
  if (Object.prototype.hasOwnProperty.call(rawDingtalk, 'lastDetectedGroupSessionWebhook')) {
    dingtalkPatch.lastDetectedGroupSessionWebhook = isMaskedValue(rawDingtalk.lastDetectedGroupSessionWebhook)
      ? current.dingtalk.lastDetectedGroupSessionWebhook
      : rawDingtalk.lastDetectedGroupSessionWebhook;
  }
  const rawDwsCli = asRecord(raw.dwsCli);
  const dwsCliPatch = { ...rawDwsCli } as Record<string, unknown>;
  if (Object.prototype.hasOwnProperty.call(rawDwsCli, 'clientSecret')) {
    dwsCliPatch.clientSecret = isMaskedValue(rawDwsCli.clientSecret)
      ? current.dwsCli.clientSecret
      : rawDwsCli.clientSecret;
  }
  return normalizeBotConfig({
    ...current,
    ...raw,
    weixin: { ...current.weixin, ...weixinPatch },
    feishu: { ...current.feishu, ...asRecord(raw.feishu) },
    dingtalk: { ...current.dingtalk, ...dingtalkPatch },
    dwsCli: { ...current.dwsCli, ...dwsCliPatch },
    qq: { ...current.qq, ...asRecord(raw.qq) },
  });
}

// 规范化简单平台配置（仅 enabled 字段） — Chinese: normalize simple platform
function normalizeSimplePlatform(input: unknown): BotPlatformConfig {
  const raw = asRecord(input);
  return { enabled: normalizeBoolean(raw.enabled, false) };
}

// 规范化 dws CLI 配置 — Chinese: normalize dws CLI config
function normalizeDwsCliConfig(input: unknown): DwsCliConfig {
  const raw = asRecord(input);
  return {
    enabled: normalizeBoolean(raw.enabled, DEFAULT_BOT_CONFIG.dwsCli.enabled),
    binaryPath: normalizeString(raw.binaryPath, DEFAULT_BOT_CONFIG.dwsCli.binaryPath),
    clientId: normalizeString(raw.clientId, DEFAULT_BOT_CONFIG.dwsCli.clientId),
    clientSecret: normalizeString(raw.clientSecret, DEFAULT_BOT_CONFIG.dwsCli.clientSecret),
  };
}

function normalizeBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function normalizeString(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value.trim() : fallback;
}

function normalizeWeixinBridgeUrl(_value: unknown): string {
  const value = normalizeString(_value, DEFAULT_WEIXIN_BRIDGE_URL);
  return value || DEFAULT_WEIXIN_BRIDGE_URL;
}

// 运行时规范化微信桥接 URL（从遗留默认值迁移到新推断值） — Chinese: runtime normalize WeChat bridge URL
export function normalizeRuntimeWeixinBridgeUrl(config: BotConfig): BotConfig {
  if (config.weixin.bridgeMode !== 'desktop_managed') return config;
  if (config.weixin.bridgeUrl !== LEGACY_WEIXIN_BRIDGE_URL) return config;
  if (DEFAULT_WEIXIN_BRIDGE_URL === LEGACY_WEIXIN_BRIDGE_URL) return config;
  return {
    ...config,
    weixin: {
      ...config.weixin,
      bridgeUrl: DEFAULT_WEIXIN_BRIDGE_URL,
    },
  };
}

function normalizeWeixinBridgeMode(value: unknown): WeixinBridgeMode {
  return value === 'external_rpc' ? 'external_rpc' : 'desktop_managed';
}

function normalizeDingtalkConnectionMode(value: unknown): DingtalkConnectionMode {
  return value === 'webhook' ? 'webhook' : 'stream';
}

function normalizeStringArray(value: unknown, fallback: string[]): string[] {
  if (Array.isArray(value)) {
    return value.map((item) => (typeof item === 'string' ? item.trim() : '')).filter(Boolean);
  }
  if (typeof value === 'string') {
    return value.split(',').map((s) => s.trim()).filter(Boolean);
  }
  return [...fallback];
}

// 将未知值转换为 Record<string, unknown> — Chinese: coerce unknown to record
function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

// 掩码敏感字符串 — Chinese: mask a sensitive string
function maskSecret(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  return trimmed.length > 8 ? `${trimmed.slice(0, 4)}...${trimmed.slice(-4)}` : '****';
}

// 判断一个值是否是掩码过的字符串（包含 ...） — Chinese: detect masked value
function isMaskedValue(value: unknown): boolean {
  return typeof value === 'string' && value.includes('...');
}

// 推断微信桥接 URL：优先 SUANLIZI_WEIXIN_BRIDGE_URL，否则使用端口默认值 — Chinese: default WeChat bridge URL
function defaultWeixinBridgeUrl(): string {
  const explicit = process.env.SUANLIZI_WEIXIN_BRIDGE_URL?.trim();
  if (explicit) return explicit;
  const port = process.env.SUANLIZI_WEIXIN_BRIDGE_PORT?.trim() || '18790';
  return `http://127.0.0.1:${port}/api/v1/admin/rpc`;
}
