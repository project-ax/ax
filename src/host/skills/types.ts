import type { SkillFrontmatter } from '../../skills/frontmatter-schema.js';

/** One parsed SKILL.md or a parse failure. Input to the state-derivation helpers. */
export type SkillSnapshotEntry =
  | { name: string; ok: true; frontmatter: SkillFrontmatter; body: string }
  | { name: string; ok: false; error: string };

/** Approvals + storage state the host holds. Input alongside the snapshot
 *  for `computeSkillStates` / `computeSetupQueue`. Keys are skill-scoped so
 *  a deleted-and-re-added skill doesn't auto-satisfy from a prior skill's
 *  leftover rows. */
export interface SkillDerivationState {
  /** Approved domains, keyed by `${skillName}/${normalizedDomain}`. */
  approvedDomains: ReadonlySet<string>;
  /** Stored credentials, keyed by `${skillName}/${envName}@${scope}` (scope ∈ 'user' | 'agent'). */
  storedCredentials: ReadonlySet<string>;
}

export type SkillStateKind = 'enabled' | 'pending' | 'invalid';

export interface SkillState {
  name: string;
  kind: SkillStateKind;
  /** Human-readable reasons. Present for pending and invalid. */
  pendingReasons?: string[];
  /** Full error string for invalid. */
  error?: string;
  /** Short description surfaced in the prompt index. Present for valid frontmatter. */
  description?: string;
}

/** An entry queued onto a skill's setup card in the dashboard.
 *
 *  The card surface is intentionally editable — the admin dashboard lets
 *  the human override any field the agent-authored SKILL.md got wrong
 *  (envName, authType, scope, URL, transport, domains). The backend
 *  test-&-approve flow probes the edited values before persisting; on
 *  success it rewrites SKILL.md in the agent's repo so the git-backed
 *  source of truth stays aligned with what actually works. */
export interface SetupRequest {
  skillName: string;
  description: string;
  /** Every declared credential — including ones already satisfied by
   *  skill_credentials rows. The UI renders all of them so authType /
   *  envName / scope stay editable after the admin has typed a value;
   *  `hasExistingValue` is decorated per-entry by `getAgentSetupQueue`. */
  credentials: Array<{
    envName: string;
    authType: 'api_key' | 'oauth';
    scope: 'user' | 'agent';
    oauth?: {
      provider: string;
      clientId: string;
      authorizationUrl: string;
      tokenUrl: string;
      scopes: string[];
    };
  }>;
  /** Subset of `credentials` whose stored value is still missing. Kept for
   *  backward compatibility with code that only cares about what remains
   *  to collect — the UI now renders from `credentials` and decorates
   *  `hasExistingValue` inline. */
  missingCredentials: Array<{
    envName: string;
    authType: 'api_key' | 'oauth';
    scope: 'user' | 'agent';
    oauth?: {
      provider: string;
      clientId: string;
      authorizationUrl: string;
      tokenUrl: string;
      scopes: string[];
    };
  }>;
  /** Every declared domain — the `approved` flag tells the UI whether the
   *  admin has already checked off a given hostname. Lets the approval card
   *  surface the full domain list (editable, addable) instead of only the
   *  unapproved subset, matching the editability story for credentials +
   *  mcpServers. */
  domains: Array<{ domain: string; approved: boolean }>;
  /** Subset of `domains` still awaiting approval. Back-compat alias for
   *  older clients — prefer `domains` in new code. */
  unapprovedDomains: string[];
  /** Full MCP server list — name, url, transport, and the credential
   *  reference (envName string). All of these are editable in the card. */
  mcpServers: Array<{
    name: string;
    url: string;
    transport: 'http' | 'sse';
    /** Bare envName string from the skill's top-level `credentials[]` —
     *  the `mcpServers[].credential` frontmatter field. Absent when the
     *  server doesn't need a credential (rare). */
    credential?: string;
  }>;
}
