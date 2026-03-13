---
name: provider-sandbox
description: Use when modifying agent sandbox isolation -- seatbelt (macOS), nsjail (Linux), bwrap (Linux), Docker, or subprocess providers in src/providers/sandbox/
---

## Overview

Sandbox providers isolate agent processes with zero network access, no credentials, and mount-only filesystem access. Each provider implements `SandboxProvider` from `src/providers/sandbox/types.ts` and exports `create(config: Config)`.

## Interface

**SandboxConfig** -- passed to `spawn()`:

| Field        | Type       | Notes                                  |
|--------------|------------|----------------------------------------|
| workspace    | `string`   | Agent working directory (rw mount)     |
| skills       | `string`   | Skills directory (ro mount)            |
| ipcSocket    | `string`   | Unix socket path for IPC               |
| agentDir     | `string?`  | Identity files directory (ro mount)    |
| timeoutSec   | `number?`  | Process timeout                        |
| memoryMB     | `number?`  | Memory limit                           |
| command      | `string[]` | Command + args to execute              |

**SandboxProcess** -- returned by `spawn()`: `pid`, `exitCode` (Promise), `stdout`/`stderr` (ReadableStream), `stdin` (WritableStream), `kill()`.

**SandboxProvider**: `spawn(config)`, `kill(pid)`, `isAvailable()`.

## Implementations

| Name       | File             | Platform       | Isolation                              |
|------------|------------------|----------------|----------------------------------------|
| seatbelt   | `seatbelt.ts`    | macOS          | sandbox-exec with .sb policy           |
| nsjail     | `nsjail.ts`      | Linux          | Namespaces + seccomp-bpf (production)  |
| bwrap      | `bwrap.ts`       | Linux          | Bubblewrap containerization            |
| docker     | `docker.ts`      | Linux / macOS  | Container, --network=none, --cap-drop=ALL, optional gVisor |
| subprocess | `subprocess.ts`  | Any            | None -- dev-only fallback, logs warning |

Shared helpers in `utils.ts`: `exitCodePromise`, `enforceTimeout`, `killProcess`, `checkCommand`, `sandboxProcess`.

## Dev/Prod Mode Support

`utils.ts` includes EPERM handling for tsx-wrapped agents:
- **Dev mode**: Agent spawned via `tsx src/agent/runner.ts` -- tsx wrapper may throw EPERM when parent sends SIGTERM/SIGKILL
- **Prod mode**: Agent spawned via `node dist/agent/runner.js` -- standard signal handling
- **`enforceTimeout()`**: Wraps `kill()` in try/catch to handle EPERM gracefully, preventing sandbox crash on agent timeout

## Seatbelt (macOS)

Uses `sandbox-exec -f policies/agent.sb` with `-D` parameter substitution for dynamic paths. Minimal env -- no credentials. Key rules:

- **Last matching rule wins.** Use specific denies, not blanket `deny network*`.
- **Node.js needs:** root readdir, OpenSSL at `/System/Library/OpenSSL`, resolv.conf, file-read-metadata, node install path.
- **stdio 'ignore' requires** `(allow file-write* (literal "/dev/null"))`.

## Nsjail (Linux)

Production sandbox. `--clone_newnet` (no network), `--clone_newuser`, `--clone_newpid`, `--clone_newipc`. Resource limits at kernel level. Seccomp-bpf via `policies/agent.kafel`. Bind-mounts workspace (rw), skills (ro), agentDir (ro), IPC socket dir, Node.js path.

## Common Tasks

### Adding a new sandbox provider

1. Create `src/providers/sandbox/<name>.ts` implementing `SandboxProvider`.
2. Export `create(config: Config)`.
3. Add to `PROVIDER_MAP` in `src/host/provider-map.ts`.
4. Ensure `spawn()` passes minimal env: `AX_IPC_SOCKET`, `AX_WORKSPACE`, `AX_SKILLS` only.
5. Enforce `--network=none` or equivalent -- security invariant.
6. Mount workspace (rw), skills (ro), agentDir (ro), IPC socket dir.
7. Add integration test in `tests/providers/sandbox/`.

## Gotchas

- **Seatbelt last-matching-rule-wins.** Blanket deny at end overrides earlier allows.
- **Node.js runtime needs specific filesystem allows** -- missing any causes silent SIGABRT (exit 134).
- **Use direct binary paths** (`node_modules/.bin/tsx`) not `npx` inside sandboxes.
- **Always have an integration test with the real sandbox**, not just subprocess fallback.
- **New host paths must be added to ALL providers.** SandboxConfig, seatbelt (-D param + policy rule), nsjail (--bindmount_ro), bwrap (--ro-bind), docker (-v :ro).
- **EPERM on kill**: tsx-wrapped agents may throw EPERM on SIGTERM/SIGKILL. `enforceTimeout()` handles this with try/catch. Don't let it propagate.
