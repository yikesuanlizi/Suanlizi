# Suanlizi Trace V2 与深度监控 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用可关联、可分页、可断线回放的 Trace V2 取代当前只显示 turn/middleware/model 的弱监控，让每个 Run 的模型、工具、16 类 item、Agent、文件、checkpoint、context、memory、错误与控制动作都有可验证证据。

**Architecture:** Runtime 将 canonical `ThreadEvent` 与内部观测写入单一 `RunTraceSession`；session 串行执行“递归脱敏 → storage 原子分配 sequence 并提交 → deterministic projector 更新 RunRecord → SSE publish”。Trace 是运行真相的观察脊柱，不替代 transcript item；trace 写入失败只能报告诊断，不能让用户 Run 失败。API 用 run-scoped cursor endpoint 与 SSE replay 提供历史/实时一致视图，Web Monitor 用纯 reducer 构建 Explorer / Timeline / Inspector 三栏工作台。

**Tech Stack:** TypeScript、Zod、Vitest、SQLite/PostgreSQL、Node HTTP/SSE、React 19、CSS。

---

## 不变量

1. 同一 Run 内 `sequence` 严格单调、无重复；返回给客户端的 events 永远按 sequence 升序。
2. storage commit 成功后才能 publish；断线重连以 `Last-Event-ID`/`after` 补齐，不能出现“实时看过但历史查不到”。
3. conversation item 与 runtime evidence 分层：Monitor 不复制 user message 正文，也不把 trace 当 transcript 真相源。
4. item started/completed/discarded 共用 `span:<runId>:item:<itemId>`；root 固定为 `span:<runId>:root:<runKind>`；iteration/model/tool span 由注入的 `idFactory` 生成。
5. `finish()` 先 flush 所有子事件，再写 root completed/failed，终态必须是该不可变 Run 的最后一个 sequence。对已终态 Run 的 resume/rollback/interrupt 审计要创建新的 `control` Run，并以 `parentRunId` 指向目标 Run，不能在终态后追加事件。
6. Trace 默认只保存结构化摘要。参数、结果、header、环境变量、路径片段都经过递归脱敏和体积上限；本地 raw/deep trace 若未来启用，必须独立开关并标为敏感，禁止上传。
7. Trace recorder 是 best-effort；写入失败会产生 runtime diagnostic 和日志，但不会覆盖原 Run 成败。
8. Trace V2 不回填、不双读旧 `run_events`。旧表保留取证，新 UI 只展示 `traceVersion=2` 的 Run。

### Task 0: 锁定 Codex 参考边界

**Files:**
- Read: `E:/langchain/codex/codex-rs/rollout-trace/README.md`
- Read: `E:/langchain/codex/codex-rs/rollout-trace/src/protocol_event.rs`
- Read: `E:/langchain/codex/codex-rs/rollout-trace/src/payload.rs`
- Read: `E:/langchain/codex/codex-rs/rollout-trace/src/model/runtime.rs`
- Read: `E:/langchain/codex/codex-rs/app-server-protocol/src/protocol/v2/item.rs`
- Read: `E:/langchain/codex/codex-rs/app-server-protocol/src/protocol/v2/notification.rs`
- Modify: this plan's execution notes only

- [ ] **Step 1: 记录采用项**

执行日志写明采用：observe first / interpret later、有序原始事件脊柱、payload 与投影分层、稳定 item id、started/completed 成对、child agent 共用 trace graph、trace failure 不影响 Run。

- [ ] **Step 2: 记录不采用项**

明确不复制 Rust bundle 文件、CLI/TUI、JSON-RPC transport、Codex 私有 payload 内容和上传策略；Suanlizi 仍使用 Node HTTP/SSE 与租户隔离数据库。

- [ ] **Step 3: 锁定 ThreadItem 枚举基线**

Run:

```powershell
rg -n "^export type ThreadItem|^export interface .*Item" packages/protocol/src/types.ts
```

Expected: 把当前 16 个 union member 名称记录到 `runTraceProjector.test.ts` 的 exhaustive table；后续新增 item 导致 `assertNever` 编译失败，不能静默漏记。

### Task 1: 定义 Trace V2 与真实控制协议

**Files:**
- Create: `packages/protocol/src/runTrace.ts`
- Create: `packages/protocol/src/runTrace.test.ts`
- Create: `packages/protocol/src/runTraceSchemas.ts`
- Create: `packages/protocol/src/runTraceSchemas.test.ts`
- Modify: `packages/protocol/src/runControl.ts`
- Modify: `packages/protocol/src/runControl.test.ts`
- Modify: `packages/protocol/src/types.ts`
- Modify: `packages/protocol/src/schemas.ts`
- Modify: `packages/protocol/src/schemas.test.ts`
- Modify: `packages/protocol/src/index.ts`

- [ ] **Step 1: 写 envelope 关联性和 schema 失败测试**

测试至少覆盖：

- category 与 payload 必须是相关联合类型，`model` 事件不能携带 tool payload。
- lifecycle=`completed|failed` 时允许 duration；item 生命周期必须带 itemId。
- sequence 是大于 0 的整数，version 只能是 2。
- model/provider/tool args 中的未知字段不能绕过 schema。
- JSON parse/serialize 后保持 eventId、runId、turnId、spanId、parentSpanId、itemId、sequence。
- `runKind='control'|'workflow'` 时允许 `turnId:null`，但仍必须有 runId/threadId/root span；turn run 必须有 turnId。

Run:

```powershell
npx vitest run packages/protocol/src/runTrace.test.ts packages/protocol/src/runTraceSchemas.test.ts
```

Expected: FAIL，Trace V2 文件尚不存在。

- [ ] **Step 2: 实现 correlated envelope**

`packages/protocol/src/runTrace.ts` 固定导出以下公开形状；payload 中不保存 prompt、message 或完整文件内容：

```typescript
export const RUN_TRACE_VERSION = 2 as const;

export type RunTraceLevel = 'debug' | 'info' | 'warning' | 'error';
export type RunTraceLifecycle = 'instant' | 'started' | 'completed' | 'failed' | 'discarded';
export type RunTraceCategory =
  | 'turn' | 'iteration' | 'context' | 'memory' | 'middleware'
  | 'model' | 'tool' | 'item' | 'agent' | 'file'
  | 'checkpoint' | 'evidence' | 'error' | 'control';
export type RunTraceRunKind = 'turn' | 'control' | 'workflow' | 'subagent';

export interface RunTracePayloadMap {
  turn: { status?: 'running' | 'completed' | 'failed' | 'interrupted'; inputItemCount?: number; reason?: string };
  iteration: { index: number; outcome?: string };
  context: { phase: 'assembled' | 'compacted' | 'pressured'; sourceCounts: Record<string, number>; estimatedTokens?: number; durationMs?: number; omittedContent: true };
  memory: { phase: 'search' | 'inject' | 'write'; recordCount: number; durationMs?: number; queryHash?: string; scoreBuckets?: Record<string, number>; omittedContent: true };
  middleware: { middlewareId: string; stage: 'before' | 'after' | 'error'; attempt?: number };
  model: { provider: string; model: string; attempt: number; streaming: boolean; ttftMs?: number; inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number; finishReason?: string };
  tool: { toolName: string; callId: string; decision?: 'allow' | 'deny' | 'approval_required'; approvalId?: string; argsSummary?: unknown; resultSummary?: unknown; exitCode?: number; outputBytes?: number };
  item: { itemType: ThreadItem['type']; status?: string };
  agent: { agentThreadId: ThreadId; role: string; action: 'spawn' | 'started' | 'joined' | 'failed' | 'interrupted'; childRunId?: string };
  file: { action: 'read' | 'write' | 'patch' | 'delete' | 'checkpoint'; path: string; addedLines?: number; removedLines?: number };
  checkpoint: { checkpointId: string; turnCount: number; itemIndex: number; status: CheckpointStatus };
  evidence: { kind: string; label: string; passed?: boolean };
  error: { code: string; message: string; retryable: boolean; source?: string };
  control: { action: 'interrupt' | 'resume' | 'rollback'; outcome: 'requested' | 'accepted' | 'rejected' | 'completed'; checkpointId?: string; reason?: string };
}

interface RunTraceBase<C extends RunTraceCategory> {
  version: typeof RUN_TRACE_VERSION;
  eventId: string;
  sequence: number;
  runId: string;
  parentRunId?: string;
  runKind: RunTraceRunKind;
  threadId: ThreadId;
  turnId?: TurnId | null;
  spanId: string;
  parentSpanId?: string;
  itemId?: string;
  category: C;
  name: string;
  lifecycle: RunTraceLifecycle;
  level: RunTraceLevel;
  occurredAt: string;
  durationMs?: number;
  payload: RunTracePayloadMap[C];
}

export type RunTraceEnvelope = {
  [C in RunTraceCategory]: RunTraceBase<C>
}[RunTraceCategory];

type WithoutStorageIdentity<T> = T extends unknown
  ? Omit<T, 'eventId' | 'sequence' | 'version'>
  : never;

export type RunTraceDraft = WithoutStorageIdentity<RunTraceEnvelope>;

type WithoutRunContext<T> = T extends unknown
  ? Omit<T, 'runId' | 'parentRunId' | 'threadId' | 'turnId'>
  : never;

export type RunTraceObservation = WithoutRunContext<RunTraceDraft>;

export interface RunTracePage {
  events: RunTraceEnvelope[];
  hasMoreBefore: boolean;
  hasMoreAfter: boolean;
  nextBefore?: number;
  nextAfter?: number;
}

export type RunTraceStatus = 'pending' | 'running' | 'completed' | 'failed' | 'interrupted' | 'blocked';

export interface RunTraceSummary {
  status: RunTraceStatus;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  currentSpan?: { spanId: string; category: RunTraceCategory; name: string };
  model: { calls: number; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; maxTtftMs?: number };
  tools: { calls: number; failed: number; denied: number };
  items: { started: number; completed: number; failed: number; byType: Record<string, number> };
  agents: { spawned: number; running: number; failed: number };
  files: { changed: number; addedLines: number; removedLines: number };
  lastError?: { code: string; message: string };
  lastCheckpointId?: string;
}
```

如果现有 `ThreadId/TurnId/CheckpointStatus` 不是 string alias，直接 import 原类型，不创建平行定义。Zod schema 与 TypeScript union 同步，并对 payload 使用 `.strict()`。

- [ ] **Step 3: 复核并扩展 P0 的 run control contract**

```typescript
export type RunControlRequest =
  | { action: 'interrupt' }
  | { action: 'resume' }
  | { action: 'rollback'; checkpointId: string };

export interface RunControlCapabilities {
  interrupt: { enabled: boolean; reason?: string };
  resume: { enabled: boolean; reason?: string };
  rollback: { enabled: boolean; checkpointIds: string[]; reason?: string };
}

export interface RunControlResult {
  targetRunId: string;
  controlRunId: string;
  threadId: ThreadId;
  action: RunControlRequest['action'];
  accepted: boolean;
  reason?: string;
}
```

保留 P0 已建立的唯一 `runControlRequestSchema`，不得在 Trace 文件中再建一套。三个分支均 `.strict()`；任何客户端 `threadId`、rollback 缺 checkpointId、approve/deny/retry 都返回 schema error。approval 的批准/拒绝继续走原 approval endpoint。本任务只补 RunTrace schema 交叉测试和公开 `RunControlResult`，若 P0 类型已完全一致则测试先绿且无需重写。

- [ ] **Step 4: 复核 P0 lifecycle 关联字段，不提前破坏 emitters**

P0 已把 turn started/completed/failed 的 `runId` 与全部 emitter/schema fixture 一次性升级；本任务只增加 Trace 类型并验证可关联，不再重复改 lifecycle。稳定 tool `callId`、spawn parentRunId/childRunId 与 usage cache-write 数据会在 Task 4 和对应生产 emitter 同一提交落地，避免 Task 1 先把字段设为 required 后让当前 runtime 无法编译。不新增旧 V1 双分支。

- [ ] **Step 5: 运行并提交协议**

```powershell
npx vitest run packages/protocol/src/runTrace.test.ts packages/protocol/src/runTraceSchemas.test.ts packages/protocol/src/runControl.test.ts packages/protocol/src/schemas.test.ts
npm run build
git add packages/protocol/src
git commit -m "feat: define run trace v2 protocol"
```

Expected: 测试、build 均通过；protocol 不依赖 storage/runtime/UI。

### Task 2: 为 SQLite/PostgreSQL 增加原子 sequence 与游标分页

**Files:**
- Create: `packages/storage/src/runTraceStore.ts`
- Modify: `packages/storage/src/store.ts`
- Modify: `packages/storage/src/store.test.ts`
- Modify: `packages/storage/src/postgres.ts`
- Modify: `packages/storage/src/postgres.test.ts`
- Modify: `packages/storage/src/index.ts`
- Modify: `packages/storage/src/backend.test.ts`

- [ ] **Step 1: 写失败的存储契约测试**

同一套 contract tests 覆盖 SQLite、PostgreSQL 与 JSON file fallback：

1. 两个并发 append 得到唯一且连续的 1、2。
2. `after=15, limit=5` 返回 16..20，升序。
3. `before=16, limit=5` 返回 11..15，升序。
4. 不传 cursor、`limit=5` 返回最新 5 条而不是最早 5 条，仍以升序输出。
5. before 与 after 同时传入时报 `INVALID_CURSOR`。
6. tenant A 不能读 tenant B 的 run。
7. append 到不存在或不属于租户的 run 返回 `RUN_NOT_FOUND`。
8. 终态事件在 500 条 delta 后仍能从末页读到。

初始页 SQL 必须在子查询中 `ORDER BY sequence DESC LIMIT ?`，取出后内存 reverse；禁止 `ASC LIMIT ?`。

- [ ] **Step 2: 将 schema version 升到 6**

SQLite 与 PostgreSQL 新增：

```sql
CREATE TABLE run_trace_heads (
  tenant_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  next_sequence INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, run_id)
);

CREATE TABLE run_trace_events (
  tenant_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  event_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  turn_id TEXT,
  category TEXT NOT NULL,
  lifecycle TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  envelope_json TEXT NOT NULL,
  PRIMARY KEY (tenant_id, run_id, sequence),
  UNIQUE (tenant_id, event_id)
);
```

同时给 `run_records` 增加 `trace_version INTEGER` 与 `trace_summary_json TEXT`；`RunRecord` 增加 `traceVersion?: 2 | null`、`traceSummary?: RunTraceSummary | null`，并补 insert/update/row mapper。增加 `(tenant_id, run_id, category, sequence)` 索引。迁移只建新表/列并将 schema version 设为 6；不复制旧 `run_events`，避免把字段不足的 V1 冒充 V2。SQLite 先用 `PRAGMA table_info(run_records)` 判断列是否存在再 `ALTER TABLE`，保证重复启动幂等；PostgreSQL 使用 `ADD COLUMN IF NOT EXISTS`。

- [ ] **Step 3: 建立窄 `RunTraceStore` 能力接口**

```typescript
export interface RunTraceStore {
  appendRunTraceEvent(draft: RunTraceDraft): Promise<RunTraceEnvelope>;
  listRunTraceEvents(runId: string, query?: {
    before?: number;
    after?: number;
    limit?: number;
    categories?: RunTraceCategory[];
    errorsOnly?: boolean;
  }): Promise<RunTracePage>;
  getRunTraceHead(runId: string): Promise<number>;
  updateRunRecord(runId: string, patch: Partial<RunRecord>): Promise<void>;
}
```

Trace 装配显式要求 `RunMonitorStore & RunTraceStore`，核心 `ThreadStore` 与无关测试 fake 不增加空方法；SQLite/PostgreSQL/JSON fallback 实现该交集。fallback 的 head/event state 必须写回 `threads.json` 并在重建 store 后保持 sequence，不能只在内存工作。SQLite 在 `db.transaction()` 中验证 Run 归属、upsert head、分配 sequence、插入 envelope；PostgreSQL 使用 transaction + `INSERT ... ON CONFLICT ... DO UPDATE ... RETURNING next_sequence`。`eventId` 由存储注入的 id factory 生成，测试不依赖随机值。

- [ ] **Step 4: 运行后端一致性测试**

```powershell
npx vitest run packages/storage/src/store.test.ts packages/storage/src/postgres.test.ts packages/storage/src/backend.test.ts
npm run build
```

Expected: build 与 SQLite 测试全部通过；PostgreSQL contract 在配置测试数据库时全跑，否则明确 skip 连接测试但纯 SQL/query builder 测试必须通过。

- [ ] **Step 5: 提交存储层**

```powershell
git add packages/storage/src/runTraceStore.ts packages/storage/src/store.ts packages/storage/src/store.test.ts packages/storage/src/postgres.ts packages/storage/src/postgres.test.ts packages/storage/src/index.ts packages/storage/src/backend.test.ts
git commit -m "feat: persist and page run trace events"
```

### Task 3: 实现脱敏、确定性投影和串行 Session

**Files:**
- Create: `packages/runtime/src/runTraceRedaction.ts`
- Create: `packages/runtime/src/runTraceRedaction.test.ts`
- Create: `packages/runtime/src/runTraceProjector.ts`
- Create: `packages/runtime/src/runTraceProjector.test.ts`
- Create: `packages/runtime/src/runTraceSession.ts`
- Create: `packages/runtime/src/runTraceSession.test.ts`
- Modify: `packages/runtime/src/index.ts`

- [ ] **Step 1: 写递归脱敏失败测试**

覆盖大小写不敏感 key：`authorization/cookie/set-cookie/apiKey/api_key/token/accessToken/password/secret/env`；覆盖数组、嵌套对象、循环引用、Buffer、Error、2 KB 字符串和总 payload 32 KB 上限。路径只保留相对 workspace path，workspace 外路径变成 basename + `[outside-workspace]`。断言原对象不被 mutate。

- [ ] **Step 2: 实现纯 `redactTracePayload`**

```typescript
export interface TraceRedactionOptions {
  workspaceRoot?: string;
  maxStringBytes?: number;
  maxPayloadBytes?: number;
}

export function redactTracePayload(value: unknown, options?: TraceRedactionOptions): unknown;
```

使用 `WeakSet` 防循环；敏感值统一变成 `'[REDACTED]'`；截断值附 `{ truncated: true, originalBytes }` 元数据。禁止直接 `JSON.stringify` 未脱敏 tool input。

- [ ] **Step 3: 写 projector 失败测试**

给定固定 trace list，`projectRunTrace(events)` 必须得到相同 summary，不依赖 wall clock。覆盖 turn 与 `turnId:null` 的 control/workflow Run、running/completed/failed、usage/cache/TTFT 聚合、工具成功/失败数、agent 数、文件变更数、最后 error、最后 checkpoint、当前 span。重复 eventId 不重复计数，乱序输入先按 sequence 排序。

`RunTraceSummary` 使用 Task 1 的 protocol 类型，runtime 不再定义同名结构，避免 storage/runtime 循环依赖。

- [ ] **Step 4: 实现 `RunTraceSession` 顺序队列**

```typescript
export interface RunTraceSink {
  append(draft: RunTraceDraft): Promise<RunTraceEnvelope>;
  updateRun(runId: string, summary: RunTraceSummary): Promise<void>;
  publish(event: RunTraceEnvelope): void;
  reportFailure(error: unknown, draft: RunTraceDraft): void;
}

export class RunTraceSession {
  constructor(input: {
    runId: string;
    parentRunId?: string;
    runKind: RunTraceRunKind;
    threadId: ThreadId;
    turnId?: TurnId | null;
    sink: RunTraceSink;
    idFactory?: () => string;
    redaction?: TraceRedactionOptions;
  });
  record(observation: RunTraceObservation): Promise<RunTraceEnvelope | null>;
  finish(input: { status: 'completed' | 'failed' | 'interrupted'; error?: unknown }): Promise<void>;
  flush(): Promise<void>;
}
```

内部使用单一 promise tail。每个 record 固定顺序：redact → append → 更新内存 projection → 尝试 updateRun → publish。append 失败时 report 且不 publish；updateRun 失败时 report，但已经持久化的 envelope 仍 publish，下一条 projection 用完整内存状态再次覆盖 RunRecord。任何 trace 失败都不能 reject 用户 Run，测试必须确认下一条仍继续。`finish()` 禁止重复终态。

- [ ] **Step 5: 运行并提交 runtime 基础件**

```powershell
npx vitest run packages/runtime/src/runTraceRedaction.test.ts packages/runtime/src/runTraceProjector.test.ts packages/runtime/src/runTraceSession.test.ts
npm run build
git add packages/runtime/src
git commit -m "feat: add deterministic run trace sessions"
```

### Task 4: 将 AgentLoop、模型、工具和全部 item 接入 Trace

**Files:**
- Modify: `packages/protocol/src/types.ts`
- Modify: `packages/protocol/src/schemas.ts`
- Modify: `packages/protocol/src/schemas.test.ts`
- Modify: `packages/model-gateway/src/types.ts`
- Modify: `packages/model-gateway/src/gateway.ts`
- Modify: `packages/model-gateway/src/gateway.test.ts`
- Modify: `packages/runtime/src/agent.ts`
- Modify: `packages/runtime/src/agent.test.ts`
- Modify: `packages/runtime/src/taskRuntimeEvents.test.ts`
- Modify: `packages/runtime/src/modelOutput.test.ts`
- Modify: `apps/api/src/runtime/tenantRuntime.ts`
- Modify: `apps/api/src/runtime/tenantRuntime.test.ts`

- [ ] **Step 1: 先写 item exhaustive projection 表**

在 `runTraceProjector.test.ts` 构造 `Record<ThreadItem['type'], ThreadItemFixture>`；对每种 item 断言：started/completed 或 discarded 成对、itemId 和 spanId 稳定、payload.itemType 正确、错误 item level=error。switch 的 default 调用 `assertNever(item)`。

- [ ] **Step 2: 给 AgentConfig 显式注入模型身份与 trace sink**

```typescript
export interface AgentConfig {
  // existing fields...
  modelIdentity?: { provider: string; model: string };
  runTraceSink?: RunTraceSink;
  idFactory?: () => string;
}
```

`apps/api/src/runtime/tenantRuntime.ts` 从已经 resolve 的 config 显式传 `modelIdentity`，禁止读取 ModelGateway 私有 config；缺省测试 gateway 使用 `{provider:'unknown', model:'unknown'}`。

- [ ] **Step 3: 用 session 替换手写 `runMonitorSessions`**

每个 turn 建立一个 root session；resume/rollback/control 建新 runId 并设置 parentRunId，不能续写旧 completed/failed Run。workflow/control 没有 Turn 时传 `turnId:null`。Span 规则固定：

```text
root           span:<runId>:root:<runKind>
iteration      span:<runId>:iteration:<idFactory()>
model          span:<runId>:model:<idFactory()>
tool           span:<runId>:tool:<idFactory()>
item lifecycle span:<runId>:item:<itemId>
```

删除 `AgentLoop` 内手工维护的松散 RunEvent count/summary；RunRecord 只由 projector 更新。

- [ ] **Step 4: 记录模型深度指标**

model started 在 gateway 调用前写入；首次 delta 只记录一次 TTFT；completed/failed 包含 attempt、provider、model、streaming、usage、cache tokens、finishReason、duration。先给 `NormalizedUsage` 与 protocol `Usage` 增加 `cacheWriteTokens`，在 gateway 归一化 Anthropic `cache_creation_input_tokens` 等公开字段，并更新 empty/sum/serialization 测试；不能让 Trace 从不存在的数据猜值。delta 不逐 token 落库：每 250ms 或 4KB 合并一次 `model.delta_summary`，并在完成前 flush，避免事件风暴。

- [ ] **Step 5: 记录工具、审批与结果**

在 `ToolCallItem/McpToolCallItem/CollabToolCallItem/CommandExecutionItem` 增加 required `callId`，同一 Task 内更新 Zod schemas、模型输出 parser、所有生产 emitter 和 fixture；默认本地工具可使用稳定的 `call:<itemId>`，provider 原生 id 存在时保留映射。tool trace 使用该 callId，并将 governance decision、approvalId、脱敏 args summary、result summary、exit code、output bytes、duration、关联 itemId 写入。批准/拒绝本身仍由 approval 服务处理，但结果作为 tool trace evidence 记录。工具异常同时结束 tool span、item span，并生成 error span；不能留下永久 running。

- [ ] **Step 6: 记录 Agent、文件与 checkpoint**

spawn/join/fail/interrupted 与 childRunId 进入 agent span；child session 的 parentRunId 指向父 Run。file_change、project_checkpoint、workflow_checkpoint 与真正持久化成功的 checkpoint 进入对应 span；失败写 error，不伪造 completed。

- [ ] **Step 7: 运行集成测试**

```powershell
npx vitest run packages/protocol/src/schemas.test.ts packages/model-gateway/src/gateway.test.ts packages/runtime/src/agent.test.ts packages/runtime/src/taskRuntimeEvents.test.ts packages/runtime/src/modelOutput.test.ts apps/api/src/runtime/tenantRuntime.test.ts
npm run build
```

Expected: 16 item exhaustive 表通过；模拟模型失败、tool deny、subagent failure、interrupt、resume 都有闭合 span，且 Run 原返回值与引入 trace 前相同。

- [ ] **Step 8: 提交运行时接线**

```powershell
git add packages/protocol/src/types.ts packages/protocol/src/schemas.ts packages/protocol/src/schemas.test.ts packages/model-gateway/src/types.ts packages/model-gateway/src/gateway.ts packages/model-gateway/src/gateway.test.ts packages/runtime/src/agent.ts packages/runtime/src/agent.test.ts packages/runtime/src/taskRuntimeEvents.test.ts packages/runtime/src/modelOutput.test.ts apps/api/src/runtime/tenantRuntime.ts apps/api/src/runtime/tenantRuntime.test.ts
git commit -m "feat: record model tool item and agent spans"
```

### Task 5: 接入 context、memory 与 harness 证据，锁定终态顺序

**Files:**
- Modify: `packages/runtime/src/agent.ts`
- Modify: `packages/runtime/src/agent.test.ts`
- Modify: `packages/runtime/src/harness/evidenceLedger.ts`
- Modify: `packages/runtime/src/harness/taskHarness.ts`
- Modify: `packages/runtime/src/harness/taskHarness.test.ts`
- Modify: `apps/api/src/services/dynamicContext.ts`
- Modify: `apps/api/src/services/dynamicContext.test.ts`
- Modify: `apps/api/src/services/harnessRuntime.ts`
- Modify: `apps/api/src/services/harnessRuntime.test.ts`

- [ ] **Step 1: 写顺序测试**

期望 sequence 关系：turn.started < context.assembled < memory.inject < iteration.started < model/tool/item < evidence < checkpoint < turn.completed。失败路径是 error < turn.failed。Harness continuation 的证据必须在下一 iteration started 前落地。

- [ ] **Step 2: 记录 context/memory 摘要而非内容**

dynamic context 只写 sourceCounts、估算 token、pressure/compaction 原因和 duration；memory 只写 query hash、recordCount、score bucket 与 duration，不保存 query、memory text 或模型可见上下文片段。测试扫描 envelope JSON，断言 fixture 中的秘密文本不存在。

- [ ] **Step 3: 记录 harness 决策证据**

EvidenceLedger 的 goal/readiness/storm-breaker 结果投影为 evidence span；harnessRunId 与 iteration 进入 parent span 关联。Trace 失败不得让 harness 判定失败；harness failure 仍必须让 trace root 正确 failed。

- [ ] **Step 4: 验证 finish 自动 flush**

构造延迟 sink：调用 child record 后立即 finish，最终 storage 的最后事件必须是 root terminal；所有 child span 已关闭。重复 finish 不新增事件。

- [ ] **Step 5: 运行并提交**

```powershell
npx vitest run packages/runtime/src/agent.test.ts packages/runtime/src/harness/taskHarness.test.ts apps/api/src/services/dynamicContext.test.ts apps/api/src/services/harnessRuntime.test.ts
npm run build
git add packages/runtime/src apps/api/src/services/dynamicContext.ts apps/api/src/services/dynamicContext.test.ts apps/api/src/services/harnessRuntime.ts apps/api/src/services/harnessRuntime.test.ts
git commit -m "feat: trace context memory and harness evidence"
```

### Task 6: 提供租户安全的分页 API 与 SSE replay

**Files:**
- Create: `apps/api/src/routes/runTraceRoute.ts`
- Create: `apps/api/src/routes/runTraceRoute.test.ts`
- Create: `apps/api/src/services/runTraceSseHub.ts`
- Create: `apps/api/src/services/runTraceSseHub.test.ts`
- Modify: `apps/api/src/routes/runMonitorRoute.ts`
- Modify: `apps/api/src/routes/runMonitorRoute.test.ts`
- Modify: `apps/api/src/routes/threadRuntimeActions.ts`
- Modify: `apps/api/src/server.ts`
- Modify: `apps/api/src/runtime/tenantRuntime.ts`

- [ ] **Step 1: 写 HTTP contract 失败测试**

固定 endpoints：

```text
GET  /api/runs/:runId/trace?before=&after=&limit=&category=&errorsOnly=
GET  /api/runs/:runId/stream
POST /api/runs/:runId/control
```

测试 400 invalid cursor/limit、401 缺失/无效 token、404 不存在、404 跨租户（不泄露存在性）、200 page 升序、EventSource access_token query、strict control body、rollback checkpoint 归属、capability disabled 409。Run 列表与单 Run 详情返回 `traceVersion`、`summary`、`controlCapabilities`。

- [ ] **Step 2: 实现 run-scoped replay hub**

`RunTraceSseHub` 维护 `Map<tenantId:runId, Set<Client>>`，不缓存历史真相。连接流程：

1. 验证 run 归属。
2. 先注册 `mode='buffering'` 的 client，设置 `lastSentSequence=afterSequence`；注册后 publish 只进入该 client 的有界 buffer。
3. 读取当前 head `H`，查询 `(afterSequence,H]` 并通过 `sendIfNew(sequence)` 升序发送 replay。
4. 在 hub 的同步临界段取出 buffer，按 sequence 排序，通过同一个 `sendIfNew` 去重发送，再切成 `mode='live'`；每个 client 的 outbound promise queue 保证异步 write 不重排。
5. live publish 继续走 `sendIfNew`；buffer 超过 2000 条或 socket backpressure 超限时主动 close，让客户端按 last sequence 重连，不能无限吃内存。
6. 15 秒 heartbeat；close/abort 时删除 client。

SSE `id` 等于 decimal sequence，`event: trace`，`data` 为单个 `RunTraceEnvelope`。解析 `Last-Event-ID` 优先于 query after；无效值返回 400。测试必须把 publish 精确插在注册、head read、replay write、buffer flush 四个边界，断言无 gap、无 duplicate、严格升序。

- [ ] **Step 3: storage commit 后 publish**

tenant runtime 注入的 sink 只能在 `appendRunTraceEvent` 成功后调用 hub.publish。测试让 append reject，断言 SSE 未收到 event；让 updateRun reject，断言 diagnostic 被记录但用户 turn 不失败。

accepted interrupt/resume/rollback 为独立 `runKind='control'` session，`turnId:null`、`parentRunId=targetRunId`；control root 自己 started → outcome → completed/failed。目标 Run 保持不可变。API 返回 targetRunId/controlRunId，测试断言目标 terminal sequence 未变化且控制 Run 可单独分页/回放。

- [ ] **Step 4: 收紧 Monitor 管理语义**

删除没有真实跨租户 API 支撑的“跨租户/全局管理员”标签。普通用户只能查 tenant store。若未来需要平台管理员视图，另开 plan 并使用独立授权与审计，不在本任务伪装支持。

- [ ] **Step 5: 运行并提交 API**

```powershell
npx vitest run apps/api/src/routes/runTraceRoute.test.ts apps/api/src/services/runTraceSseHub.test.ts apps/api/src/routes/runMonitorRoute.test.ts apps/api/src/runtime/tenantRuntime.test.ts
npm run build
git add apps/api/src
git commit -m "feat: replay run trace events over sse"
```

### Task 7: 重建 Web Monitor Explorer / Timeline / Inspector

**Files:**
- Create: `apps/web/src/features/monitor/runTraceClient.ts`
- Create: `apps/web/src/features/monitor/runTraceClient.test.ts`
- Create: `apps/web/src/features/monitor/runTraceState.ts`
- Create: `apps/web/src/features/monitor/runTraceState.test.ts`
- Create: `apps/web/src/features/monitor/traceTree.ts`
- Create: `apps/web/src/features/monitor/traceTree.test.ts`
- Create: `apps/web/src/features/monitor/virtualTraceRows.ts`
- Create: `apps/web/src/features/monitor/virtualTraceRows.test.ts`
- Create: `apps/web/src/components/monitor/RunExplorer.tsx`
- Create: `apps/web/src/components/monitor/TraceTimeline.tsx`
- Create: `apps/web/src/components/monitor/TraceTimeline.test.tsx`
- Create: `apps/web/src/components/monitor/TraceInspector.tsx`
- Create: `apps/web/src/components/monitor/TraceFilters.tsx`
- Create: `apps/web/src/components/monitor/RunMonitorWorkbench.tsx`
- Create: `apps/web/src/components/monitor/RunMonitorWorkbench.test.tsx`
- Create: `apps/web/src/components/monitor/runMonitorViewModel.ts`
- Create: `apps/web/src/components/monitor/runMonitorViewModel.test.ts`
- Modify: `apps/web/src/api/authClient.ts`
- Modify: `apps/web/src/api/authClient.test.ts`
- Modify: `apps/web/src/components/RunMonitorDrawer.tsx`
- Modify: `apps/web/src/components/ItemView.tsx`
- Modify: `apps/web/src/components/DiffView.tsx`
- Modify: `apps/web/src/main.tsx`
- Modify: `apps/web/src/styles.css`

- [ ] **Step 1: 写 reducer 的历史 + live 合并测试**

覆盖：打开 Run 默认加载最新 N 条；向前翻页 prepend 去重；SSE append 按 sequence 去重；断线后 after 补齐；切换 Run 后旧请求/SSE 不得写入；选中 event 在分页后保留；显式选历史 Run 不自动跳最新；500+ 事件筛选不改变原始顺序。

本任务开始前确认产品壳计划 Task 1 的 jsdom/Testing Library 基线已完成。组件测试覆盖：Explorer 选择历史 Run、filter 后 Timeline 行数、键盘上下/Enter、Inspector 切换、错误 live region、mobile drill-in/Esc 返回；不得只测纯函数后把组件交互留给人工。

- [ ] **Step 2: 实现 run-scoped client**

client 只暴露 `listRuns/listTrace/openTraceStream/controlRun`。`openTraceStream` 必须用现有 `authEventSourceUrl()` 组合 `/api/runs/:runId/stream?after=<lastSequence>`，保留已有 query 并正确追加 access_token；EventSource 不能伪装设置 Authorization header。每次选 Run 都 abort 旧 page 请求并 close 旧 EventSource；reconnect 保存 lastSequence，指数退避 0.5/1/2/5 秒，上限 5 秒；收到 terminal 后停止自动重连。client/API 测试覆盖 JWT query、无 token、已有 query、断线 gap 和重复 sequence。

- [ ] **Step 3: 构建三栏信息架构**

```text
Run Explorer (280px) | Timeline (minmax 420px, 1fr) | Inspector (360px)
```

- Explorer：thread/run、状态、开始时间、耗时、模型、token、错误标志；明确区分 live 与 history。
- Timeline：按 turn/iteration/agent/span 分组，可展开；行显示时间、duration、category、name、状态、item/tool/model 关键摘要。
- Inspector：Overview、Metrics、Input summary、Output summary、Error、Raw（高级）分区；tool/file item 复用现有 `ItemView`/`DiffView` 的安全渲染，不展示未脱敏原始值。

筛选固定支持：全文搜索、category 多选、仅错误、仅当前 Agent、collapse completed、按 sequence/耗时排序。默认 sequence 排序。

- [ ] **Step 4: 实现无第三方依赖的固定行高虚拟化**

`virtualTraceRows.ts` 接收 rowCount、rowHeight、scrollTop、viewportHeight、overscan，返回 start/end/paddingTop/paddingBottom。测试 0、1、500、5000 行和边界 scroll。Timeline 只渲染窗口行，展开详情在 Inspector，不允许可变行高破坏计算。

- [ ] **Step 5: 删除旧 Monitor 数据混合与请求风暴**

`RunMonitorDrawer` 变成 Workbench 薄壳；删除对 current thread task/items/checkpoints 的 props。SSE 每条 trace 只 dispatch 本地 reducer，不触发 listRuns/listTrace；仅 terminal 后轻量刷新一次 Run summary。右栏 Live HUD 由产品壳计划消费同一 summary，但不复制 Timeline。

- [ ] **Step 6: 响应式与可访问性**

大于 1180px 三栏；760–1179px Explorer + 主区，Inspector 作为右侧 overlay；小于 760px 单栏路由式 drill-in。所有行使用 button/aria-selected，键盘上下移动、Enter 打开、Esc 返回；live status 用 `aria-live=polite`，错误用 assertive；reduced motion 禁用闪烁和位移动画。

- [ ] **Step 7: 运行 Web 定向测试并提交**

```powershell
npx vitest run apps/web/src/api/authClient.test.ts apps/web/src/features/monitor/runTraceClient.test.ts apps/web/src/features/monitor/runTraceState.test.ts apps/web/src/features/monitor/traceTree.test.ts apps/web/src/features/monitor/virtualTraceRows.test.ts apps/web/src/components/monitor/runMonitorViewModel.test.ts apps/web/src/components/monitor/TraceTimeline.test.tsx apps/web/src/components/monitor/RunMonitorWorkbench.test.tsx apps/web/src/components/RunMonitorDrawer.test.ts
npm run build
git add apps/web/src/api/authClient.ts apps/web/src/api/authClient.test.ts apps/web/src/features/monitor apps/web/src/components/monitor apps/web/src/components/RunMonitorDrawer.tsx apps/web/src/components/ItemView.tsx apps/web/src/components/DiffView.tsx apps/web/src/main.tsx apps/web/src/styles.css
git commit -m "feat: rebuild run monitor explorer and inspector"
```

Desktop 只因公开类型变化做最小编译适配；不得在这个提交复制 Web Workbench。完整 Desktop 迁移属于路线三。

### Task 8: Trace V2 全链路验证

**Files:**
- Modify only when a failing assertion identifies a concrete Trace V2 defect.

- [ ] **Step 1: 运行完整门禁**

```powershell
npm run verify
```

Expected: source artifact guard、lint、全量测试、build 全部通过；不得减少既有测试。

- [ ] **Step 2: 请用户手动重启已运行服务**

遵守 `AGENTS.md`：助手不启动、停止或重启 Suanlizi。告知用户代码已就绪，请用户重启 5177 对应进程；用户确认后再做浏览器验收。

- [ ] **Step 3: 使用内置浏览器验证真实 Run**

至少执行并截图/记录以下场景：普通回答、两次模型重试、tool 成功、tool deny/approval、文件修改、spawn 子 Agent、模型失败、interrupt、resume、rollback。逐一检查 Timeline/Inspector 的关联 id、终态、duration、usage、脱敏和控制按钮。

- [ ] **Step 4: 验证 500+ 与断线 replay**

在测试 fixture 或可控长 Run 中产生 500+ trace：向上翻页到 sequence 1；断开 stream 后继续运行，再连接，确认无 gap/duplicate；模型 delta 不产生全量 HTTP 风暴。Network 中每个 live event 只对应一个 SSE frame，不伴随三次 refresh。

- [ ] **Step 5: 验证 conversation/evidence 分层**

搜索 trace JSON，用户原 prompt、secret fixture、Authorization、API key、完整 memory/context 正文均不存在；聊天 transcript 仍完整显示原有 item，Monitor 只显示摘要。

- [ ] **Step 6: 勾选总路线 M2**

只有本任务所有自动化与浏览器场景通过，才在总路线图勾选 M2。失败必须回到对应任务增加回归测试，不创建无因果“收尾修复”。
