// Harness 类型定义：跨 turn 自主循环的状态、计划、证据、上下文裁切等类型。
// protocol 层共享类型（GoalEvaluation / HarnessContinuationItem）从 @suanlizi/protocol re-export，
// 避免 runtime/types.ts 与 protocol/types.ts 双份漂移（实施点 4）。

import type {
  CompactionSummary,
  GoalEvaluation,
  ItemId,
  ThreadId,
  ThreadItem,
  TurnId,
  Usage,
} from '@suanlizi/protocol';

// ─── Re-export protocol 共享类型 ────────────────────────────────────────────
// 实施点 4：GoalEvaluation / HarnessContinuationItem 统一在 protocol 定义
export type {
  GoalEvaluation,
  GoalEvaluationStatus,
  HarnessContinuationItem,
  HarnessItemVisibility,
} from '@suanlizi/protocol';

// ─── Harness 专用类型 ────────────────────────────────────────────────────────

// Harness 目标：用户定义的目标与验收标准
export interface HarnessGoal {
  objective: string;                        // 目标描述
  acceptanceCriteria: string[];             // 验收标准（必须全部通过才算达标）
  maxContinuations: number;                // 最大续跑次数，默认 8
  maxNoProgress: number;                   // 连续无进展上限，默认 2
}

// 计划节点状态：pending（待执行）/ in_progress（执行中）/ completed（已完成）/ failed（失败）
export type HarnessPlanNodeStatus = 'pending' | 'in_progress' | 'completed' | 'failed';

// Harness 计划节点：模型维护的任务分解节点
export interface HarnessPlanNode {
  id: string;
  description: string;
  status: HarnessPlanNodeStatus;
  evidenceIds: string[];                    // 支撑该节点的证据 ID
  failureReason?: string;
}

// Harness 整体状态
export type HarnessStatus = 'active' | 'satisfied' | 'blocked' | 'max_continuations' | 'no_progress' | 'cancelled';

// 结构化任务状态：GoalTracker 维护的核心状态
export interface HarnessState {
  harnessRunId: string;                    // 本次 harness run 的唯一 ID（实施点 2/6）
  goal: HarnessGoal;
  plan: HarnessPlanNode[];
  activeNodeId: string | null;             // 当前正在执行的节点
  iteration: number;                        // 当前续跑次数
  noProgressCount: number;                 // 连续无进展次数
  lastEvaluation: GoalEvaluation | null;
  lastProgressSignature: string | null;
  status: HarnessStatus;
  startedAt: string;
  updatedAt: string;
}

// ─── Evidence Receipt ────────────────────────────────────────────────────────

// 证据收据类型：tool（工具调用）/ file_change（文件变更）/ command（命令）/ test（测试）/ checkpoint / mcp / error
// / workflow_result（计划 §11.3：WorkflowRun / WorkflowAgentCall 的结构化结果物化出的证据）
export type EvidenceReceiptKind =
  | 'tool'
  | 'file_change'
  | 'command'
  | 'test'
  | 'checkpoint'
  | 'mcp'
  | 'error'
  | 'workflow_result';

// 证据状态：passed（通过）/ failed（失败）/ unknown（未知）
export type EvidenceReceiptStatus = 'passed' | 'failed' | 'unknown';

/**
 * 证据来源形态（计划 §11.3 + 盘点 §4.4 清单第 1/2 项）。
 *
 * - `thread_item`：既有主通道，一条证据一一对应一个 ThreadItem（id = `ev_<itemId>`）。
 * - `workflow`：WorkflowRun / WorkflowAgentCall 结果物化的证据，独立于普通 ThreadItem，
 *   **不保证存在 turnId / itemId**（`protocol/src/task.ts` 的 WorkflowAgentCall 注释已冻结这一点），
 *   id 命名空间为 `wev_<runId>_<agentCallId|run>`（盘点 §2 冻结），与 `ev_<itemId>` 完全隔离。
 *
 * 影响面结论：仓库内除 `evidenceLedger.ts` 的 5 个构造点外，没有任何读取方消费
 * `receipt.itemId` / `receipt.turnId`（goalEvaluator / harnessContext / readinessCritic / taskHarness
 * 只用 kind、status、summary、refs、supportsCriteria），因此选择「itemId/turnId 改为可选 +
 * sourceKind 判别」这一影响最小方案，而不是在 task 模块内做平行 Evidence 类型（平行类型会让
 * GoalEvaluator 的入参变成两套，P3 证据硬校验 gate 必须二选一，成本更高）。
 */
export type EvidenceReceiptSourceKind = 'thread_item' | 'workflow';

// 证据收据引用：指向原始 ThreadItem 的轻量指针（不复制全量内容）
export interface EvidenceReceiptRefs {
  path?: string;                           // 文件路径
  command?: string;                        // 执行的命令
  toolName?: string;                       // 工具名
  hash?: string;                           // 内容哈希
  /** Workflow 证据：所属 WorkflowRunRecord id（对应 WorkflowEvidenceSource 两分支）。 */
  runId?: string;
  /** Workflow 证据：具体某次 agent() 调用 id；run 级证据缺省。 */
  agentCallId?: string;
}

// 证据收据：只存索引和摘要，原始内容通过 itemId 从 ThreadStore 获取
export interface EvidenceReceipt {
  id: string;
  threadId: ThreadId;
  /** 来源形态判别；workflow 证据不绑定 turn/item（计划 §11.3）。 */
  sourceKind: EvidenceReceiptSourceKind;
  /** `sourceKind === 'workflow'` 时缺省（空串同样表示「无 turn 归属」，ledger 内部已按缺省处理）。 */
  turnId?: TurnId;
  /** 指向原始 ThreadItem；workflow 证据没有 ThreadItem，故缺省。 */
  itemId?: ItemId;
  /** 关联的 harness run ID；workflow 证据以 refs.runId 为主键，这里允许空串。 */
  harnessRunId: string;
  kind: EvidenceReceiptKind;
  summary: string;                         // 简短摘要
  refs: EvidenceReceiptRefs;
  supportsCriteria: string[];              // 支撑哪些验收标准（Gap 8）
  status: EvidenceReceiptStatus;
  timestamp: string;
}

// ─── Harness Context Slice ──────────────────────────────────────────────────

// 迭代上下文任务包：每轮续跑由 HarnessContextManager 构造，通过 modeInstruction 注入模型（Gap 4）
export interface HarnessContextSlice {
  // Stable Context（尽量稳定，帮助 cache hit）
  systemPrefix: string;                    // system prompt + AGENTS.md 规则

  // Working Set（当前循环真正需要的）
  goal: string;
  acceptanceCriteria: string[];
  currentNode: HarnessPlanNode | null;
  recentItems: ThreadItem[];               // 按任务相关度筛选，不是简单取最近 N 个
  failedCriteria: string[];
  lastFailure?: { node: string; reason: string };

  // Evidence References（只存引用，不塞全量）
  evidenceRefs: EvidenceReceipt[];

  // Compact Narrative（辅助方向感）
  summary?: CompactionSummary;

  // Budget
  tokenBudget: number;
}

// ─── RunTurnOptions ──────────────────────────────────────────────────────────

// runTurn 来源：user（用户输入）/ harness（harness 隐藏续跑）
export type RunTurnSource = 'user' | 'harness';

// Gap 3 / Gap 9: runTurn 第四参数，控制来源、可见性、harness 关联、生命周期副作用
export interface RunTurnOptions {
  source?: RunTurnSource;
  visibleToUser?: boolean;                 // 默认 true，harness 续跑时 false
  harnessRunId?: string;                   // 关联 harness run
  harnessIteration?: number;               // 续跑迭代序号
  extractMemory?: boolean;                 // 默认 true，harness 续跑时 false（Gap 9: 不进 cold memory）
  updateEpisode?: boolean;                 // 默认 true，harness 续跑时 true（保留 harness 轨迹）
  skipColdMemory?: boolean;                // 默认 false，harness 续跑时 true
}

// ─── Readiness / Storm / Result ──────────────────────────────────────────────

// 确定性 gate 名称（ReadinessCritic）
export type ReadinessGateName =
  | 'todo_complete'
  | 'mutation_verified'
  | 'no_unresolved_errors'
  | 'criteria_evidence'
  | 'no_storm';

// 单个 gate 判定结果
export interface ReadinessGate {
  name: ReadinessGateName;
  passed: boolean;
  detail: string;
}

// ReadinessCritic 整体判定
export interface ReadinessResult {
  passed: boolean;
  failedGates: ReadinessGate[];
  retryInstruction?: string;               // 不通过时注入给模型
}

// StormBreaker 检测结果
export interface StormBreakerResult {
  triggered: boolean;
  reason?: string;
  signature?: string;
  instruction?: string;                   // 注入给模型的 "change approach" 指令
}

// Harness 运行最终结果
export type HarnessResultStatus =
  | 'satisfied'
  | 'blocked'
  | 'max_continuations'
  | 'no_progress'
  | 'cancelled';

export interface HarnessResult {
  status: HarnessResultStatus;
  /** Gap 1: harness run 唯一标识，用于 API 状态查询和取消 */
  harnessRunId: string;
  iterations: number;
  finalEvaluation: GoalEvaluation | null;
  evidenceCount: number;
  items: ThreadItem[];
  usage: Usage | null;
}

// ─── Harness Config ───────────────────────────────────────────────────────────

// TaskHarnessEngine 配置
export interface HarnessConfig {
  maxContinuations: number;                // 默认 8
  maxNoProgress: number;                   // 默认 2
  contextBudget: number;                   // 默认 40000 tokens
  evaluatorModelName?: string;             // 可指定不同模型做 GoalEvaluator
  stormThreshold: number;                  // 默认 5
  stormBlockedThreshold: number;           // 默认 3
}

export const DEFAULT_HARNESS_CONFIG: HarnessConfig = {
  maxContinuations: 8,
  maxNoProgress: 2,
  contextBudget: 40000,
  stormThreshold: 5,
  stormBlockedThreshold: 3,
};

// ─── 工具函数类型 ─────────────────────────────────────────────────────────────

// 从 user input 提取目标
export type GoalExtractor = (userInput: unknown) => string;

// 从 user input 派生验收标准
export type CriteriaDeriver = (userInput: unknown) => Promise<string[]>;

// 续跑输入构造器
export interface ContinuationInput {
  text: string;
  modeInstruction?: string;                // Gap 4: 注入 HarnessContextSlice 渲染文本
}

// 辅助类型：harness turn 产生的 item 自带 harnessRunId/harnessIteration 字段
export interface HarnessItemFields {
  harnessRunId?: string;
  harnessIteration?: number;
}
