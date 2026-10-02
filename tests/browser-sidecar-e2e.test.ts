// 浏览器四层端到端集成测试：完整生产链路在内存 transport 上闭环
//   React UI → Rust Host → Agent Runtime（BrowserTaskOrchestrator）→ Sidecar
//   （JSONL）→ FakeBrowserRuntime（架构文档 5.1；Playwright 未安装前用 Fake 验证链路）。
// — English: four-layer browser end-to-end integration test — the full production
//   chain React UI → Rust Host → Agent Runtime (BrowserTaskOrchestrator) → Sidecar
//   (JSONL) → FakeBrowserRuntime closed over an in-memory transport (architecture
//   §5.1; the Fake stands in for Playwright until it is installed).
// 覆盖场景：
//   A 完整闭环：策略放行 click → 提交 → 事件/进度/帧级证据；
//   B 策略拒绝：deny 规则 → 不向 sidecar 发 browser.act 帧；
//   C 审批：无规则 navigate → confirm → resolveApproval 批准/拒绝；
//   D 取消传播：abort → cancel 帧 → sidecar handleCancel → fake 中断。
// — English: scenarios — A full loop (policy-allowed click commits with
//   event/progress/frame evidence), B policy denial (no browser.act frame reaches
//   the sidecar), C approval (rule-less navigate → confirm → resolveApproval
//   approve/deny), D cancellation propagation (abort → cancel frame → sidecar
//   handleCancel → fake aborts).
import { describe, expect, it } from 'vitest';
import {
  BrowserPolicyEngine,
  BrowserTaskMachine,
  BrowserTaskOrchestrator,
  FakeBrowserRuntime,
  createSidecar,
  createSidecarClient,
  ipcCodec,
  type BrowserRuntimePort,
  type BrowserSessionHandle,
  type FakeSiteDefinition,
  type ProgressEntry,
  type ProtocolFrame,
  type SidecarHandle,
  type SidecarTransport,
} from '@suanlizi/browser-runtime';
import { buildRuntimeAccessPolicy, evaluateAccessRequest } from '@suanlizi/runtime';
import type {
  AccessRule,
  ActionIntent,
  ApprovalRequest,
  BrowserTaskEvent,
  BrowserTaskState,
} from '@suanlizi/protocol';

// ─── 内存 transport 桥接 ────────────────────────────────────────────────────
// sendLine → sidecarHandle.handleLine(line)；handleLine 返回的帧数组逐行回调
// client 的 onLine；close 置标志。
// — English: in-memory transport bridge — sendLine feeds sidecarHandle.handleLine;
//   the returned frame strings are replayed one by one to the client's onLine;
//   close sets a flag.
class MemoryTransport implements SidecarTransport {
  private handler: ((line: string) => void) | null = null;
  closed = false;

  constructor(private readonly sidecar: SidecarHandle) {}

  sendLine(line: string): void {
    if (this.closed) return;
    void this.sidecar.handleLine(line).then((frames) => {
      for (const frame of frames) this.handler?.(frame);
    });
  }

  onLine(handler: (line: string) => void): void {
    this.handler = handler;
  }

  close(): void {
    this.closed = true;
  }
}

// 记录型 transport：解析并记录所有从 client 发往 sidecar 的帧
// （帧类型计数 / browser.act 是否到达 / session.close 帧证据）。
// — English: recording transport — parses and records every frame the client
//   sends to the sidecar (frame-type counts / browser.act reachability /
//   session.close frame evidence).
class RecordingTransport extends MemoryTransport {
  readonly sentFrames: ProtocolFrame[] = [];

  constructor(sidecar: SidecarHandle) {
    super(sidecar);
  }

  override sendLine(line: string): void {
    const frame = ipcCodec.decodeLine(line);
    if (frame !== null) this.sentFrames.push(frame);
    super.sendLine(line);
  }
}

// ─── 站点与意图构造 ─────────────────────────────────────────────────────────
// 两页假站点：列表页 → 详情页（点击链接触发导航）。
// — English: two-page fake site — list page → detail page (link click navigates).
const twoPageSite: FakeSiteDefinition = {
  startUrl: 'https://example.com/list',
  pages: [
    {
      url: 'https://example.com/list',
      title: '结果列表',
      elements: [
        { ref: 'link-1', role: 'link', name: '结果一', text: '结果一', href: 'https://example.com/detail/1' },
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

// 慢动作假站点：onAction delay 200ms，为取消留出窗口。
// — English: slow fake site — 200ms side-effect delay leaves a cancellation window.
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
};

function clickIntent(taskId: string, overrides: Partial<ActionIntent> = {}): ActionIntent {
  return {
    actionId: `act-${taskId}`,
    taskId,
    pageId: 'page-1',
    observationId: 'obs-init',
    expectedNavigationEpoch: 1,
    kind: 'click',
    targetRef: '[e1]',
    arguments: {},
    rationale: '打开结果一',
    effect: 'local',
    risk: 'low',
    postcondition: { kind: 'url_contains', value: 'detail' },
    ...overrides,
  };
}

// ─── 装配辅助 ────────────────────────────────────────────────────────────────
// 每场景独立构建：memory transport + sidecar（FakeBrowserRuntime）+ client，
// 测试间不共享任何可变状态。
// — English: per-scenario setup — memory transport + sidecar (FakeBrowserRuntime)
//   + client are built fresh; no mutable state is shared between tests.
async function createHarness(
  site: FakeSiteDefinition,
  taskId: string,
): Promise<{ transport: RecordingTransport; client: BrowserSessionHandle }> {
  const sidecar = createSidecar({ runtime: new FakeBrowserRuntime(site), log: () => {} });
  const transport = new RecordingTransport(sidecar);
  const client = await createSidecarClient({ taskId, transport, timeoutMs: 5000 });
  return { transport, client };
}

// orchestrator 装配：client（BrowserSessionHandle）包装为 BrowserRuntimePort
// （session.start 已在 createSidecarClient 完成，start 直接返回 handle）。
// — English: orchestrator wiring — the client (BrowserSessionHandle) is wrapped
//   as a BrowserRuntimePort (session.start already happened inside
//   createSidecarClient; start returns the handle as-is).
function createOrchestrator(input: {
  taskId: string;
  goal: string;
  client: BrowserSessionHandle;
  persistentRules: AccessRule[];
  onCheckpoint?: (ck: { events: BrowserTaskEvent[]; state: BrowserTaskState }) => void;
  onProgress?: (entry: ProgressEntry) => void;
  resolveApproval?: (request: ApprovalRequest) => Promise<boolean>;
}): BrowserTaskOrchestrator {
  const policy = buildRuntimeAccessPolicy({ mode: 'workspace', persistentRules: input.persistentRules });
  const policyEngine = new BrowserPolicyEngine({
    policy,
    evaluateAccess: (request) => evaluateAccessRequest(policy, request),
    threadId: 'thread-e2e',
    turnId: 'turn-e2e',
  });
  const machine = new BrowserTaskMachine({ taskId: input.taskId, goal: input.goal });
  const runtimePort: BrowserRuntimePort = {
    kind: 'remote',
    start: async () => input.client,
  };
  return new BrowserTaskOrchestrator({
    runtime: runtimePort,
    policyEngine,
    machine,
    onCheckpoint: input.onCheckpoint,
    onProgress: input.onProgress,
    resolveApproval: input.resolveApproval,
  });
}

// ─── 场景 ────────────────────────────────────────────────────────────────────
describe('浏览器四层端到端（orchestrator → SidecarClient(JSONL) → createSidecar → FakeBrowserRuntime）', () => {
  it('场景 A 完整闭环：策略放行 click → 提交 → 事件/进度/帧级证据', async () => {
    const taskId = 'e2e-a';
    const { transport, client } = await createHarness(twoPageSite, taskId);
    const checkpoints: Array<{ events: BrowserTaskEvent[]; state: BrowserTaskState }> = [];
    const progress: ProgressEntry[] = [];

    const orchestrator = createOrchestrator({
      taskId,
      goal: '打开结果一',
      client,
      persistentRules: [
        {
          id: 'allow-browser-click',
          effect: 'allow',
          access: 'tool_call',
          target: { kind: 'tool', toolName: 'browser.click' },
          scope: 'global',
        },
      ],
      onCheckpoint: (ck) => checkpoints.push(ck),
      onProgress: (entry) => progress.push(entry),
    });

    // start → observe：链路打通（orchestrator → client → sidecar → fake）。
    // — English: start → observe — the chain is live end to end.
    const obs = await orchestrator.start();
    expect(obs.url).toBe('https://example.com/list');
    expect(obs.elements[0]?.ref).toBe('[e1]');

    // runAction click [e1]，postcondition url_contains 'detail'。
    const result = await orchestrator.runAction({
      intent: clickIntent(taskId, {
        actionId: 'act-a1',
        observationId: obs.observationId,
        expectedNavigationEpoch: obs.navigationEpoch,
      }),
    });
    expect(result.outcome).toBe('committed');
    expect(result.decision).toBe('allowed');
    if (result.result.status === 'committed') {
      expect(result.result.evidence.observed?.url).toBe('https://example.com/detail/1');
      expect(result.result.evidence.checks[0]?.passed).toBe(true);
    }
    expect(orchestrator.state().usage.steps).toBe(1);

    // onCheckpoint：事件快照非空且含 task.created；onProgress 至少一条。
    // — English: onCheckpoint — a non-empty event snapshot containing
    //   task.created; onProgress fires at least once.
    expect(checkpoints.length).toBeGreaterThanOrEqual(1);
    const lastCk = checkpoints[checkpoints.length - 1]!;
    expect(lastCk.events.length).toBeGreaterThan(0);
    expect(lastCk.events.some((e) => e.type === 'task.created')).toBe(true);
    expect(progress.length).toBeGreaterThanOrEqual(1);

    // close：orchestrator.close → client.close → session.close 帧到达 transport。
    // — English: close — orchestrator.close → client.close → a session.close
    //   frame crosses the transport.
    await orchestrator.close('done');
    expect(transport.sentFrames.some((f) => f.action === 'session.close')).toBe(true);
  }, 15000);

  it('场景 B 策略拒绝不执行：deny browser.click → sidecar 收不到 browser.act 帧', async () => {
    const taskId = 'e2e-b';
    const { transport, client } = await createHarness(twoPageSite, taskId);
    const orchestrator = createOrchestrator({
      taskId,
      goal: '尝试点击',
      client,
      persistentRules: [
        {
          id: 'deny-browser-click',
          effect: 'deny',
          access: 'tool_call',
          target: { kind: 'tool', toolName: 'browser.click' },
          scope: 'global',
        },
      ],
    });
    const obs = await orchestrator.start();

    const result = await orchestrator.runAction({
      intent: clickIntent(taskId, {
        actionId: 'act-b1',
        observationId: obs.observationId,
        expectedNavigationEpoch: obs.navigationEpoch,
      }),
    });
    expect(result.outcome).toBe('failed');
    expect(result.decision).toBe('denied');
    if (result.result.status === 'failed') {
      expect(result.result.error.kind).toBe('policy');
      expect(result.result.error.code).toBe('POLICY_DENIED');
    }

    // 底层 sidecar 未收到 browser.act 帧（帧类型计数为零），页面未被导航。
    // — English: no browser.act frame ever reached the sidecar (zero frame-type
    //   count) and the page did not navigate.
    expect(transport.sentFrames.filter((f) => f.action === 'browser.act')).toHaveLength(0);
    const after = await orchestrator.observe();
    expect(after.url).toBe('https://example.com/list');
    await orchestrator.close('done');
  }, 15000);

  it('场景 C 审批 confirm→批准：无规则 navigate 走审批，批准成功、拒绝页面不变', async () => {
    const taskId = 'e2e-c';
    const { transport, client } = await createHarness(twoPageSite, taskId);
    const approvals: ApprovalRequest[] = [];
    let approve = true;
    const orchestrator = createOrchestrator({
      taskId,
      goal: '打开详情页',
      client,
      persistentRules: [],
      resolveApproval: async (request) => {
        approvals.push(request);
        return approve;
      },
    });
    const obs = await orchestrator.start();

    const navIntent = (actionId: string, epoch: number, observationId: string): ActionIntent => ({
      actionId,
      taskId,
      pageId: obs.pageId,
      observationId,
      expectedNavigationEpoch: epoch,
      kind: 'navigate',
      arguments: { url: 'https://example.com/detail/1' },
      rationale: '打开详情页',
      effect: 'none',
      risk: 'low',
      postcondition: { kind: 'url_contains', value: 'detail/1' },
    });

    // 1) resolveApproval → true：navigate 成功，Observation url 为详情页。
    // — English: 1) resolveApproval → true — navigate commits and the
    //   observation URL is the detail page.
    const approved = await orchestrator.runAction({
      intent: navIntent('nav-c1', obs.navigationEpoch, obs.observationId),
    });
    expect(approved.decision).toBe('confirmed');
    expect(approved.outcome).toBe('committed');
    expect(approved.approvalRequest?.kind).toBe('network');
    expect(approvals).toHaveLength(1);
    const afterApproved = await orchestrator.observe();
    expect(afterApproved.url).toBe('https://example.com/detail/1');

    // 2) resolveApproval → false：decision denied，页面未变（仍是详情页）。
    // — English: 2) resolveApproval → false — decision denied and the page
    //   stays where it is (still the detail page).
    approve = false;
    const denied = await orchestrator.runAction({
      intent: navIntent('nav-c2', afterApproved.navigationEpoch, afterApproved.observationId),
    });
    expect(denied.decision).toBe('denied');
    expect(denied.outcome).toBe('failed');
    expect(approvals).toHaveLength(2);
    const afterDenied = await orchestrator.observe();
    expect(afterDenied.url).toBe('https://example.com/detail/1');
    await orchestrator.close('done');
  }, 15000);

  it('场景 D 取消传播：abort → cancel 帧 → sidecar handleCancel → fake 中断', async () => {
    const taskId = 'e2e-d';
    const { transport, client } = await createHarness(slowSite, taskId);
    const orchestrator = createOrchestrator({
      taskId,
      goal: '取消测试',
      client,
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
    const obs = await orchestrator.start();

    // runAction 传入 AbortSignal；启动后 5ms abort。
    // — English: runAction takes an AbortSignal; abort fires 5ms after start.
    const controller = new AbortController();
    const actPromise = orchestrator.runAction({
      intent: clickIntent(taskId, {
        actionId: 'act-d1',
        observationId: obs.observationId,
        expectedNavigationEpoch: obs.navigationEpoch,
        postcondition: { kind: 'none' },
      }),
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 5);

    // 链路：abort → SidecarClient 发 cancel 帧 → sidecar handleCancel →
    // FakeRuntime abortableDelay 中断 → failed(cancelled)。
    // — English: the chain — abort → SidecarClient sends a cancel frame →
    //   sidecar handleCancel → FakeRuntime abortableDelay interrupts →
    //   failed(cancelled).
    const result = await actPromise;
    expect(result.outcome).toBe('failed');
    if (result.result.status === 'failed') {
      expect(result.result.error.kind).toBe('cancelled');
      expect(result.result.error.code).toBe('ABORTED');
    }
    // 帧级证据：client 确实发过 cancel 帧。
    // — English: frame-level evidence — the client really sent a cancel frame.
    expect(transport.sentFrames.some((f) => f.type === 'cancel')).toBe(true);
    await orchestrator.close('done');
  }, 15000);
});
