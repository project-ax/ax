// src/providers/workspace/lifecycle.ts — Unified workspace lifecycle for all sandbox providers.
//
// Replaces the hard-coded three-phase orchestration in server-completions.ts.
// Host-side providers (Docker/Apple/subprocess): prepare/finalize on host paths.
// Sandbox-side providers (k8s): prepare/finalize happen in-pod via NATS payload.

import { getLogger } from '../../logger.js';

const logger = getLogger().child({ component: 'workspace-lifecycle' });

// ═══════════════════════════════════════════════════════
// Lifecycle Plan — built once per turn
// ═══════════════════════════════════════════════════════

export interface WorkspaceLifecyclePlan {
  /** GCS prefix for workspace scopes (base — scope/id appended per scope). */
  gcsPrefix?: string;
  /** Agent name (for agent scope GCS prefix). */
  agentName: string;
  /** User ID (for user scope GCS prefix). */
  userId: string;
  /** Session ID (for session scope GCS prefix). */
  sessionId: string;
  /** Whether the agent workspace is writable (admin user). */
  agentWorkspaceWritable: boolean;
  /** Scratch workspace host path (for host-side prepare/finalize). */
  scratchPath?: string;
}

/**
 * Build a lifecycle plan from the current request context.
 */
export function buildLifecyclePlan(opts: {
  gcsPrefix?: string;
  agentName: string;
  userId: string;
  sessionId: string;
  agentWorkspaceWritable: boolean;
  scratchPath?: string;
}): WorkspaceLifecyclePlan {
  return {
    gcsPrefix: opts.gcsPrefix,
    agentName: opts.agentName,
    userId: opts.userId,
    sessionId: opts.sessionId,
    agentWorkspaceWritable: opts.agentWorkspaceWritable,
    scratchPath: opts.scratchPath,
  };
}
