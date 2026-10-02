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

  it('keeps persistent workspace and thread rules inside their declared scope', () => {
    const policy: AccessPolicyConfig = {
      mode: 'chat',
      workspaceRoot: 'E:\\langchain\\Suanlizi',
      persistentRules: [
        {
          id: 'workspace-localhost',
          effect: 'allow',
          access: 'network',
          target: { kind: 'network', host: 'localhost:5173' },
          scope: 'workspace',
          workspaceRoot: 'E:\\langchain\\Suanlizi',
        },
        {
          id: 'thread-click',
          effect: 'allow',
          access: 'tool_call',
          target: { kind: 'tool', toolName: 'browser_act:click' },
          scope: 'thread',
          threadId: 'thread-1',
        },
      ],
      temporaryGrants: [],
    };

    expect(evaluateAccessRequest(policy, {
      ...baseRequest,
      access: 'network',
      target: { kind: 'network', host: 'localhost:5173' },
      workspaceRoot: 'E:\\langchain\\Suanlizi',
    }).decision).toBe('allow');
    expect(evaluateAccessRequest(policy, {
      ...baseRequest,
      access: 'network',
      target: { kind: 'network', host: 'localhost:5173' },
      workspaceRoot: 'E:\\other-project',
    }).decision).toBe('prompt');
    expect(evaluateAccessRequest(policy, {
      ...baseRequest,
      access: 'tool_call',
      target: { kind: 'tool', toolName: 'browser_act:click' },
    }).decision).toBe('allow');
    expect(evaluateAccessRequest(policy, {
      ...baseRequest,
      threadId: 'thread-2',
      access: 'tool_call',
      target: { kind: 'tool', toolName: 'browser_act:click' },
    }).decision).toBe('prompt');
  });

  it('matches typed Ops host, service and workspace targets by scope', () => {
    const policy: AccessPolicyConfig = {
      mode: 'chat',
      workspaceRoot: 'E:\\langchain\\Suanlizi',
      persistentRules: [
        {
          id: 'ops-host',
          effect: 'allow',
          access: 'read',
          target: { kind: 'host', environmentId: 'prod', hostId: 'api-01' },
          scope: 'thread',
          threadId: 'thread-1',
        },
        {
          id: 'ops-workspace',
          effect: 'allow',
          access: 'read',
          target: { kind: 'workspace', workspaceRoot: 'E:\\langchain\\Suanlizi', relativePath: 'src' },
          scope: 'global',
        },
      ],
      temporaryGrants: [],
    };

    expect(evaluateAccessRequest(policy, {
      ...baseRequest,
      target: { kind: 'host', environmentId: 'prod', hostId: 'api-01' },
    }).decision).toBe('allow');
    expect(evaluateAccessRequest(policy, {
      ...baseRequest,
      target: { kind: 'host', environmentId: 'prod', hostId: 'db-01' },
    }).decision).toBe('prompt');
    expect(evaluateAccessRequest(policy, {
      ...baseRequest,
      target: { kind: 'workspace', workspaceRoot: 'E:\\langchain\\Suanlizi', relativePath: 'src/components/App.tsx' },
    }).decision).toBe('allow');
    expect(evaluateAccessRequest(policy, {
      ...baseRequest,
      target: { kind: 'workspace', workspaceRoot: 'E:\\langchain\\Suanlizi', relativePath: 'docs/design.md' },
    }).decision).toBe('prompt');
  });

  it('hard-denies writes and commands against typed Ops remote targets', () => {
    const policy: AccessPolicyConfig = {
      mode: 'danger_full_access',
      workspaceRoot: 'E:\\langchain\\Suanlizi',
      persistentRules: [],
      temporaryGrants: [],
    };
    for (const target of [
      { kind: 'host' as const, environmentId: 'prod', hostId: 'api-01' },
      { kind: 'container' as const, environmentId: 'prod', containerName: 'api' },
      { kind: 'service' as const, environmentId: 'prod', serviceName: 'nginx' },
      { kind: 'log' as const, environmentId: 'prod', serviceName: 'nginx' },
    ]) {
      const decision = evaluateAccessRequest(policy, { ...baseRequest, access: 'write', target });
      expect(decision).toMatchObject({ decision: 'deny', source: 'hard_deny' });
    }
  });
});
