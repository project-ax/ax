---
name: ax-ipc
description: Use when modifying IPC protocol between host and agent — schemas, actions, length-prefix framing, or Zod validation in ipc-schemas.ts and ipc-server.ts
---

## Overview

AX host and agent processes communicate over Unix domain sockets using a length-prefixed JSON protocol. The host (`src/host/ipc-server.ts`) validates every inbound message against Zod strict schemas (`src/ipc-schemas.ts`) before dispatching to a handler.

## Protocol

- **Framing:** 4-byte big-endian `UInt32` length prefix, followed by a UTF-8 JSON payload of exactly that length.
- **Envelope format:** `{ "action": "<action_name>", ...fields }`. The `action` field is validated first (must be a known action), then the full payload is validated against the action-specific strict schema.
- **Max message size:** 10 MB (server disconnects on oversize).
- **Default timeout:** 30 seconds (client-side, per call). LLM calls should use a longer per-call timeout.

## Schema Validation (3-step)

1. **JSON parse** -- raw string to object.
2. **Envelope check** -- `IPCEnvelopeSchema` validates that `action` is in `VALID_ACTIONS`. Uses `.passthrough()` so extra fields survive to step 3.
3. **Action-specific schema** -- looked up from `IPC_SCHEMAS[action]`. Built with `z.strictObject()` via the `ipcAction()` helper. Rejects any field not explicitly declared.

Shared validators: `safeString(maxLen)`, `scopeName`, `uuid`.

## Actions Table

| Category    | Action                 | Key Request Fields                                        | Key Response Fields           |
|-------------|------------------------|-----------------------------------------------------------|-------------------------------|
| LLM         | `llm_call`             | `messages`, `model?`, `tools?`, `temperature?`, `maxTokens?` | `chunks`                     |
| Memory      | `memory_write`         | `scope`, `content`, `tags?`, `tainted?`                   | `id`                          |
| Memory      | `memory_query`         | `scope`, `query?`, `limit?`, `tags?`                      | `results`                     |
| Memory      | `memory_read`          | `id`                                                      | `entry`                       |
| Memory      | `memory_delete`        | `id`                                                      | `ok`                          |
| Memory      | `memory_list`          | `scope`, `limit?`                                         | `entries`                     |
| Web         | `web_fetch`            | `url`, `method?`, `headers?`, `timeoutMs?`                | (provider result)             |
| Web         | `web_search`           | `query`, `maxResults?`                                    | (provider result)             |
| Browser     | `browser_launch`       | `config?` (headless, viewport)                            | (session info)                |
| Browser     | `browser_navigate`     | `session`, `url`                                          | `ok`                          |
| Browser     | `browser_snapshot`     | `session`                                                 | (snapshot data)               |
| Browser     | `browser_click`        | `session`, `ref`                                          | `ok`                          |
| Browser     | `browser_type`         | `session`, `ref`, `text`                                  | `ok`                          |
| Browser     | `browser_screenshot`   | `session`                                                 | `data` (base64)               |
| Browser     | `browser_close`        | `session`                                                 | `ok`                          |
| Skills      | `skill_read`           | `name`                                                    | `content`                     |
| Skills      | `skill_list`           | (none)                                                    | `skills`                      |
| Skills      | `skill_propose`        | `skill`, `content`, `reason?`                             | (proposal result)             |
| Audit       | `audit_query`          | `filter?` (action, sessionId, since, until, limit)        | `entries`                     |
| Delegation  | `agent_delegate`       | `task`, `context?`, `maxTokens?`, `timeoutSec?`          | `response`                    |
| Identity    | `identity_write`       | `file`, `content`, `reason`, `origin`                     | `applied` or `queued`         |
| Identity    | `user_write`           | `userId`, `content`, `reason`, `origin`                   | `applied` or `queued`         |
| Scheduler   | `scheduler_add_cron`   | `schedule`, `prompt`, `maxTokenBudget?`                   | `jobId`                       |
| Scheduler   | `scheduler_remove_cron`| `jobId`                                                   | `removed`                     |
| Scheduler   | `scheduler_list_jobs`  | (none)                                                    | `jobs`                        |

All responses are wrapped: `{ "ok": true, ...fields }` on success, `{ "ok": false, "error": "..." }` on failure.

## Common Tasks

### Adding a new IPC action

1. **Schema** -- In `src/ipc-schemas.ts`, define via `ipcAction('action_name', { ...fields })`. It auto-registers in `IPC_SCHEMAS`.
2. **Handler** -- In `src/host/ipc-server.ts`, add an entry to the `handlers` record. Receives `(req, ctx: IPCContext)`.
3. **Agent tools** -- Register in BOTH:
   - `src/agent/ipc-tools.ts` (TypeBox params, for pi-agent-core runner)
   - `src/agent/mcp-server.ts` (Zod params, for claude-code runner)
4. **Tests** -- Update tool count assertion in `tests/sandbox-isolation.test.ts`.

### Modifying an existing action's schema

1. Update the schema in `src/ipc-schemas.ts`.
2. Update the handler in `src/host/ipc-server.ts` if new fields need processing.
3. Update tool definitions in `ipc-tools.ts` and `mcp-server.ts` if agent-facing params changed.
4. Run `npm test` -- strict mode means any caller sending the old shape will break.

## Gotchas

- **Strict mode rejects unknown fields.** `z.strictObject()` fails the entire request if the payload contains any field not in the schema. Unit tests with mock IPC won't catch this -- always test end-to-end.
- **Default timeout is 30s.** LLM calls can take minutes; use per-call timeout overrides via `client.call(req, timeoutMs)`.
- **Two tool registries.** `ipc-tools.ts` (TypeBox) and `mcp-server.ts` (Zod) must stay in sync. Missing one means that runner has no access to the tool.
- **Taint budget.** `identity_write` and `user_write` bypass the global taint check (step 3.5) and handle taint internally (queue vs block).
- **Spread override.** The dispatcher does `{ ok: true, ...result }`. If a handler returns `{ ok: false }`, the spread overwrites `ok: true`.
