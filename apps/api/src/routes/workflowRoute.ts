import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ThreadId, ThreadItem, ThreadMeta, TurnMeta } from '@suanlizi/protocol';
import type { RunEvent, RunRecord, ThreadStore } from '@suanlizi/storage';
import {
  compileWorkflowBlueprint,
  createDefaultWorkflowComponentRegistry,
  createBuiltinWorkflowComponentRegistry,
  createWorkflowRegistryWithUserComponents,
  createWorkflowDefinitionFromGoal,
  createWorkflowRunFromDefinition,
  normalizeUserWorkflowComponent,
  normalizeWorkflowSnapshot,
  planWorkflowDefinitionFromGoal,
  publishWorkflowSnapshot,
  resumeWorkflowRun,
  retryWorkflowNode,
  runNextWorkflowNodes,
  runWorkflowNode,
  updateWorkflowNodeContract,
  type WorkflowApprovalMode,
  type WorkflowComponentDefinition,
  type WorkflowComponentRegistry,
  type WorkflowDefinition,
  type WorkflowEvent,
  type WorkflowPlannerModel,
  type WorkflowRuntimeAction,
  type WorkflowSnapshot,
  type WorkflowNodeExecutors,
} from '@suanlizi/runtime';
import { readJson, sendError, sendJson } from '../shared/http.js';

// 线程工作流标签（用于 thread.tags 中识别工作流）和存储键
// — Chinese: thread workflow tag and persistence key
export const THREAD_WORKFLOW_TAG = 'workflow';
export const WORKFLOW_COMPONENTS_KEY = 'workflow.components.v1';

// 从存储加载用户自定义工作流组件注册表（以默认内建注册表为基底）
// — Chinese: load user workflow component registry from storage (default builtin base)
export async function loadWorkflowComponentRegistry(
  store: ThreadStore,
  base: WorkflowComponentRegistry = createBuiltinWorkflowComponentRegistry(),
): Promise<WorkflowComponentRegistry> {
  const stored = await store.getSetting?.<{ components?: unknown[] }>(WORKFLOW_COMPONENTS_KEY).catch(() => null) ?? null;
  const components = Array.isArray(stored?.components) ? stored.components.filter(isWorkflowComponentDefinition) : [];
  return createWorkflowRegistryWithUserComponents(components, base);
}

// 基于目标生成工作流草案快照（definition + run）
// — Chinese: build workflow draft snapshot from goal (definition + run)
export function createThreadWorkflowSnapshot(
  goal: string,
  registry: WorkflowComponentRegistry = createDefaultWorkflowComponentRegistry(),
  now = new Date(),
): WorkflowSnapshot {
  const definition = createWorkflowDefinitionFromGoal(goal, registry, now);
  return {
    definition,
    run: createWorkflowRunFromDefinition(definition, now, registry),
  };
}

// 从线程标签中读取工作流快照（若无或解析失败返回 null）
// — Chinese: read workflow snapshot from thread tags (null if missing or invalid)
export function readThreadWorkflowSnapshot(
  thread: ThreadMeta,
  registry: WorkflowComponentRegistry = createDefaultWorkflowComponentRegistry(),
): WorkflowSnapshot | null {
  const raw = thread.tags?.[THREAD_WORKFLOW_TAG];
  if (!raw) return null;
  try {
    return normalizeWorkflowSnapshot(JSON.parse(raw) as WorkflowSnapshot, registry);
  } catch {
    return null;
  }
}

// 从线程 items 中查找最近的 workflow_checkpoint 并解析为快照
// — Chinese: find the latest workflow_checkpoint in thread items and parse as snapshot
export function readWorkflowCheckpointSnapshot(
  items: ThreadItem[],
  registry: WorkflowComponentRegistry = createDefaultWorkflowComponentRegistry(),
): WorkflowSnapshot | null {
  for (const item of [...items].reverse()) {
    if (item?.type !== 'workflow_checkpoint') continue;
    const workflow = (item as ThreadItem & { workflow?: unknown }).workflow;
    if (!workflow) continue;
    try {
      return normalizeWorkflowSnapshot(workflow as WorkflowSnapshot, registry);
    } catch {
      continue;
    }
  }
  return null;
}

// 先尝试读取线程标签快照，若缺失则从 items 中查找 checkpoint
// — Chinese: first try tag snapshot, then try checkpoint items if missing
export async function readPersistedThreadWorkflowSnapshot(
  store: ThreadStore,
  thread: ThreadMeta,
  registry: WorkflowComponentRegistry = createDefaultWorkflowComponentRegistry(),
): Promise<WorkflowSnapshot | null> {
  const tagged = readThreadWorkflowSnapshot(thread, registry);
  if (tagged) return tagged;
  const items = await store.getItems(thread.threadId).catch(() => [] as ThreadItem[]);
  return readWorkflowCheckpointSnapshot(items, registry);
}

// 保存工作流快照到线程：更新 tags 并追加 checkpoint item
// — Chinese: save workflow snapshot to thread: update tags + append checkpoint item
export async function saveThreadWorkflowSnapshot(
  store: ThreadStore,
  threadId: ThreadId,
  snapshot: WorkflowSnapshot,
  registry: WorkflowComponentRegistry = createDefaultWorkflowComponentRegistry(),
): Promise<ThreadMeta | null> {
  const thread = await store.getThread(threadId);
  if (!thread) return null;
  const normalized = normalizeWorkflowSnapshot(snapshot, registry);
  const tags = {
    ...(thread.tags ?? {}),
    [THREAD_WORKFLOW_TAG]: JSON.stringify(normalized),
  };
  await store.updateThreadMetadata(threadId, { tags });
  await store.appendItems(threadId, [await createWorkflowCheckpointItem(store, threadId, normalized)]);
  return store.getThread(threadId);
}

// 校验工作流蓝图（有 error 级诊断则抛出异常）
// — Chinese: validate workflow blueprint (throws on error-level diagnostics)
function validateWorkflowBlueprintOrThrow(
  snapshot: WorkflowSnapshot,
  registry: WorkflowComponentRegistry,
): ReturnType<typeof compileWorkflowBlueprint> {
  const blueprint = compileWorkflowBlueprint(snapshot.definition, registry);
  if (!blueprint.ok) {
    const errors = blueprint.diagnostics.filter((item) => item.severity === 'error').map((item) => item.message);
    throw new Error(`Workflow blueprint has blocking diagnostics: ${errors.join('; ') || 'unknown error'}`);
  }
  return blueprint;
}

// 将工作流草案以普通对话的形式写入线程（新增 turn + 两个 item，便于用户快速看到草案）
// — Chinese: append workflow draft as a conversational turn (user message + agent message summary)
export async function appendWorkflowDraftTranscript(
  store: ThreadStore,
  threadId: ThreadId,
  goal: string,
  snapshot: WorkflowSnapshot,
  now = new Date(),
  registry: WorkflowComponentRegistry = createDefaultWorkflowComponentRegistry(),
): Promise<ThreadItem[]> {
  const thread = await store.getThread(threadId);
  if (!thread) throw new Error('Thread not found');
  const turnCount = thread.turnCount + 1;
  const turnId = `workflow_draft_${now.getTime()}_${Math.random().toString(36).slice(2, 8)}`;
  const startedAt = now.toISOString();
  await store.saveTurn({
    turnId,
    threadId,
    index: turnCount - 1,
    userInput: { type: 'text', text: goal },
    status: 'completed',
    startedAt,
    completedAt: startedAt,
  });
  const items = createWorkflowDraftTranscriptItems(turnId, goal, snapshot, compileWorkflowBlueprint(snapshot.definition, registry), startedAt);
  await store.appendItems(threadId, items);
  await store.updateThreadMetadata(threadId, { turnCount, updatedAt: startedAt });
  return items;
}

// 生成 workflow_checkpoint 类型的线程 item
// — Chinese: generate thread item for workflow_checkpoint
async function createWorkflowCheckpointItem(
  store: ThreadStore,
  threadId: ThreadId,
  workflow: WorkflowSnapshot,
): Promise<ThreadItem> {
  const turns = await store.getTurns(threadId).catch(() => [] as TurnMeta[]);
  const latestTurn = turns.at(-1);
  const turnCount = turns.length;
  return {
    id: `workflow_checkpoint_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    type: 'workflow_checkpoint',
    turnId: latestTurn?.turnId ?? `workflow_${threadId}_${turnCount}`,
    turnCount,
    workflow,
    timestamp: new Date().toISOString(),
  };
}

// 更新工作流中某一节点的契约（标题/提示/输入输出/依赖等）
// — Chinese: update node contract (title/prompt/inputs/outputs/deps) in a workflow
export async function updateThreadWorkflowNode(
  store: ThreadStore,
  threadId: ThreadId,
  nodeId: string,
  patch: WorkflowNodePatch,
  registry: WorkflowComponentRegistry = createDefaultWorkflowComponentRegistry(),
  now = new Date(),
): Promise<ThreadMeta | null> {
  const thread = await store.getThread(threadId);
  if (!thread) return null;
  const snapshot = await readPersistedThreadWorkflowSnapshot(store, thread, registry);
  if (!snapshot) throw new Error('Workflow snapshot not found');
  const definition = updateWorkflowNodeContract(snapshot.definition, nodeId, patch, registry, now);
  return saveThreadWorkflowSnapshot(store, threadId, { definition, run: snapshot.run }, registry);
}

// 以安全方式运行工作流规划（超时或失败则回退到默认规则）
// — Chinese: safely run workflow planning (fallback to defaults on timeout/error)
export async function planWorkflowDefinitionSafely(
  goal: string,
  registry: WorkflowComponentRegistry = createBuiltinWorkflowComponentRegistry(),
  model?: WorkflowPlannerModel,
  now = new Date(),
  timeoutMs = 15_000,
): Promise<{ definition: WorkflowDefinition; warning?: string }> {
  try {
    return { definition: await withPlannerTimeout(planWorkflowDefinitionFromGoal(goal, registry, model, now), timeoutMs) };
  } catch (error) {
    const warning = error instanceof Error ? error.message : String(error);
    const definition = createWorkflowDefinitionFromGoal(goal, registry, now);
    return { definition, warning };
  }
}

// 线程级工作流运行时请求类型 — Chinese: thread workflow runtime request types
export type ThreadWorkflowRuntimeRequest =
  | { action: 'run'; input?: Record<string, unknown> }
  | { action: 'run_node'; nodeId: string; input?: Record<string, unknown> }
  | { action: 'test_run'; input?: Record<string, unknown> }
  | { action: 'publish'; changelog?: string }
  | { action: 'resume'; input?: Record<string, unknown> }
  | { action: 'cancel' }
  | { action: 'retry_node'; nodeId: string };

// 线程级工作流运行时响应类型 — Chinese: thread workflow runtime response types
export interface ThreadWorkflowRuntimeResponse {
  ok: boolean;
  code?: string;
  error?: string;
  thread?: ThreadMeta | null;
  workflow?: WorkflowSnapshot;
  run?: WorkflowSnapshot['run'];
  events?: WorkflowEvent[];
  blueprint?: ReturnType<typeof compileWorkflowBlueprint> | null;
}

// 执行线程级工作流运行时动作（publish/run/test_run/cancel/resume/run_node/retry_node 等）
// — Chinese: execute thread workflow runtime actions (publish/run/test_run/cancel/resume/run_node/retry_node)
export async function runThreadWorkflowRuntimeAction(
  store: ThreadStore,
  threadId: ThreadId,
  request: ThreadWorkflowRuntimeRequest,
  registry: WorkflowComponentRegistry = createBuiltinWorkflowComponentRegistry(),
  now = new Date(),
  executors?: WorkflowNodeExecutors,
): Promise<ThreadWorkflowRuntimeResponse> {
  const thread = await store.getThread(threadId);
  if (!thread) return { ok: false, code: 'ThreadNotFound', error: 'Thread not found' };
  const snapshot = await readPersistedThreadWorkflowSnapshot(store, thread, registry);
  if (!snapshot) return { ok: false, code: 'WorkflowNotFound', error: 'Workflow snapshot not found' };
  // publish：在运行前发布当前定义
  // — Chinese: publish: snapshot current definition as published version
  if (request.action === 'publish') {
    try {
      const workflow = publishWorkflowSnapshot(snapshot, registry, now, request.changelog);
      const saved = await saveThreadWorkflowSnapshot(store, threadId, workflow, registry);
      const event: WorkflowEvent = {
        type: 'workflow.updated',
        workflowId: workflow.definition.id,
        runId: workflow.run.id,
        timestamp: now.toISOString(),
        detail: 'Workflow published',
      };
      await persistWorkflowRunAudit(store, thread, workflow, request.action, [event], now);
      return { ok: true, thread: saved, workflow, run: workflow.run, events: [event], blueprint: compileWorkflowBlueprint(workflow.definition, registry) };
    } catch (error) {
      return { ok: false, code: 'WorkflowPublishFailed', error: error instanceof Error ? error.message : String(error), workflow: snapshot, run: snapshot.run, events: [] };
    }
  }
  const executionDefinition = request.action === 'run'
    ? snapshot.publishedDefinition
    : snapshot.definition;
  // 正式 run 必须已有发布的定义
  // — Chinese: formal run requires already-published definition
  if (request.action === 'run' && !executionDefinition) {
    return { ok: false, code: 'WorkflowNotPublished', error: 'Workflow must be published before a formal run', workflow: snapshot, run: snapshot.run, events: [] };
  }
  const blueprint = compileWorkflowBlueprint(executionDefinition ?? snapshot.definition, registry);
  if (!blueprint.ok) {
    const errors = blueprint.diagnostics.filter((item) => item.severity === 'error').map((item) => item.message);
    return {
      ok: false,
      code: 'WorkflowBlueprintInvalid',
      error: `Workflow blueprint has blocking diagnostics: ${errors.join('; ') || 'unknown error'}`,
      workflow: snapshot,
      run: snapshot.run,
      events: [],
      blueprint,
    };
  }
  // 防止重复启动正在运行的 run
  // — Chinese: prevent double-starting a running run
  if (request.action === 'run' && snapshot.run.status === 'running') {
    return { ok: false, code: 'WorkflowRunAlreadyRunning', error: 'Workflow run is already running', workflow: snapshot, run: snapshot.run };
  }

  const emitted: WorkflowEvent[] = [];
  const emit = (event: WorkflowEvent): void => { emitted.push(event); };
  try {
    let workflow: WorkflowSnapshot;
    const definition = executionDefinition ?? snapshot.definition;
    // cancel：标记当前 run 为取消；resume：恢复并运行后续节点；retry_node：重新运行某节点；test_run：在新的 run 中运行以进行测试；run_node：仅运行指定节点；run：创建并运行新的 run
    // — Chinese: cancel marks run cancelled; resume resumes pending nodes; retry_node retries a node; test_run runs on a fresh run; run_node runs a single node; run creates and runs a new formal run
    if (request.action === 'cancel') {
      workflow = resumeWorkflowRun({ definition: snapshot.definition, run: snapshot.run, action: 'cancel', now, emit }).workflow;
      workflow = preserveWorkflowPublication(snapshot, workflow);
    } else if (request.action === 'resume') {
      const resumed = resumeWorkflowRun({ definition: snapshot.definition, run: snapshot.run, action: 'resume', now, emit }).run;
      workflow = (await runNextWorkflowNodes({
        definition,
        run: resumed,
        registry,
        executors,
        now,
        threadId,
        tenantId: thread.tenantId,
        input: request.input ?? { goal: snapshot.definition.goal },
        emit,
      })).workflow;
      workflow = preserveWorkflowPublication(snapshot, workflow);
    } else if (request.action === 'retry_node') {
      workflow = {
        definition: snapshot.definition,
        run: retryWorkflowNode(snapshot.definition, snapshot.run, request.nodeId, now, emit),
        publishedDefinition: snapshot.publishedDefinition ?? null,
        publication: snapshot.publication,
        history: snapshot.history,
      };
    } else if (request.action === 'test_run') {
      const testRun = createWorkflowRunFromDefinition(snapshot.definition, now, registry);
      const tested = (await runNextWorkflowNodes({
        definition: snapshot.definition,
        run: testRun,
        registry,
        executors,
        now,
        threadId,
        tenantId: thread.tenantId,
        input: request.input ?? { goal: snapshot.definition.goal },
        emit,
      })).workflow;
      workflow = {
        ...snapshot,
        publication: {
          ...(snapshot.publication ?? { status: snapshot.publishedDefinition ? 'published' : 'draft' }),
          lastTestRunId: tested.run.id,
        },
        history: [
          ...(snapshot.history ?? []),
          {
            version: snapshot.definition.version,
            status: 'test',
            changelog: 'Test run',
            definitionId: snapshot.definition.id,
            runId: tested.run.id,
            createdAt: now.toISOString(),
          },
        ],
      };
      await persistWorkflowRunAudit(store, thread, { ...tested, publishedDefinition: snapshot.publishedDefinition ?? null, publication: workflow.publication, history: workflow.history }, request.action, emitted, now);
      const saved = await saveThreadWorkflowSnapshot(store, threadId, workflow, registry);
      return { ok: true, thread: saved, workflow, run: tested.run, events: emitted, blueprint: compileWorkflowBlueprint(snapshot.definition, registry) };
    } else if (request.action === 'run_node') {
      if (snapshot.run.status === 'running') {
        return { ok: false, code: 'WorkflowRunAlreadyRunning', error: 'Cannot run single node while workflow run is active', workflow: snapshot, run: snapshot.run };
      }
      workflow = (await runWorkflowNode({
        definition,
        run: ensureRunnableWorkflowRun(snapshot, registry),
        nodeId: request.nodeId,
        registry,
        executors,
        now,
        threadId,
        tenantId: thread.tenantId,
        input: request.input ?? { goal: snapshot.definition.goal },
        emit,
      })).workflow;
      workflow = preserveWorkflowPublication(snapshot, workflow);
    } else {
      const formalRun = createWorkflowRunFromDefinition(definition, now, registry);
      workflow = (await runNextWorkflowNodes({
        definition,
        run: formalRun,
        registry,
        executors,
        now,
        threadId,
        tenantId: thread.tenantId,
        input: request.input ?? { goal: definition.goal },
        emit,
      })).workflow;
      workflow = {
        ...preserveWorkflowPublication(snapshot, workflow),
        definition: snapshot.definition,
      };
    }

    const saved = await saveThreadWorkflowSnapshot(store, threadId, workflow, registry);
    await persistWorkflowRunAudit(store, thread ?? saved!, workflow, request.action, emitted, now);
    return {
      ok: true,
      thread: saved,
      workflow,
      run: workflow.run,
      events: emitted,
      blueprint: compileWorkflowBlueprint(workflow.definition, registry),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const event: WorkflowEvent = {
      type: 'workflow.run.failed',
      workflowId: snapshot.definition.id,
      runId: snapshot.run.id,
      timestamp: now.toISOString(),
      detail: message,
    };
    await persistWorkflowRunAudit(store, thread, snapshot, request.action, [event], now, message);
    return { ok: false, code: 'WorkflowRuntimeFailed', error: message, workflow: snapshot, run: snapshot.run, events: [event] };
  }
}

// 保留源快照的发布信息（publishedDefinition/publication/history）到新的工作流
// — Chinese: preserve source snapshot publication metadata (publishedDefinition/publication/history) into new workflow
function preserveWorkflowPublication(source: WorkflowSnapshot, workflow: WorkflowSnapshot): WorkflowSnapshot {
  return {
    ...workflow,
    publishedDefinition: source.publishedDefinition ?? workflow.publishedDefinition ?? null,
    publication: source.publication ?? workflow.publication,
    history: source.history ?? workflow.history,
  };
}

// 工作流路由主入口（组件 CRUD、计划草案、线程快照读写、运行/测试运行、节点级运行/重试、运行恢复/取消等）
// — Chinese: main workflow route entry (component CRUD, draft planning, thread snapshot r/w, run/test-run, node-level run/retry, resume/cancel)
export async function handleWorkflowRoute({
  req,
  res,
  segments,
  store,
  createPlannerModel,
  createWorkflowRegistry,
  createWorkflowExecutors,
}: {
  req: IncomingMessage;
  res: ServerResponse;
  segments: string[];
  store: ThreadStore;
  createPlannerModel?: () => Promise<WorkflowPlannerModel>;
  createWorkflowRegistry?: () => WorkflowComponentRegistry;
  createWorkflowExecutors?: () => Promise<WorkflowNodeExecutors>;
}): Promise<boolean> {
  if (segments[0] !== 'api') return false;
  const registry = await loadWorkflowComponentRegistry(store, createWorkflowRegistry?.() ?? createBuiltinWorkflowComponentRegistry());
  const workflowExecutors = createWorkflowExecutors ? await createWorkflowExecutors() : undefined;

  // api/workflow/components — 组件列表/新增/更新/删除
  // — Chinese: api/workflow/components — list/create/update/delete components
  if (segments[1] === 'workflow' && segments[2] === 'components') {
    // GET /api/workflow/components — 返回所有组件
    // — Chinese: GET /api/workflow/components — list all components
    if (req.method === 'GET' && segments.length === 3) {
      sendJson(res, 200, { ok: true, components: registry.list() });
      return true;
    }
    // POST /api/workflow/components — 新增（替换同 type 项）
    // — Chinese: POST /api/workflow/components — create (replace by type)
    if (req.method === 'POST' && segments.length === 3) {
      try {
        const body = await readJson<{ component?: WorkflowComponentDefinition }>(req);
        if (!body.component) {
          sendError(res, 400, 'Workflow component is required');
          return true;
        }
        const stored = await store.getSetting<{ components?: WorkflowComponentDefinition[] }>(WORKFLOW_COMPONENTS_KEY) ?? {};
        const current = Array.isArray(stored.components) ? stored.components : [];
        const normalized = normalizeUserWorkflowComponent(body.component, registry);
        const next = [...current.filter((component) => component.type !== normalized.type), normalized];
        await store.setSetting(WORKFLOW_COMPONENTS_KEY, { components: next });
        sendJson(res, 200, { ok: true, component: normalized, components: createWorkflowRegistryWithUserComponents(next, createWorkflowRegistry?.() ?? createBuiltinWorkflowComponentRegistry()).list() });
      } catch (error) {
        sendError(res, 400, error instanceof Error ? error.message : String(error));
      }
      return true;
    }
    // PATCH|DELETE /api/workflow/components/:type — 更新或删除指定类型组件
    // — Chinese: PATCH|DELETE /api/workflow/components/:type — update or delete typed component
    if ((req.method === 'PATCH' || req.method === 'DELETE') && segments.length === 4) {
      try {
        const type = decodeURIComponent(segments[3]);
        const stored = await store.getSetting<{ components?: WorkflowComponentDefinition[] }>(WORKFLOW_COMPONENTS_KEY) ?? {};
        const current = Array.isArray(stored.components) ? stored.components : [];
        if (req.method === 'DELETE') {
          const next = current.filter((component) => component.type !== type);
          await store.setSetting(WORKFLOW_COMPONENTS_KEY, { components: next });
          sendJson(res, 200, { ok: true, components: createWorkflowRegistryWithUserComponents(next, createWorkflowRegistry?.() ?? createBuiltinWorkflowComponentRegistry()).list() });
          return true;
        }
        const body = await readJson<{ component?: WorkflowComponentDefinition }>(req);
        const existing = current.find((component) => component.type === type);
        if (!existing || !body.component) {
          sendError(res, 404, 'Workflow component not found');
          return true;
        }
        const normalized = normalizeUserWorkflowComponent({ ...existing, ...body.component, type }, createWorkflowRegistry?.() ?? createBuiltinWorkflowComponentRegistry());
        const next = current.map((component) => component.type === type ? normalized : component);
        await store.setSetting(WORKFLOW_COMPONENTS_KEY, { components: next });
        sendJson(res, 200, { ok: true, component: normalized, components: createWorkflowRegistryWithUserComponents(next, createWorkflowRegistry?.() ?? createBuiltinWorkflowComponentRegistry()).list() });
      } catch (error) {
        sendError(res, 400, error instanceof Error ? error.message : String(error));
      }
      return true;
    }
  }

  // POST /api/workflow/plan-draft — 全局生成工作流草案（不绑定线程）
  // — Chinese: POST /api/workflow/plan-draft — generate draft globally (thread-less)
  if (req.method === 'POST' && segments[1] === 'workflow' && segments[2] === 'plan-draft' && segments.length === 3) {
    const body = await readJson<{ goal?: string }>(req);
    const goal = body.goal?.trim();
    if (!goal) {
      sendError(res, 400, 'Workflow goal is required');
      return true;
    }
    try {
      const model = createPlannerModel ? await createPlannerModel() : undefined;
      const { definition, warning } = await planWorkflowDefinitionSafely(goal, registry, model);
      const workflow: WorkflowSnapshot = {
        definition,
        run: createWorkflowRunFromDefinition(definition, new Date(), registry),
      };
      sendJson(res, 200, { ok: true, workflow, components: registry.list(), blueprint: compileWorkflowBlueprint(definition, registry), warning });
    } catch (error) {
      sendError(res, 400, error instanceof Error ? error.message : String(error));
    }
    return true;
  }

  // 线程相关工作流路由：api/threads/:threadId/workflow/*
  // — Chinese: thread-scoped workflow routes
  if (segments[1] !== 'threads' || !segments[2] || segments[3] !== 'workflow') return false;
  const threadId = segments[2];

  // GET /api/threads/:id/workflow — 返回线程工作流快照与组件/蓝图
  // — Chinese: GET /api/threads/:id/workflow — return thread workflow snapshot + components + blueprint
  if (req.method === 'GET' && segments.length === 4) {
    const thread = await store.getThread(threadId);
    if (!thread) {
      sendError(res, 404, 'Thread not found');
      return true;
    }
    const workflow = await readPersistedThreadWorkflowSnapshot(store, thread, registry);
    sendJson(res, 200, {
      workflow,
      components: registry.list(),
      blueprint: workflow ? compileWorkflowBlueprint(workflow.definition, registry) : null,
    });
    return true;
  }

  // POST /api/threads/:id/workflow/run — 正式运行工作流（需已发布）
  // — Chinese: POST /api/threads/:id/workflow/run — formal run (requires published)
  if (req.method === 'POST' && segments.length === 5 && segments[4] === 'run') {
    const body = await readWorkflowRuntimeBody(req);
    const result = await runThreadWorkflowRuntimeAction(store, threadId, { action: 'run', input: body.input }, registry, new Date(), workflowExecutors);
    sendWorkflowRuntimeResponse(res, result);
    return true;
  }

  // POST /api/threads/:id/workflow/test-run — 以独立的 run 运行工作流用于测试
  // — Chinese: POST /api/threads/:id/workflow/test-run — test-run workflow in isolated run
  if (req.method === 'POST' && segments.length === 5 && segments[4] === 'test-run') {
    const body = await readWorkflowRuntimeBody(req);
    const result = await runThreadWorkflowRuntimeAction(store, threadId, { action: 'test_run', input: body.input }, registry, new Date(), workflowExecutors);
    sendWorkflowRuntimeResponse(res, result);
    return true;
  }

  // POST /api/threads/:id/workflow/publish — 发布工作流定义
  // — Chinese: POST /api/threads/:id/workflow/publish — publish workflow definition
  if (req.method === 'POST' && segments.length === 5 && segments[4] === 'publish') {
    const body: { changelog?: string } = await readJson<{ changelog?: string }>(req).catch(() => ({}));
    const result = await runThreadWorkflowRuntimeAction(store, threadId, { action: 'publish', changelog: body.changelog }, registry, new Date(), workflowExecutors);
    sendWorkflowRuntimeResponse(res, result);
    return true;
  }

  // POST /api/threads/:id/workflow/nodes/:nodeId/run|retry — 单节点运行或重试
  // — Chinese: POST /api/threads/:id/workflow/nodes/:nodeId/run|retry — single-node run/retry
  if (req.method === 'POST' && segments.length === 7 && segments[4] === 'nodes' && (segments[6] === 'run' || segments[6] === 'retry')) {
    const body = await readWorkflowRuntimeBody(req);
    const result = await runThreadWorkflowRuntimeAction(store, threadId, segments[6] === 'retry'
      ? { action: 'retry_node', nodeId: segments[5] }
      : { action: 'run_node', nodeId: segments[5], input: body.input }, registry, new Date(), workflowExecutors);
    sendWorkflowRuntimeResponse(res, result);
    return true;
  }

  // POST /api/threads/:id/workflow/runs/:runId/resume|cancel — 运行恢复或取消
  // — Chinese: POST /api/threads/:id/workflow/runs/:runId/resume|cancel — resume or cancel a run
  if (req.method === 'POST' && segments.length === 7 && segments[4] === 'runs' && (segments[6] === 'resume' || segments[6] === 'cancel')) {
    const thread = await store.getThread(threadId);
    const workflow = thread ? await readPersistedThreadWorkflowSnapshot(store, thread, registry) : null;
    if (workflow && workflow.run.id !== segments[5]) {
      sendJson(res, 409, { ok: false, code: 'WorkflowRunMismatch', error: 'Workflow run id does not match current snapshot' });
      return true;
    }
    const body = await readWorkflowRuntimeBody(req);
    const result = await runThreadWorkflowRuntimeAction(store, threadId, segments[6] === 'cancel'
      ? { action: 'cancel' }
      : { action: 'resume', input: body.input }, registry, new Date(), workflowExecutors);
    sendWorkflowRuntimeResponse(res, result);
    return true;
  }

  // POST /api/threads/:id/workflow/plan-draft — 为线程生成工作流草案（追加 turn + items，不强制发布）
  // — Chinese: POST /api/threads/:id/workflow/plan-draft — generate draft appended to thread (turn + items, no publish)
  if (req.method === 'POST' && segments.length === 5 && segments[4] === 'plan-draft') {
    const body = await readJson<{ goal?: string }>(req);
    const goal = body.goal?.trim();
    if (!goal) {
      sendError(res, 400, 'Workflow goal is required');
      return true;
    }
    try {
      const thread = await store.getThread(threadId);
      if (!thread) {
        sendError(res, 404, 'Thread not found');
        return true;
      }
      const model = createPlannerModel ? await createPlannerModel() : undefined;
      const { definition, warning } = await planWorkflowDefinitionSafely(goal, registry, model);
      const workflow: WorkflowSnapshot = {
        definition,
        run: createWorkflowRunFromDefinition(definition, new Date(), registry),
      };
      const items = await appendWorkflowDraftTranscript(store, threadId, goal, workflow, new Date(), registry);
      sendJson(res, 200, { ok: true, workflow, components: registry.list(), blueprint: compileWorkflowBlueprint(definition, registry), items, warning });
    } catch (error) {
      sendError(res, 400, error instanceof Error ? error.message : String(error));
    }
    return true;
  }

  // PUT /api/threads/:id/workflow — 以外部快照覆盖线程工作流快照
  // — Chinese: PUT /api/threads/:id/workflow — overwrite thread workflow snapshot
  if (req.method === 'PUT' && segments.length === 4) {
    const body = await readJson<{ workflow?: WorkflowSnapshot }>(req);
    if (!body.workflow) {
      sendError(res, 400, 'Workflow snapshot is required');
      return true;
    }
    try {
      if (body.workflow.run.status === 'running') {
        sendJson(res, 409, { ok: false, code: 'WorkflowRunRunning', error: 'Cannot overwrite a running workflow snapshot' });
        return true;
      }
      const blueprint = validateWorkflowBlueprintOrThrow(body.workflow, registry);
      const thread = await saveThreadWorkflowSnapshot(store, threadId, body.workflow, registry);
      if (!thread) {
        sendError(res, 404, 'Thread not found');
        return true;
      }
      const workflow = readThreadWorkflowSnapshot(thread, registry);
      sendJson(res, 200, { ok: true, thread, workflow, components: registry.list(), blueprint });
    } catch (error) {
      sendError(res, 400, error instanceof Error ? error.message : String(error));
    }
    return true;
  }

  // POST /api/threads/:id/workflow/plan — 为线程生成工作流草案（保存为 checkpoint）
  // — Chinese: POST /api/threads/:id/workflow/plan — generate and persist plan draft to thread
  if (req.method === 'POST' && segments.length === 5 && segments[4] === 'plan') {
    const body = await readJson<{ goal?: string }>(req);
    const goal = body.goal?.trim();
    if (!goal) {
      sendError(res, 400, 'Workflow goal is required');
      return true;
    }
    try {
      const model = createPlannerModel ? await createPlannerModel() : undefined;
      const { definition, warning } = await planWorkflowDefinitionSafely(goal, registry, model);
      const snapshot: WorkflowSnapshot = {
        definition,
        run: createWorkflowRunFromDefinition(definition, new Date(), registry),
      };
      const blueprint = validateWorkflowBlueprintOrThrow(snapshot, registry);
      const thread = await saveThreadWorkflowSnapshot(store, threadId, snapshot, registry);
      if (!thread) {
        sendError(res, 404, 'Thread not found');
        return true;
      }
      sendJson(res, 200, { ok: true, thread, workflow: readThreadWorkflowSnapshot(thread, registry), components: registry.list(), blueprint, warning });
    } catch (error) {
      sendError(res, 400, error instanceof Error ? error.message : String(error));
    }
    return true;
  }

  // PATCH /api/threads/:id/workflow/nodes/:nodeId — 增量更新节点契约
  // — Chinese: PATCH /api/threads/:id/workflow/nodes/:nodeId — incrementally update node contract
  if (req.method === 'PATCH' && segments.length === 6 && segments[4] === 'nodes') {
    const patch = normalizeWorkflowNodePatch(await readJson<Record<string, unknown>>(req));
    if (!patch) {
      sendError(res, 400, 'Workflow node patch is required');
      return true;
    }
    try {
      const current = await store.getThread(threadId);
      const currentWorkflow = current ? await readPersistedThreadWorkflowSnapshot(store, current, registry) : null;
      if (currentWorkflow?.run.status === 'running') {
        sendJson(res, 409, { ok: false, code: 'WorkflowRunRunning', error: 'Cannot edit a running workflow snapshot' });
        return true;
      }
      const thread = await updateThreadWorkflowNode(store, threadId, segments[5], patch, registry);
      if (!thread) {
        sendError(res, 404, 'Thread not found');
        return true;
      }
      const workflow = readThreadWorkflowSnapshot(thread, registry);
      sendJson(res, 200, { ok: true, thread, workflow, components: registry.list(), blueprint: workflow ? compileWorkflowBlueprint(workflow.definition, registry) : null });
    } catch (error) {
      sendError(res, 400, error instanceof Error ? error.message : String(error));
    }
    return true;
  }

  return false;
}

function createWorkflowDraftTranscriptItems(
  turnId: string,
  goal: string,
  workflow: WorkflowSnapshot,
  blueprint: ReturnType<typeof compileWorkflowBlueprint>,
  timestamp: string,
): ThreadItem[] {
  const nodes = workflow.definition.nodes.filter((node) => node.componentType !== 'start' && node.componentType !== 'end');
  const titles = nodes.slice(0, 6).map((node, index) => `${index + 1}. ${node.title}`).join('；') || '暂无业务节点';
  const requirements = nodes.slice(0, 3).map((node) => node.inputRequirements).filter(Boolean).join('\n');
  const missingInputs = blueprint.missingInputs.slice(0, 4);
  return [
    { id: `${turnId}_user`, type: 'user_message', turnId, text: goal, timestamp },
    {
      id: `${turnId}_assistant`,
      type: 'agent_message',
      turnId,
      text: `我已在右侧生成 ${nodes.length} 个业务节点的工作流草案。这是静态蓝图，不会自动运行；保存草案后才会成为当前工作流项目的 checkpoint。\n\n关键节点：${titles}\n\n保留的输入契约：\n${requirements || goal}${missingInputs.length ? `\n\n仍需补充：\n${missingInputs.join('\n')}` : ''}`,
      timestamp,
    },
  ];
}

function ensureRunnableWorkflowRun(snapshot: WorkflowSnapshot, registry: WorkflowComponentRegistry): WorkflowSnapshot['run'] {
  if (snapshot.run.status === 'completed' || snapshot.run.status === 'failed' || snapshot.run.status === 'blocked' || snapshot.run.status === 'cancelled') {
    return createWorkflowRunFromDefinition(snapshot.definition, new Date(), registry);
  }
  return snapshot.run;
}

async function persistWorkflowRunAudit(
  store: ThreadStore,
  thread: ThreadMeta,
  workflow: WorkflowSnapshot,
  action: WorkflowRuntimeAction,
  events: WorkflowEvent[],
  now: Date,
  error?: string,
): Promise<void> {
  if (!store.createRunRecord && !store.appendRunEvent && !store.updateRunRecord) return;
  const status = workflowRunStatusToRunStatus(workflow.run.status);
  const record: RunRecord = {
    runId: workflow.run.id,
    tenantId: thread.tenantId,
    threadId: thread.threadId,
    turnId: null,
    parentRunId: null,
    workflowId: workflow.definition.id,
    workflowNodeId: null,
    kind: 'workflow',
    status,
    title: workflow.definition.goal,
    caller: 'workflow',
    activeStep: workflow.run.nodeRuns.find((nodeRun) => nodeRun.status === 'running' || nodeRun.status === 'blocked')?.nodeId ?? null,
    model: null,
    error: error ?? workflow.run.nodeRuns.find((nodeRun) => nodeRun.error)?.error ?? null,
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    toolCallCount: 0,
    modelCallCount: 0,
    subagentCount: 0,
    middlewareEventCount: 0,
    firstHumanMessage: null,
    lastAiMessage: null,
    startedAt: workflow.run.createdAt,
    updatedAt: workflow.run.updatedAt,
    completedAt: ['completed', 'failed', 'blocked', 'cancelled'].includes(workflow.run.status) ? now.toISOString() : null,
    metadata: { action, workflowVersion: workflow.definition.version },
  };
  await store.createRunRecord?.(record);
  const existing = await store.listRunEvents?.(workflow.run.id).catch(() => [] as RunEvent[]) ?? [];
  let sequence = existing.length;
  for (const event of events) {
    sequence += 1;
    await store.appendRunEvent?.({
      eventId: `${workflow.run.id}_${sequence}_${event.type.replace(/\W/g, '_')}`,
      runId: workflow.run.id,
      tenantId: thread.tenantId,
      threadId: thread.threadId,
      turnId: null,
      parentRunId: null,
      workflowId: event.workflowId,
      workflowNodeId: event.nodeId ?? null,
      sequence,
      category: 'workflow',
      type: event.type,
      level: event.type.endsWith('.failed') ? 'error' : event.type.endsWith('.blocked') ? 'warning' : 'info',
      message: event.detail ?? event.type,
      metadata: { action },
      createdAt: event.timestamp,
    });
  }
}

function workflowRunStatusToRunStatus(status: WorkflowSnapshot['run']['status']): RunRecord['status'] {
  if (status === 'planned') return 'pending';
  if (status === 'cancelled') return 'interrupted';
  if (status === 'blocked') return 'blocked';
  if (status === 'failed') return 'failed';
  if (status === 'completed') return 'completed';
  return 'running';
}

function isWorkflowComponentDefinition(value: unknown): value is WorkflowComponentDefinition {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<WorkflowComponentDefinition>;
  return typeof candidate.type === 'string'
    && typeof candidate.name === 'string'
    && typeof candidate.description === 'string'
    && typeof candidate.defaultPrompt === 'string'
    && typeof candidate.executorKind === 'string'
    && !!candidate.inputSchema
    && !!candidate.outputSchema;
}

type WorkflowNodePatch = Partial<Pick<WorkflowDefinition['nodes'][number], 'title' | 'prompt' | 'inputRequirements' | 'outputRequirements' | 'dependsOn' | 'approval' | 'params'>>;

function normalizeWorkflowNodePatch(body: Record<string, unknown>): WorkflowNodePatch | null {
  const patch: WorkflowNodePatch = {};
  if (typeof body.title === 'string') patch.title = body.title.trim();
  if (typeof body.prompt === 'string') patch.prompt = body.prompt;
  if (typeof body.inputRequirements === 'string') patch.inputRequirements = body.inputRequirements;
  if (typeof body.outputRequirements === 'string') patch.outputRequirements = body.outputRequirements;
  if (Array.isArray(body.dependsOn) && body.dependsOn.every((value) => typeof value === 'string')) {
    patch.dependsOn = body.dependsOn.map((value) => value.trim()).filter(Boolean);
  }
  if (body.approval === 'none' || body.approval === 'required') {
    patch.approval = body.approval as WorkflowApprovalMode;
  }
  if (body.params && typeof body.params === 'object' && !Array.isArray(body.params)) {
    patch.params = body.params as Record<string, unknown>;
  }
  return Object.keys(patch).length ? patch : null;
}

function withPlannerTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  if (timeoutMs <= 0) return promise;
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Workflow planner timed out after ${timeoutMs}ms`)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error) => {
        clearTimeout(timeout);
        reject(error);
      },
    );
  });
}

function sendWorkflowRuntimeResponse(res: ServerResponse, result: ThreadWorkflowRuntimeResponse): void {
  if (result.ok) {
    sendJson(res, 200, result);
    return;
  }
  const status = result.code === 'ThreadNotFound' || result.code === 'WorkflowNotFound'
    ? 404
    : result.code === 'WorkflowRunAlreadyRunning' || result.code === 'WorkflowRunMismatch'
      ? 409
      : 400;
  sendJson(res, status, result);
}

async function readWorkflowRuntimeBody(req: IncomingMessage): Promise<{ input?: Record<string, unknown> }> {
  return readJson<{ input?: Record<string, unknown> }>(req).catch(() => ({}));
}
