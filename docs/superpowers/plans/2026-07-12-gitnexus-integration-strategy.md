# GitNexus Integration Strategy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make GitNexus a first-class code-intelligence subsystem in Suanlizi: the UI should query a stable service layer, the Agent should use MCP tools for structured analysis, and CLI/npx should remain the indexing and maintenance path.

**Architecture:** Split responsibilities into three layers. `gitnexus serve` becomes the primary query/runtime layer for Suanlizi UI and backend APIs. MCP remains the Agent-facing structured tool layer. CLI/npx remains the maintenance and indexing layer, invoked through Suanlizi-managed jobs rather than directly by the model.

**Tech Stack:** TypeScript, Node.js, existing Suanlizi API routes, existing MCP runtime manager, existing React/Web/Desktop UI, vitest, Vite.

---

### Task 1: Lock the runtime contract and fallback order

**Files:**
- Modify: `apps/api/src/routes/gitnexusRoute.ts`
- Modify: `apps/api/src/runtime/tenantRuntime.ts`
- Modify: `apps/api/src/server.ts`
- Test: `apps/api/src/routes/gitnexusRoute.test.ts`
- Test: `apps/api/src/runtime/tenantRuntime.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';

describe('GitNexus runtime contract', () => {
  it('prefers serve/http data when available and only falls back to MCP when the service is unavailable', async () => {
    // Arrange a stub tenant runtime that reports a healthy GitNexus serve endpoint.
    // The route should query serve first and never call the MCP fallback in this case.
    expect(true).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- gitnexusRoute tenantRuntime`
Expected: FAIL because the runtime contract is not implemented yet.

- [ ] **Step 3: Write minimal implementation**

```ts
// In apps/api/src/runtime/tenantRuntime.ts
export interface GitNexusRuntime {
  getBaseUrl(tenantContext: TenantContext): Promise<string | null>;
  getStatus(tenantContext: TenantContext): Promise<{ ok: boolean; ready: boolean; reason?: string }>;
}

// In apps/api/src/routes/gitnexusRoute.ts
// Route order:
// 1. Use serve HTTP if reachable.
// 2. Fall back to MCP structured tools.
// 3. If neither is available, return a clear error payload that preserves repo/status hints.
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- gitnexusRoute tenantRuntime`
Expected: PASS with the new contract covered.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/gitnexusRoute.ts apps/api/src/runtime/tenantRuntime.ts apps/api/src/server.ts apps/api/src/routes/gitnexusRoute.test.ts apps/api/src/runtime/tenantRuntime.test.ts
git commit -m "feat: define GitNexus runtime fallback contract"
```

### Task 2: Add a Suanlizi-managed GitNexus serve service

**Files:**
- Create: `apps/api/src/services/gitNexusService.ts`
- Modify: `apps/api/src/runtime/tenantRuntime.ts`
- Modify: `apps/api/src/server.ts`
- Test: `apps/api/src/services/gitNexusService.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { createGitNexusService } from './gitNexusService.js';

describe('gitnexus service manager', () => {
  it('tracks serve URL, health, and repo indexing state per tenant', async () => {
    const service = createGitNexusService({});
    const status = await service.getStatus({ tenantId: 'default' });
    expect(status.ok).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- gitNexusService`
Expected: FAIL because the service manager does not exist yet.

- [ ] **Step 3: Write minimal implementation**

```ts
export interface GitNexusService {
  getStatus(tenant: { tenantId: string }): Promise<{ ok: boolean; ready: boolean; serveUrl?: string; repoCount?: number }>;
  ensureServe(tenant: { tenantId: string }): Promise<{ serveUrl: string }>;
  analyzeRepo(tenant: { tenantId: string }, repoPath: string): Promise<{ started: boolean }>;
  stopTenant(tenantId: string): Promise<void>;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- gitNexusService`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/gitNexusService.ts apps/api/src/services/gitNexusService.test.ts apps/api/src/runtime/tenantRuntime.ts apps/api/src/server.ts
git commit -m "feat: add GitNexus service manager"
```

### Task 3: Convert `/api/gitnexus/*` into a stable service-backed API

**Files:**
- Modify: `apps/api/src/routes/gitnexusRoute.ts`
- Modify: `apps/api/src/routes/gitnexusRoute.test.ts`
- Modify: `apps/api/src/shared/http.ts` if a helper is needed for consistent error payloads

- [ ] **Step 1: Write the failing test**

```ts
it('returns file context graph from serve-backed HTTP when the repo is indexed', async () => {
  // The API should return nodes/edges/title/groups in a stable graph payload.
  expect(true).toBe(false);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- gitnexusRoute`
Expected: FAIL before serve-backed routing exists.

- [ ] **Step 3: Write minimal implementation**

```ts
// Route behavior:
// - GET /api/gitnexus/status -> serve health + indexed repo metadata
// - GET /api/gitnexus/repos -> list indexed repos from serve
// - GET /api/gitnexus/query|context|impact|trace|cypher|graph -> try serve HTTP first
// - If serve HTTP fails, call MCP tool fallback
// - Preserve the existing JSON shape consumed by the frontends
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- gitnexusRoute`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/gitnexusRoute.ts apps/api/src/routes/gitnexusRoute.test.ts
git commit -m "feat: make GitNexus routes service-backed"
```

### Task 4: Add a Suanlizi tool for indexing and maintenance jobs

**Files:**
- Modify: `packages/tools/src/builtin.ts`
- Modify: `packages/tools/src/registry.ts` if needed for exposure metadata
- Test: `packages/tools/src/builtin.test.ts`
- Test: `packages/tools/src/registry.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
it('exposes a gitnexus_analyze tool that queues workspace indexing', async () => {
  expect(true).toBe(false);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- builtin registry`
Expected: FAIL because the tool does not exist yet.

- [ ] **Step 3: Write minimal implementation**

```ts
// Tool shape:
// name: 'gitnexus_analyze'
// input: { repoPath: string; force?: boolean }
// output: { started: boolean; repoPath: string; message: string }
// behavior: invoke the API/service layer, not raw model-side shell execution.
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- builtin registry`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/tools/src/builtin.ts packages/tools/src/registry.ts packages/tools/src/builtin.test.ts packages/tools/src/registry.test.ts
git commit -m "feat: add GitNexus indexing tool"
```

### Task 5: Update the Agent system prompt policy

**Files:**
- Modify: `packages/i18n/src/i18n.ts`
- Modify: `packages/i18n/src/i18n.test.ts`
- Modify: `packages/runtime/src/agent.ts` only if prompt assembly needs extra source context

- [ ] **Step 1: Write the failing test**

```ts
it('treats GitNexus as the preferred structured path for graph-like analysis but keeps built-in tools as the fallback', () => {
  const prompt = createI18n('zh').t(systemPromptKey('zh'));
  expect(prompt).toContain('GitNexus');
  expect(prompt).toContain('list_files/read_file/search_content');
  expect(prompt).toContain('结构化增强');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- i18n`
Expected: FAIL if the prompt policy is not precise enough.

- [ ] **Step 3: Write minimal implementation**

```ts
// Prompt policy text:
// - Built-in workspace tools stay the source of truth for general code reading.
// - GitNexus is the preferred structured path for call graphs, impact, traces, route maps, dependency graphs.
// - If GitNexus is unavailable, continue with built-ins instead of stalling.
// - If the repo is unindexed and permissions allow, trigger gitnexus_analyze.
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- i18n`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/i18n/src/i18n.ts packages/i18n/src/i18n.test.ts packages/runtime/src/agent.ts
git commit -m "feat: refine GitNexus agent prompt policy"
```

### Task 6: Make the UI use service-backed GitNexus data consistently

**Files:**
- Modify: `apps/web/src/components/GitNexusPanel.tsx`
- Modify: `apps/desktop/src/components/GitNexusPanel.tsx`
- Modify: `apps/web/src/components/GitNexusGraphModal.tsx`
- Modify: `apps/desktop/src/components/GitNexusGraphModal.tsx`
- Modify: `apps/web/src/components/GitNexusResultView.tsx`
- Modify: `apps/desktop/src/components/GitNexusResultView.tsx`
- Test: `apps/web/src/components/GitNexusResultView.test.ts`
- Test: `apps/desktop/src/components/GitNexusResultView.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
it('renders the serve-backed context graph without shrinking it down to a single node', () => {
  expect(true).toBe(false);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- GitNexusResultView`
Expected: FAIL before the UI is wired to the new service contract.

- [ ] **Step 3: Write minimal implementation**

```ts
// UI contract:
// - Graph payloads may arrive from serve or MCP, but must normalize to the same GitNexusGraphData shape.
// - If serve returns nodes/edges, render the full subgraph.
// - Keep the preview button + detail panel behavior.
// - Preserve file-level and symbol-level lane labels.
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- GitNexusResultView`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/GitNexusPanel.tsx apps/desktop/src/components/GitNexusPanel.tsx apps/web/src/components/GitNexusGraphModal.tsx apps/desktop/src/components/GitNexusGraphModal.tsx apps/web/src/components/GitNexusResultView.tsx apps/desktop/src/components/GitNexusResultView.tsx apps/web/src/components/GitNexusResultView.test.ts apps/desktop/src/components/GitNexusResultView.test.ts
git commit -m "feat: normalize GitNexus UI to the service contract"
```

### Task 7: Verify the end-to-end fallback chain

**Files:**
- No new files; use the system as integrated above

- [ ] **Step 1: Write the failing test**

```ts
it('falls back from serve to MCP to built-in workspace tools in that order', async () => {
  expect(true).toBe(false);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- gitnexusRoute i18n builtin`
Expected: FAIL until the final chain is stitched together.

- [ ] **Step 3: Write minimal implementation**

```ts
// Verification checklist:
// 1. Stop GitNexus serve and confirm the API falls back to MCP.
// 2. Disable MCP and confirm the Agent still works with list_files/read_file/search_content.
// 3. Re-enable serve and confirm UI graphs come from the service path again.
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- gitnexusRoute i18n builtin`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/gitnexusRoute.ts packages/i18n/src/i18n.ts packages/tools/src/builtin.ts apps/web/src/components/GitNexusResultView.tsx apps/desktop/src/components/GitNexusResultView.tsx
git commit -m "feat: complete GitNexus layered fallback chain"
```

### Task 8: Full verification and operator notes

**Files:**
- Modify: `README.md` if operator steps are documented there
- Modify: `docs/runtime-middleware.md` only if runtime service setup needs to be recorded there

- [ ] **Step 1: Run the focused test suite**

Run: `npm test -- gitnexusRoute gitNexusResult GitNexusResultView GitNexusForceGraph i18n builtin registry`
Expected: all pass.

- [ ] **Step 2: Run the builds**

Run:
```bash
npm run build
npm --workspace @suanlizi/web run build
npm --workspace @suanlizi/desktop run build:ui
```
Expected: all pass.

- [ ] **Step 3: Perform a real UI check**

Open Suanlizi, run a GitNexus context query, click the new preview button, and confirm:
- the preview shows the same graph in a larger overlay
- node click still opens the detail panel
- context graphs do not collapse to a single node when structured subgraph data exists
- file-level and symbol-level graphs keep distinct lane labels

- [ ] **Step 4: Commit documentation updates**

```bash
git add README.md docs/runtime-middleware.md
git commit -m "docs: record GitNexus service and fallback behavior"
```
