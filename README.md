# Suanlizi

**本地个人 Agent 工作台** — 用 TypeScript 和 React 构建的本地智能体工作流工具。

目标：完全本地运行的全能智能体系统。不依赖 ChatGPT 登录、不强制使用 OpenAI API、不绑定云端任务服务。模型侧默认面向 Ollama / LM Studio / vLLM / OpenAI-compatible endpoint（DeepSeek / 通义千问 / 智谱 GLM 等）。

> 当前版本：**v1.9.0** — 本地个人工作台，重点优化桌面体验、任务可观测性与上下文压缩

## 架构

```text
packages/
├── protocol/         事件协议、Thread/Turn/Item 类型、审批、checkpoint、harness 类型
├── model-gateway/    Ollama / LM Studio / vLLM / OpenAI-compatible 适配层
├── tools/            Shell、文件系统、patch、搜索、git 等本地工具
├── sandbox/          权限预设、执行策略、审批 handler
├── storage/          单机 SQLite + JSONL 持久化
├── context/          上下文编译、Provider 体系、项目上下文与预算控制
├── runtime/          Agent 主循环、工具调用、状态机、checkpoint/resume、Task Harness、Skill Executor
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
- 桌面 UI 开发端口：http://127.0.0.1:5178
- API 服务：http://127.0.0.1:4127

默认是本地单用户模式：数据保存在应用目录的 `app-data/`，不启用多人、多租户或云端任务服务。

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
npm run desktop:build        # 构建桌面 UI、Electron Main 和 NSIS 安装包
```

### 浏览器运行时链路

桌面窗口内浏览器工作台的动作链路：

```text
React Desktop UI → Electron Main（BrowserViewManager + CDP Adapter）
  → Agent Runtime（BrowserTaskOrchestrator 在 Main 进程：策略 / 预算 / 账本 / 审批）
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
- **A2A 协议**：Agent-to-Agent 标准协议，可调用远程 Agent 执行子任务
- **Harness 自主循环**：跨回合的目标评估、计划执行、证据记录与可取消恢复
- **任务与工作流**：任务状态机、目标状态、重规划与工作流项目
- **上下文编译**：环境、任务与项目上下文按回合组装，减少重复扫描
- **项目上下文**：识别项目结构、依赖和风险区域，变更后自动失效缓存
- **经验与记忆**：记录可复用的成功/失败模式，并支持冷记忆与回合记忆注入
- **Skill 生命周期**：prepare → execute → verify，失败可按能力回滚

### 工具与安全
- **本地工具集**：Shell、文件读写、patch、搜索、git 等常用工具内置
- **三档权限预设**：`read_only`（只读）、`workspace`（工作区内可写 + 审批）、`danger_full_access`（完全权限）
- **人机审批**：写入和命令类操作在 UI 内审批；错误提示收敛到聊天消息流
- **执行策略**：Shell 命令按白名单、确认和禁止规则执行，超时和取消会写入终态
- **MCP 治理**：支持 MCP 工具接入，Web 配置界面 + 运行时懒加载 + 连接状态监控

### 技能与扩展
- **Skills 系统**：支持本地 Skill 目录，按任务选择、自动匹配，支持 GitHub URL 一键安装
- **Skill 生命周期**：prepare（前置检查与备份）→ execute（执行）→ verify（校验）
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

### IM 平台接入
- **微信远程助手**：桌面端个人微信桥接，消息进入绑定的 Suanlizi 对话
- **钉钉机器人**：Stream 模式长连接 + AI Card 流式回复 + 企业数据操作（详见下方）

## 对话类型与运行参数

Suanlizi 只区分“是否绑定工作区”；运行强度由统一的运行参数控制。

### 对话类型

新建对话时选择，决定工作区与上下文环境：

| 类型 | workspace | 适用 | 说明 |
|------|-----------|------|------|
| **聊天** | 无工作区 | 文档问答、内容生产、知识查询、闲聊 | 不绑定项目目录，适合轻量任务 |
| **项目** | workspaceRoot | 编程开发、文件操作、工具调用、代码分析 | 绑定本地代码目录，可读写文件、运行命令、调用本地工具 |

对话类型决定 Agent 能看到和操作什么。聊天对话只保留通用工具；项目对话绑定工作区，才启用文件与终端能力。

### 运行参数

所有对话共用一组运行参数，可在“设置 → 运行参数”里调整：

| 参数 | 作用 |
|------|------|
| 权限模式 | 只读、工作区写入或完全自主，服务端会再次校验 |
| 思考程度 | `no` / `medium` / `high` / `xhigh` / `max` |
| 模型上下文和输出上限 | 按模型实际窗口设置，避免超限 |
| 上下文压缩阈值 | 达到模型上下文窗口的百分比后压缩旧回合 |
| 模型 / 工具超时 | 控制单次模型请求和单次工具调用等待时间 |
| 事件流 / 断网重连次数 | 控制前端断线后的恢复尝试 |
| 子 Agent 深度 | 当前服务端硬上限为 2，同一线程保持串行 |

### 使用建议

- **轻量问答**：聊天对话 + 只读或工作区权限，模型上下文按实际模型设置。
- **代码任务**：项目对话 + 工作区权限，任务越长越依赖上下文压缩和运行监控。
- **自动执行**：只在明确需要连续执行时使用完全自主权限，并保留可取消和可追踪的事件流。
