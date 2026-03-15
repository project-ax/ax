# Agent 4 Report — Workspace + GCS Mounting (Apple vs k8s)

## 1) Workspace scopes model

AX workspace provider uses logical scopes:

- `agent`
- `user`
- `session` (mapped to scratch semantics)

The host pre-mounts `agent`, `user`, and `session` on request start when workspace provider is active.

## 2) Host pre-mount flow

In completion handling, host does:

1. `providers.workspace.mount(sessionId, ['agent', 'user', 'session'], { userId })`
2. uses mounted `session` path as active scratch workspace when present
3. passes mounted paths into sandbox config for canonical mount wiring

This is the control point that unifies local and remote workspace backends.

## 3) GCS provider transport split

`src/providers/workspace/gcs.ts` has two transport modes:

### Local transport (non-k8s sandboxes, including Apple)

- on mount, host downloads GCS content into local directories
- snapshots file hashes
- diff/commit run from host-local mounted dirs
- sandbox sees those local dirs through volume mounts/symlinks

### Remote transport (k8s sandbox mode)

- provision handled by sandbox worker claim flow
- worker pulls scope prefixes from GCS into canonical mount paths in pod
- on release, worker uploads changed files to `_staging/<requestId>/<scope>/...`
- host-side workspace pipeline reads staged changes, applies approval/scanning, and commits to final scope prefix

## 4) How GCS-backed mounting differs for Apple containers vs k8s pods

### Apple container path

- Host mounts GCS-backed local directories first (workspace provider local transport).
- Apple container gets those directories via `-v <hostPath>:<canonicalPath>`.
- Reads/writes happen against mounted local cache paths on host.
- Commit to GCS happens from host workspace provider diff/commit pipeline.

### k8s pod path

- Host sends scope metadata (`gcsPrefix`, `readOnly`) in NATS claim.
- Sandbox worker provisions each canonical path directly from GCS (`gsutil rsync`) in pod.
- On release, worker computes diffs and uploads changed files to staging prefix in GCS.
- Host applies commit logic by promoting staged objects into final GCS scope prefix.

## 5) Session/scratch persistence behavior

`session` scope intentionally maps to scratch semantics:

- bucket folder uses `scratch/` naming for session scope
- in k8s mode, scratch survives pod restarts within the same conversation
- in local/Apple mode, persistence depends on mounted host scope lifecycle

## 6) Read-only policy integration

Scope claims include `readOnly`; worker/local mount behavior enforces permissions per scope.

This enables policies like:

- read-only agent workspace for non-admin users
- read-write user/session scopes when workspace provider enabled
