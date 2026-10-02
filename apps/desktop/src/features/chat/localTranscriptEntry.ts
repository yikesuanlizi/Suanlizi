import type { ThreadId } from '@suanlizi/protocol';
import type { ThreadItem } from '../../shared/types.js';

export type CanonicalTranscriptEntry = { source: 'canonical'; item: ThreadItem };
export type LocalTranscriptEntry = { source: 'local'; correlationId: string; threadId: ThreadId; item: ThreadItem };
export type TranscriptEntry = CanonicalTranscriptEntry | LocalTranscriptEntry;

export interface ReconcileResult {
  entries: TranscriptEntry[];
  removedCorrelationIds: string[];
}

export function reconcileCanonicalItems(
  entries: TranscriptEntry[],
  canonicalItems: ThreadItem[],
  correlationId: string,
): ReconcileResult {
  const removedCorrelationIds: string[] = [];
  const kept: TranscriptEntry[] = [];
  for (const entry of entries) {
    if (entry.source === 'local' && entry.correlationId === correlationId) {
      if (!removedCorrelationIds.includes(correlationId)) {
        removedCorrelationIds.push(correlationId);
      }
    } else {
      kept.push(entry);
    }
  }
  const canonicalEntries: TranscriptEntry[] = canonicalItems.map((item) => ({ source: 'canonical', item }));
  return { entries: [...kept, ...canonicalEntries], removedCorrelationIds };
}

export function removeLocalEntry(
  entries: TranscriptEntry[],
  correlationId: string,
): TranscriptEntry[] {
  return entries.filter(
    (entry) => !(entry.source === 'local' && entry.correlationId === correlationId),
  );
}

export function clearThreadLocalEntries(
  entries: TranscriptEntry[],
  threadId: ThreadId,
): TranscriptEntry[] {
  return entries.filter(
    (entry) => !(entry.source === 'local' && entry.threadId === threadId),
  );
}

export function toCanonicalEntries(items: ThreadItem[]): TranscriptEntry[] {
  return items.map((item) => ({ source: 'canonical', item }));
}

export function createLocalEntry(
  correlationId: string,
  threadId: ThreadId,
  item: ThreadItem,
): LocalTranscriptEntry {
  return { source: 'local', correlationId, threadId, item };
}
