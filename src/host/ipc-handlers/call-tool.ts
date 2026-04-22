/**
 * IPC handler: `call_tool` — dispatch a single tool by catalog lookup.
 *
 * The agent sends `{tool, args}`. The handler:
 *   1. Resolves the tool from the per-turn `CatalogReader` (same closure
 *      plumbing as `describe_tools`).
 *   2. Extracts the optional `_select` jq projection from args. The selector
 *      is kept off the dispatch payload; the cleaned args are forwarded to
 *      the server.
 *   3. Dispatches by `dispatch.kind`:
 *        - `mcp`     — routed to `mcpProvider.callToolOnServer`.
 *        - `openapi` — routed to `openApiProvider.dispatchOperation`
 *                      (Task 7.4). The dispatcher resolves creds, builds
 *                      the HTTP request (path substitution + query +
 *                      header + auth + body), and returns parsed JSON.
 *   4. On a successful result, if a selector was captured, runs
 *      `applyJq(result, selector)` and returns the projection. A bad
 *      selector yields `select_failed` — dispatch already succeeded, so
 *      this is a distinct failure mode from `dispatch_failed`.
 *   5. If the post-projection result's JSON form exceeds
 *      `spillThresholdBytes` (UTF-8), returns a truncated envelope
 *      `{truncated: true, full, preview}`. The agent-side stub writes
 *      `full` to a spill file and surfaces a stub to the LLM — the host
 *      stays filesystem-free (option A in the Task 4.3 plan).
 *   6. Returns `{result}` on success, `{error, kind}` on failure.
 *
 * Structured errors (never throw across the IPC boundary):
 *   - `unknown_tool` — name not in the current turn's catalog
 *   - `unsupported_dispatch` — dispatch.kind not recognized (forward-compat)
 *   - `dispatch_failed` — dispatcher threw / returned an error
 *   - `select_failed` — dispatch succeeded but the jq projection blew up
 *
 * Catalog access mirrors `describe-tools.ts` — either a direct
 * `CatalogReader` (unit-test form) or a `resolveCatalog(ctx)` closure (real
 * server wiring). Keeping the two handlers shape-identical lets the server
 * feed both from one per-turn registration.
 */

import type { CatalogTool } from '../../types/catalog.js';
import type { IPCContext } from '../ipc-server.js';
import type { CatalogReader } from './describe-tools.js';
import { applyJq } from '../tool-catalog/jq.js';
import { DEFAULT_TOOL_DISPATCH_SPILL_THRESHOLD_BYTES } from '../../config.js';
import { getLogger } from '../../logger.js';

const logger = getLogger().child({ component: 'call-tool' });

/**
 * Minimal MCP dispatcher surface the handler needs.
 *
 * We intentionally define a local type rather than reuse `McpProvider` —
 * `McpProvider.callTool` carries the legacy `{tool, arguments, agentId,
 * userId, sessionId}` shape from the pre-catalog era. The catalog already
 * knows the server, the handler already knows the args; a narrower
 * `{server, tool, args, ctx}` shape keeps the call site clean while still
 * threading the per-request identity needed for credential resolution.
 *
 * The `ctx` field is required (not optional) so downstream adapters
 * cannot silently fall back to a host-wide default user. `agentId` +
 * `userId` match the fields tool-batch threads at `tool-batch.ts:188`
 * — `userId` is the empty string when the IPC context didn't carry one,
 * matching tool-batch's `ctx.userId ?? ''` convention.
 *
 * Real-server wiring adapts from `mcpManager` + `callToolOnServer` (free
 * function in `src/plugins/mcp-client.ts`) + credential resolution. The
 * adapter lives in `server-init.ts` — this file stays dependency-free.
 */
export interface CallToolMcpDispatcher {
  callToolOnServer(call: {
    server: string;
    tool: string;
    /** The skill that owns this tool — threaded through the catalog
     *  entry's `skill` field. The adapter in `server-init.ts` filters
     *  skill-credential lookups by `(skillName, envName)` so two skills
     *  sharing a common envName cannot resolve to each other's rows
     *  (PR #185 review, issue #2). */
    skillName: string;
    args: Record<string, unknown>;
    ctx: { agentId: string; userId: string };
  }): Promise<unknown>;
}

/**
 * OpenAPI dispatcher surface the handler needs (Task 7.4).
 *
 * The handler has already:
 *   - Resolved the catalog tool (so `operationId`, `method`, `path`,
 *     `baseUrl`, and `params` are trusted + fully typed).
 *   - Stripped `_select` from `args`.
 *
 * The dispatcher's job: resolve credentials, substitute `{name}` path
 * tokens, route query/header params per `params[].in`, serialize `body`
 * as JSON when present, inject auth per `authScheme`, apply
 * `config.url_rewrites` to `baseUrl`, fire the HTTP request, and return
 * the parsed-JSON response body. Throws on transport errors or non-2xx
 * responses — the handler wraps into `{error, kind: 'dispatch_failed'}`.
 */
export interface CallToolOpenApiDispatcher {
  dispatchOperation(call: {
    baseUrl: string;
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
    /** Path template with `{name}` tokens preserved, e.g. `/pets/{id}`. */
    path: string;
    operationId: string;
    /** The skill that owns this operation — threaded from the catalog
     *  entry's `skill` field so the credential resolver can filter rows
     *  by `(skillName, envName)` instead of envName alone. Required —
     *  a silent cross-skill fallback is the exact bug this closes
     *  (PR #185 review, issue #2). */
    skillName: string;
    /** envName from skill frontmatter auth.credential, or undefined when
     *  no auth is configured. */
    credential?: string;
    authScheme?: 'bearer' | 'basic' | 'api_key_header' | 'api_key_query';
    /** Parameter locations preserved from the OpenAPI spec so the
     *  dispatcher can route each arg correctly. `body` is NEVER an entry
     *  here — it's handled separately via the reserved `args.body` key. */
    params: Array<{ name: string; in: 'path' | 'query' | 'header' }>;
    /** Combined params + optional `body` key, per the catalog tool's
     *  inputSchema. Same `_select`-stripped args the handler received. */
    args: Record<string, unknown>;
    ctx: { agentId: string; userId: string };
  }): Promise<unknown>;
}

export interface CallToolDeps {
  /** Direct catalog — unit-test form. */
  catalog?: CatalogReader;
  /** Per-request catalog lookup — real server wires this closure. */
  resolveCatalog?: (ctx: IPCContext) => CatalogReader | undefined;
  /** MCP dispatcher. Required — every catalog tool at this stage is MCP. */
  mcpProvider: CallToolMcpDispatcher;
  /** OpenAPI dispatcher. Required — parallels `mcpProvider` so a host
   *  with any openapi-source skill has a concrete dispatcher wired in.
   *  Compile-time safety over a runtime "unsupported_dispatch" fallback,
   *  same tightening we did for `fetchOpenApiSpec` in 7.3. */
  openApiProvider: CallToolOpenApiDispatcher;
  /**
   * Auto-spill threshold in UTF-8 bytes. When the stringified
   * post-projection result exceeds this, the handler returns a
   * `{truncated, full, preview}` envelope instead of `{result}`; the
   * agent-side stub writes `full` to a spill file and surfaces a stub
   * to the LLM. Default `DEFAULT_TOOL_DISPATCH_SPILL_THRESHOLD_BYTES`
   * (20 KiB) — keep the default path working for unit tests that
   * don't construct a full Config.
   */
  spillThresholdBytes?: number;
}

export interface CallToolRequest {
  tool: string;
  args: Record<string, unknown>;
}

export type CallToolErrorKind =
  | 'unknown_tool'
  | 'unsupported_dispatch'
  | 'dispatch_failed'
  | 'select_failed';

/**
 * Envelope returned when the result exceeds `spillThresholdBytes` after
 * projection. The agent-side stub is responsible for writing `full` to a
 * spill file (`/tmp/tool-<id>.json`) and handing the LLM a stub that
 * points at it. We keep the host filesystem-free — it just hands the
 * payload back with a flag and a short preview. Option A in the
 * tool-dispatch-unification plan (Task 4.3).
 */
export interface CallToolTruncatedEnvelope {
  truncated: true;
  full: unknown;
  preview: string;
}

export type CallToolResult =
  | { result: unknown }
  | CallToolTruncatedEnvelope
  | { error: string; kind: CallToolErrorKind };

/** Preview length for the truncated envelope (chars of JSON). */
const TRUNCATED_PREVIEW_CHARS = 500;

/**
 * Decide whether the stringified form of `result` exceeds `threshold`
 * bytes (UTF-8) AND return the serialized form for reuse by
 * `buildPreview`. Stringifying JSON twice on a 30 KB payload is
 * measurable — do it once.
 *
 * `serialized === undefined` means JSON.stringify threw (circular refs,
 * BigInt, etc). We can't spill what we can't serialize; let the IPC
 * layer surface the real error when it tries to send the envelope.
 */
function measureSerialized(
  result: unknown,
  threshold: number,
): { exceeds: boolean; serialized: string | undefined } {
  try {
    const serialized = JSON.stringify(result);
    return {
      exceeds: Buffer.byteLength(serialized, 'utf8') > threshold,
      serialized,
    };
  } catch {
    return { exceeds: false, serialized: undefined };
  }
}

/**
 * Build a short preview from the already-stringified result. The LLM
 * gets a plain-text cue in the stub so it can judge whether to `cat` the
 * spill file or re-query with a sharper `_select`.
 */
function buildPreview(serialized: string): string {
  if (serialized.length <= TRUNCATED_PREVIEW_CHARS) return serialized;
  return (
    serialized.slice(0, TRUNCATED_PREVIEW_CHARS) +
    '... [truncated; full response at /tmp/tool-<id>.json]'
  );
}

/**
 * Extract the optional jq projection knob from args.
 *
 * `_select` is our reserved projection field, advertised on every
 * describe_tools schema. The field is off-limits for tool authors — we
 * always strip it from the dispatch payload so servers never see it.
 *
 * Returns the cleaned args plus the captured selector. The selector is
 * `undefined` when `_select` was absent, wasn't a string, or was the
 * empty string — those are treated as "no projection requested" rather
 * than errors. A well-behaved LLM following the schema shouldn't send
 * those shapes, but we don't want to turn a mildly-confused model into a
 * hard failure.
 */
function extractSelect(
  args: Record<string, unknown>,
): { cleanedArgs: Record<string, unknown>; selector: string | undefined } {
  if (!('_select' in args)) {
    return { cleanedArgs: args, selector: undefined };
  }
  const { _select: raw, ...rest } = args;
  const selector = typeof raw === 'string' && raw.length > 0 ? raw : undefined;
  return { cleanedArgs: rest, selector };
}

/** Coerce any thrown value into a human-readable error string without losing info. */
function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

/** Pick the top-N closest names from `candidates` to `target` by a
 *  shared-meaningful-token heuristic. Good enough to catch the usual agent
 *  guesses (`mcp_linear_get_team` when catalog has `mcp_linear_list_teams`)
 *  without pulling in an edit-distance lib.
 *
 *  Universal tokens like `mcp` are stripped before scoring so cross-skill
 *  candidates (e.g. `mcp_github_list_repos`) don't surface just because
 *  they share the catalog prefix. Returns up to `limit` names, most
 *  relevant first. */
export function pickClosestNames(target: string, candidates: string[], limit = 3): string[] {
  if (candidates.length === 0) return [];
  const STOP_TOKENS = new Set(['mcp']);
  const tokenize = (s: string): string[] =>
    s.toLowerCase().split(/[_-]/).filter((t) => t.length > 0 && !STOP_TOKENS.has(t));
  const targetTokens = new Set(tokenize(target));
  if (targetTokens.size === 0) return [];
  const scored = candidates.map((name) => {
    const nameTokens = tokenize(name);
    let shared = 0;
    for (const t of nameTokens) if (targetTokens.has(t)) shared++;
    // Favor same-skill namespaces — an agent looking up
    // `mcp_linear_get_team` should see `mcp_linear_*` entries first.
    const [targetPrefix1, targetPrefix2] = target.split('_', 2);
    const [namePrefix1, namePrefix2] = name.split('_', 2);
    const prefixBonus =
      targetPrefix1 === namePrefix1 && targetPrefix2 === namePrefix2 ? 2 : 0;
    return { name, score: shared + prefixBonus };
  });
  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((s) => s.name);
}

/**
 * Unwrap a raw MCP tool result into an object/array/primitive.
 *
 * MCP's wire format delivers tool results as text content blocks. Structured
 * servers (Linear, GitHub, most modern MCP endpoints) JSON-encode the payload
 * inside a single text block — e.g. `{"issues":[...]}`. The agent's
 * `ax.callTool` caller expects real JS values: `.find()` over arrays, jq
 * `_select` iteration over objects, `.name` dereferences. Passing the raw
 * string through is what caused the "teams.find is not a function" +
 * "jq: Cannot iterate over string" thrash we saw with Linear.
 *
 * Contract:
 *   - `result` is what `callToolOnServer` returns as `.content` — a string
 *     joined from MCP text blocks, or a non-string value in the rare case a
 *     server returned structured content blocks directly.
 *   - If it's a string that parses as JSON → return the parsed value.
 *   - If it's a non-JSON string (plain-text status messages, single-line
 *     replies) → return the string unchanged. Agent sees what the server
 *     sent.
 *   - If it's already a non-string → return as-is.
 *
 * Exported so the real-server dispatcher adapter in `server-init.ts` +
 * unit tests share one implementation; the handler itself stays
 * dispatcher-agnostic.
 */
export function parseMcpTextResult(content: unknown): unknown {
  if (typeof content !== 'string') return content;
  try {
    return JSON.parse(content);
  } catch {
    return content;
  }
}

export function createCallToolHandler(deps: CallToolDeps) {
  if (!deps.catalog && !deps.resolveCatalog) {
    throw new Error(
      'createCallToolHandler: either `catalog` or `resolveCatalog` must be provided',
    );
  }
  if (!deps.mcpProvider) {
    throw new Error('createCallToolHandler: `mcpProvider` is required');
  }
  if (!deps.openApiProvider) {
    throw new Error('createCallToolHandler: `openApiProvider` is required');
  }

  const spillThresholdBytes =
    deps.spillThresholdBytes ?? DEFAULT_TOOL_DISPATCH_SPILL_THRESHOLD_BYTES;

  /**
   * Wrap `finalResult` in either `{result}` or a truncated envelope based
   * on size. Used at both the projection-success and no-projection exit
   * points so a projection that shrinks a huge payload below threshold
   * flows through unspilled — matches Task 4.3 spec ("projection that
   * SHRINKS a large response below threshold does NOT trigger
   * truncation").
   */
  function envelope(finalResult: unknown): CallToolResult {
    const { exceeds, serialized } = measureSerialized(
      finalResult,
      spillThresholdBytes,
    );
    if (!exceeds || serialized === undefined) {
      return { result: finalResult };
    }
    logger.debug('call_tool_truncated', {
      thresholdBytes: spillThresholdBytes,
    });
    return {
      truncated: true,
      full: finalResult,
      preview: buildPreview(serialized),
    };
  }

  return async function callTool(
    req: CallToolRequest,
    ctx?: IPCContext,
  ): Promise<CallToolResult> {
    const catalog: CatalogReader | undefined =
      deps.catalog ?? (ctx ? deps.resolveCatalog?.(ctx) : undefined);

    const tool: CatalogTool | undefined = catalog?.get(req.tool);
    if (!tool) {
      // Give the agent a concrete next step instead of a dead-end error.
      // Most "unknown tool" hits are name-guessing — the catalog has
      // `mcp_linear_list_teams` but the agent wrote `mcp_linear_get_team`.
      // Listing the full directory + the closest name matches lets a
      // single failed call pivot to the right one without another round-trip.
      const available = catalog?.list() ?? [];
      const suggestions = pickClosestNames(req.tool, available.map((t) => t.name));
      const hint =
        available.length === 0
          ? ' (catalog is empty — no tools are available this turn)'
          : suggestions.length > 0
            ? ` Did you mean: ${suggestions.join(', ')}? Call ax.describeTool([]) for the full directory.`
            : ` Call ax.describeTool([]) to list every available tool before calling again.`;
      return { error: `unknown tool: ${req.tool}.${hint}`, kind: 'unknown_tool' };
    }

    const { cleanedArgs, selector } = extractSelect(req.args ?? {});

    /**
     * Shared post-dispatch projection + envelope. Both MCP and OpenAPI
     * flow through this so `_select` + auto-spill behave identically
     * regardless of dispatch kind. The selector is the turn-time value
     * captured above.
     */
    async function projectAndEnvelope(result: unknown): Promise<CallToolResult> {
      if (selector !== undefined) {
        try {
          const projected = await applyJq(result, selector);
          return envelope(projected);
        } catch (err) {
          const msg = errorMessage(err);
          logger.debug('call_tool_select_failed', {
            tool: req.tool,
            selector,
            error: msg,
          });
          return {
            error: `_select projection failed: ${msg}`,
            kind: 'select_failed',
          };
        }
      }
      return envelope(result);
    }

    if (tool.dispatch.kind === 'mcp') {
      let result: unknown;
      try {
        // Thread per-request identity through so the adapter resolves
        // skill credentials against the caller's user, not a host-wide
        // default. `userId` falls back to '' for IPC contexts that
        // don't carry one — matches tool-batch's `ctx.userId ?? ''`.
        // `skillName` comes from the catalog entry so the adapter can
        // filter credential rows by `(skillName, envName)` — without
        // it, skill-A's API_KEY row could resolve skill-B's request.
        result = await deps.mcpProvider.callToolOnServer({
          server: tool.dispatch.server,
          tool: tool.dispatch.toolName,
          skillName: tool.skill,
          args: cleanedArgs,
          ctx: {
            agentId: ctx?.agentId ?? '',
            userId: ctx?.userId ?? '',
          },
        });
      } catch (err) {
        const msg = errorMessage(err);
        logger.debug('call_tool_dispatch_failed', {
          tool: req.tool,
          kind: 'mcp',
          server: tool.dispatch.server,
          error: msg,
        });
        return { error: msg, kind: 'dispatch_failed' };
      }

      return projectAndEnvelope(result);
    }

    if (tool.dispatch.kind === 'openapi') {
      let result: unknown;
      try {
        result = await deps.openApiProvider.dispatchOperation({
          baseUrl: tool.dispatch.baseUrl,
          method: tool.dispatch.method,
          path: tool.dispatch.path,
          operationId: tool.dispatch.operationId,
          // Thread skillName from the catalog entry so the credential
          // resolver filters by `(skillName, envName)` — see the
          // matching wiring in `CallToolMcpDispatcher` above for the
          // rationale.
          skillName: tool.skill,
          credential: tool.dispatch.credential,
          authScheme: tool.dispatch.authScheme,
          params: tool.dispatch.params,
          args: cleanedArgs,
          ctx: {
            agentId: ctx?.agentId ?? '',
            userId: ctx?.userId ?? '',
          },
        });
      } catch (err) {
        const msg = errorMessage(err);
        logger.debug('call_tool_dispatch_failed', {
          tool: req.tool,
          kind: 'openapi',
          operationId: tool.dispatch.operationId,
          error: msg,
        });
        return { error: msg, kind: 'dispatch_failed' };
      }

      return projectAndEnvelope(result);
    }

    // Forward-compat safety net — an unrecognized discriminated union kind
    // is a compile-time error; this branch only triggers if a new dispatch
    // kind slips into runtime data without a matching handler.
    return {
      error: `unsupported dispatch kind for tool ${req.tool}: ${(tool.dispatch as { kind: string }).kind}`,
      kind: 'unsupported_dispatch',
    };
  };
}
