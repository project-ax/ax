# Git-Based Identity

## [2026-04-16 10:00] — Fix identity cache invalidation: wire clearIdentityCache() after writes

**Task:** Fix stale identity cache bug — `clearIdentityCache()` was defined but never called, so after `hostGitCommit` or `seedRemoteRepo` modified identity files, stale cached data could be served for up to 30 seconds.

**What I did:**
- Added `clearIdentityCache` to the import in `src/host/server-completions.ts`
- Added `clearIdentityCache()` calls after `hostGitCommit()` (line ~1864), and after both `seedRemoteRepo()` calls (lines ~768, ~776)
- Updated the module doc comment in `identity-reader.ts` to reflect that cache invalidation IS done (was incorrectly saying "No explicit invalidation")
- Updated the `clearIdentityCache` JSDoc from "Useful for tests" to "Called after identity writes and in tests"

**Files touched:**
- Modified: `src/host/server-completions.ts`, `src/host/identity-reader.ts`

**Outcome:** Success — build passes, all changes are wiring existing dead code to the correct call sites.

**Notes:** `clearIdentityCache()` clears the entire Map rather than per-agentId because the write paths don't have `agentId` in scope and full-cache clear is safe given the low cost of cache misses.

## [2026-04-15 12:15] — Git-based identity system: Tasks 1-4

**Task:** Implement Tasks 1-4 of the git-based identity plan: validateCommit, loadIdentityFromGit, hostGitCommit integration, and validate_commit IPC action.

**What I did:**
- Task 1: Created `src/host/validate-commit.ts` with `validateCommit()` function (path allowlist, size limits, diff parsing). 11 test cases.
- Task 2: Added `loadIdentityFromGit()` to `src/host/server-completions.ts` — reads identity via `git show HEAD:<path>`. Updated call site to prefer git-based loading when workspace is available. 3 test cases.
- Task 3: Integrated `validateCommit()` into `hostGitCommit()` — validates .ax/ diffs after staging, reverts on rejection, continues with remaining changes.
- Task 4: Added `ValidateCommitSchema` IPC schema, `validate_commit` handler in ipc-server.ts, modified git-sidecar `commitAndPush()` to call host validation before committing. Updated sync tests.

**Files touched:**
- Created: `src/host/validate-commit.ts`, `tests/host/validate-commit.test.ts`, `tests/host/load-identity-from-git.test.ts`, `.claude/journal/host/git-identity.md`
- Modified: `src/host/server-completions.ts`, `src/ipc-schemas.ts`, `src/host/ipc-server.ts`, `src/agent/git-sidecar.ts`, `tests/agent/tool-catalog-sync.test.ts`, `tests/integration/cross-component.test.ts`

**Outcome:** Success — all 4 tasks completed, build passes, all relevant tests pass (89 across 5 test files). Pre-existing integration test flakiness (EADDRINUSE) unrelated.

**Notes:** Kept `loadIdentityFromDB` and `IDENTITY_FILE_MAP` in place for backward compat (removal is in Batch 2). The call site at line ~1099 now conditionally uses git or DB based on `hostManagedGit` flag.
