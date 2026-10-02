import type { ThreadEvent } from '@suanlizi/protocol';

export interface SequencedThreadEvent {
  sequence: number;
  event: ThreadEvent;
  emittedAt: string;
}

export interface ThreadEventReplay {
  events: SequencedThreadEvent[];
  oldestSequence: number | null;
  latestSequence: number;
  truncated: boolean;
}

/**
 * 有界的线程事件回放缓存。
 *
 * 事件只用于 SSE 断线重连窗口，不是持久化审计存储；API 重启后由线程快照
 * 恢复状态。按 tenant/thread 分桶，避免一个线程或租户影响其他连接。
 */
export class ThreadEventHistory {
  private readonly buckets = new Map<string, { nextSequence: number; events: SequencedThreadEvent[] }>();

  constructor(private readonly maxEventsPerThread = 500) {
    if (!Number.isSafeInteger(maxEventsPerThread) || maxEventsPerThread < 1) {
      throw new RangeError('maxEventsPerThread must be a positive safe integer');
    }
  }

  append(tenantId: string, threadId: string, event: ThreadEvent): SequencedThreadEvent {
    const key = this.key(tenantId, threadId);
    const bucket = this.buckets.get(key) ?? { nextSequence: 1, events: [] };
    const entry: SequencedThreadEvent = {
      sequence: bucket.nextSequence,
      event,
      emittedAt: new Date().toISOString(),
    };
    bucket.nextSequence += 1;
    bucket.events.push(entry);
    if (bucket.events.length > this.maxEventsPerThread) {
      bucket.events.splice(0, bucket.events.length - this.maxEventsPerThread);
    }
    this.buckets.set(key, bucket);
    return entry;
  }

  replayAfter(tenantId: string, threadId: string, afterSequence: number): ThreadEventReplay {
    const bucket = this.buckets.get(this.key(tenantId, threadId));
    if (!bucket || bucket.events.length === 0) {
      return { events: [], oldestSequence: null, latestSequence: Math.max(0, (bucket?.nextSequence ?? 1) - 1), truncated: false };
    }
    const oldestSequence = bucket.events[0].sequence;
    const latestSequence = bucket.events.at(-1)?.sequence ?? 0;
    return {
      events: bucket.events.filter((entry) => entry.sequence > afterSequence),
      oldestSequence,
      latestSequence,
      truncated: afterSequence < oldestSequence - 1,
    };
  }

  clearThread(tenantId: string, threadId: string): void {
    this.buckets.delete(this.key(tenantId, threadId));
  }

  private key(tenantId: string, threadId: string): string {
    return `${tenantId}\u0000${threadId}`;
  }
}
