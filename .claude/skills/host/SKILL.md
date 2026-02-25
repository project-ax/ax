---
name: ax-host
description: Use when modifying the trusted host process — server orchestration, message routing, IPC handler, or request lifecycle in src/host/
---

## Overview

The host subsystem is the trusted half of AX. It runs the HTTP server (OpenAI-compatible API over Unix socket), routes inbound/outbound messages through security scanning and taint tracking, dispatches IPC actions from sandboxed agents to provider implementations, and manages the agent process lifecycle (spawn, stdin, stdout, cleanup).

## Key Files

| File | Responsibility | Lines |
|---|---|---|
| `src/host/server.ts` | HTTP server, request lifecycle, agent spawn, channel/scheduler wiring | ~930 |
| `src/host/router.ts` | Inbound scan + taint-wrap + canary inject; outbound scan + canary check | ~155 |
| `src/host/ipc-server.ts` | Unix socket server, IPC action dispatch, Zod validation, taint budget gate | ~550 |
| `src/host/proxy.ts` | Credential-injecting Anthropic forward proxy, OAuth 401 retry | ~235 |
| `src/host/taint-budget.ts` | Per-session taint ratio tracking, action gating (SC-SEC-003) | ~130 |
| `src/host/provider-map.ts` | Static allowlist mapping config names to provider modules (SC-SEC-002) | ~95 |
| `src/host/registry.ts` | Loads and assembles ProviderRegistry from config | ~40 |

## Request Lifecycle (server.ts `processCompletion`)

1. Build `InboundMessage`, call `router.processInbound()` (scan, taint-wrap, canary inject, enqueue)
2. Dequeue message **by ID** (not FIFO) from MessageQueue
3. Create workspace dir, copy skills, write `message.txt` and `CONTEXT.md`
4. Build conversation history (DB-persisted for persistent sessions, client-provided for ephemeral)
5. Start credential proxy if LLM is not mock; refresh OAuth pre-flight
6. Spawn sandboxed agent process, write JSON payload to stdin (history, message, taintRatio, profile)
7. Collect stdout/stderr in parallel (avoids pipe buffer deadlock)
8. Call `router.processOutbound()` (scan output, check canary leakage, strip canary)
9. Persist conversation turns, clean up workspace/proxy

## Router (router.ts)

- **`processInbound(msg)`**: Canonicalizes session ID, generates canary token, wraps content in `<external_content>` taint tags, records in taint budget, runs `scanner.scanInput()`, enqueues with canary appended as HTML comment. Returns `RouterResult` with `queued` boolean.
- **`processOutbound(response, sessionId, canaryToken)`**: Checks `scanner.checkCanary()` for leakage, runs `scanner.scanOutput()`, strips canary from response. Redacts entire response if canary leaked.

## IPC Server (ipc-server.ts)

**Protocol**: 4-byte big-endian length prefix + JSON over Unix socket.

**Dispatch pipeline** (steps in `handleIPC`):
1. Parse JSON
2. Validate envelope schema (`IPCEnvelopeSchema`)
3. Validate action-specific Zod schema (`.strict()` mode)
4. **Step 3.5**: Taint budget check -- hard-blocks tainted sessions (except `identity_write` and `user_write` which do soft queuing in their handlers)
5. Dispatch to handler function, audit log result

**Handler pattern**: `handlers` record maps action name to `async (req, ctx) => result`. Each handler calls the corresponding provider method and returns a JSON-serializable result.

## Common Tasks

**Adding a new HTTP endpoint:**
1. Add URL match in `handleRequest()` in `server.ts`
2. Create handler function (follow `handleModels` / `handleCompletions` pattern)
3. Return JSON with `Content-Length` header

**Adding a new IPC action handler:**
1. Add Zod schema in `src/ipc-schemas.ts` (must use `.strict()`)
2. Add handler in `handlers` record in `ipc-server.ts`
3. Register tool in `src/agent/ipc-tools.ts` AND `src/agent/mcp-server.ts`
4. Update tool count assertion in `tests/sandbox-isolation.test.ts`

**Modifying the routing pipeline:**
1. Edit `processInbound` / `processOutbound` in `router.ts`
2. Update `RouterResult` / `OutboundResult` types if adding fields
3. Update callers in `server.ts` (HTTP path, channel path, scheduler path)

## Gotchas

- **Dequeue by ID, not FIFO**: `db.dequeueById(result.messageId)` -- FIFO dequeue causes session ID mismatches and empty canary tokens (`''.includes('')` is always true, redacting every response).
- **Consumed response body in proxy retry**: After reading the body for a 401 check, the original response is consumed. The retry path must use the new response; the fallthrough path must reconstruct from the already-read body.
- **Pino uses underscore keys**: Logger calls are `logger.info('server_listening')` not `'server listening'`. Tests scanning log output must match underscores.
- **identity_write / user_write skip global taint gate**: These actions do soft queuing (return `{ queued: true }`) in their handlers instead of hard-blocking at step 3.5.
- **Collect stdout/stderr in parallel**: Sequential collection deadlocks when one pipe buffer fills while the other is being drained.
- **Channel deduplication**: Slack delivers events multiple times on reconnect. Server uses TTL-based `processedMessages` map keyed by `channelName:messageId`.
- **OAuth pre-flight**: `ensureOAuthTokenFresh()` runs before each agent spawn; proxy handles reactive 401 retry as fallback.
