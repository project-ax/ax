// tests/providers/sandbox/k8s-warm-pool.test.ts — Tests for warm pool integration in k8s provider
//
// Tests the warm pool spawn path with NATS-based communication (no exec/attach).

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import type { SandboxConfig } from '../../../src/providers/sandbox/types.js';

// ── Warm pool integration tests ──
// Mock the warm-pool-client module directly for precise control over claiming behavior.

const mockClaimPod = vi.fn();
const mockReleasePod = vi.fn().mockResolvedValue(undefined);

vi.mock('../../../src/providers/sandbox/warm-pool-client.js', () => ({
  createWarmPoolClient: vi.fn().mockResolvedValue({
    claimPod: mockClaimPod,
    releasePod: mockReleasePod,
  }),
}));

const mockCreateNamespacedPod = vi.fn().mockResolvedValue({ body: {} });
const mockDeleteNamespacedPod = vi.fn().mockResolvedValue({ body: {} });
const mockListNamespacedPod = vi.fn().mockResolvedValue({ items: [] });
const mockReadNamespacedPod = vi.fn().mockResolvedValue({ status: { phase: 'Running' } });
const mockWatch = vi.fn().mockImplementation((_path: string, _query: any, callback: any) => {
  setTimeout(() => {
    callback('MODIFIED', {
      status: { phase: 'Succeeded', containerStatuses: [{ state: { terminated: { exitCode: 0 } } }] },
    });
  }, 10);
  return { abort: vi.fn() };
});

class MockKubeConfig {
  loadFromCluster() { throw new Error('not in cluster'); }
  loadFromDefault() {}
  makeApiClient() {
    return {
      createNamespacedPod: mockCreateNamespacedPod,
      deleteNamespacedPod: mockDeleteNamespacedPod,
      listNamespacedPod: mockListNamespacedPod,
      readNamespacedPod: mockReadNamespacedPod,
    };
  }
}

vi.mock('@kubernetes/client-node', () => ({
  KubeConfig: MockKubeConfig,
  CoreV1Api: class {},
  Watch: class {
    constructor(_kc: any) {}
    watch = mockWatch;
  },
}));

function mockConfig() {
  return {
    profile: 'balanced' as const,
    providers: {
      memory: 'cortex', scanner: 'patterns',
      channels: ['cli'], web: 'none', browser: 'none',
      credentials: 'keychain', skills: 'database', audit: 'database',
      sandbox: 'k8s', scheduler: 'none',
    },
    sandbox: { timeout_sec: 30, memory_mb: 256 },
    scheduler: {
      active_hours: { start: '08:00', end: '22:00', timezone: 'UTC' },
      max_token_budget: 1000,
      heartbeat_interval_min: 5,
    },
  };
}

describe('k8s provider warm pool integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Restore default implementations after clearAllMocks
    mockCreateNamespacedPod.mockResolvedValue({ body: {} });
    mockDeleteNamespacedPod.mockResolvedValue({ body: {} });
    mockListNamespacedPod.mockResolvedValue({ items: [] });
    mockReadNamespacedPod.mockResolvedValue({ status: { phase: 'Running' } });
    mockClaimPod.mockResolvedValue(null);  // default: no warm pods
    mockReleasePod.mockResolvedValue(undefined);
    mockWatch.mockImplementation((_path: string, _query: any, callback: any) => {
      setTimeout(() => {
        callback('MODIFIED', {
          status: { phase: 'Succeeded', containerStatuses: [{ state: { terminated: { exitCode: 0 } } }] },
        });
      }, 10);
      return { abort: vi.fn() };
    });
    delete process.env.WARM_POOL_ENABLED;
    delete process.env.WARM_POOL_TIER;
  });

  afterEach(() => {
    delete process.env.WARM_POOL_ENABLED;
    delete process.env.WARM_POOL_TIER;
  });

  test('cold start when warm pool is explicitly disabled', async () => {
    process.env.WARM_POOL_ENABLED = 'false';
    const { create } = await import('../../../src/providers/sandbox/k8s.js');
    const provider = await create(mockConfig());

    const config: SandboxConfig = {
      workspace: '/tmp/ws',
      ipcSocket: '/tmp/ipc.sock',
      command: ['node', 'runner.js'],
      timeoutSec: 30,
      memoryMB: 256,
    };

    const proc = await provider.spawn(config);

    // Should create a new pod (cold start)
    expect(mockCreateNamespacedPod).toHaveBeenCalledOnce();
    expect(mockClaimPod).not.toHaveBeenCalled();
    expect(proc.pid).toBeGreaterThan(0);
  });

  test('warm pool spawn claims pod without exec (NATS mode)', async () => {
    // Warm pool returns a claimed pod
    mockClaimPod.mockResolvedValueOnce({ name: 'warm-pod-1', tier: 'light' });

    const { create } = await import('../../../src/providers/sandbox/k8s.js');
    const provider = await create(mockConfig());

    const config: SandboxConfig = {
      workspace: '/tmp/ws',
      ipcSocket: '/tmp/ipc.sock',
      command: ['node', 'runner.js'],
      timeoutSec: 30,
    };

    const proc = await provider.spawn(config);

    // Should NOT create a new pod — claimed from warm pool
    expect(mockCreateNamespacedPod).not.toHaveBeenCalled();
    expect(mockClaimPod).toHaveBeenCalledWith('light');

    // In NATS mode, warm pod is already running runner.js — no exec needed
    expect(proc.pid).toBeGreaterThan(0);
    // podName is set for NATS work delivery
    expect(proc.podName).toBe('warm-pod-1');

    // Exit code resolves from pod watch
    const exitCode = await proc.exitCode;
    expect(exitCode).toBe(0);
  });

  test('falls back to cold start when no warm pods available', async () => {
    // claimPod returns null → no warm pods
    mockClaimPod.mockResolvedValueOnce(null);

    const { create } = await import('../../../src/providers/sandbox/k8s.js');
    const provider = await create(mockConfig());

    const config: SandboxConfig = {
      workspace: '/tmp/ws',
      ipcSocket: '/tmp/ipc.sock',
      command: ['node', 'runner.js'],
      timeoutSec: 30,
      memoryMB: 256,
    };

    const proc = await provider.spawn(config);

    // Should fall back to creating a new pod
    expect(mockCreateNamespacedPod).toHaveBeenCalledOnce();
    expect(proc.pid).toBeGreaterThan(0);
    // Cold start pods also have podName for NATS work delivery
    expect(proc.podName).toBeDefined();
  });

  test('warm pool kill deletes the claimed pod', async () => {
    process.env.WARM_POOL_ENABLED = 'true';

    mockClaimPod.mockResolvedValueOnce({ name: 'warm-pod-kill', tier: 'light' });

    const { create } = await import('../../../src/providers/sandbox/k8s.js');
    const provider = await create(mockConfig());

    const config: SandboxConfig = {
      workspace: '/tmp/ws',
      ipcSocket: '/tmp/ipc.sock',
      command: ['node', 'runner.js'],
      timeoutSec: 30,
    };

    const proc = await provider.spawn(config);
    proc.kill();

    await new Promise(r => setTimeout(r, 10));
    expect(mockDeleteNamespacedPod).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'warm-pod-kill' }),
    );
  });

  test('cold start pod has podName set for NATS work delivery', async () => {
    process.env.WARM_POOL_ENABLED = 'false';
    const { create } = await import('../../../src/providers/sandbox/k8s.js');
    const provider = await create(mockConfig());

    const config: SandboxConfig = {
      workspace: '/tmp/ws',
      ipcSocket: '/tmp/ipc.sock',
      command: ['node', 'runner.js'],
      timeoutSec: 30,
      memoryMB: 256,
    };

    const proc = await provider.spawn(config);

    // Pod name should be set for NATS work delivery
    expect(proc.podName).toMatch(/^ax-sandbox-/);
    expect(proc.pid).toBeGreaterThan(0);
  });
});
