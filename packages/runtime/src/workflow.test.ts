import { describe, expect, it } from 'vitest';
import type { ToolDefinition } from '@suanlizi/tools';
import {
  assertValidWorkflowDefinition,
  blockWorkflowStep,
  compileWorkflowBlueprint,
  completeWorkflowStep,
  completeWorkflowNode,
  createDefaultWorkflowComponentRegistry,
  createToolWorkflowComponent,
  createWorkflowDefinitionFromGoal,
  createWorkflowRunFromDefinition,
  createWorkflowRun,
  createWorkflowComponentRegistryFromTools,
  createWorkflowRegistryWithUserComponents,
  executeWorkflowNode,
  failWorkflowNode,
  publishWorkflowSnapshot,
  renderWorkflowTemplate,
  resumeWorkflowRun,
  retryWorkflowNode,
  runNextWorkflowNodes,
  planWorkflowDefinitionFromGoal,
  replanWorkflow,
  runnableWorkflowNodes,
  runnableWorkflowSteps,
  startWorkflowNode,
  startWorkflowStep,
  updateWorkflowNodeContract,
  normalizeUserWorkflowComponent,
  WorkflowComponentRegistry,
} from './workflow.js';

describe('dynamic workflow runtime', () => {
  it('runs a dependency-aware DAG as a resumable state machine', () => {
    let run = createWorkflowRun('ship runtime', [
      { id: 'plan', title: 'Plan' },
      { id: 'implement', title: 'Implement', dependsOn: ['plan'] },
      { id: 'verify', title: 'Verify', dependsOn: ['implement'] },
    ], new Date('2026-06-15T00:00:00.000Z'));

    expect(runnableWorkflowSteps(run).map((step) => step.id)).toEqual(['plan']);
    run = startWorkflowStep(run, 'plan');
    run = completeWorkflowStep(run, 'plan', 'plan ready');
    expect(runnableWorkflowSteps(run).map((step) => step.id)).toEqual(['implement']);
    run = startWorkflowStep(run, 'implement');
    run = completeWorkflowStep(run, 'implement', 'code ready');
    run = startWorkflowStep(run, 'verify');
    run = completeWorkflowStep(run, 'verify', 'tests passed');

    expect(run.status).toBe('completed');
  });

  it('supports blocking and replanning without losing completed steps', () => {
    let run = createWorkflowRun('deploy', [
      { id: 'build', title: 'Build' },
      { id: 'deploy', title: 'Deploy', dependsOn: ['build'] },
    ]);
    run = completeWorkflowStep(run, 'build', 'artifact');
    run = blockWorkflowStep(run, 'deploy', 'needs approval');
    expect(run.status).toBe('blocked');

    run = replanWorkflow(run, [
      { id: 'approve', title: 'Collect approval', dependsOn: ['build'] },
      { id: 'deploy_retry', title: 'Deploy retry', dependsOn: ['approve'] },
    ]);

    expect(run.steps.find((step) => step.id === 'build')).toMatchObject({ status: 'completed' });
    expect(runnableWorkflowSteps(run).map((step) => step.id)).toEqual(['approve']);
  });

  it('registers workflow components and rejects duplicate or unknown component types', () => {
    const registry = new WorkflowComponentRegistry();
    registry.register({
      type: 'prompt_task',
      name: 'Prompt task',
      description: 'Runs a prompt',
      executorKind: 'prompt',
      inputSchema: { type: 'object' },
      outputSchema: { type: 'object' },
      defaultPrompt: 'Do the task.',
    });

    expect(() => registry.register({
      type: 'prompt_task',
      name: 'Duplicate',
      description: 'Duplicate type',
      executorKind: 'prompt',
      inputSchema: {},
      outputSchema: {},
      defaultPrompt: '',
    })).toThrow(/Duplicate workflow component type/);

    expect(() => assertValidWorkflowDefinition({
      id: 'wf_1',
      goal: 'Ship',
      version: 1,
      source: 'user',
      nodes: [{
        id: 'unknown',
        componentType: 'made_up',
        title: 'Unknown',
        prompt: '',
        inputRequirements: '',
        outputRequirements: '',
        dependsOn: [],
        approval: 'none',
      }],
      edges: [],
      createdAt: '2026-06-15T00:00:00.000Z',
      updatedAt: '2026-06-15T00:00:00.000Z',
    }, registry)).toThrow(/Unknown workflow component type/);
  });

  it('ships standard sealed workflow components and lets a planner reference dynamically registered components', () => {
    const registry = createDefaultWorkflowComponentRegistry();
    expect(registry.list().map((component) => component.type)).toEqual([
      'start',
      'end',
      'prompt_task',
      'tool_task',
      'template',
      'parameter_extractor',
      'human_approval',
    ]);

    registry.register({
      type: 'rag_task',
      name: 'RAG task',
      description: 'Retrieves context before answering',
      executorKind: 'prompt',
      inputSchema: { type: 'object' },
      outputSchema: { type: 'object' },
      defaultPrompt: 'Retrieve relevant context.',
    });
    const planned = createWorkflowDefinitionFromGoal('Build a RAG answer flow', registry, new Date('2026-06-15T00:00:00.000Z'));
    expect(planned.nodes.some((node) => node.componentType === 'rag_task')).toBe(true);
    expect(() => assertValidWorkflowDefinition(planned, registry)).not.toThrow();
  });

  it('wraps registered tools as sealed workflow components with editable params', async () => {
    const notifyTool: ToolDefinition = {
      name: 'notify_user',
      description: 'Send a project notification.',
      parameters: {
        type: 'object',
        properties: {
          channel: { type: 'string', enum: ['email', 'weixin'], description: 'Notification channel.' },
          message: { type: 'string', description: 'Message body.' },
          urgent: { type: 'boolean', description: 'Whether to mark it urgent.' },
        },
        required: ['channel', 'message'],
      },
      requiredPolicy: 'readonly',
      async execute() {
        return { output: 'sent', status: 'completed' };
      },
    };
    const toolComponent = createToolWorkflowComponent(notifyTool);

    expect(toolComponent).toMatchObject({
      type: 'tool:notify_user',
      source: 'tool',
      toolName: 'notify_user',
      executorKind: 'tool',
      sealed: true,
      requiresApproval: false,
    });
    expect(toolComponent.ui?.fields.map((field) => field.name)).toEqual(['channel', 'message', 'urgent']);
    expect(toolComponent.ui?.fields[0]).toMatchObject({ kind: 'select', required: true, options: ['email', 'weixin'] });

    const registry = createWorkflowComponentRegistryFromTools([notifyTool]);
    expect(registry.has('tool:notify_user')).toBe(true);

    const model = {
      async chat() {
        return {
          choices: [{
            message: {
              content: JSON.stringify({
                goal: 'Notify project owner',
                nodes: [{
                  id: 'notify',
                  componentType: 'tool:notify_user',
                  title: 'Notify owner',
                  prompt: 'Use the sealed notification component.',
                  inputRequirements: 'Owner channel and message.',
                  outputRequirements: 'Delivery result.',
                  dependsOn: [],
                  approval: 'none',
                  params: { channel: 'weixin', message: 'Ready for review', urgent: true },
                }],
                edges: [],
              }),
            },
          }],
        };
      },
    };

    const planned = await planWorkflowDefinitionFromGoal('Notify project owner', registry, model, new Date('2026-06-15T00:00:00.000Z'));
    expect(planned.nodes.find((node) => node.id === 'notify')).toMatchObject({
      componentType: 'tool:notify_user',
      params: { channel: 'weixin', message: 'Ready for review', urgent: true },
    });

    const edited = updateWorkflowNodeContract(planned, 'notify', {
      params: { channel: 'email', message: 'Done', urgent: false },
    }, registry, new Date('2026-06-15T00:00:01.000Z'));
    expect(edited.nodes.find((node) => node.id === 'notify')?.params).toEqual({ channel: 'email', message: 'Done', urgent: false });
  });

  it('plans workflow JSON with a model and rejects components outside the registry', async () => {
    const registry = createDefaultWorkflowComponentRegistry();
    let plannerPrompt = '';
    const model = {
      async chat(request: { messages: Array<{ role: string; content: string }> }) {
        plannerPrompt = request.messages.map((message) => message.content).join('\n');
        return {
          choices: [{
            message: {
              content: JSON.stringify({
                goal: 'Review release',
                nodes: [
                  {
                    id: 'review',
                    componentType: 'prompt_task',
                    title: 'Review',
                    prompt: 'Review the release.',
                    inputRequirements: 'Release notes',
                    outputRequirements: 'Risks',
                    dependsOn: [],
                    approval: 'none',
                  },
                ],
                edges: [],
              }),
            },
          }],
        };
      },
    };

    const planned = await planWorkflowDefinitionFromGoal('Review release', registry, model, new Date('2026-06-15T00:00:00.000Z'));
    expect(plannerPrompt).toContain('start、end、prompt_task、tool_task、template、parameter_extractor、human_approval');
    expect(plannerPrompt).not.toContain('code_task');
    expect(plannerPrompt).not.toContain('branch');
    expect(plannerPrompt).not.toContain('subagent_task');
    expect(plannerPrompt).not.toMatch(/"type":\s*"code_task"/);
    expect(plannerPrompt).not.toMatch(/"type":\s*"branch"/);
    expect(plannerPrompt).not.toMatch(/"type":\s*"loop"/);
    expect(plannerPrompt).not.toMatch(/"type":\s*"subagent_task"/);
    expect(planned.graph).toMatchObject({ entryNodeId: 'start', terminalNodeIds: ['end'] });
    expect(planned.nodes.find((node) => node.id === 'review')).toMatchObject({ id: 'review', componentType: 'prompt_task' });

    const invalidModel = {
      async chat() {
        return {
          choices: [{ message: { content: JSON.stringify({ nodes: [{ id: 'x', componentType: 'unknown', title: 'X' }] }) } }],
        };
      },
    };
    await expect(planWorkflowDefinitionFromGoal('Bad', registry, invalidModel, new Date('2026-06-15T00:00:00.000Z')))
      .rejects.toThrow(/Unknown workflow component type/);
  });

  it('creates a domain-specific agent maturity comparison workflow for local project goals', () => {
    const registry = createDefaultWorkflowComponentRegistry();
    const goal = '帮我写一个项目对比成熟 agent 项目的工作流，对比的成熟对象是 E:\\langchain\\codex 和 E:\\langchain\\deer-flow-source，目标项目位置自填，对比标准是 harness 和 loop engine 思想为主。';
    const planned = createWorkflowDefinitionFromGoal(goal, registry, new Date('2026-06-15T00:00:00.000Z'));
    const text = planned.nodes.map((node) => [
      node.title,
      node.prompt,
      node.inputRequirements,
      node.outputRequirements,
    ].join('\n')).join('\n');

    expect(planned.nodes).toHaveLength(8);
    expect(planned.nodes.map((node) => node.id)).toEqual([
      'start',
      'confirm_scope',
      'read_reference_projects',
      'read_target_project',
      'maturity_matrix',
      'improvement_plan',
      'human_confirm',
      'end',
    ]);
    expect(planned.graph).toMatchObject({ entryNodeId: 'start', terminalNodeIds: ['end'] });
    expect(planned.variables?.namespaces.sys.map((variable) => variable.name)).toEqual(expect.arrayContaining([
      'workflow_id',
      'workflow_run_id',
      'thread_id',
      'tenant_id',
      'timestamp',
      'workspace_root',
      'user_locale',
    ]));
    expect(text).toContain('E:\\langchain\\codex');
    expect(text).toContain('E:\\langchain\\deer-flow-source');
    expect(text).toContain('目标项目路径待用户补充');
    expect(text).toContain('harness');
    expect(text).toContain('loop engine');
    expect(text).not.toContain('完成这个节点的目标');
  });

  it('validates workflow dependencies and cycles before execution', () => {
    const registry = createDefaultWorkflowComponentRegistry();
    const base = createWorkflowDefinitionFromGoal('Cycle check', registry, new Date('2026-06-15T00:00:00.000Z'));

    expect(() => assertValidWorkflowDefinition({
      ...base,
      nodes: [{ ...base.nodes[0], dependsOn: ['missing'] }],
    }, registry)).toThrow(/Unknown workflow dependency/);

    expect(() => assertValidWorkflowDefinition({
      ...base,
      nodes: [
        { ...base.nodes[0], id: 'a', dependsOn: ['b'] },
        { ...base.nodes[1], id: 'b', dependsOn: ['a'] },
      ],
      edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'a' }],
      graph: undefined,
      variables: undefined,
    }, registry)).toThrow(/cycle/i);
  });

  it('validates graph start/end, reachability, loop boundaries, and variable references', () => {
    const registry = createDefaultWorkflowComponentRegistry();
    const base = createWorkflowDefinitionFromGoal('Graph kernel', registry, new Date('2026-06-15T00:00:00.000Z'));

    expect(() => assertValidWorkflowDefinition({ ...base, graph: { ...base.graph!, entryNodeId: 'scope' } }, registry))
      .toThrow(/start node/);
    expect(() => assertValidWorkflowDefinition({ ...base, graph: { ...base.graph!, terminalNodeIds: ['review'] } }, registry))
      .toThrow(/end node/);
    expect(() => assertValidWorkflowDefinition({
      ...base,
      nodes: [...base.nodes, {
        id: 'orphan',
        componentType: 'prompt_task',
        title: 'Orphan',
        prompt: 'Orphan',
        inputRequirements: '{{input.goal}}',
        outputRequirements: 'Orphan',
        dependsOn: [],
        approval: 'none',
        params: {},
      }],
    }, registry)).toThrow(/Unreachable workflow node/);
    expect(() => assertValidWorkflowDefinition({
      ...base,
      graph: { ...base.graph!, loopBoundaries: [{ loopNodeId: 'scope', bodyEntryNodeId: 'execute', bodyExitNodeId: 'review' }] },
    }, registry)).toThrow(/loop boundary/);
    expect(() => assertValidWorkflowDefinition({
      ...base,
      nodes: base.nodes.map((node) => node.id === 'scope' ? { ...node, inputRequirements: '{{missing.goal}}' } : node),
    }, registry)).toThrow(/Unknown workflow variable namespace/);
    expect(() => assertValidWorkflowDefinition({
      ...base,
      nodes: base.nodes.map((node) => node.id === 'scope' ? { ...node, inputRequirements: '{{node.missing.output}}' } : node),
    }, registry)).toThrow(/Unknown workflow node variable reference/);
  });

  it('compiles workflow blueprints into Codex-style review diagnostics without executing them', () => {
    const registry = createDefaultWorkflowComponentRegistry();
    const goal = '对比 E:\\langchain\\codex 与 E:\\langchain\\deer-flow-source，并补充目标项目路径后再输出成熟度差距。';
    const definition = createWorkflowDefinitionFromGoal(goal, registry, new Date('2026-06-15T00:00:00.000Z'));
    const compiled = compileWorkflowBlueprint(definition, registry);

    expect(compiled.ok).toBe(true);
    expect(compiled.topology[0]).toBe('start');
    expect(compiled.topology.at(-1)).toBe('end');
    expect(compiled.entryNodeIds).toEqual(['start']);
    expect(compiled.terminalNodeIds).toEqual(['end']);
    expect(compiled.referencedVariables).toEqual(expect.arrayContaining([
      'sys.workflow_id',
      'sys.timestamp',
      'input.goal',
    ]));
    expect(compiled.missingInputs.some((item) => item.includes('目标项目路径待用户补充'))).toBe(true);
    expect(compiled.diagnostics.some((item) => item.severity === 'warning' && item.code === 'missing_input')).toBe(true);
  });

  it('reports semantic blueprint warnings for lightweight template and extractor nodes', () => {
    const registry = createDefaultWorkflowComponentRegistry();
    const definition = {
      id: 'wf_semantic',
      goal: 'Review blueprint semantics',
      version: 1,
      source: 'user' as const,
      nodes: [
        { id: 'start', componentType: 'start', title: 'Start', prompt: '{{input.goal}}', inputRequirements: 'Goal', outputRequirements: 'Scope', dependsOn: [], approval: 'none' as const, params: {} },
        { id: 'template', componentType: 'template', title: 'Template', prompt: 'Render summary', inputRequirements: 'Data', outputRequirements: 'Summary', dependsOn: ['start'], approval: 'none' as const, params: { template: 'static text only' } },
        { id: 'extract', componentType: 'parameter_extractor', title: 'Extract', prompt: 'Extract params', inputRequirements: 'Free text', outputRequirements: 'Structured fields', dependsOn: ['template'], approval: 'none' as const, params: {} },
        { id: 'end', componentType: 'end', title: 'End', prompt: 'Finish', inputRequirements: 'Summary', outputRequirements: 'Done', dependsOn: ['extract'], approval: 'none' as const, params: {} },
      ],
      edges: [
        { from: 'start', to: 'template' },
        { from: 'template', to: 'extract' },
        { from: 'extract', to: 'end' },
      ],
      graph: { version: 1 as const, entryNodeId: 'start', terminalNodeIds: ['end'] },
      variables: {
        namespaces: {
          sys: [
            { namespace: 'sys' as const, name: 'workflow_id', description: 'Workflow ID', valueType: 'string' as const, readonly: true },
            { namespace: 'sys' as const, name: 'workflow_run_id', description: 'Workflow run ID', valueType: 'string' as const, readonly: true },
            { namespace: 'sys' as const, name: 'thread_id', description: 'Thread ID', valueType: 'string' as const, readonly: true },
            { namespace: 'sys' as const, name: 'tenant_id', description: 'Tenant ID', valueType: 'string' as const, readonly: true },
            { namespace: 'sys' as const, name: 'timestamp', description: 'Timestamp', valueType: 'string' as const, readonly: true },
            { namespace: 'sys' as const, name: 'workspace_root', description: 'Workspace root', valueType: 'string' as const, readonly: true },
            { namespace: 'sys' as const, name: 'user_locale', description: 'Locale', valueType: 'string' as const, readonly: true },
          ],
          input: [{ namespace: 'input' as const, name: 'goal', description: 'Goal', valueType: 'string' as const, readonly: true }],
          node: [],
          workflow: [{ namespace: 'workflow' as const, name: 'goal', description: 'Workflow goal', valueType: 'string' as const, readonly: true }],
          env: [],
        },
      },
      createdAt: '2026-06-15T00:00:00.000Z',
      updatedAt: '2026-06-15T00:00:00.000Z',
    };

    const compiled = compileWorkflowBlueprint(definition, registry);

    expect(compiled.ok).toBe(true);
    expect(compiled.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ severity: 'warning', code: 'template_variable_missing', nodeId: 'template' }),
      expect.objectContaining({ severity: 'warning', code: 'extractor_schema_missing', nodeId: 'extract' }),
    ]));
  });

  it('keeps sealed component core contracts immutable while preserving editable params and approvals', () => {
    const registry = createDefaultWorkflowComponentRegistry();
    const definition = createWorkflowDefinitionFromGoal('Prepare release', registry, new Date('2026-06-15T00:00:00.000Z'));

    expect(() => updateWorkflowNodeContract(definition, 'execute', {
      prompt: 'Use only registered components.',
      inputRequirements: 'Must include target files.',
      outputRequirements: 'Return changed files and verification output.',
    }, registry, new Date('2026-06-15T00:00:05.000Z'))).toThrow(/sealed workflow component/i);

    const edited = updateWorkflowNodeContract(definition, 'execute', {
      title: 'Execute with approval',
      approval: 'required',
      params: {},
    }, registry, new Date('2026-06-15T00:00:06.000Z'));

    expect(edited.nodes.find((node) => node.id === 'execute')).toMatchObject({
      id: 'execute',
      title: 'Execute with approval',
      approval: 'required',
    });
  });

  it('normalizes tenant user workflow components without letting them override builtins', () => {
    const builtin = createDefaultWorkflowComponentRegistry();
    const component = normalizeUserWorkflowComponent({
      type: 'Send Email',
      name: 'Send Email',
      description: 'Draft an email with project context.',
      executorKind: 'prompt',
      inputSchema: { type: 'object' },
      outputSchema: { type: 'object' },
      defaultPrompt: 'Draft a concise project email.',
      requiresApproval: true,
      ui: { fields: [{ name: 'audience', label: 'Audience', kind: 'text', required: true }] },
    }, builtin);

    expect(component).toMatchObject({
      type: 'user_send_email',
      source: 'prompt',
      sealed: false,
      requiresApproval: true,
    });

    const registry = createWorkflowRegistryWithUserComponents([component], builtin);
    expect(registry.has('user_send_email')).toBe(true);
    expect(() => normalizeUserWorkflowComponent({ ...component, type: 'prompt_task' }, builtin)).toThrow(/reserved workflow component type/);
  });

  it('requires user tool components to bind an available tool in the current registry', () => {
    const registry = createWorkflowComponentRegistryFromTools([{
      name: 'notify_user',
      description: 'Notify a user.',
      parameters: { type: 'object', properties: {} },
      requiredPolicy: 'readonly',
      async execute() {
        return { status: 'completed', output: 'ok' };
      },
    }]);

    expect(normalizeUserWorkflowComponent({
      type: 'Notify wrapper',
      name: 'Notify wrapper',
      description: 'Wraps a known tool.',
      executorKind: 'tool',
      toolName: 'notify_user',
      inputSchema: { type: 'object' },
      outputSchema: { type: 'object' },
      defaultPrompt: 'Notify.',
    }, registry)).toMatchObject({ type: 'user_notify_wrapper', toolName: 'notify_user' });

    expect(() => normalizeUserWorkflowComponent({
      type: 'Missing tool',
      name: 'Missing tool',
      description: 'Invalid tool binding.',
      executorKind: 'tool',
      toolName: 'missing_tool',
      inputSchema: { type: 'object' },
      outputSchema: { type: 'object' },
      defaultPrompt: 'Notify.',
    }, registry)).toThrow(/unknown workflow toolName/i);
  });

  it('publishes workflow snapshots without losing the editable draft definition', () => {
    const registry = createDefaultWorkflowComponentRegistry();
    const definition = createWorkflowDefinitionFromGoal('Publishable flow', registry, new Date('2026-06-15T00:00:00.000Z'));
    const workflow = {
      definition,
      run: createWorkflowRunFromDefinition(definition, new Date('2026-06-15T00:00:01.000Z'), registry),
    };

    const published = publishWorkflowSnapshot(workflow, registry, new Date('2026-06-15T00:00:02.000Z'), 'Initial release');
    const editedDraft = updateWorkflowNodeContract(published.definition, 'execute', {
      title: 'Draft-only title',
    }, registry, new Date('2026-06-15T00:00:03.000Z'));

    expect(published.publication).toMatchObject({ status: 'published', publishedVersion: 1 });
    expect(published.publishedDefinition?.id).toBe(workflow.definition.id);
    expect({ ...published, definition: editedDraft }.publishedDefinition?.nodes.find((node) => node.id === 'execute')?.title)
      .not.toBe('Draft-only title');
    expect(published.history?.[0]).toMatchObject({ version: 1, status: 'published', changelog: 'Initial release' });
  });

  it('runs template and parameter extractor nodes with guarded default semantics', async () => {
    const registry = createDefaultWorkflowComponentRegistry();
    const definition = {
      id: 'wf_lightweight',
      goal: 'Lightweight nodes',
      version: 1,
      source: 'user' as const,
      nodes: [
        { id: 'start', componentType: 'start', title: 'Start', prompt: '{{input.goal}}', inputRequirements: '', outputRequirements: '', dependsOn: [], approval: 'none' as const, params: {} },
        { id: 'render', componentType: 'template', title: 'Render', prompt: '', inputRequirements: '{{node.start.output}}', outputRequirements: '', dependsOn: ['start'], approval: 'none' as const, params: { template: '{"name":"{{input.goal}}"}' } },
        { id: 'extract', componentType: 'parameter_extractor', title: 'Extract', prompt: '', inputRequirements: '{{node.render.output}}', outputRequirements: '', dependsOn: ['render'], approval: 'none' as const, params: { schema: { type: 'object', required: ['name'] } } },
        { id: 'end', componentType: 'end', title: 'End', prompt: 'finish', inputRequirements: '{{node.extract.output}}', outputRequirements: '', dependsOn: ['extract'], approval: 'none' as const, params: {} },
      ],
      edges: [
        { from: 'start', to: 'render' },
        { from: 'render', to: 'extract' },
        { from: 'extract', to: 'end' },
      ],
      graph: {
        version: 1 as const,
        entryNodeId: 'start',
        terminalNodeIds: ['end'],
      },
      createdAt: '2026-06-15T00:00:00.000Z',
      updatedAt: '2026-06-15T00:00:00.000Z',
    };

    const result = await runNextWorkflowNodes({
      definition,
      run: createWorkflowRunFromDefinition(definition, new Date('2026-06-15T00:00:01.000Z'), registry),
      registry,
      input: { goal: 'Suanlizi' },
    });

    expect(result.run.status).toBe('completed');
    expect(result.run.nodeRuns.find((nodeRun) => nodeRun.nodeId === 'render')?.result).toBe('{"name":"Suanlizi"}');
    expect(result.run.nodeRuns.find((nodeRun) => nodeRun.nodeId === 'extract')?.result).toBe('{"name":"Suanlizi"}');
  });

  it('runs registered workflow nodes while preserving editable definition history boundaries for unsealed components', () => {
    const registry = createDefaultWorkflowComponentRegistry();
    registry.register({
      type: 'user_prompt',
      name: 'User prompt',
      description: 'Editable user prompt component.',
      executorKind: 'prompt',
      inputSchema: {},
      outputSchema: {},
      defaultPrompt: 'Run user prompt.',
      source: 'prompt',
      sealed: false,
    });
    const definition = createWorkflowDefinitionFromGoal('Prepare release', registry, new Date('2026-06-15T00:00:00.000Z'));
    definition.nodes = definition.nodes.map((node) => node.id === 'execute' ? { ...node, componentType: 'user_prompt' } : node);
    let run = createWorkflowRunFromDefinition(definition, new Date('2026-06-15T00:00:01.000Z'), registry);

    expect(runnableWorkflowNodes(definition, run).map((node) => node.id)).toEqual(['start']);
    run = startWorkflowNode(definition, run, 'start', new Date('2026-06-15T00:00:02.000Z'));
    run = completeWorkflowNode(run, 'start', 'start ready', new Date('2026-06-15T00:00:03.000Z'));
    expect(runnableWorkflowNodes(definition, run).map((node) => node.id)).toEqual(['scope']);
    run = startWorkflowNode(definition, run, 'scope', new Date('2026-06-15T00:00:03.000Z'));
    run = completeWorkflowNode(run, 'scope', 'scope ready', new Date('2026-06-15T00:00:03.500Z'));
    expect(runnableWorkflowNodes(definition, run).map((node) => node.id)).toEqual(['execute']);
    run = failWorkflowNode(run, 'execute', 'tool unavailable', new Date('2026-06-15T00:00:04.000Z'));
    expect(run.status).toBe('failed');

    const edited = updateWorkflowNodeContract(definition, 'execute', {
      title: 'Execute with stricter input',
      prompt: 'Use only registered components.',
      inputRequirements: 'Must include target files and acceptance criteria.',
      outputRequirements: 'Return changed files and verification output.',
      dependsOn: ['scope'],
      approval: 'required',
    }, registry, new Date('2026-06-15T00:00:05.000Z'));

    expect(edited.nodes.find((node) => node.id === 'execute')).toMatchObject({
      id: 'execute',
      title: 'Execute with stricter input',
      approval: 'required',
    });
    expect(run.nodeRuns.find((nodeRun) => nodeRun.nodeId === 'execute')).toMatchObject({ status: 'failed' });
  });

  it('dispatches prompt/tool/human nodes through injected executors and emits events', async () => {
    const registry = createDefaultWorkflowComponentRegistry();
    const definition = {
      ...createWorkflowDefinitionFromGoal('Execute all kinds', registry, new Date('2026-06-15T00:00:00.000Z')),
      nodes: [
        { id: 'prompt', componentType: 'prompt_task', title: 'Prompt', prompt: '', inputRequirements: '', outputRequirements: '', dependsOn: [], approval: 'none' as const },
        { id: 'tool', componentType: 'tool_task', title: 'Tool', prompt: '', inputRequirements: '', outputRequirements: '', dependsOn: ['prompt'], approval: 'none' as const },
        { id: 'human', componentType: 'human_approval', title: 'Human', prompt: '', inputRequirements: '', outputRequirements: '', dependsOn: ['tool'], approval: 'required' as const },
      ],
      edges: [
        { from: 'prompt', to: 'tool' },
        { from: 'tool', to: 'human' },
      ],
      graph: undefined,
      variables: undefined,
    };
    let run = createWorkflowRunFromDefinition(definition, new Date('2026-06-15T00:00:01.000Z'), registry);
    const emitted: string[] = [];
    const executors = {
      prompt: async () => ({ result: 'prompt ok' }),
      tool: async () => ({ result: 'tool ok' }),
      human: async () => ({ status: 'completed' as const, result: 'approved' }),
    };

    for (const nodeId of ['prompt', 'tool', 'human']) {
      const result = await executeWorkflowNode(definition, run, nodeId, executors, registry, new Date('2026-06-15T00:00:02.000Z'), (event) => emitted.push(event.type));
      run = result.run;
    }

    expect(run.status).toBe('completed');
    expect(run.nodeRuns.map((nodeRun) => nodeRun.result)).toEqual(['prompt ok', 'tool ok', 'approved']);
    expect(emitted).toContain('workflow.node.started');
    expect(emitted).toContain('workflow.node.completed');

    const blocked = await executeWorkflowNode(
      definition,
      createWorkflowRunFromDefinition(definition, new Date('2026-06-15T00:00:03.000Z'), registry),
      'prompt',
      {},
      registry,
    );
    expect(blocked.run.status).toBe('blocked');
  });

  it('refuses to execute a workflow node with a mismatched or terminal run', async () => {
    const registry = createDefaultWorkflowComponentRegistry();
    const definition = createWorkflowDefinitionFromGoal('Execute with explicit run boundary', registry, new Date('2026-06-15T00:00:00.000Z'));
    const run = createWorkflowRunFromDefinition(definition, new Date('2026-06-15T00:00:01.000Z'), registry);

    await expect(executeWorkflowNode(
      definition,
      { ...run, workflowId: 'other_workflow' },
      definition.nodes[0].id,
      { prompt: async () => ({ result: 'should not run' }) },
      registry,
    )).rejects.toThrow(/does not match workflow definition/);

    await expect(executeWorkflowNode(
      definition,
      { ...run, status: 'completed' },
      definition.nodes[0].id,
      { prompt: async () => ({ result: 'should not run' }) },
      registry,
    )).rejects.toThrow(/terminal workflow run/);
  });

  it('runs workflow DAG nodes through default executors, variables, cancellation, and retry', async () => {
    const registry = createDefaultWorkflowComponentRegistry();
    const definition = {
      ...createWorkflowDefinitionFromGoal('Render release summary', registry, new Date('2026-06-15T00:00:00.000Z')),
      nodes: [
        { id: 'start', componentType: 'start', title: 'Start', prompt: '{{input.goal}}', inputRequirements: '', outputRequirements: '', dependsOn: [], approval: 'none' as const, params: {} },
        { id: 'draft', componentType: 'prompt_task', title: 'Draft', prompt: 'Draft {{input.goal}}', inputRequirements: '{{node.start.output}}', outputRequirements: '', dependsOn: ['start'], approval: 'none' as const, params: {} },
        { id: 'summary', componentType: 'template', title: 'Summary', prompt: '', inputRequirements: '{{node.draft.output}}', outputRequirements: '', dependsOn: ['draft'], approval: 'none' as const, params: { template: 'Summary: {{node.draft.output}} / {{workflow.status}}' } },
      ],
      edges: [{ from: 'start', to: 'draft' }, { from: 'draft', to: 'summary' }],
      graph: undefined,
      variables: undefined,
    };
    let run = createWorkflowRunFromDefinition(definition, new Date('2026-06-15T00:00:01.000Z'), registry);
    const events: string[] = [];

    const first = await runNextWorkflowNodes({
      definition,
      run,
      registry,
      threadId: 'thread-1',
      tenantId: 'tenant-a',
      input: { goal: 'Render release summary' },
      executors: {
        prompt: ({ materializedInput }) => ({ result: `prompt saw ${materializedInput}` }),
      },
      emit: (event) => events.push(event.type),
    });
    run = first.run;

    expect(run.status).toBe('completed');
    expect(run.nodeRuns.find((nodeRun) => nodeRun.nodeId === 'summary')?.result).toBe('Summary: prompt saw Draft Render release summary / running');
    expect(events).toEqual(expect.arrayContaining(['workflow.run.started', 'workflow.node.started', 'workflow.node.completed', 'workflow.run.completed']));
    expect(renderWorkflowTemplate('Env {{env.SECRET}}', { definition, run, node: definition.nodes[0], input: {}, threadId: 'thread-1' })).toBe('Env ');

    const cancelled = resumeWorkflowRun({ definition, run: { ...run, status: 'running' }, action: 'cancel' });
    expect(cancelled.run.status).toBe('cancelled');
    await expect(runNextWorkflowNodes({ definition, run: cancelled.run, registry })).rejects.toThrow(/terminal workflow run/);

    const failed = failWorkflowNode(createWorkflowRunFromDefinition(definition, new Date('2026-06-15T00:00:02.000Z'), registry), 'start', 'bad input');
    const retried = retryWorkflowNode(definition, failed, 'start');
    expect(retried.status).toBe('planned');
    expect(retried.nodeRuns.find((nodeRun) => nodeRun.nodeId === 'start')).toMatchObject({ status: 'pending' });
  });
});
