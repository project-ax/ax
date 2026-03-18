# Provider Lessons: Scheduler

### Scheduler provider methods must await async JobStore operations
**Date:** 2026-03-17
**Context:** `addCron`, `removeCron`, `listJobs`, and `scheduleOnce` in plainjob.ts were sync wrappers around `KyselyJobStore` async methods. In-memory tests passed because `MemoryJobStore` is sync, but PostgreSQL (k8s) broke silently — `listJobs()` always returned `[]` since `Array.isArray(Promise)` is false, and `addCron` fire-and-forgot the DB write.
**Lesson:** When a provider method wraps a `JobStore` (or any store with `T | Promise<T>` return types), always declare the method `async` and `await` the store call. The `SchedulerProvider` interface already allows `void | Promise<void>` returns. Sync-only test fixtures (MemoryJobStore) will NOT catch this — add at least one KyselyJobStore integration test per CRUD method.
**Tags:** scheduler, async, kysely, k8s, postgresql, plainjob

### SQLiteJobStore belongs in types.ts alongside MemoryJobStore
**Date:** 2026-03-03
**Context:** Adding a SQLite-backed JobStore for the plainjob scheduler tier
**Lesson:** The `JobStore` interface and its implementations (MemoryJobStore, SQLiteJobStore) live in `src/providers/scheduler/types.ts`. New JobStore implementations should be added there to keep them reusable across scheduler tiers. The SQLiteJobStore uses INSERT OR REPLACE for upsert and COUNT query for delete return value.
**Tags:** scheduler, sqlite, job-store, types

### Pre-existing provider-map path regex failures
**Date:** 2026-03-03
**Context:** Running full test suite after adding plainjob to provider-map
**Lesson:** Two tests (`provider-map.test.ts` and `phase2.test.ts`) have pre-existing failures because the memoryfs provider path `../providers/memory/memoryfs/index.js` doesn't match the regex `[a-z-]+\.js$`. These are NOT caused by new provider entries. Always verify if test failures are pre-existing before investigating.
**Tags:** testing, provider-map, pre-existing-failures
