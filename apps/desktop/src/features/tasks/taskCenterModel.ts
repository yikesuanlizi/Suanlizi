// 任务中心纯函数规则（P1 只读）：状态标签/色调、进度、claimed vs verified、active 判定、排序、空态。
// — English: pure-function rule set for the read-only task center (P1). It is the single source of
//   display semantics shared in behavior with the Web side; both apps implement it independently
//   (no cross-app import) but must keep identical rules, labels, tone mapping, progress formula,
//   active judgement and ordering — enforced by the mirrored assertion set in taskCenterModel.test.ts.
//
// 规则来源：packages/protocol/src/task.ts（冻结契约）+ 计划 §5.2 / §6.5 / §14.2。
import { isTaskRunTerminalState, isTaskTerminalState, type Task, type TaskRun, type TaskStatus, type TaskStep, type TaskStepStatus } from '@suanlizi/protocol';

// 语义色调集合：只用于状态表达，不作为大面积装饰背景（AGENTS.md §7）。
export type TaskTone = 'neutral' | 'active' | 'warning' | 'danger' | 'success' | 'muted';

// 任务目标层状态 → 中文标签。英文标签由组件按 locale 走 fallback。
const TASK_STATUS_LABELS_ZH: Record<TaskStatus, string> = {
  pending: '待处理',
  running: '运行中',
  blocked: '已阻塞',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
};

const TASK_STATUS_LABELS_EN: Record<TaskStatus, string> = {
  pending: 'Pending',
  running: 'Running',
  blocked: 'Blocked',
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

// 任务状态 → 色调。running 活跃、blocked 警告、completed 成功、failed 危险、cancelled 弱化、pending 中性。
const TASK_STATUS_TONES: Record<TaskStatus, TaskTone> = {
  pending: 'neutral',
  running: 'active',
  blocked: 'warning',
  completed: 'success',
  failed: 'danger',
  cancelled: 'muted',
};

// 计划步骤六态 → 中文标签。claimed（模型自述完成、缺有效证据）必须与 verified 可区分。
const STEP_STATUS_LABELS_ZH: Record<TaskStepStatus, string> = {
  pending: '待执行',
  in_progress: '进行中',
  claimed: '自述完成',
  verified: '已验证',
  failed: '失败',
  skipped: '已跳过',
};

const STEP_STATUS_LABELS_EN: Record<TaskStepStatus, string> = {
  pending: 'Pending',
  in_progress: 'In progress',
  claimed: 'Claimed',
  verified: 'Verified',
  failed: 'Failed',
  skipped: 'Skipped',
};

// 步骤色调：claimed 可显示但不可验收 → 警告；verified → 成功。
const STEP_STATUS_TONES: Record<TaskStepStatus, TaskTone> = {
  pending: 'neutral',
  in_progress: 'active',
  claimed: 'warning',
  verified: 'success',
  failed: 'danger',
  skipped: 'muted',
};

// 任务状态中文标签。
export function taskStatusLabel(status: TaskStatus, zh = true): string {
  return (zh ? TASK_STATUS_LABELS_ZH : TASK_STATUS_LABELS_EN)[status] ?? status;
}

// 任务状态色调。
export function taskStatusTone(status: TaskStatus): TaskTone {
  return TASK_STATUS_TONES[status] ?? 'neutral';
}

// 步骤状态中文标签。
export function stepStatusLabel(status: TaskStepStatus, zh = true): string {
  return (zh ? STEP_STATUS_LABELS_ZH : STEP_STATUS_LABELS_EN)[status] ?? status;
}

// 步骤状态色调。
export function stepStatusTone(status: TaskStepStatus): TaskTone {
  return STEP_STATUS_TONES[status] ?? 'neutral';
}

// claimed vs verified 的核心裁决：只有 verified 可计入验收；claimed 仅展示不可验收（计划 §14.2）。
export function isStepAcceptable(status: TaskStepStatus): boolean {
  return status === 'verified';
}

// 任务是否仍处于活跃（非终态）——一个 Thread 同一时刻最多一个 active Task（计划 §5.1）。
export function isTaskActive(task: Task): boolean {
  return !isTaskTerminalState(task.status);
}

// 任务进度：进度 = 当前计划中 verified 步数 / 总步数（计划 §4 非目标：不做单调递增百分比）。
export interface TaskProgress {
  verified: number;
  total: number;
  // 无可计步骤时为 true（无 latestPlan 或 steps 为空），UI 据此隐藏进度条而非显示 0/0。
  empty: boolean;
}

export function computeTaskProgress(task: Task): TaskProgress {
  const steps = task.latestPlan?.steps ?? [];
  const total = steps.length;
  const verified = steps.filter((step: TaskStep) => isStepAcceptable(step.status)).length;
  return { verified, total, empty: total === 0 };
}

// 进度文本：`3/6 步骤（基于当前计划）` / `3/6 steps (current plan)`；空计划返回 null。
export function formatTaskProgress(task: Task, zh = true): string | null {
  const { verified, total, empty } = computeTaskProgress(task);
  if (empty) return null;
  return zh ? `${verified}/${total} 步骤（基于当前计划）` : `${verified}/${total} steps (current plan)`;
}

// 排序：活跃任务在前，其后按 updatedAt 倒序（越近越前），最后以 id 升序保证稳定 key 与确定性。
export function sortTasks(tasks: Task[]): Task[] {
  return [...tasks].sort((a, b) => {
    const activeDelta = Number(isTaskActive(b)) - Number(isTaskActive(a));
    if (activeDelta !== 0) return activeDelta;
    const timeDelta = timestampOf(b.updatedAt) - timestampOf(a.updatedAt);
    if (timeDelta !== 0) return timeDelta;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

function timestampOf(iso: string): number {
  const value = new Date(iso).getTime();
  return Number.isNaN(value) ? 0 : value;
}

// 空态：是否存在可见任务。
export function hasVisibleTasks(tasks: Task[]): boolean {
  return tasks.length > 0;
}

// 空态文案：无任务时的中文/英文提示（空状态允许保留必要文字，AGENTS.md §7）。
export function tasksEmptyMessage(zh = true): string {
  return zh ? '还没有任务。开始一次目标运行后会在这里出现。' : 'No tasks yet. They appear here once a goal run starts.';
}

// 详情空态：未选中任务时的提示。
export function detailEmptyMessage(zh = true): string {
  return zh ? '从左侧选择一个任务查看详情。' : 'Select a task to view its details.';
}

// 统计：任务的历史 Run 数量。
export function countTaskRuns(task: Task): number {
  return task.runIds.length;
}

// 统计：任务关联证据数量。
export function countTaskEvidence(task: Task): number {
  return task.evidenceIds.length;
}

// ─── P2 生命周期：允许的操作集合（计划 §9.1 前置状态，与 Web 端行为一致） ────────────

// 用户可接管的生命周期操作；与 7 个 POST 端点一一对应。
export type TaskAction = 'start' | 'pause' | 'resume' | 'cancel' | 'retry' | 'redirect' | 'input';

const TASK_ACTION_LABELS_ZH: Record<TaskAction, string> = {
  start: '启动 Goal',
  pause: '暂停',
  resume: '继续',
  cancel: '取消',
  retry: '重试',
  redirect: '转向',
  input: '提交回答',
};

const TASK_ACTION_LABELS_EN: Record<TaskAction, string> = {
  start: 'Start Goal',
  pause: 'Pause',
  resume: 'Resume',
  cancel: 'Cancel',
  retry: 'Retry',
  redirect: 'Redirect',
  input: 'Submit answer',
};

// 操作中文标签（与 Web 端同一套）。
export function taskActionLabel(action: TaskAction, zh = true): string {
  return (zh ? TASK_ACTION_LABELS_ZH : TASK_ACTION_LABELS_EN)[action] ?? action;
}

// 按 §9.1 前置状态返回当前可用操作集合；终态 Task 返回空集（按钮隐藏而非禁用报错）。
export function allowedTaskActions(
  task: Pick<Task, 'status' | 'currentRunId' | 'pendingInput'>,
  run?: TaskRun | null,
): TaskAction[] {
  const actions: TaskAction[] = [];
  if (isTaskTerminalState(task.status)) return actions;

  if (task.status === 'pending' && !task.currentRunId) actions.push('start');

  if (run) {
    const state = run.status;
    const terminal = isTaskRunTerminalState(state);
    if (state === 'running') actions.push('pause');
    if (state === 'paused' || state === 'interrupted') actions.push('resume');
    if (!terminal) actions.push('cancel');
    if (state === 'running' || state === 'paused') actions.push('redirect');
    if (terminal) actions.push('retry');
  }

  if (task.status === 'blocked' && task.pendingInput) actions.push('input');
  return actions;
}

// 冲突错误码：乐观锁失败或前置状态不符（服务端 409）→ UI 局部提示并自动重拉。
const TASK_CONFLICT_CODES = new Set(['TASK_VERSION_CONFLICT', 'TASK_INVALID_TRANSITION', 'TASK_TERMINAL_STATE']);

// 判断异常是否为「状态已变化」类冲突（409 或对应稳定 code）。
export function isTaskConflictError(error: unknown): boolean {
  const candidate = error as { status?: number; code?: string } | null;
  if (!candidate || typeof candidate !== 'object') return false;
  if (candidate.status === 409) return true;
  return typeof candidate.code === 'string' && TASK_CONFLICT_CODES.has(candidate.code);
}
