// ============================================================================
// Node.js Sidecar：Rust Host 与浏览器宿主之间的 JSONL 进程骨架
// — English: Node.js Sidecar — the JSONL process skeleton between the Rust Host
//   and the browser host (Playwright).
//
// 架构依据：《生产级 Agent 浏览器运行时架构设计详解》5.1 / 5.3 / 14.1：
// stdin 收 command（JSONL，一帧一行），stdout 只输出协议帧（JSONL），日志一律
// 走 stderr；Playwright 由注入的 BrowserRuntimePort 隔离（Phase 1 默认
// FakeBrowserRuntime，后续替换为 PlaywrightRuntime）。
// — English: per the architecture doc sections 5.1/5.3/14.1 — stdin receives
//   commands (one JSONL frame per line), stdout carries protocol frames only,
//   logs go to stderr; the browser host is isolated behind the injected
//   BrowserRuntimePort (FakeBrowserRuntime in Phase 1).
//
// 协议契约来自 packages/browser-runtime/src/ipc（单一事实源）：
//   import { ipcCodec, isDuplicateFrame } from '../ipc/codec.js';
//   import type { ProtocolFrame, IpcCommand } from '../ipc/ipcTypes.js';
// — English: protocol contract comes from packages/browser-runtime/src/ipc
//   (single source of truth).
// ============================================================================
import { createInterface, type Interface } from 'node:readline';
import { actionIntentSchema } from '@suanlizi/protocol';
import type { ActionIntent, ClassifiedError } from '@suanlizi/protocol';
import type { ActionResult, BrowserRuntimePort, BrowserSessionHandle } from '../port.js';
import { ipcCodec, isDuplicateFrame } from '../ipc/codec.js';
import type { ProtocolFrame } from '../ipc/ipcTypes.js';

// ─── 命令 / 事件载荷 ─────────────────────────────────────────────────────────
// — English: command and event payloads.
export interface StartCommandPayload {
  taskId: string;
}
export interface NavigateCommandPayload {
  url: string;
  pageId?: string;
}
export interface ObserveCommandPayload {
  pageId?: string;
}
export interface ActCommandPayload {
  intent: ActionIntent;
}
export interface CancelPayload {
  actionId?: string;
}

// 错误响应载荷。
// — English: error response payload.
export interface ErrorPayload {
  code: string;
  message: string;
  retryable: boolean;
  actionId?: string;
}

// 动作状态事件载荷（browser.action_status）——事件仍传摘要，响应才传完整载荷。
// — English: action status event payload (browser.action_status) — events keep
//   the summary; responses carry the full payload.
// 架构文档 14.1：只对大制品（截图/DOM 快照/下载）传引用；Observation 元素列表
// 是必需数据，跨 IPC 原样传输（完整 Observation 作为响应载荷）。
// — English: per architecture doc §14.1 — only large artifacts (screenshots/DOM
//   snapshots/downloads) travel by reference; the Observation element list is
//   required data and crosses the IPC verbatim.
export interface ActionStatusEventPayload {
  actionId: string;
  status: 'prepared' | 'committed' | 'uncertain' | 'failed';
  at: number;
  reason?: string;
  error?: ClassifiedError;
}

// ─── Sidecar 依赖与句柄 ─────────────────────────────────────────────────────
// — English: sidecar deps and handle.
export interface SidecarDeps {
  // 实际浏览器宿主（Phase 1 默认 Fake；后续 PlaywrightRuntime 实现同一接口）。
  // — English: the real browser host (Fake in Phase 1; PlaywrightRuntime later).
  runtime: BrowserRuntimePort;
  // 帧序号生成器（测试可注入；默认从 1 递增）。
  // — English: frame sequence generator (injectable; defaults to 1, 2, 3…).
  nextSeq?: () => number;
  // 日志只走 stderr（stdout 必须纯净为协议帧）。
  // — English: logging only for stderr (stdout must stay pure protocol frames).
  log?: (message: string) => void;
}

export interface SidecarHandle {
  // 处理一行 stdin 输入（JSONL 一帧一行）；返回本次应写入 stdout 的帧字符串数组。
  // — English: handles one stdin line (one JSONL frame); returns the frames to
  //   write to stdout.
  handleLine(line: string): Promise<string[]>;
  // 优雅关闭：close session + 结束。
  // — English: graceful shutdown — close the session and finish.
  close(reason?: string): Promise<void>;
  // 当前会话句柄（未 start 时为 null）。
  // — English: current session handle (null until start).
  session: BrowserSessionHandle | null;
}

export interface StdinStdoutLoop {
  start(): void;
  stop(): Promise<void>;
}

// 可注入的标准流：默认 process.stdin / process.stdout；测试注入内存双工流
// （node:stream PassThrough）做管道级端到端验证，避免触碰真实进程流。
// — English: injectable standard streams — default to process.stdin/stdout;
//   tests inject in-memory duplex streams (node:stream PassThrough) for
//   pipe-level end-to-end verification without touching the real process streams.
export interface StdinStdoutStreams {
  stdin?: NodeJS.ReadableStream;
  stdout?: NodeJS.WritableStream;
}

// 进程入口：stdin 按行喂给 handleLine，stdout 写入 encode 后的帧。不启动服务，
// 仅供 Phase 1 集成时由 Rust Host 拉起进程后调用。
// — English: process entry — feeds stdin lines to handleLine and writes encoded
//   frames to stdout. Starts nothing; Phase 1 integration calls it after launch.
// streams 可选：测试注入 PassThrough（stdin/stdout）；缺省用 process.stdin/stdout。
// — English: streams is optional — tests inject PassThrough pairs; defaults to
//   process.stdin/stdout.
export function createStdinStdoutLoop(deps: SidecarDeps, streams?: StdinStdoutStreams): StdinStdoutLoop {
  const handle = createSidecar(deps);
  const log = deps.log ?? ((): void => {});
  const input = streams?.stdin ?? process.stdin;
  const output = streams?.stdout ?? process.stdout;
  let rl: Interface | null = null;

  return {
    start(): void {
      if (rl !== null) return;
      rl = createInterface({ input, crlfDelay: Infinity });
      // 串行处理：命令帧必须按到达顺序逐个执行（session.start 必须先于
      // navigate/observe；并发会导致 NOT_STARTED 与 seq 乱序）。内存对聊测试
      // 逐帧等待响应掩盖了该问题，进程管道多行到达时暴露。
      // cancel 帧例外：它是元操作，必须即时插队中止当前动作（否则要等当前
      // 动作完成后才处理，取消语义失效）。
      // — English: serial processing — frames execute strictly in arrival order
      //   (session.start must precede navigate/observe; concurrency caused
      //   NOT_STARTED and interleaved seqs — hidden by the in-memory client
      //   tests that awaited each response before sending the next frame).
      //   Cancel frames are the exception: as a meta-operation they bypass the
      //   queue to abort the in-flight action immediately.
      let pending: Promise<void> = Promise.resolve();
      rl.on('line', (line) => {
        let probe: ProtocolFrame | undefined;
        try {
          probe = ipcCodec.decodeLine(line) as ProtocolFrame;
        } catch {
          probe = undefined; // 非法行交给队列处理（handleLine 报 BAD_FRAME）
        }
        if (probe?.type === 'cancel') {
          void handle.handleLine(line).catch((err) => {
            log(`sidecar: cancel handling failed: ${String(err)}`);
          });
          return;
        }
        pending = pending
          .then(async () => {
            const frames = await handle.handleLine(line);
            for (const frame of frames) output.write(`${frame}\n`);
          })
          .catch((err) => {
            log(`sidecar: line handling failed: ${String(err)}`);
          });
      });
      rl.on('close', () => {
        rl = null;
        // stdin EOF：等队列清空后优雅关闭会话。
        // — English: stdin EOF — drain the queue, then close gracefully.
        void pending
          .finally(() => handle.close('stdin closed'))
          .catch((err) => log(`sidecar: close failed: ${String(err)}`));
      });
    },

    async stop(): Promise<void> {
      await handle.close('sidecar stop');
      if (rl !== null) {
        rl.close();
        rl = null;
      }
    },
  };
}

// ─── 实现 ────────────────────────────────────────────────────────────────────
// — English: implementation.
export function createSidecar(deps: SidecarDeps): SidecarHandle {
  const log = deps.log ?? ((): void => {});
  let seqCounter = 0;
  const nextSeq = deps.nextSeq ?? ((): number => {
    seqCounter += 1;
    return seqCounter;
  });
  const seenFrameIds = new Set<string>();
  let session: BrowserSessionHandle | null = null;
  // 进行中的动作：act 期间非空；cancel 帧据此中止。
  // — English: in-flight action — non-null while act runs; cancel frames abort it.
  let currentAction: { actionId: string; controller: AbortController } | null = null;

  // 错误响应载荷构造。
  // — English: builds an error payload.
  function errorPayload(code: string, message: string, retryable: boolean, actionId?: string): ErrorPayload {
    return { code, message, retryable, ...(actionId !== undefined ? { actionId } : {}) };
  }

  // 任意异常归类为错误载荷：ClassifiedError 形状 → 原样；其他 → INTERNAL。
  // — English: classifies any thrown value — ClassifiedError-shaped values pass
  //   through, everything else becomes INTERNAL.
  function classify(err: unknown): ErrorPayload {
    if (typeof err === 'object' && err !== null) {
      const e = err as Partial<ClassifiedError>;
      if (typeof e.code === 'string' && typeof e.message === 'string' && typeof e.retryable === 'boolean') {
        return {
          code: e.code,
          message: e.message,
          retryable: e.retryable,
          ...(typeof e.actionId === 'string' ? { actionId: e.actionId } : {}),
        };
      }
    }
    return { code: 'INTERNAL', message: err instanceof Error ? err.message : String(err), retryable: false };
  }

  // 响应帧：frameId 关联请求帧（消费者按 frameId 幂等），seq 取 nextSeq，traceId 透传。
  // — English: response frame — frameId echoes the request, seq from nextSeq.
  function responseFrame(req: ProtocolFrame, payload: unknown): string {
    return ipcCodec.encode(
      ipcCodec.makeFrame({
        type: 'response',
        action: req.action,
        payload,
        frameId: req.frameId,
        sessionId: req.sessionId,
        traceId: req.traceId,
        spanId: req.spanId,
        seq: nextSeq(),
      }),
    );
  }

  // 事件帧：独立 frameId（makeFrame 生成），seq 取 nextSeq，traceId 透传自请求。
  // — English: event frame — fresh frameId, seq from nextSeq, traceId passthrough.
  function eventFrame(req: ProtocolFrame, payload: unknown): string {
    return ipcCodec.encode(
      ipcCodec.makeFrame({
        type: 'event',
        action: 'browser.action_status',
        payload,
        sessionId: session?.sessionId ?? req.sessionId,
        traceId: req.traceId,
        spanId: req.spanId,
        seq: nextSeq(),
      }),
    );
  }

  // ── 命令处理 ──────────────────────────────────────────────────────────────
  async function handleStart(req: ProtocolFrame): Promise<string[]> {
    if (session !== null) {
      return [responseFrame(req, errorPayload('ALREADY_STARTED', 'session already started', false))];
    }
    const { taskId } = req.payload as StartCommandPayload;
    if (typeof taskId !== 'string' || taskId === '') {
      return [responseFrame(req, errorPayload('BAD_FRAME', 'invalid frame', false))];
    }
    try {
      const s = await deps.runtime.start({ taskId });
      session = s;
      return [responseFrame(req, { sessionId: s.sessionId, taskId: s.taskId })];
    } catch (err) {
      return [responseFrame(req, classify(err))];
    }
  }

  async function handleNavigate(req: ProtocolFrame): Promise<string[]> {
    if (session === null) {
      return [responseFrame(req, errorPayload('NOT_STARTED', 'no active session', false))];
    }
    const { url, pageId } = req.payload as NavigateCommandPayload;
    if (typeof url !== 'string' || url === '') {
      return [responseFrame(req, errorPayload('BAD_FRAME', 'invalid frame', false))];
    }
    try {
      const obs = await session.navigate(pageId === undefined ? { url } : { url, pageId });
      // 完整 Observation 原样返回（14.1：元素列表是必需数据）。
      // — English: the full Observation is returned verbatim (14.1: the element
      //   list is required data).
      return [responseFrame(req, obs)];
    } catch (err) {
      return [responseFrame(req, classify(err))];
    }
  }

  async function handleObserve(req: ProtocolFrame): Promise<string[]> {
    if (session === null) {
      return [responseFrame(req, errorPayload('NOT_STARTED', 'no active session', false))];
    }
    const { pageId } = req.payload as ObserveCommandPayload;
    try {
      const obs = await session.observe(pageId !== undefined ? { pageId } : {});
      // 完整 Observation 原样返回（14.1：元素列表是必需数据）。
      // — English: the full Observation is returned verbatim (14.1: the element
      //   list is required data).
      return [responseFrame(req, obs)];
    } catch (err) {
      return [responseFrame(req, classify(err))];
    }
  }

  async function handlePageGraph(req: ProtocolFrame): Promise<string[]> {
    if (session === null) {
      return [responseFrame(req, errorPayload('NOT_STARTED', 'no active session', false))];
    }
    try {
      return [responseFrame(req, session.currentPageGraph())];
    } catch (err) {
      return [responseFrame(req, classify(err))];
    }
  }

  async function handleAct(req: ProtocolFrame): Promise<string[]> {
    if (session === null) {
      return [responseFrame(req, errorPayload('NOT_STARTED', 'no active session', false))];
    }
    const { intent: rawIntent } = req.payload as ActCommandPayload;
    const parsed = actionIntentSchema.safeParse(rawIntent);
    if (!parsed.success) {
      return [responseFrame(req, errorPayload('BAD_INTENT', 'invalid action intent', false))];
    }
    const intent = parsed.data as ActionIntent;
    // 防御：一个动作完成前不接受新动作（避免并发副作用）。
    // — English: guard — no new action while one is in flight.
    if (currentAction !== null) {
      return [responseFrame(req, errorPayload('BUSY', 'another action is in progress', false))];
    }

    const controller = new AbortController();
    currentAction = { actionId: intent.actionId, controller };
    const out: string[] = [];

    // 1) 执行前：prepared 事件。
    // — English: 1) before execution — prepared event.
    out.push(
      eventFrame(req, { actionId: intent.actionId, status: 'prepared', at: Date.now() } satisfies ActionStatusEventPayload),
    );

    // 2) 执行（signal 可被 cancel 帧中止）。
    // — English: 2) execution — abortable via cancel frames.
    let result: ActionResult;
    try {
      result = await session.act({ intent, signal: controller.signal });
    } catch (err) {
      const aborted = controller.signal.aborted;
      result = aborted
        ? {
            status: 'failed',
            error: {
              kind: 'cancelled',
              code: 'ABORTED',
              message: 'action cancelled',
              retryable: false,
              actionId: intent.actionId,
            },
          }
        : {
            status: 'failed',
            error: {
              kind: 'transient',
              code: 'INTERNAL',
              message: err instanceof Error ? err.message : String(err),
              retryable: false,
              actionId: intent.actionId,
            },
          };
    } finally {
      currentAction = null;
    }

    // 3) 结果事件（committed / uncertain / failed）。
    // — English: 3) outcome event.
    if (result.status === 'committed') {
      out.push(eventFrame(req, { actionId: intent.actionId, status: 'committed', at: Date.now() }));
    } else if (result.status === 'uncertain') {
      out.push(eventFrame(req, { actionId: intent.actionId, status: 'uncertain', reason: result.reason, at: Date.now() }));
    } else {
      out.push(eventFrame(req, { actionId: intent.actionId, status: 'failed', error: result.error, at: Date.now() }));
    }

    // 4) ok 响应：三态载荷。
    // — English: 4) ok response with the three-state payload.
    out.push(responseFrame(req, result));
    return out;
  }

  async function handleClose(req: ProtocolFrame): Promise<string[]> {
    const s = session;
    session = null;
    if (s === null) {
      // 幂等 close：无会话也回 ok。
      // — English: idempotent close — ok even without a session.
      return [responseFrame(req, {})];
    }
    try {
      await s.close('session.close command');
    } catch (err) {
      log(`sidecar: session.close failed: ${String(err)}`);
    }
    return [responseFrame(req, { sessionId: s.sessionId })];
  }

  // cancel 帧：中止当前动作；带 actionId 且与当前动作不匹配 → 忽略（不回帧）。
  // — English: cancel frame — aborts the in-flight action; a mismatched actionId
  //   is ignored (no frames emitted).
  function handleCancel(req: ProtocolFrame): void {
    if (currentAction === null) return;
    const { actionId } = req.payload as CancelPayload;
    if (actionId !== undefined && actionId !== currentAction.actionId) return;
    currentAction.controller.abort();
  }

  return {
    get session(): BrowserSessionHandle | null {
      return session;
    },

    async handleLine(line: string): Promise<string[]> {
      const frame = ipcCodec.decodeLine(line);
      if (frame === null) {
        // 无法解析：占位 frameId（makeFrame 生成），sessionId='unknown'，seq 用 nextSeq。
        // — English: unparseable line — placeholder frameId, sessionId 'unknown'.
        const placeholder = ipcCodec.makeFrame({
          type: 'response',
          action: 'unknown',
          payload: errorPayload('BAD_FRAME', 'invalid frame', false),
          sessionId: 'unknown',
          seq: nextSeq(),
          traceId: 'trace-unknown',
        });
        return [ipcCodec.encode(placeholder)];
      }

      // 幂等：重复 frameId 丢弃，不回帧不执行。
      // — English: idempotency — duplicate frameIds are dropped silently.
      if (isDuplicateFrame(frame, seenFrameIds)) return [];

      // cancel 帧：立即中止当前动作（不检查 deadline）。
      // — English: cancel frames abort immediately (no deadline check).
      if (frame.type === 'cancel') {
        handleCancel(frame as ProtocolFrame);
        return [];
      }
      if (frame.type !== 'command') {
        return [responseFrame(frame, errorPayload('BAD_FRAME', 'invalid frame', false))];
      }

      // deadline：已过期直接拒绝，不执行。
      // — English: expired deadline — rejected without execution.
      if (frame.deadline !== undefined && frame.deadline < Date.now()) {
        return [responseFrame(frame, errorPayload('DEADLINE', 'deadline exceeded', false))];
      }

      switch (frame.action) {
        case 'session.start':
          return handleStart(frame as ProtocolFrame);
        case 'browser.navigate':
          return handleNavigate(frame as ProtocolFrame);
        case 'browser.observe':
          return handleObserve(frame as ProtocolFrame);
        case 'browser.page_graph':
          return handlePageGraph(frame as ProtocolFrame);
        case 'browser.act':
          return handleAct(frame as ProtocolFrame);
        case 'session.close':
          return handleClose(frame as ProtocolFrame);
        default:
          return [responseFrame(frame, errorPayload('BAD_FRAME', 'invalid frame', false))];
      }
    },

    async close(reason?: string): Promise<void> {
      currentAction?.controller.abort();
      const s = session;
      session = null;
      if (s === null) return;
      try {
        await s.close(reason ?? 'sidecar close');
      } catch (err) {
        log(`sidecar: close failed: ${String(err)}`);
      }
    },
  };
}
