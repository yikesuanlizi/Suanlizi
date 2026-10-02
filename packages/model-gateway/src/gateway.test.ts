import { afterEach, describe, expect, it } from 'vitest';
import {
  convertOpenAIResponseForTest,
  estimateChatTokens,
  ModelGateway,
  normalizeUsage,
  resolveCacheStrategy,
} from './gateway.js';
import { getProviderProfile, resolveProviderProfile } from './providerProfiles.js';
import {
  buildAnthropicToolHistory,
  buildOpenAiChatToolHistory,
  type ProviderAssistantFrame,
} from './providerFrames.js';
import type { ChatMessage } from './types.js';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('estimateChatTokens', () => {
  it('estimates tokens before sending a request', () => {
    const estimate = estimateChatTokens([
      { role: 'system', content: '你是一个本地编程助手。' },
      { role: 'user', content: [
        { type: 'text', text: '请总结这个文件' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,abc' } },
      ] },
    ]);

    expect(estimate.inputTokens).toBeGreaterThan(0);
    expect(estimate.messageCount).toBe(2);
    expect(estimate.imageCount).toBe(1);
  });
});

describe('normalizeUsage', () => {
  it('reads DeepSeek native prompt cache hit and miss fields first', () => {
    expect(normalizeUsage({
      prompt_cache_hit_tokens: 80,
      prompt_cache_miss_tokens: 20,
      completion_tokens: 12,
    }, 'deepseek-native')).toEqual({
      prompt_tokens: 100,
      completion_tokens: 12,
      total_tokens: 112,
      cached_tokens: 80,
      cache_reported: true,
      cache_source: 'deepseek',
      cache_strategy: 'deepseek-native',
    });
  });

  it('falls back to OpenAI cached_tokens details', () => {
    expect(normalizeUsage({
      prompt_tokens: 100,
      completion_tokens: 8,
      total_tokens: 108,
      prompt_tokens_details: { cached_tokens: 60 },
    }, 'openai-compatible')).toMatchObject({
      prompt_tokens: 100,
      completion_tokens: 8,
      cached_tokens: 60,
      cache_strategy: 'openai-compatible',
    });
  });

  it('falls back to Anthropic cache read input tokens', () => {
    expect(normalizeUsage({
      input_tokens: 90,
      output_tokens: 10,
      cache_read_input_tokens: 70,
    }, 'anthropic-cache-control')).toEqual({
      prompt_tokens: 90,
      completion_tokens: 10,
      total_tokens: 100,
      cached_tokens: 70,
      cache_reported: true,
      cache_source: 'anthropic',
      cache_strategy: 'anthropic-cache-control',
    });
  });

  it('保留 Anthropic prompt cache creation tokens for monitor accounting', () => {
    expect(normalizeUsage({
      input_tokens: 90,
      output_tokens: 10,
      cache_read_input_tokens: 70,
      cache_creation_input_tokens: 20,
    }, 'anthropic-cache-control')).toMatchObject({
      cached_tokens: 70,
      cache_creation_tokens: 20,
      cache_reported: true,
    });
  });

  it('normalizes OpenAI-compatible usage from the first choice when top-level usage is missing', () => {
    const response = convertOpenAIResponseForTest({
      id: 'cmpl_choice_usage',
      object: 'chat.completion',
      created: 1,
      model: 'kimi-k3',
      choices: [{
        index: 0,
        message: { role: 'assistant', content: 'ok' },
        finish_reason: 'stop',
        usage: {
          prompt_tokens: 11,
          completion_tokens: 7,
          total_tokens: 18,
        },
      }],
    });

    expect(response.usage).toEqual({
      prompt_tokens: 11,
      completion_tokens: 7,
      total_tokens: 18,
      cached_tokens: 0,
      cache_reported: false,
    });
  });

  it('maps provider reasoning aliases to reasoning_content in non-stream responses', () => {
    const response = convertOpenAIResponseForTest({
      id: 'cmpl_reasoning_alias',
      object: 'chat.completion',
      created: 1,
      model: 'qwen3.8-flash',
      choices: [{
        index: 0,
        message: { role: 'assistant', content: 'ok', reasoning: '先检查请求。' } as ChatMessage,
        finish_reason: 'stop',
      }],
    });

    expect(response.choices[0]?.message.reasoning_content).toBe('先检查请求。');
  });

  it('moves tagged reasoning out of non-stream assistant content', () => {
    const response = convertOpenAIResponseForTest({
      id: 'cmpl_tagged_reasoning',
      object: 'chat.completion',
      created: 1,
      model: 'qwen3.8-flash',
      choices: [{
        index: 0,
        message: { role: 'assistant', content: '<think>先检查参数。</think>最终答案' },
        finish_reason: 'stop',
      }],
    });

    expect(response.choices[0]?.message.content).toBe('最终答案');
    expect(response.choices[0]?.message.reasoning_content).toBe('先检查参数。');
    expect(JSON.stringify(response)).not.toContain('<think>');
  });

  it('drops empty tagged reasoning without creating a reasoning field', () => {
    const response = convertOpenAIResponseForTest({
      id: 'cmpl_empty_tagged_reasoning',
      object: 'chat.completion',
      created: 1,
      model: 'qwen3.8-flash',
      choices: [{
        index: 0,
        message: { role: 'assistant', content: '<think> </think>你好！' },
        finish_reason: 'stop',
      }],
    });

    expect(response.choices[0]?.message.content).toBe('你好！');
    expect(response.choices[0]?.message.reasoning_content).toBeUndefined();
  });

  it('reads llama.cpp cache_n/prompt_n timings and reports the source', () => {
    expect(normalizeUsage({
      timings: { cache_n: 26_529, prompt_n: 650 },
      completion_tokens: 4,
    })).toMatchObject({
      prompt_tokens: 27_179,
      cached_tokens: 26_529,
      cache_reported: true,
      cache_source: 'llama-timings',
    });
  });
});

describe('resolveCacheStrategy', () => {
  it('uses DeepSeek native cache accounting for DeepSeek providers and models', () => {
    expect(resolveCacheStrategy({ provider: 'deepseek', model: 'deepseek-v4-pro' })).toBe('deepseek-native');
    expect(resolveCacheStrategy({ provider: 'openai_compatible', model: 'deepseek-chat' })).toBe('deepseek-native');
  });

  it('uses OpenAI-compatible cache accounting for compatible providers by default', () => {
    expect(resolveCacheStrategy({ provider: 'openai', model: 'gpt-5' })).toBe('openai-compatible');
    expect(resolveCacheStrategy({ provider: 'openai_compatible', model: 'qwen-plus' })).toBe('openai-compatible');
  });

  it('allows explicit cache strategy overrides including disabling cache accounting', () => {
    expect(resolveCacheStrategy({ provider: 'deepseek', model: 'deepseek-chat', cacheStrategy: 'openai-compatible' })).toBe('openai-compatible');
    expect(resolveCacheStrategy({ provider: 'deepseek', model: 'deepseek-chat', cacheStrategy: 'none' })).toBe('none');
  });
});

describe('model request timeout and retry signals', () => {
  it('creates a fresh timeout signal for every OpenAI-compatible retry', async () => {
    const signals: AbortSignal[] = [];
    globalThis.fetch = async (_url, init) => {
      signals.push(init?.signal as AbortSignal);
      throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    };
    const gateway = new ModelGateway({
      provider: 'openai',
      baseUrl: 'http://127.0.0.1:8080/v1',
      model: 'test-model',
      timeoutMs: 10,
      retry: { maxAttempts: 2, initialDelayMs: 0, maxDelayMs: 0 },
    });

    await expect(gateway.chat({ messages: [{ role: 'user', content: 'hello' }] }))
      .rejects.toMatchObject({ code: 'MODEL_REQUEST_TIMEOUT', timeoutMs: 10 });
    expect(signals).toHaveLength(2);
    expect(signals[0]).not.toBe(signals[1]);
  });
});

describe('provider profiles', () => {
  it('maps OpenAI to the native Responses transport', () => {
    const profile = getProviderProfile('openai');
    expect(profile).toMatchObject({
      id: 'openai',
      endpointFormat: 'responses',
      transport: 'openai_responses',
      reasoningMode: 'openai_responses_items',
      toolHistoryMode: 'openai_responses',
      cacheMode: 'openai_prompt_details',
    });
  });

  it('maps MiniMax to Anthropic Messages with MiniMax reasoning mode', () => {
    const profile = getProviderProfile('minimax');
    expect(profile).toMatchObject({
      id: 'minimax',
      endpointFormat: 'anthropic_messages',
      transport: 'anthropic_messages',
      reasoningMode: 'minimax_anthropic_thinking',
      toolHistoryMode: 'anthropic_blocks',
      cacheMode: 'anthropic_cache_control',
    });
  });

  it('maps DeepSeek to Chat Completions with native reasoning and cache modes', () => {
    const profile = getProviderProfile('deepseek');
    expect(profile).toMatchObject({
      id: 'deepseek',
      endpointFormat: 'chat_completions',
      transport: 'openai_chat_completions',
      reasoningMode: 'deepseek_reasoning_content',
      toolHistoryMode: 'openai_chat',
      cacheMode: 'deepseek_native',
    });
  });

  it('maps llama.cpp to the local Responses transport', () => {
    expect(getProviderProfile('llama.cpp')).toMatchObject({
      id: 'llama_cpp',
      displayName: 'llama.cpp',
      endpointFormat: 'responses',
      transport: 'openai_responses',
      reasoningMode: 'openai_responses_items',
      toolHistoryMode: 'openai_responses',
    });
  });

  it('maps providers with official Responses routes to Responses transport', () => {
    const providerIds = [
      'xai',
      'groq',
      'openrouter',
      'huggingface',
    ];

    for (const providerId of providerIds) {
      expect(getProviderProfile(providerId)).toMatchObject({
        id: providerId,
        endpointFormat: 'responses',
        transport: 'openai_responses',
        reasoningMode: 'openai_responses_items',
        toolHistoryMode: 'openai_responses',
        cacheMode: 'openai_prompt_details',
      });
    }
  });

  it('keeps providers without a confirmed Responses route on Chat Completions', () => {
    const providerIds = [
      'gemini',
      'mistral',
      'perplexity',
      'qwen',
      'zhipu',
      'kimi',
      'volcengine',
      'baidu',
      'siliconflow',
      'together',
    ];

    for (const providerId of providerIds) {
      expect(getProviderProfile(providerId)).toMatchObject({
        id: providerId,
        endpointFormat: 'chat_completions',
        transport: 'openai_chat_completions',
        reasoningMode: 'none',
        toolHistoryMode: 'openai_chat',
        cacheMode: 'openai_prompt_details',
      });
    }
  });

  it('selects DeepSeek and Kimi Responses only for supported model families', () => {
    expect(resolveProviderProfile({ provider: 'deepseek', baseUrl: '', model: 'deepseek-v4-pro' })).toMatchObject({
      endpointFormat: 'responses',
      transport: 'openai_responses',
    });
    expect(resolveProviderProfile({ provider: 'deepseek', baseUrl: '', model: 'deepseek-chat' })).toMatchObject({
      endpointFormat: 'chat_completions',
      transport: 'openai_chat_completions',
    });
    expect(resolveProviderProfile({ provider: 'kimi', baseUrl: '', model: 'kimi-k3' })).toMatchObject({
      endpointFormat: 'responses',
      transport: 'openai_responses',
    });
    expect(resolveProviderProfile({ provider: 'kimi', baseUrl: '', model: 'kimi-k2' })).toMatchObject({
      endpointFormat: 'chat_completions',
      transport: 'openai_chat_completions',
    });
  });

  it('does not route unknown DeepSeek v4 aliases or embedded Kimi k3 names to Responses', () => {
    expect(resolveProviderProfile({ provider: 'deepseek', baseUrl: '', model: 'deepseek-v4-ultra' })).toMatchObject({
      endpointFormat: 'chat_completions',
      transport: 'openai_chat_completions',
    });
    expect(resolveProviderProfile({ provider: 'deepseek', baseUrl: '', model: 'deepseek-v4-pro-preview' })).toMatchObject({
      endpointFormat: 'chat_completions',
      transport: 'openai_chat_completions',
    });
    expect(resolveProviderProfile({ provider: 'kimi', baseUrl: '', model: 'my-kimi-k3-proxy' })).toMatchObject({
      endpointFormat: 'chat_completions',
      transport: 'openai_chat_completions',
    });
    expect(resolveProviderProfile({ provider: 'deepseek', baseUrl: '', model: 'deepseek-v4-pro-v2-preview' })).toMatchObject({
      endpointFormat: 'chat_completions',
      transport: 'openai_chat_completions',
    });
  });

  it('allows only explicit numeric versions of the published DeepSeek v4 aliases', () => {
    for (const model of ['deepseek-v4-flash-v2', 'deepseek-v4-pro-2025-01', 'deepseek-v4-flash-vision-exp-v1.1']) {
      expect(resolveProviderProfile({ provider: 'deepseek', baseUrl: '', model })).toMatchObject({
        endpointFormat: 'responses',
        transport: 'openai_responses',
      });
    }
  });

  it('normalizes provider aliases before resolving profiles', () => {
    expect(getProviderProfile('google')).toMatchObject({
      id: 'gemini',
      displayName: 'Google Gemini',
    });
    expect(getProviderProfile('grok')).toMatchObject({
      id: 'xai',
      displayName: 'xAI',
    });
    expect(getProviderProfile('moonshot')).toMatchObject({
      id: 'kimi',
      displayName: 'Kimi (Moonshot)',
    });
    expect(getProviderProfile('dashscope')).toMatchObject({
      id: 'qwen',
      displayName: '通义千问 (Qwen)',
    });
  });

  it('resolves unknown providers to generic OpenAI-compatible behavior', () => {
    const profile = resolveProviderProfile({
      provider: 'my_gateway',
      baseUrl: 'https://example.test/v1',
      model: 'custom-model',
    });
    expect(profile.id).toBe('my_gateway');
    expect(profile.endpointFormat).toBe('chat_completions');
    expect(profile.reasoningMode).toBe('none');
    expect(profile.toolHistoryMode).toBe('openai_chat');
  });
});

describe('llama.cpp request shape', () => {
  it('uses the OpenAI-compatible endpoint without reasoning_effort', async () => {
    let requestUrl = '';
    let requestBody: Record<string, unknown> | undefined;
    globalThis.fetch = async (url, init) => {
      requestUrl = String(url);
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({
        id: 'resp_llama',
        object: 'response',
        created_at: 1,
        model: 'Qwen3-8B-GGUF',
        status: 'completed',
        output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] }],
      }));
    };

    const gateway = new ModelGateway({
      provider: 'llama.cpp',
      baseUrl: 'http://127.0.0.1:8080/v1',
      apiKey: '',
      model: 'Qwen3-8B-GGUF',
      reasoningEffort: 'medium',
    });
    await gateway.chat({
      reasoning_effort: 'high',
      messages: [
        { role: 'system', content: 'system' },
        { role: 'user', content: 'hello' },
      ],
    });

    expect(requestUrl).toBe('http://127.0.0.1:8080/v1/responses');
    expect(requestBody?.input).toEqual([
      { type: 'message', role: 'system', content: 'system' },
      { type: 'message', role: 'user', content: 'hello' },
    ]);
    expect(requestBody).not.toHaveProperty('reasoning');
  });

  it('does not send reasoning for llama.cpp streaming Responses when requested explicitly', async () => {
    let requestBody: Record<string, unknown> | undefined;
    globalThis.fetch = async (_url, init) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response([
        'event: response.output_text.delta',
        'data: {"type":"response.output_text.delta","delta":"ok"}',
        '',
        'event: response.completed',
        'data: {"type":"response.completed","response":{"status":"completed","output":[]}}',
        '',
      ].join('\n'));
    };
    const gateway = new ModelGateway({
      provider: 'llama.cpp',
      baseUrl: 'http://127.0.0.1:8080/v1',
      apiKey: '',
      model: 'Qwen3-8B-GGUF',
    });

    const events = [];
    for await (const event of gateway.chatStream({
      reasoning_effort: 'high',
      messages: [{ role: 'user', content: 'hello' }],
    })) events.push(event);

    expect(events).toContainEqual({ type: 'delta', content: 'ok' });
    expect(requestBody).not.toHaveProperty('reasoning');
  });

  it('forwards llama.cpp cache controls only when a slot lease is provided', async () => {
    let requestBody: Record<string, unknown> | undefined;
    globalThis.fetch = async (_url, init) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({
        id: 'cmpl_llama_slot',
        object: 'chat.completion',
        created: 1,
        model: 'Qwen3-8B-GGUF',
        choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      }));
    };
    const gateway = new ModelGateway({
      provider: 'llama.cpp',
      baseUrl: 'http://127.0.0.1:8080/v1',
      apiKey: '',
      model: 'Qwen3-8B-GGUF',
    });

    await gateway.chat({ messages: [{ role: 'user', content: 'hello' }] }, {
      llama: { idSlot: 1, cachePrompt: true, returnProgress: true },
    });

    expect(requestBody).toMatchObject({ id_slot: 1, cache_prompt: true, return_progress: true });
  });

  it('folds duplicate system messages into the first message at the local gateway boundary', async () => {
    let requestBody: Record<string, unknown> | undefined;
    globalThis.fetch = async (_url, init) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({
        id: 'resp_llama_multi_system',
        object: 'response',
        created_at: 1,
        model: 'Qwen3-8B-GGUF',
        status: 'completed',
        output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] }],
      }));
    };

    const gateway = new ModelGateway({
      provider: 'llama_cpp',
      baseUrl: 'http://127.0.0.1:8080/v1',
      apiKey: '',
      model: 'Qwen3-8B-GGUF',
    });
    await gateway.chat({
      messages: [
        { role: 'user', content: 'hello' },
        { role: 'system', content: 'base' },
        { role: 'assistant', content: 'prior' },
        { role: 'system', content: 'dynamic' },
      ],
    });

    expect(requestBody?.input).toEqual([
      { type: 'message', role: 'system', content: 'base\n\ndynamic' },
      { type: 'message', role: 'user', content: 'hello' },
      { type: 'message', role: 'assistant', content: 'prior' },
    ]);
  });

  it('identifies local llama.cpp failures without labeling them as OpenAI errors', async () => {
    globalThis.fetch = async () => new Response(JSON.stringify({
      error: { code: 500, message: 'Jinja Exception: System message must be at the beginning.', type: 'server_error' },
    }), { status: 500 });
    const gateway = new ModelGateway({
      provider: 'llama_cpp',
      baseUrl: 'http://127.0.0.1:8080/v1',
      apiKey: '',
      model: 'Qwen3-8B-GGUF',
    });

    await expect(gateway.chat({ messages: [{ role: 'user', content: 'hello' }] }))
      .rejects.toThrow('llama.cpp gateway error (500): Jinja Exception: System message must be at the beginning.');
  });

  it('probes llama.cpp capabilities through /props without issuing a completion', async () => {
    const requests: string[] = [];
    globalThis.fetch = async (url) => {
      requests.push(String(url));
      return new Response(JSON.stringify({
        total_slots: 2,
        default_generation_settings: { n_ctx: 65536 },
        model_n_ctx_train: 131072,
        build_info: 'b10636',
        model_path: 'Qwythos-9B-v2-MTP-Q4_K_M.gguf',
        chat_template: 'qwen3 {{ messages[0] }}',
        chat_template_tool_use: 'tool_calls function',
      }));
    };

    const gateway = new ModelGateway({
      provider: 'llama_cpp',
      baseUrl: 'http://127.0.0.1:8080/v1',
      apiKey: '',
      model: 'Qwen3-8B-GGUF',
    });

    await expect(gateway.probeLlamaCapabilities()).resolves.toMatchObject({
      provider: 'llama_cpp',
      reachable: true,
      hasToolTemplate: true,
      hasReasoningTemplate: false,
      slotCount: 2,
      contextTokens: 65536,
      trainingContextTokens: 131072,
      buildInfo: 'b10636',
      modelPath: 'Qwythos-9B-v2-MTP-Q4_K_M.gguf',
      chatTemplate: 'qwen3 {{ messages[0] }}',
    });
    expect(requests).toEqual(['http://127.0.0.1:8080/props']);
  });

  it('reports an unreachable llama.cpp /props endpoint without throwing', async () => {
    globalThis.fetch = async () => {
      throw new Error('connect ECONNREFUSED');
    };
    const gateway = new ModelGateway({
      provider: 'llama.cpp',
      baseUrl: 'http://127.0.0.1:8080/v1',
      apiKey: '',
      model: 'Qwen3-8B-GGUF',
    });

    await expect(gateway.probeLlamaCapabilities()).resolves.toMatchObject({
      provider: 'llama_cpp',
      reachable: false,
      error: 'connect ECONNREFUSED',
    });
  });

  it('rejects an oversized request after a successful capability probe', async () => {
    let completionSent = false;
    globalThis.fetch = async (url) => {
      if (String(url).endsWith('/props')) {
        return new Response(JSON.stringify({
          total_slots: 1,
          default_generation_settings: { n_ctx: 16 },
        }));
      }
      completionSent = true;
      return new Response(JSON.stringify({
        id: 'should_not_be_sent',
        object: 'chat.completion',
        created: 1,
        model: 'Qwen3-8B-GGUF',
        choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      }));
    };
    const gateway = new ModelGateway({
      provider: 'llama.cpp',
      baseUrl: 'http://127.0.0.1:8080/v1',
      apiKey: '',
      model: 'Qwen3-8B-GGUF',
    });
    await gateway.probeLlamaCapabilities();
    await expect(gateway.chat({ messages: [{ role: 'user', content: 'x'.repeat(80) }], max_tokens: 8 }))
      .rejects.toThrow('请求超过上下文窗口');
    expect(completionSent).toBe(false);
  });

  it('falls back to Chat Completions when Responses is an unsupported route', async () => {
    const urls: string[] = [];
    globalThis.fetch = async (url) => {
      urls.push(String(url));
      if (String(url).endsWith('/responses')) return new Response(JSON.stringify({ detail: 'Not Found' }), { status: 404 });
      return new Response(JSON.stringify({
        id: 'chat_fallback',
        object: 'chat.completion',
        created: 1,
        model: 'Qwen3-8B-GGUF',
        choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      }));
    };
    const gateway = new ModelGateway({
      provider: 'llama_cpp',
      baseUrl: 'http://127.0.0.1:8080/v1',
      apiKey: '',
      model: 'Qwen3-8B-GGUF',
    });

    await expect(gateway.chat({ messages: [{ role: 'user', content: 'hello' }] })).resolves.toMatchObject({
      choices: [{ message: { content: 'ok' } }],
    });
    expect(urls).toEqual([
      'http://127.0.0.1:8080/v1/responses',
      'http://127.0.0.1:8080/v1/chat/completions',
    ]);
  });

  it('does not leak Responses persistence frames into Chat fallback requests', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    globalThis.fetch = async (url, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      bodies.push(body);
      if (String(url).endsWith('/responses')) return new Response('Not Found', { status: 404 });
      return new Response(JSON.stringify({
        id: 'chat_fallback_frame',
        object: 'chat.completion',
        created: 1,
        model: 'Qwen3-8B-GGUF',
        choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      }));
    };
    const gateway = new ModelGateway({
      provider: 'llama.cpp',
      baseUrl: 'http://127.0.0.1:8080/v1',
      apiKey: '',
      model: 'Qwen3-8B-GGUF',
    });

    await gateway.chat({
      messages: [
        { role: 'user', content: '继续' },
        {
          role: 'assistant',
          content: '',
          tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'list_files', arguments: '{}' } }],
          providerFrame: {
            format: 'openai_responses',
            outputItems: [{ type: 'function_call', call_id: 'call_1', name: 'list_files', arguments: '{}' }],
          },
        },
        { role: 'tool', tool_call_id: 'call_1', content: '[]' },
      ],
    });

    const chatBody = bodies[1];
    expect(chatBody.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'assistant', tool_calls: expect.any(Array) }),
    ]));
    expect(JSON.stringify(chatBody)).not.toContain('providerFrame');
  });
});

describe('OpenAI-compatible stream safety', () => {
  function streamResponse(lines: string[]): Response {
    const encoder = new TextEncoder();
    return new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(lines.join('\n')));
        controller.close();
      },
    }));
  }

  it('assembles one structured tool call with a stable id and emits done once', async () => {
    globalThis.fetch = async () => streamResponse([
      'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"name":"list_files"}}]}}]}',
      'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"path\\":\\".\\"}"}}]},"finish_reason":"tool_calls"}]}',
      'data: [DONE]',
      '',
    ]);
    const gateway = new ModelGateway({
      provider: 'openai_compatible',
      baseUrl: 'http://127.0.0.1:8080/v1',
      apiKey: '',
      model: 'Qwen3-8B-GGUF',
    });

    const events = [];
    for await (const event of gateway.chatStream({ messages: [{ role: 'user', content: 'list files' }] })) events.push(event);

    const starts = events.filter((event) => event.type === 'tool_call_start');
    const deltas = events.filter((event) => event.type === 'tool_call_delta');
    const ends = events.filter((event) => event.type === 'tool_call_end');
    expect(starts).toHaveLength(1);
    expect(deltas).toHaveLength(1);
    expect(ends).toHaveLength(1);
    expect(new Set([...starts, ...deltas, ...ends].map((event) => event.id))).toEqual(new Set(['tool_0_0']));
    expect(events.filter((event) => event.type === 'done')).toHaveLength(1);
  });

  it('normalizes Gitee reasoning_content, reasoning, and thinking deltas', async () => {
    globalThis.fetch = async () => streamResponse([
      'data: {"choices":[{"index":0,"delta":{"reasoning_content":"先检查参数。"}}]}',
      'data: {"choices":[{"index":0,"delta":{"reasoning":"再确认路由。"}}]}',
      'data: {"choices":[{"index":0,"delta":{"thinking":"最后输出。","content":"完成"}}]}',
      'data: [DONE]',
    ]);
    const gateway = new ModelGateway({
      provider: 'giteeai',
      baseUrl: 'https://ai.gitee.com/v1',
      apiKey: 'gitee-key',
      model: 'deepseek-v4-flash-0731',
    });

    const events = [];
    for await (const event of gateway.chatStream({ messages: [{ role: 'user', content: 'hello' }] })) events.push(event);

    expect(events.filter((event) => event.type === 'reasoning_delta').map((event) => event.content))
      .toEqual(['先检查参数。', '再确认路由。', '最后输出。']);
    expect(events.filter((event) => event.type === 'delta').map((event) => event.content)).toEqual(['完成']);
    expect(events.filter((event) => event.type === 'done')).toHaveLength(1);
  });

  it('normalizes tagged reasoning split across streaming frames', async () => {
    globalThis.fetch = async () => streamResponse([
      'data: {"choices":[{"delta":{"content":"<thi"}}]}',
      'data: {"choices":[{"delta":{"content":"nk>内部思考"}}]}',
      'data: {"choices":[{"delta":{"content":"</thi"}}]}',
      'data: {"choices":[{"delta":{"content":"nk>最终答案"}}]}',
      'data: [DONE]',
    ]);
    const gateway = new ModelGateway({
      provider: 'giteeai',
      baseUrl: 'https://ai.gitee.com/v1',
      apiKey: 'gitee-key',
      model: 'qwen3.8-flash',
    });

    const events = [];
    for await (const event of gateway.chatStream({ messages: [{ role: 'user', content: 'hello' }] })) events.push(event);

    expect(events.filter((event) => event.type === 'reasoning_delta').map((event) => event.content))
      .toEqual(['内部思考']);
    expect(events.filter((event) => event.type === 'delta').map((event) => event.content).join(''))
      .toBe('最终答案');
    expect(JSON.stringify(events)).not.toContain('<think>');
    expect(events.filter((event) => event.type === 'done')).toHaveLength(1);
  });

  it('does not emit an empty reasoning event for an empty tagged block', async () => {
    globalThis.fetch = async () => streamResponse([
      'data: {"choices":[{"delta":{"content":"<think> </think>你好！"}}]}',
      'data: [DONE]',
    ]);
    const gateway = new ModelGateway({
      provider: 'giteeai',
      baseUrl: 'https://ai.gitee.com/v1',
      apiKey: 'gitee-key',
      model: 'qwen3.8-flash',
    });

    const events = [];
    for await (const event of gateway.chatStream({ messages: [{ role: 'user', content: 'hello' }] })) events.push(event);

    expect(events.filter((event) => event.type === 'reasoning_delta')).toHaveLength(0);
    expect(events.filter((event) => event.type === 'delta').map((event) => event.content).join(''))
      .toBe('你好！');
  });

  it('keys tool calls by choice and index, retaining one id when the provider id arrives late', async () => {
    globalThis.fetch = async () => streamResponse([
      'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"name":"lookup"}}]}},{"index":1,"delta":{"tool_calls":[{"index":0,"id":"call_second","function":{"name":"other"}}]}}]}',
      'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_late","function":{"arguments":"{\\"value\\":"}}]}},{"index":1,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"value\\":2}"}}]}}]}',
      'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"1}"}}]},"finish_reason":"tool_calls"},{"index":1,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":4},"timings":{"cache_n":1,"prompt_n":2}}',
      'data: [DONE]',
    ]);
    const gateway = new ModelGateway({
      provider: 'openai_compatible',
      baseUrl: 'http://127.0.0.1:8080/v1',
      apiKey: '',
      model: 'Qwen3-8B-GGUF',
    });

    const events = [];
    for await (const event of gateway.chatStream({ messages: [{ role: 'user', content: 'use tools' }] })) events.push(event);

    const starts = events.filter((event) => event.type === 'tool_call_start');
    const ends = events.filter((event) => event.type === 'tool_call_end');
    expect(starts).toHaveLength(2);
    expect(ends).toHaveLength(2);
    expect(starts.map((event) => event.id)).toEqual(['tool_0_0', 'call_second']);
    expect(ends.map((event) => [event.id, event.name, event.arguments])).toEqual([
      ['tool_0_0', 'lookup', '{"value":1}'],
      ['call_second', 'other', '{"value":2}'],
    ]);
    expect(events.filter((event) => event.type === 'done')).toHaveLength(1);
    expect(events.find((event) => event.type === 'done')).toMatchObject({
      type: 'done',
      usage: {
        prompt_tokens: 3,
        completion_tokens: 4,
        cached_tokens: 1,
        cache_source: 'llama-timings',
      },
    });
  });

  it('emits one done event and flushes the final line when the stream ends without a marker', async () => {
    globalThis.fetch = async () => streamResponse([
      'data: {"choices":[{"index":0,"delta":{"content":"ordinary <tool_call_note> text"}}]}',
    ]);
    const gateway = new ModelGateway({
      provider: 'openai_compatible',
      baseUrl: 'http://127.0.0.1:8080/v1',
      apiKey: '',
      model: 'Qwen3-8B-GGUF',
    });

    const events = [];
    for await (const event of gateway.chatStream({ messages: [{ role: 'user', content: 'hello' }] })) events.push(event);

    expect(events.filter((event) => event.type === 'delta').map((event) => event.content).join(''))
      .toBe('ordinary <tool_call_note> text');
    expect(events.filter((event) => event.type === 'protocol_error')).toHaveLength(0);
    expect(events.filter((event) => event.type === 'done')).toHaveLength(1);
  });

  it('keeps usage-only frames that arrive after finish_reason', async () => {
    globalThis.fetch = async () => streamResponse([
      'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}',
      'data: {"usage":{"prompt_tokens":12,"completion_tokens":2},"timings":{"cache_n":9,"prompt_n":3}}',
      'data: [DONE]',
    ]);
    const gateway = new ModelGateway({ provider: 'openai_compatible', baseUrl: 'http://127.0.0.1:8080/v1', apiKey: '', model: 'Qwen3-8B-GGUF' });
    const events = [];
    for await (const event of gateway.chatStream({ messages: [{ role: 'user', content: 'hello' }] })) events.push(event);
    expect(events.filter((event) => event.type === 'done')).toHaveLength(1);
    expect(events.find((event) => event.type === 'done')).toMatchObject({ usage: { completion_tokens: 2, cached_tokens: 9 } });
  });

  it('emits llama.cpp prompt prefill progress without treating it as assistant text', async () => {
    let requestCount = 0;
    globalThis.fetch = async () => {
      requestCount += 1;
      if (requestCount === 1) return new Response('Responses route unavailable', { status: 404 });
      return streamResponse([
        'data: {"prompt_progress":{"total":100,"cache":80,"processed":20,"time_ms":12}}',
        'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}',
        'data: [DONE]',
      ]);
    };
    const gateway = new ModelGateway({ provider: 'llama.cpp', baseUrl: 'http://127.0.0.1:8080/v1', apiKey: '', model: 'Qwen3-8B-GGUF' });
    const events = [];
    for await (const event of gateway.chatStream({ messages: [{ role: 'user', content: 'hello' }] })) events.push(event);
    expect(events).toContainEqual({ type: 'prompt_progress', total: 100, cache: 80, processed: 20, timeMs: 12 });
    expect(events).toContainEqual({ type: 'delta', content: 'ok' });
    expect(events.find((event) => event.type === 'done')).toMatchObject({ usage: { cached_tokens: 80 } });
  });

  it('surfaces provider errors embedded in a successful SSE response', async () => {
    globalThis.fetch = async () => streamResponse([
      'data: {"error":{"message":"template failed"}}',
      'data: [DONE]',
    ]);
    const gateway = new ModelGateway({ provider: 'openai_compatible', baseUrl: 'http://127.0.0.1:8080/v1', apiKey: '', model: 'Qwen3-8B-GGUF' });
    const events = [];
    for await (const event of gateway.chatStream({ messages: [{ role: 'user', content: 'hello' }] })) events.push(event);
    expect(events).toContainEqual({ type: 'error', error: expect.objectContaining({ message: 'template failed' }) });
    expect(events.filter((event) => event.type === 'done')).toHaveLength(0);
  });

  it('surfaces malformed OpenAI SSE JSON as a protocol error instead of silently dropping it', async () => {
    globalThis.fetch = async () => streamResponse([
      'data: {"choices":[{"delta":{"content":"ok"}}]}',
      'data: {not-json}',
      'data: [DONE]',
    ]);
    const gateway = new ModelGateway({ provider: 'openai_compatible', baseUrl: 'http://127.0.0.1:8080/v1', apiKey: '', model: 'Qwen3-8B-GGUF' });
    const events = [];
    for await (const event of gateway.chatStream({ messages: [{ role: 'user', content: 'hello' }] })) events.push(event);

    expect(events.filter((event) => event.type === 'protocol_error')).toEqual([
      { type: 'protocol_error', message: '模型流格式错误：服务端返回了无法解析的 SSE JSON。' },
    ]);
    expect(events.filter((event) => event.type === 'delta').map((event) => event.content).join('')).toBe('ok');
  });

  it('turns an unstructured llama.cpp tool marker into a protocol error', async () => {
    globalThis.fetch = async () => streamResponse([
      'data: {"choices":[{"delta":{"content":"<tool_"}}]}',
      'data: {"choices":[{"delta":{"content":"call>"}}]}',
      'data: [DONE]',
      '',
    ]);
    const gateway = new ModelGateway({
      provider: 'openai_compatible',
      baseUrl: 'http://127.0.0.1:8080/v1',
      apiKey: '',
      model: 'Qwen3-8B-GGUF',
    });

    const events = [];
    for await (const event of gateway.chatStream({ messages: [{ role: 'user', content: 'use a tool' }] })) events.push(event);
    expect(events.filter((event) => event.type === 'protocol_error')).toHaveLength(1);
    expect(events.some((event) => event.type === 'delta')).toBe(false);
    expect(events.filter((event) => event.type === 'done')).toHaveLength(1);
  });

  it('turns a split function marker into one protocol error without leaking the marker', async () => {
    globalThis.fetch = async () => streamResponse([
      'data: {"choices":[{"delta":{"content":"<function="}}]}',
      'data: {"choices":[{"delta":{"content":"lookup>\\n{\\"value\\":1}"}}]}',
      'data: [DONE]',
    ]);
    const gateway = new ModelGateway({
      provider: 'openai_compatible',
      baseUrl: 'http://127.0.0.1:8080/v1',
      apiKey: '',
      model: 'Qwen3-8B-GGUF',
    });

    const events = [];
    for await (const event of gateway.chatStream({ messages: [{ role: 'user', content: 'use a tool' }] })) events.push(event);
    expect(events.filter((event) => event.type === 'protocol_error')).toHaveLength(1);
    expect(events.filter((event) => event.type === 'delta').map((event) => event.content).join(''))
      .not.toContain('<function=');
    expect(events.filter((event) => event.type === 'done')).toHaveLength(1);
  });
});

describe('provider frames', () => {
  it('replays OpenAI chat tool calls without text placeholders', () => {
    const frame: ProviderAssistantFrame = {
      format: 'openai_chat',
      content: null,
      toolCalls: [{
        id: 'call_read_1',
        type: 'function',
        function: { name: 'read_file', arguments: '{"path":"a.txt"}' },
      }],
    };
    const messages = buildOpenAiChatToolHistory(frame, [{
      modelToolCallId: 'call_read_1',
      output: 'file text',
    }]);
    expect(JSON.stringify(messages)).not.toContain('[Tool');
    expect(messages).toEqual([
      {
        role: 'assistant',
        content: '',
        tool_calls: frame.toolCalls,
      },
      {
        role: 'tool',
        tool_call_id: 'call_read_1',
        content: 'file text',
      },
    ]);
  });

  it('replays Anthropic tool_use and tool_result blocks without text placeholders', () => {
    const frame: ProviderAssistantFrame = {
      format: 'anthropic_messages',
      contentBlocks: [{
        type: 'tool_use',
        id: 'toolu_1',
        name: 'read_file',
        input: { path: 'a.txt' },
      }],
    };
    const messages = buildAnthropicToolHistory(frame, [{
      modelToolCallId: 'toolu_1',
      output: 'file text',
    }]);
    expect(JSON.stringify(messages)).not.toContain('[Tool');
    expect(messages).toEqual([
      {
        role: 'assistant',
        content: frame.contentBlocks,
      },
      {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: 'toolu_1',
          content: 'file text',
        }],
      },
    ]);
  });
});

describe('Responses 路由与兼容回退', () => {
  it('DeepSeek 根地址的 Chat Completions 使用 /v1 且不重复追加', async () => {
    const requestUrls: string[] = [];
    globalThis.fetch = async (url) => {
      requestUrls.push(String(url));
      return new Response(JSON.stringify({
        id: 'cmpl_deepseek_root_chat',
        object: 'chat.completion',
        created: 1,
        model: 'deepseek-chat',
        choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      }));
    };
    const gateway = new ModelGateway({
      provider: 'deepseek',
      baseUrl: 'https://api.deepseek.com',
      apiKey: 'test',
      model: 'deepseek-chat',
    });

    await gateway.chat({ messages: [{ role: 'user', content: 'hello' }] });
    expect(requestUrls).toEqual(['https://api.deepseek.com/v1/chat/completions']);
  });

  it('DeepSeek 自定义 /v1 地址不会重复追加版本路径', async () => {
    let requestUrl = '';
    globalThis.fetch = async (url) => {
      requestUrl = String(url);
      return new Response(JSON.stringify({
        id: 'cmpl_deepseek_custom_chat',
        object: 'chat.completion',
        created: 1,
        model: 'deepseek-chat',
        choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      }));
    };
    const gateway = new ModelGateway({
      provider: 'deepseek',
      baseUrl: 'https://proxy.example.test/v1',
      apiKey: 'test',
      model: 'deepseek-chat',
    });

    await gateway.chat({ messages: [{ role: 'user', content: 'hello' }] });
    expect(requestUrl).toBe('https://proxy.example.test/v1/chat/completions');
  });

  it('为 DeepSeek Responses 去掉 Chat 专用的 /v1 基址', async () => {
    let requestUrl = '';
    globalThis.fetch = async (url) => {
      requestUrl = String(url);
      return new Response(JSON.stringify({
        id: 'resp_ds',
        status: 'completed',
        model: 'deepseek-v4-pro',
        output: [{ type: 'message', content: [{ type: 'output_text', text: 'ok' }] }],
      }));
    };
    const gateway = new ModelGateway({
      provider: 'deepseek',
      baseUrl: 'https://api.deepseek.test/v1',
      apiKey: 'test',
      model: 'deepseek-v4-pro',
    });

    await gateway.chat({ messages: [{ role: 'user', content: 'hello' }] });
    expect(requestUrl).toBe('https://api.deepseek.test/responses');
  });

  it('仅在 Responses 端点返回 404/405 时回退到 Chat Completions', async () => {
    const requestUrls: string[] = [];
    globalThis.fetch = async (url) => {
      requestUrls.push(String(url));
      if (String(url).endsWith('/responses')) return new Response('not found', { status: 404 });
      return new Response(JSON.stringify({
        id: 'cmpl_fallback',
        object: 'chat.completion',
        created: 1,
        model: 'gpt-5',
        choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      }));
    };
    const gateway = new ModelGateway({
      provider: 'openai',
      baseUrl: 'https://api.openai.test/v1',
      apiKey: 'test',
      model: 'gpt-5',
    });

    await expect(gateway.chat({ messages: [{ role: 'user', content: 'hello' }] })).resolves.toMatchObject({
      choices: [{ message: { content: 'ok' } }],
    });
    expect(requestUrls).toEqual([
      'https://api.openai.test/v1/responses',
      'https://api.openai.test/v1/chat/completions',
    ]);
  });

  it('DeepSeek 根地址的 Responses 回退到 /v1/chat/completions', async () => {
    const requestUrls: string[] = [];
    globalThis.fetch = async (url) => {
      requestUrls.push(String(url));
      if (String(url).endsWith('/responses')) return new Response('Responses route unavailable', { status: 404 });
      return new Response(JSON.stringify({
        id: 'cmpl_deepseek_root_fallback',
        object: 'chat.completion',
        created: 1,
        model: 'deepseek-v4-pro',
        choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      }));
    };
    const gateway = new ModelGateway({
      provider: 'deepseek',
      baseUrl: 'https://api.deepseek.com',
      apiKey: 'test',
      model: 'deepseek-v4-pro',
    });

    await expect(gateway.chat({ messages: [{ role: 'user', content: 'hello' }] })).resolves.toMatchObject({
      choices: [{ message: { content: 'ok' } }],
    });
    expect(requestUrls).toEqual([
      'https://api.deepseek.com/responses',
      'https://api.deepseek.com/v1/chat/completions',
    ]);
  });

  it('不会把 Responses 404 模型业务错误误判为端点不支持', async () => {
    let requestCount = 0;
    globalThis.fetch = async () => {
      requestCount += 1;
      return new Response(JSON.stringify({
        error: { code: 'model_not_found', message: 'The requested model was not found.' },
      }), { status: 404 });
    };
    const gateway = new ModelGateway({
      provider: 'deepseek',
      baseUrl: 'https://api.deepseek.com',
      apiKey: 'test',
      model: 'deepseek-v4-pro',
    });

    await expect(gateway.chat({ messages: [{ role: 'user', content: 'hello' }] })).rejects.toThrow('model was not found');
    expect(requestCount).toBe(1);
  });

  it('不会把没有端点提示的资源 404 误判为 Responses 端点缺失', async () => {
    let requestCount = 0;
    globalThis.fetch = async () => {
      requestCount += 1;
      return new Response(JSON.stringify({ error: { code: 'resource_not_found', message: 'Resource not found.' } }), { status: 404 });
    };
    const gateway = new ModelGateway({
      provider: 'openai',
      baseUrl: 'https://api.openai.test/v1',
      apiKey: 'test',
      model: 'gpt-5',
    });

    await expect(gateway.chat({ messages: [{ role: 'user', content: 'hello' }] })).rejects.toThrow('Resource not found');
    expect(requestCount).toBe(1);
  });

  it('仅对明确的 Responses 路由错误执行 404 回退', async () => {
    const requestUrls: string[] = [];
    globalThis.fetch = async (url) => {
      requestUrls.push(String(url));
      if (String(url).endsWith('/responses')) {
        return new Response(JSON.stringify({ error: { code: 'route_not_found', message: 'Route not found: /responses' } }), { status: 404 });
      }
      return new Response(JSON.stringify({
        id: 'cmpl_route_fallback',
        object: 'chat.completion',
        created: 1,
        model: 'gpt-5',
        choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      }));
    };
    const gateway = new ModelGateway({
      provider: 'openai',
      baseUrl: 'https://api.openai.test/v1',
      apiKey: 'test',
      model: 'gpt-5',
    });

    await expect(gateway.chat({ messages: [{ role: 'user', content: 'hello' }] })).resolves.toMatchObject({ choices: [{ message: { content: 'ok' } }] });
    expect(requestUrls).toEqual([
      'https://api.openai.test/v1/responses',
      'https://api.openai.test/v1/chat/completions',
    ]);
  });

  it('不会把普通 Responses 400 参数错误误判为端点不支持', async () => {
    let requestCount = 0;
    globalThis.fetch = async () => {
      requestCount += 1;
      return new Response(JSON.stringify({ error: { message: 'invalid response_format' } }), { status: 400 });
    };
    const gateway = new ModelGateway({
      provider: 'openai',
      baseUrl: 'https://api.openai.test/v1',
      apiKey: 'test',
      model: 'gpt-5',
    });

    await expect(gateway.chat({ messages: [{ role: 'user', content: 'hello' }] })).rejects.toThrow('invalid response_format');
    expect(requestCount).toBe(1);
  });

  it('把 DeepSeek Responses usage 的缓存来源标记为 deepseek', async () => {
    globalThis.fetch = async () => new Response(JSON.stringify({
      id: 'resp_deepseek_cache',
      status: 'completed',
      model: 'deepseek-v4-pro',
      output: [{ type: 'message', content: [{ type: 'output_text', text: 'ok' }] }],
      usage: {
        prompt_cache_hit_tokens: 12,
        prompt_cache_miss_tokens: 28,
        completion_tokens: 4,
      },
    }));
    const gateway = new ModelGateway({
      provider: 'deepseek',
      baseUrl: 'https://api.deepseek.com',
      apiKey: 'test',
      model: 'deepseek-v4-pro',
    });

    const response = await gateway.chat({ messages: [{ role: 'user', content: 'hello' }] });
    expect(response.usage).toMatchObject({
      cached_tokens: 12,
      cache_source: 'deepseek',
      cache_strategy: 'deepseek-native',
    });
    expect(response.usage).not.toMatchObject({ cache_source: 'openai' });
  });
});

describe('MiniMax and DeepSeek provider behavior', () => {
  it('adds MiniMax Anthropic diagnostics without switching to OpenAI placeholders', () => {
    const gateway = new ModelGateway({
      provider: 'minimax',
      model: 'MiniMax-M3',
      baseUrl: '',
      apiKey: 'test',
    });

    expect((gateway as unknown as { profile: { endpointFormat: string; reasoningMode: string } }).profile).toMatchObject({
      endpointFormat: 'anthropic_messages',
      reasoningMode: 'minimax_anthropic_thinking',
    });
  });

  it('sends MiniMax M3 through Anthropic-compatible messages with bearer auth and adaptive thinking', async () => {
    let requestUrl = '';
    let requestHeaders: Headers | undefined;
    let requestBody: unknown;
    globalThis.fetch = async (url, init) => {
      requestUrl = String(url);
      requestHeaders = new Headers(init?.headers);
      requestBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({
        id: 'msg_minimax',
        type: 'message',
        role: 'assistant',
        model: 'MiniMax-M3',
        content: [{ type: 'text', text: 'ok' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 10, output_tokens: 2 },
      }));
    };

    const gateway = new ModelGateway({
      provider: 'minimax',
      baseUrl: 'https://api.minimaxi.com/anthropic/v1',
      apiKey: 'minimax-key',
      model: 'MiniMax-M3',
    });

    await gateway.chat({ messages: [{ role: 'user', content: 'hello' }] });

    expect(requestUrl).toBe('https://api.minimaxi.com/anthropic/v1/messages');
    expect(requestHeaders?.get('Authorization')).toBe('Bearer minimax-key');
    expect(requestHeaders?.has('x-api-key')).toBe(false);
    expect(requestBody).toMatchObject({
      model: 'MiniMax-M3',
      thinking: { type: 'adaptive' },
      messages: [
        {
          role: 'user',
          content: [{ type: 'text', text: 'hello', cache_control: { type: 'ephemeral' } }],
        },
      ],
    });
  });

  it('does not send Anthropic tool_result blocks after an intervening user message', async () => {
    let requestBody: { messages?: Array<{ role: string; content: unknown[] }> } = {};
    globalThis.fetch = async (_url, init) => {
      requestBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({
        id: 'msg_anthropic',
        type: 'message',
        role: 'assistant',
        model: 'claude-test',
        content: [{ type: 'text', text: 'ok' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 10, output_tokens: 2 },
      }));
    };

    const gateway = new ModelGateway({
      provider: 'anthropic',
      baseUrl: 'https://api.anthropic.com/v1',
      apiKey: 'anthropic-key',
      model: 'claude-test',
    });

    await gateway.chat({
      messages: [
        {
          role: 'assistant',
          content: '',
          providerFrame: {
            format: 'anthropic_messages',
            contentBlocks: [{ type: 'tool_use', id: 'toolu_read_1', name: 'read_file', input: { path: 'a.txt' } }],
          },
        },
        { role: 'user', content: '新的用户消息插入了工具结果之前' },
        { role: 'tool', tool_call_id: 'toolu_read_1', content: 'file text' },
        { role: 'user', content: '继续' },
      ],
    });

    expect(JSON.stringify(requestBody.messages)).not.toContain('tool_result');
  });

  it('streams MiniMax thinking blocks as reasoning deltas instead of assistant text', async () => {
    const encoder = new TextEncoder();
    globalThis.fetch = async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode([
          'event: message_start',
          'data: {"type":"message_start","message":{"id":"msg_minimax_stream","type":"message","role":"assistant","model":"MiniMax-M3","content":[],"stop_reason":null,"usage":{"input_tokens":10,"output_tokens":0}}}',
          '',
          'event: content_block_start',
          'data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":"","signature":"sig"}}',
          '',
          'event: content_block_delta',
          'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"need a tool"}}',
          '',
          'event: content_block_start',
          'data: {"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}',
          '',
          'event: content_block_delta',
          'data: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"final"}}',
          '',
          'event: message_stop',
          'data: {"type":"message_stop"}',
          '',
        ].join('\n')));
        controller.close();
      },
    }));

    const gateway = new ModelGateway({
      provider: 'minimax',
      baseUrl: 'https://api.minimaxi.com/anthropic/v1',
      apiKey: 'test',
      model: 'MiniMax-M3',
    });

    const events = [];
    for await (const event of gateway.chatStream({ messages: [{ role: 'user', content: 'hello' }] })) {
      events.push(event);
    }

    expect(events).toContainEqual({ type: 'reasoning_delta', content: 'need a tool' });
    expect(events).toContainEqual({ type: 'delta', content: 'final' });
    expect(events).not.toContainEqual({ type: 'delta', content: 'need a tool' });
  });

  it('preserves DeepSeek reasoning_content in normalized OpenAI responses', () => {
    const response = convertOpenAIResponseForTest({
      id: 'cmpl_1',
      object: 'chat.completion',
      created: 1,
      model: 'deepseek-v4-pro',
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: 'answer',
          reasoning_content: 'private reasoning summary',
        },
        finish_reason: 'stop',
      }],
      usage: {
        prompt_cache_hit_tokens: 10,
        prompt_cache_miss_tokens: 30,
        completion_tokens: 5,
      },
    }, 'deepseek-native');
    expect(response.choices[0].message.reasoning_content).toBe('private reasoning summary');
    expect(response.usage).toMatchObject({
      prompt_tokens: 40,
      completion_tokens: 5,
      cached_tokens: 10,
      cache_strategy: 'deepseek-native',
    });
  });

  it('sends DeepSeek thinking controls in provider-native request shape', async () => {
    let requestBody: unknown;
    globalThis.fetch = async (_url, init) => {
      requestBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({
        id: 'resp_deepseek',
        object: 'response',
        created_at: 1,
        model: 'deepseek-v4-pro',
        status: 'completed',
        output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] }],
        usage: { input_tokens: 3, output_tokens: 3, total_tokens: 6 },
      }));
    };

    const gateway = new ModelGateway({
      provider: 'deepseek',
      baseUrl: 'https://api.deepseek.test',
      apiKey: 'test',
      model: 'deepseek-v4-pro',
      reasoningEffort: 'xhigh',
    });

    await gateway.chat({ messages: [{ role: 'user', content: 'hello' }] });

    expect(requestBody).toMatchObject({
      model: 'deepseek-v4-pro',
      reasoning: { effort: 'xhigh' },
    });
    expect(requestBody).not.toHaveProperty('thinking');
  });

  it('adds OpenRouter app attribution headers while preserving caller overrides', async () => {
    let requestHeaders: Headers | undefined;
    globalThis.fetch = async (_url, init) => {
      requestHeaders = new Headers(init?.headers);
      return new Response(JSON.stringify({
        id: 'cmpl_openrouter',
        object: 'chat.completion',
        created: 1,
        model: 'openai/gpt-5.2',
        choices: [{
          index: 0,
          message: { role: 'assistant', content: 'ok' },
          finish_reason: 'stop',
        }],
      }));
    };

    const gateway = new ModelGateway({
      provider: 'openrouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'or-key',
      model: 'openai/gpt-5.2',
      extraHeaders: { 'X-OpenRouter-Title': 'User Title' },
    });

    await gateway.chat({ messages: [{ role: 'user', content: 'hello' }] });

    expect(requestHeaders?.get('HTTP-Referer')).toBe('https://github.com/suanlizi-agent/suanlizi');
    expect(requestHeaders?.get('X-OpenRouter-Title')).toBe('User Title');
    expect(requestHeaders?.get('X-OpenRouter-Categories')).toBe('productivity,developer-tools,local-first');
  });

  it('sends Mistral parallel tool call control in the official chat request shape', async () => {
    let requestBody: unknown;
    globalThis.fetch = async (_url, init) => {
      requestBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({
        id: 'cmpl_mistral',
        object: 'chat.completion',
        created: 1,
        model: 'mistral-large-latest',
        choices: [{
          index: 0,
          message: { role: 'assistant', content: 'ok' },
          finish_reason: 'stop',
        }],
      }));
    };

    const gateway = new ModelGateway({
      provider: 'mistral',
      baseUrl: 'https://api.mistral.ai/v1',
      apiKey: 'mistral-key',
      model: 'mistral-large-latest',
    });

    await gateway.chat({
      messages: [{ role: 'user', content: 'hello' }],
      tools: [{
        type: 'function',
        function: {
          name: 'lookup',
          description: 'Look up data',
          parameters: { type: 'object', properties: {} },
        },
      }],
    });

    expect(requestBody).toMatchObject({ parallel_tool_calls: true });
  });

  it('normalizes Kimi reasoning effort to official low/high/max values', async () => {
    let requestBody: unknown;
    globalThis.fetch = async (_url, init) => {
      requestBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({
        id: 'resp_kimi',
        object: 'response',
        created_at: 1,
        model: 'kimi-k3',
        status: 'completed',
        output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] }],
      }));
    };

    const gateway = new ModelGateway({
      provider: 'kimi',
      baseUrl: 'https://api.moonshot.ai/v1',
      apiKey: 'kimi-key',
      model: 'kimi-k3',
      reasoningEffort: 'xhigh',
    });

    await gateway.chat({ messages: [{ role: 'user', content: 'hello' }] });

    expect(requestBody).toMatchObject({ reasoning: { effort: 'xhigh' } });
    expect(requestBody).not.toHaveProperty('reasoning_effort');
  });

  it('maps Qwen reasoning effort to DashScope enable_thinking instead of OpenAI reasoning_effort', async () => {
    let requestBody: unknown;
    globalThis.fetch = async (_url, init) => {
      requestBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({
        id: 'cmpl_qwen',
        object: 'chat.completion',
        created: 1,
        model: 'qwen3-coder-plus',
        choices: [{
          index: 0,
          message: { role: 'assistant', content: 'ok' },
          finish_reason: 'stop',
        }],
      }));
    };

    const gateway = new ModelGateway({
      provider: 'qwen',
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      apiKey: 'dashscope-key',
      model: 'qwen3-coder-plus',
      reasoningEffort: 'high',
    });

    await gateway.chat({ messages: [{ role: 'user', content: 'hello' }] });

    expect(requestBody).toMatchObject({ enable_thinking: true });
    expect(requestBody).not.toHaveProperty('reasoning_effort');
    expect(requestBody).not.toHaveProperty('thinking');
  });

  it('disables Qwen thinking for explicit low or disabled reasoning effort', async () => {
    let requestBody: unknown;
    globalThis.fetch = async (_url, init) => {
      requestBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({
        id: 'cmpl_qwen',
        object: 'chat.completion',
        created: 1,
        model: 'qwen3-coder-plus',
        choices: [{
          index: 0,
          message: { role: 'assistant', content: 'ok' },
          finish_reason: 'stop',
        }],
      }));
    };

    const gateway = new ModelGateway({
      provider: 'qwen',
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      apiKey: 'dashscope-key',
      model: 'qwen3-coder-plus',
      reasoningEffort: 'disabled',
    });

    await gateway.chat({ messages: [{ role: 'user', content: 'hello' }] });

    expect(requestBody).toMatchObject({ enable_thinking: false });
    expect(requestBody).not.toHaveProperty('reasoning_effort');
  });

  it('adapts Gitee AI chat requests to named-tool compatibility', async () => {
    let requestBody: Record<string, unknown> | undefined;
    let requestHeaders: Headers | undefined;
    globalThis.fetch = async (_url, init) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      requestHeaders = new Headers(init?.headers);
      return new Response(JSON.stringify({
        id: 'cmpl_gitee',
        object: 'chat.completion',
        created: 1,
        model: 'DeepSeek-R1-Distill-Qwen-14B',
        choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      }));
    };

    const gateway = new ModelGateway({
      provider: 'giteeai',
      baseUrl: 'https://ai.gitee.com/v1',
      apiKey: 'gitee-key',
      model: 'DeepSeek-R1-Distill-Qwen-14B',
      reasoningEffort: 'high',
    });

    await gateway.chat({
      messages: [{ role: 'user', content: 'hello' }],
      tools: [{
        type: 'function',
        function: { name: 'read_file', description: 'Read a file', parameters: { type: 'object', properties: {} } },
      }],
      tool_choice: 'auto',
      parallel_tool_calls: true,
      extra_body: {
        top_k: 50,
        frequency_penalty: 1,
        provider_mode: 'failover-safe',
        model: 'must-not-override',
      },
    });

    expect(requestBody).not.toHaveProperty('tool_choice');
    expect(requestBody).not.toHaveProperty('reasoning_effort');
    expect(requestBody).not.toHaveProperty('parallel_tool_calls');
    expect(requestBody).toMatchObject({
      top_k: 50,
      frequency_penalty: 1,
      provider_mode: 'failover-safe',
      model: 'DeepSeek-R1-Distill-Qwen-14B',
    });
    expect(requestBody).not.toHaveProperty('extra_body');
    expect(requestBody?.tools).toEqual([expect.objectContaining({
      type: 'function',
      function: expect.objectContaining({ name: 'read_file' }),
    })]);
    expect(requestHeaders?.get('X-Failover-Enabled')).toBe('true');
  });

  it('flattens Gitee historical tool exchanges while keeping current tools enabled', async () => {
    let requestBody: Record<string, unknown> | undefined;
    globalThis.fetch = async (_url, init) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({
        id: 'cmpl_gitee_history',
        object: 'chat.completion',
        created: 1,
        model: 'qwen3.8-flash',
        choices: [{ index: 0, message: { role: 'assistant', content: '继续处理' }, finish_reason: 'stop' }],
      }));
    };

    const gateway = new ModelGateway({
      provider: 'giteeai',
      baseUrl: 'https://ai.gitee.com/v1',
      apiKey: 'gitee-key',
      model: 'qwen3.8-flash',
    });

    await gateway.chat({
      messages: [
        { role: 'system', content: '你是助手。' },
        { role: 'user', content: '读取文件' },
        {
          role: 'assistant',
          content: '',
          tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'list_files', arguments: '{"path":"."}' } }],
        },
        { role: 'tool', tool_call_id: 'call_1', content: '["README.md"]' },
        { role: 'user', content: '请继续。' },
      ],
      tools: [{
        type: 'function',
        function: { name: 'read_file', description: 'Read a file', parameters: { type: 'object', properties: {} } },
      }],
    });

    const messages = requestBody?.messages as Array<Record<string, unknown>>;
    expect(messages.map((message) => message.role)).toEqual(['system', 'user', 'assistant', 'user', 'user']);
    expect(messages[2]).toEqual({
      role: 'assistant',
      content: '[工具调用]\n名称: list_files\n参数: {"path":"."}',
    });
    expect(messages[3]).toEqual({ role: 'user', content: '[工具结果: list_files]\n["README.md"]' });
    expect(messages.some((message) => 'tool_calls' in message || message.role === 'tool')).toBe(false);
    expect(requestBody?.tools).toEqual([expect.objectContaining({
      function: expect.objectContaining({ name: 'read_file' }),
    })]);
  });

  it('applies the same Gitee history guard when the provider is openai-compatible', async () => {
    let requestBody: Record<string, unknown> | undefined;
    globalThis.fetch = async (_url, init) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({
        id: 'cmpl_gitee_custom_provider',
        object: 'chat.completion',
        created: 1,
        model: 'qwen3.8-flash',
        choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      }));
    };

    const gateway = new ModelGateway({
      provider: 'openai_compatible',
      baseUrl: 'https://ai.gitee.com/v1',
      apiKey: 'gitee-key',
      model: 'qwen3.8-flash',
    });

    await gateway.chat({
      messages: [
        { role: 'user', content: '读取文件' },
        {
          role: 'assistant',
          content: '',
          tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'list_files', arguments: '{}' } }],
        },
        { role: 'tool', tool_call_id: 'call_1', content: '[]' },
      ],
      tools: [{
        type: 'function',
        function: { name: 'read_file', description: 'Read a file', parameters: { type: 'object', properties: {} } },
      }],
    });

    const messages = requestBody?.messages as Array<Record<string, unknown>>;
    expect(messages.some((message) => 'tool_calls' in message || message.role === 'tool')).toBe(false);
    expect(messages.map((message) => message.role)).toEqual(['user', 'assistant', 'user']);
  });

  it('uses GLM thinking controls and streaming tool-call flag for Zhipu models that support them', async () => {
    let requestBody: unknown;
    const encoder = new TextEncoder();
    globalThis.fetch = async (_url, init) => {
      requestBody = JSON.parse(String(init?.body));
      return new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          controller.close();
        },
      }));
    };

    const gateway = new ModelGateway({
      provider: 'zhipu',
      baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
      apiKey: 'glm-key',
      model: 'glm-4.6',
      reasoningEffort: 'high',
    });

    const events = [];
    for await (const event of gateway.chatStream({
      messages: [{ role: 'user', content: 'hello' }],
      tools: [{
        type: 'function',
        function: {
          name: 'lookup',
          description: 'Look up data',
          parameters: { type: 'object', properties: {} },
        },
      }],
    })) {
      events.push(event);
    }

    expect(events).toContainEqual({ type: 'done' });
    expect(requestBody).toMatchObject({
      thinking: { type: 'enabled', clear_thinking: true },
      tool_stream: true,
    });
    expect(requestBody).not.toHaveProperty('reasoning_effort');
  });

  it('keeps GLM-5.2 reasoning_effort while using GLM thinking controls', async () => {
    let requestBody: unknown;
    globalThis.fetch = async (_url, init) => {
      requestBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({
        id: 'cmpl_glm',
        object: 'chat.completion',
        created: 1,
        model: 'glm-5.2',
        choices: [{
          index: 0,
          message: { role: 'assistant', content: 'ok' },
          finish_reason: 'stop',
        }],
      }));
    };

    const gateway = new ModelGateway({
      provider: 'zhipu',
      baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
      apiKey: 'glm-key',
      model: 'glm-5.2',
      reasoningEffort: 'xhigh',
    });

    await gateway.chat({ messages: [{ role: 'user', content: 'hello' }] });

    expect(requestBody).toMatchObject({
      thinking: { type: 'enabled', clear_thinking: true },
      reasoning_effort: 'xhigh',
    });
  });

  it('routes DeepSeek models on Ark through DeepSeek native thinking controls', async () => {
    let requestBody: unknown;
    globalThis.fetch = async (_url, init) => {
      requestBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({
        id: 'cmpl_ark_deepseek',
        object: 'chat.completion',
        created: 1,
        model: 'deepseek-v4-pro',
        choices: [{
          index: 0,
          message: { role: 'assistant', content: 'ok' },
          finish_reason: 'stop',
        }],
      }));
    };

    const gateway = new ModelGateway({
      provider: 'volcengine',
      baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
      apiKey: 'ark-key',
      model: 'deepseek-chat',
      reasoningEffort: 'xhigh',
    });

    await gateway.chat({ messages: [{ role: 'user', content: 'hello' }] });

    expect(requestBody).toMatchObject({
      thinking: {
        type: 'enabled',
        reasoning_effort: 'max',
      },
    });
    expect(requestBody).not.toHaveProperty('reasoning_effort');
  });

  it('streams DeepSeek reasoning_content as reasoning deltas instead of assistant text', async () => {
    globalThis.fetch = async () => new Response(new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();
        [
          'data: {"choices":[{"delta":{"reasoning_content":"plan first"}}]}',
          '',
          'data: {"choices":[{"delta":{"content":"answer"}}]}',
          '',
          'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_cache_hit_tokens":2,"prompt_cache_miss_tokens":3,"completion_tokens":4}}',
          '',
          'data: [DONE]',
          '',
        ].forEach((line) => controller.enqueue(encoder.encode(`${line}\n`)));
        controller.close();
      },
    }));

    const gateway = new ModelGateway({
      provider: 'deepseek',
      baseUrl: 'https://api.deepseek.test/v1',
      apiKey: 'test',
      model: 'deepseek-chat',
    });

    const events = [];
    for await (const event of gateway.chatStream({ messages: [{ role: 'user', content: 'hello' }] })) {
      events.push(event);
    }

    expect(events).toContainEqual({ type: 'reasoning_delta', content: 'plan first' });
    expect(events).toContainEqual({ type: 'delta', content: 'answer' });
    expect(events).not.toContainEqual({ type: 'delta', content: 'plan first' });
  });
});

describe('ModelGateway retry policy', () => {
  it('normalizes provider, model, and baseUrl before selecting protocol and credentials', () => {
    const gateway = new ModelGateway({
      provider: ' minimax ',
      model: '\tMiniMax-M3 ',
      baseUrl: ' https://api.minimaxi.com/anthropic/v1 ',
    });

    expect((gateway as unknown as { protocol: string }).protocol).toBe('anthropic');
    expect((gateway as unknown as { config: { provider: string; model: string; baseUrl: string } }).config).toMatchObject({
      provider: 'minimax',
      model: 'MiniMax-M3',
      baseUrl: 'https://api.minimaxi.com/anthropic/v1',
    });
  });

  it('adds Anthropic cache control to the last system block and final user message', async () => {
    let requestBody: unknown;
    globalThis.fetch = async (_url, init) => {
      requestBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({
        id: 'msg-test',
        type: 'message',
        role: 'assistant',
        model: 'claude-test',
        content: [{ type: 'text', text: 'ok' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 8 },
      }));
    };

    const gateway = new ModelGateway({
      provider: 'anthropic',
      baseUrl: 'http://anthropic.test/v1',
      model: 'claude-test',
    });

    await gateway.chat({
      messages: [
        { role: 'system', content: 'stable system' },
        { role: 'user', content: 'hello' },
      ],
    });

    expect(requestBody).toMatchObject({
      system: [{ type: 'text', text: 'stable system', cache_control: { type: 'ephemeral' } }],
      messages: [
        {
          role: 'user',
          content: [{ type: 'text', text: 'hello', cache_control: { type: 'ephemeral' } }],
        },
      ],
    });
  });

  it('does not add Anthropic cache control when cache strategy is disabled', async () => {
    let requestBody: unknown;
    globalThis.fetch = async (_url, init) => {
      requestBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({
        id: 'msg-test',
        type: 'message',
        role: 'assistant',
        model: 'claude-test',
        content: [{ type: 'text', text: 'ok' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 10, output_tokens: 2 },
      }));
    };

    const gateway = new ModelGateway({
      provider: 'anthropic',
      baseUrl: 'http://anthropic.test/v1',
      model: 'claude-test',
      cacheStrategy: 'none',
    });

    await gateway.chat({
      messages: [
        { role: 'system', content: 'stable system' },
        { role: 'user', content: 'hello' },
      ],
    });

    expect(JSON.stringify(requestBody)).not.toContain('cache_control');
  });

  it('retries retryable OpenAI-compatible failures and returns the successful response', async () => {
    let attempts = 0;
    globalThis.fetch = async () => {
      attempts += 1;
      if (attempts < 3) {
        return new Response('rate limited', { status: 429 });
      }
      return new Response(JSON.stringify({
        id: 'chatcmpl-test',
        object: 'chat.completion',
        created: 1,
        model: 'test-model',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: 'ok' },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
      }));
    };

    const gateway = new ModelGateway({
      provider: 'openai_compatible',
      baseUrl: 'http://example.test/v1',
      model: 'test-model',
      retry: { maxAttempts: 3, initialDelayMs: 1, maxDelayMs: 1 },
    });

    const retryNotices: Array<{ attempt: number; status?: number }> = [];
    const response = await gateway.chat(
      { messages: [{ role: 'user', content: 'hello' }] },
      { onRetry: (notice) => {
        retryNotices.push({ attempt: notice.attempt, status: notice.status });
      } },
    );

    expect(attempts).toBe(3);
    expect(retryNotices).toEqual([{ attempt: 1, status: 429 }, { attempt: 2, status: 429 }]);
    expect(response.choices[0]?.message.content).toBe('ok');
  });

  it('does not retry non-retryable authentication failures', async () => {
    let attempts = 0;
    globalThis.fetch = async () => {
      attempts += 1;
      return new Response('unauthorized', { status: 401 });
    };

    const gateway = new ModelGateway({
      provider: 'openai_compatible',
      baseUrl: 'http://example.test/v1',
      model: 'test-model',
      retry: { maxAttempts: 3, initialDelayMs: 1, maxDelayMs: 1 },
    });

    await expect(gateway.chat({ messages: [{ role: 'user', content: 'hello' }] })).rejects.toThrow('401');
    expect(attempts).toBe(1);
  });

  it('propagates caller abort signals into OpenAI-compatible fetch requests', async () => {
    const controller = new AbortController();
    let observedSignal: AbortSignal | undefined;
    globalThis.fetch = async (_url, init) => {
      observedSignal = init?.signal as AbortSignal | undefined;
      controller.abort('stop requested');
      throw new DOMException('Aborted', 'AbortError');
    };

    const gateway = new ModelGateway({
      provider: 'openai_compatible',
      baseUrl: 'http://example.test/v1',
      model: 'test-model',
      retry: { maxAttempts: 1 },
    });

    await expect(gateway.chat(
      { messages: [{ role: 'user', content: 'hello' }] },
      { signal: controller.signal },
    )).rejects.toThrow('Aborted');

    expect(observedSignal).toBeDefined();
    expect(observedSignal?.aborted).toBe(true);
  });
});
