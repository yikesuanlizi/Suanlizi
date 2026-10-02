import * as fs from 'node:fs';
import * as os from 'node:os';
import path from 'node:path';
import { AgentLoop, McpRuntimeManager, SystemMonitor, createEmptySystemMonitorStatus, type AgentConfig } from '@suanlizi/runtime';
import { LlamaSlotLeaseManager, ModelGateway, type ModelConfig, type OpenAIModelCapabilities } from '@suanlizi/model-gateway';
import { AutoApproveHandler, DEFAULT_PRESET, getPreset, type ApprovalHandler, type SandboxConfig } from '@suanlizi/sandbox';
import { LocalHookRegistry, LocalSkillRegistryCache } from '@suanlizi/extensions';
import { createI18n, systemPromptKey } from '@suanlizi/i18n';
import { resolveModelCapabilities, type SystemMonitorStatus, type ThreadEvent } from '@suanlizi/protocol';
import type { ThreadStore } from '@suanlizi/storage';
import { BUILTIN_TOOLS, ToolRegistry } from '@suanlizi/tools';
import { createDynamicContextProvider } from '../services/dynamicContext.js';
import { createDingtalkForwardToolsForStore, dingtalkForwardingSystemPrompt } from '../services/dingtalkForwardTool.js';
import {
  WEB_PROVIDER_SECRETS_KEY,
  A2A_CONFIG_KEY,
  normalizeA2AConfig,
  createConfigRepository,
  hiddenChatWorkspaceRoot,
  resolveConfig,
  resolveWebProviderRuntimeConfig,
  type AgentRunConfig,
  type WebProviderSecrets,
} from '../config/config.js';
import { DEFAULT_TENANT_ID, type TenantContext } from '../shared/tenant.js';
import { ActiveRunRegistry } from './activeRunRegistry.js';

export type AgentRuntimeOverrides = Pick<AgentConfig, 'systemPrompt' | 'tools'> & {
  systemPromptSuffix?: string;
};
export type AgentCreateConfig = Partial<AgentRunConfig> & Partial<AgentRuntimeOverrides>;

export interface ProviderModelList {
  provider: string;
  models: string[];
  error?: string;
}

export interface ModelContextProbe {
  provider: string;
  contextTokens?: number;
  maxOutputTokens?: number;
  trainingContextTokens?: number;
  slotCount?: number;
  source: 'server' | 'model' | 'unavailable';
  reachable?: boolean;
  error?: string;
}

export interface TenantRuntimeOptions {
  rootStore: ThreadStore;
  approvalBroker: ApprovalHandler;
  publishEvent(event: ThreadEvent, tenantId?: string): void;
  /** Explicit llama.cpp slot capacity. Omit when the server capacity is unknown. */
  llamaSlotCount?: number;
}

export interface TenantRuntime {
  storeForTenant(tenantContext: TenantContext): ThreadStore;
  configRepoForTenant(tenantContext: TenantContext): ReturnType<typeof createConfigRepository>;
  mcpManagerForTenant(tenantContext: TenantContext): McpRuntimeManager;
  skillCacheForTenant(tenantContext: TenantContext): LocalSkillRegistryCache;
  getDefaultAgent(tenantContext?: TenantContext): Promise<AgentLoop>;
  getSystemMonitorStatus(tenantContext?: TenantContext): Promise<SystemMonitorStatus>;
  resetDefaultAgent(tenantContext: TenantContext): void;
  saveDefaultRunConfig(configPatch: Partial<AgentRunConfig>, tenantContext: TenantContext): Promise<AgentRunConfig>;
  createAgent(
    configPatch?: AgentCreateConfig,
    tenantContext?: TenantContext,
  ): Promise<{ agent: AgentLoop; model: ModelGateway; config: AgentRunConfig }>;
  probeModelCapabilities(
    configPatch?: Partial<AgentRunConfig>,
    tenantContext?: TenantContext,
  ): Promise<ModelContextProbe>;
  listProviderModels(
    configPatch?: Pick<AgentRunConfig, 'provider' | 'model' | 'baseUrl'>,
    tenantContext?: TenantContext,
  ): Promise<ProviderModelList>;
  activeRunRegistry: ActiveRunRegistry;
}

export function createLlamaSlotLeaseManager(slotCount: unknown): LlamaSlotLeaseManager | undefined {
  if (!Number.isInteger(slotCount) || (slotCount as number) < 1) return undefined;
  return new LlamaSlotLeaseManager(slotCount as number);
}

/** Resolve the effective model window while keeping the llama server as a hard ceiling. */
export function resolveEffectiveContextTokens(
  configured: number | undefined,
  serverContext: number | undefined,
  fallback: number | undefined,
): number | undefined {
  if (serverContext && configured) return Math.min(configured, serverContext);
  if (serverContext) return serverContext;
  return configured ?? fallback;
}

export function createTenantRuntime(options: TenantRuntimeOptions): TenantRuntime {
  const defaultTenantContext: TenantContext = { tenantId: DEFAULT_TENANT_ID };
  const configRepo = createConfigRepository(options.rootStore);
  const mcpManager = new McpRuntimeManager();
  const skillCache = new LocalSkillRegistryCache();
  let defaultAgent: AgentLoop | null = null;
  let defaultAgentPromise: Promise<AgentLoop> | null = null;
  const activeRunRegistry = new ActiveRunRegistry();
  // One host sampler per tenant runtime. AgentLoop instances (including
  // short-lived probes and child agents) observe this same sampler.
  let sharedSystemMonitor: SystemMonitor | null = null;
  // Start conservatively at one slot. A llama.cpp /props probe upgrades this
  // capacity to the server's reported -np value before the first request.
  const configuredLlamaSlots = Number.isInteger(options.llamaSlotCount) && (options.llamaSlotCount ?? 0) > 0
    ? options.llamaSlotCount
    : 1;
  const llamaSlotLeases = new LlamaSlotLeaseManager(configuredLlamaSlots);
  // Settings probing and Agent construction can happen close together. Keep a
  // short-lived, in-flight cache here so one custom endpoint is not hit twice
  // for the same provider/model while the user is editing its configuration.
  const openAIProbeCache = new Map<string, { at: number; promise: Promise<OpenAIModelCapabilities> }>();

  function openAIProbeKey(config: Pick<AgentRunConfig, 'provider' | 'baseUrl' | 'model'>): string {
    return [config.provider.trim(), (config.baseUrl ?? '').trim().replace(/\/+$/, ''), config.model.trim()].join('|');
  }

  async function probeOpenAIModelCapabilities(
    model: ModelGateway,
    config: Pick<AgentRunConfig, 'provider' | 'baseUrl' | 'model'>,
  ): Promise<OpenAIModelCapabilities> {
    const key = openAIProbeKey(config);
    const now = Date.now();
    const cached = openAIProbeCache.get(key);
    if (cached && now - cached.at < 30_000) return cached.promise;

    const promise = model.probeOpenAIModelCapabilities();
    openAIProbeCache.set(key, { at: now, promise });
    try {
      return await promise;
    } catch (error) {
      // Aborted/transport failures should not poison the cache for 30 seconds.
      if (openAIProbeCache.get(key)?.promise === promise) openAIProbeCache.delete(key);
      throw error;
    }
  }

  function bindAgentToRegistry(agent: AgentLoop): void {
    agent.onEvent((event) => {
      if (event.type === 'turn.started') {
        activeRunRegistry.register({
          runId: event.runId,
          threadId: event.threadId,
          turnId: event.turnId,
          interrupt: () => {
            agent.interrupt(event.threadId);
          },
          resolveDecision: (response) => agent.resolveUserDecision(event.threadId, response),
        });
      } else if (event.type === 'turn.completed' || event.type === 'turn.failed') {
        activeRunRegistry.finish(event.runId);
      }
    });
  }

  function storeForTenant(_tenantContext: TenantContext): ThreadStore {
    return options.rootStore;
  }

  function configRepoForTenant(_tenantContext: TenantContext): ReturnType<typeof createConfigRepository> {
    return configRepo;
  }

  function mcpManagerForTenant(_tenantContext: TenantContext): McpRuntimeManager {
    return mcpManager;
  }

  function skillCacheForTenant(_tenantContext: TenantContext): LocalSkillRegistryCache {
    return skillCache;
  }

  async function getDefaultAgent(_tenantContext: TenantContext = defaultTenantContext): Promise<AgentLoop> {
    if (defaultAgent) return defaultAgent;
    if (!defaultAgentPromise) {
      defaultAgentPromise = createAgent({}, defaultTenantContext)
        .then(({ agent }) => {
          defaultAgent = agent;
          return agent;
        })
        .finally(() => {
          defaultAgentPromise = null;
        });
    }
    return defaultAgentPromise;
  }

  async function getSystemMonitorStatus(_tenantContext: TenantContext = defaultTenantContext): Promise<SystemMonitorStatus> {
    const config = await configRepo.getDefaultRunConfig();
    if (sharedSystemMonitor) return sharedSystemMonitor.getStatus();
    if (defaultAgent) return defaultAgent.getSystemMonitorStatus();
    if (config.systemMonitorSamplingEnabled === true) {
      // Do not block the monitor panel on model/MCP/skill initialization. Expose
      // an enabled "sampling" state now; the next poll returns real data.
      void getDefaultAgent(_tenantContext).catch(() => {
        // A later status poll can retry runtime initialization.
      });
      return createEmptySystemMonitorStatus(true);
    }
    // Avoid constructing a model/runtime merely to render a disabled monitor panel.
    return createEmptySystemMonitorStatus(false);
  }

  async function probeModelCapabilities(
    configPatch: Partial<AgentRunConfig> = {},
    _tenantContext: TenantContext = defaultTenantContext,
  ): Promise<ModelContextProbe> {
    const base = await configRepo.getDefaultRunConfig();
    // A capability probe must report the server/model window, not reuse an
    // older user override that could hide the current llama.cpp slot size.
    const config = resolveConfig({ ...base, ...configPatch, modelContextTokens: undefined });
    const fallback = resolveModelCapabilities({
      provider: config.provider,
      model: config.model,
      baseUrl: config.baseUrl,
      modelContextTokens: undefined,
      modelMaxOutputTokens: config.modelMaxOutputTokens,
    });
    const model = new ModelGateway({
      provider: config.provider,
      model: config.model,
      baseUrl: config.baseUrl ?? '',
      apiKey: config.apiKey,
      maxTokens: config.modelMaxOutputTokens ?? 8192,
      temperature: 0.2,
      timeoutMs: 15_000,
      reasoningEffort: config.reasoningEffort,
    });

    if (model.getProfile().id === 'llama_cpp') {
      const capabilities = await model.probeLlamaCapabilities();
      return {
        provider: config.provider,
        ...(capabilities.contextTokens ? { contextTokens: capabilities.contextTokens } : {}),
        ...(capabilities.trainingContextTokens ? { trainingContextTokens: capabilities.trainingContextTokens } : {}),
        ...(capabilities.slotCount ? { slotCount: capabilities.slotCount } : {}),
        source: capabilities.contextTokens ? 'server' : 'unavailable',
        reachable: capabilities.reachable,
        ...(capabilities.error ? { error: capabilities.error } : {}),
      };
    }

    if (!fallback.contextTokens && model.getProfile().transport !== 'anthropic_messages') {
      const capabilities = await probeOpenAIModelCapabilities(model, config);
      return {
        provider: config.provider,
        ...(capabilities.contextTokens ? { contextTokens: capabilities.contextTokens } : {}),
        ...(capabilities.maxOutputTokens ? { maxOutputTokens: capabilities.maxOutputTokens } : {}),
        source: capabilities.contextTokens ? 'server' : 'unavailable',
        reachable: capabilities.reachable,
        ...(capabilities.error ? { error: capabilities.error } : {}),
      };
    }

    return {
      provider: config.provider,
      ...(fallback.contextTokens ? { contextTokens: fallback.contextTokens } : {}),
      ...(fallback.maxOutputTokens ? { maxOutputTokens: fallback.maxOutputTokens } : {}),
      source: fallback.contextTokens ? 'model' : 'unavailable',
    };
  }

  function resetDefaultAgent(_tenantContext: TenantContext): void {
    defaultAgent = null;
  }

  async function saveDefaultRunConfig(
    configPatch: Partial<AgentRunConfig>,
    tenantContext: TenantContext,
  ): Promise<AgentRunConfig> {
    const next = await configRepo.saveDefaultRunConfig(configPatch);
    if (configPatch.skillsRoot !== undefined) {
      skillCache.clear();
    }
    // 系统监控开关/阈值变更：热更新到当前运行中的 agent
    // — Chinese: system monitor toggle/threshold change: hot-update the currently running agent
    if (configPatch.systemMonitorEnabled !== undefined
      || configPatch.systemMonitorSamplingEnabled !== undefined
      || configPatch.systemMonitorGuardEnabled !== undefined
      || configPatch.systemMonitorLogRecordingEnabled !== undefined
      || configPatch.systemMonitorThresholds !== undefined) {
      const currentAgent = defaultAgent;
      if (currentAgent) {
        currentAgent.updateSystemMonitorConfig({
          enabled: configPatch.systemMonitorSamplingEnabled ?? configPatch.systemMonitorEnabled,
          guardEnabled: configPatch.systemMonitorGuardEnabled,
          logRecordingEnabled: configPatch.systemMonitorLogRecordingEnabled,
          thresholds: configPatch.systemMonitorThresholds,
        } as never);
      }
      if (sharedSystemMonitor) {
        sharedSystemMonitor.updateConfig({
          enabled: configPatch.systemMonitorSamplingEnabled ?? configPatch.systemMonitorEnabled,
          guardEnabled: configPatch.systemMonitorGuardEnabled,
          logRecordingEnabled: configPatch.systemMonitorLogRecordingEnabled,
          thresholds: configPatch.systemMonitorThresholds,
        });
        if (!sharedSystemMonitor.isEnabled()) {
          sharedSystemMonitor.stop();
          sharedSystemMonitor = null;
        }
      }
    }
    resetDefaultAgent(tenantContext);
    return next;
  }

  async function listProviderModels(
    configPatch: Partial<Pick<AgentRunConfig, 'provider' | 'model' | 'baseUrl'>> = {},
    _tenantContext: TenantContext = defaultTenantContext,
  ): Promise<ProviderModelList> {
    const base = await configRepo.getDefaultRunConfig();
    // Settings only needs provider/base URL; the API key is resolved from the
    // server configuration and never accepted from or returned to the client.
    const config = resolveConfig({ ...base, ...configPatch });
    const model = new ModelGateway({
      provider: config.provider,
      model: config.model,
      baseUrl: config.baseUrl ?? '',
      apiKey: config.apiKey,
      maxTokens: 1,
      temperature: 0,
      timeoutMs: 10_000,
    });
    const result = await model.listModels();
    return {
      provider: config.provider,
      models: result.models,
      ...(result.error ? { error: result.error } : {}),
    };
  }

  async function createAgent(
    configPatch: AgentCreateConfig = {},
    _tenantContext: TenantContext = defaultTenantContext,
  ): Promise<{ agent: AgentLoop; model: ModelGateway; config: AgentRunConfig }> {
    const tenantStore = options.rootStore;
    const tenantRepo = configRepo;
    const base = await tenantRepo.getDefaultRunConfig();
    const config = resolveConfig({ ...base, ...configPatch });
    const monitorConfig = {
      enabled: config.systemMonitorSamplingEnabled === true,
      guardEnabled: config.systemMonitorGuardEnabled === true,
      logRecordingEnabled: config.systemMonitorLogRecordingEnabled === true,
      thresholds: config.systemMonitorThresholds,
    };
    if (monitorConfig.enabled) {
      if (!sharedSystemMonitor) {
        sharedSystemMonitor = new SystemMonitor(monitorConfig);
        sharedSystemMonitor.start();
      } else {
        sharedSystemMonitor.updateConfig(monitorConfig);
      }
    }
    await prepareManagedWorkspaceDirectories(config.workspaceRoot);
    const defaultSystemPrompt = createI18n(config.locale ?? 'zh').t(systemPromptKey(config.locale ?? 'zh'));
    const connectorPrompt = dingtalkForwardingSystemPrompt(config.locale ?? 'zh');
    const runtimeSystemPrompt = `${configPatch.systemPrompt
      ?? (configPatch.systemPromptSuffix
        ? `${defaultSystemPrompt}\n\n${connectorPrompt}\n\n${configPatch.systemPromptSuffix}`
        : `${defaultSystemPrompt}\n\n${connectorPrompt}`)}

## Managed temporary files
For one-off scripts and disposable caches, use the application-managed tmp directory. Do not create runtime data folders or disposable caches in the project workspace. Application-managed tmp files may be removed after seven days; durable user-requested work belongs in the selected workspace.`;
    if (config.workspaceRoot === hiddenChatWorkspaceRoot(config.dataDir)) {
      fs.mkdirSync(config.workspaceRoot, { recursive: true });
    }
    const modelCapabilities = resolveModelCapabilities({
      provider: config.provider,
      model: config.model,
      baseUrl: config.baseUrl,
      modelContextTokens: config.modelContextTokens,
      modelMaxOutputTokens: config.modelMaxOutputTokens,
    });
    const modelConfig: ModelConfig = {
      provider: config.provider,
      model: config.model,
      baseUrl: config.baseUrl ?? '',
      apiKey: config.apiKey,
      maxTokens: config.modelMaxOutputTokens ?? 8192,
      temperature: 0.2,
      timeoutMs: (config.modelTimeoutSeconds ?? 120) * 1_000,
      reasoningEffort: config.reasoningEffort,
      contextTokens: config.modelContextTokens,
    };
    const model = new ModelGateway(modelConfig);
    let effectiveContextTokens = modelCapabilities.contextTokens;
    if (model.getProfile().id === 'llama_cpp') {
      // /props reports the effective per-slot window. Treat it as a hard
      // ceiling so a stale UI/config value cannot send an oversized prompt.
      const llamaCapabilities = await model.probeLlamaCapabilities();
      effectiveContextTokens = resolveEffectiveContextTokens(
        config.modelContextTokens,
        llamaCapabilities.contextTokens,
        modelCapabilities.contextTokens,
      );
    } else if (!effectiveContextTokens && model.getProfile().transport !== 'anthropic_messages') {
      // Custom/OpenAI-compatible providers often omit a static model rule. Ask
      // their metadata endpoint before AgentLoop falls back to its internal
      // history budget; never synthesize a 40K window from that fallback.
      const remoteCapabilities = await probeOpenAIModelCapabilities(model, config);
      effectiveContextTokens = remoteCapabilities.contextTokens;
    }
    const preset = getPreset(config.permissions) ?? DEFAULT_PRESET;
    const sandbox: SandboxConfig = {
      preset,
      workspaceRoot: config.workspaceRoot,
      execPolicyRules: [
        { pattern: [['git', 'jj']], decision: 'allow', justification: 'VCS commands are allowed.' },
        { pattern: ['npm', 'run'], decision: 'prompt', justification: 'npm scripts may have side effects.' },
        { pattern: ['rm', ['-rf', '-r']], decision: 'forbidden', justification: 'Recursive delete is too dangerous.' },
      ],
    };
    const skills = await skillCache.loadFromDirectory(config.skillsRoot);
    const hooks = new LocalHookRegistry();
    const webProviderSecrets = await tenantStore.getSetting<WebProviderSecrets>(WEB_PROVIDER_SECRETS_KEY) ?? {};
    const webProvider = resolveWebProviderRuntimeConfig(config, webProviderSecrets);
    await mcpManager.configure(await tenantRepo.listMcpServers(), { startEnabled: false });
    // 已启用的 MCP 服务器预启动，把具体工具直接暴露给 Agent
    // 未启用的 server 不会启动，也不会暴露任何工具
    // — Chinese: pre-start enabled MCP servers so concrete tools are exposed to the agent;
    //            disabled servers are not started and expose no tools
    const mcpTools = await mcpManager.toolDefinitions({ ensureStarted: true });
    // 读取 A2A 客户端配置 — Chinese: read A2A client config
    const a2aConfig = normalizeA2AConfig(await tenantStore.getSetting(A2A_CONFIG_KEY));
    const agent = new AgentLoop(({
      workspaceRoot: config.workspaceRoot,
      sandbox,
      model,
      llamaSlotLeaseManager: llamaSlotLeases,
      store: tenantStore,
      tenantId: DEFAULT_TENANT_ID,
      approvalHandler: preset.approval === 'never' ? new AutoApproveHandler() : options.approvalBroker,
      skills,
      hooks,
      locale: config.locale ?? 'zh',
      maxIterations: config.maxIterations,
      webSearchMode: config.webSearchMode,
      webProvider,
      runProfile: config.runProfile,
      modelContextTokens: effectiveContextTokens,
      modelMaxOutputTokens: modelConfig.maxTokens,
      agentRoles: config.agentRoles,
      systemPrompt: runtimeSystemPrompt,
      tools: configPatch.tools ?? createTenantToolRegistry(tenantStore, config.toolTimeoutSeconds),
      mcpTools,
      dynamicContextProvider: createDynamicContextProvider(tenantStore),
      memory: {
        memoryEnabled: config.memoryEnabled,
        autoExtractMemories: config.autoExtractMemories,
        useColdMemories: config.useColdMemories,
        memoryInjectLimit: config.memoryInjectLimit,
        memoryTokenBudget: config.memoryTokenBudget,
      },
      a2aClientEnabled: a2aConfig.clientEnabled,
      a2aRemotes: a2aConfig.remotes.map(r => r.url),
      // 中文注释：采样、轨迹记录和阈值 guard 分别由设置字段控制；guard 只在采样开启时生效。
      maxSubagentDepth: config.maxSubagentDepth ?? 1,
      maxParallelReadonlyTools: config.maxParallelReadonlyTools ?? 2,
      systemMonitor: ({
        ...monitorConfig,
      } as never),
      systemMonitorInstance: sharedSystemMonitor ?? undefined,
      skillsDirs: [config.skillsRoot],
    } as AgentConfig));
    agent.onEvent((event) => options.publishEvent(event, DEFAULT_TENANT_ID));
    bindAgentToRegistry(agent);
    await agent.loadSkillsFromConfiguredDirs();
    return { agent, model, config };
  }

  return {
    storeForTenant,
    configRepoForTenant,
    mcpManagerForTenant,
    skillCacheForTenant,
    getDefaultAgent,
    getSystemMonitorStatus,
    resetDefaultAgent,
    saveDefaultRunConfig,
    createAgent,
    probeModelCapabilities,
    listProviderModels,
    activeRunRegistry,
  };
}

export function createTenantToolRegistry(store: ThreadStore, toolTimeoutSeconds?: number): ToolRegistry {
  const registry = new ToolRegistry();
  const defaultTimeoutMs = toolTimeoutSeconds && toolTimeoutSeconds > 0
    ? toolTimeoutSeconds * 1_000
    : undefined;
  for (const tool of BUILTIN_TOOLS) {
    registry.register(defaultTimeoutMs ? { ...tool, timeoutMs: defaultTimeoutMs } : tool);
  }
  for (const tool of createDingtalkForwardToolsForStore(store)) {
    registry.register(defaultTimeoutMs ? { ...tool, timeoutMs: defaultTimeoutMs } : tool);
  }
  return registry;
}

async function prepareManagedWorkspaceDirectories(workspaceRoot: string): Promise<void> {
  const root = workspaceRoot.trim();
  if (!root) return;
  const tempRoot = process.env.SUANLIZI_DATA_DIR?.trim()
    ? path.join(process.env.SUANLIZI_DATA_DIR.trim(), 'tmp')
    : path.join(os.tmpdir(), 'suanlizi', path.basename(root) || 'default', 'tmp');
  await fs.promises.mkdir(tempRoot, { recursive: true });
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const entries = await fs.promises.readdir(tempRoot, { withFileTypes: true }).catch(() => []);
  await Promise.all(entries.map(async (entry) => {
    const entryPath = path.join(tempRoot, entry.name);
    const stats = await fs.promises.stat(entryPath).catch(() => null);
    if (!stats || stats.mtimeMs >= cutoff) return;
    await fs.promises.rm(entryPath, { recursive: entry.isDirectory(), force: true });
  }));
}
