// 工具治理中间件：为 runtime 提供工具调用频率限制、工具黑名单、只读沙箱检查、命令执行策略以及人工审批等能力。
import type { ApprovalHandler, PermissionPreset, Sandbox } from '@suanlizi/sandbox';
import type { AccessRequest, ApprovalRequest } from '@suanlizi/protocol';
import type { RuntimeMiddleware, RuntimeToolResponse } from './middleware.js';

// ToolGovernanceConfig：工具治理策略配置
export interface ToolGovernanceConfig {
  /** Per-tool call limits within one turn. */
  /** 单 turn 内每个工具的调用次数上限（key 为工具名，value 为最大次数）。 */
  rateLimits?: Record<string, number>;
  /** Tools that must never run in this runtime profile. */
  /** 本运行配置下一律禁止执行的工具列表（黑名单）。 */
  blockedTools?: string[];
  /** Tools that require approval even if their own definition does not. */
  /** 即使工具自身定义不需要审批，也强制要求人工审批的工具列表。 */
  forceApprovalTools?: string[];
}

// ToolGovernanceMiddlewareOptions：创建工具治理中间件的依赖项与配置
export interface ToolGovernanceMiddlewareOptions {
  /** 人工审批请求处理器（用于同步或异步等待用户确认）。 */
  approvalHandler: ApprovalHandler;
  /** 权限预设（如 approval='never' 可关闭审批）。 */
  preset?: PermissionPreset;
  /** 沙箱实例访问器，用于评估命令执行策略。 */
  sandbox: () => Sandbox;
  /** 可选的治理策略配置，未提供时使用默认行为。 */
  governance?: ToolGovernanceConfig;
}

// 创建工具治理中间件：在 beforeTool 中依次执行黑名单检查、频率检查、只读沙箱检查、命令策略检查以及人工审批
export function createToolGovernanceMiddleware(options: ToolGovernanceMiddlewareOptions): RuntimeMiddleware {
  const callsByTurn = new Map<string, Map<string, number>>();
  const blockedTools = new Set(options.governance?.blockedTools ?? []);
  const forceApprovalTools = new Set(options.governance?.forceApprovalTools ?? []);
  const rateLimits = options.governance?.rateLimits ?? {};

  return {
    beforeTool: async (ctx, request) => {
      if (blockedTools.has(request.toolName)) {
        return failedGovernanceResponse(
          ctx.locale === 'zh'
            ? `工具 "${request.toolName}" 已被当前工具治理策略禁用。`
            : `Tool "${request.toolName}" is blocked by the current tool governance policy.`,
          'TOOL_BLOCKED',
        );
      }

      const limit = rateLimits[request.toolName];
      if (typeof limit === 'number' && limit >= 0) {
        const turnCalls = callsByTurn.get(ctx.turnId) ?? new Map<string, number>();
        callsByTurn.set(ctx.turnId, turnCalls);
        const nextCount = (turnCalls.get(request.toolName) ?? 0) + 1;
        turnCalls.set(request.toolName, nextCount);
        if (nextCount > limit) {
          return failedGovernanceResponse(
            ctx.locale === 'zh'
              ? `工具 "${request.toolName}" 本轮调用次数已超过 ${limit} 次上限。`
              : `Tool "${request.toolName}" exceeded the per-turn limit of ${limit}.`,
            'TOOL_RATE_LIMIT_REACHED',
          );
        }
      }

      if (request.toolDef?.requiredPolicy === 'workspace_write' && ctx.permissions.level === 'readonly') {
        return failedGovernanceResponse(
          ctx.locale === 'zh'
            ? `当前只读沙箱拒绝执行工具 "${request.toolName}"。`
            : `Readonly sandbox rejected tool "${request.toolName}".`,
          'SANDBOX_DENIED',
        );
      }

      if (request.toolName === 'shell_command' && typeof request.args.command === 'string') {
        const execResult = options.sandbox().evaluateCommand(request.args.command);
        if (execResult.decision === 'forbidden') {
          const reason = execResult.matchedRules[0]?.justification ?? 'Blocked by exec policy';
          return failedGovernanceResponse(
            ctx.locale === 'zh' ? `已拒绝：${reason}` : `Rejected: ${reason}`,
            'EXEC_POLICY_DENIED',
          );
        }
      }

      const requiresApproval = options.preset?.approval === 'never'
        ? false
        : request.toolDef?.requiresApproval === true || forceApprovalTools.has(request.toolName);
      if (!requiresApproval) return undefined;

      // browser_navigate 会在工具执行前按目标主机申请网络访问；这里不再生成
      // 第二个泛化 tool_call 审批，以免用户为同一次导航确认两遍。
      if (request.toolName === 'browser_navigate' || request.toolName === 'browser_download') return undefined;

      const accessRequest = accessRequestForTool(ctx, request);
      if (typeof request.toolContext.requestAccess === 'function') {
        const decision = await request.toolContext.requestAccess(accessRequest);
        await ctx.audit?.({
          category: 'approval',
          type: 'approval.resolved',
          level: decision.decision === 'allow' ? 'info' : 'warning',
          message: decision.decision === 'allow'
            ? `Approval granted for ${request.toolName}`
            : `Approval denied for ${request.toolName}`,
          toolName: request.toolName,
          metadata: {
            status: decision.decision === 'allow' ? 'approved' : 'denied',
            reason: decision.justification,
            toolName: request.toolName,
          },
        });
        if (decision.decision !== 'allow') {
          return failedGovernanceResponse(
            ctx.locale === 'zh' ? `已拒绝：${decision.justification}` : `Rejected: ${decision.justification}`,
            'APPROVAL_DENIED',
          );
        }
        request.toolContext.approved = true;
        return undefined;
      }

      const approvalReq: ApprovalRequest = {
        requestId: generateApprovalId(),
        threadId: ctx.threadId,
        turnId: ctx.turnId,
        itemId: `approval_${ctx.turnId}_${Date.now()}`,
        kind: request.toolName === 'shell_command' ? 'command' : 'file_write',
        description: `Execute ${request.toolName}: ${JSON.stringify(request.args).slice(0, 200)}`,
        payload: request.args,
        decision: 'prompt',
        accessRequest,
      };

      ctx.emit({
        type: 'approval.required',
        threadId: ctx.threadId,
        turnId: ctx.turnId,
        itemId: approvalReq.itemId,
        requestId: approvalReq.requestId,
        kind: approvalReq.kind,
        description: approvalReq.description,
        payload: approvalReq.payload,
        decision: 'prompt',
      });
      await ctx.audit?.({
        category: 'approval',
        type: 'approval.required',
        message: approvalReq.description,
        toolName: request.toolName,
        metadata: {
          requestId: approvalReq.requestId,
          status: 'required',
          kind: approvalReq.kind,
          toolName: request.toolName,
        },
      });

      const approval = await options.approvalHandler.requestApproval(approvalReq);
      await ctx.audit?.({
        category: 'approval',
        type: 'approval.resolved',
        level: approval.approved ? 'info' : 'warning',
        message: approval.approved ? `Approval granted for ${request.toolName}` : `Approval denied for ${request.toolName}`,
        toolName: request.toolName,
        metadata: {
          requestId: approvalReq.requestId,
          status: approval.approved ? 'approved' : 'denied',
          reason: approval.reason ?? null,
          toolName: request.toolName,
        },
      });
      if (!approval.approved) {
        const reason = approval.reason ?? 'denied';
        return failedGovernanceResponse(
          ctx.locale === 'zh' ? `已拒绝：${reason}` : `Rejected: ${reason}`,
          'APPROVAL_DENIED',
        );
      }
      request.toolContext.approved = true;
      return undefined;
    },
    afterTurn: (ctx) => {
      callsByTurn.delete(ctx.turnId);
    },
  };
}

function accessRequestForTool(ctx: Parameters<NonNullable<RuntimeMiddleware['beforeTool']>>[0], request: {
  toolCall: { id?: string };
  toolName: string;
  args: Record<string, unknown>;
}): AccessRequest {
  if (request.toolName === 'shell_command' && typeof request.args.command === 'string') {
    return {
      access: 'command',
      target: { kind: 'command', command: request.args.command },
      threadId: ctx.threadId,
      turnId: ctx.turnId,
      toolCallId: request.toolCall.id,
      toolName: request.toolName,
      description: `执行命令：${request.args.command.slice(0, 200)}`,
    };
  }
  const actionKind = request.toolName === 'browser_act' && typeof request.args.kind === 'string'
    ? `:${request.args.kind}`
    : '';
  return {
    access: 'tool_call',
    target: { kind: 'tool', toolName: `${request.toolName}${actionKind}` },
    threadId: ctx.threadId,
    turnId: ctx.turnId,
    toolCallId: request.toolCall.id,
    toolName: request.toolName,
    description: `执行工具：${request.toolName}${actionKind}`,
  };
}

// 构造工具治理失败的统一响应：将状态标记为 failed，携带错误码
function failedGovernanceResponse(message: string, code: string): RuntimeToolResponse {
  return {
    output: message,
    status: 'failed',
    error: { message, code },
  };
}

// 生成审批请求的唯一 id：时间戳 + 随机字符串
function generateApprovalId(): string {
  return `approval_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}
