# plainjob Scheduler Provider Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use provider-scheduler to implement this plan task-by-task.

**Goal:** Add a `plainjob` scheduler tier that uses [plainjob](https://github.com/justplainstuff/plainjob) — a SQLite-backed job queue — for durable cron scheduling and one-shot delayed jobs. Survives process restarts. Replaces in-memory cron matching with plainjob's built-in `cron-parser` and persistent job tables.

**Architecture:** New `src/providers/scheduler/plainjob.ts` implements `SchedulerProvider` using plainjob's `defineQueue` + `defineWorker`. Cron jobs use `queue.schedule()` for recurring execution with SQLite durability. One-shot jobs use `queue.add()` with `delay`. A per-schedule worker converts fired jobs into `InboundMessage` calls via the existing `onMessage` callback. Heartbeat remains a `setInterval` timer (not a job — doesn't need persistence). Proactive hints and token budget remain in-memory (same as `full` tier). The existing `none`, `cron`, and `full` tiers are untouched.

**Tech Stack:** plainjob (npm), better-sqlite3 / bun:sqlite (already deps), existing SchedulerProvider interface

---

## Design Decisions

### Why plainjob

The existing `cron` and `full` scheduler providers use in-memory job storage (`MemoryJobStore`), a hand-rolled 60-second polling loop, and custom cron matching (`matchesCron` / `parseCronField` / `minuteKey` in `utils.ts`). This works, but:

1. **Jobs don't survive restarts.** `MemoryJobStore` is a `Map` — everything's gone on process death.
2. **One-shot jobs are `setTimeout`-based.** If the process restarts between scheduling and firing, the job is lost.
3. **No execution history.** The store only tracks what's scheduled, not what ran.

plainjob gives us durable SQLite persistence, battle-tested cron parsing, timeout-based requeue for stalled jobs, auto-cleanup of completed/failed jobs, and an execution history for free (every fired job is a row in `plainjob_jobs`). It also supports both `better-sqlite3` and `bun:sqlite`, matching AX's dual-runtime story.

### What plainjob replaces

| Concern | Current (`cron.ts`) | plainjob |
|---------|---------------------|----------|
| Job persistence | `MemoryJobStore` (in-memory `Map`) | SQLite tables (`plainjob_jobs`, `plainjob_scheduled_jobs`) |
| Cron parsing | `matchesCron()` + `parseCronField()` in `utils.ts` | `cron-parser` (bundled in plainjob) |
| Deduplication | `lastFiredMinute` Map + `minuteKey()` | `next_run_at` tracking in `plainjob_scheduled_jobs` |
| One-shot jobs | `setTimeout` (lost on restart) | `queue.add(type, data, { delay })` (persisted) |
| Execution tracking | None | Every fired job is a row with status (Pending→Processing→Done/Failed) |
| Cleanup | None | `removeDoneJobsOlderThan` / `removeFailedJobsOlderThan` |
| Stall recovery | None | `timeout` option → auto-requeues processing jobs that exceed deadline |

### What stays AX-specific

- **Active hours filtering** — plainjob has no concept of this. The worker processor checks `isWithinActiveHours()` and marks the job done without acting if outside hours.
- **Heartbeat** — A periodic timer, not a job. Stays as `setInterval`. Doesn't need persistence.
- **Proactive hints** (`full-plainjob` variant only) — Memory subscription, confidence thresholds, cooldown, token budget logic. Orthogonal to job scheduling.
- **`SchedulerProvider` interface** — plainjob's `Queue`/`Worker` types don't match AX's provider contract. The new provider wraps them.
- **`CronJobDef` mapping** — AX's `CronJobDef` (id, schedule, agentId, prompt, delivery, runOnce) serialized into plainjob's `data` field.

### Connection strategy

plainjob expects its own `Connection` interface with `pragma()`, `exec()`, `prepare()`, `transaction()`, `close()`. AX has `openDatabase()` in `src/utils/sqlite.ts` returning a different `SQLiteDatabase` shape.

**Decision: Use plainjob's built-in adapters directly** — `better(db)` for Node.js, `bun(db)` for Bun runtime. This bypasses AX's `openDatabase()` but gets the exact shape plainjob needs without a fragile bridge layer. The scheduler provider does its own runtime detection (same `isBun` check from `src/utils/sqlite.ts`) and calls the appropriate plainjob adapter.

The SQLite file lives at `{data_dir}/scheduler.db`, separate from other AX databases. The `data_dir` path comes from a new optional config field `scheduler.db_path`.

### Job type naming convention

plainjob's `schedule()` creates entries in `plainjob_scheduled_jobs` with a UNIQUE `type` column. Each `CronJobDef` maps to a type string `ax-cron:{job.id}`. One-shot jobs use `ax-once:{job.id}`.

plainjob's `defineWorker(type, processor, { queue })` matches on exact `type`. Since each scheduled job has a unique type, each gets its own worker. All workers share the same processor function. A `Map<string, Worker>` tracks active workers (parallel to the current `Map<string, setTimeout>` for once-timers).

### Recovery behavior

plainjob handles recovery via `next_run_at` recalculation:
- On startup, `cron-parser` computes the next future run time for each scheduled job. If the process was down and `next_run_at` is in the past, it fast-forwards to the next valid time. This is **skip-missed** behavior.
- Any jobs stuck in `Processing` status (process died mid-execution) get requeued after `timeout` expires.

This matches the original plan's recommended default. If "run once on recovery" is needed later, it can be added as a post-startup check without changing the architecture.

### Concurrency

plainjob's worker processes one job at a time per worker instance (sequential polling loop). If a handler takes longer than the cron interval, subsequent jobs queue up as `Pending` rows. No overlap, no lost jobs. Equivalent to Croner's `protect: true` but with persistence — if the process dies mid-execution, the job gets requeued after timeout.

### Shutdown

```
1. Clear heartbeat timer (clearInterval)
2. Stop all workers (worker.stop() — awaits in-flight job)
3. Close queue (queue.close() — final maintenance, closes SQLite)
```

plainjob's `worker.stop()` already handles awaiting in-flight work. For shutdown timeout: wrap `worker.stop()` calls in `Promise.race` with a configurable deadline.

### `runOnce` jobs

AX's `CronJobDef` has a `runOnce` flag — fire once then delete. For plainjob:
- Use `queue.add('ax-once:{id}', serializedDef, { delay })` instead of `queue.schedule()`. The delay is computed from the cron expression's next tick (or from the explicit `fireAt` Date for `scheduleOnce()`).
- After the worker processes it, the job becomes `Done` and plainjob auto-cleans it per retention policy.
- **Reliability improvement:** Current `setTimeout`-based `scheduleOnce()` loses the job on restart. plainjob persists it.

---

## Prerequisites

- `plainjob` installed as a dependency
- `better-sqlite3` already present (existing dep)

---

### Task 1: Install plainjob dependency

**Files:**
- Modify: `package.json`

**Step 1: Install plainjob**

Run: `npm install plainjob`

**Step 2: Verify installation**

Run: `npm ls plainjob`
Expected: `plainjob@<version>` listed

**Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: add plainjob dependency for durable scheduler"
```

---

### Task 2: Add `db_path` to scheduler config

**Files:**
- Modify: `src/types.ts:88-100` (scheduler config block)

**Step 1: Write the failing test**

Create: `tests/providers/scheduler/plainjob.test.ts`

```typescript
import { describe, test, expect, afterEach, vi, beforeEach } from 'vitest';
import type { Config } from '../../../src/types.js';

const mockConfig = {
  profile: 'balanced',
  providers: {
    llm: 'anthropic', memory: 'file', scanner: 'basic',
    channels: ['cli'], web: 'none', browser: 'none',
    credentials: 'env', skills: 'readonly', audit: 'file',
    sandbox: 'subprocess', scheduler: 'plainjob',
  },
  sandbox: { timeout_sec: 120, memory_mb: 512 },
  scheduler: {
    active_hours: { start: '00:00', end: '23:59', timezone: 'UTC' },
    max_token_budget: 4096,
    heartbeat_interval_min: 30,
    db_path: '/tmp/test-scheduler.db',
  },
  history: { max_turns: 50, thread_context_turns: 5 },
} as Config;

describe('scheduler-plainjob config', () => {
  test('config accepts db_path field', () => {
    expect(mockConfig.scheduler.db_path).toBe('/tmp/test-scheduler.db');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/providers/scheduler/plainjob.test.ts`
Expected: FAIL — `db_path` does not exist on `Config.scheduler` type

**Step 3: Add `db_path` to Config type**

In `src/types.ts:88-100`, add `db_path?: string;` to the scheduler block:

```typescript
  scheduler: {
    active_hours: {
      start: string;
      end: string;
      timezone: string;
    };
    max_token_budget: number;
    heartbeat_interval_min: number;
    proactive_hint_confidence_threshold?: number;
    proactive_hint_cooldown_sec?: number;
    agent_dir?: string;
    defaultDelivery?: CronDelivery;
    db_path?: string;               // ← NEW: SQLite path for plainjob store
  };
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/providers/scheduler/plainjob.test.ts`
Expected: PASS

---

### Task 3: Register `plainjob` in provider-map

**Files:**
- Modify: `src/host/provider-map.ts:78-82` (scheduler block)

**Step 1: Add plainjob entry**

```typescript
  scheduler: {
    none:     '../providers/scheduler/none.js',
    cron:     '../providers/scheduler/cron.js',
    full:     '../providers/scheduler/full.js',
    plainjob: '../providers/scheduler/plainjob.js',   // ← NEW
  },
```

**Step 2: Verify SchedulerProviderName type updates**

The `SchedulerProviderName` type at line 116 is derived from the map and should now include `'plainjob'`. No manual change needed — it's computed with `keyof`.

**Step 3: Run existing tests**

Run: `npx vitest run tests/host/` — verify no regressions.

---

### Task 4: Implement the plainjob scheduler provider

This is the core task. The provider wraps plainjob's `defineQueue` + `defineWorker` and exposes the `SchedulerProvider` interface.

**Files:**
- Create: `src/providers/scheduler/plainjob.ts`

**Step 1: Write comprehensive tests**

Expand `tests/providers/scheduler/plainjob.test.ts` with tests for the full lifecycle. Use an in-memory or temp-file SQLite database.

Tests to write:

```
describe('scheduler-plainjob', () => {
  // Lifecycle
  test('start() initializes queue and workers')
  test('stop() shuts down workers and closes queue')

  // CRUD
  test('addCron() persists job and creates worker')
  test('removeCron() stops worker and removes schedule')
  test('listJobs() returns all registered CronJobDefs')

  // Firing
  test('cron job fires onMessage with correct InboundMessage shape')
  test('cron job respects active hours — skips outside window')
  test('runOnce job fires once then is not rescheduled')

  // One-shot
  test('scheduleOnce() persists delayed job via queue.add()')
  test('scheduleOnce() job fires after delay and calls onMessage')

  // Heartbeat
  test('heartbeat fires at configured interval')
  test('heartbeat respects active hours')
  test('heartbeat reads HEARTBEAT.md when agent_dir is set')

  // Recovery
  test('jobs survive queue close and reopen')
  test('stalled processing jobs are requeued after timeout')

  // Shutdown
  test('stop() awaits in-flight job before closing')

  // Testing helper
  test('checkCronNow() is not supported (returns undefined)')
})
```

**Step 2: Implement the provider**

```typescript
// src/providers/scheduler/plainjob.ts
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import type { SchedulerProvider, CronJobDef } from './types.js';
import type { InboundMessage } from '../shared-types.js';
import type { Config } from '../../types.js';
import {
  type ActiveHours,
  schedulerSession, parseTime, isWithinActiveHours,
} from './utils.js';

// Note: matchesCron, parseCronField, minuteKey are NOT imported —
// plainjob handles cron matching internally.

interface PlainJobDeps {
  // Allow injecting a pre-configured queue for testing
  queue?: unknown;
}

export async function create(
  config: Config,
  deps: PlainJobDeps = {},
): Promise<SchedulerProvider> {
  // ... (see implementation notes below)
}
```

**Implementation notes for `create()`:**

1. **Runtime detection + connection setup:**
   ```typescript
   const req = createRequire(import.meta.url);
   const isBun = typeof (globalThis as Record<string, unknown>).Bun !== 'undefined';

   // Use plainjob's built-in adapters
   const { defineQueue, defineWorker, better, bun } = req('plainjob');

   let connection;
   if (isBun) {
     const { Database } = req('bun:sqlite');
     connection = bun(new Database(dbPath));
   } else {
     const BetterSqlite3 = req('better-sqlite3');
     connection = better(new BetterSqlite3(dbPath));
   }
   ```

2. **Queue creation:**
   ```typescript
   const queue = defineQueue({
     connection,
     timeout: 5 * 60 * 1000,            // 5 min job timeout
     removeDoneJobsOlderThan: 7 * 24 * 60 * 60 * 1000,  // 7 days
     removeFailedJobsOlderThan: 30 * 24 * 60 * 60 * 1000, // 30 days
   });
   ```

3. **Job data serialization:**
   ```typescript
   // CronJobDef → plainjob data (JSON-serialized)
   function serializeDef(def: CronJobDef): string {
     return JSON.stringify(def);
   }
   function deserializeDef(data: string): CronJobDef {
     return JSON.parse(data) as CronJobDef;
   }
   ```

4. **Worker creation per schedule:**
   ```typescript
   const workers = new Map<string, ReturnType<typeof defineWorker>>();

   function jobType(id: string): string { return `ax-cron:${id}`; }
   function onceType(id: string): string { return `ax-once:${id}`; }

   function createWorkerForJob(type: string): void {
     const worker = defineWorker(type, async (job: { data: string }) => {
       if (!onMessageHandler) return;
       if (!isWithinActiveHours(activeHours)) return; // skip silently

       const def = deserializeDef(job.data);
       onMessageHandler({
         id: randomUUID(),
         session: schedulerSession(`cron:${def.id}`),
         sender: `cron:${def.id}`,
         content: def.prompt,
         attachments: [],
         timestamp: new Date(),
       });
     }, { queue });

     worker.start();
     workers.set(type, worker);
   }
   ```

5. **`addCron()` implementation:**
   ```typescript
   addCron(job: CronJobDef): void {
     const type = job.runOnce ? onceType(job.id) : jobType(job.id);

     if (job.runOnce) {
       // One-shot: compute delay from cron expression's next tick
       // Use cron-parser to get next fire time, then queue.add with delay
       const { parseExpression } = require('cron-parser');
       const interval = parseExpression(job.schedule);
       const nextFire = interval.next().toDate();
       const delay = Math.max(0, nextFire.getTime() - Date.now());
       queue.add(type, serializeDef(job), { delay });
     } else {
       // Recurring: use queue.schedule()
       queue.schedule(type, { cron: job.schedule });
       // Store the CronJobDef data — plainjob scheduled_jobs only stores type+cron,
       // not arbitrary data. We need a side-map for the job metadata.
     }

     createWorkerForJob(type);

     // Track the CronJobDef in a local map for listJobs()
     jobDefs.set(job.id, job);
   }
   ```

6. **Important nuance — `queue.schedule()` doesn't accept `data`:**

   plainjob's `schedule(type, { cron })` creates a template in `plainjob_scheduled_jobs` that only stores `type` and `cron_expression`. When it fires, it inserts a job into `plainjob_jobs` **with no data**. The worker receives a job with `data: '{}'` (or similar empty payload).

   **Solution: Store `CronJobDef` metadata in a side `Map<string, CronJobDef>`** and look it up by type in the worker processor. The side map is reconstructed on startup from the scheduled jobs table (type encodes the job ID) plus the original `addCron` call.

   For durability across restarts, persist the `CronJobDef` metadata separately. Two options:

   a. **Use the same SQLite database** — create a small `ax_job_meta` table alongside plainjob's tables.
   b. **Use `queue.add()` for everything** instead of `queue.schedule()` — add a job with the full data payload, and when the worker processes it, compute the next fire time and `queue.add()` a successor. This makes each "recurring" job a chain of one-shots.

   **Go with option (a):** A `ax_job_meta` table keeps the clean separation between plainjob's scheduling and AX's job metadata. The table schema:

   ```sql
   CREATE TABLE IF NOT EXISTS ax_job_meta (
     id   TEXT PRIMARY KEY,
     def  TEXT NOT NULL       -- JSON-serialized CronJobDef
   );
   ```

   On startup, read all rows from `ax_job_meta`, cross-reference with `queue.getScheduledJobs()`, and recreate workers for active schedules. This handles the restart recovery case: plainjob restores the cron schedules, and `ax_job_meta` restores the metadata.

7. **Startup sequence:**
   ```typescript
   async start(onMessage): Promise<void> {
     onMessageHandler = onMessage;

     // Restore CronJobDef metadata from ax_job_meta table
     const rows = metaStmt.all() as Array<{ id: string; def: string }>;
     for (const row of rows) {
       const def = JSON.parse(row.def) as CronJobDef;
       jobDefs.set(def.id, def);
     }

     // Create workers for all scheduled jobs that have metadata
     const scheduled = queue.getScheduledJobs();
     for (const sj of scheduled) {
       if (!workers.has(sj.type)) {
         createWorkerForJob(sj.type);
       }
     }

     // Start heartbeat timer
     heartbeatTimer = setInterval(fireHeartbeat, heartbeatIntervalMs);
   }
   ```

8. **Shutdown:**
   ```typescript
   async stop(): Promise<void> {
     if (heartbeatTimer) {
       clearInterval(heartbeatTimer);
       heartbeatTimer = null;
     }

     const stopPromises = [...workers.values()].map(w => w.stop());
     const timeout = config.scheduler.shutdown_timeout ?? 10_000;
     await Promise.race([
       Promise.all(stopPromises),
       new Promise(resolve => setTimeout(resolve, timeout)),
     ]);

     workers.clear();
     queue.close();
     onMessageHandler = null;
   }
   ```

**Step 3: Verify all tests pass**

Run: `npx vitest run tests/providers/scheduler/plainjob.test.ts`

---

### Task 5: Implement `full-plainjob` variant with proactive hints

**Files:**
- Create: `src/providers/scheduler/full-plainjob.ts`
- Create: `tests/providers/scheduler/full-plainjob.test.ts`

This follows the same pattern as `full.ts` extending `cron.ts`. The `full-plainjob` provider composes the base `plainjob` provider with:

- Memory provider's `onProactiveHint()` subscription
- Confidence threshold filtering
- Cooldown tracking (SHA256 signature-based)
- Active hours filtering for hints
- Token budget tracking
- Audit logging for hint decisions
- `recordTokenUsage()` and `listPendingHints()` methods

**Step 1: Write tests** — mirror `tests/providers/scheduler/full.test.ts` but using plainjob base.

**Step 2: Implement** — import `create` from `./plainjob.js`, wrap it with the proactive hint logic from `full.ts`. The hint handling code is identical; only the base scheduler changes.

**Step 3: Register in provider-map:**

```typescript
  scheduler: {
    none:           '../providers/scheduler/none.js',
    cron:           '../providers/scheduler/cron.js',
    full:           '../providers/scheduler/full.js',
    plainjob:       '../providers/scheduler/plainjob.js',
    'full-plainjob': '../providers/scheduler/full-plainjob.js',   // ← NEW
  },
```

**Step 4: Verify all tests pass**

Run: `npx vitest run tests/providers/scheduler/`

---

### Task 6: Run full test suite and fix regressions

**Step 1:** Run `npm test -- --run`

**Step 2:** Fix any regressions. Common issues:
- `SchedulerProviderName` type changes affecting tests that enumerate valid provider names
- Provider-map tests checking the exact set of scheduler entries
- If any sync tests validate the scheduler provider count

**Step 3:** Verify clean test run

---

### Task 7: Update journal and lessons

**Files:**
- Append: `.claude/journal/providers/scheduler.md`
- Conditionally append: `.claude/lessons/providers/scheduler.md` (if new lessons discovered)

---

## Things deferred

- **"Run once on recovery" / missed policy** — Skip-missed is the default (plainjob's natural behavior). Can be added later as a post-startup check that compares last execution time against the previous cron tick.
- **Execution history API** — plainjob's `plainjob_jobs` table already stores every execution. Exposing it via `SchedulerProvider` (e.g., `listExecutions(jobId)`) is a future enhancement.
- **Multi-process workers** — plainjob supports forking workers across CPU cores. Single-process is fine for AX's use case.
- **Custom serializer** — plainjob supports a `serializer` option. Default `JSON.stringify`/`JSON.parse` is fine.
- **`full-plainjob` as default** — The `full-plainjob` variant could eventually replace `full` as the default scheduler. Deferred until the plainjob tier is proven in production.
- **`checkCronNow()` test helper** — plainjob doesn't expose a "manually trigger now" API. Tests use real cron timing or manipulate the database directly. The method returns `undefined` / is a no-op on the plainjob provider.
- **Retry logic** — For recurring schedules, the next cron tick IS the retry. plainjob's timeout-based requeue handles stalled jobs. Explicit retry-with-backoff for single executions is a different pattern.

## File structure (final)

```
src/providers/scheduler/
├── types.ts              -- unchanged
├── cron.ts               -- unchanged (backward compat)
├── full.ts               -- unchanged (backward compat)
├── none.ts               -- unchanged
├── utils.ts              -- unchanged (plainjob provider still uses isWithinActiveHours, schedulerSession, parseTime)
├── plainjob.ts           -- NEW: plainjob-backed scheduler provider
└── full-plainjob.ts      -- NEW: plainjob + proactive hints

tests/providers/scheduler/
├── cron.test.ts          -- unchanged
├── full.test.ts          -- unchanged
├── utils.test.ts         -- unchanged
├── plainjob.test.ts      -- NEW
└── full-plainjob.test.ts -- NEW
```
