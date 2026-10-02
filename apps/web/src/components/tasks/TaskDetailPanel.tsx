// 运行详情：Goal 与独立 Dynamic Workflow 分开展示；组合场景由 Goal Run 调用 Workflow Run。
// 普通 Harness Agent 与既有静态 Blueprint Workflow 不进入此视图。
import React, { useState } from 'react';
import type { Task, TaskRun, TaskRunState } from '@suanlizi/protocol';
import type { Locale } from '../../config/config.js';
import type { IconName } from '../Icon.js';
import { formatTimestamp } from '../../shared/i18n.js';
import {
  allowedTaskActions,
  computeStepProgress,
  countEvidence,
  countRuns,
  formatStepProgress,
  getTaskActionLabel,
  getTaskStatusView,
  resolveCurrentRun,
  type TaskAction,
} from '../../features/tasks/taskCenterModel.js';
import { Icon } from '../Icon.js';
import { PendingUserInputCard } from './PendingUserInputCard.js';
import { StatusBadge } from './StatusBadge.js';
import { TaskEvidencePanel } from './TaskEvidencePanel.js';
import { TaskPlanTimeline } from './TaskPlanTimeline.js';
import { TaskRunHistory } from './TaskRunHistory.js';
import { TaskWorkflowPanel } from './TaskWorkflowPanel.js';
import { styles } from './taskStyles.js';

const ACTION_ICON: Record<TaskAction, IconName> = {
  start: 'play',
  pause: 'stop',
  resume: 'play',
  cancel: 'stopCircle',
  retry: 'refresh',
  redirect: 'branch',
  input: 'send',
};

const RUN_STATUS_LABELS: Record<TaskRunState, { zh: string; en: string }> = {
  queued: { zh: '排队中', en: 'Queued' },
  running: { zh: '运行中', en: 'Running' },
  paused: { zh: '已暂停', en: 'Paused' },
  blocked: { zh: '等待你的决定', en: 'Awaiting your decision' },
  completed: { zh: '已完成', en: 'Completed' },
  failed: { zh: '失败', en: 'Failed' },
  cancelled: { zh: '已取消', en: 'Cancelled' },
  interrupted: { zh: '已中断', en: 'Interrupted' },
};

export interface TaskDetailPanelProps {
  locale: Locale;
  task: Task | null;
  runs?: readonly TaskRun[];
  loading?: boolean;
  error?: string | null;
  planHistoryIncomplete?: boolean;
  onJumpToThread?(threadId: string): void;
  onAction?(action: TaskAction, payload?: { instruction?: string; answer?: string }): void;
  actionBusy?: boolean;
  actionError?: string | null;
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return <section style={styles.section}><h3 style={styles.sectionTitle}>{title}</h3>{children}</section>;
}

function runStatusLabel(run: TaskRun | null, locale: Locale): string {
  if (!run) return locale === 'en' ? 'Not started' : '尚未启动';
  const view = RUN_STATUS_LABELS[run.status];
  return locale === 'en' ? view.en : view.zh;
}

export function TaskDetailPanel({
  locale,
  task,
  runs,
  loading = false,
  error = null,
  planHistoryIncomplete = true,
  onJumpToThread,
  onAction,
  actionBusy = false,
  actionError = null,
}: TaskDetailPanelProps) {
  const [redirectOpen, setRedirectOpen] = useState(false);
  const [instruction, setInstruction] = useState('');

  if (error) return <div style={styles.error}>{error}</div>;
  if (!task) {
    return <div style={styles.empty}>{loading
      ? (locale === 'en' ? 'Loading…' : '加载中…')
      : (locale === 'en' ? 'Select a Goal or Dynamic Workflow to view details' : '选择一个 Goal 或 Dynamic Workflow 查看详情')}</div>;
  }

  const standaloneWorkflow = task.origin === 'explicit_workflow';
  const statusView = getTaskStatusView(task.status, locale);
  const progress = computeStepProgress(task.latestPlan);
  const currentRun = resolveCurrentRun(task, runs);
  const runCount = countRuns(task, runs);
  const evidenceCount = countEvidence(task);
  const criteria = task.acceptanceCriteria ?? [];
  const availableActions = !standaloneWorkflow && onAction
    ? allowedTaskActions(task, currentRun).filter((action) => action !== 'input')
    : [];
  const showInput = !standaloneWorkflow && Boolean(onAction) && allowedTaskActions(task, currentRun).includes('input');

  const submitRedirect = () => {
    const text = instruction.trim();
    if (!text || actionBusy) return;
    onAction?.('redirect', { instruction: text });
    setRedirectOpen(false);
    setInstruction('');
  };

  const entityLabel = standaloneWorkflow
    ? (locale === 'en' ? 'Dynamic Workflow' : '动态工作流')
    : (locale === 'en' ? 'Goal' : 'Goal 目标');

  return (
    <div style={styles.detailScroll}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={styles.rowBetween}>
          <div style={{ minWidth: 0 }}>
            <div style={{ ...styles.faint, fontSize: 12, marginBottom: 2 }}>{entityLabel}</div>
            <h2 style={styles.objective}>{task.objective}</h2>
          </div>
          <StatusBadge view={statusView} />
        </div>
        <div style={{ ...styles.rowBetween, gap: 12 }}>
          <time dateTime={task.updatedAt} style={styles.time}>{formatTimestamp(task.updatedAt, locale)}</time>
          {onJumpToThread ? (
            <button type="button" style={styles.linkButton} onClick={() => onJumpToThread(task.threadId)}>
              <span>{locale === 'en' ? 'Open thread' : '打开对话'}</span><Icon name="chevronRight" />
            </button>
          ) : null}
        </div>
      </div>

      {standaloneWorkflow ? (
        <>
          <div style={styles.statRow}>
            <span><span style={styles.statValue}>{runCount}</span>{locale === 'en' ? 'runs' : '运行记录'}</span>
            <span><span style={styles.statValue}>{evidenceCount}</span>{locale === 'en' ? 'evidence' : '证据'}</span>
          </div>
          <Section title={locale === 'en' ? 'Dynamic Workflow' : '动态工作流'}>
            <TaskWorkflowPanel locale={locale} taskId={task.id} threadId={task.threadId} standalone />
          </Section>
          <Section title={locale === 'en' ? 'Workflow run records' : '工作流运行记录'}>
            <TaskRunHistory locale={locale} runs={runs ?? []} currentRunId={task.currentRunId} />
          </Section>
          <Section title={locale === 'en' ? 'Workflow evidence' : '工作流证据'}>
            <TaskEvidencePanel locale={locale} evidenceIds={task.evidenceIds ?? []} />
          </Section>
        </>
      ) : (
        <>
          <div style={styles.statRow}>
            <span><span style={styles.statValue}>{formatStepProgress(progress, locale)}</span>{locale === 'en' ? 'Goal progress' : 'Goal 进度'}</span>
            <span><span style={styles.statValue}>{runCount}</span>{locale === 'en' ? 'Goal runs' : 'Goal 运行'}</span>
            <span><span style={styles.statValue}>{evidenceCount}</span>{locale === 'en' ? 'evidence' : '证据'}</span>
          </div>

          <div style={{
            padding: '8px 10px', borderTop: '1px solid var(--nx-border)', borderBottom: '1px solid var(--nx-border)',
            display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, lineHeight: 1.5,
          }}>
            <div><span style={styles.faint}>{locale === 'en' ? 'Goal Run: ' : 'Goal 运行：'}</span><strong>{runStatusLabel(currentRun, locale)}</strong></div>
            <div><span style={styles.faint}>{locale === 'en' ? 'Dynamic workflow: ' : '动态工作流：'}</span>{locale === 'en' ? 'proposed by the Goal Run only when needed; your approval is required.' : '仅在 Goal Run 需要拆分、并行或替代路径时提出，必须由你批准。'}</div>
            <div><span style={styles.faint}>{locale === 'en' ? 'Verification: ' : '验收：'}</span>{locale === 'en' ? `${evidenceCount} evidence attached` : `已附 ${evidenceCount} 条证据`}</div>
          </div>

          {onAction && (availableActions.length > 0 || actionError) ? (
            <div style={styles.actionBar}>
              {actionError ? <div style={{ ...styles.inlineError, width: '100%' }}>{actionError}</div> : null}
              {availableActions.map((action) => (
                <button
                  key={action}
                  type="button"
                  aria-label={getTaskActionLabel(action, locale)}
                  style={{ ...styles.actionButton, ...(action === 'cancel' ? styles.actionButtonDanger : {}), ...(actionBusy ? styles.actionButtonBusy : {}) }}
                  disabled={actionBusy}
                  onClick={() => action === 'redirect' ? setRedirectOpen((open) => !open) : onAction(action)}
                >
                  <Icon name={ACTION_ICON[action]} /><span>{getTaskActionLabel(action, locale)}</span>
                </button>
              ))}
              {redirectOpen ? (
                <div style={styles.redirectRow}>
                  <input style={styles.textInput} type="text" value={instruction} disabled={actionBusy}
                    placeholder={locale === 'en' ? 'New instruction for this Goal' : '输入新的 Goal 指令'} onChange={(event) => setInstruction(event.target.value)} />
                  <button type="button" style={{ ...styles.actionButton, ...(instruction.trim() && !actionBusy ? {} : styles.actionButtonBusy) }} disabled={!instruction.trim() || actionBusy} onClick={submitRedirect}>
                    <Icon name="send" /><span>{locale === 'en' ? 'Confirm' : '确认'}</span>
                  </button>
                  <button type="button" style={styles.actionButton} disabled={actionBusy} onClick={() => { setRedirectOpen(false); setInstruction(''); }}>
                    <Icon name="x" /><span>{locale === 'en' ? 'Cancel' : '取消'}</span>
                  </button>
                </div>
              ) : null}
            </div>
          ) : null}

          {task.status === 'blocked' && task.pendingInput ? (
            <PendingUserInputCard locale={locale} pendingInput={task.pendingInput} onSubmitAnswer={showInput ? (answer) => onAction?.('input', { answer }) : undefined} busy={actionBusy} />
          ) : null}

          <Section title={locale === 'en' ? 'Dynamic workflow' : '动态工作流'}>
            <TaskWorkflowPanel locale={locale} taskId={task.id} threadId={task.threadId} />
          </Section>
          <Section title={locale === 'en' ? 'Goal acceptance criteria' : 'Goal 验收标准'}>
            {criteria.length ? (
              <ul style={styles.listReset}>{criteria.map((criterion, index) => <li key={`${index}-${criterion}`} style={styles.criteriaItem}><span style={styles.faint} aria-hidden="true">·</span><span style={{ wordBreak: 'break-word' }}>{criterion}</span></li>)}</ul>
            ) : <div style={{ ...styles.faint, fontSize: 12 }}>{locale === 'en' ? 'No acceptance criteria' : '未设置验收标准'}</div>}
          </Section>
          <Section title={locale === 'en' ? 'Current Goal plan' : '当前 Goal 计划'}>
            <TaskPlanTimeline locale={locale} plan={task.latestPlan} historyIncomplete={planHistoryIncomplete} />
          </Section>
          <Section title={locale === 'en' ? 'Goal runs' : 'Goal 运行记录'}>
            {currentRun ? <div style={{ ...styles.muted, fontSize: 12, marginBottom: 4 }}>{locale === 'en' ? 'Current Goal Run: ' : '当前 Goal Run：'}{currentRun.id}</div> : null}
            <TaskRunHistory locale={locale} runs={runs ?? []} currentRunId={task.currentRunId} />
          </Section>
          <Section title={locale === 'en' ? 'Goal evidence' : 'Goal 证据'}><TaskEvidencePanel locale={locale} evidenceIds={task.evidenceIds ?? []} /></Section>
        </>
      )}
    </div>
  );
}
