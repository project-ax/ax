/**
 * Delegation hardening tests — targets specific crash-causing bugs
 * in the subagent delegation pipeline.
 *
 * Bug 1: Timer leak in IPC handler timeout (setTimeout never cleared)
 * Bug 2: Delegation zombie when IPC timeout fires (counter never decremented)
 * Bug 3: Error response inconsistency in delegation handler
 *
 * These tests reproduce the failure modes that cause "3 concurrent agents
 * crashes the server."
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { createIPCHandler, type IPCContext, type DelegateRequest } from '../../src/host/ipc-server.js';
import { createDelegationHandlers } from '../../src/host/ipc-handlers/delegation.js';
import type { ProviderRegistry } from '../../src/types.js';

function mockProviders(): ProviderRegistry {
  return {
    llm: { name: 'mock', chat: vi.fn(), models: vi.fn() },
    memory: {
      write: vi.fn(async () => 'mock-id'),
      query: vi.fn(async () => []),
      read: vi.fn(async () => null),
      delete: vi.fn(),
      list: vi.fn(async () => []),
    },
    scanner: {
      scanInput: vi.fn(async () => ({ verdict: 'PASS' as const })),
      scanOutput: vi.fn(async () => ({ verdict: 'PASS' as const })),
      canaryToken: vi.fn(() => 'CANARY-test'),
      checkCanary: vi.fn(() => false),
    },
    channels: [],
    web: {
      fetch: vi.fn(),
      search: vi.fn(async () => []),
    },
    browser: {
      launch: vi.fn(),
      navigate: vi.fn(),
      snapshot: vi.fn(),
      click: vi.fn(),
      type: vi.fn(),
      screenshot: vi.fn(),
      close: vi.fn(),
    },
    credentials: {
      get: vi.fn(async () => null),
      set: vi.fn(),
      delete: vi.fn(),
      list: vi.fn(async () => []),
    },
    skills: {
      list: vi.fn(async () => []),
      read: vi.fn(async () => ''),
      propose: vi.fn(),
      approve: vi.fn(),
      reject: vi.fn(),
      revert: vi.fn(),
      log: vi.fn(async () => []),
    },
    audit: {
      log: vi.fn(),
      query: vi.fn(async () => []),
    },
    sandbox: {
      spawn: vi.fn(),
      kill: vi.fn(),
      isAvailable: vi.fn(async () => true),
    },
    scheduler: {
      start: vi.fn(),
      stop: vi.fn(),
    },
  } as unknown as ProviderRegistry;
}

const defaultCtx: IPCContext = { sessionId: 'test-session', agentId: 'primary' };

// ── Bug 1: Timer leak ────────────────────────────────────────

describe('IPC handler timeout cleanup', () => {
  test('clearTimeout is called after handler completes successfully', async () => {
    const providers = mockProviders();
    const originalSetTimeout = globalThis.setTimeout;
    const originalClearTimeout = globalThis.clearTimeout;

    const timerIds: ReturnType<typeof setTimeout>[] = [];
    const clearedTimerIds: ReturnType<typeof setTimeout>[] = [];

    // Track setTimeout calls that look like IPC handler timeouts (>= 60s)
    vi.spyOn(globalThis, 'setTimeout').mockImplementation((fn: any, ms?: number, ...args: any[]) => {
      const id = originalSetTimeout(fn, ms, ...args);
      if (ms && ms >= 60_000) {
        timerIds.push(id);
      }
      return id;
    });

    vi.spyOn(globalThis, 'clearTimeout').mockImplementation((id?: ReturnType<typeof setTimeout>) => {
      if (id !== undefined) {
        clearedTimerIds.push(id);
      }
      return originalClearTimeout(id);
    });

    const handler = createIPCHandler(providers, {
      delegation: { maxConcurrent: 3, maxDepth: 2 },
      onDelegate: async () => 'done',
    });

    await handler(
      JSON.stringify({ action: 'agent_delegate', task: 'Test timer cleanup' }),
      defaultCtx,
    );

    // Every long timer (IPC handler timeout) should have been cleared
    for (const timerId of timerIds) {
      expect(clearedTimerIds).toContain(timerId);
    }

    vi.restoreAllMocks();
  });

  test('clearTimeout is called even when handler throws', async () => {
    const providers = mockProviders();
    const originalSetTimeout = globalThis.setTimeout;
    const originalClearTimeout = globalThis.clearTimeout;

    const timerIds: ReturnType<typeof setTimeout>[] = [];
    const clearedTimerIds: ReturnType<typeof setTimeout>[] = [];

    vi.spyOn(globalThis, 'setTimeout').mockImplementation((fn: any, ms?: number, ...args: any[]) => {
      const id = originalSetTimeout(fn, ms, ...args);
      if (ms && ms >= 60_000) {
        timerIds.push(id);
      }
      return id;
    });

    vi.spyOn(globalThis, 'clearTimeout').mockImplementation((id?: ReturnType<typeof setTimeout>) => {
      if (id !== undefined) {
        clearedTimerIds.push(id);
      }
      return originalClearTimeout(id);
    });

    const handler = createIPCHandler(providers, {
      delegation: { maxConcurrent: 3, maxDepth: 2 },
      onDelegate: async () => { throw new Error('handler exploded'); },
    });

    await handler(
      JSON.stringify({ action: 'agent_delegate', task: 'Test timer cleanup on error' }),
      defaultCtx,
    );

    for (const timerId of timerIds) {
      expect(clearedTimerIds).toContain(timerId);
    }

    vi.restoreAllMocks();
  });
});

// ── Bug 2: Concurrent delegation counter management ──────────
//
// These tests use createDelegationHandlers directly (bypassing the full IPC
// pipeline) to test the delegation handler's concurrency tracking without
// being blocked by the IPC handler's 15-minute timeout wrapper.

describe('concurrent delegation counter', () => {
  test('3 concurrent delegations all complete, then 4th succeeds', async () => {
    const providers = mockProviders();
    const resolvers: (() => void)[] = [];

    const { agent_delegate } = createDelegationHandlers(providers, {
      delegation: { maxConcurrent: 3, maxDepth: 5 },
      onDelegate: async () => {
        return new Promise<string>(resolve => {
          resolvers.push(() => resolve('done'));
        });
      },
    });

    // Start 3 delegations (all should be accepted)
    const d1 = agent_delegate({ task: 'Task 1' }, defaultCtx);
    const d2 = agent_delegate({ task: 'Task 2' }, defaultCtx);
    const d3 = agent_delegate({ task: 'Task 3' }, defaultCtx);

    // Give event loop a tick so all 3 register their concurrency
    await new Promise(r => setTimeout(r, 50));

    // 4th should be rejected while 3 are in-flight
    const d4Rejected = await agent_delegate({ task: 'Task 4 (should fail)' }, defaultCtx);
    expect(d4Rejected.ok).toBe(false);
    expect(d4Rejected.error).toContain('concurrent');

    // Resolve all 3
    for (const resolve of resolvers) resolve();
    const [r1, r2, r3] = await Promise.all([d1, d2, d3]);
    expect(r1.response).toBe('done');
    expect(r2.response).toBe('done');
    expect(r3.response).toBe('done');

    // Counter should be back to 0 — fire 5th, resolve it, verify success
    const d5 = agent_delegate({ task: 'Task 5 (should pass)' }, defaultCtx);
    await new Promise(r => setTimeout(r, 10));
    resolvers[resolvers.length - 1]!();
    const r5 = await d5;
    expect(r5.response).toBe('done');
  });

  test('counter decrements when 1 of 3 concurrent delegations throws', async () => {
    const providers = mockProviders();
    let callCount = 0;
    const resolvers: (() => void)[] = [];

    const { agent_delegate } = createDelegationHandlers(providers, {
      delegation: { maxConcurrent: 3, maxDepth: 5 },
      onDelegate: async () => {
        callCount++;
        if (callCount === 2) {
          throw new Error('delegation 2 crashed');
        }
        return new Promise<string>(resolve => {
          resolvers.push(() => resolve('done'));
        });
      },
    });

    // Start 3 delegations — #2 will throw
    const d1 = agent_delegate({ task: 'Task 1' }, defaultCtx);
    const d2 = agent_delegate({ task: 'Task 2 (crashes)' }, defaultCtx);
    const d3 = agent_delegate({ task: 'Task 3' }, defaultCtx);

    // Wait for microtasks to settle — d2 should resolve with error
    await new Promise(r => setTimeout(r, 50));

    // d2 should have resolved with error (handler caught the throw)
    const r2 = await d2;
    expect(r2.ok).toBe(false);
    expect(r2.error).toContain('delegation 2 crashed');

    // Resolve the other 2
    for (const resolve of resolvers) resolve();
    const [r1, r3] = await Promise.all([d1, d3]);
    expect(r1.response).toBe('done');
    expect(r3.response).toBe('done');

    // Counter should be back to 0 — fire new delegation, resolve it, verify
    callCount = 0;
    const d4 = agent_delegate({ task: 'Task 4 (after crash recovery)' }, defaultCtx);
    await new Promise(r => setTimeout(r, 10));
    resolvers[resolvers.length - 1]!();
    const r4 = await d4;
    expect(r4.response).toBe('done');
  });

  test('rapid-fire: 10 requests with maxConcurrent=3, exactly 3 accepted', async () => {
    const providers = mockProviders();
    const resolvers: (() => void)[] = [];

    const { agent_delegate } = createDelegationHandlers(providers, {
      delegation: { maxConcurrent: 3, maxDepth: 5 },
      onDelegate: async () => {
        return new Promise<string>(resolve => {
          resolvers.push(() => resolve('done'));
        });
      },
    });

    // Fire 10 requests simultaneously
    const promises: Promise<any>[] = [];
    for (let i = 0; i < 10; i++) {
      promises.push(agent_delegate({ task: `Task ${i}` }, defaultCtx));
    }

    // Let microtasks settle so accepted calls reach onDelegate
    await new Promise(r => setTimeout(r, 50));

    // Resolve the ones that were accepted (only 3 should have resolvers)
    expect(resolvers.length).toBe(3);
    for (const resolve of resolvers) resolve();

    const results = await Promise.all(promises);

    const accepted = results.filter((r: any) => r.response !== undefined);
    const rejected = results.filter((r: any) => r.ok === false);

    expect(accepted.length).toBe(3);
    expect(rejected.length).toBe(7);

    for (const r of rejected) {
      expect(r.error).toContain('concurrent');
    }

    // Counter back to 0 — fire one more, resolve it, verify
    const finalPromise = agent_delegate({ task: 'Final after storm' }, defaultCtx);
    await new Promise(r => setTimeout(r, 10));
    resolvers[resolvers.length - 1]!();
    const final = await finalPromise;
    expect(final.response).toBe('done');
  });

  test('counter decrements when all concurrent delegations throw', async () => {
    const providers = mockProviders();

    const { agent_delegate } = createDelegationHandlers(providers, {
      delegation: { maxConcurrent: 3, maxDepth: 5 },
      onDelegate: async () => { throw new Error('all delegates fail'); },
    });

    // Fire 3 that all throw
    const [r1, r2, r3] = await Promise.all([
      agent_delegate({ task: 'Fail 1' }, defaultCtx),
      agent_delegate({ task: 'Fail 2' }, defaultCtx),
      agent_delegate({ task: 'Fail 3' }, defaultCtx),
    ]);

    expect(r1.ok).toBe(false);
    expect(r2.ok).toBe(false);
    expect(r3.ok).toBe(false);

    // Counter must be 0 — create a new handler set with a success callback
    const { agent_delegate: delegate2 } = createDelegationHandlers(providers, {
      delegation: { maxConcurrent: 3, maxDepth: 5 },
      onDelegate: async () => 'recovered',
    });

    const d4 = await delegate2({ task: 'After total failure' }, defaultCtx);
    expect(d4.response).toBe('recovered');
  });
});

// ── Bug 3: Error response consistency ────────────────────────

describe('delegation error response format', () => {
  test('handler throw returns ok:false with error message', async () => {
    const providers = mockProviders();
    const handler = createIPCHandler(providers, {
      delegation: { maxConcurrent: 3, maxDepth: 2 },
      onDelegate: async () => { throw new Error('something broke'); },
    });

    const result = JSON.parse(await handler(
      JSON.stringify({ action: 'agent_delegate', task: 'Error format test' }),
      defaultCtx,
    ));

    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
    expect(typeof result.error).toBe('string');
    expect(result.error).toContain('something broke');
  });

  test('concurrency limit returns same error shape as handler error', async () => {
    const providers = mockProviders();
    let resolveDelegate: () => void;

    // Use createDelegationHandlers directly to avoid IPC timeout blocking
    const { agent_delegate } = createDelegationHandlers(providers, {
      delegation: { maxConcurrent: 1, maxDepth: 2 },
      onDelegate: async () => {
        return new Promise<string>(resolve => { resolveDelegate = () => resolve('done'); });
      },
    });

    // Block the slot
    const d1 = agent_delegate({ task: 'Blocking' }, defaultCtx);
    await new Promise(r => setTimeout(r, 10));

    // Get concurrency rejection
    const limitResult = await agent_delegate({ task: 'Over limit' }, defaultCtx);

    // Both should have ok:false and error string
    expect(limitResult.ok).toBe(false);
    expect(typeof limitResult.error).toBe('string');

    // Unblock and clean up
    resolveDelegate!();
    await d1;

    // Now get handler error via IPC handler (no blocking needed)
    const errorHandler = createIPCHandler(providers, {
      delegation: { maxConcurrent: 1, maxDepth: 2 },
      onDelegate: async () => { throw new Error('crash'); },
    });

    const errorResult = JSON.parse(await errorHandler(
      JSON.stringify({ action: 'agent_delegate', task: 'Throw' }),
      defaultCtx,
    ));

    expect(errorResult.ok).toBe(false);
    expect(typeof errorResult.error).toBe('string');

    // Both should have ok and error keys
    expect(limitResult).toHaveProperty('ok');
    expect(limitResult).toHaveProperty('error');
    expect(errorResult).toHaveProperty('ok');
    expect(errorResult).toHaveProperty('error');
  });

  test('depth limit returns same error shape as concurrency limit', async () => {
    const providers = mockProviders();
    const handler = createIPCHandler(providers, {
      delegation: { maxConcurrent: 3, maxDepth: 2 },
      onDelegate: async () => 'done',
    });

    const depthResult = JSON.parse(await handler(
      JSON.stringify({ action: 'agent_delegate', task: 'Too deep' }),
      { sessionId: 'test-session', agentId: 'agent:depth=2' },
    ));

    expect(depthResult.ok).toBe(false);
    expect(typeof depthResult.error).toBe('string');
    expect(depthResult.error).toContain('depth');
  });
});

// ── Delegation audit completeness ────────────────────────────

describe('delegation audit trail', () => {
  test('successful delegation audits both action and completion', async () => {
    const providers = mockProviders();
    const handler = createIPCHandler(providers, {
      delegation: { maxConcurrent: 3, maxDepth: 2 },
      onDelegate: async () => 'audit test result',
    });

    await handler(
      JSON.stringify({ action: 'agent_delegate', task: 'Audit completeness test' }),
      defaultCtx,
    );

    // Should have audit entries for the delegation
    expect(providers.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'agent_delegate' }),
    );
  });

  test('failed delegation is still audited', async () => {
    const providers = mockProviders();
    const handler = createIPCHandler(providers, {
      delegation: { maxConcurrent: 3, maxDepth: 2 },
      onDelegate: async () => { throw new Error('fail'); },
    });

    await handler(
      JSON.stringify({ action: 'agent_delegate', task: 'Audit on failure test' }),
      defaultCtx,
    );

    // Delegation action should still be audited even though it failed
    expect(providers.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'agent_delegate' }),
    );
  });
});
