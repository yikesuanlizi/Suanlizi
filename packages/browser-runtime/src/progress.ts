// 用户进度投影（架构文档 15.2）：用户可读进度由结构化运行事件生成，不让模型
// 编造运行状态；机器 Trace 与用户进度同源不同投影。本模块是纯函数：逐条映射
// 事件（一条事件至多产生一条进度），无法映射的事件跳过，保留输入顺序。
// 输入是协议事件（BrowserTaskEvent）与 Sidecar 事件（IpcEvent）的统一窄化，
// Phase 1 只关心这些事件。
// — English: user progress projection (architecture §15.2) — user-readable
//   progress is derived from structured run events, never fabricated by the
//   model; machine trace and user progress share one source with different
//   projections. Pure functions: each event yields at most one entry,
//   unmappable events are skipped, input order is preserved. The input is a
//   narrowed union of protocol events (BrowserTaskEvent) and Sidecar events
//   (IpcEvent); Phase 1 only cares about these.
import type { BrowserActionKind } from '@suanlizi/protocol';

export type ProgressTone = 'info' | 'ok' | 'warn' | 'error';

export interface ProgressEntry {
  at: number; // epoch ms
  tone: ProgressTone;
  text: string; // 用户可读中文文案（user-readable Chinese copy）
  source: string; // 来源事件标识（type/action），便于追溯（origin event id for tracing）
}

// 输入：协议事件或 Sidecar 事件的统一窄化（Phase 1 只关心这些）。
// — English: input — narrowed union of protocol / Sidecar events (Phase 1 scope).
export type ProgressSource =
  | { type: 'task.created'; createdAt: string }
  | { type: 'browser.navigate'; url: string; at: number }
  | { type: 'observation.accepted'; elementCount: number; at: number }
  | { type: 'action.prepared'; actionKind: string; at: number }
  | { type: 'action.completed'; outcome: 'committed' | 'uncertain' | 'failed'; errorCode?: string; at: number }
  | { type: 'human.requested'; prompt: string; at: number }
  | { type: 'human.resolved'; approved: boolean; at: number }
  | { type: 'budget.updated'; at: number }
  | { type: 'task.paused'; at: number }
  | { type: 'task.cancelled'; at: number }
  | { type: 'task.failed'; code: string; at: number }
  | { type: 'task.completed'; at: number };

// 动作种类 → 用户可读标签；未收录的种类原样返回。
// — English: action kind → user-readable label; unknown kinds pass through.
const ACTION_KIND_LABELS: Partial<Record<BrowserActionKind, string>> = {
  click: '点击',
  type: '输入',
  navigate: '导航',
  submit: '提交',
  download: '下载',
  scroll: '滚动',
  screenshot: '截图',
  wait: '等待',
};

export function actionKindLabel(kind: string): string {
  return ACTION_KIND_LABELS[kind as BrowserActionKind] ?? kind;
}

// at 字段解析：数字事件自带 at 直接透传；字符串（createdAt）用 Date.parse；
// 缺失或解析失败时回退 0。
// — English: at resolution — numeric timestamps pass through, strings go
//   through Date.parse, missing / unparseable values fall back to 0.
function resolveAt(value: number | string | undefined): number {
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

// 逐条映射：一条事件至多产生一条进度；无法映射的事件返回 null 被跳过。
// — English: per-event mapping — at most one entry per event; null means skip.
function mapToProgress(source: ProgressSource): ProgressEntry | null {
  switch (source.type) {
    case 'task.created':
      return { at: resolveAt(source.createdAt), tone: 'info', text: '任务已创建', source: source.type };
    case 'browser.navigate':
      return { at: resolveAt(source.at), tone: 'info', text: `正在打开 ${source.url}`, source: source.type };
    case 'observation.accepted':
      return {
        at: resolveAt(source.at),
        tone: 'info',
        text: `已获取页面快照（${source.elementCount} 个可交互元素）`,
        source: source.type,
      };
    case 'action.prepared':
      return {
        at: resolveAt(source.at),
        tone: 'info',
        text: `正在执行 ${actionKindLabel(source.actionKind)}`,
        source: source.type,
      };
    case 'action.completed':
      switch (source.outcome) {
        case 'committed':
          return { at: resolveAt(source.at), tone: 'ok', text: '操作完成', source: source.type };
        case 'uncertain':
          return { at: resolveAt(source.at), tone: 'warn', text: '操作结果不确定，等待对账', source: source.type };
        case 'failed':
          return {
            at: resolveAt(source.at),
            tone: 'error',
            text: `操作失败：${source.errorCode ?? '未知错误'}`,
            source: source.type,
          };
      }
      break;
    case 'human.requested':
      return { at: resolveAt(source.at), tone: 'warn', text: `需要确认：${source.prompt}`, source: source.type };
    case 'human.resolved':
      return source.approved
        ? { at: resolveAt(source.at), tone: 'ok', text: '已确认', source: source.type }
        : { at: resolveAt(source.at), tone: 'info', text: '已拒绝，Agent 将调整方案', source: source.type };
    case 'budget.updated':
      return { at: resolveAt(source.at), tone: 'info', text: '预算已更新', source: source.type };
    case 'task.paused':
      return { at: resolveAt(source.at), tone: 'info', text: '任务已暂停', source: source.type };
    case 'task.cancelled':
      return { at: resolveAt(source.at), tone: 'warn', text: '任务已取消', source: source.type };
    case 'task.failed':
      return { at: resolveAt(source.at), tone: 'error', text: `任务失败：${source.code}`, source: source.type };
    case 'task.completed':
      return { at: resolveAt(source.at), tone: 'ok', text: '任务完成', source: source.type };
    default:
      // 运行时防御：无法映射的事件（含未来新增类型）直接跳过。
      // — English: runtime guard — unmappable events (incl. future types) are skipped.
      return null;
  }
}

// 纯函数：逐条映射（一条事件至多产生一条进度），保留顺序；无法映射的事件跳过。
// — English: pure function — maps events one by one (at most one entry each),
//   preserving order; unmappable events are skipped.
export function projectProgress(sources: ReadonlyArray<ProgressSource>): ProgressEntry[] {
  const entries: ProgressEntry[] = [];
  for (const source of sources) {
    const entry = mapToProgress(source);
    if (entry !== null) {
      entries.push(entry);
    }
  }
  return entries;
}
