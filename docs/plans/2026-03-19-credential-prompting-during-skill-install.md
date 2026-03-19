# Host-Side Credential Prompting During Skill Install

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** When a skill requires API keys (`requires.env`), prompt the user for missing credentials through the existing channel (Slack, web chat UI, admin dashboard) — entirely host-side, so real credentials never touch the agent or sandbox.

**Architecture:** Modeled on the existing `web_proxy.approval_required` pattern. The host detects missing credentials during sandbox launch (in `server-completions.ts`), emits a `credential.required` event via the event bus, and blocks via a new `credential-prompts.ts` registry until the user provides the value. Three resolution paths: (1) the chat completions SSE stream emits a named `event: credential_required` event, and the client POSTs back to `POST /v1/credentials/provide`; (2) the admin dashboard SSE + `POST /admin/api/credentials/provide`; (3) the agent-side IPC handler `credential_provide` (for Slack and other channel-driven flows where the agent relays the host's prompt).

**Tech Stack:** Existing event bus, SSE streaming, `web-proxy-approvals.ts` as template, new HTTP endpoint in `server.ts` and `server-admin.ts`.

---

## Task 1: Credential Prompt Registry

**Files:**
- Create: `src/host/credential-prompts.ts`
- Test: `tests/host/credential-prompts.test.ts`

This module mirrors `web-proxy-approvals.ts` but for credential prompts. It blocks until the user provides a value or the timeout expires.

**Step 1: Write the failing test**

```typescript
// tests/host/credential-prompts.test.ts
import { describe, test, expect, afterEach } from 'vitest';

describe('credential-prompts', () => {
  afterEach(async () => {
    const { cleanupSession } = await import('../../src/host/credential-prompts.js');
    cleanupSession('test-session');
  });

  test('requestCredential blocks until resolveCredential is called', async () => {
    const { requestCredential, resolveCredential } = await import('../../src/host/credential-prompts.js');

    // Start the request (non-blocking — returns a promise)
    const promise = requestCredential('test-session', 'LINEAR_API_KEY');

    // Resolve it from another "thread"
    setTimeout(() => resolveCredential('test-session', 'LINEAR_API_KEY', 'lin_real_key'), 10);

    const result = await promise;
    expect(result).toBe('lin_real_key');
  });

  test('requestCredential returns null on timeout', async () => {
    const { requestCredential } = await import('../../src/host/credential-prompts.js');

    // Use a very short timeout for testing
    const result = await requestCredential('test-session', 'MISSING_KEY', 50);
    expect(result).toBeNull();
  });

  test('duplicate requests for same credential piggyback', async () => {
    const { requestCredential, resolveCredential } = await import('../../src/host/credential-prompts.js');

    const p1 = requestCredential('test-session', 'API_KEY');
    const p2 = requestCredential('test-session', 'API_KEY');

    setTimeout(() => resolveCredential('test-session', 'API_KEY', 'the_value'), 10);

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toBe('the_value');
    expect(r2).toBe('the_value');
  });

  test('resolveCredential returns false if no pending request', async () => {
    const { resolveCredential } = await import('../../src/host/credential-prompts.js');
    const found = resolveCredential('test-session', 'NOPE', 'val');
    expect(found).toBe(false);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npm test -- --run tests/host/credential-prompts.test.ts`
Expected: FAIL — module not found

**Step 3: Write minimal implementation**

```typescript
// src/host/credential-prompts.ts
/**
 * Pending credential prompt registry.
 *
 * When the host detects a missing credential during sandbox launch, it calls
 * requestCredential() which blocks until the user provides the value via
 * resolveCredential() (called from the HTTP endpoint or IPC handler) or
 * the timeout expires (returns null).
 *
 * Modeled on web-proxy-approvals.ts.
 */

import { getLogger } from '../logger.js';

const logger = getLogger().child({ component: 'credential-prompts' });

/** How long to wait for the user to provide a credential before giving up. */
const DEFAULT_TIMEOUT_MS = 120_000;

interface PendingEntry {
  resolve: (value: string | null) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** sessionId → Map<envName, PendingEntry> */
const pending = new Map<string, Map<string, PendingEntry>>();

/**
 * Request a credential from the user. Returns a Promise that resolves with
 * the credential value when provided, or null if the timeout expires.
 */
export function requestCredential(
  sessionId: string,
  envName: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<string | null> {
  // Already pending — piggyback on the existing request
  const sessionPending = pending.get(sessionId);
  if (sessionPending?.has(envName)) {
    return new Promise<string | null>((resolve) => {
      const existing = sessionPending.get(envName)!;
      const origResolve = existing.resolve;
      existing.resolve = (value) => {
        origResolve(value);
        resolve(value);
      };
    });
  }

  return new Promise<string | null>((resolve) => {
    let map = pending.get(sessionId);
    if (!map) {
      map = new Map();
      pending.set(sessionId, map);
    }

    const timer = setTimeout(() => {
      map!.delete(envName);
      if (map!.size === 0) pending.delete(sessionId);
      logger.info('credential_prompt_timeout', { sessionId, envName });
      resolve(null);
    }, timeoutMs);
    if (timer.unref) timer.unref();

    map.set(envName, { resolve, timer });
    logger.debug('credential_prompt_requested', { sessionId, envName });
  });
}

/**
 * Resolve a pending credential prompt. Called from the HTTP endpoint or IPC handler.
 * Returns true if a pending request was found and resolved.
 */
export function resolveCredential(sessionId: string, envName: string, value: string): boolean {
  const sessionPending = pending.get(sessionId);
  const entry = sessionPending?.get(envName);
  if (!entry) return false;

  clearTimeout(entry.timer);
  sessionPending!.delete(envName);
  if (sessionPending!.size === 0) pending.delete(sessionId);

  logger.info('credential_prompt_resolved', { sessionId, envName });
  entry.resolve(value);
  return true;
}

/**
 * Clean up all pending prompts for a session.
 */
export function cleanupSession(sessionId: string): void {
  const sessionPending = pending.get(sessionId);
  if (sessionPending) {
    for (const entry of sessionPending.values()) {
      clearTimeout(entry.timer);
      entry.resolve(null);
    }
    pending.delete(sessionId);
  }
}
```

**Step 4: Run test to verify it passes**

Run: `npm test -- --run tests/host/credential-prompts.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/host/credential-prompts.ts tests/host/credential-prompts.test.ts
git commit -m "feat: add credential prompt registry for host-side credential collection"
```

---

## Task 2: Emit `credential.required` Event and Block on Missing Credentials

**Files:**
- Modify: `src/host/server-completions.ts` (credential collection loop)
- Test: `tests/host/credential-prompts.test.ts` (add integration test)

Currently, missing credentials are silently skipped. This task makes the host emit a `credential.required` event and block until the user provides the value.

**Step 1: Write the failing test**

Add to `tests/host/credential-prompts.test.ts`:

```typescript
test('integration: emits event and blocks until credential provided', async () => {
  const { requestCredential, resolveCredential } = await import('../../src/host/credential-prompts.js');

  // Simulate the server-completions flow:
  // 1. Detect missing credential
  // 2. Emit event (we'll just verify the blocking behavior)
  // 3. Block until resolved
  const events: string[] = [];

  const promise = (async () => {
    events.push('requesting');
    const value = await requestCredential('int-test', 'GITHUB_TOKEN', 5000);
    events.push(`got:${value}`);
    return value;
  })();

  // Simulate user providing credential after a delay
  await new Promise(r => setTimeout(r, 20));
  events.push('providing');
  resolveCredential('int-test', 'GITHUB_TOKEN', 'ghp_secret');

  const result = await promise;
  expect(result).toBe('ghp_secret');
  expect(events).toEqual(['requesting', 'providing', 'got:ghp_secret']);
});
```

**Step 2: Run test to verify it passes** (uses already-built module)

Run: `npm test -- --run tests/host/credential-prompts.test.ts`
Expected: PASS

**Step 3: Modify `server-completions.ts` credential collection loop**

Replace the current credential collection block (the one that just logs `credential_not_found`) with one that emits an event and blocks:

In `server-completions.ts`, find the block that starts with `// Build credential placeholders for skill-required env vars` (around line 735) and replace:

```typescript
    // Build credential placeholders for skill-required env vars (now that workspace paths are set).
    if (config.web_proxy) {
      const skillEnvRequirements = collectSkillEnvRequirements(
        agentWsPath ? join(agentWsPath, 'skills') : undefined,
        userWsPath ? join(userWsPath, 'skills') : undefined,
      );
      for (const envName of skillEnvRequirements) {
        let realValue = await providers.credentials.get(envName);

        // If credential is missing, prompt the user for it
        if (!realValue) {
          reqLogger.info('credential_prompt_emitting', { envName });
          eventBus?.emit({
            type: 'credential.required',
            requestId,
            timestamp: Date.now(),
            data: { envName, sessionId },
          });

          const { requestCredential } = await import('./credential-prompts.js');
          const provided = await requestCredential(sessionId, envName);
          if (provided) {
            // Store for future sessions
            await providers.credentials.set(envName, provided).catch(() => {
              reqLogger.debug('credential_store_failed', { envName });
            });
            realValue = provided;
          }
        }

        if (realValue) {
          credentialMap.register(envName, realValue);
          reqLogger.debug('credential_placeholder_registered', { envName });
        } else {
          reqLogger.debug('credential_not_found', { envName });
        }
      }
    }
```

Add the import at the top of server-completions.ts (it's already there from the MITM work — no change needed for the `import` line since we use dynamic `import()` above).

**Step 4: Run host tests**

Run: `npm test -- --run tests/host/`
Expected: ALL PASS

**Step 5: Commit**

```bash
git add src/host/server-completions.ts tests/host/credential-prompts.test.ts
git commit -m "feat: emit credential.required event and block on missing credentials"
```

---

## Task 3: SSE Named Event in Chat Completions Stream

**Files:**
- Modify: `src/host/server.ts` (add `credential.required` handler in SSE subscriber)
- Test: `tests/host/server-credentials-sse.test.ts`

The chat completions endpoint already subscribes to request-scoped events for `llm.chunk` and `tool.call`. Add handling for `credential.required` — emit it as a named SSE event (`event: credential_required`) so web chat UIs can show a credential input modal.

**Step 1: Write the failing test**

```typescript
// tests/host/server-credentials-sse.test.ts
import { describe, test, expect } from 'vitest';

describe('credential.required SSE event', () => {
  test('sendSSENamedEvent emits named SSE event format', async () => {
    const { sendSSENamedEvent } = await import('../../src/host/server-http.js');

    // Mock ServerResponse
    const chunks: string[] = [];
    const mockRes = {
      write: (data: string) => { chunks.push(data); return true; },
    };

    sendSSENamedEvent(mockRes as any, 'credential_required', {
      envName: 'LINEAR_API_KEY',
      sessionId: 'sess-1',
    });

    expect(chunks.length).toBe(1);
    // Named SSE event format: "event: <name>\ndata: <json>\n\n"
    expect(chunks[0]).toContain('event: credential_required\n');
    expect(chunks[0]).toContain('"envName":"LINEAR_API_KEY"');
    expect(chunks[0]).toContain('\n\n');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npm test -- --run tests/host/server-credentials-sse.test.ts`
Expected: FAIL — `sendSSENamedEvent` not exported

**Step 3: Add `sendSSENamedEvent` to `server-http.ts`**

Add after the existing `sendSSEChunk` function:

```typescript
/** Send a named SSE event (non-OpenAI format, for custom client handling). */
export function sendSSENamedEvent(res: ServerResponse, eventName: string, data: Record<string, unknown>): void {
  res.write(`event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`);
}
```

**Step 4: Run test to verify it passes**

Run: `npm test -- --run tests/host/server-credentials-sse.test.ts`
Expected: PASS

**Step 5: Add `credential.required` handler in SSE subscriber in `server.ts`**

In `server.ts`, inside the `subscribeRequest` callback (around line 837), add a new `else if` branch after the `tool.call` handler:

```typescript
        } else if (event.type === 'credential.required' && event.data.envName) {
          // Emit as a named SSE event — web chat UIs show a credential input modal.
          // This is NOT an OpenAI-format chunk; clients that don't understand named
          // events will safely ignore it.
          sendSSENamedEvent(res, 'credential_required', {
            envName: event.data.envName as string,
            sessionId: event.data.sessionId as string,
            requestId,
          });
        }
```

Add the import at the top of server.ts:

```typescript
import { sendSSEChunk, sendSSENamedEvent, ... } from './server-http.js';
```

**Step 6: Run tests**

Run: `npm test -- --run tests/host/`
Expected: ALL PASS

**Step 7: Commit**

```bash
git add src/host/server-http.ts src/host/server.ts tests/host/server-credentials-sse.test.ts
git commit -m "feat: emit credential_required named SSE event in chat completions stream"
```

---

## Task 4: HTTP Endpoint for Credential Resolution

**Files:**
- Modify: `src/host/server.ts` (add `POST /v1/credentials/provide` route)
- Modify: `src/host/server-admin.ts` (add `POST /admin/api/credentials/provide` route)
- Test: `tests/host/credential-provide-endpoint.test.ts`

Two HTTP endpoints that resolve pending credential prompts — one on the main API (`/v1/credentials/provide` for web chat UI) and one on the admin API (`/admin/api/credentials/provide` for the admin dashboard).

**Step 1: Write the failing test**

```typescript
// tests/host/credential-provide-endpoint.test.ts
import { describe, test, expect, afterEach } from 'vitest';
import * as http from 'node:http';

describe('credential provide endpoint', () => {
  test('resolveCredential is called with correct args', async () => {
    const { requestCredential, resolveCredential, cleanupSession } = await import('../../src/host/credential-prompts.js');

    // Start a pending request
    const promise = requestCredential('sess-1', 'LINEAR_API_KEY', 5000);

    // Simulate the HTTP endpoint calling resolveCredential
    const found = resolveCredential('sess-1', 'LINEAR_API_KEY', 'lin_key_123');
    expect(found).toBe(true);

    const result = await promise;
    expect(result).toBe('lin_key_123');

    cleanupSession('sess-1');
  });
});
```

**Step 2: Run test to verify it passes** (tests existing module)

Run: `npm test -- --run tests/host/credential-provide-endpoint.test.ts`
Expected: PASS

**Step 3: Add route to `server.ts`**

In `server.ts`, add a new route handler before the `sendError(res, 404, 'Not found')` fallback:

```typescript
    // POST /v1/credentials/provide — resolve a pending credential prompt
    if (url === '/v1/credentials/provide' && req.method === 'POST') {
      try {
        const body = JSON.parse(await readBody(req));
        const { sessionId, envName, value } = body;
        if (!sessionId || !envName || typeof value !== 'string') {
          sendError(res, 400, 'Missing required fields: sessionId, envName, value');
          return;
        }
        const { resolveCredential } = await import('./credential-prompts.js');
        const found = resolveCredential(sessionId, envName, value);
        const responseBody = JSON.stringify({ ok: true, found });
        res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(responseBody) });
        res.end(responseBody);
      } catch (err) {
        sendError(res, 400, `Invalid request: ${(err as Error).message}`);
      }
      return;
    }
```

**Step 4: Add route to `server-admin.ts`**

In `server-admin.ts`, add before the `sendError(res, 404, 'Not found')` fallback:

```typescript
  // POST /admin/api/credentials/provide — resolve a pending credential prompt
  if (pathname === '/admin/api/credentials/provide' && method === 'POST') {
    try {
      const body = JSON.parse(await readBody(req));
      const { sessionId, envName, value } = body;
      if (!sessionId || !envName || typeof value !== 'string') {
        sendError(res, 400, 'Missing required fields: sessionId, envName, value');
        return;
      }
      const { resolveCredential } = await import('./credential-prompts.js');
      const found = resolveCredential(sessionId, envName, value);
      sendJSON(res, { ok: true, found });
    } catch (err) {
      sendError(res, 400, `Invalid request: ${(err as Error).message}`);
    }
    return;
  }
```

**Step 5: Run tests**

Run: `npm test -- --run tests/host/`
Expected: ALL PASS

**Step 6: Commit**

```bash
git add src/host/server.ts src/host/server-admin.ts tests/host/credential-provide-endpoint.test.ts
git commit -m "feat: add HTTP endpoints for credential prompt resolution"
```

---

## Task 5: Clean Up Credential Prompts on Session End

**Files:**
- Modify: `src/host/server-completions.ts` (call `cleanupSession` in cleanup block)
- Test: `tests/host/credential-prompts.test.ts` (add cleanup test)

Ensure pending credential prompts are cleaned up when a session ends (timeout, completion, error), just like `web-proxy-approvals.ts` cleanup.

**Step 1: Write the failing test**

Add to `tests/host/credential-prompts.test.ts`:

```typescript
test('cleanupSession resolves all pending with null', async () => {
  const { requestCredential, cleanupSession } = await import('../../src/host/credential-prompts.js');

  const p1 = requestCredential('cleanup-test', 'KEY_A', 30_000);
  const p2 = requestCredential('cleanup-test', 'KEY_B', 30_000);

  // Cleanup should resolve both with null
  cleanupSession('cleanup-test');

  const [r1, r2] = await Promise.all([p1, p2]);
  expect(r1).toBeNull();
  expect(r2).toBeNull();
});
```

**Step 2: Run test to verify it passes** (uses existing implementation)

Run: `npm test -- --run tests/host/credential-prompts.test.ts`
Expected: PASS

**Step 3: Wire cleanup into `server-completions.ts`**

In `server-completions.ts`, find the cleanup block at the end of `processCompletion` (where `webProxyCleanup` is called). Add credential prompt cleanup:

```typescript
    // Clean up credential prompts
    const { cleanupSession: cleanupCredentialPrompts } = await import('./credential-prompts.js');
    cleanupCredentialPrompts(sessionId);
```

**Step 4: Run tests**

Run: `npm test -- --run tests/host/`
Expected: ALL PASS

**Step 5: Commit**

```bash
git add src/host/server-completions.ts tests/host/credential-prompts.test.ts
git commit -m "feat: clean up credential prompts on session end"
```

---

## Task 6: Update Skills Documentation

**Files:**
- Modify: `.claude/skills/ax-security/SKILL.md`
- Modify: `.claude/skills/ax-provider-credentials/SKILL.md`
- Modify: `.claude/skills/ax-provider-web/SKILL.md`

**Step 1: Update ax-security skill**

Document that missing credentials trigger a host-side prompt via event bus, and that the credential never passes through the agent.

**Step 2: Update ax-provider-credentials skill**

Document the credential prompting flow: `credential.required` event → SSE/admin/IPC resolution → `credentials.set()` for persistence.

**Step 3: Update ax-provider-web skill**

Document that the MITM credential injection flow now includes interactive credential prompting for missing credentials.

**Step 4: Commit**

```bash
git add .claude/skills/
git commit -m "docs: document host-side credential prompting flow"
```

---

## Summary

| Task | What | Key Files |
|------|------|-----------|
| 1 | Credential prompt registry | `src/host/credential-prompts.ts` |
| 2 | Emit event + block on missing credentials | `src/host/server-completions.ts` |
| 3 | SSE named event in chat completions | `src/host/server.ts`, `server-http.ts` |
| 4 | HTTP endpoints for resolution | `server.ts`, `server-admin.ts` |
| 5 | Session cleanup | `server-completions.ts` |
| 6 | Documentation | `.claude/skills/` |

**Dependencies:** Task 2 depends on Task 1. Tasks 3-4 depend on Task 1. Task 5 depends on Task 2. Task 6 depends on all others.

**Not in scope (future work):**
- Slack channel handler integration (uses the same `credential.required` event — the Slack handler would listen for it and DM the user)
- Credential rotation / expiry
- Per-skill credential approval gates
- Web chat UI modal implementation (client-side — this plan covers the server-side API)
