// 任务中心容器（P2）：负责取数、选择编排与生命周期操作，左列表右详情；取数走 taskClient（相对 /api fetch）。
// 为可测性提供 api 注入（默认使用 taskClient），测试传 fake 即可覆盖点击操作→提交→刷新。
// — English: task-center container; owns fetching, selection and P2 lifecycle actions. `api` is
//   injectable so tests exercise actions (submit + refresh) without a real server.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Locale } from '../../config/config.js';
import type { Task, TaskPlanVersion, TaskRun } from '@suanlizi/protocol';
import {
  cancelTask,
  getTask,
  getTaskPlanHistory,
  listTaskEvidenceIds,
  listTaskRuns,
  listTasks,
  pauseTask,
  redirectTask,
  resumeTask,
  retryTask,
  startTask,
  submitTaskInput,
  TaskRequestError,
  type TaskActionKind,
  type TaskActionResult,
  type TaskListFilter,
} from '../../api/taskClient.js';
import { runTaskAction } from '../../features/tasks/taskActionFlow.js';
import { sortTasks, type TaskAction } from '../../features/tasks/taskCenterModel.js';
import { Icon } from '../Icon.js';
import { TaskList } from './TaskList.js';
import { TaskDetailPanel } from './TaskDetailPanel.js';
import './tasks.css';

// 可注入的取数 + 操作面，签名与 taskClient 一致；测试传 fake 即可脱离网络。
export interface TaskCenterApi {
  listTasks(filter?: TaskListFilter): Promise<Task[]>;
  getTask(taskId: string): Promise<Task>;
  listTaskRuns(taskId: string): Promise<TaskRun[]>;
  getTaskPlanHistory(taskId: string): Promise<{ plan: TaskPlanVersion | null; historyIncomplete: boolean }>;
  listTaskEvidenceIds(taskId: string): Promise<string[]>;
  runAction(taskId: string, action: TaskAction, payload?: { instruction?: string; answer?: string }): Promise<TaskActionResult>;
}

// 将 UI 操作映射到对应 POST 端点（与 Web 抽屉同一套契约）。
async function dispatchAction(
  taskId: string,
  action: TaskAction,
  payload?: { instruction?: string; answer?: string },
): Promise<TaskActionResult> {
  switch (action) {
    case 'start':
      return startTask(taskId);
    case 'pause':
      return pauseTask(taskId);
    case 'resume':
      return resumeTask(taskId);
    case 'cancel':
      return cancelTask(taskId);
    case 'retry':
      return retryTask(taskId);
    case 'redirect':
      return redirectTask(taskId, payload?.instruction ?? '');
    case 'input':
      return submitTaskInput(taskId, payload?.answer ?? '');
    default:
      throw new TaskRequestError(`未知操作：${String(action)}`, { status: 400, code: 'TASK_REQUEST_INVALID' });
  }
}

const OBSERVER_ORIGINS: NonNullable<TaskListFilter['origin']> = ['explicit_goal', 'explicit_workflow'];

const defaultApi: TaskCenterApi = {
  listTasks: (filter) => listObserverTasks(filter),
  getTask: (taskId) => getTask(taskId),
  listTaskRuns: (taskId) => listTaskRuns(taskId),
  getTaskPlanHistory: async (taskId) => {
    const history = await getTaskPlanHistory(taskId);
    return { plan: history.latestPlan ?? history.versions[history.versions.length - 1] ?? null, historyIncomplete: history.historyIncomplete };
  },
  listTaskEvidenceIds: (taskId) => listTaskEvidenceIds(taskId),
  runAction: (taskId, action, payload) => dispatchAction(taskId, action as TaskActionKind, payload),
};

/**
 * 任务中心只请求当前 API 支持的 Goal / Workflow 来源；请求失败直接展示。
 */
async function listObserverTasks(filter?: TaskListFilter): Promise<Task[]> {
  return await listTasks(filter);
}

interface TaskDetail {
  runs: TaskRun[];
  plan: TaskPlanVersion | null;
  historyIncomplete: boolean;
  evidenceIds: string[];
}

const EMPTY_DETAIL: TaskDetail = { runs: [], plan: null, historyIncomplete: false, evidenceIds: [] };

export interface TaskCenterProps {
  locale: Locale;
  /** 可选会话过滤：只列出该 thread 的任务；缺省则跨线程列出全部任务。 */
  threadId?: string;
  /** 初始选中的任务 id（用于外部深链）。 */
  initialTaskId?: string;
  /** 点击任务跳转：暴露 threadId 供上层切换到对应会话。 */
  onOpenThread?(threadId: string): void;
  /** 注入取数实现，便于测试与未来替换。 */
  api?: TaskCenterApi;
}

export function TaskCenter({ locale, threadId, initialTaskId, onOpenThread, api = defaultApi }: TaskCenterProps) {
  const zh = locale === 'zh';
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(initialTaskId ?? null);
  const [detail, setDetail] = useState<TaskDetail>(EMPTY_DETAIL);
  const [detailLoading, setDetailLoading] = useState(false);
  const [refreshNonce, setRefreshNonce] = useState(0);
  const [detailTask, setDetailTask] = useState<Task | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const errorTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 卸载时清理短时错误定时器。
  useEffect(() => () => {
    if (errorTimer.current) clearTimeout(errorTimer.current);
  }, []);

  const filter = useMemo<TaskListFilter>(
    () => ({ ...(threadId ? { threadId } : {}), origin: OBSERVER_ORIGINS }),
    [threadId],
  );

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    api
      .listTasks(filter)
      .then((result) => {
        if (cancelled) return;
        const sorted = sortTasks(result);
        setTasks(sorted);
        setSelectedId((current) => {
          if (current && sorted.some((task) => task.id === current)) return current;
          return sorted[0]?.id ?? null;
        });
      })
      .catch((reason: unknown) => {
        if (cancelled) return;
        setTasks([]);
        setError(describeError(reason, zh));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [api, filter, refreshNonce, zh]);

  useEffect(() => {
    if (!selectedId) {
      setDetail(EMPTY_DETAIL);
      setDetailTask(null);
      return undefined;
    }
    let cancelled = false;
    setDetailLoading(true);
    Promise.all([
      api.listTaskRuns(selectedId).catch(() => [] as TaskRun[]),
      api.getTaskPlanHistory(selectedId).catch(() => ({ plan: null, historyIncomplete: false })),
      api.listTaskEvidenceIds(selectedId).catch(() => [] as string[]),
      api.getTask(selectedId).catch(() => null),
    ])
      .then(([runs, plan, evidenceIds, freshTask]) => {
        if (cancelled) return;
        setDetail({ runs, plan: plan.plan, historyIncomplete: plan.historyIncomplete, evidenceIds });
        // 操作后 getTask 回传的权威任务覆盖列表快照，保证按钮集合基于最新状态。
        if (freshTask) setDetailTask(freshTask);
      })
      .finally(() => {
        if (!cancelled) setDetailLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [api, selectedId, refreshNonce]);

  const selectedTask = useMemo(
    () => detailTask ?? tasks.find((task) => task.id === selectedId) ?? null,
    [detailTask, tasks, selectedId],
  );

  const handleRetry = useCallback(() => setRefreshNonce((nonce) => nonce + 1), []);

  const flashActionError = useCallback((message: string) => {
    setActionError(message);
    if (errorTimer.current) clearTimeout(errorTimer.current);
    errorTimer.current = setTimeout(() => setActionError(null), 6000);
  }, []);

  // 生命周期操作：runTaskAction 统一处理提交/冲突自动重拉/成功刷新；行为与 Web 抽屉一致。
  const handleAction = useCallback(
    async (action: TaskAction, payload?: { instruction?: string; answer?: string }) => {
      if (!selectedId || actionBusy) return;
      setActionBusy(true);
      setActionError(null);
      const outcome = await runTaskAction({
        submit: () => api.runAction(selectedId, action, payload),
        reload: async () => setRefreshNonce((nonce) => nonce + 1),
      });
      setActionBusy(false);
      if (outcome.status !== 'ok') flashActionError(outcome.message);
    },
    [selectedId, actionBusy, api, flashActionError],
  );

  return (
    <div className="taskCenter taskCenter--observer" aria-label={zh ? '运行观察' : 'Run observer'}>
      <div className="taskCenterListPane">
        <div className="taskCenterSectionTitle">
          <span>{zh ? 'Goal 与动态工作流' : 'Goals and Dynamic Workflows'}</span>
          <span className="taskCenterSectionActions">
            <button type="button" className="taskCenterRefresh" onClick={handleRetry} aria-label={zh ? '刷新运行记录' : 'Refresh runs'}>
              <Icon name="refresh" />
              {zh ? '刷新' : 'Refresh'}
            </button>
          </span>
        </div>
        <TaskList
          locale={locale}
          tasks={tasks}
          loading={loading}
          error={error}
          selectedTaskId={selectedId}
          onSelect={setSelectedId}
          onRetry={handleRetry}
          emptyMessage={zh
            ? '暂无目标或动态工作流。请从输入栏选择 Goal 或 Dynamic Workflow 创建。'
            : 'No Goals or Dynamic Workflows yet. Create one from the composer.'}
        />
      </div>
      <div className="taskCenterDetailPane">
        <TaskDetailPanel
          locale={locale}
          task={selectedTask}
          runs={detail.runs}
          plan={detail.plan ?? selectedTask?.latestPlan ?? null}
          historyIncomplete={detail.historyIncomplete}
          evidenceIds={detail.evidenceIds.length > 0 ? detail.evidenceIds : selectedTask?.evidenceIds ?? []}
          loading={detailLoading}
          onOpenThread={onOpenThread}
          onAction={handleAction}
          actionBusy={actionBusy}
          actionError={actionError}
        />
      </div>
    </div>
  );
}

// 将取数异常归一为一句可操作的中文提示（优先用后端稳定 code 对应的 message）。
function describeError(reason: unknown, zh: boolean): string {
  if (reason instanceof TaskRequestError) return reason.message;
  if (reason instanceof Error && reason.message) return reason.message;
  return zh ? '加载运行记录失败，请稍后重试。' : 'Failed to load runs. Please retry.';
}
