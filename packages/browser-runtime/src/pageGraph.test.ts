// PageGraph 一致性守卫单元测试：覆盖架构文档 8.1 的检查 / 归一化 / 页面操作辅助
// — English: PageGraph consistency guard unit tests — covers the doc 8.1 checks,
//   normalization, and page-operation helpers (open/activate/close).
import { describe, expect, it } from 'vitest';
import type { PageGraph, PageNode } from '@suanlizi/protocol';
import {
  activatePage,
  checkPageGraphConsistency,
  closePage,
  normalizePageGraph,
  openPage,
} from './pageGraph.js';

// 构造最小 PageNode（默认 background、epoch 0）
// — English: builds a minimal PageNode (background, epoch 0 by default).
function makePage(pageId: string, overrides: Partial<PageNode> = {}): PageNode {
  return {
    pageId,
    url: `https://example.com/${pageId}`,
    title: pageId,
    state: 'background',
    navigationEpoch: 0,
    ...overrides,
  };
}

// 取问题 code 列表，便于断言
// — English: extracts the issue codes for assertion.
function codes(graph: PageGraph): string[] {
  return checkPageGraphConsistency(graph).map((i) => i.code);
}

describe('checkPageGraphConsistency 规则 1：一致图', () => {
  it('1 个 active + 1 个 background，activePageId 指向 active → issues 空', () => {
    const graph: PageGraph = {
      activePageId: 'p1',
      pages: [
        makePage('p1', { state: 'active', navigationEpoch: 3 }),
        makePage('p2', { navigationEpoch: 1 }),
      ],
    };
    expect(checkPageGraphConsistency(graph)).toEqual([]);
  });
});

describe('checkPageGraphConsistency 规则 2：多 active', () => {
  it('两个 active 页面 → MULTIPLE_ACTIVE（仅报告一次）', () => {
    const graph: PageGraph = {
      activePageId: 'p1',
      pages: [makePage('p1', { state: 'active' }), makePage('p2', { state: 'active' })],
    };
    const issues = checkPageGraphConsistency(graph);
    expect(issues.map((i) => i.code)).toEqual(['MULTIPLE_ACTIVE']);
    expect(issues.filter((i) => i.code === 'MULTIPLE_ACTIVE')).toHaveLength(1);
    expect(issues[0]!.detail.length).toBeGreaterThan(0);
  });
});

describe('checkPageGraphConsistency 规则 3：activePageId 指向不存在页', () => {
  it('activePageId 不在 pages → ACTIVE_NOT_FOUND', () => {
    const graph: PageGraph = {
      activePageId: 'ghost',
      pages: [makePage('p1', { state: 'active' }), makePage('p2')],
    };
    expect(codes(graph)).toContain('ACTIVE_NOT_FOUND');
  });

  it('pages 非空但 activePageId 为空字符串 → ACTIVE_NOT_FOUND', () => {
    const graph: PageGraph = { activePageId: '', pages: [makePage('p1', { state: 'active' })] };
    expect(codes(graph)).toContain('ACTIVE_NOT_FOUND');
  });
});

describe('checkPageGraphConsistency 规则 4：空图分支', () => {
  it('空 pages + activePageId "" → issues 空（初始状态视为一致）', () => {
    const graph: PageGraph = { activePageId: '', pages: [] };
    expect(checkPageGraphConsistency(graph)).toEqual([]);
  });

  it('空 pages + activePageId 非空 → NO_ACTIVE_PAGE（不报 ACTIVE_NOT_FOUND）', () => {
    const graph: PageGraph = { activePageId: 'ghost', pages: [] };
    const issues = checkPageGraphConsistency(graph);
    expect(issues.map((i) => i.code)).toEqual(['NO_ACTIVE_PAGE']);
  });

  it('pages 非空但无 active 页面 → NO_ACTIVE_PAGE', () => {
    const graph: PageGraph = {
      activePageId: 'p1',
      pages: [makePage('p1'), makePage('p2')],
    };
    expect(codes(graph)).toContain('NO_ACTIVE_PAGE');
  });
});

describe('checkPageGraphConsistency 规则 5：重复 pageId', () => {
  it('pages 中 pageId 重复 → DUPLICATE_PAGE_ID（仅报告一次）', () => {
    const graph: PageGraph = {
      activePageId: 'p1',
      pages: [makePage('p1', { state: 'active' }), makePage('p1'), makePage('p1')],
    };
    const issues = checkPageGraphConsistency(graph);
    expect(issues.filter((i) => i.code === 'DUPLICATE_PAGE_ID')).toHaveLength(1);
    expect(issues[0]!.code).toBe('DUPLICATE_PAGE_ID');
  });
});

describe('checkPageGraphConsistency 规则 6：CLOSED_ACTIVE 与 BAD_EPOCH', () => {
  it('activePageId 指向 closed 页面且恰好 1 个 active → CLOSED_ACTIVE', () => {
    const graph: PageGraph = {
      activePageId: 'p2',
      pages: [makePage('p1', { state: 'active' }), makePage('p2', { state: 'closed' })],
    };
    expect(codes(graph)).toContain('CLOSED_ACTIVE');
  });

  it('唯一页面为 closed 且被 activePageId 指向 → 只报 NO_ACTIVE_PAGE（CLOSED_ACTIVE 被覆盖）', () => {
    const graph: PageGraph = {
      activePageId: 'p1',
      pages: [makePage('p1', { state: 'closed' })],
    };
    const issues = checkPageGraphConsistency(graph);
    expect(issues.map((i) => i.code)).toEqual(['NO_ACTIVE_PAGE']);
  });

  it('多 active 时 activePageId 指向 closed 页 → 只报 MULTIPLE_ACTIVE（CLOSED_ACTIVE 被覆盖）', () => {
    const graph: PageGraph = {
      activePageId: 'p3',
      pages: [
        makePage('p1', { state: 'active' }),
        makePage('p2', { state: 'active' }),
        makePage('p3', { state: 'closed' }),
      ],
    };
    const issues = checkPageGraphConsistency(graph);
    expect(issues.map((i) => i.code)).toEqual(['MULTIPLE_ACTIVE']);
  });

  it('navigationEpoch < 0 → BAD_EPOCH（多个负值也只报告一次）', () => {
    const graph: PageGraph = {
      activePageId: 'p1',
      pages: [
        makePage('p1', { state: 'active', navigationEpoch: -1 }),
        makePage('p2', { navigationEpoch: -2 }),
      ],
    };
    const issues = checkPageGraphConsistency(graph);
    expect(issues.filter((i) => i.code === 'BAD_EPOCH')).toHaveLength(1);
  });

  it('组合问题按序去重：重复 id + 无 active + 坏 epoch 各报告一次', () => {
    const graph: PageGraph = {
      activePageId: '',
      pages: [
        makePage('p1', { state: 'background', navigationEpoch: -1 }),
        makePage('p1', { state: 'background', navigationEpoch: -3 }),
      ],
    };
    const issues = checkPageGraphConsistency(graph);
    expect(issues.map((i) => i.code)).toEqual([
      'DUPLICATE_PAGE_ID',
      'NO_ACTIVE_PAGE',
      'ACTIVE_NOT_FOUND',
      'BAD_EPOCH',
    ]);
  });
});

describe('normalizePageGraph 归一化', () => {
  it('坏 activePageId（指向不存在页面）→ 修正为第一个 active 页', () => {
    const graph: PageGraph = {
      activePageId: 'ghost',
      pages: [makePage('p1', { state: 'active' }), makePage('p2')],
    };
    const out = normalizePageGraph(graph);
    expect(out.activePageId).toBe('p1');
    expect(out.pages.map((p) => p.state)).toEqual(['active', 'background']);
  });

  it('activePageId 指向 background 页面 → 修正为第一个 active 页', () => {
    const graph: PageGraph = {
      activePageId: 'p2',
      pages: [makePage('p1', { state: 'active' }), makePage('p2')],
    };
    expect(normalizePageGraph(graph).activePageId).toBe('p1');
  });

  it('没有 active 页面 → activePageId 置 "" 且 pages 保留', () => {
    const graph: PageGraph = {
      activePageId: 'p1',
      pages: [makePage('p1'), makePage('p2', { state: 'closed' })],
    };
    const out = normalizePageGraph(graph);
    expect(out.activePageId).toBe('');
    expect(out.pages).toHaveLength(2);
  });

  it('多个 active → 保留第一个 active，其余降为 background', () => {
    const graph: PageGraph = {
      activePageId: 'p3',
      pages: [
        makePage('p1', { state: 'active' }),
        makePage('p2', { state: 'active' }),
        makePage('p3', { state: 'active' }),
      ],
    };
    const out = normalizePageGraph(graph);
    expect(out.activePageId).toBe('p1');
    expect(out.pages.map((p) => p.state)).toEqual(['active', 'background', 'background']);
  });

  it('一致图：返回副本且不修改原对象', () => {
    const graph: PageGraph = {
      activePageId: 'p1',
      pages: [makePage('p1', { state: 'active' }), makePage('p2')],
    };
    const out = normalizePageGraph(graph);
    expect(out).not.toBe(graph);
    expect(out.pages).not.toBe(graph.pages);
    expect(out).toEqual(graph);
    expect(graph.activePageId).toBe('p1'); // 原对象未被修改
  });
});

describe('openPage / activatePage / closePage 页面操作', () => {
  it('openPage：新页面以 background 加入，返回新图，原图不变', () => {
    const graph: PageGraph = { activePageId: 'p1', pages: [makePage('p1', { state: 'active' })] };
    const out = openPage(graph, makePage('p2', { state: 'closed' }));
    expect(out.pages).toHaveLength(2);
    expect(out.pages[1]!.state).toBe('background'); // 传入 state 被强制为 background
    expect(out.activePageId).toBe('p1');
    expect(graph.pages).toHaveLength(1);
  });

  it('openPage：pageId 已存在 → 抛 Error', () => {
    const graph: PageGraph = { activePageId: 'p1', pages: [makePage('p1', { state: 'active' })] };
    expect(() => openPage(graph, makePage('p1'))).toThrow();
  });

  it('activatePage：原 active 降为 background，activePageId 更新', () => {
    const graph: PageGraph = {
      activePageId: 'p1',
      pages: [makePage('p1', { state: 'active' }), makePage('p2')],
    };
    const out = activatePage(graph, 'p2');
    expect(out.activePageId).toBe('p2');
    expect(out.pages.map((p) => p.state)).toEqual(['background', 'active']);
    expect(graph.pages[0]!.state).toBe('active'); // 原图不变
  });

  it('activatePage：已是 active → 不变（返回新副本）', () => {
    const graph: PageGraph = {
      activePageId: 'p1',
      pages: [makePage('p1', { state: 'active' }), makePage('p2')],
    };
    const out = activatePage(graph, 'p1');
    expect(out).toEqual(graph);
    expect(out).not.toBe(graph);
  });

  it('activatePage：页面不存在 → 抛 Error', () => {
    const graph: PageGraph = { activePageId: 'p1', pages: [makePage('p1', { state: 'active' })] };
    expect(() => activatePage(graph, 'ghost')).toThrow();
  });

  it('closePage：关闭 background 页 → active 不变', () => {
    const graph: PageGraph = {
      activePageId: 'p1',
      pages: [makePage('p1', { state: 'active' }), makePage('p2')],
    };
    const out = closePage(graph, 'p2');
    expect(out.activePageId).toBe('p1');
    expect(out.pages[1]!.state).toBe('closed');
  });

  it('closePage：关闭 active 页且还有其他非 closed 页 → 激活第一个非 closed 页', () => {
    const graph: PageGraph = {
      activePageId: 'p1',
      pages: [
        makePage('p1', { state: 'active' }),
        makePage('p2'),
        makePage('p3', { state: 'closed' }),
      ],
    };
    const out = closePage(graph, 'p1');
    expect(out.pages[0]!.state).toBe('closed');
    expect(out.activePageId).toBe('p2'); // 第一个非 closed 页
  });

  it('closePage：全部 closed → activePageId 置 ""', () => {
    const graph: PageGraph = {
      activePageId: 'p1',
      pages: [makePage('p1', { state: 'active' }), makePage('p2')],
    };
    const out = closePage(graph, 'p1');
    const out2 = closePage(out, 'p2');
    expect(out2.pages.map((p) => p.state)).toEqual(['closed', 'closed']);
    expect(out2.activePageId).toBe('');
  });

  it('closePage：页面不存在 → 按无操作返回新副本（不抛错）', () => {
    const graph: PageGraph = {
      activePageId: 'p1',
      pages: [makePage('p1', { state: 'active' })],
    };
    const out = closePage(graph, 'ghost');
    expect(out).toEqual(graph);
    expect(out).not.toBe(graph);
  });

  it('open → activate → close 完整流程保持图一致', () => {
    let graph: PageGraph = { activePageId: 'p1', pages: [makePage('p1', { state: 'active' })] };
    graph = openPage(graph, makePage('p2'));
    graph = openPage(graph, makePage('p3'));
    graph = activatePage(graph, 'p2');
    expect(checkPageGraphConsistency(graph)).toEqual([]);
    graph = closePage(graph, 'p2');
    expect(graph.activePageId).toBe('p1');
    expect(checkPageGraphConsistency(graph)).toEqual([]);
  });
});
