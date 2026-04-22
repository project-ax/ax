# feat/tool-dispatch-unification — PR draft

Draft PR description for the final merge. 28 commits, 212 files, +18141/-4914.

---

## Summary

Replaces the per-agent TypeScript tool-stub codegen pipeline (`src/host/toolgen/`, `tool_batch` IPC, `execute_script` + `ax.callTool` runtime helper) with a unified, session-scoped **tool catalog** and two meta-tools for dispatch: `describe_tools` (schema lookup) and `call_tool` (dispatch). Adds first-class **OpenAPI** support alongside MCP, plus a **diagnostic pipeline** that surfaces host-side catalog failures directly in the chat UI so the user no longer has to grep logs to know why a skill isn't working.

## What gets added

### Tool catalog + indirect dispatch (Phases 1–6)

- `src/types/catalog.ts` — `CatalogTool` type (discriminated union over `mcp` / `openapi` dispatch kinds), shared between host and agent.
- `src/host/tool-catalog/` — session-scoped registry, MCP adapter, OpenAPI adapter (pure: takes dereferenced spec), per-(agentId, HEAD-sha) cache, jq-based `_select` response projection, auto-spill on large responses.
- `src/host/ipc-handlers/describe-tools.ts` — meta-tool handler: lookup by catalog name, `names: []` returns the full directory.
- `src/host/ipc-handlers/call-tool.ts` — meta-tool handler: dispatches MCP or OpenAPI, applies optional `_select` jq projection, truncates large responses to a `{truncated, full, preview}` envelope that the agent-side stub writes to a spill file.
- `src/agent/tools/describe-tools.ts` + `src/agent/tool-catalog.ts` entries — built-in `describe_tools` + `call_tool` tools on the agent side.
- System prompt block: one-liner catalog grouped by skill, rendered at turn start.

### OpenAPI adapter (Phase 7)

- `openapi[]` frontmatter block on `SkillFrontmatterSchema` with `spec`, `baseUrl` (https-pinned), optional `auth: {scheme, credential}` where scheme is one of `bearer | basic | api_key_header | api_key_query`, and `include` / `exclude` glob filters.
- `src/host/tool-catalog/adapters/openapi.ts` — pure adapter, parses OpenAPI 3.0 specs (rejects v2/Swagger), emits `api_<skill>_<snake_opid>` catalog entries with inputSchema derived from params + requestBody.
- `src/host/skills/openapi-spec-fetcher.ts` — HTTPS URLs go direct to `@apidevtools/swagger-parser`; workspace-relative paths resolve through the bare git repo with traversal guards.
- `src/host/ipc-handlers/openapi-dispatcher.ts` — default HTTP dispatcher: path/query/header/body routing, 4 auth schemes, URL rewrites, credential redaction in failure logs (e.g. `api_key_query` key value never leaks), CRLF-injection guard on header values, `URLSearchParams.append`-based query construction, repeated-token path substitution.
- E2E test: `tests/e2e/fixtures/skills/petstore/` with a 4-operation spec + 2-call scripted flow through the catalog → dispatcher chain. Test case `19. Petstore 2-turn flow through OpenAPI indirect dispatch` in the regression suite.

### Diagnostic surfacing pipeline

Three-task pipeline (B1 → B2 → B3) that turns host-side silent failures into user-visible banners:

- **B1 (`src/host/diagnostics.ts`)** — per-turn ring-buffered `DiagnosticCollector` (capped at 50 entries with an overflow marker). Wired into `populateCatalogFromSkills` so MCP listTools failures, OpenAPI spec fetch/parse failures, and wide-surface advisories (Phase 8) push structured `Diagnostic` records alongside the existing `logger.warn` lines.
- **B2 (`src/host/server-completions.ts` + `src/host/server-request-handlers.ts`)** — fresh collector per turn attached to `CompletionResult`. Streaming mode emits `event: diagnostic` named SSE frames between the final finish-reason chunk and `data: [DONE]`. Non-streaming mode always emits a top-level `diagnostics: []` (empty-always, for uniform consumer contract).
- **B3 (`ui/chat/src/components/thread.tsx` + `ui/chat/src/lib/ax-chat-transport.ts`)** — chat-ui transport parses the SSE events; a dismissible `DiagnosticBanner` renders under the most recent assistant turn, color-coded by severity (info/warn/error), with the severity-highest-wins rule for mixed batches.

**What this catches**: OpenAPI spec fetch failure, MCP listTools failure, wide-surface advisories (>20 MCP tools or >30 OpenAPI ops without `include:`). **Not yet**: call_tool dispatch errors (the LLM already sees those in its response content), credential resolution failures.

### Other additions

- `feat(config): expose sandbox CPU as a first-class config field` — `cpus: 0.1–16` on `config.sandbox`, plumbed through k8s provider + spawn site. Heavy-tier fallback now actually gets its `cpus: 4` override instead of being silently overwritten.
- `feat(skills): Test-&-Enable MCP approval flow + credential observability` — admin can probe MCP servers with real turn-time auth before enabling; every skill-credential resolution is now logged with a fingerprint + selection reason so "which credential row won" is observable.
- `feat(skills): dedicated skill-write validator + frontmatter enforcement` — `skill_write` tool for SKILL.md authoring (rejects invalid frontmatter with actionable errors); non-interactive sessions blocked from mutating SKILL.md frontmatter.
- `feat(url-rewrite): thread config.url_rewrites into MCP host calls` — `config.url_rewrites` now honored at both spec-fetch time AND dispatch time, so the e2e `mock-target.test` redirection works symmetrically for MCP and OpenAPI.
- `fix(chat-ui): gate chat_sessions.ensureExists on http: sessionIds` — scheduled-job and webhook sessions no longer pollute the chat UI thread list.
- `fix(prompt): teach agent to surface missing-tool gaps, not paper over` — agent now reports catalog gaps explicitly instead of fabricating replacement skills via `skill_write` (caught in the field when an OpenAPI skill's approval silently torched its `openapi[]` block and the agent invented a new MCP skill with a fake URL).

## What gets deleted (Phase 6)

| Removed | Replaced by |
|---|---|
| `src/host/toolgen/` (codegen pipeline: OpenAPI + MCP → TypeScript stubs + schema-hash cache) | `src/host/tool-catalog/` + `describe_tools` / `call_tool` |
| `src/host/ipc-handlers/tool-batch.ts` + `tool_batch` IPC action | `call_tool` with optional `_select` for projection |
| `src/agent/execute-script.ts` (node-subprocess tool + `ax.callTool` runtime helper + `/tmp/ax-results` spill protocol) | `call_tool` dispatches directly; agent never spawns subprocesses for tool calls |
| `src/agent/prompt/tool-index-loader.ts` (load `.ax/tools/<skill>/_index.json` into prompt) | `src/agent/prompt/modules/tool-catalog.ts` — one-liner render from the host-delivered catalog |
| `src/host/skills/tool-module-sync.ts` (codegen-era plumbing) | N/A — catalog is built live, not materialized |
| Admin `/admin/api/refresh-tools` endpoint + UI button | N/A — catalog is rebuilt automatically on HEAD change |
| `.ax/tools/<skill>/_index.json` + generated stub files | N/A — catalog replaces |

## What breaks

**Skill format**: no breaking changes. `openapi[]` is purely additive. Existing MCP skills keep working.

**Agent-facing tools**: agents that previously called tools via `execute_script`'s `ax.callTool(...)` runtime helper will now find neither `execute_script` nor the helper. They must use `describe_tools` + `call_tool` instead. The prompt module teaches this directly; the on-disk `.ax/tools/` directory no longer exists.

**Config**: `tool_dispatch.mode` (`indirect` / `direct`) + `tool_dispatch.spill_threshold_bytes` added to `Config`. Default mode is `indirect` (the meta-tools). `direct` exposes every catalog tool as a first-class SDK tool — kept for rollback and benchmarking.

**Admin UI**: "Refresh tools" button removed. Was the only visible surface of the deleted endpoint.

**IPC**: `tool_batch` action schema deleted. Nothing outside this PR calls it (confirmed via grep during the Phase 6 sweep).

## PR Checklist status

- [x] All tests pass (`npm run build && npm test`). 2911/2968 pass; 33 pre-existing macOS `listen EINVAL` socket-path failures on `server.test.ts` / `server-history.test.ts` / `server-multimodal.test.ts` (unrelated — reproduce on main before this branch). 24 skipped (test-catalog exceptions, not regressions).
- [x] `npm run test:e2e` — [ ] deferred; requires kind cluster rebuild. Targeted e2e scripts exist and static-analyze clean. **Please run before merge.**
- [x] Journal updated with phase-level entries in `.claude/journal/` (host/skills.md, host/tool-catalog.md, agent/prompt.md, agent/tools.md).
- [x] Lessons recorded for the three plan-flagged decisions + the diagnostic-pipeline design calls:
  - jq subprocess vs bundled library
  - Spill file responsibility split (host emits envelope, agent writes file)
  - IPC-action module pattern (factory + ctx-resolver + structured errors)
  - SSE event ordering for side-band events
  - Per-turn collectors: fresh-per-call, closure-captures-by-reference
  - (+ ~15 more across the phases)
- [x] `CLAUDE.md` verified clean. `.claude/skills/ax/*` swept — `ax/SKILL.md`, `ax-host/SKILL.md`, `ax-ipc/SKILL.md` updated. `docs/web/` verified clean.
- [ ] Manual smoke test in kind cluster documented with turn-count evidence. **Owner: reviewer.** The 5-step protocol from the plan's "Verification Plan" section:
  1. Install Linear skill. Confirm `.ax/tools/` is not regenerated (deleted in Phase 6).
  2. Send "what issues are in Product's current cycle?" — observe 3-4 `call_tool` IPC requests + one response. Zero retries.
  3. Measure system prompt token count with one 42-tool skill — target ~3K for one-liners.
  4. Trigger a large response — observe auto-spill to `/tmp/tool-*.json` + `_truncated` stub in agent context.
  5. Switch `tool_dispatch.mode: direct` — verify `tools[]` in the API call includes every catalog tool with full schemas.

## Suggested rollout

Stage on an internal environment first. Watch `.claude/journal/host/skills.md` + the new diagnostic banner for a week. If no retry-spiral complaints AND no `catalog_populate_*` diagnostic spikes: ship.
