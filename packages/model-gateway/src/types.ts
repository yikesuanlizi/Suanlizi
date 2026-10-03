// 引入协议层的多模态输入部件与重试策略
import type { InputPart, RetryPolicy } from '@suanlizi/protocol';

// ─── Model Provider Configuration ───────────────────────────────────────────
// 单个模型配置：完整描述一次模型调用所需的全部参数
// 英文说明：ModelConfig describes the full set of parameters needed for a model call
export interface ModelConfig {
  /** Provider id (e.g. 'deepseek', 'openai', 'ollama'). */
  // 模型提供者 id（例如 'deepseek'、'openai'、'ollama'）
  provider: string;
  /** Base URL override — if empty, resolved from provider registry or env. */
  // 自定义 baseURL；为空时自动从 provider 注册表或环境变量解析
  baseUrl: string;
  /** Model name. */
  // 模型名（例如 gpt-4o、deepseek-chat）
  model: string;
  /** API key override — if empty, resolved from env var or config file. */
  // 显式 API key；为空时从环境变量或 ~/.suanlizi/config.json 解析
  apiKey?: string;
  /** 单次响应最大 token 数 */
  maxTokens?: number;
  /** 采样温度（0-2） */
  temperature?: number;
  /** 核采样参数 */
  topP?: number;
  /** Top-k sampling parameter for providers such as Gitee AI/Qwen. */
  topK?: number;
  /** Frequency penalty passed through to Chat Completions providers. */
  frequencyPenalty?: number;
  /** Presence penalty passed through to Chat Completions providers. */
  presencePenalty?: number;
  /** Provider-specific Chat Completions fields. Values are flattened into the wire body. */
  extraBody?: Record<string, unknown>;
  /** 额外 HTTP header（如自定义网关需要的 token / project） */
  extraHeaders?: Record<string, string>;
  /** 请求超时（毫秒），默认 120000 */
  timeoutMs?: number;
  /** 流式空闲超时（毫秒）：等待下一帧的最大时间，默认 300000。 */
  streamIdleTimeoutMs?: number;
  /** 自定义重试策略（部分覆盖默认） */
  retry?: Partial<RetryPolicy>;
  /** 缓存策略：auto 时按 provider/model 自动推断 */
  cacheStrategy?: CacheStrategy | 'auto';
  /** 推理努力程度（OpenAI o-series、DeepSeek R1 等） */
  reasoningEffort?: 'low' | 'medium' | 'high' | string;
  /** 服务端上下文窗口；llama.cpp 会将其作为请求前的硬上限提示。 */
  contextTokens?: number;
}

// 缓存策略：deepseek-native（原生）/ openai-compatible（带缓存字段）/ anthropic-cache-control / none
export type CacheStrategy =
  | 'deepseek-native'
  | 'openai-compatible'
  | 'anthropic-cache-control'
  | 'none';

// 重试通知：让调用方在重试时拿到状态
export interface ModelRetryNotice {
  attempt: number;        // 当前第几次尝试
  maxAttempts: number;    // 最大尝试次数
  delayMs: number;        // 本次等待毫秒
  status?: number;        // 上次失败的 HTTP 状态码
  error?: string;         // 上次失败原因
}

// 模型请求选项
export interface ModelRequestOptions {
  signal?: AbortSignal;            // 取消信号
  onRetry?: (notice: ModelRetryNotice) => void | Promise<void>;  // 每次重试时回调
  /** llama.cpp request controls. These are opt-in because not every compatible gateway supports them. */
  llama?: {
    idSlot?: number;
    cachePrompt?: boolean;
    returnProgress?: boolean;
    slotEpoch?: string;
  };
}

/**
 * Capability metadata returned by an OpenAI-compatible `/models` endpoint.
 *
 * Providers are not required to expose limits here.  In particular, a
 * reachable endpoint with no limit metadata must not be treated as a guessed
 * 40K window.
 */
export interface OpenAIModelCapabilities {
  provider: string;
  model: string;
  reachable: boolean;
  contextTokens?: number;
  maxOutputTokens?: number;
  error?: string;
}

export interface LlamaCapabilities {
  provider: 'llama_cpp';
  reachable: boolean;
  /** Number of prompt-cache slots reported by llama-server (-np). */
  slotCount?: number;
  /** Effective per-slot context reported by /props.default_generation_settings.n_ctx. */
  contextTokens?: number;
  /** Training context advertised by the loaded model, when exposed by /props. */
  trainingContextTokens?: number;
  /** Build identity exposed by llama-server. */
  buildInfo?: string;
  /** Loaded model path/alias exposed by llama-server, when available. */
  modelPath?: string;
  /** Stable capability epoch used to invalidate leases after endpoint/model changes. */
  epoch?: string;
  chatTemplate?: string;
  hasToolTemplate: boolean;
  hasReasoningTemplate: boolean;
  error?: string;
}

// 上下文 token 估算结果
export interface TokenEstimate {
  inputTokens: number;     // 估算的输入 token
  messageCount: number;    // 消息条数
  imageCount: number;      // 图片数
  charCount: number;       // 字符数
}

/** Which API protocol the provider uses (falls back to 'openai'). */
// 判断 provider 使用哪种协议；只有 anthropic 走独立分支，其它都按 OpenAI 处理
// 英文说明：Anthropic providers use an alternate protocol; everything else falls back to OpenAI
export function protocolFor(provider: string): 'openai' | 'anthropic' {
  return provider === 'anthropic' ? 'anthropic' : 'openai';
}

// ─── Unified Message Types (OpenAI shape, converted for Anthropic internally) ─
// 统一消息类型：以 OpenAI 形态为基准，内部转换给 Anthropic
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | MultimodalContent[];  // 文本或多模态内容
  name?: string;                          // 工具名（部分模型需要）
  tool_calls?: ToolCall[];                // assistant 的工具调用
  tool_call_id?: string;                  // tool 消息对应的工具调用 id
  reasoning_content?: string;             // DeepSeek/Moonshot 等 OpenAI-compatible 推理回放字段
  reasoning_details?: unknown[];          // MiniMax/OpenRouter 等兼容端点的结构化推理字段
  providerFrame?:
    | {
        format: 'openai_chat';
        content: string | null;
        toolCalls?: ToolCall[];
        reasoningContent?: string;
        reasoningDetails?: unknown[];
      }
    | {
        format: 'openai_responses';
        outputItems: unknown[];
      }
    | {
        format: 'anthropic_messages';
        contentBlocks: AnthropicContentBlock[];
      };
}

// 多模态内容：文本或图片
export type MultimodalContent = TextContent | ImageUrlContent;

// 文本片段
export interface TextContent {
  type: 'text';
  text: string;
}

// 图片 URL 片段
export interface ImageUrlContent {
  type: 'image_url';
  image_url: { url: string; detail?: 'low' | 'high' | 'auto' };
}

// 工具调用
export interface ToolCall {
  id: string;                                        // 工具调用 id
  type: 'function';
  function: { name: string; arguments: string };     // 工具名 + JSON 字符串参数
}

// 工具定义（发给模型）
export interface ToolDefinition {
  type: 'function';
  function: { name: string; description: string; parameters: unknown };
}

/** Structured output request shared by Chat Completions and Responses. */
export type ResponseFormat =
  | { type: 'text' }
  | { type: 'json_object' }
  | {
      type: 'json_schema';
      json_schema: {
        name: string;
        description?: string;
        schema: Record<string, unknown>;
        strict?: boolean;
      };
    };

// ─── OpenAI Request / Response ──────────────────────────────────────────────
// OpenAI Chat Completions 请求体
export interface ChatCompletionRequest {
  model: string;
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  tool_choice?: 'auto' | 'none' | 'required' | { type: 'function'; function: { name: string } };
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  top_k?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  /** OpenAI SDK-compatible provider extensions (flattened into the JSON body). */
  extra_body?: Record<string, unknown>;
  reasoning_effort?: 'low' | 'medium' | 'high' | string;
  thinking?: {
    type: 'enabled' | 'disabled';
    reasoning_effort?: 'high' | 'max' | string;
    clear_thinking?: boolean;
  };
  enable_thinking?: boolean;
  parallel_tool_calls?: boolean;
  tool_stream?: boolean;
  id_slot?: number;
  cache_prompt?: boolean;
  return_progress?: boolean;
  stream?: boolean;
  stop?: string[];
  /** Optional structured output contract. Providers may map this to their native shape. */
  response_format?: ResponseFormat;
}

// 归一化后的用量：统一 OpenAI / Anthropic 字段
export interface NormalizedUsage {
  prompt_tokens: number;            // 输入 token
  completion_tokens: number;        // 输出 token
  total_tokens: number;             // 总 token
  cached_tokens?: number;           // 缓存命中 token
  /** Anthropic prompt-cache creation tokens when the provider reports them. */
  cache_creation_tokens?: number;
  /** False means the provider did not report a cache value; it is not a zero hit. */
  cache_reported?: boolean;
  cache_source?: 'deepseek' | 'openai' | 'anthropic' | 'llama-timings';
  cache_strategy?: Exclude<CacheStrategy, 'none'>;
}

// OpenAI Chat Completions 响应
export interface ChatCompletionResponse {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: Choice[];
  usage?: NormalizedUsage;
  timings?: unknown;
}

// 单条回答选项
export interface Choice {
  index: number;
  message: ChatMessage;
  finish_reason: 'stop' | 'length' | 'tool_calls' | 'content_filter' | null;
}

// ─── Anthropic Request / Response ───────────────────────────────────────────
// Anthropic Messages API 请求体
export interface AnthropicMessageRequest {
  model: string;
  system?: string | Array<AnthropicTextBlock>;  // system 提示，可为字符串或带 cache_control 的块
  messages: AnthropicMessage[];
  tools?: AnthropicTool[];
  max_tokens: number;
  temperature?: number;
  top_p?: number;
  thinking?: {
    type: 'adaptive' | 'enabled' | 'disabled' | string;
    budget_tokens?: number;
  };
  stream?: boolean;
  stop_sequences?: string[];
}

// Anthropic 单条消息：只允许 user/assistant 两种角色
export interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: AnthropicContentBlock[];
}

// Anthropic 内容块：text / tool_use / tool_result 三种
export type AnthropicContentBlock =
  | AnthropicTextBlock
  | { type: 'thinking'; thinking: string; signature?: string }
  | { type: 'redacted_thinking'; data: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string };

// Anthropic 文本块，可带 cache_control 走 prompt cache
export interface AnthropicTextBlock {
  type: 'text';
  text: string;
  cache_control?: { type: 'ephemeral' };
}

// Anthropic 工具定义：使用 input_schema 而非 parameters
export interface AnthropicTool {
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

// Anthropic 响应
export interface AnthropicMessageResponse {
  id: string;
  type: 'message';
  role: 'assistant';
  model: string;
  content: AnthropicContentBlock[];
  stop_reason: 'end_turn' | 'max_tokens' | 'tool_use' | 'stop_sequence' | null;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens?: number;       // 缓存读 token
    cache_creation_input_tokens?: number;   // 缓存创建 token
  };
}

// ─── Anthropic Streaming SSE ────────────────────────────────────────────────
// Anthropic 流式 SSE 事件
export interface AnthropicSSEEvent {
  type:
    | 'message_start'        // 消息开始
    | 'content_block_start'  // 内容块开始
    | 'content_block_delta'  // 内容块增量
    | 'content_block_stop'   // 内容块结束
    | 'message_delta'        // 消息元信息增量（含 usage）
    | 'message_stop'         // 消息结束
    | 'ping';                // 心跳
  message?: AnthropicMessageResponse;
  content_block?: AnthropicContentBlock;
  index?: number;
  delta?: {
    type: 'text_delta' | 'input_json_delta' | 'thinking_delta' | 'signature_delta';
    text?: string;
    partial_json?: string;
    thinking?: string;
    signature?: string;
  };
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
}

// ─── Unified Stream Event ───────────────────────────────────────────────────
// 统一流式事件：上层不必区分 OpenAI / Anthropic
export type StreamEvent =
  | { type: 'delta'; content: string }                                           // 文本增量
  | { type: 'reasoning_delta'; content: string }                                 // 推理/思考增量
  | { type: 'prompt_progress'; total?: number; cache?: number; processed?: number; timeMs?: number } // llama.cpp 预填进度
  | { type: 'tool_call_start'; id: string; name: string }                        // 工具调用开始
  | { type: 'tool_call_delta'; id: string; arguments: string }                   // 工具参数增量
  | { type: 'tool_call_end'; id: string; name: string; arguments: string }       // 工具调用结束
  | { type: 'protocol_error'; message: string }                                   // provider 输出了无法解析的工具协议
  | { type: 'done'; usage?: NormalizedUsage }                                    // 流式结束
  | { type: 'error'; error: Error };                                             // 错误

// ─── Helpers ────────────────────────────────────────────────────────────────
// 把协议层的 InputPart 转为统一多模态内容
export function inputPartsToContent(parts: InputPart[]): MultimodalContent[] {
  return parts.map((part) => {
    if (part.type === 'text') return { type: 'text', text: part.text };
    if (part.type === 'image_url') {
      return { type: 'image_url', image_url: { url: part.image_url.url, detail: part.image_url.detail ?? 'auto' } };
    }
    return { type: 'image_url', image_url: { url: `file://${part.path}`, detail: 'auto' } };
  });
}
