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

  it('parses typed Ops targets without collapsing them into path/network targets', () => {
    const parsed = accessRuleSchema.parse({
      id: 'ops-log',
      effect: 'allow',
      access: 'read',
      target: {
        kind: 'log',
        environmentId: 'prod',
        hostId: 'api-01',
        serviceName: 'nginx',
        timeRange: { from: '2026-08-19T00:00:00.000Z', to: '2026-08-19T01:00:00.000Z' },
      },
      scope: 'thread',
      threadId: 'thread-1',
    });
    expect(parsed.target.kind).toBe('log');
  });
});
