# Plan: Skill Binaries via GCS for K8s Sandboxes

## Problem

Skill install commands run on the **host** (via `skill_install` IPC handler), but k8s sandbox pods have no access to host-installed binaries. The pods use `emptyDir` volumes with `readOnlyRootFilesystem: true` and no host path mounts. There's no mechanism to bridge binaries from the host into the pod.

## Approach

Reuse the existing GCS workspace provisioning pattern:
1. Host installs skill binary locally (existing flow — no change)
2. Host uploads the installed binary artifacts to GCS under a `skill-bins/` prefix
3. Pod provisions skill binaries from GCS via the host's HTTP provision endpoint (same pattern as workspace scopes)
4. Binaries land on a writable volume mount (`/workspace/.skill-bins`) and are added to PATH

This mirrors how workspace scopes (agent/user/session) are already provisioned into pods.

## Implementation Steps

### Step 1: Add canonical path for skill-bins
**File:** `src/providers/sandbox/canonical-paths.ts`

- Add `CANONICAL.skillBins = '/workspace/.skill-bins'` to the canonical paths
- Add `AX_SKILL_BINS` to `canonicalEnv()`

### Step 2: Add `skill-bins` volume to k8s pod spec
**File:** `src/providers/sandbox/k8s.ts`

- Add a new `emptyDir` volume `skill-bins` with 512Mi limit
- Mount at `CANONICAL.skillBins` (`/workspace/.skill-bins`)
- Add `AX_SKILL_BINS` env var pointing to the mount path
- Prepend `CANONICAL.skillBins` to the pod's PATH env var

### Step 3: Extend workspace scope to include `skill-bins`
**Files:** `src/providers/workspace/types.ts`, `src/providers/workspace/gcs.ts`

- Extend `WorkspaceScope` type to include `'skill-bins'`
- In `downloadScope()`, handle the `skill-bins` scope (GCS folder: `skill-bins/`)
- Reuse the existing `/internal/workspace/provision` endpoint — just accept `scope=skill-bins`
- Update scope validation in `host-process.ts` to allow `skill-bins`

### Step 4: Upload installed binaries to GCS after successful install
**File:** `src/host/ipc-handlers/skills.ts`

After a successful `executeInstallStep()` where `binVerified === true`:
- Resolve the binary's actual path via `command -v` (reuse `binExists` pattern)
- Read the binary file content
- Upload to GCS via workspace provider's `uploadSkillBin()` method
- Store the GCS key in the persisted install state

For package managers, capture the binary at the resolved path:
- The install command (e.g., `npm install -g <pkg>`) puts the binary in PATH
- `command -v <bin>` resolves the installed path
- We read and upload that single file (not the entire node_modules)

### Step 5: Provision skill binaries in-pod during startup
**File:** `src/agent/runner.ts`, `src/agent/workspace.ts`

In `provisionWorkspaceFromPayload()`:
- After provisioning agent/user/session scopes, provision `skill-bins` scope
- `provisionScope(CANONICAL.skillBins, '', false, httpOpts('skill-bins', agentId))`
- After extracting, `chmod +x` all files (they're binaries)
- Prepend `CANONICAL.skillBins` to `process.env.PATH` in the runner

### Step 6: Context-aware `binExists()` for k8s
**File:** `src/host/ipc-handlers/skills.ts`

- When sandbox is k8s, `binExists()` on the host is misleading (host PATH ≠ pod PATH)
- For k8s context: check if the binary exists in GCS `skill-bins/{agentId}/` instead
- This ensures `skill_install` inspect returns accurate `satisfied`/`needed` for k8s pods
- Add `sandboxType` to IPCContext (already available from session config)

### Step 7: Tests

- `tests/providers/sandbox/k8s.test.ts` — pod spec includes `skill-bins` volume, PATH prepend
- `tests/host/ipc-handlers/skills.test.ts` — GCS upload after install, GCS-based binExists for k8s
- `tests/agent/workspace.test.ts` — skill-bins scope provision, chmod +x

### Step 8: Documentation and skills updates

- Update `.claude/skills/ax-provider-sandbox/SKILL.md`
- Update `.claude/skills/ax-host/SKILL.md`
- Journal and lessons entries

## Security Considerations

- Binaries are uploaded by the **host** (trusted) after validation — the agent never writes binaries
- GCS access is host-mediated (pod has no GCS credentials)
- Binary files get `chmod 555` after provision
- The `skill-bins` scope is per-agent (scoped by agentId)
- Token validation on provision endpoint prevents unauthorized access
- Binary names validated by `BIN_NAME_RE` (`[a-zA-Z0-9_.-]+`)

## Files to Modify

1. `src/providers/sandbox/canonical-paths.ts` — add CANONICAL.skillBins
2. `src/providers/sandbox/k8s.ts` — add volume, mount, PATH env
3. `src/providers/workspace/types.ts` — extend WorkspaceScope
4. `src/providers/workspace/gcs.ts` — handle skill-bins scope, upload method
5. `src/host/ipc-handlers/skills.ts` — GCS upload after install, k8s-aware binExists
6. `src/host/host-process.ts` — extend provision endpoint scope validation for skill-bins
7. `src/agent/runner.ts` — provision skill-bins in pod startup
8. `src/agent/workspace.ts` — chmod +x for skill-bins scope
9. Tests (3 files)
10. Skills/docs updates
