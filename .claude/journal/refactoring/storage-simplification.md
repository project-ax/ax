# Refactoring: Storage Architecture Simplification

## [2026-03-12 01:30] — Simplify storage architecture: Phases 1, 2, and 4

**Task:** Implement the storage architecture simplification plan — move identity files and skills from filesystem mounts to the DocumentStore, delete the file-based storage provider, and simplify canonical paths.

**What I did:**
- Phase 1: Added preloaded identity/skills to stdin payload (agent-side), DB loading helpers (host-side), dual-write IPC handlers, and one-time filesystem-to-DB migration
- Phase 2: Deleted `src/providers/storage/file.ts`, removed from provider-map, defaulted storage to `database` and database to `sqlite`
- Phase 4: Removed `skills` and `agentDir` from SandboxConfig, removed skills/identity canonical mounts from all sandbox providers, deleted `mergeSkillsOverlay()`

**Files touched:**
- Modified: runner.ts, identity-loader.ts, stream-utils.ts, agent-setup.ts, server-completions.ts, identity.ts (IPC handler), server.ts, provider-map.ts, config.ts, types.ts (sandbox), canonical-paths.ts, bwrap.ts, docker.ts, nsjail.ts, seatbelt.ts, ax.yaml fixture, SKILL.md (storage skill)
- Created: storage-migration.ts, server-completions.test.ts, storage-migration.test.ts
- Deleted: file.ts (storage), file.test.ts (storage)
- Test fixes: canonical-paths.test.ts, sandbox-isolation.test.ts, history-smoke.test.ts

**Outcome:** Success. All 205 test files pass (2376 tests). Canonical mount table reduced from 6 to 4. File storage provider eliminated. Overlayfs skills merge eliminated.

**Notes:** Initial attempt used parallel subagents which caused a git branch reset, losing all work. Redid with a single comprehensive agent. Phase 3 (hybrid sandbox lifecycle) deferred to separate task.
