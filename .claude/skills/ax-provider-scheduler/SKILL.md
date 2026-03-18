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

- **Heartbeat**: fires every `config.scheduler.heartbeat_interval_min` minutes. Reads optional `HEARTBEAT.md` from `config.scheduler.agent_dir`. Suppressed outside active hours.
- **Cron check**: runs every 60 seconds. Uses `matchesCron()` from `utils.ts` (standard 5-field: min hour dom month dow). Suppressed outside active hours.
- **Active hours**: parsed from `config.scheduler.active_hours.{start,end,timezone}`. Uses `toLocaleTimeString` with the configured timezone. Both heartbeats and cron jobs are gated.
- **Session addressing**: each message uses `schedulerSession(sender)` which sets `provider: 'scheduler'`, `scope: 'dm'`.
- **Async methods**: `addCron`, `removeCron`, `listJobs`, `scheduleOnce` are all async — they await the underlying `KyselyJobStore` operations. Mock schedulers in tests can return sync values (interface allows `void | Promise<void>`).

## Common Tasks

- **Add a new scheduled event type**: create a new timer in `plainjob.ts`, gate it with `isWithinActiveHours()`, fire via `onMessageHandler()`.
- **Test cron matching**: use `checkCronNow(at)` to inject a specific Date without waiting for the 60s interval.

## Gotchas

- **Host-side only**: the scheduler cannot call agent-side functions like `markRun()`. Anything requiring agent execution must go through the message pipeline.
- **Active hours timezone**: `isWithinActiveHours()` uses `toLocaleTimeString` with the configured timezone string. Invalid timezones throw at runtime, not at config parse time.
- **Cron uses local Date methods**: `matchesCron()` calls `date.getMinutes()`, `date.getHours()`, etc., which use the host machine's local time -- not the configured timezone. Only the active-hours gate is timezone-aware.
