/**
 * IPC handlers: workspace provider operations.
 *
 * Workspace provider model (workspace_mount):
 * - agent:   shared persistent workspace
 * - user:    per-user persistent workspace
 * - session: temporary scratch for the current session
 *
 * All writes go through the workspace provider's mount/diff/commit pipeline,
 * which enforces structural checks and content scanning before persistence.
 */
import type { ProviderRegistry } from '../../types.js';
import type { IPCContext } from '../ipc-server.js';
import type { WorkspaceScope } from '../../providers/workspace/types.js';

export interface WorkspaceHandlerOptions {
  agentName: string;
  profile: string;
}

export function createWorkspaceHandlers(providers: ProviderRegistry, opts: WorkspaceHandlerOptions) {
  return {
    workspace_mount: async (req: any, ctx: IPCContext) => {
      const requestedScopes = req.scopes as WorkspaceScope[];

      // Determine which scopes are not yet active
      const currentScopes = providers.workspace.activeMounts(ctx.sessionId);
      const newScopes = requestedScopes.filter(s => !currentScopes.includes(s));

      if (newScopes.length === 0) {
        // All requested scopes already active — return current state
        return {
          mounted: currentScopes,
          paths: {},
        };
      }

      // Mount new scopes (additive), passing userId for user scope resolution
      const mounts = await providers.workspace.mount(ctx.sessionId, newScopes, { userId: ctx.userId });

      await providers.audit.log({
        action: 'workspace_mount',
        sessionId: ctx.sessionId,
        args: { scopes: newScopes, allScopes: [...currentScopes, ...newScopes] },
      });

      return {
        mounted: [...currentScopes, ...newScopes],
        paths: mounts.paths,
      };
    },

  };
}
