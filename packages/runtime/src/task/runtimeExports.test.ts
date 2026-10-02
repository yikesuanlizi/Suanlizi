// runtime 包入口（packages/runtime/src/index.ts）的 task/ 导出可加载性验证。
// 这里断言的是「运行时真实可 import」而不是仅类型可解析：任何把类型当值导出、
// 或撞名覆盖的写法都会在这里暴露。
import { describe, expect, it } from 'vitest';
import * as runtime from '../index.js';

const VALUE_EXPORTS = [
  'createTaskWithRun',
  'transitionRun',
  'transitionRunOfTask',
  'transitionRunAndSyncTask',
  'applyTaskSyncFromRun',
  'syncTaskFromRun',
  'createRetryRun',
  'completeRun',
  'blockForUserInput',
  'resolveUserInput',
  'attachTaskEvidence',
  'findActiveTask',
  'newTaskId',
  'newRunId',
  'TASK_NON_TERMINAL_STATUSES',
  'projectPlan',
  'projectPlanWithDiff',
  'diffPlans',
  'deriveStepId',
  'deriveStepStatus',
  'isSystemStepId',
  'ReplanGate',
  'createReplanGate',
  'trackClaimedProgress',
  'claimedSignatures',
  'stepProgressSignature',
  'claimedStallExceeded',
  'SYSTEM_STEP_ID_PATTERN',
  'STEP_ID_PREFIX',
  'workflowEvidenceId',
  'isWorkflowEvidenceId',
  'toWorkflowEvidenceSeed',
  'evidenceKindFilter',
  'WORKFLOW_EVIDENCE_ID_PREFIX',
  'WORKFLOW_EVIDENCE_RUN_SEGMENT',
  'EvidenceLedger',
] as const;

describe('@suanlizi/runtime 入口的 task 层导出', () => {
  it.each(VALUE_EXPORTS)('%s 可从包入口取到', (name) => {
    expect((runtime as Record<string, unknown>)[name]).toBeDefined();
  });

  it('入口导出的实现与子模块导出的实现是同一引用（未被别名分叉）', async () => {
    const lifecycle = await import('../task/taskLifecycle.js');
    const projection = await import('../task/planProjection.js');
    expect(runtime.createTaskWithRun).toBe(lifecycle.createTaskWithRun);
    expect(runtime.syncTaskFromRun).toBe(lifecycle.syncTaskFromRun);
    expect(runtime.projectPlan).toBe(projection.projectPlan);
    expect(runtime.ReplanGate).toBe(projection.ReplanGate);
  });
});
