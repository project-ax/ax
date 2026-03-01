# MemU Integration Plan for AX (with OpenClaw/QMD Comparison)

## Why this plan exists

We compared OpenClaw's current memory stack and MemU's architecture to decide how AX should evolve its `memu` provider.

Current findings:
- OpenClaw separates memory concerns:
  - `memory-core` + QMD for retrieval/search workflows.
  - A separate long-term semantic memory extension (`memory-lancedb` in current upstream).
- AX currently has a `memu` provider, but it is a heuristic in-memory stub (`Map` + regex extraction) and not a real MemU integration.
- MemU is a richer memory system (memorize/retrieve + structured memory model), but needs an adapter to fit AX's provider contract and security invariants.

Reference links:
- OpenClaw memory docs: <https://github.com/openclaw/openclaw/blob/main/docs/concepts/memory.md>
- OpenClaw QMD manager: <https://github.com/openclaw/openclaw/blob/main/src/memory/qmd-manager.ts>
- OpenClaw memory-lancedb extension: <https://github.com/openclaw/openclaw/tree/main/extensions/memory-lancedb>
- QMD repo: <https://github.com/tobi/qmd>
- MemU docs: <https://memu.pro/docs>
- MemU architecture note: <https://github.com/NevaMind-AI/memU/blob/main/docs/architecture.md>

## Goals

1. Replace AX's heuristic `memu` stub with a real MemU-backed provider.
2. Preserve AX's existing agent tool contract (`memory_write/query/read/delete/list`).
3. Keep all AX security invariants (SC-SEC-001/002/003/004) intact.
4. Preserve proactive hint flow (`memory.onProactiveHint` -> scheduler).
5. Support enterprise scope isolation (`scope`, `agentId`) end-to-end.

## Non-goals

1. Replacing AX's IPC memory action names.
2. Letting agent containers call MemU directly.
3. Turning off taint tracking for memory operations.
4. Shipping a cloud-only dependency as the default runtime path.

## Current AX gaps to close

- `src/providers/memory/memu.ts`
  - `write()` and `delete()` are no-ops.
  - Storage is in-memory only (lost on restart).
  - Query is substring+tags, not semantic retrieval.
  - `memorize()` has no explicit context object for scope/session/agent.
- `src/host/server-completions.ts`
  - Calls `providers.memory.memorize(fullHistory)` with conversation text only.
  - No typed memory context payload for tenant isolation metadata.
- `src/providers/memory/types.ts`
  - `ConversationTurn` does not carry taint/timestamp metadata.
  - No explicit retrieval mode/capabilities contract.

## Recommended target architecture

Use a host-side MemU adapter provider with optional lexical fallback.

1. AX host process remains the only caller of memory provider methods.
2. `providers/memory/memu.ts` becomes a MemU adapter (HTTP or SDK bridge).
3. MemU runtime is local/host-controlled by default (localhost sidecar), not internet-exposed.
4. Optional fallback path for retrieval:
   - Primary: MemU semantic retrieval
   - Fallback: existing SQLite lexical query for degraded mode
5. Scheduler proactive hints continue through existing `onProactiveHint` interface.

This mirrors OpenClaw's practical split: robust retrieval backend + separate long-term memory behavior.

## Interface changes (AX)

These are additive or narrowly breaking, and focused on making MemU integration explicit.

### 1) Update memory types

File: `src/providers/memory/types.ts`

Proposed additions:

```ts
export interface ConversationTurn {
  role: 'user' | 'assistant';
  content: string;
  sender?: string;
  taint?: TaintTag;
  timestamp?: Date;
}

export interface MemoryContext {
  scope: string;
  sessionId: string;
  agentId?: string;
  userId?: string;
}

export interface MemorizeInput {
  turns: ConversationTurn[];
  context: MemoryContext;
}

export interface MemorizeResult {
  created: number;
  updated: number;
  skipped: number;
  emittedHints: number;
}

export interface MemoryQuery {
  scope: string;
  query?: string;
  limit?: number;
  tags?: string[];
  agentId?: string;
  mode?: 'lexical' | 'semantic' | 'hybrid';
}
```

Provider shape change:

```ts
memorize?(input: MemorizeInput): Promise<MemorizeResult | void>;
```

Notes:
- Keep existing CRUD method names unchanged.
- `mode` is optional and defaults to provider-native behavior.
- If strict backward compatibility is required for plugin providers, accept both signatures temporarily and deprecate old signature in one release.

### 2) Update completion pipeline invocation

File: `src/host/server-completions.ts`

Change:
- Replace `providers.memory.memorize(fullHistory)` with a typed call that includes `context`.
- Build `context` from resolved session info (`sessionId`, `agentId`, `userId`, effective scope).

### 3) Add MemU config block

Files: `src/types.ts`, `src/config.ts`, `ax.yaml`

Proposed config shape:

```yaml
memory_config:
  memu:
    transport: http
    base_url: "http://127.0.0.1:8765"
    timeout_ms: 5000
    retrieval_mode: hybrid
    fallback_provider: sqlite
    enforce_localhost: true
```

Validation rules:
- If `providers.memory == memu`, require `memory_config.memu`.
- If `enforce_localhost=true`, reject non-loopback URLs.

## MemU adapter behavior mapping

File: `src/providers/memory/memu.ts`

Mapping rules:

1. `write(entry)`:
- Map AX `MemoryEntry` to MemU create/upsert API.
- Persist `scope`, `agentId`, `tags`, `taint` in metadata fields.
- Return stable memory ID.

2. `query(q)`:
- Use MemU retrieve API (`mode` mapped from AX query mode).
- Enforce scope and `agentId` filters in adapter, even if upstream also filters.
- Return AX `MemoryEntry[]` shape.
- On MemU transient error, optionally fallback to SQLite provider if configured.

3. `read(id)` and `list(scope, limit)`:
- Use MemU CRUD/list APIs.
- Apply adapter-level filter checks for scope/agent isolation.

4. `delete(id)`:
- Hard delete through MemU API.

5. `memorize(input)`:
- Send full turn set plus context metadata.
- Ensure taint metadata propagates to extracted memories.
- Emit `onProactiveHint` callbacks for task/follow-up signals from MemU outputs.

6. `onProactiveHint(handler)`:
- Maintain existing callback contract so scheduler integration (`src/providers/scheduler/full.ts`) remains unchanged.

## Security threat model checks

### SC-SEC-001 (sandbox isolation)

Controls:
- Agent container must never call MemU directly.
- Only host-side provider talks to MemU.
- If MemU runs as sidecar, bind to loopback only.

Tests:
- Ensure no MemU client dependency is used in `src/agent/`.
- Integration test confirms memory still flows only via IPC actions.

### SC-SEC-002 (static provider loading)

Controls:
- Keep MemU provider in static `provider-map.ts` entry (`memory: memu`).
- Do not build import paths dynamically from config.

Tests:
- Existing provider-map tests + new case for memu config rejecting invalid transport URLs when localhost enforcement is on.

### SC-SEC-003 (taint budget and taint propagation)

Controls:
- Carry taint on `ConversationTurn` into `memorize()` extracted records.
- On query results, keep `entry.taint` so host can continue taint accounting.
- Never downgrade `external` taint inside adapter.

Tests:
- Regression: tainted conversation -> memorized entries remain tainted.
- Regression: reading tainted memory contributes to taint budget and can block sensitive actions.

### SC-SEC-004 (safe path)

Controls:
- If any local cache/snapshot files are added for MemU adapter, all paths must use `safePath()`.

Tests:
- Path traversal tests for any new file-backed MemU cache.

### Additional memory-specific threats

1. Cross-tenant leakage:
- Enforce `scope` and `agentId` filters in adapter and host.

2. Prompt-injection in recalled memory:
- Preserve external-content wrappers for tainted recalled content before LLM consumption.

3. Denial of service:
- Add request timeout, retry budget, and circuit breaker in MemU adapter.

4. Data exfiltration:
- Default deployment should be local sidecar. Remote MemU endpoints must be explicit opt-in with audit warnings.

## Implementation phases

### Phase 1: Contract and config hardening

Files:
- `src/providers/memory/types.ts`
- `src/types.ts`
- `src/config.ts`
- `ax.yaml`
- `src/host/server-completions.ts`

Deliverables:
- New `MemorizeInput`/`MemoryContext` contract.
- MemU config schema.
- Completion pipeline updated to send typed context.

Acceptance:
- All existing memory tests pass with compatibility shim.

### Phase 2: Real MemU adapter

Files:
- `src/providers/memory/memu.ts`
- `tests/providers/memory/memu.test.ts`
- Optional: `src/providers/memory/memu-client.ts`

Deliverables:
- Replace in-memory stub with real MemU-backed operations.
- Deterministic mapping AX <-> MemU entities.

Acceptance:
- CRUD + memorize behavior persists across process restarts.
- `onProactiveHint` still fires for pending tasks.

### Phase 3: Security and resilience

Files:
- `src/host/ipc-handlers/memory.ts`
- `src/host/server-completions.ts`
- `tests/host/` and `tests/integration/`

Deliverables:
- Adapter-level guardrails (timeout/retry/circuit breaker).
- Scope isolation regression tests.
- Taint propagation regression tests.

Acceptance:
- Security regressions fail closed.
- No SC invariant violations.

### Phase 4: Optional hybrid retrieval

Files:
- `src/providers/memory/memu.ts`
- `src/providers/memory/sqlite.ts` (fallback hooks only if needed)
- `tests/providers/memory/`

Deliverables:
- `mode: hybrid` support with semantic+lexical fallback strategy.

Acceptance:
- Query quality improves on semantic prompts while preserving deterministic behavior during MemU outages.

## Test plan

### Unit tests

1. `tests/providers/memory/memu.test.ts`
- Maps write/query/read/delete/list to MemU client calls.
- Preserves `scope`, `agentId`, `tags`, `taint`.
- `memorize(input)` passes context metadata.
- Hint emission behavior unchanged.

2. `tests/config.test.ts`
- Valid/invalid `memory_config.memu` combinations.
- Localhost enforcement checks.

3. `tests/host/ipc-handlers/memory.test.ts` (add if missing)
- Scope and audit behavior unaffected by provider swap.

### Integration tests

1. `tests/integration/phase2.test.ts`
- Update `memorize()` expectations for new input shape.

2. New test: `tests/integration/memu-adapter.test.ts`
- End-to-end memory lifecycle with MemU provider.
- Restart scenario to confirm persistence.

3. New test: taint propagation through memorize/query
- Tainted turn -> memorized tainted entry -> taint budget increases on retrieval.

### E2E tests

1. `tests/e2e/scenarios/memory-lifecycle.test.ts`
- Run against memu provider config as separate scenario.

2. New e2e: proactive hint bridge
- `memorize()` extracts pending task -> scheduler receives hint -> channel message emitted once (cooldown respected).

## Decision and recommendation

Recommended path for AX:

1. Keep AX memory IPC tool surface unchanged.
2. Implement real MemU integration behind the existing `memu` provider name.
3. Add typed memorize context and stronger taint metadata propagation.
4. Default to host-local MemU runtime with strict egress controls.
5. Add optional lexical fallback for reliability, borrowing OpenClaw's operational lesson from QMD fallback behavior.

This gives AX better semantic memory without giving up its security posture.
