# Suanlizi 生产审计待修改清单

来源：`docs/prompts/suanlizi-production-audit-prompt.zh.md` 的只读生产审计。本文只记录已由源码调用链确认的问题；不以历史对话中的“已修复”作为证据。

## P0：必须先闭合

### P0-1 本地 API 信任边界

- 现状：默认 CORS 为 `*`，请求入口没有身份或来源 capability；工作区文件和终端端点接收调用方给出的绝对根目录。
- 风险：用户浏览任意网页时，该网页可跨域调用本机 API，读取文件、创建 PowerShell PTY 并写入命令。
- 修改：默认仅允许 Suanlizi 的本机 UI Origin；移除文件下载端点自行写入的通配 CORS；所有 JSON 请求限制体积，图片请求额外设总量上限。
- 后续：将工作区根目录升级为服务端已授权的 root ID，禁止业务 API 接收任意绝对路径。

### P0-2 终端进程收口

- 现状：关闭 session 时先设置 `exited=true`，导致后续终止进程树的条件永远不成立。
- 修改：记录关闭前退出状态；未退出时终止 PowerShell 及其进程树；保留 session 终态供轮询端确认。

### P0-3 工具取消必须传到子进程

- 现状：工具超时只有 `Promise.race`，`shell_command` 没有监听 `AbortSignal`。
- 修改：ToolRegistry 为单次调用派生 AbortSignal，超时和用户取消都向工具传播；shell 命令收到 abort 后终止 Windows/Unix 进程树并写入可识别错误码。

### P0-4 路径 canonical 化与符号链接

- 现状：路径判断只使用 `path.resolve`，工作区内符号链接可指向工作区外。
- 修改：权限判定和实际读写均使用 realpath 后的 canonical 路径；写入/补丁提交前复验 canonical 路径未发生变化，拒绝符号链接切换后的 TOCTOU。

## 后续优先级

1. P1：线程删除收口事务、终端/浏览器 `threadId` 所有权、Web Ops 接管对称性、知识库编译 checkpoint 恢复。
2. P1：将系统监控收敛为 tenant 级单例，消除每次 Agent 创建遗留的采样定时器。
3. P2：普通 Thread SSE 的 cursor/replay、Composer/文件预览线程分桶、附件引用计数与删除策略。
4. P2：审批 broker 持久化，API 重启后恢复等待授权与审计记录。

## P0 验收标准

- 非 Suanlizi Origin 的预检和状态改变请求均得到拒绝，可信的 `5173/5178` 与桌面 `app://bundle` UI 不受影响。
- 终端关闭、Agent 停止和工具超时后，不存在对应的命令子进程。
- 工作区内的文件或目录符号链接不能借默认工作区授权访问其外部目标。
- 超大 JSON 与超量图片在解析前被拒绝，服务进程不会将其完整拼接到内存。

## 实施记录（2026-09-05）

- P0-1 已完成：默认 CORS 改为 Suanlizi 本机 UI 白名单，移除了原始文件端点的通配 CORS；JSON 默认上限为 1 MiB，对话请求上限为 30 MiB，图片限制为最多 4 张且解码后总量不超过 20 MiB。
- P0-2 已完成：终端关闭会终止未退出的进程树，并保留 60 秒只读终态供输出轮询后自动清理。
- P0-3 已完成：工具注册表把用户取消和超时传入派生 `AbortSignal`；shell 命令会终止 Windows 进程树或 Unix 子进程并返回结构化取消错误。
- P0-4 已完成：路径权限判定基于 realpath 的 canonical target；`write_file` 和 `apply_patch` 落盘前复验路径，避免符号链接切换。

## P1 实施记录（2026-09-07）

- 线程删除已闭合：删除前中断活动 run，并等待线程空闲；超时返回 `THREAD_DELETE_TIMEOUT` 且不删除数据；并发删除返回 `THREAD_DELETE_IN_PROGRESS`；成功时清理 working set、事件客户端、模型槽位、线程数据、rollout 和远程 Bot 绑定。
- 终端与浏览器已按线程隔离：终端 session、输入、输出、resize、删除均校验 `threadId`；Electron 浏览器的创建、枚举、导航、观察、点击、输入、关闭和隐藏均要求线程作用域，Agent 页面继续按 `pageId` 选择并保持同线程串行。
- 浏览器 IPC 增加源码级作用域回归测试，覆盖空作用域、空白规范化、跨线程入口和创建标签的线程绑定；Electron 的生成目录不作为测试入口。
- 系统监控已收敛为 tenant 级共享采样器，子 Agent 不再重复创建或销毁共享 monitor。
- 知识库编译支持内容级 checkpoint：启用待处理缓存时，已脱敏文件以编码载荷和文件元数据保存；恢复前复验 canonical 路径、大小和 mtime，未变化文件直接复用，变化文件重新提取；原文不会进入 checkpoint。
- Web 与桌面 Ops 接管对称：Web 按当前线程恢复非终态任务，waiting confirmation/blocked 会在主聊天流显示可操作锚点，侧栏隐藏时仍可确认、拒绝、补充范围或取消；已结束任务不会自动打开 Ops 工作台。

P1 当前剩余风险：知识库 checkpoint 仅在 `persistPending` 打开时保存内容级中间结果；附件引用计数和审批 broker 持久化仍属于 P2。浏览器原生 View 的完整 Electron 运行验收需在用户启动桌面端后进行，本轮未启动服务进程。

## P2 实施记录（2026-09-07）

- 普通 Thread SSE 已支持有界 cursor/replay：服务端按租户和线程维护最近 500 条事件，发送标准 SSE `id` 与 `sequence`，首次连接可使用 `afterSequence`，浏览器自动重连可使用 `Last-Event-ID`。
- 重放事件带 `isReplay: true`，实时事件带 `isReplay: false`；客户端按线程连接内的 `sequence` 去重，避免断线重连重复追加消息。
- 当游标早于内存保留窗口时发送 `thread.replay.gap`，Web/Desktop 自动重新拉取线程快照；事件缓存不是审计存储，API 重启后仍以持久化线程快照为准。
- 同线程多个 Ops 任务按事件流最后活动时间排序，前端不会因任务局部 `sequence` 从 0 重新开始而选错任务。
- Gitee AI 兼容层已补齐：按官方 Chat Completions 形态发送嵌套 `function` 工具，省略不被其网关接受的 `tool_choice: auto`、`reasoning_effort` 与并行工具字段，并默认带 `X-Failover-Enabled: true`；自定义 `custom_*` provider 只要基址为 `ai.gitee.com` 也会命中该适配。
- Gitee 新模型参数形态已统一：JavaScript 直传的 `top_k`、`frequency_penalty`、`presence_penalty` 与 Python SDK 的 `extra_body` 均可进入同一 Chat Completions 请求；`extra_body` 会展开到顶层且不能覆盖 `model/messages/tools` 等协议字段。流式 `reasoning_content`、`reasoning`、`thinking` 增量统一为 Suanlizi 思考事件；图片消息继续按 OpenAI 多模态 `image_url` 发送。
