// P2 任务操作编排（纯函数，无 React、无网络）：与 Web 端保持同一行为——提交 → 冲突自动重拉 → 成功后刷新。
// — English: pure lifecycle-action orchestration; submit → on 409 refresh+report conflict, on success
//   refresh. Mirrors the Web side so behaviour is identical across both apps.
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
 * 运行一次任务操作：成功刷新详情返回 ok；409/前置不符刷新详情返回 conflict；其它错误返回 error 不刷新。
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
