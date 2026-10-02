# Goal 任务工作流改造 · 代做任务列表与处理结果

对应计划：`docs/superpowers/plans/2026-09-19-suanlizi-goal-task-workflow-plan.md`
本批次范围：P0（Task / Run / Evidence / 状态机 / Checkpoint / AbortSignal 盘点）。
执行方式：每波次 3 个 agent 并行，处理结果实时改写本文档。

## 1. 代做任务列表

| ID | 任务 | 波次 | 负责 agent | 独占文件 | 状态 |
|---|---|---|---|---|---|
| A | protocol `task.ts` 契约 + zod schema + 兼容性测试 | 1 | Agent-A | `packages/protocol/src/task.ts`、`task.test.ts`、`index.ts`（仅加一行） | ✅ 完成 |
| B | 通用 `taskStateMachine.ts` 抽取，OpsTask 内部复用且零回归 | 1 | Agent-B | `packages/protocol/src/taskStateMachine.ts`、`taskStateMachine.test.ts`、`opsTask.ts` | ✅ 完成 |
| C | AbortSignal / Checkpoint / Blueprint / Evidence 现状盘点 | 1 | Agent-C | 仅本文档 §4 | ✅ 完成 |
| D | storage `taskStore.ts` 四张表 + 启动扫描 + 单元测试 | 2 | Agent-D | `packages/storage/src/taskStore.ts`、`taskStore.test.ts`、`store.ts`（仅装配点） | ✅ 完成 |
| E | runtime `task/` taskLifecycle + planProjection 纯函数层 + Evidence workflow_result 扩展 | 2 | Agent-E | `packages/runtime/src/task/*`、`harness/evidenceLedger.ts` | ✅ 完成 |
| F | API `taskRoute.ts` 基础 CRUD + 状态机服务端校验 + 测试 | 2 | Agent-F | `apps/api/src/routes/taskRoute.ts`、`taskRoute.test.ts` | ✅ 完成 |
| G | Harness 启动自动创建 Task/TaskRun + thread.tags 影子写 | 3 | 主 agent | `services/taskShadowWriter.ts`、`routes/harnessRoute.js` 等 | ✅ 完成 |
| H | 全量校验、接线、交付报告 | 3 | 主 agent | — | ✅ 完成 |
| I | P1-A：web 任务中心只读 UI（features/tasks + components/tasks + taskClient + 测试） | 4 | Agent-I(web) | `apps/web/src/{features/tasks,components/tasks,api/taskClient.ts}` | ✅ 完成 |
| J | P1-B：desktop 任务中心只读 UI 与组件测试 | 4 | Agent-J(desktop) | `apps/desktop/src/{features/tasks,components/tasks,api/taskClient.ts}` | ✅ 完成 |
| K | P1-C：thread.tags↔task 表幂等对账脚本（§14.6）+ 测试 | 4 | Agent-K | `apps/api/src/services/taskReconcile.ts(.test)` | ✅ 完成 |
| L | P1 接线（两端 main.tsx 抽屉）+ 真实浏览器验收 | 4 | 主 agent | 两端 `main.tsx`、两端 `TaskCenterDrawer.tsx` | ✅ 完成（失败路径；带真实数据路径待用户重启 API） |

## 2. 波次间共享契约（由主 agent 冻结，波次 2 依此并行）

- `task.ts` 导出（Agent-A 落地，波次 2 所有人按此引用）：
  `TaskStatus`、`TaskRunKind`、`WorkflowKind`、`Task`、`TaskRun`、`TaskStepStatus`、`TaskStep`、`TaskPlanVersion`、`PendingUserInput`、`ReplanPolicy`、`WorkflowRuntimeLimits`、`DEFAULT_WORKFLOW_RUNTIME_LIMITS`、`WorkflowRunStatus`、`WorkflowUsage`、`WorkflowAgentCall`、`WorkflowRunRecord`、`WorkflowEvidenceSource`、`WorkflowScriptRequest`、`TaskGoalStatusResponse`、`TASK_RUN_STATES`、`TASK_RUN_TRANSITIONS`、`TASK_RUN_TERMINAL_STATES`、`canTransitionTaskRun`、`assertTaskRunTransition`、`TASK_STATUS_TRANSITIONS`、`TASK_EVENT_NAMES`、`TaskError`、`TaskErrorCode`。
- `TaskStorePort`（存储层对 API/runtime 暴露的接口，Agent-D 实现，Agent-F 以 fake 测试）：

```ts
interface TaskStorePort {
  createTask(task: Task): Promise<Task>;
  getTask(id: string): Promise<Task | null>;
  updateTask(id: string, patch: Partial<Task>, expectedVersion: number): Promise<Task>;
  listTasks(filter?: { threadId?: string; status?: TaskStatus[] }): Promise<Task[]>;
  createRun(run: TaskRun): Promise<TaskRun>;
  getRun(id: string): Promise<TaskRun | null>;
  updateRun(id: string, patch: Partial<TaskRun>, expectedVersion: number): Promise<TaskRun>;
  listRuns(taskId: string): Promise<TaskRun[]>;
  upsertWorkflowRun(record: WorkflowRunRecord): Promise<WorkflowRunRecord>;
  getWorkflowRun(id: string): Promise<WorkflowRunRecord | null>;
  recordAgentCall(runId: string, call: WorkflowAgentCall): Promise<WorkflowAgentCall>;
  updateAgentCall(runId: string, call: WorkflowAgentCall): Promise<WorkflowAgentCall>;
  listAgentCalls(runId: string): Promise<WorkflowAgentCall[]>;
  /** 启动扫描：非终态 Run 无活跃 checkpoint 时标记 interrupted。 */
  recoverInterruptedRuns(isLive: (run: TaskRun) => boolean): Promise<TaskRun[]>;
}
```

- `Task` 与 `TaskRun` 均带 `version: number` 乐观锁字段（复用 §11.1 OpsTask 模式）。
- 【波次 1 后冻结补充】
  - Blueprint 旧状态类型已重命名为 `BlueprintRunStatus`（`@suanlizi/runtime`）；`WorkflowRunStatus` 名字归 `@suanlizi/protocol/task` 独占。
  - `TaskRun.checkpointId` 编码为 `String(Checkpoint.turnId)`（Checkpoint 无独立 id，身份为 threadId+turnId+generation）；恢复读取后必须断言 `ckpt.turnId === run.checkpointId`，不等视为被新 turn 取代，禁止 resume（详见 §4.2）。
  - workflow_result Evidence 的 id 命名空间不得复用 `ev_<itemId>` 模式（ledger 现有 id 硬编码规则），采用 `wev_<runId>_<agentCallId|run>` 前缀（详见 §4.4）。
  - `taskStateMachine.ts` 不经 protocol index 聚合导出，包内按路径 import；波次 2 runtime/api 侧通过 `@suanlizi/protocol` 的 task.ts 具名导出使用状态机。

## 3. 波次 1 处理结果（实时改写）

### 3.1 Agent-A：protocol task.ts（已完成）

- 新建 `packages/protocol/src/task.ts`（886 行，仅 import zod 与 `./types.js`）+ `task.test.ts`（24 用例）；`index.ts` 仅追加 `export * from './task.js';`。
- §2 冻结的导出清单全部落地，另含 `GoalBudgetPolicy`（含 `maxWorkflowRunsPerGoal`）、`TASK_STATUS_TRANSITIONS`、19 项 `TASK_EVENT_NAMES`、13 项 `TASK_ERROR_CODES`、全量 strict zod schema。
- 命名冲突检查：与现有 protocol 导出零冲突；`TaskGoalStatusResponse.evaluation` 直接复用 types.ts 的 `GoalEvaluation`。
- 关键偏差/决策（主 agent 已确认接受）：
  1. `TASK_RUN_TRANSITIONS` 严格按计划 §11.4，**不含 `running → completed` 边**；completed 只能经 paused/blocked 落入。P2/P3 若需直落终态必须回改计划并说明理由。
  2. `DEFAULT_REPLAN_POLICY` / `DEFAULT_GOAL_BUDGET_POLICY` 为实现者补充的合理默认，可被服务端配置覆盖。

### 3.2 Agent-B：taskStateMachine 抽取（已完成）

- 新建 `packages/protocol/src/taskStateMachine.ts`：`TransitionTable<S>`、`createTransitionHelpers`（isState/isTerminalState/canTransition/assertTransition，终态优先）、`validateVersion`/`isVersionMatch`、`deriveRetrySpec`。通用层不反向依赖 opsTask。
- `opsTask.ts` 内部委托通用原语，所有公共导出符号（含别名与错误文案）逐条保持不变；zod schema 未动；`opsTask.test.ts` 未动且 10/10 通过（零回归裁判）。
- `taskStateMachine.ts` 暂不经 `index.ts` 聚合导出（泛化名如 `validateVersion` 有撞名风险），由包内路径引用；波次 2 的 `task.ts` 如需复用可包内 import。

### 3.3 主 agent 合并校验（已完成）

- 撞名处置：Agent-C 发现 Blueprint 旧 `WorkflowRunStatus`（`packages/runtime/src/workflow.ts`，6 值）与协议新 `WorkflowRunStatus`（8 值）同名不同集合。已确认旧名无任何跨包使用者（web/desktop 用本地副本），故将 runtime 侧重命名为 `BlueprintRunStatus`（`workflow.ts` 3 处 + `runtime/index.ts` 再导出 1 处），协议名独占给 Script Workflow。
- 校验命令与结果（均于 d:/suanlizi 执行）：
  - `npx vitest run packages/protocol/src/task.test.ts .../taskStateMachine.test.ts .../opsTask.test.ts .../schemas.test.ts` → 4 files / 49 tests 全通过。
  - `npx vitest run packages/runtime/src/workflow.test.ts` → 20 tests 全通过。
  - `npx tsc --noEmit -p packages/protocol/tsconfig.json` → exit 0。
  - `npx tsc --noEmit -p packages/runtime/tsconfig.json` → exit 0。
- Agent-C 盘点结论中的 4 项实现约束已纳入波次 2 任务书：checkpointId 编码为 `String(turnId)` 且恢复时断言 turnId 相等；Evidence id 命名空间 `ev_<itemId>` 需为 workflow_result 开非-ThreadItem 写入通道；GoalEvaluator 不校验 evidence id 存在性（P3 gate 修复项）；recoverInterruptedRuns 挂 `server.ts` listen 回调与 recoverOpsTasks 并列。

## 4. 现状盘点（Agent-C 填写）

### 4.1 AbortSignal 取消链现状

盘点基线：`packages/runtime/src/agent.ts`（7842 行）、`harness/taskHarness.ts`、`harness/harnessContext.ts`、`packages/tools/src/registry.ts`、`apps/api/src/services/harnessRuntime.ts`、`packages/sandbox/src`。检索词：AbortController / AbortSignal / interrupt / stopping / pendingInterrupts / cancel / kill。

**链路实况（按传播顺序）**

| 环节 | 位置 | 事实 |
|---|---|---|
| 根 controller 创建 | `apps/api/src/services/harnessRuntime.ts:63` | 进程内唯一根创建点 `const abortController = new AbortController()`；`:68` 以 `run(abortController.signal)` 启动；入口在 `routes/harnessRoute.ts:197-216` 把 signal 透传给 `agent.runHarness(threadId, input, { signal, harnessRunId })` |
| 内部 controller | `packages/runtime/src/state.ts:64-66` | `ThreadRuntimeState.cancelController`（per-thread）；`:167-183 startTurn` 创建并 abort 旧 controller；`:230-239 interruptTurn` → `status='stopping'` + `pendingInterrupts.push` + `abort()`；`:313-330 delete/deleteAll` 也 abort |
| 两路合成 | `agent.ts:7762` | `combineAbortSignals(external, internal)`；`runTurn` `:2627`、`resumeRunning` `:1484` 合成 `effectiveSignal` 并传入 `agentLoop`（`:2704`） |
| 模型流 | `agent.ts:3213-3236`、`:3327`、`:3358` | signal 进入 `RuntimeModelRequest`，`requestSignal = effectiveRequest.signal ?? signal`，abort 后抛 `'Turn cancelled'` — **穿透正常** |
| 循环边界 | `agent.ts:2956`、`:3721` | 仅在迭代顶部与工具批开始前检查 `signal.aborted`，无 mid-await 抢占 |
| **工具执行（断点）** | `agent.ts:3908` | `ToolContext.signal = this.stateManager.get(threadId).cancelController?.signal` — 只绑内部 controller，**外部根 signal 与 harness signal 完全不穿透工具**；同样缺陷在 `:2360`（preflight document reads） |
| 工具层自身 | `packages/tools/src/registry.ts:80-82`、`:244-255`、`:271-286` | 契约支持 `ctx.signal`；内部自建 controller 转发外部 signal + `withTimeout(tool.timeoutMs ?? 60_000)`；abort 时 **返回 `status:'failed'` code `TOOL_CANCELLED`，不抛异常**，agentLoop 视其为普通工具失败继续下一轮。`builtin.ts:447/1025` 把 `ctx.signal` 交给 `runShellCommand`，`:526/1087` abort→`child.kill()` |
| **子代理（断点）** | `agent.ts:4799`、`:4851`、`:4907` | `childAgent.runTurn(childThreadId, {type:'text',...})` **第三参数 signal 缺省**；父→子取消只走 `interrupt()` 内 `:1315-1348` 的递归 `:1326 childAgent.interrupt(childThreadId)`，外部 abort 不会触发它 |
| **harness 循环（断点）** | `harness/taskHarness.ts:285` | `while (goalTracker.canContinue())` **无 `signal?.aborted` 检查**；signal 只在 `:280/:311/:326/:395` 的 runTurn 与 `:339-345` evaluator 处使用；主循环无 try/catch，abort 抛出后 `:214` 的 ledger 汇总与状态落盘不执行 |
| harnessContext | `harness/harnessContext.ts` 全文 | 无任何 signal/abort（纯同步裁切：`buildIterationContext:218-252`、`trimToBudget:308-347`、`renderHarnessContextSlice:393-445`），不是断点 |
| **取消 API（断点）** | `harnessRuntime.ts:127-136` | `cancel(runId)` 仅标 `runtimeStatus='cancelled'` + `abortController.abort()`，**不调 `agent.interrupt(threadId)`** ⇒ 不写 stopping checkpoint、不填 `pendingInterrupts`、不发 `thread.runtime.updated`；`:141-147 cancelByThread`、`:152-160 abortAll`、`server.ts:1044-1048` 优雅退出同样只 abortAll |
| **持久化写入（断点）** | `agent.ts:6205`、`:6167-6185` | `await store.appendCheckpoint(...)`、`saveTurn`、`persistItems` 全链路无 signal 形参，abort 后仍会写完；`interrupt()` 的 stopping checkpoint 是 `:1337-1346 void this.writeCheckpoint(...).catch(()=>undefined)` **fire-and-forget**，进程退出可能丢失 |
| resumeRunning | `server.ts:961` | `agent.resumeRunning(threadId, input)` **不传 signal** ⇒ 用户点"继续"后的新 turn 脱离任何注册表，无法再被 cancel |
| sandbox | `packages/sandbox/src/*` | grep AbortController/AbortSignal/kill/cancel/interrupt **零命中**；只有 approval/preset 策略，取消能力完全依赖上层传下来的子进程 kill |
| 可复用范式 | `apps/api/src/services/opsTaskRunner.ts:402-418`、`:540-542` | `abortable()` 包装 + `deadlineController` + forwardAbort + `:208-253` 子进程 kill — 现成的正确取消骨架 |

**结论**

- 现有链路只有三段中的中间一段完整：`API registry → runHarness signal → runTurn effectiveSignal → 模型流`；到工具、到子代理、到 harness 迭代边界、到持久化写入这四点是断的。
- 更本质的问题是**取消语义被拆成两套互不知晓的机制**：外部 `AbortSignal`（只中断模型流）与内部 `cancelController`+`interrupt()`（才真正写 stopping checkpoint 与 `pendingInterrupts`）。只 abort 不 interrupt ⇒ 进程重启后无法区分"用户取消"与"崩溃"。
- 工具取消当前是**软失败**（返回 failed item 继续跑），不是中断；这对 TaskRun「取消即停止产生副作用」的语义是不成立的。

**P0 设计项（TaskRun/Workflow 必须按此新建，不能沿用现状）**

1. 单一根 signal 约定：TaskRun 级 controller 注册表（照 `harnessRuntime.ts` registry 形状），signal 逐级 `combineAbortSignals` 传递 TaskRun → WorkflowRun → `agent()` 调用 → 子代理，任何一级不得丢弃形参。
2. 取消 = interrupt + abort 双写：所有外部取消入口必须先 `agent.interrupt(threadId, reason)`（落 stopping checkpoint / `pendingInterrupts` / runtime.updated）再 `abort()`，与 §11.2 恢复顺序对齐。
3. 每个等待点都要有 abort 出口：模型流、工具执行、持久化写入、harness 迭代边界、workflow `parallel/map` 屏障、agent 并发信号量等待。
4. 终态迁移幂等单点：只在 signal 触发的 catch/finally 里做一次 TaskRun 终态写入，避免"取消后仍写 completed"（§14.3 明确禁止）。

**P2 修复项（既有代码，可独立落地，按代价升序）**

- `harnessRuntime.ts:127-136` `cancel()`/`abortAll()` 补 `agent.interrupt(threadId)`（最小代价、最大收益）。
- `server.ts:961` `resumeRunning` 传入登记过的 signal。
- `taskHarness.ts:285`（及 `:432+` resumeHarness 同形循环）循环顶部加 `if (signal?.aborted) break`，并用 try/finally 保证 `ledger` 汇总与 `goalTracker.persist` 在 abort 时仍执行。
- `registry.ts:271-286` 把 `TOOL_CANCELLED` 提升为可区分的取消语义（新增 `status:'cancelled'` 或抛 `isTurnCancelledError` 可识别的错误），使 agentLoop 能停止而非重试。
- `agent.ts:3908` / `:2360` 的 `ToolContext.signal` 改传 `effectiveSignal`：需把 effectiveSignal 形参化贯穿 `executeToolCall` / `executeToolCallBatch` / `executePreflightDocumentReads`（触及面较大，P2 重点）。
- `agent.ts:4799/4851/4907` 子代理 `runTurn` 补 signal 实参，并在 `childAgentsByParent`（`:437-438`）注册处让父 abort 联动子 `cancelController`。
- checkpoint/turn 写入路径增加 abort 前置检查或改为可 await 的关闭序列（配合 graceful shutdown，避免丢 stopping checkpoint）。
- `packages/sandbox/src` 若要在 P2 真正停沙箱副作用，需新增 signal/cancel 形参（当前零取消面）。

### 4.2 Agent Checkpoint 整合点

**符号与实际读写点**

| 符号 | 定义 | 读 | 写 |
|---|---|---|---|
| `Checkpoint` | `packages/protocol/src/types.ts:1509-1520` | `getRuntimeState` `runtime/src/agent.ts:1278-1312`；`getLastCheckpoint` `storage/src/store.ts:954-987` | `writeCheckpoint` `agent.ts:6187-6206`（`:6205` 唯一 store 调用） |
| `CheckpointLine` | `types.ts:1523-1534` | `store.ts:969` 反扫匹配 | `store.ts:920-937` 以 `{type:'__checkpoint__'}` 追加进 rollout JSONL |
| `CheckpointStatus` | `types.ts:1537` = `running\|stopping\|waiting_user_input\|terminal\|completed\|interrupted\|failed\|stale` | `agent.ts:1284-1301` 冷启动推导 | 见下方状态写入点 |
| `ThreadRuntimeState` | `types.ts:1540-1550` | `state.ts:85-87 lastCheckpoint` | `state.ts:167-257` |
| `RUNNING_CHECKPOINT_TTL_MS` | `agent.ts:136` = `30 * 60 * 1000` | `agent.ts:1281`（stale 判定）、`:6167-6185`（算 `expiresAt`） | — |
| `getLastCheckpoint` | 接口 `store.ts:221`；实现 `:954-987` | `agent.ts:1278+`、`server.ts` 状态序列化 | **只有 threadId 入参，返回该 thread 最后一条** |

checkpoint 状态写入点全表：`running` 初始 `agent.ts:2631`、每个工具批之后 `:3154-3157`、running 心跳刷新 `:6167-6185 refreshRunningCheckpoint`；`waiting_user_input` `:1376-1379`；`stopping` `:1337-1346`；终态 `completed:2713` / `interrupted:2737,2765` / `failed:2804`；子代理 `interrupted:5110-5118`。压缩与可见性：`store.ts:1305-1350 keepLastCheckpoints`、`:881` item 读取时跳过 `__checkpoint__`/`__rollback__`、`:2108-2115` checkpoint 类 item 按 `turnCount <= activeTurnCount` 过滤（rollback 感知）。API 侧暴露：`server.ts:183`、`:189` 序列化 `pendingInterrupts` / `hasCancelController`。

**checkpointId 该指向什么（计划遗留问题，需定案）**

- 事实：`Checkpoint` **没有独立 id 字段**（`types.ts:1509-1520` 全量字段为 threadId/turnId/itemIndex/timestamp/generation?/status?/expiresAt?/decisionRequest?/executionStatus?）。身份是 **(threadId, turnId)** 复合，同一 turn 内多次快照靠 `generation`（`agent.ts:6167-6185`）区分，而 store 只有 `getLastCheckpoint(threadId)` 一个读取入口 —— 无法按 generation 取历史快照。
- 结论：`TaskRun.checkpointId`（`protocol/src/task.ts:205`，schema `:790`）应编码为 **`String(turnId)`**，threadId 由 `TaskRun.threadId` 提供；不要臆造独立 id，也不要引入新表。需要精确到快照序号时使用复合 `"${turnId}:${generation}"`，但恢复逻辑仍只能校验 turnId（因为无法按 generation 回读），所以 **推荐只用 turnId**。
- 恢复校验：`getLastCheckpoint(run.threadId)` 后必须断言 `ckpt.turnId === run.checkpointId`；不等 ⇒ 该 thread 之后跑过新 turn，本 run 已被取代，走终态/interrupted 分支，**严禁** resume。
- ⚠ 命名冲突（必须处理）：run-monitor 域里已存在另一个 `checkpointId`，语义是 trace span id：`agent.ts:2189` `checkpointId: String(metadata.checkpointId ?? spanId)`、`:2226` 附近。与 Agent Checkpoint 无关；`task_runs` 字段与前端展示必须改名或在各自域内隔离，否则 §14.9 事件目录会混。

**§11.2 恢复顺序 → 现有字段映射**

| §11.2 分支 | 判据（全部来自 `getLastCheckpoint`） | 动作 |
|---|---|---|
| `running` 且未过期 | `status==='running' \|\| 'stopping'`，`Date.now() < expiresAt` | 有活跃 controller（`state.ts:64-66`）则跳过；否则 `resumeRunning(threadId, undefined, signal)` |
| `stopping` | `pendingInterrupts.length > 0`（`types.ts:1540-1550`） | 不再 resume，直接落 `interrupted` 终态 |
| `waiting_user_input` | `status==='waiting_user_input'` 且 `decisionRequest` 非空（`agent.ts:1310`） | 还原 pending decision 给 UI，TaskRun 置 `waiting_user` |
| terminal | `status ∈ {terminal, completed, interrupted, failed}`（**四个值，不是单一 terminal**） | 直接回写 TaskRun 对应终态，不 resume |
| stale | `status==='stale'`：`agent.ts:1281` 按 `expiresAt` **读时派生**（checkpoint 里从未被写出） | 视为崩溃遗留 → `recoverInterruptedRuns` 标 `interrupted` |

**恢复扫描挂载点**

- 现成位点：`apps/api/src/server.ts:1022 server.listen(port, () => { ... })`，内部 `:1035 void recoverOpsTasks({...})`。`TaskStorePort.recoverInterruptedRuns(isLive)`（契约见本文档 §2 `task.ts:42`）应与 `recoverOpsTasks` **并列**放在同一 listen 回调，形状照抄（fire-and-forget + 日志 + 不阻塞端口就绪）。
- 服务装配位置：`server.ts:122-129 adaptAgentLoopToPort` 一带是端口适配装配区；`harnessRuntime.ts:185` 是进程单例注册表 —— TaskRun registry 应同样单例化，供 `isLive` 查询。
- `isLive` 判据现状：只有进程内 `ThreadStateManager.instance()`（`state.ts:337-342` 单例）与 `harnessRuntimeRegistry.listByThread`（`harnessRuntime.ts:120`）可查，**没有任何共享 lease/心跳表**（`run_records` 亦无，`store.ts:421-453`）。

**对 P0/P2 的约束**

- P0：`task_runs` 不得成为第二套恢复真相 —— 只镜像 `Checkpoint`（`task.ts:197-205` 注释已如此约定，落地时以 §11.2 顺序实现，checkpoint 为唯一真源）。
- P0：`checkpointId` 编码规则（turnId，`"threadId:turnId"` 拼接还是裸 turnId）必须由主 agent 冻结进 `task.ts` 注释，因为 `taskRunSchema`（`:785/:790`）已导出；本文档建议 **裸 `String(turnId)` + 冗余 `thread_id` 列**。
- P0：恢复扫描必须同时覆盖 goal 类（关联 `harnessRunId`，`task.ts:186`）与 workflow 类（`workflowRunId`/`workflowKind`，`:188/:191`）两种 run，且 `kind='goal'` 时 `workflowKind` 必须缺省的约束要在恢复路径中校验。
- P0：单进程假设必须显式写进文档与代码注释；若未来多实例部署，需要给 `task_runs` 加 lease/heartbeat 列（现状零机制）—— 否则两个进程会同时 resume 同一 thread（**未验证**：仓库是否存在多实例部署形态）。
- P0：`resumeRunning` 在恢复路径中**必须传 signal 并登记**，否则重演 §4.1 的 `server.ts:961` 脱管问题。
- P2：`agent.ts:1284-1301` 的冷启动 status 推导是"内存无 state 时按最后 checkpoint 猜"，与新加的 TaskRun 恢复扫描职责重叠 —— 建议由主 agent 明确单一归属，避免两处各写一份恢复逻辑（违反 §11.2 的"禁止双份"）。

### 4.3 Blueprint workflow.ts 影响面

**WorkflowDefinition / 运行状态存在哪里（实测）**

| 内容 | 存储位置 | 证据（`apps/api/src/routes/workflowRoute.ts`，916 行） |
|---|---|---|
| 定义+快照**主存储** | `thread.tags['workflow']`（JSON 字符串） | `:34 THREAD_WORKFLOW_TAG='workflow'`；读 `:64-75`；优先级 `:98-107`（tags 优先） |
| 快照冗余副本 | ThreadItem `type:'workflow_checkpoint'` | 双写 `:111-127`；item id `:184 workflow_checkpoint_${Date.now()}_${rand}` |
| 组件注册表 | `settings['workflow.components.v1']` | `:35 WORKFLOW_COMPONENTS_KEY`；`:39-46` 读 settings |
| 运行审计 | `run_records` + `run_events`，`kind:'workflow'`、`caller:'workflow'`、`turnId:null` | `:776-840 persistWorkflowRunAudit`、`:795 kind:'workflow'`、`:817 createRunRecord`；状态映射 `:842-849`（`cancelled` → run_records 里写成 `interrupted`） |
| 类型与编译 | `packages/runtime/src/workflow.ts`（1919 行） | `WorkflowRunStatus :4`、`WorkflowDefinition :79`、`WorkflowSnapshot :114`、`WorkflowComponentRegistry :235`、`createWorkflowDefinitionFromGoal :453`（id 生成 `:472`）、`WorkflowRuntimeAction :200`、`compileWorkflowBlueprint :665` |

**运行模型事实**

- `workflowRoute.ts:253-435` 的**全部 action（run / test_run / run_node / publish / cancel / resume）都在 HTTP 请求内同步执行完毕**才返回：无后台 run 注册表、无 AbortSignal、无跨请求续跑、无 agent() 语义（只跑已注册组件）。
- 所以 `:230-237` 的 cancel/resume 只是**改写 tags 里的状态字段**，不存在"真正被中断的执行"；`runs/:runId/resume|cancel` 的 runId 校验方式是比对 URL 段 `:615-625 workflow.run.id !== segments[5]`。
- 一致性风险：`store.ts:1435-1478 createRunRecord` 是 `INSERT OR REPLACE`，主键 `(tenant_id, run_id)`（`:421-453`）—— run_id 撞车即静默覆盖审计行。
- tags 是"真相"：`store.ts:2108-2115` 让 `workflow_checkpoint` item 随 thread rollback 消失，而 tags 不会 ⇒ 副本可能滞后，读路径已按 tags 优先（`:98-107`）处理。

**结论：Script Workflow 落 `workflow_runs` 新表与现有 Blueprint 不冲突 —— 但有 5 条硬约束**

1. **不得复用 `run_records` 的 run_id 空间**：新表 + 独立前缀（建议 `wfrun_`），并在记录上带 `workflowKind`（`protocol/src/task.ts:191` 已有该字段，`kind='goal'` 时必须缺省）以在数据层区分 blueprint/script（`task.ts:73-76 WORKFLOW_KINDS`）。
2. **不得写 `thread.tags['workflow']`**：那是 Blueprint 的**单快照槽位**（一个 thread 只能存一个 workflow），Script 必须走新表。
3. **不得复用 `workflow_checkpoint` item type**，避免被 `store.ts:2108-2115` 的 rollback 过滤波及。
4. **`WorkflowRunStatus` 命名冲突已真实存在，需主 agent 定案**：`runtime/workflow.ts:4` 是 6 值（`planned\|running\|completed\|failed\|blocked\|cancelled`），`protocol/task.ts:438-449 WORKFLOW_RUN_TRANSITIONS` 是 8 值（`queued\|running\|paused\|blocked\|interrupted\|completed\|cancelled\|failed`）且已在波次 1 冻结导出。二者同名不同集合 ⇒ 建议 Blueprint 侧改名 `BlueprintRunStatus` 并在 workflow.ts 内保留映射；若不改，runtime 侧 `import { WorkflowRunStatus }` 将二义。（**未验证**：`packages/runtime/src/workflow.ts` 是否已 import protocol 的同名类型 —— 当前只 grep 到本地定义 `:4`。）
5. **并发争用**：Blueprint 是请求内同步、TaskRun/Script 是后台异步，二者可能在同一 thread 上并发 ⇒ 共用一个 `state.ts:64-66 cancelController`。P0 需在 TaskRun 启动前做互斥检查，可照抄 `harness/goalTracker.ts:283-290 canStartNewHarness` 的 tags 互斥范式（但按约束 2，互斥标记不得写在 `tags['workflow']`）。

**对 P0 的补充约束**

- Script Workflow 的 `compileWorkflowBlueprint`（`workflow.ts:665`）、`WorkflowComponentRegistry`（`:235`）、`settings['workflow.components.v1']` 整条组件面**不可复用**（受限 JS 没有组件图），因此 P0 只在 storage/protocol 层交汇，runtime 层新增 `task/workflowRuntime.ts` 独立实现即可 —— 这也是任务 E 的独占文件边界成立的前提。
- Blueprint 现有 `publishedDefinition` / `publication` / `history`（见 `workflowRoute.ts:374` 组装）与 Script 的 `scriptHash`（`task.ts:417-418` 批准后固化、运行期禁改）语义正交，合并展示层需要 `workflowKind` 分栏，不能塞进同一状态机。

### 4.4 Evidence 承载现状与 workflow_result 扩展点

**先纠一处计划里的措辞**：`packages/protocol/src/**` 中 grep `HarnessEvidence|interface Evidence|EvidenceReceipt` **零命中** —— protocol 层没有任何 Evidence 类型。真实形态是 runtime 私有的 `EvidenceReceipt`（**计划 §11.3 引用的名字应为 `EvidenceReceipt`**）。

**Evidence 的真实形态**

| 形态 | 定义 | 关键字段 / 说明 |
|---|---|---|
| `EvidenceReceipt` | `packages/runtime/src/harness/types.ts:88-100` | `id, threadId, turnId, itemId, harnessRunId, kind, summary, refs, supportsCriteria, status, timestamp` ⇒ §11.3 所说的**强绑 threadId/turnId/itemId 属实**，且还多绑一个 `harnessRunId` |
| `EvidenceReceiptKind` | `types.ts:67-74` | `tool\|file_change\|command\|test\|checkpoint\|mcp\|error`；其中 `test`、`checkpoint` **从未被 ledger 产出**（见下 switch） |
| `EvidenceReceiptStatus` | `types.ts:77` | `passed\|failed\|unknown` |
| `EvidenceReceiptRefs` | `types.ts:80-85` | 仅 `path?/command?/toolName?/hash?` —— 装不下 runId/agentCallId |
| `HarnessPlanNode.evidenceIds` | `types.ts:42` | 节点→证据引用 |
| `HarnessState` 无 evidence 字段 | `types.ts:50-62` | 证据不进 HarnessState，只进 thread.tags 的 plan 里的 `evidenceIds` |
| 另两套**独立**形态（勿混淆） | `protocol/src/opsTask.ts:236-247`、`protocol/src/runTrace.ts:12/:68` | `OpsTaskEvidence`（`source: replay\|local\|ssh\|service\|log`、`status: complete\|partial\|timed_out\|stale`、`contentHash`、`detectorVersion`、`redactionVersion`，配合 `OpsTaskClaim.evidenceIds :225`）；run_trace 的 `category:'evidence'` + payload `{kind,label,passed?}`（仅监控 UI） |

**EvidenceLedger 的实际行为**（`harness/evidenceLedger.ts`，406 行）

- **纯内存**：`:103-109` 三个 Map 索引（`:105 private receipts: Map<string, EvidenceReceipt>`），**无任何 store 写入路径**；所谓"持久化"只有 `:376-397 rebuildFromThreadItems` 冷启动重放。
- id 生成：`:177 const id = \`ev_${item.id}\`` ⇒ **Evidence id 与 ThreadItem id 一一对应**，这是 workflow_result 扩展的最大结构性约束（`protocol/src/task.ts:404-409` 明确 WorkflowAgentCall "不保证存在 turnId / itemId"）。
- 产出通道：`:160-168 recordTurn` → `:172-257 buildReceipt`，switch 只覆盖 5 类 item：`tool_call:183`、`command_execution:198`、`file_change:213`、`mcp_tool_call:226`、`error:241`，**default → null（不产证据）**；`turnId` 在 `:163` 被外层强制覆写。
- 校验缺失：`:355-364 applyCriteriaMap` 对模型给出的未知 evidence id **静默忽略**；`:319 getRecentEvidence(limit)` 无任何 kind 过滤能力。
- `supportsCriteria` 由 `deriveSupportsCriteria(item, this.currentCriteria)`（`:180`）**启发式文本匹配**得出，不是证明。

**谁在读 evidence**

- `GoalEvaluator`（`harness/goalEvaluator.ts`）：入参 `evaluate(goal, state, recentItems, evidenceReceipts, {signal})` `:48-73`；`:102-110` **只把 receipts 渲染成 prompt 文本行** `- [status] kind: summary (supports: …)`；`:123-134` 要求模型回 `criteriaEvidenceMap`；`:191-200` 解析该 map（**不校验 id 是否存在**）；`:229-240` fail-closed。⇒ 结论：**evaluator 侧证据可被模型幻觉**（伪造 evidenceId 即可通过）。
- 证据集合来源：`harness/taskHarness.ts:343` 与 `:530`（resumeHarness 路径）`ledger.getRecentEvidence(20)`；`:634 getRecentEvidence(10)`。
- `ReadinessCritic`（`harness/readinessCritic.ts`）：`checkMutationVerified :104-125` 用 `getRecentEvidence(50)` 且**按 `kind==='command'` + `isVerificationCommand(refs.command)` 硬编码过滤**；`checkCriteriaEvidence :141-157` 用 `ledger.size()===0` 时**直接放行为 true**（"defer to evaluator"）。
- `GoalTracker`（`harness/goalTracker.ts`）：**完全不读 evidence**，只管 `HarnessState`；持久化在 `:233-250 persist`（先 `getThread` 读旧 tags 再 merge 全量替换）写 `thread.tags['harnessState:<runId>']` + `activeHarnessRunId`（常量 `:24-29`），读在 `:256-275 load`，互斥在 `:283-290`。
- `harnessContext.ts:270` 用 `getRecentEvidence(maxItems*2)` 填 `HarnessContextSlice.evidenceRefs`（`types.ts:118`）。

**新增 `workflow_result` Evidence 必须动的清单**

| # | 位置 | 改动 |
|---|---|---|
| 1 | `harness/types.ts:67-74` | `EvidenceReceiptKind` 加 `'workflow_result'` |
| 2 | `harness/types.ts:80-85` | `EvidenceReceiptRefs` 加 `runId?: string; agentCallId?: string`（对应 `task.ts:432-434 WorkflowEvidenceSource` 两分支：`workflow_run` / `workflow_agent_call`） |
| 3 | `harness/evidenceLedger.ts:160-257` | 现有 `recordTurn/recordItem → buildReceipt` 以 ThreadItem 为唯一入参，必须新增**不经 ThreadItem** 的写入通道（如 `recordWorkflowResult(...)`），且 id 不能再是 `ev_${item.id}` —— 建议 `ev_wfr_${agentCallId}`，agentCallId 本身已是确定性 hash（`task.ts:381-385`） |
| 4 | `harness/evidenceLedger.ts:376-397` | `rebuildFromThreadItems` 无法重建非 item 来源证据 ⇒ 必须加第二重建源（推荐：从 `workflow_runs`/agent_calls 表重建，接口签名需扩；备选：在 thread 上落一个可重放的 ThreadItem，但会污染会话可见性，`types.ts:133-141 RunTurnOptions.visibleToUser` 可控）。**这是 P0 必须先定的设计决策** |
| 5 | `harness/evidenceLedger.ts:355-364` + `goalEvaluator.ts:191-200` | 补"`criteriaEvidenceMap` 中的 id 必须存在于 ledger"校验（未知 id 拒绝/告警），否则 §11.3"证据不可幻觉"不成立 |
| 6 | 物化点（任务 E 的 `runtime/src/task/*`） | 按 `task.ts:398-403`：Evidence 物化失败 ⇒ WorkflowRun 必须 `failed`，不得降级为文本总结；需在 `WorkflowAgentCall` 成功回调同事务写 `evidenceId`，并发 `workflow.evidence.created` 事件（`task.ts:535`）、错误码 `WORKFLOW_EVIDENCE_MATERIALIZATION_FAILED`（`task.ts:569`） |
| 7 | `harness/readinessCritic.ts:104-125`、`:141-157` | `checkMutationVerified` 的 kind 白名单不含新 kind；`checkCriteriaEvidence` 在 `ledger.size()===0` 时无条件放行 ⇒ 若 workflow 是唯一证据来源，gate 形同虚设，需一并收紧 |
| 8 | `harness/taskHarness.ts:343`、`:530`、`harnessContext.ts:270` | 若希望 evaluator 稳定看到 workflow 证据，需给 `getRecentEvidence` 加 kind 过滤或提高 limit（当前 20 条窗口可能把 workflow_result 挤掉） |

**P2 修复项**

- `test` / `checkpoint` 两个 kind 长期无人产出（`types.ts:71-72` vs `evidenceLedger.ts:182-257`）⇒ 要么补齐（例如 `command_execution` 且 exitCode=0 且命令命中 `isVerificationCommand` 时派生 `test`），要么删除，避免 evaluator prompt 里出现空洞的 kind 承诺。
- ledger 纯内存 + 重启后依赖 `rebuildFromThreadItems`：若重建源不全，`resumeHarness`（`taskHarness.ts:432+`）会让 evaluator 看到空证据列表并 fail-closed 判 `continue` ⇒ 表现为"重启后无限续跑"，目前仅靠 `maxContinuations`（`types.ts:206-212`）兜底。
- `deriveSupportsCriteria` 的启发式文本匹配（`evidenceLedger.ts:180`）与 `applyCriteriaMap` 的静默忽略组合起来会让 `supportsCriteria` 与真实支撑关系漂移，建议 P2 改为只信 `applyCriteriaMap` 且带校验。
- **未验证**：`packages/protocol/src/task.ts` 中 `TaskStep.evidenceIds`（`:104`、`:262`、`:508`）与 `EvidenceReceipt.id` 的 id 命名空间是否已约定一致（`task.ts` 里出现的是示例值 `'ev-1'`，而 ledger 产出 `ev_<itemId>`）；需主 agent 冻结格式，否则 §11.2 的 `claimed/verified` 投影（`task.ts:219-224`）会因查不到证据而全部退化为 `claimed`。

## 5. 波次 2 处理结果（实时改写）

### 5.1 Agent-D：storage taskStore（已完成）

- 新建 `packages/storage/src/taskStore.ts`（771 行）+ `taskStore.test.ts`（19 用例）；`store.ts` 仅 +12 行装配（`initSchema` 末尾调 `ensureTaskStoreSchema`，幂等迁移 version 7）；`storage/index.ts` 导出 `SqliteTaskStore`。
- 四张表按计划 §6.2 DDL + 必要增列：`tasks.run_ids/version/interaction_mode`、`task_runs.workflow_kind/version`、`workflow_agent_calls.evidence_id/thread_item_id`（均为 §5.1/§11.3 已冻结字段的持久化，纯增量）；不加 tenant_id（§6.2 DDL 无此列，单用户定位）。
- `checkpointId` 按盘点 §4.2 冻结为裸 `String(turnId)`；恢复比较用 `String(ckpt.turnId) !== String(run.checkpointId)`（修正盘点原文 `Number(...)` 写法——TurnId 实为 string）。
- `recoverInterruptedRuns` 七分支决策表（被取代→interrupted / 活跃未过期→skip / 无 ckpt→interrupted / terminal→completed|failed / interrupted|stale→interrupted / waiting_user→blocked / 其余→interrupted），只镜像 checkpoint，不写第二份真相。
- 测试：taskStore 19 + store 19 零回归；storage tsc exit 0。

### 5.2 Agent-E：runtime task 模块 + Evidence 扩展（已完成）

**新增文件（只落在 `packages/runtime/src/task/`）**

| 文件 | 职责 | 关键导出 |
|---|---|---|
| `task/taskLifecycle.ts` | Task/TaskRun 生命周期纯编排，只吃注入的 `TaskStorePort`（类型来自 `@suanlizi/protocol`，**零 `@suanlizi/storage` 依赖**） | `createTaskWithRun` / `findActiveTask` / `transitionRun` / `transitionRunOfTask` / `transitionRunAndSyncTask` / `completeRun` / `syncTaskFromRun` / `applyTaskSyncFromRun` / `createRetryRun` / `blockForUserInput` / `resolveUserInput` / `attachTaskEvidence` / `newTaskId` / `newRunId` / `TASK_NON_TERMINAL_STATUSES` |
| `task/planProjection.ts` | §14.2/§12.2 投影纯函数（不接存储、不依赖端口） | `projectPlan` / `projectPlanWithDiff` / `diffPlans` / `deriveStepId` / `deriveStepStatus` / `ReplanGate` / `createReplanGate` / `trackClaimedProgress` / `claimedSignatures` / `stepProgressSignature` / `claimedStallExceeded` |
| `task/taskLifecycle.test.ts` | 注入 `FakeTaskStorePort`（自带严格乐观锁）37 用例 | 建 Task/Run、active 冲突、非法迁移、终态幂等、retry、block/resolve、completeRun |
| `task/planProjection.test.ts` | §14.7 要求全覆盖 36 用例 | 引用不存在 id / 自带 id / 非法状态被拒；claimed-verified 派生全表；diff；ReplanGate 冷却与预算；skipped 不可由模型声明 |
| `task/workflowEvidence.test.ts` | workflow_result 通道 + 双重建源 17 用例 | id 规则、幂等写入、kind 过滤、命名空间互不覆盖 |
| `task/runtimeExports.test.ts` | 包入口可加载性 37 用例 | 证明 index.ts 的新导出在运行时真能取到且未分叉 |

**修改文件（仅 3 个，未越界）**：`harness/types.ts`、`harness/evidenceLedger.ts`、`src/index.ts`（后者只追加导出）。

**§4.4 八项清单落地情况**：第 1/2/3/4/8 项已完成；第 5/7 项（`goalEvaluator` 的 criteriaEvidenceMap 校验、`readinessCritic` 的 kind 白名单与 `size()===0` 放行）属 P3 证据 gate，按任务书约束**未动**；第 6 项（WorkflowAgentCall 成功回调同事务物化 Evidence）需 workflow runtime 与 storage 就绪，属下一波次。

**Evidence id 命名空间**：thread item 通道保持 `ev_<itemId>`；workflow 通道固定 `wev_<runId>_<agentCallId>`，run 级用 §2 冻结的 `run` 占位（`wev_<runId>_run`）。注意 §4.4 第 3 项原建议的 `ev_wfr_*` **已被 §2 冻结契约推翻**，本波次按 `wev_` 实施。前缀互斥保证两重建源共存同一 ledger 不互相覆盖；`agentCallId` 禁取 `run`（防 `wev_r_run` 二义）。

**itemId/turnId 形态决策**：`EvidenceReceipt` 改为 `sourceKind: 'thread_item' | 'workflow'` 必填 + `turnId?`/`itemId?` 可选（方案 A），否决 task 模块内平行类型（方案 B）：全仓 grep 证实除 `evidenceLedger.ts` 内部 5 个构造点外无任何读方消费 `receipt.itemId`/`receipt.turnId`，且 `packages/runtime/src/**` 之外（apps/web、apps/desktop、apps/api、其余 packages）**零 `EvidenceReceipt` 引用**，因此影响面仅限本文件；方案 B 会使 GoalEvaluator/ReadinessCritic 在 P3 同时吃两套类型。

**已知协议缺口（已解决，见 §5.4）**：~~`protocol/src/task.ts` 的 `TASK_RUN_TRANSITIONS` 没有任何指向 `completed` 的出边，本波次一度把写入收敛为 `completeRun()` 旁路~~ —— 主 agent 已在波次 2 合并时补边（`running→completed` 与四态→`interrupted`），`completeRun` 已退回 `transitionRun(port, id, 'completed')` 的收敛入口，旁路与 `allowFromQueued` 已删除。

**校验结果**：`npx vitest run packages/runtime/src/task packages/runtime/src/harness packages/runtime/src/taskRuntimeEvents.test.ts packages/runtime/src/agent.test.ts` ⇒ 7 files / 239 tests 全绿；`npx tsc --noEmit -p packages/runtime/tsconfig.json` ⇒ exit 0。

### 5.3 Agent-F：API taskRoute（已完成，待波次 3 装配）

- 新建 `apps/api/src/routes/taskRoute.ts`（600 行）+ `taskRoute.test.ts`（14 用例，内存 fake TaskStorePort，不起 HTTP 服务）。
- P0 端点：GET /api/tasks（threadId/status 过滤）、GET /api/tasks/:id、POST /api/tasks（服务端生成字段，status 入口即拒，active 冲突 409）、GET :id/runs、GET :id/plan-history（真实快照 + `historyIncomplete:true`，不合成假数据）、GET :id/evidence（evidenceIds 原文）、PATCH :id/metadata（乐观锁）。
- 错误响应全部 `{ error: { code, message, details? } }`；路由级补充码 `TASK_REQUEST_INVALID`/`TASK_INTERNAL_ERROR`（`TASK_ROUTE_ERROR_CODES`，未污染 protocol）。
- 主 agent 已处置：`apps/api/package.json` 补声明 `"zod": "^3.24.0"`（与 protocol 包一致，消除对 hoisting 的隐依赖）。

### 5.4 主 agent 合并修正：协议迁移表补边（重要决策）

- 发现：计划 §11.4 迁移表只定义了 completed/interrupted 的出口，**没有任何指向 completed 与 interrupted 的入边**，导致：① GoalRun 成功结束无法表达（Agent-E 一度加 `completeRun` 旁路）；② §11.2 恢复扫描的 `running→interrupted` 只能 bypass；③ 旁路与 D 的真实 store 迁移校验集成时会矛盾（`allowFromQueued` 在真库上必挂）。这是计划表自身遗漏，不补则违反“单一迁移表”目标。
- 修正（`packages/protocol/src/task.ts`）：`queued|running|paused|blocked` 各 +`interrupted` 入边；`running` 另 +`completed`。刻意不补 `queued/paused/blocked → completed`（未运行或已暂停不得直落成功）；`interrupted → completed` 这类事后镜像仍由恢复单点 bypass 承担。
- 同步修正：protocol task.test 全表断言反转 + 新增补边/仍禁止断言；storage test 改 `running→completed` 接受 + 新增 `queued→completed` 拒绝；runtime `completeRun` 删旁路；D 侧恢复注释同步；修掉 taskStore.ts 一处未使用导入。
- 验证（均 d:/suanlizi）：`npx vitest run packages/protocol packages/storage packages/runtime` → 43 files / 578 tests 全绿；`npx vitest run apps/api/src/routes/taskRoute.test.ts` → 14 绿；四包 `tsc --noEmit` 全部 exit 0；eslint 新增代码 0 错误 0 警告。

## 6. 波次 3 与最终校验

### 6.1 主 agent 接线（已完成）

- **存储层入口**：`@suanlizi/storage` 的 `createStore` 现同时返回 `taskStore`（`SqliteTaskStore`），与 `LocalThreadStore` 共享同一 db 句柄，并注入 `threadStore` 作为 `getLastCheckpoint` 恢复读取。
- **API 装配**：`server.ts` 解构 `taskStore`；在 `handleOpsRoute` 之后挂载 `handleTaskRoute`（`/api/tasks`）；`ThreadRouteContext` 新增可选 `taskStore` 并透传给 `handleHarnessRoute`。
- **Harness 影子写（计划 §14.6 影子写期）**：新建 `apps/api/src/services/taskShadowWriter.ts`，`handleHarnessStart` 在 registry 启动后 best-effort 创建 Task + goal Run（推进到 running），并 `attachShadowTaskTracking` 镜像 `entry.promise` 终态（completed→`completeRun`、cancelled/failed→对应迁移 + `applyTaskSyncFromRun`）；`thread.tags` 仍是读优先，task 表只做影子对账。未注入 `taskStore` 时保持既有行为，零副作用。
- **恢复扫描（计划 §11.2）**：新建 `apps/api/src/services/taskRecovery.ts` 的 `startTaskRunRecovery`，在 `server.listen` 回调与 `recoverOpsTasks` 并列 fire-and-forget 调用，`isLive` 由 `harnessRuntimeRegistry.get(harnessRunId)?.runtimeStatus === 'running'` 注入；恢复真相只在 Agent Checkpoint。
- 测试工装：`apps/api/src/testing/fakeTaskStore.ts`（内存 TaskStorePort，带迁移表 + 乐观锁），供 taskShadowWriter / harnessRoute 集成测试复用。

### 6.2 P0 验收（计划 §7 P0 + §14.7）

- ✅ taskStore 单元测试覆盖创建/更新/终态/查询/乐观锁/非法迁移/retry/恢复六分支（`packages/storage/src/taskStore.test.ts`）。
- ✅ API 测试覆盖 404、非法状态迁移、版本冲突、active 冲突、成功响应（`taskRoute.test.ts` 14 用例）。
- ✅ 启动一个 Harness run 后能从 `/api/tasks` 查询到对应 Task（`harnessRoute.test.ts` 新增端到端用例：start → 影子 Task running + goal Run completed，并断言 goal Run 不带 `workflowKind`）。
- ✅ OpsTask 既有全部单元测试零回归（`opsTask.test.ts` 10 绿）；通用状态机 `taskStateMachine.test.ts` 10 绿。
- ✅ Agent Checkpoint 恢复顺序测试覆盖 running/stopping→interrupted/waiting_user_input→blocked/terminal→终态/stale→interrupted（taskStore 恢复分支）。
- ✅ 评估 Blueprint `workflow.ts` 影响面并完成撞名隔离（`BlueprintRunStatus` 重命名），Script Workflow 走独立 `workflow_runs` 表，不冲突（盘点 §4.3 五条硬约束落进 taskStore DDL 与 checkpointId 冻结）。
- ✅ AbortSignal 链路盘点已产出断点清单并区分 P0 设计项 / P2 修复项（盘点 §4.1）；P0 取消链设计约定写入 §2 冻结补充。

### 6.3 最终校验命令与结果（均 d:/suanlizi 执行）

- `npx vitest run packages/protocol packages/storage packages/runtime` → **43 files / 578 tests 全绿**。
- `npx vitest run apps/api/src/routes/taskRoute.test.ts .../harnessRoute.test.ts apps/api/src/services/taskShadowWriter.test.ts .../taskRecovery.test.ts .../harnessRuntime.test.ts` → **5 files / 38 tests 全绿**。
- `npx tsc -b`（根，含所有包增量重建）→ exit 0；`npx tsc --noEmit -p apps/api/tsconfig.json` → exit 0。
- `npx eslint`（本批全部新增/修改文件）→ 0 错误 0 警告。
- `git diff --check` → 干净（仅 CRLF 归一化警告，均来自本批未触碰的文件）。

### 6.4 关于全仓 `npx vitest run` 的 15 个失败（均与本批无关，已逐一归因）

- `apps/api/src/serverStructure.test.ts`：守卫要求 `server.ts ≤ 850` 行，但**基线 HEAD 就是 893 行**，本批开工前该守卫已失败；本批仅净增约 22 行装配（已把恢复扫描从内联收敛为 service 调用以压缩增量）。
- `apps/api/src/shared/tenant.test.ts`：`git status` 证明 `tenant.ts` 与 HEAD **无差异**（本批未触碰），失败是多租户 header 的既有断言与本仓库单用户方向不一致，属仓库既有状态。
- `apps/web`、`apps/desktop` 的 13 个 CSS/主题回归守卫（`desktopShellRegression`、`lightThemeSkin`、`settingsShell`、`topbarActions`、`rightPaneSizing`、`workspaceFilesLayout`、`settingsNavigation`、`agentWorkbenchModel`、`subagents`、`ItemView`）：`git grep` 证明这两个目录**没有任何文件 import 本批模块**（taskStore/handleTaskRoute/taskShadowWriter/taskStoreContract 零命中）。这些是用户未提交的 UI 改动导致的既有失败，与本批正交。
- `tests/electron-*`（全仓运行时的 Electron/Playwright “Process failed to launch!”）：打包产物/桌面二进制在当前环境未启动，属环境依赖，与本批源码无关。

## 7. 遗留风险与未验证项

（滚动更新）

- ~~[Agent-E] 协议状态机缺口~~ —— **已解决（§5.4）**：`TASK_RUN_TRANSITIONS` 已补 `running→completed` 与四活跃态→`interrupted` 入边，`completeRun` 旁路与 `allowFromQueued` 已删除；补边是对计划 §11.4 原表的必要修正，交付时需在总结中向用户声明。
- **[Agent-E] 终态 Task 不可原地 retry**：因 `TASK_STATUS_TRANSITIONS` 终态无出口，`createRetryRun` 对已 `failed/cancelled` 的 Task 抛 `TASK_TERMINAL_STATE`，只能新建 Task；若产品需要「失败后原地重跑」，需主 agent 先定协议级 `retryOf` 字段与迁移边。
- **[Agent-E] 未验证**：`TaskStep.evidenceIds` 与 `EvidenceReceipt.id` 的命名空间一致性已在 runtime 侧固定为「ledger 产出的 `ev_*` / `wev_*` 原值」（`projectPlan` 的 `validEvidenceIds` 直接拿 ledger id）；storage/API 侧落库时不得再加前缀，否则 §14.2 全部退化为 `claimed`。
- **[Agent-E] P3 待接**：本波次 `projectPlan` / `ReplanGate` / `trackClaimedProgress` 均为无入口的纯函数，尚未与 `GoalTracker.updatePlan`、`goalEvaluator.criteriaEvidenceMap`、`readinessCritic` 接线（按任务书约束未改这三个文件）。

### 7.1 P0 交付边界（本次批次）

- **已完成**：仅 P0（Task / Run / Evidence 承载 / 通用状态机 / Checkpoint 镜像恢复 / AbortSignal 盘点 + 设计约定）的代码地基；未启动任何服务进程（需用户自行重启 API 以加载新表和路由）。
- **未开始**（属后续阶段）：~~P1 任务中心只读 UI~~（✅ 已完成，见 §8）、P2 生命周期端点与用户接管（pause/resume/cancel/retry/redirect/input + SSE 终态事件）、P3 计划投影与证据硬校验 gate（claimed/verified 接线 GoalTracker）、P4a/P4b WorkflowScriptRuntime 与批准/监控 UI、P5 恢复与复用、P6 Goal × Workflow 组合。`taskRoute` 中生命周期端点、`WorkflowScriptRuntime`、`/api/tasks/:id/goal-status` 均尚未实现。
- **已知遗留风险**：
  1. ~~影子写期双写…本批未写对账脚本~~ —— **已解决（§8.3）**：`apps/api/src/services/taskReconcile.ts` 提供幂等对账（只读 tags、只写 task 表，3 轮重跑 tags 不变）；尚未接入启动流程/CLI，调用方需自行注入依赖（见 §8.6）。
  2. `recoverInterruptedRuns` 基于单进程假设，无任何 lease/心跳机制（盘点 §4.2）；多实例部署会双重 resume 同一 thread。
  3. `serverStructure.test.ts` 行数守卫在本批前已破（HEAD 893>850）；上 P1 前建议先单独安排一次 `server.ts` 路由拆分（属用户未提交改动的收编，不混入功能提交）。
  4. `interrupted` 仍是非终态：启动扫描可能反复扫到同一 interrupted Run；`decideRecoveryTarget` 已用 target===当前态不回写保证幂等，但 `interrupted → cancelled/failed` 的正式收口属 P2 生命周期端点。
  5. 计划 §11.4 迁移表补边（§5.4）是对计划文档的修正，下次修订计划时应把补边写回 §11.4 正文，避免后续读者再次撞上同一个协议缺口。

## 8. P1 任务中心只读 UI（波次 4，三 agent 并行 + 主 agent 接线）

目标（计划 §7 P1）：先让用户看到真实任务，只读、不提供操作按钮。

### 8.1 Agent-I：web 任务中心（已完成）

- 新建 `apps/web/src/api/taskClient.ts`（5 个 GET 端点，非 2xx 保留服务端稳定 code 如 `TASK_NOT_FOUND`，网络/非法 JSON 抛 `TaskApiError`，不返回假数据）、`features/tasks/taskCenterModel.ts`（纯函数：状态→中文标签+tone、进度=verified/总步数、claimed 标“待补证据”、active 判定、updatedAt 倒序不改入参、空态）、`components/tasks/` 7 个只读组件 + `StatusBadge` + `taskStyles.ts`（局部内联 style + CSS 变量，未动全局 `styles.css`，未改 `Icon.tsx`）。
- 测试：model/render/client 共 35（主 agent 后补重试用例 = 36），零网络依赖；`tsc -p apps/web` exit 0。

### 8.2 Agent-J：desktop 任务中心（已完成）

- 新建 13 个文件；`api/taskClient.ts` 经核对走相对 `/api` 裸 fetch（与 knowledgeClient/threadConfigClient 同构；`desktopBridge` 只承载 Electron 原生能力）；`features/tasks/taskCenterModel.ts` 与 web 锁定同一套规则（独立实现，无跨 app import，16 条跨端一致性断言）；`components/tasks/tasks.css` 局部样式（720px 单列、520px 徽章压缩）。
- desktop `TaskCenter` 自带取数（可注入 `api` 供测试），与 web 展示型设计互补；测试 30 绿（model 16 + render 14），`tsc -p apps/desktop` exit 0。

### 8.3 Agent-K：幂等对账脚本（已完成，§14.6 / §7.1 风险 1 闭环）

- 新建 `apps/api/src/services/taskReconcile.ts`（`reconcileTasksFromTags`）：只读 `thread.tags['harnessState:<runId>']` + Agent Checkpoint 派生目标态，只写 task 表（乐观锁）；`ReconcileThreadStore` 类型面不含任何写方法，从结构上断绝改 tags 的可能；确定性补建 id（`task_reconcile_<harnessRunId>`）+ 同态短路 + BFS 迁移寻路保证幂等；单项失败记 conflicts 不中断整轮。
- 测试 20 绿：含“混合场景跑 3 轮后 tags 快照逐键相等且 fake 写方法调用记录为空”的硬断言；`tsc -p apps/api` exit 0。
- 尚未接入启动流程/CLI（禁改既有文件约束下保留为可注入服务），主 agent 评价：接入属 P2 运维入口范畴，不阻塞 P1 验收。

### 8.4 主 agent 接线（两端 main.tsx）

- 新建两端 `components/tasks/TaskCenterDrawer.tsx`：复用现有监控抽屉外壳类（fixed 遮罩 + z-index 40 面板，主题兼容）；web 抽屉自持取数状态适配展示型 TaskCenter；desktop 抽屉只做外壳包裹自取数 TaskCenter；三种关闭路径（X/遮罩/Escape）。
- 两端 topbar 新增「任务中心」按钮（复用现有 `layers` 图标，插在任务监控旁）；desktop 额外把 `taskCenterOpen` 纳入 `suspendNativeBrowser`，避免被原生 BrowserView 遮挡；跳转回调复用各端 `loadThread`。
- 接线中发现并修复：编辑工具意外将 workflow `effectiveGoal` 模板串里的字面量 `\n\n` 展开为真实换行（行为等价但属噪声），已字节级还原两端；临时修复脚本已删除。

### 8.5 真实浏览器验收（5178 Vite，后端未启动 = 失败路径）

- 首次验收发现真实缺陷：web 错误态无「重试」按钮（desktop 有），违反“失败可接管”——已修：`TaskList` 错误分支加 `onRetry` 重试按钮（抽屉接 `loadList`），补 2 条渲染断言。
- Browser agent 复验（两轮）：topbar 按钮存在且位置正确；抽屉打开、面板不溢出（rect 756×820 ⊂ 视口）、遮罩下聊天输入不可交互、无层间遮挡；错误态可见非空白（“任务请求失败（HTTP 500）：/tasks”）；重试按钮触发新 `GET /api/tasks`；Escape/遮罩/X 三路径全部有效；console 无未捕获异常。
- 截图：`.playwright-cli/accept-initial.png`、`accept-drawer-open.png`、`task-center-retry-check.png`。
- 验收后本次启动的 5178 Vite 已关闭并确认端口释放；未启动/重启任何 API 进程。
- **带真实数据的 happy-path 点击验收（任务列表/详情/进度/跳转）待用户重启 API 后补**（AGENTS §3：代码修改后只提示用户重启）。

### 8.6 P1 校验命令汇总

- `npx vitest run apps/web/src/features/tasks apps/web/src/components/tasks apps/web/src/api/taskClient.test.ts` → 36 绿；desktop 对应 → 30 绿；`apps/api/src/services/taskReconcile.test.ts` → 20 绿。
- `tsc --noEmit`：apps/web / apps/desktop / apps/api 均 exit 0；eslint tasks 目录 0 错 0 警。

## 9. P2 冻结契约（生命周期与用户接管，波次 5 依此并行）

主 agent 前置变更（已完成，波次 5 不得再改 agent.ts）：`AgentLoop.resumeHarness(threadId, { signal })` 已新增（复用 runHarness 的引擎构造 `buildHarnessEngine()`，行为零变化）；`npx tsc -b` 重建已通过。

### 9.1 端点（Agent-M，`taskRoute.ts` 扩展 + 新建 `services/taskLifecycleService.ts`）

所有端点：服务端过 `assertTaskRunTransition`/`assertTaskStatusTransition` 与乐观锁；错误响应 `{ error: { code, message, details? } }`；成功响应 200/202 `{ task, run? }`；每个状态变更向所属 thread 发终态/更新事件（§9.3）。

| 端点 | 前置状态 | 行为 |
|---|---|---|
| `POST :id/start` | Task pending 且无 currentRun（手工建 Task 后） | 新建 goal Run queued→running，经 `createAgent`+registry 起 `runHarness`（复用 taskShadowWriter 追踪）；202 |
| `POST :id/pause` | currentRun running | `agent.interrupt` + abort 当前 harness（双写，§9.2），Run running→paused；harnessState 保留 active（续跑间隔暂停语义） |
| `POST :id/resume` | currentRun paused 或 interrupted | Run →running，起 `agent.resumeHarness(threadId,{signal})` 后台登记 |
| `POST :id/cancel` | currentRun 非终态 | 双写取消 + Run →cancelled（带 error）+ Task 同步 cancelled |
| `POST :id/retry` | Task running/blocked 且 currentRun 终态 | `createRetryRun` 新建 queued Run + 同 start 方式起新 harnessRunId；终态 Task 不得原地 retry（沿用 §7.1 约束，报 TASK_TERMINAL_STATE） |
| `POST :id/redirect` | currentRun running/paused | body `{ instruction: string }` 非空；先 cancel 当前 Run（cancelled）再新建 Run 并以 instruction 为 userInput 起 harness；计划 trigger 投影属 P3 |
| `POST :id/input` | Task blocked 且有 pendingInput | body `{ answer: string }`；`resolveUserInput` 清 pendingInput、Run blocked→queued→running，answer 作为起跑输入 |

### 9.2 取消链双写（Agent-N）

- `harnessRuntime.cancel/cancelByThread/abortAll`：除 abort 外同步调用 `agent.interrupt(threadId)`（落 stopping checkpoint / pendingInterrupts），再写影子 Run 终态；registry 条目需新增 `interrupt?: () => void` 回调字段（由 harnessRoute 注册时传入），旧调用方兼容。
- `taskHarness.runHarness/resumeHarness` 主循环顶部 `if (signal?.aborted) break`，try/finally 保证 ledger 汇总与 GoalTracker.persist 在 abort 时仍执行。
- `server.ts` 的 `resumeRunning` 调用点：signal 必须登记（接 activeRunRegistry/等价机制），不阻塞主任务：若行号变动与 M 冲突，N 只改 resumeRunning 所在块。
- 盘点 §4.1 其余 P2 项（ToolContext effectiveSignal 贯穿、子代理 runTurn 补 signal）：归入本波 N，但 agent.ts 已被主 agent 锁定——N 是波次内唯一可改 agent.ts 的 agent（M/O 禁改），以消除同文件冲突。

### 9.3 事件（Agent-M）

- 复用现有 `ThreadEvent` 通道：若 protocol 已有 `task.*` 事件类型则直用；否则新 增 `task.run.terminal` 与 `task.run.updated` 两个最小事件类型（含 payload：taskId/runId/status/reason?，过 zod 兼容测试），不发明新事件名（必取自 `TASK_EVENT_NAMES`）；SSE 断线后前端靠 `GET /api/tasks` 重拉（已具备）。

## 10. P2 生命周期与用户接管交付（波次 5，2026-09-20）

> 执行方式调整：应用户要求，本波次由主 agent 直接实现与核验（M/N 两 agent 在取消前已落盘主要代码，主 agent 完成接线、修缺与全量验证）。

### 10.1 P2-M 生命周期端点（已完成）

- `apps/api/src/services/taskLifecycleService.ts`（529 行）+ 测试（439 行，含 fake agent/registry）：七个操作 start/pause/resume/cancel/retry/redirect/input，全部经 protocol 迁移表 + 乐观锁裁决，成功响应 200/202 `{ task, run? }`；取消/暂停统一 `interruptAndAbort`（先 `agent.interrupt` 落 stopping checkpoint，再 `registry.cancel` 双写 abort+终态）。
- `taskRoute.ts` 扩展 `POST /api/tasks/:id/<action>` 统一入口：zod strict 校验各操作入参（redirect 需 instruction、input 需 answer），未接线 lifecycle deps 时仅生命周期端点返回 500 `TASK_INTERNAL_ERROR`，CRUD/查询不受影响。
- **server.ts 接线（主 agent 本波补齐）**：`handleTaskRoute` 注入 `getAgent`（租户缺省编排，完整权限，不复用 Ops 只读预设）、`publishEvent`（`publishTenantEvent`，task 事件走既有 ThreadEvent 通道）、`registry: harnessRuntimeRegistry`。

### 10.2 P2-N 取消链（核实已完整，测试绿）

- `harnessRuntimeRegistry.cancel`：interrupt（写 stopping checkpoint / pendingInterrupts）+ abort 双写；`cancelByThread`/`abortAll` 同语义。
- `taskHarness.runHarness/resumeHarness`：主循环顶部 `if (signal?.aborted) break`；abort 后未收敛出 active 的，`settleTerminalState({ aborted: true })` → `cancelled` 可追溯终态（runHarness 与 resumeHarness 各两处入口），abort 引发的抛错同样收敛为 cancelled，不留未捕获拒绝。
- `server.ts` resumeRunning 调用点：`tenantRuntime.activeRunRegistry.register` 登记 + interrupt 回调（interrupt+abort 双写）。

### 10.3 P2-O 两端操作 UI（已完成）

- web：`taskClient` 7 个 POST 操作方法（`TaskApiError` 保留服务端稳定 code）；`features/tasks/taskActionFlow.ts` 统一编排（提交/冲突自动重拉/成功刷新）；`TaskDetailPanel` 按 `allowedTaskActions(task, currentRun)` 渲染操作按钮（图标全用现有映射 play/stop/stopCircle/refresh/branch；cancel 为 danger 样式；redirect 内联输入；busy 时全部禁用）；blocked 任务渲染 `PendingUserInputCard`（自由文本+快捷回答，提交走 POST :id/input）。
- desktop：与 web 同构（`api/taskClient.ts` 操作方法、`features/tasks/taskActionFlow.ts`、TaskCenter 自取数编排 `runTaskAction`、TaskDetailPanel/PendingUserInputCard 等价实现）。

### 10.4 P2 验证结果

- API：taskRoute+taskLifecycleService 38 测试、tasks 全家桶 7 文件 87 测试全绿；web tasks+taskClient 67 测试全绿；desktop tasks+api 62 测试全绿；harnessRuntime+harness 13 测试全绿。
- `tsc --noEmit`：apps/api / apps/web / apps/desktop 均 exit 0；eslint 本波涉及文件 0 错 0 警（修复 `cancelTaskWithoutRun` 未用参数警告）。
- **未做**（待 API 运行后补）：生命周期操作的真实浏览器点击验收（本机 API 4127 未运行且按规范不自行启动；失败路径抽屉验收已在 P1 覆盖且本轮 UI 外壳未变）。用户重启 API 后即可用真实任务验证操作按钮与终态事件。

## 11. P3 计划投影与证据硬校验 gate（波次 6，主 agent 直接实现，2026-09-20）

落实 §7.1 遗留项「projectPlan / ReplanGate / trackClaimedProgress 均为无入口的纯函数」与 §4.4 清单第 5/7 项。执行方式：应用户要求，不再派 agent，由主 agent 直接实现与验证。

### 11.1 新建 `packages/runtime/src/harness/planSync.ts`（计划来源 + 投影接线）

- `extractPlanFromItems(items)`：从模型 turn 输出提取 ```plan 代码块（JSON 数组或 `{steps}`）；非法 JSON / 未闭合 / 携带保留字段（stepId/systemId）→ 返回 error（fail-closed，不抛出）。
- `HarnessPlanSync.applyModelPlan(nodes, opts)`：首版直通投影（trigger=init，不消耗预算）；后续版本必须过 ReplanGate（预算 3 次 / 冷却 30s / 触发阈值 noProgressCount 或 claimedStreak ≥ 2 / token 预算），再经 projectPlanWithDiff 产出 added/removed/modified；投影被拒（引用不存在 step id → `TASK_PLAN_UNKNOWN_STEP_ID`、伪造 step_ 命名空间 → `TASK_PLAN_STEP_ID_CONFLICT`）→ fail-closed 保留上一版。内容完全一致 → unchanged 不消耗预算。
- `claimProgress()`：§14.4 claimed 进展跟踪单点（每轮一次）；签名未变累计 stall，计划变化自动清零。
- `restorePriorFromHarnessNodes(nodes)`：进程重启后从持久化 plan 重建先验（completed→claimed 保守映射，verified 由证据重判）。
- `validEvidenceIdsFromReceipts(receipts)`：verified 派生唯一依据 = ledger 中 `passed` 收据 id；failed/unknown 不算。
- `toHarnessNodes(version)`：TaskPlanVersion → 四态 HarnessPlanNode 回投影（verified/claimed/skipped→completed，不阻塞 todo_complete gate）。

### 11.2 taskHarness 接线（runHarness 与 resumeHarness 同构）

- 每轮 `ledger.recordTurn` 后调 `syncPlanFromTurn`：提取模型计划 → applyModelPlan → 成功则 `goalTracker.updatePlan(toHarnessNodes(...))`；投影/提取失败时保留旧计划并把拒绝原因注入 blocker。
- 每轮续跑前调 `claimProgress()`：claimed 步骤连续无进展时向模型注入可操作纠错指令（`[plan] N consecutive iterations...`），声称完成但缺证据的步骤无法无限重试。
- resume 路径先 `restorePriorFromHarnessNodes` 重建先验，冷启动后 claimed/verified 语义不丢。
- `taskHarness.ts` 现 755 行（≤800 达标；planSync 已独立成模块）。

### 11.3 证据硬校验 gate

- **goalEvaluator**：`parseEvaluation` 增加 evidenceReceipts 参数；criteriaEvidenceMap 只保留指向真实 criterion（∈ acceptanceCriteria）与真实 evidence id（∈ 收据 id 集合）的映射；出现任何非法引用 → fail-closed（satisfied 强制 false，blocker 注明 `unknown criteria or evidence ids`）——满足计划验收条款「模型引用不存在 id 时被拒绝」。
- **readinessCritic**：新增 `EVIDENCE_KIND_WHITELIST`（8 种已知 kind）；criteria_evidence 与 mutation_verified 两个 gate 只承认白名单内 kind 的收据，伪造 kind 视为无效证据；`size()===0` 放行保持既有语义（盘点清单第 7 项闭环）。

### 11.4 P3 验证结果

- 新增测试：`planSync.test.ts`（16 用例：提取正常/非法 JSON/未闭合/保留字段；init 直通；claimed 无有效证据不升级 verified；unknown id / 伪造命名空间被拒；阈值未满 denied；预算耗尽 denied；unchanged 不耗预算；claimProgress stall 累计与清零；toHarnessNodes 映射）+ `p3EvidenceGate.test.ts`（7 用例：evaluator 非法引用 fail-closed ×3、合法引用放行、无 map 不受影响；critic 白名单 ×3）。
- 核心三包（protocol/storage/runtime）608 测试全绿（原 578 + 新增 30）；`tsc -b` 重建通过；apps/api `tsc --noEmit` exit 0；P3 涉及文件 eslint 0 错 0 警。
- **限制声明**：回放测试（计划验收「回放覆盖真实 run 输出序列」）依赖真实 run fixture，本波未接入；已用确定性单测覆盖投影/gate 全部分支，真实回放待 API 运行采集稳定 fixture 后补。

## §12 P4a：WorkflowScriptRuntime MVP（波次 7，主 agent 直接执行）

> 本波起按用户指令停止派遣子 agent，全部由主 agent 直接实现与验证。

### 12.1 新增模块：`packages/runtime/src/workflowScript/`

- **validator.ts（约 430 行）**：acorn AST 白名单静态校验（新增 `acorn ^8.14.1` 显式依赖，`npm install` 已更新 lock）。
  - 预处理：唯一合法导出 `export const meta` 先剥离为顶层 `const meta`，再以 `sourceType:'script' + allowReturnOutsideFunction + allowAwaitOutsideFunction` 解析——脚本约定是顶层 `await`/`return`。
  - 预扫描快速拒绝：静态 `import` 与非 meta 的 `export` 给出精确 `import_forbidden` / `export_forbidden` 诊断（script 模式下它们是语法错误，不能依赖解析器报错分类）。
  - 白名单遍历：可用标识符仅 `agent/pipeline/parallel/phase/log/args` + 局部声明 + 纯内建（`Boolean/String/Number/Array/Object/undefined/NaN/Infinity`）；`this`、`new`、tagged template 全禁；`constructor/__proto__/prototype` 属性访问禁；动态计算成员访问必须字符串字面量；对运行时 API 的赋值/遮蔽声明/成员访问均拒绝；未声明标识符给出具体禁用名单提示（Date、Math、eval、Function、process、fetch、setTimeout 等）。
  - meta 提取：`{name, description, phases}` 必须是字面量，供批准界面展示；缺失 meta 报 `meta_missing`。
- **runtime.ts（约 480 行）**：`WorkflowScriptRuntime`。
  - 校验通过后以 `new Function` + async IIFE 执行，脚本能触达的能力只有注入的受限闭包（agent/pipeline/parallel/phase/log/args）——与静态白名单双重防线（§12.3 要求）。
  - 限制：`maxConcurrentAgents`（信号量，release 直接移交槽位避免竞态超发）、`maxAgentsPerRun`、`maxItemsPerPipeline`（pipeline 与 parallel 共用条目上限）、`maxTotalTokens`（0=不限）、`maxDurationMs`（deadline 检查 + 超时 abort）；超限抛 `TaskError('WORKFLOW_LIMIT_EXCEEDED')` 并落终态 failed。
  - 取消：内部 AbortController 桥接外部 signal 与超时，`agent()` 执行前/信号量等待中均检查，取消穿透到子代理 executor 注入的 signal；终态 cancelled。
  - 结构化输出：`agent(prompt, {schema})` 结果过 `validateStructuredOutput`（type/properties/required/items/enum 子集）；失败记入 AgentCall `failed` + `structured output validation failed: ...`，抛 `WorkflowStructuredOutputError`（可被脚本 try/catch）。
  - AgentCall 持久化：经 TaskStorePort（`recordAgentCall/updateAgentCall`）记录 running→completed/failed/cancelled；`WorkflowRunRecord` 以 `taskRunId` 注入时持久化 running→completed/failed/cancelled 及 usage 汇总；持久化失败不中断执行（终态再落一次）。
  - 进度事件：`workflow.phase` / `workflow.log` / `workflow.agent_call.updated` / `workflow.agent_call.terminal`（runtime 局部类型；协议目录中的 `workflow.*` SSE 接线在 P4b）。
  - `agentCallId` 当前为顺序 id（`wac_{runId}_{seq}`）；计划 §5.5 的稳定 id（hash(scriptHash+callPath+…))归 P5。
- **schema.ts（约 90 行）**：最小 JSON Schema 子集校验（深度上限 20，路径化错误信息）。
- **scriptPrompt.ts**：`WORKFLOW_SCRIPT_GENERATION_PROMPT`——脚本生成提示词（P4 交付项），与 validator 白名单同步维护的约定写在文件头。
- 导出：`workflowScript/index.ts` barrel + `packages/runtime/src/index.ts` 总入口；`@suanlizi/runtime` 新增符号均向后兼容。

### 12.2 P4 验收对照（本波范围）

| 验收项 | 状态 |
| --- | --- |
| 非法脚本 / import / fs/shell / 随机时间调用全部拒绝 | ✅ validator.test.ts 负向 14 组用例，含 §12.3 全部绕过向量（`agent['constructor']`、`({}).constructor`、`Function`/`eval`、逗号表达式包 `import()`、`this` 逃逸、`__proto__`、getter 间接访问、异步回调构造受限标识符（setTimeout）、修改 `agent/pipeline/parallel` 引用） |
| 并发不超过配置 | ✅ peak ≤ maxConcurrentAgents 用例（12 条目 / 上限 3） |
| 取消能穿透子代理 | ✅ 进行中 agent 调用标记 cancelled，run 终态 cancelled，WorkflowRunRecord 落盘 cancelled |
| 结构化输出失败可追踪 | ✅ AgentCall 记 failed + 错误消息可断言；抛错类型可被脚本捕获 |
| 运行中不阻塞主会话 | 结构性满足（run 为独立异步流程，回调式 onEvent）；SSE/API 接线在 P4b 验证 |

### 12.3 验证结果

- workflowScript 29 测试全绿（validator 17 + runtime 12）；packages/runtime 全量 389 测试全绿。
- 全仓 `tsc -b` exit 0；workflowScript eslint 0 错 0 警；`git diff --check` 通过（CRLF 警告为既有文件）。
- apps/api 回归 342/344 通过；仅剩的 2 个失败为既有基线失败（`serverStructure.test.ts` 行数上限、`tenant.test.ts`），与本波无关（本波未改 apps/api）。
- npm install 输出 "removed 16 packages" 为 lockfile 清理多余平台包，已确认 acorn 依赖解析正常、测试通过。

### 12.4 P4b 待办（下一波）

- API 层：脚本请求路由（validate→批准→创建 WorkflowRunRecord→后台执行）、`workflow.*` 事件接 publishTenantEvent、`GET /api/workflows/runs/:id/result`。
- 两端 UI：脚本批准界面（meta/估算展示）与运行监控（AgentCall 列表/phase/log/usage）。
- 真实 executor 注入：把子代理执行接到 AgentLoop/harness（工具与权限继承既有治理）。

---

## §13 P4b 交付记录（AgentCall 持久化 API 路由 + SSE 事件接线）

### 13.1 模块说明

- `packages/protocol/src/types.ts`：新增 `WorkflowUsageSummary`、`WorkflowRunUpdatedEvent`、`WorkflowRunTerminalEvent`、`WorkflowAgentCallUpdatedEvent`、`WorkflowAgentCallTerminalEvent` 并入 `ThreadEvent` union（agentCall 用 `{ id, status, label?, phase?, error? }` 结构子集承载，规避 types.ts → task.ts 反向依赖；`threadId` 可选但 service 始终携带，保证 SSE 按 thread 路由）。
- `packages/runtime/src/workflowScript/runtime.ts`：`WorkflowAgentExecutor` input 增加 `schema?: Record<string, unknown>`，`agent(prompt, { schema })` 时透传给执行器。
- `apps/api/src/services/workflowScriptService.ts`：`createWorkflowScriptService(deps)`，职责：
  - `validate(script)`：静态校验 + meta 提取（批准界面展示）；
  - `startRun({ taskId, script, args?, limits? })`：Task 存在性校验（TASK_NOT_FOUND）→ 静态校验（WORKFLOW_SCRIPT_INVALID 携带 diagnostics）→ 创建 `kind='workflow' / workflowKind='script'` 的 TaskRun（§14.8）+ WorkflowRunRecord（queued）→ `workflow.run.updated` 事件 → queued→running → **后台 `void runtime.run()` 不阻塞主会话** → 终态落 TaskRun（乐观锁）+ `workflow.run.terminal` 事件；
  - `cancelRun(runId)`：进程内 `Map<runId, AbortController>` 取消注册表（与 harnessRuntimeRegistry 同型语义）；
  - `getResult(runId)`：RunRecord + AgentCalls 视图。
- `apps/api/src/services/workflowScriptWiring.ts`：按租户进程级缓存的 service 工厂；子代理执行器走既有 `AgentLoop.runTurn`（`source='harness'` + `visibleToUser:false` + `skipColdMemory:true` + `extractMemory:false` + `harnessRunId=workflowRunId`），schema 存在时在 prompt 附加 JSON Schema 输出指令，从 `AgentMessageItem` 提取 `structuredOutput ?? text`；权限治理不旁路。
- `apps/api/src/routes/workflowScriptRoute.ts`：
  - `POST /api/tasks/:taskId/workflows/validate`（200 校验视图）
  - `POST /api/tasks/:taskId/workflows/runs`（202 启动；strict schema 拒收 runId/status 等服务端字段）
  - `GET /api/workflows/runs/:runId/result`（200 / 404 WORKFLOW_RUN_NOT_FOUND）
  - `GET /api/workflows/runs/:runId/agent-calls`（200 AgentCall 列表）
  - `POST /api/workflows/runs/:runId/cancel`（202；未运行 409）
  - 装配顺序：**必须在 handleTaskRoute 之前**（taskRoute 把 `/api/tasks/:id/workflows/*` 当未知子段 404）。
- `apps/api/src/server.ts`：仅在 handleOpsRoute 后、handleTaskRoute 前插入 15 行装配（工厂在 wiring 模块，避免加重 server.ts 行数）。

### 13.2 测试与验证

- `apps/api/src/routes/workflowScriptRoute.test.ts`：11 用例全绿（validate 视图、TASK_NOT_FOUND、WORKFLOW_SCRIPT_INVALID 不落 Run、批准启动全链路〔TaskRun kind=workflow 落库 / 后台不阻塞 / AgentCall result / usage 汇总 / terminal 事件〕、schema 校验失败可追踪、取消穿透〔AgentCall cancelled + terminal 事件 + 二次 cancel 409〕、路由 HTTP 语义 200/202/400/404/409、未知路径不吞路由）。
- 调试期修复：路由段数（5 段 `/result`）、测试脚本 `agent(prompt, options)` 位置参数签名、deferred executor 需监听 signal 才能被 abort 打断（与真实 runTurn 取消链一致）、cancel 前需让 runtime 先进入 agent()。
- 回归：apps/api 353/355（仅剩 serverStructure 行数上限〔既有，server.ts 1152>850，本波未加重：装配只 +15 行〕与 tenant.test.ts 两个既有基线失败）；`tsc -b` 全仓 0；eslint 0；`git diff --check` 通过。

### 13.3 P4b 剩余待办

- 两端 UI：脚本批准界面（meta/估算展示）与运行监控（AgentCall 列表 / phase / usage）；`workflow.*` SSE 事件的前端消费。

### 13.4 两端 UI 交付（补充）

- `apps/web/src/api/workflowScriptClient.ts` / `apps/desktop/src/api/workflowScriptClient.ts`：workflow 脚本 API 客户端（validate / start / result / cancel；409 取消错误转译为可操作提示；desktop 版按 desktop taskClient 的 TaskRequestError 风格同构）。
- `apps/web/src/components/tasks/TaskWorkflowPanel.tsx` / `apps/desktop/src/components/tasks/TaskWorkflowPanel.tsx`：任务详情面板内新增「工作流脚本」区块：
  - 脚本 textarea → 「校验」按钮（空脚本禁用）→ 失败显示诊断码 + 行号（danger 左边框），成功显示 meta（name/description/phases 链）+「批准并启动」；
  - 启动后 1.5s 轮询 result API 至终态（断线自动重试；SSE `workflow.run.*` 事件由协议层接线，前端轮询兜底恢复）；监控区展示 run 状态、token/agent 汇总、AgentCall 列表（状态 + label/prompt 截断 + token）+「取消运行」；
  - 视觉遵守 §7：1px 低对比边框、语义色仅状态、无解释性副标题、长文本 ellipsis + title。
- `TaskDetailPanel`（web + desktop）在证据区之后挂载该区块；desktop 直接复用同构组件源（--nx-* 变量两端均有定义）。
- `TaskWorkflowPanel.render.test.tsx`（web + desktop）：静态渲染 4 用例（初始挂载 / 空脚本禁用 / 不误显批准取消 / locale 切换），全绿。
- 验证：全仓 `tsc -b` 0；新文件 eslint 0 警 0 错；web/desktop tasks + api 既有渲染测试 53/53 全绿。

### 13.5 未验证风险（如实记录）

- 浏览器真实点击验收（校验 → 批准 → 运行监控 → 取消全链路）需 API + 前端同时运行，本波未获启动授权未执行；后端链路已由 11 个 service/route 用例覆盖，UI 链路仅静态渲染验证。
- ~~`workflow.*` SSE 事件的前端实时消费（替代轮询的推送式刷新）未接入 UI~~ —— **已解决（§17）**：面板订阅 `/api/events/:threadId`，按事件类型去抖重拉 requests / 运行结果；轮询仍保留作为断线兼底。

---

## §14 P5 交付记录（Workflow 恢复与复用）

### 14.1 稳定 agentCallId（§5.5）

- `WorkflowScriptRuntime.stableCallId`：`wac_ + sha256(scriptHash | callIndex | phase | label | prompt | schemaJSON).slice(0,16)`。
- 脚本与入参不变时跨运行稳定；恢复时按 id 命中决定复用或重跑。旧的 `wac_{runId}_{seq}` 不稳定 id 已废弃（受影响测试同步更新）。

### 14.2 恢复复用（runtime）

- `WorkflowScriptRuntimeOptions.resumeAgentCalls?: readonly WorkflowAgentCall[]`：命中且 prior `status='completed'` → 直接返回保存结果，不调 executor、不增加 usage；否则重跑（"编辑脚本后受影响前缀之后重跑 / 未受影响直接复用"语义由 fingerprint 覆盖 prompt/label/phase/schema 自然达成）。
- `persistAgentCall` 增加回退：新 run 首次登记（含复用的 prior 调用）时 update 不存在 → recordAgentCall。

### 14.3 service / API / 恢复扫描

- `startRun` 新增 `resumeFromRunId`：读取 prior RunRecord 的 agentCalls 传入 runtime；prior 不存在抛 `WORKFLOW_RUN_NOT_FOUND`。
- 同脚本重复运行拒绝（§5.5）：取消注册表值改为 `{ controller, scriptHash }`，同 scriptHash 运行中再启动抛 `TASK_ACTIVE_EXISTS`。
- 路由 `POST /tasks/:id/workflows/runs` 请求体新增可选 `resumeFromRunId`（strict schema）。
- 进程重启恢复：`startTaskRunRecovery` 新增 `onRecovered` 回调；server 启动处把被改写的 `kind='workflow'` TaskRun 的 `workflowRunId` 交给 `workflowScriptService.markWorkflowRunsInterrupted`（非终态 WorkflowRunRecord → `interrupted`，脚本运行状态只在进程内，不可能续跑）。

### 14.4 UI（两端）

- `startWorkflowRun(..., resumeFromRunId?)`（web + desktop client）。
- 监控区 run 状态为 `failed / interrupted` 时显示「恢复运行」按钮（textarea 脚本作为恢复输入，支持"编辑后重新运行"；空脚本禁用）。

### 14.5 验证

> 本节标题原为「验证」且未限定范围；现补充：下表仅适用于 **14.1–14.4 已交付项**（稳定 id / 恢复复用 / 重复拒绝 / interrupted 恢复 / 恢复按钮）；计划 §7 P5 清单中的「脚本保存、查看、对比」与「大任务警告」当时未完成，已在 **§14.7** 补齐。

- workflowScript 全量 14/14（api route/service）+ runtime/workflowScript 全绿；packages/runtime + api/services 合计 178/178。
- 全仓 `tsc -b` 0；新改文件 eslint 0。
- P5 验收对照：编辑脚本后受影响调用重跑 ✅；未受影响调用直接复用 ✅；子代理未退出拒绝重复启动 ✅；进程重启标记 interrupted ✅。

### 14.6 P6 待办（下一波）

> 已完成，见 §15 P6 交付记录（2026-09-20）。以下保留为当时的冻结项清单。

- GoalRun 在合适阶段启动 WorkflowRun：GoalEvaluator/ReplanGate 产出 `WorkflowScriptRequest`（taskId/goalRunId/objective/proposedScript/estimatedAgents/estimatedTokens/limits，protocol 已冻结）。
- 批准链路：`workflow.request.created/approved/rejected` 事件 + 用户批准 UI 入口（脚本来源改为模型提议而非手输）。
- WorkflowRun 结果写入 Evidence：`workflow_evidence.created` 事件 + `WorkflowEvidenceSource`（{ kind: 'workflow_run' | 'workflow_agent_call' }）物化到 EvidenceLedger；物化失败必须 fail（WORKFLOW_EVIDENCE_MATERIALIZATION_FAILED）。
- GoalEvaluator 消费 Workflow 结构化结果（只读 Evidence）。
- Task 多 Run 串联：GoalRun → WorkflowRun → GoalRun；防无限触发（maxWorkflowRunsPerGoal 已在 protocol GoalPolicy 冻结）。
- 验收：全链路 API 测试 + 真实 UI 点击 + 失败路径（模型失败 / 脚本非法 / Agent 取消 / 断线 / 进程重启）。

### 14.7 P5 补口：大任务警告、成本统计与历史脚本（2026-09-20，本波补完 §7 P5 清单）

**静态成本度量（大任务警告的依据）**

- `validator.ts` 新增 `WorkflowScriptCostMetrics { agentCallSites, agentsInsideLoop, fanOutSites }`，由**与白名单遍历完全独立**的 `collectCostMetrics(program)` 产出（不参与 `ok` 判定，不改任何安全语义）：统计 `agent(...)` 调用点、`pipeline/parallel` 扇出点，并用循环深度判断 agent 是否处于 `for/for-in/for-of/while/do` 或 `pipeline/parallel` 回调内（两者都会在运行时把 1 次调用放大成 N 次）。仅校验通过时返回 `cost`。
- `workflowScriptService.validate()` → `WorkflowScriptValidationView.cost`；`workflowScriptRoute.ts` 的 `WorkflowScriptValidationResponse.validation` 改为直接复用 service 视图类型（避免路体重抄结构、两份漂移）。
- 导出面：`workflowScript/index.ts` + `packages/runtime/src/index.ts` 导出 `WorkflowScriptCostMetrics`。

**历史脚本（保存 / 查看 / 对比 / 编辑后重跑的数据源）**

- `service.listScripts(taskId)`：从已落库的 `WorkflowRunRecord.script` 投影，**按 `scriptHash` 去重保留最新一次**、按 `startedAt` 倒序；不引入第二份存储、不新建表。
- 新端点 `GET /api/tasks/:taskId/workflows/scripts` → `{ taskId, scripts: WorkflowScriptHistoryEntry[] }`（含 runId / hash / status / usage / evidenceId）。
- 本次运行的脚本在终态后自动刷新（`pollResult` 进入终态分支时重拉），无需用户手动“保存”。

**两端 UI**

- 新建纯函数模块 `features/workflow/workflowScriptCost.ts`（两端同构）：`workflowCostWarning(cost, locale)`（调用点 ≥ 5 或存在循环/扇出放大时警告，否则 null）与 `diffScripts(before, after, maxSamples?)`（行级多重集差异，返 added/removed/unchanged/samples，不伪造行号对齐）。
- 新建 `components/tasks/WorkflowScriptHistory.tsx`（两端同构）：展示 hash 前 8 位 + token/agent 成本统计 + 状态 + 「载入」「对比」（展开后显示 +N / -M 行与差异行样本，ellipsis + title）；空历史不渲染容器；稳定 key。
- `TaskWorkflowPanel`：meta 区下方渲染大任务警告（`--nx-warn` 左侧细线，非大块红色）；尾部挂历史脚本区；`onLoad` 回写 textarea 并清旧校验（强制重走「校验 → 批准并启动」闸门）。
- `workflowScriptClient.ts`（两端）：`fetchWorkflowScripts` + `WorkflowScriptHistoryEntry`；`WorkflowScriptValidation` 补 `cost`。desktop 版本端 `TaskRequestError` 约定。

**验证**

- 新增测试：`validator.test.ts` 成本度量 4 例（pipeline 内 agent / 单点不放大 / for 循环体 / 不通过时无 cost）；`workflowScriptRoute.test.ts` 新增 listScripts 去重与路由 200 用例 + validate.cost 断言；两端 `workflowScriptCost.test.ts` 各 8 例（警告阈值 + diff 计数/截断/空白处理）；两端 `WorkflowScriptHistory.render.test.tsx` 各 3 例。
- 本波回归面：runtime workflowScript+harness+task、apps/api services+workflowScriptRoute、storage taskStore、两端 workflow/tasks → **42 文件 / 470 测试全绿**；`npx tsc -b` exit 0；eslint 涉及文件 0 错 0 警；`git diff --check` 干净。
- §7 P5 清单补完：scriptHash/稳定 agentCallId ✅、AgentCall 结果持久化 ✅、恢复时复用或重跑 ✅、脚本保存/查看/对比/编辑后重跑 ✅（本小节）、大任务警告与成本统计 ✅（本小节）。

## §15 P6 交付记录（Goal × Workflow 组合）

### 15.1 协议与事件（packages/protocol）

- `WorkflowRunRecord` 新增三字段：`goalRunId?`（GoalRun 来源，缺省=用户手动发起、不参与预算）、`evidenceId?`（run 级证据 `wev_<runId>_run`）、`result?: unknown`（脚本 return 终态值）；`workflowRunRecordSchema` 同步 optional。
- `TaskStorePort` 新增 `listWorkflowRuns(filter?: WorkflowRunListFilter)`，`WorkflowRunListFilter = { goalRunId?: string }`（已导出）。
- `types.ts` 新增三个事件接口并入 `ThreadEvent` union：`WorkflowRequestCreatedEvent` / `WorkflowRequestDecidedEvent`（approved|rejected）/ `WorkflowEvidenceCreatedEvent`，事件名逐字取 `TASK_EVENT_NAMES`（`workflow.request.created|approved|rejected`、`workflow.evidence.created`）。
- 复用 P3 已冻结的 `WorkflowScriptRequest`、`WorkflowEvidenceSource`、`GoalBudgetPolicy.maxWorkflowRunsPerGoal = 2`、错误码 `WORKFLOW_EVIDENCE_MATERIALIZATION_FAILED`。

### 15.2 存储（packages/storage/taskStore.ts）

- `workflow_runs` 增列 `goal_run_id` / `evidence_id` / `result`；`ensureTaskStoreSchema` 用 `PRAGMA table_info` 检查后幂等 `ALTER TABLE ADD COLUMN`，`TASK_STORE_MIGRATION_VERSION` 7 → 8（既有库可直接升级）。
- `upsertWorkflowRun` / `rowToWorkflowRun` 三字段往返（`result` JSON 文本列）；新增 `listWorkflowRuns({ goalRunId })`。
- `apps/api/src/testing/fakeTaskStore.ts` 与两处测试本地 fake 同步实现该端口。

### 15.3 runtime：提案提取与证据消费

- 新建 `packages/runtime/src/harness/workflowProposal.ts`：`extractWorkflowProposal(items, { taskId, goalRunId, limits? })` 逆向扫描最后一条 `agent_message` 的 ```workflow 围栏 JSON，`objective/script` 必填并先跑 `validateWorkflowScript` 静态预检；非法提案返回 `error`（fail-closed，不产生请求）。`WORKFLOW_CONTINUATION_HINT` 是续跑输入里的提案格式提示。
- `HarnessWorkflowOptions`：`{ taskId, goalRunId, onRequest(request), evidenceProvider?(threadId) }`；`runHarness` / `resumeHarness` 均接受，**未注入时行为零变化**（已有 6 个 P2/P3 harness 测试不改断言即通过）。
- `taskHarness.ts` 六个 turn 之后（首轮、replan、storm、continuation × run/resume）统一走 `handleWorkflowProposal`：命中即 `onRequest` → `goalTracker.markBlocked(...)` → 返回 `blocked` 终态；`onRequest` 抛错同样收口为 blocked（`workflow request rejected: ...`），不留 active harness 孤儿。
- `preloadWorkflowEvidence`：ledger 初始化后把 `evidenceProvider` 投影出的 `wev_` seeds 经 `rebuildFromWorkflowResults` 物化进账本，GoalEvaluator 只从 Evidence 消费 Workflow 结构化结果（不读脚本变量）；预载异常吞掉，不阻断目标推进。

### 15.4 service：请求链路与证据物化（apps/api/services/workflowScriptService.ts）

- `proposeRun`：Task/GoalRun 归属校验（非 goal kind → `TASK_RUN_NOT_FOUND`）→ 脚本静态校验 → 预算 → 建 `kind='workflow'` 的 **blocked** TaskRun + blocked `WorkflowRunRecord`（带 `goalRunId`）→ 发 `workflow.request.created`。**不执行**。
- `approveRun`：`requireBlockedRequest` → 预算复核 → TaskRun `blocked → queued`（迁移表无 `blocked → running` 直达边）→ 发 `approved` + `run.updated(queued)` → 复用 `launchRun`。返回 202 语义的 `{ status: 'approved' }`。
- `rejectRun`：RunRecord 与 TaskRun 双写 `cancelled`，发 `workflow.request.rejected` + `workflow.run.terminal(cancelled)`；重复决定 → `TASK_INVALID_TRANSITION`。
- `listRequests(taskId)`：只回 `status === 'blocked'` 的记录。
- 预算治理：`assertGoalBudget` 以 `listWorkflowRuns({ goalRunId })` 计数（含 blocked），提案时 `>= max` 拒绝、批准时 `> max` 防御性拒绝，均抛 `WORKFLOW_LIMIT_EXCEEDED` —— 防 Goal 无限触发大 Workflow。
- 证据物化 fail-fast：`runtime.run()` 完成 → `materializeWorkflowEvidence`（每个 completed AgentCall 写 `wev_<runId>_<callId>`，run 级写 `wev_<runId>_run` + `result` 落库，发 `workflow.evidence.created`）→ 任一步失败即 `failMaterialization`：RunRecord/TaskRun 落 `failed`、终态事件齐全、**不触发续跑**；成功才 `settleTaskRun` 并调用 `onGoalResume`（异常 swallow）。
- 幂等：已带 `evidenceId` 的 AgentCall 跳过重写。

### 15.5 路由与生产装配

- `workflowScriptRoute.ts` 新增 4 端点：`POST/GET /api/tasks/:taskId/workflows/requests`、`POST /api/workflows/runs/:runId/approve`、`POST .../reject`（reject 容忍空 body，但 `REQUEST_BODY_TOO_LARGE` 仍上抛）；请求体 strict schema 拒收多余字段；`TASK_RUN_NOT_FOUND → 404`。
- `workflowScriptWiring.ts` 新增：
  - `projectWorkflowEvidenceSeeds(taskStore, taskId)`：只投影 `completed` 的 workflow 记录（agentCall 级 + run 级 seed，`status='passed'`，summary 单行截断 400 字符，外部结果不进模型上下文）。
  - `taskWorkflowIntegrationForTenant(tenantContext, deps)`：`onRequest = proposeRun + blockForUserInput(GoalRun → blocked + pendingInput)`，`evidenceProvider = projectWorkflowEvidenceSeeds`。
  - `onGoalResume → continueGoalAfterWorkflow`：懒建 `createTaskLifecycleService` 并走 `input()` 通道，把 blocked GoalRun `blocked → queued → running` 起新 harness（新 harness 预载刚物化的证据）—— 即 **GoalRun → WorkflowRun → GoalRun** 的多 Run 串联，且续跑仍以模型提案 + 用户批准为闸门。
- `server.ts`：`handleTaskRoute` 注入 `workflow: taskWorkflowIntegrationForTenant(...)`；`taskRoute.ts` 的 `TaskRouteOptions.workflow` 透传给生命周期服务；`launchGoalHarness` 把 `{ taskId, goalRunId, onRequest, evidenceProvider }` 传给 `runHarness` / `resumeHarness`。

### 15.6 UI（web + desktop，两端文件保持一致）

- `workflowScriptClient.ts`：`fetchWorkflowRequests` / `approveWorkflowRequest` / `rejectWorkflowRequest` + `WorkflowPendingRequest` 等类型（desktop 端沿用本端 `TaskRequestError` 约定）。
- `TaskWorkflowPanel.tsx`：抽出可测展示组件 `WorkflowRequestList`（15.6 待批准区）——挂载即拉取、`busy` 时按钮禁用、批准后立即进入既有运行监控轮询、拒绝后就地从列表移除；请求项展示脚本 meta 名 + runId（标题 `title` 兜全文， ellipsis 截断，稳定 key）。GoalRun 侧的「需要你补充信息」卡片复用 P2 的 `PendingUserInputCard`，展示提案问题与批准指引。

### 15.7 验证（本波实际执行）

- `npx tsc -b` 全仓 exit 0。
- P6 定向套件全绿（合计 **172 + 69** 断言用例）：
  - `apps/api/src/routes/workflowScriptRoute.test.ts` 21（含 P6 7 例：propose 落库+事件、非法脚本/goal 不存在、预算拒绝、reject 双写、listRequests、approve→执行→证据+续跑钩子、**证据物化失败 fail-fast**）
  - `apps/api/src/services/workflowScriptWiring.test.ts` 4（证据投影 + 集成工厂 + **提案→pendingInput→批准→证据→GoalRun 续跑** 全链路）
  - `packages/runtime/src/harness/workflowProposal.test.ts` 7（提取 4 类失败路径 + 提案收口 blocked + onRequest 抛错 + 未注入零变化 + 续跑提示开关）
  - `packages/storage/src/taskStore.test.ts` 21（三新列往返 + `listWorkflowRuns` 过滤）
  - 既有回归未改断言通过：`taskHarness` / `planSync` / `p3EvidenceGate` / `workflowEvidence` / `taskLifecycle` / `workflowScript runtime+validator` / `protocol schemas` / `taskRoute` / 两端 `tasks` 组件（5 文件 69 例）
  - 本波及相邻面总跑：`apps/api` + storage/runtime/protocol + 两端 tasks 组件 → **64 文件 / 640 测试通过**，仅剩下列两个基线失败（§15.8）
- 改动文件 `npx eslint` 0 error 0 warning；`git diff --check` 无空白错误。
- **真实浏览器点击验收（本机 5178 Vite + fetch 打桩，未启动 API）**：topbar「任务中心」→ 任务列表→详情 → 「工作流脚本」区，实际 DOM 断言：
  - 面板挂载即 `GET /api/tasks/task-p6/workflows/requests`；待批准区渲染脚本名 `batch-audit` + `wfrun_p6` + 「批准/拒绝」（a11y 快照 uid 12_76–12_81）；
  - 点「批准」→ `POST /api/workflows/runs/wfrun_p6/approve` → 请求项就地移除 → 监控接管轮询 `GET .../result`，显示「运行中」与 AgentCall 列表（“audit repo”）；
  - Esc 关闭抽屉→重新打开→面板重挂重新拉取→点「拒绝」→ `POST .../reject` → 列表移除；
  - 布局：批准按钮滚入视口后 `elementFromPoint` 命中自身（无遮挡）；抽屉内部滚动（scrollHeight 1293 / clientHeight 771）而 `document` 不可滚（页面无溢出）；
  - 同时可见：`PendingUserInputCard` 展示提案问题、证据区展示 `wev_wfrun_p6_run`、执行记录同时列出 goalrun_p6 与 「工作流（脚本）」 run（多 Run 串联在 UI 可见）；
  - console 25 条 error 全为打桩前打到已死 API 的资源 500，**无未捕获 JS 异常 / React 错误**；验收后已关闭本次启动的 5178 进程并确认端口释放（截图因原生浏览器视图隐藏未能落盘，改用 a11y 快照留证；`.playwright-cli/` 已 gitignore，无遗留文件）。
- P6 验收对照（计划 §7）：GoalRun 在合适阶段启动 WorkflowRun ✅（提案→请求→批准→执行）；WorkflowRun 结果写入 Evidence ✅（`wev_` + `result` + `workflow.evidence.created`，失败必须 fail）；GoalEvaluator 消费结构化结果 ✅（只读预载 Evidence）；多 Run 串联 ✅（blocked GoalRun 经 `input` 通道续跑新 harness）；防无限触发 ✅（`maxWorkflowRunsPerGoal` 提案/批准双重校验）。

### 15.8 未验证项与已知限制

- 上述浏览器验收的传输层是 fetch 打桩（真实路由契约与响应体来自 `workflowScriptRoute.ts` 与回归测试）；**带真实后端的端到端点击（模型提案 → 真库 blocked 请求 → 批准 → 真子代理执行 → 证据入库）仍未做**，需用户重启 API（新增的 `workflow_runs` 三列会在启动时幂等迁移）后补。
- 提案提示词只注入 harness 续跑输入（`WORKFLOW_CONTINUATION_HINT`），未改首轮系统提示，避免非 workflow 任务的成本与风格漂移；模型是否提案由评估器判定「适合大规模并行编排」驱动。
- 自动续跑依赖 GoalRun 处于 `blocked`（提案时写入 `pendingInput`）。若用户在批准前手动 cancel/retry 了该 GoalRun，`input()` 会抛错并被 swallow —— Workflow 终态与证据不受影响，用户可继续手动 retry。
- 全仓 `vitest run` 另有 35 例失败，均与本波无关且早于本波存在：Electron 端到端（本机 `Process failed to launch`）、UI CSS/文案守卫、`serverStructure`（HEAD 的 server.ts 已 893 行 > 850 阈值，本波 +6 行装配）、`tenant.test.ts`（期望多租户 id，代码按项目规范固定 `default`）。

> 上述后两项已在 **§16** 修复；其余为 Electron 环境与用户未提交 UI 改动的遗留。

## §16 补端点、全链路 e2e 与 server.ts 行数收口（2026-09-20）

### 16.1 补齐计划 §13.1 列出但从未实现的两个端点

审计发现计划「新增 API」清单里的 `GET /api/tasks/:id/goal-status` 与 `GET /api/workflows/runs/:id/evidence` 一直没有实现（protocol 已有 `TaskGoalStatusResponse` + zod schema，路由从未接入）：

- 新建 `apps/api/src/services/taskGoalStatusService.ts`：只读 `task` 表与 `thread.tags['harnessState:<harnessRunId>'].lastEvaluation`（GoalTracker 已有写入，不引第二套评估载体）；无评估时如实返回空摘要，不伪造 `evaluation`；task 不存在抛 `TASK_NOT_FOUND`。`taskRoute` 新增 `goal-status` 分支（未注入服务时 500 `TASK_INTERNAL_ERROR`，非 GET 405），`server.ts` 注入 `createTaskGoalStatusService({ taskStore, threadStore: store })`。
- `workflowScriptService.getEvidence(runId)` + `GET /api/workflows/runs/:runId/evidence` → `{ runId, taskRunId, status, goalRunId?, runEvidenceId?, evidenceIds[], result? }`；未知 run 404。
- 两端 client 补 `fetchTaskGoalStatus`（web 走 `requestJson`，desktop 走本端 `readJson`+`TaskRequestError`）与 `fetchWorkflowRunEvidence`；`GET .../result` 同时补齐 `goalRunId/evidenceId/result` 与 AgentCall `evidenceId` 透出（之前路由手搭响应体漏了这三个 P6 字段）。

### 16.2 P6 全链路 e2e（真实 HTTP + 真实 SQLite）

新建 `apps/api/src/routes/workflowGoalE2e.test.ts`：测试进程内 `createServer` 监听 `127.0.0.1:0`，用**生产装配函数**（`workflowScriptServiceForTenant` / `taskWorkflowIntegrationForTenant` / `createTaskGoalStatusService`）+ **真实 `SqliteTaskStore`**（临时目录）跑真 fetch；不起任何常驻服务，用例结束 `server.close()`。

- 正向链：`POST /api/tasks` → `POST :id/start`（假 harness 使用生产注入的 `workflow.onRequest` 提案，taskId/goalRunId 取自 `HarnessWorkflowOptions` 而非自造）→ `GET :id/workflows/requests` 从真库读回 blocked 请求 → Task blocked + `pendingInput` → `POST runs/:id/approve` → 真 executor 后台执行 → `wev_*_run`/`wev_*_<callId>` 与 `result` 落库 → `onGoalResume` 经 `input` 通道把 GoalRun `blocked → queued → running` 起第二个 harness → 两个 Run 均 `completed`、`pendingInput` 清空；并断言 `workflow.request.created/approved/evidence.created/run.terminal` 事件齐备、`/workflows/scripts` 与 `/goal-status` 可读到真实数据。
- 失败链：非法脚本 400 `WORKFLOW_SCRIPT_INVALID` 且不落任何记录；goal run 不存在 404 `TASK_RUN_NOT_FOUND`；批准不存在的 run 404；未知路径不被路由吞掉。
- 注：“Run completed 不推导 Task 终态”是 `syncTaskFromRun` 的既有保守设计（验收为显式动作），e2e 按真实语义断言 Task 停在 `running`。

### 16.3 e2e 当场发现并修复的三个真实缺陷（单测未覆盖到）

1. **run 级写入反覆盖调用级证据**：`materializeWorkflowEvidence` 先给每个 AgentCall 写 `evidenceId`，再用带内联旧 `agentCalls` 副本的 `upsertWorkflowRun` 写 run 级字段 → `INSERT OR REPLACE` 把刚写的 `evidenceId` 洗掉。修法：run 级更新传 `agentCalls: []`，子表为调用级唯一真相。
2. **runtime 把 GoalRun 来源列写空**：`WorkflowScriptRuntime` 自接 `WorkflowRunRecord` 时重建对象，不包含 `goalRunId/evidenceId/result`（这些列的所有权属于 API 服务层），导致 GoalRun 来源静默丢失，预算归集 `listWorkflowRuns({goalRunId})` 也会失真。修法：改为读-合并-写（`existing` 优先，含 `startedAt`）。
3. **`updateTask` 无法清空 `pendingInput`**：列写入以 `patch.x !== undefined` 判定，`resolveUserInput` 传 `pendingInput: undefined` 时 SQL 不写 →  answered 后的旧问题永远挂在 UI。修法：可清字段改用「键是否存在」（`currentRunId/latestPlan/pendingInput/interactionMode/completedAt`），并在 `taskStore.test.ts` 加“缺省键不得覆盖、显式 undefined 才清空”的硬断言（内存 FakeTaskStore 用展开语义，故之前不可能暴露）。

同时修正 `workflowScriptRoute.test.ts` 里的 `WorkflowFakeStore.getWorkflowRun`：从子表合成 `agentCalls`，与真实存储一致（否则 fake 会继续掩盖第 1 类问题）。`onGoalResume` 的 swallow 也补上 `logger.warn`（§6：失败不得静默）。

### 16.4 server.ts 行数收口（修复长期为红的 `serverStructure` 守卫）

AGENTS §5 要求 `server.ts` 只做服务启动与路由装配，守卫阈值 850 行；HEAD 已 893 行（本目标开工前就红），历次装配只增不减。本轮按职责下沉：

- `services/accessPolicyRules.ts`（审批持久化规则纯函数）
- `services/a2aHandlerRegistry.ts`（按租户 A2A handler 缓存 + AgentCard + 端口适配）
- `services/skillDraftService.ts`（草拟提示词/安装回复/失败项/URL 归一）
- `services/threadEventBus.ts`（SSE 发布、订阅表与回放缓冲）
- `shared/threadSerialization.ts`（`generateServerId`；同时删除仓内无人调用的死导出 `serializeThreadState`）
- `routes/threadSkillInstall.ts`（`/skills install` 的完整 turn 生命周期，行为逐字不变，依赖改为显式注入）

结果：`server.ts` 1140 → **807 行**（≤ 850），`serverStructure.test.ts` 3/3 通过；`server.ts` eslint 0 错 0 警（其余警告均属用户未提交的存量文件，未混入本波改动）。

### 16.5 `tenant.test.ts` 对齐单用户产品规范

该测试仍期望 `parseTenantContext` 按 header 返回 `team_A-1`，与 AGENTS §1（禁止多租户入口、`tenant_id` 固定 `default`）矛盾——代码是对的、测试过期。改写为：断言任何入参都钉在 `default`，同时保留 `safeTenantId` 对 `../other`、`team/a` 等路径类 id 的拒绝断言与空值回落 `default` 的覆盖（不是放宽断言，而是把校验覆盖移到真正负责它的函数上）。

### 16.6 验证

- `npx tsc -b` exit 0；`npx eslint apps/api/src/server.ts apps/api/src/routes/threadSkillInstall.ts` 0 错 0 警。
- `npx vitest run apps/api packages/runtime packages/storage packages/protocol` → **99 文件 / 1029 测试全部通过**（含新 e2e 2 例、goal-status 服务 4 例、route goal-status/evidence 新用例、存储清空语义新用例）；`serverStructure` 与 `tenant.test` 两个旧红已消除。
- `git diff --check` 无空白错误。
- 全仓 `npx vitest run`：开工前 35 失败 / 22 文件 → 现在 **33 失败 / 20 文件（2700 通过）**，减少的两个正是 `serverStructure` 与 `tenant.test`；其余 33 例仍是 Electron 启动失败与用户未提交 UI 改动的 CSS/文案守卫，与本波无关（不混入本目标的功能提交，留给用户的 UI 工作自行收口）。

## §17 `workflow.*` 事件的实时消费与一个真实崩溃修复（2026-09-20）

补上 §13.5 记录的遗留：“`workflow.*` SSE 事件的前端实时消费未接入 UI，仅轮询兼底”。

### 17.1 事件过滤纯函数（两端同构）

- 新建 `apps/{web,desktop}/src/features/tasks/taskEventRefresh.ts`：`shouldRefreshTasksFromEvent`（`task.*` / `workflow.*` 前缀）、`shouldRefreshWorkflowRequests`（仅 `workflow.request.created|approved|rejected`）、`shouldRefreshWorkflowRun`（run/agent_call 终态与 `workflow.evidence.created`），以及 `TASK_EVENT_REFRESH_DEBOUNCE_MS = 400`。无法解析的报文一律不触发刷新（可观测事件名逐字取自 `TASK_EVENT_NAMES` / types.ts 事件族）。
- `TaskWorkflowPanel` 新增可选 `threadId`（两端 `TaskDetailPanel` 已传），订阅 `/api/events/:threadId`：请求类事件去抖重拉 requests+scripts，进度类事件去抖重拉运行结果；卸载时 `source.close()` + 清定时器（无 EventSource 环境自动跳过，不影响静态渲染测试）。
- 效果：GoalRun 在后台提案时，面板不再需要“关上抽屉再打开”才能看到待批准请求。

### 17.2 浏览器验收当场发现并修复的真实崩溃

真实页面验证时，一个字段缺失的 200 响应（`{}` 而无 `scripts`）导致 `setScripts(undefined)` 再被列表组件读 `.length`，**整棵 React 树被卸载**（console 报 `Cannot read properties of undefined (reading 'length')`）。修复：

- 两端 `workflowScriptClient`：`fetchWorkflowScripts` / `fetchWorkflowRequests` 对缺失数组归一为 `[]`；`fetchWorkflowRunResult` 缺 `run` 时抛可操作错误（`MALFORMED_RESPONSE`）而不是往下传 `undefined`。
- 面板 `loadRequests` / `loadScripts` 再加 `Array.isArray` 防御（双重卡口，不把半形数据塞进渲染层）。

### 17.3 验证

- `npx tsc -b` exit 0；改动文件 eslint 0 错 0 警；两端 tasks + features/tasks 套件 **12 文件 / 131 测试全绿**（含新增 `taskEventRefresh.test.ts` 各 4 例）。
- 真实浏览器（本机 5178 Vite + fetch/EventSource 可控桩，未启 API）：面板订阅 `/api/events/thread-live` 并初始不显示待批准区 → 仅下发一帧 `workflow.request.created` → 去抖后重拉两个端点、`live-audit · wfrun_live` 与「批准/拒绝」就地出现（未重挂组件、订阅未关闭）；`elementFromPoint` 命中批准按钮本身（无遮挡）；再下发 `workflow.request.approved` 同时把 `/workflows/scripts` 返回体改为 `{}` → 应用仍挂载、待批准区仍在、console 无未捕获异常（修复前同场景必现 TypeError）。
- 验收后已关闭本次启动的 5178 进程并确认端口释放；无临时文件残留。未启动、未重启任何 API / Electron / sidecar 进程。
- 仍未覆盖：带真实后端的端到端点击（需用户重启 API），以及真实模型提案与真 SSE 服务端的联调。

## §18 事件目录补齐与 §14.5 大结果句柄（2026-09-20）

### 18.1 两个“只声明未发布”的事件（计划 §13.1 / §14.9）

审计发现 `workflow.result.created` 与 `task.goal.evaluation.available` 早已写进 `TASK_EVENT_NAMES`（protocol 测试还断言存在），但全仓无任何发布点 —— 目录上有、链路上无。本轮补齐：

- `types.ts` 新增 `WorkflowResultCreatedEvent`（`runId` / 可选 `agentCallId` / `resultHash` / `size`）与 `TaskGoalEvaluationAvailableEvent`（`satisfied` / `status` / `passedCriteria` / `failedCriteria`）并入 `ThreadEvent` union；两者都只带摘要与指纹，不内联大结果正文。
- `workflowScriptService.materializeWorkflowEvidence`：每个完成调用与 run 级各发一条 `workflow.result.created`（先于 `workflow.evidence.created`，顺序已在测试里断言）；指纹由 `resultFingerprint()` 计算（sha256 前 16 位 + UTF-8 字节大小）。
- GoalRun 收口时由 `taskLifecycleService.trackHarnessTerminal` 调新增依赖 `readGoalEvaluation({ taskId, runId })` 取回 tags 里的 `lastEvaluation` 并发事件；`taskGoalStatusService` 因此多一个 `readGoalEvaluation` 方法，`taskRoute` 透传、`server.ts` 用同一实例注入（+1 行）。读不到评估 → 不发事件；读取抛错 → `logger.warn` 记账，**不阻断终态写入**（三个分支均有测试）。
- `threadEventSchema`（zod discriminated union）本来就不含 task.*/workflow.* 族，与 P4b/P6 做法一致，未强行扩容。

### 18.2 §14.5 大结果句柄与 `readResult` 分页

计划 §14.5（P4a 必并入）要求 `agent()` 返回 `ResultHandle` 而不是无约束全文；原实现直接把全文交给脚本。

- **协议**：`WorkflowAgentCall` 新增 `resultHash?` / `resultSize?`（+ strict schema）。
- **存储**：`workflow_agent_calls` 增列 `result_hash` / `size_bytes`，PRAGMA 幂等 ALTER，`TASK_STORE_MIGRATION_VERSION` 9。
- **runtime**：`WORKFLOW_RESULT_HANDLE_THRESHOLD_BYTES = 8KB`；`fingerprint()` 统一算 json/hash/size；`scriptFacingResult()` 决走向 —— 小结果原值直返（仅行为不变），超阈值只返 `{ resultId, runId, agentCallId, hash, size, summary(前缀 240), truncated: true }`；恢复复用的 prior 调用同样走句柄（指纹缺失时按需补算）。
- **新受限 API**：`readResult(句柄 | callId, { offset, limit })` 返回 `{ text, offset, limit, size, hash, hasMore }`，全文从本次运行的结果表（含复用项）取，**不内联给脚本**；offset/limit 非法或句柄不属于本运行 → `WORKFLOW_SCRIPT_INVALID` fail-closed。`WORKFLOW_API_NAMES` 已纳入 `readResult`（遮蔽声明与成员访问规则自动生效），`scriptPrompt` 同步文档大结果规则。
- 测试：runtime 新增 5 例（小结果仍记指纹 / 大结果只给句柄 / 跨分页拼接等于全文 / 参数越界与非法句柄 / 复用路径不重跑 executor）；validator 2 例（`readResult` 可调用与句柄属性访问合法；`readResults` 仍 `unknown_identifier`、遮蔽声明仍 `shadow_runtime_api`）；storage 1 例（指纹字段往返）。
- 开发过程中自查修正一处真实缺陷：`scriptFacingResult` 先用 `computed!` 非空断言，恢复路径（有 hash/size 无 json）会 `Cannot read properties of undefined (reading 'json')`；改为无断言惰性补算后测试转绿。

### 18.3 验证

- `npx tsc -b` exit 0；`npx eslint packages/runtime/src/workflowScript packages/protocol/src packages/storage/src apps/api/src/services apps/api/src/routes` 仅余 1 条存量警告（`botRoute.ts` 未用导入，本波未触碰）。
- `npx vitest run packages/runtime packages/storage packages/protocol apps/api` → **99 文件 / 1038 测试全绿**（含旧用例零回归，说明句柄改动只影响超阈值结果，既有脚本行为不变）。
- `git diff --check` 无空白错误。

## §19 风险表硬条款与迁移过渡收尾（2026-09-20）

本轮把计划里“写了但没做”的两条风险/迁移对策补齐。

### 19.1 §14.11 资源竞态：全局同时只允许一个 WorkflowRun

原实现只比对 `scriptHash`，两个不同脚本可以并发跑，而计划 §14.11 明确要求“第一版全局同时只允许一个 WorkflowRun 运行”。

- `workflowScriptService` 新增 `assertNoActiveRun(scriptHash, context)`：`controllers.size > 0` 即抛 `TASK_ACTIVE_EXISTS`，详情里带 `activeRuns`；同脚本时报更具体的原文案（保留旧行为）。
- 检查时机：必须在任何写入之前 —— `startRun` 在创建 TaskRun/RunRecord 之前，`approveRun` 在 `blocked → queued` 迁移之前。否则拒绝会留下永久 queued/blocked 的半状态 Run（违反 §6“不得留下永久 queued”）。
- 测试：`§14.11 全局串行`（不同脚本被拒 + 拒时不落任何记录 + 前一个终态后可启动）与 `已有运行中 run 时批准请求`（报错且请求仍为 blocked，前一个结束后同一请求可批准成功）；连同旧“同脚本重复启动”用例共 3 例全绿。

### 19.2 §14.6 / §8.2 tags→task 表切换期的对账接入启动流程

`reconcileTasksFromTags` 自 §8.3 就存在且幂等，但一直“尚未接入启动流程/CLI”，对应计划 §8.2“tags 只写摘要缓存、不作事实来源”的切换动作没人触发。

- `server.listen` 回调内，与 `recoverOpsTasks` / `startTaskRunRecovery` 并列 fire-and-forget 调用 `reconcileTasksFromTags({ threadStore: defaultTenantStore, taskStore, listThreads, logger, isLive })`；`isLive` 接 `harnessRuntimeRegistry`，避免把正在跑的 harness 误对账为 interrupted。
- 安全边界未变：对账依赖的 `ReconcileThreadStore` 类型面只包含读方法（结构上拿不到写接口），故只会前向修正 task 表；失败只记日志不抛（不阻断启动）。
- server.ts 仍守行数限制（本次 +18 行，`serverStructure.test.ts` 3/3 通过）。

### 19.3 验证

- `npx tsc -b` exit 0；`npx eslint apps/api/src/server.ts apps/api/src/services/workflowScriptService.ts apps/api/src/routes/workflowScriptRoute.test.ts` 0 错 0 警。
- `npx vitest run apps/api packages/runtime` → **79 文件 / 790 测试全绿**（含新增 2 例全局串行与原有全部回归）；`serverStructure.test.ts` 单跑 3/3。
- `git diff --check` 无空白错误。

## §20 §14.10 “编辑后批准 + diff”交付（2026-09-20）

计划 §14.10 四条要求中，“用户可编辑脚本后再批准（编辑版必须重新过静态校验）”与“批准界面展示原始与编辑后脚本的 diff”此前完全没实现：批准只能跑提案原文。

### 20.1 服务端

- `approveRun(runId, { script? })`：传入与提案不同的脚本时，**先重跑 `validateWorkflowScript`**，失败抛 `WORKFLOW_SCRIPT_INVALID`（带 diagnostics）并且**不迁移任何状态**；通过则把新内容与新的 `scriptHash` 固化进 RunRecord，并运行编辑版（而非提案原文）。
- 顺序：静态校验 → 全局串行闸门 → `blocked → queued` 迁移 → 事件 → `launchRun`；任一步失败都不会留下 queued/blocked 半状态。
- 返回体新增 `scriptEdited?` 与 `scriptHash`（批准后真实生效的指纹）。
- `POST /api/workflows/runs/:runId/approve` 新增 strict `approveWorkflowRunRequestSchema`（只允许 `{ script }`，空 body 仍为批准原提案）；非法字段一律 400，与其余端点一致。

### 20.2 两端 UI

- `WorkflowRequestList` 新增 `currentScript` / `onLoad`，`onApprove(request, editedScript?)`：
  - 「载入编辑」把提案原文导入编辑区；
  - 编辑区与提案不同时，显示行级 diff 摘要（`+N / -M 行`，复用 §14.7 的 `diffScripts`），主按钮变为「批准编辑后脚本」（传编辑版），并额外给「批准原提案」；相同时只有普通「批准」；
  - busy 时按钮全部禁用；无解释性副标题，标签直接服务操作。
- 两端 `workflowScriptClient.approveWorkflowRequest(runId, script?)` 同步；`WorkflowRequestDecision` 补 `scriptEdited/scriptHash`。

### 20.3 验证

- 单元/契约：`§14.10 编辑后批准` 用例——非法编辑（import）被拒且 RunRecord/TaskRun 仍 blocked、hash 未变；合法编辑后 `scriptEdited=true`、`scriptHash` 变为新 64 位值、`record.script` 为编辑版、run 跑完 `completed`、**AgentCall 提示词是编辑后新增的那条**（证明真跑了编辑版）。路由用例覆盖 202/空 body/多余字段拒绝。
- 组件渲染：`WorkflowRequestList` 新增“未编辑时无 diff / 编辑后出现 +1 / -0、批准编辑后脚本、批准原提案”断言（两端）。
- 真实浏览器（本机 5178 Vite + 可记录请求体的 fetch 桩，未启 API）：点「载入编辑」→ 编辑区填入提案原文且**无 diff** → 用原生 setter + input 事件真实改动脚本 → 出现「已编辑」且按钮变为「批准编辑后脚本 / 批准原提案」→ 点前者，`POST /api/workflows/runs/wfrun_edit/approve` 请求体实测包含新增的 `agent('added step')` 行（200 字符），待批准区就地消失并转入监控；console 22 条 error 全为有意 500，**无未捕获异常**。验收后已关闭 5178 并确认端口释放，无临时文件残留。
- `npx tsc -b` exit 0；涉及文件 eslint 0 错 0 警；`npx vitest run apps/api` → **51 文件 / 385 测试全绿**；`git diff --check` 无空白错误。



## §21 真实 API + SQLite Goal × Workflow 生命周期验收（2026-09-21）

本轮完成计划 §7 P6 的真实后端验收补口。测试不是 mock 路由：使用已构建的 API 进程、真实 SQLite storage 与真实 HTTP 请求，覆盖创建任务、启动、查询运行与 Goal 状态、暂停、恢复、证据查询和线程清理。

### 21.1 pause / resume 真实链路

- `POST /api/tasks` 创建 Goal Task，`POST /api/tasks/:id/start` 启动 GoalRun。
- `POST /api/tasks/:id/pause` 返回 `run.status = paused`。
- `POST /api/tasks/:id/resume` 返回 `run.status = running`。
- pause 前后的 `harnessRunId` 完全一致；未出现 `Harness run ... already exists`。
- 根因修复：pause 使用 `AbortSignal.reason = { type: 'suanlizi-harness-suspend' }` 表达“暂停而非取消”；registry 删除运行时条目但不创建第二个同 ID harness；GoalTracker 保持 active，resume 复用原 harnessRunId。
- 同链路已查询 `GET /api/tasks/:id`、`/runs`、`/evidence`、`/goal-status`，确认 Task/Run/证据/Goal 投影接口可读。

### 21.2 真实验收中发现并修复的配置问题

创建 Thread 时虽然 `ThreadMeta.workspaceRoot` 为 `D:\\suanlizi`，运行配置却回退到了全局 `D:\\teacher_rag`。原因是 `getThreadRunConfig()` 原先只读取全局 workspaceRoot 与 access policy，没有把非 chat Thread 的工作区元数据作为运行默认值。

已修复 `apps/api/src/config/config.ts`：非 chat Thread 优先使用 `thread.workspaceRoot`，显式线程 access policy 仍优先；同时统一 `path.resolve`，确保运行配置与 access policy 使用同一绝对路径。已补 `apps/api/src/config/config.test.ts`，验证线程工作区优先级。

### 21.3 Run completed 与 Task running 的语义观察

真实模型一次执行可能以 Harness `no_progress` 结束；底层 Run 可记录为 `completed`，但 Task 保持 `running`。这不是本轮继续添加第二套状态推导：现有设计明确规定“Run completed 不等于 Goal 达成”，Task completed 只能由 GoalEvaluator + Evidence gate 判定。该状态应由后续 Goal 验收/用户接管（`input`、`retry`、`redirect` 或 `cancel`）继续推进，不把模型“正常返回”误报为目标完成。

本轮不擅自把 `no_progress` 改写为 `failed` 或 `blocked`，避免破坏“执行结束”和“目标验收失败/等待用户输入”的语义边界；后续若要自动收口，应单独设计并补协议、事件、UI 与恢复测试。

### 21.4 模型协议差异

默认 `giteeai/qwen3.8-flash` 在本次真实任务中多次输出普通文本形式的工具调用，触发 `PLAIN_TEXT_TOOL_CALL_REPEATED` 并停止本轮；切换到结构化工具调用正常的 `custom_api / glm-5.3-flash` 后，Harness 可完成一轮执行。该现象属于模型/网关协议兼容性，不应被误判为 Goal × Workflow 生命周期代码失败。

### 21.5 验证与收口

- `npx tsc -b` 通过。
- `apps/api/src/config/config.test.ts`：33/33 通过。
- 前序定向验证：TaskHarness 7/7、HarnessRuntime、TaskLifecycleService、TaskRoute，以及真实 HTTP/SQLite pause/resume 链路通过。
- `git diff --check` 通过；仅有既有 CRLF 转换提示，无空白错误。
- 本轮 API 进程已在完成验证后停止，并确认 4127、5178 无监听。

> 结论：P6 的真实后端生命周期关键链路已验收；最后发现的 workspaceRoot 回退问题已修复并补测试。剩余的“模型 no_progress 后是否自动把 Task 收口为 blocked/failed”属于独立的状态语义议题，不阻塞本计划已有的 Goal × Workflow 组合交付。
