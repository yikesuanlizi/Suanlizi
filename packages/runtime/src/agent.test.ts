import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import JSZip from 'jszip';
import type {
  Checkpoint,
  RunTraceDraft,
  RunTraceEnvelope,
  ThreadId,
  ThreadItem,
  ThreadEvent,
  MemoryRecord,
  ThreadMeta,
  TurnMeta,
  EpisodeRecord,
  ThreadWorkingSetSnapshot,
} from '@suanlizi/protocol';
import { RUN_TRACE_VERSION } from '@suanlizi/protocol';
import { AgentLoop } from './agent.js';
import { compactionOptionsForRunProfile } from './runProfile.js';
import { ThreadStateManager } from './state.js';
import type { RunEvent, RunFeedback, RunRecord, ThreadStore } from '@suanlizi/storage';
import { LocalHookRegistry, LocalSkillRegistry } from '@suanlizi/extensions';
import { ToolRegistry, type ToolDefinition } from '@suanlizi/tools';
import type { RuntimeMiddleware } from './middleware.js';
import { AutoApproveHandler, getPreset } from '@suanlizi/sandbox';
import { LIGHT_MEMORY_KEY, type LightMemoryState } from '@suanlizi/memory';

function deferred<T>(): { promise: Promise<T>; resolve: (value: T | PromiseLike<T>) => void; reject: (reason?: unknown) => void } {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function waitForCondition(assertion: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (assertion()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

class FakeStore implements ThreadStore {
  thread: ThreadMeta;
  turns: TurnMeta[];
  items: ThreadItem[] = [];
  checkpoint: Checkpoint | null = null;
  savedTurns: TurnMeta[] = [];
  runRecords: RunRecord[] = [];
  runEvents: RunEvent[] = [];
  runTraceEvents: RunTraceEnvelope[] = [];
  memoryRecords: MemoryRecord[] = [];
  memoryUsages: Array<{ id: string; usedAt: string }> = [];
  episodeRecords: EpisodeRecord[] = [];
  workingSets: Map<string, ThreadWorkingSetSnapshot> = new Map();
  settings: Map<string, unknown> = new Map();

  constructor(threadId: ThreadId, turnId: string) {
    this.thread = {
      threadId,
      title: 'test',
      workspaceRoot: process.cwd(),
      status: 'active',
      turnCount: 1,
      createdAt: '2026-06-07T00:00:00.000Z',
      updatedAt: '2026-06-07T00:00:00.000Z',
      archivedAt: null,
      ephemeral: false,
      tags: {},
    };
    this.turns = [
      {
        turnId,
        threadId,
        index: 0,
        userInput: { type: 'text', text: 'continue me' },
        status: 'running',
        startedAt: '2026-06-07T00:00:00.000Z',
        completedAt: null,
      },
    ];
    this.checkpoint = {
      threadId,
      turnId,
      itemIndex: 0,
      timestamp: '2026-06-07T00:00:01.000Z',
    };
  }

  async appendItems(_threadId: ThreadId, items: ThreadItem[]): Promise<void> {
    this.items.push(...items);
  }

  async updateThreadMetadata(_threadId: ThreadId, patch: Partial<ThreadMeta>): Promise<void> {
    this.thread = { ...this.thread, ...patch };
  }

  async createThread(meta: ThreadMeta): Promise<void> {
    this.thread = meta;
  }

  async getThread(threadId: ThreadId): Promise<ThreadMeta | null> {
    return threadId === this.thread.threadId ? this.thread : null;
  }

  async listThreads(): Promise<ThreadMeta[]> {
    return [this.thread];
  }

  async deleteThread(threadId: ThreadId): Promise<void> {
    if (threadId === this.thread.threadId) {
      this.turns = [];
      this.items = [];
      this.checkpoint = null;
    }
  }

  async getItems(): Promise<ThreadItem[]> {
    return this.items;
  }

  async getTurns(): Promise<TurnMeta[]> {
    return this.turns;
  }

  async saveTurn(turn: TurnMeta): Promise<void> {
    this.savedTurns.push(turn);
  }

  async getRecentItems(): Promise<ThreadItem[]> {
    return this.items;
  }

  async getLastCheckpoint(): Promise<Checkpoint | null> {
    return this.checkpoint;
  }

  async appendCheckpoint(_threadId: ThreadId, ckpt: Checkpoint): Promise<void> {
    this.checkpoint = ckpt;
  }

  async getSetting<T = unknown>(key: string): Promise<T | null> {
    return (this.settings.get(key) as T | undefined) ?? null;
  }

  async setSetting(key: string, value: unknown): Promise<void> {
    this.settings.set(key, value);
  }

  async upsertMemoryRecord(record: MemoryRecord): Promise<void> {
    const index = this.memoryRecords.findIndex((item) => item.id === record.id);
    if (index >= 0) this.memoryRecords[index] = record;
    else this.memoryRecords.push(record);
  }

  async listMemoryRecords(): Promise<MemoryRecord[]> {
    return this.memoryRecords.filter((record) => record.status === 'active');
  }

  async searchMemoryRecords(query: string): Promise<MemoryRecord[]> {
    const needle = query.toLowerCase();
    return this.memoryRecords.filter((record) => record.status === 'active' && record.text.toLowerCase().includes(needle));
  }

  async deleteMemoryRecord(id: string): Promise<void> {
    this.memoryRecords = this.memoryRecords.filter((record) => record.id !== id);
  }

  async recordMemoryUsage(id: string, usedAt: string): Promise<void> {
    this.memoryUsages.push({ id, usedAt });
    const record = this.memoryRecords.find((item) => item.id === id);
    if (record) {
      record.usageCount += 1;
      record.lastUsedAt = usedAt;
    }
  }

  async upsertThreadSpawnEdge(): Promise<void> {}

  async setThreadSpawnEdgeStatus(): Promise<void> {}

  async listThreadSpawnChildren(): Promise<never[]> {
    return [];
  }

  async listThreadSpawnDescendants(): Promise<never[]> {
    return [];
  }

  async createRunRecord(record: RunRecord): Promise<void> {
    this.runRecords.push(record);
  }

  async updateRunRecord(runId: string, patch: Partial<RunRecord>): Promise<void> {
    const index = this.runRecords.findIndex((record) => record.runId === runId);
    if (index >= 0) this.runRecords[index] = { ...this.runRecords[index], ...patch };
  }

  async appendRunEvent(event: RunEvent): Promise<void> {
    this.runEvents.push(event);
  }

  async appendRunTraceEvent(draft: RunTraceDraft): Promise<RunTraceEnvelope> {
    const event = {
      ...draft,
      version: RUN_TRACE_VERSION,
      eventId: `${draft.runId}_trace_${this.runTraceEvents.length + 1}`,
      sequence: this.runTraceEvents.length + 1,
    } as RunTraceEnvelope;
    this.runTraceEvents.push(event);
    return event;
  }

  async listRunRecords(): Promise<RunRecord[]> {
    return this.runRecords;
  }

  async listRunEvents(runId: string): Promise<RunEvent[]> {
    return this.runEvents.filter((event) => event.runId === runId);
  }

  async upsertRunFeedback(): Promise<void> {}

  async listRunFeedback(): Promise<RunFeedback[]> {
    return [];
  }

  async upsertEpisodeRecord(record: EpisodeRecord): Promise<void> {
    const index = this.episodeRecords.findIndex((e) => e.id === record.id);
    if (index >= 0) this.episodeRecords[index] = record;
    else this.episodeRecords.push(record);
  }

  async getEpisodeRecord(id: string): Promise<EpisodeRecord | null> {
    return this.episodeRecords.find((e) => e.id === id) ?? null;
  }

  async listEpisodeRecords(options?: {
    threadId?: string;
    lifecycle?: Array<EpisodeRecord['lifecycle']>;
    temperature?: Array<EpisodeRecord['temperature']>;
    excludeEpisodeIds?: string[];
  }): Promise<EpisodeRecord[]> {
    return this.episodeRecords.filter((e) => {
      if (options?.threadId && e.sourceThreadId !== options.threadId) return false;
      if (options?.lifecycle && !options.lifecycle.includes(e.lifecycle)) return false;
      if (options?.temperature && !options.temperature.includes(e.temperature)) return false;
      if (options?.excludeEpisodeIds?.includes(e.id)) return false;
      return true;
    });
  }

  async searchEpisodeRecords(query: string, options?: {
    threadId?: string;
    lifecycle?: Array<EpisodeRecord['lifecycle']>;
    temperature?: Array<EpisodeRecord['temperature']>;
    excludeEpisodeIds?: string[];
  }): Promise<EpisodeRecord[]> {
    const tokens = query.toLowerCase().split(/\s+/).filter((t) => t !== 'or' && t.length > 0);
    return this.episodeRecords.filter((e) => {
      if (options?.threadId && e.sourceThreadId !== options.threadId) return false;
      if (options?.lifecycle && !options.lifecycle.includes(e.lifecycle)) return false;
      if (options?.temperature && !options.temperature.includes(e.temperature)) return false;
      if (options?.excludeEpisodeIds?.includes(e.id)) return false;
      const haystack = [
        e.title,
        e.objective,
        e.summary,
        ...e.facts,
        ...e.decisions,
        ...e.artifacts,
        ...e.keywords,
      ]
        .join(' ')
        .toLowerCase();
      return tokens.some((token) => haystack.includes(token.replace(/"/g, '')));
    });
  }

  async recordEpisodeUsage(id: string): Promise<void> {
    const episode = this.episodeRecords.find((e) => e.id === id);
    if (episode) episode.usageCount += 1;
  }

  async saveThreadWorkingSet(snapshot: ThreadWorkingSetSnapshot): Promise<void> {
    this.workingSets.set(snapshot.threadId, { ...snapshot });
  }

  async getThreadWorkingSet(threadId: string): Promise<ThreadWorkingSetSnapshot | null> {
    return this.workingSets.get(threadId) ?? null;
  }

  async deleteThreadWorkingSet(threadId: string): Promise<void> {
    this.workingSets.delete(threadId);
  }

  scope(): ThreadStore {
    return this;
  }
}

class BlockingModel {
  private readonly gate = deferred<void>();
  private readonly releaseGate = deferred<void>();

  async waitUntilStreaming(): Promise<void> {
    await this.gate.promise;
  }

  release(): void {
    this.releaseGate.resolve();
  }

  async *chatStream() {
    this.gate.resolve();
    await this.releaseGate.promise;
    yield { type: 'delta' as const, content: 'released' };
    yield { type: 'done' as const };
  }
}

class FakeModel {
  lastUserContent: string | null = null;

  async *chatStream(req: { messages: Array<{ role: string; content: unknown }> }) {
    const lastUser = [...req.messages].reverse().find((msg) => msg.role === 'user');
    this.lastUserContent = typeof lastUser?.content === 'string' ? lastUser.content : null;
    yield { type: 'delta' as const, content: 'resumed' };
    yield { type: 'done' as const };
  }
}

class CapturingModel {
  requests: Array<{ messages: Array<{ role: string; content: unknown }> }> = [];

  async *chatStream(req: { messages: Array<{ role: string; content: unknown }> }) {
    this.requests.push(req);
    yield { type: 'delta' as const, content: 'ok' };
    yield { type: 'done' as const };
  }
}

class BudgetCapturingModel {
  request: { messages: Array<{ role: string; content: unknown }>; tools?: unknown[]; max_tokens?: number } | null = null;

  async *chatStream(req: { messages: Array<{ role: string; content: unknown }>; tools?: unknown[]; max_tokens?: number }) {
    this.request = req;
    yield { type: 'delta' as const, content: 'ok' };
    yield { type: 'done' as const };
  }
}

class FailingModel {
  async *chatStream() {
    throw new Error('model stream broke');
  }
}

class TimeoutAfterDeltaModel {
  async *chatStream() {
    yield { type: 'delta' as const, content: '已经生成的部分内容' };
    throw new Error('The operation was aborted due to timeout');
  }
}

class ProviderErrorAfterDeltaModel {
  async *chatStream() {
    yield { type: 'delta' as const, content: '已收到请求，正在处理。' };
    throw new Error('llama.cpp gateway error (500): provider failed');
  }
}

class ProviderErrorAfterReasoningModel {
  async *chatStream() {
    yield { type: 'reasoning_delta' as const, content: '先检查请求。' };
    throw new Error('provider failed after reasoning');
  }
}

class ReasoningThenAnswerModel {
  async *chatStream() {
    yield { type: 'reasoning_delta' as const, content: '先判断是否需要工具。' };
    yield { type: 'delta' as const, content: '最终回答。' };
    yield { type: 'done' as const };
  }
}

class PlaceholderToolTextModel {
  calls = 0;

  async *chatStream() {
    this.calls += 1;
    if (this.calls === 1) {
      yield { type: 'delta' as const, content: '好的，我先查一下。\n\n[Tool web_search]' };
      yield { type: 'done' as const };
      return;
    }
    yield { type: 'delta' as const, content: '这是完整最终回答。' };
    yield { type: 'done' as const };
  }
}

class SuccessfulToolThenPlaceholderModel {
  calls = 0;

  async *chatStream() {
    this.calls += 1;
    if (this.calls === 1) {
      yield {
        type: 'tool_call_end' as const,
        id: 'call_success_then_replay',
        name: 'current_time',
        arguments: '{}',
      };
      yield { type: 'done' as const };
      return;
    }
    if (this.calls === 2) {
      yield { type: 'delta' as const, content: '[工具调用]\n名称: current_time\n参数: {}' };
      yield { type: 'done' as const };
      return;
    }
    yield { type: 'delta' as const, content: '工具已成功执行，下面是最终结果。' };
    yield { type: 'done' as const };
  }
}

class PlaceholderToolTextCapturingModel {
  calls: Array<Array<{ role: string; content?: unknown }>> = [];

  async *chatStream(req: { messages: Array<{ role: string; content?: unknown }> }) {
    this.calls.push(req.messages);
    if (this.calls.length === 1) {
      yield { type: 'delta' as const, content: '我来读取文件。[Tool read_file completed]\n{"output":"bad"}' };
      yield { type: 'done' as const };
      return;
    }
    yield { type: 'delta' as const, content: '已修正，直接回答。' };
    yield { type: 'done' as const };
  }
}

class DsmlToolTextModel {
  calls = 0;

  async *chatStream() {
    this.calls += 1;
    if (this.calls === 1) {
      yield { type: 'delta' as const, content: '好的，我继续读取文件。\n\n<｜tool_calls｜>\n<｜invoke name="read_file"｜>\n<｜parameter name="filePath"｜>E:\\langchain\\dify\\api\\core\\workflow\\node_runtime.py<｜/parameter｜>\n<｜/invoke｜>\n<｜/tool_calls｜>' };
      yield { type: 'done' as const };
      return;
    }
    yield { type: 'delta' as const, content: '这是整理后的正常回复。' };
    yield { type: 'done' as const };
  }
}

class ToolCallingModel {
  calls: Array<Array<{ role: string; tool_calls?: unknown; tool_call_id?: string }>> = [];

  async *chatStream(req: { messages: Array<{ role: string; tool_calls?: unknown; tool_call_id?: string }> }) {
    this.calls.push(req.messages);

    if (this.calls.length === 1) {
      yield {
        type: 'tool_call_end' as const,
        id: 'call_current_time',
        name: 'current_time',
        arguments: '{}',
      };
      yield { type: 'done' as const };
      return;
    }

    yield { type: 'delta' as const, content: 'ok' };
    yield { type: 'done' as const };
  }
}

class AnthropicToolCallingModel {
  calls: Array<Array<{ role: string; content?: unknown; providerFrame?: unknown; tool_call_id?: string }>> = [];

  getModelId(): string {
    return 'MiniMax-M3';
  }

  getProfile() {
    return {
      id: 'minimax',
      displayName: 'MiniMax',
      baseUrl: 'https://api.minimaxi.com/anthropic/v1',
      apiKeyEnvVars: ['MINIMAX_API_KEY'],
      endpointFormat: 'anthropic_messages',
      transport: 'anthropic_messages',
      toolHistoryMode: 'anthropic_blocks',
      reasoningMode: 'minimax_anthropic_thinking',
      cacheMode: 'anthropic_cache_control',
    };
  }

  async *chatStream(req: { messages: Array<{ role: string; content?: unknown; providerFrame?: unknown; tool_call_id?: string }> }) {
    this.calls.push(req.messages);
    const toolResults = req.messages.filter((message) => message.role === 'tool');
    if (toolResults.length === 0) {
      yield { type: 'reasoning_delta' as const, content: '需要读取文件。' };
      yield {
        type: 'tool_call_end' as const,
        id: 'toolu_read_1',
        name: 'read_file',
        arguments: '{"path":"README.md"}',
      };
      yield { type: 'done' as const };
      return;
    }
    yield { type: 'delta' as const, content: '读完了。' };
    yield { type: 'done' as const };
  }
}

class DeepSeekReasoningToolModel {
  calls: Array<Array<{ role: string; content?: unknown; reasoning_content?: string; tool_calls?: unknown; tool_call_id?: string }>> = [];

  getModelId(): string {
    return 'deepseek-v4-pro';
  }

  getProfile() {
    return {
      id: 'deepseek',
      displayName: 'DeepSeek',
      baseUrl: 'https://api.deepseek.com/v1',
      apiKeyEnvVars: ['DEEPSEEK_API_KEY'],
      endpointFormat: 'chat_completions',
      transport: 'openai_chat_completions',
      toolHistoryMode: 'openai_chat',
      reasoningMode: 'deepseek_reasoning_content',
      cacheMode: 'deepseek_native',
    };
  }

  async *chatStream(req: { messages: Array<{ role: string; content?: unknown; reasoning_content?: string; tool_calls?: unknown; tool_call_id?: string }> }) {
    this.calls.push(req.messages);
    const toolResults = req.messages.filter((message) => message.role === 'tool');
    if (toolResults.length === 0) {
      yield { type: 'reasoning_delta' as const, content: '先决定读取时间。' };
      yield {
        type: 'tool_call_end' as const,
        id: 'call_current_time',
        name: 'current_time',
        arguments: '{}',
      };
      yield { type: 'done' as const };
      return;
    }
    yield { type: 'delta' as const, content: '时间读完了。' };
    yield { type: 'done' as const };
  }
}

class LlamaResponsesToolCallingModel {
  calls: Array<Array<{ role: string; content?: unknown; providerFrame?: unknown; tool_calls?: unknown; tool_call_id?: string }>> = [];

  getModelId(): string {
    return 'Qwen3-8B-GGUF';
  }

  getProfile() {
    return {
      id: 'llama_cpp',
      displayName: 'llama.cpp',
      baseUrl: 'http://127.0.0.1:8080/v1',
      apiKeyEnvVars: [],
      endpointFormat: 'responses',
      transport: 'openai_responses',
      toolHistoryMode: 'openai_responses',
      reasoningMode: 'openai_responses_items',
      cacheMode: 'openai_prompt_details',
    };
  }

  async *chatStream(req: { messages: Array<{ role: string; content?: unknown; providerFrame?: unknown; tool_calls?: unknown; tool_call_id?: string }> }) {
    this.calls.push(req.messages);
    if (this.calls.length === 1) {
      yield { type: 'reasoning_delta' as const, content: '先检查当前时间。' };
      yield {
        type: 'tool_call_end' as const,
        id: 'call_current_time_responses',
        name: 'current_time',
        arguments: '',
      };
      yield { type: 'done' as const };
      return;
    }
    yield { type: 'delta' as const, content: '已完成。' };
    yield { type: 'done' as const };
  }
}

class SingleToolModel {
  calls: Array<Array<{ role: string; tool_calls?: unknown; tool_call_id?: string }>> = [];

  constructor(private readonly toolName: string, private readonly args: Record<string, unknown> = {}) {}

  async *chatStream(req: { messages: Array<{ role: string; tool_calls?: unknown; tool_call_id?: string }> }) {
    this.calls.push(req.messages);
    if (this.calls.length === 1) {
      yield {
        type: 'tool_call_end' as const,
        id: `call_${this.toolName}`,
        name: this.toolName,
        arguments: JSON.stringify(this.args),
      };
      yield { type: 'done' as const };
      return;
    }
    yield { type: 'delta' as const, content: 'done after tool' };
    yield { type: 'done' as const };
  }
}

class TwoToolCallsModel {
  calls: Array<Array<{ role: string; tool_calls?: unknown; tool_call_id?: string; content?: unknown }>> = [];

  constructor(private readonly firstTool: string, private readonly secondTool: string) {}

  async *chatStream(req: { messages: Array<{ role: string; tool_calls?: unknown; tool_call_id?: string; content?: unknown }> }) {
    this.calls.push(req.messages);
    if (this.calls.length === 1) {
      yield {
        type: 'tool_call_end' as const,
        id: `call_${this.firstTool}`,
        name: this.firstTool,
        arguments: '{}',
      };
      yield {
        type: 'tool_call_end' as const,
        id: `call_${this.secondTool}`,
        name: this.secondTool,
        arguments: '{}',
      };
      yield { type: 'done' as const };
      return;
    }
    yield { type: 'delta' as const, content: 'done after both tools' };
    yield { type: 'done' as const };
  }
}

class RepeatingToolModel {
  calls = 0;

  constructor(private readonly toolName = 'current_time') {}

  async *chatStream(req: { tools?: Array<{ function: { name: string } }> }) {
    this.calls += 1;
    const toolAvailable = (req.tools ?? []).some((tool) => tool.function.name === this.toolName);
    if (toolAvailable && this.calls <= 5) {
      yield {
        type: 'tool_call_end' as const,
        id: `call_repeat_${this.calls}`,
        name: this.toolName,
        arguments: JSON.stringify({ same: true }),
      };
      yield { type: 'done' as const };
      return;
    }
    yield { type: 'delta' as const, content: 'finished after repeats' };
    yield { type: 'done' as const };
  }
}

class LimitedRepeatingToolModel {
  calls = 0;

  constructor(private readonly repeats: number, private readonly toolName = 'current_time') {}

  async *chatStream(req: { tools?: Array<{ function: { name: string } }> }) {
    this.calls += 1;
    const toolAvailable = (req.tools ?? []).some((tool) => tool.function.name === this.toolName);
    if (toolAvailable && this.calls <= this.repeats) {
      yield {
        type: 'tool_call_end' as const,
        id: `call_limited_repeat_${this.calls}`,
        name: this.toolName,
        arguments: JSON.stringify({ same: true }),
      };
      yield { type: 'done' as const };
      return;
    }
    yield { type: 'delta' as const, content: 'finished after limited repeats' };
    yield { type: 'done' as const };
  }
}

class FailingToolRetryModel {
  calls = 0;

  async *chatStream(req: { tools?: Array<{ function: { name: string } }> }) {
    this.calls += 1;
    const toolAvailable = (req.tools ?? []).some((tool) => tool.function.name === 'always_fail');
    if (toolAvailable && this.calls <= 4) {
      yield {
        type: 'tool_call_end' as const,
        id: `call_fail_${this.calls}`,
        name: 'always_fail',
        arguments: '{}',
      };
      yield { type: 'done' as const };
      return;
    }
    yield { type: 'delta' as const, content: 'done after failures' };
    yield { type: 'done' as const };
  }
}

class IgnoresDisabledToolsModel {
  calls = 0;
  requests: Array<{ tools?: unknown[]; tool_choice?: unknown }> = [];

  async *chatStream(req: { tools?: Array<{ function: { name: string } }>; tool_choice?: unknown }) {
    this.calls += 1;
    this.requests.push({ tools: req.tools, tool_choice: req.tool_choice });
    // Deliberately emit the same call even when the runtime sends
    // tools: []/tool_choice: none, matching misbehaving llama.cpp templates.
    yield {
      type: 'tool_call_end' as const,
      id: `call_ignores_disabled_${this.calls}`,
      name: 'current_time',
      arguments: '{}',
    };
    yield { type: 'done' as const };
  }
}

class RepeatingPlaceholderToolTextModel {
  calls = 0;

  async *chatStream() {
    this.calls += 1;
    yield { type: 'delta' as const, content: '[Tool read_file]' };
    yield { type: 'done' as const };
  }
}

class SequenceToolModel {
  messages: Array<Array<{ role: string; content?: unknown }>> = [];

  constructor(private readonly sequence: Array<{ name: string; args?: Record<string, unknown> }>) {}

  async chat() {
    return {
      choices: [
        {
          message: {
            content: '当前进度：旧上下文已压缩。\n关键上下文：mid-turn 工具 follow-up 前已替换旧历史。\n待办事项：继续工具后续调用。',
          },
        },
      ],
    };
  }

  async *chatStream(req: { messages: Array<{ role: string; content?: unknown }> }) {
    this.messages.push(req.messages);
    const toolResultCount = req.messages.filter((message) => message.role === 'tool').length;
    const next = this.sequence[toolResultCount];
    if (next) {
      yield {
        type: 'tool_call_end' as const,
        id: `call_sequence_${toolResultCount}`,
        name: next.name,
        arguments: JSON.stringify(next.args ?? {}),
      };
      yield { type: 'done' as const };
      return;
    }
    yield { type: 'delta' as const, content: 'sequence done' };
    yield { type: 'done' as const };
  }
}

class AliasToolCallingModel {
  calls = 0;

  async *chatStream() {
    this.calls += 1;
    if (this.calls === 1) {
      yield {
        type: 'tool_call_end' as const,
        id: 'call_list_file',
        name: 'list_file',
        arguments: JSON.stringify({ path: '.', maxEntries: 5 }),
      };
      yield { type: 'done' as const };
      return;
    }

    yield { type: 'delta' as const, content: 'listed ok' };
    yield { type: 'done' as const };
  }
}

class ToolListModel {
  toolNames: string[][] = [];
  tools: Array<Array<{ function: { name: string; parameters: { properties?: Record<string, { enum?: string[] }> } } }>> = [];

  async *chatStream(req: { tools?: Array<{ function: { name: string; parameters: { properties?: Record<string, { enum?: string[] }> } } }> }) {
    const tools = req.tools ?? [];
    this.tools.push(tools);
    this.toolNames.push(tools.map((tool) => tool.function.name));
    yield { type: 'delta' as const, content: 'ok' };
    yield { type: 'done' as const };
  }
}

class MessageCapturingModel {
  messages: Array<Array<{ role: string; content: unknown }>> = [];

  async *chatStream(req: { messages: Array<{ role: string; content: unknown }> }) {
    this.messages.push(req.messages);
    yield { type: 'delta' as const, content: 'ok' };
    yield { type: 'done' as const };
  }
}

class DelayedToolBindingModel {
  toolNames: string[][] = [];
  calls = 0;

  async *chatStream(req: { tools?: Array<{ function: { name: string } }> }) {
    const names = (req.tools ?? []).map((tool) => tool.function.name);
    this.toolNames.push(names);
    this.calls += 1;

    if (this.calls === 1) {
      yield {
        type: 'tool_call_end' as const,
        id: 'call_tool_search',
        name: 'tool_search',
        arguments: JSON.stringify({ query: 'read workspace file', limit: 3 }),
      };
      yield { type: 'done' as const };
      return;
    }

    if (this.calls === 2) {
      yield {
        type: 'tool_call_end' as const,
        id: 'call_read_file',
        name: 'read_file',
        arguments: JSON.stringify({ path: 'README.md' }),
      };
      yield { type: 'done' as const };
      return;
    }

    yield { type: 'delta' as const, content: 'done' };
    yield { type: 'done' as const };
  }
}

class HiddenToolCallingModel {
  toolNames: string[][] = [];
  calls = 0;

  async *chatStream(req: { tools?: Array<{ function: { name: string } }> }) {
    this.toolNames.push((req.tools ?? []).map((tool) => tool.function.name));
    this.calls += 1;
    if (this.calls === 1) {
      yield {
        type: 'tool_call_end' as const,
        id: 'call_hidden_read',
        name: 'read_file',
        arguments: JSON.stringify({ path: 'README.md' }),
      };
      yield { type: 'done' as const };
      return;
    }
    yield { type: 'delta' as const, content: 'stopped' };
    yield { type: 'done' as const };
  }
}

function createDelayedBindingRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register({
    name: 'read_file',
    description: 'Read a workspace file',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
      },
      required: ['path'],
      additionalProperties: false,
    },
    requiredPolicy: 'readonly',
    async execute(args) {
      return {
        status: 'completed',
        output: `read ${String(args.path)}`,
        data: { path: args.path },
      };
    },
  });
  registry.register({
    name: 'write_file',
    description: 'Write a workspace file',
    parameters: { type: 'object' },
    requiredPolicy: 'workspace_write',
    async execute() {
      return { status: 'completed', output: 'wrote' };
    },
  });
  return registry;
}

class SummaryAndMessageCapturingModel extends MessageCapturingModel {
  async chat() {
    return {
      choices: [
        {
          message: {
            content: '用户目标：继续长任务。\n已完成变更：旧上下文已压缩。\n未完成事项：处理当前请求。',
          },
        },
      ],
    };
  }
}

function createLargeOutputToolRegistry(output: string): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register({
    name: 'huge_output',
    description: 'Return a large output payload.',
    requiredPolicy: 'readonly',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async execute() {
      return { status: 'completed', output };
    },
  });
  registry.register({
    name: 'noop_after_compact',
    description: 'No-op tool used after compaction.',
    requiredPolicy: 'readonly',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async execute() {
      return { status: 'completed', output: 'noop' };
    },
  });
  return registry;
}

class UsageModel {
  async *chatStream() {
    yield { type: 'delta' as const, content: 'ok' };
    yield {
      type: 'done' as const,
      usage: {
        prompt_tokens: 11,
        cached_tokens: 5,
        cache_reported: true,
        completion_tokens: 7,
        total_tokens: 18,
        cache_strategy: 'deepseek-native',
      },
    };
  }
}

class TriStateUsageModel {
  private callCount = 0;

  async *chatStream() {
    const cacheReported = [undefined, true, false][this.callCount++];
    yield { type: 'delta' as const, content: 'ok' };
    yield {
      type: 'done' as const,
      usage: {
        prompt_tokens: 10,
        completion_tokens: 2,
        ...(cacheReported === undefined ? {} : { cache_reported: cacheReported }),
        ...(cacheReported === true ? { cached_tokens: 4 } : {}),
      },
    };
  }
}

class RepeatingWebSearchModel {
  toolNames: string[][] = [];

  async *chatStream(req: { tools?: Array<{ function: { name: string } }> }) {
    const toolNames = (req.tools ?? []).map((tool) => tool.function.name);
    this.toolNames.push(toolNames);
    if (toolNames.includes('web_search')) {
      yield {
        type: 'tool_call_end' as const,
        id: `call_web_search_${this.toolNames.length}`,
        name: 'web_search',
        arguments: JSON.stringify({ query: 'same query', maxResults: 5 }),
      };
      yield { type: 'done' as const };
      return;
    }
    yield { type: 'delta' as const, content: 'final' };
    yield { type: 'done' as const };
  }
}

class MultiThreadStore implements ThreadStore {
  threads = new Map<ThreadId, ThreadMeta>();
  turns = new Map<ThreadId, TurnMeta[]>();
  items = new Map<ThreadId, ThreadItem[]>();
  edges: Array<{
    tenantId?: string;
    parentThreadId: ThreadId;
    childThreadId: ThreadId;
    status: 'open' | 'closed';
    createdAt: string;
    updatedAt: string;
  }> = [];
  checkpoints = new Map<ThreadId, Checkpoint>();

  constructor(rootThread: ThreadMeta) {
    this.threads.set(rootThread.threadId, rootThread);
  }

  async appendItems(threadId: ThreadId, items: ThreadItem[]): Promise<void> {
    this.items.set(threadId, [...(this.items.get(threadId) ?? []), ...items]);
  }

  async updateThreadMetadata(threadId: ThreadId, patch: Partial<ThreadMeta>): Promise<void> {
    const thread = this.threads.get(threadId);
    if (thread) this.threads.set(threadId, { ...thread, ...patch });
  }

  async createThread(meta: ThreadMeta): Promise<void> {
    this.threads.set(meta.threadId, meta);
  }

  async getThread(threadId: ThreadId): Promise<ThreadMeta | null> {
    return this.threads.get(threadId) ?? null;
  }

  async listThreads(): Promise<ThreadMeta[]> {
    return [...this.threads.values()];
  }

  async deleteThread(threadId: ThreadId): Promise<void> {
    this.threads.delete(threadId);
    this.turns.delete(threadId);
    this.items.delete(threadId);
    this.edges = this.edges.filter((edge) => edge.parentThreadId !== threadId && edge.childThreadId !== threadId);
  }

  async getItems(threadId: ThreadId): Promise<ThreadItem[]> {
    return this.items.get(threadId) ?? [];
  }

  async getTurns(threadId: ThreadId): Promise<TurnMeta[]> {
    return this.turns.get(threadId) ?? [];
  }

  async saveTurn(turn: TurnMeta): Promise<void> {
    const turns = this.turns.get(turn.threadId) ?? [];
    const index = turns.findIndex((existing) => existing.turnId === turn.turnId);
    if (index >= 0) {
      turns[index] = turn;
    } else {
      turns.push(turn);
    }
    this.turns.set(turn.threadId, turns);
  }

  async getRecentItems(threadId: ThreadId): Promise<ThreadItem[]> {
    return this.items.get(threadId) ?? [];
  }

  async getLastCheckpoint(threadId: ThreadId): Promise<Checkpoint | null> {
    return this.checkpoints.get(threadId) ?? null;
  }

  async appendCheckpoint(threadId: ThreadId, ckpt: Checkpoint): Promise<void> {
    this.checkpoints.set(threadId, ckpt);
  }

  async getSetting<T = unknown>(): Promise<T | null> {
    return null;
  }

  async setSetting(): Promise<void> {}

  async upsertThreadSpawnEdge(edge: {
    tenantId?: string;
    parentThreadId: ThreadId;
    childThreadId: ThreadId;
    status: 'open' | 'closed';
    createdAt: string;
    updatedAt: string;
  }): Promise<void> {
    this.edges = this.edges.filter((existing) => (
      existing.parentThreadId !== edge.parentThreadId || existing.childThreadId !== edge.childThreadId
    ));
    this.edges.push(edge);
  }

  async setThreadSpawnEdgeStatus(parentThreadId: ThreadId, childThreadId: ThreadId, status: 'open' | 'closed'): Promise<void> {
    this.edges = this.edges.map((edge) => (
      edge.parentThreadId === parentThreadId && edge.childThreadId === childThreadId
        ? { ...edge, status, updatedAt: new Date().toISOString() }
        : edge
    ));
  }

  async listThreadSpawnChildren(parentThreadId: ThreadId, status?: 'open' | 'closed') {
    return this.edges.filter((edge) => edge.parentThreadId === parentThreadId && (!status || edge.status === status));
  }

  async listThreadSpawnDescendants(parentThreadId: ThreadId, status?: 'open' | 'closed') {
    const result: typeof this.edges = [];
    const visit = (id: ThreadId) => {
      for (const edge of this.edges.filter((candidate) => candidate.parentThreadId === id && (!status || candidate.status === status))) {
        result.push(edge);
        visit(edge.childThreadId);
      }
    };
    visit(parentThreadId);
    return result;
  }

  async createRunRecord(): Promise<void> {}
  async updateRunRecord(): Promise<void> {}
  async appendRunEvent(): Promise<void> {}
  async listRunRecords(): Promise<never[]> { return []; }
  async listRunEvents(): Promise<never[]> { return []; }
  async upsertRunFeedback(): Promise<void> {}
  async listRunFeedback(): Promise<never[]> { return []; }

  scope(): ThreadStore {
    return this;
  }
}

class CollabModel {
  async *chatStream(req: { messages: Array<{ role: string; content: unknown }> }) {
    const lastUser = [...req.messages].reverse().find((message) => message.role === 'user');
    const toolResults = req.messages.filter((message) => message.role === 'tool');
    if (lastUser?.content === 'inspect package') {
      yield { type: 'delta' as const, content: 'child done' };
      yield { type: 'done' as const };
      return;
    }
    if (toolResults.length === 0) {
      yield {
        type: 'tool_call_end' as const,
        id: 'call_spawn',
        name: 'spawn_agent',
        arguments: JSON.stringify({
          prompt: 'inspect package',
          agentRole: 'reviewer',
          agentNickname: 'worker',
        }),
      };
      yield { type: 'done' as const };
      return;
    }
    if (toolResults.length === 1) {
      yield {
        type: 'tool_call_end' as const,
        id: 'call_wait',
        name: 'wait',
        arguments: '{}',
      };
      yield { type: 'done' as const };
      return;
    }
    yield { type: 'delta' as const, content: 'parent done' };
    yield { type: 'done' as const };
  }
}

class SpawnThenChildRepeatsModel {
  async *chatStream(req: {
    messages: Array<{ role: string; content: unknown }>;
    tools?: Array<{ function: { name: string } }>;
  }) {
    const lastUser = [...req.messages].reverse().find((message) => message.role === 'user');
    const toolResults = req.messages.filter((message) => message.role === 'tool');
    if (lastUser?.content === 'inspect package') {
      const currentTimeAvailable = (req.tools ?? []).some((tool) => tool.function.name === 'current_time');
      if (currentTimeAvailable && toolResults.length < 2) {
        yield {
          type: 'tool_call_end' as const,
          id: `call_child_time_${toolResults.length}`,
          name: 'current_time',
          arguments: JSON.stringify({ same: true }),
        };
        yield { type: 'done' as const };
        return;
      }
      yield { type: 'delta' as const, content: 'child done after inherited governance' };
      yield { type: 'done' as const };
      return;
    }
    if (toolResults.length === 0) {
      yield {
        type: 'tool_call_end' as const,
        id: 'call_spawn_for_inheritance',
        name: 'spawn_agent',
        arguments: JSON.stringify({ prompt: 'inspect package' }),
      };
      yield { type: 'done' as const };
      return;
    }
    if (toolResults.length === 1) {
      yield {
        type: 'tool_call_end' as const,
        id: 'call_wait_for_inheritance',
        name: 'wait',
        arguments: '{}',
      };
      yield { type: 'done' as const };
      return;
    }
    yield { type: 'delta' as const, content: 'parent done' };
    yield { type: 'done' as const };
  }
}

class CollabCommandModel {
  constructor(
    private readonly toolName: string,
    private readonly args: Record<string, unknown>,
    private readonly childReplies: Record<string, string> = {},
  ) {}

  async *chatStream(req: { messages: Array<{ role: string; content: unknown }> }) {
    const lastUser = [...req.messages].reverse().find((message) => message.role === 'user');
    if (typeof lastUser?.content === 'string' && this.childReplies[lastUser.content]) {
      yield { type: 'delta' as const, content: this.childReplies[lastUser.content] };
      yield { type: 'done' as const };
      return;
    }

    const toolResults = req.messages.filter((message) => message.role === 'tool');
    if (toolResults.length === 0) {
      yield {
        type: 'tool_call_end' as const,
        id: `call_${this.toolName}`,
        name: this.toolName,
        arguments: JSON.stringify(this.args),
      };
      yield { type: 'done' as const };
      return;
    }

    yield { type: 'delta' as const, content: 'parent done' };
    yield { type: 'done' as const };
  }
}

class RoleProfileCaptureModel {
  readonly calls: Array<{
    messages: Array<{ role: string; content: unknown }>;
    tools: Array<{ function: { name: string } }>;
  }> = [];

  constructor(
    private readonly args: Record<string, unknown>,
    private readonly childReplies: Record<string, string> = {},
  ) {}

  async *chatStream(req: {
    messages: Array<{ role: string; content: unknown }>;
    tools?: Array<{ function: { name: string } }>;
  }) {
    this.calls.push({
      messages: req.messages,
      tools: req.tools ?? [],
    });
    const lastUser = [...req.messages].reverse().find((message) => message.role === 'user');
    if (typeof lastUser?.content === 'string' && this.childReplies[lastUser.content]) {
      yield { type: 'delta' as const, content: this.childReplies[lastUser.content] };
      yield { type: 'done' as const };
      return;
    }

    const toolResults = req.messages.filter((message) => message.role === 'tool');
    if (toolResults.length === 0) {
      yield {
        type: 'tool_call_end' as const,
        id: 'call_spawn_role_profile',
        name: 'spawn_agent',
        arguments: JSON.stringify(this.args),
      };
      yield { type: 'done' as const };
      return;
    }

    yield { type: 'delta' as const, content: 'parent done' };
    yield { type: 'done' as const };
  }
}

function createThread(threadId: ThreadId, title = threadId): ThreadMeta {
  const now = new Date().toISOString();
  return {
    threadId,
    title,
    workspaceRoot: process.cwd(),
    status: 'active',
    turnCount: 0,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    ephemeral: false,
    tags: {},
  };
}

describe('AgentLoop resumeRunning', () => {
  it('loads checkpoint and original user input from storage when process state was lost', async () => {
    const threadId = 'thread-cold-resume';
    const turnId = 'turn-cold-resume';
    const store = new FakeStore(threadId, turnId);
    const model = new FakeModel();
    const stateManager = new ThreadStateManager();

    const agent = new AgentLoop(
      {
        workspaceRoot: process.cwd(),
        sandbox: { level: 'workspace_write', workspaceRoot: process.cwd() },
        model: model as never,
        store,
      },
      stateManager,
    );

    const result = await agent.resumeRunning(threadId);

    expect(model.lastUserContent).toBe('continue me');
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.type).toBe('agent_message');
    expect(store.savedTurns).toHaveLength(1);
    expect(store.savedTurns[0]?.turnId).toBe(turnId);
    expect(store.savedTurns[0]?.status).toBe('completed');
  });
});

describe('AgentLoop runTurn failure handling', () => {
  it('uses temporary approval for external file access without mutating persistent rules', async () => {
    const threadId = 'thread-access-policy-approval';
    const store = new FakeStore(threadId, 'previous-turn');
    store.thread.turnCount = 0;
    store.turns = [];
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'suanlizi-runtime-access-workspace-'));
    const externalRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'suanlizi-runtime-access-external-'));
    const externalFile = path.join(externalRoot, 'note.txt');
    await fs.writeFile(externalFile, 'external note\n', 'utf-8');
    const approvals: unknown[] = [];
    const approvalHandler = {
      async requestApproval(req: unknown) {
        approvals.push(req);
        return { approved: true, reason: 'allow once', temporaryScope: 'tool_call' as const };
      },
    };
    const agent = new AgentLoop({
      workspaceRoot,
      sandbox: { level: 'workspace_write', workspaceRoot },
      accessPolicy: {
        mode: 'workspace',
        workspaceRoot,
        persistentRules: [],
        temporaryGrants: [],
      },
      model: new SequenceToolModel([{ name: 'read_file', args: { filePath: externalFile } }]) as never,
      store,
      locale: 'zh',
      approvalHandler,
    });

    await agent.runTurn(threadId, { type: 'text', text: '读取外部文件' });

    expect(approvals).toHaveLength(1);
    expect(approvals[0]).toMatchObject({
      kind: 'tool_call',
      accessRequest: {
        access: 'read',
        target: { kind: 'path', path: externalFile },
        toolName: 'read_file',
      },
      temporaryGrantOptions: [
        { scope: 'tool_call', label: '仅本次工具调用' },
        { scope: 'turn', label: '仅本轮对话' },
        { scope: 'session', label: '仅本次应用会话' },
      ],
    });
    expect(store.items.find((item) => item.type === 'tool_call')).toMatchObject({
      type: 'tool_call',
      status: 'completed',
      result: expect.objectContaining({
        path: externalFile,
        artifactRefs: expect.arrayContaining([
          expect.objectContaining({
            path: externalFile,
            excerpt: expect.stringContaining('external note'),
          }),
        ]),
      }),
    });
    expect((agent as unknown as { config: { accessPolicy: { persistentRules: unknown[] } } }).config.accessPolicy.persistentRules).toEqual([]);
    expect(store.runEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({
        category: 'approval',
        type: 'access.decision',
        metadata: expect.objectContaining({
          decision: 'prompt',
          source: 'approval_required',
          access: 'read',
          toolName: 'read_file',
        }),
      }),
      expect.objectContaining({
        category: 'approval',
        type: 'access.temporary_grant',
        metadata: expect.objectContaining({
          scope: 'tool_call',
          access: 'read',
          toolName: 'read_file',
        }),
      }),
    ]));
  });

  it('records control-oriented run monitor events for turn, model, and tool phases', async () => {
    const threadId = 'thread-run-monitor';
    const store = new FakeStore(threadId, 'previous-turn');
    store.thread.turnCount = 0;
    store.turns = [];
    const agent = new AgentLoop({
      workspaceRoot: process.cwd(),
      sandbox: { level: 'readonly', workspaceRoot: process.cwd() },
      model: new ToolCallingModel() as never,
      store,
      tenantId: 'tenantMonitor',
      locale: 'zh',
    });

    await agent.runTurn(threadId, { type: 'text', text: 'use a tool' });

    expect(store.runRecords).toEqual([
      expect.objectContaining({
        tenantId: 'tenantMonitor',
        threadId,
        kind: 'turn',
        status: 'completed',
        caller: 'lead_agent',
      }),
    ]);
    const runId = String(store.runRecords[0].runId);
    await expect(store.listRunEvents(runId)).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ category: 'turn', type: 'turn.started', runId }),
      expect.objectContaining({ category: 'model', type: 'model.completed', runId }),
      expect.objectContaining({ category: 'tool', type: 'tool.completed', runId, toolName: 'current_time' }),
    ]));
    expect(store.runTraceEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({ category: 'turn', lifecycle: 'started', runId }),
      expect.objectContaining({ category: 'model', lifecycle: 'completed', runId }),
      expect.objectContaining({
        category: 'tool',
        lifecycle: 'completed',
        runId,
        payload: expect.objectContaining({ toolName: 'current_time' }),
      }),
      expect.objectContaining({
        category: 'item',
        runId,
        payload: expect.objectContaining({ itemType: 'agent_message' }),
      }),
    ]));
    expect(store.runRecords[0]).toMatchObject({
      traceVersion: 2,
      traceSummary: expect.objectContaining({
        status: 'completed',
        model: expect.objectContaining({ calls: expect.any(Number) }),
        tools: expect.objectContaining({ calls: expect.any(Number) }),
      }),
    });
  });

  it('records file lifecycle trace events from read_document results', async () => {
    const threadId = 'thread-document-trace';
    const store = new FakeStore(threadId, 'previous-turn');
    store.thread.turnCount = 0;
    store.turns = [];
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'suanlizi-runtime-document-trace-'));
    await writeRuntimeMinimalDocx(path.join(root, 'brief.docx'), 'trace 内容');
    const model = new SequenceToolModel([{ name: 'read_document', args: { filePath: 'brief.docx' } }]);
    const agent = new AgentLoop({
      workspaceRoot: root,
      sandbox: { level: 'workspace_write', workspaceRoot: root },
      model: model as never,
      store,
      locale: 'zh',
      approvalHandler: new AutoApproveHandler(),
    });

    await agent.runTurn(threadId, { type: 'text', text: '分析 brief.docx' });

    expect(store.runTraceEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({
        category: 'file',
        name: 'file.extract',
        payload: expect.objectContaining({
          action: 'extract',
          path: expect.stringContaining('brief.docx'),
          artifactPath: expect.stringContaining('.suanlizi'),
        }),
      }),
    ]));
  });

  it('injects a freshness warning before the next model call when a document artifact is stale', async () => {
    const threadId = 'thread-preflight-stale';
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'suanlizi-agent-preflight-'));
    await writeRuntimeMinimalDocx(path.join(root, 'brief.docx'), '版本一');

    const store = new FakeStore(threadId, 'previous-turn');
    store.thread.turnCount = 0;
    store.turns = [];
    const setupModel = new SequenceToolModel([{ name: 'read_document', args: { filePath: 'brief.docx' } }]);
    const setupAgent = new AgentLoop({
      workspaceRoot: root,
      sandbox: { level: 'workspace_write', workspaceRoot: root },
      model: setupModel as never,
      store,
      locale: 'zh',
    });
    await setupAgent.runTurn(threadId, { type: 'text', text: '读取 brief.docx' });

    await new Promise((resolve) => setTimeout(resolve, 5));
    await writeRuntimeMinimalDocx(path.join(root, 'brief.docx'), '版本二');
    const model = new MessageCapturingModel();
    const agent = new AgentLoop({
      workspaceRoot: root,
      sandbox: { level: 'workspace_write', workspaceRoot: root },
      model: model as never,
      store,
      locale: 'zh',
      approvalHandler: new AutoApproveHandler(),
    });

    await agent.runTurn(threadId, { type: 'text', text: '继续分析' });

    const serialized = JSON.stringify(model.messages[0]);
    expect(serialized).toContain('旧提取内容已经过期');
    expect(serialized).toContain('read_document');
  });

  it('injects a document verification notice for follow-up questions before relying on previous document context', async () => {
    const threadId = 'thread-preflight-followup-document';
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'suanlizi-agent-followup-document-'));
    await writeRuntimeMinimalDocx(path.join(root, 'brief.docx'), '版本一');

    const store = new FakeStore(threadId, 'previous-turn');
    store.thread.turnCount = 0;
    store.turns = [];
    const setupModel = new SequenceToolModel([{ name: 'read_document', args: { filePath: 'brief.docx' } }]);
    const setupAgent = new AgentLoop({
      workspaceRoot: root,
      sandbox: { level: 'workspace_write', workspaceRoot: root },
      model: setupModel as never,
      store,
      locale: 'zh',
    });
    await setupAgent.runTurn(threadId, { type: 'text', text: '读取 brief.docx' });

    const model = new SequenceToolModel([{ name: 'read_document', args: { filePath: 'brief.docx' } }]);
    const agent = new AgentLoop({
      workspaceRoot: root,
      sandbox: { level: 'workspace_write', workspaceRoot: root },
      model: model as never,
      store,
      locale: 'zh',
    });

    await agent.runTurn(threadId, { type: 'text', text: '现在呢，看看适合开发了吗？' });

    const firstRequest = JSON.stringify(model.messages[0]);
    expect(firstRequest).toContain('当前问题像是在继续讨论之前的文档');
    expect(firstRequest).toContain('read_document');
    expect(firstRequest).toContain('brief.docx');
    const finalRequest = JSON.stringify(model.messages.at(-1));
    expect(finalRequest.match(/文件知识校验提醒/g) ?? []).toHaveLength(1);
    expect(store.runEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({
        category: 'file',
        type: 'file.read',
        level: 'warning',
        message: expect.stringContaining('Document verification required'),
      }),
    ]));
  });

  it('auto refreshes a recently discussed document before a follow-up answer even when the model does not call tools', async () => {
    const threadId = 'thread-preflight-auto-document';
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'suanlizi-agent-auto-document-'));
    await writeRuntimeMinimalDocx(path.join(root, 'brief.docx'), '旧版本内容');

    const store = new FakeStore(threadId, 'previous-turn');
    store.thread.turnCount = 0;
    store.turns = [];
    const setupModel = new SequenceToolModel([{ name: 'read_document', args: { filePath: 'brief.docx' } }]);
    const setupAgent = new AgentLoop({
      workspaceRoot: root,
      sandbox: { level: 'workspace_write', workspaceRoot: root },
      model: setupModel as never,
      store,
      locale: 'zh',
    });
    await setupAgent.runTurn(threadId, { type: 'text', text: '读取 brief.docx' });

    await new Promise((resolve) => setTimeout(resolve, 5));
    await writeRuntimeMinimalDocx(path.join(root, 'brief.docx'), '新版本内容');
    const model = new MessageCapturingModel();
    const agent = new AgentLoop({
      workspaceRoot: root,
      sandbox: { level: 'workspace_write', workspaceRoot: root },
      model: model as never,
      store,
      locale: 'zh',
    });

    await agent.runTurn(threadId, { type: 'text', text: '现在呢，看看适合开发了吗？' });

    const firstRequest = JSON.stringify(model.messages[0]);
    expect(firstRequest).toContain('文件知识自动校验结果');
    expect(firstRequest).toContain('新版本内容');
    const currentTurnToolReads = store.items.filter((item) =>
      item.type === 'tool_call' &&
      item.toolName === 'read_document' &&
      item.result &&
      JSON.stringify(item.result).includes('新版本内容')
    );
    expect(currentTurnToolReads.length).toBeGreaterThan(0);
  });

  it('records observed document knowledge on project checkpoints', async () => {
    const threadId = 'thread-checkpoint-knowledge';
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'suanlizi-checkpoint-knowledge-'));
    await writeRuntimeMinimalDocx(path.join(root, 'brief.docx'), '检查点知识');
    const model = new SequenceToolModel([
      { name: 'read_document', args: { filePath: 'brief.docx' } },
      { name: 'write_file', args: { filePath: 'notes.md', content: '# notes\n' } },
    ]);
    const store = new FakeStore(threadId, 'previous-turn');
    store.thread.turnCount = 0;
    store.turns = [];
    const agent = new AgentLoop({
      workspaceRoot: root,
      sandbox: { level: 'workspace_write', workspaceRoot: root },
      model: model as never,
      store,
      locale: 'zh',
      approvalHandler: new AutoApproveHandler(),
    });

    await agent.runTurn(threadId, { type: 'text', text: '读取 brief.docx 后写 notes' });

    const checkpoint = store.items.find((item) => item.type === 'project_checkpoint');
    expect(checkpoint).toMatchObject({
      type: 'project_checkpoint',
      knowledge: {
        observedFiles: [
          expect.objectContaining({ path: expect.stringContaining('brief.docx'), sha256: expect.any(String) }),
        ],
        documentArtifacts: [
          expect.objectContaining({
            sourcePath: expect.stringContaining('brief.docx'),
            artifactPath: expect.stringContaining('.suanlizi'),
            sourceHash: expect.any(String),
            artifactHash: expect.any(String),
          }),
        ],
      },
    });
    const writeEvent = store.runTraceEvents.find((event) =>
      event.category === 'file'
      && event.payload.action === 'write'
      && event.payload.path.endsWith('notes.md')
    );
    expect(writeEvent).toBeDefined();
    expect(store.runRecords.at(-1)?.traceSummary?.files.changed).toBe(1);
    expect(store.runRecords.at(-1)?.traceSummary?.files.addedLines).toBeGreaterThan(0);
  });

  it('does not treat plain text tool placeholders as the final answer', async () => {
    const threadId = 'thread-placeholder-tool-text';
    const store = new FakeStore(threadId, 'previous-turn');
    const model = new PlaceholderToolTextModel();
    const events: ThreadEvent[] = [];
    const agent = new AgentLoop({
      workspaceRoot: process.cwd(),
      sandbox: { level: 'workspace_write', workspaceRoot: process.cwd() },
      model: model as never,
      store,
      locale: 'zh',
    });
    agent.onEvent((event) => events.push(event));

    const result = await agent.runTurn(threadId, { type: 'text', text: '查一下资料' });

    expect(model.calls).toBe(2);
    expect([...result.items].reverse().find((item) => item.type === 'agent_message')).toMatchObject({
      text: '这是完整最终回答。',
    });
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'item.discarded' }),
      expect.objectContaining({ type: 'model.output.rejected', message: expect.stringContaining('普通文本') }),
    ]));
  });

  it('does not block after a successful tool when the provider replays flattened tool text', async () => {
    const threadId = 'thread-successful-tool-replay';
    const store = new FakeStore(threadId, 'previous-turn');
    const model = new SuccessfulToolThenPlaceholderModel();
    const events: ThreadEvent[] = [];
    const agent = new AgentLoop({
      workspaceRoot: process.cwd(),
      sandbox: { level: 'workspace_write', workspaceRoot: process.cwd() },
      model: model as never,
      store,
      locale: 'zh',
    });
    agent.onEvent((event) => events.push(event));

    const result = await agent.runTurn(threadId, { type: 'text', text: '查一下当前时间' });

    expect(model.calls).toBe(3);
    expect(result.items.filter((item) => item.type === 'tool_call')).toHaveLength(2);
    expect([...result.items].reverse().find((item) => item.type === 'agent_message')).toMatchObject({
      text: '工具已成功执行，下面是最终结果。',
    });
    expect(events.filter((event) => event.type === 'model.output.rejected')).toHaveLength(1);
  });

  it('does not display DSML-style text tool calls as assistant replies', async () => {
    const threadId = 'thread-dsml-tool-text';
    const store = new FakeStore(threadId, 'previous-turn');
    const model = new DsmlToolTextModel();
    const agent = new AgentLoop({
      workspaceRoot: process.cwd(),
      sandbox: { level: 'workspace_write', workspaceRoot: process.cwd() },
      model: model as never,
      store,
      locale: 'zh',
    });

    const result = await agent.runTurn(threadId, { type: 'text', text: '继续读取文件' });

    expect(model.calls).toBe(2);
    expect(result.items.some((item) => item.type === 'agent_message' && item.text?.includes('tool_calls'))).toBe(false);
    expect([...result.items].reverse().find((item) => item.type === 'agent_message')).toMatchObject({
      text: '这是整理后的正常回复。',
    });
  });

  it('does not push plain-text tool placeholder output into retry history', async () => {
    const threadId = 'thread-placeholder-tool-text-retry-history';
    const store = new FakeStore(threadId, 'previous-turn');
    const model = new PlaceholderToolTextCapturingModel();
    const agent = new AgentLoop({
      workspaceRoot: process.cwd(),
      sandbox: { level: 'workspace_write', workspaceRoot: process.cwd() },
      model: model as never,
      store,
      locale: 'zh',
    });

    const result = await agent.runTurn(threadId, { type: 'text', text: '继续' });

    expect(result.items.some((item) =>
      item.type === 'agent_message' &&
      item.text.includes('[Tool read_file completed]')
    )).toBe(false);
    const retryMessages = model.calls[1] ?? [];
    const serialized = JSON.stringify(retryMessages);
    expect(serialized).not.toContain('[Tool read_file completed]');
    expect(serialized).toContain('plain-text tool placeholder was discarded');
  });

  it('persists reasoning deltas separately from assistant text', async () => {
    const threadId = 'thread-reasoning-delta';
    const store = new FakeStore(threadId, 'previous-turn');
    const agent = new AgentLoop({
      workspaceRoot: process.cwd(),
      sandbox: { level: 'workspace_write', workspaceRoot: process.cwd() },
      model: new ReasoningThenAnswerModel() as never,
      store,
      locale: 'zh',
    });

    const result = await agent.runTurn(threadId, { type: 'text', text: '继续' });

    expect(result.items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'reasoning',
        text: '先判断是否需要工具。',
      }),
      expect.objectContaining({
        type: 'agent_message',
        text: '最终回答。',
      }),
    ]));
    expect(result.items.some((item) => item.type === 'agent_message' && item.text.includes('先判断'))).toBe(false);
    expect(store.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'reasoning', text: '先判断是否需要工具。' }),
      expect.objectContaining({ type: 'agent_message', text: '最终回答。' }),
    ]));
  });

  it('does not replay historical reasoning items as assistant content', async () => {
    const threadId = 'thread-history-reasoning-redaction';
    const store = new FakeStore(threadId, 'previous-turn');
    store.items.push(
      {
        id: 'previous-user',
        type: 'user_message',
        turnId: 'previous-turn',
        text: 'v1.0 现在适合开发了吗？',
        timestamp: '2026-06-07T00:00:00.000Z',
      },
      {
        id: 'previous-reasoning',
        type: 'reasoning',
        turnId: 'previous-turn',
        text: '用户在问：v1.0 现在适合去开发了吗？',
        timestamp: '2026-06-07T00:00:01.000Z',
      },
      {
        id: 'previous-answer',
        type: 'agent_message',
        turnId: 'previous-turn',
        text: '上一轮可见回答。',
        timestamp: '2026-06-07T00:00:02.000Z',
      },
    );
    const model = new MessageCapturingModel();
    const agent = new AgentLoop({
      workspaceRoot: process.cwd(),
      sandbox: { level: 'workspace_write', workspaceRoot: process.cwd() },
      model: model as never,
      store,
      locale: 'zh',
    });

    await agent.runTurn(threadId, { type: 'text', text: '现在呢？' });

    const serialized = JSON.stringify(model.messages[0]);
    expect(serialized).not.toContain('[Reasoning]');
    expect(serialized).not.toContain('用户在问：v1.0');
    expect(serialized).toContain('上一轮可见回答。');
  });

  it('persists an error item when the model stream fails', async () => {
    const threadId = 'thread-failing-turn';
    const store = new FakeStore(threadId, 'previous-turn');
    const stateManager = new ThreadStateManager();
    const agent = new AgentLoop(
      {
        workspaceRoot: process.cwd(),
        sandbox: { level: 'workspace_write', workspaceRoot: process.cwd() },
        model: new FailingModel() as never,
        store,
      },
      stateManager,
    );

    await expect(agent.runTurn(threadId, { type: 'text', text: '今天周几' })).rejects.toThrow(
      'model stream broke',
    );

    expect(store.items.map((item) => item.type)).toEqual(['user_message', 'error']);
    expect(store.items[1]).toMatchObject({
      type: 'error',
      message: 'model stream broke',
    });
    expect(store.savedTurns.at(-1)).toMatchObject({
      status: 'failed',
    });
  });

  it('does not feed historical error items back into the next model request', async () => {
    const threadId = 'thread-history-error-redaction';
    const store = new FakeStore(threadId, 'previous-turn');
    store.items.push(
      {
        id: 'previous-user',
        type: 'user_message',
        turnId: 'previous-turn',
        text: '你好',
        timestamp: '2026-06-07T00:00:00.000Z',
      },
      {
        id: 'previous-error',
        type: 'error',
        turnId: 'previous-turn',
        message: 'OpenAI gateway error (401): Unauthorized',
        info: { kind: 'Other' },
        timestamp: '2026-06-07T00:00:01.000Z',
      },
    );
    const model = new CapturingModel();
    const agent = new AgentLoop({
      workspaceRoot: process.cwd(),
      sandbox: { level: 'workspace_write', workspaceRoot: process.cwd() },
      model: model as never,
      store,
      locale: 'zh',
    });

    await agent.runTurn(threadId, { type: 'text', text: '现在用新模型回答' });

    const messages = model.requests.at(-1)?.messages ?? [];
    expect(messages.some((message) => String(message.content).includes('OpenAI gateway error'))).toBe(false);
    expect(messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'user', content: '现在用新模型回答' }),
    ]));
  });

  it('keeps streamed assistant text visible when the model times out', async () => {
    const threadId = 'thread-timeout-partial';
    const store = new FakeStore(threadId, 'previous-turn');
    const events: ThreadEvent[] = [];
    const agent = new AgentLoop({
      workspaceRoot: process.cwd(),
      sandbox: { level: 'workspace_write', workspaceRoot: process.cwd() },
      model: new TimeoutAfterDeltaModel() as never,
      store,
      locale: 'zh',
    });
    agent.onEvent((event) => events.push(event));

    const result = await agent.runTurn(threadId, { type: 'text', text: '长回答' });

    expect(result.items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'agent_message',
        text: '已经生成的部分内容',
      }),
    ]));
    expect(store.items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'agent_message',
        text: '已经生成的部分内容',
      }),
    ]));
    expect(store.items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'error',
        message: expect.stringContaining('timeout'),
      }),
    ]));
    expect(store.savedTurns.at(-1)).toMatchObject({ status: 'interrupted' });
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'stream.error',
        error: expect.objectContaining({ info: expect.objectContaining({ kind: 'ResponseStreamDisconnected' }) }),
      }),
      expect.objectContaining({ type: 'turn.completed', status: 'interrupted' }),
    ]));
  });

  it('closes and persists partial assistant output when a provider fails after deltas', async () => {
    const threadId = 'thread-provider-error-partial';
    const store = new FakeStore(threadId, 'previous-turn');
    const events: ThreadEvent[] = [];
    const agent = new AgentLoop({
      workspaceRoot: process.cwd(),
      sandbox: { level: 'workspace_write', workspaceRoot: process.cwd() },
      model: new ProviderErrorAfterDeltaModel() as never,
      store,
      locale: 'zh',
    });
    agent.onEvent((event) => events.push(event));

    await expect(agent.runTurn(threadId, { type: 'text', text: '触发错误' })).rejects.toThrow('provider failed');

    expect(store.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'agent_message', text: '已收到请求，正在处理。' }),
      expect.objectContaining({ type: 'error', message: expect.stringContaining('provider failed') }),
    ]));
    expect(events.filter((event) => event.type === 'item.completed' && event.item.type === 'agent_message')).toHaveLength(1);
    expect(store.savedTurns.at(-1)).toMatchObject({ status: 'failed' });
  });

  it('closes a reasoning item exactly once when a provider fails after reasoning deltas', async () => {
    const threadId = 'thread-provider-error-reasoning';
    const store = new FakeStore(threadId, 'previous-turn');
    const events: ThreadEvent[] = [];
    const agent = new AgentLoop({
      workspaceRoot: process.cwd(),
      sandbox: { level: 'workspace_write', workspaceRoot: process.cwd() },
      model: new ProviderErrorAfterReasoningModel() as never,
      store,
      locale: 'zh',
    });
    agent.onEvent((event) => events.push(event));

    await expect(agent.runTurn(threadId, { type: 'text', text: '触发推理错误' }))
      .rejects.toThrow('provider failed after reasoning');

    expect(store.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'reasoning', text: '先检查请求。', completedAt: expect.any(String) }),
      expect.objectContaining({ type: 'error', message: expect.stringContaining('provider failed after reasoning') }),
    ]));
    expect(events.filter((event) => event.type === 'item.completed' && event.item.type === 'reasoning')).toHaveLength(1);
    expect(events.filter((event) => event.type === 'item.discarded')).toHaveLength(0);
  });
});

describe('AgentLoop model request context budget', () => {
  it('accounts for tool schemas after middleware and keeps a 16K request below the input budget', async () => {
    const threadId = 'thread-model-request-budget';
    const tools = new ToolRegistry();
    const largeDescription = 'tool capability '.repeat(420);
    for (let index = 0; index < 12; index += 1) {
      tools.register({
        name: `large_tool_${index}`,
        description: largeDescription,
        parameters: {
          type: 'object',
          properties: {
            input: { type: 'string', description: 'input '.repeat(200) },
          },
          required: ['input'],
          additionalProperties: false,
        },
        requiredPolicy: 'readonly',
        async execute() {
          return { status: 'completed', output: 'ok' };
        },
      });
    }
    const model = new BudgetCapturingModel();
    const events: ThreadEvent[] = [];
    const agent = new AgentLoop({
      workspaceRoot: process.cwd(),
      sandbox: { level: 'readonly', workspaceRoot: process.cwd() },
      model: model as never,
      modelContextTokens: 16_384,
      modelMaxOutputTokens: 8_192,
      store: new FakeStore(threadId, 'previous-turn'),
      tools,
    });
    agent.onEvent((event) => events.push(event));

    await agent.runTurn(threadId, { type: 'text', text: 'keep this request within the local model context' });

    const estimate = events.find((event) => event.type === 'context.token_estimate.updated');
    expect(estimate).toMatchObject({
      type: 'context.token_estimate.updated',
      estimate: { inputTokens: expect.any(Number) },
    });
    expect((estimate as Extract<ThreadEvent, { type: 'context.token_estimate.updated' }>).estimate.inputTokens)
      .toBeLessThanOrEqual(16_384 - 8_192 - 256);
    expect(model.request).not.toBeNull();
    expect(model.request?.max_tokens).toBe(8_192);
  });
});

describe('AgentLoop runtime middleware', () => {
  it('runs turn, model, and tool middleware stages in order', async () => {
    const threadId = 'thread-runtime-middleware-order';
    const order: string[] = [];
    const middleware: RuntimeMiddleware = {
      beforeTurn: async () => { order.push('beforeTurn'); },
      beforeModel: async () => { order.push('beforeModel'); },
      wrapModel: async (_ctx, request, next) => {
        order.push('wrapModel:before');
        const response = await next(request);
        order.push('wrapModel:after');
        return response;
      },
      afterModel: async () => { order.push('afterModel'); },
      beforeTool: async () => { order.push('beforeTool'); },
      wrapTool: async (_ctx, request, next) => {
        order.push('wrapTool:before');
        const response = await next(request);
        order.push('wrapTool:after');
        return response;
      },
      afterTool: async () => { order.push('afterTool'); },
      afterTurn: async (_ctx, result) => { order.push(`afterTurn:${result.status}`); },
    };
    const agent = new AgentLoop({
      workspaceRoot: process.cwd(),
      sandbox: { level: 'workspace_write', workspaceRoot: process.cwd() },
      model: new ToolCallingModel() as never,
      store: new FakeStore(threadId, 'previous-turn'),
      runtimeMiddleware: [middleware],
    });

    await agent.runTurn(threadId, { type: 'text', text: 'use a tool' });

    expect(order).toEqual([
      'beforeTurn',
      'beforeModel',
      'wrapModel:before',
      'wrapModel:after',
      'afterModel',
      'beforeTool',
      'wrapTool:before',
      'wrapTool:after',
      'afterTool',
      'beforeModel',
      'wrapModel:before',
      'wrapModel:after',
      'afterModel',
      'afterTurn:completed',
    ]);
  });

  it('calls afterTurn with failed status when beforeTurn throws', async () => {
    const threadId = 'thread-runtime-before-turn-failure';
    const afterTurn: string[] = [];
    const middleware: RuntimeMiddleware = {
      beforeTurn: async () => {
        throw new Error('beforeTurn failed');
      },
      afterTurn: async (_ctx, result) => {
        afterTurn.push(result.status);
      },
    };
    const store = new FakeStore(threadId, 'previous-turn');
    const agent = new AgentLoop({
      workspaceRoot: process.cwd(),
      sandbox: { level: 'workspace_write', workspaceRoot: process.cwd() },
      model: new ToolCallingModel() as never,
      store,
      runtimeMiddleware: [middleware],
    });

    await expect(agent.runTurn(threadId, { type: 'text', text: 'fail before turn' }))
      .rejects.toThrow('beforeTurn failed');

    expect(afterTurn).toEqual(['failed']);
    expect(store.savedTurns.at(-1)).toMatchObject({ status: 'failed' });
  });

  it('keeps completed turn state when turn_end hook throws but still calls afterTurn', async () => {
    const threadId = 'thread-runtime-turn-end-hook-failure';
    const afterTurn: string[] = [];
    const hooks = new LocalHookRegistry();
    hooks.on('turn_end', () => {
      throw new Error('turn_end failed');
    });
    const middleware: RuntimeMiddleware = {
      afterTurn: async (_ctx, result) => {
        afterTurn.push(result.status);
      },
    };
    const store = new FakeStore(threadId, 'previous-turn');
    const agent = new AgentLoop({
      workspaceRoot: process.cwd(),
      sandbox: { level: 'workspace_write', workspaceRoot: process.cwd() },
      model: new ToolCallingModel() as never,
      store,
      hooks,
      runtimeMiddleware: [middleware],
    });

    await expect(agent.runTurn(threadId, { type: 'text', text: 'hook should fail late' }))
      .rejects.toThrow('turn_end failed');

    expect(afterTurn).toEqual(['completed']);
    expect(store.savedTurns.at(-1)).toMatchObject({ status: 'completed' });
    expect(store.items.some((item) => item.type === 'error' && 'message' in item && item.message === 'turn_end failed')).toBe(false);
  });

  it('calls afterTurn with failed status when beforeModel throws', async () => {
    const threadId = 'thread-runtime-before-model-failure';
    const afterTurn: string[] = [];
    const store = new FakeStore(threadId, 'previous-turn');
    const agent = new AgentLoop({
      workspaceRoot: process.cwd(),
      sandbox: { level: 'workspace_write', workspaceRoot: process.cwd() },
      model: new MessageCapturingModel() as never,
      store,
      runtimeMiddleware: [{
        beforeModel: async () => {
          throw new Error('beforeModel failed');
        },
        afterTurn: async (_ctx, result) => {
          afterTurn.push(result.status);
        },
      }],
    });

    await expect(agent.runTurn(threadId, { type: 'text', text: 'fail before model' }))
      .rejects.toThrow('beforeModel failed');

    expect(afterTurn).toEqual(['failed']);
    expect(store.savedTurns.at(-1)).toMatchObject({ status: 'failed' });
    expect(store.checkpoint).toMatchObject({ status: 'failed' });
    expect(store.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'error', message: 'beforeModel failed' }),
    ]));
  });

  it('calls afterTurn with failed status when wrapModel throws', async () => {
    const threadId = 'thread-runtime-wrap-model-failure';
    const afterTurn: string[] = [];
    const store = new FakeStore(threadId, 'previous-turn');
    const agent = new AgentLoop({
      workspaceRoot: process.cwd(),
      sandbox: { level: 'workspace_write', workspaceRoot: process.cwd() },
      model: new MessageCapturingModel() as never,
      store,
      runtimeMiddleware: [{
        wrapModel: async () => {
          throw new Error('wrapModel failed');
        },
        afterTurn: async (_ctx, result) => {
          afterTurn.push(result.status);
        },
      }],
    });

    await expect(agent.runTurn(threadId, { type: 'text', text: 'fail in wrap model' }))
      .rejects.toThrow('wrapModel failed');

    expect(afterTurn).toEqual(['failed']);
    expect(store.savedTurns.at(-1)).toMatchObject({ status: 'failed' });
    expect(store.checkpoint).toMatchObject({ status: 'failed' });
    expect(store.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'error', message: 'wrapModel failed' }),
    ]));
  });

  it('lets wrapModel amend model request messages', async () => {
    const threadId = 'thread-runtime-wrap-model';
    const model = new MessageCapturingModel();
    const middleware: RuntimeMiddleware = {
      wrapModel: async (_ctx, request, next) => next({
        ...request,
        messages: [...request.messages, { role: 'user', content: 'message from wrapModel' }],
      }),
    };
    const agent = new AgentLoop({
      workspaceRoot: process.cwd(),
      sandbox: { level: 'workspace_write', workspaceRoot: process.cwd() },
      model: model as never,
      store: new FakeStore(threadId, 'previous-turn'),
      runtimeMiddleware: [middleware],
    });

    await agent.runTurn(threadId, { type: 'text', text: 'hello' });

    expect(JSON.stringify(model.messages[0])).toContain('message from wrapModel');
  });

  it('lets beforeTool short-circuit a normal tool without executing it', async () => {
    const threadId = 'thread-runtime-before-tool';
    let realExecutions = 0;
    const tools = new ToolRegistry();
    tools.register({
      name: 'side_effect_tool',
      description: 'Records whether the real tool executed.',
      requiredPolicy: 'readonly',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      execute: async () => {
        realExecutions += 1;
        return { output: 'real execution', status: 'completed' };
      },
    });
    const store = new FakeStore(threadId, 'previous-turn');
    const agent = new AgentLoop({
      workspaceRoot: process.cwd(),
      sandbox: { level: 'workspace_write', workspaceRoot: process.cwd() },
      model: new SingleToolModel('side_effect_tool') as never,
      store,
      tools,
      runtimeMiddleware: [{
        beforeTool: async () => ({
          output: 'blocked before execution',
          status: 'failed',
          error: { message: 'blocked before execution', code: 'BEFORE_TOOL_BLOCKED' },
        }),
      }],
    });

    await agent.runTurn(threadId, { type: 'text', text: 'use side effect tool' });

    expect(realExecutions).toBe(0);
    expect(store.items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'tool_call',
        toolName: 'side_effect_tool',
        status: 'failed',
        error: { message: 'blocked before execution', code: 'BEFORE_TOOL_BLOCKED' },
        result: 'blocked before execution',
      }),
      expect.objectContaining({ type: 'agent_message', text: 'done after tool' }),
    ]));
  });

  it('lets wrapTool short-circuit tool execution while still returning a tool result to the model', async () => {
    const threadId = 'thread-runtime-wrap-tool';
    const middleware: RuntimeMiddleware = {
      wrapTool: async () => ({
        output: 'blocked by runtime middleware',
        status: 'failed',
        error: { message: 'blocked by runtime middleware', code: 'MIDDLEWARE_BLOCKED' },
      }),
    };
    const store = new FakeStore(threadId, 'previous-turn');
    const agent = new AgentLoop({
      workspaceRoot: process.cwd(),
      sandbox: { level: 'workspace_write', workspaceRoot: process.cwd() },
      model: new ToolCallingModel() as never,
      store,
      runtimeMiddleware: [middleware],
    });

    await agent.runTurn(threadId, { type: 'text', text: 'use a tool' });

    expect(store.items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'tool_call',
        status: 'failed',
        result: 'blocked by runtime middleware',
      }),
      expect.objectContaining({
        type: 'agent_message',
        text: 'ok',
      }),
    ]));
  });

  it('settles a started tool item when tool middleware throws', async () => {
    const threadId = 'thread-runtime-tool-throw';
    const tools = new ToolRegistry();
    tools.register({
      name: 'throwing_tool',
      description: 'Throws to exercise tool failure finalization.',
      requiredPolicy: 'readonly',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      execute: async () => ({ output: 'should not execute', status: 'completed' }),
    });
    const store = new FakeStore(threadId, 'previous-turn');
    const agent = new AgentLoop({
      workspaceRoot: process.cwd(),
      sandbox: { level: 'workspace_write', workspaceRoot: process.cwd() },
      model: new SingleToolModel('throwing_tool') as never,
      store,
      tools,
      runtimeMiddleware: [{
        wrapTool: async () => {
          throw Object.assign(new Error('upstream tool failure'), { code: 'UPSTREAM_TOOL_FAILED' });
        },
      }],
    });

    await expect(agent.runTurn(threadId, { type: 'text', text: 'run the tool' })).rejects.toThrow('upstream tool failure');

    expect(store.items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'tool_call',
        toolName: 'throwing_tool',
        status: 'failed',
        error: { message: 'upstream tool failure', code: 'UPSTREAM_TOOL_FAILED' },
        result: { error: 'upstream tool failure', code: 'UPSTREAM_TOOL_FAILED' },
        completedAt: expect.any(String),
      }),
      expect.objectContaining({ type: 'error', message: 'upstream tool failure' }),
    ]));
    expect(store.items.some((item) => item.type === 'tool_call' && item.status === 'in_progress')).toBe(false);
  });

  it('runs explicitly parallel-safe readonly tool calls concurrently while preserving tool result order', async () => {
    const threadId = 'thread-runtime-parallel-tools';
    const tools = new ToolRegistry();
    const release = deferred<void>();
    const log: string[] = [];
    let active = 0;
    let maxActive = 0;
    let started = 0;
    const makeTool = (name: string, output: string): ToolDefinition & { supportsParallelToolCalls: true } => ({
      name,
      description: `${name} parallel test tool`,
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      requiredPolicy: 'readonly',
      supportsParallelToolCalls: true,
      async execute() {
        log.push(`start:${name}`);
        active += 1;
        maxActive = Math.max(maxActive, active);
        started += 1;
        if (started === 2) release.resolve();
        await release.promise;
        log.push(`end:${name}`);
        active -= 1;
        return { status: 'completed', output };
      },
    });
    tools.register(makeTool('parallel_a', 'A result'));
    tools.register(makeTool('parallel_b', 'B result'));
    const model = new TwoToolCallsModel('parallel_a', 'parallel_b');
    const store = new FakeStore(threadId, 'previous-turn');
    const agent = new AgentLoop({
      workspaceRoot: process.cwd(),
      sandbox: { level: 'workspace_write', workspaceRoot: process.cwd() },
      model: model as never,
      store,
      tools,
    });

    await agent.runTurn(threadId, { type: 'text', text: 'run both readonly tools' });

    expect(maxActive).toBe(2);
    expect(log.slice(0, 2)).toEqual(['start:parallel_a', 'start:parallel_b']);
    const secondModelMessages = model.calls[1] ?? [];
    expect(secondModelMessages.filter((message) => message.role === 'tool').map((message) => message.content)).toEqual([
      'A result',
      'B result',
    ]);
    expect(store.runEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'tool.batch.started',
        metadata: expect.objectContaining({ parallel: true, toolCount: 2 }),
      }),
      expect.objectContaining({
        type: 'tool.batch.completed',
        metadata: expect.objectContaining({ parallel: true, toolCount: 2 }),
      }),
    ]));
  });

  it('keeps tool calls serial unless the tool explicitly opts into parallel execution', async () => {
    const threadId = 'thread-runtime-serial-tools';
    const tools = new ToolRegistry();
    const log: string[] = [];
    let active = 0;
    let maxActive = 0;
    const makeTool = (name: string): ToolDefinition => ({
      name,
      description: `${name} serial test tool`,
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      requiredPolicy: 'readonly',
      async execute() {
        log.push(`start:${name}`);
        active += 1;
        maxActive = Math.max(maxActive, active);
        await Promise.resolve();
        active -= 1;
        log.push(`end:${name}`);
        return { status: 'completed', output: `${name} result` };
      },
    });
    tools.register(makeTool('serial_a'));
    tools.register(makeTool('serial_b'));
    const agent = new AgentLoop({
      workspaceRoot: process.cwd(),
      sandbox: { level: 'workspace_write', workspaceRoot: process.cwd() },
      model: new TwoToolCallsModel('serial_a', 'serial_b') as never,
      store: new FakeStore(threadId, 'previous-turn'),
      tools,
    });

    await agent.runTurn(threadId, { type: 'text', text: 'run both serial tools' });

    expect(maxActive).toBe(1);
    expect(log).toEqual(['start:serial_a', 'end:serial_a', 'start:serial_b', 'end:serial_b']);
  });

  it('records a collab tool item when wrapTool short-circuits spawn_agent', async () => {
    const parentThread = createThread('thread-runtime-wrap-collab');
    const store = new MultiThreadStore(parentThread);
    const middleware: RuntimeMiddleware = {
      wrapTool: async (_ctx, request, next) => {
        if (request.toolName !== 'spawn_agent') return next(request);
        return {
          output: 'spawn blocked by runtime middleware',
          status: 'failed',
          error: { message: 'spawn blocked by runtime middleware', code: 'MIDDLEWARE_BLOCKED' },
        };
      },
    };
    const agent = new AgentLoop({
      workspaceRoot: process.cwd(),
      sandbox: { level: 'workspace_write', workspaceRoot: process.cwd() },
      model: new CollabCommandModel('spawn_agent', { prompt: 'inspect package' }) as never,
      store,
      runtimeMiddleware: [middleware],
    });

    await agent.runTurn(parentThread.threadId, { type: 'text', text: 'spawn then block' });

    expect(store.items.get(parentThread.threadId)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'collab_tool_call',
        tool: 'spawn_agent',
        status: 'failed',
        error: { message: 'spawn blocked by runtime middleware', code: 'MIDDLEWARE_BLOCKED' },
        result: 'spawn blocked by runtime middleware',
      }),
      expect.objectContaining({
        type: 'agent_message',
        text: 'parent done',
      }),
    ]));
    expect(store.edges).toEqual([]);
  });

  it('allows exactly maxRepeatedToolCalls identical calls before blocking the next repeat', async () => {
    const threadId = 'thread-runtime-repeat-boundary';
    const store = new FakeStore(threadId, 'previous-turn');
    const agent = new AgentLoop({
      workspaceRoot: process.cwd(),
      sandbox: { level: 'workspace_write', workspaceRoot: process.cwd() },
      model: new LimitedRepeatingToolModel(2) as never,
      store,
      maxRepeatedToolCalls: 2,
    });

    await agent.runTurn(threadId, { type: 'text', text: 'repeat exactly twice' });

    const toolItems = store.items.filter((item) => item.type === 'tool_call');
    expect(toolItems).toHaveLength(2);
    expect(toolItems.every((item) => item.status === 'completed')).toBe(true);
    expect(JSON.stringify(toolItems)).not.toContain('TOOL_LOOP_DETECTED');
  });

  it('short-circuits repeated identical tool calls before the real tool executes again', async () => {
    const threadId = 'thread-runtime-loop-detection';
    const model = new RepeatingToolModel();
    const store = new FakeStore(threadId, 'previous-turn');
    const agent = new AgentLoop({
      workspaceRoot: process.cwd(),
      sandbox: { level: 'workspace_write', workspaceRoot: process.cwd() },
      model: model as never,
      store,
      maxRepeatedToolCalls: 2,
    });

    await agent.runTurn(threadId, { type: 'text', text: 'repeat tool' });

    const toolItems = store.items.filter((item) => item.type === 'tool_call');
    expect(toolItems).toHaveLength(3);
    expect(toolItems.at(-1)).toMatchObject({
      status: 'failed',
      error: { code: 'TOOL_LOOP_DETECTED' },
    });
  });

  it('resets consecutive tool error count after a successful tool call', async () => {
    const threadId = 'thread-runtime-error-reset';
    const tools = new ToolRegistry();
    tools.register({
      name: 'sometimes_fail',
      description: 'Fails when requested.',
      requiredPolicy: 'readonly',
      parameters: {
        type: 'object',
        properties: { fail: { type: 'boolean' } },
        additionalProperties: false,
      },
      execute: async (args) => (
        args.fail
          ? { output: 'failed intentionally', status: 'failed', error: { message: 'failed intentionally', code: 'INTENTIONAL_FAILURE' } }
          : { output: 'success intentionally', status: 'completed' }
      ),
    });
    const store = new FakeStore(threadId, 'previous-turn');
    const agent = new AgentLoop({
      workspaceRoot: process.cwd(),
      sandbox: { level: 'workspace_write', workspaceRoot: process.cwd() },
      model: new SequenceToolModel([
        { name: 'sometimes_fail', args: { fail: true } },
        { name: 'sometimes_fail', args: { fail: false } },
        { name: 'sometimes_fail', args: { fail: true } },
        { name: 'sometimes_fail', args: { fail: true } },
      ]) as never,
      store,
      tools,
      maxConsecutiveToolErrors: 2,
      maxRepeatedToolCalls: 10,
    });

    await agent.runTurn(threadId, { type: 'text', text: 'failure reset sequence' });

    const toolItems = store.items.filter((item) => item.type === 'tool_call');
    expect(toolItems.map((item) => item.status)).toEqual(['failed', 'completed', 'failed', 'failed']);
    expect(JSON.stringify(toolItems)).not.toContain('TOOL_ERROR_LIMIT_REACHED');
  });

  it('stops repeated tool retries after consecutive tool failures', async () => {
    const threadId = 'thread-runtime-tool-error-limit';
    const tools = new ToolRegistry();
    tools.register({
      name: 'always_fail',
      description: 'Always fails.',
      requiredPolicy: 'readonly',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      execute: async () => ({
        output: 'failed internally',
        status: 'failed',
        error: { message: 'failed internally', code: 'INTENTIONAL_FAILURE' },
      }),
    });
    const store = new FakeStore(threadId, 'previous-turn');
    const agent = new AgentLoop({
      workspaceRoot: process.cwd(),
      sandbox: { level: 'workspace_write', workspaceRoot: process.cwd() },
      model: new FailingToolRetryModel() as never,
      store,
      tools,
      maxConsecutiveToolErrors: 2,
      maxRepeatedToolCalls: 10,
    });

    await agent.runTurn(threadId, { type: 'text', text: 'retry failing tool' });

    const toolItems = store.items.filter((item) => item.type === 'tool_call');
    expect(toolItems).toHaveLength(3);
    expect(toolItems.at(-1)).toMatchObject({
      status: 'failed',
      error: { code: 'TOOL_ERROR_LIMIT_REACHED' },
    });
  });

  it('hard-stops when the model emits tools after governance disables them', async () => {
    const threadId = 'thread-runtime-governance-ignores-tools';
    const model = new IgnoresDisabledToolsModel();
    const store = new FakeStore(threadId, 'previous-turn');
    const agent = new AgentLoop({
      workspaceRoot: process.cwd(),
      sandbox: { level: 'workspace_write', workspaceRoot: process.cwd() },
      model: model as never,
      store,
      maxRepeatedToolCalls: 1,
    });

    await expect(agent.runTurn(threadId, { type: 'text', text: 'do not loop' }))
      .rejects.toThrow('TOOL_GOVERNANCE_FINAL_RESPONSE_REJECTED');

    // First call executes, second is the middleware guard, third is the one
    // forced no-tool attempt. No fourth iteration or tool execution is allowed.
    expect(model.calls).toBe(3);
    expect(model.requests.at(-1)).toEqual({ tools: [], tool_choice: 'none' });
    expect(store.items.filter((item) => item.type === 'tool_call')).toHaveLength(2);
    expect(store.items.at(-1)).toMatchObject({
      type: 'error',
      message: expect.stringContaining('TOOL_GOVERNANCE_FINAL_RESPONSE_REJECTED'),
    });
  });

  it('re-applies no-tool finalization after a model wrapper tries to re-enable tools', async () => {
    const threadId = 'thread-runtime-governance-wrapper-reenable';
    const model = new IgnoresDisabledToolsModel();
    const store = new FakeStore(threadId, 'previous-turn');
    const agent = new AgentLoop({
      workspaceRoot: process.cwd(),
      sandbox: { level: 'workspace_write', workspaceRoot: process.cwd() },
      model: model as never,
      store,
      maxRepeatedToolCalls: 1,
      runtimeMiddleware: [{
        wrapModel: async (_ctx, request, next) => request.tool_choice === 'none'
          ? next({
              ...request,
              tools: [{
                type: 'function',
                function: { name: 'current_time', description: 'unexpected', parameters: {} },
              }],
              tool_choice: 'auto',
            })
          : next(request),
      }],
    });

    await expect(agent.runTurn(threadId, { type: 'text', text: 'protect wrapped finalization' }))
      .rejects.toThrow('TOOL_GOVERNANCE_FINAL_RESPONSE_REJECTED');

    expect(model.calls).toBe(3);
    expect(model.requests.at(-1)).toEqual({ tools: [], tool_choice: 'none' });
    expect(store.items.at(-1)).toMatchObject({
      type: 'error',
      message: expect.stringContaining('TOOL_GOVERNANCE_FINAL_RESPONSE_REJECTED'),
    });
  });

  it('treats a fractional or non-positive maxIterations as a bounded positive integer', async () => {
    const cases: Array<{ value: number; expectedMax: number; expectedCalls?: number }> = [
      { value: 1.9, expectedMax: 1, expectedCalls: 1 },
      { value: 0, expectedMax: 1, expectedCalls: 1 },
      { value: Number.NaN, expectedMax: 100 },
    ];
    for (const { value, expectedMax, expectedCalls } of cases) {
      const threadId = `thread-runtime-max-iterations-${String(value)}`;
      const model = new RepeatingToolModel();
      const store = new FakeStore(threadId, 'previous-turn');
      const agent = new AgentLoop({
        workspaceRoot: process.cwd(),
        sandbox: { level: 'workspace_write', workspaceRoot: process.cwd() },
        model: model as never,
        store,
        locale: 'en',
        maxIterations: value,
        maxRepeatedToolCalls: 10,
      });
      expect((agent as unknown as { config: { maxIterations: number } }).config.maxIterations).toBe(expectedMax);
      if (expectedCalls === undefined) continue;

      await expect(agent.runTurn(threadId, { type: 'text', text: 'respect iteration bound' }))
        .rejects.toThrow(/Agent loop exceeded max iterations/);
      expect(model.calls).toBe(expectedCalls);
      expect(store.savedTurns.at(-1)).toMatchObject({ status: 'failed' });
      expect(store.items.at(-1)).toMatchObject({ type: 'error' });
    }
  });

  it('stops after one retry when plain-text tool placeholders repeat', async () => {
    const threadId = 'thread-runtime-repeated-placeholder';
    const model = new RepeatingPlaceholderToolTextModel();
    const store = new FakeStore(threadId, 'previous-turn');
    const agent = new AgentLoop({
      workspaceRoot: process.cwd(),
      sandbox: { level: 'workspace_write', workspaceRoot: process.cwd() },
      model: model as never,
      store,
    });

    await expect(agent.runTurn(threadId, { type: 'text', text: 'do not repeat placeholder' }))
      .rejects.toThrow('PLAIN_TEXT_TOOL_CALL_REPEATED');

    expect(model.calls).toBe(2);
    expect(store.items.at(-1)).toMatchObject({
      type: 'error',
      message: expect.stringContaining('PLAIN_TEXT_TOOL_CALL_REPEATED'),
    });
  });

  it('injects dynamic runtime context before each model call', async () => {
    const threadId = 'thread-runtime-dynamic-context';
    const model = new MessageCapturingModel();
    const store = new FakeStore(threadId, 'previous-turn');
    store.items = [
      {
        id: 'file-change-1',
        type: 'file_change',
        turnId: 'previous-turn',
        changes: [{ path: 'packages/runtime/src/agent.ts', kind: 'update', summary: 'runtime edited' }],
        status: 'completed',
      },
    ];
    const agent = new AgentLoop({
      workspaceRoot: process.cwd(),
      sandbox: { preset: getPreset('workspace'), workspaceRoot: process.cwd() },
      model: model as never,
      store,
      tenantId: 'tenant-runtime-context',
      webSearchMode: 'on',
      runProfile: 'cache_first',
      dynamicContextProvider: async () => '远程助手绑定状态：weixin.enabled=true weixin.activeThreadMatched=true',
    });

    await agent.runTurn(threadId, {
      type: 'multimodal',
      parts: [
        { type: 'text', text: 'inspect context' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,abc' } },
      ],
    });

    const serialized = JSON.stringify(model.messages[0]);
    expect(serialized).toContain('<dynamic_context>');
    expect(serialized).toContain('tenantId=tenant-runtime-context');
    expect(serialized).toContain('工作区路径');
    expect(serialized).toContain('运行状态');
    // 运行档位已收敛为统一策略，不再注入提示词噪音。
    expect(serialized).not.toContain('runProfile=');
    expect(serialized).toContain('webSearchMode=on');
    expect(serialized).toContain('权限 preset=workspace');
    expect(serialized).toContain('最近上传/图片数量=1');
    expect(serialized).toContain('packages/runtime/src/agent.ts');
    expect(serialized).toContain('远程助手绑定状态');
  });

  it('injects provider string arrays and keeps base dynamic context for empty provider output', async () => {
    const arrayModel = new MessageCapturingModel();
    const arrayThreadId = 'thread-runtime-dynamic-context-array';
    await new AgentLoop({
      workspaceRoot: process.cwd(),
      sandbox: { level: 'workspace_write', workspaceRoot: process.cwd() },
      model: arrayModel as never,
      store: new FakeStore(arrayThreadId, 'previous-turn'),
      dynamicContextProvider: async () => ['provider line one', 'provider line two'],
    }).runTurn(arrayThreadId, { type: 'text', text: 'array provider' });

    const arrayContext = JSON.stringify(arrayModel.messages[0]);
    expect(arrayContext).toContain('provider line one');
    expect(arrayContext).toContain('provider line two');

    const emptyModel = new MessageCapturingModel();
    const emptyThreadId = 'thread-runtime-dynamic-context-empty';
    await new AgentLoop({
      workspaceRoot: process.cwd(),
      sandbox: { level: 'workspace_write', workspaceRoot: process.cwd() },
      model: emptyModel as never,
      store: new FakeStore(emptyThreadId, 'previous-turn'),
      dynamicContextProvider: async () => [],
    }).runTurn(emptyThreadId, { type: 'text', text: 'empty provider' });

    const emptyContext = JSON.stringify(emptyModel.messages[0]);
    expect(emptyContext).toContain('<dynamic_context>');
    expect(emptyContext).toContain('工作区路径');
  });
});

describe('AgentLoop delayed tool binding', () => {
  it('keeps eager binding as the default and does not expose tool_search', async () => {
    const threadId = 'thread-eager-tool-binding-default';
    const model = new ToolListModel();
    const agent = new AgentLoop({
      workspaceRoot: process.cwd(),
      sandbox: { level: 'workspace_write', workspaceRoot: process.cwd() },
      model: model as never,
      store: new FakeStore(threadId, 'previous-turn'),
      tools: createDelayedBindingRegistry(),
    });

    await agent.runTurn(threadId, { type: 'text', text: 'list tools' });

    expect(model.toolNames[0]).toEqual(expect.arrayContaining(['read_file', 'write_file']));
    expect(model.toolNames[0]).not.toContain('tool_search');
  });

  it('exposes only tool_search first, then binds matching tool schemas after search', async () => {
    const threadId = 'thread-delayed-tool-search';
    const model = new DelayedToolBindingModel();
    const store = new FakeStore(threadId, 'previous-turn');
    const agent = new AgentLoop({
      workspaceRoot: process.cwd(),
      sandbox: { level: 'workspace_write', workspaceRoot: process.cwd() },
      model: model as never,
      store,
      tools: createDelayedBindingRegistry(),
      toolBindingMode: 'delayed',
      maxToolSearchResults: 1,
    });

    await agent.runTurn(threadId, { type: 'text', text: 'read a file' });

    expect(model.toolNames[0]).toEqual(['tool_search']);
    expect(model.toolNames[1]).toEqual(['read_file', 'tool_search']);
    expect(model.toolNames[1]).not.toContain('write_file');
    expect(store.items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'tool_call',
        toolName: 'tool_search',
        status: 'completed',
      }),
      expect.objectContaining({
        type: 'tool_call',
        toolName: 'read_file',
        status: 'completed',
        result: { path: 'README.md' },
      }),
    ]));
  });

  it('fails a direct call to an unbound tool without running the real tool', async () => {
    const threadId = 'thread-delayed-hidden-tool';
    const model = new HiddenToolCallingModel();
    const store = new FakeStore(threadId, 'previous-turn');
    let executed = false;
    const registry = new ToolRegistry();
    registry.register({
      name: 'read_file',
      description: 'Read a workspace file',
      parameters: { type: 'object' },
      requiredPolicy: 'readonly',
      async execute() {
        executed = true;
        return { status: 'completed', output: 'read' };
      },
    });
    const agent = new AgentLoop({
      workspaceRoot: process.cwd(),
      sandbox: { level: 'workspace_write', workspaceRoot: process.cwd() },
      model: model as never,
      store,
      tools: registry,
      toolBindingMode: 'delayed',
    });

    await agent.runTurn(threadId, { type: 'text', text: 'call hidden read directly' });

    expect(model.toolNames[0]).toEqual(['tool_search']);
    expect(executed).toBe(false);
    expect(store.items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'tool_call',
        toolName: 'read_file',
        status: 'failed',
        error: expect.objectContaining({ code: 'TOOL_NOT_BOUND' }),
      }),
    ]));
  });

  it('allows explicit initial tools in delayed mode', async () => {
    const threadId = 'thread-delayed-initial-tools';
    const model = new ToolListModel();
    const agent = new AgentLoop({
      workspaceRoot: process.cwd(),
      sandbox: { level: 'workspace_write', workspaceRoot: process.cwd() },
      model: model as never,
      store: new FakeStore(threadId, 'previous-turn'),
      tools: createDelayedBindingRegistry(),
      toolBindingMode: 'delayed',
      initialTools: ['read_file'],
    });

    await agent.runTurn(threadId, { type: 'text', text: 'list tools' });

    expect(model.toolNames[0]).toEqual(['read_file', 'tool_search']);
  });
});

describe('AgentLoop tool governance middleware', () => {
  it('blocks configured tools before real execution', async () => {
    const threadId = 'thread-governance-blocked-tool';
    let executed = false;
    const tools = new ToolRegistry();
    tools.register({
      name: 'dangerous_tool',
      description: 'Dangerous test tool',
      parameters: { type: 'object' },
      requiredPolicy: 'readonly',
      async execute() {
        executed = true;
        return { status: 'completed', output: 'ran' };
      },
    });
    const store = new FakeStore(threadId, 'previous-turn');
    const agent = new AgentLoop({
      workspaceRoot: process.cwd(),
      sandbox: { level: 'workspace_write', workspaceRoot: process.cwd() },
      model: new SingleToolModel('dangerous_tool') as never,
      store,
      tools,
      toolGovernance: { blockedTools: ['dangerous_tool'] },
    });

    await agent.runTurn(threadId, { type: 'text', text: 'run blocked tool' });

    expect(executed).toBe(false);
    expect(store.items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'tool_call',
        toolName: 'dangerous_tool',
        status: 'failed',
        error: expect.objectContaining({ code: 'TOOL_BLOCKED' }),
      }),
    ]));
  });

  it('applies per-tool turn rate limits', async () => {
    const threadId = 'thread-governance-rate-limit';
    let executed = 0;
    const tools = new ToolRegistry();
    tools.register({
      name: 'limited_tool',
      description: 'Limited test tool',
      parameters: { type: 'object' },
      requiredPolicy: 'readonly',
      async execute() {
        executed += 1;
        return { status: 'completed', output: 'ran' };
      },
    });
    const store = new FakeStore(threadId, 'previous-turn');
    const agent = new AgentLoop({
      workspaceRoot: process.cwd(),
      sandbox: { level: 'workspace_write', workspaceRoot: process.cwd() },
      model: new SequenceToolModel([
        { name: 'limited_tool' },
        { name: 'limited_tool' },
      ]) as never,
      store,
      tools,
      toolGovernance: { rateLimits: { limited_tool: 1 } },
    });

    await agent.runTurn(threadId, { type: 'text', text: 'run limited tool twice' });

    expect(executed).toBe(1);
    expect(store.items.filter((item) => item.type === 'tool_call').at(-1)).toMatchObject({
      status: 'failed',
      error: { code: 'TOOL_RATE_LIMIT_REACHED' },
    });
  });

  it('forces HITL approval from middleware and records denial as a tool result', async () => {
    const threadId = 'thread-governance-force-approval';
    let executed = false;
    const approvalEvents: ThreadEvent[] = [];
    const tools = new ToolRegistry();
    tools.register({
      name: 'reviewed_tool',
      description: 'Needs approval by policy',
      parameters: { type: 'object' },
      requiredPolicy: 'readonly',
      async execute() {
        executed = true;
        return { status: 'completed', output: 'ran' };
      },
    });
    const store = new FakeStore(threadId, 'previous-turn');
    const agent = new AgentLoop({
      workspaceRoot: process.cwd(),
      sandbox: { level: 'workspace_write', workspaceRoot: process.cwd() },
      model: new SingleToolModel('reviewed_tool') as never,
      store,
      tools,
      approvalHandler: {
        requestApproval: async () => ({ approved: false, reason: 'needs human' }),
      },
      toolGovernance: { forceApprovalTools: ['reviewed_tool'] },
    });
    agent.onEvent((event) => approvalEvents.push(event));

    await agent.runTurn(threadId, { type: 'text', text: 'run reviewed tool' });

    expect(executed).toBe(false);
    expect(approvalEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'approval.required', threadId }),
    ]));
    expect(store.runEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({ category: 'approval', type: 'approval.required' }),
      expect.objectContaining({
        category: 'approval',
        type: 'approval.resolved',
        metadata: expect.objectContaining({ status: 'denied' }),
      }),
    ]));
    expect(store.items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'tool_call',
        toolName: 'reviewed_tool',
        status: 'failed',
        error: expect.objectContaining({ code: 'APPROVAL_DENIED' }),
      }),
    ]));
  });
});

describe('AgentLoop guardian middleware', () => {
  it('fails closed when guardian denies a tool call before real execution', async () => {
    const threadId = 'thread-guardian-denied';
    let executed = false;
    let reviewCalls = 0;
    const warnings: ThreadEvent[] = [];
    const tools = new ToolRegistry();
    tools.register({
      name: 'dangerous_tool',
      description: 'Dangerous test tool',
      parameters: { type: 'object' },
      requiredPolicy: 'readonly',
      async execute() {
        executed = true;
        return { status: 'completed', output: 'ran' };
      },
    });
    const store = new FakeStore(threadId, 'previous-turn');
    const agent = new AgentLoop({
      workspaceRoot: process.cwd(),
      sandbox: { level: 'workspace_write', workspaceRoot: process.cwd() },
      model: new SingleToolModel('dangerous_tool') as never,
      store,
      tools,
      guardian: {
        enabled: true,
        review: 'all',
        reviewer: async () => {
          reviewCalls += 1;
          return { authorization: 'denied', riskLevel: 'high', reason: 'unsafe request' };
        },
      },
    });
    agent.onEvent((event) => warnings.push(event));

    await agent.runTurn(threadId, { type: 'text', text: 'run dangerous tool' });

    expect(executed).toBe(false);
    expect(reviewCalls).toBe(1);
    expect(store.items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'tool_call',
        toolName: 'dangerous_tool',
        status: 'failed',
        error: expect.objectContaining({ code: 'GUARDIAN_DENIED' }),
      }),
    ]));
    expect(warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'warning', threadId, turnId: expect.any(String) }),
    ]));
  });

  it('fails closed when the guardian reviewer errors', async () => {
    const threadId = 'thread-guardian-review-error';
    let executed = false;
    const tools = new ToolRegistry();
    tools.register({
      name: 'reviewed_tool',
      description: 'Reviewed test tool',
      parameters: { type: 'object' },
      requiredPolicy: 'readonly',
      async execute() {
        executed = true;
        return { status: 'completed', output: 'ran' };
      },
    });
    const store = new FakeStore(threadId, 'previous-turn');
    const agent = new AgentLoop({
      workspaceRoot: process.cwd(),
      sandbox: { level: 'workspace_write', workspaceRoot: process.cwd() },
      model: new SingleToolModel('reviewed_tool') as never,
      store,
      tools,
      guardian: {
        enabled: true,
        review: 'all',
        reviewer: async () => {
          throw new Error('review model unavailable');
        },
      },
    });

    await agent.runTurn(threadId, { type: 'text', text: 'run reviewed tool' });

    expect(executed).toBe(false);
    expect(store.items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'tool_call',
        toolName: 'reviewed_tool',
        status: 'failed',
        error: expect.objectContaining({ code: 'GUARDIAN_REVIEW_FAILED' }),
      }),
    ]));
  });

  it('opens a per-turn guardian rejection circuit after repeated denials', async () => {
    const threadId = 'thread-guardian-circuit';
    let reviewCalls = 0;
    let executed = 0;
    const tools = new ToolRegistry();
    tools.register({
      name: 'guarded_tool',
      description: 'Guarded test tool',
      parameters: { type: 'object' },
      requiredPolicy: 'readonly',
      async execute() {
        executed += 1;
        return { status: 'completed', output: 'ran' };
      },
    });
    const store = new FakeStore(threadId, 'previous-turn');
    const agent = new AgentLoop({
      workspaceRoot: process.cwd(),
      sandbox: { level: 'workspace_write', workspaceRoot: process.cwd() },
      model: new SequenceToolModel([
        { name: 'guarded_tool' },
        { name: 'guarded_tool' },
      ]) as never,
      store,
      tools,
      guardian: {
        enabled: true,
        review: 'all',
        maxDenialsPerTurn: 1,
        reviewer: async () => {
          reviewCalls += 1;
          return { authorization: 'denied', riskLevel: 'medium', reason: 'not allowed' };
        },
      },
      maxRepeatedToolCalls: 10,
    });

    await agent.runTurn(threadId, { type: 'text', text: 'try twice' });

    expect(executed).toBe(0);
    expect(reviewCalls).toBe(1);
    const toolItems = store.items.filter((item) => item.type === 'tool_call');
    expect(toolItems).toHaveLength(2);
    expect(toolItems[0]).toMatchObject({ status: 'failed', error: { code: 'GUARDIAN_DENIED' } });
    expect(toolItems[1]).toMatchObject({ status: 'failed', error: { code: 'GUARDIAN_CIRCUIT_OPEN' } });
  });
});

describe('AgentLoop checkpoint metadata', () => {
  it('writes terminal checkpoints with status and generation and without running expiry', async () => {
    const threadId = 'thread-checkpoint-status';
    const store = new FakeStore(threadId, 'previous-turn');
    const agent = new AgentLoop({
      workspaceRoot: process.cwd(),
      sandbox: { level: 'workspace_write', workspaceRoot: process.cwd() },
      model: new FakeModel() as never,
      store,
    });

    await agent.runTurn(threadId, { type: 'text', text: '检查 checkpoint' });

    expect(store.checkpoint).toMatchObject({
      threadId,
      itemIndex: 2,
      status: 'completed',
      generation: expect.any(Number),
    });
    expect(store.checkpoint?.expiresAt).toBeUndefined();
  });
});

describe('AgentLoop interrupt handling', () => {
  it('emits an interrupted completion event instead of a failed turn', () => {
    const threadId = 'thread-interrupt';
    const turnId = 'turn-interrupt';
    const stateManager = new ThreadStateManager();
    stateManager.startTurn(threadId, turnId);
    const agent = new AgentLoop(
      {
        workspaceRoot: process.cwd(),
        sandbox: { level: 'workspace_write', workspaceRoot: process.cwd() },
        model: new FakeModel() as never,
        store: new FakeStore(threadId, turnId),
      },
      stateManager,
    );
    const events: Array<{ type: string; status?: string }> = [];
    agent.onEvent((event) => events.push(event as never));

    expect(agent.interrupt(threadId)).toBe(true);

    expect(events).toContainEqual(expect.objectContaining({
      type: 'turn.completed',
      status: 'interrupted',
    }));
    expect(events.some((event) => event.type === 'turn.failed')).toBe(false);
  });

  it('passes cancellation into the active model stream and preserves visible partial output', async () => {
    const threadId = 'thread-interrupt-stream';
    const store = new FakeStore(threadId, 'previous-turn');
    const started = deferred<void>();
    const aborted = deferred<void>();
    let observedSignal: AbortSignal | undefined;
    const model = {
      async *chatStream(
        _req: unknown,
        options?: { signal?: AbortSignal },
      ): AsyncGenerator<{ type: 'delta'; content: string }> {
        observedSignal = options?.signal;
        yield { type: 'delta', content: 'partial answer' };
        started.resolve();
        if (!options?.signal) throw new Error('missing abort signal');
        if (!options.signal.aborted) {
          await new Promise<void>((resolve) => {
            options.signal!.addEventListener('abort', () => resolve(), { once: true });
          });
        }
        aborted.resolve();
        throw new Error('Turn cancelled');
      },
    };
    const agent = new AgentLoop({
      workspaceRoot: process.cwd(),
      sandbox: { level: 'workspace_write', workspaceRoot: process.cwd() },
      model: model as never,
      store,
    });

    const run = agent.runTurn(threadId, { type: 'text', text: 'stop this' });
    await started.promise;

    expect(observedSignal).toBeDefined();
    expect(observedSignal?.aborted).toBe(false);
    expect(agent.interrupt(threadId)).toBe(true);
    await aborted.promise;

    const result = await run;
    expect(result.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'agent_message', text: 'partial answer' }),
    ]));
    expect(store.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'agent_message', text: 'partial answer' }),
    ]));
    expect(store.savedTurns.at(-1)).toMatchObject({ status: 'interrupted' });
    expect(store.checkpoint).toMatchObject({ status: 'interrupted', itemIndex: 2 });
  });
});

describe('AgentLoop message history', () => {
  it('injects matching cold memories into the stable model context and records usage', async () => {
    const threadId = 'thread-cold-memory';
    const store = new FakeStore(threadId, 'previous-turn');
    store.memoryRecords = [{
      id: 'mem-cn',
      type: 'preference',
      text: '用户偏好：回答使用中文。',
      status: 'active',
      scope: 'global',
      sourceThreadId: 'source-thread',
      sourceTurnIds: ['source-turn'],
      workspaceRoot: process.cwd(),
      tags: ['language'],
      confidence: 0.9,
      usageCount: 0,
      lastUsedAt: null,
      createdAt: '2026-06-19T00:00:00.000Z',
      updatedAt: '2026-06-19T00:00:00.000Z',
    }];
    const model = new MessageCapturingModel();
    const agent = new AgentLoop({
      workspaceRoot: process.cwd(),
      sandbox: { level: 'workspace_write', workspaceRoot: process.cwd() },
      model: model as never,
      store,
      memory: { memoryEnabled: true, useColdMemories: true, autoExtractMemories: false, memoryInjectLimit: 4, memoryTokenBudget: 800 },
    });

    await agent.runTurn(threadId, { type: 'text', text: '请用中文总结一下' });

    const systemPrompt = String(model.messages[0]?.find((message) => message.role === 'system')?.content ?? '');
    expect(systemPrompt).toContain('## Cold Memories');
    expect(systemPrompt).toContain('[memory:mem-cn preference');
    expect(systemPrompt).toContain('用户偏好：回答使用中文。');
    expect(store.memoryUsages).toEqual([expect.objectContaining({ id: 'mem-cn' })]);
  });

  it('injects flushed light memories into the stable model context', async () => {
    const threadId = 'thread-light-memory';
    const store = new FakeStore(threadId, 'previous-turn');
    const state: LightMemoryState = {
      enabled: true,
      debounceMs: 30_000,
      maxEntries: 200,
      queue: [],
      nextFlushAt: null,
      entries: [
        {
          id: 'light-cn',
          text: '用户希望短回答优先用中文。',
          sourceThreadId: 'source-thread',
          createdAt: '2026-06-19T00:00:00.000Z',
          updatedAt: '2026-06-19T00:00:00.000Z',
        },
      ],
    };
    await store.setSetting(LIGHT_MEMORY_KEY, state);
    const model = new MessageCapturingModel();
    const agent = new AgentLoop({
      workspaceRoot: process.cwd(),
      sandbox: { level: 'workspace_write', workspaceRoot: process.cwd() },
      model: model as never,
      store,
      memory: { memoryEnabled: true, useColdMemories: false, autoExtractMemories: false, memoryInjectLimit: 4, memoryTokenBudget: 800 },
    });

    await agent.runTurn(threadId, { type: 'text', text: '继续' });

    const systemPrompt = String(model.messages[0]?.find((message) => message.role === 'system')?.content ?? '');
    expect(systemPrompt).toContain('## Light Memories');
    expect(systemPrompt).toContain('[light:light-cn sourceThreadId=source-thread]');
    expect(systemPrompt).toContain('用户希望短回答优先用中文。');
  });

  it('does not inject or extract cold memories when disabled or thread-excluded', async () => {
    const threadId = 'thread-memory-disabled';
    const disabledStore = new FakeStore(threadId, 'previous-turn');
    disabledStore.memoryRecords = [{
      id: 'mem-disabled',
      type: 'preference',
      text: '用户偏好：回答使用中文。',
      status: 'active',
      scope: 'global',
      sourceThreadId: 'source-thread',
      sourceTurnIds: ['source-turn'],
      workspaceRoot: process.cwd(),
      tags: [],
      confidence: 0.9,
      usageCount: 0,
      lastUsedAt: null,
      createdAt: '2026-06-19T00:00:00.000Z',
      updatedAt: '2026-06-19T00:00:00.000Z',
    }];
    const disabledModel = new MessageCapturingModel();
    await new AgentLoop({
      workspaceRoot: process.cwd(),
      sandbox: { level: 'workspace_write', workspaceRoot: process.cwd() },
      model: disabledModel as never,
      store: disabledStore,
      memory: { memoryEnabled: false, useColdMemories: false, autoExtractMemories: false, memoryInjectLimit: 4, memoryTokenBudget: 800 },
    }).runTurn(threadId, { type: 'text', text: '请用中文总结一下' });
    expect(JSON.stringify(disabledModel.messages[0])).not.toContain('Cold Memories');
    expect(disabledStore.memoryUsages).toEqual([]);

    const excludedStore = new FakeStore('thread-memory-excluded', 'previous-turn');
    excludedStore.thread.tags = { memoryExcluded: 'true' };
    await new AgentLoop({
      workspaceRoot: process.cwd(),
      sandbox: { level: 'workspace_write', workspaceRoot: process.cwd() },
      model: new MessageCapturingModel() as never,
      store: excludedStore,
      memory: { memoryEnabled: true, useColdMemories: false, autoExtractMemories: true, memoryInjectLimit: 4, memoryTokenBudget: 800 },
    }).runTurn('thread-memory-excluded', { type: 'text', text: '以后都用中文回答' });
    expect(excludedStore.memoryRecords).toEqual([]);
  });

  it('extracts cold memory candidates after a completed eligible turn', async () => {
    const threadId = 'thread-memory-extract';
    const store = new FakeStore(threadId, 'previous-turn');
    const agent = new AgentLoop({
      workspaceRoot: process.cwd(),
      sandbox: { level: 'workspace_write', workspaceRoot: process.cwd() },
      model: new MessageCapturingModel() as never,
      store,
      memory: { memoryEnabled: true, useColdMemories: false, autoExtractMemories: true, memoryInjectLimit: 4, memoryTokenBudget: 800 },
    });

    await agent.runTurn(threadId, { type: 'text', text: '以后默认用中文回答，并记住 Suanlizi 只改 Suanlizi/ 目录。' });

    await waitForCondition(() => store.memoryRecords.length >= 2, 500);
    expect(store.memoryRecords).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'preference', text: expect.stringContaining('中文') }),
      expect.objectContaining({ type: 'project_fact', text: expect.stringContaining('Suanlizi/') }),
    ]));
  });

  it('normalizes common hallucinated tool names before execution', async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'suanlizi-tool-alias-'));
    await fs.writeFile(path.join(workspaceRoot, 'README.md'), '# test\n', 'utf-8');
    const threadId = 'thread-tool-alias';
    const store = new FakeStore(threadId, 'previous-turn');
    const agent = new AgentLoop({
      workspaceRoot,
      sandbox: { level: 'workspace_write', workspaceRoot },
      model: new AliasToolCallingModel() as never,
      store,
    });

    await agent.runTurn(threadId, { type: 'text', text: '列一下目录' });

    expect(store.items.some((item) => item.type === 'error')).toBe(false);
    expect(store.items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'tool_call',
        toolName: 'list_files',
        status: 'completed',
        result: expect.objectContaining({
          entries: expect.arrayContaining([
            expect.objectContaining({ path: 'README.md', kind: 'file' }),
          ]),
        }),
      }),
      expect.objectContaining({
        type: 'agent_message',
        text: 'listed ok',
      }),
    ]));
  });

  it('persists model tool call ids on tool call items', async () => {
    const threadId = 'thread-provider-tool-id';
    const store = new FakeStore(threadId, 'previous-turn');
    const model = new SingleToolModel('current_time');
    const agent = new AgentLoop({
      workspaceRoot: process.cwd(),
      sandbox: { level: 'workspace_write', workspaceRoot: process.cwd() },
      model: model as never,
      store,
    });

    await agent.runTurn(threadId, { type: 'text', text: '现在几点' });

    const toolItem = store.items.find((item) => item.type === 'tool_call');
    expect(toolItem).toMatchObject({
      type: 'tool_call',
      modelToolCallId: 'call_current_time',
      modelToolName: 'current_time',
      providerToolCall: expect.objectContaining({
        format: 'openai_chat',
        id: 'call_current_time',
        name: 'current_time',
      }),
    });
  });

  it('persists provider assistant frames for model tool turns', async () => {
    const threadId = 'thread-provider-assistant-frame';
    const store = new FakeStore(threadId, 'previous-turn');
    const model = new SingleToolModel('current_time');
    const agent = new AgentLoop({
      workspaceRoot: process.cwd(),
      sandbox: { level: 'workspace_write', workspaceRoot: process.cwd() },
      model: model as never,
      store,
    });

    await agent.runTurn(threadId, { type: 'text', text: '现在几点' });

    const assistantItem = store.items.find((item) =>
      item.type === 'agent_message' &&
      item.providerFrame?.format === 'openai_chat'
    );
    expect(assistantItem).toMatchObject({
      type: 'agent_message',
      providerFrame: {
        format: 'openai_chat',
        content: null,
        toolCalls: [{
          id: 'call_current_time',
          type: 'function',
          function: { name: 'current_time', arguments: '{}' },
        }],
      },
    });
  });

  it('persists Anthropic provider frames for MiniMax tool turns and replays them on the next model call', async () => {
    const threadId = 'thread-anthropic-provider-frame';
    const store = new FakeStore(threadId, 'previous-turn');
    const model = new AnthropicToolCallingModel();
    const tools = new ToolRegistry();
    tools.register({
      name: 'read_file',
      description: 'Read a file',
      requiredPolicy: 'readonly',
      requiresApproval: false,
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
        additionalProperties: false,
      },
      execute: async () => ({ output: 'file text', status: 'completed' as const }),
    });
    const agent = new AgentLoop({
      workspaceRoot: process.cwd(),
      sandbox: { level: 'readonly', workspaceRoot: process.cwd() },
      model: model as never,
      store,
      tools,
      locale: 'zh',
    });

    await agent.runTurn(threadId, { type: 'text', text: '读 README' });

    const assistantFrame = store.items.find((item) => item.type === 'agent_message' && item.providerFrame?.format === 'anthropic_messages');
    const reasoningIndex = store.items.findIndex((item) => item.type === 'reasoning' && item.text === '需要读取文件。');
    const assistantFrameIndex = store.items.findIndex((item) => item === assistantFrame);
    expect(assistantFrame).toMatchObject({
      type: 'agent_message',
      providerFrame: {
        format: 'anthropic_messages',
        contentBlocks: expect.arrayContaining([
          expect.objectContaining({ type: 'thinking', thinking: '需要读取文件。' }),
          expect.objectContaining({ type: 'tool_use', id: 'toolu_read_1', name: 'read_file' }),
        ]),
      },
    });
    expect(reasoningIndex).toBeGreaterThanOrEqual(0);
    expect(reasoningIndex).toBeLessThan(assistantFrameIndex);
    expect(model.calls[1]).toEqual(expect.arrayContaining([
      expect.objectContaining({
        role: 'assistant',
        providerFrame: expect.objectContaining({
          format: 'anthropic_messages',
          contentBlocks: expect.arrayContaining([
            expect.objectContaining({ type: 'tool_use', id: 'toolu_read_1' }),
          ]),
        }),
      }),
      expect.objectContaining({
        role: 'tool',
        tool_call_id: 'toolu_read_1',
      }),
    ]));
  });

  it('persists DeepSeek reasoning_content in OpenAI tool history and replays it on the next model call', async () => {
    const threadId = 'thread-deepseek-reasoning-history';
    const store = new FakeStore(threadId, 'previous-turn');
    const model = new DeepSeekReasoningToolModel();
    const agent = new AgentLoop({
      workspaceRoot: process.cwd(),
      sandbox: { level: 'workspace_write', workspaceRoot: process.cwd() },
      model: model as never,
      store,
      locale: 'zh',
    });

    await agent.runTurn(threadId, { type: 'text', text: '现在几点' });

    const assistantFrame = store.items.find((item) => item.type === 'agent_message' && item.providerFrame?.format === 'openai_chat');
    const reasoningIndex = store.items.findIndex((item) => item.type === 'reasoning' && item.text === '先决定读取时间。');
    const assistantFrameIndex = store.items.findIndex((item) => item === assistantFrame);
    expect(assistantFrame).toMatchObject({
      type: 'agent_message',
      providerFrame: {
        format: 'openai_chat',
        content: null,
        reasoningContent: '先决定读取时间。',
        toolCalls: [expect.objectContaining({ id: 'call_current_time' })],
      },
    });
    expect(reasoningIndex).toBeGreaterThanOrEqual(0);
    expect(reasoningIndex).toBeLessThan(assistantFrameIndex);
    expect(model.calls[1]).toEqual(expect.arrayContaining([
      expect.objectContaining({
        role: 'assistant',
        reasoning_content: '先决定读取时间。',
        tool_calls: [expect.objectContaining({ id: 'call_current_time' })],
      }),
      expect.objectContaining({
        role: 'tool',
        tool_call_id: 'call_current_time',
      }),
    ]));
  });

  it('persists llama Responses outputItems and replays reasoning and tools on the next turn', async () => {
    const threadId = 'thread-llama-responses-history';
    const store = new FakeStore(threadId, 'previous-turn');
    const model = new LlamaResponsesToolCallingModel();
    const agent = new AgentLoop({
      workspaceRoot: process.cwd(),
      sandbox: { level: 'workspace_write', workspaceRoot: process.cwd() },
      model: model as never,
      store,
      locale: 'zh',
    });

    await agent.runTurn(threadId, { type: 'text', text: '现在几点' });
    await agent.runTurn(threadId, { type: 'text', text: '继续' });

    const assistantFrame = store.items.find((item) => item.type === 'agent_message' && item.providerFrame?.format === 'openai_responses');
    expect(assistantFrame).toMatchObject({
      type: 'agent_message',
      providerFrame: {
        format: 'openai_responses',
        outputItems: expect.arrayContaining([
          {
            type: 'reasoning',
            summary: [{ type: 'summary_text', text: '先检查当前时间。' }],
            content: [{ type: 'input_text', text: '先检查当前时间。' }],
          },
          {
            type: 'function_call',
            call_id: 'call_current_time_responses',
            name: 'current_time',
            arguments: '{}',
          },
        ]),
      },
    });
    const replayedAssistant = model.calls[2]?.find((message) => (
      message.role === 'assistant'
      && (message.providerFrame as { format?: string } | undefined)?.format === 'openai_responses'
    ));
    expect(replayedAssistant).toBeDefined();
    expect(replayedAssistant?.providerFrame).toEqual(expect.objectContaining({
      format: 'openai_responses',
      outputItems: expect.arrayContaining([
        expect.objectContaining({ type: 'reasoning', content: [{ type: 'input_text', text: '先检查当前时间。' }] }),
        expect.objectContaining({ type: 'function_call', call_id: 'call_current_time_responses' }),
      ]),
    }));
    expect(replayedAssistant?.tool_calls).toEqual(expect.arrayContaining([expect.objectContaining({
      id: 'call_current_time_responses',
      function: expect.objectContaining({ arguments: '{}' }),
    })]));
    const replayedTool = model.calls[2]?.find((message) => (
      message.role === 'tool' && message.tool_call_id === 'call_current_time_responses'
    ));
    expect(replayedTool).toBeDefined();
  });

  it('replays completed tools structurally on the next turn', async () => {
    const threadId = 'thread-structured-tool-history';
    const store = new FakeStore(threadId, 'previous-turn');
    const model = new SingleToolModel('current_time');
    const agent = new AgentLoop({
      workspaceRoot: process.cwd(),
      sandbox: { level: 'workspace_write', workspaceRoot: process.cwd() },
      model: model as never,
      store,
    });

    await agent.runTurn(threadId, { type: 'text', text: '现在几点' });
    await agent.runTurn(threadId, { type: 'text', text: '继续' });

    const secondTurnInitialMessages = model.calls[2] ?? [];
    const serialized = JSON.stringify(secondTurnInitialMessages);
    expect(serialized).not.toContain('[Tool');
    expect(secondTurnInitialMessages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        role: 'assistant',
        tool_calls: [expect.objectContaining({ id: 'call_current_time' })],
      }),
      expect.objectContaining({
        role: 'tool',
        tool_call_id: 'call_current_time',
      }),
    ]));
  });

  it('does not replay persisted tool results as orphan OpenAI tool messages on the next turn', async () => {
    const threadId = 'thread-tool-history';
    const store = new FakeStore(threadId, 'previous-turn');
    const model = new ToolCallingModel();
    const agent = new AgentLoop({
      workspaceRoot: process.cwd(),
      sandbox: { level: 'workspace_write', workspaceRoot: process.cwd() },
      model: model as never,
      store,
    });

    await agent.runTurn(threadId, { type: 'text', text: '现在几点' });
    await agent.runTurn(threadId, { type: 'text', text: '继续' });

    const secondTurnInitialMessages = model.calls[2] ?? [];
    const assistantToolCall = secondTurnInitialMessages.find((msg) =>
      msg.role === 'assistant' &&
      Array.isArray(msg.tool_calls) &&
      msg.tool_calls.some((toolCall) =>
        typeof toolCall === 'object' &&
        toolCall !== null &&
        (toolCall as { id?: string }).id === 'call_current_time'
      )
    );
    const toolMessage = secondTurnInitialMessages.find((msg) =>
      msg.role === 'tool' &&
      msg.tool_call_id === 'call_current_time'
    );
    expect(assistantToolCall).toBeTruthy();
    expect(toolMessage).toBeTruthy();
    expect(secondTurnInitialMessages.indexOf(toolMessage!)).toBeGreaterThan(
      secondTurnInitialMessages.indexOf(assistantToolCall!),
    );
  });

  it('redacts DingTalk group send tool history before sending it back to the model', async () => {
    const threadId = 'thread-dingtalk-tool-history';
    const store = new FakeStore(threadId, 'previous-turn');
    store.items.push({
      id: 'old-dingtalk-assistant',
      type: 'agent_message',
      turnId: 'previous-turn',
      text: '',
      providerFrame: {
        format: 'openai_chat',
        content: null,
        toolCalls: [{
          id: 'call_old_dingtalk_send',
          type: 'function',
          function: {
            name: 'dingtalk_forward_to_group',
            arguments: JSON.stringify({ message: '安博威的爸爸', targetGroupName: '打完我去打DD·', source: 'dingtalk_dm' }),
          },
        }],
      },
    });
    store.items.push({
      id: 'old-dingtalk-send',
      type: 'tool_call',
      turnId: 'previous-turn',
      toolName: 'dingtalk_forward_to_group',
      arguments: { message: '安博威的爸爸', targetGroupName: '打完我去打DD·', source: 'dingtalk_dm' },
      modelToolCallId: 'call_old_dingtalk_send',
      modelToolName: 'dingtalk_forward_to_group',
      providerToolCall: {
        format: 'openai_chat',
        id: 'call_old_dingtalk_send',
        name: 'dingtalk_forward_to_group',
        arguments: { message: '安博威的爸爸', targetGroupName: '打完我去打DD·', source: 'dingtalk_dm' },
      },
      result: {
        output: '已发送',
        data: {
          conversationId: 'cid_group_target',
          processQueryKey: 'group_sent',
          messageId: 'msg_internal',
        },
      },
      status: 'completed',
    });
    const model = new MessageCapturingModel();
    const agent = new AgentLoop({
      workspaceRoot: process.cwd(),
      sandbox: { level: 'workspace_write', workspaceRoot: process.cwd() },
      model: model as never,
      store,
    });

    await agent.runTurn(threadId, { type: 'text', text: '现在几点了？' });

    const modelInput = JSON.stringify(model.messages[0]);
    expect(modelInput).not.toContain('[Tool dingtalk_forward_to_group completed]');
    expect(modelInput).toContain('DingTalk group message tool result redacted');
    expect(modelInput).not.toContain('安博威的爸爸');
    expect(modelInput).not.toContain('cid_group_target');
    expect(modelInput).not.toContain('group_sent');
    expect(modelInput).not.toContain('processQueryKey');
    expect(modelInput).not.toContain('messageId');
  });

  it('redacts persisted assistant messages that leaked tool-call protocol text', async () => {
    const threadId = 'thread-leaked-tool-protocol-history';
    const store = new FakeStore(threadId, 'previous-turn');
    store.items.push({
      id: 'old-leaked-agent-message',
      type: 'agent_message',
      turnId: 'previous-turn',
      text: [
        '好的，我来发送。',
        '',
        '<｜tool_calls｜>',
        '<｜invoke name="dingtalk_send_group_message"｜>',
        '<｜parameter name="text"｜>安博威的爸爸<｜/parameter｜>',
        '<｜parameter name="groupName"｜>打完我去打DD·<｜/parameter｜>',
        '<｜/invoke｜>',
        '<｜/tool_calls｜>',
      ].join('\n'),
    });
    const model = new MessageCapturingModel();
    const agent = new AgentLoop({
      workspaceRoot: process.cwd(),
      sandbox: { level: 'workspace_write', workspaceRoot: process.cwd() },
      model: model as never,
      store,
    });

    await agent.runTurn(threadId, { type: 'text', text: '现在几点了？' });

    const modelInput = JSON.stringify(model.messages[0]);
    expect(modelInput).toContain('Previous assistant message redacted because it contained leaked tool-call protocol text');
    expect(modelInput).not.toContain('dingtalk_send_group_message');
    expect(modelInput).not.toContain('安博威的爸爸');
    expect(modelInput).not.toContain('tool_calls');
    expect(modelInput).not.toContain('invoke');
  });

  it('injects the selected skill body when the user mentions a skill token', async () => {
    const skills = new LocalSkillRegistry();
    skills.register({
      name: 'frontend-design',
      description: 'Design frontend UI.',
      body: 'Use the frontend-design body, not only the summary.',
      sourcePath: 'C:/skills/frontend-design/SKILL.md',
    });
    const model = new MessageCapturingModel();
    const agent = new AgentLoop({
      workspaceRoot: process.cwd(),
      sandbox: { level: 'workspace_write', workspaceRoot: process.cwd() },
      model: model as never,
      store: new FakeStore('thread-skill-token', 'previous-turn'),
      skills,
    });

    await agent.runTurn('thread-skill-token', {
      type: 'text',
      text: '$frontend-design 优化这个界面',
    });

    expect(model.messages[0]?.some((message) => (
      message.role === 'system'
      && typeof message.content === 'string'
      && message.content.includes('Use the frontend-design body')
    ))).toBe(false);
    expect(model.messages[0]?.some((message) => (
      message.role === 'user'
      && typeof message.content === 'string'
      && message.content.includes('Use the frontend-design body')
    ))).toBe(true);
  });

  it('includes Codex-style skills instructions in the stable system prompt', async () => {
    const skills = new LocalSkillRegistry();
    skills.register({
      name: 'code-review',
      description: 'Review code changes and find regressions.',
      body: 'Full review workflow body.',
      sourcePath: 'C:/skills/code-review/SKILL.md',
    });
    const model = new MessageCapturingModel();
    const agent = new AgentLoop({
      workspaceRoot: process.cwd(),
      sandbox: { level: 'workspace_write', workspaceRoot: process.cwd() },
      model: model as never,
      store: new FakeStore('thread-skills-instructions', 'previous-turn'),
      skills,
    });

    await agent.runTurn('thread-skills-instructions', {
      type: 'text',
      text: '检查这个模块',
    });

    const systemPrompt = model.messages[0]?.find((message) => message.role === 'system')?.content;
    expect(systemPrompt).toContain('<skills_instructions>');
    expect(systemPrompt).toContain('### How to use skills');
    expect(systemPrompt).toContain("task clearly matches a skill's description");
    expect(systemPrompt).toContain('- code-review: Review code changes and find regressions. (file: C:/skills/code-review/SKILL.md)');
  });

  it('does not inject full skill bodies into the stable prompt without an explicit skill token', async () => {
    const skills = new LocalSkillRegistry();
    skills.register({
      name: 'frontend-design',
      description: 'Design frontend UI.',
      body: 'Use the frontend-design body only when the skill is active.',
      sourcePath: 'C:/skills/frontend-design/SKILL.md',
    });
    const model = new MessageCapturingModel();
    const agent = new AgentLoop({
      workspaceRoot: process.cwd(),
      sandbox: { level: 'workspace_write', workspaceRoot: process.cwd() },
      model: model as never,
      store: new FakeStore('thread-skill-match-only', 'previous-turn'),
      skills,
    });

    await agent.runTurn('thread-skill-match-only', {
      type: 'text',
      text: '帮我美化这个 Web UI',
    });

    const systemPrompt = model.messages[0]?.find((message) => message.role === 'system')?.content;
    const userMessages = model.messages[0]?.filter((message) => message.role === 'user') ?? [];
    expect(systemPrompt).toContain('<skills_instructions>');
    expect(systemPrompt).toContain('Design frontend UI.');
    expect(systemPrompt).not.toContain('Use the frontend-design body only when the skill is active.');
    expect(userMessages.some((message) => (
      typeof message.content === 'string'
      && message.content.includes('Use the frontend-design body only when the skill is active.')
    ))).toBe(false);
  });

  it('keeps one-shot mode instructions out of the stable system prefix', async () => {
    const model = new MessageCapturingModel();
    const agent = new AgentLoop({
      workspaceRoot: process.cwd(),
      sandbox: { level: 'workspace_write', workspaceRoot: process.cwd() },
      model: model as never,
      store: new FakeStore('thread-mode-instruction', 'previous-turn'),
    });

    await agent.runTurn('thread-mode-instruction', {
      type: 'text',
      text: '检查这个模块',
      modeInstruction: 'Review mode: list bugs first.',
    });

    expect(model.messages[0]?.some((message) => (
      message.role === 'system'
      && typeof message.content === 'string'
      && message.content.includes('Review mode')
    ))).toBe(false);
    expect(model.messages[0]?.some((message) => (
      message.role === 'user'
      && typeof message.content === 'string'
      && message.content.includes('Review mode')
    ))).toBe(true);
  });

  it('does not include compacted turn items in model history after compaction', async () => {
    const threadId = 'thread-compacted-history';
    const store = new FakeStore(threadId, 'previous-turn');
    store.turns = [
      {
        turnId: 'old-turn',
        threadId,
        index: 0,
        userInput: { type: 'text', text: 'old secret request' },
        status: 'completed',
        startedAt: '2026-06-10T00:00:00.000Z',
        completedAt: '2026-06-10T00:00:01.000Z',
      },
      {
        turnId: 'recent-turn',
        threadId,
        index: 1,
        userInput: { type: 'text', text: 'recent request' },
        status: 'completed',
        startedAt: '2026-06-10T00:01:00.000Z',
        completedAt: '2026-06-10T00:01:01.000Z',
      },
    ];
    store.items = [
      { id: 'old-user', type: 'user_message', turnId: 'old-turn', text: 'old secret request' },
      { id: 'old-tool', type: 'tool_call', turnId: 'old-turn', toolName: 'read_file', arguments: {}, result: 'OLD_TOOL_OUTPUT_SECRET', status: 'completed' },
      { id: 'recent-user', type: 'user_message', turnId: 'recent-turn', text: 'recent request' },
      { id: 'recent-agent', type: 'agent_message', turnId: 'recent-turn', text: 'recent answer' },
    ];
    store.thread = {
      ...store.thread,
      status: 'compacted',
      tags: {
        compactedSummary: 'Summary keeps the old goal without raw tool output.',
        compactedRanges: JSON.stringify([
          {
            compactedTurnIds: ['old-turn'],
            retainedTurnIds: ['recent-turn'],
            compactionItemId: 'compact-1',
            summary: 'Summary keeps the old goal without raw tool output.',
          },
        ]),
      },
    };
    const model = new MessageCapturingModel();
    const agent = new AgentLoop({
      workspaceRoot: process.cwd(),
      sandbox: { level: 'workspace_write', workspaceRoot: process.cwd() },
      model: model as never,
      store,
    });

    await agent.runTurn(threadId, { type: 'text', text: 'continue' });

    const serialized = JSON.stringify(model.messages[0]);
    expect(serialized).toContain('Summary keeps the old goal');
    expect(serialized).toContain('recent answer');
    expect(serialized).not.toContain('OLD_TOOL_OUTPUT_SECRET');
    expect(serialized).not.toContain('old secret request');
  });

  it('drops oversized retained history before sending the model request after compaction', async () => {
    const threadId = 'thread-oversized-retained-history';
    const hugeRetainedOutput = `HUGE_RETAINED_OUTPUT_${'x'.repeat(200_000)}`;
    const store = new FakeStore(threadId, 'previous-turn');
    store.turns = Array.from({ length: 11 }, (_, index) => ({
      turnId: `turn-${index}`,
      threadId,
      index,
      userInput: { type: 'text', text: `request ${index}` },
      status: 'completed',
      startedAt: `2026-06-10T00:${String(index).padStart(2, '0')}:00.000Z`,
      completedAt: `2026-06-10T00:${String(index).padStart(2, '0')}:01.000Z`,
    }));
    store.items = store.turns.flatMap((turn, index) => [
      { id: `${turn.turnId}-user`, type: 'user_message' as const, turnId: turn.turnId, text: `request ${index}` },
      {
        id: `${turn.turnId}-agent`,
        type: 'agent_message' as const,
        turnId: turn.turnId,
        text: index === 10 ? hugeRetainedOutput : `answer ${index} ${'x'.repeat(2000)}`,
      },
    ]);
    const model = new SummaryAndMessageCapturingModel();
    const agent = new AgentLoop({
      workspaceRoot: process.cwd(),
      sandbox: { level: 'workspace_write', workspaceRoot: process.cwd() },
      model: model as never,
      store,
      runProfile: 'runtime_os',
    });

    const events: ThreadEvent[] = [];
    agent.onEvent((event) => events.push(event));
    await agent.runTurn(threadId, { type: 'text', text: 'continue' });
    const userIndex = events.findIndex((event) => event.type === 'item.completed' && event.item?.type === 'user_message');
    const compactIndex = events.findIndex((event) => event.type === 'thread.compacted.v2' && event.phase === 'started');
    expect(userIndex).toBeGreaterThan(-1);
    expect(compactIndex).toBeGreaterThan(userIndex);

    const serialized = JSON.stringify(model.messages[0]);
    expect(serialized).toContain('旧上下文已压缩');
    expect(serialized).toContain('request 10');
    expect(serialized).not.toContain('HUGE_RETAINED_OUTPUT');
  });

  it('auto-compacts mid-turn before a follow-up model call and hides compacted raw output', async () => {
    const threadId = 'thread-mid-turn-compaction';
    const hugeOutput = `MID_TURN_SECRET_${'x'.repeat(180_000)}`;
    const store = new FakeStore(threadId, 'previous-turn');
    store.turns = Array.from({ length: 7 }, (_, index) => ({
      turnId: `old-turn-${index}`,
      threadId,
      index,
      userInput: { type: 'text', text: `old request ${index}` },
      status: 'completed',
      startedAt: `2026-06-10T00:0${index}:00.000Z`,
      completedAt: `2026-06-10T00:0${index}:01.000Z`,
    }));
    store.items = store.turns.flatMap((turn, index) => [
      { id: `${turn.turnId}-user`, type: 'user_message' as const, turnId: turn.turnId, text: `old request ${index}` },
      { id: `${turn.turnId}-agent`, type: 'agent_message' as const, turnId: turn.turnId, text: `OLD_MID_TURN_RAW_${index} ${'x'.repeat(12_000)}` },
    ]);
    const model = new SequenceToolModel([
      { name: 'huge_output' },
      { name: 'noop_after_compact' },
    ]);
    const agent = new AgentLoop({
      workspaceRoot: process.cwd(),
      sandbox: { level: 'workspace_write', workspaceRoot: process.cwd() },
      model: model as never,
      store,
      tools: createLargeOutputToolRegistry(hugeOutput),
      runProfile: 'runtime_os',
      maxRepeatedToolCalls: 10,
    });
    const events: ThreadEvent[] = [];
    agent.onEvent((event) => events.push(event));

    await agent.runTurn(threadId, { type: 'text', text: 'run huge tool then continue' });

    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'thread.compacted.v2', phase: 'started', trigger: 'auto' }),
      expect.objectContaining({ type: 'thread.compacted.v2', phase: 'completed', trigger: 'auto' }),
    ]));
    const userEventIndex = events.findIndex((event) => event.type === 'item.started' && event.item?.type === 'user_message');
    const compactionEventIndex = events.findIndex((event) => event.type === 'thread.compacted.v2' && event.phase === 'started');
    expect(userEventIndex).toBeGreaterThanOrEqual(0);
    expect(compactionEventIndex).toBeGreaterThan(userEventIndex);
    const compactionEvent = events[compactionEventIndex];
    const userEvent = events[userEventIndex];
    if (compactionEvent?.type === 'thread.compacted.v2' && userEvent?.type === 'item.started') {
      expect(compactionEvent.turnId).toBe(userEvent.turnId);
    }
    const compactionEventIds = events.flatMap((event) => (
      event.type === 'thread.compacted.v2' && event.item ? [event.item.id] : []
    ));
    expect(compactionEventIds).toEqual([
      compactionEventIds[0],
      compactionEventIds[0],
    ]);
    expect(JSON.stringify(store.items.filter((item) => item.type === 'context_compaction'))).toContain('旧上下文已压缩');
    expect(JSON.stringify(model.messages.at(-1))).toContain('旧上下文已压缩');
    expect(JSON.stringify(model.messages.at(-1))).not.toContain('OLD_MID_TURN_RAW_0');
  });
});

describe('AgentLoop usage accounting', () => {
  it('emits and persists thread-level cumulative token usage', async () => {
    const threadId = 'thread-usage';
    const store = new FakeStore(threadId, 'previous-turn');
    const agent = new AgentLoop({
      workspaceRoot: process.cwd(),
      sandbox: { level: 'workspace_write', workspaceRoot: process.cwd() },
      model: new UsageModel() as never,
      store,
    });
    const usageEvents: unknown[] = [];
    agent.onEvent((event) => {
      if (event.type === 'thread.token_usage.updated') usageEvents.push(event);
    });

    await agent.runTurn(threadId, { type: 'text', text: 'first' });
    await agent.runTurn(threadId, { type: 'text', text: 'second' });

    expect(usageEvents.at(-1)).toMatchObject({
      type: 'thread.token_usage.updated',
      threadId,
      usage: {
        total: {
          inputTokens: 22,
          cachedInputTokens: 10,
          outputTokens: 14,
          cacheStrategy: 'deepseek-native',
        },
      },
    });
    expect(JSON.parse(store.thread.tags.threadUsage)).toMatchObject({
      total: {
        inputTokens: 22,
        cachedInputTokens: 10,
        outputTokens: 14,
        cacheStrategy: 'deepseek-native',
      },
    });
  });

  it('aggregates cache reporting as true, false, or unknown without inventing zero hits', async () => {
    const threadId = 'thread-usage-cache-tristate';
    const store = new FakeStore(threadId, 'previous-turn');
    const agent = new AgentLoop({
      workspaceRoot: process.cwd(),
      sandbox: { level: 'workspace_write', workspaceRoot: process.cwd() },
      model: new TriStateUsageModel() as never,
      store,
    });

    await agent.runTurn(threadId, { type: 'text', text: 'unknown cache report' });
    let usage = JSON.parse(store.thread.tags.threadUsage) as { total: { cacheReported?: boolean; cachedInputTokens: number } };
    expect(usage.total.cacheReported).toBeUndefined();
    expect(usage.total.cachedInputTokens).toBe(0);

    await agent.runTurn(threadId, { type: 'text', text: 'mixed cache report' });
    usage = JSON.parse(store.thread.tags.threadUsage) as { total: { cacheReported?: boolean; cachedInputTokens: number } };
    expect(usage.total.cacheReported).toBeUndefined();
    expect(usage.total.cachedInputTokens).toBe(4);

    await agent.runTurn(threadId, { type: 'text', text: 'unreported cache report' });
    usage = JSON.parse(store.thread.tags.threadUsage) as { total: { cacheReported?: boolean; cachedInputTokens: number } };
    expect(usage.total.cacheReported).toBe(false);
    expect(usage.total.cachedInputTokens).toBe(4);
  });

  it('emits soft compaction pressure before automatic compaction is triggered', async () => {
    const threadId = 'thread-soft-pressure';
    const store = new FakeStore(threadId, 'previous-turn');
    store.items = [
      {
        id: 'old-agent',
        type: 'agent_message',
        turnId: 'old-turn',
        text: 'x'.repeat(90_000),
      },
    ];
    const agent = new AgentLoop({
      workspaceRoot: process.cwd(),
      sandbox: { level: 'workspace_write', workspaceRoot: process.cwd() },
      model: new FakeModel() as never,
      store,
    });
    const pressureEvents: unknown[] = [];
    agent.onEvent((event) => {
      if (event.type === 'context.compaction_pressure') pressureEvents.push(event);
    });

    await agent.runTurn(threadId, { type: 'text', text: '继续' });

    expect(pressureEvents).toEqual([
      expect.objectContaining({
        type: 'context.compaction_pressure',
        threadId,
        pressure: expect.objectContaining({
          status: 'soft',
          window: { ordinal: 1, prefillInputTokens: null },
        }),
      }),
    ]);
  });

  it('stores the first server-side input usage as the auto compact window baseline', async () => {
    const stateManager = new ThreadStateManager();
    const threadId = 'thread-usage-window';
    const agent = new AgentLoop({
      workspaceRoot: process.cwd(),
      sandbox: { level: 'workspace_write', workspaceRoot: process.cwd() },
      model: new UsageModel() as never,
      store: new FakeStore(threadId, 'previous-turn'),
    }, stateManager);

    await agent.runTurn(threadId, { type: 'text', text: 'first' });
    await agent.runTurn(threadId, { type: 'text', text: 'second' });

    expect(stateManager.get(threadId).autoCompactWindow).toEqual({
      ordinal: 1,
      prefillInputTokens: 11,
    });
  });

  it('records automatic compaction lifecycle events in stream and run monitor', async () => {
    const threadId = 'thread-hard-compaction-lifecycle';
    const store = new FakeStore(threadId, 'previous-turn');
    store.turns = Array.from({ length: 4 }, (_, index) => ({
      turnId: `old-turn-${index}`,
      threadId,
      index,
      userInput: { type: 'text', text: `old request ${index}` },
      status: 'completed',
      startedAt: `2026-06-10T00:0${index}:00.000Z`,
      completedAt: `2026-06-10T00:0${index}:01.000Z`,
    }));
    store.items = store.turns.flatMap((turn, index) => [
      { id: `${turn.turnId}-user`, type: 'user_message' as const, turnId: turn.turnId, text: `old request ${index}` },
      { id: `${turn.turnId}-agent`, type: 'agent_message' as const, turnId: turn.turnId, text: `old answer ${index} ${'x'.repeat(60_000)}` },
    ]);
    const agent = new AgentLoop({
      workspaceRoot: process.cwd(),
      sandbox: { level: 'workspace_write', workspaceRoot: process.cwd() },
      model: new SummaryAndMessageCapturingModel() as never,
      store,
      runProfile: 'runtime_os',
    });
    const events: ThreadEvent[] = [];
    agent.onEvent((event) => events.push(event));

    await agent.runTurn(threadId, { type: 'text', text: '继续' });

    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'thread.compacted.v2', phase: 'started', trigger: 'auto' }),
      expect.objectContaining({ type: 'thread.compacted.v2', phase: 'completed', trigger: 'auto' }),
    ]));
    const userEvent = events.findIndex((event) => event.type === 'item.started' && event.item?.type === 'user_message');
    const compactEvent = events.findIndex((event) => event.type === 'thread.compacted.v2' && event.phase === 'started');
    expect(userEvent).toBeGreaterThanOrEqual(0);
    expect(compactEvent).toBeGreaterThan(userEvent);

    const runId = String(store.runRecords[0]?.runId);
    await expect(store.listRunEvents(runId)).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'compaction.started', category: 'compaction' }),
      expect.objectContaining({ type: 'compaction.completed', category: 'compaction' }),
    ]));
  });

  it('terminates the same turn with a visible error if pre-turn compaction fails', async () => {
    const threadId = 'thread-compaction-failure';
    const store = new FakeStore(threadId, 'previous-turn');
    store.turns = Array.from({ length: 4 }, (_, index) => ({
      turnId: `old-turn-${index}`, threadId, index,
      userInput: { type: 'text', text: `old request ${index}` },
      status: 'completed', startedAt: '2026-06-10T00:00:00.000Z', completedAt: '2026-06-10T00:00:01.000Z',
    }));
    store.items = store.turns.flatMap((turn) => [
      { id: `${turn.turnId}-user`, type: 'user_message' as const, turnId: turn.turnId, text: 'old request' },
      { id: `${turn.turnId}-agent`, type: 'agent_message' as const, turnId: turn.turnId, text: 'x'.repeat(60_000) },
    ]);
    const hooks = new LocalHookRegistry();
    hooks.on('pre_compact', () => { throw new Error('compaction interrupted'); });
    const agent = new AgentLoop({
      workspaceRoot: process.cwd(), sandbox: { level: 'workspace_write', workspaceRoot: process.cwd() },
      model: new SummaryAndMessageCapturingModel() as never, store, hooks, runProfile: 'runtime_os',
    });
    const events: ThreadEvent[] = [];
    agent.onEvent((event) => events.push(event));

    await expect(agent.runTurn(threadId, { type: 'text', text: '继续' })).rejects.toThrow('compaction interrupted');
    const currentTurn = store.savedTurns.at(-1);
    expect(currentTurn?.status).toBe('failed');
    expect(store.checkpoint?.status).toBe('failed');
    expect(store.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'user_message', turnId: currentTurn?.turnId }),
      expect.objectContaining({ type: 'error', turnId: currentTurn?.turnId, message: 'compaction interrupted' }),
    ]));
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'thread.compacted.v2', phase: 'failed', turnId: currentTurn?.turnId }),
      expect.objectContaining({ type: 'turn.failed', turnId: currentTurn?.turnId }),
    ]));
  });

  it('does not emit automatic compaction events for raw items from already compacted turns', async () => {
    const threadId = 'thread-already-compacted-pressure';
    const store = new FakeStore(threadId, 'previous-turn');
    store.thread.status = 'compacted';
    store.thread.tags = {
      compactedSummary: '当前进度：旧上下文已压缩。',
      compactedRanges: JSON.stringify([
        {
          compactedTurnIds: ['old-turn-0', 'old-turn-1'],
          retainedTurnIds: ['old-turn-2', 'old-turn-3', 'old-turn-4'],
          compactionItemId: 'compact-existing',
          summary: '当前进度：旧上下文已压缩。',
          tokensBefore: 120000,
          tokensAfter: 120,
          createdAt: '2026-06-10T00:05:00.000Z',
          trigger: 'auto',
          strategy: 'llm',
        },
      ]),
    };
    store.turns = Array.from({ length: 5 }, (_, index) => ({
      turnId: `old-turn-${index}`,
      threadId,
      index,
      userInput: { type: 'text', text: `old request ${index}` },
      status: 'completed',
      startedAt: `2026-06-10T00:0${index}:00.000Z`,
      completedAt: `2026-06-10T00:0${index}:01.000Z`,
    }));
    store.items = store.turns.flatMap((turn, index) => [
      { id: `${turn.turnId}-user`, type: 'user_message' as const, turnId: turn.turnId, text: `old request ${index}` },
      { id: `${turn.turnId}-agent`, type: 'agent_message' as const, turnId: turn.turnId, text: `old answer ${index} ${'x'.repeat(index < 2 ? 90_000 : 100)}` },
    ]);
    const agent = new AgentLoop({
      workspaceRoot: process.cwd(),
      sandbox: { level: 'workspace_write', workspaceRoot: process.cwd() },
      model: new FakeModel() as never,
      store,
      runProfile: 'runtime_os',
    });
    const events: ThreadEvent[] = [];
    agent.onEvent((event) => events.push(event));

    await agent.runTurn(threadId, { type: 'text', text: '继续' });

    expect(events.some((event) => event.type === 'thread.compacted.v2')).toBe(false);
  });
});

describe('AgentLoop rollbackThread', () => {
  it('rejects count 0 through the runtime rollback boundary and audits the failure', async () => {
    const threadId = 'thread-runtime-rollback-zero';
    const store = new FakeStore(threadId, 'previous-turn');
    const agent = new AgentLoop({
      workspaceRoot: process.cwd(),
      sandbox: { level: 'workspace_write', workspaceRoot: process.cwd() },
      model: new FakeModel() as never,
      store,
    });
    const events: ThreadEvent[] = [];
    agent.onEvent((event) => events.push(event));

    await expect(agent.rollbackThread(threadId, 0)).rejects.toThrow(/count/i);

    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'thread.rollback.failed', threadId }),
    ]));
    expect(store.runEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({ category: 'rollback', type: 'rollback.failed' }),
    ]));
  });

  it('rejects rollback while a turn is running', async () => {
    const threadId = 'thread-runtime-rollback-running';
    const store = new FakeStore(threadId, 'previous-turn');
    const model = new BlockingModel();
    const agent = new AgentLoop({
      workspaceRoot: process.cwd(),
      sandbox: { level: 'workspace_write', workspaceRoot: process.cwd() },
      model: model as never,
      store,
    });
    const run = agent.runTurn(threadId, { type: 'text', text: 'block' });
    await model.waitUntilStreaming();

    await expect(agent.rollbackThread(threadId, 1)).rejects.toThrow(/running/i);
    model.release();
    await run;
  });

  it('rejects a second rollback while one is pending', async () => {
    const threadId = 'thread-runtime-rollback-pending';
    const store = new FakeStore(threadId, 'previous-turn');
    const stateManager = new ThreadStateManager();
    stateManager.beginRollback(threadId, 'request-a');
    const agent = new AgentLoop({
      workspaceRoot: process.cwd(),
      sandbox: { level: 'workspace_write', workspaceRoot: process.cwd() },
      model: new FakeModel() as never,
      store,
    }, stateManager);

    await expect(agent.rollbackThread(threadId, 1)).rejects.toThrow(/pending/i);
  });
});

describe('AgentLoop run profiles', () => {
  it('uses one unified compaction policy instead of two run profiles', () => {
    // 多运行状态已舍弃：两档 profile 现在产出同一套压缩策略。
    expect(compactionOptionsForRunProfile('runtime_os')).toMatchObject({
      softCompactRatio: 0.5,
      hardCompactRatio: 0.8,
      strategy: 'llm',
    });
    expect(compactionOptionsForRunProfile('cache_first')).toEqual(
      compactionOptionsForRunProfile('runtime_os'),
    );
  });
});

describe('AgentLoop web search tool policy', () => {
  it('keeps web_search schema stable for auto/on modes and hides it only when disabled', async () => {
    const offModel = new ToolListModel();
    const offAgent = new AgentLoop({
      workspaceRoot: process.cwd(),
      sandbox: { level: 'workspace_write', workspaceRoot: process.cwd() },
      model: offModel as never,
      store: new FakeStore('thread-web-search-off', 'previous-turn'),
      webSearchMode: 'off',
    });
    await offAgent.runTurn('thread-web-search-off', {
      type: 'text',
      text: '联网搜索 LangChain 最新版本',
    });
    expect(offModel.toolNames[0]).not.toContain('web_search');
    expect(offModel.toolNames[0]).not.toContain('web_fetch');

    const onModel = new ToolListModel();
    const onAgent = new AgentLoop({
      workspaceRoot: process.cwd(),
      sandbox: { level: 'workspace_write', workspaceRoot: process.cwd() },
      model: onModel as never,
      store: new FakeStore('thread-web-search-on', 'previous-turn'),
      webSearchMode: 'on',
    });
    await onAgent.runTurn('thread-web-search-on', {
      type: 'text',
      text: '普通问题',
    });
    expect(onModel.toolNames[0]).toContain('web_search');
    expect(onModel.toolNames[0]).not.toContain('web_fetch');
    const onWebSearchTool = onModel.tools[0].find((tool) => tool.function.name === 'web_search');
    const webActionEnum = onWebSearchTool?.function.parameters.properties?.action?.enum;
    expect(webActionEnum).toContain('open_page');
    expect(webActionEnum).toContain('find_in_page');

    const autoLocalModel = new ToolListModel();
    const autoLocalAgent = new AgentLoop({
      workspaceRoot: process.cwd(),
      sandbox: { level: 'workspace_write', workspaceRoot: process.cwd() },
      model: autoLocalModel as never,
      store: new FakeStore('thread-web-search-auto-local', 'previous-turn'),
      webSearchMode: 'auto',
    });
    await autoLocalAgent.runTurn('thread-web-search-auto-local', {
      type: 'text',
      text: '检查本地文件',
    });
    expect(autoLocalModel.toolNames[0]).toContain('web_search');
    expect(autoLocalModel.toolNames[0]).not.toContain('web_fetch');

    const autoModel = new ToolListModel();
    const autoAgent = new AgentLoop({
      workspaceRoot: process.cwd(),
      sandbox: { level: 'workspace_write', workspaceRoot: process.cwd() },
      model: autoModel as never,
      store: new FakeStore('thread-web-search-auto', 'previous-turn'),
      webSearchMode: 'auto',
    });
    await autoAgent.runTurn('thread-web-search-auto', {
      type: 'text',
      text: '联网搜索 LangChain 最新版本',
    });
    expect(autoModel.toolNames[0]).toContain('web_search');
    expect(autoModel.toolNames[0]).not.toContain('web_fetch');
  });

  it('disables web_search after repeated searches so the turn can converge', async () => {
    const model = new RepeatingWebSearchModel();
    const registry = new ToolRegistry();
    let executedSearches = 0;
    registry.register({
      name: 'web_search',
      description: 'fake web search',
      parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
      requiredPolicy: 'readonly',
      async execute() {
        executedSearches += 1;
        return { output: 'result', status: 'completed' };
      },
    } satisfies ToolDefinition);

    const store = new FakeStore('thread-web-search-budget', 'previous-turn');
    const agent = new AgentLoop({
      workspaceRoot: process.cwd(),
      sandbox: { level: 'workspace_write', workspaceRoot: process.cwd() },
      model: model as never,
      store,
      tools: registry,
      webSearchMode: 'on',
      maxIterations: 20,
    });

    await agent.runTurn('thread-web-search-budget', {
      type: 'text',
      text: 'https://example.com 看看有什么内容',
    });

    expect(executedSearches).toBe(2);
    expect(model.toolNames.at(-1)).not.toContain('web_search');
    expect(store.items.some((item) =>
      item.type === 'tool_call' &&
      item.toolName === 'web_search' &&
      item.status === 'failed' &&
      JSON.stringify(item.result).includes('重复搜索'),
    )).toBe(true);
    expect(store.items.some((item) => item.type === 'agent_message' && item.text === 'final')).toBe(true);
  });
});

describe('AgentLoop collaboration tools', () => {
  it('creates parent and spawned child threads with the configured tenant id', async () => {
    const parentThread = createThread('thread-parent-tenant', 'parent');
    const store = new MultiThreadStore(parentThread);
    const agent = new AgentLoop({
      workspaceRoot: process.cwd(),
      sandbox: { level: 'workspace_write', workspaceRoot: process.cwd() },
      model: new CollabCommandModel('spawn_agent', { prompt: 'do tenant work', agentRole: 'worker' }) as never,
      store,
      tenantId: 'tenant-runtime-a',
    });

    const started = await agent.startThread('tenant parent');
    await agent.runTurn(parentThread.threadId, { type: 'text', text: 'spawn tenant child' });

    const child = [...store.threads.values()].find((thread) => thread.parentThreadId === parentThread.threadId);
    expect(started).toMatchObject({ tenantId: 'tenant-runtime-a' });
    expect(store.threads.get(started.threadId)).toMatchObject({ tenantId: 'tenant-runtime-a' });
    expect(child).toMatchObject({ tenantId: 'tenant-runtime-a' });
    expect(store.edges.find((edge) => edge.childThreadId === child?.threadId)).toMatchObject({
      tenantId: 'tenant-runtime-a',
    });
  });

  it('spawns a child thread, records collab tool calls, and waits for the child result', async () => {
    const now = new Date().toISOString();
    const parentThread: ThreadMeta = {
      threadId: 'thread-parent-collab',
      title: 'parent',
      workspaceRoot: process.cwd(),
      status: 'active',
      turnCount: 0,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      ephemeral: false,
      tags: {},
    };
    const store = new MultiThreadStore(parentThread);
    const agent = new AgentLoop({
      workspaceRoot: process.cwd(),
      sandbox: { level: 'workspace_write', workspaceRoot: process.cwd() },
      model: new CollabModel() as never,
      store,
      locale: 'zh',
    });
    const events: Array<{ type: string; threadId?: string; childThreadId?: string; event?: { type?: string } }> = [];
    agent.onEvent((event) => events.push(event as never));

    await agent.runTurn(parentThread.threadId, { type: 'text', text: '派一个子 agent 检查项目' });

    const child = [...store.threads.values()].find((thread) => thread.parentThreadId === parentThread.threadId);
    expect(child).toMatchObject({
      agentNickname: 'worker',
      agentRole: 'reviewer',
    });
    expect(store.edges).toEqual([
      expect.objectContaining({
        parentThreadId: parentThread.threadId,
        childThreadId: child?.threadId,
        status: 'open',
      }),
    ]);
    expect(store.items.get(parentThread.threadId)?.filter((item) => item.type === 'collab_tool_call')).toEqual([
      expect.objectContaining({
        tool: 'spawn_agent',
        status: 'completed',
        newThreadId: child?.threadId,
        result: expect.objectContaining({
          envelope: expect.objectContaining({
            schemaVersion: 1,
            senderThreadId: parentThread.threadId,
            receiverThreadId: child?.threadId,
            task: 'inspect package',
            locale: 'zh',
            webSearchMode: 'auto',
            permissions: expect.objectContaining({ level: 'workspace_write' }),
            constraints: expect.arrayContaining([
              expect.objectContaining({ layer: 'parent_delegation' }),
              expect.objectContaining({ layer: 'subagent_role' }),
            ]),
          }),
        }),
      }),
      expect.objectContaining({ tool: 'wait', status: 'completed', receiverThreadId: child?.threadId }),
    ]);
    expect((store.items.get(child!.threadId) ?? []).some((item) => item.type === 'agent_message' && item.text === 'child done')).toBe(true);
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'child_agent.event',
        threadId: parentThread.threadId,
        childThreadId: child?.threadId,
        event: expect.objectContaining({ type: 'item.completed' }),
      }),
    ]));
    expect(store.items.get(parentThread.threadId)?.at(-1)).toMatchObject({
      type: 'agent_message',
      text: 'parent done',
    });
  });

  it('passes runtime middleware, dynamic context provider, and stability limits to child agents', async () => {
    const parentThread = createThread('thread-parent-inherit-runtime');
    const store = new MultiThreadStore(parentThread);
    let childBeforeModelCalls = 0;
    let childSawProviderContext = false;
    const runtimeMiddleware: RuntimeMiddleware = {
      beforeModel: async (ctx, request) => {
        if (ctx.thread.parentThreadId === parentThread.threadId) {
          childBeforeModelCalls += 1;
          childSawProviderContext ||= JSON.stringify(request.messages).includes('provider inherited marker');
        }
      },
    };
    const agent = new AgentLoop({
      workspaceRoot: process.cwd(),
      sandbox: { level: 'workspace_write', workspaceRoot: process.cwd() },
      model: new SpawnThenChildRepeatsModel() as never,
      store,
      runtimeMiddleware: [runtimeMiddleware],
      dynamicContextProvider: async () => 'provider inherited marker',
      maxRepeatedToolCalls: 1,
    });

    await agent.runTurn(parentThread.threadId, { type: 'text', text: 'spawn child with inherited runtime' });

    const child = [...store.threads.values()].find((thread) => thread.parentThreadId === parentThread.threadId);
    const childItems = child ? store.items.get(child.threadId) ?? [] : [];
    expect(childBeforeModelCalls).toBeGreaterThan(0);
    expect(childSawProviderContext).toBe(true);
    expect(childItems).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'tool_call',
        status: 'failed',
        error: expect.objectContaining({ code: 'TOOL_LOOP_DETECTED' }),
      }),
      expect.objectContaining({
        type: 'agent_message',
      }),
    ]));
  });

  it('rejects spawn_agent when open child descendants reach maxSubagents', async () => {
    const parentThread = createThread('thread-parent-open-limit');
    const openChild = { ...createThread('thread-open-child'), parentThreadId: parentThread.threadId };
    const store = new MultiThreadStore(parentThread);
    await store.createThread(openChild);
    await store.upsertThreadSpawnEdge({
      parentThreadId: parentThread.threadId,
      childThreadId: openChild.threadId,
      status: 'open',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    const agent = new AgentLoop({
      workspaceRoot: process.cwd(),
      sandbox: { level: 'workspace_write', workspaceRoot: process.cwd() },
      model: new CollabCommandModel('spawn_agent', { prompt: 'inspect package' }) as never,
      store,
      maxSubagents: 1,
    });

    await agent.runTurn(parentThread.threadId, { type: 'text', text: 'spawn over limit' });

    expect([...store.threads.values()].filter((thread) => thread.parentThreadId === parentThread.threadId)).toHaveLength(1);
    expect(store.items.get(parentThread.threadId)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'collab_tool_call',
        tool: 'spawn_agent',
        status: 'failed',
        error: expect.objectContaining({ code: 'SUBAGENT_LIMIT_REACHED' }),
      }),
    ]));
  });

  it('does not count closed child edges against maxSubagents', async () => {
    const parentThread = createThread('thread-parent-closed-limit');
    const closedChild = { ...createThread('thread-closed-child'), parentThreadId: parentThread.threadId };
    const store = new MultiThreadStore(parentThread);
    await store.createThread(closedChild);
    await store.upsertThreadSpawnEdge({
      parentThreadId: parentThread.threadId,
      childThreadId: closedChild.threadId,
      status: 'closed',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    const agent = new AgentLoop({
      workspaceRoot: process.cwd(),
      sandbox: { level: 'workspace_write', workspaceRoot: process.cwd() },
      model: new CollabCommandModel('spawn_agent', { prompt: 'inspect package' }, { 'inspect package': 'new child done' }) as never,
      store,
      maxSubagents: 1,
    });

    await agent.runTurn(parentThread.threadId, { type: 'text', text: 'spawn after closed child' });

    const children = [...store.threads.values()].filter((thread) => thread.parentThreadId === parentThread.threadId);
    expect(children).toHaveLength(2);
    expect(store.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ childThreadId: closedChild.threadId, status: 'closed' }),
      expect.objectContaining({ parentThreadId: parentThread.threadId, status: 'open' }),
    ]));
    expect(store.items.get(parentThread.threadId)).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'collab_tool_call', tool: 'spawn_agent', status: 'completed' }),
    ]));
  });

  it('send_input starts a new child turn and records the delegated prompt', async () => {
    const parent = createThread('thread-parent-send', 'parent');
    const child = {
      ...createThread('thread-child-send', 'child'),
      parentThreadId: parent.threadId,
      agentRole: 'reviewer',
      agentNickname: 'worker',
    };
    const store = new MultiThreadStore(parent);
    await store.createThread(child);
    await store.upsertThreadSpawnEdge({
      parentThreadId: parent.threadId,
      childThreadId: child.threadId,
      status: 'open',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    const agent = new AgentLoop({
      workspaceRoot: process.cwd(),
      sandbox: { level: 'workspace_write', workspaceRoot: process.cwd() },
      model: new CollabCommandModel('send_input', {
        threadId: child.threadId,
        prompt: 'follow up',
      }, { 'follow up': 'child followup done' }) as never,
      store,
      locale: 'zh',
    });

    await agent.runTurn(parent.threadId, { type: 'text', text: '继续子 agent' });

    const childTurn = store.turns.get(child.threadId)?.at(-1);
    expect(childTurn).toMatchObject({
      threadId: child.threadId,
      userInput: { type: 'text', text: 'follow up' },
    });
    expect(['running', 'completed']).toContain(childTurn?.status);
    expect(store.items.get(child.threadId)?.some((item) => (
      item.type === 'user_message' && item.text === 'follow up'
    ))).toBe(true);
    expect(store.items.get(parent.threadId)?.find((item) => item.type === 'collab_tool_call')).toMatchObject({
      tool: 'send_input',
      status: 'completed',
      receiverThreadId: child.threadId,
      prompt: 'follow up',
      agentStatus: 'running',
    });
  });

  it('list_agents returns persisted child agents with runtime status after restart', async () => {
    const parent = createThread('thread-parent-list-agents', 'parent');
    const child = {
      ...createThread('thread-child-listed', 'child'),
      parentThreadId: parent.threadId,
      agentRole: 'reviewer',
      agentNickname: 'worker',
    };
    const store = new MultiThreadStore(parent);
    await store.createThread(child);
    await store.saveTurn({
      turnId: 'child-turn-listed',
      threadId: child.threadId,
      index: 0,
      userInput: { type: 'text', text: 'previous work' },
      status: 'completed',
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
    });
    await store.upsertThreadSpawnEdge({
      parentThreadId: parent.threadId,
      childThreadId: child.threadId,
      status: 'open',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    const agent = new AgentLoop({
      workspaceRoot: process.cwd(),
      sandbox: { level: 'workspace_write', workspaceRoot: process.cwd() },
      model: new CollabCommandModel('list_agents', {}) as never,
      store,
    });

    await agent.runTurn(parent.threadId, { type: 'text', text: '列出子 agent' });

    expect(store.items.get(parent.threadId)?.find((item) => item.type === 'collab_tool_call')).toMatchObject({
      tool: 'list_agents',
      status: 'completed',
      result: {
        agents: [
          expect.objectContaining({
            threadId: child.threadId,
            agentRole: 'reviewer',
            agentNickname: 'worker',
            edgeStatus: 'open',
            status: 'completed',
          }),
        ],
      },
    });
  });

  it('send_message queues child input without starting a child turn', async () => {
    const parent = createThread('thread-parent-send-message', 'parent');
    const child = {
      ...createThread('thread-child-send-message', 'child'),
      parentThreadId: parent.threadId,
      agentRole: 'researcher',
      agentNickname: 'worker',
      tags: {},
    };
    const store = new MultiThreadStore(parent);
    await store.createThread(child);
    await store.upsertThreadSpawnEdge({
      parentThreadId: parent.threadId,
      childThreadId: child.threadId,
      status: 'open',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    const agent = new AgentLoop({
      workspaceRoot: process.cwd(),
      sandbox: { level: 'workspace_write', workspaceRoot: process.cwd() },
      model: new CollabCommandModel('send_message', { target: child.threadId, message: 'queued only' }) as never,
      store,
    });

    await agent.runTurn(parent.threadId, { type: 'text', text: 'queue child mail' });

    expect(store.turns.get(child.threadId) ?? []).toHaveLength(0);
    expect(JSON.parse(store.threads.get(child.threadId)?.tags.agentMailbox ?? '[]')).toEqual([
      expect.objectContaining({ content: 'queued only', triggerTurn: false }),
    ]);
    expect(store.items.get(parent.threadId)?.find((item) => item.type === 'collab_tool_call')).toMatchObject({
      tool: 'send_message',
      status: 'completed',
      receiverThreadId: child.threadId,
      agentStatus: 'open',
    });
  });

  it('followup_task queues child input and starts a child turn', async () => {
    const parent = createThread('thread-parent-followup-task', 'parent');
    const child = {
      ...createThread('thread-child-followup-task', 'child'),
      parentThreadId: parent.threadId,
      agentRole: 'implementer',
      agentNickname: 'worker',
      tags: {},
    };
    const store = new MultiThreadStore(parent);
    await store.createThread(child);
    await store.upsertThreadSpawnEdge({
      parentThreadId: parent.threadId,
      childThreadId: child.threadId,
      status: 'open',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    const agent = new AgentLoop({
      workspaceRoot: process.cwd(),
      sandbox: { level: 'workspace_write', workspaceRoot: process.cwd() },
      model: new CollabCommandModel('followup_task', { target: child.threadId, message: 'run followup' }, {
        'run followup': 'child followup done',
      }) as never,
      store,
    });

    await agent.runTurn(parent.threadId, { type: 'text', text: 'wake child' });

    expect(store.turns.get(child.threadId)?.at(-1)).toMatchObject({
      threadId: child.threadId,
      userInput: { type: 'text', text: 'run followup' },
    });
    expect(JSON.parse(store.threads.get(child.threadId)?.tags.agentMailbox ?? '[]')).toEqual([
      expect.objectContaining({ content: 'run followup', triggerTurn: true }),
    ]);
    expect(store.items.get(parent.threadId)?.find((item) => item.type === 'collab_tool_call')).toMatchObject({
      tool: 'followup_task',
      status: 'completed',
      receiverThreadId: child.threadId,
      agentStatus: 'running',
    });
  });

  it('rejects spawn_agent when child depth would exceed maxSubagentDepth', async () => {
    const parent = createThread('thread-depth-root', 'parent');
    const child = { ...createThread('thread-depth-child', 'child'), parentThreadId: parent.threadId };
    const store = new MultiThreadStore(parent);
    await store.createThread(child);
    const agent = new AgentLoop({
      workspaceRoot: process.cwd(),
      sandbox: { level: 'workspace_write', workspaceRoot: process.cwd() },
      model: new CollabCommandModel('spawn_agent', { prompt: 'too deep' }) as never,
      store,
      maxSubagentDepth: 1,
    });

    await agent.runTurn(child.threadId, { type: 'text', text: 'spawn grandchild' });

    expect([...store.threads.values()].filter((thread) => thread.parentThreadId === child.threadId)).toHaveLength(0);
    expect(store.items.get(child.threadId)?.find((item) => item.type === 'collab_tool_call')).toMatchObject({
      tool: 'spawn_agent',
      status: 'failed',
      error: expect.objectContaining({ code: 'SUBAGENT_DEPTH_LIMIT_REACHED' }),
    });
  });

  it('applies configured agent role profile instructions, skills, and tool filters to child agents', async () => {
    const parent = createThread('thread-parent-role-profile', 'parent');
    const store = new MultiThreadStore(parent);
    const skills = new LocalSkillRegistry();
    skills.register({
      name: 'code-review',
      description: 'Review code changes.',
      body: 'Review code changes.',
      sourcePath: 'code-review/SKILL.md',
    });
    skills.register({
      name: 'frontend-design',
      description: 'Design frontend screens.',
      body: 'Design frontend screens.',
      sourcePath: 'frontend-design/SKILL.md',
    });
    const tools = new ToolRegistry();
    tools.register({
      name: 'current_time',
      description: 'Get time.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      execute: async () => ({ status: 'completed' as const, output: 'now' }),
      requiredPolicy: 'readonly',
      requiresApproval: false,
    });
    tools.register({
      name: 'shell_command',
      description: 'Run shell.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      execute: async () => ({ status: 'completed' as const, output: 'shell' }),
      requiredPolicy: 'workspace_write',
      requiresApproval: false,
    });
    const model = new RoleProfileCaptureModel({
      prompt: 'profile child work',
      agent_type: 'reviewer',
    }, {
      'profile child work': 'role child done',
    });
    const agent = new AgentLoop({
      workspaceRoot: process.cwd(),
      sandbox: { level: 'workspace_write', workspaceRoot: process.cwd() },
      model: model as never,
      store,
      tools,
      skills,
      agentRoles: {
        reviewer: {
          description: 'Review-only subagent.',
          instructions: 'Only review the delegated code and report risks.',
          allowedSkills: ['code-review'],
          allowedTools: ['current_time'],
        },
      },
    });

    await agent.runTurn(parent.threadId, { type: 'text', text: 'spawn role-profile child' });

    await waitForCondition(() => model.calls.some((call) => (
      call.messages.some((message) => message.role === 'user' && message.content === 'profile child work')
    )));
    const childCall = model.calls.find((call) => (
      call.messages.some((message) => message.role === 'user' && message.content === 'profile child work')
    ));
    const systemPrompt = String(childCall?.messages.find((message) => message.role === 'system')?.content ?? '');
    expect(systemPrompt).toContain('Agent Role Profile: reviewer');
    expect(systemPrompt).toContain('Only review the delegated code and report risks.');
    expect(systemPrompt).toContain('code-review');
    expect(systemPrompt).not.toContain('frontend-design');
    expect(childCall?.tools.map((tool) => tool.function.name)).toEqual(['current_time']);

    const child = [...store.threads.values()].find((thread) => thread.parentThreadId === parent.threadId);
    expect(child).toMatchObject({
      agentRole: 'reviewer',
      agentNickname: 'reviewer',
      tags: expect.objectContaining({
        agentRoleProfile: 'reviewer',
      }),
    });
  });

  it('rejects unknown agent_type before creating a child thread', async () => {
    const parent = createThread('thread-parent-unknown-role', 'parent');
    const store = new MultiThreadStore(parent);
    const agent = new AgentLoop({
      workspaceRoot: process.cwd(),
      sandbox: { level: 'workspace_write', workspaceRoot: process.cwd() },
      model: new CollabCommandModel('spawn_agent', { prompt: 'unknown role work', agent_type: 'missing-role' }) as never,
      store,
    });

    await agent.runTurn(parent.threadId, { type: 'text', text: 'spawn unknown role' });

    expect([...store.threads.values()].filter((thread) => thread.parentThreadId === parent.threadId)).toHaveLength(0);
    expect(store.items.get(parent.threadId)?.find((item) => item.type === 'collab_tool_call')).toMatchObject({
      tool: 'spawn_agent',
      status: 'failed',
      error: expect.objectContaining({ code: 'UNKNOWN_AGENT_ROLE' }),
    });
  });

  it('inherits the parent model even when spawn args request model and reasoning overrides', async () => {
    const parent = createThread('thread-parent-spawn-overrides', 'parent');
    const store = new MultiThreadStore(parent);
    const model = new CollabCommandModel('spawn_agent', {
      prompt: 'override work',
      agentRole: 'researcher',
      model: 'fast-model',
      reasoningEffort: 'low',
    }, { 'override work': 'override child done' });
    const factoryCalls: Array<{ model?: string; reasoningEffort?: string }> = [];
    const agent = new AgentLoop({
      workspaceRoot: process.cwd(),
      sandbox: { level: 'workspace_write', workspaceRoot: process.cwd() },
      model: model as never,
      store,
      spawnModelFactory: (override) => {
        factoryCalls.push(override);
        return new CollabCommandModel('noop', {}, { 'override work': 'wrong model used' }) as never;
      },
    });

    await agent.runTurn(parent.threadId, { type: 'text', text: 'spawn override child' });

    const child = [...store.threads.values()].find((thread) => thread.parentThreadId === parent.threadId);
    await waitForCondition(() => Boolean(child && store.items.get(child.threadId)?.some((item) => (
      item.type === 'agent_message' && item.text === 'override child done'
    ))));
    expect(factoryCalls).toEqual([]);
    expect(child?.tags).toMatchObject({
      agentRequestedModel: 'fast-model',
      agentModelInherited: 'true',
      agentReasoningEffort: 'low',
    });
    expect(store.items.get(child!.threadId)).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'agent_message', text: 'override child done' }),
    ]));
  });

  it('close_agent closes the edge and persists an interrupted running child turn', async () => {
    const parent = createThread('thread-parent-close', 'parent');
    const child = {
      ...createThread('thread-child-close', 'child'),
      parentThreadId: parent.threadId,
      turnCount: 1,
    };
    const runningTurn: TurnMeta = {
      turnId: 'child-running-turn',
      threadId: child.threadId,
      index: 0,
      userInput: { type: 'text', text: 'long child work' },
      status: 'running',
      startedAt: new Date().toISOString(),
      completedAt: null,
    };
    const store = new MultiThreadStore(parent);
    await store.createThread(child);
    await store.saveTurn(runningTurn);
    await store.appendCheckpoint(child.threadId, {
      threadId: child.threadId,
      turnId: runningTurn.turnId,
      itemIndex: 0,
      timestamp: new Date().toISOString(),
      status: 'running',
    });
    await store.upsertThreadSpawnEdge({
      parentThreadId: parent.threadId,
      childThreadId: child.threadId,
      status: 'open',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    const stateManager = new ThreadStateManager();
    stateManager.startTurn(child.threadId, runningTurn.turnId);
    const agent = new AgentLoop(
      {
        workspaceRoot: process.cwd(),
        sandbox: { level: 'workspace_write', workspaceRoot: process.cwd() },
        model: new CollabCommandModel('close_agent', { threadId: child.threadId }) as never,
        store,
      },
      stateManager,
    );

    await agent.runTurn(parent.threadId, { type: 'text', text: '关闭子 agent' });

    expect(store.edges[0]).toMatchObject({ childThreadId: child.threadId, status: 'closed' });
    expect(store.turns.get(child.threadId)?.[0]).toMatchObject({
      turnId: runningTurn.turnId,
      status: 'interrupted',
    });
    expect(store.checkpoints.get(child.threadId)).toMatchObject({
      threadId: child.threadId,
      turnId: runningTurn.turnId,
      status: 'interrupted',
    });
    expect(stateManager.isRunning(child.threadId)).toBe(false);
  });

  it('resume_agent reconnects an open child running checkpoint into runtime state', async () => {
    const parent = createThread('thread-parent-resume-agent', 'parent');
    const child = {
      ...createThread('thread-child-resume-agent', 'child'),
      parentThreadId: parent.threadId,
      agentRole: 'researcher',
      agentNickname: 'worker',
      turnCount: 1,
    };
    const runningTurn: TurnMeta = {
      turnId: 'child-resumable-turn',
      threadId: child.threadId,
      index: 0,
      userInput: { type: 'text', text: 'resumable child work' },
      status: 'running',
      startedAt: new Date().toISOString(),
      completedAt: null,
    };
    const checkpoint: Checkpoint = {
      threadId: child.threadId,
      turnId: runningTurn.turnId,
      itemIndex: 2,
      timestamp: new Date().toISOString(),
      status: 'running',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    const store = new MultiThreadStore(parent);
    await store.createThread(child);
    await store.saveTurn(runningTurn);
    await store.appendCheckpoint(child.threadId, checkpoint);
    await store.upsertThreadSpawnEdge({
      parentThreadId: parent.threadId,
      childThreadId: child.threadId,
      status: 'open',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    const stateManager = new ThreadStateManager();
    const agent = new AgentLoop(
      {
        workspaceRoot: process.cwd(),
        sandbox: { level: 'workspace_write', workspaceRoot: process.cwd() },
        model: new CollabCommandModel('resume_agent', { threadId: child.threadId }) as never,
        store,
      },
      stateManager,
    );

    await agent.runTurn(parent.threadId, { type: 'text', text: '恢复子 agent' });

    expect(stateManager.get(child.threadId).lastCheckpoint).toMatchObject(checkpoint);
    expect(store.items.get(parent.threadId)?.find((item) => item.type === 'collab_tool_call')).toMatchObject({
      tool: 'resume_agent',
      status: 'completed',
      receiverThreadId: child.threadId,
      agentStatus: 'running',
      result: expect.objectContaining({
        childThreadId: child.threadId,
        status: 'running',
        resumable: true,
      }),
    });
  });
});

describe('AgentLoop episode memory mode', () => {
  it('does not create episodes or working sets when mode is disabled', async () => {
    const threadId = 'thread-episode-mode-disabled';
    const store = new FakeStore(threadId, 'previous-turn');
    store.thread.tags = { episodeMemoryMode: 'disabled' };
    const model = new MessageCapturingModel();

    const agent = new AgentLoop({
      workspaceRoot: process.cwd(),
      sandbox: { level: 'workspace_write', workspaceRoot: process.cwd() },
      model: model as never,
      store,
    });

    await agent.runTurn(threadId, { type: 'text', text: 'do something' });

    expect(store.episodeRecords).toEqual([]);
    expect(store.workingSets.get(threadId)).toBeUndefined();
    expect(store.runEvents.some((e) => e.type === 'episode.mode.disabled')).toBe(true);
  });

  it('does not inject or update episodes when mode is polluted', async () => {
    const threadId = 'thread-episode-mode-polluted';
    const store = new FakeStore(threadId, 'previous-turn');
    store.thread.tags = { episodeMemoryMode: 'polluted' };
    const model = new MessageCapturingModel();

    const agent = new AgentLoop({
      workspaceRoot: process.cwd(),
      sandbox: { level: 'workspace_write', workspaceRoot: process.cwd() },
      model: model as never,
      store,
    });

    await agent.runTurn(threadId, { type: 'text', text: 'do something' });

    expect(store.episodeRecords).toEqual([]);
    expect(store.workingSets.get(threadId)).toBeUndefined();
    expect(store.runEvents.some((e) => e.type === 'episode.mode.polluted')).toBe(true);
  });

  it('creates an open episode and working set when mode is enabled', async () => {
    const threadId = 'thread-episode-mode-enabled';
    const store = new FakeStore(threadId, 'previous-turn');
    const model = new MessageCapturingModel();

    const agent = new AgentLoop({
      workspaceRoot: process.cwd(),
      sandbox: { level: 'workspace_write', workspaceRoot: process.cwd() },
      model: model as never,
      store,
    });

    await agent.runTurn(threadId, { type: 'text', text: 'do something' });

    expect(store.episodeRecords.length).toBeGreaterThan(0);
    expect(store.episodeRecords[0].lifecycle).toBe('open');
    expect(store.workingSets.get(threadId)).toBeDefined();
  });
});

async function writeRuntimeMinimalDocx(filePath: string, text: string): Promise<void> {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">',
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>',
    '<Default Extension="xml" ContentType="application/xml"/>',
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>',
    '</Types>',
  ].join(''));
  zip.folder('_rels')!.file('.rels', [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>',
    '</Relationships>',
  ].join(''));
  zip.folder('word')!.file('document.xml', [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">',
    '<w:body><w:p><w:r><w:t>',
    escapeRuntimeXml(text),
    '</w:t></w:r></w:p></w:body></w:document>',
  ].join(''));
  await fs.writeFile(filePath, await zip.generateAsync({ type: 'nodebuffer' }));
}

function escapeRuntimeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
