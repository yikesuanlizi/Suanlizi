// spawn_remote_agent 工具定义：让 Suanlizi Agent 把任务委派给外部 A2A Agent。
//
// 这是一个协作工具（collab tool），实际的 execute 不会被执行 ——
// AgentLoop 在分发工具调用时会先经过 isCollabTool 判断，
// 命中后走 runCollabTool 分支（见 agent.ts 的 spawnRemoteAgent），
// 因此这里的 execute 只是占位，调用时直接抛错以暴露误用。

import type { ToolDefinition } from '@suanlizi/tools';

export const REMOTE_AGENT_TOOL: ToolDefinition = {
  name: 'spawn_remote_agent',
  description:
    '委派任务到外部 A2A Agent（跨框架协作）。当需要其他专业 Agent 协助、或目标 Agent 不在本地 Suanlizi 实例内时使用。' +
    '调用后会通过 HTTP 拉取远程 Agent 的 agent-card 并阻塞等待其返回结果。',
  parameters: {
    type: 'object',
    properties: {
      agentUrl: {
        type: 'string',
        description: '远程 A2A Agent 的 URL（如 https://other-agent.com），会自动拼接 /.well-known/agent-card.json',
      },
      task: {
        type: 'string',
        description: '要委派给远程 Agent 的任务描述',
      },
      context: {
        type: 'string',
        description: '可选的上下文信息，帮助远程 Agent 理解任务背景',
      },
    },
    required: ['agentUrl', 'task'],
    additionalProperties: false,
  },
  // 仅发起 HTTP 调用，不涉及本地文件写入/命令执行，故 readonly 即可
  requiredPolicy: 'readonly',
  requiresApproval: false,
  supportsParallelToolCalls: false,
  execute: async () => {
    throw new Error('spawn_remote_agent must be called through collab tool dispatcher');
  },
};
