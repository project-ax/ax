# Three-Tier Sandbox Architecture: WASM, Containers, and K8s Pods

> **Purpose**: Design document for AX's three-tier sandbox execution model. Each tier
> trades isolation strength for startup speed and resource efficiency. The host picks
> the right tier per-command based on what the agent is actually trying to do.
>
> **Status**: Proposal
> **Date**: 2026-03-08
> **Depends on**: [K8s Agent Compute Architecture](2026-03-04-k8s-agent-compute-architecture.md),
> [Security Hardening Spec](ax-security-hardening-spec.md)

---

## Table of Contents

1. [Problem Statement](#problem-statement)
2. [Design Principles](#design-principles)
3. [Three-Tier Model](#three-tier-model)
4. [Tier 1: WASM (WASI) — Lightweight Commands](#tier-1-wasm-wasi--lightweight-commands)
5. [Tier 2: Container Sandbox — Full Shell](#tier-2-container-sandbox--full-shell)
6. [Tier 3: K8s Pod — Cloud Isolation](#tier-3-k8s-pod--cloud-isolation)
7. [Tier Selection Logic](#tier-selection-logic)
8. [WASI Filesystem Model](#wasi-filesystem-model)
9. [IPC and the Socket Problem](#ipc-and-the-socket-problem)
10. [Recommended Architecture](#recommended-architecture)
11. [Security Analysis](#security-analysis)
12. [Implementation Plan](#implementation-plan)
13. [Open Questions](#open-questions)

---

## Problem Statement

AX agents execute bash commands, read/write files, and run scripts inside sandboxed
containers. Today every `sandbox_bash` call spawns a process inside nsjail, Docker,
bwrap, or a seatbelt sandbox — even for trivial operations like `cat`, `ls`, `grep`,
or `echo`. That's like hailing a taxi to cross the street.

The cost of process-per-command:
- **Startup latency**: 50–200ms for nsjail/bwrap, 500ms+ for Docker
- **Resource overhead**: each spawn allocates namespaces, mounts filesystems, forks
- **Scaling ceiling**: K8s pods take seconds to schedule; warm pools help but waste memory

Most agent commands are simple file operations that don't need a full Linux userspace.
We can run them in WebAssembly in <1ms with stronger isolation guarantees than
namespace-based sandboxing.

---

## Design Principles

1. **Right-size isolation.** Don't burn a container for `cat README.md`. Don't run
   `npm install` in WASM. Match the isolation tier to what the command actually needs.

2. **Same filesystem view everywhere.** All three tiers see the same canonical paths
   (`/workspace`, `/workspace/scratch`, `/workspace/skills`). Agent code doesn't know
   or care which tier ran its command.

3. **Host decides, agent doesn't.** Tier selection happens on the host side in the
   `sandbox_bash` IPC handler. The agent submits commands; it has no say in how
   they're executed.

4. **Security floor, not ceiling.** Every tier must enforce: no network, no credential
   access, no escape to host filesystem. WASM is additive security (stronger than
   containers for filesystem), not a relaxation.

5. **Progressive enhancement.** WASM tier is optional. If it's not available or
   can't handle a command, fall through to container tier. System works fine without it.

---

## Three-Tier Model

```
┌─────────────────────────────────────────────────────────────────┐
│                     HOST PROCESS                                 │
│                                                                  │
│   sandbox_bash IPC handler                                       │
│   ┌──────────────────────────────────────────────────────────┐  │
│   │              TIER SELECTOR                                │  │
│   │                                                           │  │
│   │   Command arrives → classify → dispatch to tier:          │  │
│   │                                                           │  │
│   │   ┌──────────┐   ┌──────────────┐   ┌────────────────┐  │  │
│   │   │ Tier 1   │   │ Tier 2       │   │ Tier 3         │  │  │
│   │   │ WASM     │   │ Container    │   │ K8s Pod        │  │  │
│   │   │          │   │              │   │                │  │  │
│   │   │ <1ms     │   │ 50-500ms     │   │ 1-5s (warm)    │  │  │
│   │   │ In-proc  │   │ nsjail/bwrap │   │ NATS dispatch  │  │  │
│   │   │ WASI fs  │   │ Docker       │   │ gVisor runtime │  │  │
│   │   │          │   │ Seatbelt     │   │                │  │  │
│   │   │ cat,ls   │   │ bash,python  │   │ npm,docker     │  │  │
│   │   │ grep,wc  │   │ node,git     │   │ long-running   │  │  │
│   │   │ head,    │   │ pip install  │   │ multi-process  │  │  │
│   │   │ tail,    │   │ make, cargo  │   │                │  │  │
│   │   │ echo,    │   │              │   │                │  │  │
│   │   │ sort,    │   │              │   │                │  │  │
│   │   │ uniq     │   │              │   │                │  │  │
│   │   └──────────┘   └──────────────┘   └────────────────┘  │  │
│   └──────────────────────────────────────────────────────────┘  │
│                                                                  │
│   All tiers use canonical paths (from canonical-paths.ts):       │
│     /workspace          (rw) — session working directory         │
│     /workspace/scratch  (rw) — session temp files                │
│     /workspace/skills   (ro) — merged skills overlay             │
│     /workspace/identity (ro) — agent identity                    │
│     /workspace/agent    (ro) — shared agent workspace            │
│     /workspace/user     (ro) — per-user persistent storage       │
└─────────────────────────────────────────────────────────────────┘
```

---

## Tier 1: WASM (WASI) — Lightweight Commands

### What It Is

A WebAssembly module (compiled from C/Rust via `wasm32-wasi` target) that implements
common Unix utilities: `cat`, `ls`, `grep`, `head`, `tail`, `wc`, `sort`, `uniq`,
`echo`, `mkdir`, `rm`, `cp`, `mv`, `find`, `sed` (basic), `tr`, `cut`, `tee`.

The primary candidate is **BusyBox compiled to WASM** — a single ~2MB module that
provides 300+ Unix utilities. Alternative: individual Rust reimplementations
(e.g., `uutils/coreutils` compiled to `wasm32-wasi`).

### Runtime

We recommend **Node.js built-in `node:wasi`** for initial implementation, with
migration to **wasmtime** via its Node.js bindings if fuel metering proves necessary.

Key requirements:
- **WASI Preview 1** support (filesystem preopens, args, env, stdio)
- **Fuel metering** (wasmtime only) — cap execution at N instructions to prevent infinite loops
- **Memory limits** — cap linear memory at 256MB
- **No WASI networking** — the runtime simply doesn't provide `wasi:sockets`

### How It Works

```typescript
// src/providers/sandbox/wasm-tier.ts

import { WASI } from 'node:wasi';
import { readFile } from 'node:fs/promises';

let busyboxModule: WebAssembly.Module | null = null;

async function loadBusybox(): Promise<WebAssembly.Module> {
  if (!busyboxModule) {
    const wasm = await readFile(new URL('./wasm/busybox.wasm', import.meta.url));
    busyboxModule = await WebAssembly.compile(wasm);
  }
  return busyboxModule;
}

export interface WasmExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export async function wasmExec(
  argv: string[],
  workspace: string,
  scratchDir: string,
): Promise<WasmExecResult> {
  const wasi = new WASI({
    version: 'preview1',
    args: argv,
    env: {},                               // No env vars — no credential leaks
    preopens: {
      '/workspace':         workspace,
      '/workspace/scratch': scratchDir,
    },
    returnOnExit: true,
  });

  const module = await loadBusybox();
  const instance = await WebAssembly.instantiate(module, wasi.getImportObject());
  const exitCode = wasi.start(instance);

  return { stdout: '...', stderr: '...', exitCode: exitCode ?? 0 };
}
```

### Why WASM Isolation Is Stronger Than Containers

| Property | Container (nsjail/bwrap) | WASM (WASI) |
|---|---|---|
| Filesystem model | Start with OS, restrict | Start with nothing, grant |
| Path traversal | Prevented by mount namespaces | Impossible — runtime resolves all paths |
| Ambient capabilities | Must be explicitly dropped | Don't exist |
| Network | Disabled via `unshare-net` | Not implemented in runtime |
| System calls | Filtered via seccomp-bpf | Only WASI calls available (~45 vs ~300+) |
| `/proc`, `/sys` | Must be explicitly hidden | Don't exist |
| Kernel attack surface | Full Linux kernel | Zero — WASM is a userspace VM |

WASM doesn't just restrict access — the concepts don't exist. There's no `/proc` to
hide because there's no `/proc`. There's no network to disable because the runtime
doesn't implement sockets. It's defense by absence, not defense by policy.

### Limitations

- **No process spawning.** Can't `$(command substitution)`, can't pipe between
  processes, can't `bash -c "..."`. Single-process execution only.
- **No Unix sockets.** Can't connect to the IPC socket. But Tier 1 doesn't need IPC —
  it's a pure command executor, not an agent. (See [IPC and the Socket Problem](#ipc-and-the-socket-problem).)
- **No dynamic linking.** The WASM module must be self-contained. BusyBox is ideal
  because it's a single static binary.
- **Limited shell features.** No bash built-ins, no job control, no environment
  variable expansion beyond what we pass in `env`.
- **No special filesystems.** No `/dev/null`, no `/dev/urandom`, no `/proc/self`.
  Some commands may behave differently.

---

## Tier 2: Container Sandbox — Full Shell

This is today's sandbox — nsjail, bwrap, Docker, or seatbelt. No changes needed.

### When to Use

- Commands that need a shell: pipes (`|`), redirects (`>`), subshells (`$(...)`)
- Commands that need process spawning: `git`, `npm`, `python`, `node`
- Commands that need system libraries: anything dynamically linked
- Commands that need `/dev/null`, `/dev/urandom`, or other special files
- Package managers: `pip install`, `npm install`, `cargo build`
- Build tools: `make`, `cmake`, `tsc`, `webpack`

### Existing Providers

| Provider | Platform | Isolation Method |
|---|---|---|
| `nsjail` | Linux | User namespaces + seccomp-bpf (`src/providers/sandbox/nsjail.ts`) |
| `bwrap` | Linux | Bubblewrap lightweight namespaces (`src/providers/sandbox/bwrap.ts`) |
| `docker` | Linux/macOS | Docker with `--network=none`, optional gVisor (`src/providers/sandbox/docker.ts`) |
| `seatbelt` | macOS | `sandbox-exec` with Seatbelt profiles (`src/providers/sandbox/seatbelt.ts`) |
| `subprocess` | Any | No isolation, dev-only (`src/providers/sandbox/subprocess.ts`) |

All providers mount the same canonical paths via `src/providers/sandbox/canonical-paths.ts`:
- Direct remapping for Docker/nsjail/bwrap
- Symlink fallback for seatbelt/subprocess

---

## Tier 3: K8s Pod — Cloud Isolation

Documented in [K8s Agent Compute Architecture](2026-03-04-k8s-agent-compute-architecture.md).
Pod-per-sandbox with gVisor runtime, NATS dispatch, warm pool management.

### When to Use

- Cloud deployments where in-pod isolation isn't possible (GKE Autopilot — no
  `CAP_SYS_ADMIN`, no `CLONE_NEWUSER`, no custom seccomp)
- Long-running workloads (>30s timeout)
- Multi-tenant environments requiring hard security boundaries
- Workloads requiring dedicated CPU/memory resource guarantees

### Dispatch Flow

```
Agent → IPC → Host → sandbox_bash handler
                        │
                        ├─ Local mode → Tier 1 or Tier 2 (local sandbox)
                        │
                        └─ K8s mode → NATS dispatch → sandbox pod
                                       │
                                       ├─ tasks.sandbox.claim (request/reply)
                                       ├─ tasks.sandbox.{podId}.bash (execute)
                                       └─ tasks.sandbox.{podId}.release (return to pool)
```

Implementation: `src/host/nats-sandbox-dispatch.ts`, `src/sandbox-worker/types.ts`.

---

## Tier Selection Logic

The host's `sandbox_bash` handler classifies commands and picks the cheapest tier
that can handle them safely.

### Classification Algorithm

```typescript
// src/providers/sandbox/tier-selector.ts

/** Commands that WASM BusyBox can handle (single-process, no shell features). */
const WASM_COMMANDS = new Set([
  'cat', 'ls', 'head', 'tail', 'wc', 'sort', 'uniq', 'echo',
  'grep', 'egrep', 'fgrep', 'find', 'mkdir', 'rmdir', 'rm',
  'cp', 'mv', 'ln', 'touch', 'chmod', 'basename', 'dirname',
  'tr', 'cut', 'tee', 'seq', 'yes', 'true', 'false', 'env',
  'pwd', 'whoami', 'id', 'date', 'sleep', 'md5sum', 'sha256sum',
  'base64', 'od', 'hexdump', 'strings', 'diff', 'patch',
  'tar', 'gzip', 'gunzip', 'xargs', 'sed',
]);

/** Shell metacharacters that require a real shell. */
const SHELL_META = /[|;&$`"'(){}!<>\n\\]/;

export type Tier = 'wasm' | 'container' | 'k8s';

export function selectTier(
  command: string,
  opts: { wasmAvailable: boolean; k8sMode: boolean },
): Tier {
  // K8s mode: everything goes to pods
  if (opts.k8sMode) return 'k8s';

  // No WASM → container
  if (!opts.wasmAvailable) return 'container';

  // Shell metacharacters → need a real shell
  if (SHELL_META.test(command)) return 'container';

  // Extract binary name
  const binary = command.trim().split(/\s+/)[0];

  // Known WASM-compatible command
  if (WASM_COMMANDS.has(binary)) return 'wasm';

  // Unknown → container (safe default)
  return 'container';
}
```

### Fallback Behavior

If WASM execution fails (e.g., unimplemented WASI call), the handler falls back to
Tier 2 automatically. False negatives (running in container when WASM would work) are
fine. False positives (running in WASM when container is needed) are bugs.

```typescript
const tier = selectTier(command, { wasmAvailable, k8sMode });

if (tier === 'wasm') {
  try {
    return await wasmExec(parseArgv(command), workspace, scratchDir);
  } catch (err) {
    log.warn({ err, command }, 'WASM exec failed, falling back to container');
  }
}

// Tier 2: container execution (existing path)
return await containerExec(command, sandboxConfig);
```

---

## WASI Filesystem Model

### How Preopens Work

WASI uses **capability-based filesystem access**. The runtime grants access to
specific host directories at instantiation via "preopens" — a map from guest paths
to host paths. The WASM module can only access files under preopened directories.

```
Guest sees:                     Host reality:
/workspace/README.md    →    /home/user/.ax/agents/abc/workspace/README.md
/workspace/scratch/out  →    /home/user/.ax/agents/abc/scratch/out
/workspace/skills/...   →    /tmp/.ax-skills-merged-a1b2c3d4/...
```

Key properties:
- **No ambient filesystem.** If it's not preopened, it doesn't exist.
- **Path traversal impossible.** The runtime resolves `../` before touching the host
  filesystem. `open("/workspace/../../../etc/passwd")` resolves to the preopen root
  (which doesn't contain `etc/passwd`), not `/etc/passwd`.
- **Read-only enforced at the runtime level.** Not via mount flags that could be
  circumvented, but in the WASI shim itself. `fd_write` returns `EBADF` for
  read-only preopens.

### Canonical Path Mapping

The WASM tier uses the same canonical paths as container tiers (from
`src/providers/sandbox/canonical-paths.ts`):

| Canonical Path | Preopen Mode | Maps To |
|---|---|---|
| `/workspace` | rw | Session workspace (CWD) |
| `/workspace/scratch` | rw | Session scratch directory |
| `/workspace/skills` | ro | Merged skills overlay |
| `/workspace/identity` | ro | Agent identity files |
| `/workspace/agent` | ro | Shared agent workspace |
| `/workspace/user` | ro | Per-user persistent storage |

Agent code that does `cat /workspace/skills/my-skill.md` works identically whether
it runs in WASM, nsjail, Docker, or a K8s pod.

---

## IPC and the Socket Problem

### The Problem

WASI Preview 1 doesn't support Unix domain sockets. Agent processes need IPC to call
the host for `llm_call`, `memory_write`, `web_fetch`, etc. How does the WASM tier
handle this?

### The Answer: It Doesn't Need To

The key insight: **WASM doesn't run the agent — it runs individual commands.**

The agent process still runs in a container sandbox (Tier 2) or K8s pod (Tier 3).
When the agent issues a `sandbox_bash` IPC call, the *host* decides whether to
execute that command via WASM or via the container's shell.

```
Agent process (in container, with IPC socket)
  │
  ├── IPC: sandbox_bash("cat README.md")
  │     └── Host: Tier 1 (WASM) → wasmExec(["cat", "README.md"])
  │
  ├── IPC: sandbox_bash("npm install")
  │     └── Host: Tier 2 (Container) → execSync in sandbox
  │
  ├── IPC: llm_call(...)
  │     └── Host: Credential proxy → API (nothing to do with sandboxing)
  │
  └── IPC: sandbox_bash("grep -r TODO src/")
        └── Host: Tier 1 (WASM) → wasmExec(["grep", "-r", "TODO", "src/"])
```

The WASM module is a pure command executor — it takes argv, reads/writes files in its
preopened directories, and returns stdout/stderr/exitCode. No IPC needed because it's
not making decisions. The agent (which makes decisions) runs in a container with full
IPC access.

This is the cleanest separation:
- **Agent** = decision-making, needs IPC, runs in container
- **Command execution** = file ops, can run in WASM, no IPC needed

### Alternatives Considered

| Option | Verdict |
|---|---|
| **WASI Preview 2 sockets** | Experimental in wasmtime, not production-ready. Revisit later. |
| **stdin/stdout IPC bridge** | Pipe IPC messages through WASM stdio. Adds complexity for no benefit over Option A. |
| **Run agent in WASM** | Would need IPC, process spawning, dynamic linking. WASI can't do this. Wrong tool for the job. |

---

## Recommended Architecture

### Integration Point

The WASM tier plugs into the existing `sandbox_bash` IPC handler in
`src/host/ipc-handlers/sandbox-tools.ts`. No changes to the `SandboxProvider`
interface, no new IPC actions, no changes to agent-side code.

```typescript
// Modified sandbox_bash handler in src/host/ipc-handlers/sandbox-tools.ts

sandbox_bash: async (req, ctx) => {
  const workspace = resolveWorkspace(opts, ctx);
  const scratch = scratchDir(ctx);
  const tier = selectTier(req.command, {
    wasmAvailable: wasmTier.isAvailable(),
    k8sMode: opts.k8sMode,
  });

  if (tier === 'wasm') {
    try {
      const result = await wasmTier.exec(parseArgv(req.command), workspace, scratch);
      return { output: result.stdout + result.stderr };
    } catch {
      // Fall through to container
    }
  }

  if (tier === 'k8s') {
    return await natsSandboxDispatch(req, ctx);
  }

  // Tier 2: container execution (existing path)
  const out = execSync(req.command, { cwd: workspace, timeout: 30_000 });
  return { output: out.toString() };
};
```

### New Files

```
src/providers/sandbox/
├── tier-selector.ts          # NEW: command classification + tier selection
├── wasm-tier.ts              # NEW: WASM execution engine
└── wasm/
    └── busybox.wasm          # NEW: pre-compiled BusyBox WASI binary
```

### No Interface Changes

The `SandboxProvider` interface (`src/providers/sandbox/types.ts`) stays exactly
as-is. WASM is not a new sandbox provider — it's an optimization *inside* the
`sandbox_bash` handler. The agent doesn't know about it. The provider registry
doesn't know about it.

This is intentional. WASM is a command execution optimization, not a new isolation
primitive. Adding it to the provider interface would complicate things for zero benefit.

---

## Security Analysis

### Threat Model: WASM Tier

| Threat | Mitigation |
|---|---|
| Filesystem escape | Impossible — WASI preopens are the only accessible paths, enforced by runtime |
| Path traversal (`../`) | Runtime resolves all paths relative to preopens before host access |
| Network access | WASI runtime doesn't implement `wasi:sockets` — no TCP/UDP/DNS |
| Resource exhaustion | Fuel metering caps instructions; memory limit caps linear memory |
| Code injection | WASM module is pre-compiled, not constructed from input |
| Environment variable leaks | Empty env map — no `API_KEY`, no `HOME`, no `PATH` |
| Time-of-check/time-of-use | Single-threaded WASM execution, no concurrent access |
| Escape to host process | WASM executes in a sandboxed VM within the Node.js process |

### Security Surface Comparison

```
                    Syscalls    FS Model         Network    Process Spawn
WASM (Tier 1)       ~45 WASI   capability-based  none       no
nsjail (Tier 2)     ~60 (bpf)  namespace+mount   unshared   yes (in ns)
Docker (Tier 2)     ~250+      overlay+mount     disabled   yes (in ctr)
K8s+gVisor (Tier 3) ~70 (sentry) overlay         NetworkPol yes (in pod)
```

WASM has the smallest attack surface of any tier. Its security guarantees are
**mathematical** (enforced by the VM specification) rather than **policy-based**
(enforced by kernel configuration that could be misconfigured).

### What WASM Doesn't Protect Against

- **Logic bugs in the WASM module itself.** If BusyBox has a buffer overflow, it
  can corrupt WASM linear memory — but can't escape the sandbox.
- **Side-channel attacks.** Timing-based information leakage is theoretically
  possible but not practically exploitable in this context.
- **Denial of service.** Fuel metering prevents infinite loops but a malicious
  command could still allocate up to the memory limit. This is bounded and
  equivalent to existing container memory limits.

---

## Implementation Plan

### Phase 1: WASM Tier (Local Dev)

1. **Acquire BusyBox WASM binary.** Compile from source (`wasm32-wasi` target) or
   use existing builds. Verify all target applets work under WASI Preview 1.
2. **Implement `wasm-tier.ts`.** WASI instantiation, stdio capture, timeout via
   `AbortSignal`, memory limits.
3. **Implement `tier-selector.ts`.** Command classification, `WASM_COMMANDS` set,
   shell metacharacter detection.
4. **Modify `sandbox-tools.ts`.** Add tier selection before container dispatch, with
   automatic fallback on WASM failure.
5. **Tests.** Unit tests for tier selection. Integration tests running common commands
   through WASM. Fallback tests confirming container execution when WASM fails.
   Source-level tests verifying no shell metacharacter bypass.

### Phase 2: Benchmarks

6. **Measure latency.** Compare WASM vs container execution for common commands:
   `cat`, `ls`, `grep`, `head`, `wc`. Target: 10-50x faster for Tier 1 commands.
7. **Measure memory.** Profile WASM module memory usage under concurrent load.
   Target: <50MB per concurrent execution.
8. **Stress test.** 100 concurrent WASM executions to verify no resource leaks or
   module corruption.

### Phase 3: Production Hardening

9. **Fuel calibration.** (Requires wasmtime migration.) Determine appropriate fuel
   limits for each command class. Too low = legitimate commands fail. Too high = DoS.
10. **WASM module integrity.** Checksum validation of the BusyBox binary at startup.
    If tampered with, refuse to use Tier 1 and log a security warning.
11. **Observability.** Emit metrics: tier selection distribution, WASM execution
    times, fallback frequency. Wire into existing logging infrastructure
    (`src/utils/logger.ts`).

### Out of Scope (Future)

- **WASI Preview 2.** Adds `wasi:sockets`, `wasi:http`, component model. Not needed
  for Tier 1 command execution. Revisit if we ever want WASM to run agent processes.
- **Custom WASM tools.** Compiling purpose-built tools (e.g., a WASM-native `jq` or
  `yq`) for common agent operations. Nice-to-have, not essential.
- **WASM for Tier 3.** Running WASM inside K8s pods. Adds complexity for minimal
  benefit — pods already have gVisor isolation.

---

## Open Questions

1. **Which WASM runtime?** Node.js built-in `node:wasi` is convenient but limited
   (no fuel metering, experimental API). `wasmtime-node` is more capable but adds
   a native dependency. **Recommendation**: start with `node:wasi`, migrate to
   `wasmtime-node` if fuel metering proves necessary.

2. **BusyBox vs uutils?** BusyBox is battle-tested and small (~2MB WASM). Rust
   `uutils/coreutils` has better WASI support but larger binary (~15MB). **Start
   with BusyBox**, switch if we hit WASI compatibility issues.

3. **Command parsing edge cases.** The tier selector parses `command.split(/\s+/)[0]`
   to extract the binary name. This breaks for: `env VAR=val cat file` (sees `env`),
   `timeout 5 grep pattern` (sees `timeout`). How deep should parsing go?
   **Safe answer**: if it's ambiguous, fall through to container. False negatives
   (running in container when WASM would work) are fine. False positives (running in
   WASM when container is needed) are bugs.

4. **Concurrent execution model.** WASM execution is synchronous within a single
   instantiation. For concurrent `sandbox_bash` calls, we need one WASM instance
   per call. The compiled `WebAssembly.Module` is shared (thread-safe); only the
   `Instance` is per-call. Verify memory usage under concurrent load before shipping.

---

## Summary

| | Tier 1: WASM | Tier 2: Container | Tier 3: K8s Pod |
|---|---|---|---|
| **Startup** | <1ms | 50-500ms | 1-5s (warm) |
| **Isolation** | WASI preopens (capability) | Namespaces + seccomp | Pod boundary + gVisor |
| **Syscall surface** | ~45 WASI calls | 60-250 (filtered) | ~70 (gVisor sentry) |
| **Network** | Not implemented | Disabled | NetworkPolicy |
| **Process spawn** | No | Yes | Yes |
| **Shell features** | No | Yes | Yes |
| **IPC access** | No (not needed) | Yes (Unix socket) | Yes (NATS) |
| **Use case** | File ops, grep, cat | Full shell, builds | Cloud, multi-tenant |
| **Availability** | Optional | Required | K8s mode only |
| **Code path** | `wasm-tier.ts` | Existing `SandboxProvider` | `nats-sandbox-dispatch.ts` |

The three-tier model gives us the best of all worlds: sub-millisecond execution for
the 60-80% of agent commands that are simple file operations, full Linux userspace
when needed, and cloud-scale isolation for production deployments. Each tier is
independently useful. The system works without WASM (just slower). It works without
K8s (just local). The tiers compose, they don't depend on each other.

We're basically a nervous crab with three shells — picking the right one depending
on whether we're crossing the street or crossing the ocean.
