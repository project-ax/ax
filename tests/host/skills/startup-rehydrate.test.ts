// tests/host/skills/startup-rehydrate.test.ts
//
// Unit tests for rehydrateSkillsForAgents — the startup loop that re-runs
// reconcile for every known agent so in-memory appliers catch up with
// DB-persisted SkillState after a host restart.
//
// The runReconcile seam lets these tests avoid the real orchestrator
// (bare-repo snapshotting, state store, applier plumbing) entirely and just
// verify the loop-level contract: ordered iteration, per-agent try/catch,
// empty-list no-op.

import { describe, it, expect, vi } from 'vitest';
import { rehydrateSkillsForAgents } from '../../../src/host/skills/startup-rehydrate.js';
import type { OrchestratorDeps } from '../../../src/host/skills/reconcile-orchestrator.js';
import type { ProxyDomainList } from '../../../src/host/proxy-domain-list.js';
import type { CredentialProvider } from '../../../src/providers/credentials/types.js';
import type { EventBus } from '../../../src/host/event-bus.js';

function fakeDeps(overrides: Partial<OrchestratorDeps> = {}): OrchestratorDeps {
  return {
    agentName: 'foo-agent',
    proxyDomainList: { getAllowedDomains: () => new Set<string>() } as unknown as ProxyDomainList,
    credentials: {
      async get() { return null; },
      async set() {},
      async delete() {},
      async list() { return []; },
      async listScopePrefix() { return []; },
    } as unknown as CredentialProvider,
    stateStore: null as unknown as OrchestratorDeps['stateStore'],
    eventBus: {
      emit() {},
      subscribe: () => () => {},
      subscribeRequest: () => () => {},
      listenerCount: () => 0,
    } as unknown as EventBus,
    getBareRepoPath: () => '/nonexistent',
    ...overrides,
  };
}

describe('rehydrateSkillsForAgents', () => {
  it('runs reconcileAgent once per agent in the list', async () => {
    const calls: string[] = [];
    const deps = fakeDeps();

    await rehydrateSkillsForAgents(['a1', 'a2', 'a3'], deps, {
      runReconcile: async (id) => { calls.push(id); },
    });

    expect(calls).toEqual(['a1', 'a2', 'a3']);
  });

  it('continues past failures from individual agents', async () => {
    const deps = fakeDeps();
    const calls: string[] = [];
    await rehydrateSkillsForAgents(['a1', 'a2'], deps, {
      runReconcile: async (id) => {
        calls.push(id);
        if (id === 'a1') throw new Error('boom');
      },
    });
    // a1 throws — a2 must still be invoked
    expect(calls).toEqual(['a1', 'a2']);
  });

  it('does nothing when agent list is empty', async () => {
    const deps = fakeDeps();
    const runReconcile = vi.fn();
    await rehydrateSkillsForAgents([], deps, { runReconcile });
    expect(runReconcile).not.toHaveBeenCalled();
  });
});
