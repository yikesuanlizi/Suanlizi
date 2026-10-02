// 运行观察容器：只读展示显式 Goal 与 Dynamic Workflow，创建入口只保留在输入栏。
// Read-only run observer: explicit Goals and Dynamic Workflows only; creation stays in the composer.
import React from 'react';
import type { Task, TaskRun } from '@suanlizi/protocol';
import type { Locale } from '../../config/config.js';
import { Icon } from '../Icon.js';
import { isActiveTask, type TaskAction } from '../../features/tasks/taskCenterModel.js';
import { TaskDetailPanel } from './TaskDetailPanel.js';
import { TaskList } from './TaskList.js';
import { styles } from './taskStyles.js';

export interface TaskCenterProps {
  locale: Locale;
  /** 右侧运行观察使用纵向阅读布局，避免在窄栏硬挤成两列。 */
  compact?: boolean;
  /** 为 false 时不渲染（与 RunMonitorDrawer 挂载方式对齐）。 */
  open?: boolean;
  tasks: readonly Task[];
  selectedTaskId?: string | null;
  /** 当前选中任务详情；缺省时按 selectedTaskId 从 tasks 中查找。 */
  selectedTask?: Task | null;
  /** 选中任务的 Run 列表（来自 /api/tasks/:id/runs）。 */
  runs?: readonly TaskRun[];
  loading?: boolean;
  detailLoading?: boolean;
  /** 列表级错误（来自 /api/tasks）。 */
  error?: string | null;
  /** 详情级错误（来自 /api/tasks/:id/*）。 */
  detailError?: string | null;
  /** 列表错误态的重试回调（透传 TaskList）。 */
  onRetry?(): void;
  planHistoryIncomplete?: boolean;
  /** 点击任务项：携带完整 Task（含 threadId）。 */
  onSelectTask(task: Task): void;
  /** 关闭容器（drawer 场景）。 */
  onClose?(): void;
  /** 跳转任务所属 Thread（供主 agent 接线）。 */
  onJumpToThread?(threadId: string): void;
  /** Goal 生命周期操作；独立 Workflow 的脚本控制由详情内 Workflow 面板处理。 */
  onAction?(action: TaskAction, payload?: { instruction?: string; answer?: string }): void;
  /** 任一操作进行中：禁用全部操作按钮。 */
  actionBusy?: boolean;
  /** 操作局部错误/冲突提示。 */
  actionError?: string | null;
}

export function TaskCenter({
  locale,
  compact = false,
  open = true,
  tasks,
  selectedTaskId,
  selectedTask,
  runs,
  loading = false,
  detailLoading = false,
  error = null,
  detailError = null,
  onRetry,
  planHistoryIncomplete = true,
  onSelectTask,
  onClose,
  onJumpToThread,
  onAction,
  actionBusy = false,
  actionError = null,
}: TaskCenterProps) {
  const resolved = selectedTask ?? tasks.find((task) => task.id === selectedTaskId) ?? null;
  const activeCount = tasks.filter((task) => isActiveTask(task)).length;
  const title = locale === 'en' ? 'Run observer' : '运行观察';

  if (!open) return null;

  return (
    <div style={{ ...styles.root, ...(compact ? styles.observerRoot : {}) }} role="region" aria-label={title}>
      <header style={styles.header}>
        <h2 style={styles.headerTitle}>{title}</h2>
        <span style={styles.headerCount}>
          {locale === 'en'
            ? `${activeCount} active / ${tasks.length} total`
            : `进行中 ${activeCount} 个 / 共 ${tasks.length} 个`}
        </span>
        <span style={styles.spacer} />
        {onClose ? (
          <button
            type="button"
            style={styles.iconButton}
            onClick={onClose}
            aria-label={locale === 'en' ? 'Close' : '关闭'}
          >
            <Icon name="x" />
          </button>
        ) : null}
      </header>

      <div style={compact ? styles.observerBody : styles.body}>
        <aside style={compact ? styles.observerListPane : styles.listPane}>
          <TaskList
            locale={locale}
            tasks={tasks}
            selectedTaskId={resolved?.id ?? selectedTaskId ?? null}
            loading={loading}
            error={error}
            onRetry={onRetry}
            onSelectTask={onSelectTask}
          />
        </aside>
        <main style={compact ? styles.observerDetailPane : styles.detailPane}>
          <TaskDetailPanel
            locale={locale}
            task={resolved}
            runs={runs}
            loading={detailLoading}
            error={detailError}
            planHistoryIncomplete={planHistoryIncomplete}
            onJumpToThread={onJumpToThread}
            onAction={onAction}
            actionBusy={actionBusy}
            actionError={actionError}
          />
        </main>
      </div>
    </div>
  );
}
