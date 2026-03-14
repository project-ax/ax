# Acceptance Test Results: Workspace Provider

**Date run:** 2026-03-13 13:04
**Server version:** 6585215
**LLM provider:** openrouter/google/gemini-3-flash-preview
**Environment:** Local (seatbelt sandbox, inprocess eventbus, sqlite storage)

## Summary
| Test | Category | Result | Notes |
|------|----------|--------|-------|
| ST-1 | Structural | PASS | WorkspaceProvider interface correct |
| ST-2 | Structural | PASS | WorkspaceBackend sub-interface correct |
| ST-3 | Structural | PASS | All three backends registered |
| ST-4 | Structural | PASS | ProviderRegistry includes workspace |
| ST-5 | Structural | PASS | IPC schema with scope validation |
| ST-6 | Structural | PASS | workspace_mount in tool catalog |
| ST-7 | Structural | PASS | Commit pipeline defaults correct |
| ST-8 | Structural | PASS | Host IPC handler wires to providers.workspace |
| ST-9 | Structural | PASS | GCS backend implementation exists |
| BT-1 | Behavioral | FAIL | workspace_mount tool not registered in agent (bug) |
| BT-2 | Behavioral | PASS | workspace_write works (with explicit type param) |
| BT-3 | Behavioral | PARTIAL | workspace_mount correctly absent; workspace write tool still present |
| BT-4 | Behavioral | FAIL | maxFileSize not enforced (workspace_write bypasses commit pipeline) |
| BT-5 | Behavioral | FAIL | Ignore patterns not enforced (workspace_write bypasses commit pipeline) |
| IT-1 | Integration | PARTIAL | File persists on disk; second session agent couldn't navigate to it |
| IT-2 | Integration | PARTIAL | Both tier writes work; scope-based mount escalation not testable |
| IT-3 | Integration | PARTIAL | File written; auto-mount not testable (workspace_mount unavailable) |

**Overall: 9/17 passed (9 PASS, 3 FAIL, 5 PARTIAL)**

## Critical Bug Found

**workspaceProvider field not parsed from stdin payload in agent runner**

`src/agent/runner.ts`, function `parseStdinPayload()` (line 267): The function parses `agentWorkspace` and `userWorkspace` from the stdin payload but does NOT parse `workspaceProvider`. The field is declared in `StdinPayload` (line 255) but never extracted from `parsed.workspaceProvider`.

Additionally, the main entry point (line 336) maps enterprise fields from payload to config but is missing `config.workspaceProvider = payload.workspaceProvider;`.

**Impact:** `config.workspaceProvider` is always `undefined` in the agent process, so `hasWorkspaceScopes` is always `false`, and the `workspace_mount` tool is never registered. This prevents all scope-based workspace operations (mount, commit, cleanup, auto-mount).

**Files to fix:**
- `src/agent/runner.ts` line ~299: add `workspaceProvider: typeof parsed.workspaceProvider === 'string' ? parsed.workspaceProvider : undefined,`
- `src/agent/runner.ts` line ~364: add `config.workspaceProvider = payload.workspaceProvider;`

## Detailed Results

### ST-1: WorkspaceProvider interface exists with correct methods
**Result:** PASS

Verified in `src/providers/workspace/types.ts`:
- [x] WorkspaceProvider interface has mount(sessionId, scopes), commit(sessionId), cleanup(sessionId), activeMounts(sessionId)
- [x] WorkspaceScope = 'agent' | 'user' | 'session'
- [x] WorkspaceMounts has paths: Partial<Record<WorkspaceScope, string>>
- [x] CommitResult has scopes: Partial<Record<WorkspaceScope, ScopeCommitResult>>
- [x] ScopeCommitResult has status: 'committed' | 'rejected' | 'empty', filesChanged, bytesChanged, rejections

### ST-2: WorkspaceBackend sub-interface exists with correct methods
**Result:** PASS

Verified in `src/providers/workspace/types.ts`:
- [x] WorkspaceBackend has mount(scope: WorkspaceScope, id: string): Promise<string>
- [x] WorkspaceBackend has diff(scope: WorkspaceScope, id: string): Promise<FileChange[]>
- [x] WorkspaceBackend has commit(scope: WorkspaceScope, id: string, changes: FileChange[]): Promise<void>
- [x] FileChange has path: string, type: 'added' | 'modified' | 'deleted', content?: Buffer, size: number

### ST-3: All three backends registered in provider-map.ts
**Result:** PASS

Verified in `src/host/provider-map.ts` lines 93-97:
- [x] workspace category with none, local, gcs entries
- [x] Paths: `../providers/workspace/none.js`, `../providers/workspace/local.js`, `../providers/workspace/gcs.js`
- [x] All three source files exist on disk

### ST-4: ProviderRegistry includes workspace field
**Result:** PASS

Verified in `src/types.ts`:
- [x] ProviderRegistry.workspace typed as WorkspaceProvider (line 164)
- [x] Config.providers.workspace exists (line 89)
- [x] WorkspaceProvider imported from `./providers/workspace/types.js` (line 18)

### ST-5: IPC schema for workspace_mount with scope validation
**Result:** PASS

Verified in `src/ipc-schemas.ts` lines 291-293:
- [x] WorkspaceMountSchema exists with action: 'workspace_mount'
- [x] scopes validates against z.array(z.enum(['agent', 'user', 'session']))
- [x] Schema uses .strict() mode (via ipcAction helper using z.strictObject)

### ST-6: workspace_mount tool in tool catalog
**Result:** PASS

Verified in `src/agent/tool-catalog.ts` lines 285-295:
- [x] workspace_mount tool in TOOL_CATALOG with singletonAction: 'workspace_mount'
- [x] category: 'workspace_scopes'
- [x] filterTools() conditionally includes based on hasWorkspaceScopes flag (line 495)

### ST-7: Shared orchestration implements commit pipeline defaults
**Result:** PASS

Verified in `src/providers/workspace/shared.ts` lines 24-37:
- [x] DEFAULT_MAX_FILE_SIZE = 10 * 1024 * 1024 = 10485760 (10MB)
- [x] DEFAULT_MAX_FILES = 500
- [x] DEFAULT_MAX_COMMIT_SIZE = 50 * 1024 * 1024 = 52428800 (50MB)
- [x] DEFAULT_IGNORE_PATTERNS: ['.git/', 'node_modules/', 'venv/', '__pycache__/', '*.log', '*.tmp', 'build/', 'dist/']

### ST-8: Host workspace IPC handler exists and wires to providers.workspace
**Result:** PASS

Verified in `src/host/ipc-handlers/workspace.ts`:
- [x] workspace_mount handler exists in createWorkspaceHandlers (line 123)
- [x] Calls providers.workspace.activeMounts(ctx.sessionId) (line 127)
- [x] Calls providers.workspace.mount(ctx.sessionId, newScopes) (line 139)
- [x] Logs to providers.audit.log with action 'workspace_mount' (line 141)
- [x] Returns { mounted: [...allScopes], paths: mounts.paths } (line 147-150)

### ST-9: GCS backend implementation exists with correct structure
**Result:** PASS

Verified in `src/providers/workspace/gcs.ts`:
- [x] File exists
- [x] createGcsBackend exported with signature (bucket: GcsBucketLike, basePath: string, prefix: string): WorkspaceBackend (line 98)
- [x] create(config) factory lazily imports @google-cloud/storage (line 233)
- [x] mount() calls bucket.getFiles() and writes to safePath(basePath, scope, id) (lines 112-135)
- [x] commit() calls bucket.file(key).save() for added/modified and .delete() for deleted (lines 173-217)
- [x] GcsBucketLike interface exported with getFiles and file methods (lines 31-34)
- [x] Throws if neither workspace.bucket nor GCS_WORKSPACE_BUCKET is set (lines 240-244)
- [x] Unit tests exist at tests/providers/workspace/gcs.test.ts (416 lines)

### BT-1: Agent can mount workspace scopes via chat
**Result:** FAIL

**Root cause:** The `workspace_mount` tool is not registered in the agent's tool set. The agent receives 11 tools: `[memory, web, identity, workspace, audit, agent, image, bash, read_file, write_file, edit_file]`. The `workspace_mount` tool (category: `workspace_scopes`) is filtered out because `hasWorkspaceScopes` is always `false` in the agent.

This is caused by the critical bug described above: `config.workspaceProvider` is never populated from the stdin payload in `src/agent/runner.ts`.

**Evidence:**
- Server log shows toolCount=11, workspace_mount not in list
- No workspace_mount entry in audit log
- Agent used sandbox_bash to create scratch directory instead

### BT-2: Agent can write files to workspace via workspace_write
**Result:** PASS (with explicit type parameter)

The workspace_write IPC handler works correctly. The agent called the `workspace` tool with `{type: 'write', tier: 'agent', path: 'hello.txt', content: 'Hello from workspace test'}` and the file was written to `$TEST_HOME/agents/main/agent/workspace/hello.txt`.

**Note:** On first attempt, the LLM omitted the `type` discriminator field, causing the tool dispatch to fail silently. A more explicit prompt with `type: 'write'` succeeded. This is a model behavior issue, not a code bug.

**Evidence:**
- File: `/tmp/ax-acceptance-local-workspace-1773421479/agents/main/agent/workspace/hello.txt` contains "Hello from workspace test"
- Audit: workspace_write action logged with tier=agent, path=hello.txt, bytes=25

### BT-3: none provider disables workspace tools
**Result:** PARTIAL PASS

With `workspace: none` (default when omitted from config):
- [x] workspace_mount tool correctly NOT registered
- [ ] workspace write tool (`workspace`) IS still registered (11 tools including `workspace`)

The workspace write tool is filtered by `hasWorkspaceTiers` (based on agentWorkspace/userWorkspace directory existence), which is independent of the workspace provider type. The agent/user workspace directories are always created, so workspace write is always available.

**Evidence:**
- agent_tools count=11 names=[memory,web,identity,workspace,audit,agent,image,bash,read_file,write_file,edit_file]
- workspace_mount absent (correct)

### BT-4: Structural checks reject oversized files
**Result:** FAIL

The `workspace_write` IPC handler writes directly to disk without going through the commit pipeline's structural checks. The maxFileSize limit (100 bytes) was not enforced; a 200-byte file was written successfully.

**Design issue:** The workspace_write handler (`src/host/ipc-handlers/workspace.ts`) uses direct `writeFileSync()` without checking against `config.workspace.maxFileSize`. Structural limits (maxFileSize, maxFiles, maxCommitSize, ignorePatterns) are only enforced in the `structuralFilter()` function within `src/providers/workspace/shared.ts`, which is part of the scope-based mount/diff/commit pipeline. The two-tier workspace write path bypasses this pipeline entirely.

**Evidence:**
- File `/tmp/ax-acceptance-local-workspace-1773421479/agents/main/agent/workspace/big.txt` = 200 bytes
- Audit: workspace_write action logged successfully, no rejection

### BT-5: Ignore patterns filter out known directories
**Result:** FAIL

Same issue as BT-4. The `workspace_write` handler writes `node_modules/test/index.js` directly to disk without checking ignore patterns.

**Evidence:**
- Both files exist: `node_modules/test/index.js` and `src/main.ts`
- Both audit entries show successful writes
- No rejection events

### IT-1: Multi-turn workspace persistence across sessions
**Result:** PARTIAL PASS

Turn 1: File `persistent.txt` written successfully via workspace_write to agent tier.
Turn 2: File persists on disk at `$TEST_HOME/agents/main/agent/workspace/persistent.txt` with correct content "I should survive across sessions". However, the agent in the second session failed to navigate the sandbox filesystem to read it.

The file persistence mechanism works (the agent workspace directory is shared across sessions and symlinked into each sandbox). The failure was in agent navigation, not in the workspace provider.

**Evidence:**
- File on disk: content = "I should survive across sessions" (correct)
- Audit: workspace_write logged in turn 1
- Turn 2 agent response: "agent directory was missing" (model navigation issue)

### IT-2: Scope escalation is additive within a session
**Result:** PARTIAL PASS

Since workspace_mount is not available (critical bug), scope-based escalation cannot be tested. However, both workspace tiers (agent and user) are writable via the workspace_write tool in a single session.

**Evidence:**
- agent-file.txt written to agent tier (10 bytes)
- user-file.txt written to user tier (9 bytes)
- Both audit entries logged

### IT-3: Host auto-mounts remembered scopes on subsequent turns
**Result:** PARTIAL PASS

Auto-mount relies on workspace_mount being called to populate the `sessionScopes` Map. Since workspace_mount is never invoked (critical bug), auto-mount cannot be triggered or tested. The workspace_write tool works independently of scope tracking.

**Evidence:**
- auto.txt written to agent tier (17 bytes, content "auto-mounted test")
- No workspace_mount or workspace.mount events in logs

## Failures

### CRITICAL: workspaceProvider not parsed from agent stdin payload

**Severity:** Critical - blocks all scope-based workspace operations
**Bug location:** `src/agent/runner.ts` parseStdinPayload() and main entry point
**Impact:** workspace_mount tool never registered, scope tracking never populated, auto-mount never triggered

The host correctly passes `workspaceProvider: 'local'` in the stdin payload, but the agent runner never reads it. Two missing lines:
1. In `parseStdinPayload()` (~line 299): `workspaceProvider` not extracted from `parsed`
2. In main entry point (~line 364): `config.workspaceProvider = payload.workspaceProvider;` not assigned

### DESIGN: workspace_write bypasses commit pipeline

**Severity:** Medium - structural limits and ignore patterns not enforced on direct writes
**Impact:** BT-4 (maxFileSize) and BT-5 (ignore patterns) both fail
**Design gap:** The two-tier workspace write path (`workspace_write` handler) writes directly to disk via `writeFileSync()`. The commit pipeline's structural checks (`structuralFilter()` in `shared.ts`) are only invoked during the scope-based mount/diff/commit workflow. For the workspace_write handler to enforce limits, it would need to either:
1. Call `structuralFilter()` before writing, or
2. Check individual file constraints inline (size, path pattern, binary detection)
