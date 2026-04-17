# Credential Provider Lessons

### All credential providers must fall back to process.env on get()
**Date:** 2026-03-02
**Context:** Refactoring credential providers to use keychain as default
**Lesson:** Every credential provider's `get()` method should check `process.env[key]` and `process.env[key.toUpperCase()]` after checking its own store. This ensures shell-exported vars (like `OPENROUTER_API_KEY`) work regardless of which credential backend is active. The proxy reads `process.env` synchronously, so credentials must also be seeded into `process.env` at startup via `loadCredentials()`.
**Tags:** credentials, provider, process.env, fallback

### Use AX_CREDS_YAML_PATH env var override for testing credential providers
**Date:** 2026-03-02
**Context:** Writing tests for the plaintext credential provider
**Lesson:** Credential providers that write to disk (plaintext, encrypted) should support an env var override for the file path (e.g., `AX_CREDS_YAML_PATH`, `AX_CREDS_STORE_PATH`) so tests can use temp directories. Set it in `beforeEach`, clean up in `afterEach`, and always save/restore the original value.
**Tags:** credentials, testing, temp-dir, isolation

### Extending CredentialProvider requires touching every inline mock
**Date:** 2026-04-16
**Context:** Added `listScopePrefix(prefix)` to `CredentialProvider` for the skills reconciler current-state loader.
**Lesson:** There are ~7 ad-hoc inline stubs implementing `CredentialProvider` across tests (`tests/dotenv.test.ts`, `tests/host/credential-scopes.test.ts`, `tests/host/credential-injection-integration.test.ts` [×4], `tests/host/ipc-handlers/skills-credential.test.ts`, `tests/provider-sdk/harness.test.ts`, `tests/providers/mcp/database.test.ts` [×4]). Any new method on the interface needs a stub in each. Easy way to find them all: `grep -rn 'delete:\s*async' tests/` — the inline stubs all have `delete: async () => {}`. Running `npm run build` (tsc) catches the missing-method errors cleanly.
**Tags:** credentials, provider, interface, testing, tsc, mock

### LIKE prefix matching — guard against metacharacters even when input looks safe
**Date:** 2026-04-16
**Context:** Implementing `listScopePrefix(prefix)` using `Kysely.where('scope','like',`${prefix}%`)` in `src/providers/credentials/database.ts`.
**Lesson:** Even when callers only pass internally-generated strings (e.g. `user:<agentName>:`), throw on LIKE metacharacters (`%`, `_`, `\`) in the prefix. It's one line and future-proofs against a day when someone passes user-controlled data. Kysely parameterizes the full pattern so injection isn't the risk — over-matching is (`%` means "any"). Throw, don't silently escape: the caller is buggy/hostile, surface it.
**Tags:** sql, kysely, like, security, defensive

### Zod transform for backward-compatible config migration
**Date:** 2026-03-02
**Context:** Migrating `credentials: 'env'` to `credentials: 'keychain'` in config.ts
**Lesson:** When renaming a config value, use `z.union([newEnum, z.literal('old')]).transform()` to accept the old value and silently remap it. Add a `console.warn` for deprecation. This avoids breaking existing ax.yaml files while encouraging migration.
**Tags:** config, zod, migration, backward-compat
