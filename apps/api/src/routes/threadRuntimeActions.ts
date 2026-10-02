import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AgentLoop } from '@suanlizi/runtime';
import type { RunControlAction, ThreadId } from '@suanlizi/protocol';
import { readJson, sendJson } from '../shared/http.js';
import type { RunControlHandlerRequest } from './runMonitorRoute.js';

export async function handleRollbackThreadRuntimeAction(options: {
  req: IncomingMessage;
  res: ServerResponse;
  threadId: ThreadId;
  createAgent: () => Promise<AgentLoop>;
}): Promise<void> {
  const body = await readJson<{ count?: number }>(options.req);
  const agent = await options.createAgent();
  const result = await agent.rollbackThread(options.threadId, body.count ?? 1);
  sendJson(options.res, 200, result);
}

// RunControlAction 处理器：interrupt/resume/rollback 三个分支
// — English: RunControlAction handler: interrupt/resume/rollback branches
// 注意：rollback 使用 checkpointId（协议层），但 runtime.rollbackThread 仍需 count。
// 在 runtime 支持 checkpointId 解析之前，rollback 默认 count=1。
// — English: rollback uses checkpointId (protocol layer), but runtime.rollbackThread still needs count.
// Until the runtime supports checkpointId resolution, rollback defaults to count=1.
export async function handleRunControlAction(
  action: RunControlAction,
  request: RunControlHandlerRequest,
  createAgent: () => Promise<AgentLoop>,
): Promise<unknown> {
  const agent = await createAgent();
  if (action === 'interrupt') return { interrupted: agent.interrupt(request.threadId) };
  if (action === 'resume') return await agent.resumeRunning(request.threadId);
  if (action === 'rollback') {
    // TODO: 将 checkpointId 解析为 count（需要 store 查询 checkpoint 位置）
    // — English: TODO: resolve checkpointId to count (requires store query for checkpoint position)
    return await agent.rollbackThread(request.threadId, 1);
  }
  return { ok: false, unsupported: action };
}
