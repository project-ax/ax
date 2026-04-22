# Agent: execute_script

Local Node sandbox used by the agent for ad-hoc scripting. Executes `args.code`
in a spawned `node` subprocess with a preamble that exposes
`globalThis.ax` (callTool / describeTool) over HTTP IPC.

## [2026-04-21 11:00] — RETIRED

**Status:** `execute_script` has been removed from the codebase. The catalog entry, handler, `ax.callTool` preamble, MCP registration, and `/tmp/ax-results` spill protocol are all gone. Replaced by the `tool` CLI shim model: `/opt/ax/tools/bin/tool` + per-catalog-tool symlinks, dispatched as native bash commands via argv[0].

**Retirement commits:** `c5a96d87` (catalog entry), `3b7b05d5` (MCP registration), `c256d096` (handler + preamble + spill + IPC routing).

**Why:** stateless-script-with-stdout-only thrashed in production — agents made 7+ shape-probing calls per task instead of composing pipelines. CLI shims play to the LLM's trained-on pattern (bash + jq + pipes + filesystem-as-state) and shipped the same capability with atomic observable calls.

See `.claude/journal/agent/tool-cli.md` for the full migration retrospective and commit-by-commit breakdown.

Entries below are historical — kept for archaeology of why each design decision was made. Nothing below this line is live.

---

## [2026-04-20 14:15] — Task 6.4: Port input-shape guards to ax.callTool

**Task:** Restore the per-tool, actionable TypeError the legacy codegen used to
throw on bad `params` shape. Post-Task 6.3, wrong-shape calls fell through to
the host Zod validator with a less helpful message — this wires the catalog's
compact key list + required keys into the `ax.callTool` preamble so the error
fires locally with the tool name and key hint.
**What I did:**
- `src/agent/execute-script.ts`: refactored the static `AX_PREAMBLE` string
  into `buildPreamble(catalog?)` and extracted a `buildSchemaMap(catalog)`
  helper. Preamble now injects a `const __AX_TOOL_SCHEMAS__ = {...}` compact
  map `{name: {properties, required}}` — intentionally NOT the full JSON
  schema (the host still does full Zod validation at IPC; types/constraints
  in the preamble would just bloat every script). `ax.callTool` now:
  1) looks up `__AX_TOOL_SCHEMAS__[name]`,
  2) if found, includes the first-3-keys-plus-ellipsis hint in the generic
     "args must be an object" error,
  3) if found and `required` is non-empty, errors if any required key is
     missing (listing the missing ones).
  When schema is missing (unknown tool) or no catalog was passed, falls back
  to the generic `ax.callTool("<name>", args) — args must be an object` that
  Task 6.1 shipped. Exported `buildPreamble` and `buildSchemaMap` so tests
  can assert on them directly.
- Added `catalog?: CatalogTool[]` as a third optional arg to `executeScript`.
- Threaded `opts?.catalog` into executeScript at both caller sites that had
  it: `src/agent/runners/pi-session.ts` and `src/agent/ipc-tools.ts`.
- `src/agent/mcp-server.ts`: added `catalog?: CatalogTool[]` to
  `MCPServerOptions` and passed it through to `executeScript`. Updated
  `src/agent/runners/claude-code.ts` to thread `config.catalog` when
  creating the MCP server.
- `tests/agent/execute-script.test.ts`: added 6 integration tests (wrong
  shape with hint, missing required keys, tool not in catalog, no catalog,
  no per-property type validation, empty-required passes empty args) plus
  4 unit tests for `buildSchemaMap` / `buildPreamble` edge cases (missing
  properties, non-array required, mixed required types, preamble literal
  shape).
**Files touched:**
- Modified: `src/agent/execute-script.ts`
- Modified: `src/agent/ipc-tools.ts`
- Modified: `src/agent/mcp-server.ts`
- Modified: `src/agent/runners/pi-session.ts`
- Modified: `src/agent/runners/claude-code.ts`
- Modified: `tests/agent/execute-script.test.ts` (+10 tests)
**Outcome:** Success. `npx vitest run tests/agent/execute-script.test.ts`
29/29 pass. `npx vitest run tests/agent/` 429/429 pass. `npm run build` clean.
Pre-existing failures in `tests/sandbox-isolation.test.ts` (tool-count drift
to 13 vs 11) and `tests/host/*` (EINVAL long-socket-path on darwin tmp dirs)
reproduce on the untouched branch HEAD — unrelated to this change.
**Notes:**
- Preamble size: empty catalog ~2.5KB; 50-tool catalog ~5.9KB. Each tool
  adds roughly 70 bytes (`"mcp_tool_X":{"properties":[..5 keys..],"required":["a"]}`).
  Well within acceptable overhead.
- Key-hint slicing matches the old codegen exactly: first 3 keys + `, ...`
  if more than 3. Keeps error messages scannable.
- MCP server is the legacy path (claude-code runner). Previously had no
  catalog field on `MCPServerOptions`; added one this task. When
  `config.catalog` is undefined, `buildPreamble(undefined)` is byte-identical
  to `buildPreamble([])` and the fallback generic validation still works.

## [2026-04-20 13:45] — Task 6.2: Rewrite execute_script tool description for ax.callTool API

**Task:** Replace the stale `/workspace/.ax/tools/` import advertisement in the
`execute_script` catalog entry with the new `ax.callTool` pattern injected by
the Task 6.1 preamble.
**What I did:**
- `src/agent/tool-catalog.ts`: rewrote the `execute_script` description. It now
  (1) names `ax.callTool` / `ax.describeTool` as the API, (2) states that the
  output shape is not typed and recommends log-on-first-use or `opts.select`
  jq projection, (3) explicitly says errors throw (use try/catch), (4) shows
  the canonical team → cycle → issues 3-liner, and (5) preserves the 10KB
  stdout cap + `/tmp/ax-results/` spill note. Also replaced the stale `code`
  parameter `description`.
- `src/agent/mcp-server.ts`: mirrored the `code` parameter description update
  (the MCP pathway had its own stale copy).
- `tests/agent/tool-catalog.test.ts`: added a sync test asserting the
  `execute_script` description mentions `ax.callTool` + `ax.describeTool` +
  `10KB` + `/tmp/ax-results`, and does NOT mention `/workspace/.ax/tools/` or
  `import {` (both of which would survive from the old codegen world).
**Files touched:**
- Modified: `src/agent/tool-catalog.ts`
- Modified: `src/agent/mcp-server.ts`
- Modified: `tests/agent/tool-catalog.test.ts` (+1 test)
**Outcome:** Success. `npm run build` clean; `npm test -- tests/agent/` passes
435/435.
**Notes:**
- Left `src/agent/runner.ts` and `src/agent/prompt/modules/runtime.ts` alone —
  those `.ax/tools/` references are Task 6.3 (codegen deletion) and Task 6.5
  (documentation sweep) territory, out of scope here.
- Used `mcp_linear_*` names in the example deliberately — Linear is the
  motivating skill in the plan, and the names come straight from the catalog
  naming pattern (`mcp_<server>_<tool>`). Keeps the example concrete without
  hardcoding anything that isn't already there in production.

## [2026-04-20 13:40] — Task 6.1 follow-up: tighten null-result handling + coverage gaps

**Task:** Code-review follow-ups on the `ax.callTool` preamble (Task 6.1):
(1) `result.result ?? result` silently masked `{result: null}` success;
(2) empty-string `AX_IPC_TOKEN` was not exercised by tests;
(3) `describeTool(123)` wrapped to `[123]` and sent without local guard.
**What I did:**
- `src/agent/execute-script.ts`: changed the unwrap line to
  `'result' in result ? result.result : result` — `{result: null}` now
  returns `null` instead of the wrapper. Added a non-empty-string guard
  to `describeTool` mirroring the one on `callTool` (throws TypeError
  for numeric/empty names before posting).
- `tests/agent/execute-script.test.ts`: added 3 tests in the existing
  `describe('ax.* preamble …')` block — null-result passthrough,
  empty-string token omits Authorization header, `describeTool(123)`
  throws TypeError.
**Files touched:**
- Modified: `src/agent/execute-script.ts` (preamble body only)
- Modified: `tests/agent/execute-script.test.ts` (+3 tests)
**Outcome:** Success. 16/16 execute-script tests pass (was 13);
agent suite 434/434 green (was 431); `npm run build` clean.
**Notes:**
- No preamble-drift concerns: there's no byte-equivalence assertion
  anywhere — the spec line from the plan is the only authority, and it
  explicitly called for the `in`-check rewrite.
- `'result' in result` will throw if `result` is a primitive (e.g. raw
  `null` JSON), but so did the original `result.result ?? result` via
  property access. Behavior parity preserved on non-object responses.

## [2026-04-20 13:32] — Task 6.1: inject ax.callTool preamble into execute_script

**Task:** Tool-dispatch-unification Phase 6 Task 6.1 — prepend a runtime
preamble to every `execute_script` body so LLM-authored scripts can call
catalog tools directly via `ax.callTool(name, args, opts?)` /
`ax.describeTool(names)`, without going through the legacy codegen
pipeline (`/workspace/.ax/tools/<server>/index.js`). Preamble posts to
`/internal/ipc` on the host using `AX_HOST_URL` + `AX_IPC_TOKEN`,
matching the per-turn catalog-era action shapes (`call_tool`,
`describe_tools`).
**What I did:**
- `src/agent/execute-script.ts`: added the `AX_PREAMBLE` constant (byte-for-byte
  the spec in the plan) and concatenated it onto `args.code` before writing
  the tmp `.mjs`. Updated the file header to document the preamble contract
  and the line-number-shift caveat.
- `tests/agent/execute-script.test.ts`: added 11 real-subprocess tests
  covering HTTP body shape, success/error unwrapping, `opts.select` →
  `_select` inlining, missing `AX_HOST_URL`, local TypeError guards,
  `describeTool` list-wrapping, a no-op-preamble regression, and
  `version: 1`.
- Fake `/internal/ipc` server runs in a `worker_thread` because
  `execFileSync` blocks the main event loop — a same-thread HTTP server
  can't accept the subprocess's connection.
- Worker → parent `postMessage` races with `execFileSync`'s synchronous
  return; added a `host.flush()` (setImmediate yield) that every test
  awaits before asserting on `host.requests`.
**Files touched:**
- Modified: `src/agent/execute-script.ts` (+84 lines, preamble + header)
- Modified: `tests/agent/execute-script.test.ts` (+240 lines, 11 new integration tests)
- Created: `.claude/journal/agent/execute-script.md` (this file)
**Outcome:** Success. 13/13 tests pass in 1.09s; full agent suite
431/431 green; `npm run build` clean.
**Notes:**
- Spec compliance: preamble text is byte-for-byte from the plan — no
  unilateral tweaks. `result.result ?? result` handles both the
  `{result}` success case and the `{truncated, full, preview}` envelope
  (spill protocol flows through as a plain object for scripts that want
  to inspect it).
- Child-process networking gotcha: the fake HTTP server MUST be on a
  different thread than the test caller. I burned ~20 minutes on this
  before the worker-thread rewrite — recording as a lesson.

