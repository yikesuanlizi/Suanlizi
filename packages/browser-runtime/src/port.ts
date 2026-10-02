// 浏览器运行时 Port：隔离 Agent Runtime 与 Playwright/宿主实现
// — English: BrowserRuntimePort — decouples the Agent Runtime from Playwright/host implementations
// 首期为 FakeBrowserRuntime；Phase 1 由 Node Browser Worker（Playwright）实现同一接口。
import type { ActionIntent, ClassifiedError, Observation, PageGraph } from '@suanlizi/protocol';

export type BrowserRuntimeKind = 'fake' | 'playwright' | 'electron' | 'remote';

// 动作验证证据：执行不等于成功，任何动作必须验证后置条件并留下证据。
// — English: action evidence — execution is not success; every action must verify its postcondition.
export interface PostconditionCheck {
  postcondition: string;
  passed: boolean;
  detail?: string;
}

export interface ActionEvidence {
  actionId: string;
  verifiedAt: number;
  checks: PostconditionCheck[];
  observed?: { url: string; title: string; navigationEpoch: number };
  // 外部证据：订单号、提交响应、下载摘要等第三方可核实回执
  // — English: external evidence — order ids, submit responses, download digests
  externalEvidence?: Record<string, string>;
}

// 动作结果三态：committed（已验证）、uncertain（副作用状态不明确，禁止盲目重试）、failed
// — English: three-state action result — committed (verified), uncertain (side effects unclear), failed
export type ActionResult =
  | { status: 'committed'; evidence: ActionEvidence; observation?: Observation }
  | { status: 'uncertain'; reason: string; evidence: ActionEvidence }
  | { status: 'failed'; error: ClassifiedError };

// 单任务独占的浏览器会话句柄。
// — English: per-task exclusive browser session handle.
export interface BrowserSessionHandle {
  readonly sessionId: string;
  readonly taskId: string;
  close(reason?: string): Promise<void>;
  currentPageGraph(): PageGraph;
  observe(input?: { signal?: AbortSignal; pageId?: string }): Promise<Observation>;
  navigate(input: { url: string; signal?: AbortSignal; pageId?: string }): Promise<Observation>;
  act(input: { intent: ActionIntent; signal?: AbortSignal }): Promise<ActionResult>;
}

// 浏览器运行时端口：Runtime 只依赖此接口，不感知 Playwright 细节。
// — English: browser runtime port — the Runtime depends only on this interface.
export interface BrowserRuntimePort {
  readonly kind: BrowserRuntimeKind;
  start(input: { taskId: string; signal?: AbortSignal }): Promise<BrowserSessionHandle>;
}
