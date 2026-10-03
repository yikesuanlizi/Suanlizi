/**
 * 第 2 步事件骨架的钉子测试。
 *
 * 验证：
 *  - update_cognition 后会 emit task.cognition.updated（钉子 2）
 *  - ContextEngine 注入后会 emit task.context.updated，且不包含完整 prompt content（钉子 3）
 *  - 普通 /turn 会 emit task.runtime.updated，但不会 emit task.loop.updated（钉子 4）
 *  - harness continuation 时 onStateChange 收到 active / 终态 status，证明 task.loop.updated 数据源工作（钉子 5）
 *
 * 约束：
 *  - 不发完整 system prompt
 *  - 不发完整 chunk content
 *  - 普通 /turn 不会进入 harness
 */
import { describe, expect, it, vi } from 'vitest';
import type { ThreadEvent, ThreadId } from '@suanlizi/protocol';
import { AgentLoop } from './agent.js';
import { ThreadStateManager } from './state.js';
import { createDynamicContextMiddleware, type RuntimeTurnContext } from './middleware.js';
import type { ThreadStore } from '@suanlizi/storage';
import type { ThreadMeta, TurnMeta, Checkpoint } from '@suanlizi/protocol';
import { TaskHarnessEngine, type HarnessStateChangeCallback } from './harness/taskHarness.js';
import { DEFAULT_HARNESS_CONFIG } from './harness/types.js';
import type { ContextEngine, AssembledContext, ProviderContext, AgentContext } from '@suanlizi/context';

// —— 复用 agent.test.ts 的 fake 工具，但本文件需要自包含以避免循环依赖 —— //

class FakeStore {
  thread: ThreadMeta;
  turns: TurnMeta[] = [];
  items: never[] = [];
  tags: Record<string, string> = {};
  checkpoint: { threadId: ThreadId; turnId: string; itemIndex: number; timestamp: string; status?: string } | null = null;

  constructor(threadId: ThreadId, turnId: string) {
    this.thread = {
      threadId,
      title: 'task-runtime-test',
      workspaceRoot: process.cwd(),
      status: 'active' as const,
      turnCount: 0,
      createdAt: '2026-06-10T00:00:00.000Z',
      updatedAt: '2026-06-10T00:00:00.000Z',
      archivedAt: null,
      ephemeral: false,
      tags: {},
    };
    this.turns = [{
      turnId,
      threadId,
      index: 0,
      userInput: { type: 'text', text: 'hello' },
      status: 'completed',
      startedAt: '2026-06-10T00:00:00.000Z',
      completedAt: null,
    }];
  }
  async getThread(threadId: ThreadId) { return threadId === this.thread.threadId ? this.thread : null; }
  async updateThreadMetadata(_threadId: ThreadId, patch: Partial<ThreadMeta>) {
    if (patch.tags) this.thread.tags = patch.tags;
  }
  async getTurns() { return this.turns; }
  async saveTurn(turn: TurnMeta) { this.turns = [turn, ...this.turns.filter((t) => t.turnId !== turn.turnId)]; }
  async getRecentItems() { return []; }
  async getItems() { return []; }
  async appendItems() {}
  async getCompactionSummary() { return null; }
  async listThreadSpawnDescendants() { return []; }
  async getLastCheckpoint() { return this.checkpoint; }
  async appendCheckpoint(_threadId: ThreadId, ckpt: { threadId: ThreadId; turnId: string; itemIndex: number; timestamp: string; status?: string }) { this.checkpoint = ckpt; }
  async getSetting() { return null; }
  async setSetting() {}
  async createRunRecord() {}
  async updateRunRecord() {}
  async appendRunEvent() {}
  async listRunRecords() { return []; }
  async listRunEvents() { return []; }
  async upsertRunFeedback() {}
  async listRunFeedback() { return []; }
}

class StubModel {
  async *chatStream() {
    yield { type: 'delta' as const, content: 'ok' };
    yield { type: 'done' as const };
  }
}

function buildAgent(threadId: ThreadId, events: ThreadEvent[]) {
  const store = new FakeStore(threadId, 'turn-prev');
  const stateManager = new ThreadStateManager();
  const agent = new AgentLoop(
    {
      workspaceRoot: process.cwd(),
      sandbox: { level: 'workspace_write', workspaceRoot: process.cwd() },
      model: new StubModel() as never,
      store: store as unknown as ThreadStore,
      locale: 'zh',
    },
    stateManager,
  );
  agent.onEvent((event) => events.push(event));
  return { agent, store };
}

// —— 钉子 2：update_cognition 后 emit task.cognition.updated —— //

describe('task.cognition.updated（钉子 2）', () => {
  it('updateTaskCognition 后会 emit task.cognition.updated 事件', () => {
    const threadId = 'thread-cog-emit';
    const events: ThreadEvent[] = [];
    const { agent } = buildAgent(threadId, events);

    agent.updateTaskCognition(threadId, {
      goal: '介绍航空保障包',
      verificationCriteria: ['说明扩展包用途'],
    });

    const cogEvents = events.filter((e) => e.type === 'task.cognition.updated');
    expect(cogEvents).toHaveLength(1);
    const ev = cogEvents[0] as Extract<ThreadEvent, { type: 'task.cognition.updated' }>;
    expect(ev.threadId).toBe(threadId);
    expect(ev.cognition.goal).toBe('介绍航空保障包');
    expect(ev.cognition.verificationCriteria).toEqual(['说明扩展包用途']);
    expect(ev.cognition.confidence).toBeGreaterThanOrEqual(0);
    expect(ev.cognition.confidence).toBeLessThanOrEqual(1);
  });
});

// —— 钉子 3：ContextEngine 注入后 emit task.context.updated，不含完整 content —— //

describe('task.context.updated（钉子 3）', () => {
  it('assembleBeforeTurn 之后 emit task.context.updated，chunks 不含完整 content', async () => {
    const events: ThreadEvent[] = [];
    const emit = (event: ThreadEvent) => events.push(event);

    const fakeContextEngine: ContextEngine = {
      assembleBeforeTurn: async (_ctx: ProviderContext): Promise<AssembledContext> => ({
        chunks: [
          {
            id: 'chunk-task-1',
            source: 'task-context-provider',
            priority: 10,
            tokens: 120,
            content: '这是一段超长的真实 prompt 内容，绝对不能泄露到 SSE 上去。',
            metadata: { summary: '当前任务认知摘要', truncated: false },
          },
          {
            id: 'chunk-exp-1',
            source: 'experience-provider',
            priority: 20,
            tokens: 80,
            content: '历史经验内容，不能泄露',
            metadata: { truncated: true, summary: '历史经验摘要' },
          },
        ],
        updatedAgentContext: {} as AgentContext,
        usedTokens: 200,
        remainingTokens: 7800,
      }),
      assemblePhase: async () => ({ chunks: [], updatedAgentContext: {} as AgentContext, usedTokens: 0, remainingTokens: 0 }),
    };

    const existingContext: AgentContext = {
      cognition: {
        task: {
          goal: '',
          constraints: [],
          assumptions: [],
          knownFacts: [],
          unknowns: [],
          risks: [],
          confidence: 0,
          verificationCriteria: [],
        },
      },
      world: { environment: { cwd: process.cwd(), os: 'test', shell: 'bash' }, project: undefined },
      memory: undefined,
      updatedAt: 0,
    };

    const middleware = createDynamicContextMiddleware({
      contextEngine: fakeContextEngine,
      getAgentContext: () => existingContext,
      setAgentContext: () => {},
      contextBudget: 8000,
      emit,
    });

    const ctx: RuntimeTurnContext = {
      tenantId: 'default',
      threadId: 'thread-ctx-emit',
      turnId: 'turn-ctx-emit',
      thread: {
        threadId: 'thread-ctx-emit',
        title: 'ctx',
        workspaceRoot: process.cwd(),
        status: 'active',
        turnCount: 1,
        createdAt: '2026-06-10T00:00:00.000Z',
        updatedAt: '2026-06-10T00:00:00.000Z',
        archivedAt: null,
        ephemeral: false,
        tags: {},
      },
      userInput: { type: 'text', text: 'hi' },
      workspaceRoot: process.cwd(),
      locale: 'zh',
      webSearchMode: 'auto',
      runtimeState: { threadId: 'thread-ctx-emit', status: 'idle', resumable: false, stale: false, checkpoint: null },
      checkpoint: null as unknown as Checkpoint,
      collectedItems: [],
      store: new FakeStore('thread-ctx-emit', 'turn-prev') as unknown as ThreadStore,
      stateManager: {} as never,
      emit,
      permissions: { level: 'workspace_write', networkAllowed: true },
      maxSubagents: 4,
    };

    await middleware.beforeTurn?.(ctx);

    const ctxEvents = events.filter((e) => e.type === 'task.context.updated');
    expect(ctxEvents).toHaveLength(1);
    const ev = ctxEvents[0] as Extract<ThreadEvent, { type: 'task.context.updated' }>;
    expect(ev.chunks).toHaveLength(2);
    expect(ev.chunks[0]).toMatchObject({ id: 'chunk-task-1', source: 'task-context-provider', tokens: 120, priority: 10, truncated: false, summary: '当前任务认知摘要' });
    expect(ev.chunks[1]).toMatchObject({ id: 'chunk-exp-1', source: 'experience-provider', tokens: 80, priority: 20, truncated: true, summary: '历史经验摘要' });
    // 关键约束：事件中不能出现 chunk 的完整 content
    expect(JSON.stringify(ev)).not.toContain('这是一段超长的真实 prompt 内容');
    expect(JSON.stringify(ev)).not.toContain('历史经验内容');
    expect(ev.usedTokens).toBe(200);
    expect(ev.remainingTokens).toBe(7800);
  });
});

// —— 钉子 4：普通 /turn 会 emit task.runtime.updated，但不会 emit task.loop.updated —— //

describe('task.runtime.updated on normal /turn（钉子 4）', () => {
  it('普通 runTurn 会 emit task.runtime.updated，但不会 emit task.loop.updated', async () => {
    const threadId = 'thread-runtime-normal';
    const events: ThreadEvent[] = [];
    const { agent } = buildAgent(threadId, events);

    await agent.runTurn(threadId, { type: 'text', text: '介绍一下航空保障包（扩展包）' });

    const runtimeEvents = events.filter((e) => e.type === 'task.runtime.updated');
    expect(runtimeEvents.length).toBeGreaterThan(0);
    const beforeTurn = runtimeEvents.find((e) => (e as Extract<ThreadEvent, { type: 'task.runtime.updated' }>).phase === 'before_turn');
    expect(beforeTurn).toBeDefined();
    expect((beforeTurn as Extract<ThreadEvent, { type: 'task.runtime.updated' }>).status).toBe('running');

    const afterTurn = runtimeEvents.find((e) => (e as Extract<ThreadEvent, { type: 'task.runtime.updated' }>).phase === 'after_turn');
    expect(afterTurn).toBeDefined();
    expect((afterTurn as Extract<ThreadEvent, { type: 'task.runtime.updated' }>).status).toBe('completed');

    // 普通 /turn 绝对不能 emit task.loop.updated
    const loopEvents = events.filter((e) => e.type === 'task.loop.updated');
    expect(loopEvents).toHaveLength(0);

    // 也不能 emit harness.state.updated（即不进入 harness）
    const harnessEvents = events.filter((e) => e.type === 'harness.state.updated');
    expect(harnessEvents).toHaveLength(0);
  });
});

// —— 钉子 5：harness continuation 会触发 onStateChange，对应 task.loop.updated 数据源 —— //
//
// 这里直接验证 TaskHarnessEngine 在 continuation 时调用 onStateChange，
// agent.ts 的 onHarnessStateChange 会据此 emit task.loop.updated。

class FakeHarnessStore {
  private tags: Record<string, string> = {};
  async getThread(threadId: ThreadId): Promise<ThreadMeta> {
    return {
      threadId,
      title: 'Harness test',
      workspaceRoot: '',
      status: 'active' as const,
      turnCount: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      archivedAt: null,
      ephemeral: false,
      tags: this.tags,
    };
  }
  async updateThreadMetadata(_threadId: ThreadId, patch: { tags?: Record<string, string> }) {
    this.tags = patch.tags ?? this.tags;
  }
  async getRecentItems() { return []; }
  async getItems() { return []; }
  async getCompactionSummary() { return null; }
}

describe('task.loop.updated on harness continuation（钉子 5）', () => {
  it('harness 第一次状态变化是 active，最终是 satisfied', async () => {
    const statuses: string[] = [];
    const onStateChange: HarnessStateChangeCallback = ({ state }) => {
      statuses.push(state.status);
    };

    const answerItems = [{
      id: 'item-answer',
      type: 'agent_message',
      turnId: 'turn-1',
      text: '航空保障包（扩展包）用于补充能力。',
      status: 'completed',
      timestamp: new Date().toISOString(),
    }] as never[];

    const agentLoop = {
      runTurn: vi.fn(async () => ({ items: answerItems, usage: null })),
      updateTaskCognition: vi.fn(),
    };

    const model = {
      completeOnce: vi.fn(async () => JSON.stringify({
        satisfied: true,
        status: 'satisfied',
        passedCriteria: ['介绍航空保障包'],
        failedCriteria: [],
        evidenceSummary: 'answered',
        reasoning: 'pure answer',
        criteriaEvidenceMap: {},
      })),
    };

    const engine = new TaskHarnessEngine(
      agentLoop as never,
      model as never,
      new FakeHarnessStore() as never,
      { ...DEFAULT_HARNESS_CONFIG, maxContinuations: 2, maxNoProgress: 1 },
      undefined,
      onStateChange,
    );

    const result = await engine.runHarness(
      'thread-harness-loop-emit',
      { type: 'text', text: '介绍一下航空保障包（扩展包）' },
      { acceptanceCriteria: ['介绍航空保障包'], maxContinuations: 2 },
    );

    expect(result.status).toBe('satisfied');
    // 第一次 state change 必须是 active（loop 启动信号）
    expect(statuses[0]).toBe('active');
    // 最后必然到达 satisfied（loop 终态信号）
    expect(statuses.at(-1)).toBe('satisfied');

    // 模拟 agent.ts 的 task.loop.updated emit 约束：
    expect(statuses.length).toBeGreaterThan(0);
  });
});
