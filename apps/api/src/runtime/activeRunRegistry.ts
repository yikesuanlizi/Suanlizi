export interface ActiveRunHandle {
  runId: string;
  threadId: string;
  turnId: string;
  interrupt(): Promise<void> | void;
  resolveDecision?(response: { requestId: string; action: 'way_one' | 'way_two' | 'custom_input' | 'cancel' | 'confirm'; optionId?: string; customInput?: string }): Promise<{ accepted: boolean; resumed: boolean }>;
}

export class ActiveRunRegistry {
  private handles = new Map<string, ActiveRunHandle>();
  private topLevelReservations = new Set<string>();
  private idleWaiters = new Map<string, Set<() => void>>();

  /** Reserve a top-level task slot before constructing/running an AgentLoop. */
  tryReserveTopLevel(reservationId: string, maxActiveTasks: number): boolean {
    if (this.topLevelReservations.has(reservationId)) return true;
    const limit = Number.isFinite(maxActiveTasks) ? Math.max(1, Math.floor(maxActiveTasks)) : 4;
    if (this.topLevelReservations.size >= limit) return false;
    this.topLevelReservations.add(reservationId);
    return true;
  }

  releaseTopLevel(reservationId: string): void {
    this.topLevelReservations.delete(reservationId);
  }

  activeTopLevelCount(): number {
    return this.topLevelReservations.size;
  }

  register(handle: ActiveRunHandle): () => void {
    this.handles.set(handle.runId, handle);
    return () => this.finish(handle.runId);
  }

  get(runId: string): ActiveRunHandle | null {
    return this.handles.get(runId) ?? null;
  }

  getByThreadId(threadId: string): ActiveRunHandle | null {
    for (const handle of this.handles.values()) {
      if (handle.threadId === threadId) return handle;
    }
    return null;
  }

  finish(runId: string): void {
    const handle = this.handles.get(runId);
    if (!handle) return;
    this.handles.delete(runId);
    if (!Array.from(this.handles.values()).some((entry) => entry.threadId === handle.threadId)) {
      const waiters = this.idleWaiters.get(handle.threadId);
      if (waiters) {
        this.idleWaiters.delete(handle.threadId);
        for (const wake of waiters) wake();
      }
    }
  }

  /** Wait until a thread has no active run. A zero timeout performs a snapshot. */
  waitForThreadIdle(threadId: string, timeoutMs = 5_000): Promise<boolean> {
    if (!this.getByThreadId(threadId)) return Promise.resolve(true);
    if (timeoutMs <= 0) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const waiters = this.idleWaiters.get(threadId) ?? new Set<() => void>();
      const timer = setTimeout(() => finish(false), timeoutMs);
      timer.unref?.();
      const wake = (): void => finish(true);
      const finish = (idle: boolean): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        waiters.delete(wake);
        if (waiters.size === 0) this.idleWaiters.delete(threadId);
        resolve(idle);
      };
      waiters.add(wake);
      this.idleWaiters.set(threadId, waiters);
      if (!this.getByThreadId(threadId)) finish(true);
    });
  }

  has(runId: string): boolean {
    return this.handles.has(runId);
  }

  listActiveRunIds(): string[] {
    return Array.from(this.handles.keys());
  }

  clear(): void {
    this.handles.clear();
    this.topLevelReservations.clear();
    for (const waiters of this.idleWaiters.values()) {
      for (const wake of waiters) wake();
    }
    this.idleWaiters.clear();
  }
}
