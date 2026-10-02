# Suanlizi 运维模式 V1.2 实施方案

状态：可实施草案（个人多知识库链路已落地，P0 仍需完成完整审计闭环）

> **最终知识库边界（覆盖本文早期租户/工作区表述）**
>
> Suanlizi 是单用户个人知识库系统。知识库主链路固定为：
> `个人知识库名称 → 用户通过原生目录选择器授权的 canonical 来源目录 → 不可变 Snapshot → 查询 Receipt → 对话/Ops 任务显式选择的 knowledgeBaseIds`。
> 项目、workspace、workspaceRoot、tenantId 和 `scope: workspace|ops` 不决定知识库归属、列表、筛选或默认选择；旧字段只能作为存储迁移兼容元数据保留。没有用户明确选择的知识库时，不创建默认库、不使用当前项目目录、不允许 Ops 进入 queued。

日期：2026-08-19

本文是 `2026-08-17-suanlizi-ops-mode-v1.md` 的收敛版本。原文件保留为愿景和讨论记录，本文件作为后续实现依据。V1.2 将知识库快照作为 Ops 的硬前置：没有可用、已授权且不可变的知识库快照，任务不得进入 `queued`。

## 1. 目标

在现有 Suanlizi Agent Runtime 上增加一个 `Ops Mode`，让 Agent 能够在知识库依据和显式作用域约束下，对本地或授权远程环境执行一次性、可暂停、可恢复、可审计的运维诊断。

V1 的核心结果不是“自动修复”，而是：

1. 在明确的主机、服务、工作区和时间范围内，绑定至少一个 `ready` 的不可变知识库快照后采集只读运行信息。
2. 将知识库命中和运行时结果转换为带来源、时间、快照、脱敏和信任状态的 Evidence。
3. 通过 Observe → Retrieve → Hypothesize → Investigate → Verify → Conclude 完成诊断。
4. 输出事实、假设、证据、知识依据、风险和下一步验证动作；检索分数不是置信度。
5. 远端永远不写入；本地 Patch 必须经过用户审查；模型不能扩大知识库或运行环境范围。

## 2. V1 边界

### 2.1 包含

- ReplayAdapter：脱敏 Fixture 回放，作为开发和验收的第一运行环境。
- LocalAdapter：当前工作区、当前机器和本地容器的只读查询。
- SshAdapter：经过安全配置后访问授权远程主机的只读能力。
- 一个统一的 Ops 任务入口：持续进行运维诊断，并按证据自动穿插日志分析、运行时检查和知识库检索；日志分析不是第二种用户模式。
- 任务状态机、预算、取消、暂停、恢复和 SSE 事件重放。
- KnowledgeBase/Wiki 作用域选择、服务端快照解析、索引、词法检索、查询收据和引用边界。
- Evidence 索引、脱敏、过期、信任标记和知识引用。
- 任务时间线、证据列表、验证状态和结论视图。
- 本地 Patch 提案、Diff 审查和用户确认后的写入。

### 2.2 不包含

- 远端写文件、上传、重启、部署和自动修复。
- 常驻监控、告警接入和自动触发任务。
- Kubernetes、云厂商专用控制面和复杂拓扑数据库。
- 多租户权限体系。
- 一开始就引入 OpenSearch/Elasticsearch。
- 以 1M 上下文作为默认策略。
- 多个并行 Agent 互相调度。
- 没有知识库快照的无依据 Ops 诊断。
- 把普通 memory、整个工作区或整个 Wiki 全量注入模型上下文。

## 3. 设计原则

1. **复用现有运行时。** 不创建第二套 Agent Loop、Harness、Trace 或权限系统。
2. **默认拒绝。** 目标、环境、主机、服务和时间范围缺失时，不执行远程能力。
3. **证据先于结论。** 模型可以提出假设，但不能把没有 Evidence 支持的假设写成根因。
4. **远程只读硬隔离。** 远程能力由类型化 Adapter 提供，不暴露任意 Shell。
5. **状态可重放。** 任务状态和事件必须能在断线、进程重启后恢复。
6. **不可信输入隔离。** 日志、Wiki、远程输出、配置和代码都不能改变系统策略。
7. **本地变更可审查。** Patch 先生成提案，再由用户确认写入独立 worktree 或当前工作区。
8. **知识依据先绑定。** 每个任务在 `draft → queued` 前必须固定至少一个 `ready` 的 immutable snapshot；同步不会改变运行中或历史任务引用的快照。
9. **本地优先、可解释检索。** 知识库只采用 SQLite FTS/词法检索，不引入向量数据库、embedding 或语义 reranker。模型推理由 Model Gateway/Provider 单独负责，不参与知识库索引。

## 4. 与现有 Suanlizi 的关系

Ops Mode 是现有模式扩展，不是独立产品。

```text
AgentLoop / TaskHarnessEngine
        │
        ├── RunTraceStore        事实事件源
        ├── EvidenceLedger       证据收据索引
        ├── AccessPolicy         权限判定
        ├── ToolRegistry         工具注册和输出限制
        ├── KnowledgeCatalog     知识库、来源、快照目录和作用域
        ├── KnowledgeIndexer     本地/Wiki/Incident 增量索引
        ├── KnowledgeRetriever   SQLite FTS/词法检索和 QueryReceipt
        └── Ops Mode             预设、Adapter、Context 和运维 UI
```

现有对象的职责：

- `TaskHarnessEngine`：负责目标、循环、预算和 Ready/Verify；P0 补齐显式 pause/resume/cancel 状态迁移。
- `EvidenceLedger`：负责从 ThreadItem/RunTrace 建立证据收据，不复制完整历史。
- `RunTraceStore`：负责任务事件的追加和分页；Ops SSE 游标重放是 P0 新增的 API 能力，不假定现有端点已经支持。
- `AccessPolicy`：负责本地和远程能力的最终 allow/prompt/deny 判定。
- `ThreadStore`：负责线程和任务关联的持久化。
- `KnowledgeCatalog`：负责单用户个人 KnowledgeBase、Source、Document、Snapshot 的目录和不可变引用；与 `ThreadStore` 共享 SQLite 仅为存储复用，不继承 tenant、项目或当前工作区身份。
- `KnowledgeIndexer`：复用 `read_document` 的文件指纹、`extractorVersion` 和 freshness 语义，只写入带版本的 SQLite FTS 索引。
- `KnowledgeRetriever`：按任务 `knowledgeScope` 查询，输出去重、脱敏、信任过滤后的命中和可重放 `KnowledgeQueryReceipt`。
- Ops 专属代码只增加预设、Runtime Adapter、Knowledge Adapter、Evidence 规范化、Context Compiler 和 UI 投影，不把知识库塞进 `RuntimeAdapter`，也不创建第二套权限系统。

### 4.1 ModeSpec

不要使用无法校验的字符串数组，采用版本化、类型化契约：

```ts
type ModeSpec = {
  id: 'ops';
  version: 1;
  contextProviders: Array<{ id: string; version: string }>;
  toolProviders: Array<{ id: string; version: string }>;
  policyProfile: 'ops_readonly';
  memoryNamespace: string;
  taskPresets: readonly ['ops'];
};
```

Policy profile 只能收紧权限，不能覆盖全局硬拒绝规则。

### 4.2 现状差距

以下能力在当前代码中不是现成能力，必须列入 P0，不能在计划中当作已有基础设施：

- `TaskHarnessEngine` 需要补充可持久化的 pause/resume/cancel 语义和状态迁移校验。
- `RunTraceStore` 有事件序号和分页基础，但 Ops API 的 SSE `afterSequence`/`Last-Event-ID` 重放、断线去重尚未完成。
- Ops API 的 `Idempotency-Key` 需要新增任务创建和动作请求的幂等记录；可以参考 sidecar 的实现思路，但不能假设 sidecar 能直接复用。
- 项目目前没有通用 secret detector/redaction pipeline；P0 必须先确定并实现最小脱敏组件。
- 项目当前没有 `KnowledgeBase`、`KnowledgeCatalog`、Wiki 接入、知识快照解析或查询收据实现；现有 Ops 只能算没有知识依据的本地/回放原型。
- `read_document` 已有文件指纹、提取器版本和 freshness 可复用语义，但尚未形成 KnowledgeDocument/Snapshot/Chunk 目录；必须在 Ops P0 release gate 建成最小知识闭环。
- 当前 `EvidenceLedger`/`RunTraceStore` 没有知识 Evidence 的快照引用和 semantic role 字段；需要扩展投影契约，不能用普通 memory 或临时文本替代。

P0 完成标准中的“暂停、回放、幂等和脱敏”均以这些新增实现和测试为准。

### 4.3 Ops 激活与生命周期

Ops 采用“主动进入 + 被动建议”的混合激活方式，不能让模型静默切换到远程能力。

1. **主动入口。** 用户可以从线程模式选择器、Ops 任务预设或运行监控中的“创建诊断任务”进入 Ops。正式创建任务前必须选择预设、环境、主机或工作区范围、时间范围以及一个或多个个人知识库；服务端只校验并固定用户提交的 ready Snapshot，不在 Composer 中放知识库选择器。
2. **建议入口。** 普通聊天中识别到“查看服务状态、分析日志、排查故障”等运维意图时，只显示“建议切换到 Ops”的操作，不自动连接主机、不自动读取远程日志，也不改变当前权限。
3. **上下文入口。** 用户可以从文件、运行错误、监控事件或历史 Incident 发起 Ops 任务；这些入口只预填范围和证据引用，仍需用户确认任务范围后才执行。

激活规则：

- 普通聊天、自动分类和模型提示都不能授予远程权限。
- 生产环境、远程环境和任何需要网络连接的任务，在创建任务时必须显式确认环境、主机和时间范围。
- 每个任务必须绑定用户明确选择的一个或多个个人 KnowledgeBase，并在排队前校验并固定 `ready` 的 immutable `snapshotIds`；没有选择、快照未就绪、freshness 不满足或原 Snapshot 撤权时，稳定地进入 `blocked`，分别使用 `OPS_KNOWLEDGE_REQUIRED`、`OPS_KNOWLEDGE_NOT_READY`、`OPS_KNOWLEDGE_SNAPSHOT_STALE/EXPIRED` 或 `OPS_KNOWLEDGE_SNAPSHOT_REVOKED`。工作区只表示诊断目标，不是知识库身份或范围。
- KnowledgeBase 不是普通 memory，也不是 workspace 文件树；任务只使用用户显式选择的个人知识库 `knowledgeScope` 中固定的快照和检索命中，不能把全库或项目文件自动注入模型。
- `mode` 表示线程当前的交互入口，`taskPreset` 只表示统一的 Ops 任务，`runProfile` 继续只表示运行策略（当前的 `cache_first` 或 `runtime_os`），三者不能互相替代。日志优先、运行时优先等顺序由协调器根据入口证据和当前 Evidence 自动决定，不暴露为用户模式。
- 推荐的数据关系为：`Thread.mode: 'chat' | 'ops'`、`OpsTask.taskPreset: 'ops'`，并在 `OpsTaskSpec` 中保存本次任务的完整作用域。切换 `mode` 不等于创建任务，也不等于放宽权限；从日志入口进入只影响初始查询顺序，不改变任务类型。
- 同一线程同一时间最多一个活动 Ops 任务；任务拥有独立 `taskId` 和 `runId`，普通聊天消息不能复用或覆盖 Ops checkpoint。
- Ops 任务完成、取消或失败后，线程可以回到普通聊天；任务时间线和证据仍保留在历史中，不得因为回到聊天而删除或失效。
- 隐藏右侧栏只隐藏 Task Inspector，不暂停、取消、断开或销毁任务。应用冷启动后恢复未完成任务的状态、checkpoint、事件游标和最近一次作用域，并明确标记任务是由用户创建还是由上下文入口创建。
- 只有显式的暂停、恢复、取消和确认动作能改变任务状态；模型不能通过自然语言或工具输出伪造这些状态迁移。

因此，Ops 不是“只能主动开启”，也不是“模型自动接管”：用户负责开启模式、授权个人来源目录、选择知识库和诊断范围，系统负责提出建议、校验并固定快照，模型只能在已授权任务作用域和固定知识快照内工作。即使用户主动开启，没有明确选库或没有 `ready` 快照也只能进入 `blocked`，不能进入 `queued`。

### 4.4 模型部署边界

知识库检索不依赖 embedding 模型；本项目明确不部署向量模型，也不维护向量索引。Ops 所需的推理模型属于独立的 Model Gateway/Provider 能力：

- 支持已配置的 OpenAI-compatible、Anthropic-like 或本地推理服务；模型地址、鉴权引用、上下文上限和健康状态由 Provider 配置管理。
- 模型部署、启动、停止和升级不由 KnowledgeCatalog 或 Ops 任务静默触发。只有用户在 Provider/模型设置中显式配置后，Ops 才能使用该模型。
- 模型不可用时，任务应返回稳定的模型配置/服务错误并保持可审计状态；不能退化为绕过知识库或权限的“无依据模式”。
- Model Gateway 只接收固定 Snapshot 检索产生的脱敏、不可信上下文；模型输出不能改变权限、任务范围、状态迁移或知识库绑定。

## 5. 任务模型

### 5.1 状态

```text
draft → queued | blocked | cancelled
queued → running | blocked | cancelled | failed
running → paused | waiting_confirmation | verifying | blocked | cancelled | failed
paused → running | cancelled | failed
blocked → queued | cancelled | failed
waiting_confirmation → verifying | running | cancelled | failed
verifying → completed | running | waiting_confirmation | blocked | cancelled | failed
```

迁移语义必须固定，并区分用户控制和受信任协调器：

- **用户控制的迁移：** `draft/blocked → cancelled`、`queued → cancelled`、`running → paused/cancelled`、`paused → running/cancelled`、`waiting_confirmation → verifying/running/cancelled`，以及 blocked 任务对原 Snapshot 的 `reauthorize_snapshot`。这些迁移只能由经过身份校验的任务所有者或被授权操作者通过 action API 发起；模型输出不能代替用户动作。
- **受信任协调器的迁移：** `draft → queued/blocked`、`queued → running/blocked/failed`、`running → verifying/blocked/failed`、`verifying → completed/running/waiting_confirmation/blocked/failed`、`blocked → failed`（仅持久化/调度故障）。协调器必须执行同一份状态机、预算、AccessPolicy 和知识授权检查，不能接受客户端直接写状态。
- `draft → queued`：服务端原子解析请求的知识范围，校验作用域、预设和预算，并固定至少一个 `ready` Snapshot manifest；缺少范围、权限或知识条件时持久化为 `blocked`，附稳定错误码。`draft` 或从未进入 `queued` 的 `blocked` 任务才允许首次解析。
- `blocked → queued`：若任务从未进入 `queued`，用户补齐范围后可首次解析；若任务已经 `queued/running` 后因撤权或过期进入 `blocked`，只能通过 `reauthorize_snapshot` 重新授权原 `resolvedSnapshotIds` 后排队，不能重新解析或替换 Snapshot。需要新 Snapshot 必须通过 retry 创建新 `taskId`，旧 blocked 任务保留阻塞事实。
- `running → paused`：显式暂停并保存 checkpoint；`paused → running`：恢复同一个 checkpoint，不重复执行已确认完成的 Adapter 调用。
- `running → waiting_confirmation`：需要用户确认 Patch、扩大运行范围或执行本地测试；确认后由协调器进入 `verifying`，拒绝但继续调查则回到 `running`，拒绝并终止则由用户进入 `cancelled`。
- `running/verifying → blocked`：发现缺少输入、权限、原 Snapshot 授权或 freshness 条件；任务必须停止取数并保留阻塞原因。撤权/过期只允许“重新授权原 Snapshot”或“retry/new task 绑定新 Snapshot”两条恢复路径。
- `verifying → running`：验证失败但仍有可调查路径；`verifying → waiting_confirmation`：下一步需要人工决策。
- `completed`、`cancelled`、`failed` 是终态，不允许原地恢复；因撤权/过期而 `blocked` 的任务也不能在原地绑定新 Snapshot。`retry` 总是创建新的 `taskId`（允许来源为终态或 blocked），通过 `parentTaskId` 引用旧任务和可复用的 Evidence；旧任务保持结案或阻塞事实。

每次迁移都写入事件，包含 `taskVersion` 和递增 `sequence`。并发更新使用乐观锁；同一线程同一时间只允许一个活动 Ops 任务。非法迁移必须返回稳定错误码，不得静默忽略：

| 错误码 | 含义 |
| --- | --- |
| `OPS_TASK_NOT_FOUND` | 任务不存在或不属于当前 workspace |
| `OPS_INVALID_TRANSITION` | 当前状态不允许目标迁移 |
| `OPS_TERMINAL_STATE` | 终态任务不能继续操作；请创建重试任务 |
| `OPS_VERSION_CONFLICT` | `taskVersion` 过期，需要重新读取任务 |
| `OPS_SCOPE_REQUIRED` | 缺少或变更了环境、主机、服务、路径或时间范围 |
| `OPS_CONFIRMATION_REQUIRED` | 当前动作必须由用户显式确认 |
| `OPS_IDEMPOTENCY_CONFLICT` | 相同幂等键对应了不同请求体 |
| `OPS_ACTIVE_TASK_EXISTS` | 同一线程已有活动 Ops 任务 |
| `OPS_KNOWLEDGE_REQUIRED` | 任务没有选择任何 KnowledgeBase 或 snapshot |
| `OPS_KNOWLEDGE_NOT_READY` | 选择的知识库没有可用的 `ready` immutable snapshot |
| `OPS_KNOWLEDGE_SNAPSHOT_STALE` | Snapshot 仍可读但不满足 strict freshness policy |
| `OPS_KNOWLEDGE_SNAPSHOT_EXPIRED` | Snapshot 已超过允许的 freshness 窗口 |
| `OPS_KNOWLEDGE_SNAPSHOT_REVOKED` | 原 Snapshot 的当前授权已撤销，必须重新授权或 retry |
| `OPS_KNOWLEDGE_SCOPE_DENIED` | 知识库、来源或快照不在当前个人目录/任务固定作用域 |
| `OPS_TASK_ACTOR_DENIED` | 当前 actor 无权创建、读取或操作该任务 |

### 5.2 OpsTaskSpec

```ts
type OpsTaskSpec = {
  taskId: string;
  tenantId: string;
  workspaceId: string;
  threadId: string;
  parentTaskId?: string;
  createdBy: string;
  presetId: 'ops';
  workspaceRoot: string;
  environmentId: string;
  target: {
    hostIds: string[];
    serviceNames?: string[];
    containerNames?: string[];
    timeRange?: { from: string; to: string };
  };
  knowledgeScope: {
    knowledgeBaseIds: string[];
    sourceIds?: string[];
    filters?: {
      kinds?: Array<'workspace_docs' | 'wiki' | 'incident'>;
      paths?: string[];
      providers?: string[];
      updatedAfter?: string;
    };
    snapshotPolicy: {
      readiness: 'require_ready';
      freshness: 'strict' | 'warn' | 'allow_stale';
      maxAgeMs: number;
    };
    resolvedSnapshotIds: string[];
    resolutionReceiptId?: string;
    resolutionVersion?: string;
    maxHits: number;
    maxContextTokens: number;
  };
  policyProfile: 'ops_readonly';
  budgets: {
    maxAdapterCalls: number;
    maxConcurrentCalls: number;
    maxOutputBytes: number;
    maxInputTokens?: number;
    maxWallTimeMs: number;
  };
  acceptanceCriteria: string[];
  allowLocalPatchProposal: boolean;
  allowLocalTest: boolean;
};
```

`environmentId` 必须来自已保存的环境连接配置，不能由模型或普通文本临时伪造。生产环境默认需要用户确认任务范围。

创建请求必须由 UI 提交 `knowledgeBaseIds`（以及可选的固定 `snapshotIds`）；服务端在 `draft → queued` 前校验个人目录中这些 ID 的来源授权和 ready 快照，原子写入 `resolutionReceiptId` 和完整 `OpsTaskSpec`。模型、Adapter 和普通聊天文本都不能追加 KnowledgeBase、Source 或 Snapshot。

`resolvedSnapshotIds` 一旦任务首次进入 `queued` 就是不可替换的事实字段。后续同步、撤权或 freshness 变化不得重新解析覆盖它：从未排队的 `draft/blocked` 才能首次解析；已运行任务阻塞后只能重新授权这些原 Snapshot，或者通过 retry/new task 绑定新 Snapshot。`resolutionReceiptId` 记录候选、排除原因、policy、actor 和时间，便于冷启动重放。

### 5.3 KnowledgeBase 契约

KnowledgeBase 是单用户个人、独立于工作区的知识集合，不是普通 memory，也不是把整个库直接拼接进上下文。KnowledgeBase、Source、Snapshot 和 Receipt 的旧 `tenantId` 字段仅用于迁移兼容，不参与归属或筛选；Ops Task 另带诊断目标的 `workspaceId/workspaceRoot`。服务端查询只接受任务显式提交的 knowledgeBaseIds/snapshotIds，不能靠“当前线程”、当前项目或数组顺序替代知识库选择。知识源的 canonical `sourceRoot` 只能来自用户原生目录授权，不构成工作区绑定。凭据只保存 `credentialRef`，绝不保存密钥正文。

```ts
type KnowledgeBase = {
  knowledgeBaseId: string;
  tenantId: string;
  scope: 'ops';
  name: string;
  description?: string;
  status: 'active' | 'syncing' | 'blocked' | 'deleted';
  sourceIds: string[];
  currentSnapshotId?: string;
  createdAt: string;
  updatedAt: string;
  version: number;
};

type KnowledgeSource = {
  sourceId: string;
  tenantId: string;
  knowledgeBaseId: string;
  kind: 'workspace_docs' | 'wiki' | 'incident';
  name: string;
  scope: { sourceRoot?: string; pathPrefix?: string; incidentIds?: string[] };
  sync: { status: 'idle' | 'queued' | 'syncing' | 'ready' | 'failed' | 'revoked'; cursor?: string; lastError?: string; leaseId?: string };
  adapterId: string;
  provider?: string;
  space?: string;
  page?: string;
  path?: string;
  revision?: string;
  sourceUpdatedAt?: string;
  credentialRef?: string;
  createdAt: string;
  recordUpdatedAt: string;
};

type KnowledgeDocument = {
  documentId: string;
  tenantId: string;
  sourceId: string;
  externalId?: string;
  title: string;
  path?: string;
  url?: string;
  revision?: string;
  sourceUpdatedAt?: string;
  recordUpdatedAt: string;
  contentHash: string;
  byteLength: number;
  encoding: string;
  extractorVersion: string;
  freshness: 'fresh' | 'stale' | 'expired' | 'deleted';
  trust: 'untrusted';
  riskFlags: Array<'prompt_injection' | 'secret_like' | 'oversize' | 'invalid_encoding'>;
};

type KnowledgeSnapshot = {
  snapshotId: string;
  tenantId: string;
  knowledgeBaseId: string;
  sourceIds: string[];
  manifestStatus: 'building' | 'ready' | 'failed';
  immutable: true;
  contentHash: string;
  documentIds: string[];
  chunkIds: string[];
  redactionVersion: string;
  indexVersion: string;
  extractorVersion: string;
  createdAt: string;
  completedAt?: string;
  failureCode?: string;
};

type SnapshotDocument = {
  snapshotDocumentId: string;
  tenantId: string;
  snapshotId: string;
  documentId: string;
  documentRevision: string;
  contentHash: string;
  chunkIds: string[];
  redactionVersion: string;
  extractorVersion: string;
  indexVersion: string;
  ordinal: number;
};

type SnapshotAvailability = {
  snapshotId: string;
  tenantId: string;
  status: 'available' | 'expired' | 'revoked' | 'deleted';
  grantVersion: string;
  reason?: string;
  changedAt: string;
};

type KnowledgeChunk = {
  chunkId: string;
  tenantId: string;
  snapshotId: string;
  documentId: string;
  ordinal: number;
  text: string;
  contentHash: string;
  tokenCount: number;
  byteLength: number;
  headingPath?: string[];
  locator: { path?: string; url?: string; page?: string; lineStart?: number; lineEnd?: number; revision?: string };
  trust: 'untrusted';
  riskFlags: Array<'prompt_injection' | 'secret_like'>;
};

type KnowledgeQueryReceipt = {
  receiptId: string;
  taskId: string;
  runId: string;
  tenantId: string;
  snapshotIds: string[];
  normalizedQueryPlan: string;
  normalizedQueryHash: string;
  canonicalFilters: Record<string, unknown>;
  policyVersion: string;
  retrieverVersion: string;
  fts: { tokenizer: string; parser: string };
  retriever: { mode: 'fts'; tokenizer: string; parser: string };
  indexVersions: string[];
  orderedHits: Array<{ chunkId: string; rank: number; lexicalScore: number }>;
  redactionVersion: string;
  trustPolicyVersion: string;
  maxHits: number;
  maxContextTokens: number;
  actualBudget: { hits: number; contextTokens: number; outputBytes: number };
  truncationReasons: Array<'max_hits' | 'max_context_tokens' | 'max_output_bytes' | 'diversity' | 'policy_filter'>;
  createdAt: string;
};

type KnowledgeResolutionReceipt = {
  receiptId: string;
  tenantId: string;
  actorId: string;
  requestHash: string;
  policyVersion: string;
  candidates: Array<{ snapshotId: string; accepted: boolean; reasonCode?: string }>;
  resolvedSnapshotIds: string[];
  createdAt: string;
};
```

`KnowledgeSnapshot` 是 append-only 内容 manifest；`building/failed` 只存在于 staging，不能被任务解析，`ready` 后其 document revision、contentHash、chunkIds、Chunk 文本、redactionVersion、extractorVersion 和 indexVersion 永不改变。撤权、过期和删除只写 `SnapshotAvailability`/grant 投影，不能把 `revoked/deleted` 写回 manifest，也不能改写历史任务的 `resolvedSnapshotIds`。`KnowledgeDocument` 是当前目录元数据，历史版本必须通过 `SnapshotDocument` 引用。

Wiki Source 的外部元数据至少包含 `provider`、`space`、`page`、`path`、`revision`、`sourceUpdatedAt` 和 `credentialRef`；目录记录使用 `recordUpdatedAt`，不复用 `updatedAt`。历史 Evidence、Receipt 和 manifest 只保留审计引用及 hash；正文读取必须再次通过个人来源授权和 snapshot availability 校验。

Snapshot 解析和 freshness 使用一套确定性算法：按请求中的 `knowledgeBaseIds`、`sourceIds`、filters 和 `snapshotPolicy` 的 canonical 排序筛选对象；只保留 manifestStatus=`ready` 且 availability=`available` 的 Snapshot，按 `completedAt DESC, snapshotId ASC` 排序；`strict` 要求 `now - completedAt <= maxAgeMs`，`warn` 允许超龄但必须记录 warning，`allow_stale` 允许 stale 但仍拒绝 expired/deleted/revoked。没有候选时返回对应稳定错误码，不把不同错误全部映射为 `NOT_READY`。解析结果、排除理由、policyVersion、actor 和 `resolvedSnapshotIds` 一起原子写入 resolution receipt。`normalizedQueryPlan` 是可重放的规范化查询计划，`normalizedQueryHash` 是其哈希；两者都不保存未脱敏原始查询。

### 5.4 OpsTaskSession

`OpsTaskSession` 是任务投影，不替代已有 RunRecord：

```ts
type OpsTaskSession = {
  spec: OpsTaskSpec;
  state: 'draft' | 'queued' | 'running' | 'paused' | 'waiting_confirmation' | 'verifying' | 'completed' | 'blocked' | 'cancelled' | 'failed';
  currentPhase: 'observe' | 'hypothesize' | 'investigate' | 'verify' | 'conclude';
  hypothesisIds: string[];
  evidenceIds: string[];
  checkpointSequence: number;
  taskVersion: number;
  sequence: number;
  lastError?: { code: string; message: string; details?: Record<string, unknown> };
  finalConclusion?: Conclusion;
  evidence?: OpsTaskEvidence[];
  budgetUsage?: {
    adapterCalls: number;
    inputTokens: number;
    outputBytes: number;
    wallTimeMs: number;
  };
  patchProposal?: {
    id: string;
    summary: string;
    diff: string;
    status: 'proposed' | 'approved' | 'rejected' | 'applied';
    createdAt: string;
    decidedAt?: string;
  };
};
```

`taskVersion` 从 0 开始，每次成功状态或任务投影更新递增；`sequence` 是任务事件游标，创建事件可以使用 0，后续事件必须严格递增。当前协议的 `OpsTaskSession` 还允许保存脱敏 Evidence、预算用量和待审 Patch 提案；它们不替代 `RunRecord`，也不能绕过状态机直接写入终态。

## 6. Adapter 契约

Agent 不直接拼接 SSH 或 Shell。Adapter 只暴露有限的结构化能力。

```ts
type AdapterAudit = {
  adapterId: string;
  adapterVersion: string;
  environmentId: string;
  hostId: string;
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
  timedOut: boolean;
  redactionProfile: string;
};

type AdapterResult<T> = {
  data: T;
  evidenceIds: string[];
  audit: AdapterAudit;
  nextCursor?: string;
};

interface RuntimeAdapter {
  getHostInfo(input: ReadScope, signal?: AbortSignal): Promise<AdapterResult<HostInfo>>;
  listProcesses(input: ReadScope, signal?: AbortSignal): Promise<AdapterResult<ProcessInfo[]>>;
  listContainers(input: ReadScope, signal?: AbortSignal): Promise<AdapterResult<ContainerInfo[]>>;
  getServiceStatus(input: ServiceScope, signal?: AbortSignal): Promise<AdapterResult<ServiceStatus>>;
  getContainerLogs(input: LogQuery, signal?: AbortSignal): Promise<AdapterResult<LogPage>>;
  getJournalLogs(input: LogQuery, signal?: AbortSignal): Promise<AdapterResult<LogPage>>;
  getGitStatus(input: WorkspaceScope, signal?: AbortSignal): Promise<AdapterResult<GitStatus>>;
}
```

所有查询必须带作用域、超时和上限。日志查询必须支持分页、游标、最大字节数和截断标记。

本地验证命令不扩张 `RuntimeAdapter` 的只读查询契约，P0 最小纵向闭环注册受限的命令能力；P4 只扩展 Patch 后联动：

```ts
type LocalTestScope = {
  workspaceRoot: string;
  testId: string;
  args?: string[];
  timeoutMs: number;
};

type CommandResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
};

interface LocalCommandAdapter {
  runTest(input: LocalTestScope, signal?: AbortSignal): Promise<AdapterResult<CommandResult>>;
}
```

`LocalCommandAdapter` 只能接受已注册的 `testId` 和校验后的参数，不能接受任意 Shell 字符串；它以独立的 `local.run.test` 能力注册到任务 API，使用现有 `command` 权限和工作区作用域。当前只开放固定的类型检查和单元测试入口，输出先脱敏再进入任务投影和 UI。

### 6.1 SSH 安全要求

- 私钥和 Token 不进入 Suanlizi 配置、ThreadItem、Evidence 或模型上下文。
- 凭据只使用系统 SSH Agent、受控凭据存储或用户临时授权。
- 主机指纹使用固定 `known_hosts` 或显式指纹确认，禁止自动接受未知主机。
- 不允许 `sudo`、重定向、管道、命令替换、后台进程和任意 Shell。
- 具体命令由 Adapter 内部固定生成，用户输入只能进入经过校验的参数位。
- 认证失败、指纹变化、超时和部分结果必须生成明确状态，不伪装成空结果。
- 远程日志和配置即使是“只读”也可能包含密钥，必须先脱敏再进入模型。

### 6.2 Knowledge adapters and lifecycle

知识源不实现 `RuntimeAdapter`，而是通过独立、只返回文档和同步元数据的契约接入 `KnowledgeCatalog`：

```ts
type KnowledgeSourceAdapter = {
  readonly id: string;
  readonly version: string;
  listChanges(source: KnowledgeSource, cursor?: string, signal?: AbortSignal): Promise<{
    documents: Array<{ externalId?: string; title: string; path?: string; url?: string; revision?: string; sourceUpdatedAt?: string; content: string }>;
    nextCursor?: string;
    complete: boolean;
  }>;
  revoke(source: KnowledgeSource, reason: string): Promise<void>;
};

type WikiAdapter = KnowledgeSourceAdapter & {
  readonly kind: 'wiki';
  fetchPage(source: KnowledgeSource, pageRef: { page?: string; path?: string; revision?: string }, signal?: AbortSignal): Promise<{
    title: string;
    provider: string;
    space?: string;
    page?: string;
    path?: string;
    revision?: string;
    sourceUpdatedAt?: string;
    url?: string;
    markdown: string;
  }>;
};
```

生命周期固定为：`source created → sync queued → syncing → snapshot building → ready`；失败进入 `failed`，撤权和删除更新 Source grant/sync status 及 `SnapshotAvailability` 为 `revoked` 或 `deleted`，不修改已 `ready` 的 manifest。同步状态统一使用 `syncing`，不再出现 `running`。本地 `workspace_docs` 通过 `read_document`/文件树按 canonical workspaceRoot 增量扫描；Wiki 通过 `WikiAdapter` 使用 `credentialRef` 和 provider cursor；Incident 从脱敏 Incident/Evidence 投影导入。Wiki 是知识源之一，不等同于 normative Evidence。

索引器在入库前执行 size/encoding 校验、secret redaction、内容 hash、`extractorVersion` 和 prompt-injection 风险标记，并保留 Markdown 标题层级、Wiki 页面/路径、revision 和行号定位。SQLite FTS/词法索引是唯一检索索引，不创建向量/embedding 索引。

同步必须采用单飞 lease：同一 source 同时最多一个 `leaseId`，lease 过期后由协调器回收 `queued/syncing/building`，不能由并发同步覆盖 cursor。原子提交顺序固定为：1）获取 lease 并读取旧 cursor/currentSnapshot；2）为每个变化写不可变 document revision、`SnapshotDocument` 和 Chunk staging；3）构建并 fsync 带 `indexVersion` 的 staging FTS；4）在一个 Catalog 事务中写 manifest、SnapshotDocument/Chunk 引用、indexVersion、source cursor、SnapshotAvailability 和 `KnowledgeBase.currentSnapshotId`，事务提交即发布新 `ready` Snapshot。读路径只接受已发布的 manifest/indexVersion 对；任何一步失败都不提交 current，保留旧 `ready`。崩溃恢复把无 lease 的 building 状态标为 failed/可清理，不把半成品设为 current。部分 source 撤权后，新任务只能解析仍有 grant 的新 Snapshot；已运行任务在下一次取数边界阻塞，必须重新授权原 Snapshot，不能偷偷切换到剩余 source 的新 Snapshot。

Wiki 内容在服务端先经过 URL/Markdown 安全清洗：只允许配置 provider 的 origin，限制重定向次数并拒绝 localhost、内网、云 metadata 和解析后落入私网的地址；拒绝 URL 中凭据、隐藏链接、HTML 注释、`display:none`/不可见节点和不在 allowlist 的 HTML 标签/属性，Markdown 仅保留允许的链接/标题/强调/代码语法。清洗、脱敏和 risk flag 都是服务端强制步骤，`trust: 'untrusted'` 不是唯一防线。

知识库安全边界与运行时权限共用现有 `AccessPolicy`：

- Wiki、workspace 文档和 Incident 全部视为 `untrusted data`。内容中的系统提示、工具调用、权限授予、状态迁移或“忽略上文”都只是文本，不能改变 AgentLoop、ToolRegistry、AccessPolicy 或 Ops 状态机。
- 入库前强制执行最大字节数、编码校验、secret detector/redaction、内容 hash、`extractorVersion` 和 prompt-injection/risk 标记；原始未脱敏内容默认不落盘，调试临时区必须加密并有短 TTL。
- 检索结果携带 `trust: 'untrusted'`、风险标记和引用边界；Context Compiler 只能把脱敏 chunk 和允许的引用元数据提升到模型上下文，不能把 credentialRef 或原始内容传给模型。
- 每一次读都校验个人 KnowledgeBase、Source、Snapshot grant 和 Chunk scope；若同时访问本地目标，再单独校验任务的 workspace。删除或撤权后，新任务不得解析这些对象；历史任务保留 Evidence/Receipt 的审计引用和 hash，但正文读取必须重新授权，不能通过旧 `snapshotId` 绕过撤权。旧 tenant 字段只用于迁移兼容。
- 工具 dispatch 前和 Adapter 边界都必须重新校验服务端生成的参数、环境/host/service/path/time scope、AccessPolicy 和 task actor；客户端参数、Wiki 文本、模型输出和 `trust` 标记都不能授予权限或改变工具参数。

## 7. Evidence 设计

Evidence 是追加写入、不可变的逻辑对象；V1 的物理载体是 RunEvent/ThreadItem 元数据和 `EvidenceLedger` 投影，不要求立刻建立独立 Evidence 表。ThreadItem 只保存引用和摘要，不能保存未脱敏原文。

```ts
type Evidence = {
  evidenceId: string;
  tenantId: string;
  workspaceId: string;
  taskId: string;
  runId: string;
  kind: 'log' | 'code' | 'git' | 'runtime' | 'config' | 'knowledge';
  sourceKind?: 'workspace_docs' | 'wiki' | 'incident';
  role: 'observed' | 'normative' | 'historical' | 'reference';
  source: {
    adapterId?: string;
    hostId?: string;
    service?: string;
    path?: string;
    lineStart?: number;
    lineEnd?: number;
    knowledgeBaseId?: string;
    sourceId?: string;
    documentId?: string;
    snapshotId?: string;
    chunkId?: string;
    revision?: string;
    heading?: string;
    url?: string;
  };
  observedAt: string;
  expiresAt?: string;
  contentHash: string;
  redactedContent: string;
  redactionVersion: string;
  status: 'complete' | 'partial' | 'timed_out' | 'stale' | 'expired';
  parentIds: string[];
};
```

`workspace_docs`、`wiki`、`incident` 是 Source 的 `kind`，不决定 Evidence 的 `role`。Evidence 的 role 由内容语义和服务端分类决定：当前机器、当前服务、当前日志和当前根因只能是 `observed`；规范、Runbook 或预期行为可以是 `normative`；历史事故是 `historical`；背景资料是 `reference`。知识 Evidence 统一使用 `kind: 'knowledge'`，并携带 sourceKind、KnowledgeBase、Source、Document、Snapshot、Chunk、revision、heading、url/path 等定位。Wiki 不能单独证明“当前机器/当前故障”的根因。

`redaction_failed` 不是 Evidence 状态。脱敏失败时只追加一条不可进入模型上下文的 `EvidenceAttempt` 审计记录，不写入 `EvidenceLedger`：

```ts
type EvidenceAttempt = {
  attemptId: string;
  tenantId: string;
  workspaceId: string;
  taskId: string;
  runId: string;
  source: Evidence['source'];
  status: 'redaction_failed';
  detectorVersion: string;
  reasonCode: string;
  observedAt: string;
};
```

这样既能审计“为什么没有证据”，又不会产生带有空内容或未脱敏内容的伪 Evidence。

结论使用 Claim 关联证据：

```ts
type Claim = {
  claimId: string;
  tenantId: string;
  workspaceId: string;
  text: string;
  kind: 'current_state' | 'root_cause' | 'normative_rule' | 'historical' | 'reference';
  subject: string;
  scope: { tenantId: string; workspaceId: string; environmentId?: string; hostIds?: string[]; serviceNames?: string[] };
  timeRange?: { from: string; to: string };
  status: 'supported' | 'contradicted' | 'unverified';
  evidence: ClaimEvidenceRelation[];
};

type ClaimEvidenceRelation = {
  evidenceId: string;
  relation: 'supports' | 'contradicts' | 'context';
};
```

Claim 不接受模型自由填写的百分比 `confidence`。服务端校验 Claim 的 tenant/workspace/scope、Evidence 所属任务和时间范围，并校验关系语义：`supports`/`contradicts` 必须引用可读 Evidence，`context` 不得单独提升 Claim 状态；`current_state` 和 `root_cause` 必须至少有同一 environment/host/service scope 的 `observed` Evidence，只有 normative/historical/reference 时最多为 `unverified`。支持程度由 `status` 和 Evidence 状态共同决定；若 UI 需要排序，只能显示服务端计算的离散 `supportLevel: 'low' | 'medium' | 'high'`，且不得作为模型输入的授权依据。若存在过期、部分或冲突 Evidence，结论必须显示对应状态。

### 7.1 脱敏流水线

```text
Adapter output
  → size/encoding limit
  → secret detector
  → redaction
  → hash
  → Evidence persistence
  → model context
```

脱敏失败时拒绝持久化 Evidence 和发送模型，但允许持久化上面的 `EvidenceAttempt` 审计记录。原始内容默认不保存；确有调试需要时只进入加密临时区，并设置短 TTL。

## 8. Agent Loop

每个阶段都有明确输入、输出和停止条件。进入 Observe 前必须确认 `resolvedSnapshotIds` 仍属于任务，并对每个 Snapshot 的 manifest、availability grant 和统一的 `snapshotPolicy.freshness` 做服务端检查；进入 Retrieve 后才允许编译知识上下文：

1. `Observe`：采集基础快照，不能直接拉取无限日志。
2. `Retrieve`：只在固定 Snapshot 中查询，写入 QueryReceipt；无快照、撤权或不满足 freshness 时按 `OPS_KNOWLEDGE_NOT_READY`、`OPS_KNOWLEDGE_SNAPSHOT_REVOKED`、`OPS_KNOWLEDGE_SNAPSHOT_STALE` 或 `OPS_KNOWLEDGE_SNAPSHOT_EXPIRED` 进入 `blocked`，不能静默降级到全库搜索。已持久化 Receipt 的 replay 只读 Receipt，不把它当作绕过当前授权的模型上下文。
3. `Hypothesize`：生成有限数量的可证伪假设，并记录依据。
4. `Investigate`：一次只验证少量假设，遵守 Adapter、KnowledgeRetriever 和预算限制。
5. `Verify`：重新查询关键状态或执行允许的本地验证。
6. `Conclude`：输出 Claims、Evidence、Assumptions、Risk 和 Verification。

默认限制：最大 3 轮假设验证、最大墙钟时间、最大 Adapter 调用数、最大输出字节数和最大 Token 数。每次工具调用后写 checkpoint；取消和进程重启后从最后一个成功事件恢复，调用必须带幂等键。

调查失败时区分：

- `blocked`：缺少范围、权限或必要输入。
- `failed`：Adapter 或系统错误。
- `unverified`：有候选解释但证据不足。
- `completed`：满足预设验收标准，不代表自动修复成功。

## 9. Context Engine

Context Compiler 只把任务相关的摘要、快照和 Evidence 引用编译给模型，不拼接整个仓库、整个 KnowledgeBase 或全部日志。固定流水线如下：

```text
query
  → KnowledgeRetriever.retrieve(knowledgeScope)
  → policy filter（tenant/workspace/KB/source/snapshot）
  → redaction + trust boundary + prompt-injection isolation
  → dedupe + lexical rank（只使用 FTS 可解释分数）
  → maxHits/maxContextTokens/maxOutputBytes budget
  → Evidence promotion（按语义分类 role，不按 source kind 猜测）
  → QueryReceipt + model context
```

每次新查询必须生成 `KnowledgeQueryReceipt`，记录 `normalizedQueryHash`、固定 snapshotIds/indexVersions、canonical filters、policy/retriever/FTS tokenizer/parser、按 rank 排序的 lexical hitId/rank/score、脱敏/信任策略、实际预算用量和截断原因。Receipt 的 replay 只读取已持久化的 `orderedHits`，不重新执行检索、不访问当前 `currentSnapshotId`，也不因新同步改写结果；replay 默认只返回收据、rank/score 和引用元数据，Chunk 正文仍须通过当前 actor/grant 再授权。V1 不要求 deterministic rerun；若后续提供 rerun，必须使用 Receipt 记录的全部版本和参数，并另生成新的 Receipt。`normalizedQueryHash` 是规范化查询及 canonical filter 的执行身份；不保存原文，不再同时维护含义重复的 `queryHash/queryTextHash`。排序分数不写成 Claim 置信度。

上下文来源必须带版本和失效条件：

- Project Brain：提交、文件哈希和摘要版本。
- Runtime Snapshot：环境、主机、观察时间和过期时间。
- Logs：服务、时间窗口、游标和截断信息。
- Wiki：KnowledgeBase/source/document/snapshot/chunk、路径/页面/章节、revision、更新时间和“不可信内容”标记。
- Incident：脱敏后的历史事故和来源。

SQLite FTS/词法检索是唯一检索路径。先按 `normalizedQueryHash` 对本次查询去重，再按 source/document 多样性限制结果，最后按 `maxHits`、字节和 token 预算截断；不部署、不调用 embedding 服务，也不存在向量 fallback 分支。

模型上下文预算与任务预算分开：任务 `maxContextTokens`/`maxOutputBytes` 是本次任务硬上限，模型能力上限由 `ModelCapabilities` 动态读取。Qwen3.8-27B 等 256K 模型不能被硬编码的 32K 覆盖，但也不能因此整库注入。上下文窗口和本次任务预算都要在 UI 中分别显示。

## 10. 权限模型

Ops 使用现有 `AccessPolicy`，不创建 `remote.read.*` 形式的第二套权限枚举。点号名称只作为 UI 能力标签，实际判定仍使用现有 `AccessKind` 和 `AccessTarget`。

现有 `AccessKind` 为 `read | write | command | network | tool_call`。P0 扩展 `AccessTarget`，保留已有的 `path`、`command`、`network`、`tool` 目标，并增加 `workspace`、`host`、`container`、`service`、`log`、`knowledge_base`、`knowledge_source`、`knowledge_snapshot`、`knowledge_chunk` 类型。运行目标携带 `workspaceRoot`、相对路径、`environmentId`、`hostId`、`serviceName`、`containerName` 和日志查询范围；独立 Ops 知识目标携带完整的 `tenantId/knowledgeBaseId/sourceId/snapshotId/chunkId` 父链，不能只凭裸子资源 ID 授权。这样本地路径、远程读取和知识正文访问都走同一条判定链，也不会把本地文件系统或知识资源错误地塞进 `host`。

Ops Task、TaskEvent、Evidence、Claim、Incident 仍保存运行时审计所需的 `tenantId`、`workspaceId`（若适用）、`threadId`、`createdBy`，动作事件保存 `actorId`；KnowledgeBase/Source/Snapshot/Receipt 的旧 tenant 字段仅为迁移兼容，不参与个人知识库筛选。每个 REST/SSE/工具入口校验任务和个人目录授权；涉及本地目标的任务动作再校验 workspace。`threadId` 只表达数据关联，不能代替身份或授权；客户端传入的 tenant/workspace/createdBy 只能作为请求校验项，不能成为授权来源。

能力标签到现有策略的映射如下：

```text
remote.read.host       → read + target(host/environment scope)
remote.read.process    → read + target(host/environment scope)
remote.read.container  → read + target(container/host/environment scope)
remote.read.service    → read + target(service/host/environment scope)
remote.read.logs       → read + target(log/service/host/time scope)
remote.read.config     → read + target(service/host scope)，返回前脱敏
local.read.workspace    → read + target(workspace/path scope)
remote.write.*         → write/command + hard deny
remote.restart.*       → command + hard deny
remote.upload.*        → write/network + hard deny
remote.deploy.*        → write/command + hard deny
local.propose.patch    → read/tool_call，生成提案，不写文件
local.apply.patch      → write + prompt
local.run.test         → command + target(workspace scope) + prompt
knowledge.read         → read + target(workspace/knowledgeBase/source/snapshot scope)
knowledge.sync         → read + network/tool_call + target(workspace/knowledgeBase/source scope) + prompt
knowledge.chunk.read   → read + target(knowledgeBase/snapshot/chunk scope)
```

硬拒绝优先级高于线程、工作区和全局授权。授权规则必须同时绑定 `access`、目标、环境和作用域，不能只按工具名称放行。远程只读规则也不能放宽本地路径越界、网络和凭据保护规则。服务端在工具 dispatch 前、Adapter 调用前和实际执行前各做一次参数、task actor、environment/host/service/path/time scope、AccessPolicy 和 grant revalidation；任一层失败都返回拒绝错误并写入失败事件，不能用空结果掩盖拒绝。

KnowledgeBase 权限不另造一套审批链：知识库读取、同步、Chunk 读取都映射回现有 `read`/`network`/`tool_call` 和扩展后的 `AccessTarget`。服务端必须检查当前个人目录中的 knowledgeBaseId、sourceId、snapshotId、SnapshotAvailability grant 和 Chunk scope；涉及本地诊断目标时再检查任务 workspace。客户端只能提交用户已选的 KnowledgeBase 集合，不能由模型或项目路径扩大集合。撤权、删除请求统一返回稳定知识库错误码，知识库不存在返回 `OPS_KNOWLEDGE_REQUIRED`，没有 `ready` manifest 返回 `OPS_KNOWLEDGE_NOT_READY`，原 Snapshot grant 失效返回 `OPS_KNOWLEDGE_SNAPSHOT_REVOKED`。

## 11. API 和 SSE

第一版统一使用任务 API，避免把任务状态塞进普通聊天接口：

```text
POST /ops/tasks
GET  /ops/tasks/:taskId
POST /ops/tasks/:taskId/actions       pause/resume/cancel/confirm/reject/update_scope/reauthorize_snapshot
POST /ops/tasks/:taskId/retry         从 completed/cancelled/failed/blocked 任务创建新的 taskId
GET  /ops/tasks/:taskId/events        SSE，支持 afterSequence
GET  /ops/tasks/:taskId/evidence/:id
POST /ops/tasks/:taskId/patch/approve
POST /ops/tasks/:taskId/incidents

GET  /knowledge-bases?cursor=&limit=
POST /knowledge-bases
GET  /knowledge-bases/:knowledgeBaseId
PATCH /knowledge-bases/:knowledgeBaseId       乐观锁更新元数据
DELETE /knowledge-bases/:knowledgeBaseId      撤权/删除（不改历史快照引用）
POST /knowledge-bases/:knowledgeBaseId/sources
GET  /knowledge-bases/:knowledgeBaseId/sources?cursor=&limit=
PATCH /knowledge-sources/:sourceId
POST /knowledge-sources/:sourceId/sync       幂等同步请求
GET  /knowledge-sources/:sourceId/status
GET  /knowledge-bases/:knowledgeBaseId/snapshots?cursor=&limit=
GET  /knowledge-snapshots/:snapshotId
POST /knowledge/query                     query + knowledgeScope → receipt/hits
GET  /knowledge/receipts/:receiptId
GET  /knowledge/receipts/:receiptId/replay       只读已持久化 orderedHits，不重新检索
GET  /knowledge/chunks/:chunkId
```

当前原型实际挂载在 `/api/ops/...`。Patch 提案、批准和拒绝目前统一走
`POST /api/ops/tasks/:taskId/actions` 的 `propose_patch`、`approve_patch` 和
`reject_patch` 动作；证据读取、任务 Incident 列表和全局 Incident 列表已经有对应
GET/POST/DELETE 路由。独立的 `/patch/approve` 路径仍是后续兼容入口，不应在当前 UI
中伪装成已启用的文件写入能力。

API 创建/失败协议固定如下：

- 成功持久化 Task（无论状态为 `draft`、`queued` 或 `blocked`）统一返回 HTTP `201`，信封为 `{ ok: true, data: { taskId, state, error? }, requestId }`；`blocked` 必须同时返回稳定 `error.code`，Task 已落盘，不能只返回空响应。`draft` 仅用于尚未提交解析的合法请求。
- 请求 schema/参数非法返回 HTTP `400` 和 `{ ok: false, error: { code: 'OPS_INVALID_REQUEST', message, details }, requestId }`，不创建 Task；认证失败 `401`，actor/tenant/workspace 无权 `403`，版本/幂等/活动任务冲突 `409`，存储或调度暂时失败 `503`。
- HTTP `201` 的 `blocked` 与状态机的 `lastError.code` 必须一一对应：缺 KB 用 `OPS_KNOWLEDGE_REQUIRED`，未就绪用 `OPS_KNOWLEDGE_NOT_READY`，freshness/撤权分别用对应 Snapshot 错误码；不得把所有原因混成 `NOT_READY`。
- 同一 `Idempotency-Key` 加同一请求体返回第一次完全相同的 HTTP 状态、信封和 `taskId`；同键不同请求体返回 `409 OPS_IDEMPOTENCY_CONFLICT`。收到 `503` 时用相同幂等键重试不会创建第二个 Task；已创建的 `blocked` Task 通过 action/重新授权或 `/retry` 处理，不通过创建重试重新解析旧任务。

其他要求：

- 创建和动作请求支持 `Idempotency-Key`。
- 创建和动作请求的幂等键由 Ops API 持久化，键必须绑定 tenant、task、action 和请求体哈希；同键不同请求体返回冲突。
- SSE 事件有 `taskId/runId/sequence/type`，当前原型从租户隔离的 Ops 任务事件投影按 `afterSequence` 或 `Last-Event-ID` 重放，并在传输信封中增加 `isReplay: boolean`。`isReplay` 只描述本次投递来源，不写入事实事件；迁移到 `RunTraceStore` 是后续存储收敛工作。
- 客户端按 `sequence` 去重，但不能因为 `isReplay` 而丢弃断线期间尚未出现的事件：只有已应用过的 sequence 才跳过，缺失的历史事件必须按顺序补齐；实时事件使用正常动画，重放事件使用无动画或“已恢复”提示。
- 断线重连不能重复追加 UI item；重放与实时事件必须共用同一套 item 合并键。
- 后端错误必须写入失败事件和任务状态，不能只返回空白响应。
- `pause/resume/cancel` 必须是串行状态迁移，不能并发覆盖。
- Knowledge CRUD、Source sync、Snapshot 列表和 Chunk/Receipt 读取都必须支持个人目录、分页游标、`Idempotency-Key`（创建/同步/查询）和 `expectedVersion` 乐观锁；删除只影响新任务可见性，不修改历史任务固定的 Snapshot manifest。
- `POST /ops/tasks` 必须携带 UI 选中的 KnowledgeBase；服务端在返回 `queued` 前只校验这些 ID 并固定 `resolvedSnapshotIds`。无法解析时返回已持久化的 `blocked` Task 和稳定错误码，不得让 UI 显示已运行。已排队任务不得通过 action 重新解析新 Snapshot。
- `update_scope` 只能修改从未进入 `queued` 的 `draft/blocked` 请求范围；已排队或曾运行任务的 knowledgeScope/resolvedSnapshotIds 不可替换。撤权/过期任务只能调用 `reauthorize_snapshot`，或通过 `/retry` 创建绑定新 Snapshot 的任务。
- `POST /knowledge/query` 必须返回 `receiptId`、脱敏 Chunk 引用、`orderedHits`、truncation reasons、实际预算和固定 Snapshot/indexVersion；不能返回未脱敏原文或 credentialRef。Replay endpoint 只读取 Receipt，不重新执行检索。
- 所有后端错误（包括工具参数拒绝、同步失败、撤权和 freshness 阻塞）都必须写入对应 Task/Source 事件；SSE 发出同一错误 envelope 的失败事件，前端 REST 失败后重新拉取 Task/线程，不能只显示事件栏。

## 12. UI

右侧 `Task Inspector` 第一版只显示必要信息：

- 任务状态、阶段、环境和风险。
- 目标主机、服务和时间范围。
- 权限结论和预算消耗。
- 工具时间线和 Evidence 列表。
- Claim 与 Evidence 的跳转关系。
- 过期、部分、冲突和脱敏状态。
- 暂停、恢复、取消、确认 Patch 和保存 Incident。

知识库相关 UI 是 Ops 的必需路径：

- Ops 工作台提供 KnowledgeBase 管理：创建/重命名/删除、独立来源列表、Wiki provider/space/page/path/revision、credentialRef 状态（只显示引用，不显示密钥）、同步状态和错误。
- Ops 工作台显示全部个人命名知识库的 ready 状态、已授权来源 canonical path、来源/页面数量、最近同步时间，并提供创建、改名、停用、同步、页面预览和搜索验证；Composer 不显示知识库范围选择器，也不把知识库当工作区配置。
- 任务创建后 UI 只展示服务端固定的 Snapshot，不提供覆盖 `resolvedSnapshotIds` 的重新解析按钮。
- Task Inspector 显示 Knowledge scope、固定 snapshotIds、freshness、QueryReceipt、FTS 检索状态、截断预算和 Knowledge Evidence 的页面/标题/路径跳转。所有知识内容明确标记“不可信”及服务端判定的 semantic role，不能伪装成当前运行事实。
- 隐藏右栏时，`blocked` 锚点卡片必须显示知识库缺失/未就绪/撤权/过期原因，并提供同步、重新授权原 Snapshot 或创建 retry 任务的动作；已排队任务不能用“重新解析”覆盖固定 Snapshot，动作仍经过同一任务状态机和 AccessPolicy。

拓扑图、因果图、复杂监控面板和架构可视化后置。隐藏右侧栏只影响显示，不暂停任务，也不销毁任务状态。

### 12.1 关键交互硬要求

- **线程锚点卡片。** 当任务进入 `waiting_confirmation` 或 `blocked`，且 Task Inspector 当前不可见时，在主聊天流底部插入一条可操作的 Thread Anchor Card。卡片显示任务编号、阶段、目标范围、等待原因和最小必要动作；用户可以直接批准、拒绝并继续调查、补充范围或取消。卡片使用当前主题的实色面板和细边框，不依赖毛玻璃或右侧栏可见性。
- **双通道一致性。** 锚点卡片与 Task Inspector 使用同一个任务状态和 action id；任一处完成操作，另一处立即更新，不能产生两个确认流程。
- **Claim 证据绑定。** 结论中的每个 Claim 必须显示 `supported`、`contradicted` 或 `unverified` 状态、kind/subject/scope/timeRange，并列出带 `supports`/`contradicts`/`context` 关系的 Evidence 引用。Evidence 引用打开轻量摘要，不复制未脱敏原文；`unverified` 使用“假设”标记，不能伪装成结论。
- **Evidence 状态感知。** Evidence 列表要区分完整、部分/截断、过期和脱敏隔离。过期项提供“重新查询”动作并生成新 Evidence；`EvidenceAttempt(redaction_failed)` 只显示为隔离审计状态，不能提供“查看原文”。
- **预算 HUD。** Task Inspector 顶部同时显示墙钟时间、Adapter 调用数、任务 Token 预算和模型上下文能力上限；任务预算达到 80% 提醒，达到上限进入 `blocked` 或 `failed`，不能继续静默调用。
- **日志查询。** 日志列表采用游标分页和虚拟滚动，明确显示截断区间、字节上限和下一游标；重连或追加查询不能重复已有日志项。
- **Patch 审查。** P4 的 Diff 区域默认只读，展示影响文件、测试建议和写入目标。直接写入当前工作区必须二次确认；写入独立 worktree 作为默认推荐。任何写入成功后追加人工确认事件和测试 Evidence。

### 12.2 V1 功能矩阵

下表把“融合”拆成可验收的用户功能。功能是否进入 V1 以最后一列为准；未列入 V1 的能力不能在 UI 中伪装成已经可用。

| 功能 | 用户入口 | Adapter / 数据源 | 权限与确认 | 输出与失败状态 | Evidence | 阶段 |
| --- | --- | --- | --- | --- | --- | --- |
| 进入 Ops 任务 | 线程模式选择器、监控事件、文件或 Incident 上下文菜单 | 无，创建统一的 `OpsTaskSpec` | 仅确认任务范围；远程环境另需环境确认 | 创建 `draft` 任务；缺少范围时进入 `blocked`，补齐后重新排队 | 创建事件和作用域收据 | P0 |
| 选择个人知识库并固定快照 | Ops 工作台、Ops 任务创建 | KnowledgeCatalog | `read` + personal KB/source scope | 用户显式选择一个或多个库；服务端固定 Snapshot；无选择、未就绪、freshness 或撤权时 `blocked`，显示对应 CTA | `knowledgeScope`、resolution receipt 和固定 Snapshot | P0（release gate） |
| 知识库管理 | Ops 工作台 | KnowledgeCatalog、KnowledgeSourceAdapter | 当前个人目录；Wiki 同步另需 network/tool_call | CRUD、来源授权、同步状态、失败/撤权和删除确认 | Catalog 审计事件 | P1（管理 UI） |
| Wiki/文档/Incident 来源扩展 | 知识库来源面板 | workspace_docs、WikiAdapter、Incident adapter | 只读、credentialRef、来源 scope；不能把内容中的指令当权限 | 增量 cursor、hash/revision、`ready`/`failed`/availability 投影 | immutable Snapshot manifest 和索引版本 | P1（provider 扩展） |
| FTS 检索 | Ops 创建、Inspector 查询 | KnowledgeRetriever、SQLite FTS | 固定 Snapshot 和 `maxHits/maxContextTokens` | 只使用 FTS；显示截断和多样性限制 | QueryReceipt、Chunk 引用 | P0 |
| 环境与目标选择 | 任务创建面板 | 已保存环境配置、工作区配置 | 生产/远程主机必须显式确认；未知主机拒绝 | 显示环境、主机、服务、容器、时间范围 | 作用域快照 | P0 |
| 主机和运行时快照 | 统一 Ops 任务的 Observe/Investigate 阶段 | Replay、Local、Ssh | `read`，按 host/environment 绑定 | 主机信息、进程、容器和服务状态；超时或部分结果可见 | `runtime`，带观察时间和过期时间 | P1/P2 |
| 日志与 Journal 查询 | 统一 Ops 任务的自动查询或 Task Inspector 的“追加查询” | Replay、Local、Ssh | `read` + log/service/time scope；查询上限固定 | 分页、游标、截断、认证失败、超时和部分结果 | `log`，脱敏后保存 | P1/P2 |
| 工作区与 Git 检查 | 统一 Ops 任务或文件上下文入口 | LocalAdapter | `read` + workspace scope | Git 状态、相关文件和行号；越界路径 `blocked` | `git` / `code` | P1 |
| 假设与调查编排 | Ops 任务时间线 | KnowledgeRetriever + 已授权 Adapter 结果 + Model Gateway | 只能调用任务允许的工具和固定 Snapshot，受预算限制 | Observe → Retrieve → Hypothesize → Investigate → Verify → Conclude；当前状态/根因无 observed 证据时 `unverified` | Claim relation 与 semantic Evidence role | P0 |
| 重新验证 | 结论卡片中的“重新查询/验证” | 原 Adapter，新的观察时间 | 复用原作用域，仍受策略、预算和 TTL | 新旧结果对比；证据过期或冲突明确标记 | 新 Evidence，不覆盖旧 Evidence | P0 |
| 暂停、恢复、取消和断线续跑 | Task Inspector 和任务 API | Harness、RunTraceStore | 仅经认证的任务所有者或显式授权 actor 可操作；threadId 只作关联；状态迁移串行 | `paused`、`running`、`cancelled`、`failed`；重复动作幂等 | 状态迁移事件和 checkpoint | P0 |
| 权限预览与拦截 | 创建任务、首次调用前、被拒绝时 | AccessPolicy | 默认拒绝；远程写入、重启、上传、部署硬拒绝 | 显示 allow/prompt/deny 及原因；禁止用空结果代替拒绝 | 权限决策收据 | P0 |
| 人工介入锚点 | 主聊天流底部、Task Inspector | ThreadStore + OpsTaskSession | 不新增权限；动作仍走任务状态机和幂等键 | Inspector 隐藏时仍可补充范围、确认、拒绝或取消 | action 事件和状态迁移 | P0 |
| Claim 与 Evidence 查看 | 结论卡片、Evidence 摘要 Popover | EvidenceLedger | 只允许查看当前 workspace/environment 的脱敏内容 | 支持/冲突/假设状态和证据跳转；隔离项不可查看原文 | 引用关系不复制内容 | P3 |
| 预算与上下文 HUD | Task Inspector 顶部 | RunTrace、ModelCapabilities | 只读 | 显示墙钟、Adapter 调用、任务预算和模型能力上限；超限阻止继续执行 | 预算事件 | P3 |
| Patch 提案 | 结论或文件上下文中的“生成 Patch” | LocalAdapter + 本地工作区 | 先 `read/tool_call` 生成提案；写入前必须确认 | Diff、影响文件、测试建议；未确认不得写入 | Patch 提案、审查和执行记录 | P4 |
| 本地验证测试 | Ops Inspector / Patch 审查面板 | LocalCommandAdapter | `command` + 用户明确点击运行；只允许注册 testId、限制工作区和命令集合 | 测试输出、退出码、超时、取消和失败原因 | `test` 运行记录；脱敏失败仅留审计事件 | P0（最小闭环）；P4 仅扩展 Patch 后联动 |
| 保存 Incident | 任务结论面板 | EvidenceLedger、ThreadStore | 脱敏、去重和用户确认 | 结构化摘要、根因、影响、修复和验证建议 | Incident 引用脱敏 Evidence | P4 |
| 导出与删除 | 设置或 Incident 管理 | 持久化层 | 仅当前 workspace/environment 范围 | 导出成功、删除确认、保留期检查 | 审计事件，不导出凭据 | P2/P4 |

V1 首发承诺的前提是 P0 release gate：ReplayAdapter、LocalAdapter、LocalCommandAdapter 固定测试入口、统一 Ops 任务、KnowledgeBase 最小纵向闭环（manifest、FTS、resolution receipt、QueryReceipt、权限和冷启动）以及证据链和任务控制全部通过。没有 `ready` KnowledgeSnapshot 或有效 availability grant 的任务只能 `blocked`，不能伪装为无知识依据的完整诊断。P1 只增加 Wiki/Incident provider 和管理 UI 等增强；SshAdapter 在 P2 接入后才开放真实远程环境；Patch 写入和 Incident 检索在 P4 完成前只能显示为未启用或使用回放数据。常驻监控、告警自动触发、自动修复和多 Agent 协同不属于 V1 功能。

## 13. 持久化和保留

- `ThreadStore` 和 `RunTraceStore` 是任务事实源。
- V1 不引入独立 Evidence 表：Evidence 元数据和引用挂在 RunEvent/ThreadItem 上，`EvidenceLedger` 负责投影和重建。
- V1 Evidence 的 `expiresAt`、`redactionVersion`、`status`、`contentHash` 必须随事件/条目一起持久化，重建时不得重新脱敏生成不同结果。
- P2 在远程日志量和 TTL 需求明确后，再评估独立 Evidence 存储和淘汰迁移。
- OpsTask、Evidence 索引和 Incident 是可重建投影；独立 Incident 存储不改变 RunTrace 事实源。
- 任务、证据和事故按显式 `tenantId/workspaceId/environmentId` 命名空间隔离；历史审计引用与正文读取授权分离。
- 原始日志默认不落盘；脱敏 Evidence 和索引设置明确 TTL。
- Incident 保存前必须经过脱敏、去重和用户确认。
- 提供删除、导出和保留期检查，不能只设计写入和检索。
- KnowledgeCatalog 持久化 KnowledgeBase/Source/Document/Snapshot manifest/SnapshotDocument/SnapshotAvailability/Chunk/Receipt 元数据；`ready` manifest、indexVersion、extractorVersion、contentHash、availability grant、resolutionReceipt 和 `resolvedSnapshotIds` 必须可冷启动恢复。
- 同步采用 cursor 增量更新：cursor、外部 document revision、manifest、FTS index 和 `currentSnapshotId` 按 6.2 的单飞 lease 与原子发布顺序提交。旧 `ready` Snapshot 永不原地改写；新文档/修订生成新 Snapshot，删除文档只在新 manifest 中缺席或标记 deleted，历史任务仍可审计引用旧 Snapshot。
- FTS 索引带 indexVersion；迁移期间旧 Snapshot 可读，重建失败不能让已固定任务改用新索引或全库。冷启动扫描到 Source `syncing`、Snapshot `building` 或 Ops task `running` 时按各自 lease/checkpoint 恢复或回收，不能把半成品设为 current；失败保留旧 ready。
- 删除/撤权使新任务无法解析相应 KB/source/snapshot，返回 `OPS_KNOWLEDGE_SCOPE_DENIED` 或 Snapshot 专用错误；已有任务在下一取数边界阻塞，必须重新授权原 Snapshot 或创建 retry/new task，不能切换到新 Snapshot。历史 QueryReceipt、Evidence、manifest hash 和定位保留审计，正文访问重新通过当前 actor/grant 授权。
- 原始未脱敏内容默认不落盘。若 Wiki provider 只提供原文，必须在临时加密区完成解析、脱敏和 hash 后立即清理，并记录 TTL/清理事件。

## 14. 分阶段实施

阶段状态按当前源码核对，不把“接口存在”误记为“能力完整”。

### P0：首次可进入 queued 的最小纵向 KB 闭环（release gate，当前尚未通过）

- [x] `OpsTaskSpec`、完整状态迁移、稳定错误码、`taskVersion`/`sequence` 和 retry/`parentTaskId` 协议。
- [x] Thread 的 `mode`/统一 `taskPreset` 类型、schema 以及 SQLite/JSON/Postgres 元数据持久化；旧线程默认按 `chat` 读取。
- [x] 租户隔离的 Ops 任务投影 API：创建、列表、详情、状态动作、retry、Evidence 读取和 Incident CRUD。
- [x] `Idempotency-Key`、请求体指纹、同租户串行锁、乐观锁版本冲突和同线程活动任务冲突。
- [x] SSE `afterSequence`/`Last-Event-ID`、`isReplay` 和 API 进程重启后的 queued/running/verifying 任务恢复；当前事件事实源仍是 Ops setting 投影。
- [x] 规则式 `SecretRedactor`、密钥日志隔离和 `EvidenceAttempt` 事件；脱敏失败不会创建可供模型读取的 Evidence。
- [x] 现有 `AccessPolicy` 的 workspace/host/container/service/log 目标及远程写入、重启、上传、部署硬拒绝。
- [x] ReplayAdapter、LocalAdapter 的最小执行器和可选 Harness 只读调查桥接。
- [ ] P0 固定 `LocalCommandAdapter` 的注册 testId、workspace scope、参数校验和脱敏输出；P4 只追加 Patch 后测试联动。
- [x] Desktop Task Inspector、隐藏右侧栏时的 Thread Anchor Card、暂停/恢复/取消/确认/拒绝/补充范围操作入口。
- [ ] 个人 KnowledgeBase/Source/Document/Snapshot manifest/SnapshotDocument/SnapshotAvailability/Chunk/QueryReceipt 目录和持久化；旧 tenant 字段只作迁移兼容，Ops Task 单独保存诊断 workspace 目标。
- [ ] workspace_docs 的最小同步 vertical slice：cursor、单飞 lease、原子 manifest+FTS+currentSnapshot 发布、旧 ready 保留、崩溃回收和冷启动恢复。
- [ ] `draft → queued` 的一次性确定性快照解析、统一 freshness policy、resolution receipt、`OPS_KNOWLEDGE_REQUIRED/NOT_READY/SCOPE_DENIED` 及 stale/expired/revoked 错误。
- [ ] SQLite FTS/词法检索、脱敏/Markdown 安全清洗、QueryReceipt ordered hits 和 replay；不引入向量检索或 embedding 依赖。
- [ ] 固定 Snapshot 的 Context Compiler、semantic Evidence role、Claim relation 校验、正文再授权和撤权/过期阻塞恢复路径。
- [x] Ops 工作台的独立知识库状态、创建/同步 CTA、固定 Snapshot 摘要和 blocked CTA；P1 再补完整 KnowledgeCatalog 管理 UI 与 provider 管理。
- [ ] Harness pause/resume/cancel 尚未与 Ops checkpoint 做到“从最后成功 Adapter 调用恢复”；恢复当前会重新调度 Runner，仍需重复调用防护。
- [ ] 六类安全 Fixture 尚未全部接入 API 级回放验收，目前只有 Replay/Runner 单元 Fixture 和脱敏测试。

P0 release gate 只有在上述 KnowledgeBase vertical slice、FTS、resolution/QueryReceipt、权限隔离、冷启动和失败闭环全部通过后，任务才允许从 `draft` 进入 `queued`。在 gate 通过前，已有任务、回放和 UI 只能作为无知识原型展示；任何没有有效 `ready` manifest 和 availability grant 的任务必须持久化为 `blocked`，不能宣称“可运行的 Ops”。

### P1：知识源 provider 与管理增强（不重复 P0 release gate）

- [x] ReplayAdapter 的确定性文本回放和 LocalAdapter 的工作区目录只读快照。
- [x] Evidence 摘要、哈希、脱敏版本和预算用量进入任务投影。
- [ ] WikiAdapter 的 provider/space/page/path/revision 定位、SSRF/HTML/Markdown 清洗和来源 grant，复用 P0 manifest/FTS/Receipt 契约。
- [ ] Incident adapter 导入脱敏历史资料，保持 `sourceKind` 与 Evidence role 分离。
- [ ] KnowledgeCatalog 管理 UI、来源授权、同步状态、固定 Snapshot 查看和 blocked/re-authorize/retry CTA。
- [ ] Wiki/Incident Provider、知识库管理 UI 和模型部署健康检查；检索仍保持 FTS-only。
- [ ] 主机信息、进程、容器、服务、日志游标/截断和 Git 查询尚未拆成完整的结构化 Adapter 契约。
- [ ] 统一 Ops 任务还没有完整的 Observe → Retrieve → Hypothesize → Investigate → Verify 结果 Fixture 矩阵。

### P2：SshAdapter（未实现真实连接）

- [x] `SshAdapter` 边界和按环境选择 Adapter 的路由已存在；凭据不会进入接口。
- [ ] 真实 SSH 连接、环境配置、主机指纹、凭据句柄、连接池生命周期和类型化读取均未实现；当前调用会明确返回“未配置”。
- [ ] 认证失败、连接超时、命令注入、越界路径、未知主机和指纹变化测试尚未完成。

### P3：Task Inspector 和模型接入（部分实现）

- [x] Desktop Task Inspector 展示任务状态、阶段、预算、Evidence、Claim、Patch 提案和任务动作。
- [x] API Runner 可通过只读权限创建 Harness 调查和验证回合。
- [ ] ModelCapabilities 动态上下文预算、Wiki 不可信上下文标记、Evidence Popover 和完整 Claim 跳转尚未完成。

### P4：Patch 和 Incident（部分实现）

- [x] Patch 提案、Diff 预览、批准/拒绝状态和 Incident 的脱敏摘要持久化、列表、读取、删除。
- [ ] 尚未实际写入工作区或独立 worktree；Patch 后的测试联动、结构化/语义 Incident 检索仍未实现。固定本地测试入口、测试运行记录和脱敏输出已在 P0 最小闭环中实现。

上述分阶段状态不改变“不开放远程写入、重启、上传、部署和自动修复”的安全边界。

## 15. 验收标准

除原有五个故障场景外，必须增加：

1. 未知 SSH 主机和指纹变化。
2. 认证失败、连接超时和部分日志结果。
3. 日志、配置和 Wiki 中包含伪造密钥或 Prompt Injection。
4. 远程命令注入、`sudo`、重定向和越界路径尝试。
5. 过期 Evidence 触发重新查询。
6. SSE 断线后按游标恢复且不重复事件；客户端能区分 `isReplay`，并补齐断线期间遗漏的事件。
7. 任务取消、进程重启和 checkpoint 恢复。
8. 重复提交不会创建两个活动任务。
9. 本地 Patch 在用户确认前不写入工作区。
10. 相同 Fixture 重放时，Evidence 引用和结论状态稳定；不要求模型逐字相同。
11. Harness pause/resume/cancel 的状态迁移不会重复执行 Adapter 调用。
12. Ops API 相同幂等键不会创建重复任务或重复动作。
13. SshAdapter 任务结束和进程退出后无悬挂连接。
14. 所有非法状态迁移返回稳定错误码；`queued` 可取消；从未进入 `queued` 的 `blocked` 任务可补充作用域后首次解析，已运行后阻塞的任务只能重新授权原 Snapshot 或通过 retry 创建新任务；终态只能通过 retry 创建新任务。
15. Task Inspector 隐藏时进入 `waiting_confirmation` 或 `blocked`，主聊天流出现可操作 Thread Anchor Card，且与 Inspector 共用同一个 action id。
16. 脱敏失败只产生 `EvidenceAttempt`，不存在 `redaction_failed` Evidence 或可查看的原始内容。
17. 不选择 KnowledgeBase 时任务保持 `draft/blocked`，返回 `OPS_KNOWLEDGE_REQUIRED`，不能进入 `queued`。
18. 选择的 Snapshot manifest 未 `ready` 时返回 `OPS_KNOWLEDGE_NOT_READY`；超出 strict freshness 返回 `OPS_KNOWLEDGE_SNAPSHOT_STALE` 或 `OPS_KNOWLEDGE_SNAPSHOT_EXPIRED`；grant 撤销返回 `OPS_KNOWLEDGE_SNAPSHOT_REVOKED`，均进入 `blocked`，不能静默使用全库。
19. 任务创建后固定 `resolvedSnapshotIds`；同一 Fixture 重放得到稳定的 QueryReceipt/chunk 引用，Wiki 更新不会污染旧任务。
20. 跨 tenant、workspace、KnowledgeBase、Source 或 Snapshot 查询均返回 `OPS_KNOWLEDGE_SCOPE_DENIED`；删除/撤权后新任务不可用，历史 Evidence 仍可审计但正文重新授权。
21. Wiki 内容包含 prompt injection、伪造系统消息、权限或工具指令时，模型只看到不可信标记，不能改变系统提示、权限、状态机或工具调用。
22. 未部署任何 embedding/向量服务时，SQLite FTS/词法检索仍能返回脱敏命中并生成 QueryReceipt。
23. Claim 只有 `workspace_docs`/`wiki`/`incident` 中被分类为 normative、historical 或 reference 的知识 Evidence 时，不得将“当前机器/当前根因”标为 `supported`；必须有当前作用域的 observed Evidence。
24. 检索命中超过 `maxHits`、`maxContextTokens` 或字节预算时可重放地截断，Receipt 记录 `truncationReasons`、ordered hit ranks/scores、实际预算和引用边界，不整库注入。
25. Wiki source 的 provider/space/page/path/revision/`sourceUpdatedAt`/`recordUpdatedAt`/credentialRef 全部可追溯，凭据正文、未脱敏原文、URL 重定向、隐藏链接和不在 allowlist 的 HTML 不进入模型上下文。
26. 冷启动恢复后任务仍引用原 Snapshot 和 QueryReceipt；同步产生新 Snapshot 不改变运行中/历史任务的知识依据。

V1 完成必须同时满足：

- 任务只调用显式允许的 Adapter 能力。
- 所有成功观察结果都有 Evidence 和脱敏状态；失败或脱敏失败的尝试都有 `EvidenceAttempt` 审计记录，且不会把未脱敏内容写入 Evidence 或模型上下文。
- 结论能区分 supported、contradicted 和 unverified。
- 预算、超时、取消、恢复和重连均可验证。
- 远程写入能力在策略、Adapter 和测试中都不可达。
- 本地 Patch 必须经过用户审查。
- 至少六个脱敏 Fixture 通过回放验收。
- 测试直接引用 `src`，不得通过 `dist` 或 `dist-types` 验证运行时行为。
- 每个可运行 Ops 任务都能追溯至少一个 `ready` immutable KnowledgeSnapshot、至少一条 QueryReceipt 或明确的 `blocked` 知识错误；不得把无知识库的回放结果误报为完整诊断。

## 16. 不阻塞基础检索、但不得绕过知识契约的决策

以下事项可以在知识库最小闭环之后继续演进，不得成为基础 Ops 的隐式前置：

- 首批 Linux 发行版和 Docker 版本。
- Wiki provider 的具体 Markdown 解析器实现；但标题/路径/revision 定位和不可信标记必须遵守 P0 manifest/FTS/Receipt 契约，并在 P1 provider 扩展中保持稳定。
- embedding/向量模型和向量数据库不属于本项目范围；模型部署只通过 Model Gateway/Provider 管理，不参与知识库检索。
- Incident 的最终保留周期、外部模型 fallback、Kubernetes 和 OpenSearch Provider。

这些决策不改变 `KnowledgeBase → ready immutable Snapshot → QueryReceipt → Context Compiler` 的硬链路，也不能恢复“无知识库即可运行”或“整库注入模型”的旧表述。实现期间必须保持 ReplayAdapter、LocalAdapter、AccessPolicy、Evidence 和 Knowledge 契约稳定。

## 17. 当前完成度判定

本文件是实施契约，同时记录当前源码完成度。当前源码已经有 Ops 任务、权限、Evidence、本地/回放执行原型，以及单用户个人多知识库最小闭环：

- **已有原型：** Ops 状态机、稳定错误码、终态重试、租户隔离任务投影、动作幂等和乐观锁、SSE 游标重放与 `isReplay`、线程 `mode/taskPreset` 持久化、ReplayAdapter/LocalAdapter 执行、AgentLoop Harness 接入、预算/暂停/恢复/取消/失败收口、SecretRedactor 与 `EvidenceAttempt`、脱敏 Evidence 哈希与摘要、Evidence 查询、Patch 提案审批流、Incident 保存/查询/删除、隐藏 Inspector 时的 Thread Anchor Card。
- **已完成的个人知识库闭环：** 个人命名库、原生目录选择器产生的 canonical 授权凭据、不可变 Snapshot、SQLite FTS 增量发布、统一 `SecretRedactor`、跳过/截断统计、查询 Receipt 重放、快照保留与收据保护，以及 `knowledgeScope` 的服务端解析和任务固定绑定。知识库不读取当前项目路径，不按 tenant/workspace/scope 或列表顺序筛选；无显式选择不能进入 `queued`。桌面端提供全局个人知识库入口、创建、改名、停用、同步、页面预览、搜索验证和多选。
- **安全边界：** `SshAdapter` 当前明确拒绝未配置的远程环境；它不接受凭据、不拼接任意 Shell，也不会伪装成成功结果。远程连接、主机指纹和连接池仍需后续接入经过审查的 SSH 实现。LocalAdapter 只读工作区摘要，不执行命令或写文件。
- **仍需后续接入：** 真实 SSH 读取、完整进程/容器/日志/Git 结构化查询、独立 Evidence TTL 存储、Patch 写入 worktree、Patch 后测试联动、Wiki/Incident provider 与 Incident 全文检索。LocalCommandAdapter 当前只执行注册的类型检查/单元测试，不能扩展为任意命令。模型部署通过 Model Gateway/Provider 单独推进。
- **明确不属于当前承诺：** 常驻监控、告警自动触发、远程写入/重启/部署/自动修复、Kubernetes/云控制面和多 Agent 并行协同。

因此，当前结论是：**Ops 已具备“个人知识库硬前置”的本地/回放闭环，但不含远程运维能力。** 未显式选择个人知识库或所选快照未就绪时，任务必须显示 `OPS_KNOWLEDGE_REQUIRED`/`OPS_KNOWLEDGE_NOT_READY` 并保持 `blocked`；UI 不能把无快照任务显示为“运行中”。远程能力仍是显式未配置的安全边界。
