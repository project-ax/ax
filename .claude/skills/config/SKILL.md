---
name: ax-config
description: Use when modifying configuration parsing, path resolution, environment variables, or OAuth token handling in config.ts, paths.ts, or dotenv.ts
---

## Overview

AX configuration has three layers: `ax.yaml` (parsed and Zod-validated by `config.ts`), filesystem paths (centralized in `paths.ts`), and environment variables (loaded from `~/.ax/.env` by `dotenv.ts` with OAuth auto-refresh). All files live under `~/.ax/` by default, overridable with `AX_HOME`.

## Key Files

| File | Responsibility |
|---|---|
| `src/config.ts` | Loads and validates `ax.yaml` via Zod `strictObject` schema |
| `src/paths.ts` | All path resolution functions; session ID validation/composition |
| `src/dotenv.ts` | `.env` loader, OAuth token refresh (pre-flight + reactive) |

## Config Structure (`ax.yaml`)

Validated by `ConfigSchema` (Zod `strictObject` -- rejects unknown keys).

| Field | Type | Default | Notes |
|---|---|---|---|
| `agent` | `pi-agent-core \| pi-coding-agent \| claude-code` | `pi-agent-core` | Agent runner type |
| `profile` | enum from `PROFILE_NAMES` | required | Personality profile |
| `providers` | object | required | Maps each category to a provider name |
| `providers.llm` | string | required | LLM provider (e.g., `anthropic`, `mock`) |
| `providers.channels` | string[] | required | Active channel providers |
| `channel_config` | `Record<string, ChannelAccessConfig>` | optional | Per-channel access policies |
| `max_tokens` | number (256-200000) | 8192 | Max tokens for LLM calls |
| `sandbox` | object | required | `timeout_sec` (1-3600), `memory_mb` (64-8192) |
| `scheduler` | object | required | `active_hours` (start/end HH:MM + tz), `max_token_budget`, `heartbeat_interval_min` |
| `history` | object | `{max_turns:50, thread_context_turns:5}` | Conversation retention settings |

## Paths (`paths.ts`)

| Function | Returns | Notes |
|---|---|---|
| `axHome()` | `~/.ax` or `AX_HOME` | Root for all AX files |
| `configPath()` | `~/.ax/ax.yaml` | Main config file |
| `envPath()` | `~/.ax/.env` | Environment variables file |
| `dataDir()` | `~/.ax/data` | Data subdirectory |
| `dataFile(...segs)` | `~/.ax/data/<segs>` | Resolve file under data dir |
| `workspaceDir(sessionId)` | `~/.ax/data/workspaces/<...>` | Colon IDs become nested dirs; UUIDs stay flat |
| `agentDir(name)` | `~/.ax/agents/<name>` | Agent identity files (SOUL.md, IDENTITY.md, etc.) |
| `agentUserDir(name, userId)` | `~/.ax/agents/<name>/users/<userId>` | Per-user state within an agent |
| `composeSessionId(...parts)` | `part1:part2:part3` | Joins with `:`, validates segments, requires 3+ parts |
| `parseSessionId(id)` | `string[] \| null` | Splits colon IDs; returns null for UUIDs |
| `isValidSessionId(id)` | boolean | Accepts UUID or 3+ colon-separated segments |

## Dotenv / OAuth (`dotenv.ts`)

- **`loadDotEnv()`**: Reads `~/.ax/.env`, sets `process.env` (skips already-set keys), then calls `_refreshIfNeeded()`
- **`ensureOAuthTokenFresh()`**: Pre-flight check. Returns immediately if token has >5 min remaining. Called by server before each agent spawn.
- **`refreshOAuthTokenFromEnv()`**: Force-refresh. Used by proxy on reactive 401 retry. Updates both `process.env` and `.env` file.
- **OAuth env vars**: `CLAUDE_CODE_OAUTH_TOKEN`, `AX_OAUTH_REFRESH_TOKEN`, `AX_OAUTH_EXPIRES_AT`
- **`updateEnvFile()`**: Preserves comments and ordering; replaces matching keys in-place, appends new keys

## Common Tasks

**Adding a new config field:**
1. Add field to `ConfigSchema` in `config.ts` (use `.optional().default()` for backward compat)
2. Add corresponding field to the `Config` TypeScript type in `src/types.ts`
3. Both must stay in sync -- `strictObject` rejects keys not in the Zod schema

**Adding a new path helper:**
1. Add function to `paths.ts`
2. Use `axHome()` or `dataDir()` as base -- never hardcode `~/.ax`
3. Validate user-supplied segments with `validatePathSegment()` to prevent path traversal

## Gotchas

- **`.env` not auto-loaded by tsx or bun scripts**: Neither `tsx` nor Bun's npm script runner loads `.env`. Call `loadDotEnv()` manually at entry points, or use `bun src/main.ts` directly (Bun auto-loads `.env` for direct `.ts` files only).
- **OAuth refresh has two layers**: (1) Pre-flight via `ensureOAuthTokenFresh()` before agent spawn, (2) Reactive 401 retry via `refreshOAuthTokenFromEnv()` in the proxy. Both update `process.env` and the `.env` file.
- **Zod strictObject rejects unknown keys**: Every field in the TypeScript `Config` type MUST also exist in `ConfigSchema`. Adding a field to only one side causes silent validation failures at runtime.
- **`AX_HOME` overrides all paths**: Set in tests to isolate SQLite databases and prevent lock contention between parallel test files.
- **Session ID segments are filesystem-safe**: Validated by `SEGMENT_RE` (`/^[a-zA-Z0-9_.\-]+$/`). Colons are separators, never part of a segment.
