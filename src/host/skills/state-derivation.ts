// src/host/skills/state-derivation.ts — Pure helpers that derive a skill's
// enable state and setup-card payload from a parsed snapshot plus the host's
// current approvals + stored credentials. Shared between `getAgentSkills`
// and `getAgentSetupQueue`.

import type {
  SkillSnapshotEntry,
  SkillState,
  SkillDerivationState,
  SetupRequest,
} from './types.js';

/** Per-skill enabled/pending/invalid. */
export function computeSkillStates(
  snapshot: SkillSnapshotEntry[],
  current: Pick<SkillDerivationState, 'approvedDomains' | 'storedCredentials'>,
): SkillState[] {
  return snapshot.map((entry) => {
    if (!entry.ok) {
      return { name: entry.name, kind: 'invalid', error: entry.error };
    }
    const fm = entry.frontmatter;
    const reasons: string[] = [];

    for (const cred of fm.credentials) {
      const key = `${entry.name}/${cred.envName}@${cred.scope}`;
      if (!current.storedCredentials.has(key)) {
        reasons.push(`missing credential ${cred.envName} (${cred.scope})`);
      }
    }
    for (const domain of fm.domains) {
      if (!current.approvedDomains.has(`${entry.name}/${domain}`)) {
        reasons.push(`domain not approved: ${domain}`);
      }
    }
    if (reasons.length === 0) {
      return { name: entry.name, kind: 'enabled', description: fm.description };
    }
    return {
      name: entry.name,
      kind: 'pending',
      pendingReasons: reasons,
      description: fm.description,
    };
  });
}

/** Setup-card payloads for every skill with at least one unmet requirement.
 *
 *  The card now carries the full editable frontmatter surface (every
 *  credential, every domain, every mcpServer with transport + credential
 *  ref) so the admin dashboard can let a human correct agent-authored
 *  SKILL.md before enabling. `missingCredentials` + `unapprovedDomains`
 *  are kept as derived subsets for back-compat with code that only cares
 *  about what remains to collect. */
export function computeSetupQueue(
  snapshot: SkillSnapshotEntry[],
  current: Pick<SkillDerivationState, 'approvedDomains' | 'storedCredentials'>,
): SetupRequest[] {
  const out: SetupRequest[] = [];
  for (const entry of snapshot) {
    if (!entry.ok) continue;
    const fm = entry.frontmatter;
    const credentials = fm.credentials.map((c) => ({
      envName: c.envName,
      authType: c.authType,
      scope: c.scope,
      oauth: c.oauth,
    }));
    const missingCredentials = credentials
      .filter((c) => !current.storedCredentials.has(`${entry.name}/${c.envName}@${c.scope}`));
    const domains = fm.domains.map((d) => ({
      domain: d,
      approved: current.approvedDomains.has(`${entry.name}/${d}`),
    }));
    const unapprovedDomains = domains.filter((d) => !d.approved).map((d) => d.domain);
    if (missingCredentials.length === 0 && unapprovedDomains.length === 0) continue;
    out.push({
      skillName: entry.name,
      description: fm.description,
      credentials,
      missingCredentials,
      domains,
      unapprovedDomains,
      mcpServers: fm.mcpServers.map((m) => ({
        name: m.name,
        url: m.url,
        transport: m.transport,
        ...(m.credential !== undefined ? { credential: m.credential } : {}),
      })),
    });
  }
  return out;
}
