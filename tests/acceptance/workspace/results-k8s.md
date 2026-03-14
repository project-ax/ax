# Acceptance Test Results: Workspace Provider

**Date run:** 2026-03-13 13:46
**Server version:** 6585215
**LLM provider:** openrouter/google/gemini-3-flash-preview
**Environment:** K8s/kind (subprocess sandbox, nats eventbus, postgresql storage)

## Summary
| Test | Category | Result | Notes |
|------|----------|--------|-------|
| BT-1 | Behavioral | PASS | workspace_mount tool called, audit entries present |
| BT-2 | Behavioral | PASS | workspace_write wrote file, audit entries present, content verified |
| BT-3 | Behavioral | PASS | workspace_mount tool absent with workspace: none config |
| BT-4 | Behavioral | FAIL | workspace_write bypasses commit pipeline maxFileSize check |
| BT-5 | Behavioral | FAIL | workspace_write bypasses commit pipeline ignore patterns |
| IT-1 | Integration | PASS | File persisted across sessions, readable in new session |
| IT-2 | Integration | PARTIAL PASS | Both scopes mounted, files written; additive allScopes not reflected in audit due to per-request session IDs |
| IT-3 | Integration | PARTIAL PASS | File written without explicit mount; auto-mount of provider-backed workspace not verifiable via workspace_write path |

**Overall: 4/8 passed, 2/8 partial pass, 2/8 failed**

## Bug Found During Testing

**workspaceProvider not parsed from stdin payload (runner.ts)**

The `parseStdinPayload()` function in `src/agent/runner.ts` defined `workspaceProvider` in the `StdinPayload` interface but never actually extracted it from the parsed JSON object. Additionally, the main runner code that maps payload fields to config fields was missing the `config.workspaceProvider = payload.workspaceProvider` assignment.

This caused `hasWorkspaceScopes` to always be `false` in the agent subprocess, which meant the `workspace_mount` tool was never registered in the tool catalog despite `config.providers.workspace` being set to `local`.

**Fix applied:** Two lines added to `src/agent/runner.ts`:
1. Line 300: `workspaceProvider: typeof parsed.workspaceProvider === 'string' ? parsed.workspaceProvider : undefined,` (in parseStdinPayload)
2. Line 366: `config.workspaceProvider = payload.workspaceProvider;` (in main runner)

## Detailed Results

### BT-1: Agent can mount workspace scopes via chat
**Result: PASS**

- Agent called workspace_mount with scopes ["session", "agent"]
- Audit log shows two workspace_mount entries:
  - `{"scopes":["session","agent"],"allScopes":["session","agent"]}`
- Agent response: "I've mounted the session and agent workspaces."
- No errors in server logs

Evidence:
```
workspace_mount | {"scopes":["session","agent"],"allScopes":["session","agent"]}
```

### BT-2: Agent can write files to workspace and they persist through commit
**Result: PASS**

- Agent called workspace_mount then workspace_write
- Audit log shows `workspace_write` with `{"tier":"agent","path":"hello.txt","bytes":25}`
- File verified on agent-runtime pod at `/home/ax/.ax/agents/main/agent/workspace/hello.txt`
- Content verified: "Hello from workspace test"
- No errors in server logs

Evidence:
```
workspace_write | {"tier":"agent","path":"hello.txt","bytes":25}
```
File content: `Hello from workspace test`

### BT-3: none provider disables workspace tools
**Result: PASS**

- Deployed separate namespace with `config.providers.workspace: none`
- Agent tool list: audit, bash, read_file, write_file, edit_file, memory, web, identity, workspace, agent, image
- `workspace_mount` is NOT present (correct)
- `workspace` (enterprise two-tier write tool) is present but this is expected -- it's independent of the workspace provider
- No errors in server logs

### BT-4: Structural checks reject oversized files
**Result: FAIL**

- Config set with `workspace.maxFileSize: 100`
- Agent wrote 212 bytes to `big.txt` via `workspace_write`
- Audit shows successful write: `{"tier":"agent","path":"big.txt","bytes":212}`
- File was NOT rejected

**Root cause:** The `workspace_write` IPC handler writes directly to `agentWorkspaceDir()` using `writeFileSync()`, completely bypassing the workspace provider's commit pipeline (in `shared.ts`). The maxFileSize check only applies during `commit()` calls in the provider-backed workspace flow (mount -> diff -> commit), not during direct `workspace_write` calls.

This is an architectural gap: the two-tier enterprise workspace (workspace_write) and the provider-backed workspace (workspace_mount/commit) are independent systems with different write paths.

### BT-5: Ignore patterns filter out known directories
**Result: FAIL**

- Agent wrote `node_modules/test/index.js` and `src/main.ts` via `workspace_write`
- Both files were persisted -- `node_modules/test/index.js` was NOT rejected

**Root cause:** Same as BT-4. The `workspace_write` handler does not apply ignore pattern filtering. The `structuralFilter()` function in `shared.ts` (which checks ignore patterns) is part of the commit pipeline, not the direct write path.

Evidence:
```
Files found on disk:
/home/ax/.ax/agents/main/agent/workspace/src/main.ts
/home/ax/.ax/agents/main/agent/workspace/node_modules/test/index.js
```

### IT-1: Multi-turn workspace persistence across sessions
**Result: PASS**

- Session 1 (`acceptance:workspace:k8s:it1:turn1`): Mounted agent workspace, wrote `persistent.txt` with "I should survive across sessions"
- Session 2 (`acceptance:workspace:k8s:it1:turn2`): Mounted agent workspace, read `persistent.txt` -- content matches
- File verified on disk: `/home/ax/.ax/agents/main/agent/workspace/persistent.txt` contains "I should survive across sessions"
- Audit log has 26+ workspace entries across both sessions

### IT-2: Scope escalation is additive within a session
**Result: PARTIAL PASS**

- Step 1: Mounted session scope -- audit shows `{"scopes":["session"],"allScopes":["session"]}`
- Step 2: Mounted agent scope -- audit shows `{"scopes":["agent"],"allScopes":["agent"]}`
- Step 3: Wrote to both scopes -- agent-file.txt in agent tier, session-file.txt in scratch dir
- Both files verified on disk

**Partial because:** The `allScopes` field in the second mount shows `["agent"]` instead of the expected `["session","agent"]`. This is because in k8s mode, each HTTP request becomes a separate NATS session request with a different internal `requestId` (used as `ctx.sessionId` in the IPC handler). The workspace provider's in-memory `sessionScopes` Map tracks scopes by this internal ID, so the second request doesn't know about the first request's session scope.

This is an expected limitation of the current architecture: the provider-backed workspace scope tracking is per-process, per-requestId, not per-persistent-session. The persistent session ID (`acceptance:workspace:k8s:it2`) is separate from the internal request ID.

### IT-3: Host auto-mounts remembered scopes on subsequent turns
**Result: PARTIAL PASS**

- Step 1: Mounted agent and session scopes explicitly
- Step 2: Wrote `auto.txt` without calling workspace_mount -- file written successfully

**Partial because:** The auto-mount feature in `server-completions.ts` calls `providers.workspace.activeMounts()` which uses in-memory scope tracking. In k8s mode, each request gets a new internal request ID, so `activeMounts()` returns empty for the second request (the provider doesn't remember the first request's mounts). The file write succeeded because `workspace_write` doesn't require a provider-backed mount -- it writes directly to the enterprise `agentWorkspaceDir`.

Auto-mount log entries were not found, confirming that the provider-level auto-mount did not fire (scopes were not remembered across requests).

## Failures

### BT-4 and BT-5: workspace_write bypasses commit pipeline

**Impact:** The structural checks (file size limits, file count limits, ignore patterns, binary detection) defined in `shared.ts` are only enforced during the provider-backed workspace's `commit()` flow. The enterprise `workspace_write` IPC handler writes files directly to disk without any structural validation.

**Recommendation:** Either:
1. Add structural checks (maxFileSize, ignore patterns) to the `workspace_write` handler in `src/host/ipc-handlers/workspace.ts`
2. Or route workspace_write through the provider's commit pipeline instead of direct file I/O

### IT-2 and IT-3: Provider scope tracking doesn't persist across k8s requests

**Impact:** In k8s mode, each HTTP request maps to a different internal `requestId`, which is used as the session ID for workspace provider scope tracking. The in-memory `sessionScopes` Map in `shared.ts` is keyed by this internal ID, so additive mounting and auto-mount don't work across separate requests.

**Recommendation:** Persist scope tracking in the database (keyed by persistent session ID) rather than in-memory (keyed by internal request ID).
