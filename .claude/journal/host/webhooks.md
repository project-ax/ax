# Webhooks — Journal

## [2026-03-03 01:30] — Implement LLM-powered webhook transforms

**Task:** Implement inbound webhook support where HTTP payloads are transformed into agent-compatible messages by an LLM using markdown transform files.
**What I did:** Implemented all 8 tasks from the plan:
1. Added `webhooks` section to ConfigSchema and Config type
2. Added `webhooksDir()` and `webhookTransformPath()` path helpers with safePath
3. Created `server-webhooks.ts` with handler: bearer token auth, per-IP rate limiting, body parsing, transform file lookup, taint-tagging, audit logging
4. Created `webhook-transform.ts` with LLM transform: sends transform file as system prompt + payload as user content, parses structured JSON response with Zod validation
5. Wired webhook handler into `server.ts`: composition root creates handler when config.webhooks.enabled, route added to handleRequest, drain check included
6. Taint-tagging integrated into handler (recordTaint callback)
7. Audit logging integrated into handler (audit callback)
8. Wrote user-facing docs at `docs/webhooks.md` with examples for GitHub, Stripe, and generic alerts
**Files touched:**
- Modified: `src/config.ts`, `src/types.ts`, `src/paths.ts`, `src/host/server.ts`
- Created: `src/host/server-webhooks.ts`, `src/host/webhook-transform.ts`, `docs/webhooks.md`
- Created: `tests/host/server-webhooks.test.ts` (13 tests), `tests/host/webhook-transform.test.ts` (6 tests)
- Modified: `tests/config.test.ts` (4 new tests), `tests/paths.test.ts` (3 new tests)
**Outcome:** Success — 26 new tests all passing. Full suite passes (2 pre-existing failures in provider-map.test.ts and phase2.test.ts are unrelated).
**Notes:** Injected `transformExists` and `readTransform` as deps rather than using `existsSync`/`readFileSync` directly in the handler — makes testing much cleaner without needing temp files. The `null ?? default` gotcha with optional transform results caught me in tests (null is nullish, so `??` replaces it).
