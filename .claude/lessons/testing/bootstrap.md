# Testing Bootstrap

### Bootstrap lifecycle must be tested end-to-end including server restarts
**Date:** 2026-02-22
**Context:** Two bootstrap bugs went undetected: `.bootstrap-admin-claimed` never deleted, and BOOTSTRAP.md recreated on restart. Tests only covered individual helper functions and single-server-lifecycle scenarios.
**Lesson:** Any time server startup has initialization logic that depends on persisted state (like "copy file if not exists"), there MUST be a test that verifies the behavior across server restarts. Unit tests for helpers are not enough — the interaction between server startup copying and bootstrap completion deletion is where bugs hide.
**Tags:** bootstrap, lifecycle, integration-testing, server-restart

### isAgentBootstrapMode requires BOTH SOUL.md and IDENTITY.md to complete bootstrap
**Date:** 2026-02-22
**Context:** A test assumed writing just SOUL.md would trigger bootstrap completion and delete BOOTSTRAP.md. It was wrong — `isAgentBootstrapMode` returns true until BOTH files exist.
**Lesson:** When writing tests for multi-step completion logic (like bootstrap), always trace through the actual condition. `isAgentBootstrapMode` checks `!existsSync(SOUL.md) || !existsSync(IDENTITY.md)` — both must exist for it to return false. Tests must create both files before asserting completion behavior.
**Tags:** bootstrap, testing, conditions, identity

### Bootstrap creates a taint deadlock — bypass taint for SOUL.md/IDENTITY.md during bootstrap
**Date:** 2026-03-27
**Context:** In k8s, bootstrap never completed. Chat-UI messages are 100% tainted (external content). The identity handler's taint gate queued ALL identity writes, including SOUL.md/IDENTITY.md. Since bootstrap can only complete when both are written, this creates an unrecoverable deadlock.
**Lesson:** Critical initialization writes (SOUL.md, IDENTITY.md during bootstrap) must bypass the taint gate. Check if BOOTSTRAP.md exists in DocumentStore before applying the taint check. Also: the scheduler must skip sessions when the agent is still in bootstrap mode — scheduler sessions use a system userId that fails the admin gate.
**Tags:** bootstrap, taint, deadlock, k8s, scheduler

### OpenAI-compat LLM provider must yield tool calls for any finish_reason
**Date:** 2026-03-27
**Context:** Gemini via OpenRouter returns tool calls with non-standard finish_reason values (not "tool_calls" or "stop"). The openai.ts provider only yielded tool calls for those two values, silently dropping tool calls from other providers.
**Lesson:** When accumulating tool calls from an OpenAI SSE stream, yield them on ANY non-null finish_reason, not just "tool_calls" or "stop". Different providers use different values (Gemini: "STOP", Anthropic: "end_turn"/"tool_use").
**Tags:** openai-compat, tool-calls, finish-reason, gemini, openrouter
