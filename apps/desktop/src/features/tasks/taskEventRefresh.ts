// P6：任务中心 SSE 事件过滤（纯函数，web/desktop 同构）。
//
// 目标：GoalRun 在后台提案 Workflow、Run 状态迁移或证据物化时，前端不必重开抽屉即可看到变化。
// 事件名逐字取自 protocol 的 TASK_EVENT_NAMES 与 types.ts 的 workflow.* 族；
// 无法解析的报文一律不触发刷新（宁可少刷，也不因脏数据反复打接口）。
// — Chinese: decides whether an SSE payload should refresh task views.

/** 需要刷新任务视图的事件前缀。 */
const REFRESHABLE_EVENT_PREFIXES = ['workflow.', 'task.'] as const;

/** 去抖时长：合并同一轮内密集事件（run.updated + agent_call.updated + evidence.created）。 */
export const TASK_EVENT_REFRESH_DEBOUNCE_MS = 400;

function parseEventType(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const type = (parsed as { type?: unknown }).type;
  return typeof type === 'string' ? type : null;
}

/** 解析 SSE data 帧；命中 workflow.* / task.* 时返回 true。 */
export function shouldRefreshTasksFromEvent(raw: unknown): boolean {
  const type = parseEventType(raw);
  if (!type) return false;
  return REFRESHABLE_EVENT_PREFIXES.some((prefix) => type.startsWith(prefix));
}

/**
 * 仅「待批准请求」相关的子集：工作流面板用它决定是否重拉 requests。
 * item.* 不参与（提案块虽在 agent_message 里，但落库以 workflow.request.created 为准）。
 */
export function shouldRefreshWorkflowRequests(raw: unknown): boolean {
  const type = parseEventType(raw);
  return (
    type === 'workflow.request.created'
    || type === 'workflow.request.approved'
    || type === 'workflow.request.rejected'
  );
}

/** Run 进度事件：面板用它决定是否重拉运行结果。 */
export function shouldRefreshWorkflowRun(raw: unknown): boolean {
  const type = parseEventType(raw);
  if (!type) return false;
  return type === 'workflow.run.updated'
    || type === 'workflow.run.terminal'
    || type === 'workflow.agent_call.terminal'
    || type === 'workflow.evidence.created';
}
