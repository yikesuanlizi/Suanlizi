import type {
  CacheStrategy,
  ChatCompletionRequest,
  ChatCompletionResponse,
  ChatMessage,
  ModelConfig,
  ModelRequestOptions,
  NormalizedUsage,
  StreamEvent,
  ToolCall,
} from './types.js';

export interface ResponsesTextPart {
  type: 'input_text';
  text: string;
}

export interface ResponsesImagePart {
  type: 'input_image';
  image_url: string;
  detail?: 'low' | 'high' | 'auto';
}

export type ResponsesMessageContent = string | Array<ResponsesTextPart | ResponsesImagePart>;

export interface ResponsesMessageInput {
  type: 'message';
  role: 'system' | 'developer' | 'user' | 'assistant';
  content: ResponsesMessageContent;
  name?: string;
}

export interface ResponsesFunctionCallInput {
  type: 'function_call';
  call_id: string;
  name: string;
  arguments: string;
}

export interface ResponsesFunctionCallOutputInput {
  type: 'function_call_output';
  call_id: string;
  output: string;
}

export interface ResponsesReasoningInput {
  type: 'reasoning';
  summary: Array<{ type: 'summary_text'; text: string }>;
  /** llama.cpp requires a non-empty content array when replaying reasoning. */
  content?: Array<{ type: 'input_text'; text: string }>;
}

export type ResponsesInputItem =
  | ResponsesMessageInput
  | ResponsesFunctionCallInput
  | ResponsesFunctionCallOutputInput
  | ResponsesReasoningInput
  | Record<string, unknown>;

export interface ResponsesFunctionTool {
  type: 'function';
  name: string;
  description?: string;
  parameters?: unknown;
  strict?: boolean;
}

export interface ResponsesRequest {
  model: string;
  input: ResponsesInputItem[];
  tools?: ResponsesFunctionTool[];
  tool_choice?: 'auto' | 'none' | 'required' | { type: 'function'; name: string } | Record<string, unknown>;
  max_output_tokens?: number;
  temperature?: number;
  top_p?: number;
  reasoning?: { effort: string };
  parallel_tool_calls?: boolean;
  stream?: boolean;
  text?: { format: Record<string, unknown> };
  stop?: string[];
  /** llama.cpp Responses-to-Chat 适配器接受的专用控制字段。 */
  id_slot?: number;
  cache_prompt?: boolean;
  return_progress?: boolean;
}

/**
 * Estimate final Responses input without serialising image URLs; structured
 * reasoning and tool output items remain included.
 */
export function estimateResponsesInputTokens(
  request: Pick<ResponsesRequest, 'input' | 'tools' | 'max_output_tokens'>,
): number {
  const inputTokens = estimateResponsesValueTokens(request.input);
  const toolTokens = request.tools?.length ? estimateResponsesValueTokens(request.tools) : 0;
  return Math.max(1, inputTokens + toolTokens + Math.max(0, request.max_output_tokens ?? 0));
}

type UnknownRecord = Record<string, unknown>;

/** 把统一消息转换为 Responses API 的 input 项。 */
export function buildResponsesRequest(
  req: Omit<ChatCompletionRequest, 'model' | 'stream'>,
  config: Pick<ModelConfig, 'model' | 'maxTokens' | 'temperature' | 'topP' | 'reasoningEffort'> & { provider?: string },
  options?: ModelRequestOptions,
  stream = false,
): ResponsesRequest {
  const input: ResponsesInputItem[] = [];
  const includeLlamaReasoningContent = isLlamaCppProvider(config.provider);
  for (const message of req.messages ?? []) {
    appendMessageInput(input, message, includeLlamaReasoningContent);
  }

  const body: ResponsesRequest = {
    model: config.model,
    input,
    max_output_tokens: req.max_tokens ?? config.maxTokens,
    temperature: req.temperature ?? config.temperature,
    top_p: req.top_p ?? config.topP,
    stream,
  };

  // 原生 Responses 没有 Chat 的 stop 字段；仅本地兼容服务需要转发它。
  if (req.stop?.length && ['llama_cpp', 'llama.cpp', 'llama-cpp', 'ollama', 'lmstudio', 'vllm'].includes(config.provider ?? '')) body.stop = req.stop;
  if (options?.llama) {
    if (Number.isInteger(options.llama.idSlot) && (options.llama.idSlot ?? -1) >= 0) body.id_slot = options.llama.idSlot;
    if (options.llama.cachePrompt !== undefined) body.cache_prompt = options.llama.cachePrompt;
    if (options.llama.returnProgress !== undefined) body.return_progress = options.llama.returnProgress;
  }

  if (req.tools?.length) {
    body.tools = req.tools.map((tool) => {
      const source = tool as typeof tool & { function: typeof tool.function & { strict?: boolean } };
      return {
        type: 'function' as const,
        name: source.function.name,
        description: source.function.description,
        parameters: source.function.parameters,
        ...(typeof source.function.strict === 'boolean' ? { strict: source.function.strict } : {}),
      };
    });
  }

  if (req.tool_choice !== undefined) {
    body.tool_choice = convertToolChoice(req.tool_choice);
  }
  if (req.parallel_tool_calls !== undefined) body.parallel_tool_calls = req.parallel_tool_calls;

  const effort = normalizeReasoningEffort(req.reasoning_effort ?? config.reasoningEffort);
  if (effort) body.reasoning = { effort };

  const source = req as unknown as ChatCompletionRequest & UnknownRecord;
  const responseFormat = source.response_format;
  if (responseFormat && typeof responseFormat === 'object' && !Array.isArray(responseFormat)) {
    const format = convertResponseFormat(responseFormat as UnknownRecord);
    if (format) body.text = { format };
  }
  return omitUndefined(body);
}

/** 将 Responses JSON 响应归一化为网关现有的 ChatCompletionResponse。 */
export function normalizeResponsesResponse(
  raw: unknown,
  model: string,
  cacheStrategy?: CacheStrategy,
): ChatCompletionResponse {
  const response = asRecord(raw) ?? {};
  const output = Array.isArray(response.output) ? response.output : [];
  const extracted = extractOutput(output);
  const fallbackText = typeof response.output_text === 'string' ? response.output_text : '';
  const content = extracted.text || fallbackText;
  const responseModel = typeof response.model === 'string' && response.model ? response.model : model;
  const toolCalls = extracted.toolCalls;
  const status = typeof response.status === 'string' ? response.status : undefined;
  const finishReason = resolveFinishReason(status, toolCalls.length, response);
  const message: ChatMessage = {
    role: 'assistant',
    content,
    ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
    ...(extracted.reasoning ? { reasoning_content: extracted.reasoning } : {}),
  };
  const usage = normalizeResponsesUsage(
    response.usage,
    cacheStrategy,
    asRecord(response.timings),
  );
  return {
    id: typeof response.id === 'string' && response.id ? response.id : `response_${Date.now()}`,
    object: 'chat.completion',
    created: numberOr(response.created_at, numberOr(response.created, Math.floor(Date.now() / 1000))),
    model: responseModel,
    choices: [{ index: 0, message, finish_reason: finishReason }],
    ...(usage ? { usage } : {}),
  };
}

/** 兼容调用方使用更直观的转换名称。 */
export const responsesResponseToChatCompletion = normalizeResponsesResponse;

/** 解析 Responses API 的事件式 SSE，并输出网关统一的流事件。 */
export async function* parseResponsesStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  cacheStrategy?: CacheStrategy,
): AsyncGenerator<StreamEvent> {
  const decoder = new TextDecoder();
  let buffer = '';
  let eventName = '';
  let dataLines: string[] = [];
  let doneEmitted = false;
  let streamErrorEmitted = false;
  let terminalEventReceived = false;
  let finalUsage: NormalizedUsage | undefined;
  const toolCalls = new Map<string, StreamToolState>();
  const textSeen = new Map<string, string>();
  const reasoningSeen = new Map<string, string>();

  const emitDone = (): StreamEvent[] => {
    if (doneEmitted) return [];
    doneEmitted = true;
    const events: StreamEvent[] = [];
    for (const call of toolCalls.values()) {
      if (!call.ended) {
        call.ended = true;
        events.push({ type: 'tool_call_end', id: call.id, name: call.name, arguments: call.arguments });
      }
    }
    events.push({ type: 'done', ...(finalUsage ? { usage: finalUsage } : {}) });
    return events;
  };

  const processRecord = (name: string, data: string): StreamEvent[] => {
    if (doneEmitted || streamErrorEmitted || !data.trim()) return [];
    if (data.trim() === '[DONE]') {
      terminalEventReceived = true;
      return emitDone();
    }
    let payload: UnknownRecord;
    try {
      const parsed: unknown = JSON.parse(data);
      payload = asRecord(parsed) ?? {};
    } catch {
      return [];
    }

    const type = typeof payload.type === 'string' ? payload.type : name;
    const events: StreamEvent[] = [];
    const providerError = readProviderError(payload, type);
    if (providerError) {
      if (type === 'response.failed') terminalEventReceived = true;
      streamErrorEmitted = true;
      events.push({ type: 'error', error: new Error(providerError) });
      return events;
    }

    if (type === 'response.completed' || type === 'response.incomplete') {
      terminalEventReceived = true;
      const response = asRecord(payload.response) ?? payload;
      finalUsage = normalizeResponsesUsage(response.usage, cacheStrategy, asRecord(response.timings));
      events.push(...emitMissingOutput(response.output));
      events.push(...emitDone());
      return events;
    }

    if (type === 'response.output_text.delta') {
      const delta = stringValue(payload.delta);
      if (delta) {
        const key = stringValue(payload.item_id) || 'output_text';
        textSeen.set(key, (textSeen.get(key) ?? '') + delta);
        events.push({ type: 'delta', content: delta });
      }
      return events;
    }

    if (type === 'response.output_text.done') {
      events.push(...emitTextIfMissing(stringValue(payload.text), stringValue(payload.item_id) || 'output_text', textSeen));
      return events;
    }

    if (type === 'response.refusal.delta') {
      const delta = stringValue(payload.delta);
      if (delta) events.push({ type: 'delta', content: delta });
      return events;
    }

    if (isReasoningDoneType(type)) {
      const key = stringValue(payload.item_id) || 'reasoning';
      const completeText = stringValue(payload.text);
      if (completeText) events.push(...emitReasoningIfMissing(completeText, key, reasoningSeen));
      return events;
    }

    if (isReasoningDeltaType(type)) {
      const delta = stringValue(payload.delta) || stringValue(payload.text);
      if (delta) {
        const key = stringValue(payload.item_id) || 'reasoning';
        reasoningSeen.set(key, (reasoningSeen.get(key) ?? '') + delta);
        events.push({ type: 'reasoning_delta', content: delta });
      }
      return events;
    }

    if (type === 'response.function_call_arguments.delta') {
      const call = ensureStreamTool(toolCalls, payload);
      const delta = stringValue(payload.delta);
      if (call && delta) {
        call.arguments += delta;
        events.push(...startToolIfNeeded(call));
        events.push({ type: 'tool_call_delta', id: call.id, arguments: call.arguments });
      }
      return events;
    }

    if (type === 'response.function_call_arguments.done') {
      const call = ensureStreamTool(toolCalls, payload);
      const argumentsText = stringValue(payload.arguments);
      if (call) {
        events.push(...startToolIfNeeded(call));
        if (argumentsText && argumentsText !== call.arguments) {
          call.arguments = argumentsText;
          events.push({ type: 'tool_call_delta', id: call.id, arguments: call.arguments });
        }
        events.push(...endTool(call));
      }
      return events;
    }

    if (type === 'response.output_item.added' || type === 'response.output_item.done') {
      const item = asRecord(payload.item);
      if (item) events.push(...emitOutputItem(item, payload, toolCalls, textSeen, reasoningSeen));
      return events;
    }

    return events;
  };

  const emitRecord = function* (): Generator<StreamEvent> {
    if (dataLines.length === 0) {
      eventName = '';
      return;
    }
    yield* processRecord(eventName, dataLines.join('\n'));
    eventName = '';
    dataLines = [];
  };

  const consumeLine = function* (line: string): Generator<StreamEvent> {
    const trimmed = line.trimEnd();
    if (!trimmed) {
      yield* emitRecord();
    } else if (trimmed.startsWith(':')) {
      return;
    } else if (trimmed.startsWith('event:')) {
      eventName = trimmed.slice(6).trim();
    } else if (trimmed.startsWith('data:')) {
      dataLines.push(trimmed.slice(5).trimStart());
    }
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? '';
      for (const line of lines) yield* consumeLine(line);
    }
    buffer += decoder.decode();
    if (buffer) {
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? '';
      for (const line of lines) yield* consumeLine(line);
      if (buffer) yield* consumeLine(buffer);
    }
    yield* emitRecord();
    if (!doneEmitted && !streamErrorEmitted && !terminalEventReceived) {
      streamErrorEmitted = true;
      yield { type: 'error', error: new Error('Responses stream ended before a terminal event was received.') };
    }
  } catch (error) {
    if (!doneEmitted && !streamErrorEmitted) {
      yield { type: 'error', error: error instanceof Error ? error : new Error(String(error)) };
    }
  } finally {
    reader.releaseLock();
  }

  function emitMissingOutput(output: unknown): StreamEvent[] {
    if (!Array.isArray(output)) return [];
    const events: StreamEvent[] = [];
    output.forEach((value, index) => {
      const item = asRecord(value);
      if (item) events.push(...emitOutputItem(item, { output_index: index }, toolCalls, textSeen, reasoningSeen, true));
    });
    return events;
  }
}

interface StreamToolState {
  id: string;
  name: string;
  arguments: string;
  started: boolean;
  ended: boolean;
}

function appendMessageInput(input: ResponsesInputItem[], message: ChatMessage, includeLlamaReasoningContent = false): void {
  const providerFrame = (message as unknown as { providerFrame?: unknown }).providerFrame;
  if (message.role === 'assistant' && isResponsesFrame(providerFrame)) {
    input.push(...providerFrame.outputItems.filter((item): item is Record<string, unknown> => Boolean(asRecord(item))));
    return;
  }

  if (message.role === 'tool') {
    if (message.tool_call_id) {
      input.push({
        type: 'function_call_output',
        call_id: message.tool_call_id,
        output: contentToText(message.content),
      });
    }
    return;
  }

  const content = toResponsesContent(message.content);
  if (message.role === 'assistant' && message.reasoning_content?.trim()) {
    const reasoningText = message.reasoning_content;
    input.push({
      type: 'reasoning',
      summary: [{ type: 'summary_text', text: reasoningText }],
      ...(includeLlamaReasoningContent ? { content: [{ type: 'input_text' as const, text: reasoningText }] } : {}),
    });
  }
  if (content !== '' || !message.tool_calls?.length) {
    input.push({
      type: 'message',
      role: message.role,
      content,
      ...(message.name ? { name: message.name } : {}),
    });
  }
  if (message.tool_calls?.length) {
    for (const toolCall of message.tool_calls) {
      input.push({
        type: 'function_call',
        call_id: toolCall.id,
        name: toolCall.function.name,
        arguments: toolCall.function.arguments,
      });
    }
  }
}

function isLlamaCppProvider(provider: string | undefined): boolean {
  const normalized = provider?.trim().toLowerCase();
  return normalized === 'llama_cpp' || normalized === 'llama.cpp' || normalized === 'llama-cpp' || normalized === 'llamacpp';
}

function toResponsesContent(content: ChatMessage['content']): ResponsesMessageContent {
  if (typeof content === 'string') return content;
  return content.map((part) => part.type === 'text'
    ? { type: 'input_text' as const, text: part.text }
    : {
        type: 'input_image' as const,
        image_url: part.image_url.url,
        ...(part.image_url.detail ? { detail: part.image_url.detail } : {}),
      });
}

function contentToText(content: ChatMessage['content']): string {
  return typeof content === 'string' ? content : content.map((part) => part.type === 'text' ? part.text : `[Image: ${part.image_url.url}]`).join('\n');
}

function isResponsesFrame(value: unknown): value is { format: 'openai_responses'; outputItems: unknown[] } {
  return Boolean(asRecord(value)?.format === 'openai_responses' && Array.isArray(asRecord(value)?.outputItems));
}

function convertToolChoice(value: NonNullable<ChatCompletionRequest['tool_choice']>): ResponsesRequest['tool_choice'] {
  if (typeof value === 'string') return value;
  const functionName = asRecord(value.function)?.name;
  return typeof functionName === 'string' ? { type: 'function', name: functionName } : { ...value };
}

function convertResponseFormat(value: UnknownRecord): Record<string, unknown> | undefined {
  const type = typeof value.type === 'string' ? value.type : undefined;
  if (!type) return undefined;
  if (type === 'json_schema') {
    const schema = asRecord(value.json_schema);
    if (!schema) return { type };
    return {
      type,
      ...(typeof schema.name === 'string' ? { name: schema.name } : {}),
      ...(typeof schema.description === 'string' ? { description: schema.description } : {}),
      ...(schema.schema !== undefined ? { schema: schema.schema } : {}),
      ...(typeof schema.strict === 'boolean' ? { strict: schema.strict } : {}),
    };
  }
  return { type };
}

function normalizeReasoningEffort(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const effort = value.trim().toLowerCase();
  if (!effort || ['no', 'low', 'none', 'off', 'disabled', 'disable', 'false', 'minimal'].includes(effort)) return undefined;
  if (effort === 'ultra' || effort === 'maximum') return 'max';
  if (effort === 'x-high' || effort === 'x_high') return 'xhigh';
  return effort;
}

function extractOutput(output: unknown[]): { text: string; reasoning: string; toolCalls: ToolCall[] } {
  const texts: string[] = [];
  const reasoning: string[] = [];
  const toolCalls: ToolCall[] = [];
  for (const value of output) {
    const item = asRecord(value);
    if (!item) continue;
    const type = stringValue(item.type);
    if (type === 'function_call' || type === 'custom_tool_call') {
      const id = stringValue(item.call_id) || stringValue(item.id) || `tool_${toolCalls.length}`;
      const name = stringValue(item.name) || 'unknown';
      const args = argumentsValue(item.arguments, item.input) || '{}';
      toolCalls.push({ id, type: 'function', function: { name, arguments: args } });
      continue;
    }
    if (type === 'reasoning') {
      reasoning.push(...extractReasoningText(item.summary));
      continue;
    }
    if (type === 'message') {
      const content = item.content;
      if (typeof content === 'string') texts.push(content);
      else if (Array.isArray(content)) {
        for (const part of content) {
          const record = asRecord(part);
          if (!record) continue;
          if (typeof record.text === 'string' && (record.type === undefined || record.type === 'output_text' || record.type === 'text')) texts.push(record.text);
          if (record.type === 'refusal' && typeof record.refusal === 'string') texts.push(record.refusal);
        }
      }
      continue;
    }
    if ((type === 'output_text' || type === 'text') && typeof item.text === 'string') texts.push(item.text);
  }
  return { text: texts.join(''), reasoning: reasoning.join(''), toolCalls };
}

function extractReasoningText(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((part) => {
    const record = asRecord(part);
    return record && typeof record.text === 'string' ? [record.text] : [];
  });
}

function resolveFinishReason(status: string | undefined, toolCount: number, response: UnknownRecord): 'stop' | 'length' | 'tool_calls' | 'content_filter' | null {
  if (toolCount) return 'tool_calls';
  const incompleteReason = stringValue(asRecord(response.incomplete_details)?.reason);
  if (status === 'incomplete' && incompleteReason === 'max_output_tokens') return 'length';
  if (status === 'incomplete' && incompleteReason === 'content_filter') return 'content_filter';
  if (status === 'failed') return 'content_filter';
  if (status === 'in_progress' || status === 'queued') return null;
  return 'stop';
}

function normalizeResponsesUsage(
  raw: unknown,
  cacheStrategy?: CacheStrategy,
  fallbackTimings?: UnknownRecord,
): NormalizedUsage | undefined {
  const usage = asRecord(raw);
  const source = usage ?? (fallbackTimings ? { timings: fallbackTimings } : undefined);
  if (!source) return undefined;
  const timings = asRecord(source.timings) ?? fallbackTimings;
  const details = asRecord(source.input_tokens_details);
  const promptDetails = asRecord(source.prompt_tokens_details);
  const deepseekHit = firstNumber(source.prompt_cache_hit_tokens);
  const deepseekMiss = firstNumber(source.prompt_cache_miss_tokens);
  const deepseekReported = deepseekHit !== undefined || deepseekMiss !== undefined;
  const llamaCache = firstNumber(timings?.cache_n, source.cache_n);
  const llamaPrompt = firstNumber(timings?.prompt_n, source.prompt_n);
  const cachedValue = deepseekReported
    ? deepseekHit ?? 0
    : firstNumber(
      details?.cached_tokens,
      source.cached_tokens,
      promptDetails?.cached_tokens,
      llamaCache,
    );
  const inputTokens = deepseekReported
    ? (deepseekHit ?? 0) + (deepseekMiss ?? 0)
    : firstNumber(source.input_tokens, source.prompt_tokens)
      ?? (llamaPrompt !== undefined ? llamaPrompt + (llamaCache ?? 0) : 0);
  const outputTokens = firstNumber(source.output_tokens, source.completion_tokens) ?? 0;
  const totalTokens = firstNumber(source.total_tokens) ?? inputTokens + outputTokens;
  // The selected strategy is authoritative for native DeepSeek Responses.
  // Some responses report input/output counts without exposing hit/miss
  // fields, but must still retain the provider identity for usage consumers.
  const cacheSource = cacheStrategy === 'deepseek-native'
    ? 'deepseek' as const
    : llamaCache !== undefined
    ? 'llama-timings' as const
    : deepseekReported
      ? 'deepseek' as const
      : cachedValue === undefined ? undefined : 'openai' as const;
  const result: NormalizedUsage = {
    prompt_tokens: inputTokens,
    completion_tokens: outputTokens,
    total_tokens: totalTokens,
    cached_tokens: cachedValue ?? 0,
    ...(cachedValue === undefined
      ? { cache_reported: false, ...(cacheSource ? { cache_source: cacheSource } : {}) }
      : { cache_reported: true, ...(cacheSource ? { cache_source: cacheSource } : {}) }),
    ...(cacheStrategy && cacheStrategy !== 'none' ? { cache_strategy: cacheStrategy } : {}),
  };
  return result;
}

function emitOutputItem(
  item: UnknownRecord,
  envelope: UnknownRecord,
  toolCalls: Map<string, StreamToolState>,
  textSeen: Map<string, string>,
  reasoningSeen: Map<string, string>,
  includeCompleted = false,
): StreamEvent[] {
  const events: StreamEvent[] = [];
  const type = stringValue(item.type);
  const key = stringValue(item.id)
    || stringValue(envelope.item_id)
    || (textSeen.has('output_text') ? 'output_text' : `output_${stringValue(envelope.output_index) || '0'}`);
  if (type === 'function_call' || type === 'custom_tool_call') {
    const call = ensureStreamTool(toolCalls, { ...envelope, ...item });
    if (!call) return events;
    events.push(...startToolIfNeeded(call));
    const argumentsText = argumentsValue(item.arguments, item.input);
    if (argumentsText && argumentsText !== call.arguments) {
      call.arguments = argumentsText;
      events.push({ type: 'tool_call_delta', id: call.id, arguments: call.arguments });
    }
    if (includeCompleted || type === 'custom_tool_call') events.push(...endTool(call));
    return events;
  }
  if (type === 'message') {
    const content = item.content;
    if (Array.isArray(content)) {
      for (const part of content) {
        const record = asRecord(part);
        if (record && typeof record.text === 'string' && (record.type === undefined || record.type === 'output_text' || record.type === 'text')) {
          events.push(...emitTextIfMissing(record.text, stringValue(record.id) || key, textSeen));
        }
      }
    } else if (typeof content === 'string') {
      events.push(...emitTextIfMissing(content, key, textSeen));
    }
  } else if (type === 'output_text' || type === 'text') {
    events.push(...emitTextIfMissing(stringValue(item.text), key, textSeen));
  } else if (type === 'reasoning') {
    for (const text of extractReasoningText(item.summary)) {
      events.push(...emitReasoningIfMissing(text, key, reasoningSeen));
    }
  }
  return events;
}

function emitTextIfMissing(text: string, key: string, seen: Map<string, string>): StreamEvent[] {
  if (!text) return [];
  const previous = seen.get(key) ?? '';
  if (text === previous) return [];
  const suffix = text.startsWith(previous) ? text.slice(previous.length) : text;
  seen.set(key, text);
  return suffix ? [{ type: 'delta', content: suffix }] : [];
}

function emitReasoningIfMissing(text: string, key: string, seen: Map<string, string>): StreamEvent[] {
  if (!text) return [];
  const previous = seen.get(key) ?? '';
  if (text === previous) return [];
  const suffix = text.startsWith(previous) ? text.slice(previous.length) : text;
  seen.set(key, text);
  return suffix ? [{ type: 'reasoning_delta', content: suffix }] : [];
}

function ensureStreamTool(map: Map<string, StreamToolState>, payload: UnknownRecord): StreamToolState | undefined {
  const key = stringValue(payload.item_id) || stringValue(payload.id) || stringValue(payload.call_id) || `tool_${stringValue(payload.output_index) || map.size}`;
  let call = map.get(key);
  if (!call) {
    call = {
      id: stringValue(payload.call_id) || stringValue(payload.id) || `tool_${stringValue(payload.output_index) || map.size}`,
      name: stringValue(payload.name) || 'unknown',
      arguments: argumentsValue(payload.arguments) || '',
      started: false,
      ended: false,
    };
    map.set(key, call);
  } else if (stringValue(payload.name)) {
    call.name = stringValue(payload.name);
  }
  return call;
}

function startToolIfNeeded(call: StreamToolState): StreamEvent[] {
  if (call.started) return [];
  call.started = true;
  return [{ type: 'tool_call_start', id: call.id, name: call.name }];
}

function endTool(call: StreamToolState): StreamEvent[] {
  if (call.ended) return [];
  call.ended = true;
  return [{ type: 'tool_call_end', id: call.id, name: call.name, arguments: call.arguments }];
}

function isReasoningDeltaType(type: string): boolean {
  return type === 'response.reasoning_summary_text.delta'
    || type === 'response.reasoning_text.delta'
    || type === 'response.reasoning.delta';
}

function isReasoningDoneType(type: string): boolean {
  return type === 'response.reasoning_summary_text.done'
    || type === 'response.reasoning_text.done';
}

function readProviderError(payload: UnknownRecord, type: string): string | undefined {
  const responseError = asRecord(payload.response)?.error;
  const source = payload.error ?? responseError ?? (type === 'error' || type === 'response.failed' ? payload : undefined);
  if (typeof source === 'string' && source.trim()) return source.trim().slice(0, 500);
  const record = asRecord(source);
  if (record && typeof record.message === 'string' && record.message.trim()) return record.message.trim().slice(0, 500);
  if (record && typeof record.detail === 'string' && record.detail.trim()) return record.detail.trim().slice(0, 500);
  if (type === 'response.failed') return 'Responses provider returned a failed response.';
  return undefined;
}

function omitUndefined<T>(value: T): T {
  const record = value as unknown as UnknownRecord;
  for (const key of Object.keys(record)) if (record[key] === undefined) delete record[key];
  return value;
}

function asRecord(value: unknown): UnknownRecord | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as UnknownRecord : undefined;
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function argumentsValue(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === 'string') return value;
    if (value !== undefined && value !== null) {
      try {
        return JSON.stringify(value);
      } catch {
        return '';
      }
    }
  }
  return '';
}
function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}
function estimateResponsesValueTokens(value: unknown, parentType?: string): number {
  if (typeof value === 'string') return estimateResponsesTextTokens(value);
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return 1;
  if (Array.isArray(value)) {
    return value.reduce((total, item) => total + estimateResponsesValueTokens(item), 1);
  }
  const record = asRecord(value);
  if (!record) return 0;
  let total = 2;
  const type = stringValue(record.type);
  for (const [key, entry] of Object.entries(record)) {
    // Data URLs count as a fixed image allowance rather than their byte length.
    if ((key === 'image_url' || key === 'url') && (type === 'input_image' || parentType === 'input_image')) {
      total += 85;
      continue;
    }
    total += estimateResponsesTextTokens(key) + 1 + estimateResponsesValueTokens(entry, type);
  }
  return total;
}
function estimateResponsesTextTokens(text: string): number {
  if (!text) return 0;
  let cjk = 0;
  let other = 0;
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    if ((code >= 0x3040 && code <= 0x30ff)
      || (code >= 0x3400 && code <= 0x9fff)
      || (code >= 0xf900 && code <= 0xfaff)) cjk += 1;
    else other += 1;
  }
  return Math.ceil(cjk * 1.5 + other / 4);
}
function firstNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, Math.floor(value));
  }
  return undefined;
}
