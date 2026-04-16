// src/host/server-admin-helpers.ts — Admin helper functions backed by AgentRegistry + git workspace.

import type { AgentRegistry } from './agent-registry.js';
import type { WorkspaceProvider } from '../providers/workspace/types.js';
import { readIdentityForAgent } from './identity-reader.js';

export interface AdminContext {
  registry: AgentRegistry;
  agentId: string;
  workspace?: WorkspaceProvider;
}

/** Returns true when the agent is still in bootstrap mode (missing SOUL.md or IDENTITY.md). */
export async function isAgentBootstrapMode(ctx: AdminContext): Promise<boolean> {
  if (!ctx.workspace) return true; // No workspace provider = can't read identity = bootstrap
  const identity = await readIdentityForAgent(ctx.agentId, ctx.workspace);
  return !identity.soul || !identity.identity;
}

/** Returns true when the given userId is an admin for this agent. */
export async function isAdmin(ctx: AdminContext, userId: string): Promise<boolean> {
  const entry = await ctx.registry.get(ctx.agentId);
  if (!entry) return false;
  return entry.admins.includes(userId);
}

/** Adds a userId to the agent's admins list. */
export async function addAdmin(ctx: AdminContext, userId: string): Promise<void> {
  await ctx.registry.addAdmin(ctx.agentId, userId);
}

/**
 * Atomically claims the bootstrap admin slot for the given userId.
 * Returns true if this user is the first to claim (and is added to admins).
 * Returns false if someone already claimed it.
 */
export async function claimBootstrapAdmin(ctx: AdminContext, userId: string): Promise<boolean> {
  return ctx.registry.claimBootstrapAdmin(ctx.agentId, userId);
}
