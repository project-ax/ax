# Conversation History Persistence — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Persist conversation history server-side so all clients (CLI, Slack, scheduler) get multi-turn context without managing history themselves.

**Architecture:** A new `ConversationStore` class backed by SQLite (`conversations.db`) stores turns keyed by session ID. The server loads history before spawning agents and saves turns after completion. Slack sessions are fixed to use shared session keys (no per-user peer ID in channels/threads). Thread sessions inherit recent channel context. A configurable `max_turns` cap applies globally.

**Tech Stack:** SQLite (via existing `src/utils/sqlite.ts` adapter), Zod for config validation, Vitest for tests.

---

## Design Decisions

### Session Key Changes

The `SessionAddress` for Slack currently includes `peer: user` in channel and thread scopes, which fragments shared conversations into per-user sessions. The fix:

| Scope | Current key | New key |
|---|---|---|
| DM | `slack:dm:T1234:U5678` | `slack:dm:U5678` (drop workspace) |
| Group DM | (not handled) | `slack:group:G5678` |
| Channel | `slack:channel:T1234:C5678:U5678` | `slack:channel:C5678` (drop workspace + peer) |
| Thread | `slack:thread:T1234:C5678:ts:U5678` | `slack:thread:C5678:ts` (drop workspace + peer) |

### Stored Turn Schema

Each turn stores the sender to support multi-user conversations:

```sql
CREATE TABLE turns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  role TEXT NOT NULL,        -- 'user' | 'assistant'
  sender TEXT,               -- user ID (null for assistant)
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX idx_turns_session ON turns(session_id, id);
```

### Config

```yaml
history:
  max_turns: 50              # max turns stored/sent per session (0 = disabled)
  thread_context_turns: 5    # channel turns prepended to thread history
```

### ConversationTurn Extension

The existing `ConversationTurn` (`{ role, content }`) needs a `sender` field for multi-user contexts. The agent stdin payload sends `{ role, content, sender? }` so the agent knows who said what.

---

## Task 1: Add `history` config to Config type and Zod schema

**Files:**
- Modify: `src/types.ts` — add `history` to `Config` interface
- Modify: `src/config.ts` — add `history` to `ConfigSchema` with defaults

**Step 1: Write the failing test**

Create `tests/config-history.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { loadConfig } from '../src/config.js';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('history config', () => {
  const tmpDir = join(tmpdir(), 'ax-config-history-test');

  function writeConfig(yaml: string): string {
    mkdirSync(tmpDir, { recursive: true });
    const p = join(tmpDir, 'ax.yaml');
    writeFileSync(p, yaml);
    return p;
  }

  afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

  it('applies default history settings when history section is omitted', () => {
    const p = writeConfig(`
profile: balanced
providers:
  llm: mock
  memory: file
  scanner: basic
  channels: []
  web: none
  browser: none
  credentials: env
  skills: readonly
  audit: file
  sandbox: subprocess
  scheduler: none
sandbox:
  timeout_sec: 120
  memory_mb: 256
scheduler:
  active_hours: { start: "00:00", end: "23:59", timezone: "UTC" }
  max_token_budget: 4096
  heartbeat_interval_min: 30
`);
    const config = loadConfig(p);
    expect(config.history).toEqual({ max_turns: 50, thread_context_turns: 5 });
  });

  it('accepts explicit history settings', () => {
    const p = writeConfig(`
profile: balanced
providers:
  llm: mock
  memory: file
  scanner: basic
  channels: []
  web: none
  browser: none
  credentials: env
  skills: readonly
  audit: file
  sandbox: subprocess
  scheduler: none
sandbox:
  timeout_sec: 120
  memory_mb: 256
scheduler:
  active_hours: { start: "00:00", end: "23:59", timezone: "UTC" }
  max_token_budget: 4096
  heartbeat_interval_min: 30
history:
  max_turns: 100
  thread_context_turns: 10
`);
    const config = loadConfig(p);
    expect(config.history.max_turns).toBe(100);
    expect(config.history.thread_context_turns).toBe(10);
  });

  it('rejects max_turns less than 0', () => {
    const p = writeConfig(`
profile: balanced
providers:
  llm: mock
  memory: file
  scanner: basic
  channels: []
  web: none
  browser: none
  credentials: env
  skills: readonly
  audit: file
  sandbox: subprocess
  scheduler: none
sandbox:
  timeout_sec: 120
  memory_mb: 256
scheduler:
  active_hours: { start: "00:00", end: "23:59", timezone: "UTC" }
  max_token_budget: 4096
  heartbeat_interval_min: 30
history:
  max_turns: -1
  thread_context_turns: 5
`);
    expect(() => loadConfig(p)).toThrow();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/config-history.test.ts`
Expected: FAIL — `config.history` is undefined / Zod rejects unknown `history` field

**Step 3: Implement**

In `src/types.ts`, add to the `Config` interface:

```typescript
history: {
  max_turns: number;
  thread_context_turns: number;
};
```

In `src/config.ts`, add to `ConfigSchema`:

```typescript
history: z.strictObject({
  max_turns: z.number().int().min(0).max(10000).default(50),
  thread_context_turns: z.number().int().min(0).max(50).default(5),
}).default({ max_turns: 50, thread_context_turns: 5 }),
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/config-history.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/types.ts src/config.ts tests/config-history.test.ts
git commit -m "feat: add history config (max_turns, thread_context_turns)"
```

---

## Task 2: Create `ConversationStore` class

**Files:**
- Create: `src/conversation-store.ts`
- Test: `tests/conversation-store.test.ts`

**Step 1: Write the failing test**

Create `tests/conversation-store.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ConversationStore } from '../src/conversation-store.js';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('ConversationStore', () => {
  const dbPath = join(tmpdir(), `ax-conv-test-${Date.now()}.db`);
  let store: ConversationStore;

  beforeEach(() => {
    store = new ConversationStore(dbPath);
  });

  afterEach(() => {
    store.close();
    rmSync(dbPath, { force: true });
    rmSync(dbPath + '-wal', { force: true });
    rmSync(dbPath + '-shm', { force: true });
  });

  it('stores and retrieves turns for a session', () => {
    store.append('sess1', 'user', 'hello', 'U123');
    store.append('sess1', 'assistant', 'hi there');
    const turns = store.load('sess1');
    expect(turns).toHaveLength(2);
    expect(turns[0]).toMatchObject({ role: 'user', content: 'hello', sender: 'U123' });
    expect(turns[1]).toMatchObject({ role: 'assistant', content: 'hi there', sender: null });
  });

  it('isolates sessions', () => {
    store.append('sess1', 'user', 'msg1');
    store.append('sess2', 'user', 'msg2');
    expect(store.load('sess1')).toHaveLength(1);
    expect(store.load('sess2')).toHaveLength(1);
  });

  it('returns empty array for unknown session', () => {
    expect(store.load('nonexistent')).toEqual([]);
  });

  it('respects maxTurns limit', () => {
    for (let i = 0; i < 10; i++) {
      store.append('sess1', 'user', `msg${i}`);
    }
    const turns = store.load('sess1', 5);
    expect(turns).toHaveLength(5);
    // Should return the LAST 5 turns
    expect(turns[0].content).toBe('msg5');
    expect(turns[4].content).toBe('msg9');
  });

  it('prunes old turns beyond maxTurns on append', () => {
    for (let i = 0; i < 100; i++) {
      store.append('sess1', 'user', `msg${i}`);
    }
    store.prune('sess1', 50);
    // After pruning to 50, should only have the last 50
    const all = store.load('sess1');
    expect(all).toHaveLength(50);
    expect(all[0].content).toBe('msg50');
  });

  it('clears a session', () => {
    store.append('sess1', 'user', 'hello');
    store.clear('sess1');
    expect(store.load('sess1')).toEqual([]);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/conversation-store.test.ts`
Expected: FAIL — module not found

**Step 3: Implement**

Create `src/conversation-store.ts`:

```typescript
import { openDatabase } from './utils/sqlite.js';
import type { SQLiteDatabase } from './utils/sqlite.js';
import { dataFile } from './paths.js';

export interface StoredTurn {
  id: number;
  session_id: string;
  role: 'user' | 'assistant';
  sender: string | null;
  content: string;
  created_at: number;
}

export class ConversationStore {
  private db: SQLiteDatabase;

  constructor(dbPath: string = dataFile('conversations.db')) {
    this.db = openDatabase(dbPath);
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS turns (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        sender TEXT,
        content TEXT NOT NULL,
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
      )
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_turns_session ON turns(session_id, id)
    `);
  }

  /** Append a turn to the session. */
  append(sessionId: string, role: 'user' | 'assistant', content: string, sender?: string): void {
    this.db.prepare(
      'INSERT INTO turns (session_id, role, sender, content) VALUES (?, ?, ?, ?)'
    ).run(sessionId, role, sender ?? null, content);
  }

  /** Load the last `maxTurns` turns for a session (oldest first). */
  load(sessionId: string, maxTurns?: number): StoredTurn[] {
    if (maxTurns !== undefined && maxTurns > 0) {
      // Subquery to get the last N rows by id desc, then re-order asc
      return this.db.prepare(`
        SELECT * FROM (
          SELECT id, session_id, role, sender, content, created_at
          FROM turns WHERE session_id = ? ORDER BY id DESC LIMIT ?
        ) ORDER BY id ASC
      `).all(sessionId, maxTurns) as StoredTurn[];
    }
    return this.db.prepare(
      'SELECT id, session_id, role, sender, content, created_at FROM turns WHERE session_id = ? ORDER BY id ASC'
    ).all(sessionId) as StoredTurn[];
  }

  /** Delete turns older than the last `keep` for a session. */
  prune(sessionId: string, keep: number): void {
    this.db.prepare(`
      DELETE FROM turns WHERE session_id = ? AND id NOT IN (
        SELECT id FROM turns WHERE session_id = ? ORDER BY id DESC LIMIT ?
      )
    `).run(sessionId, sessionId, keep);
  }

  /** Clear all turns for a session. */
  clear(sessionId: string): void {
    this.db.prepare('DELETE FROM turns WHERE session_id = ?').run(sessionId);
  }

  close(): void {
    this.db.close();
  }
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/conversation-store.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/conversation-store.ts tests/conversation-store.test.ts
git commit -m "feat: add ConversationStore for persistent conversation history"
```

---

## Task 3: Fix Slack `buildSession` — remove peer from channels/threads, drop workspace, add group DM support

**Files:**
- Modify: `src/providers/channel/slack.ts` — fix `buildSession()`
- Modify: `tests/` — add/update tests for session addressing

**Step 1: Write the failing test**

Create `tests/providers/channel/slack-session.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { canonicalize } from '../../../src/providers/channel/types.js';
import type { SessionAddress } from '../../../src/providers/channel/types.js';

describe('Slack session addressing', () => {
  it('DM session is scoped to peer only (no workspace)', () => {
    const addr: SessionAddress = {
      provider: 'slack', scope: 'dm',
      identifiers: { peer: 'U5678' },
    };
    expect(canonicalize(addr)).toBe('slack:dm:U5678');
  });

  it('channel session has no peer ID', () => {
    const addr: SessionAddress = {
      provider: 'slack', scope: 'channel',
      identifiers: { channel: 'C1234' },
    };
    expect(canonicalize(addr)).toBe('slack:channel:C1234');
  });

  it('thread session has no peer ID', () => {
    const addr: SessionAddress = {
      provider: 'slack', scope: 'thread',
      identifiers: { channel: 'C1234', thread: '1709.5678' },
    };
    expect(canonicalize(addr)).toBe('slack:thread:C1234:1709.5678');
  });

  it('group DM session is scoped to channel ID', () => {
    const addr: SessionAddress = {
      provider: 'slack', scope: 'group',
      identifiers: { channel: 'G9999' },
    };
    expect(canonicalize(addr)).toBe('slack:group:G9999');
  });

  it('two users in same channel produce identical session keys', () => {
    const addr1: SessionAddress = {
      provider: 'slack', scope: 'channel',
      identifiers: { channel: 'C1234' },
    };
    const addr2: SessionAddress = {
      provider: 'slack', scope: 'channel',
      identifiers: { channel: 'C1234' },
    };
    expect(canonicalize(addr1)).toBe(canonicalize(addr2));
  });

  it('thread session has parent pointing to channel session', () => {
    const addr: SessionAddress = {
      provider: 'slack', scope: 'thread',
      identifiers: { channel: 'C1234', thread: '1709.5678' },
      parent: {
        provider: 'slack', scope: 'channel',
        identifiers: { channel: 'C1234' },
      },
    };
    // Parent should canonicalize to the shared channel session
    expect(canonicalize(addr.parent!)).toBe('slack:channel:C1234');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/providers/channel/slack-session.test.ts`
Expected: FAIL — current buildSession includes peer and workspace in canonicalized keys

**Step 3: Implement**

In `src/providers/channel/slack.ts`, rewrite `buildSession()`:

```typescript
function buildSession(
  user: string,
  channel: string,
  threadTs?: string,
  channelType?: string,
): SessionAddress {
  // DMs: scoped per user
  if (channelType === 'im') {
    return {
      provider: 'slack',
      scope: 'dm',
      identifiers: { peer: user },
    };
  }

  // Group DMs (multi-party): scoped per group channel
  if (channelType === 'mpim') {
    return {
      provider: 'slack',
      scope: 'group',
      identifiers: { channel },
    };
  }

  // Thread: own session with parent pointing to channel
  if (threadTs) {
    return {
      provider: 'slack',
      scope: 'thread',
      identifiers: { channel, thread: threadTs },
      parent: {
        provider: 'slack',
        scope: 'channel',
        identifiers: { channel },
      },
    };
  }

  // Channel: shared across all users
  return {
    provider: 'slack',
    scope: 'channel',
    identifiers: { channel },
  };
}
```

Update the `app.message` handler to pass `channel_type` and also handle `mpim`:

```typescript
app.message(async ({ message }) => {
  const msg = message as SlackMessage;
  if (!msg.text || !msg.user) return;
  if (msg.user === botUserId) return;
  if (!messageHandler) return;

  // Process DMs and group DMs here; channels handled by app_mention
  if (msg.channel_type !== 'im' && msg.channel_type !== 'mpim') return;

  await messageHandler({
    id: msg.ts,
    session: buildSession(msg.user, msg.channel, msg.thread_ts, msg.channel_type),
    sender: msg.user,
    content: msg.text,
    attachments: buildAttachments(msg.files),
    timestamp: new Date(parseFloat(msg.ts) * 1000),
    replyTo: msg.thread_ts,
    raw: message,
  });
});
```

Update the `app_mention` handler — pass `undefined` for channelType (channels always come through app_mention):

```typescript
app.event('app_mention', async ({ event }) => {
  // ... existing validation ...
  await messageHandler({
    id: event.ts,
    session: buildSession(event.user, event.channel, event.thread_ts ?? event.ts),
    sender: event.user,
    content: text,
    attachments: buildAttachments((event as any).files),
    timestamp: new Date(parseFloat(event.ts) * 1000),
    replyTo: event.thread_ts,
    raw: event,
  });
});
```

Note: `app_mention` doesn't have `channel_type`, but it's always a channel context (never DM/MPIM), so `buildSession` defaults to channel/thread scope when `channelType` is undefined.

**Step 4: Run tests**

Run: `npx vitest run tests/providers/channel/slack-session.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/providers/channel/slack.ts tests/providers/channel/slack-session.test.ts
git commit -m "fix: remove peer/workspace from channel/thread session keys, add group DM support"
```

---

## Task 4: Extend `ConversationTurn` and stdin payload with `sender` field

**Files:**
- Modify: `src/agent/runner.ts` — add `sender` to `ConversationTurn` and `StdinPayload` parsing
- Modify: `src/providers/memory/types.ts` — add `sender` to its `ConversationTurn`
- Test: `tests/agent/runner-history.test.ts`

**Step 1: Write the failing test**

Create `tests/agent/runner-history.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { parseStdinPayload, historyToPiMessages } from '../src/agent/runner.js';
import type { ConversationTurn } from '../src/agent/runner.js';

describe('ConversationTurn with sender', () => {
  it('parseStdinPayload preserves sender field', () => {
    const payload = JSON.stringify({
      message: 'hi',
      history: [
        { role: 'user', content: 'hello', sender: 'U123' },
        { role: 'assistant', content: 'hey' },
      ],
      taintRatio: 0, taintThreshold: 1, profile: 'balanced', sandboxType: 'subprocess',
    });
    const result = parseStdinPayload(payload);
    expect(result.history[0].sender).toBe('U123');
    expect(result.history[1].sender).toBeUndefined();
  });

  it('historyToPiMessages includes sender in user message content for multi-user context', () => {
    const history: ConversationTurn[] = [
      { role: 'user', content: 'hello', sender: 'U123' },
      { role: 'user', content: 'world', sender: 'U456' },
    ];
    const msgs = historyToPiMessages(history);
    // User messages from different senders should be distinguishable
    expect(msgs[0].content).toContain('U123');
    expect(msgs[1].content).toContain('U456');
  });

  it('historyToPiMessages omits sender prefix when sender is absent', () => {
    const history: ConversationTurn[] = [
      { role: 'user', content: 'hello' },
    ];
    const msgs = historyToPiMessages(history);
    expect(msgs[0].content).toBe('hello');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/agent/runner-history.test.ts`
Expected: FAIL — `sender` not in `ConversationTurn`

**Step 3: Implement**

In `src/agent/runner.ts`:

```typescript
export interface ConversationTurn {
  role: 'user' | 'assistant';
  content: string;
  sender?: string;  // user ID for multi-user contexts
}
```

Update `historyToPiMessages` to prefix user messages with sender when present:

```typescript
export function historyToPiMessages(history: ConversationTurn[]): AgentMessage[] {
  return history.map((turn): AgentMessage => {
    if (turn.role === 'user') {
      // Prefix with sender ID for multi-user conversations
      const content = turn.sender ? `[${turn.sender}]: ${turn.content}` : turn.content;
      return {
        role: 'user',
        content,
        timestamp: Date.now(),
      } satisfies UserMessage;
    }
    return {
      role: 'assistant',
      content: [{ type: 'text', text: turn.content }],
      api: 'anthropic-messages',
      provider: 'anthropic',
      model: DEFAULT_MODEL_ID,
      usage: { inputTokens: 0, outputTokens: 0, inputCachedTokens: 0, reasoningTokens: 0, totalCost: 0 },
      stopReason: 'stop',
      timestamp: Date.now(),
    } satisfies AssistantMessage;
  });
}
```

Update `parseStdinPayload` to preserve `sender`:

```typescript
// In the history mapping inside parseStdinPayload:
history: Array.isArray(parsed.history)
  ? parsed.history.map((t: any) => ({
      role: t.role,
      content: t.content,
      ...(t.sender ? { sender: t.sender } : {}),
    }))
  : [],
```

Also update the `ConversationTurn` in `src/providers/memory/types.ts`:

```typescript
export interface ConversationTurn {
  role: 'user' | 'assistant';
  content: string;
  sender?: string;
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/agent/runner-history.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/agent/runner.ts src/providers/memory/types.ts tests/agent/runner-history.test.ts
git commit -m "feat: add sender field to ConversationTurn for multi-user history"
```

---

## Task 5: Integrate `ConversationStore` into server — load history before agent, save turns after completion

**Files:**
- Modify: `src/host/server.ts` — instantiate store, load/save in `processCompletion`
- Test: `tests/host/server-history.test.ts`

**Step 1: Write the failing test**

Create `tests/host/server-history.test.ts` that tests the integration points. Since `processCompletion` is a closure inside `createServer`, we'll test through the `ConversationStore` directly and verify the server wiring with a focused integration test:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ConversationStore } from '../src/conversation-store.js';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { rmSync } from 'node:fs';

describe('server history integration', () => {
  const dbPath = join(tmpdir(), `ax-server-hist-${Date.now()}.db`);
  let store: ConversationStore;

  beforeEach(() => { store = new ConversationStore(dbPath); });
  afterEach(() => {
    store.close();
    rmSync(dbPath, { force: true });
    rmSync(dbPath + '-wal', { force: true });
    rmSync(dbPath + '-shm', { force: true });
  });

  it('round-trips: save turns then load them as history', () => {
    const sessionId = 'slack:channel:C1234';
    store.append(sessionId, 'user', 'what is 2+2?', 'U111');
    store.append(sessionId, 'assistant', '4');
    store.append(sessionId, 'user', 'and 3+3?', 'U222');
    store.append(sessionId, 'assistant', '6');

    const history = store.load(sessionId, 50);
    expect(history).toHaveLength(4);
    expect(history[0]).toMatchObject({ role: 'user', content: 'what is 2+2?', sender: 'U111' });
    expect(history[3]).toMatchObject({ role: 'assistant', content: '6' });
  });

  it('max_turns caps history loaded', () => {
    const sessionId = 'main:cli:default';
    for (let i = 0; i < 20; i++) {
      store.append(sessionId, 'user', `msg${i}`);
      store.append(sessionId, 'assistant', `reply${i}`);
    }
    const history = store.load(sessionId, 10);
    expect(history).toHaveLength(10);
    // Last 10 turns = msg15, reply15, msg16, reply16, ...msg19, reply19
    expect(history[0].content).toBe('msg15');
  });

  it('thread loads parent channel context', () => {
    const channelId = 'slack:channel:C1234';
    const threadId = 'slack:thread:C1234:1709.5678';

    // Simulate channel history
    store.append(channelId, 'user', 'channel msg 1', 'U111');
    store.append(channelId, 'assistant', 'channel reply 1');
    store.append(channelId, 'user', 'channel msg 2', 'U222');
    store.append(channelId, 'assistant', 'channel reply 2');

    // Simulate thread history
    store.append(threadId, 'user', 'thread msg 1', 'U111');
    store.append(threadId, 'assistant', 'thread reply 1');

    // Load thread with 2 channel context turns
    const channelContext = store.load(channelId, 2);
    const threadHistory = store.load(threadId, 50);

    // Combine: channel context + thread history
    const combined = [...channelContext, ...threadHistory];
    expect(combined).toHaveLength(4);
    expect(combined[0].content).toBe('channel msg 2');
    expect(combined[1].content).toBe('channel reply 2');
    expect(combined[2].content).toBe('thread msg 1');
    expect(combined[3].content).toBe('thread reply 1');
  });
});
```

**Step 2: Run test to verify it passes (these test the store, not server wiring)**

Run: `npx vitest run tests/host/server-history.test.ts`
Expected: PASS (these are store-level tests; the server wiring comes next)

**Step 3: Implement server wiring**

In `src/host/server.ts`:

1. Import and instantiate the store:

```typescript
import { ConversationStore } from '../conversation-store.js';
// Inside createServer():
const conversationStore = new ConversationStore();
```

2. In `processCompletion`, after workspace setup (around line 427), load history from DB:

```typescript
// Load server-side conversation history
const maxTurns = config.history.max_turns;
let dbHistory: Array<{ role: 'user' | 'assistant'; content: string; sender?: string }> = [];

if (maxTurns > 0 && persistentSessionId) {
  const storedTurns = conversationStore.load(persistentSessionId, maxTurns);
  dbHistory = storedTurns.map(t => ({
    role: t.role,
    content: t.content,
    ...(t.sender ? { sender: t.sender } : {}),
  }));

  // For thread sessions, prepend parent channel context
  // Thread session IDs look like "slack:thread:C1234:ts"
  // Parent channel ID is "slack:channel:C1234"
  if (persistentSessionId.includes(':thread:')) {
    const parts = persistentSessionId.split(':');
    // slack:thread:C1234:ts → slack:channel:C1234
    const channelSessionId = `${parts[0]}:channel:${parts[2]}`;
    const contextTurns = config.history.thread_context_turns;
    if (contextTurns > 0) {
      const channelContext = conversationStore.load(channelSessionId, contextTurns);
      const contextMapped = channelContext.map(t => ({
        role: t.role as 'user' | 'assistant',
        content: t.content,
        ...(t.sender ? { sender: t.sender } : {}),
      }));
      dbHistory = [...contextMapped, ...dbHistory];
    }
  }
}

// Merge: prefer DB history, fall back to client-provided for HTTP API calls
const history = dbHistory.length > 0
  ? dbHistory
  : clientMessages.slice(0, -1).map(m => ({
      role: m.role as 'user' | 'assistant',
      content: m.content,
    }));
```

3. After successful completion (after `db.complete(queued.id)`, around line 583), save the turn pair:

```typescript
// Persist conversation turn
if (maxTurns > 0 && persistentSessionId) {
  conversationStore.append(persistentSessionId, 'user', content, userId);
  conversationStore.append(persistentSessionId, 'assistant', outbound.content);
  conversationStore.prune(persistentSessionId, maxTurns);
}
```

4. Pass `sender` in stdin payload history entries:

```typescript
const stdinPayload = JSON.stringify({
  history: history.map(h => ({
    role: h.role,
    content: h.content,
    ...('sender' in h && h.sender ? { sender: h.sender } : {}),
  })),
  message: content,
  // ... rest unchanged
});
```

**Step 4: Run all tests**

Run: `npx vitest run tests/host/server-history.test.ts && npx vitest run`
Expected: PASS

**Step 5: Commit**

```bash
git add src/host/server.ts tests/host/server-history.test.ts
git commit -m "feat: integrate ConversationStore into server — load/save history per session"
```

---

## Task 6: Pass `persistentSessionId` correctly from channel handler

**Files:**
- Modify: `src/host/server.ts` — change channel `onMessage` to pass `canonicalize(msg.session)` as `persistentSessionId`

**Step 1: Write the failing test**

This is a wiring change. The test is best verified by the existing integration test from Task 5 plus a unit test that the session ID is deterministic:

Add to `tests/providers/channel/slack-session.test.ts`:

```typescript
it('same channel message from different users produces same session ID', () => {
  const addr1: SessionAddress = {
    provider: 'slack', scope: 'channel',
    identifiers: { channel: 'C1234' },
  };
  const addr2: SessionAddress = {
    provider: 'slack', scope: 'channel',
    identifiers: { channel: 'C1234' },
  };
  const id1 = canonicalize(addr1);
  const id2 = canonicalize(addr2);
  expect(id1).toBe(id2);
  expect(id1).toBe('slack:channel:C1234');
});
```

**Step 2: Run test to verify it passes (session key correctness already ensured by Task 3)**

**Step 3: Implement**

In `src/host/server.ts`, the channel `onMessage` handler currently passes `msg.id` (the Slack message timestamp) as `persistentSessionId`. Change it to use the canonicalized session address:

```typescript
channel.onMessage(async (msg: InboundMessage) => {
  // ... existing validation, dedup, bootstrap gate, inbound scan ...

  const persistentSessionId = canonicalize(msg.session);

  const { responseContent } = await processCompletion(
    msg.content, `ch-${randomUUID().slice(0, 8)}`, [], persistentSessionId,
    { sessionId: result.sessionId, messageId: result.messageId!, canaryToken: result.canaryToken },
    msg.sender,
  );
  await channel.send(msg.session, { content: responseContent });
});
```

Import `canonicalize` from `../providers/channel/types.js` at the top of `server.ts`.

**Step 4: Run tests**

Run: `npx vitest run`
Expected: PASS

**Step 5: Commit**

```bash
git add src/host/server.ts
git commit -m "fix: use canonicalized session address as persistentSessionId for channel messages"
```

---

## Task 7: Remove vestigial `CONTEXT.md` and `message.txt` workspace files

**Files:**
- Modify: `src/host/server.ts` — remove `writeFileSync` for `CONTEXT.md` and `message.txt`
- Modify: `src/agent/stream-utils.ts` — remove `loadContext()`
- Modify: `src/agent/prompt/modules/context.ts` — remove or repurpose the module
- Modify: `src/agent/prompt/types.ts` — remove `contextContent`
- Update tests that reference these files

**Step 1: Search for all references**

Run: `grep -r 'CONTEXT.md\|message.txt\|loadContext\|contextContent' src/ tests/`

Identify every file that references these. Remove writing, loading, and prompt injection of these vestigial files.

**Step 2: Remove the writes in server.ts**

Delete lines 424-425:
```typescript
// DELETE: writeFileSync(join(workspace, 'CONTEXT.md'), `# Session: ${queued.session_id}\n`);
// DELETE: writeFileSync(join(workspace, 'message.txt'), content);
```

**Step 3: Remove `loadContext` from `stream-utils.ts`**

Delete the function and its import from all callers (runner.ts, pi-session.ts).

**Step 4: Remove `ContextModule` or make it a no-op**

Delete `src/agent/prompt/modules/context.ts` and remove it from the PromptBuilder module list. Remove `contextContent` from `PromptContext`.

**Step 5: Update tests**

Fix any tests that assert on `CONTEXT.md`, `message.txt`, `loadContext`, or `contextContent`.

**Step 6: Run all tests**

Run: `npx vitest run`
Expected: PASS

**Step 7: Commit**

```bash
git add -A
git commit -m "chore: remove vestigial CONTEXT.md and message.txt workspace files"
```

---

## Task 8: Verify end-to-end with smoke test

**Files:**
- Modify or create: `tests/smoke-history.test.ts`

**Step 1: Write smoke test**

Create a smoke test that:
1. Starts the server with mock LLM
2. Sends a message with session_id `main:cli:smoketest` — "my name is Alice"
3. Gets a response
4. Sends a second message with the same session_id — "what is my name?"
5. Verifies the second request's stdin payload includes history from the first turn
6. Verifies the `ConversationStore` DB contains both turns

This validates the full loop: HTTP → server → DB save → next request → DB load → stdin payload → agent.

**Step 2: Run smoke test**

Run: `npx vitest run tests/smoke-history.test.ts`
Expected: PASS

**Step 3: Commit**

```bash
git add tests/smoke-history.test.ts
git commit -m "test: add smoke test for conversation history persistence"
```

---

## Summary of Changes

| File | Change |
|---|---|
| `src/types.ts` | Add `history` to Config |
| `src/config.ts` | Add `history` Zod schema with defaults |
| `src/conversation-store.ts` | New — SQLite-backed turn storage |
| `src/host/server.ts` | Load history before agent, save after completion, fix channel persistentSessionId |
| `src/providers/channel/slack.ts` | Fix buildSession — drop peer/workspace from shared scopes, add group DM |
| `src/providers/channel/types.ts` | No changes needed (SessionScope already has 'group') |
| `src/agent/runner.ts` | Add sender to ConversationTurn, update historyToPiMessages and parseStdinPayload |
| `src/providers/memory/types.ts` | Add sender to ConversationTurn |
| `src/host/server.ts` | Remove CONTEXT.md/message.txt writes |
| `src/agent/stream-utils.ts` | Remove loadContext |
| `src/agent/prompt/modules/context.ts` | Remove |
| `src/agent/prompt/types.ts` | Remove contextContent |
