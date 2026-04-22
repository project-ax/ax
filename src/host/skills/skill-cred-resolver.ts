/**
 * Shared skill-credential value resolver.
 *
 * Originally, `resolveMcpAuthHeadersByCredential` in `server-completions.ts`
 * handled the full lookup AND also built the `Authorization: Bearer ...`
 * header in one pass — convenient for MCP which only knows bearer tokens,
 * but wrong for OpenAPI dispatch where the auth scheme can be `basic`,
 * `api_key_header`, or `api_key_query`. Those build different header/query
 * shapes that still reuse the same underlying credential value.
 *
 * This helper factors out the value-only lookup: given an envName + per-
 * request identity + the skill-cred store, returns the raw credential
 * string (or `undefined` when no row matches AND no `process.env` fallback
 * is set). Callers build their own header/query shape on top.
 *
 * Scope precedence (identical to `resolveMcpAuthHeadersByCredential`):
 *   1. A row where `user_id === userId` wins.
 *   2. A row where `user_id === ''` (agent-scope sentinel) is the fallback.
 *   3. Otherwise the first matching row.
 *   4. If no rows match at all, fall back to `process.env[envName]` —
 *      covers dev/infra creds that were never written to `skill_credentials`.
 *
 * DO NOT log the returned value — caller owns logging of the derived
 * header/query shape (with redaction). This helper intentionally returns a
 * plain string so the call site can't accidentally leak the raw value via
 * a formatted header string.
 */

import type { SkillCredStore } from './skill-cred-store.js';

export async function resolveCredentialValueByEnvName(args: {
  envName: string;
  agentId: string;
  userId: string;
  skillCredStore: SkillCredStore;
}): Promise<string | undefined> {
  const { envName, agentId, userId, skillCredStore } = args;
  const rows = await skillCredStore.listForAgent(agentId);
  const matching = rows.filter((r) => r.envName === envName);
  if (matching.length === 0) {
    return process.env[envName] ?? undefined;
  }
  const user = matching.find((r) => r.userId === userId);
  const agent = matching.find((r) => r.userId === '');
  const selected = user ?? agent ?? matching[0];
  return selected.value || undefined;
}
