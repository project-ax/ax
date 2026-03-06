# Cortex Acceptance Test Fixes (FIX-6/7/8/9)

## [2026-03-06 16:30] — Fix remaining cortex acceptance test issues

**Task:** Fix 4 remaining issues from `tests/acceptance/cortex/fixes.md`: FIX-6, FIX-7, FIX-8, FIX-9
**What I did:**
- **FIX-6:** Added `apiCredentials.envVars` secret loop to `charts/ax/templates/host/deployment.yaml` (matching agent-runtime template)
- **FIX-7:** Added `python3 make g++` build tools to `container/Dockerfile` for native extension compilation
- **FIX-8:** Fixed `searchContent()` in `items-store.ts` to split OR-joined terms into individual LIKE conditions using Kysely `eb.or()`
- **FIX-9:** Changed default `internal.auth.username` from `ax` to `postgres` in `values.yaml`; updated `_helpers.tpl` to use correct secret key based on username
**Files touched:**
- `src/providers/memory/cortex/items-store.ts` (searchContent OR split)
- `tests/providers/memory/cortex/items-store.test.ts` (new OR search test)
- `charts/ax/templates/host/deployment.yaml` (API credentials env vars)
- `charts/ax/templates/_helpers.tpl` (conditional PG secret key)
- `charts/ax/values.yaml` (default username → postgres)
- `container/Dockerfile` (build tools for native extensions)
- `tests/acceptance/cortex/fixes.md` (status updates)
**Outcome:** Success — all 2359 tests pass, all 9 fix items now resolved
**Notes:** FIX-7 is partial — sqlite-vec for SQLite mode needs build tools (added), but k8s with PostgreSQL depends on pgvector being available in the PG instance (the `postgres.ts` provider already handles this via `CREATE EXTENSION IF NOT EXISTS vector`)
