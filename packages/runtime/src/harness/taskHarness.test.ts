import { describe, expect, it, vi } from 'vitest';
import type { ThreadId, ThreadItem, ThreadMeta } from '@suanlizi/protocol';
import { TaskHarnessEngine, type HarnessAgentLoop } from './taskHarness.js';
import { GoalTracker } from './goalTracker.js';
import { DEFAULT_HARNESS_CONFIG } from './types.js';

class FakeHarnessStore {
  tags: Record<string, string> = {};

  async getThread(threadId: ThreadId): Promise<ThreadMeta> {
    return {
      threadId,
      title: 'Harness test',
      workspaceRoot: '',
      status: 'active' as const,
      turnCount: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      archivedAt: null,
      ephemeral: false,
      tags: this.tags,
    };
  }

  async updateThreadMetadata(_threadId: ThreadId, patch: { tags?: Record<string, string> }) {
    this.tags = patch.tags ?? this.tags;
  }

  async getRecentItems() {
    return [];
  }

  async getItems() {
    return [];
  }

  async getCompactionSummary() {
    return null;
  }
}

// P2 取消链断言用：直接读 thread.tags 里落盘的 harnessState（GoalTracker.persist 写入）
function readHarnessState(
  store: FakeHarnessStore,
  harnessRunId: string,
): { status: string; iteration: number } | null {
  const raw = store.tags[`harnessState:${harnessRunId}`];
  return raw ? (JSON.parse(raw) as { status: string; iteration: number }) : null;
}

const answerItems: ThreadItem[] = [{
  id: 'item_answer_abort',
  type: 'agent_message',
  turnId: 'turn_answer_abort',
  text: '已完成一部分。',
  status: 'completed',
  timestamp: new Date().toISOString(),
} as unknown as ThreadItem];

// 评估器固定返回「未满足、继续」，保证循环本应一直跑下去（从而能证明 abort 真的让它退出）
function neverSatisfiedModel() {
  return {
    completeOnce: vi.fn(async () => JSON.stringify({
      satisfied: false,
      status: 'continue',
      passedCriteria: [],
      failedCriteria: ['目标未达成'],
      evidenceSummary: '',
      reasoning: 'keep going',
      progressSignature: `sig-${Math.random()}`,
      criteriaEvidenceMap: {},
    })),
  };
}

describe('TaskHarnessEngine', () => {
  it('lets a pure answer reach goal evaluation instead of retrying readiness forever', async () => {
    let turnCalls = 0;
    const answerItems: ThreadItem[] = [{
      id: 'item_answer',
      type: 'agent_message',
      turnId: 'turn_answer',
      text: '航空保障包（扩展包）用于补充航空保障相关能力。',
      status: 'completed',
      timestamp: new Date().toISOString(),
    } as unknown as ThreadItem];

    const agentLoop: HarnessAgentLoop = {
      runTurn: vi.fn(async () => {
        turnCalls += 1;
        if (turnCalls > 2) throw new Error('readiness retry loop');
        return { items: answerItems, usage: null };
      }),
    };
    const model = {
      completeOnce: vi.fn(async () => JSON.stringify({
        satisfied: true,
        status: 'satisfied',
        passedCriteria: ['介绍一下航空保障包（扩展包）'],
        failedCriteria: [],
        evidenceSummary: 'The assistant answered the requested introduction.',
        reasoning: 'Pure informational answer satisfies the criterion.',
        criteriaEvidenceMap: {},
      })),
    };

    const engine = new TaskHarnessEngine(
      agentLoop,
      model,
      new FakeHarnessStore(),
      { ...DEFAULT_HARNESS_CONFIG, maxContinuations: 2, maxNoProgress: 1 },
    );

    const result = await engine.runHarness(
      'thread-harness-pure-answer',
      { type: 'text', text: '介绍一下航空保障包（扩展包）' },
      {
        acceptanceCriteria: ['介绍一下航空保障包（扩展包）'],
        maxContinuations: 2,
      },
    );

    expect(result.status).toBe('satisfied');
    expect(agentLoop.runTurn).toHaveBeenCalledTimes(1);
    expect(model.completeOnce).toHaveBeenCalledTimes(1);
  });

  it('stops repeated readiness failures through no-progress instead of retrying indefinitely', async () => {
    let turnCalls = 0;
    const changedItems: ThreadItem[] = [{
      id: 'item_change',
      type: 'file_change',
      turnId: 'turn_change',
      status: 'completed',
      timestamp: new Date().toISOString(),
      changes: [{
        kind: 'update',
        path: 'src/example.ts',
        summary: 'changed example',
        hunks: [],
      }],
    } as unknown as ThreadItem];

    const agentLoop: HarnessAgentLoop = {
      runTurn: vi.fn(async () => {
        turnCalls += 1;
        if (turnCalls > 3) throw new Error('readiness retry loop');
        return { items: changedItems, usage: null };
      }),
    };
    const model = {
      completeOnce: vi.fn(async () => JSON.stringify({
        satisfied: false,
        status: 'continue',
        passedCriteria: [],
        failedCriteria: ['修改 src/example.ts 并通过测试'],
        evidenceSummary: '',
        reasoning: 'not called when readiness fails',
      })),
    };

    const engine = new TaskHarnessEngine(
      agentLoop,
      model,
      new FakeHarnessStore(),
      { ...DEFAULT_HARNESS_CONFIG, maxContinuations: 5, maxNoProgress: 1 },
    );

    const result = await engine.runHarness(
      'thread-harness-readiness-stop',
      { type: 'text', text: '修改 src/example.ts 并通过测试' },
      {
        acceptanceCriteria: ['修改 src/example.ts 并通过测试'],
        maxContinuations: 5,
      },
    );

    expect(result.status).toBe('no_progress');
    expect(agentLoop.runTurn).toHaveBeenCalledTimes(2);
    expect(model.completeOnce).not.toHaveBeenCalled();
  });

  it('P2 取消链：signal abort 后续跑循环立即退出并落 cancelled 可追溯终态', async () => {
    const controller = new AbortController();
    controller.abort();
    const store = new FakeHarnessStore();
    const persist = vi.spyOn(store, 'updateThreadMetadata');
    const agentLoop: HarnessAgentLoop = {
      runTurn: vi.fn(async () => {
      // 首轮阻塞到 abort，避免循环先跑满 maxContinuations 导致 suspend 断言失真。
      await new Promise<void>((resolve) => {
        const check = () => {
          if (controller.signal.aborted) resolve();
          else setTimeout(check, 5);
        };
        check();
      });
      return { items: answerItems, usage: null };
    }),
    };
    const model = neverSatisfiedModel();
    const statuses: string[] = [];
    const engine = new TaskHarnessEngine(
      agentLoop,
      model,
      store,
      { ...DEFAULT_HARNESS_CONFIG, maxContinuations: 5, maxNoProgress: 5 },
      undefined,
      ({ state }) => { statuses.push(state.status); },
    );

    const result = await engine.runHarness(
      'thread-harness-abort',
      { type: 'text', text: '修改 src/example.ts 并通过测试' },
      {
        acceptanceCriteria: ['修改 src/example.ts 并通过测试'],
        maxContinuations: 5,
        signal: controller.signal,
        harnessRunId: 'hrun-abort',
      },
    );

    // 循环顶部 break：首轮之后不再发起任何续跑 turn / 评估
    expect(agentLoop.runTurn).toHaveBeenCalledTimes(1);
    expect(model.completeOnce).not.toHaveBeenCalled();
    expect(result.status).toBe('cancelled');
    // persist 在 abort 路径仍执行一次，harnessState 落 cancelled、activeHarnessRunId 清空
    expect(persist).toHaveBeenCalled();
    expect(readHarnessState(store, 'hrun-abort')?.status).toBe('cancelled');
    expect(store.tags['activeHarnessRunId']).toBe('');
    expect(statuses.at(-1)).toBe('cancelled');
  });

  it('P2 取消链：abort 引发的 runTurn 抛错收敛为 cancelled 终态，不产生未捕获拒绝', async () => {
    const controller = new AbortController();
    const store = new FakeHarnessStore();
    const agentLoop: HarnessAgentLoop = {
      runTurn: vi.fn(async () => {
        controller.abort();
        throw new Error('Turn cancelled');
      }),
    };
    const engine = new TaskHarnessEngine(
      agentLoop,
      neverSatisfiedModel(),
      store,
      { ...DEFAULT_HARNESS_CONFIG, maxContinuations: 5, maxNoProgress: 5 },
    );

    const result = await engine.runHarness(
      'thread-harness-abort-throw',
      { type: 'text', text: '修改 src/example.ts 并通过测试' },
      {
        acceptanceCriteria: ['修改 src/example.ts 并通过测试'],
        maxContinuations: 5,
        signal: controller.signal,
        harnessRunId: 'hrun-abort-throw',
      },
    );

    expect(result.status).toBe('cancelled');
    expect(readHarnessState(store, 'hrun-abort-throw')?.status).toBe('cancelled');
    expect(store.tags['activeHarnessRunId']).toBe('');
  });

  it('P2 取消链：非取消异常仍向上抛出，但 finally 补写 blocked 终态（不留 active 孤儿）', async () => {
    const store = new FakeHarnessStore();
    const agentLoop: HarnessAgentLoop = {
      runTurn: vi.fn(async () => { throw new Error('model exploded'); }),
    };
    const engine = new TaskHarnessEngine(
      agentLoop,
      neverSatisfiedModel(),
      store,
      { ...DEFAULT_HARNESS_CONFIG, maxContinuations: 5, maxNoProgress: 5 },
    );

    await expect(engine.runHarness(
      'thread-harness-error',
      { type: 'text', text: '修改 src/example.ts 并通过测试' },
      {
        acceptanceCriteria: ['修改 src/example.ts 并通过测试'],
        maxContinuations: 5,
        harnessRunId: 'hrun-error',
      },
    )).rejects.toThrow('model exploded');

    expect(readHarnessState(store, 'hrun-error')?.status).toBe('blocked');
    expect(store.tags['activeHarnessRunId']).toBe('');
  });

  it('P2 生命周期修复：pause 的 suspend signal abort 不落 cancelled，保持 active 等待 resume', async () => {
    const suspendController = new AbortController();
    const controller = new AbortController();
    const store = new FakeHarnessStore();
    const persist = vi.spyOn(store, 'updateThreadMetadata');
    const agentLoop: HarnessAgentLoop = {
      runTurn: vi.fn(async () => {
        // 首轮阻塞到 abort，避免循环先跑满 maxContinuations 导致 suspend 断言失真。
        await new Promise<void>((resolve) => {
          const check = () => {
            if (controller.signal.aborted) resolve();
            else setTimeout(check, 5);
          };
          check();
        });
        return { items: answerItems, usage: null };
      }),
    };
    const statuses: string[] = [];
    const engine = new TaskHarnessEngine(
      agentLoop,
      neverSatisfiedModel(),
      store,
      { ...DEFAULT_HARNESS_CONFIG, maxContinuations: 5, maxNoProgress: 5 },
      undefined,
      ({ state }) => { statuses.push(state.status); },
    );

    const resultPromise = engine.runHarness(
      'thread-harness-suspend',
      { type: 'text', text: '修改 src/example.ts 并通过测试' },
      {
        acceptanceCriteria: ['修改 src/example.ts 并通过测试'],
        maxContinuations: 5,
        signal: controller.signal,
        suspendSignal: suspendController.signal,
        harnessRunId: 'hrun-suspend',
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    // 模拟 pause：suspend signal 先 abort，随后真正 abort 收口。
    suspendController.abort();
    controller.abort();
    const result = await resultPromise;

    // suspend 意图：状态保持 active，activeHarnessRunId tag 保留，resume 可续跑。
    expect(result.status).toBe('cancelled'); // registry 侧仍收口为 cancelled 结果（不变更协议）。
    expect(readHarnessState(store, 'hrun-suspend')?.status).toBe('active');
    expect(store.tags['activeHarnessRunId']).toBe('hrun-suspend');
    expect(statuses.at(-1)).toBe('active');
    expect(persist).toHaveBeenCalled();

    // resume（显式 harnessRunId）可以继续执行。
    const resumeEngine = new TaskHarnessEngine(
      agentLoop,
      neverSatisfiedModel(),
      store,
      { ...DEFAULT_HARNESS_CONFIG, maxContinuations: 5, maxNoProgress: 5 },
    );
    const resumed = await resumeEngine.resumeHarness('thread-harness-suspend', {
      harnessRunId: 'hrun-suspend',
    });
    expect(resumed.harnessRunId).toBe('hrun-suspend');
  });
  it('P2 取消链：resumeHarness 的续跑循环 abort 后退出并 persist cancelled', async () => {
    const store = new FakeHarnessStore();
    const seeded = new GoalTracker('thread-harness-resume-abort', 'hrun-resume');
    seeded.setGoal('修改 src/example.ts 并通过测试', ['修改 src/example.ts 并通过测试'], {
      maxContinuations: 5,
      maxNoProgress: 5,
    });
    await seeded.persist(store);
    expect(readHarnessState(store, 'hrun-resume')?.status).toBe('active');

    const controller = new AbortController();
    controller.abort();
    const persist = vi.spyOn(store, 'updateThreadMetadata');
    const agentLoop: HarnessAgentLoop = {
      runTurn: vi.fn(async () => ({ items: answerItems, usage: null })),
    };
    const engine = new TaskHarnessEngine(
      agentLoop,
      neverSatisfiedModel(),
      store,
      { ...DEFAULT_HARNESS_CONFIG, maxContinuations: 5, maxNoProgress: 5 },
    );

    const result = await engine.resumeHarness('thread-harness-resume-abort', {
      signal: controller.signal,
    });

    expect(result.status).toBe('cancelled');
    expect(agentLoop.runTurn).not.toHaveBeenCalled();
    expect(persist).toHaveBeenCalled();
    expect(readHarnessState(store, result.harnessRunId)?.status).toBe('cancelled');
    expect(store.tags['activeHarnessRunId']).toBe('');
  });
});
