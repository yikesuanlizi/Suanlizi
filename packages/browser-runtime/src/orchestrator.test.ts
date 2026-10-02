// 浏览器任务编排器测试：FakeBrowserRuntime + 策略 stub（真实 evaluateAccessRequest
// 的复用由 tests/browser-phase0.test.ts 集成测试覆盖，避免 browser-runtime 依赖 runtime 包）
// — English: orchestrator tests — FakeBrowserRuntime + policy stub (real
//   evaluateAccessRequest reuse is covered by the tests/ integration suite).
import { describe, expect, it } from 'vitest';
import type {
  AccessDecision,
  AccessRequest,
  AccessRule,
  ActionIntent,
  ApprovalRequest,
  BrowserTaskEvent,
  BrowserTaskState,
  RunTraceObservation,
  TaskBudget,
} from '@suanlizi/protocol';
import { normalizeAccessPolicyConfig } from '@suanlizi/protocol';
import { BrowserPolicyEngine } from './policy.js';
import { BrowserTaskMachine, BudgetExceededError, DEFAULT_TASK_BUDGET } from './taskMachine.js';
import { BrowserTraceRecorder } from './trace.js';
import { FakeBrowserRuntime, type FakeSiteDefinition } from './fakeRuntime.js';
import type { ProgressEntry } from './progress.js';
import { BrowserTaskOrchestrator, type OrchestratorDeps } from './orchestrator.js';
import type { ActionResult, BrowserRuntimePort, BrowserSessionHandle } from './port.js';

// ─── 站点与策略 fixture ─────────────────────────────────────────────────────
// 列表页 onAction 处理 navigate（fake 的 act 需要它来真正导航），
// click 链接走默认 href 导航。
// — English: the list page handles navigate in onAction (required by fake act);
//   clicking a link uses the default href navigation.
const SITE: FakeSiteDefinition = {
  startUrl: 'https://shop.example.com/list',
  pages: [
    {
      url: 'https://shop.example.com/list',
      title: '商品列表',
      elements: [
        { ref: 'link-item-1', role: 'link', name: '查看详情', text: '商品 1', href: 'https://shop.example.com/item/1' },
        { ref: 'link-item-2', role: 'link', name: '查看详情 2', text: '商品 2', href: 'https://shop.example.com/item/2' },
      ],
      onAction: (action) => {
        if (action.kind === 'navigate') {
          const url = (action.value as { url?: unknown } | undefined)?.url;
          if (typeof url === 'string') return { kind: 'navigate', url };
        }
        return undefined;
      },
    },
    {
      url: 'https://shop.example.com/item/1',
      title: '商品详情 1',
      elements: [{ ref: 'btn-buy', role: 'button', name: '立即购买' }],
    },
    {
      url: 'https://shop.example.com/item/2',
      title: '商品详情 2',
      elements: [{ ref: 'btn-buy-2', role: 'button', name: '立即购买 2' }],
    },
  ],
};

// 下载预检测试站点：example.com 文件列表页（下载预检的同源上下文）。
// — English: download-preflight site — an example.com file-listing page
//   (the same-origin context for the download preflight).
const DOWNLOAD_SITE: FakeSiteDefinition = {
  startUrl: 'https://example.com/files',
  pages: [{ url: 'https://example.com/files', title: '文件列表', elements: [] }],
};

// 可编程 tracking runtime：包装 FakeBrowserRuntime，计数 act 调用，
// 可让前 failTimes 次 act 返回指定分类的 failed（恢复/重试测试用；不改 orchestrator）。
// — English: programmable tracking runtime — wraps FakeBrowserRuntime, counts
//   act calls, and can fail the first N acts with a chosen error class
//   (for recovery/retry tests; no orchestrator test hooks needed).
function makeTrackingRuntime(opts: { failTimes?: number; failKind?: 'transient' | 'element' } = {}): {
  runtime: BrowserRuntimePort;
  actCalls: () => number;
} {
  let actCalls = 0;
  let failuresLeft = opts.failTimes ?? 0;
  const inner = new FakeBrowserRuntime(SITE);
  const wrapSession = (session: BrowserSessionHandle): BrowserSessionHandle => ({
    get sessionId() {
      return session.sessionId;
    },
    get taskId() {
      return session.taskId;
    },
    close: (reason) => session.close(reason),
    currentPageGraph: () => session.currentPageGraph(),
    observe: (input) => session.observe(input),
    navigate: (input) => session.navigate(input),
    act: async (input) => {
      actCalls += 1;
      if (failuresLeft > 0) {
        failuresLeft -= 1;
        const kind = opts.failKind ?? 'transient';
        return {
          status: 'failed',
          error: {
            kind,
            code: kind === 'element' ? 'STALE_EPOCH' : 'NETWORK',
            message: kind === 'element' ? '观测已过期，请重新观测' : '临时网络故障',
            retryable: true,
            actionId: input.intent.actionId,
          },
        } satisfies ActionResult;
      }
      return session.act(input);
    },
  });
  return {
    runtime: {
      kind: 'fake',
      start: async (input) => wrapSession(await inner.start(input)),
    },
    actCalls: () => actCalls,
  };
}

// 允许 click 的持久规则：tool_call + browser.click 命中即 allow。
// — English: persistent allow rule for click (tool_call + browser.click).
const ALLOW_CLICK_RULE: AccessRule = {
  id: 'allow-click',
  effect: 'allow',
  access: 'tool_call',
  target: { kind: 'tool', toolName: 'browser.click' },
  scope: 'global',
  reason: '允许点击',
};

// 拒绝 click 的持久规则：evaluateAccessRequest 先查 deny 规则。
// — English: persistent deny rule for click (deny wins over allow).
const DENY_CLICK_RULE: AccessRule = {
  id: 'deny-click',
  effect: 'deny',
  access: 'tool_call',
  target: { kind: 'tool', toolName: 'browser.click' },
  scope: 'global',
  reason: '禁止点击测试',
};

// 允许 network 访问的持久规则：download 在策略层映射为 network（见
// policy.buildAccessRequest），stub 按 target.kind 匹配，host 不参与比较。
// — English: persistent network allow rule — download maps to network at the
//   policy layer (see policy.buildAccessRequest); the stub matches on
//   target.kind only, host is not compared.
const ALLOW_NETWORK_RULE: AccessRule = {
  id: 'allow-network',
  effect: 'allow',
  access: 'network',
  target: { kind: 'network', host: 'example.com' },
  scope: 'global',
  reason: '允许网络访问（下载）',
};

// 策略 stub：按持久规则模拟 evaluateAccessRequest 的子集语义（deny 优先、allow、prompt）。
// — English: policy stub — mirrors the persistent-rule subset of evaluateAccessRequest.
function stubEvaluateAccess(rules: AccessRule[]) {
  return (request: AccessRequest): AccessDecision => {
    const matches = (rule: AccessRule): boolean =>
      rule.access === request.access
      && rule.target.kind === request.target.kind
      && (rule.target.kind === 'tool' ? rule.target.toolName === request.target.toolName : true);
    const deny = rules.find((r) => r.effect === 'deny' && matches(r));
    if (deny !== undefined) {
      return { decision: 'deny', request, source: 'persistent_rule', justification: deny.reason ?? '命中持久拒绝规则' };
    }
    const allow = rules.find((r) => r.effect === 'allow' && matches(r));
    if (allow !== undefined) {
      return { decision: 'allow', request, source: 'persistent_rule', justification: allow.reason ?? '命中持久允许规则' };
    }
    return { decision: 'prompt', request, source: 'approval_required', justification: '需要用户临时授权' };
  };
}

// 策略配置：stub 按持久规则判定。
// — English: policy config — the stub decides on persistent rules.
function makePolicyConfig(rules: AccessRule[] = []): ReturnType<typeof normalizeAccessPolicyConfig> {
  return normalizeAccessPolicyConfig({
    mode: 'workspace',
    workspaceRoot: '',
    persistentRules: rules,
    temporaryGrants: [],
  });
}

// ─── 测试夹具 ────────────────────────────────────────────────────────────────
interface SetupOptions {
  rules?: AccessRule[];
  budget?: Partial<TaskBudget>;
  maxExternalWrites?: number; // 透传给 BrowserPolicyEngine（evaluate 层预检）
  machine?: BrowserTaskMachine;
  resolveApproval?: (request: ApprovalRequest) => Promise<boolean>;
  onApprovalRequest?: (request: ApprovalRequest) => void;
  runtime?: BrowserRuntimePort; // 可注入的 runtime 包装（默认 FakeBrowserRuntime）
}

interface SetupResult {
  orchestrator: BrowserTaskOrchestrator;
  machine: BrowserTaskMachine;
  policyEngine: BrowserPolicyEngine;
  traceSpans: RunTraceObservation[];
  progress: ProgressEntry[];
  checkpoints: Array<{ events: BrowserTaskEvent[]; state: BrowserTaskState }>;
  approvalRequests: ApprovalRequest[];
}

function setup(options: SetupOptions = {}): SetupResult {
  const runtime = options.runtime ?? new FakeBrowserRuntime(SITE);
  const policyConfig = makePolicyConfig(options.rules);
  const policyEngine = new BrowserPolicyEngine({
    policy: policyConfig,
    evaluateAccess: stubEvaluateAccess(options.rules ?? []),
    maxExternalWrites: options.maxExternalWrites,
    threadId: 'thread-1',
    turnId: 'turn-1',
  });
  const machine =
    options.machine
    ?? new BrowserTaskMachine({
      taskId: 'task-1',
      goal: '测试任务',
      budget: { ...DEFAULT_TASK_BUDGET, ...options.budget },
    });
  const traceSpans: RunTraceObservation[] = [];
  const trace = new BrowserTraceRecorder({
    runId: 'run-1',
    threadId: 'thread-1',
    turnId: 'turn-1',
    runKind: 'turn',
    emit: (observation) => traceSpans.push(observation),
  });
  const progress: ProgressEntry[] = [];
  const checkpoints: SetupResult['checkpoints'] = [];
  const approvalRequests: ApprovalRequest[] = [];
  const deps: OrchestratorDeps = {
    runtime,
    policyEngine,
    machine,
    trace,
    onProgress: (entry) => progress.push(entry),
    onCheckpoint: (ck) => checkpoints.push(ck),
    onApprovalRequest: (request) => {
      approvalRequests.push(request);
      options.onApprovalRequest?.(request);
    },
    resolveApproval: options.resolveApproval,
  };
  const orchestrator = new BrowserTaskOrchestrator(deps);
  return { orchestrator, machine, policyEngine, traceSpans, progress, checkpoints, approvalRequests };
}

// click 动作意图（引用列表页 [e1]）。
// — English: a click intent targeting list-page [e1].
function clickIntent(overrides: Partial<ActionIntent> = {}): ActionIntent {
  return {
    actionId: 'act-click-1',
    taskId: 'task-1',
    pageId: 'page-1',
    observationId: 'obs-1',
    expectedNavigationEpoch: 1,
    kind: 'click',
    targetRef: '[e1]',
    arguments: {},
    rationale: '点击查看详情',
    effect: 'none',
    risk: 'low',
    postcondition: { kind: 'url_contains', value: 'https://shop.example.com/item/1' },
    ...overrides,
  };
}

// navigate 动作意图（无规则时 evaluateAccess 返回 prompt → confirm）。
// — English: a navigate intent (no rules → evaluateAccess prompts → confirm).
function navigateIntent(url: string, overrides: Partial<ActionIntent> = {}): ActionIntent {
  return {
    actionId: 'act-nav-1',
    taskId: 'task-1',
    pageId: 'page-1',
    observationId: 'obs-1',
    expectedNavigationEpoch: 1,
    kind: 'navigate',
    arguments: { url },
    rationale: '导航测试',
    effect: 'none',
    risk: 'low',
    postcondition: { kind: 'url_contains', value: url },
    ...overrides,
  };
}

// 绑定意图到一次真实观测（observationId/epoch/pageId 与页面一致，避免 STALE_EPOCH）。
// — English: bind an intent to a real observation so the fake runtime accepts it.
function bindToObservation<T extends ActionIntent>(intent: T, obs: NonNullable<Awaited<ReturnType<BrowserTaskOrchestrator['start']>>>): T {
  return {
    ...intent,
    pageId: obs.pageId,
    observationId: obs.observationId,
    expectedNavigationEpoch: obs.navigationEpoch,
  };
}

// Trace payload 访问辅助（payload 是联合类型，读取字段需窄化）。
// — English: trace payload accessor (payload is a union; narrow fields here).
function browserPayload(span: RunTraceObservation): {
  phase?: string;
  outcome?: string;
  reason?: string;
  errorCode?: string;
  verificationPassed?: boolean;
} {
  return span.payload as { phase?: string; outcome?: string; reason?: string; errorCode?: string; verificationPassed?: boolean };
}

describe('BrowserTaskOrchestrator', () => {
  it('完整闭环：start→observe→runAction(click) committed，事件/trace/进度/检查点齐备', async () => {
    const { orchestrator, machine, traceSpans, progress, checkpoints } = setup({ rules: [ALLOW_CLICK_RULE] });

    const startObs = await orchestrator.start();
    expect(startObs.elements.length).toBeGreaterThan(0);

    const obs = await orchestrator.observe();
    const intent = bindToObservation(clickIntent(), obs);
    const result = await orchestrator.runAction({ intent });

    // 结果三态 + 决策
    expect(result.outcome).toBe('committed');
    expect(result.decision).toBe('allowed');
    expect(result.result.status).toBe('committed');

    // 预算与状态
    expect(machine.state.usage.steps).toBe(1);
    expect(machine.state.usage.consecutiveFailures).toBe(0);
    expect(machine.state.status).toBe('running');

    // 事件序列：task.created < observation.accepted < budget.updated < action.prepared < action.completed
    const types = machine.events.map((e) => e.type);
    const indexOf = (t: BrowserTaskEvent['type']): number => types.indexOf(t);
    expect(indexOf('task.created')).toBeGreaterThanOrEqual(0);
    expect(indexOf('task.created')).toBeLessThan(indexOf('observation.accepted'));
    expect(indexOf('observation.accepted')).toBeLessThan(indexOf('budget.updated'));
    expect(indexOf('budget.updated')).toBeLessThan(indexOf('action.prepared'));
    expect(indexOf('action.prepared')).toBeLessThan(indexOf('action.completed'));
    const completed = machine.events.find((e) => e.type === 'action.completed');
    expect(completed?.type === 'action.completed' ? completed.outcome : undefined).toBe('committed');

    // trace：observe×2（start + observe）+ policy + execute + verify
    expect(traceSpans.map((s) => browserPayload(s).phase)).toEqual(['observe', 'observe', 'policy', 'execute', 'verify']);
    expect(browserPayload(traceSpans[2]).outcome).toBe('allowed');
    expect(browserPayload(traceSpans[3]).phase).toBe('execute');
    expect(browserPayload(traceSpans[4])).toMatchObject({ phase: 'verify', outcome: 'committed', verificationPassed: true });

    // onProgress：task.created / observation.accepted / action.prepared / action.completed
    const sources = progress.map((p) => p.source);
    expect(sources).toContain('task.created');
    expect(sources).toContain('observation.accepted');
    expect(sources).toContain('action.prepared');
    expect(sources).toContain('action.completed');
    expect(progress.find((p) => p.source === 'task.created')?.tone).toBe('info');

    // onCheckpoint：每个动作后一次，events 非空
    expect(checkpoints).toHaveLength(1);
    expect(checkpoints[0].events.length).toBeGreaterThan(0);
    expect(checkpoints[0].state.usage.steps).toBe(1);
  });

  it('confirm→批准：无规则 navigate，resolveApproval true → decision confirmed 且页面已导航', async () => {
    const { orchestrator, machine, traceSpans, approvalRequests } = setup({
      resolveApproval: async () => true,
    });

    await orchestrator.start();
    const obs = await orchestrator.observe();
    const result = await orchestrator.runAction({
      intent: bindToObservation(navigateIntent('https://shop.example.com/item/2'), obs),
    });

    expect(result.decision).toBe('confirmed');
    expect(result.outcome).toBe('committed');
    expect(result.approvalRequest).toBeDefined();
    expect(result.approvalRequest?.justification).toBe('需要用户临时授权');
    expect(approvalRequests).toHaveLength(1);
    expect(machine.state.usage.steps).toBe(1);

    // 批准后 trace.policy 记 allowed（reason 标注已批准）
    const policySpan = traceSpans.find((s) => browserPayload(s).phase === 'policy');
    expect(policySpan).toBeDefined();
    expect(browserPayload(policySpan!).outcome).toBe('allowed');
    expect(browserPayload(policySpan!).reason).toBe('已批准');

    // 页面确实导航成功
    const after = await orchestrator.observe();
    expect(after.url).toBe('https://shop.example.com/item/2');
  });

  it('confirm→拒绝：resolveApproval false → decision denied、无副作用、consecutiveFailures 递增', async () => {
    const { orchestrator, machine, traceSpans } = setup({
      resolveApproval: async () => false,
    });

    await orchestrator.start();
    const obs = await orchestrator.observe();
    const result = await orchestrator.runAction({
      intent: bindToObservation(navigateIntent('https://shop.example.com/item/2'), obs),
    });

    expect(result.decision).toBe('denied');
    expect(result.outcome).toBe('failed');
    expect(result.approvalRequest).toBeUndefined();
    if (result.result.status === 'failed') {
      expect(result.result.error).toMatchObject({
        kind: 'policy',
        code: 'POLICY_DENIED',
        message: '需要用户临时授权',
        retryable: false,
        actionId: 'act-nav-1',
      });
    }
    // 预算照常消耗（reserve 先于策略），连续失败 +1
    expect(machine.state.usage.steps).toBe(1);
    expect(machine.state.usage.consecutiveFailures).toBe(1);
    // 无副作用：页面未变化，无 execute/verify 阶段
    const after = await orchestrator.observe();
    expect(after.url).toBe('https://shop.example.com/list');
    expect(traceSpans.filter((s) => browserPayload(s).phase === 'execute')).toHaveLength(0);
    expect(browserPayload(traceSpans.find((s) => browserPayload(s).phase === 'policy')!).outcome).toBe('denied');
  });

  it('navigate() 特例：走同一管道并返回新观测', async () => {
    const { orchestrator } = setup({ resolveApproval: async () => true });

    await orchestrator.start();
    const nav = await orchestrator.navigate({ url: 'https://shop.example.com/item/2' });

    expect(nav.url).toBe('https://shop.example.com/item/2');
    expect(nav.title).toBe('商品详情 2');
  });

  it('navigateFromUser() 仅接受用户地址栏的 http/https 输入，不等待 Agent 策略审批', async () => {
    const { orchestrator, approvalRequests } = setup();
    await orchestrator.start();

    const nav = await orchestrator.navigateFromUser({ url: 'https://shop.example.com/item/2' });
    expect(nav.url).toBe('https://shop.example.com/item/2');
    expect(approvalRequests).toEqual([]);

    await expect(orchestrator.navigateFromUser({ url: 'file:///C:/secret.txt' }))
      .rejects.toMatchObject({ code: 'USER_NAVIGATION_URL_BLOCKED' });
  });

  it('策略 deny：persistent deny 规则 → decision denied，页面无变化，不执行动作', async () => {
    const { orchestrator, machine, traceSpans } = setup({ rules: [DENY_CLICK_RULE] });

    await orchestrator.start();
    const obs = await orchestrator.observe();
    const result = await orchestrator.runAction({ intent: bindToObservation(clickIntent(), obs) });

    expect(result.decision).toBe('denied');
    expect(result.outcome).toBe('failed');
    if (result.result.status === 'failed') {
      expect(result.result.error).toMatchObject({
        kind: 'policy',
        code: 'POLICY_DENIED',
        message: '禁止点击测试',
        retryable: false,
        actionId: 'act-click-1',
      });
    }
    expect(machine.state.usage.consecutiveFailures).toBe(1);
    // 页面无变化且未进入执行阶段
    const after = await orchestrator.observe();
    expect(after.url).toBe('https://shop.example.com/list');
    expect(traceSpans.filter((s) => browserPayload(s).phase === 'execute')).toHaveLength(0);
    expect(traceSpans.filter((s) => browserPayload(s).phase === 'verify')).toHaveLength(0);
    expect(browserPayload(traceSpans.find((s) => browserPayload(s).phase === 'policy')!)).toMatchObject({
      outcome: 'denied',
      reason: '禁止点击测试',
    });
  });

  it('下载预检通过：同源 pdf 且大小未超限 → 继续执行并 committed', async () => {
    const { orchestrator, machine } = setup({
      rules: [ALLOW_NETWORK_RULE],
      runtime: new FakeBrowserRuntime(DOWNLOAD_SITE),
    });

    await orchestrator.start();
    const obs = await orchestrator.observe();
    const result = await orchestrator.runAction({
      intent: bindToObservation(
        {
          actionId: 'act-dl-allow-1',
          taskId: 'task-1',
          pageId: 'page-1',
          observationId: 'obs-1',
          expectedNavigationEpoch: 1,
          kind: 'download',
          arguments: {
            url: 'https://example.com/files/report.pdf',
            suggestedName: 'report.pdf',
            sizeBytes: 1024,
          },
          rationale: '下载报表',
          effect: 'none',
          risk: 'low',
          postcondition: { kind: 'download_completed' },
        } satisfies ActionIntent,
        obs,
      ),
    });

    expect(result.outcome).toBe('committed');
    expect(result.decision).toBe('allowed');
    expect(result.result.status).toBe('committed');
    // 预检不消耗额外步数：一次 runAction 即一步（由既有 reserve 处理）
    expect(machine.state.usage.steps).toBe(1);
  });

  it('下载预检拒绝：.exe 扩展名不在白名单 → failed(TYPE_BLOCKED)，底层 act 未调用', async () => {
    const { runtime, actCalls } = makeTrackingRuntime();
    const { orchestrator } = setup({ rules: [ALLOW_NETWORK_RULE], runtime });

    await orchestrator.start();
    const obs = await orchestrator.observe();
    const result = await orchestrator.runAction({
      intent: bindToObservation(
        {
          actionId: 'act-dl-deny-1',
          taskId: 'task-1',
          pageId: 'page-1',
          observationId: 'obs-1',
          expectedNavigationEpoch: 1,
          kind: 'download',
          arguments: {
            url: 'https://shop.example.com/files/malware.exe',
            suggestedName: 'malware.exe',
          },
          rationale: '下载可执行文件',
          effect: 'none',
          risk: 'low',
          postcondition: { kind: 'download_completed' },
        } satisfies ActionIntent,
        obs,
      ),
    });

    // 策略层已放行（decision allowed），下载策略拒绝（TYPE_BLOCKED）
    expect(result.outcome).toBe('failed');
    expect(result.decision).toBe('allowed');
    if (result.result.status === 'failed') {
      expect(result.result.error).toMatchObject({
        kind: 'policy',
        code: 'TYPE_BLOCKED',
        retryable: false,
        actionId: 'act-dl-deny-1',
      });
    }
    // 下载策略拒绝不重试：不附 recovery 建议
    expect(result.recovery).toBeUndefined();
    // 预检在账本 prepare/执行之前拦截：底层 runtime act 一次也未调用
    expect(actCalls()).toBe(0);
  });

  it('预算：maxSteps=1 用尽后第二次 runAction 抛 BudgetExceededError', async () => {
    const { orchestrator, machine } = setup({ rules: [ALLOW_CLICK_RULE], budget: { maxSteps: 1 } });

    await orchestrator.start();
    const obs = await orchestrator.observe();
    const first = await orchestrator.runAction({ intent: bindToObservation(clickIntent(), obs) });
    expect(first.outcome).toBe('committed');
    expect(machine.state.usage.steps).toBe(1);

    await expect(
      orchestrator.runAction({ intent: bindToObservation(clickIntent({ actionId: 'act-click-2' }), obs) }),
    ).rejects.toThrow(BudgetExceededError);
  });

  it('预算记账：外部写动作 committed 后 externalWrites 计入任务预算并随 checkpoint 持久化', async () => {
    const { orchestrator, machine } = setup({
      rules: [ALLOW_CLICK_RULE],
      budget: { maxExternalWrites: 1 },
      maxExternalWrites: 1, // policy 预检与任务预算一致
      // 外部副作用会触发强制 confirm，注入批准
      // — English: external side effects force a confirm — inject approval.
      resolveApproval: async () => true,
    });

    await orchestrator.start();
    const obs = await orchestrator.observe();
    const first = await orchestrator.runAction({
      intent: bindToObservation(clickIntent({ effect: 'external_reversible', actionId: 'act-write-1' }), obs),
    });
    expect(first.outcome).toBe('committed');
    expect(machine.state.usage.externalWrites).toBe(1);
    // checkpoint 快照含预算状态（崩溃恢复后写预算不归零）
    const ck = machine.checkpoint();
    expect(ck.state.usage.externalWrites).toBe(1);
    expect(ck.events.some((e) => e.type === 'budget.updated')).toBe(true);

    // 第二次外部写：policy 预检计数（noteExternalWrite）先达上限 → WRITE_BUDGET 拒绝
    // （evaluate 层防线；machine reserve 预算为 checkpoint 持久化的兜底层）
    // — English: the second external write is denied by the policy preflight
    //   counter (WRITE_BUDGET — the evaluate-layer guard; the machine reserve
    //   budget is the checkpoint-persisted backstop).
    const second = await orchestrator.runAction({
      intent: bindToObservation(clickIntent({ effect: 'external_reversible', actionId: 'act-write-2' }), obs),
    });
    expect(second.outcome).toBe('failed');
    if (second.result.status === 'failed') {
      // orchestrator 把策略拒绝统一包装为 POLICY_DENIED，message 携带 WRITE_BUDGET 原因
      // — English: the orchestrator wraps policy denials as POLICY_DENIED; the
      //   WRITE_BUDGET reason travels in the message.
      expect(second.result.error.code).toBe('POLICY_DENIED');
      expect(second.result.error.message).toContain('WRITE_BUDGET');
    }
  });

  it('取消：signal abort → runAction 返回 failed（kind cancelled），machine 终态 cancelled', async () => {
    const controller = new AbortController();
    const machine = new BrowserTaskMachine({
      taskId: 'task-1',
      goal: '测试任务',
      signal: controller.signal,
    });
    const { orchestrator, traceSpans } = setup({ rules: [ALLOW_CLICK_RULE], machine });

    await orchestrator.start({ signal: controller.signal });
    const obs = await orchestrator.observe();
    controller.abort();

    const result = await orchestrator.runAction({ intent: bindToObservation(clickIntent(), obs) });
    expect(result.outcome).toBe('failed');
    if (result.result.status === 'failed') {
      expect(result.result.error.kind).toBe('cancelled');
      expect(result.result.error.code).toBe('ABORTED');
    }
    // machine 已通过 signal 监听进入终态 cancelled
    expect(machine.state.status).toBe('cancelled');
    // 终态后事件流冻结：不会再追加 action.completed
    expect(machine.events.some((e) => e.type === 'action.completed')).toBe(false);
    // trace 仍记录 verify（errorCode ABORTED）
    const verifySpan = traceSpans.find((s) => browserPayload(s).phase === 'verify');
    expect(verifySpan).toBeDefined();
    expect(browserPayload(verifySpan!)).toMatchObject({ outcome: 'failed', errorCode: 'ABORTED' });
  });

  it('uncertain：postcondition 无法满足 → outcome uncertain，连续失败递增，verify verificationPassed false', async () => {
    const { orchestrator, machine, traceSpans } = setup({ rules: [ALLOW_CLICK_RULE] });

    await orchestrator.start();
    const obs = await orchestrator.observe();
    const result = await orchestrator.runAction({
      intent: bindToObservation(
        clickIntent({ postcondition: { kind: 'element_appears', ref: '[e99]' } }),
        obs,
      ),
    });

    expect(result.outcome).toBe('uncertain');
    expect(result.decision).toBe('allowed');
    expect(result.result.status).toBe('uncertain');
    expect(machine.state.usage.consecutiveFailures).toBe(1);
    expect(machine.state.usage.steps).toBe(1);

    const verifySpan = traceSpans.find((s) => browserPayload(s).phase === 'verify');
    expect(verifySpan).toBeDefined();
    expect(browserPayload(verifySpan!)).toMatchObject({ outcome: 'uncertain', verificationPassed: false });
  });

  it('close 幂等：两次 close 不抛错，machine 进入终态', async () => {
    const { orchestrator, machine } = setup({ rules: [ALLOW_CLICK_RULE] });

    await orchestrator.start();
    await orchestrator.close('完成');
    await orchestrator.close('再次关闭');

    expect(machine.state.status).toBe('cancelled');
  });

  it('onProgress 覆盖 task.created 与动作事件（prepared/completed）', async () => {
    const { orchestrator, progress } = setup({ rules: [ALLOW_CLICK_RULE] });

    await orchestrator.start();
    const obs = await orchestrator.observe();
    await orchestrator.runAction({ intent: bindToObservation(clickIntent(), obs) });

    const sources = progress.map((p) => p.source);
    expect(sources).toEqual(expect.arrayContaining(['task.created', 'observation.accepted', 'action.prepared', 'action.completed']));

    // 文案与语气
    const prepared = progress.find((p) => p.source === 'action.prepared');
    expect(prepared?.text).toContain('点击');
    expect(prepared?.tone).toBe('info');
    const completed = progress.find((p) => p.source === 'action.completed');
    expect(completed?.tone).toBe('ok');
    expect(completed?.text).toBe('操作完成');
  });

  it('requestHuman：machine 进入 waiting（wait.kind=human），onProgress 投影 human.requested（warn）', async () => {
    const { orchestrator, machine, progress } = setup({ rules: [ALLOW_CLICK_RULE] });

    await orchestrator.start();
    await orchestrator.requestHuman({
      request: {
        requestId: 'human-1',
        taskId: 'task-1',
        type: 'captcha',
        prompt: '请完成页面上的人机验证',
        timeoutMs: 60_000,
        onTimeout: 'extend',
      },
    });

    // 状态：waiting + wait={kind:'human', requestId}
    expect(machine.state.status).toBe('waiting');
    expect(machine.state.wait).toEqual({ kind: 'human', requestId: 'human-1', since: expect.any(Number) });
    // 事件流含 human.requested（携带完整 request）
    const requested = machine.events.find((e) => e.type === 'human.requested');
    expect(requested?.type === 'human.requested' ? requested.request.requestId : undefined).toBe('human-1');
    // 进度投影：tone warn、文本含 prompt
    const entry = progress.find((p) => p.source === 'human.requested');
    expect(entry).toBeDefined();
    expect(entry?.tone).toBe('warn');
    expect(entry?.text).toContain('请完成页面上的人机验证');
  });

  it('resolveHuman(approved)：状态回 running、wait 清除，onProgress 投影 human.resolved（ok）', async () => {
    const { orchestrator, machine, progress } = setup({ rules: [ALLOW_CLICK_RULE] });

    await orchestrator.start();
    await orchestrator.requestHuman({
      request: {
        requestId: 'human-1',
        taskId: 'task-1',
        type: 'input',
        prompt: '请输入短信验证码',
        timeoutMs: 60_000,
        onTimeout: 'extend',
      },
    });
    await orchestrator.resolveHuman({ requestId: 'human-1', approved: true, reason: '用户已输入验证码' });

    // 状态回 running、wait 清除
    expect(machine.state.status).toBe('running');
    expect(machine.state.wait).toBeUndefined();
    // 事件流含 human.resolved（approved=true，reason 透传）
    const resolved = machine.events.find((e) => e.type === 'human.resolved');
    expect(resolved?.type === 'human.resolved' ? resolved.approved : undefined).toBe(true);
    expect(resolved?.type === 'human.resolved' ? resolved.reason : undefined).toBe('用户已输入验证码');
    // 进度投影：ok '已确认'
    const entry = progress.find((p) => p.source === 'human.resolved');
    expect(entry).toBeDefined();
    expect(entry?.tone).toBe('ok');
    expect(entry?.text).toBe('已确认');
  });

  it('校验：resolveHuman requestId 不匹配抛 Error；终态后 requestHuman 抛 Error', async () => {
    const { orchestrator, machine } = setup({ rules: [ALLOW_CLICK_RULE] });

    await orchestrator.start();
    // 无待处理请求时 resolveHuman 直接抛错
    await expect(orchestrator.resolveHuman({ requestId: 'human-999', approved: true })).rejects.toThrow(
      /no pending human request/,
    );
    await orchestrator.requestHuman({
      request: {
        requestId: 'human-1',
        taskId: 'task-1',
        type: 'captcha',
        prompt: '请完成人机验证',
        timeoutMs: 60_000,
        onTimeout: 'extend',
      },
    });
    // requestId 不匹配（pending 是 human-1）→ 抛错且状态不受影响
    await expect(orchestrator.resolveHuman({ requestId: 'human-2', approved: true })).rejects.toThrow(
      /no pending human request/,
    );
    expect(machine.state.status).toBe('waiting');
    expect(machine.state.wait?.requestId).toBe('human-1');
    // 匹配的 requestId 可正常解决（拒绝路径）
    await orchestrator.resolveHuman({ requestId: 'human-1', approved: false });
    expect(machine.state.status).toBe('running');

    // 终态后 requestHuman 抛 Error（显式异常）
    await orchestrator.close('结束');
    expect(machine.state.status).toBe('cancelled');
    await expect(
      orchestrator.requestHuman({
        request: {
          requestId: 'human-2',
          taskId: 'task-1',
          type: 'confirm',
          prompt: '终态后的请求',
          timeoutMs: 60_000,
          onTimeout: 'abort',
        },
      }),
    ).rejects.toThrow('terminal state');
  });

  it('runActionWithRetry：transient 前两次失败自动退避重试，第三次成功 → committed，底层 act 调用 3 次', async () => {
    const { runtime, actCalls } = makeTrackingRuntime({ failTimes: 2, failKind: 'transient' });
    const { orchestrator } = setup({ rules: [ALLOW_CLICK_RULE], runtime });

    await orchestrator.start();
    const obs = await orchestrator.observe();
    const result = await orchestrator.runActionWithRetry({ intent: bindToObservation(clickIntent(), obs) });

    expect(result.outcome).toBe('committed');
    expect(result.recovery).toBeUndefined();
    // 1 次执行 + 2 次自动重试 = 3 次底层 act
    expect(actCalls()).toBe(3);
  }, 15_000);

  it('runActionWithRetry：连续 transient 失败 4 次 → 返回最后一次 failed 且 recovery.action 为 replan', async () => {
    const { runtime, actCalls } = makeTrackingRuntime({ failTimes: 4, failKind: 'transient' });
    // maxConsecutiveFailures 默认 3，4 次连续失败会触发 BudgetExceededError——
    // 提上限以便观察纯重试语义（recovery 达上限 → replan）。
    // — English: default maxConsecutiveFailures is 3; raise it so the 4th
    //   consecutive failure exercises the retry cap (replan) instead of the
    //   budget guard.
    const { orchestrator } = setup({
      rules: [ALLOW_CLICK_RULE],
      runtime,
      budget: { maxConsecutiveFailures: 10 },
    });

    await orchestrator.start();
    const obs = await orchestrator.observe();
    const result = await orchestrator.runActionWithRetry({ intent: bindToObservation(clickIntent(), obs) });

    expect(result.outcome).toBe('failed');
    if (result.result.status === 'failed') {
      expect(result.result.error).toMatchObject({ kind: 'transient', code: 'NETWORK' });
    }
    // 重试达上限（3 次）后 recovery 变为 replan，不再重试
    expect(result.recovery).toMatchObject({ action: 'replan', retryable: false });
    expect(actCalls()).toBe(4);
  }, 20_000);

  it('runActionWithRetry：element 类失败（STALE_EPOCH）→ 不自动重试，recovery.action 为 reobserve，底层 act 仅 1 次', async () => {
    const { runtime, actCalls } = makeTrackingRuntime({ failTimes: 1, failKind: 'element' });
    const { orchestrator } = setup({ rules: [ALLOW_CLICK_RULE], runtime });

    await orchestrator.start();
    const obs = await orchestrator.observe();
    const result = await orchestrator.runActionWithRetry({ intent: bindToObservation(clickIntent(), obs) });

    expect(result.outcome).toBe('failed');
    expect(result.recovery).toMatchObject({ action: 'reobserve', retryable: true });
    // reobserve 不自动重试——调用方应重新观测后再次调用
    expect(actCalls()).toBe(1);
  });

  it('runActionWithRetry：外部副作用 uncertain → recovery 为 reconcile 且不重试（即使 resolveApproval 允许）', async () => {
    const { runtime, actCalls } = makeTrackingRuntime();
    const { orchestrator } = setup({
      rules: [ALLOW_CLICK_RULE],
      runtime,
      resolveApproval: async () => true,
    });

    await orchestrator.start();
    const obs = await orchestrator.observe();
    const result = await orchestrator.runActionWithRetry({
      intent: bindToObservation(
        clickIntent({ effect: 'external_reversible', postcondition: { kind: 'element_appears', ref: '[e99]' } }),
        obs,
      ),
    });

    expect(result.outcome).toBe('uncertain');
    expect(result.recovery).toMatchObject({ action: 'reconcile', retryable: false });
    // 外部副作用结果不明：对账而非盲目重试
    expect(actCalls()).toBe(1);
  });
});
