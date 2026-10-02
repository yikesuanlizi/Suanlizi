# Suanlizi P0 Correctness Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在任何视觉重做之前，恢复工程门禁，并修复配置作用域、线程切换、消息滚动、历史 Run 数据归属和运行控制的正确性。

**Architecture:** 配置状态改为显式 reducer，不再通过一个 `useEffect` 同时写全局和线程；线程加载与 Monitor 刷新均使用 generation guard 拒绝过期结果。旧 Monitor 在 Trace V2 上线前只展示选中 Run 自己的持久化事件，当前线程 task state 留在右栏 Live HUD，杜绝历史数据串用。

**Tech Stack:** TypeScript、React reducer/hooks、Node fetch/SSE、Vitest、ESLint Flat Config、SQLite ThreadStore。

---

## 文件边界

**新增：**

- `eslint.config.mjs`：ESLint 9 Flat Config。
- `scripts/check-source-artifacts.mjs`：阻止构建产物回流到任意 workspace 的 `src`。
- `tests/scripts/check-source-artifacts.test.ts`：生成物门禁的跨平台单测。
- `packages/protocol/src/runConfig.ts`：线程覆盖、模型预设的跨端公开类型和严格选择器。
- `packages/protocol/src/runConfig.test.ts`：作用域与预设字段白名单测试。
- `apps/web/src/features/settings/configState.ts`：global/thread/new-thread/appearance 纯 reducer。
- `apps/web/src/features/settings/configState.test.ts`：作用域状态转换测试。
- `apps/web/src/features/settings/settingsClient.ts`：显式 settings API 写入。
- `apps/web/src/features/settings/settingsClient.test.ts`：请求路径与 payload 测试。
- `apps/web/src/features/chat/latestRequestGuard.ts`：线程请求 generation/AbortController 管理。
- `apps/web/src/features/chat/latestRequestGuard.test.ts`：快速切换竞态测试。
- `apps/web/src/features/chat/transcriptFollow.ts`：是否跟随底部的纯状态机。
- `apps/web/src/features/chat/transcriptFollow.test.ts`：滚动行为测试。
- `apps/web/src/features/monitor/runMonitorState.ts`：Run 选择、请求版本和事件归属 reducer。
- `apps/web/src/features/monitor/runMonitorState.test.ts`：历史选择与过期响应测试。

**修改：**

- `.gitignore`、`package.json`、`package-lock.json`：生成物和 lint 门禁。
- `packages/protocol/src/index.ts`：导出模型预设公开类型。
- `apps/api/src/config/config.ts`、`apps/api/src/config/config.test.ts`：模型预设仅接收模型字段。
- `packages/storage/src/store.ts`、`packages/storage/src/store.test.ts`：按租户获取单个 Run。
- `apps/api/src/routes/runMonitorRoute.ts`、`apps/api/src/routes/runMonitorRoute.test.ts`：Run 所有权、能力和控制结果。
- `apps/api/src/routes/threadRuntimeActions.ts`：不支持动作抛出明确错误。
- `apps/web/src/main.tsx`：显式配置状态、线程加载 guard、SSE 刷新策略、滚动状态。
- `apps/web/src/components/SettingsDrawer.tsx`：删除打开即改值和 blur 静默保存，按钮调用显式 action。
- `apps/web/src/components/ComposerBar.tsx`：Composer 只修改 active-thread scope。
- `apps/web/src/features/monitor/runMonitor.ts`：以 reducer 驱动且拒绝过期响应。
- `apps/web/src/components/RunMonitorDrawer.tsx`：不再接收当前线程 items/task state。

P0 只修改 Web 交互实现。共享的 protocol/storage/API/runtime 修改必须保证 Desktop 继续通过类型检查和构建，但 Desktop 的界面同步留到路线三，避免违反 `AGENTS.md` 的阶段顺序。

### Task 0: 对照 Codex 的线程与 item 生命周期

**Files:**
- Read: `E:/langchain/codex/codex-rs/app-server-protocol/src/protocol/v2/item.rs`
- Read: `E:/langchain/codex/codex-rs/app-server/src/thread_status.rs`
- Read: `E:/langchain/codex/codex-rs/app-server/src/bespoke_event_handling.rs`
- Read: `E:/langchain/codex/codex-rs/rollout-trace/README.md`
- Modify: this plan's execution notes only

- [ ] **Step 1: 记录采用的边界**

执行者在工作日志中写明：Suanlizi 保留 started/completed item 对、稳定 item id、thread status 与 active turn 分离、resume 后重新建立事件订阅；Monitor 投影不能取代 transcript item 真相源。

- [ ] **Step 2: 记录不采用的结构**

明确不复制 Codex 的 CLI/TUI 布局、JSON-RPC transport 或 Rust rollout bundle 文件结构；Suanlizi 继续使用 React + HTTP/SSE + SQLite/PostgreSQL，只采用生命周期与投影原则。

- [ ] **Step 3: 检查 P0 任务没有引入第二套 item 状态机**

Run:

```powershell
rg -n "item\.started|item\.updated|item\.completed|item\.discarded" packages/protocol/src packages/runtime/src apps/api/src apps/web/src
```

Expected: canonical `ThreadEvent` 是唯一跨层 item lifecycle；UI 临时 item 使用独立 local entry 类型，不伪装或复制一套 `ThreadEvent`。

**执行记录（2026-07-20）：**

采用：保留 canonical item 的 started/completed 配对与稳定 item id；thread status 与 active turn 分离；resume 后重新建立事件订阅；transcript item 是真相源，Monitor 只做投影。

不采用：不复制 Codex CLI/TUI 布局、JSON-RPC transport 或 Rust rollout bundle 文件结构；Suanlizi 继续使用 React + HTTP/SSE + SQLite/PostgreSQL，只采用生命周期与投影原则。

- **Local transient item：** 必须有显式 source、correlation id 和 reconciliation，禁止仅靠字符串前缀与 canonical item 协调；测试 snapshot、成功、失败、线程切换时的替换与清理。对应 P0 Task 4。
- **Monitor item identity：** 必须使用稳定 `item.id`；测试同一 turn 两次同名 tool、两个 `file_change`、两个 `error` 均不折叠。对应 P0 Task 6、Trace 计划 Task 7。
- **Resume/SSE：** 必须先订阅缓冲再取 snapshot，或使用 cursor replay，并按序去重；测试 snapshot/live 边界无 gap、无 duplicate。对应 P0 Task 4、Trace 计划 Task 6。
- **Item lifecycle closure：** 所有 `item.started` 必须在成功、middleware/tool 抛错、取消路径中，以同一 `item.id` 的 `item.completed` 或 `item.discarded` 闭合。仅对应 Trace 计划 Task 4。

### Task 1: 恢复生成物与 lint 门禁

**Files:**
- Modify: `.gitignore`
- Create: `eslint.config.mjs`
- Create: `scripts/check-source-artifacts.mjs`
- Create: `tests/scripts/check-source-artifacts.test.ts`
- Modify: `package.json`
- Modify: `package-lock.json`

- [ ] **Step 1: 证明当前生成物规则失效**

Run:

```powershell
git check-ignore --no-index packages/memory/src/memory.js
```

Expected: 退出码 1，说明当前 `src/**/*.js` 没有匹配 workspace 包内文件。

- [ ] **Step 2: 修正 `.gitignore` 的 workspace 深度**

将文件末尾四条生成物规则替换为：

```gitignore
# TypeScript emit must never live beside package/app sources.
**/src/**/*.js
**/src/**/*.js.map
**/src/**/*.d.ts
**/src/**/*.d.ts.map
```

不要添加 `!**/src/**/*.ts`：`memory.d.ts` 同样匹配 `*.ts`，该否定规则会把声明产物重新放回工作区。

- [ ] **Step 3: 验证生成物已被忽略**

Run:

```powershell
git check-ignore -v --no-index packages/memory/src/memory.js
git check-ignore -v --no-index packages/model-gateway/src/gateway.d.ts.map
```

Expected: 两个路径都显示由 `.gitignore` 中 `**/src/**` 规则命中。

- [ ] **Step 3a: 精确移除源码目录旁的现有生成物**

先解析并检查目标只能位于两个已知包的 `src` 目录：

```powershell
$sourceRoots = @(
  (Resolve-Path 'packages/memory/src').Path,
  (Resolve-Path 'packages/model-gateway/src').Path
)
$generated = Get-ChildItem -LiteralPath $sourceRoots -File | Where-Object {
  $_.Name -match '\.(js|js\.map|d\.ts|d\.ts\.map)$'
}
$generated | Select-Object FullName
```

Expected: 只列出已核对的 44 个 TypeScript emit 文件，不出现手写源码。确认后在同一个 PowerShell 会话执行：

```powershell
$generated | Remove-Item -Force
```

删除后运行 `Get-ChildItem -LiteralPath $sourceRoots -File`，确认 `.ts` 测试和源码仍存在。该操作只清理可重新构建的未跟踪产物。

- [ ] **Step 4: 请管理员安装 TypeScript Flat Config 解析器**

由管理员运行（助手不得执行）：

```powershell
npm install --save-dev typescript-eslint
```

助手禁止执行 `npm install`。执行到此处时暂停并请管理员运行该命令；管理员完成后检查 `package.json` 与 `package-lock.json` 已更新，再继续 Step 5。

- [ ] **Step 5: 创建可执行的 ESLint 9 配置**

```javascript
// eslint.config.mjs
import tseslint from 'typescript-eslint';

export default [
  {
    ignores: [
      '**/dist/**',
      '**/dist-types/**',
      '**/node_modules/**',
      '**/src-tauri/gen/**',
      '**/.suanlizi/**',
      '**/outputs/**',
    ],
  },
  {
    files: ['packages/**/*.ts', 'apps/**/*.ts', 'apps/**/*.tsx'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
        ecmaFeatures: { jsx: true },
      },
    },
    plugins: { '@typescript-eslint': tseslint.plugin },
    rules: {
      'no-debugger': 'error',
      'no-constant-condition': ['error', { checkLoops: false }],
      '@typescript-eslint/no-unused-vars': ['warn', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
      }],
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
];
```

- [ ] **Step 6: 修正 lint script 的 TSX 范围并运行门禁**

将 root script 改为：

```json
"lint": "eslint packages/ apps/"
```

Run:

```powershell
npm run lint
npm test
npm run build
```

Expected: 三条命令退出码均为 0。允许已有 unused 警告，但不允许 ESLint 配置错误或 error。

- [ ] **Step 7: 增加源码目录生成物门禁**

`scripts/check-source-artifacts.mjs` 只递归扫描 `packages/*/src` 与 `apps/*/src`，发现 `*.js`、`*.js.map`、`*.d.ts`、`*.d.ts.map` 即输出相对路径并退出 1；没有产物时退出 0。导出 `findSourceArtifacts(workspaceRoot)`，CLI 入口只负责格式化错误，便于单测直接调用。

`tests/scripts/check-source-artifacts.test.ts` 在 `os.tmpdir()` 下创建最小 workspace，覆盖：嵌套源码产物会被发现、普通 `.ts/.tsx` 不会被误报、`dist` 目录不在扫描范围。测试的临时目录放在系统临时区，不得写入项目目录。放在 `tests/**` 是为了匹配当前 Vitest include；不要把测试留在不会被收集的 `scripts/**`。

在 root `package.json` 中加入：

```json
"check:source-artifacts": "node scripts/check-source-artifacts.mjs",
"verify": "npm run check:source-artifacts && npm run lint && npm test && npm run build"
```

Run:

```powershell
npx vitest run tests/scripts/check-source-artifacts.test.ts
npm run check:source-artifacts
npm run verify
```

Expected: 单测和两个门禁均退出 0；`npm run build` 后再次运行 `npm run check:source-artifacts` 仍退出 0。

- [ ] **Step 8: 提交工程门禁**

```powershell
git add .gitignore eslint.config.mjs scripts/check-source-artifacts.mjs tests/scripts/check-source-artifacts.test.ts package.json package-lock.json
git commit -m "chore: restore lint and generated artifact guards"
```

### Task 2: 锁定模型预设字段

**Files:**
- Create: `packages/protocol/src/runConfig.ts`
- Create: `packages/protocol/src/runConfig.test.ts`
- Modify: `packages/protocol/src/index.ts`
- Modify: `apps/api/src/config/config.ts`
- Modify: `apps/api/src/config/config.test.ts`
- Modify: `apps/web/src/config/config.ts`
- Modify: `apps/web/src/shared/types.ts`
- Modify: `apps/web/src/main.tsx`
- Modify: `apps/web/src/components/SettingsDrawer.tsx`

- [ ] **Step 1: 写失败的 protocol 白名单测试**

```typescript
// packages/protocol/src/runConfig.test.ts
import { describe, expect, it } from 'vitest';
import { modelPresetConfigFrom, threadRunConfigOverridesFrom } from './runConfig.js';

describe('modelPresetConfigFrom', () => {
  it('keeps only provider, model, and baseUrl', () => {
    expect(modelPresetConfigFrom({
      provider: 'openai',
      model: 'gpt-5',
      baseUrl: 'https://example.test/v1',
      permissions: 'danger_full_access',
      workspaceRoot: 'E:/secret',
      memoryEnabled: false,
    })).toEqual({
      provider: 'openai',
      model: 'gpt-5',
      baseUrl: 'https://example.test/v1',
    });
  });

  it('projects only fields that may override a thread', () => {
    expect(threadRunConfigOverridesFrom({
      workspaceRoot: 'E:/repo',
      provider: 'openai',
      model: 'gpt-5',
      baseUrl: '',
      permissions: 'workspace',
      webSearchMode: 'auto',
      reasoningEffort: 'high',
      runProfile: 'runtime_os',
      memoryEnabled: false,
      dataDir: 'E:/private',
    })).toEqual({
      workspaceRoot: 'E:/repo',
      provider: 'openai',
      model: 'gpt-5',
      baseUrl: '',
      permissions: 'workspace',
      webSearchMode: 'auto',
      reasoningEffort: 'high',
      runProfile: 'runtime_os',
    });
  });

  it('rejects a preset without provider or model', () => {
    expect(() => modelPresetConfigFrom({ provider: '', model: '' }))
      .toThrow('provider and model are required');
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run:

```powershell
npx vitest run packages/protocol/src/runConfig.test.ts
```

Expected: FAIL，模块 `runConfig.js` 尚不存在。

- [ ] **Step 3: 实现公开模型预设类型**

```typescript
// packages/protocol/src/runConfig.ts
export type PermissionPresetId = 'read_only' | 'workspace' | 'danger_full_access';
export type WebSearchMode = 'auto' | 'on' | 'off';
export type ReasoningEffort = 'low' | 'medium' | 'high';
export type RunProfile = 'cache_first' | 'runtime_os';

export interface ThreadRunConfigOverrides {
  workspaceRoot?: string;
  provider?: string;
  model?: string;
  baseUrl?: string;
  permissions?: PermissionPresetId;
  webSearchMode?: WebSearchMode;
  reasoningEffort?: ReasoningEffort;
  runProfile?: RunProfile;
}

export const THREAD_RUN_CONFIG_KEYS = [
  'workspaceRoot',
  'provider',
  'model',
  'baseUrl',
  'permissions',
  'webSearchMode',
  'reasoningEffort',
  'runProfile',
] as const;

export type ThreadRunConfigKey = typeof THREAD_RUN_CONFIG_KEYS[number];

export function threadRunConfigOverridesFrom(input: Record<string, unknown>): ThreadRunConfigOverrides {
  const result: ThreadRunConfigOverrides = {};
  for (const key of THREAD_RUN_CONFIG_KEYS) {
    const value = input[key];
    if (typeof value === 'string') (result as Record<string, string>)[key] = value;
  }
  return result;
}

export interface ModelPresetConfig {
  provider: string;
  model: string;
  baseUrl: string;
}

export function modelPresetConfigFrom(input: Record<string, unknown>): ModelPresetConfig {
  const provider = typeof input.provider === 'string' ? input.provider.trim() : '';
  const model = typeof input.model === 'string' ? input.model.trim() : '';
  const baseUrl = typeof input.baseUrl === 'string' ? input.baseUrl.trim() : '';
  if (!provider || !model) throw new Error('provider and model are required');
  return { provider, model, baseUrl };
}
```

在 `packages/protocol/src/index.ts` 导出：

```typescript
export * from './runConfig.js';
```

`apps/web/src/config/config.ts` 删除本地重复的 `PermissionPresetId/WebSearchMode/ReasoningEffort/RunProfile` 定义，改为从 `@suanlizi/protocol` import 并 re-export（若现有调用仍从该模块导入）；API 对应字段也引用同一 protocol union，避免三端字符串集合漂移。

- [ ] **Step 4: 让 API 在合并默认值前执行白名单**

将 `apps/api/src/config/config.ts` 中的 `ModelPreset.config` 改为 `ModelPresetConfig`，并将 repository 内的选择逻辑替换为：

```typescript
import { modelPresetConfigFrom, type ModelPresetConfig } from '@suanlizi/protocol';

async function upsertModelPreset(input: {
  id?: string;
  name?: string;
  config?: Record<string, unknown>;
}): Promise<{ preset: ModelPreset; presets: ModelPreset[] }> {
  const safeConfig = modelPresetConfigFrom(input.config ?? {});
  const presets = await listModelPresets();
  const id = input.id?.trim() || randomUUID();
  const existing = presets.find((preset) => preset.id === id);
  const now = new Date().toISOString();
  const preset: ModelPreset = {
    id,
    name: input.name?.trim() || existing?.name || modelPresetName(safeConfig),
    config: safeConfig,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  const next = existing
    ? presets.map((item) => item.id === id ? preset : item)
    : [preset, ...presets];
  await store.setSetting(MODEL_PRESETS_KEY, next);
  return { preset, presets: next };
}
```

- [ ] **Step 5: 补 API 回归测试**

在 `apps/api/src/config/config.test.ts` 增加用例：提交包含 `permissions/workspaceRoot/memoryEnabled` 的 payload 后，持久化 preset 的 `config` 必须严格等于三字段；缺 provider/model 时必须 reject。

Run:

```powershell
npx vitest run packages/protocol/src/runConfig.test.ts apps/api/src/config/config.test.ts
```

Expected: PASS。

- [ ] **Step 6: 修正 Web 保存、应用和取消顺序**

`ModelPreset.config` 改为 `ModelPresetConfig`。`main.tsx` 的保存函数接收已确认名称，不在函数内部读取整份 `RunConfig`：

```typescript
async function saveModelPreset(name: string, presetConfig: ModelPresetConfig): Promise<void> {
  const response = await fetch('/api/model-presets', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, config: presetConfig }),
  });
  if (!response.ok) throw new Error('Model preset save failed');
  const data = await response.json() as { presets?: ModelPreset[] };
  setModelPresets(data.presets ?? []);
}

function applyModelPreset(preset: ModelPreset): void {
  setConfig({ ...config, ...preset.config });
}
```

Task 2 发生在 config reducer 创建之前，因此这里只沿用当前 React setter，保证该提交可独立编译；它只解决 preset 字段污染。Task 3 必须立即把这个 setter 换成持久化成功后才 dispatch 的 active-thread update，不得提前引用尚不存在的 `dispatchConfig`。

`SettingsDrawer` 保存预设流程固定为：先请求名称；名称返回 `null` 时立即 return；之后才创建自定义 provider、写 key/env binding 并 POST preset。测试必须断言取消时上述请求均为 0 次。

- [ ] **Step 7: 提交预设正确性修复**

```powershell
npx vitest run packages/protocol/src/runConfig.test.ts apps/api/src/config/config.test.ts
npm run build
git add packages/protocol/src/runConfig.ts packages/protocol/src/runConfig.test.ts packages/protocol/src/index.ts apps/api/src/config/config.ts apps/api/src/config/config.test.ts apps/web/src/config/config.ts apps/web/src/shared/types.ts apps/web/src/main.tsx apps/web/src/components/SettingsDrawer.tsx
git commit -m "fix: restrict model presets to model fields"
```

### Task 3: 将配置拆成显式作用域

**Files:**
- Create: `apps/web/src/features/settings/configState.ts`
- Create: `apps/web/src/features/settings/configState.test.ts`
- Create: `apps/web/src/features/settings/settingsClient.ts`
- Create: `apps/web/src/features/settings/settingsClient.test.ts`
- Create: `apps/web/src/features/settings/threadRunConfigActions.ts`
- Create: `apps/web/src/features/settings/threadRunConfigActions.test.ts`
- Create: `apps/api/src/config/threadRunConfig.test.ts`
- Create: `apps/api/src/routes/threadConfigScope.test.ts`
- Create: `apps/api/src/routes/threadRunRequestScope.test.ts`
- Modify: `apps/api/src/config/config.ts`
- Modify: `apps/api/src/config/config.test.ts`
- Modify: `apps/api/src/routes/threadRoutes.ts`
- Modify: `apps/api/src/routes/threadRuntimeActions.ts`
- Modify: `apps/api/src/server.ts`
- Modify: `apps/web/src/main.tsx`
- Modify: `apps/web/src/components/SettingsDrawer.tsx`
- Modify: `apps/web/src/components/ComposerBar.tsx`

- [ ] **Step 1: 写配置 reducer 的失败测试**

```typescript
// apps/web/src/features/settings/configState.test.ts
import { describe, expect, it } from 'vitest';
import { configStateReducer, initialConfigState } from './configState.js';

describe('configStateReducer', () => {
  it('keeps thread edits out of global defaults', () => {
    const loaded = configStateReducer(initialConfigState, {
      type: 'globals.loaded',
      config: { provider: 'openai', model: 'gpt-5' },
    });
    const selected = configStateReducer(loaded, {
      type: 'thread.selected',
      threadId: 'thread-1',
      config: { provider: 'anthropic', model: 'claude' },
    });
    const edited = configStateReducer(selected, {
      type: 'thread.patched',
      patch: { model: 'claude-next' },
    });
    expect(edited.globalDefaults.model).toBe('gpt-5');
    expect(edited.activeThreadOverrides.model).toBe('claude-next');
  });

  it('keeps appearance outside server runtime payloads', () => {
    const state = configStateReducer(initialConfigState, {
      type: 'appearance.patched',
      patch: { themeMode: 'dark', userAvatarId: 'owl' },
    });
    expect(state.appearance).toEqual(expect.objectContaining({ themeMode: 'dark', userAvatarId: 'owl' }));
    expect(state.globalDefaults).not.toHaveProperty('themeMode');
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run:

```powershell
npx vitest run apps/web/src/features/settings/configState.test.ts
```

Expected: FAIL，`configState.js` 尚不存在。

- [ ] **Step 3: 实现四域 reducer 和 picker**

```typescript
// apps/web/src/features/settings/configState.ts
import type { ThreadRunConfigKey, ThreadRunConfigOverrides } from '@suanlizi/protocol';
import type { RunConfig } from '../../config/config.js';

export type AppearanceConfig = Pick<RunConfig,
  'themeMode' | 'userAvatarId' | 'customUserAvatarDataUrl'>;
export type GlobalRuntimeConfig = Omit<RunConfig, keyof AppearanceConfig>;

export interface ConfigState {
  globalDefaults: Partial<GlobalRuntimeConfig>;
  activeThreadId: string;
  activeThreadOverrides: ThreadRunConfigOverrides;
  newThreadOverrides: ThreadRunConfigOverrides;
  appearance: Partial<AppearanceConfig>;
  hydrated: boolean;
}

export const initialConfigState: ConfigState = {
  globalDefaults: {},
  activeThreadId: '',
  activeThreadOverrides: {},
  newThreadOverrides: {},
  appearance: {},
  hydrated: false,
};

export type ConfigStateAction =
  | { type: 'globals.loaded'; config: Partial<GlobalRuntimeConfig> }
  | { type: 'globals.patched'; patch: Partial<GlobalRuntimeConfig> }
  | { type: 'thread.selected'; threadId: string; config: ThreadRunConfigOverrides }
  | { type: 'thread.patched'; patch: ThreadRunConfigOverrides }
  | { type: 'thread.unset'; keys: ThreadRunConfigKey[] }
  | { type: 'new-thread.patched'; patch: ThreadRunConfigOverrides }
  | { type: 'new-thread.unset'; keys: ThreadRunConfigKey[] }
  | { type: 'appearance.patched'; patch: Partial<AppearanceConfig> }
  | { type: 'hydrated' };

function omitRunConfigKeys(
  current: ThreadRunConfigOverrides,
  keys: ThreadRunConfigKey[],
): ThreadRunConfigOverrides {
  const next = { ...current };
  for (const key of keys) delete next[key];
  return next;
}

export function configStateReducer(state: ConfigState, action: ConfigStateAction): ConfigState {
  switch (action.type) {
    case 'globals.loaded':
      return { ...state, globalDefaults: { ...action.config } };
    case 'globals.patched':
      return { ...state, globalDefaults: { ...state.globalDefaults, ...action.patch } };
    case 'thread.selected':
      return { ...state, activeThreadId: action.threadId, activeThreadOverrides: { ...action.config } };
    case 'thread.patched':
      return { ...state, activeThreadOverrides: { ...state.activeThreadOverrides, ...action.patch } };
    case 'thread.unset':
      return { ...state, activeThreadOverrides: omitRunConfigKeys(state.activeThreadOverrides, action.keys) };
    case 'new-thread.patched':
      return { ...state, newThreadOverrides: { ...state.newThreadOverrides, ...action.patch } };
    case 'new-thread.unset':
      return { ...state, newThreadOverrides: omitRunConfigKeys(state.newThreadOverrides, action.keys) };
    case 'appearance.patched':
      return { ...state, appearance: { ...state.appearance, ...action.patch } };
    case 'hydrated':
      return { ...state, hydrated: true };
  }
}

export function effectiveRunConfig(defaults: RunConfig, state: ConfigState): RunConfig {
  return {
    ...defaults,
    ...state.globalDefaults,
    ...state.activeThreadOverrides,
    ...state.appearance,
  };
}

export function globalRuntimePayload(config: Partial<RunConfig>): Partial<GlobalRuntimeConfig> {
  const { themeMode, userAvatarId, customUserAvatarDataUrl, ...runtime } = config;
  void themeMode; void userAvatarId; void customUserAvatarDataUrl;
  return runtime;
}
```

- [ ] **Step 3a: 先写 API override/unset 失败测试**

固定覆盖：默认模型为 `default-model`、线程只保存 `{model:'thread-model'}`；GET 返回 resolved config + overrides；PATCH `{unset:['model']}` 后线程重新继承默认模型；theme、memory、dataDir 出现在 `set` 时返回 400。

Run:

```powershell
npx vitest run apps/api/src/config/threadRunConfig.test.ts apps/api/src/routes/threadConfigScope.test.ts
```

Expected: FAIL，repository 与 route 尚无 override/unset contract。

- [ ] **Step 3b: 实现线程 override repository 与 API**

```typescript
// packages/protocol/src/runConfig.ts
import { z } from 'zod';

export interface ThreadConfigUpdate {
  set?: ThreadRunConfigOverrides;
  unset?: ThreadRunConfigKey[];
}

const threadRunConfigOverridesSchema = z.object({
  workspaceRoot: z.string().trim().min(1).optional(),
  provider: z.string().trim().min(1).optional(),
  model: z.string().trim().min(1).optional(),
  baseUrl: z.string().optional(),
  permissions: z.enum(['read_only', 'workspace', 'danger_full_access']).optional(),
  webSearchMode: z.enum(['auto', 'on', 'off']).optional(),
  reasoningEffort: z.enum(['low', 'medium', 'high']).optional(),
  runProfile: z.enum(['cache_first', 'runtime_os']).optional(),
}).strict();

export const threadConfigUpdateSchema = z.object({
  set: threadRunConfigOverridesSchema.optional(),
  unset: z.array(z.enum(THREAD_RUN_CONFIG_KEYS)).max(THREAD_RUN_CONFIG_KEYS.length).optional(),
}).strict().superRefine((value, context) => {
  if (!value.set && !value.unset?.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'set or unset is required' });
  }
  for (const key of value.unset ?? []) {
    if (value.set && key in value.set) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: `cannot set and unset ${key}` });
    }
  }
});
```

`createConfigRepository` 提供：

```typescript
getThreadRunConfigOverrides(threadId: ThreadId): Promise<ThreadRunConfigOverrides>;
updateThreadRunConfig(threadId: ThreadId, update: ThreadConfigUpdate): Promise<AgentRunConfig>;
replaceThreadRunConfig(threadId: ThreadId, overrides: ThreadRunConfigOverrides): Promise<AgentRunConfig>;
```

存储 tag 读取旧数据时才使用 allowlist picker；HTTP 请求必须先通过上述严格 schema，未知 key、非法 enum、空 provider/model、同一 key 同时 set/unset 均返回 400，不能静默丢弃。存储 tag 只写已验证 override，不再写 resolved 全量快照。HTTP contract 固定为：

```text
GET   /api/threads/:id/config -> { config, overrides }
PATCH /api/threads/:id/config <- { set?, unset? }
POST  /api/threads            <- { ..., configOverrides? }
```

同时从服务端 `AgentRunConfig/defaultConfig/resolveConfig/publicRunConfig` 移除仅 UI 使用的 `themeMode`；头像字段原本就不属于服务端 runtime。主题与头像完全由 Web `appearance` slice + localStorage 管理。`locale` 保留在 global runtime defaults，因为 Agent prompt、guardian、Bot 回复都真实使用它，但它不允许 thread override。读取旧 settings 时只通过新的 allowlist 投影，不增加兼容分支。`PATCH /api/settings` 对 theme/avatar 字段返回 400，防止它们重新进入服务端默认配置。

Run 前述两个测试，Expected: PASS。

- [ ] **Step 4: 写 settings client 请求测试**

使用注入式 `fetcher`，断言 global 只访问 `/api/settings`、thread 只访问 `/api/threads/thread-1/config`，且 payload 不包含外观字段。

```typescript
// apps/web/src/features/settings/settingsClient.ts
import type { ThreadConfigUpdate } from '@suanlizi/protocol';
import type { RunConfig } from '../../config/config.js';
import { globalRuntimePayload } from './configState.js';

type Fetcher = typeof fetch;

async function patchConfig(fetcher: Fetcher, url: string, config: Partial<RunConfig>): Promise<void> {
  const response = await fetcher(url, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ config: globalRuntimePayload(config) }),
  });
  if (!response.ok) throw new Error(`Config save failed: ${response.status}`);
}

export const saveGlobalDefaults = (config: Partial<RunConfig>, fetcher: Fetcher = fetch) =>
  patchConfig(fetcher, '/api/settings', config);

export async function saveActiveThreadConfig(
  threadId: string,
  update: ThreadConfigUpdate,
  fetcher: Fetcher = fetch,
): Promise<void> {
  const response = await fetcher(`/api/threads/${encodeURIComponent(threadId)}/config`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(update),
  });
  if (!response.ok) throw new Error(`Thread config save failed: ${response.status}`);
}
```

- [ ] **Step 5: 替换 `main.tsx` 自动双写 effect**

删除同时 PATCH `/api/settings` 与 `/api/threads/:id/config` 的 effect。使用 `useReducer(configStateReducer, initialConfigState)`，加载全局时 dispatch `globals.loaded`，加载线程快照时 dispatch `thread.selected`。Composer 的权限、reasoning、runProfile、模型预设在有当前线程时必须先调用 `saveActiveThreadConfig(threadId, {set})`，成功后才 dispatch `thread.patched`；“恢复继承”发送 `{unset:[key]}`，成功后 dispatch `thread.unset`。无当前线程时只改 `newThreadOverrides`。每个 immediate control 有 pending/error，失败保留原有效值并在 Composer 附近显示可重试错误，不能只改本地后假装已生效。创建新线程发送 `configOverrides: newThreadOverrides`。

把“persist 成功后才 dispatch”封装到 `threadRunConfigActions.ts`，注入 save/dispatch，测试 deferred resolve、reject、重复点击和 stale threadId：reject 时 0 次 state commit，切换线程后的晚到成功也不能写入新线程。

普通 turn、interrupt、resume、fork 请求不得再附带全量 `config`，运行时只读取服务端已存 defaults + overrides。为 `buildTurnRequest` 增加测试：返回体不含 `config`。

服务端同步从 `TurnRequest` 删除 `config`，并在 turn/interrupt/resume/fork route 对请求体中的 `config` 返回 400 `REQUEST_CONFIG_NOT_ALLOWED`；不要静默 strip，也不要保留旧分支。API 测试证明 config 不会触发 `saveThreadRunConfig`，而当前线程已持久化 overrides 仍会被 runtime resolve 使用。

外观仍写 `localStorage`，不进入 thread API。Settings 的“设为默认”和“应用到当前对话”分别调用 `saveGlobalDefaults` 与 `saveActiveThreadConfig`，成功后才更新 reducer baseline。

- [ ] **Step 6: 删除打开 Settings 的隐式写入**

从 Web `SettingsDrawer.tsx` 删除强制 `webSearchMode='auto'` 的 effect，并删除 env var input 的 `onBlur` 远程保存。环境变量只通过明确的“保存绑定”按钮提交；失败必须保留 draft 并展示 error。

- [ ] **Step 7: 运行配置定向测试和构建**

Run:

```powershell
npx vitest run packages/protocol/src/runConfig.test.ts apps/api/src/config/config.test.ts apps/api/src/config/threadRunConfig.test.ts apps/api/src/routes/threadConfigScope.test.ts apps/api/src/routes/threadRunRequestScope.test.ts apps/web/src/features/settings/configState.test.ts apps/web/src/features/settings/settingsClient.test.ts apps/web/src/features/settings/threadRunConfigActions.test.ts
npm run build
```

Expected: 测试与 build 均通过。

- [ ] **Step 8: 提交作用域修复**

```powershell
git add packages/protocol/src/runConfig.ts apps/api/src/config/config.ts apps/api/src/config/config.test.ts apps/api/src/config/threadRunConfig.test.ts apps/api/src/routes/threadRoutes.ts apps/api/src/routes/threadRuntimeActions.ts apps/api/src/routes/threadConfigScope.test.ts apps/api/src/routes/threadRunRequestScope.test.ts apps/api/src/server.ts apps/web/src/features/settings apps/web/src/main.tsx apps/web/src/components/SettingsDrawer.tsx apps/web/src/components/ComposerBar.tsx
git commit -m "fix: separate global and thread configuration scopes"
```

### Task 4: 阻止线程切换竞态 ✅ DONE

**Files:**
- Create: `apps/web/src/features/chat/latestRequestGuard.ts`
- Create: `apps/web/src/features/chat/latestRequestGuard.test.ts`
- Create: `apps/web/src/features/chat/localTranscriptEntry.ts`
- Create: `apps/web/src/features/chat/localTranscriptEntry.test.ts`
- Modify: `apps/web/src/features/chat/threadItems.ts`
- Modify: `apps/web/src/features/chat/threadItems.test.ts`
- Modify: `apps/web/src/features/chat/threads.test.ts`
- Modify: `apps/web/src/features/workflow/workflow.ts`
- Modify: `apps/web/src/features/workflow/workflow.test.ts`
- Modify: `apps/web/src/main.tsx`

- [ ] **Step 1: 写 generation guard 的失败测试**

```typescript
// apps/web/src/features/chat/latestRequestGuard.test.ts
import { describe, expect, it } from 'vitest';
import { createLatestRequestGuard } from './latestRequestGuard.js';

describe('createLatestRequestGuard', () => {
  it('aborts the previous request and rejects its result', () => {
    const guard = createLatestRequestGuard();
    const first = guard.begin();
    const second = guard.begin();
    expect(first.signal.aborted).toBe(true);
    expect(guard.isCurrent(first.generation)).toBe(false);
    expect(guard.isCurrent(second.generation)).toBe(true);
  });
});
```

- [ ] **Step 1a: 写 local transcript reconciliation 失败测试**

`localTranscriptEntry.test.ts` 固定判别联合和四个可观察结果：local entry 必须是 `{source:'local', correlationId, threadId, item}`，canonical entry 必须是 `{source:'canonical', item}`；snapshot 用 canonical item 替换并清除该线程 local entry；成功按 correlationId 原子移除 local 后合并 canonical items；失败移除 local 且不伪造 canonical item；线程切换清除旧线程 local entry，不能进入新线程。测试不得读取 `pending_user_`、`skill_draft_` 等 id 前缀。

- [ ] **Step 2: 实现 guard**

```typescript
// apps/web/src/features/chat/latestRequestGuard.ts
export function createLatestRequestGuard() {
  let generation = 0;
  let controller: AbortController | null = null;
  return {
    begin() {
      controller?.abort();
      controller = new AbortController();
      generation += 1;
      return { generation, signal: controller.signal };
    },
    isCurrent(candidate: number) {
      return candidate === generation && controller?.signal.aborted === false;
    },
    dispose() {
      controller?.abort();
      controller = null;
      generation += 1;
    },
  };
}
```

- [ ] **Step 2a: 实现显式 local entry 与协调边界**

```typescript
// apps/web/src/features/chat/localTranscriptEntry.ts
export type TranscriptEntry =
  | { source: 'canonical'; item: ThreadItem }
  | { source: 'local'; correlationId: string; threadId: ThreadId; item: ThreadItem };
```

`main.tsx` 为每次 optimistic action 创建不依赖 item id 格式的 correlationId；`threadItems.ts` 只通过 `source` 与 correlationId 执行 replace/remove，并在渲染边界解包 `entry.item`。删除所有用 `startsWith('pending_user')`、`startsWith('skill_draft')` 判断生命周期的分支。REST 成功先 reconcile 再合并 canonical items；REST 失败先清理 correlation，再重拉 snapshot；snapshot commit 和线程切换都显式清理相应 local entries。

- [ ] **Step 3: 将线程快照加载改为纯 fetch + 条件提交**

`reloadThreadSnapshot(id, signal)` 必须把相同 signal 传给 thread、workflow、children 和 context-pressure 请求；将 `loadThreadWorkflow(threadId)` 扩展为 `loadThreadWorkflow(threadId, signal)`，并把该 signal 原样传给内部 fetch。解析完成后先检查 `guard.isCurrent(generation)`，再一次性提交 items/turns/usage/config/workflow。`loadThread` 必须先关闭旧 EventSource，再为目标线程创建 buffering EventSource；收到 connected 后才拉 snapshot。snapshot 期间事件只进入带单调 receive cursor 的 buffer；commit 后按 cursor 排序，并以事件 cursor 或 canonical `(event.type, item.id)` identity 去重 flush，随后切为 live。generation 失效时必须同时 abort fetch、关闭该 stream 并丢弃 buffer；断线重连完整重走“订阅缓冲 → snapshot → flush → live”，禁止先 snapshot 后开 SSE。

核心顺序固定为：

```typescript
const request = threadLoadGuardRef.current.begin();
eventSourceRef.current?.close();
const stream = openBufferedThreadEventSource(id, request.generation);
await stream.connected;
const snapshot = await fetchThreadSnapshot(id, request.signal);
if (!threadLoadGuardRef.current.isCurrent(request.generation)) {
  stream.close();
  return;
}
commitThreadSnapshot(snapshot);
stream.flushOrderedUnique(applyCanonicalThreadEvent);
stream.goLive(applyCanonicalThreadEvent);
```

- [ ] **Step 4: 添加交错响应回归测试**

测试创建 A、B 两个 deferred fetch：先请求 A，再请求 B；先 resolve B、后 resolve A。最终 state 必须只包含 B，且只有 B 的 stream 存活。断言 workflow fetch 收到与 thread/children/context-pressure 相同的 signal；线程切换 abort 后，旧 workflow 请求以 AbortError 取消且旧 workflow 结果不提交。再将 canonical item 事件分别插在 connected 后/snapshot 返回前、snapshot commit 后/flush 前与 live 阶段，断言 snapshot 未包含的事件不会丢失；让 snapshot 与 buffer 含同一 item，并重复投递同 cursor/同 lifecycle identity，断言最终 items/turns 各只有一份且顺序稳定。

Run:

```powershell
npx vitest run apps/web/src/features/chat/latestRequestGuard.test.ts apps/web/src/features/chat/localTranscriptEntry.test.ts apps/web/src/features/chat/threadItems.test.ts apps/web/src/features/chat/threads.test.ts apps/web/src/features/workflow/workflow.test.ts
```

Expected: PASS。

- [ ] **Step 5: 提交线程加载修复**

```powershell
git add apps/web/src/features/chat/latestRequestGuard.ts apps/web/src/features/chat/latestRequestGuard.test.ts apps/web/src/features/chat/localTranscriptEntry.ts apps/web/src/features/chat/localTranscriptEntry.test.ts apps/web/src/features/chat/threadItems.ts apps/web/src/features/chat/threadItems.test.ts apps/web/src/features/chat/threads.test.ts apps/web/src/features/workflow/workflow.ts apps/web/src/features/workflow/workflow.test.ts apps/web/src/main.tsx
git commit -m "fix: reject stale thread snapshot responses"
```

### Task 5: 只在用户位于底部时跟随消息

**Files:**
- Create: `apps/web/src/features/chat/transcriptFollow.ts`
- Create: `apps/web/src/features/chat/transcriptFollow.test.ts`
- Modify: `apps/web/src/main.tsx`
- Modify: `apps/web/src/styles.css`

- [ ] **Step 1: 写滚动状态机失败测试**

```typescript
// apps/web/src/features/chat/transcriptFollow.test.ts
import { describe, expect, it } from 'vitest';
import { nextTranscriptFollowState } from './transcriptFollow.js';

describe('nextTranscriptFollowState', () => {
  it('stops following when the user scrolls more than 96px from bottom', () => {
    expect(nextTranscriptFollowState({ following: true, distanceFromBottom: 180, source: 'user' }))
      .toEqual({ following: false, showReturnToBottom: true });
  });

  it('keeps following for streaming content while already at bottom', () => {
    expect(nextTranscriptFollowState({ following: true, distanceFromBottom: 12, source: 'content' }))
      .toEqual({ following: true, showReturnToBottom: false });
  });
});
```

- [ ] **Step 2: 实现纯状态机**

```typescript
// apps/web/src/features/chat/transcriptFollow.ts
export interface TranscriptFollowState {
  following: boolean;
  showReturnToBottom: boolean;
}

export function nextTranscriptFollowState(input: {
  following: boolean;
  distanceFromBottom: number;
  source: 'user' | 'content' | 'return-action';
}): TranscriptFollowState {
  if (input.source === 'return-action') return { following: true, showReturnToBottom: false };
  if (input.source === 'user' && input.distanceFromBottom > 96) {
    return { following: false, showReturnToBottom: true };
  }
  if (input.distanceFromBottom <= 32) return { following: true, showReturnToBottom: false };
  return { following: input.following, showReturnToBottom: !input.following };
}
```

- [ ] **Step 3: 替换无条件 smooth scroll effect**

Transcript `onScroll` 只更新 follow state；`lastItemSignature` 变化时仅当 `following=true` 才使用 `requestAnimationFrame` 设置 `scrollTop=scrollHeight`。非跟随状态显示固定在 transcript 右下角的“回到底部”按钮，点击后立即滚到底并恢复 following。

- [ ] **Step 4: 验证测试并提交**

Run:

```powershell
npx vitest run apps/web/src/features/chat/transcriptFollow.test.ts
npm run build
```

Expected: PASS 且 build 退出码 0。

```powershell
git add apps/web/src/features/chat/transcriptFollow.ts apps/web/src/features/chat/transcriptFollow.test.ts apps/web/src/main.tsx apps/web/src/styles.css
git commit -m "fix: preserve transcript reading position"
```

### Task 6: 修正旧 Monitor 的 Run 归属和控制能力

**Files:**
- Create: `packages/protocol/src/runControl.ts`
- Create: `packages/protocol/src/runControl.test.ts`
- Modify: `packages/protocol/src/index.ts`
- Modify: `packages/protocol/src/types.ts`
- Modify: `packages/protocol/src/schemas.ts`
- Modify: `packages/protocol/src/schemas.test.ts`
- Modify: `packages/storage/src/store.ts`
- Modify: `packages/storage/src/store.test.ts`
- Modify: `packages/storage/src/postgres.ts`
- Modify: `packages/storage/src/postgres.test.ts`
- Modify: `packages/storage/src/index.ts`
- Modify: `packages/storage/src/backend.test.ts`
- Modify: `apps/api/src/routes/runMonitorRoute.ts`
- Modify: `apps/api/src/routes/runMonitorRoute.test.ts`
- Modify: `apps/api/src/routes/threadRuntimeActions.ts`
- Create: `apps/api/src/runtime/activeRunRegistry.ts`
- Create: `apps/api/src/runtime/activeRunRegistry.test.ts`
- Modify: `apps/api/src/runtime/tenantRuntime.ts`
- Modify: `apps/api/src/runtime/tenantRuntime.test.ts`
- Modify: `apps/api/src/server.ts`
- Modify: `packages/runtime/src/agent.ts`
- Modify: `packages/runtime/src/agent.test.ts`
- Create: `apps/web/src/features/monitor/runMonitorState.ts`
- Create: `apps/web/src/features/monitor/runMonitorState.test.ts`
- Modify: `apps/web/src/features/monitor/runMonitor.ts`
- Modify: `apps/web/src/features/chat/threadView.ts`
- Modify: `apps/web/src/features/chat/threadView.test.ts`
- Modify: `apps/web/src/components/RunMonitorDrawer.tsx`
- Modify: `apps/web/src/main.tsx`

- [ ] **Step 1: 写 Run 状态归属失败测试**

```typescript
// apps/web/src/features/monitor/runMonitorState.test.ts
import { describe, expect, it } from 'vitest';
import { initialRunMonitorState, runMonitorReducer } from './runMonitorState.js';

describe('runMonitorReducer', () => {
  it('preserves an explicitly selected historical run after refresh', () => {
    const selected = { ...initialRunMonitorState, selectedRunId: 'run-old' };
    const next = runMonitorReducer(selected, {
      type: 'runs.loaded',
      requestId: 2,
      runs: [{ runId: 'run-new' }, { runId: 'run-old' }] as never,
    });
    expect(next.selectedRunId).toBe('run-old');
  });

  it('ignores a stale events response', () => {
    const state = { ...initialRunMonitorState, selectedRunId: 'run-b', activeRequestId: 4 };
    const next = runMonitorReducer(state, {
      type: 'events.loaded',
      requestId: 3,
      runId: 'run-a',
      events: [{ runId: 'run-a' }] as never,
    });
    expect(next.events).toEqual([]);
  });
});
```

- [ ] **Step 1a: 写 Monitor item identity 失败测试**

在 `threadView.test.ts` 用同一 turn 构造两次同名 tool、两个 `file_change`、两个 `error`，每个 item 使用不同 id；断言 `describeEvent` 产生六个不同 key。再对同一 item id 的 started/completed 断言 key 相同，证明更新原行而不是新增。测试不得接受仅由 turnId、item type 或 tool name 组成的 key。

- [ ] **Step 2: 给 storage 增加租户限定的单 Run 查询**

不要把监控方法强塞成核心 `ThreadStore` 的必需方法；现有大量 memory/runtime 测试 fake 只需要线程能力。新增窄接口并在 Monitor 装配处要求交集：

```typescript
export interface RunRecordFilter {
  threadId?: ThreadId;
  status?: RunStatus;
  limit?: number;
}

export interface RunEventFilter {
  limit?: number;
  category?: string;
}

export interface RunMonitorStore {
  getRunRecord(runId: string): Promise<RunRecord | null>;
  listRunRecords(filter?: RunRecordFilter): Promise<RunRecord[]>;
  listRunEvents(runId: string, filter?: RunEventFilter): Promise<RunEvent[]>;
  createRunRecord(record: RunRecord): Promise<void>;
  updateRunRecord(runId: string, patch: Partial<RunRecord>): Promise<void>;
  appendRunEvent(event: RunEvent): Promise<void>;
}
```

SQLite 实现：

```typescript
async getRunRecord(runId: string): Promise<RunRecord | null> {
  const row = this.db.prepare(
    'SELECT * FROM run_records WHERE tenant_id = ? AND run_id = ?',
  ).get(this.tenantId, runId) as Record<string, unknown> | undefined;
  return row ? rowToRunRecord(row) : null;
}
```

PostgreSQL 使用同样的 `WHERE tenant_id = $1 AND run_id = $2` 约束；测试必须证明 tenant A 不能读取 tenant B 的相同/不同 runId。SQLite/PostgreSQL 与 `createFileBackedDb` fallback 都实现 `ThreadStore & RunMonitorStore`；fallback 的 JSON state 增加 run records/events 并通过同一归属 contract，禁止 silent no-op。`runMonitorRoute` 显式接收 `RunMonitorStore`；无关的 ThreadStore fake 不需要空实现监控方法。`AgentConfig` 增加独立 `runMonitorStore?: RunMonitorStore`，旧 monitor 写入只走这个 capability；tenant runtime 的生产装配必须传真实 store，纯 runtime 单测可不启用监控。server composition 在启动时验证并注入，不在每次写入时 optional-chain 核心 ThreadStore 方法。

- [ ] **Step 3: 将控制动作缩到真实支持范围并返回能力**

```typescript
export type RunControlAction = 'interrupt' | 'resume' | 'rollback';

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
  action: RunControlAction;
  accepted: boolean;
  reason?: string;
}
```

类型与 Zod discriminated union 放入 `packages/protocol/src/runControl.ts` 并从 index 导出；三个 request 分支都 `.strict()`。能力计算必须同时读取 Run 状态、active-run registry 和该线程 checkpoint：running 只有 registry 中仍存在该精确 runId 时才允许 interrupt；interrupted/failed 可 resume；rollback 只有存在 `checkpoint.turnCount < currentTurnCount` 的旧 checkpoint 才启用并返回其 id。`resolveRollbackCount` 若差值小于等于 0 必须返回 `CHECKPOINT_NOT_OLDER`，禁止用 `Math.max(1, ...)` 回退错误 turn。

`POST /api/runs/:runId/control` 必须先 `getRunRecord`，不存在返回 404；请求 schema 使用 `.strict()`，客户端不得传 `threadId`，服务端从 RunRecord 得到真实 threadId；不在 capabilities 内返回 409。每个 accepted action 创建独立 `kind='control'` 的 `controlRunId`，`parentRunId` 指向 URL 中的 target Run，不能向已经终态的 target 追加审计事件。approve/deny 保留原 approval API，不进入 run control。`handleRunControlAction` 对未知动作直接 throw，不再返回 `{unsupported}` 的 HTTP 200。GET runs 响应为每个 Run 附加 `controlCapabilities`。

- [ ] **Step 3a: 让 interrupt 命中真实运行实例**

当前每次 turn 会创建/选择具体 `AgentLoop`，不能再让控制路由调用 tenant default agent。`TurnStartedEvent/TurnCompletedEvent/TurnFailedEvent` 增加 required `runId`；`beginRunMonitor` 返回它创建的 runId，normal turn、resume 与 harness 路径的所有 emitter/schema fixture 同步更新。

`ActiveRunRegistry` 固定接口：

```typescript
interface ActiveRunHandle {
  runId: string;
  threadId: ThreadId;
  turnId: TurnId;
  interrupt(): Promise<void> | void;
}

class ActiveRunRegistry {
  register(handle: ActiveRunHandle): () => void;
  get(runId: string): ActiveRunHandle | null;
  finish(runId: string): void;
}
```

tenant runtime 监听具体 agent 的 lifecycle：started 注册 `() => agent.interrupt(threadId)`，terminal 与 run promise `finally` 双保险注销。控制路由只调用 `registry.get(runId)?.interrupt()`；不存在时 capability disabled/409 `RUN_NOT_ACTIVE`。并发测试启动两个不同 AgentLoop/Run，interrupt A 只能 abort A，B 继续；终态后 registry 为空。registry 是 tenant-scoped，跨租户 runId 不可见。

- [ ] **Step 4: 实现 Run Monitor reducer**

State 至少包含：

```typescript
export interface RunMonitorState {
  runs: RunRecord[];
  events: RunEvent[];
  selectedRunId: string;
  expandedThreadId: string;
  activeRequestId: number;
  loading: boolean;
}
```

`runs.loaded` 仅在当前选择已不存在时选择第一项；`events.loaded` 必须同时匹配 requestId 与 selectedRunId。切换 thread 时终止旧 AbortController。展开另一个 thread 时按该 threadId 请求 runs，不能继续使用主界面 currentThreadId。

同时将 `threadView.ts` 的 item `eventKey` 固定为包含完整稳定 `item.id`（例如 `item:${item.id}`）；turnId、item type 与 tool name 只用于分组或可见标签，不能参与身份替代。

- [ ] **Step 5: 删除历史 Drawer 的当前线程数据注入**

从 `RunMonitorDrawer` props 与 `main.tsx` 调用中删除：

```typescript
taskRuntimeState
runtimeItems
checkpoints
currentTurnCount
```

旧 Drawer 在 Trace V2 前只展示 `selectedRunId` 对应的 RunRecord 与 RunEvent。`TaskRuntimeMonitorPanel` 保留在右栏，语义明确为 live current-thread HUD。

- [ ] **Step 6: 停止每条 SSE 全量 refresh**

删除 Web `if (runMonitor.open) void runMonitor.refresh()`。P0 只在 `turn.completed`、`turn.failed`、`thread.rollback.completed` 触发一次 `refresh(selectedRunId)`；Task B 上线后由 `run.trace.appended` 增量 reducer 替换这次刷新。

- [ ] **Step 7: 运行定向测试**

Run:

```powershell
npx vitest run packages/protocol/src/runControl.test.ts packages/protocol/src/schemas.test.ts packages/storage/src/store.test.ts packages/storage/src/postgres.test.ts packages/storage/src/backend.test.ts packages/runtime/src/agent.test.ts apps/api/src/runtime/activeRunRegistry.test.ts apps/api/src/runtime/tenantRuntime.test.ts apps/api/src/routes/runMonitorRoute.test.ts apps/web/src/features/monitor/runMonitorState.test.ts apps/web/src/features/chat/threadView.test.ts apps/web/src/components/RunMonitorDrawer.test.ts
npm run build
```

Expected: PASS 且 build 退出 0；API 测试同时覆盖 404、请求携带 threadId 的 strict-schema 400、RUN_NOT_ACTIVE/非法状态/旧 checkpoint 的 409 与支持动作 200。

- [ ] **Step 8: 提交 Monitor 正确性修复**

```powershell
git add packages/protocol/src/runControl.ts packages/protocol/src/runControl.test.ts packages/protocol/src/index.ts packages/protocol/src/types.ts packages/protocol/src/schemas.ts packages/protocol/src/schemas.test.ts packages/storage/src/store.ts packages/storage/src/store.test.ts packages/storage/src/postgres.ts packages/storage/src/postgres.test.ts packages/storage/src/index.ts packages/storage/src/backend.test.ts packages/runtime/src/agent.ts packages/runtime/src/agent.test.ts apps/api/src/runtime/activeRunRegistry.ts apps/api/src/runtime/activeRunRegistry.test.ts apps/api/src/runtime/tenantRuntime.ts apps/api/src/runtime/tenantRuntime.test.ts apps/api/src/server.ts apps/api/src/routes/runMonitorRoute.ts apps/api/src/routes/runMonitorRoute.test.ts apps/api/src/routes/threadRuntimeActions.ts apps/web/src/features/monitor apps/web/src/features/chat/threadView.ts apps/web/src/features/chat/threadView.test.ts apps/web/src/components/RunMonitorDrawer.tsx apps/web/src/main.tsx
git commit -m "fix: bind monitor state and controls to selected runs"
```

### Task 7: P0 全量验证与人工回归

**Files:**
- Modify only if a verification failure identifies a concrete defect in a P0-touched file.

- [ ] **Step 1: 运行静态与全量测试**

```powershell
npm run verify
```

Expected: `verify` 退出码为 0；测试数不得少于执行前的 922。

- [ ] **Step 2: 检查构建没有污染源码目录**

```powershell
git status --short
git ls-files --others --exclude-standard | Select-String -Pattern '\.(js|js\.map|d\.ts|d\.ts\.map)$'
```

Expected: 第二条无输出；status 只包含明确的 P0 源码/测试修改。

- [ ] **Step 3: 在 5177 执行 P0 交互清单**

使用内置浏览器验证：

1. 打开、关闭 Settings，不触发 PATCH，也不改变联网模式。
2. 修改模型 draft 后取消保存，刷新页面，配置不变。
3. 分别保存“当前对话”和“应用默认”，Network 中各只有对应 endpoint。
4. 快速交替点击两个线程，最终标题、items、usage、Agent children 全属于最后一次点击。
5. 向上滚动后触发模型 delta，视口不跳；点击“回到底部”恢复跟随。
6. Monitor 选历史失败 Run 后刷新，选中项不跳回最新 Run，页面不出现当前 task state。
7. completed Run 仅在有更旧 checkpoint 时显示 rollback；registry 中仍 active 的 running Run 只显示 interrupt，陈旧 running 记录不显示可执行控制。

- [ ] **Step 4: 记录基线结果**

在总路线图 M1 对应 checkbox 勾选通过项；任何失败项在进入 Trace V2 前修复并增加回归测试。P0 不创建额外“收尾提交”，修复应 amend 到对应任务提交或以 `fix:` 独立提交保留因果。
