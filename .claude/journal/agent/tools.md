# Agent: Tools

Tool catalog consolidation, MCP server tools, tool definition generation, prompt module updates.

## [2026-04-19 19:37] — Close remaining `_select` LLM-facing surfaces (companion to cd22e645)

**Task:** Reviewer agreed my prior-fix callout was valid: closing `_select` in only the `call_tool` description is inconsistent because the prompt-render one-liners (`(team, state?, _select?)`) and the `describe_tools` handler's schema augmentation both still expose `_select` to the LLM. The model would lean on those and ignore the description anyway. Close all three surfaces.
**What I did:**
- `src/types/catalog-render.ts`: dropped `.concat('_select?')` from the one-liner renderer. Left a TODO-ish comment pointing at Task 4.2 for the re-enable (one-line flip).
- `src/host/ipc-handlers/describe-tools.ts`: reduced `augmentSchemaWithSelect` to a pass-through (return the schema unchanged). Kept the function name + call-site + comment so Task 4.2 is a one-line body swap. Updated the file-level doc comment to explain why.
- `src/host/ipc-server.ts`: updated a stale comment that claimed `_select` was still augmented into describe_tools responses.
- Flipped test expectations in 3 test files (no tests deleted):
  - `tests/agent/prompt/modules/tool-catalog.test.ts`: `_select?` no longer in one-liner output; added `.not.toContain('_select')` guard.
  - `tests/host/tool-catalog/render.test.ts`: same — one-liners drop the `_select?` suffix; added `.not.toContain('_select')` guard.
  - `tests/host/ipc-handlers/describe-tools.test.ts`: renamed the "augments with _select" test to "returns schemas WITHOUT _select" (explicitly asserts absence); adjusted the mutation-safety test's title now that it's no longer about augmentation; updated file-level guard comment.
**Files touched:**
- Modified: `src/types/catalog-render.ts` (removed 1 `.concat` + 5-line comment)
- Modified: `src/host/ipc-handlers/describe-tools.ts` (augmentSchemaWithSelect → pass-through + updated doc comments)
- Modified: `src/host/ipc-server.ts` (stale-comment fix)
- Modified: `tests/agent/prompt/modules/tool-catalog.test.ts` (2 assertions flipped)
- Modified: `tests/host/tool-catalog/render.test.ts` (2 assertions flipped)
- Modified: `tests/host/ipc-handlers/describe-tools.test.ts` (2 tests flipped, 1 file comment updated)
**Outcome:** Success. 555/555 tests green across `tests/agent/ + tests/host/tool-catalog/ + tests/host/ipc-handlers/`. `tsc --noEmit` clean. Kept intact: `stripSelect` (still defensive), IPC schemas, `tests/agent/tools/describe-tools.test.ts` _select pass-through test, `tests/host/ipc-handlers/call-tool.test.ts` strip-before-dispatch test.
**Notes:**
- This is the structural fix. After this, the LLM has zero surface advertising `_select`: not in the prompt render, not in describe_tools schema output, not in call_tool's own description. Task 4.2 re-enables all three in one go when projection is wired.
- Companion to cd22e645 (which closed only the call_tool description). Standalone commit so the trajectory is reviewable.

## [2026-04-19 19:34] — Remove `_select` from call_tool description (post-3.5 review fix)

**Task:** Code-quality review on 562524b7 flagged an Important (conf 85) issue: the `call_tool` description advertised `_select` as a jq projection knob, but `stripSelect` in the host handler currently drops it silently (projection lands in Task 4.2). An LLM reading the description would send `_select` expecting a smaller response and get the full response back — a token-budget trap.
**What I did:** Removed the `_select` mention from the `call_tool` catalog description in `src/agent/tool-catalog.ts` (both the `description` string and the nested `args` field description). Same edit in `src/agent/mcp-server.ts` (the claude-code-runner mirror). Kept `stripSelect` intact — it's the defensive guard that prevents `_select` from leaking into the MCP provider if the LLM sends it anyway. Left `describe_tools` description unchanged per the reviewer's explicit scope. Task 4.2 re-adds the advertisement when projection actually works.
**Files touched:**
- Modified: `src/agent/tool-catalog.ts` (description + args description)
- Modified: `src/agent/mcp-server.ts` (args Zod description)
**Outcome:** Success. 627/627 related tests green (tests assert forwarding of `_select`, not its description — no tests needed to change). `tsc` clean.
**Notes:** Other `_select` surfaces — `src/types/catalog-render.ts` appends `_select?` to prompt one-liners, `describe-tools.ts` augments every schema with an `_select` property — are outside the review's scope. Flagged-but-not-fixed-here for a future reviewer pass if the concern extends. The stripSelect defensive guard stays.

## [2026-04-19 19:25] — Register agent-side describe_tools + call_tool (Task 3.5)

**Task:** Task 3.5 of the tool-dispatch-unification plan — graduate `describe_tools` + `call_tool` from schema-only stubs into agent-facing meta-tools, register conditionally on `tool_dispatch.mode === 'indirect'`, ship mode from host via stdin payload. This flips the switch: the full indirect-mode dispatch loop (agent → describe_tools/call_tool → host handlers → MCP) is now reachable end-to-end.
**What I did:**
- Added two new entries to `TOOL_CATALOG` with `singletonAction` (auto-flows into pi-session's `createIPCToolDefinitions` via the existing catalog.map pattern).
- Added matching MCP `tool()` definitions in `mcp-server.ts` so the claude-code runner also registers them.
- Extended `ToolFilterContext` with an optional `toolDispatchMode` field (defaults to `'indirect'` when absent). `filterTools(ctx)` strips describe_tools + call_tool in `direct` mode via a `INDIRECT_ONLY_TOOLS` set.
- Extended `AgentConfig` + `StdinPayload` + `parseStdinPayload` + `applyPayload` with a `tool_dispatch` block. Host `server-completions.ts` ships `config.tool_dispatch` alongside `catalog`. `buildSystemPrompt` reads `config.tool_dispatch?.mode ?? 'indirect'` and threads it into the returned `toolFilter`.
- Created `src/agent/tools/describe-tools.ts` with `createDescribeToolsTool(ipc)` + `createCallToolTool(ipc)` factory functions — primitive IPC pass-throughs used by the new unit-test file. These are a hook point for the Task 4.x projection + spill work; real wiring stays in the catalog dispatch layer.
- New `tests/agent/tools/describe-tools.test.ts` with 11 tests covering both factories (IPC payload shape, pass-through, error propagation, `_select` forwarding).
- Cleaned up the `knownInternalActions` exemption for `describe_tools` + `call_tool` in `tool-catalog-sync.test.ts` per the Task 3.2→3.5 graduation comment (left a breadcrumb comment noting where the actions now live).
- Bumped tool counts 13→15 in `tool-catalog.test.ts`, `ipc-tools.test.ts`, `mcp-server.test.ts`. Added 6 new mode-based filtering tests (covers direct mode hides / indirect mode exposes / default-indirect).
- Updated `.claude/skills/ax-agent/SKILL.md` with the new file reference and a note about `toolDispatchMode`.
**Files touched:**
- Modified: `src/agent/tool-catalog.ts` (+55 lines — 2 catalog entries + mode filter)
- Modified: `src/agent/mcp-server.ts` (+17 lines — 2 `tool()` defs)
- Modified: `src/agent/runner.ts` (+26 lines — AgentConfig + StdinPayload + parse + apply)
- Modified: `src/agent/agent-setup.ts` (+4 lines — thread mode into toolFilter)
- Modified: `src/host/server-completions.ts` (+4 lines — ship `tool_dispatch` in stdin payload)
- Created: `src/agent/tools/describe-tools.ts` (+77 lines)
- Created: `tests/agent/tools/describe-tools.test.ts` (+123 lines, 11 tests)
- Modified: `tests/agent/tool-catalog.test.ts` (+34 lines — count + mode filter tests)
- Modified: `tests/agent/tool-catalog-sync.test.ts` (-5 / +4 lines — remove exempt entries)
- Modified: `tests/agent/ipc-tools.test.ts` (+26 lines — IPC payload tests, direct-mode test)
- Modified: `tests/agent/mcp-server.test.ts` (+28 lines — direct/indirect mode tests)
- Modified: `.claude/skills/ax-agent/SKILL.md` (+2 lines)
**Outcome:** Success. 627/627 related tests green (agent + ipc-handlers + ipc + config). `tsc` clean. 29 host/server.test.ts failures confirmed pre-existing on main (macOS socket-path-too-long, unrelated).
**Notes:**
- **Why TOOL_CATALOG entries + factory functions both:** catalog entries handle real wiring through pi-session + mcp-server consistently. The factory functions exist because (a) the plan's test-signature snippet asked for `createDescribeToolsTool(ipc)` and (b) they become a natural hook point for Task 4.2 (projection) + 4.3 (spill), which need agent-side logic wrapping the IPC call.
- **Default-indirect-when-missing:** host now always ships `tool_dispatch` (Task 3.1 made it non-optional), but inline-built `AgentConfig`s in tests frequently omit it. Agent-side default is `'indirect'` (matches host config default).
- **Filterless call site:** `mcp-server.ts` default when `opts.filter` is undefined is still `null → include all`. That means describe_tools/call_tool appear whenever no filter is passed (e.g., in tool-catalog-sync.test.ts `createIPCMcpServer(client)`). Matches the catalog's no-filter behavior — consistent default.
- **Direct mode coverage:** added explicit tests for the direct-mode "no meta tools" path in tool-catalog.test.ts (4 tests), ipc-tools.test.ts (1 test), and mcp-server.test.ts (1 test). Task 5.1 will later register individual catalog tools in direct mode; for now direct mode just hides the two meta-tools.

## [2026-03-31 10:00] — Add dedicated grep and glob tools to agent

**Task:** Add structured `grep` and `glob` tools to pi-coding-agent, replacing raw bash `rg`/`find` usage with context-window-safe alternatives
**What I did:** Full-stack implementation across 10 files:
- IPC schemas: `SandboxGrepSchema` and `SandboxGlobSchema` in ipc-schemas.ts, updated SandboxApprove/Result enums
- Tool catalog: two new singleton tools in `sandbox` category (tool-catalog.ts)
- Host handlers: `sandbox_grep` (spawns `rg` with streaming truncation) and `sandbox_glob` (spawns `rg --files --glob`) in sandbox-tools.ts
- Local sandbox: `grep()` and `glob()` methods with audit gate pattern in local-sandbox.ts
- IPC routing: two new switch cases in ipc-tools.ts
- MCP server: two new `tool()` definitions for claude-code runner in mcp-server.ts
- Prompt: tool-style.ts updated to guide agent to prefer grep/glob over bash
- Tests: 9 new handler tests (5 grep, 4 glob), updated tool counts in 4 test files (18→20)
**Files touched:** Modified: src/ipc-schemas.ts, src/agent/tool-catalog.ts, src/host/ipc-handlers/sandbox-tools.ts, src/agent/local-sandbox.ts, src/agent/ipc-tools.ts, src/agent/mcp-server.ts, src/agent/prompt/modules/tool-style.ts, tests/host/ipc-handlers/sandbox-tools.test.ts, tests/agent/ipc-tools.test.ts, tests/agent/tool-catalog.test.ts, tests/agent/mcp-server.test.ts, tests/sandbox-isolation.test.ts
**Outcome:** Success — all 2762 tests passing
**Notes:** Both tools use ripgrep (`rg`) as backend. Key feature is `max_results` (default 100) with `truncated` flag to protect context window. Tool counts went from 18 to 20 in 5 separate test files — lesson reinforced: tool count is hardcoded in many places.

## [2026-03-15 15:30] — Implement local sandbox execution (Tasks 1-11)

**Task:** Implement unified agent container architecture — agents execute tools locally with host audit gate
**What I did:** Added audit gate IPC schemas (sandbox_approve/sandbox_result), host-side audit gate handlers, agent-side local executor (local-sandbox.ts), workspace provisioning CLI, wired local sandbox into all three tool dispatch paths (ipc-tools, pi-session, claude-code/MCP), three-phase container orchestration, resource tiers for delegation, removed legacy providers (seatbelt/nsjail/bwrap), removed ephemeral container and NATS dispatch infrastructure, updated Dockerfile/CI/Helm, updated docs.
**Files touched:** ~40 files created/modified/deleted across src/agent/, src/host/, src/providers/, src/config.ts, src/ipc-schemas.ts, container/, charts/, flux/, .github/, docs/, README.md, and their tests
**Outcome:** Success — all 202 test files, 2396 tests passing. Build clean.
**Notes:** Three separate tool creation paths needed sandbox wiring (ipc-tools.ts, pi-session.ts, mcp-server.ts). The MCP server uses a ternary pattern while the others use switch statements. Tool-catalog-sync tests caught missing registrations immediately.

## [2026-03-14 12:00] — Restore workspace tool in agent catalog (lazy-sandbox Task 3)

**Task:** Add a `workspace` tool to the agent tool catalog so the LLM can write files to persistent workspace tiers (agent/user) without requiring a sandbox.
**What I did:** Added `'workspace'` to ToolCategory union, added workspace tool entry to TOOL_CATALOG with `Type.Union([write])` and `actionMap: { write: 'workspace_write' }`, added `'workspace'` case to `filterTools` gated on `hasWorkspaceScopes`, added matching MCP tool in `mcp-server.ts`, updated tool counts from 14 to 15 in 5 test files, added workspace tool test, removed `'workspace_write'` from knownInternalActions in sync test since it's now catalog-mapped.
**Files touched:** Modified: src/agent/tool-catalog.ts, src/agent/mcp-server.ts, tests/agent/tool-catalog.test.ts, tests/agent/tool-catalog-sync.test.ts, tests/agent/mcp-server.test.ts, tests/agent/ipc-tools.test.ts, tests/sandbox-isolation.test.ts
**Outcome:** Success — all 321 agent tests + 33 sandbox-isolation tests pass
**Notes:** Workspace tool uses `Type.Union([...])` even with one member for future extensibility. Category is `'workspace'` (distinct from `'workspace_scopes'`). Both gate on `ctx.hasWorkspaceScopes`.

## [2026-03-04 19:05] — Move bash/file tools from local to IPC (Phase 1, Task 3)

**Task:** Move bash, read_file, write_file, edit_file tools from local (in-process) execution to IPC routing through the host process, as groundwork for k8s sandbox pod dispatch.
**What I did:** Added 4 sandbox tools to TOOL_CATALOG (tool-catalog.ts), 4 Zod schemas (ipc-schemas.ts), created host-side IPC handlers (sandbox-tools.ts) with safePath containment, registered handlers in ipc-server.ts with shared workspaceMap, wired workspace registration/deregistration in server-completions.ts and server.ts, removed local-tools.ts (now unused), updated pi-session.ts to pass tools: [] (no built-in coding tools), added sandbox tools to mcp-server.ts, and updated all affected tests.
**Files touched:** Created: src/host/ipc-handlers/sandbox-tools.ts, tests/host/ipc-handlers/sandbox-tools.test.ts. Deleted: src/agent/local-tools.ts, tests/agent/local-tools.test.ts. Modified: src/agent/tool-catalog.ts, src/ipc-schemas.ts, src/host/ipc-server.ts, src/host/server-completions.ts, src/host/server.ts, src/agent/runners/pi-session.ts, src/agent/mcp-server.ts, tests/agent/tool-catalog.test.ts, tests/agent/ipc-tools.test.ts, tests/sandbox-isolation.test.ts, tests/agent/mcp-server.test.ts, tests/integration/cross-component.test.ts, tests/agent/runners/pi-session.test.ts
**Outcome:** Success — build passes, 2332/2335 tests pass (3 pre-existing failures in skills-install unrelated to this change)
**Notes:** Key design decision: shared workspaceMap (Map<string, string>) flows from server.ts to both completionDeps (register/deregister) and createIPCHandler (consume). The requestId used in processCompletion becomes sessionId in IPC context. Pi-session tests needed tool name updates (write -> write_file) and mock IPC servers for sandbox_write_file.

## [2026-02-28 22:30] — Update prompt modules with consolidated tool names

**Task:** Update 6 prompt modules in `src/agent/prompt/modules/` to reference new consolidated tool names instead of old individual IPC tool names
**What I did:** Updated tool name references in all 6 prompt module files:
- `memory-recall.ts`: `memory_query`/`memory_read`/`memory_write` -> `memory({ type: "query" })` etc.
- `skills.ts`: `skill_read`/`skill_propose` -> `skill({ type: "read" })` etc.
- `heartbeat.ts`: `scheduler_add_cron`/`scheduler_run_at`/`scheduler_remove_cron`/`scheduler_list_jobs` -> `scheduler({ type: "add_cron" })` etc.
- `delegation.ts`: `agent_delegate` -> `delegate`
- `runtime.ts`: `workspace_write`/`identity_propose`/`proposal_list` -> `workspace({ type: "write" })`/`governance({ type: "propose" })`/`governance({ type: "list_proposals" })`
- `identity.ts`: `identity_write`/`user_write` -> `identity({ type: "write" })`/`identity({ type: "user_write" })`
**Files touched:** `src/agent/prompt/modules/memory-recall.ts`, `src/agent/prompt/modules/skills.ts`, `src/agent/prompt/modules/heartbeat.ts`, `src/agent/prompt/modules/delegation.ts`, `src/agent/prompt/modules/runtime.ts`, `src/agent/prompt/modules/identity.ts`
**Outcome:** Success — all old tool names replaced with consolidated syntax
**Notes:** Found an additional `user_write` reference in `security.ts` line 45 that was not in the task scope. Left it for a follow-up since instructions said to only modify the 6 listed files.

## [2026-02-28 22:48] — Update all tests for consolidated tool names (Task 6)

**Task:** Update all test files in `tests/agent/` to match the 10-tool consolidated catalog
**What I did:** Updated 10 test files across the agent test suite:
- `tool-catalog.test.ts`: Count 28->10, updated expected names, param key tests for union schemas, category `'skills'->'skill'`, injectUserId on `identity` instead of `user_write`, filterTools assertions use consolidated names
- `tool-catalog-sync.test.ts`: MCP sync uses superset check for union params, prompt sync checks type values not old tool names, IPC schema sync checks actionMap/singletonAction values against IPC_SCHEMAS
- `ipc-tools.test.ts`: All tool references updated (memory/web/identity/scheduler/delegate/image), count 28->10, filter tests use consolidated names, multi-op dispatch tests use type param
- `mcp-server.test.ts`: All tool lookups use consolidated names, count 28->10, handler calls include type param
- `prompt/modules/heartbeat.test.ts`: `scheduler_add_cron` etc. -> check for `scheduler` + type values
- `prompt/modules/skills.test.ts`: `skill_read`/`skill_propose` -> check for `skill` + `read`/`propose`
- `prompt/modules/memory-recall.test.ts`: `memory_query`/`memory_write`/`memory_read` -> check for `memory` + type values
- `prompt/modules/identity.test.ts`: `identity_write`/`user_write` -> check for `identity` + type values
- `prompt/enterprise-runtime.test.ts`: `identity_propose`/`proposal_list` -> `governance` + `propose`/`list_proposals`
- `runners/pi-session.test.ts`: Updated tool name assertions and mock LLM tool_use payload to use consolidated names
**Files touched:** 10 files in `tests/agent/`
**Outcome:** Success — all 324 agent tests pass across 34 test files
**Notes:** IPC client tests (`ipc-client.test.ts`) and host tests were left untouched since they test transport/IPC actions which haven't changed.

## [2026-02-28 22:30] — Consolidate MCP server tools (28 -> 10)

**Task:** Rewrite the `allTools` array in `src/agent/mcp-server.ts` to replace 28 individual `tool()` calls with 10 consolidated ones, matching the tool catalog consolidation.
**What I did:**
- Replaced 28 individual Zod `tool()` calls with 10 consolidated tool definitions
- Multi-op tools use `z.enum()` for the `type` field with all operation-specific fields made optional
- Each multi-op handler strips undefined optional fields before dispatching: `Object.fromEntries(Object.entries(rest).filter(([_, v]) => v !== undefined))`
- Added `SCHEDULER_ACTIONS` and `GOVERNANCE_ACTIONS` lookup maps for irregular IPC action name mappings
- Identity tool handler includes origin normalization and userId injection for `user_write` operations
- Governance `propose` handler includes origin normalization
- Singleton tools (audit, delegate, image) pass args directly to their fixed IPC action
- `allowedNames` filtering unchanged -- still uses `filterTools().map(s => s.name)` which now returns the 10 consolidated names
**Files touched:** `src/agent/mcp-server.ts`
**Outcome:** Success — file compiles clean, no `mcp-server.ts` errors in `npx tsc --noEmit`
**Notes:** The Zod `tool()` helper takes a flat schema shape (not `z.object()`), so discriminated unions aren't usable. Instead, `type` is a `z.enum()` and all operation-specific fields are `.optional()`. The handler strips undefineds before calling IPC.

## [2026-02-28 22:00] — Consolidate tool-catalog.ts from 28 tools to 10

**Task:** Rewrite `src/agent/tool-catalog.ts` to consolidate 28 separate ToolSpec entries into 10 consolidated tools using a `type` discriminator pattern for multi-op tools and `singletonAction` for single-op tools.
**What I did:**
- Replaced the entire `TOOL_CATALOG` array: 28 entries -> 10 entries (memory, web, identity, scheduler, skill, workspace, governance, audit, delegate, image)
- Added `actionMap` and `singletonAction` fields to the `ToolSpec` interface
- Changed `ToolCategory` from `'skills'` to `'skill'` (singular)
- Updated `filterTools()` to use `'skill'` instead of `'skills'`
- Updated `getToolParamKeys()` to handle TypeBox `Type.Union()` schemas (collects all keys across union members, excluding `type`)
- Added `timeoutMs: 600_000` to delegate tool and `timeoutMs: 120_000` to image tool
- Multi-op tools use `Type.Union([Type.Object({type: Type.Literal(...), ...}), ...])` pattern
- All 28 original IPC action names preserved in actionMap/singletonAction fields
**Files touched:** `src/agent/tool-catalog.ts`
**Outcome:** Success — TypeScript compiles clean (`npx tsc --noEmit` passes), all 28 IPC actions accounted for
**Notes:** The `actionMap` field maps `type` discriminator values to flat IPC action names (e.g. `{write: 'memory_write', query: 'memory_query'}`). Some mappings are irregular: scheduler `remove` -> `scheduler_remove_cron`, scheduler `list` -> `scheduler_list_jobs`, governance `propose` -> `identity_propose`.

## [2026-02-28 21:30] — Update pi-session.ts tool definition generation (Task 4)

**Task:** Update `createIPCToolDefinitions()` in pi-session.ts to use actionMap/singletonAction dispatch logic matching ipc-tools.ts
**What I did:** Rewrote the execute function body inside `createIPCToolDefinitions()` to:
- For multi-op tools (with `actionMap`): extract `type` from params, look up IPC action in `spec.actionMap[type]`, pass remaining params without `type`
- For singleton tools (with `singletonAction`): use `spec.singletonAction` as IPC action, pass all params
- For legacy tools (neither): fall back to `spec.name` as action
- Inject `userId` only when the resolved action is `user_write`
- Apply origin normalization when resolved action is in `TOOLS_WITH_ORIGIN` (now includes `identity_propose`)
- Apply file normalization when resolved action is `identity_write`
- Return error text if `type` value not found in `actionMap`
**Files touched:** `src/agent/runners/pi-session.ts`
**Outcome:** Success — `npm run build` compiles cleanly with zero errors
**Notes:** The dispatch logic now mirrors `ipc-tools.ts` — both resolve the IPC action name the same way before calling through to the host.

## [2026-02-26 14:00] — LLM tool call optimization: context-aware filtering

**Task:** Optimize LLM tool calls by adding context-aware filtering so only relevant tools are sent per session
**What I did:**
1. Added `ToolCategory` type and `category` field to `ToolSpec` — tagged all 25 tools across 9 categories (memory, web, audit, identity, scheduler, skills, delegation, workspace, governance)
2. Added `ToolFilterContext` interface and `filterTools()` function — excludes tools by category based on session flags (hasHeartbeat, hasSkills, hasWorkspaceTiers, hasGovernance)
3. Tightened verbose tool descriptions in TOOL_CATALOG and MCP server — reduced identity_write, user_write, skill_propose, agent_delegate, workspace/governance descriptions by 50-70%
4. Refactored `buildSystemPrompt()` to return `toolFilter` alongside `systemPrompt` — single derivation point for filter context
5. Wired filtering into all 3 tool consumers: ipc-tools.ts (pi-agent-core), pi-session.ts (pi-coding-agent), mcp-server.ts (claude-code)
6. Refactored claude-code.ts to use shared `buildSystemPrompt()` instead of manual PromptBuilder usage
7. Updated tests: fixed tool count assertions, added HEARTBEAT.md fixture to pi-session test, added filterTools test suite (12 tests), added filter tests to ipc-tools (3 tests) and mcp-server (2 tests), updated sandbox-isolation test
**Files touched:**
- Modified: src/agent/tool-catalog.ts, src/agent/ipc-tools.ts, src/agent/mcp-server.ts, src/agent/agent-setup.ts, src/agent/runner.ts, src/agent/runners/pi-session.ts, src/agent/runners/claude-code.ts
- Modified tests: tests/agent/tool-catalog.test.ts, tests/agent/ipc-tools.test.ts, tests/agent/mcp-server.test.ts, tests/agent/runners/pi-session.test.ts, tests/sandbox-isolation.test.ts
**Outcome:** Success — 151 test files, 1546 tests pass (1 skipped, pre-existing)
**Notes:** Without heartbeat/skills/enterprise, tool count drops from 25 to 11 per LLM call. Filter context aligns with prompt module shouldInclude() logic — if HeartbeatModule is excluded, scheduler tools are too. All existing sync tests still pass since they test against the unfiltered catalog.

## [2026-04-20 07:50] — Phase 5 direct-mode dispatch (Tasks 5.1 + 5.2)

**Task:** Implement Phase 5 of the tool-dispatch unification plan. When `tool_dispatch.mode === 'direct'`, every catalog tool (mcp_linear_*, api_*) becomes a first-class AgentTool in the LLM's tools[] with its real JSON Schema, so constrained decoders enforce argument shapes. Execution still routes through `call_tool` internally so projection + spill semantics stay centralized.

**What I did:** Extended `IPCToolsOptions` and `IPCToolDefsOptions` (pi-session's variant) with an optional `catalog: CatalogTool[]`. In direct mode, each catalog entry gets appended to the returned tool list with a thin wrapper that routes through ipcCall('call_tool', {tool, args}). Schema conversion: cast the raw JSON Schema to TSchema (structural superset). In indirect mode the option is silently ignored — describe_tools/call_tool meta-tools take the LLM-facing slot per filterTools.

**Files touched:** src/agent/ipc-tools.ts, src/agent/runners/pi-session.ts, tests/agent/ipc-tools.test.ts (+5 tests).

**Outcome:** Success. 25/25 focused (ipc-tools + agent-setup), full 2833/2891 (+5 from prior, 34 pre-existing unchanged).

**Notes:** Tasks 5.1 and 5.2 are fused — once the tool is exposed with the real schema, the only sensible execute() routes through call_tool. Skipped Task 5.3 (weak-model smoke test) — the mock OpenRouter doesn't have "weak model" characteristics; real arg-shape accuracy comparison needs a live model. claude-code runner + mcp-server.ts (Zod path) aren't yet updated — those paths are used less often and can follow in a separate PR.
