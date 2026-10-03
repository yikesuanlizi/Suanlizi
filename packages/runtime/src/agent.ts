import type {
  ThreadId,
  TurnId,
  ThreadMeta,
  TurnMeta,
  ThreadItem,
  ThreadEvent,
  RunTraceObservation,
  RunTraceRunKind,
  UserInput,
  ItemId,
  Usage,
  CollabToolCallItem,
  CollabToolName,
  AgentTransferEnvelope,
  CheckpointStatus,
  ThreadRuntimeState,
  ThreadUsage,
  CompactedRange,
  EpisodeRecord,
  ThreadWorkingSetSnapshot,
  EpisodeMemoryMode,
  KnowledgeCheckpointSummary,
  AccessDecision,
  AccessPolicyConfig,
  AccessRequest,
  AccessRule,
  PersistentAccessScope,
  TemporaryAccessGrant,
  TemporaryAccessScope,
  AgentDecisionAction,
  AgentDecisionRequest,
  AgentDecisionResponse,
  ThreadExecutionStatus,
} from '@suanlizi/protocol';
import { RUN_TRACE_VERSION } from '@suanlizi/protocol';
import { ModelGateway, type AnthropicContentBlock, type ChatMessage, type ToolCall, type LlamaSlotLeaseManager } from '@suanlizi/model-gateway';
import { artifactRoot, ToolRegistry, type ToolContext, type ToolDefinition, type ToolResult, type WebProviderRouterOptions, BUILTIN_TOOLS } from '@suanlizi/tools';
import { Sandbox, resolveSandboxEffective, type SandboxConfig, type SandboxLevel, DenyAllApprovalHandler } from '@suanlizi/sandbox';
import type { ApprovalHandler } from '@suanlizi/sandbox';
import type { PermissionPreset } from '@suanlizi/sandbox';
import type { RunEvent, RunEventLevel, RunRecord, RunTraceStore, ThreadStore } from '@suanlizi/storage';
import type { RemoteAgentClient } from './a2aClient/remoteAgentClient.js';
import {
  DEFAULT_MEMORY_SETTINGS,
  compactThread,
  extractMemoryCandidates,
  getCompactionPressure,
  mergeMemoryCandidate,
  normalizeMemorySettings,
  resumeThread,
  rollbackTurns,
  searchColdMemories,
  buildOrReuseWorkingSet,
  getThreadWorkingSetSnapshot,
  saveThreadWorkingSetSnapshot,
  getOpenEpisodeForThread,
  saveEpisodeRecord,
  sealEpisode,
  updateEpisodeFromTurn,
  invalidateEpisodesByTurnRange,
  getEpisodeMemorySettings,
  normalizeEpisodeMemorySettings,
  listLightMemories,
  type MemorySettings,
  type EpisodeMemorySettings,
} from '@suanlizi/memory';
import { loadAgentsMd, LocalSkillRegistry, LocalHookRegistry } from '@suanlizi/extensions';
import type { HookRegistry, SkillRegistry } from '@suanlizi/extensions';
import { createI18n, systemPromptKey } from '@suanlizi/i18n';
import type { Locale, I18n } from '@suanlizi/i18n';
import { ThreadStateManager } from './state.js';
import type { ThreadState } from './state.js';
import type { Checkpoint } from '@suanlizi/protocol';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { shouldEnableWebSearch, type WebSearchMode } from './webSearchPolicy.js';
import { parseMcpNamespacedToolName } from './mcpClient.js';
import { buildPromptCacheShape, comparePromptCacheShape, type PromptCacheShape } from './cacheShape.js';
import { buildFreshnessPreflightNotice } from './fileFreshnessPreflight.js';
import { compactionOptionsForModelContext, contextBudget } from './compactionPolicy.js';
import { leaksToolProtocol, validateThreadItemsForPersistence } from './modelOutput.js';
import { SuanliziRuntimeError, isRecoverableStreamError, toSuanliziErrorInfo } from './runtimeError.js';
import type { RunTurnOptions, HarnessItemFields, HarnessResult } from './harness/types.js';
import { TaskHarnessEngine, type HarnessAgentLoop, type HarnessStateChangeCallback } from './harness/taskHarness.js';
import { DEFAULT_HARNESS_CONFIG } from './harness/types.js';
import type { EvaluatorModelGateway } from './harness/goalEvaluator.js';
import {
  composeRuntimeMiddleware,
  createDynamicContextMiddleware,
  createExperienceWritebackMiddleware,
  createStabilityMiddleware,
  type RuntimeMiddleware,
  type RuntimeModelRequest,
  type RuntimeToolRequest,
  type RuntimeToolResponse,
  type RuntimeTurnResult,
  type RuntimeTurnContext,
} from './middleware.js';
import {
  createToolSearchTool,
  toolNamesFromSearchResult,
  TOOL_SEARCH_TOOL_NAME,
} from './toolSearch.js';
import { createToolGovernanceMiddleware, type ToolGovernanceConfig } from './toolGovernance.js';
import { createStrictToolFinalizationMiddleware } from './strictToolFinalization.js';
import { createGuardianMiddleware, type GuardianConfig } from './guardian.js';
import { SystemMonitor, DEFAULT_SYSTEM_MONITOR_CONFIG, createEmptySystemMonitorStatus, type SystemMonitorConfig } from './systemMonitor.js';
import type { SystemMonitorLevel, SystemMonitorStatus } from '@suanlizi/protocol';
import {
  createContextEngine,
  createInitialAgentContext,
  EnvironmentContextProvider,
  ExperienceContextProvider,
  ExperienceEngine,
  JsonExperienceStore,
  ProjectBrainContextProvider,
  TaskContextProvider,
  type AgentContext,
  type ContextEngine,
  type ContextProvider,
  type ExperienceStore,
  type ProjectBrainEnricher,
} from '@suanlizi/context';
import {
  discoverSkills,
  loadAllSkillModules,
  registerSkillsToRegistry,
  buildSkillsIndexBlock,
  type LoadedSkill,
} from '@suanlizi/extensions';
import { SkillExecutor } from './skillExecutor.js';
import { createUseSkillTool, USE_SKILL_TOOL_NAME } from './skillTool.js';
import { RunTraceSession } from './runTraceSession.js';
import { buildRuntimeAccessPolicy, evaluateAccessRequest } from './accessPolicy.js';

const RUNNING_CHECKPOINT_TTL_MS = 30 * 60 * 1000;
const MAX_WEB_SEARCH_CALLS_PER_TURN = 6;
const MAX_DUPLICATE_WEB_SEARCH_QUERY_PER_TURN = 2;
const MODEL_HISTORY_TOKEN_BUDGET = 40_000;
const DEFAULT_MODEL_OUTPUT_TOKEN_BUDGET = 4_096;
const MODEL_REQUEST_OVERHEAD_TOKENS = 256;
const MODEL_REQUEST_SAFETY_MARGIN_TOKENS = 64;
const MIN_MODEL_INPUT_TOKEN_BUDGET = 512;

function runtimeApprovalId(): string {
  return `approval_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function approvalKindForAccessRequest(request: AccessRequest): 'command' | 'file_write' | 'tool_call' | 'network' {
  if (request.access === 'command') return 'command';
  if (request.access === 'network') return 'network';
  if (request.access === 'write') return 'file_write';
  return 'tool_call';
}

function temporaryGrantOptionsForLocale(locale: Locale): Array<{ scope: TemporaryAccessScope; label: string }> {
  if (locale === 'zh') {
    return [
      { scope: 'tool_call', label: '仅本次工具调用' },
      { scope: 'turn', label: '仅本轮对话' },
      { scope: 'session', label: '仅本次应用会话' },
    ];
  }
  return [
    { scope: 'tool_call', label: 'This tool call only' },
    { scope: 'turn', label: 'This turn only' },
    { scope: 'session', label: 'This app session only' },
  ];
}

export type ToolBindingMode = 'eager' | 'delayed';

export const DEFAULT_AGENT_ROLE_NAME = 'default';

export interface AgentRoleProfile {
  // 中文注释：展示给模型与 list_agents 调用者的人类可读用途说明。
  /** Human-readable purpose shown to the model and list_agents callers. */
  description?: string;
  // 中文注释：附加到子 agent 系统提示的角色特定指令。
  /** Role-specific instructions appended to the child system prompt. */
  instructions?: string;
  // 中文注释：instructions 的别名，与常见配置命名一致。
  /** Alias for instructions, matching common config naming. */
  systemPrompt?: string;
  // 中文注释：角色作用域内的技能。等价于 allowedSkills。
  /** Role-scoped skills. Equivalent to allowedSkills. */
  skills?: string[];
  // 中文注释：对使用此角色生成的子 agent 可见的技能名称。
  /** Skill names visible to spawned agents using this role. */
  allowedSkills?: string[];
  // 中文注释：对使用此角色生成的子 agent 可见且可执行的工具名称。
  /** Tool names visible and executable by spawned agents using this role. */
  allowedTools?: string[];
  // 中文注释：对使用此角色生成的子 agent 隐藏并拒绝的工具名称。
  /** Tool names hidden and rejected for spawned agents using this role. */
  blockedTools?: string[];
  // 中文注释：复制到子线程的元数据；不会切换继承的模型。
  /** Metadata copied to the child thread; it does not switch the inherited model. */
  serviceTier?: string;
  // 中文注释：此 agent 可生成的子 agent 的本地数量上限。
  /** Role-local limit for children spawned by this agent. */
  maxSubagents?: number;
  // 中文注释：角色本地的子 agent 嵌套深度上限。
  /** Role-local child-agent depth limit. */
  maxSubagentDepth?: number;
}

export interface ResolvedAgentRoleProfile extends AgentRoleProfile {
  name: string;
}

export type AgentRoleProfiles = Record<string, AgentRoleProfile>;

// ─── Config ─────────────────────────────────────────────────────────────────
// 中文注释：运行时配置接口。
export interface AgentConfig {
  // 中文注释：工作区认证只看这个布尔标记；workspaceRoot 只是位置数据。
  hasWorkspace?: boolean;
  // 中文注释：文件操作的工作区根目录。
  /** Workspace root for file operations. */
  workspaceRoot: string;
  // 中文注释：沙箱配置。
  /** Sandbox config. */
  sandbox: SandboxConfig;
  // 中文注释：运行时访问策略；持久规则来自设置，临时授权仅在内存中追加。
  /** Runtime access policy; persistent rules come from settings, temporary grants stay in memory. */
  accessPolicy?: AccessPolicyConfig;
  // 中文注释：模型网关实例。
  /** Model gateway instance. */
  model: ModelGateway;
  // 中文注释：线程存储。
  /** Thread store. */
  store: ThreadStore;
  // 中文注释：运行时租户隔离 ID。
  /** Runtime tenant isolation id. */
  tenantId?: string;
  // 中文注释：工具注册表（默认为 BUILTIN_TOOLS）。
  /** Tool registry (defaults to BUILTIN_TOOLS). */
  tools?: ToolRegistry;
  // 中文注释：从已启用的 MCP 服务器发现的 MCP 工具。
  /** MCP tools discovered from enabled MCP servers. */
  mcpTools?: ToolDefinition[];
  // 中文注释：审批处理器（默认为 DenyAllApprovalHandler）。
  /** Approval handler (defaults to DenyAllApprovalHandler). */
  approvalHandler?: ApprovalHandler;
  // 中文注释：每个回合 agent 循环的最大迭代次数。
  /** Max agent loop iterations per turn. */
  maxIterations?: number;
  /** Maximum top-level tasks is enforced by the API registry; this value is retained for runtime diagnostics. */
  maxActiveTasks?: number;
  /** Maximum explicitly parallel-safe readonly tools per agent step. */
  maxParallelReadonlyTools?: number;
  // 中文注释：系统提示覆盖。
  /** System prompt override. */
  systemPrompt?: string;
  // 中文注释：技能注册表。
  /** Skills registry. */
  skills?: SkillRegistry;
  // 中文注释：hooks 注册表。
  /** Hooks registry. */
  hooks?: HookRegistry;
  // 中文注释：UI 与 agent 响应的语言（默认 'zh'）。
  /** UI + agent response locale (default: 'zh'). */
  locale?: Locale;
  // 中文注释：控制在提供者扩展可用时何时提供 web_search。
  /** Controls when web_search should be offered once a provider extension is available. */
  webSearchMode?: WebSearchMode;
  // 中文注释：传递给 web_search/web_fetch 工具的 Web 提供者设置。
  /** Web provider settings passed down to web_search/web_fetch tools. */
  webProvider?: WebProviderRouterOptions;
  // 中文注释：运行时权衡配置（缓存命中稳定性或长期追踪可追溯性）。
  /** Runtime trade-off profile: cache hit stability or long-running traceability. */
  /** Current model context window in tokens. Used for compaction pressure and UI pressure events. */
  modelContextTokens?: number;
  /** Maximum completion tokens reserved in the model context window. */
  modelMaxOutputTokens?: number;
  // 中文注释：父线程下允许打开的已生成子 agent 最大数量。
  /** Maximum open spawned subagents below a parent thread. */
  maxSubagents?: number;
  // 中文注释：供回合/模型/工具流水线扩展使用的运行时中间件钩子。
  /** Runtime middleware hooks for turn/model/tool pipeline extension. */
  runtimeMiddleware?: RuntimeMiddleware[];
  // 中文注释：用于动态上下文注入的可选事实提供者。
  /** Optional fact provider for dynamic context injection. */
  dynamicContextProvider?: (ctx: RuntimeTurnContext) => Promise<string | string[]>;
  // 中文注释：每个回合重复执行相同工具调用的最大次数，超过则短路。
  /** Maximum repeated identical tool calls per turn before short-circuiting. */
  maxRepeatedToolCalls?: number;
  // 中文注释：连续工具响应失败的最大次数，超过则短路重试。
  /** Maximum consecutive failed tool responses before short-circuiting retries. */
  maxConsecutiveToolErrors?: number;
  // 中文注释：工具 schema 绑定策略。出于兼容性考虑，默认为 eager。
  /** Tool schema binding strategy. Defaults to eager for compatibility. */
  toolBindingMode?: ToolBindingMode;
  // 中文注释：在 delayed-binding 首次模型调用时暴露的工具名称。
  /** Tool names exposed on the first delayed-binding model call. */
  initialTools?: string[];
  // 中文注释：一次 tool_search 调用可返回并绑定的最大工具数。
  /** Maximum tools returned and bound by one tool_search call. */
  maxToolSearchResults?: number;
  // 中文注释：超出稳定性限制的运行时工具治理策略。
  /** Runtime tool governance policy beyond stability limits. */
  toolGovernance?: ToolGovernanceConfig;
  // 中文注释：子 agent 嵌套深度的最大值。根节点的子节点深度为 1。
  /** Maximum child-agent nesting depth. Root children are depth 1. */
  maxSubagentDepth?: number;
  // 中文注释：生成时模型/推理覆写的可选工厂。未设置时回退到继承模型。
  /** Optional factory for spawn-time model/reasoning overrides. Falls back to inherited model. */
  spawnModelFactory?: (override: {
    model?: string;
    reasoningEffort?: string;
    serviceTier?: string;
    agentRole?: string;
  }) => ModelGateway;
  // 中文注释：Codex 风格的 agent_type 角色配置。用户配置可按名称覆写内置配置。
  /** Codex-style agent_type profiles. User profiles override built-ins by name. */
  agentRoles?: AgentRoleProfiles;
  // 中文注释：此 AgentLoop 实例活动的角色配置；通常为已生成子 agent 设置。
  /** Active role profile for this AgentLoop instance; normally set for spawned children. */
  activeAgentRoleProfile?: ResolvedAgentRoleProfile | null;
  // 中文注释：在工具执行前的可选 Codex 风格 fail-closed 安全审查。
  /** Optional Codex-style fail-closed safety review before tool execution. */
  guardian?: GuardianConfig;
  // 中文注释：此运行时的热/温/冷记忆策略。
  /** Hot/warm/cold memory policy for this runtime. */
  memory?: Partial<MemorySettings>;
  // 中文注释：A2A 客户端配置 — 是否允许调用外部 A2A Agent。
  /** A2A client config — whether calling external A2A agents is allowed. */
  a2aClientEnabled?: boolean;
  // 中文注释：已注册的远程 A2A Agent 地址列表（用于工具描述提示）。
  /** Registered remote A2A agent URLs (used for tool description hints). */
  a2aRemotes?: string[];
  // 中文注释：系统监控配置（可开关）。启用后 agent 会收到主机 CPU/内存/磁盘压力的主动通知，
  //           并在工具执行/子 agent 委派时自动限流。
  /** System monitor config (toggleable). When enabled, the agent receives proactive
   *  host CPU/memory/disk pressure notifications and auto-throttles tool execution / subagent delegation. */
  llamaSlotLeaseManager?: LlamaSlotLeaseManager;
  systemMonitor?: Partial<SystemMonitorConfig>;
  // 中文注释：经验引擎配置。开启后会在回合内自动记录 failure_pattern / successful_workflow / gotcha 等 SAO 经验。
  /** Experience engine config. When enabled, records SAO-format experiences (failure patterns,
   *  successful workflows, gotchas) across turns and surfaces them in dynamic context. */
  experiences?: {
    enabled?: boolean;
    /** Persistence directory. If set, uses JsonExperienceStore at that path; otherwise in-memory only. */
    storageDir?: string;
    /** Max entries kept after prune. */
    maxEntries?: number;
  };
  // 中文注释：可执行技能目录列表。每个目录下子目录/SKILL.md 或 *.skill.md 会被扫描；带 entry 字段的 SKILL.md 视为 executable skill。
  /** Executable skill directories. Each directory's subdirectories with SKILL.md (or *.skill.md files) are scanned;
   *  SKILL.md files with an "entry" field are treated as executable skills. */
  skillsDirs?: string[];
}

type ResolvedAgentConfig = Required<Omit<AgentConfig, 'memory' | 'a2aClientEnabled' | 'a2aRemotes' | 'systemMonitor' | 'experiences' | 'skillsDirs' | 'modelContextTokens' | 'modelMaxOutputTokens' | 'llamaSlotLeaseManager'>> & {
  modelContextTokens?: number;
  modelMaxOutputTokens?: number;
  memory: MemorySettings;
  a2aClientEnabled?: boolean;
  a2aRemotes?: string[];
  llamaSlotLeaseManager?: LlamaSlotLeaseManager;
  systemMonitor: SystemMonitorConfig;
  experiences: { enabled: boolean; storageDir?: string; maxEntries: number };
  skillsDirs: string[];
};

type ToolCallExecutionResult = {
  toolCall: ToolCall;
  output: string;
  disableWebSearch?: boolean;
  activateToolNames?: string[];
};

// ─── Agent Loop ─────────────────────────────────────────────────────────────
export class AgentLoop {
  private config: ResolvedAgentConfig;
  private tools: ToolRegistry;
  private i18n: I18n;
  private eventListeners: Array<(event: ThreadEvent) => void> = [];
  private subagentRuns = new Map<ThreadId, Promise<{ items: ThreadItem[]; usage: Usage | null }>>();
  private promptCacheShapes = new Map<ThreadId, PromptCacheShape>();
  private runMonitorSessions = new Map<TurnId, {
    runId: string;
    runKind: RunTraceRunKind;
    threadId: ThreadId;
    turnId: TurnId;
    sequence: number;
    startedAt: string;
    modelCallCount: number;
    toolCallCount: number;
    subagentCount: number;
    middlewareEventCount: number;
    inputTokens: number;
    cachedInputTokens: number;
    outputTokens: number;
    reasoningOutputTokens: number;
    traceSession: RunTraceSession | null;
  }>();
  private runtimeMiddleware: ReturnType<typeof composeRuntimeMiddleware>;
  /** Per-thread episode working set snapshot (in-memory cache). */
  private threadWorkingSets = new Map<ThreadId, ThreadWorkingSetSnapshot>();
  /** Per-thread currently open episode (in-memory cache). */
  private threadOpenEpisodes = new Map<ThreadId, EpisodeRecord>();
  /** Per-thread state manager — process-level singleton by default. */
  readonly stateManager: ThreadStateManager;
  /** Resolved sandbox engine (lazy). */
  private _sandbox: Sandbox | null = null;
  /** Effective sandbox level from config (resolved from preset if set). */
  private _effectiveSandbox: { level: SandboxLevel; networkAllowed: boolean };
  private runtimeAccessPolicy: AccessPolicyConfig;
  // 中文注释：系统监控实例。仅在 config.systemMonitor.enabled=true 时启动后台采样。
  /** System monitor instance. Only starts background sampling when config.systemMonitor.enabled=true. */
  private _systemMonitor: SystemMonitor | null = null;
  // 中文注释：待注入给 agent 的系统压力通知（级别变化时写入，下一次模型调用前消费并清空）。
  /** Pending system-pressure notice to inject into the next model call (set on level change, consumed and cleared before next model call). */
  private _pendingSystemNotice: string | null = null;
  // 中文注释：取消 SystemMonitor 级别变化订阅的函数。
  /** Unsubscribe function for the SystemMonitor level-change listener. */
  private _systemMonitorUnsub: (() => void) | null = null;
  // 实施点 2：per-thread harness 字段标记，用于给 harness turn 产生的 items 打 harnessRunId
  // — English: per-thread harness fields marker, used to tag items produced by harness turns
  private harnessFieldsByThread = new Map<ThreadId, HarnessItemFields>();
  private pendingDecisionResolvers = new Map<ThreadId, {
    request: AgentDecisionRequest;
    resolve: (response: AgentDecisionResponse) => void;
    reject: (error: unknown) => void;
  }>();
  /** Child runtime handles owned by each parent turn for cancellation propagation. */
  private childAgentsByParent = new Map<ThreadId, Map<ThreadId, AgentLoop>>();
  private _contextEngine: ContextEngine;
  private agentContextByThread = new Map<ThreadId, AgentContext>();
  private envContextProvider: EnvironmentContextProvider;
  private taskContextProvider: TaskContextProvider;
  private projectBrainProvider: ProjectBrainContextProvider | null = null;
  // 中文注释：SAO 经验引擎，用于记录失败模式、成功工作流、gotcha 等行为经验。
  /** SAO experience engine: records failure patterns, successful workflows, gotchas, etc. */
  private _experienceEngine: ExperienceEngine;
  // 中文注释：已加载的 skill 列表（包含 prompt skill 和 executable skill）。
  /** Loaded skills (both prompt-only and executable). */
  private loadedSkills: LoadedSkill[] = [];
  // 中文注释：skill 执行器，负责参数校验、超时、错误隔离。
  /** Skill executor: parameter validation, timeout, error isolation. */
  private _skillExecutor: SkillExecutor;

  constructor(config: AgentConfig, stateManager?: ThreadStateManager) {
    const locale = config.locale ?? 'zh';
    this.i18n = createI18n(locale);
    this.stateManager = stateManager ?? ThreadStateManager.instance();
    this.config = {
      hasWorkspace: config.hasWorkspace !== false,
      workspaceRoot: config.workspaceRoot,
      sandbox: config.sandbox,
      accessPolicy: buildRuntimeAccessPolicy(config.accessPolicy ?? {
        mode: config.sandbox.preset?.id === 'danger_full_access'
          ? 'danger_full_access'
          : config.sandbox.level === 'readonly'
            ? 'chat'
            : 'workspace',
        workspaceRoot: config.workspaceRoot,
        persistentRules: [],
        temporaryGrants: [],
      }),
      model: config.model,
      store: config.store,
      tenantId: safeRuntimeTenantId(config.tenantId ?? config.store.tenantId),
      tools: config.tools ?? createDefaultRegistry(),
      mcpTools: config.mcpTools ?? [],
      approvalHandler: config.approvalHandler ?? new DenyAllApprovalHandler(),
      maxIterations: Math.max(1, Math.floor(Number(config.maxIterations ?? 100))) || 100,
      maxActiveTasks: Math.max(1, Math.floor(config.maxActiveTasks ?? 4)),
      systemPrompt: config.systemPrompt ?? this.i18n.t(systemPromptKey(locale)),
      skills: config.skills ?? new LocalSkillRegistry(),
      hooks: config.hooks ?? new LocalHookRegistry(),
      locale,
      webSearchMode: config.webSearchMode ?? 'auto',
      webProvider: config.webProvider ?? { provider: 'native_fetch' },
      modelContextTokens: positiveInteger(config.modelContextTokens),
      modelMaxOutputTokens: positiveInteger(config.modelMaxOutputTokens),
      maxSubagents: config.maxSubagents ?? 4,
      runtimeMiddleware: config.runtimeMiddleware ?? [],
      dynamicContextProvider: config.dynamicContextProvider ?? (async () => []),
      maxRepeatedToolCalls: config.maxRepeatedToolCalls ?? 3,
      maxConsecutiveToolErrors: config.maxConsecutiveToolErrors ?? 100,
      toolBindingMode: config.toolBindingMode ?? 'eager',
      initialTools: config.initialTools ?? [],
      maxToolSearchResults: config.maxToolSearchResults ?? 8,
      toolGovernance: config.toolGovernance ?? {},
      maxSubagentDepth: Math.max(1, Math.min(2, Math.floor(config.maxSubagentDepth ?? 1))),
      maxParallelReadonlyTools: Math.max(1, Math.min(16, Math.floor(config.maxParallelReadonlyTools ?? 2))),
      spawnModelFactory: config.spawnModelFactory ?? (() => config.model),
      agentRoles: normalizeAgentRoleProfiles(config.agentRoles),
      activeAgentRoleProfile: config.activeAgentRoleProfile ?? null,
      guardian: config.guardian ?? {},
      memory: normalizeMemorySettings(config.memory ?? DEFAULT_MEMORY_SETTINGS),
      systemMonitor: {
        ...DEFAULT_SYSTEM_MONITOR_CONFIG,
        ...config.systemMonitor,
        thresholds: {
          ...DEFAULT_SYSTEM_MONITOR_CONFIG.thresholds,
          ...config.systemMonitor?.thresholds,
        },
      },
      experiences: {
        enabled: config.experiences?.enabled ?? false,
        storageDir: config.experiences?.storageDir,
        maxEntries: config.experiences?.maxEntries ?? 500,
      },
      skillsDirs: config.skillsDirs ?? [],
    };
    this.runtimeAccessPolicy = this.config.accessPolicy;
    this.tools = this.config.tools;
    registerCollabTools(this.tools, {
      a2aClientEnabled: config.a2aClientEnabled,
      a2aRemotes: config.a2aRemotes,
    });
    registerOptionalTools(this.tools, this.config.mcpTools);
    if (this.config.toolBindingMode === 'delayed' && !this.tools.get(TOOL_SEARCH_TOOL_NAME)) {
      this.tools.register(createToolSearchTool(this.tools, {
        maxResults: this.config.maxToolSearchResults,
      }));
    }
    this._effectiveSandbox = resolveSandboxEffective(config.sandbox);

    this.envContextProvider = new EnvironmentContextProvider({ cwd: this.config.workspaceRoot });
    this.taskContextProvider = new TaskContextProvider();

    let experienceStore: ExperienceStore | undefined;
    if (this.config.experiences.enabled) {
      const dir = this.config.experiences.storageDir
        ?? path.join(artifactRoot(this.config.workspaceRoot), 'experiences');
      experienceStore = new JsonExperienceStore(dir, 'experiences.json');
    }
    this._experienceEngine = new ExperienceEngine({
      enabled: this.config.experiences.enabled,
      workspaceRoot: this.config.workspaceRoot,
      store: experienceStore,
    });

    const providers: ContextProvider[] = [
      this.taskContextProvider,
      this.envContextProvider,
      new ExperienceContextProvider({ experienceEngine: this._experienceEngine }),
    ];
    if (this.config.workspaceRoot) {
      this.projectBrainProvider = new ProjectBrainContextProvider({
        workspaceRoot: this.config.workspaceRoot,
      });
      providers.push(this.projectBrainProvider);
    }

    this._contextEngine = createContextEngine({
      totalBudget: contextBudget(),
      providers,
    });

    this._skillExecutor = new SkillExecutor();
    if (!this.tools.get(USE_SKILL_TOOL_NAME)) {
      this.tools.register(createUseSkillTool({
        getSkills: () => this.loadedSkills,
        executor: this._skillExecutor,
        getWorkspaceRoot: () => this.config.workspaceRoot,
      }));
    }

    if (!this.tools.get('update_cognition')) {
      this.tools.register({
        name: 'update_cognition',
        description: 'Update your internal task cognition state. Use this when you discover new facts, identify new risks, resolve unknowns, or want to record constraints discovered during execution. This updates your mental model so subsequent turns have accurate context.',
        requiredPolicy: 'readonly',
        parameters: {
          type: 'object',
          properties: {
            addKnownFacts: {
              type: 'array',
              items: { type: 'string' },
              description: 'New facts you have confirmed (e.g. "The project uses pnpm workspaces")',
            },
            addUnknowns: {
              type: 'array',
              items: { type: 'string' },
              description: 'New questions/unknowns you need to resolve',
            },
            resolveUnknowns: {
              type: 'array',
              items: { type: 'string' },
              description: 'Previously-unknown items that are now resolved (exact text matches)',
            },
            addConstraints: {
              type: 'array',
              items: { type: 'string' },
              description: 'New constraints discovered (e.g. "Must support Node 18")',
            },
            addRisks: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  description: { type: 'string' },
                  severity: { type: 'string', enum: ['low', 'medium', 'high'] },
                  mitigation: { type: 'string' },
                },
                required: ['description', 'severity'],
              },
              description: 'New risks identified',
            },
            confidence: {
              type: 'number',
              description: 'Your current confidence in completing the task (0.0 = completely stuck, 1.0 = certain of success)',
            },
          },
          additionalProperties: false,
        },
        execute: async (_args, toolCtx) => {
          const args = _args as Record<string, unknown>;
          const threadId = toolCtx.threadId as ThreadId;
          if (!threadId) {
            return { output: 'No thread context available', status: 'failed' };
          }
          this.updateTaskCognition(threadId, {
            addKnownFacts: args.addKnownFacts as string[] | undefined,
            addUnknowns: args.addUnknowns as string[] | undefined,
            resolveUnknowns: args.resolveUnknowns as string[] | undefined,
            addConstraints: args.addConstraints as string[] | undefined,
            addRisks: args.addRisks as Array<{ description: string; severity: 'low'|'medium'|'high'; mitigation?: string }> | undefined,
            confidence: typeof args.confidence === 'number' ? args.confidence : undefined,
          });
          const ctx = this.getOrCreateAgentContext(threadId);
          const t = ctx.cognition.task;
          return {
            output: [
              'Cognition updated. Current state:',
              `Goal: ${t.goal || '(none set)'}`,
              `Confidence: ${Math.round(t.confidence * 100)}%`,
              `Known facts (${t.knownFacts.length}): ${t.knownFacts.length > 0 ? t.knownFacts.slice(-5).join('; ') : 'none'}`,
              `Unknowns (${t.unknowns.length}): ${t.unknowns.length > 0 ? t.unknowns.slice(-5).join('; ') : 'none'}`,
              `Constraints (${t.constraints.length}): ${t.constraints.length > 0 ? t.constraints.slice(-3).join('; ') : 'none'}`,
              `Risks (${t.risks.length}): ${t.risks.length > 0 ? t.risks.slice(-3).map((r) => `[${r.severity}] ${r.description}`).join('; ') : 'none'}`,
            ].join('\n'),
            status: 'completed',
          };
        },
      });
    }

    this.runtimeMiddleware = composeRuntimeMiddleware([
      createStabilityMiddleware({
        maxRepeatedToolCalls: this.config.maxRepeatedToolCalls,
        maxConsecutiveToolErrors: this.config.maxConsecutiveToolErrors,
        maxWebSearchCallsPerTurn: MAX_WEB_SEARCH_CALLS_PER_TURN,
        maxDuplicateWebSearchQueryPerTurn: MAX_DUPLICATE_WEB_SEARCH_QUERY_PER_TURN,
      }),
      createGuardianMiddleware(this.config.guardian),
      createToolGovernanceMiddleware({
        approvalHandler: this.config.approvalHandler,
        preset: this.preset,
        sandbox: () => this.sandbox,
        governance: this.config.toolGovernance,
      }),
      createDynamicContextMiddleware({
        contextEngine: this._contextEngine,
        getExecutableSkillsBlock: () => buildSkillsIndexBlock(this.loadedSkills),
        getAgentContext: (threadId) => this.getOrCreateAgentContext(threadId),
        setAgentContext: (threadId, ctx) => this.agentContextByThread.set(threadId, ctx),
        contextBudget: contextBudget(),
        emit: (event) => this.emit(event),
      }),
      createExperienceWritebackMiddleware({
        experienceEngine: this._experienceEngine,
      }),
      {
        afterTool: (_ctx, request, response) => {
          if (response.status === 'failed') return;
          const mutatingTools = new Set([
            'shell', 'write_file', 'patch', 'edit_file', 'apply_patch',
            'create_file', 'delete_file', 'rename_file', 'mkdir', 'git_apply',
            'run_tests', 'install_dependency',
          ]);
          if (mutatingTools.has(request.toolName) && this.projectBrainProvider) {
            this.projectBrainProvider.invalidateArchitecture();
            this.envContextProvider?.invalidateCache?.();
          }
        },
      },
      ...this.config.runtimeMiddleware,
      createStrictToolFinalizationMiddleware(),
    ]);
    // 中文注释：初始化系统监控。仅当 enabled=true 时启动后台采样，并订阅级别变化用于主动通知。
    // — Chinese: init system monitor; only starts background sampling when enabled, subscribes for proactive notification
    this.initSystemMonitor();
  }

  /** 初始化系统监控并订阅级别变化事件。 */
  // — Chinese: init system monitor and subscribe to level-change events
  private initSystemMonitor(): void {
    const cfg = this.config.systemMonitor;
    if (!cfg.enabled) return;
    this._systemMonitor = new SystemMonitor(cfg);
    this._systemMonitorUnsub = this._systemMonitor.onLevelChange((status) => {
      this.handleSystemMonitorLevelChange(status);
    });
    this._systemMonitor.start();
  }

  /** 级别变化时：写入待注入通知 + 发射 warning 事件。 */
  // — Chinese: on level change: queue notice for next model call + emit warning event
  private handleSystemMonitorLevelChange(status: SystemMonitorStatus): void {
    if (status.level === 'none') {
      // 压力解除 — 注入恢复通知
      // — Chinese: pressure cleared — inject recovery notice
      this._pendingSystemNotice = `[System Monitor] Host pressure has returned to normal. You may resume normal tool execution and subagent delegation.`;
    } else {
      this._pendingSystemNotice = `[System Monitor] Host under ${status.level} pressure. ${status.recommendation} (CPU: ${status.snapshot.cpuUsage.toFixed(1)}%, Memory: ${status.snapshot.memUsage.toFixed(1)}%)`;
    }
    // 发射 warning 事件给 UI / 监听器
    // — Chinese: emit warning event to UI / listeners
    this.emit({
      type: 'warning',
      message: this._pendingSystemNotice,
    });
  }

  /** 获取当前系统监控级别（未启用时返回 'none'）。 */
  // — Chinese: get current system monitor level (returns 'none' if disabled)
  private get systemMonitorLevel(): SystemMonitorLevel {
    if (!this._systemMonitor || !this._systemMonitor.isGuardEnabled()) return 'none';
    return this._systemMonitor.getStatus().level;
  }

  /** 消费待注入的系统通知，返回通知文本（无则返回 null）。 */
  // — Chinese: consume pending system notice, returns notice text or null
  private consumePendingSystemNotice(): string | null {
    const notice = this._pendingSystemNotice;
    this._pendingSystemNotice = null;
    return notice;
  }

  private getOrCreateAgentContext(threadId: ThreadId): AgentContext {
    let ctx = this.agentContextByThread.get(threadId);
    if (!ctx) {
      const env = {
        cwd: this.config.workspaceRoot,
        os: process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : process.platform,
        shell: process.platform === 'win32' ? (process.env.COMSPEC || 'cmd.exe') : (process.env.SHELL || '/bin/sh'),
      };
      ctx = createInitialAgentContext(env);
      this.agentContextByThread.set(threadId, ctx);
    }
    return ctx;
  }

  getAgentContext(threadId: ThreadId): AgentContext | undefined {
    return this.agentContextByThread.get(threadId);
  }

  registerProjectBrainEnricher(enricher: ProjectBrainEnricher): void {
    if (this.projectBrainProvider) {
      this.projectBrainProvider.addEnricher(enricher);
    }
  }

  updateTaskCognition(threadId: ThreadId, update: {
    goal?: string;
    constraints?: string[];
    assumptions?: string[];
    knownFacts?: string[];
    unknowns?: string[];
    risks?: Array<{ description: string; severity: 'low' | 'medium' | 'high'; mitigation?: string }>;
    confidence?: number;
    verificationCriteria?: string[];
    addConstraints?: string[];
    addKnownFacts?: string[];
    addUnknowns?: string[];
    resolveUnknowns?: string[];
    addRisks?: Array<{ description: string; severity: 'low' | 'medium' | 'high'; mitigation?: string }>;
  }): void {
    const ctx = this.getOrCreateAgentContext(threadId);
    const current = ctx.cognition.task;

    const mergedConstraints = update.constraints ?? (update.addConstraints?.length
      ? [...new Set([...current.constraints, ...update.addConstraints])]
      : current.constraints);
    const mergedFacts = update.knownFacts ?? (update.addKnownFacts?.length
      ? [...new Set([...current.knownFacts, ...update.addKnownFacts])]
      : current.knownFacts);
    const mergedUnknowns = update.unknowns ?? (update.resolveUnknowns?.length
      ? current.unknowns.filter((u) => !update.resolveUnknowns!.includes(u))
      : update.addUnknowns?.length
        ? [...new Set([...current.unknowns, ...update.addUnknowns])]
        : current.unknowns);
    const mergedRisks = update.risks ?? (update.addRisks?.length
      ? [...current.risks, ...update.addRisks]
      : current.risks);

    const newConfidence = update.confidence !== undefined
      ? Math.max(0, Math.min(1, update.confidence))
      : update.goal
        ? Math.max(current.confidence, 0.7)
        : current.confidence;

    const updatedTask = {
      ...current,
      ...(update.goal !== undefined ? { goal: update.goal } : {}),
      ...(update.assumptions !== undefined ? { assumptions: update.assumptions } : {}),
      constraints: mergedConstraints,
      knownFacts: mergedFacts,
      unknowns: mergedUnknowns,
      risks: mergedRisks,
      confidence: newConfidence,
      ...(update.verificationCriteria !== undefined ? { verificationCriteria: update.verificationCriteria } : {}),
    };
    this.agentContextByThread.set(threadId, {
      ...ctx,
      cognition: { task: updatedTask },
      updatedAt: Date.now(),
    });
    // emit task.cognition.updated — 让 TaskRuntimeMonitor 能看到认知状态变化
    // 注意：只发摘要字段，不发完整 prompt
    const activeTurnId = this.stateManager.get(threadId)?.activeTurnId;
    this.emit({
      type: 'task.cognition.updated',
      threadId,
      turnId: activeTurnId ?? undefined,
      cognition: {
        goal: updatedTask.goal,
        constraints: updatedTask.constraints,
        knownFacts: updatedTask.knownFacts,
        unknowns: updatedTask.unknowns,
        risks: updatedTask.risks.map((r) => r.description),
        confidence: updatedTask.confidence,
        verificationCriteria: updatedTask.verificationCriteria,
      },
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * 运行时更新系统监控配置（热更新开关/阈值）。
   * 启用时若尚未初始化则创建实例并启动；禁用时停止采样并释放资源。
   */
  /** Update system monitor config at runtime (hot-reload toggle / thresholds).
   *  Creates and starts the monitor if enabling; stops and disposes if disabling. */
  updateSystemMonitorConfig(partial: Partial<SystemMonitorConfig>): void {
    if (this._systemMonitor) {
      this._systemMonitor.updateConfig(partial);
      if (!this._systemMonitor.isEnabled()) {
        if (this._systemMonitorUnsub) {
          this._systemMonitorUnsub();
          this._systemMonitorUnsub = null;
        }
        this._systemMonitor = null;
      }
    } else if (partial.enabled) {
      const cfg: SystemMonitorConfig = {
        ...DEFAULT_SYSTEM_MONITOR_CONFIG,
        ...partial,
        thresholds: {
          ...DEFAULT_SYSTEM_MONITOR_CONFIG.thresholds,
          ...partial.thresholds,
        },
      };
      this._systemMonitor = new SystemMonitor(cfg);
      this._systemMonitorUnsub = this._systemMonitor.onLevelChange((status) => {
        this.handleSystemMonitorLevelChange(status);
      });
      this._systemMonitor.start();
    }
  }

  /** 释放系统监控资源（停止后台采样、取消订阅）。 */
  /** Dispose system monitor: stop background sampling and unsubscribe. */
  dispose(): void {
    if (this._systemMonitorUnsub) {
      this._systemMonitorUnsub();
      this._systemMonitorUnsub = null;
    }
    if (this._systemMonitor) {
      this._systemMonitor.stop();
      this._systemMonitor = null;
    }
  }

  /**
   * 共享父 agent 的 SystemMonitor 实例（不启动新采样）。
   * 子 agent 用此方法获得同一主机的监控状态，但不重复后台采样。
   */
  /**
   * Attach a shared SystemMonitor instance (without starting a new sampler).
   * Child agents use this to read the same host status without duplicate sampling.
   */
  attachSystemMonitor(monitor: SystemMonitor | null): void {
    // 不订阅级别变化 — 子 agent 的限流通过 systemMonitorLevel getter 实时读取
    // — Chinese: don't subscribe to level changes — child reads level via systemMonitorLevel getter
    this._systemMonitor = monitor;
  }

  /** Lazy Sandbox instance for exec policy evaluation. */
  private get sandbox(): Sandbox {
    if (!this._sandbox) {
      this._sandbox = new Sandbox(this.config.sandbox);
    }
    return this._sandbox;
  }

  /** Resolved effective sandbox level (from preset if set, else from config). */
  private get effectiveLevel(): SandboxLevel {
    return this._effectiveSandbox.level;
  }

  /** Resolved effective network access. */
  private get effectiveNetwork(): boolean {
    return this._effectiveSandbox.networkAllowed;
  }

  /** Resolved preset (if any). */
  private get preset(): PermissionPreset | undefined {
    return this.config.sandbox.preset;
  }

  private async requestAccess(
    threadId: ThreadId,
    turnId: TurnId,
    request: AccessRequest,
  ): Promise<AccessDecision> {
    const scopedRequest: AccessRequest = {
      ...request,
      workspaceRoot: request.workspaceRoot ?? this.config.workspaceRoot,
    };
    const decision = evaluateAccessRequest(this.runtimeAccessPolicy, scopedRequest);
    await this.appendAccessDecisionEvent(turnId, decision);
    if (decision.decision !== 'prompt') return decision;

    const requestId = runtimeApprovalId();
    const itemId = `approval_${turnId}_${Date.now()}`;
    const approvalReq = {
      requestId,
      threadId,
      turnId,
      itemId,
      kind: approvalKindForAccessRequest(scopedRequest),
      description: scopedRequest.description,
      payload: scopedRequest.target,
      decision: 'prompt' as const,
      justification: decision.justification,
      accessRequest: scopedRequest,
      temporaryGrantOptions: temporaryGrantOptionsForLocale(this.config.locale),
    };

    this.emit({
      type: 'approval.required',
      threadId,
      turnId,
      itemId,
      requestId,
      kind: approvalReq.kind,
      description: approvalReq.description,
      payload: approvalReq.payload,
      decision: 'prompt',
      justification: decision.justification,
      accessRequest: scopedRequest,
      temporaryGrantOptions: approvalReq.temporaryGrantOptions,
    });

    await this.appendRunMonitorEvent(turnId, {
      category: 'approval',
      type: 'approval.required',
      message: scopedRequest.description,
      toolName: scopedRequest.toolName,
      metadata: {
        requestId,
        status: 'required',
        kind: approvalReq.kind,
        access: scopedRequest.access,
        target: scopedRequest.target,
        toolName: scopedRequest.toolName,
      },
    });

    const approval = await this.config.approvalHandler.requestApproval(approvalReq);
    const temporaryScope = approval.temporaryScope ?? 'tool_call';
    const grant = this.createTemporaryGrant(scopedRequest, approval.approved ? 'allow' : 'deny', temporaryScope);
    this.runtimeAccessPolicy.temporaryGrants.push(grant);
    if (approval.approved && approval.persistentScope) {
      // API 端已先落盘规则；当前 Agent 也立即持有等价规则，避免同一轮后续同类
      // 操作再次等待审批。下一次创建 Agent 时会从持久化配置重新加载该规则。
      this.runtimeAccessPolicy.persistentRules.push(
        this.createRuntimePersistentRule(scopedRequest, approval.persistentScope),
      );
    }

    await this.appendRunMonitorEvent(turnId, {
      category: 'approval',
      type: approval.approved ? 'access.temporary_grant' : 'access.temporary_deny',
      level: approval.approved ? 'info' : 'warning',
      message: approval.approved ? `Temporary access granted for ${scopedRequest.toolName ?? scopedRequest.access}` : `Temporary access denied for ${scopedRequest.toolName ?? scopedRequest.access}`,
      toolName: scopedRequest.toolName,
      metadata: {
        requestId,
        scope: temporaryScope,
        persistentScope: approval.persistentScope,
        access: scopedRequest.access,
        target: scopedRequest.target,
        toolName: scopedRequest.toolName,
        grantId: grant.id,
      },
    });

    if (approval.approved) {
      return {
        decision: 'allow',
        request: scopedRequest,
        source: 'temporary_grant',
        matchedRuleId: grant.id,
        matchedRuleScope: grant.scope,
        justification: approval.reason ?? '临时授权通过',
      };
    }

    return {
      decision: 'deny',
        request: scopedRequest,
      source: 'temporary_grant',
      matchedRuleId: grant.id,
      matchedRuleScope: grant.scope,
      justification: approval.reason ?? '用户拒绝临时授权',
    };
  }

  private createTemporaryGrant(
    request: AccessRequest,
    effect: TemporaryAccessGrant['effect'],
    scope: TemporaryAccessScope,
  ): TemporaryAccessGrant {
    return {
      id: `temp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      effect,
      access: request.access,
      target: request.target,
      scope,
      threadId: request.threadId,
      turnId: request.turnId,
      toolCallId: request.toolCallId,
      createdAt: new Date().toISOString(),
    };
  }

  private createRuntimePersistentRule(request: AccessRequest, scope: PersistentAccessScope): AccessRule {
    const now = new Date().toISOString();
    return {
      id: `runtime_persistent_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      effect: 'allow',
      access: request.access,
      target: request.target,
      scope,
      ...(scope === 'thread' ? { threadId: request.threadId } : {}),
      ...(scope === 'workspace' && request.workspaceRoot ? { workspaceRoot: request.workspaceRoot } : {}),
      reason: '当前运行中由审批授予的类似操作规则',
      createdAt: now,
      updatedAt: now,
    };
  }

  private async appendAccessDecisionEvent(turnId: TurnId, decision: AccessDecision): Promise<void> {
    await this.appendRunMonitorEvent(turnId, {
      category: 'approval',
      type: 'access.decision',
      level: decision.decision === 'deny' ? 'warning' : 'info',
      message: decision.justification,
      toolName: decision.request.toolName,
      metadata: {
        decision: decision.decision,
        source: decision.source,
        matchedRuleId: decision.matchedRuleId,
        matchedRuleScope: decision.matchedRuleScope,
        access: decision.request.access,
        target: decision.request.target,
        toolName: decision.request.toolName,
        agentThreadId: decision.request.agentThreadId ?? decision.request.threadId,
        agentRole: decision.request.agentRole ?? null,
      },
    });
  }

  /** Get the current locale. */
  get locale(): Locale {
    return this.config.locale;
  }

  private initialVisibleToolNames(): Set<string> {
    const names = new Set<string>([TOOL_SEARCH_TOOL_NAME]);
    for (const name of this.config.initialTools) {
      const resolved = resolveToolName(this.tools, name);
      if (this.tools.get(resolved)) {
        names.add(resolved);
      }
    }
    return names;
  }

  /** Get the i18n context (for UI to translate messages). */
  get i18nContext(): I18n {
    return this.i18n;
  }

  /** Access the SAO experience engine (for external recording/querying and harness loops). */
  get experienceEngine(): ExperienceEngine {
    return this._experienceEngine;
  }

  /** Access the skill executor for external/API skill invocation. */
  get skillExecutor(): SkillExecutor {
    return this._skillExecutor;
  }

  /** Return all currently loaded skills (both prompt and executable). */
  getLoadedSkills(): LoadedSkill[] {
    return [...this.loadedSkills];
  }

  /** Register a set of loaded skills (merges by name, overwriting). Also registers their prompt bodies into the configured SkillRegistry for prompt injection. */
  registerSkills(skills: LoadedSkill[]): void {
    for (const skill of skills) {
      const idx = this.loadedSkills.findIndex((s) => s.name === skill.name);
      if (idx >= 0) this.loadedSkills[idx] = skill;
      else this.loadedSkills.push(skill);
    }
    registerSkillsToRegistry(this.config.skills, skills);
  }

  /** Scan all configured skillsDirs, discover SKILL.md files, load executable modules, and register them. Returns total loaded count. */
  async loadSkillsFromConfiguredDirs(): Promise<number> {
    let total = 0;
    for (const dir of this.config.skillsDirs) {
      total += await this.loadSkillsFromDirectory(dir);
    }
    return total;
  }

  /** Discover and load skills from a single directory. Registers both prompt and executable skills. Returns count. */
  async loadSkillsFromDirectory(skillsDir: string): Promise<number> {
    try {
      const { skills, errors } = await discoverSkills(skillsDir);
      for (const err of errors) {
        console.warn(`[skill-loader] failed to parse skill ${err.name}: ${err.error}`);
      }
      const modErrors = await loadAllSkillModules(skills);
      for (const err of modErrors) {
        console.warn(`[skill-loader] failed to load module for ${err.name}: ${err.error}`);
      }
      this.registerSkills(skills);
      return skills.length;
    } catch (err) {
      console.warn(`[skill-loader] failed to scan ${skillsDir}:`, err);
      return 0;
    }
  }

  /** Get the thread state for a given thread. */
  getThreadState(threadId: ThreadId): ThreadState {
    return this.stateManager.get(threadId);
  }

  /**
   * 计算当前线程的上下文压力（不触发压缩、不发送事件）。
   * 供前端在加载/切换对话时主动查询。
   */
  async getContextPressure(threadId: ThreadId): Promise<{
    estimatedTokens: number;
    maxTokens: number;
    softThreshold: number;
    hardThreshold: number;
    ratio: number;
    status: 'ok' | 'soft' | 'hard';
  }> {
    const recentItems = await this.config.store.getRecentItems(threadId, 200);
    const thread = await this.config.store.getThread(threadId);
    const effectiveRecentItems = filterEffectiveCompactionItems(recentItems, thread?.tags?.compactedRanges);
    const compactionOptions = compactionOptionsForModelContext(this.config.modelContextTokens);
    const rolloutPressure = getCompactionPressure(effectiveRecentItems, compactionOptions);
    const estimatedTokens = rolloutPressure.estimatedTokens;
    const ratio = rolloutPressure.maxTokens > 0 ? estimatedTokens / rolloutPressure.maxTokens : 1;
    return {
      ...rolloutPressure,
      estimatedTokens,
      ratio,
      status: estimatedTokens >= rolloutPressure.hardThreshold
        ? 'hard' as const
        : estimatedTokens >= rolloutPressure.softThreshold
          ? 'soft' as const
          : 'ok' as const,
    };
  }

  async rollbackThread(threadId: ThreadId, count: number = 1): Promise<{ removedTurns: number }> {
    const requestId = `rollback_${generateId()}`;
    await this.beginControlRun(requestId, threadId, 'Thread rollback');
    const fail = async (message: string, error?: unknown): Promise<never> => {
      const info = toSuanliziErrorInfo(error ?? new Error(message));
      this.emit({
        type: 'thread.rollback.failed',
        threadId,
        error: { message, info },
      });
      await this.appendRunMonitorEvent(requestId, {
        category: 'rollback',
        type: 'rollback.failed',
        level: 'error',
        message,
        metadata: { requestId, count, status: 'failed', error: message },
      });
      await this.finishRunMonitor(requestId, 'failed', null, error ?? new Error(message));
      throw new Error(message);
    };

    if (!Number.isFinite(count) || count <= 0) {
      return fail('rollback count must be >= 1');
    }
    if (this.stateManager.isRunning(threadId)) {
      return fail(`Thread ${threadId} is running; rollback is not allowed during an active turn`);
    }
    if (!this.stateManager.beginRollback(threadId, requestId)) {
      return fail(`Thread ${threadId} already has a pending rollback`);
    }

    await this.appendRunMonitorEvent(requestId, {
      category: 'rollback',
      type: 'rollback.started',
      message: 'Thread rollback started',
      metadata: { requestId, count, status: 'started' },
    });
    try {
      const thread = await this.config.store.getThread(threadId);
      const result = await rollbackTurns(threadId, this.config.store, count);
      this.emit({
        type: 'thread.rollback.completed',
        threadId,
        checkpointTurnCount: Math.max(0, (thread?.turnCount ?? 0) - result.removedTurns),
      });
      await this.appendRunMonitorEvent(requestId, {
        category: 'rollback',
        type: 'rollback.completed',
        message: 'Thread rollback completed',
        metadata: { requestId, count, removedTurns: result.removedTurns, status: 'completed' },
      });
      const newTurnCount = Math.max(0, (thread?.turnCount ?? 0) - result.removedTurns);
      await this.invalidateEpisodesForRollback(threadId, newTurnCount, requestId);
      await this.finishRunMonitor(requestId, 'completed', null);
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return fail(message, error);
    } finally {
      this.stateManager.finishRollback(threadId, requestId);
    }
  }

  async getRuntimeState(threadId: ThreadId): Promise<ThreadRuntimeState> {
    const state = this.stateManager.get(threadId);
    const checkpoint = state.lastCheckpoint ?? await this.config.store.getLastCheckpoint(threadId);
    const stale = Boolean(checkpoint?.status === 'running' && checkpoint.expiresAt && checkpoint.expiresAt < new Date().toISOString());
    const status = stale
      ? 'stale'
      : state.status === 'idle' && (checkpoint?.executionStatus === 'running' || checkpoint?.status === 'running')
        ? 'running'
        : state.status === 'idle' && (checkpoint?.executionStatus === 'stopping' || checkpoint?.status === 'stopping')
          ? 'stopping'
          : state.status === 'idle' && (checkpoint?.executionStatus === 'waiting_user_input' || checkpoint?.status === 'waiting_user_input')
            ? 'waiting_user_input'
        : state.status === 'idle' && checkpoint?.executionStatus === 'terminal'
          ? 'terminal'
          : state.status === 'terminal'
            ? state.terminalStatus ?? 'completed'
            : state.status;
    const executionStatus: ThreadExecutionStatus = stale
      ? 'terminal'
      : state.status === 'running' || state.status === 'stopping' || state.status === 'waiting_user_input'
        ? state.status
        : state.status === 'terminal'
          ? 'terminal'
          : checkpoint?.executionStatus ?? (checkpoint?.status === 'running' ? 'running' : checkpoint?.status === 'stopping' ? 'stopping' : checkpoint?.status === 'waiting_user_input' ? 'waiting_user_input' : checkpoint?.status === 'terminal' ? 'terminal' : 'idle');
    return {
      threadId,
      status,
      checkpoint: checkpoint ? { ...checkpoint, status: stale ? 'stale' : checkpoint.status } : null,
      resumable: Boolean(checkpoint && (checkpoint.status === 'running' || checkpoint.status === 'waiting_user_input') && !stale),
      stale,
      executionStatus,
      terminalStatus: state.terminalStatus ?? undefined,
      decisionRequest: state.pendingDecision ?? checkpoint?.decisionRequest ?? null,
    };
  }

  /** Request interruption; terminal state is emitted only after the run observes cancellation. */
  interrupt(threadId: ThreadId, requestId?: string): boolean {
    const state = this.stateManager.get(threadId);
    if (!this.stateManager.isRunning(threadId) || !state.activeTurnId) return false;
    const turnId = state.activeTurnId;
    this.stateManager.interruptTurn(threadId, turnId, requestId ?? generateId());
    const pendingDecision = this.pendingDecisionResolvers.get(threadId);
    if (pendingDecision) {
      this.pendingDecisionResolvers.delete(threadId);
      pendingDecision.reject(new Error('Turn cancelled'));
    }
    for (const [childThreadId, childAgent] of this.childAgentsByParent.get(threadId)?.entries() ?? []) {
      childAgent.interrupt(childThreadId);
    }
    const session = this.runMonitorSessions.get(turnId);
    const runId = session?.runId ?? `run_${turnId}`;
    this.emit({ type: 'thread.runtime.updated', threadId, turnId, runId, status: 'stopping' });
    // A state-only caller (mostly recovery/tests) has no active promise that
    // can publish the terminal event. Real runs publish it from runTurn's
    // cancellation path after the provider has actually stopped.
    if (!session && state.lastCheckpoint?.status !== 'running') {
      this.emit({ type: 'turn.completed', threadId, turnId, runId, usage: null, status: 'interrupted' });
    }
    const checkpoint = state.lastCheckpoint;
    if (checkpoint) {
      const stoppingCheckpoint: Checkpoint = {
        ...checkpoint,
        timestamp: new Date().toISOString(),
        status: 'stopping',
        executionStatus: 'stopping',
      };
      void this.writeCheckpoint(threadId, stoppingCheckpoint).catch(() => undefined);
    }
    return true;
  }

  /** Ask the user for a durable, resumable decision inside the current turn. */
  async waitForUserDecision(
    threadId: ThreadId,
    input: Omit<AgentDecisionRequest, 'requestId' | 'threadId' | 'turnId' | 'runId' | 'createdAt' | 'status'>,
  ): Promise<AgentDecisionResponse> {
    const state = this.stateManager.get(threadId);
    if (!state.activeTurnId || !['running', 'waiting_user_input'].includes(state.status)) {
      throw new Error(`Thread ${threadId} has no active turn to wait for a decision`);
    }
    if (this.pendingDecisionResolvers.has(threadId)) {
      throw new Error(`Thread ${threadId} already has a pending decision`);
    }
    const request: AgentDecisionRequest = {
      ...input,
      requestId: `decision_${generateId()}`,
      threadId,
      turnId: state.activeTurnId,
      createdAt: new Date().toISOString(),
      status: 'pending',
    };
    this.stateManager.waitForUserInput(threadId, state.activeTurnId, request);
    const checkpoint = this.withCheckpointState(threadId, state.activeTurnId, await this.config.store.getItems(threadId).then((items) => items.length), 'waiting_user_input');
    checkpoint.decisionRequest = request;
    checkpoint.executionStatus = 'waiting_user_input';
    await this.writeCheckpoint(threadId, checkpoint);
    const runId = this.runMonitorSessions.get(state.activeTurnId)?.runId;
    const pending = new Promise<AgentDecisionResponse>((resolve, reject) => {
      this.pendingDecisionResolvers.set(threadId, { request: { ...request, runId }, resolve, reject });
    });
    this.emit({ type: 'agent.decision.requested', threadId, turnId: state.activeTurnId, request: { ...request, runId } });
    this.emit({ type: 'thread.runtime.updated', threadId, turnId: state.activeTurnId, runId, status: 'waiting_user_input', decisionRequest: { ...request, runId } });
    return pending;
  }

  /** Stable public alias used by tool/extension integrations. */
  requestDecision(
    threadId: ThreadId,
    input: Omit<AgentDecisionRequest, 'requestId' | 'threadId' | 'turnId' | 'runId' | 'createdAt' | 'status'>,
  ): Promise<AgentDecisionResponse> {
    return this.waitForUserDecision(threadId, input);
  }

  /** Resolve an in-process decision; cold-start callers can use resumeRunning with the same checkpoint. */
  async resolveUserDecision(threadId: ThreadId, response: AgentDecisionResponse): Promise<{ accepted: boolean; resumed: boolean }> {
    const state = this.stateManager.get(threadId);
    const pending = this.pendingDecisionResolvers.get(threadId);
    const persistedCheckpoint = await this.config.store.getLastCheckpoint(threadId);
    const request = pending?.request ?? state.pendingDecision ?? persistedCheckpoint?.decisionRequest;
    if (!request || request.requestId !== response.requestId) return { accepted: false, resumed: false };
    const persistedWaiting = persistedCheckpoint?.status === 'waiting_user_input' || persistedCheckpoint?.executionStatus === 'waiting_user_input';
    if (!['waiting_user_input', 'running'].includes(state.status) && !pending && !persistedWaiting) return { accepted: false, resumed: false };
    const resolved: AgentDecisionRequest = {
      ...request,
      status: response.action === 'cancel' ? 'cancelled' : 'resolved',
      resolvedAt: new Date().toISOString(),
      selectedAction: response.action,
      selectedOptionId: response.optionId,
      customInput: response.customInput,
    };
    if (pending) {
      this.pendingDecisionResolvers.delete(threadId);
      this.stateManager.resumeAfterUserInput(threadId, request.turnId);
      pending.resolve(response);
    }
    const checkpoint = this.withCheckpointState(threadId, request.turnId, (await this.config.store.getItems(threadId)).length, 'running');
    checkpoint.decisionRequest = resolved;
    checkpoint.executionStatus = pending ? 'running' : 'waiting_user_input';
    await this.writeCheckpoint(threadId, checkpoint);
    this.emit({ type: 'agent.decision.resolved', threadId, turnId: request.turnId, requestId: response.requestId, action: response.action, optionId: response.optionId, customInput: response.customInput });
    this.emit({ type: 'thread.runtime.updated', threadId, turnId: request.turnId, status: pending ? 'running' : 'waiting_user_input', decisionRequest: resolved });
    if (!pending) {
      await this.resumeRunning(threadId, { type: 'text', text: decisionResponseText(response) });
      return { accepted: true, resumed: true };
    }
    return { accepted: true, resumed: false };
  }

  /** Stable public alias for API/control adapters. */
  submitDecision(threadId: ThreadId, response: AgentDecisionResponse): Promise<{ accepted: boolean; resumed: boolean }> {
    return this.resolveUserDecision(threadId, response);
  }

  /**
   * Resume a running turn after an interrupt, using the last checkpoint
   * to skip already-completed items.
   */
  async resumeRunning(
    threadId: ThreadId,
    userInput?: UserInput,
    signal?: AbortSignal,
  ): Promise<{ items: ThreadItem[]; usage: Usage | null }> {
    const state = this.stateManager.get(threadId);
    let ckpt = state.lastCheckpoint;
    if (!ckpt) {
      ckpt = await this.config.store.getLastCheckpoint(threadId);
      if (ckpt) {
        this.stateManager.setCheckpoint(threadId, ckpt);
      }
    }

    if (!ckpt) {
      if (!userInput) {
        throw new Error(`Thread ${threadId} has no checkpoint to resume`);
      }
      return this.runTurn(threadId, userInput, signal);
    }

    const thread = await this.config.store.getThread(threadId);
    if (!thread) throw new Error(`Thread ${threadId} not found`);

    const turnId = ckpt.turnId;
    if (!userInput) {
      const turns = await this.config.store.getTurns(threadId);
      userInput = turns.find((turn) => turn.turnId === turnId)?.userInput;
      if (!userInput) {
        throw new Error(`Turn ${turnId} has no persisted user input to resume`);
      }
    }

    // Rehydrate already completed items so item ids remain stable.
    // 重新恢复已完成的条目，保持条目 id 稳定不变。
    const allItems = await this.config.store.getItems(threadId);
    const collectedItems: ThreadItem[] = allItems.slice(0, ckpt.itemIndex);
    const recentKnowledgeItems = allItems.slice(-80);

    // Clear interrupts and restart
    // 清除中断并重启
    this.stateManager.clearPendingInterrupts(threadId);
    const cancelController = this.stateManager.startTurn(threadId, turnId);
    const effectiveSignal = combineAbortSignals(signal, cancelController.signal);

    this.emit({
      type: 'thread.resumed',
      threadId,
      turnIndex: thread.turnCount,
    });

    const updatedCkpt: Checkpoint = this.withCheckpointState(threadId, turnId, ckpt.itemIndex, 'running');
    const runtimeContext = await this.createRuntimeTurnContext(
      threadId,
      turnId,
      thread,
      userInput,
      updatedCkpt,
      collectedItems,
    );
    await this.beginRunMonitor({ threadId, turnId, title: thread.title, userInput });
    const resumeRunId = `run_${turnId}`;
    await this.maybeEmitWorkingSetRestored(threadId, turnId);

    const webSearchRecommended = shouldEnableWebSearch(this.config.webSearchMode, userInput);
    const webSearchToolAvailable = this.shouldOfferWebSearchTool();
    const messages = await this.buildMessages(threadId, userInput, thread, webSearchRecommended);
    let terminalTurnResult: RuntimeTurnResult | null = null;

    try {
      await this.appendRunMonitorEvent(turnId, {
        category: 'middleware',
        type: 'middleware.beforeTurn',
        message: 'beforeTurn middleware started',
      });
      await this.runtimeMiddleware.beforeTurn(runtimeContext);
      // 发 task.runtime.updated phase=before_turn — 普通 /turn 也会发，但不代表进入 harness
      this.emitTaskRuntimeUpdated(threadId, turnId, 'before_turn', 'running');
      const result = await this.agentLoop(
        threadId,
        turnId,
        messages,
        collectedItems,
        effectiveSignal,
        updatedCkpt,
        webSearchToolAvailable,
        runtimeContext,
        recentKnowledgeItems,
      );
      const turns = await this.config.store.getTurns(threadId);
      const turn = turns.find((candidate) => candidate.turnId === turnId);
      if (turn) {
        turn.status = 'completed';
        turn.completedAt = new Date().toISOString();
        await this.config.store.saveTurn(turn);
      }
      await this.writeCheckpoint(threadId, this.withCheckpointState(threadId, turnId, collectedItems.length, 'completed'));
      this.stateManager.completeTurn(threadId, turnId);
      this.emit({ type: 'thread.runtime.updated', threadId, turnId, runId: resumeRunId, status: 'terminal', terminalStatus: 'completed' });
      if (result.usage) await this.recordUsage(threadId, turnId, result.usage);
      this.emit({ type: 'turn.completed', threadId, turnId, runId: resumeRunId, usage: result.usage });
      this.emitTaskRuntimeUpdated(threadId, turnId, 'after_turn', 'completed');
      this.emitTaskRuntimeUpdated(threadId, turnId, 'idle', 'completed');
      terminalTurnResult = { status: 'completed', usage: result.usage };
      await this.finishRunMonitor(turnId, 'completed', result.usage);
      const resumedTurnIndex = turn?.index ?? thread.turnCount;
      await this.updateEpisodeFromCompletedTurn(thread, turnId, resumedTurnIndex, userInput, collectedItems);
      await this.maybeExtractColdMemories(thread, turnId, userInput, collectedItems);
      await this.finishTurnLifecycle(runtimeContext, terminalTurnResult);
      return result;
    } catch (err) {
      if (terminalTurnResult) throw err;
      if (isTurnCancelledError(err)) {
        const turns = await this.config.store.getTurns(threadId);
        const turn = turns.find((candidate) => candidate.turnId === turnId);
        if (turn) {
          turn.status = 'interrupted';
          turn.completedAt = new Date().toISOString();
          await this.config.store.saveTurn(turn);
        }
        await this.writeCheckpoint(threadId, this.withCheckpointState(threadId, turnId, collectedItems.length, 'interrupted'));
        this.stateManager.completeInterruptedTurn(threadId, turnId);
        this.emit({ type: 'thread.runtime.updated', threadId, turnId, runId: resumeRunId, status: 'terminal', terminalStatus: 'interrupted' });
        this.emit({ type: 'turn.completed', threadId, turnId, runId: resumeRunId, usage: null, status: 'interrupted' });
        this.emitTaskRuntimeUpdated(threadId, turnId, 'after_turn', 'interrupted');
        this.emitTaskRuntimeUpdated(threadId, turnId, 'idle', 'interrupted');
        terminalTurnResult = { status: 'interrupted', usage: null, error: err };
        await this.finishRunMonitor(turnId, 'interrupted', null, err);
        await this.finishTurnLifecycle(runtimeContext, terminalTurnResult);
        return { items: collectedItems, usage: null };
      }
      if (isRecoverableStreamError(err)) {
        const info = toSuanliziErrorInfo(err);
        const message = err instanceof Error ? err.message : String(err);
        const turns = await this.config.store.getTurns(threadId);
        const turn = turns.find((candidate) => candidate.turnId === turnId);
        if (turn) {
          turn.status = 'interrupted';
          turn.completedAt = new Date().toISOString();
          await this.config.store.saveTurn(turn);
        }
        await this.writeCheckpoint(threadId, this.withCheckpointState(threadId, turnId, collectedItems.length, 'interrupted'));
        this.stateManager.completeInterruptedTurn(threadId, turnId);
        this.emit({ type: 'thread.runtime.updated', threadId, turnId, runId: resumeRunId, status: 'terminal', terminalStatus: 'interrupted' });
        this.emit({
          type: 'stream.error',
          threadId,
          turnId,
          message,
          recoverable: true,
          error: { message, info },
        });
        this.emit({ type: 'turn.completed', threadId, turnId, runId: resumeRunId, usage: null, status: 'interrupted' });
        this.emitTaskRuntimeUpdated(threadId, turnId, 'after_turn', 'interrupted');
        this.emitTaskRuntimeUpdated(threadId, turnId, 'idle', 'interrupted');
        await this.appendRunMonitorEvent(turnId, {
          category: 'model',
          type: 'stream.error',
          level: 'warning',
          message,
          metadata: { info, recoverable: true },
        });
        terminalTurnResult = { status: 'interrupted', usage: null, error: err };
        await this.finishRunMonitor(turnId, 'interrupted', null, err);
        await this.finishTurnLifecycle(runtimeContext, terminalTurnResult);
        return { items: collectedItems, usage: null };
      }
      const errorMsg = String(err);
      const errorInfo = toSuanliziErrorInfo(err);
      this.stateManager.failTurn(threadId, turnId, {
        message: errorMsg,
        timestamp: new Date().toISOString(),
      });
      this.emit({ type: 'thread.runtime.updated', threadId, turnId, runId: resumeRunId, status: 'terminal', terminalStatus: 'failed' });
      await this.writeCheckpoint(threadId, this.withCheckpointState(threadId, turnId, collectedItems.length, 'failed'));
      this.emit({
        type: 'turn.failed',
        threadId,
        turnId,
        runId: resumeRunId,
        error: { message: errorMsg, info: errorInfo },
      });
      this.emitTaskRuntimeUpdated(threadId, turnId, 'after_turn', 'failed');
      this.emitTaskRuntimeUpdated(threadId, turnId, 'idle', 'failed');
      terminalTurnResult = { status: 'failed', usage: null, error: err };
      await this.finishRunMonitor(turnId, 'failed', null, err);
      try {
        await this.finishTurnLifecycle(runtimeContext, terminalTurnResult);
      } catch {
        // Preserve the original turn failure after afterTurn has had a chance to run.
        // 在 afterTurn 有机会执行后保留原始回合失败信息。
      }
      throw err;
    }
  }

  /**
   * Register a listener for streaming events.
   * 返回 unsubscribe 函数，调用后移除该监听器。
   * — Chinese: register listener; returns unsubscribe function.
   */
  onEvent(listener: (event: ThreadEvent) => void): () => void {
    this.eventListeners.push(listener);
    let unsubscribed = false;
    return () => {
      if (unsubscribed) return;
      unsubscribed = true;
      const idx = this.eventListeners.indexOf(listener);
      if (idx >= 0) this.eventListeners.splice(idx, 1);
    };
  }

  /** Emit an event to all listeners. */
  private emit(event: ThreadEvent): void {
    // Provider/tool callbacks can resolve after cancellation. Once a turn is
    // terminal, discard late item/delta events so they cannot enter a later turn.
    if ('threadId' in event && typeof event.threadId === 'string' && 'turnId' in event && typeof event.turnId === 'string') {
      const state = this.stateManager.get(event.threadId);
      const lifecycle = event.type === 'turn.completed'
        || event.type === 'turn.failed'
        || event.type === 'thread.runtime.updated'
        || event.type === 'task.runtime.updated'
        || event.type === 'stream.error'
        || event.type === 'agent.decision.resolved';
      if (state.activeTurnId !== event.turnId && state.lastTerminalTurnId === event.turnId && !lifecycle) return;
    }
    for (const listener of this.eventListeners) {
      try {
        listener(event);
      } catch {
        // don't let listener errors crash the loop
        // 不让监听器错误导致循环崩溃
      }
    }
  }

  /**
   * 发 task.runtime.updated 事件（第 2 步事件骨架）。
   * 只发 phase/status 等元数据，不发完整 prompt。
   * 普通 /turn 也会发，但不代表进入 harness —— harness 只是 runtime 底座里的约束/证据/验收层。
   * — English: emit task.runtime.updated skeleton event, metadata only.
   */
  private emitTaskRuntimeUpdated(
    threadId: ThreadId,
    turnId: TurnId | undefined,
    phase: 'before_turn' | 'model' | 'tool' | 'compact' | 'after_turn' | 'idle',
    status: 'running' | 'completed' | 'failed' | 'interrupted',
  ): void {
    this.emit({
      type: 'task.runtime.updated',
      threadId,
      turnId,
      phase,
      status,
      timestamp: new Date().toISOString(),
    });
  }

  private discardTransientItem(
    threadId: ThreadId,
    turnId: TurnId,
    collectedItems: ThreadItem[],
    itemId?: string,
  ): void {
    if (!itemId) return;
    const itemIndex = collectedItems.findIndex((item) => item.id === itemId);
    const discardedItem = itemIndex >= 0 ? collectedItems[itemIndex] : null;
    if (itemIndex >= 0) collectedItems.splice(itemIndex, 1);
    this.emit({ type: 'item.discarded', threadId, turnId, itemId });
    if (discardedItem) {
      void this.appendItemRunMonitorEvent(threadId, turnId, discardedItem, 'item.discarded');
    }
  }

  private async beginRunMonitor(options: {
    threadId: ThreadId;
    turnId: TurnId;
    title: string;
    userInput: UserInput;
  }): Promise<string> {
    const now = new Date().toISOString();
    const runId = `run_${options.turnId}`;
    const session = {
      runId,
      runKind: 'turn' as const,
      threadId: options.threadId,
      turnId: options.turnId,
      sequence: 0,
      startedAt: now,
      modelCallCount: 0,
      toolCallCount: 0,
      subagentCount: 0,
      middlewareEventCount: 0,
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      reasoningOutputTokens: 0,
      traceSession: this.createRunTraceSession({
        runId,
        runKind: 'turn',
        threadId: options.threadId,
        turnId: options.turnId,
      }),
    };
    this.runMonitorSessions.set(options.turnId, session);
    await this.safeMonitorWrite(async () => {
      const record: RunRecord = {
        runId,
        tenantId: this.config.tenantId,
        threadId: options.threadId,
        turnId: options.turnId,
        kind: 'turn',
        status: 'running',
        title: options.title,
        caller: 'lead_agent',
        activeStep: 'turn',
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0,
        reasoningOutputTokens: 0,
        toolCallCount: 0,
        modelCallCount: 0,
        subagentCount: 0,
        middlewareEventCount: 0,
        firstHumanMessage: truncateMonitorText(userInputToText(options.userInput)),
        startedAt: now,
        updatedAt: now,
        metadata: { locale: this.config.locale },
      };
      await this.config.store.createRunRecord?.(record);
    });
    await this.appendRunMonitorEvent(options.turnId, {
      category: 'turn',
      type: 'turn.started',
      level: 'info',
      message: 'Turn started',
      metadata: { tenantId: this.config.tenantId },
    });
    return runId;
  }

  private async beginControlRun(runKey: TurnId, threadId: ThreadId, title: string): Promise<void> {
    const now = new Date().toISOString();
    const runId = `run_${runKey}`;
    const session = {
      runId,
      runKind: 'control' as const,
      threadId,
      turnId: runKey,
      sequence: 0,
      startedAt: now,
      modelCallCount: 0,
      toolCallCount: 0,
      subagentCount: 0,
      middlewareEventCount: 0,
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      reasoningOutputTokens: 0,
      traceSession: this.createRunTraceSession({
        runId,
        runKind: 'control',
        threadId,
        turnId: null,
      }),
    };
    this.runMonitorSessions.set(runKey, session);
    await this.safeMonitorWrite(async () => {
      await this.config.store.createRunRecord?.({
        runId,
        tenantId: this.config.tenantId,
        threadId,
        turnId: null,
        kind: 'control',
        status: 'running',
        title,
        caller: 'lead_agent',
        activeStep: 'rollback',
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0,
        reasoningOutputTokens: 0,
        toolCallCount: 0,
        modelCallCount: 0,
        subagentCount: 0,
        middlewareEventCount: 0,
        startedAt: now,
        updatedAt: now,
        metadata: { tenantId: this.config.tenantId },
      });
    });
  }

  private async appendRunMonitorEvent(turnId: TurnId, event: {
    category: RunEvent['category'];
    type: string;
    level?: RunEventLevel;
    message: string;
    toolName?: string | null;
    model?: string | null;
    durationMs?: number | null;
    metadata?: Record<string, unknown>;
  }): Promise<void> {
    const session = this.runMonitorSessions.get(turnId);
    if (!session) return;
    if (event.type.startsWith('middleware.system_monitor') && !this._systemMonitor?.isLogRecordingEnabled()) return;
    session.sequence += 1;
    if (event.category === 'model') session.modelCallCount += event.type === 'model.started' ? 1 : 0;
    if (event.category === 'tool') session.toolCallCount += event.type.endsWith('.started') ? 1 : 0;
    if (event.category === 'subagent') session.subagentCount += event.type.endsWith('.started') ? 1 : 0;
    if (event.category === 'middleware') session.middlewareEventCount += 1;
    const createdAt = new Date().toISOString();
    await this.safeMonitorWrite(async () => {
      await this.config.store.appendRunEvent?.({
        eventId: `${session.runId}_event_${session.sequence}`,
        runId: session.runId,
        tenantId: this.config.tenantId,
        threadId: session.threadId,
        turnId: session.turnId,
        sequence: session.sequence,
        category: event.category,
        type: event.type,
        level: event.level ?? 'info',
        message: event.message,
        toolName: event.toolName ?? null,
        model: event.model ?? null,
        durationMs: event.durationMs ?? null,
        metadata: event.metadata ?? {},
        createdAt,
      });
      await this.config.store.updateRunRecord?.(session.runId, {
        activeStep: event.category,
        updatedAt: createdAt,
        toolCallCount: session.toolCallCount,
        modelCallCount: session.modelCallCount,
        subagentCount: session.subagentCount,
        middlewareEventCount: session.middlewareEventCount,
      });
    });
    await this.appendRunTraceFromMonitorEvent(session, event, createdAt);
  }

  private createRunTraceSession(options: {
    runId: string;
    runKind: RunTraceRunKind;
    threadId: ThreadId;
    turnId?: TurnId | null;
  }): RunTraceSession | null {
    const traceStore = this.config.store as ThreadStore & Partial<RunTraceStore>;
    if (!traceStore.appendRunTraceEvent || !this.config.store.updateRunRecord) return null;
    return new RunTraceSession({
      runId: options.runId,
      runKind: options.runKind,
      threadId: options.threadId,
      turnId: options.turnId,
      redaction: { workspaceRoot: this.config.workspaceRoot },
      sink: {
        append: (draft) => traceStore.appendRunTraceEvent!(draft),
        updateRun: async (runId, summary) => {
          await this.config.store.updateRunRecord?.(runId, {
            traceVersion: RUN_TRACE_VERSION,
            traceSummary: summary,
          });
        },
        publish: () => {},
        reportFailure: (error) => {
          this.emit({
            type: 'error',
            message: `Run trace write failed: ${error instanceof Error ? error.message : String(error)}`,
          });
        },
      },
    });
  }

  private modelProviderDiagnostics(): {
    provider: string;
    providerId: string;
    model: string;
    endpointFormat: string;
    transport: string;
    reasoningMode: string;
    toolHistoryMode: string;
  } {
    const model = this.config.model as ModelGateway & {
      getProfile?: () => ReturnType<ModelGateway['getProfile']>;
      getModelId?: () => string;
    };
    const profile = typeof model.getProfile === 'function' ? model.getProfile() : null;
    return {
      provider: profile?.id ?? 'unknown',
      providerId: profile?.id ?? 'unknown',
      model: typeof model.getModelId === 'function' ? model.getModelId() : 'unknown',
      endpointFormat: profile?.endpointFormat ?? 'unknown',
      transport: profile?.transport ?? 'unknown',
      reasoningMode: profile?.reasoningMode ?? 'none',
      toolHistoryMode: profile?.toolHistoryMode ?? 'unknown',
    };
  }

  private async appendRunTraceFromMonitorEvent(
    session: {
      runId: string;
      runKind: RunTraceRunKind;
      turnId: TurnId;
      traceSession: RunTraceSession | null;
    },
    event: {
      category: RunEvent['category'];
      type: string;
      level?: RunEventLevel;
      message: string;
      toolName?: string | null;
      model?: string | null;
      durationMs?: number | null;
      metadata?: Record<string, unknown>;
    },
    occurredAt: string,
  ): Promise<void> {
    if (!session.traceSession) return;
    const observation = this.runTraceObservationFromMonitorEvent(session.runId, session.runKind, session.turnId, event, occurredAt);
    if (!observation) return;
    await session.traceSession.record(observation);
  }

  private runTraceObservationFromMonitorEvent(
    runId: string,
    runKind: RunTraceRunKind,
    turnId: TurnId,
    event: {
      category: RunEvent['category'];
      type: string;
      level?: RunEventLevel;
      message: string;
      toolName?: string | null;
      model?: string | null;
      durationMs?: number | null;
      metadata?: Record<string, unknown>;
    },
    occurredAt: string,
  ): RunTraceObservation | null {
    const metadata = event.metadata ?? {};
    const lifecycle = monitorTypeToTraceLifecycle(event.type);
    const spanId = `span:${runId}:${event.category}:${monitorSpanSuffix(event, turnId)}`;
    const level = event.level ?? 'info';
    const base = {
      spanId,
      runKind,
      name: event.type,
      lifecycle,
      level,
      occurredAt,
      durationMs: event.durationMs ?? undefined,
    };

    if (event.category === 'turn') {
      return {
        ...base,
        category: 'turn',
        payload: {
          status: monitorTypeToTurnStatus(event.type),
          reason: level === 'error' ? event.message : undefined,
        },
      };
    }

    if (event.category === 'middleware') {
      return {
        ...base,
        category: 'middleware',
        payload: {
          middlewareId: String(metadata.middlewareId ?? event.type.split('.')[1] ?? 'runtime'),
          stage: monitorTypeToMiddlewareStage(event.type, level),
          attempt: numberMetadata(metadata.attempt),
        },
      };
    }

    if (event.category === 'model') {
      const usage = metadata.usage as Partial<Usage> | undefined;
      return {
        ...base,
        category: 'model',
        payload: {
          provider: String(metadata.provider ?? 'unknown'),
          providerId: String(metadata.providerId ?? metadata.provider ?? 'unknown'),
          model: event.model ?? String(metadata.model ?? 'unknown'),
          endpointFormat: stringMetadata(metadata.endpointFormat),
          transport: stringMetadata(metadata.transport),
          reasoningMode: stringMetadata(metadata.reasoningMode),
          toolHistoryMode: stringMetadata(metadata.toolHistoryMode),
          attempt: numberMetadata(metadata.attempt) ?? 1,
          streaming: metadata.streaming === undefined ? true : Boolean(metadata.streaming),
          inputTokens: usage?.inputTokens,
          outputTokens: usage?.outputTokens,
          cacheReadTokens: usage?.cachedInputTokens,
          finishReason: String(metadata.finishReason ?? ''),
        },
      };
    }

    if (event.category === 'tool') {
      return {
        ...base,
        category: 'tool',
        payload: {
          toolName: event.toolName ?? String(metadata.toolName ?? 'unknown'),
          callId: String(metadata.callId ?? metadata.itemId ?? spanId),
          resourceKind: traceResourceKindMetadata(metadata.resourceKind),
          server: stringMetadata(metadata.server),
          tool: stringMetadata(metadata.tool),
          skillName: stringMetadata(metadata.skillName),
          decision: metadata.decision as 'allow' | 'deny' | 'approval_required' | undefined,
          approvalId: metadata.approvalId == null ? undefined : String(metadata.approvalId),
          argsSummary: metadata.argsSummary,
          resultSummary: metadata.resultSummary ?? metadata.outputSummary,
          exitCode: numberMetadata(metadata.exitCode),
          outputBytes: numberMetadata(metadata.outputBytes),
        },
      };
    }

    if (event.category === 'item') {
      return {
        ...base,
        category: 'item',
        itemId: metadata.itemId == null ? undefined : String(metadata.itemId),
        payload: {
          itemType: String(metadata.itemType ?? 'agent_message') as ThreadItem['type'],
          status: event.type.split('.').at(-1),
        },
      };
    }

    if (event.category === 'subagent') {
      return {
        ...base,
        category: 'agent',
        payload: {
          agentThreadId: String(metadata.agentThreadId ?? metadata.threadId ?? 'unknown'),
          role: String(metadata.role ?? 'subagent'),
          action: monitorTypeToAgentAction(event.type, lifecycle),
          childRunId: metadata.childRunId == null ? undefined : String(metadata.childRunId),
        },
      };
    }

    if (event.category === 'file') {
      return {
        ...base,
        category: 'file',
        itemId: metadata.itemId == null ? undefined : String(metadata.itemId),
        payload: {
          action: traceFileAction(metadata.action ?? event.type.split('.')[1]),
          path: String(metadata.path ?? ''),
          sourcePath: stringMetadata(metadata.sourcePath),
          artifactPath: stringMetadata(metadata.artifactPath),
          sha256: stringMetadata(metadata.sha256),
          artifactSha256: stringMetadata(metadata.artifactSha256),
          staleReason: stringMetadata(metadata.staleReason),
          contentType: stringMetadata(metadata.contentType),
          extractor: stringMetadata(metadata.extractor),
          addedLines: numberMetadata(metadata.addedLines),
          removedLines: numberMetadata(metadata.removedLines),
        },
      } as RunTraceObservation;
    }

    if (event.category === 'checkpoint') {
      return {
        ...base,
        category: 'checkpoint',
        payload: {
          checkpointId: String(metadata.checkpointId ?? spanId),
          turnCount: numberMetadata(metadata.turnCount) ?? 0,
          itemIndex: numberMetadata(metadata.itemIndex) ?? 0,
          status: String(metadata.status ?? 'running') as CheckpointStatus,
        },
      };
    }

    if (event.category === 'approval') {
      return {
        ...base,
        category: 'approval',
        payload: {
          decision: traceApprovalDecision(metadata.decision),
          source: stringMetadata(metadata.source),
          matchedRuleId: stringMetadata(metadata.matchedRuleId),
          matchedRuleScope: stringMetadata(metadata.matchedRuleScope),
          requestId: stringMetadata(metadata.requestId),
          status: traceApprovalStatus(metadata.status ?? event.type),
          scope: stringMetadata(metadata.scope),
          grantId: stringMetadata(metadata.grantId),
          access: stringMetadata(metadata.access),
          target: metadata.target,
          toolName: event.toolName ?? stringMetadata(metadata.toolName),
          agentThreadId: stringMetadata(metadata.agentThreadId) as ThreadId | undefined,
          agentRole: metadata.agentRole == null ? undefined : String(metadata.agentRole),
        },
      };
    }

    if (event.category === 'control') {
      return {
        ...base,
        category: 'control',
        payload: {
          action: monitorTypeToControlAction(event.type),
          outcome: level === 'error' ? 'rejected' : 'completed',
          checkpointId: metadata.checkpointId == null ? undefined : String(metadata.checkpointId),
          reason: level === 'error' ? event.message : undefined,
        },
      };
    }

    if (level === 'error') {
      return {
        ...base,
        category: 'error',
        payload: {
          code: String(metadata.code ?? event.type.toUpperCase().replace(/[^A-Z0-9_]+/g, '_')),
          message: event.message,
          retryable: Boolean(metadata.retryable),
          source: event.category,
        },
      };
    }

    return null;
  }

  private async appendFileChangeRunMonitorEvents(
    turnId: TurnId,
    itemId: ItemId,
    toolName: 'write_file' | 'apply_patch',
    changes: NormalizedFileChange[],
  ): Promise<void> {
    for (const change of changes) {
      const action = change.kind === 'delete'
        ? 'delete'
        : toolName === 'write_file'
          ? 'write'
          : 'patch';
      await this.appendRunMonitorEvent(turnId, {
        category: 'file',
        type: `file.${action}`,
        message: `${action} file ${change.path}`,
        metadata: {
          itemId,
          action,
          path: change.path,
          addedLines: change.addedLines ?? 0,
          removedLines: change.removedLines ?? 0,
        },
      });
    }
  }

  private async appendFileLifecycleRunMonitorEvents(
    turnId: TurnId,
    itemId: ItemId,
    toolName: string,
    data: unknown,
  ): Promise<void> {
    const object = data && typeof data === 'object' ? data as Record<string, unknown> : {};
    if (toolName === 'read_file') {
      const file = object.file && typeof object.file === 'object' ? object.file as Record<string, unknown> : null;
      const freshness = object.freshness && typeof object.freshness === 'object' ? object.freshness as Record<string, unknown> : null;
      if (file?.path) {
        await this.appendRunMonitorEvent(turnId, {
          category: 'file',
          type: 'file.read',
          message: `Read file ${String(file.path)}`,
          metadata: {
            itemId,
            action: 'read',
            path: String(file.path),
            sha256: stringMetadata(file.sha256),
            contentType: stringMetadata(file.contentType),
          },
        });
      }
      if (freshness?.status === 'unmanaged_warning') {
        await this.appendRunMonitorEvent(turnId, {
          category: 'file',
          type: 'file.stale',
          level: 'warning',
          message: `Unmanaged derived artifact read: ${String(freshness.artifactPath ?? file?.path ?? '')}`,
          metadata: {
            itemId,
            action: 'stale',
            path: String(freshness.artifactPath ?? file?.path ?? ''),
            staleReason: 'unmanaged_artifact',
          },
        });
      }
      return;
    }

    if (toolName !== 'read_document') return;
    const source = object.source && typeof object.source === 'object' ? object.source as Record<string, unknown> : null;
    const artifact = object.artifact && typeof object.artifact === 'object' ? object.artifact as Record<string, unknown> : null;
    if (!source?.path || !artifact?.path) return;
    const stale = object.stale === true;
    const reused = object.reused === true;
    await this.appendRunMonitorEvent(turnId, {
      category: 'file',
      type: reused ? 'file.reuse' : stale ? 'file.refresh' : 'file.extract',
      level: stale ? 'warning' : 'info',
      message: reused
        ? `Reused document artifact for ${String(source.path)}`
        : stale
          ? `Refreshed document artifact for ${String(source.path)}`
          : `Extracted document ${String(source.path)}`,
      metadata: {
        itemId,
        action: reused ? 'reuse' : stale ? 'refresh' : 'extract',
        path: String(source.path),
        sourcePath: String(source.path),
        artifactPath: String(artifact.path),
        sha256: stringMetadata(source.sha256),
        artifactSha256: stringMetadata(artifact.sha256),
        contentType: stringMetadata(source.contentType),
        extractor: stringMetadata(artifact.extractor),
      },
    });
  }

  private async executePreflightDocumentReads(
    threadId: ThreadId,
    turnId: TurnId,
    collectedItems: ThreadItem[],
    documentPaths: string[],
  ): Promise<string[]> {
    const outputs: string[] = [];
    for (const documentPath of documentPaths) {
      const itemId = generateItemId(turnId, collectedItems.length);
      const args = { filePath: documentPath };
      const toolItem: ThreadItem = {
        id: itemId,
        type: 'tool_call',
        turnId,
        toolName: 'read_document',
        arguments: args,
        modelToolName: 'read_document',
        status: 'in_progress',
        timestamp: new Date().toISOString(),
      };
      collectedItems.push(toolItem);
      this.emit({ type: 'item.started', threadId, turnId, item: toolItem });
      void this.appendItemRunMonitorEvent(threadId, turnId, toolItem, 'item.started');
      await this.appendRunMonitorEvent(turnId, {
        category: 'tool',
        type: 'tool.started',
        message: `Preflight read_document started for ${documentPath}`,
        toolName: 'read_document',
        metadata: {
          itemId,
          argsSummary: redactMonitorArgs(args),
          resourceKind: 'tool',
          tool: 'read_document',
          preflight: true,
        },
      });

      const ctx: ToolContext = {
        workspaceRoot: this.config.workspaceRoot,
        threadId,
        turnId,
        approved: false,
        signal: this.stateManager.get(threadId).cancelController?.signal,
        webProvider: this.config.webProvider,
        accessPolicy: this.runtimeAccessPolicy,
        requestAccess: (request) => this.requestAccess(threadId, turnId, request),
        systemMonitor: this._systemMonitor ?? undefined,
      };
      const result = await this.tools.execute('read_document', args, ctx);
      this.completePreflightToolItem(toolItem, result);
      this.emit({ type: 'item.completed', threadId, turnId, item: toolItem });
      void this.appendItemRunMonitorEvent(threadId, turnId, toolItem, 'item.completed');
      await this.persistItems(threadId, [toolItem]);
      await this.appendRunMonitorEvent(turnId, {
        category: 'tool',
        type: result.status === 'failed' ? 'tool.failed' : 'tool.completed',
        level: result.status === 'failed' ? 'warning' : 'info',
        message: result.status === 'failed'
          ? `Preflight read_document failed for ${documentPath}`
          : `Preflight read_document completed for ${documentPath}`,
        toolName: 'read_document',
        metadata: {
          itemId,
          status: result.status,
          preflight: true,
          resultSummary: result.data ?? result.output,
        },
      });
      await this.appendFileLifecycleRunMonitorEvents(turnId, itemId, 'read_document', result.data);
      outputs.push([
        `read_document(${documentPath}) => ${result.status}`,
        formatToolHistoryPayload(result.data ?? result.output),
      ].join('\n'));
    }
    return outputs;
  }

  private completePreflightToolItem(toolItem: ThreadItem, result: ToolResult): void {
    (toolItem as ThreadItem & { status: ToolResult['status'] }).status = result.status;
    if (result.error) {
      (toolItem as ThreadItem & { error?: { message: string } }).error = result.error;
    }
    (toolItem as ThreadItem & { result?: unknown }).result = result.data ?? result.output;
  }

  // 为 item 生命周期事件追加 run monitor 审计记录
  // — English: append run monitor audit event for item lifecycle
  private async appendItemRunMonitorEvent(
    threadId: ThreadId,
    turnId: TurnId,
    item: ThreadItem,
    lifecycle: 'item.started' | 'item.updated' | 'item.completed' | 'item.discarded',
  ): Promise<void> {
    const session = this.runMonitorSessions.get(turnId);
    if (!session) return;
    const itemType = item.type;
    const itemId = (item as { id?: string }).id ?? '';
    const summary = this.summarizeItemForMonitor(item);
    await this.appendRunMonitorEvent(turnId, {
      category: 'item',
      type: lifecycle,
      level: lifecycle === 'item.discarded' ? 'debug' : 'info',
      message: `${itemType} ${lifecycle.split('.')[1]}${summary ? `: ${summary}` : ''}`,
      metadata: {
        itemId,
        itemType,
        threadId,
        turnId,
      },
    });
  }

  // 为监控事件提供简短人类可读摘要（不包含完整内容，只取关键字段）
  // — English: provide short human-readable summary for monitor events (no full content)
  private summarizeItemForMonitor(item: ThreadItem): string {
    switch (item.type) {
      case 'user_message': return (item.text ?? '').slice(0, 80);
      case 'agent_message': return (item.text ?? '').slice(0, 80);
      case 'reasoning': return (item.text ?? '').slice(0, 80);
      case 'tool_call': return item.toolName;
      case 'mcp_tool_call': return `${item.server}/${item.tool}`;
      case 'collab_tool_call': return item.tool;
      case 'command_execution': return item.command;
      case 'file_change': return item.changes?.map((c) => c.path).join(', ') ?? '';
      case 'web_search': return item.query;
      case 'todo_list': return `${item.items?.length ?? 0} items`;
      case 'error': return (item.message ?? '').slice(0, 80);
      case 'context_compaction': return item.trigger;
      case 'workflow_checkpoint': return `turn ${item.turnCount}`;
      case 'project_checkpoint': return `turn ${item.turnCount}`;
      case 'rollback_conflict': return (item.message ?? '').slice(0, 80);
      case 'harness_continuation': return `iteration ${item.iteration}`;
      default: return '';
    }
  }

  private async finishRunMonitor(turnId: TurnId, status: RunRecord['status'], usage: Usage | null, error?: unknown): Promise<void> {
    const session = this.runMonitorSessions.get(turnId);
    if (!session) return;
    const completedAt = new Date().toISOString();
    await this.appendRunMonitorEvent(turnId, {
      category: 'turn',
      type: status === 'completed' ? 'turn.completed' : `turn.${status}`,
      level: status === 'failed' ? 'error' : status === 'interrupted' ? 'warning' : 'info',
      message: status === 'completed' ? 'Turn completed' : `Turn ${status}`,
      metadata: usage ? { usage } : {},
    });
    await this.safeMonitorWrite(async () => {
      await this.config.store.updateRunRecord?.(session.runId, {
        status,
        activeStep: 'done',
        inputTokens: session.inputTokens,
        cachedInputTokens: session.cachedInputTokens,
        outputTokens: session.outputTokens,
        reasoningOutputTokens: session.reasoningOutputTokens,
        toolCallCount: session.toolCallCount,
        modelCallCount: session.modelCallCount,
        subagentCount: session.subagentCount,
        middlewareEventCount: session.middlewareEventCount,
        error: error ? String(error instanceof Error ? error.message : error) : null,
        completedAt,
        updatedAt: completedAt,
      });
    });
    this.runMonitorSessions.delete(turnId);
  }

  private async safeMonitorWrite(write: () => Promise<void>): Promise<void> {
    try {
      await write();
    } catch (error) {
      this.emit({
        type: 'error',
        message: `Run monitor write failed: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  // ─── Public API ───────────────────────────────────────────────────────────
  /** Start a new thread. */
  async startThread(title?: string, options: { hasWorkspace?: boolean; workspaceRoot?: string; tags?: Record<string, string> } = {}): Promise<ThreadMeta> {
    const threadId = generateId();
    const now = new Date().toISOString();
    const meta: ThreadMeta = {
      threadId,
      tenantId: this.config.tenantId,
      title: title ?? 'Untitled',
      hasWorkspace: options.hasWorkspace ?? this.config.hasWorkspace !== false,
      workspaceRoot: options.workspaceRoot ?? this.config.workspaceRoot,
      status: 'active',
      turnCount: 0,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      ephemeral: false,
      tags: options.tags ?? {},
    };
    await this.config.store.createThread(meta);
    const event = { type: 'thread.started' as const, threadId, thread: meta };
    this.emit(event);
    await this.config.hooks.trigger('session_start', { threadId, workspaceRoot: this.config.workspaceRoot });
    return meta;
  }

  /** Resume an existing thread. */
  async resumeThread(threadId: ThreadId): Promise<ThreadMeta | null> {
    const result = await resumeThread(threadId, this.config.store);
    if (!result) return null;
    this.emit({
      type: 'thread.resumed',
      threadId,
      turnIndex: result.turns.length,
    });
    const latestTurnId = result.turns.length > 0 ? result.turns[result.turns.length - 1].turnId : threadId;
    await this.emitCompactionPressure(threadId, latestTurnId);
    return result.thread;
  }

  async resumeTree(threadId: ThreadId): Promise<{
    threadId: ThreadId;
    children: Array<{
      threadId: ThreadId;
      status: ThreadRuntimeState['status'];
      checkpoint: Checkpoint | null;
      stale: boolean;
    }>;
  }> {
    const edges = await this.config.store.listThreadSpawnDescendants(threadId, 'open');
    const children = [];
    for (const edge of edges) {
      const state = await this.getRuntimeState(edge.childThreadId);
      if (state.checkpoint) {
        this.stateManager.setCheckpoint(edge.childThreadId, state.checkpoint);
      }
      if (state.stale && state.checkpoint?.turnId) {
        const turns = await this.config.store.getTurns(edge.childThreadId);
        const staleTurn = turns.find((turn) => turn.turnId === state.checkpoint?.turnId);
        if (staleTurn && staleTurn.status === 'running') {
          staleTurn.status = 'interrupted';
          staleTurn.completedAt = new Date().toISOString();
          await this.config.store.saveTurn(staleTurn);
        }
        await this.writeCheckpoint(edge.childThreadId, {
          ...state.checkpoint,
          status: 'stale',
          timestamp: new Date().toISOString(),
          expiresAt: undefined,
        });
      }
      children.push({
        threadId: edge.childThreadId,
        status: state.status,
        checkpoint: state.checkpoint,
        stale: state.stale,
      });
    }
    return { threadId, children };
  }

  /** Run a single turn (user input → agent → tool calls → ... → final response). */
  async runTurn(
    threadId: ThreadId,
    userInput: UserInput,
    signal?: AbortSignal,
    options?: RunTurnOptions,
  ): Promise<{ items: ThreadItem[]; usage: Usage | null }> {
    const thread = await this.config.store.getThread(threadId);
    if (!thread) throw new Error(`Thread ${threadId} not found`);

    // Check if already running
    // 检查是否已在运行
    const persistedRuntimeState = await this.getRuntimeState(threadId);
    if (this.stateManager.isRunning(threadId) || ['running', 'stopping', 'waiting_user_input'].includes(persistedRuntimeState.executionStatus ?? '')) {
      throw new Error(`Thread ${threadId} already has an active turn`);
    }

    // Gap 3 / Gap 9: 解析 RunTurnOptions，设置 harness 字段标记和副作用控制
    // — English: parse RunTurnOptions for harness fields and side-effect control
    const harnessFields: HarnessItemFields | null = options?.harnessRunId
      ? {
          harnessRunId: options.harnessRunId,
          ...(options.harnessIteration !== undefined ? { harnessIteration: options.harnessIteration } : {}),
        }
      : null;
    if (harnessFields) {
      this.harnessFieldsByThread.set(threadId, harnessFields);
    }
    // 副作用控制：harness 续跑默认跳过 cold memory 提取，保留 episode 更新
    const skipColdMemory = options?.skipColdMemory ?? false;
    const extractMemory = options?.extractMemory ?? !skipColdMemory;
    const updateEpisode = options?.updateEpisode ?? true;

    const turnId = generateId();
    const turnIndex = thread.turnCount;
    const turn: TurnMeta = {
      turnId,
      threadId,
      index: turnIndex,
      userInput,
      status: 'running',
      startedAt: new Date().toISOString(),
      completedAt: null,
    };

    // State machine: start turn
    // 状态机：启动回合
    const cancelController = this.stateManager.startTurn(threadId, turnId);
    const effectiveSignal = combineAbortSignals(signal, cancelController.signal);

    // Write initial checkpoint
    // 写入初始检查点
    const checkpoint = this.withCheckpointState(threadId, turnId, 0, 'running');
    await this.writeCheckpoint(threadId, checkpoint);

    await this.config.store.saveTurn(turn);
    await this.config.store.updateThreadMetadata(threadId, {
      turnCount: turnIndex + 1,
    });

    const runId = await this.beginRunMonitor({ threadId, turnId, title: thread.title, userInput });
    this.emit({ type: 'turn.started', threadId, turnId, runId, turnIndex });
    await this.config.hooks.trigger('turn_start', {
      threadId,
      turnId,
      workspaceRoot: this.config.workspaceRoot,
    });

    // Episode working set preparation (after turn_start hook, before compaction).
    await this.prepareEpisodeWorkingSet(thread, turnId, turnIndex, userInput);

    const userItem: ThreadItem = {
      id: generateItemId(turnId, 0),
      type: 'user_message',
      turnId,
      text: userInputToText(userInput),
      timestamp: turn.startedAt,
      ...(userInput.type === 'multimodal' ? {
        attachments: userInput.parts
          .filter((part): part is Extract<typeof part, { type: 'image_path' }> => part.type === 'image_path')
          .map((part) => ({ name: part.name ?? path.basename(part.path), path: part.path, mimeType: part.mimeType, url: part.url })),
      } : {}),
    };
    const collectedItems: ThreadItem[] = [userItem];
    this.emitItem(threadId, turnId, userItem);
    await this.persistItems(threadId, [userItem]);
    this.refreshRunningCheckpoint(checkpoint, threadId, turnId, collectedItems.length);
    await this.writeCheckpoint(threadId, checkpoint);

    let runtimeContext: RuntimeTurnContext | null = null;
    let terminalTurnResult: RuntimeTurnResult | null = null;
    try {
      // Pre-turn auto compaction: visible item, then compacted summary enters context.
      // 回合前自动压缩：可见条目，然后压缩摘要进入上下文。
      await this.maybeAutoCompact(threadId, turnId);
      const refreshedThread = await this.config.store.getThread(threadId) ?? thread;

      // Build messages
      // 构建消息
      const webSearchRecommended = shouldEnableWebSearch(this.config.webSearchMode, userInput);
      const webSearchToolAvailable = this.shouldOfferWebSearchTool();
      const messages = await this.buildMessages(threadId, userInput, refreshedThread, webSearchRecommended);
      const recentKnowledgeItems = await this.config.store.getRecentItems(threadId, 80);

      runtimeContext = await this.createRuntimeTurnContext(
        threadId,
        turnId,
        refreshedThread,
        userInput,
        checkpoint,
        collectedItems,
      );

      // Main agent loop
      // 主 agent 循环
      await this.appendRunMonitorEvent(turnId, {
        category: 'middleware',
        type: 'middleware.beforeTurn',
        message: 'beforeTurn middleware started',
      });
      await this.runtimeMiddleware.beforeTurn(runtimeContext);
      // 发 task.runtime.updated phase=before_turn — harness turn 也走相同 runtime 事件骨架
      this.emitTaskRuntimeUpdated(threadId, turnId, 'before_turn', 'running');
      const result = await this.agentLoop(
        threadId,
        turnId,
        messages,
        collectedItems,
        effectiveSignal,
        checkpoint,
        webSearchToolAvailable,
        runtimeContext,
        recentKnowledgeItems,
      );
      turn.status = 'completed';
      turn.completedAt = new Date().toISOString();
      await this.config.store.saveTurn(turn);
      await this.writeCheckpoint(threadId, this.withCheckpointState(threadId, turnId, collectedItems.length, 'completed'));
      this.stateManager.completeTurn(threadId, turnId);
      this.emit({ type: 'thread.runtime.updated', threadId, turnId, runId, status: 'terminal', terminalStatus: 'completed' });
      if (result.usage) await this.recordUsage(threadId, turnId, result.usage);
      this.emit({ type: 'turn.completed', threadId, turnId, runId, usage: result.usage });
      this.emitTaskRuntimeUpdated(threadId, turnId, 'after_turn', 'completed');
      this.emitTaskRuntimeUpdated(threadId, turnId, 'idle', 'completed');
      terminalTurnResult = { status: 'completed', usage: result.usage };
      await this.finishRunMonitor(turnId, 'completed', result.usage);
      // Gap 9: 副作用控制 — harness 续跑按 options 决定是否更新 episode / 提取 cold memory
      if (updateEpisode) {
        await this.updateEpisodeFromCompletedTurn(refreshedThread, turnId, turnIndex, userInput, collectedItems);
      }
      if (extractMemory) {
        await this.maybeExtractColdMemories(refreshedThread, turnId, userInput, collectedItems);
      }
      if (runtimeContext) await this.finishTurnLifecycle(runtimeContext, terminalTurnResult);
      return result;
    } catch (err) {
      if (terminalTurnResult) throw err;
      if (isTurnCancelledError(err)) {
        turn.status = 'interrupted';
        turn.completedAt = new Date().toISOString();
        await this.config.store.saveTurn(turn);
        await this.writeCheckpoint(threadId, this.withCheckpointState(threadId, turnId, collectedItems.length, 'interrupted'));
        this.stateManager.completeInterruptedTurn(threadId, turnId);
        this.emit({ type: 'thread.runtime.updated', threadId, turnId, runId, status: 'terminal', terminalStatus: 'interrupted' });
        this.emit({ type: 'turn.completed', threadId, turnId, runId, usage: null, status: 'interrupted' });
        this.emitTaskRuntimeUpdated(threadId, turnId, 'after_turn', 'interrupted');
        this.emitTaskRuntimeUpdated(threadId, turnId, 'idle', 'interrupted');
        terminalTurnResult = { status: 'interrupted', usage: null, error: err };
        await this.finishRunMonitor(turnId, 'interrupted', null, err);
        if (runtimeContext) await this.finishTurnLifecycle(runtimeContext, terminalTurnResult);
        return { items: collectedItems, usage: null };
      }
      if (isRecoverableStreamError(err)) {
        const info = toSuanliziErrorInfo(err);
        const message = err instanceof Error ? err.message : String(err);
        turn.status = 'interrupted';
        turn.completedAt = new Date().toISOString();
        await this.config.store.saveTurn(turn);
        const errorItem: ThreadItem = {
          id: generateItemId(turnId, collectedItems.length),
          type: 'error',
          turnId,
          message,
          info,
          timestamp: new Date().toISOString(),
        };
        collectedItems.push(errorItem);
        this.emitItem(threadId, turnId, errorItem);
        await this.persistItems(threadId, [errorItem]);
        await this.writeCheckpoint(threadId, this.withCheckpointState(threadId, turnId, collectedItems.length, 'interrupted'));
        this.stateManager.completeInterruptedTurn(threadId, turnId);
        this.emit({ type: 'thread.runtime.updated', threadId, turnId, runId, status: 'terminal', terminalStatus: 'interrupted' });
        this.emit({
          type: 'stream.error',
          threadId,
          turnId,
          message,
          recoverable: true,
          error: { message, info },
        });
        this.emit({ type: 'turn.completed', threadId, turnId, runId, usage: null, status: 'interrupted' });
        this.emitTaskRuntimeUpdated(threadId, turnId, 'after_turn', 'interrupted');
        this.emitTaskRuntimeUpdated(threadId, turnId, 'idle', 'interrupted');
        await this.appendRunMonitorEvent(turnId, {
          category: 'model',
          type: 'stream.error',
          level: 'warning',
          message,
          metadata: { info, recoverable: true },
        });
        terminalTurnResult = { status: 'interrupted', usage: null, error: err };
        await this.finishRunMonitor(turnId, 'interrupted', null, err);
        if (runtimeContext) await this.finishTurnLifecycle(runtimeContext, terminalTurnResult);
        return { items: collectedItems, usage: null };
      }
      const errorMsg = err instanceof Error ? err.message : String(err);
      const errorInfo = toSuanliziErrorInfo(err);
      const rawCause = err instanceof Error && err.cause instanceof Error ? err.cause.message : undefined;
      const errorDetail = rawCause
        ?? (err as { detail?: unknown }).detail as string | undefined
        ?? (err instanceof Error && /model request timed out/i.test(err.message)
          ? 'The operation was aborted due to timeout'
          : undefined);
      const errorItem: ThreadItem = {
        id: generateItemId(turnId, collectedItems.length),
        type: 'error',
        turnId,
        message: errorMsg,
        info: errorInfo,
        ...(errorDetail ? { detail: errorDetail } : {}),
        timestamp: new Date().toISOString(),
      };
      collectedItems.push(errorItem);
      this.emitItem(threadId, turnId, errorItem);
      await this.persistItems(threadId, [errorItem]);
      await this.writeCheckpoint(threadId, this.withCheckpointState(threadId, turnId, collectedItems.length, 'failed'));
      turn.status = 'failed';
      turn.completedAt = new Date().toISOString();
      await this.config.store.saveTurn(turn);
      this.stateManager.failTurn(threadId, turnId, {
        message: errorMsg,
        timestamp: new Date().toISOString(),
      });
      this.emit({ type: 'thread.runtime.updated', threadId, turnId, runId, status: 'terminal', terminalStatus: 'failed' });
      this.emit({
        type: 'turn.failed',
        threadId,
        turnId,
        runId,
        error: { message: errorMsg, info: errorInfo },
      });
      this.emitTaskRuntimeUpdated(threadId, turnId, 'after_turn', 'failed');
      this.emitTaskRuntimeUpdated(threadId, turnId, 'idle', 'failed');
      terminalTurnResult = { status: 'failed', usage: null, error: err };
      await this.finishRunMonitor(turnId, 'failed', null, err);
      try {
        if (runtimeContext) await this.finishTurnLifecycle(runtimeContext, terminalTurnResult);
      } catch {
        // Preserve the original turn failure after afterTurn has had a chance to run.
        // 在 afterTurn 有机会执行后保留原始回合失败信息。
      }
      throw err;
    } finally {
      // 实施点 2：清理 per-thread harness 字段标记，避免泄漏到后续 turn
      // — English: clear per-thread harness fields marker to avoid leaking to subsequent turns
      if (harnessFields) {
        this.harnessFieldsByThread.delete(threadId);
      }
    }
  }

  /**
   * Gap 1 / Gap 3: Task Harness Engine 入口。
   * 启动跨 turn 自主循环：Goal → Plan → Execute → Critique → Replan → Verify。
   * 调用方（API route）拿到 harnessRunId 后可立即返回，循环在后台进行。
   */
  async runHarness(
    threadId: ThreadId,
    userInput: UserInput,
    options?: {
      goal?: string;
      acceptanceCriteria?: string[];
      maxContinuations?: number;
      signal?: AbortSignal;
      /** Gap 1: 调用方预生成的 harnessRunId，用于 API 立即返回 */
      harnessRunId?: string;
    },
  ): Promise<HarnessResult> {
    // EvaluatorModelGateway adapter：把 ModelGateway.chat 包装成 completeOnce
    // — English: adapt ModelGateway.chat into EvaluatorModelGateway.completeOnce
    const evaluatorModel: EvaluatorModelGateway = {
      completeOnce: async (prompt, opts) => {
        const response = await this.config.model.chat(
          {
            messages: [{ role: 'user', content: prompt }],
          },
          { signal: opts?.signal },
        );
        const choice = response.choices[0];
        const content = choice?.message?.content;
        if (typeof content === 'string') return content;
        // 多模态 content 降级为空串（evaluator prompt 期望纯文本响应）
        return '';
      },
    };

    const onHarnessStateChange: HarnessStateChangeCallback = ({ threadId: tid, harnessRunId, state, evaluation, evidenceCount }) => {
      this.emit({
        type: 'harness.state.updated',
        threadId: tid,
        harnessRunId,
        status: state.status,
        iteration: state.iteration,
        maxContinuations: state.goal.maxContinuations,
        noProgressCount: state.noProgressCount,
        maxNoProgress: state.goal.maxNoProgress,
        goal: state.goal.objective,
        acceptanceCriteria: state.goal.acceptanceCriteria,
        satisfied: state.status === 'satisfied',
        blocker: state.lastEvaluation?.blocker,
        failedCriteria: evaluation?.failedCriteria ?? state.lastEvaluation?.failedCriteria ?? [],
        evidenceCount,
        planNodes: state.plan.map((n) => ({ id: n.id, description: n.description, status: n.status })),
        activeNodeId: state.activeNodeId,
        nextHint: evaluation?.nextHint,
        startedAt: state.startedAt,
        updatedAt: state.updatedAt,
      });
      // 发 task.loop.updated — harness continuation 是 loop 状态的一个来源，不叫 harness
      // — English: emit task.loop.updated; harness loop is one source of loop state, not the only one
      const loopStatus: 'active' | 'satisfied' | 'blocked' | 'no_progress' | 'max_continuations' =
        state.status === 'cancelled' ? 'blocked' : state.status;
      const activeTurnId = this.stateManager.get(tid)?.activeTurnId;
      this.emit({
        type: 'task.loop.updated',
        threadId: tid,
        turnId: activeTurnId ?? undefined,
        loopId: harnessRunId,
        iteration: state.iteration,
        maxIterations: state.goal.maxContinuations,
        noProgressCount: state.noProgressCount,
        continuationReason: state.lastEvaluation?.status,
        status: loopStatus,
        timestamp: new Date().toISOString(),
      });
    };

    // 构造 TaskHarnessEngine：this 作为 HarnessAgentLoop（runTurn 已扩展为 4 参数）
    // — English: build TaskHarnessEngine with this agent as the loop delegate
    const engine = new TaskHarnessEngine(
      this as unknown as HarnessAgentLoop,
      evaluatorModel,
      this.config.store,
      DEFAULT_HARNESS_CONFIG,
      this._experienceEngine,
      onHarnessStateChange,
    );

    return engine.runHarness(threadId, userInput, options);
  }

  /** Resume a previously persisted harness/goal run through TaskHarnessEngine. */
  async resumeHarness(
    threadId: ThreadId,
    options?: {
      signal?: AbortSignal;
            harnessRunId?: string;
      workflow?: import('./harness/taskHarness.js').HarnessWorkflowOptions;
    },
  ): Promise<HarnessResult> {
    const evaluatorModel: EvaluatorModelGateway = {
      completeOnce: async (prompt, opts) => {
        const response = await this.config.model.chat(
          { messages: [{ role: 'user', content: prompt }] },
          { signal: opts?.signal },
        );
        const content = response.choices[0]?.message?.content;
        return typeof content === 'string' ? content : '';
      },
    };
    const onHarnessStateChange: HarnessStateChangeCallback = ({ threadId: tid, harnessRunId, state, evaluation, evidenceCount }) => {
      this.emit({
        type: 'harness.state.updated',
        threadId: tid,
        harnessRunId,
        status: state.status,
        iteration: state.iteration,
        maxContinuations: state.goal.maxContinuations,
        noProgressCount: state.noProgressCount,
        maxNoProgress: state.goal.maxNoProgress,
        goal: state.goal.objective,
        acceptanceCriteria: state.goal.acceptanceCriteria,
        satisfied: state.status === 'satisfied',
        blocker: state.lastEvaluation?.blocker,
        failedCriteria: evaluation?.failedCriteria ?? state.lastEvaluation?.failedCriteria ?? [],
        evidenceCount,
        planNodes: state.plan.map((n) => ({ id: n.id, description: n.description, status: n.status })),
        activeNodeId: state.activeNodeId,
        nextHint: evaluation?.nextHint,
        startedAt: state.startedAt,
        updatedAt: state.updatedAt,
      });
      const loopStatus: 'active' | 'satisfied' | 'blocked' | 'no_progress' | 'max_continuations' =
        state.status === 'cancelled' ? 'blocked' : state.status;
      const activeTurnId = this.stateManager.get(tid)?.activeTurnId;
      this.emit({
        type: 'task.loop.updated',
        threadId: tid,
        turnId: activeTurnId ?? undefined,
        loopId: harnessRunId,
        iteration: state.iteration,
        maxIterations: state.goal.maxContinuations,
        noProgressCount: state.noProgressCount,
        continuationReason: state.lastEvaluation?.status,
        status: loopStatus,
        timestamp: new Date().toISOString(),
      });
    };
    const engine = new TaskHarnessEngine(
      this as unknown as HarnessAgentLoop,
      evaluatorModel,
      this.config.store,
      DEFAULT_HARNESS_CONFIG,
      this._experienceEngine,
      onHarnessStateChange,
    );
    return engine.resumeHarness(threadId, options);
  }

  /** Expose the shared/current system monitor status for API callers. */
  getSystemMonitorStatus(): SystemMonitorStatus {
    return this._systemMonitor?.getStatus() ?? createEmptySystemMonitorStatus(false);
  }

  /** Release a llama.cpp slot lease bound to a thread when the thread is deleted. */
  releaseLlamaSlot(threadId: ThreadId): void {
    this.config.llamaSlotLeaseManager?.releaseThread(threadId);
  }

  // ─── Agent Loop Core ──────────────────────────────────────────────────────
  private async agentLoop(
    threadId: ThreadId,
    turnId: TurnId,
    messages: ChatMessage[],
    collectedItems: ThreadItem[],
    signal: AbortSignal,
    checkpoint: Checkpoint,
    webSearchToolAvailable: boolean,
    runtimeContext: RuntimeTurnContext,
    recentKnowledgeItems: ThreadItem[],
  ): Promise<{ items: ThreadItem[]; usage: Usage | null }> {
    let iteration = 0;
    let plainTextToolPlaceholderRetries = 0;
    let usage: Usage | null = null;
    let webSearchDisabled = false;
    let freshnessPreflightApplied = false;
    const visibleToolNames = this.config.toolBindingMode === 'delayed'
      ? this.initialVisibleToolNames()
      : undefined;

    while (iteration < this.config.maxIterations) {
      if (signal.aborted) throw new Error('Turn cancelled');

      // 中文注释：主动通知 — 若 SystemMonitor 级别变化，在下一次模型调用前注入系统通知
      // — Chinese: proactive notification — inject system notice before next model call if level changed
      const pendingNotice = this.consumePendingSystemNotice();
      if (pendingNotice) {
        messages.push({
          role: 'user',
          content: pendingNotice,
        });
        await this.appendRunMonitorEvent(turnId, {
          category: 'middleware',
          type: 'middleware.system_monitor_notice',
          level: 'warning',
          message: pendingNotice,
          metadata: { iteration },
        });
      }

      const freshnessNotice = freshnessPreflightApplied ? null : await buildFreshnessPreflightNotice({
        workspaceRoot: this.config.workspaceRoot,
        locale: this.config.locale,
        userText: userInputToText(runtimeContext.userInput),
        recentItems: [...recentKnowledgeItems, ...collectedItems].slice(-80),
      });
      if (freshnessNotice) {
        freshnessPreflightApplied = true;
        messages.push({ role: 'user', content: freshnessNotice.content });
        const staleArtifact = freshnessNotice.staleArtifacts[0];
        const requiredDocumentPath = freshnessNotice.requiredDocumentPaths?.[0];
        const documentPaths = uniqueStrings([
          ...freshnessNotice.staleArtifacts.map((entry) => entry.sourcePath),
          ...(freshnessNotice.requiredDocumentPaths ?? []),
        ]).slice(0, 3);
        await this.appendRunMonitorEvent(turnId, {
          category: 'file',
          type: staleArtifact ? 'file.stale' : 'file.read',
          level: 'warning',
          message: staleArtifact
            ? 'Stale document artifacts detected before model call'
            : 'Document verification required before model call',
          metadata: {
            action: staleArtifact ? 'stale' : 'read',
            path: staleArtifact?.artifactPath ?? requiredDocumentPath ?? '',
            sourcePath: staleArtifact?.sourcePath ?? requiredDocumentPath,
            staleReason: staleArtifact?.reason,
            staleArtifacts: freshnessNotice.staleArtifacts,
            requiredDocumentPaths: freshnessNotice.requiredDocumentPaths ?? [],
          },
        });
        const preflightResults = await this.executePreflightDocumentReads(threadId, turnId, collectedItems, documentPaths);
        if (preflightResults.length > 0) {
          messages.push({
            role: 'user',
            content: [
              '文件知识自动校验结果：runtime 已在模型回答前调用 read_document 刷新/复用以下文档内容。',
              ...preflightResults,
            ].join('\n\n'),
          });
        }
      }

      iteration++;
      const streamed = await this.runModelStream(
        threadId,
        turnId,
        collectedItems,
        messages,
        webSearchToolAvailable && !webSearchDisabled,
        runtimeContext,
        signal,
        visibleToolNames,
      );
      usage = streamed.usage;
      const message = streamed.message;
      // If no tool calls, this is the final response
      // 如果没有工具调用，就是最终响应
      if (!message.tool_calls || message.tool_calls.length === 0) {
        if (isTextToolPlaceholder(message.content) && iteration < this.config.maxIterations) {
          plainTextToolPlaceholderRetries += 1;
          if (plainTextToolPlaceholderRetries > 1) {
            const repeatedProviderDiagnostics = this.modelProviderDiagnostics();
            const repeatedError = new Error('PLAIN_TEXT_TOOL_CALL_REPEATED');
            await this.appendRunMonitorEvent(turnId, {
              category: 'model',
              type: 'model.output.rejected',
              level: 'error',
              message: 'Repeated plain-text tool placeholder hard-stopped the turn',
              model: repeatedProviderDiagnostics.model,
              metadata: { ...repeatedProviderDiagnostics, iteration, reason: 'plain_text_tool_placeholder' },
            });
            throw repeatedError;
          }
          const providerDiagnostics = this.modelProviderDiagnostics();
          await this.appendRunMonitorEvent(turnId, {
            category: 'model',
            type: 'model.plain_text_tool_call',
            level: 'warning',
            message: 'Model emitted a plain-text tool call placeholder; requesting a structured retry',
            model: providerDiagnostics.model,
            metadata: { ...providerDiagnostics, iteration },
          });
          await this.appendRunMonitorEvent(turnId, {
            category: 'model',
            type: 'model.output.discarded',
            level: 'warning',
            message: 'plain-text tool placeholder was discarded before retry',
            model: providerDiagnostics.model,
            metadata: { ...providerDiagnostics, iteration, reason: 'plain_text_tool_placeholder' },
          });
          messages.push({
            role: 'user',
            content: this.config.locale === 'zh'
              ? 'plain-text tool placeholder was discarded before retry。上一条模型输出因为把工具调用协议写成普通文本，已被系统丢弃。不要复述该文本；需要工具时只能使用结构化 tool call，不需要工具时直接给最终回答。'
              : 'plain-text tool placeholder was discarded before retry. The previous model output was discarded because it wrote a tool-call protocol as plain text. Do not repeat that text. Use a structured tool call if a tool is needed; otherwise provide the final answer directly.',
          });
          continue;
        }
        return { items: collectedItems, usage };
      }

      // Process tool calls
      // 处理工具调用
      const assistantToolMessage: ChatMessage = {
        role: 'assistant',
        content: message.content ?? null,
        tool_calls: message.tool_calls,
      };
      if (message.reasoning_content) {
        assistantToolMessage.reasoning_content = message.reasoning_content;
      }
      if (message.providerFrame?.format === 'anthropic_messages') {
        assistantToolMessage.providerFrame = message.providerFrame;
      } else if (message.providerFrame?.format === 'openai_responses') {
        assistantToolMessage.providerFrame = message.providerFrame;
      }
      messages.push(assistantToolMessage);

      const toolResults = await this.executeToolCallBatch(
        threadId,
        turnId,
        message.tool_calls,
        collectedItems,
        runtimeContext,
        signal,
        visibleToolNames,
      );

      for (const toolResult of toolResults) {
        if (toolResult.disableWebSearch) {
          webSearchDisabled = true;
        }
        if (visibleToolNames && toolResult.activateToolNames) {
          for (const name of toolResult.activateToolNames) {
            visibleToolNames.add(resolveToolName(this.tools, name));
          }
        }

        // Update checkpoint after each tool execution
        // 每次工具执行后更新检查点
        this.refreshRunningCheckpoint(checkpoint, threadId, turnId, collectedItems.length);
        await this.writeCheckpoint(threadId, checkpoint);

        messages.push({
          role: 'tool',
          content: toolResult.output,
          tool_call_id: toolResult.toolCall.id,
        });
      }

      const compacted = await this.maybeAutoCompact(threadId, turnId, 'mid_turn', messages);
      if (compacted) {
        const refreshedThread = await this.config.store.getThread(threadId);
        if (refreshedThread) {
          const webSearchRecommended = shouldEnableWebSearch(this.config.webSearchMode, runtimeContext.userInput);
          const rebuilt = await this.buildMessages(
            threadId,
            runtimeContext.userInput,
            refreshedThread,
            webSearchRecommended,
            false,
          );
          messages.splice(0, messages.length, ...rebuilt);
        }
      }
    }

    throw new Error(this.i18n.t('runtime.max_iterations', { max: this.config.maxIterations }));
  }

  private roleToolFilter(): { include?: string[]; exclude?: string[] } | undefined {
    const profile = this.config.activeAgentRoleProfile;
    if (!profile) return undefined;
    return {
      include: profile.allowedTools && profile.allowedTools.length > 0 ? profile.allowedTools : undefined,
      exclude: profile.blockedTools && profile.blockedTools.length > 0 ? profile.blockedTools : undefined,
    };
  }

  private isToolAllowedByRole(toolName: string): boolean {
    const profile = this.config.activeAgentRoleProfile;
    if (!profile) return true;
    if (profile.blockedTools?.includes(toolName)) return false;
    if (profile.allowedTools?.length && !profile.allowedTools.includes(toolName)) return false;
    return true;
  }

  private async runModelStream(
    threadId: ThreadId,
    turnId: TurnId,
    collectedItems: ThreadItem[],
    messages: ChatMessage[],
    webSearchToolAvailable: boolean,
    runtimeContext: RuntimeTurnContext,
    signal: AbortSignal,
    visibleToolNames?: ReadonlySet<string>,
  ): Promise<{ message: ChatMessage; usage: Usage | null }> {
    const roleToolFilter = this.roleToolFilter();
    const tools = this.tools
      .toOpenAITools(roleToolFilter)
      .filter((tool) => !visibleToolNames || visibleToolNames.has(tool.function.name))
      .filter((tool) => tool.function.name !== 'web_fetch')
      .filter((tool) => webSearchToolAvailable || tool.function.name !== 'web_search');

    let modelRequest: RuntimeModelRequest = {
      messages,
      tools,
      tool_choice: 'auto',
      max_tokens: this.config.modelMaxOutputTokens,
      signal,
    };
    await this.appendRunMonitorEvent(turnId, {
      category: 'middleware',
      type: 'middleware.beforeModel',
      message: 'beforeModel middleware started',
      metadata: { messageCount: messages.length, toolCount: tools.length },
    });
    modelRequest = await this.runtimeMiddleware.beforeModel(runtimeContext, modelRequest);
    const contextTokens = this.config.modelContextTokens ?? MODEL_HISTORY_TOKEN_BUDGET;
    const outputBudget = Math.max(1, Math.floor(
      Number(modelRequest.max_tokens ?? this.config.modelMaxOutputTokens ?? DEFAULT_MODEL_OUTPUT_TOKEN_BUDGET),
    ) || DEFAULT_MODEL_OUTPUT_TOKEN_BUDGET);
    const inputBudget = Math.max(
      MIN_MODEL_INPUT_TOKEN_BUDGET,
      contextTokens - outputBudget - MODEL_REQUEST_OVERHEAD_TOKENS - MODEL_REQUEST_SAFETY_MARGIN_TOKENS,
    );
    modelRequest.messages = fitMessagesToBudget(modelRequest.messages, inputBudget);
    // 发 task.runtime.updated phase=model — 让 monitor 知道当前进入模型调用阶段
    this.emitTaskRuntimeUpdated(threadId, turnId, 'model', 'running');
    const cacheShape = buildPromptCacheShape(modelRequest.messages, modelRequest.tools ?? []);
    const cacheComparison = comparePromptCacheShape(this.promptCacheShapes.get(threadId), cacheShape);
    this.promptCacheShapes.set(threadId, cacheShape);
    this.emit({
      type: 'cache.diagnostics',
      threadId,
      turnId,
      shape: cacheShape,
      stable: cacheComparison.stable,
      reasons: cacheComparison.reasons,
    });
    this.emit({
      type: 'context.token_estimate.updated',
      threadId,
      turnId,
      estimate: estimateRuntimeChatTokens(modelRequest.messages),
    });
    const providerDiagnostics = this.modelProviderDiagnostics();

    await this.appendRunMonitorEvent(turnId, {
      category: 'model',
      type: 'model.started',
      message: 'Model stream started',
      model: providerDiagnostics.model,
      metadata: {
        ...providerDiagnostics,
        messageCount: modelRequest.messages.length,
        toolCount: modelRequest.tools?.length ?? 0,
      },
    });
    let response: { message: ChatMessage; usage: Usage | null };
    try {
      response = await this.runtimeMiddleware.wrapModel(runtimeContext, modelRequest, async (request) => {
      let content = '';
      let reasoningContent = '';
      let usage: Usage | null = null;
      let agentItem: ThreadItem | null = null;
      let reasoningItem: ThreadItem | null = null;
      const toolCalls = new Map<string, ToolCall>();
      const requestSignal = request.signal ?? signal;

      try {
      for await (const event of this.config.model.chatStream({
        messages: request.messages,
        tools: request.tools,
        tool_choice: request.tool_choice ?? 'auto',
        max_tokens: request.max_tokens,
      }, {
        signal: requestSignal,
        onRetry: (notice) => {
          this.emit({
            type: 'model.retry',
            threadId,
            turnId,
            attempt: notice.attempt,
            maxAttempts: notice.maxAttempts,
            delayMs: notice.delayMs,
            status: notice.status,
            error: notice.error,
          });
        },
      })) {
        if (requestSignal.aborted) throw new Error('Turn cancelled');
        if (event.type === 'delta') {
          if (!agentItem) {
            agentItem = {
              id: generateItemId(turnId, collectedItems.length),
              type: 'agent_message',
              turnId,
              text: '',
              timestamp: new Date().toISOString(),
            };
            collectedItems.push(agentItem);
            this.emit({ type: 'item.started', threadId, turnId, item: agentItem });
            void this.appendItemRunMonitorEvent(threadId, turnId, agentItem, 'item.started');
          }
          content += event.content;
          agentItem.text = content;
          this.emit({
            type: 'agent_message.delta',
            threadId,
            turnId,
            itemId: agentItem.id,
            delta: event.content,
          });
          this.emit({ type: 'item.updated', threadId, turnId, item: agentItem });
        } else if (event.type === 'reasoning_delta') {
          if (!reasoningItem) {
            reasoningItem = {
              id: generateItemId(turnId, collectedItems.length),
              type: 'reasoning',
              turnId,
              text: '',
              timestamp: new Date().toISOString(),
            };
            collectedItems.push(reasoningItem);
            this.emit({ type: 'item.started', threadId, turnId, item: reasoningItem });
            void this.appendItemRunMonitorEvent(threadId, turnId, reasoningItem, 'item.started');
          }
          reasoningContent += event.content;
          reasoningItem.text = reasoningContent;
          this.emit({ type: 'item.updated', threadId, turnId, item: reasoningItem });
        } else if (event.type === 'tool_call_start' || event.type === 'tool_call_delta') {
          const id = event.id || `tool_${toolCalls.size}`;
          const existing = toolCalls.get(id) ?? {
            id,
            type: 'function' as const,
            function: { name: '', arguments: '' },
          };
          if (event.type === 'tool_call_start') {
            existing.function.name = event.name;
          } else {
            existing.function.arguments = event.arguments;
          }
          toolCalls.set(id, existing);
        } else if (event.type === 'tool_call_end') {
          const id = event.id || `tool_${toolCalls.size}`;
          toolCalls.set(id, {
            id,
            type: 'function',
            function: {
              name: event.name,
              arguments: event.arguments,
            },
          });
        } else if (event.type === 'done') {
          usage = event.usage
            ? {
                inputTokens: event.usage.prompt_tokens,
                cachedInputTokens: event.usage.cached_tokens ?? 0,
                cacheReported: event.usage.cache_reported === undefined ? undefined : event.usage.cache_reported,
                outputTokens: event.usage.completion_tokens,
                reasoningOutputTokens: 0,
                cacheStrategy: event.usage.cache_strategy,
              }
            : usage;
        } else if (event.type === 'error') {
          throw event.error;
        }
      }
      } catch (error) {
        if (reasoningItem && reasoningContent.trim()) {
          const reasoningValidation = validateThreadItemsForPersistence([reasoningItem]);
          if (reasoningValidation.ok) {
            const reasoningCompletedAt = new Date().toISOString();
            (reasoningItem as { completedAt?: string }).completedAt = reasoningCompletedAt;
            this.emit({ type: 'item.completed', threadId, turnId, item: reasoningItem });
            void this.appendItemRunMonitorEvent(threadId, turnId, reasoningItem, 'item.completed');
            await this.persistItems(threadId, [reasoningItem]);
          } else {
            this.discardTransientItem(threadId, turnId, collectedItems, reasoningItem.id);
          }
        }
        if (agentItem && content.trim()) {
          const partialValidation = validateThreadItemsForPersistence([agentItem]);
          if (partialValidation.ok) {
            this.emit({ type: 'item.completed', threadId, turnId, item: agentItem });
            void this.appendItemRunMonitorEvent(threadId, turnId, agentItem, 'item.completed');
            await this.persistItems(threadId, [agentItem]);
          } else {
            this.discardTransientItem(threadId, turnId, collectedItems, agentItem.id);
            this.emit({
              type: 'model.output.rejected',
              threadId,
              turnId,
              message: partialValidation.error.message,
              error: { message: partialValidation.error.message, info: partialValidation.error.info },
            });
            await this.appendRunMonitorEvent(turnId, {
              category: 'model',
              type: 'model.output.rejected',
              level: 'warning',
              message: partialValidation.error.message,
              metadata: { info: partialValidation.error.info },
            });
          }
        }
        const info = toSuanliziErrorInfo(error);
        throw new SuanliziRuntimeError(error instanceof Error ? error.message : String(error), info, { cause: error });
      }

      const plainTextToolPlaceholder = agentItem
        && toolCalls.size === 0
        && isTextToolPlaceholder(content);
      if (plainTextToolPlaceholder) {
        const placeholderMessage = this.config.locale === 'zh'
          ? '普通文本工具调用占位输出已被系统拒绝，不会作为最终回答。'
          : 'Plain-text tool-call placeholder output was rejected and will not be treated as the final answer.';
        this.emit({
          type: 'model.output.rejected',
          threadId,
          turnId,
          message: placeholderMessage,
          error: { message: placeholderMessage, info: { kind: 'BadRequest', reason: 'protocol' } },
        });
        await this.appendRunMonitorEvent(turnId, {
          category: 'model',
          type: 'model.output.rejected',
          level: 'warning',
          message: placeholderMessage,
          metadata: { reason: 'plain_text_tool_placeholder' },
        });
        this.discardTransientItem(threadId, turnId, collectedItems, agentItem?.id);
        if (reasoningItem) {
          this.discardTransientItem(threadId, turnId, collectedItems, reasoningItem.id);
        }
      } else {
        if (reasoningItem) {
          const reasoningValidation = validateThreadItemsForPersistence([reasoningItem]);
          if (!reasoningValidation.ok) {
            this.discardTransientItem(threadId, turnId, collectedItems, reasoningItem.id);
            this.emit({
              type: 'model.output.rejected',
              threadId,
              turnId,
              message: reasoningValidation.error.message,
              error: { message: reasoningValidation.error.message, info: reasoningValidation.error.info },
            });
            await this.appendRunMonitorEvent(turnId, {
              category: 'model',
              type: 'model.output.rejected',
              level: 'warning',
              message: reasoningValidation.error.message,
              metadata: { info: reasoningValidation.error.info },
            });
            throw reasoningValidation.error;
          }
          // Include the terminal marker in both the event and persisted copy so the
          // UI cannot mistake a just-completed reasoning item for still streaming.
          (reasoningItem as { completedAt?: string }).completedAt = new Date().toISOString();
          this.emit({ type: 'item.completed', threadId, turnId, item: reasoningItem });
          void this.appendItemRunMonitorEvent(threadId, turnId, reasoningItem, 'item.completed');
          await this.persistItems(threadId, [reasoningItem]);
        }
      }

      if (!plainTextToolPlaceholder && agentItem) {
        if (toolCalls.size > 0) {
          agentItem.providerFrame = buildProviderFrameForToolCalls(
            providerDiagnostics.toolHistoryMode,
            content || null,
            reasoningContent,
            [...toolCalls.values()],
          );
        }
        const validation = validateThreadItemsForPersistence([agentItem]);
        if (!validation.ok) {
          this.discardTransientItem(threadId, turnId, collectedItems, agentItem.id);
          this.emit({
            type: 'model.output.rejected',
            threadId,
            turnId,
            message: validation.error.message,
            error: { message: validation.error.message, info: validation.error.info },
          });
          await this.appendRunMonitorEvent(turnId, {
            category: 'model',
            type: 'model.output.rejected',
            level: 'warning',
            message: validation.error.message,
            metadata: { info: validation.error.info },
          });
          throw validation.error;
        }
        this.emit({ type: 'item.completed', threadId, turnId, item: agentItem });
        void this.appendItemRunMonitorEvent(threadId, turnId, agentItem, 'item.completed');
        await this.persistItems(threadId, [agentItem]);
      } else if (toolCalls.size > 0) {
        const assistantFrameItem: ThreadItem = {
          id: generateItemId(turnId, collectedItems.length),
          type: 'agent_message',
          turnId,
          text: '',
          providerFrame: buildProviderFrameForToolCalls(
            providerDiagnostics.toolHistoryMode,
            null,
            reasoningContent,
            [...toolCalls.values()],
          ),
          timestamp: new Date().toISOString(),
        };
        collectedItems.push(assistantFrameItem);
        this.emit({ type: 'item.started', threadId, turnId, item: assistantFrameItem });
        this.emit({ type: 'item.completed', threadId, turnId, item: assistantFrameItem });
        void this.appendItemRunMonitorEvent(threadId, turnId, assistantFrameItem, 'item.started');
        void this.appendItemRunMonitorEvent(threadId, turnId, assistantFrameItem, 'item.completed');
        await this.persistItems(threadId, [assistantFrameItem]);
      }

      if (!agentItem && toolCalls.size === 0) {
        throw new Error(this.i18n.t('runtime.no_response'));
      }

      const assistantMessage: ChatMessage = {
        role: 'assistant',
        content,
        tool_calls: toolCalls.size > 0 ? [...toolCalls.values()] : undefined,
      };
      if (reasoningContent.trim()) {
        assistantMessage.reasoning_content = reasoningContent;
      }
      if (toolCalls.size > 0 && providerDiagnostics.toolHistoryMode === 'anthropic_blocks') {
        const providerFrame = buildProviderFrameForToolCalls(
          providerDiagnostics.toolHistoryMode,
          content || null,
          reasoningContent,
          [...toolCalls.values()],
        );
        if (providerFrame.format === 'anthropic_messages') {
          assistantMessage.providerFrame = {
            format: 'anthropic_messages',
            contentBlocks: providerFrame.contentBlocks,
          };
        }
      }
      return { message: assistantMessage, usage };
      });
    } catch (error) {
      await this.appendRunMonitorEvent(turnId, {
        category: 'model',
        type: 'model.failed',
        level: 'error',
        message: error instanceof Error ? error.message : String(error),
        model: providerDiagnostics.model,
        metadata: providerDiagnostics,
      });
      throw error;
    }
    await this.runtimeMiddleware.afterModel(runtimeContext, modelRequest, response);
    const session = this.runMonitorSessions.get(turnId);
    if (session && response.usage) {
      session.inputTokens += response.usage.inputTokens;
      session.cachedInputTokens += response.usage.cachedInputTokens;
      session.outputTokens += response.usage.outputTokens;
      session.reasoningOutputTokens += response.usage.reasoningOutputTokens;
    }
    await this.appendRunMonitorEvent(turnId, {
      category: 'model',
      type: 'model.completed',
      message: 'Model stream completed',
      model: providerDiagnostics.model,
      metadata: response.usage ? { ...providerDiagnostics, usage: response.usage } : providerDiagnostics,
    });
    return response;
  }

  // ─── Tool Execution ───────────────────────────────────────────────────────
  private async executeToolCallBatch(
    threadId: ThreadId,
    turnId: TurnId,
    toolCalls: ToolCall[],
    collectedItems: ThreadItem[],
    runtimeContext: RuntimeTurnContext,
    signal: AbortSignal,
    visibleToolNames?: ReadonlySet<string>,
  ): Promise<ToolCallExecutionResult[]> {
    const results = new Array<ToolCallExecutionResult>(toolCalls.length);
    let index = 0;
    while (index < toolCalls.length) {
      if (signal.aborted) throw new Error('Turn cancelled');

      if (!this.supportsParallelToolCall(toolCalls[index], visibleToolNames)) {
        const toolCall = toolCalls[index];
        const result = await this.executeToolCall(
          threadId,
          turnId,
          toolCall,
          collectedItems,
          runtimeContext,
          visibleToolNames,
        );
        results[index] = { toolCall, ...result };
        index += 1;
        continue;
      }

      const start = index;
      index += 1;
      while (index < toolCalls.length && this.supportsParallelToolCall(toolCalls[index], visibleToolNames)) {
        index += 1;
      }
      const group = toolCalls.slice(start, index);
      // 中文注释：系统监控限流 — light 级别将并发批次减半
      // — Chinese: system monitor throttle — light level halves the parallel batch size
      const maxBatch = this.maxParallelBatchSize;
      if (maxBatch !== Number.POSITIVE_INFINITY && group.length > maxBatch) {
        // 分成更小的子批次依次执行
        // — Chinese: split into smaller sub-batches and execute sequentially
        for (let subStart = 0; subStart < group.length; subStart += maxBatch) {
          const subgroup = group.slice(subStart, subStart + maxBatch);
          const subResults = await this.runParallelGroup(
            threadId,
            turnId,
            subgroup,
            collectedItems,
            runtimeContext,
            visibleToolNames,
          );
          subResults.forEach((result, offset) => {
            results[start + subStart + offset] = result;
          });
        }
        continue;
      }
      if (group.length === 1) {
        const toolCall = group[0];
        const result = await this.executeToolCall(
          threadId,
          turnId,
          toolCall,
          collectedItems,
          runtimeContext,
          visibleToolNames,
        );
        results[start] = { toolCall, ...result };
        continue;
      }

      const groupResults = await this.runParallelGroup(
        threadId,
        turnId,
        group,
        collectedItems,
        runtimeContext,
        visibleToolNames,
      );
      groupResults.forEach((result, offset) => {
        results[start + offset] = result;
      });
    }
    return results;
  }

  /** 执行一组可并发的工具调用（含事件追踪）。 */
  /** Execute a group of parallel-safe tool calls (with event tracking). */
  private async runParallelGroup(
    threadId: ThreadId,
    turnId: TurnId,
    group: ToolCall[],
    collectedItems: ThreadItem[],
    runtimeContext: RuntimeTurnContext,
    visibleToolNames?: ReadonlySet<string>,
  ): Promise<ToolCallExecutionResult[]> {
    const toolNames = group.map((toolCall) => resolveToolName(this.tools, toolCall.function.name));
    await this.appendRunMonitorEvent(turnId, {
      category: 'tool',
      type: 'tool.batch.started',
      message: `Parallel tool batch started (${toolNames.join(', ')})`,
      metadata: { parallel: true, toolCount: group.length, toolNames },
    });
    try {
      const groupResults = await Promise.all(group.map(async (toolCall) => {
        const result = await this.executeToolCall(
          threadId,
          turnId,
          toolCall,
          collectedItems,
          runtimeContext,
          visibleToolNames,
        );
        return { toolCall, ...result };
      }));
      await this.appendRunMonitorEvent(turnId, {
        category: 'tool',
        type: 'tool.batch.completed',
        message: `Parallel tool batch completed (${toolNames.join(', ')})`,
        metadata: { parallel: true, toolCount: group.length, toolNames },
      });
      return groupResults;
    } catch (error) {
      await this.appendRunMonitorEvent(turnId, {
        category: 'tool',
        type: 'tool.batch.failed',
        level: 'error',
        message: error instanceof Error ? error.message : String(error),
        metadata: { parallel: true, toolCount: group.length, toolNames },
      });
      throw error;
    }
  }

  private supportsParallelToolCall(
    toolCall: ToolCall,
    visibleToolNames?: ReadonlySet<string>,
  ): boolean {
    const toolName = resolveToolName(this.tools, toolCall.function.name);
    if (visibleToolNames && !visibleToolNames.has(toolName)) return false;
    if (isCollabTool(toolName)) return false;
    if (!this.isToolAllowedByRole(toolName)) return false;
    const toolDef = this.tools.get(toolName);
    if (toolDef?.supportsParallelToolCalls !== true
      || toolDef.requiredPolicy !== 'readonly'
      || toolDef.requiresApproval === true) {
      return false;
    }
    // 中文注释：系统监控限流 — moderate 及以上强制串行
    // — Chinese: system monitor throttle — moderate+ forces sequential execution
    const level = this.systemMonitorLevel;
    if (level === 'moderate' || level === 'severe') return false;
    return true;
  }

  /** 根据系统监控级别返回并发工具批次的最大大小。 */
  /** Max parallel batch size based on system monitor level. */
  private get maxParallelBatchSize(): number {
    const level = this.systemMonitorLevel;
    switch (level) {
      case 'severe':
      case 'moderate':
        return 1; // 全串行
      case 'light':
        return Math.min(this.config.maxParallelReadonlyTools, 2); // 并发数减半（不超过用户上限）
      case 'none':
      default:
        return this.config.maxParallelReadonlyTools;
    }
  }

  private async executeToolCall(
    threadId: ThreadId,
    turnId: TurnId,
    toolCall: ToolCall,
    collectedItems: ThreadItem[],
    runtimeContext: RuntimeTurnContext,
    visibleToolNames?: ReadonlySet<string>,
  ): Promise<{ output: string; disableWebSearch?: boolean; activateToolNames?: string[] }> {
    const requestedToolName = toolCall.function.name;
    const toolName = resolveToolName(this.tools, requestedToolName);
    let args: Record<string, unknown>;
    try {
      args = JSON.parse(toolCall.function.arguments);
    } catch {
      args = {};
    }

    const ctx: ToolContext = {
      workspaceRoot: this.config.workspaceRoot,
      threadId,
      turnId,
      approved: false,
      signal: this.stateManager.get(threadId).cancelController?.signal,
      webProvider: this.config.webProvider,
      accessPolicy: this.runtimeAccessPolicy,
      requestAccess: (request) => this.requestAccess(threadId, turnId, {
        ...request,
        toolCallId: request.toolCallId ?? toolCall.id,
      }),
      // 中文注释：注入系统监控引用，工具内部可调用 get_system_status 查询主机状态
      // — Chinese: inject system monitor reference so tools can query host status
      systemMonitor: this._systemMonitor ?? undefined,
      requestUserDecision: (input) => this.waitForUserDecision(threadId, input),
    };

    // Check sandbox policy
    // 检查沙箱策略
    const toolDef = this.tools.get(toolName);
    if (!toolDef) {
      const msg = this.i18n.t('runtime.unknown_tool', { tool: toolName });
      const errorItem: ThreadItem = {
        id: generateItemId(turnId, collectedItems.length),
        type: 'error',
        turnId,
        message: msg,
        timestamp: new Date().toISOString(),
      };
      collectedItems.push(errorItem);
      this.emitItem(threadId, turnId, errorItem);
      return { output: msg };
    }
    // 中文注释：系统监控限流 — severe 级别只允许 readonly 工具，阻止写操作
    // — Chinese: system monitor throttle — severe level only allows readonly tools, blocks writes
    if (this.systemMonitorLevel === 'severe' && toolDef.requiredPolicy !== 'readonly') {
      const blockedMsg = `[System Monitor] Host under severe pressure. Write/dangerous tools are temporarily blocked. Only readonly tools are allowed. Please wait for load to decrease.`;
      const response: RuntimeToolResponse = {
        status: 'failed',
        output: blockedMsg,
        error: { message: 'Tool blocked by system monitor (severe level).', code: 'SYSTEM_MONITOR_SEVERE_BLOCK' },
      };
      const runtimeToolRequest: RuntimeToolRequest = {
        toolCall,
        requestedToolName,
        toolName,
        args,
        toolDef,
        toolContext: ctx,
      };
      await this.runtimeMiddleware.afterTool(runtimeContext, runtimeToolRequest, response);
      const output = await this.recordMiddlewareToolResponse(
        threadId,
        turnId,
        toolName,
        args,
        collectedItems,
        response,
      );
      return { output };
    }
    if (!this.isToolAllowedByRole(toolName)) {
      const response: RuntimeToolResponse = {
        status: 'failed',
        output: `Tool ${toolName} is not allowed by active agent role ${this.config.activeAgentRoleProfile?.name}.`,
        error: { message: 'Tool blocked by active agent role.', code: 'TOOL_BLOCKED_BY_AGENT_ROLE' },
      };
      const runtimeToolRequest: RuntimeToolRequest = {
        toolCall,
        requestedToolName,
        toolName,
        args,
        toolDef,
        toolContext: ctx,
      };
      await this.runtimeMiddleware.afterTool(runtimeContext, runtimeToolRequest, response);
      const output = await this.recordMiddlewareToolResponse(
        threadId,
        turnId,
        toolName,
        args,
        collectedItems,
        response,
      );
      return { output };
    }

    const runtimeToolRequest: RuntimeToolRequest = {
      toolCall,
      requestedToolName,
      toolName,
      args,
      toolDef,
      toolContext: ctx,
    };
    await this.appendRunMonitorEvent(turnId, {
      category: 'middleware',
      type: 'middleware.beforeTool',
      message: `beforeTool middleware started for ${toolName}`,
      toolName,
    });
    const middlewareItem = {
      id: generateItemId(turnId, collectedItems.length),
      type: 'tool_call',
      turnId,
      toolName,
      arguments: args,
      modelToolCallId: toolCall.id,
      modelToolName: toolCall.function.name,
      providerToolCall: {
        format: 'openai_chat',
        id: toolCall.id,
        name: toolCall.function.name,
        arguments: args,
        raw: toolCall,
      },
      status: 'in_progress',
      timestamp: new Date().toISOString(),
    } as ThreadItem;
    collectedItems.push(middlewareItem);
    this.emit({ type: 'item.started', threadId, turnId, item: middlewareItem });
    void this.appendItemRunMonitorEvent(threadId, turnId, middlewareItem, 'item.started');
    await this.appendRunMonitorEvent(turnId, {
      category: 'tool',
      type: 'tool.started',
      message: `Tool ${toolName} started`,
      toolName,
      metadata: {
        itemId: middlewareItem.id,
        callId: toolCall.id,
        argsSummary: redactMonitorArgs(args),
        ...resourceMetadataForToolCall(toolName, args, null),
      },
    });
    const middlewareShortCircuit = await this.runtimeMiddleware.beforeTool(runtimeContext, runtimeToolRequest);
    // 发 task.runtime.updated phase=tool — 进入工具调用阶段
    this.emitTaskRuntimeUpdated(threadId, turnId, 'tool', 'running');
    if (middlewareShortCircuit) {
      await this.runtimeMiddleware.afterTool(runtimeContext, runtimeToolRequest, middlewareShortCircuit);
      if (isCollabTool(toolName)) {
        const output = await this.recordMiddlewareToolResponse(threadId, turnId, toolName, args, collectedItems, middlewareShortCircuit);
        await this.appendRunMonitorEvent(turnId, {
          category: 'tool',
          type: middlewareShortCircuit.status === 'failed' ? 'tool.failed' : 'tool.completed',
          level: middlewareShortCircuit.status === 'failed' ? 'warning' : 'info',
          message: middlewareShortCircuit.output,
          toolName,
          metadata: { status: middlewareShortCircuit.status, shortCircuited: true },
        });
        return { output, disableWebSearch: middlewareShortCircuit.disableWebSearch };
      }
      const middlewareToolItem = middlewareItem as ThreadItem & {
        status: RuntimeToolResponse['status'];
        error?: { message: string; code?: string };
        result?: unknown;
        completedAt?: string;
      };
      middlewareToolItem.status = middlewareShortCircuit.status;
      middlewareToolItem.error = middlewareShortCircuit.error;
      middlewareToolItem.result = middlewareShortCircuit.data ?? middlewareShortCircuit.output;
      middlewareToolItem.completedAt = new Date().toISOString();
      this.emit({ type: 'item.completed', threadId, turnId, item: middlewareToolItem });
      void this.appendItemRunMonitorEvent(threadId, turnId, middlewareToolItem, 'item.completed');
      await this.persistItems(threadId, [middlewareToolItem]);
      const output = middlewareShortCircuit.output;
      await this.appendRunMonitorEvent(turnId, {
        category: 'tool',
        type: middlewareShortCircuit.status === 'failed' ? 'tool.failed' : 'tool.completed',
        level: middlewareShortCircuit.status === 'failed' ? 'warning' : 'info',
        message: middlewareShortCircuit.output,
        toolName,
        metadata: { status: middlewareShortCircuit.status, shortCircuited: true },
      });
      return { output, disableWebSearch: middlewareShortCircuit.disableWebSearch };
    }

    if (visibleToolNames && !visibleToolNames.has(toolName)) {
      const response: RuntimeToolResponse = {
        status: 'failed',
        output: this.config.locale === 'zh'
          ? `工具 "${toolName}" 尚未绑定。请先调用 ${TOOL_SEARCH_TOOL_NAME} 搜索并绑定需要的工具 schema，然后再调用该工具。`
          : `Tool "${toolName}" is not bound yet. Call ${TOOL_SEARCH_TOOL_NAME} first to search and bind the needed tool schema, then call this tool again.`,
        error: {
          code: 'TOOL_NOT_BOUND',
          message: `Tool "${toolName}" is not visible in the current delayed binding set`,
        },
        data: {
          requestedToolName,
          toolName,
          visibleTools: [...visibleToolNames].sort(),
        },
      };
      await this.runtimeMiddleware.afterTool(runtimeContext, runtimeToolRequest, response);
      const output = await this.recordMiddlewareToolResponse(
        threadId,
        turnId,
        toolName,
        args,
        collectedItems,
        response,
      );
      await this.appendRunMonitorEvent(turnId, {
        category: 'tool',
        type: 'tool.failed',
        level: 'warning',
        message: response.output,
        toolName,
        metadata: { status: response.status, code: response.error?.code },
      });
      return { output };
    }

    if (isCollabTool(toolName)) {
      const middlewareItemIndex = collectedItems.indexOf(middlewareItem);
      if (middlewareItemIndex >= 0) collectedItems.splice(middlewareItemIndex, 1);
      const response = await this.runtimeMiddleware.wrapTool(runtimeContext, runtimeToolRequest, async () => {
        const result = await this.executeCollabToolCall(threadId, turnId, toolName, args, collectedItems);
        return { output: result.output, status: 'completed' };
      });
      await this.runtimeMiddleware.afterTool(runtimeContext, runtimeToolRequest, response);
      if (!collectedItems.some((item) => item.type === 'collab_tool_call')) {
        const output = await this.recordMiddlewareToolResponse(
          threadId,
          turnId,
          toolName,
          args,
          collectedItems,
          response,
        );
        return { output, disableWebSearch: response.disableWebSearch };
      }
      return { output: response.output, disableWebSearch: response.disableWebSearch };
    }

    // Pre-tool hook
    // 工具前钩子
    await this.config.hooks.trigger('pre_tool_use', {
      threadId,
      turnId,
      toolName: requestedToolName === toolName ? toolName : `${requestedToolName} -> ${toolName}`,
      toolArgs: args,
      workspaceRoot: this.config.workspaceRoot,
    });

    // Start item
    // 启动条目
    const itemId = generateItemId(turnId, collectedItems.length);
    const mcpIdentity = parseMcpNamespacedToolName(toolName);
    const toolItem: ThreadItem = {
      id: itemId,
      type: mcpIdentity ? 'mcp_tool_call' : 'tool_call',
      turnId,
      ...(mcpIdentity
        ? {
            server: mcpIdentity.serverId,
            tool: mcpIdentity.toolName,
            arguments: args,
          }
        : {
            toolName,
            arguments: args,
          }),
      modelToolCallId: toolCall.id,
      modelToolName: toolCall.function.name,
      providerToolCall: {
        format: 'openai_chat',
        id: toolCall.id,
        name: toolCall.function.name,
        arguments: args,
        raw: toolCall,
      },
      status: 'in_progress',
      timestamp: new Date().toISOString(),
    } as ThreadItem;
    collectedItems.push(toolItem);
    this.emit({ type: 'item.started', threadId, turnId, item: toolItem });
    void this.appendItemRunMonitorEvent(threadId, turnId, toolItem, 'item.started');
    const toolResourceMetadata = resourceMetadataForToolCall(toolName, args, mcpIdentity);
    await this.appendRunMonitorEvent(turnId, {
      category: 'tool',
      type: 'tool.started',
      message: `Tool ${toolName} started`,
      toolName,
      metadata: {
        itemId,
        callId: toolCall.id,
        argsSummary: redactMonitorArgs(args),
        ...toolResourceMetadata,
      },
    });

    const prePatchSnapshots = toolName === 'apply_patch'
      ? await capturePrePatchSnapshots(args, this.config.workspaceRoot)
      : toolName === 'write_file'
        ? await captureWriteFilePathSnapshot(args, this.config.workspaceRoot)
        : new Map<string, string | null>();

    // Execute
    // 执行
    let result: RuntimeToolResponse;
    try {
      result = await this.runtimeMiddleware.wrapTool(
        runtimeContext,
        runtimeToolRequest,
        (request) => this.tools.execute(request.toolName, request.args, request.toolContext),
      );
    } catch (error) {
      const failedToolItem = toolItem as ThreadItem & {
        status: 'failed';
        error?: { message: string; code?: string };
        result?: unknown;
        completedAt?: string;
      };
      failedToolItem.status = 'failed';
      failedToolItem.error = {
        message: error instanceof Error ? error.message : String(error),
        code: (error as { code?: string } | undefined)?.code,
      };
      failedToolItem.result = { error: failedToolItem.error.message, code: failedToolItem.error.code };
      failedToolItem.completedAt = new Date().toISOString();
      this.emit({ type: 'item.completed', threadId, turnId, item: failedToolItem });
      void this.appendItemRunMonitorEvent(threadId, turnId, failedToolItem, 'item.completed');
      await this.persistItems(threadId, [failedToolItem]);
      throw error;
    }

    // Update item
    // 更新条目
    (toolItem as ThreadItem & { status: typeof result.status }).status = result.status;
    if (result.error) {
      (toolItem as ThreadItem & { error?: { message: string } }).error = result.error;
    }
    if (mcpIdentity) {
      const data = result.data && typeof result.data === 'object'
        ? result.data as { content?: unknown[]; structuredContent?: unknown }
        : {};
      (toolItem as ThreadItem & { result?: unknown }).result = {
        content: Array.isArray(data.content) ? data.content : [result.output],
        structuredContent: data.structuredContent ?? null,
      };
    } else {
      (toolItem as ThreadItem & { result?: unknown }).result = result.data ?? result.output;
    }
    this.emit({ type: 'item.completed', threadId, turnId, item: toolItem });
    void this.appendItemRunMonitorEvent(threadId, turnId, toolItem, 'item.completed');

    // Persist
    // 持久化
    await this.persistItems(threadId, [toolItem]);

    if ((toolName === 'apply_patch' || toolName === 'write_file') && result.status === 'completed') {
      const changes = toolName === 'apply_patch'
        ? normalizeFileChanges(result.data)
        : buildWriteFileChanges(args, prePatchSnapshots);
      if (changes.length > 0) {
        const fileItem: ThreadItem = {
          id: generateItemId(turnId, collectedItems.length),
          type: 'file_change',
          turnId,
          changes,
          hunks: changes.flatMap((change) => change.hunks ?? []),
          summary: changes.map((change) => change.summary ?? `${change.kind} ${change.path}`).join('\n'),
          status: 'completed',
          timestamp: new Date().toISOString(),
        };
        collectedItems.push(fileItem);
        this.emit({ type: 'item.started', threadId, turnId, item: fileItem });
        this.emit({ type: 'item.completed', threadId, turnId, item: fileItem });
        void this.appendItemRunMonitorEvent(threadId, turnId, fileItem, 'item.started');
        void this.appendItemRunMonitorEvent(threadId, turnId, fileItem, 'item.completed');
        await this.persistItems(threadId, [fileItem]);
        await this.appendFileChangeRunMonitorEvents(turnId, itemId, toolName, changes);
        const projectCheckpoint = await createProjectCheckpointItem({
          threadId,
          turnId,
          itemId: generateItemId(turnId, collectedItems.length),
          turnCount: await activeTurnCount(this.config.store, threadId),
          workspaceRoot: this.config.workspaceRoot,
          changes,
          beforeSnapshots: prePatchSnapshots,
          collectedItems,
        });
        if (projectCheckpoint.files.length > 0) {
          collectedItems.push(projectCheckpoint);
          this.emit({ type: 'item.started', threadId, turnId, item: projectCheckpoint });
          this.emit({ type: 'item.completed', threadId, turnId, item: projectCheckpoint });
          void this.appendItemRunMonitorEvent(threadId, turnId, projectCheckpoint, 'item.started');
          void this.appendItemRunMonitorEvent(threadId, turnId, projectCheckpoint, 'item.completed');
          await this.persistItems(threadId, [projectCheckpoint]);
        }
        this.emit({
          type: 'turn.diff.updated',
          threadId,
          turnId,
          diff: changes.map((change) => `${change.kind} ${change.path} +${change.addedLines ?? 0}/-${change.removedLines ?? 0}`).join('\n'),
        });
      }
    }

    // Post-tool hook
    // 工具后钩子
    await this.config.hooks.trigger('post_tool_use', {
      threadId,
      turnId,
      toolName,
      toolArgs: args,
      toolResult: result,
      workspaceRoot: this.config.workspaceRoot,
    });

    await this.runtimeMiddleware.afterTool(runtimeContext, runtimeToolRequest, result);
    await this.appendRunMonitorEvent(turnId, {
      category: 'tool',
      type: result.status === 'failed' ? 'tool.failed' : 'tool.completed',
      level: result.status === 'failed' ? 'error' : 'info',
      message: result.status === 'failed' ? (result.error?.message ?? result.output) : `Tool ${toolName} completed`,
      toolName,
      metadata: {
        itemId,
        callId: toolCall.id,
        status: result.status,
        resultSummary: summarizeToolResultForMonitor(result.data ?? result.output),
        ...toolResourceMetadata,
      },
    });
    await this.appendFileLifecycleRunMonitorEvents(turnId, itemId, toolName, result.data);

    return {
      output: result.output,
      disableWebSearch: result.disableWebSearch,
      activateToolNames: toolName === TOOL_SEARCH_TOOL_NAME
        ? toolNamesFromSearchResult(result.data)
        : undefined,
    };
  }

  private async recordMiddlewareToolResponse(
    threadId: ThreadId,
    turnId: TurnId,
    toolName: string,
    args: Record<string, unknown>,
    collectedItems: ThreadItem[],
    response: RuntimeToolResponse,
  ): Promise<string> {
    if (isCollabTool(toolName)) {
      const item: CollabToolCallItem = {
        id: generateItemId(turnId, collectedItems.length),
        type: 'collab_tool_call',
        turnId,
        tool: toolName,
        status: response.status,
        senderThreadId: threadId,
        receiverThreadId: stringArg(args, 'threadId') ?? stringArg(args, 'agentId'),
        prompt: stringArg(args, 'prompt'),
        error: response.error,
        result: response.data ?? response.output,
        timestamp: new Date().toISOString(),
      };
      collectedItems.push(item);
      this.emit({ type: 'item.started', threadId, turnId, item });
      this.emit({ type: 'item.completed', threadId, turnId, item });
      void this.appendItemRunMonitorEvent(threadId, turnId, item, 'item.started');
      void this.appendItemRunMonitorEvent(threadId, turnId, item, 'item.completed');
      await this.persistItems(threadId, [item]);
      return response.output;
    }

    const mcpIdentity = parseMcpNamespacedToolName(toolName);
    const toolItem: ThreadItem = {
      id: generateItemId(turnId, collectedItems.length),
      type: mcpIdentity ? 'mcp_tool_call' : 'tool_call',
      turnId,
      ...(mcpIdentity
        ? {
            server: mcpIdentity.serverId,
            tool: mcpIdentity.toolName,
            arguments: args,
          }
        : {
            toolName,
            arguments: args,
          }),
      status: response.status,
      error: response.error,
      result: response.data ?? response.output,
      timestamp: new Date().toISOString(),
    } as ThreadItem;
    collectedItems.push(toolItem);
    this.emit({ type: 'item.started', threadId, turnId, item: toolItem });
    this.emit({ type: 'item.completed', threadId, turnId, item: toolItem });
    void this.appendItemRunMonitorEvent(threadId, turnId, toolItem, 'item.started');
    void this.appendItemRunMonitorEvent(threadId, turnId, toolItem, 'item.completed');
    await this.persistItems(threadId, [toolItem]);
    return response.output;
  }

  private async executeCollabToolCall(
    threadId: ThreadId,
    turnId: TurnId,
    toolName: CollabToolName,
    args: Record<string, unknown>,
    collectedItems: ThreadItem[],
  ): Promise<{ output: string }> {
    const item: CollabToolCallItem = {
      id: generateItemId(turnId, collectedItems.length),
      type: 'collab_tool_call',
      turnId,
      tool: toolName,
      status: 'in_progress',
      senderThreadId: threadId,
      receiverThreadId: stringArg(args, 'threadId') ?? stringArg(args, 'agentId'),
      prompt: stringArg(args, 'prompt'),
      timestamp: new Date().toISOString(),
    };
    collectedItems.push(item);
    this.emit({ type: 'item.started', threadId, turnId, item });
    void this.appendItemRunMonitorEvent(threadId, turnId, item, 'item.started');

    try {
      const result = await this.runCollabTool(threadId, toolName, args, item);
      item.status = 'completed';
      item.result = result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const code = error && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string'
        ? (error as { code: string }).code
        : undefined;
      item.status = 'failed';
      item.error = code ? { message, code } : { message };
      item.result = code ? { error: message, code } : { error: message };
    }

    this.emit({ type: 'item.completed', threadId, turnId, item });
    void this.appendItemRunMonitorEvent(threadId, turnId, item, 'item.completed');
    await this.persistItems(threadId, [item]);
    return { output: formatCollabToolOutput(item, this.config.locale) };
  }

  private async runCollabTool(
    parentThreadId: ThreadId,
    toolName: CollabToolName,
    args: Record<string, unknown>,
    item: CollabToolCallItem,
  ): Promise<unknown> {
    switch (toolName) {
      case 'spawn_agent':
        return this.spawnSubagent(parentThreadId, args, item);
      case 'send_input':
        return this.sendInputToSubagent(parentThreadId, args, item);
      case 'send_message':
        return this.sendInterAgentMessage(parentThreadId, args, item, false);
      case 'followup_task':
        return this.sendInterAgentMessage(parentThreadId, args, item, true);
      case 'resume_agent':
        return this.resumeSubagent(parentThreadId, args, item);
      case 'wait':
      case 'wait_agent':
        return this.waitForSubagents(parentThreadId, args, item);
      case 'list_agents':
        return this.listSubagents(parentThreadId, args, item);
      case 'close_agent':
        return this.closeSubagent(parentThreadId, args, item);
      case 'spawn_remote_agent':
        return this.spawnRemoteAgent(parentThreadId, args, item);
      default:
        throw new Error(`Unknown collaboration tool: ${toolName}`);
    }
  }

  /**
   * 委派任务到外部 A2A Agent（跨框架协作）。
   * 通过 @a2a-js/sdk 的 ClientFactory 与远程 Agent 通信。
   *
   * 优先使用流式接口（sendMessageStream），将远程 Agent 的中间状态
   * 实时以 item.updated 事件回传给父线程；若远程 Agent 不支持流式
   * 或建立流失败，则回退到阻塞式 sendMessage。
   */
  // — Chinese: delegate task to remote A2A agent. Prefers streaming with real-time
  // status feedback; falls back to blocking mode if streaming unavailable.
  private async spawnRemoteAgent(
    parentThreadId: ThreadId,
    args: Record<string, unknown>,
    item: CollabToolCallItem,
  ): Promise<unknown> {
    const agentUrl = stringArg(args, 'agentUrl');
    if (!agentUrl) throw new Error('spawn_remote_agent requires agentUrl');
    const task = stringArg(args, 'task');
    if (!task) throw new Error('spawn_remote_agent requires task');
    const context = stringArg(args, 'context');

    // 把任务描述记录到 collab tool call item 上，便于前端展示与回放
    // — Chinese: record task description on collab tool call item for UI display
    item.prompt = task;
    item.agentStatus = 'running';
    item.receiverThreadId = agentUrl;

    const { RemoteAgentClient } = await import('./a2aClient/remoteAgentClient.js');
    const remoteClient = new RemoteAgentClient();

    let result;
    try {
      // 流式模式：实时消费远程事件并转发 item.updated 到父线程
      // — Chinese: streaming mode: consume remote events, forward as item.updated
      result = await this.consumeRemoteAgentStream(remoteClient, agentUrl, task, context, parentThreadId, item);
    } catch {
      // 流式建立失败（远程 Agent 不支持 streaming 或连接异常）→ 回退到阻塞模式
      // — Chinese: streaming setup failed (unsupported or connection error) → fall back to blocking
      result = await remoteClient.sendTask(agentUrl, task, context);
    }

    // 把远程 Agent 的 URL 与最终状态记到 item 上
    // — Chinese: record remote agent URL and final status on item
    item.agentStatus = result.status === 'completed' ? 'completed' : result.status === 'failed' ? 'failed' : 'running';

    let output = `Remote agent response (${agentUrl}):\n${result.text || '(no text reply)'}`;
    if (result.artifacts.length > 0) {
      output += '\n\nArtifacts:';
      for (const a of result.artifacts) {
        output += `\n${a.name || 'unnamed'}: ${a.text || '(empty)'}`;
      }
    }
    if (result.error) {
      output += `\n\nError: ${result.error}`;
    }

    return {
      agentUrl,
      taskId: result.taskId,
      status: result.status,
      text: result.text,
      artifacts: result.artifacts,
      error: result.error,
      output,
    };
  }

  /**
   * 消费远程 Agent 的流式事件，实时把状态变化以 item.updated 事件转发到父线程。
   * 同时累积状态轨迹（remoteStatusTrail）和中间文本流（remoteTextStream）到 item 上，
   * 供前端展示 working → input-required → completed 的过程与流式文本。
   * 返回与 sendTask 相同结构的聚合结果。
   */
  // — Chinese: consume remote agent stream events, forward status as item.updated.
  // Accumulates status trail and text stream on item for UI display.
  private async consumeRemoteAgentStream(
    remoteClient: RemoteAgentClient,
    agentUrl: string,
    task: string,
    context: string | undefined,
    parentThreadId: ThreadId,
    item: CollabToolCallItem,
  ): Promise<{
    taskId?: string;
    status: 'completed' | 'failed' | 'working';
    text: string;
    artifacts: Array<{ name?: string; text: string }>;
    error?: string;
  }> {
    const turnId = item.turnId;
    const artifacts: Array<{ name?: string; text: string }> = [];
    let text = '';
    let taskId: string | undefined;
    let finalStatus: 'completed' | 'failed' | 'working' = 'working';

    // 初始化轨迹和文本流容器（仅在首次调用时创建）
    // — Chinese: init trail and text stream containers (only on first call)
    if (!item.remoteStatusTrail) item.remoteStatusTrail = [];
    if (!item.remoteTextStream) item.remoteTextStream = [];

    for await (const event of remoteClient.sendTaskStream(agentUrl, task, context)) {
      switch (event.type) {
        case 'status': {
          const statusEvent = event.data as { taskId?: string; status?: { state?: string; timestamp?: string; message?: { parts?: Array<{ kind: string; text?: string }> } } } | undefined;
          if (statusEvent?.taskId) taskId = statusEvent.taskId;
          const state = statusEvent?.status?.state ?? 'unknown';
          const eventTimestamp = statusEvent?.status?.timestamp ?? new Date().toISOString();

          // 更新 item 状态
          // — Chinese: update item agentStatus based on state
          if (state === 'working') {
            item.agentStatus = 'running';
          } else if (state === 'completed') {
            item.agentStatus = 'completed';
            finalStatus = 'completed';
          } else if (state === 'failed' || state === 'canceled' || state === 'rejected') {
            item.agentStatus = 'failed';
            finalStatus = 'failed';
          } else if (state === 'input-required') {
            item.agentStatus = 'running';
          }

          // 从 status.message 中提取中间文本（如果有）
          // — Chinese: extract intermediate text from status.message if present
          let intermediateText: string | undefined;
          const messageParts = statusEvent?.status?.message?.parts;
          if (messageParts) {
            intermediateText = messageParts
              .filter((p) => p.kind === 'text')
              .map((p) => p.text ?? '')
              .join('');
          }

          // 追加到状态轨迹
          // — Chinese: append to status trail
          item.remoteStatusTrail.push({
            timestamp: eventTimestamp,
            state,
            text: intermediateText,
          });

          // 若有中间文本，同时追加到文本流
          // — Chinese: if intermediate text present, also append to text stream
          if (intermediateText) {
            item.remoteTextStream.push({
              timestamp: eventTimestamp,
              text: intermediateText,
            });
          }

          this.emit({ type: 'item.updated', threadId: parentThreadId, turnId, item });
          break;
        }
        case 'message': {
          // 远程 Agent 的最终消息 → 提取文本
          // — Chinese: remote agent's final message → extract text
          const message = event.data as { parts?: Array<{ kind: string; text?: string }> } | undefined;
          if (message?.parts) {
            const messageText = message.parts
              .filter((p) => p.kind === 'text')
              .map((p) => p.text ?? '')
              .join('\n');
            if (messageText) text = text ? `${text}\n${messageText}` : messageText;
          }
          break;
        }
        case 'artifact': {
          // 远程 Agent 的产物 → 收集
          // — Chinese: remote agent artifact → collect
          const artifactEvent = event.data as { artifact?: { name?: string; parts?: Array<{ kind: string; text?: string }> } } | undefined;
          const artifact = artifactEvent?.artifact;
          if (artifact) {
            const artifactText = (artifact.parts ?? [])
              .filter((p) => p.kind === 'text')
              .map((p) => p.text ?? '')
              .join('\n');
            artifacts.push({ name: artifact.name, text: artifactText });
          }
          break;
        }
        case 'task': {
          // 完整 Task 对象 → 提取 taskId
          // — Chinese: full Task object → extract taskId
          const taskObj = event.data as { id?: string } | undefined;
          if (taskObj?.id) taskId = taskObj.id;
          break;
        }
        case 'error': {
          finalStatus = 'failed';
          item.agentStatus = 'failed';
          // 错误也记入状态轨迹，便于前端展示失败时点
          // — Chinese: record error in status trail for UI to show failure point
          const errTimestamp = new Date().toISOString();
          item.remoteStatusTrail.push({
            timestamp: errTimestamp,
            state: 'failed',
            text: event.error,
          });
          this.emit({ type: 'item.updated', threadId: parentThreadId, turnId, item });
          return {
            taskId,
            status: 'failed',
            text,
            artifacts,
            error: event.error ?? 'Remote agent stream error',
          };
        }
        case 'done': {
          // 流结束 — 如果尚未收到最终状态，默认 completed
          // — Chinese: stream done — default to completed if no final status received
          if (finalStatus === 'working') finalStatus = 'completed';
          return { taskId, status: finalStatus, text, artifacts };
        }
        default:
          break;
      }
    }

    // 流自然结束但未收到 done 事件 — 用已收集的数据返回
    // — Chinese: stream ended naturally without done event — return collected data
    if (finalStatus === 'working') finalStatus = 'completed';
    return { taskId, status: finalStatus, text, artifacts };
  }

  private async spawnSubagent(
    parentThreadId: ThreadId,
    args: Record<string, unknown>,
    item: CollabToolCallItem,
  ): Promise<unknown> {
    const prompt = stringArg(args, 'prompt')?.trim();
    if (!prompt) throw new Error('spawn_agent requires prompt');
    // 中文注释：系统监控限流 — 主机压力大时阻止新增子 agent
    // — Chinese: system monitor throttle — block new subagent spawns under host pressure
    const level = this.systemMonitorLevel;
    if (level !== 'none') {
      const status = this._systemMonitor?.getStatus();
      const reason = status?.recommendation ?? 'Host under pressure';
      const error = new Error(
        `Subagent delegation blocked by system monitor (level: ${level}). ${reason}`,
      );
      (error as Error & { code?: string }).code = 'SYSTEM_MONITOR_THROTTLED';
      throw error;
    }
    const openEdges = await this.config.store.listThreadSpawnDescendants(parentThreadId, 'open');
    const parentMaxSubagents = this.config.activeAgentRoleProfile?.maxSubagents ?? this.config.maxSubagents;
    if (openEdges.length >= parentMaxSubagents) {
      throw new Error(`Maximum open subagents reached: ${parentMaxSubagents}`);
    }

    const parent = await this.config.store.getThread(parentThreadId);
    if (!parent) throw new Error(`Thread ${parentThreadId} not found`);
    const nextDepth = await this.subagentDepth(parentThreadId) + 1;
    const parentMaxSubagentDepth = this.config.activeAgentRoleProfile?.maxSubagentDepth ?? this.config.maxSubagentDepth;
    if (nextDepth > parentMaxSubagentDepth) {
      const error = new Error(`Maximum subagent depth reached: ${parentMaxSubagentDepth}`);
      (error as Error & { code?: string }).code = 'SUBAGENT_DEPTH_LIMIT_REACHED';
      throw error;
    }
    const now = new Date().toISOString();
    const childThreadId = generateId();
    const roleName = stringArg(args, 'agentRole') ?? stringArg(args, 'agent_type') ?? stringArg(args, 'role') ?? DEFAULT_AGENT_ROLE_NAME;
    const roleProfile = resolveAgentRoleProfile(this.config.agentRoles, roleName);
    const agentRole = roleProfile.name;
    const agentNickname = stringArg(args, 'agentNickname') ?? stringArg(args, 'nickname') ?? agentRole;
    const spawnOverrides = {
      model: stringArg(args, 'model')?.trim() || undefined,
      reasoningEffort: stringArg(args, 'reasoningEffort') ?? stringArg(args, 'reasoning_effort') ?? undefined,
      serviceTier: stringArg(args, 'serviceTier') ?? stringArg(args, 'service_tier') ?? roleProfile.serviceTier ?? undefined,
      agentRole,
    };
    const child: ThreadMeta = {
      threadId: childThreadId,
      tenantId: this.config.tenantId,
      title: titleFromText(prompt),
      workspaceRoot: parent.workspaceRoot || this.config.workspaceRoot,
      status: 'active',
      turnCount: 0,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      ephemeral: parent.ephemeral,
      tags: {
        ...parent.tags,
        agentDepth: String(nextDepth),
        agentRoleProfile: roleProfile.name,
        ...(spawnOverrides.model ? { agentRequestedModel: spawnOverrides.model, agentModelInherited: 'true' } : {}),
        ...(spawnOverrides.reasoningEffort ? { agentReasoningEffort: spawnOverrides.reasoningEffort } : {}),
        ...(spawnOverrides.serviceTier ? { agentServiceTier: spawnOverrides.serviceTier } : {}),
      },
      parentThreadId,
      agentNickname,
      agentRole,
    };
    await this.config.store.createThread(child);
    await this.config.store.upsertThreadSpawnEdge({
      parentThreadId,
      tenantId: this.config.tenantId,
      childThreadId,
      status: 'open',
      createdAt: now,
      updatedAt: now,
    });

    item.newThreadId = childThreadId;
    item.receiverThreadId = childThreadId;
    item.agentStatus = 'running';

    const envelope = this.buildTransferEnvelope({
      parentThreadId,
      childThreadId,
      prompt,
      agentRole,
      agentNickname,
    });
    const childAgent = this.createChildAgent(agentRole, agentNickname, envelope, spawnOverrides, roleProfile);
    this.trackChildAgent(parentThreadId, childThreadId, childAgent);
    this.forwardChildEvents({
      childAgent,
      parentThreadId,
      childThreadId,
      agentNickname,
      agentRole,
    });
    const run = childAgent.runTurn(childThreadId, { type: 'text', text: prompt });
    this.subagentRuns.set(childThreadId, run);
    void run.catch(() => undefined);
    void run.finally(() => this.untrackChildAgent(parentThreadId, childThreadId)).catch(() => undefined);

    return {
      childThreadId,
      status: 'running',
      agentRole,
      agentNickname,
      envelope,
    };
  }

  private async sendInputToSubagent(
    parentThreadId: ThreadId,
    args: Record<string, unknown>,
    item: CollabToolCallItem,
  ): Promise<unknown> {
    const childThreadId = requiredThreadArg(args);
    const prompt = stringArg(args, 'prompt')?.trim() ?? stringArg(args, 'input')?.trim();
    if (!prompt) throw new Error('send_input requires prompt');
    await this.ensureChildThread(parentThreadId, childThreadId);
    if (this.stateManager.isRunning(childThreadId)) {
      if (args.interrupt === true) {
        await this.interruptSubagentTurn(childThreadId);
      } else {
        throw new Error(`Subagent ${childThreadId} is already running`);
      }
    }
    item.receiverThreadId = childThreadId;
    item.prompt = prompt;
    item.agentStatus = 'running';
    const child = await this.config.store.getThread(childThreadId);
    const agentRole = child?.agentRole ?? 'subagent';
    const agentNickname = child?.agentNickname ?? 'subagent';
    const envelope = this.buildTransferEnvelope({
      parentThreadId,
      childThreadId,
      prompt,
      agentRole,
      agentNickname,
    });
    const childAgent = this.createChildAgent(agentRole, agentNickname, envelope);
    this.trackChildAgent(parentThreadId, childThreadId, childAgent);
    this.forwardChildEvents({
      childAgent,
      parentThreadId,
      childThreadId,
      agentNickname,
      agentRole,
    });
    const run = childAgent.runTurn(childThreadId, { type: 'text', text: prompt });
    this.subagentRuns.set(childThreadId, run);
    void run.catch(() => undefined);
    void run.finally(() => this.untrackChildAgent(parentThreadId, childThreadId)).catch(() => undefined);
    await this.waitForSubagentPromptPersisted(childThreadId, prompt);
    return { childThreadId, status: 'running', envelope };
  }

  private async sendInterAgentMessage(
    parentThreadId: ThreadId,
    args: Record<string, unknown>,
    item: CollabToolCallItem,
    triggerTurn: boolean,
  ): Promise<unknown> {
    const childThreadId = stringArg(args, 'target') ?? stringArg(args, 'threadId') ?? stringArg(args, 'agentId');
    if (!childThreadId) throw new Error(`${item.tool} requires target`);
    const message = stringArg(args, 'message')?.trim() ?? stringArg(args, 'prompt')?.trim();
    if (!message) throw new Error(`${item.tool} requires message`);
    const child = await this.ensureChildThread(parentThreadId, childThreadId);
    await this.appendAgentMailboxMessage(child, {
      senderThreadId: parentThreadId,
      receiverThreadId: childThreadId,
      content: message,
      triggerTurn,
      createdAt: new Date().toISOString(),
    });

    item.receiverThreadId = childThreadId;
    item.prompt = message;
    item.agentStatus = triggerTurn ? 'running' : 'open';

    if (!triggerTurn) {
      return { childThreadId, status: 'queued', triggerTurn: false };
    }
    if (this.stateManager.isRunning(childThreadId)) {
      return { childThreadId, status: 'queued_running', triggerTurn: true };
    }

    const agentRole = child.agentRole ?? 'subagent';
    const agentNickname = child.agentNickname ?? 'subagent';
    const envelope = this.buildTransferEnvelope({
      parentThreadId,
      childThreadId,
      prompt: message,
      agentRole,
      agentNickname,
    });
    const childAgent = this.createChildAgent(agentRole, agentNickname, envelope);
    this.trackChildAgent(parentThreadId, childThreadId, childAgent);
    this.forwardChildEvents({
      childAgent,
      parentThreadId,
      childThreadId,
      agentNickname,
      agentRole,
    });
    const run = childAgent.runTurn(childThreadId, { type: 'text', text: message });
    this.subagentRuns.set(childThreadId, run);
    void run.catch(() => undefined);
    void run.finally(() => this.untrackChildAgent(parentThreadId, childThreadId)).catch(() => undefined);
    await this.waitForSubagentPromptPersisted(childThreadId, message);
    return { childThreadId, status: 'running', triggerTurn: true, envelope };
  }

  private async listSubagents(
    parentThreadId: ThreadId,
    args: Record<string, unknown>,
    item: CollabToolCallItem,
  ): Promise<unknown> {
    const pathPrefix = stringArg(args, 'path_prefix') ?? stringArg(args, 'pathPrefix');
    const edges = await this.config.store.listThreadSpawnDescendants(parentThreadId);
    const agents = [];
    for (const edge of edges) {
      const child = await this.config.store.getThread(edge.childThreadId);
      if (!child) continue;
      const taskName = child.agentNickname ?? child.agentRole ?? child.threadId;
      if (pathPrefix && !child.threadId.startsWith(pathPrefix) && !taskName.startsWith(pathPrefix)) continue;
      const runtimeState = await this.getRuntimeState(child.threadId);
      const latestTurn = (await this.config.store.getTurns(child.threadId)).at(-1);
      agents.push({
        threadId: child.threadId,
        agentId: child.threadId,
        taskName,
        agentRole: child.agentRole ?? null,
        agentNickname: child.agentNickname ?? null,
        edgeStatus: edge.status,
        status: runtimeState.status === 'idle' ? (latestTurn?.status ?? edge.status) : runtimeState.status,
        parentThreadId: edge.parentThreadId,
      });
    }
    item.agentStatus = agents.some((agent) => agent.status === 'running') ? 'running' : 'completed';
    return { agents };
  }

  private forwardChildEvents(options: {
    childAgent: AgentLoop;
    parentThreadId: ThreadId;
    childThreadId: ThreadId;
    agentNickname: string | null | undefined;
    agentRole: string | null | undefined;
  }): void {
    options.childAgent.onEvent((event) => {
      if ('turnId' in event && typeof event.turnId === 'string') {
        const childState = options.childAgent.getThreadState(options.childThreadId);
        const lifecycle = event.type === 'turn.completed' || event.type === 'turn.failed' || event.type === 'thread.runtime.updated';
        if (childState.activeTurnId !== event.turnId && childState.lastTerminalTurnId === event.turnId && !lifecycle) return;
      }
      this.emit(event);
      if (!('threadId' in event) || event.threadId !== options.childThreadId) return;
      this.emit({
        type: 'child_agent.event',
        threadId: options.parentThreadId,
        childThreadId: options.childThreadId,
        agentNickname: options.agentNickname ?? null,
        agentRole: options.agentRole ?? null,
        event: event as unknown as Record<string, unknown>,
      });
    });
  }

  private trackChildAgent(parentThreadId: ThreadId, childThreadId: ThreadId, childAgent: AgentLoop): void {
    const children = this.childAgentsByParent.get(parentThreadId) ?? new Map<ThreadId, AgentLoop>();
    children.set(childThreadId, childAgent);
    this.childAgentsByParent.set(parentThreadId, children);
  }

  private untrackChildAgent(parentThreadId: ThreadId, childThreadId: ThreadId): void {
    const children = this.childAgentsByParent.get(parentThreadId);
    if (!children) return;
    children.delete(childThreadId);
    if (children.size === 0) this.childAgentsByParent.delete(parentThreadId);
  }

  private async resumeSubagent(
    parentThreadId: ThreadId,
    args: Record<string, unknown>,
    item: CollabToolCallItem,
  ): Promise<unknown> {
    const childThreadId = requiredThreadArg(args);
    const child = await this.ensureChildThread(parentThreadId, childThreadId);
    item.receiverThreadId = childThreadId;
    const runtimeState = await this.getRuntimeState(childThreadId);
    if (runtimeState.checkpoint) {
      this.stateManager.setCheckpoint(childThreadId, runtimeState.checkpoint);
    }
    const agentStatus: CollabToolCallItem['agentStatus'] = runtimeState.resumable
      ? 'running'
      : runtimeState.status === 'idle'
        ? 'open'
        : runtimeState.status === 'stale'
          ? 'interrupted'
          : runtimeState.status === 'terminal'
            ? runtimeState.terminalStatus ?? 'completed'
            : runtimeState.status === 'stopping'
              ? 'interrupted'
              : runtimeState.status === 'waiting_user_input'
                ? 'running'
                : runtimeState.status;
    item.agentStatus = agentStatus;
    return {
      childThreadId,
      status: item.agentStatus,
      resumable: runtimeState.resumable,
      runtimeState,
      agentRole: child.agentRole,
      agentNickname: child.agentNickname,
    };
  }

  private async waitForSubagents(
    parentThreadId: ThreadId,
    args: Record<string, unknown>,
    item: CollabToolCallItem,
  ): Promise<unknown> {
    const requested = stringArg(args, 'threadId') ?? stringArg(args, 'agentId');
    const childThreadIds = requested
      ? [requested]
      : (await this.config.store.listThreadSpawnChildren(parentThreadId, 'open')).map((edge) => edge.childThreadId);
    const children: Array<{
      threadId: ThreadId;
      status: CollabToolCallItem['agentStatus'];
      latestResponse: string;
    }> = [];
    for (const childThreadId of childThreadIds) {
      await this.ensureChildThread(parentThreadId, childThreadId);
      const run = this.subagentRuns.get(childThreadId);
      if (run) {
        try {
          await run;
        } catch {
          // The child's own turn records the failure; wait reports the status below.
          // 子 agent 自己的回合会记录失败；等待会在下面报告状态。
        }
      }
      const turns = await this.config.store.getTurns(childThreadId);
      const latestTurn = turns.at(-1);
      const status: CollabToolCallItem['agentStatus'] = latestTurn?.status ?? 'completed';
      const items = await this.config.store.getItems(childThreadId);
      const latestResponse = [...items].reverse().find((candidate) => candidate.type === 'agent_message')?.text ?? '';
      children.push({ threadId: childThreadId, status, latestResponse });
    }
    if (children.length === 1) {
      item.receiverThreadId = children[0].threadId;
      item.agentStatus = children[0].status;
    }
    return { children };
  }

  private async closeSubagent(
    parentThreadId: ThreadId,
    args: Record<string, unknown>,
    item: CollabToolCallItem,
  ): Promise<unknown> {
    const childThreadId = requiredThreadArg(args);
    await this.ensureChildThread(parentThreadId, childThreadId);
    if (this.stateManager.isRunning(childThreadId)) {
      await this.interruptSubagentTurn(childThreadId);
    } else {
      const runtimeState = await this.getRuntimeState(childThreadId);
      if (runtimeState.resumable) {
        await this.interruptSubagentTurn(childThreadId);
      }
    }
    await this.config.store.setThreadSpawnEdgeStatus(parentThreadId, childThreadId, 'closed');
    item.receiverThreadId = childThreadId;
    item.agentStatus = 'closed';
    return { childThreadId, status: 'closed' };
  }

  private async interruptSubagentTurn(childThreadId: ThreadId): Promise<void> {
    const state = this.stateManager.get(childThreadId);
    const activeTurnId = state.activeTurnId;
    if (activeTurnId && state.status === 'running') {
      this.interrupt(childThreadId);
      const activeRun = this.subagentRuns.get(childThreadId);
      if (activeRun) {
        try {
          await activeRun;
        } catch {
          // The child turn persists its terminal cancellation state.
        }
        return;
      }
    }

    const checkpoint = state.lastCheckpoint ?? await this.config.store.getLastCheckpoint(childThreadId);
    const turnId = activeTurnId ?? (checkpoint?.status === 'running' ? checkpoint.turnId : null);
    if (!turnId) return;

    const turns = await this.config.store.getTurns(childThreadId);
    const turn = turns.find((candidate) => candidate.turnId === turnId);
    const timestamp = new Date().toISOString();
    if (turn && turn.status === 'running') {
      turn.status = 'interrupted';
      turn.completedAt = timestamp;
      await this.config.store.saveTurn(turn);
    }

    const itemIndex = checkpoint?.itemIndex ?? (await this.config.store.getItems(childThreadId)).length;
    const interruptedCheckpoint: Checkpoint = {
      threadId: childThreadId,
      turnId,
      itemIndex,
      timestamp,
      generation: state.generation,
      status: 'interrupted',
    };
    await this.writeCheckpoint(childThreadId, interruptedCheckpoint);
    this.stateManager.completeInterruptedTurn(childThreadId, turnId);
  }

  private async waitForSubagentPromptPersisted(childThreadId: ThreadId, prompt: string): Promise<void> {
    const deadline = Date.now() + 1_000;
    while (Date.now() < deadline) {
      const items = await this.config.store.getItems(childThreadId);
      if (items.some((item) => item.type === 'user_message' && item.text === prompt)) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`Subagent ${childThreadId} did not persist delegated input`);
  }

  private async ensureChildThread(parentThreadId: ThreadId, childThreadId: ThreadId): Promise<ThreadMeta> {
    const child = await this.config.store.getThread(childThreadId);
    if (!child) throw new Error(`Subagent ${childThreadId} not found`);
    const edges = await this.config.store.listThreadSpawnDescendants(parentThreadId);
    if (!edges.some((edge) => edge.childThreadId === childThreadId)) {
      throw new Error(`Subagent ${childThreadId} does not belong to thread ${parentThreadId}`);
    }
    return child;
  }

  private async appendAgentMailboxMessage(
    child: ThreadMeta,
    message: {
      senderThreadId: ThreadId;
      receiverThreadId: ThreadId;
      content: string;
      triggerTurn: boolean;
      createdAt: string;
    },
  ): Promise<void> {
    const mailbox = parseAgentMailbox(child.tags.agentMailbox);
    mailbox.push(message);
    await this.config.store.updateThreadMetadata(child.threadId, {
      tags: { ...child.tags, agentMailbox: JSON.stringify(mailbox) },
    });
  }

  private async subagentDepth(threadId: ThreadId): Promise<number> {
    let depth = 0;
    let current = await this.config.store.getThread(threadId);
    const seen = new Set<ThreadId>();
    while (current?.parentThreadId && !seen.has(current.threadId)) {
      seen.add(current.threadId);
      depth += 1;
      current = await this.config.store.getThread(current.parentThreadId);
    }
    return depth;
  }

  private buildTransferEnvelope({
    agentNickname,
    agentRole,
    childThreadId,
    parentThreadId,
    prompt,
  }: {
    agentNickname: string;
    agentRole: string;
    childThreadId: ThreadId;
    parentThreadId: ThreadId;
    prompt: string;
  }): AgentTransferEnvelope {
    return {
      schemaVersion: 1,
      senderThreadId: parentThreadId,
      receiverThreadId: childThreadId,
      role: agentRole,
      nickname: agentNickname,
      task: prompt,
      locale: this.config.locale,
      webSearchMode: this.config.webSearchMode,
      permissions: {
        level: this.effectiveLevel,
        networkAllowed: this.effectiveNetwork,
        presetId: this.preset?.id,
      },
      constraints: [
        {
          layer: 'project_agents_md',
          text: 'Follow the active AGENTS.md/project rules inherited from the parent thread.',
        },
        {
          layer: 'thread_config',
          text: `Use inherited model, workspace, locale, web_search mode, Skills, MCP, and permission preset.`,
        },
        {
          layer: 'parent_delegation',
          text: prompt,
        },
        {
          layer: 'skills_mcp_web_search',
          text: `web_search=${this.config.webSearchMode}; active skills and MCP servers are inherited from parent config.`,
        },
        {
          layer: 'subagent_role',
          text: `Role=${agentRole}; nickname=${agentNickname}.`,
        },
      ],
      contextRefs: [],
      artifacts: [],
      summary: prompt,
      limits: {
        maxSubagents: this.config.maxSubagents,
        largePayloadPolicy: 'artifact_refs',
      },
    };
  }

  private createChildAgent(
    agentRole: string | null | undefined,
    agentNickname: string | null | undefined,
    envelope?: AgentTransferEnvelope,
    _overrides?: {
      model?: string;
      reasoningEffort?: string;
      serviceTier?: string;
      agentRole?: string;
    },
    roleProfile?: ResolvedAgentRoleProfile | null,
  ): AgentLoop {
    const activeRoleProfile = roleProfile ?? this.tryResolveAgentRoleProfile(agentRole);
    const roleLine = this.config.locale === 'zh'
      ? `你是父线程派生的子 agent。角色：${agentRole ?? 'subagent'}。名称：${agentNickname ?? 'subagent'}。独立完成分配任务，最后给出简洁结论。`
      : `You are a spawned subagent. Role: ${agentRole ?? 'subagent'}. Nickname: ${agentNickname ?? 'subagent'}. Complete the delegated task independently and end with a concise result.`;
    const roleProfilePrompt = buildRoleProfilePrompt(activeRoleProfile);
    const envelopeLine = envelope
      ? `\n\n## Agent Transfer Envelope\n${JSON.stringify(envelope, null, 2)}`
      : '';
    const roleProfileLine = roleProfilePrompt ? `\n\n${roleProfilePrompt}` : '';
    const child = new AgentLoop(
      {
        workspaceRoot: this.config.workspaceRoot,
        sandbox: this.config.sandbox,
        model: this.config.model,
        store: this.config.store,
        tenantId: this.config.tenantId,
        tools: this.tools,
        approvalHandler: this.config.approvalHandler,
        maxIterations: this.config.maxIterations,
        maxActiveTasks: this.config.maxActiveTasks,
        systemPrompt: `${this.config.systemPrompt}\n\n${roleLine}${roleProfileLine}${envelopeLine}`,
        skills: scopedSkillsForRole(this.config.skills, activeRoleProfile),
        hooks: this.config.hooks,
        locale: this.config.locale,
        webSearchMode: this.config.webSearchMode,
          accessPolicy: this.runtimeAccessPolicy,
        maxSubagents: activeRoleProfile?.maxSubagents ?? this.config.maxSubagents,
        maxSubagentDepth: activeRoleProfile?.maxSubagentDepth ?? this.config.maxSubagentDepth,
        spawnModelFactory: this.config.spawnModelFactory,
        agentRoles: this.config.agentRoles,
        activeAgentRoleProfile: activeRoleProfile,
        runtimeMiddleware: this.config.runtimeMiddleware,
        dynamicContextProvider: this.config.dynamicContextProvider,
        maxRepeatedToolCalls: this.config.maxRepeatedToolCalls,
        maxConsecutiveToolErrors: this.config.maxConsecutiveToolErrors,
        toolBindingMode: this.config.toolBindingMode,
        initialTools: this.config.initialTools,
        maxToolSearchResults: this.config.maxToolSearchResults,
        maxParallelReadonlyTools: this.config.maxParallelReadonlyTools,
        toolGovernance: this.config.toolGovernance,
        guardian: this.config.guardian,
        memory: this.config.memory,
        // 中文注释：子 agent 不自建采样器，通过 attachSystemMonitor 共享父 agent 的实例
        // — Chinese: child doesn't start its own sampler; shares parent's via attachSystemMonitor
        systemMonitor: { enabled: false },
      },
      this.stateManager,
    );
    // 中文注释：共享父 agent 的 SystemMonitor 实例，让子 agent 的工具调用也受同样的限流
    // — Chinese: share parent's SystemMonitor so child's tool calls follow the same throttle
    child.attachSystemMonitor(this._systemMonitor);
    return child;
  }

  private tryResolveAgentRoleProfile(roleName: string | null | undefined): ResolvedAgentRoleProfile | null {
    try {
      return resolveAgentRoleProfile(this.config.agentRoles, roleName ?? DEFAULT_AGENT_ROLE_NAME);
    } catch {
      return null;
    }
  }

  // ─── Message Building ─────────────────────────────────────────────────────
  private async buildMessages(
    threadId: ThreadId,
    userInput: UserInput,
    thread: ThreadMeta,
    webSearchRecommended = false,
    includeCurrentUserInput = true,
  ): Promise<ChatMessage[]> {
    const messages: ChatMessage[] = [];

    // System prompt
    // 系统提示
    const systemPrompt = await this.buildSystemPrompt(thread, userInput);
    messages.push({ role: 'system', content: systemPrompt });
    const turnInstruction = this.buildTurnInstructionPrompt(userInput, webSearchRecommended);

    // Recent history
    // 最近历史
    const recentItems = await this.config.store.getRecentItems(threadId, 50);
    const compactedTurnIds = new Set(parseCompactedRanges(thread.tags?.compactedRanges)
      .flatMap((range) => range.compactedTurnIds));
    const effectiveItems = recentItems.filter((item) => {
      return !(item.turnId && compactedTurnIds.has(item.turnId) && item.type !== 'context_compaction');
    });
    messages.push(...threadItemsToModelMessages(effectiveItems));

    // Current user input - support multimodal (text + images)
    // 当前用户输入 — 支持多模态（文本 + 图像）
    if (!includeCurrentUserInput) {
      return fitMessagesToBudget(messages, MODEL_HISTORY_TOKEN_BUDGET);
    }
    if (userInput.type === 'multimodal') {
      const contentParts: Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }> = [];
      for (const part of userInput.parts) {
        if (part.type === 'text') {
          contentParts.push({ type: 'text', text: part.text });
        } else if (part.type === 'image_url') {
          contentParts.push({ type: 'image_url', image_url: { url: part.image_url.url } });
        } else if (part.type === 'image_path') {
          const dataUrl = await imagePathToDataUrl(part.path, part.mimeType);
          if (dataUrl) contentParts.push({ type: 'image_url', image_url: { url: dataUrl } });
        }
      }
      if (turnInstruction) {
        contentParts.push({ type: 'text', text: turnInstruction });
      }
      messages.push({ role: 'user', content: contentParts });
    } else {
      messages.push({ role: 'user', content: appendTurnInstruction(userInput.text, turnInstruction) });
    }

    return fitMessagesToBudget(messages, MODEL_HISTORY_TOKEN_BUDGET);
  }

  private shouldOfferWebSearchTool(): boolean {
    return this.config.webSearchMode !== 'off';
  }

  private buildTurnInstructionPrompt(userInput: UserInput, webSearchRecommended: boolean): string {
    const sections: string[] = [];
    const activeSkillsPrompt = this.buildActiveSkillsPrompt(userInput);
    if (activeSkillsPrompt) sections.push(activeSkillsPrompt);
    const modeInstruction = userInputModeInstruction(userInput);
    if (modeInstruction) {
      sections.push(`One-time instruction for this turn only:\n${modeInstruction}`);
    }
    if (webSearchRecommended) {
      sections.push([
        'Web access is recommended for this turn.',
        'Use the Codex-style web_search tool actions: search, open_page, and find_in_page.',
        'If the user provides a URL, call web_search with action="open_page" and url first.',
        'Use action="search" only to discover likely URLs, then stop searching and use action="open_page" on the most relevant page.',
        'Avoid repeated searches for the same task; summarize from fetched pages and search results.',
        'Avoid web tools for local repository work.',
      ].join(' '));
    }
    if (sections.length === 0) return '';
    return `<turn_instructions>\n${sections.join('\n\n')}\n</turn_instructions>`;
  }

  private async buildSystemPrompt(thread: ThreadMeta, userInput?: UserInput): Promise<string> {
    let prompt = this.config.systemPrompt;

    // Inject AGENTS.md
    // 注入 AGENTS.md
    const agentsMd = await loadAgentsMd(this.config.workspaceRoot);
    if (agentsMd) {
      prompt += `\n\n## Project Rules (AGENTS.md)\n${agentsMd}`;
    }

    // Inject skills
    // 注入技能
    const skillsText = this.config.skills.toPromptText();
    if (skillsText) {
      prompt += `\n\n${skillsText}`;
    }

    if (userInput) {
      const memoryContext = await this.buildMemoryContext(thread, userInput);
      if (memoryContext) {
        prompt += `\n\n${memoryContext}`;
      }
    }

    const lightMemoryContext = await this.buildLightMemoryContext(thread);
    if (lightMemoryContext) {
      prompt += `\n\n${lightMemoryContext}`;
    }

    // Inject episode working set (after cold memory, before compacted summary).
    const workingSet = this.threadWorkingSets.get(thread.threadId);
    if (workingSet?.frozenPromptBlock) {
      prompt += `\n\n${workingSet.frozenPromptBlock}`;
    }

    // Inject compacted summary
    // 注入压缩摘要
    if (thread.status === 'compacted' && thread.tags?.compactedSummary) {
      prompt += `\n\n## Previous Conversation Summary\n${thread.tags.compactedSummary}`;
    }

    return prompt;
  }

  private async buildMemoryContext(thread: ThreadMeta, userInput: UserInput): Promise<string> {
    const settings = this.config.memory;
    if (!settings.memoryEnabled || !settings.useColdMemories) return '';
    if (thread.tags?.memoryExcluded === 'true') return '';
    if (!this.config.store.listMemoryRecords && !this.config.store.searchMemoryRecords) return '';

    const query = userInputToText(userInput);
    const results = await searchColdMemories(this.config.store, query, {
      workspaceRoot: thread.workspaceRoot ?? this.config.workspaceRoot,
      limit: settings.memoryInjectLimit,
      tokenBudget: settings.memoryTokenBudget,
    });
    if (results.length === 0) return '';

    const usedAt = new Date().toISOString();
    for (const result of results) {
      try {
        await this.config.store.recordMemoryUsage?.(result.record.id, usedAt);
      } catch (err) {
        await this.appendRunMonitorEvent('memory-context', {
          category: 'memory',
          type: 'memory.usage_record_failed',
          level: 'warning',
          message: err instanceof Error ? err.message : String(err),
          metadata: { memoryId: result.record.id },
        });
      }
    }

    const lines = results.map((result) => {
      const record = result.record;
      const sourceThreadId = record.sourceThreadId ?? 'unknown';
      const score = result.score.toFixed(2);
      return `- [memory:${record.id} ${record.type} score=${score} sourceThreadId=${sourceThreadId}] ${record.text}`;
    });
    return [
      '## Cold Memories',
      'Persistent memories retrieved for this turn. Use them only when relevant; each entry is source-marked for audit.',
      ...lines,
    ].join('\n');
  }

  private async buildLightMemoryContext(thread: ThreadMeta): Promise<string> {
    const settings = this.config.memory;
    if (!settings.memoryEnabled) return '';
    if (thread.tags?.memoryExcluded === 'true') return '';

    try {
      const memories = await listLightMemories(this.config.store);
      if (memories.length === 0) return '';
      const limit = Math.max(1, Math.min(settings.memoryInjectLimit, 20));
      const selected = memories
        .slice()
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .slice(0, limit);
      const lines = selected.map((entry) => {
        const sourceThreadId = entry.sourceThreadId ?? 'unknown';
        return `- [light:${entry.id} sourceThreadId=${sourceThreadId}] ${entry.text}`;
      });
      return [
        '## Light Memories',
        'Recent lightweight user notes. Use them only when relevant to the current turn.',
        ...lines,
      ].join('\n');
    } catch (err) {
      await this.appendRunMonitorEvent('memory-context', {
        category: 'memory',
        type: 'memory.light_context_failed',
        level: 'warning',
        message: err instanceof Error ? err.message : String(err),
      });
      return '';
    }
  }

  private async maybeExtractColdMemories(
    thread: ThreadMeta,
    turnId: TurnId,
    userInput: UserInput,
    collectedItems: ThreadItem[],
  ): Promise<void> {
    const settings = this.config.memory;
    if (!settings.memoryEnabled || !settings.autoExtractMemories) return;
    if (thread.ephemeral || thread.parentThreadId || thread.tags?.memoryExcluded === 'true') return;
    if (!this.config.store.upsertMemoryRecord || !this.config.store.listMemoryRecords) return;

    try {
      const assistantText = collectedItems
        .filter((item): item is Extract<ThreadItem, { type: 'agent_message' }> => item.turnId === turnId && item.type === 'agent_message')
        .map((item) => item.text)
        .join('\n\n');
      const candidates = extractMemoryCandidates({
        threadId: thread.threadId,
        turnId,
        workspaceRoot: thread.workspaceRoot ?? this.config.workspaceRoot,
        userText: userInputToText(userInput),
        assistantText,
        now: new Date(),
      });
      for (const candidate of candidates) {
        await mergeMemoryCandidate(this.config.store, candidate, new Date());
      }
    } catch (err) {
      await this.appendRunMonitorEvent(turnId, {
        category: 'memory',
        type: 'memory.extract_failed',
        level: 'warning',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ─── Episode Memory Helpers ─────────────────────────────────────────────────
  private storeSupportsEpisodes(): boolean {
    return Boolean(
      this.config.store.upsertEpisodeRecord &&
      this.config.store.listEpisodeRecords &&
      this.config.store.saveThreadWorkingSet &&
      this.config.store.getThreadWorkingSet,
    );
  }

  private async loadEpisodeMemorySettings(): Promise<EpisodeMemorySettings> {
    if (!this.storeSupportsEpisodes()) return normalizeEpisodeMemorySettings(undefined);
    try {
      return await getEpisodeMemorySettings(this.config.store);
    } catch {
      // 无 turn 上下文时静默回退；有上下文的地方会额外上报 warning
      return normalizeEpisodeMemorySettings(undefined);
    }
  }

  private resolveEpisodeMemoryMode(thread: ThreadMeta): EpisodeMemoryMode {
    const mode = thread.tags?.episodeMemoryMode;
    if (mode === 'disabled' || mode === 'polluted') return mode;
    return 'enabled';
  }

  private async prepareEpisodeWorkingSet(
    thread: ThreadMeta,
    turnId: TurnId,
    turnIndex: number,
    userInput: UserInput,
  ): Promise<void> {
    if (!this.storeSupportsEpisodes()) return;

    const mode = this.resolveEpisodeMemoryMode(thread);
    if (mode === 'disabled') {
      this.threadWorkingSets.delete(thread.threadId);
      this.threadOpenEpisodes.delete(thread.threadId);
      await this.appendRunMonitorEvent(turnId, {
        category: 'memory',
        type: 'episode.mode.disabled',
        message: 'Episode memory is disabled for this thread',
      });
      return;
    }

    if (mode === 'polluted') {
      this.threadWorkingSets.delete(thread.threadId);
      this.threadOpenEpisodes.delete(thread.threadId);
      await this.appendRunMonitorEvent(turnId, {
        category: 'memory',
        type: 'episode.mode.polluted',
        message: 'Episode memory is polluted for this thread; skipping automatic injection',
      });
      return;
    }

    let settings: EpisodeMemorySettings;
    try {
      settings = await this.loadEpisodeMemorySettings();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.appendRunMonitorEvent(turnId, {
        category: 'memory',
        type: 'episode.settings_load_failed',
        level: 'warning',
        message: `Failed to load episode memory settings: ${message}`,
      });
      return;
    }

    if (!settings.episodeMemoryEnabled) return;

    try {
      const previousOpenEpisode = this.threadOpenEpisodes.get(thread.threadId) ?? null;
      const openEpisode = await getOpenEpisodeForThread(this.config.store, thread.threadId);
      if (openEpisode) {
        this.threadOpenEpisodes.set(thread.threadId, openEpisode);
      }

      const hadSnapshot = await getThreadWorkingSetSnapshot(this.config.store, thread.threadId);
      if (hadSnapshot) {
        this.threadWorkingSets.set(thread.threadId, hadSnapshot);
      }

      const activeGoal = thread.tags?.activeGoal;
      const selectedArtifacts = thread.tags?.selectedArtifacts
        ? thread.tags.selectedArtifacts.split(',').map((s) => s.trim()).filter(Boolean)
        : undefined;

      const result = await buildOrReuseWorkingSet(
        this.config.store,
        thread,
        userInput,
        turnId,
        turnIndex,
        openEpisode,
        settings,
        activeGoal,
        selectedArtifacts,
      );

      this.threadWorkingSets.set(thread.threadId, result.snapshot);
      if (result.openEpisode) {
        this.threadOpenEpisodes.set(thread.threadId, result.openEpisode);
      }

      if (result.rebuilt) {
        try {
          await saveThreadWorkingSetSnapshot(this.config.store, result.snapshot);
          if (result.openEpisode && result.openEpisode.id !== previousOpenEpisode?.id) {
            await saveEpisodeRecord(this.config.store, result.openEpisode);
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          await this.appendRunMonitorEvent(turnId, {
            category: 'memory',
            type: 'episode.working_set_save_failed',
            level: 'warning',
            message: `Failed to save rebuilt working set: ${message}`,
          });
        }

        this.emit({
          type: 'episode.working_set_rebuilt',
          threadId: thread.threadId,
          turnId,
          generation: result.snapshot.generation,
          activeEpisodeIds: result.snapshot.activeEpisodeIds,
          frozenPromptBlock: result.snapshot.frozenPromptBlock,
        });
        await this.appendRunMonitorEvent(turnId, {
          category: 'memory',
          type: 'episode.working_set_rebuilt',
          message: 'Episode working set rebuilt',
          metadata: {
            generation: result.snapshot.generation,
            activeEpisodeIds: result.snapshot.activeEpisodeIds,
            injectedEpisodeIds: result.snapshot.injectedEpisodeIds,
            taskFingerprint: result.snapshot.taskFingerprint,
          },
        });
      } else if (hadSnapshot) {
        await this.appendRunMonitorEvent(turnId, {
          category: 'memory',
          type: 'episode.working_set_restored',
          message: 'Episode working set restored from persisted snapshot',
          metadata: {
            generation: result.snapshot.generation,
            activeEpisodeIds: result.snapshot.activeEpisodeIds,
            taskFingerprint: result.snapshot.taskFingerprint,
          },
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.appendRunMonitorEvent(turnId, {
        category: 'memory',
        type: 'episode.working_set_failed',
        level: 'warning',
        message: `Episode working set preparation failed: ${message}`,
      });
    }
  }

  private async updateEpisodeFromCompletedTurn(
    thread: ThreadMeta,
    turnId: TurnId,
    turnIndex: number,
    userInput: UserInput,
    collectedItems: ThreadItem[],
  ): Promise<void> {
    if (!this.storeSupportsEpisodes()) return;

    const mode = this.resolveEpisodeMemoryMode(thread);
    if (mode !== 'enabled') return;

    const openEpisode = this.threadOpenEpisodes.get(thread.threadId);
    if (!openEpisode || openEpisode.lifecycle !== 'open') return;

    let settings: EpisodeMemorySettings;
    try {
      settings = await this.loadEpisodeMemorySettings();
    } catch {
      return;
    }
    if (!settings.episodeMemoryEnabled) return;

    const userText = userInputToText(userInput);
    const assistantText = collectedItems
      .filter((item): item is Extract<ThreadItem, { type: 'agent_message' }> =>
        item.turnId === turnId && item.type === 'agent_message',
      )
      .map((item) => item.text)
      .join('\n\n');
    const episodeItems = collectedItems
      .filter((item) => item.turnId === turnId)
      .map((item) => ({
        type: item.type,
        text: (item as Partial<ThreadItem> & { text?: string }).text,
        path: (item as Partial<ThreadItem> & { path?: string }).path,
        items: (item as Partial<ThreadItem> & { items?: Array<{ text: string; completed: boolean }> }).items,
      }));

    try {
      const updated = updateEpisodeFromTurn(
        openEpisode,
        turnId,
        turnIndex,
        userText,
        assistantText,
        episodeItems,
      );
      await saveEpisodeRecord(this.config.store, updated);
      this.threadOpenEpisodes.set(thread.threadId, updated);
      await this.appendRunMonitorEvent(turnId, {
        category: 'memory',
        type: 'episode.updated',
        message: 'Open episode updated from completed turn',
        metadata: { episodeId: updated.id, sourceTurnEndIndex: updated.sourceTurnEndIndex },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.appendRunMonitorEvent(turnId, {
        category: 'memory',
        type: 'episode.update_failed',
        level: 'warning',
        message: `Failed to update open episode: ${message}`,
      });
    }
  }

  private async sealOpenEpisodeForCompaction(threadId: ThreadId, turnId: TurnId): Promise<void> {
    if (!this.storeSupportsEpisodes()) return;

    const thread = await this.config.store.getThread(threadId);
    if (!thread || this.resolveEpisodeMemoryMode(thread) !== 'enabled') return;

    let settings: EpisodeMemorySettings;
    try {
      settings = await this.loadEpisodeMemorySettings();
    } catch {
      return;
    }
    if (!settings.episodeMemoryEnabled) return;

    const openEpisode = this.threadOpenEpisodes.get(threadId);
    if (!openEpisode || openEpisode.lifecycle !== 'open') return;

    try {
      const sealed = sealEpisode(openEpisode, 'pre_compact');
      await saveEpisodeRecord(this.config.store, sealed);
      this.threadOpenEpisodes.set(threadId, sealed);
      await this.appendRunMonitorEvent(turnId, {
        category: 'memory',
        type: 'episode.sealed',
        message: 'Open episode sealed before context compaction',
        metadata: { episodeId: sealed.id, reason: 'pre_compact' },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.appendRunMonitorEvent(turnId, {
        category: 'memory',
        type: 'episode.seal_failed',
        level: 'warning',
        message: `Failed to seal open episode before compaction: ${message}`,
      });
    }
  }

  private async invalidateEpisodesForRollback(
    threadId: ThreadId,
    newTurnCount: number,
    turnId: TurnId,
  ): Promise<void> {
    if (!this.storeSupportsEpisodes()) return;

    try {
      const { rolledBack, stale } = await invalidateEpisodesByTurnRange(
        this.config.store,
        threadId,
        newTurnCount,
      );
      if (rolledBack.length > 0 || stale.length > 0) {
        await this.appendRunMonitorEvent(turnId, {
          category: 'memory',
          type: 'episode.invalidated',
          message: `Invalidated episodes after rollback (rolledBack=${rolledBack.length}, stale=${stale.length})`,
          metadata: { rolledBack, stale, newTurnCount },
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.appendRunMonitorEvent(turnId, {
        category: 'memory',
        type: 'episode.invalidate_failed',
        level: 'warning',
        message: `Failed to invalidate episodes after rollback: ${message}`,
      });
    }

    try {
      if (this.config.store.deleteThreadWorkingSet) {
        await this.config.store.deleteThreadWorkingSet(threadId);
      }
      this.threadWorkingSets.delete(threadId);
      this.threadOpenEpisodes.delete(threadId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.appendRunMonitorEvent(turnId, {
        category: 'memory',
        type: 'episode.working_set_delete_failed',
        level: 'warning',
        message: `Failed to delete thread working set after rollback: ${message}`,
      });
    }
  }

  private async maybeEmitWorkingSetRestored(threadId: ThreadId, turnId: TurnId): Promise<void> {
    if (!this.storeSupportsEpisodes()) return;
    try {
      const thread = await this.config.store.getThread(threadId);
      const mode = thread ? this.resolveEpisodeMemoryMode(thread) : 'enabled';
      if (mode !== 'enabled') {
        this.threadWorkingSets.delete(threadId);
        this.threadOpenEpisodes.delete(threadId);
        return;
      }

      const openEpisode = await getOpenEpisodeForThread(this.config.store, threadId);
      if (openEpisode) {
        this.threadOpenEpisodes.set(threadId, openEpisode);
      }
      const snapshot = this.config.store.getThreadWorkingSet
        ? await this.config.store.getThreadWorkingSet(threadId)
        : null;
      if (snapshot) {
        this.threadWorkingSets.set(threadId, snapshot);
        await this.appendRunMonitorEvent(turnId, {
          category: 'memory',
          type: 'episode.working_set_restored',
          message: 'Episode working set restored from persisted snapshot',
          metadata: {
            generation: snapshot.generation,
            activeEpisodeIds: snapshot.activeEpisodeIds,
            taskFingerprint: snapshot.taskFingerprint,
            episodeIdentity: snapshot.episodeIdentity,
          },
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.appendRunMonitorEvent(turnId, {
        category: 'memory',
        type: 'episode.working_set_restore_failed',
        level: 'warning',
        message: `Failed to restore episode working set: ${message}`,
      });
    }
  }

  private async emitCompactionPressure(
    threadId: ThreadId,
    turnId: TurnId,
    visibleMessages?: ChatMessage[],
  ): Promise<{
    pressure: {
      estimatedTokens: number;
      maxTokens: number;
      softThreshold: number;
      hardThreshold: number;
      ratio: number;
      status: 'ok' | 'soft' | 'hard';
    };
    compactionOptions: ReturnType<typeof compactionOptionsForModelContext>;
    autoCompactWindow: ThreadState['autoCompactWindow'];
  }> {
    const recentItems = await this.config.store.getRecentItems(threadId, 200);
    const thread = await this.config.store.getThread(threadId);
    const effectiveRecentItems = filterEffectiveCompactionItems(recentItems, thread?.tags?.compactedRanges);
    const compactionOptions = compactionOptionsForModelContext(this.config.modelContextTokens);
    const rolloutPressure = getCompactionPressure(effectiveRecentItems, compactionOptions);
    const visibleInputTokens = visibleMessages ? estimateRuntimeChatTokens(visibleMessages).inputTokens : 0;
    const estimatedTokens = Math.max(rolloutPressure.estimatedTokens, visibleInputTokens);
    const ratio = rolloutPressure.maxTokens > 0 ? estimatedTokens / rolloutPressure.maxTokens : 1;
    const pressure = {
      ...rolloutPressure,
      estimatedTokens,
      ratio,
      status: estimatedTokens >= rolloutPressure.hardThreshold
        ? 'hard' as const
        : estimatedTokens >= rolloutPressure.softThreshold
          ? 'soft' as const
          : 'ok' as const,
    };
    const autoCompactWindow = { ...this.stateManager.get(threadId).autoCompactWindow };
    this.emit({ type: 'context.compaction_pressure', threadId, turnId, pressure: { ...pressure, window: autoCompactWindow } });
    return { pressure, compactionOptions, autoCompactWindow };
  }

  private async maybeAutoCompact(
    threadId: ThreadId,
    turnId: TurnId,
    phaseContext: 'pre_turn' | 'mid_turn' = 'pre_turn',
    visibleMessages?: ChatMessage[],
  ): Promise<boolean> {
    const { pressure, compactionOptions, autoCompactWindow } = await this.emitCompactionPressure(threadId, turnId, visibleMessages);
    const pressureWithWindow = { ...pressure, window: autoCompactWindow };
    if (pressure.status !== 'hard') return false;
    const compactionItemId = `compact_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    this.emit({
      type: 'thread.compacted.v2',
      threadId,
      turnId,
      phase: 'started',
      trigger: 'auto',
      strategy: compactionOptions.strategy,
      tokensBefore: Math.ceil(pressure.estimatedTokens),
      item: { id: compactionItemId },
    });
    await this.appendRunMonitorEvent(turnId, {
      category: 'compaction',
      type: 'compaction.started',
      message: 'Automatic context compaction started',
      metadata: { trigger: 'auto', phase: phaseContext, strategy: compactionOptions.strategy, pressure: pressureWithWindow },
    });
    // 发 task.runtime.updated phase=compact — 进入上下文压缩阶段
    this.emitTaskRuntimeUpdated(threadId, turnId, 'compact', 'running');
    try {
      await this.config.hooks.trigger('pre_compact', {
        threadId,
        turnId,
        workspaceRoot: this.config.workspaceRoot,
      });
      await this.sealOpenEpisodeForCompaction(threadId, turnId);
      const result = await compactThread(threadId, this.config.store, this.config.model, {
        trigger: 'auto',
        compactionTurnId: turnId,
        compactionItemId,
        force: phaseContext === 'mid_turn',
        tokensBeforeOverride: Math.ceil(pressure.estimatedTokens),
        ...compactionOptions,
      });
      let compacted = false;
      if (result.item) {
        this.emit({ type: 'item.started', threadId, turnId, item: result.item });
        this.emit({ type: 'item.completed', threadId, turnId, item: result.item });
        void this.appendItemRunMonitorEvent(threadId, turnId, result.item, 'item.started');
        void this.appendItemRunMonitorEvent(threadId, turnId, result.item, 'item.completed');
        this.emit({
          type: 'thread.compacted',
          threadId,
          compactedTurns: result.compactedTurns,
          tokensBefore: result.tokensBefore,
          tokensAfter: result.tokensAfter,
        });
        this.emit({
          type: 'thread.compacted.v2',
          threadId,
          turnId,
          phase: 'completed',
          trigger: 'auto',
          strategy: compactionOptions.strategy,
          compactedTurns: result.compactedTurns,
          tokensBefore: result.tokensBefore,
          tokensAfter: result.tokensAfter,
          item: result.item,
        });
        await this.appendRunMonitorEvent(turnId, {
          category: 'compaction',
          type: 'compaction.completed',
          message: 'Automatic context compaction completed',
          metadata: {
            trigger: 'auto',
            phase: phaseContext,
            strategy: compactionOptions.strategy,
            compactedTurns: result.compactedTurns,
            tokensBefore: result.tokensBefore,
            tokensAfter: result.tokensAfter,
            windowOrdinal: autoCompactWindow.ordinal,
          },
        });
        this.stateManager.startNextAutoCompactWindow(threadId);
        compacted = true;
      }
      await this.config.hooks.trigger('post_compact', {
        threadId,
        turnId,
        workspaceRoot: this.config.workspaceRoot,
      });
      return compacted;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const info = toSuanliziErrorInfo(error);
      this.emit({
        type: 'thread.compacted.v2',
        threadId,
        turnId,
        phase: 'failed',
        trigger: 'auto',
        strategy: compactionOptions.strategy,
        item: { id: compactionItemId },
        error: { message, info },
      });
      await this.appendRunMonitorEvent(turnId, {
        category: 'compaction',
        type: 'compaction.failed',
        level: 'error',
        message,
        metadata: { trigger: 'auto', phase: phaseContext, strategy: compactionOptions.strategy, info },
      });
      throw error;
    }
  }

  private buildActiveSkillsPrompt(userInput: UserInput): string {
    const text = userInputToText(userInput);
    const names = [...new Set([...text.matchAll(/\$([a-z0-9][a-z0-9_-]*)/gi)].map((match) => match[1]))];
    const skills = names
      .map((name) => this.config.skills.get(name))
      .filter((skill) => skill !== undefined);
    if (skills.length === 0) return '';
    return [
      '## Active Skill Instructions',
      ...skills.map((skill) => [
        `### ${skill.name}`,
        skill.description ? `Description: ${skill.description}` : '',
        skill.body,
      ].filter(Boolean).join('\n')),
    ].join('\n\n');
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────
  private async finishTurnLifecycle(
    runtimeContext: RuntimeTurnContext,
    result: RuntimeTurnResult,
  ): Promise<void> {
    let lifecycleError: unknown;
    try {
      await this.config.hooks.trigger('turn_end', {
        threadId: runtimeContext.threadId,
        turnId: runtimeContext.turnId,
        workspaceRoot: this.config.workspaceRoot,
      });
    } catch (err) {
      lifecycleError = err;
    } finally {
      try {
        await this.runtimeMiddleware.afterTurn(runtimeContext, result);
      } catch (err) {
        lifecycleError ??= err;
      }
    }
    if (lifecycleError) throw lifecycleError;
  }

  private async createRuntimeTurnContext(
    threadId: ThreadId,
    turnId: TurnId,
    thread: ThreadMeta,
    userInput: UserInput,
    checkpoint: Checkpoint,
    collectedItems: ThreadItem[],
  ): Promise<RuntimeTurnContext> {
    const runtimeState = await this.getRuntimeState(threadId);
    return {
      tenantId: this.config.tenantId,
      threadId,
      turnId,
      thread,
      userInput,
      workspaceRoot: this.config.workspaceRoot,
      locale: this.config.locale,
      webSearchMode: this.config.webSearchMode,
      runtimeState: {
        ...runtimeState,
        checkpoint,
      },
      checkpoint,
      collectedItems,
      store: this.config.store,
      stateManager: this.stateManager,
      emit: (event) => this.emit(event),
      audit: (event) => this.appendRunMonitorEvent(turnId, event),
      permissions: {
        level: this.effectiveLevel,
        networkAllowed: this.effectiveNetwork,
        presetId: this.preset?.id,
      },
      maxSubagents: this.config.maxSubagents,
      dynamicContextProvider: this.config.dynamicContextProvider,
    };
  }

  private withCheckpointState(
    threadId: ThreadId,
    turnId: TurnId,
    itemIndex: number,
    status: CheckpointStatus,
  ): Checkpoint {
    const state = this.stateManager.get(threadId);
    const timestamp = new Date().toISOString();
    const checkpoint: Checkpoint = {
      threadId,
      turnId,
      itemIndex,
      timestamp,
      generation: state.generation,
      status,
      executionStatus: status === 'waiting_user_input'
        ? 'waiting_user_input'
        : status === 'stopping'
          ? 'stopping'
          : ['completed', 'failed', 'interrupted', 'terminal', 'stale'].includes(status)
            ? 'terminal'
            : 'running',
    };
    if (status === 'running') {
      checkpoint.expiresAt = new Date(Date.now() + RUNNING_CHECKPOINT_TTL_MS).toISOString();
    }
    return checkpoint;
  }

  private refreshRunningCheckpoint(
    checkpoint: Checkpoint,
    threadId: ThreadId,
    turnId: TurnId,
    itemIndex: number,
  ): void {
    const next = this.withCheckpointState(threadId, turnId, itemIndex, 'running');
    checkpoint.itemIndex = next.itemIndex;
    checkpoint.timestamp = next.timestamp;
    checkpoint.generation = next.generation;
    checkpoint.status = next.status;
    checkpoint.expiresAt = next.expiresAt;
    checkpoint.executionStatus = next.executionStatus;
  }

  private async writeCheckpoint(threadId: ThreadId, checkpoint: Checkpoint): Promise<void> {
    this.stateManager.setCheckpoint(threadId, checkpoint);
    await this.config.store.appendCheckpoint(threadId, checkpoint);
  }

  private async recordUsage(threadId: ThreadId, turnId: TurnId, usage: Usage): Promise<void> {
    this.stateManager.recordAutoCompactWindowPrefill(threadId, usage.inputTokens);
    const thread = await this.config.store.getThread(threadId);
    const previous = parseThreadUsage(threadId, thread?.tags?.threadUsage);
    const turns = [
      ...previous.turns.filter((entry) => entry.turnId !== turnId),
      { turnId, usage, timestamp: new Date().toISOString() },
    ];
    const total = turns.reduce<Usage>((sum, entry) => ({
      inputTokens: sum.inputTokens + entry.usage.inputTokens,
      cachedInputTokens: sum.cachedInputTokens + entry.usage.cachedInputTokens,
      outputTokens: sum.outputTokens + entry.usage.outputTokens,
      reasoningOutputTokens: sum.reasoningOutputTokens + entry.usage.reasoningOutputTokens,
      cacheStrategy: combineCacheStrategy(sum.cacheStrategy, entry.usage.cacheStrategy),
      cacheReported: combineCacheReported(sum.cacheReported, entry.usage.cacheReported),
    }), emptyUsage());
    const next: ThreadUsage = {
      threadId,
      total,
      turns,
      updatedAt: new Date().toISOString(),
    };
    await this.config.store.updateThreadMetadata(threadId, {
      tags: { ...(thread?.tags ?? {}), threadUsage: JSON.stringify(next) },
    });
    this.emit({ type: 'thread.token_usage.updated', threadId, usage: next });
  }

  private emitItem(threadId: ThreadId, turnId: TurnId, item: ThreadItem): void {
    // 实施点 2：emit 前注入 harnessRunId 标记（保证事件与持久化一致）
    this.applyHarnessFields(threadId, item);
    // P6.3：注入 runId，使 timeline 严格按 run 过滤 — Chinese: inject runId for strict run-scoped timeline
    this.applyRunIdField(turnId, item);
    this.emit({ type: 'item.started', threadId, turnId, item });
    this.emit({ type: 'item.completed', threadId, turnId, item });
    void this.appendItemRunMonitorEvent(threadId, turnId, item, 'item.completed');
  }

  // 实施点 2：从 per-thread Map 取 harnessFields，注入到 item（仅 harness turn 产生时生效）
  // — English: read harness fields from per-thread map and inject onto item if present
  private applyHarnessFields(threadId: ThreadId, item: ThreadItem): void {
    const fields = this.harnessFieldsByThread.get(threadId);
    if (!fields) return;
    (item as ThreadItem & HarnessItemFields).harnessRunId = fields.harnessRunId;
    if (fields.harnessIteration !== undefined) {
      (item as ThreadItem & HarnessItemFields).harnessIteration = fields.harnessIteration;
    }
  }

  // P6.3：从 runMonitorSessions 取 turnId 对应的 runId 注入到 item，保证持久化 item 可被 store.getItems({ runId }) 严格过滤
  // — English: read runId from runMonitorSessions by turnId and inject onto item for strict run-scoped filtering
  private applyRunIdField(turnId: TurnId, item: ThreadItem): void {
    const session = this.runMonitorSessions.get(turnId);
    if (!session) return;
    (item as ThreadItem & { runId?: string }).runId = session.runId;
  }

  // 实施点 2：appendItems 包装，store 前注入 harnessRunId 标记，保证持久化 item 可被 EvidenceLedger.rebuildFromThreadItems 按 harnessRunId 过滤
  // — English: appendItems wrapper that tags items with harness fields before persistence
  private async persistItems(threadId: ThreadId, items: ThreadItem[]): Promise<void> {
    for (const item of items) {
      this.applyHarnessFields(threadId, item);
      // P6.3：持久化前注入 runId（从 item.turnId 查 runMonitorSessions）— Chinese: inject runId before persistence
      if (typeof item.turnId === 'string') {
        this.applyRunIdField(item.turnId, item);
      }
    }
    await this.config.store.appendItems(threadId, items);
  }
}

function emptyUsage(): Usage {
  return {
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
  };
}

function monitorTypeToTraceLifecycle(type: string): RunTraceObservation['lifecycle'] {
  const suffix = type.split('.').at(-1);
  if (suffix === 'started') return 'started';
  if (suffix === 'completed') return 'completed';
  if (suffix === 'failed') return 'failed';
  if (suffix === 'discarded') return 'discarded';
  return 'instant';
}

function monitorTypeToTurnStatus(type: string): 'running' | 'completed' | 'failed' | 'interrupted' | undefined {
  const suffix = type.split('.').at(-1);
  if (suffix === 'started') return 'running';
  if (suffix === 'completed') return 'completed';
  if (suffix === 'failed') return 'failed';
  if (suffix === 'interrupted') return 'interrupted';
  return undefined;
}

function monitorTypeToMiddlewareStage(type: string, level: RunEventLevel): 'before' | 'after' | 'error' {
  if (level === 'error' || type.includes('failed') || type.includes('error')) return 'error';
  if (type.toLowerCase().includes('after')) return 'after';
  return 'before';
}

function monitorTypeToAgentAction(
  type: string,
  lifecycle: RunTraceObservation['lifecycle'],
): 'spawn' | 'started' | 'joined' | 'failed' | 'interrupted' {
  if (type.includes('spawn')) return 'spawn';
  if (type.includes('join') || type.includes('completed')) return 'joined';
  if (type.includes('interrupt')) return 'interrupted';
  if (lifecycle === 'failed') return 'failed';
  return 'started';
}

function monitorTypeToControlAction(type: string): 'interrupt' | 'resume' | 'rollback' {
  if (type.includes('resume')) return 'resume';
  if (type.includes('rollback')) return 'rollback';
  return 'interrupt';
}

function traceApprovalDecision(value: unknown): 'allow' | 'prompt' | 'deny' | undefined {
  if (value === 'allow' || value === 'prompt' || value === 'deny') return value;
  if (value === 'approval_required') return 'prompt';
  return undefined;
}

function traceApprovalStatus(value: unknown): 'required' | 'granted' | 'denied' | undefined {
  const status = typeof value === 'string' ? value : '';
  if (status === 'required' || status === 'approval.required' || status === 'prompt') return 'required';
  if (status === 'granted' || status === 'access.temporary_grant' || status === 'approved') return 'granted';
  if (status === 'denied' || status === 'access.temporary_deny' || status === 'rejected') return 'denied';
  return undefined;
}

function monitorSpanSuffix(
  event: {
    type: string;
    metadata?: Record<string, unknown>;
  },
  turnId: TurnId,
): string {
  const metadata = event.metadata ?? {};
  return String(metadata.itemId ?? metadata.callId ?? `${turnId}:${event.type}`);
}

function numberMetadata(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function stringMetadata(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function traceFileAction(value: unknown): 'read' | 'write' | 'patch' | 'delete' | 'checkpoint' | 'extract' | 'stale' | 'refresh' | 'reuse' {
  const action = typeof value === 'string' ? value : '';
  if (['read', 'write', 'patch', 'delete', 'checkpoint', 'extract', 'stale', 'refresh', 'reuse'].includes(action)) {
    return action as ReturnType<typeof traceFileAction>;
  }
  return 'read';
}

function traceResourceKindMetadata(value: unknown): 'tool' | 'mcp' | 'skill' | 'shell' | 'agent' | undefined {
  if (value === 'tool' || value === 'mcp' || value === 'skill' || value === 'shell' || value === 'agent') {
    return value;
  }
  return undefined;
}

function resourceMetadataForToolCall(
  toolName: string,
  args: Record<string, unknown>,
  mcpIdentity: { serverId: string; toolName: string } | null,
): Record<string, unknown> {
  if (mcpIdentity) {
    return {
      resourceKind: 'mcp',
      server: mcpIdentity.serverId,
      tool: mcpIdentity.toolName,
    };
  }

  const skillName = skillNameFromToolArgs(args);
  if (skillName || /^(skill|skills)(?:_|$)/i.test(toolName)) {
    return {
      resourceKind: 'skill',
      skillName: skillName ?? toolName,
      tool: toolName,
    };
  }

  if (isCollabTool(toolName)) {
    return {
      resourceKind: 'agent',
      tool: toolName,
    };
  }

  if (toolName === 'shell_command' || toolName === 'exec_command' || toolName === 'command_execution') {
    return {
      resourceKind: 'shell',
      tool: toolName,
    };
  }

  return {
    resourceKind: 'tool',
    tool: toolName,
  };
}

function skillNameFromToolArgs(args: Record<string, unknown>): string | undefined {
  const direct = ['skillName', 'skill', 'name']
    .map((key) => args[key])
    .find((value): value is string => typeof value === 'string' && value.trim().length > 0);
  if (direct) return direct.trim();

  const installed = args.installed;
  if (Array.isArray(installed)) {
    const first = installed.find((value): value is string => typeof value === 'string' && value.trim().length > 0);
    return first?.trim();
  }

  return undefined;
}

function summarizeToolResultForMonitor(result: unknown): unknown {
  if (typeof result === 'string') {
    return result.length > 300 ? `${result.slice(0, 300)}…` : result;
  }
  if (result && typeof result === 'object') {
    return result;
  }
  return result;
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

function combineCacheStrategy(
  left: Usage['cacheStrategy'],
  right: Usage['cacheStrategy'],
): Usage['cacheStrategy'] {
  if (!left) return right;
  if (!right || left === right) return left;
  return 'mixed';
}

function combineCacheReported(
  left: Usage['cacheReported'],
  right: Usage['cacheReported'],
): Usage['cacheReported'] {
  if (left === false || right === false) return false;
  if (left === true && right === true) return true;
  return undefined;
}

function parseThreadUsage(threadId: ThreadId, raw: string | undefined): ThreadUsage {
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as ThreadUsage;
      if (parsed && Array.isArray(parsed.turns) && parsed.total) return parsed;
    } catch {
      // ignore malformed persisted usage
      // 忽略格式不正确的持久化用量
    }
  }
  return {
    threadId,
    total: emptyUsage(),
    turns: [],
    updatedAt: new Date().toISOString(),
  };
}

function parseAgentMailbox(raw: string | undefined): Array<{
  senderThreadId: ThreadId;
  receiverThreadId: ThreadId;
  content: string;
  triggerTurn: boolean;
  createdAt: string;
}> {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((entry) => {
      if (!entry || typeof entry !== 'object') return [];
      const candidate = entry as Record<string, unknown>;
      if (
        typeof candidate.senderThreadId !== 'string' ||
        typeof candidate.receiverThreadId !== 'string' ||
        typeof candidate.content !== 'string'
      ) {
        return [];
      }
      return [{
        senderThreadId: candidate.senderThreadId,
        receiverThreadId: candidate.receiverThreadId,
        content: candidate.content,
        triggerTurn: candidate.triggerTurn === true,
        createdAt: typeof candidate.createdAt === 'string' ? candidate.createdAt : new Date().toISOString(),
      }];
    });
  } catch {
    return [];
  }
}

function parseCompactedRanges(raw: string | undefined): CompactedRange[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed as CompactedRange[] : [];
  } catch {
    return [];
  }
}

function filterEffectiveCompactionItems(items: ThreadItem[], compactedRangesRaw: string | undefined): ThreadItem[] {
  const compactedTurnIds = new Set(parseCompactedRanges(compactedRangesRaw)
    .flatMap((range) => range.compactedTurnIds));
  if (compactedTurnIds.size === 0) return items;
  return items.filter((item) => (
    !item.turnId
    || !compactedTurnIds.has(item.turnId)
    || item.type === 'context_compaction'
  ));
}

function normalizeFileChanges(data: unknown): Array<{
  path: string;
  kind: 'add' | 'delete' | 'update';
  hunks?: Array<{
    path: string;
    startLine?: number;
    endLine?: number;
    addedLines: number;
    removedLines: number;
    addedLinesContent: string[];
    removedLinesContent: string[];
    summary?: string;
  }>;
  addedLines?: number;
  removedLines?: number;
  summary?: string;
}> {
  const record = data && typeof data === 'object' ? data as { changes?: unknown } : {};
  if (!Array.isArray(record.changes)) return [];
  return record.changes.flatMap((change) => {
    if (!change || typeof change !== 'object') return [];
    const candidate = change as Record<string, unknown>;
    const kind = candidate.kind;
    const filePath = candidate.path;
    if ((kind !== 'add' && kind !== 'delete' && kind !== 'update') || typeof filePath !== 'string') {
      return [];
    }
    const hunks = Array.isArray(candidate.hunks)
      ? candidate.hunks.flatMap((hunk) => {
          if (!hunk || typeof hunk !== 'object') return [];
          const typed = hunk as Record<string, unknown>;
          // 中文注释：缺失的行内容字段解析为空数组
          const addedLinesContent = Array.isArray(typed.addedLinesContent)
            ? typed.addedLinesContent.filter((line): line is string => typeof line === 'string')
            : [];
          const removedLinesContent = Array.isArray(typed.removedLinesContent)
            ? typed.removedLinesContent.filter((line): line is string => typeof line === 'string')
            : [];
          return [{
            path: typeof typed.path === 'string' ? typed.path : filePath,
            startLine: typeof typed.startLine === 'number' ? typed.startLine : undefined,
            endLine: typeof typed.endLine === 'number' ? typed.endLine : undefined,
            addedLines: typeof typed.addedLines === 'number' ? typed.addedLines : 0,
            removedLines: typeof typed.removedLines === 'number' ? typed.removedLines : 0,
            addedLinesContent,
            removedLinesContent,
            summary: typeof typed.summary === 'string' ? typed.summary : undefined,
          }];
        })
      : undefined;
    return [{
      path: filePath,
      kind,
      hunks,
      addedLines: typeof candidate.addedLines === 'number' ? candidate.addedLines : undefined,
      removedLines: typeof candidate.removedLines === 'number' ? candidate.removedLines : undefined,
      summary: typeof candidate.summary === 'string' ? candidate.summary : undefined,
    }];
  });
}

type NormalizedFileChange = ReturnType<typeof normalizeFileChanges>[number];

async function activeTurnCount(store: ThreadStore, threadId: ThreadId): Promise<number> {
  const thread = await store.getThread(threadId);
  return thread?.turnCount ?? (await store.getTurns(threadId)).length;
}

async function capturePrePatchSnapshots(args: Record<string, unknown>, workspaceRoot: string): Promise<Map<string, string | null>> {
  const patchText = typeof args.patch === 'string' ? args.patch : '';
  const paths = extractPatchPaths(patchText);
  const snapshots = new Map<string, string | null>();
  for (const filePath of paths) {
    snapshots.set(filePath, await readWorkspaceTextFile(workspaceRoot, filePath));
  }
  return snapshots;
}

// 中文注释：write_file 在写入前捕获目标文件的当前内容，用于后续回滚。
async function captureWriteFilePathSnapshot(args: Record<string, unknown>, workspaceRoot: string): Promise<Map<string, string | null>> {
  const filePath = typeof args.filePath === 'string' ? args.filePath.trim() : '';
  const snapshots = new Map<string, string | null>();
  if (!filePath) return snapshots;
  snapshots.set(filePath, await readWorkspaceTextFile(workspaceRoot, filePath));
  return snapshots;
}

// 中文注释：write_file 整体覆盖文件，没有 patch hunk；根据 beforeContent 是否存在判断 add/update。
// 为让前端 DiffView 能渲染真实行级 diff，这里用公共前缀/后缀裁剪算出最小变更行集。
// — English: write_file overwrites the whole file; compute minimal diff via common prefix/suffix trim.
function buildWriteFileChanges(
  args: Record<string, unknown>,
  beforeSnapshots: Map<string, string | null>,
): NormalizedFileChange[] {
  const filePath = typeof args.filePath === 'string' ? args.filePath.trim() : '';
  if (!filePath) return [];
  const content = typeof args.content === 'string' ? args.content : '';
  const beforeContent = beforeSnapshots.has(filePath)
    ? beforeSnapshots.get(filePath)!
    : null;
  const kind: 'add' | 'update' = beforeContent === null ? 'add' : 'update';
  const splitLines = (text: string): string[] => text === '' ? [] : text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const afterLines = splitLines(content);
  const beforeLines = beforeContent === null ? [] : splitLines(beforeContent);
  // 公共前缀/后缀裁剪：只保留真正变化的行，避免整体显示为删除+新增
  // — English: trim common prefix/suffix to keep only changed lines
  let prefix = 0;
  const maxPrefix = Math.min(beforeLines.length, afterLines.length);
  while (prefix < maxPrefix && beforeLines[prefix] === afterLines[prefix]) prefix++;
  let suffix = 0;
  const maxSuffix = Math.min(beforeLines.length - prefix, afterLines.length - prefix);
  while (suffix < maxSuffix && beforeLines[beforeLines.length - 1 - suffix] === afterLines[afterLines.length - 1 - suffix]) suffix++;
  const removedLinesContent = beforeLines.slice(prefix, beforeLines.length - suffix);
  const addedLinesContent = afterLines.slice(prefix, afterLines.length - suffix);
  const startLine = prefix + 1;
  const endLine = Math.max(prefix + removedLinesContent.length, prefix + addedLinesContent.length, startLine);
  const hunks = (addedLinesContent.length > 0 || removedLinesContent.length > 0) ? [{
    path: filePath,
    addedLines: addedLinesContent.length,
    removedLines: removedLinesContent.length,
    addedLinesContent,
    removedLinesContent,
    startLine,
    endLine,
    summary: `write_file: ${filePath}`,
  }] : [];
  return [{
    path: filePath,
    kind,
    hunks,
    addedLines: addedLinesContent.length,
    removedLines: removedLinesContent.length,
    summary: `write_file: ${filePath}`,
  }];
}

function extractPatchPaths(patchText: string): string[] {
  const paths = new Set<string>();
  for (const line of patchText.split(/\r?\n/)) {
    for (const prefix of ['*** Add File: ', '*** Delete File: ', '*** Update File: ', '*** Move to: ']) {
      if (line.startsWith(prefix)) {
        paths.add(line.slice(prefix.length).trim());
      }
    }
  }
  return [...paths].filter(Boolean);
}

async function createProjectCheckpointItem({
  turnId,
  itemId,
  turnCount,
  workspaceRoot,
  changes,
  beforeSnapshots,
  collectedItems,
}: {
  threadId: ThreadId;
  turnId: TurnId;
  itemId: ItemId;
  turnCount: number;
  workspaceRoot: string;
  changes: NormalizedFileChange[];
  beforeSnapshots: Map<string, string | null>;
  collectedItems: ThreadItem[];
}): Promise<Extract<ThreadItem, { type: 'project_checkpoint' }>> {
  const files = [];
  for (const change of changes) {
    const beforeContent = beforeSnapshots.has(change.path)
      ? beforeSnapshots.get(change.path)!
      : await readWorkspaceTextFile(workspaceRoot, change.path);
    const afterContent = await readWorkspaceTextFile(workspaceRoot, change.path);
    files.push({
      path: change.path,
      kind: change.kind,
      beforeContent,
      afterContent,
      beforeHash: beforeContent === null ? null : sha256(beforeContent),
      afterHash: afterContent === null ? null : sha256(afterContent),
    });
  }
  return {
    id: itemId,
    type: 'project_checkpoint',
    turnId,
    turnCount,
    workspaceRoot,
    files,
    knowledge: buildKnowledgeCheckpointSummary(collectedItems),
    timestamp: new Date().toISOString(),
  };
}

function buildKnowledgeCheckpointSummary(items: ThreadItem[]): KnowledgeCheckpointSummary | undefined {
  const observedFiles = new Map<string, KnowledgeCheckpointSummary['observedFiles'][number]>();
  const documentArtifacts = new Map<string, KnowledgeCheckpointSummary['documentArtifacts'][number]>();

  for (const item of items) {
    if (item.type !== 'tool_call' || item.status === 'failed') continue;
    const result = objectRecord(item.result);
    const file = objectRecord(result.file);
    const source = objectRecord(result.source);
    const artifact = objectRecord(result.artifact);

    const fileSummary = fileFingerprintSummary(file);
    if (fileSummary) observedFiles.set(fileSummary.path, fileSummary);

    const sourceSummary = fileFingerprintSummary(source);
    if (sourceSummary) observedFiles.set(sourceSummary.path, sourceSummary);

    const artifactPath = stringMetadata(artifact.path);
    const sourcePath = stringMetadata(source.path);
    const sourceHash = stringMetadata(source.sha256);
    const artifactHash = stringMetadata(artifact.sha256);
    if (artifactPath && sourcePath && sourceHash && artifactHash) {
      documentArtifacts.set(`${sourcePath}\0${artifactPath}`, {
        artifactPath,
        sourcePath,
        sourceHash,
        artifactHash,
      });
    }
  }

  if (observedFiles.size === 0 && documentArtifacts.size === 0) return undefined;
  return {
    observedFiles: [...observedFiles.values()],
    documentArtifacts: [...documentArtifacts.values()],
  };
}

function fileFingerprintSummary(value: Record<string, unknown>): KnowledgeCheckpointSummary['observedFiles'][number] | null {
  const filePath = stringMetadata(value.path);
  const sha256Value = stringMetadata(value.sha256);
  const mtimeMs = numberMetadata(value.mtimeMs);
  const sizeBytes = numberMetadata(value.sizeBytes);
  if (!filePath || !sha256Value || mtimeMs === undefined || sizeBytes === undefined) return null;
  return { path: filePath, sha256: sha256Value, mtimeMs, sizeBytes };
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

async function readWorkspaceTextFile(workspaceRoot: string, filePath: string): Promise<string | null> {
  const absolutePath = safeWorkspacePath(workspaceRoot, filePath);
  if (!absolutePath) return null;
  try {
    return await fs.readFile(absolutePath, 'utf-8');
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? null : Promise.reject(error);
  }
}

function safeWorkspacePath(workspaceRoot: string, filePath: string): string | null {
  if (!workspaceRoot.trim()) return null;
  const root = path.resolve(workspaceRoot);
  const absolutePath = path.resolve(root, filePath);
  const relative = path.relative(root, absolutePath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return null;
  return absolutePath;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

// ─── Defaults ───────────────────────────────────────────────────────────────
function createDefaultRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  for (const tool of BUILTIN_TOOLS) {
    registry.register(tool);
  }
  return registry;
}

const BUILTIN_AGENT_ROLE_PROFILES: AgentRoleProfiles = {
  [DEFAULT_AGENT_ROLE_NAME]: {
    description: 'Default spawned agent role. Inherits the parent runtime configuration.',
  },
  reviewer: {
    description: 'Reviews implementation, tests, regressions, and risks.',
    instructions: [
      'Review the delegated work with a code-review posture.',
      'Prioritize correctness, regressions, missing tests, safety, and concrete file references.',
      'Keep the final result concise and actionable.',
    ].join('\n'),
    allowedSkills: ['code-review'],
  },
  researcher: {
    description: 'Investigates code, documentation, and design context before reporting findings.',
    instructions: [
      'Explore the delegated context before drawing conclusions.',
      'Prefer source-backed findings and identify uncertainty explicitly.',
      'Do not make code changes unless the task explicitly asks for implementation.',
    ].join('\n'),
  },
  implementer: {
    description: 'Implements focused changes and reports verification results.',
    instructions: [
      'Implement the delegated change within the inherited workspace and constraints.',
      'Keep edits scoped, preserve unrelated user changes, and verify the behavior you changed.',
    ].join('\n'),
  },


};

function normalizeAgentRoleProfiles(profiles?: AgentRoleProfiles): AgentRoleProfiles {
  const normalized: AgentRoleProfiles = {};
  for (const [name, profile] of Object.entries(profiles ?? {})) {
    const normalizedName = normalizeAgentRoleName(name);
    if (normalizedName) normalized[normalizedName] = { ...profile };
  }
  return normalized;
}

function normalizeAgentRoleName(name: string | null | undefined): string {
  const trimmed = (name ?? DEFAULT_AGENT_ROLE_NAME).trim();
  return trimmed || DEFAULT_AGENT_ROLE_NAME;
}

function resolveAgentRoleProfile(profiles: AgentRoleProfiles, name: string | null | undefined): ResolvedAgentRoleProfile {
  const roleName = normalizeAgentRoleName(name);
  const profile = profiles[roleName] ?? BUILTIN_AGENT_ROLE_PROFILES[roleName];
  if (!profile) {
    const error = new Error(`unknown agent_type '${roleName}'`);
    (error as Error & { code?: string }).code = 'UNKNOWN_AGENT_ROLE';
    throw error;
  }
  return { ...profile, name: roleName };
}

function scopedSkillsForRole(parentSkills: SkillRegistry, profile: ResolvedAgentRoleProfile | null | undefined): SkillRegistry {
  const allowedSkillNames = profile ? profile.allowedSkills ?? profile.skills : undefined;
  if (!allowedSkillNames || allowedSkillNames.length === 0) return parentSkills;
  const registry = new LocalSkillRegistry();
  for (const name of allowedSkillNames) {
    const skill = parentSkills.get(name);
    if (skill) registry.register(skill);
  }
  return registry;
}

function buildRoleProfilePrompt(profile: ResolvedAgentRoleProfile | null | undefined): string {
  if (!profile) return '';
  const lines = [`## Agent Role Profile: ${profile.name}`];
  if (profile.description?.trim()) lines.push(`Description: ${profile.description.trim()}`);
  const instructions = [profile.instructions, profile.systemPrompt]
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .join('\n\n');
  if (instructions) lines.push(`Instructions:\n${instructions}`);
  const allowedSkills = profile.allowedSkills ?? profile.skills;
  if (allowedSkills?.length) lines.push(`Allowed skills: ${allowedSkills.join(', ')}`);
  if (profile.allowedTools?.length) lines.push(`Allowed tools: ${profile.allowedTools.join(', ')}`);
  if (profile.blockedTools?.length) lines.push(`Blocked tools: ${profile.blockedTools.join(', ')}`);
  return lines.join('\n');
}

function registerCollabTools(
  registry: ToolRegistry,
  options?: { a2aClientEnabled?: boolean; a2aRemotes?: string[] },
): void {
  for (const tool of createCollabToolDefinitions(options)) {
    if (!registry.get(tool.name)) {
      registry.register(tool);
    }
  }
}

function registerOptionalTools(registry: ToolRegistry, tools: ToolDefinition[]): void {
  for (const tool of tools) {
    if (!registry.get(tool.name)) {
      registry.register(tool);
    }
  }
}

function resolveToolName(registry: ToolRegistry, name: string): string {
  const maybeRegistry = registry as ToolRegistry & { resolveName?: (toolName: string) => string };
  if (typeof maybeRegistry.resolveName === 'function') {
    return maybeRegistry.resolveName(name);
  }
  return FALLBACK_TOOL_ALIASES.get(name) ?? name;
}

const FALLBACK_TOOL_ALIASES = new Map<string, string>([
  ['list_file', 'list_files'],
  ['list_dir', 'list_files'],
  ['list_directory', 'list_files'],
  ['ls', 'list_files'],
  ['dir', 'list_files'],
  ['search_file', 'search_content'],
  ['search_files', 'search_content'],
  ['grep', 'search_content'],
  ['rg', 'search_content'],
  ['read_files', 'read_file'],
  ['cat', 'read_file'],
  ['open_page', 'web_search'],
  ['open_url', 'web_search'],
  ['fetch_url', 'web_fetch'],
  ['web_open', 'web_search'],
]);

function createCollabToolDefinitions(options?: { a2aClientEnabled?: boolean; a2aRemotes?: string[] }): ToolDefinition[] {
  const readonly = 'readonly' as const;
  const tools: ToolDefinition[] = [
    {
      name: 'spawn_agent',
      description: 'Spawn a child agent thread for an independent subtask. Use this when parallel investigation or delegation helps.',
      requiredPolicy: readonly,
      requiresApproval: false,
      parameters: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: 'The full task prompt for the child agent.' },
          agentRole: { type: 'string', description: 'Agent role profile, such as default, reviewer, researcher, implementer, or a configured role.' },
          agent_type: { type: 'string', description: 'Codex-compatible role label alias for agentRole.' },
          agentNickname: { type: 'string', description: 'Optional display nickname for the child agent.' },
          model: { type: 'string', description: 'Optional requested model metadata. Suanlizi child agents still inherit the parent model.' },
          reasoningEffort: { type: 'string', description: 'Optional requested reasoning effort metadata.' },
          reasoning_effort: { type: 'string', description: 'Codex-compatible reasoning effort alias.' },
        },
        required: ['prompt'],
        additionalProperties: false,
      },
      execute: async () => ({ output: 'handled by AgentLoop', status: 'completed' as const }),
    },
    {
      name: 'send_input',
      description: 'Send a new prompt to an existing child agent thread.',
      requiredPolicy: readonly,
      requiresApproval: false,
      parameters: {
        type: 'object',
        properties: {
          threadId: { type: 'string', description: 'Child thread ID.' },
          prompt: { type: 'string', description: 'Message to send to the child agent.' },
          interrupt: { type: 'boolean', description: 'Interrupt the child if it is already running before sending.' },
        },
        required: ['threadId', 'prompt'],
        additionalProperties: false,
      },
      execute: async () => ({ output: 'handled by AgentLoop', status: 'completed' as const }),
    },
    {
      name: 'send_message',
      description: 'Queue a message for an existing child agent without starting a new turn.',
      requiredPolicy: readonly,
      requiresApproval: false,
      parameters: {
        type: 'object',
        properties: {
          target: { type: 'string', description: 'Child thread ID.' },
          message: { type: 'string', description: 'Message to queue for the child agent.' },
        },
        required: ['target', 'message'],
        additionalProperties: false,
      },
      execute: async () => ({ output: 'handled by AgentLoop', status: 'completed' as const }),
    },
    {
      name: 'followup_task',
      description: 'Queue a follow-up task for an existing child agent and wake it to run a turn.',
      requiredPolicy: readonly,
      requiresApproval: false,
      parameters: {
        type: 'object',
        properties: {
          target: { type: 'string', description: 'Child thread ID.' },
          message: { type: 'string', description: 'Task message for the child agent.' },
        },
        required: ['target', 'message'],
        additionalProperties: false,
      },
      execute: async () => ({ output: 'handled by AgentLoop', status: 'completed' as const }),
    },
    {
      name: 'resume_agent',
      description: 'Reconnect to an existing child agent thread after reload or process restart.',
      requiredPolicy: readonly,
      requiresApproval: false,
      parameters: {
        type: 'object',
        properties: {
          threadId: { type: 'string', description: 'Child thread ID.' },
        },
        required: ['threadId'],
        additionalProperties: false,
      },
      execute: async () => ({ output: 'handled by AgentLoop', status: 'completed' as const }),
    },
    {
      name: 'wait',
      description: 'Wait for one child agent, or all open child agents when threadId is omitted, and return their latest results.',
      requiredPolicy: readonly,
      requiresApproval: false,
      parameters: {
        type: 'object',
        properties: {
          threadId: { type: 'string', description: 'Optional child thread ID.' },
        },
        additionalProperties: false,
      },
      execute: async () => ({ output: 'handled by AgentLoop', status: 'completed' as const }),
    },
    {
      name: 'wait_agent',
      description: 'Codex-compatible alias for wait. Wait for one child agent, or all open child agents when target is omitted.',
      requiredPolicy: readonly,
      requiresApproval: false,
      parameters: {
        type: 'object',
        properties: {
          target: { type: 'string', description: 'Optional child thread ID.' },
          threadId: { type: 'string', description: 'Optional child thread ID.' },
        },
        additionalProperties: false,
      },
      execute: async () => ({ output: 'handled by AgentLoop', status: 'completed' as const }),
    },
    {
      name: 'list_agents',
      description: 'List spawned child agents and their current/persisted status.',
      requiredPolicy: readonly,
      requiresApproval: false,
      parameters: {
        type: 'object',
        properties: {
          path_prefix: { type: 'string', description: 'Optional child id or nickname prefix.' },
        },
        additionalProperties: false,
      },
      execute: async () => ({ output: 'handled by AgentLoop', status: 'completed' as const }),
    },
    {
      name: 'close_agent',
      description: 'Close a child agent thread edge. If the child is running, it is interrupted first.',
      requiredPolicy: readonly,
      requiresApproval: false,
      parameters: {
        type: 'object',
        properties: {
          threadId: { type: 'string', description: 'Child thread ID.' },
        },
        required: ['threadId'],
        additionalProperties: false,
      },
      execute: async () => ({ output: 'handled by AgentLoop', status: 'completed' as const }),
    },
  ];
  // 中文注释：仅当 a2aClientEnabled=true 时注册 spawn_remote_agent 工具
  // — Chinese: only register spawn_remote_agent when a2aClientEnabled=true
  if (options?.a2aClientEnabled) {
    const remotesHint = options.a2aRemotes?.length
      ? ` Registered remote agents: ${options.a2aRemotes.join(', ')}.`
      : '';
    tools.push({
      name: 'spawn_remote_agent',
      description: `Delegate a subtask to a remote A2A (Agent-to-Agent) agent. The remote agent executes the task and returns its result. Use this for cross-framework collaboration or when a remote agent has specialized capabilities.${remotesHint}`,
      requiredPolicy: readonly,
      requiresApproval: false,
      parameters: {
        type: 'object',
        properties: {
          agentUrl: {
            type: 'string',
            description: 'URL of the remote A2A agent (e.g. https://host/api/a2a or https://host/.well-known/agent-card.json).',
          },
          task: {
            type: 'string',
            description: 'Task description to send to the remote agent.',
          },
          context: {
            type: 'string',
            description: 'Optional additional context to pass to the remote agent.',
          },
        },
        required: ['agentUrl', 'task'],
        additionalProperties: false,
      },
      execute: async () => ({ output: 'handled by AgentLoop', status: 'completed' as const }),
    });
  }
  return tools;
}

function threadItemsToModelMessages(items: ThreadItem[]): ChatMessage[] {
  const messages: ChatMessage[] = [];
  for (const item of items) {
    const structuredMessages = itemToStructuredToolHistoryMessages(item);
    if (structuredMessages) {
      messages.push(...structuredMessages);
      continue;
    }
    const msg = itemToMessage(item);
    if (msg) messages.push(msg);
  }
  return sanitizeStructuredToolHistory(messages);
}

function itemToStructuredToolHistoryMessages(item: ThreadItem): ChatMessage[] | null {
  if (item.type === 'agent_message' && item.rejectedReason === 'plain_text_tool_placeholder') {
    return [];
  }

  if (item.type === 'agent_message' && item.providerFrame?.format === 'anthropic_messages') {
    return [{
      role: 'assistant',
      content: item.text,
      providerFrame: {
        format: 'anthropic_messages',
        contentBlocks: item.providerFrame.contentBlocks as AnthropicContentBlock[],
      },
    }];
  }

  if (item.type === 'agent_message' && item.providerFrame?.format === 'openai_responses') {
    const toolCalls = item.providerFrame.outputItems
      .filter((entry): entry is { type: 'function_call'; call_id: string; name: string; arguments: string } =>
        !!entry && typeof entry === 'object' && (entry as any).type === 'function_call')
      .map((entry) => ({
        id: entry.call_id,
        type: 'function' as const,
        function: { name: entry.name, arguments: entry.arguments ?? '{}' },
      }));
    const message: ChatMessage = {
      role: 'assistant',
      content: '',
      providerFrame: { format: 'openai_responses', outputItems: item.providerFrame.outputItems },
    };
    if (toolCalls.length > 0) message.tool_calls = toolCalls;
    return [message];
  }

  if (item.type === 'agent_message' && item.providerFrame?.format === 'openai_chat') {
    const toolCalls = normalizeOpenAiToolCalls(item.providerFrame.toolCalls);
    const message: ChatMessage = {
      role: 'assistant',
      content: typeof item.providerFrame.content === 'string' ? item.providerFrame.content : item.text,
    };
    if (toolCalls.length > 0) {
      message.tool_calls = toolCalls;
      if (!message.content) {
        message.content = '';
      }
    }
    if (typeof item.providerFrame.reasoningContent === 'string') {
      message.reasoning_content = item.providerFrame.reasoningContent;
    }
    if (Array.isArray(item.providerFrame.reasoningDetails)) {
      message.reasoning_details = item.providerFrame.reasoningDetails;
    }
    if (!message.content && !message.tool_calls?.length) {
      return [];
    }
    return [message];
  }

  const toolCallId = getModelToolCallId(item);
  if (!toolCallId) {
    return null;
  }
  const content = toolHistoryContent(item);
  if (content === null) {
    return [];
  }
  return [{
    role: 'tool',
    tool_call_id: toolCallId,
    content,
  }];
}

function buildProviderFrameForToolCalls(
  toolHistoryMode: string,
  content: string | null,
  reasoningContent: string,
  toolCalls: ToolCall[],
): NonNullable<ChatMessage['providerFrame']> {
  if (toolHistoryMode === 'openai_responses') {
    const outputItems: unknown[] = [];
    if (reasoningContent.trim()) {
      outputItems.push({
        type: 'reasoning',
        summary: [{ type: 'summary_text', text: reasoningContent }],
        content: [{ type: 'input_text', text: reasoningContent }],
      });
    }
    if (content?.trim()) {
      outputItems.push({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: content }] });
    }
    for (const toolCall of toolCalls) {
      outputItems.push({
        type: 'function_call',
        call_id: toolCall.id,
        name: toolCall.function.name,
        arguments: toolCall.function.arguments || '{}',
      });
    }
    return { format: 'openai_responses', outputItems };
  }
  if (toolHistoryMode === 'anthropic_blocks') {
    const contentBlocks: AnthropicContentBlock[] = [];
    if (reasoningContent.trim()) {
      contentBlocks.push({ type: 'thinking', thinking: reasoningContent });
    }
    if (content?.trim()) {
      contentBlocks.push({ type: 'text', text: content });
    }
    for (const toolCall of toolCalls) {
      contentBlocks.push({
        type: 'tool_use',
        id: toolCall.id,
        name: toolCall.function.name,
        input: parseToolCallArguments(toolCall.function.arguments),
      });
    }
    return {
      format: 'anthropic_messages',
      contentBlocks,
    };
  }
  return {
    format: 'openai_chat',
    content,
    toolCalls,
    ...(reasoningContent.trim() ? { reasoningContent } : {}),
  };
}

function parseToolCallArguments(argumentsText: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(argumentsText);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : { _value: parsed };
  } catch {
    return { _raw: argumentsText };
  }
}

function normalizeOpenAiToolCalls(value: unknown[] | undefined): ToolCall[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isOpenAiToolCall).map(sanitizeToolCallForHistory);
}

function isOpenAiToolCall(value: unknown): value is ToolCall {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  const fn = record.function;
  return typeof record.id === 'string'
    && record.type === 'function'
    && !!fn
    && typeof fn === 'object'
    && typeof (fn as Record<string, unknown>).name === 'string'
    && typeof (fn as Record<string, unknown>).arguments === 'string';
}

function sanitizeToolCallForHistory(toolCall: ToolCall): ToolCall {
  if (!isDingtalkGroupForwardTool(toolCall.function.name)) {
    return toolCall;
  }
  return {
    ...toolCall,
    function: {
      ...toolCall.function,
      arguments: JSON.stringify({ redacted: true }),
    },
  };
}

function getModelToolCallId(item: ThreadItem): string | null {
  switch (item.type) {
    case 'tool_call':
    case 'mcp_tool_call':
    case 'collab_tool_call':
      return typeof item.modelToolCallId === 'string' && item.modelToolCallId.trim()
        ? item.modelToolCallId
        : null;
    default:
      return null;
  }
}

function toolHistoryContent(item: ThreadItem): string | null {
  switch (item.type) {
    case 'tool_call':
      if (isDingtalkGroupForwardTool(item.toolName)) {
        return 'DingTalk group message tool result redacted. Do not reuse this prior tool call or reveal internal routing details.';
      }
      return formatToolHistoryPayload(item.result ?? item.error ?? item.arguments);
    case 'mcp_tool_call':
      return formatToolHistoryPayload(item.result ?? item.error ?? item.arguments);
    case 'collab_tool_call':
      return formatToolHistoryPayload(item.result ?? item.error ?? item.prompt);
    default:
      return null;
  }
}

function sanitizeStructuredToolHistory(messages: ChatMessage[]): ChatMessage[] {
  const availableToolResultIds = new Set(
    messages
      .filter((message) => message.role === 'tool' && typeof message.tool_call_id === 'string')
      .map((message) => message.tool_call_id as string),
  );
  const normalized = messages
    .map((message): ChatMessage | null => {
      if (message.role !== 'assistant' || !message.tool_calls?.length) return message;
      const toolCalls = message.tool_calls.filter((toolCall) => availableToolResultIds.has(toolCall.id));
      if (toolCalls.length === 0) {
        return typeof message.content === 'string' && message.content.trim()
          ? { ...message, tool_calls: undefined }
          : null;
      }
      return { ...message, tool_calls: toolCalls };
    })
    .filter((message): message is ChatMessage => message !== null);

  const pendingToolCallIds = new Set<string>();
  const sanitized: ChatMessage[] = [];
  for (const message of normalized) {
    if (message.role === 'assistant' && message.tool_calls?.length) {
      for (const toolCall of message.tool_calls) {
        pendingToolCallIds.add(toolCall.id);
      }
      sanitized.push(message);
      continue;
    }
    if (message.role === 'tool') {
      const toolCallId = message.tool_call_id;
      if (!toolCallId || !pendingToolCallIds.has(toolCallId)) {
        continue;
      }
      pendingToolCallIds.delete(toolCallId);
      sanitized.push(message);
      continue;
    }
    sanitized.push(message);
  }
  return sanitized;
}

function itemToMessage(item: ThreadItem): ChatMessage | null {
  switch (item.type) {
    case 'user_message':
      return { role: 'user', content: item.text };
    case 'agent_message':
      if (
        item.rejectedReason === 'plain_text_tool_placeholder'
        && typeof item.timestamp === 'string'
        && Date.now() - Date.parse(item.timestamp) < 60_000
      ) {
        return null;
      }
      if (leaksToolProtocol(item.text)) {
        return {
          role: 'assistant',
          content: '[Previous assistant message redacted because it contained leaked tool-call protocol text.]',
        };
      }
      return { role: 'assistant', content: item.text };
    case 'reasoning':
      return null;
    case 'tool_call':
      return null;
    case 'context_compaction':
      return {
        role: 'assistant',
        content: `[Context compaction ${item.status}]\n${item.summary?.raw ?? ''}`,
      };
    case 'collab_tool_call':
      return null;
    case 'mcp_tool_call':
      return null;
    case 'command_execution':
      return {
        role: 'assistant',
        content: `[Command ${item.status}]\n${item.command}\n${item.aggregatedOutput}`,
      };
    case 'error':
      return null;
    default:
      return null;
  }
}

function fitMessagesToBudget(messages: ChatMessage[], maxTokens: number): ChatMessage[] {
  if (estimateRuntimeChatTokens(messages).inputTokens <= maxTokens) return messages;
  if (messages.length <= 2) return messages;

  const first = messages[0];
  const last = messages[messages.length - 1];
  const middle = messages.slice(1, -1);
  const retained: ChatMessage[] = [];
  for (let index = middle.length - 1; index >= 0; index -= 1) {
    const candidate = [first, middle[index], ...retained, last];
    if (estimateRuntimeChatTokens(candidate).inputTokens <= maxTokens) {
      retained.unshift(middle[index]);
    }
  }
  return [first, ...retained, last];
}

function estimateRuntimeChatTokens(messages: ChatMessage[]): {
  inputTokens: number;
  messageCount: number;
  imageCount: number;
  charCount: number;
} {
  let charCount = 0;
  let imageCount = 0;
  for (const message of messages) {
    charCount += message.role.length + 4;
    if (typeof message.content === 'string') {
      charCount += message.content.length;
      continue;
    }
    for (const part of message.content) {
      if (part.type === 'text') {
        charCount += part.text.length;
      } else if (part.type === 'image_url') {
        imageCount += 1;
        charCount += 85;
      }
    }
  }
  return {
    inputTokens: Math.max(1, Math.ceil(charCount / 4) + messages.length * 3 + imageCount * 85),
    messageCount: messages.length,
    imageCount,
    charCount,
  };
}

function formatToolHistoryPayload(payload: unknown): string {
  if (payload === undefined || payload === null) return '';
  return typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2);
}

function isTextToolPlaceholder(content: unknown): boolean {
  if (typeof content !== 'string') return false;
  const trimmed = content.trim();
  if (!trimmed) return false;
  return /\[(?:Tool|tool)\s+[\w.-]+(?:\s+(?:completed|failed|running|pending))?\]/.test(trimmed)
    || /^工具调用\s*[:：]\s*[\w.-]+\s*$/i.test(trimmed)
    || leaksToolProtocol(trimmed);
}

function isDingtalkGroupForwardTool(name: string): boolean {
  return name === 'dingtalk_send_group_message' || name === 'dingtalk_forward_to_group';
}

function userInputToText(input: UserInput): string {
  if (input.type === 'text') return input.text;
  return input.parts
    .map((part) => {
      if (part.type === 'text') return part.text;
      if (part.type === 'image_url') return '[image]';
      return `[image: ${part.path}]`;
    })
    .filter(Boolean)
    .join('\n');
}

async function imagePathToDataUrl(filePath: string, declaredMimeType?: string): Promise<string | null> {
  try {
    const content = await fs.readFile(filePath);
    if (content.byteLength === 0 || content.byteLength > 20 * 1024 * 1024) return null;
    const extension = path.extname(filePath).slice(1).toLowerCase();
    const mimeType = declaredMimeType || ({ jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml' }[extension] ?? 'application/octet-stream');
    return `data:${mimeType};base64,${content.toString('base64')}`;
  } catch {
    return null;
  }
}

function userInputModeInstruction(input: UserInput): string {
  const value = input.modeInstruction;
  return typeof value === 'string' ? value.trim() : '';
}

function appendTurnInstruction(text: string, instruction: string): string {
  const trimmed = instruction.trim();
  if (!trimmed) return text;
  return `${text}\n\n${trimmed}`;
}

function generateId(): string {
  return `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function generateItemId(turnId: TurnId, index: number): ItemId {
  return `${turnId}_item_${index}`;
}

function isTurnCancelledError(error: unknown): boolean {
  return error instanceof Error && error.message === 'Turn cancelled';
}

function safeRuntimeTenantId(value: string | null | undefined): string {
  const tenantId = value?.trim() || 'default';
  if (!/^[A-Za-z0-9_-]+$/.test(tenantId)) {
    throw new Error(`Invalid tenant id: ${value ?? ''}`);
  }
  return tenantId;
}

function decisionResponseText(response: AgentDecisionResponse): string {
  if (response.action === 'cancel') return '用户拒绝了当前决策；请继续处理本轮任务，不要将此决定当作取消整个任务。';
  if (response.action === 'custom_input') return response.customInput?.trim() || '用户选择了自定义输入，但未提供内容。';
  if (response.optionId) return `用户选择了 ${response.optionId}。`;
  if (response.action === 'way_one') return '用户选择方式一。';
  if (response.action === 'way_two') return '用户选择方式二。';
  return '用户确认继续。';
}

function combineAbortSignals(external: AbortSignal | undefined, internal: AbortSignal): AbortSignal {
  if (!external) return internal;
  if (external.aborted || internal.aborted) return AbortSignal.abort();
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  external.addEventListener('abort', abort, { once: true });
  internal.addEventListener('abort', abort, { once: true });
  return controller.signal;
}

function positiveInteger(value: number | undefined): number | undefined {
  if (!Number.isFinite(value) || !value || value <= 0) return undefined;
  return Math.floor(value);
}

function isCollabTool(name: string): name is CollabToolName {
  return [
    'spawn_agent',
    'send_input',
    'send_message',
    'followup_task',
    'resume_agent',
    'wait',
    'wait_agent',
    'list_agents',
    'close_agent',
    'spawn_remote_agent',
  ].includes(name);
}

function stringArg(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function truncateMonitorText(text: string, max = 500): string {
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

function redactMonitorArgs(args: Record<string, unknown>): Record<string, unknown> {
  const redacted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (/key|token|secret|password|authorization/i.test(key)) {
      redacted[key] = '[redacted]';
    } else if (typeof value === 'string') {
      redacted[key] = truncateMonitorText(value, 300);
    } else {
      redacted[key] = value;
    }
  }
  return redacted;
}

function requiredThreadArg(args: Record<string, unknown>): ThreadId {
  const threadId = stringArg(args, 'threadId') ?? stringArg(args, 'agentId');
  if (!threadId) throw new Error('Child threadId is required');
  return threadId;
}

function titleFromText(text: string): string {
  const compact = text.replace(/\s+/g, ' ').trim();
  return compact.length > 48 ? `${compact.slice(0, 48)}...` : compact || 'Subagent';
}

function formatCollabToolOutput(item: CollabToolCallItem, locale: Locale): string {
  const zh = locale === 'zh';
  const payload = item.result ?? item.error ?? {};
  if (item.status === 'failed') {
    const message = item.error?.message ?? (zh ? '协作工具失败。' : 'Collaboration tool failed.');
    return zh ? `失败：${message}` : `Failed: ${message}`;
  }
  const json = typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2);
  return zh
    ? `${item.tool} 已完成。\n${json}`
    : `${item.tool} completed.\n${json}`;
}
