/**
 * IPC handler: `describe_tools` — return full schemas for a list of named tools.
 *
 * The host holds the source-of-truth `ToolCatalog` (built per-turn in
 * `processCompletion` and cached per (agentId, userId, HEAD-sha)). In
 * `indirect` dispatch mode the agent sees only the summaries; when it
 * needs full inputSchema detail before calling a tool, it asks via this
 * handler.
 *
 * Response shape: `{ tools: [{name, summary, schema}], unknown: [string] }`.
 *   - `tools` contains an entry for every name that resolved.
 *   - `unknown` contains every name that did not — always present so the
 *     agent doesn't have to key on presence of a field.
 *
 * Schema augmentation: enabled; paired with `applyJq` on the host side
 * (`call-tool.ts`). Every returned schema gets a `_select` property — an
 * optional jq filter the agent can use to keep responses small. The
 * projection runs host-side after dispatch; a bad selector returns a
 * structured `select_failed` rather than throwing. Augmentation is
 * non-destructive — the cached `CatalogTool.schema` is never mutated.
 *
 * Catalog access: the handler receives either a direct `CatalogReader`
 * (convenient for unit tests) or a `resolveCatalog(ctx)` lookup closure.
 * The real host wires the closure form, reading from per-turn state
 * populated by `processCompletion`. This is the same per-turn plumbing
 * story as `workspaceMap`, just shaped as a function rather than a
 * shared `Map` — the handler stays agnostic to how the host stores it.
 */

import type { CatalogTool } from '../../types/catalog.js';
import type { IPCContext } from '../ipc-server.js';

/** Read-only subset of `ToolCatalog` the handler actually needs. */
export interface CatalogReader {
  get(name: string): CatalogTool | undefined;
  /** Return every catalog tool in insertion order. Used by
   *  `describe_tools([])` to answer "what tools do I have?" in one round-trip. */
  list(): CatalogTool[];
}

export interface DescribeToolsDeps {
  /** Direct catalog — convenient for unit tests that build one inline. */
  catalog?: CatalogReader;
  /** Per-request catalog lookup — real server wires this closure. Returns
   *  `undefined` when no catalog has been registered for this context. */
  resolveCatalog?: (ctx: IPCContext) => CatalogReader | undefined;
}

export interface DescribeToolsRequest {
  names: string[];
}

export interface DescribeToolsResult {
  tools: Array<{ name: string; summary: string; schema: Record<string, unknown> }>;
  unknown: string[];
}

/**
 * Inject the `_select` jq projection knob into the returned schema.
 *
 * Non-destructive: we clone the top level and a shallow copy of
 * `properties`, then add `_select`. The caller's cached `CatalogTool.schema`
 * is never mutated — the same schema object is re-read on every turn that
 * hits the per-(agentId, userId, HEAD-sha) cache, so identity matters.
 *
 * The inner property schemas stay as-is — those are still the server's
 * contract and not ours to touch.
 */
function augmentSchemaWithSelect(schema: Record<string, unknown>): Record<string, unknown> {
  // Non-destructive clone of the top level. We only mutate `properties`,
  // not the inner schemas — those are still the server's contract.
  const props = { ...((schema.properties as Record<string, unknown>) ?? {}) };
  props._select = {
    type: 'string',
    description:
      'Optional jq filter applied to the response. Use this to keep your ' +
      'context window small — e.g. `.issues | length`, `.items[].id`. ' +
      'The filter runs on the host after dispatch; a bad filter returns a ' +
      'structured error, not a crash.',
  };
  return { ...schema, properties: props };
}

export function createDescribeToolsHandler(deps: DescribeToolsDeps) {
  if (!deps.catalog && !deps.resolveCatalog) {
    throw new Error('createDescribeToolsHandler: either `catalog` or `resolveCatalog` must be provided');
  }

  return async function describeTools(
    req: DescribeToolsRequest,
    ctx?: IPCContext,
  ): Promise<DescribeToolsResult> {
    const catalog =
      deps.catalog ??
      (ctx ? deps.resolveCatalog?.(ctx) : undefined);

    // Empty `names` = directory mode. Return every catalog tool's name +
    // summary with NO schema — the agent uses this to discover what it has
    // without paying for full schema bytes it doesn't need yet. Once it
    // picks the 1-3 tools that match the task, a second call with those
    // names fills in the schemas.
    if (req.names.length === 0) {
      const all = catalog?.list() ?? [];
      return {
        tools: all.map(t => ({ name: t.name, summary: t.summary, schema: {} })),
        unknown: [],
      };
    }

    const tools: DescribeToolsResult['tools'] = [];
    const unknown: string[] = [];

    for (const name of req.names) {
      const tool = catalog?.get(name);
      if (!tool) {
        unknown.push(name);
        continue;
      }
      tools.push({
        name: tool.name,
        summary: tool.summary,
        schema: augmentSchemaWithSelect(tool.schema),
      });
    }

    return { tools, unknown };
  };
}

/** Build a `CatalogReader` from a flat `CatalogTool[]` (cache output). */
export function catalogReaderFromTools(tools: CatalogTool[]): CatalogReader {
  const byName = new Map(tools.map(t => [t.name, t]));
  return {
    get: (name: string) => byName.get(name),
    list: () => [...tools],
  };
}
