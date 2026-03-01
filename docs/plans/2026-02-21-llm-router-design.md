# LLM Router — Design Document

**Date:** 2026-02-21
**Status:** Approved (design session)

## Overview

Replace the single-provider LLM loading with an **LLM router** that handles model routing and fallback. The router is active for all IPC-based agents. The `claude-code` agent is excluded — it uses Anthropic directly via the credential-injecting proxy.

## Motivation

AX currently loads one LLM provider at startup. If that provider fails (rate limit, outage, auth issue), the agent gets an error. We want:

1. **Fallback** — Automatically try alternative models/providers when one fails.
2. **Unified routing** — A single component that parses compound `provider/model` IDs and dispatches to the correct child provider.
3. **Simplicity** — One code path, always. No conditional branching between "single" and "multi" modes.

## Config & Data Model

### Config Shape

```yaml
model: openrouter/claude-sonnet-4-20250514
model_fallbacks:
  - openrouter/gpt-4.1
  - groq/llama-3.3-70b
```

- `model` — Required for non-claude-code agents. Always a compound `provider/model` ID. Split on first `/`.
- `model_fallbacks` — Optional. Ordered list of compound IDs to try if the primary fails.
- `providers.llm` — **Removed.** The router is always used (for non-claude-code agents). Child providers are determined from the compound IDs.

### `claude-code` Agent Exception

When `agent: claude-code`, the LLM is Anthropic via the credential-injecting proxy — the host doesn't route LLM calls through IPC at all. In this case:

- `model` and `model_fallbacks` are **not required** (ignored if present).
- `providers.llm` is **not required**.
- The registry skips loading the router entirely.

### Parsing

```
"openrouter/gpt-4.1" → { provider: "openrouter", model: "gpt-4.1" }
"anthropic/claude-sonnet-4-20250514" → { provider: "anthropic", model: "claude-sonnet-4-20250514" }
```

Split on the first `/`. A model string without `/` is an error.

### Internal Type

```typescript
interface ModelCandidate {
  provider: string;
  model: string;
}
```

The router holds:
- `candidates: ModelCandidate[]` — Primary at index 0, then fallbacks in order.
- `providers: Map<string, LLMProvider>` — One child provider instance per unique provider name.

## Fallback Runtime Logic

### Attempt Loop

```
for each candidate in [primary, ...fallbacks]:
  if candidate.provider is cooled down → skip
  try:
    yield* childProvider.chat({ model: candidate.model, ... })
    return  // success
  catch error:
    classify(error) → retryable | permanent
    if permanent → skip to next candidate
    if retryable → mark provider cooldown, skip to next candidate

if all candidates exhausted → throw last error
```

### Error Classification

Two buckets:

- **Retryable**: 429 (rate limit), 5xx (server error), timeout, connection refused. Triggers a cooldown on that provider.
- **Permanent**: 401/403 (auth), 400 (bad request), 404 (model not found). Skips immediately, no cooldown.

### Provider Cooldowns

Lightweight circuit breaker per provider name (not per model):

- First failure: 30s cooldown
- Subsequent failures: exponential backoff, capped at 5 minutes
- Resets on any successful call to that provider

In-memory `Map<string, { until: number; consecutive: number }>`. No persistence — fresh state on process restart.

### Streaming

The router yields chunks as they arrive from the child provider. If a provider fails **mid-stream** (partial response), the error propagates — no retry. Fallback only applies to connection/pre-response failures.

## Router Structure & Lifecycle

**File:** `src/providers/llm/router.ts`

### `create(config: Config)`

1. **Parse candidates** — Reads `config.model` and `config.model_fallbacks`. Splits each on first `/` into `ModelCandidate[]`.
2. **Deduplicate providers** — Collects unique provider names. For each, calls the underlying provider loader to instantiate a child `LLMProvider`. Two `openrouter/*` models share one child instance.
3. **Return `LLMProvider` interface** — Exposes `chat()` that runs the fallback loop.

### Registry

The registry loads the router for all non-claude-code agents:

```typescript
llm: config.agent === 'claude-code'
  ? undefined
  : await loadProvider('llm', 'router', config),
```

`claude-code` skips LLM provider loading entirely — it talks to Anthropic via the proxy, not through the provider interface.

### Provider Map

`src/host/provider-map.ts` entry:

```typescript
router: '../providers/llm/router.js',
```

The existing individual entries (`anthropic`, `openai`, `openrouter`, `groq`) remain — the router uses them to load child providers.

## Credential Handling

Each child provider resolves its own API key from environment variables at `create()` time. If a key is missing, the child provider's existing deferred-credential pattern creates a stub that throws on first call. The router treats that throw as a permanent error and skips to the next candidate.

Missing API keys don't crash startup — they just make that provider unavailable in the fallback chain.

## Logging

Debug-level logging for each attempt:

```
router: trying openrouter/gpt-4.1
router: openrouter/gpt-4.1 failed (429 rate_limit), cooldown 30s
router: trying groq/llama-3.3-70b
router: groq/llama-3.3-70b succeeded
```

Uses existing logging infrastructure.

## Integration Points

### IPC Layer — No Changes

`ipc-server.ts` calls `providers.llm.chat()` and streams chunks. The router is invisible to the IPC boundary and the agent.

### Agent — Model-Unaware

The agent never knows which model or provider is being used. The host owns all routing decisions.

### server.ts Cleanup

The existing model-prefix-stripping logic (lines 522-536) is removed. The router handles all compound ID parsing internally.

## Edge Cases

| Case | Behavior |
|------|----------|
| Single model, no fallbacks | Router creates one child provider. Functionally identical to direct call. |
| Empty `model_fallbacks: []` | Same as absent — one candidate only. |
| Duplicate provider in candidates | One child instance per unique provider name. Shared cooldown state. |
| All candidates exhausted | Throws the last error. Agent sees a single failure. |
| Bare model name (no `/`) | Error at startup — compound ID required. |
| `agent: claude-code` | Router not loaded. `model` and `model_fallbacks` ignored. LLM handled by proxy. |
| Mid-stream failure | Error propagates. No fallback for partial responses. |

## File Change List

### New Files

- `src/providers/llm/router.ts` — The router provider.
- `tests/providers/llm/router.test.ts` — Unit tests.

### Modified Files

- `src/types.ts` — Add `model_fallbacks?: string[]` to Config. Remove `llm` from `providers` (or leave ignored).
- `src/host/registry.ts` — Load `router` for LLM when agent is not `claude-code`; skip LLM loading for `claude-code`.
- `src/host/server.ts` — Remove model-prefix-stripping logic.
- `src/host/provider-map.ts` — Rename `multi` entry to `router`, point to `../providers/llm/router.js`.

### Unchanged

- `src/host/ipc-server.ts` — Calls `providers.llm.chat()` as before.
- `src/providers/llm/anthropic.ts`, `openai.ts` — Child providers, no changes.
- `src/agent/` — Agent remains model-unaware.

### Not In Scope (Deferred)

- Claude-code proxy routing
- Persistent cooldown state
- Provider health metrics / observability
