// 浏览器任务指标聚合（架构文档 16.2 首期指标）：从 append-only 任务事件流折叠
// 出可观测的质量指标——任务成功率（verificationPassRate）、动作验证通过率、
// 元素引用失效率（staleRefFailures）、平均步骤（totalSteps）、用户接管率
// （approvalsRequested）、预算耗尽率（budgetExceeded）、uncertain 副作用数量
// 与取消/完成延迟（durationMs）。本模块是纯函数：只读事件与可选的调用方错误
// 列表，不做任何 IO；事件中缺失的失败细节（如元素引用失效码）可由调用方通过
// errors 精确补充。
// — English: browser task metrics aggregation (architecture §16.2 Phase-1
//   metrics) — fold the append-only task event stream into observable quality
//   metrics: task success rate (verificationPassRate), action verification
//   pass rate, element-ref failure rate (staleRefFailures), average steps
//   (totalSteps), human takeover rate (approvalsRequested), budget exhaustion
//   rate (budgetExceeded), uncertain side-effect count and
//   completion/cancellation latency (durationMs). Pure functions: read-only
//   over events plus an optional caller-provided error list, no IO; failure
//   details absent from events (e.g. element-ref failure codes) can be
//   supplied precisely via errors.
import type { BrowserTaskEvent, ClassifiedError } from '@suanlizi/protocol';

// 任务级聚合指标（架构文档 16.2 首期指标清单）。
// — English: task-level aggregated metrics (architecture §16.2 Phase-1 list).
export interface BrowserTaskMetrics {
  taskId: string;
  totalSteps: number; // budget.updated 事件的 steps 终值（无则 0）
  committed: number; // action.completed outcome='committed' 数
  uncertain: number; // outcome='uncertain' 数（uncertain 副作用数量）
  failed: number; // outcome='failed' 数
  staleRefFailures: number; // 元素引用失效率：failed 且错误码含 STALE_EPOCH 或 ELEMENT_ 前缀
  verificationPassRate: number; // committed / (committed+uncertain+failed)，分母为 0 时 1
  approvalsRequested: number; // human.requested 事件数（用户接管率分子）
  budgetExceeded: boolean; // 是否存在失败事件含 budget 相关（或调用方传入标志）
  startedAt?: number;
  finishedAt?: number;
  durationMs?: number; // finishedAt - startedAt
}

// 聚合输入：任务事件流（action.completed / human.requested / task.created /
// task.completed / task.cancelled / task.failed / budget.updated 等）与可选的
// 动作失败错误列表（用于精确统计事件无法携带的失败细节，如元素引用失效码）。
// — English: aggregation input — the task event stream plus an optional list
//   of action failure errors for precise counting of details events cannot
//   carry (e.g. element-ref failure codes).
export interface MetricsInput {
  taskId: string;
  events: ReadonlyArray<BrowserTaskEvent>;
  errors?: ReadonlyArray<ClassifiedError>;
}

// 元素引用失效错误码：stale epoch（导航后引用过期）或 ELEMENT_* 前缀。
// — English: element-ref failure code match — stale epoch or ELEMENT_* prefix.
const STALE_REF_CODE_RE = /STALE_EPOCH|ELEMENT_/;

function isStaleRefCode(code: string): boolean {
  return STALE_REF_CODE_RE.test(code);
}

// 保留 3 位小数（toFixed 四舍五入后转回 number）。
// — English: keep 3 decimal places (rounded via toFixed, back to number).
function round3(value: number): number {
  return Number(value.toFixed(3));
}

// 折叠事件流为任务级指标。规则：
// - totalSteps：取最后一个 budget.updated 事件的 usage.steps（无则 0）。
// - committed/uncertain/failed：action.completed 按 outcome 计数。
// - staleRefFailures：task.failed 的 failure.code 匹配 /STALE_EPOCH|ELEMENT_/
//   计数，加上 errors 列表中 code 匹配的计数（两种来源可叠加）。
// - approvalsRequested：human.requested 事件数。
// - budgetExceeded：errors 中存在 kind==='budget'，或 task.failed 的
//   failure.kind==='budget'。
// - startedAt/finishedAt/durationMs：task.created 与
//   task.completed/cancelled/failed 的时间戳解析（无效时间戳忽略）。
// — English: fold the event stream into task-level metrics per the rules
//   above (last budget.updated steps; outcome counts; stale-ref matches from
//   both task.failed events and the errors list; human.requested count;
//   budget kind from errors or task.failed; timestamps parsed from
//   task.created and terminal events, invalid timestamps ignored).
export function aggregateBrowserMetrics(input: MetricsInput): BrowserTaskMetrics {
  const { taskId, events, errors } = input;

  let totalSteps = 0;
  let committed = 0;
  let uncertain = 0;
  let failed = 0;
  let approvalsRequested = 0;
  let staleRefFailures = 0;
  let budgetExceeded = false;
  let startedAt: number | undefined;
  let finishedAt: number | undefined;

  for (const event of events) {
    switch (event.type) {
      case 'budget.updated':
        totalSteps = event.usage.steps;
        break;
      case 'action.completed':
        if (event.outcome === 'committed') committed += 1;
        else if (event.outcome === 'uncertain') uncertain += 1;
        else failed += 1;
        break;
      case 'human.requested':
        approvalsRequested += 1;
        break;
      case 'task.created': {
        // 取第一个 task.created 的创建时间（通常只有一个）。
        // — English: first task.created timestamp (normally one).
        const ts = Date.parse(event.createdAt);
        if (startedAt === undefined && !Number.isNaN(ts)) startedAt = ts;
        break;
      }
      case 'task.completed': {
        const ts = Date.parse(event.completedAt);
        if (!Number.isNaN(ts)) finishedAt = ts;
        break;
      }
      case 'task.cancelled': {
        const ts = Date.parse(event.cancelledAt);
        if (!Number.isNaN(ts)) finishedAt = ts;
        break;
      }
      case 'task.failed': {
        if (isStaleRefCode(event.failure.code)) staleRefFailures += 1;
        if (event.failure.kind === 'budget') budgetExceeded = true;
        const ts = Date.parse(event.failedAt);
        if (!Number.isNaN(ts)) finishedAt = ts;
        break;
      }
      default:
        break;
    }
  }

  // 调用方错误列表：精确补充元素引用失效与预算耗尽统计。
  // — English: caller-provided error list for precise stale-ref/budget stats.
  if (errors) {
    for (const error of errors) {
      if (isStaleRefCode(error.code)) staleRefFailures += 1;
      if (error.kind === 'budget') budgetExceeded = true;
    }
  }

  const judged = committed + uncertain + failed;
  const verificationPassRate = judged === 0 ? 1 : round3(committed / judged);
  const durationMs =
    startedAt !== undefined && finishedAt !== undefined ? finishedAt - startedAt : undefined;

  return {
    taskId,
    totalSteps,
    committed,
    uncertain,
    failed,
    staleRefFailures,
    verificationPassRate,
    approvalsRequested,
    budgetExceeded,
    startedAt,
    finishedAt,
    durationMs,
  };
}
