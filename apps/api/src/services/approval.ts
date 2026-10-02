import type { ApprovalHandler } from '@suanlizi/sandbox';
import type { ApprovalLogEntry, ApprovalRequest, PersistentAccessScope, TemporaryAccessScope } from '@suanlizi/protocol';

interface PendingApproval {
  request: ApprovalRequest;
  requestedAt: string;
  resolve: (response: { approved: boolean; reason?: string; temporaryScope?: TemporaryAccessScope; persistentScope?: PersistentAccessScope }) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class WebApprovalBroker implements ApprovalHandler {
  private pending = new Map<string, PendingApproval>();
  private history: ApprovalLogEntry[] = [];

  constructor(
    private readonly timeoutMs = 60 * 1000,
    private readonly onResolved?: (entry: ApprovalLogEntry) => void,
  ) {}

  requestApproval(req: ApprovalRequest): Promise<{ approved: boolean; reason?: string; temporaryScope?: TemporaryAccessScope; persistentScope?: PersistentAccessScope }> {
    return new Promise((resolve) => {
      const requestedAt = new Date().toISOString();
      const timer = setTimeout(() => {
        const entry = this.pending.get(req.requestId);
        this.pending.delete(req.requestId);
        this.record(entry?.request ?? req, requestedAt, false, 'approval timeout', 'timeout');
        resolve({
          approved: false,
          reason: 'approval timeout',
        });
      }, this.timeoutMs);
      this.pending.set(req.requestId, { request: req, requestedAt, resolve, timer });
    });
  }

  listPending(): ApprovalRequest[] {
    return [...this.pending.values()].map((entry) => entry.request);
  }

  getPending(requestId: string): ApprovalRequest | undefined {
    return this.pending.get(requestId)?.request;
  }

  decide(requestId: string, approved: boolean, reason?: string): boolean {
    return this.decideWithScope(requestId, approved, reason);
  }

  decideWithScope(
    requestId: string,
    approved: boolean,
    reason?: string,
    temporaryScope?: TemporaryAccessScope,
    persistentScope?: PersistentAccessScope,
  ): boolean {
    const entry = this.pending.get(requestId);
    if (!entry) return false;
    clearTimeout(entry.timer);
    this.pending.delete(requestId);
    this.record(entry.request, entry.requestedAt, approved, reason, approved ? 'approved' : 'denied');
    entry.resolve({
      approved,
      reason,
      ...(temporaryScope ? { temporaryScope } : {}),
      ...(persistentScope ? { persistentScope } : {}),
    });
    return true;
  }

  listHistory(): ApprovalLogEntry[] {
    return [...this.history];
  }

  private record(
    request: ApprovalRequest,
    requestedAt: string,
    approved: boolean,
    reason: string | undefined,
    status: ApprovalLogEntry['status'],
  ): void {
    const entry: ApprovalLogEntry = {
      requestId: request.requestId,
      threadId: request.threadId,
      turnId: request.turnId,
      itemId: request.itemId,
      kind: request.kind,
      description: request.description,
      approved,
      reason,
      status,
      requestedAt,
      resolvedAt: new Date().toISOString(),
    };
    this.history.push(entry);
    if (this.history.length > 200) {
      this.history = this.history.slice(-200);
    }
    this.onResolved?.(entry);
  }
}
