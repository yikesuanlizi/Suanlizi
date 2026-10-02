// P2 任务操作编排（纯函数，无 React、无网络）：把「调用端点 → 冲突自动重拉 → 成功后刷新」
// 收敛为单一可测流程，两端（web 抽屉 / desktop 容器）复用同一条行为，避免逻辑分叉。
// — English: pure orchestration for a lifecycle action; submit → on 409 refresh+report conflict,
//   on success refresh. Shared shape keeps web and desktop behaviour identical and unit-testable.
import { isTaskConflictError } from './taskCenterModel.js';

/** 冲突时的局部提示文案（AGENTS.md §7：错误局部、可操作）。 */
export const TASK_CONFLICT_MESSAGE = '状态已变化，已为你刷新';

export interface TaskActionFlowDeps {
  /** 执行对应 POST 端点（由调用方绑定具体 client 函数与 payload）。 */
  submit(): Promise<unknown>;
  /** 重新拉取 task + runs 详情；成功与冲突路径都会调用。 */
  reload(): Promise<void>;
}

export type TaskActionOutcome =
  | { status: 'ok' }
  | { status: 'conflict'; message: string }
  | { status: 'error'; message: string };

/**
 * 运行一次任务操作：
 * - 成功 → 刷新详情，返回 ok；
 * - 409 / 前置不符 → 刷新详情并返回 conflict（携带统一提示）；
 * - 其它错误 → 返回 error（不刷新，保留当前视图供用户重试）。
 */
export async function runTaskAction(deps: TaskActionFlowDeps): Promise<TaskActionOutcome> {
  try {
    await deps.submit();
    await deps.reload();
    return { status: 'ok' };
  } catch (error) {
    if (isTaskConflictError(error)) {
      await deps.reload();
      return { status: 'conflict', message: TASK_CONFLICT_MESSAGE };
    }
    return { status: 'error', message: error instanceof Error ? error.message : String(error) };
  }
}
