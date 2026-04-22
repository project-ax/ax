/**
 * Normalize + compare two SKILL.md frontmatter objects to detect
 * agent-driven drift from admin-approved state.
 *
 * Why this exists: the agent can call `skill_write` during heartbeat / cron
 * turns to "fix" a pending skill. If the new frontmatter picks a different
 * envName, credential ref, URL, transport, or scope from what the admin
 * approved via Test-&-Enable, the host's stored credential row no longer
 * satisfies the skill's declaration — the skill flips PENDING and every
 * subsequent turn's catalog build 401s until an admin re-approves. Silent
 * correctness bug that looks exactly like "expired API key".
 *
 * Policy: non-chat sessions (heartbeat, cron, channel) can still create
 * brand-new skills or edit the markdown body, but can't change the
 * frontmatter of an existing skill. This function answers the narrow
 * question needed for that policy.
 */

import type { SkillFrontmatter } from './frontmatter-schema.js';

/** Deep, key-order-independent JSON representation. Used to fingerprint
 *  frontmatter for equality comparison. `undefined` fields are dropped so
 *  `{x: undefined}` and `{}` compare equal (matches YAML serializer
 *  behavior — missing vs. explicit-null are treated the same). */
function canonicalize(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return '[' + value.map(canonicalize).join(',') + ']';
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalize(obj[k])).join(',') + '}';
}

/** Compare two parsed frontmatter objects by their canonical JSON form.
 *  True when ANY field differs. */
export function frontmattersEqual(a: SkillFrontmatter, b: SkillFrontmatter): boolean {
  return canonicalize(a) === canonicalize(b);
}

/** Describe which top-level fields changed between `before` and `after`.
 *  Returned as a sorted list of field names, suitable for user-facing
 *  error messages ("name / credentials / mcpServers changed"). Used by
 *  the non-chat-session guard to tell the agent exactly what part of
 *  its proposed write is disallowed. */
export function changedFrontmatterFields(
  before: SkillFrontmatter,
  after: SkillFrontmatter,
): string[] {
  const changed: string[] = [];
  const keys: (keyof SkillFrontmatter)[] = [
    'name', 'description', 'source', 'credentials', 'mcpServers', 'domains',
  ];
  for (const key of keys) {
    if (canonicalize(before[key]) !== canonicalize(after[key])) {
      changed.push(String(key));
    }
  }
  return changed;
}

/** Is this session one where frontmatter mutations are allowed?
 *
 *  Chat-UI turns (`http:dm:...`) are user-initiated — the admin is
 *  directly driving the conversation and any `skill_write` call is an
 *  explicit action. Every other provider (scheduler, cron, slack,
 *  webhook) is agent-self-initiated or channel-originated; those must
 *  not be able to rewrite frontmatter of an already-existing skill. */
export function isInteractiveSession(sessionId: string | undefined): boolean {
  if (!sessionId) return false;
  return sessionId.startsWith('http:');
}
