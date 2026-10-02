# Cognitive Context Layer — V1~V4 实施计划

> 基于代码评审（非README猜测）制定。核心判断：Suanlizi runtime 已成熟，但**认知上下文（Cognitive Context）不是一级对象**，agent.ts 直接拼装所有 context。
>
> 目标优先级：V1 Context Engine > V2 Project Brain (GitNexus升级) > V3 Experience Engine > V4 Skill Runtime。

---

## 零、现状快照（代码真实状态）

| 组件 | 文件 | 当前状态 | 缺口 |
|------|------|---------|------|
| context注入点 | [middleware.ts:48-54](file:///e:/langchain/suanlizi/packages/runtime/src/middleware.ts#L48-L54) | 单一 `dynamicContextProvider?: (ctx) => Promise<string\|string[]>` | 无分层、无优先级、无结构化、无token预算 |
| 认知状态雏形 | [goalTracker.ts:20-30](file:///e:/langchain/suanlizi/packages/runtime/src/harness/goalTracker.ts#L20-L30) | Harness内部有 `constraints/assumptions/successCriteria` | 只在harness模式可用，不是runtime一级对象 |
| Memory策略 | [memory.ts](file:///e:/langchain/suanlizi/packages/memory/src/memory.ts) | 有 `sealEpisode/promoteToWarmMemory`，按阈值自动晋升 | 无evaluation gate，无"谁批准写"，无失败模式识别 |
| Skill定义 | [extensions.ts](file:///e:/langchain/suanlizi/packages/extensions/src/extensions.ts) | `skill={instructions, tools}` 纯prompt级 | 无生命周期（prepare/execute/verify/rollback） |
| GitNexus | [packages/gitnexus/src/index.ts](file:///e:/langchain/suanlizi/packages/gitnexus/src/index.ts) | 独立MCP server+CLI，有codeGraph(symbolIndex/fileIndex/callGraph)+gitLog/blame/diff | 未接入ContextProvider，是工具不是上下文 |

---

## V1：Context Engine（认知上下文层）⭐⭐⭐⭐⭐

### 1.1 目标

把 `agent.ts` 中分散的 context 拼装逻辑抽离成独立包，让 **CognitiveState（认知状态）成为一级对象**，支持多 Provider 注册、token 预算分配、优先级排序。

### 1.2 新增包结构

```
packages/context/
├── src/
│   ├── index.ts                 # 导出
│   ├── types.ts                 # 核心类型定义（AgentContext三层结构）
│   ├── contextEngine.ts         # ContextEngine 主类
│   ├── contextAssembler.ts      # token预算+裁剪+拼装+优先级排序
│   └── providers/
│       ├── environmentContext.ts # 内置：环境信息（cwd/os/git status等）
│       └── taskContext.ts       # 内置：任务理解（TaskCognition）
├── package.json
└── tsconfig.json
```

> V1不包含MemoryContextProvider（memory尚未稳定），V3 Experience Engine完成后再接入。

### 1.3 核心类型（types.ts）

> **架构决策**：AgentContext 分三层，性质不同不混淆。
> - `cognition`：Agent对任务的理解，会随推理变化
> - `world`：外部世界事实（project/environment），不因agent想法改变，由对应provider刷新
> - `memory`：本轮召回的经验摘要，V1不做（memory尚未稳定），V3填充

```typescript
// packages/context/src/types.ts

export interface AgentContext {
  cognition: CognitionLayer;
  world: WorldLayer;
  memory?: MemoryLayer;          // V3填充，V1为undefined
  updatedAt: number;
}

export interface CognitionLayer {
  task: TaskCognition;
}

export interface TaskCognition {
  goal: string;
  constraints: string[];         // 用户明确约束 + 系统推断约束
  assumptions: string[];         // 当前假设（可能被推翻）
  knownFacts: string[];          // 已确认事实
  unknowns: string[];            // 待确认/待探索
  risks: RiskAssessment[];
  confidence: number;            // 0-1，对当前理解的信心
  verificationCriteria: string[];// 完成标准（harness的verificationCriteria升级到这里）
}

export interface RiskAssessment {
  description: string;
  severity: 'low' | 'medium' | 'high';
  mitigation?: string;
}

export interface WorldLayer {
  environment: EnvironmentContext;
  project?: ProjectContext;      // V2填充，V1为undefined
}

export interface ProjectContext {
  architecture?: string;
  architectureHash?: string;     // 用于判断是否需要重新注入
  techStack?: string[];
  changedFiles?: string[];
  changeVersion?: number;        // 变更版本号，用于delta注入
  riskyAreas?: string[];
  dependencyGraph?: string;
  recentChanges?: string;
  lastInjectedTurn?: number;     // 上次注入架构信息的turnId，后续只注入delta
}

export interface EnvironmentContext {
  cwd: string;
  os: string;
  shell: string;
  gitBranch?: string;
  gitDirty?: boolean;
  hasBuildFiles?: string[];
}

export interface MemoryLayer {
  retrievedExperiences: ExperienceRef[];  // V3填充
}

export interface ExperienceRef {
  id: string;
  type: 'failure_pattern' | 'successful_workflow' | 'gotcha' | 'environment_fact';
  summary: string;               // 注入prompt的摘要
  confidence: number;
}

export interface ContextProvider {
  name: string;
  priority: number;              // 数字越小优先级越高
  maxTokens: number;             // 该provider的token预算
  phase: 'before_turn' | 'after_tool' | 'after_turn';

  provide(
    ctx: ProviderContext,
    signal?: AbortSignal
  ): Promise<ContextChunk[]>;
}

export interface ContextChunk {
  id: string;                    // 幂等ID，避免重复注入
  source: string;                // provider name
  priority: number;
  tokens: number;                // 估算token数
  content: string;               // 最终注入system prompt的文本
  metadata?: Record<string, unknown>;
}

export interface ProviderContext {
  threadId: ThreadId;
  turnId: TurnId;
  userInput: string;
  agentContext: AgentContext;
  items: ThreadItem[];           // 当前对话历史
  runProfile: RunProfile;
}

export interface ContextEngineConfig {
  totalBudget: number;           // 总token预算（默认8000，可被runProfile覆盖）
  providers: ContextProvider[];
}

export interface AssembledContext {
  chunks: ContextChunk[];
  updatedAgentContext: AgentContext;
  usedTokens: number;
  remainingTokens: number;
}
```

### 1.4 与现有代码的衔接点

**改动1：middleware.ts — 替换 dynamicContextProvider**

现状（[middleware.ts:48-54](file:///e:/langchain/suanlizi/packages/runtime/src/middleware.ts#L48-L54)）：
```typescript
if (dynamicContextProvider) {
  const provided = await dynamicContextProvider(runtimeTurnContext);
  if (Array.isArray(provided)) dynamicContextChunks.push(...provided);
  else dynamicContextChunks.push(provided);
}
```

改为：
```typescript
const contextEngine = this.contextEngine ?? new ContextEngine({
  providers: [
    new EnvironmentContextProvider(),
    new TaskContextProvider(),
    // ProjectBrain V2注册在这里
    // MemoryContextProvider V3注册在这里
  ],
  totalBudget: runtimeTurnContext.runProfile.contextBudget ?? 8000,
});

const assembled = await contextEngine.assembleBeforeTurn({
  threadId: runtimeTurnContext.threadId,
  turnId: runtimeTurnContext.turnId,
  userInput: runtimeTurnContext.userInput,
  agentContext: this.agentContextByThread.get(threadId) ?? this.getInitialAgentContext(runtimeTurnContext),
  items: thread.items,
  runProfile: runtimeTurnContext.runProfile,
}, signal);

dynamicContextChunks.push(...assembled.chunks.map(c => c.content));
this.updateAgentContext(threadId, assembled.updatedAgentContext);
```

**改动2：agent.ts — 引入ContextEngine，不再直接拼context**

- 新增 `contextEngine?: ContextEngine` 字段
- `dynamicContextProvider` 标记为 `@deprecated`，保留向后兼容（内部转成ContextProvider）
- 新增 `agentContextByThread: Map<ThreadId, AgentContext>` 存储
- 从harness初始化时，如果已有goal则初始化TaskCognition

**改动3：harness对接 — GoalTracker升级使用TaskCognition**

[goalTracker.ts](file:///e:/langchain/suanlizi/packages/runtime/src/harness/goalTracker.ts) 当前把goal/constraints存在HarnessState里。改为：
- HarnessGoal只存objective/acceptanceCriteria
- TaskCognition作为AgentContext.cognition.task存在context层
- GoalTracker读写通过agentContext.cognition.task

**改动4：RunProfile扩展**

```typescript
// runProfile.ts 新增字段
contextBudget?: number;          // context总预算，覆盖默认8000
contextProviders?: string[];     // 启用的provider name列表
```

### 1.5 内置Provider实现顺序

V1只实现2个Provider（Memory Provider推迟到V3）：

1. **EnvironmentContextProvider**（最小，先写）：
   - 检测cwd、os、shell
   - 检测git branch/dirty
   - 检测build files（package.json/pom.xml/requirements.txt等）
   - 输出固定格式文本，token消耗约200-300
   - 刷新 `agentContext.world.environment`

2. **TaskContextProvider**（核心）：
   - 第一轮：基于userInput初始化TaskCognition（goal从用户输入提取，constraints空，assumptions标记"未验证"）
   - 非第一轮：读取现有cognition，输出格式化的任务状态
   - after_turn阶段：如果harness给出了新的evaluation，更新knownFacts/unknowns/confidence
   - 实现 `updateCognition(nextPartial: Partial<TaskCognition>)` 方法
   - 更新 `agentContext.cognition.task`

### 1.6 Token预算分配算法（contextAssembler.ts）

```
1. 收集所有 before_turn 阶段 provider 的 ContextChunk[]
2. 按priority排序（小的在前）
3. 依次填充，直到剩余token < 下一个chunk的tokens
4. 截断最后一个chunk（如果可以摘要截断，标记truncated=true）
5. 返回 AssembledContext { chunks, updatedAgentContext, usedTokens, remainingTokens }
```

### 1.7 持久化

- AgentContext 随 HarnessContinuationItem 一起持久化（已有harness_continuation item类型）
- 新增 `agent_context` 字段到 harnessContinuationItemSchema（[schemas.ts](file:///e:/langchain/suanlizi/packages/protocol/src/schemas.ts)）
- 非harness模式下，AgentContext仅存在内存中（agentContextByThread），不持久化——因为非harness模式是短对话，不需要跨turn恢复认知状态

### 1.8 V1验收标准

- [ ] `packages/context` 包可独立build，零runtime循环依赖
- [ ] agent.ts不再直接拼装各种context字符串（通过ContextEngine）
- [ ] dynamicContextProvider旧接口仍然可用（deprecated但不break）
- [ ] EnvironmentContextProvider输出环境信息并刷新world.environment
- [ ] TaskContextProvider初始化/更新TaskCognition（cognition.task）
- [ ] harness模式goal/verificationCriteria正确写入AgentContext.cognition.task
- [ ] token预算生效，context总长度不超过budget
- [ ] 现有测试全部通过（npm test）
- [ ] 新增context包单元测试（provider排序、token预算、agentContext更新）

---

## V2：Project Brain（GitNexus升级为Context Provider）⭐⭐⭐⭐⭐

### 2.1 目标

把GitNexus从**工具（主动调用）**升级为**Context Provider（被动注入）**，实现：
- 每轮turn自动注入项目理解，不需要LLM主动调用`gitnexus_search`
- 输出ProjectCognition（架构摘要/变更文件/风险区域/依赖图）
- 保留`gitnexus_search`等工具作为主动深度查询手段（两层互补）

### 2.2 包改动

不新建包，在现有 `packages/gitnexus` 基础上扩展：

```
packages/gitnexus/src/
├── brain/                       # 新增：Project Brain 模块
│   ├── projectBrain.ts          # ProjectBrain主类，实现ContextProvider接口
│   ├── architectureAnalyzer.ts  # 架构分析（基于codeGraph）
│   ├── changeAnalyzer.ts        # 变更分析（基于git diff/log）
│   ├── riskDetector.ts          # 风险区域检测
│   └── promptBuilder.ts         # 输出格式化
├── codeGraph/                   # 现有，增强
├── git/                         # 现有，增强
└── index.ts                     # 新增导出ProjectBrain
```

### 2.3 ProjectBrain实现ContextProvider接口

```typescript
// packages/gitnexus/src/brain/projectBrain.ts

export class ProjectBrain implements ContextProvider {
  name = 'project_brain';
  priority = 20;                  // 低于task/env(10)，高于memory(30)
  maxTokens = 2000;               // 项目上下文预算
  phase = 'before_turn' as const;

  private codeGraph: CodeGraph;
  private gitInspector: GitInspector;
  private cache: Map<string, CachedBrain>; // 按projectRoot缓存

  async provide(ctx: ProviderContext): Promise<ContextChunk[]> {
    const projectRoot = await this.detectProjectRoot(ctx);
    if (!projectRoot) return [];

    const brain = await this.getOrBuildBrain(projectRoot);
    const userInput = ctx.userInput;
    const turnId = ctx.turnId;
    const projectCtx = ctx.agentContext.world.project;

    const chunks: ContextChunk[] = [];

    // 增量注入策略：首轮全量，后续只注入delta
    const isFirstTurn = !projectCtx || !projectCtx.lastInjectedTurn;
    const architectureChanged = !projectCtx?.architectureHash || projectCtx.architectureHash !== brain.architectureHash;

    // 1. 架构摘要：仅首轮或architecture变化时注入（避免每轮浪费2000 token）
    if (isFirstTurn || architectureChanged) {
      chunks.push({
        id: `arch:${brain.architectureHash}`,
        source: this.name,
        priority: 21,
        tokens: estimateTokens(brain.architectureSummary),
        content: `## Project Architecture\n${brain.architectureSummary}`,
      });
    }

    // 2. 变更delta：如果changeVersion变化，注入变更增量
    const hasNewChanges = !projectCtx?.changeVersion || projectCtx.changeVersion !== brain.changeVersion;
    if (hasNewChanges && brain.changedFiles.length > 0) {
      const deltaContent = isFirstTurn ? brain.changeSummary : this.buildChangeDelta(projectCtx, brain);
      chunks.push({
        id: `changes:${brain.changeVersion}`,
        source: this.name,
        priority: 22,
        tokens: estimateTokens(deltaContent),
        content: isFirstTurn
          ? `## Recent Changes\n${deltaContent}`
          : `## Change Delta Since Turn ${projectCtx.lastInjectedTurn}\n${deltaContent}`,
      });
    }

    // 3. 风险区域：基于userInput相关性过滤，始终按需注入（轻量）
    const relevantRisks = this.findRelevantRisks(brain, userInput);
    if (relevantRisks.length > 0) {
      chunks.push({
        id: `risks:${turnId}`,
        source: this.name,
        priority: 23,
        tokens: estimateTokens(formatRisks(relevantRisks)),
        content: `## Risk Areas for This Task\n${formatRisks(relevantRisks)}`,
      });
    }

    return chunks;
  }

  // 更新agentContext.world.project
  updateWorldProject(ctx: ProviderContext, brain: CachedBrain): ProjectContext {
    return {
      architecture: brain.architectureSummary,
      architectureHash: brain.architectureHash,
      techStack: brain.techStack,
      changedFiles: brain.changedFiles,
      changeVersion: brain.changeVersion,
      riskyAreas: brain.riskyAreas,
      lastInjectedTurn: ctx.turnId,
    };
  }
}
```

### 2.4 各子模块职责

**architectureAnalyzer.ts** — 基于codeGraph的架构分析：
- 扫描入口文件（package.json main/index.ts等）
- 识别模块边界（目录结构→模块）
- 识别核心抽象（导出的class/interface/function）
- 检测循环依赖
- 输出：技术栈、模块拓扑、核心抽象列表、架构模式（MVC/分层/事件驱动等）
- 更新频率：codeGraph变化时重建（文件增删/改了import）

**changeAnalyzer.ts** — 变更分析：
- `git status --porcelain` 获取未提交变更
- `git diff --cached` + `git diff` 获取staged/unstaged diff
- `git log --oneline -10` 获取最近10条commit
- 分析变更文件类型（源码/配置/测试/文档）
- 分析变更影响范围（基于codeGraph的依赖图反向查找）
- 输出：变更文件列表、影响范围、变更类型

**riskDetector.ts** — 风险区域检测：
- 识别"上帝文件"（超过500行且被多处引用）
- 识别测试覆盖率低的模块（有src无test）
- 识别最近频繁修改的文件（git log -n 20 --name-only 热点）
- 识别配置文件变更风险
- 基于userInput的query相关性过滤（只注入与当前任务相关的风险）

### 2.5 CodeGraph增强

现状[codeGraph.ts](file:///e:/langchain/suanlizi/packages/gitnexus/src/codeGraph/codeGraph.ts)只有symbolIndex/fileIndex/callGraph，需增强：
- 增量更新（文件保存后只更新受影响文件，而非全量重建）
- 反向依赖图（reverseDependencies: Map<file, Set<file>>）用于影响范围分析
- 模块边界检测（基于目录结构的模块划分）

### 2.6 接入方式

在context Engine初始化时注册ProjectBrain：

```typescript
// agent.ts 或 agent 工厂函数
const contextEngine = new ContextEngine({
  providers: [
    new EnvironmentContextProvider(),
    new TaskContextProvider(),
    new ProjectBrain({ workspaceRoot: options.cwd }),  // V2新增
    // MemoryContextProvider V3新增
  ],
  totalBudget: 8000,
});
```

**不**移除现有gitnexus MCP工具和CLI。它们是主动查询层，ProjectBrain是被动注入层：
- ProjectBrain：每轮自动提供"你需要知道的项目概况"（不浪费tool call）
- `gitnexus_search/code_graph/git_inspect`：LLM需要深度查询时主动调用

### 2.7 V2验收标准

- [ ] ProjectBrain实现ContextProvider接口
- [ ] architectureAnalyzer输出架构摘要（技术栈+模块+核心抽象）
- [ ] changeAnalyzer在git dirty时输出变更摘要
- [ ] riskDetector基于userInput相关性过滤风险
- [ ] codeGraph支持增量更新和反向依赖
- [ ] ProjectBrain自动注册到ContextEngine，非code模式自动no-op
- [ ] 注入内容通过token预算控制（不超过maxTokens）
- [ ] 缓存机制避免每轮重扫全量代码
- [ ] 现有gitnexus MCP/CLI工具功能不回退
- [ ] npm test全绿

---

## V3：Experience Engine（经验引擎）⭐⭐⭐⭐

### 3.1 目标

解决Memory Write Policy问题：**什么时候写？写什么？谁批准？** 让memory从"存储"升级为"经验"。

### 3.2 核心改动

**改动1：Episode结束时引入Experience Evaluation Gate**

现状[memory.ts](file:///e:/langchain/suanlizi/packages/memory/src/memory.ts)的`sealEpisode`是自动的（基于阈值），改为：

```typescript
// packages/memory/src/experience/experienceEvaluator.ts

interface EpisodeOutcome {
  success: boolean;              // harness的goalEvaluator结果，或用户反馈
  quality: number;               // 0-1
  timeSpent: number;             // 耗时（turn数）
  toolsUsed: string[];           // 使用的工具
  iterations: IterationRecord[]; // 每轮记录（用于提取SAO）
}

interface IterationRecord {
  userInput: string;
  toolCalls: { name: string; args: unknown; result: unknown; error?: string }[];
  modelOutput: string;
  evidence: string[];
}

interface ExperienceEvaluator {
  evaluate(
    episode: Episode,
    outcome: EpisodeOutcome,
    agentContext: AgentContext
  ): Promise<ExperienceEvaluation>;
}

interface ExperienceEvaluation {
  shouldPromote: boolean;
  extractedExperiences: Experience[];  // SAO结构的行为策略
  writePolicy: WritePolicy;
}

/**
 * Experience 是行为策略，不是知识库。
 * 核心结构：Situation → Action → Outcome
 * 语义："如果看到X（情境），通常做Y（行动），会导致Z（结果）"
 * 类似人类经验：不是"X是什么"，而是"遇到X该怎么做"
 */
interface Experience {
  id: string;
  type: 'failure_pattern' | 'successful_workflow' | 'gotcha' | 'environment_fact';

  trigger: {
    context: string;            // 情境描述：什么场景下适用
    symptoms: string[];         // 触发信号：看到什么现象时想起这条经验
  };

  action: {
    steps: string[];            // 行动步骤：应该怎么做
    rationale?: string;         // 为什么这样做（可选，用于LLM理解）
  };

  outcome: {
    success: boolean;           // 这条经验导向成功还是失败
    description: string;        // 结果描述
    failureMode?: string;       // 如果是失败经验，失败模式是什么
  };

  confidence: number;           // 0-1，基于使用反馈动态调整
  sourceEpisodeId: string;
  usedCount: number;            // 被召回使用次数
  successRate?: number;         // 使用后的成功率（用于衰减/淘汰）
  lastUsedAt?: number;
}

interface WritePolicy {
  promoteToWarm: boolean;
  deduplicateAgainst?: string[];  // 需要去重的已有experience ID
}
```

**改动2：ExperienceStore — 新增经验存储**

在memory包内新增experience子模块：

```
packages/memory/src/
├── experience/
│   ├── experienceEvaluator.ts
│   ├── experienceStore.ts       // 经验的CRUD+召回（按trigger.symptoms匹配）
│   ├── saoExtractor.ts          // 从iterations提取SAO三元组
│   └── experienceDecay.ts       // 经验衰减：不用降权、失败降权、使用成功升权
├── light/working/cold (现有)
└── memory.ts
```

ExperienceStore独立于light/working/cold三层，是跨层的"行为策略"索引：
- 不存储完整conversation或总结性知识，存储SAO三元组（情境→行动→结果）
- 召回时按trigger.symptoms匹配当前上下文（tool error、特定文件类型、特定命令输出等）
- 有衰减机制：长期不用的experience降权，使用后失败的experience降权或删除
- 不是另一个RAG——它是"if-then"行为策略库，召回结果直接注入TaskContext作为guidance

**改动3：Harness结束时触发Experience Evaluation**

[taskHarness.ts](file:///e:/langchain/suanlizi/packages/runtime/src/harness/taskHarness.ts)的HarnessLoop结束（成功/失败/取消）时，调用：

```typescript
// 在goalEvaluator给出最终结果后
const outcome: EpisodeOutcome = {
  success: evalResult.status === 'satisfied',
  quality: this.estimateQuality(evalResult),
  failurePatterns: this.extractFailurePatterns(evalResult, iterations),
  keyDecisions: this.extractKeyDecisions(iterations),
  reusableWorkflow: success ? this.extractWorkflow(iterations) : undefined,
  timeSpent: iterations.length,
  toolsUsed: this.collectToolsUsed(iterations),
};

const evaluation = await experienceEvaluator.evaluate(
  currentEpisode, outcome, agentContext
);
await memory.processExperienceEvaluation(episodeId, evaluation);
```

非harness模式（普通对话）：
- turn结束时，如果有tool error或用户纠正，提取轻量级gotcha（单步SAO）
- 不做深度evaluation，避免每轮都跑模型

**改动4：MemoryContextProvider（V3新增Provider）**

V3新增MemoryContextProvider，作为ContextEngine的一个Provider注册：
1. 从ExperienceStore按trigger.symptoms匹配当前上下文
2. 拼装时experience放最前面（行为策略优先级最高）
3. 现有workingSet/episode召回放后面，作为补充
4. 总token受contextEngine.totalBudget约束

### 3.3 V3验收标准

- [ ] ExperienceEvaluator在harness结束时运行
- [ ] ExperienceStore支持CRUD和相关度召回
- [ ] failure_pattern识别常见错误（工具参数错误、路径错误、权限错误等）
- [ ] successful_workflow提取（如果harness成功，记录步骤序列）
- [ ] 写入有evaluation gate（不是自动promote）
- [ ] experience有衰减机制（不用降权、用失败标记）
- [ ] MemoryContextProvider召回时优先包含experience
- [ ] 非harness模式可提取轻量级gotcha
- [ ] 现有memory测试不回退

---

## V4：Skill Runtime（技能运行时）⭐⭐⭐⭐

### 4.1 目标

把Skill从`{instructions, tools}`（prompt级）升级为**Workflow Object**（可执行能力），支持生命周期，与Harness集成。

### 4.2 核心改动

**改动1：扩展Skill接口**

现状[extensions.ts](file:///e:/langchain/suanlizi/packages/extensions/src/extensions.ts)的skill是prompt级：
```typescript
interface Skill {
  name: string;
  instructions: string;
  tools?: Tool[];
}
```

改为：

```typescript
// packages/extensions/src/skill/skillRuntime.ts

interface SkillV2 {
  name: string;
  version: string;
  description: string;

  // 声明式：告诉LLM什么时候用
  triggers: SkillTrigger[];       // 什么情况下激活
  parameters?: z.ZodSchema;       // 参数schema

  // 生命周期方法
  prepare?(ctx: SkillContext): Promise<SkillPreparation>;
  execute?(ctx: SkillContext, params: unknown): Promise<SkillExecutionResult>;
  verify?(ctx: SkillContext, result: SkillExecutionResult): Promise<SkillVerification>;
  rollback?(ctx: SkillContext, result: SkillExecutionResult): Promise<void>;

  // 向后兼容：prompt级skill
  instructions?: string;         // 旧skill保留，V2 skill不使用
  tools?: Tool[];                // skill自带工具
}

interface SkillTrigger {
  type: 'intent' | 'keyword' | 'context' | 'user_explicit';
  pattern: string | RegExp | ((ctx: SkillContext) => boolean);
  confidence?: number;
}

interface SkillPreparation {
  goal: string;                  // 该skill的子目标（注入TaskCognition）
  prerequisites: string[];       // 前置条件检查
  requiredTools: string[];       // 需要的工具
  contextAugmentation?: string;  // 额外context注入
  verificationCriteria: string[];// 该skill的验收标准
}

interface SkillExecutionResult {
  success: boolean;
  output?: unknown;
  evidence: string[];            // 证据item IDs（对接EvidenceLedger）
  metrics?: Record<string, number>;
}

interface SkillVerification {
  passed: boolean;
  evidence: string[];
  issues?: string[];
}

interface SkillContext {
  cognitiveState: CognitiveState;
  threadId: ThreadId;
  turnId: TurnId;
  signal: AbortSignal;
  tools: ToolRegistry;           // 工具访问
  memory: Memory;                // 记忆访问
}
```

**改动2：SkillRuntime — Skill执行引擎**

```typescript
// packages/extensions/src/skill/skillRuntime.ts

class SkillRuntime {
  private skills: Map<string, SkillV2>;

  // 匹配当前上下文应该激活哪些skill
  async matchSkills(ctx: SkillContext): Promise<MatchedSkill[]>;

  // 执行skill生命周期
  async executeSkill(
    skillName: string,
    params: unknown,
    ctx: SkillContext
  ): Promise<SkillExecutionResult>;

  // 与Harness集成：skill声明的goal自动成为子goal
  async prepareSkillAsSubgoal(
    skill: SkillV2,
    ctx: SkillContext
  ): Promise<HarnessPlanNode>;    // 返回plan node给harness
}
```

**改动3：向后兼容**

- 保留SkillV1（instructions+tools）接口
- SkillRuntime检测：如果只有instructions+tools，降级为prompt级skill
- 注册时统一转换：V1 skill包装成V2（execute方法=undefined，靠instructions驱动LLM）

**改动4：Skill与Harness的集成点**

[taskHarness.ts](file:///e:/langchain/suanlizi/packages/runtime/src/harness/taskHarness.ts)在Plan阶段：
1. TaskCognition初始化后，调用`skillRuntime.matchSkills(ctx)`
2. 匹配到的skill的prepare()生成子goal
3. 子goal自动成为HarnessPlanNode
4. execute阶段如果skill有execute()方法，作为tool直接调用（而非让LLM自由发挥）
5. verify阶段用skill.verify()做确定性检查，再交给GoalEvaluator做语义检查

### 4.3 MVP Skill示例（验证V4接口）

实现1-2个skill来验证接口，而不是一次实现所有skill：

**DeploySkill示例**：
```typescript
const DeploySkill: SkillV2 = {
  name: 'deploy',
  version: '0.1.0',
  description: '部署项目到指定环境',
  triggers: [{ type: 'intent', pattern: /部署|deploy|发布/i }],
  parameters: z.object({ environment: z.enum(['dev','staging','prod']) }),

  async prepare(ctx) {
    // 检查前置条件：是否有Dockerfile、是否有CI配置、git是否dirty
    return {
      goal: `Deploy project to ${params.environment}`,
      prerequisites: ['Dockerfile exists', 'git working directory clean'],
      requiredTools: ['shell_exec', 'file_read'],
      verificationCriteria: ['Health check returns 200', 'Version matches expected'],
    };
  },

  async execute(ctx, params) {
    // 可以是确定性代码，也可以返回指令让LLM做
    // 如果是确定性代码，直接执行shell
    // 如果需要LLM判断，返回steps交给agent loop
  },

  async verify(ctx, result) {
    // curl health check
    return { passed: true, evidence: ['health-check-ok'] };
  },

  async rollback(ctx, result) {
    // 回滚到上一版本
  },
};
```

### 4.4 V4验收标准

- [ ] SkillV2接口定义完成
- [ ] SkillRuntime支持match/execute/verify生命周期
- [ ] V1 skill（instructions+tools）向后兼容
- [ ] Skill与Harness集成：prepare()返回subgoal
- [ ] Skill自带verify()作为确定性检查，优先于GoalEvaluator
- [ ] 至少1个示例Skill（如DeploySkill或TestSkill）可用
- [ ] 现有skill注册/加载不回退
- [ ] Skill匹配基于context/intent，不只是keyword

---

## 实施顺序与版本对应

| 版本 | 内容 | 预计工作量 | 依赖关系 |
|------|------|-----------|---------|
| **v1.3.0** | V1 Context Engine（基础架构） | 中 | 无 |
| **v1.4.0** | V2 Project Brain（GitNexus升级） | 大 | 依赖V1（需要ContextProvider接口） |
| **v1.5.0** | V3 Experience Engine | 中 | 依赖V1（需要CognitiveState） |
| **v1.6.0** | V4 Skill Runtime | 大 | 依赖V1（CognitiveState）+V3（Experience用于skill效果反馈） |

### 为什么V1先做且独立发版？

V1是基础设施，不改V1，V2/V3/V4都没有接入点。V1做完后agent.ts解耦，后续每个版本都可以独立开发、独立测试、独立回滚。

---

## 风险与注意事项

1. **不要过度设计**：V1的CognitiveState只定义TaskCognition的基本字段，不要一开始就加太多字段。YAGNI。
2. **向后兼容**：dynamicContextProvider旧接口在V1保留，标deprecated，v2.0再移除。
3. **token预算是硬约束**：所有Provider必须遵守maxTokens，超了contextAssembler要截断。
4. **ProjectBrain性能**：codeGraph全量扫描慢，必须做缓存+增量更新，否则每轮turn卡几秒不可接受。
5. **Experience误提取**：失败模式识别可能提取错误经验，必须有confidence阈值，低confidence的不promote。
6. **Skill Runtime不替代LLM**：Skill的execute()是给确定性操作用的（如deploy、run test），不是所有操作都变成确定性代码。LLM的灵活性仍然是核心。
