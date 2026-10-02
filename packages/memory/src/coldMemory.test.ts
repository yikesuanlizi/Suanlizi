import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ThreadStore } from '@suanlizi/storage';
import {
  DEFAULT_MEMORY_SETTINGS,
  exportMemoryArtifacts,
  extractMemoryCandidates,
  mergeMemoryCandidate,
  pruneColdMemories,
  searchColdMemories,
  type MemoryCandidate,
  type MemoryRecord,
} from './coldMemory.js';

function memoryStore(records: MemoryRecord[] = []): ThreadStore {
  const settings = new Map<string, unknown>();
  return {
    tenantId: 'tenantA',
    async getSetting<T = unknown>(key: string): Promise<T | null> {
      return (settings.get(key) as T | undefined) ?? null;
    },
    async setSetting(key: string, value: unknown): Promise<void> {
      settings.set(key, value);
    },
    async upsertMemoryRecord(record: MemoryRecord): Promise<void> {
      const index = records.findIndex((item) => item.id === record.id);
      if (index >= 0) records[index] = record;
      else records.push(record);
    },
    async listMemoryRecords(): Promise<MemoryRecord[]> {
      return records.filter((record) => record.status === 'active');
    },
    async searchMemoryRecords(query: string): Promise<MemoryRecord[]> {
      const q = query.toLowerCase();
      return records.filter((record) => record.status === 'active' && record.text.toLowerCase().includes(q));
    },
    async recordMemoryUsage(id: string, usedAt: string): Promise<void> {
      const record = records.find((item) => item.id === id);
      if (record) {
        record.usageCount += 1;
        record.lastUsedAt = usedAt;
      }
    },
  } as ThreadStore;
}

describe('cold memory', () => {
  it('extracts useful candidates and drops generic conversation text', () => {
    const candidates = extractMemoryCandidates({
      threadId: 'thread-a',
      turnId: 'turn-a',
      workspaceRoot: 'E:/langchain/Suanlizi',
      userText: '以后回答保持中文，并且 Suanlizi 项目只允许改 Suanlizi/ 目录。',
      assistantText: '好的，我会遵守。',
      now: new Date('2026-06-19T00:00:00.000Z'),
    });

    expect(candidates).toEqual([
      expect.objectContaining({ type: 'preference', text: expect.stringContaining('中文') }),
      expect.objectContaining({ type: 'project_fact', text: expect.stringContaining('Suanlizi/') }),
    ]);
    expect(extractMemoryCandidates({
      threadId: 'thread-a',
      turnId: 'turn-b',
      workspaceRoot: 'E:/langchain/Suanlizi',
      userText: '你好',
      assistantText: '你好',
      now: new Date('2026-06-19T00:01:00.000Z'),
    })).toEqual([]);
  });

  it('extracts project facts from toolchain and setup statements without explicit memory keywords', () => {
    const candidates = extractMemoryCandidates({
      threadId: 'thread-a',
      turnId: 'turn-toolchain',
      workspaceRoot: 'E:/langchain/Suanlizi',
      userText: '这个项目用 pnpm，不要 npm；测试命令是 pnpm vitest。',
      assistantText: '明白，后续会按 pnpm 工具链处理。',
      now: new Date('2026-06-19T00:02:00.000Z'),
    });

    expect(candidates).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'project_fact',
        text: expect.stringContaining('pnpm'),
        tags: expect.arrayContaining(['project']),
      }),
    ]));
  });

  it('extracts workflow patterns and environment notes from ordinary setup statements', () => {
    const candidates = extractMemoryCandidates({
      threadId: 'thread-a',
      turnId: 'turn-workflow',
      workspaceRoot: 'E:/langchain/Suanlizi',
      userText: [
        '开发流程是先写失败测试，再实现。',
        '本机是 Windows，shell 用 PowerShell，路径根目录是 E:/langchain/Suanlizi。',
      ].join('\n'),
      assistantText: '收到。',
      now: new Date('2026-06-19T00:03:00.000Z'),
    });

    expect(candidates).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'workflow_pattern',
        text: expect.stringContaining('失败测试'),
      }),
      expect.objectContaining({
        type: 'environment_note',
        text: expect.stringContaining('PowerShell'),
      }),
    ]));
  });

  it('merges duplicate candidates and searches by query/workspace/usage score', async () => {
    const store = memoryStore();
    const now = new Date('2026-06-19T00:00:00.000Z');
    const candidate: MemoryCandidate = {
      id: 'candidate-a',
      type: 'preference',
      text: '用户偏好：回答使用中文。',
      scope: 'global',
      sourceThreadId: 'thread-a',
      sourceTurnIds: ['turn-a'],
      workspaceRoot: 'E:/langchain/Suanlizi',
      tags: ['language'],
      confidence: 0.9,
      createdAt: now.toISOString(),
    };

    const first = await mergeMemoryCandidate(store, candidate, now);
    const second = await mergeMemoryCandidate(store, { ...candidate, id: 'candidate-b', sourceTurnIds: ['turn-b'] }, now);

    expect(first.id).toBe(second.id);
    const results = await searchColdMemories(store, '中文总结', {
      workspaceRoot: 'E:/langchain/Suanlizi',
      limit: 3,
      tokenBudget: 500,
      now,
    });
    expect(results[0]).toEqual(expect.objectContaining({
      score: expect.any(Number),
      reason: expect.stringContaining('query'),
      record: expect.objectContaining({ usageCount: 0 }),
    }));
  });

  it('recalls active memories through lightweight synonym expansion', async () => {
    const store = memoryStore([
      {
        id: 'mem-permission',
        type: 'failure_lesson',
        text: '修复 Windows 权限错误：以管理员身份重新授予 workspace 写入权限。',
        status: 'active',
        scope: 'workspace',
        sourceThreadId: 'thread-a',
        sourceTurnIds: ['turn-a'],
        workspaceRoot: 'E:/langchain/Suanlizi',
        tags: ['lesson'],
        confidence: 0.84,
        usageCount: 0,
        lastUsedAt: null,
        createdAt: '2026-06-19T00:00:00.000Z',
        updatedAt: '2026-06-19T00:00:00.000Z',
      },
    ]);

    const results = await searchColdMemories(store, '上次那个 permission problem 怎么解决的', {
      workspaceRoot: 'E:/langchain/Suanlizi',
      now: new Date('2026-06-20T00:00:00.000Z'),
    });

    expect(results[0]?.record.id).toBe('mem-permission');
    expect(results[0]?.reason).toContain('query');
  });

  it('does not return workspace memories on workspace and recency alone', async () => {
    const store = memoryStore([
      {
        id: 'mem-unrelated',
        type: 'project_fact',
        text: 'Suanlizi uses pnpm for tests.',
        status: 'active',
        scope: 'workspace',
        sourceThreadId: 'thread-a',
        sourceTurnIds: ['turn-a'],
        workspaceRoot: 'E:/langchain/Suanlizi',
        tags: ['project'],
        confidence: 0.84,
        usageCount: 0,
        lastUsedAt: null,
        createdAt: '2026-06-19T00:00:00.000Z',
        updatedAt: '2026-06-19T00:00:00.000Z',
      },
    ]);

    const results = await searchColdMemories(store, '帮我设计登录页面', {
      workspaceRoot: 'E:/langchain/Suanlizi',
      now: new Date('2026-06-20T00:00:00.000Z'),
    });

    expect(results).toEqual([]);
  });

  it('soft-deletes stale low-value cold memories while keeping used and recent records', async () => {
    const records: MemoryRecord[] = [
      {
        id: 'mem-stale',
        type: 'environment_note',
        text: 'Old temporary note',
        status: 'active',
        scope: 'workspace',
        sourceThreadId: 'thread-a',
        sourceTurnIds: ['turn-a'],
        workspaceRoot: 'E:/langchain/Suanlizi',
        tags: [],
        confidence: 0.5,
        usageCount: 0,
        lastUsedAt: null,
        createdAt: '2025-01-01T00:00:00.000Z',
        updatedAt: '2025-01-01T00:00:00.000Z',
      },
      {
        id: 'mem-used',
        type: 'failure_lesson',
        text: 'Useful old lesson',
        status: 'active',
        scope: 'workspace',
        sourceThreadId: 'thread-a',
        sourceTurnIds: ['turn-b'],
        workspaceRoot: 'E:/langchain/Suanlizi',
        tags: ['lesson'],
        confidence: 0.8,
        usageCount: 3,
        lastUsedAt: '2025-12-01T00:00:00.000Z',
        createdAt: '2025-01-01T00:00:00.000Z',
        updatedAt: '2025-01-01T00:00:00.000Z',
      },
    ];
    const store = memoryStore(records);

    const result = await pruneColdMemories(store, {
      maxAgeDays: 90,
      minConfidence: 0.7,
      now: new Date('2026-06-20T00:00:00.000Z'),
    });

    expect(result.deleted).toEqual(['mem-stale']);
    expect(records.find((record) => record.id === 'mem-stale')?.status).toBe('deleted');
    expect(records.find((record) => record.id === 'mem-used')?.status).toBe('active');
  });

  it('exports DB-backed memories to audit artifacts without changing runtime truth', async () => {
    const store = memoryStore([
      {
        id: 'mem-a',
        type: 'project_fact',
        text: 'Suanlizi memory runtime truth lives in DB.',
        status: 'active',
        scope: 'workspace',
        sourceThreadId: 'thread-a',
        sourceTurnIds: ['turn-a'],
        workspaceRoot: 'E:/langchain/Suanlizi',
        tags: ['storage'],
        confidence: 0.88,
        usageCount: 2,
        lastUsedAt: null,
        createdAt: '2026-06-19T00:00:00.000Z',
        updatedAt: '2026-06-19T00:00:00.000Z',
      },
    ]);
    const outDir = mkdtempSync(join(tmpdir(), 'suanlizi-memory-export-'));

    const result = await exportMemoryArtifacts(store, outDir);

    expect(result.writtenFiles.map((file) => file.replace(/\\/g, '/'))).toEqual([
      expect.stringContaining('MEMORY.md'),
      expect.stringContaining('raw_memories.md'),
      expect.stringContaining('rollout_summaries/thread-a.md'),
    ]);
    expect(readFileSync(join(outDir, 'MEMORY.md'), 'utf8')).toContain('Suanlizi memory runtime truth lives in DB.');
  });

  it('defines conservative default settings', () => {
    expect(DEFAULT_MEMORY_SETTINGS).toMatchObject({
      memoryEnabled: true,
      autoExtractMemories: true,
      useColdMemories: true,
      memoryInjectLimit: 6,
      memoryTokenBudget: 1200,
    });
  });
});
