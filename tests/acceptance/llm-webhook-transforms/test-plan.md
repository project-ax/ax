# Acceptance Tests: LLM Webhook Transforms

**Plan document(s):** `docs/plans/2026-03-02-llm-webhook-transforms.md`
**Date designed:** 2026-03-03
**Total tests:** 21 (ST: 12, BT: 5, IT: 4)

## Summary of Acceptance Criteria

Extracted from the plan document:

1. Config: `webhooks` section in `ax.yaml` with `enabled`, `token` (required), `path`, `max_body_bytes`, `model`, `allowed_agent_ids` (all optional)
2. Config: Missing `token` when `enabled: true` must be rejected by Zod validation
3. Config: No `webhooks` section is valid (feature is optional)
4. Paths: `webhooksDir()` returns `~/.ax/webhooks/`
5. Paths: `webhookTransformPath(name)` returns `~/.ax/webhooks/<name>.md` with safePath sanitization
6. Paths: Path traversal in webhook names is sanitized (no `..` escape)
7. Handler: Bearer token auth via `Authorization` header or `X-AX-Token` header
8. Handler: Token in query string rejected with 400
9. Handler: Timing-safe token comparison (`timingSafeEqual`)
10. Handler: Per-IP fixed-window rate limiting (20 failures per 60s)
11. Handler: JSON body parsing with configurable size limit (default 256KB)
12. Handler: 404 when transform file `~/.ax/webhooks/<name>.md` does not exist
13. Handler: POST-only (405 for other methods)
14. Handler: Returns 202 `{ ok, runId }` on successful dispatch
15. Handler: Returns 204 when LLM transform returns null (skip event)
16. Transform: LLM called with transform file as system prompt, `{ headers, payload }` as user content
17. Transform: Response validated against strict Zod schema (`message` required, optional `agentId`, `sessionKey`, `model`, `timeoutSec`)
18. Transform: Invalid JSON or missing `message` field throws error (500)
19. Taint: Webhook payloads taint-tagged as external content before dispatch
20. Audit: Auth failures, receipts, and dispatches are audit-logged
21. Allowlist: When `allowed_agent_ids` is set, transform must return an agentId in the list; omitting agentId is blocked
22. Server wiring: Webhooks only enabled when `config.webhooks.enabled` is true
23. Server wiring: Configurable path prefix (default `/webhooks/`)
24. Server wiring: Drain handling — webhooks rejected during server shutdown (503)
25. Server wiring: Dispatch calls `processCompletion` with fire-and-forget pattern
26. Server wiring: `userId` is set to `'webhook'` for dispatched runs
27. Dispatch: `runId` format is `webhook-<8-char-uuid>`
28. Filesystem ops: Injected as callbacks (`transformExists`, `readTransform`) for testability
29. Documentation: User-facing docs at `docs/webhooks.md` with config, transform file examples, curl examples, security notes

---

## Structural Tests

### ST-1: Config schema includes webhooks section

**Criterion:** Config: `webhooks` section in `ax.yaml` with all specified fields (Plan, Task 1)
**Plan reference:** `2026-03-02-llm-webhook-transforms.md`, Task 1 Step 3

**Verification steps:**
1. Read `src/config.ts` and check for `webhooks: z.strictObject(...)` in ConfigSchema
2. Verify all fields present: `enabled` (boolean), `token` (string.min(1)), `path` (string, optional), `max_body_bytes` (number.int.positive, optional), `model` (string, optional), `allowed_agent_ids` (array of string.min(1), optional)
3. Verify the whole `webhooks` block is `.optional()`

**Expected outcome:**
- [ ] ConfigSchema contains `webhooks` key with `z.strictObject` containing all 6 fields
- [ ] `enabled` is `z.boolean()` (required)
- [ ] `token` is `z.string().min(1)` (required)
- [ ] `path`, `max_body_bytes`, `model`, `allowed_agent_ids` are all optional
- [ ] `webhooks` itself is `.optional()` on the top-level schema

**Pass/Fail:** _pending_

---

### ST-2: Config type interface includes webhooks

**Criterion:** The `Config` TypeScript interface must include the `webhooks` optional property (Plan, Task 1)
**Plan reference:** `2026-03-02-llm-webhook-transforms.md`, Task 1 Step 3

**Verification steps:**
1. Read `src/types.ts` and check Config interface for `webhooks?` property
2. Verify property types match: `enabled: boolean`, `token: string`, `path?: string`, `max_body_bytes?: number`, `model?: string`, `allowed_agent_ids?: string[]`

**Expected outcome:**
- [ ] `Config` interface has `webhooks?` with all 6 typed fields
- [ ] Types match the Zod schema exactly

**Pass/Fail:** _pending_

---

### ST-3: Path helpers exported and use safePath

**Criterion:** `webhooksDir()` and `webhookTransformPath(name)` must be exported, and `webhookTransformPath` must use `safePath()` for path traversal protection (Plan, Task 2)
**Plan reference:** `2026-03-02-llm-webhook-transforms.md`, Task 2 Step 3

**Verification steps:**
1. Read `src/paths.ts` and check for `export function webhooksDir()` and `export function webhookTransformPath(name)`
2. Verify `webhooksDir()` returns `join(axHome(), 'webhooks')`
3. Verify `webhookTransformPath(name)` calls `safePath(webhooksDir(), ...)` — NOT `join()` directly

**Expected outcome:**
- [ ] Both functions are exported
- [ ] `webhooksDir()` uses `join(axHome(), 'webhooks')`
- [ ] `webhookTransformPath(name)` delegates to `safePath()` (SC-SEC-004 compliance)

**Pass/Fail:** _pending_

---

### ST-4: Webhook handler uses timing-safe token comparison

**Criterion:** Token comparison must use `timingSafeEqual` to prevent timing attacks (Plan, Task 3)
**Plan reference:** `2026-03-02-llm-webhook-transforms.md`, Task 3 Step 3

**Verification steps:**
1. Read `src/host/server-webhooks.ts` and check for `timingSafeEqual` import from `node:crypto`
2. Verify the `safeEqual` function uses `timingSafeEqual(Buffer.from(a), Buffer.from(b))`
3. Verify the auth check calls `safeEqual` (not `===` or `==`)

**Expected outcome:**
- [ ] `timingSafeEqual` is imported from `node:crypto`
- [ ] Token comparison goes through `safeEqual()` which wraps `timingSafeEqual`
- [ ] No direct `===` comparison on raw token strings

**Pass/Fail:** _pending_

---

### ST-5: Rate limiter implements fixed-window with correct constants

**Criterion:** Per-IP fixed-window rate limiting: 20 failures per 60s window (Plan, Task 3)
**Plan reference:** `2026-03-02-llm-webhook-transforms.md`, Task 3 Step 3

**Verification steps:**
1. Read `src/host/server-webhooks.ts` and check rate limiter constants
2. Verify `RATE_LIMIT_WINDOW_MS = 60_000` and `RATE_LIMIT_MAX_FAILURES = 20`
3. Verify `isRateLimited(ip)` checks count against max, with window expiry
4. Verify `recordAuthFailure(ip)` increments count within window or resets on new window
5. Verify `resetRateLimit(ip)` clears the entry on successful auth

**Expected outcome:**
- [ ] Window is 60 seconds, max failures is 20
- [ ] Rate limit resets on successful auth (via `resetRateLimit`)
- [ ] Window expiry logic is correct (old window entries are effectively ignored)

**Pass/Fail:** _pending_

---

### ST-6: Webhook handler supports both Authorization and X-AX-Token headers

**Criterion:** Auth: Bearer token via `Authorization` header or `X-AX-Token` header (Plan, Task 3)
**Plan reference:** `2026-03-02-llm-webhook-transforms.md`, Task 3 Step 3

**Verification steps:**
1. Read `src/host/server-webhooks.ts` and check `extractToken()` function
2. Verify it first checks `Authorization: Bearer <token>` header
3. Verify it falls back to `X-AX-Token` header
4. Verify it returns `undefined` if neither is present

**Expected outcome:**
- [ ] `extractToken` checks `req.headers.authorization` for `Bearer ` prefix
- [ ] Falls back to `req.headers['x-ax-token']`
- [ ] Returns `undefined` when no token found

**Pass/Fail:** _pending_

---

### ST-7: Transform validates output against strict Zod schema

**Criterion:** LLM response validated against strict Zod schema with `message` required (Plan, Task 4)
**Plan reference:** `2026-03-02-llm-webhook-transforms.md`, Task 4 Step 3

**Verification steps:**
1. Read `src/host/webhook-transform.ts` and check `TransformResultSchema`
2. Verify it uses `z.strictObject()` (not `z.object()`) — rejects unknown keys
3. Verify fields: `message: z.string().min(1)` (required), `agentId`, `sessionKey`, `model` (optional strings), `timeoutSec` (optional positive int)
4. Verify invalid JSON throws an Error mentioning "invalid JSON"
5. Verify missing `message` field throws an Error

**Expected outcome:**
- [ ] Schema is `z.strictObject()` (strict mode, no extra keys)
- [ ] `message` is required, non-empty string
- [ ] `agentId`, `sessionKey`, `model` are optional strings
- [ ] `timeoutSec` is optional positive integer
- [ ] Error messages are descriptive (include field names)

**Pass/Fail:** _pending_

---

### ST-8: Server wiring — webhookHandler created only when enabled

**Criterion:** Webhooks only enabled when `config.webhooks.enabled` is true (Plan, Task 5)
**Plan reference:** `2026-03-02-llm-webhook-transforms.md`, Task 5 Step 3

**Verification steps:**
1. Read `src/host/server.ts` and find webhook handler creation
2. Verify conditional: `config.webhooks?.enabled ? createWebhookHandler(...) : null`
3. Verify route matching checks `webhookHandler` is truthy before processing
4. Verify imports: `createWebhookHandler` from `./server-webhooks.js` and `createWebhookTransform` from `./webhook-transform.js`

**Expected outcome:**
- [ ] `webhookHandler` is conditionally created based on `config.webhooks?.enabled`
- [ ] Null when disabled — route simply doesn't match
- [ ] Both `createWebhookHandler` and `createWebhookTransform` are imported

**Pass/Fail:** _pending_

---

### ST-9: Server wiring — configurable path prefix

**Criterion:** Configurable path prefix, defaulting to `/webhooks/` (Plan, Task 5)
**Plan reference:** `2026-03-02-llm-webhook-transforms.md`, Task 5 Step 3

**Verification steps:**
1. Read `src/host/server.ts` and find `webhookPrefix` computation
2. Verify it reads `config.webhooks?.path` and appends `/` if missing
3. Verify default is `/webhooks/`
4. Verify the route matching uses `url.startsWith(webhookPrefix)`

**Expected outcome:**
- [ ] `webhookPrefix` defaults to `/webhooks/`
- [ ] Custom path from config is used with trailing slash normalization
- [ ] Route matching uses `startsWith(webhookPrefix)` for correct prefix matching

**Pass/Fail:** _pending_

---

### ST-10: Server wiring — drain handling rejects webhooks

**Criterion:** Webhook requests rejected during server shutdown with 503 (Plan, Task 5)
**Plan reference:** `2026-03-02-llm-webhook-transforms.md`, Task 5 Step 3

**Verification steps:**
1. Read `src/host/server.ts` and find drain check near the top of `handleRequest`
2. Verify that when `draining` is true and URL starts with `webhookPrefix`, a 503 is returned
3. Verify the drain check is BEFORE the webhook route handler

**Expected outcome:**
- [ ] Drain check covers both `/v1/chat/completions` AND webhook prefix
- [ ] Returns 503 with appropriate error message
- [ ] Check happens before request tracking and handler invocation

**Pass/Fail:** _pending_

---

### ST-11: Server wiring — dispatch calls processCompletion correctly

**Criterion:** Dispatch uses fire-and-forget `processCompletion` with `'webhook'` userId (Plan, Task 5)
**Plan reference:** `2026-03-02-llm-webhook-transforms.md`, Task 5 Step 3

**Verification steps:**
1. Read `src/host/server.ts` webhook dispatch callback
2. Verify `void processCompletion(...)` pattern (fire-and-forget with `.catch()`)
3. Verify `userId` parameter is `'webhook'`
4. Verify `result.message` is passed as content
5. Verify `result.agentId`, `result.model`, `result.timeoutSec` are used to build `childConfig`
6. Verify `runId` is passed as `requestId`

**Expected outcome:**
- [ ] `processCompletion` called with `void` + `.catch()` for fire-and-forget
- [ ] userId is `'webhook'`
- [ ] Agent config overrides (agentId, model, timeout) are plumbed through
- [ ] Error handler logs `webhook_dispatch_failed`

**Pass/Fail:** _pending_

---

### ST-12: Documentation exists with required sections

**Criterion:** User-facing docs with config, transform examples, curl examples, security notes (Plan, Task 8)
**Plan reference:** `2026-03-02-llm-webhook-transforms.md`, Task 8

**Verification steps:**
1. Check `docs/webhooks.md` exists
2. Verify it contains: configuration section with `ax.yaml` example
3. Verify it contains: at least 2 transform file examples (GitHub, Stripe or generic)
4. Verify it contains: curl testing examples
5. Verify it contains: security considerations section
6. Verify voice matches CLAUDE.md guidelines (warm, self-deprecating, not gatekeeping)

**Expected outcome:**
- [ ] `docs/webhooks.md` exists and is non-empty
- [ ] Has config section with YAML examples showing all options
- [ ] Has at least 2 transform file examples
- [ ] Has curl examples for testing
- [ ] Has security considerations section covering: bearer tokens, rate limiting, timing-safe comparison, taint-tagging, audit logging, path traversal, HMAC not yet
- [ ] Tone matches project voice guidelines

**Pass/Fail:** _pending_

---

## Behavioral Tests

### BT-1: GitHub push webhook — LLM transforms payload and dispatches agent run

**Criterion:** POST to `/webhooks/<name>` with valid auth loads transform file, calls LLM, returns 202 with runId, and triggers async agent run (Plan, Data Flow diagram)
**Plan reference:** `2026-03-02-llm-webhook-transforms.md`, Data Flow + Tasks 3-5

**Setup:**
- AX server running with `webhooks.enabled: true` and `webhooks.token` set
- Create `$TEST_HOME/webhooks/github.md` with the GitHub transform example from docs
- Session: `acceptance:webhooks:bt1`

**Chat script:**
1. Send via curl:
   ```bash
   curl -s -X POST --unix-socket "$TEST_HOME/ax.sock" \
     -H "Authorization: Bearer $WEBHOOK_TOKEN" \
     -H "Content-Type: application/json" \
     -H "X-GitHub-Event: push" \
     http://localhost/webhooks/github \
     -d '{"ref":"refs/heads/main","pusher":{"name":"alice"},"commits":[{"message":"fix: login bug"}],"head_commit":{"message":"fix: login bug"}}'
   ```
   Expected behavior: Returns 202 with `{ "ok": true, "runId": "webhook-..." }`
   Structural check: Response body has `ok: true` and `runId` matching `webhook-[a-f0-9]{8}`

2. Check audit log:
   ```bash
   sqlite3 "$TEST_HOME/data/audit.db" "SELECT action FROM audit_log WHERE action LIKE 'webhook.%' ORDER BY rowid DESC LIMIT 5"
   ```
   Expected: Contains `webhook.received` and `webhook.dispatched`

**Expected outcome:**
- [ ] HTTP response is 202 with valid JSON `{ ok, runId }`
- [ ] `runId` matches `webhook-[a-f0-9]{8}` pattern
- [ ] Audit log contains `webhook.received` and `webhook.dispatched` entries
- [ ] No 500 errors in server logs

**Pass/Fail:** _pending_

---

### BT-2: LLM returns null for ignored event — 204 no content

**Criterion:** null from LLM means "skip this event", returning 204 (Plan, Data Flow: null -> 204 skip)
**Plan reference:** `2026-03-02-llm-webhook-transforms.md`, Data Flow diagram + Task 3

**Setup:**
- Same as BT-1 (server running, github.md transform file present)
- The GitHub transform example says "everything else: return null"

**Chat script:**
1. Send via curl with a `watch` event (should be ignored per transform file):
   ```bash
   curl -s -o /dev/null -w "%{http_code}" -X POST --unix-socket "$TEST_HOME/ax.sock" \
     -H "Authorization: Bearer $WEBHOOK_TOKEN" \
     -H "Content-Type: application/json" \
     -H "X-GitHub-Event: watch" \
     http://localhost/webhooks/github \
     -d '{"action":"starred","repository":{"name":"test"}}'
   ```
   Expected behavior: Returns 204 (no content)

**Expected outcome:**
- [ ] HTTP status code is 204
- [ ] Response body is empty
- [ ] No `webhook.dispatched` audit entry for this request (only `webhook.received`)
- [ ] No errors in server logs

**Pass/Fail:** _pending_

---

### BT-3: Auth rejection — 401 with wrong token

**Criterion:** Bearer token auth rejects invalid tokens with 401 (Plan, Task 3)
**Plan reference:** `2026-03-02-llm-webhook-transforms.md`, Task 3

**Setup:**
- Server running with webhooks enabled

**Chat script:**
1. Send with wrong token:
   ```bash
   curl -s -o /dev/null -w "%{http_code}" -X POST --unix-socket "$TEST_HOME/ax.sock" \
     -H "Authorization: Bearer wrong-token" \
     -H "Content-Type: application/json" \
     http://localhost/webhooks/github \
     -d '{"event":"push"}'
   ```
   Expected behavior: Returns 401

2. Send with no auth header:
   ```bash
   curl -s -o /dev/null -w "%{http_code}" -X POST --unix-socket "$TEST_HOME/ax.sock" \
     -H "Content-Type: application/json" \
     http://localhost/webhooks/github \
     -d '{"event":"push"}'
   ```
   Expected behavior: Returns 401

3. Check audit for auth failure:
   ```bash
   sqlite3 "$TEST_HOME/data/audit.db" "SELECT action FROM audit_log WHERE action = 'webhook.auth_failed' ORDER BY rowid DESC LIMIT 1"
   ```
   Expected: Contains `webhook.auth_failed`

**Expected outcome:**
- [ ] Wrong token returns 401
- [ ] Missing token returns 401
- [ ] Audit log records `webhook.auth_failed`

**Pass/Fail:** _pending_

---

### BT-4: Missing transform file returns 404

**Criterion:** Returns 404 when transform file `~/.ax/webhooks/<name>.md` does not exist (Plan, Task 3)
**Plan reference:** `2026-03-02-llm-webhook-transforms.md`, Task 3

**Setup:**
- Server running with webhooks enabled
- No `nonexistent.md` file in `$TEST_HOME/webhooks/`

**Chat script:**
1. Send to a webhook name with no transform file:
   ```bash
   curl -s -o /dev/null -w "%{http_code}" -X POST --unix-socket "$TEST_HOME/ax.sock" \
     -H "Authorization: Bearer $WEBHOOK_TOKEN" \
     -H "Content-Type: application/json" \
     http://localhost/webhooks/nonexistent \
     -d '{"event":"test"}'
   ```
   Expected behavior: Returns 404

**Expected outcome:**
- [ ] HTTP status code is 404
- [ ] Response body mentions "No webhook transform found"

**Pass/Fail:** _pending_

---

### BT-5: X-AX-Token header accepted as alternative auth

**Criterion:** Auth supports both `Authorization: Bearer` and `X-AX-Token` headers (Plan, Task 3)
**Plan reference:** `2026-03-02-llm-webhook-transforms.md`, Task 3 Step 3

**Setup:**
- Server running with webhooks enabled and a transform file present

**Chat script:**
1. Send with `X-AX-Token` header instead of Authorization:
   ```bash
   curl -s -o /dev/null -w "%{http_code}" -X POST --unix-socket "$TEST_HOME/ax.sock" \
     -H "X-AX-Token: $WEBHOOK_TOKEN" \
     -H "Content-Type: application/json" \
     -H "X-GitHub-Event: push" \
     http://localhost/webhooks/github \
     -d '{"ref":"refs/heads/main","pusher":{"name":"bob"},"commits":[],"head_commit":{"message":"test"}}'
   ```
   Expected behavior: NOT 401 (should proceed to transform and return 202 or 204)

**Expected outcome:**
- [ ] HTTP status is NOT 401 (auth accepted)
- [ ] Response is either 202 (dispatched) or 204 (LLM skipped) — NOT an auth error

**Pass/Fail:** _pending_

---

## Integration Tests

### IT-1: Full webhook pipeline — payload to agent run via processCompletion

**Criterion:** Full data flow: POST webhook -> auth -> LLM transform -> taint-tag -> processCompletion dispatch -> 202 (Plan, Data Flow)
**Plan reference:** `2026-03-02-llm-webhook-transforms.md`, Data Flow diagram

**Setup:**
- AX server running with webhooks enabled
- Create `$TEST_HOME/webhooks/ci.md` with:
  ```markdown
  # CI Webhook Transform

  You receive CI pipeline notifications.

  For any payload:
  - message: Summarize: pipeline name, status, branch, and commit.
  - agentId: "main"
  ```
- Session ID: `acceptance:webhooks:it1`

**Sequence:**
1. Send webhook:
   ```bash
   curl -s -X POST --unix-socket "$TEST_HOME/ax.sock" \
     -H "Authorization: Bearer $WEBHOOK_TOKEN" \
     -H "Content-Type: application/json" \
     http://localhost/webhooks/ci \
     -d '{"pipeline":"build","status":"failed","branch":"main","commit":"abc123"}'
   ```
   Verify: 202 response with `runId`

2. Wait 2-3 seconds for async dispatch, then check audit log:
   ```bash
   sqlite3 "$TEST_HOME/data/audit.db" \
     "SELECT action, args FROM audit_log WHERE action LIKE 'webhook.%' ORDER BY rowid DESC LIMIT 5"
   ```
   Verify: Contains `webhook.received` and `webhook.dispatched` with `ci` in args

3. Check server log for the processCompletion invocation:
   ```bash
   grep -c "webhook_dispatch_failed" "$TEST_HOME/data/ax.log" || echo "0"
   ```
   Verify: No `webhook_dispatch_failed` errors (or count is 0)

**Expected final state:**
- [ ] 202 returned with valid runId
- [ ] Audit log has both `webhook.received` and `webhook.dispatched` for the CI webhook
- [ ] No dispatch failure errors in server logs
- [ ] The LLM was called (implied by successful 202 — if LLM fails, we'd get 500)

**Pass/Fail:** _pending_

---

### IT-2: Allowlist enforcement end-to-end

**Criterion:** When `allowed_agent_ids` is configured, only listed agentIds are accepted (Plan, Task 6 allowlist check)
**Plan reference:** `2026-03-02-llm-webhook-transforms.md`, Task 3 (allowlist section)

**Setup:**
- AX server running with `webhooks.allowed_agent_ids: ["main"]`
- Create `$TEST_HOME/webhooks/restricted.md` with:
  ```markdown
  # Restricted Webhook

  Always return:
  - message: "Test message"
  - agentId: "unauthorized-agent"
  ```
- Create `$TEST_HOME/webhooks/allowed.md` with:
  ```markdown
  # Allowed Webhook

  Always return:
  - message: "Test message"
  - agentId: "main"
  ```
- Session ID: `acceptance:webhooks:it2`

**Sequence:**
1. Send to `restricted` webhook (LLM should return agentId not in allowlist):
   ```bash
   curl -s -w "\n%{http_code}" -X POST --unix-socket "$TEST_HOME/ax.sock" \
     -H "Authorization: Bearer $WEBHOOK_TOKEN" \
     -H "Content-Type: application/json" \
     http://localhost/webhooks/restricted \
     -d '{"test":true}'
   ```
   Verify: 400 response with "not in allowed list" message

2. Send to `allowed` webhook (LLM should return agentId in allowlist):
   ```bash
   curl -s -w "\n%{http_code}" -X POST --unix-socket "$TEST_HOME/ax.sock" \
     -H "Authorization: Bearer $WEBHOOK_TOKEN" \
     -H "Content-Type: application/json" \
     http://localhost/webhooks/allowed \
     -d '{"test":true}'
   ```
   Verify: 202 response (dispatch succeeded)

**Expected final state:**
- [ ] `restricted` webhook returns 400 (blocked by allowlist)
- [ ] `allowed` webhook returns 202 (allowed through)
- [ ] Allowlist applies to the LLM's returned agentId, not a request-level field

**Pass/Fail:** _pending_

---

### IT-3: Rate limiting locks out after repeated auth failures

**Criterion:** 20 failed auth attempts from same IP in 60s triggers 429 lockout (Plan, Task 3)
**Plan reference:** `2026-03-02-llm-webhook-transforms.md`, Task 3

**Setup:**
- AX server running with webhooks enabled
- Session ID: `acceptance:webhooks:it3`

**Sequence:**
1. Send 20 requests with wrong token:
   ```bash
   for i in $(seq 1 20); do
     curl -s -o /dev/null -w "%{http_code}\n" -X POST --unix-socket "$TEST_HOME/ax.sock" \
       -H "Authorization: Bearer wrong-token" \
       -H "Content-Type: application/json" \
       http://localhost/webhooks/github \
       -d '{"test":true}'
   done
   ```
   Verify: All return 401

2. Send 21st request with wrong token:
   ```bash
   curl -s -o /dev/null -w "%{http_code}" -X POST --unix-socket "$TEST_HOME/ax.sock" \
     -H "Authorization: Bearer wrong-token" \
     -H "Content-Type: application/json" \
     http://localhost/webhooks/github \
     -d '{"test":true}'
   ```
   Verify: Returns 429 (rate limited)

3. Verify a valid request from same IP is also blocked:
   ```bash
   curl -s -o /dev/null -w "%{http_code}" -X POST --unix-socket "$TEST_HOME/ax.sock" \
     -H "Authorization: Bearer $WEBHOOK_TOKEN" \
     -H "Content-Type: application/json" \
     http://localhost/webhooks/github \
     -d '{"test":true}'
   ```
   Verify: Returns 429 (rate limit check happens before auth)

**Expected final state:**
- [ ] First 20 requests return 401
- [ ] 21st request returns 429
- [ ] Valid-token request from rate-limited IP also returns 429
- [ ] `Retry-After: 60` header present in 429 response

**Pass/Fail:** _pending_

---

### IT-4: Taint tagging verified via taint budget state

**Criterion:** All webhook payloads are taint-tagged as external content (Plan, Task 6)
**Plan reference:** `2026-03-02-llm-webhook-transforms.md`, Task 6

**Setup:**
- AX server running with webhooks enabled and transform file present
- Session ID: `acceptance:webhooks:it4`

**Sequence:**
1. Send a successful webhook:
   ```bash
   RESPONSE=$(curl -s -X POST --unix-socket "$TEST_HOME/ax.sock" \
     -H "Authorization: Bearer $WEBHOOK_TOKEN" \
     -H "Content-Type: application/json" \
     -H "X-GitHub-Event: push" \
     http://localhost/webhooks/github \
     -d '{"ref":"refs/heads/main","pusher":{"name":"alice"},"commits":[{"message":"test"}],"head_commit":{"message":"test"}}')
   RUN_ID=$(echo "$RESPONSE" | jq -r '.runId')
   ```
   Verify: 202 returned with runId

2. Check audit log for taint evidence — the dispatch callback records taint before calling processCompletion:
   ```bash
   sqlite3 "$TEST_HOME/data/audit.db" \
     "SELECT action, args FROM audit_log WHERE action = 'webhook.dispatched' AND args LIKE '%github%' ORDER BY rowid DESC LIMIT 1"
   ```
   Verify: Dispatch entry exists (taint recording is internal; we verify it structurally below)

3. Structural verification — check that `recordTaint` is wired in server.ts:
   ```
   Read src/host/server.ts and verify recordTaint callback is passed to createWebhookHandler
   and calls taintBudget.recordContent(sessionId, content, true)
   ```
   Verify: `isTainted` is always `true` for webhook payloads

**Expected final state:**
- [ ] Webhook dispatched successfully (202)
- [ ] Server.ts wires `recordTaint` callback to `taintBudget.recordContent`
- [ ] The `isTainted` parameter is hardcoded to `true` (all webhook content is external)
- [ ] Session ID for taint follows `webhook:<runId>` pattern (or custom `sessionKey`)

**Pass/Fail:** _pending_

---

## Notes for Execution

### Config Requirements

The acceptance test `ax.yaml` fixture needs a `webhooks` section:
```yaml
webhooks:
  enabled: true
  token: "acceptance-test-webhook-token-32chars!"
```

For IT-2 (allowlist test), a separate config or runtime modification is needed to set `allowed_agent_ids: ["main"]`.

### Transform Files

Create these in `$TEST_HOME/webhooks/` before behavioral/integration tests:
- `github.md` — Copy from `docs/webhooks.md` GitHub example
- `ci.md` — Simple transform for IT-1
- `restricted.md` — Returns unauthorized agentId for IT-2
- `allowed.md` — Returns allowed agentId for IT-2

### Rate Limit Caveat

IT-3 (rate limiting) uses a module-level `Map`, so the rate limit state persists across all webhook requests within the same server process. Running IT-3 early or in isolation is recommended to avoid contaminating other tests. Also note that the rate limit is per-IP and the test uses a Unix socket — `req.socket.remoteAddress` may be `undefined` or a Unix socket path, so the rate limiter may treat all requests as the same "IP". Verify this behavior during execution.

### LLM Dependency

BT-1, BT-2, IT-1, and IT-2 all require a real LLM call for the transform step. The transform uses the fast model (Haiku by default). If LLM calls are too expensive or flaky for acceptance testing, consider whether a mock LLM provider can be configured in the test fixture.
