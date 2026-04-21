# IPC: Protocol

IPC protocol enhancements: heartbeat keep-alive, schema hardening, transport simplification.

## [2026-04-19 20:15] — Tool dispatch Task 3.4 follow-up: thread ctx.userId through call_tool dispatcher

**Task:** Review found that `server-init.ts`'s `callToolMcpDispatcher` adapter captured `defaultUserId` at construction time instead of threading per-request userId from IPC ctx — latent on 3.4 (handler unreachable), live bug the moment Task 3.5 ships. Both reviewers flagged Important, fix-before-3.5.
**What I did:** Made `ctx: {agentId, userId}` a required field on `CallToolMcpDispatcher.callToolOnServer` input (not optional — forces the threading). Handler passes `{agentId: ctx?.agentId ?? '', userId: ctx?.userId ?? ''}` on every dispatch, mirroring tool-batch's `ctx.userId ?? ''` convention at `tool-batch.ts:188`. Adapter in `server-init.ts` now uses `ctx.agentId` + `ctx.userId` when calling `resolveMcpAuthHeaders` and `mcpManager.getServerMeta` — `defaultUserId` capture removed entirely; added a DO-NOT-REINTRODUCE comment so this can't silently regress. Added two new tests: (1) dispatches with different userIds per-call against the same host (alice then bob) and asserts each dispatch gets the right ctx — the exact scenario the bug would break on a multi-user host; (2) ctx with no userId → empty string (matches tool-batch convention). Updated the existing happy-path test to assert the full `{server, tool, args, ctx}` shape.
**Files touched:** src/host/ipc-handlers/call-tool.ts (+9/−2: interface + handler threads ctx), src/host/server-init.ts (+12/−9: adapter accepts ctx, removes `defaultUserId` capture), tests/host/ipc-handlers/call-tool.test.ts (+58/−4: happy-path assertion updated, 2 new tests)
**Outcome:** Success — 12/12 call-tool tests pass (was 10), 387/387 across ipc-handlers + tool-catalog + skills + agent sync + ipc-schemas, tsc clean.
**Notes:** Zero surprises in the call-chain. The handler already received `ctx: IPCContext | undefined` (for closure-form catalog lookup); all we needed was to forward its identity fields into the dispatcher call. The `?? ''` fallback keeps the shape compatible with IPC contexts that genuinely have no userId (e.g. server-internal `defaultCtx` at `server-init.ts:544`) without reintroducing a captured default.

## [2026-04-19 19:50] — Tool dispatch Task 3.4: call_tool handler + catalogMap per-session plumbing

**Task:** Implement the `call_tool` IPC handler (Task 3.4 of the tool-dispatch-unification plan) — single-tool pass-through dispatch by catalog lookup. Also populate the `resolveCatalog` wiring that Task 3.3 left deferred, so both `describe_tools` and `call_tool` are actually reachable in production.
**What I did:** Created `src/host/ipc-handlers/call-tool.ts` (factory mirrors `describe-tools.ts`: accepts either `catalog?: CatalogReader` for tests or `resolveCatalog?: (ctx) => ...` for production, plus a required `mcpProvider: CallToolMcpDispatcher`). Strips `_select` from args before dispatch (projection is Task 4.2). Returns `{result}` on success, `{error, kind}` for structured errors (`unknown_tool`, `unsupported_dispatch`, `dispatch_failed`) — never throws across the IPC boundary. 10 tests, all 3 plan-specified cases plus `_select` stripping, closure-form wiring, no-catalog-for-turn, openapi-dispatch guard, factory guards, and non-Error coercion. Per-session catalog plumbing: added `catalogMap: Map<sessionId, CatalogReader>` to `CompletionDeps` and `HostCore`, constructed in `server-init.ts` next to `workspaceMap`, registered in `processCompletion` immediately after `getOrBuildCatalog` resolves and unregistered in the outer `finally` block (same lifetime as `workspaceMap`). Wired `resolveCatalog: (ctx) => catalogMap.get(ctx.sessionId)` and a `callToolMcpDispatcher` adapter into `createIPCHandler`. Adapter turns `{server, tool, args}` → `mcpManager.getServerMeta(agentId, server)` → `callToolOnServer(url, tool, args, {headers, transport})` with header-resolution fallback to `resolveMcpAuthHeaders`. Extended `mcpManager.getServerMeta` return shape with `url` (pre-existing callers only read `source`/`headers`/`transport`, unaffected).
**Files touched:** src/host/ipc-handlers/call-tool.ts (+138, new), tests/host/ipc-handlers/call-tool.test.ts (+170, new), src/host/ipc-server.ts (+17: import + option + conditional handler registration), src/host/server-completions.ts (+19: catalogMap deps field, import, register + unregister), src/host/server-init.ts (+58: catalogMap construction, completionDeps wiring, resolveCatalog closure, callToolMcpDispatcher adapter), src/plugins/mcp-manager.ts (+3: expose `url` on `getServerMeta` return).
**Outcome:** Success — 10/10 new call-tool tests pass, 387/387 across ipc-handlers + tool-catalog + skills + agent sync + ipc-schemas + plugins, tsc clean. Pre-existing macOS Unix-socket-path failures in tests/host/server*.test.ts confirmed unchanged on baseline.
**Notes:** Deviations: (1) defined a local `CallToolMcpDispatcher` interface in the handler rather than reusing `McpProvider` — the legacy shape carries `{agentId,userId,sessionId}` which the catalog+handler already know; `{server,tool,args}` matches the plan's test verbatim and keeps the call site clean. (2) Adapter captures `defaultUserId` at construction — per-user credential scoping for skill MCP servers is owned by tool-batch today; documented with a caveat comment, to be unified in a later phase. (3) `call_tool` still lives in `knownInternalActions` in tests/agent/tool-catalog-sync.test.ts — graduates in Task 3.5 when the agent-side tool registers.

## [2026-04-19 19:30] — Tool dispatch Task 3.3 cleanup: drop defensive branch, abstraction leak, rename option

**Task:** Address 3 Important-severity code-quality review findings on commit d0d5293a (the Task 3.3 handler).
**What I did:** (1) Deleted the "skill-owned `_select` wins" branch in `augmentSchemaWithSelect` — catalog tools are machine-generated from MCP/OpenAPI, names are regex-constrained, no real source can declare top-level `_select`; plus that branch returned `{...schema}` without re-wrapping `properties`, leaving the handler inconsistent with its other branch (shared `properties` reference → cache-corruption risk). Removed the corresponding test. (2) Dropped the `ToolCatalog` re-export from `describe-tools.ts` so the module doesn't leak past its `CatalogReader` abstraction; moved the test import to `src/host/tool-catalog/registry.js` directly. Also removed the now-unused `ToolCatalog` import from the handler module. (3) Renamed `getCatalog` → `resolveCatalog` in `DescribeToolsDeps`, `IPCHandlerOptions`, the ipc-server registration, and the two test cases that exercise the closure form. Docstrings updated to match.
**Files touched:** src/host/ipc-handlers/describe-tools.ts (−21 lines), tests/host/ipc-handlers/describe-tools.test.ts (−25 lines), src/host/ipc-server.ts (3 lines renamed)
**Outcome:** Success — 8/8 describe-tools tests pass (was 9), 103/103 across the verify suite (describe-tools + ipc-server + tool-catalog-sync + cross-component + ipc-schemas), tsc clean.
**Notes:** `resolveCatalog` reads better than `getCatalog` because the neighboring `workspaceMap` option is literally a Map — keeping the verb distinct from the noun-shaped siblings makes the function-vs-map shape obvious without a comment. Task 3.4 (`call_tool`) will inherit the renamed option.

## [2026-04-19 19:05] — Tool dispatch Task 3.3: describe_tools IPC handler

**Task:** Implement the `describe_tools` IPC handler (Task 3.3 of the tool-dispatch-unification plan). Handler takes `{names}`, returns `{tools: [{name, summary, schema}], unknown: [string]}` with every returned schema augmented by an optional `_select` (jq projection) property.
**What I did:** Created `src/host/ipc-handlers/describe-tools.ts` with a factory `createDescribeToolsHandler({catalog?, getCatalog?})` that supports two forms — a direct `CatalogReader` (unit-test convenience, matching the plan's test shape `new ToolCatalog().register(...)`) and a per-turn `getCatalog(ctx)` closure (real-server wiring). Added `augmentSchemaWithSelect` — shallow-clones `schema` + `schema.properties` and adds `_select: {type:'string', description:'…jq…'}`, preserving any pre-existing `_select` from a skill. Also exported a small `catalogReaderFromTools(tools)` helper so the server can hand the handler a ready-made reader built from the cached `CatalogTool[]`. Added `IPCHandlerOptions.getCatalog?: (ctx) => CatalogReader | undefined` and conditional registration in `createIPCHandler` (absent getter → action falls through to default "No handler" path — right failure mode for hosts not in unified-dispatch mode). Wrote 9 tests covering: direct-catalog happy path, unknown names, `_select` augmentation shape, **non-mutation of cached schema** (the key invariant), mixed known/unknown split, skill-owned `_select` preservation, `getCatalog` closure form, no-catalog-for-turn (all unknown), factory guard.
**Files touched:** src/host/ipc-handlers/describe-tools.ts (new, 113 lines), tests/host/ipc-handlers/describe-tools.test.ts (new, 155 lines), src/host/ipc-server.ts (+11 lines: import, option, handler registration)
**Outcome:** Success — 9/9 new tests pass; tsc clean; ipc-server, tool-catalog-sync, cross-component (51/51) still green.
**Notes:** Catalog-access chosen: Option B (per-request `getCatalog(ctx)` closure). This mirrors the `workspaceMap` pattern already used for per-turn state, but via a closure instead of a raw Map — keeps the handler agnostic to how the host stores it. Wiring the closure from `processCompletion` → `createIPCHandler` is deferred until Task 3.4 lands so `describe_tools` + `call_tool` can share a single plumbing change. `tests/agent/tool-catalog-sync.test.ts` still lists `describe_tools` in `knownInternalActions` until Task 3.5 moves agent-side tool registration under TOOL_CATALOG — deliberate, matches the comment already in that file.

## [2026-04-19 18:44] — Tool dispatch Task 3.2 follow-up: register describe_tools + call_tool in knownInternalActions

**Task:** Fix CI-breaking failure in `tests/agent/tool-catalog-sync.test.ts` after commit b4be3c55 — the sync test asserts every action in `IPC_SCHEMAS` is either mapped from `TOOL_CATALOG` or listed in `knownInternalActions`, and Task 3.2 added two schemas that satisfied neither.
**What I did:** Added `'describe_tools', 'call_tool'` to `knownInternalActions` (tests/agent/tool-catalog-sync.test.ts) with a terse comment noting they graduate out of this list once Task 3.5 registers agent-side tools under TOOL_CATALOG.
**Files touched:** tests/agent/tool-catalog-sync.test.ts (+4 lines)
**Outcome:** Success — tool-catalog-sync 8/8 pass, ipc-schemas 44/44 still pass, tsc clean. Broader `tests/host/server*` failures observed in the sweep are pre-existing `listen EINVAL` Unix-socket-path issues (path too long on macOS), confirmed to fail on the pre-Task-3.2 baseline — unrelated to this work.
**Notes:** Lesson at `.claude/lessons/ipc/entries.md:66` already warns about this exact failure mode (`every IPC_SCHEMAS action has a handler` / `knownInternalActions`). I read the existing schemas before writing the fix but missed running the sync sweep. The lesson exists — the miss was mine. Future reminder: when adding an `ipcAction()`, mandatory local checks are (1) handler, (2) `knownInternalActions` if host-internal, (3) `tests/agent/tool-catalog-sync.test.ts` before committing.

## [2026-04-19 18:39] — Tool dispatch Task 3.2: describe_tools + call_tool IPC schemas

**Task:** Define Zod `.strict()` IPC action schemas for the two new host-side tool-dispatch actions (`describe_tools`, `call_tool`) as part of the tool-dispatch-unification plan.
**What I did:** Added `DescribeToolsSchema` (`names: z.array(safeString(200)).min(1)`) and `CallToolSchema` (`tool: safeString(200)`, `args: z.record(z.string(), z.unknown())`) via the existing `ipcAction()` builder. Added 12 tests in `tests/ipc-schemas.test.ts` covering accept/reject cases for both schemas (empty arrays, missing fields, strict-mode extra fields, non-string coercion, non-object args). All 44 tests pass, tsc clean.
**Files touched:** src/ipc-schemas.ts (+13 lines), tests/ipc-schemas.test.ts (+85 lines)
**Outcome:** Success — 44/44 tests pass.
**Notes:** The plan snippet used `ipcAction('x', z.object({...}).strict())` but the actual builder takes a `ZodRawShape` (field literal) and already applies `z.strictObject` internally — passed fields directly. Zod 4 `z.record` requires both key+value schemas (`z.record(z.string(), z.unknown())`) as flagged in the task brief; this matches the pre-existing `ToolBatchSchema` pattern. No handler wired yet — that's Tasks 3.3 and 3.4.

## [2026-04-17 05:58] — Phase 3 Task 2: skills_index IPC schema

**Task:** Add a Zod `.strict()` schema for a new IPC action `skills_index` (request takes no fields; handler uses `ctx.agentId`).
**What I did:** Wrote 4-case vitest TDD spec (registered, accepts empty envelope, rejects unknown fields, rejects wrong action literal); saw 2 fail as expected; added `SkillsIndexSchema = ipcAction('skills_index', {})` under the Skills section with a JSDoc documenting the (non-validated) response shape; tests green; build clean.
**Files touched:** src/ipc-schemas.ts, tests/ipc/skills-index-schema.test.ts
**Outcome:** Success — 4/4 tests pass, `npm run build` clean.
**Notes:** The `ipcAction()` helper auto-registers via the module-level registry, so no additional wiring needed. Empty-body action follows the same pattern as `FetchWorkSchema`/`SchedulerListJobsSchema`. Tests directory `tests/ipc/` didn't exist — created it.

## [2026-03-20 12:20] — Remove AX_IPC_TRANSPORT env var, auto-detect HTTP mode from AX_HOST_URL

**Task:** Remove dead NATS transport references and eliminate AX_IPC_TRANSPORT env var — HTTP mode is now auto-detected from AX_HOST_URL presence
**What I did:** Replaced all `AX_IPC_TRANSPORT` checks with `AX_HOST_URL` presence detection. Removed `AX_IPC_TRANSPORT` from k8s pod env, pool-controller pod env. Simplified workspace-release.ts to remove legacy NATS staging mode (always direct HTTP). Updated isK8sTransport/isHTTPTransport variables to check AX_HOST_URL. Renamed nats_agent_response log keys to k8s_agent_response. Updated all tests.
**Files touched:** src/agent/runner.ts, src/agent/runners/claude-code.ts, src/agent/runners/pi-session.ts, src/agent/http-ipc-client.ts, src/agent/workspace-release.ts, src/logger.ts, src/providers/sandbox/k8s.ts, src/pool-controller/k8s-client.ts, tests/agent/runner.test.ts, tests/agent/runners/claude-code.test.ts, tests/agent/workspace-release.test.ts, tests/providers/sandbox/k8s.test.ts, tests/pool-controller/k8s-client.test.ts, tests/providers/sandbox/nats-subprocess.ts, tests/providers/sandbox/docker-nats.ts
**Outcome:** Success — build passes, all 2469 tests pass
**Notes:** AX_HOST_URL was already set for k8s pods via extraSandboxEnv (server-k8s.ts) and pool-controller. The separate AX_IPC_TRANSPORT=http was redundant.

## [2026-03-17 14:50] — Fix workspace_write IPC schema rejecting session tier

**Task:** Debug why workspace_write with tier='session' never reaches host handler in K8s e2e tests
**What I did:** Traced data flow from agent through IPC to host. Found WorkspaceWriteSchema in ipc-schemas.ts restricted tier to z.enum(['agent', 'user']), silently rejecting 'session' at Zod validation before the handler was called. Added 'session' to the enum, updated tool descriptions in tool-catalog.ts and mcp-server.ts, added schema test, removed debug instrumentation.
**Files touched:** src/ipc-schemas.ts, src/agent/tool-catalog.ts, src/agent/mcp-server.ts, src/host/ipc-handlers/workspace.ts, tests/ipc-schemas-enterprise.test.ts, tests/e2e/e2e-k8s-docker.test.ts
**Outcome:** Success — build passes, all 19 tests pass
**Notes:** The schema validation failure returned a generic error back to the agent but never invoked the handler, making the debug logs in the handler useless for diagnosis.

## [2026-03-16 16:58] — Fix NATS IPC client receiving JetStream PubAck instead of IPC response

**Task:** Investigate `ipc_llm_error: undefined` in k8s sandbox pods
**What I did:** Traced the error through pi-session.ts → NATSIPCClient → NATS handler. Added diagnostic logging (`response.ok` value + `Object.keys(response)`) to determine the actual response shape. Discovered the response had `keys=[stream,seq]` — a JetStream PubAck, not the IPC response. Root cause: a JetStream stream captures the `ipc.request.>` subjects; when `nc.request()` publishes with a reply inbox, the server sends a PubAck to that inbox before the handler responds, and `nc.request()` takes the first message. Fixed by replacing `nc.request()` with manual `subscribe` + `publish` pattern that filters out JetStream PubAck responses.
**Files touched:** `src/agent/nats-ipc-client.ts`, `tests/agent/nats-ipc-client.test.ts`, `tests/agent/nats-warm-pod-flow.test.ts`
**Outcome:** Success — all 19 NATS tests pass, clean build
**Notes:** The root cause is a JetStream stream (likely a catch-all `>` stream) on the NATS server capturing IPC subjects. The fix is resilient regardless of NATS config — it skips any response with `stream`+`seq` but no `ok` field. Also added a cleanup step to the NATS stream init job that deletes any stream capturing IPC subjects (`>`, `ipc.>`, or `ipc.request.>`) to prevent recurrence.

## [2026-03-16 07:40] — Add NATS IPC round-trip integration test

**Task:** Create an integration test that verifies NATSIPCClient and startNATSIPCHandler work together end-to-end via real NATS request/reply.
**What I did:** Created `tests/integration/nats-ipc-roundtrip.test.ts` with 3 tests: sandbox_approve routing, memory_search routing, and unknown action default response. Test gracefully skips when NATS is unavailable (probes connectivity in beforeAll, returns early from each test if natsAvailable is false). Starts handler with mock handleIPC, connects client, and verifies round-trip JSON serialization.
**Files touched:** `tests/integration/nats-ipc-roundtrip.test.ts` (new)
**Outcome:** Success — all 3 tests pass (skip gracefully when NATS is not running locally).
**Notes:** Test does not start a NATS server — relies on external NATS being available. CI will skip unless NATS_URL is configured.

## [2026-03-16 07:34] — Add NATS IPC handler for host-side request routing

**Task:** Create a NATS-based IPC handler for the host side that subscribes to ipc.request.{sessionId} and routes incoming IPC requests through the existing handleIPC pipeline.
**What I did:** Created `src/host/nats-ipc-handler.ts` with `startNATSIPCHandler()` function that mirrors the pattern from `nats-llm-proxy.ts`. Subscribes to `ipc.request.{sessionId}`, decodes NATS messages, extracts optional `_sessionId`/`_agentId`/`_userId` context fields from the payload, routes through the `handleIPC` callback, and responds via NATS reply. Created comprehensive test with 10 tests covering: module export, subscribe subject, close/drain, request routing, context extraction, invalid JSON handling, custom ctx, error propagation, fire-and-forget (no reply), and connection options.
**Files touched:** `src/host/nats-ipc-handler.ts` (new), `tests/host/nats-ipc-handler.test.ts` (new)
**Outcome:** Success — all 10 tests pass.
**Notes:** Uses dynamic `import('nats')` like nats-llm-proxy.ts and nats-bridge.ts. Returns `{ close }` interface for cleanup. Wiring into agent-runtime-process.ts is a separate task.

## [2026-03-16 07:33] — Add NATS IPC client for k8s sandbox pods

**Task:** Create a NATS-based IPC client as a drop-in replacement for IPCClient when running inside k8s sandbox pods, using NATS request/reply instead of Unix sockets.
**What I did:** Created `NATSIPCClient` class in `src/agent/nats-ipc-client.ts` that matches the `IPCClient` interface (connect, call, disconnect, setContext) but communicates via NATS request/reply on `ipc.request.{sessionId}` subjects. Enriches requests with _sessionId, _requestId, _userId, _sessionScope context fields. Created comprehensive test file with 13 tests covering: request/reply flow, context enrichment, subject routing, setContext updates, timeout propagation, idempotent connect, custom NATS URL, drain on disconnect, auto-connect, and optional field omission.
**Files touched:** `src/agent/nats-ipc-client.ts` (new), `tests/agent/nats-ipc-client.test.ts` (new)
**Outcome:** Success — all 13 tests pass.
**Notes:** Uses dynamic `import('nats')` like the existing nats-bridge.ts. NATS module is already in package.json dependencies. Selected by `AX_IPC_TRANSPORT=nats` env var (wiring into runner.ts is a separate task).

## [2026-03-15 16:23] — Fix proxy.sock ENOENT race on first message after restart

**Task:** Debug `connect ENOENT proxy.sock` error on first Slack message after server restart (subsequent messages work)
**What I did:** Root cause was `createIPCServer` calling `server.listen()` without awaiting completion — socket file didn't exist yet when the first agent was spawned. Made `createIPCServer` async, returning `Promise<Server>` that resolves only after the socket is bound and accepting connections. Also moved Apple Container bridge sockets to a `bridges/` subdirectory to prevent co-location with proxy.sock.
**Files touched:** `src/host/ipc-server.ts`, `src/host/server.ts`, `src/host/agent-runtime-process.ts`, `src/providers/sandbox/apple.ts`, `tests/host/ipc-server.test.ts`
**Outcome:** Success — 76 affected tests pass, 2403/2404 full suite pass (1 pre-existing failure).
**Notes:** The race only affected the first message because subsequent messages arrived after the event loop had processed the pending listen. Apple Container agents masked the issue by using bridge.sock (reverse IPC) instead of connecting to proxy.sock directly.

## [2026-03-15 15:35] — Fix concurrent IPC call response misrouting

**Task:** Debug why the web UI showed no response when user said "hi" — agent's second LLM call returned empty text
**What I did:** Root-caused to IPC client using per-call `data` handlers on a shared socket. When pi-coding-agent executed multiple tool calls concurrently (identity x2, memory x1), all handlers received the first response, resolved, and removed themselves. Subsequent responses were misrouted to the next LLM call, which parsed an identity_read response as an LLM response (no `chunks` → empty text). Fixed by adding `_msgId` correlation: client generates a unique ID per call, host echoes it in responses/heartbeats, client routes responses by ID using a single shared data handler.
**Files touched:** `src/agent/ipc-client.ts` (major refactor: shared data handler + pending map), `src/host/ipc-server.ts` (echo `_msgId` in responses/heartbeats, strip before Zod validation), `tests/agent/ipc-client.test.ts` (added concurrent test), `tests/agent/ipc-client-reconnect.test.ts`, `tests/agent/runner.test.ts`, `tests/agent/session.test.ts`, `tests/agent/runners/pi-session.test.ts` (all mock servers updated to echo `_msgId`)
**Outcome:** Success — all 2401 tests pass (1 pre-existing unrelated failure)
**Notes:** The bug was intermittent in production because it required concurrent IPC calls (multiple tool_use in a single LLM response). Sequential tool calls worked fine.

## [2026-03-14 11:54] — Restore workspace_write IPC schema

**Task:** Add `workspace_write` IPC schema as part of lazy-sandbox decoupling effort
**What I did:** Added `WorkspaceWriteSchema` to `src/ipc-schemas.ts` using `ipcAction()` with tier (agent|user), path, and content fields. Added tests in `tests/ipc-schemas-enterprise.test.ts` for valid input and invalid tier rejection. Added `workspace_write` to enterprise actions registry test. Also added `workspace_write` to `knownInternalActions` in `tests/agent/tool-catalog-sync.test.ts` to pass sync test (will be moved to tool catalog in Task 3).
**Files touched:** `src/ipc-schemas.ts`, `tests/ipc-schemas-enterprise.test.ts`, `tests/agent/tool-catalog-sync.test.ts`
**Outcome:** Success — all targeted tests pass (20/20)
**Notes:** Schema follows existing patterns: `safeString(1024)` for path, `safeString(500_000)` for content (matching SandboxWriteFileSchema), `z.enum(['agent', 'user'])` for tier.

## [2026-03-03 02:50] — Address PR #48 review comments on ipc-schemas.ts

**Task:** Address unresolved review comment on src/ipc-schemas.ts from PR #48
**What I did:**
- Extracted duplicated agent state enum values into a shared `agentStates` const and `agentStateEnum` in `AgentOrchListSchema`
- Changed `policyTags` items from bare `z.string().max(50)` to `safeString(50)` for null-byte validation consistency
- Changed `payload` record keys from `z.string()` to `safeString(200)` for consistency with `headers` record
- Changed `eventType` from bare `z.string()` to `safeString(200)` for length/null-byte validation
- Added `.min(0)` bound to `since` number field in `AgentOrchTimelineSchema`
**Files touched:** `src/ipc-schemas.ts`
**Outcome:** Success — all 2147 tests pass (200 test files)
**Notes:** The other two PR #48 review comments (on orchestration.ts and orchestrator.ts) were already addressed by commit 2e6cf08 and marked "Outdated" on GitHub. Only ipc-schemas.ts had an unresolved comment.

## [2026-02-27 10:29] — IPC Heartbeat Keep-Alive

**Task:** Implement heartbeat mechanism for IPC so long-running operations don't time out
**What I did:**
- Server (`ipc-server.ts`): Added `HEARTBEAT_INTERVAL_MS` (15s) export and heartbeat interval around handler execution in `createIPCServer`. Server sends `{_heartbeat: true, ts}` frames during handler execution.
- Client (`ipc-client.ts`): Rewrote `onData` in `callOnce()` to process multiple frames in a `while` loop, recognize `_heartbeat` frames (reset timeout timer), and resolve on actual response. Changed `const timer` to `let timer`. Updated timeout error message to mention heartbeats.
- Tool catalog (`tool-catalog.ts`): Removed `timeoutMs` from `agent_delegate` (was 10min) and `image_generate` (was 2min) — heartbeats eliminate the need for static overrides.
- Tests: Added 4 new heartbeat tests in `ipc-client.test.ts`, 2 tests in `ipc-server.test.ts`, updated 2 tests in `ipc-tools.test.ts`.
**Files touched:** `src/host/ipc-server.ts`, `src/agent/ipc-client.ts`, `src/agent/tool-catalog.ts`, `tests/agent/ipc-client.test.ts`, `tests/host/ipc-server.test.ts`, `tests/agent/ipc-tools.test.ts`
**Outcome:** Success — all 1736 tests pass (167 test files)
**Notes:** Design mirrors openclaw pattern (tick events every 15s, 2x watchdog = 30s default client timeout). For fast operations (<15s), interval never fires — zero overhead.
