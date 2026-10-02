# Task Harness Engine 实施计划

> 目标：在现有 AgentLoop 之上构建可验证、可暂停、可恢复、可裁切上下文的 HarnessLoop。
>
> 核心原则：**不要先追求复杂 workflow loop；先把 AgentLoop 外面套出一个可验证、可暂停、可恢复、可裁切上下文的 HarnessLoop。**

## 一、架构总览

```
用户开启 harness 模式
  → GoalTracker.setGoal(objective, acceptanceCriteria)
  → HarnessLoop 启动
    → HarnessContextManager.buildIterationContext()  [构造任务包]
    → AgentLoop.runTurn()                             [现有，最小改动]
      → model → tools → model → ... → final answer
    → EvidenceLedger.recordTurn()                      [收集本轮证据]
    → ReadinessCritic.check()                          [确定性规则 gate]
      → 不通过 → 注入 retry instruction → 继续 AgentLoop
      → 通过 → 继续
    → StormBreaker.check()                             [死循环检测]
    → GoalEvaluator.evaluate()                         [独立模型验收]
      → satisfied → 结束
      → goal_not_met_yet → Replanner
      → needs_user_input / blocked → 暂停
    → Replanner.makeContinuation()                     [隐藏续跑]
      → 无进展检测 → 连续 2 轮无变化 → 暂停
    → 回到 buildIterationContext()
  → max_continuations (8) 到达 → 暂停
```

### 分层职责

```
HarnessLoop (跨 turn 自主循环)
  ├── HarnessContextManager   — 上下文裁切核心
  ├── EvidenceLedger           — 工具调用收据索引层
  ├── GoalTracker              — 目标状态、续跑计数、signature
  ├── ReadinessCritic           — 确定性规则 gate（先规则后模型）
  ├── GoalEvaluator             — 独立模型语义验收
  ├── StormBreaker              — 死循环检测
  └── Replanner                 — 隐藏续跑消息生成

AgentLoop (单 turn tool loop，现有，最小改动)
  └── 支持 harness hidden input + 工具执行后回调 EvidenceLedger
```

### 与现有代码的关系

| 现有模块 | 角色 | 改动方式 |
|---------|------|---------|
| `AgentLoop` (agent.ts) | subtask 执行器 | 最小侵入：支持 hidden input source + 工具执行后回调 |
| `ThreadStore` (store.ts) | 持久化层 | 不改，EvidenceLedger 在其上建索引 |
| `ThreadItem` (types.ts) | 条目类型 | 新增 `harness_continuation` 类型 |
| `RunProfile` (runProfile.ts) | 运行参数 | 扩展枚举，增加 `harness` |
| `compactThread` (memory.ts) | 上下文压缩 | 不改，HarnessContextManager 在其上层做裁切 |
| `WorkflowDefinition` (workflow.ts) | DAG 状态机 | MVP 阶段不改，后续才接入 loopBoundaries |

## 二、核心数据结构

### 2.1 HarnessState — 结构化任务状态

```typescript
// packages/runtime/src/harness/types.ts

interface HarnessGoal {
  objective: string;
  acceptanceCriteria: string[];
  maxContinuations: number;      // 默认 8
  maxNoProgress: number;          // 默认 2
}

interface HarnessPlanNode {
  id: string;
  description: string;
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  evidenceIds: string[];          // 支撑该节点的证据 ID
  failureReason?: string;
}

interface HarnessState {
  goal: HarnessGoal;
  plan: HarnessPlanNode[];
  activeNodeId: string | null;
  iteration: number;               // 当前续跑次数
  noProgressCount: number;        // 连续无进展次数
  lastEvaluation: GoalEvaluation | null;
  lastProgressSignature: string | null;
  status: 'active' | 'satisfied' | 'blocked' | 'max_continuations' | 'no_progress';
  startedAt: string;
  updatedAt: string;
}
```

### 2.2 EvidenceReceipt — 证据收据（索引层，不存全量）

```typescript
interface EvidenceReceipt {
  id: string;
  threadId: ThreadId;
  turnId: TurnId;
  itemId: ItemId;                  // 指向原始 ThreadItem
  harnessRunId: string;
  kind: 'tool' | 'file_change' | 'command' | 'test' | 'checkpoint' | 'mcp' | 'error';
  summary: string;                 // 简短摘要
  refs: {
    path?: string;                 // 文件路径
    command?: string;              // 执行的命令
    toolName?: string;             // 工具名
    hash?: string;                 // 内容哈希
  };
  supportsCriteria: string[];      // 支撑哪些验收标准
  status: 'passed' | 'failed' | 'unknown';
  timestamp: string;
}
```

**关键设计**：EvidenceLedger **不重复存全量内容**，只存索引和收据。原始内容通过 `itemId` 从 `ThreadStore.getItems()` 获取。

### 2.3 GoalEvaluation — 验收评估结果

```typescript
interface GoalEvaluation {
  satisfied: boolean;
  status: 'satisfied' | 'continue' | 'needs_user_input' | 'blocked';
  passedCriteria: string[];
  failedCriteria: string[];
  blocker?: string;
  nextHint?: string;
  evidenceSummary: string;
  progressSignature: string;      // 用于无进展检测
  reasoning: string;
}
```

`progressSignature` 组成：
```
SHA256(failedCriteria.sort().join('|') + completedNodeIds.sort().join('|') + newEvidenceIds.sort().join('|') + lastBlocker)
```

### 2.4 HarnessContinuationItem — 隐藏续跑条目

```typescript
// 新增 ThreadItem 类型，不伪装成 user_message
interface HarnessContinuationItem {
  id: ItemId;
  type: 'harness_continuation';
  turnId: TurnId;
  harnessRunId: string;
  iteration: number;
  objective: string;
  instruction: string;            // 给模型的续跑指令
  evaluation: GoalEvaluation;     // 上次评估结果
  visibleToUser: false;           // UI 不显示，run monitor 可审计
  timestamp: string;
}
```

### 2.5 HarnessContextSlice — 迭代上下文任务包

```typescript
interface HarnessContextSlice {
  // Stable Context（尽量稳定，帮助 cache hit）
  systemPrefix: string;            // system prompt + AGENTS.md 规则

  // Working Set（当前循环真正需要的）
  goal: string;
  acceptanceCriteria: string[];
  currentNode: HarnessPlanNode | null;
  recentItems: ThreadItem[];       // 按任务相关度筛选，不是最近 N 个
  failedCriteria: string[];
  lastFailure?: { node: string; reason: string };

  // Evidence References（只存引用，不塞全量）
  evidenceRefs: EvidenceReceipt[];

  // Compact Narrative（辅助方向感）
  summary?: CompactionSummary;

  // Budget
  tokenBudget: number;
}
```

## 三、模块详细设计

### Step 1: `harness/types.ts` — 类型定义

**文件**: `packages/runtime/src/harness/types.ts`（新建）

**内容**: 上述所有接口和类型定义。

**依赖**: `@suanlizi/protocol` (ThreadId, TurnId, ItemId, ThreadItem, CompactionSummary)

**不改动任何现有文件。**

### Step 2: `evidenceLedger.ts` — 证据收据索引层

**文件**: `packages/runtime/src/harness/evidenceLedger.ts`（新建）

**借鉴**: Reasonix `evidence.Ledger`，但不做平行历史库。

**核心接口**:
```typescript
class EvidenceLedger {
  private receipts: Map<string, EvidenceReceipt> = new Map();
  private byThread: Map<ThreadId, Set<string>> = new Map();

  // 从 ThreadItem 提取证据收据
  recordItem(item: ThreadItem, threadId: ThreadId, harnessRunId: string): EvidenceReceipt | null;

  // 批量记录一个 turn 的所有 item
  recordTurn(items: ThreadItem[], threadId: ThreadId, turnId: TurnId, harnessRunId: string): EvidenceReceipt[];

  // 查询
  hasSuccessfulCommand(command: string, sinceTurnId?: TurnId): boolean;
  hasSuccessfulWrite(paths: string[], sinceTurnId?: TurnId): boolean;
  hasSuccessfulReadOrWrite(paths: string[], sinceTurnId?: TurnId): boolean;
  hasFailedTool(toolName: string, sinceTurnId?: TurnId): boolean;
  getEvidenceForCriteria(criteria: string): EvidenceReceipt[];
  getRecentEvidence(limit: number): EvidenceReceipt[];

  // 统计
  getToolCallCount(toolName: string): number;
  getErrorCount(): number;
}
```

**证据提取规则**:
| ThreadItem 类型 | EvidenceReceipt.kind | 提取内容 |
|----------------|---------------------|---------|
| `tool_call` (status=completed) | `tool` | toolName + result 摘要 |
| `tool_call` (status=failed) | `error` | toolName + error message |
| `command_execution` (status=completed) | `command` | command + output 前 200 字符 |
| `command_execution` (status=failed) | `error` | command + exit code |
| `file_change` (status=completed) | `file_change` | paths + hunks 摘要 |
| `mcp_tool_call` (status=completed) | `mcp` | server + tool + result 摘要 |
| `error` | `error` | message + info |

### Step 3: `goalTracker.ts` — 目标状态管理

**文件**: `packages/runtime/src/harness/goalTracker.ts`（新建）

**借鉴**: DeerFlow `GoalState` + Reasonix `goalMachine`

**核心接口**:
```typescript
class GoalTracker {
  private state: HarnessState;
  private threadId: ThreadId;

  setGoal(objective: string, acceptanceCriteria: string[], options?: {
    maxContinuations?: number;
    maxNoProgress?: number;
  }): void;

  getState(): HarnessState;

  // 每次 iteration 后调用
  recordEvaluation(eval_: GoalEvaluation): HarnessState;

  // 无进展检测
  checkNoProgress(): boolean;

  // 续跑计数
  canContinue(): boolean;

  // 状态转换
  markSatisfied(): void;
  markBlocked(reason: string): void;
  markMaxContinuations(): void;
  markNoProgress(): void;

  // plan 管理
  updatePlan(nodes: HarnessPlanNode[]): void;
  advanceNode(nodeId: string): void;
  failNode(nodeId: string, reason: string): void;

  // 持久化（通过 ThreadStore.tags）
  async persist(store: ThreadStore): Promise<void>;
  async load(store: ThreadStore): Promise<HarnessState | null>;
}
```

**状态转换图**:
```
active
  ├── satisfied        (evaluator.satisfied = true)
  ├── blocked          (evaluator.status = blocked, 累积 3 次同原因)
  ├── max_continuations (iteration >= maxContinuations)
  └── no_progress       (noProgressCount >= maxNoProgress)
```

### Step 4: `harnessContext.ts` — 上下文裁切核心

**文件**: `packages/runtime/src/harness/harnessContext.ts`（新建）

**借鉴**: 用户分析的"四类上下文分层"

**核心接口**:
```typescript
class HarnessContextManager {
  constructor(
    private store: ThreadStore,
    private ledger: EvidenceLedger,
    private goalTracker: GoalTracker,
  );

  // 每轮 iteration 构造任务包
  async buildIterationContext(
    threadId: ThreadId,
    budget: number,
  ): Promise<HarnessContextSlice>;

  // 按验收标准选择相关证据
  selectEvidenceForCriteria(
    criteria: string[],
    maxItems: number,
  ): EvidenceReceipt[];

  // 压缩已完成节点的上下文
  compactCompletedIteration(
    nodeId: string,
  ): void;

  // 保留失败上下文（不压缩）
  retainFailureContext(
    nodeId: string,
    reason: string,
  ): void;

  // 预算裁切
  trimToBudget(
    slice: HarnessContextSlice,
    maxTokens: number,
  ): HarnessContextSlice;
}
```

**buildIterationContext 逻辑**:
```
1. 获取 HarnessState
2. 从 ThreadStore.getRecentItems 取最近 item
3. 按 evidence 相关度过滤（不是简单取最近 N 个）:
   - 保留当前 activeNode 相关的 item
   - 保留失败节点的 error item
   - 保留有 evidenceReceipt 的 tool/command item
   - 丢弃已完成且已压缩的旧 item
4. 从 EvidenceLedger 选择支撑当前 failedCriteria 的证据
5. 从 thread.tags.compactedSummary 获取摘要
6. 组装 HarnessContextSlice
7. trimToBudget 裁切到预算内
```

**裁切优先级**（从高到低）:
```
1. system prompt + goal + acceptanceCriteria    [不可丢]
2. 当前 active node 的描述                       [不可丢]
3. 最近一轮的失败原因                           [不可丢]
4. 支撑 failedCriteria 的 evidence receipt      [高]
5. 最近 N 轮的 tool/command 结果                [中]
6. compactedSummary                             [低]
7. 旧 reasoning item                             [可丢]
8. 旧已完成节点的 item                           [可丢]
```

### Step 5: `stormBreaker.ts` — 死循环检测

**文件**: `packages/runtime/src/harness/stormBreaker.ts`（新建）

**借鉴**: Reasonix `applyStormBreaker`

**核心接口**:
```typescript
class StormBreaker {
  private signatures: Map<string, number> = new Map();  // signature → count
  private blockedStreak: number = 0;
  private readonly threshold: number;                   // 默认 5
  private readonly blockedThreshold: number;            // 默认 3

  // 每轮工具执行后调用
  check(items: ThreadItem[]): StormBreakerResult;

  // 重置
  reset(): void;
}

interface StormBreakerResult {
  triggered: boolean;
  reason?: string;
  signature?: string;
  instruction?: string;  // 注入给模型的 "change approach" 指令
}
```

**检测规则**:
1. **签名检测**: `(toolName, errorMessage)` 组合连续命中 `threshold` 次
2. **连续阻塞检测**: `blockedTurnStreak` 连续 `blockedThreshold` 次
3. 命中后生成 `instruction`: "You appear to be stuck repeating the same action. Change your approach and try a different strategy."

### Step 6: `readinessCritic.ts` — 确定性规则 gate

**文件**: `packages/runtime/src/harness/readinessCritic.ts`（新建）

**借鉴**: Reasonix `finalReadinessCheckFor` — **先规则，后模型**

**核心接口**:
```typescript
class ReadinessCritic {
  constructor(
    private ledger: EvidenceLedger,
    private goalTracker: GoalTracker,
  );

  // 模型给出 final answer 后调用
  check(items: ThreadItem[]): ReadinessResult;
}

interface ReadinessResult {
  passed: boolean;
  failedGates: ReadinessGate[];
  retryInstruction?: string;  // 不通过时注入给模型
}

interface ReadinessGate {
  name: string;
  passed: boolean;
  detail: string;
}
```

**Gate 规则（全部确定性，不调模型）**:

| Gate | 规则 | 判定 |
|------|------|------|
| `todo_complete` | 所有 plan node 状态为 completed | 有未完成 → fail |
| `mutation_verified` | 有 file_change item → 必须有对应的成功 command/test 证据 | 缺验证 → fail |
| `no_unresolved_errors` | 最近 N 轮无未恢复的 error item | 有 error → fail |
| `criteria_evidence` | 每条 acceptanceCriteria 至少有 1 个 evidenceReceipt 支撑 | 缺证据 → fail |
| `no_storm` | StormBreaker 未触发 | 触发 → fail |

**不通过时**: 生成 `retryInstruction`，包含具体哪些 gate 失败、需要做什么。

### Step 7: `goalEvaluator.ts` — 独立模型语义验收

**文件**: `packages/runtime/src/harness/goalEvaluator.ts`（新建）

**借鉴**: DeerFlow `evaluate_goal_completion` — 独立非思考模型，fail-closed

**核心接口**:
```typescript
class GoalEvaluator {
  constructor(
    private model: ModelGateway,
    private evaluatorModelName?: string,  // 可指定不同模型
  );

  async evaluate(
    goal: HarnessGoal,
    state: HarnessState,
    recentItems: ThreadItem[],
    evidenceReceipts: EvidenceReceipt[],
  ): Promise<GoalEvaluation>;
}
```

**评估 prompt** (借鉴 DeerFlow 但增强):
```
You are a strict completion evaluator for an AI coding assistant.
Decide whether the active goal is fully satisfied using ONLY the visible conversation evidence and evidence receipts.

Goal: {goal.objective}
Acceptance Criteria:
{goal.acceptanceCriteria.map((c, i) => `${i+1}. ${c}`).join('\n')}

Plan State:
{plan nodes with status}

Evidence Receipts:
{evidenceReceipts.map(r => `- [${r.status}] ${r.kind}: ${r.summary} (supports: ${r.supportsCriteria.join(', ')})`).join('\n')}

Recent Conversation:
{recentItems formatted}

Rules:
- Do not assume files, commands, tests, or external state changed unless evidence shows it.
- If visible evidence is too weak to prove progress, fail closed with blocker=missing_evidence.
- Use blocker=needs_user_input when the assistant is waiting on the user.
- Use blocker=goal_not_met_yet when useful autonomous work can continue.
- Use status=satisfied ONLY when ALL acceptance criteria are met with evidence.

Output exactly one JSON object:
{
  "satisfied": boolean,
  "status": "satisfied" | "continue" | "needs_user_input" | "blocked",
  "passedCriteria": string[],
  "failedCriteria": string[],
  "blocker": string,
  "nextHint": string,
  "evidenceSummary": string,
  "reasoning": string
}
```

**progressSignature 计算**:
```typescript
function computeProgressSignature(eval_: GoalEvaluation, state: HarnessState): string {
  const parts = [
    eval_.failedCriteria.sort().join('|'),
    state.plan.filter(n => n.status === 'completed').map(n => n.id).sort().join('|'),
    eval_.evidenceSummary.slice(0, 100),
  ];
  return crypto.createHash('sha256').update(parts.join('::')).digest('hex').slice(0, 16);
}
```

### Step 8: `taskHarness.ts` — 组装 HarnessLoop

**文件**: `packages/runtime/src/harness/taskHarness.ts`（新建）

**核心接口**:
```typescript
class TaskHarnessEngine {
  constructor(
    private agentLoop: AgentLoop,
    private model: ModelGateway,
    private store: ThreadStore,
    private config: HarnessConfig,
  );

  async runHarness(
    threadId: ThreadId,
    userInput: UserInput,
    options: {
      goal?: string;
      acceptanceCriteria?: string[];
      maxContinuations?: number;
      signal?: AbortSignal;
    },
  ): Promise<HarnessResult>;
}

interface HarnessResult {
  status: 'satisfied' | 'blocked' | 'max_continuations' | 'no_progress' | 'cancelled';
  iterations: number;
  finalEvaluation: GoalEvaluation | null;
  evidenceCount: number;
  items: ThreadItem[];
  usage: Usage | null;
}
```

**主循环逻辑**:
```typescript
async runHarness(threadId, userInput, options): Promise<HarnessResult> {
  // 1. 初始化
  const goalTracker = new GoalTracker(threadId);
  const ledger = new EvidenceLedger();
  const contextMgr = new HarnessContextManager(this.store, ledger, goalTracker);
  const stormBreaker = new StormBreaker();
  const readinessCritic = new ReadinessCritic(ledger, goalTracker);
  const evaluator = new GoalEvaluator(this.model, this.config.evaluatorModelName);
  const harnessRunId = generateId();

  goalTracker.setGoal(
    options.goal ?? extractGoalFromInput(userInput),
    options.acceptanceCriteria ?? await this.deriveCriteria(userInput),
    { maxContinuations: options.maxContinuations ?? 8 },
  );

  // 2. 第一轮：正常 runTurn（用户输入）
  let result = await this.agentLoop.runTurn(threadId, userInput, options.signal);
  ledger.recordTurn(result.items, threadId, /* turnId */, harnessRunId);

  // 3. 自主循环
  while (goalTracker.canContinue()) {
    // 3a. Readiness gate（确定性规则）
    const readiness = readinessCritic.check(result.items);
    if (!readiness.passed) {
      // 注入 retry instruction，继续 AgentLoop（同一 turn 内）
      const retryInput = makeRetryInput(readiness.retryInstruction);
      result = await this.agentLoop.runTurn(threadId, retryInput, options.signal);
      ledger.recordTurn(result.items, threadId, /* turnId */, harnessRunId);
      continue;
    }

    // 3b. Storm breaker
    const storm = stormBreaker.check(result.items);
    if (storm.triggered) {
      const stormInput = makeStormInput(storm.instruction);
      result = await this.agentLoop.runTurn(threadId, stormInput, options.signal);
      ledger.recordTurn(result.items, threadId, /* turnId */, harnessRunId);
      continue;
    }

    // 3c. Goal evaluation（独立模型）
    const eval_ = await evaluator.evaluate(
      goalTracker.getState().goal,
      goalTracker.getState(),
      result.items,
      ledger.getRecentEvidence(20),
    );

    // 3d. 记录评估，更新状态
    goalTracker.recordEvaluation(eval_);

    // 3e. 判定
    if (eval_.satisfied) {
      return { status: 'satisfied', iterations: goalTracker.getState().iteration, ... };
    }
    if (eval_.status === 'needs_user_input' || eval_.status === 'blocked') {
      return { status: 'blocked', ... };
    }

    // 3f. 无进展检测
    if (goalTracker.checkNoProgress()) {
      return { status: 'no_progress', ... };
    }

    // 3g. 隐藏续跑 — 注意必须传 signal 作为第三参数
    const continuationInput = makeContinuationInput(eval_, goalTracker.getState());
    result = await this.agentLoop.runTurn(
      threadId,
      continuationInput,
      options.signal,           // 第三参数：signal
      {                          // 第四参数：RunTurnOptions
        source: 'harness',
        visibleToUser: false,
        harnessRunId,
        harnessIteration: goalTracker.getState().iteration,
        skipColdMemory: true,
        extractMemory: false,
      },
    );
    ledger.recordTurn(result.items, threadId, /* turnId */, harnessRunId);
  }

  // 4. 到达上限
  return { status: 'max_continuations', ... };
}
```

### Step 9: `runProfile.ts` 扩展 + config 同步

**文件改动清单**:

| 文件 | 改动 |
|------|------|
| `packages/runtime/src/runProfile.ts` | 增加 `harness` profile，soft=0.4, hard=0.7, strategy=llm |
| `apps/api/src/config/config.ts` | 增加 harness profile 选项 |
| `apps/web/src/config/config.ts` | 同步 |
| `apps/desktop/src/config/config.ts` | 同步 |

**harness profile 参数**:
```typescript
if (profile === 'harness') {
  return {
    softCompactRatio: 0.4,    // 更早压缩
    hardCompactRatio: 0.7,    // 更早硬压缩
    strategy: 'llm',          // LLM 语义压缩
  };
}
```

### Step 10: `agent.ts` 最小接入

**文件**: `packages/runtime/src/agent.ts`（改动现有）

**改动 1: 支持 harness hidden input**

在 `runTurn` 方法中保持 `signal` 第三参数兼容，新增第四参数 `options`：
```typescript
async runTurn(
  threadId: ThreadId,
  userInput: UserInput,
  signal?: AbortSignal,
  options?: RunTurnOptions,
): Promise<{ items: ThreadItem[]; usage: Usage | null }>
```

**注意**：现有调用方 `server.ts:795` 是 `agent.runTurn(threadId, input)`，不传 signal，保持兼容。
A2A 适配器 `server.ts:86` 是 `agent.runTurn(threadId, input, signal)`，也兼容。
Harness 调用必须写 `runTurn(threadId, input, signal, options)`，不能跳过 signal。

**伪代码调用修正**（Step 8 taskHarness.ts 中）：
```typescript
// 隐藏续跑调用 — 必须传 signal 作为第三参数
result = await this.agentLoop.runTurn(
  threadId,
  continuationInput,
  options.signal,           // 第三参数：signal
  {                          // 第四参数：options
    source: 'harness',
    visibleToUser: false,
    harnessRunId,
    harnessIteration: goalTracker.getState().iteration,
    skipColdMemory: true,
    extractMemory: false,
  },
);
```

当 `source === 'harness'` 时：
- 持久化为 `HarnessContinuationItem` 而非 `UserMessageItem`
- 事件流中标记 `hidden: true`
- UI 不显示
- **禁止触发 cold memory 提取** (`maybeExtractColdMemories` 跳过)
- **禁止更新 episode** (`updateEpisodeFromCompletedTurn` 跳过)
- **turnCount 仍然递增**（harness turn 也是真实 turn，需要可审计）
- **run monitor 正常记录**（harness iteration 需要可观测）

**改动 2: 工具执行后回调 EvidenceLedger**

在工具执行完成后（现有 `executeToolCall` 附近），增加一个可选回调：
```typescript
// 现有工具执行后
if (this.config.onToolExecuted) {
  this.config.onToolExecuted(item, threadId, turnId);
}
```

AgentLoop 不直接依赖 EvidenceLedger，通过回调解耦。

**改动 3: 新增 `runHarness` 入口**

```typescript
async runHarness(
  threadId: ThreadId,
  userInput: UserInput,
  options?: HarnessOptions,
): Promise<HarnessResult> {
  const engine = new TaskHarnessEngine(this, this.config.model, this.config.store, ...);
  return engine.runHarness(threadId, userInput, options ?? {});
}
```

**改动 4: harness hidden continuation 副作用控制**

`RunTurnOptions` 完整字段：
```typescript
interface RunTurnOptions {
  source?: 'user' | 'harness';
  visibleToUser?: boolean;
  harnessRunId?: string;
  harnessIteration?: number;
  extractMemory?: boolean;      // 默认 true，harness 续跑时 false
  updateEpisode?: boolean;      // 默认 true，harness 续跑时 true（保留 harness 轨迹）
  skipColdMemory?: boolean;     // 默认 false，harness 续跑时 true
}
```

在 `runTurn` 完成后的生命周期阶段：
```typescript
// agent.ts 现有逻辑
if (!options?.skipColdMemory) {
  await this.maybeExtractColdMemories(refreshedThread, turnId, userInput, collectedItems);
}
if (options?.updateEpisode !== false) {
  await this.updateEpisodeFromCompletedTurn(refreshedThread, turnId, turnIndex, userInput, collectedItems);
}
```

这样 harness 续跑不会污染 cold memory，但 episode 仍然记录 harness 轨迹。

## 四、实施顺序与依赖

```
Step 1: harness/types.ts          [无依赖，纯类型]
   ↓
Step 2: evidenceLedger.ts          [依赖 Step 1 + ThreadItem 类型]
   ↓
Step 3: goalTracker.ts             [依赖 Step 1]
   ↓
Step 4: harnessContext.ts          [依赖 Step 1-3 + ThreadStore]
   ↓
Step 5: stormBreaker.ts             [依赖 Step 1，纯规则]
   ↓                    (Step 2, 5 可并行)
Step 6: readinessCritic.ts          [依赖 Step 2-3，纯规则]
   ↓
Step 7: goalEvaluator.ts            [依赖 Step 1-3 + ModelGateway]
   ↓
Step 8: taskHarness.ts             [依赖 Step 1-7，组装]
   ↓
Step 9: runProfile + config         [独立，可并行]
   ↓
Step 10: agent.ts 接入              [依赖 Step 8-9]
```

**可并行步骤**:
- Step 2 (evidenceLedger) 和 Step 5 (stormBreaker) 互相独立
- Step 9 (runProfile + config) 与 Step 4-7 独立

## 五、测试策略

### 单元测试

| 模块 | 测试重点 |
|------|---------|
| `evidenceLedger` | 从各种 ThreadItem 类型正确提取 receipt；查询 API 正确性 |
| `goalTracker` | 状态转换正确；无进展检测；续跑计数 |
| `harnessContext` | 预算裁切优先级；证据选择相关度 |
| `stormBreaker` | 签名检测；连续阻塞检测；重置 |
| `readinessCritic` | 每个 gate 独立测试；组合测试 |
| `goalEvaluator` | mock model 返回；progressSignature 计算 |

### 集成测试

| 场景 | 验证点 |
|------|--------|
| 简单任务一次完成 | evaluator satisfied → 结束 |
| 需要多次迭代 | 隐藏续跑正常 → 最终 satisfied |
| todo 未完成 | readiness gate 拦截 → retry → 最终完成 |
| 死循环 | storm breaker 触发 → 改变方法 → 完成 |
| 无进展 | 连续 2 轮 signature 相同 → 暂停 |
| 到达上限 | 8 次续跑 → max_continuations |
| 需要用户输入 | evaluator 返回 needs_user_input → 暂停 |
| 上下文裁切 | 长任务中 token 不超预算 |

## 六、MVP 范围

**第一版只做**:
- Step 1-8: 核心 HarnessLoop
- Step 9-10: 最小接入

**第一版不做**:
- Workflow loopBoundaries 激活
- 复杂 DAG 重写
- prompt executor / tool executor 注册
- UI 上的 harness 控制面板（仅通过 API 触发）

## 七、评分预期

| 模块 | 现状 | Step 1-8 后 | Step 1-10 后 |
|------|------|-----------|-------------|
| AgentLoop | 7.5/10 | 7.5/10 | 7.5/10 |
| 长运行底座 | 7/10 | 7/10 | 8/10 |
| cache/runtime 双模式 | 6.5/10 | 6.5/10 | 7.5/10 |
| **Harness 自主循环** | **4.5/10** | **7.5/10** | **8.5/10** |
| **上下文裁切** | **5/10** | **7/10** | **8/10** |

## 八、文件清单

> **注**：本节为初版清单，未包含 Gap 1–10 和实施级细节的增量文件。
> **最终执行清单以第十一章"补全后的文件清单"为准。**
> 本节保留用于对比初始范围与补全后的范围差异。

### 新建文件

| 文件路径 | Step |
|---------|------|
| `packages/runtime/src/harness/types.ts` | 1 |
| `packages/runtime/src/harness/evidenceLedger.ts` | 2 |
| `packages/runtime/src/harness/goalTracker.ts` | 3 |
| `packages/runtime/src/harness/harnessContext.ts` | 4 |
| `packages/runtime/src/harness/stormBreaker.ts` | 5 |
| `packages/runtime/src/harness/readinessCritic.ts` | 6 |
| `packages/runtime/src/harness/goalEvaluator.ts` | 7 |
| `packages/runtime/src/harness/taskHarness.ts` | 8 |
| `packages/runtime/src/harness/index.ts` | 8 |

### 改动文件

| 文件路径 | Step | 改动范围 |
|---------|------|---------|
| `packages/runtime/src/runProfile.ts` | 9 | 增加 harness 枚举 |
| `packages/runtime/src/agent.ts` | 10 | runTurn 增加 options 参数；新增 runHarness 入口 |
| `packages/protocol/src/types.ts` | 10 | 新增 HarnessContinuationItem 类型 |
| `apps/api/src/config/config.ts` | 9 | 增加 harness profile |
| `apps/web/src/config/config.ts` | 9 | 同步 |
| `apps/desktop/src/config/config.ts` | 9 | 同步 |

### 测试文件

| 文件路径 | 覆盖模块 |
|---------|---------|
| `packages/runtime/src/harness/evidenceLedger.test.ts` | Step 2 |
| `packages/runtime/src/harness/goalTracker.test.ts` | Step 3 |
| `packages/runtime/src/harness/harnessContext.test.ts` | Step 4 |
| `packages/runtime/src/harness/stormBreaker.test.ts` | Step 5 |
| `packages/runtime/src/harness/readinessCritic.test.ts` | Step 6 |
| `packages/runtime/src/harness/goalEvaluator.test.ts` | Step 7 |
| `packages/runtime/src/harness/taskHarness.test.ts` | Step 8 |

---

## 九、审查反馈缺口补充（Gap 1–10）

> 本章节是对计划第一版审查反馈的逐条补充，作为各 Step 的可执行细则。
> 已落地：Gap 3（runTurn 签名修正，见 Step 8/Step 10）、Gap 9（hidden continuation 副作用控制，见 Step 10 改动 4）。
> 以下补齐剩余 8 个缺口 + trimToBudget 算法细化。

### Gap 1 — API 入口（新增 Step 11）

**问题**：计划声明 "MVP 仅通过 API 触发"，但文件清单没有 API route，`runHarness` 只存在于 runtime 内，用户和测试都打不通。

**补丁**：

新建 `apps/api/src/routes/harnessRoute.ts`，并在 `apps/api/src/server.ts` 接入路由。

**接口设计**：

```http
POST /api/threads/:id/harness/run
  body: { userInput, goal?, acceptanceCriteria?, maxContinuations?, runProfile? }
  resp: { harnessRunId, status: 'running' }

GET  /api/threads/:id/harness/state
  resp: { activeHarnessRunId, status, iteration, goal, plan, evidenceCount, lastEvaluation }

POST /api/threads/:id/harness/cancel
  body: { reason? }
  resp: { cancelled: true, finalStatus }
```

**路由匹配（与 server.ts 现有模式一致）**：

```typescript
// apps/api/src/server.ts 现有模式：if (req.method && url.pathname)
if (req.method === 'POST' && url.pathname.match(/^\/api\/threads\/[^/]+\/harness\/run$/)) {
  return harnessRoute.runHarness(req, threadId);
}
if (req.method === 'GET' && url.pathname.match(/^\/api\/threads\/[^/]+\/harness\/state$/)) {
  return harnessRoute.getState(req, threadId);
}
if (req.method === 'POST' && url.pathname.match(/^\/api\/threads\/[^/]+\/harness\/cancel$/)) {
  return harnessRoute.cancel(req, threadId);
}
```

**职责边界**：
- `harnessRoute.runHarness` 调用 `agent.runHarness(threadId, userInput, options)`，立即返回 `harnessRunId`，不阻塞响应。
- 实际进度通过现有 SSE 事件流推送（`item.started`/`item.completed` 已支持 harness continuation item）。
- `getState` 读取 `thread.tags.activeHarnessRunId` + `GoalTracker.load(store)` 重建状态。
- `cancel` 通过 `AbortController` 触发 `options.signal.abort()`，由 HarnessLoop 主循环捕获并退出。

**文件清单增量**：
| 文件路径 | Step | 改动 |
|---------|------|------|
| `apps/api/src/routes/harnessRoute.ts` | 11 | 新建 |
| `apps/api/src/server.ts` | 11 | 接入 3 条 harness 路由 |

---

### Gap 2 — Protocol schemas + 前端 shared types 同步

**问题**：Step 10 只改 `packages/protocol/src/types.ts`，但 `schemas.ts` 的 `threadItemSchema` 是 `z.discriminatedUnion('type', [...])`，不加入新 schema 会出现 "TS 有，Zod 不认" 的断层；前端 `apps/web/src/shared/types.ts` 的 `ThreadItem` 是宽松 interface，`apps/web/src/features/chat/threadView.ts` 的 `isTranscriptItem()` 也需排除新类型，否则 UI 会把 `harness_continuation` 当普通 item 渲染。

**补丁**：

#### 2.1 `packages/protocol/src/schemas.ts`

在 `threadItemSchema` 的 discriminatedUnion 数组中新增：

```typescript
const harnessContinuationItemSchema = z.object({
  id: itemIdSchema,
  type: z.literal('harness_continuation'),
  turnId: turnIdSchema.optional(),
  harnessRunId: z.string(),
  iteration: z.number().int(),
  objective: z.string(),
  instruction: z.string(),
  evaluation: goalEvaluationSchema,  // 复用 Step 7 的 schema
  visibleToUser: z.literal(false),
  timestamp: z.string(),
});

// 加入 threadItemSchema discriminatedUnion
threadItemSchema = z.discriminatedUnion('type', [
  // ... existing 14 schemas
  harnessContinuationItemSchema,
]);
```

#### 2.2 前端 shared types 同步

| 文件 | 改动 |
|------|------|
| `apps/web/src/shared/types.ts` | `ThreadItem.type` 字段注释补充 `'harness_continuation'`；新增可选字段 `harnessRunId?`、`iteration?`、`objective?`、`instruction?`、`evaluation?`、`visibleToUser?`（沿用宽松 interface 风格） |
| `apps/desktop/src/shared/types.ts` | 同步 web 侧改动 |
| `apps/web/src/features/chat/threadView.ts` | `isTranscriptItem()` 增加 `&& item.type !== 'harness_continuation'`；`ThreadItemLike` 接口补充对应可选字段；`itemHeading()` 不需要新增 case（UI 不显示） |
| `apps/desktop/src/features/chat/threadView.ts` | 同步 web 侧改动 |

#### 2.3 事件 schema

`item.started` / `item.completed` / `item.updated` 事件依赖 `threadItemSchema`，加入新 schema 后自动支持，无需额外改动。

**文件清单增量**：
| 文件路径 | Step | 改动 |
|---------|------|------|
| `packages/protocol/src/schemas.ts` | 10 | 新增 harnessContinuationItemSchema 并加入 discriminatedUnion |
| `apps/web/src/shared/types.ts` | 10 | ThreadItem 增加可选字段 |
| `apps/desktop/src/shared/types.ts` | 10 | 同步 |
| `apps/web/src/features/chat/threadView.ts` | 10 | isTranscriptItem 排除 harness_continuation |
| `apps/desktop/src/features/chat/threadView.ts` | 10 | 同步 |

---

### Gap 3 — runTurn 签名修正（✅ 已在 Step 8/Step 10 落地）

签名：`runTurn(threadId, userInput, signal?, options?: RunTurnOptions)`
伪代码：`runTurn(threadId, continuationInput, options.signal, { source: 'harness', ... })`

详见 Step 8 隐藏续跑调用段落与 Step 10 改动 1。

---

### Gap 4 — HarnessContextSlice 注入方式（Step 4 补充细则）

**问题**：`HarnessContextManager.buildIterationContext()` 构造了 `HarnessContextSlice`，但 `AgentLoop.runTurn()` 只接受 `userInput`，真实上下文仍由 `AgentLoop.buildMessages()` 自己从 recent items + compacted summary 构造。计划没说 `HarnessContextSlice` 怎么注入模型。

**决策**：第一版用 **hidden continuation + modeInstruction** 注入任务包，不新增 `contextOverride` 参数，不改 `AgentLoop.buildMessages()`。

**注入路径**：

```typescript
// taskHarness.ts
const slice = await contextMgr.buildIterationContext(threadId, budget);
const continuationInput = makeContinuationInput(eval_, goalTracker.getState());
// 关键：把 slice 渲染成文本注入到 continuationInput.modeInstruction
continuationInput.modeInstruction = renderHarnessContextSlice(slice);

result = await this.agentLoop.runTurn(
  threadId, continuationInput, options.signal,
  { source: 'harness', visibleToUser: false, harnessRunId, ... },
);
```

**`renderHarnessContextSlice(slice)` 输出格式**：

```text
[harness context]
# Goal
{slice.goal}

# Acceptance Criteria
{slice.acceptanceCriteria.map((c, i) => `${i+1}. ${c}`).join('\n')}

# Current Plan Node
{slice.currentNode?.description ?? '—'}

# Failed Criteria (focus here)
{slice.failedCriteria.join(', ') ?? '—'}

# Last Failure
{slice.lastFailure ?? '—'}

# Evidence Receipts (references only, not full content)
{slice.evidenceRefs.map(r => `- [${r.status}] ${r.kind}: ${r.summary} (supports: ${r.supportsCriteria.join(', ')})`).join('\n')}

# Recent Progress Summary
{slice.summary?.narrative ?? '—'}
[/harness context]
```

**关键原则**：
- **不塞 system prompt**：动态 harness 状态每轮变化，塞 system prompt 会打爆 cache prefix，缓存优先命中率归零。
- **放 hidden user/turn instruction**：通过 `modeInstruction` 注入，走正常 turn 消息流，不影响 cache prefix。
- **EvidenceReceipt 只传 reference**（id + summary + status），不传全量内容；模型需要细节时通过 `examine_evidence` 工具（后续 Step）按 id 拉。

**Step 4 接口增量**：

```typescript
// harnessContext.ts 新增
function renderHarnessContextSlice(slice: HarnessContextSlice): string;
```

---

### Gap 5 — EvidenceLedger 重建策略（Step 2 补充细则）

**问题**：`EvidenceLedger` 现在是 `private receipts: Map<string, EvidenceReceipt>`，只存在内存。Harness 目标是可暂停、可恢复，服务重启或 run interrupted 后 ledger 会丢失，"Resume" 就是断的。

**决策**：MVP 选 **方案 B** — 不持久化 receipt，但提供 `rebuildFromThreadItems(threadId)` 从 ThreadStore items 重建。

**理由**：
- 方案 A（EvidenceReceipt 作为新 ThreadItem 类型持久化）需要扩协议、扩 schema、扩 UI 隐藏规则，改动面大。
- 方案 B 不改协议，receipt 是派生数据，随时可从原始 items 重建，更简单。
- ThreadStore 的 items 已经是事实源（source of truth），ledger 只是索引视图。

**Step 2 接口增量**：

```typescript
class EvidenceLedger {
  // 原有 receipts/byThread Map 保留为内存缓存

  // 新增：从 ThreadStore items 重建 ledger
  async rebuildFromThreadItems(
    threadId: ThreadId,
    store: ThreadStore,
    harnessRunId?: string,  // 可选过滤特定 run
  ): Promise<void> {
    this.receipts.clear();
    this.byThread.clear();
    const items = await store.getItems(threadId);
    for (const item of items) {
      // 过滤：只记录该 harnessRunId 的 continuation 之间的 items
      if (harnessRunId && this.getItemHarnessRunId(item) !== harnessRunId) continue;
      this.recordItem(item, threadId, harnessRunId ?? this.getItemHarnessRunId(item) ?? '');
    }
  }

  // 辅助：从 ThreadItem 提取 harnessRunId
  private getItemHarnessRunId(item: ThreadItem): string | undefined {
    if (item.type === 'harness_continuation') return item.harnessRunId;
    return undefined;
  }
}
```

**Resume 流程**（在 `TaskHarnessEngine.runHarness` 入口）：

```typescript
async runHarness(threadId, userInput, options) {
  const goalTracker = new GoalTracker(threadId);
  await goalTracker.load(this.store);  // 从 thread.tags 恢复 HarnessState

  const ledger = new EvidenceLedger();
  await ledger.rebuildFromThreadItems(threadId, this.store, goalTracker.getState().harnessRunId);
  // 现在 ledger 内存有完整历史 receipts

  // 检查是否已结束
  const state = goalTracker.getState();
  if (state.status !== 'active') {
    return { status: state.status, iterations: state.iteration, ... };
  }

  // 继续 harness loop（续跑，而不是从头开始）
  // ...
}
```

---

### Gap 6 — GoalTracker 多 run 隔离（Step 3 补充细则）

**问题**：`GoalTracker.persist(store)` 通过 `ThreadStore.tags`，如果一个 thread 以后多次 harness run，单个 `tags.harnessState` 会互相覆盖。

**决策**：第一版规定 **一个 thread 同时只允许一个 active harness**，通过 `thread.tags.activeHarnessRunId` 管理互斥；历史 run 的状态用 `harnessState:<runId>` 命名空间隔离。

**Step 3 接口增量**：

```typescript
class GoalTracker {
  // 新增字段
  private harnessRunId: string;

  async persist(store: ThreadStore): Promise<void> {
    const tags: Record<string, string> = {
      [`harnessState:${this.harnessRunId}`]: JSON.stringify(this.state),
    };
    // 仅当 state.status === 'active' 时才设置 activeHarnessRunId
    if (this.state.status === 'active') {
      tags.activeHarnessRunId = this.harnessRunId;
    } else {
      tags.activeHarnessRunId = '';  // 清空
    }
    await store.updateThreadMetadata(this.threadId, { tags });
  }

  async load(store: ThreadStore): Promise<HarnessState | null> {
    const thread = await store.getThread(this.threadId);
    const activeRunId = thread.tags?.activeHarnessRunId;
    if (!activeRunId) return null;

    const stateJson = thread.tags?.[`harnessState:${activeRunId}`];
    if (!stateJson) return null;

    this.harnessRunId = activeRunId;
    this.state = JSON.parse(stateJson);
    return this.state;
  }

  // 互斥检查：开启新 harness 前必须确认无 active run
  static async canStartNewHarness(store: ThreadStore, threadId: ThreadId): Promise<boolean> {
    const thread = await store.getThread(threadId);
    return !thread.tags?.activeHarnessRunId;
  }
}
```

**TaskHarnessEngine 启动检查**：

```typescript
async runHarness(threadId, userInput, options) {
  if (!(await GoalTracker.canStartNewHarness(this.store, threadId))) {
    throw new Error('Thread already has an active harness run. Cancel or wait for it to finish first.');
  }
  // ... 继续
}
```

---

### Gap 7 — Verification command 识别规则（Step 6 补充细则）

**问题**：`mutation_verified` gate 规则是 "有 file_change → 必须有对应成功 command/test 证据"，但 "对应" 没定义，否则任意 `echo ok` 都可能成为验证证据。

**补丁**：新增 `isVerificationCommand(command): boolean` 识别器。

**Step 6 接口增量**：

```typescript
// readinessCritic.ts

const VERIFICATION_COMMAND_PATTERNS: RegExp[] = [
  /^npm\s+test(\s|$)/,
  /^npm\s+run\s+(test|build|lint|typecheck)(\s|$)/,
  /^npx\s+(vitest|jest|tsc|eslint|prettier)(\s|$)/,
  /^pnpm\s+(test|build|lint|typecheck)(\s|$)/,
  /^yarn\s+(test|build|lint|typecheck)(\s|$)/,
  /^tsc\s+(-p|--project|--noEmit)(\s|$)/,
  /^vitest(\s|$)/,
  /^jest(\s|$)/,
  /^pytest(\s|$)/,
  /^python\s+-m\s+(pytest|unittest)(\s|$)/,
  /^go\s+(test|build|vet)(\s|$)/,
  /^cargo\s+(test|build|clippy)(\s|$)/,
  /^mvn\s+(test|verify|compile)(\s|$)/,
  /^gradle\s+(test|build)(\s|$)/,
  /^make\s+(test|check)(\s|$)/,
  /^dotnet\s+(test|build)(\s|$)/,
];

export function isVerificationCommand(command: string): boolean {
  const trimmed = command.trim();
  return VERIFICATION_COMMAND_PATTERNS.some(re => re.test(trimmed));
}
```

**`mutation_verified` gate 修正**：

```typescript
// readinessCritic.ts
function checkMutationVerified(ledger: EvidenceLedger, items: ThreadItem[]): ReadinessGate {
  const fileChanges = items.filter(i => i.type === 'file_change' && i.status === 'completed');
  if (fileChanges.length === 0) return { name: 'mutation_verified', passed: true, detail: 'no mutations' };

  // 必须有 isVerificationCommand = true 的成功 command 证据
  const verifiedCommands = ledger
    .getRecentEvidence(50)
    .filter(r => r.kind === 'command' && r.status === 'passed')
    .filter(r => isVerificationCommand(r.refs.command ?? ''));

  if (verifiedCommands.length === 0) {
    return {
      name: 'mutation_verified',
      passed: false,
      detail: `检测到 ${fileChanges.length} 个文件变更，但没有对应的 verification command (npm test/vitest/tsc/pytest 等)`,
    };
  }

  // 进一步：检查 verifiedCommands 是否覆盖 fileChanges 的 path（MVP 可选）
  return { name: 'mutation_verified', passed: true, detail: `${verifiedCommands.length} 个 verification 通过` };
}
```

**关键原则**：`echo ok` / `ls` / `cat` 这类命令不算 verification，避免被模型糊弄。

---

### Gap 8 — supportsCriteria 生成规则（Step 2/7 补充细则）

**问题**：`EvidenceReceipt.supportsCriteria` 是好字段，但计划没说怎么填。MVP 不做的话 `criteria_evidence` gate 全 fail，导致 harness 一直续跑。

**决策**：两层填充。

**第一层：deterministic（在 `EvidenceLedger.recordItem` 时填充）**

```typescript
// evidenceLedger.ts

function deriveSupportsCriteria(item: ThreadItem, criteria: string[]): string[] {
  const supported: string[] = [];
  const text = extractItemText(item).toLowerCase();
  const paths = extractItemPaths(item);
  const command = extractItemCommand(item);

  for (const criterion of criteria) {
    const c = criterion.toLowerCase();
    // 规则 1：criterion 中提到路径/文件名，且 item 改了对应文件
    for (const p of paths) {
      if (c.includes(p.toLowerCase()) || c.includes(basename(p).toLowerCase())) {
        supported.push(criterion);
        break;
      }
    }
    // 规则 2：criterion 提到 "test"/"build"/"lint"，且 item 是对应 verification command
    if (/test|build|lint|typecheck/.test(c) && command && isVerificationCommand(command)) {
      supported.push(criterion);
      continue;
    }
    // 规则 3：criterion 包含 tool name 关键词，且 item 是该 tool 调用
    if (item.type === 'tool_call' && item.toolName) {
      if (c.includes(item.toolName.toLowerCase())) {
        supported.push(criterion);
      }
    }
  }
  return [...new Set(supported)];  // 去重
}
```

**第二层：evaluator（在 `GoalEvaluator.evaluate` 输出中声明对应关系）**

```typescript
// goalEvaluator.ts
interface GoalEvaluation {
  // 原有字段...
  criteriaEvidenceMap?: Record<string, string[]>;  // criterion → evidenceId[]
}

// 评估 prompt 追加：
// "Additionally, output a JSON object `criteriaEvidenceMap` mapping each acceptance criterion
//  to the evidence receipt IDs that support it. Use empty array [] if no evidence supports a criterion."
```

**Ledger 更新流程**：

```typescript
// taskHarness.ts 主循环
const eval_ = await evaluator.evaluate(...);
if (eval_.criteriaEvidenceMap) {
  ledger.applyCriteriaMap(eval_.criteriaEvidenceMap);  // 反向更新 receipt.supportsCriteria
}
```

**`criteria_evidence` gate 判定**：

```typescript
function checkCriteriaEvidence(ledger: EvidenceLedger, criteria: string[]): ReadinessGate {
  const missing = criteria.filter(c => ledger.getEvidenceForCriteria(c).length === 0);
  if (missing.length > 0) {
    return {
      name: 'criteria_evidence',
      passed: false,
      detail: `缺少证据支撑的 criteria: ${missing.join('; ')}`,
    };
  }
  return { name: 'criteria_evidence', passed: true, detail: 'all criteria have evidence' };
}
```

**Step 2 接口增量**：

```typescript
class EvidenceLedger {
  // 新增
  applyCriteriaMap(map: Record<string, string[]>): void;
  // 新增
  getEvidenceForCriteria(criteria: string): EvidenceReceipt[];  // 已在原计划中
}
```

---

### Gap 9 — Hidden continuation 副作用（✅ 已在 Step 10 改动 4 落地）

`RunTurnOptions` 完整字段（`source`/`visibleToUser`/`harnessRunId`/`extractMemory`/`updateEpisode`/`skipColdMemory`）+ 生命周期副作用控制逻辑，见 Step 10 改动 4。

---

### Gap 10 — runProfile 完整同步文件清单（Step 9 替换原清单）

**问题**：Step 9 只列了 `packages/runtime/src/runProfile.ts` + 3 个 config.ts，但实际下拉框、默认值、测试都依赖 runProfile，需要同步的文件更多。

**补丁**：替换 Step 9 文件清单为完整版本。

| 文件路径 | Step | 改动 |
|---------|------|------|
| `packages/runtime/src/runProfile.ts` | 9 | 增加 `harness` profile，参数 soft=0.4, hard=0.7, strategy=llm |
| `apps/api/src/config/config.ts` | 9 | 增加 harness profile 选项 |
| `apps/web/src/config/config.ts` | 9 | `RunProfile` 类型加 `'harness'`，config schema 同步 |
| `apps/desktop/src/config/config.ts` | 9 | 同步 web |
| `apps/web/src/config/runProfiles.ts` | 9 | `runProfileLabel()` / `runProfileDescription()` 增加 harness case |
| `apps/desktop/src/config/runProfiles.ts` | 9 | 同步 web |
| `apps/web/src/config/defaults.ts` | 9 | 默认 profile 不变（仍为 cache_first），但 `validateRunProfile()` 接受 'harness' |
| `apps/desktop/src/config/defaults.ts` | 9 | 同步 web |
| `apps/web/src/components/ComposerBar.tsx` | 9 | profile 下拉框增加 harness 选项 |
| `apps/desktop/src/components/ComposerBar.tsx` | 9 | 同步 web |
| `apps/api/src/config/config.test.ts` | 9 | 增加 harness profile 解析测试 |
| `apps/web/src/config/config.test.ts` | 9 | 增加 harness profile 测试 |
| `apps/desktop/src/config/config.test.ts` | 9 | 同步 web |

**关键原则**：
- `harness` profile 不作为默认值，只在用户显式选择或 `POST /api/threads/:id/harness/run` 时激活。
- 下拉框中 `harness` 选项放在最后，label 为 "Harness（自主循环）"，避免误选。
- API 触发 harness 时 `runProfile` 会被强制设为 `harness`，覆盖用户当前选择。

---

### 细化 trimToBudget — 预算分配与裁切算法（Step 4 补充细则）

**问题**：计划只写了"按预算裁切"，没说预算比例和具体裁切策略，实施时容易拍脑袋。

**预算分配（总预算默认 40k tokens）**：

| 分层 | 预算比例 | 预算 token | 策略 |
|------|---------|----------|------|
| Stable / system prompt + AGENTS.md | 不可裁 | ~3-5k（固定） | 不进入 trimToBudget，由 AgentLoop buildMessages 保证 |
| Goal + acceptanceCriteria + active node | 不可裁 | ~2k（固定） | 必须保留 |
| Failure context（最近一轮失败原因 + 相关 error item） | 15% | 6k | 优先保留，但限制最近 1-2 轮 |
| Evidence receipts（只 ref + summary，不塞全量） | 25% | 10k | 按 supportsCriteria 相关度排序，超出只保留 id + status |
| Recent relevant items（工具/命令/文件变更原文） | 35% | 14k | 按 turnId 倒序 + activeNode 相关度 |
| Compacted narrative（历史摘要） | 15% | 6k | 超出时优先丢旧摘要 |
| Reserve（缓冲） | 10% | 4k | 留给模型输出 + 工具结果增量 |

**裁切策略（按优先级从高到低执行）**：

```typescript
// harnessContext.ts

function trimToBudget(slice: HarnessContextSlice, maxTokens: number): HarnessContextSlice {
  let budget = maxTokens;
  const kept: HarnessContextSlice = { ...slice };

  // 1. 不可裁层：system + goal + active node
  budget -= estimateTokens(kept.systemPrefix);
  budget -= estimateTokens(kept.goal + kept.acceptanceCriteria.join('\n') + kept.currentNode?.description);

  // 2. Failure context：保留最近 1-2 轮
  if (kept.lastFailure) {
    budget -= estimateTokens(kept.lastFailure);
  }

  // 3. Evidence receipts：按 supportsCriteria 相关度排序
  const evidenceBudget = Math.floor(maxTokens * 0.25);
  kept.evidenceRefs = trimEvidenceRefs(kept.evidenceRefs, evidenceBudget);
  budget -= evidenceBudget;

  // 4. Recent items：按 turnId 倒序 + activeNode 相关度
  const recentBudget = Math.floor(maxTokens * 0.35);
  kept.recentItems = trimRecentItems(kept.recentItems, recentBudget, kept.currentNode?.id);
  budget -= recentBudget;

  // 5. Compacted narrative
  const narrativeBudget = Math.floor(maxTokens * 0.15);
  kept.summary = trimSummary(kept.summary, narrativeBudget);

  // 6. Reserve 不动（10%）

  return kept;
}

function trimEvidenceRefs(refs: EvidenceReceipt[], budget: number): EvidenceReceipt[] {
  // 排序：failedCriteria 相关 > 当前 node 相关 > 最近 > 其他
  const sorted = [...refs].sort((a, b) => relevanceScore(b) - relevanceScore(a));
  const kept: EvidenceReceipt[] = [];
  let used = 0;
  for (const r of sorted) {
    const cost = estimateTokens(r.summary + r.refs.path + r.refs.command);
    if (used + cost > budget) {
      // 超预算：只保留 id + status（10 token）
      kept.push({ ...r, summary: '[truncated]', refs: {} });
    } else {
      kept.push(r);
      used += cost;
    }
  }
  return kept;
}

function trimRecentItems(items: ThreadItem[], budget: number, activeNodeId?: string): ThreadItem[] {
  const kept: ThreadItem[] = [];
  let used = 0;
  // 倒序遍历，优先保留 activeNode 相关的 item
  const sorted = [...items].sort((a, b) => {
    const aRel = isItemRelatedToNode(a, activeNodeId) ? 1 : 0;
    const bRel = isItemRelatedToNode(b, activeNodeId) ? 1 : 0;
    if (aRel !== bRel) return bRel - aRel;
    return (b.timestamp ?? '').localeCompare(a.timestamp ?? '');
  });

  for (const item of sorted) {
    const cost = estimateTokens(item.text ?? item.aggregatedOutput ?? item.command ?? '');
    if (used + cost > budget) {
      // command output 超长：只保留前后 200 字符
      if (item.type === 'command_execution' && (item.aggregatedOutput?.length ?? 0) > 400) {
        const trimmedItem = {
          ...item,
          aggregatedOutput: item.aggregatedOutput!.slice(0, 200) + '\n...[truncated]...\n' + item.aggregatedOutput!.slice(-200),
        };
        kept.push(trimmedItem);
        used += 450;  // 近似
        continue;
      }
      // file_change：只保留 path + hunk summary，不留整文件
      if (item.type === 'file_change') {
        const trimmedItem = {
          ...item,
          changes: item.changes?.map(c => ({ path: c.path, kind: c.kind, summary: c.summary })),
          // 丢弃 hunks 整文件内容
        };
        kept.push(trimmedItem);
        used += 100;
        continue;
      }
      // 跳过超预算的非关键 item
      continue;
    }
    kept.push(item);
    used += cost;
  }
  return kept;
}
```

**裁切规则汇总**：

1. EvidenceReceipt 超预算时只保留 `id + status`，丢弃 `summary/refs`。
2. `command_execution` 输出超过 400 字符只保留前 200 + 后 200 字符，中间 `[truncated]`。
3. `file_change` 只保留 `path + kind + summary`，丢弃 `hunks` 整文件 diff。
4. 已完成节点的 item 只保留 `node summary + evidence ids`，丢弃原始 reasoning。
5. 旧 reasoning item（`type === 'reasoning'`）默认全部丢弃。
6. `tool_call` 结果超过 500 字符只保留前 200 + 后 200 字符。
7. `agent_message` 超过 1000 字符只保留前 500 + 后 500 字符。

**预算动态调整**：
- 如果某轮失败原因复杂（error item > 2k token），failure context 预算可临时扩到 25%，从 recent items 借。
- 如果 evidence 极多（>50 receipts），evidence refs 预算可临时扩到 35%，从 narrative 借。

---

## 十、补全后的实施顺序

> **本节为最终执行清单**，已合并第九章 Gap 1–10 和第十二章实施级细节的所有增量。

```
Step 1:  harness/types.ts              [无依赖]
Step 2:  evidenceLedger.ts             [+ Gap 5 rebuildFromThreadItems, Gap 8 deriveSupportsCriteria]
Step 3:  goalTracker.ts                [+ Gap 6 多 run 隔离]
Step 4:  harnessContext.ts              [+ Gap 4 renderHarnessContextSlice, trimToBudget 细化]
Step 5:  stormBreaker.ts               [无变化]
Step 6:  readinessCritic.ts            [+ Gap 7 isVerificationCommand]
Step 7:  goalEvaluator.ts              [+ Gap 8 criteriaEvidenceMap]
Step 8:  taskHarness.ts                [+ Gap 3 runTurn 签名, Gap 4 注入路径, Gap 5 resume 流程, Gap 6 互斥检查]
Step 9:  runProfile + config           [+ Gap 10 完整同步文件清单]
Step 10: agent.ts 接入                 [+ Gap 3 签名, Gap 9 副作用控制]
Step 11: harnessRoute + server.ts      [+ Gap 1 API 入口]
```

## 十一、补全后的文件清单

> **本节为最终执行清单**，已合并第九章 Gap 1–10 和第十二章实施级细节的所有增量。

### 新建文件

| 文件路径 | Step |
|---------|------|
| `packages/runtime/src/harness/types.ts` | 1 |
| `packages/runtime/src/harness/evidenceLedger.ts` | 2 |
| `packages/runtime/src/harness/goalTracker.ts` | 3 |
| `packages/runtime/src/harness/harnessContext.ts` | 4 |
| `packages/runtime/src/harness/stormBreaker.ts` | 5 |
| `packages/runtime/src/harness/readinessCritic.ts` | 6 |
| `packages/runtime/src/harness/goalEvaluator.ts` | 7 |
| `packages/runtime/src/harness/taskHarness.ts` | 8 |
| `packages/runtime/src/harness/index.ts` | 8 |
| `apps/api/src/routes/harnessRoute.ts` | 11 |
| `apps/api/src/services/harnessRuntime.ts` | 11 |

### 改动文件

| 文件路径 | Step | 改动 |
|---------|------|------|
| `packages/runtime/src/runProfile.ts` | 9 | 增加 harness 枚举 |
| `packages/runtime/src/agent.ts` | 10 | runTurn 增 4 参数 options；新增 runHarness 入口；副作用控制；**实施点 2: 给 harness turn 的 items 打 harnessRunId/harnessIteration** |
| `packages/protocol/src/types.ts` | 10 | 新增 `GoalEvaluation` + `HarnessContinuationItem` 导出；**实施点 2: BaseItem 增加可选 `harnessRunId`/`harnessIteration`** |
| `packages/protocol/src/schemas.ts` | 10 | 新增 `goalEvaluationSchema` + `harnessContinuationItemSchema` 并加入 `threadItemSchema` discriminatedUnion；**实施点 2: 各 item schema 加 `harnessRunId: z.string().optional()`** |
| `apps/api/src/config/config.ts` | 9 | 增加 harness profile |
| `apps/api/src/server.ts` | 11 | 接入 3 条 harness 路由；**实施点 3: 进程退出时调 `harnessRuntimeRegistry.cleanup()`** |
| `apps/web/src/config/config.ts` | 9 | RunProfile 类型加 'harness' |
| `apps/desktop/src/config/config.ts` | 9 | 同步 web |
| `apps/web/src/config/runProfiles.ts` | 9 | label/description 增加 harness case |
| `apps/desktop/src/config/runProfiles.ts` | 9 | 同步 web |
| `apps/web/src/config/defaults.ts` | 9 | validateRunProfile 接受 'harness' |
| `apps/desktop/src/config/defaults.ts` | 9 | 同步 web |
| `apps/web/src/components/ComposerBar.tsx` | 9 | profile 下拉增加 harness 选项 |
| `apps/desktop/src/components/ComposerBar.tsx` | 9 | 同步 web |
| `apps/web/src/shared/types.ts` | 10 | ThreadItem 增加可选字段 |
| `apps/desktop/src/shared/types.ts` | 10 | 同步 |
| `apps/web/src/features/chat/threadView.ts` | 10 | isTranscriptItem 排除 harness_continuation |
| `apps/desktop/src/features/chat/threadView.ts` | 10 | 同步 |
| `apps/api/src/config/config.test.ts` | 9 | harness profile 测试 |
| `apps/web/src/config/config.test.ts` | 9 | harness profile 测试 |
| `apps/desktop/src/config/config.test.ts` | 9 | 同步 web |

### 测试文件

| 文件路径 | 覆盖模块 |
|---------|---------|
| `packages/runtime/src/harness/evidenceLedger.test.ts` | Step 2 + Gap 5/8 |
| `packages/runtime/src/harness/goalTracker.test.ts` | Step 3 + Gap 6 |
| `packages/runtime/src/harness/harnessContext.test.ts` | Step 4 + Gap 4 + trimToBudget |
| `packages/runtime/src/harness/stormBreaker.test.ts` | Step 5 |
| `packages/runtime/src/harness/readinessCritic.test.ts` | Step 6 + Gap 7 |
| `packages/runtime/src/harness/goalEvaluator.test.ts` | Step 7 + Gap 8 |
| `packages/runtime/src/harness/taskHarness.test.ts` | Step 8 + Gap 3/5/6 |
| `apps/api/src/routes/harnessRoute.test.ts` | Step 11 + Gap 1 |

---

## 十二、实施级细节补充（执行时易踩坑 5 点）

> 本章节是对第九章的二次复核补充，针对 5 个"写代码时才暴露、但返工成本高"的执行级细节。
> 前 3 个直接影响实现正确性，**开工前必须先补到对应 Step 的伪代码里**。

### 实施点 1 — `updateThreadMetadata(tags)` 是全量替换，必须 merge（影响 Gap 6）

**问题**：[store.ts:660-663](file:///e:/langchain/Suanlizi/packages/storage/src/store.ts#L660-L663) 的实现是：

```typescript
if (patch.tags !== undefined) {
  sets.push('tags = ?');
  params.push(JSON.stringify(patch.tags));
}
```

SQL 是 `tags = ?`，直接整体替换，**不是 merge**。第九章 Gap 6 的 GoalTracker 写法：

```typescript
await store.updateThreadMetadata(this.threadId, { tags });
```

会把原有 `runConfig` / `compactedSummary` / memory 相关 tags 全部冲掉。harness 一跑，压缩摘要和配置标签就没了。

**补丁**：所有写 tags 的地方必须先读后 merge。

```typescript
// goalTracker.ts — Gap 6 persist 修正
async persist(store: ThreadStore): Promise<void> {
  const thread = await store.getThread(this.threadId);
  const existingTags = thread?.tags ?? {};

  const harnessTags: Record<string, string> = {
    [`harnessState:${this.harnessRunId}`]: JSON.stringify(this.state),
  };
  if (this.state.status === 'active') {
    harnessTags.activeHarnessRunId = this.harnessRunId;
  } else {
    harnessTags.activeHarnessRunId = '';  // 清空 active
  }

  // 关键：merge 而非替换
  await store.updateThreadMetadata(this.threadId, {
    tags: { ...existingTags, ...harnessTags },
  });
}
```

**同样适用于**：
- `HarnessContextManager` 若要写 `compactedSummary` 到 tags（MVP 不写，走 ThreadStore items）。
- 任何 harness 模块写 tags 都遵循 "read-modify-write" 模式。

**测试要求**：`goalTracker.test.ts` 必须有一个用例：先写 `runConfig`/`compactedSummary` tags，再 `goalTracker.persist()`，验证旧 tags 仍在。

---

### 实施点 2 — EvidenceLedger 按 `harnessRunId` 关联普通 items（影响 Gap 5）

**问题**：第九章 Gap 5 的 `rebuildFromThreadItems` 写：

```typescript
if (harnessRunId && this.getItemHarnessRunId(item) !== harnessRunId) continue;
```

但只有 `harness_continuation` item 有 `harnessRunId` 字段，普通 `tool_call` / `file_change` / `command_execution` 没有。这样过滤会把真正的证据全部过滤掉，ledger 重建后空空如也。

**决策**：给 `RunTurnOptions.source === 'harness'` 时，**该 turn 产生的所有 items 都附加 `harnessRunId` 字段**，前端不显示即可。

**Step 10 接口增量**：

`ThreadItem`（types.ts）所有变体增加可选字段：

```typescript
// packages/protocol/src/types.ts
interface BaseItemFields {
  id: ItemId;
  turnId?: TurnId;
  timestamp: string;
  harnessRunId?: string;        // 新增：harness 续跑产生的 item 才有
  harnessIteration?: number;   // 新增：辅助审计
}
```

`schemas.ts` 对应 schema 都加 `harnessRunId: z.string().optional()`。

前端 `threadView.ts` 的 `ThreadItemLike` 增加可选字段（沿用宽松风格），UI 渲染时忽略即可。

**AgentLoop 持久化时注入**（agent.ts 改动 1）：

```typescript
// runTurn 完成后，appendItems 前给所有 collectedItems 打标
if (options?.source === 'harness' && options.harnessRunId) {
  for (const item of collectedItems) {
    (item as any).harnessRunId = options.harnessRunId;
    if (options.harnessIteration !== undefined) {
      (item as any).harnessIteration = options.harnessIteration;
    }
  }
}
await store.appendItems(threadId, collectedItems);
```

**EvidenceLedger 重建修正**：

```typescript
// evidenceLedger.ts — Gap 5 rebuildFromThreadItems 修正
async rebuildFromThreadItems(
  threadId: ThreadId,
  store: ThreadStore,
  harnessRunId?: string,
): Promise<void> {
  this.receipts.clear();
  this.byThread.clear();
  const items = await store.getItems(threadId);
  for (const item of items) {
    // 关键修正：用 item.harnessRunId 字段直接过滤
    if (harnessRunId) {
      const itemRunId = (item as any).harnessRunId;
      if (itemRunId !== harnessRunId) continue;
    }
    this.recordItem(item, threadId, harnessRunId ?? (item as any).harnessRunId ?? '');
  }
}
```

**好处**：
- 重建逻辑简单清晰，不需要"run 区间 / turnId 范围"推断。
- 每个 item 自带 harnessRunId，审计和 cancel 都能直接定位。
- 前端隐藏 `harnessRunId` 字段，不影响 UI。

**测试要求**：`evidenceLedger.test.ts` 必须验证：rebuild 后能正确按 harnessRunId 过滤，普通 item 不带 harnessRunId 的不会被记入该 run。

---

### 实施点 3 — 后台 harness run 注册表（影响 Gap 1）

**问题**：第九章 Gap 1 的 API 设计说：

> `runHarness` 立即返回 `harnessRunId`，不阻塞响应
> `cancel` 通过 `AbortController` 触发 `options.signal.abort()`

但如果 API handler 只写 `void agent.runHarness(...)`，**没有地方保存** `harnessRunId → AbortController` / `→ Promise` / `→ status` 的映射。`/cancel` 找不到 signal，`/state` 只能看 tags，无法判断内存中是否还在 running。

**补丁**：新增后台 harness run 注册表。

**新建文件**：

```text
apps/api/src/services/harnessRuntime.ts
```

**核心接口**：

```typescript
// apps/api/src/services/harnessRuntime.ts

interface ActiveHarnessRun {
  harnessRunId: string;
  threadId: ThreadId;
  controller: AbortController;
  promise: Promise<HarnessResult>;
  startedAt: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  error?: string;
  result?: HarnessResult;
}

class HarnessRuntimeRegistry {
  private runs: Map<string, ActiveHarnessRun> = new Map();
  private byThread: Map<ThreadId, Set<string>> = new Map();

  register(run: ActiveHarnessRun): void {
    this.runs.set(run.harnessRunId, run);
    if (!this.byThread.has(run.threadId)) this.byThread.set(run.threadId, new Set());
    this.byThread.get(run.threadId)!.add(run.harnessRunId);

    // promise 完成时自动更新 status
    run.promise
      .then((result) => {
        const r = this.runs.get(run.harnessRunId);
        if (r) { r.status = 'completed'; r.result = result; }
      })
      .catch((err) => {
        const r = this.runs.get(run.harnessRunId);
        if (r) {
          r.status = err.name === 'AbortError' ? 'cancelled' : 'failed';
          r.error = err.message;
        }
      });
  }

  get(harnessRunId: string): ActiveHarnessRun | undefined {
    return this.runs.get(harnessRunId);
  }

  getByThread(threadId: ThreadId): ActiveHarnessRun[] {
    const ids = this.byThread.get(threadId) ?? new Set();
    return [...ids].map(id => this.runs.get(id)).filter(Boolean) as ActiveHarnessRun[];
  }

  getActiveByThread(threadId: ThreadId): ActiveHarnessRun | undefined {
    return this.getByThread(threadId).find(r => r.status === 'running');
  }

  cancel(harnessRunId: string, reason?: string): boolean {
    const run = this.runs.get(harnessRunId);
    if (!run || run.status !== 'running') return false;
    run.controller.abort(reason);
    run.status = 'cancelled';
    return true;
  }

  // 进程退出前的清理（可选：持久化 running 状态到 tags）
  cleanup(): void {
    for (const run of this.runs.values()) {
      if (run.status === 'running') {
        run.controller.abort('server shutdown');
      }
    }
  }
}

// 单例
export const harnessRuntimeRegistry = new HarnessRuntimeRegistry();
```

**harnessRoute 接入**：

```typescript
// apps/api/src/routes/harnessRoute.ts
import { harnessRuntimeRegistry } from '../services/harnessRuntime.js';

async function runHarness(req, threadId) {
  const body = await readBody(req);

  // 互斥检查（结合 Gap 6）
  if (await harnessRuntimeRegistry.getActiveByThread(threadId)) {
    return json(409, { error: 'Thread already has an active harness run' });
  }

  const harnessRunId = generateId();
  const controller = new AbortController();
  const promise = agent.runHarness(threadId, body.userInput, {
    goal: body.goal,
    acceptanceCriteria: body.acceptanceCriteria,
    maxContinuations: body.maxContinuations,
    signal: controller.signal,
  });

  harnessRuntimeRegistry.register({
    harnessRunId, threadId, controller, promise,
    startedAt: new Date().toISOString(),
    status: 'running',
  });

  // 立即返回，不 await promise
  return json(202, { harnessRunId, status: 'running' });
}

async function getState(req, threadId) {
  // 优先看内存中的 running
  const active = harnessRuntimeRegistry.getActiveByThread(threadId);
  if (active) {
    return json(200, { activeHarnessRunId: active.harnessRunId, status: 'running', ... });
  }
  // 否则从 tags 恢复（已结束或服务重启后的状态）
  const goalTracker = new GoalTracker(threadId);
  const state = await goalTracker.load(store);
  return json(200, state ? { ...state } : { status: 'idle' });
}

async function cancel(req, threadId) {
  const body = await readBody(req);
  const active = harnessRuntimeRegistry.getActiveByThread(threadId);
  if (!active) return json(404, { error: 'No active harness run' });
  const ok = harnessRuntimeRegistry.cancel(active.harnessRunId, body.reason);
  return json(200, { cancelled: ok, harnessRunId: active.harnessRunId });
}
```

**文件清单增量**：

| 文件路径 | Step | 改动 |
|---------|------|------|
| `apps/api/src/services/harnessRuntime.ts` | 11 | 新建，后台 harness run 注册表 |
| `apps/api/src/routes/harnessRoute.ts` | 11 | 接入注册表，实现 cancel |
| `apps/api/src/server.ts` | 11 | 进程退出时调 `harnessRuntimeRegistry.cleanup()` |

**关键原则**：
- 注册表是进程内单例，**不跨进程持久化**（服务重启后 running run 会随进程消失，但 tags 里的 `activeHarnessRunId` 会保留，下次 `/state` 时显示 "interrupted"）。
- `cleanup()` 在 server shutdown 时 abort 所有 running run，避免 zombie promise。
- 多副本部署时，注册表只对当前进程有效；跨进程 cancel 需要 sticky session 或后续引入 Redis pub/sub（MVP 不做）。

---

### 实施点 4 — `goalEvaluationSchema` 列入 protocol/schema 计划（影响 Gap 2）

**问题**：第九章 Gap 2 的 `harnessContinuationItemSchema` 写：

```typescript
evaluation: goalEvaluationSchema,  // 复用 Step 7 的 schema
```

但 `goalEvaluationSchema` 没有在文件清单里列出来，也没说放哪个包。如果只在 `packages/runtime/src/harness/types.ts` 定义，而 protocol 不认，会出现：
- TS 类型 `GoalEvaluation` 在 runtime 包
- Zod schema 不存在或散落
- `harnessContinuationItemSchema.evaluation` 无法 validate

**决策**：把 `GoalEvaluation` 和 `harnessContinuationItem` 都作为 protocol 类型，统一在 `packages/protocol` 定义。

**补丁**：

`packages/protocol/src/types.ts` 新增导出：

```typescript
// packages/protocol/src/types.ts
export interface GoalEvaluation {
  satisfied: boolean;
  status: 'satisfied' | 'continue' | 'needs_user_input' | 'blocked';
  passedCriteria: string[];
  failedCriteria: string[];
  blocker?: string;
  nextHint?: string;
  evidenceSummary: string;
  progressSignature: string;
  reasoning: string;
  criteriaEvidenceMap?: Record<string, string[]>;  // Gap 8 新增
}

export interface HarnessContinuationItem extends BaseItem {
  type: 'harness_continuation';
  harnessRunId: string;
  iteration: number;
  objective: string;
  instruction: string;
  evaluation: GoalEvaluation;
  visibleToUser: false;
}
```

`packages/protocol/src/schemas.ts` 新增：

```typescript
// packages/protocol/src/schemas.ts
export const goalEvaluationSchema = z.object({
  satisfied: z.boolean(),
  status: z.enum(['satisfied', 'continue', 'needs_user_input', 'blocked']),
  passedCriteria: z.array(z.string()),
  failedCriteria: z.array(z.string()),
  blocker: z.string().optional(),
  nextHint: z.string().optional(),
  evidenceSummary: z.string(),
  progressSignature: z.string(),
  reasoning: z.string(),
  criteriaEvidenceMap: z.record(z.string(), z.array(z.string())).optional(),
});

export const harnessContinuationItemSchema = z.object({
  id: itemIdSchema,
  type: z.literal('harness_continuation'),
  turnId: turnIdSchema.optional(),
  harnessRunId: z.string(),
  iteration: z.number().int(),
  objective: z.string(),
  instruction: z.string(),
  evaluation: goalEvaluationSchema,
  visibleToUser: z.literal(false),
  timestamp: z.string(),
});
```

**runtime 包引用**：

```typescript
// packages/runtime/src/harness/types.ts
export type {
  GoalEvaluation,
  HarnessContinuationItem,
} from '@suanlizi/protocol';
```

避免 `runtime/types.ts` 和 `protocol/types.ts` 双份漂移。

**文件清单修正**：

| 文件路径 | Step | 改动 |
|---------|------|------|
| `packages/protocol/src/types.ts` | 10 | 新增 `GoalEvaluation` + `HarnessContinuationItem` 导出 |
| `packages/protocol/src/schemas.ts` | 10 | 新增 `goalEvaluationSchema` + `harnessContinuationItemSchema` |
| `packages/runtime/src/harness/types.ts` | 1 | re-export protocol 类型，不重复定义 |

**前端 shared types**：`apps/web/src/shared/types.ts` 和 `apps/desktop/src/shared/types.ts` 的宽松 interface 仍可保留，但补注释指明 protocol 是事实源。

---

### 实施点 5 — 旧第八章文件清单标注（文档整洁）

**问题**：第八章（第 840 行起）旧清单仍写"改动文件只到 types.ts/config.ts，测试文件没有 harnessRoute.test.ts"，第十一章有补全后的清单。两份清单并存，执行者容易读乱。

**决策**：不删除第八章（保留修订历史可追溯），但在第八章开头加一句指引。

**补丁**：

在 `## 八、文件清单` 标题下方加：

```markdown
> **注**：本节为初版清单，未包含 Gap 1–10 和实施级细节的增量文件。
> **最终执行清单以第十一章"补全后的文件清单"为准。**
> 本节保留用于对比初始范围与补全后的范围差异。
```

同样在第十章"补全后的实施顺序"和第十一章"补全后的文件清单"标题下方加：

```markdown
> **本节为最终执行清单**，已合并第九章 Gap 1–10 和第十二章实施级细节的所有增量。
```

---

## 十三、最终开工检查清单

| 检查项 | 状态 | 位置 |
|--------|------|------|
| Gap 1 API 入口 | ✅ | 第九章 Gap 1 + Step 11 |
| Gap 2 protocol schema 同步 | ✅ | 第九章 Gap 2 + 实施点 4 |
| Gap 3 runTurn 签名 | ✅ | Step 8/10 |
| Gap 4 ContextSlice 注入 | ✅ | 第九章 Gap 4 |
| Gap 5 EvidenceLedger 重建 | ✅ | 第九章 Gap 5 + 实施点 2 |
| Gap 6 多 run 隔离 | ✅ | 第九章 Gap 6 + 实施点 1 |
| Gap 7 verification command | ✅ | 第九章 Gap 7 |
| Gap 8 supportsCriteria | ✅ | 第九章 Gap 8 |
| Gap 9 hidden continuation 副作用 | ✅ | Step 10 改动 4 |
| Gap 10 runProfile 同步 | ✅ | 第九章 Gap 10 |
| trimToBudget 算法 | ✅ | 第九章末 |
| 实施点 1 tags merge | ✅ | 第十二章实施点 1 |
| 实施点 2 item.harnessRunId | ✅ | 第十二章实施点 2 |
| 实施点 3 后台 run 注册表 | ✅ | 第十二章实施点 3 |
| 实施点 4 goalEvaluationSchema | ✅ | 第十二章实施点 4 |
| 实施点 5 旧清单标注 | ✅ | 第十二章实施点 5 |

**开工决策**：以上 16 项全部补齐，计划已可作为可执行实施计划开工。
