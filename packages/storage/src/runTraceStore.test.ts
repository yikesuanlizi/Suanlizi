import { describe, expect, it } from 'vitest';
import { createStore } from './index.js';
import type { RunTraceDraft } from '@suanlizi/protocol';
import type { RunRecord, ThreadStore } from './store.js';
import type { RunTraceStore } from './runTraceStore.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function traceStore(): ThreadStore & RunTraceStore {
  return createStore(mkdtempSync(join(tmpdir(), 'suanlizi-run-trace-store-'))).store as ThreadStore & RunTraceStore;
}

function runRecord(runId = 'run-a', threadId = 'thread-a'): RunRecord {
  const now = '2026-07-21T00:00:00.000Z';
  return {
    runId,
    threadId,
    turnId: 'turn-a',
    kind: 'turn',
    status: 'running',
    caller: 'lead_agent',
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    toolCallCount: 0,
    modelCallCount: 0,
    subagentCount: 0,
    middlewareEventCount: 0,
    startedAt: now,
    updatedAt: now,
  };
}

function modelDraft(runId = 'run-a', index = 1): RunTraceDraft {
  return {
    runId,
    runKind: 'turn',
    threadId: 'thread-a',
    turnId: 'turn-a',
    spanId: `span:${runId}:model:${index}`,
    category: 'model',
    name: `model ${index}`,
    lifecycle: 'started',
    level: 'info',
    occurredAt: `2026-07-21T00:00:0${index}.000Z`,
    payload: {
      provider: 'openai',
      model: 'gpt-5',
      attempt: index,
      streaming: true,
    },
  };
}

describe('RunTraceStore contract', () => {
  it('assigns strictly increasing sequence numbers per run', async () => {
    const store = traceStore();
    await store.createRunRecord!(runRecord());

    const first = await store.appendRunTraceEvent(modelDraft('run-a', 1));
    const second = await store.appendRunTraceEvent(modelDraft('run-a', 2));

    expect(first).toEqual(expect.objectContaining({ version: 2, sequence: 1, runId: 'run-a' }));
    expect(second).toEqual(expect.objectContaining({ version: 2, sequence: 2, runId: 'run-a' }));
    expect(second.eventId).not.toBe(first.eventId);
    await expect(store.getRunTraceHead('run-a')).resolves.toBe(2);
  });

  it('returns the latest page in ascending sequence order', async () => {
    const store = traceStore();
    await store.createRunRecord!(runRecord());
    for (let index = 1; index <= 5; index++) {
      await store.appendRunTraceEvent(modelDraft('run-a', index));
    }

    const page = await store.listRunTraceEvents('run-a', { limit: 3 });

    expect(page.events.map((event) => event.sequence)).toEqual([3, 4, 5]);
    expect(page.hasMoreBefore).toBe(true);
    expect(page.hasMoreAfter).toBe(false);
    expect(page.nextBefore).toBe(3);
    expect(page.nextAfter).toBe(5);
  });

  it('supports before and after cursors as exclusive bounds', async () => {
    const store = traceStore();
    await store.createRunRecord!(runRecord());
    for (let index = 1; index <= 5; index++) {
      await store.appendRunTraceEvent(modelDraft('run-a', index));
    }

    await expect(store.listRunTraceEvents('run-a', { after: 2, limit: 2 }))
      .resolves.toMatchObject({ events: [{ sequence: 3 }, { sequence: 4 }], hasMoreAfter: true });
    await expect(store.listRunTraceEvents('run-a', { before: 4, limit: 2 }))
      .resolves.toMatchObject({ events: [{ sequence: 2 }, { sequence: 3 }], hasMoreBefore: true });
  });

  it('rejects invalid cursors and runs outside the current tenant', async () => {
    const root = traceStore();
    const tenantA = root.scope!('tenantA') as ThreadStore & RunTraceStore;
    const tenantB = root.scope!('tenantB') as ThreadStore & RunTraceStore;
    await tenantA.createRunRecord!(runRecord('run-a'));

    await expect(tenantA.listRunTraceEvents('run-a', { before: 3, after: 1 }))
      .rejects.toThrow('INVALID_CURSOR');
    await expect(tenantB.appendRunTraceEvent(modelDraft('run-a', 1)))
      .rejects.toThrow('RUN_NOT_FOUND');
    await expect(tenantB.listRunTraceEvents('run-a')).resolves.toEqual({
      events: [],
      hasMoreBefore: false,
      hasMoreAfter: false,
    });
  });
});
