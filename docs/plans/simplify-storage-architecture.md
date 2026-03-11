# Simplify Storage Architecture

**Date:** 2026-03-10
**Status:** Draft
**Branch:** `claude/simplify-storage-architecture-c7rUg`

## Problem

The filesystem/volume mount/data sync design is the most complex part of AX's architecture. Currently:

1. **6 canonical mount paths** (`/workspace`, `/workspace/scratch`, `/workspace/skills`, `/workspace/identity`, `/workspace/agent`, `/workspace/user`) with overlayfs, symlink fallbacks, and per-provider remapping
2. **Dual storage backends** (file + SQLite) that do the same thing
3. **Identity and skills live on filesystem** — requiring directory mounting, overlayfs merging, and canonical path translation to make them visible inside sandboxes
4. **Per-turn sandbox lifecycle** even when the agent just needs to make an LLM call and return text

This creates a lot of moving parts for what is conceptually simple: "give the agent its identity, skills, and a place to work."

## Design Decisions

1. **DB as source of truth** for identity and skills (eliminates filesystem mounting)
2. **Hybrid sandbox lifecycle** — lightweight for chat/web-fetch, full sandbox for code execution
3. **Drop the file-based StorageProvider** — the `DatabaseProvider` interface supports both SQLite (local/single-agent) and PostgreSQL (K8s/multi-tenant). This plan eliminates the *file-based* backend, not the choice of database engine. SQLite and Postgres remain interchangeable behind the `StorageProvider` contract.

## Architecture

### Phase 1: DB-Backed Identity & Skills (Biggest Win)

**Goal:** Identity files and skills live in the `DocumentStore` (SQLite `documents` table). Agents receive them via the stdin payload instead of filesystem mounts.

#### What changes

| Component | Before | After |
|-----------|--------|-------|
| Identity storage | `~/.ax/agents/<id>/agent/identity/*.md` files | `documents` table, collection='identity', key='<agentId>/<filename>' |
| Skills storage | `~/.ax/agents/<id>/agent/skills/*.md` + user overlay | `documents` table, collection='skills', key='<agentId>/<filename>' for agent-level, key='<agentId>/users/<userId>/<filename>' for user-level |
| Identity loading | `identity-loader.ts` reads from filesystem via `readFileSync` | `identity-loader.ts` reads from stdin payload (host loads from DB, sends via stdin) |
| Skills loading | `loadSkills()` reads `readdirSync` + `readFileSync` from mounted dir | Host loads from DB, sends merged skill list via stdin payload |
| Skill merging | overlayfs (Linux) or fallback (macOS) | DB query with user-level keys shadowing agent-level keys |
| Identity writes | IPC handler → writes to filesystem | IPC handler → writes to DocumentStore (already exists) |
| SandboxConfig | 7+ path fields | Remove `skills`, `agentDir`, `agentWorkspace`, `userWorkspace` |
| Canonical paths | 6 mounts | 2 mounts: `/workspace` (scratch) + IPC socket |

#### Key files to modify

- **`src/providers/storage/database.ts`** — No changes needed, DocumentStore already supports this
- **`src/host/server-completions.ts`** — Load identity + skills from DB, include in stdin payload. Remove `mergeSkillsOverlay` call, remove `agentDir`/`agentWorkspace`/`userWorkspace` from SandboxConfig
- **`src/agent/identity-loader.ts`** — Read from stdin payload instead of filesystem. Accept `IdentityFiles` object directly
- **`src/agent/stream-utils.ts`** — `loadSkills()` reads from stdin payload instead of filesystem
- **`src/agent/agent-setup.ts`** — Accept pre-loaded identity and skills instead of directory paths
- **`src/agent/runner.ts`** — Update `AgentConfig` to carry identity/skills data instead of paths
- **`src/providers/sandbox/types.ts`** — Slim down `SandboxConfig`
- **`src/providers/sandbox/canonical-paths.ts`** — Remove identity/skills/agent/user mounts, keep scratch + IPC
- **`src/host/ipc-handlers/identity.ts`** — Read/write identity via DocumentStore instead of filesystem
- **`src/host/ipc-handlers/skills.ts`** — Read/write skills via DocumentStore
- **`src/paths.ts`** — Deprecate `agentIdentityDir`, `agentIdentityFilesDir`, `agentSkillsDir`, `userSkillsDir`, `agentWorkspaceDir`, `userWorkspaceDir`

#### Stdin payload shape (expanded)

```typescript
interface AgentPayload {
  // ... existing fields (history, config, etc.)
  identity: {
    agents: string;    // AGENTS.md content
    soul: string;      // SOUL.md content
    identity: string;  // IDENTITY.md content
    user: string;      // USER.md content
    bootstrap: string;
    userBootstrap: string;
    heartbeat: string;
  };
  skills: Array<{
    name: string;
    description: string;
    content: string;   // full markdown content
    scope: 'agent' | 'user';
  }>;
}
```

#### Migration

- On first boot after upgrade, scan `~/.ax/agents/*/agent/identity/*.md` and `~/.ax/agents/*/agent/skills/*.md` and import into DocumentStore
- Migration runs once, writes a `migrated_storage_v1` flag to DB
- After migration, filesystem files become inert (not deleted, just ignored)

#### Skill merge logic (replaces overlayfs)

```sql
-- Agent-level skills
SELECT key, content FROM documents
WHERE collection = 'skills' AND key LIKE '<agentId>/%' AND key NOT LIKE '<agentId>/users/%'

-- User-level skills (shadow agent-level by filename)
SELECT key, content FROM documents
WHERE collection = 'skills' AND key LIKE '<agentId>/users/<userId>/%'
```

User-level skills with the same filename override agent-level. Pure DB query, no overlayfs.

### Phase 2: Drop File-Based StorageProvider

**Goal:** Remove `src/providers/storage/file.ts` and all file-based storage code.

#### What changes

- Delete `src/providers/storage/file.ts`
- Remove file-storage config option from `providers.storage` in config schema
- Remove file-storage paths from `src/paths.ts` (`dataFile('messages/pending')`, `dataFile('conversations')`, etc.)
- Update `src/providers/storage/index.ts` to only export database provider
- SQLite is already the default — this just removes dead code

#### Migration

- If `~/.ax/data/messages/`, `~/.ax/data/conversations/`, or `~/.ax/data/sessions/` exist, run a one-time import into SQLite, then ignore the directories

### Phase 3: Hybrid Sandbox Lifecycle

**Goal:** Most turns don't need a sandbox at all. Only spawn one when the agent needs to execute code.

> **Deployment-specific behavior:** This phase applies differently depending on the deployment mode.
>
> - **Local (single-user):** The host process handles lightweight turns directly — running LLM calls and IPC tools without spawning an agent process. This is the "fast path" described below.
> - **K8s (multi-tenant):** Lightweight turns still route through `ax-agent-runtime` pods (per the [K8s agent compute architecture](2026-03-04-k8s-agent-compute-architecture.md)). The agent-runtime pod handles the LLM call and IPC tools — the host never runs LLM calls directly. The optimization here is that the agent-runtime pod skips sandbox creation for lightweight turns, not that we bypass agent-runtime entirely. This preserves the invariant that the host pod is stateless ingress only.
>
> In both modes, the **turn classification** and **session sandbox pool** logic are identical — the difference is only *where* the lightweight turn executes.

#### Turn classification

```
Inbound message
    ↓
Does this turn require code execution?
    ├─ NO  → "lightweight turn" (no sandbox)
    │         Local:  host handles directly
    │         K8s:    agent-runtime handles, no sandbox spawned
    └─ YES → "sandbox turn" (spawn or reuse session sandbox)
```

**Lightweight turn (no sandbox):**
- LLM call runs directly (local: host process, K8s: agent-runtime pod)
- IPC tools (web fetch, memory, identity read/write, skills) handled without sandbox
- No filesystem workspace needed
- Agent sandbox process not spawned
- Conversation history loaded from DB, response saved to DB

**Sandbox turn (session-scoped sandbox):**
- Full sandbox spawned (or reused from session pool)
- Workspace mounted as `/workspace/scratch` (only scratch needed now — identity/skills come via payload)
- Sandbox persists for the session duration (not per-turn)
- Supports: code execution, file creation, package installation
- Session sandbox pool: keyed by `persistentSessionId`, with idle timeout

#### Decision heuristic

The host decides before spawning:

1. **Agent type**: `pi-coding-agent` with code execution tools → sandbox. `pi-session` with chat-only tools → lightweight.
2. **Tool catalog**: If the agent's tool catalog includes `bash`, `write_file`, `read_file` → sandbox. If only `web_fetch`, `memory_*`, `identity_*`, `skills_*` → lightweight.
3. **Config override**: `config.sandbox.mode: 'always' | 'auto' | 'never'` — explicit control.

#### Session-scoped sandbox pool

```typescript
interface SandboxSession {
  sessionId: string;
  process: SandboxProcess;
  workspace: string;
  lastUsedAt: number;
  idleTimeoutMs: number;  // default: 5 minutes
}
```

- On sandbox turn: check pool for existing session sandbox → reuse, or spawn new
- Idle sandboxes killed after timeout
- Session end (channel disconnect, explicit close) → kill sandbox, clean workspace
- K8s: maps to pod affinity by sessionId (extends existing NATS dispatcher pattern)

#### Key files to modify

- **`src/host/server-completions.ts`** — Add turn classification. For lightweight turns, call LLM directly without spawning agent process. For sandbox turns, use session pool.
- **`src/providers/sandbox/types.ts`** — Add `SandboxPool` interface
- **`src/host/sandbox-pool.ts`** (new) — Session-scoped sandbox lifecycle management
- **`src/types.ts`** — Add `sandbox.mode` config field

### Phase 4: Simplify Canonical Paths

**Goal:** With identity/skills served via DB and lightweight turns skipping sandbox entirely, the mount table collapses.

#### Before (6 mounts)
```
/workspace           — CWD/HOME
/workspace/scratch   — Session working files
/workspace/skills    — Merged skills (overlayfs)
/workspace/identity  — SOUL.md, AGENTS.md, etc.
/workspace/agent     — Agent shared workspace
/workspace/user      — Per-user persistent storage
```

#### After (2 mounts)
```
/workspace           — CWD/HOME + scratch
/workspace/ipc       — IPC socket (or via env var)
```

Identity, skills, agent workspace, and user workspace are all served via the stdin payload or IPC calls. No filesystem mounting needed.

#### SandboxConfig (simplified)
```typescript
interface SandboxConfig {
  workspace: string;      // scratch directory (rw)
  ipcSocket: string;      // IPC socket path
  command: string[];      // agent command
  timeoutSec?: number;
  memoryMB?: number;
}
```

Down from 9+ fields to 5.

## Implementation Order

```
Phase 1 (identity/skills to DB)     ← biggest complexity reduction
  ↓
Phase 2 (drop file storage)          ← cleanup, removes dead code
  ↓
Phase 3 (hybrid sandbox lifecycle)   ← performance win, requires Phase 1
  ↓
Phase 4 (simplify canonical paths)   ← cleanup, requires Phase 1
```

Phases 1 and 2 can be done together. Phase 4 is a natural consequence of Phase 1. Phase 3 is the most architecturally significant but depends on Phase 1 being done first (so identity/skills don't require mounts).

## What This Eliminates

| Component | Status |
|-----------|--------|
| `src/providers/storage/file.ts` | Deleted |
| `mergeSkillsOverlay()` (overlayfs) | Deleted |
| `createCanonicalSymlinks()` | Simplified (2 mounts) |
| `symlinkEnv()` | Simplified |
| `canonicalEnv()` | Simplified |
| Identity filesystem paths (`agentIdentityDir`, etc.) | Deprecated |
| Skills filesystem paths | Deprecated |
| 4 of 6 canonical mount paths | Removed |
| Dual storage backend branching | Removed |
| Sandbox-per-turn overhead for chat turns | Eliminated |

## What This Preserves

- **Security invariants**: No credentials in containers, taint tagging, audit logging
- **Provider contract pattern**: SandboxProvider, StorageProvider interfaces unchanged (just simplified implementations)
- **IPC protocol**: Identity/skills reads and writes still go through IPC handlers
- **All sandbox providers**: nsjail, bwrap, docker, k8s, seatbelt, subprocess — they just get simpler configs
- **Conversation history**: Unchanged (already DB-backed)
- **Message queue**: Unchanged (already DB-backed)

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| Large identity/skills content in stdin payload | Cap at 64KB per file (already enforced by `DEFAULT_MAX_CHARS`). Skills typically < 5KB each. |
| DB corruption loses identity | Daily SQLite backup (WAL checkpoint + copy). Migration preserves original files as fallback. |
| Lightweight turns can't handle unexpected tool calls | Turn classification is conservative — any code-execution tool in catalog → sandbox turn. Config override to force sandbox mode. |
| Session sandbox idle resource usage | Configurable idle timeout (default 5 min). Hard cap on concurrent session sandboxes. |
| Breaking existing `~/.ax/agents/` directory layout | Migration imports existing files. Directory structure preserved but becomes inert. |
