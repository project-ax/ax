// src/host/skills/startup-rehydrate.ts — On host boot, re-run reconcile for
// every known agent so in-memory appliers rebuild live state from DB + bare
// repo. Agents without a repo throw inside buildSnapshotFromBareRepo; the
// orchestrator's try/catch converts that to a skills.reconcile_failed event —
// harmless for agents that never pushed a SKILL.md.
//
// Per-agent failures are caught here (in addition to the orchestrator's own
// safety net) so one bad agent can't block the rest of the fleet from
// rehydrating on startup. Failures log `startup_rehydrate_failed` and we
// continue to the next agent.

import { reconcileAgent, type OrchestratorDeps } from './reconcile-orchestrator.js';
import { getLogger } from '../../logger.js';

const logger = getLogger().child({ component: 'skills-rehydrate' });

export interface RehydrateOptions {
  /** Defaults to 'refs/heads/main' — which ref to reconcile on startup. */
  ref?: string;
  /** Seam for testing; real code uses reconcileAgent. */
  runReconcile?: (agentId: string) => Promise<void>;
}

/**
 * Walk `agentIds` and run a reconcile for each so the in-memory MCP registry
 * and proxy allowlist match the DB-persisted desired state after a host
 * restart. Per-agent failures are logged and swallowed — rehydration is
 * best-effort; the next reconcile (push-time hook) will catch up.
 */
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
