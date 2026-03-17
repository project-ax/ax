# Workspace Provider Journal

## [2026-03-16 21:10] — Fix k8s workspace file syncing to GCS via NATS IPC

**Task:** Files written to /workspace/scratch, /workspace/user, and /workspace/agent inside k8s sandbox pods never got synced back to the GCS bucket. RemoteTransport.diff() read from an empty _staging/ prefix, and pods have no network.
**What I did:** Rewrote RemoteTransport to store changes from setRemoteChanges() and return them from diff(). Added workspace_release IPC schema for agent→host file transfer. Created agent-side workspace-release.ts that diffs scope dirs, base64-encodes files, and sends via chunked IPC. Integrated into both claude-code and pi-session runners before agent_response. Added host-process interception of workspace_release in wrappedHandleIPC. Added RemoteFileChange type and optional setRemoteChanges to WorkspaceProvider interface.
**Files touched:** src/ipc-schemas.ts, src/providers/workspace/types.ts, src/providers/workspace/gcs.ts, src/agent/workspace-release.ts (new), src/agent/runners/claude-code.ts, src/agent/runners/pi-session.ts, src/host/host-process.ts, tests/providers/workspace/gcs-remote-transport.test.ts (new), tests/agent/workspace-release.test.ts (new), tests/agent/tool-catalog-sync.test.ts
**Outcome:** Success — 213 test files, 2492 tests pass (all new tests included)
**Notes:** Changes flow: agent pod diffs workspace dirs → base64-encodes → sends workspace_release IPC → host decodes + stores via setRemoteChanges → workspace.commit() picks up via RemoteTransport.diff() → structural filter + scanner → GCS upload. Chunking at ~800KB keeps within NATS 1MB limit. Pod starts with empty emptyDir volumes so baseHashes is empty Map (every file is "new").

## [2026-03-13 14:50] — Wire workspace provider directories into sandbox as writable mounts

**Task:** Close the gap where workspace provider directories (System 2) were not mounted into the sandbox, making them unreachable from the agent process. The removed workspace_write tool had masked this gap.
**What I did:** Extended WorkspaceProvider.mount() with MountOptions (userId param) for proper user scope resolution. Added workspaceMountsWritable flag to SandboxConfig. Updated server-completions.ts to pre-mount agent+user scopes via workspace provider before sandbox spawn and use those paths (rw) instead of legacy enterprise paths (ro). Updated all 5 sandbox providers: docker (:ro→:rw conditional), bwrap (--ro-bind→--bind conditional), nsjail (--bindmount_ro→--bindmount conditional), seatbelt (new AGENT_WORKSPACE_RW/USER_WORKSPACE_RW params), subprocess (symlinks already work since host dirs are writable). Updated seatbelt policy with conditional write rules. Added 9 new tests (3 for MountOptions userId, 6 for writable mount verification).
**Files touched:** src/providers/workspace/types.ts, src/providers/workspace/shared.ts, src/providers/workspace/none.ts, src/providers/sandbox/types.ts, src/providers/sandbox/docker.ts, src/providers/sandbox/bwrap.ts, src/providers/sandbox/nsjail.ts, src/providers/sandbox/seatbelt.ts, src/providers/sandbox/canonical-paths.ts, src/host/server-completions.ts, src/host/ipc-handlers/workspace.ts, policies/agent.sb, tests/sandbox-isolation.test.ts, tests/providers/workspace/shared.test.ts
**Outcome:** Success — 206 test files, 2432 tests pass (9 new tests added)
**Notes:** When workspace provider is 'none', falls back to legacy enterprise paths mounted read-only (existing behavior). When active, workspace provider's commit() validates all changes at end-of-turn. The seatbelt policy uses /dev/null for writable workspace params when not active, so (subpath "/dev/null") matches nothing useful.

## [2026-03-13 14:01] — Remove workspace_write tool (FIX-2/FIX-4)

**Task:** Remove the `workspace_write` and `workspace_write_file` IPC actions and tool, since the workspace provider's mount/diff/commit pipeline makes them redundant and they bypassed structural checks (FIX-2).
**What I did:** Removed workspace_write/workspace_write_file from: IPC schemas, IPC handlers, tool catalog (workspace category + hasWorkspaceTiers), agent-setup, prompt types/runtime module (Storage Tiers section), MCP server, manifest generator, skill format parser permission map. Deleted 3 test files (workspace.test.ts, workspace-file.test.ts, workspace-ops.test.ts). Updated 8 test files (tool-catalog, ipc-tools, mcp-server, enterprise-runtime, runtime, ipc-schemas-enterprise, error-handling, sandbox-isolation).
**Files touched:** src/ipc-schemas.ts, src/host/ipc-handlers/workspace.ts, src/agent/tool-catalog.ts, src/agent/agent-setup.ts, src/agent/prompt/types.ts, src/agent/prompt/modules/runtime.ts, src/agent/mcp-server.ts, src/utils/manifest-generator.ts, src/utils/skill-format-parser.ts, src/host/server-channels.ts, tests/* (8 updated, 3 deleted)
**Outcome:** Success — 206 test files, 2423 tests pass
**Notes:** agentWorkspace/userWorkspace config fields retained — still used by sandbox providers for read-only mounts. The workspace provider's commit pipeline is now the only write path. FIX-4 resolved implicitly since the tool is gone entirely.

## [2026-03-13 13:15] — Local acceptance test execution

**Task:** Run all 17 workspace acceptance tests (ST-1 through ST-9, BT-1 through BT-5, IT-1 through IT-3) in a local environment.
**What I did:** Set up isolated TEST_HOME, patched ax.yaml with workspace: local, ran all structural tests by reading source code, started server and ran behavioral and integration tests. Discovered critical bug: workspaceProvider field not parsed from stdin payload in agent runner, preventing workspace_mount tool from being registered. Also found that workspace_write handler bypasses the commit pipeline (structural limits, ignore patterns not enforced on direct writes).
**Files touched:** Created tests/acceptance/workspace/results-local.md
**Outcome:** 9/17 passed (9 PASS, 3 FAIL, 5 PARTIAL). All structural tests pass. Behavioral/integration tests impacted by the workspaceProvider parsing bug and the workspace_write bypass of commit pipeline.
**Notes:** Two bugs to fix: (1) src/agent/runner.ts parseStdinPayload() missing workspaceProvider extraction + main entry point missing assignment. (2) workspace_write handler should enforce structural limits from config.workspace before writing.

## [2026-03-13] — Update acceptance test plan for GCS backend

**Task:** Update workspace acceptance test plan now that gcs.ts backend is implemented.
**What I did:** Added ST-9 (GCS backend structural verification: createGcsBackend export, lazy SDK import, mount downloads from GCS, commit uploads to GCS, GcsBucketLike interface, safePath usage, bucket config requirement). Updated ST-3 to verify all three source files exist on disk. Updated k8s environment notes to distinguish kind (uses local backend) from GKE production (uses gcs backend). Added GKE production environment section. Updated acceptance criteria list (now 19 items, was 18). Corrected "GCS not yet implemented" language throughout. Test count: 17 (ST: 9, BT: 5, IT: 3).
**Files touched:** Modified tests/acceptance/workspace/test-plan.md
**Outcome:** Success — test plan reflects current implementation state.
**Notes:** K8s kind tests still use `workspace: local` since kind clusters don't have GCS. The GCS backend is verified structurally (ST-9) and via its 20 unit tests, but not via behavioral acceptance tests (would require a real GCS bucket).

## [2026-03-13 11:42] — Add GCS workspace backend

**Task:** Implement GCS workspace backend per the design plan section 9 (`gcs` — Google Cloud Storage).
**What I did:** Added `@google-cloud/storage` dependency. Added `bucket` and `prefix` fields to `WorkspaceConfig` in types.ts. Created `src/providers/workspace/gcs.ts` with `createGcsBackend()` (exported for testing) and `create()` factory. Created `tests/providers/workspace/gcs.test.ts` with 20 tests using an in-memory mock GCS bucket. TDD approach: wrote tests first (RED), verified failure, then implemented (GREEN).
**Files touched:** package.json (dep), src/providers/workspace/types.ts, src/providers/workspace/gcs.ts (new), tests/providers/workspace/gcs.test.ts (new)
**Outcome:** Success — 20 new tests pass, all 2449 tests in full suite pass (209 files).
**Notes:** The `createGcsBackend()` accepts a `GcsBucketLike` interface for testability — tests pass a Map-backed mock. The GCS SDK is lazily imported in `create()` to avoid requiring it when other backends are used. Diff logic reuses the same snapshot approach as the local backend (hash-based). The provider-map already had the `gcs` entry from the integration step.

## [2026-03-13] — Design workspace provider acceptance test plan

**Task:** Create acceptance test plan for the workspace provider covering both local and k8s environments.
**What I did:** Read the design plan (docs/plans/2026-03-13-workspace-provider-design.md), all 4 implementation files, 3 unit test files, IPC schemas, IPC handler, tool catalog, server-completions lifecycle, and both local/k8s acceptance fixtures. Designed 16 tests: 8 structural (interface shape, provider-map, registry, IPC schema, tool catalog, orchestration defaults, IPC handler wiring), 5 behavioral (mount via chat, write+persist, none disables tools, oversized file rejection, ignore pattern filtering), 3 integration (cross-session persistence, additive scope escalation, host auto-mount of remembered scopes). Included full k8s execution plan using `workspace: local` on the host pod (GCS backend not yet implemented). Documented fixture changes, config patching strategy, side-effect checks for both environments, and the execution architecture.
**Files touched:** Created tests/acceptance/workspace/test-plan.md
**Outcome:** Success — comprehensive test plan ready for review and execution.
**Notes:** K8s uses `workspace: local` (not gcs) since gcs backend is unimplemented. The local backend runs on the host pod's ephemeral filesystem, which is fine for acceptance tests but NOT for production. BT-3 (none provider test) requires a separate server/namespace since it needs a different config. BT-4 needs `maxFileSize: 100` override for testability.

## [2026-03-13 10:47] — Add comprehensive workspace provider tests

**Task:** Write tests for none.ts, shared.ts, and local.ts workspace providers in tests/providers/workspace/.
**What I did:** Created 3 test files with 52 total tests: none.test.ts (7 tests: empty returns, no-op behavior, session independence), shared.test.ts (27 tests: scope tracking, structural checks for size/count/commit-size/ignore/binary, scanner integration with mock ScannerProvider, commit result shapes, cleanup behavior, config defaults), local.test.ts (18 tests: mount directory creation, idempotent mount, safePath traversal protection, diff detection for add/modify/delete, commit persistence and re-snapshot, full lifecycle with cross-session persistence).
**Files touched:** Created tests/providers/workspace/{none.test.ts, shared.test.ts, local.test.ts}
**Outcome:** Success — all 52 tests pass. Used real filesystem with tmpdir for local.test.ts, mocked backend/scanner for shared.test.ts.
**Notes:** Followed existing test patterns (vitest, .js extension imports, Config cast, tmpdir+randomUUID for temp dirs). The shared.test.ts tests exercise both structural filter layers and scanner integration by injecting mock backends that return controlled FileChange arrays.

## [2026-03-13] — Integrate workspace provider into AX infrastructure

**Task:** Wire the workspace provider into 7 integration points: types, provider-map, IPC schemas, agent tools, host IPC handler, host turn lifecycle, and config defaults.
**What I did:** Added WorkspaceProvider to ProviderRegistry and Config types. Added workspace category (none/local/gcs) to provider-map.ts with WorkspaceProviderName type. Added WorkspaceMountSchema + WorkspaceWriteSchema + WorkspaceWriteFileSchema to ipc-schemas.ts. Added workspace_scopes tool category and workspace_mount tool to tool-catalog.ts with hasWorkspaceScopes filter. Added workspace_mount to mcp-server.ts. Expanded workspace IPC handler with mount logic. Added workspace to registry.ts provider loading. Integrated workspace lifecycle (auto-mount, commit, cleanup) into server-completions.ts. Added workspace config block with defaults to config.ts. Updated 12 test files with workspace mocks and adjusted tool counts (14->15).
**Files touched:** src/types.ts, src/host/provider-map.ts, src/ipc-schemas.ts, src/agent/tool-catalog.ts, src/agent/agent-setup.ts, src/agent/runner.ts, src/agent/mcp-server.ts, src/host/ipc-handlers/workspace.ts, src/host/registry.ts, src/host/server-completions.ts, src/config.ts, tests/agent/ipc-tools.test.ts, tests/agent/tool-catalog.test.ts, tests/e2e/harness.ts, tests/host/delegation-hardening.test.ts, tests/host/ipc-delegation.test.ts, tests/host/ipc-handlers/image.test.ts, tests/host/ipc-handlers/llm-events.test.ts, tests/host/ipc-handlers/skills-install.test.ts, tests/host/ipc-server.test.ts, tests/host/router.test.ts, tests/integration/cross-component.test.ts, tests/integration/e2e.test.ts
**Outcome:** Success — 27 files changed across all 7 integration categories. All 205 test files (2377 tests) pass.
**Notes:** Used separate workspace_scopes category (not existing workspace category) because workspace_mount filters on hasWorkspaceScopes (provider != 'none') while workspace write/write_file filter on hasWorkspaceTiers (enterprise). Three additional test files needed updates beyond the initial 12: tests/sandbox-isolation.test.ts, tests/agent/mcp-server.test.ts, and tests/agent/tool-catalog.test.ts required workspace_mount in expected tool lists, count bumps (14->15), and hasWorkspaceScopes in filter contexts.

## [2026-03-13] — Implement workspace provider category

**Task:** Create 4 new files under src/providers/workspace/ implementing the WorkspaceProvider category per the design plan.
**What I did:** Created types.ts (interfaces), none.ts (stub), shared.ts (orchestration with structural checks + scanner delegation), local.ts (filesystem backend with snapshot-based diffing). Followed existing provider patterns (scanner/types.ts, scheduler/none.ts). Used safePath() for all path construction in local.ts.
**Files touched:** Created src/providers/workspace/{types.ts, none.ts, shared.ts, local.ts}
**Outcome:** Success — all 4 files pass tsc with zero errors, no existing files modified.
**Notes:** Config type doesn't have a workspace block yet (that requires modifying src/types.ts). Local provider uses `config as unknown as Record<string, unknown>` cast to safely access the optional workspace config section.
