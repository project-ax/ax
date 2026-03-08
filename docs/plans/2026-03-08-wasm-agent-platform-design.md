# WASM Agent Platform Design

**Date:** 2026-03-08
**Status:** Draft

## Problem

The current K8s architecture (see `2026-03-04-k8s-agent-compute-architecture.md`) uses full Linux containers with gVisor for agent sandboxing. This works, but carries significant overhead:

- **Cold start:** Pod scheduling + container pull + workspace setup = 5-30s per agent
- **Resource cost:** Each sandbox pod needs its own CPU/memory allocation, even for lightweight tasks
- **Operational complexity:** Warm pool management, pod lifecycle, NATS for inter-pod IPC

WASM offers a lighter-weight isolation model: near-instant startup (~5ms), smaller memory footprint, and capability-based security that's a natural fit for AX's zero-trust model.

## Decision

Replace Linux container sandboxes with WASM sandboxes running inside worker pods. The WASM runtime (Wasmtime or WasmEdge) provides the isolation boundary instead of gVisor + pod boundary.

### Key Insight: HTTP Proxy is Just HTTP

The host pod already runs a credential-injecting HTTP proxy (see `2026-02-10-credential-injecting-proxy.md`). Worker pods can reach this proxy via plain HTTP through an internal ClusterIP service. There's no reason to tunnel HTTP requests through NATS.

NATS remains the IPC protocol for structured tool calls (memory, web, audit, delegation). But LLM API calls — which are just HTTP requests to the Anthropic API — go directly to the host pod's proxy over HTTP.

```
WASM sandbox (no real sockets — WASI capability denied)
  │
  │ WASI-HTTP call intercepted by host runtime
  │
  ▼
Worker pod WASM host runtime
  │
  │ Plain HTTP to ClusterIP service
  │
  ▼
Host pod HTTP proxy (internal LB)
  │
  ├─ Allowlist check (only /v1/messages)
  ├─ Credential injection (API key or OAuth token)
  ├─ Audit log
  ├─ Taint-tag response
  │
  ▼
api.anthropic.com
```

## Architecture

### Three-Layer System (Revised)

```
┌──────────────────────────────────────────────────────────────────┐
│                        INGRESS LAYER                              │
│            Deployment: ax-host (replicas: 2-3)                    │
│                                                                   │
│  ┌──────────────────────────────────────────────────────────┐    │
│  │ Host Pods                                                │    │
│  │                                                          │    │
│  │  HTTP API / SSE / Webhooks / Channels                    │    │
│  │  Credential-injecting HTTP proxy (:8081)                 │    │
│  │  Admin dashboard                                         │    │
│  │                                                          │    │
│  │  Stateless. Behind k8s Service / LB.                     │    │
│  │  0.5 CPU / 512Mi per pod                                │    │
│  └──────────────────────────────────────────────────────────┘    │
│                                                                   │
│  k8s Services:                                                    │
│    ax-host          (external LB)  → :8080 HTTP API              │
│    ax-host-proxy    (ClusterIP)    → :8081 credential proxy      │
│                                                                   │
└──────────────────────────────┬───────────────────────────────────┘
                               │
                         ┌─────┴─────┐
                         │   NATS    │  StatefulSet (3 replicas)
                         │ JetStream │  IPC only — no LLM traffic
                         └─────┬─────┘
                               │
┌──────────────────────────────┼───────────────────────────────────┐
│              COMPUTE LAYER                                        │
│            Deployment: ax-worker (replicas: 3-10, autoscaled)    │
│                                                                   │
│  ┌──────────────────────────────────────────────────────────┐    │
│  │ Worker Pod                                               │    │
│  │                                                          │    │
│  │  WASM Host Runtime (Wasmtime/WasmEdge)                   │    │
│  │  ├── WASM sandbox 1 (agent session A)                    │    │
│  │  ├── WASM sandbox 2 (agent session B)                    │    │
│  │  ├── WASM sandbox 3 (agent session C)                    │    │
│  │  └── ...                                                 │    │
│  │                                                          │    │
│  │  NATS client (IPC: memory, web, audit, delegation)      │    │
│  │  HTTP client (LLM proxy → ax-host-proxy ClusterIP)      │    │
│  │                                                          │    │
│  │  2 CPU / 4Gi per pod                                    │    │
│  │  Multiple concurrent WASM sandboxes per pod              │    │
│  └──────────────────────────────────────────────────────────┘    │
│                                                                   │
└──────────────────────────────┬───────────────────────────────────┘
                               │
                         ┌─────┴─────┐
                         │ Cloud SQL │  PostgreSQL (HA, shared)
                         └───────────┘
```

### What Changed From the Container Architecture

| Aspect | Container Architecture | WASM Architecture |
|--------|----------------------|-------------------|
| Isolation boundary | gVisor pod per agent | WASM sandbox per agent |
| Sandboxes per pod | 1 | Many (10-50+) |
| Cold start | 5-30s (pod + container + workspace) | ~5-50ms (WASM instantiate) |
| LLM proxy path | NATS `ipc.llm.{sessionId}` | Direct HTTP to ClusterIP |
| Warm pool needed | Yes (pool-controller) | No (instant start) |
| Network isolation | k8s NetworkPolicy per pod | WASI capability denial |
| File system isolation | Ephemeral pod volume | WASI virtual filesystem |
| Resource overhead | ~1 CPU / 2Gi per sandbox | ~50-100MB per sandbox |

### Communication Channels

Two distinct channels, used for different purposes:

**HTTP (LLM proxy):** Worker pod → `ax-host-proxy` ClusterIP → Anthropic API

- Standard HTTP/1.1 or HTTP/2
- Supports SSE streaming natively
- Stateless, horizontally scalable behind k8s Service
- No serialization overhead — just proxy the bytes
- Network policy allows worker→host traffic (already required for NATS)

**NATS (IPC):** Worker pod ↔ NATS ↔ Host pod (for structured tool calls)

- Memory, web_fetch, audit, skills, delegation
- Request/reply pattern with Zod-validated schemas
- Ordered, durable (JetStream) where needed
- Tenant-tagged for multi-tenancy

Why not NATS for LLM calls? Because:
1. LLM calls are just HTTP — wrapping them in NATS adds serialization/deserialization for no benefit
2. SSE streaming maps naturally to HTTP chunked transfer, not NATS message sequences
3. The proxy is stateless — it's just a credential injector, perfect for a ClusterIP service
4. NATS message size limits would require chunking large responses, adding complexity
5. The worker pod already needs host-reachable network (for NATS), so no new network policy is needed

### WASM Sandbox Model

Each agent session runs in its own WASM sandbox instance. The WASM host runtime (running in the worker pod's Node.js process) controls what capabilities each sandbox gets.

#### WASI Capabilities

```
Granted:
  ├── wasi:filesystem    — virtual FS (in-memory or mapped to workspace dir)
  ├── wasi:clocks        — monotonic + wall clock (read-only)
  ├── wasi:random        — CSPRNG
  └── wasi:cli           — args, env (filtered), stdin/stdout/stderr

Denied:
  ├── wasi:sockets       — no raw socket access
  └── wasi:http          — intercepted by host runtime (see below)

Intercepted (host-mediated):
  └── wasi:http/outgoing-handler
      ├── /v1/messages → forwarded to ax-host-proxy (LLM calls)
      └── everything else → denied (or routed through IPC web_fetch)
```

The WASM sandbox thinks it's making HTTP requests, but the host runtime intercepts every outgoing request and decides what to do:

- Anthropic API calls → forwarded to the host pod's credential-injecting proxy
- Everything else → blocked, or routed through the IPC `web_fetch` handler (which applies allowlists and taint-tagging)

This is the WASM equivalent of the current seatbelt/nsjail sandbox — capability-based instead of syscall-based.

#### Agent Code in WASM

Two approaches, not mutually exclusive:

**Option A: Compile pi-session to WASM (via wasi-sdk or component model)**

The pi-session agent loop is TypeScript. We'd need a WASM-compatible JS runtime:
- QuickJS compiled to WASM (small, fast, limited)
- SpiderMonkey compiled to WASM (heavier but full-featured)
- Or: compile the TypeScript to native WASM via AssemblyScript or similar

This is the harder path but gives the tightest integration.

**Option B: Run a WASM-native agent runtime**

Write a thin agent loop in Rust/Go compiled to WASM. The agent loop:
1. Receives the conversation context (system prompt, history, tools) via WASI stdin or shared memory
2. Makes LLM API calls via WASI-HTTP (intercepted → proxy)
3. Executes tool calls by writing to a host-monitored pipe (→ NATS IPC)
4. Returns the final response via WASI stdout

This is lighter but requires maintaining a separate agent implementation.

**Option C (recommended): Hybrid — WASM for isolation, subprocess for execution**

Use WASM for the security boundary but run the actual agent code as a sandboxed subprocess:
1. Worker pod receives session request from NATS
2. Worker spawns a Node.js subprocess with restricted capabilities (no network, limited FS)
3. WASM host runtime mediates all I/O between the subprocess and the outside world
4. LLM calls → intercepted → HTTP to proxy
5. Tool calls → intercepted → NATS IPC

This preserves the existing TypeScript agent code while getting WASM's capability-based security model. The subprocess runs inside a WASM-like sandbox (e.g., using Wasmtime's component model for the I/O layer, even if the compute isn't WASM).

### Worker Pod Internals

```
Worker Pod (Node.js process)
  │
  ├── NATS Client
  │   ├── Subscribe: session.request.* (queue group — claim work)
  │   ├── Publish: events.{requestId} (streaming events to host)
  │   ├── Publish: results.{requestId} (final result to host)
  │   └── Request/Reply: ipc.request.{sessionId} (tool calls)
  │
  ├── HTTP Client Pool
  │   └── Persistent connections to ax-host-proxy ClusterIP
  │       Used by all WASM sandboxes for LLM calls
  │
  ├── WASM Sandbox Manager
  │   ├── Instantiate sandbox for new session
  │   ├── Route WASI-HTTP calls to proxy or IPC
  │   ├── Manage per-sandbox virtual filesystem
  │   ├── Enforce resource limits (memory, CPU time, wall time)
  │   └── Tear down sandbox on session completion
  │
  └── Sandbox Instances (concurrent)
      ├── Sandbox A: session-123 (pi-session agent)
      ├── Sandbox B: session-456 (pi-session agent)
      ├── Sandbox C: session-789 (claude-code agent)
      └── ...
```

### Execution Flow: Pi-Session Chat With Tools

```
1. Client → POST /v1/chat/completions → Host Pod
2. Host Pod validates, publishes to NATS: session.request.pi-session
3. Worker Pod claims request from NATS queue group

4. Worker Pod:
   a. Instantiates WASM sandbox with virtual FS (~5ms)
   b. Loads conversation history from PostgreSQL
   c. Starts agent loop inside sandbox

5. Agent loop (inside WASM sandbox):
   a. Makes LLM call:
      → WASI-HTTP outgoing request to /v1/messages
      → Host runtime intercepts
      → HTTP POST to ax-host-proxy ClusterIP
      → Proxy injects credentials, forwards to api.anthropic.com
      → SSE response streams back through proxy → host runtime → sandbox

   b. LLM responds with tool_use (e.g., bash)

   c. Agent calls bash tool:
      → Host runtime intercepts tool call
      → NATS request to ipc.request.{sessionId}
      → Host pod handles (or dispatches to sandbox pod for bash)
      → Response via NATS reply

   d. Agent makes another LLM call with tool result
      → Same HTTP path as step 5a

   e. Agent produces final response

6. Worker Pod:
   a. Publishes events.{requestId} throughout (SSE to client)
   b. Publishes results.{requestId} with final response
   c. Saves conversation to PostgreSQL
   d. Tears down WASM sandbox

7. Host Pod forwards SSE events + final result to client
```

### Bash/File Tool Execution

WASM sandboxes can't execute arbitrary bash commands (no syscall access). Two options:

**Option A: Sidecar execution container**

Each worker pod has a sidecar container with bash/coreutils. Tool calls are dispatched to the sidecar via a local Unix socket. The sidecar runs with restricted capabilities (no network, limited FS view).

**Option B: Keep sandbox pods for bash (hybrid)**

WASM handles the agent conversation loop (lightweight, instant start). When the agent needs bash/file tools, dispatch to a sandbox pod via NATS (same as the container architecture). This means:
- Agent loop: WASM sandbox (fast, cheap)
- Code execution: Linux container sandbox (when needed, per-turn affinity)

This is a good middle ground — most conversations don't use bash at all, and we avoid the complexity of running bash inside WASM.

**Option C: WASI process model (future)**

WASI Preview 3 may include a process model that allows spawning subprocesses. When available, this would let the WASM sandbox run bash directly, with the host runtime controlling which binaries are available.

**Recommendation: Option B for now, migrate to C when WASI matures.**

## Security Model

| Layer | Mechanism | Protects Against |
|-------|-----------|------------------|
| WASM capability model | WASI capabilities granted per-sandbox | Unauthorized syscalls, network access, file access |
| HTTP proxy allowlist | Only `/v1/messages` forwarded | Credential use for non-LLM purposes |
| Credential injection | Proxy adds credentials, sandbox never sees them | Credential theft from compromised sandbox |
| WASI-HTTP interception | Host runtime controls all outbound HTTP | Data exfiltration, unauthorized API calls |
| IPC validation | Zod schemas with `.strict()` on all NATS messages | Injection, unauthorized actions |
| Virtual filesystem | Per-sandbox isolated FS, no host FS access | Cross-tenant data access |
| Resource limits | Per-sandbox memory + CPU time limits | Resource exhaustion, DoS |
| NATS tenant tagging | Every message carries `tenant_id` | Tenant impersonation |

### Network Policy

Simpler than the container architecture — only worker pods need external access, not individual sandbox pods:

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: worker-egress
spec:
  podSelector:
    matchLabels:
      app: ax-worker
  policyTypes: [Egress]
  egress:
    # NATS for IPC
    - to:
        - podSelector:
            matchLabels:
              app: nats
      ports:
        - port: 4222
    # Host proxy for LLM calls
    - to:
        - podSelector:
            matchLabels:
              app: ax-host
      ports:
        - port: 8081
    # Cloud SQL
    - to:
        - podSelector:
            matchLabels:
              app: cloud-sql-proxy
      ports:
        - port: 5432
    # DNS
    - to: []
      ports:
        - port: 53
          protocol: UDP
```

No inbound connections to worker pods. All work is pull-based (NATS queue groups).

## Scaling

| Signal | Scales | Mechanism |
|--------|--------|-----------|
| NATS queue depth (`session.request.*`) | Worker pods | KEDA scaler on pending message count |
| Active WASM sandboxes per worker | Worker pods | Custom metric + HPA |
| HTTP request rate | Host pods | Standard HPA on CPU/request rate |
| SSE connection count | Host pods | Custom metric |

No warm pool controller needed. WASM sandboxes start in milliseconds — there's nothing to pre-warm.

## Migration Path

### Phase 1: HTTP Proxy on Host Pod (No WASM Yet)

Extract the credential-injecting proxy into a separate port on the host pod. Expose it as a ClusterIP service (`ax-host-proxy`). Existing container sandboxes switch from NATS LLM proxy to direct HTTP proxy.

This is a standalone improvement — reduces NATS traffic and simplifies the LLM call path — regardless of whether we adopt WASM.

### Phase 2: WASM Sandbox Prototype

Build a proof-of-concept WASM sandbox that can:
1. Run a minimal agent loop (hardcoded prompt, single LLM call)
2. Make LLM calls via WASI-HTTP → host proxy
3. Return the response

Validate: startup time, memory overhead, WASI-HTTP interception works correctly.

### Phase 3: Full Agent in WASM

Port the pi-session agent loop to run inside a WASM sandbox. Tool calls dispatched via NATS IPC. LLM calls via HTTP proxy.

### Phase 4: Bash/File Tools

Implement the hybrid approach: WASM for agent loop, Linux container sandbox pods for bash/file execution. Or adopt WASI process model if mature.

## Open Questions

1. **WASM runtime choice:** Wasmtime vs WasmEdge vs V8 WASM. Wasmtime has the best WASI support. V8 is already in Node.js but WASI support is experimental.

2. **JS-in-WASM:** Running TypeScript agent code inside WASM requires a JS engine compiled to WASM (QuickJS, etc.) or rewriting the agent in a WASM-native language. The hybrid approach (Option C above) sidesteps this.

3. **WASI-HTTP maturity:** WASI-HTTP (`wasi:http/outgoing-handler`) is standardized but implementation support varies. Need to validate that Wasmtime's implementation is production-ready.

4. **Memory overhead at scale:** 50 concurrent WASM sandboxes × 100MB each = 5GB per worker pod. Need to measure real-world memory usage and tune worker pod sizing.

5. **Debugging:** WASM sandboxes are harder to debug than containers (no `kubectl exec`). Need good logging and observability from the start.

## Alternatives Considered

### Stay With Container Sandboxes

The container architecture works. WASM is only worth it if the cold start and resource overhead are actually problems. If most sessions reuse warm pool pods and the pool controller keeps up, containers may be good enough.

### WASM Without HTTP Proxy Optimization

We could use WASM sandboxes but still route LLM calls through NATS. This works but adds unnecessary complexity. The HTTP proxy is already there, it's already stateless, and HTTP is the natural protocol for proxying HTTP requests. Using NATS for this is like shipping a letter by first putting it in a box, then putting the box in a truck — when you could just put the letter in the truck.

### Firecracker MicroVMs

Lighter than full containers, heavier than WASM. ~125ms startup. Good isolation guarantees. But requires bare-metal or nested virt support (not available on GKE Autopilot).
