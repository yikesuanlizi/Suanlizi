// 远程 A2A Agent 客户端：封装 @a2a-js/sdk 的 ClientFactory，
// 提供 checkHealth / sendTask / sendTaskStream 三个简化接口，
// 供 Suanlizi 的 spawn_remote_agent 协作工具调用。
//
// 设计要点：
// - 每次调用都按 agentUrl 重新创建 Client（createFromUrl 会自动拉取
//   /.well-known/agent-card.json 并协商传输协议）。
// - 同步走 sendMessage（阻塞模式），流式走 sendMessageStream。
// - 仅提取文本 part 与 artifact，其它类型（file/data）忽略。

import { ClientFactory } from '@a2a-js/sdk/client';
import type {
  Message,
  Task,
  TaskStatusUpdateEvent,
  TaskArtifactUpdateEvent,
  MessageSendParams,
  Part,
} from '@a2a-js/sdk';

/** 远程 Agent 调用结果（同步模式）。 */
export interface RemoteAgentResult {
  /** 远程任务 ID（仅当返回 Task 时存在）。 */
  taskId?: string;
  /** 任务终态：completed / failed / working。 */
  status: 'completed' | 'failed' | 'working';
  /** Agent 回复的文本（拼接所有文本 part）。 */
  text: string;
  /** 产物列表。 */
  artifacts: Array<{ name?: string; text: string }>;
  /** 失败时的错误信息。 */
  error?: string;
}

/** 流式事件：把 SDK 的 A2AStreamEventData 归一化成更窄的类型。 */
export interface RemoteAgentStreamEvent {
  type: 'status' | 'artifact' | 'message' | 'task' | 'done' | 'error';
  data?: Message | Task | TaskStatusUpdateEvent | TaskArtifactUpdateEvent;
  error?: string;
}

export class RemoteAgentClient {
  private factory: ClientFactory;

  constructor() {
    this.factory = new ClientFactory();
  }

  /** 检查远程 Agent 是否可用，并返回其 card 中的 name。 */
  async checkHealth(url: string): Promise<{ ok: boolean; name?: string; error?: string }> {
    try {
      const client = await this.factory.createFromUrl(url);
      const card = await client.getAgentCard();
      return { ok: true, name: card.name };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  /** 发送任务到远程 Agent（阻塞等待结果）。 */
  async sendTask(agentUrl: string, task: string, context?: string): Promise<RemoteAgentResult> {
    const client = await this.factory.createFromUrl(agentUrl);

    const params: MessageSendParams = {
      message: {
        messageId: crypto.randomUUID(),
        role: 'user',
        parts: [{ kind: 'text', text: context ? `${task}\n\n上下文：${context}` : task }],
        kind: 'message',
      },
    };

    const response = await client.sendMessage(params);

    if (response.kind === 'message') {
      const message = response as Message;
      const text = extractTextFromParts(message.parts).join('\n');
      return { status: 'completed', text, artifacts: [] };
    }

    const taskObj = response as Task;
    const text =
      (taskObj.history ?? [])
        .filter((m) => m.role === 'agent')
        .flatMap((m) => extractTextFromParts(m.parts))
        .join('\n') || '';
    const artifacts = (taskObj.artifacts ?? []).map((a) => ({
      name: a.name,
      text: extractTextFromParts(a.parts).join('\n'),
    }));
    const state = taskObj.status?.state;
    const status: RemoteAgentResult['status'] =
      state === 'completed'
        ? 'completed'
        : state === 'failed' || state === 'rejected' || state === 'canceled'
          ? 'failed'
          : 'working';
    return {
      taskId: taskObj.id,
      status,
      text,
      artifacts,
    };
  }

  /** 流式发送任务到远程 Agent。 */
  async *sendTaskStream(
    agentUrl: string,
    task: string,
    context?: string,
  ): AsyncGenerator<RemoteAgentStreamEvent> {
    // 阶段 1：建立连接（拉取 AgentCard + 发起 SSE 请求）
    // 此阶段失败会直接 throw，调用方可据此回退到阻塞模式
    // — Chinese: phase 1: establish connection. Failure throws so caller can fall back.
    const client = await this.factory.createFromUrl(agentUrl);

    const params: MessageSendParams = {
      message: {
        messageId: crypto.randomUUID(),
        role: 'user',
        parts: [{ kind: 'text', text: context ? `${task}\n\n上下文：${context}` : task }],
        kind: 'message',
      },
    };

    // 阶段 2：迭代 SSE 事件流
    // 此阶段失败（网络中断、远程 Agent 抛错等）以 error 事件 yield，
    // 让调用方保留已收到的部分结果而非全部丢弃
    // — Chinese: phase 2: iterate SSE events. Mid-stream errors yield as error event
    // so caller can keep partial results.
    const stream = client.sendMessageStream(params);
    try {
      for await (const event of stream) {
        if (event.kind === 'status-update') {
          yield { type: 'status', data: event as TaskStatusUpdateEvent };
          if ((event as TaskStatusUpdateEvent).final) {
            yield { type: 'done' };
            return;
          }
        } else if (event.kind === 'artifact-update') {
          yield { type: 'artifact', data: event as TaskArtifactUpdateEvent };
        } else if (event.kind === 'message') {
          yield { type: 'message', data: event as Message };
        } else if (event.kind === 'task') {
          yield { type: 'task', data: event as Task };
        }
      }
    } catch (streamError) {
      // 流中断 — 以 error 事件通知调用方，保留已收集的部分结果
      // — Chinese: stream interrupted — yield error event, preserve partial results
      yield {
        type: 'error',
        error: streamError instanceof Error ? streamError.message : String(streamError),
      };
      return;
    }
    yield { type: 'done' };
  }
}

/** 从 Part[] 中提取所有文本 part 的内容并拼接。 */
function extractTextFromParts(parts: Part[]): string[] {
  return parts.filter((p): p is Extract<Part, { kind: 'text' }> => p.kind === 'text').map((p) => p.text);
}
