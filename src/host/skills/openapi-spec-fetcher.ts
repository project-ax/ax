/**
 * Default `fetchOpenApiSpec` factory for `populateCatalogFromSkills`.
 *
 * The orchestrator is pure (no I/O), but production needs an implementation
 * that reaches the spec wherever the skill author pointed. Two paths:
 *
 *   1. `https://…` — hand directly to `@apidevtools/swagger-parser`, which
 *      fetches + parses + dereferences in one shot. Same trust boundary as
 *      `mcpServers[].url`: the URL is frontmatter-authored, this is a
 *      host-side discovery call (not an agent-sandbox egress), so we
 *      bypass the web proxy and go direct — same posture as MCP catalog
 *      population. `config.url_rewrites` is applied for e2e harness
 *      redirection (mock servers bound on dynamic ports).
 *
 *   2. Workspace-relative path (e.g. `./openapi.yaml`, `specs/api.json`)
 *      — skills live in a bare git repo, not on disk. We resolve the
 *      relative path against the skill's directory (`.ax/skills/<skill>/`)
 *      inside the repo, read the file content via `git show`, parse
 *      JSON or YAML, and hand the in-memory object to SwaggerParser for
 *      dereferencing.
 *
 * Security
 * ────────
 * Workspace-relative `spec` values come from frontmatter the skill author
 * controls. We reject:
 *   - Absolute paths (`/etc/passwd`) — frontmatter has no business pointing
 *     at the host filesystem.
 *   - `..` traversal segments after normalization — a spec path that
 *     escapes `.ax/skills/<skill>/` is a traversal attempt.
 *   - The sanitized path is checked with a manual containment check
 *     rather than `safePath` because the workspace "dir" is logical
 *     (a git path prefix), not a real filesystem directory — `safePath`'s
 *     `resolve()` step would resolve against cwd, not the bare repo.
 *
 * The v2 rejection is handled by the adapter downstream, but we also
 * short-circuit here: if the parsed document declares `swagger: "2.0"`
 * (or any non-3.x), we throw before calling SwaggerParser so the error
 * originates in a place an operator can grep for.
 */

import SwaggerParser from '@apidevtools/swagger-parser';
import type { OpenAPIV3 } from 'openapi-types';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parse as parseYaml } from 'yaml';
import { posix as posixPath } from 'node:path';
import { applyUrlRewrite, type UrlRewriteMap } from '../../plugins/url-rewrite.js';
import { getLogger } from '../../logger.js';
import type { SkillOpenApiSource } from '../../skills/frontmatter-schema.js';

const execFileAsync = promisify(execFile);
const logger = getLogger().child({ component: 'openapi-spec-fetcher' });

const HEAD_REF = 'refs/heads/main';

export interface MakeDefaultFetchOpenApiSpecInput {
  /** Resolve the bare-repo path for an agent. The closure's `skillName`
   *  argument addresses a path within that repo (`.ax/skills/<skill>/...`).
   *  Matches the signature of `GetAgentSkillsDeps.getBareRepoPath`. */
  getBareRepoPath(agentId?: string): string | Promise<string>;
  /** Optional `config.url_rewrites` map. Same hook `mcp-client-factory`
   *  uses for e2e mock-server redirection. Production default is
   *  undefined → no-op. */
  urlRewrites?: UrlRewriteMap;
}

/** A parsed spec must be OpenAPI v3.x.x. Anything else is rejected with a
 *  descriptive error so skill authors can diagnose from logs alone. */
function assertOpenApiV3(parsed: unknown, context: string): asserts parsed is OpenAPIV3.Document {
  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`OpenAPI spec is not an object (${context})`);
  }
  const version = (parsed as { openapi?: unknown; swagger?: unknown });
  if (typeof version.swagger === 'string') {
    throw new Error(
      `OpenAPI v2 (Swagger ${version.swagger}) not supported — convert to v3 or provide a v3 spec (${context})`,
    );
  }
  if (typeof version.openapi !== 'string' || !version.openapi.startsWith('3.')) {
    throw new Error(
      `Expected OpenAPI 3.x spec, got openapi=${JSON.stringify(version.openapi)} (${context})`,
    );
  }
}

/** JSON or YAML content → parsed JS object. JSON is a strict subset of
 *  YAML 1.2, so JSON-parse first (cheaper, strict), then fall through to
 *  YAML on failure. A first-character branch doesn't work because YAML's
 *  flow syntax also starts with `{`/`[` (e.g. `{openapi: "3.0.3", ...}`
 *  is valid YAML but invalid JSON — unquoted keys). If BOTH parsers fail,
 *  we compose the errors so the skill author can see whichever is closer
 *  to their intent. */
function parseSpecContent(content: string, sourceLabel: string): unknown {
  try {
    return JSON.parse(content);
  } catch (jsonErr) {
    try {
      return parseYaml(content);
    } catch (yamlErr) {
      throw new Error(
        `Failed to parse spec at ${sourceLabel} as either JSON or YAML. ` +
          `JSON error: ${(jsonErr as Error).message}. ` +
          `YAML error: ${(yamlErr as Error).message}.`,
      );
    }
  }
}

/** True for `https://…` or `http://…` URLs. Workspace-relative paths
 *  (`./x.yaml`, `specs/x.json`, `x.yaml`) return false. */
function isHttpUrl(spec: string): boolean {
  return /^https?:\/\//i.test(spec);
}

/** Validate a workspace-relative spec path. Returns the normalized path
 *  suitable for `git show <ref>:.ax/skills/<skill>/<normalized>`. Throws
 *  on absolute paths and `..` traversal attempts.
 *
 *  Accepts `./openapi.yaml`, `openapi.yaml`, `specs/api.json`, etc.
 *  Rejects `/etc/passwd`, `../../secrets`, `specs/../../../etc/passwd`. */
function normalizeWorkspaceSpecPath(spec: string): string {
  if (spec.length === 0) {
    throw new Error('OpenAPI spec path is empty — set `openapi[].spec` in the skill frontmatter');
  }
  if (spec.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(spec)) {
    throw new Error(
      `OpenAPI spec path must be a workspace-relative path or https:// URL — absolute path rejected: ${JSON.stringify(spec)}`,
    );
  }
  // posix.normalize collapses `./a/../b` into `b`, but leaves `../x` as
  // `../x` (traversal). We reject any normalized path that starts with `..`.
  const normalized = posixPath.normalize(spec.replace(/\\/g, '/'));
  if (normalized === '..' || normalized.startsWith('../')) {
    throw new Error(
      `OpenAPI spec path traversal blocked — path escapes skill directory: ${JSON.stringify(spec)}`,
    );
  }
  // After normalize `./a` becomes `a`; keep the clean form.
  return normalized.replace(/^\.\//, '');
}

async function readSpecFromRepo(
  bareRepoPath: string,
  gitPath: string,
): Promise<string> {
  const { stdout } = await execFileAsync(
    'git',
    ['-C', bareRepoPath, 'show', `${HEAD_REF}:${gitPath}`],
    { encoding: 'buffer', maxBuffer: 16 * 1024 * 1024 },
  );
  return stdout.toString('utf-8');
}

export function makeDefaultFetchOpenApiSpec(
  input: MakeDefaultFetchOpenApiSpecInput,
): (skillName: string, source: SkillOpenApiSource) => Promise<OpenAPIV3.Document> {
  const { getBareRepoPath, urlRewrites } = input;

  return async (skillName, source) => {
    if (isHttpUrl(source.spec)) {
      // Apply url_rewrites (prod no-op, e2e harness uses it). SwaggerParser
      // will fetch + dereference the remote spec in one call.
      const dispatchUrl = applyUrlRewrite(source.spec, urlRewrites);
      logger.debug('openapi_fetch_http', { skillName, specUrl: dispatchUrl });
      const doc = (await SwaggerParser.dereference(dispatchUrl)) as unknown;
      assertOpenApiV3(doc, `url=${dispatchUrl}`);
      return doc;
    }

    // Workspace-relative: read from the bare repo via git-show.
    const normalized = normalizeWorkspaceSpecPath(source.spec);
    const bareRepoPath = await getBareRepoPath();
    const gitPath = `.ax/skills/${skillName}/${normalized}`;
    logger.debug('openapi_fetch_workspace', { skillName, gitPath });

    const content = await readSpecFromRepo(bareRepoPath, gitPath);
    const parsed = parseSpecContent(content, `skill=${skillName} path=${gitPath}`);
    assertOpenApiV3(parsed, `skill=${skillName} path=${gitPath}`);
    // Hand the already-parsed object to SwaggerParser; it walks + dereferences
    // internal $refs without hitting the network or the filesystem. External
    // $refs (e.g. `$ref: "./other.yaml"`) are not supported by this path —
    // skill authors should inline their component schemas.
    const dereferenced = (await SwaggerParser.dereference(parsed as unknown as OpenAPIV3.Document)) as unknown;
    assertOpenApiV3(dereferenced, `skill=${skillName} path=${gitPath}`);
    return dereferenced;
  };
}
