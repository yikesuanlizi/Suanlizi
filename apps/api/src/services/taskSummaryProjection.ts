// TaskCenter 摘要投影：把 TaskRun 与 WorkflowRun/AgentCall 的持久化事实
// 合并回 Task DTO，供列表计数和详情证据展示使用；不改变 Task 的终态语义。
import type { Task, TaskStorePort } from '@suanlizi/protocol';

export type TaskSummaryStore = Pick<TaskStorePort, 'listRuns' | 'getWorkflowRun' | 'listAgentCalls'>;

/**
 * runIds / evidenceIds 是 Task 的汇总字段，但执行记录与 Workflow 证据分别落在独立表。
 * 从单一事实来源补齐 DTO，避免旧记录或独立 Dynamic Workflow 显示为 0 次运行 / 0 条证据。
 */
export async function projectTaskSummary(task: Task, store: TaskSummaryStore): Promise<Task> {
  const runs = await store.listRuns(task.id);
  const workflowRunIds = [...new Set(runs
    .map((run) => run.workflowRunId)
    .filter((id): id is string => typeof id === 'string' && id.length > 0))];

  const evidenceGroups = await Promise.all(workflowRunIds.map(async (workflowRunId) => {
    const [workflowRun, agentCalls] = await Promise.all([
      store.getWorkflowRun(workflowRunId),
      store.listAgentCalls(workflowRunId),
    ]);
    return [
      ...(workflowRun?.evidenceId ? [workflowRun.evidenceId] : []),
      ...agentCalls
        .map((call) => call.evidenceId)
        .filter((id): id is string => typeof id === 'string' && id.length > 0),
    ];
  }));

  return {
    ...task,
    runIds: [...new Set([...task.runIds, ...runs.map((run) => run.id)])],
    evidenceIds: [...new Set([...task.evidenceIds, ...evidenceGroups.flat()])],
  };
}
