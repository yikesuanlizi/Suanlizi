import { describe, expect, it } from 'vitest';
import { RUN_TRACE_VERSION, type RunTraceDraft, type RunTraceEnvelope, type RunTraceObservation } from '@suanlizi/protocol';
import { RunTraceSession, type RunTraceSink } from './runTraceSession.js';

function observation(index: number): RunTraceObservation {
  return {
    runKind: 'turn',
    spanId: `span-model-${index}`,
    category: 'model',
    name: `model ${index}`,
    lifecycle: 'started',
    level: 'info',
    occurredAt: `2026-07-21T00:00:0${index}.000Z`,
    payload: { provider: 'openai', model: 'gpt-5', attempt: index, streaming: true },
  };
}

function createSink(failFirstAppend = false): RunTraceSink & { events: RunTraceEnvelope[]; failures: unknown[] } {
  let sequence = 0;
  let failed = false;
  const events: RunTraceEnvelope[] = [];
  const failures: unknown[] = [];
  return {
    events,
    failures,
    async append(draft: RunTraceDraft): Promise<RunTraceEnvelope> {
      if (failFirstAppend && !failed) {
        failed = true;
        throw new Error('append failed');
      }
      const envelope = {
        ...draft,
        version: RUN_TRACE_VERSION,
        eventId: `event-${++sequence}`,
        sequence,
      } as RunTraceEnvelope;
      events.push(envelope);
      return envelope;
    },
    async updateRun(): Promise<void> {},
    publish(): void {},
    reportFailure(error: unknown): void {
      failures.push(error);
    },
  };
}

describe('RunTraceSession', () => {
  it('serializes observations and writes terminal root last', async () => {
    const sink = createSink();
    const session = new RunTraceSession({
      runId: 'run-a',
      runKind: 'turn',
      threadId: 'thread-a',
      turnId: 'turn-a',
      sink,
    });

    await Promise.all([session.record(observation(1)), session.record(observation(2))]);
    await session.finish({ status: 'completed' });

    expect(sink.events.map((event) => event.sequence)).toEqual([1, 2, 3]);
    expect(sink.events.at(-1)).toMatchObject({
      category: 'turn',
      lifecycle: 'completed',
      spanId: 'span:run-a:root:turn',
      payload: { status: 'completed' },
    });
  });

  it('reports append failures without poisoning later observations', async () => {
    const sink = createSink(true);
    const session = new RunTraceSession({
      runId: 'run-a',
      runKind: 'turn',
      threadId: 'thread-a',
      turnId: 'turn-a',
      sink,
    });

    await expect(session.record(observation(1))).resolves.toBeNull();
    await expect(session.record(observation(2))).resolves.toMatchObject({ sequence: 1 });

    expect(sink.failures).toHaveLength(1);
    expect(sink.events).toHaveLength(1);
  });
});
