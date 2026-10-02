import { describe, expect, it } from 'vitest';
import {
  buildResponsesRequest,
  normalizeResponsesResponse,
  parseResponsesStream,
} from './responsesClient.js';

describe('Responses API 转换', () => {
  it('把消息、图片、工具、推理和结构化输出映射到 Responses 请求', () => {
    const request = buildResponsesRequest({
      messages: [
        { role: 'system', content: '你是助手。' },
        {
          role: 'user',
          content: [
            { type: 'text', text: '读取文件' },
            { type: 'image_url', image_url: { url: 'https://example.test/a.png', detail: 'high' } },
          ],
        },
        {
          role: 'assistant',
          content: '',
          reasoning_content: '先检查路径。',
          tool_calls: [{
            id: 'call_1',
            type: 'function',
            function: { name: 'read_file', arguments: '{"path":"a.txt"}' },
          }],
        },
        { role: 'tool', tool_call_id: 'call_1', content: '内容' },
      ],
      tools: [{
        type: 'function',
        function: { name: 'read_file', description: '读取文件', parameters: { type: 'object' } },
      }],
      reasoning_effort: 'high',
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'answer', schema: { type: 'object' }, strict: true },
      },
    }, { model: 'gpt-5', maxTokens: 100, temperature: 0, topP: 1, reasoningEffort: 'medium' }, undefined, true);

    expect(request).toMatchObject({
      model: 'gpt-5',
      max_output_tokens: 100,
      temperature: 0,
      top_p: 1,
      reasoning: { effort: 'high' },
      stream: true,
      text: { format: { type: 'json_schema', name: 'answer', strict: true } },
      tools: [{ type: 'function', name: 'read_file', parameters: { type: 'object' } }],
    });
    expect(request.input).toEqual(expect.arrayContaining([
      { type: 'message', role: 'system', content: '你是助手。' },
      {
        type: 'message',
        role: 'user',
        content: [
          { type: 'input_text', text: '读取文件' },
          { type: 'input_image', image_url: 'https://example.test/a.png', detail: 'high' },
        ],
      },
      {
        type: 'reasoning',
        summary: [{ type: 'summary_text', text: '先检查路径。' }],
      },
      { type: 'function_call', call_id: 'call_1', name: 'read_file', arguments: '{"path":"a.txt"}' },
      { type: 'function_call_output', call_id: 'call_1', output: '内容' },
    ]));
  });

  it('仅为 llama.cpp Responses 回放 reasoning content，原生 OpenAI 不增加该字段', () => {
    const messages = [{ role: 'assistant' as const, content: '', reasoning_content: '保留的推理文本' }];
    const llamaRequest = buildResponsesRequest({ messages }, {
      model: 'local-model', maxTokens: 64, temperature: 0.2, topP: 0.9, reasoningEffort: 'medium', provider: 'llama.cpp',
    });
    const openAiRequest = buildResponsesRequest({ messages }, {
      model: 'gpt-5', maxTokens: 64, temperature: 0.2, topP: 0.9, reasoningEffort: 'medium', provider: 'openai',
    });

    expect(llamaRequest.input).toContainEqual({
      type: 'reasoning',
      summary: [{ type: 'summary_text', text: '保留的推理文本' }],
      content: [{ type: 'input_text', text: '保留的推理文本' }],
    });
    expect(openAiRequest.input).toContainEqual({
      type: 'reasoning',
      summary: [{ type: 'summary_text', text: '保留的推理文本' }],
    });
    const openAiReasoningItem = openAiRequest.input.find((item) => item.type === 'reasoning');
    expect(openAiReasoningItem).toEqual({
      type: 'reasoning',
      summary: [{ type: 'summary_text', text: '保留的推理文本' }],
    });
  });

  it('把 output 文本、reasoning、function_call 和 usage 转成统一响应', () => {
    const response = normalizeResponsesResponse({
      id: 'resp_1',
      created_at: 1710000000,
      model: 'gpt-5',
      status: 'completed',
      output: [
        { type: 'reasoning', summary: [{ type: 'summary_text', text: '思考' }] },
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '答案' }] },
        { type: 'function_call', call_id: 'call_1', name: 'read_file', arguments: '{"path":"a.txt"}' },
      ],
      usage: {
        input_tokens: 20,
        output_tokens: 8,
        total_tokens: 28,
        input_tokens_details: { cached_tokens: 12 },
      },
    }, 'fallback', 'openai-compatible');

    expect(response).toMatchObject({
      id: 'resp_1',
      object: 'chat.completion',
      created: 1710000000,
      model: 'gpt-5',
      choices: [{
        message: {
          role: 'assistant',
          content: '答案',
          reasoning_content: '思考',
          tool_calls: [{ id: 'call_1', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } }],
        },
        finish_reason: 'tool_calls',
      }],
      usage: {
        prompt_tokens: 20,
        completion_tokens: 8,
        total_tokens: 28,
        cached_tokens: 12,
        cache_reported: true,
        cache_source: 'openai',
        cache_strategy: 'openai-compatible',
      },
    });
  });

  it('保留 llama.cpp Responses 的 slot/cache 控制和 timings 缓存命中', () => {
    const request = buildResponsesRequest({
      messages: [{ role: 'user', content: '继续' }],
      stop: ['<END>'],
    }, {
      model: 'local-model',
      maxTokens: 64,
      temperature: 0.2,
      topP: 0.9,
      reasoningEffort: 'medium',
      provider: 'llama.cpp',
    }, { llama: { idSlot: 1, cachePrompt: true, returnProgress: true } });

    expect(request).toMatchObject({
      id_slot: 1,
      cache_prompt: true,
      return_progress: true,
      stop: ['<END>'],
    });
    const response = normalizeResponsesResponse({
      id: 'resp_local',
      status: 'completed',
      output: [{ type: 'message', content: [{ type: 'output_text', text: '完成' }] }],
      timings: { cache_n: 120, prompt_n: 8 },
    }, 'local-model', 'openai-compatible');
    expect(response.usage).toMatchObject({
      prompt_tokens: 128,
      cached_tokens: 120,
      cache_reported: true,
      cache_source: 'llama-timings',
    });
  });

  it('DeepSeek native Responses usage 始终保留 deepseek 缓存来源', () => {
    const response = normalizeResponsesResponse({
      id: 'resp_deepseek_usage',
      status: 'completed',
      output: [{ type: 'message', content: [{ type: 'output_text', text: '完成' }] }],
      usage: { input_tokens: 20, output_tokens: 4, total_tokens: 24 },
    }, 'deepseek-v4-pro', 'deepseek-native');

    expect(response.usage).toMatchObject({
      cache_strategy: 'deepseek-native',
      cache_source: 'deepseek',
      cache_reported: false,
    });
  });
});

describe('Responses SSE 转换', () => {
  it('解析文本、工具参数和 response.completed，并且只发出一次 done', async () => {
    const payload = [
      'event: response.output_item.added',
      'data: {"type":"response.output_item.added","output_index":0,"item":{"id":"fc_1","type":"function_call","call_id":"call_1","name":"read_file","arguments":""}}',
      '',
      'event: response.output_text.delta',
      'data: {"type":"response.output_text.delta","item_id":"msg_1","delta":"答"}',
      '',
      'event: response.function_call_arguments.delta',
      `data: ${JSON.stringify({ type: 'response.function_call_arguments.delta', item_id: 'fc_1', delta: '{"path":"' })}`,
      '',
      'event: response.function_call_arguments.done',
      `data: ${JSON.stringify({ type: 'response.function_call_arguments.done', item_id: 'fc_1', arguments: '{"path":"a.txt"}' })}`,
      '',
      'event: response.completed',
      'data: {"type":"response.completed","response":{"id":"resp_1","status":"completed","output":[],"usage":{"input_tokens":4,"output_tokens":2,"total_tokens":6}}}',
      '',
    ].join('\n');
    const reader = new Response(payload).body?.getReader();
    if (!reader) throw new Error('missing reader');

    const events = [];
    for await (const event of parseResponsesStream(reader, 'openai-compatible')) events.push(event);
    expect(events).toContainEqual({ type: 'tool_call_start', id: 'call_1', name: 'read_file' });
    expect(events).toContainEqual({ type: 'delta', content: '答' });
    expect(events).toContainEqual({ type: 'tool_call_delta', id: 'call_1', arguments: '{"path":"' });
    expect(events).toContainEqual({ type: 'tool_call_end', id: 'call_1', name: 'read_file', arguments: '{"path":"a.txt"}' });
    expect(events.filter((event) => event.type === 'done')).toHaveLength(1);
    expect(events.find((event) => event.type === 'done')).toMatchObject({ usage: { prompt_tokens: 4, completion_tokens: 2 } });
  });

  it('把 response.failed 作为错误终态，不伪造 done', async () => {
    const payload = [
      'event: response.failed',
      'data: {"type":"response.failed","response":{"status":"failed"}}',
      '',
    ].join('\n');
    const reader = new Response(payload).body?.getReader();
    if (!reader) throw new Error('missing reader');

    const events = [];
    for await (const event of parseResponsesStream(reader)) events.push(event);
    expect(events).toContainEqual({
      type: 'error',
      error: expect.objectContaining({ message: 'Responses provider returned a failed response.' }),
    });
    expect(events.filter((event) => event.type === 'done')).toHaveLength(0);
  });

  it('保留 Responses SSE 的 detail 错误字段', async () => {
    const payload = [
      'event: error',
      'data: {"type":"error","detail":"模板不支持 Responses"}',
      '',
    ].join('\n');
    const reader = new Response(payload).body?.getReader();
    if (!reader) throw new Error('missing reader');

    const events = [];
    for await (const event of parseResponsesStream(reader)) events.push(event);
    expect(events).toContainEqual({
      type: 'error',
      error: expect.objectContaining({ message: '模板不支持 Responses' }),
    });
  });

  it('处理没有尾部换行的最后一条 SSE 事件', async () => {
    const payload = [
      'event: response.output_text.delta',
      'data: {"type":"response.output_text.delta","delta":"尾帧"}',
      '',
      'event: response.completed',
      'data: {"type":"response.completed","response":{"status":"completed","output":[]}}',
    ].join('\n');
    const reader = new Response(payload).body?.getReader();
    if (!reader) throw new Error('missing reader');

    const events = [];
    for await (const event of parseResponsesStream(reader)) events.push(event);
    expect(events).toContainEqual({ type: 'delta', content: '尾帧' });
    expect(events.filter((event) => event.type === 'done')).toHaveLength(1);
  });

  it('正常 EOF 未收到终态时发出错误而不是伪造 done', async () => {
    const payload = [
      'event: response.output_text.delta',
      'data: {"type":"response.output_text.delta","delta":"未完成"}',
      '',
    ].join('\n');
    const reader = new Response(payload).body?.getReader();
    if (!reader) throw new Error('missing reader');

    const events = [];
    for await (const event of parseResponsesStream(reader)) events.push(event);
    expect(events).toContainEqual({
      type: 'error',
      error: expect.objectContaining({ message: 'Responses stream ended before a terminal event was received.' }),
    });
    expect(events.filter((event) => event.type === 'done')).toHaveLength(0);
  });

  it('不会把 reasoning.done 的完整摘要重复追加到增量推理', async () => {
    const payload = [
      'event: response.reasoning_summary_text.delta',
      'data: {"type":"response.reasoning_summary_text.delta","item_id":"r_1","delta":"先检查"}',
      '',
      'event: response.reasoning_summary_text.done',
      'data: {"type":"response.reasoning_summary_text.done","item_id":"r_1","text":"先检查"}',
      '',
      'event: response.completed',
      'data: {"type":"response.completed","response":{"status":"completed","output":[]}}',
      '',
    ].join('\n');
    const reader = new Response(payload).body?.getReader();
    if (!reader) throw new Error('missing reader');

    const events = [];
    for await (const event of parseResponsesStream(reader)) events.push(event);
    expect(events.filter((event) => event.type === 'reasoning_delta')).toEqual([
      { type: 'reasoning_delta', content: '先检查' },
    ]);
    expect(events.filter((event) => event.type === 'done')).toHaveLength(1);
  });
});
