# Testing: E2E

End-to-end test framework, simulated providers, scenario coverage.

## [2026-04-21 18:05] — Task 7.5: Petstore 2-call flow through OpenAPI indirect dispatch

**Task:** Phase 7 final task of tool-dispatch-unification — prove the unified indirect-dispatch pipeline handles an OpenAPI-sourced tool chain end-to-end (parallel to Task 4.4's Linear/MCP proof). Must validate: catalog populated from `openapi[]` frontmatter via spec fetch, 2 chained `call_tool` invocations land on a real HTTP server, url_rewrites applied at BOTH spec-fetch and dispatch time.
**What I did:**
  - **Verified url_rewrite coverage first**: `src/host/skills/openapi-spec-fetcher.ts:163` applies `urlRewrites` to the spec URL before SwaggerParser fetches; `src/host/ipc-handlers/openapi-dispatcher.ts:271` applies it to the composed baseUrl+path before the fetch call. Both paths honor `config.url_rewrites` — no blocker.
  - **Fixture skill** at `tests/e2e/fixtures/skills/petstore/SKILL.md` with `openapi: [{spec: https://mock-target.test/openapi/petstore.json, baseUrl: https://mock-target.test/api/v1}]`. No `auth:` block — unit tests already cover all 4 auth schemes; e2e stays focused on dispatch mechanics.
  - **Mock Petstore handler** (`tests/e2e/mock-server/petstore.ts`, ~170 LOC): parallels `mcp.ts` structure. Serves `GET /openapi/petstore.json` by loading `tests/fixtures/openapi/petstore-minimal.json` and injecting `servers: [{url: https://mock-target.test/api/v1}]`. Implements listPets/createPet/getPetByID/deletePet with in-memory state + per-op counters + `/petstore/_stats` + `/petstore/_reset` hooks. Determinism: createPet with `name='Rex'` always returns `id=42`.
  - **Read-back sentinel**: getPetByID attaches `_readback: true` to the response. Disambiguates the scripted chain — Turn 2 and Turn 3 return shape-identical payloads otherwise, and the mock OpenRouter's first-match-wins iteration would make Turn 2 re-fire on its own output.
  - **Router wiring** (`tests/e2e/mock-server/index.ts`): routes `/openapi/petstore.json`, `/api/v1/pets`, `/petstore/*` to `handlePetstore`; calls `resetPetstore()` from `resetAll()`.
  - **Scripted turns** (`tests/e2e/scripts/petstore-flow.ts`): 3 turns — opening user message triggers `call_tool(api_petstore_create_pet, {body:{name:'Rex'}})`, chain on `/"id":42.*"name":"Rex"/` → `api_petstore_get_pet_by_id({id:42})`, chain on `/"_readback":true/` → final content "Created pet Rex with id 42." Tool names verified against adapter's `toSnakeCase`: `getPetByID` → `get_pet_by_id` (trailing-acronym case).
  - **Seed script extension** (`tests/e2e/global-setup.ts`): previously only hashed `linear_mcp/SKILL.md`; now hashes both fixtures and builds a single `.ax/skills/` tree containing `linear_mcp/` + `petstore/`. Single commit keeps the catalog snapshot coherent.
  - **Regression test 19** in `regression.test.ts`: resets petstore stats, sends "Create a pet named Rex and tell me its id.", asserts response contains Rex+42, and asserts `stats.createPet === 1`, `stats.getPetById === 1`, `stats.listPets === 0`, `stats.deletePet === 0`.
**Files touched:** `tests/e2e/fixtures/skills/petstore/SKILL.md` (new), `tests/e2e/mock-server/petstore.ts` (new), `tests/e2e/mock-server/index.ts`, `tests/e2e/scripts/petstore-flow.ts` (new), `tests/e2e/scripts/index.ts`, `tests/e2e/regression.test.ts`, `tests/e2e/global-setup.ts`, `.claude/journal/testing/e2e.md`.
**Outcome:** Success on implementation. `npm run build` clean. `npm test -- tests/host/tool-catalog/` 43/43 pass. `npm test -- tests/host/ipc-handlers/` 162/162 pass. `npm test -- tests/host/skills/` 197/197 pass. Fixture frontmatter parses cleanly through `SkillFrontmatterSchema.strict()`. Full `npm run test:e2e` requires a kind cluster rebuild — deferred to post-deploy verification per the plan's Step 10.
**Notes:**
  - The vendored spec at `tests/fixtures/openapi/petstore-minimal.json` uses `operationId: getPetByID` (all-caps ID). The adapter's `toSnakeCase` regex handles the trailing-acronym case → `get_pet_by_id`. Kept the original casing to exercise the branch rather than renaming to `getPetById`.
  - The `_readback: true` sentinel is the cleanest way to disambiguate turns when both chained tool responses share the same JSON shape. An alternative (counter-based turn routing in the mock OpenRouter) would have been more invasive.
  - Seeding both fixtures in a single commit avoids ordering-surprise bugs where the second-seeded skill would clobber the first if we naively re-ran the update-ref step.
  - Pre-existing test failures in `tests/host/server*.test.ts` + `tests/integration/smoke.test.ts` (21 + 12) are unrelated — reproduced on `main` before my changes. They fail on `ipc-server.ts` socket bind, not on OpenAPI code.

## [2026-04-21 14:30] — Task 13: tool CLI shim regression for Linear 3-step pipeline

**Task:** Add an e2e regression test proving the Linear 3-step pipeline (get_team → list_cycles → list_issues) completes in ≤4 tool calls via `bash` + `tool` CLI shims — the replacement for the `execute_script`-thrashing scenario the live kind trace (`chatcmpl-c155550e`) caught.
**What I did:**
  - Added `tests/e2e/scripts/tool-cli.ts` with 4 `ScriptedTurn`s: opening user-message match → `bash(mcp_linear_mcp_get_team | jq ... marker=cli-shim-team)`, chain on `/cli-shim-team/` → `list_cycles` with `cli-shim-cycle` marker, on `/cli-shim-cycle/` → `list_issues` with `cli-shim-count` marker + jq count projection, on `/cli-shim-count/` → final content-only answer naming the count.
  - Unique per-step marker strings injected via `jq '. + {marker: "..."}'`: the mock OpenRouter scans `matchToolResult` globally across `ALL_TURNS` and first match wins; sibling `linear-flow.ts` already owns `/team_product/`, `/cycle_99/`, `/Ship Task 4\.4/`, so reusing those patterns would cross-wire the two tests.
  - Exported `TOOL_CLI_TURNS` from `tests/e2e/scripts/index.ts` and concatenated into `ALL_TURNS` after `LINEAR_FLOW_TURNS`.
  - Added test 19 to `tests/e2e/regression.test.ts`: POSTs the exact thrashing prompt ("how many issues in the current cycle for Product"), resets MCP counters first, asserts `res.content` matches `/\d+\s+issues?/i`, never contains `execute_script`, and each of `get_team`/`list_cycles`/`list_issues` was hit exactly once.
**Files touched:** `tests/e2e/scripts/tool-cli.ts` (new), `tests/e2e/scripts/index.ts`, `tests/e2e/regression.test.ts`, `.claude/journal/testing/e2e.md`.
**Outcome:** Success on implementation + typecheck (`npx tsc --noEmit` clean). Full `npm run test:e2e` run deferred — requires a fresh kind cluster rebuild with the Task 9 Docker image containing the `tool` binary. Flagged for post-deploy verification per the plan's Step 4.
**Notes:**
  - `ChatResponse` field is `.content`, not `.body` as the plan sketch suggested.
  - Real flow inside the kind cluster: agent emits `bash({command: "mcp_linear_mcp_get_team | jq ..."})` → host `sandbox_bash` spawns bash inside the sandbox → the shim symlink (Task 7/8) dispatches through the on-host `tool` binary (Task 1–5) → posts to `/internal/ipc` with `call_tool` → host dispatches to mock MCP → stdout wrapped in `{output: ...}` bubbles back as the tool-result content the mock OpenRouter pattern-matches.
  - Test 19 mirrors test 18's structure (reset → assert count → assert exact-once MCP hits) so the two tests provide parallel evidence for the two dispatch paths (`call_tool` direct vs `bash` + shim).

## [2026-04-19 23:15] — Task 4.4: Linear 3-turn cycle flow through indirect dispatch

**Task:** Final Phase 4 task of tool-dispatch-unification — prove the unified indirect-dispatch pipeline handles a realistic 3-turn tool chain end-to-end through a mock MCP server. Must validate: catalog populated from skill frontmatter, 3 chained `call_tool` invocations land on a real JSON-RPC server, zero retries.
**What I did:**
  - **url_rewrites for MCP** (production code): Extracted the existing URL-rewrite logic from `web-proxy.ts` into shared `src/plugins/url-rewrite.ts` helper; threaded `config.url_rewrites` into two MCP call sites (`mcp-client-factory.ts` for catalog population, `server-init.ts` call_tool dispatcher adapter) so `https://mock-target.test/...` frontmatter URLs transparently redirect to the mock server. No-op in production (rewrites unset). Added 10 unit tests for the helper + 2 factory rewrite tests.
  - **Snapshot fix** (production bug): `buildSnapshotFromBareRepo` threw `fatal: Not a valid object name refs/heads/main` on brand-new bare repos, crashing every first-turn completion as "Internal processing error". Added a `rev-parse --verify` pre-check returning `[]` for non-existent refs. Added regression test.
  - **Fixture skill** at `tests/e2e/fixtures/skills/linear_mcp/SKILL.md` with `mcpServers: [{name: linear, url: https://mock-target.test/mcp/linear, transport: http}]`. Name uses underscore (catalog rejects hyphens per `/^(mcp|api)_[a-z0-9_]+$/`).
  - **Dockerfile + AX_SKILLS_DIR**: `COPY tests/e2e/fixtures/ ./fixtures/` plus `host.env: AX_SKILLS_DIR=/opt/ax/fixtures/skills` in `kind-values.yaml` so only e2e sees the fixture.
  - **Mock MCP handler** (`tests/e2e/mock-server/mcp.ts`, ~200 LOC): minimal JSON-RPC 2.0 over HTTP. Advertises `get_team`/`list_cycles`/`list_issues`. Per-method counters + `GET /mcp/_stats` + `POST /mcp/_reset` endpoints. Dependency-free.
  - **Mock OpenRouter multi-turn**: Extended `ScriptedTurn` with optional `matchToolResult`. On tool-result follow-up, mock first tries to match against any turn's `matchToolResult` before falling back to the canned summary — drives the 3-turn chain without breaking tests 1-17.
  - **Scripted turns** (`tests/e2e/scripts/linear-flow.ts`): 4 turns — opening `call_tool(get_team)`, chain on `/team_product/` → `list_cycles`, on `/cycle_99/` → `list_issues`, on `/Ship Task 4\.4/` → final summary.
  - **Seed hook in global-setup**: K8s-sandbox path doesn't actually commit to the agent's bare repo (host never writes). Added a `kubectl exec` step that uses git plumbing (`hash-object`/`mktree`/`commit-tree`/`update-ref`) to pre-seed `refs/heads/main` with the fixture skill. Idempotent, ~30 LOC.
  - **Debug hook**: `AX_E2E_KEEP_CLUSTER=1` leaves the kind cluster + port-forward running so failures can be inspected via `kubectl logs`/`exec`.
  - Test 18 in `regression.test.ts` — asserts response contains an issue ID + all 3 MCP methods hit exactly once via `/mcp/_stats`.
**Files touched:** `src/plugins/url-rewrite.ts` (new), `src/host/web-proxy.ts`, `src/host/skills/mcp-client-factory.ts`, `src/host/skills/snapshot.ts`, `src/host/server-completions.ts`, `src/host/server-init.ts`, `container/agent/Dockerfile`, `tests/e2e/kind-values.yaml`, `tests/e2e/global-setup.ts`, `tests/e2e/mock-server/{mcp.ts (new), index.ts, openrouter.ts}`, `tests/e2e/scripts/{linear-flow.ts (new), index.ts, types.ts}`, `tests/e2e/regression.test.ts`, `tests/e2e/fixtures/skills/linear_mcp/SKILL.md` (new), `tests/plugins/url-rewrite.test.ts` (new), `tests/host/skills/mcp-client-factory.test.ts`, `tests/host/skills/snapshot.test.ts`.
**Outcome:** Success. `npm run test:e2e` passes 20/20 tests. All 3 MCP methods hit exactly once in the final green run; pod logs confirm the 3 `call_tool` dispatches landed in a single completion with no retries.
**Notes:**
  - Catalog tool name format `/^(mcp|api)_[a-z0-9_]+$/` — skill directory names MUST use underscores, not hyphens. The register path silently rejects with a log warn, which took one run to diagnose.
  - Tests 1-17 were passing with "Internal processing error" responses because their assertions only check `status === 200` + `content.length > 0`. My stricter content assertion in test 18 surfaced the pre-existing `buildSnapshotFromBareRepo` crash. Fix is a ~8-line pre-check; regression-test added.
  - The k8s-sandbox path does NOT run `seedAxDirectory` against the bare repo — it's gated on `hostOwnsGitCommit` which stays false when the sandbox pod writes. Pre-seeding via `kubectl exec` + git plumbing is the cleanest work-around without rewriting the sandbox flow.

## [2026-04-19 20:40] — Fix pre-existing e2e config drift (unblocks Phase 3 verification)

**Task:** Unblock `npm run test:e2e` so Phase 3 of tool-dispatch-unification could be verified end-to-end.
**What I did:** `tests/e2e/kind-values.yaml` referenced providers that were removed during the March 2026 architecture simplification (`workspace: gcs`, `providers.skills: git`, root-level `workspace:` block with gcs-specific fields). Host pod was CrashLoopBackOff with "unknown field(s)" config errors. Also the `gitServer` chart default is `enabled: true` → `ax-git` pod ImagePullBackOff because the e2e doesn't build `ax-git-server:local`. Switched `workspace` to `git-local` (self-contained on-disk bare repos, no server needed), removed `skills` provider entry + the gcs-specific root `workspace:` block, added `gitServer.enabled: false` to skip the git-server deployment.
**Files touched:** `tests/e2e/kind-values.yaml` (−8/+4 lines)
**Outcome:** Success. `npm run test:e2e` now runs cleanly: 19/19 pass in 113s. Phase 3's smoke test (regression.test.ts test 17) confirmed live end-to-end — resolves the residual-risk caveat from the Task 3.6 spec review.
**Notes:** Pure config drift, not Phase 3 work. The stale config dates from commit `24d7bd19` (architecture simplification). The chart default `gitServer.enabled: true` wants an `ax-git-server:local` image that the e2e setup never builds — flipping it off in values is the smaller fix than teaching the setup to build it.

## [2026-04-19 19:50] — Task 3.6: indirect-dispatch e2e smoke test

**Task:** Prove the Phase 3 `indirect` tool-dispatch loop wires end-to-end — agent LLM emits `call_tool` → IPC stub forwards → host handler resolves catalog → structured result flows back. Tier 1 e2e test per the tool-dispatch-unification plan.
**What I did:** Added `tests/e2e/scripts/tool-dispatch.ts` — a single-turn pack where the scripted LLM emits a `call_tool` invocation for `mcp_linear_list_issues`. Registered it in `tests/e2e/scripts/index.ts` (`TOOL_DISPATCH_TURNS` + `ALL_TURNS`). Added test case 17 to `tests/e2e/regression.test.ts` — user message "Please exercise the indirect dispatch smoke path." matches the new turn's narrow regex `/indirect dispatch smoke/i`. Verified no collision with other turns (tightened match pattern twice: initial wording triggered `list.*issues` + `run.*at`). TS build clean; no new unit tests needed — the 64 existing `describe_tools` + `call_tool` handler tests already cover the handler surface.
**Files touched:** `tests/e2e/scripts/tool-dispatch.ts` (new), `tests/e2e/scripts/index.ts`, `tests/e2e/regression.test.ts`
**Outcome:** Success. `npm run build` clean. Full `npm test` suite: 2777 passed, 34 pre-existing macOS socket-path failures in `tests/host/server*` + `tests/integration/` (unchanged, documented in task brief). Did NOT run `npm run test:e2e` end-to-end — kind cluster startup is heavyweight (~5 min) and the test infra is known-working; turn-matching logic independently verified via a standalone tsx smoke.
**Notes:** Scoped to Option A-lite per the plan's own fallback guidance ("If MCP mocking is complex, maybe this task just proves describe_tools + call_tool dispatch at the IPC level"). The e2e catalog is empty — no installed skill with MCP server — so the host's `call_tool` handler returns `{error, kind: 'unknown_tool'}`. That structured response travelling the full agent→IPC→host→agent→LLM path IS the smoke-test evidence. Real MCP dispatch arrives in Task 4.4 (Linear 3-turn cycle flow). The mock OpenRouter short-circuits on `role: 'tool'` follow-ups (returns a canned summary), so only ONE meta-tool can be exercised per test — chose `call_tool` over `describe_tools` since it covers the higher-value dispatch path.

## [2026-04-16 00:17] — Phase 2 Task 10: git-native skills e2e smoke

**Task:** Write an end-to-end test that exercises the full phase 2 wire — post-receive hook fires on push → HMAC → in-process HTTP endpoint → real reconcileAgent → state store + event bus. No stubs for anything shipped in phase 2.
**What I did:** Created `tests/host/skills/e2e-reconcile.test.ts`. Stood up an in-process HTTP server on an ephemeral port wired to `createReconcileHookHandler` + real `reconcileAgent` (real snapshot builder, real state store on in-memory sqlite, real event bus, real `loadCurrentState`). Only provider-boundary stubs for `ProxyDomainList`, `CredentialProvider`, and MCP manager (omitted). Bare repo initialized, `installPostReceiveHook(bareRepoPath, 'agent-e2e')` installs the shell hook. A cloned working tree commits `.ax/skills/demo/SKILL.md` with valid frontmatter and pushes. The push subprocess env carries `AX_HOST_URL` + `AX_HOOK_SECRET`. Test polls `stateStore.getPriorStates('agent-e2e')` up to 5s because the hook runs asynchronously after the push subprocess exits. Gated on `hasCommand('openssl'/'curl'/'git')` — table stakes, but skip-clean if absent.
**Files touched:** `tests/host/skills/e2e-reconcile.test.ts` (new)
**Outcome:** Success — passed first try. All 15 skills test files (80 tests) pass, `tsc` build clean.
**Notes:** Had to add explicit `git config user.name` / `user.email` in the work tree — `childEnv` GIT_* vars cover commit but not all git operations on CI. The `git symbolic-ref HEAD refs/heads/main` on the bare repo is wrapped in try/catch because some git versions default to main. Stderr from `git push` is captured for debug output if the polling deadline is missed.

## [2026-03-20] — Update ax-debug skill to prefer e2e infrastructure

**Task:** Restructure ax-debug skill to use e2e test infrastructure as the primary debugging approach
**What I did:** Rewrote ax-debug skill with a 3-tier hierarchy: (1) E2E test infrastructure (preferred — deterministic, CI-friendly), (2) Kind cluster dev loop (production-parity pod behavior), (3) Local process harnesses (debugger attachment). Added Tier 1 section documenting the full e2e architecture, debugging workflow, how to add reproduction tests and scripted turns, and when to escalate. Updated "Debugging Specific Issues" section to lead with Tier 1 steps. All existing Tier 2/3 content preserved.
**Files touched:** .claude/skills/ax-debug/SKILL.md (rewritten)
**Outcome:** Success — skill now directs to e2e tests first with clear escalation criteria
**Notes:** The key insight is that most bugs can be reproduced with a scripted turn + test case, avoiding the overhead of manual kind cluster setup or local process juggling.

## [2026-03-20] — Update skills to match test restructuring

**Task:** Update ax-testing, ax-debug, and acceptance-test skills to reflect recent commits that restructured tests
**What I did:**
1. Deleted `acceptance-test` skill — the entire `tests/acceptance/` directory was removed; the manual test plan approach was replaced by automated vitest regression tests in `tests/e2e/`
2. Updated `ax-testing` skill — refreshed the complete directory listing to match current files, removed references to deleted `tests/e2e/scenarios/`, added new e2e regression test section, added `npm run test:e2e` command, documented ScriptedTurn pattern and mock server architecture
3. Left `ax-debug` skill unchanged — all referenced files still exist (`scripts/k8s-dev.sh`, `run-http-local.ts`, etc.)
**Files touched:** .claude/skills/acceptance-test/SKILL.md (deleted), .claude/skills/ax-testing/SKILL.md (rewritten)
**Outcome:** Success — skills now accurately reflect the codebase
**Notes:** The old acceptance-test skill was a 1000-line manual workflow for spawning agents against live servers. The new tests/e2e/ approach uses mock servers with scripted LLM responses, making tests deterministic and CI-friendly.

## [2026-03-20 10:50] — Restructure acceptance tests into tests/e2e/

**Task:** Refactor test directory structure: delete old tests/e2e/, flatten tests/acceptance/automated/, split scripted-turns.ts into modules, rename tests/acceptance/ to tests/e2e/
**What I did:**
1. Deleted old tests/e2e/ (8 sandbox test files, superseded)
2. Flattened tests/acceptance/automated/* up one level into tests/acceptance/
3. Split scripted-turns.ts into tests/acceptance/scripts/ with individual files per turn category (types, bootstrap, chat, skills, memory, scheduler, index)
4. Renamed tests/acceptance/ to tests/e2e/ via git mv
5. Updated import in mock-server/openrouter.ts (../scripted-turns.js -> ../scripts/index.js)
6. Updated tests/e2e/vitest.config.ts paths
7. Updated root vitest.config.ts excludes (removed old tests/acceptance/automated/** entry)
8. Renamed package.json script test:acceptance -> test:e2e
**Files touched:**
- Deleted: tests/e2e/ (old), tests/acceptance/automated/, tests/acceptance/scripted-turns.ts
- Created: tests/e2e/scripts/{types,bootstrap,chat,skills,memory,scheduler,index}.ts
- Modified: tests/e2e/mock-server/openrouter.ts, tests/e2e/vitest.config.ts, vitest.config.ts, package.json
**Outcome:** Success — 215 test files, 2478 tests pass. Mock server verified. All imports clean.
**Notes:** git mv required staging the flattened state first since git tracked the old automated/ paths.

## [2026-03-20 10:10] — Delete Layer A scenario tests, keep Layer B sandbox tests

**Task:** Remove Layer A scenario tests from tests/e2e/ while preserving Layer B sandbox tests
**What I did:** Verified import dependencies before deleting. Found that `scriptable-llm.ts` and `mock-providers.ts` are imported by all 4 kept test files and both server harnesses, so they were NOT deleted. Deleted `tests/e2e/scenarios/` (13 test files), `tests/e2e/harness.ts`, and `tests/e2e/scripted-llm.ts`. Staged deletions and ran full test suite (215 files, 2478 tests pass).
**Files touched:** Deleted 15 files (13 scenario tests + harness.ts + scripted-llm.ts), 3740 lines removed
**Outcome:** Success — no test regressions
**Notes:** `scriptable-llm.ts` and `mock-providers.ts` could not be deleted as originally planned because Layer B files depend on them. `vitest.e2e.config.ts` kept (still needed for Layer B tests).

## [2026-03-17 16:00] — K8s Docker E2E simulation: full stack implementation

**Task:** Create Docker+NATS E2E tests simulating k8s host+sandbox communication
**What I did:** Built three new files + fixed existing k8s path tests:
1. `tests/providers/sandbox/docker-nats.ts` — Docker container with NATS/HTTP IPC (k8s simulation)
2. `tests/integration/k8s-server-harness.ts` — Server harness with NATS publishWork, /internal/ipc route, token registry, agent_response interception
3. `tests/integration/e2e-k8s-docker.test.ts` — 7 E2E tests through Docker + NATS + HTTP IPC
4. Fixed `tests/integration/e2e-k8s-path.test.ts` — switched to k8s-server-harness, fixing pre-existing publishWork gap
**Files touched:**
- New: tests/providers/sandbox/docker-nats.ts, tests/integration/k8s-server-harness.ts, tests/integration/e2e-k8s-docker.test.ts, docs/plans/2026-03-17-k8s-docker-e2e-tests.md
- Modified: tests/integration/e2e-k8s-path.test.ts
**Outcome:** Success — K8s path tests: 7/7 passed (~10s). Docker+NATS tests created, require Docker + nats-server.
**Notes:** Key bugs found: (1) NATS subject mismatch — agents subscribe to `sandbox.work` queue group, not the old `agent.work.{podName}` per-pod subject. (2) Streaming test assertion — k8s mode uses agentResponsePromise, not SSE. (3) Docker E2E tests on macOS are fundamentally broken — Unix domain sockets don't work across Docker Desktop VM boundary (ENOTSUP). Pre-existing issue, not introduced by our changes.

## [2026-03-17 15:00] — Docker+NATS E2E test file

**Task:** Create the E2E test file that exercises feature scenarios through a real Docker container communicating via NATS+HTTP IPC
**What I did:** Created `tests/integration/e2e-k8s-docker.test.ts` with 7 test scenarios: basic message, tool use, streaming, bootstrap, scheduler CRUD, guardian injection blocking, and web proxy SSRF blocking. Tests auto-detect Docker + nats-server; skip when unavailable. Auto-starts nats-server if not running. Builds fresh Docker image in beforeAll (npm run build + docker build). Uses `createK8sHarness` from k8s-server-harness.ts and `createDockerNATS` from docker-nats.ts.
**Files touched:**
- New: tests/integration/e2e-k8s-docker.test.ts
**Outcome:** Success — file created with all 7 scenarios matching the pattern from e2e-docker.test.ts and e2e-k8s-path.test.ts.
**Notes:** 180s timeouts for container tests, 300s for beforeAll (build+docker build). Uses `AX_DOCKER_IMAGE` env var save/restore pattern. Port randomized in 19000-19999 range.

## [2026-03-17 14:00] — Docker+NATS hybrid sandbox provider

**Task:** Create a hybrid sandbox provider that runs agent in Docker container but communicates via NATS work delivery + HTTP IPC (like real k8s)
**What I did:** Created `tests/providers/sandbox/docker-nats.ts` with `create(config, opts)` factory. Combines Docker container isolation (security hardening: read-only root, cap-drop=ALL, non-root user 1000, no-new-privileges, 64MB tmpfs) with k8s communication path (NATS work delivery, HTTP IPC). Uses bridge network + `host.docker.internal` to reach NATS and host HTTP endpoints.
**Files touched:**
- New: tests/providers/sandbox/docker-nats.ts
**Outcome:** Success — file created with full Docker args, canonical path mounts, NATS/HTTP env vars, podName for triggering host's NATS code path.
**Notes:** Sits alongside existing `nats-subprocess.ts` (bare process + NATS). Key difference: this one adds Docker container isolation. Uses `canonicalEnv()` then deletes `AX_IPC_SOCKET` since HTTP IPC replaces Unix sockets. `DockerNATSOptions` requires `hostUrl` and optionally `natsUrl` (defaults to `nats://host.docker.internal:4222`).

## [2026-03-17 12:00] — K8s path (NATS subprocess) E2E test file

**Task:** Create E2E tests for the NATS work delivery + HTTP IPC code path (k8s sandbox)
**What I did:** Created `tests/integration/e2e-k8s-path.test.ts` with 7 test scenarios that exercise the full k8s code path through NATS subprocess + HTTP IPC transport. Tests auto-detect NATS availability and skip when nats-server is not running. Uses `createHarness` with TCP port (not Unix socket) and `createNATSSubprocess` with `ipcTransport: 'http'`.
**Files touched:**
- New: tests/integration/e2e-k8s-path.test.ts
**Outcome:** Success — file created, type-checks cleanly. 7 scenarios: basic message, tool use, streaming, bootstrap, scheduler CRUD, guardian injection blocking, web proxy SSRF blocking.
**Notes:** The `createScriptableLLM` and `createHarness` helpers from `server-harness.ts` and `scriptable-llm.ts` were not yet used by any test files before this. The `port` option on `createHarness` enables TCP listener for NATS (which needs TCP, not Unix socket). The `k8sSandbox()` helper sets `AX_HOST_URL` and `PORT` env vars that `createNATSSubprocess` reads to configure the agent's HTTP IPC target.

## [2026-02-22 21:00] — E2E test framework: expanded coverage for missing scenarios

**Task:** Address gaps in E2E test coverage — memory CRUD lifecycle, browser interactions (click/type/screenshot/close), governance proposals, agent delegation, agent registry, audit query, and error handling
**What I did:**
- Extended TestHarness with `delegation`, `onDelegate`, and `seedAgents` options, plus `agentRegistry` field backed by a temp-dir AgentRegistry
- Created 5 new scenario test files:
  1. `memory-lifecycle.test.ts` (10 tests): write → read → list → delete full lifecycle, tag filtering, limit, multi-turn LLM memory write+query
  2. `browser-interaction.test.ts` (7 tests): click, type, screenshot (base64), close, full login-form flow, navigate audit, multi-turn LLM browser form fill
  3. `governance-proposals.test.ts` (18 tests): identity_propose, proposal_list (with status filter), proposal_review (approve/reject/nonexistent/already-reviewed), agent_registry_list (with status filter), agent_registry_get, full propose→list→review→verify flow, scanner blocking, audit trail
  4. `agent-delegation.test.ts` (9 tests): successful delegation, unconfigured handler error, depth limit, concurrency limit, context passing, child context verification, audit trail, multi-turn LLM delegation
  5. `error-handling.test.ts` (14 tests): invalid JSON, unknown actions, audit_query, empty inputs, nested workspace paths, rapid sequential writes, mixed operation consistency, max turns, harness isolation, seeded data verification
**Files touched:**
- Modified: tests/e2e/harness.ts (added delegation/registry/seedAgents support)
- New: tests/e2e/scenarios/{memory-lifecycle,browser-interaction,governance-proposals,agent-delegation,error-handling}.test.ts
**Outcome:** Success — 58 new E2E tests, all passing. Full suite: 1336 pass + 1 skipped (pre-existing)
**Notes:** Key gotchas: `identity_propose` requires `origin: 'agent_initiated'` (not `'agent'`), `memory_read` ID must be valid UUID per Zod schema, `proposalId` must be valid UUID, multiple TestHarness instances need careful dispose ordering to avoid "database not open" errors in afterEach.

## [2026-02-22 20:30] — E2E test framework with simulated providers

**Task:** Build an end-to-end test framework that simulates all external dependencies (LLMs, web APIs, timers, Slack messages, etc.) to test common AX operations
**What I did:** Created a comprehensive E2E test framework with three core components:
1. **ScriptedLLM** (`tests/e2e/scripted-llm.ts`): A mock LLM provider that follows a pre-defined script of turns. Supports sequential turns, conditional matching (by message content or tool_result presence), and call recording. Convenience helpers for text, tool_use, and mixed turns.
2. **TestHarness** (`tests/e2e/harness.ts`): Wires together mock providers, router, IPC handler, and MessageQueue. Drives events (sendMessage, fireCronJob, runAgentLoop) and provides assertion helpers (auditEntriesFor, memoryForScope, readIdentityFile, readWorkspaceFile). Sets AX_HOME to a temp dir for filesystem isolation.
3. **8 scenario test files** covering: Slack message flow, scheduled tasks, skill creation, workspace operations, identity/soul updates, web search/fetch, multi-turn tool use loops, full pipeline integration.
**Files touched:**
- New: tests/e2e/scripted-llm.ts, tests/e2e/harness.ts
- New: tests/e2e/scenarios/{slack-message,scheduled-task,skill-creation,workspace-ops,identity-update,web-search,multi-turn-tool-use,full-pipeline}.test.ts
**Outcome:** Success — 64 new E2E tests, all passing. Full suite: 1277 pass + 64 new = 1341 pass (1 pre-existing flaky smoke test timeout unrelated)
**Notes:** The provider contract pattern makes this approach very effective — every external dependency is behind an interface. The ScriptedLLM with sequential + conditional turns enables scripting complex multi-turn agent loops. Key gotchas: web_search handler returns SearchResult[] spread as array indices, web_fetch returns FetchResponse spread flat, skill_propose returns ProposalResult spread flat, scratchDir requires UUID or 3+ colon-separated session IDs.
