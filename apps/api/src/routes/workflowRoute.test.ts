import { describe, expect, it } from 'vitest';
import type { ThreadId, ThreadItem, ThreadMeta, TurnMeta } from '@suanlizi/protocol';
import type { RunEvent, RunRecord, ThreadStore } from '@suanlizi/storage';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import {
  compileWorkflowBlueprint,
  createDefaultWorkflowComponentRegistry,
  createWorkflowDefinitionFromGoal,
  createWorkflowRunFromDefinition,
  type WorkflowSnapshot,
} from '@suanlizi/runtime';
import {
  THREAD_WORKFLOW_TAG,
  appendWorkflowDraftTranscript,
  WORKFLOW_COMPONENTS_KEY,
  createThreadWorkflowSnapshot,
  handleWorkflowRoute,
  loadWorkflowComponentRegistry,
  planWorkflowDefinitionSafely,
  readThreadWorkflowSnapshot,
  readWorkflowCheckpointSnapshot,
  runThreadWorkflowRuntimeAction,
  saveThreadWorkflowSnapshot,
  updateThreadWorkflowNode,
} from './workflowRoute.js';

function thread(threadId: string, tags: Record<string, string> = {}): ThreadMeta {
  return {
    threadId,
    tenantId: 'default',
    title: 'Workflow thread',
    workspaceRoot: '',
    status: 'active',
    turnCount: 0,
    createdAt: '2026-06-15T00:00:00.000Z',
    updatedAt: '2026-06-15T00:00:00.000Z',
    archivedAt: null,
    ephemeral: false,
    tags,
  };
}

class FakeStore implements Partial<ThreadStore> {
  threads = new Map<ThreadId, ThreadMeta>();
  items: ThreadItem[] = [];
  turns: TurnMeta[] = [];
  runRecords: RunRecord[] = [];
  runEvents: RunEvent[] = [];
  settings = new Map<string, unknown>();

  async getThread(threadId: ThreadId): Promise<ThreadMeta | null> {
    return this.threads.get(threadId) ?? null;
  }

  async updateThreadMetadata(threadId: ThreadId, patch: Partial<Pick<ThreadMeta, 'title' | 'status' | 'turnCount' | 'updatedAt' | 'tags'>>): Promise<void> {
    const current = this.threads.get(threadId);
    if (!current) return;
    this.threads.set(threadId, { ...current, ...patch, tags: patch.tags ?? current.tags });
  }

  async appendItems(_threadId: ThreadId, items: ThreadItem[]): Promise<void> {
    this.items.push(...items);
  }

  async getItems(): Promise<ThreadItem[]> {
    return this.items;
  }

  async getTurns(): Promise<TurnMeta[]> {
    return this.turns;
  }

  async saveTurn(turn: TurnMeta): Promise<void> {
    this.turns.push(turn);
  }

  async createRunRecord(record: RunRecord): Promise<void> {
    this.runRecords = [...this.runRecords.filter((candidate) => candidate.runId !== record.runId), record];
  }

  async updateRunRecord(runId: string, patch: Partial<RunRecord>): Promise<void> {
    this.runRecords = this.runRecords.map((record) => record.runId === runId ? { ...record, ...patch } : record);
  }

  async appendRunEvent(event: RunEvent): Promise<void> {
    this.runEvents.push(event);
  }

  async listRunRecords(): Promise<RunRecord[]> {
    return this.runRecords;
  }

  async listRunEvents(runId: string): Promise<RunEvent[]> {
    return this.runEvents.filter((event) => event.runId === runId);
  }

  async getSetting<T = unknown>(key: string): Promise<T | null> {
    return (this.settings.get(key) as T | undefined) ?? null;
  }

  async setSetting(key: string, value: unknown): Promise<void> {
    this.settings.set(key, value);
  }
}

function req(method: string, body?: unknown): IncomingMessage {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
  return Object.assign(Readable.from(chunks), { method, url: '/' }) as IncomingMessage;
}

function res(): ServerResponse & { status?: number; body?: unknown } {
  const output = {
    writeHead(status: number) {
      output.status = status;
      return output;
    },
    end(raw: string) {
      output.body = raw ? JSON.parse(raw) : undefined;
    },
  } as unknown as ServerResponse & { status?: number; body?: unknown };
  return output;
}

describe('workflow route helpers', () => {
  it('stores a thread-scoped workflow snapshot in thread tags', async () => {
    const store = new FakeStore();
    store.threads.set('t1', thread('t1', { keep: 'yes' }));
    const registry = createDefaultWorkflowComponentRegistry();
    const definition = createWorkflowDefinitionFromGoal('Release Suanlizi', registry, new Date('2026-06-15T00:00:00.000Z'));
    const snapshot: WorkflowSnapshot = {
      definition,
      run: createWorkflowRunFromDefinition(definition, new Date('2026-06-15T00:00:01.000Z'), registry),
    };

    const saved = await saveThreadWorkflowSnapshot(store as unknown as ThreadStore, 't1', snapshot, registry);
    expect(saved?.tags?.keep).toBe('yes');
    expect(saved?.tags?.[THREAD_WORKFLOW_TAG]).toContain('"definition"');
    expect(readThreadWorkflowSnapshot(saved!, registry)?.definition.goal).toBe('Release Suanlizi');
  });

  it('persists a workflow checkpoint item whenever a workflow snapshot is saved', async () => {
    const store = new FakeStore();
    store.threads.set('t1', thread('t1', { keep: 'yes' }));
    store.turns = [{
      turnId: 'turn-latest',
      threadId: 't1',
      index: 0,
      userInput: { type: 'text', text: 'plan it' },
      status: 'completed',
      startedAt: '2026-06-15T00:00:00.000Z',
      completedAt: '2026-06-15T00:00:01.000Z',
    }];
    const registry = createDefaultWorkflowComponentRegistry();
    const snapshot = createThreadWorkflowSnapshot('Checkpoint workflow', registry, new Date('2026-06-15T00:00:00.000Z'));

    await saveThreadWorkflowSnapshot(store as unknown as ThreadStore, 't1', snapshot, registry);

    expect(store.items).toEqual([
      expect.objectContaining({
        type: 'workflow_checkpoint',
        turnId: 'turn-latest',
        turnCount: 1,
        workflow: expect.objectContaining({
          definition: expect.objectContaining({ goal: 'Checkpoint workflow' }),
        }),
      }),
    ]);
  });

  it('recovers the latest workflow snapshot from checkpoint items when thread tags are missing', async () => {
    const store = new FakeStore();
    store.threads.set('t1', thread('t1', { workflowProject: 'true' }));
    const registry = createDefaultWorkflowComponentRegistry();
    const oldSnapshot = createThreadWorkflowSnapshot('Old checkpoint workflow', registry, new Date('2026-06-15T00:00:00.000Z'));
    const latestSnapshot = createThreadWorkflowSnapshot('Recovered checkpoint workflow', registry, new Date('2026-06-15T00:00:02.000Z'));
    store.items = [
      { id: 'wf_checkpoint_old', type: 'workflow_checkpoint', turnId: 'turn-1', turnCount: 1, workflow: oldSnapshot, timestamp: '2026-06-15T00:00:01.000Z' },
      { id: 'wf_checkpoint_latest', type: 'workflow_checkpoint', turnId: 'turn-2', turnCount: 2, workflow: latestSnapshot, timestamp: '2026-06-15T00:00:03.000Z' },
    ];

    expect(readWorkflowCheckpointSnapshot(store.items, registry)?.definition.goal).toBe('Recovered checkpoint workflow');

    const response = res();
    await handleWorkflowRoute({
      req: req('GET'),
      res: response,
      segments: ['api', 'threads', 't1', 'workflow'],
      store: store as unknown as ThreadStore,
      createWorkflowRegistry: () => registry,
    });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      workflow: { definition: { goal: 'Recovered checkpoint workflow' } },
      blueprint: { ok: true },
    });

    const publish = await runThreadWorkflowRuntimeAction(store as unknown as ThreadStore, 't1', { action: 'publish' }, registry, new Date('2026-06-15T00:00:04.000Z'));
    expect(publish.ok).toBe(true);
    expect(publish.workflow?.definition.goal).toBe('Recovered checkpoint workflow');
    expect(store.threads.get('t1')?.tags?.[THREAD_WORKFLOW_TAG]).toContain('Recovered checkpoint workflow');
  });

  it('saves workflow definitions as static snapshots without starting a run', async () => {
    const store = new FakeStore();
    store.threads.set('t1', thread('t1'));
    const registry = createDefaultWorkflowComponentRegistry();
    const snapshot = createThreadWorkflowSnapshot('Static workflow definition', registry, new Date('2026-06-15T00:00:00.000Z'));

    const saved = await saveThreadWorkflowSnapshot(store as unknown as ThreadStore, 't1', snapshot, registry);
    const parsed = readThreadWorkflowSnapshot(saved!, registry);

    expect(parsed?.run.status).toBe('planned');
    expect(parsed?.run.nodeRuns.every((nodeRun) => nodeRun.status === 'pending')).toBe(true);
    expect(store.items).toHaveLength(1);
    expect(store.items[0]).toMatchObject({ type: 'workflow_checkpoint' });
  });

  it('rejects missing threads and unknown workflow components', async () => {
    const store = new FakeStore();
    const registry = createDefaultWorkflowComponentRegistry();
    const snapshot = createThreadWorkflowSnapshot('Bad flow', registry, new Date('2026-06-15T00:00:00.000Z'));
    snapshot.definition.nodes[0].componentType = 'unknown_component';

    await expect(saveThreadWorkflowSnapshot(store as unknown as ThreadStore, 'missing', snapshot, registry)).resolves.toBeNull();

    store.threads.set('t1', thread('t1'));
    await expect(saveThreadWorkflowSnapshot(store as unknown as ThreadStore, 't1', snapshot, registry)).rejects.toThrow(/Unknown workflow component type/);
  });

  it('rejects saving workflow snapshots with blocking blueprint diagnostics at the route boundary', async () => {
    const store = new FakeStore();
    store.threads.set('t1', thread('t1'));
    const registry = createDefaultWorkflowComponentRegistry();
    const snapshot = createThreadWorkflowSnapshot('Invalid workflow save', registry, new Date('2026-06-15T00:00:00.000Z'));
    snapshot.definition.nodes = snapshot.definition.nodes.map((node) => node.componentType === 'start'
      ? { ...node, dependsOn: ['execute'] }
      : node);
    const response = res();

    await handleWorkflowRoute({
      req: req('PUT', { workflow: snapshot }),
      res: response,
      segments: ['api', 'threads', 't1', 'workflow'],
      store: store as unknown as ThreadStore,
      createWorkflowRegistry: () => registry,
    });

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      error: expect.stringContaining('Workflow blueprint has blocking diagnostics'),
    });
    expect(store.threads.get('t1')?.tags?.[THREAD_WORKFLOW_TAG]).toBeUndefined();
    expect(store.items).toHaveLength(0);
  });

  it('updates editable node contract fields while keeping node id and run history', async () => {
    const store = new FakeStore();
    const registry = createDefaultWorkflowComponentRegistry();
    const snapshot = createThreadWorkflowSnapshot('Implement flow', registry, new Date('2026-06-15T00:00:00.000Z'));
    snapshot.run.nodeRuns = snapshot.run.nodeRuns.map((nodeRun) => nodeRun.nodeId === 'execute'
      ? { ...nodeRun, status: 'failed', error: 'previous failure' }
      : nodeRun);
    store.threads.set('t1', thread('t1', {
      [THREAD_WORKFLOW_TAG]: JSON.stringify(snapshot),
    }));

    const saved = await updateThreadWorkflowNode(store as unknown as ThreadStore, 't1', 'execute', {
      title: 'Execute revised node',
      dependsOn: ['scope'],
      approval: 'required',
    }, registry, new Date('2026-06-15T00:00:02.000Z'));

    const parsed = readThreadWorkflowSnapshot(saved!, registry);
    expect(parsed?.definition.nodes.find((node) => node.id === 'execute')).toMatchObject({
      id: 'execute',
      title: 'Execute revised node',
      approval: 'required',
    });
    expect(parsed?.run.nodeRuns.find((nodeRun) => nodeRun.nodeId === 'execute')).toMatchObject({
      status: 'failed',
      error: 'previous failure',
    });
  });

  it('falls back to a deterministic workflow when model planning returns an invalid component', async () => {
    const registry = createDefaultWorkflowComponentRegistry();
    const planned = await planWorkflowDefinitionSafely('Read local project files', registry, {
      async chat() {
        return { choices: [{ message: { content: JSON.stringify({ nodes: [{ id: 'x', componentType: 'read_directory', title: 'Read files' }] }) } }] };
      },
    }, new Date('2026-06-15T00:00:00.000Z'));

    expect(planned.definition.nodes.map((node) => node.componentType)).toContain('tool_task');
    expect(planned.warning).toMatch(/Unknown workflow component type/);
  });

  it('keeps invalid model output useful for agent maturity comparison goals', async () => {
    const registry = createDefaultWorkflowComponentRegistry();
    const goal = '做一个 agent 代码结构成熟度对比，对比成熟对象是 E:\\langchain\\codex 和 E:\\langchain\\deer-flow-source，目标项目位置自填，对比标准是 harness 和 loop engine。';
    const planned = await planWorkflowDefinitionSafely(goal, registry, {
      async chat() {
        return { choices: [{ message: { content: 'not json' } }] };
      },
    }, new Date('2026-06-15T00:00:00.000Z'));
    const text = planned.definition.nodes.map((node) => `${node.title}\n${node.inputRequirements}\n${node.outputRequirements}`).join('\n');

    expect(planned.warning).toMatch(/Workflow planner did not return JSON/);
    expect(planned.definition.nodes.map((node) => node.id)).toEqual([
      'start',
      'confirm_scope',
      'read_reference_projects',
      'read_target_project',
      'maturity_matrix',
      'improvement_plan',
      'human_confirm',
      'end',
    ]);
    expect(planned.definition.graph).toMatchObject({ entryNodeId: 'start', terminalNodeIds: ['end'] });
    expect(text).toContain('E:\\langchain\\codex');
    expect(text).toContain('E:\\langchain\\deer-flow-source');
    expect(text).toContain('目标项目路径待用户补充');
    expect(text).toContain('harness');
    expect(text).toContain('loop engine');
    expect(compileWorkflowBlueprint(planned.definition, registry).missingInputs).toEqual(expect.arrayContaining([
      '目标项目路径待用户补充',
    ]));
  });

  it('falls back when workflow planning model does not return before the timeout', async () => {
    const registry = createDefaultWorkflowComponentRegistry();
    const planned = await planWorkflowDefinitionSafely('Read local project files', registry, {
      async chat() {
        return new Promise(() => undefined);
      },
    }, new Date('2026-06-15T00:00:00.000Z'), 1);

    expect(planned.warning).toMatch(/timed out/);
    expect(planned.definition.nodes.map((node) => node.id)).toEqual(['start', 'scope', 'execute', 'review', 'end']);
    expect(compileWorkflowBlueprint(planned.definition, registry).topology).toEqual(['start', 'scope', 'execute', 'review', 'end']);
  });

  it('persists workflow draft transcript items without saving the snapshot as current workflow', async () => {
    const store = new FakeStore();
    store.threads.set('t1', thread('t1', { workflowProject: 'true' }));
    const registry = createDefaultWorkflowComponentRegistry();
    const snapshot = createThreadWorkflowSnapshot('Draft transcript workflow', registry, new Date('2026-06-15T00:00:00.000Z'));
    snapshot.definition.nodes = snapshot.definition.nodes.map((node) => node.id === 'scope'
      ? { ...node, inputRequirements: `${node.inputRequirements}\n目标项目：目标项目路径待用户补充` }
      : node);

    const items = await appendWorkflowDraftTranscript(store as unknown as ThreadStore, 't1', 'Draft transcript workflow', snapshot, new Date('2026-06-15T00:00:02.000Z'));

    expect(store.turns).toHaveLength(1);
    expect(store.threads.get('t1')?.turnCount).toBe(1);
    expect(items.map((item) => item.type)).toEqual(['user_message', 'agent_message']);
    expect(store.items).toEqual(items);
    expect(store.threads.get('t1')?.tags?.[THREAD_WORKFLOW_TAG]).toBeUndefined();
    expect(items[1]).toMatchObject({
      type: 'agent_message',
      text: expect.stringContaining('静态蓝图，不会自动运行'),
    });
    expect(items[1]).toMatchObject({ type: 'agent_message' });
    if (items[1].type !== 'agent_message') throw new Error('expected workflow draft reply item');
    expect(items[1].text).toContain('仍需补充');
    expect(items[1].text).toContain('目标项目路径待用户补充');
  });

  it('runs, cancels, and retries workflow snapshots while writing workflow audit events', async () => {
    const store = new FakeStore();
    const registry = createDefaultWorkflowComponentRegistry();
    const snapshot = createThreadWorkflowSnapshot('Route runtime workflow', registry, new Date('2026-06-15T00:00:00.000Z'));
    snapshot.definition.nodes = snapshot.definition.nodes.map((node) => {
      if (node.id === 'execute') return { ...node, componentType: 'human_approval', approval: 'required' };
      if (node.id === 'scope' || node.id === 'review') {
        return { ...node, componentType: 'template', approval: 'none', params: { template: '{{input.goal}}' } };
      }
      return node;
    });
    snapshot.run = createWorkflowRunFromDefinition(snapshot.definition, new Date('2026-06-15T00:00:01.000Z'), registry);
    store.threads.set('t1', thread('t1', { [THREAD_WORKFLOW_TAG]: JSON.stringify(snapshot) }));

    const published = await runThreadWorkflowRuntimeAction(store as unknown as ThreadStore, 't1', { action: 'publish' }, registry, new Date('2026-06-15T00:00:02.000Z'));
    expect(published.ok).toBe(true);

    const runResult = await runThreadWorkflowRuntimeAction(store as unknown as ThreadStore, 't1', { action: 'run' }, registry, new Date('2026-06-15T00:00:02.500Z'));
    expect(runResult.ok).toBe(true);
    expect(runResult.workflow?.run.status).toBe('blocked');
    expect(store.runRecords.find((record) => record.runId === runResult.run?.id))
      .toMatchObject({ kind: 'workflow', status: 'blocked', workflowId: snapshot.definition.id });
    expect(store.runEvents.map((event) => event.type)).toEqual(expect.arrayContaining(['workflow.run.started', 'workflow.node.blocked', 'workflow.run.blocked']));

    const retryResult = await runThreadWorkflowRuntimeAction(store as unknown as ThreadStore, 't1', { action: 'retry_node', nodeId: 'execute' }, registry, new Date('2026-06-15T00:00:03.000Z'));
    expect(retryResult.error).toBeUndefined();
    expect(retryResult.ok).toBe(true);
    expect(retryResult.workflow?.run.nodeRuns.find((nodeRun) => nodeRun.nodeId === 'execute')?.status).toBe('pending');
    expect(store.runEvents.map((event) => event.type)).toContain('workflow.node.retried');

    const cancelResult = await runThreadWorkflowRuntimeAction(store as unknown as ThreadStore, 't1', { action: 'cancel' }, registry, new Date('2026-06-15T00:00:04.000Z'));
    expect(cancelResult.ok).toBe(true);
    expect(cancelResult.workflow?.run.status).toBe('cancelled');
    expect(store.runEvents.map((event) => event.type)).toContain('workflow.run.cancelled');
  });

  it('stores custom workflow components in tenant-scoped settings and exposes them through the route', async () => {
    const store = new FakeStore();
    const response = res();

    await handleWorkflowRoute({
      req: req('POST', {
        component: {
          type: 'Send Email',
          name: 'Send Email',
          description: 'Draft a project email.',
          executorKind: 'prompt',
          inputSchema: { type: 'object' },
          outputSchema: { type: 'object' },
          defaultPrompt: 'Draft email.',
        },
      }),
      res: response,
      segments: ['api', 'workflow', 'components'],
      store: store as unknown as ThreadStore,
    });

    expect(response.status).toBe(200);
    expect(store.settings.get(WORKFLOW_COMPONENTS_KEY)).toMatchObject({
      components: [expect.objectContaining({ type: 'user_send_email', sealed: false })],
    });

    const registry = await loadWorkflowComponentRegistry(store as unknown as ThreadStore);
    expect(registry.has('user_send_email')).toBe(true);
  });

  it('publishes workflows and runs the published definition while test runs leave the official run intact', async () => {
    const store = new FakeStore();
    const registry = createDefaultWorkflowComponentRegistry();
    const snapshot = createThreadWorkflowSnapshot('Publish route workflow', registry, new Date('2026-06-15T00:00:00.000Z'));
    snapshot.definition.nodes = snapshot.definition.nodes.map((node) => {
      if (node.id === 'scope' || node.id === 'execute' || node.id === 'review') {
        return { ...node, componentType: 'template', approval: 'none' as const, params: { template: `${node.id}: {{input.goal}}` } };
      }
      return node;
    });
    snapshot.run = createWorkflowRunFromDefinition(snapshot.definition, new Date('2026-06-15T00:00:01.000Z'), registry);
    store.threads.set('t1', thread('t1', { [THREAD_WORKFLOW_TAG]: JSON.stringify(snapshot) }));

    const publish = await runThreadWorkflowRuntimeAction(store as unknown as ThreadStore, 't1', { action: 'publish' }, registry, new Date('2026-06-15T00:00:02.000Z'));
    expect(publish.ok).toBe(true);
    expect(publish.workflow?.publication).toMatchObject({ status: 'published', publishedVersion: 1 });

    const draftEdited = readThreadWorkflowSnapshot(store.threads.get('t1')!, registry)!;
    draftEdited.definition.nodes = draftEdited.definition.nodes.map((node) => node.id === 'execute'
      ? { ...node, title: 'Draft edited title' }
      : node);
    store.threads.set('t1', {
      ...store.threads.get('t1')!,
      tags: { [THREAD_WORKFLOW_TAG]: JSON.stringify(draftEdited) },
    });

    const testRun = await runThreadWorkflowRuntimeAction(store as unknown as ThreadStore, 't1', { action: 'test_run' }, registry, new Date('2026-06-15T00:00:03.000Z'));
    expect(testRun.ok).toBe(true);
    expect(testRun.workflow?.publication?.lastTestRunId).toBe(testRun.run?.id);
    expect(testRun.workflow?.run.id).toBe(draftEdited.run.id);

    const officialRun = await runThreadWorkflowRuntimeAction(store as unknown as ThreadStore, 't1', { action: 'run' }, registry, new Date('2026-06-15T00:00:04.000Z'));
    expect(officialRun.ok).toBe(true);
    expect(officialRun.workflow?.run.status).toBe('completed');
    expect(officialRun.workflow?.run.nodeRuns.find((nodeRun) => nodeRun.nodeId === 'execute')?.result)
      .toBe('execute: Publish route workflow');
    expect(store.runEvents.map((event) => event.type)).toEqual(expect.arrayContaining(['workflow.run.started', 'workflow.run.completed']));
  });

  it('rejects invalid workflow blueprints before runtime execution', async () => {
    const store = new FakeStore();
    const registry = createDefaultWorkflowComponentRegistry();
    const snapshot = createThreadWorkflowSnapshot('Invalid runtime workflow', registry, new Date('2026-06-15T00:00:00.000Z'));
    snapshot.definition.nodes = snapshot.definition.nodes.map((node) => node.id === 'review'
      ? { ...node, componentType: 'unsupported_complex_node' }
      : node);
    store.threads.set('t1', thread('t1', { [THREAD_WORKFLOW_TAG]: JSON.stringify(snapshot) }));

    const result = await runThreadWorkflowRuntimeAction(store as unknown as ThreadStore, 't1', { action: 'test_run' }, registry, new Date('2026-06-15T00:00:02.000Z'));

    expect(result.ok).toBe(false);
    expect(result.code).toBe('WorkflowNotFound');
    expect(result.error).toContain('Workflow snapshot not found');
    expect(result.blueprint).toBeUndefined();
    expect(store.runRecords).toHaveLength(0);
    expect(store.runEvents).toHaveLength(0);
  });
});
