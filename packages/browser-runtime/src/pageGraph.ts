// PageGraph 一致性守卫：pageId 标识页面、activePageId 指向活跃页、
// state 为 active/background/closed、navigationEpoch 每导航递增（架构文档 8.1）
// — English: PageGraph consistency guard — pageId identifies a page,
//   activePageId points to the active page, state is active/background/closed,
//   and navigationEpoch increments on each navigation (architecture doc 8.1).
// 本模块为纯函数实现，不含任何 DOM / 浏览器实现；即使首期以单活跃页面为主，
// 也通过 pageId 标识页面，为 popup 与多标签页保留正确协议。
import type { PageGraph, PageNode } from '@suanlizi/protocol';

// 一致性检查：返回问题列表（空数组 = 一致）
// — English: consistency check — returns a list of issues (empty array = consistent).
export interface PageGraphIssue {
  code:
    | 'NO_ACTIVE_PAGE'
    | 'MULTIPLE_ACTIVE'
    | 'ACTIVE_NOT_FOUND'
    | 'DUPLICATE_PAGE_ID'
    | 'BAD_EPOCH'
    | 'CLOSED_ACTIVE';
  detail: string;
}

/**
 * 检查 PageGraph 一致性（架构文档 8.1，规则按序）：
 * 1. pages 中 pageId 重复 → DUPLICATE_PAGE_ID；
 * 2. pages 为空且 activePageId 非空 → NO_ACTIVE_PAGE；
 *    pages 为空且 activePageId 为空 → 无问题（初始状态，视为一致）；
 * 3. active 状态页面数量 > 1 → MULTIPLE_ACTIVE；数量 0（pages 非空）→ NO_ACTIVE_PAGE；
 * 4. activePageId 为空或不在 pages → ACTIVE_NOT_FOUND；
 * 5. activePageId 指向的页面 state 为 closed 且未被 NO_ACTIVE_PAGE / MULTIPLE_ACTIVE
 *    覆盖 → CLOSED_ACTIVE（state 为 background 时由 NO_ACTIVE_PAGE / MULTIPLE_ACTIVE
 *    / ACTIVE_NOT_FOUND 覆盖，不单独报告）；
 * 6. 任一页面 navigationEpoch < 0 → BAD_EPOCH（无法检查前后递增，只检查非负）。
 * 每类问题最多报告一次（按序去重）。
 * — English: checks PageGraph consistency (doc 8.1, rules in order) — duplicate
 *   pageId → DUPLICATE_PAGE_ID; empty pages with non-empty activePageId →
 *   NO_ACTIVE_PAGE (empty activePageId → consistent initial state); active count
 *   > 1 → MULTIPLE_ACTIVE, count 0 (non-empty pages) → NO_ACTIVE_PAGE; missing
 *   activePageId → ACTIVE_NOT_FOUND; activePageId pointing to a closed page (not
 *   covered by NO_ACTIVE_PAGE/MULTIPLE_ACTIVE) → CLOSED_ACTIVE; negative
 *   navigationEpoch → BAD_EPOCH. Each code is reported at most once.
 */
export function checkPageGraphConsistency(graph: PageGraph): PageGraphIssue[] {
  const issues: PageGraphIssue[] = [];
  const { activePageId, pages } = graph;

  // 规则 1：pageId 重复 → DUPLICATE_PAGE_ID（最多报告一次）。
  // — English: rule 1 — duplicate pageId → DUPLICATE_PAGE_ID (reported once).
  const seen = new Set<string>();
  for (const page of pages) {
    if (seen.has(page.pageId)) {
      issues.push({
        code: 'DUPLICATE_PAGE_ID',
        detail: `pageId 重复: '${page.pageId}'`,
      });
      break;
    }
    seen.add(page.pageId);
  }

  // 规则 2：pages 为空时的明确分支。
  // 空 pages + 空 activePageId → 无问题（初始状态，视为一致）。
  // — English: rule 2 — explicit branch for empty pages: empty activePageId is a
  //   consistent initial state; non-empty activePageId → NO_ACTIVE_PAGE.
  if (pages.length === 0) {
    if (activePageId !== '') {
      issues.push({
        code: 'NO_ACTIVE_PAGE',
        detail: `图为空但 activePageId 非空: '${activePageId}'`,
      });
    }
    return issues; // 空 pages 无 epoch 可查
  }

  // 规则 3：active 状态页面数量。
  // — English: rule 3 — active page count.
  const activePages = pages.filter((p) => p.state === 'active');
  if (activePages.length === 0) {
    issues.push({
      code: 'NO_ACTIVE_PAGE',
      detail: `pages 非空（${pages.length} 个）但没有 active 页面`,
    });
  } else if (activePages.length > 1) {
    issues.push({
      code: 'MULTIPLE_ACTIVE',
      detail: `存在 ${activePages.length} 个 active 页面: ${activePages
        .map((p) => p.pageId)
        .join(', ')}`,
    });
  }

  // 规则 4：activePageId 为空或不在 pages → ACTIVE_NOT_FOUND。
  // — English: rule 4 — missing/unknown activePageId → ACTIVE_NOT_FOUND.
  const activeTarget =
    activePageId === '' ? undefined : pages.find((p) => p.pageId === activePageId);
  if (activeTarget === undefined) {
    issues.push({
      code: 'ACTIVE_NOT_FOUND',
      detail:
        activePageId === ''
          ? 'activePageId 为空（pages 非空）'
          : `activePageId 指向不存在的页面: '${activePageId}'`,
    });
  } else if (activeTarget.state === 'closed' && activePages.length === 1) {
    // 规则 5：activePageId 指向 closed 页面 → CLOSED_ACTIVE；
    // 已报 NO_ACTIVE_PAGE（activePages.length 0）或 MULTIPLE_ACTIVE（>1）时被覆盖；
    // state 为 background 时同样由上述规则覆盖，不单独报告。
    // — English: rule 5 — activePageId points to a closed page → CLOSED_ACTIVE,
    //   unless already covered by NO_ACTIVE_PAGE or MULTIPLE_ACTIVE.
    issues.push({
      code: 'CLOSED_ACTIVE',
      detail: `activePageId '${activePageId}' 指向的页面已关闭（state=closed）`,
    });
  }

  // 规则 6：navigationEpoch < 0 → BAD_EPOCH（只检查非负，前后递增无法在本层验证）。
  // — English: rule 6 — negative navigationEpoch → BAD_EPOCH (non-negativity only).
  if (pages.some((p) => p.navigationEpoch < 0)) {
    issues.push({
      code: 'BAD_EPOCH',
      detail: '存在 navigationEpoch < 0 的页面',
    });
  }

  return issues;
}

/**
 * 归一化 PageGraph：无操作时也返回副本（不修改原对象）；修正明显矛盾：
 * - activePageId 为空、指向不存在页面或指向非 active 页面 → 设为第一个 active
 *   页面的 pageId；没有 active 页面 → activePageId 置 '' 且 pages 保留；
 * - 多个 active → 保留第一个 active，其余降为 background。
 * — English: normalizes a PageGraph (always returns a copy, never mutates the
 *   input) — a missing/unknown/non-active activePageId is repointed to the first
 *   active page, or cleared when no active page exists; extra active pages are
 *   demoted to background, keeping the first active.
 */
export function normalizePageGraph(graph: PageGraph): PageGraph {
  // 浅拷贝 pages（页面对象也拷贝，避免与输入共享可变引用）。
  // — English: shallow-copies pages (page objects copied too, no shared refs with input).
  const pages: PageNode[] = graph.pages.map((p) => ({ ...p }));

  // 多个 active → 保留第一个，其余降为 background。
  // — English: multiple active pages → keep the first, demote the rest.
  let seenActive = false;
  for (const page of pages) {
    if (page.state === 'active') {
      if (seenActive) {
        page.state = 'background';
      } else {
        seenActive = true;
      }
    }
  }

  const firstActive = pages.find((p) => p.state === 'active');
  const target = pages.find((p) => p.pageId === graph.activePageId);
  let activePageId = graph.activePageId;
  if (firstActive === undefined) {
    // 没有 active 页面 → activePageId 置 ''，pages 保留。
    // — English: no active page → clear activePageId, keep pages.
    activePageId = '';
  } else if (graph.activePageId === '' || target === undefined || target.state !== 'active') {
    // activePageId 缺失 / 指向不存在 / 指向非 active 页面 → 指向第一个 active。
    // — English: missing/unknown/non-active activePageId → point to first active.
    activePageId = firstActive.pageId;
  }

  return { activePageId, pages };
}

/**
 * 页面操作辅助（popup / 多标签页预置）：新页面以 background 状态加入，返回新图。
 * 若 pageId 已存在 → 抛 Error。
 * — English: page-operation helpers (popup / multi-tab preset) — openPage adds a
 *   new page as background and returns a new graph; throws if pageId already exists.
 */
export function openPage(graph: PageGraph, page: PageNode): PageGraph {
  if (graph.pages.some((p) => p.pageId === page.pageId)) {
    throw new Error(`pageId 已存在: '${page.pageId}'`);
  }
  return {
    activePageId: graph.activePageId,
    pages: [...graph.pages, { ...page, state: 'background' as const }],
  };
}

/**
 * 置 active（原 active 降为 background）；若已是 active 则不变（返回新副本）；
 * 页面不存在 → 抛 Error。
 * — English: activatePage makes the page active (previous active demoted to
 *   background); no-op copy if already active; throws if the page does not exist.
 */
export function activatePage(graph: PageGraph, pageId: string): PageGraph {
  const target = graph.pages.find((p) => p.pageId === pageId);
  if (target === undefined) {
    throw new Error(`页面不存在: '${pageId}'`);
  }
  if (target.state === 'active') {
    return { activePageId: graph.activePageId, pages: [...graph.pages] };
  }
  return {
    activePageId: pageId,
    pages: graph.pages.map((p) => {
      if (p.pageId === pageId) return { ...p, state: 'active' as const };
      if (p.state === 'active') return { ...p, state: 'background' as const };
      return p;
    }),
  };
}

/**
 * 置 closed；若关闭的是 active 页且还有其他非 closed 页 → 激活第一个非 closed 页
 * （将其 state 置为 active，保持图一致）；全部 closed → activePageId 置 ''。
 * 页面不存在时按无操作返回新副本（不抛错）。
 * — English: closePage marks the page closed; if the active page is closed and
 *   other non-closed pages exist, the first one becomes active (its state is
 *   promoted to 'active' to keep the graph consistent); all closed →
 *   activePageId cleared. Unknown pageId is a no-op copy (no throw).
 */
export function closePage(graph: PageGraph, pageId: string): PageGraph {
  const pages = graph.pages.map((p) =>
    p.pageId === pageId ? { ...p, state: 'closed' as const } : p,
  );
  if (graph.activePageId !== pageId) {
    return { activePageId: graph.activePageId, pages };
  }
  const firstOpen = pages.find((p) => p.state !== 'closed');
  if (firstOpen === undefined) {
    // 全部 closed → activePageId 置 ''。
    // — English: all closed → clear activePageId.
    return { activePageId: '', pages };
  }
  // 激活第一个非 closed 页：activePageId 指向它，并将其 state 置为 active。
  // — English: activate the first non-closed page: point activePageId at it and
  //   promote its state to 'active'.
  return {
    activePageId: firstOpen.pageId,
    pages: pages.map((p) =>
      p.pageId === firstOpen.pageId && p.state === 'background'
        ? { ...p, state: 'active' as const }
        : p,
    ),
  };
}
