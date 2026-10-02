// ============================================================================
// Sidecar JSONL 客户端：桌面 Host 侧与 Sidecar 进程通信的会话句柄
// — English: Sidecar JSONL client — the desktop-Host-side BrowserSessionHandle
//   that talks to the Sidecar process.
//
// 与 sidecar.ts 同一协议（packages/browser-runtime/src/ipc 为单一事实源）；
// 传输层（stdin/stdout、内存管道、子进程 IPC）抽象在 SidecarTransport 之后。
// 架构依据：《生产级 Agent 浏览器运行时架构设计详解》14.1 —— 只对大制品
// （截图/DOM 快照/下载）传引用；Observation 元素列表与 ActionResult 三态是
// 必需数据，跨 IPC 原样传输。
// — English: same protocol as sidecar.ts (single source of truth in ipc/);
//   the transport (stdin/stdout, in-memory pipe, child IPC) is abstracted
//   behind SidecarTransport. Per architecture doc §14.1 only large artifacts
//   travel by reference; the Observation element list and the three-state
//   ActionResult cross the IPC verbatim.
//
// 行为契约：
//  1. createSidecarClient 立即发送 session.start（seq=1）等待响应：ok → handle；
//     error → ClassifiedError{kind:'page', code, message, retryable}；超时 →
//     ClassifiedError{kind:'transient', code:'SIDECAR_TIMEOUT', retryable:true}。
//  2. observe/navigate 返回完整 Observation（observationSchema 校验，解析失败
//     抛 BAD_RESPONSE）；act 返回完整 ActionResult 三态（error 响应 → failed）；
//     close 发 session.close 后关闭 transport；currentPageGraph 基于最近一次
//     Observation 缓存。
//  3. pending 命令按 frameId 匹配响应，且响应帧 action 必须与请求一致；
//     event 帧（browser.action_status）只触发 onActionStatus，不匹配 pending。
//  4. 取消：abort 时若存在 pending act → 发送 cancel 帧（payload
//     { actionId }），等待其 failed(cancelled) 响应正常返回；否则直接 reject
//     ClassifiedError{kind:'cancelled', code:'ABORTED', retryable:false}。
//  5. seq 从 1 递增；所有发送帧带 version: IPC_VERSION 与 timestamp（由
//     ipcCodec.makeFrame 统一填充）。
//  6. 幂等：收到的响应帧 frameId 已在 seenFrameIds → 丢弃；响应匹配后记录。
//  7. 超时：pending 命令超时（timeoutMs，默认 30000）→ reject transient
//     SIDECAR_TIMEOUT 并移除 pending。
// — English: behavior contract — numbered above (start, payloads, frame
//   matching, cancellation, seq, idempotency, timeout).
// ============================================================================
import { observationSchema, pageGraphSchema } from '@suanlizi/protocol';
import type { ActionIntent, ClassifiedError, Observation, PageGraph } from '@suanlizi/protocol';
import type { ActionEvidence, ActionResult, BrowserSessionHandle } from '../port.js';
import { ipcCodec } from '../ipc/codec.js';
import type { ProtocolFrame } from '../ipc/ipcTypes.js';

// 传输抽象：Host 侧注入 stdin/stdout、内存管道或子进程 IPC。
// — English: transport abstraction — injected with stdin/stdout, an in-memory
//   pipe or child-process IPC.
export interface SidecarTransport {
  sendLine(line: string): void;
  onLine(handler: (line: string) => void): void;
  close(): void;
}

export interface SidecarClientOptions {
  taskId: string;
  transport: SidecarTransport;
  signal?: AbortSignal;
  // 单命令超时（毫秒），默认 30000。
  // — English: per-command timeout in ms, default 30000.
  timeoutMs?: number;
  // browser.action_status 事件回调（payload 为事件帧载荷）。
  // — English: browser.action_status event callback (payload is the event frame payload).
  onActionStatus?: (payload: unknown) => void;
}

export interface SidecarBrowserSessionHandle extends BrowserSessionHandle {
  listPages(input?: { signal?: AbortSignal }): Promise<PageGraph>;
}

const DEFAULT_TIMEOUT_MS = 30000;
// 统一 traceId（跨进程追踪关联）。
// — English: constant traceId for cross-process trace correlation.
const TRACE_ID = 'trace-sidecar-client';
// start 响应前未知 sessionId 的占位（frameId 前缀）。
// — English: placeholder sessionId before the start response (frameId prefix).
const SESSION_PLACEHOLDER = 'sidecar';

// 错误响应载荷形状（与 sidecar.ts 的 ErrorPayload 对应）。
// — English: error response payload shape (matches ErrorPayload in sidecar.ts).
function isErrorPayload(payload: unknown): boolean {
  if (typeof payload !== 'object' || payload === null) return false;
  const p = payload as Record<string, unknown>;
  return typeof p.code === 'string' && typeof p.message === 'string' && typeof p.retryable === 'boolean';
}

// 错误载荷 → ClassifiedError。
// — English: error payload → ClassifiedError.
function classifiedError(payload: unknown, kind: ClassifiedError['kind'] = 'page'): ClassifiedError {
  const p = (typeof payload === 'object' && payload !== null ? payload : {}) as Record<string, unknown>;
  return {
    kind,
    code: typeof p.code === 'string' ? p.code : 'UNKNOWN',
    message: typeof p.message === 'string' ? p.message : 'unknown error',
    retryable: typeof p.retryable === 'boolean' ? p.retryable : false,
    ...(typeof p.actionId === 'string' ? { actionId: p.actionId } : {}),
  };
}

// 对端响应载荷校验失败（observationSchema 失败 / ActionResult 形状非法）。
// — English: response payload validation failure (observationSchema / ActionResult shape).
function badResponseError(message: string): ClassifiedError {
  return { kind: 'page', code: 'BAD_RESPONSE', message, retryable: false };
}

function abortedError(): ClassifiedError {
  return { kind: 'cancelled', code: 'ABORTED', message: 'operation aborted', retryable: false };
}

// 响应帧的完整 ActionResult 解析：error 响应 → failed ActionResult；三态 →
// 原样归一；其他形状 → 抛 BAD_RESPONSE。
// — English: parses a response frame into a full ActionResult — error response
//   → failed ActionResult; the three states are normalized; anything else
//   throws BAD_RESPONSE.
function parseActionResult(payload: unknown): ActionResult {
  if (typeof payload !== 'object' || payload === null) {
    throw badResponseError('invalid action result payload');
  }
  const p = payload as Record<string, unknown>;
  if (isErrorPayload(payload)) {
    return { status: 'failed', error: classifiedError(payload, 'page') };
  }
  if (p.status === 'committed') {
    if (typeof p.evidence !== 'object' || p.evidence === null) {
      throw badResponseError('committed action result missing evidence');
    }
    return {
      status: 'committed',
      evidence: p.evidence as ActionEvidence,
      ...(p.observation !== undefined ? { observation: p.observation as Observation } : {}),
    };
  }
  if (p.status === 'uncertain') {
    if (typeof p.reason !== 'string' || typeof p.evidence !== 'object' || p.evidence === null) {
      throw badResponseError('uncertain action result missing reason/evidence');
    }
    return { status: 'uncertain', reason: p.reason, evidence: p.evidence as ActionEvidence };
  }
  if (p.status === 'failed') {
    if (typeof p.error !== 'object' || p.error === null) {
      throw badResponseError('failed action result missing error');
    }
    return { status: 'failed', error: p.error as ClassifiedError };
  }
  throw badResponseError('invalid action result status');
}

// 进行中的命令：frameId → 挂起条目（resolve/reject + 超时 + 清理）。
// — English: in-flight commands — frameId → pending entry (resolve/reject + timeout + cleanup).
interface PendingCommand {
  frameId: string;
  action: string;
  errorAsResult: boolean;
  timer: ReturnType<typeof setTimeout>;
  cleanup: () => void;
  resolve: (payload: unknown) => void;
  reject: (error: ClassifiedError) => void;
}

export function createSidecarClient(options: SidecarClientOptions): Promise<SidecarBrowserSessionHandle> {
  const { taskId, transport, signal, onActionStatus } = options;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  // signal 已中止：不发帧，直接失败。
  // — English: an already-aborted signal fails immediately, no frame sent.
  if (signal?.aborted === true) {
    transport.close();
    return Promise.reject(abortedError());
  }

  // ── 内部状态 ─────────────────────────────────────────────────────────────
  let seq = 0; // 发送帧序号，从 1 递增（首个帧 seq=1）
  let sessionId: string | null = null;
  let closed = false;
  let latestObservation: Observation | null = null;
  const seenFrameIds = new Set<string>();
  const pending = new Map<string, PendingCommand>();

  function nextFrameId(): string {
    seq += 1;
    // client 独立命名空间：sidecar 事件帧用 fr-${sessionId}-${seq}，若沿用会与
    // 本端请求帧撞号，导致响应被幂等集合误丢。规范允许自生成唯一 id。
    // — English: a client-private namespace — sidecar event frames use
    //   fr-${sessionId}-${seq}; reusing it would collide with our request ids
    //   and get the responses dropped by the idempotency set. The spec allows
    //   caller-generated unique ids.
    return `cfr-${sessionId ?? SESSION_PLACEHOLDER}-${seq}`;
  }

  // 所有发送帧统一走 makeFrame：version=IPC_VERSION、timestamp=Date.now() 由
  // codec 填充；frameId 由调用方生成（cfr-${sessionId}-${seq}，client 命名空间）。
  // — English: every outgoing frame goes through makeFrame — version and
  //   timestamp are filled by the codec; frameId is caller-generated in the
  //   client namespace (cfr-${sessionId}-${seq}).
  function sendFrame(type: ProtocolFrame['type'], action: string, payload: unknown, frameId: string): void {
    const frame = ipcCodec.makeFrame({
      sessionId: sessionId ?? SESSION_PLACEHOLDER,
      seq,
      type,
      action,
      payload,
      traceId: TRACE_ID,
      frameId,
    });
    transport.sendLine(ipcCodec.encode(frame));
  }

  // cancel 帧：frameId 自生成，payload { actionId }；不注册 pending（无响应）。
  // — English: cancel frame — caller-generated frameId, payload { actionId };
  //   no pending entry (no response expected).
  function sendCancelFrame(actionId: string): void {
    sendFrame('cancel', 'cancel', { actionId }, nextFrameId());
  }

  // 发送命令并挂起等待：先注册 pending 再发送，避免同步 transport 的竞态。
  // — English: sends a command and waits — pending is registered before the
  //   frame is sent to avoid races with synchronous transports.
  function sendCommand(
    action: string,
    payload: unknown,
    opts: { signal?: AbortSignal; actionId?: string; errorAsResult?: boolean } = {},
  ): Promise<unknown> {
    return new Promise<unknown>((resolve, reject) => {
      const frameId = nextFrameId();
      let settled = false;
      let cancelSent = false;
      const abortListeners: Array<() => void> = [];

      function settle(fn: () => void): void {
        if (settled) return;
        settled = true;
        pending.delete(frameId);
        clearTimeout(timer);
        for (const off of abortListeners) off();
        fn();
      }

      function onAbort(): void {
        if (settled) return;
        // 有 pending act：发 cancel 帧，等待其 failed(cancelled) 响应正常返回。
        // — English: a pending act — send a cancel frame and wait for its
        //   failed(cancelled) response to return normally.
        if (action === 'browser.act' && opts.actionId !== undefined && !cancelSent) {
          cancelSent = true;
          sendCancelFrame(opts.actionId);
          return;
        }
        settle(() => reject(abortedError()));
      }

      const timer = setTimeout(() => {
        settle(() =>
          reject(
            classifiedError(
              { code: 'SIDECAR_TIMEOUT', message: `command ${action} timed out after ${timeoutMs}ms`, retryable: true },
              'transient',
            ),
          ),
        );
      }, timeoutMs);

      // 组合全局 signal 与方法级 signal。
      // — English: combine the client-wide signal and the per-call signal.
      for (const s of [signal, opts.signal]) {
        if (s === undefined) continue;
        if (s.aborted) {
          onAbort();
          continue;
        }
        s.addEventListener('abort', onAbort, { once: true });
        abortListeners.push(() => s.removeEventListener('abort', onAbort));
      }

      const entry: PendingCommand = {
        frameId,
        action,
        errorAsResult: opts.errorAsResult ?? false,
        timer,
        cleanup: () => {
          for (const off of abortListeners) off();
        },
        resolve: (p) => settle(() => resolve(p)),
        reject: (e) => settle(() => reject(e)),
      };
      pending.set(frameId, entry);
      sendFrame('command', action, payload, frameId);
    });
  }

  // 收帧：幂等 → 事件分流 → 按 frameId 匹配 pending（action 必须一致）。
  // — English: incoming frames — dedup, then events vs. pending matching
  //   (the response action must equal the request action).
  transport.onLine((line) => {
    const frame = ipcCodec.decodeLine(line);
    if (frame === null) return; // 无法解析：忽略
    if (seenFrameIds.has(frame.frameId)) return; // 幂等：重复 frameId 丢弃
    seenFrameIds.add(frame.frameId);

    if (frame.type === 'event') {
      if (frame.action === 'browser.action_status') onActionStatus?.(frame.payload);
      return;
    }
    if (frame.type !== 'response') return;
    const entry = pending.get(frame.frameId);
    if (entry === undefined) return;
    if (frame.action !== entry.action) return; // 响应 action 必须与请求一致
    if (isErrorPayload(frame.payload) && !entry.errorAsResult) {
      entry.reject(classifiedError(frame.payload, 'page'));
      return;
    }
    entry.resolve(frame.payload);
  });

  function assertOpen(): void {
    if (closed) {
      throw { kind: 'page', code: 'SESSION_CLOSED', message: 'session closed', retryable: false } satisfies ClassifiedError;
    }
  }

  const handle: SidecarBrowserSessionHandle = {
    get sessionId(): string {
      return sessionId ?? SESSION_PLACEHOLDER;
    },
    get taskId(): string {
      return taskId;
    },

    async close(reason?: string): Promise<void> {
      if (closed) return;
      closed = true;
      try {
        // 确定性：等待 session.close 的 ok 响应。
        // — English: deterministic — await the session.close ok response.
        await sendCommand('session.close', { reason }, {});
      } catch {
        // close 尽力而为：错误/超时同样关闭 transport。
        // — English: close is best-effort — errors/timeouts still close the transport.
      }
      transport.close();
    },

    currentPageGraph(): PageGraph {
      // client 缓存最近一次 Observation，未观测时回退默认值（协议要求 page-1）。
      // — English: backed by the cached latest Observation, with fallbacks
      //   before any observation (the protocol pins the active page to page-1).
      return {
        activePageId: 'page-1',
        pages: [
          {
            pageId: 'page-1',
            url: latestObservation?.url ?? 'about:blank',
            title: latestObservation?.title ?? '',
            state: 'active',
            navigationEpoch: latestObservation?.navigationEpoch ?? 0,
          },
        ],
      };
    },

    async listPages(input?: { signal?: AbortSignal }): Promise<PageGraph> {
      assertOpen();
      const payload = await sendCommand('browser.page_graph', {}, { signal: input?.signal });
      const parsed = pageGraphSchema.safeParse(payload);
      if (!parsed.success) {
        throw badResponseError(`invalid page graph response: ${parsed.error.message}`);
      }
      return parsed.data;
    },

    async observe(input?: { signal?: AbortSignal; pageId?: string }): Promise<Observation> {
      assertOpen();
      const payload = await sendCommand(
        'browser.observe',
        input?.pageId !== undefined ? { pageId: input.pageId } : {},
        { signal: input?.signal },
      );
      const parsed = observationSchema.safeParse(payload);
      if (!parsed.success) {
        throw badResponseError(`invalid observation response: ${parsed.error.message}`);
      }
      latestObservation = parsed.data;
      return parsed.data;
    },

    async navigate(input: { url: string; signal?: AbortSignal; pageId?: string }): Promise<Observation> {
      assertOpen();
      const payload = await sendCommand(
        'browser.navigate',
        input.pageId === undefined ? { url: input.url } : { url: input.url, pageId: input.pageId },
        { signal: input.signal },
      );
      const parsed = observationSchema.safeParse(payload);
      if (!parsed.success) {
        throw badResponseError(`invalid observation response: ${parsed.error.message}`);
      }
      latestObservation = parsed.data;
      return parsed.data;
    },

    async act(input: { intent: ActionIntent; signal?: AbortSignal }): Promise<ActionResult> {
      assertOpen();
      const payload = await sendCommand(
        'browser.act',
        { intent: input.intent },
        { signal: input.signal, actionId: input.intent.actionId, errorAsResult: true },
      );
      return parseActionResult(payload);
    },
  };

  // 立即发送 session.start（seq=1）：ok → handle；error → kind:'page'；
  // 超时/abort 由 sendCommand 处理。
  // — English: session.start goes out immediately (seq=1) — ok → handle;
  //   error → kind 'page'; timeout/abort handled inside sendCommand.
  async function start(): Promise<SidecarBrowserSessionHandle> {
    const payload = await sendCommand('session.start', { taskId }, {});
    const p = payload as { sessionId?: unknown };
    sessionId = typeof p.sessionId === 'string' ? p.sessionId : SESSION_PLACEHOLDER;
    return handle;
  }

  return start();
}
