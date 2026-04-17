import type {
  SkillSnapshotEntry,
  SkillState,
  ReconcilerCurrentState,
} from './types.js';

/**
 * Per-skill enabled/pending/invalid. Exposed as a named export for
 * focused testing; the top-level `reconcile` composes this with the
 * rest of the pipeline.
 */
export function computeSkillStates(
  snapshot: SkillSnapshotEntry[],
  current: Pick<ReconcilerCurrentState, 'approvedDomains' | 'storedCredentials'>,
): SkillState[] {
  return snapshot.map((entry) => {
    if (!entry.ok) {
      return { name: entry.name, kind: 'invalid', error: entry.error };
    }
    const fm = entry.frontmatter;
    const reasons: string[] = [];

    for (const cred of fm.credentials) {
      const key = `${cred.envName}@${cred.scope}`;
      if (!current.storedCredentials.has(key)) {
        reasons.push(`missing credential ${cred.envName} (${cred.scope})`);
      }
    }
    for (const domain of fm.domains) {
      if (!current.approvedDomains.has(domain)) {
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
