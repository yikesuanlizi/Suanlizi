// Workflow 受限脚本运行时（计划 §5.4）。
// 静态校验通过后，脚本在本类构造的受限 API 闭包（agent/pipeline/parallel/phase/log/args）中执行：
// - 并发受 maxConcurrentAgents 信号量约束；
// - 总调用数 / pipeline 条目数 / token 总量 / 总时长受 WorkflowRuntimeLimits 约束；
// - 取消信号穿透到每一次 agent() 调用；
// - 结构化输出按 schema 校验，失败记入 AgentCall 并抛错，可追踪；
// - AgentCall / WorkflowRunRecord 通过 TaskStorePort 持久化（store 注入时）。

import { createHash } from 'node:crypto';
import {
  DEFAULT_WORKFLOW_RUNTIME_LIMITS,
  TaskError,
  type TaskEventName,
  type TaskStorePort,
  type WorkflowAgentCall,
  type WorkflowRuntimeLimits,
  type WorkflowRunRecord,
  type WorkflowUsage,
} from '@suanlizi/protocol';
import { validateStructuredOutput } from './schema.js';
import { validateWorkflowScript, type WorkflowScriptValidationResult } from './validator.js';

/** agent() 的选项（计划 §5.4）。schema 为 JSON Schema 子集。 */
export interface WorkflowAgentOptions {
  schema?: Record<string, unknown>;
  label?: string;
  model?: string;
}

/** 子代理执行器：由外层（API 层 / harness）注入真实模型调用。 */
export interface WorkflowAgentExecutor {
  (input: {
    prompt: string;
    callId: string;
    label?: string;
    model?: string;
    phase: string;
    /** 声明了 schema 时附带传入，执行器负责让子代理产出可解析的结构化输出。 */
    schema?: Record<string, unknown>;
    signal: AbortSignal;
  }): Promise<{ result: unknown; inputTokens: number; outputTokens: number }>;
}

/** 运行时进度事件（runtime 局部类型；协议事件目录见 @suanlizi/protocol TASK_EVENT_NAMES）。 */
export interface WorkflowRuntimeEvent {
  type: 'workflow.phase' | 'workflow.log' | 'workflow.agent_call.updated' | 'workflow.agent_call.terminal';
  runId?: string;
  phase?: string;
  message?: string;
  agentCall?: WorkflowAgentCall;
  timestamp: string;
}

export interface WorkflowScriptRuntimeOptions {
  script: string;
  /** 批准后固化的脚本哈希（P5 用于稳定 agentCallId 与恢复复用）。 */
  scriptHash: string;
  runId?: string;
  taskRunId?: string;
  args?: unknown;
  limits?: Partial<WorkflowRuntimeLimits>;
  executor: WorkflowAgentExecutor;
  signal?: AbortSignal;
  /** 注入后持久化 WorkflowRunRecord / WorkflowAgentCall；省略时仅内存记录。 */
  store?: Pick<TaskStorePort, 'upsertWorkflowRun' | 'getWorkflowRun' | 'recordAgentCall' | 'updateAgentCall' | 'listAgentCalls'>;
  onEvent?: (event: WorkflowRuntimeEvent) => void;
  now?: () => number;
  /**
   * P5 恢复复用：先前运行（同一脚本）的 AgentCall 列表。
   * 稳定 agentCallId 命中且 prior status='completed' 时直接返回保存结果，
   * 不再调用 executor、不增加 usage；否则重跑（§5.5 恢复规则）。
   */
  resumeAgentCalls?: readonly WorkflowAgentCall[];
}

/**
 * §14.5（内存边界）：超过该字节数的 `agent()` 结果不向脚本内联全文，
 * 而是返回 ResultHandle；全文仍随 AgentCall 落库（服务端真相），脚本只能用
 * `readResult(handle, { offset, limit })` 按字偏分页取回文本，不得把大结果展开为整数组。
 */
export const WORKFLOW_RESULT_HANDLE_THRESHOLD_BYTES = 8 * 1024;

/** readResult 单页默认与上限（字符）。 */
export const WORKFLOW_RESULT_PAGE_DEFAULT_CHARS = 4_096;
export const WORKFLOW_RESULT_PAGE_MAX_CHARS = 65_536;

export interface WorkflowResultHandle {
  resultId: string;
  runId: string;
  agentCallId: string;
  hash: string;
  size: number;
  summary: string;
  truncated: true;
}

export interface WorkflowResultPage {
  text: string;
  offset: number;
  limit: number;
  size: number;
  hash: string;
  hasMore: boolean;
}

export interface WorkflowScriptRunResult {
  status: 'completed' | 'failed' | 'cancelled';
  value: unknown;
  usage: WorkflowUsage;
  agentCalls: WorkflowAgentCall[];
  error?: string;
}

/** 结构化输出校验失败：已持久化 failed AgentCall，脚本可捕获或让运行失败。 */
export class WorkflowStructuredOutputError extends Error {
  readonly callId: string;
  constructor(callId: string, message: string) {
    super(message);
    this.name = 'WorkflowStructuredOutputError';
    this.callId = callId;
  }
}

/** 惰性求值：延迟 import acorn 不是目标；这里只是收敛校验入口类型。 */
export type { WorkflowScriptValidationResult };

export class WorkflowScriptRuntime {
  private readonly limits: WorkflowRuntimeLimits;
  private readonly executor: WorkflowAgentExecutor;
  private readonly signal: AbortSignal | undefined;
  private readonly store: WorkflowScriptRuntimeOptions['store'];
  private readonly onEvent: (event: WorkflowRuntimeEvent) => void;
  private readonly now: () => number;
  private readonly scriptHash: string;
  private readonly runId: string;
  private readonly taskRunId: string | undefined;
  private readonly args: unknown;
  private readonly script: string;
  /** 稳定 agentCallId → prior 已完成结果（P5 恢复复用）。 */
  private readonly resumableCalls: Map<string, WorkflowAgentCall>;

  constructor(options: WorkflowScriptRuntimeOptions) {
    this.script = options.script;
    this.scriptHash = options.scriptHash;
    this.runId = options.runId ?? `wfrun_${options.now?.() ?? Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    this.taskRunId = options.taskRunId;
    this.args = options.args;
    this.limits = { ...DEFAULT_WORKFLOW_RUNTIME_LIMITS, ...options.limits };
    this.executor = options.executor;
    this.signal = options.signal;
    this.store = options.store;
    this.onEvent = options.onEvent ?? (() => {});
    this.now = options.now ?? (() => Date.now());
    this.resumableCalls = new Map(
      (options.resumeAgentCalls ?? []).filter((call) => call.status === 'completed').map((call) => [call.id, call]),
    );
  }

  /** 静态校验入口（批准界面 / API 层复用）。 */
  validate(): WorkflowScriptValidationResult {
    return validateWorkflowScript(this.script);
  }

  /** 执行脚本。返回终态结果；脚本抛错 / 取消不向上抛未捕获异常。 */
  async run(): Promise<WorkflowScriptRunResult> {
    const validation = this.validate();
    if (!validation.ok) {
      throw new TaskError(
        'WORKFLOW_SCRIPT_INVALID',
        `Workflow script failed static validation: ${validation.diagnostics.map((d) => `${d.code}:${d.message}`).join('; ')}`,
        { workflowRunId: this.runId, diagnostics: validation.diagnostics },
      );
    }

    const startedAt = this.now();
    const usage: WorkflowUsage = { inputTokens: 0, outputTokens: 0, agentCallCount: 0, durationMs: 0 };
    const agentCalls: WorkflowAgentCall[] = [];
    // 内部控制器：外部 signal 或超时都会触发 abort，从而穿透到子代理。
    const controller = new AbortController();
    const onExternalAbort = () => controller.abort();
    this.signal?.addEventListener('abort', onExternalAbort, { once: true });
    const deadline = startedAt + this.limits.maxDurationMs;
    const timer = setTimeout(() => controller.abort(), Math.max(0, this.limits.maxDurationMs));
    const state = {
      phase: '',
      agentCount: 0,
      tokens: 0,
      activeAgents: 0,
      maxObservedConcurrency: 0,
    };

    try {
      await this.persistRun('running', usage, agentCalls, startedAt);
      const api = this.createApi(controller, state, deadline, agentCalls, usage);
      const body = validation.executableBody!;
      // 静态校验保证：脚本唯一 export 是 `export const meta`（已在 executableBody 中剥离），
      // 顶层 return 在 Function body 中合法；脚本能触达的能力只有下面的受限闭包。
      const fn = new Function(
        'agent', 'pipeline', 'parallel', 'phase', 'log', 'readResult', 'args',
        // 脚本顶层允许 await/return：包一层 async IIFE，且不向脚本暴露 this。
        '"use strict";return (async () => {\n' + body + '\n})();',
      ) as (...api: unknown[]) => Promise<unknown>;
      const value = await fn(
        api.agent,
        api.pipeline,
        api.parallel,
        api.phase,
        api.log,
        api.readResult,
        this.args,
      );
      usage.durationMs = this.now() - startedAt;
      await this.persistRun('completed', usage, agentCalls, startedAt, this.now());
      return {
        status: 'completed',
        value: value === undefined ? null : value,
        usage,
        agentCalls: [...agentCalls],
      };
    } catch (error) {
      usage.durationMs = this.now() - startedAt;
      const aborted = controller.signal.aborted;
      const status: WorkflowScriptRunResult['status'] = aborted ? 'cancelled' : 'failed';
      const message = error instanceof Error ? error.message : String(error);
      await this.persistRun(aborted ? 'cancelled' : 'failed', usage, agentCalls, startedAt, this.now());
      return {
        status,
        value: null,
        usage,
        agentCalls: [...agentCalls],
        error: aborted ? `workflow run cancelled: ${message}` : message,
      };
    } finally {
      clearTimeout(timer);
      this.signal?.removeEventListener('abort', onExternalAbort);
    }
  }

  // ─── 受限 API 构造 ─────────────────────────────────────────────────────────

  private createApi(
    controller: AbortController,
    state: { phase: string; agentCount: number; tokens: number; activeAgents: number; maxObservedConcurrency: number },
    deadline: number,
    agentCalls: WorkflowAgentCall[],
    usage: WorkflowUsage,
  ) {
    const semaphore = new Semaphore(this.limits.maxConcurrentAgents, controller.signal);
    // §14.5：本次运行内可分页取回的结果全文（callId → value），含恢复复用的 prior 调用。
    const resultValues = new Map<string, unknown>();

    const throwIfAborted = (): void => {
      if (controller.signal.aborted) {
        throw new Error('Workflow run aborted.');
      }
      if (this.now() >= deadline) {
        controller.abort();
        throw new TaskError('WORKFLOW_LIMIT_EXCEEDED', `Workflow run exceeded maxDurationMs (${this.limits.maxDurationMs}).`, { limit: 'maxDurationMs', workflowRunId: this.runId });
      }
    };

    const assertTokens = (): void => {
      if (this.limits.maxTotalTokens > 0 && state.tokens > this.limits.maxTotalTokens) {
        throw new TaskError(
          'WORKFLOW_LIMIT_EXCEEDED',
          `Workflow run exceeded maxTotalTokens (${state.tokens} > ${this.limits.maxTotalTokens}).`,
          { limit: 'maxTotalTokens', workflowRunId: this.runId },
        );
      }
    };

    const agent = async (prompt: string, options?: WorkflowAgentOptions): Promise<unknown | null> => {
      throwIfAborted();
      if (typeof prompt !== 'string' || !prompt.trim()) {
        throw new TaskError('WORKFLOW_SCRIPT_INVALID', 'agent(prompt) requires a non-empty prompt string.', { workflowRunId: this.runId });
      }
      if (state.agentCount >= this.limits.maxAgentsPerRun) {
        throw new TaskError(
          'WORKFLOW_LIMIT_EXCEEDED',
          `Workflow run exceeded maxAgentsPerRun (${this.limits.maxAgentsPerRun}).`,
          { limit: 'maxAgentsPerRun', workflowRunId: this.runId },
        );
      }
      state.agentCount += 1;
      // P5：稳定 agentCallId = hash(scriptHash + callIndex + phase + label + prompt + schema)。
      // 脚本与入参不变时跨运行稳定，恢复时据此决定复用或重跑（§5.5）。
      const callId = this.stableCallId(state.agentCount, state.phase, prompt, options);
      const resumed = this.resumableCalls.get(callId);
      if (resumed) {
        // 命中已完成 prior 调用：直接复用保存结果，不调 executor、不增加 usage。
        const reuse: WorkflowAgentCall = { ...resumed, id: callId };
        agentCalls.push(reuse);
        resultValues.set(callId, reuse.result);
        if (reuse.resultHash === undefined) {
          const printed = this.fingerprint(reuse.result);
          reuse.resultHash = printed.hash;
          reuse.resultSize = printed.size;
        }
        this.emit({ type: 'workflow.agent_call.terminal', runId: this.runId, phase: state.phase, agentCall: { ...reuse } });
        await this.persistAgentCall(reuse);
        return this.scriptFacingResult(callId, reuse.result, reuse.resultHash, reuse.resultSize);
      }
      const call: WorkflowAgentCall = {
        id: callId,
        label: options?.label,
        prompt,
        model: options?.model,
        status: 'running',
        inputTokens: 0,
        outputTokens: 0,
        startedAt: new Date(this.now()).toISOString(),
      };
      agentCalls.push(call);
      this.emit({ type: 'workflow.agent_call.updated', runId: this.runId, phase: state.phase, agentCall: { ...call } });
      await this.persistAgentCall(call);

      try {
        await semaphore.acquire();
        throwIfAborted();
        state.activeAgents += 1;
        state.maxObservedConcurrency = Math.max(state.maxObservedConcurrency, state.activeAgents);
        let output: { result: unknown; inputTokens: number; outputTokens: number };
        try {
          output = await this.executor({
            prompt,
            callId,
            label: options?.label,
            model: options?.model,
            phase: state.phase,
            schema: options?.schema,
            signal: controller.signal,
          });
        } finally {
          state.activeAgents -= 1;
          semaphore.release();
        }
        call.inputTokens = output.inputTokens;
        call.outputTokens = output.outputTokens;
        usage.inputTokens += output.inputTokens;
        usage.outputTokens += output.outputTokens;
        usage.agentCallCount += 1;
        state.tokens = usage.inputTokens + usage.outputTokens;
        assertTokens();

        if (options?.schema) {
          const check = validateStructuredOutput(options.schema, output.result);
          if (!check.ok) {
            call.status = 'failed';
            call.error = `structured output validation failed: ${check.error}`;
            call.completedAt = new Date(this.now()).toISOString();
            this.emit({ type: 'workflow.agent_call.terminal', runId: this.runId, phase: state.phase, agentCall: { ...call } });
            await this.persistAgentCall(call);
            throw new WorkflowStructuredOutputError(callId, call.error);
          }
        }
        call.status = 'completed';
        call.result = output.result;
        const printed = this.fingerprint(output.result);
        call.resultHash = printed.hash;
        call.resultSize = printed.size;
        call.completedAt = new Date(this.now()).toISOString();
        resultValues.set(callId, output.result);
        this.emit({ type: 'workflow.agent_call.terminal', runId: this.runId, phase: state.phase, agentCall: { ...call } });
        await this.persistAgentCall(call);
        // §14.5：大结果只向脚本返回句柄，避免无约束全文进入脚本主堆。
        return this.scriptFacingResult(callId, output.result, printed.hash, printed.size, printed.json);
      } catch (error) {
        if (call.status === 'running') {
          const aborted = controller.signal.aborted;
          call.status = aborted ? 'cancelled' : 'failed';
          call.error = error instanceof Error ? error.message : String(error);
          call.completedAt = new Date(this.now()).toISOString();
          this.emit({ type: 'workflow.agent_call.terminal', runId: this.runId, phase: state.phase, agentCall: { ...call } });
          await this.persistAgentCall(call);
        }
        throw error;
      }
    };

    const runBounded = async <R>(
      count: number,
      limitName: 'maxItemsPerPipeline' | 'maxAgentsPerRun',
      worker: (index: number) => R | Promise<R>,
    ): Promise<R[]> => {
      throwIfAborted();
      if (count > this.limits.maxItemsPerPipeline) {
        throw new TaskError(
          'WORKFLOW_LIMIT_EXCEEDED',
          `Workflow ${limitName === 'maxItemsPerPipeline' ? 'pipeline' : 'parallel batch'} exceeded maxItemsPerPipeline (${count} > ${this.limits.maxItemsPerPipeline}).`,
          { limit: 'maxItemsPerPipeline', workflowRunId: this.runId },
        );
      }
      const results = new Array<R>(count);
      let next = 0;
      const runners = Array.from({ length: Math.min(count, this.limits.maxConcurrentAgents) }, async () => {
        while (true) {
          throwIfAborted();
          const index = next;
          next += 1;
          if (index >= count) return;
          results[index] = await worker(index);
        }
      });
      await Promise.all(runners);
      return results;
    };

    const pipeline = async <T, R>(
      items: readonly T[],
      worker: (item: T, index: number) => Promise<R | null>,
    ): Promise<Array<R | null>> => {
      throwIfAborted();
      if (!Array.isArray(items)) {
        throw new TaskError('WORKFLOW_SCRIPT_INVALID', 'pipeline(items, worker) requires an array of items.', { workflowRunId: this.runId });
      }
      return runBounded<R | null>(items.length, 'maxItemsPerPipeline', (index) => worker(items[index], index));
    };

    const parallel = async (tasks: Array<() => Promise<unknown | null>>): Promise<Array<unknown | null>> => {
      throwIfAborted();
      if (!Array.isArray(tasks)) {
        throw new TaskError('WORKFLOW_SCRIPT_INVALID', 'parallel(tasks) requires an array of task factories.', { workflowRunId: this.runId });
      }
      return runBounded(tasks.length, 'maxItemsPerPipeline', (index) => tasks[index]());
    };

    const phase = (title: string): void => {
      if (typeof title !== 'string' || !title.trim()) {
        throw new TaskError('WORKFLOW_SCRIPT_INVALID', 'phase(title) requires a non-empty title string.', { workflowRunId: this.runId });
      }
      state.phase = title;
      this.emit({ type: 'workflow.phase', runId: this.runId, phase: title });
    };

    const log = (message: string): void => {
      this.emit({ type: 'workflow.log', runId: this.runId, phase: state.phase, message: String(message) });
    };

    /**
     * §14.5：分页读回结果全文的切片。只接受本运行内 `agent()` 返回的句柄或 callId；
     * 参数非法（offset < 0 / limit 超出范围）时 fail-closed 抛脚本可诊断错误。
     */
    const readResult = (target: unknown, options?: { offset?: number; limit?: number }): WorkflowResultPage => {
      const callId = resolveResultCallId(target);
      if (!callId || !resultValues.has(callId)) {
        throw new TaskError(
          'WORKFLOW_SCRIPT_INVALID',
          'readResult requires a handle (or call id) returned by agent() in this run.',
          { workflowRunId: this.runId },
        );
      }
      const printed = this.fingerprint(resultValues.get(callId));
      const offset = Number(options?.offset ?? 0);
      const limit = Number(options?.limit ?? WORKFLOW_RESULT_PAGE_DEFAULT_CHARS);
      if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > WORKFLOW_RESULT_PAGE_MAX_CHARS) {
        throw new TaskError(
          'WORKFLOW_SCRIPT_INVALID',
          `readResult options are out of range: offset=${String(options?.offset ?? 0)} limit=${String(options?.limit ?? WORKFLOW_RESULT_PAGE_DEFAULT_CHARS)}.`,
          { workflowRunId: this.runId },
        );
      }
      const text = printed.json.slice(offset, offset + limit);
      return {
        text,
        offset,
        limit,
        size: printed.size,
        hash: printed.hash,
        hasMore: offset + limit < printed.json.length,
      };
    };

    return { agent, pipeline, parallel, phase, log, readResult };
  }

  // ─── 事件与持久化 ──────────────────────────────────────────────────────────

  private emit(event: Omit<WorkflowRuntimeEvent, 'timestamp'>): void {
    this.onEvent({ ...event, timestamp: new Date(this.now()).toISOString() } as WorkflowRuntimeEvent);
  }

  private stableCallId(callIndex: number, phase: string, prompt: string, options?: WorkflowAgentOptions): string {
    const fingerprint = [
      this.scriptHash,
      String(callIndex),
      phase,
      options?.label ?? '',
      prompt,
      options?.schema ? JSON.stringify(options.schema) : '',
    ].join('|');
    return `wac_${createHash('sha256').update(fingerprint).digest('hex').slice(0, 16)}`;
  }

  /** 结果指纹：序列化文本 + sha256 前 16 位 + UTF-8 字节大小。 */
  private fingerprint(value: unknown): { json: string; hash: string; size: number } {
    let json: string;
    try {
      json = JSON.stringify(value) ?? String(value);
    } catch {
      json = String(value);
    }
    return {
      json,
      hash: createHash('sha256').update(json).digest('hex').slice(0, 16),
      size: Buffer.byteLength(json, 'utf8'),
    };
  }

  /**
   * 脚本可见返回值：小结果直返原值；超阈值的只返回句柄（摘要为前缀预览）。
   * hash/size 缺失时用指纹兼容计算（prior 调用未带指纹的情形）。
   */
  private scriptFacingResult(
    callId: string,
    value: unknown,
    hash?: string,
    size?: number,
    json?: string,
  ): unknown {
    let resolvedHash = hash;
    let resolvedSize = size;
    let resolvedJson = json;
    if (resolvedHash === undefined || resolvedSize === undefined) {
      // prior 调用可能未带指纹：此时按需补算，不得假定已有值。
      const printed = this.fingerprint(value);
      resolvedHash = printed.hash;
      resolvedSize = printed.size;
      resolvedJson = printed.json;
    }
    if (resolvedSize <= WORKFLOW_RESULT_HANDLE_THRESHOLD_BYTES) return value;
    if (resolvedJson === undefined) resolvedJson = this.fingerprint(value).json;
    return {
      resultId: `wfr_${this.runId}_${callId}`,
      runId: this.runId,
      agentCallId: callId,
      hash: resolvedHash,
      size: resolvedSize,
      summary: resolvedJson.slice(0, 240),
      truncated: true as const,
    } satisfies WorkflowResultHandle;
  }

  private async persistAgentCall(call: WorkflowAgentCall): Promise<void> {
    if (!this.store) return;
    try {
      const existing = await this.store.getWorkflowRun(this.runId);
      if (existing) {
        try {
          await this.store.updateAgentCall(this.runId, { ...call });
        } catch {
          // 新 run 首次登记（含恢复复用的 prior 调用）：update 不存在时回退 record。
          await this.store.recordAgentCall(this.runId, { ...call });
        }
      } else {
        await this.store.recordAgentCall(this.runId, { ...call });
      }
    } catch {
      // 持久化失败不中断脚本执行；运行记录的 usage 汇总会在终态再落一次。
    }
  }

  private async persistRun(
    status: WorkflowRunRecord['status'],
    usage: WorkflowUsage,
    agentCalls: WorkflowAgentCall[],
    startedAt: number,
    completedAt?: number,
  ): Promise<void> {
    if (!this.store || !this.taskRunId) return;
    try {
      // 先读回现有记录：goalRunId / evidenceId / result 等列的所有权属于 API 服务层，
      // 本运行时只拥有 status/usage/agentCalls/时间戳；直接重建对象会把那些列写空。
      const existing = await this.store.getWorkflowRun(this.runId).catch(() => null);
      const record: WorkflowRunRecord = {
        ...(existing ?? {}),
        id: this.runId,
        taskRunId: this.taskRunId,
        script: this.script,
        scriptHash: this.scriptHash,
        args: this.args,
        status,
        agentCalls: agentCalls.map((call) => ({ ...call })),
        usage: { ...usage },
        startedAt: existing?.startedAt ?? new Date(startedAt).toISOString(),
        updatedAt: new Date(this.now()).toISOString(),
        ...(completedAt !== undefined ? { completedAt: new Date(completedAt).toISOString() } : {}),
      };
      await this.store.upsertWorkflowRun(record);
    } catch {
      // 终态持久化失败不再二次抛出；与 harness settleTerminalState 的容错语义一致。
    }
  }
}

/** 从脚本报回的句柄（或 callId 字符串）解析出 callId；形状不合时返回 null。 */
function resolveResultCallId(target: unknown): string | null {
  if (typeof target === 'string') return target.trim() || null;
  if (!target || typeof target !== 'object' || Array.isArray(target)) return null;
  const agentCallId = (target as { agentCallId?: unknown }).agentCallId;
  return typeof agentCallId === 'string' && agentCallId.trim() ? agentCallId : null;
}

/** 简单计数信号量：并发上限 + abort 快速失败；release 直接把槽位移交给等待者，避免竞态超发。 */
class Semaphore {
  private active = 0;
  private readonly waiters: Array<{ resolve: () => void; reject: (error: Error) => void }> = [];

  constructor(
    private readonly max: number,
    private readonly signal: AbortSignal,
  ) {
  }

  async acquire(): Promise<void> {
    if (this.signal.aborted) throw new Error('Workflow run aborted.');
    if (this.active < this.max) {
      this.active += 1;
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => reject(new Error('Workflow run aborted.'));
      const removeAbort = () => this.signal.removeEventListener('abort', onAbort);
      this.signal.addEventListener('abort', onAbort, { once: true });
      this.waiters.push({
        resolve: () => {
          removeAbort();
          resolve();
        },
        reject: (error) => {
          removeAbort();
          reject(error);
        },
      });
    });
    // 槽位由 release() 直接移交，不再自增。
  }

  release(): void {
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter.resolve();
      return;
    }
    this.active -= 1;
  }
}

export type WorkflowRuntimeProtocolEventName = Extract<
  TaskEventName,
  'workflow.run.created' | 'workflow.run.updated' | 'workflow.run.terminal' | 'workflow.agent_call.updated' | 'workflow.agent_call.terminal'
>;
