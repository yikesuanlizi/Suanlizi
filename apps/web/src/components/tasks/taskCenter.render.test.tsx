import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { PendingUserInput, Task, TaskPlanVersion, TaskRun, TaskStep } from '@suanlizi/protocol';
import { TaskCenter } from './TaskCenter.js';
import { TaskList } from './TaskList.js';
import { TaskDetailPanel } from './TaskDetailPanel.js';
import { TaskPlanTimeline } from './TaskPlanTimeline.js';
import { PendingUserInputCard } from './PendingUserInputCard.js';

function step(id: string, status: TaskStep['status']): TaskStep {
  return { id, description: `步骤-${id}`, status, evidenceIds: status === 'verified' ? [`ev-${id}`] : [] };
}

const plan: TaskPlanVersion = {
  version: 1,
  createdAt: '2026-09-19T00:00:00.000Z',
  trigger: 'init',
  steps: [step('s1', 'verified'), step('s2', 'claimed'), step('s3', 'in_progress'), step('s4', 'pending'), step('s5', 'failed'), step('s6', 'verified')],
};

function makeTask(overrides: Partial<Task> & { id: string }): Task {
  return {
    threadId: `thread-${overrides.id}`,
    objective: `目标-${overrides.id}`,
    acceptanceCriteria: ['标准甲', '标准乙'],
    status: 'running',
    runIds: ['r1'],
    evidenceIds: ['ev-s1', 'ev-s6'],
    createdAt: '2026-09-18T00:00:00.000Z',
    updatedAt: '2026-09-19T00:00:00.000Z',
    version: 1,
    origin: 'harness_shadow',
    ...overrides,
  };
}

const runningTask = makeTask({ id: 't1', latestPlan: plan, currentRunId: 'r1' });

const run: TaskRun = {
  id: 'r1',
  taskId: 't1',
  threadId: 'thread-t1',
  kind: 'workflow',
  workflowKind: 'script',
  status: 'running',
  updatedAt: '2026-09-19T01:00:00.000Z',
  version: 0,
};

const pendingInput: PendingUserInput = {
  question: '要部署到哪个环境？',
  options: ['staging', 'production'],
  freeText: true,
  askedAt: '2026-09-19T02:00:00.000Z',
};

describe('TaskList 渲染', () => {
  it('渲染真实任务、进度文案与状态标签', () => {
    const html = renderToStaticMarkup(
      React.createElement(TaskList, { locale: 'zh', tasks: [runningTask], onSelectTask: vi.fn() }),
    );
    expect(html).toContain('目标-t1');
    expect(html).toContain('2/6 步');
    expect(html).toContain('进行中');
  });

  it('空列表显示空态文案', () => {
    const html = renderToStaticMarkup(
      React.createElement(TaskList, { locale: 'zh', tasks: [], onSelectTask: vi.fn() }),
    );
    expect(html).toContain('暂无目标或动态工作流');
  });

  it('错误信息以可操作提示渲染', () => {
    const html = renderToStaticMarkup(
      React.createElement(TaskList, { locale: 'zh', tasks: [], error: '无法连接任务服务', onSelectTask: vi.fn() }),
    );
    expect(html).toContain('无法连接任务服务');
    // 未传 onRetry 时不渲染重试按钮。
    expect(html).not.toContain('重试');
  });

  it('错误态传入 onRetry 时渲染可点击的重试按钮', () => {
    const html = renderToStaticMarkup(
      React.createElement(TaskList, {
        locale: 'zh',
        tasks: [],
        error: '任务请求失败',
        onRetry: vi.fn(),
        onSelectTask: vi.fn(),
      }),
    );
    expect(html).toContain('任务请求失败');
    expect(html).toContain('重试');
    expect(html).toContain('<button');
  });
});

describe('TaskPlanTimeline 渲染', () => {
  it('区分 claimed 与 verified：claimed 标注待补证据', () => {
    const html = renderToStaticMarkup(
      React.createElement(TaskPlanTimeline, { locale: 'zh', plan, historyIncomplete: true }),
    );
    expect(html).toContain('步骤-s1');
    expect(html).toContain('已验证');
    expect(html).toContain('自述完成');
    expect(html).toContain('待补证据');
    expect(html).toContain('历史记录不完整');
  });

  it('无计划时显示占位', () => {
    const html = renderToStaticMarkup(React.createElement(TaskPlanTimeline, { locale: 'zh', plan: null }));
    expect(html).toContain('暂无计划步骤');
  });
});

describe('PendingUserInputCard 渲染', () => {
  it('blocked 展示结构化问题与选项', () => {
    const html = renderToStaticMarkup(
      React.createElement(PendingUserInputCard, { locale: 'zh', pendingInput }),
    );
    expect(html).toContain('需要你补充信息');
    expect(html).toContain('要部署到哪个环境？');
    expect(html).toContain('staging');
    expect(html).toContain('production');
  });

  it('无 pendingInput 时不渲染', () => {
    const html = renderToStaticMarkup(
      React.createElement(PendingUserInputCard, { locale: 'zh', pendingInput: null }),
    );
    expect(html).toBe('');
  });
});

describe('TaskDetailPanel 渲染', () => {
  it('展示目标、验收标准、迭代/证据数量与计划步骤', () => {
    const html = renderToStaticMarkup(
      React.createElement(TaskDetailPanel, { locale: 'zh', task: runningTask, runs: [run] }),
    );
    expect(html).toContain('目标-t1');
    expect(html).toContain('标准甲');
    expect(html).toContain('Goal 验收标准');
    expect(html).toContain('动态工作流');
    expect(html).toContain('工作流（脚本）');
    expect(html).toContain('证据 2 条');
  });

  it('独立 Dynamic Workflow 不显示 Goal 的进度、验收或计划区域', () => {
    const workflowTask = makeTask({
      id: 'wf1',
      origin: 'explicit_workflow',
      latestPlan: plan,
      currentRunId: 'r1',
    });
    const html = renderToStaticMarkup(
      React.createElement(TaskDetailPanel, { locale: 'zh', task: workflowTask, runs: [run], onAction: vi.fn() }),
    );
    expect(html).toContain('Dynamic Workflow');
    expect(html).toContain('工作流运行记录');
    expect(html).toContain('工作流证据');
    expect(html).not.toContain('Goal 进度');
    expect(html).not.toContain('Goal 验收标准');
    expect(html).not.toContain('当前 Goal 计划');
    expect(html).not.toContain('Goal 运行记录');
  });

  it('blocked 且有 pendingInput 时渲染待补充卡片', () => {
    const blocked = makeTask({ id: 't2', status: 'blocked', pendingInput });
    const html = renderToStaticMarkup(
      React.createElement(TaskDetailPanel, { locale: 'zh', task: blocked }),
    );
    expect(html).toContain('需要你补充信息');
    expect(html).toContain('要部署到哪个环境？');
  });

  it('未选中任务时显示引导空态', () => {
    const html = renderToStaticMarkup(
      React.createElement(TaskDetailPanel, { locale: 'zh', task: null }),
    );
    expect(html).toContain('选择一个 Goal 或 Dynamic Workflow 查看详情');
  });
});

describe('TaskDetailPanel P2 操作条渲染', () => {
  it('传 onAction 时按 allowed 集合渲染按钮（running run → 暂停/取消/转向，不含启动/重试/继续）', () => {
    const html = renderToStaticMarkup(
      React.createElement(TaskDetailPanel, { locale: 'zh', task: runningTask, runs: [run], onAction: vi.fn() }),
    );
    expect(html).toContain('暂停');
    expect(html).toContain('取消');
    expect(html).toContain('转向');
    expect(html).not.toContain('>启动<');
    expect(html).not.toContain('>重试<');
    expect(html).not.toContain('>继续<');
  });

  it('未传 onAction 时保持只读（不渲染任何操作按钮）', () => {
    const html = renderToStaticMarkup(
      React.createElement(TaskDetailPanel, { locale: 'zh', task: runningTask, runs: [run] }),
    );
    expect(html).not.toContain('暂停');
    expect(html).not.toContain('转向');
  });

  it('blocked + pendingInput + onAction 时底部渲染重试、卡片内就近渲染提交回答', () => {
    const blocked = makeTask({ id: 't3', status: 'blocked', currentRunId: 'r1', pendingInput });
    const doneRun: TaskRun = { ...run, status: 'completed' };
    const html = renderToStaticMarkup(
      React.createElement(TaskDetailPanel, { locale: 'zh', task: blocked, runs: [doneRun], onAction: vi.fn() }),
    );
    expect(html).toContain('重试');
    expect(html).toContain('提交回答');
    expect(html).toContain('type="radio"');
  });

  it('actionError 局部提示在操作条上方渲染', () => {
    const html = renderToStaticMarkup(
      React.createElement(TaskDetailPanel, {
        locale: 'zh',
        task: runningTask,
        runs: [run],
        onAction: vi.fn(),
        actionError: '状态已变化，已为你刷新',
      }),
    );
    expect(html).toContain('状态已变化，已为你刷新');
  });

  it('actionBusy 时操作按钮 disabled 防双发', () => {
    const html = renderToStaticMarkup(
      React.createElement(TaskDetailPanel, {
        locale: 'zh',
        task: runningTask,
        runs: [run],
        onAction: vi.fn(),
        actionBusy: true,
      }),
    );
    expect(html).toContain('disabled');
  });
});

describe('TaskCenter 容器渲染', () => {
  it('左列表 + 右详情同时渲染，标题为中文', () => {
    const html = renderToStaticMarkup(
      React.createElement(TaskCenter, {
        locale: 'zh',
        tasks: [runningTask],
        selectedTask: runningTask,
        runs: [run],
        onSelectTask: vi.fn(),
        onClose: vi.fn(),
      }),
    );
    expect(html).toContain('运行观察');
    expect(html).toContain('目标-t1');
    expect(html).toContain('2/6 步');
    expect(html).toContain('验收标准');
  });

  it('open=false 时不渲染（drawer 收起）', () => {
    const html = renderToStaticMarkup(
      React.createElement(TaskCenter, { locale: 'zh', open: false, tasks: [], onSelectTask: vi.fn() }),
    );
    expect(html).toBe('');
  });

  it('空任务列表渲染空态', () => {
    const html = renderToStaticMarkup(
      React.createElement(TaskCenter, { locale: 'zh', tasks: [], onSelectTask: vi.fn() }),
    );
    expect(html).toContain('暂无目标或动态工作流');
  });
});
