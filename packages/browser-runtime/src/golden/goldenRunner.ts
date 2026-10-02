// 黄金任务执行器：把脚本化步骤翻译为 BrowserRuntimePort 调用，
// 维护 latestObservation 供断言与 act 引用，失败即中止，取消不吞。
// — English: golden task runner — translates scripted steps into
//   BrowserRuntimePort calls, keeps latestObservation fresh for assertions and
//   acts, aborts on the first failure, and never swallows cancellation.
import type {
  ActionIntent,
  BrowserActionKind,
  Observation,
  Postcondition,
} from '@suanlizi/protocol';
import type { BrowserRuntimePort } from '../port.js';
import type {
  GoldenAssert,
  GoldenStepResult,
  GoldenTask,
  GoldenTaskResult,
} from './goldenTypes.js';

export interface RunGoldenTaskInput {
  taskId?: string;
  signal?: AbortSignal;
}

const BROWSER_ACTION_KINDS: readonly BrowserActionKind[] = [
  'navigate',
  'observe',
  'click',
  'type',
  'select',
  'press',
  'scroll',
  'screenshot',
  'submit',
  'download',
  'wait',
];

// 步骤 act.kind 是自由字符串，必须收窄为协议定义的 BrowserActionKind。
// — English: narrows the free-form step kind into the protocol's BrowserActionKind.
function asBrowserActionKind(kind: string): BrowserActionKind {
  if ((BROWSER_ACTION_KINDS as readonly string[]).includes(kind)) {
    return kind as BrowserActionKind;
  }
  throw new Error(`golden: 未知动作类型 ${kind}`);
}

// 该后置条件意味着页面可能已变化（url_/element_ 前缀）→ act 后需重新观测。
// — English: whether the postcondition implies the page may have changed.
function pageMayHaveChanged(post: Postcondition): boolean {
  return post.kind.startsWith('url_') || post.kind.startsWith('element_');
}

// 把任意抛出的值渲染为 detail 文本；ClassifiedError 形状（带 code）优先。
// — English: renders any thrown value into a detail string (ClassifiedError first).
function describeThrown(err: unknown): string {
  if (err !== null && typeof err === 'object') {
    const e = err as { code?: unknown; message?: unknown };
    if (typeof e.code === 'string') {
      const msg = typeof e.message === 'string' ? e.message : String(err);
      return `[${e.code}] ${msg}`;
    }
  }
  return err instanceof Error ? err.message : String(err);
}

// 求值断言：返回全部失败项；空数组 = 通过。
// — English: evaluates an assertion into failure strings; empty = passed.
function evaluateAssert(assert: GoldenAssert, obs: Observation): string[] {
  const failures: string[] = [];
  if (assert.pageUrlContains !== undefined && !obs.url.includes(assert.pageUrlContains)) {
    failures.push(`url 不含 "${assert.pageUrlContains}"（实际 ${obs.url}）`);
  }
  if (assert.titleContains !== undefined && !obs.title.includes(assert.titleContains)) {
    failures.push(`标题不含 "${assert.titleContains}"（实际 "${obs.title}"）`);
  }
  if (assert.contentContains !== undefined) {
    const text = obs.mainContent.map((b) => b.text).join('\n');
    if (!text.includes(assert.contentContains)) {
      failures.push(`mainContent 不含 "${assert.contentContains}"`);
    }
  }
  if (assert.elementCountAtLeast !== undefined && obs.elements.length < assert.elementCountAtLeast) {
    failures.push(`元素数量 ${obs.elements.length} 少于下限 ${assert.elementCountAtLeast}`);
  }
  if (assert.hasElementText !== undefined) {
    const needle = assert.hasElementText;
    const hit = obs.elements.some((e) => e.text !== undefined && e.text.includes(needle));
    if (!hit) failures.push(`无元素文本包含 "${assert.hasElementText}"`);
  }
  if (assert.hasElementRole !== undefined) {
    const hit = obs.elements.some((e) => e.role === assert.hasElementRole);
    if (!hit) failures.push(`无元素 role 为 "${assert.hasElementRole}"`);
  }
  return failures;
}

// 运行黄金任务：
// 1. runtime.start({ taskId: input.taskId ?? `golden-${task.id}` }) → session。
// 2. 逐步骤执行（navigate / observe / act / assert），act 的 ActionIntent 全部
//    取自 latestObservation；act 后若页面可能变化则重新 observe。
// 3. 任一步 failed → 中止后续步骤，passed=false，failedStepId 记录首败步骤。
// 4. 每步前检查 signal.aborted → 抛 Error('cancelled')（runner 不吞取消）。
// 5. session.close() 由 try/finally 保证。
// — English: runs a golden task — start → scripted steps against the cached
//   latestObservation → abort on first failure → close in finally.
export async function runGoldenTask(
  runtime: BrowserRuntimePort,
  task: GoldenTask,
  input?: RunGoldenTaskInput,
): Promise<GoldenTaskResult> {
  const startedAt = Date.now();
  const taskId = input?.taskId ?? `golden-${task.id}`;
  const session = await runtime.start({ taskId, signal: input?.signal });
  const steps: GoldenStepResult[] = [];
  let latestObservation: Observation | undefined;
  let failedStepId: string | undefined;

  try {
    for (let i = 0; i < task.steps.length; i++) {
      const step = task.steps[i];
      // 每步前检查取消。
      // — English: check cancellation before every step.
      if (input?.signal?.aborted) throw new Error('cancelled');

      let passed = true;
      let detail = '';

      if (step.navigate !== undefined) {
        try {
          await session.navigate({ url: step.navigate.url, signal: input?.signal });
          // navigate 后重新观测，刷新 latestObservation。
          // — English: re-observe after navigate to refresh latestObservation.
          latestObservation = await session.observe({ signal: input?.signal });
          detail = `导航到 ${step.navigate.url}`;
        } catch (err) {
          if (input?.signal?.aborted) throw new Error('cancelled');
          passed = false;
          detail = `导航失败 ${describeThrown(err)}`;
        }
      } else if (step.observe !== undefined) {
        latestObservation = await session.observe({ signal: input?.signal });
        detail = `观测 ${latestObservation.observationId}`;
      } else if (step.act !== undefined) {
        // 防御：act 之前还没有观测时先补一次观测。
        // — English: defensively observe once if no observation exists yet.
        if (latestObservation === undefined) {
          latestObservation = await session.observe({ signal: input?.signal });
        }
        const intent: ActionIntent = {
          actionId: `${task.id}-${step.id}-${i}`,
          taskId: session.taskId,
          pageId: latestObservation.pageId,
          observationId: latestObservation.observationId,
          expectedNavigationEpoch: latestObservation.navigationEpoch,
          kind: asBrowserActionKind(step.act.kind),
          targetRef: step.act.targetRef,
          // 显式 arguments 优先，value 兜底（黄金任务 T6 下载等需要多字段参数）。
          // — English: explicit arguments win; value is the fallback.
          arguments: {
            ...(step.act.arguments ?? {}),
            ...(step.act.value !== undefined ? { value: step.act.value } : {}),
          },
          rationale: step.act.rationale ?? step.description,
          effect: step.act.effect ?? 'local',
          risk: step.act.risk ?? 'low',
          postcondition: step.act.postcondition,
        };
        const result = await session.act({ intent, signal: input?.signal });
        if (result.status === 'committed') {
          detail = `动作 ${intent.kind}${intent.targetRef !== undefined ? ` ${intent.targetRef}` : ''} 已提交`;
          // 页面可能变化（url_/element_ 后置条件）→ 重新观测刷新 latestObservation。
          // — English: page may have changed → re-observe to refresh latestObservation.
          if (pageMayHaveChanged(intent.postcondition)) {
            try {
              latestObservation = await session.observe({ signal: input?.signal });
            } catch {
              // 动作已 committed；刷新观测失败只影响后续步骤的引用，不翻转本步状态。
              // — English: action already committed; a failed refresh only
              //   affects later refs, it does not flip this step.
            }
          }
        } else if (result.status === 'uncertain') {
          passed = false;
          detail = `动作结果 uncertain：${result.reason}`;
        } else {
          // failed：取消类错误向上传播为 cancelled；其余记录错误码。
          // — English: failed — cancellation propagates, other errors are recorded.
          if (result.error.kind === 'cancelled') throw new Error('cancelled');
          passed = false;
          detail = `动作失败 [${result.error.code}] ${result.error.message}`;
        }
      } else if (step.assert !== undefined) {
        // 防御：assert 之前还没有观测时先补一次观测。
        // — English: defensively observe once if no observation exists yet.
        if (latestObservation === undefined) {
          latestObservation = await session.observe({ signal: input?.signal });
        }
        const failures = evaluateAssert(step.assert, latestObservation);
        if (failures.length === 0) {
          detail = '断言通过';
        } else {
          passed = false;
          detail = `断言失败：${failures.join('；')}`;
        }
      } else {
        passed = false;
        detail = '步骤未定义任何动作（navigate/act/observe/assert）';
      }

      steps.push({ id: step.id, status: passed ? 'passed' : 'failed', detail });
      if (!passed) {
        failedStepId = step.id;
        break;
      }
    }
  } finally {
    await session.close('golden-run-finished');
  }

  return {
    taskId: session.taskId,
    passed: failedStepId === undefined,
    steps,
    startedAt,
    finishedAt: Date.now(),
    ...(failedStepId !== undefined ? { failedStepId } : {}),
  };
}
