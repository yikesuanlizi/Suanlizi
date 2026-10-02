// 任务列表（只读）：渲染真实 Task，稳定 key、状态徽章、更新时间、进度摘要与空态。
// Read-only task list: real tasks, stable keys, badges, timestamps, progress summary, empty state.
import React from 'react';
import type { Task } from '@suanlizi/protocol';
import type { Locale } from '../../config/config.js';
import { formatTimestamp } from '../../shared/i18n.js';
import {
  computeStepProgress,
  formatStepProgress,
  getEmptyListText,
  getTaskStatusView,
  isTaskListEmpty,
  sortTasksByUpdatedDesc,
} from '../../features/tasks/taskCenterModel.js';
import { StatusBadge } from './StatusBadge.js';
import { styles } from './taskStyles.js';

export interface TaskListProps {
  locale: Locale;
  tasks: readonly Task[];
  selectedTaskId?: string | null;
  loading?: boolean;
  error?: string | null;
  /** 错误态下的重试回调；缺省则不展示重试按钮。 */
  onRetry?(): void;
  /** 点击任务项：回调携带完整 Task（含 threadId，供上层接线跳转 Thread）。 */
  onSelectTask(task: Task): void;
}

export function TaskList({
  locale,
  tasks,
  selectedTaskId,
  loading = false,
  error = null,
  onRetry,
  onSelectTask,
}: TaskListProps) {
  const sorted = sortTasksByUpdatedDesc(tasks);
  return (
    <div style={styles.listScroll}>
      {error ? (
        <div style={styles.error}>
          <span>{error}</span>
          {onRetry ? (
            <button type="button" style={styles.iconButton} onClick={onRetry}>
              {locale === 'en' ? 'Retry' : '重试'}
            </button>
          ) : null}
        </div>
      ) : null}
      {loading && isTaskListEmpty(sorted) ? (
        <div style={styles.empty}>{locale === 'en' ? 'Loading…' : '加载中…'}</div>
      ) : null}
      {!loading && isTaskListEmpty(sorted) ? (
        <div style={styles.empty}>{getEmptyListText(locale)}</div>
      ) : null}
      <ul style={styles.listReset}>
        {sorted.map((task) => {
          const statusView = getTaskStatusView(task.status, locale);
          const progress = computeStepProgress(task.latestPlan);
          const active = task.id === selectedTaskId;
          return (
            <li key={task.id}>
              <button
                type="button"
                onClick={() => onSelectTask(task)}
                style={{
                  ...styles.listItem,
                  ...(active ? styles.listItemActive : null),
                }}
                aria-current={active ? 'true' : undefined}
              >
                <span style={styles.listItemTitle}>{task.objective}</span>
                <span style={styles.listItemMeta}>
                  <StatusBadge view={statusView} />
                  <span>{formatStepProgress(progress, locale)}</span>
                </span>
                <time dateTime={task.updatedAt} style={styles.time}>
                  {formatTimestamp(task.updatedAt, locale)}
                </time>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
