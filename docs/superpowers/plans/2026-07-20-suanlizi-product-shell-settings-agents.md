# Suanlizi Web 主界面、设置与 Agent 工作台 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 5177 的 Web 界面从“巨型页面 + 巨型设置抽屉 + 装饰性人物卡”重构为清晰的对话工作台：主任务始终突出，设置有明确作用域和提交语义，右栏能真正理解 Agent 当前在做什么，插件中心能力不回归。

**Architecture:** `main.tsx` 只组合 controllers 与 product shell；线程、Composer、Settings、Workbench 各自拥有 headless state/controller，展示组件不直接请求 API。Settings 使用 modal shell + page registry + explicit draft/baseline；Composer draft 以 threadId 隔离；右栏以 Trace V2 summary 与 child-thread API 构造只读 view model。路线二只完成 Web，Desktop 仅保持 build，视觉共享留到路线三。

**Tech Stack:** React 19、TypeScript、CSS、Vitest + Testing Library、Playwright、内置浏览器。

---

## 产品约束

1. 保留插件中心现有搜索、分类、卡片、安装/移除和 MCP 联动；本计划只换 Shell、反馈和 token，不重写业务流。
2. Settings 打开/切页/关闭不得远程写入。运行配置必须明确选择“设为默认”或“应用到当前对话”；外观仅写本地应用状态；实体动作（安装插件、保存 key、绑定 env、连接 Bot）各自独立提交并显示结果。
3. Composer 一级只展示模型、权限、附件、发送/停止；reasoning、run profile、联网、远程助手进入“运行选项”。高级能力可发现，但不与主动作争抢。
4. 右栏只显示当前状态、Agents、文件，不重复用户消息或完整 transcript。机器人插画只允许出现在没有 child agent 的空状态，不再占主卡大面积。
5. transcript 与右栏内部滚动，Composer 始终可见；Enter 发送、Shift+Enter 换行；用户离开底部后流式内容不抢滚动。
6. 1440/1024/760/390 四个宽度必须有明确布局，不允许“右栏按钮 active 但 pane 被 CSS 隐藏”。
7. `main.tsx` 目标不超过 500 行；任一新组件/controller 不超过 500 行，Settings page 目标不超过 350 行；不得再制造 2000 行 Drawer 或 8000 行样式文件。

### Task 0: 对照 Codex 的 UI 数据边界

**Files:**
- Read: `E:/langchain/codex/codex-rs/app-server-protocol/src/protocol/v2/item.rs`
- Read: `E:/langchain/codex/codex-rs/app-server-protocol/src/protocol/v2/notification.rs`
- Read: `E:/langchain/codex/codex-rs/app-server/src/thread_status.rs`
- Read: `apps/web/src/main.tsx`
- Read: `apps/web/src/components/SettingsDrawer.tsx`
- Read: `apps/web/src/components/RightPane.tsx`
- Read: `apps/web/src/components/AgentStagePanel.tsx`
- Modify: this plan's execution notes only

- [ ] **Step 1: 记录采用的产品边界**

采用：thread status 与 active turn 分离、item 是对话真相源、Agent/工具状态从 canonical event 投影、resume 重新订阅。右栏只能消费 summary/view model，不把自己的展示状态写回 runtime。

- [ ] **Step 2: 记录不采用的结构**

不复制 Codex TUI 布局、command palette 样式或 CLI 分屏；Suanlizi 是 Web 产品壳，需保留鼠标/触控、响应式、modal 与现有插件/文件预览能力。

### Task 1: 建立可测试的 Web 交互基线

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `vitest.config.ts`
- Create: `apps/web/src/test/render.tsx`
- Create: `apps/web/src/test/render.test.tsx`
- Create: `playwright.config.ts`
- Create: `tests/e2e/suanlizi-product-shell.spec.ts`

- [ ] **Step 1: 请管理员安装 UI 测试依赖**

由管理员运行；助手根据 `AGENTS.md` 不得执行：

```powershell
npm install --save-dev @testing-library/react @testing-library/user-event @testing-library/jest-dom jsdom @playwright/test
npx playwright install chromium
```

管理员完成后确认 `package.json`/`package-lock.json` 更新，且没有生产 dependency 变化。

- [ ] **Step 2: 让 Vitest 收集 TSX 测试**

将 include 改为：

```typescript
include: [
  'tests/**/*.test.{ts,tsx}',
  'packages/*/src/**/*.test.{ts,tsx}',
  'apps/*/src/**/*.test.{ts,tsx}',
],
```

`render.tsx` 导入 `@testing-library/jest-dom/vitest`，封装 userEvent 与必要 provider；UI test 文件首行使用 `// @vitest-environment jsdom`，避免所有 runtime/storage 测试切到 jsdom。

- [ ] **Step 3: 写测试工具 smoke test**

渲染一个带 label/button/dialog 的 fixture，断言按 role 查询、Tab 焦点和 user click 可用。Run:

```powershell
npx vitest run apps/web/src/test/render.test.tsx
npm run build
```

Expected: PASS 且 build 退出 0。

- [ ] **Step 4: 建立不自动启动服务的 Playwright 配置**

`playwright.config.ts` 使用 `baseURL: process.env.SUANLIZI_BASE_URL ?? 'http://127.0.0.1:5177'`，不配置 `webServer`，遵守“助手不启动/重启服务”。必须设置 `testDir:'./tests/e2e'`、`testMatch:'**/*.spec.ts'`，防止 Playwright 把全仓 Vitest `.test.ts/.tsx` 当 E2E；`outputDir:'./outputs/playwright'`，默认 chromium、trace on-first-retry、screenshot only-on-failure。root scripts 加：

```json
"test:e2e": "playwright test",
"test:e2e:ui": "playwright test --ui"
```

首个 spec 只断言当前应用已经具备的稳定锚点：应用可达、主导航/Composer/设置按钮可按 role 找到。该 smoke spec 在提交前必须通过；路线二尚未实现的行为留到 Task 8 先写红灯再完成，不提交永久失败测试。所有会写配置、安装插件或创建线程的 E2E 默认使用 `page.route()` 固定 mock；若必须命中真实 API，则使用隔离 test tenant 并在 `afterEach` 通过公开删除 API 清理，禁止污染用户当前 5177 数据。

- [ ] **Step 5: 提交测试基线**

```powershell
git add package.json package-lock.json vitest.config.ts apps/web/src/test playwright.config.ts tests/e2e/suanlizi-product-shell.spec.ts
git commit -m "test: add web interaction and e2e harness"
```

### Task 2: 先无行为变化拆开巨型 SettingsDrawer

**Files:**
- Create: `apps/web/src/components/settings/SettingsShell.tsx`
- Create: `apps/web/src/components/settings/SettingsNavigation.tsx`
- Create: `apps/web/src/components/settings/SettingsFooter.tsx`
- Create: `apps/web/src/components/settings/SettingsSection.tsx`
- Create: `apps/web/src/components/settings/pages/GeneralSettingsPage.tsx`
- Create: `apps/web/src/components/settings/pages/ModelConnectionsPage.tsx`
- Create: `apps/web/src/components/settings/pages/AppearanceSettingsPage.tsx`
- Create: `apps/web/src/components/settings/pages/MemoryContextPage.tsx`
- Create: `apps/web/src/components/settings/pages/PerformanceSettingsPage.tsx`
- Create: `apps/web/src/components/settings/pages/PluginCenterPage.tsx`
- Create: `apps/web/src/components/settings/pages/PluginCenterPage.test.tsx`
- Create: `apps/web/src/components/settings/pages/RemoteAssistantsPage.tsx`
- Create: `apps/web/src/components/settings/pages/AdvancedSettingsPage.tsx`
- Create: `apps/web/src/components/settings/settingsPageRegistry.ts`
- Create: `apps/web/src/components/settings/settingsPageRegistry.test.ts`
- Modify: `apps/web/src/components/SettingsDrawer.tsx`
- Modify: `apps/web/src/settingsNavigation.test.ts`
- Modify: `apps/web/src/skillsSettings.test.ts`

- [ ] **Step 1: 锁定现有插件中心 contract**

在拆分前补测试：catalog 搜索、category filter、installed filter、安装/移除回调、MCP badge、错误状态、空状态、keyboard activation。记录当前 API callback 数量和 payload。拆分后同一组测试不得变化。

- [ ] **Step 2: 建立 page registry**

固定导航：

```text
常规
  ├─ 通用与语言
  ├─ 模型与连接
  └─ 外观
运行
  ├─ 记忆与上下文
  └─ 性能与监控
扩展
  ├─ 插件中心
  └─ 远程助手
高级
  └─ 管理与诊断
```

Registry 项包含 id、group、label、icon、keywords、render；搜索只过滤导航，不卸载当前 dirty page。旧 section id 通过单次映射迁移本地选中页，不保留两套渲染路径。

- [ ] **Step 3: 将 Drawer 变成薄适配器**

`SettingsDrawer.tsx` 只做旧 props 到 `SettingsShellProps` 的一次映射，目标不超过 120 行；各页面先原样移动现有表单/回调，不在本提交改变保存语义或 CSS。`PluginCenterPage` 直接承接原 JSX 与 handlers，禁止顺手改业务。

- [ ] **Step 4: 保持现有 overlay 行为完成结构拆分**

`SettingsShell` 先复用现有 overlay/open/close 结构，只把 header/navigation/body/footer 拆开；不在重构提交同时改变 focus、Esc、backdrop 或保存时机。真实 modal、dirty guard 和焦点恢复统一在 Task 3 实现并测试。

- [ ] **Step 5: 运行结构回归并提交**

```powershell
npx vitest run apps/web/src/components/settings/settingsPageRegistry.test.ts apps/web/src/components/settings/pages/PluginCenterPage.test.tsx apps/web/src/settingsNavigation.test.ts apps/web/src/skillsSettings.test.ts apps/web/src/features/settings/mcpConfig.test.ts
npm run build
git add apps/web/src/components/SettingsDrawer.tsx apps/web/src/components/settings apps/web/src/settingsNavigation.test.ts apps/web/src/skillsSettings.test.ts
git commit -m "refactor: split settings into page components"
```

Expected: 插件中心功能与 callback contract 不变；`SettingsDrawer.tsx` 小于 120 行，任一 page 小于 500 行。

### Task 3: 实现 Settings draft、作用域与错误闭环

**Files:**
- Create: `apps/web/src/features/settings/settingsDraft.ts`
- Create: `apps/web/src/features/settings/settingsDraft.test.ts`
- Create: `apps/web/src/features/settings/useSettingsController.ts`
- Create: `apps/web/src/features/settings/useSettingsController.test.tsx`
- Create: `apps/web/src/api/httpClient.ts`
- Create: `apps/web/src/api/httpClient.test.ts`
- Create: `apps/web/src/components/settings/SettingsScopePicker.tsx`
- Create: `apps/web/src/components/settings/UnsavedChangesDialog.tsx`
- Create: `apps/web/src/components/settings/SettingsSaveStatus.tsx`
- Modify: `apps/web/src/components/settings/SettingsShell.tsx`
- Modify: `apps/web/src/components/settings/SettingsFooter.tsx`
- Modify: `apps/web/src/components/settings/pages/ModelConnectionsPage.tsx`
- Modify: `apps/web/src/components/settings/pages/AppearanceSettingsPage.tsx`
- Modify: `apps/web/src/components/settings/pages/MemoryContextPage.tsx`
- Modify: `apps/web/src/components/settings/pages/AdvancedSettingsPage.tsx`
- Modify: `apps/web/src/api/botClient.ts`
- Modify: `apps/web/src/api/botClient.test.ts`
- Modify: `apps/web/src/api/webProviderClient.ts`
- Create: `apps/web/src/api/webProviderClient.test.ts`
- Modify: `apps/web/src/main.tsx`

- [ ] **Step 1: 写 draft reducer 失败测试**

State 明确包含：

```typescript
interface DraftSlice<T> {
  baseline: T;
  draft: T;
  dirtyPaths: string[];
  saveState: 'idle' | 'saving' | 'saved' | 'error';
  error?: string;
}

interface SettingsDraftState {
  global: DraftSlice<Partial<GlobalRuntimeConfig>>;
  activeThread: DraftSlice<ThreadRunConfigOverrides>;
  appearance: DraftSlice<Partial<AppearanceConfig>>;
  target: 'global-defaults' | 'active-thread';
}
```

测试：open clone baseline 不写 API；edit 只变 draft；revert page；discard all；successful save 更新 baseline/清 dirty；failed save 保留 draft/dirty；active thread 不存在时禁用 target；切换 target 不携带对方 dirty；close dirty 返回 `confirmation-required`。

- [ ] **Step 2: 实现页面级 dirty 与显式保存**

Footer 固定按钮：`取消/放弃修改`、`恢复本页`、主按钮。运行字段根据 ScopePicker 显示“设为新对话默认”或“应用到当前对话”；外观显示“应用外观”；不使用模糊的“保存全部”。保存中禁用同域控件，成功显示短暂状态，失败在 Footer 和具体字段显示 error，禁止 toast 一闪而过后丢 draft。

- [ ] **Step 3: 区分 draft 字段与实体命令**

- 模型/provider/baseUrl、权限、web search、reasoning、run profile 属于 global/thread draft。
- theme/avatar 属于 appearance draft，只写 local storage。
- locale、memory、context、system monitor、dataDir、skillsRoot、web provider 属于 global settings；locale 同时驱动 Web 文案和 runtime/Bot 语言，不能降为只在浏览器生效。
- provider key/env binding、插件 install/uninstall、MCP 保存、Bot/remote connect 是独立命令，各自有明确按钮、pending/success/error，不进入 Footer batch save。

打开/关闭、input blur、切页不得调用这些命令。

- [ ] **Step 3a: 统一 Settings mutation 的 HTTP 错误语义**

```typescript
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | null,
    message: string,
  ) { super(message); }
}

export async function requestJson<T>(input: RequestInfo, init?: RequestInit): Promise<T>;
```

`requestJson` 对非 2xx 解析安全的 `{code,message}` 后抛 `HttpError`，204 返回 `undefined as T`，AbortError 原样透传。将本任务触及的 settingsClient、botClient、webProvider mutation 和插件/MCP command adapter 改用它；每个 controller 把 error 留在对应 draft/command state。测试 400 JSON、500 非 JSON、204、abort 和 retry，禁止 catch 后假装 saved。

- [ ] **Step 4: 实现真实 modal 与 dirty close guard**

`SettingsShell` 使用 `<dialog>` 或现有 `AppDialog` 的 native-dialog 封装，具备 `aria-labelledby`、初始焦点、Tab/Shift+Tab 锁定、Esc 请求关闭、关闭后焦点回设置按钮。点击 X、backdrop、Esc、导航离开时，如果 dirty，打开 `UnsavedChangesDialog`，提供“继续编辑 / 放弃 / 保存并关闭”。保存失败停留在 Settings。嵌套 dialog 关闭后焦点返回触发元素；不能让 backdrop click 穿透到主界面。

- [ ] **Step 5: 写取消预设与 API 路径测试**

取消模型预设命名时，创建 provider、保存 key/env、POST preset 都是 0 次。保存 global 只请求 `/api/settings`；thread 只请求 `/api/threads/:id/config`；外观不请求网络；打开关闭 0 次 PATCH。

- [ ] **Step 6: 运行并提交**

```powershell
npx vitest run apps/web/src/api/httpClient.test.ts apps/web/src/api/botClient.test.ts apps/web/src/api/webProviderClient.test.ts apps/web/src/features/settings/settingsDraft.test.ts apps/web/src/features/settings/useSettingsController.test.tsx apps/web/src/features/settings/settingsClient.test.ts apps/web/src/modelSettingsDraft.test.ts apps/web/src/composerModelPresets.test.ts
npm run build
git add apps/web/src/api/httpClient.ts apps/web/src/api/httpClient.test.ts apps/web/src/api/botClient.ts apps/web/src/api/botClient.test.ts apps/web/src/api/webProviderClient.ts apps/web/src/api/webProviderClient.test.ts apps/web/src/features/settings apps/web/src/components/settings apps/web/src/main.tsx
git commit -m "feat: rebuild settings around explicit drafts"
```

### Task 4: 让“性能与监控”展示真实系统状态

**Files:**
- Modify: `packages/runtime/src/agent.ts`
- Modify: `packages/runtime/src/agent.test.ts`
- Modify: `packages/runtime/src/systemMonitor.ts`
- Create: `packages/runtime/src/systemMonitor.test.ts`
- Create: `apps/api/src/routes/systemMonitorRoute.ts`
- Create: `apps/api/src/routes/systemMonitorRoute.test.ts`
- Modify: `apps/api/src/runtime/tenantRuntime.ts`
- Modify: `apps/api/src/runtime/tenantRuntime.test.ts`
- Modify: `apps/api/src/runtime/shutdown.ts`
- Modify: `apps/api/src/runtime/shutdown.test.ts`
- Modify: `apps/api/src/server.ts`
- Create: `apps/web/src/api/systemMonitorClient.ts`
- Create: `apps/web/src/api/systemMonitorClient.test.ts`
- Create: `apps/web/src/components/settings/SystemMonitorStatusCard.tsx`
- Create: `apps/web/src/components/settings/SystemMonitorStatusCard.test.tsx`
- Modify: `apps/web/src/components/settings/pages/PerformanceSettingsPage.tsx`

- [ ] **Step 1: 写 API 状态测试**

`GET /api/system-monitor/status` 返回 `{configuredEnabled, samplerState, level, recommendation, snapshot, lastSampleAt, lastError}`；`samplerState` 是 `disabled | not_sampled | healthy | unavailable`。未采样不能伪造 CPU=0 为健康。跨 tenant 只读各自 owner。采样错误保留最后一次 good snapshot，同时返回 unavailable 与安全错误码，不泄露 stack。

- [ ] **Step 2: 暴露只读 runtime 状态**

建立 tenant 级 `SystemMonitor` owner：tenant runtime 创建一次、启动一次，所有本 tenant AgentLoop 只注入/订阅该实例，不得在 `createAgent` 中各自 new sampler。`AgentLoop` 增加“使用外部 monitor 但不拥有其 stop 生命周期”的注入边界；现有 child 也复用同一实例。保存开关/阈值调用 owner 的 `updateConfig`，tenant shutdown 唯一负责 stop。

`SystemMonitor` 记录 `lastSampleAt` 与脱敏 `lastError`；sample catch 不再完全吞掉，`getHealth()` 区分 configured enabled 与 sampler availability。`tenantRuntime.getSystemMonitorStatus(tenantId)` 直接读 owner；不得在 GET 时创建 Agent 或 sampler。测试连续 createAgent 仍只有一个采样 timer，所有 agent 看到相同 level；shutdown 后 timer 清零。

- [ ] **Step 3: 实现状态卡**

状态卡分别展示 configuredEnabled、samplerState、level、CPU、内存、磁盘最小可用空间、最后采样时间、实际限流影响；5 秒轮询仅在 Performance page 可见且 Settings 打开时运行，隐藏/关闭立即 abort。not_sampled/unavailable/disabled 有不同文案，不能全显示绿色。

- [ ] **Step 4: 运行并提交**

```powershell
npx vitest run packages/runtime/src/systemMonitor.test.ts packages/runtime/src/agent.test.ts apps/api/src/routes/systemMonitorRoute.test.ts apps/api/src/runtime/tenantRuntime.test.ts apps/api/src/runtime/shutdown.test.ts apps/web/src/api/systemMonitorClient.test.ts apps/web/src/components/settings/SystemMonitorStatusCard.test.tsx
npm run build
git add packages/runtime/src/systemMonitor.ts packages/runtime/src/systemMonitor.test.ts packages/runtime/src/agent.ts packages/runtime/src/agent.test.ts apps/api/src/routes/systemMonitorRoute.ts apps/api/src/routes/systemMonitorRoute.test.ts apps/api/src/runtime/tenantRuntime.ts apps/api/src/runtime/tenantRuntime.test.ts apps/api/src/runtime/shutdown.ts apps/api/src/runtime/shutdown.test.ts apps/api/src/server.ts apps/web/src/api/systemMonitorClient.ts apps/web/src/api/systemMonitorClient.test.ts apps/web/src/components/settings/SystemMonitorStatusCard.tsx apps/web/src/components/settings/SystemMonitorStatusCard.test.tsx apps/web/src/components/settings/pages/PerformanceSettingsPage.tsx
git commit -m "feat: expose truthful system monitor status"
```

### Task 5: 重构主 Product Shell 与线程隔离 Composer

**Files:**
- Create: `apps/web/src/components/shell/WorkspaceLayout.tsx`
- Create: `apps/web/src/components/shell/ConversationHeader.tsx`
- Create: `apps/web/src/components/shell/ConversationSurface.tsx`
- Create: `apps/web/src/components/shell/TranscriptPane.tsx`
- Create: `apps/web/src/features/chat/useThreadSession.ts`
- Create: `apps/web/src/features/chat/useThreadSession.test.tsx`
- Create: `apps/web/src/features/input/composerDrafts.ts`
- Create: `apps/web/src/features/input/composerDrafts.test.ts`
- Create: `apps/web/src/features/input/useComposerController.ts`
- Create: `apps/web/src/features/input/useComposerController.test.tsx`
- Create: `apps/web/src/components/composer/ComposerInput.tsx`
- Create: `apps/web/src/components/composer/ComposerPrimaryControls.tsx`
- Create: `apps/web/src/components/composer/ComposerRunOptions.tsx`
- Create: `apps/web/src/components/composer/AttachmentStrip.tsx`
- Modify: `apps/web/src/components/ComposerBar.tsx`
- Modify: `apps/web/src/main.tsx`

- [ ] **Step 1: 写 thread-keyed draft 失败测试**

`ComposerDraftStore` 以 threadId（未创建线程用 `new:<workspaceId>`）保存 text、attachments、run-option draft。测试 A/B 快速切换各自恢复；提交开始不清空；API 接受成功才清空对应 draft；失败保留文字和图片；A 的晚到成功不能清 B；remove image 按稳定 UUID 而非数组 index。

- [ ] **Step 2: 实现 Composer controller**

Controller 负责 Enter/Shift+Enter、composition event、slash palette、paste/drop、submit clientRequestId、busy/stop。视图只收 value/status/actions。测试中文输入法 compositionEnd 前 Enter 不发送；Shift+Enter 始终换行；busy 时 primary action 变“停止”且有可访问名称。

- [ ] **Step 3: 简化一级控制**

Composer 第一行/底栏只保留：模型选择、权限级别、附件、发送/停止。`ComposerRunOptions` popover 提供 reasoning、runProfile、web search、远程助手；每个值明确显示“继承默认”或当前 thread override。模型 preset 应用只改 model 三字段。

- [ ] **Step 4: 抽取 Product Shell**

`WorkspaceLayout` 明确三列：sidebar / conversation / workbench。`ConversationSurface` 使用 `min-height:0`，Transcript 内滚动，Composer 是非滚动底部。Header 展示 workspace、thread title、run status、当前模型和 workbench toggle；低频设置/监控入口放 overflow，不与发送竞争。

`main.tsx` 抽取 thread/settings/composer/workbench controllers 后只负责组合与少量顶层 dialog，目标 ≤500 行。不得把原 1752 行整体搬到一个 `useApp.ts`。

- [ ] **Step 5: 运行并提交**

```powershell
npx vitest run apps/web/src/features/chat/useThreadSession.test.tsx apps/web/src/features/input/composerDrafts.test.ts apps/web/src/features/input/useComposerController.test.tsx apps/web/src/components/ComposerBar.test.ts apps/web/src/features/input/composerInput.test.ts
npm run build
git add apps/web/src/components/shell apps/web/src/features/chat/useThreadSession.ts apps/web/src/features/chat/useThreadSession.test.tsx apps/web/src/features/input apps/web/src/components/composer apps/web/src/components/ComposerBar.tsx apps/web/src/main.tsx
git commit -m "feat: add responsive conversation shell and composer controls"
```

### Task 6: 将右侧人物区重做为可操作的 Agent Workbench

**Files:**
- Create: `apps/web/src/features/agents/agentWorkbenchModel.ts`
- Create: `apps/web/src/features/agents/agentWorkbenchModel.test.ts`
- Create: `apps/web/src/features/agents/useAgentWorkbench.ts`
- Create: `apps/web/src/features/agents/useAgentWorkbench.test.tsx`
- Create: `apps/web/src/components/workbench/WorkbenchTabs.tsx`
- Create: `apps/web/src/components/workbench/LiveActivityHud.tsx`
- Create: `apps/web/src/components/workbench/AgentTree.tsx`
- Create: `apps/web/src/components/workbench/AgentTree.test.tsx`
- Create: `apps/web/src/components/workbench/AgentInspector.tsx`
- Create: `apps/web/src/components/workbench/AgentEmptyState.tsx`
- Create: `apps/web/src/components/workbench/WorkspaceWorkbench.tsx`
- Modify: `apps/web/src/components/RightPane.tsx`
- Modify: `apps/web/src/components/AgentStagePanel.tsx`
- Modify: `apps/web/src/components/TaskRuntimeMonitorPanel.tsx`
- Modify: `apps/web/src/components/WorkspaceFilesPanel.tsx`
- Modify: `apps/web/src/main.tsx`

- [ ] **Step 1: 写 Agent view-model 失败测试**

从主 thread、recursive child info、Trace V2 summary 构造：

```typescript
interface AgentWorkbenchNode {
  threadId: string;
  parentThreadId?: string;
  depth: number;
  role: string;
  status: 'idle' | 'queued' | 'running' | 'waiting' | 'completed' | 'failed' | 'interrupted';
  currentItem?: { type: ThreadItem['type']; label: string };
  startedAt?: string;
  updatedAt: string;
  elapsedMs?: number;
  toolCalls: number;
  tokens: number;
  error?: string;
  children: AgentWorkbenchNode[];
}
```

测试 child 深度/排序、running/waiting/completed 映射、缺 Trace 时 fallback、error 优先、elapsed 用注入 now、同 child 不重复、500 items 只做一次线性遍历。

- [ ] **Step 2: 实现 activity / agents / files 三 tab**

`RightPaneTab` 改为 `'activity' | 'agents' | 'files'`。Activity 只展示当前 Run summary、当前 span、context pressure、系统 throttle、错误和合法控制；不列完整事件。Agents 展示树与 inspector。Files 保留现有搜索/预览/diff。

线程“此线程不生成记忆”移到 thread overflow 菜单，不继续占用右栏顶端。

- [ ] **Step 3: 替换装饰性 Agent Stage**

Agent tree 每行显示状态点、角色/title、当前 item、耗时、tool/token；支持展开、collapse all、状态 filter、错误 badge、键盘树导航。点击选中后 Inspector 显示 parent/child、最新动作、指标、相关 Run/Trace 跳转和错误。主控机器人只在没有 child 且 idle 的 EmptyState 中小尺寸出现，移除随机点击动画与大面积 hero 卡。

- [ ] **Step 4: 控制动作必须能力驱动**

Inspector/Activity 的 interrupt/resume/rollback 只根据 `RunControlCapabilities` 显示；rollback 要求用户选择服务端返回的旧 checkpointId。失败结果留在操作附近并可重试，不能 HTTP 200 + “unsupported”。

- [ ] **Step 5: 响应式 pane 行为**

≥1180px workbench 固定 340–440px 可拖动；760–1179px 以 overlay 打开并有 backdrop/Esc/focus return；<760px 使用全宽 sheet。toggle 的 aria-expanded/aria-controls 必须与真实可见状态一致；切换 thread 保留 tab，但清除已不存在的 selected agent。

- [ ] **Step 6: 运行并提交**

```powershell
npx vitest run apps/web/src/features/agents/agentWorkbenchModel.test.ts apps/web/src/features/agents/useAgentWorkbench.test.tsx apps/web/src/components/workbench/AgentTree.test.tsx apps/web/src/components/RightPane.test.ts apps/web/src/features/agents/subagents.test.ts apps/web/src/features/agents/subagentActivity.test.ts
npm run build
git add apps/web/src/features/agents apps/web/src/components/workbench apps/web/src/components/RightPane.tsx apps/web/src/components/AgentStagePanel.tsx apps/web/src/components/TaskRuntimeMonitorPanel.tsx apps/web/src/components/WorkspaceFilesPanel.tsx apps/web/src/main.tsx
git commit -m "feat: add agent workbench and inspector"
```

### Task 7: 重建视觉 token、CSS 边界、响应式与无障碍

**Files:**
- Create: `apps/web/src/styles/tokens.css`
- Create: `apps/web/src/styles/base.css`
- Create: `apps/web/src/styles/product-shell.css`
- Create: `apps/web/src/styles/settings.css`
- Create: `apps/web/src/styles/composer.css`
- Create: `apps/web/src/styles/workbench.css`
- Create: `apps/web/src/styles/monitor.css`
- Create: `apps/web/src/styles/responsive.css`
- Modify: `apps/web/src/styles.css`
- Modify: `apps/web/src/lightThemeSkin.test.ts`
- Modify: `apps/web/src/rightPaneSizing.test.ts`
- Modify: `apps/web/src/agentStageLayout.test.ts`
- Modify: `apps/web/src/settingsNavigation.test.ts`

- [ ] **Step 1: 先锁 token，不靠覆盖堆修**

Token 固定四层：canvas/surface/elevated/overlay；text primary/secondary/muted；border/subtle/strong；accent/success/warning/danger；spacing 4/8/12/16/24/32；radius 6/10/14；shadow 仅 modal/popover。浅色/深色都满足正文 4.5:1、UI 边界 3:1。禁止把全部组件都做成渐变玻璃卡。

- [ ] **Step 2: 将 `styles.css` 变成入口**

按顺序 `@import` 上述文件；逐组件迁移并删除旧 selector，不能在末尾继续追加 `!important` 覆盖。提交前 `styles.css` 只保留 imports 与少量全局兼容，目标 <80 行；任何单个 CSS 文件 <900 行。

- [ ] **Step 3: 统一交互状态**

所有 button/input/select/tab/tree row 覆盖 hover、focus-visible、active、disabled、loading、error。只 transition color/background/border/transform/opacity，禁止 `transition: all`。点击目标最小 36px，移动端 44px。tooltip 不承载唯一说明，表单有可见 label/help/error。

- [ ] **Step 4: 锁定滚动与断点**

`html/body/#root` 高度链完整；shell 和各 column `min-height:0/min-width:0`；只有 transcript、settings page、workbench body、monitor timeline 内部滚动。390px 下 Composer 不横向溢出；1024px overlay 不挤窄 transcript；1440px 三栏总宽稳定。

- [ ] **Step 5: reduced motion 与语义审计**

`prefers-reduced-motion: reduce` 关闭机器人、spinner 以外的无限动画与位移；dialog/tab/tree/listbox 按 WAI-ARIA keyboard pattern；async success/error 有 `aria-live`；icon-only button 全部 aria-label。删除交互 div 和 clickable span。

- [ ] **Step 6: 运行样式/结构测试并提交**

```powershell
npx vitest run apps/web/src/lightThemeSkin.test.ts apps/web/src/rightPaneSizing.test.ts apps/web/src/agentStageLayout.test.ts apps/web/src/settingsNavigation.test.ts apps/web/src/appStructure.test.ts apps/web/src/sidebar.test.ts apps/web/src/topbarActions.test.ts
npm run build
git add apps/web/src/styles.css apps/web/src/styles apps/web/src/*.test.ts
git commit -m "style: polish responsive suanlizi product shell"
```

### Task 8: M3 自动化与内置浏览器验收

**Files:**
- Modify: `tests/e2e/suanlizi-product-shell.spec.ts`
- Create: `tests/e2e/suanlizi-settings.spec.ts`
- Create: `tests/e2e/suanlizi-composer-workbench.spec.ts`
- Create: `tests/e2e/suanlizi-accessibility.spec.ts`
- Modify only concrete defects found in files touched by Tasks 2–7.

- [ ] **Step 1: 扩展 Playwright 行为矩阵**

Mock/fixture 或本地真实 API 覆盖：Settings open/close no write、dirty close 三选项、global/thread endpoint、preset cancel、plugin search/install callback、thread A/B composer draft、send fail retains draft、Enter/Shift+Enter、scroll follow、Agent tree select/filter、workbench overlay、Run control capability、system monitor unavailable。

- [ ] **Step 2: 运行完整门禁**

```powershell
npm run verify
```

Expected: 全绿且测试数不减少。

- [ ] **Step 3: 请用户手动重启 5177 服务**

助手不得启动/重启 Suanlizi。用户确认服务已使用新 build 后再运行：

```powershell
npm run test:e2e
```

- [ ] **Step 4: 使用内置浏览器逐断点验收**

在 1440、1024、760、390 宽度检查主界面、所有 Settings page、插件中心、Composer popover、Activity/Agents/Files、Monitor 三栏/overlay。每个宽度保存浅色/深色截图；验证无水平滚动、无遮挡、焦点不丢、Esc 顺序正确、pane toggle 与可见状态一致。

- [ ] **Step 5: 网络与错误细节验收**

Browser Network/console 中确认：打开 Settings 0 PATCH；SSE 不触发全量请求风暴；失败保存保留 draft；system monitor 停留页面才轮询；切 thread 中止旧请求；console 无 React key、state update after unmount、dialog focus 警告。

- [ ] **Step 6: 用户体验复核并勾选 M3**

向用户展示四宽度关键截图和剩余差异。只有用户确认主界面、设置、Agent 工作台方向不再大改，才勾选总路线 M3；否则只在路线二内迭代，不进入路线三。
