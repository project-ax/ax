// src/host/server-admin-skills-helpers.ts
//
// Admin-side test-and-enable flow. Replaces the old "approve" split —
// Test-&-Enable is one atomic step that probes the (possibly edited)
// frontmatter, and only if every MCP server answers listTools, writes
// credentials + approves domains + rewrites SKILL.md in the agent's repo.
// Nothing persists when a probe fails.
//
// Editable fields the admin can override per card (mirrors SetupRequest):
//   - credentials[]: envName, authType, scope
//   - mcpServers[]: url, transport, credential ref
//   - domains[]: full target list (add/remove)
//
// Credentials never enter the audit log.

import { z } from 'zod';
import { stringify as stringifyYaml } from 'yaml';
import type { Config, ProviderRegistry } from '../types.js';
import type { AuditProvider } from '../providers/audit/types.js';
import type { SkillCredStore } from './skills/skill-cred-store.js';
import type { SkillDomainStore } from './skills/skill-domain-store.js';
import type { SkillState } from './skills/types.js';
import type { UrlRewriteMap } from '../plugins/url-rewrite.js';
import { loadSnapshot, getAgentSkills, type GetAgentSkillsDeps } from './skills/get-agent-skills.js';
import { probeMcpServers, type ProbeMcpServerInput } from './skills/probe-mcp-server.js';
import { parseSkillFile } from '../skills/parser.js';
import type { SkillOpenApiSource } from '../skills/frontmatter-schema.js';

const ENV_NAME_RE = /^[A-Z][A-Z0-9_]{1,63}$/;

// ── Body schema ──────────────────────────────────────────────────────────────
//
// The admin dashboard posts the FULL intended frontmatter shape (every
// editable field, even unedited ones) plus credential values. Duplicates
// the SkillFrontmatterSchema rules so validation errors surface at the
// HTTP layer with actionable messages — parseSkillFile runs again on the
// composed YAML for defense-in-depth, but failing there would be "invalid
// frontmatter after we built it ourselves" rather than an admin error.

const OAuthBlockSchema = z
  .object({
    provider: z.string().min(1).max(100),
    clientId: z.string().min(1).max(500),
    authorizationUrl: z.string().url().startsWith('https://'),
    tokenUrl: z.string().url().startsWith('https://'),
    scopes: z.array(z.string().min(1)).default([]),
  })
  .strict();

const CredentialEditSchema = z
  .object({
    envName: z.string().regex(ENV_NAME_RE),
    authType: z.enum(['api_key', 'oauth']).default('api_key'),
    scope: z.enum(['user', 'agent']).default('user'),
    oauth: OAuthBlockSchema.optional(),
  })
  .strict()
  .refine(
    (c) => c.authType !== 'oauth' || c.oauth !== undefined,
    { message: 'oauth authType requires an oauth block' },
  );

const McpServerEditSchema = z
  .object({
    name: z.string().min(1).max(100),
    url: z.string().url().startsWith('https://'),
    transport: z.enum(['http', 'sse']),
    credential: z.string().regex(ENV_NAME_RE).optional(),
    include: z.array(z.string().min(1)).optional(),
    exclude: z.array(z.string().min(1)).optional(),
  })
  .strict();

export const ApproveBodySchema = z
  .object({
    agentId: z.string().min(1),
    skillName: z.string().min(1),
    /** The admin's intended final frontmatter for the three editable
     *  sections. Non-editable fields (name, description, source) are
     *  preserved from the current SKILL.md. */
    frontmatter: z
      .object({
        credentials: z.array(CredentialEditSchema).default([]),
        mcpServers: z.array(McpServerEditSchema).default([]),
        domains: z.array(z.string().min(1)).default([]),
      })
      .strict(),
    /** Per-envName value the admin typed into the password field. An
     *  empty string means "reuse the stored value for this envName". A
     *  missing entry for an OAuth cred is expected (OAuth goes through
     *  the dedicated start/callback flow). */
    credentialValues: z
      .array(
        z.object({
          envName: z.string().regex(ENV_NAME_RE),
          value: z.string(),
        }),
      )
      .default([]),
    userId: z.string().optional(),
  })
  .strict();

export type ApproveBody = z.infer<typeof ApproveBodySchema>;

// ── Helper deps ─────────────────────────────────────────────────────────────

export interface ApproveDeps {
  providers: Pick<ProviderRegistry, 'audit' | 'workspace'>;
  config: Config;
  defaultUserId?: string;
  skillCredStore: SkillCredStore;
  skillDomainStore: SkillDomainStore;
  /** Live git-backed skill state loader. Used to read the current
   *  SKILL.md (frontmatter + body) so non-editable fields survive, and
   *  to recompute state after the commit lands. */
  agentSkillsDeps: GetAgentSkillsDeps;
  /** Optional URL rewrites — the e2e mock harness sets these so probe
   *  requests land on the mock server instead of the real vendor. */
  urlRewrites?: UrlRewriteMap;
}

export interface ProbeFailureDetail {
  name: string;
  error: string;
}

export type ApproveResult =
  | { ok: true; state: SkillState | undefined; commit?: string | null }
  | { ok: false; status: number; error: string; details?: string; probeFailures?: ProbeFailureDetail[] };

// ── YAML serialization ───────────────────────────────────────────────────────

/** Serialize intended frontmatter to the canonical key order that matches
 *  what skill-creator produces (name → description → source → credentials →
 *  mcpServers → openapi → domains). Omits empty arrays/undefineds so the diff
 *  against what the agent wrote stays minimal.
 *
 *  `openapi[]` is operational (drives catalog population) — MUST be preserved
 *  across the approval rewrite. A prior version of this function omitted it,
 *  which silently torched the spec/baseUrl/auth/include/exclude block on every
 *  approve, leaving the skill "enabled" with zero tools in the catalog and no
 *  error surface. Caught in the field via the petstore skill.
 */
export function serializeFrontmatter(fm: {
  name: string;
  description: string;
  source?: { url: string; version?: string };
  credentials: ApproveBody['frontmatter']['credentials'];
  mcpServers: ApproveBody['frontmatter']['mcpServers'];
  openapi?: SkillOpenApiSource[];
  domains: string[];
}): Record<string, unknown> {
  const out: Record<string, unknown> = {
    name: fm.name,
    description: fm.description,
  };
  if (fm.source) out.source = fm.source;
  if (fm.credentials.length > 0) {
    out.credentials = fm.credentials.map((c) => {
      const entry: Record<string, unknown> = { envName: c.envName, authType: c.authType, scope: c.scope };
      if (c.oauth) entry.oauth = c.oauth;
      return entry;
    });
  }
  if (fm.mcpServers.length > 0) {
    out.mcpServers = fm.mcpServers.map((m) => {
      const entry: Record<string, unknown> = { name: m.name, url: m.url, transport: m.transport };
      if (m.credential) entry.credential = m.credential;
      if (m.include) entry.include = m.include;
      if (m.exclude) entry.exclude = m.exclude;
      return entry;
    });
  }
  if (fm.openapi && fm.openapi.length > 0) {
    out.openapi = fm.openapi.map((o) => {
      const entry: Record<string, unknown> = { spec: o.spec, baseUrl: o.baseUrl };
      if (o.auth) entry.auth = o.auth;
      if (o.include) entry.include = o.include;
      if (o.exclude) entry.exclude = o.exclude;
      return entry;
    });
  }
  if (fm.domains.length > 0) out.domains = fm.domains;
  return out;
}

// ── Main helper ──────────────────────────────────────────────────────────────

export async function approveSkillSetup(
  deps: ApproveDeps,
  body: ApproveBody,
): Promise<ApproveResult> {
  if (!deps.config?.agent_name || !deps.agentSkillsDeps) {
    return { ok: false, status: 503, error: 'Skills not configured' };
  }

  // 1. Load the current SKILL.md so we can preserve name / description / source
  //    / body, and we know what the admin is editing.
  const snapshot = await loadSnapshot(body.agentId, deps.agentSkillsDeps);
  const entry = snapshot.find((e) => e.name === body.skillName);
  if (!entry) {
    return { ok: false, status: 404, error: `No skill ${body.skillName} for agent ${body.agentId}` };
  }
  if (!entry.ok) {
    return {
      ok: false,
      status: 400,
      error: 'Current SKILL.md is invalid; cannot edit through admin dashboard',
      details: entry.error,
    };
  }
  const current = entry.frontmatter;

  // 2. Guard: OAuth credentials don't go through Test-&-Enable — they use
  //    the dedicated OAuth flow. If the admin's edit list includes any
  //    OAuth entry, we still accept it in the frontmatter (it was already
  //    declared that way by the skill-creator); we just won't test it and
  //    don't require a value for it.
  const apiKeyCreds = body.frontmatter.credentials.filter((c) => c.authType === 'api_key');

  // 3. Build the rewritten SKILL.md bytes, then round-trip them through
  //    parseSkillFile. If our own serializer produces an invalid file, the
  //    probe should never fire — return a clear 500-ish error.
  const intended = serializeFrontmatter({
    name: current.name,
    description: current.description,
    source: current.source,
    credentials: body.frontmatter.credentials,
    mcpServers: body.frontmatter.mcpServers,
    // openapi[] isn't admin-editable through Test-&-Enable (the probe flow
    // only exercises MCP servers), so preserve it verbatim from whatever
    // skill-creator originally wrote. Dropping this is how an OpenAPI-only
    // skill ended up "enabled" with zero tools in the catalog.
    openapi: current.openapi,
    domains: body.frontmatter.domains,
  });
  const yamlBlock = stringifyYaml(intended, { lineWidth: 0 });
  const rewrittenContent = `---\n${yamlBlock}---\n${entry.body}`;
  const reparsed = parseSkillFile(rewrittenContent);
  if (!reparsed.ok) {
    return {
      ok: false,
      status: 400,
      error: 'Edited frontmatter is invalid',
      details: reparsed.error,
    };
  }

  // 4. Probe each MCP server with the admin's typed creds applied as
  //    Authorization headers. Skip servers whose credential ref isn't one
  //    the admin supplied AND isn't already stored.
  const userId = body.userId ?? deps.defaultUserId ?? 'admin';
  const valueByEnv = new Map(body.credentialValues.map((c) => [c.envName, c.value]));

  // Resolve a value for a given envName: prefer admin-typed, else look in
  // skill_credentials (any skill on this agent, prefer user-scoped).
  async function resolveValue(envName: string): Promise<string | undefined> {
    const typed = valueByEnv.get(envName);
    if (typed && typed.length > 0) return typed;
    const rows = await deps.skillCredStore.listForAgent(body.agentId);
    const matching = rows.filter((r) => r.envName === envName);
    if (matching.length === 0) return undefined;
    const user = matching.find((r) => r.userId === userId);
    const agent = matching.find((r) => r.userId === '');
    return user?.value ?? agent?.value ?? matching[0].value;
  }

  const probeInputs: ProbeMcpServerInput[] = [];
  for (const server of body.frontmatter.mcpServers) {
    const headers: Record<string, string> = {};
    if (server.credential) {
      const value = await resolveValue(server.credential);
      if (value) headers.Authorization = `Bearer ${value}`;
    }
    probeInputs.push({
      name: server.name,
      url: server.url,
      transport: server.transport,
      ...(Object.keys(headers).length > 0 ? { headers } : {}),
    });
  }

  const probeResults = probeInputs.length > 0
    ? await probeMcpServers(probeInputs, { urlRewrites: deps.urlRewrites })
    : [];
  const probeFailures: ProbeFailureDetail[] = probeResults
    .filter((r): r is { name: string; ok: false; error: string } => !r.ok)
    .map((r) => ({ name: r.name, error: r.error }));
  if (probeFailures.length > 0) {
    return {
      ok: false,
      status: 400,
      error: 'MCP server probe failed',
      details: probeFailures.map((f) => `${f.name}: ${f.error}`).join('; '),
      probeFailures,
    };
  }

  // ── Probe passed. Persist everything. ──────────────────────────────────────

  // 5. Commit the rewritten SKILL.md to the agent's repo. The post-receive
  //    hook (installed at repo creation) fires reconcile automatically —
  //    no extra cache-invalidation call needed.
  let commitSha: string | null = null;
  if (rewrittenContent !== await readSkillFileFromBareRepo(body.agentId, body.skillName, deps.agentSkillsDeps)) {
    if (!deps.providers.workspace) {
      return { ok: false, status: 500, error: 'No workspace provider configured' };
    }
    const result = await deps.providers.workspace.commitFiles(body.agentId, {
      files: [
        {
          path: `.ax/skills/${body.skillName}/SKILL.md`,
          content: rewrittenContent,
        },
      ],
      message: `admin: edit ${body.skillName} skill frontmatter`,
      author: { name: 'AX Admin', email: 'admin@ax.internal' },
    });
    commitSha = result.commit;
  }

  // 6. Write credentials (api_key only) at the possibly-edited envName /
  //    scope. OAuth entries are skipped — they already went through the
  //    OAuth callback.
  for (const cred of apiKeyCreds) {
    const storageUserId = cred.scope === 'user' ? userId : '';
    const value = await resolveValue(cred.envName);
    if (value === undefined) {
      return {
        ok: false,
        status: 400,
        error: 'Missing credential value',
        details: `No value typed or stored for ${cred.envName}`,
      };
    }
    await deps.skillCredStore.put({
      agentId: body.agentId,
      skillName: body.skillName,
      envName: cred.envName,
      userId: storageUserId,
      value,
    });
  }

  // 7. Approve every domain in the intended frontmatter. Idempotent.
  for (const domain of body.frontmatter.domains) {
    await deps.skillDomainStore.approve({
      agentId: body.agentId,
      skillName: body.skillName,
      domain,
    });
  }

  // 8. Return state. Fetch fresh since the repo + stores just changed.
  const states = await getAgentSkills(body.agentId, deps.agentSkillsDeps);
  const state = states.find((s) => s.name === body.skillName);

  // 9. Audit — never log credential values. Include probe count for
  //    observability ("how many tools did we see?" is in the logs).
  await deps.providers.audit.log({
    action: 'skill_approved',
    sessionId: body.agentId,
    args: {
      agentId: body.agentId,
      skillName: body.skillName,
      envNames: apiKeyCreds.map((c) => c.envName),
      domains: body.frontmatter.domains,
      mcpServerCount: body.frontmatter.mcpServers.length,
      toolCountByServer: probeResults.filter((r) => r.ok).map((r) => ({
        name: r.name,
        toolCount: (r as { ok: true; toolCount: number }).toolCount,
      })),
      rewrittenSkillMd: commitSha !== null,
    },
    result: 'success',
    durationMs: 0,
  });

  return { ok: true, state, commit: commitSha };
}

/** Read `.ax/skills/<name>/SKILL.md` from the bare repo at HEAD. Used to
 *  short-circuit the commit step when the rewritten bytes are identical
 *  to what's already committed. */
async function readSkillFileFromBareRepo(
  agentId: string,
  skillName: string,
  deps: GetAgentSkillsDeps,
): Promise<string> {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const execFileAsync = promisify(execFile);
  const bareRepoPath = await deps.getBareRepoPath(agentId);
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['-C', bareRepoPath, 'show', `refs/heads/main:.ax/skills/${skillName}/SKILL.md`],
      { encoding: 'buffer', maxBuffer: 16 * 1024 * 1024 },
    );
    return stdout.toString('utf-8');
  } catch {
    return '';
  }
}
