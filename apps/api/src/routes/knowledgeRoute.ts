import type { IncomingMessage, ServerResponse } from 'node:http';
import type { URL } from 'node:url';
import type { ThreadStore } from '@suanlizi/storage';
import { readJson, sendJson } from '../shared/http.js';
import type { TenantContext } from '../shared/tenant.js';
import {
  authorizeKnowledgeDirectory,
  getKnowledgeBase,
  getKnowledgePage,
  getSnapshot,
  listKnowledgeBases,
  listKnowledgePages,
  queryKnowledge,
  replayKnowledgeReceipt,
  renameKnowledgeBase,
  deleteKnowledgeBase,
} from '../services/knowledgeBase.js';
import {
  actOnKnowledgeJob,
  cancelKnowledgeJobsForBase,
  getKnowledgeBaseJob,
  getKnowledgeJob,
  startKnowledgeBaseCreateJob,
  startKnowledgeBaseSyncJob,
  recoverKnowledgeCompileJobs,
} from '../services/knowledgeCompileJob.js';
import { pickWorkspaceDirectory } from './workspacePicker.js';

export async function handleKnowledgeRoute(options: {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  segments: string[];
  store: ThreadStore;
  tenantContext: TenantContext;
}): Promise<boolean> {
  const { req, res, segments, store, tenantContext } = options;
  if (segments[0] !== 'api') return false;
  await recoverKnowledgeCompileJobs(store, tenantContext.tenantId);

  if (req.method === 'GET' && segments[1] === 'knowledge-jobs' && segments.length === 3) {
    const job = await getKnowledgeJob(store, decodeURIComponent(segments[2]), tenantContext.tenantId);
    if (!job) {
      sendJson(res, 404, { error: { code: 'OPS_KNOWLEDGE_JOB_NOT_FOUND', message: 'Knowledge compile job not found' } });
    } else {
      sendJson(res, 200, { job });
    }
    return true;
  }

  if (req.method === 'POST' && segments[1] === 'knowledge-jobs' && segments[2] && segments[3] === 'actions' && segments.length === 4) {
    const body = await readJson<{ action?: unknown }>(req);
    const action = body.action === 'pause' || body.action === 'resume' || body.action === 'cancel' ? body.action : null;
    if (!action) {
      sendJson(res, 400, { error: { code: 'OPS_KNOWLEDGE_JOB_ACTION_INVALID', message: 'A pause, resume, or cancel action is required' } });
      return true;
    }
    try {
      sendJson(res, 200, { job: await actOnKnowledgeJob(store, tenantContext.tenantId, decodeURIComponent(segments[2]), action) });
    } catch (error) {
      sendJson(res, 409, { error: { code: 'OPS_KNOWLEDGE_JOB_ACTION_FAILED', message: error instanceof Error ? error.message : String(error) } });
    }
    return true;
  }

  if (req.method === 'POST' && segments[1] === 'knowledge-jobs' && segments[2] && segments.length === 4 && (segments[3] === 'pause' || segments[3] === 'resume' || segments[3] === 'cancel')) {
    // Kept out of the primary client path; the action endpoint above is the
    // canonical API, while these aliases ease integration with older clients.
    const jobId = segments[2];
    const actionName = segments[3];
    if (jobId && (actionName === 'pause' || actionName === 'resume' || actionName === 'cancel')) {
      try {
        sendJson(res, 200, { job: await actOnKnowledgeJob(store, tenantContext.tenantId, decodeURIComponent(jobId), actionName) });
      } catch (error) {
        sendJson(res, 409, { error: { code: 'OPS_KNOWLEDGE_JOB_ACTION_FAILED', message: error instanceof Error ? error.message : String(error) } });
      }
      return true;
    }
  }

  if (req.method === 'GET' && segments[1] === 'knowledge-bases' && segments.length === 2) {
    sendJson(res, 200, { knowledgeBases: await listKnowledgeBases(store, tenantContext.tenantId) });
    return true;
  }

  // This is deliberately separate from workspace selection. It invokes the
  // native picker and returns an opaque directory grant, so clients cannot
  // turn an arbitrary request path or active project into a knowledge source.
  if (req.method === 'POST' && segments[1] === 'knowledge' && segments[2] === 'authorize-directory' && segments.length === 3) {
    try {
      const picked = await pickWorkspaceDirectory({ description: '选择个人知识库来源目录' });
      if (picked.cancelled) {
        sendJson(res, 200, { cancelled: true });
        return true;
      }
      const sourceGrant = await authorizeKnowledgeDirectory(store, tenantContext.tenantId, picked.workspaceRoot);
      sendJson(res, 200, { cancelled: false, sourceGrant });
    } catch (error) {
      sendJson(res, 500, { error: { code: 'OPS_KNOWLEDGE_DIRECTORY_PICK_FAILED', message: error instanceof Error ? error.message : String(error) } });
    }
    return true;
  }

  if (req.method === 'POST' && segments[1] === 'knowledge-bases' && segments.length === 2) {
    const body = await readJson<{ name?: unknown; sourceGrantId?: unknown; persistPending?: unknown }>(req);
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    const sourceGrantId = typeof body.sourceGrantId === 'string' ? body.sourceGrantId.trim() : '';
    if (!name) {
      sendJson(res, 400, { error: { code: 'OPS_KNOWLEDGE_NAME_REQUIRED', message: 'KnowledgeBase name is required' } });
      return true;
    }
    if (!sourceGrantId) {
      sendJson(res, 400, { error: { code: 'OPS_KNOWLEDGE_SOURCE_REQUIRED', message: 'A native-picker directory authorization is required' } });
      return true;
    }
    try {
      const result = await startKnowledgeBaseCreateJob(store, tenantContext.tenantId, {
        name,
        sourceGrantId,
        persistPending: body.persistPending === true,
      });
      sendJson(res, 202, { knowledgeBase: result.base, snapshot: null, job: result.job });
    } catch (error) {
      sendJson(res, 400, { error: { code: 'OPS_KNOWLEDGE_SYNC_FAILED', message: error instanceof Error ? error.message : String(error) } });
    }
    return true;
  }

  // Kept as a compatibility endpoint, but it must never create a hidden
  // cwd-based knowledge base. Creation requires a named base and an explicit
  // directory selected by the user.
  if (req.method === 'POST' && segments[1] === 'ops-knowledge' && segments.length === 2) {
    sendJson(res, 409, { error: { code: 'OPS_KNOWLEDGE_SELECTION_REQUIRED', message: 'Create and select a personal knowledge base explicitly.' } });
    return true;
  }

  if (segments[1] === 'knowledge-bases' && segments[2]) {
    const base = await getKnowledgeBase(store, decodeURIComponent(segments[2]), tenantContext.tenantId);
    if (!base) {
      sendJson(res, 404, { error: { code: 'OPS_KNOWLEDGE_NOT_FOUND', message: 'KnowledgeBase not found' } });
      return true;
    }
    if (req.method === 'POST' && segments[3] === 'sync') {
      try {
        const body = await readJson<{ persistPending?: unknown }>(req);
        const result = await startKnowledgeBaseSyncJob(store, tenantContext.tenantId, base.knowledgeBaseId, body.persistPending === true);
        sendJson(res, 202, { knowledgeBase: result.base, snapshot: base.currentSnapshotId ? await getSnapshot(store, base.currentSnapshotId, tenantContext.tenantId) : null, job: result.job });
      } catch (error) {
        sendJson(res, 400, { error: { code: 'OPS_KNOWLEDGE_SYNC_FAILED', message: error instanceof Error ? error.message : String(error) } });
      }
      return true;
    }
    if (req.method === 'PATCH' && segments.length === 3) {
      const body = await readJson<{ name?: unknown }>(req);
      if (typeof body.name !== 'string' || !body.name.trim()) {
        sendJson(res, 400, { error: { code: 'OPS_KNOWLEDGE_NAME_REQUIRED', message: 'KnowledgeBase name is required' } });
        return true;
      }
      try {
        sendJson(res, 200, { knowledgeBase: await renameKnowledgeBase(store, tenantContext.tenantId, base.knowledgeBaseId, body.name) });
      } catch (error) {
        sendJson(res, 400, { error: { code: 'OPS_KNOWLEDGE_UPDATE_FAILED', message: error instanceof Error ? error.message : String(error) } });
      }
      return true;
    }
    if (req.method === 'DELETE' && segments.length === 3) {
      try {
        await cancelKnowledgeJobsForBase(store, tenantContext.tenantId, base.knowledgeBaseId);
        await deleteKnowledgeBase(store, tenantContext.tenantId, base.knowledgeBaseId);
        sendJson(res, 204, {});
      } catch (error) {
        sendJson(res, 400, { error: { code: 'OPS_KNOWLEDGE_DELETE_FAILED', message: error instanceof Error ? error.message : String(error) } });
      }
      return true;
    }
    if (req.method === 'GET' && segments.length === 3) {
      const snapshot = base.currentSnapshotId ? await getSnapshot(store, base.currentSnapshotId, tenantContext.tenantId) : null;
      sendJson(res, 200, { knowledgeBase: base, snapshot, job: await getKnowledgeBaseJob(store, base.knowledgeBaseId, tenantContext.tenantId) });
      return true;
    }
    if (req.method === 'GET' && segments[3] === 'job' && segments.length === 4) {
      sendJson(res, 200, { job: await getKnowledgeBaseJob(store, base.knowledgeBaseId, tenantContext.tenantId) });
      return true;
    }
    if (req.method === 'GET' && segments[3] === 'pages' && segments.length === 4) {
      sendJson(res, 200, {
        pages: await listKnowledgePages(store, base.knowledgeBaseId, tenantContext.tenantId),
      });
      return true;
    }
    if (req.method === 'GET' && segments[3] === 'pages' && segments.length === 5) {
      const page = await getKnowledgePage(
        store,
        base.knowledgeBaseId,
        decodeURIComponent(segments[4]),
        tenantContext.tenantId,
      );
      if (!page) {
        sendJson(res, 404, { error: { code: 'OPS_KNOWLEDGE_PAGE_NOT_FOUND', message: 'Knowledge page not found' } });
      } else {
        sendJson(res, 200, { page });
      }
      return true;
    }
  }

  if (req.method === 'GET' && segments[1] === 'knowledge-snapshots' && segments[2]) {
    const snapshot = await getSnapshot(store, decodeURIComponent(segments[2]), tenantContext.tenantId);
    if (!snapshot) {
      sendJson(res, 404, { error: { code: 'OPS_KNOWLEDGE_SNAPSHOT_NOT_FOUND', message: 'Knowledge snapshot not found' } });
      return true;
    }
    sendJson(res, 200, { snapshot });
    return true;
  }

  if (req.method === 'GET' && segments[1] === 'knowledge' && segments[2] === 'receipts' && segments[3]) {
    const replay = await replayKnowledgeReceipt(store, tenantContext.tenantId, decodeURIComponent(segments[3]));
    if (!replay) {
      sendJson(res, 404, { error: { code: 'OPS_KNOWLEDGE_RECEIPT_NOT_FOUND', message: 'Knowledge query receipt not found' } });
      return true;
    }
    sendJson(res, 200, replay);
    return true;
  }

  if (req.method === 'POST' && segments[1] === 'knowledge' && segments[2] === 'query') {
    const body = await readJson<{ knowledgeBaseIds?: unknown; snapshotIds?: unknown; query?: unknown; maxHits?: unknown }>(req);
    const knowledgeBaseIds = Array.isArray(body.knowledgeBaseIds) ? body.knowledgeBaseIds.filter((id): id is string => typeof id === 'string') : [];
    if (knowledgeBaseIds.length === 0 || typeof body.query !== 'string' || !body.query.trim()) {
      sendJson(res, 400, { error: { code: 'OPS_KNOWLEDGE_QUERY_INVALID', message: 'knowledgeBaseIds and query are required' } });
      return true;
    }
    try {
      const result = await queryKnowledge(store, tenantContext.tenantId, {
        knowledgeBaseIds,
        snapshotIds: Array.isArray(body.snapshotIds) ? body.snapshotIds.filter((id): id is string => typeof id === 'string') : undefined,
        query: body.query,
        maxHits: typeof body.maxHits === 'number' ? body.maxHits : undefined,
      });
      sendJson(res, 200, result);
    } catch (error) {
      sendJson(res, 409, { error: { code: 'OPS_KNOWLEDGE_NOT_READY', message: error instanceof Error ? error.message : String(error) } });
    }
    return true;
  }

  return false;
}
