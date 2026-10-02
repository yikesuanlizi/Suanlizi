import type { RunTraceEnvelope, RunTraceSummary } from '@suanlizi/protocol';

export function projectRunTrace(input: RunTraceEnvelope[]): RunTraceSummary {
  const seen = new Set<string>();
  const events = [...input]
    .sort((a, b) => a.sequence - b.sequence)
    .filter((event) => {
      if (seen.has(event.eventId)) return false;
      seen.add(event.eventId);
      return true;
    });
  const countedToolCalls = new Set<string>();

  const summary: RunTraceSummary = {
    status: 'pending',
    model: { calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    tools: { calls: 0, failed: 0, denied: 0 },
    approvals: { decisions: 0, prompts: 0, allowed: 0, denied: 0 },
    items: { started: 0, completed: 0, failed: 0, byType: {} },
    agents: { spawned: 0, running: 0, failed: 0 },
    files: { reads: 0, changed: 0, addedLines: 0, removedLines: 0, extracted: 0, reused: 0, stale: 0, refreshed: 0 },
  };

  for (const event of events) {
    if (event.lifecycle === 'started') {
      summary.currentSpan = { spanId: event.spanId, category: event.category, name: event.name };
    } else if (summary.currentSpan?.category === event.category) {
      summary.currentSpan = undefined;
    }
    if (event.category === 'turn') {
      if (event.lifecycle === 'started') {
        summary.status = 'running';
        summary.startedAt ??= event.occurredAt;
      } else if (event.lifecycle === 'completed') {
        summary.status = event.payload.status === 'interrupted' ? 'interrupted' : 'completed';
        summary.completedAt = event.occurredAt;
        summary.durationMs = event.durationMs;
        summary.currentSpan = undefined;
      } else if (event.lifecycle === 'failed') {
        summary.status = 'failed';
        summary.completedAt = event.occurredAt;
        summary.durationMs = event.durationMs;
        summary.currentSpan = undefined;
      }
      continue;
    }

    switch (event.category) {
      case 'model':
        summary.model.providerId = event.payload.providerId ?? event.payload.provider;
        summary.model.model = event.payload.model;
        summary.model.endpointFormat = event.payload.endpointFormat;
        summary.model.transport = event.payload.transport;
        summary.model.reasoningMode = event.payload.reasoningMode;
        summary.model.toolHistoryMode = event.payload.toolHistoryMode;
        if (event.lifecycle === 'completed') {
          summary.model.calls += 1;
          summary.model.inputTokens += event.payload.inputTokens ?? 0;
          summary.model.outputTokens += event.payload.outputTokens ?? 0;
          summary.model.cacheReadTokens += event.payload.cacheReadTokens ?? 0;
          summary.model.cacheWriteTokens += event.payload.cacheWriteTokens ?? 0;
          if (event.payload.ttftMs !== undefined) {
            summary.model.maxTtftMs = Math.max(summary.model.maxTtftMs ?? 0, event.payload.ttftMs);
          }
        }
        break;
      case 'tool':
        if (event.name.startsWith('tool.batch.')) break;
        if (countedToolCalls.has(event.payload.callId)) break;
        countedToolCalls.add(event.payload.callId);
        summary.tools.calls += 1;
        if (event.lifecycle === 'failed') summary.tools.failed += 1;
        if (event.payload.decision === 'deny') summary.tools.denied += 1;
        break;
      case 'item':
        if (event.lifecycle === 'started') summary.items.started += 1;
        if (event.lifecycle === 'completed') summary.items.completed += 1;
        if (event.lifecycle === 'failed' || event.payload.status === 'failed') summary.items.failed += 1;
        summary.items.byType[event.payload.itemType] = (summary.items.byType[event.payload.itemType] ?? 0) + 1;
        break;
      case 'agent':
        if (event.payload.action === 'spawn') summary.agents.spawned += 1;
        if (event.payload.action === 'started') summary.agents.running += 1;
        if (event.payload.action === 'failed') summary.agents.failed += 1;
        break;
      case 'file':
        if (event.lifecycle === 'completed' || event.lifecycle === 'instant') {
          if (event.payload.action === 'read') summary.files.reads += 1;
          if (event.payload.action === 'extract') summary.files.extracted += 1;
          if (event.payload.action === 'reuse') summary.files.reused += 1;
          if (event.payload.action === 'stale') summary.files.stale += 1;
          if (event.payload.action === 'refresh') summary.files.refreshed += 1;
          if (['write', 'patch', 'delete', 'checkpoint'].includes(event.payload.action)) {
            summary.files.changed += 1;
            summary.files.addedLines += event.payload.addedLines ?? 0;
            summary.files.removedLines += event.payload.removedLines ?? 0;
          }
        }
        break;
      case 'checkpoint':
        summary.lastCheckpointId = event.payload.checkpointId;
        break;
      case 'approval':
        if (event.name === 'access.decision' || event.payload.decision) {
          summary.approvals ??= { decisions: 0, prompts: 0, allowed: 0, denied: 0 };
          summary.approvals.decisions += 1;
          if (event.payload.decision === 'allow') summary.approvals.allowed += 1;
          if (event.payload.decision === 'deny') summary.approvals.denied += 1;
        } else if (event.name === 'approval.required' || event.payload.status === 'required') {
          summary.approvals ??= { decisions: 0, prompts: 0, allowed: 0, denied: 0 };
          summary.approvals.prompts += 1;
        } else if (event.name === 'access.temporary_grant' || event.payload.status === 'granted') {
          summary.approvals ??= { decisions: 0, prompts: 0, allowed: 0, denied: 0 };
          summary.approvals.allowed += 1;
        } else if (event.name === 'access.temporary_deny' || event.payload.status === 'denied') {
          summary.approvals ??= { decisions: 0, prompts: 0, allowed: 0, denied: 0 };
          summary.approvals.denied += 1;
        }
        break;
      case 'error':
        summary.lastError = { code: event.payload.code, message: event.payload.message };
        if (summary.status !== 'completed') summary.status = 'failed';
        break;
      default:
        break;
    }
  }

  return summary;
}
