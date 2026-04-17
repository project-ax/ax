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
