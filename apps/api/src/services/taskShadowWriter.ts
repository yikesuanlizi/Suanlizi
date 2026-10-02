// Harness 影子写（计划 §14.6 影子写期 / §5.1 Task 管目标、Run 管过程）：
// Harness run 启动时自动创建 Task + goal TaskRun，并在 run 终态时镜像落库；
// `thread.tags` 的 harnessState:* 仍是现有读优先事实来源，task 表在本阶段只做影子对账。
//
// 设计约束：
// 1. 全程 best-effort：任何失败只 console.warn，绝不影响 harness run 的启动与执行
//    （切换期结束、task 表成为读权威后，本文件的吞错策略要收紧）。
// 2. 状态迁移一律走 @suanlizi/runtime 的 taskLifecycle（内部由 @suanlizi/protocol 迁移表校验），
//    本模块不自建第二套迁移逻辑（§11.4）。
// 3. Task.completed 不在本阶段推导 —— Run 完成 ≠ 目标达成，验收 gate 在 P3 接入（§14.1）。
// 4. 一个 thread 最多一个 active Task（§5.1）：发现遗留 active Task（旧 crash 影子）时，
//    先把旧 Run 记 cancelled 并同步 Task，再为新 harness run 建新 Task；
//    旧 harness 若实际还活着，其迟到的终态写入会命中终态拒绝，被本模块吞掉并告警。

import type { TaskRun, TaskStorePort } from '@suanlizi/protocol';
import { isTaskRunTerminalState } from '@suanlizi/protocol';
import {
  applyTaskSyncFromRun,
  completeRun,
  createTaskWithRun,
  findActiveTask,
  transitionRun,
} from '@suanlizi/runtime';

/** 影子 Task/Run 的句柄，供终态追踪使用。 */
export interface ShadowTaskHandle {
  taskId: string;
  runId: string;
}

/** 与 HarnessRuntimeRegistry 条目对齐的最小观察面（便于测试注入）。 */
export interface ShadowRunObservation {
  runtimeStatus: 'running' | 'completed' | 'failed' | 'cancelled';
  error?: string;
  promise: Promise<unknown>;
}

export interface ShadowLogger {
  warn(message: string): void;
}

const defaultLogger: ShadowLogger = {
  warn: (message) => console.warn(message),
};

/**
 * harness run 启动后创建影子 Task + goal Run，并把 Run 推进到 running。
 * 返回 null 表示未创建（objective 为空或影子写失败），调用方无需区分原因。
 */
export async function shadowTaskForHarnessStart(deps: {
  taskStore: TaskStorePort;
  threadId: string;
  harnessRunId: string;
  goal?: string;
  input?: string;
  acceptanceCriteria?: string[];
  logger?: ShadowLogger;
}): Promise<ShadowTaskHandle | null> {
  const { taskStore, threadId, harnessRunId, logger = defaultLogger } = deps;
  const objective = (deps.goal ?? deps.input ?? '').trim();
  if (!objective) {
    logger.warn(`[tasks] shadow write skipped: empty objective for thread ${threadId}`);
    return null;
  }
  try {
    await supersedeStaleActiveTask({ taskStore, threadId, logger });
    const { task, run } = await createTaskWithRun(taskStore, {
      threadId,
      objective,
      acceptanceCriteria: deps.acceptanceCriteria ?? [],
      kind: 'goal',
      harnessRunId,
      origin: 'harness_shadow',
    });
    // harness run 已在 registry 中起跑，Run 直接 queued → running，Task 同步 running。
    const running = await transitionRun(taskStore, run.id, 'running');
    await applyTaskSyncFromRun(taskStore, task, running);
    return { taskId: task.id, runId: running.id };
  } catch (error) {
    logger.warn(
      `[tasks] shadow write failed for thread ${threadId}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return null;
  }
}

/**
 * 追踪 harness run 终态并镜像到影子 Run。必须与 `shadowTaskForHarnessStart` 成对调用；
 * 观察 promise 的 settle（无论成功/失败/取消），不抛出任何异常。
 */
export function attachShadowTaskTracking(deps: {
  taskStore: TaskStorePort;
  handle: ShadowTaskHandle;
  entry: ShadowRunObservation;
  logger?: ShadowLogger;
}): void {
  const { taskStore, handle, entry, logger = defaultLogger } = deps;
  void (async () => {
    try {
      await entry.promise;
    } catch {
      // 终态以 entry.runtimeStatus 为准，promise reject 无需另处理。
    }
    try {
      const run = await settleShadowRun(taskStore, handle, entry);
      if (run) {
        const task = await taskStore.getTask(handle.taskId);
        if (task) await applyTaskSyncFromRun(taskStore, task, run);
      }
    } catch (error) {
      logger.warn(
        `[tasks] shadow terminal sync failed for run ${handle.runId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  })();
}

/** 按 registry 的 runtimeStatus 落影子 Run 终态（completed 走单点 completeRun）；无写入时返回 null。 */
async function settleShadowRun(
  taskStore: TaskStorePort,
  handle: ShadowTaskHandle,
  entry: ShadowRunObservation,
): Promise<TaskRun | null> {
  const run = await taskStore.getRun(handle.runId);
  if (!run || isTaskRunTerminalState(run.status)) return null;
  switch (entry.runtimeStatus) {
    case 'completed':
      return completeRun(taskStore, run.id);
    case 'cancelled':
      return transitionRun(taskStore, run.id, 'cancelled', {
        error: entry.error ?? 'Harness run cancelled',
      });
    case 'failed':
      return transitionRun(taskStore, run.id, 'failed', {
        error: entry.error ?? 'Harness run failed',
      });
    default:
      return null;
  }
}

/**
 * 影子写期清理：同 thread 存在遗留 active Task（上一进程 crash 或旧 Run 未落终态）时，
 * 把其非终态 Run 记 cancelled 并同步 Task，为新 harness run 腾出单 active 约束。
 */
async function supersedeStaleActiveTask(deps: {
  taskStore: TaskStorePort;
  threadId: string;
  logger: ShadowLogger;
}): Promise<void> {
  const { taskStore, threadId, logger } = deps;
  const active = await findActiveTask(taskStore, threadId, 'harness_shadow');
  if (!active) return;
  const runs = await taskStore.listRuns(active.id);
  for (const run of runs ?? []) {
    if (isTaskRunTerminalState(run.status)) continue;
    try {
      const cancelled = await transitionRun(taskStore, run.id, 'cancelled', {
        error: 'superseded by new harness run (shadow write period)',
      });
      const refreshed = await taskStore.getTask(active.id);
      if (refreshed) await applyTaskSyncFromRun(taskStore, refreshed, cancelled);
    } catch (error) {
      logger.warn(
        `[tasks] failed to supersede stale run ${run.id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}
