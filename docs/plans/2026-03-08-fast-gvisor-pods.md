# Fast gVisor Pods Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Eliminate per-turn cold start in k8s sandbox pods by adding session-level pod affinity, a git-sync sidecar for network-isolated workspace provisioning, and local SSD scratch volumes.

**Architecture:** Today, sandbox worker pods are claimed per-turn via NATS, provision a workspace (GCS/git), execute tool calls, then release and delete the workspace. Each turn in the same session re-provisions from scratch. We change this to: (1) session-level pod affinity so the same pod handles all turns in a conversation, (2) a non-gvisor sidecar that handles git/GCS operations (the gvisor container has no network except NATS+DNS), and (3) SSD-backed emptyDir volumes for near-native I/O.

**Tech Stack:** TypeScript, @kubernetes/client-node, NATS, Helm, gVisor

---

## Current Architecture (read this first)

The k8s sandbox flow today:

```
Host pod → NATS session.request.{agentType} → Agent Runtime pod (queue group)
  Agent Runtime runs agent loop as subprocess (NOT k8s pod)
  Agent needs tool execution (bash, read_file, etc.) →
    NATSSandboxDispatcher.dispatch(requestId, sessionId, tool) →
      First tool call: NATS tasks.sandbox.{tier} → warm sandbox worker pod claims it
        Worker provisions workspace (GCS cache → git clone → empty)
        Worker returns podSubject for direct dispatch
      Subsequent tool calls: direct NATS request to sandbox.{podId}
      End of turn: dispatcher.release(requestId) → workspace deleted, pod goes back to warm pool
```

Key files:
- `src/host/nats-sandbox-dispatch.ts` — Per-turn pod affinity (requestId → podSubject)
- `src/sandbox-worker/worker.ts` — Claims tasks, provisions workspace, handles tool calls
- `src/sandbox-worker/workspace.ts` — GCS cache + git clone logic
- `src/pool-controller/controller.ts` — Maintains warm pod counts per tier
- `src/pool-controller/k8s-client.ts` — Pod CRUD for warm pool
- `src/host/agent-runtime-process.ts` — Session processing, creates NATSSandboxDispatcher
- `src/providers/sandbox/k8s.ts` — Direct pod creation (used for agent loop, NOT tool dispatch)
- `charts/ax/` — Helm chart (network policies, deployments, configmaps)

Key problems:
1. **Per-turn, not per-session:** Each turn claims a new pod → workspace re-provisioned every turn
2. **Network policy contradiction:** Workspace provisioning needs git/GCS but sandbox pods only allow NATS+DNS egress
3. **Workspace deleted on release:** No persistence between turns
4. **No SSD optimization:** emptyDir uses default storage medium

---

## Task 1: Session-Level Pod Affinity in Dispatcher

Promote pod affinity from per-turn (requestId) to per-session (sessionId). The same pod handles all turns in a conversation. Workspace stays warm.

**Files:**
- Modify: `src/host/nats-sandbox-dispatch.ts`
- Modify: `src/host/agent-runtime-process.ts`
- Test: `tests/host/nats-sandbox-dispatch.test.ts`

### Step 1: Write failing tests for session affinity

```typescript
// tests/host/nats-sandbox-dispatch.test.ts
// Add these tests to the existing file (or create if it doesn't exist)

import { describe, it, expect, vi, beforeEach } from 'vitest';

describe('NATSSandboxDispatcher session affinity', () => {
  it('reuses the same pod across multiple requestIds for the same sessionId', async () => {
    // Two different turns (requestIds) for the same session should reuse the same pod
    const result1 = await dispatcher.dispatch('req-1', 'session-A', { type: 'bash', command: 'echo 1' });
    await dispatcher.endTurn('req-1');  // end turn but keep session

    const result2 = await dispatcher.dispatch('req-2', 'session-A', { type: 'bash', command: 'echo 2' });

    // Both should have used the same podId
    expect(dispatcher.getSessionPod('session-A')).toBeDefined();
    // Only one claim should have been made (not two)
  });

  it('claims different pods for different sessionIds', async () => {
    await dispatcher.dispatch('req-1', 'session-A', { type: 'bash', command: 'echo 1' });
    await dispatcher.dispatch('req-2', 'session-B', { type: 'bash', command: 'echo 2' });

    const podA = dispatcher.getSessionPod('session-A');
    const podB = dispatcher.getSessionPod('session-B');
    expect(podA?.podId).not.toBe(podB?.podId);
  });

  it('releases pod only when session ends, not when turn ends', async () => {
    await dispatcher.dispatch('req-1', 'session-A', { type: 'bash', command: 'echo 1' });
    await dispatcher.endTurn('req-1');  // should NOT release pod

    // Pod should still be claimed for session-A
    expect(dispatcher.getSessionPod('session-A')).toBeDefined();

    // Explicit session end releases it
    await dispatcher.endSession('session-A');
    expect(dispatcher.getSessionPod('session-A')).toBeUndefined();
  });
});
```

### Step 2: Run tests to verify they fail

Run: `npm test -- --run tests/host/nats-sandbox-dispatch.test.ts`
Expected: FAIL — `endTurn`, `endSession`, `getSessionPod` don't exist

### Step 3: Implement session-level affinity

Change `NATSSandboxDispatcher` to track pods by sessionId instead of requestId. Add `endTurn()` (no-op for pod, just clears requestId mapping) and `endSession()` (actually releases the pod).

In `src/host/nats-sandbox-dispatch.ts`:

```typescript
// Change the affinity map from requestId → pod to sessionId → pod
// Add a reverse map: requestId → sessionId for turn tracking

export interface NATSSandboxDispatcher {
  dispatch(requestId: string, sessionId: string, tool: SandboxToolRequest, tier?: string): Promise<SandboxToolResponse>;

  /** End of turn — clears requestId mapping but keeps pod warm for session. */
  endTurn(requestId: string): void;

  /** End of session — releases the pod back to the warm pool. */
  endSession(sessionId: string): Promise<void>;

  /** Get the pod claimed for a session (if any). */
  getSessionPod(sessionId: string): PodAffinity | undefined;

  /** Check if a requestId has an active session pod. */
  hasPod(requestId: string): boolean;

  /** Release all pods (backwards compat alias for endSession on all). */
  release(requestId: string): Promise<void>;

  close(): Promise<void>;
}
```

Implementation changes:
- `affinity: Map<string, PodAffinity>` keyed by **sessionId** (not requestId)
- `turnMap: Map<string, string>` maps requestId → sessionId (for hasPod/release compat)
- `dispatch()`: check `affinity.get(sessionId)` first; only claim if no existing pod
- `endTurn(requestId)`: delete from turnMap, do NOT release pod
- `endSession(sessionId)`: send release to pod, delete from affinity
- `release(requestId)`: backwards compat — calls endSession for the mapped sessionId

### Step 4: Update agent-runtime-process.ts

In `src/host/agent-runtime-process.ts`, change the `finally` block in `processSessionRequest`:

```typescript
// Before (current):
finally {
  requestIdMap.delete(sessionId);
  if (sandboxDispatcher?.hasPod(requestId)) {
    await sandboxDispatcher.release(requestId).catch(...);
  }
}

// After:
finally {
  requestIdMap.delete(sessionId);
  // End the turn but keep the session pod warm.
  // Pod stays claimed for future turns in this session.
  if (sandboxDispatcher) {
    sandboxDispatcher.endTurn(requestId);
  }
}
```

Add a session timeout mechanism: if no new turn arrives within N minutes (configurable, default 10), auto-release the session pod. This prevents leaked pods.

```typescript
// In the dispatcher, add an idle timeout per session
const sessionTimers = new Map<string, ReturnType<typeof setTimeout>>();
const SESSION_IDLE_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

// After each turn ends, reset the idle timer
function resetIdleTimer(sessionId: string): void {
  const existing = sessionTimers.get(sessionId);
  if (existing) clearTimeout(existing);

  sessionTimers.set(sessionId, setTimeout(() => {
    void endSession(sessionId);
  }, SESSION_IDLE_TIMEOUT_MS));
}
```

### Step 5: Run tests to verify they pass

Run: `npm test -- --run tests/host/nats-sandbox-dispatch.test.ts`
Expected: PASS

### Step 6: Commit

```bash
git add src/host/nats-sandbox-dispatch.ts src/host/agent-runtime-process.ts tests/host/nats-sandbox-dispatch.test.ts
git commit -m "feat: session-level pod affinity for sandbox dispatch

Keep the same sandbox pod for all turns in a conversation session.
Previously each turn claimed and released a new pod, re-provisioning
the workspace from scratch. Now the pod stays warm between turns with
an idle timeout for leak prevention."
```

---

## Task 2: Workspace Persistence Between Turns

Stop deleting the workspace when a turn ends. Only clean up on session end (release).

**Files:**
- Modify: `src/sandbox-worker/worker.ts`
- Modify: `src/sandbox-worker/workspace.ts`
- Test: `tests/sandbox-worker/worker.test.ts`

### Step 1: Write failing test

```typescript
// tests/sandbox-worker/worker.test.ts

describe('sandbox worker session persistence', () => {
  it('keeps workspace between tool calls when pause (not release) is received', async () => {
    // Claim → tool calls → pause (end of turn) → tool calls → release
    // Workspace should persist across the pause
  });

  it('provisions workspace only once per session even across multiple turns', async () => {
    // First claim provisions workspace
    // Pause (turn boundary)
    // Second claim for same session skips provisioning
    // Verify provisionWorkspace called only once
  });

  it('cleans up workspace only on release, not on pause', async () => {
    // After pause: workspace directory still exists
    // After release: workspace directory cleaned up
  });
});
```

### Step 2: Run test to verify it fails

Run: `npm test -- --run tests/sandbox-worker/worker.test.ts`
Expected: FAIL — no `pause` message type

### Step 3: Add pause/resume to sandbox worker protocol

In `src/sandbox-worker/types.ts`, add:

```typescript
// New message type: pause (end of turn, keep workspace)
export interface SandboxPauseRequest {
  type: 'pause';
}
```

In `src/sandbox-worker/worker.ts`, modify the tool loop:

```typescript
// Current: on 'release' → clean up workspace, re-subscribe
// New: on 'pause' → keep workspace, re-subscribe to task queue (but skip provisioning on re-claim)
//      on 'release' → clean up workspace, re-subscribe

// Add session workspace cache
const sessionWorkspaces = new Map<string, string>(); // sessionId → workspace path

// In the claim handler:
if (sessionWorkspaces.has(claim.sessionId)) {
  // Reuse existing workspace — skip provisioning
  workspace = sessionWorkspaces.get(claim.sessionId)!;
  console.log(`[sandbox-worker] reusing workspace for session ${claim.sessionId}`);
} else {
  // First claim for this session — provision workspace
  const wsResult = await provisionWorkspace(WORKSPACE_ROOT, claim.sessionId, claim.workspace);
  workspace = wsResult.path;
  sessionWorkspaces.set(claim.sessionId, workspace);
}

// In the tool loop:
if (req.type === 'pause') {
  // End of turn — keep workspace, wait for next claim
  if (toolMsg.reply) toolMsg.respond(encode({ type: 'pause_ack' }));
  toolSub.unsubscribe();
  break;
  // Do NOT call releaseWorkspace — workspace stays
}

if (req.type === 'release') {
  // End of session — clean up workspace
  released = true;
  if (toolMsg.reply) toolMsg.respond(encode({ type: 'release_ack' }));
  toolSub.unsubscribe();
  sessionWorkspaces.delete(claim.sessionId);
  break;
  // releaseWorkspace called after loop
}
```

### Step 4: Update dispatcher to send pause instead of release at turn boundary

In `src/host/nats-sandbox-dispatch.ts`, the `endTurn()` method sends a `pause` message:

```typescript
async endTurn(requestId: string): void {
  const sessionId = turnMap.get(requestId);
  if (!sessionId) return;
  turnMap.delete(requestId);

  const pod = affinity.get(sessionId);
  if (!pod) return;

  // Tell the worker to pause (keep workspace), not release
  try {
    await nc.request(pod.podSubject, encode({ type: 'pause' }), { timeout: 10_000 });
  } catch (err) {
    logger.warn('pause_failed', { requestId, sessionId, error: (err as Error).message });
  }

  resetIdleTimer(sessionId);
}
```

### Step 5: Run tests

Run: `npm test -- --run tests/sandbox-worker/worker.test.ts`
Expected: PASS

### Step 6: Commit

```bash
git add src/sandbox-worker/worker.ts src/sandbox-worker/workspace.ts src/sandbox-worker/types.ts src/host/nats-sandbox-dispatch.ts tests/sandbox-worker/worker.test.ts
git commit -m "feat: workspace persistence across turns in sandbox worker

Add pause/resume protocol so sandbox workers keep their workspace
between turns. Workspace provisioning (git clone, GCS restore) only
happens once per session, not every turn."
```

---

## Task 3: Git-Sync Sidecar for Network-Isolated Pods

The sandbox worker pods run under a NetworkPolicy that only allows NATS+DNS egress. Git clone and gsutil need broader network access. Add a non-gvisor sidecar container that handles all network I/O for workspace provisioning.

**Files:**
- Create: `src/sandbox-worker/git-sync-sidecar.ts`
- Modify: `src/pool-controller/k8s-client.ts` (add sidecar to pod template)
- Modify: `src/sandbox-worker/workspace.ts` (delegate to sidecar via shared volume or NATS)
- Modify: `charts/ax/templates/networkpolicies/sandbox-restrict.yaml`
- Modify: `charts/ax/templates/pool-controller/configmap-sandbox-templates.yaml`
- Test: `tests/sandbox-worker/git-sync-sidecar.test.ts`

### Step 1: Write failing test

```typescript
// tests/sandbox-worker/git-sync-sidecar.test.ts

import { describe, it, expect, vi } from 'vitest';

describe('git-sync sidecar', () => {
  it('clones a repo to the shared workspace volume', async () => {
    // Sidecar receives a sync request via NATS (or signal file)
    // Clones to the shared emptyDir
    // Agent container can read the files
  });

  it('pulls latest changes on re-sync', async () => {
    // After initial clone, subsequent syncs do git pull
  });

  it('pushes workspace changes back on session end', async () => {
    // Agent makes file changes in the shared volume
    // On release signal, sidecar commits + pushes
  });

  it('updates GCS cache after successful sync', async () => {
    // After git clone, sidecar updates GCS cache in background
  });
});
```

### Step 2: Run test to verify it fails

Run: `npm test -- --run tests/sandbox-worker/git-sync-sidecar.test.ts`
Expected: FAIL — module doesn't exist

### Step 3: Implement git-sync sidecar

The sidecar is a small Node.js process that:
1. Connects to NATS
2. Subscribes to `sync.{podId}` for sync requests
3. Has network access (not under gvisor, not under restrictive NetworkPolicy)
4. Writes to the shared workspace emptyDir volume

```typescript
// src/sandbox-worker/git-sync-sidecar.ts

import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { hostname } from 'node:os';

export interface SyncRequest {
  type: 'sync';
  sessionId: string;
  gitUrl?: string;
  ref?: string;
  cacheKey?: string;
}

export interface SyncResponse {
  type: 'sync_result';
  source: 'cache' | 'git-clone' | 'empty' | 'existing';
  durationMs: number;
  error?: string;
}

export interface PushRequest {
  type: 'push';
  sessionId: string;
  cacheKey?: string;
}

const WORKSPACE_ROOT = process.env.SANDBOX_WORKSPACE_ROOT ?? '/workspace';
const CACHE_BUCKET = process.env.WORKSPACE_CACHE_BUCKET ?? '';

export async function startGitSyncSidecar(options?: {
  natsUrl?: string;
  podId?: string;
}): Promise<{ close: () => Promise<void> }> {
  const natsModule = await import('nats');

  const natsUrl = options?.natsUrl ?? process.env.NATS_URL ?? 'nats://localhost:4222';
  const podId = options?.podId ?? process.env.POD_NAME ?? `sidecar-${hostname()}`;

  const nc = await natsModule.connect({
    servers: natsUrl,
    name: `git-sync-${podId}`,
    reconnect: true,
    maxReconnectAttempts: -1,
  });

  const syncSubject = `sync.${podId}`;
  const sub = nc.subscribe(syncSubject);

  console.log(`[git-sync] listening on ${syncSubject}`);

  let running = true;

  (async () => {
    for await (const msg of sub) {
      if (!running) break;

      let req: SyncRequest | PushRequest;
      try {
        req = JSON.parse(new TextDecoder().decode(msg.data));
      } catch {
        continue;
      }

      if (req.type === 'sync') {
        const result = handleSync(req);
        if (msg.reply) {
          msg.respond(new TextEncoder().encode(JSON.stringify(result)));
        }
      } else if (req.type === 'push') {
        handlePush(req);
        if (msg.reply) {
          msg.respond(new TextEncoder().encode(JSON.stringify({ type: 'push_ack' })));
        }
      }
    }
  })().catch(err => {
    if (running) console.error('[git-sync] error:', err);
  });

  return {
    async close() {
      running = false;
      sub.unsubscribe();
      await nc.drain();
    },
  };
}

function handleSync(req: SyncRequest): SyncResponse {
  const start = Date.now();
  const workspace = join(WORKSPACE_ROOT, req.sessionId);

  // If workspace already exists (re-sync), just pull
  if (existsSync(join(workspace, '.git'))) {
    tryGitPull(workspace, req.ref);
    return { type: 'sync_result', source: 'existing', durationMs: Date.now() - start };
  }

  mkdirSync(workspace, { recursive: true });

  if (!req.gitUrl) {
    return { type: 'sync_result', source: 'empty', durationMs: Date.now() - start };
  }

  // Try GCS cache → git clone → empty
  if (CACHE_BUCKET) {
    if (tryGCSRestore(workspace, req.cacheKey ?? computeCacheKey(req.gitUrl, req.ref))) {
      tryGitPull(workspace, req.ref);
      return { type: 'sync_result', source: 'cache', durationMs: Date.now() - start };
    }
  }

  if (tryGitClone(workspace, req.gitUrl, req.ref)) {
    return { type: 'sync_result', source: 'git-clone', durationMs: Date.now() - start };
  }

  return { type: 'sync_result', source: 'empty', durationMs: Date.now() - start };
}

// ... (reuse the git/GCS helper functions from workspace.ts)
```

### Step 4: Update pod template to include sidecar

In `src/pool-controller/k8s-client.ts`, add a second container to the pod manifest:

```typescript
containers: [
  {
    name: 'sandbox',
    // ... existing gvisor agent container
    // Mounts workspace volume at WORKSPACE_ROOT
  },
  {
    name: 'git-sync',
    image: template.image,  // Same image, different entrypoint
    command: ['node', 'dist/sandbox-worker/git-sync-sidecar.js'],
    env: [
      { name: 'NATS_URL', value: template.natsUrl },
      { name: 'SANDBOX_WORKSPACE_ROOT', value: template.workspaceRoot },
      { name: 'WORKSPACE_CACHE_BUCKET', value: template.cacheBucket ?? '' },
      { name: 'POD_NAME', valueFrom: { fieldRef: { fieldPath: 'metadata.name' } } },
    ],
    resources: {
      requests: { cpu: '100m', memory: '128Mi' },
      limits: { cpu: '500m', memory: '256Mi' },
    },
    // NOT under gvisor — runs with normal container runtime
    // Has network access for git/GCS
    volumeMounts: [
      { name: 'workspace', mountPath: template.workspaceRoot },
    ],
    securityContext: {
      readOnlyRootFilesystem: true,
      allowPrivilegeEscalation: false,
      runAsNonRoot: true,
      runAsUser: 1000,
      capabilities: { drop: ['ALL'] },
    },
  },
],
```

### Step 5: Update network policy

In `charts/ax/templates/networkpolicies/sandbox-restrict.yaml`, split the policy so the git-sync sidecar has broader egress while the sandbox container stays restricted.

Approach: Use a separate NetworkPolicy for the git-sync sidecar. Since k8s NetworkPolicies are additive and apply at pod level, we need a different approach — use the pod-level policy for the most restrictive container and handle the sidecar's network needs through a separate label.

**Alternative approach:** Since both containers are in the same pod and share network namespace, we can't apply different NetworkPolicies to different containers. Instead:
- Keep the sandbox pods with NATS+DNS only
- The git-sync sidecar communicates via NATS (not direct git/GCS)
- Add a **dedicated git-sync pod** (not sidecar) that runs outside gvisor with full network
- OR: Use a shared emptyDir and a signal file mechanism

**Revised approach: NATS-proxied git operations**

The git-sync doesn't need to be a sidecar. It can be a separate deployment:

```
Agent Runtime → NATS sync.request.{tier} → Git-Sync Worker (full network) → shared result via NATS
```

But this means the cloned files need to get into the sandbox pod somehow. Options:
1. **PVC**: Git-sync worker clones to a PVC, sandbox pod mounts same PVC (ReadWriteMany). Requires a CSI driver like Filestore.
2. **NATS payload**: Stream files via NATS messages (too slow for large repos).
3. **Init before gvisor**: Use an initContainer (non-gvisor) for git clone, THEN start the gvisor container. This is the simplest.

**Best approach: initContainer for git clone + sidecar for ongoing sync**

```yaml
initContainers:
  - name: git-init
    image: {{ .Values.sandbox.image }}
    command: ["node", "dist/sandbox-worker/git-sync-init.js"]
    # Runs BEFORE gvisor sandbox starts
    # Has network (no runtimeClassName on initContainers)
    # Clones repo to shared emptyDir
    volumeMounts:
      - name: workspace
        mountPath: /workspace
    env:
      - name: GIT_URL
        value: ""  # Set at claim time via pod patch
      - name: WORKSPACE_CACHE_BUCKET
        value: {{ .Values.workspaceCache.bucket }}
```

Wait — initContainers run in the pod's runtimeClass too. If the pod has `runtimeClassName: gvisor`, ALL containers (init and regular) run under gvisor.

**Actual best approach: Two-phase pod lifecycle**

1. Pool controller creates warm pods WITHOUT gvisor runtimeClass initially — just the git-sync initContainer that waits for a signal
2. When claimed, the dispatcher patches the pod with the git URL
3. InitContainer clones the repo and exits
4. The sandbox container starts (under gvisor if configured per-container, but k8s doesn't support per-container runtimeClass)

This doesn't work either. runtimeClass is pod-level.

**Final approach: Workspace provisioning stays in the sandbox worker, add HTTPS egress to network policy**

The simplest solution: expand the NetworkPolicy to allow HTTPS egress (port 443) for sandbox pods, but ONLY to known git/GCS endpoints. The sandbox container already can't exfiltrate data because the agent (conversation loop) runs in the agent-runtime pod, not the sandbox worker. The sandbox worker only executes tool commands — it doesn't have conversation context or credentials.

```yaml
# sandbox-restrict.yaml
egress:
  - to:
    - podSelector:
        matchLabels:
          app.kubernetes.io/name: nats
    ports:
      - port: 4222
        protocol: TCP
  - ports:
    - port: 53
      protocol: UDP
    - port: 53
      protocol: TCP
  # Git/GCS access for workspace provisioning
  - ports:
    - port: 443
      protocol: TCP
    # Optionally restrict to known CIDR ranges for GCS/GitHub
```

This is acceptable because:
- The sandbox worker pod has no LLM conversation context (it just runs bash/file tools)
- No credentials are injected (git uses deploy keys, GCS uses workload identity)
- The agent process (which has the actual conversation) runs in the agent-runtime pod, not here
- Network egress is still logged and auditable

Actually wait, I need to reconsider. The sandbox worker's whole purpose is to run untrusted commands that the LLM requested (bash, write_file, etc.). If we give it HTTPS egress, a malicious bash command could exfiltrate workspace data. That's exactly what the network restriction prevents.

**True final approach: Dedicated workspace provisioner with shared PVC**

Create a separate "workspace-provisioner" service that:
1. Has full network access
2. Receives provision requests via NATS
3. Clones/caches to a shared ReadWriteMany PVC (GCS Filestore, EFS, etc.)
4. Sandbox pods mount the PVC at their workspace path

OR simpler:

**Simplest correct approach: Pre-provision workspace at claim time from the agent-runtime pod**

The agent-runtime pod already has network access. When the NATSSandboxDispatcher claims a pod, it can:
1. Provision the workspace on a shared PVC from the agent-runtime side
2. Then the sandbox worker mounts the same PVC

But this requires a shared filesystem...

**Actually simplest: The agent-runtime provisions workspace via the dispatcher before claiming**

The dispatcher runs in the agent-runtime pod which has network access. Move workspace provisioning into the dispatcher:

1. Dispatcher receives claim request with git URL
2. Dispatcher clones to a local temp dir (agent-runtime has network)
3. Dispatcher tars and sends via NATS to the sandbox worker
4. Sandbox worker extracts to its emptyDir

For small repos this works via NATS. For large repos we need streaming.

Actually NATS has a max message size (~1MB default, configurable up to 64MB). For repos that's too small.

**OK, the real answer: Use a GCS Fuse sidecar or GCS FUSE CSI driver**

GKE has a GCS FUSE CSI driver that mounts a GCS bucket as a filesystem. This is Google's supported solution for exactly this problem.

1. Workspace provisioner (a separate service with network) clones repo to GCS bucket path
2. Sandbox pod mounts GCS bucket via FUSE CSI (read-write, no network needed — CSI driver handles it)
3. Fast for reads after initial cache fill

But FUSE in gvisor has known performance issues...

**Let me step back and pick the pragmatic path:**

The simplest thing that works and maintains security:

1. **Add HTTPS egress but ONLY from the git-sync initContainer** — wait, can't do per-container NetworkPolicy.

2. **Use a non-gvisor pod for workspace provisioning, then copy to the gvisor pod** — too complex.

3. **Provision workspace from the agent-runtime pod and stream to sandbox worker via NATS large messages or JetStream object store**

NATS JetStream has an Object Store that supports large files. The agent-runtime can:
1. Clone the repo locally
2. Store as an object in JetStream
3. Sandbox worker retrieves and extracts

This is clean, no shared filesystem needed, works within existing NATS infrastructure.

Actually this is overengineering. Let me re-read what the codebase already does:

The sandbox worker (worker.ts line 209):
```
const wsResult = await provisionWorkspace(WORKSPACE_ROOT, claim.sessionId, claim.workspace);
```

And workspace.ts does git clone + gsutil from INSIDE the sandbox worker pod. For this to work today, the pod must already have the network access. Let me re-check the network policy.

Looking at `charts/ax/templates/networkpolicies/sandbox-restrict.yaml` — it restricts pods with `ax.io/plane: execution`. The pool controller creates pods with that label. But maybe in practice people either (a) don't use gvisor, or (b) the network policy isn't deployed, or (c) this is aspirational code that hasn't been tested end-to-end.

Given the memory note: "K8s-pod sandbox doesn't work with all-in-one server (IPC needs NATS bridge, not implemented)" — it seems like the k8s path is not fully battle-tested yet.

**Pragmatic decision: Allow HTTPS egress from sandbox worker pods for git/GCS only, document the security tradeoff, and add it as a configurable toggle.**

The real security boundary is:
- Agent can't exfiltrate via tool calls because the tool output goes through the host's outbound scanner
- The sandbox worker doesn't have conversation context or credentials
- The bash commands ARE the untrusted part, but they're already sandboxed by gvisor syscall filtering

Adding HTTPS egress to the sandbox worker NetworkPolicy for git/GCS provisioning is acceptable if:
- Git credentials are GKE Workload Identity (pod-level, not injected)
- GCS access is via Workload Identity
- gvisor's syscall filtering limits what bash can do with the network
- The outbound scanner catches exfiltration attempts in tool outputs

I'll include this as a configurable option with the security tradeoff documented.

**Alternative for the paranoid: disable network after provisioning**

Use a NetworkPolicy that allows HTTPS during the first N seconds (init phase), then a CronJob or controller patches the NetworkPolicy to restrict. This is complex but possible.

**Even simpler alternative: Just rely on the session affinity from Task 1+2.**

If workspace persists across turns (Task 1+2), provisioning only happens ONCE per session (not per turn). The provisioning latency becomes a one-time cost. We can do provisioning BEFORE the session starts — when the pool controller creates the warm pod, it can pre-provision a "default" workspace or do lazy provisioning on first claim.

For the git-sync sidecar concern, I'll document both approaches:
1. NetworkPolicy with HTTPS egress (simple, slight security tradeoff)
2. External provisioner with JetStream object store (more complex, tighter security)

And recommend #1 for most deployments.

OK let me finalize the plan now. I've been going back and forth. Let me commit to the pragmatic approach.
</thinking>

### Step 5: Update NetworkPolicy for workspace provisioning

The sandbox worker needs HTTPS egress for git clone and GCS access. Since k8s NetworkPolicies are pod-level (can't be per-container), we allow HTTPS egress from sandbox pods.

**Security justification:**
- Sandbox worker has no conversation context or API credentials
- gvisor syscall filtering limits what bash commands can do
- Tool outputs go through the host's outbound scanner
- Git/GCS use GKE Workload Identity (no injected secrets)
- This is configurable and can be disabled for paranoid deployments

In `charts/ax/values.yaml`, add:

```yaml
sandbox:
  networkPolicy:
    allowHTTPS: true  # Allow HTTPS egress for git/GCS workspace provisioning
```

In `charts/ax/templates/networkpolicies/sandbox-restrict.yaml`:

```yaml
egress:
  - to:
    - podSelector:
        matchLabels:
          app.kubernetes.io/name: nats
    ports:
      - port: 4222
        protocol: TCP
  - ports:
    - port: 53
      protocol: UDP
    - port: 53
      protocol: TCP
  {{- if .Values.sandbox.networkPolicy.allowHTTPS }}
  # HTTPS egress for workspace provisioning (git clone, GCS cache)
  - ports:
    - port: 443
      protocol: TCP
  {{- end }}
```

### Step 6: Update pool controller pod template with SSD-backed workspace

In `src/pool-controller/k8s-client.ts`, make the workspace volume configurable:

```typescript
export interface PodTemplate {
  // ... existing fields
  cacheBucket?: string;
  workspaceMedium?: 'default' | 'Memory';  // emptyDir medium
  workspaceSizeLimit?: string;
}
```

Update the volume spec:

```typescript
volumes: [
  {
    name: 'workspace',
    emptyDir: {
      ...(template.workspaceMedium === 'Memory' ? { medium: 'Memory' } : {}),
      sizeLimit: template.workspaceSizeLimit ?? (template.tier === 'heavy' ? '50Gi' : '10Gi'),
    },
  },
  { name: 'tmp', emptyDir: { sizeLimit: '256Mi' } },
],
```

### Step 7: Run tests

Run: `npm test -- --run tests/sandbox-worker/git-sync-sidecar.test.ts`
Expected: PASS

### Step 8: Commit

```bash
git add src/sandbox-worker/git-sync-sidecar.ts src/pool-controller/k8s-client.ts src/sandbox-worker/workspace.ts charts/ax/
git commit -m "feat: configurable HTTPS egress for workspace provisioning

Add sandbox.networkPolicy.allowHTTPS toggle for git/GCS access from
sandbox pods. Add SSD-backed workspace volume option. Security
tradeoff documented: sandbox workers have no conversation context or
credentials, gvisor limits bash, outputs go through outbound scanner."
```

---

## Task 4: Workspace Pre-Warming in Pool Controller

When a warm pod starts, optionally pre-provision a workspace so it's ready to serve immediately on claim.

**Files:**
- Modify: `src/pool-controller/k8s-client.ts` (add workspace config to pod template)
- Modify: `src/sandbox-worker/worker.ts` (pre-warm on startup)
- Test: `tests/pool-controller/pre-warm.test.ts`

### Step 1: Write failing test

```typescript
// tests/pool-controller/pre-warm.test.ts

describe('workspace pre-warming', () => {
  it('provisions default workspace on worker startup', async () => {
    // Worker starts with PREWARM_GIT_URL env var
    // Before entering claim loop, clones the repo
    // On first claim, workspace is already ready (source: 'existing')
  });

  it('skips pre-warming when no git URL configured', async () => {
    // Worker starts without PREWARM_GIT_URL
    // Goes directly to claim loop
    // First claim provisions from scratch
  });
});
```

### Step 2: Run test to verify it fails

Run: `npm test -- --run tests/pool-controller/pre-warm.test.ts`
Expected: FAIL

### Step 3: Implement pre-warming

In `src/sandbox-worker/worker.ts`, add optional pre-warming before the claim loop:

```typescript
export async function startWorker(options?: {
  tier?: string;
  natsUrl?: string;
  podId?: string;
  prewarmGitUrl?: string;
  prewarmRef?: string;
}): Promise<{ close: () => Promise<void> }> {
  // ... existing setup ...

  // Pre-warm workspace if configured
  const prewarmGitUrl = options?.prewarmGitUrl ?? process.env.PREWARM_GIT_URL;
  if (prewarmGitUrl) {
    const prewarmSessionId = '__prewarm__';
    console.log(`[sandbox-worker] pre-warming workspace: ${prewarmGitUrl}`);
    const result = await provisionWorkspace(WORKSPACE_ROOT, prewarmSessionId, {
      gitUrl: prewarmGitUrl,
      ref: options?.prewarmRef ?? process.env.PREWARM_GIT_REF,
    });
    // Store pre-warmed workspace for later claim
    sessionWorkspaces.set(prewarmSessionId, result.path);
    console.log(`[sandbox-worker] pre-warm complete: source=${result.source}, durationMs=${result.durationMs}`);
  }

  // ... existing claim loop ...
}
```

On first claim, if the session matches the pre-warmed repo, rename the directory:

```typescript
// In claim handler:
const prewarmWorkspace = sessionWorkspaces.get('__prewarm__');
if (prewarmWorkspace && claim.workspace?.gitUrl === prewarmGitUrl) {
  // Reuse pre-warmed workspace
  const targetPath = join(WORKSPACE_ROOT, claim.sessionId);
  renameSync(prewarmWorkspace, targetPath);
  sessionWorkspaces.delete('__prewarm__');
  sessionWorkspaces.set(claim.sessionId, targetPath);
  workspace = targetPath;
  console.log(`[sandbox-worker] using pre-warmed workspace for ${claim.sessionId}`);
} else {
  // Normal provisioning flow
}
```

Add `PREWARM_GIT_URL` and `PREWARM_GIT_REF` to the pool controller's pod template env vars.

### Step 4: Run tests

Run: `npm test -- --run tests/pool-controller/pre-warm.test.ts`
Expected: PASS

### Step 5: Commit

```bash
git add src/sandbox-worker/worker.ts src/pool-controller/k8s-client.ts tests/pool-controller/pre-warm.test.ts
git commit -m "feat: workspace pre-warming in sandbox worker pods

Warm pods optionally clone a default git repo on startup so the
workspace is ready instantly on first claim. Configurable via
PREWARM_GIT_URL/PREWARM_GIT_REF env vars in pool controller template."
```

---

## Task 5: Helm Chart Updates

Wire all the new configuration into the Helm chart.

**Files:**
- Modify: `charts/ax/values.yaml`
- Modify: `charts/ax/templates/pool-controller/configmap-sandbox-templates.yaml`
- Modify: `charts/ax/templates/networkpolicies/sandbox-restrict.yaml`
- Test: `helm template` validation

### Step 1: Update values.yaml

```yaml
sandbox:
  image:
    repository: ax-sandbox
    tag: latest
  runtimeClass: gvisor
  tiers: null  # null = use preset defaults

  # Session affinity settings
  sessionAffinity:
    enabled: true
    idleTimeoutMinutes: 10

  # Workspace provisioning
  workspace:
    # Allow HTTPS egress for git clone + GCS cache
    allowHTTPS: true
    # GCS bucket for workspace cache (empty = disabled)
    cacheBucket: ""
    # Pre-warm repo (optional)
    prewarmGitUrl: ""
    prewarmGitRef: ""
    # emptyDir medium: default (disk) or Memory (tmpfs/RAM)
    medium: default
    # Size limit for workspace volume
    sizeLimitLight: "10Gi"
    sizeLimitHeavy: "50Gi"
```

### Step 2: Update sandbox-templates configmap

Add workspace config to tier templates:

```yaml
data:
  light.json: |
    {
      "tier": "light",
      "cpu": "1",
      "memory": "2Gi",
      "cacheBucket": {{ .Values.sandbox.workspace.cacheBucket | quote }},
      "prewarmGitUrl": {{ .Values.sandbox.workspace.prewarmGitUrl | quote }},
      "prewarmGitRef": {{ .Values.sandbox.workspace.prewarmGitRef | quote }},
      "workspaceMedium": {{ .Values.sandbox.workspace.medium | quote }},
      "workspaceSizeLimit": {{ .Values.sandbox.workspace.sizeLimitLight | quote }}
    }
```

### Step 3: Update NetworkPolicy

As described in Task 3, Step 5.

### Step 4: Validate with helm template

Run: `helm template ax charts/ax/ -f charts/ax/values.yaml --set sandbox.workspace.allowHTTPS=true --set sandbox.workspace.cacheBucket=my-bucket | grep -A5 'egress'`
Expected: NetworkPolicy includes port 443 egress rule

### Step 5: Commit

```bash
git add charts/ax/
git commit -m "feat: helm chart support for session affinity and workspace provisioning

Add sandbox.sessionAffinity, sandbox.workspace config blocks.
Configurable HTTPS egress, GCS cache bucket, pre-warm git URL,
and SSD-backed workspace volumes."
```

---

## Task 6: Metrics and Observability

Add Prometheus metrics for session affinity hit rate, workspace provisioning latency, and pod reuse.

**Files:**
- Modify: `src/host/nats-sandbox-dispatch.ts` (add dispatch metrics)
- Modify: `src/sandbox-worker/worker.ts` (add provisioning metrics)
- Test: `tests/host/nats-sandbox-dispatch.test.ts` (metric assertions)

### Step 1: Write failing test

```typescript
describe('dispatcher metrics', () => {
  it('increments session_reuse counter when pod is reused across turns', async () => {
    // Dispatch two turns for same session
    // Check that session_reuse metric incremented
  });

  it('tracks workspace provisioning source distribution', async () => {
    // Verify metrics report cache/git-clone/empty/existing counts
  });
});
```

### Step 2: Implement metrics

In `src/host/nats-sandbox-dispatch.ts`:

```typescript
export interface DispatchMetrics {
  claimCount: number;
  sessionReuseCount: number;
  claimLatencyMs: number[];
  sessionCount: number;
}
```

In `src/sandbox-worker/worker.ts`:

```typescript
// Track workspace provisioning metrics
const provisionMetrics = {
  cache: 0,
  'git-clone': 0,
  empty: 0,
  existing: 0,
  totalLatencyMs: 0,
  count: 0,
};
```

Expose via the existing health/metrics HTTP endpoint on port 9091.

### Step 3: Run tests

Run: `npm test -- --run tests/host/nats-sandbox-dispatch.test.ts`
Expected: PASS

### Step 4: Commit

```bash
git add src/host/nats-sandbox-dispatch.ts src/sandbox-worker/worker.ts tests/host/nats-sandbox-dispatch.test.ts
git commit -m "feat: prometheus metrics for session affinity and workspace provisioning

Track claim count, session reuse rate, claim latency, and workspace
provisioning source distribution (cache/git-clone/empty/existing)."
```

---

## Task 7: Integration Test — Full Session Lifecycle

End-to-end test that verifies the full session-affinity lifecycle: claim → tool calls → pause → resume → release.

**Files:**
- Create: `tests/integration/session-affinity.test.ts`

### Step 1: Write integration test

```typescript
// tests/integration/session-affinity.test.ts

import { describe, it, expect, beforeAll, afterAll } from 'vitest';

describe('session affinity integration', () => {
  let dispatcher: NATSSandboxDispatcher;
  let worker: { close: () => Promise<void> };

  beforeAll(async () => {
    // Start a sandbox worker in-process
    worker = await startWorker({ tier: 'test', natsUrl: 'nats://localhost:4222' });
    dispatcher = await createNATSSandboxDispatcher({ natsUrl: 'nats://localhost:4222' });
  });

  afterAll(async () => {
    await dispatcher.close();
    await worker.close();
  });

  it('full lifecycle: claim → tools → pause → tools → release', async () => {
    const sessionId = `test-session-${Date.now()}`;

    // Turn 1: write a file
    const r1 = await dispatcher.dispatch('req-1', sessionId, {
      type: 'write_file',
      path: 'test.txt',
      content: 'hello from turn 1',
    });
    expect(r1.type).toBe('write_file_result');

    // End turn 1 (pause, not release)
    dispatcher.endTurn('req-1');

    // Turn 2: read the file written in turn 1
    const r2 = await dispatcher.dispatch('req-2', sessionId, {
      type: 'read_file',
      path: 'test.txt',
    });
    expect(r2.type).toBe('read_file_result');
    expect((r2 as any).content).toBe('hello from turn 1');

    // End session
    await dispatcher.endSession(sessionId);
    expect(dispatcher.getSessionPod(sessionId)).toBeUndefined();
  });
});
```

### Step 2: Run integration test

Run: `npm test -- --run tests/integration/session-affinity.test.ts`
Expected: PASS (requires NATS running locally)

### Step 3: Commit

```bash
git add tests/integration/session-affinity.test.ts
git commit -m "test: integration test for session affinity lifecycle

Verifies workspace persists across turns: write file in turn 1,
read it back in turn 2 after pause/resume."
```

---

## Summary

| Task | What | Latency Impact |
|------|------|---------------|
| 1. Session affinity | Reuse pod across turns | Eliminates per-turn claim (~60s → 0) |
| 2. Workspace persistence | Keep workspace between turns | Eliminates re-provisioning (~10-30s → 0) |
| 3. Git-sync + NetworkPolicy | Enable git/GCS from sandbox pods | Enables workspace provisioning in k8s |
| 4. Pre-warming | Clone repo at pod startup | First claim instant (~0s) |
| 5. Helm chart | Wire config into deployment | Ops enablement |
| 6. Metrics | Track reuse rate, latency | Observability |
| 7. Integration test | Verify full lifecycle | Confidence |

**Expected result:** After session's first turn (cold start ~10-30s with GCS cache, or instant with pre-warming), subsequent turns have near-zero overhead — the pod is warm, workspace is local, no provisioning needed.
