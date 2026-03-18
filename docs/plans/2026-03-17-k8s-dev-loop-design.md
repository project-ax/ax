# K8s Dev Loop: Fast Iteration for Local Kind Clusters

**Date:** 2026-03-17
**Status:** Design

## Problem

The current k8s development workflow requires a full rebuild → docker build → kind load → pod restart cycle (~60s per iteration). There's no way to:
- Quickly test code changes in a real kind cluster
- Attach debuggers to sandbox pods
- Inspect the database
- Drive an automated debug/fix/retry loop from Claude Code

## Solution

Use **host volume mounts** to map the local `dist/` directory into kind nodes, so pods read code directly from the host filesystem. After `tsc`, changes are instantly visible — just restart the node process (not the pod) to pick them up.

## Architecture

### Volume Mount Chain

```
Host filesystem (dist/, templates/, skills/)
  ↓ kind extraMounts
Kind node (/ax-dev/dist, /ax-dev/templates, /ax-dev/skills)
  ↓ hostPath volumes
Pod containers (/opt/ax/dist, /opt/ax/templates, /opt/ax/skills)
```

### Dev Loop

```
edit code → tsc (~2s) → flush (~3s) → test → read logs → fix → repeat
```

Total iteration time: ~5-7s (down from ~60s).

## Components

### 1. Kind Cluster Config (generated)

`scripts/k8s-dev.sh setup` generates the kind config dynamically using `$(pwd)`:

```yaml
# Generated at runtime — not checked in
kind: Cluster
apiVersion: kind.x-k8s.io/v1alpha4
nodes:
  - role: control-plane
    extraMounts:
      - hostPath: ${PWD}/dist
        containerPath: /ax-dev/dist
      - hostPath: ${PWD}/templates
        containerPath: /ax-dev/templates
      - hostPath: ${PWD}/skills
        containerPath: /ax-dev/skills
  - role: worker
    extraMounts:
      - hostPath: ${PWD}/dist
        containerPath: /ax-dev/dist
      - hostPath: ${PWD}/templates
        containerPath: /ax-dev/templates
      - hostPath: ${PWD}/skills
        containerPath: /ax-dev/skills
```

### 2. Dev Helm Values Overlay

`charts/ax/kind-dev-values.yaml`:

```yaml
preset: "small"

imageDefaults:
  tag: latest
  pullPolicy: IfNotPresent

host:
  replicas: 1
  command: ["node", "--inspect=0.0.0.0:9229", "/ax-dev/dist/host/host-process.js"]
  extraVolumeMounts:
    - name: ax-dev-dist
      mountPath: /opt/ax/dist
    - name: ax-dev-templates
      mountPath: /opt/ax/templates
    - name: ax-dev-skills
      mountPath: /opt/ax/skills
  extraVolumes:
    - name: ax-dev-dist
      hostPath:
        path: /ax-dev/dist
    - name: ax-dev-templates
      hostPath:
        path: /ax-dev/templates
    - name: ax-dev-skills
      hostPath:
        path: /ax-dev/skills

poolController:
  replicas: 1
  command: ["node", "/ax-dev/dist/pool-controller/main.js"]
  extraVolumeMounts:
    - name: ax-dev-dist
      mountPath: /opt/ax/dist
    - name: ax-dev-templates
      mountPath: /opt/ax/templates
  extraVolumes:
    - name: ax-dev-dist
      hostPath:
        path: /ax-dev/dist
    - name: ax-dev-templates
      hostPath:
        path: /ax-dev/templates

sandbox:
  runtimeClass: ""  # no gVisor in kind
  tiers:
    light:
      minReady: 2
      maxReady: 5
      template:
        command: ["node", "/ax-dev/dist/agent/runner.js"]
        extraVolumeMounts:
          - name: ax-dev-dist
            mountPath: /opt/ax/dist
          - name: ax-dev-templates
            mountPath: /opt/ax/templates
          - name: ax-dev-skills
            mountPath: /opt/ax/skills
        extraVolumes:
          - name: ax-dev-dist
            hostPath:
              path: /ax-dev/dist
          - name: ax-dev-templates
            hostPath:
              path: /ax-dev/templates
          - name: ax-dev-skills
            hostPath:
              path: /ax-dev/skills
    heavy:
      minReady: 0
      maxReady: 1
      template:
        command: ["node", "/ax-dev/dist/agent/runner.js"]
        extraVolumeMounts:
          - name: ax-dev-dist
            mountPath: /opt/ax/dist
          - name: ax-dev-templates
            mountPath: /opt/ax/templates
          - name: ax-dev-skills
            mountPath: /opt/ax/skills
        extraVolumes:
          - name: ax-dev-dist
            hostPath:
              path: /ax-dev/dist
          - name: ax-dev-templates
            hostPath:
              path: /ax-dev/templates
          - name: ax-dev-skills
            hostPath:
              path: /ax-dev/skills

nats:
  config:
    cluster:
      replicas: 1
    jetstream:
      enabled: true

postgresql:
  internal:
    enabled: true
```

### 3. PodTemplate Extension (code change)

**`src/pool-controller/k8s-client.ts`** — extend the `PodTemplate` interface:

```typescript
export interface PodTemplate {
  // ... existing fields ...
  extraVolumes?: Array<{ name: string; hostPath?: { path: string }; emptyDir?: { sizeLimit?: string } }>;
  extraVolumeMounts?: Array<{ name: string; mountPath: string; subPath?: string; readOnly?: boolean }>;
}
```

In `createPod()`, spread extra volumes/mounts into the pod spec:

```typescript
volumes: [
  { name: 'scratch', emptyDir: { sizeLimit: ... } },
  { name: 'agent-ws', emptyDir: { sizeLimit: '10Gi' } },
  { name: 'user-ws', emptyDir: { sizeLimit: '10Gi' } },
  { name: 'tmp', emptyDir: { sizeLimit: '256Mi' } },
  ...(template.extraVolumes ?? []),
],

volumeMounts: [
  { name: 'scratch', mountPath: '/workspace/scratch' },
  { name: 'agent-ws', mountPath: '/workspace/agent' },
  { name: 'user-ws', mountPath: '/workspace/user' },
  { name: 'tmp', mountPath: '/tmp' },
  ...(template.extraVolumeMounts ?? []),
],
```

### 4. Helm Chart Changes

**`charts/ax/templates/pool-controller/deployment.yaml`** — add extraVolumes/extraVolumeMounts support (same pattern as host deployment).

**`charts/ax/templates/pool-controller/configmap-sandbox-templates.yaml`** — pass through `extraVolumes` and `extraVolumeMounts` from values into the sandbox tier template JSON.

### 5. Helper Script

`scripts/k8s-dev.sh` — single entry point with subcommands:

```bash
#!/usr/bin/env bash
# Usage: scripts/k8s-dev.sh <command> [args]
```

| Command | What it does | Time |
|---|---|---|
| `setup` | Generate kind config from `$(pwd)` → create cluster → `npm run build` → `docker build` → `kind load` → create namespace + secrets → `helm install` with dev values | ~3-5min (one-time) |
| `build` | `npm run build` (tsc only) | ~2s |
| `flush` | `kubectl delete pods -l ax.io/role=sandbox` — pool controller recreates from mount | ~3-5s |
| `flush all` | Above + `kubectl exec kill 1` in host/pool-controller containers to restart node processes | ~3-5s |
| `cycle` | build + flush | ~5-7s |
| `cycle all` | build + flush all | ~5-7s |
| `test "<msg>"` | curl POST to chat completions endpoint with given message, print response | varies |
| `logs [component]` | Tail logs — all, host, sandbox, or pool-controller | streaming |
| `status` | Pod status + warm pool pod count | instant |
| `debug sandbox` | Set ConfigMap flag → next sandbox pod starts with `--inspect-brk=0.0.0.0:9230` → watch for pod → port-forward 9230 → print "attach debugger now" | waits |
| `debug host` | Port-forward localhost:9229 to host pod (already running `--inspect`) | instant |
| `db` | Port-forward PostgreSQL service, open interactive psql session | instant |
| `db "<query>"` | Port-forward + run single SQL query, print results | instant |
| `db reset` | Drop and recreate the AX database (clean-state testing) | ~2s |
| `teardown` | Delete kind cluster | ~10s |

**`package.json`** addition:

```json
{
  "k8s:dev": "bash scripts/k8s-dev.sh"
}
```

### 6. Sandbox Debugger Flow (Option A)

1. `npm run k8s:dev debug sandbox` sets a debug annotation/env on the sandbox template ConfigMap
2. Pool controller detects the flag when creating the next pod
3. Next sandbox pod starts with `--inspect-brk=0.0.0.0:9230` (pauses at startup)
4. Script watches for the pod, port-forwards 9230 to localhost
5. User (or Claude Code) attaches Chrome DevTools or VS Code
6. Send a test request → that pod claims the work → execution pauses → debug
7. When done, script clears the flag and cleans up the port-forward

### 7. Setup Prerequisites

The `setup` command handles everything, but requires:
- `kind` installed (`brew install kind`)
- `helm` installed (`brew install helm`)
- `kubectl` installed (`brew install kubectl`)
- `docker` running
- `ANTHROPIC_API_KEY` set in environment (for the k8s secret)
- `psql` installed for `db` commands (`brew install postgresql`)

The script checks for these and prints actionable error messages for any missing dependency.

### 8. Initial Docker Build

The volume mounts overlay `dist/`, `templates/`, and `skills/` on top of the base container image. The base image still provides:
- Node.js runtime
- `node_modules/` (production dependencies)
- OS-level packages (git, etc.)

So `setup` still does one initial `docker build` + `kind load`. You only need to rebuild the Docker image when `package.json` dependencies change (rare). Day-to-day code iteration never touches Docker.

## Files to Create/Modify

| File | Action | Description |
|---|---|---|
| `scripts/k8s-dev.sh` | Create | Main entry-point script |
| `charts/ax/kind-dev-values.yaml` | Create | Dev Helm values overlay with hostPath mounts |
| `src/pool-controller/k8s-client.ts` | Modify | Add `extraVolumes`/`extraVolumeMounts` to `PodTemplate` + `createPod()` |
| `charts/ax/templates/pool-controller/deployment.yaml` | Modify | Add extraVolumes/extraVolumeMounts support |
| `charts/ax/templates/pool-controller/configmap-sandbox-templates.yaml` | Modify | Pass through extraVolumes from values |
| `package.json` | Modify | Add `k8s:dev` script |

## Claude Code Integration

With this setup, Claude Code can autonomously drive the debug loop:

```
1. Read error logs: npm run k8s:dev logs sandbox
2. Edit source file to fix the issue
3. npm run k8s:dev cycle          # build + flush (~5-7s)
4. npm run k8s:dev test "repro"   # send test request
5. npm run k8s:dev logs sandbox   # check if fix worked
6. If still broken, go to 2
```

For host-side issues, replace `cycle` with `cycle all` and `logs sandbox` with `logs host`.
