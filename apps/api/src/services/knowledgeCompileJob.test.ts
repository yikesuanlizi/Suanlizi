import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ThreadStore } from '@suanlizi/storage';
import {
  actOnKnowledgeJob,
  getKnowledgeJob,
  startKnowledgeBaseCreateJob,
} from './knowledgeCompileJob.js';
import { authorizeKnowledgeDirectory, getKnowledgeBase } from './knowledgeBase.js';

class FakeStore implements Partial<ThreadStore> {
  private readonly settings = new Map<string, unknown>();

  async getSetting<T = unknown>(key: string): Promise<T | null> {
    return (this.settings.get(key) as T | undefined) ?? null;
  }

  async setSetting(key: string, value: unknown): Promise<void> {
    this.settings.set(key, value);
  }
}

async function waitForJob(store: ThreadStore, jobId: string, status: string): Promise<Awaited<ReturnType<typeof getKnowledgeJob>>> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const job = await getKnowledgeJob(store, jobId, 'tenant-job-test');
    if (job?.status === status) return job;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return getKnowledgeJob(store, jobId, 'tenant-job-test');
}

describe('knowledge compile jobs', () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it('compiles asynchronously and publishes a ready snapshot only at completion', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'suanlizi-kb-job-'));
    roots.push(root);
    await writeFile(path.join(root, 'runbook.md'), '# Restart\nApproval is required.\n', 'utf8');
    const store = new FakeStore() as unknown as ThreadStore;
    const grant = await authorizeKnowledgeDirectory(store, 'tenant-job-test', root);
    const started = await startKnowledgeBaseCreateJob(store, 'tenant-job-test', { name: 'Jobs', sourceGrantId: grant.grantId });
    expect(started.job.status).toBe('queued');
    expect((await getKnowledgeBase(store, started.base.knowledgeBaseId, 'tenant-job-test'))?.currentSnapshotId).toBeUndefined();
    const completed = await waitForJob(store, started.job.jobId, 'completed');
    expect(completed?.snapshotId).toBeTruthy();
    expect((await getKnowledgeBase(store, started.base.knowledgeBaseId, 'tenant-job-test'))?.currentSnapshotId).toBe(completed?.snapshotId);
  });

  it('supports queued pause and resume without persisting source text in pending cache', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'suanlizi-kb-job-pause-'));
    roots.push(root);
    await writeFile(path.join(root, 'manual.md'), '# Manual\nDo not persist this source text.\n', 'utf8');
    const store = new FakeStore() as unknown as ThreadStore;
    const grant = await authorizeKnowledgeDirectory(store, 'tenant-job-test', root);
    const started = await startKnowledgeBaseCreateJob(store, 'tenant-job-test', { name: 'Pause', sourceGrantId: grant.grantId, persistPending: true });
    const paused = await actOnKnowledgeJob(store, 'tenant-job-test', started.job.jobId, 'pause');
    expect(['paused', 'queued', 'scanning', 'extracting', 'indexing']).toContain(paused.status);
    const pausedFinal = paused.status === 'paused' ? paused : await waitForJob(store, started.job.jobId, 'paused');
    expect(pausedFinal?.status).toBe('paused');
    const persisted = await store.getSetting<unknown>('knowledge.catalog.v1:personal');
    expect(JSON.stringify(persisted)).not.toContain('Do not persist this source text');
    const resumed = await actOnKnowledgeJob(store, 'tenant-job-test', started.job.jobId, 'resume');
    expect(resumed.status).toBe('queued');
    expect((await waitForJob(store, started.job.jobId, 'completed'))?.status).toBe('completed');
  });

  it('cancels before finalization and leaves the base without a ready snapshot', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'suanlizi-kb-job-cancel-'));
    roots.push(root);
    await writeFile(path.join(root, 'manual.md'), '# Manual\nCancel this compile.\n', 'utf8');
    const store = new FakeStore() as unknown as ThreadStore;
    const grant = await authorizeKnowledgeDirectory(store, 'tenant-job-test', root);
    const started = await startKnowledgeBaseCreateJob(store, 'tenant-job-test', { name: 'Cancel', sourceGrantId: grant.grantId });
    const cancelled = await actOnKnowledgeJob(store, 'tenant-job-test', started.job.jobId, 'cancel');
    expect(cancelled.status).toBe('cancelled');
    expect((await getKnowledgeBase(store, started.base.knowledgeBaseId, 'tenant-job-test'))?.currentSnapshotId).toBeUndefined();
    expect((await getKnowledgeJob(store, started.job.jobId, 'tenant-job-test'))?.status).toBe('cancelled');
  });
});
