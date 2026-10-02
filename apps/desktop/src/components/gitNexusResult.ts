// GitNexus MCP 结果解析器
// 把 gitnexus MCP 服务器返回的 result.content / structuredContent 转换为统一的图/列表数据结构
import type { ThreadItem } from '../shared/types.js';

// ─── 类型定义 ─────────────────────────────────────────────────────────────────

export interface GitNexusNode {
  id: string;
  label: string;
  kind?: string; // symbol kind: function/class/method/file/process 等
  file?: string;
  line?: number;
  group?: string; // 用于分组着色：'center' | 'caller' | 'callee' | 'process' | 'upstream' | 'downstream' | 'route' | 'handler' | 'consumer' | 'changed' | 'affected'
  depth?: number;
}

export interface GitNexusEdge {
  id: string;
  source: string;
  target: string;
  label?: string;
}

export interface GitNexusRow {
  name: string;
  kind?: string;
  file?: string;
  line?: number;
  score?: number;
  confidence?: number;
}

export interface GitNexusGraphData {
  kind: 'graph' | 'list';
  title: string;
  nodes: GitNexusNode[];
  edges: GitNexusEdge[];
  groups?: Array<{ label: string; count: number }>;
  rows?: GitNexusRow[];
}

// ─── helper 函数 ──────────────────────────────────────────────────────────────

// 生成唯一节点 id，例如 ctx-center-0
function makeId(prefix: string, idx: number): string {
  return `${prefix}-${idx}`;
}

// 转 string，undefined/null 转 ''
function safeString(v: unknown): string {
  if (v === undefined || v === null) return '';
  return String(v);
}

// 截断超长 label（超过 60 字符加 ...）
function truncateLabel(label: string): string {
  if (label.length > 60) return label.slice(0, 60) + '...';
  return label;
}

// 防止重复 id，重复则跳过
function pushNode(nodes: GitNexusNode[], node: GitNexusNode): void {
  if (nodes.some((n) => n.id === node.id)) return;
  nodes.push(node);
}

// 防止重复 source-target
function pushEdge(edges: GitNexusEdge[], edge: GitNexusEdge): void {
  if (edges.some((e) => e.source === edge.source && e.target === edge.target)) return;
  edges.push(edge);
}

// 统计每个 group 的节点数
function buildGroups(nodes: GitNexusNode[]): Array<{ label: string; count: number }> {
  const counts = new Map<string, number>();
  for (const n of nodes) {
    const g = n.group ?? 'default';
    counts.set(g, (counts.get(g) ?? 0) + 1);
  }
  return Array.from(counts.entries()).map(([label, count]) => ({ label, count }));
}

function convertProvidedGraph(source: Record<string, unknown>, fallbackTitle: string): GitNexusGraphData | null {
  if (!Array.isArray(source.nodes)) return null;

  const nodes: GitNexusNode[] = [];
  for (let i = 0; i < source.nodes.length; i++) {
    const raw = source.nodes[i];
    if (!raw || typeof raw !== 'object') continue;
    const node = raw as Record<string, unknown>;
    const id = safeString(node.id) || makeId('provided-node', i);
    const label = safeString(node.label) || safeString(node.name) || safeString(node.symbol) || id;
    const graphNode: GitNexusNode = {
      id,
      label: truncateLabel(label),
      group: safeString(node.group) || 'default',
    };
    const kind = safeString(node.kind);
    if (kind) graphNode.kind = kind;
    const file = safeString(node.file) || safeString(node.path);
    if (file) graphNode.file = file;
    if (typeof node.line === 'number') graphNode.line = node.line;
    if (typeof node.depth === 'number') graphNode.depth = node.depth;
    pushNode(nodes, graphNode);
  }

  if (nodes.length === 0) return null;

  const nodeIds = new Set(nodes.map((node) => node.id));
  const edges: GitNexusEdge[] = [];
  const rawEdges = Array.isArray(source.edges) ? source.edges : [];
  for (let i = 0; i < rawEdges.length; i++) {
    const raw = rawEdges[i];
    if (!raw || typeof raw !== 'object') continue;
    const edge = raw as Record<string, unknown>;
    const sourceId = safeString(edge.source);
    const targetId = safeString(edge.target);
    if (!sourceId || !targetId || !nodeIds.has(sourceId) || !nodeIds.has(targetId)) continue;
    pushEdge(edges, {
      id: safeString(edge.id) || makeId('provided-edge', i),
      source: sourceId,
      target: targetId,
      label: safeString(edge.label) || undefined,
    });
  }

  return {
    kind: 'graph',
    title: safeString(source.title) || fallbackTitle,
    nodes,
    edges,
    groups: buildGroups(nodes),
  };
}

// 从 item.result 提取 source 对象
function extractSource(item: ThreadItem): unknown | null {
  const result = item.result;
  if (!result || typeof result !== 'object') return null;
  const r = result as { content?: unknown; structuredContent?: unknown };
  // 优先 structuredContent
  const sc = r.structuredContent;
  if (sc !== null && sc !== undefined && typeof sc === 'object') {
    return sc;
  }
  // 否则从 content 数组找 { type: 'text', text } 元素，尝试 JSON.parse
  if (Array.isArray(r.content)) {
    for (const c of r.content) {
      if (c && typeof c === 'object') {
        const ce = c as { type?: unknown; text?: unknown };
        if (ce.type === 'text' && typeof ce.text === 'string') {
          try {
            return JSON.parse(ce.text);
          } catch {
            // 解析失败，继续找下一个
          }
        }
      }
    }
  }
  return null;
}

function readRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value === 'string' && value.trim()) {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      return null;
    }
  }
  return null;
}

function extractGitNexusTool(item: ThreadItem): string {
  const tool = item.tool ?? '';
  if (tool !== 'mcp_call_tool') return tool;
  const args = readRecord(item.arguments);
  return typeof args?.tool === 'string' ? args.tool.trim() : '';
}

// ─── 各工具转换函数 ────────────────────────────────────────────────────────────

// context：中心符号 + 调用者/被调用者/进程
function convertContext(source: unknown, _tool: string): GitNexusGraphData | null {
  if (!source || typeof source !== 'object') return null;
  const s = source as Record<string, unknown>;

  // symbol 可能是字符串，也可能是对象 { name, kind, file, line }
  // 真实 GitNexus 返回的 symbol 通常是对象，兼容两种形态
  const symbolRaw = s.symbol;
  let symbolName = '';
  let symbolKind: string | undefined;
  let symbolFile: string | undefined;
  let symbolLine: number | undefined;
  if (typeof symbolRaw === 'string') {
    symbolName = symbolRaw;
    symbolKind = safeString(s.kind) || undefined;
    symbolFile = safeString(s.file) || undefined;
    symbolLine = typeof s.line === 'number' ? s.line : undefined;
  } else if (symbolRaw && typeof symbolRaw === 'object') {
    const so = symbolRaw as Record<string, unknown>;
    symbolName = safeString(so.name) || safeString(so.symbol) || safeString(so.label);
    symbolKind = safeString(so.kind) || undefined;
    symbolFile = safeString(so.file) || safeString(so.path) || undefined;
    symbolLine = typeof so.line === 'number' ? so.line : undefined;
  }
  // 兜底用顶层 name
  if (!symbolName) symbolName = safeString(s.name);
  const providedGraph = convertProvidedGraph(s, symbolName ? `context: ${symbolName}` : 'context');
  if (providedGraph) return providedGraph;
  if (!symbolName) return null;

  const nodes: GitNexusNode[] = [];
  const edges: GitNexusEdge[] = [];

  const centerId = makeId('ctx-center', 0);
  pushNode(nodes, {
    id: centerId,
    label: truncateLabel(symbolName),
    kind: symbolKind,
    file: symbolFile,
    line: symbolLine,
    group: 'center',
  });

  // 左侧 callers（可能是 source.callers 或 source.references.callers）
  let callers: unknown = s.callers;
  if ((!Array.isArray(callers) || callers.length === 0) && s.references && typeof s.references === 'object') {
    callers = (s.references as Record<string, unknown>).callers;
  }
  if (Array.isArray(callers)) {
    callers.forEach((c, i) => {
      if (!c || typeof c !== 'object') return;
      const ce = c as Record<string, unknown>;
      const label = safeString(ce.symbol) || safeString(ce.name) || safeString(ce.label) || `caller${i}`;
      const id = makeId('ctx-caller', i);
      pushNode(nodes, {
        id,
        label: truncateLabel(label),
        kind: safeString(ce.kind) || undefined,
        file: safeString(ce.file) || undefined,
        line: typeof ce.line === 'number' ? ce.line : undefined,
        group: 'caller',
      });
      pushEdge(edges, { id: makeId('ctx-edge-caller', i), source: id, target: centerId });
    });
  }

  // 右侧 callees
  if (Array.isArray(s.callees)) {
    s.callees.forEach((c, i) => {
      if (!c || typeof c !== 'object') return;
      const ce = c as Record<string, unknown>;
      const label = safeString(ce.symbol) || safeString(ce.name) || safeString(ce.label) || `callee${i}`;
      const id = makeId('ctx-callee', i);
      pushNode(nodes, {
        id,
        label: truncateLabel(label),
        kind: safeString(ce.kind) || undefined,
        file: safeString(ce.file) || undefined,
        line: typeof ce.line === 'number' ? ce.line : undefined,
        group: 'callee',
      });
      pushEdge(edges, { id: makeId('ctx-edge-callee', i), source: centerId, target: id });
    });
  }

  // 下方 processes
  if (Array.isArray(s.processes)) {
    s.processes.forEach((p, i) => {
      if (!p || typeof p !== 'object') return;
      const pe = p as Record<string, unknown>;
      const label = safeString(pe.name) || safeString(pe.symbol) || safeString(pe.label) || `process${i}`;
      const id = makeId('ctx-process', i);
      pushNode(nodes, {
        id,
        label: truncateLabel(label),
        kind: 'process',
        file: safeString(pe.file) || undefined,
        line: typeof pe.line === 'number' ? pe.line : undefined,
        group: 'process',
      });
      pushEdge(edges, { id: makeId('ctx-edge-process', i), source: centerId, target: id });
    });
  }

  return {
    kind: 'graph',
    title: `context: ${symbolName}`,
    nodes,
    edges,
    groups: buildGroups(nodes),
  };
}

// impact：中心 root + 上游/下游
function convertImpact(source: unknown, _tool: string): GitNexusGraphData | null {
  if (!source || typeof source !== 'object') return null;
  const s = source as Record<string, unknown>;
  const rootRaw = s.root ?? s.symbol;
  let rootName = '';
  let rootObj: Record<string, unknown> | null = null;
  if (typeof rootRaw === 'string') {
    rootName = rootRaw;
  } else if (rootRaw && typeof rootRaw === 'object') {
    rootObj = rootRaw as Record<string, unknown>;
    rootName = safeString(rootObj.name) || safeString(rootObj.symbol) || safeString(rootObj.label);
  }
  if (!rootName) return null;
  const providedGraph = convertProvidedGraph(s, `impact: ${rootName}`);
  if (providedGraph) return providedGraph;

  const nodes: GitNexusNode[] = [];
  const edges: GitNexusEdge[] = [];

  const rootId = makeId('imp-root', 0);
  pushNode(nodes, {
    id: rootId,
    label: truncateLabel(rootName),
    kind: rootObj ? safeString(rootObj.kind) || undefined : undefined,
    file: rootObj ? safeString(rootObj.file) || undefined : undefined,
    line: rootObj && typeof rootObj.line === 'number' ? rootObj.line : undefined,
    group: 'center',
  });

  // 左侧 upstream
  if (Array.isArray(s.upstream)) {
    s.upstream.forEach((u, i) => {
      if (!u || typeof u !== 'object') return;
      const ue = u as Record<string, unknown>;
      const label = safeString(ue.name) || safeString(ue.symbol) || safeString(ue.label) || `upstream${i}`;
      const id = makeId('imp-upstream', i);
      pushNode(nodes, {
        id,
        label: truncateLabel(label),
        kind: safeString(ue.kind) || undefined,
        file: safeString(ue.file) || undefined,
        line: typeof ue.line === 'number' ? ue.line : undefined,
        group: 'upstream',
        depth: typeof ue.depth === 'number' ? ue.depth : undefined,
      });
      pushEdge(edges, { id: makeId('imp-edge-up', i), source: id, target: rootId });
    });
  }

  // 右侧 downstream
  if (Array.isArray(s.downstream)) {
    s.downstream.forEach((d, i) => {
      if (!d || typeof d !== 'object') return;
      const de = d as Record<string, unknown>;
      const label = safeString(de.name) || safeString(de.symbol) || safeString(de.label) || `downstream${i}`;
      const id = makeId('imp-downstream', i);
      pushNode(nodes, {
        id,
        label: truncateLabel(label),
        kind: safeString(de.kind) || undefined,
        file: safeString(de.file) || undefined,
        line: typeof de.line === 'number' ? de.line : undefined,
        group: 'downstream',
        depth: typeof de.depth === 'number' ? de.depth : undefined,
      });
      pushEdge(edges, { id: makeId('imp-edge-down', i), source: rootId, target: id });
    });
  }

  return {
    kind: 'graph',
    title: `impact: ${rootName}`,
    nodes,
    edges,
    groups: buildGroups(nodes),
  };
}

// trace：路径步骤水平排列
function convertTrace(source: unknown, _tool: string): GitNexusGraphData | null {
  if (!source || typeof source !== 'object') return null;
  const s = source as Record<string, unknown>;
  const steps = Array.isArray(s.path) ? s.path : Array.isArray(s.steps) ? s.steps : null;
  if (!steps || steps.length === 0) return null;

  const nodes: GitNexusNode[] = [];
  const edges: GitNexusEdge[] = [];
  const labels: string[] = [];
  let prevId: string | null = null;

  steps.forEach((step, i) => {
    let label = '';
    let kind: string | undefined;
    let file: string | undefined;
    let line: number | undefined;
    if (typeof step === 'string') {
      label = step;
    } else if (step && typeof step === 'object') {
      const se = step as Record<string, unknown>;
      label =
        safeString(se.name) ||
        safeString(se.symbol) ||
        safeString(se.label) ||
        safeString(se.file) ||
        `step${i}`;
      kind = safeString(se.kind) || undefined;
      file = safeString(se.file) || undefined;
      line = typeof se.line === 'number' ? se.line : undefined;
    } else {
      label = `step${i}`;
    }
    labels.push(label);
    const id = makeId('trace-step', i);
    pushNode(nodes, {
      id,
      label: truncateLabel(label),
      kind,
      file,
      line,
      group: 'route',
    });
    if (prevId) {
      pushEdge(edges, { id: makeId('trace-edge', i), source: prevId, target: id });
    }
    prevId = id;
  });

  const first = labels[0] ?? '';
  const last = labels[labels.length - 1] ?? '';
  const title = first && last && first !== last ? `trace: ${first} -> ${last}` : first ? `trace: ${first}` : 'trace';

  return {
    kind: 'graph',
    title,
    nodes,
    edges,
    groups: buildGroups(nodes),
  };
}

// query：结果列表
function convertQuery(source: unknown, _tool: string): GitNexusGraphData | null {
  if (!source || typeof source !== 'object') return null;
  const s = source as Record<string, unknown>;
  const list = Array.isArray(s.results)
    ? s.results
    : Array.isArray(s.symbols)
      ? s.symbols
      : Array.isArray(s.matches)
        ? s.matches
        : null;
  if (!list || list.length === 0) return null;

  const rows: GitNexusRow[] = [];
  list.forEach((item, i) => {
    if (typeof item === 'string') {
      rows.push({ name: item });
      return;
    }
    if (!item || typeof item !== 'object') return;
    const ie = item as Record<string, unknown>;
    const name = safeString(ie.name) || safeString(ie.symbol) || safeString(ie.label) || `item${i}`;
    const row: GitNexusRow = { name };
    const kind = safeString(ie.kind);
    if (kind) row.kind = kind;
    const file = safeString(ie.file) || safeString(ie.path);
    if (file) row.file = file;
    if (typeof ie.line === 'number') row.line = ie.line;
    if (typeof ie.score === 'number') row.score = ie.score;
    if (typeof ie.confidence === 'number') row.confidence = ie.confidence;
    rows.push(row);
  });

  if (rows.length === 0) return null;

  const query = safeString(s.query) || safeString(s.searchQuery) || safeString(s.search);
  const title = query ? `query: ${query}` : 'query';

  return {
    kind: 'list',
    title,
    nodes: [],
    edges: [],
    rows,
  };
}

// route_map：路由 -> 处理器 -> 消费者 三列布局
function convertRouteMap(source: unknown, _tool: string): GitNexusGraphData | null {
  if (!source || typeof source !== 'object') return null;
  const s = source as Record<string, unknown>;
  const routes = Array.isArray(s.routes) ? s.routes : Array.isArray(s.endpoints) ? s.endpoints : null;
  const handlers = Array.isArray(s.handlers) ? s.handlers : null;
  const consumers = Array.isArray(s.consumers) ? s.consumers : Array.isArray(s.components) ? s.components : null;

  if ((!routes || routes.length === 0) && (!handlers || handlers.length === 0)) return null;

  const nodes: GitNexusNode[] = [];
  const edges: GitNexusEdge[] = [];
  const handlerMap = new Map<string, string>(); // handlerKey -> nodeId

  if (handlers) {
    handlers.forEach((h, i) => {
      if (!h || typeof h !== 'object') return;
      const he = h as Record<string, unknown>;
      const label =
        safeString(he.name) ||
        safeString(he.symbol) ||
        safeString(he.label) ||
        safeString(he.handler) ||
        `handler${i}`;
      const id = makeId('rm-handler', i);
      pushNode(nodes, {
        id,
        label: truncateLabel(label),
        kind: safeString(he.kind) || undefined,
        file: safeString(he.file) || undefined,
        line: typeof he.line === 'number' ? he.line : undefined,
        group: 'handler',
      });
      const key = safeString(he.handler) || safeString(he.name) || safeString(he.id);
      if (key) handlerMap.set(key, id);
    });
  }

  if (routes) {
    routes.forEach((r, i) => {
      if (!r || typeof r !== 'object') return;
      const re = r as Record<string, unknown>;
      const label =
        safeString(re.name) ||
        safeString(re.path) ||
        safeString(re.route) ||
        safeString(re.label) ||
        `route${i}`;
      const id = makeId('rm-route', i);
      pushNode(nodes, {
        id,
        label: truncateLabel(label),
        kind: 'route',
        file: safeString(re.file) || undefined,
        line: typeof re.line === 'number' ? re.line : undefined,
        group: 'route',
      });
      const handlerKey = safeString(re.handler) || safeString(re.handlerName);
      if (handlerKey) {
        const handlerId = handlerMap.get(handlerKey);
        if (handlerId) {
          pushEdge(edges, { id: makeId('rm-edge-rh', i), source: id, target: handlerId });
        }
      }
    });
  }

  if (consumers) {
    consumers.forEach((c, i) => {
      if (!c || typeof c !== 'object') return;
      const ce = c as Record<string, unknown>;
      const label = safeString(ce.name) || safeString(ce.symbol) || safeString(ce.label) || `consumer${i}`;
      const id = makeId('rm-consumer', i);
      pushNode(nodes, {
        id,
        label: truncateLabel(label),
        kind: safeString(ce.kind) || undefined,
        file: safeString(ce.file) || undefined,
        line: typeof ce.line === 'number' ? ce.line : undefined,
        group: 'consumer',
      });
      const handlerKey = safeString(ce.handler) || safeString(ce.handlerName);
      if (handlerKey) {
        const handlerId = handlerMap.get(handlerKey);
        if (handlerId) {
          pushEdge(edges, { id: makeId('rm-edge-hc', i), source: handlerId, target: id });
        }
      }
    });
  }

  return {
    kind: 'graph',
    title: 'route_map',
    nodes,
    edges,
    groups: buildGroups(nodes),
  };
}

// detect_changes：变更文件 -> 受影响符号/进程 两列布局
function convertDetectChanges(source: unknown, _tool: string): GitNexusGraphData | null {
  if (!source || typeof source !== 'object') return null;
  const s = source as Record<string, unknown>;
  const changed = Array.isArray(s.changedFiles) ? s.changedFiles : Array.isArray(s.changes) ? s.changes : null;
  const affected = Array.isArray(s.affectedSymbols)
    ? s.affectedSymbols
    : Array.isArray(s.affectedProcesses)
      ? s.affectedProcesses
      : null;

  if ((!changed || changed.length === 0) && (!affected || affected.length === 0)) return null;

  const nodes: GitNexusNode[] = [];
  const edges: GitNexusEdge[] = [];

  const changedNodes: Array<{ id: string; file?: string; symbol?: string }> = [];

  if (changed) {
    changed.forEach((c, i) => {
      let label = '';
      let file: string | undefined;
      let symbol: string | undefined;
      if (typeof c === 'string') {
        label = c;
        file = c;
      } else if (c && typeof c === 'object') {
        const ce = c as Record<string, unknown>;
        file = safeString(ce.file) || safeString(ce.path) || undefined;
        symbol = safeString(ce.symbol) || safeString(ce.name) || undefined;
        label = file || symbol || safeString(ce.label) || `change${i}`;
      }
      const id = makeId('dc-changed', i);
      pushNode(nodes, {
        id,
        label: truncateLabel(label),
        kind: 'file',
        file,
        group: 'changed',
      });
      changedNodes.push({ id, file, symbol });
    });
  }

  const affectedNodes: Array<{ id: string; file?: string; symbol?: string }> = [];

  if (affected) {
    affected.forEach((a, i) => {
      let label = '';
      let file: string | undefined;
      let symbol: string | undefined;
      if (typeof a === 'string') {
        label = a;
        symbol = a;
      } else if (a && typeof a === 'object') {
        const ae = a as Record<string, unknown>;
        file = safeString(ae.file) || safeString(ae.path) || undefined;
        symbol = safeString(ae.symbol) || safeString(ae.name) || safeString(ae.process) || undefined;
        label = symbol || file || safeString(ae.label) || `affected${i}`;
      }
      const id = makeId('dc-affected', i);
      pushNode(nodes, {
        id,
        label: truncateLabel(label),
        kind: file ? 'file' : 'process',
        file,
        group: 'affected',
      });
      affectedNodes.push({ id, file, symbol });
    });
  }

  // 边：changed -> affected（按 file/symbol 关联，否则全连接）
  let edgeIdx = 0;
  for (const cn of changedNodes) {
    let matched = false;
    for (const an of affectedNodes) {
      const sameFile = cn.file && an.file && cn.file === an.file;
      const sameSymbol = cn.symbol && an.symbol && cn.symbol === an.symbol;
      if (sameFile || sameSymbol) {
        pushEdge(edges, { id: makeId('dc-edge', edgeIdx++), source: cn.id, target: an.id });
        matched = true;
      }
    }
    // 没有关联字段时全连接
    if (!matched && !cn.file && !cn.symbol) {
      for (const an of affectedNodes) {
        pushEdge(edges, { id: makeId('dc-edge', edgeIdx++), source: cn.id, target: an.id });
      }
    }
  }

  return {
    kind: 'graph',
    title: 'detect_changes',
    nodes,
    edges,
    groups: buildGroups(nodes),
  };
}

// ─── 主函数 ────────────────────────────────────────────────────────────────────

export function parseGitNexusResult(item: ThreadItem): GitNexusGraphData | null {
  // 非 mcp_tool_call 或非 gitnexus 服务器，返回 null
  if (item.type !== 'mcp_tool_call' || item.server !== 'gitnexus') return null;

  // 提取 source：优先 structuredContent，否则从 content 数组解析 text
  const source = extractSource(item);
  if (source === null) return null;

  // 根据 tool 分发；Suanlizi 懒加载 MCP 时会通过 mcp_call_tool 包装真实工具名
  const tool = extractGitNexusTool(item);
  switch (tool) {
    case 'context':
      return convertContext(source, tool);
    case 'impact':
      return convertImpact(source, tool);
    case 'trace':
      return convertTrace(source, tool);
    case 'query':
      return convertQuery(source, tool);
    case 'route_map':
      return convertRouteMap(source, tool);
    case 'detect_changes':
      return convertDetectChanges(source, tool);
    default:
      return null;
  }
}
