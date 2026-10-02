import type { Locale } from '../config/config.js';
import type { ThreadItem } from '../shared/types.js';
import type { TaskRuntimeMonitorState } from '../features/monitor/taskRuntimeMonitor.js';

export function TaskRuntimeMonitorPanel({
  locale,
  state,
  items = [],
}: {
  locale: Locale;
  state?: TaskRuntimeMonitorState;
  items?: ThreadItem[];
}) {
  const zh = locale === 'zh';
  const cognition = state?.cognition?.cognition;
  const context = state?.context;
  const loop = state?.loop;
  const runtime = state?.runtime ?? null;
  const events = state?.events ?? [];
  const recentItems = summarizeItems(items, zh);
  const taskSteps = buildTaskSteps({ cognition, items, recentItems, runtime, zh });

  return (
    <section className="taskRuntimePanel" aria-label={zh ? '任务列表' : 'Task list'}>
      <div className="taskRuntimeHeader">
        <div>
          <h2>{zh ? '任务列表' : 'Task List'}</h2>
          <p>{zh ? '任务步骤、运行阶段与执行项' : 'Task steps, phase and activity'}</p>
        </div>
        {runtime ? (
          <span className={`taskRuntimeStatus ${runtime.status}`}>
            {statusLabel(runtime.status, zh)}
          </span>
        ) : null}
      </div>

      <div className="taskRuntimeBody">
        {runtime ? (
          <div className="taskRuntimePhase">
            { /* 不再显示内部 runProfile（runtime_os 之类），改显示阶段状态。 */ }
            <strong>{phaseLabel(runtime.phase, zh)}</strong>
            <span>{statusLabel(runtime.status, zh)}</span>
          </div>
        ) : <p className="taskRuntimeEmpty">{zh ? '暂无任务事件' : 'No task events'}</p>}

        {taskSteps.length > 0 ? (
          <div className="taskRuntimeSection">
            <div className="taskRuntimeSectionTitle">
              <span>{zh ? '步骤' : 'Steps'}</span>
              <em>{taskSteps.filter((step) => step.status === 'completed').length}/{taskSteps.length}</em>
            </div>
            <div className="taskRuntimeStepList">
              {taskSteps.map((step) => (
                <div className={`taskRuntimeStep ${step.status}`} key={step.id}>
                  <span className="taskRuntimeStepMarker" aria-hidden="true" />
                  <strong>{step.title}</strong>
                  {step.detail ? <em>{step.detail}</em> : null}
                </div>
              ))}
            </div>
          </div>
        ) : null}

        {context ? (
          <div className="taskRuntimeSection">
            <div className="taskRuntimeSectionTitle">
              <span>{zh ? '上下文' : 'Context'}</span>
              <em>{context.usedTokens}/{context.usedTokens + context.remainingTokens}</em>
            </div>
            <div className="taskRuntimeChunkList">
              {context.chunks.slice(0, 5).map((chunk) => (
                <div className="taskRuntimeChunk" key={chunk.id}>
                  <span>{chunk.source}</span>
                  <strong>{chunk.summary || chunk.id}</strong>
                  <em>{chunk.tokens} tok · P{chunk.priority}{chunk.truncated ? (zh ? ' · 已裁切' : ' · trimmed') : ''}</em>
                </div>
              ))}
            </div>
          </div>
        ) : null}

        {cognition ? (
          <div className="taskRuntimeSection">
            <div className="taskRuntimeSectionTitle">
              <span>{zh ? '任务认知' : 'Task Cognition'}</span>
              <em>{Math.round(cognition.confidence * 100)}%</em>
            </div>
            {cognition.goal ? <p className="taskRuntimeGoal">{cognition.goal}</p> : null}
            <RuntimeList title={zh ? '事实' : 'Facts'} items={cognition.knownFacts} />
            <RuntimeList title={zh ? '风险' : 'Risks'} items={cognition.risks} />
            <RuntimeList title={zh ? '未知' : 'Unknowns'} items={cognition.unknowns} />
            <RuntimeList title={zh ? '验收' : 'Criteria'} items={cognition.verificationCriteria} />
          </div>
        ) : null}

        {loop ? (
          <div className="taskRuntimeLoop">
            <div>
              <span>{zh ? '续跑' : 'Loop'}</span>
              <strong>{loop.iteration}/{loop.maxIterations}</strong>
            </div>
            <div>
              <span>{zh ? '无进展' : 'No progress'}</span>
              <strong>{loop.noProgressCount}</strong>
            </div>
            {loop.continuationReason ? <p>{loop.continuationReason}</p> : null}
          </div>
        ) : null}

        {events.length > 0 ? (
          <div className="taskRuntimeSection">
            <div className="taskRuntimeSectionTitle">
              <span>{zh ? '事件流' : 'Event Flow'}</span>
              <em>{events.length}</em>
            </div>
            <div className="taskRuntimeEventList">
              {events.slice(0, 6).map((event, index) => (
                <div className="taskRuntimeEvent" key={`${event.type}-${event.timestamp}-${index}`}>
                  <span>{eventLabel(event)}</span>
                  <time>{formatEventTime(event.timestamp)}</time>
                </div>
              ))}
            </div>
          </div>
        ) : null}

        {recentItems.length > 0 ? (
          <div className="taskRuntimeSection">
            <div className="taskRuntimeSectionTitle">
              <span>{zh ? '执行项' : 'Activity'}</span>
              <em>{recentItems.length}</em>
            </div>
            <div className="taskRuntimeItemList">
              {recentItems.map((item) => (
                <div className="taskRuntimeItem" key={item.id}>
                  <span>{item.label}</span>
                  {item.detail ? <strong>{item.detail}</strong> : null}
                </div>
              ))}
            </div>
          </div>
        ) : null}
      </div>
    </section>
  );
}

function RuntimeList({ title, items }: { title: string; items: string[] }) {
  if (items.length === 0) return null;
  return (
    <div className="taskRuntimeList">
      <span>{title}</span>
      <ul>
        {items.slice(0, 3).map((item, index) => (
          <li key={`${title}-${index}`}>{item}</li>
        ))}
      </ul>
    </div>
  );
}

function phaseLabel(phase: NonNullable<TaskRuntimeMonitorState['runtime']>['phase'], zh: boolean): string {
  switch (phase) {
    case 'before_turn': return zh ? '回合准备' : 'Before turn';
    case 'model': return zh ? '模型调用' : 'Model';
    case 'tool': return zh ? '工具执行' : 'Tool';
    case 'compact': return zh ? '上下文压缩' : 'Compaction';
    case 'after_turn': return zh ? '回合收尾' : 'After turn';
    case 'idle': return zh ? '空闲' : 'Idle';
    default: return phase;
  }
}

function statusLabel(status: NonNullable<TaskRuntimeMonitorState['runtime']>['status'], zh: boolean): string {
  switch (status) {
    case 'running': return zh ? '运行中' : 'Running';
    case 'completed': return zh ? '已完成' : 'Completed';
    case 'failed': return zh ? '失败' : 'Failed';
    case 'interrupted': return zh ? '已中断' : 'Interrupted';
    default: return status;
  }
}

function eventLabel(event: TaskRuntimeMonitorState['events'][number]): string {
  switch (event.type) {
    case 'task.runtime.updated':
      return `runtime · ${event.phase} · ${event.status}`;
    case 'task.cognition.updated':
      return `cognition · ${Math.round(event.cognition.confidence * 100)}%`;
    case 'task.context.updated':
      return `context · ${event.usedTokens} tok`;
    case 'task.loop.updated':
      return `loop · ${event.status}`;
    default:
      return 'task';
  }
}

function formatEventTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

const operationalItemTypes = new Set([
  'tool_call',
  'collab_tool_call',
  'mcp_tool_call',
  'command_execution',
  'file_change',
  'context_compaction',
  'rollback_conflict',
  'project_checkpoint',
  'workflow_checkpoint',
  'error',
  'web_search',
]);

function summarizeItems(items: ThreadItem[], zh: boolean): Array<{ id: string; label: string; detail: string }> {
  return items
    .filter((item) => operationalItemTypes.has(item.type))
    .slice(-4)
    .reverse()
    .map((item) => {
      const label = itemLabel(item, zh);
      const detail = itemDetail(item, zh);
      return { id: item.id, label, detail: clip(detail, 72) };
    });
}

type TaskStepStatus = 'completed' | 'running' | 'pending' | 'blocked';

interface TaskStep {
  id: string;
  title: string;
  detail?: string;
  status: TaskStepStatus;
}

function buildTaskSteps({
  cognition,
  items,
  recentItems,
  runtime,
  zh,
}: {
  cognition: NonNullable<TaskRuntimeMonitorState['cognition']>['cognition'] | undefined;
  items: ThreadItem[];
  recentItems: Array<{ id: string; label: string; detail: string }>;
  runtime: TaskRuntimeMonitorState['runtime'];
  zh: boolean;
}): TaskStep[] {
  const latestTodo = [...items].reverse().find((item) => item.type === 'todo_list');
  const todoItems = latestTodo?.items ?? [];
  if (todoItems.length > 0) {
    let firstOpenSeen = false;
    return todoItems.slice(0, 6).map((todo, index) => {
      const status: TaskStepStatus = todo.completed
        ? 'completed'
        : (!firstOpenSeen && runtime?.status === 'running' ? 'running' : 'pending');
      if (!todo.completed) firstOpenSeen = true;
      return {
        id: `todo-${index}`,
        title: todo.text,
        status,
      };
    });
  }

  const steps: TaskStep[] = [];
  if (cognition?.goal) {
    steps.push({
      id: 'goal',
      title: zh ? '确认目标' : 'Confirm goal',
      detail: cognition.goal,
      status: 'completed',
    });
  }

  const criteria = cognition?.verificationCriteria ?? [];
  criteria.slice(0, 3).forEach((criterion, index) => {
    steps.push({
      id: `criterion-${index}`,
      title: criterion,
      detail: zh ? '验收项' : 'criterion',
      status: runtime?.status === 'completed' ? 'completed' : (index === 0 && runtime?.status === 'running' ? 'running' : 'pending'),
    });
  });

  if (recentItems.length > 0) {
    steps.push({
      id: 'evidence',
      title: zh ? '收集执行证据' : 'Collect execution evidence',
      detail: recentItems[0]?.label,
      status: 'completed',
    });
  } else if (runtime?.status === 'running') {
    steps.push({
      id: 'evidence',
      title: zh ? '收集执行证据' : 'Collect execution evidence',
      status: 'running',
    });
  }

  if (runtime) {
    steps.push({
      id: 'finish',
      title: zh ? '收尾并同步状态' : 'Finalize and sync state',
      detail: phaseLabel(runtime.phase, zh),
      status: runtime.status === 'completed' ? 'completed' : (runtime.phase === 'after_turn' ? 'running' : 'pending'),
    });
  }

  return steps.slice(0, 6);
}

function itemLabel(item: ThreadItem, zh: boolean): string {
  const status = item.status ? ` · ${item.status}` : '';
  switch (item.type) {
    case 'tool_call': return `${item.toolName || (zh ? '工具调用' : 'Tool call')}${status}`;
    case 'mcp_tool_call': return `${item.server || 'mcp'}:${item.tool || 'tool'}${status}`;
    case 'collab_tool_call': return `${item.tool || (zh ? '协作工具' : 'Collab tool')}${status}`;
    case 'command_execution': return `${zh ? '命令执行' : 'Command'}${status}`;
    case 'file_change': return `${zh ? '文件变更' : 'File changes'}${status}`;
    case 'context_compaction': return `${zh ? '上下文压缩' : 'Compaction'}${status}`;
    case 'rollback_conflict': return zh ? '回滚冲突' : 'Rollback conflict';
    case 'project_checkpoint': return zh ? '工程快照' : 'Project checkpoint';
    case 'workflow_checkpoint': return zh ? '工作流快照' : 'Workflow checkpoint';
    case 'error': return zh ? '错误' : 'Error';
    case 'web_search': return `${zh ? '网页搜索' : 'Web search'}${status}`;
    case 'todo_list': return zh ? '任务清单' : 'Todo list';
    default: return `${item.type}${status}`;
  }
}

function itemDetail(item: ThreadItem, zh: boolean): string {
  if (item.type === 'file_change') {
    const changes = item.changes ?? [];
    const firstPath = changes[0]?.path;
    const count = changes.length;
    if (firstPath) return count > 1 ? `${firstPath} +${count - 1}` : firstPath;
    return typeof item.summary === 'string' ? item.summary : '';
  }
  if (item.type === 'project_checkpoint') {
    const count = item.files?.length ?? 0;
    return count > 0 ? (zh ? `${count} 个文件` : `${count} files`) : '';
  }
  if (item.type === 'context_compaction') {
    const before = typeof item.tokensBefore === 'number' ? item.tokensBefore : null;
    const after = typeof item.tokensAfter === 'number' ? item.tokensAfter : null;
    if (before !== null && after !== null) return `${before} -> ${after} tok`;
    return typeof item.trigger === 'string' ? item.trigger : '';
  }
  if (item.type === 'rollback_conflict') {
    return typeof item.message === 'string' ? item.message : '';
  }
  return [
    typeof item.command === 'string' ? item.command : '',
    typeof item.toolName === 'string' ? item.toolName : '',
    typeof item.tool === 'string' ? item.tool : '',
    typeof item.message === 'string' ? item.message : '',
    item.error?.message ?? '',
  ].find(Boolean) ?? '';
}

function clip(value: string, max: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, max - 1)}…`;
}
