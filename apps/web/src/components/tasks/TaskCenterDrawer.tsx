// 运行观察抽屉（Web）：只观察显式 Goal / Dynamic Workflow 的状态、证据和待审脚本。
// 创建入口在 Composer，右侧抽屉只负责观测和必要接管。
import { useCallback, useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import type { Task, TaskRun } from '@suanlizi/protocol';
import type { Locale } from '../../config/config.js';
import {
  cancelTask,
  fetchTask,
  fetchTaskRuns,
  fetchTasks,
  pauseTask,
  redirectTask,
  resumeTask,
  retryTask,
  startTask,
  submitTaskInput,
  TaskApiError,
  type TaskListQuery,
} from '../../api/taskClient.js';
import { runTaskAction } from '../../features/tasks/taskActionFlow.js';
import type { TaskAction } from '../../features/tasks/taskCenterModel.js';
import { TaskCenter } from './TaskCenter.js';

export interface TaskCenterDrawerProps {
  open: boolean;
  locale: Locale;
  onClose(): void;
  /** 点击详情里的跳转：切换到任务所属 Thread（由 main.tsx 传入 loadThread 包装）。 */
  onJumpToThread(threadId: string): void;
}

const panelStyle: CSSProperties = {
  position: 'relative',
  pointerEvents: 'auto',
  display: 'flex',
  flexDirection: 'column',
  width: 'min(420px, calc(100vw - 16px))',
  height: '100%',
  margin: 0,
  borderTop: 'none',
  borderRight: 'none',
  borderBottom: 'none',
  borderLeft: '1px solid var(--nx-border, #e2e8f0)',
  borderRadius: 0,
  background: 'var(--nx-panel, #ffffff)',
  overflow: 'hidden',
  minHeight: 0,
};

// 局部错误/冲突提示的短时驻留时长（AGENTS §7：错误局部、短时）。
const ERROR_LINGER_MS = 6000;
const OBSERVER_ORIGINS: NonNullable<TaskListQuery['origin']> = ['explicit_goal', 'explicit_workflow'];

/**
 * 任务中心只请求当前 API 支持的 Goal / Workflow 来源；请求失败直接展示。
 */
async function fetchObserverTasks(): Promise<{ tasks: Task[] }> {
  return await fetchTasks({ origin: OBSERVER_ORIGINS });
}

export function TaskCenterDrawer({ open, locale, onClose, onJumpToThread }: TaskCenterDrawerProps) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedTask, setSelectedTask] = useState<Task | null>(null);
  const [runs, setRuns] = useState<TaskRun[]>([]);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const errorTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const loadList = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchObserverTasks();
      setTasks(data.tasks);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open) void loadList();
  }, [open, loadList]);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  useEffect(() => () => {
    if (errorTimer.current) clearTimeout(errorTimer.current);
  }, []);

  const flashActionError = useCallback((message: string) => {
    setActionError(message);
    if (errorTimer.current) clearTimeout(errorTimer.current);
    errorTimer.current = setTimeout(() => setActionError(null), ERROR_LINGER_MS);
  }, []);

  const reloadDetail = useCallback(async (taskId: string) => {
    setDetailLoading(true);
    setDetailError(null);
    try {
      const [detail, runsData] = await Promise.all([fetchTask(taskId), fetchTaskRuns(taskId)]);
      setSelectedTask(detail.task);
      setRuns(runsData.runs);
    } catch (err) {
      setDetailError(err instanceof Error ? err.message : String(err));
    } finally {
      setDetailLoading(false);
    }
  }, []);

  const selectTask = useCallback(async (task: Task) => {
    setSelectedId(task.id);
    setSelectedTask(task);
    setRuns([]);
    setDetailError(null);
    setActionError(null);
    await reloadDetail(task.id);
  }, [reloadDetail]);

  const handleAction = useCallback(async (action: TaskAction, payload?: { instruction?: string; answer?: string }) => {
    if (!selectedId || actionBusy) return;
    setActionBusy(true);
    setActionError(null);
    const submit = async () => {
      switch (action) {
        case 'start': return startTask(selectedId);
        case 'pause': return pauseTask(selectedId);
        case 'resume': return resumeTask(selectedId);
        case 'cancel': return cancelTask(selectedId);
        case 'retry': return retryTask(selectedId);
        case 'redirect': return redirectTask(selectedId, payload?.instruction ?? '');
        case 'input': return submitTaskInput(selectedId, payload?.answer ?? '');
        default: throw new Error(`未知操作：${String(action)}`);
      }
    };
    const outcome = await runTaskAction({
      submit,
      reload: async () => {
        await reloadDetail(selectedId);
        await loadList();
      },
    });
    setActionBusy(false);
    if (outcome.status !== 'ok') flashActionError(outcome.message);
  }, [selectedId, actionBusy, reloadDetail, loadList, flashActionError]);

  if (!open) return null;

  return (
    <div className="runMonitorWorkbench taskObserverWorkbench" role="complementary" aria-label={locale === 'zh' ? '运行观察' : 'Run observer'}>
      <div className="taskObserverPanel" style={panelStyle}>
        <TaskCenter
          locale={locale}
          compact
          tasks={tasks}
          selectedTaskId={selectedId}
          selectedTask={selectedTask}
          runs={runs}
          loading={loading}
          detailLoading={detailLoading}
          error={error}
          detailError={detailError}
          onRetry={() => void loadList()}
          planHistoryIncomplete
          onSelectTask={(task) => void selectTask(task)}
          onClose={onClose}
          onJumpToThread={onJumpToThread}
          onAction={(action, payload) => void handleAction(action, payload)}
          actionBusy={actionBusy}
          actionError={actionError}
        />
      </div>
    </div>
  );
}
