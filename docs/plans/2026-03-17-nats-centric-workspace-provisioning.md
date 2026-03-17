# Unified Workspace Lifecycle

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the broken three-phase pod orchestration with a unified workspace lifecycle where each sandbox provider decides WHERE prepare/release happens — host-side for Docker/Apple/subprocess (bind-mounted paths), sandbox-side for k8s (emptyDir volumes).

**Architecture:** Add a `workspaceLocation: 'host' | 'sandbox'` capability to the SandboxProvider interface. Build a `WorkspaceLifecyclePlan` once per turn in server-completions.ts. Host-side providers use the existing workspace.mount()/commit() flow plus new git workspace helpers that run directly on bind-mounted host paths. K8s includes scope info in the NATS work payload, and the runner provisions/releases inside the pod. The three-phase orchestration (separate provision/cleanup pods) is removed entirely — it's unnecessary for Docker/Apple (host sees bind-mounted paths) and broken for k8s (pods don't share emptyDir volumes).

**Tech Stack:** TypeScript, vitest, NATS queue groups, GCS (@google-cloud/storage + gsutil), k8s pod specs

---

## Current State

```
server-completions.ts (lines 850-1133) hard-codes three-phase orchestration:
  1. needsProvisioning = isContainerSandbox && workspaceGitUrl
  2. Spawn provision pod → workspace-cli.js provision (git clone + GCS scopes)
  3. Spawn agent pod → agent runs
  4. Spawn cleanup pod → workspace-cli.js cleanup (git push + GCS cache)

Problems:
  - Docker/Apple: three-phase is unnecessary — workspace.mount() already provisions
    GCS scopes to host paths, which are bind-mounted into the container.
  - K8s: three-phase is broken — each phase is a separate pod with separate
    emptyDir volumes. Provisioned content never reaches the agent pod.
  - K8s release: always diffs against empty baseline (workspace-cli.ts:191),
    treating every file as "added" regardless of prior state.
```

## Target State

```
server-completions.ts dispatches lifecycle based on workspaceLocation:

  Host-side (Docker/Apple/subprocess):
    workspace.mount()       → GCS scopes provisioned to host paths (already works)
    prepareGitWorkspace()   → git clone scratch to host path (NEW)
    spawn one container     → bind-mounts host paths
    agent runs + exits      → changes visible on host via bind-mount
    workspace.commit()      → diffs against snapshot, commits to GCS (already works)
    finalizeGitWorkspace()  → git push + GCS cache update (NEW)

  Sandbox-side (k8s):
    workspace.mount()       → no-op (returns empty paths, already implemented)
    payload includes scope info + git URL
    spawn one pod           → runner provisions from payload before agent starts
    agent runs              → reads/writes canonical paths
    runner releases         → diffs against provisioned hashes, HTTP upload (already works)
    runner finalizes        → git push + GCS cache update (NEW in-pod)
    workspace.commit()      → reads pending changes from RemoteTransport (already works)
```

---

### Task 1: Add `workspaceLocation` capability to sandbox providers

**Files:**
- Modify: `src/providers/sandbox/types.ts`
- Modify: `src/providers/sandbox/docker.ts`
- Modify: `src/providers/sandbox/apple.ts`
- Modify: `src/providers/sandbox/subprocess.ts`
- Modify: `src/providers/sandbox/k8s.ts`
- Modify: `tests/sandbox-isolation.test.ts`

**Step 1: Write the failing test**

Add to `tests/sandbox-isolation.test.ts`:

```typescript
describe('sandbox workspaceLocation capability', () => {
  test('SandboxProvider has workspaceLocation field', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(resolve('src/providers/sandbox/types.ts'), 'utf-8');
    expect(source).toContain('workspaceLocation');
  });

  test('docker provider sets workspaceLocation to host', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(resolve('src/providers/sandbox/docker.ts'), 'utf-8');
    expect(source).toContain("workspaceLocation: 'host'");
  });

  test('apple provider sets workspaceLocation to host', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(resolve('src/providers/sandbox/apple.ts'), 'utf-8');
    expect(source).toContain("workspaceLocation: 'host'");
  });

  test('subprocess provider sets workspaceLocation to host', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(resolve('src/providers/sandbox/subprocess.ts'), 'utf-8');
    expect(source).toContain("workspaceLocation: 'host'");
  });

  test('k8s provider sets workspaceLocation to sandbox', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(resolve('src/providers/sandbox/k8s.ts'), 'utf-8');
    expect(source).toContain("workspaceLocation: 'sandbox'");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npm test -- --run tests/sandbox-isolation.test.ts`
Expected: FAIL — `workspaceLocation` doesn't exist yet

**Step 3: Update SandboxProvider interface**

In `src/providers/sandbox/types.ts`, add to the `SandboxProvider` interface:

```typescript
export interface SandboxProvider {
  spawn(config: SandboxConfig): Promise<SandboxProcess>;
  kill(pid: number): Promise<void>;
  isAvailable(): Promise<boolean>;

  /**
   * Where workspace prepare/release should run.
   * - 'host': bind-mounted paths — host prepares before spawn, releases after exit.
   * - 'sandbox': pod-local volumes — runner provisions in-pod, releases via HTTP.
   */
  workspaceLocation: 'host' | 'sandbox';
}
```

**Step 4: Add the property to each provider's return value**

In `src/providers/sandbox/docker.ts`, add to the returned object (line 57):

```typescript
  return {
    workspaceLocation: 'host' as const,
    async spawn(config: SandboxConfig): Promise<SandboxProcess> {
```

In `src/providers/sandbox/apple.ts`, add to the returned object (line 40):

```typescript
  return {
    workspaceLocation: 'host' as const,
    async spawn(config: SandboxConfig): Promise<SandboxProcess> {
```

In `src/providers/sandbox/subprocess.ts`, add to the returned object (line 11):

```typescript
  return {
    workspaceLocation: 'host' as const,
    async spawn(config: SandboxConfig): Promise<SandboxProcess> {
```

In `src/providers/sandbox/k8s.ts`, add to the returned object (line 321):

```typescript
  return {
    workspaceLocation: 'sandbox' as const,
    async spawn(config: SandboxConfig): Promise<SandboxProcess> {
```

**Step 5: Run test to verify it passes**

Run: `npm test -- --run tests/sandbox-isolation.test.ts`

**Step 6: Commit**

```bash
git add src/providers/sandbox/types.ts src/providers/sandbox/docker.ts src/providers/sandbox/apple.ts src/providers/sandbox/subprocess.ts src/providers/sandbox/k8s.ts tests/sandbox-isolation.test.ts
git commit -m "feat: add workspaceLocation capability to sandbox providers"
```

---

### Task 2: Create workspace lifecycle module with shared types and host-side helpers

**Files:**
- Create: `src/providers/workspace/lifecycle.ts`
- Create: `tests/providers/workspace/lifecycle.test.ts`

**Step 1: Write the failing test**

Create `tests/providers/workspace/lifecycle.test.ts`:

```typescript
import { describe, test, expect } from 'vitest';
import { resolve } from 'node:path';

describe('workspace lifecycle module', () => {
  test('exports WorkspaceLifecyclePlan type', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(resolve('src/providers/workspace/lifecycle.ts'), 'utf-8');
    expect(source).toContain('WorkspaceLifecyclePlan');
  });

  test('exports prepareGitWorkspace function', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(resolve('src/providers/workspace/lifecycle.ts'), 'utf-8');
    expect(source).toContain('export async function prepareGitWorkspace');
  });

  test('exports finalizeGitWorkspace function', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(resolve('src/providers/workspace/lifecycle.ts'), 'utf-8');
    expect(source).toContain('export async function finalizeGitWorkspace');
  });

  test('exports buildLifecyclePlan function', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(resolve('src/providers/workspace/lifecycle.ts'), 'utf-8');
    expect(source).toContain('export function buildLifecyclePlan');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npm test -- --run tests/providers/workspace/lifecycle.test.ts`
Expected: FAIL — file doesn't exist

**Step 3: Create lifecycle.ts**

Create `src/providers/workspace/lifecycle.ts`.

Note on security: The git helpers use `execFileSync` (no shell). The gsutil/tar helpers
use `execSync` because gsutil relies on shell glob expansion — these paths are all
host-constructed (not user input) and match the existing pattern in `src/agent/workspace.ts`.

```typescript
// src/providers/workspace/lifecycle.ts — Unified workspace lifecycle for all sandbox providers.
//
// Replaces the hard-coded three-phase orchestration in server-completions.ts.
// Host-side providers (Docker/Apple/subprocess): prepare/finalize on host paths.
// Sandbox-side providers (k8s): prepare/finalize happen in-pod via NATS payload.

import { execFileSync, execSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { getLogger } from '../../logger.js';

const logger = getLogger().child({ component: 'workspace-lifecycle' });

// ═══════════════════════════════════════════════════════
// Lifecycle Plan — built once per turn
// ═══════════════════════════════════════════════════════

export interface WorkspaceLifecyclePlan {
  /** Git URL for scratch workspace. */
  gitUrl?: string;
  /** Git branch/ref. */
  gitRef?: string;
  /** Deterministic cache key for GCS workspace cache. */
  cacheKey?: string;
  /** GCS prefix for workspace scopes (base — scope/id appended per scope). */
  gcsPrefix?: string;
  /** Agent name (for agent scope GCS prefix). */
  agentName: string;
  /** User ID (for user scope GCS prefix). */
  userId: string;
  /** Session ID (for session scope GCS prefix). */
  sessionId: string;
  /** Whether the agent workspace is writable (admin user). */
  agentWorkspaceWritable: boolean;
  /** Scratch workspace host path (for host-side prepare/finalize). */
  scratchPath?: string;
}

/**
 * Build a lifecycle plan from the current request context.
 */
export function buildLifecyclePlan(opts: {
  gitUrl?: string;
  gitRef?: string;
  gcsPrefix?: string;
  agentName: string;
  userId: string;
  sessionId: string;
  agentWorkspaceWritable: boolean;
  scratchPath?: string;
}): WorkspaceLifecyclePlan {
  const cacheKey = opts.gitUrl
    ? createHash('sha256').update(`${opts.gitUrl}:${opts.gitRef ?? 'HEAD'}`).digest('hex').slice(0, 16)
    : undefined;

  return {
    gitUrl: opts.gitUrl,
    gitRef: opts.gitRef,
    cacheKey,
    gcsPrefix: opts.gcsPrefix,
    agentName: opts.agentName,
    userId: opts.userId,
    sessionId: opts.sessionId,
    agentWorkspaceWritable: opts.agentWorkspaceWritable,
    scratchPath: opts.scratchPath,
  };
}

// ═══════════════════════════════════════════════════════
// Host-side git workspace prepare/finalize
// ═══════════════════════════════════════════════════════

const CACHE_BUCKET = process.env.WORKSPACE_CACHE_BUCKET ?? '';

/**
 * Prepare a git workspace on a host-visible path (Docker/Apple/subprocess).
 * Restores from GCS cache, falls back to git clone --depth=1.
 */
export async function prepareGitWorkspace(plan: WorkspaceLifecyclePlan): Promise<void> {
  if (!plan.gitUrl || !plan.scratchPath) return;

  // Already populated (e.g. subprocess reusing an existing workspace)
  if (existsSync(join(plan.scratchPath, '.git'))) {
    tryGitPull(plan.scratchPath, plan.gitRef);
    return;
  }

  // Try GCS cache restore
  if (CACHE_BUCKET && plan.cacheKey) {
    if (tryGCSRestore(plan.scratchPath, plan.cacheKey)) {
      tryGitPull(plan.scratchPath, plan.gitRef);
      return;
    }
  }

  // Fall back to git clone
  tryGitClone(plan.scratchPath, plan.gitUrl, plan.gitRef);
}

/**
 * Finalize a git workspace on a host-visible path (Docker/Apple/subprocess).
 * Pushes changes to remote, updates GCS cache.
 */
export async function finalizeGitWorkspace(plan: WorkspaceLifecyclePlan): Promise<void> {
  if (!plan.gitUrl || !plan.scratchPath) return;

  const isGitRepo = existsSync(join(plan.scratchPath, '.git'));
  if (!isGitRepo) return;

  tryGitPush(plan.scratchPath);

  if (CACHE_BUCKET && plan.cacheKey) {
    // Fire-and-forget — don't block response on cache update
    updateGCSCache(plan.scratchPath, plan.cacheKey).catch(() => {});
  }
}

// ═══════════════════════════════════════════════════════
// Git helpers — use execFileSync (no shell) for safety
// ═══════════════════════════════════════════════════════

function tryGCSRestore(workspace: string, cacheKey: string): boolean {
  const cachePath = `gs://${CACHE_BUCKET}/${cacheKey}/workspace.tar.gz`;
  try {
    execFileSync('gsutil', ['-q', 'cp', cachePath, '/tmp/workspace-cache.tar.gz'], {
      timeout: 30_000, stdio: 'pipe',
    });
    execFileSync('tar', ['xzf', '/tmp/workspace-cache.tar.gz', '-C', workspace], {
      timeout: 60_000, stdio: 'pipe',
    });
    try { rmSync('/tmp/workspace-cache.tar.gz'); } catch { /* ignore */ }
    logger.info('git_workspace_cached', { cacheKey });
    return true;
  } catch {
    return false;
  }
}

function tryGitClone(workspace: string, gitUrl: string, ref?: string): boolean {
  try {
    const args = ['clone', '--depth=1'];
    if (ref) args.push('--branch', ref);
    args.push(gitUrl, workspace);
    execFileSync('git', args, { timeout: 120_000, stdio: 'pipe' });
    logger.info('git_workspace_cloned', { gitUrl, ref });
    return true;
  } catch (err) {
    logger.warn('git_workspace_clone_failed', { error: (err as Error).message });
    return false;
  }
}

function tryGitPull(workspace: string, ref?: string): void {
  try {
    execFileSync('git', ['-C', workspace, 'pull', '--ff-only', 'origin', ref ?? 'HEAD'], {
      timeout: 30_000, stdio: 'pipe',
    });
  } catch {
    // Non-fatal
  }
}

function tryGitPush(workspace: string): void {
  try {
    const status = execFileSync('git', ['-C', workspace, 'status', '--porcelain'], {
      encoding: 'utf-8', timeout: 10_000,
    }).trim();
    if (!status) return;

    // git add + commit requires shell chaining for atomicity
    // nosemgrep: javascript.lang.security.detect-child-process — workspace: host-controlled path
    execSync(
      `git -C "${workspace}" add . && git -C "${workspace}" commit -m "sandbox: auto-commit workspace changes"`,
      { timeout: 30_000, stdio: 'pipe' },
    );
    execFileSync('git', ['-C', workspace, 'push'], { timeout: 60_000, stdio: 'pipe' });
    logger.info('git_workspace_pushed');
  } catch (err) {
    logger.warn('git_workspace_push_failed', { error: (err as Error).message });
  }
}

async function updateGCSCache(workspace: string, cacheKey: string): Promise<void> {
  const cachePath = `gs://${CACHE_BUCKET}/${cacheKey}/workspace.tar.gz`;
  try {
    execFileSync('tar', ['czf', '/tmp/workspace-upload.tar.gz', '-C', workspace, '.'], {
      timeout: 120_000, stdio: 'pipe',
    });
    execFileSync('gsutil', ['-q', 'cp', '/tmp/workspace-upload.tar.gz', cachePath], {
      timeout: 120_000, stdio: 'pipe',
    });
    try { rmSync('/tmp/workspace-upload.tar.gz'); } catch { /* ignore */ }
  } catch {
    // Cache update failure is non-fatal
  }
}
```

**Step 4: Run test to verify it passes**

Run: `npm test -- --run tests/providers/workspace/lifecycle.test.ts`

**Step 5: Commit**

```bash
git add src/providers/workspace/lifecycle.ts tests/providers/workspace/lifecycle.test.ts
git commit -m "feat: workspace lifecycle module with shared types and host-side helpers"
```

---

### Task 3: Add workspace provisioning fields to NATS work payload

**Files:**
- Modify: `src/host/server-completions.ts`
- Modify: `src/agent/runner.ts`
- Modify: `tests/sandbox-isolation.test.ts`

**Step 1: Write the failing test**

Add to `tests/sandbox-isolation.test.ts`:

```typescript
describe('work payload includes workspace provisioning fields', () => {
  test('stdinPayload includes GCS scope fields when workspace provider is active', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(resolve('src/host/server-completions.ts'), 'utf-8');
    expect(source).toContain('agentGcsPrefix');
    expect(source).toContain('userGcsPrefix');
    expect(source).toContain('sessionGcsPrefix');
  });

  test('StdinPayload type includes provisioning fields', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(resolve('src/agent/runner.ts'), 'utf-8');
    expect(source).toContain('workspaceGitUrl');
    expect(source).toContain('agentGcsPrefix');
    expect(source).toContain('agentReadOnly');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npm test -- --run tests/sandbox-isolation.test.ts`

**Step 3: Add fields to StdinPayload in runner.ts**

In `src/agent/runner.ts`, add to the `StdinPayload` interface (around line 287):

```typescript
  /** Git URL for scratch workspace provisioning (k8s in-pod). */
  workspaceGitUrl?: string;
  /** Git ref for workspace checkout. */
  workspaceGitRef?: string;
  /** GCS cache key for workspace restore. */
  workspaceCacheKey?: string;
  /** GCS prefix for agent scope provisioning. */
  agentGcsPrefix?: string;
  /** GCS prefix for user scope provisioning. */
  userGcsPrefix?: string;
  /** GCS prefix for session/scratch scope provisioning. */
  sessionGcsPrefix?: string;
  /** Whether agent scope is read-only (non-admin users). */
  agentReadOnly?: boolean;
```

In `parseStdinPayload()`, add parsing for these fields (around line 329):

```typescript
        workspaceGitUrl: typeof parsed.workspaceGitUrl === 'string' ? parsed.workspaceGitUrl : undefined,
        workspaceGitRef: typeof parsed.workspaceGitRef === 'string' ? parsed.workspaceGitRef : undefined,
        workspaceCacheKey: typeof parsed.workspaceCacheKey === 'string' ? parsed.workspaceCacheKey : undefined,
        agentGcsPrefix: typeof parsed.agentGcsPrefix === 'string' ? parsed.agentGcsPrefix : undefined,
        userGcsPrefix: typeof parsed.userGcsPrefix === 'string' ? parsed.userGcsPrefix : undefined,
        sessionGcsPrefix: typeof parsed.sessionGcsPrefix === 'string' ? parsed.sessionGcsPrefix : undefined,
        agentReadOnly: parsed.agentReadOnly === true,
```

**Step 4: Add fields to stdinPayload in server-completions.ts**

In `src/host/server-completions.ts`, add to the `stdinPayload` object (around line 826, after `skills`). These fields are only consumed by sandbox-side providers (k8s) but are harmless for others:

```typescript
      // Workspace provisioning fields (sandbox-side providers provision in-pod)
      workspaceGitUrl: process.env.AX_WORKSPACE_GIT_URL,
      workspaceGitRef: process.env.AX_WORKSPACE_GIT_REF,
      workspaceCacheKey,
      agentGcsPrefix: workspaceGcsPrefix ? `${workspaceGcsPrefix}agent/${agentName}/` : undefined,
      userGcsPrefix: workspaceGcsPrefix ? `${workspaceGcsPrefix}user/${currentUserId}/` : undefined,
      sessionGcsPrefix: workspaceGcsPrefix ? `${workspaceGcsPrefix}scratch/${sessionId}/` : undefined,
      agentReadOnly: !agentWorkspaceWritable,
```

Note: `workspaceCacheKey` is already computed at line 859. `workspaceGcsPrefix` is at line 854.

**Step 5: Run test**

Run: `npm test -- --run tests/sandbox-isolation.test.ts`

**Step 6: Commit**

```bash
git add src/host/server-completions.ts src/agent/runner.ts tests/sandbox-isolation.test.ts
git commit -m "feat: add workspace provisioning fields to NATS work payload"
```

---

### Task 4: Add GCS and git env vars to k8s pod spec

**Files:**
- Modify: `src/providers/sandbox/k8s.ts`
- Modify: `tests/sandbox-isolation.test.ts`

**Step 1: Write the failing test**

Add to `tests/sandbox-isolation.test.ts`:

```typescript
test('k8s pod spec includes GCS and git workspace env vars', async () => {
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(resolve('src/providers/sandbox/k8s.ts'), 'utf-8');
  expect(source).toContain('GCS_WORKSPACE_BUCKET');
  expect(source).toContain('WORKSPACE_CACHE_BUCKET');
  expect(source).toContain('AX_WORKSPACE_GIT_URL');
});
```

**Step 2: Run test to verify it fails**

Run: `npm test -- --run tests/sandbox-isolation.test.ts`

**Step 3: Add env vars to k8s pod spec**

In `src/providers/sandbox/k8s.ts`, add to the env array in `buildPodSpec()` (around line 139, before `POD_NAME`):

```typescript
            // GCS + git workspace config — used by in-pod provisionScope() and provisionWorkspace()
            ...(process.env.GCS_WORKSPACE_BUCKET ? [{ name: 'GCS_WORKSPACE_BUCKET', value: process.env.GCS_WORKSPACE_BUCKET }] : []),
            ...(process.env.WORKSPACE_CACHE_BUCKET ? [{ name: 'WORKSPACE_CACHE_BUCKET', value: process.env.WORKSPACE_CACHE_BUCKET }] : []),
            ...(process.env.AX_WORKSPACE_GIT_URL ? [{ name: 'AX_WORKSPACE_GIT_URL', value: process.env.AX_WORKSPACE_GIT_URL }] : []),
            ...(process.env.AX_WORKSPACE_GIT_REF ? [{ name: 'AX_WORKSPACE_GIT_REF', value: process.env.AX_WORKSPACE_GIT_REF }] : []),
```

**Step 4: Run test**

Run: `npm test -- --run tests/sandbox-isolation.test.ts`

**Step 5: Commit**

```bash
git add src/providers/sandbox/k8s.ts tests/sandbox-isolation.test.ts
git commit -m "feat: pass GCS and git workspace env vars to k8s pod spec"
```

---

### Task 5: Add in-pod workspace provisioning to runner lifecycle

**Files:**
- Modify: `src/agent/runner.ts`
- Create: `tests/agent/runner-provisioning.test.ts`

**Step 1: Write the failing test**

Create `tests/agent/runner-provisioning.test.ts`:

```typescript
import { describe, test, expect } from 'vitest';
import { resolve } from 'node:path';

describe('in-pod workspace provisioning', () => {
  test('runner.ts has provisionWorkspaceFromPayload function', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(resolve('src/agent/runner.ts'), 'utf-8');
    expect(source).toContain('provisionWorkspaceFromPayload');
  });

  test('provisionWorkspaceFromPayload provisions scopes and writes hash snapshot', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(resolve('src/agent/runner.ts'), 'utf-8');
    expect(source).toContain('provisionScope');
    expect(source).toContain('provisionWorkspace');
    expect(source).toContain('.ax-hashes.json');
  });

  test('k8s HTTP mode calls provisionWorkspaceFromPayload before run()', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(resolve('src/agent/runner.ts'), 'utf-8');
    // Provisioning must appear between applyPayload and run
    const applyIdx = source.indexOf('applyPayload(config, payload)');
    const provisionIdx = source.indexOf('provisionWorkspaceFromPayload(payload)');
    const runIdx = source.indexOf('return run(config)');
    expect(provisionIdx).toBeGreaterThan(applyIdx);
    expect(provisionIdx).toBeLessThan(runIdx);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npm test -- --run tests/agent/runner-provisioning.test.ts`

**Step 3: Add provisioning function to runner.ts**

In `src/agent/runner.ts`, add imports near the top:

```typescript
import { provisionScope, provisionWorkspace } from './workspace.js';
import { CANONICAL } from '../providers/sandbox/canonical-paths.js';
import { writeFileSync } from 'node:fs';
```

Add the provisioning function (before the `run()` export):

```typescript
/**
 * Provision workspace scopes inside the pod (k8s sandbox-side lifecycle).
 * Called after receiving work payload, before running the agent.
 * Writes hash snapshots to /tmp/.ax-hashes.json for the release step.
 */
async function provisionWorkspaceFromPayload(payload: StdinPayload): Promise<void> {
  const snapshot: Record<string, [string, string][]> = {};

  // Git workspace → /workspace/scratch
  if (payload.workspaceGitUrl) {
    try {
      const result = await provisionWorkspace(CANONICAL.scratch, '', {
        gitUrl: payload.workspaceGitUrl,
        ref: payload.workspaceGitRef,
        cacheKey: payload.workspaceCacheKey,
      });
      logger.info('provision_workspace', { source: result.source, durationMs: result.durationMs });
    } catch (err) {
      logger.warn('provision_workspace_failed', { error: (err as Error).message });
    }
  }

  // Agent scope → /workspace/agent
  if (payload.agentGcsPrefix) {
    try {
      const result = await provisionScope(CANONICAL.agent, payload.agentGcsPrefix, payload.agentReadOnly ?? true);
      snapshot.agent = [...result.hashes.entries()];
      logger.info('provision_agent_scope', { source: result.source, fileCount: result.fileCount });
    } catch (err) {
      logger.warn('provision_agent_scope_failed', { error: (err as Error).message });
    }
  }

  // User scope → /workspace/user
  if (payload.userGcsPrefix) {
    try {
      const result = await provisionScope(CANONICAL.user, payload.userGcsPrefix, false);
      snapshot.user = [...result.hashes.entries()];
      logger.info('provision_user_scope', { source: result.source, fileCount: result.fileCount });
    } catch (err) {
      logger.warn('provision_user_scope_failed', { error: (err as Error).message });
    }
  }

  // Session scope → /workspace/scratch (GCS overlay on top of git workspace)
  if (payload.sessionGcsPrefix) {
    try {
      const result = await provisionScope(CANONICAL.scratch, payload.sessionGcsPrefix, false);
      snapshot.session = [...result.hashes.entries()];
      logger.info('provision_session_scope', { source: result.source, fileCount: result.fileCount });
    } catch (err) {
      logger.warn('provision_session_scope_failed', { error: (err as Error).message });
    }
  }

  // Write hash snapshot for workspace release to diff against
  if (Object.keys(snapshot).length > 0) {
    try {
      writeFileSync('/tmp/.ax-hashes.json', JSON.stringify(snapshot), 'utf-8');
      logger.debug('hash_snapshot_written', { scopes: Object.keys(snapshot) });
    } catch (err) {
      logger.warn('hash_snapshot_write_failed', { error: (err as Error).message });
    }
  }
}
```

**Step 4: Wire provisioning into the k8s HTTP mode lifecycle**

In runner.ts, update the k8s HTTP mode block (around line 481):

```typescript
    waitForNATSWork().then(async (data) => {
      const payload = parseStdinPayload(data);
      applyPayload(config, payload);

      // Sandbox-side workspace lifecycle: provision before agent runs
      await provisionWorkspaceFromPayload(payload);

      return run(config);
    }).catch((err) => {
```

**Step 5: Run test**

Run: `npm test -- --run tests/agent/runner-provisioning.test.ts`

**Step 6: Commit**

```bash
git add src/agent/runner.ts tests/agent/runner-provisioning.test.ts
git commit -m "feat: in-pod workspace provisioning from NATS payload"
```

---

### Task 6: Update workspace release to use provisioned hash baselines

**Files:**
- Modify: `src/agent/workspace-cli.ts`
- Create: `tests/agent/workspace-release-hashes.test.ts`

**Step 1: Write the failing test**

Create `tests/agent/workspace-release-hashes.test.ts`:

```typescript
import { describe, test, expect } from 'vitest';
import { resolve } from 'node:path';

describe('workspace release uses provisioned baselines', () => {
  test('release reads hash snapshot from /tmp/.ax-hashes.json', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(resolve('src/agent/workspace-cli.ts'), 'utf-8');
    expect(source).toContain('/tmp/.ax-hashes.json');
  });

  test('release does not always use empty baselines', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(resolve('src/agent/workspace-cli.ts'), 'utf-8');
    // The release function should read from hash snapshot, not just use empty Map()
    const releaseSection = source.slice(source.indexOf('async function release'));
    expect(releaseSection).toContain('hashSnapshot');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npm test -- --run tests/agent/workspace-release-hashes.test.ts`
Expected: FAIL — release still uses `new Map()` hard-coded at line 191

**Step 3: Update workspace-cli.ts release**

In `src/agent/workspace-cli.ts`, update the `release()` function. Replace the loop starting at line 183 with:

```typescript
  // Read provisioned hash baselines if available (written by runner.ts provisionWorkspaceFromPayload).
  // When present, diffs are accurate (only actual changes). When absent (non-k8s, first run),
  // falls back to empty baseline (treats all files as "added").
  let hashSnapshot: HashSnapshot = {};
  const hashSnapshotPath = '/tmp/.ax-hashes.json';
  if (existsSync(hashSnapshotPath)) {
    try {
      hashSnapshot = JSON.parse(readFileSync(hashSnapshotPath, 'utf-8'));
      console.error(`[release] using provisioned baselines: ${Object.keys(hashSnapshot).join(', ')}`);
    } catch {
      console.error('[release] failed to read hash snapshot, using empty baselines');
    }
  }

  for (const scope of scopeNames) {
    const mountPath = scopePaths[scope];
    if (!mountPath || !existsSync(mountPath)) {
      console.error(`[release] skipping ${scope}: ${mountPath} does not exist`);
      continue;
    }

    // Use provisioned hashes as baseline (accurate diff) or empty map (all files = added)
    const snapshotEntries = hashSnapshot[scope];
    const baseHashes: FileHashMap = snapshotEntries ? new Map(snapshotEntries) : new Map();
    const diffs = diffScope(mountPath, baseHashes);
```

This replaces lines 183-193 which always used `const baseHashes: FileHashMap = new Map();`.

**Step 4: Run test**

Run: `npm test -- --run tests/agent/workspace-release-hashes.test.ts`

**Step 5: Commit**

```bash
git add src/agent/workspace-cli.ts tests/agent/workspace-release-hashes.test.ts
git commit -m "feat: workspace release reads provisioned hash baselines"
```

---

### Task 7: Add in-pod cleanup to agent runners (k8s sandbox-side finalize)

**Files:**
- Modify: `src/agent/runners/claude-code.ts`
- Modify: `src/agent/runners/pi-session.ts`
- Modify: `tests/sandbox-isolation.test.ts`

**Step 1: Write the failing test**

Add to `tests/sandbox-isolation.test.ts`:

```typescript
describe('in-pod workspace cleanup (sandbox-side finalize)', () => {
  test('claude-code runner calls releaseWorkspace after workspace release', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(resolve('src/agent/runners/claude-code.ts'), 'utf-8');
    expect(source).toContain('releaseWorkspace');
    expect(source).toContain('workspace_cleanup');
  });

  test('pi-session runner calls releaseWorkspace after workspace release', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(resolve('src/agent/runners/pi-session.ts'), 'utf-8');
    expect(source).toContain('releaseWorkspace');
    expect(source).toContain('workspace_cleanup');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npm test -- --run tests/sandbox-isolation.test.ts`

**Step 3: Add cleanup calls to both runners**

In both `src/agent/runners/claude-code.ts` and `src/agent/runners/pi-session.ts`, add after the existing `releaseWorkspaceScopes()` block (and before the `agent_response` IPC call):

```typescript
      // Sandbox-side finalize: git push + GCS cache update.
      // In k8s, the pod owns the workspace — finalize must happen in-pod.
      // Host-side providers (Docker/Apple) handle this after container exit.
      try {
        const { releaseWorkspace } = await import('../workspace.js');
        const scratchPath = '/workspace/scratch';
        const { existsSync } = await import('node:fs');
        if (existsSync(scratchPath + '/.git')) {
          await releaseWorkspace(scratchPath, {
            pushChanges: true,
            updateCache: !!process.env.WORKSPACE_CACHE_BUCKET,
            cacheKey: process.env.AX_WORKSPACE_CACHE_KEY,
          });
          logger.info('workspace_cleanup_done');
        }
      } catch (err) {
        logger.warn('workspace_cleanup_failed', { error: (err as Error).message });
      }
```

**Step 4: Run test**

Run: `npm test -- --run tests/sandbox-isolation.test.ts`

**Step 5: Commit**

```bash
git add src/agent/runners/claude-code.ts src/agent/runners/pi-session.ts tests/sandbox-isolation.test.ts
git commit -m "feat: in-pod workspace cleanup for sandbox-side finalize"
```

---

### Task 8: Replace three-phase orchestration with lifecycle dispatch

**Files:**
- Modify: `src/host/server-completions.ts`
- Modify: `tests/sandbox-isolation.test.ts`

This is the main integration task. Replaces the hard-coded three-phase logic with `workspaceLocation`-based dispatch.

**Step 1: Write the test**

Add to `tests/sandbox-isolation.test.ts`:

```typescript
describe('lifecycle dispatch replaces three-phase orchestration', () => {
  test('server-completions no longer spawns separate provision or cleanup pods', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(resolve('src/host/server-completions.ts'), 'utf-8');
    expect(source).not.toContain('provision_phase_start');
    expect(source).not.toContain('cleanup_phase_start');
    expect(source).not.toContain('workspace-cli.js provision');
    expect(source).not.toContain('workspace-cli.js cleanup');
  });

  test('server-completions uses workspaceLocation for lifecycle dispatch', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(resolve('src/host/server-completions.ts'), 'utf-8');
    expect(source).toContain('workspaceLocation');
    expect(source).toContain('prepareGitWorkspace');
    expect(source).toContain('finalizeGitWorkspace');
    expect(source).toContain('buildLifecyclePlan');
  });
});
```

**Step 2: Import lifecycle module in server-completions.ts**

At the top of `src/host/server-completions.ts`, add:

```typescript
import { buildLifecyclePlan, prepareGitWorkspace, finalizeGitWorkspace } from '../providers/workspace/lifecycle.js';
```

**Step 3: Build lifecycle plan (replace lines ~850-861)**

Replace the `needsProvisioning` block and `workspaceCacheKey` computation with:

```typescript
    // ── Workspace lifecycle ──
    // Build a plan once per turn. Host-side providers (Docker/Apple) use it to
    // prepare/finalize on bind-mounted paths. Sandbox-side providers (k8s) include
    // the plan fields in the NATS work payload for in-pod provisioning.
    const workspaceGitUrl = process.env.AX_WORKSPACE_GIT_URL;
    const workspaceGcsPrefix = process.env.AX_WORKSPACE_GCS_PREFIX;

    const lifecyclePlan = buildLifecyclePlan({
      gitUrl: workspaceGitUrl,
      gitRef: process.env.AX_WORKSPACE_GIT_REF,
      gcsPrefix: workspaceGcsPrefix,
      agentName,
      userId: currentUserId,
      sessionId,
      agentWorkspaceWritable,
      scratchPath: workspace,
    });
    const workspaceCacheKey = lifecyclePlan.cacheKey;
```

**Step 4: Replace provision phase (delete lines ~863-879) with host-side prepare**

```typescript
    // Host-side prepare: provision git workspace on bind-mount paths before spawn.
    // Sandbox-side (k8s) skips this — the runner provisions in-pod from payload.
    if (agentSandbox.workspaceLocation === 'host' && lifecyclePlan.gitUrl) {
      try {
        await prepareGitWorkspace(lifecyclePlan);
        reqLogger.debug('host_prepare_done', { gitUrl: lifecyclePlan.gitUrl });
      } catch (err) {
        reqLogger.warn('host_prepare_failed', { error: (err as Error).message });
      }
    }
```

**Step 5: Replace cleanup phase (delete lines ~1112-1133) with host-side finalize**

```typescript
    // Host-side finalize: git push + GCS cache update on bind-mount paths after exit.
    // Sandbox-side (k8s) skips this — the runner handles it in-pod.
    if (agentSandbox.workspaceLocation === 'host' && lifecyclePlan.gitUrl) {
      try {
        await finalizeGitWorkspace(lifecyclePlan);
        reqLogger.debug('host_finalize_done');
      } catch (err) {
        reqLogger.warn('host_finalize_failed', { error: (err as Error).message });
      }
    }
```

**Step 6: Remove `needsProvisioning` variable and all references**

Delete: `const needsProvisioning = isContainerSandbox && workspaceGitUrl;`

Search for remaining `needsProvisioning` references and remove.

**Step 7: Run tests**

Run: `npm test -- --run tests/sandbox-isolation.test.ts`

Then: `npm test -- --run`

**Step 8: Commit**

```bash
git add src/host/server-completions.ts tests/sandbox-isolation.test.ts
git commit -m "refactor: replace three-phase orchestration with lifecycle dispatch"
```

---

### Task 9: Remove the `network` flag from SandboxConfig

**Files:**
- Modify: `src/providers/sandbox/types.ts`
- Modify: `src/providers/sandbox/docker.ts`
- Modify: `src/providers/sandbox/apple.ts`
- Modify: `tests/sandbox-isolation.test.ts`

The `network` flag only existed for the three-phase orchestration (provision/cleanup pods needed network). Now that prepare/finalize happen host-side or in-pod, no container sandbox ever needs this flag toggled per-spawn.

**Step 1: Write the test**

Add to `tests/sandbox-isolation.test.ts`:

```typescript
test('SandboxConfig no longer has network flag', async () => {
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(resolve('src/providers/sandbox/types.ts'), 'utf-8');
  expect(source).not.toContain('network?:');
  expect(source).not.toContain('Three-phase orchestration');
});
```

**Step 2: Remove the field and conditional usage**

In `src/providers/sandbox/types.ts`, remove:

```typescript
  // ── Three-phase orchestration ──
  /** When true, container has network access (provision/cleanup phases). Default: false. */
  network?: boolean;
```

In `src/providers/sandbox/docker.ts` line 69, replace:

```typescript
        // Before:
        ...(config.network ? [] : ['--network=none']),
        // After:
        '--network=none',
```

In `src/providers/sandbox/apple.ts` line 70, replace:

```typescript
        // Before:
        ...(config.network ? ['--network', 'default'] : []),
        // After: remove line entirely (no network by default)
```

**Step 3: Run tests**

Run: `npm test -- --run tests/sandbox-isolation.test.ts`

Then: `npm test -- --run`

**Step 4: Commit**

```bash
git add src/providers/sandbox/types.ts src/providers/sandbox/docker.ts src/providers/sandbox/apple.ts tests/sandbox-isolation.test.ts
git commit -m "refactor: remove network flag from SandboxConfig (no longer needed)"
```

---

### Task 10: Full test suite, cleanup, and documentation

**Step 1:** Run full test suite:

```bash
npm test -- --run
```

**Step 2:** Verify no references to three-phase orchestration remain:

```bash
grep -rn 'needsProvisioning\|provision_phase\|cleanup_phase\|workspace-cli.js provision\|workspace-cli.js cleanup' src/
```

**Step 3:** Verify `workspaceLocation` is set on all sandbox providers:

```bash
grep -n 'workspaceLocation' src/providers/sandbox/*.ts
```

Expected: one line per provider + one in types.ts.

**Step 4:** Update sandbox skill documentation

Update `.claude/skills/ax/provider-sandbox/SKILL.md` to document:
- The `workspaceLocation` capability on SandboxProvider
- Host-side lifecycle: workspace.mount() + prepareGitWorkspace/finalizeGitWorkspace
- Sandbox-side lifecycle: in-pod provisioning from NATS payload
- The `WorkspaceLifecyclePlan` type in `src/providers/workspace/lifecycle.ts`
- Removal of `SandboxConfig.network` flag and three-phase orchestration

**Step 5:** Update canonical-paths.ts comments

Add a note that `/workspace` root is read-only in all providers except Apple Container (known TODO).

**Step 6:** Final commit

```bash
git add .claude/skills/ src/providers/sandbox/canonical-paths.ts tests/
git commit -m "docs: update skills and canonical paths for unified workspace lifecycle"
```
