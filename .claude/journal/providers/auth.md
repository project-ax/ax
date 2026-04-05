# Auth Provider Journal

## [2026-04-05 16:35] — Wire auth provider into provider-map and Config types

**Task:** Add auth provider to static allowlist and Config/ProviderRegistry types (Task 3 of 13)
**What I did:** Added `auth` entry to `_PROVIDER_MAP` in `src/host/provider-map.ts` with admin-token and better-auth paths. Added `AuthProviderName` typed export. Updated `src/types.ts` with AuthProviderName import, `auth?: AuthProviderName[]` in Config.providers, `auth?` config block with better_auth settings, and `auth?: AuthProvider[]` in ProviderRegistry.
**Files touched:** `src/host/provider-map.ts` (modified), `src/types.ts` (modified)
**Outcome:** Success — tsc compiles cleanly, all 2876 tests pass
**Notes:** Auth is an array in both Config.providers and ProviderRegistry because multiple auth providers can be chained (admin-token + better-auth).

## [2026-04-05 16:33] — Add admin-token auth provider

**Task:** Implement the admin-token auth provider as the first concrete AuthProvider implementation (Task 2 of 13)
**What I did:** Created `src/providers/auth/admin-token.ts` with timing-safe token comparison, Bearer header and X-Ax-Token header support. Created tests in `tests/providers/auth/admin-token.test.ts` with 6 tests covering valid/invalid/missing tokens and unconfigured token scenarios. TDD approach: tests written first, verified failing, then implementation written.
**Files touched:** `src/providers/auth/admin-token.ts` (created), `tests/providers/auth/admin-token.test.ts` (created)
**Outcome:** Success — all 6 tests pass
**Notes:** Reimplements extractToken/safeEqual from `src/host/server-admin.ts` in the provider pattern so it can be used independently of the admin server.

## [2026-04-05 10:00] — Add AuthProvider contract types

**Task:** Create the AuthProvider contract types as the first step of the pluggable auth provider category
**What I did:** Created `src/providers/auth/types.ts` with AuthRole, AuthUser, AuthResult, and AuthProvider interface. Follows the co-located types pattern used by all other provider categories.
**Files touched:** `src/providers/auth/types.ts` (created)
**Outcome:** Success — compiles cleanly with `npx tsc --noEmit`
**Notes:** The three-way return from authenticate() (null / {authenticated:false} / {authenticated:true, user}) is the key design choice — null means "not my request, try next provider" which enables provider chaining.
