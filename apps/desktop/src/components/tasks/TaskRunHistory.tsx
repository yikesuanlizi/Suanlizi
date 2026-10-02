// 运行历史（只读）：展示任务的历史 Run（过程态），标记当前活跃 Run。retry 只追加新 Run，不复活旧 Run。
// — English: read-only run history; marks the current run. Retry appends new runs, never revives old ones.
import type { Locale } from '../../config/config.js';
import type { TaskRun, TaskRunKind, TaskRunState, WorkflowKind } from '@suanlizi/protocol';
import { Icon } from '../Icon.js';
import { formatDateTime } from './taskDisplay.js';
import './tasks.css';

const RUN_STATE_LABELS_ZH: Record<TaskRunState, string> = {
  queued: '排队中',
  running: '运行中',
  paused: '已暂停',
  blocked: '已阻塞',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
  interrupted: '已中断',
};

const RUN_STATE_TONES: Record<TaskRunState, string> = {
  queued: 'tone-neutral',
  running: 'tone-active',
  paused: 'tone-neutral',
  blocked: 'tone-warning',
  completed: 'tone-success',
  failed: 'tone-danger',
  cancelled: 'tone-muted',
  interrupted: 'tone-warning',
};

function kindLabel(kind: TaskRunKind, workflowKind: WorkflowKind | undefined, zh: boolean): string {
  if (kind === 'goal') return zh ? '目标续跑' : 'Goal run';
  if (!zh) return workflowKind ? `Workflow · ${workflowKind}` : 'Workflow run';
  if (workflowKind === 'script') return '脚本工作流';
  if (workflowKind === 'blueprint') return '蓝图工作流';
  return zh ? '工作流' : 'Workflow run';
}

export interface TaskRunHistoryProps {
  locale: Locale;
  runs: TaskRun[];
  currentRunId?: string;
}

export function TaskRunHistory({ locale, runs, currentRunId }: TaskRunHistoryProps) {
  const zh = locale === 'zh';

  return (
    <div className="taskSection">
      <div className="taskSectionHeading">
        <Icon name="workflow" />
        <strong>{zh ? '运行历史' : 'Run history'}</strong>
        <em>{runs.length}</em>
      </div>
      {runs.length === 0 ? (
        <p className="taskEmptyState">{zh ? '暂无运行记录。' : 'No runs recorded.'}</p>
      ) : (
        <div className="taskRunHistory">
          {runs.map((run) => (
            <div className="taskRunRow" key={run.id}>
              <span className="taskRunId" title={run.id}>
                {currentRunId === run.id ? '● ' : ''}
                {run.id}
              </span>
              <span className="taskRunKind">{kindLabel(run.kind, run.workflowKind, zh)}</span>
              <span className={`taskRunState ${RUN_STATE_TONES[run.status] ?? 'tone-neutral'}`}>
                {(zh ? RUN_STATE_LABELS_ZH[run.status] : run.status) ?? run.status}
                {run.startedAt ? ` · ${formatDateTime(run.startedAt, locale)}` : ''}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
