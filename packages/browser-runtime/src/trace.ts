// 浏览器 Trace 记录器：把观测/策略/动作执行/验证阶段映射为
// RunTrace observation（category='browser'），由上层 RunTraceSession 落库。
// — English: browser trace recorder — maps observe/policy/execute/verify phases
//   to RunTrace observations (category='browser') persisted by RunTraceSession.
// 本包不依赖 runtime 的 RunTraceSession：只通过 emit 回调发 observation，
// 关联靠 spanId 序列与 payload 中的 actionId/observationId。
// — English: this package does not depend on RunTraceSession — observations are
//   emitted via a callback; correlation uses the spanId sequence plus
//   actionId/observationId in the payload.
import type { RunTraceLevel, RunTraceObservation, RunTracePayloadMap, RunTraceRunKind } from '@suanlizi/protocol';
import { stripSensitiveUrl } from './urlSafe.js';

type BrowserPayload = RunTracePayloadMap['browser'];

export interface BrowserTraceRecorderInput {
  runId: string;
  threadId: string;
  turnId?: string | null;
  runKind: 'turn' | 'control' | 'workflow' | 'subagent';
  emit: (observation: RunTraceObservation) => void;
}

export interface BrowserObservedInput {
  pageId: string;
  observationId: string;
  url: string;
  elementCount: number;
}

export interface BrowserPolicyInput {
  actionId: string;
  actionKind: string;
  outcome: 'allowed' | 'confirm' | 'denied';
  risk?: string;
  effect?: string;
  reason?: string;
}

export interface BrowserActionStartedInput {
  actionId: string;
  actionKind: string;
  risk?: string;
  effect?: string;
}

export interface BrowserActionFinishedInput {
  actionId: string;
  outcome: 'committed' | 'uncertain' | 'failed' | 'cancelled';
  verificationPassed?: boolean;
  errorCode?: string;
  actionKind?: string;
}

// 浏览器 Trace 记录器：每次调用 emit 一条 lifecycle='instant' 的 observation。
// — English: browser trace recorder — one instant observation per call.
export class BrowserTraceRecorder {
  readonly #runId: string;
  readonly #threadId: string;
  readonly #turnId: string | null;
  readonly #runKind: RunTraceRunKind;
  readonly #emit: (observation: RunTraceObservation) => void;
  #sequence = 0;

  constructor(input: BrowserTraceRecorderInput) {
    this.#runId = input.runId;
    this.#threadId = input.threadId;
    this.#turnId = input.turnId ?? null;
    this.#runKind = input.runKind;
    this.#emit = input.emit;
  }

  // 通用发出：spanId 递增；observation 不含 run context（runId/threadId/turnId
  // 由上层 session 在落库时补充）。
  // — English: common emit — spanId increments; observation carries no run
  //   context (the upstream session adds it when persisting).
  #record(name: string, level: RunTraceLevel, payload: BrowserPayload): void {
    this.#emit({
      runKind: this.#runKind,
      spanId: `span:browser:${++this.#sequence}`,
      category: 'browser',
      name,
      lifecycle: 'instant',
      level,
      occurredAt: new Date().toISOString(),
      payload,
    });
  }

  observed(input: BrowserObservedInput): void {
    this.#record('browser.observe', 'info', {
      phase: 'observe',
      pageId: input.pageId,
      observationId: input.observationId,
      url: stripSensitiveUrl(input.url),
      elementCount: input.elementCount,
    });
  }

  policy(input: BrowserPolicyInput): void {
    this.#record('browser.policy', input.outcome === 'denied' ? 'warning' : 'info', {
      phase: 'policy',
      actionId: input.actionId,
      actionKind: input.actionKind,
      outcome: input.outcome,
      risk: input.risk,
      effect: input.effect,
      reason: input.reason,
    });
  }

  actionStarted(input: BrowserActionStartedInput): void {
    this.#record('browser.action', 'info', {
      phase: 'execute',
      actionId: input.actionId,
      actionKind: input.actionKind,
      risk: input.risk,
      effect: input.effect,
    });
  }

  actionFinished(input: BrowserActionFinishedInput): void {
    const level: RunTraceLevel =
      input.outcome === 'uncertain' || input.outcome === 'failed' || input.outcome === 'cancelled' ? 'error' : 'info';
    this.#record('browser.action', level, {
      phase: input.outcome === 'cancelled' ? 'cancel' : 'verify',
      actionId: input.actionId,
      actionKind: input.actionKind,
      outcome: input.outcome,
      verificationPassed: input.verificationPassed,
      errorCode: input.errorCode,
    });
  }
}
