# Suanlizi v1.5.0 配置与架构指南

本文档详细说明 Suanlizi 的目录结构、配置层级、上下文治理机制和完整的配置方式。

---

## 一、目录结构总览

```
Suanlizi/
├── apps/                          # 应用层（可运行的终端产品）
│   ├── api/                       # 本地 Node.js API 服务
│   │   ├── src/
│   │   │   ├── server.ts          # HTTP/SSE 服务入口
│   │   │   ├── services/          # 业务服务层
│   │   │   │   ├── agentService.ts    # Agent 生命周期管理
│   │   │   │   ├── dingtalkForwardTool.ts # 钉钉文件转发工具
│   │   │   │   └── ...
│   │   │   ├── config/
│   │   │   │   ├── config.ts      # 核心运行配置（AgentRunConfig）
│   │   │   │   └── mcp.ts         # MCP 服务器配置
│   │   │   └── http/              # HTTP 路由与响应处理
│   │   └── package.json
│   ├── desktop/                   # Tauri 桌面端（Windows/macOS/Linux）
│   │   ├── src/                   # 前端渲染层（与 web 共享代码）
│   │   ├── src-tauri/             # Rust/Tauri 主进程
│   │   │   ├── Cargo.toml         # Rust 依赖（版本号 1.5.0）
│   │   │   ├── tauri.conf.json    # Tauri 配置（版本号 1.5.0）
│   │   │   └── icons/             # 应用图标
│   │   └── package.json
│   └── web/                       # React Web 控制台（开发模式独立使用）
│       ├── src/
│       │   ├── components/        # 可复用 UI 组件
│       │   ├── threadView.ts      # 对话视图模型
│       │   ├── settings/          # 设置面板
│       │   │   ├── ProviderSettings.tsx    # 模型提供商设置
│       │   │   ├── SkillsSettings.tsx      # Skill 管理
│       │   │   └── McpSettings.tsx         # MCP 服务器管理
│       │   └── main.tsx           # 前端入口
│       └── package.json
│
├── packages/                      # 核心库（可独立发布的模块）
│   ├── protocol/                  # 协议层：跨包共享类型定义
│   │   └── src/
│   │       ├── index.ts
│   │       ├── thread.ts          # Thread/Turn/Item 类型
│   │       ├── checkpoint.ts      # Checkpoint 协议
│   │       └── events.ts          # 事件流协议
│   │
│   ├── model-gateway/             # 模型网关：统一 LLM 适配层
│   │   └── src/
│   │       ├── providers/         # 各厂商适配
│   │       │   ├── ollama.ts
│   │       │   ├── openaiCompatible.ts
│   │       │   ├── lmstudio.ts
│   │       │   └── vllm.ts
│   │       ├── chat.ts            # ChatMessage / ToolCall 类型
│   │       └── index.ts
│   │
│   ├── tools/                     # 内置工具集
│   │   └── src/
│   │       ├── shell.ts           # Shell 命令执行（受沙箱约束）
│   │       ├── filesystem.ts      # 文件读写工具
│   │       ├── patch.ts           # 精确补丁编辑
│   │       ├── git/               # Git 操作工具集
│   │       ├── gitnexus/          # GitNexus 代码导航工具
│   │       └── index.ts           # 工具注册入口
│   │
│   ├── sandbox/                   # 沙箱与权限
│   │   └── src/
│   │       ├── sandbox.ts         # 沙箱执行器
│   │       ├── presets.ts         # 三档权限预设（只读/默认/完全访问）
│   │       └── approval.ts        # 审批策略（on_request/never/on_failure）
│   │
│   ├── storage/                   # 持久化层
│   │   └── src/
│   │       ├── sqlite.ts          # SQLite 主存储
│   │       ├── jsonl.ts           # JSONL rollout 日志
│   │       └── index.ts
│   │
│   ├── context/                   # 🧠 认知上下文层（v1.5.0 新增核心）
│   │   └── src/
│   │       ├── types.ts           # AgentContext / Provider 接口定义
│   │       ├── contextEngine.ts   # Context Engine（组装器+预算裁切）
│   │       ├── providers/         # 上下文 Provider 体系
│   │       │   ├── environmentContext.ts   # 环境信息（CWD/OS/Shell/Git）
│   │       │   ├── projectBrainContext.ts  # ProjectBrain（项目架构扫描）
│   │       │   └── taskContext.ts         # Task Cognition（目标/约束/风险）
│   │       ├── experience/        # 📚 Experience Engine（SAO经验闭环）
│   │       │   ├── experienceEngine.ts     # 经验记录/检索引擎
│   │       │   ├── experienceStore.ts      # 内存/持久化存储
│   │       │   ├── evaluationGate.ts       # 经验质量评估门控
│   │       │   └── types.ts
│   │       └── index.ts
│   │
│   ├── runtime/                   # Agent 运行时（主循环）
│   │   └── src/
│   │       ├── agent.ts           # Agent 主类（编排入口）
│   │       ├── middlewares/       # 中间件管线
│   │       │   ├── middleware.ts          # Turn 级中间件（含上下文缓存）
│   │       │   └── dynamicContext.ts      # 动态上下文注入中间件
│   │       ├── harness/           # 🎯 Task Harness Engine（自主循环）
│   │       │   ├── taskHarness.ts         # Harness 主引擎
│   │       │   ├── goalTracker.ts         # 目标追踪状态机
│   │       │   ├── evidenceLedger.ts      # 证据账本
│   │       │   └── types.ts
│   │       ├── skillExecutor.ts   # Skill 执行器（含 prepare/verify/rollback）
│   │       ├── state.ts           # 线程状态管理（idle/running/interrupted...）
│   │       ├── memoryCompression.ts # 上下文压缩
│   │       └── workflow/          # Workflow 蓝图引擎（DAG）
│   │
│   ├── memory/                    # 记忆系统
│   │   └── src/
│   │       ├── settings.ts        # 记忆设置（默认值+规范化）
│   │       ├── summarizer.ts      # 摘要器
│   │       └── episodeMemory.ts   # Episode 记忆
│   │
│   ├── extensions/                # Skill/Hook 扩展系统
│   │   └── src/
│   │       ├── skillRuntime.ts    # SkillModule 类型/加载器/生命周期
│   │       ├── skillRegistry.ts  # Skill 注册表
│   │       ├── skillMdParser.ts  # SKILL.md 解析器
│   │       ├── agentsMd.ts       # AGENTS.md 解析
│   │       └── index.ts
│   │
│   ├── i18n/                      # 国际化（中/英）
│   │   └── src/
│   │       ├── zh.ts
│   │       ├── en.ts
│   │       └── index.ts
│   │
│   └── bot/                       # IM 机器人桥接
│       └── src/
│           ├── dingtalk.ts        # 钉钉适配器
│           └── wechat.ts          # 微信适配器
│
├── docs/                          # 文档
├── scripts/                       # 构建/开发脚本
├── tests/                         # 跨包集成测试
├── package.json                   # 根 package.json（monorepo 管理）
├── tsconfig.base.json             # TypeScript 基础配置
└── AGENTS.md                      # Agent 协作规范（给 AI 助手看的）
```

---

## 二、配置层级总览

Suanlizi 采用**四层配置叠加**模型，从底层到顶层依次合并，顶层覆盖底层：

```
┌─────────────────────────────────────────────────────┐
│  Layer 4: 单次 Turn 请求配置（TurnRequest.config）    │  最高优先级
├─────────────────────────────────────────────────────┤
│  Layer 3: 线程级配置（thread.tags.runConfig）        │  每个线程独立
├─────────────────────────────────────────────────────┤
│  Layer 2: 用户默认配置（SQLite settings 表）          │  UI 设置面板写入
├─────────────────────────────────────────────────────┤
│  Layer 1: 系统默认值（defaultConfig 常量）            │  代码内置，最低优先级
└─────────────────────────────────────────────────────┘
```

### 各层详解

#### Layer 1：系统默认值（代码内置）

定义于 [config.ts](file:///e:/langchain/Suanlizi/apps/api/src/config/config.ts#L200-L229) 的 `defaultConfig`：

| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| `workspaceRoot` | `process.cwd()` | 工作区根目录 |
| `provider` | `'ollama'` | 模型提供商 |
| `model` | `'qwen2.5-coder:7b'` | 默认模型 |
| `permissions` | `'workspace'` | 权限预设 |
| `dataDir` | `<cwd>/.suanlizi` | 数据目录 |
| `skillsRoot` | `<home>/.suanlizi/skills` | Skill 目录 |
| `webSearchMode` | `'auto'` | 网页搜索模式 |
| `webProvider` | `'native_fetch'` | 网页抓取后端 |
| `reasoningEffort` | `'medium'` | 推理力度 |
| `runProfile` | `'runtime_os'` | 运行模式 |
| `themeMode` | `'light'` | 界面主题 |
| `memoryEnabled` | 见 memory settings | 记忆开关 |
| `systemMonitorEnabled` | `false` | 系统监控限流 |

#### Layer 2：用户默认配置（持久化）

存储在 SQLite `settings` 表中，key 为 `runConfig.default`。通过 Web UI 设置面板修改，调用 `POST /api/config` 持久化。

#### Layer 3：线程级配置（Thread Override）

存储在每个 thread 的 `tags.runConfig` JSON 字段中。允许不同线程使用不同模型/权限，例如：
- Chat 线程用轻量模型快速响应
- 代码分析线程用强模型
- Harness 任务线程用 `harness` runProfile

#### Layer 4：单次请求配置（Turn Override）

API 调用时通过 `TurnRequest.config` 传入，仅影响当前 turn，不持久化。

---

## 三、数据目录结构

首次启动后，`<dataDir>`（默认 `.suanlizi/`）会生成以下结构：

```
.suanlizi/
├── suanlizi.sqlite                   # SQLite 主数据库
│   ├── threads                    # 线程表
│   ├── turns                      # Turn 表
│   ├── items                      # 消息/工具调用/结果表
│   ├── checkpoints                # Checkpoint 表
│   ├── settings                   # 配置表（Layer 2 存储位置）
│   ├── harness_state              # Harness 状态
│   └── experiences                # Experience 经验库（v1.5.0+）
│
├── rollouts/                      # JSONL rollout 日志（每 turn 一个文件）
│   └── <threadId>/
│       └── <turnId>.jsonl
│
├── skills/                        # Skill 缓存（加载的 Skill 模块）
├── mcp/                           # MCP 服务器缓存
└── chat-workspace/                # Chat 模式隔离工作区
```

全局 Skill 目录位于用户 home 下：

```
~/.suanlizi/skills/
└── <skill-name>/
    ├── SKILL.md                   # Skill 描述文档（必须）
    ├── index.ts                   # 可执行入口（可选，对应 entryPath）
    └── ...                        # Skill 附带的资源文件
```

---

## 四、核心配置项详解

### 4.1 模型提供商配置

通过 UI 设置面板或 API 配置：

```typescript
interface AgentRunConfig {
  provider: string;       // 'ollama' | 'openai' | 'lmstudio' | 'vllm' | 自定义
  model: string;          // 模型 ID，如 'qwen2.5-coder:7b'、'gpt-4o'
  baseUrl?: string;       // API 基础 URL
  apiKey?: string;        // API Key（不返回给前端，敏感字段）
}
```

**API Key 来源：**
- 环境变量：如 `OPENAI_API_KEY`、`FIRECRAWL_API_KEY`
- 项目配置数据库：通过 UI 输入，存入 SQLite（加密存储）
- `webProviderKeySource` 控制 Firecrawl 等第三方 Key 的来源优先级

### 4.2 权限预设（Sandbox）

三档内置预设定义于 [presets.ts](file:///e:/langchain/Suanlizi/packages/sandbox/src/presets.ts#L55-L94)：

| 预设 ID | 中文名 | 审批策略 | 沙箱等级 | 网络 | 适用场景 |
|---------|--------|----------|----------|------|----------|
| `read_only` | 只读 | 每次询问 | readonly | ❌ | 代码审查、只读分析 |
| `workspace` | 默认 | 每次询问 | workspace_write | ❌ | 日常开发（推荐） |
| `danger_full_access` | 完全访问 | 从不询问 | full | ✅ | 信任环境下全自动 |

**审批策略三种：**
- `on_request`：每次工具调用弹窗请求用户批准
- `never`：自动批准所有操作（危险模式）
- `on_failure`：仅在命令失败时询问是否重试

### 4.3 运行模式（Run Profile）

```typescript
type RunProfile = 'cache_first' | 'runtime_os' | 'harness';
```

| 模式 | 说明 |
|------|------|
| `cache_first` | 优先使用缓存，命中则跳过工具执行，适合稳定性优先的场景 |
| `runtime_os` | 标准模式，正常执行工具调用，适合日常使用（默认） |
| `harness` | 启动 Task Harness 自主循环，Agent 自动迭代直到目标达成 |

### 4.4 网页搜索配置

```typescript
webSearchMode: 'auto' | 'on' | 'off';     // 搜索开关
webProvider: 'native_fetch' | 'firecrawl'; // 抓取后端
webProviderKeySource: 'config' | 'env';   // Firecrawl Key 来源
```

- `native_fetch`：使用原生 fetch 抓取（免费但受限）
- `firecrawl`：使用 Firecrawl 服务（需 API Key，抓取质量更高）

### 4.5 记忆系统配置

**基础记忆（Light Memory）：**

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `memoryEnabled` | true | 全局记忆开关 |
| `autoExtractMemories` | true | 自动从对话中提取记忆 |
| `useColdMemories` | true | 注入冷启动记忆 |
| `memoryInjectLimit` | 5 | 单次注入记忆条数上限 |
| `memoryTokenBudget` | 800 | 记忆 Token 预算 |

**Episode 记忆（情景记忆）：**

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `episodeMemoryEnabled` | true | Episode 记忆开关 |
| `episodeInjectLimit` | 3 | 注入 Episode 条数 |
| `episodeTokenBudget` | 600 | Episode Token 预算 |
| `episodeSwitchCooldownTurns` | 3 | 切换 Episode 冷却回合数 |
| `episodeSealIdleMinutes` | 30 | Episode 封存空闲时间（分钟） |
| `episodeColdAfterDays` | 7 | Episode 变冷天数 |
| `episodeFtsCandidateLimit` | 20 | 全文检索候选数 |
| `episodeRerankEnabled` | true | 启用重排序 |

### 4.6 MCP 配置

MCP 服务器列表存储在 `settings` 表的 `mcpServers` key 中，格式：

```typescript
interface McpServerConfig {
  id: string;
  name: string;
  transport: 'stdio' | 'sse';
  command?: string;      // stdio 模式：启动命令
  args?: string[];       // stdio 模式：命令参数
  url?: string;          // sse 模式：服务器 URL
  env?: Record<string, string>; // 环境变量
  enabled: boolean;
}
```

通过 UI 设置面板的 "MCP Servers" 部分添加/删除/启停。

### 4.7 A2A 协议配置

```typescript
interface A2AConfig {
  enabled: boolean;        // 启用 A2A Server（对外暴露 Agent）
  clientEnabled: boolean;  // 启用 A2A Client（调用远程 Agent）
  remotes: Array<{         // 已注册的远程 Agent 列表
    url: string;
    name?: string;
    addedAt: string;
  }>;
}
```

### 4.8 子 Agent 角色档案

通过 `agentRoles` 配置不同 `agent_type` 的角色预设：

```typescript
type AgentRoleProfiles = Record<string, {
  description?: string;      // 角色描述
  instructions?: string;     // 角色指令
  systemPrompt?: string;     // 额外 System Prompt
  skills?: string[];         // 默认加载的 Skill
  allowedSkills?: string[];  // 允许的 Skill 白名单
  allowedTools?: string[];   // 允许的工具白名单
  blockedTools?: string[];   // 禁用的工具黑名单
  serviceTier?: string;      // 服务等级
  maxSubagents?: number;     // 最大子 Agent 数
  maxSubagentDepth?: number; // 最大子 Agent 嵌套深度
}>;
```

### 4.9 推理力度

```typescript
type ReasoningEffort = 'low' | 'medium' | 'high';
```

控制模型思考深度：
- `low`：快速响应，token 消耗少
- `medium`：平衡（默认）
- `high`：深度思考，适合复杂任务

### 4.10 界面配置

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `themeMode` | `'dark' \| 'light' \| 'system'` | `'light'` | 主题模式 |
| `locale` | `'zh' \| 'en'` | 自动检测 | 界面语言 |

---

## 五、🧠 上下文治理机制（v1.5.0 核心）

### 5.1 AgentContext 三层认知模型

每次 turn 开始前，Context Engine 会组装一个完整的 `AgentContext`，分三层：

```
AgentContext
├── cognition: CognitionLayer    ← 认知层（Agent 对任务的理解）
│   └── task: TaskCognition
│       ├── goal                 ← 当前目标（Harness 写入）
│       ├── constraints[]        ← 约束条件
│       ├── assumptions[]        ← 假设
│       ├── knownFacts[]         ← 已知事实
│       ├── unknowns[]           ← 未知项
│       ├── risks[]              ← 风险评估（含 severity）
│       ├── confidence           ← 置信度 0-1
│       └── verificationCriteria[] ← 验收标准（Harness 写入）
│
├── world: WorldLayer            ← 世界层（对外部环境的感知）
│   ├── environment: EnvironmentContext
│   │   ├── cwd                  ← 当前工作目录
│   │   ├── os                   ← 操作系统
│   │   ├── shell                ← Shell 类型
│   │   ├── gitBranch            ← Git 分支
│   │   ├── gitDirty             ← 是否有未提交改动
│   │   └── hasBuildFiles[]      ← 检测到的构建文件
│   └── project?: ProjectContext ← ProjectBrain 填充
│       ├── architecture         ← 架构摘要文本
│       ├── architectureHash     ← 架构哈希（增量注入依据）
│       ├── techStack[]          ← 技术栈
│       ├── framework            ← 框架
│       ├── language             ← 主语言
│       ├── modules[]            ← 模块列表
│       ├── entryPoints[]        ← 入口文件
│       ├── changedFiles[]       ← 最近变更文件
│       ├── changeVersion        ← 变更版本号
│       ├── riskyAreas[]         ← 风险区域
│       └── fullInjectedOnce     ← 是否已全量注入过
│
└── memory?: MemoryLayer         ← 记忆层（经验检索结果）
    └── retrievedExperiences: ExperienceRef[]
        ├── id
        ├── type                 ← 'failure_pattern' | 'successful_workflow' | 'gotcha' | 'environment_fact'
        ├── summary
        └── confidence
```

### 5.2 Context Provider 体系

Provider 是上下文的生产单元，每个 Provider 负责一类信息的注入：

| Provider | Phase | 优先级 | 说明 |
|----------|-------|--------|------|
| `EnvironmentContextProvider` | `before_turn` | 10 | 注入 OS/CWD/Shell/Git 等环境信息 |
| `ProjectBrainContextProvider` | `before_turn` | 20 | 项目架构扫描（带线程隔离+增量注入） |
| `TaskContextProvider` | `before_turn` | 30 | Task Cognition（目标/约束/风险） |
| `ExperienceContextProvider` | `before_turn` | 5 | 检索相关历史经验 |

**Provider 接口定义**（[types.ts](file:///e:/langchain/Suanlizi/packages/context/src/types.ts#L87-L97)）：

```typescript
interface ContextProvider {
  readonly name: string;
  readonly priority: number;     // 数字越小优先级越高
  readonly maxTokens: number;    // 该 Provider 最大 Token 上限
  readonly phase: ContextPhase;  // 执行阶段

  provide(ctx: ProviderContext, signal?: AbortSignal): Promise<ContextProviderResult>;
}
```

**执行阶段（ContextPhase）：**
- `before_turn`：Turn 开始前执行（主要阶段，大部分 Provider 在此阶段）
- `after_tool`：工具调用后执行（用于更新项目状态等）
- `after_turn`：Turn 结束后执行（用于记录经验、更新记忆）

### 5.3 Token 预算与裁切策略

Context Engine 按以下流程工作：

```
1. 按 phase 过滤 Provider
2. 按 priority 升序执行 Provider（priority 小的先执行）
3. 前一个 Provider 的 contextPatch 会影响后一个 Provider 看到的 AgentContext
4. 收集所有 chunks，按 priority 排序
5. 按预算从高优先级到低优先级装填：
   - chunk.tokens ≤ remainingTokens → 完整放入
   - chunk.tokens > remainingTokens 且 remaining > 100 → 截断（附加 ...[truncated]）
   - 否则丢弃
6. 返回 AssembledContext { chunks, updatedAgentContext, usedTokens, remainingTokens }
```

**关键机制：**
- **增量注入**：ProjectBrain 基于 `architectureHash` 判断架构是否变化。首轮全量注入（`mode: 'full'`），后续架构未变化时只注入 delta（如变更文件列表），大幅节省 Token
- **Turn 级缓存**：动态上下文中间件在 `beforeTurn` 阶段调用一次 ContextEngine，将结果缓存。`beforeModel` 阶段（同一 turn 可能触发多次）直接复用缓存，避免重复执行 Provider
- **去重**：通过 `chunk.id` 去重，防止不同 Provider 产生重复内容

### 5.4 ProjectBrain 线程隔离架构（v1.5.0 修复的核心 P1 问题）

ProjectBrain 是最复杂的 Provider，因为它需要扫描整个项目，必须严格处理并发：

```
ProjectBrainContextProvider 内部状态：
├── sharedArchitecture          ← 跨线程共享（架构扫描结果）
│   ├── summary: ArchitectureSummary
│   ├── hash: string            ← 架构指纹
│   ├── lastScannedAt: number
│   └── changeVersion: number
│
├── perThreadCache: Map<ThreadId, ProjectBrainCache>  ← 线程级缓存
│   └── <threadId>:
│       ├── turnCounter         ← 该线程 turn 计数
│       ├── lastInjectedHash    ← 上次注入的架构哈希
│       ├── lastFullInjectionTurn ← 上次全量注入的 turn
│       └── fullInjectedOnce    ← 是否全量注入过
│
└── architectureScanPromise: Promise<void> | null  ← 扫描锁（防并发）
```

**隔离原则：**
- 架构扫描结果（目录结构、模块列表、技术栈）跨线程共享——因为这是项目的客观属性
- 注入状态（hash、turn计数、是否全量注入过）线程私有——每个线程的对话历史不同，需要独立判断何时注入什么
- 使用 `architectureScanPromise` 做 Promise 锁：多个线程同时触发扫描时，只有一个真正执行，其他等待同一个 Promise

### 5.5 Task Cognition 线程安全

TaskContextProvider 维护每个线程的任务认知状态：

```
TaskContextProvider 内部：
└── agentContextByThread: Map<ThreadId, AgentContext>
    └── <threadId>:
        └── cognition.task       ← 该线程的 goal/constraints/verificationCriteria
```

- **构造时只读**：`initialGoal`/`initialConstraints` 不再通过 `updateOptions` 全局共享
- **Harness 同步**：`taskHarness.ts` 在 `setGoal` 后调用 `updateTaskCognition(threadId, { goal, verificationCriteria })`，将 Harness 的目标和验收标准同步到对应线程的 Task Cognition
- **resetThread**：Harness 开始新任务时可以重置线程的认知状态

### 5.6 Experience 经验闭环（v1.5.0 新增）

**经验类型：**

| 类型 | 触发场景 | 记录内容 |
|------|----------|----------|
| `successful_workflow` | Harness 以 satisfied 结束 | taskSummary、steps、attempts |
| `failure_pattern` | 工具报错/Harness blocked | errorMessage、symptoms（自动识别错误模式）、resolutionSteps |
| `gotcha` | 特定陷阱/注意事项 | 手动记录或自动提取 |
| `environment_fact` | 环境发现 | fact、toolNames |

**自动错误分类**（[experienceEngine.ts](file:///e:/langchain/Suanlizi/packages/context/src/experience/experienceEngine.ts#L48-L61)）：
引擎内置 12 种错误模式正则，自动匹配并打标签：
- `MODULE_NOT_FOUND` → `deps`/`npm`
- `EACCES`/`EPERM` → `permissions`
- `ECONNREFUSED` → `network`
- `EADDRINUSE` → `port-conflict`
- `ENOENT` → `path`
- `ETIMEDOUT` → `network`/`timeout`
- `OUT_OF_MEMORY` → `memory`
- `SyntaxError` → `syntax`
- `TypeError` → `types`/`null-check`
- 等等...

**评估门控（Evaluation Gate）：**
不是所有记录都存入经验库，必须通过质量门控：
- 信号强度（signal strength）≥ 阈值
- 信息完整性足够（有解决方案/可复现步骤）
- 去重（避免重复存储相同模式）

**检索注入：**
`before_turn` 阶段，ExperienceContextProvider 根据当前 userInput 和 taskCognition 检索相似经验，注入到 `memory.retrievedExperiences`，帮助 Agent 避免重蹈覆辙。

---

## 六、🎯 Skill 生命周期管理（v1.5.0 新增）

### 6.1 SkillModule 接口

可执行 Skill 可以导出完整的四阶段生命周期钩子：

```typescript
interface SkillModule {
  // 必须：核心执行逻辑
  execute: (params: Record<string, unknown>, ctx: SkillExecutionContext) =>
    Promise<SkillExecutionResult>;

  // 可选：前置准备（检查前置条件、备份文件）
  prepare?: (params: Record<string, unknown>, ctx: SkillExecutionContext) =>
    Promise<SkillPrepareResult>;
  // SkillPrepareResult: { ok: true; backupFiles?: Array<{path; content}> }
  //                     | { ok: false; error: string }

  // 可选：后置验证（检查执行结果是否符合预期）
  verify?: (params: Record<string, unknown>, output: unknown, ctx: SkillExecutionContext) =>
    Promise<SkillVerifyResult>;
  // SkillVerifyResult: { ok: true } | { ok: false; error: string }

  // 可选：回滚（prepare/execute/verify 失败时调用，恢复备份文件）
  rollback?: (
    params: Record<string, unknown>,
    reason: SkillRollbackReason,
    backupFiles?: Array<{path; content}>,
    ctx: SkillExecutionContext
  ) => Promise<void>;
  // SkillRollbackReason: 'prepare_failed' | 'execute_failed' | 'verify_failed' | 'aborted'

  description?: string;
  parameters?: SkillParameter[];
  validateParams?: (params: Record<string, unknown>) => { valid: boolean; errors?: string[] };
}
```

### 6.2 执行流程

```
调用 SkillExecutor.execute(skill, params, ctx)
│
├── 1. 参数校验（validateParams）
│   └── 失败 → { success: false, code: 'SKILL_INVALID_PARAMS' }
│
├── 2. prepare 阶段（如果定义了）
│   ├── 成功 → 保存 backupFiles，prepared = true
│   └── 失败 → 调用 rollback（reason: 'prepare_failed'）
│              → { success: false, code: 'SKILL_PREPARE_FAILED', rolledBack }
│
├── 3. execute 阶段
│   ├── 成功 → 进入 verify
│   ├── 超时 → 调用 rollback（reason: 'aborted'）
│   └── 异常 → 调用 rollback（reason: 'execute_failed'）
│              → { success: false, code: 'SKILL_EXECUTION_ERROR'/'SKILL_TIMEOUT' }
│
├── 4. verify 阶段（如果定义了）
│   ├── 成功 → 返回成功结果
│   └── 失败 → 调用 rollback（reason: 'verify_failed'）
│              → { success: false, code: 'SKILL_VERIFY_FAILED' }
│
└── 5. 返回结果
    {
      success: true,
      prepared: boolean,       // 是否执行了 prepare
      rolledBack: false,       // 是否回滚
      durationMs: number,
      // ... 其他 skill 返回的字段
    }
```

**超时保护：**
- prepare/execute/verify 总超时：`skill.timeoutMs ?? 30000`（30秒）
- rollback 独立超时：10秒（防止回滚本身卡住）
- 超时或 AbortSignal 触发时都会尝试 rollback

---

## 七、环境变量参考

| 变量名 | 说明 | 必填 |
|--------|------|------|
| `FIRECRAWL_API_KEY` | Firecrawl 网页抓取 API Key | 使用 firecrawl 时必填 |
| `FIRECRAWL_BASE_URL` | Firecrawl 自定义 Base URL | 可选 |
| `OPENAI_API_KEY` | OpenAI API Key | 使用 OpenAI 时 |
| `ANTHROPIC_API_KEY` | Anthropic API Key | 使用 Claude 时 |
| `OLLAMA_BASE_URL` | Ollama 服务地址 | 默认 `http://localhost:11434` |

注意：API Key 优先从环境变量读取，也可以通过 UI 设置面板存入项目配置。

---

## 八、配置解析与规范化

所有配置在使用前都会经过 `resolveConfig()` 规范化处理：

1. **路径解析**：`workspaceRoot`、`dataDir`、`skillsRoot` 都通过 `path.resolve()` 转为绝对路径
2. **枚举校验**：所有 enum 类型（webSearchMode、webProvider、reasoningEffort、runProfile、themeMode）如果不在合法值集合内，回退到默认值
3. **布尔强制**：`systemMonitorEnabled` 等布尔字段强制转换为 boolean
4. **Memory 设置规范化**：通过 `normalizeMemorySettings` 和 `normalizeEpisodeMemorySettings` 确保数值在合理范围内
5. **密钥剥离**：`publicRunConfig()` 在返回给前端前移除 `apiKey` 字段

**配置合并顺序：**
```typescript
const effectiveConfig = resolveConfig({
  ...defaultConfig,           // Layer 1
  ...storedDefaultConfig,     // Layer 2
  ...threadConfig,            // Layer 3
  ...requestConfig,           // Layer 4
});
```

---

## 九、快速配置指南

### 场景 1：本地 Ollama + 代码开发（开箱即用）

无需额外配置，默认即可：
- Provider: `ollama`，Model: `qwen2.5-coder:7b`
- 权限: `workspace`（操作需批准）
- Run Profile: `runtime_os`

### 场景 2：使用云端模型（如 GPT-4o）

1. 打开设置面板 → Provider Settings
2. 选择 `openai`，填入 API Key
3. 选择模型 `gpt-4o`
4. 保存为默认配置或保存为 Model Preset

### 场景 3：Harness 自主任务执行

1. 将 Run Profile 切换为 `harness`
2. 在输入框描述目标和验收标准
3. Agent 将自动进入 plan→execute→evaluate→replan 循环
4. 右侧 Run Monitor 可查看 Evidence Ledger 和 Goal Progress
5. 任务结束后，经验自动记录到 Experience Engine

### 场景 4：安装 Skill

1. 将 Skill 放入 `~/.suanlizi/skills/<skill-name>/` 目录
2. 确保包含 `SKILL.md`，可执行 Skill 需包含 `index.ts` 导出 `execute`
3. 重启服务后 Skill 自动加载
4. 或在 UI 设置面板 → Skills 中通过 GitHub URL 一键安装

### 场景 5：添加 MCP 服务器

1. 打开设置面板 → MCP Servers
2. 添加服务器：
   - **stdio 模式**：填写 command（如 `npx`）和 args（如 `["-y", "@modelcontextprotocol/server-filesystem", "/path"]`）
   - **SSE 模式**：填写 url（如 `http://localhost:3000/sse`）
3. 启用后工具自动注册
