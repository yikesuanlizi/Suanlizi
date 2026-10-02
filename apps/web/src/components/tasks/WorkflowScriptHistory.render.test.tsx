// P5：历史脚本区静态渲染测试（web；desktop 同构）。
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { WorkflowScriptHistory } from './WorkflowScriptHistory.js';
import type { WorkflowScriptHistoryEntry } from '../../api/workflowScriptClient.js';

const ENTRY: WorkflowScriptHistoryEntry = {
  runId: 'wfrun_1',
  taskRunId: 'taskrun_1',
  scriptHash: 'abcdef1234567890'.padEnd(64, '0'),
  script: 'export const meta = { name: "old", description: "d", phases: ["p1"] };\nreturn 1;',
  status: 'completed',
  startedAt: '2026-09-20T00:00:00.000Z',
  completedAt: '2026-09-20T00:01:00.000Z',
  usage: { inputTokens: 120, outputTokens: 48, agentCallCount: 1, durationMs: 1500 },
  evidenceId: 'wev_wfrun_1_run',
};

describe('WorkflowScriptHistory 渲染', () => {
  it('空历史不渲染任何容器', () => {
    const html = renderToStaticMarkup(
      React.createElement(WorkflowScriptHistory, { locale: 'zh', scripts: [], currentScript: '', onLoad: vi.fn() }),
    );
    expect(html).toBe('');
  });

  it('展示 hash、成本统计、状态与载入/对比操作', () => {
    const html = renderToStaticMarkup(
      React.createElement(WorkflowScriptHistory, { locale: 'zh', scripts: [ENTRY], currentScript: ENTRY.script, onLoad: vi.fn() }),
    );
    expect(html).toContain('历史脚本');
    expect(html).toContain('abcdef12');
    expect(html).toContain('168 tok · 1 agent');
    expect(html).toContain('已完成');
    expect(html).toContain('载入');
    expect(html).toContain('对比');
    // 未展开对比时不显示差异摘要。
    expect(html).not.toContain('与当前脚本一致');
  });

  it('英文 locale 切换文案与状态原样展示', () => {
    const html = renderToStaticMarkup(
      React.createElement(WorkflowScriptHistory, { locale: 'en', scripts: [{ ...ENTRY, status: 'interrupted' }], currentScript: '', onLoad: vi.fn() }),
    );
    expect(html).toContain('Saved scripts');
    expect(html).toContain('Load');
    expect(html).toContain('Compare');
    expect(html).toContain('interrupted');
  });
});
