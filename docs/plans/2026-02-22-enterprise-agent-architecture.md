# Enterprise Agent Architecture

> **Purpose:** Defines how ax evolves from single-user ephemeral agents to long-lived, multi-user shared agents deployable on stateless Kubernetes pods. Covers filesystem layout, sandbox mounts, identity evolution, memory scoping, artifact management, and governance model.

---

## 1. Design Principles

**Agent as logical entity.** An agent's identity (personality, memory, skills, workspace) persists in shared storage. The process serving it is ephemeral — any pod can serve any agent at any time.

**Blast radius determines governance.** Changes that affect all users (SOUL.md, shared workspace, org memory) require governance proportional to the security profile. Changes that affect one user (USER.md, user workspace, user memory) are always free. Session-scoped state has no restrictions.

**No magic filesystems.** The agent sees a simple, predictable directory layout. No overlayfs, no copy-on-write surprises. Two readable trees (shared + user), one writable tree (user), clear boundaries.

**IPC is the control plane.** The agent process never writes directly to shared state. All writes that cross scope boundaries go through IPC, where the host enforces governance, runs scanners, checks quotas, and logs to the audit trail.

---

## 2. Storage Architecture

### Infrastructure

All state lives on the local filesystem under `~/.ax/` (or `AX_HOME`). The directory layout is designed so that a future migration to Kubernetes only requires swapping the local filesystem for a shared one (NFS/EFS) — no structural changes needed.

```
Local Filesystem (~/.ax/)
├── Agent identity files
├── Agent shared workspace
├── Per-user workspaces
├── Per-user identity (USER.md)
└── Session scratch dirs

Future (k8s): mount ~/.ax/ on NFS/EFS across all pods.
              Any pod can serve any agent — same layout, shared storage.
```

### Filesystem Layout

```
~/.ax/
├── agents/<agent-id>/
│   │
│   │  # AGENT'S OWN FILES (the agent's "self")
│   ├── agent/
│   │   ├── SOUL.md              ← personality, tone, boundaries
│   │   ├── IDENTITY.md          ← name, role, capabilities
│   │   ├── AGENTS.md            ← operating instructions
│   │   ├── HEARTBEAT.md         ← scheduled task checklist
│   │   ├── capabilities.yaml    ← capability declarations
│   │   └── workspace/           ← shared code, docs, skills
│   │       ├── repo/
│   │       ├── docs/
│   │       └── skills/
│   │
│   │  # PER-USER STATE (isolated per user, never cross-visible)
│   └── users/<userId>/
│       ├── USER.md              ← user preferences, style, context
│       └── workspace/           ← user's persistent files
│           ├── my-report.md
│           └── notes/
│
│  # PER-SESSION SCRATCH (ephemeral, deleted on session end)
└── scratch/<session-id>/
    ├── work/
    └── tmp/
```

---

## 3. Agent View (Sandbox Mounts)

The agent process sees a clean, predictable filesystem. No overlay merging — two readable trees and one writable tree:

```
/
├── workspace/                ← rw, user's persistent workspace, cwd
│   ├── my-report.md
│   ├── notes/
│   └── repo/                 ← user's own clone (if applicable)
│
├── shared/                   ← ro, agent's shared workspace
│   ├── repo/                 ← canonical source
│   ├── docs/
│   └── skills/
│
├── .ax/                      ← ro, identity files
│   ├── SOUL.md
│   ├── IDENTITY.md
│   ├── AGENTS.md
│   ├── HEARTBEAT.md
│   └── USER.md               ← current user only
│
└── tmp/                      ← rw, session scratch (ephemeral)
```

### Mount Table

| Agent sees | Host path | Access |
|---|---|---|
| `/workspace/` | `~/.ax/agents/<id>/users/<uid>/workspace/` | rw |
| `/shared/` | `~/.ax/agents/<id>/agent/workspace/` | ro |
| `/.ax/SOUL.md` | `~/.ax/agents/<id>/agent/SOUL.md` | ro |
| `/.ax/IDENTITY.md` | `~/.ax/agents/<id>/agent/IDENTITY.md` | ro |
| `/.ax/AGENTS.md` | `~/.ax/agents/<id>/agent/AGENTS.md` | ro |
| `/.ax/HEARTBEAT.md` | `~/.ax/agents/<id>/agent/HEARTBEAT.md` | ro |
| `/.ax/USER.md` | `~/.ax/agents/<id>/users/<uid>/USER.md` | ro |
| `/tmp/` | `~/.ax/scratch/<session-id>/` | rw |
| `/tmp/ax-ipc/proxy.sock` | host IPC socket | rw |

### Key Properties

- **`/workspace/` is the agent's cwd.** All tool calls (bash, read_file, write_file) default here.
- **`/shared/` is read-only.** The agent copies what it needs into `/workspace/` explicitly.
- **Identity files in `/.ax/`** are loaded into the system prompt at session start. The agent rarely reads them directly.
- **`/tmp/`** is session-scoped scratch. Truly ephemeral. Deleted on session end.
- **Only the current user's subtree is mounted.** Other users' directories are invisible to the agent process.
- **No network access.** Enforced by sandbox (nsjail `--clone_newnet`, bwrap `--unshare-net`, docker `--network=none`, seatbelt deny rules).

---

## 4. File Ownership & Governance

### Who Can Modify What

Files are categorized by who seeds them, who evolves them, and what governance applies:

| File | Seeded By | Evolved By | Scope | Governance |
|---|---|---|---|---|
| `SOUL.md` | Admin | Agent | all users | Profile-based |
| `IDENTITY.md` | Admin | Agent | all users | Profile-based |
| `AGENTS.md` | Admin | Admin | all users | Admin only |
| `HEARTBEAT.md` | Admin | Admin | all users | Admin only |
| `agent/workspace/` | Admin/CI | Admin + Agent | all users | Profile-based (agent writes) |
| `USER.md` | Agent | Agent | one user | Free |
| `users/<uid>/workspace/` | User + Agent | User + Agent | one user | Free |
| Org memory | Admin + Agent | Agent | all users | Profile-based |
| User memory | Agent | Agent | one user | Free |
| Session memory | Agent | Agent | one session | Free |
| Skills | Admin + Agent | Admin (approval) | all users | Admin approval always |

### Security Profile Governance Matrix

| Resource | paranoid | balanced | yolo |
|---|---|---|---|
| SOUL.md / IDENTITY.md | Agent proposes → admin approves | Agent proposes → admin notified | Agent writes freely, audit logged |
| agent/workspace/ writes | Agent proposes → admin approves | Agent writes + admin notified | Agent writes + audit logged |
| Org-scoped memory | Agent proposes → admin approves | Agent writes, admin can review | Agent writes freely |
| User-scoped resources | Free | Free | Free |
| Session-scoped resources | Free | Free | Free |
| Skills | Propose → admin approves | Propose → admin approves | Propose → admin approves |

**Skills always require admin approval** regardless of profile, because they introduce new capabilities into the agent's toolkit.

---

## 5. Identity Evolution

### The Model

Agent identity files (SOUL.md, IDENTITY.md) are **admin-seeded, agent-evolved, governance-controlled**. The agent learns about itself through interactions and proposes refinements. The security profile determines whether proposals are auto-applied or require approval.

### Mechanism

The agent uses `identity_propose` (not direct `identity_write`) for shared identity files:

```
Agent process                              Host process (IPC)
─────────────                              ────────────
identity_propose(                      →   IPC handler
  file: "SOUL.md",                         1. Scanner check (injection patterns)
  diff: "...",                             2. Taint check (session contamination)
  reason: "Users prefer concise..."        3. Profile gate:
)                                             ├─ paranoid:  store proposal, notify admin
                                              ├─ balanced:  apply + notify admin
                                              └─ yolo:      apply + audit log
```

### Bootstrap Mode

For new agents (no SOUL.md yet, BOOTSTRAP.md present):

1. Admin creates agent with BOOTSTRAP.md (discovery prompt)
2. Agent receives BOOTSTRAP.md as system prompt instead of full identity
3. Agent writes SOUL.md and IDENTITY.md via `identity_write` (no governance gate during bootstrap)
4. BOOTSTRAP.md is deleted
5. Subsequent sessions use full identity system with governance

In enterprise deployments, bootstrap is typically an admin-run setup flow, not user-triggered.

### Per-User Personalization

USER.md is always freely writable by the agent. This is where per-user adaptation lives:

- Communication preferences ("User prefers terse responses")
- Role context ("User is a senior backend engineer")
- Learned patterns ("User always wants tests before merging")
- Personal context ("User's timezone is PST")

Each user's USER.md is invisible to other users and doesn't affect shared agent identity.

---

## 6. Memory Scoping

### Three Scopes

| Scope | Key | Visible To | Agent Writes | Governance |
|---|---|---|---|---|
| `org` | `org:<agent-id>` | All users of this agent | Via IPC | Profile-based |
| `user` | `user:<userId>` | One user only | Via IPC | Free |
| `session` | `session:<sessionId>` | One session only | Via IPC | Free |

### Isolation Rules

- Queries from User A never return User B's `user:*` memories
- The host enforces scope isolation on every `memory_query` and `memory_read` call
- Org memory contamination is the primary risk vector: User A teaches the agent something wrong, all 200 users get it
- Profile-based governance on org writes mitigates this: paranoid requires admin approval, balanced allows review

### Storage

The memory provider contract is storage-agnostic. The existing memory providers (SQLite, file, memu) work as-is — the change is adding scope awareness to the provider interface so the host can enforce isolation.

The memory provider must:
1. Accept a `scope` parameter on every write (`org`, `user:<uid>`, `session:<sid>`)
2. Filter by scope on every read/query (the host passes the current userId and sessionId; the provider must not return entries from other users' scopes)
3. Apply governance checks before writing to `org` scope (delegated to the host IPC handler, not the provider itself)

```typescript
// Extended MemoryProvider interface
interface MemoryProvider {
  write(entry: MemoryEntry): Promise<string>;       // entry includes scope
  query(opts: MemoryQuery): Promise<MemoryEntry[]>;  // opts includes allowed scopes
  read(id: string, scope: string): Promise<MemoryEntry | null>;
  list(scope: string, limit?: number): Promise<MemoryEntry[]>;
  delete(id: string, scope: string): Promise<void>;
}

interface MemoryEntry {
  id?: string;
  scope: string;           // 'org', 'user:<uid>', 'session:<sid>'
  content: string;
  tags?: string[];
  taint?: TaintTag;
  createdBy?: string;      // userId who triggered the write
  createdAt?: Date;
}

interface MemoryQuery {
  scopes: string[];        // host provides allowed scopes for this request
  query: string;
  limit?: number;
  tags?: string[];
}
```

For single-node deployments, the existing SQLite or file-based providers work fine with scope filtering. For future multi-pod deployments, a Postgres + pgvector provider can be swapped in without changing the interface.

---

## 7. Artifact Management

### Artifact Tiers

```
              Lifespan     Visible To          Example
              ────────     ──────────          ───────
/tmp/         session      this session        build output, temp files

/workspace/   permanent    this user + agent   reports, cloned repos,
                                               generated images, notes

/shared/      permanent    all users + agent   shared templates, canonical
              (ro to agent)                    docs, reference material
```

### IPC Tools

```typescript
// Save from scratch to user workspace — always allowed
artifact_save(
  source: "/tmp/work/report.pdf",       // path in scratch
  path: "reports/q4-summary.pdf"        // destination in user workspace
)

// Promote from user workspace to shared — governance-controlled
artifact_promote(
  path: "docs/ci-troubleshooting.md",   // path in user workspace
  destination: "docs/ci-runbook.md",    // path in shared workspace
  reason: "4 users asked about CI failures this week"
)
// → paranoid: proposal → admin approval
// → balanced: copy + admin notified
// → yolo: copy + audit logged

// Write directly to shared workspace — governance-controlled
workspace_write(
  path: "templates/onboarding.md",      // path in shared workspace
  content: "...",
  reason: "Created standard onboarding template"
)

// List/read across scopes
workspace_list(scope: "user" | "agent", path?: string)
workspace_read(scope: "user" | "agent", path: string)
```

### Promotion Flow

The typical lifecycle: agent creates a file in scratch during a session → saves to user workspace if worth keeping → later promotes to shared workspace if it benefits all users.

```
/tmp/ (scratch)  ──artifact_save──→  /workspace/ (user)  ──artifact_promote──→  /shared/ (agent)
     free                                  free                                governance-controlled
```

Promotion always copies, never moves. The user keeps their version.

---

## 8. Concurrency Model

### No Locks Needed

The architecture eliminates the need for per-agent locks:

- **Shared workspace** (`/shared/`) is read-only to agent processes. No concurrent write conflicts.
- **User workspace** (`/workspace/`) is scoped to one user. Sessions for the same user sharing the same workspace is the only collision risk — mitigated by the host routing concurrent requests for the same user sequentially.
- **Session scratch** (`/tmp/`) is per-session. Complete isolation.
- **Identity evolution** goes through IPC. The host process is the single writer, serialized naturally by Node.js event loop on a single node.
- **Memory writes** go through the memory provider via IPC. The provider handles its own consistency (SQLite WAL, file locks, etc.).

### Future: Multi-Pod Deployment

When deploying on Kubernetes with multiple replicas, the local filesystem is replaced with shared storage:

- Shared filesystem (NFS/EFS) mounted at `~/.ax/` on all pods
- Memory provider swapped to Postgres + pgvector (row-level locking handles concurrent writes)
- Identity file writes serialized via `pg_advisory_lock(hash(agent_id))` — brief lock, only for the actual file write
- Any pod can serve any agent — no sticky sessions required

The architecture is designed so this migration requires no structural changes — just swapping the storage backend and memory provider.

---

## 9. System Prompt Changes

### PromptContext Extensions

```typescript
interface PromptContext {
  // Existing fields unchanged...

  // New fields
  agentId: string;                    // agent identifier (not hardcoded "main")
  sharedWorkspacePath: string;        // mounted path to /shared/
  userWorkspacePath: string;          // mounted path to /workspace/
  scratchPath: string;                // mounted path to /tmp/
  sharedWorkspaceIndex?: string;      // directory listing of /shared/
  userWorkspaceIndex?: string;        // directory listing of /workspace/
}
```

### Module Changes

| Module | Change |
|---|---|
| **IdentityModule** (priority 0) | Add `renderWorkspaceContext()` section describing the three-tier filesystem, available tools, and promotion flow |
| **SecurityModule** (priority 10) | Add workspace ownership rules: never access other users' files, never write directly to shared workspace, always use IPC tools for cross-scope writes |
| **RuntimeModule** (priority 90) | Add filesystem layout to runtime snapshot: agent ID, user ID, cwd, workspace paths |
| **PromptContext** | Add `agentId`, workspace paths, directory indexes |
| **Identity Loader** | Update paths from `~/.ax/agents/main/` to `/.ax/agents/<id>/agent/` and `/.ax/agents/<id>/users/<uid>/` |

### New IPC Schemas

```typescript
// ipc-schemas.ts additions

WorkspaceWriteSchema = ipcAction('workspace_write', {
  path: safeString(1024),
  content: safeString(1_048_576),    // 1MB max
  reason: safeString(512),
});

ArtifactSaveSchema = ipcAction('artifact_save', {
  source: safeString(1024),           // path in /tmp/
  path: safeString(1024),             // destination in /workspace/
});

ArtifactPromoteSchema = ipcAction('artifact_promote', {
  path: safeString(1024),             // source in /workspace/
  destination: safeString(1024),      // destination in /shared/
  reason: safeString(512),
});

WorkspaceListSchema = ipcAction('workspace_list', {
  scope: z.enum(['agent', 'user']),
  path: safeString(1024).optional(),
});

WorkspaceReadSchema = ipcAction('workspace_read', {
  scope: z.enum(['agent', 'user']),
  path: safeString(1024),
});
```

### Sandbox Provider Updates

All sandbox providers (nsjail, seatbelt, bwrap, docker) need updated mount configurations:

```
# Before (current)
--bindmount     workspace          (rw)
--bindmount_ro  skills             (ro)
--bindmount_ro  agentDir           (ro)

# After (enterprise)
--bindmount     userWorkspace      (rw)   → /workspace/
--bindmount_ro  agentWorkspace     (ro)   → /shared/
--bindmount_ro  identityFiles      (ro)   → /.ax/
--bindmount     scratchDir         (rw)   → /tmp/
```

---

## 10. Access Control Summary

```
┌──────────────────────────┬───────┬────────┬─────────┬──────────────────┐
│ Resource                 │ Read  │ Write  │ Scope   │ Governance       │
├──────────────────────────┼───────┼────────┼─────────┼──────────────────┤
│ SOUL.md                  │ mount │ IPC    │ all     │ profile-based    │
│ IDENTITY.md              │ mount │ IPC    │ all     │ profile-based    │
│ AGENTS.md                │ mount │ admin  │ all     │ admin only       │
│ HEARTBEAT.md             │ mount │ admin  │ all     │ admin only       │
│ /shared/ (agent wksp)    │ mount │ IPC    │ all     │ profile-based    │
│ Skills                   │ mount │ IPC    │ all     │ admin approval   │
│ Org memory               │ IPC   │ IPC    │ all     │ profile-based    │
│ USER.md                  │ mount │ IPC    │ user    │ free             │
│ /workspace/ (user wksp)  │ mount │ direct │ user    │ free             │
│ User memory              │ IPC   │ IPC    │ user    │ free             │
│ /tmp/ (scratch)          │ direct│ direct │ session │ free             │
│ Session memory            │ IPC   │ IPC    │ session │ free             │
└──────────────────────────┴───────┴────────┴─────────┴──────────────────┘
```

---

## 11. Migration Path from Current Architecture

The current ax architecture is single-agent (`agents/main/`) with per-session workspaces. The migration to enterprise is incremental:

### Phase 1: Multi-Agent Registry
- Replace hardcoded `agents/main/` with `agents/<agent-id>/agent/`
- Add agent registry (JSON file or SQLite initially, swappable to Postgres later)
- Update `paths.ts` to resolve agent-scoped paths
- Update identity loader to accept `agentId` parameter

### Phase 2: User Isolation
- Move USER.md to `agents/<id>/users/<uid>/USER.md` (path already exists in current design)
- Add per-user workspace directories at `agents/<id>/users/<uid>/workspace/`
- Update sandbox providers to mount user workspace as `/workspace/` (rw) and agent workspace as `/shared/` (ro)
- Enforce userId scoping on all IPC handlers

### Phase 3: Memory Scoping
- Add `scope` field to memory provider interface
- Update existing memory providers (SQLite, file, memu) to filter by scope
- Add scope enforcement in IPC handler (host determines allowed scopes from userId/sessionId)
- Apply governance checks on `org` scope writes

### Phase 4: Governance Layer
- Add `identity_propose` IPC action (extend existing `identity_write` with proposal queue)
- Add `workspace_write`, `artifact_save`, `artifact_promote` IPC actions
- Add proposal storage (file-based or SQLite initially)
- Wire profile-based governance into all cross-scope write handlers
- Add admin CLI for proposal review

### Phase 5: Kubernetes Deployment (future)
- Swap local filesystem for shared NFS/EFS at `~/.ax/`
- Swap memory provider to Postgres + pgvector
- Swap proposal/registry storage to Postgres
- Stateless pods with updated sandbox mounts
- Advisory locks for identity file writes across pods
- Health checks, readiness probes, horizontal pod autoscaling
