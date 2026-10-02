# Suanlizi 目标任务与动态工作流改造计划

状态：可实施草案（待按 P0/P1 分批落地）

日期：2026-09-19

本文收敛此前关于长程任务、Goal 模式、Dynamic Workflow、任务列表和 Claude Code Workflows 的讨论，作为 Suanlizi 后续实现依据。结论已按 Claude Code 官方文档校准：Dynamic Workflows 不是动态 DAG 图编辑器，而是受限 JavaScript 脚本运行时；Goal 是外层目标续跑与验收机制；二者可组合，但不应混为一谈。

## 1. 目标

把 Suanlizi 现有的 Harness、Workflow、监控面板统一为用户可理解、可管理、可恢复的目标任务系统，并补充 Claude Code 式 Dynamic Workflow 能力。

最终形成四层职责：

```text
Task                  用户可见的一等任务：目标、验收、状态、证据
  ├── GoalRun         目标续跑：持续朝目标推进，评估是否完成
  │     └── Harness   AgentLoop 外层循环、Evidence、Replan
  └── WorkflowRun     大规模并行编排：受限 JS 脚本 + 子代理
        └── AgentCall 独立子代理调用，结果保存在脚本变量/运行时状态
```

一句话职责划分：

- **Task 管目标**；
- **GoalRun / Harness 管持续逼近目标**；
- **WorkflowRun 管大规模并行执行**；
- **Evidence 管可信验收**。

## 2. 已澄清的概念边界

### 2.1 三种“动态”不是同一件事

| 概念 | 动态发生在哪 | 核心形态 | 适用问题 |
|---|---|---|---|
| Goal 模式 | 外层续跑控制 | 每轮后 GoalEvaluator 判断是否继续 | 明确终点和验收条件 |
| DyFlow 式计划演进 | 模型推理层 | 子目标序列 + 中间反馈 + replan | 复杂推理和计划调整 |
| Claude Code Dynamic Workflows | 系统运行时 | 受限 JavaScript 脚本编排子代理 | 大规模并行、上下文隔离、可复跑 |

此前方案中“模型输出结构化图变更，系统 diff 节点增删边”的动态 DAG 引擎路线停止实施。该路线复杂度高、模型输出易错，且不符合官方 Workflows 的核心价值。

### 2.2 Goal 与 Workflow 的关系

```text
Task
  ↓
GoalRun
  ↓
某个阶段适合并行处理
  ↓
启动 WorkflowRun
  ↓
WorkflowRun 返回结构化结果
  ↓
结果写入 Evidence
  ↓
GoalEvaluator 判断是否满足验收标准
  ↓
继续 / 完成 / 阻塞
```

约束：

- Goal 控制 Workflow，Workflow 不控制 Goal。
- Workflow 不判断最终目标是否完成，只返回中间结构化结果。
- Workflow 结果必须转为 Evidence，供 GoalEvaluator 使用。
- 需要用户决策时，Workflow 返回结构化结果并结束，由外层 GoalRun 暂停询问。
- Goal 不能无限触发大 Workflow，必须有预算和次数限制。

### 2.3 现有 Workflow 编辑器的定位

现有 `WorkflowDefinition` / `WorkflowPanel` 是可视化静态流程编辑器，继续保留为：

```text
Blueprint Workflow
    用户手工编排、需要图结构、确定性重跑的流程
```

不将其冒充为 Claude Code 式 Dynamic Workflow。后续新增：

```text
Script Workflow
    模型生成的受限 JavaScript 编排脚本
```

两者共用 Task / Run / Agent / Evidence 底座，但执行器不同。

## 3. 当前缺口

1. `Task` 不是一等实体：Harness 状态、Workflow 状态和监控面板各自维护状态。
2. `thread.tags` 中的 `harnessState:*` 和 `workflow` 快照是主要持久化形态，缺少独立事实来源。
3. 任务列表只是当前线程运行监控，不是跨线程任务中心。
4. Harness plan 缺少系统分配的稳定 step id 和版本化演进记录。
5. 模型声明步骤完成缺乏证据硬校验，`claimed` 与 `verified` 不区分。
6. Workflow 是静态图编辑器，没有受限脚本运行时、子代理并行编排、结构化输出和恢复。
7. 缺少暂停、恢复、重试、用户引导的结构化 API 与 UI。
8. 缺少 Goal 与 Workflow 的组合调度、预算治理和证据桥接。

## 4. 非目标

- 不实现模型输出节点/边增删的动态 DAG diff 引擎。
- 不实现树形子任务体系。
- 不把 Workflow 脚本暴露为任意 shell / Node 执行能力。
- 不做多人多租户任务管理。
- 不做常驻监控和自动触发。
- 不承诺 UI 进度百分比单调递增；进度显示“当前计划完成数/总数”。
- 第一版 WorkflowRun 不支持中途普通用户输入，仅支持权限等待和取消。

## 5. 核心设计

### 5.1 Task / Run 分离

Task 只表达目标层，Run 表达一次执行尝试。

```ts
export type TaskStatus =
  | 'pending'
  | 'running'
  | 'blocked'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type TaskRunKind = 'goal' | 'workflow';

export interface Task {
  id: string;
  threadId: string;
  objective: string;
  acceptanceCriteria: string[];
  status: TaskStatus;
  currentRunId?: string;
  runIds: string[];
  latestPlan?: TaskPlanVersion;
  evidenceIds: string[];
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  pendingInput?: PendingUserInput;
}

export interface TaskRun {
  id: string;
  taskId: string;
  threadId: string;
  kind: TaskRunKind;
  status:
    | 'queued'
    | 'running'
    | 'paused'
    | 'blocked'
    | 'completed'
    | 'failed'
    | 'cancelled'
    | 'interrupted';
  harnessRunId?: string;
  workflowRunId?: string;
  startedAt?: string;
  updatedAt: string;
  completedAt?: string;
  error?: string;
  checkpointId?: string;
}
```

规则：

- retry 创建新的 Run，不复活旧 Run。
- Task 管终态，Run 管过程态。
- 事件流按 Run 组织，UI 按 Task 聚合。
- 一个 Thread 同一时刻最多一个 active Task；一个 Thread 可有多个历史 Task。

### 5.2 计划投影与步骤状态

GoalRun 的计划作为 Harness 的投影，不作为第二执行引擎。

```ts
export type TaskStepStatus =
  | 'pending'
  | 'in_progress'
  | 'claimed'
  | 'verified'
  | 'failed'
  | 'skipped';

export interface TaskStep {
  id: string;             // 系统分配，模型不能生成或修改
  description: string;
  status: TaskStepStatus;
  evidenceIds: string[];
  dependsOn?: string[];
  failureReason?: string;
  startedAt?: string;
  completedAt?: string;
}

export interface TaskPlanVersion {
  version: number;
  createdAt: string;
  trigger: 'init' | 'replan' | 'redirect' | 'failure';
  steps: TaskStep[];
}
```

规则：

- 模型输出新计划时，已有步骤只能引用 id 并更新状态；新增步骤不携带 id，由系统补发。
- `claimed` 表示模型声明完成但没有证据；`verified` 表示至少挂有有效 Evidence。
- GoalEvaluator 和验收标准必须引用 Evidence，不能只信模型自述。
- replan 有预算、冷却和触发阈值，防止震荡循环。

```ts
export interface ReplanPolicy {
  maxReplansPerTask: number;
  minIntervalMs: number;
  triggerThreshold: number;
  tokenBudget: number;
}
```

### 5.3 用户输入与引导

```ts
export interface PendingUserInput {
  question: string;
  options?: string[];
  freeText: boolean;
  askedAt: string;
}
```

本地单用户场景不做超时自动推进。任务 blocked 时在任务中心展示待处理问题，用户回复后创建新 Run 或恢复当前 Run。

### 5.4 WorkflowScriptRuntime

新增受限脚本运行时，参考 Claude Code Workflows 的核心机制，而不是复制定价、平台和账号行为。

脚本示例：

```js
export const meta = {
  name: 'audit-auth-files',
  description: '扫描缺少鉴权检查的文件',
  phases: ['发现文件', '并行审计', '汇总']
}

phase('发现文件')

const found = await agent('找出可能包含鉴权检查的文件，返回文件路径列表。', {
  schema: {
    type: 'object',
    properties: {
      files: { type: 'array', items: { type: 'string' } }
    },
    required: ['files']
  }
})

phase('并行审计')

const audits = await pipeline(found.files, file =>
  agent(`审计 ${file} 是否缺少鉴权检查，返回风险和证据。`, {
    label: file,
    schema: {
      type: 'object',
      properties: {
        file: { type: 'string' },
        risk: { type: 'string', enum: ['low', 'medium', 'high'] },
        issue: { type: 'string' },
        evidence: { type: 'array', items: { type: 'string' } }
      },
      required: ['file', 'risk', 'issue', 'evidence']
    }
  })
)

return audits.filter(Boolean)
```

运行时 API：

```ts
export interface WorkflowRuntimeApi {
  agent(prompt: string, options?: WorkflowAgentOptions): Promise<unknown | null>;
  pipeline<T, R>(
    items: readonly T[],
    worker: (item: T, index: number) => Promise<R | null>,
  ): Promise<Array<R | null>>;
  parallel(
    tasks: Array<() => Promise<unknown | null>>,
  ): Promise<Array<unknown | null>>;
  phase(title: string): void;
  log(message: string): void;
  args?: unknown;
}
```

脚本限制：

- 禁止 `import()` 和模块加载。
- 禁止直接文件系统、shell、process、网络访问。
- 禁止 `Date.now()`、`Math.random()`、无参数 `new Date()`。
- 只允许 `agent`、`pipeline`、`parallel`、`phase`、`log`、`args`。
- 脚本本身只编排，不执行副作用；子代理通过既有工具和权限系统执行。
- 必须先通过静态校验和用户批准，再进入后台运行。

运行限制：

```ts
export interface WorkflowRuntimeLimits {
  maxConcurrentAgents: number;
  maxAgentsPerRun: number;
  maxItemsPerPipeline: number;
  maxTotalTokens: number;
  maxDurationMs: number;
  requireApproval: boolean;
}
```

第一版建议默认值：

```text
maxConcurrentAgents = 4
maxAgentsPerRun = 50
maxItemsPerPipeline = 500
maxDurationMs = 30 分钟
requireApproval = true
```

### 5.5 Workflow 恢复模型

每个 `agent()` 调用必须有稳定 ID：

```text
agentCallId = hash(scriptHash + callPath + prompt + args + index)
```

恢复规则：

- 已完成且前序输入未变的调用，直接返回保存结果。
- 前序输入变化或脚本变化的调用，重新执行。
- 停止时仍在运行的调用，恢复时重新执行。
- 子代理进程未退出前，不允许启动同一脚本的重复运行。

```ts
export interface WorkflowRunRecord {
  id: string;
  taskRunId: string;
  script: string;
  scriptHash: string;
  args?: unknown;
  status: WorkflowRunStatus;
  agentCalls: WorkflowAgentCall[];
  usage: WorkflowUsage;
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
}

export interface WorkflowAgentCall {
  id: string;
  label?: string;
  prompt: string;
  model?: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'blocked' | 'cancelled';
  result?: unknown;
  error?: string;
  inputTokens: number;
  outputTokens: number;
  startedAt?: string;
  completedAt?: string;
}
```

### 5.6 内存与上下文边界

Workflow 解决的是“中间结果不进入主会话上下文”，不是“大任务不占进程内存”。

必须继续执行：

- 子代理返回结构化摘要，不返回无约束全文。
- 超大结果落盘或存库，脚本变量只保留引用和摘要。
- 分批执行，避免一次性构造超大数组。
- Agent 调用结果持久化，恢复时从存储读取。
- 并发、总量、token、时长全部受运行限制约束。

## 6. 模块与文件规划

### 6.1 协议层

新增：

```text
packages/protocol/src/task.ts
```

导出：

- `Task`
- `TaskRun`
- `TaskStatus`
- `TaskRunKind`
- `TaskStep`
- `TaskPlanVersion`
- `PendingUserInput`
- `ReplanPolicy`
- `WorkflowRuntimeLimits`
- `WorkflowAgentCall`
- `WorkflowRunRecord`

更新：

```text
packages/protocol/src/index.ts
packages/protocol/src/schemas.ts
```

要求：

- 提供稳定 JSON schema 和兼容性测试。
- 不把 UI 结构放进 protocol。

### 6.2 存储层

新增：

```text
packages/storage/src/taskStore.ts
packages/storage/src/taskStore.test.ts
```

表：

```sql
tasks (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  objective TEXT NOT NULL,
  acceptance_criteria TEXT NOT NULL,
  status TEXT NOT NULL,
  current_run_id TEXT,
  latest_plan TEXT,
  evidence_ids TEXT NOT NULL DEFAULT '[]',
  pending_input TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
)

task_runs (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  harness_run_id TEXT,
  workflow_run_id TEXT,
  checkpoint_id TEXT,
  error TEXT,
  started_at TEXT,
  updated_at TEXT NOT NULL,
  completed_at TEXT
)

workflow_runs (
  id TEXT PRIMARY KEY,
  task_run_id TEXT NOT NULL,
  script TEXT NOT NULL,
  script_hash TEXT NOT NULL,
  args TEXT,
  status TEXT NOT NULL,
  usage TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
)

workflow_agent_calls (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  label TEXT,
  prompt TEXT NOT NULL,
  model TEXT,
  status TEXT NOT NULL,
  result TEXT,
  error TEXT,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  started_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)
```

职责：

- SQLite / WAL 是 Task、Run、WorkflowRun、AgentCall 的单一事实来源。
- `thread.tags` 中的 Harness / Workflow 状态降级为兼容读取缓存，逐步迁移。
- 启动时扫描非终态 Run，根据 checkpoint 决定恢复或标记 `interrupted`。

### 6.3 Runtime 层

新增：

```text
packages/runtime/src/task/
  taskLifecycle.ts
  planProjection.ts
  taskLifecycle.test.ts
  planProjection.test.ts

packages/runtime/src/workflowScript/
  types.ts
  scriptValidator.ts
  scriptRuntime.ts
  agentCallRecorder.ts
  resume.ts
  scriptValidator.test.ts
  scriptRuntime.test.ts
  resume.test.ts
```

更新：

```text
packages/runtime/src/harness/taskHarness.ts
packages/runtime/src/harness/goalTracker.ts
packages/runtime/src/agent.ts
packages/runtime/src/index.ts
```

职责：

- `taskLifecycle`：创建 Task/Run、状态迁移、终态落库。
- `planProjection`：把 Harness plan 转成系统分配 id 的 TaskPlanVersion，生成 diff。
- `scriptValidator`：语法、白名单、meta、随机/时间调用、资源限制静态校验。
- `scriptRuntime`：执行受限脚本，调度子代理，记录 AgentCall 和 usage。
- `agentCallRecorder`：持久化每次 Agent 调用结果，生成稳定 agentCallId。
- `resume`：按 scriptHash、callPath、前序结果决定复用或重跑。

安全要求：

- 不使用未加固的 `node:vm` 作为唯一安全边界。
- 使用 AST 白名单 + 运行时 API 注入 + 资源上限 + 权限审批。
- Agent 执行沿用现有工具权限体系，不新增旁路。

### 6.4 API 层

新增：

```text
apps/api/src/routes/taskRoute.ts
apps/api/src/routes/taskRoute.test.ts
```

接口：

```text
GET    /api/tasks
GET    /api/tasks/:id
POST   /api/tasks
POST   /api/tasks/:id/start
POST   /api/tasks/:id/pause
POST   /api/tasks/:id/resume
POST   /api/tasks/:id/cancel
POST   /api/tasks/:id/retry
POST   /api/tasks/:id/redirect
POST   /api/tasks/:id/input
GET    /api/tasks/:id/evidence
GET    /api/tasks/:id/runs
GET    /api/tasks/:id/plan-history

POST   /api/workflows/script/validate
POST   /api/workflows/script/run
GET    /api/workflows/runs/:id
POST   /api/workflows/runs/:id/pause
POST   /api/workflows/runs/:id/resume
POST   /api/workflows/runs/:id/cancel
```

要求：

- 服务端校验状态迁移和权限，不信任客户端状态。
- 每个终态都有明确事件。
- 失败返回结构化错误并写入可追踪错误记录。
- Workflow 脚本必须先 `validate`，再经过用户批准，再 `run`。

### 6.5 Web / Desktop UI

新增（两端同步）：

```text
apps/web/src/features/tasks/
apps/desktop/src/features/tasks/

apps/web/src/components/tasks/
apps/desktop/src/components/tasks/
  TaskCenter.tsx
  TaskList.tsx
  TaskDetailPanel.tsx
  TaskPlanTimeline.tsx
  TaskEvidencePanel.tsx
  TaskRunHistory.tsx
  TaskCreateDialog.tsx
  PendingUserInputCard.tsx

apps/web/src/components/workflowScript/
apps/desktop/src/components/workflowScript/
  WorkflowScriptViewer.tsx
  WorkflowScriptApprovalDialog.tsx
  WorkflowRunMonitor.tsx
  WorkflowAgentCallList.tsx
```

界面要点：

- 左侧任务列表，右侧任务详情。
- 状态：运行中、已阻塞、已完成、失败、已取消。
- 步骤区分 `claimed` 与 `verified`。
- 进度显示 `3/6 步骤（基于当前计划）`。
- 显示当前 Run、迭代次数、证据数量、最近事件。
- 阻塞任务显示结构化待用户输入卡片。
- Workflow 脚本运行前必须展示脚本、阶段、预计规模和资源限制，并要求批准。
- 运行中展示阶段、agent 调用、失败原因、token 消耗，可停止。
- 不使用粗边、毛玻璃、大面积阴影或装饰性视觉。

## 7. 分阶段实施

### P0：Task / Run / Evidence 地基（第 1 周）

目标：任务能创建、记录、查询，状态可持久化。

- 新增 `packages/protocol/src/task.ts`。
- 新增 SQLite 表和 `taskStore.ts`。
- 新增 `/api/tasks` 基础 CRUD 与查询。
- Harness 启动时自动创建 Task 和 TaskRun。
- `thread.tags` 继续兼容，但写入以 task 表为准。

验收：

- taskStore 单元测试覆盖创建、更新、终态、查询。
- API 测试覆盖 404、非法状态迁移、成功响应。
- 启动一个 Harness run 后能从 `/api/tasks` 查询到对应 Task。

### P1：任务中心只读 UI（第 2 周）

目标：先让用户看到真实任务，而不是做假 UI。

- Web / Desktop 新增任务中心。
- 展示任务列表、状态、当前 Run、步骤、证据数量。
- 支持点击进入对应 Thread。
- 暂不提供操作按钮，只读。

验收：

- 两端组件测试通过。
- 使用 Playwright 打开实际页面，断言任务列表、详情、空状态和点击跳转。
- 无遮挡、无溢出。

### P2：生命周期与用户接管（第 3 周）

目标：任务从“可见”变为“可控”。

- pause / resume / cancel / retry。
- 用户输入结构和 blocked 展示。
- redirect 将用户修改注入 Evidence 并触发新 Run。
- API 服务端状态机校验。
- SSE 终态事件。

验收：

- 覆盖正常、取消、暂停、恢复、失败、重试和非法状态迁移。
- AbortSignal 穿透到工具和子代理执行层。
- 断线后重新拉取任务状态，不显示空白。

### P3：计划投影与证据硬校验（第 4 周）

目标：让 GoalRun 的计划可信、可演进、可审计。

- Harness plan 转为 TaskPlanVersion。
- 系统分配 step id。
- 模型新计划 diff：added / removed / modified。
- 区分 claimed / verified。
- replan 预算、冷却和触发阈值。
- Evidence 挂接验收标准。

验收：

- 模型引用不存在 id、制造循环依赖、输出非法状态时被拒绝。
- claimed 步骤无法升级为 verified，除非存在有效 Evidence。
- 回放测试覆盖真实 run 输出序列。

### P4：WorkflowScriptRuntime MVP（第 5-6 周）

目标：支持受限 JS 脚本编排子代理。

- 脚本生成提示词。
- AST / 静态校验。
- 用户批准界面。
- `agent` / `pipeline` / `parallel` / `phase` / `log` / `args`。
- 结构化输出 schema 校验。
- 并发、总量、token、时长限制。
- AgentCall 持久化和进度事件。

验收：

- 非法脚本、import、fs/shell、随机时间调用全部拒绝。
- 并发不超过配置。
- 取消能穿透子代理。
- 结构化输出失败可追踪。
- 运行中不阻塞主会话。

### P5：Workflow 恢复与复用（第 7 周）

目标：大任务可中断、可恢复、可复用。

- scriptHash、agentCallId 稳定生成。
- AgentCall 结果持久化。
- 恢复时按前序结果决定复用或重跑。
- 脚本保存、查看、对比、编辑后重新运行。
- 大任务警告和成本统计。

验收：

- 编辑脚本后，受影响前缀之后的 AgentCall 重跑。
- 已完成且未受影响的 AgentCall 直接复用。
- 子代理未退出时拒绝重复启动。
- 进程重启后能恢复或标记 interrupted。

### P6：Goal 与 Workflow 组合（第 8 周）

目标：形成完整闭环。

- GoalRun 可在合适阶段启动 WorkflowRun。
- WorkflowRun 结果写入 Evidence。
- GoalEvaluator 消费 Workflow 结构化结果。
- Task 可以包含多个 Run：GoalRun → WorkflowRun → GoalRun。
- 防止 Goal 无限触发大 Workflow。

验收：

- 全链路 API 测试。
- 真实 UI 点击：创建任务、运行、查看进度、停止、恢复、查看证据、完成任务。
- 失败路径：模型失败、Workflow 脚本非法、Agent 取消、断线、进程重启。

## 8. 迁移与兼容

1. 现有 `harnessState:*` 状态继续可读，用于启动时回放和历史兼容。
2. 新状态写入 task 表后，`thread.tags` 只写摘要缓存，不作为事实来源。
3. 现有 `WorkflowDefinition` 项目继续使用 Blueprint Workflow，不强制迁移。
4. 新增 Script Workflow 与 Blueprint Workflow 并存，由 `TaskRun.workflowKind = 'blueprint' | 'script'` 区分；`TaskRun.kind` 只区分 GoalRun 与 WorkflowRun。
5. API 保留现有 `/harness/*` 和 `/workflow/*` 端点，新增 `/tasks/*` 不破坏旧客户端。
6. 数据迁移使用版本号和幂等脚本，不手改 SQLite 生成数据。

## 9. 风险与对策

| 风险 | 对策 |
|---|---|
| Workflow 脚本沙箱逃逸 | AST 白名单、API 注入、无 import、无 fs/shell、权限审批、资源上限 |
| 模型输出非法计划 | 系统分配 id、引用校验、状态机校验、非法输出拒绝 |
| 双写状态不一致 | SQLite 为事实来源，tags 降级缓存，启动扫描 interrupted |
| Workflow 内存膨胀 | 结构化摘要、分批、结果落盘、总量限制 |
| Goal 无限续跑 | maxContinuations、maxNoProgress、ReplanPolicy、Workflow 次数预算 |
| 取消不彻底 | AbortSignal 穿透到工具和子代理，运行时等待清理 |
| UI 变成假任务面板 | 只使用真实 Task / Run / Evidence 数据，不做本地模拟状态 |
| 与现有大量未提交改动冲突 | 每阶段只改明确文件，提交前检查 diff，不做无关重构 |

## 10. 完成标准

本计划完成时必须满足：

1. Task / Run / Evidence / WorkflowAgentCall 有稳定协议和持久化表。
2. 任务中心可跨线程查看任务状态、计划、证据、运行历史。
3. 暂停、恢复、取消、重试、用户输入、redirect 均走服务端状态机。
4. GoalRun 的计划演进有版本记录，步骤完成必须证据化。
5. WorkflowScriptRuntime 只执行通过静态校验和用户批准的受限脚本。
6. WorkflowRun 结果可作为 Evidence 被 GoalEvaluator 使用。
7. 正常、失败、取消、超时、断线、进程重启路径均有测试。
8. Web 和 Desktop 两端同步，不引入遮挡、粗边或无效介绍性 UI。
9. 不修改生成物，不留下临时文件和后台进程。
## 11. 复查后的必要修正（P0）

本节并入 P0 约束，先完成以下三条再实施后续阶段。

### 11.1 复用现有 OpsTask 状态机资产

项目已有 `packages/protocol/src/opsTask.ts`，包含：

- `OPS_TASK_STATES`
- `OPS_TASK_TRANSITIONS`
- `OPS_TASK_TERMINAL_STATES`
- `validateOpsTaskVersion`
- `createOpsTaskRetry`
- 独立错误码族

本计划的 Task / TaskRun 不得另起一套平行状态机。P0 应先抽取通用 `taskStateMachine.ts`，复用：

- 状态迁移表
- 乐观锁校验
- 终态判定
- 幂等重试关系

OpsTask 仍作为运维域的既有实体保留；新 Task 为通用目标任务实体。二者共用状态机资产，避免迁移表、错误码和 UI 状态语义分裂。

### 11.2 明确与现有 Agent Checkpoint 的整合

现有 Agent 层已有独立 Checkpoint 机制，包含：

- `Checkpoint`
- `CheckpointStatus`
- `ThreadRuntimeState`
- `RUNNING_CHECKPOINT_TTL_MS`
- `waiting_user_input`
- `stale / interrupted / failed`
- `getLastCheckpoint(threadId)`

`TaskRun.checkpointId` 必须指向现有 Agent Checkpoint，不得新建一套运行时恢复机制。

恢复顺序固定为：

```text
读 task_runs.checkpointId
  ↓
读取对应 Agent Checkpoint
  ↓
按 checkpoint.executionStatus / decisionRequest 决定：
  running        → resume
  stopping       → 继续停止并等待子进程退出
  waiting_user   → 还原 pending decision
  terminal       → 落 TaskRun 终态
  stale/interrupted → 标记 interrupted
  ↓
以 Agent Checkpoint 结果为准回写 task_runs
```

禁止在 Task 表与 Agent Checkpoint 之间各写一份恢复真相。

### 11.3 Workflow 证据回流路径

现有 `EvidenceReceipt` 强绑定：

- `threadId`
- `turnId`
- `itemId`

而 `WorkflowAgentCall` 独立于普通 ThreadItem，不一定具有 `turnId / itemId`。

P0 必须扩展 Evidence 承载形式，新增 Workflow 结果证据：

```ts
export type WorkflowEvidenceSource =
  | { kind: 'workflow_run'; runId: string }
  | { kind: 'workflow_agent_call'; runId: string; agentCallId: string };

export interface WorkflowAgentCall {
  // 原字段保持不变
  id: string;
  label?: string;
  prompt: string;
  model?: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'blocked' | 'cancelled';
  result?: unknown;
  error?: string;
  inputTokens: number;
  outputTokens: number;
  startedAt?: string;
  completedAt?: string;

  // 新增
  evidenceId?: string;
  threadItemId?: string;
}
```

WorkflowRun 完成或 AgentCall 结构化输出通过 schema 校验后：

1. 将结构化结果写入 workflow result 存储。
2. 生成 `workflow_result` 类型 Evidence。
3. `refs` 保存 `runId + agentCallId`。
4. GoalEvaluator 只消费 Evidence，不直接消费脚本变量。
5. 若 Evidence 生成失败，WorkflowRun 标记 `failed`，不得静默降级为普通文本总结。

### 11.4 TaskRun 状态迁移表

P0 落地时必须定义唯一迁移表，不依赖散落 if/else。建议：

```ts
export const TASK_RUN_TRANSITIONS = {
  queued: ['running', 'blocked', 'cancelled', 'failed'],
  running: ['paused', 'blocked', 'cancelled', 'failed'],
  paused: ['running', 'cancelled', 'failed'],
  blocked: ['queued', 'cancelled', 'failed'],
  interrupted: ['running', 'queued', 'cancelled', 'failed'],
  completed: [],
  cancelled: [],
  failed: []
} as const;
```

补充规则：

- `blocked → queued` 表示等待用户输入后重新排队。
- `interrupted` 恢复前必须核对 Agent Checkpoint。
- 终态无出口。
- `retry` 只创建新 Run，不修改旧 Run 终态。

## 12. 复查后的必要修正（P1）

### 12.1 GoalRun 触发 WorkflowRun 的机制

不允许 GoalEvaluator 隐式触发 WorkflowRun。统一采用显式工具请求：

```ts
export interface WorkflowScriptRequest {
  taskId: string;
  goalRunId: string;
  objective: string;
  proposedScript: string;
  estimatedAgents: number;
  estimatedTokens: number;
  limits: WorkflowRuntimeLimits;
}
```

触发链路：

```text
Harness 续跑
  ↓
模型调用 workflow_script_request 工具
  ↓
scriptValidator 静态校验
  ↓
生成 WorkflowScriptRequest
  ↓
用户批准
  ↓
创建 WorkflowRun
  ↓
结果生成 Evidence
  ↓
回到 GoalEvaluator
```

用户也可在任务中心手动创建 WorkflowRun，但同样必须通过静态校验和批准。

### 12.2 planProjection 的触发契约

当前 `GoalTracker.updatePlan(nodes)` 直接接收模型生成节点，尚未提供稳定 id 校验和补发能力。P3 必须新增：

```text
Harness continuation 输出 plan snapshot
  ↓
planProjection.normalize
    - 已有 id 校验
    - 非法 id 拒绝
    - 新步骤补发系统 id
    - 状态合法性校验
  ↓
TaskPlanVersion diff
  ↓
GoalTracker.updatePlan(normalizedPlan)
```

触发点：

- 初始 GoalRun 启动时。
- GoalEvaluator 返回 `continue` 后。
- 用户 redirect 后创建新 Run 前。
- 失败重试前继承历史计划并允许调整。

### 12.3 Workflow 脚本沙箱负向测试

P4 验收必须包含 AST 白名单绕过用例：

- `agent['constructor']`
- `({}).constructor`
- `Function` / `eval` 动态构造
- 模板字符串拼接后调用受限 API
- 逗号表达式包裹 `import()`
- `this` 指针逃逸
- 原型链污染
- getter/setter 间接访问
- 异步回调中构造受限标识符
- 脚本内修改 `agent` / `pipeline` / `parallel` 引用

任何绕过尝试都必须在静态校验或运行时 API 层被拒绝，不得依赖沙箱隐式失败。

## 13. 复查后的 API 与排期修正

### 13.1 API 补充

新增：

```text
GET /api/tasks/:id/goal-status
GET /api/workflows/runs/:id/result
GET /api/workflows/runs/:id/evidence
```

`goal-status` 返回最近一次 GoalEvaluation 摘要：

```ts
export interface TaskGoalStatusResponse {
  taskId: string;
  runId?: string;
  evaluation?: GoalEvaluation;
  passedCriteria: string[];
  failedCriteria: string[];
  blocker?: string;
  evidenceIds: string[];
}
```

Workflow 结果回填必须产生事件：

```text
workflow.result.created
workflow.evidence.created
task.goal.evaluation.available
```

### 13.2 排期调整

- P0 增加：
  - OpsTask 状态机复用方案。
  - Agent Checkpoint 整合方案。
  - Evidence 承载 WorkflowRun 结果的扩展。
  - AbortSignal 在 Harness、Agent、工具、子代理链路中的现状盘点。
- P4 拆分：
  - P4a：WorkflowScriptRuntime 后端 MVP（脚本生成、校验、执行、限制、持久化）。
  - P4b：批准 UI、监控 UI、运行历史 UI。
- P5 依赖 P4a 完成。
- P6 依赖 P5 和 P3 完成。

修订后：

```text
P0  Task / Run / Evidence / 状态机 / Checkpoint / AbortSignal 盘点
P1  任务中心只读 UI
P2  生命周期与用户接管
P3  计划投影与证据硬校验
P4a WorkflowScriptRuntime 后端 MVP
P4b Workflow 批准与监控 UI
P5  Workflow 恢复与复用
P6  Goal 与 Workflow 组合
```

## 14. Kimi K3 第二轮复查修正（P0 动工前必须并入）

本节吸收 2026-09-19 第二轮 Kimi K3 xhigh 复查结论。确认项不再重复：三种“动态”分层、Task / Run 分离、OpsTask 状态机复用、Agent Checkpoint 整合、Workflow 证据物化、`claimed / verified` 双态、受限 JS 沙箱路线、P4a/P4b 拆分均维持不变。以下问题必须在对应阶段落实。

### 14.1 GoalEvaluator 与现有 GoalTracker 的融合点（P0）

不新增第二套 GoalEvaluator 双轨。实现原则：

- 现有 `GoalTracker` 与 `GoalEvaluation` 仍是评估状态的唯一载体。
- P3 的证据硬校验作为 `GoalTracker.recordEvaluation` 之前的 gate：先按 acceptanceCriteria / Evidence 校验 evaluation，再决定是否接受、降级或拒绝。
- `GoalEvaluation.status = 'needs_user_input'` 必须映射为 `TaskRun.blocked` + 结构化 `PendingUserInput`；`blocked` 映射为 `TaskRun.blocked` + blocker；`satisfied / continue` 才允许驱动完成或继续。
- Workflow 结果不直接进入 GoalTracker，只通过 `workflow_result` Evidence 参与 gate。

### 14.2 HarnessPlanNode 与 TaskStep 状态映射（P0 协议 / P3 实现）

`HarnessPlanNode` 保持现有四态，不扩成六态；六态只在 `TaskStep` 展示层和验收层存在，由 `planProjection` 派生：

| HarnessPlanNode.status | Evidence 结果 | TaskStep.status |
|---|---|---|
| pending | - | pending |
| in_progress | - | in_progress |
| completed | evidenceIds 非空且 Evidence 有效 | verified |
| completed | 无证据或 Evidence 无效 | claimed |
| failed | - | failed |
| - | 用户或系统显式跳过 | skipped |

规则：

- 模型声明 `completed` 时，投影层不能直接写 `verified`。
- `claimed` 是可显示但不可验收的状态。
- `skipped` 不允许由模型声明为绕过验收的手段，必须由用户 redirect / 明确策略触发。

### 14.3 取消链落地约束（P0 设计，P2 验收）

P0 不只做盘点，必须产出取消链设计并纳入实现：

- 每个 `TaskRun` 持有根 `AbortController`。
- GoalRun、WorkflowRun、AgentCall、工具调用、子代理执行均从根 signal 派生 cancellation scope。
- 父级取消必须同步传播到全部后代；局部 cancel 不得取消同 TaskRun 下无关分支。
- `WorkflowAgentCall` 持久化等价取消标识，恢复时能识别 `cancelled` / `interrupted`。
- 所有等待点（模型流、工具执行、子代理、持久化写入）必须响应 abort 并落终态事件。
- P2 验收必须覆盖 GoalRun → WorkflowRun → AgentCall → tool 的完整取消链，而不是只测 Harness 循环层。

### 14.4 claimed 的下游纠错路径（P1）

Goal gate 读取到 `claimed` 时：

1. 首次：返回 `continue`，并注入“该步骤缺证据，必须补 Evidence 或说明阻塞原因”的反馈。
2. 连续多次仍为 `claimed`：计入 `noProgressCount`。
3. 达到阈值：转 `blocked`，带结构化 blocker，禁止无限重试。
4. `claimed` 不能作为 acceptanceCriteria 满足依据，也不能直接升级为 `verified`。

### 14.5 大结果句柄与恢复（P4a）

解决“内存边界”和“恢复需要结果参与计算”的张力：

- `agent()` 返回给脚本的是 `ResultHandle`，包含 resultId、hash、summary、size、schemaRef，不返回无约束全文。
- `callPath` 与结果 hash 共同决定恢复复用；调用输入或结果 hash 变化则不复用。
- 脚本只能通过受限 API 分批 / 流式消费结果，不允许把大结果展开为整数组。
- 传给下一个 agent 的结果由运行时按 handle 从存储解析并裁剪，不进入 JS 主堆。
- 恢复时只恢复 handle 与调度状态，不预载全部历史结果。

### 14.6 thread.tags 与 task 表的迁移过渡（P0/P1）

- 影子写期：以现有 `thread.tags` 为读优先，task 表影子写，用于对账。
- 切换期：task 表成为事实来源，tags 只写摘要缓存。
- 切换通过 schema version / 迁移完成标记控制，不允许长期双真相。
- 对账脚本必须幂等，只修正 task 表，不改写 tags；重复执行结果一致。
- 保留一次性回滚路径：切换失败时可回到 tags 读优先，但不得丢终态和 checkpoint 关联。

### 14.7 P0 验收补充

P0 除原文验收外还必须包含：

- `taskStateMachine.ts` 抽取后，OpsTask 既有全部单元测试零回归。
- 新状态机测试覆盖非法迁移、终态无出口、乐观锁、retry 新建 Run。
- Agent Checkpoint 恢复顺序测试覆盖 running / stopping / waiting_user_input / terminal / stale。
- AbortSignal 链路设计评审通过，并标出当前断点与 P2 修复项。
- 评估现行 `packages/runtime/src/workflow.ts` Blueprint runner 的存储 / API 影响面，确保 Script Workflow 不与其冲突。

### 14.8 Blueprint / Script 子类型（P0 协议）

`TaskRunKind = 'goal' | 'workflow'` 不承担 Workflow 子类型语义。新增：

```ts
export type WorkflowKind = 'blueprint' | 'script';

export interface TaskRun {
  // ...
  kind: 'goal' | 'workflow';
  workflowKind?: WorkflowKind;
}
```

Blueprint Workflow 与 Script Workflow 可复用 TaskRun，但数据层必须可区分。

### 14.9 集中事件目录（P0 协议）

事件名、payload、时序必须集中在 `packages/protocol/src/task.ts` 或事件契约模块中定义，并纳入 schema 兼容性测试。至少覆盖：

- `task.created / updated`
- `task.run.created / updated / terminal`
- `task.goal.evaluation.available`
- `task.plan.version.created`
- `task.user_input.required / resolved`
- `workflow.request.created / approved / rejected`
- `workflow.run.created / updated / terminal`
- `workflow.agent_call.updated / terminal`
- `workflow.result.created`
- `workflow.evidence.created`

所有 terminal 状态必须有终态事件；SSE 断线后可通过任务查询 API 恢复最终状态。

### 14.10 WorkflowScriptRequest 与脚本生成的关系（P4b）

- 5.4 的脚本生成提示词产物就是 `WorkflowScriptRequest.proposedScript` 的来源。
- 用户可以编辑脚本后再批准，但编辑后的脚本必须重新通过 `scriptValidator` 静态校验。
- 批准界面向用户展示原始脚本与编辑后脚本的 diff。
- 批准后脚本内容与 `scriptHash` 固化，不允许运行时变更；如需修改必须创建新的 WorkflowScriptRequest / WorkflowRun。

### 14.11 其他补充

- `Task.interactionMode?: 'autonomous' | 'interactive' | 'supervised'` 作为协议占位，第一版默认 `supervised`，不实现三套完整执行策略。
- 风险表新增：
  - 评估幻觉：模型把 `claimed` 当成已验收；对策为 Evidence gate 与 noProgress 联动。
  - 资源竞态：多个 WorkflowRun 并发；第一版全局同时只允许一个 WorkflowRun 运行。
- Goal 预算新增 `maxWorkflowRunsPerGoal`，与 `ReplanPolicy` 并列，防止无限触发大规模 Workflow。