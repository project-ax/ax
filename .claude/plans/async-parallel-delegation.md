# Plan: Async Parallel Delegation via Orchestrator (No New Tools)

## Context

When the LLM returns multiple `agent_delegate` tool calls in a single response, they execute sequentially (~17s each = ~51s for 3). The bottleneck is pi-agent-core's `executeToolCalls` loop, which awaits each tool one-at-a-time.

The orchestration infrastructure (`src/host/orchestration/`) is already built — Supervisor, Directory, Orchestrator, messaging — but NOT wired into delegation. The current `handleDelegate` in `server.ts:255` still synchronously awaits `processCompletion()` for each child agent.

**Solution:** Make `agent_delegate` fire-and-forget. Child agents register with the Orchestrator and run concurrently. The LLM uses existing `agent_orch_status` / `agent_orch_list` to poll for completion and read results from `handle.metadata.result`. No new tools needed.

## Flow

```
LLM response: 3x agent_delegate tool calls

Sequential tool execution (pi-agent-core, unchanged):
  1. agent_delegate("Research A") → registers child in Orchestrator, spawns in background
     → returns {handleId: "uuid-1", status: "started"}  (~ms)
  2. agent_delegate("Research B") → same
     → returns {handleId: "uuid-2", status: "started"}  (~ms)
  3. agent_delegate("Research C") → same
     → returns {handleId: "uuid-3", status: "started"}  (~ms)

All 3 children running concurrently via Orchestrator.

Next LLM turn:
  LLM calls agent_orch_list(state: ["completed","failed"])
  → returns snapshots with metadata.result for each finished child

Total: ~17s (max of 3) instead of ~51s (sum of 3)
```

## Steps

### 1. Create Orchestrator in server.ts, pass to IPC handler

**File:** `src/host/server.ts`

- Import `createOrchestrator` from `./orchestration/orchestrator.js`
- Create instance with existing `eventBus` and `providers.audit`:
  ```typescript
  const orchestrator = createOrchestrator(eventBus, providers.audit);
  ```
- Pass `orchestrator` to `createIPCHandler` options (line ~288):
  ```typescript
  const handleIPC = createIPCHandler(providers, {
    ...existing opts,
    orchestrator,
  });
  ```
- Call `orchestrator.shutdown()` in `stopServer()` (before closing IPC server)

This also activates the already-coded orchestration IPC handlers (`agent_orch_list`, `agent_orch_status`, etc.) which are currently dead code because no orchestrator is passed.

### 2. Make agent_delegate fire-and-forget with Orchestrator lifecycle

**File:** `src/host/ipc-handlers/delegation.ts`

Current behavior:
```
activeDelegations++
await onDelegate()
activeDelegations--
return { response }
```

New behavior:
```typescript
activeDelegations++

// Register child in Orchestrator
const handle = orchestrator.register({
  agentId: `delegate-${ctx.agentId}`,
  agentType: (req.runner ?? 'pi-coding-agent') as AgentType,
  parentId: null,
  sessionId: ctx.sessionId,
  userId: ctx.userId ?? 'unknown',
  activity: req.task.slice(0, 200),
});

// Transition to running
orchestrator.supervisor.transition(handle.id, 'running', 'Processing delegation');

// Fire and forget
const promise = opts.onDelegate(delegateReq, childCtx);
promise.then(result => {
  handle.metadata.result = result;
  orchestrator.supervisor.complete(handle.id, result.slice(0, 500));
}).catch(err => {
  handle.metadata.error = err instanceof Error ? err.message : String(err);
  orchestrator.supervisor.fail(handle.id, handle.metadata.error);
}).finally(() => {
  activeDelegations--;
});

// Audit + return immediately
return { handleId: handle.id, status: 'started' };
```

Key details:
- `activeDelegations` decrements in `.finally()` when background promise settles — concurrency enforcement still correct
- Result stored in `handle.metadata.result` — accessible via `agent_orch_status`
- Error stored in `handle.metadata.error` — accessible via `agent_orch_status`
- Supervisor state transitions: `spawning → running → completed/failed`

### 3. Update agent_delegate tool description

**File:** `src/agent/tool-catalog.ts`

Update the `agent_delegate` description to mention it returns immediately:
```typescript
description:
  'Delegate a task to a sub-agent running in its own sandbox. ' +
  'Returns immediately with a handleId — use agent_orch_status or ' +
  'agent_orch_list to poll for completion and read results from metadata.result. ' +
  'Subject to depth and concurrency limits.',
```

### 4. Update delegation prompt module with new pattern

**File:** `src/agent/prompt/modules/delegation.ts`

Teach the LLM the fan-out/poll/collect pattern:

- `agent_delegate` returns immediately with `{handleId, status: "started"}`
- Delegate ALL tasks first, then poll for results
- Use `agent_orch_list` with `state: ["completed","failed"]` to see which children finished
- Use `agent_orch_status(handleId)` to read individual results from `metadata.result`
- If not all done yet, poll again on next turn
- Pattern: fan-out → poll → collect

### 5. Wire Orchestrator into TestHarness

**File:** `tests/e2e/harness.ts`

- Import `createEventBus` and `createOrchestrator`
- Create both in `TestHarness` constructor
- Pass `orchestrator` to `createIPCHandler`
- Expose `orchestrator` as a public field for test assertions
- Call `orchestrator.shutdown()` in `dispose()`

### 6. Update existing delegation tests + add parallel tests

**File:** `tests/e2e/scenarios/agent-delegation.test.ts`

**Existing test updates** — `agent_delegate` now returns `{handleId, status: "started"}` instead of `{response}`:
- Tests that check `result.response` → assert `result.handleId` exists + `result.status === "started"`, then wait for background promise to settle, then call `agent_orch_status` to verify result
- Multi-turn test: after `agent_delegate` tool call, the tool result now contains `handleId` instead of `response`, so the LLM script needs adjustment

**New test cases:**
1. **Fire-and-forget**: `agent_delegate` returns `{handleId, status: "started"}` immediately
2. **Result in Orchestrator**: after background settles, `agent_orch_status(handleId)` has `metadata.result`
3. **Parallel timing**: 3 delegates with artificial delay, total time ≈ max (not sum)
4. **Partial failure**: 1 of 3 throws, handle shows `state: "failed"` with `metadata.error`
5. **Concurrency limit**: 4th delegate rejected when `maxConcurrent=3`
6. **agent_orch_list finds children**: list with session filter returns all spawned handles

## Files Modified

| File | Change |
|------|--------|
| `src/host/server.ts` | Create Orchestrator, pass to IPC handler, shutdown |
| `src/host/ipc-handlers/delegation.ts` | Fire-and-forget with Orchestrator lifecycle |
| `src/agent/tool-catalog.ts` | Update `agent_delegate` description |
| `src/agent/prompt/modules/delegation.ts` | Teach fan-out/poll/collect pattern |
| `tests/e2e/harness.ts` | Wire Orchestrator into TestHarness |
| `tests/e2e/scenarios/agent-delegation.test.ts` | Update existing + add parallel tests |

## What's NOT Changing

- **No new IPC schema** — no `agent_delegate_collect`
- **No new tool** — existing `agent_orch_status` / `agent_orch_list` do the job
- **No changes to `ipc-server.ts`** — `IPCHandlerOptions` already has `orchestrator?: Orchestrator`
- **No changes to orchestration handlers** — `agent_orch_status` already returns `metadata` in snapshot
- **No changes to `scripted-llm.ts`** — no multi-tool-use helper needed

## Verification

1. `npm run build` — TypeScript compiles clean
2. `npm test` — all existing tests pass (with delegation test updates)
3. New parallel-delegate tests pass
4. Manual: run a prompt triggering 3 `agent_delegate` calls → confirm all 3 spawn at ~same timestamp, `agent_orch_list` returns all results
