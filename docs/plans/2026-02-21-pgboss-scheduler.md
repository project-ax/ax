# pg-boss Scheduler Tier Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a `pgboss` scheduler tier that uses pg-boss for distributed cron scheduling and one-shot delayed jobs, safe for multi-replica K8s deployments.

**Architecture:** New `src/providers/scheduler/pgboss.ts` implements `SchedulerProvider` using pg-boss. Cron jobs use `boss.schedule()` for distributed-safe recurring execution. One-shot jobs use `boss.send()` with `startAfter`. A single `boss.work()` handler converts fired jobs into `InboundMessage` calls. Heartbeat is a pg-boss schedule. Proactive hints and token budget remain in-memory (per-instance, same as `full` tier). The existing `none`, `cron`, and `full` tiers are untouched.

**Tech Stack:** pg-boss (npm), PostgreSQL, existing SchedulerProvider interface

---

## Prerequisites

- PostgreSQL instance accessible from dev environment
- `DATABASE_URL` env var with connection string (e.g. `postgres://user:pass@localhost:5432/ax`)

---

### Task 1: Install pg-boss dependency

**Files:**
- Modify: `package.json`

**Step 1: Install pg-boss**

Run: `npm install pg-boss`

**Step 2: Verify installation**

Run: `npm ls pg-boss`
Expected: `pg-boss@<version>` listed

**Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: add pg-boss dependency"
```

---

### Task 2: Add `pgboss_url` to scheduler config

**Files:**
- Modify: `src/types.ts:57-69` (scheduler config block)

**Step 1: Write the failing test**

Create: `tests/providers/scheduler/pgboss.test.ts`

```typescript
import { describe, test, expect, afterEach, vi, beforeEach } from 'vitest';
import type { Config } from '../../../src/types.js';
import type { InboundMessage } from '../../../src/providers/channel/types.js';

// ─── Mock config ──────────────────────────────────────

const mockConfig = {
  profile: 'balanced',
  providers: {
    llm: 'anthropic', memory: 'file', scanner: 'basic',
    channels: ['cli'], web: 'none', browser: 'none',
    credentials: 'env', skills: 'readonly', audit: 'file',
    sandbox: 'subprocess', scheduler: 'pgboss',
  },
  sandbox: { timeout_sec: 120, memory_mb: 512 },
  scheduler: {
    active_hours: { start: '00:00', end: '23:59', timezone: 'UTC' },
    max_token_budget: 4096,
    heartbeat_interval_min: 30,
    pgboss_url: 'postgres://test:test@localhost:5432/ax_test',
  },
  history: { max_turns: 50, thread_context_turns: 5 },
} as Config;

describe('scheduler-pgboss config', () => {
  test('config accepts pgboss_url field', () => {
    expect(mockConfig.scheduler.pgboss_url).toBe('postgres://test:test@localhost:5432/ax_test');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/providers/scheduler/pgboss.test.ts`
Expected: FAIL — `pgboss_url` does not exist on Config.scheduler type

**Step 3: Add pgboss_url to Config type**

In `src/types.ts`, add `pgboss_url?: string;` to the `scheduler` block (after line 68, before the closing `}`):

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
    pgboss_url?: string;
  };
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/providers/scheduler/pgboss.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/types.ts tests/providers/scheduler/pgboss.test.ts
git commit -m "feat(scheduler): add pgboss_url config field"
```

---

### Task 3: Create the pgboss scheduler provider

This is the core task. The provider implements `SchedulerProvider` by delegating to pg-boss.

**Files:**
- Create: `src/providers/scheduler/pgboss.ts`

**Step 1: Write integration tests**

Expand `tests/providers/scheduler/pgboss.test.ts` with the full test suite. These tests mock pg-boss itself (we don't need a real Postgres in unit tests). The mock captures `schedule()`, `send()`, and `work()` calls.

```typescript
import { describe, test, expect, afterEach, vi, beforeEach } from 'vitest';
import type { Config } from '../../../src/types.js';
import type { InboundMessage } from '../../../src/providers/channel/types.js';
import type { CronJobDef } from '../../../src/providers/scheduler/types.js';

// ─── Mock pg-boss ─────────────────────────────────────

// Capture the work handler so tests can simulate job delivery
let workHandler: ((jobs: any[]) => Promise<void>) | null = null;
const scheduledQueues = new Map<string, { cron: string; data: any }>();
const sentJobs: { queue: string; data: any; options: any }[] = [];
const createdQueues = new Set<string>();
const cancelledJobIds: string[] = [];

const mockBoss = {
  start: vi.fn(),
  stop: vi.fn(),
  createQueue: vi.fn(async (name: string) => { createdQueues.add(name); }),
  work: vi.fn(async (_queue: string, _opts: any, handler: any) => {
    workHandler = handler;
  }),
  schedule: vi.fn(async (queue: string, cron: string, data: any) => {
    scheduledQueues.set(`${queue}:${data?.jobId ?? 'default'}`, { cron, data });
  }),
  unschedule: vi.fn(async (queue: string) => {}),
  send: vi.fn(async (queue: string, data: any, options: any) => {
    sentJobs.push({ queue, data, options });
    return data?.jobId ?? 'mock-pgboss-id';
  }),
  cancel: vi.fn(async (id: string) => { cancelledJobIds.push(id); }),
  getQueueSize: vi.fn(async () => ({ count: 0 })),
};

vi.mock('pg-boss', () => {
  return {
    default: class PgBoss {
      constructor(_url: string) {}
      start = mockBoss.start;
      stop = mockBoss.stop;
      createQueue = mockBoss.createQueue;
      work = mockBoss.work;
      schedule = mockBoss.schedule;
      unschedule = mockBoss.unschedule;
      send = mockBoss.send;
      cancel = mockBoss.cancel;
      getQueueSize = mockBoss.getQueueSize;
    },
  };
});

// ─── Mock config ──────────────────────────────────────

const mockConfig = {
  profile: 'balanced',
  providers: {
    llm: 'anthropic', memory: 'file', scanner: 'basic',
    channels: ['cli'], web: 'none', browser: 'none',
    credentials: 'env', skills: 'readonly', audit: 'file',
    sandbox: 'subprocess', scheduler: 'pgboss',
  },
  sandbox: { timeout_sec: 120, memory_mb: 512 },
  scheduler: {
    active_hours: { start: '00:00', end: '23:59', timezone: 'UTC' },
    max_token_budget: 4096,
    heartbeat_interval_min: 30,
    pgboss_url: 'postgres://test:test@localhost:5432/ax_test',
  },
  history: { max_turns: 50, thread_context_turns: 5 },
} as Config;

// ─── Import after mock ───────────────────────────────

import { create } from '../../../src/providers/scheduler/pgboss.js';

// ═══════════════════════════════════════════════════════

describe('scheduler-pgboss', () => {
  let stopFn: (() => Promise<void>) | null = null;

  beforeEach(() => {
    workHandler = null;
    scheduledQueues.clear();
    sentJobs.length = 0;
    createdQueues.clear();
    cancelledJobIds.length = 0;
    vi.clearAllMocks();
  });

  afterEach(async () => {
    if (stopFn) {
      await stopFn();
      stopFn = null;
    }
  });

  // ─── Lifecycle ──────────────────────────────────────

  test('start() calls boss.start() and registers work handler', async () => {
    const scheduler = await create(mockConfig);
    await scheduler.start(() => {});
    stopFn = () => scheduler.stop();

    expect(mockBoss.start).toHaveBeenCalledOnce();
    expect(mockBoss.work).toHaveBeenCalled();
  });

  test('stop() calls boss.stop()', async () => {
    const scheduler = await create(mockConfig);
    await scheduler.start(() => {});
    await scheduler.stop();

    expect(mockBoss.stop).toHaveBeenCalledOnce();
  });

  // ─── addCron ────────────────────────────────────────

  test('addCron creates a pg-boss schedule', async () => {
    const scheduler = await create(mockConfig);
    await scheduler.start(() => {});
    stopFn = () => scheduler.stop();

    scheduler.addCron!({
      id: 'job-1',
      schedule: '*/5 * * * *',
      agentId: 'assistant',
      prompt: 'Check updates',
    });

    // Should have called boss.schedule with the cron expression
    expect(mockBoss.schedule).toHaveBeenCalled();
    const call = mockBoss.schedule.mock.calls[0];
    expect(call[1]).toBe('*/5 * * * *');
    expect(call[2].jobId).toBe('job-1');
    expect(call[2].prompt).toBe('Check updates');
  });

  // ─── removeCron ─────────────────────────────────────

  test('removeCron unschedules the job', async () => {
    const scheduler = await create(mockConfig);
    await scheduler.start(() => {});
    stopFn = () => scheduler.stop();

    scheduler.addCron!({
      id: 'remove-me',
      schedule: '0 * * * *',
      agentId: 'assistant',
      prompt: 'Hourly check',
    });

    scheduler.removeCron!('remove-me');

    expect(mockBoss.unschedule).toHaveBeenCalled();
  });

  // ─── listJobs ───────────────────────────────────────

  test('listJobs returns tracked jobs', async () => {
    const scheduler = await create(mockConfig);
    await scheduler.start(() => {});
    stopFn = () => scheduler.stop();

    scheduler.addCron!({
      id: 'list-job',
      schedule: '0 9 * * *',
      agentId: 'assistant',
      prompt: 'Morning check',
    });

    const jobs = scheduler.listJobs!();
    expect(jobs).toHaveLength(1);
    expect(jobs[0].id).toBe('list-job');
  });

  // ─── scheduleOnce ──────────────────────────────────

  test('scheduleOnce sends a delayed job via boss.send with startAfter', async () => {
    const scheduler = await create(mockConfig);
    await scheduler.start(() => {});
    stopFn = () => scheduler.stop();

    const fireAt = new Date(Date.now() + 60_000);
    scheduler.scheduleOnce!({
      id: 'once-job',
      schedule: '0 0 1 1 *',
      agentId: 'assistant',
      prompt: 'One-shot task',
      runOnce: true,
    }, fireAt);

    expect(mockBoss.send).toHaveBeenCalled();
    const sendCall = mockBoss.send.mock.calls[0];
    expect(sendCall[1].jobId).toBe('once-job');
    expect(sendCall[2].startAfter).toEqual(fireAt);
  });

  // ─── Job execution (work handler) ──────────────────

  test('work handler converts pg-boss job to InboundMessage', async () => {
    const scheduler = await create(mockConfig);
    const received: InboundMessage[] = [];

    await scheduler.start((msg) => { received.push(msg); });
    stopFn = () => scheduler.stop();

    // Simulate pg-boss delivering a job
    expect(workHandler).not.toBeNull();
    await workHandler!([{
      id: 'pgboss-internal-id',
      data: {
        jobId: 'cron-123',
        agentId: 'assistant',
        prompt: 'Do the thing',
        schedule: '*/5 * * * *',
      },
    }]);

    expect(received).toHaveLength(1);
    expect(received[0].sender).toBe('cron:cron-123');
    expect(received[0].content).toBe('Do the thing');
    expect(received[0].session.provider).toBe('scheduler');
  });

  test('work handler for heartbeat job produces heartbeat message', async () => {
    const scheduler = await create(mockConfig);
    const received: InboundMessage[] = [];

    await scheduler.start((msg) => { received.push(msg); });
    stopFn = () => scheduler.stop();

    await workHandler!([{
      id: 'pgboss-hb-id',
      data: {
        jobId: '__heartbeat__',
        isHeartbeat: true,
      },
    }]);

    expect(received).toHaveLength(1);
    expect(received[0].sender).toBe('heartbeat');
    expect(received[0].content).toContain('Heartbeat');
  });

  // ─── Heartbeat schedule ────────────────────────────

  test('start() registers heartbeat schedule', async () => {
    const scheduler = await create(mockConfig);
    await scheduler.start(() => {});
    stopFn = () => scheduler.stop();

    // Should have scheduled a heartbeat cron
    const hbSchedule = mockBoss.schedule.mock.calls.find(
      (c: any[]) => c[2]?.isHeartbeat === true
    );
    expect(hbSchedule).toBeTruthy();
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/providers/scheduler/pgboss.test.ts`
Expected: FAIL — module `../../../src/providers/scheduler/pgboss.js` not found

**Step 3: Implement the pgboss scheduler provider**

Create `src/providers/scheduler/pgboss.ts`:

```typescript
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import PgBoss from 'pg-boss';
import type { SchedulerProvider, CronJobDef } from './types.js';
import type { InboundMessage } from '../channel/types.js';
import type { Config } from '../../types.js';
import {
  type ActiveHours,
  schedulerSession, parseTime, isWithinActiveHours,
} from './utils.js';

const QUEUE_NAME = 'ax-scheduler';

// Convert heartbeat interval (minutes) to a cron expression.
// pg-boss schedule() needs a cron string — we approximate to the nearest minute.
function heartbeatCron(intervalMin: number): string {
  const mins = Math.max(1, Math.round(intervalMin));
  if (mins === 1) return '* * * * *';
  if (mins <= 59) return `*/${mins} * * * *`;
  // For intervals >= 60 min, fire on the hour every N hours
  const hours = Math.round(mins / 60);
  return `0 */${Math.max(1, hours)} * * *`;
}

export async function create(config: Config): Promise<SchedulerProvider> {
  const pgUrl = config.scheduler.pgboss_url ?? process.env.DATABASE_URL;
  if (!pgUrl) {
    throw new Error('pgboss scheduler requires pgboss_url in config or DATABASE_URL env var');
  }

  const boss = new PgBoss(pgUrl);
  let onMessageHandler: ((msg: InboundMessage) => void) | null = null;

  // Local job registry — mirrors what's scheduled in pg-boss so listJobs() works
  // without querying the database.
  const jobRegistry = new Map<string, CronJobDef>();

  const activeHours: ActiveHours = {
    start: parseTime(config.scheduler.active_hours.start),
    end: parseTime(config.scheduler.active_hours.end),
    timezone: config.scheduler.active_hours.timezone,
  };

  const agentDir = config.scheduler.agent_dir;

  function getHeartbeatContent(): string {
    let content = 'Heartbeat check — review pending tasks and proactive hints.';
    if (agentDir) {
      try {
        const md = readFileSync(join(agentDir, 'HEARTBEAT.md'), 'utf-8');
        if (md.trim()) content = md;
      } catch { /* no HEARTBEAT.md — use default */ }
    }
    return content;
  }

  async function handleJob(jobs: { id: string; data: any }[]): Promise<void> {
    if (!onMessageHandler) return;

    for (const job of jobs) {
      const data = job.data;

      // Active hours gate
      if (!isWithinActiveHours(activeHours)) return;

      if (data.isHeartbeat) {
        onMessageHandler({
          id: randomUUID(),
          session: schedulerSession('heartbeat'),
          sender: 'heartbeat',
          content: getHeartbeatContent(),
          attachments: [],
          timestamp: new Date(),
        });
        continue;
      }

      // Regular cron or one-shot job
      const jobId = data.jobId ?? job.id;
      onMessageHandler({
        id: randomUUID(),
        session: schedulerSession(`cron:${jobId}`),
        sender: `cron:${jobId}`,
        content: data.prompt,
        attachments: [],
        timestamp: new Date(),
      });

      // Clean up runOnce jobs from local registry
      if (data.runOnce) {
        jobRegistry.delete(jobId);
      }
    }
  }

  return {
    async start(onMessage: (msg: InboundMessage) => void): Promise<void> {
      onMessageHandler = onMessage;
      await boss.start();
      await boss.createQueue(QUEUE_NAME);
      await boss.work(QUEUE_NAME, { batchSize: 1 }, handleJob);

      // Register heartbeat schedule
      const hbCron = heartbeatCron(config.scheduler.heartbeat_interval_min);
      await boss.schedule(QUEUE_NAME, hbCron, {
        jobId: '__heartbeat__',
        isHeartbeat: true,
      });
    },

    async stop(): Promise<void> {
      onMessageHandler = null;
      await boss.stop();
    },

    addCron(job: CronJobDef): void {
      jobRegistry.set(job.id, job);
      boss.schedule(QUEUE_NAME, job.schedule, {
        jobId: job.id,
        agentId: job.agentId,
        prompt: job.prompt,
        schedule: job.schedule,
        maxTokenBudget: job.maxTokenBudget,
        delivery: job.delivery,
        runOnce: job.runOnce,
      });
    },

    removeCron(jobId: string): void {
      jobRegistry.delete(jobId);
      // Unschedule by name — pg-boss uses the queue+data combo.
      // We cancel any pending jobs and remove the schedule.
      boss.unschedule(QUEUE_NAME);
      // Re-register remaining schedules
      for (const j of jobRegistry.values()) {
        boss.schedule(QUEUE_NAME, j.schedule, {
          jobId: j.id,
          agentId: j.agentId,
          prompt: j.prompt,
          schedule: j.schedule,
          maxTokenBudget: j.maxTokenBudget,
          delivery: j.delivery,
          runOnce: j.runOnce,
        });
      }
    },

    listJobs(): CronJobDef[] {
      return [...jobRegistry.values()];
    },

    scheduleOnce(job: CronJobDef, fireAt: Date): void {
      jobRegistry.set(job.id, job);
      boss.send(QUEUE_NAME, {
        jobId: job.id,
        agentId: job.agentId,
        prompt: job.prompt,
        schedule: job.schedule,
        maxTokenBudget: job.maxTokenBudget,
        delivery: job.delivery,
        runOnce: true,
      }, {
        startAfter: fireAt,
        singletonKey: job.id,
      });
    },
  };
}
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/providers/scheduler/pgboss.test.ts`
Expected: All PASS

**Step 5: Commit**

```bash
git add src/providers/scheduler/pgboss.ts tests/providers/scheduler/pgboss.test.ts
git commit -m "feat(scheduler): add pgboss scheduler tier backed by pg-boss"
```

---

### Task 4: Register pgboss in provider map

**Files:**
- Modify: `src/host/provider-map.ts:66-70`

**Step 1: Add pgboss to the scheduler allowlist**

```typescript
  scheduler: {
    none: '../providers/scheduler/none.js',
    cron: '../providers/scheduler/cron.js',
    full: '../providers/scheduler/full.js',
    pgboss: '../providers/scheduler/pgboss.js',
  },
```

**Step 2: Run existing provider-map tests (if any) + build**

Run: `npm run build`
Expected: Clean compilation

**Step 3: Commit**

```bash
git add src/host/provider-map.ts
git commit -m "feat(scheduler): register pgboss in provider allowlist"
```

---

### Task 5: Verify existing scheduler tests still pass

**Files:** None modified — validation only.

**Step 1: Run all scheduler tests**

Run: `npx vitest run tests/providers/scheduler/`
Expected: All existing `full.test.ts`, `cron.test.ts`, `utils.test.ts` tests still PASS alongside new `pgboss.test.ts`

**Step 2: Run full test suite**

Run: `npm test`
Expected: No regressions

**Step 3: Commit (if any fixups needed)**

---

### Task 6: Add removeCron with per-job schedule names

The initial `removeCron` implementation above unschedules the entire queue and re-registers all remaining jobs. This works but is not ideal. pg-boss `schedule()` uses a schedule name — we should use `ax-sched:{jobId}` as distinct schedule names so each job can be independently unscheduled.

**Files:**
- Modify: `src/providers/scheduler/pgboss.ts`
- Modify: `tests/providers/scheduler/pgboss.test.ts`

**Step 1: Write test for independent schedule removal**

Add to `tests/providers/scheduler/pgboss.test.ts`:

```typescript
  test('removeCron only unschedules the specific job', async () => {
    const scheduler = await create(mockConfig);
    await scheduler.start(() => {});
    stopFn = () => scheduler.stop();

    scheduler.addCron!({
      id: 'keep-me',
      schedule: '0 9 * * *',
      agentId: 'assistant',
      prompt: 'Morning',
    });

    scheduler.addCron!({
      id: 'remove-me',
      schedule: '0 17 * * *',
      agentId: 'assistant',
      prompt: 'Evening',
    });

    scheduler.removeCron!('remove-me');

    const jobs = scheduler.listJobs!();
    expect(jobs).toHaveLength(1);
    expect(jobs[0].id).toBe('keep-me');

    // Unschedule should have been called with the specific schedule name
    const unschedCalls = mockBoss.unschedule.mock.calls;
    expect(unschedCalls.some((c: any[]) => c[0].includes('remove-me'))).toBe(true);
  });
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/providers/scheduler/pgboss.test.ts`
Expected: FAIL — unschedule called with generic queue name, not per-job name

**Step 3: Refactor to use per-job schedule names**

Update `src/providers/scheduler/pgboss.ts` — change `addCron` and `removeCron` to use `ax-sched:{jobId}` as the schedule queue name:

```typescript
    addCron(job: CronJobDef): void {
      jobRegistry.set(job.id, job);
      const schedName = `ax-sched:${job.id}`;
      boss.createQueue(schedName);
      boss.schedule(schedName, job.schedule, {
        jobId: job.id,
        agentId: job.agentId,
        prompt: job.prompt,
        schedule: job.schedule,
        maxTokenBudget: job.maxTokenBudget,
        delivery: job.delivery,
        runOnce: job.runOnce,
      });
      // Also register a worker for this queue
      boss.work(schedName, { batchSize: 1 }, handleJob);
    },

    removeCron(jobId: string): void {
      jobRegistry.delete(jobId);
      const schedName = `ax-sched:${jobId}`;
      boss.unschedule(schedName);
    },
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/providers/scheduler/pgboss.test.ts`
Expected: All PASS

**Step 5: Commit**

```bash
git add src/providers/scheduler/pgboss.ts tests/providers/scheduler/pgboss.test.ts
git commit -m "refactor(scheduler): use per-job schedule names for independent unschedule"
```

---

### Task 7: Full suite validation and build

**Step 1: Build**

Run: `npm run build`
Expected: Clean compilation, no errors

**Step 2: Run all tests**

Run: `npm test`
Expected: All tests pass, zero regressions

**Step 3: Final commit if any fixups**

```bash
git add -A
git commit -m "chore: fix any build/test issues from pgboss tier"
```

---

## Summary

After all tasks, the codebase has:

- `src/providers/scheduler/pgboss.ts` — new pg-boss backed scheduler
- `tests/providers/scheduler/pgboss.test.ts` — unit tests with mocked pg-boss
- `src/types.ts` — `pgboss_url` optional config field
- `src/host/provider-map.ts` — `pgboss` in scheduler allowlist

To use in production: set `providers.scheduler: pgboss` in `ax.yaml` and provide `DATABASE_URL` or `scheduler.pgboss_url`.

Existing `none`, `cron`, and `full` tiers are completely untouched.
