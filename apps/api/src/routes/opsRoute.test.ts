import { describe, expect, it } from 'vitest';
import { PassThrough } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ThreadStore } from '@suanlizi/storage';
import type { TenantContext } from '../shared/tenant.js';
import { handleOpsRoute, recoverOpsTasks } from './opsRoute.js';

class FakeStore implements Partial<ThreadStore> {
  settings = new Map<string, unknown>();
  threads = new Map<string, { threadId: string; workspaceRoot: string }>();

  async getSetting<T = unknown>(key: string): Promise<T | null> {
    return (this.settings.get(key) as T | undefined) ?? null;
  }

  async setSetting(key: string, value: unknown): Promise<void> {
    this.settings.set(key, value);
  }

  async getThread(threadId: string): Promise<any> {
    return this.threads.get(threadId) ?? { threadId, workspaceRoot: 'D:\\suanlizi' };
  }
}

function request(
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): IncomingMessage {
  const stream = new PassThrough();
  const req = stream as unknown as IncomingMessage;
  req.method = method;
  req.url = path;
  req.headers = headers;
  if (body === undefined) stream.end();
  else stream.end(JSON.stringify(body));
  return req;
}

function response() {
  const chunks: Buffer[] = [];
  const res = new PassThrough() as unknown as ServerResponse & {
    statusCode: number;
    body?: unknown;
    chunks: Buffer[];
  };
  res.chunks = chunks;
  res.statusCode = 200;
  res.writeHead = ((status: number) => {
    res.statusCode = status;
    return res;
  }) as never;
  res.write = ((chunk: string | Buffer) => {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    return true;
  }) as never;
  res.end = ((chunk?: string | Buffer) => {
    if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    const raw = Buffer.concat(chunks).toString('utf8');
    res.body = raw ? JSON.parse(raw) : undefined;
    return res;
  }) as never;
  return res;
}

const tenantContext: TenantContext = { tenantId: 'ops-test' };
const spec = {
  threadId: 'thread-1',
  presetId: 'ops',
  workspaceRoot: 'D:\\suanlizi',
  environmentId: 'local',
  target: { hostIds: [] },
  policyProfile: 'ops_readonly',
  acceptanceCriteria: ['collect snapshot'],
  allowLocalPatchProposal: false,
  allowLocalTest: false,
};

describe('Ops task route', () => {
  it('stores SSH metadata only and returns redacted test diagnostics', async () => {
    const store = new FakeStore() as unknown as ThreadStore;
    const saved = response();
    await handleOpsRoute({
      req: request('POST', '/api/ops/ssh-profiles', {
        profileId: 'ssh-prod', name: 'Production', host: 'prod.example.test', port: 22, user: 'ops',
        auth: { method: 'credential_store', credentialRef: 'windows:ops/prod' },
      }),
      res: saved,
      url: new URL('http://localhost/api/ops/ssh-profiles'),
      segments: ['api', 'ops', 'ssh-profiles'],
      store,
      tenantContext,
    });
    expect(saved.statusCode).toBe(201);
    expect(JSON.stringify((store as unknown as FakeStore).settings.get('ops.ssh.profiles.v1'))).not.toContain('password');

    const tested = response();
    await handleOpsRoute({
      req: request('POST', '/api/ops/ssh-profiles/test', {
        profileId: 'ssh-prod', name: 'Production', host: 'prod.example.test', port: 22, user: 'ops',
        auth: { method: 'credential_store', credentialRef: 'windows:ops/prod' },
      }),
      res: tested,
      url: new URL('http://localhost/api/ops/ssh-profiles/test'),
      segments: ['api', 'ops', 'ssh-profiles', 'test'],
      store,
      tenantContext,
    });
    expect(tested.statusCode).toBe(200);
    expect((tested.body as { diagnostics: { status: string; credentialRef?: string } }).diagnostics.status).toBe('not_configured');
    expect(JSON.stringify(tested.body)).not.toContain('privateKey');
  });
  it('does not write the initial SSE replay after the connection closes', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const store = new class extends FakeStore {
      private calls = 0;

      override async getSetting<T = unknown>(key: string): Promise<T | null> {
        this.calls += 1;
        if (this.calls === 2) await gate;
        return super.getSetting<T>(key);
      }
    }() as unknown as ThreadStore & { settings: Map<string, unknown> };
    store.settings.set('ops.tasks.v1', {
      tasks: {
        'ops-sse-close': {
          spec: {
            taskId: 'ops-sse-close',
            threadId: 'thread-1',
            presetId: 'ops',
            workspaceRoot: 'D:\\suanlizi',
            environmentId: 'replay:test',
            target: { hostIds: [] },
            policyProfile: 'ops_readonly',
            budgets: { maxAdapterCalls: 1, maxConcurrentCalls: 1, maxOutputBytes: 1000, maxWallTimeMs: 1000 },
            acceptanceCriteria: [],
            allowLocalPatchProposal: false,
            allowLocalTest: false,
          },
          state: 'draft',
          currentPhase: 'observe',
          hypothesisIds: [],
          evidenceIds: [],
          checkpointSequence: 0,
          taskVersion: 0,
          sequence: 0,
        },
      },
      events: {
        'ops-sse-close': [{
          type: 'ops.task.created',
          taskId: 'ops-sse-close',
          threadId: 'thread-1',
          from: 'draft',
          to: 'draft',
          taskVersion: 0,
          sequence: 0,
          occurredAt: new Date().toISOString(),
        }],
      },
      idempotency: {},
      incidents: {},
    });
    const req = request('GET', '/api/ops/tasks/ops-sse-close/events');
    const res = response();
    const pending = handleOpsRoute({
      req,
      res,
      url: new URL('http://localhost/api/ops/tasks/ops-sse-close/events'),
      segments: ['api', 'ops', 'tasks', 'ops-sse-close', 'events'],
      store,
      tenantContext,
    });
    await new Promise((resolve) => setImmediate(resolve));
    req.emit('close');
    release();
    await pending;

    expect(res.chunks).toHaveLength(0);
  });

  it('lists registered local tests and rejects tests on tasks without explicit permission', async () => {
    const store = new FakeStore() as unknown as ThreadStore;
    const list = response();
    await handleOpsRoute({
      req: request('GET', '/api/ops/tests'),
      res: list,
      url: new URL('http://localhost/api/ops/tests'),
      segments: ['api', 'ops', 'tests'],
      store,
      tenantContext,
    });
    expect(list.statusCode).toBe(200);
    expect((list.body as { tests: Array<{ testId: string }> }).tests.map((item) => item.testId)).toEqual(
      expect.arrayContaining(['workspace.typecheck', 'workspace.unit']),
    );

    const created = response();
    await handleOpsRoute({
      req: request('POST', '/api/ops/tasks', { ...spec, taskId: 'ops-test-permission' }),
      res: created,
      url: new URL('http://localhost/api/ops/tasks'),
      segments: ['api', 'ops', 'tasks'],
      store,
      tenantContext,
    });
    const denied = response();
    await handleOpsRoute({
      req: request('POST', '/api/ops/tasks/ops-test-permission/tests', { testId: 'workspace.typecheck' }),
      res: denied,
      url: new URL('http://localhost/api/ops/tasks/ops-test-permission/tests'),
      segments: ['api', 'ops', 'tasks', 'ops-test-permission', 'tests'],
      store,
      tenantContext,
    });
    expect(denied.statusCode).toBe(403);
    expect((denied.body as { error: { code: string } }).error.code).toBe('OPS_TEST_NOT_ALLOWED');
  });

  it('rejects local-test permission on a non-local environment', async () => {
    const store = new FakeStore() as unknown as ThreadStore;
    const created = response();
    await handleOpsRoute({
      req: request('POST', '/api/ops/tasks', {
        ...spec,
        taskId: 'ops-remote-test-permission',
        environmentId: 'ssh:production',
        allowLocalTest: true,
      }),
      res: created,
      url: new URL('http://localhost/api/ops/tasks'),
      segments: ['api', 'ops', 'tasks'],
      store,
      tenantContext,
    });
    expect(created.statusCode).toBe(403);
    expect((created.body as { error: { code: string } }).error.code).toBe('OPS_TEST_NOT_ALLOWED');
  });

  it('rejects every local task whose workspace is outside the current thread', async () => {
    const store = new FakeStore() as unknown as ThreadStore;
    const created = response();
    await handleOpsRoute({
      req: request('POST', '/api/ops/tasks', {
        ...spec,
        taskId: 'ops-local-scope',
        workspaceRoot: 'D:\\outside-project',
        allowLocalTest: false,
      }),
      res: created,
      url: new URL('http://localhost/api/ops/tasks'),
      segments: ['api', 'ops', 'tasks'],
      store,
      tenantContext,
    });
    expect(created.statusCode).toBe(422);
    expect((created.body as { error: { code: string } }).error.code).toBe('OPS_SCOPE_REQUIRED');
  });

  it('does not queue tests on a terminal task', async () => {
    const store = new FakeStore() as unknown as ThreadStore;
    const created = response();
    await handleOpsRoute({
      req: request('POST', '/api/ops/tasks', { ...spec, taskId: 'ops-terminal-test' }),
      res: created,
      url: new URL('http://localhost/api/ops/tasks'),
      segments: ['api', 'ops', 'tasks'],
      store,
      tenantContext,
    });
    const persisted = (store as unknown as FakeStore).settings.get('ops.tasks.v1') as {
      tasks: Record<string, Record<string, unknown>>;
      events: Record<string, unknown[]>;
      idempotency: Record<string, unknown>;
      incidents: Record<string, unknown>;
    };
    persisted.tasks['ops-terminal-test'] = {
      ...(created.body as { task: Record<string, unknown> }).task,
      state: 'completed',
      spec: { ...(created.body as { task: { spec: Record<string, unknown> } }).task.spec, allowLocalTest: true },
    };
    (store as unknown as FakeStore).settings.set('ops.tasks.v1', persisted);
    const queued = response();
    await handleOpsRoute({
      req: request('POST', '/api/ops/tasks/ops-terminal-test/tests', { testId: 'workspace.typecheck' }),
      res: queued,
      url: new URL('http://localhost/api/ops/tasks/ops-terminal-test/tests'),
      segments: ['api', 'ops', 'tasks', 'ops-terminal-test', 'tests'],
      store,
      tenantContext,
    });
    expect(queued.statusCode).toBe(400);
    expect((queued.body as { error: { code: string } }).error.code).toBe('OPS_TERMINAL_STATE');
  });

  it('cancels an invalid queued test during cold-start recovery', async () => {
    const store = new FakeStore() as unknown as ThreadStore;
    const created = response();
    await handleOpsRoute({
      req: request('POST', '/api/ops/tasks', { ...spec, taskId: 'ops-recovery-test' }),
      res: created,
      url: new URL('http://localhost/api/ops/tasks'),
      segments: ['api', 'ops', 'tasks'],
      store,
      tenantContext,
    });
    const persisted = (store as unknown as FakeStore).settings.get('ops.tasks.v1') as {
      tasks: Record<string, any>;
      events: Record<string, unknown[]>;
      idempotency: Record<string, unknown>;
      incidents: Record<string, unknown>;
    };
    const task = (created.body as { task: any }).task;
    persisted.tasks['ops-recovery-test'] = {
      ...task,
      state: 'completed',
      testRuns: [{ testRunId: 'test-recovery', testId: 'workspace.typecheck', args: [], status: 'queued' }],
      spec: { ...task.spec, environmentId: 'ssh:prod', allowLocalTest: true },
    };
    (store as unknown as FakeStore).settings.set('ops.tasks.v1', persisted);

    await recoverOpsTasks({ store, tenantId: tenantContext.tenantId });
    const recovered = (store as unknown as FakeStore).settings.get('ops.tasks.v1') as typeof persisted;
    expect(recovered.tasks['ops-recovery-test'].testRuns[0]).toMatchObject({
      status: 'cancelled',
      errorCode: 'OPS_TEST_NOT_ALLOWED',
    });
  });

  it('uses the task id segment and supports idempotent creation', async () => {
    const store = new FakeStore() as unknown as ThreadStore;
    const body = { ...spec, start: false };
    const first = response();
    await handleOpsRoute({
      req: request('POST', '/api/ops/tasks', body, { 'idempotency-key': 'create-1' }),
      res: first,
      url: new URL('http://localhost/api/ops/tasks'),
      segments: ['api', 'ops', 'tasks'],
      store,
      tenantContext,
    });
    expect(first.statusCode).toBe(201);
    const taskId = (first.body as { task: { spec: { taskId: string } } }).task.spec.taskId;

    const duplicate = response();
    await handleOpsRoute({
      req: request('POST', '/api/ops/tasks', body, { 'idempotency-key': 'create-1' }),
      res: duplicate,
      url: new URL('http://localhost/api/ops/tasks'),
      segments: ['api', 'ops', 'tasks'],
      store,
      tenantContext,
    });
    expect(duplicate.statusCode).toBe(201);
    expect((duplicate.body as { task: { spec: { taskId: string } } }).task.spec.taskId).toBe(
      taskId,
    );

    const detail = response();
    await handleOpsRoute({
      req: request('GET', `/api/ops/tasks/${taskId}`),
      res: detail,
      url: new URL(`http://localhost/api/ops/tasks/${taskId}`),
      segments: ['api', 'ops', 'tasks', taskId],
      store,
      tenantContext,
    });
    expect(detail.statusCode).toBe(200);
    expect((detail.body as { task: { spec: { taskId: string } } }).task.spec.taskId).toBe(taskId);
  });

  it('rejects queueing through the same task id when no knowledge base is selected', async () => {
    const store = new FakeStore() as unknown as ThreadStore;
    const created = response();
    await handleOpsRoute({
      req: request('POST', '/api/ops/tasks', { ...spec, taskId: 'ops-action-test' }),
      res: created,
      url: new URL('http://localhost/api/ops/tasks'),
      segments: ['api', 'ops', 'tasks'],
      store,
      tenantContext,
    });
    const action = response();
    await handleOpsRoute({
      req: request('POST', '/api/ops/tasks/ops-action-test/actions', {
        action: 'start',
        expectedTaskVersion: 0,
      }),
      res: action,
      url: new URL('http://localhost/api/ops/tasks/ops-action-test/actions'),
      segments: ['api', 'ops', 'tasks', 'ops-action-test', 'actions'],
      store,
      tenantContext,
    });
    expect(action.statusCode).toBe(400);
    expect((action.body as { error: { code: string } }).error.code).toBe('OPS_KNOWLEDGE_REQUIRED');
  });

  it('exposes the documented patch approval path and rejects missing proposals', async () => {
    const store = new FakeStore() as unknown as ThreadStore;
    const created = response();
    await handleOpsRoute({
      req: request('POST', '/api/ops/tasks', { ...spec, taskId: 'ops-patch-test', allowLocalPatchProposal: true }),
      res: created,
      url: new URL('http://localhost/api/ops/tasks'),
      segments: ['api', 'ops', 'tasks'],
      store,
      tenantContext,
    });
    const task = (created.body as { task: Record<string, unknown> }).task;
    const persisted = (store as unknown as FakeStore).settings.get('ops.tasks.v1') as {
      tasks: Record<string, Record<string, unknown>>;
      events: Record<string, unknown[]>;
      idempotency: Record<string, unknown>;
      incidents: Record<string, unknown>;
    };
    persisted.tasks['ops-patch-test'] = {
      ...task,
      state: 'waiting_confirmation',
      taskVersion: 1,
      patchProposal: {
        id: 'patch-1',
        summary: 'Fix config',
        diff: '-old\n+new',
        status: 'proposed',
        createdAt: new Date().toISOString(),
      },
    };
    (store as unknown as FakeStore).settings.set('ops.tasks.v1', persisted);

    const approved = response();
    await handleOpsRoute({
      req: request('POST', '/api/ops/tasks/ops-patch-test/patch/approve', { expectedTaskVersion: 1 }),
      res: approved,
      url: new URL('http://localhost/api/ops/tasks/ops-patch-test/patch/approve'),
      segments: ['api', 'ops', 'tasks', 'ops-patch-test', 'patch', 'approve'],
      store,
      tenantContext,
    });
    expect(approved.statusCode).toBe(200);
    expect((approved.body as { task: { state: string; patchProposal: { status: string } } }).task).toMatchObject({
      state: 'verifying',
      patchProposal: { status: 'approved' },
    });

    const missing = response();
    const current = (store as unknown as FakeStore).settings.get('ops.tasks.v1') as typeof persisted;
    current.tasks['ops-patch-test'] = {
      ...current.tasks['ops-patch-test'],
      state: 'waiting_confirmation',
      taskVersion: 2,
      patchProposal: undefined,
    };
    (store as unknown as FakeStore).settings.set('ops.tasks.v1', current);
    await handleOpsRoute({
      req: request('POST', '/api/ops/tasks/ops-patch-test/patch/approve', { expectedTaskVersion: 2 }),
      res: missing,
      url: new URL('http://localhost/api/ops/tasks/ops-patch-test/patch/approve'),
      segments: ['api', 'ops', 'tasks', 'ops-patch-test', 'patch', 'approve'],
      store,
      tenantContext,
    });
    expect(missing.statusCode).toBe(400);
    expect((missing.body as { error: { code: string } }).error.code).toBe('OPS_INVALID_TRANSITION');
  });

  it('reads evidence and persists a concluded incident with idempotent ownership', async () => {
    const store = new FakeStore() as unknown as ThreadStore;
    const created = response();
    await handleOpsRoute({
      req: request('POST', '/api/ops/tasks', { ...spec, taskId: 'ops-incident-test' }),
      res: created,
      url: new URL('http://localhost/api/ops/tasks'),
      segments: ['api', 'ops', 'tasks'],
      store,
      tenantContext,
    });
    const task = (created.body as { task: Record<string, unknown> }).task;
    const persisted = (store as unknown as FakeStore).settings.get('ops.tasks.v1') as {
      tasks: Record<string, Record<string, unknown>>;
      events: Record<string, unknown[]>;
      idempotency: Record<string, unknown>;
      incidents: Record<string, unknown>;
    };
    persisted.tasks['ops-incident-test'] = {
      ...task,
      state: 'completed',
      evidenceIds: ['evidence-1'],
      evidence: [{
        id: 'evidence-1',
        source: 'replay',
        status: 'complete',
        contentHash: 'hash-1',
        summary: 'redacted summary',
        observedAt: new Date().toISOString(),
        detectorVersion: 'suanlizi-secret-rules-v1',
      }],
      finalConclusion: {
        summary: 'Healthy replay',
        claims: [{ text: 'Healthy', status: 'supported', evidenceIds: ['evidence-1'] }],
      },
    };
    (store as unknown as FakeStore).settings.set('ops.tasks.v1', persisted);

    const evidence = response();
    await handleOpsRoute({
      req: request('GET', '/api/ops/tasks/ops-incident-test/evidence/evidence-1'),
      res: evidence,
      url: new URL('http://localhost/api/ops/tasks/ops-incident-test/evidence/evidence-1'),
      segments: ['api', 'ops', 'tasks', 'ops-incident-test', 'evidence', 'evidence-1'],
      store,
      tenantContext,
    });
    expect(evidence.statusCode).toBe(200);
    expect((evidence.body as { evidence: { id: string } }).evidence.id).toBe('evidence-1');

    const incident = response();
    await handleOpsRoute({
      req: request('POST', '/api/ops/tasks/ops-incident-test/incidents', { title: 'Replay incident' }, { 'idempotency-key': 'incident-1' }),
      res: incident,
      url: new URL('http://localhost/api/ops/tasks/ops-incident-test/incidents'),
      segments: ['api', 'ops', 'tasks', 'ops-incident-test', 'incidents'],
      store,
      tenantContext,
    });
    expect(incident.statusCode).toBe(201);
    const incidentId = (incident.body as { incident: { incidentId: string } }).incident.incidentId;

    const duplicate = response();
    await handleOpsRoute({
      req: request('POST', '/api/ops/tasks/ops-incident-test/incidents', { title: 'Replay incident' }, { 'idempotency-key': 'incident-1' }),
      res: duplicate,
      url: new URL('http://localhost/api/ops/tasks/ops-incident-test/incidents'),
      segments: ['api', 'ops', 'tasks', 'ops-incident-test', 'incidents'],
      store,
      tenantContext,
    });
    expect(duplicate.statusCode).toBe(201);
    expect((duplicate.body as { incident: { incidentId: string } }).incident.incidentId).toBe(incidentId);
  });
});
