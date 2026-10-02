# Suanlizi

**本地 Agent OS** — 一个用 TypeScript 和 React 构建的多智能体全能工作台。

目标：完全本地运行的全能智能体系统。不依赖 ChatGPT 登录、不强制使用 OpenAI API、不绑定云端任务服务。模型侧默认面向 Ollama / LM Studio / vLLM / OpenAI-compatible endpoint（DeepSeek / 通义千问 / 智谱 GLM 等）。

> 当前版本：**v1.5.0** — Cognitive Context Layer（认知上下文层）+ Skill 生命周期 + Experience 经验闭环

## 架构

```text
packages/
├── protocol/         事件协议、Thread/Turn/Item 类型、审批、checkpoint、harness 类型
├── model-gateway/    Ollama / LM Studio / vLLM / OpenAI-compatible 适配层
├── tools/            Shell、文件系统、patch、搜索、git、GitNexus 等本地工具
├── sandbox/          权限预设、执行策略、审批 handler
├── storage/          单机 SQLite + JSONL 持久化
├── context/          Cognitive Context Layer：Provider 体系 + ProjectBrain + Task Cognition + Experience Engine
├── runtime/          Agent 主循环、工具调用、状态机、checkpoint/resume、workflow 蓝图引擎、Task Harness Engine、Skill Executor
├── memory/           上下文压缩、恢复、分支、回滚
├── extensions/       Skill 注册表、AGENTS.md/SKILL.md 解析、Skill 模块加载器、Hooks 系统
├── i18n/             多语言文案
└── bot/              钉钉 / 微信等 IM 平台桥接
apps/
├── api/              本地 Node API，负责运行时、工具执行、审批、线程与 harness 控制
├── desktop/          Electron 桌面端（Windows / macOS / Linux）
└── web/              React + TypeScript 本地控制台
```

## 快速启动

```bash
npm install
npm start
```

启动后打开：

- Web 控制台：http://127.0.0.1:5177
- API 服务：http://127.0.0.1:4127

默认启动是 **单机模式**，使用 SQLite + 本地 rollout 文件，面向个人桌面使用。

## 桌面端启动

桌面端（Electron + WebContentsView）是浏览器运行时（内置浏览器面板）的唯一宿主：用户与 Agent 操作**同一个** WebContentsView（同一 DOM / Cookie / 会话），Agent 动作通过 webContents.debugger（CDP）实时驱动用户可见页面。

### 前置环境

| 组件 | 说明 | 获取方式 |
| --- | --- | --- |
| Node.js ≥ 22 | 运行 Electron Main / 构建 | https://nodejs.org |
| Electron（含 Chromium） | 桌面窗口与内置浏览器 | `npm install`（devDependencies 已含，安装时自动下载二进制） |

### 完整桌面应用（Electron 窗口）

```bash
npm install
npm run desktop:dev
```

`desktop:dev` 通过 `scripts/start-desktop.mjs` 自动拉起 API 服务（http://127.0.0.1:4127）、桌面 UI 开发服务器（http://127.0.0.1:5178）与 Electron Main（dev 模式加载 5178 Renderer，含「浏览器」工作台）。

### 仅桌面 UI 预览（无 Electron，浏览器里看界面）

```bash
npm start                                              # API 服务
npm --workspace @suanlizi/desktop run dev:ui              # 打开 http://127.0.0.1:5178
```

> 注意：浏览器预览模式没有 `suanliziDesktop` 桥，浏览器工作台会显示「桌面浏览器不可用」——这是 strict 模式的预期行为，生产环境不会静默降级为 mock。真实浏览器功能必须通过 Electron 桌面窗口使用。

### 生产构建

```bash
npm run desktop:build        # 构建 Electron 可执行产物（安装包打包在 Phase 5）
```

### 浏览器运行时链路

桌面窗口内浏览器工作台的动作链路：

```text
React Desktop UI → Electron Main（BrowserViewManager + CDP Adapter）
  → Agent Runtime（BrowserTaskOrchestrator 在 Main 进程：策略/预算/账本/审批）
  → 同一 WebContentsView（用户可见页面，单一持久化会话 persist:suanlizi-browser）
```

策略执行点位于 Main 进程的 orchestrator：所有动作强制经过 `BrowserTaskOrchestrator`（AccessPolicy / ApprovalRequest / 预算 / checkpoint），外部副作用动作会先弹出审批请求。Agent 的导航/点击/输入在用户可见的真实页面上实时发生。

## 核心能力

### Agent 运行时
- **多对话线程**：每个对话对应独立 thread，上下文和运行状态完全隔离
- **状态机**：idle / running / interrupted / completed / failed 完整状态流转
- **Checkpoint / Resume**：每轮对话和每次工具调用后写入检查点，支持随时停止、断点续跑和冷恢复
- **子 Agent**：支持 spawn 子智能体分工协作，子 Agent 继承并只能收紧父 Agent 的权限
- **上下文压缩**：三级压缩框架（轻记忆 + episode + 结构化 summary），token 达到阈值自动触发压缩
- **A2A 协议**（v1.0+）：Agent-to-Agent 标准协议，可调用远程 Agent 执行子任务
- **Harness 自主循环**（v1.2+）：跨 turn 的 Goal → Plan → Execute → Critique → Replan → Verify，配合 Evidence Ledger 与四层上下文裁切
- **Workflow 蓝图引擎**（v1.2+）：基于 DAG 的可视化工作流，支持计划 / 审批 / 发布 / 执行 / 重规划
- **Cognitive Context Layer**（v1.5+）：线程级 Provider 体系（Environment / Task / ProjectBrain），架构 hash 增量注入，turn 级缓存避免重复执行
- **ProjectBrain**（v1.5+）：自动扫描项目结构、模块依赖、风险区域，跨线程共享架构缓存
- **Experience Engine**（v1.5+）：SAO（Situation-Action-Outcome）经验沉淀，harness 结束自动记录成功/失败模式，冷启动加速
- **Skill 生命周期**（v1.5+）：prepare → execute → verify 三阶段执行，失败自动 rollback，支持文件备份回滚

### 工具与安全
- **本地工具集**：Shell、文件读写、patch、搜索、git 等常用工具内置
- **三档权限预设**：`read_only`（只读）、`workspace`（工作区内可写 + 审批）、`danger_full_access`（完全权限）
- **人机审批**：workspace 模式下，写文件和命令类工具自动进入 Web 审批队列
- **执行策略**：shell 命令可按规则配置 allow / prompt / forbidden
- **MCP 治理**：支持 MCP 工具接入，Web 配置界面 + 运行时懒加载 + 连接状态监控
- **GitNexus 代码分析**（v1.1+）：三层架构（serve HTTP / MCP fallback / CLI npx 包装）自动分析代码仓库

### 技能与扩展
- **Skills 系统**：支持本地 Skill 目录，按任务选择、自动匹配，支持 GitHub URL 一键安装
- **Skill 生命周期**（v1.5+）：prepare（前置检查+文件备份）→ execute（执行）→ verify（后置校验），任一阶段失败自动 rollback 恢复文件
- **Hooks 扩展**：AGENTS.md、SKILL.md 约定式扩展入口
- **A2A 协议**：跨进程、跨语言 Agent 调用
- **MCP 工具生态**：运行时懒加载 MCP 服务，Web 配置界面管理连接

### 系统监控与限流
- **实时监控**：CPU / 内存 / 磁盘占用后台采样
- **四级限流**：none → light → moderate → severe，逐级收紧
  - light：并行批 ≤ 2，禁止新子 Agent
  - moderate：全串行执行，禁止新子 Agent
  - severe：仅允许只读工具，全串行，禁止新子 Agent
- **主动通知**：限流等级变化时主动告知 Agent，自动调整执行策略

### 模型厂商注册
- **OpenAI-compatible 自定义 API**：设置页填写厂商名称、Base URL 和 API Key 后应用；保存时会创建独立厂商条目，并在桌面端浏览器当前 tab 可用时自动取其 favicon 作为厂商图标
- **厂商下拉展示**：已注册的自定义厂商出现在厂商下拉“自定义”分组，输入栏模型预设选项也会使用对应图标；未提供 favicon 的自定义/兼容端点显示中性连接图标，不根据模型名猜测厂商品牌

### IM 平台接入- **微信远程助手**：桌面端个人微信桥接，消息进入绑定的 Suanlizi 对话
- **钉钉机器人**：Stream 模式长连接 + AI Card 流式回复 + 企业数据操作（详见下方）

## Work 与 Code 两种工作模式

Suanlizi 把"做什么"（**会话类型**）和"怎么跑"（**runProfile**）分成两个独立的维度。它们的组合决定了 Agent 在当前对话中的能力水平。

### 维度一：会话类型（What）

新建对话时选择，决定工作区与上下文环境：

| 类型 | workspace | 适用 | 说明 |
|------|-----------|------|------|
| **Work（聊天）** | 空（无工作区） | 文档问答、内容生产、知识查询、闲聊 | 不绑定项目目录，配置极简，适合轻量任务 |
| **Code（项目）** | workspaceRoot | 编程开发、文件操作、工具调用、代码分析 | 绑定本地代码目录，可读写文件、运行命令、调用 GitNexus 等工具 |

会话类型决定的是"Agent 能看到/操作什么"。

### 维度二：runProfile（How）

每个对话可在设置中切换，决定运行策略与压缩行为：

| Profile | 压缩策略 | 缓存策略 | 适合 | 定位 |
|---------|----------|----------|------|------|
| **`cache_first`（缓存优先）** | 保守，延迟压缩 | 优先保持稳定 prefix，提高 cache 命中 | 重复查询、长文档、追问 | DeepSeek / OpenAI 兼容模型缓存敏感场景 |
| **`runtime_os`（长运行）** | 中等保守 | 平衡可观测性与性能 | 复杂多步任务、可追溯流程 | 多智能体协作、长任务、压缩/中断恢复优先 |
| **`harness`（Harness 自主循环）** | 较早压缩，可选 LLM 语义压缩 | 不追求稳定 prefix，配合上下文裁切 | 自适应任务、自主目标达成 | Task Harness Engine 启动档位 |

### 组合建议：work × code 各推荐什么？

#### Work 模式（聊天会话）

会话类型为 `chat`（无 workspace），主要用于问答、内容生产、知识查询。

| Profile | 能力 | 适用 |
|---------|------|------|
| **`cache_first`** ⭐ 推荐 | 提示词和工具结构稳定，延迟压缩，缓存命中率高 | 重复性提问、文档问答、长文档追问 |
| **`runtime_os`** | 中等压缩，可观测性强 | 多步追问、需要回溯的复杂问答 |
| `harness` | 不推荐：无 workspace 时工具能力受限 | — |

**Work 模式能力水平**：文档检索、压缩对话、引用追溯、A2A 远端 Agent 调用、AI Card 流式回复（钉钉/微信场景）。不涉及本地文件操作。

#### Code 模式（项目会话）

会话类型为 `project`（绑定 workspaceRoot），主要用于编程、文件操作、工具调用、代码分析。

| Profile | 能力 | 适用 |
|---------|------|------|
| **`harness`** ⭐ 推荐 | 自主循环：Goal→Plan→Execute→Critique→Replan，Evidence Ledger 记录每次 tool/file/command 收据，StormBreaker 防死循环 | 多步编码任务、文件批量修改、跨文件重构、自动化运维 |
| **`runtime_os`** | 平衡可观测性，任务全程可追踪 | 需要详细回溯的开发任务、调试 |
| `cache_first` | 延迟压缩，长 prefix 缓存 | 长会话的代码探索、反复修改同一组文件 |

**Code 模式能力水平**（按 profile 递增）：

- `cache_first`：单 turn 工具调用、稳定 prefix 缓存
- `runtime_os`：单 turn 工具调用 + 全程可观测（checkpoint / event / 工具调用栈）
- `harness`：在 `runtime_os` 之上加 **跨 turn 自主循环**，可自动重启 turn 直到目标达成（验收标准全过），可暂停 / 恢复 / 取消

#### 一句话总结

| | Work（聊天） | Code（项目） |
|---|---|---|
| **首选 profile** | `cache_first` | `harness` |
| **次选 profile** | `runtime_os` | `runtime_os` |
| **核心能力** | 文档问答、内容生产、压缩对话 | 文件操作、工具调用、GitNexus、自主循环 |
| **不涉及** | 本地文件 | 跨项目跨用户 |

## 微信远程助手

桌面端支持个人微信桥接，把微信消息接入 Suanlizi 对话：

- 扫码登录一次即可，切换对话不需要重新扫码
- 消息进入当前绑定的对话，可随时改绑
- 配置按 thread 独立生效（模型、权限、Skills 等）
- 收到消息先自动 ACK，处理完成后统一回复

## 钉钉机器人

Suanlizi 深度集成钉钉平台，支持消息收发、AI Card 流式回复、企业数据操作等完整能力。

### 接入方式

| 模式 | 说明 | 适用场景 |
|------|------|----------|
| **Stream 长连接** | WebSocket 长连接，主动推送消息 | 生产环境推荐，无需公网回调地址 |
| **Webhook 回调** | HTTP 回调接收消息 | 有公网地址的服务端部署 |

配置参数：`AppKey`（clientId）、`AppSecret`（clientSecret）、`RobotCode`。

### 消息收发

- **单聊 / 群聊**：都支持，群聊需 @ 机器人触发
- **文本 / 富文本 / 图片 / 文件**：全消息类型接收
- **@ 提及解析**：自动识别 @ 姓名，三级查找策略（已知用户缓存 → dws 通讯录 → 组织成员），支持真实钉钉 @ 高亮
- **消息转发**：单聊消息可转发到目标群，附件 / 图片也支持转发
- **自动降级**：session webhook 过期（错误码 300001）时自动降级为机器人主动发送
- **文件传输**：最大 20MB，支持下载钉钉附件并转发到群

### AI Card 流式回复

- 专属 AI Card 模板，支持 Markdown 内容流式追加
- 思考中 / 生成中 / 已完成 状态可视化
- 同一张卡片持续更新，不刷屏

### 企业数据操作（dws CLI）

通过 dws 命令行工具操作钉钉企业数据，Agent 可以直接调用：

| 能力 | 说明 |
|------|------|
| **通讯录** | 搜索联系人、查询组织成员 |
| **日历** | 创建 / 查询 / 修改日程事件 |
| **待办** | 创建待办、指定执行人、状态跟踪 |
| **AI 表格** | 读写钉钉智能表格 / 多维表格 |
| **文档** | 读写钉钉文档、云盘文件 |
| **考勤** | 查询考勤记录、排班信息 |
| **DING 消息** | 发送 DING 消息加急通知 |
| **审批** | 发起 / 查询审批单 |
| **群聊管理** | 管理群成员、群设置 |

调用方式为统一的 `dingtalk` 工具，通过 `action` 参数区分：

- `send_message`：发送 / 转发消息到群
- `dws_exec`：执行 dws 命令（如 `["calendar","event","list"]`）
- `dws_schema`：查询可用的 dws 产品和工具
- `dws_auth_status`：检查 dws 登录状态和当前组织

支持 `dwsDryRun` 预览破坏性操作，`dwsJq` 过滤 JSON 输出减少 token 消耗。

## GitNexus 三层架构（v1.1+）

GitNexus 是 Suanlizi 内置的代码仓库分析能力，通过三层降级保证可用性：

| 层 | 名称 | 作用 | 触发条件 |
|----|------|------|----------|
| **Layer 1** | serve HTTP | `gitnexus serve` 子进程 + HTTP 查询（4747 端口） | 默认优先 |
| **Layer 2** | MCP | serve 不可用时 fallback 到 MCP 协议 | serve 健康检查失败 |
| **Layer 3** | CLI / npx | `gitnexus_analyze` 工具封装 `npx -y gitnexus@latest` 调用 | serve 与 MCP 都不可用 |

Agent system prompt 明确三层使用策略，确保任何环境下都能调用 GitNexus 做代码分析。

## API 路由速查

| 路径 | 说明 |
|------|------|
| `POST /api/threads` | 新建会话（chat/project/workflowProject） |
| `GET /api/threads/:id` | 会话详情（thread/turns/items/config/usage） |
| `POST /api/threads/:id/turn` | 提交用户输入、启动一轮 |
| `POST /api/threads/:id/interrupt` | 中断当前 turn |
| `GET /api/threads/:id/state` | Runtime 状态（turn/iteration/usage） |
| `GET /api/threads/:id/context-pressure` | 上下文压力（用于决定是否压缩） |
| `POST /api/threads/:id/skills/install` | 一键安装 GitHub Skill |
| `POST /api/threads/:id/harness/start` | 启动 Harness 自主循环（立即返回 harnessRunId） |
| `GET /api/threads/:id/harness/status` | 查询 harness 状态（运行时 + 持久化） |
| `POST /api/threads/:id/harness/cancel` | 取消运行中的 harness run |
| `GET /api/events/:threadId` | SSE 事件流（turn.started/item.completed/turn.completed/...） |

## 后续重点

- **Experience 检索**：将 SAO 经验接入冷启动和 turn 级上下文，实现真正的"越用越聪明"
- **Skill prepare/verify 示例**：为官方内置 skill 补充 prepare/verify/rollback 最佳实践模板
- **Harness 经验可视化**：Run Monitor 中展示从 Experience Engine 命中的历史经验
- **Harness 自主循环**：完善 Evidence Ledger 可视化、目标达成度评分
- **Workflow 蓝图**：节点级审批、断点恢复
- **输入框命令**：`/skills add`、`/mcp add`、`/plan` 等应用内命令
- **上下文压缩**：完善三级压缩、handoff summary、缓存命中统计
- **恢复能力**：增强主动停止、异常退出、进程重启后的恢复体验

## 许可证

MIT
