---
name: ax-security
description: Use when modifying security mechanisms — taint budget, canary tokens, path traversal defense, sandbox isolation, scanner patterns, or any security-sensitive code paths
---

## Overview

AX enforces four security controls across the host/agent boundary. **SC-SEC-001** isolates agents in sandboxed containers with no network or credentials. **SC-SEC-002** loads providers only from a static allowlist in `src/host/provider-map.ts` -- no dynamic imports from config values. **SC-SEC-003** tracks per-session taint ratios and blocks sensitive actions when external content dominates the conversation. **SC-SEC-004** prevents path traversal via `safePath()` on every file-based provider.

## Taint Budget (SC-SEC-003)

| Profile   | Threshold | Meaning                                    |
|-----------|-----------|--------------------------------------------|
| paranoid  | 10%       | Blocks if >10% of session tokens are tainted |
| balanced  | 30%       | Default -- moderate external content allowed |
| yolo      | 60%       | Permissive, still blocks majority-tainted    |

- `TaintBudget` class in `src/host/taint-budget.ts` tracks `taintedTokens / totalTokens` per session.
- `recordContent(sessionId, content, isTainted)` called in `router.processInbound()` for every inbound message.
- `checkAction(sessionId, action)` called in `src/host/ipc-server.ts` dispatch (line ~420) as a global gate before handler execution.
- Actions with custom taint handling (`identity_write`, `user_write`) skip the global gate and call `checkAction()` inside their handlers (soft block with queuing, not hard block).
- Default sensitive actions: `identity_write`, `user_write`, `oauth_call`, `skill_propose`, `browser_navigate`, `scheduler_add_cron`.
- Users can override per-action via `addUserOverride(sessionId, action)`.

## Canary Tokens

1. **Injection** -- `router.processInbound()` generates a token via `providers.scanner.canaryToken()` (random hex: `CANARY-<32hex>`). Appended to queued content as `<!-- canary:<token> -->`.
2. **Detection** -- `router.processOutbound()` calls `providers.scanner.checkCanary(response, token)`. If the token appears in the agent's response, the content is fully redacted.
3. **Audit** -- Leakage triggers an audit log entry (`canary_leaked`, result: `blocked`). The response is replaced with `[Response redacted: canary token leaked]`.
4. **Cleanup** -- Any residual token in non-leaked responses is stripped via `replaceAll(token, '[REDACTED]')`.

## Safe Path (SC-SEC-004)

`src/utils/safe-path.ts` exports two functions:
- **`safePath(baseDir, ...segments)`** -- Sanitizes segments (strips `..`, path separators, null bytes, colons), joins to base, resolves to absolute, and verifies containment. Throws on escape.
- **`assertWithinBase(baseDir, targetPath)`** -- Validates an existing path is inside the base directory.
- **Required** in every file-based provider that constructs paths from agent/user/external input.

## Taint Tagging

- All external content is wrapped: `<external_content trust="external" source="...">...</external_content>`.
- `TaintTag` structure (from `src/types.ts`): `{ source: string, trust: 'user' | 'external' | 'system', timestamp: Date }`.
- Wrapping happens in `router.processInbound()`. Messages from `provider !== 'system'` are marked tainted.

## Sandbox Isolation (SC-SEC-001)

- **No network** -- Agent containers deny all TCP/IP. Unix sockets allowed only for IPC.
- **No credentials** -- API keys and OAuth tokens never enter the container. The credential-injecting proxy runs host-side.
- **Mount-only** -- Sandbox exposes: workspace (read-write), skills directory (read-only), IPC socket, agent directory (read-only).
- Providers: seatbelt (macOS), bwrap (Linux), nsjail (Linux), Docker, subprocess (dev fallback).
- New host paths require updates to ALL sandbox providers (SandboxConfig, seatbelt policy, bwrap, nsjail, Docker).

## Common Tasks

### Adding a new sensitive action to taint budget
1. Add the action string to `DEFAULT_SENSITIVE_ACTIONS` in `src/host/taint-budget.ts`.
2. If the action needs soft blocking (queue instead of reject), skip it in the global gate in `ipc-server.ts` (`actionName !== 'your_action'`) and call `taintBudget.checkAction()` inside the handler.
3. Add a test in `tests/host/taint-budget.test.ts`.

### Adding a new scanner pattern
1. Add the pattern to `src/providers/scanner/patterns.ts`.
2. Add test cases in `tests/providers/scanner/` covering match and non-match.
3. Verify regex edge cases: punctuation in tokens, greedy quantifiers, multi-word sequences with optional groups.

## Invariants

- Credentials never enter agent containers.
- No network access from agent processes (TCP/IP denied; Unix socket IPC only).
- All external content is taint-tagged before reaching the agent.
- Provider loading uses static allowlist only -- no dynamic path construction from config.
- Every file path from untrusted input passes through `safePath()`.
- Canary tokens are stripped or redacted before responses reach the user.
- All security-relevant actions are audit-logged.
- `ipc-schemas.ts` uses `.strict()` mode -- no unexpected fields pass validation.
