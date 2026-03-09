# Unified WASM Sandbox Architecture for AX

**Date:** 2026-03-08
**Status:** Draft
**Supersedes:** `2026-03-08-autopilot-fast-sandbox-architecture.md`, `2026-03-08-wasm-agent-platform-design.md`

---

## Executive Summary

This document resolves the tensions between two overlapping WASM design proposals for AX and produces a single implementable plan. The core decision:

**WASM becomes a fast path behind AX's existing sandbox tool IPC actions. Container sandboxes remain the fallback and correctness reference. The agent loop stays in native Node.js.**

This is the autopilot doc's scope (WASM for tools) combined with the platform doc's k8s architecture (worker pods with multiple sandboxes). We take the autopilot doc's security model (hostcall API with capability tokens) and the platform doc's HTTP proxy optimization, then cut everything that adds complexity without delivering value in the next 8 weeks.

Key outcomes:
- p95 tool call latency drops from seconds to <150ms for 80%+ of calls
- Warm pool demand drops materially for common operations; removal is a later optimization, not an opening assumption
- Zero changes to security invariants (credentials never in untrusted context, taint propagation preserved, full audit trail)
- Agent code and tool catalog stay stable in the initial rollout — no JS-in-WASM, no Rust rewrite, no new agent-visible tool surface

---

## Architecture Decision Records

### ADR-1: Where Does the Agent Loop Run?

**Decision: Native Node.js. Not WASM.**

The platform doc proposes running the entire agent loop inside WASM. This is the wrong call for three reasons:

1. **JS-in-WASM is not production-ready.** QuickJS-in-WASM gives you ES2023 but not the Node.js ecosystem. SpiderMonkey-in-WASM is heavy and poorly maintained. Compiling AX's TypeScript agent to WASM via AssemblyScript would be a rewrite. The platform doc acknowledges this by ultimately recommending "Option C" (hybrid subprocess), which is just... running Node.js with extra steps.

2. **The agent loop is not the latency problem.** Cold start pain comes from spawning sandbox pods for tool calls. The agent loop itself is an event-driven LLM conversation — it waits for API responses 99% of the time. Making the agent loop start faster saves 5ms on a workflow that takes 30+ seconds per turn. That is not where the ROI is.

3. **The agent loop is not the security problem.** AX's threat model isolates *tool execution* (untrusted code running on user content) from *agent orchestration* (trusted code making LLM calls with credentials). The agent loop needs credentials for LLM calls. Putting it in WASM means either (a) passing credentials into the sandbox (violating the security model) or (b) proxying every LLM call through WASI-HTTP interception (complex, fragile, and adds latency to the hot path). Neither is acceptable.

The platform doc's "Option C" (WASM for isolation boundary, subprocess for execution) is essentially admitting that WASM-for-agents doesn't work. Let's skip the indirection and keep agents in Node.js where they already work.

**What this means for the k8s architecture:** Worker pods run Node.js agent processes directly (as they do today in the container architecture). WASM is used *within* those processes for tool execution. No WASI-HTTP interception needed. No NATS-bridged LLM calls. LLM calls go directly from the agent process to the credential-injecting proxy.

### ADR-2: How Should Tool Execution Be Tiered?

**Decision: Two tiers with an intent router. Not three lanes.**

The autopilot doc proposes three lanes (WASM capsules, warm gVisor pods, dedicated heavy pods). The platform doc proposes two tiers (WASM tool modules, container fallback). Three lanes is over-engineered for a small team.

**Tier 1: WASM Tool Modules (target: 80-90% of tool calls eventually, but not on day one)**

Pre-compiled WASM modules for operations AX already exposes through the existing `sandbox_*` IPC actions. These run in Wasmtime's pooling allocator inside the trusted host/agent-runtime process, not inside the sandboxed agent subprocess.

Initial modules must match the current tool catalog, which today exposes only:
- `bash`
- `read_file`
- `write_file`
- `edit_file`

That means the realistic v1 module set is:
- **workspace-fs.wasm:** backs `sandbox_read_file`, `sandbox_write_file`, and `sandbox_edit_file`
- **workspace-list.wasm:** optional internal helper for directory traversal and filtering, if needed by the bash classifier
- **bash-readonly classifier + modules:** strict allowlist for exact command shapes invoked through the existing `bash` tool, such as `pwd`, `ls`, `cat`, `head`, `tail`, `wc`, `rg`, and read-only `git` subcommands

Important constraint: AX does **not** currently have dedicated `search`, `git`, or `list_dir` IPC actions. If we want those later, that is a separate tool-catalog project. The initial WASM rollout should stay behind the existing `sandbox_bash` / `sandbox_read_file` / `sandbox_write_file` / `sandbox_edit_file` surface.

Deferred modules (add only after real traffic proves the need):
- dedicated `rg.wasm` and `git-readonly.wasm` paths behind the `bash` classifier
- python.wasm, quickjs.wasm — useful but add significant surface area
- sqlite.wasm — niche
- dedicated `search` / `git` agent tools — useful ergonomically, but outside the initial cutover
- git write operations — security implications need separate review

**Tier 2: Container Fallback (target: 10-20% of tool calls)**

Existing sandbox pods (gVisor on GKE, seatbelt/nsjail locally) for:
- Full bash with pipes, subshells, job control
- `npm test`, `npm install`, build commands
- Any tool call the intent router can't confidently classify
- Commands explicitly marked high-risk by policy

No Lane C. If a command needs a dedicated heavy pod, it goes through the existing sandbox provider with higher resource limits. That's a config knob on Tier 2, not a separate lane.

### ADR-3: Security Model — Hostcall API vs WASI Capabilities

**Decision: Hostcall API with Zod validation. WASI capabilities as defense-in-depth, not primary control.**

The autopilot doc's hostcall API (`ax.fs.read`, `ax.fs.write`, etc.) is the right primary security model because:

1. **It's auditable at the application layer.** Every hostcall goes through Zod schema validation, capability token checks, and audit logging. WASI capabilities are a runtime-level abstraction — they tell you what syscalls are allowed, not what application-level operations are permitted.

2. **It integrates with AX's existing security infrastructure.** Taint tags, path validation via `safePath()`, audit events — all of these already exist. The hostcall API is the natural enforcement point.

3. **WASI capabilities are too coarse.** WASI gives you "filesystem: yes/no" and "sockets: yes/no." AX needs "filesystem: read from /workspace/src, write to /workspace/src, deny /workspace/.env." That granularity requires application-level enforcement.

However, WASI capabilities still serve as defense-in-depth:
- Deny `wasi:sockets` entirely (WASM tool modules never need raw network)
- Deny raw `wasi:filesystem` in v1. All file access must go through `ax.fs.*` hostcalls so AX keeps audit logging, quotas, and `safePath()` enforcement
- Deny `wasi:http` in v1. Tool modules that need network stay in Tier 2 until there is a separately reviewed hostcall path
- Deny raw `wasi:cli` environment access. If argument passing is needed, pass structured inputs through the invocation payload rather than ambient env vars
- Use Wasmtime fuel metering for CPU limits

The autopilot doc's per-invocation capability tokens are good but should be simplified. A full JWT-like token with signed claims is over-engineering for an in-process boundary. Use a simple struct:

```typescript
interface ToolInvocationContext {
  invocationId: string;
  sessionId: string;
  module: string;           // e.g., 'ripgrep' or 'git-readonly'
  permissions: {
    fsRead: string[];       // allowed read path prefixes
    fsWrite: string[];      // allowed write path prefixes
    maxBytesRead: number;
    maxBytesWrite: number;
  };
  limits: {
    maxMemoryMb: number;
    maxTimeMs: number;
    maxOutputBytes: number;
  };
  deadlineMs: number;       // absolute timestamp
}
```

No signing, no JWT, no "capability token" ceremony. This context object is created by trusted host code and captured by the registered host functions. It never needs to be exposed to the module as an ambient secret. The trust boundary is the WASM sandbox itself — the module can trigger hostcalls, but the host decides whether each call is allowed.

### ADR-4: K8s Architecture

**Decision: Adopt the platform doc's worker pod topology, but with native Node.js agent processes, not WASM agent sandboxes.**

```
+-------------------------------------------------------------+
|                      INGRESS LAYER                          |
|          Deployment: ax-host (replicas: 2-3)                |
|                                                             |
|  Host Pods:                                                 |
|    HTTP API / SSE / Webhooks / Channels                     |
|    Credential-injecting HTTP proxy (:8081)                  |
|    Admin dashboard                                          |
|    0.5 CPU / 512Mi per pod                                  |
|                                                             |
|  Services:                                                  |
|    ax-host       (external LB) -> :8080                     |
|    ax-host-proxy (ClusterIP)   -> :8081                     |
+----------------------------+--------------------------------+
                             |
                       +-----+-----+
                       |   NATS    |  StatefulSet (3 replicas)
                       | JetStream |  IPC for tool dispatch + events
                       +-----+-----+
                             |
+----------------------------+--------------------------------+
|                COMPUTE LAYER                                |
|          Deployment: ax-worker (replicas: 3-10)             |
|                                                             |
|  Worker Pod:                                                |
|    Node.js process                                          |
|    +-- Agent Session Manager                                |
|    |   +-- Session A (pi-session, native Node.js)           |
|    |   +-- Session B (pi-session, native Node.js)           |
|    |   +-- Session C (claude-code subprocess)               |
|    |                                                        |
|    +-- WASM Tool Runner (Wasmtime, pooled)                  |
|    |   +-- workspace-fs.wasm                                |
|    |   +-- readonly bash modules (rg/git/coreutils subset)  |
|    |   +-- Per-call: memory limits, FS caps, fuel metering  |
|    |                                                        |
|    +-- Intent Router                                        |
|    |   +-- Classifies tool calls -> Tier 1 or Tier 2       |
|    |                                                        |
|    +-- NATS Client (IPC: memory, web, audit, delegation)    |
|    +-- HTTP Client (LLM -> ax-host-proxy ClusterIP)         |
|                                                             |
|    2 CPU / 4Gi per pod                                      |
|    Multiple concurrent agent sessions per pod               |
+----------------------------+--------------------------------+
                             | (Tier 2 fallback only)
                       +-----+-----+
                       |  Sandbox  |  On-demand gVisor pods
                       |   Pods    |  For full bash/build commands
                       +-----------+
```

**Key difference from the platform doc:** Agent sessions are native Node.js processes (or subprocesses for claude-code), not WASM sandboxes. WASM is used only for tool execution within those processes.

**Key difference from the container architecture:** Many tool calls can be satisfied inside the worker pod. Tier 2 fallback still dispatches to sandbox pods, and the warm pool remains until metrics prove it can be reduced safely.

**HTTP Proxy optimization (from platform doc — this is brilliant):** LLM calls go directly from worker pods to the `ax-host-proxy` ClusterIP service over HTTP. No NATS for LLM traffic. This is a standalone win regardless of WASM adoption. NATS remains for structured IPC (memory, web_fetch, audit, delegation, events).

### ADR-5: Intent Router Design

**Decision: Simple pattern-matching router, not ML-based classification. Grow the allowlist conservatively.**

The autopilot doc's `ExecutionIntent` interface is good but the `riskScore` field implies dynamic risk assessment that's unnecessary complexity. Replace with deterministic routing:

```typescript
interface ToolRoute {
  tier: 1 | 2;
  module?: string;        // Tier 1: which WASM module
  reason: string;         // Audit trail
}

function routeToolCall(tool: string, args: Record<string, unknown>): ToolRoute {
  // Deterministic pattern matching:
  // 1. Check if tool has a WASM module registered
  // 2. Check if the specific subcommand/flags are supported
  // 3. Check resource estimates (file size, output size)
  // 4. Default to Tier 2 if uncertain
}
```

Rules:
- If a WASM module exists for the tool AND the specific operation is in the module's supported set, route to Tier 1.
- If the tool call includes unsupported flags, pipes, shell metacharacters, or references binaries not in the WASM module, route to Tier 2.
- If the estimated I/O exceeds Tier 1 limits (e.g., reading a 500MB file), route to Tier 2.
- **Always route to Tier 2 when uncertain.** False negatives (sending to Tier 2 when Tier 1 would work) cost latency. False positives (sending to Tier 1 when it can't handle the command) cost correctness. Correctness wins.

Every routing decision is logged with the reason, creating a dataset for expanding Tier 1 coverage over time.

---

## Unified Architecture

### Execution Flow: Tool Call in Worker Pod

```
Host-side sandbox handler receives an existing `sandbox_*` IPC action
  |
  v
Intent Router classifies tool call
  |
  +-- Tier 1 (WASM): recognized tool, supported operation, within limits
  |   |
  |   v
  |   Create ToolInvocationContext (permissions, limits, deadline)
  |   |
  |   v
  |   Wasmtime pooling allocator instantiates module
  |     - Set fuel limit (CPU bound)
  |     - Set memory limit
  |     - Register hostcall functions (ax.fs.*, ax.log.emit)
  |     - Expose no raw WASI FS or HTTP
  |   |
  |   v
  |   Run module
  |     - All FS operations go through hostcall API
  |     - Hostcall validates against ToolInvocationContext
  |     - Hostcall applies safePath() validation
  |     - Hostcall emits audit breadcrumbs
  |   |
  |   v
  |   Collect output (stdout, stderr, exit code)
  |     - Truncate if exceeds maxOutputBytes
  |     - Record metrics (duration, memory, fuel consumed)
  |   |
  |   +-- Success -> return result to agent
  |   +-- Runtime error -> if fallback-safe, retry via Tier 2
  |                        if not, return error to agent
  |
  +-- Tier 2 (Container): needs full POSIX, uncertain, or high-risk
      |
      v
      Dispatch to sandbox pod via existing mechanism
      (NATS IPC for k8s, Unix socket IPC for local)
```

### Hostcall API (Simplified from Autopilot Doc)

Four hostcalls. That's it. Keep the surface area minimal.

**`ax.fs.read(path, offset?, length?) -> { content }`**
- Validates path against `fsRead` allowlist in context
- Validates total bytes against `maxBytesRead` budget
- Applies `safePath()` to resolve within workspace
- Returns plain content that can be mapped back to AX's existing `sandbox_read_file` response shape

**`ax.fs.write(path, content, mode: 'overwrite' | 'append') -> { bytesWritten }`**
- Validates path against `fsWrite` allowlist in context
- Validates total bytes against `maxBytesWrite` budget
- Applies `safePath()` to resolve within workspace
- Rejects writes to protected paths (`.env`, credentials, etc.)

**`ax.fs.list(path, recursive?, maxEntries?) -> { entries }`**
- Validates path against `fsRead` allowlist in context
- Caps entry count at `maxEntries` (default: 10000)
- Returns type, size, modification time per entry

**`ax.log.emit(level, message, data?) -> void`**
- Structured audit breadcrumb from WASM module
- No validation beyond schema (it's a log, not an action)
- Rate-limited to prevent log flooding

No `ax.http.fetch` in initial release. Tool modules that need HTTP go to Tier 2. No subprocess spawning from WASM — that defeats the purpose of WASM isolation.

Deliberate non-goal for v1: do **not** invent file-provenance taint metadata for workspace reads unless AX first grows a real provenance store. The current tool-result contract is plain text, and the initial WASM path should preserve that contract.

### Integration with Existing Codebase

The first implementation should attach to AX's **existing** seam, not invent a new one. Today the agent tool catalog already routes through:

- `sandbox_bash`
- `sandbox_read_file`
- `sandbox_write_file`
- `sandbox_edit_file`

Those IPC actions are handled in `src/host/ipc-handlers/sandbox-tools.ts`, with mirrored execution logic in `src/sandbox-worker/worker.ts` for the k8s/NATS path. That is where the router belongs.

Recommended implementation shape:

```
src/host/sandbox-tools/
  types.ts             -- shared request/response + executor contracts
  router.ts            -- Tier 1 / Tier 2 routing decisions
  bash-classifier.ts   -- strict grammar for allowlisted bash shapes
  local-executor.ts    -- current direct host execution
  wasm-executor.ts     -- Tier 1 implementation
  nats-executor.ts     -- current Tier 2 remote dispatch
```

And then:

1. `createSandboxToolHandlers()` normalizes each existing `sandbox_*` IPC action into a shared request shape
2. The new router decides Tier 1 vs Tier 2
3. Tier 1 runs through the WASM executor
4. Tier 2 continues to use the current local/NATS/container path

This keeps:
- agent code unchanged
- IPC schemas unchanged in the initial rollout
- tool catalog unchanged in the initial rollout
- fallback semantics in one place instead of split across host and worker implementations

Important pre-work: the current local handler path and the NATS sandbox worker duplicate file/path logic. Before enabling Tier 1 for real traffic, extract the shared validation/normalization rules so Tier 1 and Tier 2 are compared against the same contract.

AX may eventually factor the WASM runtime behind a provider contract, but doing that first is unnecessary churn. A new top-level provider kind would force coordinated changes across `src/types.ts`, `src/config.ts`, `src/host/registry.ts`, `src/host/provider-map.ts`, onboarding, and a wide test surface before the runtime has even been proven viable.

---

## Security Model

### Preserved Invariants (Non-Negotiable)

| Invariant | How WASM Preserves It |
|-----------|----------------------|
| No credentials in untrusted context | WASM modules never see API keys. For k8s rollout, only enable Tier 1 in a process that does not hold LLM credentials directly, or after routing LLM calls through the credential-injecting proxy. |
| All external content taint-tagged | WASM does not weaken the existing taint boundaries (`router.processInbound()`, web providers, proxy path). Workspace file reads keep the current plain-text tool-result contract unless a separate provenance design is added. |
| Complete audit trail | Every hostcall emits audit event with invocationId, module, operation, decision, duration. |
| No dynamic imports from config | WASM modules loaded from static manifest with SHA256 verification. |
| Path traversal protection | All hostcall paths go through `safePath()`. No raw FS access from WASM. |

### New Security Controls

**Module Integrity:**
- Each WASM module has a SHA256 digest in `manifest.json`
- Verified at load time (not per-invocation — modules are immutable once loaded)
- Modules built in CI from auditable source, not downloaded from registries
- No user-supplied WASM modules (this is tool running, not a plugin system)

**Resource Isolation:**
- Wasmtime fuel metering bounds CPU time per invocation
- Per-invocation memory limits via Wasmtime's `Store` configuration
- Output size caps prevent memory exhaustion from large tool outputs
- Deadline-based cancellation (wall clock timeout)
- No raw WASI filesystem or HTTP in v1; every privileged operation goes through hostcalls

**Failure Semantics (from autopilot doc — this is good):**
- Permission denied -> fail closed, return error to agent, emit audit event
- Schema validation failure -> fail closed, same
- WASM runtime trap (OOM, fuel exhaustion) -> fail closed, return error
- Fallback to Tier 2 only for runtime errors on commands explicitly marked fallback-safe
- Deterministic policy failures (blocked path, exceeded quota) never fall back

**Kill Switch:**
- Config flag `wasm.enabled: false` disables all Tier 1 routing
- All tool calls go to Tier 2 (existing sandbox path)
- Local `ax start` can pick this up via existing config hot-reload; k8s should assume a normal config rollout unless ConfigMap reload wiring is explicitly built

### Threat Model Comparison

| Threat | Container Sandbox | WASM Sandbox |
|--------|------------------|--------------|
| Sandbox escape | gVisor + pod boundary (strong) | WASM linear memory + Wasmtime (strong, different surface) |
| Resource exhaustion | Pod resource limits | Fuel metering + memory limits (finer-grained) |
| Path traversal | safePath() + mount isolation | safePath() + hostcall validation + no raw FS |
| Data exfiltration | No network (NetworkPolicy) | No sockets (WASI denied) + no hostcall for HTTP |
| Supply chain | Container image scanning | Module SHA256 + reproducible builds |

WASM is not strictly stronger or weaker than containers. It's a different isolation model. The key insight: for pure-computation tools (search, diff, read, list), WASM is sufficient and faster. For complex operations (bash, builds), containers remain the right choice. The two-tier model uses each where it's strongest.

---

## Implementation Roadmap

### Phase 0: Feasibility + Integration Seam (Week 1-2)

**Goal:** Prove the runtime is viable and hook the router into the real AX dispatch path without changing behavior.

Tasks:
1. **Extract the execution seam.** Refactor `src/host/ipc-handlers/sandbox-tools.ts` and the mirrored `src/sandbox-worker/worker.ts` logic behind a shared request/response contract so Tier 1 and Tier 2 can be compared against the same semantics.
2. **Add a shadow router skeleton.** Insert the routing decision point behind the existing `sandbox_*` IPC actions. Initially routes everything to Tier 2 while emitting "would-have-been-tier-1" metrics.
3. **Collect real tool-shape data.** Measure which IPC actions are used, which `bash` command shapes appear, path sizes, output sizes, and end-to-end latency. This data drives the classifier allowlist.
4. **Run a runtime spike.** Load a trivial module, execute hostcalls, enforce fuel/memory limits, and test concurrent invocations. Prove packaging works in local dev, tests, and container images.
5. **Validate the credential boundary for k8s.** If the target worker process still holds LLM credentials directly, do not enable in-process WASM there yet. Either move that deployment to the credential-injecting proxy path first or keep Tier 1 local-only until that boundary is fixed.

**Exit criteria:** Shadow router merged, tool-shape telemetry collected for at least one representative week, and a clear go/no-go decision recorded for the chosen Wasm runtime. If the runtime spike fails, stop here and ship only the proxy/routing improvements.

### Phase 1: Structured File Ops via WASM (Week 3-4)

**Goal:** Serve the existing structured file tools through Tier 1 with no agent-visible changes.

Tasks:
1. **Implement minimal hostcall API.** `ax.fs.read`, `ax.fs.write`, and `ax.log.emit` with strict schema validation, `safePath()` enforcement, quotas, and audit events.
2. **Build `workspace-fs.wasm`.** Support the exact behaviors needed for `sandbox_read_file`, `sandbox_write_file`, and `sandbox_edit_file`.
3. **Preserve contract parity.** Keep IPC schemas and tool result shapes unchanged. The WASM path must return the same response forms as today's handlers.
4. **Canary with shadow comparison.** For a controlled slice of traffic, run Tier 1 and Tier 2 side-by-side and compare results before serving Tier 1 responses broadly.
5. **Use disciplined fallback semantics.** Runtime failures may fall back if explicitly marked fallback-safe. Deterministic policy failures never fall back.

**Exit criteria:** `sandbox_read_file`, `sandbox_write_file`, and `sandbox_edit_file` pass parity tests across local, WASM, and NATS/container backends; fallback rate is low and understood; no correctness regressions in canary traffic.

### Phase 2: Restricted `bash` Fast Path (Week 5-6)

**Goal:** Move the safe, repetitive subset of the existing `bash` tool into Tier 1.

Tasks:
1. **Build a strict bash classifier.** Route only exact command shapes that are easy to parse and audit. Everything ambiguous stays in Tier 2.
2. **Start with read-only commands.** `pwd`, `ls`, `cat`, `head`, `tail`, `wc`, `rg`, and read-only `git` subcommands are the realistic first wave because AX exposes them today only through `sandbox_bash`.
3. **Keep command parsing conservative.** No pipes, redirection, subshells, background jobs, shell variables, or arbitrary binary dispatch in Tier 1.
4. **Dual-run before expand.** For newly supported command families, compare Tier 1 output to Tier 2 output until confidence is high enough to serve Tier 1 directly.
5. **Do not add new agent-visible tools yet.** Dedicated `search` or `git` tools are an optional follow-on after the backend fast path is proven.

**Exit criteria:** A meaningful slice of current `bash` traffic is served by Tier 1 with stable correctness, auditable classifier rules, and no surprise escalations.

### Phase 3: Optimization and Infrastructure Shrink (Week 7-8)

**Goal:** Reduce container usage only after correctness and routing quality are demonstrated.

Tasks:
1. **Shrink the warm pool based on sustained hit rate.** Use real Tier 1/Tier 2 metrics over time, not a one-day spike.
2. **Tune resource limits.** Use observed memory, output, and fuel metrics rather than guessed defaults.
3. **Package and preload modules cleanly.** Make sure local dev, `npm test`, and production containers all resolve the same immutable module artifacts.
4. **Consider extra hostcalls only with separate review.** `ax.http.fetch` stays deferred unless traffic proves the need and the security review is explicit.

**Exit criteria:** Tier 1 carries a sustained share of supported traffic, p95 latency on the covered operations is materially lower, and warm-pool capacity can be reduced without harming correctness or tail latency.

### Future (Post-8-Week)

These items are explicitly deferred. They may never be needed.

- python.wasm / quickjs.wasm — only if tool call data shows significant demand for short script execution
- Git write operations in WASM — requires careful security review
- WASI Preview 3 process model — watch for maturity, evaluate when stable
- WASM for agent isolation — re-evaluate only if JS-in-WASM becomes production-grade and there's a demonstrated need

### Acceptance Criteria and Tests

Before calling the plan "done", the implementation needs explicit proof in four areas:

1. **Contract parity tests**
   - The existing `sandbox_bash`, `sandbox_read_file`, `sandbox_write_file`, and `sandbox_edit_file` responses remain stable across local, WASM, and NATS/container backends.
   - Path traversal, quota enforcement, and error-shape behavior match documented expectations.

2. **Security tests**
   - Raw WASI filesystem and network access are denied in v1.
   - Hostcalls reject paths outside the workspace, protected files, oversized reads/writes, and expired deadlines.
   - Deterministic policy failures do not silently fall back to Tier 2.

3. **Classifier tests**
   - The bash classifier has golden tests for every allowlisted command shape and rejects ambiguous shell constructs by default.
   - Route decisions are audited with a reason string that is asserted in tests.

4. **Operational tests**
   - Concurrency tests prove the chosen Wasm runtime does not leak memory or crash under parallel invocations.
   - k8s acceptance coverage proves Tier 1 can coexist with the current NATS + warm-pool Tier 2 path and that the kill switch really forces all traffic back to Tier 2.

---

## Risks and Mitigations

### Risk 1: Wasmtime Node.js Bindings Instability

**Severity:** High
**Likelihood:** Medium

Wasmtime's Node.js bindings are less battle-tested than its Rust/C APIs. Crashes, memory leaks, or API changes could block progress.

**Mitigation:**
- Phase 0 includes a spike to validate bindings with realistic workloads
- Identify fallback runtime (V8's built-in WASM, Wasmer) early
- Kill switch allows instant revert to container-only path
- All WASM invocations are wrapped in process-level crash recovery

### Risk 2: WASM Tool Incompatibility with Real-World Usage

**Severity:** Medium
**Likelihood:** High

Agents use tools in unpredictable ways, and AX currently exposes most shell-like behavior through a free-form `bash` tool. Real traffic may be much less classifiable than the plan hopes, which would cap Tier 1 coverage well below the headline target.

**Mitigation:**
- Conservative routing: default to Tier 2 when uncertain
- Dual-run and shadow compare before broad enablement
- Shadow mode (Phase 0) collects real data before enabling Tier 1
- Deterministic policy failures fail closed; only explicit runtime failures may fall back
- Fallback rate is a primary metric — alerts if it exceeds 15%

### Risk 3: Credential Boundary Regression in K8s

**Severity:** High
**Likelihood:** Medium

If Tier 1 runs in a process that also holds direct LLM credentials, a WASM runtime escape becomes more damaging than it needs to be and weakens AX's existing "no credentials in untrusted context" story.

**Mitigation:**
- Treat credential-free execution as a rollout gate, not a nice-to-have
- Prefer the credential-injecting HTTP proxy path for k8s workers before enabling in-process WASM there
- Keep the kill switch available so k8s can revert to container-only execution immediately

### Risk 4: WASM Module Supply Chain

**Severity:** High
**Likelihood:** Low

If WASM modules are compromised, attackers get code running inside worker pods (albeit constrained by WASI capabilities and hostcall validation).

**Mitigation:**
- Modules built from source in CI, not downloaded from external registries
- SHA256 digest verification at load time
- Reproducible builds where possible
- No user-supplied WASM modules — this is not a plugin system

### Risk 5: Resource Exhaustion from Many Concurrent WASM Instances

**Severity:** Medium
**Likelihood:** Medium

Multiple concurrent agent sessions each running WASM tool calls could exhaust worker pod memory.

**Mitigation:**
- Wasmtime pooling allocator reuses memory across instances
- Per-invocation memory limits prevent individual runaways
- Worker pod autoscaling on active sandbox count
- Graceful degradation: if WASM allocator is at capacity, route to Tier 2

### Risk 6: Debugging Difficulty

**Severity:** Medium
**Likelihood:** High

WASM is harder to debug than native code. No `kubectl exec` into a WASM sandbox. Stack traces are hexadecimal addresses without debug info.

**Mitigation:**
- Comprehensive structured logging from hostcall API (every operation logged with context)
- WASM modules built with DWARF debug info in non-production builds
- Audit events include full routing decision chain
- Fallback to Tier 2 preserves debuggability for complex cases

---

## What We Cut

### Cut from the Autopilot Doc

| Item | Why Cut |
|------|---------|
| **Lane C (dedicated heavy pods)** | Over-engineering. Tier 2 with higher resource limits achieves the same thing. Config knob, not architecture. |
| **Signed capability tokens (JWT-like)** | Over-engineering for an in-process boundary. Simple struct passed by trusted host code is sufficient. No trust boundary crossed. |
| **Capsule packaging with versioned signed artifacts** | Over-engineering. These are pre-compiled modules built in CI, not a package registry. SHA256 verification is enough. |
| **`ax.proc.run` hostcall** | Dangerous. Subprocess spawning from WASM defeats the purpose. If you need that, use Tier 2. |
| **Risk score in ExecutionIntent** | Implies ML/heuristic classification. Deterministic pattern matching is simpler, more predictable, and easier to audit. |
| **Policy DSL** | YAGNI. Static routing rules in TypeScript are sufficient. A DSL adds complexity without value until there are many tenants with different policies. |

### Cut from the Platform Doc

| Item | Why Cut |
|------|---------|
| **Agent loop in WASM** | Fundamental architectural mistake. The agent loop needs credentials, uses the full Node.js ecosystem, and isn't the latency bottleneck. See ADR-1. |
| **WASI-HTTP interception for LLM calls** | Unnecessary complexity. Agent runs natively, makes HTTP calls directly to proxy. No interception needed. |
| **WASM sandbox per agent session** | The isolation boundary for agents remains the process/pod boundary. WASM is for tool running within a trusted agent process. |
| **python.wasm and quickjs.wasm (initial release)** | Deferred until data shows demand. They add significant surface area (CPython stdlib, QuickJS engine) for uncertain benefit. |
| **WASIX consideration** | Correctly rejected in the platform doc. Adding `fork()`/process spawning to WASM is antithetical to WASM's security model. |
| **KEDA scaling on NATS queue depth** | Good idea but independent of WASM. Implement separately as a k8s scaling improvement. |
| **50 concurrent WASM sandboxes per pod** | This assumed WASM agent sandboxes. With WASM only for tools, concurrency is per-tool-call, not per-session. Much lighter. |

### What Both Docs Got Right (Kept)

| Item | Source | Why It's Good |
|------|--------|--------------|
| HTTP proxy as ClusterIP | Platform doc | Eliminates NATS for LLM traffic. Standalone win. |
| WASI capability denial (no sockets) | Both | Defense-in-depth for WASM tool modules. |
| Fuel metering for CPU bounds | Both | Fine-grained CPU limiting without wall-clock hacks. |
| Conservative rollout (shadow -> read-only -> writes) | Autopilot doc | Reduces blast radius. Builds confidence with data. |
| Fallback-safe classification | Autopilot doc | Not all failures should fall back. Policy failures fail closed. |
| Route attestation in audit events | Autopilot doc | Essential for tuning and debugging the router. |
| Per-session virtual filesystem | Both | Clean workspace isolation for WASM modules. |
| Kill switch | Autopilot doc | Essential operational control for a new path. |
| Worker pod topology | Platform doc | Multiple sessions per pod is the right density model for k8s. |

---

## Appendix: Critique of Both Designs

### Autopilot Doc — What's Brilliant, What's Not

**Brilliant:**
- The hostcall API design with explicit contracts per operation. This is how you build a security boundary — small surface, validated inputs, audited outputs.
- Failure/fallback semantics are well thought out. The distinction between "fallback-safe runtime error" and "fail-closed policy violation" is critical and often overlooked.
- Conservative rollout with shadow mode. Collecting "would-have-been-Lane-A" data before enabling is exactly right.
- The framing of "Execution Intent" over raw command dispatch. Even though the specific interface is over-specified, the concept of normalizing tool calls before routing is sound.

**Not Brilliant:**
- Three lanes is one too many. Lane B and Lane C are both "send to a container pod with different resource limits." That's a config knob, not an architectural distinction.
- Signed capability tokens for an in-process boundary is security theater. The trust boundary is the WASM sandbox. Inside the Node.js process, everything is trusted. A signed token proves nothing that a simple struct doesn't.
- The capsule packaging system (versioned, signed, with metadata JSON) is borrowing from container registries without the use case. These modules are built in CI and deployed with the application. They don't need a package management layer.
- No k8s architecture at all. The doc assumes the infrastructure exists and only talks about what happens inside a pod. That's necessary but not sufficient.

### Platform Doc — What's Brilliant, What's Not

**Brilliant:**
- The HTTP proxy insight. "NATS for LLM calls is like shipping a letter by first putting it in a box, then putting the box in a truck." This is correct, well-reasoned, and immediately actionable.
- Worker pod topology with multiple sessions per pod. This is the right density model — WASM or not.
- The two-tier tool model (WASM modules + container fallback) is simpler and more honest than three lanes.
- Explicit comparison table showing what changed from the container architecture. Clear communication of the delta.
- WASIX rejection. Good security judgment.

**Not Brilliant:**
- Agent-in-WASM is the central premise and it's wrong. All three options (compile to WASM, rewrite in Rust, hybrid subprocess) are worse than just running Node.js. The doc arrives at "Option C" which is effectively "don't use WASM for the agent" — but dressed up as a WASM solution.
- Memory estimates (50 sandboxes x 100MB = 5GB) are based on WASM agent sandboxes. With WASM only for tool calls, the memory model is completely different (tool modules are short-lived, use pooling allocator, share compiled code).
- WASI-HTTP interception for LLM calls is clever but fragile. It requires implementing an HTTP proxy inside the WASM runtime, handling SSE streaming through that proxy, and getting all the edge cases right. Direct HTTP from the agent process is simpler and faster.
- The doc handwaves debugging. "Need good logging and observability from the start" is correct but insufficient. The autopilot doc's audit trail design is more concrete.
- "No warm pool needed" is only true if agents are in WASM (instant start). With native Node.js agents, warm pools may still be needed for agent startup — but not for tool calls, which is where the real latency lives.

---

## Summary of Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Agent loop | Native Node.js | Not the latency bottleneck, needs credentials, JS-in-WASM immature |
| Tool running | Two tiers: WASM + container fallback | Simple, additive, preserves existing paths |
| Primary security model | Hostcall API with Zod validation | Auditable, integrates with existing infra, right granularity |
| Defense-in-depth | WASI capability denial | Deny sockets, raw FS, and raw HTTP in v1; use fuel metering |
| K8s architecture | Worker pods with native agent processes | Multiple sessions per pod, WASM for tool calls only |
| LLM call path | Direct HTTP to ClusterIP proxy | Eliminates NATS overhead for LLM traffic |
| Intent routing | Deterministic pattern matching | Predictable, auditable, conservative |
| Integration seam | Existing `sandbox_*` IPC actions | No initial agent/tool-catalog rewrite |
| First WASM modules | `workspace-fs` plus a restricted readonly `bash` subset | Matches AX's current tool surface |
| Rollout strategy | Shadow -> structured file ops -> restricted bash -> optimize | Data-driven, reversible, aligned to current contracts |
| Kill switch | Config flag disables all Tier 1 | Revert via hot reload locally or rollout in k8s |
