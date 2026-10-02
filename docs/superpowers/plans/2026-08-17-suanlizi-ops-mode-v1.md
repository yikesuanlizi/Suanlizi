# Suanlizi 运维模式 V1 实施计划

状态：规划中

日期：2026-08-17

## 1. 目标与边界

Suanlizi 不单独实现一个运维 Agent，而是在统一的 Agent Core、Context Engine、Harness、Memory、Tool Runtime 和 Project Brain 之上增加 `Ops Mode`。

Ops Mode 只注入运维领域能力：

- OpsContext
- OpsHarness
- RuntimeAdapter
- Evidence Layer
- Ops Memory
- Ops Policies
- 运维任务 UI 和可视化视图

Agent 的推理、状态机、工具调度和模型网关仍由 Suanlizi 统一提供。

V1 的主要目标是：在远端只读的前提下，根据运行时信息、日志、代码、Git、部署配置和运维知识，完成一次可审计、可验证的故障定位，并给出本地修改建议或 Patch。

V1 不负责：

- 远端写文件、上传文件、重启服务、部署和自动修复
- 常驻式全量监控
- Kubernetes 和云厂商专用控制面
- 多租户
- 复杂的 Multi-Agent Runtime
- 1M 上下文作为默认运行策略
- 一开始就引入 Elasticsearch/OpenSearch

## 2. 总体架构

```text
Suanlizi
├── Agent Core
├── Context Engine
├── Harness
├── Memory
├── Tool Runtime
├── Project Brain
└── Modes
    ├── Coding
    ├── Research
    ├── RAG
    ├── Browser
    └── Ops
        ├── OpsContext
        ├── OpsHarness
        ├── RuntimeAdapter
        ├── Evidence Layer
        ├── Ops Memory
        └── Ops Policies
```

Ops Mode 不创建新的 Agent Runtime。第一版只在现有模式扩展机制中注册一组 Context Provider、Tool Provider、Policy Provider 和 Memory Namespace。

建议抽象出最小的模式契约：

```ts
type ModeSpec = {
  id: string
  contextProviders: string[]
  toolProviders: string[]
  policies: string[]
  memoryNamespaces: string[]
  taskPresets: string[]
}
```

## 3. Agent 任务模型

不拆成五个独立 Agent。故障定位、代码导航、部署检查、变更建议和 Patch 审查都是同一个 Agent Core 下的 Role、Skill 或 Policy。

```text
Suanlizi Agent
    │
Task Classification
    │
Diagnose / Inspect / Change
    │
Observe → Hypothesize → Investigate → Verify → Conclude
```

建议角色名称：

- `diagnostician`
- `code-navigator`
- `deployment-inspector`
- `change-advisor`
- `patch-reviewer`

Role 只影响任务目标、证据要求、工具白名单和输出格式，不创建新的模型会话和运行时。

## 4. OpsTaskSession

增加任务会话作为运维任务的状态容器。它负责暂停恢复、预算、假设、工具调用、证据和验证状态。

```text
OpsTaskSession
├── goal
├── scope
├── environment
├── currentPhase
├── hypotheses
├── collectedEvidence
├── toolCalls
├── policyDecisions
├── verificationStatus
├── contextBudget
└── finalConclusion
```

每个任务必须有：

- 唯一任务 ID
- 目标项目和环境
- 允许访问的主机、服务和时间范围
- 最大工具调用次数
- 最大输出量和上下文预算
- 超时时间
- 结束条件
- 是否允许生成本地 Patch

Agent Loop 必须有硬性停止条件，禁止无限调查。默认最多三轮主要假设验证，发现冲突证据时暂停并要求重新确认范围。

## 5. OpsContext 与上下文工程

OpsContext 不直接拼接整个项目和全部日志，而是把异构信息组织成带来源和新鲜度的 Context Artifact，再由 Context Compiler 形成本次任务的 Task Context。

```text
OpsContext
├── Project Brain
├── Runtime Snapshot
├── Logs
├── Code
├── Git
├── Deployment
├── Wiki / Obsidian
└── Incident Memory
```

### 5.1 Project Brain

V1 先维护以下信息：

- 项目结构和模块摘要
- 入口、路由和主要调用关系
- 语言、框架和依赖
- 配置项与环境变量引用
- Docker Compose 服务关系
- 服务、日志和代码目录的映射
- Git 分支、提交和变更摘要
- 测试入口和测试状态

Runtime Graph 和 Deployment Graph 先从 Compose、容器名称、端口、依赖和观测结果推导，不在第一版实现复杂的全量图数据库。

### 5.2 分层摘要

项目接入时生成以下摘要层，不直接写入模型上下文：

- L0：仓库元数据、提交、语言、文件数量
- L1：目录和模块摘要
- L2：文件、类、函数、路由和配置摘要
- L3：当前任务涉及的调用链、日志窗口和部署关系

摘要必须记录文件路径、行号、Git 提交或文件哈希，并在文件变化后增量失效。

### 5.3 Runtime Snapshot

Runtime Snapshot 分为基础快照和目标快照。

基础快照：

- 主机系统、CPU、内存、磁盘
- 进程和容器列表
- 服务状态
- 网络基本状态
- Git 状态
- 部署元数据

目标快照：

- 指定服务的日志
- 指定时间范围
- Trace ID 或 Request ID
- 指定配置
- 指定依赖服务状态

基础快照只采集便宜且稳定的信息；只有确定目标后，才查询大量日志和配置。每个快照必须带 `observedAt`、`expiresAt` 和环境标识，防止模型使用过期运行态。

## 6. Evidence Layer

Evidence 是运维模式的正式数据对象，不只是给模型看的文本。

```ts
type Evidence = {
  id: string
  kind: "log" | "code" | "git" | "runtime" | "config" | "wiki"
  source: string
  scope?: string
  observedAt: string
  expiresAt?: string
  content: string
  location?: string
  command?: string
  contentHash?: string
  sensitivity: "public" | "internal" | "secret-redacted"
  parentIds?: string[]
}
```

要求：

- 每个工具输出都转换为 Evidence 或 Evidence 集合
- 每条 Evidence 包含来源、时间、范围和新鲜度
- 代码 Evidence 包含文件和行号
- 日志 Evidence 包含主机、服务、时间窗口和请求标识
- 配置 Evidence 必须脱敏
- 重要结论必须引用 Evidence ID
- 模型不能在没有证据的情况下输出确定性根因
- 置信度结合证据覆盖率、来源一致性、新鲜度和验证结果计算

推荐的结论结构：

```text
Root Cause
Evidence
Confidence
Assumptions
Risk
Verification
```

## 7. RuntimeAdapter

Agent 不直接理解 SSH，也不直接拼接任意 Shell。第一版使用 SSH 实现 `RuntimeAdapter`，但上层只看到类型化的只读能力。

```ts
interface RuntimeAdapter {
  getHostInfo(): Promise<Evidence[]>
  listProcesses(): Promise<Evidence[]>
  listContainers(): Promise<Evidence[]>
  getContainerLogs(query: LogQuery): Promise<Evidence[]>
  getServiceStatus(name: string): Promise<Evidence[]>
  getJournalLogs(query: JournalQuery): Promise<Evidence[]>
  getNetworkStatus(): Promise<Evidence[]>
  getGitStatus(path: string): Promise<Evidence[]>
}
```

以后可增加：

- LocalAdapter
- DockerAdapter
- KubernetesAdapter
- CloudVMAdapter

所有 Adapter 方法必须统一返回：结构化结果、Evidence、执行耗时、超时状态、脱敏状态和审计信息。

## 8. OpsHarness 与安全策略

Harness 负责硬约束、风险、证据和验证，不依赖 Prompt 自觉。

### 8.1 能力权限

```text
remote.read.host       ALLOW
remote.read.process    ALLOW
remote.read.container  ALLOW
remote.read.logs       ALLOW
remote.read.git        ALLOW
remote.read.config     ALLOW
local.write.patch      ALLOW
local.run.test         ASK
remote.write.*         DENY
remote.restart.*       DENY
remote.upload.*        DENY
remote.deploy.*        DENY
```

### 8.2 不可绕过的策略

- 默认远程只读
- 禁止任意 Shell 拼接
- 禁止 SSH 写文件和上传文件
- 禁止远程重启和部署
- 禁止把密钥、Token、密码写入 Evidence
- 所有外部输入按不可信内容处理
- 工具调用有超时、输出上限、调用次数和并发限制
- 重要结论必须引用证据
- 存在冲突证据时不得直接给出确定根因
- 本地 Patch 生成后必须进入用户审查状态

## 9. 日志、Wiki 和 Memory

### 9.1 Wiki / Obsidian

Obsidian Markdown 是第一版的人类维护入口，不新增复杂知识库后台。

建议目录：

```text
/ops
├── runbooks
├── architecture
├── incidents
└── projects
```

Markdown 进入 `OpsWikiProvider`，经过解析、分块、元数据提取和向量索引后，作为 Context Provider 被使用。

### 9.2 日志

日志不做全量 Embedding。

优先通过以下条件查询：

- 时间范围
- 服务
- 主机
- 日志级别
- 错误关键词
- Trace ID
- Request ID
- 容器或进程

V1 使用 SQLite/FTS 保存索引，向量库只负责 Wiki、架构说明、项目摘要和历史事故的语义检索。日志量显著增加后再增加 OpenSearch/Elasticsearch Provider。

### 9.3 Incident Memory

运维 Memory 主要保存事故，而不是完整聊天记录。

```text
Incident
├── Problem
├── Environment
├── Symptoms
├── Evidence
├── Root Cause
├── Fix
├── Verification
├── Result
└── RedactionMetadata
```

事故进入长期 Memory 前需要脱敏、去重和用户确认。当前事故检索历史事故时，先使用环境、服务、错误类型和时间等结构化条件，再使用语义检索。

## 10. Agent Loop

```text
Observe
  ↓
Hypothesize
  ↓
Investigate
  ↓
Verify
  ↓
Conclude
```

典型 502 流程：

```text
发现 502
→ 查询 Nginx 和网关状态
→ 检查后端容器是否退出
→ 查询后端错误日志
→ 检查数据库或 Redis 连接
→ 定位代码或配置
→ 验证假设
→ 输出根因、证据、风险和建议
```

每次调查都记录假设和被否定的假设，避免重复查询和循环调用。

## 11. 右侧任务控制台 UI

右侧栏统一命名为 `Task Inspector`，集中展示预设、作用域、约束、预算和输出要求。主区域展示聊天、任务时间线和证据结果。

### 11.1 右侧栏结构

```text
Task Inspector
├── Task Preset
├── Environment / Risk
├── Scope
├── Permission Constraints
├── Evidence & Verification
├── Resource Budget
├── Output Format
└── Task Actions
```

顶部常驻显示：

- 当前环境：本地、测试、生产
- 当前权限：远程只读
- 当前风险等级：低、中、高
- 当前任务状态：准备、运行、等待确认、完成、失败

### 11.2 任务预设

V1 预设：

1. 故障诊断
2. 日志分析
3. 运行态巡检
4. 部署检查
5. 代码定位
6. 变更建议
7. 本地 Patch
8. 验证回归
9. 事故复盘
10. 架构可视化

预设只是默认配置，不是新的 Agent。选择预设后允许编辑目标项目、主机、服务、时间范围和输出格式。

### 11.3 可调整约束

- 目标项目、环境、主机、服务
- 日志时间范围
- 最大工具调用次数
- 最大日志行数
- 上下文预算
- 任务超时
- 最少证据数量
- 置信度阈值
- 是否允许生成本地 Patch
- 是否允许运行本地测试
- 是否保存为 Incident

远程写入、远程重启、远程上传、远程部署等约束应以锁定状态展示，不能在普通任务表单中切换。

### 11.4 主区域可视化

- 任务阶段时间线
- Evidence 证据链
- 根因因果链
- 运行时服务拓扑
- 日志时间线
- 代码错误栈和调用链
- 正常/异常快照对比
- Patch Diff
- 假设验证矩阵
- Incident 报告

工具调用只展示在右侧运行轨迹或事件面板，不重复把用户消息放入工具轨迹。

## 12. 模型与上下文策略

模型通过 `ModelProvider` 抽象接入，不把 Ops Mode 绑定到某个模型。

第一版模型目标：Qwen3-VL 8B/9B 级别或兼容的本地多模态模型。

运行策略：

- 默认上下文 32K
- 需要时提升到 64K 或 128K
- 通过项目摘要、代码图、检索、快照和 Evidence 实现逻辑长上下文
- 图片、截图、监控面板只在任务需要时发送给视觉模型
- Embedding 使用独立模型，不占用主模型上下文
- 模型负责假设、排序、解释和建议
- 规则系统负责权限、参数校验、预算和验证流程

不把 1M 上下文作为 V1 的设计前提。大上下文能力不能替代检索、摘要和证据选择。

## 13. 仓库代码落点

按现有 Suanlizi 分层实现，不把 Ops 逻辑塞入单个入口文件：

- `packages/protocol/src/`：OpsTaskSession、Evidence、RuntimeSnapshot、Policy、Preset 的共享类型和 schema
- `packages/runtime/src/`：Ops 任务状态机、Loop、checkpoint、预算和验证编排
- `packages/tools/src/`：只读 RuntimeAdapter 工具、Evidence 转换和工具注册
- `packages/storage/src/`：任务、Evidence、快照和 Incident 的 SQLite/JSONL 持久化
- `packages/model-gateway/src/`：模型能力声明、视觉输入和上下文预算适配
- `apps/api/src/`：Ops 任务 API、Preset 管理、任务状态和 Evidence 查询
- `apps/web/src/`：Task Inspector、任务时间线、证据视图和运维可视化
- `docs/`：架构决策、计划、Runbook 和验收记录

前端不在 `main.tsx` 堆积任务表单、类型和协议转换；右侧边栏应拆成可复用组件，任务状态转换放到纯前端状态模块。

## 14. 分阶段实施计划

### P0：契约和安全基础

- 定义 ModeSpec
- 定义 OpsTaskSession
- 定义 Evidence、RuntimeSnapshot、Incident、Policy schema
- 定义远程只读能力和工具权限
- 增加任务预算、超时和审计记录
- 建立四个脱敏的回放 Fixture

完成标准：不接真实服务器，也能创建任务、执行模拟工具、生成 Evidence 并完成状态流转。

### P1：只读运行时和任务上下文

- 实现 SSH RuntimeAdapter 的主机、进程、容器、日志、服务和 Git 查询
- 实现基础 Runtime Snapshot
- 实现 Evidence 脱敏、哈希、新鲜度和来源
- 实现按时间、服务、级别和关键词查询日志
- 实现项目结构和代码摘要

完成标准：给定一个本地 Fixture，可以从运行态、日志和代码组成一个可追溯 Task Context。

### P2：右侧任务控制台和可视化

- 实现 Task Inspector
- 实现任务预设
- 实现作用域、权限、预算和输出约束
- 实现任务时间线
- 实现 Evidence 证据链
- 实现日志时间线和快照对比
- 实现 Patch Diff 展示

完成标准：用户可以配置一个只读诊断任务，看到每次工具调用、证据和验证状态。

### P3：模型与项目知识

- 接入 ModelProvider
- 接入多模态输入
- 实现 Markdown/Obsidian Provider
- 实现 SQLite/FTS 和向量检索 Provider
- 实现项目摘要增量更新
- 实现证据引用格式和不确定性输出

完成标准：模型不能只输出答案，必须输出假设、Evidence、Confidence、风险和验证建议。

### P4：事故记忆和本地 Patch

- 实现 Incident Memory
- 实现历史事故检索
- 实现本地 Patch 生成
- 实现本地测试申请和用户确认
- 实现 Patch 影响范围和验证报告

完成标准：远端保持只读，本地可以生成可审查 Patch，并能记录验证结果。

### P5：可选扩展

- Docker 专用 Adapter
- Kubernetes Adapter
- OpenSearch/Elasticsearch 日志 Provider
- 运行时和部署拓扑增强
- 外部模型 fallback
- 更复杂的监控窗口和告警接入

## 15. 验收场景

至少准备以下可回放任务：

1. Nginx 502，后端容器退出
2. Python Traceback，定位到文件和函数
3. Docker 容器启动失败，定位环境变量或依赖问题
4. 配置修改后服务行为异常，比较前后快照
5. 生成本地 Patch，远端不发生任何写操作

验收指标：

- 重要结论是否都有 Evidence 引用
- 是否能区分事实、假设和推断
- 是否能在证据不足时拒绝下结论
- 是否能在限定工具预算内结束
- 是否能阻止所有远程写操作
- 相同 Fixture 是否能重放得到相近结果
- 上下文是否明显小于整个项目和全部日志
- 用户能否清楚看到任务状态和下一步验证动作

## 16. 需要后续确认的决策

- 第一批支持的 Linux 发行版和 Docker 版本
- SSH 凭据来源、过期时间和脱敏策略
- 本地 Patch 是否自动写入工作区，还是只导出 Diff
- 本地测试是否需要逐次确认
- SQLite 和向量 Provider 的具体实现
- 代码摘要使用的解析器和支持语言范围
- 事故数据的保留周期
- 是否允许外网模型 fallback
- 视觉任务首先支持截图、监控面板还是部署拓扑图

## 17. 与 FreeAiOps 的关系

FreeAiOps 可以作为后台认证、通用 CRUD 和基础管理接口的参考，但不作为 Ops Mode 核心。Suanlizi 现有的 TypeScript 分层、Agent Runtime、前端工作台、协议和存储边界应作为实现基础。

## 18. V1 完成定义

当以下条件同时满足时，视为 Ops Mode V1 完成：

- 用户可以从右侧 Task Inspector 创建一个运维任务
- 任务只调用显式允许的只读 RuntimeAdapter 能力
- 所有观察结果都转化为可追溯 Evidence
- Agent 能执行 Observe → Hypothesize → Investigate → Verify → Conclude
- 结论包含 Evidence、Confidence、Assumptions、Risk 和 Verification
- UI 能展示任务时间线、证据链、运行快照和验证结果
- 本地 Patch 需要用户审查，远端永远不写入
- Incident 可以经过脱敏后保存并再次检索
- 四个以上脱敏故障 Fixture 通过回放验收

