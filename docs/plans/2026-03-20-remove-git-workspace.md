# Remove Git Workspace Provisioning

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Remove all git-based workspace provisioning (clone/pull/push) since there is no git workspace provider — only none, local, and gcs exist.

**Architecture:** The git workspace code is a separate layer from the GCS workspace provider. It runs git clone/pull/push on scratch workspace paths, configured via `AX_WORKSPACE_GIT_URL` / `AX_WORKSPACE_GIT_REF` env vars. Removing it means: deleting the lifecycle git helpers, removing git fields from StdinPayload, removing git env var passthrough in k8s pods, removing git finalize blocks in runners, and cleaning up server-completions.

**Tech Stack:** TypeScript, Node.js

---

## Task 1: Remove git helpers from workspace lifecycle

**Files:**
- Modify: `src/providers/workspace/lifecycle.ts` (remove git functions and helpers, keep `buildLifecyclePlan` but remove gitUrl/gitRef fields)

**Step 1: Edit lifecycle.ts**

Remove from `WorkspaceLifecyclePlan` interface:
- `gitUrl?: string`
- `gitRef?: string`

Remove from `buildLifecyclePlan` opts and return:
- `gitUrl`, `gitRef` params
- `cacheKey` computation from gitUrl (keep cacheKey if needed elsewhere, but it's only derived from gitUrl — remove it too)

Delete these functions entirely:
- `prepareGitWorkspace()`
- `finalizeGitWorkspace()`
- `tryGitClone()`
- `tryGitPull()`
- `tryGitPush()`
- `tryGCSRestore()` (used only for git workspace cache)
- `updateGCSCache()` (used only for git workspace cache)

Remove `CACHE_BUCKET` constant.

Remove imports: `execFileSync`, `execSync`, `existsSync`, `rmSync`, `createHash` — only if no longer used after removals.

**Step 2: Run build**

Run: `npm run build`
Expected: May have errors in files that import removed exports — that's expected, fixed in later tasks.

**Step 3: Commit**

```bash
git add src/providers/workspace/lifecycle.ts
git commit -m "refactor: remove git helpers from workspace lifecycle"
```

---

## Task 2: Remove git workspace code from agent workspace.ts

**Files:**
- Modify: `src/agent/workspace.ts` (remove git clone/pull/push from provisionWorkspace and releaseWorkspace)

**Step 1: Edit workspace.ts**

Remove from `WorkspaceConfig`:
- `gitUrl?: string`
- `ref?: string`

Remove from `WorkspaceResult`:
- `'git-clone'` from source union type (keep `'cache' | 'empty'`)

In `provisionWorkspace()`:
- Remove the git clone fallback path (the `tryGitClone` call and surrounding logic)
- Remove `tryGitPull` call from GCS cache restore
- Remove `computeCacheKey` usage from gitUrl
- Keep GCS cache restore logic if it's used independently (it is — via `CACHE_BUCKET`)

In `releaseWorkspace()`:
- Remove `tryGitPush` call
- Remove `isGitRepo` check

Delete these functions:
- `computeCacheKey()`
- `tryGitClone()`
- `tryGitPull()`
- `tryGitPush()`

Remove `execSync` import if no longer used.

**Step 2: Commit**

```bash
git add src/agent/workspace.ts
git commit -m "refactor: remove git clone/pull/push from agent workspace"
```

---

## Task 3: Remove git fields from StdinPayload and parsing

**Files:**
- Modify: `src/agent/runner.ts` (remove workspaceGitUrl, workspaceGitRef from StdinPayload and parseStdinPayload)

**Step 1: Edit runner.ts**

Remove from `StdinPayload` interface:
- `workspaceGitUrl?: string` (line 276)
- `workspaceGitRef?: string` (line 278)

Remove from `parseStdinPayload()`:
- `workspaceGitUrl` parsing (line 337)
- `workspaceGitRef` parsing (line 338)

In `provisionWorkspaceFromPayload()`:
- Remove the two `if (payload.workspaceGitUrl)` blocks (~lines 402-414 and 428-440)
- Remove comments referencing git workspace

**Step 2: Commit**

```bash
git add src/agent/runner.ts
git commit -m "refactor: remove git fields from StdinPayload"
```

---

## Task 4: Remove git workspace from server-completions.ts

**Files:**
- Modify: `src/host/server-completions.ts`

**Step 1: Edit server-completions.ts**

Remove import of `prepareGitWorkspace`, `finalizeGitWorkspace` from lifecycle (line 31). Keep `buildLifecyclePlan` if still needed.

Remove:
- `workspaceGitUrl` variable (line 874)
- `gitUrl` and `gitRef` from `buildLifecyclePlan` call (lines 879-880)
- `workspaceGitUrl` and `workspaceGitRef` from stdinPayload object (lines 917-918)

Remove the host-side prepare block (~lines 948-957):
```typescript
if (agentSandbox.workspaceLocation === 'host' && lifecyclePlan.gitUrl) { ... }
```

Remove the host-side finalize block (~lines 1203-1212):
```typescript
if (agentSandbox.workspaceLocation === 'host' && lifecyclePlan.gitUrl) { ... }
```

**Step 2: Commit**

```bash
git add src/host/server-completions.ts
git commit -m "refactor: remove git workspace from server-completions"
```

---

## Task 5: Remove git env vars from k8s sandbox provider

**Files:**
- Modify: `src/providers/sandbox/k8s.ts` (lines 135-136)

**Step 1: Edit k8s.ts**

Remove:
```typescript
...(process.env.AX_WORKSPACE_GIT_URL ? [{ name: 'AX_WORKSPACE_GIT_URL', value: process.env.AX_WORKSPACE_GIT_URL }] : []),
...(process.env.AX_WORKSPACE_GIT_REF ? [{ name: 'AX_WORKSPACE_GIT_REF', value: process.env.AX_WORKSPACE_GIT_REF }] : []),
```

Update the comment on line 132 from "GCS + git workspace config" to "GCS workspace config".

**Step 2: Commit**

```bash
git add src/providers/sandbox/k8s.ts
git commit -m "refactor: remove git env vars from k8s pod spec"
```

---

## Task 6: Remove git finalize from agent runners

**Files:**
- Modify: `src/agent/runners/claude-code.ts` (~lines 283-299)
- Modify: `src/agent/runners/pi-session.ts` (~lines 560-577)

**Step 1: Edit claude-code.ts**

Remove the entire "Sandbox-side finalize: git push + GCS cache update" block (~lines 283-299) that checks for `.git` directory and calls `releaseWorkspace`.

**Step 2: Edit pi-session.ts**

Remove the identical block (~lines 560-577).

**Step 3: Commit**

```bash
git add src/agent/runners/claude-code.ts src/agent/runners/pi-session.ts
git commit -m "refactor: remove git finalize from agent runners"
```

---

## Task 7: Clean up workspace-cli.ts git references

**Files:**
- Modify: `src/agent/workspace-cli.ts`

**Step 1: Edit workspace-cli.ts**

In `provision()`:
- Remove `gitUrl: args['git-url']` from the config passed to `provisionWorkspace` (line 49)
- Remove `ref: args.ref` (line 50)
- Update comment on line 47 from "GCS cache → git clone → empty" to "GCS cache → empty"

In `cleanup()`:
- Remove `pushChanges: args['push-changes'] === 'true'` from `releaseWorkspace` call (line 129)
- Remove `updateCache: args['update-cache'] === 'true'` and `cacheKey: args['cache-key']` if no longer used after git removal (check if GCS cache is still used — keep if so)
- Update comment on line 127 from "git push, GCS cache update, cleanup" to "cleanup"

In usage message (line 312):
- Remove `--git-url --ref` from provision usage
- Remove `--push-changes` from cleanup usage

Update file header comments (lines 6-8) to remove git references.

**Step 2: Commit**

```bash
git add src/agent/workspace-cli.ts
git commit -m "refactor: remove git references from workspace CLI"
```

---

## Task 8: Fix tests

**Files:**
- Modify: `tests/sandbox-isolation.test.ts`
- Modify: `tests/providers/workspace/lifecycle.test.ts`
- Modify: `tests/agent/workspace-provision-fixes.test.ts`
- Modify: `tests/agent/workspace-cli.test.ts`

**Step 1: Update sandbox-isolation.test.ts**

- Remove/update test "k8s pod spec includes GCS and git workspace env vars" (line 476) — keep GCS, remove git assertions
- Remove assertions for `prepareGitWorkspace`, `finalizeGitWorkspace` (lines 572-573)
- Remove assertion for `workspaceGitUrl` (line 610)

**Step 2: Update lifecycle.test.ts**

- Remove tests for `prepareGitWorkspace` and `finalizeGitWorkspace` exports (lines 11-21)

**Step 3: Update workspace-provision-fixes.test.ts**

- Remove the entire "P1 fix: HTTP GCS path provisions git workspace" describe block (lines 91+)

**Step 4: Update workspace-cli.test.ts**

- Update tests referencing `gitUrl` if applicable

**Step 5: Run all tests**

Run: `npm test`
Expected: All pass

**Step 6: Commit**

```bash
git add tests/
git commit -m "test: update tests after git workspace removal"
```

---

## Task 9: Build and verify

**Step 1: Full build**

Run: `npm run build`
Expected: Clean compilation, no errors

**Step 2: Full test suite**

Run: `npm test`
Expected: All tests pass

**Step 3: Final commit (if any remaining fixes)**

---
