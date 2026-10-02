import type { RunTraceCategory, RunTraceDraft, RunTraceEnvelope, RunTracePage } from '@suanlizi/protocol';

export interface RunTraceQuery {
  before?: number;
  after?: number;
  limit?: number;
  categories?: RunTraceCategory[];
  errorsOnly?: boolean;
}

export interface RunTraceStore {
  appendRunTraceEvent(draft: RunTraceDraft): Promise<RunTraceEnvelope>;
  listRunTraceEvents(runId: string, query?: RunTraceQuery): Promise<RunTracePage>;
  getRunTraceHead(runId: string): Promise<number>;
}
