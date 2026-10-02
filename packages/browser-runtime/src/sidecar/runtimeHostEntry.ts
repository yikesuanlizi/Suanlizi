// Agent Runtime 进程入口：桌面链路（架构文档 5.1）中承载 Agent Runtime 的 Node 进程。
// 它是 Rust Host 与 Node Sidecar 之间的策略执行点——所有浏览器动作必须经过
// BrowserTaskOrchestrator（策略/预算/账本/事件/checkpoint），UI 不能直接把未经
// 策略处理的动作送进浏览器。
//
// 进程拓扑：
//   React Desktop UI → Tauri invoke → Rust Host →（JSONL IPC）→ 本进程（orchestrator
//   + policy + machine + trace）→（spawnSidecarProcess）→ Node Sidecar → Playwright
//
// 协议：stdin/stdout JSONL（同 ipc 层），action 集合：
//   session.start { taskId, goal?, budget?, site?, runtime?, policyRules? }
//   browser.navigate { url }
//   browser.observe {}
//   browser.act { intent }                     ← 唯一动作入口，强制过 orchestrator
//   browser.cancel {}
//   approval.resolve { requestId, approved }
//   session.close
// 事件帧：approval.requested（需人工确认时）、action.status（动作进度）。
// — English: Agent Runtime process entry — the Node process hosting the Agent
//   Runtime in the desktop link (§5.1). It is the policy enforcement point
//   between the Rust host and the Node sidecar: every browser action must pass
//   through BrowserTaskOrchestrator (policy/budget/ledger/events/checkpoint).
import { createInterface, type Interface } from 'node:readline';
import type { AccessRule, ActionIntent, BrowserTaskEvent, BrowserTaskState, ClassifiedError, TaskBudget } from '@suanlizi/protocol';
import { normalizeAccessPolicyConfig } from '@suanlizi/protocol';
import { ipcCodec } from '../ipc/codec.js';
import { IPC_VERSION } from '../ipc/ipcTypes.js';
import type { ProtocolFrame } from '../ipc/ipcTypes.js';
import { BrowserTaskMachine } from '../taskMachine.js';
import { BrowserPolicyEngine } from '../policy.js';
import { BrowserTaskOrchestrator } from '../orchestrator.js';
import { BrowserTraceRecorder } from '../trace.js';
import { spawnSidecarProcess } from './sidecarProcessHost.js';

interface HostCliArgs {
  taskId: string;
  site: string;
  runtime: 'fake' | 'playwright';
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'object' && error !== null) {
    const value = error as Record<string, unknown>;
    const message = typeof value.message === 'string' ? value.message : undefined;
    const code = typeof value.code === 'string' ? value.code : undefined;
    if (message && code) return `${code}: ${message}`;
    if (message) return message;
    if (code) return code;
    try {
      return JSON.stringify(value);
    } catch {
      return 'unknown runtime error';
    }
  }
  return String(error);
}

function safeLogOrigin(value: string): string {
  try {
    return new URL(value).origin;
  } catch {
    return 'invalid-url';
  }
}

function parseArgs(argv: readonly string[]): HostCliArgs {
  const out: HostCliArgs = { taskId: 'host-task', site: 'default', runtime: 'fake' };
  for (const arg of argv) {
    const eq = arg.indexOf('=');
    const key = eq === -1 ? arg.replace(/^--/, '') : arg.slice(2, eq);
    const value = eq === -1 ? 'true' : arg.slice(eq + 1);
    switch (key) {
      case 'task-id': out.taskId = value; break;
      case 'site': out.site = value; break;
      case 'runtime': out.runtime = value === 'playwright' ? 'playwright' : 'fake'; break;
      default: break;
    }
  }
  return out;
}

// 内置 evaluateAccess 子集（持久规则 deny/allow → 其余 prompt 人工确认）。
// 完整 evaluateAccessRequest（含 blocklist/workspace 默认）由桌面端配置注入——Phase 1
// 简化：Rust Host 侧持久规则经 session.start 的 policyRules 传入。
// — English: built-in evaluateAccess subset (persistent deny/allow rules; everything
//   else prompts for confirmation). The full evaluateAccessRequest is injected by
//   desktop config — Phase 1 simplification: persistent rules arrive via
//   session.start.policyRules from the Rust host.
function defaultEvaluateAccess(rules: AccessRule[]) {
  return (request: { access: string; target: { kind: string; toolName?: string } }): {
    decision: 'deny' | 'allow' | 'prompt';
    request: unknown;
    source: 'persistent_rule' | 'approval_required';
    justification: string;
  } => {
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
    process.stderr.write(`[runtime-host] evaluateAccess prompt: access=${request.access} targetKind=${request.target.kind} toolName=${String(request.target.toolName)} rules=${rules.length}\n`);
    return { decision: 'prompt', request, source: 'approval_required', justification: '需要用户临时授权' };
  };
}

interface HostRuntime {
  handleLine(line: string): Promise<string[]>;
  // 事件 flush：进程入口在每行处理后调用（审批事件独立写出）。
  // — English: event flush for the process entry (called after every line).
  flushEvents(): string[];
  close(reason?: string): Promise<void>;
}

export function createRuntimeHostEntry(deps: {
  log?: (line: string) => void;
  // 事件即时写出通道（审批挂起时 handleLine 不会返回，事件必须旁路写出）。
  // — English: the immediate event channel — while an approval is pending
  //   handleLine never returns, so events must bypass it.
  emitEvent?: (encodedFrame: string) => void;
} = {}): HostRuntime {
  const log = deps.log ?? ((): void => {});
  const emitEvent = deps.emitEvent ?? ((): void => {});
  let machine: BrowserTaskMachine | null = null;
  let policyEngine: BrowserPolicyEngine | null = null;
  let orchestrator: BrowserTaskOrchestrator | null = null;
  let spawned: Awaited<ReturnType<typeof spawnSidecarProcess>> | null = null;
  let trace: BrowserTraceRecorder | null = null;
  const seenFrameIds = new Set<string>();
  let seq = 0;

  const nextSeq = (): number => {
    seq += 1;
    return seq;
  };

  function okFrame(req: ProtocolFrame, result: unknown): string {
    return ipcCodec.encode({
      version: IPC_VERSION,
      frameId: req.frameId,
      sessionId: req.sessionId,
      seq: nextSeq(),
      timestamp: Date.now(),
      traceId: req.traceId,
      type: 'response',
      action: req.action,
      payload: { result },
    });
  }

  function errorFrame(req: ProtocolFrame, code: string, message: string, retryable: boolean): string {
    return ipcCodec.encode({
      version: IPC_VERSION,
      frameId: req.frameId,
      sessionId: req.sessionId,
      seq: nextSeq(),
      timestamp: Date.now(),
      traceId: req.traceId,
      type: 'response',
      action: req.action,
      payload: { code, message, retryable },
    });
  }

  function eventFrame(req: ProtocolFrame, action: string, payload: unknown): string {
    return ipcCodec.encode({
      version: IPC_VERSION,
      frameId: `hfr-${nextSeq()}`,
      sessionId: req.sessionId,
      seq: nextSeq(),
      timestamp: Date.now(),
      traceId: req.traceId,
      type: 'event',
      action,
      payload,
    });
  }

  function emitHostEvent(req: ProtocolFrame, action: string, payload: unknown): void {
    const encoded = eventFrame(req, action, payload);
    if (deps.emitEvent !== undefined) {
      emitEvent(`${encoded}\n`);
      return;
    }
    approvalQueue.push({ action, payload });
  }

  // state 快照随响应返回（UI 进度/预算展示的数据源）。
  // — English: the state snapshot rides along every response.
  function statePayload(): BrowserTaskState | null {
    return machine?.state ?? null;
  }

  // 审批事件队列：orchestrator 回调入队，经 flushEvents 独立写出（审批挂起时响应帧
  // 不会返回，事件必须独立 flush，否则 UI 永远收不到 approval.requested）。
  // — English: the approval event queue — flushed independently via flushEvents
  //   (while an approval is pending the response frame is stuck, so events must
  //   flush on their own or the UI never sees approval.requested).
  const approvalQueue: Array<{ action: string; payload: unknown }> = [];

  // 挂起的审批等待器：approval.resolve 命令按 requestId 匹配并放行/拒绝。
  // — English: pending approval waiters — the approval.resolve command matches by
  //   requestId and grants or denies.
  const approvalWaiters = new Map<string, (approved: boolean) => void>();

  // 无 UI 的进程内审批实现：发 approval.requested 事件帧，挂起直到 approval.resolve。
  // — English: in-process approval without a UI — emits approval.requested and
  //   suspends until approval.resolve arrives.
  function resolveApprovalForHost(request: import('@suanlizi/protocol').ApprovalRequest): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      approvalWaiters.set(request.requestId, resolve);
      emitHostEvent(
        {
          version: IPC_VERSION,
          frameId: 'ap-immediate',
          sessionId: 'host',
          seq: 0,
          timestamp: Date.now(),
          traceId: 'trace-host',
          type: 'command',
          action: 'flush',
          payload: {},
        },
        'approval.requested',
        request,
      );
    });
  }

  // 事件 flush（进程入口在每行处理后调用；req 仅用于 traceId/sessionId 透传）。
  // — English: event flush for the process entry (called after every line).
  function flushEvents(req: ProtocolFrame): string[] {
    const out: string[] = [];
    for (const entry of approvalQueue.splice(0, approvalQueue.length)) {
      out.push(
        eventFrame(req, entry.action, entry.payload),
      );
    }
    return out;
  }

  function takePendingEventFrames(): string[] {
    return flushEvents({
      version: IPC_VERSION,
      frameId: 'flush',
      sessionId: 'host',
      seq: 0,
      timestamp: Date.now(),
      traceId: 'trace-host',
      type: 'command',
      action: 'flush',
      payload: {},
    });
  }

  function assertStarted(req: ProtocolFrame): string[] | null {
    if (orchestrator === null) {
      return [errorFrame(req, 'NOT_STARTED', 'no active task', false)];
    }
    return null;
  }

  async function handleStart(req: ProtocolFrame): Promise<string[]> {
    if (orchestrator !== null) {
      return [errorFrame(req, 'BUSY', 'a task is already running', false)];
    }
    const payload = (req.payload ?? {}) as Record<string, unknown>;
    const taskId = typeof payload.taskId === 'string' ? payload.taskId : 'host-task';
    const goal = typeof payload.goal === 'string' ? payload.goal : '浏览器任务';
    const site = typeof payload.site === 'string' ? payload.site : depsSite;
    const runtimeMode = payload.runtime === 'playwright' ? 'playwright' : 'fake';
    const rules = Array.isArray(payload.policyRules) ? (payload.policyRules as AccessRule[]) : [];
    log(`runtime host: start frame=${req.frameId} task=${taskId} mode=${runtimeMode}`);

    const budget: TaskBudget = {
      maxSteps: 100,
      maxTokens: 200_000,
      maxReplans: 5,
      maxConsecutiveFailures: 3,
      maxDurationMs: 10 * 60_000,
      maxExternalWrites: 5,
      maxDownloadBytes: 100 * 1024 * 1024,
    };

    try {
      // 1) 拉起 Node Sidecar 子进程（真实 JSONL 管道）。
      // — English: 1) spawn the Node sidecar child (real JSONL pipe).
      spawned = await spawnSidecarProcess({
        taskId,
        runtime: runtimeMode,
        site,
        log,
        onActionStatus: (payload) => {
          emitHostEvent(req, 'browser.action_status', payload);
        },
      });
      log(`runtime host: sidecar ready pid=${String(spawned.child.pid)}`);

      // 2) 装配 orchestrator：策略/预算/账本/事件/Trace 全闭环。
      // — English: 2) assemble the orchestrator — policy/budget/ledger/events/trace.
      machine = new BrowserTaskMachine({
        taskId,
        goal,
        budget,
        signal: undefined,
      });
      machine.start();

      trace = new BrowserTraceRecorder({
        runId: `run-${taskId}`,
        threadId: taskId,
        turnId: 'runtime-host',
        runKind: 'workflow',
        emit: () => {
          // Phase 1：Trace 落盘由上层（Rust/存储）接入；此处只保证 span 生成通路存在。
          // — English: Phase 1 — trace persistence is wired by the upper layer; the
          //   span-generation path is exercised here.
        },
      });

      policyEngine = new BrowserPolicyEngine({
        policy: normalizeAccessPolicyConfig({}),
        evaluateAccess: defaultEvaluateAccess(rules) as never,
        threadId: taskId,
        turnId: 'runtime-host',
      });

      orchestrator = new BrowserTaskOrchestrator({
        runtime: {
          kind: 'fake',
          start: async () => spawned!.handle,
          ...spawned.handle,
        },
        policyEngine,
        machine,
        trace,
        onApprovalRequest: () => {
          // 审批事件的写出完全由 resolveApprovalForHost 负责（emitEvent 旁路或
          // 无 emitEvent 时的队列兜底）——这里不再入队，否则与旁路双写。
          // — English: approval event emission is entirely owned by
          //   resolveApprovalForHost (emitEvent bypass, or queue fallback without
          //   emitEvent) — nothing is queued here to avoid double writes.
        },
        resolveApproval: resolveApprovalForHost,
      });

      await orchestrator.start();
      log(`runtime host: started frame=${req.frameId} task=${taskId}`);
      return [okFrame(req, { state: statePayload() })];
    } catch (err) {
      log(`runtime host: start failed: ${errorMessage(err)}`);
      await cleanup();
      return [errorFrame(req, 'START_FAILED', errorMessage(err), false)];
    }
  }

  async function cleanup(): Promise<void> {
    try {
      await orchestrator?.close('host close');
    } catch {
      // 尽力而为
    }
    try {
      await spawned?.stop(5000);
    } catch {
      // 尽力而为
    }
    orchestrator = null;
    machine = null;
    policyEngine = null;
    trace = null;
    spawned = null;
  }

  async function handleNavigate(req: ProtocolFrame): Promise<string[]> {
    const blocked = assertStarted(req);
    if (blocked !== null) return blocked;
    const payload = (req.payload ?? {}) as Record<string, unknown>;
    const url = typeof payload.url === 'string' ? payload.url : '';
    const userInitiated = payload.userInitiated === true;
    if (url === '') return [errorFrame(req, 'BAD_ARG', 'url is required', false)];
    try {
      log(`runtime host: navigate frame=${req.frameId} source=${userInitiated ? 'user' : 'agent'} url=${safeLogOrigin(url)}`);
      const observation = userInitiated
        ? await orchestrator!.navigateFromUser({ url })
        : await orchestrator!.navigate({ url });
      log(`runtime host: navigate complete frame=${req.frameId} screenshotChars=${observation.screenshotRef?.length ?? 0}`);
      return [okFrame(req, { observation, state: statePayload() })];
    } catch (err) {
      log(`runtime host: navigate failed frame=${req.frameId} error=${errorMessage(err)}`);
      return [errorFrame(req, classifyCode(err), errorMessage(err), false)];
    }
  }

  async function handleObserve(req: ProtocolFrame): Promise<string[]> {
    const blocked = assertStarted(req);
    if (blocked !== null) return blocked;
    try {
      log(`runtime host: observe frame=${req.frameId}`);
      const observation = await orchestrator!.observe({});
      log(`runtime host: observe complete frame=${req.frameId} screenshotChars=${observation.screenshotRef?.length ?? 0}`);
      return [okFrame(req, { observation, state: statePayload() })];
    } catch (err) {
      log(`runtime host: observe failed frame=${req.frameId} error=${errorMessage(err)}`);
      return [errorFrame(req, classifyCode(err), errorMessage(err), false)];
    }
  }

  // 唯一动作入口：必须经过 orchestrator（策略 → 账本 → 执行 → 验证 → 落账）。
  // — English: the only action entry — everything goes through the orchestrator.
  async function handleAct(req: ProtocolFrame): Promise<string[]> {
    const blocked = assertStarted(req);
    if (blocked !== null) return blocked;
    const payload = (req.payload ?? {}) as Record<string, unknown>;
    const intent = payload.intent as ActionIntent | undefined;
    if (intent === undefined || typeof intent !== 'object') {
      return [errorFrame(req, 'BAD_INTENT', 'intent is required', false)];
    }
    try {
      const result = await orchestrator!.runAction({ intent });
      return [okFrame(req, { result, state: statePayload() })];
    } catch (err) {
      return [errorFrame(req, classifyCode(err), errorMessage(err), false)];
    }
  }

  async function handleCancel(req: ProtocolFrame): Promise<string[]> {
    const blocked = assertStarted(req);
    if (blocked !== null) return blocked;
    try {
      await orchestrator!.cancel('user cancelled');
      return [okFrame(req, { state: statePayload() })];
    } catch (err) {
      return [errorFrame(req, classifyCode(err), errorMessage(err), false)];
    }
  }

  async function handleApprovalResolve(req: ProtocolFrame): Promise<string[]> {
    const blocked = assertStarted(req);
    if (blocked !== null) return blocked;
    const payload = (req.payload ?? {}) as Record<string, unknown>;
    const requestId = typeof payload.requestId === 'string' ? payload.requestId : '';
    if (requestId === '') return [errorFrame(req, 'BAD_ARG', 'requestId is required', false)];
    try {
      const waiter = approvalWaiters.get(requestId);
      if (waiter === undefined) {
        return [errorFrame(req, 'UNKNOWN_REQUEST', `no pending approval: ${requestId}`, false)];
      }
      approvalWaiters.delete(requestId);
      waiter(payload.approved !== false);
      return [okFrame(req, { state: statePayload() })];
    } catch (err) {
      return [errorFrame(req, classifyCode(err), errorMessage(err), false)];
    }
  }

  async function handleClose(req: ProtocolFrame): Promise<string[]> {
    await cleanup();
    return [okFrame(req, {})];
  }

  function classifyCode(err: unknown): string {
    if (typeof err === 'object' && err !== null && 'code' in err) {
      return String((err as { code: unknown }).code);
    }
    return 'INTERNAL';
  }

  let pending: Promise<void> = Promise.resolve();

  return {
    // 事件 flush：进程入口在每行处理后调用（审批事件独立写出，不随响应帧）。
    // — English: event flush for the process entry (called after every line).
    flushEvents(): string[] {
      return takePendingEventFrames();
    },

    async handleLine(line: string): Promise<string[]> {
      let frame: ProtocolFrame | null = null;
      try {
        frame = ipcCodec.decodeLine(line) as ProtocolFrame;
      } catch {
        return [errorFrame(placeholderFrame(), 'BAD_FRAME', 'invalid frame', false)];
      }
      if (frame === null) return [];
      if (seenFrameIds.has(frame.frameId)) return [];
      seenFrameIds.add(frame.frameId);
      log(`runtime host: received action=${frame.action} frame=${frame.frameId}`);

      if (frame.type === 'cancel') {
        // cancel 帧即时插队（同 sidecar loop 语义）。
        // — English: cancel frames bypass the queue (same semantics as the sidecar loop).
        if (orchestrator !== null) {
          await orchestrator.cancel('user cancelled');
        }
        return [];
      }
      // approval.resolve 同样绕过队列：动作挂起等审批时，审批结果必须能即时送达
      //（否则队列被挂起的 handleAct 阻塞，形成死锁）。
      // — English: approval.resolve also bypasses the queue — while an action is
      //   suspended on approval, the verdict must arrive immediately (otherwise
      //   the queue is blocked by the pending handleAct — a deadlock).
      if (frame.action === 'approval.resolve') {
        return handleApprovalResolve(frame);
      }
      if (frame.type !== 'command') {
        return [errorFrame(frame, 'BAD_FRAME', 'invalid frame type', false)];
      }

      switch (frame.action) {
        case 'session.start':
          return handleStart(frame);
        case 'browser.navigate':
          return handleNavigate(frame);
        case 'browser.observe':
          return handleObserve(frame);
        case 'browser.act':
          return handleAct(frame);
        case 'browser.cancel':
          return handleCancel(frame);
        case 'approval.resolve':
          return handleApprovalResolve(frame);
        case 'session.close':
          return handleClose(frame);
        default:
          return [errorFrame(frame, 'BAD_FRAME', `unknown action: ${frame.action}`, false)];
      }
    },

    async close(reason?: string): Promise<void> {
      log(`runtime host: closing (${reason ?? 'no reason'})`);
      await cleanup();
      pending = Promise.resolve();
    },
  };
}

function placeholderFrame(): ProtocolFrame {
  return {
    version: IPC_VERSION,
    frameId: 'unknown',
    sessionId: 'unknown',
    seq: 0,
    timestamp: Date.now(),
    traceId: 'trace-unknown',
    type: 'command',
    action: 'unknown',
    payload: {},
  };
}

// ── 进程入口 ─────────────────────────────────────────────────────────────────
// — English: process entry — stdin lines feed handleLine; stdout gets encoded frames.
const args = parseArgs(process.argv.slice(2));
const depsSite = args.site;

const host = createRuntimeHostEntry({
  log: (message: string) => process.stderr.write(`[runtime-host:${args.taskId}] ${message}\n`),
  // 审批事件即时写出（旁路通道）。
  // — English: the immediate approval-event bypass channel.
  emitEvent: (encodedFrame: string) => process.stdout.write(encodedFrame),
});

const rl: Interface = createInterface({ input: process.stdin, crlfDelay: Infinity });
let queue: Promise<void> = Promise.resolve();
rl.on('line', (line) => {
  // cancel / approval.resolve 即时插队：动作挂起（等审批/执行中）时这些帧必须
  // 立即处理，否则串行队列被挂起的 handleAct 阻塞形成死锁。
  // — English: cancel / approval.resolve bypass the queue — while an action is
  //   suspended these frames must be handled immediately, or the serial queue
  //   deadlocks behind the pending handleAct.
  let probe: ProtocolFrame | null = null;
  try {
    probe = ipcCodec.decodeLine(line) as ProtocolFrame;
  } catch {
    probe = null;
  }
  if (probe !== null && (probe.type === 'cancel' || probe.action === 'approval.resolve')) {
    void host
      .handleLine(line)
      .then((frames) => {
        for (const frame of frames) process.stdout.write(`${frame}\n`);
      })
      .catch((err) => {
        process.stderr.write(`[runtime-host] bypass line handling failed: ${String(err)}\n`);
      });
    return;
  }
  queue = queue
    .then(async () => {
      const frames = await host.handleLine(line);
      for (const frame of frames) process.stdout.write(`${frame}\n`);
      // 审批事件独立 flush（审批挂起时响应帧不会返回）。
      // — English: approval events flush independently (the response frame is
      //   stuck while an approval is pending).
      for (const event of host.flushEvents()) process.stdout.write(`${event}\n`);
    })
    .catch((err) => {
      process.stderr.write(`[runtime-host] line handling failed: ${String(err)}\n`);
    });
});
rl.on('close', () => {
  void queue
    .finally(() => host.close('stdin closed'))
    .catch(() => undefined)
    .finally(() => process.exit(0));
});
process.once('SIGTERM', () => {
  void host.close('SIGTERM').finally(() => process.exit(0));
});
process.once('SIGINT', () => {
  void host.close('SIGINT').finally(() => process.exit(0));
});

// 类型引用保持（编译期约束：事件/错误协议与 orchestrator 一致）。
// — English: keep type references for compile-time alignment with the orchestrator.
export type { BrowserTaskEvent, ClassifiedError };
