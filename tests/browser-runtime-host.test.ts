// Agent Runtime 进程（runtimeHostEntry）进程级测试：spawn 真实子进程，经 JSONL 管道
// 驱动完整桌面链路：session.start → navigate → observe → act（强制过 orchestrator 策略）
// → approval.requested 事件 → approval.resolve → session.close。
// 前置条件：@suanlizi/protocol 的 dist 已构建（npm run build）。
// — English: process-level tests for the Agent Runtime entry — spawns the real
//   child process and drives the full desktop chain over the JSONL pipe, including
//   the mandatory orchestrator policy path and the approval flow.
import { accessSync } from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ipcCodec } from '../packages/browser-runtime/src/ipc/codec.js';
import { IPC_VERSION } from '../packages/browser-runtime/src/ipc/ipcTypes.js';
import type { ProtocolFrame } from '../packages/browser-runtime/src/ipc/ipcTypes.js';

const here = dirname(fileURLToPath(import.meta.url));

function protocolDistAvailable(): boolean {
  try {
    accessSync(join(here, '../node_modules/@suanlizi/protocol/dist/index.js'));
    return true;
  } catch {
    return false;
  }
}

const run = protocolDistAvailable() ? describe : describe.skip;

// 进程级 JSONL 客户端：spawn runtimeHostEntry，按 seq 匹配响应帧。
// — English: process-level JSONL client — spawns runtimeHostEntry and matches
//   response frames by frameId.
class HostProcessClient {
  readonly child: ChildProcess;
  private nextFrameId = 0;
  private pending = new Map<string, { action: string; resolve: (frames: ProtocolFrame[]) => void }>();
  private events: ProtocolFrame[] = [];

  constructor(child: ChildProcess) {
    this.child = child;
    const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
    rl.on('line', (line) => {
      let frame: ProtocolFrame | null = null;
      try {
        frame = ipcCodec.decodeLine(line) as ProtocolFrame;
      } catch {
        return;
      }
      if (frame === null) return;
      if (frame.type === 'event') {
        this.events.push(frame);
        return;
      }
      if (frame.type !== 'response') return;
      const entry = this.pending.get(frame.frameId);
      if (entry === undefined) return;
      this.pending.delete(frame.frameId);
      entry.resolve([frame]);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      for (const line of String(chunk).split('\n')) {
        if (line.trim() !== '') console.warn(`[runtime-host-proc] ${line}`);
      }
    });
  }

  command(action: string, payload: unknown, sessionId = 'host-s1'): Promise<ProtocolFrame[]> {
    const frameId = `ht-${++this.nextFrameId}`;
    const frame: ProtocolFrame = {
      version: IPC_VERSION,
      frameId,
      sessionId,
      seq: this.nextFrameId,
      timestamp: Date.now(),
      traceId: 'trace-host-test',
      type: 'command',
      action,
      payload,
    };
    return new Promise<ProtocolFrame[]>((resolve) => {
      this.pending.set(frameId, { action, resolve });
      this.child.stdin?.write(`${ipcCodec.encode(frame)}\n`);
    });
  }

  waitForEvent(action: string, timeoutMs = 5000): Promise<ProtocolFrame> {
    // 消费语义：已收到的事件在返回时从缓存移除，避免后续等待重复命中旧事件。
    // — English: consuming semantics — matched events are removed from the cache
    //   so later waits cannot re-hit a stale event.
    const take = (): ProtocolFrame | undefined => {
      const index = this.events.findIndex((e) => e.action === action);
      if (index === -1) return undefined;
      return this.events.splice(index, 1)[0];
    };
    const existing = take();
    if (existing !== undefined) return Promise.resolve(existing);
    return new Promise<ProtocolFrame>((resolve, reject) => {
      const deadline = Date.now() + timeoutMs;
      const timer = setInterval(() => {
        const hit = take();
        if (hit !== undefined) {
          clearInterval(timer);
          resolve(hit);
        } else if (Date.now() > deadline) {
          clearInterval(timer);
          reject(new Error(`event ${action} not received within ${timeoutMs}ms; events=${JSON.stringify(this.events.map((e) => e.action))}`));
        }
      }, 25);
    });
  }

  async stop(): Promise<void> {
    try {
      await this.command('session.close', {});
    } catch {
      // 尽力而为
    }
    this.child.stdin?.end();
    await new Promise<void>((resolve) => {
      const killer = spawn('taskkill', ['/pid', String(this.child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' });
      killer.on('exit', () => resolve());
      killer.on('error', () => resolve());
    });
  }
}

function spawnHostProcess(): HostProcessClient {
  const entry = join(here, '../packages/browser-runtime/src/sidecar/runtimeHostEntry.ts');
  const loader = join(here, '../packages/browser-runtime/scripts/register-ts-js-resolver.mjs');
  const child = spawn(
    process.execPath,
    [
      '--import', pathToFileURL(loader).href,
      entry,
      '--task-id=host-proc-test',
    ],
    { cwd: join(here, '..'), env: { ...process.env }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
  );
  return new HostProcessClient(child);
}

run('Agent Runtime 进程（runtimeHostEntry）进程级', () => {
  it('完整链路：start → navigate → observe → act（经 orchestrator）→ state 推进', async () => {
    const host = spawnHostProcess();
    try {
      const start = await host.command('session.start', {
        taskId: 'host-t1',
        site: 'golden:open-read-title',
        policyRules: [
          { access: 'network', target: { kind: 'network', host: 'golden.test' }, effect: 'allow', reason: '测试放行导航' },
          { access: 'tool_call', target: { kind: 'tool', toolName: 'browser.click' }, effect: 'allow', reason: '测试放行点击' },
        ],
      });
      expect(start[0].payload).toMatchObject({ result: { state: { status: 'running' } } });

      const nav = await host.command('browser.navigate', { url: 'https://golden.test/list' });
      const navResult = nav[0].payload as { result: { observation: { url: string } } };
      expect(navResult.result.observation.url).toBe('https://golden.test/list');

      const obs = await host.command('browser.observe', {});
      const obsResult = obs[0].payload as { result: { observation: { elements: Array<{ ref: string }>; navigationEpoch: number; pageId: string; observationId: string } } };
      expect(obsResult.result.observation.elements.length).toBeGreaterThan(0);

      const act = await host.command('browser.act', {
        intent: {
          taskId: 'host-t1',
          actionId: 'host-act-1',
          pageId: obsResult.result.observation.pageId,
          observationId: obsResult.result.observation.observationId,
          expectedNavigationEpoch: obsResult.result.observation.navigationEpoch,
          kind: 'click',
          targetRef: obsResult.result.observation.elements[0].ref,
          arguments: {},
          rationale: '进程级点击',
          effect: 'none',
          risk: 'low',
          postcondition: { kind: 'url_contains', value: 'detail' },
        },
      });
      const actResult = act[0].payload as { result: { result: { result: { status: string } } } };
      expect(actResult.result.result.result.status).toBe('committed');

      const obs2 = await host.command('browser.observe', {});
      const obs2Result = obs2[0].payload as { result: { observation: { url: string; navigationEpoch: number } } };
      expect(obs2Result.result.observation.url).toContain('detail');
    } finally {
      await host.stop();
    }
  }, 40_000);

  it('用户地址栏导航：不继承 Agent 的审批等待，直接返回新观测', async () => {
    const host = spawnHostProcess();
    try {
      await host.command('session.start', { taskId: 'host-user-navigation' });
      const nav = await host.command('browser.navigate', {
        url: 'https://example.com/detail',
        userInitiated: true,
      });
      const payload = nav[0].payload as { result: { observation: { url: string } } };
      expect(payload.result.observation.url).toBe('https://example.com/detail');
    } finally {
      await host.stop();
    }
  }, 40_000);

  it('策略强制：外部写动作触发 approval.requested 事件 → approval.resolve 放行', async () => {
    const host = spawnHostProcess();
    try {
      await host.command('session.start', {
        taskId: 'host-t2',
        site: 'golden:open-read-title',
        policyRules: [
          { access: 'network', target: { kind: 'network', host: 'golden.test' }, effect: 'allow', reason: '测试放行导航' },
        ],
      });
      await host.command('browser.navigate', { url: 'https://golden.test/list' });
      const obs = await host.command('browser.observe', {});
      const obsResult = obs[0].payload as { result: { observation: { pageId: string; observationId: string; navigationEpoch: number; elements: Array<{ ref: string }> } } };

      // 外部写动作（effect=external_irreversible）：策略应要求人工确认。
      // — English: an external write (effect=external_irreversible) must prompt.
      const actP = host.command('browser.act', {
        intent: {
          taskId: 'host-t2',
          actionId: 'host-act-write',
          pageId: obsResult.result.observation.pageId,
          observationId: obsResult.result.observation.observationId,
          expectedNavigationEpoch: obsResult.result.observation.navigationEpoch,
          kind: 'click',
          targetRef: obsResult.result.observation.elements[0].ref,
          arguments: {},
          rationale: '带外部副作用的点击',
          effect: 'external_irreversible',
          risk: 'high',
          postcondition: { kind: 'url_contains', value: 'detail' },
        },
      });

      // orchestrator 挂起等待审批 → 先收到 approval.requested 事件帧。
      // — English: the orchestrator waits — the approval.requested event frame arrives first.
      const approvalEvent = await host.waitForEvent('approval.requested');
      const request = approvalEvent.payload as { requestId: string };
      expect(typeof request.requestId).toBe('string');

      // 拒绝 → 动作失败（不执行）；再批准路径由下方允许用例覆盖。
      await host.command('approval.resolve', { requestId: request.requestId, approved: false });
      const actOutcome = await actP;
      const actPayload = actOutcome[0].payload as { result: { result: { result: { status: string; error?: { code: string } } } } };
      expect(actPayload.result.result.result.status).toBe('failed');
      expect(actPayload.result.result.result.error?.code).toBe('POLICY_DENIED');

      // 批准路径：再发一个外部写动作 → 批准 → 执行。
      const obsB = await host.command('browser.observe', {});
      const obsBResult = obsB[0].payload as { result: { observation: { pageId: string; observationId: string; navigationEpoch: number; elements: Array<{ ref: string }> } } };
      const actP2 = host.command('browser.act', {
        intent: {
          taskId: 'host-t2',
          actionId: 'host-act-write-2',
          pageId: obsBResult.result.observation.pageId,
          observationId: obsBResult.result.observation.observationId,
          expectedNavigationEpoch: obsBResult.result.observation.navigationEpoch,
          kind: 'click',
          targetRef: obsBResult.result.observation.elements[0].ref,
          arguments: {},
          rationale: '第二次外部写点击',
          effect: 'external_irreversible',
          risk: 'high',
          postcondition: { kind: 'url_contains', value: 'detail' },
        },
      });
      const approval2 = await host.waitForEvent('approval.requested');
      const request2 = approval2.payload as { requestId: string };
      await host.command('approval.resolve', { requestId: request2.requestId, approved: true });
      const act2Result = await actP2;
      const act2Payload = act2Result[0].payload as { result: { result: { result: { status: string } } } };
      expect(act2Payload.result.result.result.status).toBe('committed');
      void actP;
    } finally {
      await host.stop();
    }
  }, 40_000);

  it('cancel：任务取消后状态进入 cancelling/cancelled', async () => {
    const host = spawnHostProcess();
    try {
      const start = await host.command('session.start', { taskId: 'host-t3' });
      expect(start[0].payload).toMatchObject({ result: { state: { status: 'running' } } });
      const cancel = await host.command('browser.cancel', {});
      const cancelResult = cancel[0].payload as { result: { state: { status: string } } };
      expect(['cancelling', 'cancelled']).toContain(cancelResult.result.state.status);
    } finally {
      await host.stop();
    }
  }, 40_000);
});
