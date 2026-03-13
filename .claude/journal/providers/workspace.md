# Workspace Provider Journal

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
