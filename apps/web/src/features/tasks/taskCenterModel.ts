// 任务中心展示模型：纯函数，不接 React、不碰网络。
// Task-center display model: pure functions, no React, no network.
//
// 复用 @suanlizi/protocol 的冻结状态（TaskStatus / TaskStepStatus / TaskRunState），
// 不新造状态；只负责把它们映射成中文标签、语义 tone 与进度/排序/空态判定。
// — Chinese: reuses protocol states verbatim; only derives labels, tones and view logic.

import { isTaskRunTerminalState, isTaskTerminalState } from '@suanlizi/protocol';
import type {
  Task,
  TaskPlanVersion,
  TaskRun,
  TaskRunState,
  TaskStatus,
  TaskStep,
  TaskStepStatus,
} from '@suanlizi/protocol';
import type { Locale } from '../../config/config.js';

/** 语义 tone 只用于状态表达，不作为大面积背景（AGENTS.md §7）。 */
export type StatusTone = 'neutral' | 'active' | 'warning' | 'success' | 'danger';

export interface StatusView {
  label: string;
  tone: StatusTone;
}

// ─── 状态 → 标签 + tone ──────────────────────────────────────────────────────

const TASK_STATUS_VIEWS: Record<TaskStatus, { zh: string; en: string; tone: StatusTone }> = {
  pending: { zh: '待处理', en: 'Pending', tone: 'neutral' },
  running: { zh: '进行中', en: 'Running', tone: 'active' },
  blocked: { zh: '待补充', en: 'Blocked', tone: 'warning' },
  completed: { zh: '已完成', en: 'Completed', tone: 'success' },
  failed: { zh: '失败', en: 'Failed', tone: 'danger' },
  cancelled: { zh: '已取消', en: 'Cancelled', tone: 'neutral' },
};

const TASK_STEP_VIEWS: Record<TaskStepStatus, { zh: string; en: string; tone: StatusTone }> = {
  pending: { zh: '待执行', en: 'Pending', tone: 'neutral' },
  in_progress: { zh: '执行中', en: 'In progress', tone: 'active' },
  // claimed：模型自述完成但缺有效证据——展示但不可验收（计划 §14.2）。
  claimed: { zh: '自述完成', en: 'Claimed', tone: 'warning' },
  verified: { zh: '已验证', en: 'Verified', tone: 'success' },
  failed: { zh: '失败', en: 'Failed', tone: 'danger' },
  skipped: { zh: '已跳过', en: 'Skipped', tone: 'neutral' },
};

const TASK_RUN_VIEWS: Record<TaskRunState, { zh: string; en: string; tone: StatusTone }> = {
  queued: { zh: '排队中', en: 'Queued', tone: 'neutral' },
  running: { zh: '进行中', en: 'Running', tone: 'active' },
  paused: { zh: '已暂停', en: 'Paused', tone: 'neutral' },
  blocked: { zh: '待补充', en: 'Blocked', tone: 'warning' },
  completed: { zh: '已完成', en: 'Completed', tone: 'success' },
  failed: { zh: '失败', en: 'Failed', tone: 'danger' },
  cancelled: { zh: '已取消', en: 'Cancelled', tone: 'neutral' },
  interrupted: { zh: '已中断', en: 'Interrupted', tone: 'warning' },
};

function pick(locale: Locale, zh: string, en: string): string {
  return locale === 'en' ? en : zh;
}

/** Task 目标层状态 → 标签 + tone。 */
export function getTaskStatusView(status: TaskStatus, locale: Locale = 'zh'): StatusView {
  const view = TASK_STATUS_VIEWS[status];
  return { label: pick(locale, view.zh, view.en), tone: view.tone };
}

/** TaskStep 状态 → 标签 + tone。 */
export function getStepStatusView(status: TaskStepStatus, locale: Locale = 'zh'): StatusView {
  const view = TASK_STEP_VIEWS[status];
  return { label: pick(locale, view.zh, view.en), tone: view.tone };
}

/** TaskRun 过程态 → 标签 + tone。 */
export function getRunStateView(state: TaskRunState, locale: Locale = 'zh'): StatusView {
  const view = TASK_RUN_VIEWS[state];
  return { label: pick(locale, view.zh, view.en), tone: view.tone };
}

// ─── claimed vs verified 区分 ────────────────────────────────────────────────

/**
 * claimed 表示模型自述完成但缺有效证据：可显示、不可验收。
 * 展示层据此补一条「待补证据」提示（计划 §14.2 / §14.4）。
 */
export function isStepAwaitingEvidence(step: Pick<TaskStep, 'status'>): boolean {
  return step.status === 'claimed';
}

/** claimed 步骤的补充提示文案；其它状态返回空串。 */
export function getStepEvidenceHint(step: Pick<TaskStep, 'status'>, locale: Locale = 'zh'): string {
  if (!isStepAwaitingEvidence(step)) return '';
  return pick(locale, '待补证据', 'Awaiting evidence');
}

// ─── 步骤进度（verified 计完成，分母为当前计划总步数） ──────────────────────────

export interface StepProgress {
  /** 已验证步数（计为完成）。 */
  verified: number;
  /** 当前计划总步数。 */
  total: number;
  /** 自述完成但待补证据的步数（claimed）。 */
  claimed: number;
}

/**
 * 基于「当前计划」（latestPlan 投影）统计进度：只有 verified 计为完成。
 * 非目标：不承诺单调递增——replan 更换计划会使分母/分子跳变（计划 §7 P1 非目标）。
 */
export function computeStepProgress(
  plan: TaskPlanVersion | null | undefined,
): StepProgress {
  const steps = plan?.steps ?? [];
  let verified = 0;
  let claimed = 0;
  for (const step of steps) {
    if (step.status === 'verified') verified += 1;
    else if (step.status === 'claimed') claimed += 1;
  }
  return { verified, total: steps.length, claimed };
}

/** 进度文案：`verified/total 步`。无计划时给出中性占位而非伪造 0/0。 */
export function formatStepProgress(progress: StepProgress, locale: Locale = 'zh'): string {
  if (progress.total === 0) {
    return pick(locale, '暂无计划步骤', 'No plan steps');
  }
  return pick(
    locale,
    `${progress.verified}/${progress.total} 步`,
    `${progress.verified}/${progress.total} steps`,
  );
}

// ─── active 判定 / 排序 / 空态 ───────────────────────────────────────────────

/** active：非终态的 Task（completed / cancelled / failed 之外）。 */
export function isActiveTask(task: Pick<Task, 'status'>): boolean {
  return !isTaskTerminalState(task.status);
}

/** 找出某个 Thread 当前唯一的 active Task（约定同一 Thread 最多一个，取最近更新者）。 */
export function findActiveTask(tasks: readonly Task[]): Task | null {
  const active = tasks.filter((task) => isActiveTask(task));
  if (!active.length) return null;
  return sortTasksByUpdatedDesc(active)[0] ?? null;
}

/**
 * 按 updatedAt 倒序（新→旧）返回新数组；不修改入参。
 * ISO 字符串字典序即时间序，直接 localeCompare 稳定。
 */
export function sortTasksByUpdatedDesc(tasks: readonly Task[]): Task[] {
  return [...tasks].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** 空态判定：无任何任务。 */
export function isTaskListEmpty(tasks: readonly Task[] | undefined | null): boolean {
  return !tasks || tasks.length === 0;
}

/** 空态文案：创建行为位于输入栏，观察抽屉不再提供第二个入口。 */
export function getEmptyListText(locale: Locale = 'zh'): string {
  return pick(
    locale,
    '暂无目标或动态工作流。请从输入栏选择 Goal 或 Dynamic Workflow 创建。',
    'No Goal or Dynamic Workflow yet. Create one from the composer.',
  );
}

// ─── 详情派生：当前 Run / 迭代与证据数量 ─────────────────────────────────────

/** 依据 currentRunId 从 runs 中取当前 Run；找不到返回 null（不伪造）。 */
export function resolveCurrentRun(
  task: Pick<Task, 'currentRunId'>,
  runs: readonly TaskRun[] | undefined,
): TaskRun | null {
  if (!task.currentRunId || !runs) return null;
  return runs.find((run) => run.id === task.currentRunId) ?? null;
}

/** 迭代（Run）数量。 */
export function countRuns(task: Pick<Task, 'runIds'>, runs?: readonly TaskRun[]): number {
  if (runs) return runs.length;
  return task.runIds?.length ?? 0;
}

/** 证据数量。 */
export function countEvidence(task: Pick<Task, 'evidenceIds'>): number {
  return task.evidenceIds?.length ?? 0;
}

// ─── P2 生命周期：允许的操作集合（计划 §9.1 前置状态） ───────────────────────

/** 用户可接管的生命周期操作；与 7 个 POST 端点一一对应。 */
export type TaskAction = 'start' | 'pause' | 'resume' | 'cancel' | 'retry' | 'redirect' | 'input';

/** 操作中文标签（UI 按钮就近原则，弹层不做确认对话框）。 */
export const TASK_ACTION_LABELS: Record<TaskAction, { zh: string; en: string }> = {
  start: { zh: '启动 Goal', en: 'Start Goal' },
  pause: { zh: '暂停', en: 'Pause' },
  resume: { zh: '继续', en: 'Resume' },
  cancel: { zh: '取消', en: 'Cancel' },
  retry: { zh: '重试', en: 'Retry' },
  redirect: { zh: '转向', en: 'Redirect' },
  input: { zh: '提交回答', en: 'Submit answer' },
};

export function getTaskActionLabel(action: TaskAction, locale: Locale = 'zh'): string {
  const view = TASK_ACTION_LABELS[action];
  return pick(locale, view.zh, view.en);
}

/**
 * 按 §9.1 前置状态返回当前可用操作集合；UI 只渲染集合内按钮（隐藏而非禁用报错）。
 * - 终态 Task 返回空集（终态不可原地接管，retry 对终态 Task 报 TASK_TERMINAL_STATE）。
 * - start：Task pending 且无 currentRun。
 * - pause / resume / cancel / redirect：依赖 currentRun 的过程态。
 * - retry：Task 非终态且 currentRun 处于终态。
 * - input：Task blocked 且存在 pendingInput（由待补充卡片就近提交，不入底部操作条）。
 */
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

/** 判断异常是否为「状态已变化」类冲突（409 或对应稳定 code）；两端错误类型均暴露 status/code。 */
export function isTaskConflictError(error: unknown): boolean {
  const candidate = error as { status?: number; code?: string } | null;
  if (!candidate || typeof candidate !== 'object') return false;
  if (candidate.status === 409) return true;
  return typeof candidate.code === 'string' && TASK_CONFLICT_CODES.has(candidate.code);
}
