# Suanlizi 路线二产品化总路线 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在保留 Suanlizi runtime、storage、protocol 与插件中心有效能力的前提下，修正配置与运行状态的正确性，建立可关联、可回放的运行轨迹，并重做 Web 主界面、设置和 Agent 工作台；达到验收门槛后，再进入 Web/Desktop 共享 UI 收敛。

**Architecture:** 路线二以 `apps/web`（5177）作为交互参考实现，协议、存储、API 与运行时改造对 Web/Desktop 同时生效；所有持久化正确性修复同时覆盖两端。运行监控改用 protocol 中的版本化 Trace Envelope，并由 runtime recorder 统一写入、storage 游标分页、SSE 增量推送。路线三不提前重写产品界面，只在路线二交互和协议稳定后，把已经验证的 headless state、组件和样式迁入共享包。

**Tech Stack:** TypeScript 5.8、React 19、Vite 7、Vitest 3、Node HTTP/SSE、SQLite/PostgreSQL、CSS、Playwright。

---

## 一、已确认的产品决策

1. 采用路线二；不接受只换配色、只改间距的表面翻新。
2. 插件中心保留现有搜索、分类、卡片和安装流程，只迁移到新的 Settings Shell，并统一状态反馈与视觉 token。
3. Settings 不再用一份 `config` 同时代表全局默认、当前线程和新线程草稿。固定拆为：
   - `globalDefaults`：新线程默认运行配置，包括 runtime 使用的 `locale`；
   - `activeThreadOverrides`：当前线程允许覆盖的八个运行字段；完整配置由 defaults + overrides 解析；
   - `newThreadOverrides`：创建新项目/对话时的工作区与运行选择；
   - `appearance`：仅应用级本地主题与头像状态，不包含 runtime locale。
4. 模型预设只包含 `provider`、`model`、`baseUrl`，不包含权限、记忆、工作区、主题、运行模式或密钥。
5. 监控不再维护独立的松散字符串埋点。所有历史信息以 `runId + turnId + spanId + itemId` 关联，并由投影器生成 Run 汇总。
6. 右栏改为可折叠工作台，包含“活动 / Agents / 文件”；主控机器人只用于空闲态，不承担信息展示。
7. 路线二完整交互先在 Web 验收；Desktop 必须持续通过类型检查和构建，并使用同一 Trace 协议。路线三负责把已验证的 Web 组件共享并替换 Desktop 旧实现。
8. Trace V2 启用后不在 UI 中双读旧 `run_events`。旧表保留用于回退取证，但新 Monitor 只展示 V2 数据，避免长期兼容分支。
9. 执行功能任务前必须先对照 `E:\langchain\codex` 的 app-server item lifecycle、rollout trace、thread status 与 resume 行为；采用其“有序原始观察 + 确定性投影”边界，但适配 Suanlizi 的 Web/API/SQLite 架构。

## 二、目标结构

```text
Thread configuration
├─ global defaults
├─ active-thread snapshot
├─ new-thread draft
└─ appearance (local UI only)

Run trace
└─ Run
   └─ Turn
      └─ Agent / Iteration
         ├─ Context span
         ├─ Model span
         ├─ Middleware span
         ├─ Item / Tool span
         ├─ File / Checkpoint span
         └─ Evidence / Error span

Web product shell
├─ Workspace navigation
├─ Conversation surface
│  ├─ Header
│  ├─ Transcript
│  └─ Composer + advanced controls
└─ Right workbench
   ├─ Live activity HUD
   ├─ Agent tree + inspector
   └─ Workspace files
```

## 三、子计划与依赖

| 顺序 | 子计划 | 可独立交付的结果 | 依赖 |
|---|---|---|---|
| A | [P0 正确性与工程基础](./2026-07-20-suanlizi-correctness-foundation.md) | lint、生成物、配置作用域、线程切换、滚动和旧 Monitor 数据归属正确 | 无 |
| B | [Trace V2 与深度监控](./2026-07-20-suanlizi-run-trace-observability.md) | typed trace、游标存储、SSE replay、三栏 Monitor | A |
| C | [主界面、设置与 Agent 工作台](./2026-07-20-suanlizi-product-shell-settings-agents.md) | 新 Product Shell、Settings IA、Agent Tree/Inspector、响应式与无障碍 | A；Agent HUD 使用 B 的 summary |
| D | [路线三共享 UI 收敛](./2026-07-20-suanlizi-shared-ui-convergence.md) | `@suanlizi/ui`、Web/Desktop adapter、重复实现删除 | B、C 通过验收门 |

执行依赖允许 B 与 C 的纯 UI 骨架并行，但以下接口必须先锁定：

- A 先提交 `RunControlRequest/RunControlCapabilities`；B 再提交 `RunTraceEnvelope/RunTraceSummary`，并复用同一控制协议。
- C 的 Agent HUD 只依赖上述公开类型，不读取 runtime 内部 session。
- C 的 Settings 与 Composer 不依赖 B，可以在 A 完成后并行。
- B 的 Task 7（Monitor React Workbench）依赖 C Task 1 的 Testing Library/Playwright 基线；B 的 protocol/storage/runtime/API Tasks 1–6 不依赖它。
- D 只能迁移已通过行为测试和视觉验收的组件，不在迁移时重新设计交互。

## 四、里程碑与验收门

### M0：基线可验证

- [ ] `git check-ignore packages/memory/src/memory.js` 返回成功。
- [ ] `npm run lint` 退出码为 0。
- [ ] `npm test` 全量通过。
- [ ] `npm run build` 退出码为 0，且 `git status --short` 不产生 `src/*.js`、`src/*.d.ts` 或 map 文件。

### M1：状态正确性

- [ ] 打开 Settings 不再改变任何配置。
- [ ] 取消“保存模型预设”后，global、thread 与 provider key 均不发生写入。
- [ ] 应用模型预设只改变 `provider/model/baseUrl`。
- [ ] 全局默认保存只调用 `/api/settings`；当前线程保存只调用 `/api/threads/:id/config`。
- [ ] 连续快速切换两个线程时，较早请求不得覆盖较晚线程的 items、turns、usage、workflow 或 SSE。
- [ ] 用户离开消息底部阅读历史时，新 delta 不抢滚动；出现“回到底部”动作。
- [ ] 历史 Run 页面不再混入当前线程 task state 或 items。
- [ ] interrupt 只命中 active-run registry 中该 runId 对应的 AgentLoop；陈旧 running 记录不得宣称可中断。

### M2：Trace V2 可回放

- [ ] protocol 的 16 种 `ThreadItem` 都有明确的 trace 投影测试。
- [ ] model span 包含 provider、model、attempt、TTFT、usage、cache、finish reason 与 duration。
- [ ] tool span 包含 callId、itemId、策略/审批、递归脱敏参数摘要、结果摘要、exit code、output bytes 与 duration。
- [ ] subagent、file change、checkpoint、context、memory、error、interrupt/rollback 都能从历史 Run 复原。
- [ ] 500 条以上 trace 使用 before/after cursor 分页，终态不会因 `LIMIT` 被截掉。
- [ ] SSE 中一个模型 delta 不触发三次全量 Monitor 请求；断线后从最后 sequence 补发。
- [ ] 不支持的控制动作返回 4xx/501；前端只展示当前 Run 合法动作。
- [ ] accepted interrupt/resume/rollback 生成独立 control Run 并以 parentRunId 指向目标；目标终态 Run 不再被追加事件。

### M3：Web 产品界面验收

- [ ] 1440、1024、760、390 CSS 像素宽度下，聊天、Composer 和右栏不存在互相挤压或“按钮开启但面板隐藏”。
- [ ] Settings 使用真正的 modal 语义，支持 Esc、焦点锁定、保存中、失败、dirty、放弃修改。
- [ ] 插件中心功能无回归。
- [ ] Agent Tree 展示状态、角色、当前 item、耗时、工具数、token、错误；点击后打开 Inspector。
- [ ] Monitor 支持分组、搜索、类别筛选、仅错误、结构化 Inspector 和 500+ 行虚拟化。
- [ ] 动画遵循 `prefers-reduced-motion`，所有异步结果有可感知反馈。
- [ ] 性能设置读取 tenant 级唯一 SystemMonitor owner，明确区分 disabled/not-sampled/healthy/unavailable，创建多个 Agent 不会创建多个采样器。
- [ ] Web 行为测试、Playwright 关键路径、浅色/深色视觉快照均通过。

### M4：路线三准入

只有以下条件全部满足才执行 D：

- [ ] M0–M3 全部通过，并由用户确认 Web 交互方向不再大改。
- [ ] Trace V2 与 Settings props 在连续两个路线二提交中无破坏性变化。
- [ ] `scripts/report-ui-duplication.mjs` 证明 Web/Desktop 可迁移的同源文件不少于 40 个或不少于 120 KB。
- [ ] 共享候选文件不直接导入 `window.__TAURI__`、桌面 command 或 Web 专属环境变量。
- [ ] Web 与 Desktop 都有相同关键路径测试矩阵，可在迁移前后对比。
- [ ] 路线三首个 pilot 只迁移 Icon、Dropdown、Dialog primitives 和纯 formatter；pilot 构建通过后才迁移 Settings/Monitor。
- [ ] `AGENTS.md` 规定的统一 Bot Adapter（QQ、微信/企业微信、飞书、钉钉）里程碑已完成；若未完成，必须由用户在 M4 明确批准覆盖该阶段顺序。

当前只读基线已发现 Web/Desktop 有 70 个字节级相同文件、约 320 KB，因此“共享价值”条件已满足；是否真正进入路线三仍由 M4 的稳定性条件决定。

## 五、提交序列

每个提交必须满足自身测试，禁止把正确性、数据迁移和视觉重做塞进同一提交：

1. `chore: restore lint and generated artifact guards`
2. `fix: separate global and thread configuration scopes`
3. `fix: guard thread loading and transcript follow state`
4. `fix: bind monitor data and controls to the selected run`
5. `feat: define run trace v2 protocol`
6. `feat: persist and page run trace events`
7. `feat: record model tool item and agent spans`
8. `feat: replay run trace events over sse`
9. `feat: rebuild run monitor explorer and inspector`
10. `feat: rebuild settings around explicit drafts`
11. `feat: add responsive conversation shell and composer controls`
12. `feat: add agent workbench and inspector`
13. `test: add suanlizi product shell interaction coverage`
14. 路线三提交序列见 D 子计划。

## 六、实施方式

- [ ] 执行前使用 `superpowers:using-git-worktrees` 建立隔离工作区；当前 checkpoint `c255b35` 作为比较基线。
- [ ] 每个子计划的 Task 0 记录所参考的 Codex 文件、采用的生命周期边界和明确不采用的 CLI/TUI 结构。
- [ ] 使用 `superpowers:subagent-driven-development` 按子计划逐任务执行，每个任务进行规格审查和代码质量审查。
- [ ] 每个行为改动先写失败测试，确认失败原因，再写最小实现。
- [ ] 每个阶段完成时运行该阶段定向测试、`npm test`、`npm run lint`、`npm run build`。
- [ ] M3 使用内置浏览器和 Playwright 同时验证；人工观察不能替代自动行为断言，自动测试也不能替代视觉检查。
- [ ] M4 未通过时，路线三保持未开始，路线二成果独立可发布。
