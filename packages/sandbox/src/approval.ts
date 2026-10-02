// 引入协议层的审批请求类型
import type { ApprovalRequest, PersistentAccessScope, TemporaryAccessScope } from '@suanlizi/protocol';

/**
 * Callback interface for Human-In-The-Loop approval.
 * Implementations can prompt the user (CLI, Web UI, etc.).
 */
// 审批处理器接口：HITL（人机协同）审批回调
// 不同前端（CLI / Web / 桌面 / 微信）可以实现这个接口来弹窗
export interface ApprovalHandler {
  /** Request approval. Returns the user's decision. */
  // 发起一次审批请求，返回用户最终决定
  requestApproval(req: ApprovalRequest): Promise<{ approved: boolean; reason?: string; temporaryScope?: TemporaryAccessScope; persistentScope?: PersistentAccessScope }>;
}

/** A no-op handler that auto-denies everything (safest default). */
// 默认拒绝处理器：所有审批请求一律拒绝（最安全兜底）
export class DenyAllApprovalHandler implements ApprovalHandler {
  async requestApproval(_req: ApprovalRequest) {
    return { approved: false, reason: 'No approval handler configured — denying by default' };
  }
}

/** Auto-approve handler (for trusted environments). */
// 自动通过处理器：所有审批请求一律通过（仅用于受信任环境）
export class AutoApproveHandler implements ApprovalHandler {
  async requestApproval(_req: ApprovalRequest) {
    return { approved: true, reason: 'auto-approved' };
  }
}
