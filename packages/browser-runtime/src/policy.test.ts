// 浏览器策略引擎单元测试：覆盖 allow / confirm / deny 全部决策路径
// — English: browser policy engine unit tests — covers allow / confirm / deny decision paths
// 策略的规则匹配（evaluateAccessRequest）由注入的评估器模拟；与现有 AccessPolicy 的
// 真实集成由 tests/browser-phase0.test.ts 覆盖（避免 browser-runtime 依赖 runtime 包）。
import { describe, expect, it } from 'vitest';
import type {
  AccessDecision,
  AccessPolicyConfig,
  AccessRequest,
  ActionGrant,
  ActionIntent,
} from '@suanlizi/protocol';
import { normalizeAccessPolicyConfig } from '@suanlizi/protocol';
import { BrowserPolicyEngine } from './policy.js';

// 构造最小 AccessDecision（注入 stub 用）
// — English: builds a minimal AccessDecision for the injected stub.
function stubDecision(request: AccessRequest, value: 'allow' | 'prompt' | 'deny', justification: string): AccessDecision {
  return {
    decision: value,
    request,
    source: value === 'deny' ? 'default_deny' : value === 'prompt' ? 'approval_required' : 'persistent_rule',
    justification,
  };
}

function makeIntent(overrides: Partial<ActionIntent> = {}): ActionIntent {
  return {
    actionId: 'act-1',
    taskId: 'task-1',
    pageId: 'page-1',
    observationId: 'obs-1',
    expectedNavigationEpoch: 1,
    kind: 'click',
    arguments: {},
    rationale: '测试动作',
    effect: 'none',
    risk: 'low',
    postcondition: { kind: 'none' },
    ...overrides,
  };
}

function makePolicy(overrides: Partial<AccessPolicyConfig> = {}): AccessPolicyConfig {
  return normalizeAccessPolicyConfig({
    mode: 'workspace',
    workspaceRoot: '',
    persistentRules: [],
    temporaryGrants: [],
    ...overrides,
  });
}

function makeEngine(
  policy: AccessPolicyConfig,
  options: {
    grant?: ActionGrant;
    maxExternalWrites?: number;
    evaluateAccess?: (request: AccessRequest) => AccessDecision;
  } = {},
): BrowserPolicyEngine {
  return new BrowserPolicyEngine({
    policy,
    evaluateAccess: options.evaluateAccess ?? ((request) => stubDecision(request, 'allow', 'stub allow')),
    grant: options.grant,
    maxExternalWrites: options.maxExternalWrites,
    threadId: 'thread-1',
    turnId: 'turn-1',
  });
}

describe('BrowserPolicyEngine', () => {
  it('允许命中网络 allow 规则的 navigate（example.com）', async () => {
    const policy = makePolicy({
      persistentRules: [
        {
          id: 'allow-example',
          effect: 'allow',
          access: 'network',
          target: { kind: 'network', host: 'example.com' },
          scope: 'global',
        },
      ],
    });
    const engine = makeEngine(policy);

    const decision = await engine.evaluate(
      makeIntent({ kind: 'navigate', arguments: { url: 'https://example.com/' } }),
    );

    expect(decision).toEqual({ kind: 'allow' });
  });

  it('无规则 navigate 返回 confirm（approvalRequest.kind 为 network）', async () => {
    const engine = makeEngine(makePolicy());

    const decision = await engine.evaluate(
      makeIntent({
        kind: 'navigate',
        effect: 'external_reversible',
        arguments: { url: 'https://example.com/' },
      }),
    );

    expect(decision.kind).toBe('confirm');
    if (decision.kind === 'confirm') {
      expect(decision.approvalRequest.kind).toBe('network');
      expect(decision.approvalRequest.requestId).toBe('br-act-1');
      expect(decision.approvalRequest.itemId).toBe('item-browser-act-1');
      expect(decision.approvalRequest.threadId).toBe('thread-1');
      expect(decision.approvalRequest.turnId).toBe('turn-1');
      expect(decision.approvalRequest.decision).toBe('prompt');
      expect(decision.approvalRequest.accessRequest?.access).toBe('network');
      expect(decision.approvalRequest.accessRequest?.target).toEqual({
        kind: 'network',
        host: 'example.com',
      });
      expect(decision.approvalRequest.payload).toMatchObject({ url: 'https://example.com/' });
    }
  });

  it('无规则 navigate（effect none / risk low）因策略 prompt 仍返回 confirm', async () => {
    // 无规则时现有评估器返回 prompt（approval_required），这里用 stub 模拟。
    // — English: the existing evaluator returns prompt for unrouted requests; stub it here.
    const engine = makeEngine(makePolicy(), {
      evaluateAccess: (request) => stubDecision(request, 'prompt', '需要用户临时授权'),
    });

    const decision = await engine.evaluate(
      makeIntent({
        kind: 'navigate',
        effect: 'none',
        risk: 'low',
        arguments: { url: 'https://example.com/' },
      }),
    );

    // 评估器返回 prompt 时，策略必须把它表面化为 confirm，而不是静默放行。
    // — English: a prompt from the evaluator must surface as confirm, not a silent allow.
    expect(decision.kind).toBe('confirm');
    if (decision.kind === 'confirm') {
      expect(decision.approvalRequest.kind).toBe('network');
    }
  });

  it('拒绝 file: 协议的 navigate（NET_BLOCKED）', async () => {
    const engine = makeEngine(makePolicy());

    const decision = await engine.evaluate(
      makeIntent({ kind: 'navigate', arguments: { url: 'file:///etc/passwd' } }),
    );

    expect(decision).toEqual({ kind: 'deny', reason: 'NET_BLOCKED' });
  });

  it('回环地址 navigate 默认拒绝，精确 host allow 规则可放行', async () => {
    const engine = makeEngine(makePolicy());

    const blocked = await engine.evaluate(
      makeIntent({ kind: 'navigate', arguments: { url: 'http://localhost:8080/' } }),
    );
    expect(blocked).toEqual({ kind: 'deny', reason: 'NET_BLOCKED' });

    const allowed = makePolicy({
      persistentRules: [
        {
          id: 'allow-local',
          effect: 'allow',
          access: 'network',
          target: { kind: 'network', host: 'localhost:8080' },
          scope: 'global',
        },
      ],
    });
    const decision = await makeEngine(allowed).evaluate(
      makeIntent({ kind: 'navigate', arguments: { url: 'http://localhost:8080/' } }),
    );
    expect(decision).toEqual({ kind: 'allow' });
  });

  it('拒绝云元数据地址 navigate（169.254.169.254）', async () => {
    const engine = makeEngine(makePolicy());

    const decision = await engine.evaluate(
      makeIntent({ kind: 'navigate', arguments: { url: 'http://169.254.169.254/latest/meta-data' } }),
    );

    expect(decision).toEqual({ kind: 'deny', reason: 'NET_BLOCKED' });
  });

  it('允许低风险 local 动作（tool_call 规则命中）', async () => {
    const policy = makePolicy({
      persistentRules: [
        {
          id: 'allow-click',
          effect: 'allow',
          access: 'tool_call',
          target: { kind: 'tool', toolName: 'browser.click' },
          scope: 'global',
        },
      ],
    });

    const decision = await makeEngine(policy).evaluate(
      makeIntent({ kind: 'click', arguments: { ref: 'el-1' } }),
    );

    expect(decision).toEqual({ kind: 'allow' });
  });

  it('外部不可逆副作用即使命中 allow 规则仍须 confirm', async () => {
    const policy = makePolicy({
      persistentRules: [
        {
          id: 'allow-shop',
          // 写请求（submit/external_*）映射为 access=write、target.kind=network，
          // 因此匹配它的 allow 规则必须是 write + network target。
          // — English: the write request maps to access=write with a network target, so the allow rule must match.
          effect: 'allow',
          access: 'write',
          target: { kind: 'network', host: 'shop.example.com' },
          scope: 'global',
        },
      ],
    });

    const decision = await makeEngine(policy).evaluate(
      makeIntent({
        kind: 'submit',
        effect: 'external_irreversible',
        risk: 'medium',
        arguments: { url: 'https://shop.example.com/checkout' },
      }),
      { pageUrl: 'https://shop.example.com/checkout' },
    );

    expect(decision.kind).toBe('confirm');
    if (decision.kind === 'confirm') {
      expect(decision.approvalRequest.kind).toBe('tool_call');
      expect(decision.approvalRequest.accessRequest?.access).toBe('write');
      expect(decision.approvalRequest.accessRequest?.target).toEqual({
        kind: 'network',
        host: 'shop.example.com',
      });
    }
  });

  it('敏感参数键名直接拒绝（SENSITIVE_DATA）', async () => {
    const engine = makeEngine(makePolicy());

    const decision = await engine.evaluate(
      makeIntent({ kind: 'click', arguments: { password: 'x' } }),
    );

    expect(decision).toEqual({ kind: 'deny', reason: 'SENSITIVE_DATA' });
  });

  it('grant 未授权的动作 kind 拒绝（GRANT_ACTION）', async () => {
    const grant: ActionGrant = {
      grantId: 'grant-1',
      taskId: 'task-1',
      allowedOrigins: ['https://allowed.example'],
      allowedActionKinds: ['navigate', 'click'],
      allowedDataClasses: ['public'],
      maxExternalWrites: 3,
      confirmationThreshold: 'critical',
      expiresAt: Date.now() + 60_000,
    };
    const engine = makeEngine(makePolicy(), { grant });

    const decision = await engine.evaluate(makeIntent({ kind: 'type' }));

    expect(decision).toEqual({ kind: 'deny', reason: 'GRANT_ACTION' });
  });

  it('外部写入预算耗尽后拒绝新的外部写动作（WRITE_BUDGET）', async () => {
    const engine = makeEngine(makePolicy(), { maxExternalWrites: 2 });
    const writeIntent = makeIntent({
      kind: 'submit',
      effect: 'external_irreversible',
      arguments: { url: 'https://shop.example.com/checkout' },
    });

    engine.noteExternalWrite(writeIntent);
    engine.noteExternalWrite(writeIntent);

    const decision = await engine.evaluate(writeIntent, { pageUrl: 'https://shop.example.com/checkout' });

    expect(decision).toEqual({ kind: 'deny', reason: 'WRITE_BUDGET' });
  });

  it('evaluateAccess 返回 deny 时透传持久拒绝理由', async () => {
    const engine = makeEngine(makePolicy(), {
      evaluateAccess: (request) => stubDecision(request, 'deny', '命中持久拒绝规则'),
    });

    const decision = await engine.evaluate(
      makeIntent({ kind: 'navigate', arguments: { url: 'https://evil.example/' } }),
    );

    expect(decision.kind).toBe('deny');
    if (decision.kind === 'deny') {
      expect(decision.reason).toBe('命中持久拒绝规则');
    }
  });

  it('download 同样受网络边界约束（file:/回环 → NET_BLOCKED）', async () => {
    const engine = makeEngine(makePolicy());

    const fileDownload = await engine.evaluate(
      makeIntent({ kind: 'download', arguments: { url: 'file:///etc/passwd' } }),
    );
    expect(fileDownload).toEqual({ kind: 'deny', reason: 'NET_BLOCKED' });

    const metadataDownload = await engine.evaluate(
      makeIntent({ kind: 'download', arguments: { url: 'http://169.254.169.254/latest/meta-data' } }),
    );
    expect(metadataDownload).toEqual({ kind: 'deny', reason: 'NET_BLOCKED' });
  });

  it('回环覆盖：127/8 全段、0.0.0.0、IPv4-mapped IPv6 均拒绝；公网 IPv6 放行', async () => {
    const engine = makeEngine(makePolicy());
    const base = {
      taskId: 'task-1',
      pageId: 'page-1',
      observationId: 'obs-1',
      expectedNavigationEpoch: 1,
      kind: 'navigate' as const,
      rationale: '导航',
      effect: 'none' as const,
      risk: 'low' as const,
      postcondition: { kind: 'url_contains' as const, value: 'x' },
    };
    // 127/8 其它地址（绕过单点 127.0.0.1 检查）
    const otherLoopback: ActionIntent = { ...base, actionId: 'act-127-2', arguments: { url: 'http://127.0.0.2/admin' } };
    expect((await engine.evaluate(otherLoopback)).kind).toBe('deny');
    // 0.0.0.0（本机通配地址）
    const wildcard: ActionIntent = { ...base, actionId: 'act-0000', arguments: { url: 'http://0.0.0.0:8080/' } };
    expect((await engine.evaluate(wildcard)).kind).toBe('deny');
    // IPv4-mapped IPv6 回环
    const mapped: ActionIntent = { ...base, actionId: 'act-mapped', arguments: { url: 'http://[::ffff:127.0.0.1]/' } };
    expect((await engine.evaluate(mapped)).kind).toBe('deny');
    // 公网 IPv6 不被回环规则误杀（无规则时走到 evaluateAccess prompt → confirm）
    const publicV6: ActionIntent = { ...base, actionId: 'act-v6', arguments: { url: 'http://[2001:db8::1]/' } };
    const v6Decision = await engine.evaluate(publicV6);
    expect(['confirm', 'allow']).toContain(v6Decision.kind);
  });

  it('grant 过期直接拒绝（GRANT_EXPIRED）', async () => {
    const grant: ActionGrant = {
      grantId: 'grant-expired',
      taskId: 'task-1',
      allowedOrigins: ['https://example.com'],
      allowedActionKinds: ['navigate', 'click'],
      allowedDataClasses: ['public'],
      maxExternalWrites: 3,
      confirmationThreshold: 'critical',
      expiresAt: Date.now() - 1000,
    };
    const engine = makeEngine(makePolicy(), { grant });
    const decision = await engine.evaluate(
      makeIntent({ kind: 'navigate', arguments: { url: 'https://example.com/' } }),
      { pageUrl: 'https://example.com/' },
    );
    expect(decision).toEqual({ kind: 'deny', reason: 'GRANT_EXPIRED' });
  });

  it('grant 校验 navigate 目标 origin（不在白名单 → GRANT_ORIGIN）', async () => {
    const grant: ActionGrant = {
      grantId: 'grant-1',
      taskId: 'task-1',
      allowedOrigins: ['https://allowed.example'],
      allowedActionKinds: ['navigate', 'click'],
      allowedDataClasses: ['public'],
      maxExternalWrites: 3,
      confirmationThreshold: 'critical',
      expiresAt: Date.now() + 60_000,
    };
    const engine = makeEngine(makePolicy(), { grant });
    const decision = await engine.evaluate(
      makeIntent({ kind: 'navigate', arguments: { url: 'https://other.example/' } }),
      { pageUrl: 'https://allowed.example/list' },
    );
    expect(decision).toEqual({ kind: 'deny', reason: 'GRANT_ORIGIN' });
  });

  it('审批请求中的 URL 不含 userinfo 凭据', async () => {
    const engine = makeEngine(makePolicy(), {
      evaluateAccess: (request) => stubDecision(request, 'prompt', '需要用户授权'),
    });
    const decision = await engine.evaluate(
      makeIntent({ kind: 'navigate', arguments: { url: 'https://user:secret@example.com/admin' } }),
    );
    expect(decision.kind).toBe('confirm');
    if (decision.kind === 'confirm') {
      // payload 类型为 unknown，用 toMatchObject 断言（避免凭据断言落空）
      // — English: payload is unknown-typed; assert via toMatchObject
      expect(decision.approvalRequest.payload).toMatchObject({ url: 'https://example.com/admin' });
      expect(JSON.stringify(decision.approvalRequest.payload)).not.toContain('secret');
    }
  });

  it('敏感键名扩展：apiKey/passphrase/pw/auth 等同样被拒绝', async () => {
    const engine = makeEngine(makePolicy());
    const decision = await engine.evaluate(
      makeIntent({ kind: 'type', arguments: { apiKey: 'x', passphrase: 'y', pw: 'z', authToken: 't' } }),
    );
    expect(decision).toEqual({ kind: 'deny', reason: 'SENSITIVE_DATA' });
  });
});
