# Apple Container Reverse IPC Bridge Design

**Date:** 2026-03-14
**Status:** Draft

## Problem

The Apple Container sandbox uses `--publish-socket` for Unix socket forwarding across the VM boundary (VirtioFS doesn't support Unix sockets). Two issues:

1. **Path conflict:** The shared IPC server already owns `proxy.sock`, then `--publish-socket` tries to create the same file — the container runtime owns the host-side socket.
2. **Wrong direction:** `--publish-socket` proxies host→container connections, but IPC needs container→host (agent sends requests to host).

This causes: `Error: invalidArgument: "host socket ... already exists and may be in use"`.

## Solution

Reverse the connection direction for Apple containers only. The agent listens inside the container, the host connects via the `--publish-socket` host-side socket. Once connected, the same length-prefixed JSON IPC protocol works bidirectionally.

All other sandbox providers (subprocess, seatbelt, docker, nsjail, bwrap, k8s) are unchanged.

## Architecture

**Current flow (subprocess, docker, etc. — unchanged):**
```
Host: net.Server.listen(proxy.sock)  ←  Agent: net.connect(proxy.sock)
      ←── agent sends IPC requests ──
      ── host sends IPC responses ──→
```

**Apple container flow (new):**
```
Agent: net.Server.listen(/ipc/bridge.sock)          [inside VM]
Runtime: --publish-socket apple-<id>.sock:/ipc/bridge.sock
Host: net.connect(apple-<id>.sock)                  [forwarded into VM]
      ←── agent sends IPC requests ──               [same protocol]
      ── host sends IPC responses ──→
```

The container runtime creates the host-side socket on container start and deletes it on container stop — no stale sockets.

## Changes

### 1. `IPCClient` (agent-side: `src/agent/ipc-client.ts`)

Add `listen?: boolean` option to `IPCClientOptions`. When set, `connect()` creates a `net.Server`, listens on `socketPath`, and waits for the first inbound connection. The accepted socket is used for all subsequent `call()` invocations — identical protocol from that point on.

Reconnection in listen mode is not supported — if the bridge connection drops, the agent is effectively dead (no way to make IPC calls). The existing retry-at-spawn-level handles this.

### 2. `connectIPCBridge()` (host-side: `src/host/ipc-server.ts`)

New function that connects to a socket path and handles IPC requests using the same handler that `createIPCServer` uses. It's the mirror image: connects out instead of listening, then processes incoming requests with the same length-prefixed JSON protocol, heartbeats, and handler dispatch.

Uses `connectWithRetry(path, 20, 250)` — 5-second window for the container to start and the agent to begin listening.

### 3. Apple sandbox provider (`src/providers/sandbox/apple.ts`)

- Creates a unique per-spawn host-side socket path: `ipcSocketDir/apple-<containerName>.sock`
- Uses `--publish-socket <uniquePath>:/ipc/bridge.sock` (no conflict with shared IPC server)
- Sets `AX_IPC_LISTEN=1` and `AX_IPC_SOCKET=/ipc/bridge.sock` env vars inside the container
- Sets `bridgeSocketPath` on the returned `SandboxProcess`

### 4. `SandboxProcess` type (`src/providers/sandbox/types.ts`)

New optional field:
```typescript
/** Host-side socket path for reverse IPC bridge (Apple containers). */
bridgeSocketPath?: string;
```

Other providers don't set it — no changes needed.

### 5. `CompletionDeps` / wiring (`src/host/server-completions.ts`, `src/host/server.ts`)

- `CompletionDeps` gains `ipcHandler` field (the `handleIPC` function, set in `server.ts`)
- After `spawn()`, if `proc.bridgeSocketPath` is set, calls `connectIPCBridge()`
- Bridge is cleaned up when the process exits
- On retry: new container → new `bridgeSocketPath` → new bridge. Runtime auto-cleans old socket.

### 6. Agent runner (`src/agent/runner.ts`)

Parses `AX_IPC_LISTEN` env var. When set, creates `IPCClient` with `listen: true`.

## Security

No new attack surface:
- Bridge socket is in the same temp directory with the same owner permissions
- The vsock tunnel is point-to-point between host and VM — no network exposure
- The IPC handler is identical — all taint tracking, audit logging, and validation still applies

## Testing

**Unit tests:**
- `IPCClient` listen mode: accepts connection, `call()` works over accepted socket
- `connectIPCBridge`: connects and handles length-prefixed request/response with heartbeats
- Round-trip: `IPCClient(listen)` ↔ `connectIPCBridge`

**Integration tests:**
- Apple sandbox generates correct container args (`--publish-socket`, env vars)
- `bridgeSocketPath` is set on returned `SandboxProcess`

**Regression:**
- Full test suite passes — other providers unaffected

## Future Work

- Proxy socket (`anthropic-proxy.sock`) for claude-code agents needs the same treatment — separate concern, follow-up task
- Consider extracting the shared length-prefixed protocol into a helper used by both `createIPCServer` and `connectIPCBridge` to reduce duplication
