// src/host/skills/get-agent-skills.ts — Live-computed per-agent skill states.
//
// Walks the agent's workspace repo at refs/heads/main and derives
// enabled/pending/invalid for each declared skill by diffing frontmatter
// against the host's approved domains + stored credentials. Caches the
// git snapshot keyed on (agentId, HEAD sha) so hot agents at a stable
// HEAD avoid the ls-tree + show round-trips.

import { buildSnapshotFromBareRepo } from './snapshot.js';
import { computeSetupQueue, computeSkillStates } from './state-derivation.js';
import { normalizeDomain } from './domain-allowlist.js';
import { registerMcpServersFromSnapshot } from './mcp-registry-sync.js';
import type { SetupRequest, SkillSnapshotEntry, SkillState } from './types.js';
import type { SnapshotCache } from './snapshot-cache.js';
import type { SkillCredStore } from './skill-cred-store.js';
import type { SkillDomainStore } from './skill-domain-store.js';
import type { McpConnectionManager } from '../../plugins/mcp-manager.js';

export interface GetAgentSkillsDeps {
  /** Tuple-keyed credential store. `storedCredentials` is populated by
   *  reading `skill_credentials` rows for the agent. */
  skillCredStore: SkillCredStore;
  /** Tuple-keyed domain approval store. `approvedDomains` is populated
   *  by reading `skill_domain_approvals` rows for the agent. */
  skillDomainStore: SkillDomainStore;
  /** Resolve the bare repo path for an agent (may fetch/clone for git-http). */
  getBareRepoPath(agentId: string): string | Promise<string>;
  /** HEAD sha of refs/heads/main in the agent's repo. Empty string (or any
   *  stable sentinel) for repos with no commits yet. */
  probeHead(agentId: string): Promise<string>;
  /** Per-host-process snapshot cache keyed on `${agentId}@${headSha}`. */
  snapshotCache: SnapshotCache<SkillSnapshotEntry[]>;
  /** When present, `loadSnapshot` re-asserts this agent's skill-declared
   *  MCP servers on the global registry after each load (cache hit OR miss).
   *  Lazy hook — no startup scan; work scales with session traffic. */
  mcpManager?: McpConnectionManager;
}

const HEAD_REF = 'refs/heads/main';

/**
 * Load the git-backed skill snapshot for an agent. Cached per-(agentId, HEAD
 * sha). Exported so `domain-allowlist.ts` can reuse the same snapshot walk
 * without re-running ls-tree. Consumers that need states/setup-queue should
 * use `getAgentSkills` / `getAgentSetupQueue` instead.
 */
export async function loadSnapshot(
  agentId: string,
  deps: Pick<GetAgentSkillsDeps, 'probeHead' | 'getBareRepoPath' | 'snapshotCache' | 'mcpManager'>,
): Promise<SkillSnapshotEntry[]> {
  const headSha = await deps.probeHead(agentId);
  const cacheKey = `${agentId}@${headSha}`;
  const cached = deps.snapshotCache.get(cacheKey);
  if (cached) {
    // Re-assert MCP servers on cache hits too — the registry is in-memory
    // and gets wiped on host restart, but the snapshot cache is rebuilt
    // from git at first access. Idempotent `addServer` makes this cheap.
    if (deps.mcpManager) registerMcpServersFromSnapshot(agentId, cached, deps.mcpManager);
    return cached;
  }

  const bareRepoPath = await deps.getBareRepoPath(agentId);
  const snapshot = await buildSnapshotFromBareRepo(bareRepoPath, HEAD_REF);
  deps.snapshotCache.put(cacheKey, snapshot);
  if (deps.mcpManager) registerMcpServersFromSnapshot(agentId, snapshot, deps.mcpManager);
  return snapshot;
}

/**
 * One-pass projection of the rows `skill_domain_approvals` + `skill_credentials`
 * hold for an agent into the shapes both `computeSkillStates` /
 * `computeSetupQueue` and `getAllowedDomainsForAgent` need.
 *
 * Both projections are skill-scoped so a deleted-and-re-added skill's state
 * derives only from rows with its own `skill_name` — prior approvals for
 * other (or removed) skills don't silently satisfy its requirements.
 *
 * - `approvalsBySkill` — `skillName → Set<domain>` for the "is (skill, domain)
 *   approved?" lookup. Consumed by the proxy allowlist query.
 * - `approvedDomains` — `${skillName}/${normalizedDomain}` keys.
 *   `{approvedDomains}` input to `computeSkillStates` / `computeSetupQueue`.
 * - `storedCredentials` — `${skillName}/${envName}@${scope}` keys where
 *   scope ∈ {'agent', 'user'}.
 *     - When `userId` is provided (per-user runtime state derivation), a
 *       row contributes `@user` only when `row.userId === userId`. Without
 *       this, Alice's user-scoped row would satisfy Bob's skill state
 *       ("skill looks enabled for everyone"), which is the PR #185 review
 *       issue #6.
 *     - When `userId` is undefined (admin-wide aggregate views), ANY
 *       non-empty `row.userId` contributes `@user` — matches the prior
 *       behavior and preserves the dashboard's "at least one user has
 *       stored a value" semantics.
 *     - The empty user_id sentinel always contributes `@agent`.
 */
export async function loadAgentProjection(
  agentId: string,
  deps: Pick<GetAgentSkillsDeps, 'skillDomainStore' | 'skillCredStore'>,
  /** The user whose perspective this projection serves. When provided,
   *  user-scoped rows for a DIFFERENT user are not counted — their
   *  existence doesn't satisfy the caller's skill-state requirements.
   *  Omit for admin aggregate views. */
  userId?: string,
): Promise<{
  approvalsBySkill: Map<string, Set<string>>;
  approvedDomains: Set<string>;
  storedCredentials: Set<string>;
}> {
  const [approvalRows, credRows] = await Promise.all([
    deps.skillDomainStore.listForAgent(agentId),
    deps.skillCredStore.listForAgent(agentId),
  ]);

  const approvalsBySkill = new Map<string, Set<string>>();
  const approvedDomains = new Set<string>();
  for (const row of approvalRows) {
    const norm = normalizeDomain(row.domain);
    let bucket = approvalsBySkill.get(row.skillName);
    if (!bucket) {
      bucket = new Set();
      approvalsBySkill.set(row.skillName, bucket);
    }
    bucket.add(norm);
    approvedDomains.add(`${row.skillName}/${norm}`);
  }

  const storedCredentials = new Set<string>();
  for (const row of credRows) {
    if (row.userId === '') {
      // Agent-scope row — always contributes regardless of viewer.
      storedCredentials.add(`${row.skillName}/${row.envName}@agent`);
      continue;
    }
    // Non-empty userId — a user-scoped row.
    if (userId === undefined) {
      // Aggregate view: any user's row surfaces @user (prior behavior).
      storedCredentials.add(`${row.skillName}/${row.envName}@user`);
    } else if (row.userId === userId) {
      // Per-user view: only THIS user's row counts as satisfied.
      storedCredentials.add(`${row.skillName}/${row.envName}@user`);
    }
    // else: row belongs to a different user — do not satisfy the
    // current viewer's state.
  }

  return { approvalsBySkill, approvedDomains, storedCredentials };
}

/**
 * Delete `skill_credentials` + `skill_domain_approvals` rows for every
 * skill_name that's no longer in the workspace snapshot. Returns the list
 * of skill names that got swept.
 *
 * Rationale: "delete-then-re-add" of a skill should require a fresh admin
 * approval. Without this sweep, orphaned rows from a prior approval would
 * silently re-satisfy the re-added skill's requirements and skip the
 * approval card.
 *
 * Safety: the snapshot argument must be trusted (built from the canonical
 * bare repo). A temporarily-empty snapshot (no skills at HEAD) correctly
 * sweeps every row — that IS the invariant. Callers that might have a
 * wrong/empty snapshot should skip the sweep instead.
 */
export async function sweepOrphanedRows(
  agentId: string,
  snapshot: SkillSnapshotEntry[],
  deps: Pick<GetAgentSkillsDeps, 'skillDomainStore' | 'skillCredStore'>,
): Promise<string[]> {
  const snapshotNames = new Set(snapshot.map(e => e.name));

  const [approvalRows, credRows] = await Promise.all([
    deps.skillDomainStore.listForAgent(agentId),
    deps.skillCredStore.listForAgent(agentId),
  ]);

  const orphaned = new Set<string>();
  for (const row of approvalRows) {
    if (!snapshotNames.has(row.skillName)) orphaned.add(row.skillName);
  }
  for (const row of credRows) {
    if (!snapshotNames.has(row.skillName)) orphaned.add(row.skillName);
  }

  for (const skillName of orphaned) {
    await deps.skillCredStore.deleteForSkill(agentId, skillName);
    await deps.skillDomainStore.deleteForSkill(agentId, skillName);
  }

  return [...orphaned];
}

export async function getAgentSkills(
  agentId: string,
  deps: GetAgentSkillsDeps,
  /** Perspective user for credential scoping. When provided, user-scoped
   *  rows stored by a different user do NOT count as satisfying skill
   *  requirements for the current caller. Omit for admin aggregate
   *  views (dashboard) where any-user presence is the intended signal. */
  userId?: string,
): Promise<SkillState[]> {
  const snapshot = await loadSnapshot(agentId, deps);
  await sweepOrphanedRows(agentId, snapshot, deps);
  const projection = await loadAgentProjection(agentId, deps, userId);
  return computeSkillStates(snapshot, {
    approvedDomains: projection.approvedDomains,
    storedCredentials: projection.storedCredentials,
  });
}

/**
 * Pending setup cards for an agent, derived live from the git snapshot + host
 * approvals/credentials. One card per skill that has missing credentials or
 * unapproved domains; skills with neither (enabled) and skills with invalid
 * frontmatter are excluded.
 */
export async function getAgentSetupQueue(
  agentId: string,
  deps: GetAgentSkillsDeps,
  /** See `getAgentSkills`. Admin setup-card aggregates keep the prior
   *  "any-user satisfies" behavior by leaving this undefined. */
  userId?: string,
): Promise<SetupRequest[]> {
  const snapshot = await loadSnapshot(agentId, deps);
  await sweepOrphanedRows(agentId, snapshot, deps);
  const projection = await loadAgentProjection(agentId, deps, userId);
  return computeSetupQueue(snapshot, {
    approvedDomains: projection.approvedDomains,
    storedCredentials: projection.storedCredentials,
  });
}
