// 运行观察详情：Goal 与独立 Dynamic Workflow 共用 Task 容器，但绝不混用各自的执行语义。
// Goal 展示 GoalRun、计划投影与验收；独立工作流只展示脚本提案、WorkflowRun、AgentCall 与证据。
import { useState } from 'react';
import type { Task, TaskOrigin, TaskPlanVersion, TaskRun, TaskRunState } from '@suanlizi/protocol';
import type { Locale } from '../../config/config.js';
import { Icon } from '../Icon.js';
import {
  allowedTaskActions,
  countTaskEvidence,
  countTaskRuns,
  formatTaskProgress,
  taskActionLabel,
  taskStatusLabel,
  taskStatusTone,
  type TaskAction,
} from '../../features/tasks/taskCenterModel.js';
import { taskStatusIcon, toneClass } from './taskDisplay.js';
import { PendingUserInputCard } from './PendingUserInputCard.js';
import { TaskEvidencePanel } from './TaskEvidencePanel.js';
import { TaskPlanTimeline } from './TaskPlanTimeline.js';
import { TaskRunHistory } from './TaskRunHistory.js';
import { TaskWorkflowPanel } from './TaskWorkflowPanel.js';
import './tasks.css';

const ACTION_ICON: Record<TaskAction, Parameters<typeof Icon>[0]['name']> = {
  start: 'play',
  pause: 'stop',
  resume: 'play',
  cancel: 'stopCircle',
  retry: 'refresh',
  redirect: 'branch',
  input: 'send',
};

const RUN_STATUS_LABELS_ZH: Record<TaskRunState, string> = {
  queued: '排队中',
  running: '运行中',
  paused: '已暂停',
  blocked: '等待输入',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
  interrupted: '已中断',
};

export interface TaskDetailPanelProps {
  locale: Locale;
  task: Task | null;
  runs?: TaskRun[];
  plan?: TaskPlanVersion | null;
  historyIncomplete?: boolean;
  evidenceIds?: string[];
  loading?: boolean;
  onOpenThread?(threadId: string): void;
  onAction?(action: TaskAction, payload?: { instruction?: string; answer?: string }): void | Promise<void>;
  actionBusy?: boolean;
  actionError?: string | null;
}

function runStatusLabel(status: TaskRunState, zh: boolean): string {
  return zh ? RUN_STATUS_LABELS_ZH[status] : status;
}

function taskOrigin(task: Task): TaskOrigin {
  return task.origin ?? 'harness_shadow';
}

/** Resolve the latest script run when the task summary omits currentRunId. */
function resolveCurrentRun(task: Task, runs: TaskRun[], isStandaloneWorkflow: boolean): TaskRun | null {
  if (task.currentRunId) {
    const linked = runs.find((run) => run.id === task.currentRunId);
    if (linked) return linked;
  }
  if (!isStandaloneWorkflow) return null;
  return runs
    .filter((run) => run.kind === 'workflow' && run.workflowKind === 'script')
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0] ?? null;
}

export function TaskDetailPanel({
  locale,
  task,
  runs = [],
  plan = null,
  historyIncomplete = false,
  evidenceIds,
  loading = false,
  onOpenThread,
  onAction,
  actionBusy = false,
  actionError = null,
}: TaskDetailPanelProps) {
  const zh = locale === 'zh';
  const [redirectOpen, setRedirectOpen] = useState(false);
  const [instruction, setInstruction] = useState('');

  if (!task) {
    return <p className="taskEmptyState">{loading
      ? (zh ? '正在加载运行详情…' : 'Loading run details…')
      : (zh ? '从上方选择一个 Goal 或动态工作流查看详情。' : 'Select a Goal or Dynamic Workflow above to view details.')}
    </p>;
  }

  const origin = taskOrigin(task);
  const isStandaloneWorkflow = origin === 'explicit_workflow';
  const currentRun = resolveCurrentRun(task, runs, isStandaloneWorkflow);
  const availableActions = onAction ? allowedTaskActions(task, currentRun).filter((action) => action !== 'input') : [];
  // 独立 Script Workflow 绝不能通过通用 Task "启动" 成 GoalRun；实际批准、停止、恢复都在脚本面板。
  const actions = isStandaloneWorkflow ? availableActions.filter((action) => action === 'cancel') : availableActions;
  const canSubmitInput = !isStandaloneWorkflow && Boolean(onAction) && allowedTaskActions(task, currentRun).includes('input');
  const progress = isStandaloneWorkflow ? null : formatTaskProgress(task, zh);
  const resolvedEvidence = evidenceIds ?? task.evidenceIds ?? [];
  const typeLabel = isStandaloneWorkflow
    ? (zh ? 'Dynamic Workflow' : 'Dynamic Workflow')
    : (zh ? 'Goal' : 'Goal');

  const submitRedirect = () => {
    const value = instruction.trim();
    if (!value || actionBusy) return;
    void onAction?.('redirect', { instruction: value });
    setInstruction('');
    setRedirectOpen(false);
  };

  return (
    <div className="taskDetail">
      <header className="taskDetailHeader">
        <div>
          <div className={`taskKindLabel ${isStandaloneWorkflow ? 'taskKindLabelWorkflow' : ''}`}>{typeLabel}</div>
          <h2 className="taskDetailObjective">{task.objective}</h2>
        </div>
        <div className="taskDetailActions">
          <span className={`taskStatusBadge taskStatusBadge--compact ${toneClass(taskStatusTone(task.status))}`}>
            <Icon name={taskStatusIcon(task.status)} />
            <span className="taskStatusLabel">{taskStatusLabel(task.status, zh)}</span>
          </span>
          {onOpenThread ? (
            <button type="button" className="taskJumpButton" onClick={() => onOpenThread(task.threadId)}>
              <span>{zh ? '打开会话' : 'Open thread'}</span>
              <Icon name="chevronRight" />
            </button>
          ) : null}
        </div>
      </header>

      <div className="taskDetailStats">
        {progress ? <span className="taskDetailStat"><strong>{progress}</strong><span>{zh ? '当前计划' : 'Current plan'}</span></span> : null}
        <span className="taskDetailStat"><strong>{countTaskRuns(task)}</strong><span>{zh ? (isStandaloneWorkflow ? '工作流运行' : 'Goal 运行') : (isStandaloneWorkflow ? 'Workflow runs' : 'Goal runs')}</span></span>
        <span className="taskDetailStat"><strong>{countTaskEvidence(task)}</strong><span>{zh ? '证据' : 'Evidence'}</span></span>
      </div>

      {isStandaloneWorkflow ? (
        <div className="taskWorkflowSummary">
          <span><em>{zh ? '脚本状态：' : 'Script status: '}</em><strong>{currentRun ? runStatusLabel(currentRun.status, zh) : (zh ? '等待审阅与批准' : 'Awaiting review and approval')}</strong></span>
          <span><em>{zh ? '执行方式：' : 'Execution: '}</em>{zh ? '先审阅脚本，可编辑并查看差异；批准后才会启动 Agent Call。' : 'Review the script, optionally edit it and inspect the diff; Agent Calls start only after approval.'}</span>
          <span><em>{zh ? '结果：' : 'Result: '}</em>{zh ? `已附 ${resolvedEvidence.length} 条证据` : `${resolvedEvidence.length} evidence attached`}</span>
        </div>
      ) : (
        <div className="taskGoalSummary">
          <span><em>{zh ? 'Goal Run：' : 'Goal Run: '}</em><strong>{currentRun ? runStatusLabel(currentRun.status, zh) : (zh ? '尚未启动' : 'Not started')}</strong></span>
          <span><em>{zh ? '工作流协作：' : 'Workflow handoff: '}</em>{zh ? 'Goal Run 可按需提出动态工作流；工作流结果会写入证据，再由 GoalEvaluator 判断是否达成。' : 'A Goal Run may propose a Dynamic Workflow when needed; its result becomes evidence before GoalEvaluator decides completion.'}</span>
          <span><em>{zh ? '验收：' : 'Verification: '}</em>{zh ? `已附 ${resolvedEvidence.length} 条证据` : `${resolvedEvidence.length} evidence attached`}</span>
        </div>
      )}

      {onAction && (actions.length > 0 || actionError) ? (
        <div className="taskActionBar">
          {actionError ? <div className="taskInlineError">{actionError}</div> : null}
          {actions.map((action) => (
            <button
              key={action}
              type="button"
              className={`taskActionButton ${action === 'cancel' ? 'taskActionButtonDanger' : ''} ${actionBusy ? 'taskActionBusy' : ''}`}
              aria-label={taskActionLabel(action, zh)}
              disabled={actionBusy}
              onClick={() => action === 'redirect' ? setRedirectOpen((open) => !open) : void onAction(action)}
            >
              <Icon name={ACTION_ICON[action]} />
              <span className="taskActionButtonLabel">{taskActionLabel(action, zh)}</span>
            </button>
          ))}
          {!isStandaloneWorkflow && redirectOpen ? (
            <div className="taskRedirectRow">
              <input
                className="taskTextInput"
                value={instruction}
                disabled={actionBusy}
                placeholder={zh ? '输入新的 Goal 指令' : 'New instruction for this Goal'}
                onChange={(event) => setInstruction(event.target.value)}
              />
              <button type="button" className="taskActionButton" disabled={actionBusy || !instruction.trim()} onClick={submitRedirect}>
                <Icon name="send" /><span className="taskActionButtonLabel">{zh ? '确认' : 'Confirm'}</span>
              </button>
              <button type="button" className="taskActionButton" disabled={actionBusy} onClick={() => { setInstruction(''); setRedirectOpen(false); }}>
                <Icon name="x" /><span className="taskActionButtonLabel">{zh ? '取消' : 'Cancel'}</span>
              </button>
            </div>
          ) : null}
        </div>
      ) : null}

      {!isStandaloneWorkflow && task.status === 'blocked' && task.pendingInput ? (
        <PendingUserInputCard
          locale={locale}
          pendingInput={task.pendingInput}
          busy={actionBusy}
          onSubmitAnswer={canSubmitInput ? (answer) => void onAction?.('input', { answer }) : undefined}
        />
      ) : null}

      {!isStandaloneWorkflow ? (
        <section className="taskSection">
          <div className="taskSectionHeading"><Icon name="shield" /><strong>{zh ? 'Goal 验收标准' : 'Goal acceptance criteria'}</strong></div>
          {task.acceptanceCriteria.length ? (
            <div className="taskCriteria">
              {task.acceptanceCriteria.map((criterion, index) => (
                <div className="taskCriteriaItem" key={`${index}-${criterion}`}><Icon name="check" /><span>{criterion}</span></div>
              ))}
            </div>
          ) : <p className="taskEmptyState">{zh ? '未设置验收标准。' : 'No acceptance criteria.'}</p>}
        </section>
      ) : null}

      <section className="taskSection">
        <div className="taskSectionHeading"><Icon name="workflow" /><strong>{zh ? '动态工作流' : 'Dynamic Workflow'}</strong></div>
        <TaskWorkflowPanel locale={locale} taskId={task.id} threadId={task.threadId} taskOrigin={origin} />
      </section>

      {!isStandaloneWorkflow ? <TaskPlanTimeline locale={locale} plan={plan} historyIncomplete={historyIncomplete} /> : null}
      <TaskRunHistory locale={locale} runs={runs} currentRunId={task.currentRunId} />
      <TaskEvidencePanel locale={locale} evidenceIds={resolvedEvidence} />
    </div>
  );
}