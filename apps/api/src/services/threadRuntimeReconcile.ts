// 线程运行态启动对账：进程被强杀/崩溃时，running/stopping checkpoint 与 running turn 行都会残留。
//   - checkpoint 残留 → /state 在内存 idle 时把它回推成 running/stopping，UI 永远卡在“进行中/停止中”；
//   - turn 行残留 → 快照里 runningTurns 非空，侧栏活动点与发送按钮同样卡在“进行中”。
// 优雅退出走 runtime/shutdown.ts 的 markRunningTurnsInterrupted；强杀不会执行它，所以启动时必须再兜一次。
// 收敛目标：所有非本进程存活的运行痕迹都变成 interrupted + executionStatus=terminal。

import type { Checkpoint, TurnMeta } from '@suanlizi/protocol';
import type { ThreadStore } from '@suanlizi/storage';

// ThreadId 是 storage 内部别名，这里用 string 兼容其签名。
type ThreadId = string;

export interface ReconcileThreadRuntimeDeps {
  threadStore: ThreadStore;
  /** 进程内活跃判据：该线程是否仍有本进程持有的运行句柄。 */
  isThreadLive: (threadId: ThreadId) => boolean;
  /** 收敛 turn 行时写入的 completedAt；缺省用当前时间。 */
  completedAt?: string;
  now?: () => string;
  log?: (message: string) => void;
  warn?: (message: string) => void;
}

export interface ReconcileThreadRuntimeReport {
  scanned: number;
  /** 被改写为 interrupted 的 checkpoint 数。 */
  interrupted: number;
  /** 被改写为 interrupted 的 running turn 行数。 */
  turnsInterrupted: number;
}

/** checkpoint 是否处于“需要收口”的活动态。 */
function isActiveCheckpoint(checkpoint: Checkpoint | null): boolean {
  if (!checkpoint) return false;
  return checkpoint.status === 'running'
    || checkpoint.status === 'stopping'
    || checkpoint.executionStatus === 'running'
    || checkpoint.executionStatus === 'stopping';
}

/**
 * 把某个线程里所有仍是 running 的 turn 行改写成 interrupted。
 * 返回改写的行数；任何单行失败只记警告，不中断整体对账。
 */
export async function interruptRunningTurns(
  threadStore: ThreadStore,
  threadId: ThreadId,
  options: { completedAt?: string; warn?: (message: string) => void } = {},
): Promise<number> {
  const warn = options.warn ?? (() => undefined);
  const completedAt = options.completedAt ?? new Date().toISOString();
  const getTurns = threadStore.getTurns?.bind(threadStore);
  if (typeof getTurns !== 'function') return 0;
  let turns: TurnMeta[];
  try {
    turns = await getTurns(threadId);
  } catch (error) {
    warn('[runtime] failed to read turns for ' + threadId + ': '
      + (error instanceof Error ? error.message : String(error)));
    return 0;
  }
  let changed = 0;
  for (const turn of turns) {
    if (turn.status !== 'running') continue;
    try {
      await threadStore.saveTurn({ ...turn, status: 'interrupted', completedAt });
      changed += 1;
    } catch (error) {
      warn('[runtime] failed to interrupt turn ' + turn.turnId + ': '
      + (error instanceof Error ? error.message : String(error)));
    }
  }
  return changed;
}

export async function reconcileThreadRuntimeOnStartup(
  deps: ReconcileThreadRuntimeDeps,
): Promise<ReconcileThreadRuntimeReport> {
  const { threadStore, isThreadLive } = deps;
  const completedAt = deps.completedAt;
  const now = deps.now ?? (() => new Date().toISOString());
  const log = deps.log ?? ((message: string) => console.log(message));
  const warn = deps.warn ?? ((message: string) => console.warn(message));

  const report: ReconcileThreadRuntimeReport = { scanned: 0, interrupted: 0, turnsInterrupted: 0 };
  let threads: Array<{ threadId: ThreadId }>;
  try {
    threads = await threadStore.listThreads();
  } catch (error) {
    warn('[runtime] thread runtime reconcile failed to list threads: '
      + (error instanceof Error ? error.message : String(error)));
    return report;
  }

  for (const thread of threads) {
    report.scanned += 1;
    if (isThreadLive(thread.threadId)) continue;
    try {
      // checkpoint 读取/写入是可选的 store 能力：缺失时只做 turn 行收口。
      const readCheckpoint = threadStore.getLastCheckpoint?.bind(threadStore);
      const checkpoint = typeof readCheckpoint === 'function'
        ? await readCheckpoint(thread.threadId).catch(() => null)
        : null;
      if (checkpoint && isActiveCheckpoint(checkpoint)) {
        const next: Checkpoint = {
          ...checkpoint!,
          status: 'interrupted',
          executionStatus: 'terminal',
          // 清除活动态标志，避免被再次回推成 running。
          expiresAt: undefined,
        };
        await threadStore.appendCheckpoint(thread.threadId, next);
        report.interrupted += 1;
      }
      // turn 行同样要收口：快照里的 running turn 会让侧栏活动点和发送按钮
      // 一直显示“进行中”，重启也治不好。
      report.turnsInterrupted += await interruptRunningTurns(threadStore, thread.threadId, {
        warn,
        ...(completedAt ? { completedAt } : {}),
      });
    } catch (error) {
      warn('[runtime] thread runtime reconcile failed for ' + thread.threadId + ': '
        + (error instanceof Error ? error.message : String(error)));
    }
  }

  if (report.interrupted > 0 || report.turnsInterrupted > 0) {
    log(
      '[runtime] reconciled ' + report.interrupted + ' stale checkpoint(s) and '
      + report.turnsInterrupted + ' running turn(s) as interrupted',
    );
  }
  void now;
  return report;
}
