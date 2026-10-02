import { DEFAULT_RUN_CONFIG_KEY, WEB_PROVIDER_SECRETS_KEY, A2A_CONFIG_KEY, DEFAULT_A2A_CONFIG, normalizeA2AConfig, publicA2AConfig, publicRunConfig, publicWebProviderConfig, type A2AConfig, type AgentRunConfig, type WebProviderSecrets } from '../config/config.js';
import { readJson, sendJson } from '../shared/http.js';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { redactAccessPolicyForPublicConfig, type AccessPolicyConfig } from '@suanlizi/protocol';
import type { ThreadStore } from '@suanlizi/storage';

// 设置路由选项 — Chinese: settings route options
export interface SettingsRouteOptions {
  req: IncomingMessage;
  res: ServerResponse;
  pathname: string;
  store: ThreadStore;
  getDefaultRunConfig(): Promise<AgentRunConfig>;
  saveDefaultRunConfig(configPatch: Partial<AgentRunConfig>): Promise<AgentRunConfig>;
  saveGlobalAccessPolicy(input: unknown): Promise<AccessPolicyConfig>;
  resetDefaultAgent(): void;
}

// 处理设置路由（读取 / 更新默认运行配置、Web 提供商密钥与 A2A 协议配置）
// — Chinese: handle settings routes (read/update default run config, web provider secrets, and A2A config)
export async function handleSettingsRoute(options: SettingsRouteOptions): Promise<boolean> {
  const { req, res, pathname, store } = options;
  // GET /api/settings — 返回公开的运行配置、Web 提供商配置与 A2A 配置
  // — Chinese: GET /api/settings — return public run config + web provider config + A2A config
  if (req.method === 'GET' && pathname === '/api/settings') {
    const stored = await store.getSetting<Partial<AgentRunConfig>>(DEFAULT_RUN_CONFIG_KEY);
    const webProviderSecrets = await store.getSetting<WebProviderSecrets>(WEB_PROVIDER_SECRETS_KEY) ?? {};
    const a2aConfig = normalizeA2AConfig(await store.getSetting<unknown>(A2A_CONFIG_KEY));
    sendJson(res, 200, {
      config: publicRunConfig(await options.getDefaultRunConfig()),
      stored: Boolean(stored),
      webProvider: publicWebProviderConfig(webProviderSecrets),
      a2a: publicA2AConfig(a2aConfig),
    });
    return true;
  }

  // PATCH /api/settings/access-policy — 保存全局持久访问规则；临时授权永远不写入设置
  // — Chinese: save global persistent access rules; temporary grants are never persisted
  if (req.method === 'PATCH' && pathname === '/api/settings/access-policy') {
    const body = await readJson<{ accessPolicy?: unknown }>(req);
    const accessPolicy = await options.saveGlobalAccessPolicy(body.accessPolicy ?? {});
    options.resetDefaultAgent();
    sendJson(res, 200, { accessPolicy: redactAccessPolicyForPublicConfig(accessPolicy) });
    return true;
  }

  // PATCH /api/settings — 更新配置（含清除/写入 firecrawl 密钥、A2A 配置）
  // — Chinese: PATCH /api/settings — update config (including clear/write firecrawl key, A2A config)
  if (req.method !== 'PATCH' || pathname !== '/api/settings') return false;
  const body = await readJson<{
    config?: Partial<AgentRunConfig>;
    webProvider?: { firecrawlApiKey?: string | null; clearFirecrawlApiKey?: boolean };
    a2a?: Partial<A2AConfig>;
  }>(req);
  const config = await options.saveDefaultRunConfig(body.config ?? {});
  if (body.config && Object.keys(body.config).length > 0) {
    options.resetDefaultAgent();
  }
  let webProviderSecrets = await store.getSetting<WebProviderSecrets>(WEB_PROVIDER_SECRETS_KEY) ?? {};
  if (body.webProvider?.clearFirecrawlApiKey) {
    const { firecrawlApiKey: _firecrawlApiKey, ...rest } = webProviderSecrets;
    webProviderSecrets = rest;
    await store.setSetting(WEB_PROVIDER_SECRETS_KEY, webProviderSecrets);
    options.resetDefaultAgent();
  } else if (typeof body.webProvider?.firecrawlApiKey === 'string' && body.webProvider.firecrawlApiKey.trim()) {
    webProviderSecrets = { ...webProviderSecrets, firecrawlApiKey: body.webProvider.firecrawlApiKey.trim() };
    await store.setSetting(WEB_PROVIDER_SECRETS_KEY, webProviderSecrets);
    options.resetDefaultAgent();
  }
  // 更新 A2A 配置（若有变更） — Chinese: update A2A config if provided
  let a2aConfig: A2AConfig = DEFAULT_A2A_CONFIG;
  if (body.a2a) {
    const current = normalizeA2AConfig(await store.getSetting<unknown>(A2A_CONFIG_KEY));
    a2aConfig = normalizeA2AConfig({
      ...current,
      ...body.a2a,
      remotes: body.a2a.remotes ?? current.remotes,
    });
    await store.setSetting(A2A_CONFIG_KEY, a2aConfig);
  } else {
    a2aConfig = normalizeA2AConfig(await store.getSetting<unknown>(A2A_CONFIG_KEY));
  }
  sendJson(res, 200, {
    ok: true,
    config: publicRunConfig(config),
    webProvider: publicWebProviderConfig(webProviderSecrets),
    a2a: publicA2AConfig(a2aConfig),
  });
  return true;
}
