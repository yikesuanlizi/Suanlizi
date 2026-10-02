# Suanlizi Access Policy Strict Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建立 Suanlizi 的严格模式与工作区授权系统，把“设置里的持久允许/禁止”和“运行时弹窗里的临时允许/禁止”彻底拆开，并让本地文件、目录、命令、网络、MCP、Skill 调用都走同一个可审计的权限判定入口。

**Architecture:** 新增协议层 `AccessPolicy` 类型，运行时用一个独立 evaluator 合并全局规则、线程规则、工作区默认规则、临时授权和工具请求，再输出 `allow / prompt / deny` 决策。工具层不再自己用绝对路径绕过工作区，所有本地路径都先归一化成 `AccessRequest`，由 runtime 决定是否执行、弹窗或拒绝。前端设置页只编辑持久规则；审批面板只处理临时规则，并把每次命中原因写入活动与监控。

**Tech Stack:** TypeScript、Zod、Vitest、React、Vite、Node.js、SQLite-backed settings/thread store、现有 `@suanlizi/protocol` / `@suanlizi/runtime` / `@suanlizi/tools` / `@suanlizi/sandbox` 包。

---

## 当前事实

- 现有粗粒度权限只有 `PermissionPresetId = 'read_only' | 'workspace' | 'danger_full_access'`，定义在 `packages/protocol/src/runConfig.ts` 与 `packages/sandbox/src/presets.ts`。
- `apps/api/src/config/config.ts` 的 `AgentRunConfig.permissions` 当前默认是 `workspace`，但它只能表达沙箱等级，不能表达“某个目录永久禁止”“某个外部目录永久只读”“这次弹窗临时允许”。
- `apps/api/src/config/config.ts` 已有 `hiddenChatWorkspaceRoot(dataDir)`，`createConfigRepository()` 已经能给普通对话使用隐藏工作区，这是可复用基础。
- `packages/tools/src/registry.ts` 的 `ToolContext.workspaceRoot` 是工具的路径解析基础。
- `packages/tools/src/builtin.ts` 里的工具 `requiredPolicy` 已区分 `readonly` 与 `workspace_write`，但单个工具内部仍可以解析绝对路径。
- `packages/sandbox/src/sandbox.ts` 当前 `canRead()` / `canWrite()` 用 `absPath.startsWith(workspaceRoot)` 判断路径边界，需要改成 path-aware 边界判断，否则 `E:\langchain\Suanlizi2` 会被错误认为在 `E:\langchain\Suanlizi` 内。
- `packages/runtime/src/toolGovernance.ts` 当前会发 `approval.required`，但协议里没有表达“临时允许范围”和“持久规则命中原因”。
- `apps/web/src/main.tsx` 与 `apps/desktop/src/main.tsx` 当前直接渲染 `pendingApprovals`，审批 UI 需要改成面板式临时授权，不写设置。

## 目标语义

### 模式

| 模式 | 默认工作区 | 默认读取 | 默认写入 | 外部目录 | 适用场景 |
| --- | --- | --- | --- | --- | --- |
| 对话模式 `chat` | 隐藏 chat workspace | 只允许隐藏工作区 | 禁止 | 需要设置持久授权或运行时临时授权 | 普通问答、非代码任务 |
| 工作区模式 `workspace` | 用户选择的 workspaceRoot | 允许工作区内读取 | 允许工作区内写入 | 需要设置持久授权或运行时临时授权 | 项目开发、代码修改 |
| 高风险模式 `danger_full_access` | 当前运行配置 | 允许全部 | 允许全部 | 允许全部 | 高级开关，不能作为默认值 |

### 决策优先级

权限判定必须稳定、可解释，按以下顺序返回第一条最终决策：

1. 危险操作硬拒绝规则：删除根目录、写入系统目录、明显破坏性命令。
2. 持久拒绝规则：设置页保存的全局/线程 deny。
3. 持久允许规则：设置页保存的全局/线程 allow。
4. 工作区默认规则：对话模式隐藏工作区；工作区模式选中 workspaceRoot。
5. 临时拒绝规则：审批面板中本轮/本次 tool call 拒绝。
6. 临时允许规则：审批面板中本轮/本次 tool call 允许。
7. 需要用户确认：返回 `prompt`，前端显示审批面板。
8. 默认拒绝：无审批处理器、后台任务、超时、非法路径、解析失败。

持久拒绝必须压过临时允许。审批弹窗永远不写持久配置。

## 文件结构

### 协议层

- Create: `packages/protocol/src/accessPolicy.ts`
  - 定义 `AccessMode`、`AccessKind`、`AccessEffect`、`AccessRule`、`TemporaryAccessGrant`、`AccessPolicyConfig`、`AccessRequest`、`AccessDecision`。
  - 提供纯函数 `normalizeAccessRule()`、`normalizeAccessPolicyConfig()`、`redactAccessPolicyForPublicConfig()`。
- Create: `packages/protocol/src/accessPolicySchemas.ts`
  - 定义所有 access policy 的 Zod schema。
  - 导出 `accessPolicyConfigSchema`、`accessRuleSchema`、`temporaryAccessGrantSchema`、`accessDecisionSchema`。
- Create: `packages/protocol/src/accessPolicySchemas.test.ts`
  - 覆盖规则解析、非法 path 拒绝、公开配置不泄露敏感命令 payload。
- Modify: `packages/protocol/src/index.ts`
  - 导出 access policy 类型和 schema。
- Modify: `packages/protocol/src/runConfig.ts`
  - `ThreadRunConfigOverrides` 增加 `accessPolicy?: AccessPolicyConfig`。
  - `THREAD_RUN_CONFIG_KEYS` 增加 `accessPolicy`。
  - `GlobalRunConfigDefaultsSchema` 增加 `accessPolicy` 默认值。
- Modify: `packages/protocol/src/schemas.ts`
  - `approvalRequiredEventSchema` 增加 `accessRequest`、`temporaryGrantOptions`、`matchedRule` 字段。
- Modify: `packages/protocol/src/types.ts`
  - `ApprovalRequest` 与 `ApprovalRequiredEvent` 增加 access policy 元数据。

### 沙箱与运行时

- Modify: `packages/sandbox/src/sandbox.ts`
  - 修正路径边界判断，使用 `path.relative()` 判定 path containment。
- Modify: `packages/sandbox/src/sandbox.test.ts`
  - 增加 `E:\langchain\Suanlizi2` 不能命中 `E:\langchain\Suanlizi` 的测试。
- Create: `packages/runtime/src/accessPolicy.ts`
  - 实现 `evaluateAccessRequest()`、`mergePersistentRules()`、`temporaryGrantMatches()`、`buildRuntimeAccessPolicy()`。
  - 决策函数只依赖入参，不读取磁盘，便于测试。
- Create: `packages/runtime/src/accessPolicy.test.ts`
  - 覆盖决策优先级、持久拒绝压过临时允许、对话模式默认只读、工作区模式默认读写、非法绝对路径默认 prompt 或 deny。
- Modify: `packages/runtime/src/toolGovernance.ts`
  - 在 `beforeTool` 中先执行 access policy 判定。
  - `deny` 直接返回结构化失败。
  - `prompt` 发 `approval.required`，审批通过后只写入 runtime 内存中的 temporary grants。
  - 审批拒绝后只写入 runtime 内存中的 temporary denies。
- Modify: `packages/runtime/src/agent.ts`
  - 构造 runtime 时从 `AgentRunConfig.accessPolicy` 创建本次运行 policy。
  - 创建 `ToolContext` 时注入 `accessPolicy` 与 `requestAccess()`。
  - 子 Agent 继承父线程的安全上限：子 Agent 不能获得父 Agent 没有的持久权限。
  - `appendRunMonitorEvent()` 增加 access decision audit 元数据。

### 工具层

- Create: `packages/tools/src/accessGuard.ts`
  - 提供 `resolveToolPathAccess()`、`extractToolAccessRequests()`、`toolResultFromAccessDecision()`。
  - 每个读写工具在执行前都返回明确 `AccessRequest`，避免工具内部直接读取外部绝对路径。
- Create: `packages/tools/src/accessGuard.test.ts`
  - 覆盖相对路径、绝对路径、目录遍历、Windows 盘符、UNC 路径。
- Modify: `packages/tools/src/registry.ts`
  - `ToolContext` 增加 `accessPolicy` 快照和 `requestAccess(request)` 函数。
- Modify: `packages/tools/src/builtin.ts`
  - `read_file`、`read_document`、`list_files`、`search_content`、`write_file`、`apply_patch`、`shell_command` 执行前统一生成 `AccessRequest`。
  - `shell_command` 从命令字符串中提取工作目录与显式路径参数，无法安全解析时用 command 级请求让 runtime 决定是否 prompt。
- Modify: `packages/tools/src/builtin.test.ts`
  - 覆盖外部 docx 读取必须走 access request。
  - 覆盖对话模式读取隐藏 workspace 以外文件时必须 prompt。
  - 覆盖工作区模式写工作区外文件时必须 prompt。

### API 与持久化

- Modify: `apps/api/src/config/config.ts`
  - `AgentRunConfig` 增加 `accessPolicy: AccessPolicyConfig`。
  - `resolveConfig()` 解析旧 `permissions` 后只写入新 `accessPolicy`，不再把 `permissions` 作为主要权限模型。
  - `publicRunConfig()` 返回公开 access policy，但不返回临时 grants。
  - `createConfigRepository()` 增加 `getGlobalAccessPolicy()`、`saveGlobalAccessPolicy()`、`getThreadAccessPolicy()`、`saveThreadAccessPolicy()`。
  - `readThreadRunConfig()` 与 `saveThreadRunConfig()` 支持线程级 persistent rules。
- Modify: `apps/api/src/config/config.test.ts`
  - 覆盖旧 preset 到新 access policy 的一次性迁移。
  - 覆盖 chat thread 返回公开 config 时不泄露隐藏 workspace 绝对路径。
- Modify: `apps/api/src/routes/settingsRoute.ts`
  - `GET /api/settings` 返回 `accessPolicy`。
  - `PATCH /api/settings/access-policy` 保存全局持久规则。
- Modify: `apps/api/src/routes/threadRoutes.ts`
  - `GET /api/threads/:id/config` 返回线程级持久规则。
  - `PATCH /api/threads/:id/config` 接受 `accessPolicy` overrides。
- Create: `apps/api/src/routes/accessPolicyRoute.test.ts`
  - 覆盖全局规则保存、线程规则保存、非法规则拒绝、公开响应不包含临时授权。

### 前端设置与审批

- Create: `apps/web/src/components/settings/AccessPolicyPage.tsx`
  - 新建“权限与工作区”设置页。
  - 展示当前模式、工作区根目录、持久允许规则、持久拒绝规则。
  - 支持新增目录规则、切换读/写/命令/网络、切换全局/当前线程作用域。
  - 保存按钮只保存当前页持久规则。
- Create: `apps/desktop/src/components/settings/AccessPolicyPage.tsx`
  - 与 web 同步内容。
- Modify: `apps/web/src/components/settings/SettingsShell.tsx`
  - 增加“权限与工作区”导航项。
  - 移除全局 sticky 保存栏对权限页的干扰；权限页使用本页保存按钮。
- Modify: `apps/desktop/src/components/settings/SettingsShell.tsx`
  - 与 web 同步。
- Modify: `apps/web/src/components/settings/settingsShell.test.tsx`
  - 覆盖权限页打开、规则新增、保存、取消、scope 切换。
- Modify: `apps/desktop/src/components/settings/settingsShell.test.tsx`
  - 与 web 同步。
- Create: `apps/web/src/components/ApprovalPanel.tsx`
  - 从 `main.tsx` 中抽出审批面板。
  - 明确显示“临时授权：仅本次工具调用 / 本轮 / 本次会话”。
  - 不提供“永久允许”按钮；永久规则只能去设置页。
- Create: `apps/desktop/src/components/ApprovalPanel.tsx`
  - 与 web 同步。
- Modify: `apps/web/src/main.tsx`
  - 使用 `ApprovalPanel`。
  - `decideApproval()` body 增加 `temporaryScope`，默认 `tool_call`。
- Modify: `apps/desktop/src/main.tsx`
  - 与 web 同步。
- Modify: `apps/web/src/shared/i18n.ts`
  - 增加权限页与审批面板中文/英文文案。
- Modify: `apps/desktop/src/shared/i18n.ts`
  - 与 web 同步。

### 监控与活动面板

- Modify: `apps/web/src/features/monitor/traceFormatters.ts`
  - 增加 access decision 类型展示：`allow`、`prompt`、`deny`、命中规则、scope、路径、工具名、Agent 名。
- Modify: `apps/desktop/src/features/monitor/traceFormatters.ts`
  - 与 web 同步。
- Modify: `apps/web/src/features/agents/agentWorkbenchModel.ts`
  - 最近活动事件直接显示资源使用：Skill、MCP、文件、命令、网络、权限判定，不再把“资源使用”和“最近事件”拆成两组。
- Modify: `apps/desktop/src/features/agents/agentWorkbenchModel.ts`
  - 与 web 同步。

## Task 1: 协议层 access policy 类型与 schema

**Files:**
- Create: `packages/protocol/src/accessPolicy.ts`
- Create: `packages/protocol/src/accessPolicySchemas.ts`
- Create: `packages/protocol/src/accessPolicySchemas.test.ts`
- Modify: `packages/protocol/src/index.ts`
- Modify: `packages/protocol/src/runConfig.ts`
- Modify: `packages/protocol/src/schemas.ts`
- Modify: `packages/protocol/src/types.ts`

- [ ] **Step 1: 写失败测试**

在 `packages/protocol/src/accessPolicySchemas.test.ts` 写入：

```ts
import { describe, expect, it } from 'vitest';
import {
  accessPolicyConfigSchema,
  accessRuleSchema,
  temporaryAccessGrantSchema,
} from './accessPolicySchemas.js';
import { normalizeAccessPolicyConfig, redactAccessPolicyForPublicConfig } from './accessPolicy.js';

describe('access policy schemas', () => {
  it('parses persistent allow and deny rules', () => {
    const parsed = accessPolicyConfigSchema.parse({
      mode: 'workspace',
      workspaceRoot: 'E:\\langchain\\Suanlizi',
      persistentRules: [
        { id: 'deny-temp', effect: 'deny', access: 'write', target: { kind: 'path', path: 'E:\\langchain\\Suanlizi\\.git' }, scope: 'global' },
        { id: 'allow-docs', effect: 'allow', access: 'read', target: { kind: 'path', path: 'E:\\langchain\\dexin-agent' }, scope: 'thread' },
      ],
      temporaryGrants: [],
    });

    expect(parsed.mode).toBe('workspace');
    expect(parsed.persistentRules).toHaveLength(2);
    expect(parsed.persistentRules[0].effect).toBe('deny');
  });

  it('rejects empty path rules', () => {
    expect(() =>
      accessRuleSchema.parse({
        id: 'empty',
        effect: 'allow',
        access: 'read',
        target: { kind: 'path', path: '' },
        scope: 'global',
      }),
    ).toThrow();
  });

  it('normalizes missing arrays and preserves mode', () => {
    const normalized = normalizeAccessPolicyConfig({
      mode: 'chat',
      workspaceRoot: '',
    });

    expect(normalized).toMatchObject({
      mode: 'chat',
      persistentRules: [],
      temporaryGrants: [],
    });
  });

  it('redacts temporary grants from public config', () => {
    const publicConfig = redactAccessPolicyForPublicConfig({
      mode: 'workspace',
      workspaceRoot: 'E:\\langchain\\Suanlizi',
      persistentRules: [],
      temporaryGrants: [
        {
          id: 'temp-1',
          effect: 'allow',
          access: 'read',
          target: { kind: 'path', path: 'E:\\secret' },
          scope: 'session',
          createdAt: '2026-07-27T00:00:00.000Z',
        },
      ],
    });

    expect(publicConfig.temporaryGrants).toEqual([]);
  });

  it('parses a temporary grant with tool-call scope', () => {
    const parsed = temporaryAccessGrantSchema.parse({
      id: 'grant-1',
      effect: 'allow',
      access: 'write',
      target: { kind: 'path', path: 'E:\\langchain\\Suanlizi\\README.md' },
      scope: 'tool_call',
      toolCallId: 'call_1',
      createdAt: '2026-07-27T00:00:00.000Z',
    });

    expect(parsed.scope).toBe('tool_call');
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run:

```bash
npx vitest run packages/protocol/src/accessPolicySchemas.test.ts
```

Expected:

```text
FAIL packages/protocol/src/accessPolicySchemas.test.ts
Cannot find module './accessPolicySchemas.js'
```

- [ ] **Step 3: 新增协议类型**

在 `packages/protocol/src/accessPolicy.ts` 写入：

```ts
export type AccessMode = 'chat' | 'workspace' | 'danger_full_access';
export type AccessKind = 'read' | 'write' | 'command' | 'network' | 'tool_call';
export type AccessEffect = 'allow' | 'deny';
export type AccessRuleScope = 'global' | 'thread';
export type TemporaryAccessScope = 'tool_call' | 'turn' | 'session';
export type AccessDecisionKind = 'allow' | 'prompt' | 'deny';

export interface AccessTarget {
  kind: 'path' | 'command' | 'network' | 'tool';
  path?: string;
  command?: string;
  host?: string;
  toolName?: string;
}

export interface AccessRule {
  id: string;
  effect: AccessEffect;
  access: AccessKind;
  target: AccessTarget;
  scope: AccessRuleScope;
  reason?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface TemporaryAccessGrant {
  id: string;
  effect: AccessEffect;
  access: AccessKind;
  target: AccessTarget;
  scope: TemporaryAccessScope;
  threadId?: string;
  turnId?: string;
  toolCallId?: string;
  createdAt: string;
  expiresAt?: string;
}

export interface AccessPolicyConfig {
  mode: AccessMode;
  workspaceRoot: string;
  persistentRules: AccessRule[];
  temporaryGrants: TemporaryAccessGrant[];
}

export interface AccessRequest {
  access: AccessKind;
  target: AccessTarget;
  threadId: string;
  turnId: string;
  toolName?: string;
  toolCallId?: string;
  agentThreadId?: string;
  agentRole?: string | null;
  description: string;
}

export interface AccessDecision {
  decision: AccessDecisionKind;
  request: AccessRequest;
  source:
    | 'hard_deny'
    | 'persistent_rule'
    | 'workspace_default'
    | 'temporary_grant'
    | 'approval_required'
    | 'default_deny';
  matchedRuleId?: string;
  matchedRuleScope?: AccessRuleScope | TemporaryAccessScope;
  justification: string;
}

export function normalizeAccessPolicyConfig(input: Partial<AccessPolicyConfig> = {}): AccessPolicyConfig {
  return {
    mode: input.mode ?? 'workspace',
    workspaceRoot: typeof input.workspaceRoot === 'string' ? input.workspaceRoot : '',
    persistentRules: Array.isArray(input.persistentRules) ? input.persistentRules : [],
    temporaryGrants: Array.isArray(input.temporaryGrants) ? input.temporaryGrants : [],
  };
}

export function normalizeAccessRule(rule: AccessRule): AccessRule {
  return {
    ...rule,
    reason: rule.reason?.trim() || undefined,
    target: normalizeAccessTarget(rule.target),
  };
}

export function normalizeAccessTarget(target: AccessTarget): AccessTarget {
  if (target.kind === 'path') {
    return { kind: 'path', path: target.path?.trim() ?? '' };
  }
  if (target.kind === 'command') {
    return { kind: 'command', command: target.command?.trim() ?? '' };
  }
  if (target.kind === 'network') {
    return { kind: 'network', host: target.host?.trim().toLowerCase() ?? '' };
  }
  return { kind: 'tool', toolName: target.toolName?.trim() ?? '' };
}

export function redactAccessPolicyForPublicConfig(config: AccessPolicyConfig): AccessPolicyConfig {
  return {
    ...normalizeAccessPolicyConfig(config),
    temporaryGrants: [],
  };
}
```

- [ ] **Step 4: 新增 Zod schema**

在 `packages/protocol/src/accessPolicySchemas.ts` 写入：

```ts
import { z } from 'zod';

export const accessModeSchema = z.enum(['chat', 'workspace', 'danger_full_access']);
export const accessKindSchema = z.enum(['read', 'write', 'command', 'network', 'tool_call']);
export const accessEffectSchema = z.enum(['allow', 'deny']);
export const accessRuleScopeSchema = z.enum(['global', 'thread']);
export const temporaryAccessScopeSchema = z.enum(['tool_call', 'turn', 'session']);

export const accessTargetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('path'), path: z.string().trim().min(1) }).strict(),
  z.object({ kind: z.literal('command'), command: z.string().trim().min(1) }).strict(),
  z.object({ kind: z.literal('network'), host: z.string().trim().min(1) }).strict(),
  z.object({ kind: z.literal('tool'), toolName: z.string().trim().min(1) }).strict(),
]);

export const accessRuleSchema = z.object({
  id: z.string().trim().min(1),
  effect: accessEffectSchema,
  access: accessKindSchema,
  target: accessTargetSchema,
  scope: accessRuleScopeSchema,
  reason: z.string().trim().optional(),
  createdAt: z.string().datetime().optional(),
  updatedAt: z.string().datetime().optional(),
}).strict();

export const temporaryAccessGrantSchema = z.object({
  id: z.string().trim().min(1),
  effect: accessEffectSchema,
  access: accessKindSchema,
  target: accessTargetSchema,
  scope: temporaryAccessScopeSchema,
  threadId: z.string().trim().optional(),
  turnId: z.string().trim().optional(),
  toolCallId: z.string().trim().optional(),
  createdAt: z.string().datetime(),
  expiresAt: z.string().datetime().optional(),
}).strict();

export const accessRequestSchema = z.object({
  access: accessKindSchema,
  target: accessTargetSchema,
  threadId: z.string().trim().min(1),
  turnId: z.string().trim().min(1),
  toolName: z.string().trim().optional(),
  toolCallId: z.string().trim().optional(),
  agentThreadId: z.string().trim().optional(),
  agentRole: z.string().nullable().optional(),
  description: z.string().trim().min(1),
}).strict();

export const accessDecisionSchema = z.object({
  decision: z.enum(['allow', 'prompt', 'deny']),
  request: accessRequestSchema,
  source: z.enum([
    'hard_deny',
    'persistent_rule',
    'workspace_default',
    'temporary_grant',
    'approval_required',
    'default_deny',
  ]),
  matchedRuleId: z.string().optional(),
  matchedRuleScope: z.union([accessRuleScopeSchema, temporaryAccessScopeSchema]).optional(),
  justification: z.string(),
}).strict();

export const accessPolicyConfigSchema = z.object({
  mode: accessModeSchema.default('workspace'),
  workspaceRoot: z.string().default(''),
  persistentRules: z.array(accessRuleSchema).default([]),
  temporaryGrants: z.array(temporaryAccessGrantSchema).default([]),
}).strict();
```

- [ ] **Step 5: 接入导出与 run config**

在 `packages/protocol/src/index.ts` 添加：

```ts
export * from './accessPolicy.js';
export * from './accessPolicySchemas.js';
```

在 `packages/protocol/src/runConfig.ts`：

```ts
import type { AccessPolicyConfig } from './accessPolicy.js';
import { accessPolicyConfigSchema } from './accessPolicySchemas.js';
```

把 `ThreadRunConfigOverrides` 扩展为：

```ts
export interface ThreadRunConfigOverrides {
  workspaceRoot?: string;
  provider?: string;
  model?: string;
  baseUrl?: string;
  permissions?: PermissionPresetId;
  accessPolicy?: AccessPolicyConfig;
  webSearchMode?: WebSearchMode;
  reasoningEffort?: ReasoningEffort;
  runProfile?: RunProfile;
}
```

把 `THREAD_RUN_CONFIG_KEYS` 改为：

```ts
export const THREAD_RUN_CONFIG_KEYS = [
  'workspaceRoot',
  'provider',
  'model',
  'baseUrl',
  'permissions',
  'accessPolicy',
  'webSearchMode',
  'reasoningEffort',
  'runProfile',
] as const;
```

在 `GlobalRunConfigDefaultsSchema` 内加入：

```ts
accessPolicy: accessPolicyConfigSchema.default({}),
```

- [ ] **Step 6: 扩展审批事件协议**

在 `packages/protocol/src/types.ts` 的 `ApprovalRequiredEvent` 和 `ApprovalRequest` 中加入：

```ts
accessRequest?: AccessRequest;
temporaryGrantOptions?: Array<{
  scope: TemporaryAccessScope;
  label: string;
}>;
matchedRule?: {
  id: string;
  scope: AccessRuleScope | TemporaryAccessScope;
  effect: AccessEffect;
};
```

同文件顶部补充：

```ts
import type {
  AccessEffect,
  AccessRequest,
  AccessRuleScope,
  TemporaryAccessScope,
} from './accessPolicy.js';
```

在 `packages/protocol/src/schemas.ts` 的 `approvalRequiredEventSchema` 加入等价 schema 字段，字段允许缺省，保证旧事件回放能被解析。

- [ ] **Step 7: 运行协议测试**

Run:

```bash
npx vitest run packages/protocol/src/accessPolicySchemas.test.ts packages/protocol/src/runConfig.test.ts packages/protocol/src/schemas.test.ts
```

Expected:

```text
PASS packages/protocol/src/accessPolicySchemas.test.ts
PASS packages/protocol/src/runConfig.test.ts
PASS packages/protocol/src/schemas.test.ts
```

- [ ] **Step 8: Commit**

```bash
git add packages/protocol/src/accessPolicy.ts packages/protocol/src/accessPolicySchemas.ts packages/protocol/src/accessPolicySchemas.test.ts packages/protocol/src/index.ts packages/protocol/src/runConfig.ts packages/protocol/src/schemas.ts packages/protocol/src/types.ts
git commit -m "feat(protocol): add access policy contract"
```

## Task 2: 修正沙箱路径边界

**Files:**
- Modify: `packages/sandbox/src/sandbox.ts`
- Modify: `packages/sandbox/src/sandbox.test.ts`

- [ ] **Step 1: 写失败测试**

在 `packages/sandbox/src/sandbox.test.ts` 增加：

```ts
it('does not treat sibling directories as inside workspace', () => {
  const sandbox = new Sandbox({
    workspaceRoot: 'E:\\langchain\\Suanlizi',
    level: 'workspace_write',
  });

  expect(sandbox.canRead('E:\\langchain\\Suanlizi\\README.md')).toBe(true);
  expect(sandbox.canRead('E:\\langchain\\Suanlizi2\\README.md')).toBe(false);
  expect(sandbox.canWrite('E:\\langchain\\Suanlizi2\\README.md')).toBe(false);
});

it('allows explicit additional read and write roots with path-aware matching', () => {
  const sandbox = new Sandbox({
    workspaceRoot: 'E:\\langchain\\Suanlizi',
    level: 'workspace_write',
    allowedReadPaths: ['E:\\langchain\\dexin-agent'],
    allowedWritePaths: ['E:\\langchain\\generated'],
  });

  expect(sandbox.canRead('E:\\langchain\\dexin-agent\\v1.docx')).toBe(true);
  expect(sandbox.canRead('E:\\langchain\\dexin-agent-old\\v1.docx')).toBe(false);
  expect(sandbox.canWrite('E:\\langchain\\generated\\out.txt')).toBe(true);
  expect(sandbox.canWrite('E:\\langchain\\generated-old\\out.txt')).toBe(false);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run:

```bash
npx vitest run packages/sandbox/src/sandbox.test.ts
```

Expected:

```text
FAIL packages/sandbox/src/sandbox.test.ts
expected true to be false
```

- [ ] **Step 3: 实现 path-aware containment**

在 `packages/sandbox/src/sandbox.ts` 顶部添加：

```ts
import * as path from 'node:path';
```

在文件底部添加：

```ts
function isPathInsideOrEqual(root: string, candidate: string): boolean {
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(candidate);
  if (process.platform === 'win32') {
    const rootLower = resolvedRoot.toLowerCase();
    const candidateLower = resolvedCandidate.toLowerCase();
    if (candidateLower === rootLower) return true;
    const relative = path.relative(rootLower, candidateLower);
    return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
  }
  if (resolvedCandidate === resolvedRoot) return true;
  const relative = path.relative(resolvedRoot, resolvedCandidate);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}
```

把 `canRead()` 改为：

```ts
canRead(absPath: string): boolean {
  if (this.effective.level === 'full') return true;
  if (isPathInsideOrEqual(this.config.workspaceRoot, absPath)) return true;
  if (this.config.allowedReadPaths?.some((p) => isPathInsideOrEqual(p, absPath))) return true;
  return false;
}
```

把 `canWrite()` 改为：

```ts
canWrite(absPath: string): boolean {
  if (this.effective.level === 'full') return true;
  if (this.effective.level === 'readonly') return false;
  if (isPathInsideOrEqual(this.config.workspaceRoot, absPath)) return true;
  if (this.config.allowedWritePaths?.some((p) => isPathInsideOrEqual(p, absPath))) return true;
  return false;
}
```

- [ ] **Step 4: 运行沙箱测试**

Run:

```bash
npx vitest run packages/sandbox/src/sandbox.test.ts
```

Expected:

```text
PASS packages/sandbox/src/sandbox.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add packages/sandbox/src/sandbox.ts packages/sandbox/src/sandbox.test.ts
git commit -m "fix(sandbox): use path-aware workspace boundaries"
```

## Task 3: 运行时 access policy evaluator

**Files:**
- Create: `packages/runtime/src/accessPolicy.ts`
- Create: `packages/runtime/src/accessPolicy.test.ts`
- Modify: `packages/runtime/src/index.ts`

- [ ] **Step 1: 写失败测试**

在 `packages/runtime/src/accessPolicy.test.ts` 写入：

```ts
import { describe, expect, it } from 'vitest';
import type { AccessPolicyConfig, AccessRequest } from '@suanlizi/protocol';
import { evaluateAccessRequest } from './accessPolicy.js';

const baseRequest: AccessRequest = {
  access: 'read',
  target: { kind: 'path', path: 'E:\\langchain\\Suanlizi\\README.md' },
  threadId: 'thread-1',
  turnId: 'turn-1',
  toolName: 'read_file',
  toolCallId: 'call-1',
  description: 'read README',
};

describe('evaluateAccessRequest', () => {
  it('allows workspace reads and writes in workspace mode', () => {
    const policy: AccessPolicyConfig = {
      mode: 'workspace',
      workspaceRoot: 'E:\\langchain\\Suanlizi',
      persistentRules: [],
      temporaryGrants: [],
    };

    expect(evaluateAccessRequest(policy, baseRequest).decision).toBe('allow');
    expect(evaluateAccessRequest(policy, { ...baseRequest, access: 'write' }).decision).toBe('allow');
  });

  it('prompts for external paths in workspace mode', () => {
    const policy: AccessPolicyConfig = {
      mode: 'workspace',
      workspaceRoot: 'E:\\langchain\\Suanlizi',
      persistentRules: [],
      temporaryGrants: [],
    };

    const decision = evaluateAccessRequest(policy, {
      ...baseRequest,
      target: { kind: 'path', path: 'E:\\langchain\\dexin-agent\\v1.docx' },
    });

    expect(decision.decision).toBe('prompt');
    expect(decision.source).toBe('approval_required');
  });

  it('denies when a persistent deny matches even if temporary allow exists', () => {
    const policy: AccessPolicyConfig = {
      mode: 'workspace',
      workspaceRoot: 'E:\\langchain\\Suanlizi',
      persistentRules: [
        {
          id: 'deny-docs',
          effect: 'deny',
          access: 'read',
          target: { kind: 'path', path: 'E:\\langchain\\dexin-agent' },
          scope: 'global',
        },
      ],
      temporaryGrants: [
        {
          id: 'allow-docs-once',
          effect: 'allow',
          access: 'read',
          target: { kind: 'path', path: 'E:\\langchain\\dexin-agent' },
          scope: 'turn',
          threadId: 'thread-1',
          turnId: 'turn-1',
          createdAt: '2026-07-27T00:00:00.000Z',
        },
      ],
    };

    const decision = evaluateAccessRequest(policy, {
      ...baseRequest,
      target: { kind: 'path', path: 'E:\\langchain\\dexin-agent\\v1.docx' },
    });

    expect(decision.decision).toBe('deny');
    expect(decision.matchedRuleId).toBe('deny-docs');
  });

  it('allows matching temporary grant for the same turn', () => {
    const policy: AccessPolicyConfig = {
      mode: 'chat',
      workspaceRoot: 'E:\\langchain\\Suanlizi\\.suanlizi\\chat-workspace',
      persistentRules: [],
      temporaryGrants: [
        {
          id: 'allow-on-turn',
          effect: 'allow',
          access: 'read',
          target: { kind: 'path', path: 'E:\\langchain\\dexin-agent' },
          scope: 'turn',
          threadId: 'thread-1',
          turnId: 'turn-1',
          createdAt: '2026-07-27T00:00:00.000Z',
        },
      ],
    };

    expect(evaluateAccessRequest(policy, {
      ...baseRequest,
      target: { kind: 'path', path: 'E:\\langchain\\dexin-agent\\v1.docx' },
    }).decision).toBe('allow');
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run:

```bash
npx vitest run packages/runtime/src/accessPolicy.test.ts
```

Expected:

```text
FAIL packages/runtime/src/accessPolicy.test.ts
Cannot find module './accessPolicy.js'
```

- [ ] **Step 3: 实现 evaluator**

在 `packages/runtime/src/accessPolicy.ts` 写入：

```ts
import * as path from 'node:path';
import type {
  AccessDecision,
  AccessPolicyConfig,
  AccessRequest,
  AccessRule,
  TemporaryAccessGrant,
} from '@suanlizi/protocol';

export function evaluateAccessRequest(policy: AccessPolicyConfig, request: AccessRequest): AccessDecision {
  const hardDeny = hardDenyReason(request);
  if (hardDeny) {
    return decision('deny', request, 'hard_deny', hardDeny);
  }

  const persistentDeny = policy.persistentRules.find((rule) => rule.effect === 'deny' && ruleMatches(rule, request));
  if (persistentDeny) {
    return decision('deny', request, 'persistent_rule', persistentDeny.reason ?? '命中持久拒绝规则', persistentDeny.id, persistentDeny.scope);
  }

  const persistentAllow = policy.persistentRules.find((rule) => rule.effect === 'allow' && ruleMatches(rule, request));
  if (persistentAllow) {
    return decision('allow', request, 'persistent_rule', persistentAllow.reason ?? '命中持久允许规则', persistentAllow.id, persistentAllow.scope);
  }

  if (workspaceDefaultAllows(policy, request)) {
    return decision('allow', request, 'workspace_default', policy.mode === 'chat' ? '对话隐藏工作区默认允许' : '项目工作区默认允许');
  }

  const tempDeny = policy.temporaryGrants.find((grant) => grant.effect === 'deny' && temporaryGrantMatches(grant, request));
  if (tempDeny) {
    return decision('deny', request, 'temporary_grant', '命中临时拒绝', tempDeny.id, tempDeny.scope);
  }

  const tempAllow = policy.temporaryGrants.find((grant) => grant.effect === 'allow' && temporaryGrantMatches(grant, request));
  if (tempAllow) {
    return decision('allow', request, 'temporary_grant', '命中临时允许', tempAllow.id, tempAllow.scope);
  }

  if (policy.mode === 'danger_full_access') {
    return decision('allow', request, 'workspace_default', '高风险完全访问模式允许');
  }

  return decision('prompt', request, 'approval_required', '需要用户临时授权');
}

export function temporaryGrantMatches(grant: TemporaryAccessGrant, request: AccessRequest): boolean {
  if (grant.access !== request.access) return false;
  if (!targetMatches(grant.target, request.target)) return false;
  if (grant.threadId && grant.threadId !== request.threadId) return false;
  if (grant.scope === 'turn' && grant.turnId !== request.turnId) return false;
  if (grant.scope === 'tool_call' && grant.toolCallId !== request.toolCallId) return false;
  if (grant.expiresAt && Date.parse(grant.expiresAt) <= Date.now()) return false;
  return true;
}

function ruleMatches(rule: AccessRule, request: AccessRequest): boolean {
  return rule.access === request.access && targetMatches(rule.target, request.target);
}

function targetMatches(ruleTarget: AccessRule['target'], requestTarget: AccessRequest['target']): boolean {
  if (ruleTarget.kind !== requestTarget.kind) return false;
  if (ruleTarget.kind === 'path') {
    return Boolean(ruleTarget.path && requestTarget.path && isPathInsideOrEqual(ruleTarget.path, requestTarget.path));
  }
  if (ruleTarget.kind === 'command') {
    return Boolean(ruleTarget.command && requestTarget.command?.startsWith(ruleTarget.command));
  }
  if (ruleTarget.kind === 'network') {
    return Boolean(ruleTarget.host && requestTarget.host && hostMatches(requestTarget.host, ruleTarget.host));
  }
  return ruleTarget.toolName === requestTarget.toolName;
}

function workspaceDefaultAllows(policy: AccessPolicyConfig, request: AccessRequest): boolean {
  if (request.target.kind !== 'path') return false;
  if (request.access !== 'read' && request.access !== 'write') return false;
  if (!request.target.path || !policy.workspaceRoot) return false;
  if (!isPathInsideOrEqual(policy.workspaceRoot, request.target.path)) return false;
  if (policy.mode === 'chat') return request.access === 'read';
  if (policy.mode === 'workspace') return true;
  return policy.mode === 'danger_full_access';
}

function hardDenyReason(request: AccessRequest): string | null {
  if (request.target.kind === 'path' && request.target.path) {
    const parsed = path.parse(path.resolve(request.target.path));
    if (path.resolve(request.target.path) === parsed.root && request.access === 'write') {
      return '拒绝写入磁盘根目录';
    }
  }
  if (request.target.kind === 'command' && request.target.command) {
    const normalized = request.target.command.toLowerCase();
    if (/\brm\s+-rf\s+[/\\]|remove-item\b.*\b-recurse\b/i.test(normalized)) {
      return '拒绝明显破坏性递归删除命令';
    }
  }
  return null;
}

function decision(
  value: AccessDecision['decision'],
  request: AccessRequest,
  source: AccessDecision['source'],
  justification: string,
  matchedRuleId?: string,
  matchedRuleScope?: AccessDecision['matchedRuleScope'],
): AccessDecision {
  return {
    decision: value,
    request,
    source,
    justification,
    matchedRuleId,
    matchedRuleScope,
  };
}

function isPathInsideOrEqual(root: string, candidate: string): boolean {
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(candidate);
  const relative = path.relative(resolvedRoot, resolvedCandidate);
  return relative === '' || (relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative));
}

function hostMatches(host: string, pattern: string): boolean {
  const normalizedHost = host.toLowerCase();
  const normalizedPattern = pattern.toLowerCase();
  if (normalizedPattern.startsWith('*.')) {
    const suffix = normalizedPattern.slice(1);
    return normalizedHost.endsWith(suffix) && normalizedHost !== normalizedPattern.slice(2);
  }
  return normalizedHost === normalizedPattern;
}
```

- [ ] **Step 4: 导出 runtime helper**

在 `packages/runtime/src/index.ts` 添加：

```ts
export * from './accessPolicy.js';
```

- [ ] **Step 5: 运行测试**

Run:

```bash
npx vitest run packages/runtime/src/accessPolicy.test.ts
```

Expected:

```text
PASS packages/runtime/src/accessPolicy.test.ts
```

- [ ] **Step 6: Commit**

```bash
git add packages/runtime/src/accessPolicy.ts packages/runtime/src/accessPolicy.test.ts packages/runtime/src/index.ts
git commit -m "feat(runtime): evaluate access policy decisions"
```

## Task 4: 工具路径守卫

**Files:**
- Create: `packages/tools/src/accessGuard.ts`
- Create: `packages/tools/src/accessGuard.test.ts`
- Modify: `packages/tools/src/registry.ts`
- Modify: `packages/tools/src/builtin.ts`
- Modify: `packages/tools/src/builtin.test.ts`
- Modify: `packages/tools/src/index.ts`

- [ ] **Step 1: 写失败测试**

在 `packages/tools/src/accessGuard.test.ts` 写入：

```ts
import { describe, expect, it } from 'vitest';
import { resolveToolPathAccess } from './accessGuard.js';

describe('resolveToolPathAccess', () => {
  it('resolves relative paths inside workspace', () => {
    const request = resolveToolPathAccess({
      workspaceRoot: 'E:\\langchain\\Suanlizi',
      path: 'README.md',
      access: 'read',
      threadId: 'thread-1',
      turnId: 'turn-1',
      toolName: 'read_file',
      description: 'read file',
    });

    expect(request.target).toEqual({ kind: 'path', path: 'E:\\langchain\\Suanlizi\\README.md' });
  });

  it('does not rewrite absolute external paths into the workspace', () => {
    const request = resolveToolPathAccess({
      workspaceRoot: 'E:\\langchain\\Suanlizi',
      path: 'E:\\langchain\\dexin-agent\\v1.docx',
      access: 'read',
      threadId: 'thread-1',
      turnId: 'turn-1',
      toolName: 'read_document',
      description: 'read document',
    });

    expect(request.target).toEqual({ kind: 'path', path: 'E:\\langchain\\dexin-agent\\v1.docx' });
  });

  it('normalizes dot-dot traversal before runtime policy evaluation', () => {
    const request = resolveToolPathAccess({
      workspaceRoot: 'E:\\langchain\\Suanlizi',
      path: '..\\dexin-agent\\v1.docx',
      access: 'read',
      threadId: 'thread-1',
      turnId: 'turn-1',
      toolName: 'read_document',
      description: 'read document',
    });

    expect(request.target).toEqual({ kind: 'path', path: 'E:\\langchain\\dexin-agent\\v1.docx' });
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run:

```bash
npx vitest run packages/tools/src/accessGuard.test.ts
```

Expected:

```text
FAIL packages/tools/src/accessGuard.test.ts
Cannot find module './accessGuard.js'
```

- [ ] **Step 3: 实现工具 guard**

在 `packages/tools/src/accessGuard.ts` 写入：

```ts
import * as path from 'node:path';
import type { AccessDecision, AccessKind, AccessRequest } from '@suanlizi/protocol';
import type { ToolResult } from './registry.js';

export interface ResolveToolPathAccessInput {
  workspaceRoot: string;
  path: string;
  access: Extract<AccessKind, 'read' | 'write'>;
  threadId: string;
  turnId: string;
  toolName: string;
  toolCallId?: string;
  description: string;
}

export function resolveToolPathAccess(input: ResolveToolPathAccessInput): AccessRequest {
  const resolved = path.isAbsolute(input.path)
    ? path.resolve(input.path)
    : path.resolve(input.workspaceRoot, input.path);

  return {
    access: input.access,
    target: { kind: 'path', path: resolved },
    threadId: input.threadId,
    turnId: input.turnId,
    toolName: input.toolName,
    toolCallId: input.toolCallId,
    description: input.description,
  };
}

export function toolResultFromAccessDecision(decision: AccessDecision): ToolResult {
  return {
    output: decision.justification,
    status: 'failed',
    error: {
      message: decision.justification,
      code: decision.decision === 'prompt' ? 'ACCESS_APPROVAL_REQUIRED' : 'ACCESS_DENIED',
    },
    data: {
      accessDecision: decision,
    },
  };
}
```

- [ ] **Step 4: 扩展 ToolContext**

在 `packages/tools/src/registry.ts` 顶部添加：

```ts
import type { AccessDecision, AccessPolicyConfig, AccessRequest } from '@suanlizi/protocol';
```

在 `ToolContext` 中加入：

```ts
/** Runtime access policy snapshot for this turn. */
accessPolicy?: AccessPolicyConfig;
/** Ask runtime whether this tool access is allowed, needs approval, or denied. */
requestAccess?: (request: AccessRequest) => Promise<AccessDecision>;
```

- [ ] **Step 5: 在 built-in 工具中使用 guard**

在 `packages/tools/src/builtin.ts` 顶部加入：

```ts
import { resolveToolPathAccess, toolResultFromAccessDecision } from './accessGuard.js';
```

对 `read_file` 的执行函数，在实际读取前加入：

```ts
const filePath = String(args.path ?? args.filePath ?? '');
const accessRequest = resolveToolPathAccess({
  workspaceRoot: ctx.workspaceRoot,
  path: filePath,
  access: 'read',
  threadId: ctx.threadId,
  turnId: ctx.turnId,
  toolName: 'read_file',
  description: `读取文件 ${filePath}`,
});
const accessDecision = await ctx.requestAccess?.(accessRequest);
if (accessDecision && accessDecision.decision !== 'allow') {
  return toolResultFromAccessDecision(accessDecision);
}
```

对 `read_document` 使用同一结构，`toolName` 改成 `read_document`，`description` 改成 `读取文档 ${filePath}`。

对 `write_file` 使用同一结构，`access` 改成 `write`，`toolName` 改成 `write_file`。

对 `list_files` 使用同一结构，目录参数 `path` 缺省值为 `'.'`。

对 `search_content` 使用同一结构，目录参数 `path` 缺省值为 `'.'`。

对 `apply_patch` 在执行前为每个 patch 文件生成 `write` 请求，只要有一个返回非 allow，就返回 `toolResultFromAccessDecision()`。

对 `shell_command` 在执行前生成 command 请求：

```ts
const command = String(args.command ?? '');
const accessRequest = {
  access: 'command' as const,
  target: { kind: 'command' as const, command },
  threadId: ctx.threadId,
  turnId: ctx.turnId,
  toolName: 'shell_command',
  description: `执行命令 ${command.slice(0, 120)}`,
};
const accessDecision = await ctx.requestAccess?.(accessRequest);
if (accessDecision && accessDecision.decision !== 'allow') {
  return toolResultFromAccessDecision(accessDecision);
}
```

- [ ] **Step 6: 运行工具测试**

Run:

```bash
npx vitest run packages/tools/src/accessGuard.test.ts packages/tools/src/builtin.test.ts packages/tools/src/registry.test.ts
```

Expected:

```text
PASS packages/tools/src/accessGuard.test.ts
PASS packages/tools/src/builtin.test.ts
PASS packages/tools/src/registry.test.ts
```

- [ ] **Step 7: Commit**

```bash
git add packages/tools/src/accessGuard.ts packages/tools/src/accessGuard.test.ts packages/tools/src/registry.ts packages/tools/src/builtin.ts packages/tools/src/builtin.test.ts packages/tools/src/index.ts
git commit -m "feat(tools): route filesystem access through policy guard"
```

## Task 5: runtime 审批只生成临时授权

**Files:**
- Modify: `packages/runtime/src/toolGovernance.ts`
- Modify: `packages/runtime/src/agent.ts`
- Modify: `packages/runtime/src/agent.test.ts`
- Modify: `packages/runtime/src/runTraceProjector.ts`
- Modify: `packages/runtime/src/runTraceProjector.test.ts`

- [ ] **Step 1: 写失败测试**

在 `packages/runtime/src/agent.test.ts` 增加一个测试，构造 mock approval handler：

```ts
it('stores approval results as temporary runtime grants only', async () => {
  const approvals: unknown[] = [];
  const agent = createTestAgent({
    config: {
      workspaceRoot: 'E:\\langchain\\Suanlizi',
      accessPolicy: {
        mode: 'workspace',
        workspaceRoot: 'E:\\langchain\\Suanlizi',
        persistentRules: [],
        temporaryGrants: [],
      },
    },
    approvalHandler: {
      async requestApproval(req) {
        approvals.push(req);
        return { approved: true, reason: 'allow once' };
      },
    },
  });

  await agent.runTurn('thread-1', { type: 'text', text: 'read E:\\langchain\\dexin-agent\\v1.docx' });

  expect(approvals).toHaveLength(1);
  expect(agent.getConfig().accessPolicy.persistentRules).toEqual([]);
});
```

如果当前 test helper 没有 `createTestAgent()` 或 `getConfig()`，在同一测试文件中用现有 agent test 的构造方式创建 AgentLoop，并通过 emitted events 断言 `approval.required` 含 `temporaryGrantOptions`。

- [ ] **Step 2: 运行测试确认失败**

Run:

```bash
npx vitest run packages/runtime/src/agent.test.ts --testNamePattern "temporary runtime grants"
```

Expected:

```text
FAIL packages/runtime/src/agent.test.ts
```

- [ ] **Step 3: 在 runtime context 中注入 requestAccess**

在 `packages/runtime/src/agent.ts` 创建 `ToolContext` 的位置加入：

```ts
requestAccess: async (request) => this.evaluateAndAuditAccessRequest(threadId, turnId, request),
accessPolicy: this.runtimeAccessPolicy,
```

新增私有方法：

```ts
private async evaluateAndAuditAccessRequest(
  threadId: ThreadId,
  turnId: TurnId,
  request: AccessRequest,
): Promise<AccessDecision> {
  const decision = evaluateAccessRequest(this.runtimeAccessPolicy, request);
  await this.appendRunMonitorEvent(turnId, {
    category: 'approval',
    type: 'access.decision',
    level: decision.decision === 'deny' ? 'warning' : 'info',
    message: decision.justification,
    toolName: request.toolName,
    metadata: {
      decision: decision.decision,
      source: decision.source,
      matchedRuleId: decision.matchedRuleId,
      matchedRuleScope: decision.matchedRuleScope,
      access: request.access,
      target: request.target,
      agentThreadId: request.agentThreadId ?? threadId,
      agentRole: request.agentRole ?? null,
    },
  });
  return decision;
}
```

`this.runtimeAccessPolicy` 在 AgentLoop 构造时从 `config.accessPolicy` 创建，不能把审批结果写回 `config.accessPolicy.persistentRules`。

- [ ] **Step 4: 改造 `toolGovernance.ts` 的 prompt 分支**

当 `AccessDecision.decision === 'prompt'` 时，`ApprovalRequest` 必须包含：

```ts
temporaryGrantOptions: [
  { scope: 'tool_call', label: '仅本次工具调用' },
  { scope: 'turn', label: '仅本轮对话' },
  { scope: 'session', label: '仅本次应用会话' },
],
accessRequest: request.accessRequest,
```

审批通过后向 AgentLoop 的 runtime 临时 grants 追加：

```ts
{
  id: `temp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
  effect: 'allow',
  access: accessRequest.access,
  target: accessRequest.target,
  scope: approval.temporaryScope ?? 'tool_call',
  threadId: accessRequest.threadId,
  turnId: accessRequest.turnId,
  toolCallId: accessRequest.toolCallId,
  createdAt: new Date().toISOString(),
}
```

审批拒绝后追加同结构 `effect: 'deny'`。该数组在进程内存或 AgentLoop 实例内存在，不写 SQLite settings。

- [ ] **Step 5: 监控 projector 增加 access.decision**

在 `packages/runtime/src/runTraceProjector.ts` 对 `RunEvent.type === 'access.decision'` 输出 category `approval`，payload 保留：

```ts
{
  decision,
  source,
  access,
  target,
  matchedRuleId,
  matchedRuleScope,
  agentThreadId,
  agentRole,
}
```

- [ ] **Step 6: 运行 runtime 测试**

Run:

```bash
npx vitest run packages/runtime/src/agent.test.ts packages/runtime/src/runTraceProjector.test.ts packages/runtime/src/toolGovernance.test.ts
```

Expected:

```text
PASS packages/runtime/src/agent.test.ts
PASS packages/runtime/src/runTraceProjector.test.ts
PASS packages/runtime/src/toolGovernance.test.ts
```

- [ ] **Step 7: Commit**

```bash
git add packages/runtime/src/toolGovernance.ts packages/runtime/src/agent.ts packages/runtime/src/agent.test.ts packages/runtime/src/runTraceProjector.ts packages/runtime/src/runTraceProjector.test.ts
git commit -m "feat(runtime): keep approvals temporary and auditable"
```

## Task 6: API 配置与持久规则存储

**Files:**
- Modify: `apps/api/src/config/config.ts`
- Modify: `apps/api/src/config/config.test.ts`
- Modify: `apps/api/src/routes/settingsRoute.ts`
- Modify: `apps/api/src/routes/threadRoutes.ts`
- Create: `apps/api/src/routes/accessPolicyRoute.test.ts`

- [ ] **Step 1: 写配置测试**

在 `apps/api/src/config/config.test.ts` 增加：

```ts
it('normalizes access policy from workspace defaults', () => {
  const config = resolveConfig({
    workspaceRoot: 'E:\\langchain\\Suanlizi',
  });

  expect(config.accessPolicy).toMatchObject({
    mode: 'workspace',
    workspaceRoot: 'E:\\langchain\\Suanlizi',
    persistentRules: [],
    temporaryGrants: [],
  });
});

it('maps legacy read_only permissions to chat-like read policy without writing legacy permissions as source of truth', () => {
  const config = resolveConfig({
    permissions: 'read_only',
    workspaceRoot: 'E:\\langchain\\Suanlizi',
  });

  expect(config.accessPolicy.mode).toBe('chat');
  expect(config.permissions).toBe('read_only');
});

it('public config removes temporary grants', () => {
  const config = resolveConfig({
    accessPolicy: {
      mode: 'workspace',
      workspaceRoot: 'E:\\langchain\\Suanlizi',
      persistentRules: [],
      temporaryGrants: [
        {
          id: 'temp-1',
          effect: 'allow',
          access: 'read',
          target: { kind: 'path', path: 'E:\\secret' },
          scope: 'session',
          createdAt: '2026-07-27T00:00:00.000Z',
        },
      ],
    },
  });

  expect(publicRunConfig(config).accessPolicy.temporaryGrants).toEqual([]);
});
```

- [ ] **Step 2: 运行配置测试确认失败**

Run:

```bash
npx vitest run apps/api/src/config/config.test.ts
```

Expected:

```text
FAIL apps/api/src/config/config.test.ts
Property 'accessPolicy' does not exist
```

- [ ] **Step 3: 扩展 AgentRunConfig**

在 `apps/api/src/config/config.ts` import 中加入：

```ts
  normalizeAccessPolicyConfig,
  redactAccessPolicyForPublicConfig,
  type AccessPolicyConfig,
```

在 `AgentRunConfig` 中加入：

```ts
accessPolicy: AccessPolicyConfig;
```

在 `defaultConfig` 中加入：

```ts
accessPolicy: {
  mode: 'workspace',
  workspaceRoot: process.cwd(),
  persistentRules: [],
  temporaryGrants: [],
},
```

在 `resolveConfig()` 中，在 `workspaceRoot` 归一化之后加入：

```ts
const inputPolicy = normalizeAccessPolicyConfig(merged.accessPolicy);
const modeFromPermissions = merged.permissions === 'danger_full_access'
  ? 'danger_full_access'
  : merged.permissions === 'read_only'
    ? 'chat'
    : inputPolicy.mode;
merged.accessPolicy = normalizeAccessPolicyConfig({
  ...inputPolicy,
  mode: modeFromPermissions,
  workspaceRoot: inputPolicy.workspaceRoot || merged.workspaceRoot,
  temporaryGrants: [],
});
```

`temporaryGrants` 运行时专用，配置读取时清空。

- [ ] **Step 4: publicRunConfig 脱敏**

把 `publicRunConfig()` 改成：

```ts
export function publicRunConfig(config: AgentRunConfig): AgentRunConfig {
  const { apiKey: _apiKey, ...publicConfig } = config;
  return {
    ...publicConfig,
    accessPolicy: redactAccessPolicyForPublicConfig(config.accessPolicy),
  };
}
```

- [ ] **Step 5: repository 增加 access policy 方法**

在 `createConfigRepository()` 中新增 storage key：

```ts
export const ACCESS_POLICY_KEY = 'accessPolicy.v1';
export const THREAD_ACCESS_POLICY_KEY_PREFIX = 'thread-access-policy:';
```

新增函数：

```ts
async function getGlobalAccessPolicy(): Promise<AccessPolicyConfig> {
  const config = await getDefaultRunConfig();
  return normalizeAccessPolicyConfig(config.accessPolicy);
}

async function saveGlobalAccessPolicy(input: unknown): Promise<AccessPolicyConfig> {
  const current = await getDefaultRunConfig();
  const nextPolicy = normalizeAccessPolicyConfig(input as Partial<AccessPolicyConfig>);
  const next = await saveDefaultRunConfig({ ...current, accessPolicy: nextPolicy });
  return next.accessPolicy;
}

function threadAccessPolicyKey(threadId: string): string {
  return `${THREAD_ACCESS_POLICY_KEY_PREFIX}${threadId}`;
}

async function getThreadAccessPolicy(threadId: string): Promise<AccessPolicyConfig | null> {
  const stored = await store.getSetting<Partial<AccessPolicyConfig>>(threadAccessPolicyKey(threadId));
  return stored ? normalizeAccessPolicyConfig(stored) : null;
}

async function saveThreadAccessPolicy(threadId: string, input: unknown): Promise<AccessPolicyConfig> {
  const safe = normalizeAccessPolicyConfig(input as Partial<AccessPolicyConfig>);
  await store.setSetting(threadAccessPolicyKey(threadId), safe);
  return safe;
}
```

把这些函数加入 return object。

- [ ] **Step 6: routes 接入**

在 `apps/api/src/routes/settingsRoute.ts` 增加：

```ts
if (req.method === 'PATCH' && pathname === '/api/settings/access-policy') {
  const body = await readJson<{ accessPolicy?: unknown }>(req);
  const accessPolicy = await ctx.saveGlobalAccessPolicy(body.accessPolicy ?? {});
  sendJson(res, 200, { accessPolicy: redactAccessPolicyForPublicConfig(accessPolicy) });
  return true;
}
```

在 `apps/api/src/routes/threadRoutes.ts` 的 config PATCH 处理里，保留现有 `overrides`，并接受：

```ts
const accessPolicy = body.accessPolicy
  ? await ctx.saveThreadAccessPolicy(threadId, body.accessPolicy)
  : undefined;
sendJson(res, 200, { overrides, accessPolicy });
```

- [ ] **Step 7: 运行 API 测试**

Run:

```bash
npx vitest run apps/api/src/config/config.test.ts apps/api/src/routes/accessPolicyRoute.test.ts apps/api/src/routes/threadMetadata.test.ts
```

Expected:

```text
PASS apps/api/src/config/config.test.ts
PASS apps/api/src/routes/accessPolicyRoute.test.ts
PASS apps/api/src/routes/threadMetadata.test.ts
```

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/config/config.ts apps/api/src/config/config.test.ts apps/api/src/routes/settingsRoute.ts apps/api/src/routes/threadRoutes.ts apps/api/src/routes/accessPolicyRoute.test.ts
git commit -m "feat(api): persist access policy rules"
```

## Task 7: 设置页“权限与工作区”

**Files:**
- Create: `apps/web/src/components/settings/AccessPolicyPage.tsx`
- Create: `apps/desktop/src/components/settings/AccessPolicyPage.tsx`
- Modify: `apps/web/src/components/settings/SettingsShell.tsx`
- Modify: `apps/desktop/src/components/settings/SettingsShell.tsx`
- Modify: `apps/web/src/components/settings/settingsShell.test.tsx`
- Modify: `apps/desktop/src/components/settings/settingsShell.test.tsx`
- Modify: `apps/web/src/shared/i18n.ts`
- Modify: `apps/desktop/src/shared/i18n.ts`
- Modify: `apps/web/src/styles.css`
- Modify: `apps/desktop/src/styles.css`

- [ ] **Step 1: 写设置页测试**

在 `apps/web/src/components/settings/settingsShell.test.tsx` 增加：

```tsx
it('renders access policy page and saves persistent thread rules', async () => {
  renderSettingsShell({
    locale: 'zh',
    initialPage: 'accessPolicy',
    activeThreadId: 'thread-1',
  });

  expect(screen.getByText('权限与工作区')).toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: '新增目录规则' }));
  await userEvent.type(screen.getByLabelText('路径'), 'E:\\langchain\\dexin-agent');
  await userEvent.click(screen.getByLabelText('读取'));
  await userEvent.click(screen.getByRole('button', { name: '保存到当前线程' }));

  expect(fetchMock).toHaveBeenCalledWith('/api/threads/thread-1/config', expect.objectContaining({
    method: 'PATCH',
  }));
});
```

在 `apps/desktop/src/components/settings/settingsShell.test.tsx` 写同一断言。

- [ ] **Step 2: 运行测试确认失败**

Run:

```bash
npx vitest run apps/web/src/components/settings/settingsShell.test.tsx apps/desktop/src/components/settings/settingsShell.test.tsx --testNamePattern "access policy"
```

Expected:

```text
FAIL
Unable to find text: 权限与工作区
```

- [ ] **Step 3: 新增 AccessPolicyPage 组件**

在 `apps/web/src/components/settings/AccessPolicyPage.tsx` 写入：

```tsx
import type { AccessPolicyConfig, AccessRule } from '@suanlizi/protocol';

export interface AccessPolicyPageProps {
  locale: 'zh' | 'en';
  value: AccessPolicyConfig;
  scope: 'global' | 'currentThread';
  workspaceRoot: string;
  onChange: (value: AccessPolicyConfig) => void;
  onSave: () => void;
}

export function AccessPolicyPage({ value, scope, workspaceRoot, onChange, onSave }: AccessPolicyPageProps) {
  const addPathRule = () => {
    const now = new Date().toISOString();
    const nextRule: AccessRule = {
      id: `rule_${Date.now()}`,
      effect: 'allow',
      access: 'read',
      target: { kind: 'path', path: '' },
      scope,
      createdAt: now,
      updatedAt: now,
    };
    onChange({ ...value, persistentRules: [...value.persistentRules, nextRule] });
  };

  return (
    <section className="settingsPage settingsAccessPolicyPage">
      <header className="settingsPageHeader">
        <div>
          <h2>权限与工作区</h2>
          <p>设置里的规则会持久保存；运行时审批只临时生效。</p>
        </div>
        <button className="solidButton" type="button" onClick={onSave}>
          {scope === 'global' ? '保存为全局规则' : '保存到当前线程'}
        </button>
      </header>

      <div className="settingsCard settingsCardCompact">
        <div className="settingsFieldRow">
          <label>当前模式</label>
          <span>{value.mode === 'chat' ? '对话模式' : value.mode === 'workspace' ? '工作区模式' : '高风险完全访问'}</span>
        </div>
        <div className="settingsFieldRow">
          <label>工作区</label>
          <code title={workspaceRoot}>{workspaceRoot || '隐藏对话工作区'}</code>
        </div>
      </div>

      <div className="settingsCard settingsCardCompact">
        <div className="settingsSectionTitleRow">
          <h3>持久规则</h3>
          <button className="ghostButton" type="button" onClick={addPathRule}>新增目录规则</button>
        </div>
        {value.persistentRules.length === 0 ? (
          <p className="settingsMuted">没有额外持久规则。工作区内按当前模式默认处理，外部目录会在运行时询问。</p>
        ) : (
          <div className="accessRuleList">
            {value.persistentRules.map((rule) => (
              <article className="accessRuleRow" key={rule.id}>
                <select
                  aria-label="效果"
                  value={rule.effect}
                  onChange={(event) => onChange({
                    ...value,
                    persistentRules: value.persistentRules.map((item) => item.id === rule.id ? { ...item, effect: event.target.value as AccessRule['effect'] } : item),
                  })}
                >
                  <option value="allow">允许</option>
                  <option value="deny">禁止</option>
                </select>
                <select
                  aria-label="权限"
                  value={rule.access}
                  onChange={(event) => onChange({
                    ...value,
                    persistentRules: value.persistentRules.map((item) => item.id === rule.id ? { ...item, access: event.target.value as AccessRule['access'] } : item),
                  })}
                >
                  <option value="read">读取</option>
                  <option value="write">改写</option>
                  <option value="command">命令</option>
                  <option value="network">网络</option>
                </select>
                <input
                  aria-label="路径"
                  value={rule.target.path ?? ''}
                  onChange={(event) => onChange({
                    ...value,
                    persistentRules: value.persistentRules.map((item) => item.id === rule.id ? { ...item, target: { kind: 'path', path: event.target.value } } : item),
                  })}
                  placeholder="E:\\langchain\\dexin-agent"
                />
              </article>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
```

复制到 `apps/desktop/src/components/settings/AccessPolicyPage.tsx`，路径与 import 保持一致。

- [ ] **Step 4: SettingsShell 接入导航**

在 web 和 desktop 的 `SettingsShell.tsx` 中：

```ts
import { AccessPolicyPage } from './AccessPolicyPage.js';
```

把页面 key union 增加：

```ts
type SettingsPageKey = 'appearance' | 'models' | 'accessPolicy' | 'agents' | 'tools' | 'mcp' | 'monitor' | 'memory' | 'about';
```

导航数组增加：

```ts
{ key: 'accessPolicy', label: '权限与工作区' },
```

页面渲染处增加：

```tsx
{activePage === 'accessPolicy' ? (
  <AccessPolicyPage
    locale={locale}
    value={accessPolicyDraft}
    scope={scope === 'currentThread' ? 'currentThread' : 'global'}
    workspaceRoot={modelConfigDraft.workspaceRoot}
    onChange={setAccessPolicyDraft}
    onSave={() => void saveAccessPolicyDraft()}
  />
) : null}
```

- [ ] **Step 5: CSS 低噪声样式**

在 web 与 desktop 的 `styles.css` 添加：

```css
.settingsAccessPolicyPage {
  gap: 14px;
}

.settingsCardCompact {
  padding: 16px;
}

.settingsFieldRow {
  display: grid;
  grid-template-columns: 112px minmax(0, 1fr);
  gap: 12px;
  align-items: center;
  min-height: 34px;
}

.settingsFieldRow label,
.settingsMuted {
  color: #475569;
  font-size: 13px;
  font-weight: 500;
}

.settingsFieldRow code {
  color: #0f172a;
  font-size: 13px;
  word-break: break-all;
}

.accessRuleList {
  display: grid;
  gap: 10px;
}

.accessRuleRow {
  display: grid;
  grid-template-columns: 92px 92px minmax(220px, 1fr);
  gap: 10px;
  align-items: center;
}

.accessRuleRow input,
.accessRuleRow select {
  min-height: 34px;
  border: 1px solid #cbd5e1;
  border-radius: 10px;
  background: #fff;
  color: #0f172a;
  font-size: 13px;
}
```

- [ ] **Step 6: 运行设置测试**

Run:

```bash
npx vitest run apps/web/src/components/settings/settingsShell.test.tsx apps/desktop/src/components/settings/settingsShell.test.tsx
```

Expected:

```text
PASS apps/web/src/components/settings/settingsShell.test.tsx
PASS apps/desktop/src/components/settings/settingsShell.test.tsx
```

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/components/settings/AccessPolicyPage.tsx apps/desktop/src/components/settings/AccessPolicyPage.tsx apps/web/src/components/settings/SettingsShell.tsx apps/desktop/src/components/settings/SettingsShell.tsx apps/web/src/components/settings/settingsShell.test.tsx apps/desktop/src/components/settings/settingsShell.test.tsx apps/web/src/shared/i18n.ts apps/desktop/src/shared/i18n.ts apps/web/src/styles.css apps/desktop/src/styles.css
git commit -m "feat(settings): add persistent access policy page"
```

## Task 8: 审批面板临时授权 UI

**Files:**
- Create: `apps/web/src/components/ApprovalPanel.tsx`
- Create: `apps/desktop/src/components/ApprovalPanel.tsx`
- Modify: `apps/web/src/main.tsx`
- Modify: `apps/desktop/src/main.tsx`
- Modify: `apps/web/src/styles.css`
- Modify: `apps/desktop/src/styles.css`

- [ ] **Step 1: 写审批 UI 测试**

在 `apps/web/src/components/ApprovalPanel.test.tsx` 新建：

```tsx
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ApprovalPanel } from './ApprovalPanel.js';

describe('ApprovalPanel', () => {
  it('submits temporary tool-call approval without persistent options', async () => {
    const onDecision = vi.fn();
    render(
      <ApprovalPanel
        approvals={[{
          requestId: 'approval-1',
          threadId: 'thread-1',
          turnId: 'turn-1',
          itemId: 'item-1',
          kind: 'file_write',
          description: '读取外部文档',
          payload: {},
          decision: 'prompt',
          temporaryGrantOptions: [
            { scope: 'tool_call', label: '仅本次工具调用' },
            { scope: 'turn', label: '仅本轮对话' },
          ],
        }]}
        onDecision={onDecision}
      />,
    );

    expect(screen.getByText('临时授权')).toBeInTheDocument();
    expect(screen.queryByText('永久允许')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '允许' }));
    expect(onDecision).toHaveBeenCalledWith('approval-1', true, 'tool_call');
  });
});
```

在 desktop 侧复制同名测试。

- [ ] **Step 2: 运行测试确认失败**

Run:

```bash
npx vitest run apps/web/src/components/ApprovalPanel.test.tsx apps/desktop/src/components/ApprovalPanel.test.tsx
```

Expected:

```text
FAIL
Cannot find module './ApprovalPanel.js'
```

- [ ] **Step 3: 实现 ApprovalPanel**

在 `apps/web/src/components/ApprovalPanel.tsx` 写入：

```tsx
import type { ApprovalRequest, TemporaryAccessScope } from '../shared/types.js';
import { ApprovalDiffPreview } from './ApprovalDiffPreview.js';

export interface ApprovalPanelProps {
  approvals: ApprovalRequest[];
  onDecision: (requestId: string, approved: boolean, temporaryScope: TemporaryAccessScope) => void;
}

export function ApprovalPanel({ approvals, onDecision }: ApprovalPanelProps) {
  if (approvals.length === 0) return null;

  return (
    <section className="approvalPanel approvalPanelFloating" aria-label="需要临时授权">
      {approvals.map((approval) => {
        const defaultScope = approval.temporaryGrantOptions?.[0]?.scope ?? 'tool_call';
        return (
          <article className="approvalItem approvalItemPanel" key={approval.requestId}>
            <header>
              <strong>临时授权</strong>
              <span>{approval.description}</span>
            </header>
            <p className="approvalScopeHint">本面板只影响当前运行；持久允许或禁止请到“设置 → 权限与工作区”。</p>
            {approval.kind === 'file_write' ? (
              <div className="approvalItemDiff">
                <ApprovalDiffPreview payload={approval.payload} locale="zh" />
              </div>
            ) : null}
            <footer>
              <button className="whiteButton" type="button" onClick={() => onDecision(approval.requestId, false, defaultScope)}>
                拒绝
              </button>
              <button className="solidButton" type="button" onClick={() => onDecision(approval.requestId, true, defaultScope)}>
                允许
              </button>
            </footer>
          </article>
        );
      })}
    </section>
  );
}
```

复制到 desktop 侧。

- [ ] **Step 4: main.tsx 接入**

在 web 与 desktop `main.tsx` 中：

```ts
import { ApprovalPanel } from './components/ApprovalPanel.js';
```

把 `decideApproval` 签名改为：

```ts
async function decideApproval(requestId: string, approved: boolean, temporaryScope: TemporaryAccessScope = 'tool_call') {
```

body 改为：

```ts
body: JSON.stringify({
  approved,
  temporaryScope,
}),
```

把原内联 approval panel JSX 替换为：

```tsx
<ApprovalPanel approvals={pendingApprovals} onDecision={decideApproval} />
```

- [ ] **Step 5: CSS 面板化**

在 web 与 desktop `styles.css` 添加：

```css
.approvalPanelFloating {
  position: fixed;
  right: 24px;
  bottom: 24px;
  z-index: 70;
  width: min(520px, calc(100vw - 48px));
  display: grid;
  gap: 12px;
}

.approvalItemPanel {
  border: 1px solid #dbe4f0;
  border-radius: 18px;
  background: #fff;
  box-shadow: 0 20px 60px rgba(15, 23, 42, 0.16);
  padding: 16px;
}

.approvalItemPanel header {
  display: grid;
  gap: 4px;
}

.approvalItemPanel header strong {
  color: #0f172a;
  font-size: 15px;
}

.approvalItemPanel header span,
.approvalScopeHint {
  color: #475569;
  font-size: 13px;
}

.approvalItemPanel footer {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  margin-top: 14px;
}

.whiteButton {
  min-height: 34px;
  border: 1px solid #cbd5e1;
  border-radius: 10px;
  background: #fff;
  color: #0f172a;
  font-weight: 600;
}
```

- [ ] **Step 6: 运行审批测试**

Run:

```bash
npx vitest run apps/web/src/components/ApprovalPanel.test.tsx apps/desktop/src/components/ApprovalPanel.test.tsx
```

Expected:

```text
PASS apps/web/src/components/ApprovalPanel.test.tsx
PASS apps/desktop/src/components/ApprovalPanel.test.tsx
```

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/components/ApprovalPanel.tsx apps/desktop/src/components/ApprovalPanel.tsx apps/web/src/components/ApprovalPanel.test.tsx apps/desktop/src/components/ApprovalPanel.test.tsx apps/web/src/main.tsx apps/desktop/src/main.tsx apps/web/src/styles.css apps/desktop/src/styles.css
git commit -m "feat(ui): make approvals temporary panel decisions"
```

## Task 9: 活动与监控显示权限、Skill、MCP、Agent 资源

**Files:**
- Modify: `packages/runtime/src/runTraceProjector.ts`
- Modify: `packages/runtime/src/runTraceProjector.test.ts`
- Modify: `apps/web/src/features/monitor/traceFormatters.ts`
- Modify: `apps/desktop/src/features/monitor/traceFormatters.ts`
- Modify: `apps/web/src/features/agents/agentWorkbenchModel.ts`
- Modify: `apps/desktop/src/features/agents/agentWorkbenchModel.ts`
- Modify: `apps/web/src/components/workbench/LiveActivityHud.tsx`
- Modify: `apps/desktop/src/components/workbench/LiveActivityHud.tsx`

- [ ] **Step 1: 写 trace projector 测试**

在 `packages/runtime/src/runTraceProjector.test.ts` 增加：

```ts
it('projects access decisions as approval trace events with agent and resource details', () => {
  const projected = projectRunEvent({
    id: 'event-1',
    runId: 'run-1',
    threadId: 'thread-1',
    turnId: 'turn-1',
    sequence: 1,
    category: 'approval',
    type: 'access.decision',
    level: 'warning',
    message: '需要用户临时授权',
    timestamp: '2026-07-27T00:00:00.000Z',
    metadata: {
      decision: 'prompt',
      source: 'approval_required',
      access: 'read',
      target: { kind: 'path', path: 'E:\\langchain\\dexin-agent\\v1.docx' },
      toolName: 'read_document',
      agentThreadId: 'thread-1',
      agentRole: 'Suanlizi 主控 Agent',
    },
  });

  expect(projected.category).toBe('approval');
  expect(projected.payload).toMatchObject({
    decision: 'prompt',
    access: 'read',
    toolName: 'read_document',
    agentRole: 'Suanlizi 主控 Agent',
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run:

```bash
npx vitest run packages/runtime/src/runTraceProjector.test.ts --testNamePattern "access decisions"
```

Expected:

```text
FAIL packages/runtime/src/runTraceProjector.test.ts
```

- [ ] **Step 3: trace formatter 增加 access.decision**

在 web 与 desktop 的 `traceFormatters.ts` 中加入：

```ts
if (event.type === 'access.decision') {
  const payload = event.payload as {
    decision?: string;
    access?: string;
    target?: { kind?: string; path?: string; host?: string; command?: string; toolName?: string };
    toolName?: string;
    agentRole?: string;
  };
  const targetLabel = payload.target?.path ?? payload.target?.host ?? payload.target?.command ?? payload.target?.toolName ?? '未知资源';
  return {
    icon: payload.decision === 'deny' ? '⛔' : payload.decision === 'prompt' ? '🔐' : '✅',
    label: '权限判定',
    summary: `${payload.agentRole ?? 'Agent'} · ${payload.toolName ?? 'tool'} · ${payload.access ?? 'access'} · ${targetLabel}`,
  };
}
```

- [ ] **Step 4: agentWorkbenchModel 合并资源与事件**

在 web 与 desktop 的 `agentWorkbenchModel.ts` 中，把最近活动事件的生成改为单条结构：

```ts
{
  id,
  agentThreadId,
  agentLabel,
  type,
  status,
  resource: {
    kind: 'skill' | 'mcp' | 'file' | 'command' | 'network' | 'permission',
    label,
    detail,
  },
  timestamp,
}
```

渲染时一行显示：

```text
Suanlizi 主控 Agent · read_document · E:\langchain\dexin-agent\v1.docx · 临时授权
```

不再单独渲染“资源使用”列表。

- [ ] **Step 5: 运行监控与右栏测试**

Run:

```bash
npx vitest run packages/runtime/src/runTraceProjector.test.ts apps/web/src/features/agents/agentWorkbenchModel.test.ts apps/desktop/src/features/agents/agentWorkbenchModel.test.ts
```

Expected:

```text
PASS packages/runtime/src/runTraceProjector.test.ts
PASS apps/web/src/features/agents/agentWorkbenchModel.test.ts
PASS apps/desktop/src/features/agents/agentWorkbenchModel.test.ts
```

- [ ] **Step 6: Commit**

```bash
git add packages/runtime/src/runTraceProjector.ts packages/runtime/src/runTraceProjector.test.ts apps/web/src/features/monitor/traceFormatters.ts apps/desktop/src/features/monitor/traceFormatters.ts apps/web/src/features/agents/agentWorkbenchModel.ts apps/desktop/src/features/agents/agentWorkbenchModel.ts apps/web/src/components/workbench/LiveActivityHud.tsx apps/desktop/src/components/workbench/LiveActivityHud.tsx
git commit -m "feat(monitor): show access resources in activity events"
```

## Task 10: 最终验证与浏览器验收

**Files:**
- Modify only if verification finds a failing assertion in files already changed by Tasks 1-9.

- [ ] **Step 1: 类型检查**

Run:

```bash
npx tsc -b
```

Expected:

```text
0 errors
```

- [ ] **Step 2: lint**

Run:

```bash
npm run lint
```

Expected:

```text
0 errors
0 warnings
```

- [ ] **Step 3: 全量测试**

Run:

```bash
npm test
```

Expected:

```text
Test Files  all passed
Tests       all passed
```

- [ ] **Step 4: 构建**

Run:

```bash
npm run build
```

Expected:

```text
tsc -b exits with code 0
```

- [ ] **Step 5: 内置浏览器验收**

启动项目：

```bash
npm run dev
```

在内置浏览器打开：

```text
http://127.0.0.1:5177/
```

验收路径：

- 打开设置 → 权限与工作区。
- 对话模式下确认说明显示“隐藏对话工作区，外部目录需要授权”。
- 工作区模式下确认 workspaceRoot 显示项目路径。
- 新增持久允许规则：`E:\langchain\dexin-agent`，权限为“读取”，保存到当前线程。
- 关闭设置后重新打开，规则仍存在。
- 触发读取外部 docx，若已有持久允许，不应弹审批。
- 删除持久规则后再次触发读取外部 docx，应弹审批面板。
- 审批面板只显示“临时授权”，不显示“永久允许”。
- 拒绝后本轮相同工具请求不应重复弹窗，应直接拒绝。
- 允许“仅本次工具调用”后，下一次工具调用同一路径应再次询问。
- 活动面板最近事件显示 Agent、工具名、资源路径、权限决策。
- 监控抽屉 trace 中能看到 `access.decision` 条目，并能查看 typed payload。
- 浏览器 console 无 error / warn。

- [ ] **Step 6: Commit 验证修正**

若 Step 1-5 中有修正：

```bash
git add packages apps
git commit -m "fix(access-policy): close verification gaps"
```

如果没有修正：

```bash
git status --short
```

Expected:

```text
empty output
```

## 实施约束

- 弹窗授权只写运行时内存，不写 settings，不写 thread tags，不写 model preset。
- 设置页保存的规则必须持久化到 SQLite settings 或 thread config。
- 持久 deny 的优先级永远高于临时 allow。
- `danger_full_access` 只能作为高级显式选择，不能由默认配置、普通对话、工作区创建流程自动启用。
- 所有文件工具必须走 `requestAccess()`，不能在工具内部直接读取任意绝对路径。
- 子 Agent 的权限上限不能超过父 Agent。
- 监控必须能解释每次 allow / prompt / deny 的来源。
- 对话模式与工作区模式的 UI 文案必须明确区分，不能只显示底层枚举名。

## 自检清单

- 需求“弹窗授权是临时允许禁止，设置里的是持久化允许禁止”由 Task 5、Task 7、Task 8 覆盖。
- 需求“对话模式只能读取，或者授权工作区/目录/无限制”由 Task 3、Task 6、Task 7 覆盖。
- 需求“工作区模式，在选择工作目录的条件下授权读取和改写其他目录”由 Task 3、Task 4、Task 7 覆盖。
- 需求“活动和监控更详细，包含 skill、mcp、资源、agent 区分”由 Task 9 覆盖。
- 路径越界与绝对路径绕过问题由 Task 2、Task 4 覆盖。
- 无运行时审批写入持久设置的路径。
