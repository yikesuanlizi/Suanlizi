import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as XLSX from 'xlsx';
import type { ThreadStore } from '@suanlizi/storage';
import { createStore } from '@suanlizi/storage';
import { authorizeKnowledgeDirectory, createKnowledgeBase, ensureOpsKnowledgeBase, ensureWorkspaceKnowledgeBase, getKnowledgePage, listKnowledgeBases, queryKnowledge, replayKnowledgeReceipt } from './knowledgeBase.js';

class FakeStore implements Partial<ThreadStore> {
  private readonly settings = new Map<string, unknown>();

  async getSetting<T = unknown>(key: string): Promise<T | null> {
    return (this.settings.get(key) as T | undefined) ?? null;
  }

  async setSetting(key: string, value: unknown): Promise<void> {
    this.settings.set(key, value);
  }
}

describe('workspace knowledge base', () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it('creates an immutable workspace snapshot and queries lexical hits', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'suanlizi-kb-'));
    roots.push(root);
    await writeFile(path.join(root, 'runbook.md'), '---\ntitle: Restart\n---\nRestart the service only after approval.\n', 'utf8');
    const store = new FakeStore() as unknown as ThreadStore;

    const first = await ensureWorkspaceKnowledgeBase(store, 'tenant-a', root);
    expect(first.snapshot.immutable).toBe(true);
    expect(first.snapshot.status).toBe('ready');
    expect(first.base.workspaceId).toBe(first.snapshot.workspaceId);
    expect(first.snapshot.chunks.some((chunk) => chunk.text.includes('Restart'))).toBe(true);
    expect(first.snapshot.graph.nodes).toHaveLength(1);
    const page = await getKnowledgePage(
      store,
      first.base.knowledgeBaseId,
      first.snapshot.pages[0]!.pageId,
      'tenant-a',
    );
    expect(page).toEqual(expect.objectContaining({ title: 'Restart', body: expect.stringContaining('Restart') }));
    expect(page?.body).not.toContain('title: Restart');

    const result = await queryKnowledge(store, 'tenant-a', {
      knowledgeBaseIds: [first.base.knowledgeBaseId],
      snapshotIds: [first.snapshot.snapshotId],
      query: 'restart service',
    });
    expect(result.receipt.snapshotIds).toEqual([first.snapshot.snapshotId]);
    expect(result.receipt.queryVersion).toBe('wiki-core-lexical-v1');
    expect(result.hits[0]?.relativePath).toBe('runbook.md');

    const replay = await replayKnowledgeReceipt(store, 'tenant-a', result.receipt.receiptId);
    expect(replay?.hits.map((hit) => hit.chunkId)).toEqual(result.hits.map((hit) => hit.chunkId));
    expect(await replayKnowledgeReceipt(store, 'other-tenant', result.receipt.receiptId)).toBeNull();
  });

  it('persists the wiki catalog and FTS index in the shared SQLite store', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'suanlizi-kb-workspace-'));
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'suanlizi-kb-data-'));
    roots.push(root, dataDir);
    await writeFile(path.join(root, 'runbook.md'), '# Restart\nRestart the service only after approval.\n', 'utf8');

    const firstRuntime = createStore(dataDir);
    const firstStore = firstRuntime.store;
    const first = await ensureWorkspaceKnowledgeBase(firstStore, 'tenant-sqlite', root);
    expect(firstStore.knowledgeSqlite).toBeDefined();
    expect(first.snapshot.pages[0]).toEqual(expect.objectContaining({ title: 'Restart', generated: false }));
    expect(first.snapshot.pages[0]).toEqual(expect.objectContaining({
      pageDirectory: 'other',
      summary: '',
      links: [],
    }));
    expect(firstStore.knowledgeSqlite!.get<{ count: number }>(
      'SELECT COUNT(*) AS count FROM knowledge_chunks_fts WHERE tenant_id = ?',
      ['tenant-sqlite'],
    )?.count).toBeGreaterThan(0);
    (firstRuntime.db as { close?: () => void }).close?.();

    const reopenedRuntime = createStore(dataDir);
    const reopenedStore = reopenedRuntime.store;
    const reopened = await ensureWorkspaceKnowledgeBase(reopenedStore, 'tenant-sqlite', root, { sync: false });
    expect(reopened.snapshot.snapshotId).toBe(first.snapshot.snapshotId);
    const query = await queryKnowledge(reopenedStore, 'tenant-sqlite', {
      knowledgeBaseIds: [reopened.base.knowledgeBaseId],
      snapshotIds: [reopened.snapshot.snapshotId],
      query: 'restart service',
    });
    expect(query.hits[0]?.relativePath).toBe('runbook.md');
    (reopenedRuntime.db as { close?: () => void }).close?.();
  });

  it('uses the pulled Wiki title-priority AND semantics before writing a receipt', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'suanlizi-kb-ranking-'));
    roots.push(root);
    await writeFile(
      path.join(root, 'body-runbook.md'),
      '# Runbook\nRestart the service only after approval.\n',
      'utf8',
    );
    await writeFile(
      path.join(root, 'title-runbook.md'),
      '# Restart Service\nFollow the approval checklist.\n',
      'utf8',
    );
    const store = new FakeStore() as unknown as ThreadStore;
    const indexed = await ensureWorkspaceKnowledgeBase(store, 'tenant-ranking', root);
    const result = await queryKnowledge(store, 'tenant-ranking', {
      knowledgeBaseIds: [indexed.base.knowledgeBaseId],
      query: 'restart service',
    });

    expect(result.receipt.queryVersion).toBe('wiki-core-lexical-v1');
    expect(result.hits.map((hit) => hit.relativePath)).toEqual([
      'title-runbook.md',
      'body-runbook.md',
    ]);
  });

  it('matches query terms across chunks at page level without duplicating page ranking', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'suanlizi-kb-cross-chunk-'));
    roots.push(root);
    await writeFile(
      path.join(root, 'cross.md'),
      `# Cross chunk\nRestart ${'context '.repeat(500)} approval\n`,
      'utf8',
    );
    const store = new FakeStore() as unknown as ThreadStore;
    const indexed = await ensureWorkspaceKnowledgeBase(store, 'tenant-cross-chunk', root);
    const result = await queryKnowledge(store, 'tenant-cross-chunk', {
      knowledgeBaseIds: [indexed.base.knowledgeBaseId],
      query: 'restart approval',
      maxHits: 10,
    });
    expect(result.hits.length).toBeGreaterThan(0);
    expect(new Set(result.hits.map((hit) => hit.relativePath))).toEqual(new Set(['cross.md']));
    expect(result.receipt.orderedHits.every((hit, index, all) => index === 0 || hit.rank > all[index - 1]!.rank)).toBe(true);
  });
});

describe('personal knowledge bases', () => {
  it('requires explicit creation and never derives a default from cwd or tenant', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'suanlizi-personal-kb-'));
    await writeFile(path.join(root, 'runbook.md'), '# Personal\nUse the approved runbook.\n', 'utf8');
    const store = new FakeStore() as unknown as ThreadStore;
    const grant = await authorizeKnowledgeDirectory(store, 'tenant-a', root);
    const created = await createKnowledgeBase(store, 'tenant-a', { name: '个人手册', sourceGrantId: grant.grantId });
    expect(created.base.name).toBe('个人手册');
    expect(created.base.tenantId).toBeUndefined();
    expect(created.base.workspaceRoot).toBeUndefined();
    expect(created.base.source?.grantId).toBe(grant.grantId);
    expect(created.base.source?.canonicalPath).toBe(await realpath(root));
    expect((await listKnowledgeBases(store, 'another-tenant')).map((item) => item.knowledgeBaseId)).toEqual([created.base.knowledgeBaseId]);
    await expect(ensureOpsKnowledgeBase(store, 'tenant-a')).rejects.toThrow('no default Ops knowledge base');
    await rm(root, { recursive: true, force: true });
  });

  it('rejects direct paths and records skipped files even when nothing is indexed', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'suanlizi-personal-kb-skipped-'));
    try {
      await writeFile(path.join(root, 'secret.bin'), 'not indexable', 'utf8');
      const store = new FakeStore() as unknown as ThreadStore;
      await expect(createKnowledgeBase(store, 'tenant-a', { name: '不能直接传路径' })).rejects.toThrow('native-picker directory grant');
      const grant = await authorizeKnowledgeDirectory(store, 'tenant-a', root);
      const created = await createKnowledgeBase(store, 'tenant-a', { name: '仅授权目录', sourceGrantId: grant.grantId });
      expect(created.snapshot.indexStats).toEqual(expect.objectContaining({ indexedFiles: 0, skippedFiles: 1 }));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('extracts supported binary documents before redaction and indexing', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'suanlizi-personal-kb-binary-'));
    try {
      const workbook = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(
        workbook,
        XLSX.utils.aoa_to_sheet([['标题', '内容'], ['运行手册', '审批后重启服务']]),
        '运行手册',
      );
      XLSX.writeFile(workbook, path.join(root, 'runbook.xlsx'));
      const store = new FakeStore() as unknown as ThreadStore;
      const grant = await authorizeKnowledgeDirectory(store, 'tenant-binary', root);
      const created = await createKnowledgeBase(store, 'tenant-binary', { name: '二进制文档', sourceGrantId: grant.grantId });

      expect(created.snapshot.indexStats?.indexedFiles).toBe(1);
      expect(created.snapshot.sources[0]).toEqual(expect.objectContaining({
        relativePath: 'runbook.xlsx',
        extractor: 'xlsx-text',
        extractorVersion: '1',
      }));
      expect(created.snapshot.chunks.some((chunk) => chunk.text.includes('审批后重启服务'))).toBe(true);
      expect(created.snapshot.pages[0]?.title).toBe('runbook');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
