# Sandbox Dispatch

Local and NATS-based sandbox dispatching, lazy sandbox spawning.

## [2026-03-14 14:15] — Implement session scope workspace persistence for k8s

**Task:** Implement session-scoped workspace persistence so k8s pods share scratch files across turns
**What I did:** Added `CANONICAL.session` path, `sessionWorkspace` to SandboxConfig, session scope to SandboxClaimRequest/ReleaseResponse types, session-ws volume to k8s pod spec, session provisioning in sandbox worker, session mount in server-completions, session symlink in createCanonicalSymlinks, session in runtime prompt, and updated the ax skill docs.
**Files touched:** `src/providers/sandbox/canonical-paths.ts`, `src/providers/sandbox/types.ts`, `src/providers/sandbox/k8s.ts`, `src/sandbox-worker/types.ts`, `src/sandbox-worker/worker.ts`, `src/host/server-completions.ts`, `src/agent/runner.ts`, `src/agent/agent-setup.ts`, `src/agent/prompt/types.ts`, `src/agent/prompt/modules/runtime.ts`, `tests/sandbox-isolation.test.ts`, `.claude/skills/ax/provider-sandbox/SKILL.md`
**Outcome:** Success — all 2446 tests pass (5 new session scope tests)
**Notes:** Session scope uses the workspace provider's existing orchestrator — `scopeId('session', ctx)` resolves to `sessionId`. The GCS backend's `buildGcsPrefix()` handles all scopes equally. The sandbox worker's `provisionScope()` is already parameterized. This was mostly wiring — the infrastructure was ~80% ready.

## [2026-03-14 13:50] — Fix workspace commit dropping user scope changes

**Task:** User workspace changes not appearing in GCS after end-of-turn commit
**What I did:** Root cause: `shared.ts` orchestrator stored `userId` during `mount()` but didn't remember it for `commit()`. The commit built a `ScopeContext` without `userId`, so `scopeId('user', ctx)` fell back to `sessionId` instead of `userId`. This meant `backend.diff('user', sessionId)` instead of `backend.diff('user', 'alice')` — wrong directory, no changes found, nothing committed. Fix: added `sessionUserIds` map to the orchestrator, populated during mount(), used during commit(), cleaned up during cleanup(). Added 3 tests.
**Files touched:** `src/providers/workspace/shared.ts`, `tests/providers/workspace/shared.test.ts`
**Outcome:** Success — all 2442 tests pass
**Notes:** The `agent/assistant/scratch/` in GCS is a leftover from the previous behavior where workspaceMap pointed at agentWsPath — all writes went to the agent workspace, including scratch files. The user should clear that from the bucket.

## [2026-03-14 13:25] — Fix agent/user workspace visibility in sandbox tools

**Task:** Agent couldn't see user/ and agent/ directories via sandbox tools (bash, read_file, etc.)
**What I did:** Root cause: processCompletion stored the scratch workspace dir in workspaceMap, but agent/ and user/ symlinks were only created inside the sandbox provider's spawn() (local to that scope). Sandbox tool IPC handlers used workspaceMap as CWD, so they had no sibling agent/user dirs. Fix: (1) Create a symlink mountRoot in processCompletion using createCanonicalSymlinks, store it in workspaceMap so sandbox tools see scratch/, agent/, user/ as siblings. (2) Added hasAgentWorkspace/hasUserWorkspace to PromptContext so the runtime prompt tells the LLM about these directories. (3) Cleanup mountRoot in finally block.
**Files touched:** `src/host/server-completions.ts`, `src/agent/prompt/types.ts`, `src/agent/prompt/modules/runtime.ts`, `src/agent/agent-setup.ts`, `tests/host/ipc-handlers/sandbox-tools.test.ts`
**Outcome:** Success — all 2439 tests pass (5 new tests for workspace tier access via symlinks)
**Notes:** The sandbox provider also creates its own mountRoot for the agent subprocess — that's fine, the agent subprocess and the host-side tool handlers each get their own symlink layout pointing to the same real directories.

## [2026-03-14 12:05] — Create LocalSandboxDispatcher for lazy sandbox spawning

**Task:** Implement LocalSandboxDispatcher that mirrors NATSSandboxDispatcher pattern for local sandbox modes
**What I did:** Created `src/host/local-sandbox-dispatch.ts` with factory function pattern (closure-based, no `this` binding). For container types (apple/docker), lazily spawns sandbox on first `ensureSandbox()` call. For subprocess/seatbelt, `ensureSandbox()` is a no-op. Added `getSandboxProcess()` accessor for later integration. Created comprehensive test suite with 11 tests covering all sandbox types, reuse, release, and close.
**Files touched:** `src/host/local-sandbox-dispatch.ts` (created), `tests/host/local-sandbox-dispatch.test.ts` (created)
**Outcome:** Success — all 11 tests pass
**Notes:** Used closure pattern (not class) to match NATSSandboxDispatcher style. Delete from map before kill() in release() so hasSandbox returns false even on throw. Promise.allSettled in close() so one failure doesn't block others.
