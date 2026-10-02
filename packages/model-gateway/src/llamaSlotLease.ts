/**
 * Thread-scoped leases for llama.cpp prompt-cache slots.
 *
 * The manager deliberately returns null when all slots are occupied. The
 * caller can then use llama.cpp's normal LCP scheduler instead of pretending
 * that a different conversation still owns a warm slot.
 */
export interface LlamaSlotLease {
  threadId: string;
  fingerprint: string;
  slotId: number;
  epoch: string;
  acquiredAt: number;
  lastUsedAt: number;
}

export interface AcquireLlamaSlotInput {
  threadId: string;
  fingerprint: string;
  epoch: string;
  now?: number;
}

export class LlamaSlotLeaseManager {
  private readonly leases = new Map<string, LlamaSlotLease>();
  private readonly capacities = new Map<string, number>();

  constructor(
    private readonly defaultMaxSlots = 1,
    private readonly idleTtlMs = 30 * 60 * 1000,
  ) {
    if (!Number.isInteger(defaultMaxSlots) || defaultMaxSlots < 1) throw new Error('maxSlots must be a positive integer');
    if (!Number.isFinite(idleTtlMs) || idleTtlMs < 0) throw new Error('idleTtlMs must be non-negative');
  }

  acquire(input: AcquireLlamaSlotInput): LlamaSlotLease | null {
    const threadId = input.threadId.trim();
    const fingerprint = input.fingerprint.trim();
    const epoch = input.epoch.trim();
    if (!threadId || !fingerprint || !epoch) return null;
    const key = this.key(threadId, fingerprint);
    const now = input.now ?? Date.now();
    this.pruneIdle(fingerprint, now);
    const existing = this.leases.get(key);
    if (existing && existing.epoch === epoch) {
      existing.lastUsedAt = now;
      return { ...existing };
    }
    if (existing) this.leases.delete(key);
    // Each llama server connection owns an independent slot pool. Never let
    // an unrelated endpoint consume this connection's slot capacity.
    const occupied = new Set([...this.leases.values()]
      .filter((lease) => lease.fingerprint === fingerprint)
      .map((lease) => lease.slotId));
    let slotId = -1;
    const maxSlots = this.capacities.get(fingerprint) ?? this.defaultMaxSlots;
    for (let candidate = 0; candidate < maxSlots; candidate += 1) {
      if (!occupied.has(candidate)) { slotId = candidate; break; }
    }
    if (slotId < 0) return null;
    const lease: LlamaSlotLease = {
      threadId,
      fingerprint,
      slotId,
      epoch,
      acquiredAt: now,
      lastUsedAt: now,
    };
    this.leases.set(key, lease);
    return { ...lease };
  }

  /** Apply the server-reported -np capacity without invalidating valid leases. */
  setCapacity(fingerprint: string, capacity: number): void {
    const normalized = fingerprint.trim();
    if (!normalized || !Number.isInteger(capacity) || capacity < 1) return;
    this.capacities.set(normalized, capacity);
    for (const [key, lease] of this.leases) {
      if (lease.fingerprint === normalized && lease.slotId >= capacity) this.leases.delete(key);
    }
  }

  release(threadId: string, fingerprint: string): boolean {
    return this.leases.delete(this.key(threadId.trim(), fingerprint.trim()));
  }

  invalidateEpoch(epoch: string): number {
    let removed = 0;
    for (const [key, lease] of this.leases) {
      if (lease.epoch !== epoch) {
        this.leases.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  /** Remove leases for one llama endpoint when its /props probe fails. */
  invalidateFingerprint(fingerprint: string): number {
    const normalized = fingerprint.trim();
    if (!normalized) return 0;
    let removed = 0;
    for (const [key, lease] of this.leases) {
      if (lease.fingerprint !== normalized) continue;
      this.leases.delete(key);
      removed += 1;
    }
    return removed;
  }

  /** Keep only leases matching the current server capability epoch. */
  invalidateFingerprintExceptEpoch(fingerprint: string, epoch: string): number {
    const normalized = fingerprint.trim();
    const expected = epoch.trim();
    if (!normalized || !expected) return 0;
    let removed = 0;
    for (const [key, lease] of this.leases) {
      if (lease.fingerprint !== normalized || lease.epoch === expected) continue;
      this.leases.delete(key);
      removed += 1;
    }
    return removed;
  }

  /** Release all leases held by a deleted/closed conversation. */
  releaseThread(threadId: string): number {
    const normalized = threadId.trim();
    if (!normalized) return 0;
    let removed = 0;
    for (const [key, lease] of this.leases) {
      if (lease.threadId !== normalized) continue;
      this.leases.delete(key);
      removed += 1;
    }
    return removed;
  }

  snapshot(): LlamaSlotLease[] {
    return [...this.leases.values()].map((lease) => ({ ...lease }));
  }

  private pruneIdle(fingerprint: string, now: number): void {
    if (this.idleTtlMs === 0) return;
    for (const [key, lease] of this.leases) {
      if (lease.fingerprint === fingerprint && now - lease.lastUsedAt >= this.idleTtlMs) {
        this.leases.delete(key);
      }
    }
  }

  private key(threadId: string, fingerprint: string): string {
    return `${fingerprint}\u0000${threadId}`;
  }
}
