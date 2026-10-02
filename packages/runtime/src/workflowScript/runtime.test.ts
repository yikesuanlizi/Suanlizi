// Workflow 受限运行时测试（计划 P4 验收：并发上限、总量/条目/token/时长限制、
// 取消穿透子代理、结构化输出失败可追踪、args 透传、AgentCall 持久化）。
import { describe, expect, it } from 'vitest';
import { type WorkflowAgentCall, type WorkflowRunRecord } from '@suanlizi/protocol';
import { WorkflowScriptRuntime, WORKFLOW_RESULT_HANDLE_THRESHOLD_BYTES, type WorkflowAgentExecutor, type WorkflowRuntimeEvent } from './runtime.js';
import type { WorkflowScriptMeta } from './validator.js';

const SCRIPT_HEAD = "export const meta = { name: 't', description: 'd', phases: ['p1'] }\n";

function makeExecutor(
  impl: (input: { prompt: string; callId: string; signal: AbortSignal }) => Promise<unknown>,
): { executor: WorkflowAgentExecutor; prompts: string[] } {
  const prompts: string[] = [];
  return {
    prompts,
    executor: async (input) => {
      prompts.push(input.prompt);
      const result = await impl(input);
      return { result, inputTokens: 10, outputTokens: 5 };
    },
  };
}

/** 内存版 TaskStorePort 子集，校验 AgentCall / WorkflowRunRecord 持久化路径。 */
function makeStore() {
  const runs = new Map<string, WorkflowRunRecord>();
  const calls = new Map<string, WorkflowAgentCall>();
  return {
    runs,
    calls,
    upsertWorkflowRun: async (record: WorkflowRunRecord) => {
      runs.set(record.id, record);
      return record;
    },
    getWorkflowRun: async (id: string) => runs.get(id) ?? null,
    recordAgentCall: async (runId: string, call: WorkflowAgentCall) => {
      calls.set(`${runId}:${call.id}`, call);
      return call;
    },
    updateAgentCall: async (runId: string, call: WorkflowAgentCall) => {
      calls.set(`${runId}:${call.id}`, call);
      return call;
    },
    listAgentCalls: async (runId: string) =>
      [...calls.entries()].filter(([key]) => key.startsWith(`${runId}:`)).map(([, call]) => call),
  };
}

const SAMPLE_SCRIPT = `${SCRIPT_HEAD}
phase('p1')
const files = args && args.files ? args.files : ['a.ts', 'b.ts', 'c.ts']
const found = await agent('列出文件', { schema: { type: 'object', properties: { files: { type: 'array', items: { type: 'string' } } }, required: ['files'] } })
const audits = await pipeline(found.files, file => agent(\`审计 \${file}\`, { label: file }))
return { files: found.files, audits }
`;

describe('WorkflowScriptRuntime', () => {
  it('执行计划式脚本：schema 校验、args 透传、phase/log 事件与结果回传', async () => {
    const events: WorkflowRuntimeEvent[] = [];
    const { executor } = makeExecutor(async ({ prompt }) => {
      if (prompt === '列出文件') return { files: ['a.ts', 'b.ts'] };
      return { file: prompt, risk: 'low' };
    });
    const runtime = new WorkflowScriptRuntime({
      script: SAMPLE_SCRIPT,
      scriptHash: 'hash-1',
      args: { files: ['ignored'] },
      executor,
      onEvent: (event) => events.push(event),
    });
    const result = await runtime.run();
    expect(result.status).toBe('completed');
    expect(result.value).toEqual({
      files: ['a.ts', 'b.ts'],
      audits: [{ file: '审计 a.ts', risk: 'low' }, { file: '审计 b.ts', risk: 'low' }],
    });
    expect(result.usage.agentCallCount).toBe(3);
    expect(events.some((e) => e.type === 'workflow.phase' && e.phase === 'p1')).toBe(true);
    expect(events.filter((e) => e.type === 'workflow.agent_call.terminal')).toHaveLength(3);
  });

  it('静态校验失败的脚本抛 WORKFLOW_SCRIPT_INVALID', async () => {
    const { executor } = makeExecutor(async () => null);
    const runtime = new WorkflowScriptRuntime({
      script: `${SCRIPT_HEAD}const t = Date.now()\nreturn t`,
      scriptHash: 'hash-1',
      executor,
    });
    await expect(runtime.run()).rejects.toMatchObject({ code: 'WORKFLOW_SCRIPT_INVALID' });
  });

  it('并发不超过 maxConcurrentAgents', async () => {
    let active = 0;
    let peak = 0;
    const { executor } = makeExecutor(async ({ prompt }) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active -= 1;
      return prompt === 'list' ? { files: Array.from({ length: 12 }, (_, i) => `f${i}.ts`) } : 'ok';
    });
    const runtime = new WorkflowScriptRuntime({
      script: `${SCRIPT_HEAD}const found = await agent('list')\nconst out = await pipeline(found.files, file => agent(file))\nreturn out.length`,
      scriptHash: 'hash-1',
      limits: { maxConcurrentAgents: 3 },
      executor,
    });
    const result = await runtime.run();
    expect(result.status).toBe('completed');
    expect(result.value).toBe(12);
    expect(peak).toBeLessThanOrEqual(3);
  });

  it('超过 maxAgentsPerRun 时抛 WORKFLOW_LIMIT_EXCEEDED 且 run failed', async () => {
    const { executor } = makeExecutor(async () => 'ok');
    const runtime = new WorkflowScriptRuntime({
      script: `${SCRIPT_HEAD}const out = await parallel([() => agent('1'), () => agent('2'), () => agent('3')])\nreturn out`,
      scriptHash: 'hash-1',
      limits: { maxAgentsPerRun: 2 },
      executor,
    });
    const result = await runtime.run();
    expect(result.status).toBe('failed');
    expect(result.error).toContain('maxAgentsPerRun');
  });

  it('pipeline 条目数超过 maxItemsPerPipeline 被拒绝（不发起任何 agent 调用）', async () => {
    const { executor, prompts } = makeExecutor(async () => ({ files: Array.from({ length: 6 }, (_, i) => `f${i}`) }));
    const runtime = new WorkflowScriptRuntime({
      script: `${SCRIPT_HEAD}const found = await agent('list')\nconst out = await pipeline(found.files, file => agent(file))\nreturn out`,
      scriptHash: 'hash-1',
      limits: { maxItemsPerPipeline: 5 },
      executor,
    });
    const result = await runtime.run();
    expect(result.status).toBe('failed');
    expect(result.error).toContain('maxItemsPerPipeline');
    expect(prompts).toHaveLength(1);
  });

  it('token 总量超过 maxTotalTokens 时失败', async () => {
    const { executor } = makeExecutor(async () => 'ok');
    const runtime = new WorkflowScriptRuntime({
      script: `${SCRIPT_HEAD}await agent('1')\nawait agent('2')\nreturn true`,
      scriptHash: 'hash-1',
      limits: { maxTotalTokens: 25 },
      executor,
    });
    const result = await runtime.run();
    expect(result.status).toBe('failed');
    expect(result.error).toContain('maxTotalTokens');
  });

  it('超过 maxDurationMs 后取消（run cancelled）', async () => {
    const { executor } = makeExecutor(async () => {
      await new Promise((resolve) => setTimeout(resolve, 40));
      return 'ok';
    });
    const runtime = new WorkflowScriptRuntime({
      script: `${SCRIPT_HEAD}await agent('1')\nawait agent('2')\nreturn true`,
      scriptHash: 'hash-1',
      limits: { maxDurationMs: 20 },
      executor,
    });
    const result = await runtime.run();
    expect(result.status).toBe('cancelled');
    expect(result.error).toContain('cancelled');
  });

  it('取消信号穿透子代理：进行中的 agent 调用标记 cancelled，run 终态 cancelled', async () => {
    const controller = new AbortController();
    const store = makeStore();
    const executor: WorkflowAgentExecutor = ({ signal }) =>
      new Promise((_, reject) => {
        const onAbort = () => reject(new Error('subagent aborted'));
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
      });
    const runtime = new WorkflowScriptRuntime({
      script: `${SCRIPT_HEAD}await agent('slow')\nawait agent('never')\nreturn true`,
      scriptHash: 'hash-1',
      runId: 'wfrun-cancel-1',
      taskRunId: 'taskrun-1',
      store,
      executor,
      signal: controller.signal,
    });
    const runPromise = runtime.run();
    setTimeout(() => controller.abort(), 10);
    const result = await runPromise;
    expect(result.status).toBe('cancelled');
    expect(result.agentCalls[0]?.status).toBe('cancelled');
    expect(store.runs.get('wfrun-cancel-1')?.status).toBe('cancelled');
  });

  it('结构化输出 schema 校验失败：AgentCall 记录 failed 且抛 WorkflowStructuredOutputError', async () => {
    const store = makeStore();
    const { executor } = makeExecutor(async () => ({ wrong: 'shape' }));
    const runtime = new WorkflowScriptRuntime({
      script: `${SCRIPT_HEAD}const r = await agent('bad', { schema: { type: 'object', properties: { files: { type: 'array' } }, required: ['files'] } })\nreturn r`,
      scriptHash: 'hash-1',
      runId: 'wfrun-schema-1',
      taskRunId: 'taskrun-1',
      store,
      executor,
    });
    const result = await runtime.run();
    expect(result.status).toBe('failed');
    expect(result.agentCalls[0]?.status).toBe('failed');
    expect(result.agentCalls[0]?.error).toContain('structured output validation failed');
    expect(store.calls.get(`wfrun-schema-1:${result.agentCalls[0]?.id}`)?.status).toBe('failed');
  });

  it('结构化输出错误可被脚本捕获（WorkflowStructuredOutputError）', async () => {
    const { executor } = makeExecutor(async () => ({ wrong: 'shape' }));
    const runtime = new WorkflowScriptRuntime({
      script: `${SCRIPT_HEAD}
let failure = null
try {
  await agent('bad', { schema: { type: 'object', properties: { files: { type: 'array' } }, required: ['files'] } })
} catch (error) {
  failure = error && error.name
}
return failure`,
      scriptHash: 'hash-1',
      executor,
    });
    const result = await runtime.run();
    expect(result.status).toBe('completed');
    expect(result.value).toBe('WorkflowStructuredOutputError');
  });

  it('注入 store 时持久化 run record 与 agent calls（running → completed）', async () => {
    const store = makeStore();
    const { executor } = makeExecutor(async () => 'ok');
    const runtime = new WorkflowScriptRuntime({
      script: `${SCRIPT_HEAD}const a = await agent('one')\nconst b = await agent('two')\nreturn [a, b]`,
      scriptHash: 'hash-abc',
      runId: 'wfrun-persist-1',
      taskRunId: 'taskrun-1',
      store,
      executor,
    });
    const result = await runtime.run();
    expect(result.status).toBe('completed');
    const record = store.runs.get('wfrun-persist-1');
    expect(record?.status).toBe('completed');
    expect(record?.scriptHash).toBe('hash-abc');
    expect(record?.usage.agentCallCount).toBe(2);
    expect(store.calls.size).toBe(2);
  });

  it('validate() 暴露 meta 供批准界面展示', () => {
    const { executor } = makeExecutor(async () => 'ok');
    const runtime = new WorkflowScriptRuntime({
      script: SAMPLE_SCRIPT,
      scriptHash: 'hash-1',
      executor,
    });
    const validation = runtime.validate();
    expect(validation.ok).toBe(true);
    expect(validation.meta?.name).toBe('t');
    expect((validation.meta as WorkflowScriptMeta).phases).toEqual(['p1']);
  });
});

// ─── §14.5：大结果句柄与 readResult 分页 ───────────────────────────────────────

const HANDLE_SCRIPT = `${SCRIPT_HEAD}
phase('p1')
const big = await agent('生成大结果')
const page = readResult(big, { offset: 0, limit: 120 })
return { truncated: big.truncated, hash: big.hash, size: big.size, summary: big.summary, head: page.text, hasMore: page.hasMore }
`;

const SMALL_SCRIPT = `${SCRIPT_HEAD}
phase('p1')
const small = await agent('生成小结果')
return { files: small.files }
`;

/** 足以越线的大结果（> 8KB）。 */
function bigResult(): { rows: string[] } {
  return { rows: Array.from({ length: 400 }, (_, index) => `row-${index}-${'x'.repeat(40)}`) };
}

describe('WorkflowScriptRuntime §14.5 大结果句柄', () => {
  it('小结果直返原值，但仍记录 resultHash / resultSize', async () => {
    const store = makeStore();
    const { executor } = makeExecutor(async () => ({ files: ['a.ts'] }));
    const runtime = new WorkflowScriptRuntime({
      script: SMALL_SCRIPT,
      scriptHash: 'hash-small',
      runId: 'wfrun-small',
      taskRunId: 'taskrun-small',
      executor,
      store: store as never,
    });
    const result = await runtime.run();
    expect(result.status).toBe('completed');
    expect(result.value).toEqual({ files: ['a.ts'] });
    const call = [...store.calls.values()][0]!;
    expect(call.resultHash).toMatch(/^[0-9a-f]{16}$/);
    expect(call.resultSize).toBeGreaterThan(0);
    expect(call.resultSize).toBeLessThanOrEqual(WORKFLOW_RESULT_HANDLE_THRESHOLD_BYTES);
  });

  it('大结果只向脚本返回句柄，readResult 可分页取回全文', async () => {
    const { executor } = makeExecutor(async () => bigResult());
    const runtime = new WorkflowScriptRuntime({
      script: HANDLE_SCRIPT,
      scriptHash: 'hash-big',
      runId: 'wfrun-big',
      executor,
    });
    const result = await runtime.run();
    expect(result.status).toBe('completed');
    const value = result.value as {
      truncated: true; hash: string; size: number; summary: string; head: string; hasMore: boolean;
    };
    // 句柄字段：脚本拿不到全文，只能拿到指纹 + 前缀摘要。
    expect(value.truncated).toBe(true);
    expect(value.hash).toMatch(/^[0-9a-f]{16}$/);
    expect(value.size).toBeGreaterThan(WORKFLOW_RESULT_HANDLE_THRESHOLD_BYTES);
    expect(value.summary.length).toBeLessThanOrEqual(240);
    expect(value.hasMore).toBe(true);
    const serialized = JSON.stringify(bigResult());
    expect(value.head).toBe(serialized.slice(0, 120));
    expect(value.head.length).toBeLessThan(serialized.length);
  });

  it('句柄跨分页拼接得到完整全文；参数越界或非法句柄 fail-closed', async () => {
    const script = `${SCRIPT_HEAD}
phase('p1')
const big = await agent('生成大结果')
const first = readResult(big, { offset: 0, limit: 5000 })
const second = readResult(big, { offset: 5000, limit: 60000 })
return { a: first.text, b: second.text, hasMore: first.hasMore, secondHasMore: second.hasMore, size: second.size, hash: second.hash }
`;
    const { executor } = makeExecutor(async () => bigResult());
    const runtime = new WorkflowScriptRuntime({ script, scriptHash: 'hash-page', runId: 'wfrun-page', executor });
    const result = await runtime.run();
    expect(result.status).toBe('completed');
    const value = result.value as { a: string; b: string; hasMore: boolean; secondHasMore: boolean; size: number; hash: string };
    expect(value.hasMore).toBe(true);
    expect(value.secondHasMore).toBe(false);
    expect(value.a + value.b).toBe(JSON.stringify(bigResult()));
    expect(value.hash).toMatch(/^[0-9a-f]{16}$/);

    // limit 超过单页上限 → 脚本错误可诊断，run 落 failed。
    const overLimit = await new WorkflowScriptRuntime({
      script: `${SCRIPT_HEAD}\nconst big = await agent('生成大结果')\nreturn readResult(big, { offset: 0, limit: 999999 })` as string,
      scriptHash: 'hash-over',
      runId: 'wfrun-over',
      executor,
    }).run().catch((error: unknown) => error);
    // runtime.run() 本身不抛：失败以 status=failed + error 返回。
    const failed = overLimit as { status: string; error?: string };
    expect(failed.status).toBe('failed');
    expect(failed.error).toContain('out of range');

    const notHandle = await new WorkflowScriptRuntime({
      script: `${SCRIPT_HEAD}\nreturn readResult('wac_missing', { offset: 0, limit: 100 })` as string,
      scriptHash: 'hash-bad',
      runId: 'wfrun-bad',
      executor,
    }).run();
    expect(notHandle.status).toBe('failed');
    expect(notHandle.error).toContain('readResult requires a handle');
  });

  it('恢复复用的大结果同样以句柄形式交给脚本（不重新执行 executor）', async () => {
    const prior: WorkflowAgentCall = {
      id: 'ignored',
      prompt: '生成大结果',
      status: 'completed',
      result: bigResult(),
      inputTokens: 3,
      outputTokens: 4,
    };
    let executorCalls = 0;
    const { executor } = makeExecutor(async () => {
      executorCalls += 1;
      return bigResult();
    });
    // callId 由 hash 决定；prior 需用同一算法才能命中。此处直接拿一次真实运行产生的 id 复用。
    const first = await new WorkflowScriptRuntime({
      script: HANDLE_SCRIPT,
      scriptHash: 'hash-resume',
      runId: 'wfrun-first',
      executor,
    }).run();
    expect(first.status).toBe('completed');
    const callId = first.agentCalls[0]?.id ?? '';
    executorCalls = 0;

    const resumed = await new WorkflowScriptRuntime({
      script: HANDLE_SCRIPT,
      scriptHash: 'hash-resume',
      runId: 'wfrun-resume',
      executor,
      resumeAgentCalls: [{ ...prior, id: callId }],
    }).run();
    expect(resumed.status).toBe('completed');
    expect(executorCalls).toBe(0);
    // 复用的大结果仍只给句柄：后续脚本需走 readResult 分页。
    const value = resumed.value as { truncated: true; size: number; head: string };
    expect(value.truncated).toBe(true);
    expect(value.size).toBeGreaterThan(WORKFLOW_RESULT_HANDLE_THRESHOLD_BYTES);
    expect(resumed.agentCalls[0]?.id).toBe(callId);
    expect(resumed.usage.agentCallCount).toBe(0);
  });
});
