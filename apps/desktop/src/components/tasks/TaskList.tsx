// 任务列表（只读）：跨线程展示任务目标、状态、进度、运行/证据数量。点击仅回调选择，不发起操作。
// — English: read-only task list. Emits selection only; no lifecycle actions in P1.
import type { Locale } from '../../config/config.js';
import type { Task } from '@suanlizi/protocol';
import { Icon } from '../Icon.js';
import {
  computeTaskProgress,
  countTaskEvidence,
  countTaskRuns,
  formatTaskProgress,
  hasVisibleTasks,
  taskStatusLabel,
  taskStatusTone,
} from '../../features/tasks/taskCenterModel.js';
import { formatRelative, taskStatusIcon, toneClass } from './taskDisplay.js';
import './tasks.css';

export interface TaskListProps {
  locale: Locale;
  tasks: Task[];
  loading?: boolean;
  error?: string | null;
  selectedTaskId?: string | null;
  onSelect(taskId: string): void;
  onRetry?(): void;
  /** 运行观察可提供专用空态，避免把它误写成普通任务中心。 */
  emptyMessage?: string;
}

export function TaskList({ locale, tasks, loading = false, error = null, selectedTaskId = null, onSelect, onRetry, emptyMessage }: TaskListProps) {
  const zh = locale === 'zh';

  if (loading) {
    return <p className="taskEmptyState">{zh ? '正在加载任务…' : 'Loading tasks…'}</p>;
  }
  if (error) {
    return (
      <div className="taskErrorState" role="alert">
        <span>{error}</span>
        {onRetry ? (
          <button type="button" className="taskCenterRefresh" onClick={onRetry} style={{ marginTop: 8 }}>
            <Icon name="refresh" />
            {zh ? '重试' : 'Retry'}
          </button>
        ) : null}
      </div>
    );
  }
  if (!hasVisibleTasks(tasks)) {
    return <p className="taskEmptyState">{emptyMessage ?? (zh ? '暂无任务。' : 'No tasks yet.')}</p>;
  }

  const now = Date.now();
  return (
    <div className="taskList" role="list">
      {tasks.map((task) => {
        const tone = taskStatusTone(task.status);
        const progress = computeTaskProgress(task);
        const progressText = formatTaskProgress(task, zh);
        return (
          <button
            key={task.id}
            type="button"
            role="listitem"
            className={`taskListRow${selectedTaskId === task.id ? ' selected' : ''}`}
            aria-current={selectedTaskId === task.id ? 'true' : undefined}
            onClick={() => onSelect(task.id)}
          >
            <span className={`taskStatusBadge taskStatusBadge--compact ${toneClass(tone)}`} title={taskStatusLabel(task.status, zh)}>
              <Icon name={taskStatusIcon(task.status)} />
              <span className="taskStatusLabel">{taskStatusLabel(task.status, zh)}</span>
            </span>
            <span className="taskListBody">
              <span className="taskListTitleRow">
                <span className="taskListObjective">{task.objective}</span>
                <span className={`taskListKind${task.origin === 'explicit_workflow' ? ' taskListKindWorkflow' : ''}`}>
                  {task.origin === 'explicit_workflow' ? 'Dynamic Workflow' : 'Goal'}
                </span>
              </span>
              {progressText ? (
                <span className="taskProgressBar" aria-hidden="true">
                  <span style={{ width: `${Math.round((progress.verified / Math.max(1, progress.total)) * 100)}%` }} />
                </span>
              ) : null}
              <span className="taskListMeta">
                {progressText ? <span className="taskListMetaItem">{progressText}</span> : null}
                <span className="taskListMetaItem">
                  <Icon name="activity" />
                  {zh ? `${countTaskRuns(task)} 次运行` : `${countTaskRuns(task)} runs`}
                </span>
                <span className="taskListMetaItem">
                  <Icon name="layers" />
                  {zh ? `${countTaskEvidence(task)} 证据` : `${countTaskEvidence(task)} evidence`}
                </span>
                <span className="taskListMetaItem">{formatRelative(task.updatedAt, now, zh)}</span>
              </span>
            </span>
          </button>
        );
      })}
    </div>
  );
}
