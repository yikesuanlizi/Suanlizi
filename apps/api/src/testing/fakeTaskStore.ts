// 测试工装：内存版 TaskStorePort（带 protocol 迁移表与乐观锁校验）。
// 仅供 apps/api 测试使用，不承载业务逻辑；生产装配一律走 @suanlizi/storage 的 SqliteTaskStore。
import type {
  Task,
  TaskRun,
  TaskListFilter,
  TaskStatus,
  TaskStorePort,
  WorkflowAgentCall,
  WorkflowRunRecord,
  WorkflowRunListFilter,
} from '@suanlizi/protocol';
import {
  TaskError,
  assertTaskRunTransition,
  assertTaskStatusTransition,
  validateTaskVersion,
} from '@suanlizi/protocol';

export class FakeTaskStore implements TaskStorePort {
  tasks = new Map<string, Task>();
  runs = new Map<string, TaskRun>();

  async createTask(task: Task): Promise<Task> {
    if (this.tasks.has(task.id)) throw new TaskError('TASK_ACTIVE_EXISTS', 'dup task id');
    this.tasks.set(task.id, structuredClone(task));
    return structuredClone(task);
  }

  async getTask(id: string): Promise<Task | null> {
    const task = this.tasks.get(id);
    return task ? structuredClone(task) : null;
  }

  async updateTask(
    id: string,
    patch: Partial<Omit<Task, 'id' | 'createdAt'>>,
    expectedVersion: number,
  ): Promise<Task> {
    const current = this.tasks.get(id);
    if (!current) throw new TaskError('TASK_NOT_FOUND', `task ${id} not found`);
    validateTaskVersion(current.version, expectedVersion);
    if (patch.status && patch.status !== current.status) {
      assertTaskStatusTransition(current.status, patch.status);
    }
    const next: Task = { ...current, ...patch, version: current.version + 1 };
    this.tasks.set(id, next);
    return structuredClone(next);
  }

  async listTasks(filter?: TaskListFilter): Promise<Task[]> {
    let all = [...this.tasks.values()];
    if (filter?.threadId) all = all.filter((task) => task.threadId === filter.threadId);
    if (filter?.status) all = all.filter((task) => (filter.status as readonly TaskStatus[]).includes(task.status));
    if (filter?.origin?.length) {
      all = all.filter((task) => {
        const origin = task.origin === 'explicit_goal' || task.origin === 'explicit_workflow'
          ? task.origin
          : 'harness_shadow';
        return filter.origin?.includes(origin);
      });
    }
    return all.map((task) => structuredClone(task));
  }

  async createRun(run: TaskRun): Promise<TaskRun> {
    if (this.runs.has(run.id)) throw new TaskError('TASK_ACTIVE_EXISTS', 'dup run id');
    this.runs.set(run.id, structuredClone(run));
    return structuredClone(run);
  }

  async getRun(id: string): Promise<TaskRun | null> {
    const run = this.runs.get(id);
    return run ? structuredClone(run) : null;
  }

  async updateRun(
    id: string,
    patch: Partial<Omit<TaskRun, 'id' | 'taskId'>>,
    expectedVersion: number,
  ): Promise<TaskRun> {
    const current = this.runs.get(id);
    if (!current) throw new TaskError('TASK_RUN_NOT_FOUND', `run ${id} not found`);
    validateTaskVersion(current.version, expectedVersion);
    if (patch.status && patch.status !== current.status) {
      assertTaskRunTransition(current.status, patch.status);
    }
    const next: TaskRun = { ...current, ...patch, version: current.version + 1 };
    this.runs.set(id, next);
    return structuredClone(next);
  }

  async listRuns(taskId: string): Promise<TaskRun[]> {
    return [...this.runs.values()]
      .filter((run) => run.taskId === taskId)
      .map((run) => structuredClone(run));
  }

  async upsertWorkflowRun(_record: WorkflowRunRecord): Promise<WorkflowRunRecord> {
    throw new Error('FakeTaskStore: workflow runs not used by these tests');
  }

  async getWorkflowRun(_id: string): Promise<WorkflowRunRecord | null> {
    return null;
  }

  async listWorkflowRuns(_filter?: WorkflowRunListFilter): Promise<WorkflowRunRecord[]> {
    return [];
  }

  async recordAgentCall(_runId: string, _call: WorkflowAgentCall): Promise<WorkflowAgentCall> {
    throw new Error('FakeTaskStore: agent calls not used by these tests');
  }

  async updateAgentCall(_runId: string, _call: WorkflowAgentCall): Promise<WorkflowAgentCall> {
    throw new Error('FakeTaskStore: agent calls not used by these tests');
  }

  async listAgentCalls(_runId: string): Promise<WorkflowAgentCall[]> {
    return [];
  }

  async recoverInterruptedRuns(_isLive: (run: TaskRun) => boolean): Promise<TaskRun[]> {
    return [];
  }
}
