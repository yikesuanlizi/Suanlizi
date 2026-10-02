// 浏览器策略引擎：把动作意图（ActionIntent）转化为 allow / confirm / deny 决策
// — English: Browser policy engine — turns an ActionIntent into allow / confirm / deny
// 检查顺序（全部通过才 allow）：
//   1) 网络边界：navigate 的 file: 协议与回环/元数据地址，除非策略中有精确 host 的 allow 规则
//   2) 授权包络：grant 存在时校验页面 origin 与动作 kind
//   3) 敏感数据：arguments 中密码/令牌等键名直接拒绝
//   4) 映射为 AccessRequest 并交给注入的 evaluateAccess（deny 即拒绝）
//   5) 风险与副作用确认：external 副作用、high/critical 风险必须 confirm
//   6) 外部写入预算：externalWriteCount 达到 maxExternalWrites 后拒绝
// — English: checks run in order; allow only when every check passes.
// Phase 0 简化：evaluateAccess 返回 prompt 不直接触发 confirm，确认与否由第 5 步决定；
// 外部写预算由调用方在动作 committed 后通过 noteExternalWrite 记账。
import type {
  AccessDecision,
  AccessPolicyConfig,
  AccessRequest,
  AccessTarget,
  ActionGrant,
  ActionIntent,
  ActionRisk,
  ApprovalRequest,
} from '@suanlizi/protocol';
import { normalizeAccessPolicyConfig } from '@suanlizi/protocol';

// 决策结果：allow / confirm（带审批请求）/ deny（带机器可读 reason 码）
// — English: decision — allow, confirm (with ApprovalRequest), or deny (with machine-readable reason).
export type BrowserPolicyDecision =
  | { kind: 'allow' }
  | { kind: 'confirm'; reason: string; approvalRequest: ApprovalRequest }
  | { kind: 'deny'; reason: string };

const DEFAULT_MAX_EXTERNAL_WRITES = 3;

// 敏感键名：任何参数键匹配即拒绝，防止凭据泄漏给页面/日志。
// — English: sensitive argument keys — matching keys are denied outright.
const SENSITIVE_KEY_RE = /password|passwd|secret|token|credential|api[-_]?key|passphrase|pwd|pw|auth/i;

// 风险等级排序：low < medium < high < critical
// — English: risk severity ordering — low < medium < high < critical.
const RISK_SEVERITY: Record<ActionRisk, number> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

// 回环/云元数据/内网地址：默认禁止 navigate，除非策略中存在精确 host 的 network allow 规则。
// — English: loopback, cloud metadata and private ranges — blocked unless an
//   exact-host network allow rule exists.
function isLoopbackHost(hostname: string): boolean {
  let host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  // IPv4-mapped IPv6（::ffff:127.0.0.1 或 ::ffff:7f00:1）解包为 IPv4 后判断。
  // — English: unwrap IPv4-mapped IPv6 (dotted or hex form) before judging.
  if (host.startsWith('::ffff:')) {
    const v4part = host.slice(7);
    const hexMapped = v4part.match(/^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (hexMapped !== null) {
      const a = parseInt(hexMapped[1]!, 16);
      const b = parseInt(hexMapped[2]!, 16);
      host = `${(a >> 8) & 0xff}.${a & 0xff}.${(b >> 8) & 0xff}.${b & 0xff}`;
    } else {
      host = v4part;
    }
  }
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host === '::1' || host === '::' || host === '0:0:0:0:0:0:0:1' || host === '0:0:0:0:0:0:0:0') return true;
  // IPv4：127.0.0.0/8 全段、0.0.0.0、云元数据、内网段。
  // — English: IPv4 — the whole 127/8, 0.0.0.0, cloud metadata and private ranges.
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
    const parts = host.split('.').map(Number);
    if (parts.some((p) => p > 255)) return false;
    if (parts[0] === 127) return true;
    if (parts[0] === 0 && parts[1] === 0 && parts[2] === 0 && parts[3] === 0) return true;
    if (host === '169.254.169.254' || host === '100.100.100.200') return true;
    if (parts[0] === 10) return true;
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
    if (parts[0] === 192 && parts[1] === 168) return true;
    return false;
  }
  return false;
}

// 目标 URL：navigate/download 等动作的 arguments.url 优先，回退到当前页面 URL；解析失败返回 null。
// — English: resolve the action target URL — arguments.url first, pageUrl as fallback; null on failure.
function resolveUrl(raw: unknown, fallback?: string): URL | null {
  const candidate = typeof raw === 'string' && raw.trim() !== '' ? raw : fallback;
  if (!candidate) return null;
  try {
    return new URL(candidate);
  } catch {
    return null;
  }
}

// 页面 origin：解析失败（缺省或非法）返回 null，调用方据此跳过 origin 检查。
// — English: page origin — null when the page URL is missing or unparsable.
function resolveOrigin(pageUrl?: string): string | null {
  if (!pageUrl) return null;
  try {
    return new URL(pageUrl).origin;
  } catch {
    return null;
  }
}

export class BrowserPolicyEngine {
  private readonly policy: AccessPolicyConfig;
  private readonly evaluateAccess: (request: AccessRequest) => AccessDecision;
  private readonly grant?: ActionGrant;
  private readonly threadId: string;
  private readonly turnId: string;
  private readonly maxExternalWrites: number;
  private externalWriteCount = 0;

  constructor(input: {
    policy: AccessPolicyConfig;
    evaluateAccess: (request: AccessRequest) => AccessDecision;
    grant?: ActionGrant;
    threadId: string;
    turnId: string;
    maxExternalWrites?: number;
  }) {
    // 策略归一化：host 小写、去空白，后续规则查找基于归一化结果。
    // — English: normalize the policy up front; rule lookups use the normalized config.
    this.policy = normalizeAccessPolicyConfig(input.policy);
    this.evaluateAccess = input.evaluateAccess;
    this.grant = input.grant;
    this.threadId = input.threadId;
    this.turnId = input.turnId;
    // grant 声明的写入上限优先于引擎默认；显式传入仍可覆盖
    // — English: the grant's write cap takes precedence over the engine default
    this.maxExternalWrites = input.maxExternalWrites ?? input.grant?.maxExternalWrites ?? DEFAULT_MAX_EXTERNAL_WRITES;
  }

  // 外部写入记账：调用方在动作 committed 后调用，与副作用账本保持一致。
  // — English: count a committed external write — invoked by the host after the action commits.
  noteExternalWrite(_intent: ActionIntent): void {
    this.externalWriteCount += 1;
  }

  async evaluate(intent: ActionIntent, input?: { pageUrl?: string }): Promise<BrowserPolicyDecision> {
    const pageUrl = input?.pageUrl;
    const targetUrl = resolveUrl(intent.arguments.url, pageUrl);
    const isNetworkKind = intent.kind === 'navigate' || intent.kind === 'download';
    const isExternal =
      intent.effect === 'external_reversible' || intent.effect === 'external_irreversible';

    // 1) 网络边界：navigate/download 检查目标 URL 协议与回环地址。
    // — English: network boundary — navigate/download target protocol and loopback are blocked.
    if (isNetworkKind) {
      if (!targetUrl) return { kind: 'deny', reason: 'INVALID_URL' };
      if (targetUrl.protocol === 'file:') return { kind: 'deny', reason: 'NET_BLOCKED' };
      if (isLoopbackHost(targetUrl.hostname) && !this.hasExactNetworkAllow(targetUrl.host)) {
        return { kind: 'deny', reason: 'NET_BLOCKED' };
      }
    }

    // 2) 授权包络：grant 存在时校验目标/页面 origin 与动作 kind；
    //    目标 origin（navigate/download）优先，回退当前页面 origin；
    //    解析失败则跳过 origin 检查；grant 过期直接拒绝。
    // — English: grant envelope — target/page origin and action kind must be
    //   inside the grant; target origin wins, page origin is the fallback;
    //   an expired grant is rejected.
    if (this.grant) {
      if (this.grant.expiresAt > 0 && Date.now() > this.grant.expiresAt) {
        return { kind: 'deny', reason: 'GRANT_EXPIRED' };
      }
      const origin = isNetworkKind && targetUrl ? targetUrl.origin : resolveOrigin(pageUrl);
      if (origin && !this.grant.allowedOrigins.includes(origin)) {
        return { kind: 'deny', reason: 'GRANT_ORIGIN' };
      }
      if (!this.grant.allowedActionKinds.includes(intent.kind)) {
        return { kind: 'deny', reason: 'GRANT_ACTION' };
      }
    }

    // 3) 敏感数据：参数键名匹配密码/令牌等模式直接拒绝。
    // — English: sensitive data — argument keys matching credential patterns are denied.
    if (Object.keys(intent.arguments).some((key) => SENSITIVE_KEY_RE.test(key))) {
      return { kind: 'deny', reason: 'SENSITIVE_DATA' };
    }

    // 4) 映射为 AccessRequest 并交给注入的 evaluateAccess；返回 deny 即拒绝。
    // — English: map to an AccessRequest and delegate to the injected evaluateAccess.
    const request = this.buildAccessRequest(intent, targetUrl, pageUrl, isNetworkKind, isExternal);
    if (!request) return { kind: 'deny', reason: 'INVALID_URL' };
    const accessDecision = this.evaluateAccess(request);
    if (accessDecision.decision === 'deny') {
      return { kind: 'deny', reason: accessDecision.justification };
    }

    // 6) 外部写入预算：达到上限后新的外部写动作直接拒绝（先于 confirm 返回）。
    // — English: external write budget — reject when the limit is reached, before returning confirm.
    if (isExternal && this.externalWriteCount >= this.maxExternalWrites) {
      return { kind: 'deny', reason: 'WRITE_BUDGET' };
    }

    // 5a) 现有策略判定 prompt = 需要用户临时授权：必须转成 confirm，不能直接放行。
    // — English: an existing-policy prompt means user authorization is required —
    //   it must surface as confirm, never as an implicit allow.
    if (accessDecision.decision === 'prompt') {
      return {
        kind: 'confirm',
        reason: accessDecision.justification,
        approvalRequest: this.buildApprovalRequest(intent, request, targetUrl, accessDecision.justification),
      };
    }

    // 5b) 风险与副作用确认。
    // — English: risk and side-effect confirmation.
    const reason = this.confirmationReason(intent, isExternal);
    if (reason) {
      return {
        kind: 'confirm',
        reason,
        approvalRequest: this.buildApprovalRequest(intent, request, targetUrl, reason),
      };
    }

    // 7) 全部通过。
    // — English: every check passed.
    return { kind: 'allow' };
  }

  // 精确 host 的 network allow 规则（策略已归一化：host 小写、去空白，host 为空不参与匹配）。
  // — English: exact-host network allow rule lookup against the normalized policy.
  private hasExactNetworkAllow(host: string): boolean {
    const normalized = host.toLowerCase();
    return this.policy.persistentRules.some(
      (rule) =>
        rule.effect === 'allow' &&
        rule.access === 'network' &&
        rule.target.kind === 'network' &&
        rule.target.host !== '' &&
        rule.target.host === normalized,
    );
  }

  // 映射动作意图为访问请求：
  //   navigate/download → network；submit 或 external_* 副作用 → write（host 取页面 URL，拿不到用目标 URL）；
  //   其它 → tool_call（browser.<kind>）。navigate/download 无法解析目标 URL 时返回 null。
  // — English: map intent to AccessRequest — network for navigate/download, write for submit or
  //   external effects (page host first, target URL host as fallback), tool_call otherwise.
  private buildAccessRequest(
    intent: ActionIntent,
    targetUrl: URL | null,
    pageUrl: string | undefined,
    isNetworkKind: boolean,
    isExternal: boolean,
  ): AccessRequest | null {
    let access: AccessRequest['access'];
    let target: AccessTarget;
    if (isNetworkKind) {
      if (!targetUrl) return null;
      access = 'network';
      target = { kind: 'network', host: targetUrl.host };
    } else if (intent.kind === 'submit' || isExternal) {
      access = 'write';
      target = { kind: 'network', host: resolveHost(pageUrl) ?? targetUrl?.host ?? '' };
    } else {
      access = 'tool_call';
      target = { kind: 'tool', toolName: `browser.${intent.kind}` };
    }
    return {
      access,
      target,
      threadId: this.threadId,
      turnId: this.turnId,
      toolName: `browser.${intent.kind}`,
      toolCallId: intent.actionId,
      description: intent.rationale,
    };
  }

  // 确认理由：external 副作用必须确认（架构硬约束）；high/critical 风险必须确认，
  // 除非 grant 声明了不低于该风险的 confirmationThreshold。
  // — English: confirmation reason — external effects always confirm; high/critical risk confirms
  //   unless the grant's confirmationThreshold covers it.
  private confirmationReason(intent: ActionIntent, isExternal: boolean): string | null {
    const parts: string[] = [];
    if (isExternal) {
      parts.push(`外部副作用（${intent.effect}）：${intent.rationale}`);
    }
    const grantCoversRisk =
      this.grant !== undefined &&
      RISK_SEVERITY[intent.risk] <= RISK_SEVERITY[this.grant.confirmationThreshold];
    if ((intent.risk === 'high' || intent.risk === 'critical') && !grantCoversRisk) {
      parts.push(`高风险动作（${intent.risk}）：${intent.rationale}`);
    }
    return parts.length > 0 ? parts.join('；') : null;
  }

  // 构造审批请求：navigate/download → network，其它 → tool_call。
  // — English: build the ApprovalRequest — network for navigate/download, tool_call otherwise.
  private buildApprovalRequest(
    intent: ActionIntent,
    request: AccessRequest,
    targetUrl: URL | null,
    reason: string,
  ): ApprovalRequest {
    const kind = intent.kind === 'navigate' || intent.kind === 'download' ? 'network' : 'tool_call';
    const payload: Record<string, unknown> = {
      actionId: intent.actionId,
      kind: intent.kind,
      risk: intent.risk,
      effect: intent.effect,
    };
    if (targetUrl) payload.url = withoutUserInfo(targetUrl).toString();
    return {
      requestId: `br-${intent.actionId}`,
      threadId: this.threadId,
      turnId: this.turnId,
      itemId: `item-browser-${intent.actionId}`,
      kind,
      description: intent.rationale,
      payload,
      decision: 'prompt',
      justification: reason,
      accessRequest: request,
    };
  }
}

// 页面 host：解析失败（缺省或非法）返回 null，由调用方决定回退来源。
// — English: page host — null when the page URL is missing or unparsable.
function resolveHost(pageUrl?: string): string | null {
  if (!pageUrl) return null;
  try {
    return new URL(pageUrl).host;
  } catch {
    return null;
  }
}

// 去掉 URL userinfo（user:pass@），避免凭据进入审批请求/日志。
// — English: strips URL userinfo so credentials never reach approvals/logs.
function withoutUserInfo(url: URL): URL {
  url.username = '';
  url.password = '';
  return url;
}
