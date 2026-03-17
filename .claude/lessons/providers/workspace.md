# Workspace Provider

### K8s RemoteTransport must use NATS IPC, not GCS staging — pods have no network
**Date:** 2026-03-16
**Context:** GCS RemoteTransport's `diff()` read from a `_staging/` GCS prefix that nothing wrote to, so `workspace.commit()` always found zero changes. Pods can't upload to GCS directly (no network security invariant). The fix: agent sends changes via NATS IPC `workspace_release` action to host, which stores them in memory. RemoteTransport.diff() returns and consumes stored changes.
**Lesson:** When designing cross-boundary data flows in k8s mode, always route through NATS IPC to the host process. Pods cannot reach external services (GCS, APIs) directly. The pattern: agent diffs locally → serializes via IPC → host stores/processes → host persists to external storage. Base64 encoding is necessary for binary-safe transport over NATS JSON payloads. Chunk at ~800KB to stay within NATS 1MB default max payload.
**Tags:** workspace, gcs, k8s, nats, remote-transport, no-network, ipc

### Orchestrator must remember userId from mount for use during commit
**Date:** 2026-03-14
**Context:** User workspace changes weren't appearing in GCS. The orchestrator's `commit()` method built a `ScopeContext` without `userId`, so `scopeId('user', ctx)` fell back to `sessionId` instead of the actual user ID. The backend diffed the wrong directory and found no changes.
**Lesson:** Any state needed for commit (like `userId`) must be stored during `mount()` and retrieved during `commit()`. The workspace orchestrator's scope tracking (`sessionScopes`) and ID resolution (`sessionUserIds`) are separate maps — keep them in sync (both populated during mount, both cleaned during cleanup).
**Tags:** workspace, orchestrator, commit, userId, scope-resolution, shared.ts
