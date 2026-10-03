/**
 * Task Runtime Monitor — 当前任务运行态投影视图的 state 容器。
 *
 * 接收的事件：
 *  - task.runtime.updated  (phase: before_turn / model / tool / compact / after_turn / idle)
 *  - task.cognition.updated (AgentContext.cognition.task 摘要)
 *  - task.context.updated   (本轮注入的 chunk metadata，不含 content)
 *  - task.loop.updated      (长运行 / continuation 状态，兼容 harness loop)
 *
 * 重要约束：
 *  - 不存完整 system prompt / chunk content
 *  - 普通 /turn 也会产生这些事件，但不代表进入 harness
 *  - 旧 harness.state.updated 是历史 API 事件名，不进入普通任务运行态面板
 */
import { useCallback, useState } from 'react';
import type {
  TaskRuntimeUpdatedEvent,
  TaskCognitionUpdatedEvent,
  TaskContextUpdatedEvent,
  TaskLoopUpdatedEvent,
} from '@suanlizi/protocol';

export type TaskRuntimeMonitorEvent =
  | TaskRuntimeUpdatedEvent
  | TaskCognitionUpdatedEvent
  | TaskContextUpdatedEvent
  | TaskLoopUpdatedEvent;

export interface TaskRuntimeMonitorState {
  runtime: TaskRuntimeUpdatedEvent | null;
  cognition: TaskCognitionUpdatedEvent | null;
  context: TaskContextUpdatedEvent | null;
  loop: TaskLoopUpdatedEvent | null;
  events: TaskRuntimeMonitorEvent[];
}

const EMPTY_STATE: TaskRuntimeMonitorState = {
  runtime: null,
  cognition: null,
  context: null,
  loop: null,
  events: [],
};

const TASK_RUNTIME_EVENT_TYPES = new Set<string>([
  'task.runtime.updated',
  'task.cognition.updated',
  'task.context.updated',
  'task.loop.updated',
]);

export function isTaskRuntimeEvent(event: { type?: unknown }): boolean {
  return typeof event.type === 'string' && TASK_RUNTIME_EVENT_TYPES.has(event.type);
}

export function useTaskRuntimeMonitor() {
  const [state, setState] = useState<TaskRuntimeMonitorState>(EMPTY_STATE);

  const applyEvent = useCallback((event: Record<string, unknown>) => {
    if (typeof event.type !== 'string') return;
    const monitorEvent = event as unknown as TaskRuntimeMonitorEvent;
    switch (event.type) {
      case 'task.runtime.updated':
        setState((prev) => ({ ...prev, runtime: monitorEvent as TaskRuntimeUpdatedEvent, events: prependEvent(prev.events, monitorEvent) }));
        break;
      case 'task.cognition.updated':
        setState((prev) => ({ ...prev, cognition: monitorEvent as TaskCognitionUpdatedEvent, events: prependEvent(prev.events, monitorEvent) }));
        break;
      case 'task.context.updated':
        setState((prev) => ({ ...prev, context: monitorEvent as TaskContextUpdatedEvent, events: prependEvent(prev.events, monitorEvent) }));
        break;
      case 'task.loop.updated':
        setState((prev) => ({ ...prev, loop: monitorEvent as TaskLoopUpdatedEvent, events: prependEvent(prev.events, monitorEvent) }));
        break;
      default:
        break;
    }
  }, []);

  const clear = useCallback(() => {
    setState(EMPTY_STATE);
  }, []);

  return { state, applyEvent, clear };
}

function prependEvent(events: TaskRuntimeMonitorEvent[], event: TaskRuntimeMonitorEvent): TaskRuntimeMonitorEvent[] {
  return [event, ...events].slice(0, 20);
}
