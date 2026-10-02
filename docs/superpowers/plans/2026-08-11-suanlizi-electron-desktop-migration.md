# Suanlizi Electron 桌面端重构计划

## 1. 目标

将 `apps/desktop` 从 Tauri 2 迁移到 Electron，并让用户与 Agent 操作同一个 Electron Chromium 页面、同一份 session partition 和同一套页面生命周期。

重构完成后：

- Electron Main 是唯一桌面宿主。
- React 继续作为桌面 Renderer，不获得 Node 或任意 IPC 权限。
- 真实网页由 `WebContentsView` 承载，不再由截图或第二个 WebView 模拟。
- Agent 通过 Browser Engine Adapter 控制同一个 `WebContents`。
- 现有协议、策略、预算、副作用账本、Trace 和 Browser Runtime 测试尽量保留。
- Web 端仍是任务控制面，不控制用户本机浏览器。

## 2. 非目标

- 不在迁移期间重写聊天、设置、智能体、文件和监控业务。
- 不同时维护 Tauri 与 Electron 两套正式桌面产品。
- 不把 Electron Renderer 变成 Node 应用。
- 不把远程网页直接加载进 Suanlizi 主 Renderer。
- 不为了复用 Playwright 而启动第二个隐藏 Chromium。
- 不在第一批迁移中实现远程 Browser Worker、多智能体浏览器并发或完整浏览器扩展系统。

## 3. 架构决策

### 3.1 单一 Chromium 会话

每个浏览器标签对应一个 Electron `WebContentsView`。用户看到的页面就是 Agent 操作的 CDP Target。

```text
React Renderer
    ↓ typed preload API
Electron Main
    ├── BrowserViewManager
    │     └── WebContentsView ── 真实页面
    ├── BrowserEngineAdapter ─── 同一 webContents / CDP Target
    ├── LocalRuntimeAdapter ──── Agent Runtime
    └── DesktopServices ──────── 文件、密钥、下载、窗口
```

以下实现不允许进入正式链路：

- Playwright 独立 `launch()` 一个隐藏 Chromium，再把截图传给 UI。
- Tauri WebView2 与 Playwright Chromium 并行运行。
- Renderer 使用 `<iframe>` 加载任意远程页面。
- Renderer 获得 `ipcRenderer`、`require`、文件系统或任意 CDP 命令。

### 3.2 Browser Engine Adapter 选择

默认实现优先采用 Electron `webContents.debugger`，Phase 0 同时验证两个执行路径，但最终只能保留一个：

1. Electron Main 使用 `webContents.debugger` 实现最小 CDP Adapter。
2. Playwright 通过 CDP 附着 Electron 的同一 Target。

选择标准：

- 能稳定识别同一页面、frame、popup 和 navigation epoch。
- Agent 动作与用户输入共享 Cookie、storage 和页面内存。
- 不开放固定远程调试端口。
- 应用退出、标签关闭和崩溃后无调试连接或子进程残留。
- 能覆盖元素观测、点击、输入、滚动、截图、网络摘要和下载事件。

Playwright 官方说明 `connectOverCDP` 的能力低于原生 Playwright 协议；如果 Electron 不是由 Playwright 使用预期参数启动，部分功能也可能不可用。因此 Playwright 附着只有在 Phase 0 全量通过时才可采用。否则保留现有高层协议和 orchestrator，底层使用 `webContents.debugger` CDP Adapter，不得退回双浏览器方案。

### 3.3 安全边界

- `BrowserWindow` 使用 `contextIsolation: true`、`sandbox: true`、`nodeIntegration: false`。
- preload 只通过 `contextBridge` 暴露白名单 API。
- 每个 IPC 参数和返回值都使用共享 Schema 校验。
- 远程页面只进入独立 `WebContentsView`，不挂载 Suanlizi preload。
- Electron Main 统一处理权限请求、`window.open`、导航、下载和外部协议。
- session partition 不复用用户日常 Chrome profile。
- 密钥使用 Electron `safeStorage` 或后续独立凭证服务，不进入 Renderer、Prompt 或 Trace。
- Electron 官方明确将任意远程内容视为高风险场景；远程 `WebContentsView` 不配置 preload，不获得任何 Suanlizi IPC，并必须保持 Electron/Chromium 在受支持的安全版本。

## 4. 现有代码处置

### 4.1 保留并迁移

| 现有区域 | 处理方式 |
| --- | --- |
| `apps/desktop/src/` | 保留为 Renderer，先不做大规模搬目录 |
| `apps/web/src/` | 不改宿主职责，继续作为 Web 控制面 |
| `packages/protocol/src/browser/` | 保留并扩展 Electron IPC、控制权和标签协议 |
| `packages/browser-runtime/src/orchestrator.ts` | 保留策略、预算、账本和动作入口 |
| `packages/browser-runtime/src/policy.ts` | 保留并接入 Electron session/navigation 事件 |
| `packages/browser-runtime/src/pageGraph.ts` | 保留并改为消费 `WebContentsView` 生命周期 |
| `packages/browser-runtime/src/recovery.ts` | 保留，重新定义浏览器崩溃与 Renderer 崩溃恢复 |
| `packages/browser-runtime/src/trace.ts` | 保留，移除 UI 截图传输依赖 |
| 浏览器黄金任务和协议测试 | 保留，增加同会话与人工接管测试 |

### 4.2 替换

| 现有区域 | 替换目标 |
| --- | --- |
| `apps/desktop/src-tauri/` | `apps/desktop/electron/main/` 与桌面服务 |
| `apps/desktop/src/api/browserClient.ts` | preload 暴露的 typed desktop API client |
| `PlaywrightRuntime` 的独立 `launch()` | ElectronWebContentsAdapter |
| `sidecarEntry.ts` 浏览器进程入口 | Electron Main 内的 Browser Engine 生命周期 |
| Rust JSONL BrowserRuntimeHost | Main 内的 LocalRuntimeAdapter |
| BrowserPanel 截图 `<img>` | `WebContentsView` 真实页面区域 |

### 4.3 延后删除

Tauri 代码在 Electron 达到桌面功能平价前只作为短期回退基线，禁止继续增加浏览器能力。完成 Phase 4 验收后统一删除：

- `apps/desktop/src-tauri/`
- Tauri CLI、配置和构建脚本
- Rust BrowserRuntimeHost
- TS 源码 loader 和同机 JSONL 启动链路
- 截图式 BrowserPanel 代码和对应断言

### 4.4 当前仓库迁移清单

以下是本次方案评审时确认的实际入口，实施时逐项签收：

| 当前文件/区域 | Electron 迁移动作 |
| --- | --- |
| `apps/desktop/src/api/desktopBridge.ts` | 改为调用 `window.suanliziDesktop` typed preload API |
| `apps/desktop/src/api/browserClient.ts` | 拆成 Renderer browser client 与共享 browser contract |
| `apps/desktop/src/components/TitleBar.tsx` | 改用 Electron 窗口控制 API |
| `apps/desktop/src/components/BrowserPanel.tsx` | 改成工具栏与 View 占位区，删除截图 `<img>` |
| `apps/desktop/src/components/workbench/WorkspaceWorkbench.tsx` | 绑定动态 tab、active View 和 bounds 生命周期 |
| `apps/desktop/src-tauri/src/app.rs` | 由 Electron Main、IPC 和 desktop services 替代 |
| `apps/desktop/src-tauri/installer.nsi` | 删除；其中旧机器绝对路径不得迁移 |
| `apps/desktop/package.json` | 将 `tauri dev/build` 改为 Electron 开发和打包命令 |
| `scripts/start-desktop.mjs` | 改为编排 API、Vite Renderer 和 Electron Main |
| 根 `package.json` | 保持 `desktop:dev/build` 对外命令稳定，内部切换 Electron |
| `package-lock.json` | 由管理员安装 Electron 工具链后统一更新，不手工编辑 |
| `packages/browser-runtime/src/playwrightRuntime.ts` | 保留接口和测试参考，桌面实现替换为 Electron Adapter |
| `packages/browser-runtime/src/sidecar/` | 本地桌面链路退出；仅在远程 Worker 需求确定后决定保留范围 |

依赖安装需要管理员执行；本计划阶段不运行 `npm install`，也不使用项目内临时 npm cache。

## 5. 目标目录

迁移期间采用增量目录，不立即移动全部 Renderer 文件：

```text
apps/desktop/
├── electron/
│   ├── main/
│   │   ├── index.ts
│   │   ├── createMainWindow.ts
│   │   ├── lifecycle.ts
│   │   └── security.ts
│   ├── preload/
│   │   ├── index.ts
│   │   └── desktopApi.ts
│   ├── browser/
│   │   ├── BrowserViewManager.ts
│   │   ├── BrowserEngineAdapter.ts
│   │   ├── BrowserSessionManager.ts
│   │   ├── BrowserControlLease.ts
│   │   └── downloadManager.ts
│   ├── ipc/
│   │   ├── registerDesktopIpc.ts
│   │   ├── registerBrowserIpc.ts
│   │   └── validateIpc.ts
│   └── services/
│       ├── fileService.ts
│       ├── secretService.ts
│       └── capabilityService.ts
├── src/                 # 现有 React Renderer，迁移期保持路径稳定
├── electron.vite.config.ts
└── package.json
```

等迁移完成并稳定后，再单独评估是否把 `src/` 改名为 `renderer/`。该目录整理不与宿主迁移混在同一批次。

## 6. 分阶段实施

### Phase 0：同会话可行性闸门

目标：先证明 Electron 能提供真实页面与 Agent 同会话控制，再迁移产品壳。

任务：

- 建立最小 Electron Main、preload 和测试 Renderer。
- 创建一个 `WebContentsView` 并加载本地固定测试站点。
- 验证 React 提交的 bounds 能正确布局 View，窗口缩放和侧栏变化不留空白或覆盖工具栏。
- 验证用户手动输入后执行器可以读取同一 DOM 值。
- 验证执行器点击后用户在同一 View 立即看到变化。
- 验证 Cookie、localStorage、popup、下载、文件选择器和 DevTools。
- 记录 Electron renderer、utility、GPU 和页面进程退出状态。
- 比较 Playwright CDP attach 与 `webContents.debugger`，形成一页决策记录。

验收门槛：

- 系统进程树中只有 Electron 自身 Chromium，不存在 Playwright 额外启动的浏览器。
- 用户和 Agent 对同一输入框、同一 Cookie 和同一 popup 得到一致结果。
- 关闭 View、关闭窗口和退出应用后无残留进程。
- 连续创建和销毁 50 次 View 后内存回落到可接受区间。

失败处理：

- Playwright attach 失败但 CDP Adapter 成功：采用 CDP Adapter。
- 两种路径都无法稳定控制同一 View：停止 Electron 产品迁移并重新评审，不允许用截图或第二浏览器绕过验收。

### Phase 1：Electron 桌面壳

目标：让现有桌面 UI 在 Electron 中完整运行，但暂不接 Agent 浏览器动作。

任务：

- 新增 Electron 开发、构建和打包脚本。
- 复用当前 Vite Renderer 和 5178 开发入口。
- 建立 BrowserWindow 安全配置、单实例锁、窗口状态恢复和退出流程。
- 建立 preload typed API，并替换 Renderer 对 `window.__TAURI__` 的直接依赖。
- 迁移 `open_path`、桌面能力检测和现有本地桥接。
- 保持聊天、设置、活动、智能体、文件和监控 UI 行为不变。
- 为 Main、preload 和 Renderer 分别设置 TypeScript 配置和测试环境。

验收：

- 桌面 UI 可启动、关闭和重新打开。
- Web 端构建不包含 Electron 模块。
- Renderer 中不存在 Node 全局和任意 IPC 调用。
- 现有桌面 UI 回归测试达到迁移前基线。

### Phase 2：真实浏览器工作台

目标：用 `WebContentsView` 替换截图式 BrowserPanel。

任务：

- 实现 BrowserViewManager 和 browser tab → View 映射。
- 实现浏览器动态标签的创建、激活、关闭和恢复。
- 实现地址栏、前进、后退、刷新、停止、焦点和 DevTools 命令。
- 使用 Renderer `ResizeObserver` 上报内容矩形，由 Main 设置 View bounds。
- 标签隐藏、切换到活动/智能体/文件时同步隐藏 View。
- 处理加载状态、title、favicon、navigation、crash 和 popup 事件。
- 建立独立 session partition 与权限处理。
- 删除截图数据 URL 传输和 BrowserPanel `<img>`。

验收：

- 页面铺满浏览区域且不覆盖顶栏、标签栏和输入区。
- 页面可直接点击、输入、选择、滚动、上传和下载。
- 多标签切换时地址、标题、焦点和页面状态正确。
- 关闭标签立即回收对应 View；不存在不可见页面持续抢焦点。

### Phase 3：Agent Runtime 接线

目标：让现有 orchestrator 通过 Browser Engine Adapter 操作真实 View。

任务：

- 定义 `ElectronWebContentsRuntime implements BrowserRuntimePort`。
- 将 Observation、元素引用和 navigation epoch 映射到同一 `webContents.id`。
- 接入导航、点击、输入、选择、按键、滚动、等待、截图和下载原子动作。
- 动作统一经过策略、预算、账本和后置验证。
- 删除 Electron 本地链路中的 Node Sidecar 进程和 JSONL 转发。
- 保留 Sidecar 抽象仅用于未来 RemoteBrowserRuntime，不参与本地桌面调用。
- 将 Runtime 错误写入 thread item、任务事件和 Trace，前端失败后重新同步任务状态。

验收：

- 黄金任务通过同一 `WebContentsView` 执行。
- Agent 动作在用户可见页面实时发生。
- 单次动作超时不会关闭整个浏览器会话。
- 取消只终止当前任务和后续动作，不误杀 Electron 主进程。

### Phase 4：人工接管与桌面能力平价

目标：完成 Agent/用户协作并替代 Tauri 正式入口。

任务：

- 实现 `agent → transition → human → transition → agent` 控制权状态机。
- 用户接管前中止可取消动作；不可逆动作先进入明确状态再交接。
- 用户归还后等待页面稳定、递增 interaction epoch 并重新观测。
- 接管期间记录导航、popup 和下载，不记录输入明文。
- 完成审批、CAPTCHA、登录和文件选择流程。
- 迁移安全存储、文件权限、外部协议和微信桥接能力。
- 将根脚本 `desktop:dev`、`desktop:build` 切换到 Electron。
- 达到功能平价后删除 Tauri、Rust BrowserRuntimeHost 和截图 UI。

验收：

- 用户接管时 Agent 不再注入页面输入。
- 用户归还后 Agent 不使用旧元素引用继续操作。
- Tauri 不再是开发、构建或发布依赖。
- 桌面端所有正式路径只启动 Electron。

### Phase 5：发布与运行可靠性

目标：达到可分发的桌面产品标准。

任务：

- 配置打包、代码签名、自动更新和版本通道。
- 配置崩溃报告、日志轮转和隐私清理。
- 建立 session/profile 清理、磁盘配额和下载保留策略。
- 建立 Renderer 崩溃、View 崩溃、GPU 崩溃和主进程异常恢复。
- 建立资源监控：View 数量、renderer 数量、内存、句柄、磁盘和启动时间。
- 在干净 Windows 环境运行安装、升级、卸载和残留检查。

验收：

- 安装包不依赖开发机 Node、源码 loader 或全局工具。
- 长时间运行、反复开关标签和任务取消不产生持续资源增长。
- 崩溃恢复后任务明确恢复、挂起或失败，不静默丢失状态。

## 7. IPC 契约

Renderer 只看到领域 API，不看到 Electron 原始对象：

```typescript
interface SuanliziDesktopApi {
  browser: {
    createTab(input: CreateBrowserTabInput): Promise<BrowserTabState>;
    closeTab(tabId: string): Promise<void>;
    activateTab(tabId: string): Promise<void>;
    setBounds(input: BrowserViewBounds): Promise<void>;
    navigate(input: BrowserNavigateInput): Promise<void>;
    back(tabId: string): Promise<void>;
    forward(tabId: string): Promise<void>;
    reload(tabId: string): Promise<void>;
    requestTakeover(sessionId: string): Promise<BrowserControlState>;
    releaseControl(sessionId: string): Promise<BrowserControlState>;
    subscribe(handler: (event: BrowserDesktopEvent) => void): () => void;
  };
  files: DesktopFileApi;
  secrets: DesktopSecretApi;
  system: DesktopSystemApi;
}
```

禁止暴露：

- `ipcRenderer.send/invoke/on`
- 任意 channel 字符串
- `webContents.debugger`
- 任意文件路径读写
- 任意 shell 命令
- BrowserWindow 或 WebContents 实例

## 8. 测试矩阵

| 层 | 必测内容 |
| --- | --- |
| 协议 | Schema、版本、错误、取消、重复事件、稳定 key |
| Main 单元测试 | View 生命周期、标签映射、控制权、权限、下载路径 |
| Preload 测试 | 白名单、参数校验、订阅释放、无原始 IPC 泄漏 |
| Renderer 测试 | 动态标签、bounds、工具栏、错误、接管状态 |
| Electron 集成 | 真 View 导航、同会话 DOM/Cookie、popup、下载、关闭 |
| Runtime 集成 | 策略、预算、账本、验证、取消、失败回写 |
| 资源测试 | 50 次 View 创建销毁、长任务、崩溃、退出残留 |
| 安全测试 | preload 隔离、远程页面权限、协议跳转、下载穿越、SSRF |

## 9. 主要风险与控制

| 风险 | 控制措施 |
| --- | --- |
| Playwright 无法稳定附着同一 Electron Target | Phase 0 闸门；使用 `webContents.debugger` CDP Adapter |
| WebContentsView 覆盖 Renderer UI | 单一 bounds 管理器；标签隐藏时强制 hide；端到端布局测试 |
| Agent 与用户输入竞争 | 显式控制权状态机；非 Agent owner 时拒绝动作 |
| Electron 权限面扩大 | sandbox、contextIsolation、preload 白名单、Schema 校验 |
| 多标签导致内存增长 | View 配额、休眠/回收、资源指标和压力测试 |
| Tauri 与 Electron 双线拖延 | Tauri 冻结；Phase 4 后删除，不建立双产品维护承诺 |
| 迁移破坏 Web 端 | Electron 代码只存在 `apps/desktop`；共享包不得导入 Electron |
| 超时误杀浏览器 | 动作取消与 session 生命周期分离；仅显式关闭回收 View |

## 10. 完成定义

Electron 重构只有同时满足以下条件才算完成：

- 用户与 Agent 操作同一个可见页面和同一 session partition。
- BrowserPanel 不再渲染页面截图。
- 本地桌面链路不再启动第二个 Chromium。
- Agent 与用户控制权互斥且可恢复。
- Tauri/Rust Host 不再参与开发、构建和发布。
- Renderer 无 Node 权限，远程页面无 Suanlizi preload。
- 动作失败能进入任务 item、事件和 Trace，UI 不出现无反馈空白。
- 标签、下载、popup、文件选择、认证和退出流程通过集成测试。
- 反复创建/销毁 View 和长时间运行无持续资源泄漏。
- Web 端功能和构建不受 Electron 依赖污染。

## 11. 官方能力依据

- Electron `WebContentsView`：https://www.electronjs.org/docs/latest/api/web-contents-view
- Electron `webContents` 与 Debugger Target：https://www.electronjs.org/docs/latest/api/web-contents
- Electron 安全清单：https://www.electronjs.org/docs/latest/tutorial/security
- Electron Context Isolation：https://www.electronjs.org/docs/latest/tutorial/context-isolation
- Electron Process Sandboxing：https://www.electronjs.org/docs/latest/tutorial/sandbox
- Playwright `connectOverCDP` 限制：https://playwright.dev/docs/api/class-browsertype#browser-type-connect-over-cdp
