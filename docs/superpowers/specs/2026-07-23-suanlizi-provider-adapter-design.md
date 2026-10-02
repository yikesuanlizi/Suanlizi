# Suanlizi 模型 Provider Adapter 设计

日期：2026-07-23

## 目标

第一阶段把 Suanlizi 的模型接入从“两个兼容协议分支”升级为“Provider Profile + Transport Adapter + Provider History Replay”三层结构，先覆盖 MiniMax-M3、DeepSeek、OpenAI、Anthropic 四条一等路径。

这次不改设置页内容配置，不扩大到所有供应商。其它供应商继续走通用 OpenAI-compatible 或 Anthropic-compatible 路径，后续按同一接口追加 profile。

## 当前问题

Suanlizi 当前模型网关只有 `openai | anthropic` 两个协议判断：

- `packages/model-gateway/src/providers.ts`：provider 只声明 `protocol`
- `packages/model-gateway/src/gateway.ts`：统一入口按 `protocol` 分到 OpenAI Chat Completions 或 Anthropic Messages 转换
- `packages/runtime/src/agent.ts`：历史回放由 `itemToMessage()` 把业务 item 压成普通聊天消息

这导致三个正确性问题：

1. 工具历史被写成普通 assistant 文本，例如 `[Tool read_file completed]...`。这不是任何官方工具协议，MiniMax-M3 等模型会模仿它，再被 `leaksToolProtocol()` 判定为工具协议泄漏。
2. 持久化的 `tool_call` item 没有保存模型返回的 `tool_call.id`，无法在后续请求里准确构造 `assistant.tool_calls -> tool` 或 `assistant.tool_use -> user.tool_result`。
3. 推理字段被压扁或丢失。MiniMax 的 `reasoning_details`、DeepSeek 的 `reasoning_content`、Anthropic 的 `thinking/redacted_thinking` 块、OpenAI Responses 的 response item 都不能靠纯文本历史安全回放。

## 参考实现结论

本地参考项目给出的方向一致：

- DeerFlow 对 MiniMax、DeepSeek、vLLM 做 patch，核心是保存 provider 私有 reasoning 字段，并在后续请求中回放。
- DeepSeek-GUI/Kun 把 endpoint format 提升为配置：`chat_completions / responses / messages / custom_endpoint`，而不是只区分 OpenAI/Anthropic。
- Hermes 用 `ProviderProfile` 集中描述供应商差异，用 transport 负责消息转换和响应归一化，主 agent loop 不直接堆 provider 特判。

官方文档也支持这个判断：

- MiniMax-M3 的工具调用和交错思考要求保留完整历史；Anthropic 形态保留 `response.content`，OpenAI 形态保留含 `tool_calls/reasoning_details` 的完整 assistant message。
- DeepSeek 官方是 OpenAI-compatible，但有自己的 `thinking`、`reasoning_effort`、`reasoning_content` 和 prompt cache 字段。
- Anthropic Messages 要求 `tool_use/tool_result` 块配对，thinking 块在工具使用场景下必须按原顺序保留。
- OpenAI 官方工具调用要求保存结构化 tool call / tool output；Responses API 使用 `function_call` 与 `function_call_output` item，而不是普通文本占位符。

## 方案选择

### 方案 A：继续在当前 `openai | anthropic` 分支里打补丁

优点是改动小。缺点是每接一个 provider 都会继续污染 `gateway.ts` 和 `agent.ts`，MiniMax、DeepSeek、OpenAI Responses、Anthropic thinking 的历史回放规则会互相挤在一起。

不采用。

### 方案 B：引入 Provider Profile + Transport Adapter

每个已知 provider 声明自己的 endpoint、工具历史格式、推理字段、缓存统计和请求参数规则。运行时仍然只消费统一的归一化结果，但历史回放由 adapter 生成 provider wire messages。

采用。

### 方案 C：直接全面迁移到第三方 SDK

OpenAI/Anthropic 可以用官方 SDK，MiniMax 可用 Anthropic SDK 或 OpenAI SDK base URL，DeepSeek 可用 OpenAI SDK。但如果 SDK 直接侵入 agent loop，会让工具执行、监控、重试、测试变复杂。

暂不采用为第一阶段主方案。SDK 可作为 transport 内部实现细节，不能越过 adapter 边界。

## SDK 使用原则

实现 transport 时按“官方 SDK 优先，官方 API 其次，兼容协议兜底”执行：

- OpenAI 官方 provider：使用官方 OpenAI SDK 封装 Responses / Chat Completions；如果现有测试或运行环境不适合立即引入 SDK，则 transport 接口保持 SDK 等价参数，内部短期可用 fetch，不能把 OpenAI 专用参数散落到 runtime。
- Anthropic 官方 provider：使用官方 Anthropic SDK 封装 Messages；thinking/tool_use/tool_result 的内容块必须由 Anthropic transport 持有。
- MiniMax-M3：官方文档推荐 Anthropic SDK/OpenAI SDK 兼容调用。第一阶段默认走 Anthropic-compatible Messages，transport 可复用 Anthropic SDK 的 `baseURL` 能力；MiniMax profile 负责 base URL、thinking 和 reasoning split 规则。
- DeepSeek：官方是 OpenAI-compatible API。第一阶段使用 OpenAI Chat Completions wire shape，transport 可用 OpenAI SDK 的 `baseURL` 能力；DeepSeek profile 负责 `thinking/reasoning_effort/reasoning_content/cache` 私有规则。
- 通用 OpenAI-compatible：继续保留 fetch 或 OpenAI SDK `baseURL` 兜底，不能套用某个具体 provider 的私有字段。

SDK 只能存在于 transport 内部。runtime、settings、monitor 不直接依赖具体 SDK 类型。

## 新架构

### 1. Provider Profile

新增 profile 注册表，替代单一 `protocol` 判断。每个 profile 至少声明：

- `id`
- `displayName`
- `endpointFormat`: `chat_completions | responses | anthropic_messages | custom_endpoint`
- `baseUrl`
- `apiKeyEnvVars`
- `toolHistoryMode`: `openai_chat | openai_responses | anthropic_blocks`
- `reasoningMode`: `none | deepseek_reasoning_content | minimax_reasoning_details | anthropic_thinking | openai_responses_items`
- `cacheMode`: `none | deepseek_native | openai_prompt_details | anthropic_cache_control | minimax_anthropic`
- `buildRequestExtras(config)`: 输出 provider 专用 body/header 参数
- `normalizeResponse(raw)`: 输出统一模型结果，同时保留 provider data

第一阶段 profile：

| Provider | endpointFormat | 推荐路径 | 关键行为 |
| --- | --- | --- | --- |
| MiniMax-M3 | `anthropic_messages` | `https://api.minimaxi.com/anthropic` 或用户配置的 MiniMax Anthropic endpoint | 保留 content blocks；开启/关闭 thinking 使用 MiniMax/Anthropic 规则；禁止 `[Tool ...]` 文本回放 |
| DeepSeek | `chat_completions` | `https://api.deepseek.com/v1` | 回放 `reasoning_content`；支持 `thinking` 和 `reasoning_effort`；解析 `prompt_cache_hit_tokens/miss_tokens` |
| OpenAI | `responses` 优先，必要时 `chat_completions` | `https://api.openai.com/v1` | Responses 保存 response items；Chat Completions 保存 assistant tool_calls/tool messages |
| Anthropic | `anthropic_messages` | `https://api.anthropic.com/v1` | 保留 thinking/redacted_thinking/tool_use 顺序；工具结果按 tool_result blocks 回放 |

通用 provider：

- `openai_compatible` 继续使用 `chat_completions`
- `anthropic_compatible` 后续可独立加，不在第一阶段扩大 UI

### 2. Transport Adapter

`ModelGateway` 不再直接包含所有转换逻辑。它改为：

1. 解析 `ProviderProfile`
2. 选择 `TransportAdapter`
3. 调用 adapter 构造请求
4. adapter 解析流式/非流式响应
5. 返回统一 `ModelStreamEvent` / `ChatCompletionResponse`，并附带 `providerData`

Transport 类型：

- `OpenAiChatCompletionsTransport`
- `OpenAiResponsesTransport`
- `AnthropicMessagesTransport`

MiniMax-M3 第一阶段使用 `AnthropicMessagesTransport`，但 profile 负责 MiniMax 特有参数和响应字段。DeepSeek 使用 `OpenAiChatCompletionsTransport`，但 profile 负责 DeepSeek 特有字段。

### 3. Provider History Replay

新增 `ProviderHistoryBuilder`，替代 `itemToMessage()` 对模型历史的直接构造。

输入：

- `ThreadItem[]`
- 当前 `ProviderProfile`
- 当前模型配置

输出：

- provider wire messages
- 可用于监控的 `historyDiagnostics`

规则：

1. 用户消息仍然转为 user。
2. 最终 assistant 文本转为 assistant text。
3. 工具调用不再转为 `[Tool ...]` 文本。
4. 同一模型工具批次回放为结构化格式：
   - OpenAI Chat Completions：`assistant.tool_calls` 后接 `tool` 消息
   - OpenAI Responses：`function_call` 后接 `function_call_output`
   - Anthropic/MiniMax：`assistant.content[]` 中的 `tool_use` 后接 user `tool_result`
5. 推理字段作为 provider data 回放：
   - DeepSeek：assistant message 的 `reasoning_content`
   - MiniMax OpenAI 兼容路径：assistant message 的 `reasoning_details`
   - MiniMax/Anthropic Messages：assistant content blocks 中的 `thinking` / `tool_use` 原序列
   - OpenAI Responses：response item 序列

### 4. 持久化字段补充

为了不再依赖文本占位符，需要在协议层补充字段：

#### `AgentMessageItem`

新增可选字段：

- `providerFrame?: ProviderAssistantFrame`

用于保存这个 assistant 响应的 provider 原始结构或可安全回放结构。

#### `ReasoningItem`

新增可选字段：

- `providerFrameRef?: string`

用于关联某次 assistant frame 的 reasoning，而不是把 reasoning 文本回灌给模型。

#### `ToolCallItem / McpToolCallItem / CollabToolCallItem`

新增可选字段：

- `modelToolCallId?: string`
- `modelToolName?: string`
- `providerToolCall?: ProviderToolCallFrame`

其中 `modelToolCallId` 保存模型返回的 call id。后续历史回放必须使用这个 id 构造 tool result，不能使用 Suanlizi 自己的 item id 替代。

#### `ProviderAssistantFrame`

建议结构：

```ts
type ProviderAssistantFrame =
  | {
      format: 'openai_chat';
      content: string | null;
      toolCalls?: ToolCall[];
      reasoningContent?: string;
      reasoningDetails?: unknown[];
    }
  | {
      format: 'openai_responses';
      outputItems: unknown[];
    }
  | {
      format: 'anthropic_messages';
      contentBlocks: unknown[];
    };
```

### 5. MiniMax-M3 适配

默认一等路径使用 Anthropic Messages：

- base URL 默认 `https://api.minimaxi.com/anthropic`
- wire path 由 transport 补 `/v1/messages`
- 工具定义转换为 Anthropic `tools[].input_schema`
- tool call 保存为 `tool_use`
- tool result 保存为 `tool_result`
- thinking 配置按 profile 输出，第一阶段只支持 `auto/off`
- 不把 `[Tool ...]`、`<|tool_calls|>`、DSML 任何文本写进模型历史

如果用户配置 MiniMax OpenAI-compatible endpoint，profile 可降级到 `chat_completions`：

- 发送 `extra_body.reasoning_split = true`
- 支持 `thinking: { type: 'adaptive' | 'disabled' }`
- 回放 `reasoning_details`

第一阶段优先实现 Anthropic 路径，OpenAI-compatible MiniMax 路径只保留 profile 结构，不默认启用。

### 6. DeepSeek 适配

DeepSeek 使用 OpenAI Chat Completions wire shape，但作为一等 profile：

- base URL 默认 `https://api.deepseek.com/v1`
- `deepseek-v4-*`、`deepseek-reasoner` 认为支持 thinking
- reasoning 开启时发送：
  - `extra_body.thinking = { type: 'enabled' }`
  - `reasoning_effort` 映射 `low/medium/high/max`
- reasoning 关闭时发送：
  - `extra_body.thinking = { type: 'disabled' }`
- 响应中保存并回放 `reasoning_content`
- usage 优先读取 `prompt_cache_hit_tokens` 和 `prompt_cache_miss_tokens`

### 7. OpenAI 适配

OpenAI 官方 provider 优先用 Responses API：

- `function_call` 和 `function_call_output` 按 Responses item 保存
- 历史回放优先使用保存的 output item
- 工具调用、最终文本、拒绝、usage 由 Responses transport 归一化

如果某些 OpenAI 模型或配置不支持 Responses，profile 可回退到 Chat Completions，但回退仍然使用结构化 `tool_calls/tool` 历史，不使用文本占位符。

### 8. Anthropic 适配

Anthropic 官方 provider 使用 Messages API：

- `system` 保持顶层
- `assistant.content` 保留 `text/thinking/redacted_thinking/tool_use`
- `user.content` 保存 `tool_result`
- 多工具结果合并到紧随 tool_use 的 user 消息中
- response normalization 保留 content block 顺序

### 9. 流式 UI 行为

当前流式输出会先显示非法内容，再 discard，导致头像和输出闪烁。适配层后调整为：

1. adapter 在首段输出进入 UI 前做 provider-frame 解析。
2. 检测到 plain-text tool placeholder 时，不把该 assistant 文本追加到模型历史。
3. UI 显示“模型输出格式异常，正在按结构化工具调用重试”，不展示泄漏片段。
4. 第二次仍失败时，才持久化 error item。

这不掩盖错误，只避免用户看到闪烁和错误文本污染历史。

### 10. 监控增强

Run monitor 每次模型调用补充：

- `providerId`
- `model`
- `endpointFormat`
- `transport`
- `reasoningMode`
- `toolHistoryMode`
- `attempt`
- `historyMessageCount`
- `providerFrameCount`
- `rejectedOutputReason`

这能直接定位“哪个 provider 用了什么 wire shape，为什么重试/丢弃”。

### 11. 测试计划

第一阶段必须补这些测试：

1. MiniMax-M3：
   - 历史里不再出现 `[Tool ...]`
   - Anthropic tool_use/tool_result 正确配对
   - thinking/content blocks 顺序保留
   - 复现当前 MiniMax plain-text tool leak 记录，确认不再污染历史
2. DeepSeek：
   - `reasoning_content` 多轮回放
   - `thinking` enable/disable body 正确
   - `prompt_cache_hit_tokens/miss_tokens` 优先统计
3. OpenAI：
   - Responses function_call/function_call_output 回放
   - Chat Completions fallback 的 `assistant.tool_calls -> tool` 回放
4. Anthropic：
   - 多工具 tool_result 合并
   - thinking/redacted_thinking/tool_use 顺序保留
5. 回归：
   - `leaksToolProtocol()` 仍能拦截模型普通文本泄漏
   - UI 不再先展示泄漏片段再消失
   - 通用 OpenAI-compatible provider 不被强行套用 DeepSeek/MiniMax 私有字段

### 12. 实施边界

第一阶段不做：

- 不重做设置页 UI
- 不改变用户现有 provider 配置内容
- 不移除通用 OpenAI-compatible
- 不一次性适配 Zhipu、Qwen、Kimi、Gemini、OpenRouter 等全部 provider
- 不把 SDK 调用散落到 runtime 主循环

第一阶段必须做：

- 停止对模型历史输出 `[Tool ...]` 文本
- 保存模型工具调用 id
- 保存 provider assistant frame
- MiniMax-M3 和 DeepSeek 具备可测试的一等回放路径
- OpenAI 与 Anthropic 有正式 adapter 边界

## 验收标准

完成后满足：

1. 使用 MiniMax-M3 进行读文件/工具调用多轮任务，不再出现 `Model output leaked tool-call protocol text into assistant content` 的正常路径失败。
2. 监控里能看到当前请求实际使用的 provider、endpointFormat、transport、reasoningMode、toolHistoryMode。
3. 历史回放中不存在 Suanlizi 自造的 `[Tool ...]` assistant 文本。
4. DeepSeek reasoning 开启时，多轮不会因为缺失 `reasoning_content` 破坏请求。
5. `npm run build`、`npm run lint`、相关 runtime/model-gateway 测试通过。
