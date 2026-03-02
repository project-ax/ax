# Scheduler Provider Journal

## [2026-03-02 12:00] — Create plainjob scheduler implementation plan

**Task:** Revise the original DB-backed scheduler plan (Croner + better-sqlite3) to use plainjob as the foundation instead
**What I did:** Researched plainjob's API surface (defineQueue, defineWorker, schedule, add), analyzed its SQLite schema (plainjob_jobs, plainjob_scheduled_jobs), compared its Connection interface against AX's openDatabase() adapter, then wrote a comprehensive implementation plan covering: connection strategy (use plainjob's built-in better/bun adapters), job type naming (ax-cron:{id} / ax-once:{id}), CronJobDef metadata persistence (ax_job_meta side table), startup recovery, shutdown sequence, and the full-plainjob variant with proactive hints.
**Files touched:** `docs/plans/2026-03-02-plainjob-scheduler.md` (created)
**Outcome:** Success — plan created with 7 implementation tasks covering dependency installation, config changes, provider-map registration, base provider implementation, full variant, test suite, and journal updates.
**Notes:** Key design decision: plainjob's `queue.schedule()` doesn't accept arbitrary `data` — only `type` + `cron`. CronJobDef metadata must be stored in a side table (`ax_job_meta`) for restart recovery. Also, each scheduled job needs its own worker since plainjob matches on exact type strings.
