// 任务中心只读组件的关键渲染测试（无网络）：用 fixture 直接渲染展示型组件，并渲染 TaskCenter 容器
// 的初始加载态（服务端渲染不执行副作用，因此不触发任何 fetch）。锁定中文默认文案、claimed/verified
// 区分、稳定 key、跳转回调暴露与空态/错误态结构。
// — English: static render tests for the read-only task-center components (no network).
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Task, TaskRun, TaskStep } from '@suanlizi/protocol';
import { TaskList } from './TaskList.js';
import { TaskDetailPanel } from './TaskDetailPanel.js';
import { TaskPlanTimeline } from './TaskPlanTimeline.js';
import { TaskEvidencePanel } from './TaskEvidencePanel.js';
import { TaskRunHistory } from './TaskRunHistory.js';
import { PendingUserInputCard } from './PendingUserInputCard.js';
import { TaskCenter } from './TaskCenter.js';

function step(status: TaskStep['status'], id: string, description: string): TaskStep {
  return { id, description, status, evidenceIds: status === 'verified' ? [`ev_${id}`] : [] };
}

function makeTask(overrides: Partial<Task> & { id: string }): Task {
  return {
    threadId: `thread-${overrides.id}`,
    objective: `objective ${overrides.id}`,
    acceptanceCriteria: [],
    status: 'pending',
    runIds: [],
    evidenceIds: [],
    createdAt: '2026-09-19T00:00:00.000Z',
    updatedAt: '2026-09-19T00:00:00.000Z',
    version: 0,
    ...overrides,
  };
}

function makeRun(overrides: Partial<TaskRun> & { id: string; taskId: string }): TaskRun {
  return {
    threadId: 'thread-run',
    kind: 'goal',
    status: 'running',
    updatedAt: '2026-09-19T00:00:00.000Z',
    version: 0,
    ...overrides,
  };
}

describe('TaskList', () => {
  it('空态显示中文提示，不渲染任务行', () => {
    const html = renderToStaticMarkup(React.createElement(TaskList, { locale: 'zh', tasks: [], onSelect: () => {} }));
    expect(html).toContain('暂无任务');
    expect(html).not.toContain('taskListRow');
  });

  it('渲染任务行：目标、状态标签、进度、运行/证据数量，key 为 task.id', () => {
    const task = makeTask({
      id: 't1',
      status: 'running',
      runIds: ['r1'],
      evidenceIds: ['e1', 'e2'],
      latestPlan: { version: 1, createdAt: '2026-09-19T00:00:00.000Z', trigger: 'init', steps: [step('verified', 's1', '第一步'), step('claimed', 's2', '第二步')] },
    });
    const html = renderToStaticMarkup(React.createElement(TaskList, { locale: 'zh', tasks: [task], selectedTaskId: 't1', onSelect: () => {} }));
    expect(html).toContain('taskListRow');
    expect(html).toContain('selected');
    expect(html).toContain('objective t1');
    expect(html).toContain('运行中');
    expect(html).toContain('1/2 步骤（基于当前计划）');
    expect(html).toContain('1 次运行');
    expect(html).toContain('2 证据');
  });

  it('错误态显示可操作错误与重试入口', () => {
    const html = renderToStaticMarkup(React.createElement(TaskList, { locale: 'zh', tasks: [], error: '加载任务失败', onSelect: () => {}, onRetry: () => {} }));
    expect(html).toContain('加载任务失败');
    expect(html).toContain('重试');
  });
});

describe('TaskDetailPanel', () => {
  it('未选中任务时显示详情空态', () => {
    const html = renderToStaticMarkup(React.createElement(TaskDetailPanel, { locale: 'zh', task: null }));
    expect(html).toContain('从上方选择一个 Goal 或动态工作流查看详情');
  });

  it('渲染目标、状态、验收标准、计划/证据/运行历史，并暴露打开会话按钮', () => {
    const task = makeTask({
      id: 't9',
      status: 'blocked',
      currentRunId: 'run-1',
      runIds: ['run-1'],
      evidenceIds: ['wev_run-1_call-a'],
      acceptanceCriteria: ['鉴权检查全部通过'],
      pendingInput: { question: '需要确认目标目录', options: ['项目根目录', 'src 目录'], freeText: true, askedAt: '2026-09-19T00:00:00.000Z' },
      latestPlan: { version: 2, createdAt: '2026-09-19T00:00:00.000Z', trigger: 'replan', steps: [step('verified', 's1', '发现文件'), step('claimed', 's2', '并行审计')] },
    });
    const runs = [makeRun({ id: 'run-1', taskId: 't9', kind: 'goal', status: 'running' })];
    const html = renderToStaticMarkup(React.createElement(TaskDetailPanel, {
      locale: 'zh',
      task,
      runs,
      plan: task.latestPlan ?? null,
      historyIncomplete: true,
      evidenceIds: task.evidenceIds,
      onOpenThread: () => {},
    }));
    expect(html).toContain('objective t9');
    expect(html).toContain('已阻塞');
    expect(html).toContain('打开会话');
    expect(html).toContain('鉴权检查全部通过');
    expect(html).toContain('动态工作流');
    // claimed 与 verified 文案在详情中同时且分别出现
    expect(html).toContain('已验证');
    expect(html).toContain('自述完成');
    expect(html).toContain('需要确认目标目录');
    expect(html).toContain('run-1');
  });
});

describe('TaskPlanTimeline', () => {
  it('claimed 与 verified 步骤分别标注，并给出缺证据说明', () => {
    const plan = { version: 1, createdAt: '2026-09-19T00:00:00.000Z', trigger: 'init' as const, steps: [step('verified', 'a', '完成 A'), step('claimed', 'b', '完成 B')] };
    const html = renderToStaticMarkup(React.createElement(TaskPlanTimeline, { locale: 'zh', plan }));
    expect(html).toContain('完成 A');
    expect(html).toContain('已验证');
    expect(html).toContain('完成 B');
    expect(html).toContain('自述完成');
    expect(html).toContain('缺少有效证据');
  });

  it('无步骤时显示空态', () => {
    const html = renderToStaticMarkup(React.createElement(TaskPlanTimeline, { locale: 'zh', plan: null }));
    expect(html).toContain('当前计划暂无步骤');
  });
});

describe('TaskEvidencePanel', () => {
  it('列出证据 id 与数量', () => {
    const html = renderToStaticMarkup(React.createElement(TaskEvidencePanel, { locale: 'zh', evidenceIds: ['wev_r1_c1', 'ev_item2'] }));
    expect(html).toContain('wev_r1_c1');
    expect(html).toContain('ev_item2');
    expect(html).toContain('证据');
  });

  it('无证据时显示空态', () => {
    const html = renderToStaticMarkup(React.createElement(TaskEvidencePanel, { locale: 'zh', evidenceIds: [] }));
    expect(html).toContain('暂无证据记录');
  });
});

describe('TaskRunHistory', () => {
  it('展示 Run 的过程态与类型，标记当前 Run', () => {
    const runs = [
      makeRun({ id: 'run-a', taskId: 't1', kind: 'goal', status: 'completed' }),
      makeRun({ id: 'run-b', taskId: 't1', kind: 'workflow', workflowKind: 'script', status: 'running' }),
    ];
    const html = renderToStaticMarkup(React.createElement(TaskRunHistory, { locale: 'zh', runs, currentRunId: 'run-b' }));
    expect(html).toContain('run-a');
    expect(html).toContain('已完成');
    expect(html).toContain('脚本工作流');
    expect(html).toContain('运行中');
  });

  it('无运行时显示空态', () => {
    const html = renderToStaticMarkup(React.createElement(TaskRunHistory, { locale: 'zh', runs: [] }));
    expect(html).toContain('暂无运行记录');
  });
});

describe('PendingUserInputCard', () => {
  it('pendingInput 缺省时不渲染任何内容', () => {
    const html = renderToStaticMarkup(React.createElement(PendingUserInputCard, { locale: 'zh', pendingInput: null }));
    expect(html).toBe('');
  });

  it('渲染问题与选项（只读模式无提交回调）', () => {
    const html = renderToStaticMarkup(React.createElement(PendingUserInputCard, {
      locale: 'zh',
      pendingInput: { question: '选择部署环境', options: ['预发', '生产'], freeText: false, askedAt: '2026-09-19T00:00:00.000Z' },
    }));
    expect(html).toContain('选择部署环境');
    expect(html).toContain('预发');
    expect(html).toContain('生产');
    expect(html).toContain('请从上方选项中选择');
  });

  it('P2 提供 onSubmitAnswer 时渲染单选与提交回答按钮', () => {
    const html = renderToStaticMarkup(React.createElement(PendingUserInputCard, {
      locale: 'zh',
      pendingInput: { question: '选择部署环境', options: ['预发', '生产'], freeText: true, askedAt: '2026-09-19T00:00:00.000Z' },
      onSubmitAnswer: () => {},
    }));
    expect(html).toContain('type="radio"');
    expect(html).toContain('预发');
    expect(html).toContain('生产');
    expect(html).toContain('提交回答');
  });
});

describe('TaskCenter (container, no network)', () => {
  it('服务端渲染只产出容器与初始加载态，不触发任何 fetch', () => {
    const html = renderToStaticMarkup(React.createElement(TaskCenter, { locale: 'zh' }));
    expect(html).toContain('taskCenter');
    expect(html).toContain('taskCenterListPane');
    expect(html).toContain('taskCenterDetailPane');
    // 初始 loading 态文案，证明尚未依赖真实数据即不空白
    expect(html).toContain('正在加载任务');
  });
});

describe('TaskDetailPanel P2 操作条渲染', () => {
  const runningTask = makeTask({ id: 't1', status: 'running', currentRunId: 'r1' });
  const liveRun = makeRun({ id: 'r1', taskId: 't1', status: 'running' });

  it('传 onAction 时按 allowed 集合渲染按钮（running run → 暂停/取消/转向）', () => {
    const html = renderToStaticMarkup(
      React.createElement(TaskDetailPanel, { locale: 'zh', task: runningTask, runs: [liveRun], onAction: () => {} }),
    );
    expect(html).toContain('taskActionBar');
    expect(html).toContain('暂停');
    expect(html).toContain('取消');
    expect(html).toContain('转向');
    expect(html).not.toContain('aria-label="启动"');
    expect(html).not.toContain('aria-label="重试"');
  });

  it('未传 onAction 时保持只读（不渲染操作条）', () => {
    const html = renderToStaticMarkup(
      React.createElement(TaskDetailPanel, { locale: 'zh', task: runningTask, runs: [liveRun] }),
    );
    expect(html).not.toContain('taskActionBar');
  });

  it('blocked + pendingInput + onAction 时底部渲染重试、卡片内就近渲染提交回答', () => {
    const blocked = makeTask({
      id: 't3',
      status: 'blocked',
      currentRunId: 'r1',
      pendingInput: { question: '选择部署环境', options: ['预发', '生产'], freeText: true, askedAt: '2026-09-19T00:00:00.000Z' },
    });
    const doneRun = makeRun({ id: 'r1', taskId: 't3', status: 'completed' });
    const html = renderToStaticMarkup(
      React.createElement(TaskDetailPanel, { locale: 'zh', task: blocked, runs: [doneRun], onAction: () => {} }),
    );
    expect(html).toContain('重试');
    expect(html).toContain('提交回答');
    expect(html).toContain('type="radio"');
  });

  it('独立 Dynamic Workflow 不借用 Goal Run、验收或计划投影', () => {
    const workflow = makeTask({
      id: 'workflow-1',
      origin: 'explicit_workflow',
      status: 'pending',
      acceptanceCriteria: ['这条不应作为 Goal 验收展示'],
      latestPlan: { version: 1, createdAt: '2026-09-19T00:00:00.000Z', trigger: 'init', steps: [step('claimed', 's1', '不应展示')], },
    });
    const html = renderToStaticMarkup(React.createElement(TaskDetailPanel, { locale: 'zh', task: workflow }));

    expect(html).toContain('Dynamic Workflow');
    expect(html).toContain('等待审阅与批准');
    expect(html).not.toContain('Goal Run：');
    expect(html).not.toContain('Goal 验收标准');
    expect(html).not.toContain('计划投影');
  });

  it('Task summary without currentRunId still shows the latest script run terminal status', () => {
    const workflow = makeTask({
      id: 'workflow-completed',
      origin: 'explicit_workflow',
      status: 'pending',
      runIds: ['workflow-run'],
    });
    const completedRun = makeRun({
      id: 'workflow-run',
      taskId: workflow.id,
      kind: 'workflow',
      workflowKind: 'script',
      status: 'completed',
      updatedAt: '2026-09-25T08:46:00.000Z',
    });
    const html = renderToStaticMarkup(React.createElement(TaskDetailPanel, {
      locale: 'zh',
      task: workflow,
      runs: [completedRun],
    }));

    expect(html).toContain('\u811a\u672c\u72b6\u6001\uff1a');
    expect(html).toContain('\u5df2\u5b8c\u6210');
    expect(html).not.toContain('\u7b49\u5f85\u5ba1\u9605\u4e0e\u6279\u51c6');
  });

  it('actionError 局部提示与 busy 禁用态渲染', () => {
    const html = renderToStaticMarkup(
      React.createElement(TaskDetailPanel, {
        locale: 'zh',
        task: runningTask,
        runs: [liveRun],
        onAction: () => {},
        actionError: '状态已变化，已为你刷新',
        actionBusy: true,
      }),
    );
    expect(html).toContain('taskInlineError');
    expect(html).toContain('状态已变化，已为你刷新');
    expect(html).toContain('disabled');
  });
});
