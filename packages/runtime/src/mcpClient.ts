import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { terminateProcessTree, type ToolDefinition, type ToolParamSchema, type ToolResult } from '@suanlizi/tools';

// MCP 服务器配置：id、展示名称、命令和参数、是否启用
export interface McpServerConfig {
  id: string;
  name: string;
  command: string;
  args: string;
  enabled: boolean;
}

// MCP 服务器运行状态：disabled / configured / starting / running / failed / dead
export type McpServerRuntimeStatus = 'disabled' | 'configured' | 'starting' | 'running' | 'failed' | 'dead';

// MCP 服务器信息：name / version / title，供 UI 展示
export interface McpServerInfo {
  name?: string;
  version?: string;
  title?: string;
  [key: string]: unknown;
}

// MCP 工具描述：工具名、描述、参数 schema
export interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema?: ToolParamSchema | Record<string, unknown>;
}

// MCP 工具调用结果：内容、结构化内容、是否错误、扩展 meta
export interface McpCallToolResult {
  content: unknown[];
  structuredContent?: unknown;
  isError?: boolean;
  meta?: unknown;
}

// MCP 服务器状态视图：用于对外提供服务发现和健康检查
export interface McpServerStatusView {
  id: string;
  name: string;
  enabled: boolean;
  status: McpServerRuntimeStatus;
  serverInfo?: McpServerInfo;
  error?: string;
  toolCount: number;
  tools: Array<{ name: string; description?: string; namespacedName?: string }>;
  stderr?: string;
}

// 内部 pending 请求：resolve / reject / 超时定时器
interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: NodeJS.Timeout;
}

// 固定超时时间：initialize / list tools / call tool
const INITIALIZE_TIMEOUT_MS = 30_000;
const LIST_TOOLS_TIMEOUT_MS = 10_000;
const TOOL_CALL_TIMEOUT_MS = 60_000;

// MCP stdio 客户端：负责启动子进程、发送 JSON-RPC 2.0 请求、读取响应、调用工具
export class McpStdioClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private buffer = Buffer.alloc(0);
  private nextRequestId = 1;
  private pending = new Map<number, PendingRequest>();
  private runtimeStatus: McpServerRuntimeStatus;
  private lastError: string | undefined;
  private stderrTail = '';
  private toolList: McpToolInfo[] = [];
  private serverInfo: McpServerInfo | undefined;

  constructor(private readonly config: McpServerConfig) {
    this.runtimeStatus = config.enabled ? 'disabled' : 'disabled';
  }

  // 启动 MCP 服务器：spawn 子进程 → initialize → 拉取 tools 列表；任何异常标记为失败并向上抛出
  async start(): Promise<void> {
    if (!this.config.enabled) {
      this.runtimeStatus = 'disabled';
      return;
    }
    if (this.runtimeStatus === 'running') return;

    this.runtimeStatus = 'starting';
    this.lastError = undefined;
    this.stderrTail = '';
    this.toolList = [];
    this.buffer = Buffer.alloc(0);

    try {
      const args = splitArgs(this.config.args);
      this.child = spawn(this.config.command, args, {
        stdio: 'pipe',
        windowsHide: true,
        shell: process.platform === 'win32',
      });

      // 注册 stdout 处理器：按 Content-Length 解析 JSON-RPC 响应
      this.child.stdout.on('data', (chunk: Buffer) => this.onStdout(chunk));
      // 注册 stderr 处理器：保留尾部 4000 字符用于调试
      this.child.stderr.on('data', (chunk: Buffer) => this.onStderr(chunk));
      // 子进程错误事件：标记为 failed
      this.child.on('error', (error) => this.markFailed(error.message));
      // 子进程退出事件：若还在 starting / running 则标记为 dead
      this.child.on('exit', (code, signal) => {
        if (this.runtimeStatus === 'running' || this.runtimeStatus === 'starting') {
          const reason = `MCP server exited${code === null ? '' : ` with code ${code}`}${signal ? ` (${signal})` : ''}`;
          this.markDead(reason);
        }
      });
      // 流错误事件：stdin/stdout/stderr 各自的 error（如 EPIPE）
      // 必须监听，否则未捕获的 'error' 事件会让整个 Node 进程崩溃
      const handleStreamError = (streamName: string) => (error: NodeJS.ErrnoException) => {
        const message = `MCP ${streamName} stream error: ${error.message}`;
        if (this.runtimeStatus === 'running' || this.runtimeStatus === 'starting') {
          this.markDead(message);
        }
      };
      this.child.stdin.on('error', handleStreamError('stdin'));
      this.child.stdout.on('error', handleStreamError('stdout'));
      this.child.stderr.on('error', handleStreamError('stderr'));

      // initialize：协商协议版本和能力
      const initialize = await this.request('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'Suanlizi', version: '0.1.0' },
      }, INITIALIZE_TIMEOUT_MS) as { serverInfo?: McpServerInfo };
      this.serverInfo = initialize.serverInfo;
      // 向服务端发送 initialized 通知，完成握手
      this.notify('notifications/initialized', {});

      // 拉取工具列表并缓存
      const listed = await this.request('tools/list', {}, LIST_TOOLS_TIMEOUT_MS) as { tools?: McpToolInfo[] };
      this.toolList = Array.isArray(listed.tools) ? listed.tools : [];
      this.runtimeStatus = 'running';
    } catch (error) {
      this.markFailed(error instanceof Error ? error.message : String(error));
      await this.stop();
      throw error;
    }
  }

  // 调用工具：当前服务需处于 running 状态；返回规范化的 McpCallToolResult
  async callTool(tool: string, args: Record<string, unknown>, timeoutMs = TOOL_CALL_TIMEOUT_MS): Promise<McpCallToolResult> {
    if (this.runtimeStatus !== 'running') {
      throw new Error(`MCP server ${this.config.name} is ${this.runtimeStatus}`);
    }
    const result = await this.request('tools/call', {
      name: tool,
      arguments: args,
    }, timeoutMs) as Partial<McpCallToolResult>;
    return {
      content: Array.isArray(result.content) ? result.content : [],
      structuredContent: result.structuredContent,
      isError: result.isError,
      meta: result.meta,
    };
  }

  // 返回已缓存的工具列表快照
  tools(): McpToolInfo[] {
    return [...this.toolList];
  }

  // 生成当前服务器的状态视图，供 UI/API 使用
  status(): McpServerStatusView {
    return {
      id: normalizeMcpServerId(this.config.id || this.config.name),
      name: this.config.name,
      enabled: this.config.enabled,
      status: this.runtimeStatus,
      serverInfo: this.serverInfo,
      error: this.lastError,
      toolCount: this.toolList.length,
      tools: this.toolList.map((tool) => ({ name: tool.name, description: tool.description })),
      stderr: this.stderrTail || undefined,
    };
  }

  // 停止 MCP 服务器：清理 pending 请求并杀掉子进程
  async stop(): Promise<void> {
    const child = this.child;
    this.child = null;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('MCP server closed'));
    }
    this.pending.clear();
    if (!child) return;
    terminateProcessTree(child);
  }

  // 发送 JSON-RPC 请求：写入 Content-Length 头 + body，并注册超时定时器
  private request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    const child = this.child;
    if (!child?.stdin.writable) {
      return Promise.reject(new Error('MCP server stdin is not writable'));
    }
    const id = this.nextRequestId++;
    const message = { jsonrpc: '2.0', id, method, params };
    const body = Buffer.from(JSON.stringify(message), 'utf8');
    child.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
    child.stdin.write(body);

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
    });
  }

  // 发送 JSON-RPC 通知（无需等待响应，不注册 pending）
  private notify(method: string, params: unknown): void {
    const child = this.child;
    if (!child?.stdin.writable) return;
    const message = { jsonrpc: '2.0', method, params };
    const body = Buffer.from(JSON.stringify(message), 'utf8');
    child.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
    child.stdin.write(body);
  }

  // stdout 数据处理：累积到 buffer，循环检测并解析完整的 JSON-RPC 消息
  private onStdout(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (true) {
      // 解析 Content-Length 头
      const headerEnd = this.buffer.indexOf('\r\n\r\n');
      if (headerEnd < 0) return;
      const header = this.buffer.slice(0, headerEnd).toString('utf8');
      const match = header.match(/Content-Length:\s*(\d+)/i);
      if (!match) {
        this.markDead('MCP response missing Content-Length header');
        return;
      }
      const length = Number(match[1]);
      const bodyStart = headerEnd + 4;
      const bodyEnd = bodyStart + length;
      if (this.buffer.length < bodyEnd) return;
      const body = this.buffer.slice(bodyStart, bodyEnd).toString('utf8');
      this.buffer = this.buffer.slice(bodyEnd);
      this.handleMessage(body);
    }
  }

  // 解析 JSON-RPC 响应体并路由到对应的 pending 回调
  private handleMessage(body: string): void {
    let message: { id?: number; result?: unknown; error?: { message?: string } };
    try {
      message = JSON.parse(body) as typeof message;
    } catch (error) {
      this.markDead(`Invalid MCP JSON-RPC response: ${String(error)}`);
      return;
    }
    if (typeof message.id !== 'number') return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error) {
      pending.reject(new Error(message.error.message ?? 'MCP JSON-RPC error'));
      return;
    }
    pending.resolve(message.result);
  }

  // stderr 数据处理：保留最近 4000 字符作为调试信息
  private onStderr(chunk: Buffer): void {
    this.stderrTail = (this.stderrTail + chunk.toString('utf8')).slice(-4000);
  }

  // 将状态标记为 failed，并拒绝所有 pending 请求
  private markFailed(message: string): void {
    this.runtimeStatus = 'failed';
    this.lastError = message;
    this.rejectPending(message);
  }

  // 将状态标记为 dead（代表子进程已退出或无法恢复），并拒绝所有 pending 请求
  private markDead(message: string): void {
    this.runtimeStatus = 'dead';
    this.lastError = message;
    this.rejectPending(message);
  }

  // 统一拒绝所有 pending 请求并清理
  private rejectPending(message: string): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(message));
    }
    this.pending.clear();
  }
}

// MCP 运行时管理器：管理多个 McpStdioClient 实例，提供统一的工具定义聚合和状态查询入口
export class McpRuntimeManager {
  private clients = new Map<string, { config: McpServerConfig; client?: McpStdioClient }>();
  private startPromises = new Map<string, Promise<McpStdioClient>>();

  // 应用最新配置列表：删除已移除/变更项；为新增启用项创建 client 并按需启动
  async configure(configs: McpServerConfig[], options: { startEnabled?: boolean } = {}): Promise<void> {
    const startEnabled = options.startEnabled ?? true;
    const normalized = new Map<string, McpServerConfig>();
    for (const config of configs) {
      const id = normalizeMcpServerId(config.id || config.name);
      normalized.set(id, { ...config, id });
    }

    // 清理过期或变更的 client
    for (const [id, entry] of this.clients) {
      if (!normalized.has(id) || JSON.stringify(entry.config) !== JSON.stringify(normalized.get(id))) {
        await entry.client?.stop();
        this.clients.delete(id);
        this.startPromises.delete(id);
      }
    }

    // 为新配置项创建并按需启动 client
    for (const [id, config] of normalized) {
      if (this.clients.has(id)) continue;
      if (!config.enabled) {
        this.clients.set(id, { config });
        continue;
      }
      if (!startEnabled) {
        this.clients.set(id, { config });
        continue;
      }
      const client = new McpStdioClient(config);
      this.clients.set(id, { config, client });
      try {
        await client.start();
      } catch {
        // Status is kept on the client for UI/API inspection.
      }
    }
  }

  // 返回已启动的 MCP 服务器对应的 ToolDefinition 列表
  toolDefinitions(): ToolDefinition[];
  // 返回已启动工具，并为已配置但未启动的 server 暴露懒加载入口
  toolDefinitions(options: { includeConfigured: true; ensureStarted?: false }): ToolDefinition[];
  // 同步确保所有启用的 server 都已启动后返回 ToolDefinition 列表
  toolDefinitions(options: { ensureStarted: true; includeConfigured?: boolean }): Promise<ToolDefinition[]>;
  toolDefinitions(options?: { ensureStarted?: boolean; includeConfigured?: boolean }): ToolDefinition[] | Promise<ToolDefinition[]> {
    if (options?.ensureStarted) {
      return this.ensureStartedToolDefinitions(options);
    }
    return this.startedToolDefinitions(options);
  }

  // 确保所有启用的 server 都已启动后返回工具定义
  private async ensureStartedToolDefinitions(options: { includeConfigured?: boolean } = {}): Promise<ToolDefinition[]> {
    for (const [id, entry] of this.clients) {
      if (!entry.config.enabled || entry.client) continue;
      const client = new McpStdioClient(entry.config);
      this.clients.set(id, { ...entry, client });
      try {
        await client.start();
      } catch {
        // Status is kept on the client for UI/API inspection.
      }
    }
    return this.startedToolDefinitions(options);
  }

  // 聚合 running 状态的 MCP 工具列表：用服务端 id 做命名空间前缀
  private startedToolDefinitions(options: { includeConfigured?: boolean } = {}): ToolDefinition[] {
    const definitions: ToolDefinition[] = options.includeConfigured ? this.configuredLazyToolDefinitions() : [];
    for (const [serverId, entry] of this.clients) {
      const client = entry.client;
      if (!client || client.status().status !== 'running') continue;
      for (const tool of client.tools()) {
        const toolName = normalizeMcpToolName(tool.name);
        const namespacedName = mcpNamespacedToolName(serverId, toolName);
        definitions.push({
          name: namespacedName,
          description: tool.description
            ? `${entry.config.name}: ${tool.description}`
            : `MCP tool ${entry.config.name}: ${tool.name}`,
          parameters: normalizeToolSchema(tool.inputSchema),
          requiredPolicy: 'readonly',
          requiresApproval: false,
          timeoutMs: TOOL_CALL_TIMEOUT_MS,
          maxOutputLength: 30_000,
          execute: async (args) => {
            const result = await this.callServerTool(serverId, tool.name, args);
            return mcpResultToToolResult(result);
          },
        });
      }
    }
    return definitions;
  }

  // 为已配置的 server 暴露轻量懒加载工具；真正的 MCP 进程只在这些工具执行时启动。
  private configuredLazyToolDefinitions(): ToolDefinition[] {
    const definitions: ToolDefinition[] = [];
    for (const [serverId, entry] of this.clients) {
      if (!entry.config.enabled) continue;
      const listToolName = mcpNamespacedToolName(serverId, 'mcp_list_tools');
      const callToolName = mcpNamespacedToolName(serverId, 'mcp_call_tool');
      definitions.push({
        name: listToolName,
        description: `Start MCP server ${entry.config.name} if needed and list its available tools.`,
        parameters: {
          type: 'object',
          properties: {},
          additionalProperties: false,
        },
        requiredPolicy: 'readonly',
        requiresApproval: false,
        timeoutMs: TOOL_CALL_TIMEOUT_MS,
        maxOutputLength: 30_000,
        execute: async () => {
          const client = await this.ensureClientStarted(serverId);
          const tools = client.tools().map((tool) => ({
            name: tool.name,
            namespacedName: mcpNamespacedToolName(serverId, normalizeMcpToolName(tool.name)),
            description: tool.description,
            inputSchema: tool.inputSchema,
          }));
          return {
            status: 'completed',
            output: JSON.stringify({
              server: serverId,
              serverName: entry.config.name,
              tools,
            }, null, 2),
            data: { server: serverId, tools },
          };
        },
      });
      definitions.push({
        name: callToolName,
        description: `Start MCP server ${entry.config.name} if needed and call one of its tools by name.`,
        parameters: {
          type: 'object',
          properties: {
            tool: {
              type: 'string',
              description: 'Raw MCP tool name to call. Use mcp_list_tools first if unsure.',
            },
            arguments: {
              type: 'object',
              description: 'Arguments object passed through to the MCP tool.',
              additionalProperties: true,
            },
          },
          required: ['tool'],
          additionalProperties: false,
        },
        requiredPolicy: 'readonly',
        requiresApproval: false,
        timeoutMs: TOOL_CALL_TIMEOUT_MS,
        maxOutputLength: 30_000,
        execute: async (args) => {
          const requestedTool = typeof args.tool === 'string' ? args.tool.trim() : '';
          if (!requestedTool) {
            return {
              status: 'failed',
              output: 'MCP tool name is required.',
              error: { message: 'MCP tool name is required', code: 'MCP_TOOL_REQUIRED' },
            };
          }
          const client = await this.ensureClientStarted(serverId);
          const matched = client.tools().find((tool) => (
            tool.name === requestedTool || normalizeMcpToolName(tool.name) === requestedTool
          ));
          if (!matched) {
            return {
              status: 'failed',
              output: `Unknown MCP tool "${requestedTool}" on server "${serverId}".`,
              error: { message: `Unknown MCP tool "${requestedTool}" on server "${serverId}"`, code: 'UNKNOWN_MCP_TOOL' },
              data: { server: serverId, requestedTool, availableTools: client.tools().map((tool) => tool.name) },
            };
          }
          const toolArgs = args.arguments && typeof args.arguments === 'object' && !Array.isArray(args.arguments)
            ? args.arguments as Record<string, unknown>
            : {};
          const result = await this.callServerTool(serverId, matched.name, toolArgs);
          return mcpResultToToolResult(result);
        },
      });
    }
    return definitions;
  }

  // 按 server 懒启动 client；失败只污染当前 server 的状态，不影响其他 server。
  // 使用 startPromises 做并发保护：多个请求同时触发启动时共享同一个启动 Promise。
  private async ensureClientStarted(serverId: string): Promise<McpStdioClient> {
    const entry = this.clients.get(serverId);
    if (!entry) {
      throw new Error(`Unknown MCP server "${serverId}"`);
    }
    if (!entry.config.enabled) {
      throw new Error(`MCP server "${serverId}" is disabled`);
    }
    if (entry.client?.status().status === 'running') {
      return entry.client;
    }
    // 如果已有正在进行的启动，直接复用
    const existing = this.startPromises.get(serverId);
    if (existing) return existing;

    const promise = (async () => {
      try {
        const currentEntry = this.clients.get(serverId);
        if (!currentEntry) throw new Error(`Unknown MCP server "${serverId}"`);
        if (currentEntry.client?.status().status === 'running') return currentEntry.client;
        if (currentEntry.client) {
          await currentEntry.client.stop();
        }
        const client = new McpStdioClient(currentEntry.config);
        this.clients.set(serverId, { ...currentEntry, client });
        await client.start();
        return client;
      } finally {
        this.startPromises.delete(serverId);
      }
    })();

    this.startPromises.set(serverId, promise);
    return promise;
  }

  private async callServerTool(
    serverId: string,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<McpCallToolResult> {
    const client = await this.ensureClientStarted(serverId);
    return client.callTool(toolName, args, TOOL_CALL_TIMEOUT_MS);
  }

  // 调用指定 MCP server 的工具（自动启动 server）
  async callTool(serverId: string, toolName: string, args: Record<string, unknown> = {}): Promise<McpCallToolResult> {
    return this.callServerTool(serverId, toolName, args);
  }

  // 返回所有 server 的状态视图列表
  statuses(): McpServerStatusView[] {
    return [...this.clients.entries()].map(([serverId, entry]) => {
      if (!entry.client) {
        return {
          id: serverId,
          name: entry.config.name,
          enabled: entry.config.enabled,
          status: entry.config.enabled ? 'configured' : 'disabled',
          toolCount: 0,
          tools: [],
        };
      }
      const status = entry.client.status();
      return {
        ...status,
        id: serverId,
        tools: status.tools.map((tool) => ({
          ...tool,
          namespacedName: mcpNamespacedToolName(serverId, normalizeMcpToolName(tool.name)),
        })),
      };
    });
  }

  // 停止并清理所有 MCP client
  async shutdown(): Promise<void> {
    for (const entry of this.clients.values()) {
      await entry.client?.stop();
    }
    this.clients.clear();
    this.startPromises.clear();
  }
}

// 规范化 MCP 服务器 id：小写 + 仅保留字母、数字、下划线、短横线
export function normalizeMcpServerId(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    || 'mcp-server';
}

// 规范化工具名：仅保留字母、数字、下划线、短横线（避免跨平台命名冲突）
export function normalizeMcpToolName(value: string): string {
  return value
    .replace(/[^a-zA-Z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    || 'tool';
}

// 生成带命名空间前缀的工具名：mcp__<serverId>__<toolName>
export function mcpNamespacedToolName(serverId: string, toolName: string): string {
  return `mcp__${normalizeMcpServerId(serverId)}__${normalizeMcpToolName(toolName)}`;
}

// 将命名空间工具名还原为展示名：serverId: toolName
export function mcpToolDisplayName(namespacedName: string): string {
  const identity = parseMcpNamespacedToolName(namespacedName);
  return identity ? `${identity.serverId}: ${identity.toolName}` : namespacedName;
}

// 解析命名空间工具名：匹配 mcp__<x>__<y> 格式，解析失败返回 null
export function parseMcpNamespacedToolName(name: string): { serverId: string; toolName: string } | null {
  const match = /^mcp__([^_].*?)__(.+)$/.exec(name);
  if (!match) return null;
  return { serverId: match[1], toolName: match[2] };
}

// 将 MCP 工具调用结果转换成通用 ToolResult 格式：优先提取 text 字段，否则使用原字符串或 JSON 化
function mcpResultToToolResult(result: McpCallToolResult): ToolResult {
  const output = result.content
    .map((part) => {
      if (part && typeof part === 'object' && 'text' in part) {
        return String((part as { text?: unknown }).text ?? '');
      }
      return typeof part === 'string' ? part : JSON.stringify(part);
    })
    .filter(Boolean)
    .join('\n');
  return {
    output: output || JSON.stringify(result),
    data: {
      content: result.content,
      structuredContent: result.structuredContent,
      isError: result.isError,
      meta: result.meta,
    },
    status: result.isError ? 'failed' : 'completed',
    error: result.isError ? { message: output || 'MCP tool returned an error' } : undefined,
  };
}

// 规范化工具 schema：若缺失或非法则返回允许任意键的 object schema
function normalizeToolSchema(schema: McpToolInfo['inputSchema']): ToolParamSchema {
  if (!schema || typeof schema !== 'object') {
    return { type: 'object', properties: {}, additionalProperties: true };
  }
  const candidate = schema as ToolParamSchema;
  return {
    type: typeof candidate.type === 'string' ? candidate.type : 'object',
    description: candidate.description,
    properties: candidate.properties,
    required: candidate.required,
    additionalProperties: candidate.additionalProperties,
    enum: candidate.enum,
    items: candidate.items,
  };
}

// 将参数字符串按空白切分为数组：支持双引号和单引号分组
export function splitArgs(input: string): string[] {
  const args: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  for (const char of input.trim()) {
    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        args.push(current);
        current = '';
      }
      continue;
    }
    current += char;
  }
  if (current) args.push(current);
  return args;
}
