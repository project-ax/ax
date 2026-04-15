import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createSessionManager, type SessionManager } from '../../src/host/session-manager.js';

describe('SessionManager', () => {
  let manager: SessionManager;
  const onKill = vi.fn();

  beforeEach(() => {
    vi.useFakeTimers();
    manager = createSessionManager({
      idleTimeoutMs: 10_000,
      cleanIdleTimeoutMs: 5_000,
      warningLeadMs: 2_000,
      onKill,
    });
  });

  afterEach(() => {
    manager.shutdown();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // ── Registration & Retrieval ──

  it('registers and retrieves a session', () => {
    const kill = vi.fn();
    manager.register('s1', { pid: 1, kill, podName: 'pod-1' });
    expect(manager.has('s1')).toBe(true);
    const entry = manager.get('s1');
    expect(entry?.pid).toBe(1);
    expect(entry?.podName).toBe('pod-1');
    expect(entry?.dirty).toBe(false);
  });

  it('returns undefined for unknown session', () => {
    expect(manager.get('unknown')).toBeUndefined();
    expect(manager.has('unknown')).toBe(false);
  });

  it('removes a session', () => {
    manager.register('s1', { pid: 1, kill: vi.fn() });
    manager.remove('s1');
    expect(manager.has('s1')).toBe(false);
  });

  // ── Dirty tracking ──

  it('marks session dirty', () => {
    manager.register('s1', { pid: 1, kill: vi.fn() });
    manager.markDirty('s1');
    expect(manager.get('s1')?.dirty).toBe(true);
  });

  it('markDirty is idempotent', () => {
    manager.register('s1', { pid: 1, kill: vi.fn() });
    manager.markDirty('s1');
    manager.markDirty('s1'); // no-op
    expect(manager.get('s1')?.dirty).toBe(true);
  });

  // ── Work queue ──

  it('queues and claims work', () => {
    manager.register('s1', { pid: 1, kill: vi.fn() });
    manager.queueWork('s1', '{"message":"hello"}');
    const work = manager.claimWork('s1');
    expect(work).toBe('{"message":"hello"}');
    // Second claim returns undefined
    expect(manager.claimWork('s1')).toBeUndefined();
  });

  it('claimWork returns undefined when no work queued', () => {
    manager.register('s1', { pid: 1, kill: vi.fn() });
    expect(manager.claimWork('s1')).toBeUndefined();
  });

  it('latest queueWork overwrites previous', () => {
    manager.register('s1', { pid: 1, kill: vi.fn() });
    manager.queueWork('s1', 'first');
    manager.queueWork('s1', 'second');
    expect(manager.claimWork('s1')).toBe('second');
  });

  // ── Auth token mapping ──

  it('maps auth token to session', () => {
    manager.register('s1', { pid: 1, kill: vi.fn(), authToken: 'tok-1' });
    expect(manager.findSessionByToken('tok-1')).toBe('s1');
  });

  it('findSessionByToken returns undefined for unknown token', () => {
    expect(manager.findSessionByToken('unknown')).toBeUndefined();
  });

  it('remove clears auth token mapping', () => {
    manager.register('s1', { pid: 1, kill: vi.fn(), authToken: 'tok-1' });
    manager.remove('s1');
    expect(manager.findSessionByToken('tok-1')).toBeUndefined();
  });

  // ── Active sessions ──

  it('lists active sessions', () => {
    manager.register('s1', { pid: 1, kill: vi.fn() });
    manager.register('s2', { pid: 2, kill: vi.fn() });
    expect(manager.activeSessions()).toEqual(expect.arrayContaining(['s1', 's2']));
    expect(manager.activeSessions()).toHaveLength(2);
  });

  // ── Idle timeout ──

  it('kills clean session after cleanIdleTimeoutMs', async () => {
    const kill = vi.fn();
    manager.register('s1', { pid: 1, kill });

    // cleanIdleTimeoutMs=5000, warningLeadMs=2000 → warning at 3000ms
    vi.advanceTimersByTime(3_001);
    // Flush the async onExpiring callback
    await vi.advanceTimersByTimeAsync(0);
    // Kill fires 2000ms after warning
    vi.advanceTimersByTime(2_001);
    expect(kill).toHaveBeenCalled();
    expect(onKill).toHaveBeenCalledWith('s1', expect.objectContaining({ pid: 1 }));
    expect(manager.has('s1')).toBe(false);
  });

  it('dirty session uses longer idle timeout', async () => {
    const kill = vi.fn();
    manager.register('s1', { pid: 1, kill });
    manager.markDirty('s1');

    // At 5s (clean timeout), session should still be alive (using dirty 10s timeout)
    vi.advanceTimersByTime(5_001);
    await vi.advanceTimersByTimeAsync(0);
    expect(kill).not.toHaveBeenCalled();

    // idleTimeoutMs=10000, warningLeadMs=2000 → warning at 8000ms
    vi.advanceTimersByTime(3_000); // now at ~8s
    await vi.advanceTimersByTimeAsync(0);
    // Kill fires 2s after warning
    vi.advanceTimersByTime(2_001);
    expect(kill).toHaveBeenCalled();
  });

  it('touch resets the idle timer', async () => {
    const kill = vi.fn();
    manager.register('s1', { pid: 1, kill });

    // Advance 2.5s (approaching clean warning at 3s)
    vi.advanceTimersByTime(2_500);
    expect(kill).not.toHaveBeenCalled();

    // Touch resets the timer
    manager.touch('s1');

    // Another 2.5s — still alive because timer was reset (warning at 3s from touch)
    vi.advanceTimersByTime(2_500);
    expect(kill).not.toHaveBeenCalled();

    // Full clean timeout from last touch: warning at 3s, kill at 5s
    vi.advanceTimersByTime(501);
    await vi.advanceTimersByTimeAsync(0);
    vi.advanceTimersByTime(2_001);
    expect(kill).toHaveBeenCalled();
  });

  // ── Shutdown ──

  it('shutdown kills all sessions', () => {
    const kill1 = vi.fn();
    const kill2 = vi.fn();
    manager.register('s1', { pid: 1, kill: kill1 });
    manager.register('s2', { pid: 2, kill: kill2 });
    manager.shutdown();
    expect(kill1).toHaveBeenCalled();
    expect(kill2).toHaveBeenCalled();
    expect(manager.has('s1')).toBe(false);
    expect(manager.has('s2')).toBe(false);
  });

  it('shutdown clears pending work', () => {
    manager.register('s1', { pid: 1, kill: vi.fn() });
    manager.queueWork('s1', 'payload');
    manager.shutdown();
    expect(manager.claimWork('s1')).toBeUndefined();
  });
});
