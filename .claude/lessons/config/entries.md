# Config

### Adding a new field to an already-spread config object may be dead on arrival
**Date:** 2026-04-21
**Context:** While adding `config.sandbox.cpus`, discovered `server-init.ts` heavy-tier branch had been spreading `cpus: 4` into the child config for months — but the spawn site in `server-completions.ts` hardcoded `cpus: 1` in the `SandboxConfig`, so the heavy-tier CPU value was silently overwritten. The field existed in `SandboxConfig` and docker/apple providers already read `config.cpus`, but the plumbing from `Config.sandbox` → `SandboxConfig` was broken.
**Lesson:** When exposing a new config field, trace the full path: Zod schema → TS `Config` type → the spawn/construction site that builds the provider-facing `SandboxConfig` (or equivalent) → the provider's usage site. Spreading a value into `Config.sandbox` is not enough — the spawn site must explicitly forward `config.sandbox.X` into the provider config. Hardcoded defaults at spawn sites are silent killers for "configurable" fields.
**Tags:** config, plumbing, sandbox, dead-code, zod, blast-radius

### Renaming a Config field has massive blast radius — check YAML fixtures too
**Date:** 2026-02-26
**Context:** Renamed `config.model` + `config.model_fallbacks` to `config.models` array. First test run after updating source had 8 test file failures because 6 YAML test fixtures and 2 inline test configs still used the old `model:` field. Zod strict mode rejected the unrecognized key.
**Lesson:** When renaming a Config field: (1) grep all `.yaml` files under tests/ for the old field name, (2) grep all `.test.ts` files for inline config objects using the old name, (3) remember that Zod `.strict()` mode means any unrecognized key causes a hard failure — there's no graceful fallback. The YAML fixtures are especially easy to miss because they're data files, not code.
**Tags:** config, testing, yaml, zod, strict-mode, rename-blast-radius

### AgentConfig.model is NOT the same as Config.model — check the type before renaming
**Date:** 2026-02-26
**Context:** When renaming `Config.model` to `Config.models`, initially thought ALL `config.model` references needed updating. But `AgentConfig` in runner.ts has its own `model` field (agent-side model from CLI args) that is a completely different type.
**Lesson:** Before bulk-renaming a field across the codebase, verify which TYPE each `config.model` reference belongs to. `Config` (from ax.yaml, host-side) and `AgentConfig` (from CLI args, agent-side) are different types with different `model` fields. Use TypeScript's type system or grep for the import to disambiguate.
**Tags:** config, types, rename, agent-config, disambiguation

### Pre-existing tsc errors are expected — project uses tsx runtime
**Date:** 2026-02-22
**Context:** `npm run build` (tsc) shows 400+ errors from missing @types/node
**Lesson:** The AX project runs via tsx, not compiled tsc output. The 400+ tsc errors from missing @types/node are pre-existing and expected. Don't try to fix them — focus on vitest test results instead.
**Tags:** build, typescript, tsx, tsc

### Credential provider must be authoritative over .env for managed tokens
**Date:** 2026-03-02
**Context:** OAuth refresh tokens stored in `credentials.yaml` were ignored because `loadDotEnv()` loaded stale values from `.env` first, and `loadCredentials()` skipped keys already in `process.env`.
**Lesson:** When multiple credential sources exist (shell env, `.env` file, credential provider), the credential provider must be the authoritative source. Don't skip `provider.get()` just because `process.env` already has a value — the provider's store may have a fresher value. The provider itself falls back to `process.env` for keys not in its store, so shell exports still work naturally. Also: any code path that refreshes OAuth tokens (including reactive 401 retry) must persist the new tokens via the credential provider, not just update `process.env`, because OAuth servers commonly rotate refresh tokens. Finally: load the credential provider and seed `process.env` BEFORE loading other providers that read tokens at creation time (e.g. Slack channel provider reads `process.env.SLACK_BOT_TOKEN` in its `create()` function).
**Tags:** oauth, credentials, dotenv, token-refresh, persistence, precedence, loading-order

### New path helpers must handle colon-separated session IDs
**Date:** 2026-02-22
**Context:** `scratchDir()` used `validatePathSegment()` (alphanumeric/dash/underscore only), but channel session IDs like `test:thread:C02:2000.0001` contain colons and dots
**Lesson:** When adding new path functions that accept session IDs, use `isValidSessionId()` for validation and split colons into nested directories (same pattern as `workspaceDir()`). Don't use `validatePathSegment()` for session IDs — it's only for single-segment identifiers like agent names or user IDs.
**Tags:** paths, session-id, scratchDir, workspaceDir, validation
