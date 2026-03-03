# Acceptance Tests: PlainJob Scheduler

**Plan document(s):** `docs/plans/2026-03-02-plainjob-scheduler.md`
**Date designed:** 2026-03-03
**Total tests:** 12 (ST: 8, BT: 2, IT: 2)

## Summary of Acceptance Criteria

Extracted from the plan:

1. `SQLiteJobStore` class in `types.ts` implements `JobStore` backed by SQLite (Task 1)
2. `plainjob.ts` provider exists and exports `create(config)` (Task 2)
3. Provider opens/creates `scheduler.db` under `dataDir()` (Task 2.1)
4. Provider creates `scheduler_jobs` table if it doesn't exist (Task 2.2)
5. Provider loads existing jobs from SQLite on `create()` / `start()` (Task 2.3)
6. Provider delegates cron matching, heartbeat, active hours to shared `utils.ts` (Task 2.4)
7. Provider persists `addCron` / `removeCron` to SQLite (Task 2.5)
8. Provider supports `scheduleOnce()` with setTimeout + SQLite persistence (Task 2.6)
9. On restart, provider reloads persisted jobs and re-schedules pending one-shot jobs (Task 2.7)
10. `plainjob` registered in `provider-map.ts` scheduler allowlist (Task 3)
11. Tier boundary: plainjob provides cron + heartbeat but NOT proactive hints or token budget (Position in tier hierarchy)
12. Usage: `providers.scheduler: plainjob` in `ax.yaml`, jobs persist in `~/.ax/data/scheduler.db` (Summary)

## Structural Tests

### ST-1: SQLiteJobStore exists in scheduler types

**Criterion:** "Add a `SQLiteJobStore` class that implements `JobStore` backed by SQLite" (Task 1)
**Plan reference:** `2026-03-02-plainjob-scheduler.md`, Task 1

**Verification steps:**
1. Read `src/providers/scheduler/types.ts` and check that `SQLiteJobStore` is exported
2. Verify `SQLiteJobStore` implements `JobStore` interface methods: `get`, `set`, `delete`, `list`, `close`
3. Verify `SQLiteJobStore` constructor accepts a SQLite database parameter

**Expected outcome:**
- [ ] `SQLiteJobStore` class is exported from `types.ts`
- [ ] It implements all `JobStore` methods (`get`, `set`, `delete`, `list`, `close`)
- [ ] It includes `setRunAt` and `listWithRunAt` for one-shot persistence

**Pass/Fail:** _pending_

---

### ST-2: plainjob provider exports create()

**Criterion:** "Create: `src/providers/scheduler/plainjob.ts`" (Task 2)
**Plan reference:** `2026-03-02-plainjob-scheduler.md`, Task 2

**Verification steps:**
1. Read `src/providers/scheduler/plainjob.ts` and verify it exists
2. Check that it exports a `create(config: Config)` function (provider contract pattern)
3. Verify the returned object implements the `SchedulerProvider` interface

**Expected outcome:**
- [ ] File `src/providers/scheduler/plainjob.ts` exists
- [ ] Exports `create(config)` function
- [ ] Return value includes `start`, `stop`, `addCron`, `removeCron`, `listJobs`, `checkCronNow`, `scheduleOnce`

**Pass/Fail:** _pending_

---

### ST-3: plainjob registered in provider-map

**Criterion:** "Add `plainjob: '../providers/scheduler/plainjob.js'` to the scheduler allowlist" (Task 3)
**Plan reference:** `2026-03-02-plainjob-scheduler.md`, Task 3

**Verification steps:**
1. Read `src/host/provider-map.ts`
2. Check that the `scheduler` section includes a `plainjob` entry

**Expected outcome:**
- [ ] `plainjob` key exists in the `scheduler` section of the provider map
- [ ] Value points to `'../providers/scheduler/plainjob.js'`

**Pass/Fail:** _pending_

---

### ST-4: scheduler_jobs table schema matches plan

**Criterion:** "Creates a `scheduler_jobs` table if it doesn't exist" (Task 2.2)
**Plan reference:** `2026-03-02-plainjob-scheduler.md`, Task 2

**Verification steps:**
1. Read `src/providers/scheduler/types.ts` and find the CREATE TABLE statement
2. Verify columns: `id` (TEXT PRIMARY KEY), `schedule` (TEXT), `agent_id` (TEXT), `prompt` (TEXT), `max_token_budget` (INTEGER, nullable), `delivery` (TEXT, nullable), `run_once` (INTEGER), `run_at` (TEXT, nullable)

**Expected outcome:**
- [ ] Table is named `scheduler_jobs`
- [ ] `id` is TEXT PRIMARY KEY
- [ ] `agent_id` column exists for multi-agent filtering
- [ ] `run_at` column exists for one-shot job persistence
- [ ] `run_once` column exists with default 0

**Pass/Fail:** _pending_

---

### ST-5: plainjob reuses shared utilities

**Criterion:** "Delegates cron matching, heartbeat, active hours to shared `utils.ts`" (Task 2.4)
**Plan reference:** `2026-03-02-plainjob-scheduler.md`, Task 2

**Verification steps:**
1. Read `src/providers/scheduler/plainjob.ts`
2. Grep for imports from `./utils` or `./utils.js`
3. Verify it imports `matchesCron`, `isWithinActiveHours`, and heartbeat-related utilities
4. Verify it does NOT reimplement cron matching or active hours logic locally

**Expected outcome:**
- [ ] Imports `matchesCron` from `./utils.js`
- [ ] Imports `isWithinActiveHours` from `./utils.js`
- [ ] No local reimplementation of cron parsing or active hours logic

**Pass/Fail:** _pending_

---

### ST-6: Tier boundary — no proactive hints or token budget

**Criterion:** "plainjob — SQLite-persisted cron + heartbeat (jobs survive restarts)" but NOT "proactive hints + token budget" (Position in tier hierarchy)
**Plan reference:** `2026-03-02-plainjob-scheduler.md`, Position in tier hierarchy

**Verification steps:**
1. Read `src/providers/scheduler/plainjob.ts`
2. Grep for `proactive`, `hint`, `token_budget`, `confidence_threshold`
3. Compare with `src/providers/scheduler/full.ts` to confirm plainjob lacks those features
4. Verify `create()` does not initialize proactive hint checking or token budget tracking

**Expected outcome:**
- [ ] No proactive hint logic in plainjob.ts
- [ ] No token budget tracking in plainjob.ts
- [ ] Plainjob provides ONLY: cron jobs, heartbeat, scheduleOnce, active hours — nothing more

**Pass/Fail:** _pending_

---

### ST-7: SQLite persistence on addCron / removeCron

**Criterion:** "Persists addCron/removeCron to SQLite" (Task 2.5)
**Plan reference:** `2026-03-02-plainjob-scheduler.md`, Task 2

**Verification steps:**
1. Read `src/providers/scheduler/plainjob.ts`
2. Trace `addCron()` — verify it calls `jobs.set(job)` where `jobs` is a `SQLiteJobStore`
3. Trace `removeCron()` — verify it calls `jobs.delete(jobId)`
4. Verify `SQLiteJobStore.set()` performs an INSERT OR REPLACE into SQLite
5. Verify `SQLiteJobStore.delete()` performs a DELETE from SQLite

**Expected outcome:**
- [ ] `addCron()` persists to SQLite via `SQLiteJobStore.set()`
- [ ] `removeCron()` deletes from SQLite via `SQLiteJobStore.delete()`
- [ ] Uses INSERT OR REPLACE (upsert) semantics for set

**Pass/Fail:** _pending_

---

### ST-8: Comprehensive tests exist

**Criterion:** "Write tests" covering lifecycle, CRUD, persistence, cron firing, runOnce, dedup, scheduleOnce, heartbeat, cleanup (Task 4)
**Plan reference:** `2026-03-02-plainjob-scheduler.md`, Task 4

**Verification steps:**
1. Read `tests/providers/scheduler/plainjob.test.ts`
2. Check for test suites covering each area specified in Task 4:
   - Lifecycle (start/stop)
   - Job CRUD (addCron, listJobs, removeCron)
   - SQLite persistence (jobs survive create() calls)
   - Cron firing via checkCronNow()
   - runOnce auto-deletion
   - Dedup (one fire per minute)
   - scheduleOnce with setTimeout
   - Heartbeat firing
   - Job store cleanup on close

**Expected outcome:**
- [ ] Test file exists at `tests/providers/scheduler/plainjob.test.ts`
- [ ] Has tests for lifecycle (start/stop)
- [ ] Has tests for CRUD (addCron, listJobs, removeCron)
- [ ] Has tests for SQLite persistence across restarts
- [ ] Has tests for cron matching and firing
- [ ] Has tests for runOnce auto-deletion
- [ ] Has tests for dedup (same minute suppression)
- [ ] Has tests for scheduleOnce
- [ ] Has tests for heartbeat
- [ ] Has tests for async cleanup on stop

**Pass/Fail:** _pending_

---

## Behavioral Tests

### BT-1: Server starts with plainjob scheduler

**Criterion:** "To use: set `providers.scheduler: plainjob` in `ax.yaml`" (Summary)
**Plan reference:** `2026-03-02-plainjob-scheduler.md`, Summary

**Setup:**
- Configure `ax.yaml` with `providers.scheduler: plainjob`
- Use isolated `AX_HOME` test directory

**Chat script:**
1. Start server with `providers.scheduler: plainjob` in config
   Expected behavior: Server starts without errors, health endpoint returns OK
   Structural check: `$TEST_HOME/ax.sock` exists, `/health` responds

2. Send: `hello`
   Expected behavior: Agent responds normally (scheduler is background, doesn't affect chat)
   Structural check: No scheduler errors in `$TEST_HOME/data/ax.log`

**Expected outcome:**
- [ ] Server starts successfully with plainjob scheduler
- [ ] Health endpoint returns 200
- [ ] No scheduler-related errors in logs
- [ ] Agent can respond to messages normally

**Pass/Fail:** _pending_

---

### BT-2: Scheduler database created on startup

**Criterion:** "Opens (or creates) `scheduler.db` under `dataDir()`" (Task 2.1) / "Jobs persist in `~/.ax/data/scheduler.db`" (Summary)
**Plan reference:** `2026-03-02-plainjob-scheduler.md`, Task 2.1 & Summary

**Setup:**
- Configure `ax.yaml` with `providers.scheduler: plainjob`
- Use isolated `AX_HOME` test directory
- Server already running from BT-1

**Chat script:**
1. Send: `what time is it?`
   Expected behavior: Agent responds (this triggers scheduler initialization if lazy)
   Structural check: Verify `$TEST_HOME/data/scheduler.db` exists

2. Check SQLite schema:
   ```bash
   sqlite3 "$TEST_HOME/data/scheduler.db" ".schema scheduler_jobs"
   ```
   Expected behavior: Table schema matches plan specification
   Structural check: Columns include id, schedule, agent_id, prompt, run_once, run_at

**Expected outcome:**
- [ ] `scheduler.db` file exists under `$TEST_HOME/data/`
- [ ] `scheduler_jobs` table exists with correct schema
- [ ] Database is valid SQLite (not corrupted)
- [ ] WAL journal mode is enabled

**Pass/Fail:** _pending_

---

## Integration Tests

### IT-1: Cron jobs persist across server restart

**Criterion:** "Loads existing jobs from SQLite on `create()`" (Task 2.3) / "On restart, reloads persisted jobs" (Task 2.7)
**Plan reference:** `2026-03-02-plainjob-scheduler.md`, Tasks 2.3 & 2.7

**Setup:**
- Configure `ax.yaml` with `providers.scheduler: plainjob`
- Use isolated `AX_HOME` test directory
- Session ID: `acceptance:plainjob:it1`

**Sequence:**
1. Start server
   Action: Launch AX server with plainjob scheduler
   Verify: Health endpoint returns 200

2. Insert a test cron job directly into SQLite
   Action:
   ```bash
   sqlite3 "$TEST_HOME/data/scheduler.db" \
     "INSERT INTO scheduler_jobs (id, schedule, agent_id, prompt, run_once) \
      VALUES ('test-persist-1', '0 9 * * *', 'main', 'Good morning check', 0);"
   ```
   Verify: Row exists in database

3. Stop server
   Action: Kill server process gracefully (SIGTERM)
   Verify: Process exits, socket removed

4. Restart server
   Action: Launch AX server again with same `$TEST_HOME`
   Verify: Health endpoint returns 200

5. Verify job survived restart
   Action:
   ```bash
   sqlite3 "$TEST_HOME/data/scheduler.db" \
     "SELECT id, schedule, agent_id, prompt FROM scheduler_jobs WHERE id = 'test-persist-1';"
   ```
   Verify: Row still exists with all original values intact

**Expected final state:**
- [ ] Job `test-persist-1` exists in database after restart
- [ ] All job fields (schedule, agent_id, prompt) are preserved
- [ ] No duplicate entries created
- [ ] Server started cleanly on second launch (no migration errors)

**Pass/Fail:** _pending_

---

### IT-2: One-shot job run_at persists for rehydration

**Criterion:** "Supports `scheduleOnce()` with setTimeout + SQLite persistence" (Task 2.6) / "On restart, reloads persisted jobs and re-schedules any pending one-shot jobs" (Task 2.7)
**Plan reference:** `2026-03-02-plainjob-scheduler.md`, Tasks 2.6 & 2.7

**Setup:**
- Configure `ax.yaml` with `providers.scheduler: plainjob`
- Use isolated `AX_HOME` test directory
- Session ID: `acceptance:plainjob:it2`

**Sequence:**
1. Start server
   Action: Launch AX server with plainjob scheduler
   Verify: Health endpoint returns 200

2. Insert a one-shot job with future run_at directly into SQLite
   Action:
   ```bash
   # Schedule for 10 minutes from now
   FUTURE=$(date -u -v+10M +"%Y-%m-%dT%H:%M:%S.000Z" 2>/dev/null || date -u -d "+10 minutes" +"%Y-%m-%dT%H:%M:%S.000Z")
   sqlite3 "$TEST_HOME/data/scheduler.db" \
     "INSERT INTO scheduler_jobs (id, schedule, agent_id, prompt, run_once, run_at) \
      VALUES ('oneshot-persist-1', '* * * * *', 'main', 'One-shot reminder', 1, '$FUTURE');"
   ```
   Verify: Row exists with `run_at` set

3. Stop server
   Action: Kill server process gracefully (SIGTERM)
   Verify: Process exits

4. Restart server
   Action: Launch AX server again with same `$TEST_HOME`
   Verify: Health endpoint returns 200

5. Verify one-shot job survived and has run_at intact
   Action:
   ```bash
   sqlite3 "$TEST_HOME/data/scheduler.db" \
     "SELECT id, run_once, run_at FROM scheduler_jobs WHERE id = 'oneshot-persist-1';"
   ```
   Verify: Row exists with `run_once = 1` and `run_at` matches the future timestamp

**Expected final state:**
- [ ] One-shot job `oneshot-persist-1` exists in database after restart
- [ ] `run_at` timestamp is preserved (not cleared)
- [ ] `run_once` flag is still 1
- [ ] Server rehydrated the job (would re-schedule setTimeout internally)

**Pass/Fail:** _pending_
