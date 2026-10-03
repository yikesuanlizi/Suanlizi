// ─── Tool definition ────────────────────────────────────────────────────────
// 工具定义模块：声明所有内置工具的元信息、参数 schema、执行入口
import type {
  AccessDecision,
  AccessPolicyConfig,
  AccessRequest,
  AgentDecisionOption,
  AgentDecisionResponse,
  CommandStatus,
  SystemMonitorInterface,
} from '@suanlizi/protocol';
import type { SandboxLevel } from '@suanlizi/sandbox';
import type { WebProviderRouterOptions } from './web/provider.js';

/** Schema for tool parameters (JSON Schema subset). */
// 工具参数 schema（JSON Schema 的子集），用于描述工具接受的参数结构
export interface ToolParamSchema {
  type: string;
  description?: string;
  properties?: Record<string, ToolParamSchema>;
  required?: string[];
  additionalProperties?: boolean;
  enum?: string[];
  items?: ToolParamSchema;
}

/** A registered tool definition. */
// 已注册工具的完整定义：模型看到的工具描述 + 实际执行函数
export interface ToolDefinition {
  /** Unique tool name (e.g. "read_file", "shell_command"). */
  // 工具唯一名称（例如 "read_file"、"shell_command"），用于在工具调用中索引
  name: string;
  /** Description for the model. */
  // 面向模型的自然语言描述，模型根据这段文字决定是否调用该工具
  description: string;
  /** JSON Schema for the arguments. */
  // 参数的 JSON Schema，模型按此结构产出工具调用入参
  parameters: ToolParamSchema;
  /** Execution timeout in ms. */
  // 执行超时（毫秒），超过后会被强制中断
  timeoutMs?: number;
  /** Max output length in characters before truncation. */
  // 输出最大字符数，超过部分会被截断并附上 truncation 元数据
  maxOutputLength?: number;
  /** Which sandbox level is required. */
  // 执行该工具所需的沙箱权限级别（readonly / workspace / danger_full_access）
  requiredPolicy: SandboxLevel;
  /** Whether this tool requires HITL approval. */
  // 是否需要人机审批（HITL），true 则执行前会弹出审批对话框
  requiresApproval?: boolean;
  /** Whether multiple calls to this readonly tool can run concurrently in the same model step. */
  // 是否允许在同一轮模型推理中并发调用（只读工具才能开启）
  supportsParallelToolCalls?: boolean;
  /** The actual implementation. */
  // 真正的执行函数；返回统一结构化的 ToolResult
  execute: (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>;
}

/** Context passed to every tool execution. */
// 每次执行工具时都会注入的上下文，包含工作目录、线程 ID、是否已审批等
export interface ToolContext {
  /** Absolute workspace root. */
  // 工作区根目录的绝对路径，用于解析相对路径
  workspaceRoot: string;
  /** Current thread ID. */
  // 当前线程 ID，便于日志与审计追溯
  threadId: string;
  /** Current turn ID. */
  // 当前回合（turn）ID，便于在多步骤任务中关联
  turnId: string;
  /** Whether execution is approved. */
  // 是否已经过人工审批，工具内部可据此决定是否降级返回
  approved: boolean;
  /** Runtime access policy snapshot for this turn. */
  // 当前 turn 的运行时权限策略快照（可选）
  accessPolicy?: AccessPolicyConfig;
  /** Ask runtime whether this access is allowed, needs approval, or denied. */
  // 请求 runtime 判定一次具体访问是否允许、需要审批或拒绝
  requestAccess?: (request: AccessRequest) => Promise<AccessDecision>;
  /** AbortSignal for cancellation. */
  // 取消信号：用户中断或超时时会触发，工具内应监听以提前退出
  signal?: AbortSignal;
  /** Optional web provider settings supplied by the runtime from persisted app settings. */
  // 运行时从持久化应用设置中下发的 web provider 配置（可选）
  webProvider?: WebProviderRouterOptions;
  /** 系统监控模块引用（可选），启用后 agent 可查询主机 CPU/内存/磁盘状态 */
  // — Chinese: system monitor reference (optional), enables agent to query host CPU/memory/disk
  systemMonitor?: SystemMonitorInterface;
  /**
   * 长时命令的流式输出回调（可选）：shell 等工具在执行期间逐段推送输出增量，
   * 运行时把它包装成 command_output.delta 事件转发给前端，实现"终端式"实时预览。
   * — Chinese: streaming output callback for long-running commands; the runtime
   *   forwards deltas as command_output.delta events for live terminal preview.
   */
  onOutputDelta?: (delta: string) => void;
  /** Runtime-owned, durable user decision request. */
  requestUserDecision?: (input: {
    prompt: string;
    options: AgentDecisionOption[];
    allowCustomInput: boolean;
  }) => Promise<AgentDecisionResponse>;
}

/** Result of a tool execution. */
// 工具执行结果统一结构：output 给人看，data 给程序用
export interface ToolResult {
  /** Human-readable output. */
  // 人类可读的输出，会直接回填到模型上下文
  output: string;
  /** Structured data if applicable. */
  // 可选的结构化数据，模型可以再次消费
  data?: unknown;
  /** Error details if failed. */
  // 失败时的错误对象，包含 message 与可选的错误码
  error?: { message: string; code?: string };
  /** Exit code (for shell commands). */
  // 退出码（主要给 shell_command 用）
  exitCode?: number;
  /** Status. */
  // 执行状态：running / completed / failed / denied 等
  status: CommandStatus;
}

// 工具注册表的过滤条件：include 与 exclude 是工具名的白/黑名单
export interface ToolRegistrySchemaFilter {
  include?: Iterable<string>;
  exclude?: Iterable<string>;
}

// 工具搜索选项：limit 限制返回数量，exclude 排除不参与搜索的工具
export interface ToolSearchOptions {
  limit?: number;
  exclude?: Iterable<string>;
}

// 工具搜索匹配项的轻量描述，模型按需 discover 工具时使用
export interface ToolSearchMatch {
  name: string;
  description: string;
  requiredPolicy: SandboxLevel;
  requiresApproval: boolean;
  parameters: ToolParamSchema;
}

// ─── Tool Registry ──────────────────────────────────────────────────────────
// 工具注册表：负责注册、查找、别名解析、并发执行、输出截断等核心逻辑
export class ToolRegistry {
  // 已注册工具表：name -> ToolDefinition
  private tools: Map<string, ToolDefinition> = new Map();
  // 工具别名表：alias -> 规范名，默认带 ls/cat 等常见 Unix 习惯映射
  private aliases: Map<string, string> = new Map(DEFAULT_TOOL_ALIASES);

  // 注册一个新工具；同名重复注册会抛错，避免静默覆盖
  register(tool: ToolDefinition): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool "${tool.name}" is already registered`);
    }
    this.tools.set(tool.name, tool);
  }

  // 按名获取工具定义，会先做别名解析
  get(name: string): ToolDefinition | undefined {
    return this.tools.get(this.resolveName(name));
  }

  // 列出所有已注册工具
  list(): ToolDefinition[] {
    return [...this.tools.values()];
  }

  // 注册一个新的别名映射（alias -> canonicalName），同名的别名覆盖
  registerAlias(alias: string, canonicalName: string): void {
    if (alias === canonicalName) return;
    this.aliases.set(alias, canonicalName);
  }

  // 把传入的工具名解析成注册表里的规范名（无别名则原样返回）
  resolveName(name: string): string {
    return this.aliases.get(name) ?? name;
  }

  /** Get tools formatted for OpenAI-compatible tool_choice. */
  // 导出 OpenAI 兼容的 tools 数组，供 Chat Completions / Responses 接口使用
  // 支持 include / exclude 过滤，结果按名称排序便于缓存命中
  toOpenAITools(filter: ToolRegistrySchemaFilter = {}): Array<{
    type: 'function';
    function: { name: string; description: string; parameters: ToolParamSchema };
  }> {
    const include = filter.include ? new Set([...filter.include].map((name) => this.resolveName(name))) : null;
    const exclude = new Set([...(filter.exclude ?? [])].map((name) => this.resolveName(name)));
    return this.list()
      .filter((tool) => !include || include.has(tool.name))
      .filter((tool) => !exclude.has(tool.name))
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((t) => ({
      type: 'function' as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      },
    }));
  }

  /** Search registered tools by name and description for delayed schema binding. */
  // 按关键词搜索工具：用于 tool_search 这种延迟 schema 绑定场景
  // 评分规则：完全匹配名称 +20，名称包含 +10，描述包含 +3
  search(query: string, options: ToolSearchOptions = {}): ToolSearchMatch[] {
    const limit = Math.max(1, Math.min(options.limit ?? 8, 50));
    const exclude = new Set([...(options.exclude ?? [])].map((name) => this.resolveName(name)));
    const terms = normalizeSearchTerms(query);
    return this.list()
      .filter((tool) => !exclude.has(tool.name))
      .map((tool) => ({ tool, score: scoreTool(tool, terms) }))
      .filter((entry) => terms.length === 0 || entry.score > 0)
      .sort((a, b) => b.score - a.score || a.tool.name.localeCompare(b.tool.name))
      .slice(0, limit)
      .map(({ tool }) => ({
        name: tool.name,
        description: tool.description,
        requiredPolicy: tool.requiredPolicy,
        requiresApproval: tool.requiresApproval === true,
        parameters: tool.parameters,
      }));
  }

  /** Execute a tool by name. */
  // 执行指定名称的工具：解析别名 -> 查表 -> 超时控制 -> 输出截断 -> 错误兜底
  async execute(
    name: string,
    args: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<ToolResult> {
    const resolvedName = this.resolveName(name);
    const tool = this.tools.get(resolvedName);
    if (!tool) {
      return {
        output: `Unknown tool: ${name}`,
        status: 'failed',
        error: { message: `Tool "${name}" not found`, code: 'UNKNOWN_TOOL' },
      };
    }

    const controller = new AbortController();
    const forwardAbort = () => controller.abort(ctx.signal?.reason ?? new Error('Tool execution cancelled'));
    if (ctx.signal?.aborted) forwardAbort();
    else ctx.signal?.addEventListener('abort', forwardAbort, { once: true });

    try {
      const timeout = tool.timeoutMs ?? 60_000;
      const result = await withTimeout(
        () => tool.execute(args, { ...ctx, signal: controller.signal }),
        timeout,
        controller,
      );
      // Deterministic tool-result pruning keeps command heads and error tails
      // while avoiding a model call for compaction.
      // 中文注释：进入模型前先做无模型调用的首尾裁剪，避免巨型工具输出挤占上下文。
      const maxLen = Math.min(tool.maxOutputLength ?? DEFAULT_TOOL_RESULT_LIMIT, DEFAULT_TOOL_RESULT_LIMIT);
      if (result.output.length > maxLen) {
        const originalLength = result.output.length;
        result.output = pruneToolOutput(result.output, maxLen);
        result.data = withTruncationMetadata(result.data, {
          originalLength,
          returnedLength: result.output.length,
          maxOutputLength: maxLen,
        });
      }
      return result;
    } catch (err) {
      const aborted = controller.signal.aborted;
      const abortReason = controller.signal.reason instanceof Error
        ? controller.signal.reason.message
        : 'Tool execution cancelled';
      return {
        output: aborted ? abortReason : `Tool error: ${String(err)}`,
        status: 'failed',
        error: {
          message: aborted ? abortReason : String(err),
          code: aborted && abortReason.includes('timed out') ? 'TOOL_TIMEOUT' : aborted ? 'TOOL_CANCELLED' : 'EXECUTION_ERROR',
        },
      };
    } finally {
      ctx.signal?.removeEventListener('abort', forwardAbort);
    }
  }
}

// 把搜索 query 拆成小写 token，支持中英文（按 CJK Unicode 段切分）
function normalizeSearchTerms(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^a-z0-9_\u4e00-\u9fff]+/u)
    .map((term) => term.trim())
    .filter(Boolean);
}

// 工具搜索评分：名称命中权重远高于描述，便于精确匹配
function scoreTool(tool: ToolDefinition, terms: string[]): number {
  if (terms.length === 0) return 1;
  const name = tool.name.toLowerCase();
  const description = tool.description.toLowerCase();
  let score = 0;
  for (const term of terms) {
    if (name === term) score += 20;
    else if (name.includes(term)) score += 10;
    if (description.includes(term)) score += 3;
  }
  return score;
}

// 默认工具别名表：把常见的 Unix 命令习惯映射到规范工具名
const DEFAULT_TOOL_ALIASES = new Map<string, string>([
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

/** 默认进入模型上下文的工具输出上限（Unicode code point）。 */
const DEFAULT_TOOL_RESULT_LIMIT = 8_000;

/** 太短的首尾窗口继续用旧的尾部截断，保证测试和错误信息稳定。 */
function pruneToolOutput(output: string, maxOutputLength: number): string {
  if (maxOutputLength < 200) {
    return `${output.slice(0, maxOutputLength)}\n... [truncated ${output.length - maxOutputLength} chars]`;
  }
  const marker = '\n\n[... tool result middle pruned ...]\n\n';
  const budget = Math.max(80, maxOutputLength - [...marker].length);
  const headLength = Math.floor(budget * 0.6);
  const tailLength = budget - headLength;
  const codePoints = [...output];
  const head = codePoints.slice(0, headLength).join('');
  const tail = codePoints.slice(-tailLength).join('');
  return `${head}${marker}${tail}`;
}
// 给工具结果 data 追加 truncation 元数据；data 不是对象则包成 { value, truncation }
function withTruncationMetadata(
  data: unknown,
  truncation: { originalLength: number; returnedLength: number; maxOutputLength: number },
): unknown {
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    return { ...(data as Record<string, unknown>), truncation };
  }
  return { value: data, truncation };
}

/** Wrap a promise with a timeout. */
// 给任意 Promise 套上超时控制，超时后 reject 并清理计时器
async function withTimeout<T>(run: () => Promise<T>, ms: number, controller: AbortController): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  let abortFallbackTimer: NodeJS.Timeout | undefined;
  let rejectAfterAbort: ((reason?: unknown) => void) | undefined;
  const abortFallback = new Promise<never>((_, reject) => {
    rejectAfterAbort = reject;
  });
  const beginAbort = (): void => {
    if (abortFallbackTimer || !rejectAfterAbort) return;
    // Give cooperative tools a brief window to release their child process and
    // return their own structured cancellation result before forcing the turn on.
    abortFallbackTimer = setTimeout(() => {
      rejectAfterAbort?.(controller.signal.reason instanceof Error
        ? controller.signal.reason
        : new Error('Tool execution cancelled'));
    }, 250);
  };
  timer = setTimeout(() => {
    controller.abort(new Error(`Tool execution timed out after ${ms}ms`));
  }, ms);
  const onAbort = (): void => beginAbort();
  if (controller.signal.aborted) onAbort();
  else controller.signal.addEventListener('abort', onAbort, { once: true });
  try {
    const execution = Promise.resolve().then(run);
    // The timeout only aborts the derived signal. `abortFallback` protects the
    // runtime from tools that ignore it, without preempting cooperative cleanup.
    return await Promise.race([execution, abortFallback]);
  } finally {
    if (timer) clearTimeout(timer);
    if (abortFallbackTimer) clearTimeout(abortFallbackTimer);
    controller.signal.removeEventListener('abort', onAbort);
  }
}
