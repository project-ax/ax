# Fix List: Workspace Provider

**Generated from:** acceptance test results (2026-03-13)
**Total issues:** 4 (Critical: 1, Major: 2, Minor: 1)

## Critical

### FIX-1: workspaceProvider not parsed from agent stdin payload

**Test:** BT-1 (local), cascades to IT-1/IT-2/IT-3
**Environment:** Both (fixed mid-run by K8s agent)
**Root cause:** Incomplete — field declared in StdinPayload but never extracted or assigned
**Location:** `src/agent/runner.ts:~299` (parseStdinPayload) and `src/agent/runner.ts:~364` (main entry)
**What's wrong:** `parseStdinPayload()` defines `workspaceProvider` in the interface but never reads it from `parsed`. The main runner never assigns `config.workspaceProvider = payload.workspaceProvider`. Result: `hasWorkspaceScopes` is always `false`, `workspace_mount` tool never registered.
**What to fix:** Add two lines:
1. In `parseStdinPayload()`: `workspaceProvider: typeof parsed.workspaceProvider === 'string' ? parsed.workspaceProvider : undefined,`
2. In main runner: `config.workspaceProvider = payload.workspaceProvider;`
**Estimated scope:** 1 file
**Status:** Fixed by K8s agent during test run — verify the fix is committed.

## Major

### FIX-2: workspace_write bypasses commit pipeline structural checks

**Test:** BT-4 (both envs), BT-5 (both envs)
**Environment:** Both
**Root cause:** Design flaw — two independent write paths, only one enforces limits
**Location:** `src/host/ipc-handlers/workspace.ts` (workspace_write handler)
**What's wrong:** The `workspace_write` IPC handler writes directly to disk via `writeFileSync()`. The commit pipeline's structural checks (maxFileSize, maxFiles, maxCommitSize, ignorePatterns, binary detection) in `src/providers/workspace/shared.ts:structuralFilter()` are only invoked during the provider-backed mount/diff/commit flow. Direct writes bypass all of these checks.
**What to fix:** Add pre-write validation to the `workspace_write` handler:
1. Check file size against `config.workspace?.maxFileSize ?? DEFAULT_MAX_FILE_SIZE`
2. Check path against ignore patterns via `DEFAULT_IGNORE_PATTERNS` (or config overrides)
3. Check for binary content (null bytes)
4. Reject with an error response if any check fails
Alternatively, refactor to route writes through `structuralFilter()`.
**Estimated scope:** 1-2 files (`src/host/ipc-handlers/workspace.ts`, possibly import from `shared.ts`)

### FIX-3: Provider scope tracking doesn't persist across k8s requests

**Test:** IT-2 (k8s), IT-3 (k8s)
**Environment:** K8s only
**Root cause:** Integration gap — in-memory Map keyed by internal requestId, not persistent sessionId
**Location:** `src/providers/workspace/shared.ts` (sessionScopes Map), `src/host/server-completions.ts` (auto-mount)
**What's wrong:** The workspace provider tracks mounted scopes in an in-memory `Map<string, Set<WorkspaceScope>>` keyed by `sessionId`. In k8s mode, each HTTP request generates a new internal `requestId` that is used as `ctx.sessionId` in IPC handlers. This means scope state from request 1 is invisible to request 2, even if they share the same persistent session ID. Additive mounting and auto-mount both break.
**What to fix:** Either:
1. Key the in-memory scope map by the persistent session ID (passed through from the HTTP request's `session_id` field) instead of the internal request ID
2. Or persist scope state to the database/storage provider, keyed by persistent session ID
Option 1 is simpler. The persistent session ID needs to flow through to the workspace provider's mount/activeMounts calls.
**Estimated scope:** 2-3 files (`shared.ts`, `server-completions.ts`, possibly `ipc-handlers/workspace.ts`)

## Minor

### FIX-4: workspace write tool registered even when workspace provider is none

**Test:** BT-3 (local — partial pass)
**Environment:** Both
**Root cause:** Design flaw — workspace_write tool gated by directory existence, not provider config
**Location:** `src/agent/tool-catalog.ts` (filterTools, hasWorkspaceTiers)
**What's wrong:** The `workspace` write tool is registered based on `hasWorkspaceTiers` (whether agent/user workspace directories exist), not on the workspace provider type. Since workspace directories are always created, the write tool is always available even with `workspace: none`.
**What to fix:** Gate the `workspace` write tool on `workspace provider !== 'none'` in addition to (or instead of) directory existence. Alternatively, if the intent is that the two-tier workspace write is always available regardless of provider, update the test plan to reflect this as expected behavior.
**Estimated scope:** 1 file

## Suggested Fix Order

1. **FIX-1** — Critical, blocks all scope-based workspace operations. Already fixed mid-run; verify and commit.
2. **FIX-2** — Major, security-relevant (structural limits not enforced). Straightforward validation addition.
3. **FIX-3** — Major, k8s-specific. Requires architectural decision about scope persistence. More design work needed.
4. **FIX-4** — Minor, cosmetic. Depends on design decision about whether two-tier writes should always be available.
