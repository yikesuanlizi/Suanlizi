import { describe, expect, it } from 'vitest';
import { LlamaSlotLeaseManager } from './llamaSlotLease.js';

describe('LlamaSlotLeaseManager', () => {
  it('reuses the same slot for the same thread and connection epoch', () => {
    const manager = new LlamaSlotLeaseManager(2);

    const first = manager.acquire({ threadId: 'thread-a', fingerprint: 'llama-a', epoch: 'epoch-1', now: 10 });
    const reused = manager.acquire({ threadId: 'thread-a', fingerprint: 'llama-a', epoch: 'epoch-1', now: 20 });

    expect(first).toMatchObject({ threadId: 'thread-a', slotId: 0, acquiredAt: 10, lastUsedAt: 10 });
    expect(reused).toMatchObject({ threadId: 'thread-a', slotId: 0, acquiredAt: 10, lastUsedAt: 20 });
    expect(manager.snapshot()).toHaveLength(1);
  });

  it('keeps leases isolated by thread and fingerprint and refuses a full pool', () => {
    const manager = new LlamaSlotLeaseManager(2);

    const a = manager.acquire({ threadId: 'thread-a', fingerprint: 'llama-a', epoch: 'epoch-1' });
    const b = manager.acquire({ threadId: 'thread-b', fingerprint: 'llama-a', epoch: 'epoch-1' });
    const differentConnection = manager.acquire({ threadId: 'thread-a', fingerprint: 'llama-b', epoch: 'epoch-1' });

    expect(a?.slotId).toBe(0);
    expect(b?.slotId).toBe(1);
    expect(differentConnection).toMatchObject({ threadId: 'thread-a', fingerprint: 'llama-b', slotId: 0 });
  });

  it('replaces a stale epoch lease while preserving the released slot', () => {
    const manager = new LlamaSlotLeaseManager(2);
    const old = manager.acquire({ threadId: 'thread-a', fingerprint: 'llama-a', epoch: 'epoch-1' });
    manager.acquire({ threadId: 'thread-b', fingerprint: 'llama-a', epoch: 'epoch-1' });

    const refreshed = manager.acquire({ threadId: 'thread-a', fingerprint: 'llama-a', epoch: 'epoch-2', now: 30 });
    expect(old?.slotId).toBe(0);
    expect(refreshed).toMatchObject({ threadId: 'thread-a', fingerprint: 'llama-a', epoch: 'epoch-2', slotId: 0, acquiredAt: 30 });
    expect(manager.snapshot()).toHaveLength(2);
  });

  it('invalidates leases from epochs other than the active server epoch', () => {
    const manager = new LlamaSlotLeaseManager(2);
    manager.acquire({ threadId: 'thread-a', fingerprint: 'llama-a', epoch: 'epoch-1' });
    manager.acquire({ threadId: 'thread-b', fingerprint: 'llama-a', epoch: 'epoch-2' });

    expect(manager.invalidateEpoch('epoch-2')).toBe(1);
    expect(manager.snapshot()).toEqual([
      expect.objectContaining({ threadId: 'thread-b', epoch: 'epoch-2' }),
    ]);
  });

  it('does not create leases for blank identifiers', () => {
    const manager = new LlamaSlotLeaseManager(2);
    expect(manager.acquire({ threadId: ' ', fingerprint: 'llama-a', epoch: 'epoch-1' })).toBeNull();
    expect(manager.acquire({ threadId: 'thread-a', fingerprint: '', epoch: 'epoch-1' })).toBeNull();
    expect(manager.acquire({ threadId: 'thread-a', fingerprint: 'llama-a', epoch: ' ' })).toBeNull();
  });

  it('reclaims an idle lease for the same connection without affecting other connections', () => {
    const manager = new LlamaSlotLeaseManager(1, 100);
    manager.acquire({ threadId: 'thread-a', fingerprint: 'llama-a', epoch: 'epoch-1', now: 10 });
    expect(manager.acquire({ threadId: 'thread-b', fingerprint: 'llama-a', epoch: 'epoch-1', now: 50 })).toBeNull();
    expect(manager.acquire({ threadId: 'thread-b', fingerprint: 'llama-a', epoch: 'epoch-1', now: 111 }))
      .toMatchObject({ threadId: 'thread-b', slotId: 0 });
  });

  it('updates capacity from server props and releases leases above the new bound', () => {
    const manager = new LlamaSlotLeaseManager(1);
    manager.setCapacity('llama-a', 2);
    expect(manager.acquire({ threadId: 'thread-a', fingerprint: 'llama-a', epoch: 'epoch-1' })?.slotId).toBe(0);
    expect(manager.acquire({ threadId: 'thread-b', fingerprint: 'llama-a', epoch: 'epoch-1' })?.slotId).toBe(1);
    manager.setCapacity('llama-a', 1);
    expect(manager.snapshot()).toEqual([
      expect.objectContaining({ threadId: 'thread-a', slotId: 0 }),
    ]);
  });

  it('invalidates only one endpoint when its server probe fails', () => {
    const manager = new LlamaSlotLeaseManager(2);
    manager.acquire({ threadId: 'thread-a', fingerprint: 'llama-a', epoch: 'epoch-1' });
    manager.acquire({ threadId: 'thread-b', fingerprint: 'llama-b', epoch: 'epoch-1' });

    expect(manager.invalidateFingerprint('llama-a')).toBe(1);
    expect(manager.snapshot()).toEqual([
      expect.objectContaining({ threadId: 'thread-b', fingerprint: 'llama-b' }),
    ]);
  });

  it('drops stale leases for one endpoint when its capability epoch changes', () => {
    const manager = new LlamaSlotLeaseManager(2);
    manager.acquire({ threadId: 'thread-a', fingerprint: 'llama-a', epoch: 'epoch-1' });
    manager.acquire({ threadId: 'thread-b', fingerprint: 'llama-a', epoch: 'epoch-2' });
    manager.acquire({ threadId: 'thread-c', fingerprint: 'llama-b', epoch: 'epoch-1' });

    expect(manager.invalidateFingerprintExceptEpoch('llama-a', 'epoch-2')).toBe(1);
    expect(manager.snapshot()).toEqual([
      expect.objectContaining({ threadId: 'thread-b', epoch: 'epoch-2' }),
      expect.objectContaining({ threadId: 'thread-c', fingerprint: 'llama-b' }),
    ]);
  });

  it('releases all endpoint leases owned by a deleted thread', () => {
    const manager = new LlamaSlotLeaseManager(2);
    manager.acquire({ threadId: 'thread-a', fingerprint: 'llama-a', epoch: 'epoch-1' });
    manager.acquire({ threadId: 'thread-a', fingerprint: 'llama-b', epoch: 'epoch-1' });
    manager.acquire({ threadId: 'thread-b', fingerprint: 'llama-a', epoch: 'epoch-1' });

    expect(manager.releaseThread('thread-a')).toBe(2);
    expect(manager.snapshot()).toEqual([
      expect.objectContaining({ threadId: 'thread-b' }),
    ]);
  });
});
