// Sidecar 进程宿主测试：spawn 真实 Node 子进程（sidecarEntry + ts-js-resolver loader），
// 经真实 JSONL stdin/stdout 管道跑完整浏览器任务闭环。这是「进程级」验证——不再是
// 内存对聊，而是操作系统级子进程 + 管道。
// 前置条件：@suanlizi/protocol 的 dist 已构建（workspace 别名指向 dist；npm run build）。
// — English: sidecar process-host tests — spawns a real Node child process
//   (sidecarEntry + ts-js-resolver loader) and drives a full browser task over a
//   real JSONL stdin/stdout pipe. This is process-level verification, not an
//   in-memory conversation. Prerequisite: @suanlizi/protocol dist built (npm run build).
import { accessSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { runGoldenTaskWithOrchestrator } from '../golden/goldenOrchestrator.js';
import { GOLDEN_TASKS } from '../golden/tasks.js';
import { BrowserTaskOrchestrator } from '../orchestrator.js';
import { BrowserPolicyEngine } from '../policy.js';
import { BrowserTaskMachine } from '../taskMachine.js';
import { BrowserTraceRecorder } from '../trace.js';
import { normalizeAccessPolicyConfig } from '@suanlizi/protocol';
import { spawnSidecarProcess } from './sidecarProcessHost.js';

const here = dirname(fileURLToPath(import.meta.url));

// 测试统一走源码入口（sidecarEntry.ts + ts-js-resolver loader），不依赖 dist 构建时序。
// — English: tests always use the source entry (sidecarEntry.ts + loader) so they
//   do not depend on dist build timing.
const SRC_ENTRY = join(here, 'sidecarEntry.ts');

// 构建产物存在才跑（workspace 别名 @suanlizi/protocol → dist）。
// — English: only run when the workspace dist exists (alias → dist).
function protocolDistAvailable(): boolean {
  try {
    accessSync(join(here, '../../../../node_modules/@suanlizi/protocol/dist/index.js'));
    return true;
  } catch {
    return false;
  }
}

const run = protocolDistAvailable() ? describe : describe.skip;

run('Sidecar 进程宿主（真实子进程 + JSONL 管道）', () => {
  it('T1 黄金任务经 spawnSidecarProcess 进程级全闭环 passed', async () => {
    const spawned = await spawnSidecarProcess({
      taskId: 'proc-t1',
      runtime: 'fake',
      site: 'golden:open-read-title',
      entryPath: SRC_ENTRY,
      log: (line) => console.warn(`[sidecar-proc] ${line}`),
    });
    try {
      const result = await runGoldenTaskWithOrchestrator(
        { start: async () => spawned.handle, ...spawned.handle } as unknown as import('../port.js').BrowserRuntimePort,
        GOLDEN_TASKS[0],
        {
          budget: { maxSteps: 12, maxTokens: 10_000, maxReplans: 2, maxConsecutiveFailures: 2, maxDurationMs: 60_000, maxExternalWrites: 3, maxDownloadBytes: 10_485_760 },
        },
      );
      if (!result.passed) {
        expect(result.failedStepId, `任务 ${GOLDEN_TASKS[0].id} 失败`).toBeUndefined();
      }
      expect(result.passed).toBe(true);
      expect(spawned.child.exitCode).toBeNull();
    } finally {
      await spawned.stop(10_000);
    }
  }, 30_000);

  it('直接命令流：navigate → observe → act click → committed 且页面导航', async () => {
    const statuses: Array<{ actionId: string; status: string }> = [];
    const spawned = await spawnSidecarProcess({
      taskId: 'proc-direct',
      runtime: 'fake',
      entryPath: SRC_ENTRY,
      onActionStatus: (payload) => statuses.push(payload as { actionId: string; status: string }),
    });
    try {
      const obs1 = await spawned.handle.navigate({ url: 'https://example.com/list' });
      expect(obs1.url).toBe('https://example.com/list');
      const obs2 = await spawned.handle.observe({});
      expect(obs2.elements.length).toBeGreaterThan(0);
      const act = await spawned.handle.act({
        intent: {
          taskId: 'proc-direct',
          actionId: 'act-direct-1',
          pageId: obs2.pageId,
          observationId: obs2.observationId,
          expectedNavigationEpoch: obs2.navigationEpoch,
          kind: 'click',
          targetRef: obs2.elements[0].ref,
          arguments: {},
          rationale: '点击第一个结果',
          effect: 'none',
          risk: 'low',
          postcondition: { kind: 'url_contains', value: 'detail' },
        },
      });
      expect(act.status).toBe('committed');
      expect(statuses).toEqual(expect.arrayContaining([
        expect.objectContaining({ actionId: 'act-direct-1', status: 'prepared' }),
        expect.objectContaining({ actionId: 'act-direct-1', status: 'committed' }),
      ]));
      const obs3 = await spawned.handle.observe({});
      expect(obs3.url).toContain('detail');
      expect(obs3.navigationEpoch).toBeGreaterThan(obs2.navigationEpoch);
    } finally {
      await spawned.stop(10_000);
    }
  }, 30_000);

  it('orchestrator 进程级接线：策略/账本/事件/Trace 全闭环', async () => {
    const spawned = await spawnSidecarProcess({ taskId: 'proc-orch', runtime: 'fake', entryPath: SRC_ENTRY });
    try {
      const machine = new BrowserTaskMachine({
        taskId: 'proc-orch',
        goal: '进程级闭环验证',
        budget: { maxSteps: 20, maxTokens: 10_000, maxReplans: 2, maxConsecutiveFailures: 2, maxDurationMs: 60_000, maxExternalWrites: 3, maxDownloadBytes: 10_485_760 },
      });
      const events: string[] = [];
      const traceSpans: string[] = [];
      const recorder = new BrowserTraceRecorder({
        runId: 'proc-run',
        threadId: 'proc-thread',
        runKind: 'workflow',
        emit: (obs) => traceSpans.push(obs.category),
      });
      const port = {
        kind: 'fake' as const,
        start: async () => spawned.handle,
        ...spawned.handle,
      };
      const policyEngine = new BrowserPolicyEngine({
        policy: normalizeAccessPolicyConfig({}),
        evaluateAccess: (request: import('@suanlizi/protocol').AccessRequest) => ({ decision: 'allow' as const, request, source: 'temporary_grant', justification: '进程级测试' }),
        threadId: 'proc-thread',
        turnId: 'proc-turn',
      });
      const orchestrator = new BrowserTaskOrchestrator({
        runtime: port,
        policyEngine,
        machine,
        trace: recorder,
        onCheckpoint: (ck) => {
          for (const event of ck.events) events.push(event.type);
        },
      });
      await orchestrator.start();
      const obs = await orchestrator.navigate({ url: 'https://example.com/list' });
      expect(obs.url).toBe('https://example.com/list');
      const result = await orchestrator.runAction({
        intent: {
          taskId: 'proc-orch',
          actionId: 'act-orch-1',
          pageId: obs.pageId,
          observationId: obs.observationId,
          expectedNavigationEpoch: obs.navigationEpoch,
          kind: 'click',
          targetRef: obs.elements[0].ref,
          arguments: {},
          rationale: '点击结果',
          effect: 'none',
          risk: 'low',
          postcondition: { kind: 'url_contains', value: 'detail' },
        },
      });
      expect(result.outcome).toBe('committed');
      expect(events).toContain('action.completed');
      expect(traceSpans).toContain('browser');
      const state = machine.state;
      expect(state.usage.steps).toBeGreaterThan(0);
      await orchestrator.close('test done');
    } finally {
      await spawned.stop(10_000);
    }
  }, 30_000);

  it('stop() 优雅关闭：会话 close 后子进程退出', async () => {
    const spawned = await spawnSidecarProcess({ taskId: 'proc-stop', runtime: 'fake', entryPath: SRC_ENTRY, log: (line) => console.warn(`[stop-proc] ${line}`) });
    const obs = await spawned.handle.navigate({ url: 'https://example.com/list' });
    expect(obs.url).toBe('https://example.com/list');
    await spawned.stop(10_000);
    // 等 exit 事件；信号终止时退出码为 null，用 signalCode 区分已退出。
    // — English: await the exit event; signal termination yields a null code —
    //   signalCode then proves the process exited.
    await spawned.exitCode;
    expect(spawned.child.signalCode !== null || spawned.child.exitCode !== null).toBe(true);
  }, 30_000);
});
