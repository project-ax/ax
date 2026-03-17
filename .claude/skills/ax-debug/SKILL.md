---
name: ax-debug
description: Use when debugging k8s-related issues, NATS IPC problems, HTTP IPC problems, workspace release failures, or any issue in the sandbox/host/agent communication pipeline — runs the full k8s code path locally with debuggable processes
---

## Overview

Debug the full k8s code path (NATS or HTTP IPC, workspace release via HTTP staging, work delivery) using local processes instead of real k8s pods. Uses the `nats-subprocess` sandbox provider to spawn debuggable child processes with NATS environment.

Two transport modes are available:
- **NATS IPC** (`run-nats-local.ts`): Agent uses `NATSIPCClient` — IPC calls go via NATS request/reply
- **HTTP IPC** (`run-http-local.ts`): Agent uses `HttpIPCClient` — IPC calls go via HTTP POST to `/internal/ipc`, NATS only for work delivery

## Prerequisites

```bash
# Install NATS server (one-time)
brew install nats-server

# Build AX
npm run build
```

## Quick Start — NATS IPC

```bash
# Terminal 1: Start NATS
nats-server

# Terminal 2: Start AX with nats-subprocess sandbox (NATS IPC)
npx tsx tests/providers/sandbox/run-nats-local.ts

# Terminal 3: Send a test request
curl -X POST http://localhost:8080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"default","messages":[{"role":"user","content":"hello"}]}'
```

## Quick Start — HTTP IPC

```bash
# Terminal 1: Start NATS
nats-server

# Terminal 2: Start AX with HTTP IPC transport
npx tsx tests/providers/sandbox/run-http-local.ts

# Terminal 3: Send a test request
curl -X POST http://localhost:8080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"default","messages":[{"role":"user","content":"hello"}]}'
```

The HTTP IPC harness is a minimal host process that:
- Handles `/internal/ipc` with per-turn token auth (same as host-process.ts)
- Uses NATS `sandbox.work` queue group for work delivery with retry
- Intercepts `agent_response` IPC action to collect the agent reply

## Debugging Techniques

### Add console.log to agent or host

Edit source files directly -- the harness runs via `tsx` so changes are picked up on restart. Agent stdout/stderr is piped to the parent terminal.

Key files to instrument:

| What to debug | File | Key functions/lines |
|---|---|---|
| Work delivery (host->agent) | `src/host/host-process.ts` | `processCompletionWithNATS()`, `publishWork()` |
| HTTP IPC route (host) | `src/host/host-process.ts:710` | `/internal/ipc` POST handler, `activeTokens` |
| NATS IPC handler (host) | `src/host/nats-ipc-handler.ts` | `startNATSIPCHandler()` |
| LLM proxy (host, claude-code) | `src/host/nats-llm-proxy.ts` | `startNATSLLMProxy()` |
| Workspace staging (host) | `src/host/host-process.ts:672` | `/internal/workspace-staging` POST handler |
| Workspace release (host) | `src/host/host-process.ts:415` | `workspace_release` IPC intercept |
| Agent response (host) | `src/host/host-process.ts:444` | `agent_response` IPC intercept |
| NATS work reception (agent) | `src/agent/runner.ts` | `waitForNATSWork()` |
| HTTP IPC client (agent) | `src/agent/http-ipc-client.ts` | `call()`, `setContext()` |
| NATS IPC client (agent) | `src/agent/nats-ipc-client.ts` | `call()`, `setContext()` |
| NATS bridge (agent, claude-code) | `src/agent/nats-bridge.ts` | `startNATSBridge()` |
| Workspace release (agent) | `src/agent/workspace-release.ts` | `releaseWorkspaceScopes()` |
| Workspace CLI (agent) | `src/agent/workspace-cli.ts` | `provision`, `cleanup`, `release` commands |

### Attach Node debugger to agent process

```bash
AX_DEBUG_AGENT=1 npx tsx tests/providers/sandbox/run-nats-local.ts
```

Agent spawns with `--inspect-brk`. Attach Chrome DevTools (`chrome://inspect`) or VS Code debugger. The agent pauses at startup so you can set breakpoints before it processes work.

### Attach Node debugger to host process

```bash
node --inspect -e "import('./tests/providers/sandbox/run-nats-local.ts')"
```

### Monitor NATS traffic

```bash
# Install NATS CLI (one-time)
brew install nats-io/nats-tools/nats

# Watch all NATS subjects
nats sub ">"

# Watch only IPC requests
nats sub "ipc.request.>"

# Watch only work delivery
nats sub "agent.work.>"

# Watch LLM proxy (claude-code only)
nats sub "ipc.llm.>"
```

### Environment variables

| Env var | Default | Purpose |
|---|---|---|
| `AX_DEBUG_AGENT` | (unset) | Set to `1` to spawn agent with `--inspect-brk` |
| `NATS_URL` | `nats://localhost:4222` | NATS server URL |
| `AX_HOST_URL` | `http://localhost:8080` | Host URL for workspace staging |
| `PORT` | `8080` | Host HTTP port |
| `LOG_LEVEL` | `debug` | Log level for both host and agent |

## Message Flow

### HTTP IPC mode (run-http-local.ts)

```
1. Host spawns local process with AX_IPC_TRANSPORT=http
2. Agent creates HttpIPCClient, connects to NATS
3. Agent subscribes to sandbox.work queue group
4. Host publishes work payload via NATS request (retries until subscriber ready)
5. Agent receives work, processes it
6. Agent makes IPC calls via HTTP POST to /internal/ipc (bearer token auth)
7. Host looks up token in activeTokens, routes to IPC handler
8. Agent diffs workspace, POSTs to host /internal/workspace/release
9. Agent sends agent_response via HTTP IPC
10. Host resolves agentResponsePromise, returns to caller
```

### NATS IPC mode (run-nats-local.ts)

```
1. Host spawns local process with AX_IPC_TRANSPORT=nats
2. Agent connects to NATS, subscribes to sandbox.work queue group
3. Host publishes work payload via NATS
4. Agent processes work, makes IPC calls via ipc.request.{requestId}.{token}
5. Host's NATS IPC handler responds to each IPC call
6. (claude-code only) LLM calls proxied via ipc.llm.{requestId}.{token}
7. Agent diffs workspace, POSTs to host /internal/workspace-staging
8. Agent sends workspace_release IPC with staging_key
9. Agent sends agent_response IPC with result content
10. Host resolves completion, returns to caller
```

## Common Issues

| Symptom | Cause | Fix |
|---|---|---|
| `NATS connection refused` | nats-server not running | `nats-server` in separate terminal |
| Agent spawns but no work delivered | NATS subject mismatch | Check `POD_NAME` env matches `agent.work.{podName}` |
| `workspace_release_missing_staging` | Agent can't reach host HTTP | Check `AX_HOST_URL` is reachable from agent |
| Agent hangs after spawning | Waiting for NATS work | Check host actually published to `agent.work.{podName}` |
| `agent_response timeout` | Agent crashed or never responded | Check agent stderr for errors |
| IPC calls timing out | NATS subject token mismatch | Check `AX_IPC_TOKEN` and `AX_IPC_REQUEST_ID` match between host and agent |

## Key Files

- `tests/providers/sandbox/nats-subprocess.ts` -- The sandbox provider (spawns local processes with NATS env, supports `ipcTransport: 'http'` option)
- `tests/providers/sandbox/run-nats-local.ts` -- Test harness for NATS IPC mode (starts AX host with nats-subprocess)
- `tests/providers/sandbox/run-http-local.ts` -- Test harness for HTTP IPC mode (minimal host with `/internal/ipc` route)
- `src/host/host-process.ts` -- Host-side k8s orchestration (`processCompletionWithNATS`, `activeTokens`, `/internal/ipc` route)
- `src/host/nats-ipc-handler.ts` -- Host-side NATS IPC subscription
- `src/host/nats-llm-proxy.ts` -- Host-side LLM proxy for claude-code
- `src/agent/runner.ts` -- Agent entry point, transport selection (`AX_IPC_TRANSPORT`), NATS work reception
- `src/agent/http-ipc-client.ts` -- Agent-side HTTP IPC client (POST to `/internal/ipc`)
- `src/agent/nats-ipc-client.ts` -- Agent-side NATS IPC client
- `src/agent/nats-bridge.ts` -- Agent-side HTTP-to-NATS bridge for claude-code
- `src/agent/workspace-release.ts` -- Agent-side workspace file upload
- `tests/agent/http-ipc-client.test.ts` -- Unit tests for HttpIPCClient
