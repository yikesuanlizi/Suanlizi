import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ThreadId, ThreadItem, ThreadMeta, TurnMeta } from '@suanlizi/protocol';
import { compactThread, getCompactionPressure, rollbackTurns, shouldCompact } from './memory.js';
import type { ThreadStore } from '@suanlizi/storage';

class MemoryStore implements ThreadStore {
  thread: ThreadMeta;
  turns: TurnMeta[];
  items: ThreadItem[];
  appended: ThreadItem[] = [];
  rollbackMarkers: Array<{ threadId: ThreadId; count: number; remainingTurnCount: number }> = [];

  constructor(threadId: ThreadId) {
    this.thread = {
      threadId,
      title: 'long thread',
      workspaceRoot: process.cwd(),
      status: 'active',
      turnCount: 5,
      createdAt: '2026-06-10T00:00:00.000Z',
      updatedAt: '2026-06-10T00:00:00.000Z',
      archivedAt: null,
      ephemeral: false,
      tags: {},
    };
    this.turns = Array.from({ length: 5 }, (_, index) => ({
      turnId: `turn-${index}`,
      threadId,
      index,
      userInput: { type: 'text', text: `request ${index}` },
      status: 'completed',
      startedAt: `2026-06-10T00:0${index}:00.000Z`,
      completedAt: `2026-06-10T00:0${index}:10.000Z`,
    }));
    this.items = this.turns.flatMap((turn) => [
      {
        id: `${turn.turnId}-user`,
        type: 'user_message' as const,
        turnId: turn.turnId,
        text: String((turn.userInput as { text: string }).text),
      },
      {
        id: `${turn.turnId}-agent`,
        type: 'agent_message' as const,
        turnId: turn.turnId,
        text: 'x'.repeat(120),
      },
    ]);
  }

  async appendItems(_threadId: ThreadId, items: ThreadItem[]): Promise<void> {
    this.appended.push(...items);
    this.items.push(...items);
  }
  async updateThreadMetadata(_threadId: ThreadId, patch: Partial<ThreadMeta>): Promise<void> {
    this.thread = { ...this.thread, ...patch };
  }
  async createThread(): Promise<void> {}
  async getThread(): Promise<ThreadMeta | null> { return this.thread; }
  async listThreads(): Promise<ThreadMeta[]> { return [this.thread]; }
  async deleteThread(): Promise<void> {}
  async getItems(): Promise<ThreadItem[]> { return this.items; }
  async getTurns(): Promise<TurnMeta[]> { return this.turns; }
  async saveTurn(): Promise<void> {}
  async getRecentItems(): Promise<ThreadItem[]> { return this.items; }
  async getLastCheckpoint(): Promise<null> { return null; }
  async appendCheckpoint(): Promise<void> {}
  async appendRollbackMarker(threadId: ThreadId, marker: { count: number; remainingTurnCount: number }): Promise<void> {
    this.rollbackMarkers.push({ threadId, count: marker.count, remainingTurnCount: marker.remainingTurnCount });
  }
  async getSetting<T = unknown>(): Promise<T | null> { return null; }
  async setSetting(): Promise<void> {}
  async upsertThreadSpawnEdge(): Promise<void> {}
  async setThreadSpawnEdgeStatus(): Promise<void> {}
  async listThreadSpawnChildren(): Promise<never[]> { return []; }
  async listThreadSpawnDescendants(): Promise<never[]> { return []; }
  async createRunRecord(): Promise<void> {}
  async updateRunRecord(): Promise<void> {}
  async appendRunEvent(): Promise<void> {}
  async listRunRecords(): Promise<never[]> { return []; }
  async listRunEvents(): Promise<never[]> { return []; }
  async upsertRunFeedback(): Promise<void> {}
  async listRunFeedback(): Promise<never[]> { return []; }
}

class SummaryModel {
  async chat() {
    return {
      choices: [
        {
          message: {
            content: [
              '当前进度：完成长任务；读取并整理历史。',
              '关键上下文：保留最近上下文。',
              '待办事项：继续当前任务。',
            ].join('\n'),
          },
        },
      ],
    };
  }
}

class EmptySummaryModel {
  async chat() {
    return {
      choices: [
        {
          message: {
            content: '',
          },
        },
      ],
    };
  }
}

class CapturingSummaryModel {
  messages: Array<{ role: string; content: string }> = [];

  async chat(request: { messages: Array<{ role: string; content: string }> }) {
    this.messages = request.messages;
    return {
      choices: [
        {
          message: {
            content: [
              '当前进度：实现 Codex 风格三段式压缩，已检查早期对话。',
              '关键上下文：packages/memory/src/memory.ts；测试捕获了提示词。',
              '待办事项：继续实现并防止格式漂移。',
            ].join('\n'),
          },
        },
      ],
    };
  }
}

class CodexStyleSummaryModel {
  async chat() {
    return {
      choices: [
        {
          message: {
            content: [
              '当前进度：',
              '- 把压缩改成标准三段式 handoff。',
              '- 已经完成 Codex Memento 风格的历史整理。',
              '- 已确认压缩结果要交给下一个 LLM 接手。',
              '关键上下文：',
              '- 必须使用三段式中文字段。',
              '- section 可能包含多行 bullet。',
              '待办事项：',
              '- 继续运行记忆包测试。',
            ].join('\n'),
          },
        },
      ],
    };
  }
}

class LiteralSummaryModel {
  constructor(private readonly content: string) {}

  async chat() {
    return {
      choices: [
        {
          message: {
            content: this.content,
          },
        },
      ],
    };
  }
}

describe('compactThread', () => {
  it('reports soft compaction pressure before hard compaction is needed', () => {
    const store = new MemoryStore('thread-pressure');
    const pressure = getCompactionPressure(store.items, {
      maxTokens: 250,
      softCompactRatio: 0.5,
      hardCompactRatio: 0.8,
    });

    expect(pressure.status).toBe('soft');
    expect(pressure.estimatedTokens).toBeGreaterThanOrEqual(125);
    expect(shouldCompact(store.items, {
      maxTokens: 250,
      softCompactRatio: 0.5,
      hardCompactRatio: 0.8,
    })).toBe(false);
  });

  it('only auto-compacts after the hard threshold', () => {
    const store = new MemoryStore('thread-hard-pressure');
    expect(shouldCompact(store.items, {
      maxTokens: 180,
      softCompactRatio: 0.5,
      hardCompactRatio: 0.8,
    })).toBe(true);
  });

  it('auto-compacts once the hard threshold is reached even when below the absolute max', async () => {
    const store = new MemoryStore('thread-auto-hard-threshold');

    const result = await compactThread('thread-auto-hard-threshold', store, new SummaryModel() as never, {
      trigger: 'auto',
      maxTokens: 170,
      softCompactRatio: 0.5,
      hardCompactRatio: 0.8,
      keepRecentTurns: 3,
    });

    expect(result.compactedTurns).toBe(2);
    expect(store.appended[0]).toMatchObject({
      type: 'context_compaction',
      trigger: 'auto',
      compactedTurnIds: ['turn-0', 'turn-1'],
    });
  });

  it('does not auto-compact again from raw items that already belong to compacted turns', async () => {
    const store = new MemoryStore('thread-auto-repeat-pressure');
    store.thread.status = 'compacted';
    store.thread.tags = {
      compactedSummary: '当前进度：旧上下文已压缩。',
      compactedRanges: JSON.stringify([
        {
          compactedTurnIds: ['turn-0', 'turn-1'],
          retainedTurnIds: ['turn-2', 'turn-3', 'turn-4'],
          compactionItemId: 'compact-existing',
          summary: '当前进度：旧上下文已压缩。',
          tokensBefore: 160,
          tokensAfter: 40,
          createdAt: '2026-06-10T00:05:00.000Z',
          trigger: 'auto',
          strategy: 'llm',
        },
      ]),
    };

    const result = await compactThread('thread-auto-repeat-pressure', store, new SummaryModel() as never, {
      trigger: 'auto',
      maxTokens: 140,
      softCompactRatio: 0.5,
      hardCompactRatio: 0.8,
      keepRecentTurns: 3,
    });

    expect(result.compactedTurns).toBe(0);
    expect(store.appended).toEqual([]);
  });

  it('persists a visible context_compaction item with structured summary and preserved tail turns', async () => {
    const store = new MemoryStore('thread-compact-visible');

    const result = await compactThread('thread-compact-visible', store, new SummaryModel() as never, {
      maxTokens: 10,
      keepRecentTurns: 3,
    });

    expect(result.compactedTurns).toBe(2);
    expect(store.appended).toEqual([
      expect.objectContaining({
        type: 'context_compaction',
        status: 'completed',
        compactedTurnIds: ['turn-0', 'turn-1'],
        retainedTurnIds: ['turn-2', 'turn-3', 'turn-4'],
        summary: expect.objectContaining({
          userGoal: expect.stringContaining('完成长任务'),
          openTasks: expect.stringContaining('继续当前任务'),
        }),
      }),
    ]);
    expect(store.thread.tags?.compactedSummary).toContain('当前进度');
    expect(JSON.parse(store.thread.tags?.compactedRanges ?? '[]')).toEqual([
      expect.objectContaining({
        compactedTurnIds: ['turn-0', 'turn-1'],
        retainedTurnIds: ['turn-2', 'turn-3', 'turn-4'],
        compactionItemId: expect.any(String),
      }),
    ]);
  });

  it('attaches the compaction item to the active compaction turn instead of an old summarized turn', async () => {
    const store = new MemoryStore('thread-compact-turn');

    await compactThread('thread-compact-turn', store, new SummaryModel() as never, {
      maxTokens: 10,
      keepRecentTurns: 3,
      compactionTurnId: 'turn-compact-active',
    });

    expect(store.appended[0]).toMatchObject({
      type: 'context_compaction',
      turnId: 'turn-compact-active',
      compactedTurnIds: ['turn-0', 'turn-1'],
    });
  });

  it('supports local compaction without calling the model', async () => {
    const store = new MemoryStore('thread-local-compact');
    const model = {
      async chat() {
        throw new Error('local compaction must not call model');
      },
    };

    const result = await compactThread('thread-local-compact', store, model as never, {
      maxTokens: 10,
      keepRecentTurns: 3,
      strategy: 'local',
    });

    expect(result.compactedTurns).toBe(2);
    expect(result.summary).toContain('request 0');
    expect(result.tokensAfter).toBeLessThan(result.tokensBefore);
    expect(store.appended[0]).toMatchObject({
      type: 'context_compaction',
      status: 'completed',
      compactedTurnIds: ['turn-0', 'turn-1'],
    });
  });

  it('falls back to a local summary when the model returns an empty compaction summary', async () => {
    const store = new MemoryStore('thread-empty-summary');

    const result = await compactThread('thread-empty-summary', store, new EmptySummaryModel() as never, {
      maxTokens: 10,
      keepRecentTurns: 3,
      strategy: 'llm',
    });

    expect(result.summary).toContain('当前进度');
    expect(result.tokensAfter).toBeGreaterThan(0);
    expect(store.appended[0]).toMatchObject({
      type: 'context_compaction',
      status: 'completed',
      summary: expect.objectContaining({
        raw: expect.stringContaining('当前进度'),
      }),
    });
  });

  it('asks the model for a Codex Memento style three-section handoff summary only', async () => {
    const store = new MemoryStore('thread-codex-prompt');
    const model = new CapturingSummaryModel();

    await compactThread('thread-codex-prompt', store, model as never, {
      maxTokens: 10,
      keepRecentTurns: 3,
      strategy: 'llm',
    });

    const systemPrompt = model.messages.find((message) => message.role === 'system')?.content ?? '';
    expect(systemPrompt).toContain('Codex Memento');
    expect(systemPrompt).toContain('handoff summary');
    expect(systemPrompt).not.toContain('single paragraph');
    expect(systemPrompt).toContain('Use exactly these three top-level sections');
    for (const label of ['当前进度', '关键上下文', '待办事项']) {
      expect(systemPrompt).toContain(`${label}：`);
    }
    for (const removedLabel of ['用户目标', '已完成变更', '关键约束', '文件', '工具结果', '子 agent 结论', '未完成事项', '风险']) {
      expect(systemPrompt).not.toContain(`${removedLabel}：`);
    }
  });

  it('maps Codex-style three-section summaries onto Suanlizi structured fields', async () => {
    const store = new MemoryStore('thread-codex-labels');

    const result = await compactThread('thread-codex-labels', store, new CodexStyleSummaryModel() as never, {
      maxTokens: 10,
      keepRecentTurns: 3,
      strategy: 'llm',
    });

    expect(result.item?.summary).toMatchObject({
      userGoal: expect.stringContaining('把压缩改成标准三段式 handoff'),
      completedWork: expect.stringContaining('已经完成 Codex Memento 风格的历史整理'),
      keyConstraints: expect.stringContaining('必须使用三段式中文字段'),
      openTasks: expect.stringContaining('继续运行记忆包测试'),
    });
    expect(result.item?.summary?.completedWork).toContain('已确认压缩结果要交给下一个 LLM 接手');
    expect(result.item?.summary?.keyConstraints).toContain('section 可能包含多行 bullet');
  });

  it('does not let an empty three-section consume the following three-section content', async () => {
    const result = await compactThread('thread-empty-section', new MemoryStore('thread-empty-section'), new LiteralSummaryModel([
      '当前进度：保留空 section 边界。',
      '关键上下文：',
      '待办事项：继续当前任务。',
    ].join('\n')) as never, {
      maxTokens: 10,
      keepRecentTurns: 3,
      strategy: 'llm',
    });

    expect(result.item?.summary?.keyConstraints).toBe('');
    expect(result.item?.summary?.openTasks).toBe('继续当前任务。');
  });

  it('maps only the three standard sections', async () => {
    const result = await compactThread('thread-mixed-labels', new MemoryStore('thread-mixed-labels'), new LiteralSummaryModel([
      '当前进度：Codex progress plain text。',
      '关键上下文：Context plain text。',
      '待办事项：Todo plain text。',
    ].join('\n')) as never, {
      maxTokens: 10,
      keepRecentTurns: 3,
      strategy: 'llm',
    });

    expect(result.item?.summary).toMatchObject({
      userGoal: 'Codex progress plain text。',
      completedWork: 'Codex progress plain text。',
      keyConstraints: 'Context plain text。',
      openTasks: 'Todo plain text。',
    });
  });

  it('builds local compaction summaries from actual user input and item excerpts', async () => {
    const store = new MemoryStore('thread-local-content');
    store.turns[0] = {
      ...store.turns[0],
      userInput: { type: 'text', text: '修复压缩摘要需要保留真实请求' },
    };
    store.items = store.turns.flatMap((turn) => [
      {
        id: `${turn.turnId}-user`,
        type: 'user_message' as const,
        turnId: turn.turnId,
        text: turn.userInput.type === 'text' ? turn.userInput.text : '[multimodal]',
      },
      {
        id: `${turn.turnId}-agent`,
        type: 'agent_message' as const,
        turnId: turn.turnId,
        text: turn.turnId === 'turn-0'
          ? '已经读取 memory.test.ts 并确认需要先写失败测试'
          : '后续普通回复',
      },
    ]);

    const result = await compactThread('thread-local-content', store, {
      async chat() {
        throw new Error('local compaction must not call model');
      },
    } as never, {
      maxTokens: 10,
      keepRecentTurns: 3,
      strategy: 'local',
    });

    expect(result.summary).toContain('修复压缩摘要需要保留真实请求');
    expect(result.summary).toContain('已经读取 memory.test.ts');
    expect(result.item?.summary?.userGoal).toContain('修复压缩摘要需要保留真实请求');
    expect(result.summary).not.toContain('继续早期任务');
  });

  it('truncates long local item excerpts while preserving real request and item summary', async () => {
    const store = new MemoryStore('thread-local-long-excerpt');
    const longResult = `LONG_TOOL_RESULT_${'z'.repeat(160)}`;
    store.turns[0] = {
      ...store.turns[0],
      userInput: { type: 'text', text: '分析超长工具输出摘要' },
    };
    store.items = [
      {
        id: 'turn-0-user',
        type: 'user_message',
        turnId: 'turn-0',
        text: '分析超长工具输出摘要',
      },
      {
        id: 'turn-0-tool',
        type: 'tool_call',
        turnId: 'turn-0',
        toolName: 'read_file',
        arguments: { path: 'large.txt' },
        status: 'completed',
        result: longResult,
      },
      ...store.items.filter((item) => item.turnId !== 'turn-0'),
    ];

    const result = await compactThread('thread-local-long-excerpt', store, {
      async chat() {
        throw new Error('local compaction must not call model');
      },
    } as never, {
      maxTokens: 10,
      keepRecentTurns: 3,
      strategy: 'local',
    });

    expect(result.summary).toContain('分析超长工具输出摘要');
    expect(result.summary).toContain('LONG_TOOL_RESULT_');
    expect(result.summary).not.toContain('z'.repeat(80));
    expect(result.summary).toContain('...');
  });
});

describe('rollbackTurns checkpoints', () => {
  it('rejects count 0 before changing effective history', async () => {
    const store = new MemoryStore('thread-rollback-zero');

    await expect(rollbackTurns('thread-rollback-zero', store, 0)).rejects.toThrow(/count/i);

    expect(store.thread.turnCount).toBe(5);
    expect(store.rollbackMarkers).toEqual([]);
  });

  it('writes a rollback marker and prunes compacted ranges that cross the new effective history', async () => {
    const store = new MemoryStore('thread-rollback-marker');
    store.thread.turnCount = 4;
    store.turns = store.turns.slice(0, 4);
    store.thread.tags = {
      compactedSummary: 'summary with removed retained turn',
      compactedRanges: JSON.stringify([
        {
          compactedTurnIds: ['turn-0'],
          retainedTurnIds: ['turn-3'],
          compactionItemId: 'compact-removed',
          summary: 'summary with removed retained turn',
        },
      ]),
    };

    const result = await rollbackTurns('thread-rollback-marker', store, 3);

    expect(result.removedTurns).toBe(3);
    expect(store.rollbackMarkers).toEqual([
      { threadId: 'thread-rollback-marker', count: 3, remainingTurnCount: 1 },
    ]);
    expect(store.thread.turnCount).toBe(1);
    expect(store.thread.tags?.compactedSummary).toBeUndefined();
    expect(store.thread.tags?.compactedRanges).toBeUndefined();
  });

  it('restores the workflow tag from the latest active workflow checkpoint', async () => {
    const store = new MemoryStore('thread-workflow-rollback');
    store.thread.turnCount = 2;
    store.turns = store.turns.slice(0, 2);
    const oldWorkflow = { definition: { id: 'wf-old', goal: 'old workflow', nodes: [] }, run: { id: 'run-old' } };
    const newWorkflow = { definition: { id: 'wf-new', goal: 'new workflow', nodes: [] }, run: { id: 'run-new' } };
    store.thread.tags = { workflow: JSON.stringify(newWorkflow) };
    store.items = [
      { id: 'wf-cp-old', type: 'workflow_checkpoint', turnId: 'turn-0', turnCount: 1, workflow: oldWorkflow },
      { id: 'wf-cp-new', type: 'workflow_checkpoint', turnId: 'turn-1', turnCount: 2, workflow: newWorkflow },
    ] as ThreadItem[];

    await rollbackTurns('thread-workflow-rollback', store, 1);

    expect(store.thread.turnCount).toBe(1);
    expect(JSON.parse(store.thread.tags?.workflow ?? '{}')).toMatchObject(oldWorkflow);
  });

  it('restores disk files from project checkpoints when hashes match', async () => {
    const root = mkdtempSync(join(tmpdir(), 'suanlizi-rollback-'));
    const file = join(root, 'src.txt');
    writeFileSync(file, 'after', 'utf-8');
    const store = new MemoryStore('thread-project-rollback');
    store.thread.workspaceRoot = root;
    store.thread.turnCount = 1;
    store.turns = store.turns.slice(0, 1);
    store.items = [{
      id: 'project-cp-1',
      type: 'project_checkpoint',
      turnId: 'turn-0',
      turnCount: 1,
      workspaceRoot: root,
      files: [{
        path: 'src.txt',
        kind: 'update',
        beforeContent: 'before',
        afterContent: 'after',
        beforeHash: sha256('before'),
        afterHash: sha256('after'),
      }],
    }] as ThreadItem[];

    const result = await rollbackTurns('thread-project-rollback', store, 1);

    expect(result.removedTurns).toBe(1);
    expect(readFileSync(file, 'utf-8')).toBe('before');
    expect(store.appended.filter((item) => item.type === 'rollback_conflict')).toEqual([]);
  });

  it('records rollback conflicts instead of overwriting externally changed files', async () => {
    const root = mkdtempSync(join(tmpdir(), 'suanlizi-rollback-conflict-'));
    const file = join(root, 'src.txt');
    writeFileSync(file, 'external edit', 'utf-8');
    const store = new MemoryStore('thread-project-conflict');
    store.thread.workspaceRoot = root;
    store.thread.turnCount = 1;
    store.turns = store.turns.slice(0, 1);
    store.items = [{
      id: 'project-cp-1',
      type: 'project_checkpoint',
      turnId: 'turn-0',
      turnCount: 1,
      workspaceRoot: root,
      files: [{
        path: 'src.txt',
        kind: 'update',
        beforeContent: 'before',
        afterContent: 'after',
        beforeHash: sha256('before'),
        afterHash: sha256('after'),
      }],
    }] as ThreadItem[];

    await rollbackTurns('thread-project-conflict', store, 1);

    expect(readFileSync(file, 'utf-8')).toBe('external edit');
    expect(store.appended).toEqual([
      expect.objectContaining({
        type: 'rollback_conflict',
        conflicts: [expect.objectContaining({ path: 'src.txt', reason: expect.stringContaining('hash') })],
      }),
    ]);
  });

  it('restores the source file and removes the target after rolling back a rename checkpoint', async () => {
    // 中文注释：rename 检查点含两个文件条目：源 delete（beforeContent 为源原内容）+ 目标 add
    const root = mkdtempSync(join(tmpdir(), 'suanlizi-rollback-rename-'));
    const sourceFile = join(root, 'a.txt');
    const targetFile = join(root, 'b.txt');
    // 模拟 apply_patch move a.txt -> b.txt 之后的磁盘状态：源已删、目标含搬移后的内容
    writeFileSync(targetFile, 'moved content', 'utf-8');
    const store = new MemoryStore('thread-project-rename');
    store.thread.workspaceRoot = root;
    store.thread.turnCount = 1;
    store.turns = store.turns.slice(0, 1);
    store.items = [{
      id: 'project-cp-rename',
      type: 'project_checkpoint',
      turnId: 'turn-0',
      turnCount: 1,
      workspaceRoot: root,
      files: [
        {
          path: 'a.txt',
          kind: 'delete',
          beforeContent: 'original A',
          afterContent: null,
          beforeHash: sha256('original A'),
          afterHash: null,
        },
        {
          path: 'b.txt',
          kind: 'add',
          beforeContent: null,
          afterContent: 'moved content',
          beforeHash: null,
          afterHash: sha256('moved content'),
        },
      ],
    }] as ThreadItem[];

    const result = await rollbackTurns('thread-project-rename', store, 1);

    expect(result.removedTurns).toBe(1);
    // 源文件被恢复为原内容
    expect(readFileSync(sourceFile, 'utf-8')).toBe('original A');
    // 目标文件被删除
    expect(existsSync(targetFile)).toBe(false);
    expect(store.appended.filter((item) => item.type === 'rollback_conflict')).toEqual([]);
  });

  it('records a conflict for a renamed target modified after the checkpoint and keeps the edit', async () => {
    // 中文注释：rename 后用户手动改了目标文件，rollback 时目标哈希不匹配 → 记录冲突并保留目标修改；
    // 源文件无冲突仍按 beforeContent 恢复
    const root = mkdtempSync(join(tmpdir(), 'suanlizi-rollback-rename-conflict-'));
    const sourceFile = join(root, 'a.txt');
    const targetFile = join(root, 'b.txt');
    // 目标被外部修改，与检查点 afterHash 不一致
    writeFileSync(targetFile, 'externally modified', 'utf-8');
    const store = new MemoryStore('thread-project-rename-conflict');
    store.thread.workspaceRoot = root;
    store.thread.turnCount = 1;
    store.turns = store.turns.slice(0, 1);
    store.items = [{
      id: 'project-cp-rename-conflict',
      type: 'project_checkpoint',
      turnId: 'turn-0',
      turnCount: 1,
      workspaceRoot: root,
      files: [
        {
          path: 'a.txt',
          kind: 'delete',
          beforeContent: 'original A',
          afterContent: null,
          beforeHash: sha256('original A'),
          afterHash: null,
        },
        {
          path: 'b.txt',
          kind: 'add',
          beforeContent: null,
          afterContent: 'moved content',
          beforeHash: null,
          afterHash: sha256('moved content'),
        },
      ],
    }] as ThreadItem[];

    await rollbackTurns('thread-project-rename-conflict', store, 1);

    // 目标文件保留外部修改
    expect(readFileSync(targetFile, 'utf-8')).toBe('externally modified');
    // 源文件无冲突，按 beforeContent 恢复
    expect(readFileSync(sourceFile, 'utf-8')).toBe('original A');
    expect(store.appended).toEqual([
      expect.objectContaining({
        type: 'rollback_conflict',
        conflicts: [expect.objectContaining({ path: 'b.txt', reason: expect.stringContaining('hash') })],
      }),
    ]);
  });
});

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
