// GET /api/tasks/:id/goal-status 的读取服务（计划 §13.1）。
//
// 真相来源：GoalTracker 把 harness 状态写在 `thread.tags['harnessState:<harnessRunId>']`，
// 其中 `lastEvaluation` 就是最近一次 GoalEvaluation（types.ts 的既有载体，§14.1 禁止第二套）。
// 本服务只读 tags 与 task 表，不写任何状态；tags 属历史数据，一律按不可信输入解析。
//
// — Chinese: read-only goal-status projection from harnessState tags + task table.

import { TaskError, type GoalEvaluation, type Task, type TaskRun, type TaskStorePort } from '@suanlizi/protocol';
import type { TaskGoalStatusResponse } from '@suanlizi/protocol';

/** 只需要读 thread 元数据的能力面（LocalThreadStore 结构子集，便于测试注入）。 */
export interface GoalStatusThreadReader {
  getThread(threadId: string): Promise<{ tags?: Record<string, string> } | null>;
}

export interface TaskGoalStatusServiceDeps {
  taskStore: Pick<TaskStorePort, 'getTask' | 'getRun' | 'listRuns'>;
  threadStore: GoalStatusThreadReader;
}

interface HarnessStateTag {
  status?: unknown;
  goal?: unknown;
  lastEvaluation?: unknown;
}

export interface TaskGoalStatusService {
  readGoalStatus(taskId: string): Promise<TaskGoalStatusResponse>;
  /** 供生命周期层发 `task.goal.evaluation.available` 事件：只读最近一次 GoalEvaluation。 */
  readGoalEvaluation(taskId: string, runId: string): Promise<GoalEvaluation | null>;
}

export function createTaskGoalStatusService(deps: TaskGoalStatusServiceDeps): TaskGoalStatusService {
  async function readGoalStatus(taskId: string): Promise<TaskGoalStatusResponse> {
    const task = await deps.taskStore.getTask(taskId);
    if (!task) {
      throw new TaskError('TASK_NOT_FOUND', `task ${taskId} not found`, { taskId });
    }
    const goalRun = await currentGoalRun(deps, task);
    const base: TaskGoalStatusResponse = {
      taskId: task.id,
      passedCriteria: [],
      failedCriteria: [],
      evidenceIds: [...(task.evidenceIds ?? [])],
    };
    if (!goalRun) return base;
    base.runId = goalRun.id;

    const evaluation = await readEvaluation(deps, goalRun);
    if (!evaluation) return base;
    base.evaluation = evaluation;
    base.passedCriteria = toStringList(evaluation.passedCriteria);
    base.failedCriteria = toStringList(evaluation.failedCriteria);
    if (typeof evaluation.blocker === 'string' && evaluation.blocker.trim()) {
      base.blocker = evaluation.blocker;
    }
    return base;
  }

  async function readGoalEvaluation(taskId: string, runId: string): Promise<GoalEvaluation | null> {
    const run = await deps.taskStore.getRun(runId);
    if (!run || run.taskId !== taskId || run.kind !== 'goal') return null;
    return readEvaluation(deps, run);
  }

  return { readGoalStatus, readGoalEvaluation };
}

/** 当前 GoalRun：优先 task.currentRunId 上的 goal run，否则回退到最近一条 goal run。 */
async function currentGoalRun(
  deps: TaskGoalStatusServiceDeps,
  task: Task,
): Promise<TaskRun | null> {
  if (task.currentRunId) {
    const run = await deps.taskStore.getRun(task.currentRunId);
    if (run && run.kind === 'goal') return run;
  }
  const runs = await deps.taskStore.listRuns(task.id);
  const goalRuns = runs.filter((run) => run.kind === 'goal');
  return goalRuns.length > 0 ? goalRuns[goalRuns.length - 1] as TaskRun : null;
}

async function readEvaluation(
  deps: TaskGoalStatusServiceDeps,
  run: TaskRun,
): Promise<GoalEvaluation | null> {
  if (!run.harnessRunId) return null;
  const thread = await deps.threadStore.getThread(run.threadId);
  const raw = thread?.tags?.[`harnessState:${run.harnessRunId}`];
  if (typeof raw !== 'string' || !raw.trim()) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const evaluation = (parsed as HarnessStateTag).lastEvaluation;
  if (!evaluation || typeof evaluation !== 'object' || Array.isArray(evaluation)) return null;
  return evaluation as GoalEvaluation;
}

function toStringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : [];
}
