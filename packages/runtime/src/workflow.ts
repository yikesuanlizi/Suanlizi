import { BUILTIN_TOOLS, type ToolDefinition, type ToolParamSchema } from '@suanlizi/tools';

export type WorkflowStepStatus = 'pending' | 'running' | 'completed' | 'failed' | 'blocked';
// Blueprint 静态流程的旧运行状态；Script Workflow 的 `WorkflowRunStatus` 已收敛到 @suanlizi/protocol/task。
// Legacy Blueprint run status; the Script-Workflow `WorkflowRunStatus` now lives in @suanlizi/protocol/task.
export type BlueprintRunStatus = 'planned' | 'running' | 'completed' | 'failed' | 'blocked' | 'cancelled';
export type WorkflowExecutorKind = 'prompt' | 'tool' | 'subagent' | 'human' | 'condition' | 'code' | 'template' | 'parameter_extractor' | 'control';
export type WorkflowApprovalMode = 'none' | 'required';
export type WorkflowComponentSource = 'builtin' | 'tool' | 'mcp' | 'skill' | 'subagent' | 'prompt';
export type WorkflowComponentFieldKind = 'text' | 'textarea' | 'number' | 'checkbox' | 'select' | 'json';
export type WorkflowVariableNamespace = 'sys' | 'input' | 'node' | 'workflow' | 'env';

export interface WorkflowComponentField {
  name: string;
  label: string;
  kind: WorkflowComponentFieldKind;
  description?: string;
  required?: boolean;
  options?: string[];
}

export interface WorkflowComponentDefinition {
  type: string;
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  defaultPrompt: string;
  executorKind: WorkflowExecutorKind;
  source?: WorkflowComponentSource;
  toolName?: string;
  sealed?: boolean;
  requiresApproval?: boolean;
  ui?: { fields: WorkflowComponentField[] };
}

export interface WorkflowNode {
  id: string;
  componentType: string;
  title: string;
  prompt: string;
  inputRequirements: string;
  outputRequirements: string;
  dependsOn: string[];
  approval: WorkflowApprovalMode;
  params?: Record<string, unknown>;
  config?: Record<string, unknown>;
}

export interface WorkflowEdge {
  from: string;
  to: string;
  condition?: string;
}

export interface WorkflowGraphDefinition {
  version: 1;
  entryNodeId: string;
  terminalNodeIds: string[];
  loopBoundaries?: Array<{ loopNodeId: string; bodyEntryNodeId: string; bodyExitNodeId: string }>;
}

export interface WorkflowLayoutDefinition {
  nodes?: Record<string, { x: number; y: number }>;
  viewport?: { x: number; y: number; scale: number };
}

export interface WorkflowVariableDefinition {
  namespace: WorkflowVariableNamespace;
  name: string;
  description: string;
  valueType: 'string' | 'number' | 'boolean' | 'json' | 'array' | 'object';
  sensitive?: boolean;
  readonly?: boolean;
}

export interface WorkflowVariablePool {
  namespaces: Record<WorkflowVariableNamespace, WorkflowVariableDefinition[]>;
}

export interface WorkflowDefinition {
  id: string;
  goal: string;
  version: number;
  source: 'model' | 'user' | 'template';
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  graph?: WorkflowGraphDefinition;
  ui?: { layout?: WorkflowLayoutDefinition };
  variables?: WorkflowVariablePool;
  createdAt: string;
  updatedAt: string;
}

export interface WorkflowNodeRun {
  nodeId: string;
  status: WorkflowStepStatus;
  result?: string;
  error?: string;
  blockedReason?: string;
  startedAt?: string;
  completedAt?: string;
  retryCount?: number;
}

export interface WorkflowExecutionRun {
  id: string;
  workflowId: string;
  goal: string;
  status: BlueprintRunStatus;
  nodeRuns: WorkflowNodeRun[];
  createdAt: string;
  updatedAt: string;
}

export interface WorkflowSnapshot {
  definition: WorkflowDefinition;
  run: WorkflowExecutionRun;
  publishedDefinition?: WorkflowDefinition | null;
  publication?: {
    status: 'draft' | 'published';
    publishedVersion?: number;
    publishedAt?: string;
    lastTestRunId?: string;
  };
  history?: WorkflowVersionSummary[];
}

export interface WorkflowVersionSummary {
  version: number;
  status: 'draft' | 'published' | 'test';
  changelog?: string;
  definitionId: string;
  runId?: string;
  createdAt: string;
}

export interface WorkflowEvent {
  type:
    | 'workflow.run.started'
    | 'workflow.run.completed'
    | 'workflow.run.failed'
    | 'workflow.run.blocked'
    | 'workflow.run.cancelled'
    | 'workflow.node.started'
    | 'workflow.node.completed'
    | 'workflow.node.failed'
    | 'workflow.node.blocked'
    | 'workflow.node.retried'
    | 'workflow.updated';
  workflowId: string;
  runId?: string;
  nodeId?: string;
  timestamp: string;
  detail?: string;
}

export interface WorkflowBlueprintDiagnostic {
  severity: 'error' | 'warning' | 'info';
  code: string;
  message: string;
  nodeId?: string;
}

export interface WorkflowBlueprintCompileResult {
  ok: boolean;
  diagnostics: WorkflowBlueprintDiagnostic[];
  entryNodeIds: string[];
  terminalNodeIds: string[];
  topology: string[];
  runnableNodeIds: string[];
  missingInputs: string[];
  referencedVariables: string[];
}

export interface WorkflowNodeExecutorContext {
  definition: WorkflowDefinition;
  run: WorkflowExecutionRun;
  node: WorkflowNode;
  component: WorkflowComponentDefinition;
  previousResults: Record<string, string>;
  threadId?: string;
  tenantId?: string;
  runId?: string;
  input?: Record<string, unknown>;
  variables?: Record<string, unknown>;
  materializedInput?: string;
  emitEvent?: (event: WorkflowEvent) => void;
}

export interface WorkflowNodeExecutorResult {
  status?: 'completed' | 'failed' | 'blocked';
  result?: string;
  error?: string;
  blockedReason?: string;
}

export type WorkflowNodeExecutor = (ctx: WorkflowNodeExecutorContext) => Promise<WorkflowNodeExecutorResult> | WorkflowNodeExecutorResult;

export type WorkflowNodeExecutors = Partial<Record<WorkflowExecutorKind, WorkflowNodeExecutor>>;

export type WorkflowRuntimeAction = 'run' | 'run_node' | 'test_run' | 'publish' | 'resume' | 'cancel' | 'retry_node';

export interface WorkflowRuntimeContext {
  threadId?: string;
  tenantId?: string;
  input?: Record<string, unknown>;
  variables?: Record<string, unknown>;
}

export interface WorkflowRuntimeOptions extends WorkflowRuntimeContext {
  definition: WorkflowDefinition;
  run: WorkflowExecutionRun;
  nodeId?: string;
  action?: WorkflowRuntimeAction;
  executors?: WorkflowNodeExecutors;
  registry?: WorkflowComponentRegistry;
  now?: Date;
  emit?: (event: WorkflowEvent) => void;
}

export interface WorkflowRuntimeResult {
  workflow: WorkflowSnapshot;
  run: WorkflowExecutionRun;
  events: WorkflowEvent[];
}

export interface WorkflowPlannerModel {
  chat(request: {
    messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
    tool_choice?: 'none';
    max_tokens?: number;
    temperature?: number;
  }): Promise<{ choices: Array<{ message?: { content?: unknown } }> }>;
}

export class WorkflowComponentRegistry {
  private readonly components = new Map<string, WorkflowComponentDefinition>();

  register(component: WorkflowComponentDefinition): this {
    const type = normalizeComponentType(component.type);
    if (!type) throw new Error('Workflow component type is required');
    if (this.components.has(type)) throw new Error(`Duplicate workflow component type: ${type}`);
    this.components.set(type, { ...component, type });
    return this;
  }

  has(type: string): boolean {
    return this.components.has(normalizeComponentType(type));
  }

  get(type: string): WorkflowComponentDefinition | undefined {
    return this.components.get(normalizeComponentType(type));
  }

  list(): WorkflowComponentDefinition[] {
    return [...this.components.values()];
  }
}

export function createDefaultWorkflowComponentRegistry(): WorkflowComponentRegistry {
  return new WorkflowComponentRegistry()
    .register({
      type: 'start',
      name: 'Start',
      description: 'Workflow entry node. It declares initial inputs and starts the visual flow.',
      executorKind: 'control',
      source: 'builtin',
      sealed: true,
      inputSchema: { type: 'object', additionalProperties: true },
      outputSchema: { type: 'object', additionalProperties: true },
      defaultPrompt: '声明流程入口、初始输入和启动条件；本节点不执行业务动作。',
    })
    .register({
      type: 'end',
      name: 'End',
      description: 'Workflow terminal node. It defines normal or exceptional completion.',
      executorKind: 'control',
      source: 'builtin',
      sealed: true,
      inputSchema: { type: 'object', additionalProperties: true },
      outputSchema: { type: 'object', additionalProperties: true },
      defaultPrompt: '汇总上游结果并声明流程终止条件；本节点不执行业务动作。',
    })
    .register({
      type: 'prompt_task',
      name: 'Prompt task',
      description: 'Run a focused model prompt and produce a textual result.',
      executorKind: 'prompt',
      source: 'prompt',
      sealed: true,
      inputSchema: { type: 'object', additionalProperties: true },
      outputSchema: { type: 'object', additionalProperties: true },
      defaultPrompt: '完成这个节点的目标，严格遵守输入要求和输出要求。',
    })
    .register({
      type: 'tool_task',
      name: 'Tool task',
      description: 'Call registered tools through runtime governance.',
      executorKind: 'tool',
      source: 'builtin',
      sealed: true,
      inputSchema: { type: 'object', additionalProperties: true },
      outputSchema: { type: 'object', additionalProperties: true },
      defaultPrompt: '选择必要工具完成任务，避免重复调用。',
    })
    .register({
      type: 'template',
      name: 'Template',
      description: 'Render text from workflow variables using a sealed template contract.',
      executorKind: 'template',
      source: 'builtin',
      sealed: true,
      inputSchema: { type: 'object', additionalProperties: true },
      outputSchema: { type: 'object', additionalProperties: true },
      defaultPrompt: '根据变量引用渲染模板文本；当前版本只保存模板契约。',
      ui: { fields: [{ name: 'template', label: 'template', kind: 'textarea', description: 'Template using {{namespace.name}} references.' }] },
    })
    .register({
      type: 'parameter_extractor',
      name: 'Parameter extractor',
      description: 'Extract structured parameters from user input or upstream node output.',
      executorKind: 'parameter_extractor',
      source: 'builtin',
      sealed: true,
      inputSchema: { type: 'object', additionalProperties: true },
      outputSchema: { type: 'object', additionalProperties: true },
      defaultPrompt: '从输入中抽取结构化参数并写明字段来源、缺失项和置信度。',
      ui: { fields: [{ name: 'schema', label: 'schema', kind: 'json', description: 'Expected extracted parameter schema.' }] },
    })
    .register({
      type: 'human_approval',
      name: 'Human approval',
      description: 'Pause for human approval or clarification.',
      executorKind: 'human',
      source: 'builtin',
      sealed: true,
      inputSchema: { type: 'object', additionalProperties: true },
      outputSchema: { type: 'object', additionalProperties: true },
      defaultPrompt: '等待用户确认后再继续。',
      requiresApproval: true,
    });
}

export function createToolWorkflowComponent(tool: ToolDefinition): WorkflowComponentDefinition {
  return {
    type: `tool:${tool.name}`,
    name: tool.name,
    description: tool.description,
    executorKind: 'tool',
    source: 'tool',
    toolName: tool.name,
    sealed: true,
    requiresApproval: tool.requiresApproval === true,
    inputSchema: tool.parameters as unknown as Record<string, unknown>,
    outputSchema: { type: 'object', additionalProperties: true },
    defaultPrompt: `使用已注册工具 ${tool.name} 完成该节点。只填写组件参数，不生成或执行任意未注册代码。`,
    ui: { fields: fieldsFromToolSchema(tool.parameters) },
  };
}

export function createWorkflowComponentRegistryFromTools(
  tools: ToolDefinition[],
  base: WorkflowComponentRegistry = createDefaultWorkflowComponentRegistry(),
): WorkflowComponentRegistry {
  for (const tool of tools) base.register(createToolWorkflowComponent(tool));
  return base;
}

const USER_COMPONENT_EXECUTORS: WorkflowExecutorKind[] = ['prompt', 'template', 'parameter_extractor', 'human', 'tool'];

export function normalizeUserWorkflowComponent(
  component: WorkflowComponentDefinition,
  base: WorkflowComponentRegistry = createDefaultWorkflowComponentRegistry(),
): WorkflowComponentDefinition {
  const rawType = normalizeComponentType(component.type || component.name || '');
  const slug = rawType
    .toLowerCase()
    .replace(/[^a-z0-9_:-]+/g, '_')
    .replace(/^_+|_+$/g, '');
  const type = slug.startsWith('user_') ? slug : `user_${slug}`;
  if (!/^user_[a-z0-9_:-]+$/.test(type)) throw new Error('User workflow component type is invalid');
  const requested = normalizeComponentType(component.type);
  if (base.has(requested) || requested.startsWith('tool:') || requested === 'start' || requested === 'end') {
    throw new Error(`reserved workflow component type cannot be overridden: ${requested}`);
  }
  if (!USER_COMPONENT_EXECUTORS.includes(component.executorKind)) {
    throw new Error(`Unsupported user workflow executor: ${component.executorKind}`);
  }
  if (component.executorKind === 'tool' && !component.toolName?.trim()) {
    throw new Error('Tool workflow components require a toolName');
  }
  if (component.executorKind === 'tool' && !workflowRegistryHasToolName(base, component.toolName)) {
    throw new Error(`Unknown workflow toolName: ${component.toolName}`);
  }
  return {
    type,
    name: component.name?.trim() || type,
    description: component.description?.trim() || component.name?.trim() || type,
    executorKind: component.executorKind,
    source: component.executorKind === 'tool' ? 'tool' : component.source ?? 'prompt',
    toolName: component.toolName?.trim() || undefined,
    sealed: false,
    requiresApproval: component.requiresApproval === true,
    inputSchema: component.inputSchema && typeof component.inputSchema === 'object' ? component.inputSchema : { type: 'object' },
    outputSchema: component.outputSchema && typeof component.outputSchema === 'object' ? component.outputSchema : { type: 'object' },
    defaultPrompt: component.defaultPrompt?.trim() || component.description?.trim() || component.name?.trim() || type,
    ui: component.ui?.fields ? { fields: component.ui.fields.map(normalizeWorkflowComponentField) } : undefined,
  };
}

function workflowRegistryHasToolName(registry: WorkflowComponentRegistry, toolName?: string): boolean {
  const normalized = toolName?.trim();
  if (!normalized) return false;
  return registry.list().some((component) => (
    component.executorKind === 'tool'
    && (component.toolName === normalized || component.type === `tool:${normalized}`)
  ));
}

export function createWorkflowRegistryWithUserComponents(
  components: WorkflowComponentDefinition[],
  base: WorkflowComponentRegistry = createBuiltinWorkflowComponentRegistry(),
): WorkflowComponentRegistry {
  for (const component of components) {
    const normalized = normalizeUserWorkflowComponent(component, base);
    if (base.has(normalized.type)) throw new Error(`Duplicate workflow component type: ${normalized.type}`);
    base.register(normalized);
  }
  return base;
}

export function createBuiltinWorkflowComponentRegistry(): WorkflowComponentRegistry {
  return createWorkflowComponentRegistryFromTools(BUILTIN_TOOLS, createDefaultWorkflowComponentRegistry());
}

export interface WorkflowStep {
  id: string;
  title: string;
  dependsOn: string[];
  status: WorkflowStepStatus;
  result?: string;
  error?: string;
}

export interface WorkflowRun {
  id: string;
  goal: string;
  status: BlueprintRunStatus;
  steps: WorkflowStep[];
  createdAt: string;
  updatedAt: string;
}

export function createWorkflowDefinitionFromGoal(
  goal: string,
  registry: WorkflowComponentRegistry = createDefaultWorkflowComponentRegistry(),
  now = new Date(),
): WorkflowDefinition {
  if (isAgentMaturityComparisonGoal(goal)) {
    return createAgentMaturityComparisonWorkflowDefinition(goal, registry, now);
  }
  const componentTypes = registry.list().map((component) => component.type);
  const goalLower = goal.toLowerCase();
  const preferredExecuteType = componentTypes.find((type) => goalLower.includes(type.replace(/_task$/, '').replace(/_/g, ' ')))
    ?? componentTypes.find((type) => type !== 'prompt_task' && type.endsWith('_task'))
    ?? 'tool_task';
  const scopeComponent = registry.get('prompt_task') ?? registry.list()[0];
  const executeComponent = registry.get(preferredExecuteType) ?? scopeComponent;
  const reviewComponent = registry.get('human_approval') ?? scopeComponent;
  const startComponent = registry.get('start') ?? scopeComponent;
  const endComponent = registry.get('end') ?? scopeComponent;
  const timestamp = now.toISOString();
  const id = `workflow_def_${now.getTime()}_${Math.random().toString(36).slice(2, 8)}`;
  const definition: WorkflowDefinition = {
    id,
    goal,
    version: 1,
    source: 'model',
    nodes: [
      {
        id: 'start',
        componentType: startComponent.type,
        title: '开始',
        prompt: '声明工作流入口、用户目标和可用上下文；不执行工具或代码。',
        inputRequirements: '输入变量：{{input.goal}}；系统变量：{{sys.workflow_id}}、{{sys.thread_id}}、{{sys.timestamp}}。',
        outputRequirements: '输出初始上下文摘要、缺失输入和后续节点可引用的边界。',
        dependsOn: [],
        approval: 'none',
        params: defaultParamsForComponent(startComponent),
      },
      {
        id: 'scope',
        componentType: scopeComponent.type,
        title: '拆解目标与输入',
        prompt: '把用户目标拆成任务边界、已知输入、缺失信息和验收标准。',
        inputRequirements: '读取 {{input.goal}} 和 start 节点输出；保留用户原始约束，不扩大范围。',
        outputRequirements: '输出任务边界、验收条件和后续节点需要的上下文。',
        dependsOn: ['start'],
        approval: 'none',
        params: defaultParamsForComponent(scopeComponent),
      },
      {
        id: 'execute',
        componentType: executeComponent.type,
        title: '执行核心任务',
        prompt: executeComponent.defaultPrompt,
        inputRequirements: '读取 {{node.scope.output}}，只使用已注册组件和已治理工具。',
        outputRequirements: '输出执行结果、关键产物和需要用户确认的变更。',
        dependsOn: ['scope'],
        approval: executeComponent.requiresApproval ? 'required' : 'none',
        params: defaultParamsForComponent(executeComponent),
      },
      {
        id: 'review',
        componentType: reviewComponent.type,
        title: '确认与收口',
        prompt: reviewComponent.defaultPrompt,
        inputRequirements: '读取 {{node.execute.output}}，确认是否满足 {{input.goal}}。',
        outputRequirements: '输出确认结论、未完成事项和下一步。',
        dependsOn: ['execute'],
        approval: reviewComponent.requiresApproval ? 'required' : 'none',
        params: defaultParamsForComponent(reviewComponent),
      },
      {
        id: 'end',
        componentType: endComponent.type,
        title: '结束',
        prompt: '汇总流程结果并声明正常结束或异常结束条件；不自动执行后续动作。',
        inputRequirements: '读取 {{node.review.output}}。',
        outputRequirements: '输出最终交付摘要、风险、未完成事项和 checkpoint 说明。',
        dependsOn: ['review'],
        approval: 'none',
        params: defaultParamsForComponent(endComponent),
      },
    ],
    edges: [
      { from: 'start', to: 'scope' },
      { from: 'scope', to: 'execute' },
      { from: 'execute', to: 'review' },
      { from: 'review', to: 'end' },
    ],
    graph: createWorkflowGraph('start', ['end']),
    variables: createWorkflowVariablePool({ workflowId: id, timestamp, goal }),
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  assertValidWorkflowDefinition(definition, registry);
  return definition;
}

export async function planWorkflowDefinitionFromGoal(
  goal: string,
  registry: WorkflowComponentRegistry = createDefaultWorkflowComponentRegistry(),
  model?: WorkflowPlannerModel,
  now = new Date(),
): Promise<WorkflowDefinition> {
  if (!model) return createWorkflowDefinitionFromGoal(goal, registry, now);
  const components = registry.list().map((component) => ({
    type: component.type,
    name: component.name,
    description: component.description,
    executorKind: component.executorKind,
    source: component.source,
    toolName: component.toolName,
    sealed: component.sealed === true,
    requiresApproval: component.requiresApproval === true,
    defaultPrompt: component.defaultPrompt,
    inputSchema: component.inputSchema,
    outputSchema: component.outputSchema,
    ui: component.ui,
  }));
  const response = await model.chat({
    messages: [
      {
        role: 'system',
        content: [
          '你是 Suanlizi workflow planner。根据用户目标生成一个线程级可视化 workflow JSON。',
          '只能使用 components 清单里的 component type；不要发明组件；不要输出解释文字；组件是封装好的，不要生成代码。',
          '优先生成图形蓝图，不要假设会立即执行；工作流必须可审阅、可保存、可回退。',
          '可以使用标准组件 start、end、prompt_task、tool_task、template、parameter_extractor、human_approval。',
          '不要生成代码执行、分支、循环或子 agent 节点；需要复杂逻辑时拆成多个线性轻量节点和人工确认。',
          '输入契约中优先使用变量引用，如 {{input.goal}}、{{node.some_id.output}}、{{sys.timestamp}}。',
          '节点必须贴合用户领域目标，标题、prompt、inputRequirements、outputRequirements 都要写成具体执行契约，禁止使用“完成这个节点的目标”这类空泛占位句。',
          '如果目标涉及本地项目目录对比、Agent 成熟度、harness engine、loop engine，要拆成确认对象与标准、读取参考项目、读取目标项目、成熟度矩阵、改造计划、人工确认等专门节点。',
          'JSON 字段：goal, nodes, edges。node 字段：id, componentType, title, prompt, inputRequirements, outputRequirements, dependsOn, approval, params。edges 可带 condition。',
          'params 必须只包含组件 inputSchema/ui.fields 中声明的参数；没有参数时使用空对象。',
          'approval 只能是 none 或 required。edges 使用 from/to。',
        ].join('\n'),
      },
      {
        role: 'user',
        content: JSON.stringify({ goal, components }, null, 2),
      },
    ],
    tool_choice: 'none',
    max_tokens: 1800,
    temperature: 0.2,
  });
  const text = String(response.choices[0]?.message?.content ?? '');
  const json = extractJsonObject(text);
  if (!json) throw new Error('Workflow planner did not return JSON');
  const timestamp = now.toISOString();
  const definition: WorkflowDefinition = {
    id: typeof json.id === 'string' && json.id.trim()
      ? json.id.trim()
      : `workflow_def_${now.getTime()}_${Math.random().toString(36).slice(2, 8)}`,
    goal: typeof json.goal === 'string' && json.goal.trim() ? json.goal.trim() : goal,
    version: typeof json.version === 'number' ? json.version : 1,
    source: 'model',
    nodes: normalizePlannedNodes(json.nodes),
    edges: normalizePlannedEdges(json.edges),
    createdAt: typeof json.createdAt === 'string' ? json.createdAt : timestamp,
    updatedAt: timestamp,
  };
  const next = withWorkflowGraphKernel(definition, registry, now);
  assertValidWorkflowDefinition(next, registry);
  return next;
}

export function assertValidWorkflowDefinition(
  definition: WorkflowDefinition,
  registry: WorkflowComponentRegistry = createDefaultWorkflowComponentRegistry(),
): void {
  if (!definition.id.trim()) throw new Error('Workflow definition id is required');
  if (!definition.goal.trim()) throw new Error('Workflow goal is required');
  const ids = new Set<string>();
  for (const node of definition.nodes) {
    if (!node.id.trim()) throw new Error('Workflow node id is required');
    if (ids.has(node.id)) throw new Error(`Duplicate workflow node id: ${node.id}`);
    ids.add(node.id);
    if (!registry.has(node.componentType)) throw new Error(`Unknown workflow component type: ${node.componentType}`);
    assertValidNodeParams(node, registry.get(node.componentType));
  }
  for (const node of definition.nodes) {
    for (const dependency of node.dependsOn) {
      if (!ids.has(dependency)) throw new Error(`Unknown workflow dependency: ${dependency}`);
    }
  }
  for (const edge of definition.edges) {
    if (!ids.has(edge.from)) throw new Error(`Unknown workflow edge source: ${edge.from}`);
    if (!ids.has(edge.to)) throw new Error(`Unknown workflow edge target: ${edge.to}`);
  }
  assertAcyclic(definition.nodes);
  assertValidWorkflowGraph(definition);
  assertValidWorkflowVariables(definition);
}

export function createWorkflowRunFromDefinition(
  definition: WorkflowDefinition,
  now = new Date(),
  registry: WorkflowComponentRegistry = createDefaultWorkflowComponentRegistry(),
): WorkflowExecutionRun {
  assertValidWorkflowDefinition(definition, registry);
  const timestamp = now.toISOString();
  return {
    id: `workflow_run_${now.getTime()}_${Math.random().toString(36).slice(2, 8)}`,
    workflowId: definition.id,
    goal: definition.goal,
    status: definition.nodes.length === 0 ? 'completed' : 'planned',
    nodeRuns: definition.nodes.map((node) => ({ nodeId: node.id, status: 'pending' })),
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

export function compileWorkflowBlueprint(
  definition: WorkflowDefinition,
  registry: WorkflowComponentRegistry = createDefaultWorkflowComponentRegistry(),
): WorkflowBlueprintCompileResult {
  const diagnostics: WorkflowBlueprintDiagnostic[] = [];
  try {
    assertValidWorkflowDefinition(definition, registry);
  } catch (error) {
    diagnostics.push({
      severity: 'error',
      code: 'invalid_definition',
      message: error instanceof Error ? error.message : String(error),
    });
  }

  const outgoing = buildOutgoingEdges(definition.edges);
  let topology: string[] = [];
  try {
    topology = deriveWorkflowTopology(definition);
  } catch (error) {
    diagnostics.push({
      severity: 'error',
      code: 'dependency_cycle',
      message: error instanceof Error ? error.message : String(error),
    });
  }
  const referencedVariables = [...new Set(definition.nodes.flatMap((node) => extractWorkflowVariableRefs([
    node.prompt,
    node.inputRequirements,
    node.outputRequirements,
    JSON.stringify(node.params ?? {}),
  ].join('\n'))))];
  const missingInputs = collectWorkflowMissingInputs(definition);

  for (const node of definition.nodes) {
    if (node.componentType === 'start' && node.dependsOn.length > 0) {
      diagnostics.push({
        severity: 'error',
        code: 'start_has_dependencies',
        nodeId: node.id,
        message: `Start node must not depend on prior nodes: ${node.id}`,
      });
    }
    if (node.componentType === 'end' && (outgoing.get(node.id)?.length ?? 0) > 0) {
      diagnostics.push({
        severity: 'error',
        code: 'end_has_outgoing',
        nodeId: node.id,
        message: `End node must not have outgoing edges: ${node.id}`,
      });
    }
    if (node.componentType === 'template') {
      const templateText = typeof node.params?.template === 'string' ? node.params.template : '';
      if (extractWorkflowVariableRefs(templateText).length === 0) {
        diagnostics.push({
          severity: 'warning',
          code: 'template_variable_missing',
          nodeId: node.id,
          message: `Template node should reference workflow variables in its template body: ${node.id}`,
        });
      }
    }
    if (node.componentType === 'parameter_extractor') {
      const hasSchemaParam = ['schema', 'jsonSchema', 'outputSchema', 'fields']
        .some((name) => node.params?.[name] !== undefined && String(node.params?.[name] ?? '').trim() !== '');
      if (!hasSchemaParam) {
        diagnostics.push({
          severity: 'warning',
          code: 'extractor_schema_missing',
          nodeId: node.id,
          message: `Parameter extractor should declare a target schema or fields contract: ${node.id}`,
        });
      }
    }
  }

  for (const missingInput of missingInputs) {
    diagnostics.push({
      severity: 'warning',
      code: 'missing_input',
      message: missingInput,
    });
  }

  return {
    ok: diagnostics.every((item) => item.severity !== 'error'),
    diagnostics,
    entryNodeIds: definition.graph ? [definition.graph.entryNodeId] : definition.nodes.filter((node) => node.dependsOn.length === 0).map((node) => node.id),
    terminalNodeIds: definition.graph?.terminalNodeIds ?? definition.nodes.filter((node) => (outgoing.get(node.id)?.length ?? 0) === 0).map((node) => node.id),
    topology,
    runnableNodeIds: definition.nodes.filter((node) => node.dependsOn.length === 0).map((node) => node.id),
    missingInputs,
    referencedVariables,
  };
}

export function runnableWorkflowNodes(definition: WorkflowDefinition, run: WorkflowExecutionRun): WorkflowNode[] {
  const completed = new Set(run.nodeRuns.filter((nodeRun) => nodeRun.status === 'completed').map((nodeRun) => nodeRun.nodeId));
  const byNode = new Map(run.nodeRuns.map((nodeRun) => [nodeRun.nodeId, nodeRun]));
  return definition.nodes.filter((node) => {
    const state = byNode.get(node.id);
    return state?.status === 'pending' && node.dependsOn.every((dependency) => completed.has(dependency));
  });
}

export function startWorkflowNode(
  definition: WorkflowDefinition,
  run: WorkflowExecutionRun,
  nodeId: string,
  now = new Date(),
): WorkflowExecutionRun {
  if (!runnableWorkflowNodes(definition, run).some((node) => node.id === nodeId)) {
    throw new Error(`Workflow node is not runnable: ${nodeId}`);
  }
  return updateWorkflowNodeRun(run, nodeId, { status: 'running', startedAt: now.toISOString() }, now, 'running');
}

export function completeWorkflowNode(
  run: WorkflowExecutionRun,
  nodeId: string,
  result: string,
  now = new Date(),
): WorkflowExecutionRun {
  const next = updateWorkflowNodeRun(run, nodeId, {
    status: 'completed',
    result,
    completedAt: now.toISOString(),
  }, now);
  return { ...next, status: next.nodeRuns.every((nodeRun) => nodeRun.status === 'completed') ? 'completed' : 'running' };
}

export function failWorkflowNode(run: WorkflowExecutionRun, nodeId: string, error: string, now = new Date()): WorkflowExecutionRun {
  return updateWorkflowNodeRun(run, nodeId, { status: 'failed', error, completedAt: now.toISOString() }, now, 'failed');
}

export function blockWorkflowNode(run: WorkflowExecutionRun, nodeId: string, reason: string, now = new Date()): WorkflowExecutionRun {
  return updateWorkflowNodeRun(run, nodeId, { status: 'blocked', blockedReason: reason }, now, 'blocked');
}

export async function executeWorkflowNode(
  definition: WorkflowDefinition,
  run: WorkflowExecutionRun,
  nodeId: string,
  executors: WorkflowNodeExecutors = {},
  registry: WorkflowComponentRegistry = createDefaultWorkflowComponentRegistry(),
  now = new Date(),
  emit?: (event: WorkflowEvent) => void,
  runtimeContext: WorkflowRuntimeContext = {},
): Promise<{ run: WorkflowExecutionRun; events: WorkflowEvent[] }> {
  assertValidWorkflowDefinition(definition, registry);
  assertExecutableWorkflowRun(definition, run);
  const node = definition.nodes.find((candidate) => candidate.id === nodeId);
  if (!node) throw new Error(`Unknown workflow node: ${nodeId}`);
  const component = registry.get(node.componentType);
  if (!component) throw new Error(`Unknown workflow component type: ${node.componentType}`);
  let next = startWorkflowNode(definition, run, nodeId, now);
  const events: WorkflowEvent[] = [];
  const publish = (event: WorkflowEvent): void => {
    events.push(event);
    emit?.(event);
  };
  publish({ type: 'workflow.node.started', workflowId: definition.id, runId: run.id, nodeId, timestamp: now.toISOString() });

  const executor = executors[component.executorKind];
  if (!executor) {
    const reason = `No workflow executor registered for ${component.executorKind}`;
    next = blockWorkflowNode(next, nodeId, reason, now);
    publish({ type: 'workflow.node.blocked', workflowId: definition.id, runId: run.id, nodeId, timestamp: now.toISOString(), detail: reason });
    return { run: next, events };
  }

  try {
    const timeoutMs = typeof node.config?.timeoutMs === 'number' ? node.config.timeoutMs : 120000;
    const result = await Promise.race([
      executor({
        definition,
        run: next,
        node,
        component,
        previousResults: previousWorkflowResults(definition, next, node),
        threadId: runtimeContext.threadId,
        tenantId: runtimeContext.tenantId,
        runId: next.id,
        input: runtimeContext.input,
        variables: runtimeContext.variables,
        materializedInput: renderWorkflowTemplate(node.prompt || node.inputRequirements || '', {
          definition,
          run: next,
          node,
          input: runtimeContext.input,
          variables: runtimeContext.variables,
          threadId: runtimeContext.threadId,
          tenantId: runtimeContext.tenantId,
        }),
        emitEvent: publish,
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`Workflow node ${nodeId} timed out after ${timeoutMs}ms`)), timeoutMs),
      ),
    ]);
    if (result.status === 'blocked') {
      const reason = result.blockedReason ?? result.error ?? 'Workflow node blocked';
      next = blockWorkflowNode(next, nodeId, reason, now);
      publish({ type: 'workflow.node.blocked', workflowId: definition.id, runId: run.id, nodeId, timestamp: now.toISOString(), detail: reason });
      return { run: next, events };
    }
    if (result.status === 'failed') {
      const error = result.error ?? 'Workflow node failed';
      next = failWorkflowNode(next, nodeId, error, now);
      publish({ type: 'workflow.node.failed', workflowId: definition.id, runId: run.id, nodeId, timestamp: now.toISOString(), detail: error });
      return { run: next, events };
    }
    next = completeWorkflowNode(next, nodeId, result.result ?? '', now);
    publish({ type: 'workflow.node.completed', workflowId: definition.id, runId: run.id, nodeId, timestamp: now.toISOString(), detail: result.result });
    return { run: next, events };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    next = failWorkflowNode(next, nodeId, message, now);
    publish({ type: 'workflow.node.failed', workflowId: definition.id, runId: run.id, nodeId, timestamp: now.toISOString(), detail: message });
    return { run: next, events };
  }
}

function assertExecutableWorkflowRun(definition: WorkflowDefinition, run: WorkflowExecutionRun): void {
  if (run.workflowId !== definition.id) {
    throw new Error(`Workflow run ${run.id} does not match workflow definition ${definition.id}`);
  }
  if (run.status === 'completed' || run.status === 'failed' || run.status === 'blocked' || run.status === 'cancelled') {
    throw new Error(`Cannot execute terminal workflow run ${run.id} with status ${run.status}`);
  }
}

export async function runNextWorkflowNodes(options: WorkflowRuntimeOptions): Promise<WorkflowRuntimeResult> {
  const registry = options.registry ?? createDefaultWorkflowComponentRegistry();
  assertValidWorkflowDefinition(options.definition, registry);
  assertExecutableWorkflowRun(options.definition, options.run);
  const events: WorkflowEvent[] = [];
  const emit = (event: WorkflowEvent): void => {
    events.push(event);
    options.emit?.(event);
  };
  let run = options.run.status === 'planned'
    ? { ...options.run, status: 'running' as const, updatedAt: (options.now ?? new Date()).toISOString() }
    : options.run;
  if (options.run.status === 'planned') {
    emit({
      type: 'workflow.run.started',
      workflowId: options.definition.id,
      runId: run.id,
      timestamp: run.updatedAt,
      detail: options.definition.goal,
    });
  }
  const executors = { ...createDefaultWorkflowNodeExecutors(), ...(options.executors ?? {}) };
  const runtimeContext: WorkflowRuntimeContext = {
    threadId: options.threadId,
    tenantId: options.tenantId,
    input: options.input ?? { goal: options.definition.goal },
    variables: options.variables,
  };

  while (run.status === 'running') {
    const runnable = options.nodeId
      ? runnableWorkflowNodes(options.definition, run).filter((node) => node.id === options.nodeId)
      : runnableWorkflowNodes(options.definition, run);
    if (!runnable.length) break;
    if (runnable.length === 1) {
      const result = await executeWorkflowNode(options.definition, run, runnable[0].id, executors, registry, options.now ?? new Date(), emit, runtimeContext);
      run = result.run;
      if (run.status === 'failed' || run.status === 'blocked' || run.status === 'completed') break;
    } else {
      const results = await Promise.all(
        runnable.map((node) => executeWorkflowNode(options.definition, run, node.id, executors, registry, options.now ?? new Date(), emit, runtimeContext)),
      );
      const nodeRunMap = new Map<string, { status: WorkflowStepStatus; result?: string; error?: string; blockedReason?: string; startedAt?: string; completedAt?: string }>();
      for (const result of results) {
        for (const nodeRun of result.run.nodeRuns) {
          const existing = nodeRunMap.get(nodeRun.nodeId);
          if (!existing || (existing.status === 'pending' && nodeRun.status !== 'pending')) {
            nodeRunMap.set(nodeRun.nodeId, nodeRun);
          }
        }
      }
      run = {
        ...run,
        nodeRuns: run.nodeRuns.map((nr) => nodeRunMap.has(nr.nodeId) ? { ...nr, ...nodeRunMap.get(nr.nodeId)! } : nr),
        updatedAt: (options.now ?? new Date()).toISOString(),
      };
      const hasFailed = results.some((r) => r.run.status === 'failed');
      const hasBlocked = results.some((r) => r.run.status === 'blocked');
      if (hasFailed) {
        run = { ...run, status: 'failed' };
      } else if (hasBlocked) {
        run = { ...run, status: 'blocked' };
      } else if (run.nodeRuns.every((nr) => nr.status === 'completed')) {
        run = { ...run, status: 'completed' };
      }
      if (run.status === 'failed' || run.status === 'blocked' || run.status === 'completed') break;
    }
  }

  emitTerminalWorkflowRunEvent(options.definition, run, emit, options.now ?? new Date());
  return { workflow: { definition: options.definition, run }, run, events };
}

export async function runWorkflowNode(options: WorkflowRuntimeOptions & { nodeId: string }): Promise<WorkflowRuntimeResult> {
  return runNextWorkflowNodes({ ...options, action: 'run_node' });
}

export function resumeWorkflowRun(options: {
  definition: WorkflowDefinition;
  run: WorkflowExecutionRun;
  action?: 'resume' | 'cancel';
  now?: Date;
  emit?: (event: WorkflowEvent) => void;
}): WorkflowRuntimeResult {
  const now = options.now ?? new Date();
  if (options.action === 'cancel') {
    const run = {
      ...options.run,
      status: 'cancelled' as const,
      updatedAt: now.toISOString(),
      completedAt: now.toISOString(),
    };
    const event: WorkflowEvent = {
      type: 'workflow.run.cancelled',
      workflowId: options.definition.id,
      runId: run.id,
      timestamp: now.toISOString(),
      detail: options.definition.goal,
    };
    options.emit?.(event);
    return { workflow: { definition: options.definition, run }, run, events: [event] };
  }
  if (options.run.status !== 'blocked') {
    throw new Error(`Cannot resume workflow run ${options.run.id} with status ${options.run.status}`);
  }
  const run = {
    ...options.run,
    status: 'running' as const,
    updatedAt: now.toISOString(),
    nodeRuns: options.run.nodeRuns.map((nodeRun) => nodeRun.status === 'blocked'
      ? { ...nodeRun, status: 'pending' as const, blockedReason: undefined }
      : nodeRun),
  };
  const event: WorkflowEvent = {
    type: 'workflow.run.started',
    workflowId: options.definition.id,
    runId: run.id,
    timestamp: now.toISOString(),
    detail: 'Workflow resumed',
  };
  options.emit?.(event);
  return { workflow: { definition: options.definition, run }, run, events: [event] };
}

export function retryWorkflowNode(
  definition: WorkflowDefinition,
  run: WorkflowExecutionRun,
  nodeId: string,
  now = new Date(),
  emit?: (event: WorkflowEvent) => void,
): WorkflowExecutionRun {
  const target = run.nodeRuns.find((nodeRun) => nodeRun.nodeId === nodeId);
  if (!target) throw new Error(`Unknown workflow node run: ${nodeId}`);
  if (target.status !== 'failed' && target.status !== 'blocked') {
    throw new Error(`Workflow node is not retryable: ${nodeId}`);
  }
  const node = definition.nodes.find((candidate) => candidate.id === nodeId);
  const maxRetries = typeof node?.config?.maxRetries === 'number' ? node.config.maxRetries : 3;
  const currentRetries = target.retryCount ?? 0;
  if (currentRetries >= maxRetries) {
    throw new Error(`Workflow node ${nodeId} exceeded max retries (${maxRetries})`);
  }
  const descendants = workflowNodeDescendants(definition, nodeId);
  const resetIds = new Set([nodeId, ...descendants]);
  const next = {
    ...run,
    status: 'planned' as const,
    updatedAt: now.toISOString(),
    nodeRuns: run.nodeRuns.map((nodeRun) => resetIds.has(nodeRun.nodeId)
      ? { nodeId: nodeRun.nodeId, status: 'pending' as const, retryCount: nodeRun.nodeId === nodeId ? currentRetries + 1 : (nodeRun.retryCount ?? 0) }
      : nodeRun),
  };
  emit?.({
    type: 'workflow.node.retried',
    workflowId: definition.id,
    runId: run.id,
    nodeId,
    timestamp: now.toISOString(),
    detail: 'Workflow node reset for retry',
  });
  return next;
}

export function renderWorkflowTemplate(template: string, context: {
  definition: WorkflowDefinition;
  run: WorkflowExecutionRun;
  node: WorkflowNode;
  input?: Record<string, unknown>;
  variables?: Record<string, unknown>;
  threadId?: string;
  tenantId?: string;
}): string {
  return template.replace(/\{\{\s*([A-Za-z_][\w-]*(?:\.[A-Za-z_][\w-]*){1,2})\s*\}\}/g, (_match, ref: string) => {
    const [namespace, first, second] = ref.split('.');
    if (namespace === 'env') return '';
    if (namespace === 'sys') {
      const sys: Record<string, unknown> = {
        workflow_id: context.definition.id,
        workflow_run_id: context.run.id,
        thread_id: context.threadId ?? '',
        tenant_id: context.tenantId ?? '',
        timestamp: context.run.updatedAt,
      };
      return stringifyWorkflowValue(sys[first] ?? context.variables?.[`sys.${first}`]);
    }
    if (namespace === 'input') return stringifyWorkflowValue(context.input?.[first]);
    if (namespace === 'workflow') {
      const workflow: Record<string, unknown> = { status: context.run.status, goal: context.definition.goal, version: context.definition.version };
      return stringifyWorkflowValue(workflow[first] ?? context.variables?.[`workflow.${first}`]);
    }
    if (namespace === 'node') {
      const nodeRun = context.run.nodeRuns.find((candidate) => candidate.nodeId === first);
      if (!nodeRun || nodeRun.status !== 'completed') return '';
      if (!second || second === 'output' || second === 'result') return stringifyWorkflowValue(nodeRun.result);
      if (second === 'error') return stringifyWorkflowValue(nodeRun.error);
      return '';
    }
    return stringifyWorkflowValue(context.variables?.[ref]);
  });
}

function extractWorkflowParameters(input: string, schema: unknown): string {
  const parsed = parseWorkflowJsonObject(input);
  const output = parsed ?? {};
  const required = schema && typeof schema === 'object' && Array.isArray((schema as { required?: unknown }).required)
    ? (schema as { required: unknown[] }).required.filter((item): item is string => typeof item === 'string')
    : [];
  const missing = required.filter((key) => !(key in output));
  if (missing.length) {
    return JSON.stringify({ ...output, _missing: missing });
  }
  return JSON.stringify(output);
}

function parseWorkflowJsonObject(input: string): Record<string, unknown> | null {
  const trimmed = input.trim();
  if (!trimmed) return {};
  const candidates = [
    trimmed,
    trimmed.match(/\{[\s\S]*\}/)?.[0] ?? '',
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch {
      // try the next candidate
    }
  }
  return null;
}

function createDefaultWorkflowNodeExecutors(): WorkflowNodeExecutors {
  return {
    template: ({ definition, run, node, input, variables, threadId, tenantId }) => ({
      result: renderWorkflowTemplate(typeof node.params?.template === 'string' ? node.params.template : node.prompt, {
        definition,
        run,
        node,
        input,
        variables,
        threadId,
        tenantId,
      }),
    }),
    parameter_extractor: ({ node, materializedInput }) => ({
      result: extractWorkflowParameters(materializedInput || node.prompt || node.inputRequirements, node.params?.schema),
    }),
    control: ({ node, materializedInput }) => ({ result: materializedInput || node.outputRequirements || node.title }),
    human: () => ({ status: 'blocked', blockedReason: 'Workflow node is waiting for human approval.' }),
    prompt: () => ({ status: 'blocked', blockedReason: 'No workflow prompt executor registered.' }),
    tool: () => ({ status: 'blocked', blockedReason: 'No governed workflow tool executor registered.' }),
  };
}

function emitTerminalWorkflowRunEvent(
  definition: WorkflowDefinition,
  run: WorkflowExecutionRun,
  emit: (event: WorkflowEvent) => void,
  now: Date,
): void {
  const type = run.status === 'completed'
    ? 'workflow.run.completed'
    : run.status === 'failed'
      ? 'workflow.run.failed'
      : run.status === 'blocked'
        ? 'workflow.run.blocked'
        : null;
  if (!type) return;
  emit({
    type,
    workflowId: definition.id,
    runId: run.id,
    timestamp: now.toISOString(),
    detail: definition.goal,
  });
}

function workflowNodeDescendants(definition: WorkflowDefinition, nodeId: string): string[] {
  const outgoing = buildOutgoingEdges(definition.edges);
  const seen = new Set<string>();
  const visit = (id: string): void => {
    for (const next of outgoing.get(id) ?? []) {
      if (seen.has(next)) continue;
      seen.add(next);
      visit(next);
    }
    for (const node of definition.nodes) {
      if (!node.dependsOn.includes(id) || seen.has(node.id)) continue;
      seen.add(node.id);
      visit(node.id);
    }
  };
  visit(nodeId);
  return [...seen];
}

function stringifyWorkflowValue(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

export function updateWorkflowNodeContract(
  definition: WorkflowDefinition,
  nodeId: string,
  patch: Partial<Pick<WorkflowNode, 'title' | 'prompt' | 'inputRequirements' | 'outputRequirements' | 'dependsOn' | 'approval' | 'params'>>,
  registry: WorkflowComponentRegistry = createDefaultWorkflowComponentRegistry(),
  now = new Date(),
): WorkflowDefinition {
  const current = definition.nodes.find((node) => node.id === nodeId);
  if (!current) throw new Error(`Unknown workflow node: ${nodeId}`);
  assertPatchAllowedForWorkflowNode(current, patch, registry);
  const next: WorkflowDefinition = {
    ...definition,
    version: definition.version + 1,
    updatedAt: now.toISOString(),
    nodes: definition.nodes.map((node) => node.id === nodeId ? {
      ...node,
      ...definedPatch(patch),
      id: node.id,
      componentType: node.componentType,
    } : node),
  };
  assertValidWorkflowDefinition(next, registry);
  return next;
}

function assertPatchAllowedForWorkflowNode(
  node: WorkflowNode,
  patch: Partial<Pick<WorkflowNode, 'title' | 'prompt' | 'inputRequirements' | 'outputRequirements' | 'dependsOn' | 'approval' | 'params'>>,
  registry: WorkflowComponentRegistry,
): void {
  const component = registry.get(node.componentType);
  if (component?.sealed !== true) return;
  const blocked = ['prompt', 'inputRequirements', 'outputRequirements'] as const;
  for (const key of blocked) {
    if (patch[key] !== undefined && patch[key] !== node[key]) {
      throw new Error(`Cannot edit core contract field "${key}" on sealed workflow component ${node.componentType}; clone it as a user component first.`);
    }
  }
}

export function normalizeWorkflowSnapshot(
  snapshot: WorkflowSnapshot,
  registry: WorkflowComponentRegistry = createDefaultWorkflowComponentRegistry(),
): WorkflowSnapshot {
  assertValidWorkflowDefinition(snapshot.definition, registry);
  if (snapshot.publishedDefinition) assertValidWorkflowDefinition(snapshot.publishedDefinition, registry);
  const existing = new Map(snapshot.run.nodeRuns.map((nodeRun) => [nodeRun.nodeId, nodeRun]));
  return {
    definition: snapshot.definition,
    run: {
      ...snapshot.run,
      workflowId: snapshot.definition.id,
      goal: snapshot.definition.goal,
      nodeRuns: snapshot.definition.nodes.map((node) => existing.get(node.id) ?? { nodeId: node.id, status: 'pending' }),
    },
    publishedDefinition: snapshot.publishedDefinition ?? null,
    publication: snapshot.publication ?? { status: snapshot.publishedDefinition ? 'published' : 'draft' },
    history: snapshot.history ?? [],
  };
}

export function publishWorkflowSnapshot(
  snapshot: WorkflowSnapshot,
  registry: WorkflowComponentRegistry = createDefaultWorkflowComponentRegistry(),
  now = new Date(),
  changelog = 'Published workflow definition',
): WorkflowSnapshot {
  const normalized = normalizeWorkflowSnapshot(snapshot, registry);
  const blueprint = compileWorkflowBlueprint(normalized.definition, registry);
  if (!blueprint.ok) {
    const errors = blueprint.diagnostics.filter((item) => item.severity === 'error').map((item) => item.message);
    throw new Error(`Cannot publish workflow with blocking diagnostics: ${errors.join('; ') || 'unknown error'}`);
  }
  const publishedVersion = (normalized.publication?.publishedVersion ?? 0) + 1;
  const publishedAt = now.toISOString();
  return {
    ...normalized,
    publishedDefinition: { ...normalized.definition, updatedAt: publishedAt },
    publication: {
      ...normalized.publication,
      status: 'published',
      publishedVersion,
      publishedAt,
    },
    history: [
      ...(normalized.history ?? []),
      {
        version: publishedVersion,
        status: 'published',
        changelog,
        definitionId: normalized.definition.id,
        runId: normalized.run.id,
        createdAt: publishedAt,
      },
    ],
  };
}

export function createWorkflowRun(goal: string, steps: Array<{ id?: string; title: string; dependsOn?: string[] }>, now = new Date()): WorkflowRun {
  const ids = new Set<string>();
  const workflowSteps = steps.map((step, index) => {
    const id = step.id ?? `step_${index + 1}`;
    if (ids.has(id)) throw new Error(`Duplicate workflow step id: ${id}`);
    ids.add(id);
    return {
      id,
      title: step.title,
      dependsOn: step.dependsOn ?? [],
      status: 'pending' as const,
    };
  });
  for (const step of workflowSteps) {
    for (const dependency of step.dependsOn) {
      if (!ids.has(dependency)) throw new Error(`Unknown workflow dependency: ${dependency}`);
    }
  }
  return {
    id: `workflow_${now.getTime()}_${Math.random().toString(36).slice(2, 8)}`,
    goal,
    status: workflowSteps.length === 0 ? 'completed' : 'planned',
    steps: workflowSteps,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };
}

export function runnableWorkflowSteps(run: WorkflowRun): WorkflowStep[] {
  const completed = new Set(run.steps.filter((step) => step.status === 'completed').map((step) => step.id));
  return run.steps.filter((step) => (
    step.status === 'pending'
    && step.dependsOn.every((dependency) => completed.has(dependency))
  ));
}

export function startWorkflowStep(run: WorkflowRun, stepId: string, now = new Date()): WorkflowRun {
  const step = findStep(run, stepId);
  if (!runnableWorkflowSteps(run).some((candidate) => candidate.id === stepId)) {
    throw new Error(`Workflow step is not runnable: ${stepId}`);
  }
  return updateWorkflowStep(run, step.id, { status: 'running' }, now, 'running');
}

export function completeWorkflowStep(run: WorkflowRun, stepId: string, result: string, now = new Date()): WorkflowRun {
  const next = updateWorkflowStep(run, stepId, { status: 'completed', result }, now);
  return { ...next, status: next.steps.every((step) => step.status === 'completed') ? 'completed' : 'running' };
}

export function failWorkflowStep(run: WorkflowRun, stepId: string, error: string, now = new Date()): WorkflowRun {
  return updateWorkflowStep(run, stepId, { status: 'failed', error }, now, 'failed');
}

export function blockWorkflowStep(run: WorkflowRun, stepId: string, reason: string, now = new Date()): WorkflowRun {
  return updateWorkflowStep(run, stepId, { status: 'blocked', error: reason }, now, 'blocked');
}

export function replanWorkflow(
  run: WorkflowRun,
  additions: Array<{ id?: string; title: string; dependsOn?: string[] }>,
  now = new Date(),
): WorkflowRun {
  const existing = new Set(run.steps.map((step) => step.id));
  const newSteps = additions.map((step, index) => {
    const id = step.id ?? `step_${run.steps.length + index + 1}`;
    if (existing.has(id)) throw new Error(`Duplicate workflow step id: ${id}`);
    existing.add(id);
    return {
      id,
      title: step.title,
      dependsOn: step.dependsOn ?? [],
      status: 'pending' as const,
    };
  });
  for (const step of newSteps) {
    for (const dependency of step.dependsOn) {
      if (!existing.has(dependency)) throw new Error(`Unknown workflow dependency: ${dependency}`);
    }
  }
  return {
    ...run,
    status: run.status === 'completed' && newSteps.length > 0 ? 'running' : run.status,
    steps: [...run.steps, ...newSteps],
    updatedAt: now.toISOString(),
  };
}

function updateWorkflowStep(
  run: WorkflowRun,
  stepId: string,
  patch: Partial<WorkflowStep>,
  now: Date,
  status = run.status,
): WorkflowRun {
  findStep(run, stepId);
  return {
    ...run,
    status,
    steps: run.steps.map((step) => step.id === stepId ? { ...step, ...patch } : step),
    updatedAt: now.toISOString(),
  };
}

function findStep(run: WorkflowRun, stepId: string): WorkflowStep {
  const step = run.steps.find((candidate) => candidate.id === stepId);
  if (!step) throw new Error(`Unknown workflow step: ${stepId}`);
  return step;
}

function fieldsFromToolSchema(schema: ToolParamSchema): WorkflowComponentField[] {
  const required = new Set(schema.required ?? []);
  const properties = schema.properties ?? {};
  return Object.entries(properties).map(([name, property]) => ({
    name,
    label: name,
    kind: fieldKindFromSchema(property),
    description: property.description,
    required: required.has(name),
    options: property.enum,
  }));
}

function fieldKindFromSchema(schema: ToolParamSchema): WorkflowComponentFieldKind {
  if (schema.enum && schema.enum.length > 0) return 'select';
  if (schema.type === 'boolean') return 'checkbox';
  if (schema.type === 'number' || schema.type === 'integer') return 'number';
  if (schema.type === 'array' || schema.type === 'object') return 'json';
  const description = schema.description?.toLowerCase() ?? '';
  return description.includes('content') || description.includes('body') || description.includes('message')
    ? 'textarea'
    : 'text';
}

function defaultParamsForComponent(component: WorkflowComponentDefinition): Record<string, unknown> {
  if (!component.ui?.fields.length) return {};
  return Object.fromEntries(component.ui.fields.map((field) => [field.name, defaultValueForField(field)]));
}

function isAgentMaturityComparisonGoal(goal: string): boolean {
  const lower = goal.toLowerCase();
  const comparesProjects = /对比|比较|compare|benchmark/.test(lower);
  const agentContext = /agent|智能体|项目|代码结构|架构/.test(lower);
  const maturityContext = /成熟度|maturity|harness|loop engine|runtime|运行时/.test(lower);
  return comparesProjects && agentContext && maturityContext;
}

function createAgentMaturityComparisonWorkflowDefinition(
  goal: string,
  registry: WorkflowComponentRegistry,
  now: Date,
): WorkflowDefinition {
  const promptComponent = registry.get('prompt_task') ?? registry.list()[0];
  const toolComponent = registry.get('tool_task') ?? promptComponent;
  const humanComponent = registry.get('human_approval') ?? promptComponent;
  const timestamp = now.toISOString();
  const paths = extractLocalPaths(goal);
  const referenceProjects = paths.slice(0, 2);
  const referencesText = referenceProjects.length
    ? referenceProjects.join('、')
    : '成熟参考项目路径待用户补充';
  const targetProject = paths[2] ?? '目标项目路径待用户补充';
  const definition: WorkflowDefinition = {
    id: `workflow_def_${now.getTime()}_${Math.random().toString(36).slice(2, 8)}`,
    goal,
    version: 1,
    source: 'model',
    nodes: [
      {
        id: 'confirm_scope',
        componentType: promptComponent.type,
        title: '确认对比对象与标准',
        prompt: '从用户目标中抽取成熟参考项目、目标项目路径和评价标准；缺失信息必须明确标为待补充，不要自行编造路径。',
        inputRequirements: `用户目标：${goal}\n成熟参考项目：${referencesText}\n目标项目：${targetProject}\n核心标准：harness engine、loop engine、运行时边界、工具治理、检查点/恢复、子 agent 生命周期。`,
        outputRequirements: '输出对比范围、路径清单、评价维度、缺失输入和验收条件，供后续读取目录节点使用。',
        dependsOn: [],
        approval: 'none',
        params: defaultParamsForComponent(promptComponent),
      },
      {
        id: 'read_reference_projects',
        componentType: toolComponent.type,
        title: '读取成熟参考项目结构',
        prompt: '使用已注册文件/搜索工具读取成熟参考项目的目录结构和关键源码入口，只做结构摘要，不改文件。',
        inputRequirements: `读取参考项目：${referencesText}\n关注 agent loop、runtime/harness、工具调用、审批、checkpoint/rollout、middleware、workflow/graph、测试目录。`,
        outputRequirements: '输出每个参考项目的关键目录、核心入口文件、AgentLoop/Runtime/Harness 相关实现位置和可借鉴模式。',
        dependsOn: ['confirm_scope'],
        approval: toolComponent.requiresApproval ? 'required' : 'none',
        params: defaultParamsForComponent(toolComponent),
      },
      {
        id: 'read_target_project',
        componentType: toolComponent.type,
        title: '读取目标项目结构',
        prompt: '读取目标项目目录结构和关键源码入口；如果目标项目路径缺失，先把节点标记为需要用户补充，不继续猜测。',
        inputRequirements: `目标项目：${targetProject}\n读取范围：运行时入口、AgentLoop、工具注册与治理、checkpoint/持久化、子 agent、workflow、测试与配置。`,
        outputRequirements: '输出目标项目当前结构摘要、关键文件位置、已具备能力和明显缺口。',
        dependsOn: ['confirm_scope'],
        approval: toolComponent.requiresApproval ? 'required' : 'none',
        params: defaultParamsForComponent(toolComponent),
      },
      {
        id: 'maturity_matrix',
        componentType: promptComponent.type,
        title: '建立 harness / loop engine 成熟度矩阵',
        prompt: '基于参考项目和目标项目摘要，按维度建立成熟度矩阵；每一项都要给证据位置、成熟度判断和差距说明。',
        inputRequirements: '输入 read_reference_projects 与 read_target_project 的结构摘要；评价维度必须覆盖 harness engine、loop engine、middleware、工具治理、checkpoint、子 agent 生命周期、可观测、测试。',
        outputRequirements: '输出表格式成熟度矩阵：维度、参考项目做法、目标项目现状、差距、风险、优先级。',
        dependsOn: ['read_reference_projects', 'read_target_project'],
        approval: 'none',
        params: defaultParamsForComponent(promptComponent),
      },
      {
        id: 'improvement_plan',
        componentType: promptComponent.type,
        title: '输出差距与改造计划',
        prompt: '把成熟度矩阵转成可执行改造计划，按风险和依赖排序，区分短期边界修正与中长期工作流/runtime 演进。',
        inputRequirements: '输入 maturity_matrix 的差距、风险、优先级；不要扩展到登录、市场、复杂低代码平台等当前范围外内容。',
        outputRequirements: '输出分阶段改造计划、每阶段目标、涉及模块、测试验收和不做事项。',
        dependsOn: ['maturity_matrix'],
        approval: 'none',
        params: defaultParamsForComponent(promptComponent),
      },
      {
        id: 'human_confirm',
        componentType: humanComponent.type,
        title: '人工确认执行范围',
        prompt: '等待用户确认目标项目路径、评价标准和是否按改造计划执行；用户未确认前不进入实际代码修改。',
        inputRequirements: '输入 improvement_plan 的建议和 confirm_scope 中的缺失项。',
        outputRequirements: '输出用户确认的执行范围、取消项、补充路径和下一步动作。',
        dependsOn: ['improvement_plan'],
        approval: humanComponent.requiresApproval ? 'required' : 'none',
        params: defaultParamsForComponent(humanComponent),
      },
    ],
    edges: [
      { from: 'confirm_scope', to: 'read_reference_projects' },
      { from: 'confirm_scope', to: 'read_target_project' },
      { from: 'read_reference_projects', to: 'maturity_matrix' },
      { from: 'read_target_project', to: 'maturity_matrix' },
      { from: 'maturity_matrix', to: 'improvement_plan' },
      { from: 'improvement_plan', to: 'human_confirm' },
    ],
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  const next = withWorkflowGraphKernel(definition, registry, now);
  assertValidWorkflowDefinition(next, registry);
  return next;
}

function withWorkflowGraphKernel(
  definition: WorkflowDefinition,
  registry: WorkflowComponentRegistry,
  now: Date,
): WorkflowDefinition {
  if (definition.graph?.version === 1 && definition.variables) return definition;
  const timestamp = now.toISOString();
  const fallback = registry.list()[0];
  const startComponent = registry.get('start') ?? fallback;
  const endComponent = registry.get('end') ?? fallback;
  if (!startComponent || !endComponent) return definition;
  const hasStart = definition.nodes.some((node) => node.id === 'start');
  const hasEnd = definition.nodes.some((node) => node.id === 'end');
  const originalNodes = definition.nodes;
  const originalIds = new Set(originalNodes.map((node) => node.id));
  const outgoing = new Set(definition.edges.map((edge) => edge.from));
  const roots = originalNodes.filter((node) => !node.dependsOn.length && node.id !== 'start' && node.id !== 'end').map((node) => node.id);
  const terminals = originalNodes
    .filter((node) => !outgoing.has(node.id) && node.id !== 'start' && node.id !== 'end')
    .map((node) => node.id);
  const nodes = [
    ...(!hasStart ? [{
      id: 'start',
      componentType: startComponent.type,
      title: '开始',
      prompt: '声明工作流入口、用户目标和可用上下文；不执行工具或代码。',
      inputRequirements: '输入变量：{{input.goal}}；系统变量：{{sys.workflow_id}}、{{sys.thread_id}}、{{sys.timestamp}}。',
      outputRequirements: '输出初始上下文摘要、缺失输入和后续节点可引用的边界。',
      dependsOn: [],
      approval: 'none' as const,
      params: defaultParamsForComponent(startComponent),
    }] : []),
    ...originalNodes.map((node) => (
      !hasStart && roots.includes(node.id)
        ? { ...node, dependsOn: ['start', ...node.dependsOn] }
        : node
    )),
    ...(!hasEnd ? [{
      id: 'end',
      componentType: endComponent.type,
      title: '结束',
      prompt: '汇总流程结果并声明正常结束或异常结束条件；不自动执行后续动作。',
      inputRequirements: terminals.length ? terminals.map((id) => `{{node.${id}.output}}`).join('\n') : '{{input.goal}}',
      outputRequirements: '输出最终交付摘要、风险、未完成事项和 checkpoint 说明。',
      dependsOn: terminals.length ? terminals : roots,
      approval: 'none' as const,
      params: defaultParamsForComponent(endComponent),
    }] : []),
  ];
  const edges = [
    ...definition.edges,
    ...(!hasStart ? roots.filter((id) => originalIds.has(id)).map((id) => ({ from: 'start', to: id })) : []),
    ...(!hasEnd ? terminals.filter((id) => originalIds.has(id)).map((id) => ({ from: id, to: 'end' })) : []),
  ];
  return {
    ...definition,
    nodes,
    edges,
    graph: createWorkflowGraph('start', ['end']),
    variables: createWorkflowVariablePool({ workflowId: definition.id, timestamp, goal: definition.goal }),
  };
}

function createWorkflowGraph(entryNodeId: string, terminalNodeIds: string[]): WorkflowGraphDefinition {
  return { version: 1, entryNodeId, terminalNodeIds };
}

function createWorkflowVariablePool(options: { workflowId: string; timestamp: string; goal: string }): WorkflowVariablePool {
  return {
    namespaces: {
      sys: [
        { namespace: 'sys', name: 'workflow_id', description: `Workflow definition id ${options.workflowId}`, valueType: 'string', readonly: true },
        { namespace: 'sys', name: 'workflow_run_id', description: 'Workflow run id assigned when a run is created.', valueType: 'string', readonly: true },
        { namespace: 'sys', name: 'thread_id', description: 'Owning Suanlizi thread id.', valueType: 'string', readonly: true },
        { namespace: 'sys', name: 'tenant_id', description: 'Tenant id scope; never contains account ids or secrets.', valueType: 'string', readonly: true },
        { namespace: 'sys', name: 'timestamp', description: `Workflow planning timestamp ${options.timestamp}`, valueType: 'string', readonly: true },
        { namespace: 'sys', name: 'workspace_root', description: 'Workspace root path summary for the thread.', valueType: 'string', readonly: true },
        { namespace: 'sys', name: 'user_locale', description: 'User interface locale.', valueType: 'string', readonly: true },
      ],
      input: [
        { namespace: 'input', name: 'goal', description: `Original workflow goal: ${options.goal}`, valueType: 'string', readonly: true },
      ],
      node: [],
      workflow: [
        { namespace: 'workflow', name: 'status', description: 'Workflow blueprint or run status.', valueType: 'string', readonly: true },
      ],
      env: [],
    },
  };
}

function assertValidWorkflowGraph(definition: WorkflowDefinition): void {
  if (!definition.graph) return;
  const ids = new Set(definition.nodes.map((node) => node.id));
  if (definition.graph.version !== 1) throw new Error('Unsupported workflow graph version');
  const entry = definition.nodes.find((node) => node.id === definition.graph?.entryNodeId);
  if (!entry || entry.componentType !== 'start') throw new Error('Workflow graph is missing a start node');
  const terminals = definition.graph.terminalNodeIds.map((id) => definition.nodes.find((node) => node.id === id));
  if (!terminals.length || terminals.some((node) => !node || node.componentType !== 'end')) {
    throw new Error('Workflow graph is missing an end node');
  }
  const adjacency = new Map<string, string[]>();
  for (const edge of definition.edges) {
    adjacency.set(edge.from, [...(adjacency.get(edge.from) ?? []), edge.to]);
  }
  const reachable = new Set<string>();
  const visit = (nodeId: string): void => {
    if (reachable.has(nodeId)) return;
    reachable.add(nodeId);
    for (const next of adjacency.get(nodeId) ?? []) visit(next);
  };
  visit(definition.graph.entryNodeId);
  for (const id of ids) {
    if (!reachable.has(id)) throw new Error(`Unreachable workflow node: ${id}`);
  }
  for (const boundary of definition.graph.loopBoundaries ?? []) {
    if (!ids.has(boundary.loopNodeId) || !ids.has(boundary.bodyEntryNodeId) || !ids.has(boundary.bodyExitNodeId)) {
      throw new Error(`Invalid workflow loop boundary: ${boundary.loopNodeId}`);
    }
    const loopNode = definition.nodes.find((node) => node.id === boundary.loopNodeId);
    if (loopNode?.componentType !== 'loop') throw new Error(`Workflow loop boundary must point to a loop node: ${boundary.loopNodeId}`);
  }
}

function assertValidWorkflowVariables(definition: WorkflowDefinition): void {
  if (!definition.variables) return;
  const namespaces = new Set<WorkflowVariableNamespace>(['sys', 'input', 'node', 'workflow', 'env']);
  const declared = new Set<string>();
  for (const [namespace, variables] of Object.entries(definition.variables.namespaces) as Array<[WorkflowVariableNamespace, WorkflowVariableDefinition[]]>) {
    if (!namespaces.has(namespace)) throw new Error(`Unknown workflow variable namespace: ${namespace}`);
    for (const variable of variables) {
      if (variable.sensitive === true) throw new Error(`Workflow system variable must not expose sensitive data: ${namespace}.${variable.name}`);
      declared.add(`${namespace}.${variable.name}`);
    }
  }
  const nodeIds = new Set(definition.nodes.map((node) => node.id));
  const refs = definition.nodes.flatMap((node) => extractWorkflowVariableRefs([
    node.prompt,
    node.inputRequirements,
    node.outputRequirements,
    JSON.stringify(node.params ?? {}),
  ].join('\n')));
  for (const ref of refs) {
    const [namespace, first, second] = ref.split('.');
    if (!namespaces.has(namespace as WorkflowVariableNamespace)) throw new Error(`Unknown workflow variable namespace: ${namespace}`);
    if (namespace === 'node') {
      if (!first || !nodeIds.has(first)) throw new Error(`Unknown workflow node variable reference: ${ref}`);
      if (second && second !== 'output' && second !== 'result' && second !== 'error') throw new Error(`Unknown workflow node variable field: ${ref}`);
      continue;
    }
    if (namespace !== 'env' && !declared.has(`${namespace}.${first}`)) throw new Error(`Unknown workflow variable reference: ${ref}`);
  }
}

function buildOutgoingEdges(edges: WorkflowDefinition['edges']): Map<string, string[]> {
  const outgoing = new Map<string, string[]>();
  for (const edge of edges) {
    outgoing.set(edge.from, [...(outgoing.get(edge.from) ?? []), edge.to]);
  }
  return outgoing;
}

function deriveWorkflowTopology(definition: WorkflowDefinition): string[] {
  const dependencies = new Map<string, Set<string>>();
  const outgoing = new Map<string, Set<string>>();
  for (const node of definition.nodes) {
    dependencies.set(node.id, new Set(node.dependsOn));
    outgoing.set(node.id, new Set());
  }
  for (const edge of definition.edges) {
    dependencies.get(edge.to)?.add(edge.from);
    outgoing.get(edge.from)?.add(edge.to);
  }
  const queue = [...definition.nodes.filter((node) => (dependencies.get(node.id)?.size ?? 0) === 0).map((node) => node.id)];
  const order: string[] = [];
  while (queue.length > 0) {
    const nodeId = queue.shift()!;
    order.push(nodeId);
    for (const nextId of outgoing.get(nodeId) ?? []) {
      const nextDependencies = dependencies.get(nextId);
      if (!nextDependencies) continue;
      nextDependencies.delete(nodeId);
      if (nextDependencies.size === 0) queue.push(nextId);
    }
  }
  if (order.length !== definition.nodes.length) {
    throw new Error('Workflow dependency cycle detected in topology derivation');
  }
  return order;
}

function collectWorkflowMissingInputs(definition: WorkflowDefinition): string[] {
  const matches = new Set<string>();
  for (const node of definition.nodes) {
    const texts = [
      node.prompt,
      node.inputRequirements,
      node.outputRequirements,
      ...Object.values(node.params ?? {}).map((value) => typeof value === 'string' ? value : JSON.stringify(value)),
    ];
    for (const text of texts) {
      for (const line of String(text ?? '').split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        if (/待用户补充|待补充|待填写|未填写|to be provided|missing/i.test(trimmed)) {
          const normalized = trimmed
            .replace(/^.*?[：:]\s*/, '')
            .replace(/读取范围.*$/u, '')
            .trim();
          matches.add(normalized || trimmed);
        }
      }
    }
  }
  return [...matches];
}

function extractWorkflowVariableRefs(text: string): string[] {
  return [...text.matchAll(/\{\{\s*([A-Za-z_][\w-]*(?:\.[A-Za-z_][\w-]*){1,2})\s*\}\}/g)].map((match) => match[1]);
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function extractLocalPaths(goal: string): string[] {
  return [...goal.matchAll(/[A-Za-z]:\\[^\s，,。；;）)]+/g)].map((match) => match[0]);
}

function defaultValueForField(field: WorkflowComponentField): unknown {
  if (field.kind === 'checkbox') return false;
  if (field.kind === 'number') return '';
  if (field.kind === 'select') return field.options?.[0] ?? '';
  if (field.kind === 'json') return {};
  return '';
}

function normalizeWorkflowComponentField(field: WorkflowComponentField): WorkflowComponentField {
  const name = field.name.trim().replace(/[^\w-]+/g, '_');
  if (!name) throw new Error('Workflow component field name is required');
  const kinds: WorkflowComponentFieldKind[] = ['text', 'textarea', 'number', 'checkbox', 'select', 'json'];
  const kind = kinds.includes(field.kind) ? field.kind : 'text';
  return {
    name,
    label: field.label?.trim() || name,
    kind,
    description: field.description?.trim() || undefined,
    required: field.required === true,
    options: kind === 'select' ? uniqueStrings((field.options ?? []).map((option) => String(option).trim())) : undefined,
  };
}

function assertValidNodeParams(node: WorkflowNode, component: WorkflowComponentDefinition | undefined): void {
  if (node.params !== undefined && (!node.params || typeof node.params !== 'object' || Array.isArray(node.params))) {
    throw new Error(`Workflow node params must be an object: ${node.id}`);
  }
  if (!component?.ui?.fields.length || !node.params) return;
  const fields = new Map(component.ui.fields.map((field) => [field.name, field]));
  for (const [name, value] of Object.entries(node.params)) {
    const field = fields.get(name);
    if (!field) throw new Error(`Unknown workflow param "${name}" for component ${component.type}`);
    if (field.options && value !== '' && value !== undefined && value !== null && !field.options.includes(String(value))) {
      throw new Error(`Invalid workflow param "${name}" for component ${component.type}`);
    }
  }
}

function normalizeComponentType(type: string): string {
  return type.trim();
}

function assertAcyclic(nodes: WorkflowNode[]): void {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (nodeId: string): void => {
    if (visited.has(nodeId)) return;
    if (visiting.has(nodeId)) throw new Error(`Workflow dependency cycle detected at ${nodeId}`);
    visiting.add(nodeId);
    const node = byId.get(nodeId);
    for (const dependency of node?.dependsOn ?? []) visit(dependency);
    visiting.delete(nodeId);
    visited.add(nodeId);
  };
  for (const node of nodes) visit(node.id);
}

function updateWorkflowNodeRun(
  run: WorkflowExecutionRun,
  nodeId: string,
  patch: Partial<WorkflowNodeRun>,
  now: Date,
  status = run.status,
): WorkflowExecutionRun {
  if (!run.nodeRuns.some((candidate) => candidate.nodeId === nodeId)) {
    throw new Error(`Unknown workflow node run: ${nodeId}`);
  }
  return {
    ...run,
    status,
    nodeRuns: run.nodeRuns.map((nodeRun) => nodeRun.nodeId === nodeId ? { ...nodeRun, ...patch } : nodeRun),
    updatedAt: now.toISOString(),
  };
}

function previousWorkflowResults(
  definition: WorkflowDefinition,
  run: WorkflowExecutionRun,
  node: WorkflowNode,
): Record<string, string> {
  const runs = new Map(run.nodeRuns.map((nodeRun) => [nodeRun.nodeId, nodeRun]));
  return Object.fromEntries(node.dependsOn.map((dependency) => {
    const dependencyNode = definition.nodes.find((candidate) => candidate.id === dependency);
    const result = runs.get(dependency)?.result ?? '';
    return [dependencyNode?.id ?? dependency, result];
  }));
}

function definedPatch<T extends Record<string, unknown>>(patch: T): Partial<T> {
  return Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)) as Partial<T>;
}

function extractJsonObject(text: string): Record<string, unknown> | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const candidate = fenced ?? text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start < 0 || end < start) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function normalizePlannedNodes(value: unknown): WorkflowNode[] {
  if (!Array.isArray(value)) throw new Error('Workflow planner nodes must be an array');
  return value.map((raw, index) => {
    const node = raw as Record<string, unknown>;
    const id = typeof node.id === 'string' && node.id.trim() ? node.id.trim() : `node_${index + 1}`;
    const approval = node.approval === 'required' ? 'required' : 'none';
    return {
      id,
      componentType: typeof node.componentType === 'string' ? node.componentType.trim() : '',
      title: typeof node.title === 'string' && node.title.trim() ? node.title.trim() : id,
      prompt: typeof node.prompt === 'string' ? node.prompt : '',
      inputRequirements: typeof node.inputRequirements === 'string' ? node.inputRequirements : '',
      outputRequirements: typeof node.outputRequirements === 'string' ? node.outputRequirements : '',
      dependsOn: Array.isArray(node.dependsOn)
        ? node.dependsOn.filter((dependency): dependency is string => typeof dependency === 'string').map((dependency) => dependency.trim()).filter(Boolean)
        : [],
      approval,
      params: typeof node.params === 'object' && node.params !== null && !Array.isArray(node.params)
        ? node.params as Record<string, unknown>
        : {},
      config: typeof node.config === 'object' && node.config !== null && !Array.isArray(node.config)
        ? node.config as Record<string, unknown>
        : undefined,
    };
  });
}

function normalizePlannedEdges(value: unknown): WorkflowEdge[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((raw) => {
    const edge = raw as Record<string, unknown>;
    return typeof edge.from === 'string' && typeof edge.to === 'string'
      ? [{ from: edge.from.trim(), to: edge.to.trim() }]
      : [];
  });
}
