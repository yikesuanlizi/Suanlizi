// 任务中心展示的共享辅助：状态→图标映射、时间格式化、色调 class。只服务 components/tasks/ 内部，
// 不改动 Icon.tsx（只复用其既有 IconName），也不改动全局样式。
// — English: display helpers local to the task-center components. Reuses existing Icon names only.
import type { IconName } from '../Icon.js';
import type { TaskStatus, TaskStepStatus } from '@suanlizi/protocol';
import type { TaskTone } from '../../features/tasks/taskCenterModel.js';

// 任务目标层状态 → 既有图标名（窄宽度下标签压缩为图标，不新增 SVG）。
const TASK_STATUS_ICON: Record<TaskStatus, IconName> = {
  pending: 'pause',
  running: 'activity',
  blocked: 'alertTriangle',
  completed: 'check',
  failed: 'alert',
  cancelled: 'stopCircle',
};

// 计划步骤态 → 既有图标名。claimed 用问号表达"自述但未验证"的不确定语义。
const STEP_STATUS_ICON: Record<TaskStepStatus, IconName> = {
  pending: 'pause',
  in_progress: 'activity',
  claimed: 'question',
  verified: 'check',
  failed: 'alert',
  skipped: 'chevronRight',
};

export function taskStatusIcon(status: TaskStatus): IconName {
  return TASK_STATUS_ICON[status] ?? 'hash';
}

export function stepStatusIcon(status: TaskStepStatus): IconName {
  return STEP_STATUS_ICON[status] ?? 'hash';
}

// 色调 → CSS class 片段（与局部 tasks.css 一一对应）。
export function toneClass(tone: TaskTone): string {
  return `tone-${tone}`;
}

// 本地化日期时间（含日期与时分），非法值返回空串由调用方省略。
export function formatDateTime(iso: string | undefined, locale: 'zh' | 'en'): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString(locale === 'zh' ? 'zh-CN' : 'en-US', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

// 相对"多久前"的极简中文/英文描述，用于列表次要信息；无法解析时返回空串。
export function formatRelative(iso: string | undefined, now: number, zh = true): string {
  if (!iso) return '';
  const value = new Date(iso).getTime();
  if (Number.isNaN(value)) return '';
  const diffMs = Math.max(0, now - value);
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return zh ? '刚刚' : 'just now';
  if (minutes < 60) return zh ? `${minutes} 分钟前` : `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return zh ? `${hours} 小时前` : `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return zh ? `${days} 天前` : `${days}d ago`;
}
