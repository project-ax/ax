# Workspace Provider

### Orchestrator must remember userId from mount for use during commit
**Date:** 2026-03-14
**Context:** User workspace changes weren't appearing in GCS. The orchestrator's `commit()` method built a `ScopeContext` without `userId`, so `scopeId('user', ctx)` fell back to `sessionId` instead of the actual user ID. The backend diffed the wrong directory and found no changes.
**Lesson:** Any state needed for commit (like `userId`) must be stored during `mount()` and retrieved during `commit()`. The workspace orchestrator's scope tracking (`sessionScopes`) and ID resolution (`sessionUserIds`) are separate maps — keep them in sync (both populated during mount, both cleaned during cleanup).
**Tags:** workspace, orchestrator, commit, userId, scope-resolution, shared.ts
