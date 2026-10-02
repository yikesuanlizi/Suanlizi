// 审批面板持久化规则的可复用纯函数（从 server.ts 拆出，§5 变更边界：server.ts 只做装配）。
// — Chinese: pure access-policy rule helpers extracted from server.ts.

import type { AccessPolicyConfig, AccessRequest, AccessRule, PersistentAccessScope } from '@suanlizi/protocol';

/** 把一次「允许且记住」的审批转成持久化规则（scope 决定挂在 thread 还是 workspace）。 */
export function persistentRuleFromApproval(request: AccessRequest, scope: PersistentAccessScope): AccessRule {
  const createdAt = new Date().toISOString();
  return {
    id: `approval_allow_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
    effect: 'allow',
    access: request.access,
    target: request.target,
    scope,
    ...(scope === 'thread' ? { threadId: request.threadId } : {}),
    ...(scope === 'workspace' && request.workspaceRoot ? { workspaceRoot: request.workspaceRoot } : {}),
    reason: '通过审批面板允许类似操作',
    createdAt,
    updatedAt: createdAt,
  };
}

/** 追加规则（按 effect/access/scope/thread/workspace/target 去重）并清空临时授权。 */
export function appendPersistentRule(policy: AccessPolicyConfig, rule: AccessRule): AccessPolicyConfig {
  const alreadyPresent = policy.persistentRules.some((current) =>
    current.effect === rule.effect
    && current.access === rule.access
    && current.scope === rule.scope
    && current.threadId === rule.threadId
    && current.workspaceRoot === rule.workspaceRoot
    && JSON.stringify(current.target) === JSON.stringify(rule.target),
  );
  return {
    ...policy,
    persistentRules: alreadyPresent ? policy.persistentRules : [...policy.persistentRules, rule],
    temporaryGrants: [],
  };
}
