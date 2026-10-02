// Harness 模块入口：对外导出所有 harness 相关类型与组件。

export * from './types.js';
export { EvidenceLedger } from './evidenceLedger.js';
export {
  GoalTracker,
  GOAL_TRACKER_TAG_ACTIVE_RUN_ID,
  GOAL_TRACKER_TAG_STATE_PREFIX,
} from './goalTracker.js';
export type { GoalTrackerStore } from './goalTracker.js';
export { StormBreaker } from './stormBreaker.js';
export { HarnessContextManager, renderHarnessContextSlice, estimateTokens } from './harnessContext.js';
export type { HarnessContextStore } from './harnessContext.js';
export { ReadinessCritic, isVerificationCommand, EVIDENCE_KIND_WHITELIST } from './readinessCritic.js';
export {
  extractPlanFromItems,
  HarnessPlanSync,
  toHarnessNodes,
  validEvidenceIdsFromReceipts,
  PLAN_BLOCK_LANGUAGE,
} from './planSync.js';
export type {
  ApplyModelPlanOptions,
  ApplyModelPlanResult,
  PlanExtractionResult,
} from './planSync.js';
export { GoalEvaluator, GoalEvaluationParseError } from './goalEvaluator.js';
export type { EvaluatorModelGateway } from './goalEvaluator.js';
export { TaskHarnessEngine } from './taskHarness.js';
export type { HarnessAgentLoop, HarnessWorkflowOptions } from './taskHarness.js';
export {
  extractWorkflowProposal,
  WORKFLOW_CONTINUATION_HINT,
  WORKFLOW_PROPOSAL_BLOCK_LANGUAGE,
} from './workflowProposal.js';
export type {
  WorkflowProposalContext,
  WorkflowProposalExtraction,
} from './workflowProposal.js';