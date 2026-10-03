import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { URL } from 'node:url';
import { listAllProviders, removeCustomProvider } from '@suanlizi/model-gateway';
import { createStore, resolveStorageOptions } from '@suanlizi/storage';
import { forkThread } from '@suanlizi/memory';
import type { PersistentAccessScope, ThreadEvent, ThreadItem, UserInput } from '@suanlizi/protocol';
import { handleA2ARoute } from './a2a/a2aRoute.js';
import { WebApprovalBroker } from './services/approval.js';
import { handleCompactThread } from './routes/compactRoute.js';
import { RequestBodyTooLargeError, readJson, sendError, sendJson } from './shared/http.js';
import { DEFAULT_TENANT_ID, tenantEventKey } from './shared/tenant.js';
import { generateServerId } from './shared/threadSerialization.js';
import { createThreadEventBus } from './services/threadEventBus.js';
import { installGracefulShutdown } from './runtime/shutdown.js';
import { handlePickWorkspaceDirectory } from './routes/workspacePicker.js';
import { autoStartDingtalkForTenant, handleBotRoute } from './routes/botRoute.js';
import { handleWorkspaceFilesRoute } from './routes/workspaceFiles.js';
import { handleTerminalRoute } from './routes/terminal.js';
import { handleSettingsRoute } from './routes/settingsRoute.js';
import { handleWorkflowRoute } from './routes/workflowRoute.js';
import { handleTaskRoute } from './routes/taskRoute.js';
import { handleWorkflowScriptRoute } from './routes/workflowScriptRoute.js';
import { taskWorkflowIntegrationForTenant, workflowScriptServiceForTenant } from './services/workflowScriptWiring.js';
import { createTaskGoalStatusService } from './services/taskGoalStatusService.js';
import { appendPersistentRule, persistentRuleFromApproval } from './services/accessPolicyRules.js';
import { adaptAgentLoopToPort, createA2AHandlerRegistry } from './services/a2aHandlerRegistry.js';
import { createSkillDraftService, skillInstallUrlsFromBody } from './services/skillDraftService.js';
import { handleRunMonitorRoute } from './routes/runMonitorRoute.js';
import { handleSystemMonitorRoute } from './routes/systemMonitorRoute.js';
import { handleMemoryRoute } from './routes/memoryRoute.js';
import { handleThreadRoutes } from './routes/threadRoutes.js';
import { harnessRuntimeRegistry } from './services/harnessRuntime.js';
import { terminateAllProcessTrees } from '@suanlizi/tools';
import { startTaskRunRecovery } from './services/taskRecovery.js';
import { reconcileTasksFromTags } from './services/taskReconcile.js';
import { reconcileThreadRuntimeOnStartup } from './services/threadRuntimeReconcile.js';
import { handleRollbackThreadRuntimeAction, handleRunControlAction } from './routes/threadRuntimeActions.js';
import { handleThreadSkillInstall } from './routes/threadSkillInstall.js';
import { deleteSkill, installSkillsFromGitHubUrls, writeSkillDraft, type SkillDraft } from './services/skills.js';
import { prepareMcpDraftRequest } from './services/mcpDraft.js';
import { shouldRetitleThread, titleFromInput } from './services/threadTitle.js';

const activeAgentProcesses: import('node:child_process').ChildProcess[] = [];
import { buildUserInputFromTurnRequest } from './services/turnInput.js';
import { defaultConfig, hiddenChatWorkspaceRoot, resolveConfig, type AgentRunConfig, type TurnRequest, A2A_CONFIG_KEY, normalizeA2AConfig } from './config/config.js';
import { createTenantRuntime } from './runtime/tenantRuntime.js';
import { applyCorsHeaders, resolveCorsOptions } from './shared/cors.js';
import { handleRequestGate } from './routes/requestGate.js';
import { handleStatusRoute } from './routes/statusRoute.js';
import { handleKeysRoute } from './routes/keysRoute.js';
import { handleModelCapabilitiesRoute } from './routes/modelCapabilitiesRoute.js';
import { handleProviderModelsRoute } from './routes/providerModelsRoute.js';
import { handleModelCatalogRoute } from './routes/modelCatalogRoute.js';
import { pruneOrphanCustomProviders, reconcileRemovedModelSelection } from './services/modelCatalogService.js';
import { handleOpsRoute, recoverOpsTasks } from './routes/opsRoute.js';
import { handleKnowledgeRoute } from './routes/knowledgeRoute.js';

const storageOptions = resolveStorageOptions();
const { store: rootStore, taskStore } = createStore(defaultConfig.dataDir);
// SSE 发布/订阅与回放缓冲已下沉到 ./services/threadEventBus.ts；本处只按需取用。
const {
  publishEvent,
  publishCompletedItems,
  closeThreadEventClients,
  clients: eventClients,
  history: threadEventHistory,
} = createThreadEventBus();
const approvalBroker = new WebApprovalBroker(5 * 60_000, (entry) => {
  publishEvent({
    type: 'approval.resolved',
    threadId: entry.threadId,
    turnId: entry.turnId,
    requestId: entry.requestId,
    approved: entry.approved,
    reason: entry.reason,
    status: entry.status,
  });
});

// 事件广播、回放缓冲与订阅关闭已下沉到 ./services/threadEventBus.ts。

// 审批面板的持久化规则构造已下沉到 ./services/accessPolicyRules.ts（§5：server.ts 只做装配）。

const tenantRuntime = createTenantRuntime({
  rootStore,
  approvalBroker,
  publishEvent,
});

// ─── Workflow 脚本服务（P4b）──────────────────────────────────────────────────
// 按租户缓存的进程级单例：service 内部持有 runId → AbortController 取消注册表，
// 必须跨请求共享（每请求新建会丢失取消能力）。子代理执行器走既有 AgentLoop
// runTurn（source='harness' + 用户不可见 + 不进冷记忆），权限治理不旁路。
// 工厂实现见 ./services/workflowScriptWiring.ts（含 runTurn 子代理执行器适配与按租户缓存）。

// A2A handler 的按租户单例缓存与 AgentCard 组装已下沉到 ./services/a2aHandlerRegistry.ts。
const a2aRegistry = createA2AHandlerRegistry({
  storeForTenant: (ctx) => tenantRuntime.storeForTenant(ctx),
  createRuntimePort: async (ctx) => adaptAgentLoopToPort(await tenantRuntime.getDefaultAgent(ctx)),
});

// Skill 草拟 / 安装回复的提示词组装与兼容回落已下沉到 ./services/skillDraftService.ts。
const skillDraftService = createSkillDraftService({
  createModel: async (configPatch, ctx) => (await tenantRuntime.createAgent(configPatch ?? {}, ctx)).model,
  defaultTenantContext: { tenantId: DEFAULT_TENANT_ID },
});

async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const segments = url.pathname.split('/').filter(Boolean);
  const corsOptions = resolveCorsOptions(process.env, false);
  applyCorsHeaders(req, res, corsOptions);

  if (await handleStatusRoute({ req, res, pathname: url.pathname, storageOptions, getDefaultRunConfig: () => tenantRuntime.configRepoForTenant({ tenantId: DEFAULT_TENANT_ID }).getDefaultRunConfig() })) return;

  const gate = handleRequestGate({ req, res, corsOptions });
  if (gate.handled) return;
  const { tenantContext } = gate;

  if (await handleSystemMonitorRoute({
    req,
    res,
    pathname: url.pathname,
    getStatus: () => tenantRuntime.getSystemMonitorStatus(tenantContext),
  })) return;

  const store = tenantRuntime.storeForTenant(tenantContext);
  const configRepo = tenantRuntime.configRepoForTenant(tenantContext);
  const {
    deleteModelPreset,
    getDefaultRunConfig,
    getGlobalAccessPolicy,
    getThreadAccessPolicy,
    getThreadConfigOverrides,
    getThreadRunConfig,
    listMcpServers,
    listModelPresets,
    publicThreadRunConfig,
    saveGlobalAccessPolicy,
    saveMcpServers,
    saveThreadAccessPolicy,
    saveThreadRunConfig,
    updateThreadConfigOverrides,
    upsertModelPreset,
  } = configRepo;
  const saveTenantDefaultRunConfig = (configPatch: Partial<AgentRunConfig>) => tenantRuntime.saveDefaultRunConfig(configPatch, tenantContext);
  const resetTenantDefaultAgent = () => tenantRuntime.resetDefaultAgent(tenantContext);
  const createTenantAgent = (config?: Partial<AgentRunConfig>) => tenantRuntime.createAgent(config ?? {}, tenantContext);
  const getTenantDefaultAgent = () => tenantRuntime.getDefaultAgent(tenantContext);
  const publishTenantEvent = (event: ThreadEvent) => publishEvent(event, tenantContext.tenantId);
  const goalStatusService = createTaskGoalStatusService({ taskStore, threadStore: store });
  const tenantMcpManager = tenantRuntime.mcpManagerForTenant(tenantContext);
  if (await handleBotRoute({
    req,
    res,
    url,
    segments,
    store,
    getDefaultRunConfig,
    getThreadRunConfig,
    createAgent: async (config) => ({ agent: (await createTenantAgent(config)).agent }),
    tenantId: tenantContext.tenantId,
    activeRunRegistry: tenantRuntime.activeRunRegistry,
    publishEvent: publishTenantEvent,
  })) return;
  if (await handleWorkspaceFilesRoute({ req, res, url })) return;
  if (await handleTerminalRoute({ req, res, url })) return;
  if (await handleKnowledgeRoute({ req, res, url, segments, store, tenantContext })) return;
  if (await handleOpsRoute({
    req,
    res,
    url,
    segments,
    store,
    tenantContext,
    // Ops 的模型调查始终使用只读权限，避免复用用户当前的写入预设。
    getAgent: async () => (await createTenantAgent({ permissions: 'read_only' })).agent,
  })) return;
  // Workflow 脚本 API（P4b）：validate → 批准启动 → result / cancel。
  // 必须装配在 handleTaskRoute 之前：taskRoute 会把 /api/tasks/:id/workflows/*
  // 当未知子段 404。子代理执行器注入见 workflowScriptServiceForTenant。
  if (await handleWorkflowScriptRoute({
    req,
    res,
    url,
    segments,
    service: workflowScriptServiceForTenant(tenantContext, {
      taskStore,
      publishEvent,
      createTenantAgent: async () => (await createTenantAgent()) as never,
    }),
  })) return;

  // 目标任务中心 API（P0：基础 CRUD 与查询） — English: goal-task routes (P0 CRUD/query)
  // P2 生命周期端点（pause/resume/cancel/retry/redirect/input/start）由同一注入点装配：
  // agent 复用租户缺省编排（生命周期写入需要完整权限，不复用 Ops 的只读预设）。
  if (await handleTaskRoute({
    req,
    res,
    url,
    segments,
    taskStore,
    tenantContext,
    getAgent: async () => (await createTenantAgent()).agent,
    publishEvent: publishTenantEvent,
    registry: harnessRuntimeRegistry,
    // P6：Goal × Workflow 组合（提案转发 + 证据预载）见 taskWorkflowIntegrationForTenant。
    workflow: taskWorkflowIntegrationForTenant(tenantContext, {
      taskStore,
      publishEvent,
      createTenantAgent: async () => (await createTenantAgent()) as never,
    }),
    // P3 §13.1：goal-status 只读投影；同一实例的读接口还用于发 task.goal.evaluation.available 事件。
    goalStatus: goalStatusService,
    readGoalEvaluation: async (params) => goalStatusService.readGoalEvaluation(params.taskId, params.runId),
  })) return;

  // A2A 标准发现路径 — /.well-known/agent-card.json
  // A2A 规范要求 Agent Card 在此路径暴露，SDK 的 ClientFactory.createFromUrl 默认查找此路径
  // — Chinese: A2A standard discovery path required by the spec
  if (req.method === 'GET' && url.pathname === '/.well-known/agent-card.json') {
    const a2aHandler = a2aRegistry.handler(tenantContext, req);
    sendJson(res, 200, a2aHandler.agentCard);
    return;
  }

  // A2A (Agent2Agent) JSON-RPC 路由 — Chinese: A2A JSON-RPC route
  // Agent Card 始终可访问（用于发现），JSON-RPC 调用需要启用配置
  if (segments[0] === 'api' && segments[1] === 'a2a') {
    const a2aHandler = a2aRegistry.handler(tenantContext, req);
    const isCardRequest = req.method === 'GET' && segments[2] === 'card';
    const a2aConfig = normalizeA2AConfig(await store.getSetting(A2A_CONFIG_KEY));
    if (!isCardRequest && !a2aConfig.enabled) {
      sendError(res, 403, 'A2A Server is disabled. Enable it in Settings → A2A Protocol.');
      return;
    }
    if (await handleA2ARoute({ req, res, url, segments, handler: a2aHandler })) return;
  }

  if (await handleSettingsRoute({ req, res, pathname: url.pathname, store, getDefaultRunConfig, saveDefaultRunConfig: saveTenantDefaultRunConfig, saveGlobalAccessPolicy, resetDefaultAgent: resetTenantDefaultAgent })) return;
  if (await handleMemoryRoute({ req, res, url, pathname: url.pathname, store, getDefaultRunConfig, saveDefaultRunConfig: saveTenantDefaultRunConfig })) return;

  if (req.method === 'POST' && url.pathname === '/api/workspaces/pick') return handlePickWorkspaceDirectory(res);

  if (req.method === 'POST' && url.pathname === '/api/mcp/draft') {
    const body = await readJson<{ description?: unknown }>(req);
    const description = typeof body.description === 'string' ? body.description : '';
    return sendJson(res, 200, await prepareMcpDraftRequest(description));
  }

  if (req.method === 'GET' && url.pathname === '/api/mcp') {
    sendJson(res, 200, { servers: await listMcpServers() });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/mcp/status') {
    const detail = url.searchParams.get('detail');
    await tenantMcpManager.configure(await listMcpServers(), { startEnabled: detail === 'full' });
    sendJson(res, 200, { servers: tenantMcpManager.statuses() });
    return;
  }

  if (req.method === 'PATCH' && url.pathname === '/api/mcp') {
    const body = await readJson<{ servers?: unknown }>(req);
    const servers = await saveMcpServers(body.servers ?? []);
    resetTenantDefaultAgent();
    await tenantMcpManager.configure(servers, { startEnabled: false });
    sendJson(res, 200, { ok: true, servers, statuses: tenantMcpManager.statuses() });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/skills') {
    const config = await getDefaultRunConfig();
    const forceReload = url.searchParams.get('forceReload') === '1';
    const skills = await tenantRuntime.skillCacheForTenant(tenantContext).loadFromDirectory(
      config.skillsRoot,
      { forceReload },
    );
    if (forceReload) {
      resetTenantDefaultAgent();
    }
    sendJson(res, 200, { skillsRoot: config.skillsRoot, skills: skills.list() });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/skills/draft') {
    const body = await readJson<{ description?: string; config?: Partial<AgentRunConfig> }>(req);
    const description = body.description?.trim();
    if (!description) { sendError(res, 400, 'Skill description is required'); return; }
    sendJson(res, 200, await skillDraftService.draft(description, body.config, tenantContext));
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/skills/install') {
    const body = await readJson<{ url?: string; urls?: string[]; config?: Partial<AgentRunConfig> }>(req);
    const skillUrls = skillInstallUrlsFromBody(body);
    if (skillUrls.length === 0) { sendError(res, 400, 'Skill URL is required'); return; }
    try {
      const config = resolveConfig({ ...await getDefaultRunConfig(), ...(body.config ?? {}) });
      const result = await installSkillsFromGitHubUrls(config.skillsRoot, skillUrls);
      tenantRuntime.skillCacheForTenant(tenantContext).clear(config.skillsRoot);
      resetTenantDefaultAgent();
      sendJson(res, 200, { ok: true, ...result });
    } catch (error) {
      sendError(res, 400, error instanceof Error ? error.message : String(error));
    }
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/skills') {
    const body = await readJson<Partial<SkillDraft>>(req);
    if (!body.name?.trim() || !body.body?.trim()) {
      sendError(res, 400, 'Skill name and body are required');
      return;
    }
    const config = await getDefaultRunConfig();
    const saved = await writeSkillDraft(config.skillsRoot, {
      name: body.name,
      description: body.description ?? body.name,
      body: body.body,
    });
    tenantRuntime.skillCacheForTenant(tenantContext).clear(config.skillsRoot);
    resetTenantDefaultAgent();
    sendJson(res, 200, { ok: true, skill: saved });
    return;
  }

  if (req.method === 'DELETE' && segments[0] === 'api' && segments[1] === 'skills' && segments[2]) {
    try {
      const config = await getDefaultRunConfig();
      const removed = await deleteSkill(config.skillsRoot, decodeURIComponent(segments[2]));
      tenantRuntime.skillCacheForTenant(tenantContext).clear(config.skillsRoot);
      resetTenantDefaultAgent();
      sendJson(res, 200, { ok: true, skill: removed });
    } catch (error) {
      sendError(res, 400, error instanceof Error ? error.message : String(error));
    }
    return;
  }

  if (await handleModelCatalogRoute({
    req, res, pathname: url.pathname, segments, repo: configRepo, store,
    saveDefault: saveTenantDefaultRunConfig,
  })) return;
  if (await handleProviderModelsRoute(req, res, tenantRuntime, tenantContext)) return;
  if (await handleModelCapabilitiesRoute(req, res, tenantRuntime, tenantContext)) return;

  if (await handleKeysRoute(req, res, segments, url.pathname)) return;

  if (req.method === 'POST' && url.pathname === '/api/health') {
    const body = await readJson<{ config?: Partial<AgentRunConfig> }>(req);
    const { model } = await createTenantAgent(body.config);
    sendJson(res, 200, await model.healthCheck());
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/threads') {
    sendJson(res, 200, { threads: await store.listThreads() });
    return;
  }

  if (await handleWorkflowRoute({
    req,
    res,
    segments,
    store,
    createPlannerModel: async () => (await createTenantAgent()).model,
  })) return;

  if (await handleRunMonitorRoute({
    req,
    res,
    url,
    segments,
    store,
    tenantContext,
    activeRunRegistry: tenantRuntime.activeRunRegistry,
    onControlRun: (action, request) => handleRunControlAction(action, request, getTenantDefaultAgent),
  })) return;

  if (req.method === 'GET' && url.pathname === '/api/approvals') {
    sendJson(res, 200, { approvals: approvalBroker.listPending(), history: approvalBroker.listHistory() });
    return;
  }

  if (req.method === 'POST' && segments[0] === 'api' && segments[1] === 'approvals' && segments[2]) {
    const body = await readJson<{
      approved?: boolean;
      reason?: string;
      temporaryScope?: 'tool_call' | 'turn' | 'session';
      persistentScope?: PersistentAccessScope;
    }>(req);
    const temporaryScope = body.temporaryScope === 'turn' || body.temporaryScope === 'session' || body.temporaryScope === 'tool_call'
      ? body.temporaryScope
      : undefined;
    const persistentScope = body.persistentScope === 'thread' || body.persistentScope === 'workspace' || body.persistentScope === 'global'
      ? body.persistentScope
      : undefined;
    const approval = approvalBroker.getPending(segments[2]);
    if (!approval) { sendError(res, 404, 'Approval request not found'); return; }
    if (body.approved === true && persistentScope) {
      const accessRequest = approval.accessRequest;
      if (!accessRequest) {
        sendError(res, 400, 'This approval cannot be persisted as an access rule');
        return;
      }
      if (persistentScope === 'workspace' && !accessRequest.workspaceRoot?.trim()) {
        sendError(res, 400, 'This approval is not bound to a workspace');
        return;
      }
      const rule = persistentRuleFromApproval(accessRequest, persistentScope);
      if (persistentScope === 'thread') {
        const current = await getThreadAccessPolicy(accessRequest.threadId);
        const base = current ?? {
          mode: (await getThreadRunConfig(accessRequest.threadId)).accessPolicy.mode,
          workspaceRoot: accessRequest.workspaceRoot ?? '',
          persistentRules: [],
          temporaryGrants: [],
        };
        await saveThreadAccessPolicy(accessRequest.threadId, appendPersistentRule(base, rule));
      } else {
        const current = await getGlobalAccessPolicy();
        await saveGlobalAccessPolicy(appendPersistentRule(current, rule));
        resetTenantDefaultAgent();
      }
    }
    const ok = approvalBroker.decideWithScope(segments[2], body.approved === true, body.reason, temporaryScope, persistentScope);
    if (!ok) { sendError(res, 404, 'Approval request not found'); return; }
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/threads') {
    const body = await readJson<{ title?: string; config?: Partial<AgentRunConfig>; conversationKind?: 'chat' | 'project'; workflowProject?: boolean; mode?: 'chat' | 'ops'; taskPreset?: 'ops' | null }>(req);
    const conversationKind = body.conversationKind === 'chat' ? 'chat' : 'project';
    const effectiveConfig = body.config
      ? resolveConfig({ ...await getDefaultRunConfig(), ...body.config })
      : await getDefaultRunConfig();
    if (conversationKind === 'chat') {
      effectiveConfig.hasWorkspace = false;
      effectiveConfig.workspaceRoot = hiddenChatWorkspaceRoot(effectiveConfig.dataDir);
    }
    const agent = body.config ? (await createTenantAgent(effectiveConfig)).agent : await getTenantDefaultAgent();
    const thread = await agent.startThread(body.title ?? 'Suanlizi', {
      hasWorkspace: conversationKind === 'chat' ? false : effectiveConfig.hasWorkspace,
      workspaceRoot: conversationKind === 'chat' ? '' : effectiveConfig.workspaceRoot,
      tags: conversationKind === 'chat' ? { conversationKind: 'chat' } : body.workflowProject ? { workflowProject: 'true' } : {},
    });
    const threadConfigPatch: Partial<AgentRunConfig> = body.config ? { ...body.config } : {};
    threadConfigPatch.hasWorkspace = conversationKind === 'chat' ? false : effectiveConfig.hasWorkspace;
    if (conversationKind === 'chat') threadConfigPatch.workspaceRoot = '';
    const config = await saveThreadRunConfig(thread.threadId, threadConfigPatch);
    if (body.mode || body.taskPreset !== undefined) {
      await store.updateThreadMetadata(thread.threadId, {
        ...(body.mode ? { mode: body.mode } : {}),
        ...(body.taskPreset !== undefined ? { taskPreset: body.taskPreset } : {}),
      });
    }
    sendJson(res, 200, { thread: await store.getThread(thread.threadId), config: publicThreadRunConfig(config, await store.getThread(thread.threadId)) });
    return;
  }

  if (await handleThreadRoutes(req, res, url, segments, { store, tenantContext, taskStore, createTenantAgent, getTenantDefaultAgent, publishTenantEvent, getThreadRunConfig, saveThreadRunConfig, getThreadConfigOverrides, updateThreadConfigOverrides, getThreadAccessPolicy, saveThreadAccessPolicy, publicThreadRunConfig, closeThreadEventClients, activeRunRegistry: tenantRuntime.activeRunRegistry })) return;

  if (req.method === 'GET' && segments[0] === 'api' && segments[1] === 'events' && segments[2]) {
    const threadId = segments[2];
    const headerCursor = req.headers['last-event-id'];
    const rawHeaderCursor = Array.isArray(headerCursor) ? headerCursor[0] : headerCursor;
    const rawCursor = url.searchParams.get('afterSequence') ?? url.searchParams.get('after') ?? rawHeaderCursor;
    const explicitCursor = rawCursor !== undefined && rawCursor !== null && rawCursor.trim() !== '';
    const parsedCursor = explicitCursor ? Number(rawCursor) : undefined;
    const replay = explicitCursor
      ? threadEventHistory.replayAfter(tenantContext.tenantId, threadId, Number.isSafeInteger(parsedCursor) && parsedCursor! >= 0 ? parsedCursor! : 0)
      : { events: [], oldestSequence: null, latestSequence: 0, truncated: false };
    const afterSequence = parsedCursor ?? replay.latestSequence;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    const eventKey = tenantEventKey(tenantContext.tenantId, threadId);
    const clients = eventClients.get(eventKey) ?? new Set<ServerResponse>();
    clients.add(res);
    eventClients.set(eventKey, clients);
    if (replay.truncated) {
      res.write(`event: thread.replay.gap\ndata: ${JSON.stringify({
        type: 'thread.replay.gap',
        threadId,
        afterSequence,
        oldestSequence: replay.oldestSequence,
        latestSequence: replay.latestSequence,
        isReplay: true,
      })}\n\n`);
    }
    res.write('data: {"type":"connected","isReplay":false}\n\n');
    for (const entry of replay.events) {
      res.write(`id: ${entry.sequence}\ndata: ${JSON.stringify({ ...entry.event, sequence: entry.sequence, isReplay: true })}\n\n`);
    }
    req.on('close', () => {
      clients.delete(res);
      if (clients.size === 0) eventClients.delete(eventKey);
    });
    return;
  }

  if (req.method === 'POST' && segments[0] === 'api' && segments[1] === 'threads' && segments[2]) {
    const threadId = segments[2];
    const action = segments[3];

    if (action === 'skills' && segments[4] === 'install') {
      // 安装 Skill 的 turn 生命周期已下沉到 ./routes/threadSkillInstall.ts。
      await handleThreadSkillInstall({
        req,
        res,
        threadId,
        tenantId: tenantContext.tenantId,
        store,
        getRunConfig: getThreadRunConfig,
        saveRunConfig: saveThreadRunConfig,
        createModel: async (config) => (await tenantRuntime.createAgent(config, tenantContext)).model,
        resetDefaultAgent: resetTenantDefaultAgent,
        publishEvent: publishTenantEvent,
        publishCompletedItems,
      });
      return;
    }

    if (action === 'turn') {
      const body = await readJson<TurnRequest>(req, { maxBytes: 30 * 1024 * 1024 });
      const config = body.config
        ? await saveThreadRunConfig(threadId, body.config)
        : await getThreadRunConfig(threadId);
      const topLevelReservation = `turn:${threadId}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
      const maxActiveTasks = config.maxActiveTasks ?? 4;
      if (!tenantRuntime.activeRunRegistry.tryReserveTopLevel(topLevelReservation, maxActiveTasks)) {
        sendJson(res, 429, {
          error: {
            code: 'MAX_ACTIVE_TASKS_REACHED',
            message: `Maximum active top-level tasks reached (${maxActiveTasks}).`,
          },
        });
        return;
      }
      try {
        const thread = await store.getThread(threadId);
        const nextTitle = titleFromInput(body.input);
        if (thread && nextTitle && shouldRetitleThread(thread.title)) {
          await store.updateThreadMetadata(threadId, { title: nextTitle });
          publishEvent({
            type: 'thread.metadata.updated',
            threadId,
            title: nextTitle,
          }, tenantContext.tenantId);
        }
        const agent = (await createTenantAgent(config)).agent;
        const runtimeState = await agent.getRuntimeState(threadId);
        if (runtimeState.executionStatus === 'running' || runtimeState.executionStatus === 'stopping' || runtimeState.executionStatus === 'waiting_user_input') {
          sendError(res, 409, `Thread ${threadId} is ${runtimeState.executionStatus}`);
          return;
        }
        let input: UserInput;
        try {
          input = await buildUserInputFromTurnRequest(body, {
            threadId,
            workspaceRoot: config.workspaceRoot,
            dataDir: config.dataDir,
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          sendError(res, message.includes('must not exceed') ? 413 : 400, message);
          return;
        }
        try {
          const result = await agent.runTurn(threadId, input);
          sendJson(res, 200, result);
        } catch (error) {
          // Return the persisted transcript along with the failure. The
          // runtime writes a terminal error item before rejecting, and the
          // client can render it without racing a follow-up snapshot read.
          const items = await store.getItems(threadId).catch(() => [] as ThreadItem[]);
          sendJson(res, 500, {
            error: error instanceof Error ? error.message : String(error),
            items,
          });
        }
      } finally {
        tenantRuntime.activeRunRegistry.releaseTopLevel(topLevelReservation);
      }
      return;
    }

    if (action === 'interrupt') {
      const body = await readJson<{ config?: Partial<AgentRunConfig> }>(req);
      const config = body.config ? await saveThreadRunConfig(threadId, body.config) : await getThreadRunConfig(threadId);
      const agent = (await createTenantAgent(config)).agent;
      const activeHandle = tenantRuntime.activeRunRegistry.getByThreadId(threadId);
      const interrupted = activeHandle
        ? (await activeHandle.interrupt(), true)
        : agent.interrupt(threadId);
      const state = await agent.getRuntimeState(threadId);
      sendJson(res, 200, {
        interrupted,
        accepted: interrupted,
        status: state.executionStatus ?? (interrupted ? 'stopping' : 'terminal'),
        turnId: state.checkpoint?.turnId ?? null,
      });
      return;
    }

    if (action === 'resume-running') {
      const body = await readJson<{ input?: string; config?: Partial<AgentRunConfig> }>(req);
      const config = body.config ? await saveThreadRunConfig(threadId, body.config) : await getThreadRunConfig(threadId);
      const agent = (await createTenantAgent(config)).agent;
      const input: UserInput | undefined =
        body.input && body.input.trim() ? { type: 'text', text: body.input } : undefined;
      // P2 取消链（计划 §9.2 / 盘点 §4.1）：resume-running 自己发起的续跑也必须可取消。
      // 之前这一段没有 AbortSignal（也没有 activeRunRegistry 条目），/interrupt 只能写
      // stopping checkpoint，模型流与工具/子代理执行层不会中断。这里按 activeRunRegistry
      // 现有形状登记一个可取消条目：interrupt = agent.interrupt + abort 双写，结束后收口。
      // — English: register a cancellable AbortSignal for the resumed run and always release it.
      const resumeController = new AbortController();
      const resumeTurnId = (await agent.getRuntimeState(threadId)).checkpoint?.turnId ?? '';
      const releaseResumeRun = tenantRuntime.activeRunRegistry.register({
        runId: `resume_${threadId}_${Date.now()}`,
        threadId,
        turnId: resumeTurnId,
        interrupt: () => {
          agent.interrupt(threadId);
          resumeController.abort();
        },
      });
      try {
        const result = await agent.resumeRunning(threadId, input, resumeController.signal);
        sendJson(res, 200, result);
      } finally {
        releaseResumeRun();
      }
      return;
    }

    if (action === 'resume-tree') {
      const body = await readJson<{ config?: Partial<AgentRunConfig> }>(req);
      const config = body.config ? await saveThreadRunConfig(threadId, body.config) : await getThreadRunConfig(threadId);
      const agent = (await createTenantAgent(config)).agent;
      sendJson(res, 200, await agent.resumeTree(threadId));
      return;
    }

    if (action === 'compact') {
      await handleCompactThread({
        req,
        res,
        threadId,
        store,
        getThreadRunConfig,
        saveThreadRunConfig,
        createModel: async (config) => (await createTenantAgent(config)).model,
        publishEvent: publishTenantEvent,
        generateId: generateServerId,
      });
      return;
    }

    if (action === 'fork') {
      const body = await readJson<{ config?: Partial<AgentRunConfig> }>(req);
      const config = resolveConfig(body.config);
      sendJson(res, 200, { thread: await forkThread(threadId, store, config.workspaceRoot) });
      return;
    }

    if (action === 'rollback') {
      const config = await getThreadRunConfig(threadId);
      await handleRollbackThreadRuntimeAction({
        req,
        res,
        threadId,
        createAgent: async () => (await createTenantAgent(config)).agent,
      });
      return;
    }
  }

  sendError(res, 404, 'Not found');
}

const port = Number(process.env.SUANLIZI_API_PORT ?? 4127);
const server = createServer((req, res) => {
  route(req, res).catch((error) => {
    sendError(
      res,
      error instanceof RequestBodyTooLargeError ? error.statusCode : 500,
      error instanceof Error ? error.message : String(error),
    );
  });
});

async function listenAfterModelCatalogMigration(): Promise<void> {
  const repo = tenantRuntime.configRepoForTenant({ tenantId: DEFAULT_TENANT_ID });
  try {
    await pruneOrphanCustomProviders({
      listPresets: () => repo.listModelPresets(),
      listProviders: listAllProviders,
      removeProvider: removeCustomProvider,
      onRemoved: (providerId, remaining) => reconcileRemovedModelSelection({
        repo,
        store: rootStore,
        removed: { providerId },
        remaining,
        saveDefault: (patch) => tenantRuntime.saveDefaultRunConfig(patch, { tenantId: DEFAULT_TENANT_ID }),
      }),
    });
  } catch (error) {
    console.warn('[models] 孤儿厂商清理失败：', error instanceof Error ? error.message : String(error));
  }
  server.listen(port, () => {
  console.log(`Suanlizi API listening on http://localhost:${port}`);
  const defaultTenantStore = tenantRuntime.storeForTenant({ tenantId: DEFAULT_TENANT_ID });
  const defaultCfgRepo = tenantRuntime.configRepoForTenant({ tenantId: DEFAULT_TENANT_ID });
  void autoStartDingtalkForTenant({
    store: defaultTenantStore,
    tenantId: DEFAULT_TENANT_ID,
    getDefaultRunConfig: () => defaultCfgRepo.getDefaultRunConfig(),
    createAgent: async (config) => ({ agent: (await tenantRuntime.createAgent(config ?? {}, { tenantId: DEFAULT_TENANT_ID })).agent }),
    publishEvent: (event) => publishEvent(event, DEFAULT_TENANT_ID),
  }).catch((err) => {
    console.warn('[dingtalk] default tenant auto-start failed:', err instanceof Error ? err.message : String(err));
  });
  void recoverOpsTasks({
    store: defaultTenantStore,
    tenantId: DEFAULT_TENANT_ID,
    getAgent: async () => tenantRuntime.getDefaultAgent({ tenantId: DEFAULT_TENANT_ID }),
  }).catch((err) => {
    console.warn('[ops] task recovery failed:', err instanceof Error ? err.message : String(err));
  });
  // 启动扫描非终态 TaskRun（计划 §11.2，与 recoverOpsTasks 并列）；恢复真相只在 Agent Checkpoint。
  // P5：被改写的 workflow run 同步把 WorkflowRunRecord 标记 interrupted（脚本运行状态只在进程内）。
  startTaskRunRecovery({
    taskStore,
    isLive: (run) => Boolean(run.harnessRunId && harnessRuntimeRegistry.get(run.harnessRunId)?.runtimeStatus === 'running'),
    onRecovered: (rewritten) => {
      const workflowRunIds = rewritten
        .filter((run) => run.kind === 'workflow' && run.workflowRunId)
        .map((run) => run.workflowRunId as string);
      if (workflowRunIds.length === 0) return;
      void workflowScriptServiceForTenant({ tenantId: DEFAULT_TENANT_ID }, {
        taskStore,
        publishEvent,
        createTenantAgent: async () => {
          const { agent } = await tenantRuntime.createAgent({}, { tenantId: DEFAULT_TENANT_ID });
          return { agent: agent as never };
        },
      })
        .markWorkflowRunsInterrupted(workflowRunIds)
        .catch(() => undefined);
    },
  });
  // §14.6 切换期：以 thread.tags 为摘要源对 task 表做幂等对账（只写 task 表，类型面上无法改 tags）。
  // 与恢复扫描并列、不阻塞端口就绪；重复执行结果一致（已领先的任务会被 skip）。
  void reconcileTasksFromTags({
    threadStore: defaultTenantStore,
    taskStore,
    listThreads: async () => defaultTenantStore.listThreads(),
    logger: { warn: (message) => console.warn(message), info: (message) => console.log(message) },
    isLive: ({ harnessRunId }) => harnessRuntimeRegistry.get(harnessRunId)?.runtimeStatus === 'running',
  })
    .then((report) => {
      if (report.created + report.updated > 0) {
        console.log(`[tasks] tag→task 对账完成：补建 ${report.created}、修正 ${report.updated}、冲突 ${report.conflicts}`);
      }
    })
    .catch((error) => {
      console.warn('[tasks] tag→task 对账失败：', error instanceof Error ? error.message : String(error));
    });

  // 重启对账：进程被强杀/崩溃会留下 running checkpoint，而内存态是 idle，
  // /state 会用 checkpoint 回推成 running，导致 UI 永远卡在“进行中”。
  // 启动时把所有非本进程活跃的 running/stopping checkpoint 收敛为 interrupted。
  void reconcileThreadRuntimeOnStartup({
    threadStore: defaultTenantStore,
    // 刚启动时没有任何进程内运行句柄，register 过的一定是活着的。
    isThreadLive: (threadId) => tenantRuntime.activeRunRegistry.getByThreadId(threadId) !== null,
    log: (message) => console.log(message),
    warn: (message) => console.warn(message),
  }).catch((error) => {
    console.warn('[runtime] 启动运行态对账失败：', error instanceof Error ? error.message : String(error));
  });
  });
}
void listenAfterModelCatalogMigration();

installGracefulShutdown({
  server,
  store: rootStore,
  // 进程退出时取消对话运行并终止 MCP/任务子进程。
  onShutdown: () => {
    harnessRuntimeRegistry.abortAll();
    for (const runId of tenantRuntime.activeRunRegistry.listActiveRunIds()) {
      void tenantRuntime.activeRunRegistry.get(runId)?.interrupt();
    }
    void tenantRuntime.mcpManagerForTenant({ tenantId: DEFAULT_TENANT_ID }).shutdown();
    terminateAllProcessTrees(activeAgentProcesses);
    activeAgentProcesses.length = 0;
  },
});

process.on('exit', () => {
  terminateAllProcessTrees(activeAgentProcesses);
});
