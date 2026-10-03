// 引入类型与工具函数
import {
  ModelConfig,
  type ChatCompletionRequest,
  type ChatCompletionResponse,
  type AnthropicMessageRequest,
  type AnthropicMessageResponse,
  type AnthropicContentBlock,
  type AnthropicSSEEvent,
  type StreamEvent,
  type ChatMessage,
  type CacheStrategy,
  type ModelRequestOptions,
  type LlamaCapabilities,
  type OpenAIModelCapabilities,
  type NormalizedUsage,
  type TokenEstimate,
  type ToolCall,
  protocolFor,
} from './types.js';
// 引入 provider 注册表与 API key 解析
import { getProvider, resolveApiKey } from './providers.js';
import { resolveProviderProfile, type ProviderProfile } from './providerProfiles.js';
import { LlamaCppClient } from './llamaClient.js';
import {
  buildResponsesRequest,
  estimateResponsesInputTokens,
  normalizeResponsesResponse,
  parseResponsesStream,
  type ResponsesRequest,
} from './responsesClient.js';
import { ModelRequestTimeoutError, ModelStreamIdleTimeoutError } from './errors.js';

/** Core model gateway — unified interface over OpenAI-compatible + Anthropic APIs. */
// 核心模型网关：在 OpenAI 兼容协议和 Anthropic API 之上统一成一个对外接口
// 模型网关核心：把 OpenAI 兼容与 Anthropic 协议统一成一个接口
export class ModelGateway {
  private config: ModelConfig;
  private baseUrl: string;
  private protocol: 'openai' | 'anthropic';
  private cacheStrategy: CacheStrategy;
  private profile: ProviderProfile;
  private llamaCapabilitiesPromise: Promise<LlamaCapabilities> | null = null;
  private llamaCapabilitiesAt = 0;
  private llamaClient: LlamaCppClient | null = null;

  // 构造时自动解析 baseURL、API key、协议、缓存策略
  constructor(config: ModelConfig) {
    const normalizedConfig: ModelConfig = {
      ...config,
      provider: config.provider.trim(),
      model: config.model.trim(),
      baseUrl: (config.baseUrl ?? '').trim(),
    };
    // 解析 provider 条目
    const providerEntry = getProvider(normalizedConfig.provider);
    const resolvedBaseUrl = normalizedConfig.baseUrl;
    const resolvedApiKey = resolveApiKey(normalizedConfig.provider, normalizedConfig.apiKey);

    this.profile = resolveProviderProfile({
      provider: normalizedConfig.provider,
      baseUrl: resolvedBaseUrl,
      model: normalizedConfig.model,
    });
    this.config = { ...normalizedConfig, baseUrl: resolvedBaseUrl, apiKey: resolvedApiKey };
    this.baseUrl = resolvedBaseUrl;
    this.protocol = this.profile.transport === 'anthropic_messages'
      ? 'anthropic'
      : (providerEntry?.protocol ?? protocolFor(normalizedConfig.provider));
    this.cacheStrategy = resolveCacheStrategy(this.config, this.protocol);
    if (this.profile.id === 'llama_cpp') {
      this.llamaClient = new LlamaCppClient({
        baseUrl: resolvedBaseUrl,
        headers: this.baseHeaders(),
        timeoutMs: this.config.timeoutMs,
        retry: this.config.retry,
      });
    }
  }

  // ─── Public API ───────────────────────────────────────────────────────────

  /** Non-streaming chat completion. Works identically for both protocols. */
  // 非流式对话补全：两种协议调用方使用方式完全一致
  // 非流式对话补全：按协议自动路由到 openaiChat / anthropicChat
  async chat(
    req: Omit<ChatCompletionRequest, 'model' | 'stream'>,
    options?: ModelRequestOptions,
  ): Promise<ChatCompletionResponse> {
    if (this.protocol === 'anthropic') {
      return this.anthropicChat(req, options);
    }
    if (this.profile.transport === 'openai_responses') {
      return this.openaiResponsesChat(req, options);
    }
    return this.openaiChat(req, options);
  }

  /** Streaming chat completion — unified StreamEvent for both protocols. */
  // 流式对话补全：对两种协议统一产出 StreamEvent
  // 流式对话补全：统一输出 StreamEvent，调用方无需感知协议差异
  async *chatStream(
    req: Omit<ChatCompletionRequest, 'model' | 'stream'>,
    options?: ModelRequestOptions,
  ): AsyncGenerator<StreamEvent> {
    const stream = this.protocol === 'anthropic'
      ? this.anthropicChatStream(req, options)
      : this.profile.transport === 'openai_responses'
        ? this.openaiResponsesStream(req, options)
        : this.openaiChatStream(req, options);
    yield* this.withStreamIdleWatchdog(stream, options);
  }

  getProfile(): ProviderProfile {
    return this.profile;
  }

  getModelId(): string {
    return this.config.model;
  }

  /** Stable, non-secret identity for cache-slot leases. */
  getConnectionFingerprint(): string {
    const endpoint = this.llamaClient?.serverBaseUrl ?? this.baseUrl;
    return `${this.profile.id}|${endpoint}|${this.config.model}`;
  }

  /** Probe llama-server metadata without issuing a model completion. */
  async probeLlamaCapabilities(options?: Pick<ModelRequestOptions, 'signal'>): Promise<LlamaCapabilities> {
    if (this.profile.id !== 'llama_cpp') {
      return { provider: 'llama_cpp', reachable: false, hasToolTemplate: false, hasReasoningTemplate: false, error: 'not a llama.cpp provider' };
    }
    const now = Date.now();
    if (this.llamaCapabilitiesPromise && now - this.llamaCapabilitiesAt < 30_000) {
      return this.llamaCapabilitiesPromise;
    }
    const client = this.llamaClient;
    if (!client) {
      return { provider: 'llama_cpp', reachable: false, hasToolTemplate: false, hasReasoningTemplate: false, error: 'llama.cpp client is unavailable' };
    }
    this.llamaCapabilitiesAt = now;
    this.llamaCapabilitiesPromise = (async () => {
      try {
        const response = await client.getProps({ signal: options?.signal });
        if (!response.ok) return { provider: 'llama_cpp', reachable: false, hasToolTemplate: false, hasReasoningTemplate: false, error: `HTTP ${response.status}` };
        const body = await response.json() as Record<string, unknown>;
        const chatTemplate = typeof body.chat_template === 'string' ? body.chat_template : undefined;
        const toolTemplate = typeof body.chat_template_tool_use === 'string' ? body.chat_template_tool_use : undefined;
        const slotCount = positiveIntegerFrom(body.total_slots);
        const defaultGenerationSettings = asRecord(body.default_generation_settings);
        const contextTokens = positiveIntegerFrom(
          defaultGenerationSettings?.n_ctx
            ?? defaultGenerationSettings?.context_size
            ?? body.n_ctx,
        );
        const modelInfo = asRecord(body.model_info);
        const trainingContextTokens = positiveIntegerFrom(
          body.model_n_ctx_train
            ?? modelInfo?.model_n_ctx_train
            ?? modelInfo?.['llama.context_length']
            ?? modelInfo?.['general.context_length'],
        );
        const buildInfo = typeof body.build_info === 'string'
          ? body.build_info
          : typeof body.version === 'string' ? body.version : undefined;
        const modelPath = typeof body.model_path === 'string'
          ? body.model_path
          : typeof body.model_alias === 'string' ? body.model_alias : undefined;
        const templateText = `${chatTemplate ?? ''}\n${toolTemplate ?? ''}`.toLowerCase();
        const epoch = [
          this.getConnectionFingerprint(),
          buildInfo,
          modelPath,
          contextTokens,
          slotCount,
          trainingContextTokens,
        ].filter((value) => value !== undefined && value !== '').join('|');
        return {
          provider: 'llama_cpp',
          reachable: true,
          ...(slotCount ? { slotCount } : {}),
          ...(contextTokens ? { contextTokens } : {}),
          ...(trainingContextTokens ? { trainingContextTokens } : {}),
          ...(buildInfo ? { buildInfo } : {}),
          ...(modelPath ? { modelPath } : {}),
          ...(epoch ? { epoch } : {}),
          ...(chatTemplate ? { chatTemplate } : {}),
          hasToolTemplate: Boolean(toolTemplate) || /\btool_calls?\b|\btool_use\b|\bfunction(?:_call)?\b/.test(templateText),
          hasReasoningTemplate: /reasoning|think(?:ing)?/.test(templateText),
        };
      } catch (error) {
        return { provider: 'llama_cpp', reachable: false, hasToolTemplate: false, hasReasoningTemplate: false, error: error instanceof Error ? error.message : String(error) };
      }
    })();
    return this.llamaCapabilitiesPromise;
  }

  /**
   * Probe a model advertised by an OpenAI-compatible `/models` endpoint.
   *
   * This is metadata-only: it never sends a completion request and never
   * retries.  Many gateways expose no limits at all, so `reachable: true`
   * intentionally does not imply a context window.
   */
  async probeOpenAIModelCapabilities(
    options?: Pick<ModelRequestOptions, 'signal'>,
  ): Promise<OpenAIModelCapabilities> {
    if (this.protocol !== 'openai' || this.profile.id === 'llama_cpp') {
      return {
        provider: this.config.provider,
        model: this.config.model,
        reachable: false,
        error: 'not an OpenAI-compatible model endpoint',
      };
    }
    const timeoutMs = Math.min(Math.max(this.config.timeoutMs ?? 15_000, 1_000), 15_000);
    const base = stripTrailingSlashes(this.baseUrl);
    const urls = modelListUrls(base);
    let lastError: string | undefined;
    let sawSuccessfulResponse = false;
    for (const url of urls) {
      try {
        const signal = withTimeoutSignal(options?.signal, timeoutMs);
        const response = await fetch(url, {
          method: 'GET',
          headers: this.baseHeaders(),
          signal,
        });
        if (response.status === 404) {
          lastError = 'HTTP 404';
          continue;
        }
        if (!response.ok) {
          lastError = `HTTP ${response.status}`;
          break;
        }
        sawSuccessfulResponse = true;
        const payload = await response.json().catch(() => null) as unknown;
        const model = findModelRecord(payload, this.config.model);
        if (!model) {
          return {
            provider: this.config.provider,
            model: this.config.model,
            reachable: true,
            error: 'model was not advertised by /models',
          };
        }
        const metadata = mergeModelMetadata(model);
        return {
          provider: this.config.provider,
          model: this.config.model,
          reachable: true,
          ...(positiveIntegerFrom(firstMetadataValue(metadata, CONTEXT_METADATA_KEYS))
            ? { contextTokens: positiveIntegerFrom(firstMetadataValue(metadata, CONTEXT_METADATA_KEYS)) } : {}),
          ...(positiveIntegerFrom(firstMetadataValue(metadata, OUTPUT_METADATA_KEYS))
            ? { maxOutputTokens: positiveIntegerFrom(firstMetadataValue(metadata, OUTPUT_METADATA_KEYS)) } : {}),
        };
      } catch (error) {
        if (options?.signal?.aborted) throw error;
        lastError = error instanceof Error ? error.message : String(error);
        break;
      }
    }
    return {
      provider: this.config.provider,
      model: this.config.model,
      reachable: sawSuccessfulResponse,
      ...(lastError ? { error: lastError } : {}),
    };
  }

  /**
   * Return the configured or server-reported context window for local llama.cpp.
   * The value is intentionally optional: an unavailable /props endpoint must
   * not prevent callers from using a compatible OpenAI gateway.
   */
  async getLlamaContextTokens(options?: Pick<ModelRequestOptions, 'signal'>): Promise<number | undefined> {
    if (this.profile.id !== 'llama_cpp') return undefined;
    const capabilities = await this.probeLlamaCapabilities(options);
    if (capabilities.contextTokens && this.config.contextTokens) {
      return Math.min(capabilities.contextTokens, this.config.contextTokens);
    }
    return capabilities.contextTokens ?? this.config.contextTokens;
  }

  /** Test connectivity. */
  // 连通性测试：探测远端是否可达，并列出可用模型
  // 健康检查：探测远端可达性并列出可用模型
  async healthCheck(): Promise<{ ok: boolean; models?: string[]; error?: string }> {
    try {
      if (this.profile.id === 'llama_cpp') {
        const client = this.llamaClient;
        if (!client) return { ok: false, error: 'llama.cpp client is unavailable' };
        const resp = await client.getModels();
        if (!resp.ok) return { ok: false, error: `HTTP ${resp.status}` };
        const body = (await resp.json()) as { data?: Array<{ id: string }> };
        return { ok: true, models: body.data?.map((m) => m.id) };
      }
      const url = this.protocol === 'anthropic'
        ? this.baseUrl.replace(/\/v1\/?$/, '') + '/v1/messages'
        : this.baseUrl.replace(/\/v1\/?$/, '') + '/v1/models';
      const headers: Record<string, string> = this.baseHeaders();
      if (this.protocol === 'anthropic') {
        // Anthropic 真实探测需要带 body，这里只做 HEAD 探活
        const resp = await fetch(url, { method: 'HEAD', headers, signal: AbortSignal.timeout(5000) });
        return { ok: resp.status < 500, models: [] };
      }
      const resp = await fetch(url, { headers, signal: AbortSignal.timeout(5000) });
      if (!resp.ok) return { ok: false, error: `HTTP ${resp.status}` };
      const body = (await resp.json()) as { data?: Array<{ id: string }> };
      return { ok: true, models: body.data?.map((m) => m.id) };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  }

  /** List models from the compatible provider; used by settings without exposing keys. */
  async listModels(): Promise<{ ok: boolean; models: string[]; error?: string }> {
    try {
      if (this.profile.id === 'llama_cpp') {
        const health = await this.healthCheck();
        return { ok: health.ok, models: health.models ?? [], error: health.error };
      }
      const url = this.baseUrl.replace(/\/v1\/?$/, '') + '/v1/models';
      const headers: Record<string, string> = this.baseHeaders();
      if (this.protocol === 'anthropic') headers['anthropic-version'] = '2023-06-01';
      const resp = await fetch(url, { headers, signal: AbortSignal.timeout(8000) });
      if (!resp.ok) return { ok: false, models: [], error: `HTTP ${resp.status}` };
      const body = await resp.json() as unknown;
      const rows = Array.isArray(body)
        ? body
        : Array.isArray((body as { data?: unknown }).data)
          ? (body as { data: unknown[] }).data
          : Array.isArray((body as { models?: unknown }).models)
            ? (body as { models: unknown[] }).models
            : [];
      const models = rows.map((row) => typeof row === 'string'
        ? row
        : typeof row === 'object' && row
          ? (typeof (row as { id?: unknown }).id === 'string'
            ? (row as { id: string }).id
            : typeof (row as { name?: unknown }).name === 'string'
              ? (row as { name: string }).name
              : '')
          : '').filter(Boolean);
      return { ok: true, models: [...new Set(models)] };
    } catch (err) {
      return { ok: false, models: [], error: String(err) };
    }
  }

  // ─── OpenAI path ──────────────────────────────────────────────────────────

  /** Responses API path normalized back to Suanlizi' ChatCompletion contract. */
  private async openaiResponsesChat(
    req: Omit<ChatCompletionRequest, 'model' | 'stream'>,
    options?: ModelRequestOptions,
  ): Promise<ChatCompletionResponse> {
    const request = this.profile.id === 'llama_cpp'
      ? { ...req, reasoning_effort: undefined, messages: normalizeLlamaMessages(req.messages) }
      : req;
    const responseConfig = this.profile.id === 'llama_cpp'
      ? { ...this.config, reasoningEffort: undefined }
      : this.config;
    const body = buildResponsesRequest(request, responseConfig, options, false);
    if (this.profile.id === 'llama_cpp') await this.assertLlamaRequestFitsContext(body);
    const response = await this.openaiResponsesFetch(body, options);
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      if (isResponsesUnsupported(response.status, text)) {
        return this.openaiChat(req, options);
      }
      throw new Error(`${this.profile.displayName} gateway error (${response.status}): ${formatGatewayErrorBody(text)}`);
    }
    const raw = await response.json() as Record<string, unknown>;
    const responseFailure = responsesFailureMessage(raw);
    if (responseFailure) throw new Error(`${this.profile.displayName} Responses error: ${responseFailure}`);
    return normalizeResponsesResponse(raw, this.config.model, this.cacheStrategy);
  }

  /** Streaming Responses API path with the same fallback as non-streaming calls. */
  private async *openaiResponsesStream(
    req: Omit<ChatCompletionRequest, 'model' | 'stream'>,
    options?: ModelRequestOptions,
  ): AsyncGenerator<StreamEvent> {
    const request = this.profile.id === 'llama_cpp'
      ? { ...req, reasoning_effort: undefined, messages: normalizeLlamaMessages(req.messages) }
      : req;
    const responseConfig = this.profile.id === 'llama_cpp'
      ? { ...this.config, reasoningEffort: undefined }
      : this.config;
    const body = buildResponsesRequest(request, responseConfig, options, true);
    if (this.profile.id === 'llama_cpp') await this.assertLlamaRequestFitsContext(body);
    const response = await this.openaiResponsesFetch(body, options);
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      if (isResponsesUnsupported(response.status, text)) {
        yield* this.openaiChatStream(req, options);
        return;
      }
      yield { type: 'error', error: new Error(`${this.profile.displayName} gateway error (${response.status}): ${formatGatewayErrorBody(text)}`) };
      return;
    }
    const reader = response.body?.getReader();
    if (!reader) {
      yield { type: 'error', error: new Error('Response body is not readable') };
      return;
    }
    yield* parseResponsesStream(reader, this.cacheStrategy);
  }

  /**
   * 流式空闲看门狗：只在等待下一帧时计时。任何 delta/tool/usage 帧都会重置；
   * 长思考不应被旧的“总响应超时”误杀。
   */
  private async *withStreamIdleWatchdog(
    stream: AsyncGenerator<StreamEvent>,
    options?: ModelRequestOptions,
  ): AsyncGenerator<StreamEvent> {
    const idleTimeoutMs = Math.max(1_000, this.config.streamIdleTimeoutMs ?? 300_000);
    const controller = new AbortController();
    const parentSignal = options?.signal;
    const abortFromParent = () => controller.abort(parentSignal?.reason);
    if (parentSignal) {
      if (parentSignal.aborted) abortFromParent();
      else parentSignal.addEventListener('abort', abortFromParent, { once: true });
    }
    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    const armIdleTimer = () => {
      if (idleTimer !== null) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        controller.abort(new ModelStreamIdleTimeoutError(idleTimeoutMs));
      }, idleTimeoutMs);
    };
    const iterator = stream[Symbol.asyncIterator]();
    armIdleTimer();
    try {
      while (true) {
        let result: IteratorResult<StreamEvent>;
        try {
          result = await iterator.next();
        } catch (error) {
          const idleError = controller.signal.reason;
          if (controller.signal.aborted && idleError instanceof ModelStreamIdleTimeoutError) throw idleError;
          throw error;
        }
        if (result.done) return;
        armIdleTimer();
        yield result.value;
      }
    } finally {
      if (idleTimer !== null) clearTimeout(idleTimer);
      parentSignal?.removeEventListener('abort', abortFromParent);
      await iterator.return?.(undefined).catch(() => undefined);
    }
  }
  /** POST /responses for remote OpenAI-compatible gateways and llama-server. */
  private openaiResponsesFetch(body: ResponsesRequest, options?: ModelRequestOptions): Promise<Response> {
    if (this.profile.id === 'llama_cpp') {
      const client = this.llamaClient;
      if (!client) return Promise.reject(new Error('llama.cpp client is unavailable'));
      return client.responses(body as unknown as Record<string, unknown>, {
        signal: options?.signal,
        onRetry: options?.onRetry,
      });
    }
    // DeepSeek 的 Responses 官方基址不带 /v1，Chat 仍沿用 /v1。
    const responsesBaseUrl = this.profile.id === 'deepseek'
      ? stripTrailingSlashes(this.baseUrl).replace(/\/v1$/i, '')
      : stripTrailingSlashes(this.baseUrl);
    const url = `${responsesBaseUrl}/responses`;
    return this.fetchWithRetry(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...this.baseHeaders() },
      body: JSON.stringify(body),
    }, options, this.config.timeoutMs ?? 120_000);
  }

  // OpenAI 非流式补全：补齐 model/max_tokens/temperature/top_p/reasoning_effort 后请求
// 英文说明：在填充默认模型参数后，调用 fetch 并把异构 usage 归一化
  private async openaiChat(
    req: Omit<ChatCompletionRequest, 'model' | 'stream'>,
    options?: ModelRequestOptions,
  ): Promise<ChatCompletionResponse> {
    const body = this.buildOpenAiChatRequest(req, false, options);
    await this.assertLlamaRequestFitsContext(body);
    const resp = await this.openaiFetch(body, options);
    const json = await resp.json() as ChatCompletionResponse;
    return normalizeOpenAIResponse(json, this.cacheStrategy);
  }

  // OpenAI 流式补全：把 SSE 流解析为统一 StreamEvent
  private async *openaiChatStream(
    req: Omit<ChatCompletionRequest, 'model' | 'stream'>,
    options?: ModelRequestOptions,
  ): AsyncGenerator<StreamEvent> {
    const body = this.buildOpenAiChatRequest(req, true, options);
    await this.assertLlamaRequestFitsContext(body);
    const resp = await this.openaiFetch(body, options);
    const reader = resp.body?.getReader();
    if (!reader) {
      yield { type: 'error', error: new Error('Response body is not readable') };
      return;
    }
    yield* parseOpenAIStream(reader, this.cacheStrategy, this.profile.id === 'llama_cpp');
  }

  // OpenAI POST /chat/completions：带超时与错误文本截断
  private async openaiFetch(body: ChatCompletionRequest, options?: ModelRequestOptions): Promise<Response> {
    if (this.profile.id === 'llama_cpp') {
      const client = this.llamaClient;
      if (!client) throw new Error('llama.cpp client is unavailable');
      return client.chat(body, {
        signal: options?.signal,
        onRetry: options?.onRetry,
      });
    }
    const chatBaseUrl = this.profile.id === 'deepseek'
      ? ensureDeepSeekChatVersion(this.baseUrl)
      : stripTrailingSlashes(this.baseUrl);
    const url = `${chatBaseUrl}/chat/completions`;
    const resp = await this.fetchWithRetry(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...this.baseHeaders() },
      body: JSON.stringify(body),
    }, options, this.config.timeoutMs ?? 120_000);
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error(`${this.profile.displayName} gateway error (${resp.status}): ${formatGatewayErrorBody(text)}`);
    }
    return resp;
  }

  private buildOpenAiChatRequest(
    req: Omit<ChatCompletionRequest, 'model' | 'stream'>,
    stream: boolean,
    options?: ModelRequestOptions,
  ): ChatCompletionRequest {
    const reasoningEffort = normalizeReasoningEffortForProvider(
      this.profile.id,
      req.reasoning_effort ?? this.config.reasoningEffort,
    );
    const requestExtraBody = req.extra_body;
    const configuredExtraBody = this.config.extraBody ?? {};
    const mergedExtraBody = { ...configuredExtraBody, ...(requestExtraBody ?? {}) };
    const body: ChatCompletionRequest = {
      ...req,
      messages: stripProviderFrames(
        this.profile.id === 'llama_cpp'
          ? normalizeLlamaMessages(req.messages)
          : isGiteeEndpoint(this.profile.id, this.baseUrl)
            ? normalizeGiteeMessages(req.messages)
            : req.messages,
      ),
      model: this.config.model,
      max_tokens: req.max_tokens ?? this.config.maxTokens,
      temperature: req.temperature ?? this.config.temperature,
      top_p: req.top_p ?? this.config.topP,
      top_k: req.top_k ?? this.config.topK ?? numericExtra(mergedExtraBody.top_k),
      frequency_penalty: req.frequency_penalty ?? this.config.frequencyPenalty ?? numericExtra(mergedExtraBody.frequency_penalty),
      presence_penalty: req.presence_penalty ?? this.config.presencePenalty ?? numericExtra(mergedExtraBody.presence_penalty),
      stream,
    };
    // OpenAI's SDK calls provider-specific fields `extra_body`, but serializes
    // them at the top level. Do the same for direct requests and saved config;
    // protected protocol fields cannot be overridden by provider extensions.
    delete body.extra_body;
    Object.assign(body as unknown as Record<string, unknown>, providerExtraBody(mergedExtraBody));
    if (this.profile.id === 'llama_cpp' && options?.llama) {
      if (Number.isInteger(options.llama.idSlot) && (options.llama.idSlot ?? -1) >= 0) body.id_slot = options.llama.idSlot;
      if (options.llama.cachePrompt !== undefined) body.cache_prompt = options.llama.cachePrompt;
      if (options.llama.returnProgress !== undefined) body.return_progress = options.llama.returnProgress;
    }
    if (this.profile.reasoningMode === 'deepseek_reasoning_content') {
      body.thinking = deepSeekThinkingFromEffort(reasoningEffort);
    } else if (this.profile.id === 'llama_cpp') {
      // llama.cpp selects thinking behavior from the model chat template. Its
      // OpenAI-compatible endpoint does not define the provider-specific
      // reasoning_effort field, so leave that field out of local requests.
      delete body.reasoning_effort;
    } else {
      body.reasoning_effort = reasoningEffort;
    }
    applyDomesticOpenAiCompatibleRequestShape(body, this.profile.id, this.config.model, stream);
    applyGiteeRequestShape(body, this.profile.id, this.baseUrl);
    if (this.profile.id === 'mistral' && body.tools?.length) {
      body.parallel_tool_calls = true;
    }
    return body;
  }

  /**
   * Last-mile guard for callers that use ModelGateway without AgentLoop.
   * AgentLoop already trims messages and schemas; this check only runs when
   * a context value is known locally or from a previous /props probe, so a
   * standalone gateway call never incurs an unexpected metadata request.
   */
  private async assertLlamaRequestFitsContext(body: ChatCompletionRequest | ResponsesRequest): Promise<void> {
    if (this.profile.id !== 'llama_cpp') return;
    const probed = this.llamaCapabilitiesPromise ? await this.llamaCapabilitiesPromise : undefined;
    const contextTokens = probed?.contextTokens && this.config.contextTokens
      ? Math.min(probed.contextTokens, this.config.contextTokens)
      : probed?.contextTokens ?? this.config.contextTokens;
    if (!contextTokens) return;
    const requestedTokens = 'input' in body
      ? estimateResponsesInputTokens(body)
      : estimateChatRequestTokens(body);
    if (requestedTokens <= contextTokens) return;
    throw new Error(
      `llama.cpp 请求超过上下文窗口（估算 ${requestedTokens.toLocaleString()} tokens，限制 ${contextTokens.toLocaleString()}）。请先压缩上下文或降低输出上限。`,
    );
  }

  // ─── Anthropic path ───────────────────────────────────────────────────────

  // Anthropic 非流式补全：先把请求体转成 Anthropic 格式
  private async anthropicChat(
    req: Omit<ChatCompletionRequest, 'model' | 'stream'>,
    options?: ModelRequestOptions,
  ): Promise<ChatCompletionResponse> {
    const anthroReq = convertToAnthropic(req, this.config, this.cacheStrategy);
    const resp = await this.anthropicFetch(anthroReq, options);
    const anthroResp = (await resp.json()) as AnthropicMessageResponse;
    return convertAnthropicResponse(anthroResp, this.config.model, this.cacheStrategy);
  }

  // Anthropic 流式补全
  private async *anthropicChatStream(
    req: Omit<ChatCompletionRequest, 'model' | 'stream'>,
    options?: ModelRequestOptions,
  ): AsyncGenerator<StreamEvent> {
    const anthroReq: AnthropicMessageRequest = {
      ...convertToAnthropic(req, this.config, this.cacheStrategy),
      stream: true,
    };
    const resp = await this.anthropicFetch(anthroReq, options);
    const reader = resp.body?.getReader();
    if (!reader) {
      yield { type: 'error', error: new Error('Response body is not readable') };
      return;
    }
    yield* parseAnthropicStream(reader, this.cacheStrategy);
  }

  // Anthropic POST /messages：需要带 anthropic-version header
  private async anthropicFetch(body: AnthropicMessageRequest, options?: ModelRequestOptions): Promise<Response> {
    const url = `${this.baseUrl}/messages`;
    const resp = await this.fetchWithRetry(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'anthropic-version': '2023-06-01',
        ...this.baseHeaders(),
      },
      body: JSON.stringify(body),
    }, options, this.config.timeoutMs ?? 120_000);
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error(`Anthropic gateway error (${resp.status}): ${text.slice(0, 500)}`);
    }
    return resp;
  }

  // 带指数退避的重试 fetch：默认 3 次，最大退避 3 秒
  private async fetchWithRetry(
    url: string,
    init: RequestInit,
    options?: ModelRequestOptions,
    timeoutMs = this.config.timeoutMs ?? 120_000,
  ): Promise<Response> {
    const policy = {
      maxAttempts: Math.max(1, Math.floor(this.config.retry?.maxAttempts ?? 3)),
      initialDelayMs: Math.max(0, Math.floor(this.config.retry?.initialDelayMs ?? 300)),
      maxDelayMs: Math.max(0, Math.floor(this.config.retry?.maxDelayMs ?? 3_000)),
    };
    let lastError: unknown;
    for (let attempt = 1; attempt <= policy.maxAttempts; attempt++) {
      // 每次重试都创建新的超时 signal。复用第一次请求的 signal 会让后续
      // 重试在旧计时器到期后立即失败，表现为“连续意外报错”。
      const attemptSignal = withTimeoutSignal(options?.signal, timeoutMs);
      try {
        const response = await fetch(url, { ...init, signal: attemptSignal });
        if (!isRetryableStatus(response.status) || attempt >= policy.maxAttempts) {
          return response;
        }
        lastError = new HttpRetryError(response.status);
      } catch (error) {
        // 用户主动取消不能进入重试链，否则停止按钮会被误显示成流中断。
        if (options?.signal?.aborted) throw error;
        if (isTimeoutAbort(attemptSignal, error)) {
          lastError = new ModelRequestTimeoutError(timeoutMs, { cause: error });
        } else {
          lastError = error;
        }
        if (!isRetryableFetchError(error) || attempt >= policy.maxAttempts) {
          throw lastError;
        }
      }
      const delayMs = backoffDelay(attempt, policy.initialDelayMs, policy.maxDelayMs);
      await options?.onRetry?.({
        attempt,
        maxAttempts: policy.maxAttempts,
        delayMs,
        status: lastError instanceof HttpRetryError ? lastError.status : undefined,
        error: lastError instanceof Error && !(lastError instanceof HttpRetryError) ? lastError.message : undefined,
      });
      await sleep(delayMs);
      if (options?.signal?.aborted) throw options.signal.reason ?? new DOMException('The operation was aborted', 'AbortError');
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  // ─── Headers ──────────────────────────────────────────────────────────────

  // 构造基础请求头：Anthropic 用 x-api-key，OpenAI 用 Bearer
  private baseHeaders(): Record<string, string> {
    const h: Record<string, string> = {};
    if (this.profile.id === 'openrouter') {
      h['HTTP-Referer'] = 'https://github.com/suanlizi-agent/suanlizi';
      h['X-OpenRouter-Title'] = 'Suanlizi';
      h['X-OpenRouter-Categories'] = 'productivity,developer-tools,local-first';
    }
    if (isGiteeEndpoint(this.profile.id, this.baseUrl)) {
      // Gitee AI documents this header as the opt-in for gateway failover.
      // Respect an explicit caller value when one is supplied below.
      h['X-Failover-Enabled'] = 'true';
    }
    Object.assign(h, this.config.extraHeaders);
    if (this.protocol === 'anthropic') {
      if (this.config.apiKey && this.profile.id === 'minimax') {
        h['Authorization'] = `Bearer ${this.config.apiKey}`;
        delete h['x-api-key'];
      } else if (this.config.apiKey) {
        h['x-api-key'] = this.config.apiKey;
      }
    } else {
      if (this.config.apiKey) h['Authorization'] = `Bearer ${this.config.apiKey}`;
    }
    return h;
  }
}

function estimateChatRequestTokens(body: ChatCompletionRequest): number {
  const messages = estimateChatTokens(body.messages).inputTokens;
  const extras = body.messages.reduce((total, message) => {
    const reasoning = message.reasoning_content ? Math.ceil(message.reasoning_content.length / 3) : 0;
    const details = message.reasoning_details ? Math.ceil(JSON.stringify(message.reasoning_details).length / 3) : 0;
    const calls = message.tool_calls?.length ? Math.ceil(JSON.stringify(message.tool_calls).length / 3) : 0;
    const frame = message.providerFrame?.format === 'openai_responses'
      ? Math.ceil(JSON.stringify(message.providerFrame.outputItems).length / 3)
      : 0;
    return total + reasoning + details + calls + frame;
  }, 0);
  const toolTokens = body.tools?.length ? Math.ceil(JSON.stringify(body.tools).length / 3) : 0;
  return messages + extras + toolTokens + Math.max(0, body.max_tokens ?? 0);
}

// 合并「父级 signal」与「超时 signal」，任一触发即中断
function withTimeoutSignal(parent: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  if (!parent) return timeout;
  if (parent.aborted) return parent;
  const controller = new AbortController();
  const abortFromParent = () => controller.abort(parent.reason);
  const abortFromTimeout = () => controller.abort(timeout.reason);
  parent.addEventListener('abort', abortFromParent, { once: true });
  timeout.addEventListener('abort', abortFromTimeout, { once: true });
  return controller.signal;
}

function isTimeoutAbort(signal: AbortSignal, error: unknown): boolean {
  if (signal.aborted && isTimeoutReason(signal.reason)) return true;
  if (error instanceof DOMException && error.name === 'TimeoutError') return true;
  return error instanceof Error && /aborted.*timeout|timeout/i.test(error.message);
}

function isTimeoutReason(reason: unknown): boolean {
  return reason instanceof DOMException && reason.name === 'TimeoutError'
    || reason instanceof Error && /timeout/i.test(reason.message);
}

// 可重试 HTTP 错误包装：带原始状态码
class HttpRetryError extends Error {
  constructor(readonly status: number) {
    super(`retryable HTTP ${status}`);
  }
}

// 是否为可重试状态码：408/409/425/429/5xx
function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}

// 是否为可重试的 fetch 错误：401/403/400 不重试，其它大多可重试
function isRetryableFetchError(error: unknown): boolean {
  if (error instanceof DOMException && error.name === 'TimeoutError') return true;
  if (error instanceof Error) {
    return !/401|403|400|unauthorized|forbidden/i.test(error.message);
  }
  return true;
}

// 指数退避：initial * 2^(attempt-1)，但不超过 maxDelayMs
function backoffDelay(attempt: number, initialDelayMs: number, maxDelayMs: number): number {
  if (initialDelayMs <= 0) return 0;
  return Math.min(maxDelayMs, initialDelayMs * 2 ** Math.max(0, attempt - 1));
}

// 简单 sleep 工具
function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function estimateGatewayTextTokens(text: string): number {
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

// 估算 chat 消息的 token 数：粗略按 4 字符/token + 每条消息 3 token + 图片 85 token
export function estimateChatTokens(messages: ChatMessage[]): TokenEstimate {
  let charCount = 0;
  let textTokens = 0;
  let imageCount = 0;
  for (const message of messages) {
    charCount += message.role.length + 4;
    if (typeof message.content === 'string') {
      charCount += message.content.length;
      textTokens += estimateGatewayTextTokens(message.content);
      continue;
    }
    for (const part of message.content) {
      if (part.type === 'text') {
        charCount += part.text.length;
        textTokens += estimateGatewayTextTokens(part.text);
      } else if (part.type === 'image_url') {
        imageCount += 1;
        charCount += 85;
      }
    }
  }
  return {
    inputTokens: Math.max(1, textTokens + messages.length * 3 + imageCount * 85),
    messageCount: messages.length,
    imageCount,
    charCount,
  };
}

// 解析缓存策略：auto 时按 provider/model 推断
export function resolveCacheStrategy(
  config: Pick<ModelConfig, 'provider' | 'model' | 'cacheStrategy'>,
  protocol: 'openai' | 'anthropic' = protocolFor(config.provider),
): CacheStrategy {
  if (config.cacheStrategy && config.cacheStrategy !== 'auto') return config.cacheStrategy;
  const provider = config.provider.toLowerCase();
  const model = config.model.toLowerCase();
  if (provider.includes('deepseek') || model.includes('deepseek')) return 'deepseek-native';
  if (protocol === 'anthropic') return 'anthropic-cache-control';
  return 'openai-compatible';
}

// 把各 provider 异构的 usage 字段归一化：识别 deepseek/anthropic/openai 三种缓存字段
export function normalizeUsage(raw: unknown, cacheStrategy?: CacheStrategy): NormalizedUsage | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const usage = raw as Record<string, unknown>;
  const timings = usage.timings && typeof usage.timings === 'object'
    ? usage.timings as Record<string, unknown>
    : usage;
  const deepseekHit = numberField(usage.prompt_cache_hit_tokens);
  const deepseekMiss = numberField(usage.prompt_cache_miss_tokens);
  const llamaCache = firstPresentNumber(timings.cache_n, usage.cache_n);
  const llamaPrompt = firstPresentNumber(timings.prompt_n, usage.prompt_n);
  const promptTokens = deepseekHit || deepseekMiss
    ? deepseekHit + deepseekMiss
    : firstPresentNumber(usage.prompt_tokens, usage.input_tokens)
      ?? (llamaPrompt !== undefined ? llamaPrompt + (llamaCache ?? 0) : 0);
  const completionTokens = numberField(usage.completion_tokens ?? usage.output_tokens);
  const details = usage.prompt_tokens_details && typeof usage.prompt_tokens_details === 'object'
    ? usage.prompt_tokens_details as Record<string, unknown>
    : {};
  const openAiCached = firstPresentNumber(details.cached_tokens, usage.cached_tokens);
  const anthropicCached = firstPresentNumber(usage.cache_read_input_tokens);
  const anthropicCreated = firstPresentNumber(usage.cache_creation_input_tokens);
  const cachedTokens = deepseekHit || openAiCached || anthropicCached || llamaCache || 0;
  const cacheReported = deepseekHit !== 0 || deepseekMiss !== 0
    || hasNumber(usage.prompt_cache_hit_tokens) || hasNumber(usage.prompt_cache_miss_tokens)
    || openAiCached !== undefined || anthropicCached !== undefined || llamaCache !== undefined;
  const cacheSource = llamaCache !== undefined
    ? 'llama-timings' as const
    : deepseekHit !== 0 || deepseekMiss !== 0 || hasNumber(usage.prompt_cache_hit_tokens) || hasNumber(usage.prompt_cache_miss_tokens)
      ? 'deepseek' as const
      : cacheStrategy === 'deepseek-native' && (openAiCached !== undefined || anthropicCached !== undefined)
        ? 'deepseek' as const
        : anthropicCached !== undefined ? 'anthropic' as const : openAiCached !== undefined ? 'openai' as const : undefined;
  const inferredStrategy = cacheStrategy ?? inferCacheStrategyFromUsage(usage);
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: numberField(usage.total_tokens) || promptTokens + completionTokens,
    cached_tokens: cachedTokens,
    cache_reported: cacheReported,
    ...(anthropicCreated === undefined ? {} : { cache_creation_tokens: anthropicCreated }),
    ...(cacheSource ? { cache_source: cacheSource } : {}),
    ...(inferredStrategy && inferredStrategy !== 'none' ? { cache_strategy: inferredStrategy } : {}),
  };
}

export function convertOpenAIResponseForTest(
  raw: RawOpenAIChatCompletionResponse,
  cacheStrategy?: CacheStrategy,
): ChatCompletionResponse {
  return normalizeOpenAIResponse(raw, cacheStrategy);
}

function normalizeOpenAIResponse(
  raw: RawOpenAIChatCompletionResponse,
  cacheStrategy?: CacheStrategy,
): ChatCompletionResponse {
  const choiceUsage = raw.choices.find((choice) => choice && typeof choice === 'object' && 'usage' in choice)?.usage;
  const usagePayload = raw.usage ?? choiceUsage;
  const usageObject: Record<string, unknown> = usagePayload && typeof usagePayload === 'object'
    ? usagePayload as Record<string, unknown>
    : {};
  return {
    ...raw,
    choices: raw.choices.map((choice) => ({
      ...choice,
      message: {
        ...choice.message,
        ...(typeof choice.message.content === 'string'
          ? (() => {
              const tagged = normalizeTaggedReasoningText(choice.message.content);
              const aliases = choice.message as ChatMessage & { reasoning?: unknown; thinking?: unknown };
              const reasoning = firstStringValue(choice.message.reasoning_content, aliases.reasoning, aliases.thinking);
              const combinedReasoning = [reasoning, tagged.reasoning]
                .filter((value, index, values): value is string => Boolean(value) && values.indexOf(value) === index)
                .join('\n');
              return {
                content: tagged.content,
                ...(combinedReasoning ? { reasoning_content: combinedReasoning } : {}),
              };
            })()
          : {}),
      },
    })),
    usage: normalizeUsage(raw.timings && typeof raw.timings === 'object'
      ? { ...usageObject, timings: raw.timings }
      : usageObject, cacheStrategy),
  };
}

type RawOpenAIChatCompletionResponse = Omit<ChatCompletionResponse, 'usage'> & {
  usage?: unknown;
  timings?: unknown;
  choices: Array<ChatCompletionResponse['choices'][number] & { usage?: unknown }>;
};

/**
 * Some OpenAI-compatible providers put reasoning in the text stream using
 * `<think>...</think>` instead of the OpenAI reasoning_content field. Keep
 * those tags out of the user-facing answer and normalize the content once at
 * the protocol boundary.
 */
function normalizeTaggedReasoningText(text: string): { content: string; reasoning?: string } {
  const reasoningParts: string[] = [];
  let content = '';
  let cursor = 0;
  const openPattern = /<think\s*>/ig;
  const closePattern = /<\/think\s*>/ig;

  while (cursor < text.length) {
    openPattern.lastIndex = cursor;
    const open = openPattern.exec(text);
    if (!open) {
      content += text.slice(cursor);
      break;
    }
    content += text.slice(cursor, open.index);
    closePattern.lastIndex = open.index + open[0].length;
    const close = closePattern.exec(text);
    if (!close) {
      const trailingReasoning = text.slice(open.index + open[0].length);
      if (trailingReasoning.trim()) reasoningParts.push(trailingReasoning);
      break;
    }
    const reasoning = text.slice(open.index + open[0].length, close.index);
    if (reasoning.trim()) reasoningParts.push(reasoning);
    cursor = close.index + close[0].length;
  }

  const combinedReasoning = reasoningParts.join('');
  return combinedReasoning ? { content, reasoning: combinedReasoning } : { content };
}

function deepSeekThinkingFromEffort(
  effort: ModelConfig['reasoningEffort'] | ChatCompletionRequest['reasoning_effort'] | undefined,
): NonNullable<ChatCompletionRequest['thinking']> {
  const normalized = typeof effort === 'string' ? effort.trim().toLowerCase() : '';
  if (['no', 'low', 'none', 'off', 'disabled', 'disable', 'false', 'minimal'].includes(normalized)) {
    return { type: 'disabled' };
  }
  if (normalized === 'max' || normalized === 'xhigh' || normalized === 'x-high') {
    return { type: 'enabled', reasoning_effort: 'max' };
  }
  return { type: 'enabled', reasoning_effort: 'high' };
}

function normalizeReasoningEffortForProvider(
  providerId: string,
  effort: ModelConfig['reasoningEffort'] | ChatCompletionRequest['reasoning_effort'] | undefined,
): ModelConfig['reasoningEffort'] | ChatCompletionRequest['reasoning_effort'] | undefined {
  if (providerId !== 'kimi' || typeof effort !== 'string') return effort;
  const normalized = effort.trim().toLowerCase();
  if (normalized === 'xhigh' || normalized === 'x-high' || normalized === 'maximum') return 'max';
  if (normalized === 'medium') return 'high';
  if (normalized === 'no' || normalized === 'none' || normalized === 'off' || normalized === 'disabled' || normalized === 'minimal') return 'low';
  return effort;
}

function applyDomesticOpenAiCompatibleRequestShape(
  body: ChatCompletionRequest,
  providerId: string,
  model: string,
  stream: boolean,
): void {
  const normalizedModel = model.trim().toLowerCase();
  const effort = typeof body.reasoning_effort === 'string'
    ? body.reasoning_effort.trim().toLowerCase()
    : '';

  if (providerId === 'qwen' && supportsQwenThinking(normalizedModel) && effort) {
    body.enable_thinking = !isDisabledThinkingEffort(effort);
    delete body.reasoning_effort;
    delete body.thinking;
    return;
  }

  if (providerId === 'zhipu' && supportsGlmThinking(normalizedModel)) {
    body.thinking = {
      type: isDisabledThinkingEffort(effort) ? 'disabled' : 'enabled',
      clear_thinking: true,
    };
    if (!supportsGlmReasoningEffort(normalizedModel)) {
      delete body.reasoning_effort;
    }
    if (stream && body.tools?.length && supportsGlmStreamingToolCalls(normalizedModel)) {
      body.tool_stream = true;
    }
    return;
  }

  if (supportsDomesticDeepSeekThinking(providerId, normalizedModel) && effort) {
    body.thinking = deepSeekThinkingFromEffort(effort);
    delete body.reasoning_effort;
  }
}

/**
 * Gitee AI 当前的 Chat Completions 兼容层只接受命名工具选择。
 * `auto` 是 OpenAI 的默认语义，但 Gitee 会在请求校验阶段直接返回
 * "Currently only named tools are supported"。省略该字段仍表示由服务端
 * 自主选择工具；明确的 function 选择则原样保留。
 */
function applyGiteeRequestShape(body: ChatCompletionRequest, providerId: string, baseUrl: string): void {
  if (!isGiteeEndpoint(providerId, baseUrl)) return;
  if (body.tool_choice === 'auto') delete body.tool_choice;
  delete body.reasoning_effort;
  delete body.parallel_tool_calls;
}

/**
 * Gitee accepts top-level function definitions, but its request schema rejects
 * OpenAI's structured assistant history (`tool_calls` and `role: tool`). Keep
 * tools available for the current completion and flatten only the historical
 * exchange into ordinary assistant/user text messages.
 */
function normalizeGiteeMessages(messages: ChatMessage[]): ChatMessage[] {
  const toolNames = new Map<string, string>();
  for (const message of messages) {
    if (message.role !== 'assistant' || !message.tool_calls) continue;
    for (const toolCall of message.tool_calls) {
      if (toolCall.id && toolCall.function?.name) toolNames.set(toolCall.id, toolCall.function.name);
    }
  }

  return messages.flatMap((message): ChatMessage[] => {
    if (message.role === 'assistant' && message.tool_calls?.length) {
      const sections: string[] = [];
      if (typeof message.content === 'string' && message.content.trim()) sections.push(message.content.trim());
      for (const toolCall of message.tool_calls) {
        sections.push([
          '[工具调用]',
          `名称: ${toolCall.function.name}`,
          `参数: ${toolCall.function.arguments || '{}'}`,
        ].join('\n'));
      }
      return [{ role: 'assistant', content: sections.join('\n\n') || '[工具调用]' }];
    }
    if (message.role === 'tool') {
      const name = message.tool_call_id ? toolNames.get(message.tool_call_id) : undefined;
      const prefix = name ? `[工具结果: ${name}]` : '[工具结果]';
      return [{ role: 'user', content: `${prefix}\n${message.content}` }];
    }
    // Gitee validates assistant messages strictly. Provider-only reasoning and
    // tool metadata belong to the response path, not historical input.
    if (message.role === 'assistant') {
      return [{ role: 'assistant', content: message.content }];
    }
    return [{ role: message.role, content: message.content }];
  });
}

/**
 * Keep SDK-style `extra_body` useful without allowing it to replace the
 * canonical Chat Completions envelope. Gitee documents `top_k` through
 * Python's extra_body option, while its JavaScript examples send the same
 * field directly; both forms therefore become one top-level wire field.
 */
function providerExtraBody(extra: Record<string, unknown>): Record<string, unknown> {
  const protectedFields = new Set([
    'model', 'messages', 'stream', 'tools', 'tool_choice', 'max_tokens',
    'temperature', 'top_p', 'top_k', 'frequency_penalty', 'presence_penalty',
    'reasoning_effort', 'thinking', 'enable_thinking', 'parallel_tool_calls',
    'tool_stream', 'id_slot', 'cache_prompt', 'return_progress', 'stop',
    'response_format', 'extra_body',
  ]);
  return Object.fromEntries(Object.entries(extra).filter(([key]) => !protectedFields.has(key)));
}

function numericExtra(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function firstStringValue(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === 'string' && value.length > 0);
}

function isGiteeEndpoint(providerId: string, baseUrl: string): boolean {
  return providerId === 'giteeai' || /(?:^|[/:.])ai\.gitee\.com(?:\/|$)/i.test(baseUrl.trim());
}

function normalizeLlamaMessages(messages: ChatMessage[]): ChatMessage[] {
  const systems = messages.filter((message) => message.role === 'system');
  if (systems.length <= 1) {
    return systems.length === 1 && messages[0]?.role !== 'system'
      ? [{ ...systems[0] }, ...messages.filter((message) => message.role !== 'system')]
      : messages;
  }

  const first = systems[0];
  let content = mergeLlamaSystemContent(first.content, systems[1].content);
  for (const system of systems.slice(2)) {
    content = mergeLlamaSystemContent(content, system.content);
  }
  return [
    { ...first, content },
    ...messages.filter((message) => message.role !== 'system'),
  ];
}

/** Provider frames are Suanlizi persistence metadata, never wire-level Chat fields. */
function stripProviderFrames(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((message) => {
    if (!message.providerFrame) return message;
    const { providerFrame: _providerFrame, ...wireMessage } = message;
    return wireMessage;
  });
}

type LlamaPromptProgress = {
  total?: number;
  cache?: number;
  processed?: number;
  timeMs?: number;
};

function parseLlamaPromptProgress(chunk: Record<string, unknown>): LlamaPromptProgress | undefined {
  const raw = asRecord(chunk.prompt_progress) ?? chunk;
  const total = positiveOrZeroNumber(raw.total);
  const cache = positiveOrZeroNumber(raw.cache ?? raw.cache_n);
  const processed = positiveOrZeroNumber(raw.processed ?? raw.prompt_n);
  const timeMs = positiveOrZeroNumber(raw.time_ms ?? raw.timeMs);
  if (total === undefined && cache === undefined && processed === undefined && timeMs === undefined) return undefined;
  return {
    ...(total === undefined ? {} : { total }),
    ...(cache === undefined ? {} : { cache }),
    ...(processed === undefined ? {} : { processed }),
    ...(timeMs === undefined ? {} : { timeMs }),
  };
}

const CONTEXT_METADATA_KEYS = [
  'context_length', 'context_window', 'context_window_tokens', 'max_context_tokens',
  'max_model_len', 'n_ctx', 'n_ctx_train', 'model_n_ctx_train',
] as const;
const OUTPUT_METADATA_KEYS = [
  'max_output_tokens', 'max_completion_tokens', 'max_tokens', 'output_token_limit',
] as const;

function modelListUrls(baseUrl: string): string[] {
  const withoutV1 = baseUrl.replace(/\/v1$/i, '');
  const candidates = [`${baseUrl}/models`];
  if (withoutV1 !== baseUrl) candidates.push(`${withoutV1}/models`);
  else candidates.push(`${baseUrl}/v1/models`);
  return [...new Set(candidates)];
}

function findModelRecord(payload: unknown, modelId: string): Record<string, unknown> | undefined {
  const record = asRecord(payload);
  const entries = Array.isArray(payload)
    ? payload
    : Array.isArray(record?.data) ? record.data : [];
  const normalizedId = modelId.trim();
  return entries
    .map(asRecord)
    .find((entry): entry is Record<string, unknown> => typeof entry?.id === 'string' && entry.id === normalizedId);
}

function mergeModelMetadata(model: Record<string, unknown>): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...model };
  for (const key of ['metadata', 'capabilities', 'limits'] as const) {
    const nested = asRecord(model[key]);
    if (nested) Object.assign(merged, nested);
  }
  return merged;
}

function firstMetadataValue(record: Record<string, unknown>, keys: readonly string[]): unknown {
  for (const key of keys) {
    const direct = record[key];
    if (direct !== undefined) return direct;
    const dotted = record[`model.${key}`];
    if (dotted !== undefined) return dotted;
  }
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function positiveIntegerFrom(value: unknown): number | undefined {
  const numeric = Number(value);
  return Number.isInteger(numeric) && numeric > 0 ? numeric : undefined;
}

function positiveOrZeroNumber(value: unknown): number | undefined {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : undefined;
}

/** Keep provider diagnostics readable when a compatible endpoint wraps them in JSON. */
function formatGatewayErrorBody(body: string): string {
  const trimmed = body.trim();
  if (!trimmed) return 'No error details returned by the provider.';
  try {
    const parsed = JSON.parse(trimmed) as {
      error?: unknown;
      message?: unknown;
    };
    const error = parsed.error;
    if (typeof error === 'string' && error.trim()) return error.trim().slice(0, 500);
    if (error && typeof error === 'object' && typeof (error as { message?: unknown }).message === 'string') {
      const message = (error as { message: string }).message.trim();
      if (message) return message.slice(0, 500);
    }
    if (typeof parsed.message === 'string' && parsed.message.trim()) return parsed.message.trim().slice(0, 500);
  } catch {
    // Plain-text provider responses are already useful diagnostics.
  }
  return trimmed.slice(0, 500);
}

/** Only fall back when the provider explicitly lacks the Responses route. */
function isResponsesUnsupported(status: number, body: string): boolean {
  if (status !== 404 && status !== 405 && status !== 501) return false;
  const details = parseGatewayErrorDetails(body);
  const code = details.code?.toLowerCase() ?? '';
  const message = details.message?.toLowerCase() ?? '';

  // A model/parameter/business error can also be returned as 404/405. Never
  // retry it through Chat Completions, since that can hide the real failure.
  if (/(?:model|request|param|auth|permission|quota|rate|billing|content|token|context|validation|invalid)/.test(code)
    || /\b(?:model|parameter|param|request|quota|billing|token|context|authorization|permission|api key)\b/.test(message)) {
    return false;
  }

  if (!body.trim()) return true;
  const endpointWord = /\b(?:endpoint|route|path|url|responses?)\b/;
  const missingWord = /\b(?:not found|not supported|unsupported|unavailable|does not exist|no such|cannot)\b/;
  if (/(?:endpoint|route|path|url|responses?|method)[\s_-]*(?:not[\s_-]*found|not[\s_-]*supported|unsupported|unavailable|does[\s_-]*not[\s_-]*exist|not[\s_-]*allowed)/.test(code)
    || /(?:not[\s_-]*found|not[\s_-]*supported|unsupported|unavailable|does[\s_-]*not[\s_-]*exist|not[\s_-]*allowed)[\s_-]*(?:endpoint|route|path|url|responses?|method)/.test(code)) return true;
  if ((endpointWord.test(message) && missingWord.test(message))
    || ((status === 405 || status === 501) && /\b(?:method\s+not\s+allowed|unsupported\s+method|not\s+implemented)\b/.test(message))) return true;
  return /^(?:not found|404|method not allowed)$/.test(message);
}

function parseGatewayErrorDetails(body: string): { code?: string; message?: string } {
  const trimmed = body.trim();
  if (!trimmed) return {};
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    const error = asRecord(parsed.error);
    const code = typeof error?.code === 'string'
      ? error.code
      : typeof parsed.code === 'string' ? parsed.code : undefined;
    const message = typeof error?.message === 'string'
      ? error.message
      : typeof parsed.message === 'string'
        ? parsed.message
        : typeof parsed.error === 'string'
          ? parsed.error
          : typeof parsed.detail === 'string' ? parsed.detail : undefined;
    return { code, message };
  } catch {
    return { message: trimmed };
  }
}

function stripTrailingSlashes(url: string): string {
  return url.replace(/\/+$/, '');
}

function ensureDeepSeekChatVersion(url: string): string {
  const normalized = stripTrailingSlashes(url);
  return /\/v1$/i.test(normalized) ? normalized : `${normalized}/v1`;
}

function responsesFailureMessage(raw: Record<string, unknown>): string | undefined {
  if (raw.status !== 'failed') return undefined;
  const error = raw.error && typeof raw.error === 'object' ? raw.error as Record<string, unknown> : undefined;
  if (typeof error?.message === 'string' && error.message.trim()) return error.message.trim().slice(0, 500);
  if (typeof error?.detail === 'string' && error.detail.trim()) return error.detail.trim().slice(0, 500);
  if (typeof raw.message === 'string' && raw.message.trim()) return raw.message.trim().slice(0, 500);
  if (typeof raw.detail === 'string' && raw.detail.trim()) return raw.detail.trim().slice(0, 500);
  return 'provider returned a failed response';
}

function extractStreamProviderError(payload: Record<string, unknown>): string | undefined {
  const source = payload.error ?? (payload.type === 'error' ? payload : undefined);
  if (typeof source === 'string' && source.trim()) return source.trim().slice(0, 500);
  if (source && typeof source === 'object') {
    const message = (source as { message?: unknown }).message;
    if (typeof message === 'string' && message.trim()) return message.trim().slice(0, 500);
    if (payload.type === 'error') return JSON.stringify(source).slice(0, 500);
  }
  if (typeof payload.message === 'string' && payload.message.trim() && !Array.isArray(payload.choices)) {
    return payload.message.trim().slice(0, 500);
  }
  if (typeof payload.detail === 'string' && payload.detail.trim() && !Array.isArray(payload.choices)) {
    return payload.detail.trim().slice(0, 500);
  }
  return undefined;
}

function mergeLlamaSystemContent(
  current: ChatMessage['content'],
  addition: ChatMessage['content'],
): ChatMessage['content'] {
  if (typeof current === 'string' && typeof addition === 'string') {
    return current ? `${current}\n\n${addition}` : addition;
  }
  const asParts = (value: ChatMessage['content']) => (
    typeof value === 'string'
      ? (value ? [{ type: 'text' as const, text: value }] : [])
      : value
  );
  return [...asParts(current), ...asParts(addition)];
}

function isDisabledThinkingEffort(effort: string): boolean {
  return ['no', 'none', 'off', 'disabled', 'disable', 'false', 'minimal', 'low'].includes(effort);
}

function supportsQwenThinking(model: string): boolean {
  return model.includes('qwen3') || model.includes('qwq');
}

function supportsGlmThinking(model: string): boolean {
  return /^glm-(4\.[5-9]|5)(?:\.|$|-)/.test(model);
}

function supportsGlmReasoningEffort(model: string): boolean {
  return /^glm-5\.2(?:$|-)/.test(model);
}

function supportsGlmStreamingToolCalls(model: string): boolean {
  return /^glm-(4\.[6-9]|5)(?:\.|$|-)/.test(model);
}

function supportsDomesticDeepSeekThinking(providerId: string, model: string): boolean {
  return ['volcengine', 'siliconflow'].includes(providerId) && model.includes('deepseek');
}

// 仅基于 usage 字段推断缓存策略（未显式指定时使用）
function inferCacheStrategyFromUsage(usage: Record<string, unknown>): CacheStrategy | undefined {
  if (numberField(usage.prompt_cache_hit_tokens) || numberField(usage.prompt_cache_miss_tokens)) return 'deepseek-native';
  if (numberField(usage.cache_read_input_tokens)) return 'anthropic-cache-control';
  const timings = usage.timings && typeof usage.timings === 'object' ? usage.timings as Record<string, unknown> : usage;
  if (hasNumber(timings.cache_n) || hasNumber(usage.cache_n)) return 'openai-compatible';
  const details = usage.prompt_tokens_details && typeof usage.prompt_tokens_details === 'object'
    ? usage.prompt_tokens_details as Record<string, unknown>
    : {};
  if (numberField(details.cached_tokens) || numberField(usage.cached_tokens)) return 'openai-compatible';
  return undefined;
}

// 数字字段安全读取：非有限数返回 0
function numberField(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function hasNumber(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(value);
}

function firstPresentNumber(...values: unknown[]): number | undefined {
  for (const value of values) if (hasNumber(value)) return numberField(value);
  return undefined;
}

// ─── OpenAI → Anthropic Conversion ──────────────────────────────────────────

// 把 OpenAI 形态的请求转成 Anthropic 形态
function convertToAnthropic(
  req: Omit<ChatCompletionRequest, 'model' | 'stream'>,
  config: ModelConfig,
  cacheStrategy: CacheStrategy = 'anthropic-cache-control',
): AnthropicMessageRequest {
  const messages = req.messages;
  let system: AnthropicMessageRequest['system'];

  // 抽离 system 消息：Anthropic 用顶层 system 字段
  const systemMsg = messages.find((m) => m.role === 'system');
  if (systemMsg) {
    const systemText = typeof systemMsg.content === 'string'
      ? systemMsg.content
      : systemMsg.content.map((c) => ('text' in c ? c.text : '')).join('\n');
    if (systemText) {
      system = cacheStrategy === 'anthropic-cache-control'
        ? [{ type: 'text', text: systemText, cache_control: { type: 'ephemeral' } }]
        : [{ type: 'text', text: systemText }];
    }
  }

  // 转换其余消息
  const anthroMessages: AnthropicMessageRequest['messages'] = [];
  for (const msg of messages) {
    if (msg.role === 'system') continue;

    if (msg.role === 'assistant' && msg.providerFrame?.format === 'anthropic_messages') {
      const last = anthroMessages[anthroMessages.length - 1];
      if (last && last.role === 'assistant') {
        last.content.push(...msg.providerFrame.contentBlocks);
      } else {
        anthroMessages.push({ role: 'assistant', content: [...msg.providerFrame.contentBlocks] });
      }
      continue;
    }

    if (msg.role === 'tool' && msg.tool_call_id) {
      const text = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
      appendAnthropicToolResultIfValid(anthroMessages, {
        type: 'tool_result',
        tool_use_id: msg.tool_call_id,
        content: text,
      });
      continue;
    }

    const blocks: AnthropicContentBlock[] = [];

    // 文本内容
    if (typeof msg.content === 'string') {
      blocks.push({ type: 'text', text: msg.content });
    } else if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (part.type === 'text') {
          blocks.push({ type: 'text', text: part.text });
        } else if (part.type === 'image_url') {
          // Anthropic 不支持在线图片，降级为占位文本
          blocks.push({
            type: 'text',
            text: `[Image: ${part.image_url.url}]`,
          });
        }
      }
    }

    // 工具调用（assistant 消息）
    if (msg.tool_calls && msg.tool_calls.length > 0) {
      for (const tc of msg.tool_calls) {
        let input: Record<string, unknown>;
        try {
          input = JSON.parse(tc.function.arguments);
        } catch {
          // 解析失败：原样包到 _raw
          input = { _raw: tc.function.arguments };
        }
        blocks.push({
          type: 'tool_use',
          id: tc.id,
          name: tc.function.name,
          input,
        });
      }
    }

    if (blocks.length === 0) continue;

    // 归一化角色：Anthropic 只允许 user/assistant
    const role: 'user' | 'assistant' = msg.role as 'user' | 'assistant';

    // 合并相邻同角色消息
    const last = anthroMessages[anthroMessages.length - 1];
    if (last && last.role === role) {
      last.content.push(...blocks);
    } else {
      anthroMessages.push({ role, content: blocks });
    }
  }

  // 给最后一条 user 文本块打 cache_control 标记
  if (cacheStrategy === 'anthropic-cache-control') {
    markLastUserTextBlockCacheable(anthroMessages);
  }

  // 转换 tools 定义
  const tools: AnthropicMessageRequest['tools'] = req.tools?.map((t) => ({
    name: t.function.name,
    description: t.function.description,
    input_schema: {
      type: 'object' as const,
      properties: (t.function.parameters as Record<string, unknown>)?.properties as Record<string, unknown> ?? {},
      required: (t.function.parameters as Record<string, unknown>)?.required as string[] | undefined,
    },
  }));

  return {
    model: config.model,
    system: system || undefined,
    messages: anthroMessages,
    tools,
    max_tokens: req.max_tokens ?? config.maxTokens ?? 8192,
    temperature: req.temperature ?? config.temperature,
    top_p: req.top_p ?? config.topP,
    ...(isMiniMaxM3(config) ? { thinking: miniMaxThinkingFromEffort(config.reasoningEffort) } : {}),
    stop_sequences: req.stop,
  };
}

function isMiniMaxM3(config: Pick<ModelConfig, 'provider' | 'model'>): boolean {
  return config.provider.trim().toLowerCase() === 'minimax'
    && config.model.trim().toLowerCase() === 'minimax-m3';
}

function appendAnthropicToolResultIfValid(
  messages: AnthropicMessageRequest['messages'],
  block: Extract<AnthropicContentBlock, { type: 'tool_result' }>,
): void {
  const last = messages[messages.length - 1];
  if (last?.role === 'assistant' && hasAnthropicToolUse(last.content, block.tool_use_id)) {
    messages.push({ role: 'user', content: [block] });
    return;
  }

  if (
    last?.role === 'user'
    && last.content.length > 0
    && last.content.every((entry) => entry.type === 'tool_result')
    && !last.content.some((entry) => entry.type === 'tool_result' && entry.tool_use_id === block.tool_use_id)
  ) {
    const previous = messages[messages.length - 2];
    if (previous?.role === 'assistant' && hasAnthropicToolUse(previous.content, block.tool_use_id)) {
      last.content.push(block);
    }
  }
}

function hasAnthropicToolUse(blocks: AnthropicContentBlock[], toolUseId: string): boolean {
  return blocks.some((block) => block.type === 'tool_use' && block.id === toolUseId);
}

function miniMaxThinkingFromEffort(effort: ModelConfig['reasoningEffort'] | undefined): NonNullable<AnthropicMessageRequest['thinking']> | undefined {
  const normalized = typeof effort === 'string' ? effort.trim().toLowerCase() : '';
  if (['no', 'low', 'none', 'off', 'disabled', 'disable', 'false', 'minimal'].includes(normalized)) {
    return undefined;
  }
  return { type: 'adaptive' };
}

// 找到最后一条 user 消息的最后一个 text 块，标记为可缓存
function markLastUserTextBlockCacheable(messages: AnthropicMessageRequest['messages']): void {
  for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex--) {
    const message = messages[messageIndex];
    if (message.role !== 'user') continue;
    for (let blockIndex = message.content.length - 1; blockIndex >= 0; blockIndex--) {
      const block = message.content[blockIndex];
      if (block.type !== 'text') continue;
      block.cache_control = { type: 'ephemeral' };
      return;
    }
  }
}

// ─── Anthropic → OpenAI Response Conversion ─────────────────────────────────
// 把 Anthropic 响应转成统一 ChatCompletionResponse
function convertAnthropicResponse(
  anthroResp: AnthropicMessageResponse,
  model: string,
  cacheStrategy: CacheStrategy,
): ChatCompletionResponse {
  const textBlocks = anthroResp.content.filter((b) => b.type === 'text') as Array<{ type: 'text'; text: string }>;
  const toolUseBlocks = anthroResp.content.filter((b) => b.type === 'tool_use') as Array<{
    type: 'tool_use';
    id: string;
    name: string;
    input: Record<string, unknown>;
  }>;

  const text = textBlocks.map((b) => b.text).join('\n');
  const toolCalls: ToolCall[] = toolUseBlocks.map((b) => ({
    id: b.id,
    type: 'function' as const,
    function: {
      name: b.name,
      arguments: JSON.stringify(b.input),
    },
  }));

  return {
    id: anthroResp.id,
    object: 'chat.completion',
    created: Date.now(),
    model,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: text || '',
          tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
        },
        // stop_reason: tool_use → tool_calls，其它都映射为 stop
        finish_reason: anthroResp.stop_reason === 'tool_use' ? 'tool_calls' : 'stop',
      },
    ],
    usage: normalizeUsage(anthroResp.usage, cacheStrategy),
  };
}

// ─── Stream Parsers ─────────────────────────────────────────────────────────

// 解析 OpenAI 风格 SSE 流：data: <json>，以 [DONE] 结尾
async function* parseOpenAIStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  cacheStrategy: CacheStrategy,
  isLlama = false,
): AsyncGenerator<StreamEvent> {
  const decoder = new TextDecoder();
  let buffer = '';
  let pendingContent = '';
  let taggedContentBuffer = '';
  let insideThink = false;
  let protocolErrorEmitted = false;
  let streamErrorEmitted = false;
  let doneEmitted = false;
  let finalUsage: NormalizedUsage | undefined;
  let usagePayload: Record<string, unknown> = {};
  // Accumulate one call per choice/index. The generated id remains stable if
  // llama.cpp sends the provider id only after the first tool delta.
  const toolCalls: Map<string, {
    id: string;
    name: string;
    args: string;
    started: boolean;
    ended: boolean;
  }> = new Map();

  const protocolErrorMessage = 'llama.cpp 返回了无法解析的工具协议文本，请检查 chat template/tool-use 配置。';
  const protocolPrefixes = ['<tool_call', '<function', '<invoke', '<|tool', '<|function'];
  const protocolTagPattern = /<\/?tool_call\s*>|<\/?function\s*=\s*[^>\r\n]*>|<\/?invoke\s*>|<\|(?:tool|function)[^>\r\n]*>/i;

  const isPotentialProtocolPrefix = (value: string): boolean => {
    const suffix = value.slice(value.lastIndexOf('<')).toLowerCase();
    const compactSuffix = suffix.replace(/\s+/g, '');
    return protocolPrefixes.some((prefix) => prefix.startsWith(compactSuffix) || compactSuffix.startsWith(prefix));
  };

  const emitNormalContent = function* (content: string): Generator<StreamEvent> {
    if (!content || protocolErrorEmitted) return;
    pendingContent += content;
    const protocolMatch = protocolTagPattern.exec(pendingContent);
    if (protocolMatch && protocolMatch.index >= 0) {
      const safe = pendingContent.slice(0, protocolMatch.index);
      pendingContent = '';
      if (safe) yield { type: 'delta', content: safe };
      protocolErrorEmitted = true;
      yield { type: 'protocol_error', message: protocolErrorMessage };
      return;
    }

    // Keep only a possible split protocol tag. This preserves ordinary angle
    // bracket text immediately while still catching tags split across chunks.
    const lastLt = pendingContent.lastIndexOf('<');
    if (lastLt >= 0 && isPotentialProtocolPrefix(pendingContent)) {
      const safe = pendingContent.slice(0, lastLt);
      pendingContent = pendingContent.slice(lastLt);
      if (safe) yield { type: 'delta', content: safe };
      return;
    }
    yield { type: 'delta', content: pendingContent };
    pendingContent = '';
  };

  const thinkOpenPattern = /<think\s*>/i;
  const thinkClosePattern = /<\/think\s*>/i;
  const possibleThinkSuffix = (value: string, closing: boolean): { index: number; suffix: string } | undefined => {
    const index = value.lastIndexOf('<');
    if (index < 0) return undefined;
    const suffix = value.slice(index);
    const compact = suffix.toLowerCase().replace(/\s+/g, '');
    const prefix = closing ? '</think' : '<think';
    if (prefix.startsWith(compact)) return { index, suffix };
    return undefined;
  };
  const emitReasoning = function* (reasoning: string): Generator<StreamEvent> {
    if (reasoning.trim()) yield { type: 'reasoning_delta', content: reasoning };
  };

  // Providers such as Gitee/Qwen may embed reasoning in the text stream. Keep
  // the tags out of visible content while supporting tags split across chunks.
  const emitSafeContent = function* (content: string): Generator<StreamEvent> {
    if (!content || protocolErrorEmitted) return;
    taggedContentBuffer += content;
    while (taggedContentBuffer) {
      if (insideThink) {
        const close = thinkClosePattern.exec(taggedContentBuffer);
        if (close) {
          yield* emitReasoning(taggedContentBuffer.slice(0, close.index));
          taggedContentBuffer = taggedContentBuffer.slice(close.index + close[0].length);
          insideThink = false;
          continue;
        }
        const partial = possibleThinkSuffix(taggedContentBuffer, true);
        if (partial) {
          yield* emitReasoning(taggedContentBuffer.slice(0, partial.index));
          taggedContentBuffer = partial.suffix;
        } else {
          yield* emitReasoning(taggedContentBuffer);
          taggedContentBuffer = '';
        }
        return;
      }

      const open = thinkOpenPattern.exec(taggedContentBuffer);
      if (open) {
        yield* emitNormalContent(taggedContentBuffer.slice(0, open.index));
        taggedContentBuffer = taggedContentBuffer.slice(open.index + open[0].length);
        insideThink = true;
        continue;
      }
      const partial = possibleThinkSuffix(taggedContentBuffer, false);
      if (partial) {
        yield* emitNormalContent(taggedContentBuffer.slice(0, partial.index));
        taggedContentBuffer = partial.suffix;
      } else {
        yield* emitNormalContent(taggedContentBuffer);
        taggedContentBuffer = '';
      }
      return;
    }
  };

  const flushTaggedContent = function* (): Generator<StreamEvent> {
    if (!taggedContentBuffer) return;
    if (insideThink) {
      const partial = possibleThinkSuffix(taggedContentBuffer, true);
      yield* emitReasoning(partial ? taggedContentBuffer.slice(0, partial.index) : taggedContentBuffer);
    } else {
      const partial = possibleThinkSuffix(taggedContentBuffer, false);
      yield* emitNormalContent(partial ? taggedContentBuffer.slice(0, partial.index) : taggedContentBuffer);
    }
    taggedContentBuffer = '';
  };

  const emitDone = function* (): Generator<StreamEvent> {
    if (doneEmitted) return;
    doneEmitted = true;
    yield* flushTaggedContent();
    if (!protocolErrorEmitted && pendingContent) {
      yield { type: 'delta', content: pendingContent };
      pendingContent = '';
    }
    for (const tc of toolCalls.values()) {
      if (tc.name && !tc.ended) {
        tc.ended = true;
        yield { type: 'tool_call_end', id: tc.id, name: tc.name, arguments: tc.args };
      }
    }
    yield { type: 'done', ...(finalUsage ? { usage: finalUsage } : {}) };
  };

  const updateUsage = (chunk: Record<string, unknown>, progress?: LlamaPromptProgress): void => {
    const rawUsage = chunk.usage && typeof chunk.usage === 'object'
      ? chunk.usage as Record<string, unknown>
      : {};
    const rawTimings = chunk.timings && typeof chunk.timings === 'object'
      ? chunk.timings as Record<string, unknown>
      : undefined;
    const hasUsage = Object.keys(rawUsage).length > 0
      || rawTimings !== undefined
      || typeof chunk.cache === 'number'
      || typeof chunk.processed === 'number'
      || progress !== undefined;
    if (!hasUsage) return;

    const previousTimings = usagePayload.timings && typeof usagePayload.timings === 'object'
      ? usagePayload.timings as Record<string, unknown>
      : {};
    usagePayload = {
      ...usagePayload,
      ...rawUsage,
      ...(rawTimings ? { timings: { ...previousTimings, ...rawTimings } } : {}),
      ...(typeof chunk.cache === 'number' || progress?.cache !== undefined
        ? { cache_n: typeof chunk.cache === 'number' ? chunk.cache : progress?.cache } : {}),
      ...(typeof chunk.processed === 'number' || progress?.processed !== undefined
        ? { prompt_n: typeof chunk.processed === 'number' ? chunk.processed : progress?.processed } : {}),
    };
    finalUsage = normalizeUsage(usagePayload, cacheStrategy);
  };

  const processLine = function* (line: string): Generator<StreamEvent> {
    if (doneEmitted || streamErrorEmitted) return;
    const trimmed = line.trim();
    if (!trimmed || !trimmed.startsWith('data:')) return;
    const data = trimmed.slice(5).trimStart();
    if (data === '[DONE]') {
      yield* emitDone();
      return;
    }

    try {
      const parsed = JSON.parse(data) as Record<string, unknown>;
      const providerError = extractStreamProviderError(parsed);
      if (providerError) {
        streamErrorEmitted = true;
        yield { type: 'error', error: new Error(providerError) };
        return;
      }
      const promptProgress = isLlama ? parseLlamaPromptProgress(parsed) : undefined;
      if (promptProgress) {
        yield {
          type: 'prompt_progress',
          ...(promptProgress.total === undefined ? {} : { total: promptProgress.total }),
          ...(promptProgress.cache === undefined ? {} : { cache: promptProgress.cache }),
          ...(promptProgress.processed === undefined ? {} : { processed: promptProgress.processed }),
          ...(promptProgress.timeMs === undefined ? {} : { timeMs: promptProgress.timeMs }),
        };
      }
      updateUsage(parsed, promptProgress);
      const choices = Array.isArray(parsed.choices) ? parsed.choices : [];
      for (let choicePosition = 0; choicePosition < choices.length; choicePosition++) {
        const rawChoice = choices[choicePosition];
        if (!rawChoice || typeof rawChoice !== 'object') continue;
        const choice = rawChoice as Record<string, unknown>;
        const delta = choice.delta && typeof choice.delta === 'object'
          ? choice.delta as Record<string, unknown>
          : {};
        const reasoningContent = firstStringValue(delta.reasoning_content, delta.reasoning, delta.thinking);
        if (reasoningContent) {
          yield { type: 'reasoning_delta', content: reasoningContent };
        }
        const content = delta.content;
        if (typeof content === 'string') yield* emitSafeContent(content);

        const rawToolCalls = delta.tool_calls;
        if (Array.isArray(rawToolCalls)) {
          const choiceIndex = typeof choice.index === 'number' ? choice.index : choicePosition;
          for (const rawToolCall of rawToolCalls) {
            if (!rawToolCall || typeof rawToolCall !== 'object') continue;
            const tc = rawToolCall as Record<string, unknown>;
            const toolIndex = typeof tc.index === 'number' ? tc.index : 0;
            const key = `${choiceIndex}:${toolIndex}`;
            let entry = toolCalls.get(key);
            if (!entry) {
              entry = {
                id: `tool_${key.replace(':', '_')}`,
                name: '',
                args: '',
                started: false,
                ended: false,
              };
              toolCalls.set(key, entry);
            }

            const providerId = typeof tc.id === 'string' && tc.id.trim() ? tc.id.trim() : undefined;
            if (providerId && !entry.started) entry.id = providerId;

            const fn = tc.function && typeof tc.function === 'object'
              ? tc.function as Record<string, unknown>
              : {};
            if (typeof fn.name === 'string' && fn.name) {
              entry.name += fn.name;
              if (!entry.started) {
                entry.started = true;
                yield { type: 'tool_call_start', id: entry.id, name: entry.name };
              }
            }
            if (typeof fn.arguments === 'string' && fn.arguments) {
              entry.args += fn.arguments;
              yield { type: 'tool_call_delta', id: entry.id, arguments: entry.args };
            }
          }
        }

      }
      // Providers may send a usage/timings-only frame after finish_reason.
      // Wait for [DONE] or EOF before finalizing so that frame is retained.
    } catch {
      // 不再静默吞掉 data 行的非法 JSON；runtime 需要区分“服务端协议格式错误”
      // 与“工具实际执行失败”，否则 UI 只能看到一个永远进行中的工具批次。
      if (!protocolErrorEmitted) {
        protocolErrorEmitted = true;
        yield { type: 'protocol_error', message: '模型流格式错误：服务端返回了无法解析的 SSE JSON。' };
      }
    }
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) yield* processLine(line);
    }

    buffer += decoder.decode();
    if (buffer) yield* processLine(buffer);
    if (!doneEmitted && !streamErrorEmitted) yield* emitDone();
  } catch (err) {
    if (!doneEmitted && !streamErrorEmitted) yield { type: 'error', error: err instanceof Error ? err : new Error(String(err)) };
  } finally {
    reader.releaseLock();
  }
}

// 解析 Anthropic 风格 SSE 流：先 event: <type> 后 data: <json>
async function* parseAnthropicStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  cacheStrategy: CacheStrategy,
): AsyncGenerator<StreamEvent> {
  const decoder = new TextDecoder();
  let buffer = '';
  const toolCalls: Map<number, { id: string; name: string; args: string }> = new Map();
  const blockTypes: Map<number, AnthropicContentBlock['type']> = new Map();
  let currentToolIndex = 0;
  let doneEmitted = false;
  let protocolErrorEmitted = false;
  // 用 message_start / message_delta 累积 usage
  let usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  } | undefined;

  const emitDone = function* (): Generator<StreamEvent> {
    if (doneEmitted) return;
    doneEmitted = true;
    for (const [, tc] of toolCalls) {
      if (tc.name) yield { type: 'tool_call_end', id: tc.id, name: tc.name, arguments: tc.args };
    }
    yield {
      type: 'done',
      usage: normalizeUsage(usage, cacheStrategy),
    };
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (doneEmitted) continue;
        const trimmed = line.trim();
        if (!trimmed) continue;

        // Anthropic SSE：先 "event: <type>" 后 "data: <json>"
        if (trimmed.startsWith('event: ')) continue;

        if (!trimmed.startsWith('data: ')) continue;
        const data = trimmed.slice(6);

        try {
          const event = JSON.parse(data) as AnthropicSSEEvent;

          switch (event.type) {
            case 'message_start':
              // 首次拿到完整 usage
              if (event.message?.usage) usage = event.message.usage;
              break;

            case 'content_block_start': {
              // 工具调用开始
              const block = event.content_block;
              if (block && typeof event.index === 'number') {
                blockTypes.set(event.index, block.type);
              }
              if (block?.type === 'tool_use') {
                const idx = currentToolIndex++;
                toolCalls.set(idx, { id: block.id, name: block.name, args: '' });
                yield { type: 'tool_call_start', id: block.id, name: block.name };
              }
              break;
            }

            case 'content_block_delta': {
              // 文本或工具参数增量
              const delta = event.delta;
              if (!delta) break;
              const blockType = typeof event.index === 'number' ? blockTypes.get(event.index) : undefined;
              if (delta.type === 'thinking_delta' && delta.thinking) {
                yield { type: 'reasoning_delta', content: delta.thinking };
              }
              if (delta.type === 'text_delta' && delta.text && blockType === 'thinking') {
                yield { type: 'reasoning_delta', content: delta.text };
              } else if (delta.type === 'text_delta' && delta.text) {
                yield { type: 'delta', content: delta.text };
              }
              if (delta.type === 'input_json_delta' && delta.partial_json) {
                // 拼到当前正在构建的工具调用
                const entry = toolCalls.get(currentToolIndex - 1);
                if (entry) {
                  entry.args += delta.partial_json;
                  yield { type: 'tool_call_delta', id: entry.id, arguments: entry.args };
                }
              }
              break;
            }

            case 'content_block_stop':
              // 单个内容块结束（无需处理）
              break;

            case 'message_delta':
              // 用最终 usage 覆盖之前的
              if (event.usage) {
                usage = { ...(usage ?? { input_tokens: 0, output_tokens: 0 }), ...event.usage };
              }
              break;

            case 'message_stop':
              // flush 工具调用并发出 done
              yield* emitDone();
              break;

            case 'ping':
              // 心跳
              break;
          }
        } catch {
          // Anthropic 兼容流同样需要把非法 data 明确标记为协议错误。
          if (!protocolErrorEmitted) {
            protocolErrorEmitted = true;
            yield { type: 'protocol_error', message: '模型流格式错误：服务端返回了无法解析的 SSE JSON。' };
          }
        }
      }
    }
    // Some compatible gateways close without message_stop. Always publish one
    // terminal event so runtime can finalize the turn and persist the last
    // usage snapshot.
    if (!doneEmitted) yield* emitDone();
  } catch (err) {
    yield { type: 'error', error: err instanceof Error ? err : new Error(String(err)) };
  } finally {
    reader.releaseLock();
  }
}
