import * as path from 'node:path';
import type {
  AccessDecision,
  AccessPolicyConfig,
  AccessRequest,
  AccessRule,
  TemporaryAccessGrant,
} from '@suanlizi/protocol';
import { normalizeAccessPolicyConfig } from '@suanlizi/protocol';

export function buildRuntimeAccessPolicy(input: Partial<AccessPolicyConfig> = {}): AccessPolicyConfig {
  return normalizeAccessPolicyConfig(input);
}

export function mergePersistentRules(
  globalRules: AccessRule[] = [],
  threadRules: AccessRule[] = [],
): AccessRule[] {
  return [...globalRules, ...threadRules];
}

export function evaluateAccessRequest(policyInput: AccessPolicyConfig, request: AccessRequest): AccessDecision {
  const policy = normalizeAccessPolicyConfig(policyInput);
  const hardDeny = hardDenyReason(request);
  if (hardDeny) {
    return decision('deny', request, 'hard_deny', hardDeny);
  }

  const persistentDeny = policy.persistentRules.find((rule) => rule.effect === 'deny' && ruleMatches(rule, request));
  if (persistentDeny) {
    return decision(
      'deny',
      request,
      'persistent_rule',
      persistentDeny.reason ?? '命中持久拒绝规则',
      persistentDeny.id,
      persistentDeny.scope,
    );
  }

  const persistentAllow = policy.persistentRules.find((rule) => rule.effect === 'allow' && ruleMatches(rule, request));
  if (persistentAllow) {
    return decision(
      'allow',
      request,
      'persistent_rule',
      persistentAllow.reason ?? '命中持久允许规则',
      persistentAllow.id,
      persistentAllow.scope,
    );
  }

  if (workspaceDefaultAllows(policy, request)) {
    return decision(
      'allow',
      request,
      'workspace_default',
      policy.mode === 'chat' ? '对话隐藏工作区默认允许' : '项目工作区默认允许',
    );
  }

  const temporaryDeny = policy.temporaryGrants.find((grant) => grant.effect === 'deny' && temporaryGrantMatches(grant, request));
  if (temporaryDeny) {
    return decision('deny', request, 'temporary_grant', '命中临时拒绝', temporaryDeny.id, temporaryDeny.scope);
  }

  const temporaryAllow = policy.temporaryGrants.find((grant) => grant.effect === 'allow' && temporaryGrantMatches(grant, request));
  if (temporaryAllow) {
    return decision('allow', request, 'temporary_grant', '命中临时允许', temporaryAllow.id, temporaryAllow.scope);
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
  if (rule.scope === 'thread' && rule.threadId && rule.threadId !== request.threadId) return false;
  if (rule.scope === 'workspace' && !sameWorkspace(rule.workspaceRoot, request.workspaceRoot)) return false;
  return rule.access === request.access && targetMatches(rule.target, request.target);
}

function sameWorkspace(ruleWorkspaceRoot: string | undefined, requestWorkspaceRoot: string | undefined): boolean {
  if (!ruleWorkspaceRoot || !requestWorkspaceRoot) return false;
  const ruleRoot = path.resolve(ruleWorkspaceRoot);
  const requestRoot = path.resolve(requestWorkspaceRoot);
  return process.platform === 'win32'
    ? ruleRoot.toLowerCase() === requestRoot.toLowerCase()
    : ruleRoot === requestRoot;
}

function targetMatches(ruleTarget: AccessRule['target'], requestTarget: AccessRequest['target']): boolean {
  if (ruleTarget.kind !== requestTarget.kind) return false;
  if (ruleTarget.kind === 'path') {
    return Boolean(ruleTarget.path && requestTarget.path && isPathInsideOrEqual(ruleTarget.path, requestTarget.path));
  }
  if (ruleTarget.kind === 'workspace') {
    if (requestTarget.kind !== 'workspace') return false;
    if (!ruleTarget.workspaceRoot || !requestTarget.workspaceRoot) return false;
    if (!sameWorkspace(ruleTarget.workspaceRoot, requestTarget.workspaceRoot)) return false;
    if (!ruleTarget.relativePath) return true;
    return !requestTarget.relativePath
      ? false
      : isRelativePathInside(ruleTarget.relativePath, requestTarget.relativePath);
  }
  if (ruleTarget.kind === 'command') {
    return Boolean(ruleTarget.command && requestTarget.command?.startsWith(ruleTarget.command));
  }
  if (ruleTarget.kind === 'network') {
    return Boolean(ruleTarget.host && requestTarget.host && hostMatches(requestTarget.host, ruleTarget.host));
  }
  if (ruleTarget.kind === 'tool') {
    return ruleTarget.toolName === requestTarget.toolName;
  }
  if (ruleTarget.kind === 'host') {
    return requestTarget.kind === 'host'
      && ruleTarget.environmentId === requestTarget.environmentId
      && ruleTarget.hostId === requestTarget.hostId;
  }
  if (ruleTarget.kind === 'container') {
    return requestTarget.kind === 'container'
      && scopedIdMatches(ruleTarget.environmentId, requestTarget.environmentId)
      && scopedOptionalIdMatches(ruleTarget.hostId, requestTarget.hostId)
      && ruleTarget.containerName === requestTarget.containerName;
  }
  if (ruleTarget.kind === 'service') {
    return requestTarget.kind === 'service'
      && scopedIdMatches(ruleTarget.environmentId, requestTarget.environmentId)
      && scopedOptionalIdMatches(ruleTarget.hostId, requestTarget.hostId)
      && ruleTarget.serviceName === requestTarget.serviceName;
  }
  return requestTarget.kind === 'log'
    && scopedIdMatches(ruleTarget.environmentId, requestTarget.environmentId)
    && scopedOptionalIdMatches(ruleTarget.hostId, requestTarget.hostId)
    && scopedOptionalIdMatches(ruleTarget.serviceName, requestTarget.serviceName)
    && scopedOptionalIdMatches(ruleTarget.containerName, requestTarget.containerName)
    && timeRangeContains(ruleTarget.timeRange, requestTarget.timeRange);
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
  if (
    (request.access === 'write' || request.access === 'command')
    && ['host', 'container', 'service', 'log'].includes(request.target.kind)
  ) {
    return 'Ops 远程目标仅允许只读访问';
  }
  if (request.target.kind === 'path' && request.target.path) {
    const resolved = path.resolve(request.target.path);
    if (request.access === 'write' && resolved === path.parse(resolved).root) {
      return '拒绝写入磁盘根目录';
    }
  }
  if (request.target.kind === 'command' && request.target.command) {
    if (/\brm\s+-rf\s+[/\\]/i.test(request.target.command)
      || /\bremove-item\b.*\b-recurse\b/i.test(request.target.command)) {
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
  const normalizedRoot = process.platform === 'win32' ? resolvedRoot.toLowerCase() : resolvedRoot;
  const normalizedCandidate = process.platform === 'win32' ? resolvedCandidate.toLowerCase() : resolvedCandidate;
  const relative = path.relative(normalizedRoot, normalizedCandidate);
  return relative === '' || (relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative));
}

function isRelativePathInside(root: string, candidate: string): boolean {
  const normalizedRoot = root.replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/+$/, '');
  const normalizedCandidate = candidate.replaceAll('\\', '/').replace(/^\.\//, '');
  return normalizedCandidate === normalizedRoot
    || normalizedCandidate.startsWith(`${normalizedRoot}/`);
}

function scopedIdMatches(ruleValue: string | undefined, requestValue: string | undefined): boolean {
  return Boolean(ruleValue && requestValue && ruleValue === requestValue);
}

function scopedOptionalIdMatches(ruleValue: string | undefined, requestValue: string | undefined): boolean {
  return ruleValue === undefined || ruleValue === requestValue;
}

function timeRangeContains(
  ruleRange: { from: string; to: string } | undefined,
  requestRange: { from: string; to: string } | undefined,
): boolean {
  if (!ruleRange) return true;
  if (!requestRange) return false;
  const ruleFrom = Date.parse(ruleRange.from);
  const ruleTo = Date.parse(ruleRange.to);
  const requestFrom = Date.parse(requestRange.from);
  const requestTo = Date.parse(requestRange.to);
  return Number.isFinite(ruleFrom) && Number.isFinite(ruleTo)
    && Number.isFinite(requestFrom) && Number.isFinite(requestTo)
    && requestFrom >= ruleFrom && requestTo <= ruleTo;
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
