# Runtime Middleware 与第二批运行时边界

Suanlizi runtime 的扩展点以 `RuntimeMiddleware` 为核心，阶段顺序固定为：

```text
beforeTurn
beforeModel
wrapModel
afterModel
beforeTool
wrapTool
afterTool
afterTurn
```

`before*` 和 `after*` 按注册顺序执行；`wrapModel` / `wrapTool` 使用洋葱模型，先注册的 middleware 在外层，后注册的 middleware 更靠近真实模型或工具执行。

内置 middleware 先于用户传入的 `runtimeMiddleware` 运行。当前内置边界包括：

- Stability：重复工具调用、连续工具错误、web_search 预算、子 agent 数量限制。
- Tool governance：只读沙箱、exec policy、HITL 审批、禁用工具、per-tool turn rate limit。
- Dynamic Context：每次模型调用前注入短事实上下文。

## 延迟工具绑定

`AgentConfig.toolBindingMode` 默认为 `eager`，保持历史行为。设置为 `delayed` 后，首轮模型调用只暴露：

- `tool_search`
- `initialTools` 中显式列出的工具

模型调用 `tool_search` 后，runtime 会根据查询结果把匹配工具 schema 绑定到下一轮模型调用。未绑定工具即使被模型直接调用，也会记录为 failed `tool_call`，不会执行真实工具。

相关配置：

```ts
{
  toolBindingMode: 'delayed',
  initialTools: ['read_file'],
  maxToolSearchResults: 8
}
```

## 工具治理

`AgentConfig.toolGovernance` 提供第一版本地工具治理策略：

```ts
{
  toolGovernance: {
    blockedTools: ['shell_command'],
    forceApprovalTools: ['write_file'],
    rateLimits: {
      web_search: 4
    }
  }
}
```

审批链路已经从 `AgentLoop.executeToolCall` 抽到 middleware，`AgentLoop` 只负责解析请求、执行工具、落盘 item 和把 tool result 返回给模型。

## 轻记忆

`@suanlizi/memory` 导出轻记忆 API：

- `queueLightMemory`
- `flushLightMemoryQueue`
- `listLightMemories`
- `deleteLightMemory`
- `setLightMemoryEnabled`

轻记忆存放在 tenant-scoped settings，默认启用、本地优先、队列化、去抖，可查看、可删除、可禁用。它不做长期画像推断，只保存显式候选文本。

## 动态工作流 Runtime

`@suanlizi/runtime` 导出第一版动态工作流状态机：

- `createWorkflowRun`
- `runnableWorkflowSteps`
- `startWorkflowStep`
- `completeWorkflowStep`
- `blockWorkflowStep`
- `failWorkflowStep`
- `replanWorkflow`

它用于把“用户目标 -> 步骤 DAG/状态机 -> 执行 -> 阻塞/审批/重规划 -> 可恢复”固化为 runtime 数据结构。第一版不强绑定 AgentLoop，后续可以接入 middleware、审批和持久化恢复。
