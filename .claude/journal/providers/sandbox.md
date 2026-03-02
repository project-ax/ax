# Providers: Sandbox

Sandbox providers, canonical paths, workspace tiers.

## [2026-03-02 11:42] — Nest CANONICAL paths under /workspace, make mount root the CWD

**Task:** Fix bug where agent can't access ./agent and ./user from CWD because CWD was /scratch (a sibling, not a parent). Also fix userId mismatch in IPC context.
**What I did:** (1) Added `root: '/workspace'` to CANONICAL and nested all paths under /workspace. (2) Changed CWD/HOME in all 5 sandbox providers (docker, bwrap, nsjail, seatbelt, subprocess) from CANONICAL.scratch to CANONICAL.root/mountRoot. (3) Updated canonicalEnv to set AX_WORKSPACE to CANONICAL.root, symlinkEnv to set AX_WORKSPACE to mountRoot. (4) Added userId to IPCClientOptions and enrichment in ipc-client.ts. (5) Added _userId extraction in ipc-server.ts handleIPC. (6) Both runners (pi-session, claude-code) now pass userId to IPCClient. (7) Updated runtime prompt to reference ./scratch, ./agent, ./user. (8) Updated all tests.
**Files touched:** `src/agent/ipc-client.ts`, `src/host/ipc-server.ts`, `src/agent/runners/pi-session.ts`, `src/agent/runners/claude-code.ts`, `src/providers/sandbox/canonical-paths.ts`, `src/providers/sandbox/docker.ts`, `src/providers/sandbox/bwrap.ts`, `src/providers/sandbox/nsjail.ts`, `src/providers/sandbox/seatbelt.ts`, `src/providers/sandbox/subprocess.ts`, `src/agent/prompt/modules/runtime.ts`, `tests/` (6 files)
**Outcome:** Success — build clean, all 2007 tests pass
**Notes:** The key insight is that mount root (not scratch) must be the CWD so that ./scratch, ./agent, ./user are all accessible as relative paths.

## [2026-03-01 15:57] — Rename canonical paths: /agent→/identity, /shared→/agent

**Task:** Fix confusing mismatch between IPC tier name "agent" and mount path "/shared" by aligning the path to the tier name
**What I did:** (1) Renamed identity dir from `CANONICAL.agent` (`/agent`) to `CANONICAL.identity` (`/identity`). (2) Renamed workspace from `CANONICAL.shared` (`/shared`) to `CANONICAL.agent` (`/agent`). Updated canonical-paths.ts (constants, canonicalEnv, createCanonicalSymlinks, symlinkEnv), all 3 sandbox providers (docker, bwrap, nsjail), runtime prompt, and all related tests.
**Files touched:** `src/providers/sandbox/canonical-paths.ts`, `src/providers/sandbox/docker.ts`, `src/providers/sandbox/bwrap.ts`, `src/providers/sandbox/nsjail.ts`, `src/agent/prompt/modules/runtime.ts`, `tests/providers/sandbox/canonical-paths.test.ts`, `tests/agent/prompt/enterprise-runtime.test.ts`
**Outcome:** Success — build clean, all 2005 tests pass, zero stale `/shared` or `CANONICAL.shared` references remain
**Notes:** The existing `CANONICAL.agent` was occupied by the identity directory, so we needed a two-step swap: identity `/agent`→`/identity`, then workspace `/shared`→`/agent`.
