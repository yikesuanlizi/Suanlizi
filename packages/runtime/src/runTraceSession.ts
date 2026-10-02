import type {
  RunTraceDraft,
  RunTraceEnvelope,
  RunTraceObservation,
  RunTraceRunKind,
  RunTraceSummary,
  ThreadId,
  TurnId,
} from '@suanlizi/protocol';
import { projectRunTrace } from './runTraceProjector.js';
import { redactTracePayload, type TraceRedactionOptions } from './runTraceRedaction.js';

export interface RunTraceSink {
  append(draft: RunTraceDraft): Promise<RunTraceEnvelope>;
  updateRun(runId: string, summary: RunTraceSummary): Promise<void>;
  publish(event: RunTraceEnvelope): void;
  reportFailure(error: unknown, draft: RunTraceDraft): void;
}

export class RunTraceSession {
  private tail: Promise<unknown> = Promise.resolve();
  private readonly events: RunTraceEnvelope[] = [];
  private finished = false;

  constructor(private readonly input: {
    runId: string;
    parentRunId?: string;
    runKind: RunTraceRunKind;
    threadId: ThreadId;
    turnId?: TurnId | null;
    sink: RunTraceSink;
    redaction?: TraceRedactionOptions;
  }) {}

  record(observation: RunTraceObservation): Promise<RunTraceEnvelope | null> {
    const draft = this.draftFromObservation(observation);
    return this.enqueue(() => this.writeDraft(draft));
  }

  async finish(input: { status: 'completed' | 'failed' | 'interrupted'; error?: unknown }): Promise<void> {
    if (this.finished) return;
    this.finished = true;
    const lifecycle = input.status === 'completed' ? 'completed' : 'failed';
    const draft: RunTraceDraft = {
      runId: this.input.runId,
      parentRunId: this.input.parentRunId,
      runKind: this.input.runKind,
      threadId: this.input.threadId,
      turnId: this.input.turnId ?? (this.input.runKind === 'turn' ? undefined : null),
      spanId: `span:${this.input.runId}:root:${this.input.runKind}`,
      category: this.input.runKind === 'control' ? 'control' : 'turn',
      name: `${this.input.runKind} ${input.status}`,
      lifecycle,
      level: input.status === 'completed' ? 'info' : 'error',
      occurredAt: new Date().toISOString(),
      payload: this.input.runKind === 'control'
        ? { action: 'interrupt', outcome: input.status === 'completed' ? 'completed' : 'rejected', reason: input.error instanceof Error ? input.error.message : undefined }
        : { status: input.status },
    } as RunTraceDraft;
    await this.enqueue(() => this.writeDraft(draft));
  }

  async flush(): Promise<void> {
    await this.tail;
  }

  private draftFromObservation(observation: RunTraceObservation): RunTraceDraft {
    return {
      ...observation,
      runId: this.input.runId,
      parentRunId: this.input.parentRunId,
      runKind: this.input.runKind,
      threadId: this.input.threadId,
      turnId: this.input.turnId ?? (this.input.runKind === 'turn' ? undefined : null),
      payload: redactTracePayload(observation.payload, this.input.redaction) as never,
    } as RunTraceDraft;
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.tail.catch(() => undefined).then(operation);
    this.tail = next.catch(() => undefined);
    return next;
  }

  private async writeDraft(draft: RunTraceDraft): Promise<RunTraceEnvelope | null> {
    let envelope: RunTraceEnvelope;
    try {
      envelope = await this.input.sink.append(draft);
    } catch (error) {
      this.input.sink.reportFailure(error, draft);
      return null;
    }
    this.events.push(envelope);
    const summary = projectRunTrace(this.events);
    try {
      await this.input.sink.updateRun(this.input.runId, summary);
    } catch (error) {
      this.input.sink.reportFailure(error, draft);
    }
    this.input.sink.publish(envelope);
    return envelope;
  }
}
