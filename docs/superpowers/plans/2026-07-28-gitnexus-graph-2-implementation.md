# GitNexus Graph 2.0 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the GitNexus dependency-dot diagram with a first usable code knowledge map: semantic zoom, hover lens, click pin, and an inspector that explains the selected area.

**Architecture:** Add a pure graph view-model layer that derives clusters, node weights, level-of-detail visibility, hover neighborhoods, and pinned inspector state from existing `ForceGraphData`. Then update the existing Canvas component to draw the knowledge-map layout instead of the three-column DAG by default, while preserving existing public props and node-click behavior.

**Tech Stack:** TypeScript, React, Canvas 2D, Vitest. No new runtime dependency in this phase.

---

### Task 1: Pure GitNexus knowledge graph model

**Files:**
- Create: `apps/web/src/components/gitNexusKnowledgeGraph.ts`
- Create: `apps/desktop/src/components/gitNexusKnowledgeGraph.ts`
- Test: `apps/web/src/components/GitNexusForceGraph.test.ts`
- Test: `apps/desktop/src/components/GitNexusForceGraph.test.ts`

- [ ] **Step 1: Write failing tests for cluster derivation and LOD**

Add tests that import:

```ts
import {
  buildGitNexusKnowledgeGraph,
  computeGitNexusGraphLod,
  computeHoverLens,
} from './gitNexusKnowledgeGraph.js';
```

Test cases:

```ts
it('derives architecture clusters from file paths', () => {
  const graph = buildGitNexusKnowledgeGraph({
    nodes: [
      { id: 'web-main', label: 'main.tsx', group: 'file', file: 'apps/web/src/main.tsx' },
      { id: 'api-runtime', label: 'tenantRuntime.ts', group: 'file', file: 'apps/api/src/runtime/tenantRuntime.ts' },
      { id: 'runtime-agent', label: 'agent.ts', group: 'file', file: 'packages/runtime/src/agent.ts' },
    ],
    edges: [{ id: 'e1', source: 'web-main', target: 'api-runtime', weight: 2 }],
  });

  expect(graph.clusters.map((cluster) => cluster.id)).toEqual(
    expect.arrayContaining(['apps/web', 'apps/api', 'packages/runtime']),
  );
  expect(graph.nodes.find((node) => node.id === 'web-main')?.clusterId).toBe('apps/web');
});

it('uses semantic zoom to reveal more detail as scale increases', () => {
  const graph = buildGitNexusKnowledgeGraph({
    nodes: Array.from({ length: 40 }, (_, index) => ({
      id: `node-${index}`,
      label: `File ${index}`,
      group: 'file',
      file: `packages/runtime/src/file-${index}.ts`,
    })),
    edges: [],
  });

  const overview = computeGitNexusGraphLod(graph, 0.55);
  const detail = computeGitNexusGraphLod(graph, 2.2);

  expect(overview.visibleClusters.length).toBeGreaterThan(0);
  expect(overview.visibleNodes.length).toBeLessThan(detail.visibleNodes.length);
  expect(detail.level).toBe('file');
});

it('computes hover lens neighborhood without mutating layout nodes', () => {
  const graph = buildGitNexusKnowledgeGraph({
    nodes: [
      { id: 'a', label: 'a.ts', group: 'file', file: 'apps/web/a.ts' },
      { id: 'b', label: 'b.ts', group: 'file', file: 'apps/web/b.ts' },
      { id: 'c', label: 'c.ts', group: 'file', file: 'apps/api/c.ts' },
    ],
    edges: [
      { id: 'ab', source: 'a', target: 'b' },
      { id: 'bc', source: 'b', target: 'c' },
    ],
  });

  const lens = computeHoverLens(graph, 'b');

  expect(lens.focusNodeId).toBe('b');
  expect([...lens.visibleNodeIds].sort()).toEqual(['a', 'b', 'c']);
  expect([...lens.visibleEdgeIds].sort()).toEqual(['ab', 'bc']);
});
```

- [ ] **Step 2: Run tests and verify failure**

Run:

```bash
npx vitest run apps/web/src/components/GitNexusForceGraph.test.ts apps/desktop/src/components/GitNexusForceGraph.test.ts
```

Expected: fail because `gitNexusKnowledgeGraph.ts` does not exist.

- [ ] **Step 3: Implement pure model**

Create both web and desktop files with identical code:

```ts
import type { ForceGraphData, ForceGraphEdge, ForceGraphNode } from './GitNexusForceGraph.js';

export type GitNexusGraphLodLevel = 'cluster' | 'summary' | 'file' | 'symbol';

export interface GitNexusKnowledgeNode extends ForceGraphNode {
  clusterId: string;
  weight: number;
  nodeType: 'file' | 'symbol' | 'finding';
  inDegree: number;
  outDegree: number;
}

export interface GitNexusKnowledgeCluster {
  id: string;
  label: string;
  count: number;
  weight: number;
}

export interface GitNexusKnowledgeGraph {
  nodes: GitNexusKnowledgeNode[];
  edges: ForceGraphEdge[];
  clusters: GitNexusKnowledgeCluster[];
}

export interface GitNexusGraphLod {
  level: GitNexusGraphLodLevel;
  visibleNodes: GitNexusKnowledgeNode[];
  visibleClusters: GitNexusKnowledgeCluster[];
  visibleEdges: ForceGraphEdge[];
}

export interface GitNexusHoverLens {
  focusNodeId: string;
  visibleNodeIds: Set<string>;
  visibleEdgeIds: Set<string>;
}

export function buildGitNexusKnowledgeGraph(data: ForceGraphData): GitNexusKnowledgeGraph {
  const inDegree = new Map<string, number>();
  const outDegree = new Map<string, number>();
  for (const node of data.nodes) {
    inDegree.set(node.id, 0);
    outDegree.set(node.id, 0);
  }
  for (const edge of data.edges) {
    outDegree.set(edge.source, (outDegree.get(edge.source) ?? 0) + 1);
    inDegree.set(edge.target, (inDegree.get(edge.target) ?? 0) + 1);
  }
  const nodes = data.nodes.map((node): GitNexusKnowledgeNode => {
    const input = inDegree.get(node.id) ?? 0;
    const output = outDegree.get(node.id) ?? 0;
    return {
      ...node,
      clusterId: clusterIdForNode(node),
      nodeType: node.kind && node.kind !== 'file' ? 'symbol' : 'file',
      inDegree: input,
      outDegree: output,
      weight: Math.max(1, input + output + (node.group === 'center' ? 6 : 0)),
    };
  });
  const clusterMap = new Map<string, GitNexusKnowledgeCluster>();
  for (const node of nodes) {
    const current = clusterMap.get(node.clusterId) ?? {
      id: node.clusterId,
      label: node.clusterId,
      count: 0,
      weight: 0,
    };
    current.count += 1;
    current.weight += node.weight;
    clusterMap.set(node.clusterId, current);
  }
  return {
    nodes,
    edges: data.edges,
    clusters: [...clusterMap.values()].sort((a, b) => b.weight - a.weight || a.id.localeCompare(b.id)),
  };
}

export function computeGitNexusGraphLod(graph: GitNexusKnowledgeGraph, scale: number): GitNexusGraphLod {
  const level: GitNexusGraphLodLevel = scale < 0.8 ? 'cluster' : scale < 1.35 ? 'summary' : scale < 2.6 ? 'file' : 'symbol';
  const maxNodes = level === 'cluster' ? 0 : level === 'summary' ? 24 : level === 'file' ? 120 : 260;
  const visibleNodes = maxNodes === 0
    ? []
    : [...graph.nodes].sort((a, b) => b.weight - a.weight || a.label.localeCompare(b.label)).slice(0, maxNodes);
  const visibleIds = new Set(visibleNodes.map((node) => node.id));
  const visibleEdges = graph.edges.filter((edge) => visibleIds.has(edge.source) && visibleIds.has(edge.target));
  return {
    level,
    visibleNodes,
    visibleClusters: graph.clusters,
    visibleEdges,
  };
}

export function computeHoverLens(graph: GitNexusKnowledgeGraph, focusNodeId: string): GitNexusHoverLens {
  const visibleNodeIds = new Set<string>([focusNodeId]);
  const visibleEdgeIds = new Set<string>();
  for (const edge of graph.edges) {
    if (edge.source === focusNodeId || edge.target === focusNodeId) {
      visibleEdgeIds.add(edge.id);
      visibleNodeIds.add(edge.source);
      visibleNodeIds.add(edge.target);
    }
  }
  return { focusNodeId, visibleNodeIds, visibleEdgeIds };
}

function clusterIdForNode(node: ForceGraphNode): string {
  const path = (node.file ?? '').replace(/\\/g, '/');
  if (path.startsWith('apps/web/')) return 'apps/web';
  if (path.startsWith('apps/desktop/')) return 'apps/desktop';
  if (path.startsWith('apps/api/')) return 'apps/api';
  if (path.startsWith('packages/')) {
    const parts = path.split('/');
    return parts.length >= 2 ? `packages/${parts[1]}` : 'packages';
  }
  if (path.startsWith('docs/')) return 'docs';
  if (path.includes('/test') || path.endsWith('.test.ts') || path.endsWith('.test.tsx')) return 'tests';
  return node.group || '其他';
}
```

- [ ] **Step 4: Run tests and verify pass**

Run the same Vitest command. Expected: pass.

### Task 2: Map layout and hover/pin behavior

**Files:**
- Modify: `apps/web/src/components/GitNexusForceGraph.tsx`
- Modify: `apps/desktop/src/components/GitNexusForceGraph.tsx`
- Test: `apps/web/src/components/GitNexusForceGraph.test.ts`
- Test: `apps/desktop/src/components/GitNexusForceGraph.test.ts`

- [ ] **Step 1: Add failing layout tests**

Add tests for exported pure layout helpers:

```ts
import {
  computeGitNexusMapLayout,
  findNearestGraphNode,
} from './GitNexusForceGraph.js';

it('lays out clusters as large map regions and nodes around their cluster', () => {
  const layout = computeGitNexusMapLayout({
    nodes: [
      { id: 'web', label: 'main.tsx', group: 'file', file: 'apps/web/src/main.tsx' },
      { id: 'api', label: 'server.ts', group: 'file', file: 'apps/api/src/server.ts' },
    ],
    edges: [{ id: 'edge', source: 'web', target: 'api' }],
  }, 900, 520, 1);

  expect(layout.clusters.length).toBe(2);
  expect(layout.nodes.length).toBe(2);
  expect(layout.nodes[0].clusterId).toBeTruthy();
  expect(layout.width).toBeGreaterThanOrEqual(900);
});
```

- [ ] **Step 2: Run tests and verify failure**

Run:

```bash
npx vitest run apps/web/src/components/GitNexusForceGraph.test.ts apps/desktop/src/components/GitNexusForceGraph.test.ts
```

Expected: fail because `computeGitNexusMapLayout` does not exist.

- [ ] **Step 3: Implement map layout**

Add exported map layout types and `computeGitNexusMapLayout()` in both ForceGraph components. It should:

1. Build the knowledge graph.
2. Compute LOD from current scale.
3. Position clusters in a stable ring.
4. Position visible nodes around their cluster center.
5. Return `clusters`, `nodes`, `edges`, `width`, and `height`.

- [ ] **Step 4: Replace DAG draw with map draw**

Inside `GitNexusForceGraph`, use `computeGitNexusMapLayout()` by default. Draw:

1. Dark canvas background.
2. Cluster glow regions.
3. Edges with low opacity.
4. Nodes by type/group.
5. Labels only for clusters and visible high-weight/hover nodes.
6. Hover lens highlight.
7. Pinned node ring.

- [ ] **Step 5: Implement click pin**

Add state:

```ts
const [pinnedNode, setPinnedNode] = useState<LayoutNode | null>(null);
```

Click behavior:

1. Click node: set pinned node and call `onNodeClick`.
2. Click blank canvas: clear pinned node.
3. Hover continues to work when no pinned node exists.

- [ ] **Step 6: Run tests**

Run the same Vitest command. Expected: pass.

### Task 3: Inspector and visual polish

**Files:**
- Modify: `apps/web/src/components/GitNexusForceGraph.tsx`
- Modify: `apps/desktop/src/components/GitNexusForceGraph.tsx`
- Modify: `apps/web/src/styles.css`
- Modify: `apps/desktop/src/styles.css`

- [ ] **Step 1: Add inspector panel in component**

Render an absolutely positioned inspector inside `.gitNexusForceGraphCanvasWrap` when `hoverNode || pinnedNode` exists. Display:

```tsx
<div className="gitNexusGraphInspector">
  <div className="gitNexusGraphInspectorEyebrow">{node.group}</div>
  <strong>{node.label}</strong>
  {node.file ? <span>{node.file}</span> : null}
  <dl>
    <div><dt>入边</dt><dd>{node.inDegree}</dd></div>
    <div><dt>出边</dt><dd>{node.outDegree}</dd></div>
  </dl>
</div>
```

- [ ] **Step 2: Add map UI styles**

Add styles for:

- `.gitNexusForceGraph`
- `.gitNexusForceGraphCanvasWrap`
- `.gitNexusGraphInspector`
- `.gitNexusGraphModePill`

The visual baseline is deep code-map: dark canvas, subtle border, compact labels, no rainbow dot matrix.

- [ ] **Step 3: Manual browser check**

When the user has 5177/5178 running, open the GitNexus result in the in-app browser and verify:

1. Default view is cluster map, not three-column dot matrix.
2. Hovering shows local detail.
3. Wheel zoom reveals more nodes.
4. Clicking pins inspector.
5. Clicking blank clears pin.

### Task 4: Full verification

**Files:**
- No production files.

- [ ] **Step 1: Run targeted tests**

```bash
npx vitest run apps/web/src/components/GitNexusForceGraph.test.ts apps/desktop/src/components/GitNexusForceGraph.test.ts
```

- [ ] **Step 2: Run type and lint**

```bash
npx tsc -b
npm run lint
```

- [ ] **Step 3: Run UI builds**

```bash
npm --workspace @suanlizi/web run build
npm --workspace @suanlizi/desktop run build:ui
```

- [ ] **Step 4: Summarize remaining gaps**

Report:

1. Files changed.
2. Verification results.
3. What remains for a later Graph 2.1: canvas/WebGL, backend graph enrichment, file lifecycle overlays, and full route/test/finding filters.

