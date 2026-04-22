/**
 * Default OpenAPI dispatcher for the `call_tool` handler (Task 7.4 of the
 * tool-dispatch-unification plan).
 *
 * Parallel to `callToolMcpDispatcher` in `server-init.ts`: the `call-tool.ts`
 * handler stays dispatcher-agnostic and receives the concrete implementation
 * at wire-up time. This file builds the implementation once, closing over
 * the skill-credential store + optional `config.url_rewrites` map.
 *
 * What this dispatcher does on each call:
 *   1. Apply `urlRewrites` to `baseUrl` (no-op in production — only e2e
 *      sets the map to redirect `https://mock-target.test` → the mock
 *      server's dynamic port). Same posture as the MCP dispatcher.
 *   2. Substitute `{name}` path tokens from `args`. URL-encodes values.
 *      Missing required path params throw with a clear message.
 *   3. Build the query string from `params[in='query']` entries that are
 *      present in `args`. Primitives become `k=v`; arrays become repeated
 *      `k=v1&k=v2`. Everything is URL-encoded.
 *   4. Set request headers from `params[in='header']` entries.
 *   5. Inject auth based on `authScheme`:
 *        - `bearer`         → `Authorization: Bearer <value>`
 *        - `basic`          → `Authorization: Basic <value>` (caller-owned
 *          base64; we document the expectation in the skill-auth design)
 *        - `api_key_header` → `X-API-Key: <value>` (hardcoded name in v1)
 *        - `api_key_query`  → `?api_key=<value>` (hardcoded key in v1)
 *      `credential` + `authScheme` must both be set or both unset —
 *      mismatch throws `invalid_auth_config`.
 *   6. Serialize `args.body` as JSON with `Content-Type: application/json`
 *      when present. Method-defaulted behavior matches what the LLM gave
 *      us — we don't add or strip bodies beyond that.
 *   7. Dispatch via `fetch` (Node's native). Return parsed-JSON body on
 *      2xx; return the raw text string if the body isn't JSON (same
 *      posture as `parseMcpTextResult` — keep the caller's data shape).
 *      Non-2xx throws with status + truncated body so the handler wraps
 *      it into `{error, kind: 'dispatch_failed'}`.
 *
 * Logging: success + failure fire structured events via the shared logger.
 * NEVER log request body or headers — credential material lands there.
 */

import type { CallToolOpenApiDispatcher } from './call-tool.js';
import type { SkillCredStore } from '../skills/skill-cred-store.js';
import { resolveCredentialValueByEnvName } from '../skills/skill-cred-resolver.js';
import { applyUrlRewrite, type UrlRewriteMap } from '../../plugins/url-rewrite.js';
import { getLogger } from '../../logger.js';

const logger = getLogger().child({ component: 'openapi-dispatcher' });

/** Upper bound on how much of a non-2xx response body we inline into the
 *  thrown error message. Keeps logs + IPC payloads bounded when a server
 *  returns a huge HTML error page. */
const ERROR_BODY_MAX_CHARS = 500;

/**
 * Query-parameter keys we treat as credential-carrying and redact before
 * logging the URL. `api_key` is the only name the dispatcher currently
 * emits (hardcoded in the `api_key_query` auth branch below). If a
 * follow-up task ever makes the query-param name configurable (see the
 * module docblock's "v1 limitations"), this allowlist MUST be extended
 * in lockstep — otherwise the redaction will silently miss the new name
 * and credentials will leak back into failure logs. Lowercase comparison
 * keeps case-insensitive matching cheap.
 */
const CREDENTIAL_QUERY_KEYS = new Set(['api_key']);

/**
 * Return a log-safe version of `rawUrl` where any query parameter whose
 * key matches `CREDENTIAL_QUERY_KEYS` has its value replaced with `***`.
 * The actual URL used for `fetch` is untouched — this helper exists
 * purely so failure-log payloads never carry credential material.
 *
 * On any URL parse failure the input is returned unchanged. A malformed
 * URL shouldn't crash the logger; better to record the weird string than
 * to throw from a warn() call site and mask the underlying dispatch
 * failure.
 *
 * Exported so it can be unit-tested in isolation and reused by any
 * future call site that needs to log a URL that might carry creds.
 */
export function redactCredentialsFromUrl(rawUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return rawUrl;
  }
  if (!parsed.search) return rawUrl;
  let mutated = false;
  for (const key of Array.from(parsed.searchParams.keys())) {
    if (CREDENTIAL_QUERY_KEYS.has(key.toLowerCase())) {
      // `URLSearchParams.set` replaces all values for the key with one —
      // that's the desired behavior here (no duplicate-leak channel).
      parsed.searchParams.set(key, '***');
      mutated = true;
    }
  }
  return mutated ? parsed.toString() : rawUrl;
}

export interface MakeDefaultOpenApiDispatcherDeps {
  /** Skill credential store for resolving credential envName → value. */
  skillCredStore: SkillCredStore;
  /** `config.url_rewrites` — applied to `baseUrl` before dispatch. No-op
   *  in production (undefined). E2e sets it to redirect frontmatter URLs
   *  to mock servers on dynamic ports. */
  urlRewrites?: UrlRewriteMap | Map<string, string>;
  /** Optional fetch override for tests. Defaults to the global fetch. */
  fetchImpl?: typeof fetch;
}

function truncateBody(body: string): string {
  if (body.length <= ERROR_BODY_MAX_CHARS) return body;
  return body.slice(0, ERROR_BODY_MAX_CHARS) + '... [truncated]';
}

/** URL-encode a primitive-like value for path embedding. Objects are
 *  JSON-stringified so nested params don't silently lose data. */
function encodePrimitive(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
    return encodeURIComponent(String(v));
  }
  return encodeURIComponent(JSON.stringify(v));
}

/** Stringify a primitive-like value for `URLSearchParams.append(name, value)`.
 *  Skips the manual `encodeURIComponent` dance — `URLSearchParams` handles
 *  percent-encoding on its own. Objects are JSON-stringified so nested
 *  values don't silently lose data (matches `encodePrimitive` posture). */
function stringifyForSearchParams(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
    return String(v);
  }
  return JSON.stringify(v);
}

/**
 * Reject header names containing anything other than printable-ASCII
 * non-whitespace characters. Per RFC 7230 a field name is a token
 * (`/[!#$%&'*+.^_`|~0-9A-Za-z-]+/`); we use a looser printable-ASCII
 * check that still rules out whitespace, control chars, and high-bit
 * bytes. Names come from the adapter's `dispatch.params` (which came
 * from the OpenAPI spec) so in practice this never trips — the check
 * is defense-in-depth against a malformed spec or adapter bug.
 */
function isInvalidHeaderName(name: string): boolean {
  // Printable ASCII ranges 0x21–0x7E, no whitespace. `[^\x21-\x7E]` also
  // catches 0x20 (space), 0x7F (DEL), and all control chars.
  // eslint-disable-next-line no-control-regex
  return /[^\x21-\x7E]/.test(name);
}

/**
 * Reject header values containing CR, LF, null, or other C0 control
 * characters. Node's undici already rejects CRLF with a cryptic
 * "Invalid header value" — we validate first so the error flowing
 * through the handler's dispatch_failed envelope names the offending
 * header. Also hardens any future custom `fetchImpl` against CRLF
 * injection from LLM-controlled header values.
 */
function isInvalidHeaderValue(value: string): boolean {
  // C0 control range (0x00–0x1F) + DEL (0x7F). Tab (0x09) is technically
  // allowed in field values per RFC, but it's cheap to reject and no
  // known sensible use case for us emits one.
  // eslint-disable-next-line no-control-regex
  return /[\x00-\x1F\x7F]/.test(value);
}

export function makeDefaultOpenApiDispatcher(
  deps: MakeDefaultOpenApiDispatcherDeps,
): CallToolOpenApiDispatcher {
  const fetchImpl = deps.fetchImpl ?? fetch;

  return {
    async dispatchOperation(call): Promise<unknown> {
      const {
        baseUrl,
        method,
        path,
        operationId,
        skillName,
        credential,
        authScheme,
        ctx,
      } = call;

      // Clone args into a mutable working copy so we can peel off path
      // params (they must NOT leak into query/body) without mutating the
      // caller's object.
      const workingArgs: Record<string, unknown> = { ...call.args };

      // ── 1. Auth config sanity: both-or-neither ────────────────────────
      if ((credential === undefined) !== (authScheme === undefined)) {
        throw new Error(
          'invalid_auth_config: credential and authScheme must both be set or both unset',
        );
      }

      // ── 2. Substitute path template tokens ────────────────────────────
      // Build a Set of param names declared as `in: 'path'` so we only
      // peel those off the working args — a path-shaped token `{foo}` that
      // isn't declared stays as-is (the spec is the source of truth for
      // what's a path param vs a literal brace).
      //
      // Two-pass design: first collect the unique set of path-token names
      // referenced in the template, then perform a single global
      // substitution per name. A regex-replacer that peels args inside
      // the callback would throw "Missing required path parameter" on the
      // SECOND occurrence of a repeated token (e.g. `/a/{id}/b/{id}`)
      // because the `delete workingArgs[name]` after the first match left
      // nothing for the replacer to find the second time. Deleting AFTER
      // the full pass also means `workingArgs` retains every consumed
      // path name's key only for the duration of the pass.
      const pathParamNames = new Set(
        call.params.filter((p) => p.in === 'path').map((p) => p.name),
      );
      const headerParams = call.params.filter((p) => p.in === 'header');
      const queryParams = call.params.filter((p) => p.in === 'query');

      // Pass 1: collect the set of unique token names that actually
      // appear in the path AND are declared as path params.
      const tokenPattern = /\{([^}]+)\}/g;
      const referencedPathNames = new Set<string>();
      for (const match of path.matchAll(tokenPattern)) {
        const tokenName = match[1];
        if (pathParamNames.has(tokenName)) {
          referencedPathNames.add(tokenName);
        }
      }

      // Pass 2: validate + substitute every occurrence of each unique
      // name in one go. `replaceAll` with a literal is safe here because
      // `{` and `}` aren't regex meta-chars when passed as a string and
      // the token names are already bounded by the regex match above.
      let substitutedPath = path;
      for (const name of referencedPathNames) {
        if (!(name in workingArgs)) {
          throw new Error(`Missing required path parameter: ${name}`);
        }
        const raw = workingArgs[name];
        if (raw === null || raw === undefined) {
          throw new Error(`Missing required path parameter: ${name}`);
        }
        substitutedPath = substitutedPath.replaceAll(`{${name}}`, encodePrimitive(raw));
      }
      // Peel the consumed names AFTER the full pass so a repeated-token
      // path doesn't lose the arg mid-replace.
      for (const name of referencedPathNames) {
        delete workingArgs[name];
      }

      // ── 3. Build the rewritten URL (baseUrl + path) ───────────────────
      // Parse `baseUrl` first so any baked-in query (`?foo=1`) or
      // fragment is preserved separately from the pathname. A naive
      // string concat of `baseUrl + substitutedPath` would splice the
      // operation path INTO the query when baseUrl ends with `?k=v`
      // (we'd get `/v1/?foo=1/pets` instead of `/v1/pets?foo=1`).
      //
      // Algorithm:
      //   - Start from baseUrl's origin + pathname (drop trailing `/`).
      //   - Append the substituted operation path verbatim.
      //   - Re-parse, then copy baseUrl's original searchParams onto the
      //     new URL so they survive as the initial query set.
      //   - Step 4 below uses `URLSearchParams.append` on top of that.
      //
      // `applyUrlRewrite` runs BEFORE the second parse so hostname
      // rules hit the rewritten origin, not the frontmatter one.
      const baseParsed = new URL(baseUrl);
      const basePathname = baseParsed.pathname.replace(/\/+$/, '');
      const composedUrl = `${baseParsed.origin}${basePathname}${substitutedPath}`;
      const rewrittenUrl = applyUrlRewrite(composedUrl, deps.urlRewrites);
      const url = new URL(rewrittenUrl);
      // Carry over any baked-in query params from the original baseUrl —
      // `applyUrlRewrite` only touches the origin, but we stripped the
      // query off before concatenation to avoid the splice bug above.
      for (const [k, v] of baseParsed.searchParams) {
        url.searchParams.append(k, v);
      }

      // ── 4. Query params ──────────────────────────────────────────────
      // Use `URLSearchParams.append` on the parsed URL rather than
      // string-pieceing `?k=v&k2=v2` and reassigning `url.search`. The
      // string-piece path blew up on a `baseUrl` that ended with `?foo=1`
      // (trailing concatenation) or carried a fragment — `URLSearchParams`
      // handles both cleanly. Any query params baked into baseUrl are
      // already on `url.searchParams` from the `new URL(...)` parse.
      for (const p of queryParams) {
        if (!(p.name in workingArgs)) continue;
        const value = workingArgs[p.name];
        if (value === undefined) continue;
        if (Array.isArray(value)) {
          for (const item of value) {
            url.searchParams.append(p.name, stringifyForSearchParams(item));
          }
        } else {
          url.searchParams.append(p.name, stringifyForSearchParams(value));
        }
        delete workingArgs[p.name];
      }

      // ── 5. Headers ───────────────────────────────────────────────────
      // Validate names + values for CRLF / control characters before
      // passing to fetch. Defense-in-depth: Node's undici rejects CRLF
      // in headers, but the error is cryptic ("Invalid header value").
      // Doing the check here names the offending header in the error
      // and hardens any future custom `fetchImpl` against CRLF injection.
      const headers: Record<string, string> = {};
      for (const p of headerParams) {
        if (!(p.name in workingArgs)) continue;
        const value = workingArgs[p.name];
        if (value === undefined) continue;
        if (isInvalidHeaderName(p.name)) {
          throw new Error(
            `Invalid header name ${JSON.stringify(p.name)}: contains control or non-ASCII characters`,
          );
        }
        const stringValue = String(value);
        if (isInvalidHeaderValue(stringValue)) {
          throw new Error(
            `Invalid header value for ${p.name}: contains control characters`,
          );
        }
        headers[p.name] = stringValue;
        delete workingArgs[p.name];
      }

      // ── 6. Auth injection ────────────────────────────────────────────
      if (credential && authScheme) {
        const value = await resolveCredentialValueByEnvName({
          skillName,
          envName: credential,
          agentId: ctx.agentId,
          userId: ctx.userId,
          skillCredStore: deps.skillCredStore,
        });
        if (!value) {
          throw new Error(
            `Missing credential: no value found for envName ${credential}`,
          );
        }
        switch (authScheme) {
          case 'bearer':
            headers['Authorization'] = `Bearer ${value}`;
            break;
          case 'basic':
            // Per design: callers pre-encode `user:pass` as base64 before
            // storing. We forward as-is.
            headers['Authorization'] = `Basic ${value}`;
            break;
          case 'api_key_header':
            // v1 limitation: the header name is hardcoded to `X-API-Key`.
            // A later task can lift this into the frontmatter auth block.
            headers['X-API-Key'] = value;
            break;
          case 'api_key_query':
            // v1 limitation: the query-param name is hardcoded to `api_key`
            // — see `CREDENTIAL_QUERY_KEYS` above; extending one requires
            // extending the other in lockstep so the failure-log redaction
            // stays in sync.
            url.searchParams.append('api_key', value);
            break;
        }
      }

      // ── 7. Body ──────────────────────────────────────────────────────
      let body: string | undefined;
      if ('body' in workingArgs && workingArgs.body !== undefined) {
        try {
          body = JSON.stringify(workingArgs.body);
        } catch (err) {
          throw new Error(
            `Failed to serialize request body to JSON: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        headers['Content-Type'] = 'application/json';
        delete workingArgs.body;
      }

      // ── 8. Dispatch ──────────────────────────────────────────────────
      const started = Date.now();
      const finalUrl = url.toString();
      let response: Response;
      try {
        response = await fetchImpl(finalUrl, {
          method,
          headers,
          ...(body !== undefined ? { body } : {}),
        });
      } catch (err) {
        const durationMs = Date.now() - started;
        logger.warn('openapi_dispatch_failed', {
          operationId,
          method,
          // `api_key_query` auth puts the credential in the URL query
          // string. Redact before logging so transport/network failures
          // (which are the most likely cause of loud log volume) don't
          // spill credentials into structured logs.
          url: redactCredentialsFromUrl(finalUrl),
          durationMs,
          error: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }
      const durationMs = Date.now() - started;

      // ── 9. Response handling ─────────────────────────────────────────
      const text = await response.text();
      if (!response.ok) {
        logger.warn('openapi_dispatch_failed', {
          operationId,
          method,
          // Same redaction as the fetch-error branch above — a 4xx/5xx
          // response with `api_key_query` auth MUST NOT leak the
          // credential back through the log payload.
          url: redactCredentialsFromUrl(finalUrl),
          status: response.status,
          durationMs,
        });
        throw new Error(
          `OpenAPI call failed: ${response.status} ${response.statusText}: ${truncateBody(text)}`.trim(),
        );
      }

      logger.debug('openapi_dispatch_ok', {
        operationId,
        method,
        status: response.status,
        durationMs,
      });

      if (text.length === 0) return undefined;
      try {
        return JSON.parse(text);
      } catch {
        // Non-JSON 2xx — pass the raw string through. Mirrors
        // `parseMcpTextResult`'s "keep the caller's data shape" posture.
        return text;
      }
    },
  };
}
