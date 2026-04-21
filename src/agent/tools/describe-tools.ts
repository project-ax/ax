/**
 * Agent-side tool stubs for the tool-dispatch unification meta-tools.
 *
 * These are the primitive factory functions for `describe_tools` and
 * `call_tool` — thin IPC pass-throughs. The actual wiring into the pi-session
 * and claude-code runners happens through the shared TOOL_CATALOG (both
 * runners already iterate the catalog and map entries to their respective
 * tool shapes). These factories exist for:
 *
 *   1. Unit-test isolation — tests can verify IPC payload shape without
 *      spinning up an entire agent session.
 *   2. A hook point for Task 4.2 (projection) and 4.3 (auto-spill), where
 *      the agent-side logic needs to live somewhere more discoverable than
 *      deep inside the catalog dispatch layer.
 *
 * Task 4.3 (auto-spill) lives here: when the host returns a
 * `{truncated: true, full, preview}` envelope, we persist `full` as pretty
 * JSON to `/tmp/tool-<id>.json` inside the sandbox and hand the LLM a stub
 * `{_truncated, _path, preview}`. The LLM can then `bash cat <_path>` or
 * `read_file` to fetch the full payload on demand. /tmp is sandbox-local
 * tmpfs (pod lifetime) — fine for this use case; spill files don't need
 * to survive across turns.
 *
 * See: docs/plans/2026-04-19-tool-dispatch-unification-plan.md (Task 3.5 + 4.3).
 */

import { writeFile as nodeWriteFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import type { IIPCClient } from '../runner.js';

/** Minimal client surface — accepts any object with `call(request, timeoutMs?)`. */
export type IPCCaller = Pick<IIPCClient, 'call'>;

export interface DescribeToolsArgs {
  names: string[];
}

export interface CallToolArgs {
  tool: string;
  args: Record<string, unknown>;
}

export interface AgentToolStub<TArgs> {
  name: string;
  execute(args: TArgs): Promise<Record<string, unknown>>;
}

/**
 * Build a `describe_tools` stub that forwards `{names}` to the host via IPC.
 *
 * The host resolves the per-turn catalog (see `src/host/ipc-handlers/describe-tools.ts`)
 * and returns `{tools: [{name, summary, schema}], unknown: [string]}`. This stub
 * does zero transformation — the catalog entry in `TOOL_CATALOG` wraps the
 * response in a `text` content block for the LLM; this raw form is used by
 * unit tests and any direct agent-side consumer.
 */
export function createDescribeToolsTool(
  ipc: IPCCaller,
): AgentToolStub<DescribeToolsArgs> {
  return {
    name: 'describe_tools',
    async execute(args: DescribeToolsArgs): Promise<Record<string, unknown>> {
      return ipc.call({ action: 'describe_tools', names: args.names });
    },
  };
}

/**
 * Minimal filesystem surface the spill path needs — a single `writeFile`
 * method. Defined locally (not `Pick<typeof import('node:fs/promises')>`)
 * so unit tests can inject an in-memory Map without faking the whole
 * Node fs module. Real callers get the default `node:fs/promises`
 * wrapper when they omit the dep.
 */
export interface SpillFs {
  writeFile(path: string, content: string): Promise<void>;
}

/** Optional overrides for the call-tool factory — injected by tests. */
export interface CallToolDeps {
  /** Filesystem for spill writes. Defaults to `node:fs/promises.writeFile`. */
  fs?: SpillFs;
  /**
   * Short random hex id used in the spill path. Defaults to 16 hex
   * chars (8 random bytes = 64 bits) so birthday collisions stay
   * negligible over a pod's tool-call lifetime. Unit tests pin this
   * to get deterministic paths.
   */
  idGenerator?: () => string;
}

/** Default spill-id: 16 hex chars (8 random bytes, 64 bits of entropy). */
function defaultIdGenerator(): string {
  return randomBytes(8).toString('hex');
}

/** Default filesystem: thin wrapper so we don't reach into node:fs at test time. */
const defaultFs: SpillFs = {
  async writeFile(path: string, content: string) {
    await nodeWriteFile(path, content, 'utf8');
  },
};

/**
 * Build a `call_tool` stub that forwards `{tool, args}` to the host via IPC.
 *
 * The host resolves the tool from the per-turn catalog, extracts the
 * optional `_select` jq projection, dispatches (MCP today; OpenAPI in a
 * later phase), and — on success — applies the projection to the result.
 *
 * Response envelopes:
 *   - `{result}` — normal happy path; forwarded unchanged.
 *   - `{truncated: true, full, preview}` — response exceeded the host's
 *     `spill_threshold_bytes`. The stub writes `full` (pretty JSON) to
 *     `/tmp/tool-<id>.json` inside the sandbox and returns a stub
 *     `{_truncated: true, _path, preview}`. If the write fails we fall
 *     back to returning `{_spill_failed, result: full}` — better a big
 *     LLM context than lost data.
 *   - `{error, kind}` — structured error; forwarded unchanged.
 *
 * The second argument is optional so existing callers that only need the
 * IPC pass-through (unit tests, the runner's tool-catalog wiring when it
 * happens to be working with small payloads) don't have to construct a
 * spill fs. Real production wiring uses the defaults.
 */
export function createCallToolTool(
  ipc: IPCCaller,
  deps?: CallToolDeps,
): AgentToolStub<CallToolArgs> {
  const fs = deps?.fs ?? defaultFs;
  const idGenerator = deps?.idGenerator ?? defaultIdGenerator;

  return {
    name: 'call_tool',
    async execute(args: CallToolArgs): Promise<Record<string, unknown>> {
      const response = (await ipc.call({
        action: 'call_tool',
        tool: args.tool,
        args: args.args,
      })) as Record<string, unknown>;

      // Auto-spill path: host flagged the response as too large.
      if (response && response.truncated === true) {
        const id = idGenerator();
        const path = `/tmp/tool-${id}.json`;
        const full = response.full;
        const preview =
          typeof response.preview === 'string' ? response.preview : '';

        try {
          await fs.writeFile(path, JSON.stringify(full, null, 2));
          return {
            _truncated: true,
            _path: path,
            preview,
          };
        } catch (err) {
          // Don't lose data — return the full payload with a flag so the
          // LLM (and logs) see the spill failure reason.
          const msg = err instanceof Error ? err.message : String(err);
          return {
            _spill_failed: msg,
            result: full,
          };
        }
      }

      // Normal pass-through for `{result}` and `{error, kind}` envelopes.
      return response;
    },
  };
}
