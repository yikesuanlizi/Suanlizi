import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import type {
  OpsTaskBudgetUsage,
  OpsTaskConclusion,
  OpsTaskEvidence,
  OpsTaskPhase,
  OpsTaskSession,
  OpsTaskState,
  OpsTaskTestRun,
} from '@suanlizi/protocol';
import type { OpsTaskEvent } from '../routes/opsRoute.js';
import { redactSecrets } from '@suanlizi/runtime';

export interface OpsObservation {
  /** Adapter-provided text is immediately redacted before becoming Evidence. */
  content: string;
  source: 'replay' | 'local';
  sourceRef?: string;
  observedAt?: string;
}

export interface OpsObservationAdapter {
  readonly id: string;
  /** Optional hard cancellation hook for adapters that own external resources. */
  cancel?(): void;
  observe(task: OpsTaskSession, signal: AbortSignal): Promise<OpsObservation>;
}

export interface LocalTestScope {
  workspaceRoot: string;
  testId: string;
  args: string[];
  timeoutMs: number;
  maxOutputBytes: number;
}

export interface LocalCommandResult {
  status: 'completed' | 'failed' | 'timed_out' | 'cancelled';
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  truncated: boolean;
  durationMs: number;
  outputBytes: number;
  errorMessage?: string;
}

export interface LocalTestDefinition {
  testId: string;
  label: string;
  description: string;
  scriptRelativePath: string;
  fixedArgs: string[];
  acceptsArgs: false;
}

const LOCAL_TESTS: readonly LocalTestDefinition[] = [
  {
    testId: 'workspace.typecheck',
    label: 'TypeScript typecheck',
    description: 'Run the workspace TypeScript compiler without emitting files.',
    scriptRelativePath: 'node_modules/typescript/bin/tsc',
    fixedArgs: ['--noEmit', '--pretty', 'false'],
    acceptsArgs: false,
  },
  {
    testId: 'workspace.unit',
    label: 'Unit tests',
    description: 'Run the workspace Vitest suite in non-watch mode.',
    scriptRelativePath: 'node_modules/vitest/vitest.mjs',
    fixedArgs: ['run'],
    acceptsArgs: false,
  },
];

export type LocalTestErrorCode =
  | 'OPS_TEST_NOT_FOUND'
  | 'OPS_TEST_ARGUMENTS_INVALID'
  | 'OPS_TEST_NOT_AVAILABLE';

export class LocalTestError extends Error {
  readonly code: LocalTestErrorCode;

  constructor(code: LocalTestErrorCode, message: string) {
    super(message);
    this.name = 'LocalTestError';
    this.code = code;
  }
}

export function listLocalTests(): LocalTestDefinition[] {
  return LOCAL_TESTS.map((definition) => ({ ...definition, fixedArgs: [...definition.fixedArgs] }));
}

export function resolveLocalTest(testId: string, args: string[] = []): LocalTestDefinition {
  const definition = LOCAL_TESTS.find((item) => item.testId === testId);
  if (!definition) throw new LocalTestError('OPS_TEST_NOT_FOUND', `Unknown registered test: ${testId}`);
  if (!Array.isArray(args) || args.length > 0 || args.some((item) => typeof item !== 'string')) {
    throw new LocalTestError(
      'OPS_TEST_ARGUMENTS_INVALID',
      `Test ${testId} does not accept arbitrary arguments`,
    );
  }
  return definition;
}

function isPathInside(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function samePath(left: string, right: string): boolean {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

export function buildLocalTestEnvironment(testId: string): NodeJS.ProcessEnv {
  const allowedKeys = [
    'PATH', 'Path', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR',
    'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'ComSpec', 'PATHEXT',
    'LANG', 'LC_ALL',
  ];
  const environment: NodeJS.ProcessEnv = { SUANLIZI_OPS_TEST: testId };
  for (const key of allowedKeys) {
    const value = process.env[key];
    if (value !== undefined) environment[key] = value;
  }
  return environment;
}

function terminateChildTree(child: import('node:child_process').ChildProcess): void {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    const killer = spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
      shell: false,
      windowsHide: true,
      stdio: 'ignore',
    });
    killer.once('error', () => child.kill());
    return;
  }
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    child.kill();
  }
}

/** Executes only registered workspace tests through a direct child process. */
export class LocalCommandAdapter {
  readonly id = 'local.command';

  async runTest(input: LocalTestScope, signal: AbortSignal): Promise<LocalCommandResult> {
    const startedAt = Date.now();
    const definition = resolveLocalTest(input.testId, input.args);
    const workspaceRoot = path.resolve(input.workspaceRoot);
    const scriptPath = path.resolve(workspaceRoot, definition.scriptRelativePath);
    if (!isPathInside(workspaceRoot, scriptPath)) {
      throw new LocalTestError('OPS_TEST_NOT_AVAILABLE', 'Registered test executable escaped workspace');
    }
    let resolvedWorkspaceRoot = workspaceRoot;
    let resolvedScriptPath = scriptPath;
    try {
      resolvedWorkspaceRoot = await realpath(workspaceRoot);
      if (!samePath(resolvedWorkspaceRoot, workspaceRoot)) {
        throw new Error('workspace root changed through a symlink');
      }
      const workspaceStat = await stat(resolvedWorkspaceRoot);
      if (!workspaceStat.isDirectory()) throw new Error('workspace is not a directory');
      resolvedScriptPath = await realpath(scriptPath);
      if (resolvedScriptPath === resolvedWorkspaceRoot || !isPathInside(resolvedWorkspaceRoot, resolvedScriptPath)) {
        throw new Error('script escaped workspace');
      }
      const scriptStat = await stat(resolvedScriptPath);
      if (!scriptStat.isFile()) throw new Error('not a file');
    } catch {
      throw new LocalTestError(
        'OPS_TEST_NOT_AVAILABLE',
        `Registered test is unavailable in workspace: ${input.testId}`,
      );
    }

    const maxOutputBytes = Math.max(1, Math.min(input.maxOutputBytes, 2 * 1024 * 1024));
    const timeoutMs = Math.max(1, input.timeoutMs);
    if (signal.aborted) {
      return {
        status: 'cancelled',
        exitCode: null,
        stdout: '',
        stderr: '',
        timedOut: false,
        truncated: false,
        durationMs: 0,
        outputBytes: 0,
      };
    }
    return new Promise<LocalCommandResult>((resolve) => {
      let stdout = '';
      let stderr = '';
      let outputBytes = 0;
      let truncated = false;
      let timedOut = false;
      let cancelled = signal.aborted;
      let outputLimitHit = false;
      let settled = false;
      const finish = (result: Omit<LocalCommandResult, 'durationMs'>): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener('abort', abort);
        resolve({ ...result, durationMs: Date.now() - startedAt, outputBytes });
      };
      const append = (target: 'stdout' | 'stderr', chunk: Buffer | string): void => {
        if (settled) return;
        const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
        const remaining = Math.max(0, maxOutputBytes - outputBytes);
        if (Buffer.byteLength(text, 'utf8') > remaining) {
          const truncatedText = Buffer.from(text, 'utf8').subarray(0, remaining).toString('utf8');
          if (target === 'stdout') stdout += truncatedText;
          else stderr += truncatedText;
          outputBytes = maxOutputBytes;
          truncated = true;
          outputLimitHit = true;
          terminateChildTree(child);
          return;
        }
        if (target === 'stdout') stdout += text;
        else stderr += text;
        outputBytes += Buffer.byteLength(text, 'utf8');
      };
      const child = spawn(process.execPath, [resolvedScriptPath, ...definition.fixedArgs], {
        cwd: resolvedWorkspaceRoot,
        shell: false,
        windowsHide: true,
        detached: process.platform !== 'win32',
        env: buildLocalTestEnvironment(input.testId),
      });
      const abort = (): void => {
        cancelled = true;
        terminateChildTree(child);
      };
      const timer = setTimeout(() => {
        timedOut = true;
        terminateChildTree(child);
      }, timeoutMs);
      timer.unref?.();
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
      child.stdout.on('data', (chunk: Buffer | string) => append('stdout', chunk));
      child.stderr.on('data', (chunk: Buffer | string) => append('stderr', chunk));
      child.once('error', (error) => {
        finish({
          status: cancelled ? 'cancelled' : timedOut ? 'timed_out' : 'failed',
          exitCode: null,
          stdout,
          stderr,
          timedOut,
          truncated,
          outputBytes,
          errorMessage: error.message,
        });
      });
      child.once('close', (exitCode) => {
        const status = cancelled
          ? 'cancelled'
          : timedOut
            ? 'timed_out'
            : outputLimitHit
              ? 'failed'
              : exitCode === 0
                ? 'completed'
                : 'failed';
        finish({
          status,
          exitCode,
          stdout,
          stderr,
          timedOut,
          truncated,
          outputBytes,
          errorMessage: outputLimitHit ? 'Test output exceeded the configured limit' : undefined,
        });
      });
    });
  }
}

const DEFAULT_EVIDENCE_TTL_MS = 15 * 60 * 1000;

/** Deterministic adapter used by replay/fixture tests and offline development. */
export class ReplayAdapter implements OpsObservationAdapter {
  readonly id = 'replay';

  constructor(
    private readonly fixtures: Record<string, OpsObservation | string> = {},
  ) {}

  async observe(task: OpsTaskSession, signal: AbortSignal): Promise<OpsObservation> {
    if (signal.aborted) throw new Error('Ops task cancelled');
    const fixture = this.fixtures[task.spec.taskId] ?? this.fixtures[task.spec.environmentId];
    if (typeof fixture === 'string') {
      return { content: fixture, source: 'replay', sourceRef: task.spec.environmentId };
    }
    if (fixture) return { ...fixture, source: 'replay' };
    return {
      content: `Replay observation for ${task.spec.presetId}; no fixture supplied.`,
      source: 'replay',
      sourceRef: task.spec.environmentId,
    };
  }
}

/** Local read-only adapter. It never executes commands or writes to the workspace. */
export class LocalAdapter implements OpsObservationAdapter {
  readonly id = 'local';

  async observe(task: OpsTaskSession, signal: AbortSignal): Promise<OpsObservation> {
    if (signal.aborted) throw new Error('Ops task cancelled');
    const root = task.spec.workspaceRoot;
    const canonicalRoot = await realpath(root);
    if (!samePath(canonicalRoot, root)) throw new Error('Workspace root changed through a symlink');
    const rootStat = await stat(canonicalRoot);
    if (signal.aborted) throw new Error('Ops task cancelled');
    if (!rootStat.isDirectory()) throw new Error(`Workspace root is not a directory: ${root}`);
    const entries = await readdir(canonicalRoot, { withFileTypes: true });
    const names = entries
      .slice(0, 200)
      .map((entry) => `${entry.isDirectory() ? 'dir' : 'file'}:${entry.name}`);
    const suffix = entries.length > names.length ? `\n... ${entries.length - names.length} entries omitted` : '';
    return {
      source: 'local',
      sourceRef: canonicalRoot,
      content: [
        `Workspace: ${canonicalRoot}`,
        `Entries: ${entries.length}`,
        ...names,
      ].join('\n') + suffix,
    };
  }
}

/** Remote adapter boundary. Credentials are intentionally not accepted by this module. */
export class SshAdapter implements OpsObservationAdapter {
  readonly id = 'ssh';

  async observe(task: OpsTaskSession, signal: AbortSignal): Promise<OpsObservation> {
    if (signal.aborted) throw new Error('Ops task cancelled');
    throw new Error(`SSH adapter is not configured for environment ${task.spec.environmentId}`);
  }
}

export interface OpsTaskRunnerHooks {
  tenantId: string;
  taskId: string;
  getTask(): Promise<OpsTaskSession | null>;
  transition(to: OpsTaskState, payload?: Record<string, unknown>): Promise<OpsTaskSession>;
  patch(update: (task: OpsTaskSession) => OpsTaskSession, eventType: OpsTaskEvent['type'], payload?: Record<string, unknown>): Promise<OpsTaskSession>;
  appendEvent(type: OpsTaskEvent['type'], payload?: Record<string, unknown>): Promise<void>;
  /** Re-read the current thread workspace immediately before local execution. */
  assertWorkspaceScope?: (task: OpsTaskSession) => Promise<void>;
  adapter?: OpsObservationAdapter;
  /** Optional AgentLoop bridge. Replay/local execution remains useful when absent. */
  runHarness?: (prompt: string, signal: AbortSignal) => Promise<{ status: string; finalEvaluation?: { summary?: string; blocker?: string } | null; evidenceCount?: number }>;
}

export interface OpsLocalTestRequest {
  testRunId: string;
  testId: string;
  args: string[];
  timeoutMs: number;
}

interface RunnerEntry {
  hooks: OpsTaskRunnerHooks;
  controller: AbortController;
  promise: Promise<void>;
  kind: 'task' | 'test';
  testRunId?: string;
}

function hashContent(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function phasePayload(phase: OpsTaskPhase): Record<string, unknown> {
  return { phase };
}

function isLocalEnvironment(environmentId: string): boolean {
  return environmentId === 'local' || environmentId.startsWith('local:');
}

function cumulativeWallTime(previousWallTimeMs: number, startedAtMs: number): number {
  return previousWallTimeMs + Math.max(0, Date.now() - startedAtMs);
}

function abortable<T>(operation: Promise<T>, signal: AbortSignal, cancelOperation?: () => void): Promise<T> {
  if (signal.aborted) {
    try { cancelOperation?.(); } catch { /* best effort */ }
    return Promise.reject(new Error('Ops task cancelled'));
  }
  return new Promise<T>((resolve, reject) => {
    const handleAbort = (): void => {
      try {
        cancelOperation?.();
      } catch {
        // Cancellation is best effort; the wrapped operation still settles safely.
      }
      cleanup();
      reject(new Error('Ops task cancelled'));
    };
    const cleanup = (): void => signal.removeEventListener('abort', handleAbort);
    signal.addEventListener('abort', handleAbort, { once: true });
    operation.then(
      (value) => { cleanup(); resolve(value); },
      (error) => { cleanup(); reject(error); },
    );
  });
}

/**
 * Small, restart-tolerant execution coordinator for Ops tasks.
 * Persistence is delegated to the route so the runner does not own a second store.
 */
export class OpsTaskRunner {
  /** One FIFO per tenant/task. Main execution and test runs share it. */
  private readonly queues = new Map<string, Promise<void>>();
  private readonly entries = new Map<string, Set<RunnerEntry>>();

  start(hooks: OpsTaskRunnerHooks): void {
    const key = `${hooks.tenantId}:${hooks.taskId}`;
    const existing = [...(this.entries.get(key) ?? [])].find(
      (entry) => entry.kind === 'task' && !entry.controller.signal.aborted,
    );
    if (existing) return;
    this.enqueue(key, { hooks, kind: 'task' }, (signal) => this.execute(hooks, signal));
  }

  cancel(tenantId: string, taskId: string): boolean {
    const entries = this.entries.get(`${tenantId}:${taskId}`);
    if (!entries?.size) return false;
    for (const entry of entries) entry.controller.abort();
    return true;
  }

  startLocalTest(hooks: OpsTaskRunnerHooks, request: OpsLocalTestRequest): void {
    const key = `${hooks.tenantId}:${hooks.taskId}`;
    const existing = [...(this.entries.get(key) ?? [])].find(
      (entry) => entry.kind === 'test' && entry.testRunId === request.testRunId && !entry.controller.signal.aborted,
    );
    if (existing) return;
    this.enqueue(
      key,
      { hooks, kind: 'test', testRunId: request.testRunId },
      (signal) => this.executeLocalTest(hooks, request, signal),
    );
  }

  isRunning(tenantId: string, taskId: string): boolean {
    return (this.entries.get(`${tenantId}:${taskId}`)?.size ?? 0) > 0;
  }

  async wait(tenantId: string, taskId: string): Promise<void> {
    const key = `${tenantId}:${taskId}`;
    while (true) {
      const queue = this.queues.get(key);
      const entries = this.entries.get(key);
      if (!queue && !entries?.size) return;
      const pending = [
        ...(queue ? [queue] : []),
        ...[...(entries ?? [])].map((entry) => entry.promise),
      ];
      if (!pending.length) return;
      await Promise.all(pending);
      if (!this.queues.has(key) && !this.entries.has(key)) return;
    }
  }

  private enqueue(
    key: string,
    details: Omit<RunnerEntry, 'controller' | 'promise'>,
    work: (signal: AbortSignal) => Promise<void>,
  ): void {
    const controller = new AbortController();
    const entry = { ...details, controller, promise: Promise.resolve() } as RunnerEntry;
    const entries = this.entries.get(key) ?? new Set<RunnerEntry>();
    entries.add(entry);
    this.entries.set(key, entries);
    const previous = this.queues.get(key) ?? Promise.resolve();
    const promise = previous
      .catch(() => undefined)
      .then(async () => {
        if (controller.signal.aborted) {
          if (details.kind === 'test' && details.testRunId) {
            await this.cancelQueuedTestRun(details.hooks, details.testRunId);
          }
          return;
        }
        await work(controller.signal);
      })
      .finally(() => {
        entries.delete(entry);
        if (!entries.size && this.entries.get(key) === entries) this.entries.delete(key);
        if (this.queues.get(key) === promise) this.queues.delete(key);
      });
    entry.promise = promise;
    this.queues.set(key, promise);
  }

  private async cancelQueuedTestRun(hooks: OpsTaskRunnerHooks, testRunId: string): Promise<void> {
    const task = await hooks.getTask();
    const testRun = task?.testRuns?.find((item) => item.testRunId === testRunId);
    if (!task || !testRun || (testRun.status !== 'queued' && testRun.status !== 'running')) return;
    await this.finishTestRun(hooks, {
      testRunId,
      testId: testRun.testId,
      args: testRun.args,
      timeoutMs: 0,
    }, {
      status: 'cancelled',
      errorCode: 'OPS_TEST_CANCELLED',
      errorSummary: 'Test execution was cancelled before it started.',
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      durationMs: 0,
      outputBytes: 0,
    });
  }

  private async execute(hooks: OpsTaskRunnerHooks, signal: AbortSignal): Promise<void> {
    const startedAt = Date.now();
    let previousWallTimeMs = 0;
    let deadlineTimedOut = false;
    let deadlineTimer: NodeJS.Timeout | undefined;
    const deadlineController = new AbortController();
    const forwardAbort = (): void => deadlineController.abort();
    signal.addEventListener('abort', forwardAbort, { once: true });
    try {
      let task = await hooks.getTask();
      if (!task || task.state === 'cancelled' || task.state === 'completed' || task.state === 'failed') return;
      previousWallTimeMs = task.budgetUsage?.wallTimeMs ?? 0;
      if (hooks.assertWorkspaceScope && isLocalEnvironment(task.spec.environmentId)) {
        await hooks.assertWorkspaceScope(task);
      }
      if (previousWallTimeMs >= task.spec.budgets.maxWallTimeMs) {
        deadlineTimedOut = true;
        throw new Error('Ops task wall-time budget exceeded before execution resumed');
      }
      const remainingWallTime = Math.max(
        1,
        task.spec.budgets.maxWallTimeMs - previousWallTimeMs,
      );
      deadlineTimer = setTimeout(() => {
        deadlineTimedOut = true;
        deadlineController.abort();
      }, remainingWallTime);
      if (signal.aborted) return;
      if (task.state === 'queued') {
        task = await hooks.transition('running', phasePayload('observe'));
      }
      if (task.state !== 'running' && task.state !== 'verifying') return;

      await hooks.patch((current) => ({
        ...current,
        currentPhase: 'observe',
        checkpointSequence: current.checkpointSequence + 1,
      }), 'ops.task.checkpoint', phasePayload('observe'));
      await hooks.appendEvent('ops.task.phase', phasePayload('observe'));

      const adapter: OpsObservationAdapter = hooks.adapter ?? (
        task.spec.environmentId.startsWith('replay')
          ? new ReplayAdapter()
          : task.spec.environmentId === 'local' || task.spec.environmentId.startsWith('local:')
            ? new LocalAdapter()
            : new SshAdapter()
      );
      if ((task.budgetUsage?.adapterCalls ?? 0) >= task.spec.budgets.maxAdapterCalls) {
        throw new Error('Ops adapter-call budget exceeded');
      }
      const observation = await abortable(
        adapter.observe(task, deadlineController.signal),
        deadlineController.signal,
        () => adapter.cancel?.(),
      );
      if (deadlineController.signal.aborted) throw new Error('Ops task deadline exceeded');
      const redacted = redactSecrets(observation.content, {}, {
        taskId: task.spec.taskId,
        source: { adapterId: adapter.id, path: observation.sourceRef },
        observedAt: observation.observedAt,
      });
      if (!redacted.ok) {
        await hooks.appendEvent('ops.task.evidence_attempt', {
          status: redacted.status,
          reasonCode: redacted.reasonCode,
          attempt: redacted.attempt,
        });
        throw new Error(`Evidence redaction failed: ${redacted.reasonCode}`);
      }
      if (Buffer.byteLength(redacted.redactedContent, 'utf8') > task.spec.budgets.maxOutputBytes) {
        throw new Error('Ops evidence output exceeded maxOutputBytes');
      }
      const observedAt = observation.observedAt ?? new Date().toISOString();
      const observedAtMs = Date.parse(observedAt);
      const expiresAt = new Date(
        (Number.isFinite(observedAtMs) ? observedAtMs : Date.now()) + DEFAULT_EVIDENCE_TTL_MS,
      ).toISOString();
      const evidence: OpsTaskEvidence = {
        id: `evidence_${randomUUID()}`,
        source: observation.source,
        ...(observation.sourceRef ? { sourceRef: observation.sourceRef } : {}),
        status: 'complete',
        contentHash: hashContent(redacted.redactedContent),
        summary: redacted.redactedContent.slice(0, 4000),
        observedAt,
        expiresAt,
        detectorVersion: redacted.metadata.detectorVersion,
        redactionVersion: redacted.metadata.detectorVersion,
      };
      await hooks.appendEvent('ops.task.evidence', evidence as unknown as Record<string, unknown>);
      await hooks.patch((current) => ({
        ...current,
        currentPhase: 'hypothesize',
        evidenceIds: current.evidenceIds.includes(evidence.id)
          ? current.evidenceIds
          : [...current.evidenceIds, evidence.id],
        evidence: [...(current.evidence ?? []).filter((item) => item.id !== evidence.id), evidence],
        budgetUsage: {
          ...(current.budgetUsage ?? emptyBudgetUsage()),
          adapterCalls: (current.budgetUsage?.adapterCalls ?? 0) + 1,
          outputBytes: (current.budgetUsage?.outputBytes ?? 0) + Buffer.byteLength(redacted.redactedContent, 'utf8'),
          wallTimeMs: cumulativeWallTime(previousWallTimeMs, startedAt),
        },
        checkpointSequence: current.checkpointSequence + 1,
      }), 'ops.task.checkpoint', { phase: 'hypothesize', evidenceId: evidence.id });

      const hypothesisId = `hypothesis_${randomUUID()}`;
      await hooks.patch((current) => ({
        ...current,
        currentPhase: 'investigate',
        hypothesisIds: [...current.hypothesisIds, hypothesisId],
        checkpointSequence: current.checkpointSequence + 1,
      }), 'ops.task.checkpoint', { phase: 'investigate', hypothesisId });
      await hooks.appendEvent('ops.task.phase', phasePayload('investigate'));

      let harnessSummary = 'Investigation completed from read-only adapter evidence.';
      if (hooks.runHarness) {
        const result = await abortable(hooks.runHarness(
          [
            `Ops task preset: ${task.spec.presetId}`,
            'Use only the redacted observation below as evidence. Do not write files or execute commands.',
            redacted.redactedContent,
            `Acceptance criteria: ${task.spec.acceptanceCriteria.join('; ') || '(none)'}`,
          ].join('\n\n'),
          deadlineController.signal,
        ), deadlineController.signal);
        if (result.status === 'blocked' || result.status === 'needs_user_input') {
          await hooks.transition('blocked', { phase: 'investigate', blocker: result.finalEvaluation?.blocker });
          return;
        }
        harnessSummary = result.finalEvaluation?.summary?.slice(0, 2000) || `Agent investigation status: ${result.status}`;
      }

      await hooks.patch((current) => ({
        ...current,
        currentPhase: 'verify',
        checkpointSequence: current.checkpointSequence + 1,
      }), 'ops.task.checkpoint', phasePayload('verify'));
      if ((await hooks.getTask())?.state === 'running') {
        task = await hooks.transition('verifying', phasePayload('verify'));
      } else {
        task = await hooks.getTask() ?? task;
      }

      if (hooks.runHarness) {
        const verifyResult = await abortable(hooks.runHarness(
          [
            'Verification phase: check whether the conclusion is supported by the redacted evidence.',
            'Do not execute commands or modify files. Mark blocked if the evidence is insufficient.',
            `Evidence summary:\n${redacted.redactedContent.slice(0, 6000)}`,
            `Acceptance criteria: ${task.spec.acceptanceCriteria.join('; ') || '(none)'}`,
          ].join('\n\n'),
          deadlineController.signal,
        ), deadlineController.signal);
        if (verifyResult.status === 'blocked' || verifyResult.status === 'needs_user_input') {
          await hooks.transition('blocked', { phase: 'verify', blocker: verifyResult.finalEvaluation?.blocker });
          return;
        }
        harnessSummary = verifyResult.finalEvaluation?.summary?.slice(0, 2000) || harnessSummary;
      }
      if (deadlineTimedOut || cumulativeWallTime(previousWallTimeMs, startedAt) > task.spec.budgets.maxWallTimeMs) {
        throw new Error('Ops task wall-time budget exceeded');
      }

      const conclusion: OpsTaskConclusion = {
        summary: harnessSummary,
        claims: [{
          text: '只读观察已完成，结果可由关联 Evidence 复核。',
          status: 'supported',
          evidenceIds: [evidence.id],
          supportLevel: 'medium',
        }],
      };
      await hooks.patch((current) => ({
        ...current,
        currentPhase: 'conclude',
        finalConclusion: conclusion,
        budgetUsage: {
          ...(current.budgetUsage ?? emptyBudgetUsage()),
          wallTimeMs: cumulativeWallTime(previousWallTimeMs, startedAt),
        },
        checkpointSequence: current.checkpointSequence + 1,
      }), 'ops.task.checkpoint', phasePayload('conclude'));
      if ((await hooks.getTask())?.state === 'verifying') {
        await hooks.transition('completed', { phase: 'conclude', evidenceId: evidence.id });
      }
    } catch (error) {
      const task = await hooks.getTask();
      if (!task || task.state === 'completed' || task.state === 'failed') return;
      try {
        const errorCode = deadlineTimedOut
          ? 'OPS_TASK_TIMEOUT'
          : (error && typeof error === 'object' && 'code' in error && (error as { code?: unknown }).code === 'OPS_SCOPE_REQUIRED')
            ? 'OPS_SCOPE_REQUIRED'
            : 'OPS_TASK_EXECUTION_FAILED';
        await hooks.patch((current) => ({
          ...current,
          budgetUsage: {
            ...(current.budgetUsage ?? emptyBudgetUsage()),
            wallTimeMs: Math.max(
              current.budgetUsage?.wallTimeMs ?? 0,
              cumulativeWallTime(previousWallTimeMs, startedAt),
            ),
          },
        }), 'ops.task.checkpoint', {
          reason: deadlineTimedOut ? 'wall_time_deadline_exceeded' : 'execution_settled',
        });
        if (signal.aborted && !deadlineTimedOut) return;
        if (task.state === 'paused' || task.state === 'cancelled') return;
        await hooks.appendEvent('ops.task.failed', {
          code: errorCode,
          message: deadlineTimedOut ? 'Ops task exceeded its wall-time budget.' : error instanceof Error ? error.message : String(error),
        });
        if (task.state === 'queued' || task.state === 'running' || task.state === 'verifying') {
          await hooks.transition('failed', {
            error: errorCode === 'OPS_TASK_TIMEOUT' ? 'OPS_TASK_TIMEOUT' : error instanceof Error ? error.message : String(error),
            errorCode,
          });
        }
      } catch {
        // Preserve the original task failure; persistence errors are observed by the next status read.
      }
    } finally {
      if (deadlineTimer) clearTimeout(deadlineTimer);
      signal.removeEventListener('abort', forwardAbort);
    }
  }

  private async executeLocalTest(
    hooks: OpsTaskRunnerHooks,
    request: OpsLocalTestRequest,
    signal: AbortSignal,
  ): Promise<void> {
    const startedAt = new Date().toISOString();
    const current = await hooks.getTask();
    const testRun = current?.testRuns?.find((item) => item.testRunId === request.testRunId);
    if (!current || !testRun) return;
    // A replayed idempotent request can reach the scheduler after the original
    // run has already finished. Never execute a terminal run twice.
    if (
      testRun.status === 'completed' ||
      testRun.status === 'failed' ||
      testRun.status === 'timed_out' ||
      testRun.status === 'cancelled' ||
      current.state === 'completed' ||
      current.state === 'failed' ||
      current.state === 'cancelled'
    ) {
      await this.cancelQueuedTestRun(hooks, request.testRunId);
      return;
    }
    if (hooks.assertWorkspaceScope && isLocalEnvironment(current.spec.environmentId)) {
      try {
        await hooks.assertWorkspaceScope(current);
      } catch (error) {
        await this.finishTestRun(hooks, request, {
          status: 'cancelled',
          errorCode: 'OPS_SCOPE_REQUIRED',
          errorSummary: error instanceof Error ? error.message : 'Workspace scope changed before test execution.',
          startedAt,
          completedAt: new Date().toISOString(),
          durationMs: 0,
          outputBytes: 0,
        });
        return;
      }
    }
    if (signal.aborted) {
      await this.cancelQueuedTestRun(hooks, request.testRunId);
      return;
    }
    const adapterCalls = current.budgetUsage?.adapterCalls ?? 0;
    const priorOutputBytes = current.budgetUsage?.outputBytes ?? 0;
    const priorWallTimeMs = current.budgetUsage?.wallTimeMs ?? 0;
    if (adapterCalls >= current.spec.budgets.maxAdapterCalls) {
      await this.finishTestRun(hooks, request, {
        status: 'failed',
        errorCode: 'OPS_TEST_BUDGET_EXCEEDED',
        errorSummary: 'Adapter-call budget exhausted before the test started.',
        startedAt,
        completedAt: new Date().toISOString(),
      });
      return;
    }
    if (priorOutputBytes >= current.spec.budgets.maxOutputBytes || priorWallTimeMs >= current.spec.budgets.maxWallTimeMs) {
      await this.finishTestRun(hooks, request, {
        status: 'failed',
        errorCode: 'OPS_TEST_BUDGET_EXCEEDED',
        errorSummary: 'Ops test budget was exhausted before the test started.',
        startedAt,
        completedAt: new Date().toISOString(),
      });
      return;
    }

    await hooks.patch((task) => ({
      ...task,
      testRuns: (task.testRuns ?? []).map((item) => item.testRunId === request.testRunId
        ? { ...item, status: 'running' as const, startedAt }
        : item),
    }), 'ops.task.test.started', { testRunId: request.testRunId, testId: request.testId });

    let result: LocalCommandResult;
    try {
      result = await new LocalCommandAdapter().runTest({
        workspaceRoot: current.spec.workspaceRoot,
        testId: request.testId,
        args: request.args,
        timeoutMs: Math.min(request.timeoutMs, current.spec.budgets.maxWallTimeMs - priorWallTimeMs),
        maxOutputBytes: current.spec.budgets.maxOutputBytes - priorOutputBytes,
      }, signal);
    } catch (error) {
      const code = error instanceof LocalTestError ? error.code : 'OPS_TEST_EXECUTION_FAILED';
      await this.finishTestRun(hooks, request, {
        status: 'failed',
        errorCode: code,
        errorSummary: error instanceof Error ? error.message : String(error),
        startedAt,
        completedAt: new Date().toISOString(),
      });
      return;
    }

    const completedAt = new Date().toISOString();
    if (result.status === 'cancelled') {
      await this.finishTestRun(hooks, request, {
        status: 'cancelled',
        errorCode: 'OPS_TEST_CANCELLED',
        errorSummary: 'Test execution was cancelled.',
        startedAt,
        completedAt,
        durationMs: result.durationMs,
        exitCode: result.exitCode,
        timedOut: result.timedOut,
        truncated: result.truncated,
        outputBytes: result.outputBytes,
      });
      return;
    }

    const output = redactTestOutput(result.stdout, current, request.testRunId);
    const errors = redactTestOutput(result.stderr, current, request.testRunId);
    if (!output.ok || !errors.ok) {
      await hooks.appendEvent('ops.task.evidence_attempt', {
        testRunId: request.testRunId,
        status: 'redaction_failed',
        reasonCode: !output.ok ? output.reasonCode : !errors.ok ? errors.reasonCode : 'unknown',
      });
      await this.finishTestRun(hooks, request, {
        status: 'failed',
        errorCode: 'OPS_TEST_REDACTION_FAILED',
        errorSummary: 'Test output was isolated because it could not be safely redacted.',
        startedAt,
        completedAt,
        durationMs: result.durationMs,
        exitCode: result.exitCode,
        timedOut: result.timedOut,
        truncated: result.truncated,
        outputBytes: result.outputBytes,
      });
      return;
    }

    const status = result.status === 'timed_out'
      ? 'timed_out'
      : result.status === 'failed'
        ? 'failed'
        : 'completed';
    await this.finishTestRun(hooks, request, {
      status,
      errorCode: result.status === 'timed_out'
        ? 'OPS_TEST_TIMEOUT'
        : result.status === 'failed'
          ? 'OPS_TEST_EXECUTION_FAILED'
          : undefined,
      errorSummary: result.errorMessage,
      outputSummary: output.text,
      ...(errors.text ? { errorSummary: errors.text } : {}),
      startedAt,
      completedAt,
      durationMs: result.durationMs,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      truncated: result.truncated,
      outputBytes: result.outputBytes,
    });
  }

  private async finishTestRun(
    hooks: OpsTaskRunnerHooks,
    request: OpsLocalTestRequest,
    patch: Partial<OpsTaskTestRun> & Pick<OpsTaskTestRun, 'status'> & { outputBytes?: number },
  ): Promise<void> {
    const { outputBytes: measuredOutputBytes, ...testRunPatch } = patch;
    const consumesAdapterCall = ![
      'OPS_TEST_BUDGET_EXCEEDED',
      'OPS_TEST_CANCELLED',
      'OPS_SCOPE_REQUIRED',
    ].includes(patch.errorCode ?? '');
    await hooks.patch((task) => ({
      ...task,
      budgetUsage: {
        ...(task.budgetUsage ?? emptyBudgetUsage()),
        adapterCalls: (task.budgetUsage?.adapterCalls ?? 0)
          + (consumesAdapterCall ? 1 : 0),
        outputBytes: (task.budgetUsage?.outputBytes ?? 0)
          + (measuredOutputBytes ?? Buffer.byteLength(patch.outputSummary ?? '', 'utf8')
            + Buffer.byteLength(patch.errorSummary ?? '', 'utf8')),
        wallTimeMs: (task.budgetUsage?.wallTimeMs ?? 0) + (patch.durationMs ?? 0),
      },
      testRuns: (task.testRuns ?? []).map((item) => item.testRunId === request.testRunId
        ? { ...item, ...testRunPatch }
        : item),
    }), 'ops.task.test.completed', {
      testRunId: request.testRunId,
      testId: request.testId,
      status: patch.status,
      ...(patch.errorCode ? { errorCode: patch.errorCode } : {}),
    });
  }
}

type RedactedTestOutput = { ok: true; text: string } | { ok: false; reasonCode: string };

function redactTestOutput(text: string, task: OpsTaskSession, testRunId: string): RedactedTestOutput {
  if (!text) return { ok: true, text: '' };
  const result = redactSecrets(text.slice(0, 12_000), {}, {
    taskId: task.spec.taskId,
    runId: testRunId,
    source: { adapterId: 'local.command', path: task.spec.workspaceRoot },
  });
  return result.ok
    ? { ok: true, text: result.redactedContent }
    : { ok: false, reasonCode: result.reasonCode };
}

function emptyBudgetUsage(): OpsTaskBudgetUsage {
  return { adapterCalls: 0, inputTokens: 0, outputBytes: 0, wallTimeMs: 0 };
}
