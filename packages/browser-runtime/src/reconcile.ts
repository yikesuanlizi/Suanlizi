// 副作用对账：崩溃恢复时先处理 executing/uncertain 记录（架构文档 10.2）
// — English: side-effect reconciliation — on crash recovery, executing/uncertain
//   records are reconciled first (architecture doc 10.2)
// 原则：能证明已执行 → reconciled；能证明未执行且仍安全 → 允许重试；
// 无法判断 → 挂起请求用户处理；绝不盲目重试。
// 本模块只做纯函数决策，不含任何 DOM / 网络实现。
import type { ActionRecord, Postcondition } from '@suanlizi/protocol';

// 对账裁决：已执行 / 未执行（可安全重试）/ 仍无法判断
// — English: reconciliation verdict — executed / not executed (safe to retry) / still uncertain.
export type ReconcileVerdict = 'reconciled' | 'not_executed' | 'still_uncertain';

export interface ReconcileEvidence {
  // 外部证据：订单号、提交响应回执、下载摘要等第三方可核实信息
  // — English: external evidence — order no., submission receipt, download digest, etc.
  external?: Array<{ type: string; value: string }>;
  // 页面状态检查（对账时对当前页面的查询结果）
  // — English: page state check (queried on the current page during reconciliation).
  page?: {
    url?: string;
    successMarker?: boolean; // 页面出现明确成功提示
    successText?: string; // 页面文本包含成功标志（如 '下单成功'）
    formStillEditable?: boolean; // 表单仍可编辑（提交未生效的迹象）
  };
}

export interface ReconcileInput {
  record: ActionRecord; // 状态为 'executing' | 'uncertain'（其他状态直接按现状处理）
  evidence?: ReconcileEvidence;
}

export interface ReconcileResult {
  verdict: ReconcileVerdict;
  detail: string; // 用户可读说明
  retrySafe: boolean; // 只有 verdict==='not_executed' 时才 true
}

// 页面 URL 是否满足后置条件的 url_contains / url_equals。
// — English: whether the page URL satisfies the postcondition's url_contains/url_equals.
function urlMatchesPostcondition(pageUrl: string | undefined, post: Postcondition): boolean {
  if (pageUrl === undefined || pageUrl === '') return false;
  switch (post.kind) {
    case 'url_contains':
      return pageUrl.includes(post.value);
    case 'url_equals':
      return pageUrl === post.value;
    default:
      // 其他后置条件（element / navigation / download 等）无法用 URL 判定。
      // — English: other postconditions (element / navigation / download) can't be judged by URL.
      return false;
  }
}

/**
 * 对账裁决（架构文档 10.2，规则按序）：
 * 1. 非 executing/uncertain → 按现状处理（committed 视为已执行）。
 * 2. 外部证据存在 → reconciled（有业务回执证明已执行）。
 * 3. 页面证据：外部副作用有成功迹象 → reconciled；表单仍可编辑 → not_executed；
 *    local/none 且表单仍可编辑或 URL 未变化 → not_executed；否则 still_uncertain。
 * 4. 无任何证据 → still_uncertain（挂起请求用户处理）。
 * — English: reconciliation verdict (doc 10.2, rules in order) — 1. non-pending
 *   status handled as-is; 2. external evidence → reconciled; 3. page evidence
 *   success → reconciled, editable form → not_executed, local/none with unchanged
 *   URL → not_executed, otherwise still_uncertain; 4. no evidence → still_uncertain.
 */
export function reconcileAction(input: ReconcileInput): ReconcileResult {
  const { record, evidence } = input;
  const page = evidence?.page;

  // 规则 1：只对账 executing / uncertain，其他状态直接按现状返回。
  // — English: rule 1 — only executing/uncertain are reconciled; others returned as-is.
  if (record.status !== 'executing' && record.status !== 'uncertain') {
    return {
      verdict: record.status === 'committed' ? 'reconciled' : 'still_uncertain',
      detail: '非待对账状态',
      retrySafe: false,
    };
  }

  // 规则 2：外部证据（订单号、提交回执等第三方可核实信息）→ 已执行。
  // — English: rule 2 — external business receipt proves execution.
  const external = evidence?.external;
  if (external !== undefined && external.length > 0 && external.some((x) => x.value.trim() !== '')) {
    return { verdict: 'reconciled', detail: '外部证据（业务回执）证明已执行', retrySafe: false };
  }

  // 成功迹象：明确成功标记、页面成功文案、或 URL 满足后置条件。
  // — English: success signals — explicit success marker, success text, or URL matching postcondition.
  const hasSuccess =
    page?.successMarker === true ||
    (page?.successText !== undefined && page.successText.trim() !== '') ||
    urlMatchesPostcondition(page?.url, record.expectedPostcondition);

  const externalEffect =
    record.effect === 'external_reversible' || record.effect === 'external_irreversible';

  // 规则 3a：外部副作用（外部世界可能已生效）——绝不盲目重试。
  // — English: rule 3a — external side effects (may have taken effect) — never blindly retry.
  if (externalEffect) {
    if (hasSuccess) {
      return { verdict: 'reconciled', detail: '页面出现成功迹象，证明已执行', retrySafe: false };
    }
    if (page?.formStillEditable === true) {
      return { verdict: 'not_executed', detail: '表单仍可编辑，提交未生效，可安全重试', retrySafe: true };
    }
    return { verdict: 'still_uncertain', detail: '页面状态无法确认，挂起请求用户处理', retrySafe: false };
  }

  // 规则 3b：local / none 无外部副作用——页面未变化或表单仍可编辑即可安全重试。
  // — English: rule 3b — local/none carry no external side effect — safe to retry
  //   when the page is unchanged or the form is still editable.
  if (record.effect === 'local' || record.effect === 'none') {
    if (hasSuccess) {
      return { verdict: 'reconciled', detail: '页面出现成功迹象，证明已执行', retrySafe: false };
    }
    const urlUnchanged = page?.url !== undefined && page.url !== '' && page.url === record.preState.url;
    if (page?.formStillEditable === true || urlUnchanged) {
      return { verdict: 'not_executed', detail: '页面无副作用迹象，未执行，可安全重试', retrySafe: true };
    }
    return { verdict: 'still_uncertain', detail: '页面状态无法确认，挂起请求用户处理', retrySafe: false };
  }

  // 规则 4：无任何证据 → 挂起请求用户处理（未知 effect 值运行期防御）。
  // — English: rule 4 — no evidence → suspend and ask the user (runtime defense for unknown effect).
  return { verdict: 'still_uncertain', detail: '无证据可判定，挂起请求用户处理', retrySafe: false };
}
