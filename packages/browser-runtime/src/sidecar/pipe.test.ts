// ============================================================================
// Sidecar 管道级端到端测试：真实 readline 事件循环 + PassThrough 内存流
// — English: Sidecar pipe-level end-to-end tests — the real readline event loop
//   over in-memory PassThrough streams (no real process stdin/stdout).
//
// 覆盖：start→navigate→observe→act→close 全链路逐帧断言、stdout 纯净（每行
// 都是合法 JSON 协议帧）、stdin EOF 优雅关闭（注入 runtime 的 close 计数）、
// cancel 帧跨管道中止慢动作、非法 JSON 行（BAD_FRAME 错误响应帧）与 stop 幂等。
// — English: covers the full start→navigate→observe→act→close flow with
//   per-frame assertions, stdout purity (every line is a valid JSON protocol
//   frame), graceful shutdown on stdin EOF (via an injected close counter),
//   cancel frames aborting a slow action across the pipe, malformed JSON lines
//   (BAD_FRAME error response frames) and idempotent stop.
//
// 时序模型：每步写一行 stdin → 读一行 stdout（readNextFrame 累积缓冲按行解析，
// 超时 2000ms 断言失败），保证同一时刻只有一条命令在途，避免并发交错。
// — English: timing model — write one stdin line, then read one stdout frame
//   (readNextFrame accumulates the buffer and parses per line; a 2000ms
//   timeout fails the assertion), keeping at most one command in flight.
// ============================================================================
import { describe, expect, it } from 'vitest';
import { once } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ActionIntent, PageGraph } from '@suanlizi/protocol';
import type { ActionResult, BrowserRuntimePort, BrowserSessionHandle } from '../port.js';
import type { FakeSiteDefinition } from '../fakeRuntime.js';
import { FakeBrowserRuntime } from '../fakeRuntime.js';
import { ipcCodec } from '../ipc/codec.js';
import { createStdinStdoutLoop } from './sidecar.js';
import type { StdinStdoutLoop } from './sidecar.js';

// ─── 测试站点 ───────────────────────────────────────────────────────────────
// 列表页 → 详情页（点击链接导航）；与 sidecarClient.test.ts 同构。
// — English: list page → detail page (link click navigates), same shape as
//   sidecarClient.test.ts.
const site: FakeSiteDefinition = {
  startUrl: 'https://example.com/list',
  defaultDelayMs: 2,
  pages: [
    {
      url: 'https://example.com/list',
      title: 'Example List',
      elements: [
        {
          ref: 'link-detail',
          role: 'link',
          name: '查看详情',
          text: '查看详情',
          href: 'https://example.com/detail',
        },
        { ref: 'item-1', role: 'listitem', name: '条目 1', text: '条目 1' },
      ],
    },
    {
      url: 'https://example.com/detail',
      title: 'Example Detail',
      elements: [{ ref: 'detail-title', role: 'heading', name: '详情页', text: '详情页' }],
    },
  ],
};

// 慢站点：onAction 副作用延迟 200ms，为 cancel 帧留出窗口。
// — English: slow site — a 200ms side-effect delay leaves a cancellation window.
const slowSite: FakeSiteDefinition = {
  startUrl: 'https://slow.example/',
  defaultDelayMs: 2,
  pages: [
    {
      url: 'https://slow.example/',
      title: 'Slow Page',
      elements: [{ ref: 'btn-go', role: 'button', name: 'Go', text: 'Go' }],
      onAction: () => ({ kind: 'delay', delayMs: 200 }),
    },
  ],
};

// 构造 ActionIntent 的测试辅助函数。
// — English: test helper building an ActionIntent.
function makeIntent(overrides: Partial<ActionIntent> = {}): ActionIntent {
  return {
    actionId: 'act-1',
    taskId: 'task-1',
    pageId: 'page-1',
    observationId: 'obs-1',
    expectedNavigationEpoch: 1,
    kind: 'click',
    targetRef: '[e1]',
    arguments: {},
    rationale: '测试动作',
    effect: 'local',
    risk: 'low',
    postcondition: { kind: 'url_contains', value: 'detail' },
    ...overrides,
  };
}

// ─── 帧构造：统一走 ipcCodec（与协议 schema 单一事实源一致） ───────────────
// — English: frame construction — all through ipcCodec (single source of truth).
function makeFrames(): {
  commandLine(action: string, payload: unknown, frameId: string): string;
  cancelLine(actionId: string, frameId: string): string;
} {
  let seq = 0;
  const nextSeq = (): number => {
    seq += 1;
    return seq;
  };
  return {
    commandLine(action: string, payload: unknown, frameId: string): string {
      return ipcCodec.encode(
        ipcCodec.makeFrame({
          sessionId: 'pipe-test',
          seq: nextSeq(),
          type: 'command',
          action,
          payload,
          traceId: 'trace-pipe',
          frameId,
        }),
      );
    },
    cancelLine(actionId: string, frameId: string): string {
      return ipcCodec.encode(
        ipcCodec.makeFrame({
          sessionId: 'pipe-test',
          seq: nextSeq(),
          type: 'cancel',
          action: 'cancel',
          payload: { actionId },
          traceId: 'trace-pipe',
          frameId,
        }),
      );
    },
  };
}

// ─── stdout 读取器：累积缓冲按行解析，next() 超时 2000ms 断言失败 ──────────
// — English: stdout reader — accumulates the buffer and parses per line; next()
//   fails the assertion after a 2000ms timeout.
function createStdoutReader(stdout: PassThrough): {
  lines: string[];
  next(timeoutMs?: number): Promise<Record<string, unknown>>;
  allText(): string;
} {
  let buffer = '';
  let all = '';
  const lines: string[] = [];
  stdout.on('data', (chunk: Buffer | string) => {
    const text = chunk.toString();
    all += text;
    buffer += text;
    let idx: number;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      lines.push(buffer.slice(0, idx));
      buffer = buffer.slice(idx + 1);
    }
  });
  return {
    lines,
    // 读下一帧：已有完整行直接取；否则轮询等待（超时 → reject，断言失败）。
    // — English: reads the next frame — takes a complete line or polls (timeout rejects).
    next(timeoutMs = 2000): Promise<Record<string, unknown>> {
      return new Promise((resolve, reject) => {
        const deadline = Date.now() + timeoutMs;
        const poll = (): void => {
          if (lines.length > 0) {
            const line = lines.shift()!;
            try {
              resolve(JSON.parse(line) as Record<string, unknown>);
            } catch (err) {
              reject(new Error(`stdout 行不是合法 JSON：${line}（${String(err)}）`));
            }
            return;
          }
          if (Date.now() >= deadline) {
            reject(new Error(`等待 stdout 帧超时（${timeoutMs}ms）`));
            return;
          }
          setTimeout(poll, 5);
        };
        poll();
      });
    },
    allText(): string {
      return all;
    },
  };
}

// 轮询等待条件成立（EOF close 计数、act 启动等时序断言）。
// — English: polls until the condition holds (EOF close counts, act starts…).
async function waitFor(cond: () => boolean, what: string, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() >= deadline) throw new Error(`等待 ${what} 超时（${timeoutMs}ms）`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

// ─── 包装 runtime：记录 session.close 调用次数与 act 启动次数 ───────────────
// — English: wraps the runtime — counts session.close calls and act starts
//   (for EOF shutdown and cancel timing assertions).
class CountingRuntime implements BrowserRuntimePort {
  readonly kind = 'fake' as const;
  closeCount = 0;
  actStarted = 0;

  constructor(private readonly inner: BrowserRuntimePort) {}

  async start(input: { taskId: string; signal?: AbortSignal }): Promise<BrowserSessionHandle> {
    const inner = await this.inner.start(input);
    return {
      sessionId: inner.sessionId,
      taskId: inner.taskId,
      close: async (reason?: string): Promise<void> => {
        this.closeCount += 1;
        await inner.close(reason);
      },
      currentPageGraph: (): PageGraph => inner.currentPageGraph(),
      observe: (i?: { signal?: AbortSignal; pageId?: string }) => inner.observe(i),
      navigate: (i: { url: string; signal?: AbortSignal }) => inner.navigate(i),
      act: (i: { intent: ActionIntent; signal?: AbortSignal }): Promise<ActionResult> => {
        this.actStarted += 1;
        return inner.act(i);
      },
    };
  }
}

// 测试脚手架：双 PassThrough + loop.start()；stdout 的 error 事件被吞掉记录，
// 避免 write-after-end 之类问题以未捕获异常形式炸掉测试进程。
// — English: test scaffold — two PassThrough streams + loop.start(); stdout
//   error events are captured instead of crashing the process uncaught.
function setupLoop(runtime: BrowserRuntimePort): {
  loop: StdinStdoutLoop;
  stdin: PassThrough;
  stdout: PassThrough;
  reader: ReturnType<typeof createStdoutReader>;
  stdoutErrors: unknown[];
} {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stdoutErrors: unknown[] = [];
  stdout.on('error', (err) => stdoutErrors.push(err));
  const reader = createStdoutReader(stdout);
  const loop = createStdinStdoutLoop({ runtime, log: () => {} }, { stdin, stdout });
  loop.start();
  return { loop, stdin, stdout, reader, stdoutErrors };
}

function write(stdin: PassThrough, line: string): void {
  stdin.write(`${line}\n`);
}

describe('Sidecar pipe (createStdinStdoutLoop over PassThrough)', () => {
  it('全链路：start → navigate → observe → act → close（逐帧断言响应）', async () => {
    const frames = makeFrames();
    const { loop, stdin, stdout, reader } = setupLoop(new FakeBrowserRuntime(site));
    try {
      // session.start → response ok（含 sessionId/taskId）。
      write(stdin, frames.commandLine('session.start', { taskId: 'task-pipe' }, 'f-start'));
      const startResp = await reader.next();
      expect(startResp.type).toBe('response');
      expect(startResp.action).toBe('session.start');
      expect(startResp.frameId).toBe('f-start'); // frameId 关联请求
      expect(startResp.payload).toMatchObject({ sessionId: 'sess-task-pipe', taskId: 'task-pipe' });

      // browser.navigate → 完整 Observation。
      write(stdin, frames.commandLine('browser.navigate', { url: 'https://example.com/list' }, 'f-nav'));
      const navResp = await reader.next();
      expect(navResp.type).toBe('response');
      expect(navResp.action).toBe('browser.navigate');
      expect(navResp.frameId).toBe('f-nav');
      expect(navResp.payload).toMatchObject({
        url: 'https://example.com/list',
        title: 'Example List',
        pageId: 'page-1',
        readiness: 'stable',
      });

      // browser.observe → 完整 Observation（元素 [e1]/[e2]）。
      write(stdin, frames.commandLine('browser.observe', {}, 'f-obs'));
      const obsResp = await reader.next();
      expect(obsResp.type).toBe('response');
      expect(obsResp.action).toBe('browser.observe');
      const obsPayload = obsResp.payload as Record<string, unknown>;
      expect(obsPayload.elements).toHaveLength(2);
      const observationId = String(obsPayload.observationId);
      const navigationEpoch = Number(obsPayload.navigationEpoch);

      // browser.act：click [e1] → 详情页，postcondition url_contains 'detail' 通过。
      // 三帧顺序：prepared 事件 → committed 事件 → response ok。
      write(
        stdin,
        frames.commandLine(
          'browser.act',
          {
            intent: makeIntent({
              actionId: 'act-1',
              observationId,
              expectedNavigationEpoch: navigationEpoch,
              postcondition: { kind: 'url_contains', value: 'detail' },
            }),
          },
          'f-act',
        ),
      );
      const prepared = await reader.next();
      expect(prepared.type).toBe('event');
      expect(prepared.action).toBe('browser.action_status');
      expect(prepared.payload).toMatchObject({ actionId: 'act-1', status: 'prepared' });
      const outcome = await reader.next();
      expect(outcome.type).toBe('event');
      expect(outcome.payload).toMatchObject({ actionId: 'act-1', status: 'committed' });
      const actResp = await reader.next();
      expect(actResp.type).toBe('response');
      expect(actResp.action).toBe('browser.act');
      expect(actResp.frameId).toBe('f-act');
      const actPayload = actResp.payload as Record<string, unknown>;
      expect(actPayload.status).toBe('committed');
      const evidence = actPayload.evidence as Record<string, unknown>;
      expect(evidence.actionId).toBe('act-1');
      expect((evidence.observed as Record<string, unknown>).url).toBe('https://example.com/detail');

      // session.close → response ok。
      write(stdin, frames.commandLine('session.close', { reason: 'done' }, 'f-close'));
      const closeResp = await reader.next();
      expect(closeResp.type).toBe('response');
      expect(closeResp.action).toBe('session.close');
      expect(closeResp.frameId).toBe('f-close');
      expect(closeResp.payload).toMatchObject({ sessionId: 'sess-task-pipe' });
    } finally {
      await loop.stop();
      stdin.end();
      stdout.end();
    }
  });

  it('stdout 纯净：多轮往返后每一行都是合法 JSON 协议帧（无日志混入）', async () => {
    const frames = makeFrames();
    const { loop, stdin, stdout, reader, stdoutErrors } = setupLoop(new FakeBrowserRuntime(site));
    try {
      // 多轮往返：start + navigate + observe + act + close，每步等响应。
      write(stdin, frames.commandLine('session.start', { taskId: 'task-pure' }, 'f-1'));
      await reader.next();
      write(stdin, frames.commandLine('browser.navigate', { url: 'https://example.com/list' }, 'f-2'));
      await reader.next();
      write(stdin, frames.commandLine('browser.observe', {}, 'f-3'));
      const obs = await reader.next();
      const obsPayload = obs.payload as Record<string, unknown>;
      write(
        stdin,
        frames.commandLine(
          'browser.act',
          {
            intent: makeIntent({
              observationId: String(obsPayload.observationId),
              expectedNavigationEpoch: Number(obsPayload.navigationEpoch),
            }),
          },
          'f-4',
        ),
      );
      await reader.next(); // prepared 事件
      await reader.next(); // committed 事件
      await reader.next(); // response
      write(stdin, frames.commandLine('session.close', {}, 'f-5'));
      await reader.next();

      // 收尾：end 写入端，等全部数据 flush 后逐行校验。
      stdout.end();
      await once(stdout, 'end');
      expect(stdoutErrors).toHaveLength(0);
      const rawLines = reader.allText().split('\n').filter((l) => l.length > 0);
      expect(rawLines.length).toBeGreaterThan(0);
      for (const line of rawLines) {
        // 每一行都必须是合法 JSON，且含 type/action 字段——日志文本混入即失败。
        // — English: every line must be valid JSON with type/action fields —
        //   any log text mixed in fails the test.
        expect(() => JSON.parse(line)).not.toThrow();
        const frame = JSON.parse(line) as Record<string, unknown>;
        expect(typeof frame.type).toBe('string');
        expect(typeof frame.action).toBe('string');
      }
    } finally {
      await loop.stop();
      stdin.end();
    }
  });

  it('EOF 优雅关闭：stdin.end() 触发 session close（注入 runtime close 计数）', async () => {
    const frames = makeFrames();
    const runtime = new CountingRuntime(new FakeBrowserRuntime(site));
    const { loop, stdin, stdout, reader } = setupLoop(runtime);
    try {
      write(stdin, frames.commandLine('session.start', { taskId: 'task-eof' }, 'f-1'));
      await reader.next();
      expect(runtime.closeCount).toBe(0);

      // stdin EOF → readline close → loop 内 handle.close('stdin closed')。
      stdin.end();
      await waitFor(() => runtime.closeCount === 1, 'EOF 触发 session.close');

      // EOF 关闭路径不产生协议帧输出：stdout 数据不再增长。
      // — English: the EOF close path emits no protocol frames — stdout stops growing.
      const before = reader.allText().length;
      await new Promise((r) => setTimeout(r, 50));
      expect(reader.allText().length).toBe(before);
      expect(reader.lines).toHaveLength(0);

      // 关闭后 stop 正常返回且不重复 close（幂等）。
      await loop.stop();
      expect(runtime.closeCount).toBe(1);
    } finally {
      stdin.end();
      stdout.end();
    }
  });

  it('cancel 跨管道：act 执行中收到 cancel 帧 → failed kind=cancelled', async () => {
    const frames = makeFrames();
    const runtime = new CountingRuntime(new FakeBrowserRuntime(slowSite));
    const { loop, stdin, stdout, reader } = setupLoop(runtime);
    try {
      write(stdin, frames.commandLine('session.start', { taskId: 'task-cancel' }, 'f-1'));
      await reader.next();
      write(stdin, frames.commandLine('browser.observe', {}, 'f-2'));
      const obs = await reader.next();
      const obsPayload = obs.payload as Record<string, unknown>;

      // act 开始（不等待响应），等 runtime 确认进入执行后再发 cancel 帧。
      // — English: start act without awaiting; send the cancel frame only after
      //   the runtime confirms the action is executing.
      write(
        stdin,
        frames.commandLine(
          'browser.act',
          {
            intent: makeIntent({
              actionId: 'act-cancel',
              observationId: String(obsPayload.observationId),
              expectedNavigationEpoch: Number(obsPayload.navigationEpoch),
              postcondition: { kind: 'none' },
            }),
          },
          'f-3',
        ),
      );
      await waitFor(() => runtime.actStarted === 1, 'act 进入执行');
      write(stdin, frames.cancelLine('act-cancel', 'f-4'));

      // 三帧：prepared 事件 → failed 事件 → failed 响应（kind=cancelled）。
      const prepared = await reader.next();
      expect(prepared.payload).toMatchObject({ actionId: 'act-cancel', status: 'prepared' });
      const outcome = await reader.next();
      expect(outcome.payload).toMatchObject({ actionId: 'act-cancel', status: 'failed' });
      expect((outcome.payload as Record<string, unknown>).error).toMatchObject({
        kind: 'cancelled',
        code: 'ABORTED',
      });
      const resp = await reader.next();
      expect(resp.type).toBe('response');
      expect(resp.action).toBe('browser.act');
      expect(resp.frameId).toBe('f-3');
      expect(resp.payload).toMatchObject({ status: 'failed' });
      expect((resp.payload as Record<string, unknown>).error).toMatchObject({
        kind: 'cancelled',
        code: 'ABORTED',
        actionId: 'act-cancel',
      });
    } finally {
      await loop.stop(); // abort 进行中的动作，避免残余帧写到已 end 的流
      stdin.end();
      stdout.end();
    }
  });

  it('非法行：stdin 写入非 JSON → stdout 出现 BAD_FRAME 错误响应帧', async () => {
    const { loop, stdin, stdout, reader } = setupLoop(new FakeBrowserRuntime(site));
    try {
      stdin.write('not json {{{ 42\n');
      const resp = await reader.next();
      expect(resp.type).toBe('response');
      expect(resp.action).toBe('unknown'); // 无法解析时的占位 action
      expect(resp.payload).toMatchObject({ code: 'BAD_FRAME', message: 'invalid frame', retryable: false });
    } finally {
      await loop.stop();
      stdin.end();
      stdout.end();
    }
  });

  it('stop 幂等：多次 stop 均正常返回，stop 后 stdin 不再产生输出', async () => {
    const frames = makeFrames();
    const runtime = new CountingRuntime(new FakeBrowserRuntime(site));
    const { loop, stdin, stdout, reader } = setupLoop(runtime);
    try {
      // 先建会话，验证 stop 走 session close 路径。
      write(stdin, frames.commandLine('session.start', { taskId: 'task-stop' }, 'f-1'));
      await reader.next();

      await loop.stop();
      expect(runtime.closeCount).toBe(1);
      await loop.stop(); // 第二次：会话已关闭，直接返回
      expect(runtime.closeCount).toBe(1);

      // stop 后 readline 已关闭：stdin 写入不再产生 stdout 帧。
      // — English: after stop the readline is closed — stdin writes produce no
      //   more stdout frames.
      const before = reader.allText().length;
      stdin.write('garbage after stop\n');
      await new Promise((r) => setTimeout(r, 100));
      expect(reader.allText().length).toBe(before);
    } finally {
      stdin.end();
      stdout.end();
    }
  });
});
