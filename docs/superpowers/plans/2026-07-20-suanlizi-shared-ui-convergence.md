# Suanlizi 路线三共享 UI 收敛 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在线路二 Web 产品壳已经稳定、Bot Adapter 阶段顺序满足后，把 Web/Desktop 真正同源且通过验收的纯 UI、view model 与样式迁入 `@suanlizi/ui`，删除重复实现，同时保留两端平台能力边界。

**Architecture:** 共享包只拥有纯 view model、无平台副作用的 React presentation、tokens 和 component CSS；Web/Desktop 各自保留 API controller、storage、窗口/文件选择、Tauri command、认证与启动逻辑。迁移从 leaf primitives 开始，以一组件一提交推进；不共享 `main.tsx` 或整个 App shell，不在迁移时重新设计。任何需要超过 3 个平台方法的组件默认留在 app 内。

**Tech Stack:** React 19、TypeScript project references、Vite、Vitest/Testing Library、CSS、npm workspaces。

---

## 当前可行性结论

当前代码的 Web/Desktop 有约 106 个同路径文件，其中 70 个字节级相同、约 320 KB，共享收益客观存在；但 `AGENTS.md` 要求先完成统一 Bot Adapter（QQ、微信/企业微信、飞书、钉钉），当前 `packages/bot` 虽声明五个平台类型，具体实现仍主要是 Weixin bridge 与 DingTalk。因此本计划现在是 **NO-GO / parked**：可以准备审计与门禁，不能在路线二前或 Bot Adapter 未完成时开始 UI 包迁移，除非用户在 M4 明确覆盖阶段顺序。

## GO / NO-GO 硬门槛

只有全部满足才能执行 Task 2 及之后：

- 路线二 M0–M3 全绿，用户确认 Web 主界面、Settings、Monitor、Agent Workbench 方向稳定。
- Trace V2 与 Settings presentation props 在连续两个提交中无破坏性变化。
- `npm run verify`、Web build、Desktop UI build 全绿。
- Bot Adapter 已有统一 interface、QQ/微信/企业微信/飞书/钉钉 adapter contract tests 和至少配置/health/send/receive 的闭环；或用户书面明确允许覆盖阶段顺序。
- 最新 duplication report 仍有不少于 40 个同源候选或 120 KB 可迁移代码。
- Pilot 候选不 import Tauri command、`window.__TAURI__`、Web-only auth/env、Node fs/path 或 app 内 API client。
- Web/Desktop 对候选组件具有同一行为测试矩阵与路线二视觉基线。

任一项不满足：记录 NO-GO 原因并停止；不得以“先建大共享壳以后再修”为由绕过。

### Task 0: 对照 Codex 与项目阶段边界

**Files:**
- Read: `E:/langchain/Suanlizi/AGENTS.md`
- Read: `E:/langchain/codex/codex-rs/app-server-protocol/src/protocol/v2/item.rs`
- Read: `packages/bot/src/types.ts`
- Read: `packages/bot/src/index.ts`
- Read: `apps/web/src/main.tsx`
- Read: `apps/desktop/src/main.tsx`
- Modify: this plan's execution notes only

- [ ] **Step 1: 记录可共享真相源**

Protocol item/trace、纯 formatter、pure reducer/view model 可以共享；窗口生命周期、Tauri command、Web auth、运行服务地址和平台 storage 不共享。Codex 只提供 lifecycle 边界，不提供 Suanlizi UI package 结构。

- [ ] **Step 2: 审计 Bot Adapter gate**

Run:

```powershell
rg -n "BotAdapter|BotPlatform|qq|weixin|wechat-work|feishu|dingtalk" packages/bot/src apps/api/src
npx vitest run packages/bot/src
```

Expected for GO: 五个平台都通过同一 adapter contract suite；只有 union type 或单平台 client 不算完成。若未满足且用户未覆盖，停止本计划并报告 parked。

### Task 1: 建立可重复的重复度与平台耦合报告（NO-GO 时也可执行）

**Files:**
- Create: `scripts/report-ui-duplication.mjs`
- Create: `tests/scripts/report-ui-duplication.test.ts`
- Create: `docs/superpowers/plans/artifacts/ui-duplication-baseline.json`
- Modify: `package.json`

- [ ] **Step 1: 写报告器失败测试**

临时 fixture 覆盖：同路径同 hash、同路径不同内容、仅一端存在、忽略 test/snapshot/dist、统计 bytes/lines、扫描 forbidden imports。输出必须按 relativePath 排序，保证可 diff。

- [ ] **Step 2: 实现只读报告器**

`report-ui-duplication.mjs` 输入默认 `apps/web/src`、`apps/desktop/src`，输出：

```typescript
interface UiDuplicationReport {
  generatedAt: string;
  identical: Array<{ relativePath: string; bytes: number; lines: number }>;
  divergent: Array<{ relativePath: string; webBytes: number; desktopBytes: number }>;
  webOnly: string[];
  desktopOnly: string[];
  forbiddenImports: Array<{ side: 'web' | 'desktop'; path: string; importText: string }>;
  totals: { identicalFiles: number; identicalBytes: number; divergentFiles: number };
}
```

默认 stdout 输出 JSON；`--write <absolute-target>` 才写文件。脚本只读源码，不修改应用。`generatedAt` 在 snapshot test 中由注入 clock 固定。

- [ ] **Step 3: 添加命令并记录路线二后基线**

```json
"report:ui-duplication": "node scripts/report-ui-duplication.mjs"
```

Run:

```powershell
npx vitest run tests/scripts/report-ui-duplication.test.ts
npm run report:ui-duplication -- --write docs/superpowers/plans/artifacts/ui-duplication-baseline.json
```

Expected: JSON 可重复、无绝对用户目录/secret；报告是在路线二完成后重新生成，不能直接拿当前 70 文件数字做 GO 证据。

- [ ] **Step 4: 生成候选分级**

将 identical/divergent 人工分为：

- Tier A：Icon、Dropdown、Dialog、UserAvatar、formatter、pure view model。
- Tier B：ItemView、DiffView、PluginCenter presentation、Monitor presentation、Settings presentation。
- Tier C：Composer、WorkspaceFiles、Workbench presentation。
- Reject：main、API client、auth、Tauri bridge、update checker、platform storage。

每个候选记录 owner、现有测试、平台 import、CSS selectors、props delta。没有测试或 props 尚不稳定的候选不进入 pilot。

- [ ] **Step 5: 提交审计工具**

```powershell
git add scripts/report-ui-duplication.mjs tests/scripts/report-ui-duplication.test.ts docs/superpowers/plans/artifacts/ui-duplication-baseline.json package.json
git commit -m "chore: report web desktop ui duplication"
```

### Task 2: 在 GO 后建立最小 `@suanlizi/ui` 包

**Files:**
- Create: `packages/ui/package.json`
- Create: `packages/ui/tsconfig.json`
- Create: `packages/ui/src/index.ts`
- Create: `packages/ui/src/boundaries.test.ts`
- Modify: `tsconfig.json`
- Modify: `tsconfig.base.json`
- Modify: `vitest.config.ts`
- Modify: `apps/web/tsconfig.json`
- Modify: `apps/desktop/tsconfig.json`
- Modify: `apps/web/package.json`
- Modify: `apps/desktop/package.json`
- Modify: `package-lock.json`

- [ ] **Step 1: 创建不带业务的 package skeleton**

`package.json` 固定：

```json
{
  "name": "@suanlizi/ui",
  "version": "1.5.0",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js" },
    "./styles.css": "./src/styles/index.css"
  },
  "peerDependencies": { "react": "^19.0.0", "react-dom": "^19.0.0" },
  "dependencies": { "@suanlizi/protocol": "1.5.0" },
  "devDependencies": { "@types/react": "^19.0.0", "@types/react-dom": "^19.0.0" }
}
```

TS config extends base，`jsx: react-jsx`、DOM libs、rootDir src、outDir dist，并 reference protocol。`index.ts` 初始只导出 package version 类型，不迁任何组件。

- [ ] **Step 2: 添加 project references 与 alias**

root tsconfig 在 protocol 后加入 ui；Web/Desktop references 加 ui；base paths 与 Vitest alias 加 `@suanlizi/ui`。Web/Desktop package dependencies 加 `"@suanlizi/ui":"1.5.0"`。

- [ ] **Step 3: 请管理员更新 lockfile**

助手不得执行 npm install。由管理员运行以下命令以更新 lockfile 并建立新 workspace link：

```powershell
npm install
```

检查 lockfile 只增加 workspace `packages/ui` 与两端本地依赖，不升级无关包。

- [ ] **Step 4: 添加 boundary test**

测试递归扫描 `packages/ui/src`，禁止 import：`apps/`、Tauri、Node builtins、`window.__TAURI__`、Web API clients、desktopBridge、localStorage/sessionStorage/fetch/EventSource。React/protocol 与包内相对 import 允许。CSS 中禁止 app 根 selector（`.webApp/.desktopApp/#root`）。

- [ ] **Step 5: 构建空包并提交**

```powershell
npx vitest run packages/ui/src/boundaries.test.ts
npm run build
npm --workspace @suanlizi/web run build
npm --workspace @suanlizi/desktop run build:ui
git add packages/ui tsconfig.json tsconfig.base.json vitest.config.ts apps/web/tsconfig.json apps/desktop/tsconfig.json apps/web/package.json apps/desktop/package.json package-lock.json
git commit -m "chore: scaffold shared suanlizi ui package"
```

### Task 3: Pilot 只迁 pure primitives

**Files:**
- Create: `packages/ui/src/primitives/Icon.tsx`
- Create: `packages/ui/src/primitives/Icon.test.tsx`
- Create: `packages/ui/src/primitives/DropdownSelect.tsx`
- Create: `packages/ui/src/primitives/DropdownSelect.test.tsx`
- Create: `packages/ui/src/primitives/DialogSurface.tsx`
- Create: `packages/ui/src/primitives/DialogSurface.test.tsx`
- Create: `packages/ui/src/primitives/UserAvatar.tsx`
- Create: `packages/ui/src/primitives/UserAvatar.test.tsx`
- Create: `packages/ui/src/styles/tokens.css`
- Create: `packages/ui/src/styles/primitives.css`
- Create: `packages/ui/src/styles/index.css`
- Modify: `packages/ui/src/index.ts`
- Modify: `apps/web/src/components/Icon.tsx`
- Modify: `apps/desktop/src/components/Icon.tsx`
- Modify: `apps/web/src/components/DropdownSelect.tsx`
- Modify: `apps/desktop/src/components/DropdownSelect.tsx`
- Modify: `apps/web/src/components/Dialogs.tsx`
- Modify: `apps/desktop/src/components/Dialogs.tsx`
- Modify: `apps/web/src/components/UserAvatar.tsx`
- Modify: `apps/desktop/src/components/UserAvatar.tsx`

- [ ] **Step 1: 先把两端行为测试参数化**

同一 contract suite 对 Web wrapper 与 Desktop wrapper 运行：icon aria-hidden/label、dropdown keyboard、dialog focus/Esc/return、avatar fallback。迁移前先绿；没有 contract test 不迁。

- [ ] **Step 2: 迁到共享包，app 保留 re-export wrapper**

先把字节相同实现移入 `@suanlizi/ui`，旧路径变为一行 re-export，避免一次改完所有 import。组件只收 serializable props/callback，不读取 localStorage/fetch/platform globals。

- [ ] **Step 3: 迁 token 与 component-scoped CSS**

共享 CSS 只定义 `--suanlizi-*` token 和 `.nui-*` 组件类；`styles/index.css` 按 token → primitives 顺序 import，并由两端各自入口 import `@suanlizi/ui/styles.css` 一次。两端各自 root 设置 theme variables。禁止共享一份 8000 行 app stylesheet。视觉不得与路线二基线有意变化。

- [ ] **Step 4: 运行 pilot gate**

```powershell
npx vitest run packages/ui/src/primitives apps/web/src/components apps/desktop/src/components
npm run verify
npm --workspace @suanlizi/web run build
npm --workspace @suanlizi/desktop run build:ui
```

Expected: 两端行为与截图基线一致；boundary test 全绿；若 props adapter 超过 3 个平台方法，回退该组件，不扩大 interface。

- [ ] **Step 5: 提交 pilot**

```powershell
git add packages/ui/src apps/web/src/components/Icon.tsx apps/desktop/src/components/Icon.tsx apps/web/src/components/DropdownSelect.tsx apps/desktop/src/components/DropdownSelect.tsx apps/web/src/components/Dialogs.tsx apps/desktop/src/components/Dialogs.tsx apps/web/src/components/UserAvatar.tsx apps/desktop/src/components/UserAvatar.tsx
git commit -m "refactor: share suanlizi ui primitives"
```

### Task 4: 迁 pure formatter 与 view model

**Files:**
- Create: `packages/ui/src/view-models/itemViewModel.ts`
- Create: `packages/ui/src/view-models/itemViewModel.test.ts`
- Create: `packages/ui/src/view-models/runTraceViewModel.ts`
- Create: `packages/ui/src/view-models/runTraceViewModel.test.ts`
- Create: `packages/ui/src/view-models/agentWorkbenchViewModel.ts`
- Create: `packages/ui/src/view-models/agentWorkbenchViewModel.test.ts`
- Create: `packages/ui/src/formatters/time.ts`
- Create: `packages/ui/src/formatters/usage.ts`
- Create: `packages/ui/src/formatters/status.ts`
- Modify: `packages/ui/src/index.ts`
- Modify: corresponding Web/Desktop feature files selected by Task 1 report

- [ ] **Step 1: 用 golden fixture 锁定输出**

同一个 ThreadItem/Trace/Agent fixture 对 Web 旧函数、Desktop 旧函数和目标 shared 函数生成相同 JSON。时间 formatter 注入 locale/timeZone/now，不读取浏览器全局；usage/status 不包含文案以外副作用。

- [ ] **Step 2: 逐个迁移并删除双份实现**

迁移顺序 item → trace → agent；每个 commit 最多一个 domain。两端 feature 文件改 import 后，删除旧函数和对应重复测试，只保留 shared contract + app integration test。

- [ ] **Step 3: 每个 domain 验证**

```powershell
npx vitest run packages/ui/src/view-models packages/ui/src/formatters apps/web/src/features apps/desktop/src/features
npm --workspace @suanlizi/web run build
npm --workspace @suanlizi/desktop run build:ui
```

- [ ] **Step 4: 提交 domain commits**

```powershell
git commit -m "refactor: share item presentation models"
git commit -m "refactor: share trace presentation models"
git commit -m "refactor: share agent presentation models"
```

每次只 stage 对应 domain；这些命令不是要求连续空提交。

### Task 5: 迁 Monitor 与 Settings presentation

**Files:**
- Create: `packages/ui/src/monitor/RunExplorer.tsx`
- Create: `packages/ui/src/monitor/TraceTimeline.tsx`
- Create: `packages/ui/src/monitor/TraceInspector.tsx`
- Create: `packages/ui/src/monitor/RunMonitorWorkbench.tsx`
- Create: `packages/ui/src/settings/SettingsShell.tsx`
- Create: `packages/ui/src/settings/SettingsNavigation.tsx`
- Create: `packages/ui/src/settings/SettingsFooter.tsx`
- Create: `packages/ui/src/styles/monitor.css`
- Create: `packages/ui/src/styles/settings.css`
- Modify: `packages/ui/src/index.ts`
- Modify: route-two Web files migrated to wrappers
- Modify: corresponding Desktop Monitor/Settings files

- [ ] **Step 1: 先定义 presentation-only props**

Monitor 接收 runs/events/filterState/selection/capabilities 和 callbacks；Settings Shell 接收 registry/draft/saveState 和 callbacks。两者都不能 fetch、创建 EventSource、读 localStorage 或知道 endpoint。Web/Desktop controller 继续 app-owned。

- [ ] **Step 2: 先迁 Monitor presentation**

Monitor 协议已由路线二稳定，优先迁四个纯组件；Web wrapper 接现有 controller，Desktop 创建自己的 controller adapter 消费同一 API。运行 500 行虚拟化、筛选、键盘、control capability contract 和两端截图。

- [ ] **Step 3: 再迁 Settings Shell，不迁平台页面逻辑**

共享 modal/nav/footer/section primitives；模型、插件、Bot、文件选择等 page controller 仍在各 app。只有当某个 page 的 props 完全同构才单独迁 page presentation，禁止为了共享把 Tauri/Web 分支塞进组件。

- [ ] **Step 4: 验证并提交**

```powershell
npx vitest run packages/ui/src/monitor packages/ui/src/settings apps/web/src/components/monitor apps/web/src/components/settings apps/desktop/src/components
npm run verify
npm --workspace @suanlizi/web run build
npm --workspace @suanlizi/desktop run build:ui
git commit -m "refactor: share monitor presentation"
git commit -m "refactor: share settings shell presentation"
```

### Task 6: 评估 Composer/Workbench，拒绝共享整个 App Shell

**Files:**
- Create: `docs/superpowers/plans/artifacts/ui-tier-c-decision.md`
- Modify only Tier C files that independently pass the gate.

- [ ] **Step 1: 对每个 Tier C 候选做 props delta 表**

比较 Composer、WorkspaceFiles、Workbench 的 Web/Desktop props、controller、平台能力。满足以下条件才迁 presentation：70% 以上 JSX/CSS 同源、平台 adapter ≤3 方法、两端测试同构、路线二交互无 pending change。

- [ ] **Step 2: 默认拒绝共享 `main.tsx`/WorkspaceLayout controller**

除非报告证明两个 app shell 70% 以上行为同源，且平台差异可在 ≤3 个窄 adapter 方法表达，否则明确写 `REJECTED`。不创建 `SharedApp`、万能 `platform` 对象或几十个 callback 的超级组件。

- [ ] **Step 3: 对通过者逐个迁移**

一个候选一个 commit；先 contract tests，再 shared presentation，再 app wrapper，最后删除 duplicate。WorkspaceFiles 涉及 file picker/Tauri 时只共享 row/preview presentation，不共享 I/O controller。

- [ ] **Step 4: 提交决策记录**

```powershell
git add docs/superpowers/plans/artifacts/ui-tier-c-decision.md
git commit -m "docs: record tier c ui sharing decisions"
```

### Task 7: 删除旧重复实现并完成路线三验收

**Files:**
- Modify: `scripts/report-ui-duplication.mjs`
- Modify: `docs/superpowers/plans/artifacts/ui-duplication-baseline.json`
- Modify: migrated Web/Desktop wrappers and obsolete CSS/tests only.

- [ ] **Step 1: 重新生成报告**

```powershell
npm run report:ui-duplication -- --write docs/superpowers/plans/artifacts/ui-duplication-after.json
```

Expected: 所有已迁 candidate 不再存在双份实现；剩余 identical 文件有明确 keep-local 原因，不追求数字归零。

- [ ] **Step 2: 删除临时 re-export wrapper**

在所有 imports 已指向 `@suanlizi/ui` 后，才删除旧 wrapper。先 `rg` 确认零引用；禁止删除 app-only controller。CSS selector 同理，DevTools 与测试确认无引用后删除。

- [ ] **Step 3: 全量门禁**

```powershell
npm run verify
npm --workspace @suanlizi/web run build
npm --workspace @suanlizi/desktop run build:ui
npm run report:ui-duplication
```

若当前机器具备 Tauri/Rust toolchain，再运行：

```powershell
npm run desktop:build
```

Expected: Web/Desktop build、shared boundary、全量测试全绿；source artifact guard 无输出。

- [ ] **Step 4: 用户分别重启 Web/Desktop 后做视觉回归**

助手不启动/重启服务。用户确认后，内置浏览器验证 Web 1440/1024/760/390；Desktop 由用户打开，验证 Settings、Monitor、Agent、Composer、文件预览。与路线二基线对比，不允许因共享迁移出现视觉或交互变化。

- [ ] **Step 5: 提交清理**

```powershell
git add packages/ui apps/web apps/desktop scripts/report-ui-duplication.mjs docs/superpowers/plans/artifacts/ui-duplication-after.json
git commit -m "refactor: finish web desktop ui convergence"
```

只有 GO gate、自动化、两端 build 和用户视觉验收全部通过，路线三才算完成；否则保持最后一个已验证的可回退组件提交。
