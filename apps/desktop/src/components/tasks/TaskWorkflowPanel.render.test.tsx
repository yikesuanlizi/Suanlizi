// Goal 动态工作流面板：无提案时只说明状态；只有 GoalRun 提案后才出现审阅/批准入口。
// 通用 JS 编辑器与手工启动入口必须不再出现在初始 UI。
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { TaskWorkflowPanel, WorkflowRequestList } from './TaskWorkflowPanel.js';
import type { WorkflowPendingRequest } from '../../api/workflowScriptClient.js';

vi.mock('../../api/workflowScriptClient.js', () => ({
  WORKFLOW_TERMINAL_STATUSES: new Set(['completed', 'failed', 'cancelled']),
  fetchWorkflowRunResult: vi.fn(),
  cancelWorkflowRun: vi.fn(),
  fetchWorkflowRequests: vi.fn(async () => ({ taskId: 't1', requests: [] })),
  fetchWorkflowScripts: vi.fn(async () => ({ taskId: 't1', scripts: [] })),
  approveWorkflowRequest: vi.fn(),
  rejectWorkflowRequest: vi.fn(),
  startWorkflowRun: vi.fn(),
}));

const REQUEST: WorkflowPendingRequest = {
  id: 'wfrun_1',
  taskRunId: 'taskrun_1',
  goalRunId: 'goalrun_1',
  script: 'export const meta = { name: "batch-audit", description: "d", phases: ["p1"] };\nreturn 1;',
  status: 'blocked',
  startedAt: '2026-09-20T00:00:00.000Z',
  updatedAt: '2026-09-20T00:00:00.000Z',
};

function requestProps(overrides: Partial<React.ComponentProps<typeof WorkflowRequestList>> = {}) {
  return {
    locale: 'zh' as const,
    requests: [REQUEST],
    busy: false,
    editingRequestId: null,
    editedScript: '',
    onReview: vi.fn(),
    onEditedScriptChange: vi.fn(),
    onCancelReview: vi.fn(),
    onApproveOriginal: vi.fn(),
    onApproveEdited: vi.fn(),
    onReject: vi.fn(),
    ...overrides,
  };
}

describe('TaskWorkflowPanel 渲染', () => {
  it('没有动态工作流提案时只显示 Goal 状态说明，不显示手写脚本或手工启动入口', () => {
    const html = renderToStaticMarkup(React.createElement(TaskWorkflowPanel, { locale: 'zh', taskId: 't1' }));
    expect(html).toContain('当前 Goal 尚未提出动态工作流');
    expect(html).not.toContain('textarea');
    expect(html).not.toContain('校验');
    expect(html).not.toContain('批准并启动');
  });

  it('独立 Dynamic Workflow 的空态不伪装成 Goal 的附属提案', () => {
    const html = renderToStaticMarkup(React.createElement(TaskWorkflowPanel, {
      locale: 'zh',
      taskId: 'workflow_task',
      taskOrigin: 'explicit_workflow',
    }));
    expect(html).toContain('暂无脚本提案。请从输入栏重新创建 Dynamic Workflow。');
    expect(html).not.toContain('当前 Goal 尚未提出动态工作流');
  });

  it('英文 locale 下显示 Goal 导向的空态', () => {
    const html = renderToStaticMarkup(React.createElement(TaskWorkflowPanel, { locale: 'en', taskId: 't1' }));
    expect(html).toContain('This Goal has not proposed a dynamic workflow');
    expect(html).not.toContain('Validate');
  });
});

describe('WorkflowRequestList 渲染', () => {
  it('空请求列表不渲染任何容器', () => {
    const html = renderToStaticMarkup(React.createElement(WorkflowRequestList, requestProps({ requests: [] })));
    expect(html).toBe('');
  });

  it('未审阅时可直接批准原提案，编辑器保持隐藏', () => {
    const html = renderToStaticMarkup(React.createElement(WorkflowRequestList, requestProps()));
    expect(html).toContain('等待你批准的动态工作流提案');
    expect(html).toContain('batch-audit');
    expect(html).toContain('来源 Goal Run：goalrun_1');
    expect(html).toContain('审阅并编辑');
    expect(html).toContain('批准原提案');
    expect(html).toContain('拒绝');
    expect(html).not.toContain('textarea');
    expect(html).not.toContain('批准编辑后提案');
  });

  it('审阅模式才展示编辑器、差异与批准编辑后提案', () => {
    const html = renderToStaticMarkup(React.createElement(
      WorkflowRequestList,
      requestProps({
        editingRequestId: REQUEST.id,
        editedScript: `${REQUEST.script}\nconst extra = await agent('added step');`,
      }),
    ));
    expect(html).toContain('aria-label="动态工作流提案脚本"');
    expect(html).toContain('编辑差异：+1 / -0 行');
    expect(html).toContain('批准编辑后提案');
    expect(html).toContain('批准原提案');
    expect(html).toContain('取消编辑');
  });

  it('busy 时所有提案决策按钮禁用，英文文案切换', () => {
    const html = renderToStaticMarkup(React.createElement(
      WorkflowRequestList,
      requestProps({ locale: 'en', busy: true }),
    ));
    expect(html).toContain('Dynamic workflow proposals awaiting your approval');
    expect(html).toContain('Approve original');
    expect(html).toContain('Reject');
    expect(html).toContain('disabled');
  });
});