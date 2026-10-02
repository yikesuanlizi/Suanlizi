// A2A AgentExecutor 适配层：将 A2A 请求转换为 Suanlizi AgentLoop.runTurn 调用并实时发布事件
// 英文说明：A2A AgentExecutor adapter — converts A2A requests into Suanlizi AgentLoop.runTurn calls
//           and translates Suanlizi ThreadEvents into A2A AgentExecutionEvents in real time (true streaming).

import type { AgentExecutor, ExecutionEventBus, RequestContext } from '@a2a-js/sdk/server';
import type { Artifact, Message, Part, TextPart } from '@a2a-js/sdk';
import type { ThreadEvent, ThreadItem, ThreadId } from '../types.js';

/**
 * AgentRuntimePort — Suanlizi AgentLoop 中 A2A 所需能力的最小抽象。
 *
 * 在 @suanlizi/protocol 中定义该端口而非直接 import @suanlizi/runtime，
 * 以避免 protocol → runtime 的循环依赖（runtime 依赖 protocol）。
 *
 * 英文说明：Minimal port abstraction over AgentLoop to avoid protocol → runtime cycle.
 */
// — Chinese: AgentRuntimePort abstracts AgentLoop capabilities needed by A2A.
export interface AgentRuntimePort {
  /** 运行一个回合；返回新增的 ThreadItem[]（含 user_message / agent_message 等）。 */
  runTurn(
    threadId: ThreadId,
    input: { type: 'text'; text: string },
    signal?: AbortSignal,
  ): Promise<{ items: ThreadItem[] }>;
  /** 中断指定线程当前正在运行的回合。 */
  interrupt(threadId: ThreadId): boolean;
  /**
   * 注册事件监听器，接收 turn.started / turn.completed / item.completed / agent_message.delta 等事件。
   * 返回 unsubscribe 函数，调用后移除监听器。
   */
  // — Chinese: register event listener; returns unsubscribe function.
  onEvent(listener: (event: ThreadEvent) => void): () => void;
}

/**
 * SuanliziAgentExecutor 构造参数。
 * agentFactory 应根据 threadId 返回（或创建）对应的 AgentRuntimePort 实例。
 */
// — Chinese: SuanliziAgentExecutor options. agentFactory returns the runtime per thread.
export interface SuanliziAgentExecutorOptions {
  agentFactory: (threadId: string) => Promise<AgentRuntimePort>;
}

/** 运行中的任务追踪条目，cancel 时用于中断。 */
interface RunningTask {
  agent: AgentRuntimePort;
  abortController: AbortController;
  unsubscribe: () => void;
}

/** 从 A2A Message 的 parts 中提取纯文本。 */
// — Chinese: extract plain text from A2A Message parts
function extractTextFromParts(parts: Part[]): string {
  const texts: string[] = [];
  for (const part of parts) {
    if (part.kind === 'text') {
      texts.push((part as TextPart).text);
    }
  }
  return texts.join('\n');
}

/** 生成唯一 ID（用于 messageId / artifactId）。 */
// — Chinese: generate unique ID for messageId / artifactId
function genId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/** 从 ThreadItem 提取摘要文本用于 artifact description。 */
// — Chinese: extract summary text from ThreadItem for artifact description
function summarizeItem(item: ThreadItem): string {
  switch (item.type) {
    case 'tool_call':
      return `tool_call: ${item.toolName ?? 'unknown'}`;
    case 'command_execution':
      return `command: ${item.command ?? ''}`.slice(0, 200);
    case 'file_change':
      return `file_change: ${item.summary ?? `${item.changes?.length ?? 0} files`}`;
    case 'mcp_tool_call':
      return `mcp: ${item.server ?? ''}/${item.tool ?? ''}`;
    case 'collab_tool_call':
      return `collab: ${item.tool ?? ''}`;
    case 'web_search':
      return `web_search: ${item.query ?? ''}`;
    case 'reasoning':
      return 'reasoning';
    case 'error':
      return `error: ${item.message ?? ''}`.slice(0, 200);
    default:
      return item.type;
  }
}

/** 从 ThreadItem 提取可序列化为 TextPart 的内容。 */
// — Chinese: extract serializable text content from ThreadItem
function itemToTextPart(item: ThreadItem): TextPart {
  let text = '';
  switch (item.type) {
    case 'tool_call':
      text = JSON.stringify(item.arguments ?? {}, null, 2);
      break;
    case 'command_execution':
      text = item.command ?? '';
      break;
    case 'file_change':
      // FileChangeItem 没有 diff 字段，用 summary + changes 列表
      // — Chinese: FileChangeItem has no diff field; use summary + changes list
      text = item.summary ?? JSON.stringify(item.changes ?? [], null, 2);
      break;
    case 'mcp_tool_call':
      text = JSON.stringify(item.arguments ?? {}, null, 2);
      break;
    case 'collab_tool_call':
      text = item.prompt ?? '';
      break;
    case 'web_search':
      text = item.query ?? '';
      break;
    case 'reasoning':
      text = item.text ?? '';
      break;
    case 'error':
      text = item.message ?? '';
      break;
    default:
      text = JSON.stringify(item, null, 2);
  }
  return { kind: 'text', text };
}

/**
 * SuanliziAgentExecutor — 实现 @a2a-js/sdk 的 AgentExecutor 接口。
 *
 * 真流式工作流程：
 * 1. 从 requestContext.userMessage.parts 提取文本
 * 2. 发布 working 状态到 eventBus
 * 3. 注册 agent.onEvent 监听器，实时把 Suanlizi ThreadEvent 翻译成 A2A 事件：
 *    - turn.started          → status-update(working, final=false)
 *    - agent_message.delta   → 节流后 status-update(working, final=false, message=累积文本)
 *    - item.completed(agent_message) → message 事件
 *    - item.completed(其他)   → artifact-update 事件
 *    - approval.required     → status-update(input-required, final=false, message=询问)
 *    - turn.completed        → status-update(completed, final=true)
 *    - turn.failed           → status-update(failed, final=true, message=错误)
 * 4. 调用 AgentLoop.runTurn(threadId, text) 阻塞等待
 * 5. 取消注册监听器，调用 eventBus.finished()
 *
 * 失败时发布 failed 状态；cancelTask 时中断对应线程并发布 canceled 状态。
 *
 * 注意：ResultManager 会自动消费事件并调用 taskStore.save，本执行器只负责发布事件。
 */
// — Chinese: SuanliziAgentExecutor implements SDK AgentExecutor with TRUE streaming.
// Subscribes to AgentLoop events and forwards them in real time to A2A eventBus.
export class SuanliziAgentExecutor implements AgentExecutor {
  private readonly runningTasks = new Map<string, RunningTask>();

  constructor(private readonly options: SuanliziAgentExecutorOptions) {}

  execute = async (requestContext: RequestContext, eventBus: ExecutionEventBus): Promise<void> => {
    const { userMessage, taskId, contextId } = requestContext;
    const text = extractTextFromParts(userMessage.parts);
    const startedAt = new Date().toISOString();

    // 1. 发布初始 working 状态（非 final）
    eventBus.publish({
      kind: 'status-update',
      taskId,
      contextId,
      status: { state: 'working', timestamp: startedAt },
      final: false,
    });

    const agent = await this.options.agentFactory(taskId);
    const abortController = new AbortController();

    // 2. delta 节流状态：累积 agent_message.delta 文本，定时 flush 为 status-update
    // — Chinese: delta throttle state: accumulate agent_message.delta text, flush periodically
    let deltaBuffer = '';
    let deltaItemId: string | null = null;
    let deltaFlushTimer: ReturnType<typeof setTimeout> | null = null;
    const DELTA_FLUSH_MS = 50;

    const flushDelta = (): void => {
      if (deltaFlushTimer) {
        clearTimeout(deltaFlushTimer);
        deltaFlushTimer = null;
      }
      if (!deltaBuffer) return;
      const message: Message = {
        kind: 'message',
        messageId: genId('delta'),
        role: 'agent',
        taskId,
        contextId,
        parts: [{ kind: 'text', text: deltaBuffer }],
      };
      // 通过 status-update.message 携带中间文本，避免触发 ResultManager 把中间消息当 final
      // — Chinese: send intermediate text via status-update.message (NOT message event)
      //            to avoid ResultManager treating it as final
      eventBus.publish({
        kind: 'status-update',
        taskId,
        contextId,
        status: {
          state: 'working',
          message,
          timestamp: new Date().toISOString(),
        },
        final: false,
      });
      deltaBuffer = '';
      deltaItemId = null;
    };

    // 3. 事件监听器：把 Suanlizi ThreadEvent 实时翻译为 A2A 事件
    // — Chinese: event listener: translate Suanlizi ThreadEvent to A2A events in real time
    const listener = (event: ThreadEvent): void => {
      switch (event.type) {
        case 'turn.started': {
          eventBus.publish({
            kind: 'status-update',
            taskId,
            contextId,
            status: { state: 'working', timestamp: new Date().toISOString() },
            final: false,
          });
          break;
        }

        case 'agent_message.delta': {
          // 同一个 itemId 的 delta 累积；切换 itemId 时先 flush 旧的
          // — Chinese: accumulate deltas for the same itemId; flush on itemId switch
          if (deltaItemId !== null && deltaItemId !== event.itemId) {
            flushDelta();
          }
          deltaItemId = event.itemId;
          deltaBuffer += event.delta;
          // 节流：50ms 后 flush；如果已有定时器则复用
          // — Chinese: throttle: flush after 50ms; reuse existing timer
          if (!deltaFlushTimer) {
            deltaFlushTimer = setTimeout(flushDelta, DELTA_FLUSH_MS);
          }
          break;
        }

        case 'item.completed': {
          // 先 flush 累积的 delta（如果有）
          // — Chinese: flush pending delta first
          if (deltaFlushTimer) {
            clearTimeout(deltaFlushTimer);
            deltaFlushTimer = null;
          }
          if (deltaBuffer) {
            // 注意：item.completed 已包含完整文本，不需要单独 flush delta
            // 直接清空 buffer，由 item.completed 处理
            // — Chinese: item.completed carries full text; clear delta buffer
            deltaBuffer = '';
            deltaItemId = null;
          }

          const item = event.item;
          if (item.type === 'agent_message') {
            // agent_message 完整消息 → message 事件（ResultManager 会作为 finalMessageResult）
            // — Chinese: agent_message complete → message event (ResultManager treats as finalMessageResult)
            const agentItem = item as { id: string; type: 'agent_message'; text: string; timestamp?: string };
            const message: Message = {
              kind: 'message',
              messageId: agentItem.id,
              role: 'agent',
              taskId,
              contextId,
              parts: [{ kind: 'text', text: agentItem.text }],
            };
            eventBus.publish(message);
          } else {
            // 其他条目（tool_call / command / file_change / mcp_tool_call / collab_tool_call / web_search 等）
            // 作为 artifact-update 发布，让客户端看到中间步骤
            // — Chinese: other items → artifact-update event so client sees intermediate steps
            const artifact: Artifact = {
              artifactId: item.id ?? genId('artifact'),
              name: item.type,
              description: summarizeItem(item),
              parts: [itemToTextPart(item)],
            };
            eventBus.publish({
              kind: 'artifact-update',
              taskId,
              contextId,
              artifact,
              lastChunk: true,
            });
          }
          break;
        }

        case 'approval.required': {
          // 等待审批 → input-required 状态（非 final，客户端可响应后继续）
          // — Chinese: approval required → input-required state (non-final)
          const approvalText = `${event.description ?? 'Approval required'}${event.justification ? ` (${event.justification})` : ''}`;
          eventBus.publish({
            kind: 'status-update',
            taskId,
            contextId,
            status: {
              state: 'input-required',
              message: {
                kind: 'message',
                messageId: genId('approval'),
                role: 'agent',
                taskId,
                contextId,
                parts: [{ kind: 'text', text: approvalText }],
              },
              timestamp: new Date().toISOString(),
            },
            final: false,
          });
          break;
        }

        case 'turn.completed': {
          // flush 残留的 delta
          if (deltaFlushTimer) {
            clearTimeout(deltaFlushTimer);
            deltaFlushTimer = null;
          }
          // turn 已完成 → 发布 completed 终结状态（final: true）
          // — Chinese: turn completed → publish completed terminal status (final: true)
          eventBus.publish({
            kind: 'status-update',
            taskId,
            contextId,
            status: { state: 'completed', timestamp: new Date().toISOString() },
            final: true,
          });
          break;
        }

        case 'turn.failed': {
          if (deltaFlushTimer) {
            clearTimeout(deltaFlushTimer);
            deltaFlushTimer = null;
          }
          // turn 失败 → 发布 failed 终结状态（携带错误消息）
          // — Chinese: turn failed → publish failed terminal status with error message
          const errMsg = event.error?.message ?? 'Turn failed';
          eventBus.publish({
            kind: 'status-update',
            taskId,
            contextId,
            status: {
              state: 'failed',
              message: {
                kind: 'message',
                messageId: genId('err'),
                role: 'agent',
                taskId,
                contextId,
                parts: [{ kind: 'text', text: errMsg }],
              },
              timestamp: new Date().toISOString(),
            },
            final: true,
          });
          break;
        }

        case 'stream.error': {
          if (deltaFlushTimer) {
            clearTimeout(deltaFlushTimer);
            deltaFlushTimer = null;
          }
          // 不可恢复的 stream error → 发布 failed 终结状态
          // — Chinese: unrecoverable stream error → publish failed terminal status
          if (!event.recoverable) {
            eventBus.publish({
              kind: 'status-update',
              taskId,
              contextId,
              status: {
                state: 'failed',
                message: {
                  kind: 'message',
                  messageId: genId('serr'),
                  role: 'agent',
                  taskId,
                  contextId,
                  parts: [{ kind: 'text', text: event.message ?? 'Stream error' }],
                },
                timestamp: new Date().toISOString(),
              },
              final: true,
            });
          }
          break;
        }

        // 其他事件类型（warning / token_usage / diff_updated / compacted 等）不影响 A2A 流
        // — Chinese: other event types do not affect A2A stream
        default:
          break;
      }
    };

    const unsubscribe = agent.onEvent(listener);
    this.runningTasks.set(taskId, { agent, abortController, unsubscribe });

    try {
      // 4. 阻塞等待 runTurn 完成；事件已在 listener 中实时转发
      // — Chinese: block on runTurn; events already forwarded in real time via listener
      await agent.runTurn(taskId, { type: 'text', text }, abortController.signal);

      // 5. 兜底：如果 runTurn 完成但未触发 turn.completed 事件，补发 completed
      // — Chinese: fallback: if runTurn completed without turn.completed event, send completed
      flushDelta();
      // 注意：如果 listener 已发布过 completed，这里再发一次 final:true 也没问题（幂等）
      eventBus.publish({
        kind: 'status-update',
        taskId,
        contextId,
        status: { state: 'completed', timestamp: new Date().toISOString() },
        final: true,
      });
    } catch (error) {
      // 异常路径：发布 failed 终结状态
      // — Chinese: exception path: publish failed terminal status
      if (deltaFlushTimer) {
        clearTimeout(deltaFlushTimer);
        deltaFlushTimer = null;
      }
      const errorMessage = error instanceof Error ? error.message : String(error);
      eventBus.publish({
        kind: 'status-update',
        taskId,
        contextId,
        status: {
          state: 'failed',
          message: {
            kind: 'message',
            messageId: genId('err'),
            role: 'agent',
            taskId,
            contextId,
            parts: [{ kind: 'text', text: errorMessage }],
          },
          timestamp: new Date().toISOString(),
        },
        final: true,
      });
    } finally {
      // 6. 注销监听器，清理资源
      // — Chinese: unsubscribe listener and clean up
      if (deltaFlushTimer) {
        clearTimeout(deltaFlushTimer);
        deltaFlushTimer = null;
      }
      unsubscribe();
      this.runningTasks.delete(taskId);
      // 通知 eventBus 执行结束
      eventBus.finished();
    }
  };

  cancelTask = async (taskId: string, eventBus: ExecutionEventBus): Promise<void> => {
    const running = this.runningTasks.get(taskId);
    if (running) {
      // 中断正在运行的 turn（通过 AbortSignal 和 AgentLoop.interrupt 双通道）
      running.abortController.abort();
      running.agent.interrupt(taskId);
      running.unsubscribe();
      this.runningTasks.delete(taskId);
    }

    // 发布 canceled 状态（final: true）
    eventBus.publish({
      kind: 'status-update',
      taskId,
      contextId: taskId,
      status: { state: 'canceled', timestamp: new Date().toISOString() },
      final: true,
    });
    eventBus.finished();
  };
}
