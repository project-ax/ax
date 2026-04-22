/**
 * Live-probe each declared MCP server by attempting `listTools` with the
 * caller-supplied URL + transport + Authorization header. Used by the admin
 * Test-&-Enable flow to verify a skill's frontmatter before persisting the
 * approval.
 *
 * Same transport path (`connectAndListTools`) and same URL-rewrite step
 * (`applyUrlRewrite`) as `populateCatalogFromSkills` — if the probe returns
 * `ok: true` here, the turn-time catalog build with the same inputs will
 * succeed. If it returns `ok: false`, the error string comes straight from
 * the MCP client and reliably distinguishes connect/transport/auth failures
 * (404/405 vs 401 vs SDK protocol error).
 *
 * Per-server isolation: one flaky server yields `{ok:false,...}` for that
 * entry only. The caller decides how strict to be — admin Test-&-Enable
 * refuses to persist if ANY entry failed.
 */

import { connectAndListTools } from '../../plugins/mcp-client.js';
import { applyUrlRewrite, type UrlRewriteMap } from '../../plugins/url-rewrite.js';
import type { McpTransport } from '../../plugins/mcp-client.js';

export interface ProbeMcpServerInput {
  /** Server name from frontmatter — only used to key results. */
  name: string;
  url: string;
  transport: McpTransport;
  /** Request headers — typically `{Authorization: "Bearer <token>"}` resolved
   *  from the admin's typed credentials or existing skill_credentials rows.
   *  Absent = unauthenticated probe; most vendors return 401 immediately. */
  headers?: Record<string, string>;
}

export type ProbeMcpServerResult =
  | { name: string; ok: true; toolCount: number }
  | { name: string; ok: false; error: string };

export interface ProbeMcpServersOptions {
  /** `config.url_rewrites` — e2e mock harness. No-op in production. */
  urlRewrites?: UrlRewriteMap;
}

/** Probe one MCP server. Catches every error path so the caller can tally
 *  pass/fail without try/catch at each call site. */
export async function probeMcpServer(
  server: ProbeMcpServerInput,
  opts: ProbeMcpServersOptions = {},
): Promise<ProbeMcpServerResult> {
  try {
    const dispatchUrl = applyUrlRewrite(server.url, opts.urlRewrites);
    const tools = await connectAndListTools(dispatchUrl, {
      ...(server.headers ? { headers: server.headers } : {}),
      transport: server.transport,
    });
    return { name: server.name, ok: true, toolCount: tools.length };
  } catch (err) {
    return { name: server.name, ok: false, error: (err as Error).message };
  }
}

/** Probe every server in parallel. Order of results matches input order. */
export async function probeMcpServers(
  servers: ProbeMcpServerInput[],
  opts: ProbeMcpServersOptions = {},
): Promise<ProbeMcpServerResult[]> {
  return Promise.all(servers.map(s => probeMcpServer(s, opts)));
}
