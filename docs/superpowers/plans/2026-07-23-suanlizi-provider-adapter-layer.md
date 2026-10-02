# Suanlizi Provider Adapter Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build first-class provider adapters for MiniMax-M3, DeepSeek, OpenAI, and Anthropic so tool history, reasoning fields, and streaming retries use provider-correct wire formats instead of text placeholders.

**Architecture:** Add a profile/transport/history boundary inside `@suanlizi/model-gateway`, then update `@suanlizi/runtime` to persist provider frames and build model history through the adapter. Existing UI/settings config remains unchanged; generic compatible providers continue through the current compatible path.

**Tech Stack:** TypeScript, Vitest, existing fetch-based gateway transport, `@suanlizi/protocol`, `@suanlizi/runtime`, `@suanlizi/model-gateway`.

---

## File Structure

- Create `packages/model-gateway/src/providerProfiles.ts`
  - Owns provider capability/profile metadata: endpoint format, transport id, reasoning mode, tool history mode, cache mode.
- Create `packages/model-gateway/src/providerFrames.ts`
  - Owns serializable provider assistant frames and helpers to build/replay OpenAI Chat, OpenAI Responses, and Anthropic Messages structures.
- Modify `packages/model-gateway/src/providers.ts`
  - Keeps existing provider list and key resolution; delegates protocol/endpoint capability lookup to profiles.
- Modify `packages/model-gateway/src/types.ts`
  - Adds endpoint/transport/profile types and provider frame fields to request/response event surfaces.
- Modify `packages/model-gateway/src/gateway.ts`
  - Resolves profile once, emits request extras, preserves providerData, and includes monitor diagnostics.
- Modify `packages/model-gateway/src/index.ts`
  - Exports new profile/frame APIs.
- Modify `packages/model-gateway/src/gateway.test.ts`
  - Adds provider profile, MiniMax, DeepSeek, OpenAI/Anthropic conversion tests.
- Modify `packages/protocol/src/types.ts`
  - Adds optional persisted provider frame and model tool-call id fields.
- Modify `packages/protocol/src/schemas.ts`
  - Allows new optional fields in persisted item validation.
- Modify `packages/runtime/src/agent.ts`
  - Replaces `itemToMessage()` direct history conversion with adapter-backed history builder; persists model tool ids and provider assistant frames; changes invalid stream retry behavior.
- Modify `packages/runtime/src/agent.test.ts`
  - Adds regression tests for no `[Tool ...]` replay, MiniMax leak recovery, and provider tool id persistence.
- Modify `packages/runtime/src/modelOutput.test.ts`
  - Keeps leak detector tests valid while ensuring sanitized history no longer triggers it.
- Modify `packages/runtime/src/index.ts`
  - Exports any new helper only if tests or downstream packages need it.

## Task 1: Provider Profile Types and Registry

**Files:**
- Create: `packages/model-gateway/src/providerProfiles.ts`
- Modify: `packages/model-gateway/src/types.ts`
- Modify: `packages/model-gateway/src/index.ts`
- Test: `packages/model-gateway/src/gateway.test.ts`

- [ ] **Step 1: Write failing profile tests**

Add tests to `packages/model-gateway/src/gateway.test.ts`:

```ts
import { getProviderProfile, resolveProviderProfile } from './providerProfiles.js';

describe('provider profiles', () => {
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
```

- [ ] **Step 2: Run tests and verify failure**

Run:

```powershell
npm test -- packages/model-gateway/src/gateway.test.ts -t "provider profiles"
```

Expected: FAIL because `providerProfiles.ts` and exported functions do not exist.

- [ ] **Step 3: Implement profile types and registry**

Create `packages/model-gateway/src/providerProfiles.ts`:

```ts
import type { ModelConfig } from './types.js';
import { getProvider } from './providers.js';

export type ModelEndpointFormat =
  | 'chat_completions'
  | 'responses'
  | 'anthropic_messages'
  | 'custom_endpoint';

export type ModelTransportId =
  | 'openai_chat_completions'
  | 'openai_responses'
  | 'anthropic_messages';

export type ToolHistoryMode =
  | 'openai_chat'
  | 'openai_responses'
  | 'anthropic_blocks';

export type ReasoningMode =
  | 'none'
  | 'deepseek_reasoning_content'
  | 'minimax_anthropic_thinking'
  | 'minimax_openai_reasoning_details'
  | 'anthropic_thinking'
  | 'openai_responses_items';

export type ProviderCacheMode =
  | 'none'
  | 'deepseek_native'
  | 'openai_prompt_details'
  | 'anthropic_cache_control';

export interface ProviderProfile {
  id: string;
  displayName: string;
  baseUrl: string;
  apiKeyEnvVars: string[];
  endpointFormat: ModelEndpointFormat;
  transport: ModelTransportId;
  toolHistoryMode: ToolHistoryMode;
  reasoningMode: ReasoningMode;
  cacheMode: ProviderCacheMode;
}

const KNOWN_PROFILES: Record<string, Omit<ProviderProfile, 'baseUrl' | 'apiKeyEnvVars'>> = {
  openai: {
    id: 'openai',
    displayName: 'OpenAI',
    endpointFormat: 'responses',
    transport: 'openai_responses',
    toolHistoryMode: 'openai_responses',
    reasoningMode: 'openai_responses_items',
    cacheMode: 'openai_prompt_details',
  },
  deepseek: {
    id: 'deepseek',
    displayName: 'DeepSeek',
    endpointFormat: 'chat_completions',
    transport: 'openai_chat_completions',
    toolHistoryMode: 'openai_chat',
    reasoningMode: 'deepseek_reasoning_content',
    cacheMode: 'deepseek_native',
  },
  anthropic: {
    id: 'anthropic',
    displayName: 'Anthropic',
    endpointFormat: 'anthropic_messages',
    transport: 'anthropic_messages',
    toolHistoryMode: 'anthropic_blocks',
    reasoningMode: 'anthropic_thinking',
    cacheMode: 'anthropic_cache_control',
  },
  minimax: {
    id: 'minimax',
    displayName: 'MiniMax',
    endpointFormat: 'anthropic_messages',
    transport: 'anthropic_messages',
    toolHistoryMode: 'anthropic_blocks',
    reasoningMode: 'minimax_anthropic_thinking',
    cacheMode: 'anthropic_cache_control',
  },
};

export function getProviderProfile(providerId: string): ProviderProfile | undefined {
  const normalized = normalizeProviderId(providerId);
  const base = KNOWN_PROFILES[normalized];
  if (!base) return undefined;
  const provider = getProvider(normalized);
  return {
    ...base,
    baseUrl: provider?.baseUrl ?? '',
    apiKeyEnvVars: provider?.apiKeyEnvVar ? [provider.apiKeyEnvVar] : [],
  };
}

export function resolveProviderProfile(config: Pick<ModelConfig, 'provider' | 'baseUrl' | 'model'>): ProviderProfile {
  const known = getProviderProfile(config.provider);
  if (known) {
    return {
      ...known,
      baseUrl: config.baseUrl?.trim() || known.baseUrl,
    };
  }
  const provider = getProvider(config.provider);
  const baseUrl = config.baseUrl?.trim() || provider?.baseUrl || '';
  return {
    id: config.provider.trim() || 'openai_compatible',
    displayName: provider?.name ?? config.provider.trim() || 'OpenAI-compatible',
    baseUrl,
    apiKeyEnvVars: provider?.apiKeyEnvVar ? [provider.apiKeyEnvVar] : [],
    endpointFormat: provider?.protocol === 'anthropic' ? 'anthropic_messages' : 'chat_completions',
    transport: provider?.protocol === 'anthropic' ? 'anthropic_messages' : 'openai_chat_completions',
    toolHistoryMode: provider?.protocol === 'anthropic' ? 'anthropic_blocks' : 'openai_chat',
    reasoningMode: 'none',
    cacheMode: provider?.protocol === 'anthropic' ? 'anthropic_cache_control' : 'openai_prompt_details',
  };
}

function normalizeProviderId(providerId: string): string {
  const normalized = providerId.trim().toLowerCase();
  if (normalized === 'doubao') return 'volcengine';
  return normalized;
}
```

Modify `packages/model-gateway/src/index.ts`:

```ts
export * from './providerProfiles.js';
```

- [ ] **Step 4: Run tests and verify pass**

Run:

```powershell
npm test -- packages/model-gateway/src/gateway.test.ts -t "provider profiles"
```

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add packages/model-gateway/src/providerProfiles.ts packages/model-gateway/src/index.ts packages/model-gateway/src/gateway.test.ts
git commit -m "feat(model): add provider profiles"
```

## Task 2: Provider Frames and Wire History Builders

**Files:**
- Create: `packages/model-gateway/src/providerFrames.ts`
- Modify: `packages/model-gateway/src/index.ts`
- Test: `packages/model-gateway/src/gateway.test.ts`

- [ ] **Step 1: Write failing provider frame tests**

Add tests to `packages/model-gateway/src/gateway.test.ts`:

```ts
import {
  buildOpenAiChatToolHistory,
  buildAnthropicToolHistory,
  type ProviderAssistantFrame,
} from './providerFrames.js';

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
        content: null,
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
```

- [ ] **Step 2: Run tests and verify failure**

Run:

```powershell
npm test -- packages/model-gateway/src/gateway.test.ts -t "provider frames"
```

Expected: FAIL because `providerFrames.ts` does not exist.

- [ ] **Step 3: Implement provider frame helpers**

Create `packages/model-gateway/src/providerFrames.ts`:

```ts
import type { AnthropicContentBlock, ChatMessage, ToolCall } from './types.js';

export type ProviderAssistantFrame =
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

export interface ProviderToolResultReplay {
  modelToolCallId: string;
  output: string;
}

export function buildOpenAiChatToolHistory(
  frame: Extract<ProviderAssistantFrame, { format: 'openai_chat' }>,
  results: ProviderToolResultReplay[],
): ChatMessage[] {
  const messages: ChatMessage[] = [];
  messages.push({
    role: 'assistant',
    content: frame.content,
    tool_calls: frame.toolCalls,
    ...(frame.reasoningContent ? { reasoning_content: frame.reasoningContent } as Partial<ChatMessage> : {}),
  } as ChatMessage);
  for (const result of results) {
    messages.push({
      role: 'tool',
      tool_call_id: result.modelToolCallId,
      content: result.output,
    });
  }
  return messages;
}

export function buildAnthropicToolHistory(
  frame: Extract<ProviderAssistantFrame, { format: 'anthropic_messages' }>,
  results: ProviderToolResultReplay[],
): Array<{ role: 'user' | 'assistant'; content: AnthropicContentBlock[] }> {
  const messages: Array<{ role: 'user' | 'assistant'; content: AnthropicContentBlock[] }> = [];
  messages.push({
    role: 'assistant',
    content: frame.contentBlocks,
  });
  const resultBlocks: AnthropicContentBlock[] = results.map((result) => ({
    type: 'tool_result',
    tool_use_id: result.modelToolCallId,
    content: result.output,
  }));
  if (resultBlocks.length > 0) {
    messages.push({ role: 'user', content: resultBlocks });
  }
  return messages;
}
```

Extend `ChatMessage` in `packages/model-gateway/src/types.ts`:

```ts
  reasoning_content?: string;
  reasoning_details?: unknown[];
```

Modify `packages/model-gateway/src/index.ts`:

```ts
export * from './providerFrames.js';
```

- [ ] **Step 4: Run tests and verify pass**

Run:

```powershell
npm test -- packages/model-gateway/src/gateway.test.ts -t "provider frames"
```

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add packages/model-gateway/src/providerFrames.ts packages/model-gateway/src/types.ts packages/model-gateway/src/index.ts packages/model-gateway/src/gateway.test.ts
git commit -m "feat(model): add provider frame replay helpers"
```

## Task 3: Persist Model Tool IDs and Provider Assistant Frames

**Files:**
- Modify: `packages/protocol/src/types.ts`
- Modify: `packages/protocol/src/schemas.ts`
- Modify: `packages/runtime/src/agent.ts`
- Test: `packages/runtime/src/agent.test.ts`

- [ ] **Step 1: Write failing runtime persistence tests**

Add tests to `packages/runtime/src/agent.test.ts`:

```ts
it('persists model tool call ids on tool call items', async () => {
  const model = new ScriptedModelGateway([
    {
      content: null,
      tool_calls: [{
        id: 'call_read_file_123',
        type: 'function',
        function: { name: 'read_file', arguments: '{"path":"README.md"}' },
      }],
    },
    { content: 'done' },
  ]);
  const result = await runAgentFixture({ model, userText: 'read README' });
  const toolItem = result.items.find((item) => item.type === 'tool_call');
  expect(toolItem).toMatchObject({
    type: 'tool_call',
    modelToolCallId: 'call_read_file_123',
    modelToolName: 'read_file',
  });
});

it('persists provider assistant frames for model tool turns', async () => {
  const model = new ScriptedModelGateway([
    {
      content: null,
      tool_calls: [{
        id: 'call_read_file_456',
        type: 'function',
        function: { name: 'read_file', arguments: '{"path":"README.md"}' },
      }],
    },
    { content: 'done' },
  ]);
  const result = await runAgentFixture({ model, userText: 'read README' });
  const assistantItem = result.items.find((item) =>
    item.type === 'agent_message' &&
    item.providerFrame &&
    item.providerFrame.format === 'openai_chat'
  );
  expect(assistantItem).toBeTruthy();
});
```

- [ ] **Step 2: Run tests and verify failure**

Run:

```powershell
npm test -- packages/runtime/src/agent.test.ts -t "persists model tool"
```

Expected: FAIL because persisted item fields and helper behavior do not exist.

- [ ] **Step 3: Add protocol fields**

Modify `packages/protocol/src/types.ts`:

```ts
export type ProviderAssistantFrame =
  | {
      format: 'openai_chat';
      content: string | null;
      toolCalls?: unknown[];
      reasoningContent?: string;
      reasoningDetails?: unknown[];
    }
  | {
      format: 'openai_responses';
      outputItems: unknown[];
    }
  | {
      format: 'anthropic_messages';
      contentBlocks: unknown[];
    };

export interface ProviderToolCallFrame {
  format: 'openai_chat' | 'openai_responses' | 'anthropic_messages';
  id: string;
  name: string;
  arguments: unknown;
  raw?: unknown;
}
```

Add to `AgentMessageItem`:

```ts
  providerFrame?: ProviderAssistantFrame;
```

Add to `ReasoningItem`:

```ts
  providerFrameRef?: string;
```

Add to `ToolCallItem`, `McpToolCallItem`, and `CollabToolCallItem`:

```ts
  modelToolCallId?: string;
  modelToolName?: string;
  providerToolCall?: ProviderToolCallFrame;
```

Modify `packages/protocol/src/schemas.ts` to accept these fields as optional `z.unknown()` or strict nested schema. Use strict schema for `providerFrame.format` and `providerToolCall.format`.

- [ ] **Step 4: Persist fields from runtime**

Modify `packages/runtime/src/agent.ts` in `executeToolCall()` when creating `toolItem`:

```ts
modelToolCallId: toolCall.id,
modelToolName: toolCall.function.name,
providerToolCall: {
  format: 'openai_chat',
  id: toolCall.id,
  name: toolCall.function.name,
  arguments: args,
  raw: toolCall,
},
```

When the model returns `tool_calls`, persist an assistant frame item before executing tools:

```ts
const assistantFrameItem: ThreadItem = {
  id: generateItemId(turnId, collectedItems.length),
  type: 'agent_message',
  turnId,
  text: message.content ?? '',
  providerFrame: {
    format: 'openai_chat',
    content: message.content ?? null,
    toolCalls: message.tool_calls,
  },
  timestamp: new Date().toISOString(),
};
collectedItems.push(assistantFrameItem);
this.emit({ type: 'item.started', threadId, turnId, item: assistantFrameItem });
this.emit({ type: 'item.completed', threadId, turnId, item: assistantFrameItem });
await this.persistItems(threadId, [assistantFrameItem]);
```

- [ ] **Step 5: Run tests and verify pass**

Run:

```powershell
npm test -- packages/runtime/src/agent.test.ts -t "persists model tool"
```

Expected: PASS.

- [ ] **Step 6: Commit**

```powershell
git add packages/protocol/src/types.ts packages/protocol/src/schemas.ts packages/runtime/src/agent.ts packages/runtime/src/agent.test.ts
git commit -m "feat(runtime): persist provider tool frames"
```

## Task 4: Replace Text Placeholder History Replay

**Files:**
- Modify: `packages/runtime/src/agent.ts`
- Test: `packages/runtime/src/agent.test.ts`
- Test: `packages/runtime/src/modelOutput.test.ts`

- [ ] **Step 1: Write failing no-placeholder replay test**

Add to `packages/runtime/src/agent.test.ts`:

```ts
it('does not replay completed tools as assistant text placeholders', async () => {
  const model = new RecordingModelGateway([
    {
      content: null,
      tool_calls: [{
        id: 'call_read_1',
        type: 'function',
        function: { name: 'read_file', arguments: '{"path":"README.md"}' },
      }],
    },
    { content: 'first done' },
    { content: 'second done' },
  ]);
  await runAgentFixture({ model, userText: 'read README' });
  await runAgentFixture({ model, userText: 'continue' });
  const secondCallMessages = model.calls.at(-1)?.messages ?? [];
  const serialized = JSON.stringify(secondCallMessages);
  expect(serialized).not.toContain('[Tool');
  expect(serialized).toContain('tool_call_id');
  expect(serialized).toContain('call_read_1');
});
```

- [ ] **Step 2: Run test and verify failure**

Run:

```powershell
npm test -- packages/runtime/src/agent.test.ts -t "does not replay completed tools"
```

Expected: FAIL because `itemToMessage()` currently emits `[Tool ...]`.

- [ ] **Step 3: Implement history builder in runtime**

In `packages/runtime/src/agent.ts`, replace direct `items.map(itemToMessage)` history construction with a new helper:

```ts
function threadItemsToModelMessages(items: ThreadItem[]): ChatMessage[] {
  const messages: ChatMessage[] = [];
  const pendingToolResults = new Map<string, Array<{ modelToolCallId: string; output: string }>>();

  for (const item of items) {
    if (item.type === 'user_message') {
      messages.push({ role: 'user', content: item.text });
      continue;
    }

    if (item.type === 'agent_message') {
      if (item.providerFrame?.format === 'openai_chat') {
        messages.push({
          role: 'assistant',
          content: item.providerFrame.content,
          tool_calls: item.providerFrame.toolCalls as ChatMessage['tool_calls'],
        });
        continue;
      }
      if (!leaksToolProtocol(item.text)) {
        messages.push({ role: 'assistant', content: item.text });
      }
      continue;
    }

    if ((item.type === 'tool_call' || item.type === 'mcp_tool_call' || item.type === 'collab_tool_call') && item.modelToolCallId) {
      messages.push({
        role: 'tool',
        tool_call_id: item.modelToolCallId,
        content: formatToolHistoryPayload(item.result ?? item.error ?? ''),
      });
      continue;
    }
  }

  return collapseInvalidToolOrphans(messages);
}
```

Add `collapseInvalidToolOrphans()`:

```ts
function collapseInvalidToolOrphans(messages: ChatMessage[]): ChatMessage[] {
  const validCallIds = new Set<string>();
  const out: ChatMessage[] = [];
  for (const message of messages) {
    if (message.role === 'assistant') {
      for (const call of message.tool_calls ?? []) validCallIds.add(call.id);
      out.push(message);
      continue;
    }
    if (message.role === 'tool' && (!message.tool_call_id || !validCallIds.has(message.tool_call_id))) {
      out.push({
        role: 'user',
        content: `Previous tool result omitted from structured replay because its model tool call id is missing: ${String(message.content).slice(0, 500)}`,
      });
      continue;
    }
    out.push(message);
  }
  return out;
}
```

Delete or stop using the `tool_call`, `collab_tool_call`, `mcp_tool_call`, and `command_execution` placeholder branches in `itemToMessage()`.

- [ ] **Step 4: Run tests and verify pass**

Run:

```powershell
npm test -- packages/runtime/src/agent.test.ts -t "does not replay completed tools"
npm test -- packages/runtime/src/modelOutput.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add packages/runtime/src/agent.ts packages/runtime/src/agent.test.ts packages/runtime/src/modelOutput.test.ts
git commit -m "fix(runtime): replay tool history structurally"
```

## Task 5: MiniMax and DeepSeek Request/Response Behavior

**Files:**
- Modify: `packages/model-gateway/src/gateway.ts`
- Modify: `packages/model-gateway/src/types.ts`
- Modify: `packages/model-gateway/src/providerProfiles.ts`
- Test: `packages/model-gateway/src/gateway.test.ts`

- [ ] **Step 1: Write failing MiniMax/DeepSeek tests**

Add to `packages/model-gateway/src/gateway.test.ts`:

```ts
describe('MiniMax and DeepSeek provider behavior', () => {
  it('adds MiniMax Anthropic diagnostics without switching to OpenAI placeholders', async () => {
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

  it('preserves DeepSeek reasoning_content in normalized OpenAI responses', async () => {
    const response = convertOpenAIResponseForTest({
      id: 'cmpl_1',
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
});
```

- [ ] **Step 2: Run tests and verify failure**

Run:

```powershell
npm test -- packages/model-gateway/src/gateway.test.ts -t "MiniMax and DeepSeek"
```

Expected: FAIL because profile is not stored on gateway and test converter is not exported.

- [ ] **Step 3: Implement provider-aware gateway fields**

Modify `packages/model-gateway/src/gateway.ts` constructor:

```ts
import { resolveProviderProfile, type ProviderProfile } from './providerProfiles.js';

private profile: ProviderProfile;

constructor(config: ModelConfig) {
  ...
  this.profile = resolveProviderProfile({
    provider: normalizedConfig.provider,
    baseUrl: resolvedBaseUrl,
    model: normalizedConfig.model,
  });
  this.protocol = this.profile.transport === 'anthropic_messages' ? 'anthropic' : 'openai';
  this.cacheStrategy = resolveCacheStrategy(this.config, this.protocol);
}
```

Modify OpenAI response conversion to copy provider fields:

```ts
const reasoningContent = message.reasoning_content;
const reasoningDetails = message.reasoning_details;
...
message: {
  role: 'assistant',
  content: message.content ?? '',
  tool_calls: message.tool_calls,
  ...(typeof reasoningContent === 'string' ? { reasoning_content: reasoningContent } : {}),
  ...(Array.isArray(reasoningDetails) ? { reasoning_details: reasoningDetails } : {}),
}
```

Export a test-only helper from `gateway.ts`:

```ts
export function convertOpenAIResponseForTest(raw: OpenAIChatCompletionResponse, cacheStrategy?: CacheStrategy): ChatCompletionResponse {
  return normalizeOpenAIResponse(raw, cacheStrategy);
}
```

- [ ] **Step 4: Run tests and verify pass**

Run:

```powershell
npm test -- packages/model-gateway/src/gateway.test.ts -t "MiniMax and DeepSeek"
```

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add packages/model-gateway/src/gateway.ts packages/model-gateway/src/types.ts packages/model-gateway/src/providerProfiles.ts packages/model-gateway/src/gateway.test.ts
git commit -m "feat(model): preserve provider reasoning fields"
```

## Task 6: Plain-Text Tool Leak Retry Without History Pollution

**Files:**
- Modify: `packages/runtime/src/agent.ts`
- Test: `packages/runtime/src/agent.test.ts`

- [ ] **Step 1: Write failing retry pollution test**

Add to `packages/runtime/src/agent.test.ts`:

```ts
it('does not push plain-text tool placeholder output into retry history', async () => {
  const model = new RecordingModelGateway([
    { content: '我来读取文件。[Tool read_file completed]\\n{"output":"bad"}' },
    { content: '已修正，直接回答。' },
  ]);
  const result = await runAgentFixture({ model, userText: '继续' });
  expect(result.items.some((item) =>
    item.type === 'agent_message' &&
    item.text.includes('[Tool read_file completed]')
  )).toBe(false);
  const secondCallMessages = model.calls.at(-1)?.messages ?? [];
  expect(JSON.stringify(secondCallMessages)).not.toContain('[Tool read_file completed]');
  expect(JSON.stringify(secondCallMessages)).toContain('plain-text tool placeholder was discarded');
});
```

- [ ] **Step 2: Run test and verify failure**

Run:

```powershell
npm test -- packages/runtime/src/agent.test.ts -t "plain-text tool placeholder"
```

Expected: FAIL because current retry pushes bad assistant content into `messages`.

- [ ] **Step 3: Change retry history**

Modify `packages/runtime/src/agent.ts` in the `isTextToolPlaceholder()` branch:

```ts
messages.push({
  role: 'user',
  content: this.config.locale === 'zh'
    ? '上一条模型输出因为把工具调用协议写成普通文本，已被系统丢弃。请不要复述该文本。需要工具时只能使用结构化 tool call；不需要工具时直接给最终回答。'
    : 'The previous model output was discarded because it wrote a tool-call protocol as plain text. Do not repeat that text. Use a structured tool call if a tool is needed; otherwise provide the final answer directly.',
});
await this.appendRunMonitorEvent(turnId, {
  category: 'model',
  type: 'model.output.discarded',
  level: 'warning',
  message: 'plain-text tool placeholder was discarded before retry',
  metadata: { iteration, reason: 'plain_text_tool_placeholder' },
});
continue;
```

Remove the existing `messages.push({ role: 'assistant', content: message.content ?? '' })` from that branch.

- [ ] **Step 4: Run tests and verify pass**

Run:

```powershell
npm test -- packages/runtime/src/agent.test.ts -t "plain-text tool placeholder"
```

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add packages/runtime/src/agent.ts packages/runtime/src/agent.test.ts
git commit -m "fix(runtime): discard plain text tool leaks before retry"
```

## Task 7: Monitor Diagnostics and Full Verification

**Files:**
- Modify: `packages/runtime/src/agent.ts`
- Modify: `packages/runtime/src/runTraceProjector.ts`
- Test: `packages/runtime/src/runTraceProjector.test.ts`
- Test: `packages/runtime/src/agent.test.ts`

- [ ] **Step 1: Write failing monitor diagnostic test**

Add to `packages/runtime/src/runTraceProjector.test.ts` or the existing monitor event test area:

```ts
it('projects provider adapter diagnostics on model events', () => {
  const event = projectRunTraceEventForTest({
    category: 'model',
    type: 'model.started',
    metadata: {
      providerId: 'minimax',
      model: 'MiniMax-M3',
      endpointFormat: 'anthropic_messages',
      transport: 'anthropic_messages',
      reasoningMode: 'minimax_anthropic_thinking',
      toolHistoryMode: 'anthropic_blocks',
    },
  });
  expect(event.summary).toContain('MiniMax-M3');
  expect(event.payload).toMatchObject({
    providerId: 'minimax',
    endpointFormat: 'anthropic_messages',
    reasoningMode: 'minimax_anthropic_thinking',
  });
});
```

- [ ] **Step 2: Run test and verify failure**

Run:

```powershell
npm test -- packages/runtime/src/runTraceProjector.test.ts -t "provider adapter diagnostics"
```

Expected: FAIL until projector exposes the fields.

- [ ] **Step 3: Add diagnostics to model events**

In `packages/runtime/src/agent.ts`, when appending `model.started`, `model.completed`, `model.output.discarded`, and `model.failed` events, add:

```ts
metadata: {
  ...existingMetadata,
  providerId: this.config.model.provider,
  model: this.config.model.model,
  endpointFormat: gatewayProfile.endpointFormat,
  transport: gatewayProfile.transport,
  reasoningMode: gatewayProfile.reasoningMode,
  toolHistoryMode: gatewayProfile.toolHistoryMode,
}
```

Expose a read-only `getProfile()` method from `ModelGateway`:

```ts
getProfile(): ProviderProfile {
  return this.profile;
}
```

Use that method in runtime instead of casting private fields.

- [ ] **Step 4: Run targeted tests**

Run:

```powershell
npm test -- packages/model-gateway/src/gateway.test.ts packages/runtime/src/agent.test.ts packages/runtime/src/runTraceProjector.test.ts packages/runtime/src/modelOutput.test.ts
```

Expected: PASS.

- [ ] **Step 5: Run full verification**

Run:

```powershell
npm run lint
npm test
npm run build
```

Expected:

- `npm run lint`: 0 errors
- `npm test`: PASS; if environment-specific MCP tests fail, confirm they are the same pre-existing external MCP process failures
- `npm run build`: 0 TypeScript errors

- [ ] **Step 6: Commit**

```powershell
git add packages/model-gateway/src packages/protocol/src packages/runtime/src
git commit -m "feat(runtime): surface provider adapter diagnostics"
```

## Self-Review

Spec coverage:

- MiniMax-M3 one-off adapter path: covered by Tasks 1, 2, 5, 6.
- DeepSeek reasoning/cache behavior: covered by Tasks 1 and 5.
- OpenAI/Anthropic formal adapter boundary: covered by Tasks 1, 2, 5.
- Stop `[Tool ...]` history replay: covered by Task 4.
- Persist model tool id and provider frame: covered by Task 3.
- Streaming retry without visible pollution: covered by Task 6.
- Monitor diagnostics: covered by Task 7.

Placeholder scan:

- The plan contains no placeholder markers and every implementation task names exact files, tests, commands, and expected outcomes.

Type consistency:

- `ProviderProfile`, `ProviderAssistantFrame`, `ProviderToolCallFrame`, `modelToolCallId`, `modelToolName`, and `providerToolCall` names are consistent across tasks.
- `endpointFormat`, `transport`, `reasoningMode`, and `toolHistoryMode` are consistently used as profile diagnostics.
