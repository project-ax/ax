// src/providers/workspace/none.ts — No-op workspace provider (default)
//
// Stub that disables workspace persistence. The workspace_mount tool
// is not registered when this provider is active. AX behaves exactly
// as it does without workspaces — no breaking change.

import type { WorkspaceProvider } from './types.js';
import type { Config } from '../../types.js';

export async function create(_config: Config): Promise<WorkspaceProvider> {
  return {
    async mount() {
      return { paths: {} };
    },

    async commit() {
      return { scopes: {} };
    },

    async cleanup() {},

    activeMounts() {
      return [];
    },
  };
}
