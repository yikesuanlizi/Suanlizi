// Phase 0 集成测试：Fake 观测 → ActionIntent → 策略检查 → 执行 → 验证 → TaskEvent + Trace
// — English: Phase 0 integration test — fake observation → intent → policy → execute →
//   verify → task events + trace, reusing the existing AccessPolicy / ApprovalRequest /
//   RunTrace infrastructure instead of building parallel systems.
import { describe, expect, it } from 'vitest';
import {
  BrowserPolicyEngine,
  BrowserTaskMachine,
  BrowserTraceRecorder,
  FakeBrowserRuntime,
  type FakeSiteDefinition,
} from '@suanlizi/browser-runtime';
import {
  buildRuntimeAccessPolicy,
  evaluateAccessRequest,
  RunTraceSession,
  type RunTraceSink,
} from '@suanlizi/runtime';
import {
  runTraceEnvelopeSchema,
  type ActionIntent,
  type RunTraceDraft,
  type RunTraceEnvelope,
  type RunTraceSummary,
} from '@suanlizi/protocol';

// 内存 Trace sink：append 时做 schema 校验并保留 envelope，模拟真实落库。
// — English: in-memory trace sink — validates on append and keeps envelopes.
function memorySink(): { sink: RunTraceSink; envelopes: RunTraceEnvelope[] } {
  const envelopes: RunTraceEnvelope[] = [];
  const sink: RunTraceSink = {
    async append(draft: RunTraceDraft): Promise<RunTraceEnvelope> {
      const envelope = runTraceEnvelopeSchema.parse({
        version: 2,
        eventId: `evt-browser-${envelopes.length + 1}`,
        sequence: envelopes.length + 1,
        ...draft,
      }) as RunTraceEnvelope;
      envelopes.push(envelope);
      return envelope;
    },
    async updateRun(_runId: string, _summary: RunTraceSummary): Promise<void> {},
    publish(_event: RunTraceEnvelope): void {},
    reportFailure(_error: unknown, _draft: RunTraceDraft): void {},
  };
  return { sink, envelopes };
}

// 两页假站点：列表页 → 详情页（点击链接触发导航）。
// — English: two-page fake site — list page → detail page (click navigates).
const site: FakeSiteDefinition = {
  startUrl: 'https://example.com/list',
  pages: [
    {
      url: 'https://example.com/list',
      title: '结果列表',
      elements: [
        { ref: 'link-1', role: 'link', name: '结果一', text: '结果一', href: 'https://example.com/detail/1' },
        { ref: 'disabled-btn', role: 'button', name: '已禁用', text: '已禁用', enabled: false },
      ],
      content: [{ type: 'heading', text: '结果列表' }],
      onAction: (action) => {
        if (action.kind === 'click' && action.targetRef === 'link-1') {
          return { kind: 'navigate', url: 'https://example.com/detail/1' };
        }
        return undefined;
      },
    },
    {
      url: 'https://example.com/detail/1',
      title: '结果详情',
      elements: [{ ref: 'back', role: 'link', name: '返回', text: '返回' }],
      content: [{ type: 'paragraph', text: '详情内容' }],
    },
  ],
};

function clickIntent(overrides: Partial<ActionIntent> = {}): ActionIntent {
  return {
    actionId: 'act-1',
    taskId: 'task-1',
    pageId: 'page-1',
    observationId: 'obs-1',
    expectedNavigationEpoch: 1,
    kind: 'click',
    targetRef: '[e1]',
    arguments: {},
    rationale: '打开结果一',
    effect: 'local',
    risk: 'low',
    postcondition: { kind: 'url_contains', value: 'detail/1' },
    ...overrides,
  };
}

describe('Phase 0 浏览器任务闭环（复用现有 AccessPolicy / ApprovalRequest / RunTrace）', () => {
  it('Fake 观测 → 策略允许 → 执行 → 验证 committed → 任务事件 + Trace 落库', async () => {
    // 现有 AccessPolicy：允许 browser.click 工具调用。
    // — English: existing AccessPolicy — allow browser.click tool calls.
    const policy = buildRuntimeAccessPolicy({
      mode: 'workspace',
      persistentRules: [
        {
          id: 'allow-browser-click',
          effect: 'allow',
          access: 'tool_call',
          target: { kind: 'tool', toolName: 'browser.click' },
          scope: 'global',
        },
      ],
    });
    const policyEngine = new BrowserPolicyEngine({
      policy,
      evaluateAccess: (request) => evaluateAccessRequest(policy, request),
      threadId: 'thread-1',
      turnId: 'turn-1',
    });

    // 任务状态机 + Trace 会话（真实 RunTraceSession，内存 sink）。
    // — English: task machine plus a real RunTraceSession with an in-memory sink.
    const machine = new BrowserTaskMachine({ taskId: 'task-1', goal: '打开结果一' });
    machine.start();
    const { sink, envelopes } = memorySink();
    const traceSession = new RunTraceSession({
      runId: 'run-1',
      runKind: 'turn',
      threadId: 'thread-1',
      turnId: 'turn-1',
      sink,
    });
    const trace = new BrowserTraceRecorder({
      runId: 'run-1',
      threadId: 'thread-1',
      turnId: 'turn-1',
      runKind: 'turn',
      emit: (obs) => void traceSession.record(obs),
    });

    // 1. 观测
    const runtime = new FakeBrowserRuntime(site);
    const session = await runtime.start({ taskId: 'task-1' });
    const obs1 = await session.observe();
    expect(obs1.elements.map((e) => e.ref)).toEqual(['[e1]', '[e2]']);
    expect(obs1.elements[0].provenance.trust).toBe('untrusted');
    machine.acceptObservation({ observationId: obs1.observationId, pageId: obs1.pageId, navigationEpoch: obs1.navigationEpoch, elementCount: obs1.elements.length });
    trace.observed({ pageId: obs1.pageId, observationId: obs1.observationId, url: obs1.url, elementCount: obs1.elements.length });

    // 2. 生成动作意图
    const intent = clickIntent({ observationId: obs1.observationId, expectedNavigationEpoch: obs1.navigationEpoch });

    // 3. 策略检查（复用现有 evaluateAccessRequest）
    const decision = await policyEngine.evaluate(intent, { pageUrl: obs1.url });
    expect(decision.kind).toBe('allow');
    trace.policy({ actionId: intent.actionId, actionKind: intent.kind, outcome: 'allowed', risk: intent.risk, effect: intent.effect });

    // 4. 执行动作
    machine.reserve({ steps: 1 });
    machine.prepareAction({
      actionId: intent.actionId,
      taskId: intent.taskId,
      actionDigest: `sha256:${intent.actionId}`,
      effect: intent.effect,
      status: 'prepared',
      preState: { pageId: obs1.pageId, url: obs1.url, observationId: obs1.observationId, navigationEpoch: obs1.navigationEpoch },
      expectedPostcondition: intent.postcondition,
      preparedAt: Date.now(),
      evidenceRefs: [],
    });
    trace.actionStarted({ actionId: intent.actionId, actionKind: intent.kind, risk: intent.risk, effect: intent.effect });

    // 5. 验证结果
    const result = await session.act({ intent });
    expect(result.status).toBe('committed');
    if (result.status === 'committed') {
      expect(result.evidence.observed?.url).toBe('https://example.com/detail/1');
      expect(result.evidence.checks[0].passed).toBe(true);
      machine.completeAction({ actionId: intent.actionId, outcome: 'committed', evidenceRefs: [] });
    }
    trace.actionFinished({ actionId: intent.actionId, outcome: result.status === 'committed' ? 'committed' : 'uncertain', verificationPassed: result.status === 'committed' });

    // 6. 任务事件 + Trace 落库
    await traceSession.flush();
    machine.complete('已打开结果一');
    expect(machine.state.status).toBe('completed');
    expect(machine.state.usage.steps).toBe(1);

    const browserSpans = envelopes.filter((e) => e.category === 'browser');
    expect(browserSpans.length).toBe(4);
    expect(browserSpans.map((e) => e.payload.phase)).toEqual(['observe', 'policy', 'execute', 'verify']);
    expect(browserSpans.every((e) => e.payload.actionId === undefined || e.payload.actionId === 'act-1')).toBe(true);
    // 全部通过严格 schema 校验（memorySink 已在 append 时 parse）
    expect(envelopes.length).toBe(4);

    await session.close('done');
  });

  it('旧引用拒绝：导航后旧 epoch 的动作失败且不产生副作用', async () => {
    const runtime = new FakeBrowserRuntime(site);
    const session = await runtime.start({ taskId: 'task-2' });
    const obs1 = await session.observe();

    // 先完成一次导航（epoch 1 → 2）
    const first = await session.act({ intent: clickIntent({ observationId: obs1.observationId, expectedNavigationEpoch: obs1.navigationEpoch }) });
    expect(first.status).toBe('committed');

    // 用旧 epoch 的动作再次点击 → 旧引用拒绝
    const stale = await session.act({ intent: clickIntent({ actionId: 'act-stale', observationId: obs1.observationId, expectedNavigationEpoch: 1, targetRef: '[e1]' }) });
    expect(stale.status).toBe('failed');
    if (stale.status === 'failed') {
      expect(stale.error.code).toBe('STALE_EPOCH');
      expect(stale.error.retryable).toBe(true);
    }
    // 页面未被再次导航（epoch 仍是 2）
    expect(session.currentPageGraph().pages[0].navigationEpoch).toBe(2);
    await session.close('done');
  });

  it('复用现有审批协议：无规则 navigate 返回 confirm + ApprovalRequest', async () => {
    const policy = buildRuntimeAccessPolicy({ mode: 'workspace' });
    const engine = new BrowserPolicyEngine({
      policy,
      evaluateAccess: (request) => evaluateAccessRequest(policy, request),
      threadId: 'thread-1',
      turnId: 'turn-1',
    });
    const intent: ActionIntent = {
      actionId: 'act-nav',
      taskId: 'task-1',
      pageId: 'page-1',
      observationId: 'obs-1',
      expectedNavigationEpoch: 1,
      kind: 'navigate',
      arguments: { url: 'https://example.com/detail/1' },
      rationale: '打开详情页',
      effect: 'none',
      risk: 'low',
      postcondition: { kind: 'url_contains', value: 'detail/1' },
    };
    const decision = await engine.evaluate(intent, { pageUrl: 'https://example.com/list' });
    expect(decision.kind).toBe('confirm');
    if (decision.kind === 'confirm') {
      expect(decision.approvalRequest.kind).toBe('network');
      expect(decision.approvalRequest.threadId).toBe('thread-1');
      expect(decision.approvalRequest.accessRequest?.target).toEqual({ kind: 'network', host: 'example.com' });
    }
  });

  it('网络边界：file: 协议与回环地址默认拒绝', async () => {
    const policy = buildRuntimeAccessPolicy({ mode: 'workspace' });
    const engine = new BrowserPolicyEngine({
      policy,
      evaluateAccess: (request) => evaluateAccessRequest(policy, request),
      threadId: 'thread-1',
      turnId: 'turn-1',
    });
    const base = {
      taskId: 'task-1',
      pageId: 'page-1',
      observationId: 'obs-1',
      expectedNavigationEpoch: 1,
      kind: 'navigate' as const,
      rationale: '导航',
      effect: 'none' as const,
      risk: 'low' as const,
      postcondition: { kind: 'url_contains' as const, value: 'x' },
    };
    const fileIntent: ActionIntent = { ...base, actionId: 'act-file', arguments: { url: 'file:///C:/secret.txt' } };
    expect((await engine.evaluate(fileIntent)).kind).toBe('deny');

    const loopbackIntent: ActionIntent = { ...base, actionId: 'act-loop', arguments: { url: 'http://localhost:8080/admin' } };
    expect((await engine.evaluate(loopbackIntent)).kind).toBe('deny');

    const metadataIntent: ActionIntent = { ...base, actionId: 'act-meta', arguments: { url: 'http://169.254.169.254/latest/meta-data' } };
    expect((await engine.evaluate(metadataIntent)).kind).toBe('deny');
  });

  it('取消传播：AbortSignal 中止后动作以 cancelled 失败且任务状态进入终态', async () => {
    const controller = new AbortController();
    const machine = new BrowserTaskMachine({ taskId: 'task-3', goal: '取消测试', signal: controller.signal });
    machine.start();

    const slowSite: FakeSiteDefinition = {
      startUrl: 'https://example.com/slow',
      pages: [
        {
          url: 'https://example.com/slow',
          title: '慢页面',
          elements: [{ ref: 'btn', role: 'button', name: '慢按钮', text: '慢按钮' }],
          onAction: () => ({ kind: 'delay', delayMs: 200 }),
        },
      ],
      defaultDelayMs: 1,
    };
    const runtime = new FakeBrowserRuntime(slowSite);
    const session = await runtime.start({ taskId: 'task-3', signal: controller.signal });
    const obs = await session.observe();
    const intent: ActionIntent = {
      actionId: 'act-slow',
      taskId: 'task-3',
      pageId: obs.pageId,
      observationId: obs.observationId,
      expectedNavigationEpoch: obs.navigationEpoch,
      kind: 'click',
      targetRef: '[e1]',
      arguments: {},
      rationale: '触发慢动作',
      effect: 'none',
      risk: 'low',
      postcondition: { kind: 'none' },
    };
    const actPromise = session.act({ intent, signal: controller.signal });
    setTimeout(() => controller.abort(), 5);
    const result = await actPromise;
    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.error.kind).toBe('cancelled');
      expect(result.error.code).toBe('ABORTED');
    }
    expect(machine.state.status).toBe('cancelled');
    await session.close('done');
  });
});
