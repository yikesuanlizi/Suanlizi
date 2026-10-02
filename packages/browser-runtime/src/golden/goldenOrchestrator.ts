// 黄金任务 × 编排器集成:把黄金任务脚本放到 BrowserTaskOrchestrator 全闭环
// (策略 → 预算 → 账本 prepare → 执行 → 验证 → 事件/Trace)下执行——桌面端
// 真实执行路径(架构文档 16.1 第一层 + §7 决策与执行循环)。
// 与 runGoldenTask 同构:逐步骤 navigate/observe/act/assert,失败即中止;
// 区别是动作走 orchestrator 管道,策略/预算/账本/事件/Trace 全量生效。
// — English: golden task × orchestrator integration — runs golden task scripts
//   through the full BrowserTaskOrchestrator loop (policy → budget → ledger →
//   execute → verify → events/Trace), the real desktop execution path
//   (architecture §16.1 layer one + §7 decision & execution cycle).
//   Isomorphic to runGoldenTask: per-step navigate/observe/act/assert, abort on
//   first failure; the difference is that actions go through the orchestrator
//   pipeline so policy/budget/ledger/events/Trace all apply.
// 缺省语义 = 模拟『已获授权』的宿主环境:无匹配策略规则时 evaluateAccess 返回
// allow;evaluateAccess 也缺省时任何 confirm(如 external 副作用确认)自动放行,
// 使 T1-T5 无需人工审批即可全闭环(文档 16.1 固定任务集关注浏览器行为而非
// 审批 UI)。显式传入 evaluateAccess/resolveApproval 时按调用方语义
// (evaluateAccess 显式传入而 resolveApproval 缺省 → 拒绝,与 orchestrator 一致)。
// — English: defaults simulate an 'already-authorized' host: with no matching
//   policy rule evaluateAccess returns allow; when evaluateAccess is also the
//   default, any confirm (e.g. external side-effect confirmation) is approved
//   automatically, so T1-T5 close the loop without human approval (§16.1 tasks
//   focus on browser behavior, not approval UI). Explicit evaluateAccess /
//   resolveApproval follow caller semantics (explicit evaluateAccess without
//   resolveApproval → deny, matching the orchestrator default).
// navigate 执行语义:orchestrator.navigate 把导航建模为 act 管道中的一个
// navigate 动作(策略/预算/账本全走);FakeBrowserRuntime 的 act 对 navigate
// intent 无默认导航(需站点 onAction 处理,见 orchestrator.test.ts 注释),而
// runGoldenTask 的 navigate 语义是 session.navigate、Playwright 的 act 对
// navigate 也真正导航(playwrightRuntime.ts)。因此这里包装 runtime:act 管道
// 的 navigate 动作映射为 session.navigate(真实导航)+ 后置条件验证,
// 让黄金任务站点(无 onAction)在 orchestrator 闭环下也能跨页导航——与
// runGoldenTask / 桌面端 Playwright 行为一致。
// — English: navigate execution — orchestrator.navigate models navigation as a
//   navigate action in the act pipeline (policy/budget/ledger all apply);
//   FakeBrowserRuntime's act does not navigate for navigate intents unless the
//   site provides onAction, while runGoldenTask uses session.navigate and
//   Playwright's act really navigates. So the runtime is wrapped here: a
//   navigate action in the act pipeline maps to session.navigate (real
//   navigation) plus postcondition verification, letting golden task sites
//   (no onAction) cross-navigate under the orchestrator loop — matching
//   runGoldenTask and the desktop Playwright behavior.
import type {
  AccessDecision,
  AccessPolicyConfig,
  AccessRequest,
  AccessRule,
  ActionIntent,
  ApprovalRequest,
  BrowserActionKind,
  Observation,
  Postcondition,
  TaskBudget,
} from '@suanlizi/protocol';
import { normalizeAccessPolicyConfig } from '@suanlizi/protocol';
import type { ActionEvidence, ActionResult, BrowserRuntimePort } from '../port.js';
import { BrowserPolicyEngine } from '../policy.js';
import { BrowserTaskMachine, BudgetExceededError, DEFAULT_TASK_BUDGET } from '../taskMachine.js';
import { BrowserTaskOrchestrator } from '../orchestrator.js';
import type {
  GoldenAssert,
  GoldenStepResult,
  GoldenTask,
  GoldenTaskResult,
} from './goldenTypes.js';

export interface GoldenOrchestratorOptions {
  taskId?: string; // 任务 ID;缺省 = `golden-${task.id}`
  signal?: AbortSignal; // 取消信号;中止时抛 Error('cancelled')
  policy?: AccessPolicyConfig; // 缺省 = normalizeAccessPolicyConfig({ mode: 'workspace' })
  // 访问评估:缺省按 policy 持久规则简化匹配(deny 优先、allow 其次),无匹配
  // 规则 → allow——黄金任务模拟『已获授权』的宿主环境(行为语义 1)。
  // — English: default evaluates policy persistent rules (deny first, then
  //   allow); no matching rule → allow (golden tasks simulate an authorized host).
  evaluateAccess?: (request: AccessRequest) => AccessDecision;
  // 审批确认:缺省随 evaluateAccess——evaluateAccess 也缺省时放行(true,
  // 已授权宿主);evaluateAccess 显式传入时拒绝(false,与 orchestrator 一致)。
  // — English: approval resolver — defaults to approve when evaluateAccess is
  //   also defaulted (authorized host), deny when evaluateAccess is explicit.
  resolveApproval?: (request: ApprovalRequest) => Promise<boolean>;
  onApprovalRequest?: (request: ApprovalRequest) => void; // confirm 时先通知(UI 展示)
  budget?: Partial<TaskBudget>; // 预算覆盖;缺省 = DEFAULT_TASK_BUDGET
}

const BROWSER_ACTION_KINDS: readonly BrowserActionKind[] = [
  'navigate',
  'observe',
  'click',
  'type',
  'select',
  'press',
  'scroll',
  'screenshot',
  'submit',
  'download',
  'wait',
];

// 步骤 act.kind 是自由字符串,必须收窄为协议定义的 BrowserActionKind
// (与 goldenRunner 同一构造规则)。
// — English: narrows the free-form step kind into the protocol's BrowserActionKind
//   (same construction rule as goldenRunner).
function asBrowserActionKind(kind: string): BrowserActionKind {
  if ((BROWSER_ACTION_KINDS as readonly string[]).includes(kind)) {
    return kind as BrowserActionKind;
  }
  throw new Error(`golden: 未知动作类型 ${kind}`);
}

// 该后置条件意味着页面可能已变化(url_/element_ 前缀)→ act 后需重新观测。
// — English: whether the postcondition implies the page may have changed.
function pageMayHaveChanged(post: Postcondition): boolean {
  return post.kind.startsWith('url_') || post.kind.startsWith('element_');
}

// 把任意抛出的值渲染为 detail 文本;ClassifiedError 形状(带 code)优先。
// — English: renders any thrown value into a detail string (ClassifiedError first).
function describeThrown(err: unknown): string {
  if (err !== null && typeof err === 'object') {
    const e = err as { code?: unknown; message?: unknown };
    if (typeof e.code === 'string') {
      const msg = typeof e.message === 'string' ? e.message : String(err);
      return `[${e.code}] ${msg}`;
    }
  }
  return err instanceof Error ? err.message : String(err);
}

// 求值黄金断言:返回全部失败项;空数组 = 通过。
// 语义与 goldenRunner.evaluateAssert 完全一致(该函数未导出,此处按同语义
// 实现——见最终报告偏离说明)。
// — English: evaluates a golden assertion into failure strings; empty = passed.
//   Same semantics as goldenRunner's private evaluateAssert (not exported, so
//   re-implemented here with identical behavior — see the report note).
function evaluateGoldenAssert(assert: GoldenAssert, obs: Observation): string[] {
  const failures: string[] = [];
  if (assert.pageUrlContains !== undefined && !obs.url.includes(assert.pageUrlContains)) {
    failures.push(`url 不含 "${assert.pageUrlContains}"(实际 ${obs.url})`);
  }
  if (assert.titleContains !== undefined && !obs.title.includes(assert.titleContains)) {
    failures.push(`标题不含 "${assert.titleContains}"(实际 "${obs.title}")`);
  }
  if (assert.contentContains !== undefined) {
    const text = obs.mainContent.map((b) => b.text).join('\n');
    if (!text.includes(assert.contentContains)) {
      failures.push(`mainContent 不含 "${assert.contentContains}"`);
    }
  }
  if (assert.elementCountAtLeast !== undefined && obs.elements.length < assert.elementCountAtLeast) {
    failures.push(`元素数量 ${obs.elements.length} 少于下限 ${assert.elementCountAtLeast}`);
  }
  if (assert.hasElementText !== undefined) {
    const needle = assert.hasElementText;
    const hit = obs.elements.some((e) => e.text !== undefined && e.text.includes(needle));
    if (!hit) failures.push(`无元素文本包含 "${assert.hasElementText}"`);
  }
  if (assert.hasElementRole !== undefined) {
    const hit = obs.elements.some((e) => e.role === assert.hasElementRole);
    if (!hit) failures.push(`无元素 role 为 "${assert.hasElementRole}"`);
  }
  return failures;
}

// 规则匹配(策略已归一化:target host 小写、toolName 去空白):
// access 与 target.kind 必须一致;tool 精确匹配 toolName;network 精确匹配 host。
// — English: rule match against a normalized policy (host lowercased,
//   toolName trimmed): access and target.kind must match; tool matches by
//   toolName; network matches by host.
function matchesRule(rule: AccessRule, request: AccessRequest): boolean {
  if (rule.access !== request.access || rule.target.kind !== request.target.kind) return false;
  if (rule.target.kind === 'tool') {
    return rule.target.toolName === (request.target as { toolName?: string }).toolName;
  }
  if (rule.target.kind === 'network') {
    return rule.target.host === (request.target as { host?: string }).host;
  }
  return true;
}

// 缺省访问评估:按 policy 持久规则简化匹配——deny 优先、allow 其次,无匹配
// 规则 → allow(而非 prompt)。黄金任务模拟『已获授权』的宿主环境:文档 16.1
// 固定任务集关注浏览器行为而非审批 UI,让 T1-T5 缺省即可全闭环。
// — English: default access evaluation — simplified persistent-rule matching
//   (deny first, then allow); no match → allow instead of prompt. Golden tasks
//   simulate an 'already-authorized' host: the §16.1 fixed task set exercises
//   browser behavior, not approval UI, so T1-T5 pass with defaults.
function defaultEvaluateAccess(policy: AccessPolicyConfig) {
  return (request: AccessRequest): AccessDecision => {
    const deny = policy.persistentRules.find((r) => r.effect === 'deny' && matchesRule(r, request));
    if (deny !== undefined) {
      return {
        decision: 'deny',
        request,
        source: 'persistent_rule',
        matchedRuleId: deny.id,
        justification: deny.reason ?? '命中持久拒绝规则',
      };
    }
    const allow = policy.persistentRules.find((r) => r.effect === 'allow' && matchesRule(r, request));
    if (allow !== undefined) {
      return {
        decision: 'allow',
        request,
        source: 'persistent_rule',
        matchedRuleId: allow.id,
        justification: allow.reason ?? '命中持久允许规则',
      };
    }
    return { decision: 'allow', request, source: 'workspace_default', justification: '黄金任务:模拟已授权的宿主环境' };
  };
}

// 缺省审批:已授权宿主环境 → 任何到达 confirm 的请求自动放行
// (如 policy 引擎对 external 副作用/高风险动作的确认)。
// — English: default approval — an authorized host approves any confirm
//   (e.g. policy-engine external side-effect / high-risk confirmation).
async function defaultResolveApproval(_request: ApprovalRequest): Promise<boolean> {
  return true;
}

// 缺省审批:调用方显式管理审批(evaluateAccess 显式传入)但未给 resolveApproval
// → 拒绝,与 orchestrator 的『缺省 = 拒绝』语义一致。
// — English: default denial — the caller manages approvals explicitly
//   (evaluateAccess provided) without a resolver → deny, matching the
//   orchestrator's default.
async function defaultDenyApproval(_request: ApprovalRequest): Promise<boolean> {
  return false;
}

// navigate 后置条件求值(none / url_contains / url_equals);未知 kind 视为未满足
// (与 fake 的 evaluatePostconditions 对未知 kind 返回 false 一致)。
// — English: navigate postcondition check (none / url_contains / url_equals);
//   unknown kinds fail (matching fake's evaluatePostconditions).
function navigatePostconditionPassed(post: Postcondition, url: string): boolean {
  if (post.kind === 'none') return true;
  if (post.kind === 'url_contains') return url.includes(post.value);
  if (post.kind === 'url_equals') return url === post.value;
  return false;
}

// 包装 runtime:让 act 管道中的 navigate 动作真正导航(见文件头注释)。
// 显式委托 session 的全部方法(spread 会丢失类私有字段与原型方法)。
// — English: wraps the runtime so navigate actions in the act pipeline really
//   navigate (see the header). Delegates every session method explicitly
//   (spread would drop class private fields and prototype methods).
function wrapRuntimeNavigation(runtime: BrowserRuntimePort): BrowserRuntimePort {
  return {
    kind: runtime.kind,
    async start(input: { taskId: string; signal?: AbortSignal }) {
      const session = await runtime.start(input);
      return {
        sessionId: session.sessionId,
        taskId: session.taskId,
        close: (reason?: string) => session.close(reason),
        currentPageGraph: () => session.currentPageGraph(),
        observe: (obsInput?: { signal?: AbortSignal; pageId?: string }) => session.observe(obsInput),
        navigate: (navInput: { url: string; signal?: AbortSignal }) => session.navigate(navInput),
        async act(actInput: { intent: ActionIntent; signal?: AbortSignal }): Promise<ActionResult> {
          const { intent, signal } = actInput;
          if (intent.kind !== 'navigate') {
            return session.act(actInput);
          }
          // navigate 动作:执行真实导航 + 按 act 语义验证后置条件、构造证据。
          // — English: navigate action — real navigation + act-semantics
          //   postcondition verification and evidence.
          try {
            const obs = await session.navigate({ url: String(intent.arguments.url), signal });
            const passed = navigatePostconditionPassed(intent.postcondition, obs.url);
            const evidence: ActionEvidence = {
              actionId: intent.actionId,
              verifiedAt: Date.now(),
              checks: [{ postcondition: JSON.stringify(intent.postcondition), passed }],
            };
            if (passed) {
              return { status: 'committed', evidence };
            }
            return { status: 'uncertain', reason: '后置条件未满足', evidence };
          } catch (err) {
            const message =
              err !== null && typeof err === 'object' && typeof (err as { message?: unknown }).message === 'string'
                ? (err as { message: string }).message
                : err instanceof Error
                  ? err.message
                  : String(err);
            return {
              status: 'failed',
              error: {
                kind: 'page',
                code: 'NAVIGATE_FAILED',
                message,
                retryable: true,
                actionId: intent.actionId,
              },
            };
          }
        },
      };
    },
  };
}

// 在 orchestrator 全闭环下运行黄金任务:
// 1. 构造 BrowserTaskMachine + BrowserPolicyEngine + BrowserTaskOrchestrator。
// 2. orchestrator.start() → 逐步骤:navigate → orchestrator.navigate;
//    observe → orchestrator.observe;act → 构造 ActionIntent(goldenRunner 规则)
//    → orchestrator.runAction(committed 通过 / uncertain·failed 该步失败 /
//    BudgetExceededError → 该步失败含预算);assert → 对最近观测求值。
// 3. 每步前检查 signal.aborted → 抛 Error('cancelled')(不吞取消)。
// 4. 结果结构与 GoldenTaskResult 一致;结束时 orchestrator.close() 由
//    try/finally 保证;未全部通过时 orchestrator 不额外置终态(调用方看结果)。
// — English: runs a golden task through the orchestrator loop — build machine +
//   policy engine + orchestrator; start; per-step navigate/observe/act/assert via
//   the orchestrator pipeline; abort check before every step (throws 'cancelled');
//   result mirrors GoldenTaskResult; orchestrator.close() in finally.
export async function runGoldenTaskWithOrchestrator(
  runtime: BrowserRuntimePort,
  task: GoldenTask,
  options?: GoldenOrchestratorOptions,
): Promise<GoldenTaskResult> {
  const startedAt = Date.now();
  const taskId = options?.taskId ?? `golden-${task.id}`;
  const signal = options?.signal;
  // 缺省策略:'workspace' 模式,无规则。
  // — English: default policy — workspace mode, no rules.
  const policy = options?.policy ?? normalizeAccessPolicyConfig({ mode: 'workspace' });
  const evaluateAccess = options?.evaluateAccess ?? defaultEvaluateAccess(policy);
  // 审批语义见文件头注释:完全缺省 → 放行;显式 evaluateAccess → 缺省拒绝。
  // — English: approval semantics per the header: full defaults → approve;
  //   explicit evaluateAccess without resolver → deny.
  const resolveApproval =
    options?.resolveApproval
    ?? (options?.evaluateAccess !== undefined ? defaultDenyApproval : defaultResolveApproval);

  const machine = new BrowserTaskMachine({
    taskId,
    goal: task.goal,
    budget: { ...DEFAULT_TASK_BUDGET, ...options?.budget },
    signal,
  });
  const policyEngine = new BrowserPolicyEngine({
    policy,
    evaluateAccess,
    threadId: `thread-${taskId}`,
    turnId: `turn-${taskId}`,
    // 预算里的外部写上限与策略写预算保持一致。
    // — English: the budget's external-write cap feeds the policy write budget.
    maxExternalWrites: options?.budget?.maxExternalWrites,
  });
  const orchestrator = new BrowserTaskOrchestrator({
    runtime: wrapRuntimeNavigation(runtime),
    policyEngine,
    machine,
    onApprovalRequest: options?.onApprovalRequest,
    resolveApproval,
  });

  const steps: GoldenStepResult[] = [];
  let latestObservation: Observation | undefined;
  let failedStepId: string | undefined;

  try {
    if (signal?.aborted) throw new Error('cancelled');
    latestObservation = await orchestrator.start({ signal });

    for (let i = 0; i < task.steps.length; i++) {
      const step = task.steps[i];
      // 每步前检查取消。
      // — English: check cancellation before every step.
      if (signal?.aborted) throw new Error('cancelled');

      let passed = true;
      let detail = '';

      if (step.navigate !== undefined) {
        try {
          latestObservation = await orchestrator.navigate({ url: step.navigate.url, signal });
          detail = `导航到 ${step.navigate.url}`;
        } catch (err) {
          if (err instanceof BudgetExceededError) {
            // 预算超限(导航也走 runAction 的 reserve)。
            // — English: budget exceeded (navigate goes through runAction's reserve).
            passed = false;
            detail = `预算超限:${err.resource}`;
          } else if (signal?.aborted) {
            throw new Error('cancelled');
          } else {
            passed = false;
            detail = `导航失败 ${describeThrown(err)}`;
          }
        }
      } else if (step.observe !== undefined) {
        latestObservation = await orchestrator.observe({ signal });
        detail = `观测 ${latestObservation.observationId}`;
      } else if (step.act !== undefined) {
        // 防御:act 之前还没有观测时先补一次观测。
        // — English: defensively observe once if no observation exists yet.
        if (latestObservation === undefined) {
          latestObservation = await orchestrator.observe({ signal });
        }
        const intent: ActionIntent = {
          actionId: `${task.id}-${step.id}-${i}`,
          taskId,
          pageId: latestObservation.pageId,
          observationId: latestObservation.observationId,
          expectedNavigationEpoch: latestObservation.navigationEpoch,
          kind: asBrowserActionKind(step.act.kind),
          targetRef: step.act.targetRef,
          arguments: {
            ...(step.act.arguments ?? {}),
            ...(step.act.value !== undefined ? { value: step.act.value } : {}),
          },
          rationale: step.act.rationale ?? step.description,
          effect: step.act.effect ?? 'local',
          risk: step.act.risk ?? 'low',
          postcondition: step.act.postcondition,
        };
        try {
          const result = await orchestrator.runAction({ intent, signal });
          if (result.outcome === 'committed') {
            detail = `动作 ${intent.kind}${intent.targetRef !== undefined ? ` ${intent.targetRef}` : ''} 已提交`;
            // 页面可能变化(url_/element_ 后置条件)→ 重新观测刷新 latestObservation。
            // — English: page may have changed → re-observe to refresh latestObservation.
            if (pageMayHaveChanged(intent.postcondition)) {
              try {
                latestObservation = await orchestrator.observe({ signal });
              } catch {
                // 动作已 committed;刷新观测失败只影响后续步骤的引用,不翻转本步状态。
                // — English: action already committed; a failed refresh only
                //   affects later refs, it does not flip this step.
              }
            }
          } else if (result.outcome === 'uncertain') {
            const reason = result.result.status === 'uncertain' ? result.result.reason : '未知';
            passed = false;
            detail = `动作结果 uncertain:${reason}`;
          } else {
            // failed:取消类错误向上传播为 cancelled;其余记录错误码。
            // — English: failed — cancellation propagates, other errors are recorded.
            if (result.result.status === 'failed' && result.result.error.kind === 'cancelled') {
              throw new Error('cancelled');
            }
            const code = result.result.status === 'failed' ? result.result.error.code : 'UNKNOWN';
            const message = result.result.status === 'failed' ? result.result.error.message : '';
            passed = false;
            detail = `动作失败 [${code}] ${message}`;
          }
        } catch (err) {
          if (err instanceof BudgetExceededError) {
            // 预算超限:该步 failed,detail 含预算资源名。
            // — English: budget exceeded — step fails with the budget resource.
            passed = false;
            detail = `预算超限:${err.resource}`;
          } else if (signal?.aborted) {
            throw new Error('cancelled');
          } else {
            throw err;
          }
        }
      } else if (step.assert !== undefined) {
        // 防御:assert 之前还没有观测时先补一次观测。
        // — English: defensively observe once if no observation exists yet.
        if (latestObservation === undefined) {
          latestObservation = await orchestrator.observe({ signal });
        }
        const failures = evaluateGoldenAssert(step.assert, latestObservation);
        if (failures.length === 0) {
          detail = '断言通过';
        } else {
          passed = false;
          detail = `断言失败:${failures.join(';')}`;
        }
      } else {
        passed = false;
        detail = '步骤未定义任何动作(navigate/act/observe/assert)';
      }

      steps.push({ id: step.id, status: passed ? 'passed' : 'failed', detail });
      if (!passed) {
        failedStepId = step.id;
        break;
      }
    }
  } finally {
    await orchestrator.close('golden-run-finished');
  }

  return {
    taskId,
    passed: failedStepId === undefined,
    steps,
    startedAt,
    finishedAt: Date.now(),
    ...(failedStepId !== undefined ? { failedStepId } : {}),
  };
}
