import type { IncomingMessage, ServerResponse } from 'node:http';
import type { RunControlAction, RunControlRequest, RunControlResult, RunTraceCategory } from '@suanlizi/protocol';
import { computeRunControlCapabilities, runControlRequestSchema } from '@suanlizi/protocol';
import type { RunRecord, ThreadStore } from '@suanlizi/storage';
import type { RunTraceStore } from '@suanlizi/storage';
import { readJson, sendError, sendJson } from '../shared/http.js';
import type { TenantContext } from '../shared/tenant.js';
import type { ActiveRunRegistry } from '../runtime/activeRunRegistry.js';

export type { RunControlAction, RunControlCapabilities, RunControlRequest, RunControlResult } from '@suanlizi/protocol';

// 使用 runControlRequestSchema 校验请求体：三个分支均 .strict()，
// 拒绝 threadId、rollback 缺 checkpointId、approve/deny/retry 等。
// — English: validate body via runControlRequestSchema; three strict branches reject
// threadId, rollback without checkpointId, approve/deny/retry, etc.
function validateControlBody(body: Record<string, unknown>): { ok: true; parsed: RunControlRequest } | { ok: false; error: string } {
  // 显式拒绝 threadId，给出更清晰的错误信息（schema 也会拒绝，但错误不够直观）
  // — English: reject threadId explicitly for a clearer error (schema would also reject it)
  if ('threadId' in body) {
    return { ok: false, error: 'threadId must not be provided in request body; it is derived from the run record' };
  }
  const result = runControlRequestSchema.safeParse(body);
  if (!result.success) {
    const firstIssue = result.error.issues[0];
    const path = firstIssue?.path.join('.') ?? 'root';
    return { ok: false, error: `${path}: ${firstIssue?.message ?? 'Invalid run control request'}` };
  }
  return { ok: true, parsed: result.data };
}

export interface RunControlHandlerRequest {
  runId: string;
  threadId: string;
  run: RunRecord;
  checkpointId?: string;
}

async function handleRunScopedRoutes(options: {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  store: ThreadStore;
  tenantId: string;
  runId: string;
  subPath: string;
  activeRunRegistry?: ActiveRunRegistry;
  onControlRun?: (action: RunControlAction, request: RunControlHandlerRequest) => Promise<unknown>;
}): Promise<boolean> {
  const { req, res, url, store, tenantId, runId, subPath, activeRunRegistry, onControlRun } = options;

  if (req.method === 'GET' && subPath === 'events') {
    const events = await store.listRunEvents?.(runId, {
      category: url.searchParams.get('category') ?? undefined,
      type: url.searchParams.get('type') ?? undefined,
      afterSequence: url.searchParams.get('after') ? Number(url.searchParams.get('after')) : undefined,
      beforeSequence: url.searchParams.get('before') ? Number(url.searchParams.get('before')) : undefined,
      limit: Number(url.searchParams.get('limit') ?? 500),
    }) ?? [];
    sendJson(res, 200, { events });
    return true;
  }

  if (req.method === 'GET' && subPath === 'trace') {
    const run = await store.getRunRecord?.(runId) ?? null;
    if (!run) {
      sendError(res, 404, 'Run not found');
      return true;
    }
    const traceStore = store as ThreadStore & Partial<RunTraceStore>;
    if (!traceStore.listRunTraceEvents) {
      sendError(res, 501, 'Run trace store is not available');
      return true;
    }
    const page = await traceStore.listRunTraceEvents(runId, {
      before: numberSearchParam(url, 'before'),
      after: numberSearchParam(url, 'after'),
      limit: numberSearchParam(url, 'limit'),
      categories: runTraceCategories(url),
      errorsOnly: booleanSearchParam(url, 'errorsOnly'),
    });
    sendJson(res, 200, {
      runId,
      threadId: run.threadId,
      page,
    });
    return true;
  }

  if (req.method === 'GET' && subPath === 'items') {
    const run = await store.getRunRecord?.(runId) ?? null;
    if (!run) {
      sendError(res, 404, 'Run not found');
      return true;
    }
    const limit = Number(url.searchParams.get('limit') ?? 200);
    const itemTypeFilter = url.searchParams.get('type') ?? undefined;
    const turnIdFilter = url.searchParams.get('turnId') ?? undefined;
    const afterSeq = url.searchParams.get('after') ? Number(url.searchParams.get('after')) : undefined;
    const beforeSeq = url.searchParams.get('before') ? Number(url.searchParams.get('before')) : undefined;
    const filtered = await store.getItems(run.threadId, {
      runId,
      turnId: turnIdFilter,
      type: itemTypeFilter,
      afterSequence: afterSeq,
      beforeSequence: beforeSeq,
    });
    const total = filtered.length;
    const items = filtered.slice(-limit);
    const nextCursor = total > limit ? (total - items.length) : null;
    sendJson(res, 200, {
      items,
      runId,
      threadId: run.threadId,
      total,
      limit,
      nextCursor,
    });
    return true;
  }

  if (req.method === 'GET' && subPath === 'turns') {
    const run = await store.getRunRecord?.(runId) ?? null;
    if (!run) {
      sendError(res, 404, 'Run not found');
      return true;
    }
    const turns = await store.getTurns(run.threadId);
    const runTurns = run.turnId
      ? turns.filter((t) => t.turnId === run.turnId)
      : [];
    sendJson(res, 200, {
      turns: runTurns,
      runId,
      threadId: run.threadId,
    });
    return true;
  }

  if (req.method === 'POST' && subPath === 'control') {
    const rawBody = await readJson<Record<string, unknown>>(req);
    const validation = validateControlBody(rawBody);
    if (!validation.ok) {
      sendError(res, 400, validation.error);
      return true;
    }
    const { parsed: body } = validation;

    if (!store.appendRunEvent || !store.updateRunRecord) {
      sendError(res, 501, 'Run monitor store is not available');
      return true;
    }

    const run = await store.getRunRecord?.(runId) ?? null;
    if (!run) {
      sendError(res, 404, 'Run not found');
      return true;
    }

    const threadId = run.threadId;
    const now = new Date().toISOString();
    const controlId = `ctrl_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    let controlError: string | null = null;
    let errorCode: 'RUN_NOT_ACTIVE' | 'ACTION_NOT_SUPPORTED' | null = null;

    if (body.action === 'interrupt') {
      if (activeRunRegistry) {
        try {
          const handle = activeRunRegistry.get(runId);
          if (!handle) {
            controlError = 'RUN_NOT_ACTIVE';
            errorCode = 'RUN_NOT_ACTIVE';
          } else {
            await handle.interrupt();
          }
        } catch (error) {
          controlError = error instanceof Error ? error.message : String(error);
        }
      } else {
        controlError = 'ACTION_NOT_SUPPORTED';
        errorCode = 'ACTION_NOT_SUPPORTED';
      }
    } else if (body.action === 'resume' || body.action === 'rollback') {
      if (!onControlRun) {
        controlError = 'ACTION_NOT_SUPPORTED';
        errorCode = 'ACTION_NOT_SUPPORTED';
      } else {
        try {
          const checkpointId = body.action === 'rollback' ? body.checkpointId : undefined;
          await onControlRun(body.action, {
            runId,
            threadId,
            run,
            checkpointId,
          });
        } catch (error) {
          controlError = error instanceof Error ? error.message : String(error);
        }
      }
    }

    const recordedCheckpointId = body.action === 'rollback' ? body.checkpointId : null;
    await store.appendRunEvent({
      eventId: `control_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      runId,
      tenantId,
      threadId,
      sequence: Date.now(),
      category: 'control',
      type: `control.${body.action}`,
      level: controlError ? 'error' : 'info',
      message: controlError ?? `Run control action: ${body.action}`,
      metadata: {
        controlId,
        checkpointId: recordedCheckpointId,
        status: controlError ? 'failed' : 'completed',
        error: controlError,
        errorCode,
      },
      createdAt: now,
    });
    await store.updateRunRecord(runId, {
      activeStep: `control.${body.action}`,
      updatedAt: now,
      ...(body.action === 'interrupt' && !controlError ? { status: 'interrupted' as const } : {}),
    });

    if (controlError) {
      const statusCode = errorCode === 'RUN_NOT_ACTIVE' ? 409 : errorCode === 'ACTION_NOT_SUPPORTED' ? 501 : 409;
      sendJson(res, statusCode, {
        targetRunId: runId,
        controlRunId: controlId,
        threadId,
        action: body.action,
        accepted: false,
        reason: controlError,
      } satisfies RunControlResult);
      return true;
    }
    sendJson(res, 200, {
      targetRunId: runId,
      controlRunId: controlId,
      threadId,
      action: body.action,
      accepted: true,
    } satisfies RunControlResult);
    return true;
  }

  return false;
}

export async function handleRunMonitorRoute(options: {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  segments: string[];
  store: ThreadStore;
  tenantContext: TenantContext;
  activeRunRegistry?: ActiveRunRegistry;
  onControlRun?: (action: RunControlAction, request: RunControlHandlerRequest) => Promise<unknown>;
}): Promise<boolean> {
  const { req, res, segments, store, tenantContext, url } = options;

  if (segments[0] === 'api' && segments[1] === 'runs') {
    if (req.method === 'GET' && segments.length === 2) {
      const runs = await store.listRunRecords?.({
        threadId: url.searchParams.get('threadId') ?? undefined,
        status: url.searchParams.get('status') as never || undefined,
        limit: Number(url.searchParams.get('limit') ?? 100),
      }) ?? [];
      const activeRunIds = new Set(options.activeRunRegistry ? options.activeRunRegistry.listActiveRunIds() : []);
      const runsWithCapabilities = runs.map((run) => ({
        ...run,
        controlCapabilities: computeRunControlCapabilities({
          runStatus: run.status,
          active: activeRunIds.has(run.runId),
        }),
      }));
      sendJson(res, 200, { runs: runsWithCapabilities });
      return true;
    }

    if (req.method === 'GET' && segments.length === 3 && segments[2] === 'threads') {
      const limit = Number(url.searchParams.get('limit') ?? 100);
      const threads = await listThreadsWithRuns(store, limit);
      sendJson(res, 200, { threads });
      return true;
    }

    if (segments.length === 4) {
      const runId = segments[2];
      const subPath = segments[3];
      return handleRunScopedRoutes({
        req,
        res,
        url,
        store,
        tenantId: tenantContext.tenantId,
        runId,
        subPath,
        activeRunRegistry: options.activeRunRegistry,
        onControlRun: options.onControlRun,
      });
    }
  }

  return false;
}

function numberSearchParam(url: URL, name: string): number | undefined {
  const value = url.searchParams.get(name);
  if (value == null || value.trim() === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function booleanSearchParam(url: URL, name: string): boolean | undefined {
  const value = url.searchParams.get(name);
  if (value == null) return undefined;
  return value === '1' || value.toLowerCase() === 'true';
}

function runTraceCategories(url: URL): RunTraceCategory[] | undefined {
  const values = url.searchParams
    .getAll('category')
    .flatMap((value) => value.split(','))
    .map((value) => value.trim())
    .filter(Boolean) as RunTraceCategory[];
  return values.length > 0 ? values : undefined;
}

interface ThreadWithRunStats {
  threadId: string;
  title: string;
  runCount: number;
  lastActiveAt: string;
  tenantId: string;
  status: string;
  parentThreadId: string | null;
  agentNickname: string | null;
  agentRole: string | null;
}

async function listThreadsWithRuns(
  store: ThreadStore,
  limit: number,
): Promise<ThreadWithRunStats[]> {
  const runs = await store.listRunRecords?.({
    limit: undefined,
  }) ?? [];

  if (runs.length === 0) {
    return [];
  }

  const threadStatsMap = new Map<string, {
    runCount: number;
    lastActiveAt: string;
    tenantId: string;
  }>();

  for (const run of runs) {
    const threadId = run.threadId;
    const existing = threadStatsMap.get(threadId);
    if (existing) {
      existing.runCount += 1;
      if (run.updatedAt > existing.lastActiveAt) {
        existing.lastActiveAt = run.updatedAt;
      }
    } else {
      threadStatsMap.set(threadId, {
        runCount: 1,
        lastActiveAt: run.updatedAt,
        tenantId: run.tenantId ?? '',
      });
    }
  }

  const threadIds = Array.from(threadStatsMap.keys());
  const threadResults = await Promise.all(
    threadIds.map((threadId) => store.getThread(threadId)),
  );

  const result: ThreadWithRunStats[] = [];
  for (let i = 0; i < threadIds.length; i++) {
    const threadId = threadIds[i];
    const thread = threadResults[i];
    const stats = threadStatsMap.get(threadId)!;

    if (!thread) continue;

    result.push({
      threadId,
      title: thread.title,
      runCount: stats.runCount,
      lastActiveAt: stats.lastActiveAt,
      tenantId: thread.tenantId ?? stats.tenantId,
      status: thread.status,
      parentThreadId: thread.parentThreadId ?? null,
      agentNickname: thread.agentNickname ?? null,
      agentRole: thread.agentRole ?? null,
    });
  }

  result.sort((a, b) => b.lastActiveAt.localeCompare(a.lastActiveAt));

  return result.slice(0, limit);
}
