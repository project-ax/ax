# HEARTBEAT.md & Scheduler IPC Tools Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Give agents a HEARTBEAT.md checklist that drives periodic heartbeat behavior, add heartbeat-state.json tracking, expose scheduler IPC tools (add/remove/list cron), and add a HeartbeatModule to the system prompt so agents understand how to respond to heartbeat messages.

**Architecture:** HEARTBEAT.md lives in the agent's identity directory (`~/.ax/agents/<name>/`), loaded by the scheduler provider on each heartbeat tick and injected as message content. Agents respond `HEARTBEAT_OK` if nothing needs action. A `heartbeat-state.json` file tracks last-run timestamps per check. Three new IPC actions (`scheduler_add_cron`, `scheduler_remove_cron`, `scheduler_list_jobs`) let agents manage their own cron jobs at runtime.

**Tech Stack:** TypeScript, Zod v4, @sinclair/typebox, vitest

---

### Task 1: Create HEARTBEAT.md Template

**Files:**
- Create: `templates/HEARTBEAT.md`

**Step 1: Create the default heartbeat template**

```markdown
# Heartbeat Checklist

<!--
  This file controls what you check on each heartbeat tick.
  Each item has a cadence (how often to run) and a description.
  On each heartbeat, review the list, check items that are overdue,
  and respond HEARTBEAT_OK if nothing needs attention.
  Keep this concise — 5-10 items max. Heartbeats run frequently.
-->

## Checks

- **memory-review** (every 4h): Review recent memories for patterns worth consolidating
- **pending-tasks** (every 1h): Check if there are any pending tasks or queued identity changes awaiting review
```

**Step 2: Commit**

```bash
git add templates/HEARTBEAT.md
git commit -m "feat: add default HEARTBEAT.md template"
```

---

### Task 2: Load HEARTBEAT.md in Identity Loader

**Files:**
- Modify: `src/agent/identity-loader.ts` (add heartbeat to loadIdentityFiles)
- Modify: `src/agent/prompt/types.ts` (add heartbeat to IdentityFiles)
- Test: `tests/agent/identity-loader.test.ts`

**Step 1: Write the failing test**

In the existing identity-loader test file, add a test that verifies `loadIdentityFiles` returns a `heartbeat` field when `HEARTBEAT.md` exists in agentDir:

```typescript
it('loads HEARTBEAT.md into heartbeat field', () => {
  writeFileSync(join(agentDir, 'HEARTBEAT.md'), '# Heartbeat\n- check stuff');
  const files = loadIdentityFiles({ agentDir });
  expect(files.heartbeat).toBe('# Heartbeat\n- check stuff');
});

it('returns empty string when HEARTBEAT.md is absent', () => {
  const files = loadIdentityFiles({ agentDir });
  expect(files.heartbeat).toBe('');
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/agent/identity-loader.test.ts`
Expected: FAIL — `heartbeat` property doesn't exist on IdentityFiles

**Step 3: Add heartbeat to IdentityFiles type**

In `src/agent/prompt/types.ts`, add to the `IdentityFiles` interface:

```typescript
export interface IdentityFiles {
  agents: string;
  soul: string;
  identity: string;
  user: string;
  bootstrap: string;
  userBootstrap: string;
  heartbeat: string;      // <-- ADD THIS
}
```

**Step 4: Load HEARTBEAT.md in identity-loader.ts**

In `src/agent/identity-loader.ts`, inside `loadIdentityFiles()`, add alongside the other file reads:

```typescript
heartbeat: safeRead(join(dir, 'HEARTBEAT.md')),
```

Where `safeRead` is the existing helper that returns `''` on error.

**Step 5: Run test to verify it passes**

Run: `npx vitest run tests/agent/identity-loader.test.ts`
Expected: PASS

**Step 6: Commit**

```bash
git add src/agent/prompt/types.ts src/agent/identity-loader.ts tests/agent/identity-loader.test.ts
git commit -m "feat: load HEARTBEAT.md in identity loader"
```

---

### Task 3: Heartbeat State Tracking

**Files:**
- Create: `src/agent/heartbeat-state.ts`
- Test: `tests/agent/heartbeat-state.test.ts`

**Step 1: Write the failing tests**

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { HeartbeatState } from '../../src/agent/heartbeat-state.js';

describe('HeartbeatState', () => {
  let dir: string;
  let state: HeartbeatState;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'hb-state-'));
    state = new HeartbeatState(dir);
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('returns null for unknown check', () => {
    expect(state.lastRun('memory-review')).toBeNull();
  });

  it('records and retrieves last run time', () => {
    const now = Date.now();
    state.markRun('memory-review', now);
    expect(state.lastRun('memory-review')).toBe(now);
  });

  it('persists state to disk', () => {
    state.markRun('memory-review', 1000);
    const state2 = new HeartbeatState(dir);
    expect(state2.lastRun('memory-review')).toBe(1000);
  });

  it('isOverdue returns true when never run', () => {
    expect(state.isOverdue('memory-review', 60)).toBe(true);
  });

  it('isOverdue returns false when recently run', () => {
    state.markRun('memory-review', Date.now());
    expect(state.isOverdue('memory-review', 60)).toBe(false);
  });

  it('isOverdue returns true when cadence exceeded', () => {
    state.markRun('memory-review', Date.now() - 120 * 60 * 1000);
    expect(state.isOverdue('memory-review', 60)).toBe(true);
  });

  it('formats summary with overdue status', () => {
    state.markRun('a', Date.now());
    state.markRun('b', Date.now() - 300 * 60 * 1000);
    const summary = state.summarize({ a: 60, b: 120 });
    expect(summary).toContain('a');
    expect(summary).toContain('b');
    expect(summary).toMatch(/b.*overdue/i);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/agent/heartbeat-state.test.ts`
Expected: FAIL — module not found

**Step 3: Implement HeartbeatState**

Create `src/agent/heartbeat-state.ts`:

```typescript
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const STATE_FILE = 'heartbeat-state.json';

export class HeartbeatState {
  private data: Record<string, number> = {};
  private filePath: string;

  constructor(dir: string) {
    this.filePath = join(dir, STATE_FILE);
    try {
      this.data = JSON.parse(readFileSync(this.filePath, 'utf-8'));
    } catch { /* first run or corrupt — start fresh */ }
  }

  lastRun(checkName: string): number | null {
    return this.data[checkName] ?? null;
  }

  markRun(checkName: string, timestamp: number = Date.now()): void {
    this.data[checkName] = timestamp;
    this.persist();
  }

  isOverdue(checkName: string, cadenceMinutes: number): boolean {
    const last = this.data[checkName];
    if (last == null) return true;
    return (Date.now() - last) >= cadenceMinutes * 60 * 1000;
  }

  /** Human-readable summary for injection into heartbeat prompt. */
  summarize(cadences: Record<string, number>): string {
    const lines: string[] = [];
    for (const [name, cadenceMin] of Object.entries(cadences)) {
      const last = this.data[name];
      const overdue = this.isOverdue(name, cadenceMin);
      if (!last) {
        lines.push(`- **${name}** (every ${cadenceMin}m): never run — OVERDUE`);
      } else {
        const ago = Math.round((Date.now() - last) / 60_000);
        const status = overdue ? 'OVERDUE' : 'ok';
        lines.push(`- **${name}** (every ${cadenceMin}m): last run ${ago}m ago — ${status}`);
      }
    }
    return lines.join('\n');
  }

  private persist(): void {
    try {
      mkdirSync(join(this.filePath, '..'), { recursive: true });
      writeFileSync(this.filePath, JSON.stringify(this.data, null, 2));
    } catch { /* best-effort persistence */ }
  }
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/agent/heartbeat-state.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/agent/heartbeat-state.ts tests/agent/heartbeat-state.test.ts
git commit -m "feat: add HeartbeatState tracker for overdue check detection"
```

---

### Task 4: Inject HEARTBEAT.md Content into Heartbeat Messages

**Files:**
- Modify: `src/providers/scheduler/cron.ts` (load HEARTBEAT.md, inject content)
- Modify: `src/providers/scheduler/full.ts` (same)
- Modify: `src/providers/scheduler/types.ts` (add agentDir to SchedulerProvider.start or create config)
- Modify: `tests/providers/scheduler/cron.test.ts`
- Modify: `tests/providers/scheduler/full.test.ts`

**Step 1: Write failing tests**

In `tests/providers/scheduler/cron.test.ts`, add:

```typescript
it('heartbeat message includes HEARTBEAT.md content when file exists', async () => {
  // Create agentDir with HEARTBEAT.md
  const agentDir = mkdtempSync(join(tmpdir(), 'hb-'));
  writeFileSync(join(agentDir, 'HEARTBEAT.md'), '# Checks\n- review emails (every 2h)');

  const config = makeConfig({ agentDir });
  const sched = await create(config);
  const messages: InboundMessage[] = [];
  await sched.start(msg => messages.push(msg));

  // Trigger heartbeat manually via timer or exposed method
  // ... (use vi.advanceTimersByTime or similar)

  expect(messages[0].content).toContain('# Checks');
  expect(messages[0].content).toContain('review emails');

  await sched.stop();
  rmSync(agentDir, { recursive: true, force: true });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/providers/scheduler/cron.test.ts`
Expected: FAIL — config has no agentDir, content is still the generic string

**Step 3: Add agentDir to scheduler config**

In `src/types.ts`, add `agent_dir?: string` to the scheduler config block. In `src/config.ts`, add it as optional to the Zod schema:

```typescript
agent_dir: z.string().optional(),
```

**Step 4: Update fireHeartbeat in cron.ts and full.ts**

Read `HEARTBEAT.md` from `config.scheduler.agent_dir` on each tick. If present, use it as message content. If absent, use fallback text. Also instantiate `HeartbeatState` and include the overdue summary.

In `cron.ts` `fireHeartbeat()`:

```typescript
function fireHeartbeat(): void {
  if (!onMessageHandler) return;
  if (!isWithinActiveHours(activeHours)) return;

  let content = 'Heartbeat check — review pending tasks and proactive hints.';
  if (agentDir) {
    try {
      const md = readFileSync(join(agentDir, 'HEARTBEAT.md'), 'utf-8');
      if (md.trim()) {
        const stateSummary = heartbeatState.summarize(parseCadences(md));
        content = `${md}\n\n## Current Status\n${stateSummary}`;
      }
    } catch { /* no HEARTBEAT.md — use default */ }
  }

  onMessageHandler({
    id: randomUUID(),
    session: schedulerSession('heartbeat'),
    sender: 'heartbeat',
    content,
    attachments: [],
    timestamp: new Date(),
  });
}
```

**Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/providers/scheduler/`
Expected: PASS

**Step 6: Commit**

```bash
git add src/providers/scheduler/cron.ts src/providers/scheduler/full.ts src/types.ts src/config.ts tests/providers/scheduler/
git commit -m "feat: inject HEARTBEAT.md content into heartbeat messages"
```

---

### Task 5: Pass agentDir to Scheduler in Server

**Files:**
- Modify: `src/host/server.ts` (pass agentDir to scheduler config)

**Step 1: Write failing test or verify integration**

In the server's `startServer()`, the scheduler is started at line 672. The scheduler provider reads `config.scheduler`. We need to set `config.scheduler.agent_dir = agentDirVal` before starting the scheduler.

Add after the `agentDirVal` assignment (around line 127):

```typescript
config.scheduler.agent_dir = agentDirVal;
```

**Step 2: Verify existing server tests still pass**

Run: `npx vitest run tests/host/server.test.ts`
Expected: PASS

**Step 3: Commit**

```bash
git add src/host/server.ts
git commit -m "feat: pass agentDir to scheduler config for HEARTBEAT.md loading"
```

---

### Task 6: Scheduler IPC Schemas

**Files:**
- Modify: `src/ipc-schemas.ts`
- Test: `tests/ipc-schemas.test.ts` (if it exists, add schema validation tests)

**Step 1: Write failing tests**

```typescript
import { SchedulerAddCronSchema, SchedulerRemoveCronSchema, SchedulerListJobsSchema } from '../src/ipc-schemas.js';

describe('scheduler IPC schemas', () => {
  it('SchedulerAddCronSchema accepts valid input', () => {
    const result = SchedulerAddCronSchema.safeParse({
      action: 'scheduler_add_cron',
      schedule: '0 9 * * 1',
      prompt: 'Weekly review',
    });
    expect(result.success).toBe(true);
  });

  it('SchedulerAddCronSchema rejects missing schedule', () => {
    const result = SchedulerAddCronSchema.safeParse({
      action: 'scheduler_add_cron',
      prompt: 'Weekly review',
    });
    expect(result.success).toBe(false);
  });

  it('SchedulerRemoveCronSchema accepts valid input', () => {
    const result = SchedulerRemoveCronSchema.safeParse({
      action: 'scheduler_remove_cron',
      jobId: 'abc-123',
    });
    expect(result.success).toBe(true);
  });

  it('SchedulerListJobsSchema accepts empty body', () => {
    const result = SchedulerListJobsSchema.safeParse({
      action: 'scheduler_list_jobs',
    });
    expect(result.success).toBe(true);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/ipc-schemas.test.ts`
Expected: FAIL — schemas don't exist

**Step 3: Add schemas to ipc-schemas.ts**

```typescript
// ── Scheduler ──────────────────────────────────────────
export const SchedulerAddCronSchema = ipcAction('scheduler_add_cron', {
  schedule: safeString(100),
  prompt: safeString(10_000),
  maxTokenBudget: z.number().int().min(1).optional(),
});

export const SchedulerRemoveCronSchema = ipcAction('scheduler_remove_cron', {
  jobId: safeString(200),
});

export const SchedulerListJobsSchema = ipcAction('scheduler_list_jobs', {});
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/ipc-schemas.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/ipc-schemas.ts tests/ipc-schemas.test.ts
git commit -m "feat: add scheduler IPC schemas (add_cron, remove_cron, list_jobs)"
```

---

### Task 7: Scheduler IPC Handlers

**Files:**
- Modify: `src/host/ipc-server.ts`
- Test: `tests/host/ipc-server.test.ts`

**Step 1: Write failing tests**

Add tests for the 3 new scheduler IPC actions. Follow the existing handler test patterns in the file:

```typescript
describe('scheduler_add_cron', () => {
  it('adds a cron job and returns the job id', async () => {
    const result = await handleIPC(JSON.stringify({
      action: 'scheduler_add_cron',
      schedule: '0 9 * * 1',
      prompt: 'Weekly review',
    }), ctx);
    const parsed = JSON.parse(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.jobId).toBeDefined();
  });
});

describe('scheduler_remove_cron', () => {
  it('removes a previously added cron job', async () => {
    // Add first
    const addResult = JSON.parse(await handleIPC(JSON.stringify({
      action: 'scheduler_add_cron',
      schedule: '0 9 * * 1',
      prompt: 'Weekly review',
    }), ctx));

    const result = JSON.parse(await handleIPC(JSON.stringify({
      action: 'scheduler_remove_cron',
      jobId: addResult.jobId,
    }), ctx));
    expect(result.ok).toBe(true);
  });
});

describe('scheduler_list_jobs', () => {
  it('returns empty list initially', async () => {
    const result = JSON.parse(await handleIPC(JSON.stringify({
      action: 'scheduler_list_jobs',
    }), ctx));
    expect(result.ok).toBe(true);
    expect(result.jobs).toEqual([]);
  });

  it('returns added jobs', async () => {
    await handleIPC(JSON.stringify({
      action: 'scheduler_add_cron',
      schedule: '0 9 * * 1',
      prompt: 'Weekly review',
    }), ctx);

    const result = JSON.parse(await handleIPC(JSON.stringify({
      action: 'scheduler_list_jobs',
    }), ctx));
    expect(result.ok).toBe(true);
    expect(result.jobs).toHaveLength(1);
    expect(result.jobs[0].schedule).toBe('0 9 * * 1');
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/host/ipc-server.test.ts`
Expected: FAIL — handlers don't exist

**Step 3: Add handlers to ipc-server.ts**

In the `handlers` object, add:

```typescript
scheduler_add_cron: async (req, ctx) => {
  const jobId = randomUUID();
  const job: CronJobDef = {
    id: jobId,
    schedule: req.schedule,
    agentId: ctx.agentId,
    prompt: req.prompt,
    maxTokenBudget: req.maxTokenBudget,
  };
  providers.scheduler.addCron?.(job);
  await providers.audit.log({
    action: 'scheduler_add_cron',
    args: { jobId, schedule: req.schedule },
    sessionId: ctx.sessionId,
    result: 'success',
    timestamp: new Date(),
    durationMs: 0,
  });
  return { jobId };
},

scheduler_remove_cron: async (req, ctx) => {
  providers.scheduler.removeCron?.(req.jobId);
  await providers.audit.log({
    action: 'scheduler_remove_cron',
    args: { jobId: req.jobId },
    sessionId: ctx.sessionId,
    result: 'success',
    timestamp: new Date(),
    durationMs: 0,
  });
  return { removed: true };
},

scheduler_list_jobs: async () => {
  const jobs = providers.scheduler.listJobs?.() ?? [];
  return { jobs };
},
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/host/ipc-server.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/host/ipc-server.ts tests/host/ipc-server.test.ts
git commit -m "feat: add scheduler IPC handlers (add/remove/list cron)"
```

---

### Task 8: Register Scheduler Tools in Agent IPC Tools (pi-agent-core)

**Files:**
- Modify: `src/agent/ipc-tools.ts`
- Test: `tests/agent/ipc-tools.test.ts`

**Step 1: Write failing tests**

```typescript
it('includes scheduler_add_cron tool', () => {
  const tool = tools.find(t => t.name === 'scheduler_add_cron');
  expect(tool).toBeDefined();
  expect(tool!.description).toContain('cron');
});

it('includes scheduler_remove_cron tool', () => {
  const tool = tools.find(t => t.name === 'scheduler_remove_cron');
  expect(tool).toBeDefined();
});

it('includes scheduler_list_jobs tool', () => {
  const tool = tools.find(t => t.name === 'scheduler_list_jobs');
  expect(tool).toBeDefined();
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/agent/ipc-tools.test.ts`
Expected: FAIL — tools don't exist

**Step 3: Add tools to ipc-tools.ts**

```typescript
{
  name: 'scheduler_add_cron',
  label: 'Add Cron Job',
  description: 'Schedule a recurring task using a 5-field cron expression (minute hour day month weekday). The prompt will be sent to you at each matching time.',
  parameters: Type.Object({
    schedule: Type.String({ description: 'Cron expression, e.g. "0 9 * * 1" for 9am every Monday' }),
    prompt: Type.String({ description: 'The instruction/prompt to execute on each trigger' }),
    maxTokenBudget: Type.Optional(Type.Number({ description: 'Optional max token budget per execution' })),
  }),
  async execute(_id, params) {
    return ipcCall('scheduler_add_cron', params);
  },
},
{
  name: 'scheduler_remove_cron',
  label: 'Remove Cron Job',
  description: 'Remove a previously scheduled cron job by its ID.',
  parameters: Type.Object({
    jobId: Type.String({ description: 'The job ID returned by scheduler_add_cron' }),
  }),
  async execute(_id, params) {
    return ipcCall('scheduler_remove_cron', params);
  },
},
{
  name: 'scheduler_list_jobs',
  label: 'List Cron Jobs',
  description: 'List all currently scheduled cron jobs.',
  parameters: Type.Object({}),
  async execute(_id) {
    return ipcCall('scheduler_list_jobs', {});
  },
},
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/agent/ipc-tools.test.ts`
Expected: PASS (also update tool count assertion if one exists)

**Step 5: Commit**

```bash
git add src/agent/ipc-tools.ts tests/agent/ipc-tools.test.ts
git commit -m "feat: register scheduler IPC tools for pi-agent-core runner"
```

---

### Task 9: Register Scheduler Tools in MCP Server (claude-code)

**Files:**
- Modify: `src/agent/mcp-server.ts`
- Test: `tests/agent/mcp-server.test.ts`

**Step 1: Write failing tests**

```typescript
it('includes scheduler_add_cron tool', () => {
  expect(toolNames).toContain('scheduler_add_cron');
});

it('includes scheduler_remove_cron tool', () => {
  expect(toolNames).toContain('scheduler_remove_cron');
});

it('includes scheduler_list_jobs tool', () => {
  expect(toolNames).toContain('scheduler_list_jobs');
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/agent/mcp-server.test.ts`
Expected: FAIL — tools don't exist

**Step 3: Add tools to mcp-server.ts**

```typescript
tool(
  'scheduler_add_cron',
  'Schedule a recurring task using a 5-field cron expression (minute hour day month weekday). The prompt will be sent to you at each matching time.',
  {
    schedule: z.string().describe('Cron expression, e.g. "0 9 * * 1" for 9am every Monday'),
    prompt: z.string().describe('The instruction/prompt to execute on each trigger'),
    maxTokenBudget: z.number().optional().describe('Optional max token budget per execution'),
  },
  (args) => ipcCall('scheduler_add_cron', args),
),

tool(
  'scheduler_remove_cron',
  'Remove a previously scheduled cron job by its ID.',
  {
    jobId: z.string().describe('The job ID returned by scheduler_add_cron'),
  },
  (args) => ipcCall('scheduler_remove_cron', args),
),

tool(
  'scheduler_list_jobs',
  'List all currently scheduled cron jobs.',
  {},
  () => ipcCall('scheduler_list_jobs', {}),
),
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/agent/mcp-server.test.ts`
Expected: PASS (update tool count assertion)

**Step 5: Commit**

```bash
git add src/agent/mcp-server.ts tests/agent/mcp-server.test.ts
git commit -m "feat: register scheduler MCP tools for claude-code runner"
```

---

### Task 10: Add Heartbeat/Scheduler Module to System Prompt

**Files:**
- Create: `src/agent/prompt/modules/heartbeat.ts`
- Test: `tests/agent/prompt/modules/heartbeat.test.ts`
- Modify: `src/agent/prompt/builder.ts` (register HeartbeatModule)

**Step 1: Write failing tests**

```typescript
import { describe, it, expect } from 'vitest';
import { HeartbeatModule } from '../../../../src/agent/prompt/modules/heartbeat.js';

describe('HeartbeatModule', () => {
  const mod = new HeartbeatModule();

  it('has correct name and priority', () => {
    expect(mod.name).toBe('heartbeat');
    expect(mod.priority).toBeGreaterThan(0);
    expect(mod.priority).toBeLessThan(100);
  });

  it('is optional', () => {
    expect(mod.optional).toBe(true);
  });

  it('shouldInclude returns true when heartbeat content exists', () => {
    const ctx = makeCtx({ identityFiles: { heartbeat: '# Checks\n- stuff' } });
    expect(mod.shouldInclude(ctx)).toBe(true);
  });

  it('shouldInclude returns false when heartbeat is empty', () => {
    const ctx = makeCtx({ identityFiles: { heartbeat: '' } });
    expect(mod.shouldInclude(ctx)).toBe(false);
  });

  it('shouldInclude returns false in bootstrap mode', () => {
    const ctx = makeCtx({
      identityFiles: { heartbeat: '# Checks', soul: '', bootstrap: 'bootstrap stuff' },
    });
    expect(mod.shouldInclude(ctx)).toBe(false);
  });

  it('render includes heartbeat instructions', () => {
    const ctx = makeCtx({ identityFiles: { heartbeat: '# Checks\n- review emails (every 2h)' } });
    const sections = mod.render(ctx);
    const joined = sections.join('\n');
    expect(joined).toContain('HEARTBEAT_OK');
    expect(joined).toContain('scheduler_add_cron');
  });
});
```

(Where `makeCtx` creates a mock `PromptContext` — follow existing test patterns in `tests/agent/prompt/modules/`)

**Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/agent/prompt/modules/heartbeat.test.ts`
Expected: FAIL — module not found

**Step 3: Implement HeartbeatModule**

Create `src/agent/prompt/modules/heartbeat.ts`:

```typescript
import { isBootstrapMode } from '../types.js';
import type { PromptContext, PromptModule } from '../types.js';

export class HeartbeatModule implements PromptModule {
  readonly name = 'heartbeat';
  readonly priority = 80;  // after skills (70), before runtime (90)
  readonly optional = true;

  shouldInclude(ctx: PromptContext): boolean {
    if (isBootstrapMode(ctx)) return false;
    return !!ctx.identityFiles.heartbeat?.trim();
  }

  render(ctx: PromptContext): string[] {
    return [
      '## Heartbeat & Scheduling',
      '',
      'You receive periodic **heartbeat** messages. When one arrives:',
      '1. Review the checklist below',
      '2. For each overdue item, take the appropriate action',
      '3. If nothing needs attention, respond with exactly: `HEARTBEAT_OK`',
      '',
      '### Your Heartbeat Checklist',
      '',
      ctx.identityFiles.heartbeat,
      '',
      '### Scheduling Tools',
      '',
      'You can manage your own recurring tasks:',
      '- `scheduler_add_cron` — schedule a new recurring task (5-field cron expression)',
      '- `scheduler_remove_cron` — remove a scheduled task by ID',
      '- `scheduler_list_jobs` — list all your scheduled tasks',
      '',
      'Example: to check emails every weekday at 9am:',
      '`scheduler_add_cron({ schedule: "0 9 * * 1-5", prompt: "Check and summarize new emails" })`',
    ];
  }

  estimateTokens(ctx: PromptContext): number {
    return Math.ceil((ctx.identityFiles.heartbeat?.length ?? 0) / 4) + 200;
  }

  renderMinimal(ctx: PromptContext): string[] {
    return [
      '## Heartbeat',
      'On heartbeat messages: check the list, act on overdue items, respond HEARTBEAT_OK if nothing needed.',
      ctx.identityFiles.heartbeat,
    ];
  }
}
```

**Step 4: Register in builder.ts**

In `src/agent/prompt/builder.ts`, import HeartbeatModule and add it to the modules array:

```typescript
import { HeartbeatModule } from './modules/heartbeat.js';

// In constructor:
this.modules = [
  new IdentityModule(),
  new InjectionDefenseModule(),
  new SecurityModule(),
  new ContextModule(),
  new SkillsModule(),
  new HeartbeatModule(),     // <-- ADD (priority 80)
  new RuntimeModule(),
].sort((a, b) => a.priority - b.priority);
```

**Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/agent/prompt/modules/heartbeat.test.ts`
Expected: PASS

Run: `npx vitest run tests/agent/prompt/`
Expected: ALL PASS (builder test may need moduleCount update)

**Step 6: Commit**

```bash
git add src/agent/prompt/modules/heartbeat.ts tests/agent/prompt/modules/heartbeat.test.ts src/agent/prompt/builder.ts
git commit -m "feat: add HeartbeatModule to system prompt builder"
```

---

### Task 11: Copy HEARTBEAT.md Template on First Run

**Files:**
- Modify: `src/host/server.ts` (copy template if not exists)

**Step 1: Verify the template copy pattern**

In `server.ts` lines 130-137, existing templates are copied on first run. Add HEARTBEAT.md to this block:

```typescript
// Existing pattern (approximate):
for (const file of ['AGENTS.md', 'BOOTSTRAP.md', 'USER_BOOTSTRAP.md', 'capabilities.yaml']) {
  const dest = join(agentDirVal, file);
  if (!existsSync(dest)) {
    copyFileSync(join(templatesDir, file), dest);
  }
}
```

Add `'HEARTBEAT.md'` to this array.

**Step 2: Run existing server tests**

Run: `npx vitest run tests/host/server.test.ts`
Expected: PASS

**Step 3: Commit**

```bash
git add src/host/server.ts
git commit -m "feat: copy HEARTBEAT.md template to agent dir on first run"
```

---

### Task 12: Mark TODO.md Item Complete & Final Verification

**Files:**
- Modify: `TODO.md`

**Step 1: Run full test suite**

Run: `npm test`
Expected: ALL PASS

**Step 2: Update TODO.md**

Change `[ ] HEARTBEAT.md` to `[x] HEARTBEAT.md`.

**Step 3: Commit**

```bash
git add TODO.md
git commit -m "chore: mark HEARTBEAT.md feature as complete"
```

---

## Verification

After all tasks complete:

1. `npm test` — all tests pass
2. `npm run build` — TypeScript compiles cleanly
3. Check `~/.ax/agents/main/HEARTBEAT.md` exists after server start
4. With `scheduler: cron` or `scheduler: full` in ax.yaml, heartbeat messages should include HEARTBEAT.md content
5. Agent should have `scheduler_add_cron`, `scheduler_remove_cron`, `scheduler_list_jobs` tools available
6. System prompt includes heartbeat instructions when HEARTBEAT.md is non-empty
