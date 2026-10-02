// 黄金任务 × 编排器集成测试:缺省选项跑 T1-T5 全绿、策略 deny、预算超限、
// 取消传播、confirm 审批路径(onApprovalRequest + resolveApproval)。
// — English: golden task × orchestrator integration tests — T1-T5 pass with
//   defaults, policy deny, budget exhaustion, cancellation, and the confirm
//   approval path (onApprovalRequest + resolveApproval).
import { describe, expect, it } from 'vitest';
import type {
  AccessDecision,
  AccessPolicyConfig,
  AccessRequest,
  AccessRule,
  ApprovalRequest,
} from '@suanlizi/protocol';
import type { FakeSiteDefinition } from '../fakeRuntime.js';
import { FakeBrowserRuntime } from '../fakeRuntime.js';
import type { GoldenTask } from './goldenTypes.js';
import { runGoldenTaskWithOrchestrator } from './goldenOrchestrator.js';
import { GOLDEN_TASKS, TASK_BROWSE_DETAIL_BACK } from './tasks.js';

const LIST_URL = 'https://golden.test/list';

describe('golden tasks × orchestrator', () => {
  // 1. 首批黄金任务 T1-T5 用 FakeBrowserRuntime + 缺省选项全部 passed——
  //    证明黄金任务脚本在 orchestrator 全闭环(策略/预算/账本/事件/Trace)下可执行。
  // — English: T1-T5 pass on the fake runtime with default options — golden
  //   scripts execute under the full orchestrator loop (policy/budget/ledger/events/Trace).
  for (const task of GOLDEN_TASKS) {
    it(`${task.id}(${task.name})缺省选项全部步骤 passed`, async () => {
      const runtime = new FakeBrowserRuntime(task.site);
      const result = await runGoldenTaskWithOrchestrator(runtime, task);
      expect(result.taskId).toBe(`golden-${task.id}`);
      expect(result.passed).toBe(true);
      expect(result.failedStepId).toBeUndefined();
      expect(result.steps).toHaveLength(task.steps.length);
      for (const s of result.steps) {
        expect(s.status).toBe('passed');
      }
      expect(result.finishedAt).toBeGreaterThanOrEqual(result.startedAt);
    });
  }

  // 2. 策略 deny:policy 带 browser.click 拒绝规则 + 对应 evaluateAccess,
  //    含 click 步骤的任务 → 该步 failed(detail 含 POLICY 或错误码),passed=false。
  // — English: policy deny — a click deny rule + matching evaluateAccess makes
  //   the click step fail with POLICY in the detail; passed=false.
  it('策略 deny:click 步骤 failed 且 detail 含 POLICY', async () => {
    const denyRule: AccessRule = {
      id: 'deny-click',
      effect: 'deny',
      access: 'tool_call',
      target: { kind: 'tool', toolName: 'browser.click' },
      scope: 'global',
      reason: '禁止点击测试',
    };
    const policy: AccessPolicyConfig = {
      mode: 'workspace',
      workspaceRoot: '',
      persistentRules: [denyRule],
      temporaryGrants: [],
    };
    // 对应 evaluateAccess:命中 browser.click 即 deny,其余 allow。
    // — English: matching evaluateAccess — deny browser.click, allow everything else.
    const evaluateAccess = (request: AccessRequest): AccessDecision => {
      if (
        request.access === 'tool_call'
        && request.target.kind === 'tool'
        && request.target.toolName === 'browser.click'
      ) {
        return {
          decision: 'deny',
          request,
          source: 'persistent_rule',
          matchedRuleId: denyRule.id,
          justification: denyRule.reason ?? '禁止点击',
        };
      }
      return { decision: 'allow', request, source: 'workspace_default', justification: '允许' };
    };
    const result = await runGoldenTaskWithOrchestrator(
      new FakeBrowserRuntime(TASK_BROWSE_DETAIL_BACK.site),
      TASK_BROWSE_DETAIL_BACK,
      { policy, evaluateAccess },
    );
    expect(result.passed).toBe(false);
    expect(result.failedStepId).toBe('s2');
    expect(result.steps.map((s) => s.id)).toEqual(['s1', 's2']);
    expect(result.steps[0].status).toBe('passed');
    expect(result.steps[1].status).toBe('failed');
    expect(result.steps[1].detail).toContain('POLICY');
    expect(result.steps[1].detail).toContain('禁止点击');
  });

  // 3. 预算:budget.maxSteps=1 → 多步任务第二步 runAction 抛
  //    BudgetExceededError → 该步 failed(detail 含预算资源名)。
  // — English: budget — maxSteps=1 makes the second runAction throw
  //   BudgetExceededError; the step fails with the budget resource in the detail.
  it('预算:maxSteps=1 时第二步动作步骤 failed 且 detail 含预算', async () => {
    const result = await runGoldenTaskWithOrchestrator(
      new FakeBrowserRuntime(TASK_BROWSE_DETAIL_BACK.site),
      TASK_BROWSE_DETAIL_BACK,
      { budget: { maxSteps: 1 } },
    );
    expect(result.passed).toBe(false);
    expect(result.failedStepId).toBe('s2');
    expect(result.steps.map((s) => s.id)).toEqual(['s1', 's2']);
    expect(result.steps[0].status).toBe('passed');
    expect(result.steps[1].status).toBe('failed');
    // detail 含预算资源名(steps)。
    // — English: the detail carries the budget resource name (steps).
    expect(result.steps[1].detail).toMatch(/预算超限|budget|steps/i);
  });

  // 4. 取消:signal abort 后 runner 抛 cancelled(不吞取消)。
  // — English: cancellation — the runner throws 'cancelled' after abort.
  it('取消传播:abort 后 runner 抛 cancelled', async () => {
    const site: FakeSiteDefinition = {
      startUrl: 'https://golden.test/form',
      pages: [
        {
          url: 'https://golden.test/form',
          title: '表单页',
          elements: [{ ref: 'btn-submit', role: 'button', name: '提交', text: '提交' }],
          // 长延时让 act 挂起,等待 abort 生效。
          // — English: long delay keeps act pending until abort lands.
          onAction: () => ({ kind: 'delay', delayMs: 500 }),
        },
      ],
    };
    const task: GoldenTask = {
      id: 'cancel-task',
      name: '取消任务',
      goal: '验证取消传播。',
      site,
      steps: [
        { id: 's1', description: '打开表单页', navigate: { url: 'https://golden.test/form' } },
        { id: 's2', description: '点击提交(挂起)', act: { kind: 'click', targetRef: '[e1]', postcondition: { kind: 'none' } } },
      ],
    };
    const controller = new AbortController();
    const promise = runGoldenTaskWithOrchestrator(
      new FakeBrowserRuntime(site),
      task,
      { signal: controller.signal },
    );
    setTimeout(() => controller.abort(), 20);
    await expect(promise).rejects.toThrow('cancelled');
  });

  // 5. confirm 路径:无规则 policy + evaluateAccess 返回 prompt,显式
  //    resolveApproval 收集(先 true 后 false)→ 第一步 navigate 批准通过、
  //    第二步 click 被拒失败;onApprovalRequest 收到两次确认请求。
  // — English: confirm path — rule-less policy + prompt-returning
  //   evaluateAccess with an explicit resolver (true then false): the first
  //   step (navigate) is approved, the second (click) is denied; two approval
  //   requests surface via onApprovalRequest.
  it('confirm 路径:resolveApproval 先 true 后 false → 首步批准、次步拒绝', async () => {
    const policy: AccessPolicyConfig = { mode: 'workspace', workspaceRoot: '', persistentRules: [], temporaryGrants: [] };
    const evaluateAccess = (request: AccessRequest): AccessDecision => ({
      decision: 'prompt',
      request,
      source: 'approval_required',
      justification: '需要用户临时授权',
    });
    const task: GoldenTask = {
      id: 'confirm-task',
      name: '确认路径任务',
      goal: '验证 orchestrator 的 confirm 审批路径。',
      site: {
        startUrl: LIST_URL,
        pages: [
          {
            url: LIST_URL,
            title: '列表页',
            elements: [{ ref: 'link-result-1', role: 'link', name: '结果一', text: '结果一' }],
          },
        ],
      },
      steps: [
        { id: 's1', description: '打开列表页(需批准)', navigate: { url: LIST_URL } },
        {
          id: 's2',
          description: '点击结果一(需批准)',
          act: { kind: 'click', targetRef: '[e1]', postcondition: { kind: 'none' }, effect: 'local', risk: 'low' },
        },
      ],
    };
    const approvals: ApprovalRequest[] = [];
    const answers = [true, false];
    const result = await runGoldenTaskWithOrchestrator(
      new FakeBrowserRuntime(task.site),
      task,
      {
        policy,
        evaluateAccess,
        onApprovalRequest: (request) => approvals.push(request),
        resolveApproval: async () => answers.shift() ?? false,
      },
    );
    // 两个动作(navigate + click)各触发一次确认请求。
    // — English: both actions (navigate + click) raise one approval request each.
    expect(approvals).toHaveLength(2);
    expect(approvals[0].kind).toBe('network');
    expect(approvals[1].kind).toBe('tool_call');
    // 第一次批准 → s1 通过;第二次拒绝 → s2 失败。
    // — English: first approved → s1 passed; second denied → s2 failed.
    expect(result.steps[0].status).toBe('passed');
    expect(result.steps[1].status).toBe('failed');
    expect(result.passed).toBe(false);
    expect(result.failedStepId).toBe('s2');
    expect(result.steps[1].detail).toContain('POLICY');
  });
});
