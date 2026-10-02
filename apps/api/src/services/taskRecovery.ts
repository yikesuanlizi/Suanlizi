// TaskRun 启动恢复扫描（计划 §11.2 / 盘点 §4.2）：与 recoverOpsTasks 并列的 fire-and-forget 入口。
// 恢复真相只存在于 Agent Checkpoint，SqliteTaskStore.recoverInterruptedRuns 只做镜像回写；
// 本模块负责注入进程内 isLive 判据、日志与错误收口，不阻塞端口就绪。

import type { TaskRun, TaskStorePort } from '@suanlizi/protocol';

export interface StartTaskRunRecoveryDeps {
  taskStore: TaskStorePort;
  /** 进程内活跃判据（单进程假设；由调用方注入 registry 查询）。 */
  isLive: (run: TaskRun) => boolean;
  /** 恢复回写完成后回调（P5：workflow run 同步标记 interrupted 用）。 */
  onRecovered?: (runs: TaskRun[]) => void;
  log?: (message: string) => void;
  warn?: (message: string) => void;
}

/** 触发一次恢复扫描并收口错误；返回底层 promise 便于测试 await。 */
export function startTaskRunRecovery(deps: StartTaskRunRecoveryDeps): Promise<void> {
  const { taskStore, isLive, onRecovered } = deps;
  const log = deps.log ?? ((message: string) => console.log(message));
  const warn = deps.warn ?? ((message: string) => console.warn(message));
  return taskStore
    .recoverInterruptedRuns(isLive)
    .then((rewritten) => {
      if (rewritten.length > 0) {
        log(`[tasks] recovery rewrote ${rewritten.length} non-terminal task run(s)`);
        onRecovered?.(rewritten);
      }
    })
    .catch((error: unknown) => {
      warn(`[tasks] run recovery failed: ${error instanceof Error ? error.message : String(error)}`);
    });
}
