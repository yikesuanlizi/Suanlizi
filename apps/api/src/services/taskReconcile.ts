// 影子写期对账（计划 §14.6 / §8 / §6.2 / §11.2 / 盘点 §4.4 / §7.1 风险 1）。
// — Chinese: Shadow-write-period reconciliation: `thread.tags` stays the read-priority source of
// truth and the task tables are the only write target.
//
// 硬约束（任何一条被破坏都必须先改计划，而不是改本文件）：
// 1. **只读 tags，只写 task 表**：`deps.threadStore` 的类型面只暴露读方法（getThread /
//    getLastCheckpoint），本模块不存在任何可以触达 `updateThreadMetadata` 的通道；对账绝不
//    反向改写 tags（§14.6「对账脚本必须幂等，只修正 task 表，不改写 tags」）。
// 2. **幂等**：同一输入重复执行得到同一 task 表终态。补建行的 id 由 harnessRunId 确定性派生
//    （重复执行要么先按 harnessRunId 命中已有 Run 而走 skip，要么按主键撞车被记为 conflict）；
//    推进只在「目标态 ≠ 当前态」时发生，同态直接 skip 且零写入。
// 3. **只做前向修正**：终态 Run（completed / cancelled / failed）永不复活，终态 Task 同理
//    （§11.4 终态无出口；§5.1 retry 只新建 Run）。
// 4. **不自建第二套状态机**：迁移合法性一律走 `@suanlizi/protocol` 的 `TASK_RUN_TRANSITIONS`
//    （经 `@suanlizi/runtime` 的 taskLifecycle 落库），本模块只做「tags → 目标态」的派生与寻路
//    （§11.1 / §11.4）。目标态从当前态不可达时退回 `interrupted`，仍不可达才记 conflict。
// 5. **乐观锁**：写库使用本轮实读到的 `version` 作为 `expectedVersion`，冲突即跳过并记报告
//    （§14.6「重复执行结果一致」的前提是不覆盖并发写入）。
// 6. **单项失败不中断整轮**：每个 harness run 独立 try/catch，失败计入 `report.conflicts`。
//
// 恢复真相仍只在 Agent Checkpoint（§11.2 / 盘点 §4.2）：本模块只把 `getLastCheckpoint` 的结果
// 用于派生 TaskRun 镜像状态，不发起 resume、不写 checkpoint。

import type { Checkpoint, Task, TaskRun, TaskRunState, TaskStorePort } from '@suanlizi/protocol';
import { TASK_RUN_TRANSITIONS, TaskError, isTaskRunTerminalState, isTaskRunState } from '@suanlizi/protocol';
import {
  applyTaskSyncFromRun,
  createRetryRun,
  createTaskWithRun,
  findActiveTask,
  transitionRun,
} from '@suanlizi/runtime';

// ─── thread.tags 契约（只读镜像，事实来源在 runtime/harness/goalTracker.ts） ─────
// goalTracker.ts 的 `TAG_STATE_PREFIX` / `TAG_ACTIVE_RUN_ID` 未从 `@suanlizi/runtime` 包入口导出，
// 本模块按 §4.4 盘点的键形态本地镜像一份，只用于读取；测试用 GoalTracker.persist 真实写入做
// 键名兼容性回归（taskReconcile.test.ts「与 GoalTracker.persist 的键名兼容」用例）。

/** `thread.tags` 中每个 harness run 的状态键前缀：`harnessState:<runId>`。 */
export const HARNESS_STATE_TAG_PREFIX = 'harnessState:';
/** `thread.tags` 中的当前活跃 harness run 键；空串表示无活跃 run（goalTracker 终态时清空）。 */
export const ACTIVE_HARNESS_RUN_ID_TAG = 'activeHarnessRunId';

/** 拼接某个 harness run 的状态 tag key（只读用途）。 */
export function harnessStateTagKey(harnessRunId: string): string {
  return `${HARNESS_STATE_TAG_PREFIX}${harnessRunId}`;
}

// ─── 注入面（刻意收窄为只读） ──────────────────────────────────────────────────

/** 对账需要的最小线程视图：只要 threadId 与 tags。 */
export interface ReconcileThreadRecord {
  threadId: string;
  tags?: Record<string, string> | null;
}

/**
 * 只读线程端口。类型面**故意不包含任何写方法**：调用方即便传入完整的 `LocalThreadStore`，
 * 本模块也无法通过该类型调用 `updateThreadMetadata` / `appendItems` / `saveTurn`。
 */
export interface ReconcileThreadStore {
  getThread(threadId: string): Promise<ReconcileThreadRecord | null>;
  /** 恢复真相读取入口（§11.2）；缺省视为「无 checkpoint」。 */
  getLastCheckpoint?(threadId: string): Promise<Checkpoint | null>;
}

/** 线程列表入口由调用方注入（不 import server.ts，保持可测）。 */
export type ReconcileThreadLister = () => Promise<readonly ReconcileThreadRecord[]>;

export interface ReconcileLogger {
  warn(message: string): void;
  info?(message: string): void;
}

export interface ReconcileTasksDeps {
  threadStore: ReconcileThreadStore;
  taskStore: TaskStorePort;
  listThreads: ReconcileThreadLister;
  /** 本轮统一时间戳（ISO-8601）；注入固定值可让对账结果完全确定。 */
  now?: string;
  logger?: ReconcileLogger;
  /**
   * 进程内活跃判据（§4.2 单进程假设）。缺省时「tags 里的 activeHarnessRunId」即视为活跃，
   * 对账因此不会把正在跑的 run 误判为 interrupted。
   */
  isLive?: (input: { threadId: string; harnessRunId: string }) => boolean;
}

// ─── 报告 ──────────────────────────────────────────────────────────────────────

export type ReconcileAction = 'created' | 'updated' | 'skipped' | 'conflict';

export interface ReconcileItemReport {
  threadId: string;
  harnessRunId: string;
  action: ReconcileAction;
  /** 稳定机器可读原因码，取值见本文件 `RECONCILE_REASONS` 注释块。 */
  reason: string;
  taskId?: string;
  runId?: string;
  /** tags 里读到的 harness 状态原文。 */
  harnessStatus?: string;
  fromStatus?: TaskRunState;
  toStatus?: TaskRunState;
  /** 失败详情（仅 conflict）。 */
  error?: string;
}

export interface ReconcileReport {
  threadsScanned: number;
  harnessRunsScanned: number;
  created: number;
  updated: number;
  skipped: number;
  conflicts: number;
  /** reason → 次数。 */
  reasons: Record<string, number>;
  items: ReconcileItemReport[];
}

/**
 * reason 目录（稳定字符串，报告与日志共用）：
 * - `missing-task-run`            task 表缺失，已补建（created）
 * - `up-to-date`                  task 表已领先或持平，无需写入（skipped）
 * - `forward-fix`                 task 表落后，已前向修正（updated）
 * - `terminal-run-not-revived`    既有 Run 已终态，永不复活（skipped）
 * - `illegal-target-interrupted`  目标态不可达，按 §14.6 退回 interrupted（updated）
 * - `task-synced`                 Run 未变但 Task 层落后，已同步 Task（updated）
 * - `thread-scan-failed`          列线程失败（conflict，整轮无逐项报告）
 * - `thread-id-missing`           线程记录缺 threadId（skipped）
 * - `thread-read-failed`          单线程读取失败（conflict）
 * - `active-run-without-state-tag` activeHarnessRunId 指向的键不存在（skipped）
 * - `invalid-harness-state-tag`   tags 值不是可解析的 HarnessState（conflict）
 * - `objective-missing`           harness goal 为空，无法建 Task（conflict）
 * - `version-conflict`            乐观锁冲突（conflict）
 * - `illegal-transition`          迁移被协议状态机拒绝（conflict）
 * - `write-failed`                其他写库异常（conflict）
 */

// ─── 主入口 ────────────────────────────────────────────────────────────────────

/**
 * 幂等对账：遍历线程（或调用方注入的线程列表），读取 `thread.tags` 的
 * `harnessState:<runId>` 与 `activeHarnessRunId`，只修正 task 表。
 *
 * 返回 `ReconcileReport`；除「列线程失败」外不抛出任何单项异常。
 */
export async function reconcileTasksFromTags(deps: ReconcileTasksDeps): Promise<ReconcileReport> {
  const { threadStore, taskStore, listThreads } = deps;
  const now = deps.now ?? new Date().toISOString();
  const logger = deps.logger;
  const report = createReport();

  let threads: readonly ReconcileThreadRecord[];
  try {
    threads = (await listThreads()) ?? [];
  } catch (error) {
    pushItem(report, {
      threadId: '*',
      harnessRunId: '*',
      action: 'conflict',
      reason: 'thread-scan-failed',
      error: messageOf(error),
    });
    logger?.warn(`[tasks] reconcile aborted: cannot list threads: ${messageOf(error)}`);
    return report;
  }

  for (const listed of threads) {
    const listedId = (listed?.threadId ?? '').trim();
    if (!listedId) {
      pushItem(report, {
        threadId: '',
        harnessRunId: '',
        action: 'skipped',
        reason: 'thread-id-missing',
      });
      continue;
    }
    report.threadsScanned += 1;

    let tags: Record<string, string> = {};
    try {
      // 以 threadStore 为准重读 tags（listThreads 可能只回摘要），但仍只读不写。
      const thread = await threadStore.getThread(listedId);
      tags = { ...(thread?.tags ?? listed.tags ?? {}) };
    } catch (error) {
      pushItem(report, {
        threadId: listedId,
        harnessRunId: '',
        action: 'conflict',
        reason: 'thread-read-failed',
        error: messageOf(error),
      });
      logger?.warn(
        `[tasks] reconcile conflict for thread ${listedId}: thread read failed (${messageOf(error)})`,
      );
      continue;
    }

    const activeRunId = (tags[ACTIVE_HARNESS_RUN_ID_TAG] ?? '').trim();
    const harnessRunIds = collectHarnessRunIds(tags, activeRunId);
    if (harnessRunIds.length === 0) continue;

    const checkpoint = await readCheckpoint(threadStore, listedId, logger);

    for (const harnessRunId of harnessRunIds) {
      report.harnessRunsScanned += 1;
      await reconcileOneHarnessRun({
        report,
        logger,
        now,
        threadId: listedId,
        harnessRunId,
        tags,
        activeRunId,
        checkpoint,
        taskStore,
        isLive: deps.isLive,
      });
    }
  }

  logger?.info?.(
    `[tasks] reconcile finished: threads=${report.threadsScanned} runs=${report.harnessRunsScanned} ` +
      `created=${report.created} updated=${report.updated} skipped=${report.skipped} conflicts=${report.conflicts}`,
  );
  return report;
}

// ─── 单 run 对账 ───────────────────────────────────────────────────────────────

interface ReconcileRunContext {
  report: ReconcileReport;
  logger?: ReconcileLogger;
  now: string;
  threadId: string;
  harnessRunId: string;
  tags: Record<string, string>;
  activeRunId: string;
  checkpoint: Checkpoint | null;
  taskStore: TaskStorePort;
  isLive?: (input: { threadId: string; harnessRunId: string }) => boolean;
}

async function reconcileOneHarnessRun(ctx: ReconcileRunContext): Promise<void> {
  const { threadId, harnessRunId, taskStore } = ctx;
  const raw = ctx.tags[harnessStateTagKey(harnessRunId)];
  if (raw === undefined || raw === '') {
    // activeHarnessRunId 指向一个不存在的状态键：没有可比对的事实来源，只记不改。
    pushItem(ctx.report, {
      threadId,
      harnessRunId,
      action: 'skipped',
      reason: 'active-run-without-state-tag',
    });
    return;
  }

  const state = parseHarnessState(raw, harnessRunId);
  if (!state) {
    pushConflict(ctx, {
      threadId,
      harnessRunId,
      reason: 'invalid-harness-state-tag',
      error: 'thread.tags value is not a JSON HarnessState object',
    });
    return;
  }

  let existing: { task: Task; run: TaskRun } | null = null;
  try {
    const isActiveRun = ctx.activeRunId === harnessRunId;
    const live = ctx.isLive ? ctx.isLive({ threadId, harnessRunId }) : isActiveRun;
    // 定位查询也在 try 内：task 表读失败同样只记单项 conflict，不抖整轮。
    existing = await findRunByHarnessRunId(taskStore, threadId, harnessRunId);
    if (!existing) {
      await createMissingTaskRun(ctx, state, { isActiveRun, live });
      return;
    }
    await forwardFixExistingRun(ctx, state, existing.task, existing.run, { isActiveRun, live });
  } catch (error) {
    pushConflict(ctx, {
      threadId,
      harnessRunId,
      reason: classifyError(error),
      taskId: existing?.task.id,
      runId: existing?.run.id,
      harnessStatus: state.status,
      fromStatus: existing?.run.status,
      error: messageOf(error),
    });
  }
}

/** 补建缺失的 Task / goal TaskRun（tags 有、task 表无）。 */
async function createMissingTaskRun(
  ctx: ReconcileRunContext,
  state: HarnessStateSnapshot,
  flags: { isActiveRun: boolean; live: boolean },
): Promise<void> {
  const { threadId, harnessRunId, taskStore, now } = ctx;
  const objective = state.objective.trim();
  if (!objective) {
    pushConflict(ctx, {
      threadId,
      harnessRunId,
      reason: 'objective-missing',
      harnessStatus: state.status,
      error: 'harness goal.objective is empty; a Task cannot be created without an objective',
    });
    return;
  }

  const desired = deriveDesiredRunState({
    harnessStatus: state.status,
    checkpoint: ctx.checkpoint,
    isActiveRun: flags.isActiveRun,
    live: flags.live,
    now,
  });

  // 同 thread 已有 active Task（影子写只建了一半，或历史 run 的 tags 仍在）时，
  // 复用该 Task 追加 goal Run，避免违反「一个 thread 最多一个 active Task」（§5.1）。
  const activeTask = await findActiveTask(taskStore, threadId, 'harness_shadow');
  let task: Task;
  let run: TaskRun;
  if (activeTask) {
    const retried = await createRetryRun(taskStore, activeTask.id, {
      kind: 'goal',
      harnessRunId,
      ids: { runId: taskRunIdFor(harnessRunId) },
      now,
    });
    task = retried.task;
    run = retried.run;
  } else {
    const created = await createTaskWithRun(taskStore, {
      threadId,
      objective,
      acceptanceCriteria: state.acceptanceCriteria,
      kind: 'goal',
      harnessRunId,
      origin: 'harness_shadow',
      // 确定性 id：重复执行或对账与影子写并发时按主键撞车，不会产生第二份真相。
      ids: { taskId: taskIdFor(harnessRunId), runId: taskRunIdFor(harnessRunId) },
      now,
    });
    task = created.task;
    run = created.run;
  }

  const walked = await walkRunTo(ctx, run, desired, state);
  const synced = await applyTaskSyncFromRun(taskStore, walked.task ?? task, walked.run, { now });

  pushItem(ctx.report, {
    threadId,
    harnessRunId,
    action: 'created',
    reason: 'missing-task-run',
    taskId: synced.id,
    runId: walked.run.id,
    harnessStatus: state.status,
    fromStatus: 'queued',
    toStatus: walked.run.status,
  });
}

/** 已存在但可能落后：只做前向修正，不复活终态，不改写 tags。 */
async function forwardFixExistingRun(
  ctx: ReconcileRunContext,
  state: HarnessStateSnapshot,
  task: Task,
  run: TaskRun,
  flags: { isActiveRun: boolean; live: boolean },
): Promise<void> {
  const { threadId, harnessRunId, taskStore, now } = ctx;

  if (isTaskRunTerminalState(run.status)) {
    // §11.4 终态无出口：tags 说什么都不得改写既有终态。
    const { task: synced, changed } = await syncTaskQuietly(taskStore, task, run, now);
    pushItem(ctx.report, {
      threadId,
      harnessRunId,
      action: changed ? 'updated' : 'skipped',
      reason: changed ? 'task-synced' : 'terminal-run-not-revived',
      taskId: synced.id,
      runId: run.id,
      harnessStatus: state.status,
      fromStatus: run.status,
      toStatus: run.status,
    });
    return;
  }

  const desired = deriveDesiredRunState({
    harnessStatus: state.status,
    checkpoint: ctx.checkpoint,
    isActiveRun: flags.isActiveRun,
    live: flags.live,
    now,
    existingCheckpointId: run.checkpointId,
  });

  if (run.status === desired) {
    // Run 不落后；Task 层可能落后（例如影子写崩在 Run 与 Task 之间），同态时该调用零写入。
    const { task: synced, changed } = await syncTaskQuietly(taskStore, task, run, now);
    pushItem(ctx.report, {
      threadId,
      harnessRunId,
      action: changed ? 'updated' : 'skipped',
      reason: changed ? 'task-synced' : 'up-to-date',
      taskId: synced.id,
      runId: run.id,
      harnessStatus: state.status,
      fromStatus: run.status,
      toStatus: run.status,
    });
    return;
  }

  const walked = await walkRunTo(ctx, run, desired, state, run.version);
  const refreshedTask = await taskStore.getTask(walked.run.taskId);
  const synced = await applyTaskSyncFromRun(taskStore, refreshedTask ?? task, walked.run, { now });

  pushItem(ctx.report, {
    threadId,
    harnessRunId,
    action: 'updated',
    reason: walked.fallbackToInterrupted ? 'illegal-target-interrupted' : 'forward-fix',
    taskId: synced.id,
    runId: walked.run.id,
    harnessStatus: state.status,
    fromStatus: run.status,
    toStatus: walked.run.status,
  });
}

// ─── 状态派生表 ────────────────────────────────────────────────────────────────

/**
 * harness 状态 + Agent Checkpoint → 合法 TaskRunState（计划 §6.2「根据 checkpoint 决定恢复或
 * 标记 interrupted」、§11.2 恢复顺序、盘点 §4.4 harnessState 形态）。
 *
 * | harness.status             | checkpoint                             | TaskRun 目标态 |
 * |----------------------------|----------------------------------------|----------------|
 * | satisfied                  | -（harness 自身即终态）                | completed      |
 * | blocked                    | -                                      | blocked        |
 * | cancelled                  | -                                      | cancelled      |
 * | no_progress                | -                                      | interrupted    |
 * | max_continuations          | -                                      | interrupted    |
 * | active                     | waiting_user_input / pending decision  | blocked        |
 * | active                     | failed                                 | failed         |
 * | active                     | interrupted / stale / stopping         | interrupted    |
 * | active                     | running 且未过期且本 run 活跃且在线     | running        |
 * | active                     | running 已过期 / 已被新 turn 取代       | interrupted    |
 * | active                     | terminal / completed / idle / 缺失     | 活跃→running，否则 interrupted |
 * | 未知取值                    | 同 active 分支（保守按 checkpoint 判定） |                |
 *
 * `interrupted` 而非 `failed` 是刻意的：崩溃/重启遗留不等于目标失败，Task 层由
 * `syncTaskFromRun` 保守推导为 blocked 等待接管（§7.1 风险 4）。
 */
export function deriveDesiredRunState(input: {
  harnessStatus: string;
  checkpoint: Checkpoint | null;
  isActiveRun: boolean;
  live: boolean;
  now: string;
  existingCheckpointId?: string;
}): TaskRunState {
  switch (input.harnessStatus) {
    case 'satisfied':
      return 'completed';
    case 'blocked':
      return 'blocked';
    case 'cancelled':
      return 'cancelled';
    case 'no_progress':
    case 'max_continuations':
      return 'interrupted';
    default:
      break;
  }

  // 其余（active / 未知取值）以 Agent Checkpoint 为准；checkpoint 只能把状态往下压，
  // 不得替 harness 宣布 satisfied/cancelled（那是 tags 的专属语义，§8 读优先）。
  const ckpt = input.checkpoint;
  if (!ckpt) {
    return input.isActiveRun && input.live ? 'running' : 'interrupted';
  }

  // 盘点 §4.2：checkpointId = 裸 String(turnId)；被新 turn 取代 ⇒ 严禁按 checkpoint 继续判定。
  if (input.existingCheckpointId && String(ckpt.turnId) !== String(input.existingCheckpointId)) {
    return 'interrupted';
  }

  const status = ckpt.status;
  const executionStatus = ckpt.executionStatus;
  const waitingForUser =
    status === 'waiting_user_input' ||
    executionStatus === 'waiting_user_input' ||
    (ckpt.decisionRequest != null && ckpt.decisionRequest.status === 'pending');
  if (waitingForUser) return 'blocked';
  if (status === 'failed') return 'failed';
  if (status === 'interrupted' || status === 'stale') return 'interrupted';
  if (status === 'stopping' || executionStatus === 'stopping') return 'interrupted';

  const running = status === 'running' || executionStatus === 'running';
  const notExpired = !ckpt.expiresAt || Date.parse(input.now) < Date.parse(ckpt.expiresAt);
  if (running) {
    return input.isActiveRun && input.live && notExpired ? 'running' : 'interrupted';
  }
  // terminal / completed / idle（且 harness 仍 active）：本 run 还活着就保持 running，
  // 否则视为崩溃遗留。
  return input.isActiveRun && input.live ? 'running' : 'interrupted';
}

// ─── 迁移寻路（唯一迁移表，不散落 if/else） ─────────────────────────────────────

/**
 * 在 `TASK_RUN_TRANSITIONS` 上做一次确定性的最短路径搜索。
 * 邻居顺序取迁移表声明顺序，因此同一输入在任何进程上的路径唯一。
 * 返回不含起点、含终点的状态序列；`from === to` 返回空数组；不可达返回 null。
 */
export function findTransitionPath(from: TaskRunState, to: TaskRunState): TaskRunState[] | null {
  if (from === to) return [];
  const previous = new Map<TaskRunState, TaskRunState>();
  const seen = new Set<TaskRunState>([from]);
  const queue: TaskRunState[] = [from];
  while (queue.length > 0) {
    const current = queue.shift() as TaskRunState;
    for (const next of TASK_RUN_TRANSITIONS[current]) {
      if (seen.has(next)) continue;
      seen.add(next);
      previous.set(next, current);
      if (next === to) {
        const path: TaskRunState[] = [next];
        let cursor = next;
        while (cursor !== from) {
          cursor = previous.get(cursor) as TaskRunState;
          if (cursor !== from) path.unshift(cursor);
        }
        return path;
      }
      queue.push(next);
    }
  }
  return null;
}

interface WalkResult {
  run: TaskRun;
  task?: Task;
  /** 目标态不可达、退回 interrupted 时为 true。 */
  fallbackToInterrupted: boolean;
  hops: number;
}

/**
 * 沿迁移表把 Run 前向推进到目标态。每一跳都带实读 version 做乐观锁；
 * 目标态不可达时退回 `interrupted`（§14.6「非法即 interrupted」）。
 */
async function walkRunTo(
  ctx: ReconcileRunContext,
  run: TaskRun,
  desired: TaskRunState,
  state: HarnessStateSnapshot,
  expectedVersion?: number,
): Promise<WalkResult> {
  const { taskStore, now } = ctx;
  let target = desired;
  let path = findTransitionPath(run.status, target);
  let fallbackToInterrupted = false;
  if (!path) {
    target = 'interrupted';
    fallbackToInterrupted = true;
    path = findTransitionPath(run.status, target);
  }
  if (!path) {
    throw new TaskError(
      'TASK_INVALID_TRANSITION',
      `cannot reconcile task run ${run.id} from ${run.status} to ${desired} (nor to interrupted)`,
      { runId: run.id, from: run.status, to: desired },
    );
  }

  let current = run;
  let expect = expectedVersion ?? run.version;
  for (const next of path) {
    const note = reconcileNote(state, target);
    const checkpointId =
      !current.checkpointId && ctx.checkpoint ? String(ctx.checkpoint.turnId) : undefined;
    current = await transitionRun(taskStore, current.id, next, {
      expectedVersion: expect,
      now,
      error: note && !current.error ? note : undefined,
      checkpointId,
    });
    expect = current.version;
  }

  const task = await taskStore.getTask(current.taskId);
  return { run: current, task: task ?? undefined, fallbackToInterrupted, hops: path.length };
}

/** Task 层前向同步，返回是否真的写过（用于区分 updated / skipped）。 */
async function syncTaskQuietly(
  taskStore: TaskStorePort,
  task: Task,
  run: TaskRun,
  now: string,
): Promise<{ task: Task; changed: boolean }> {
  const base = (await taskStore.getTask(task.id)) ?? task;
  const synced = await applyTaskSyncFromRun(taskStore, base, run, { now });
  return { task: synced, changed: synced.version !== base.version };
}

/** 只有「需要人看的原因」类状态才写 error 文本，避免给 running/completed Run 制造噪声字段。 */
function reconcileNote(state: HarnessStateSnapshot, target: TaskRunState): string | undefined {
  if (target === 'running' || target === 'queued' || target === 'completed') return undefined;
  const detail = state.blocker ? `: ${state.blocker}` : '';
  return `reconciled from thread.tags harnessState:${state.harnessRunId} (status=${state.status})${detail}`;
}

// ─── tags 解析（只读，容错） ───────────────────────────────────────────────────

/** 对账实际消费的 harness 字段子集；tags 是历史数据，必须按不可信输入解析。 */
interface HarnessStateSnapshot {
  harnessRunId: string;
  status: string;
  objective: string;
  acceptanceCriteria: string[];
  blocker?: string;
  startedAt?: string;
  updatedAt?: string;
}

function parseHarnessState(raw: string, fallbackRunId: string): HarnessStateSnapshot | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const state = parsed as Record<string, unknown>;
  const goal = isRecord(state.goal) ? state.goal : {};
  const evaluation = isRecord(state.lastEvaluation) ? state.lastEvaluation : undefined;
  const status = asString(state.status) ?? 'active';
  return {
    harnessRunId: asString(state.harnessRunId) ?? fallbackRunId,
    status,
    objective: asString(goal.objective) ?? '',
    acceptanceCriteria: asStringArray(goal.acceptanceCriteria),
    blocker: evaluation ? asString(evaluation.blocker) ?? undefined : undefined,
    startedAt: asString(state.startedAt) ?? undefined,
    updatedAt: asString(state.updatedAt) ?? undefined,
  };
}

/**
 * 列出 tags 中出现的全部 harness run id（含 activeHarnessRunId），按状态里的 updatedAt 升序稳定排序
 * —— 让历史 run 先被收敛到终态，再处理最新 run，避免「给旧 run 补建时撞上仍活跃的 Task」。
 * 解析失败的键排在最后（由逐项阶段记 invalid-harness-state-tag conflict）。
 */
function collectHarnessRunIds(tags: Record<string, string>, activeRunId: string): string[] {
  const ids = new Set<string>();
  for (const key of Object.keys(tags)) {
    if (!key.startsWith(HARNESS_STATE_TAG_PREFIX)) continue;
    const runId = key.slice(HARNESS_STATE_TAG_PREFIX.length).trim();
    if (runId) ids.add(runId);
  }
  if (activeRunId) ids.add(activeRunId);
  return [...ids].sort((a, b) => {
    const left = sortKeyOf(tags[harnessStateTagKey(a)], a);
    const right = sortKeyOf(tags[harnessStateTagKey(b)], b);
    if (left === right) return a < b ? -1 : a > b ? 1 : 0;
    if (!left) return 1;
    if (!right) return -1;
    return left < right ? -1 : 1;
  });
}

function sortKeyOf(raw: string | undefined, fallbackRunId: string): string {
  if (raw === undefined || raw === '') return '';
  const parsed = parseHarnessState(raw, fallbackRunId);
  return parsed?.updatedAt ?? parsed?.startedAt ?? '';
}

async function readCheckpoint(
  threadStore: ReconcileThreadStore,
  threadId: string,
  logger?: ReconcileLogger,
): Promise<Checkpoint | null> {
  if (typeof threadStore.getLastCheckpoint !== 'function') return null;
  try {
    return (await threadStore.getLastCheckpoint(threadId)) ?? null;
  } catch (error) {
    logger?.warn(
      `[tasks] reconcile cannot read checkpoint of thread ${threadId}: ${messageOf(error)}`,
    );
    return null;
  }
}

/** 按 harnessRunId 在本线程的 task 表里找对应 Run（tags 与 task 表的关联键）。 */
async function findRunByHarnessRunId(
  taskStore: TaskStorePort,
  threadId: string,
  harnessRunId: string,
): Promise<{ task: Task; run: TaskRun } | null> {
  const tasks = await taskStore.listTasks({ threadId });
  for (const task of tasks ?? []) {
    const runs = await taskStore.listRuns(task.id);
    for (const run of runs ?? []) {
      if (run.harnessRunId === harnessRunId) return { task, run };
    }
  }
  return null;
}

// ─── 小工具 ────────────────────────────────────────────────────────────────────

/** 确定性 id：对同一 harnessRunId 永远得到同一行 id，重复执行不会补出第二份。 */
function taskIdFor(harnessRunId: string): string {
  return `task_reconcile_${sanitize(harnessRunId)}`;
}

function taskRunIdFor(harnessRunId: string): string {
  return `run_reconcile_${sanitize(harnessRunId)}`;
}

function sanitize(value: string): string {
  return value.trim().replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
}

function createReport(): ReconcileReport {
  return {
    threadsScanned: 0,
    harnessRunsScanned: 0,
    created: 0,
    updated: 0,
    skipped: 0,
    conflicts: 0,
    reasons: {},
    items: [],
  };
}

function pushItem(report: ReconcileReport, item: ReconcileItemReport): void {
  report.items.push(item);
  report[ACTION_COUNTER_KEY[item.action]] += 1;
  report.reasons[item.reason] = (report.reasons[item.reason] ?? 0) + 1;
}

/** 单项失败：计入 conflicts + 落一条 warning，但绝不抛出（§14.6 不中断整轮）。 */
function pushConflict(
  ctx: Pick<ReconcileRunContext, 'report' | 'logger'>,
  fields: Omit<ReconcileItemReport, 'action'>,
): void {
  const item: ReconcileItemReport = { ...fields, action: 'conflict' };
  pushItem(ctx.report, item);
  ctx.logger?.warn(
    `[tasks] reconcile conflict for thread ${item.threadId} harness ${item.harnessRunId}: ${item.reason}` +
      `${item.error ? ` (${item.error})` : ''}`,
  );
}

/** action → 计数字段（`conflict` 对应复数 `conflicts`）。 */
const ACTION_COUNTER_KEY: Readonly<Record<ReconcileAction, 'created' | 'updated' | 'skipped' | 'conflicts'>> = {
  created: 'created',
  updated: 'updated',
  skipped: 'skipped',
  conflict: 'conflicts',
};

function classifyError(error: unknown): string {
  if (error instanceof TaskError) {
    if (error.code === 'TASK_VERSION_CONFLICT') return 'version-conflict';
    if (error.code === 'TASK_INVALID_TRANSITION' || error.code === 'TASK_TERMINAL_STATE') {
      return 'illegal-transition';
    }
    if (error.code === 'TASK_ACTIVE_EXISTS') return 'version-conflict';
  }
  return 'write-failed';
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value
        .filter((item): item is string => typeof item === 'string')
        .map((item) => item.trim())
        .filter((item) => item.length > 0),
    ),
  ];
}

/** 供调用方与测试断言状态取值用（不额外引入 runtime 的私有类型）。 */
export function isReconcileTargetState(value: string): value is TaskRunState {
  return isTaskRunState(value);
}
