---
name: ax-provider-scheduler
description: Use when modifying scheduler providers — cron jobs, heartbeats, proactive hints, or active hours in src/providers/scheduler/
---

## Overview

The scheduler provider fires timed messages (heartbeats, cron jobs) into the host message pipeline. It runs **host-side only** and delivers `InboundMessage` objects via the `onMessage` callback registered during `start()`.

## Interface

### CronJobDef

| Field            | Type     | Required | Notes                          |
|------------------|----------|----------|--------------------------------|
| `id`             | string   | yes      | Unique job identifier          |
| `schedule`       | string   | yes      | Standard 5-field cron expr     |
| `agentId`        | string   | yes      | Target agent                   |
| `prompt`         | string   | yes      | Message content sent on trigger|
| `maxTokenBudget` | number   | no       | Per-job token cap              |

### SchedulerProvider

| Method               | Required | Description                                    |
|----------------------|----------|------------------------------------------------|
| `start(onMessage)`   | yes      | Begin timers; register message callback        |
| `stop()`             | yes      | Clear all timers; release resources             |
| `addCron(job)`       | no       | Register a cron job                            |
| `removeCron(jobId)`  | no       | Remove a cron job by ID                        |
| `listJobs()`         | no       | Return all registered CronJobDef entries       |
| `checkCronNow(at?)`  | no       | Manually trigger cron evaluation (testing)     |
| `recordTokenUsage(n)`| no       | Feed token count for budget tracking           |
| `listPendingHints()` | no       | Return hints queued when budget exceeded       |

## Implementations

| Provider   | File            | Timers | Cron | Active Hours | Notes                                         |
|------------|-----------------|--------|------|--------------|-----------------------------------------------|
| `plainjob` | `plainjob.ts`   | yes    | yes  | yes          | Persistent job queue (Kysely DB) with one-shot support |
| `none`     | `none.ts`       | no     | no   | no           | No-op; all stubs                              |

## PlainJob Provider

- **Location:** `src/providers/scheduler/plainjob.ts`
- **Storage:** Kysely-backed job queue (PostgreSQL in k8s, SQLite fallback) for persistence across restarts
- **One-shot jobs:** `scheduleOnce(datetime, prompt)` for future-dated single-execution jobs
- **Cron jobs:** Standard 5-field cron expressions, persisted to SQLite
- **Heartbeat delivery:** Configurable via `config.scheduler.defaultDelivery`
- **Agent filtering:** Jobs can target specific agents via `agentId`
- **Async stop:** Graceful shutdown clears all timers and flushes pending jobs

## PlainJob Provider Details

- **Dependency injection** via `PlainJobSchedulerDeps`: accepts optional `jobStore` (testing), `database` (shared DatabaseProvider), `eventbus`, and `documents` (DocumentStore for HEARTBEAT.md)
- **Three-tier initialization**: (1) injected `jobStore` for testing, (2) `KyselyJobStore` with shared DatabaseProvider, (3) standalone SQLite at `~/.ax/data/scheduler.db`
- **Migration table**: `'scheduler_migration'` (prevents collision with storage, cortex, etc.)
- **Heartbeat**: fires every `config.scheduler.heartbeat_interval_min` minutes. Reads HEARTBEAT.md from DocumentStore (`documents.get('identity', '{agentName}/HEARTBEAT.md')`). Suppressed outside active hours.
- **Cron check**: runs every 60 seconds. Uses `matchesCron()` from `utils.ts` (standard 5-field: min hour dom month dow). Suppressed outside active hours. Filtered by `agentName` (multi-agent safe).
- **Active hours**: parsed from `config.scheduler.active_hours.{start,end,timezone}`. Uses `toLocaleTimeString` with the configured timezone. Both heartbeats and cron jobs are gated.
- **Session addressing**: each message uses `schedulerSession(sender)` which sets `provider: 'scheduler'`, `scope: 'dm'`.
- **One-shot jobs**: `scheduleOnce(datetime, prompt)` for future-dated single-execution jobs via `setRunAt()`. Rehydrated on startup via `listWithRunAt()`.
- **Async methods**: `addCron`, `removeCron`, `listJobs`, `scheduleOnce` are all async — they await the underlying `KyselyJobStore` operations.

### Multi-Replica Deduplication

Prevents duplicate job firing across multiple host replicas:

- **`tryClaim(jobId, minuteKey)`**: Atomic CAS on `last_fired_at` column — only the replica that wins the UPDATE fires the job
- **PostgreSQL**: Row-level locks serialize concurrent claims naturally
- **SQLite**: Atomic `UPDATE...RETURNING` semantics
- **Synthetic heartbeat row**: `__heartbeat__:{agentName}` row created on startup for distributed heartbeat dedup. Filtered from `listJobs()` results.
- **In-memory fallback**: `MemoryJobStore` uses `lastFiredMinute` Map (tests only)

### In-Flight Protection

Prevents overlapping executions when a job takes longer than its interval:

- **`inFlight: Set<string>`** tracks currently executing jobs
- Before firing: `if (inFlight.has(jobId)) continue`
- `inFlight.add()` happens **before** any async operations (prevents race with rapid heartbeats)
- Removed via `.finally()` on the handler Promise

## Common Tasks

- **Add a new scheduled event type**: create a new timer in `plainjob.ts`, gate it with `isWithinActiveHours()`, fire via `onMessageHandler()`.
- **Test cron matching**: use `checkCronNow(at)` to inject a specific Date without waiting for the 60s interval.

## Gotchas

- **Host-side only**: the scheduler cannot call agent-side functions like `markRun()`. Anything requiring agent execution must go through the message pipeline.
- **Active hours timezone**: `isWithinActiveHours()` uses `toLocaleTimeString` with the configured timezone string. Invalid timezones throw at runtime, not at config parse time.
- **Cron uses local Date methods**: `matchesCron()` calls `date.getMinutes()`, `date.getHours()`, etc., which use the host machine's local time -- not the configured timezone. Only the active-hours gate is timezone-aware.
- **Multi-replica dedup uses `tryClaim()`**: Both cron jobs and heartbeats use `tryClaim(jobId, minuteKey)` for distributed dedup. Only the winning replica fires.
- **In-flight add before async**: `inFlight.add()` must happen before `documents.get()` to prevent duplicate heartbeats when two rapid calls both pass the check.
- **HEARTBEAT.md from DocumentStore**: Identity files are now loaded async from DocumentStore, not synchronous `readFileSync()` from `config.scheduler.agent_dir`.
- **Job migrations**: Three migrations in `src/migrations/jobs.ts`: `jobs_001_initial` (core schema), `jobs_002_last_fired_at` (dedup column), `jobs_003_creator_session_id` (workspace sharing).
- **Scoped cron checks**: `checkCronJobs()` filters by `agentName` via `jobs.list(agentName)`. Each host fires only its own agent's jobs.
