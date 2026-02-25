---
name: ax-provider-sandbox
description: Use when modifying agent sandbox isolation -- seatbelt (macOS), nsjail (Linux), Docker, or subprocess providers in src/providers/sandbox/
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
| docker     | `docker.ts`      | Linux / macOS  | Container, --network=none, --cap-drop=ALL, optional gVisor |
| subprocess | `subprocess.ts`  | Any            | None -- dev-only fallback, logs warning |

Shared helpers (`exitCodePromise`, `enforceTimeout`, `killProcess`, `checkCommand`, `sandboxProcess`) live in `utils.ts`.

## Seatbelt (macOS)

Uses `sandbox-exec -f policies/agent.sb` with `-D` parameter substitution for dynamic paths (WORKSPACE, SKILLS, IPC_SOCKET_DIR, PROJECT_DIR, NODE_DIR, AGENT_DIR). Minimal env -- no credentials leak. Key rules:

- **Last matching rule wins.** Use specific denies (`deny network-outbound (remote ip)`) not blanket `deny network*`, or Unix socket allows get overridden.
- **Node.js needs:** root readdir `(allow file-read* (literal "/"))`, OpenSSL at `/System/Library/OpenSSL`, resolv.conf at `/private/etc`, file-read-metadata, the nvm/fnm/volta node install path.
- **stdio 'ignore' requires** `(allow file-write* (literal "/dev/null"))` -- Node opens /dev/null for ignored fds.

## Nsjail (Linux)

Default production sandbox. Uses `--clone_newnet` (no network), `--clone_newuser`, `--clone_newpid`, `--clone_newipc`. Resource limits enforced at kernel level (`--time_limit`, `--rlimit_as`, `--max_cpus`). Seccomp-bpf policy via `policies/agent.kafel`. Bind-mounts workspace (rw), skills (ro), agentDir (ro), IPC socket dir, and Node.js install path.

## Common Tasks

### Adding a new sandbox provider

1. Create `src/providers/sandbox/<name>.ts` implementing `SandboxProvider`.
2. Export `create(config: Config)`.
3. Add to `PROVIDER_MAP` in `src/host/provider-map.ts`.
4. Ensure `spawn()` passes minimal env: `AX_IPC_SOCKET`, `AX_WORKSPACE`, `AX_SKILLS` only.
5. Enforce `--network=none` or equivalent -- this is a security invariant.
6. Mount workspace (rw), skills (ro), agentDir (ro), IPC socket dir.
7. Add integration test in `tests/providers/sandbox/`.

## Gotchas

- **Seatbelt last-matching-rule-wins.** Blanket deny at end overrides earlier allows. Use specific denies.
- **Node.js runtime needs specific filesystem allows** in any sandbox -- root readdir, OpenSSL, resolv.conf, /dev/null write. Missing any causes silent SIGABRT (exit 134).
- **Use direct binary paths** (`node_modules/.bin/tsx`) not `npx` inside sandboxes -- npx attempts network access and hangs.
- **Always have an integration test with the real sandbox**, not just subprocess fallback. The subprocess provider has zero isolation and masks sandbox policy bugs. Use `test.skipIf(!IS_MACOS)` or platform guards.
- **New host paths must be added to ALL providers.** When the agent needs a new mount (like agentDir), update SandboxConfig, seatbelt (-D param + policy rule), nsjail (--bindmount_ro), docker (-v :ro). Subprocess works without changes but real sandboxes silently block access.
