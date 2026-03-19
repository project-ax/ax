/**
 * IPC handlers: skill search (ClawHub), audit, and credential requests.
 */
import type { ProviderRegistry } from '../../types.js';
import type { IPCContext } from '../ipc-server.js';
import * as clawhub from '../../clawhub/registry-client.js';
import { getLogger } from '../../logger.js';

const logger = getLogger().child({ component: 'ipc-skills' });

export interface SkillsHandlerOptions {
  requestedCredentials?: Map<string, Set<string>>;
}

export function createSkillsHandlers(providers: ProviderRegistry, opts?: SkillsHandlerOptions) {
  return {
    skill_search: async (req: any, ctx: IPCContext) => {
      const { query, limit } = req;
      const results = await clawhub.search(query, limit ?? 20);
      await providers.audit.log({
        action: 'skill_search',
        sessionId: ctx.sessionId,
        args: { query },
      });
      return { results };
    },

    audit_query: async (req: any) => {
      return { entries: await providers.audit.query(req.filter ?? {}) };
    },

    credential_request: async (req: any, ctx: IPCContext) => {
      const { envName } = req;
      if (opts?.requestedCredentials) {
        let envNames = opts.requestedCredentials.get(ctx.sessionId);
        if (!envNames) {
          envNames = new Set();
          opts.requestedCredentials.set(ctx.sessionId, envNames);
        }
        envNames.add(envName);
      }
      logger.info('credential_request_recorded', { envName, sessionId: ctx.sessionId });
      await providers.audit.log({
        action: 'credential_request',
        sessionId: ctx.sessionId,
        args: { envName },
      });
      return { ok: true };
    },
  };
}
