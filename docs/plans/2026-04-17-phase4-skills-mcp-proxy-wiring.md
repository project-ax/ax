# Phase 4 — MCP + Proxy Allowlist Wiring from Reconciler

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Close the loop between the phase-2 reconciler and the live runtime — register/unregister MCP servers on `McpConnectionManager` and update the per-agent proxy allowlist on `ProxyDomainList` whenever a reconcile completes or the host starts.

**Architecture:** Two small "applier" modules diff `reconcile().desired` against the currently-registered state for an agent and call the appropriate mutator methods. The reconcile orchestrator gains two optional deps (`mcpApplier`, `proxyApplier`) that it invokes after the DB write. Startup rehydration re-runs the full reconcile for every known agent so live state matches DB after a host restart.

**Tech Stack:** TypeScript, vitest, Kysely/sqlite (test fixture already in place from phase 2), in-memory `McpConnectionManager` and `ProxyDomainList`.

---

## Constraints

- **Pending skills' resources never land on the live surface.** SC-SEC-002 invariant — the applier only consumes `desired.mcpServers` / `desired.proxyAllowlist` from `reconcile()`, which are already filtered to enabled skills.
- **No dynamic imports from config values.** Static allowlist only.
- **No new provider types.** Appliers are plain functions/objects, not entries in `ProviderRegistry`.
- **TDD.** Every task starts with a failing test.
- **Journal + lessons before commit.** Update `.claude/journal/host/skills.md` per task; add a lesson if you learned something non-obvious.
- **Zod `.strict()`** — no new IPC surface in this phase, but if you touch any schema, keep it strict.
- **Atomic DB writes stay in the orchestrator; appliers run *after* the DB transaction.** If the in-memory apply throws, the DB is already consistent; the next reconcile (or startup rehydration) will reconcile live state again.
- **Audit every register/unregister.** `providers.audit.log({action: 'mcp_registered' | 'mcp_unregistered' | 'proxy_allowlist_updated', ...})`.

---

## Architecture notes (read before starting)

### MCP source tagging

`McpConnectionManager` is a flat global registry keyed by server name. Plugins tag their contributions with `source: 'plugin:<name>'`; the DB loader uses `source: 'database'`. Skills will tag theirs with `source: 'skill:<agentId>'`. That gives us two useful operations via `listServersWithMeta()`:

- "Which MCP servers did this agent's skills register?" — filter entries by `source === 'skill:<agentId>'`.
- "Remove all MCP servers this agent's skills registered." — `removeServersBySource('_', 'skill:<agentId>')`.

**Name collisions across agents:** two agents both enabling a skill named `linear` with the same MCP name but different URLs would collide globally. The applier detects this (the existing server has a `source` that isn't ours) and emits a `skill.mcp_global_conflict` event without overwriting. Same-source same-name with same URL is a no-op; same-source same-name with different URL is a re-register.

### Proxy per-agent contribution

`ProxyDomainList.addSkillDomains(skillName, domains)` keys the contribution by skill name globally. Phase 4 adds `setAgentDomains(agentId, domains)` that keys by agent instead, letting us replace an agent's entire contribution idempotently. `rebuildMerged` walks both `skillDomains` (legacy) and `agentDomains` (new) plus `adminApproved` + `BUILTIN_DOMAINS`. Phase 7 will remove the legacy skill-keyed surface.

### Startup rehydration

The reconciler is pure and idempotent. On host start we iterate `agentRegistry.list()` and call `reconcileAgent(agentId, 'refs/heads/main', deps)` for each. Agents without a bare repo throw inside `buildSnapshotFromBareRepo`; the orchestrator's existing try/catch converts that into a `skills.reconcile_failed` event and returns zeroed counts — harmless for agents that never pushed a SKILL.md.

---

## Task breakdown

### Task 1: MCP applier module (tests first)

**Files:**
- Create: `src/host/skills/mcp-applier.ts`
- Create: `tests/host/skills/mcp-applier.test.ts`

The applier gets `mcpManager`, `audit?`, and `eventBus?`. Its `apply(agentId, desired)` method:

1. Computes `ours = listServersWithMeta('_').filter(s => s.source === 'skill:' + agentId)`.
2. Computes three sets against `desired`:
   - `toRegister`: in desired, not in ours.
   - `toReplace`: in both, but URL differs.
   - `toUnregister`: in ours, not in desired.
3. Detects **global conflicts**: a desired name already registered with a different `source` (plugin/database/other agent). Emits `skill.mcp_global_conflict` event and skips register/replace for that name.
4. Calls `mcpManager.addServer` / `mcpManager.removeServer` with `source: 'skill:<agentId>'`.
5. Emits `providers.audit.log({action: 'mcp_registered' | 'mcp_unregistered', args: { agentId, name, url?, source }, result: 'success', ...})` per change.
6. Returns `{ registered, unregistered, conflicts }` for the caller to emit higher-level events.

**Step 1.1 — Write failing unit tests** (`tests/host/skills/mcp-applier.test.ts`):

```typescript
import { describe, it, expect, vi } from 'vitest';
import { McpConnectionManager } from '../../../src/plugins/mcp-manager.js';
import { createMcpApplier } from '../../../src/host/skills/mcp-applier.js';

function makeManager() {
  return new McpConnectionManager();
}

function fakeAudit() {
  const entries: any[] = [];
  return { log: vi.fn(async (e: any) => { entries.push(e); }), query: vi.fn(), entries };
}

describe('McpApplier', () => {
  it('registers desired servers when nothing is present', async () => {
    const mcp = makeManager();
    const audit = fakeAudit();
    const applier = createMcpApplier({ mcpManager: mcp, audit });

    const result = await applier.apply('a1', new Map([
      ['linear', { url: 'https://mcp.linear.app' }],
    ]));

    expect(result.registered).toEqual([{ name: 'linear', url: 'https://mcp.linear.app' }]);
    expect(result.unregistered).toEqual([]);
    expect(result.conflicts).toEqual([]);
    expect(mcp.listServers('_').map(s => s.name)).toEqual(['linear']);
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'mcp_registered' }));
  });

  it('unregisters servers that drop out of desired', async () => {
    const mcp = makeManager();
    mcp.addServer('_', { name: 'linear', type: 'http', url: 'https://mcp.linear.app' }, { source: 'skill:a1' });
    const applier = createMcpApplier({ mcpManager: mcp });

    const result = await applier.apply('a1', new Map());

    expect(result.unregistered).toEqual([{ name: 'linear' }]);
    expect(mcp.listServers('_')).toEqual([]);
  });

  it('is idempotent when desired matches current', async () => {
    const mcp = makeManager();
    mcp.addServer('_', { name: 'linear', type: 'http', url: 'https://mcp.linear.app' }, { source: 'skill:a1' });
    const applier = createMcpApplier({ mcpManager: mcp });

    const result = await applier.apply('a1', new Map([
      ['linear', { url: 'https://mcp.linear.app' }],
    ]));

    expect(result.registered).toEqual([]);
    expect(result.unregistered).toEqual([]);
  });

  it('re-registers when URL changes for same name', async () => {
    const mcp = makeManager();
    mcp.addServer('_', { name: 'linear', type: 'http', url: 'https://old.example' }, { source: 'skill:a1' });
    const applier = createMcpApplier({ mcpManager: mcp });

    const result = await applier.apply('a1', new Map([
      ['linear', { url: 'https://new.example' }],
    ]));

    expect(result.registered).toEqual([{ name: 'linear', url: 'https://new.example' }]);
    expect(result.unregistered).toEqual([{ name: 'linear' }]);
    expect(mcp.listServers('_')[0].url).toBe('https://new.example');
  });

  it('does not touch servers owned by other sources (plugins/database/other agents)', async () => {
    const mcp = makeManager();
    mcp.addServer('_', { name: 'hubspot', type: 'http', url: 'https://hub' }, { source: 'plugin:hubspot' });
    mcp.addServer('_', { name: 'linear', type: 'http', url: 'https://lin-a2' }, { source: 'skill:a2' });
    const applier = createMcpApplier({ mcpManager: mcp });

    const result = await applier.apply('a1', new Map([
      ['notes', { url: 'https://notes' }],
    ]));

    expect(result.registered.map(r => r.name)).toEqual(['notes']);
    // hubspot + linear untouched
    expect(mcp.listServers('_').map(s => s.name).sort()).toEqual(['hubspot', 'linear', 'notes']);
  });

  it('emits skill.mcp_global_conflict when name already owned by non-skill source', async () => {
    const mcp = makeManager();
    mcp.addServer('_', { name: 'linear', type: 'http', url: 'https://plugin-url' }, { source: 'plugin:linear' });
    const applier = createMcpApplier({ mcpManager: mcp });

    const result = await applier.apply('a1', new Map([
      ['linear', { url: 'https://skill-url' }],
    ]));

    expect(result.registered).toEqual([]);
    expect(result.conflicts).toEqual([
      { name: 'linear', desiredUrl: 'https://skill-url', existingUrl: 'https://plugin-url', existingSource: 'plugin:linear' },
    ]);
    // Existing server NOT overwritten
    expect(mcp.listServers('_')[0].url).toBe('https://plugin-url');
  });

  it('attaches Authorization header placeholder when bearerCredential is set', async () => {
    const mcp = makeManager();
    const applier = createMcpApplier({ mcpManager: mcp });

    await applier.apply('a1', new Map([
      ['linear', { url: 'https://mcp.linear.app', bearerCredential: 'LINEAR_TOKEN' }],
    ]));

    const meta = mcp.getServerMeta('_', 'linear');
    expect(meta?.source).toBe('skill:a1');
    expect(meta?.headers).toEqual({ Authorization: 'Bearer ${LINEAR_TOKEN}' });
  });
});
```

**Step 1.2 — Run the test and confirm it fails:**

```bash
npx vitest run tests/host/skills/mcp-applier.test.ts
```
Expected: every `it` fails with `Cannot find module '../../../src/host/skills/mcp-applier.js'`.

**Step 1.3 — Implement `src/host/skills/mcp-applier.ts`:**

```typescript
// src/host/skills/mcp-applier.ts — Apply reconciler `desired.mcpServers` to
// the live McpConnectionManager with a source tag unique to this agent.
//
// Source tag: `skill:<agentId>` — lets us find / remove only the entries we
// own, without touching plugin- or database-registered servers.

import type { McpConnectionManager } from '../../plugins/mcp-manager.js';
import type { AuditProvider } from '../../providers/audit/types.js';
import { getLogger } from '../../logger.js';

const logger = getLogger().child({ component: 'mcp-applier' });

export interface McpApplyResult {
  registered: Array<{ name: string; url: string }>;
  unregistered: Array<{ name: string }>;
  conflicts: Array<{
    name: string;
    desiredUrl: string;
    existingUrl: string;
    existingSource?: string;
  }>;
}

export interface McpApplier {
  apply(
    agentId: string,
    desired: ReadonlyMap<string, { url: string; bearerCredential?: string }>,
  ): Promise<McpApplyResult>;
}

export interface McpApplierDeps {
  mcpManager: McpConnectionManager;
  audit?: AuditProvider;
}

function sourceFor(agentId: string): string {
  return `skill:${agentId}`;
}

export function createMcpApplier(deps: McpApplierDeps): McpApplier {
  const { mcpManager, audit } = deps;

  return {
    async apply(agentId, desired) {
      const source = sourceFor(agentId);
      const all = mcpManager.listServersWithMeta('_');
      const ours = new Map<string, { url: string }>(); // name → current url (our source only)
      const byName = new Map<string, { url: string; source?: string }>();
      for (const s of all) {
        byName.set(s.name, { url: s.url, source: s.source });
        if (s.source === source) ours.set(s.name, { url: s.url });
      }

      const registered: McpApplyResult['registered'] = [];
      const unregistered: McpApplyResult['unregistered'] = [];
      const conflicts: McpApplyResult['conflicts'] = [];

      // 1. Register / replace
      for (const [name, entry] of desired) {
        const existing = byName.get(name);
        const isOurs = ours.has(name);

        if (existing && !isOurs) {
          // Name already registered by a different source — do NOT overwrite.
          if (existing.url !== entry.url) {
            conflicts.push({
              name,
              desiredUrl: entry.url,
              existingUrl: existing.url,
              existingSource: existing.source,
            });
            logger.warn('mcp_global_conflict', {
              agentId, name,
              desiredUrl: entry.url,
              existingUrl: existing.url,
              existingSource: existing.source,
            });
          }
          continue;
        }

        const currentUrl = ours.get(name)?.url;
        if (currentUrl === entry.url) continue; // no-op

        if (currentUrl !== undefined && currentUrl !== entry.url) {
          mcpManager.removeServer('_', name);
          unregistered.push({ name });
        }

        const headers = entry.bearerCredential
          ? { Authorization: `Bearer \${${entry.bearerCredential}}` }
          : undefined;
        mcpManager.addServer(
          '_',
          { name, type: 'http', url: entry.url },
          { source, headers },
        );
        registered.push({ name, url: entry.url });

        if (audit) {
          await audit.log({
            action: 'mcp_registered',
            args: { agentId, name, url: entry.url, source },
            result: 'success',
            timestamp: new Date(),
            durationMs: 0,
          });
        }
      }

      // 2. Unregister anything of ours that's no longer desired
      for (const [name] of ours) {
        if (desired.has(name)) continue;
        // Already unregistered above if URL changed? No — the URL-change path
        // removes-then-adds; the name is still in `desired` so we skip here.
        const wasRemoved = mcpManager.removeServer('_', name);
        if (wasRemoved) {
          unregistered.push({ name });
          if (audit) {
            await audit.log({
              action: 'mcp_unregistered',
              args: { agentId, name, source },
              result: 'success',
              timestamp: new Date(),
              durationMs: 0,
            });
          }
        }
      }

      return { registered, unregistered, conflicts };
    },
  };
}
```

**Step 1.4 — Run the test and confirm it passes:**

```bash
npx vitest run tests/host/skills/mcp-applier.test.ts
```
Expected: 7/7 pass.

**Step 1.5 — Journal + lessons, then commit:**

```bash
# append to .claude/journal/host/skills.md
# (new entry summarizing the applier — 5-10 lines)

git add src/host/skills/mcp-applier.ts tests/host/skills/mcp-applier.test.ts .claude/journal/host/skills.md
git commit -m "feat(skills): add MCP applier diffing desired against live state"
```

---

### Task 2: Proxy applier module + per-agent ProxyDomainList API

**Files:**
- Modify: `src/host/proxy-domain-list.ts`
- Create: `src/host/skills/proxy-applier.ts`
- Create: `tests/host/skills/proxy-applier.test.ts`
- Extend: `tests/host/proxy-domain-list.test.ts` — add cases for `setAgentDomains` + rebuild.

**Step 2.1 — Write failing tests for the new `ProxyDomainList.setAgentDomains` behavior** (append to `tests/host/proxy-domain-list.test.ts`):

```typescript
test('setAgentDomains stores and merges per-agent contributions', () => {
  const list = new ProxyDomainList();
  list.setAgentDomains('a1', ['api.linear.app']);
  list.setAgentDomains('a2', ['slack.com']);
  expect(list.isAllowed('api.linear.app')).toBe(true);
  expect(list.isAllowed('slack.com')).toBe(true);
});

test('setAgentDomains replaces (does not merge) prior value for same agent', () => {
  const list = new ProxyDomainList();
  list.setAgentDomains('a1', ['api.linear.app', 'example.com']);
  list.setAgentDomains('a1', ['api.linear.app']); // drop example.com
  expect(list.isAllowed('api.linear.app')).toBe(true);
  expect(list.isAllowed('example.com')).toBe(false);
});

test('setAgentDomains with empty array clears that agent and does not affect others', () => {
  const list = new ProxyDomainList();
  list.setAgentDomains('a1', ['example.com']);
  list.setAgentDomains('a2', ['slack.com']);
  list.setAgentDomains('a1', []);
  expect(list.isAllowed('example.com')).toBe(false);
  expect(list.isAllowed('slack.com')).toBe(true);
});

test('setAgentDomains does not drop skill-keyed or admin-approved entries', () => {
  const list = new ProxyDomainList();
  list.addSkillDomains('old-skill', ['legacy.example']);
  list.approvePending('admin.example');
  list.setAgentDomains('a1', ['api.linear.app']);
  expect(list.isAllowed('legacy.example')).toBe(true);
  expect(list.isAllowed('admin.example')).toBe(true);
  expect(list.isAllowed('api.linear.app')).toBe(true);
});

test('setAgentDomains normalizes (trim + lowercase + strip trailing dot)', () => {
  const list = new ProxyDomainList();
  list.setAgentDomains('a1', ['  API.LINEAR.APP.  ']);
  expect(list.isAllowed('api.linear.app')).toBe(true);
});
```

Run it — fails (`setAgentDomains is not a function`).

**Step 2.2 — Extend `ProxyDomainList` with per-agent storage:**

In `src/host/proxy-domain-list.ts`, add:

```typescript
/** agentId → Set<domain> — phase 4 per-agent skill contribution. */
private agentDomains = new Map<string, Set<string>>();

setAgentDomains(agentId: string, domains: Iterable<string>): void {
  const normalized = new Set<string>();
  for (const d of domains) {
    const n = normalizeDomain(d);
    if (n) normalized.add(n);
  }
  if (normalized.size === 0) {
    this.agentDomains.delete(agentId);
  } else {
    this.agentDomains.set(agentId, normalized);
  }
  this.merged = null;
  logger.info('agent_domains_set', { agentId, domains: [...normalized] });
}

removeAgent(agentId: string): void {
  this.agentDomains.delete(agentId);
  this.merged = null;
}
```

Update `rebuildMerged`:

```typescript
private rebuildMerged(): void {
  const all = new Set(BUILTIN_DOMAINS);
  for (const domains of this.skillDomains.values()) for (const d of domains) all.add(d);
  for (const domains of this.agentDomains.values()) for (const d of domains) all.add(d);
  for (const d of this.adminApproved) all.add(d);
  this.merged = all;
}
```

Run proxy-domain-list tests — all pass (old + new).

```bash
npx vitest run tests/host/proxy-domain-list.test.ts
```

**Step 2.3 — Write failing tests for the proxy applier** (`tests/host/skills/proxy-applier.test.ts`):

```typescript
import { describe, it, expect, vi } from 'vitest';
import { ProxyDomainList } from '../../../src/host/proxy-domain-list.js';
import { createProxyApplier } from '../../../src/host/skills/proxy-applier.js';

function fakeAudit() {
  const entries: any[] = [];
  return { log: vi.fn(async (e: any) => { entries.push(e); }), query: vi.fn(), entries };
}

describe('ProxyApplier', () => {
  it('sets this agent\'s contribution on first apply', async () => {
    const list = new ProxyDomainList();
    const audit = fakeAudit();
    const applier = createProxyApplier({ proxyDomainList: list, audit });

    const result = await applier.apply('a1', new Set(['api.linear.app']));

    expect(result.added).toEqual(['api.linear.app']);
    expect(result.removed).toEqual([]);
    expect(list.isAllowed('api.linear.app')).toBe(true);
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({
      action: 'proxy_allowlist_updated',
      args: expect.objectContaining({ agentId: 'a1' }),
    }));
  });

  it('replaces the prior agent contribution (diffed add/remove)', async () => {
    const list = new ProxyDomainList();
    const applier = createProxyApplier({ proxyDomainList: list });

    await applier.apply('a1', new Set(['api.linear.app', 'slack.com']));
    const result = await applier.apply('a1', new Set(['api.linear.app']));

    expect(result.added).toEqual([]);
    expect(result.removed).toEqual(['slack.com']);
    expect(list.isAllowed('slack.com')).toBe(false);
    expect(list.isAllowed('api.linear.app')).toBe(true);
  });

  it('no-op when desired equals current', async () => {
    const list = new ProxyDomainList();
    const audit = fakeAudit();
    const applier = createProxyApplier({ proxyDomainList: list, audit });

    await applier.apply('a1', new Set(['api.linear.app']));
    audit.log.mockClear();
    const result = await applier.apply('a1', new Set(['api.linear.app']));

    expect(result.added).toEqual([]);
    expect(result.removed).toEqual([]);
    expect(audit.log).not.toHaveBeenCalled();
  });

  it('clears agent when desired is empty', async () => {
    const list = new ProxyDomainList();
    const applier = createProxyApplier({ proxyDomainList: list });

    await applier.apply('a1', new Set(['api.linear.app']));
    const result = await applier.apply('a1', new Set());

    expect(result.added).toEqual([]);
    expect(result.removed).toEqual(['api.linear.app']);
    expect(list.isAllowed('api.linear.app')).toBe(false);
  });
});
```

Run — fails (`createProxyApplier` not exported).

**Step 2.4 — Implement `src/host/skills/proxy-applier.ts`:**

```typescript
// src/host/skills/proxy-applier.ts — Apply reconciler `desired.proxyAllowlist`
// to the ProxyDomainList using replace-style semantics keyed by agentId.

import type { ProxyDomainList } from '../proxy-domain-list.js';
import type { AuditProvider } from '../../providers/audit/types.js';
import { getLogger } from '../../logger.js';

const logger = getLogger().child({ component: 'proxy-applier' });

const normalizeDomain = (d: string): string =>
  d.trim().toLowerCase().replace(/\.$/, '');

export interface ProxyApplyResult {
  added: string[];
  removed: string[];
}

export interface ProxyApplier {
  apply(agentId: string, desired: ReadonlySet<string>): Promise<ProxyApplyResult>;
}

export interface ProxyApplierDeps {
  proxyDomainList: ProxyDomainList;
  audit?: AuditProvider;
}

interface ProxyDomainListWithInternals {
  setAgentDomains(agentId: string, domains: Iterable<string>): void;
  /** Present in phase 4 — exposed via a light accessor for diffing. */
}

export function createProxyApplier(deps: ProxyApplierDeps): ProxyApplier {
  const { proxyDomainList, audit } = deps;
  // Track prior per-agent desired sets locally so diffing is O(|desired|) and
  // doesn't require introspecting ProxyDomainList's internal Map.
  const prior = new Map<string, Set<string>>();

  return {
    async apply(agentId, desired) {
      const normalized = new Set<string>();
      for (const d of desired) {
        const n = normalizeDomain(d);
        if (n) normalized.add(n);
      }

      const previous = prior.get(agentId) ?? new Set<string>();
      const added: string[] = [];
      const removed: string[] = [];
      for (const d of normalized) if (!previous.has(d)) added.push(d);
      for (const d of previous) if (!normalized.has(d)) removed.push(d);

      if (added.length === 0 && removed.length === 0) {
        return { added, removed };
      }

      proxyDomainList.setAgentDomains(agentId, normalized);
      prior.set(agentId, normalized);

      if (audit) {
        await audit.log({
          action: 'proxy_allowlist_updated',
          args: { agentId, added, removed, total: normalized.size },
          result: 'success',
          timestamp: new Date(),
          durationMs: 0,
        });
      }
      logger.info('proxy_allowlist_updated', {
        agentId, added, removed, total: normalized.size,
      });

      return { added, removed };
    },
  };
}
```

**Step 2.5 — Run tests:**

```bash
npx vitest run tests/host/skills/proxy-applier.test.ts tests/host/proxy-domain-list.test.ts
```
Expected: all pass.

**Step 2.6 — Journal + commit:**

```bash
git add src/host/proxy-domain-list.ts src/host/skills/proxy-applier.ts \
        tests/host/skills/proxy-applier.test.ts tests/host/proxy-domain-list.test.ts \
        .claude/journal/host/skills.md
git commit -m "feat(skills): per-agent proxy applier with replace-style semantics"
```

---

### Task 3: Wire appliers into `reconcileAgent`

**Files:**
- Modify: `src/host/skills/reconcile-orchestrator.ts`
- Modify: `tests/host/skills/reconcile-orchestrator.test.ts`

**Step 3.1 — Write failing tests** (append to `reconcile-orchestrator.test.ts`):

```typescript
it('invokes mcpApplier + proxyApplier with desired output after DB write', async () => {
  // Seed a skill that will end up ENABLED (credential + domain are met)
  seedRepo(bareRepoPath, {
    '.ax/skills/linear/SKILL.md': `---
name: linear
description: Talk to Linear.
credentials:
  - envName: LINEAR_TOKEN
    scope: user
domains:
  - api.linear.app
mcpServers:
  - name: linear-mcp
    url: https://mcp.linear.app
    credential: LINEAR_TOKEN
---
# body
`,
  });

  const stateStore = createSkillStateStore(dbHandle.db);
  const proxyDomainList = {
    getAllowedDomains: () => new Set<string>(['api.linear.app']),
  } as unknown as ProxyDomainList;
  const credentials = stubCredentials({
    byPrefix: { 'user:foo-agent:': [{ scope: 'user:foo-agent:alice', envName: 'LINEAR_TOKEN' }] },
  });
  const { bus } = recordingEventBus();

  const mcpCalls: any[] = [];
  const proxyCalls: any[] = [];
  const deps: OrchestratorDeps = {
    agentName: 'foo-agent',
    proxyDomainList,
    credentials,
    stateStore,
    eventBus: bus,
    getBareRepoPath: () => bareRepoPath,
    mcpApplier: { apply: async (id, m) => { mcpCalls.push({ id, entries: [...m] }); return { registered: [], unregistered: [], conflicts: [] }; } },
    proxyApplier: { apply: async (id, s) => { proxyCalls.push({ id, domains: [...s] }); return { added: [], removed: [] }; } },
  };

  await reconcileAgent('agent-1', 'refs/heads/main', deps);

  expect(mcpCalls).toHaveLength(1);
  expect(mcpCalls[0].id).toBe('agent-1');
  expect(mcpCalls[0].entries).toEqual([
    ['linear-mcp', { url: 'https://mcp.linear.app', bearerCredential: 'LINEAR_TOKEN' }],
  ]);
  expect(proxyCalls).toEqual([{ id: 'agent-1', domains: ['api.linear.app'] }]);
});

it('emits audit/report events reflecting applier results', async () => {
  seedRepo(bareRepoPath, { '.ax/skills/linear/SKILL.md': LINEAR_SKILL });
  const stateStore = createSkillStateStore(dbHandle.db);
  const proxyDomainList = {
    getAllowedDomains: () => new Set<string>(['api.linear.app']),
  } as unknown as ProxyDomainList;
  const credentials = stubCredentials({
    byPrefix: { 'user:foo-agent:': [{ scope: 'user:foo-agent:alice', envName: 'LINEAR_TOKEN' }] },
  });
  const { bus, events } = recordingEventBus();

  const deps: OrchestratorDeps = {
    agentName: 'foo-agent',
    proxyDomainList,
    credentials,
    stateStore,
    eventBus: bus,
    getBareRepoPath: () => bareRepoPath,
    mcpApplier: { apply: async () => ({
      registered: [{ name: 'linear-mcp', url: 'https://mcp.linear.app' }],
      unregistered: [],
      conflicts: [],
    }) },
    proxyApplier: { apply: async () => ({ added: ['api.linear.app'], removed: [] }) },
  };

  await reconcileAgent('agent-1', 'refs/heads/main', deps);

  const types = events.map(e => e.type);
  expect(types).toContain('skills.live_state_applied');
});

it('skips appliers if orchestrator catches an error before DB write', async () => {
  // Force snapshot failure; appliers must NOT be called.
  const stateStore = createSkillStateStore(dbHandle.db);
  const proxyDomainList = {
    getAllowedDomains: () => new Set<string>(),
  } as unknown as ProxyDomainList;
  const { bus } = recordingEventBus();
  const mcpApply = vi.fn().mockResolvedValue({ registered: [], unregistered: [], conflicts: [] });
  const proxyApply = vi.fn().mockResolvedValue({ added: [], removed: [] });

  const deps: OrchestratorDeps = {
    agentName: 'foo-agent',
    proxyDomainList,
    credentials: stubCredentials({}),
    stateStore,
    eventBus: bus,
    getBareRepoPath: () => '/nonexistent/path',
    mcpApplier: { apply: mcpApply },
    proxyApplier: { apply: proxyApply },
  };

  await reconcileAgent('agent-1', 'refs/heads/main', deps);

  expect(mcpApply).not.toHaveBeenCalled();
  expect(proxyApply).not.toHaveBeenCalled();
});
```

Add `import { vi } from 'vitest';` at the top if missing.

Run — 3/3 fail.

**Step 3.2 — Extend `reconcile-orchestrator.ts`:**

```typescript
import type { McpApplier } from './mcp-applier.js';
import type { ProxyApplier } from './proxy-applier.js';

export interface OrchestratorDeps extends CurrentStateDeps {
  eventBus: EventBus;
  getBareRepoPath(agentId: string): string;
  /** Phase 4: live MCP registration. Optional for back-compat with phase-2 tests. */
  mcpApplier?: McpApplier;
  /** Phase 4: live proxy-allowlist updates. Optional for back-compat. */
  proxyApplier?: ProxyApplier;
}

// In reconcileAgent, after `await deps.stateStore.putStatesAndQueue(...)`
// and BEFORE the event-emit loop, run the appliers. Their return values
// feed a single `skills.live_state_applied` summary event alongside the
// reconciler events.
```

Pseudocode diff (place after the putStatesAndQueue call):

```typescript
let applierSummary: { mcp?: McpApplyResult; proxy?: ProxyApplyResult } = {};
if (deps.mcpApplier) {
  try {
    applierSummary.mcp = await deps.mcpApplier.apply(agentId, output.desired.mcpServers);
  } catch (err) {
    log.warn('mcp_applier_failed', { agentId, error: (err as Error).message });
  }
}
if (deps.proxyApplier) {
  try {
    applierSummary.proxy = await deps.proxyApplier.apply(agentId, output.desired.proxyAllowlist);
  } catch (err) {
    log.warn('proxy_applier_failed', { agentId, error: (err as Error).message });
  }
}
if (deps.mcpApplier || deps.proxyApplier) {
  deps.eventBus.emit({
    type: 'skills.live_state_applied',
    requestId: agentId,
    timestamp: Date.now(),
    data: {
      mcp: applierSummary.mcp,
      proxy: applierSummary.proxy,
    },
  });
}
```

(Keep the imports at the top; add `import type { McpApplyResult } from './mcp-applier.js';` and `import type { ProxyApplyResult } from './proxy-applier.js';`.)

**Step 3.3 — Run tests:**

```bash
npx vitest run tests/host/skills/reconcile-orchestrator.test.ts
```
Expected: all pass (old + new 3).

**Step 3.4 — Journal + commit:**

```bash
git add src/host/skills/reconcile-orchestrator.ts tests/host/skills/reconcile-orchestrator.test.ts \
        .claude/journal/host/skills.md
git commit -m "feat(skills): invoke MCP + proxy appliers from reconcile orchestrator"
```

---

### Task 4: Startup rehydration in `server.ts`

**Files:**
- Modify: `src/host/server.ts`
- Modify: `src/host/server-init.ts` (construct appliers in `initHostCore`, expose via `HostCore`)
- Create: `tests/host/skills/startup-rehydrate.test.ts`

**Step 4.1 — Extend `HostCore` with appliers:**

In `src/host/server-init.ts`, after the stateStore block:

```typescript
let mcpApplier: McpApplier | undefined;
let proxyApplier: ProxyApplier | undefined;
if (stateStore) {
  const { createMcpApplier } = await import('./skills/mcp-applier.js');
  const { createProxyApplier } = await import('./skills/proxy-applier.js');
  mcpApplier = createMcpApplier({ mcpManager, audit: providers.audit });
  proxyApplier = createProxyApplier({ proxyDomainList: domainList, audit: providers.audit });
}
```

Add `mcpApplier?: McpApplier; proxyApplier?: ProxyApplier;` to the `HostCore` interface and return them. Import `type { McpApplier } from './skills/mcp-applier.js';` and same for proxy.

Keep these dynamic imports scoped inside the `if (stateStore)` branch — they're optional paths and the dynamic import is already the pattern used for the state store.

**Step 4.2 — Write failing tests for startup rehydrate** (`tests/host/skills/startup-rehydrate.test.ts`):

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import { Kysely, SqliteDialect } from 'kysely';
import { runMigrations } from '../../../src/utils/migrator.js';
import { skillsMigrations } from '../../../src/migrations/skills.js';
import { createSkillStateStore } from '../../../src/host/skills/state-store.js';
import { rehydrateSkillsForAgents } from '../../../src/host/skills/startup-rehydrate.js';
import type { OrchestratorDeps } from '../../../src/host/skills/reconcile-orchestrator.js';
import type { ProxyDomainList } from '../../../src/host/proxy-domain-list.js';
import type { CredentialProvider } from '../../../src/providers/credentials/types.js';
import type { EventBus } from '../../../src/host/event-bus.js';

// Reuse seedRepo / initBareRepo helpers — copy from reconcile-orchestrator.test.ts
// or extract into a shared helper module under tests/host/skills/_helpers.ts.

function fakeDeps(overrides: Partial<OrchestratorDeps>): OrchestratorDeps {
  return {
    agentName: 'foo-agent',
    proxyDomainList: { getAllowedDomains: () => new Set<string>() } as unknown as ProxyDomainList,
    credentials: {
      async get() { return null; }, async set() {}, async delete() {},
      async list() { return []; }, async listScopePrefix() { return []; },
    } as CredentialProvider,
    stateStore: null as any,
    eventBus: { emit() {}, subscribe: () => () => {}, subscribeRequest: () => () => {}, listenerCount: () => 0 } as EventBus,
    getBareRepoPath: () => '/nonexistent',
    ...overrides,
  };
}

describe('rehydrateSkillsForAgents', () => {
  it('runs reconcileAgent once per agent in the list', async () => {
    const calls: string[] = [];
    const deps = fakeDeps({ getBareRepoPath: () => '/nonexistent' });
    // stub reconcileAgent via dep injection if available, or spy on deps
    const agentIds = ['a1', 'a2', 'a3'];

    await rehydrateSkillsForAgents(agentIds, deps, {
      // allow injecting the reconcile function for testing
      runReconcile: async (id) => { calls.push(id); },
    });

    expect(calls).toEqual(['a1', 'a2', 'a3']);
  });

  it('continues past failures from individual agents', async () => {
    const deps = fakeDeps({});
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
    const deps = fakeDeps({});
    await rehydrateSkillsForAgents([], deps, { runReconcile: vi.fn() });
    // no throw — implicit pass
  });
});
```

Run — fails with "Cannot find module '.../startup-rehydrate.js'".

**Step 4.3 — Implement `src/host/skills/startup-rehydrate.ts`:**

```typescript
// src/host/skills/startup-rehydrate.ts — On host boot, re-run reconcile for
// every known agent so in-memory appliers rebuild live state from DB + bare
// repo. Agents without a repo throw inside buildSnapshotFromBareRepo; the
// orchestrator's try/catch converts that to a skills.reconcile_failed event —
// harmless for agents that never pushed a SKILL.md.

import { reconcileAgent, type OrchestratorDeps } from './reconcile-orchestrator.js';
import { getLogger } from '../../logger.js';

const logger = getLogger().child({ component: 'skills-rehydrate' });

export interface RehydrateOptions {
  /** Defaults to 'refs/heads/main' — which ref to reconcile on startup. */
  ref?: string;
  /** Seam for testing; real code uses reconcileAgent. */
  runReconcile?: (agentId: string) => Promise<void>;
}

export async function rehydrateSkillsForAgents(
  agentIds: readonly string[],
  deps: OrchestratorDeps,
  opts: RehydrateOptions = {},
): Promise<void> {
  const ref = opts.ref ?? 'refs/heads/main';
  const runReconcile = opts.runReconcile
    ?? (async (id: string) => { await reconcileAgent(id, ref, deps); });

  for (const agentId of agentIds) {
    try {
      await runReconcile(agentId);
    } catch (err) {
      logger.warn('startup_rehydrate_failed', {
        agentId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
```

Run tests — 3/3 pass.

**Step 4.4 — Wire rehydrate into `server.ts`:**

In `src/host/server.ts`, after `core` is constructed and the orchestrator deps are built, *before* the server starts listening, add:

```typescript
if (stateStore && core.mcpApplier && core.proxyApplier) {
  const orchestratorDeps: OrchestratorDeps = {
    agentName,
    proxyDomainList: domainList,
    credentials: providers.credentials,
    stateStore,
    eventBus,
    getBareRepoPath,
    mcpApplier: core.mcpApplier,
    proxyApplier: core.proxyApplier,
  };
  const agents = await agentRegistry.list();
  const { rehydrateSkillsForAgents } = await import('./skills/startup-rehydrate.js');
  await rehydrateSkillsForAgents(agents.map(a => a.id), orchestratorDeps);
}
```

Reuse this `orchestratorDeps` for the reconcile hook handler wiring (consolidate — currently hook wiring builds its own).

**Step 4.5 — Run the full test suite:**

```bash
npm test
```
Expected: all green. If any phase-2 tests break because they now see optional applier deps, that's fine — the deps are optional.

**Step 4.6 — Journal + commit:**

```bash
git add src/host/server.ts src/host/server-init.ts src/host/skills/startup-rehydrate.ts \
        tests/host/skills/startup-rehydrate.test.ts .claude/journal/host/skills.md
git commit -m "feat(skills): rehydrate MCP + proxy live state on host startup"
```

---

### Task 5: Audit event name sync + catalog test

**Files:**
- Modify: `tests/agent/tool-catalog-sync.test.ts` (or wherever the canonical audit action list lives — check it)
- Verify audit `action` strings align with any existing enum.

**Step 5.1 — Grep for any existing audit-action enum/const:**

```bash
grep -rn "'mcp_registered'\|'proxy_allowlist_updated'\|AuditAction" src/ tests/ | head
```

If there's no central enum, audit strings are free-form — move on. If there IS one (for example an admin-dashboard filter), add `mcp_registered`, `mcp_unregistered`, `proxy_allowlist_updated` to it.

**Step 5.2 — If an addition was needed, run the relevant tests:**

```bash
npx vitest run tests/host/ tests/agent/
```

**Step 5.3 — If no change was needed, skip commit; otherwise:**

```bash
git add <touched files> .claude/journal/host/skills.md
git commit -m "chore(skills): register phase-4 audit actions"
```

---

### Task 6: Documentation + journal wrap-up

**Files:**
- Modify: `.claude/skills/ax/SKILL.md` or `.claude/skills/ax-host/SKILL.md` — add a one-paragraph note under the skills pipeline section pointing to the appliers.
- Modify: `docs/plans/2026-04-16-git-native-skills-design.md` — if it has a "Phase 4" section, mark it complete with a short result summary.
- Append: `.claude/journal/host/skills.md` with a phase-4 summary entry.
- If a non-obvious pattern emerged (global MCP source tagging, idempotent applier pattern), append a lesson to `.claude/lessons/host/entries.md`.

**Step 6.1 — Run the full test suite + build:**

```bash
npm test
npm run build
```

Expected: green + clean.

**Step 6.2 — Commit documentation:**

```bash
git add .claude/ docs/plans/2026-04-16-git-native-skills-design.md
git commit -m "docs(skills): phase 4 applier + rehydration docs"
```

---

## Summary of files

**New files:**
- `src/host/skills/mcp-applier.ts`
- `src/host/skills/proxy-applier.ts`
- `src/host/skills/startup-rehydrate.ts`
- `tests/host/skills/mcp-applier.test.ts`
- `tests/host/skills/proxy-applier.test.ts`
- `tests/host/skills/startup-rehydrate.test.ts`

**Modified:**
- `src/host/proxy-domain-list.ts` — add `setAgentDomains` + `removeAgent`; update `rebuildMerged`.
- `src/host/skills/reconcile-orchestrator.ts` — accept optional `mcpApplier` + `proxyApplier`; call them after DB write.
- `src/host/server-init.ts` — construct appliers, thread through `HostCore`.
- `src/host/server.ts` — call `rehydrateSkillsForAgents` at boot; share `orchestratorDeps` with reconcile-hook handler.
- `tests/host/skills/reconcile-orchestrator.test.ts` — 3 new cases.
- `tests/host/proxy-domain-list.test.ts` — 5 new cases.
- `.claude/journal/host/skills.md` — per-task entries + summary.

**Keep untouched (explicit):**
- `src/host/proxy-domain-list.ts` `addSkillDomains`/`removeSkillDomains` — legacy; phase 7 removes.
- `src/host/ipc-handlers/skills.ts` — legacy `skill_install` handler still registers via the old API; phase 7 cleanup.

---

## Execution

**Chosen path:** Subagent-Driven Development (this session). REQUIRED SUB-SKILL: `superpowers:subagent-driven-development`.
