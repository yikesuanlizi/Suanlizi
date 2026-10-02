import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { RunMonitorDrawer } from './RunMonitorDrawer.js';
import type { RunTraceCategory, RunTraceEnvelope } from '@suanlizi/protocol';
import type { RunEvent, RunRecord, ThreadWithRuns } from '../shared/types.js';

const here = dirname(fileURLToPath(import.meta.url));

const run: RunRecord = {
  runId: 'run-1',
  tenantId: 'tenantA',
  threadId: 'thread-1',
  turnId: 'turn-1',
  kind: 'turn',
  status: 'running',
  caller: 'lead_agent',
  activeStep: 'tool',
  inputTokens: 10,
  cachedInputTokens: 2,
  outputTokens: 5,
  reasoningOutputTokens: 0,
  toolCallCount: 1,
  modelCallCount: 1,
  subagentCount: 0,
  middlewareEventCount: 2,
  startedAt: '2026-06-16T00:00:00.000Z',
  updatedAt: '2026-06-16T00:00:01.000Z',
};

const events: RunEvent[] = [{
  eventId: 'event-1',
  runId: 'run-1',
  tenantId: 'tenantA',
  threadId: 'thread-1',
  turnId: 'turn-1',
  sequence: 1,
  category: 'tool',
  type: 'tool.completed',
  level: 'info',
  message: 'current_time completed',
  toolName: 'current_time',
  metadata: { status: 'completed' },
  createdAt: '2026-06-16T00:00:01.000Z',
}];

const traces: RunTraceEnvelope[] = [{
  version: 2,
  eventId: 'trace-1',
  sequence: 1,
  runId: 'run-1',
  runKind: 'turn',
  threadId: 'thread-1',
  turnId: 'turn-1',
  spanId: 'span:run-1:tool:current_time',
  category: 'tool',
  name: 'tool.completed',
  lifecycle: 'completed',
  level: 'info',
  occurredAt: '2026-06-16T00:00:01.000Z',
  payload: { toolName: 'current_time', callId: 'call-1' },
}];

const threads: ThreadWithRuns[] = [{
  threadId: 'thread-1',
  title: 'Test Thread',
  tenantId: 'tenantA',
  status: 'active',
  runCount: 1,
  lastActiveAt: '2026-06-16T00:00:01.000Z',
}];

const allCategories: RunTraceCategory[] = ['turn', 'iteration', 'context', 'memory', 'middleware', 'model', 'tool', 'approval', 'item', 'agent', 'file', 'checkpoint', 'evidence', 'error', 'control'];

const baseProps = {
  zh: true,
  open: true,
  threadId: 'thread-1',
  runs: [run],
  events,
  traces,
  visibleTraces: traces,
  selectedRunId: 'run-1',
  selectedRun: run,
  selectedEventId: '',
  traceFocusVersion: 0,
  selectedTrace: null,
  categoryFilter: [] as RunTraceCategory[],
  errorsOnly: false,
  tracePage: null,
  threads,
  expandedThreadId: 'thread-1',
  autoRefresh: false,
  autoRefreshInterval: 5000,
  loading: false,
  loadError: null,
  allCategories,
  onClose: vi.fn(),
  onRefresh: vi.fn(),
  onSelectRun: vi.fn(),
  onControlRun: vi.fn(),
  onToggleThread: vi.fn(),
  onSelectEvent: vi.fn(),
  onToggleCategory: vi.fn(),
  onSetCategoryFilter: vi.fn(),
  onSetErrorsOnly: vi.fn(),
  onAutoRefreshChange: vi.fn(),
  onAutoRefreshIntervalChange: vi.fn(),
  onLoadOlder: vi.fn(),
};

describe('RunMonitorDrawer', () => {
  it('renders workbench with explorer, timeline, inspector columns', () => {
    const html = renderToStaticMarkup(React.createElement(RunMonitorDrawer, baseProps));
    expect(html).toContain('runMonitorWorkbench');
    expect(html).toContain('runExplorer');
    expect(html).toContain('traceTimeline');
  });

  it('returns empty string when closed', () => {
    const html = renderToStaticMarkup(React.createElement(RunMonitorDrawer, { ...baseProps, open: false }));
    expect(html).toBe('');
  });

  it('renders trace timeline with trace data', () => {
    const html = renderToStaticMarkup(React.createElement(RunMonitorDrawer, { ...baseProps, selectedEventId: 'trace-1', selectedTrace: traces[0] ?? null }));
    expect(html).toContain('traceRow');
    expect(html).toContain('tool.completed');
  });

  it('renders newest trace records first in the timeline', () => {
    const older = { ...traces[0], eventId: 'trace-old', sequence: 1, name: 'older.trace' } as RunTraceEnvelope;
    const newer = { ...traces[0], eventId: 'trace-new', sequence: 2, name: 'newer.trace' } as RunTraceEnvelope;
    const html = renderToStaticMarkup(React.createElement(RunMonitorDrawer, {
      ...baseProps,
      traces: [older, newer],
      visibleTraces: [older, newer],
    }));

    expect(html.indexOf('newer.trace')).toBeGreaterThan(-1);
    expect(html.indexOf('older.trace')).toBeGreaterThan(-1);
    expect(html.indexOf('newer.trace')).toBeLessThan(html.indexOf('older.trace'));
  });

  it('renders resource details for MCP and skill traces in the inspector', () => {
    const mcpTrace = {
      ...traces[0],
      eventId: 'trace-mcp',
      name: 'mcp.tool.completed',
      payload: {
        toolName: 'mcp_call_tool',
        callId: 'call-mcp',
        server: 'gitnexus',
        tool: 'search_code',
        argsSummary: { query: 'resource detail' },
      },
    } as unknown as RunTraceEnvelope;
    const skillTrace = {
      ...traces[0],
      eventId: 'trace-skill',
      name: 'skill.used',
      payload: {
        toolName: 'skills_add',
        callId: 'call-skill',
        skillName: 'frontend-design',
      },
    } as unknown as RunTraceEnvelope;

    const mcpHtml = renderToStaticMarkup(React.createElement(RunMonitorDrawer, {
      ...baseProps,
      traces: [mcpTrace],
      visibleTraces: [mcpTrace],
      selectedEventId: 'trace-mcp',
      selectedTrace: mcpTrace,
    }));
    const skillHtml = renderToStaticMarkup(React.createElement(RunMonitorDrawer, {
      ...baseProps,
      traces: [skillTrace],
      visibleTraces: [skillTrace],
      selectedEventId: 'trace-skill',
      selectedTrace: skillTrace,
    }));

    expect(mcpHtml).toContain('resourceKind');
    expect(mcpHtml).toContain('MCP');
    expect(mcpHtml).toContain('server');
    expect(mcpHtml).toContain('gitnexus');
    expect(mcpHtml).toContain('search_code');
    expect(skillHtml).toContain('resourceKind');
    expect(skillHtml).toContain('Skill');
    expect(skillHtml).toContain('frontend-design');
  });

  it('clears category filters in one action when All is clicked', () => {
    const filtersSource = readFileSync(join(here, 'monitor', 'TraceFilters.tsx'), 'utf-8');
    const timelineSource = readFileSync(join(here, 'monitor', 'TraceTimeline.tsx'), 'utf-8');
    const monitorSource = readFileSync(join(here, '..', 'features', 'monitor', 'runMonitor.ts'), 'utf-8');

    expect(filtersSource).toContain('onSetCategoryFilter([])');
    expect(filtersSource).not.toContain('for (const c of selectedCategories)');
    expect(timelineSource).toContain('onSetCategoryFilter');
    expect(monitorSource).toContain('setCategoryFilter');
    expect(monitorSource).not.toContain('[open, state.categoryFilter, state.errorsOnly, refresh]');
  });

  it('queues activity trace jumps until trace data is available', () => {
    const monitorSource = readFileSync(join(here, '..', 'features', 'monitor', 'runMonitor.ts'), 'utf-8');
    const stateSource = readFileSync(join(here, '..', 'features', 'monitor', 'runMonitorState.ts'), 'utf-8');
    const appSource = readFileSync(join(here, '..', 'main.tsx'), 'utf-8');

    expect(monitorSource).toContain('focusTraceTarget');
    expect(monitorSource).toContain("dispatch({ type: 'queue-trace-target'");
    expect(stateSource).toContain('pendingTraceTarget');
    expect(stateSource).toContain('resolveTraceTarget');
    expect(appSource).toContain('runMonitor.focusTraceTarget');
    expect(appSource).not.toContain('setTimeout(() => runMonitor.selectByItemId');
  });

  it('scrolls the selected trace row into view after selection', () => {
    const timelineSource = readFileSync(join(here, 'monitor', 'TraceTimeline.tsx'), 'utf-8');
    const styles = readFileSync(join(here, '..', 'styles.css'), 'utf-8');

    expect(timelineSource).toContain('selectedRowRef');
    expect(timelineSource).toContain("scrollIntoView({ block: 'center', behavior: 'smooth' })");
    expect(timelineSource).toContain('[selectedEventId, focusVersion]');
    expect(timelineSource).not.toContain('[selectedEventId, traces]');
    expect(timelineSource).toContain('data-event-id={trace.eventId}');
    expect(styles).toContain('.traceRow--jumped');
    expect(styles).toContain('@keyframes traceRowJumpPulse');
  });

  it('uses compact monitor typography and spacing', () => {
    const styles = readFileSync(join(here, '..', 'styles.css'), 'utf-8');

    expect(styles).toContain('/* Run monitor compact density + jump target affordance. */');
    expect(styles).toContain('.runMonitorPanel {\n  font-size: 12px;');
    expect(styles).toContain('.runMonitorHeader__title {\n  font-size: 14px;');
    expect(styles).toContain('.traceChip {\n  min-height: 23px;');
    expect(styles).toContain('.traceRow {\n  grid-template-columns: 22px auto auto minmax(0, 1fr) auto;');
    expect(styles).toContain('padding: 7px 8px;');
  });
});
