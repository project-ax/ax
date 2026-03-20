# Unified Cross-Channel User Identity — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Give every user a stable canonical identity that follows them across channels (Slack, web, Telegram, etc.) so that memory, identity files, workspaces, and conversations are unified regardless of how they interact with the agent.

**Architecture:** Add a `users` + `user_identities` table pair to the storage provider. On every inbound message, resolve the channel-specific sender to a canonical UUID before passing it downstream. All userId-dependent subsystems (identity files, memory, workspace, admin) consume the canonical ID. Conversation portability is achieved via an optional `conversation_id` on turns that lets multiple channel sessions share one conversation thread.

**Tech Stack:** TypeScript, Kysely (SQLite + PostgreSQL), Vitest, existing storage/channel provider contracts.

---

## Concepts

| Term | Meaning |
|------|---------|
| **Canonical userId** | A UUID assigned to a user on first interaction. Never changes. |
| **Provider identity** | A channel-specific user ID (e.g. Slack `U12345`, HTTP `alice`). Multiple provider identities can be linked to one canonical userId. |
| **Conversation** | A named, portable thread of dialogue. Has its own ID. Can be accessed from any channel. |
| **Session** | A channel-specific address (e.g. `slack:dm:U12345`). Sessions are ephemeral endpoints; conversations are durable threads. |

## Phases

| Phase | What | Tasks |
|-------|------|-------|
| 1 | User identity store (DB layer) | 1–5 |
| 2 | Identity resolution (wiring) | 6–10 |
| 3 | Backward-compat migration | 11–14 |
| 4 | Conversation portability | 15–19 |
| 5 | Cross-channel identity linking | 20–23 |

Phases 1–3 are the MVP. Phases 4–5 are extensions.

---

## Phase 1: User Identity Store

### Task 1: Database Migration — `users` + `user_identities` tables

**Files:**
- Modify: `src/providers/storage/migrations.ts`

**Step 1: Write the migration**

Add two new migrations after `storage_004_documents`:

```typescript
storage_005_users: {
  async up(db: Kysely<any>) {
    await db.schema
      .createTable('users')
      .ifNotExists()
      .addColumn('id', 'text', col => col.primaryKey())
      .addColumn('display_name', 'text')
      .addColumn('created_at', isSqlite ? 'integer' : 'bigint', col =>
        col.notNull().defaultTo(isSqlite ? sql`(unixepoch())` : sql`EXTRACT(EPOCH FROM NOW())::BIGINT`))
      .addColumn('updated_at', isSqlite ? 'integer' : 'bigint', col =>
        col.notNull().defaultTo(isSqlite ? sql`(unixepoch())` : sql`EXTRACT(EPOCH FROM NOW())::BIGINT`))
      .execute();
  },
  async down(db: Kysely<any>) {
    await db.schema.dropTable('users').ifExists().execute();
  },
},

storage_006_user_identities: {
  async up(db: Kysely<any>) {
    await db.schema
      .createTable('user_identities')
      .ifNotExists()
      .addColumn('provider', 'text', col => col.notNull())
      .addColumn('provider_user_id', 'text', col => col.notNull())
      .addColumn('user_id', 'text', col => col.notNull())
      .addColumn('linked_at', isSqlite ? 'integer' : 'bigint', col =>
        col.notNull().defaultTo(isSqlite ? sql`(unixepoch())` : sql`EXTRACT(EPOCH FROM NOW())::BIGINT`))
      .execute();

    // Composite primary key
    await sql`ALTER TABLE user_identities ADD PRIMARY KEY (provider, provider_user_id)`.execute(db)
      .catch(() => {
        // SQLite: primary key must be defined at creation time — use unique index instead
      });

    // For SQLite, add unique index as PK surrogate
    if (isSqlite) {
      await db.schema
        .createIndex('idx_user_identities_pk')
        .ifNotExists()
        .unique()
        .on('user_identities')
        .columns(['provider', 'provider_user_id'])
        .execute();
    }

    // Index for looking up all identities for a user
    await db.schema
      .createIndex('idx_user_identities_user_id')
      .ifNotExists()
      .on('user_identities')
      .column('user_id')
      .execute();
  },
  async down(db: Kysely<any>) {
    await db.schema.dropTable('user_identities').ifExists().execute();
  },
},
```

**Note on SQLite PK:** SQLite doesn't support `ALTER TABLE ... ADD PRIMARY KEY`. Use a unique index + `INSERT OR REPLACE` semantics. Alternatively, define the composite PK inline at creation time using raw SQL:

```typescript
if (isSqlite) {
  await sql`
    CREATE TABLE IF NOT EXISTS user_identities (
      provider TEXT NOT NULL,
      provider_user_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      linked_at INTEGER NOT NULL DEFAULT (unixepoch()),
      PRIMARY KEY (provider, provider_user_id)
    )
  `.execute(db);
} else {
  await sql`
    CREATE TABLE IF NOT EXISTS user_identities (
      provider TEXT NOT NULL,
      provider_user_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      linked_at BIGINT NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT,
      PRIMARY KEY (provider, provider_user_id)
    )
  `.execute(db);
}
```

Use this raw SQL approach (same pattern as `storage_002_turns` and `storage_004_documents`).

**Step 2: Verify migration runs**

```bash
npm test -- --bail tests/providers/storage/database.test.ts
```

Expected: Existing tests pass (migration is additive, no breaking changes).

**Step 3: Commit**

```bash
git add src/providers/storage/migrations.ts
git commit -m "feat(storage): add users + user_identities migration"
```

---

### Task 2: UserStore Types

**Files:**
- Modify: `src/providers/storage/types.ts`

**Step 1: Write the failing test**

Create `tests/providers/storage/user-store.test.ts`:

```typescript
import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { create } from '../../../src/providers/storage/database.js';
import { create as createSqliteDb } from '../../../src/providers/database/sqlite.js';
import { rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import type { StorageProvider } from '../../../src/providers/storage/types.js';
import type { DatabaseProvider } from '../../../src/providers/database/types.js';
import type { Config } from '../../../src/types.js';

const config = {} as Config;

describe('UserStore', () => {
  let storage: StorageProvider;
  let database: DatabaseProvider;
  let testHome: string;

  beforeEach(async () => {
    testHome = join(tmpdir(), `ax-user-store-test-${randomUUID()}`);
    mkdirSync(testHome, { recursive: true });
    process.env.AX_HOME = testHome;
    database = await createSqliteDb(config);
    storage = await create(config, 'database', { database });
  });

  afterEach(async () => {
    try { storage.close(); } catch {}
    try { await database.close(); } catch {}
    try { rmSync(testHome, { recursive: true, force: true }); } catch {}
    delete process.env.AX_HOME;
  });

  test('storage exposes users sub-store', () => {
    expect(storage.users).toBeDefined();
  });

  test('resolveOrCreate: creates user on first call', async () => {
    const userId = await storage.users.resolveOrCreate('slack', 'U12345');
    expect(userId).toMatch(/^[a-f0-9-]{36}$/); // UUID format
  });

  test('resolveOrCreate: returns same userId on repeat call', async () => {
    const first = await storage.users.resolveOrCreate('slack', 'U12345');
    const second = await storage.users.resolveOrCreate('slack', 'U12345');
    expect(first).toBe(second);
  });

  test('resolveOrCreate: different providers get different users', async () => {
    const slack = await storage.users.resolveOrCreate('slack', 'U12345');
    const http = await storage.users.resolveOrCreate('http', 'alice');
    expect(slack).not.toBe(http);
  });

  test('resolve: returns undefined for unknown identity', async () => {
    const result = await storage.users.resolve('slack', 'UNKNOWN');
    expect(result).toBeUndefined();
  });

  test('resolve: returns userId after resolveOrCreate', async () => {
    const created = await storage.users.resolveOrCreate('slack', 'U12345');
    const resolved = await storage.users.resolve('slack', 'U12345');
    expect(resolved).toBe(created);
  });

  test('link: connects a new provider identity to existing user', async () => {
    const userId = await storage.users.resolveOrCreate('slack', 'U12345');
    await storage.users.link(userId, 'http', 'alice');

    const resolved = await storage.users.resolve('http', 'alice');
    expect(resolved).toBe(userId);
  });

  test('link: idempotent — linking same identity twice does not error', async () => {
    const userId = await storage.users.resolveOrCreate('slack', 'U12345');
    await storage.users.link(userId, 'http', 'alice');
    await storage.users.link(userId, 'http', 'alice'); // no throw
  });

  test('unlink: removes a provider identity', async () => {
    const userId = await storage.users.resolveOrCreate('slack', 'U12345');
    await storage.users.link(userId, 'http', 'alice');
    await storage.users.unlink('http', 'alice');

    const resolved = await storage.users.resolve('http', 'alice');
    expect(resolved).toBeUndefined();
  });

  test('getIdentities: returns all linked identities', async () => {
    const userId = await storage.users.resolveOrCreate('slack', 'U12345');
    await storage.users.link(userId, 'http', 'alice');
    await storage.users.link(userId, 'discord', 'alice#1234');

    const identities = await storage.users.getIdentities(userId);
    expect(identities).toHaveLength(3);
    expect(identities.map(i => i.provider).sort()).toEqual(['discord', 'http', 'slack']);
  });

  test('getUser: returns user record', async () => {
    const userId = await storage.users.resolveOrCreate('slack', 'U12345', 'Alice');
    const user = await storage.users.getUser(userId);
    expect(user).toBeDefined();
    expect(user!.id).toBe(userId);
    expect(user!.displayName).toBe('Alice');
  });

  test('getUser: returns undefined for unknown userId', async () => {
    const user = await storage.users.getUser('nonexistent');
    expect(user).toBeUndefined();
  });

  test('updateDisplayName: updates the display name', async () => {
    const userId = await storage.users.resolveOrCreate('slack', 'U12345', 'Alice');
    await storage.users.updateDisplayName(userId, 'Bob');
    const user = await storage.users.getUser(userId);
    expect(user!.displayName).toBe('Bob');
  });
});
```

**Step 2: Run test to verify it fails**

```bash
npm test -- --bail tests/providers/storage/user-store.test.ts
```

Expected: FAIL — `storage.users` is undefined, `UserStoreProvider` type doesn't exist.

**Step 3: Add types to `src/providers/storage/types.ts`**

Add after the SessionStore section:

```typescript
// ═══════════════════════════════════════════════════════
// User Identity Store
// ═══════════════════════════════════════════════════════

export interface User {
  id: string;
  displayName: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface UserIdentity {
  provider: string;
  providerUserId: string;
  userId: string;
  linkedAt: number;
}

export interface UserStoreProvider {
  /**
   * Look up canonical userId for a channel identity.
   * If not found, creates a new user record + identity link and returns the new userId.
   */
  resolveOrCreate(provider: string, providerUserId: string, displayName?: string): Promise<string>;

  /** Look up canonical userId. Returns undefined if not linked. */
  resolve(provider: string, providerUserId: string): Promise<string | undefined>;

  /** Link a new channel identity to an existing canonical user. */
  link(userId: string, provider: string, providerUserId: string): Promise<void>;

  /** Remove a channel identity link. */
  unlink(provider: string, providerUserId: string): Promise<void>;

  /** Get all linked identities for a canonical user. */
  getIdentities(userId: string): Promise<UserIdentity[]>;

  /** Get user record by canonical ID. */
  getUser(userId: string): Promise<User | undefined>;

  /** Update display name. */
  updateDisplayName(userId: string, displayName: string): Promise<void>;
}
```

Add `users` to `StorageProvider`:

```typescript
export interface StorageProvider {
  readonly messages: MessageQueueStore;
  readonly conversations: ConversationStoreProvider;
  readonly sessions: SessionStoreProvider;
  readonly documents: DocumentStore;
  readonly users: UserStoreProvider;  // ← ADD
  close(): void;
}
```

**Step 4: Commit types**

```bash
git add src/providers/storage/types.ts tests/providers/storage/user-store.test.ts
git commit -m "feat(storage): add UserStoreProvider types and test scaffold"
```

---

### Task 3: UserStore Database Implementation

**Files:**
- Modify: `src/providers/storage/database.ts`

**Step 1: Implement `createUserStore`**

Add after `createDocumentStore`:

```typescript
function createUserStore(db: Kysely<any>): UserStoreProvider {
  return {
    async resolveOrCreate(provider, providerUserId, displayName?) {
      // Check if identity already exists
      const existing = await db.selectFrom('user_identities')
        .select('user_id')
        .where('provider', '=', provider)
        .where('provider_user_id', '=', providerUserId)
        .executeTakeFirst();

      if (existing) return existing.user_id as string;

      // Create new user + identity atomically
      const userId = randomUUID();
      const now = Date.now();
      await db.transaction().execute(async (trx) => {
        await trx.insertInto('users')
          .values({
            id: userId,
            display_name: displayName ?? null,
            created_at: now,
            updated_at: now,
          })
          .execute();

        await trx.insertInto('user_identities')
          .values({
            provider,
            provider_user_id: providerUserId,
            user_id: userId,
            linked_at: now,
          })
          .execute();
      });

      return userId;
    },

    async resolve(provider, providerUserId) {
      const row = await db.selectFrom('user_identities')
        .select('user_id')
        .where('provider', '=', provider)
        .where('provider_user_id', '=', providerUserId)
        .executeTakeFirst();
      return (row?.user_id as string) ?? undefined;
    },

    async link(userId, provider, providerUserId) {
      await sql`
        INSERT INTO user_identities (provider, provider_user_id, user_id, linked_at)
        VALUES (${provider}, ${providerUserId}, ${userId}, ${Date.now()})
        ON CONFLICT (provider, provider_user_id) DO UPDATE SET
          user_id = EXCLUDED.user_id,
          linked_at = EXCLUDED.linked_at
      `.execute(db);
    },

    async unlink(provider, providerUserId) {
      await db.deleteFrom('user_identities')
        .where('provider', '=', provider)
        .where('provider_user_id', '=', providerUserId)
        .execute();
    },

    async getIdentities(userId) {
      const rows = await db.selectFrom('user_identities')
        .select(['provider', 'provider_user_id', 'user_id', 'linked_at'])
        .where('user_id', '=', userId)
        .orderBy('linked_at', 'asc')
        .execute();
      return rows.map(r => ({
        provider: r.provider as string,
        providerUserId: r.provider_user_id as string,
        userId: r.user_id as string,
        linkedAt: Number(r.linked_at),
      }));
    },

    async getUser(userId) {
      const row = await db.selectFrom('users')
        .select(['id', 'display_name', 'created_at', 'updated_at'])
        .where('id', '=', userId)
        .executeTakeFirst();
      if (!row) return undefined;
      return {
        id: row.id as string,
        displayName: (row.display_name as string) ?? null,
        createdAt: Number(row.created_at),
        updatedAt: Number(row.updated_at),
      };
    },

    async updateDisplayName(userId, displayName) {
      await db.updateTable('users')
        .set({ display_name: displayName, updated_at: Date.now() })
        .where('id', '=', userId)
        .execute();
    },
  };
}
```

**Step 2: Wire into `create()` return**

In the `create` function, add `users` to the returned object:

```typescript
return {
  get messages() { return createMessageQueue(db, dbType); },
  get conversations() { return createConversationStore(db); },
  get sessions() { return createSessionStore(db); },
  get documents() { return createDocumentStore(db, dbType); },
  get users() { return createUserStore(db); },  // ← ADD
  close(): void { /* no-op */ },
};
```

**Step 3: Run tests**

```bash
npm test -- --bail tests/providers/storage/user-store.test.ts
```

Expected: All tests pass.

**Step 4: Run full storage test suite**

```bash
npm test -- --bail tests/providers/storage/
```

Expected: All existing tests still pass.

**Step 5: Commit**

```bash
git add src/providers/storage/database.ts
git commit -m "feat(storage): implement UserStore database backend"
```

---

### Task 4: Race Condition Protection for `resolveOrCreate`

**Files:**
- Modify: `src/providers/storage/database.ts`
- Modify: `tests/providers/storage/user-store.test.ts`

Two concurrent requests for the same provider+providerUserId could both see "no existing row" and try to insert, causing a unique constraint violation on `user_identities`. Fix with INSERT OR IGNORE + re-select.

**Step 1: Write the failing test**

Add to `user-store.test.ts`:

```typescript
test('resolveOrCreate: concurrent calls for same identity return same userId', async () => {
  const results = await Promise.all([
    storage.users.resolveOrCreate('slack', 'U_RACE'),
    storage.users.resolveOrCreate('slack', 'U_RACE'),
    storage.users.resolveOrCreate('slack', 'U_RACE'),
  ]);
  expect(new Set(results).size).toBe(1); // all same userId
});
```

**Step 2: Run to verify it fails (or might fail non-deterministically)**

```bash
npm test -- --bail tests/providers/storage/user-store.test.ts
```

**Step 3: Update `resolveOrCreate` to handle races**

Replace the implementation with a conflict-safe version:

```typescript
async resolveOrCreate(provider, providerUserId, displayName?) {
  // Fast path: identity already exists
  const existing = await db.selectFrom('user_identities')
    .select('user_id')
    .where('provider', '=', provider)
    .where('provider_user_id', '=', providerUserId)
    .executeTakeFirst();
  if (existing) return existing.user_id as string;

  // Slow path: create user + identity, handling races
  const userId = randomUUID();
  const now = Date.now();

  try {
    await db.transaction().execute(async (trx) => {
      await trx.insertInto('users')
        .values({ id: userId, display_name: displayName ?? null, created_at: now, updated_at: now })
        .execute();
      await trx.insertInto('user_identities')
        .values({ provider, provider_user_id: providerUserId, user_id: userId, linked_at: now })
        .execute();
    });
    return userId;
  } catch {
    // Race: another call created the identity between our SELECT and INSERT.
    // Re-read and return the winner's userId.
    const raced = await db.selectFrom('user_identities')
      .select('user_id')
      .where('provider', '=', provider)
      .where('provider_user_id', '=', providerUserId)
      .executeTakeFirst();
    if (raced) return raced.user_id as string;
    throw new Error(`Failed to resolve or create user for ${provider}:${providerUserId}`);
  }
},
```

**Step 4: Run tests**

```bash
npm test -- --bail tests/providers/storage/user-store.test.ts
```

Expected: All tests pass including the race test.

**Step 5: Commit**

```bash
git add src/providers/storage/database.ts tests/providers/storage/user-store.test.ts
git commit -m "fix(storage): handle race conditions in resolveOrCreate"
```

---

### Task 5: Existing Storage Tests Still Pass

**Step 1: Run full test suite**

```bash
npm test -- --bail tests/providers/storage/
```

Expected: All pass. The migration is additive, types are additive, StorageProvider now requires `users` but the implementation provides it.

**Step 2: Run build**

```bash
npm run build
```

Expected: Clean compile.

**Step 3: Commit (if any fixups needed)**

---

## Phase 2: Identity Resolution

### Task 6: Resolve User in Channel Handler

**Files:**
- Modify: `src/host/server-channels.ts`
- Test: `tests/host/server-channels.test.ts` (if exists, or create)

Currently, `server-channels.ts:243` passes `msg.sender` (the raw channel user ID) as `userId` to `processCompletion`. Change this to resolve through `UserStore`.

**Step 1: Write the test**

In whatever test file covers channel handler integration, add:

```typescript
test('channel handler resolves sender to canonical userId via UserStore', async () => {
  // Send message with Slack sender "U12345"
  // Assert that processCompletion receives the canonical UUID, not "U12345"
  // Assert that UserStore.resolveOrCreate was called with ('slack', 'U12345')
});
```

The exact test setup depends on the existing test harness for server-channels. If there isn't one, the test can use a mock `UserStore` and verify the call.

**Step 2: Modify `server-channels.ts`**

The `registerChannelHandler` function receives `completionDeps` which includes providers. The user store is accessible via `completionDeps.providers.storage.users`.

Before the `processCompletion` call (around line 240), add resolution:

```typescript
// Resolve channel sender to canonical user ID
const canonicalUserId = await completionDeps.providers.storage.users.resolveOrCreate(
  channel.name,   // provider name (e.g. 'slack', 'discord')
  msg.sender,     // channel-specific user ID
);
```

Then change the `processCompletion` call to pass `canonicalUserId` instead of `msg.sender`:

```typescript
const { responseContent, ... } = await processCompletion(
  completionDeps, messageContent, `ch-${randomUUID().slice(0, 8)}`, [], sessionId,
  { sessionId: result.sessionId, messageId: result.messageId!, canaryToken: result.canaryToken },
  canonicalUserId,  // ← was: msg.sender
  replyOptional,
  msg.session.scope,
);
```

**Important:** The `msg.sender` is still used for the `sender` field in the message queue (via `router.processInbound`). That's fine — the queue's `sender` field is informational. The `userId` parameter to `processCompletion` is what matters for identity files, memory, workspace, and admin checks.

**Step 3: Update bootstrap gate**

The bootstrap gate at line 204 also uses `msg.sender`. Update it to use `canonicalUserId`:

```typescript
// Resolve user BEFORE bootstrap gate
const canonicalUserId = await completionDeps.providers.storage.users.resolveOrCreate(
  channel.name, msg.sender,
);

// Bootstrap gate uses canonical ID
if (isBootstrap(agentName) && !isAdminFn(agentDir, canonicalUserId)) {
  if (claimBootstrapAdminFn(agentDir, canonicalUserId)) {
    logger.info('bootstrap_admin_claimed', { provider: channel.name, sender: msg.sender, userId: canonicalUserId });
  } else { ... }
}
```

**Step 4: Run tests**

```bash
npm test -- --bail tests/host/
```

**Step 5: Commit**

```bash
git add src/host/server-channels.ts tests/host/
git commit -m "feat(channels): resolve sender to canonical userId via UserStore"
```

---

### Task 7: Resolve User in HTTP API

**Files:**
- Modify: `src/host/server.ts`

**Step 1: Identify the change point**

At `server.ts:843`:
```typescript
const userId = chatReq.user?.split('/')[0] || undefined;
```

This raw `userId` is passed to `processCompletion` at line 988. Replace with resolved canonical ID.

**Step 2: Add resolution**

After extracting the raw userId, resolve it:

```typescript
const rawUserId = chatReq.user?.split('/')[0] || undefined;
const userId = rawUserId
  ? await completionDeps.providers.storage.users.resolveOrCreate('http', rawUserId)
  : undefined;
```

**Step 3: Update bootstrap gate**

The bootstrap gate at line 846 uses `userId`. Since we've already resolved it, the existing code works — but the admin file now stores canonical UUIDs instead of raw HTTP user IDs.

**Step 4: Run tests**

```bash
npm test -- --bail tests/host/
```

**Step 5: Commit**

```bash
git add src/host/server.ts
git commit -m "feat(http): resolve HTTP user to canonical userId via UserStore"
```

---

### Task 8: Pass Provider Identities to Identity Loader

**Files:**
- Modify: `src/host/server-completions.ts`

The identity file loader at `server-completions.ts:167` loads files from `agentName/users/userId/`. With canonical UUIDs, existing identity files keyed by channel-specific IDs (e.g. `main/users/U12345/USER.md`) won't be found.

**Step 1: Update `loadIdentityFromDB` to accept linked identities**

Change the signature:

```typescript
async function loadIdentityFromDB(
  documents: DocumentStore,
  agentName: string,
  userId: string,
  linkedProviderIds: string[],  // ← ADD: channel-specific IDs for fallback
  logger: Logger,
): Promise<IdentityPayload> {
```

**Step 2: Add fallback logic**

After loading user-level identity files, if none found, check linked provider IDs:

```typescript
// Load user-level identity files (canonical path)
const userPrefix = `${agentName}/users/${userId}/`;
let foundUserFiles = false;

for (const key of allKeys) {
  if (!key.startsWith(userPrefix)) continue;
  foundUserFiles = true;
  const filename = key.slice(userPrefix.length);
  const field = IDENTITY_FILE_MAP[filename];
  if (field) {
    const content = await documents.get('identity', key);
    if (content) identity[field] = content;
  }
}

// Fallback: check legacy paths keyed by channel-specific IDs
if (!foundUserFiles) {
  for (const legacyId of linkedProviderIds) {
    const legacyPrefix = `${agentName}/users/${legacyId}/`;
    const legacyKeys = allKeys.filter(k => k.startsWith(legacyPrefix));
    if (legacyKeys.length === 0) continue;

    // Migrate: copy to canonical path + load
    for (const key of legacyKeys) {
      const filename = key.slice(legacyPrefix.length);
      const field = IDENTITY_FILE_MAP[filename];
      if (!field) continue;
      const content = await documents.get('identity', key);
      if (!content) continue;
      identity[field] = content;
      // Migrate to canonical path
      const canonicalKey = `${userPrefix}${filename}`;
      await documents.put('identity', canonicalKey, content);
      logger.info('identity_migrated', { from: key, to: canonicalKey });
    }
    break; // use first match
  }
}
```

**Step 3: Update callers of `loadIdentityFromDB`**

In `processCompletion`, fetch linked identities and pass them:

```typescript
// Get linked provider IDs for fallback identity file lookup
const linkedIdentities = await providers.storage.users.getIdentities(currentUserId);
const linkedProviderIds = linkedIdentities.map(i => i.providerUserId);

const identityPayload = await loadIdentityFromDB(
  providers.storage.documents, agentName, currentUserId, linkedProviderIds, reqLogger,
);
```

**Step 4: Run tests**

```bash
npm test -- --bail tests/host/
```

**Step 5: Commit**

```bash
git add src/host/server-completions.ts
git commit -m "feat(identity): load identity files with legacy fallback + auto-migration"
```

---

### Task 9: Include `providerUserId` in Stdin Payload

**Files:**
- Modify: `src/host/server-completions.ts`

The agent process receives `userId` in its stdin payload. With canonical UUIDs, the agent won't know the user's channel-specific identity (which is sometimes useful for display or Slack-specific features).

**Step 1: Add `providerUserId` to stdin payload**

In `processCompletion`, where the stdin payload is built (around line 894), add:

```typescript
const stdinPayload = JSON.stringify({
  userId: currentUserId,           // canonical UUID
  providerUserId: userId,          // original channel-specific ID (pre-resolution)
  agentId: agentName,
  sessionId,
  // ... rest unchanged
});
```

Wait — by the time we reach this code, `userId` is already the resolved canonical ID. We need to preserve the original sender.

**Better approach:** Pass the original sender separately. In `processCompletion`, add a parameter:

Actually, don't change the `processCompletion` signature. Instead, derive from the already-available session and user store:

```typescript
// Look up the provider identity that matches this session's provider
const sessionProvider = persistentSessionId?.split(':')[0] ?? preProcessed?.sessionId?.split(':')[0] ?? 'http';
const providerIdentities = await providers.storage.users.getIdentities(currentUserId);
const matchingIdentity = providerIdentities.find(i => i.provider === sessionProvider);

const stdinPayload = JSON.stringify({
  userId: currentUserId,
  providerUserId: matchingIdentity?.providerUserId ?? currentUserId,
  // ... rest unchanged
});
```

Or simpler: just include the `sender` field from the queued message (which is the channel-specific ID). The queued message is available via `preProcessed`:

```typescript
// In the stdin payload:
providerUserId: queued?.sender ?? currentUserId,
```

Choose whichever is simpler at implementation time. The key requirement: the agent should have both the canonical userId and the channel-specific sender.

**Step 2: Commit**

```bash
git add src/host/server-completions.ts
git commit -m "feat(completions): include providerUserId in agent stdin payload"
```

---

### Task 10: Update Memory Recall Scoping

**Files:**
- Modify: `src/host/memory-recall.ts` (if needed)
- Verify: `src/providers/memory/cortex/items-store.ts`

Memory entries are already userId-scoped (the memory provider has `userId` fields on `MemoryEntry` and `MemoryQuery`). Since `processCompletion` now passes the canonical userId, memory scoping should work correctly — all entries written by the same user across channels will be found under the same canonical ID.

**Step 1: Verify memory recall config**

In `server-completions.ts`, check where `MemoryRecallConfig.userId` is set:

```typescript
const memoryConfig: MemoryRecallConfig = {
  // ...
  userId: currentUserId,  // already the canonical ID after our changes
};
```

No code change needed — just verify.

**Step 2: Write a test to confirm memory is unified**

```typescript
test('memory entries written via Slack are visible via HTTP for same user', async () => {
  // 1. resolveOrCreate('slack', 'U12345') → canonical userId
  // 2. Write memory entry with that userId
  // 3. resolveOrCreate('http', 'alice') → different canonical userId (not linked yet)
  // 4. Link 'http:alice' to same user: users.link(userId, 'http', 'alice')
  // 5. Query memory with userId → should find the entry
});
```

**Step 3: Commit**

```bash
git commit -m "test(memory): verify cross-channel memory unification"
```

---

## Phase 3: Backward Compatibility & Migration

### Task 11: Admin File Backward Compatibility

**Files:**
- Modify: `src/host/server.ts` (the `isAdmin` function)

The `admins` file currently contains channel-specific user IDs (e.g. `U12345`). After this change, new admin entries will be canonical UUIDs. We need `isAdmin` to check both.

**Step 1: Update `isAdmin` to accept a UserStore**

The current `isAdmin` is a pure function reading a file. To check linked identities, it needs the UserStore. Two options:

**Option A (simple):** Keep `isAdmin` checking the file as-is. Since bootstrap now writes canonical UUIDs, old admin files work with old IDs and new admin files work with new IDs. Admins added post-migration use canonical IDs. For a transition period, both formats coexist in the file.

**Option B (thorough):** Make `isAdmin` async, look up the user's linked provider IDs, and check if ANY of them appear in the admin file.

Recommend **Option B** for correctness:

```typescript
export async function isAdmin(
  agentDirPath: string,
  canonicalUserId: string,
  userStore?: UserStoreProvider,
): Promise<boolean> {
  const adminsPath = join(agentDirPath, 'admins');
  if (!existsSync(adminsPath)) return false;
  const lines = readFileSync(adminsPath, 'utf-8')
    .split('\n').map(l => l.trim()).filter(Boolean);

  // Check canonical ID first
  if (lines.includes(canonicalUserId)) return true;

  // Check linked provider IDs (backward compat with legacy admin files)
  if (userStore) {
    const identities = await userStore.getIdentities(canonicalUserId);
    return identities.some(i => lines.includes(i.providerUserId));
  }

  return false;
}
```

**Step 2: Update all callers**

`isAdmin` is called in:
- `server.ts` bootstrap gate (line 846)
- `server-channels.ts` bootstrap gate (line 204)
- `server-completions.ts` workspace writeability check (line 711)

All callers need to become `await isAdmin(...)` and pass the user store.

**Step 3: Run tests**

```bash
npm test -- --bail tests/host/
```

**Step 4: Commit**

```bash
git add src/host/server.ts src/host/server-channels.ts src/host/server-completions.ts
git commit -m "feat(admin): backward-compat isAdmin checks both canonical and provider IDs"
```

---

### Task 12: Workspace Prefix Migration

**Files:**
- Modify: `src/host/server-completions.ts`

GCS workspace paths use `user/${userId}/`. With canonical UUIDs, existing data at `user/U12345/` won't be found.

**Step 1: Keep old workspace paths accessible**

In `resolveWorkspaceGcsPrefixes`, return BOTH canonical and legacy prefixes:

```typescript
export function resolveWorkspaceGcsPrefixes(
  config: Config,
  agentName: string,
  userId: string,
  sessionId: string,
  legacyUserIds?: string[],
): {
  agentGcsPrefix?: string;
  userGcsPrefix?: string;
  sessionGcsPrefix?: string;
  legacyUserGcsPrefixes?: string[];
} {
  // ... existing logic ...
  return {
    agentGcsPrefix: `${base}agent/${agentName}/`,
    userGcsPrefix: `${base}user/${userId}/`,
    sessionGcsPrefix: `${base}scratch/${sessionId}/`,
    legacyUserGcsPrefixes: legacyUserIds?.map(id => `${base}user/${id}/`),
  };
}
```

The agent can then read from legacy prefixes and write to the canonical prefix. This is a gradual migration — data moves to the canonical path as it's updated.

**Step 2: Commit**

```bash
git add src/host/server-completions.ts
git commit -m "feat(workspace): expose legacy GCS prefixes for gradual migration"
```

---

### Task 13: Orchestration Event Store userId

**Files:**
- Verify: `src/host/orchestration/event-store.ts`

The orchestration event store already captures `user_id` from event data. Since `processCompletion` now passes the canonical userId, events will automatically be tagged with canonical IDs.

**Step 1: Verify** — No code change needed, just confirm the data flow.

**Step 2: Commit** — No commit needed.

---

### Task 14: Integration Test — Full Flow

**Files:**
- Create: `tests/host/unified-user-identity.test.ts`

Write an integration test that validates the end-to-end flow:

```typescript
describe('unified user identity', () => {
  test('same user across Slack and HTTP gets same canonical identity', async () => {
    // 1. Simulate Slack message from U12345
    //    → resolveOrCreate('slack', 'U12345') → canonical ID 'aaa-bbb'
    // 2. Link HTTP identity: users.link('aaa-bbb', 'http', 'alice')
    // 3. Simulate HTTP request with user='alice/conv1'
    //    → resolveOrCreate('http', 'alice') → BUT this creates a DIFFERENT user
    //       because it hasn't been linked yet at resolveOrCreate time
    //
    // WAIT: This reveals a design issue. resolveOrCreate('http', 'alice')
    // creates a NEW user because the link hasn't been established yet.
    // The link must happen BEFORE the HTTP request, or we need a different
    // flow for linking.
    //
    // This is correct — linking is an explicit action (Phase 5).
    // Before linking, users have separate identities. After linking,
    // the resolve() call returns the linked canonical ID.
  });

  test('identity files are shared after linking', async () => {
    // 1. Create user via Slack, write USER.md under canonical path
    // 2. Link HTTP identity to same user
    // 3. Load identity from HTTP → should find same USER.md
  });

  test('memory entries are shared after linking', async () => {
    // 1. Create user via Slack
    // 2. Write memory entry scoped to canonical userId
    // 3. Link HTTP identity
    // 4. Resolve HTTP user → same canonical ID
    // 5. Query memory → entry found
  });
});
```

**Step 1: Write tests**

**Step 2: Run**

```bash
npm test -- --bail tests/host/unified-user-identity.test.ts
```

**Step 3: Commit**

```bash
git add tests/host/unified-user-identity.test.ts
git commit -m "test: end-to-end integration test for unified user identity"
```

---

## Phase 4: Conversation Portability

> **Status:** Design outline. Flesh out into bite-sized tasks before implementing.

### Goal

Let users continue a conversation from any channel. A conversation started on the web can be picked up in Slack and vice versa.

### Schema

Add a `conversation_id` column to the `turns` table and a `conversations` registry:

```sql
-- Migration: storage_007_conversations
CREATE TABLE conversations (
  id TEXT PRIMARY KEY,                    -- UUID
  user_id TEXT NOT NULL,                  -- canonical user ID (owner)
  agent_id TEXT NOT NULL DEFAULT 'main',
  name TEXT,                              -- optional human-readable name
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(user_id, agent_id, name)
);

-- Migration: storage_008_turns_conversation_id
ALTER TABLE turns ADD COLUMN conversation_id TEXT;
CREATE INDEX idx_turns_conversation ON turns(conversation_id, id);
```

### Tasks (to be expanded)

**Task 15:** Add migration for `conversations` table + `conversation_id` column on `turns`.

**Task 16:** Add `ConversationRegistryProvider` interface to `types.ts`:
```typescript
interface ConversationRegistryProvider {
  create(userId: string, agentId: string, name?: string): Promise<string>;  // returns conversationId
  getByName(userId: string, agentId: string, name: string): Promise<string | undefined>;
  list(userId: string, agentId: string): Promise<Conversation[]>;
  getDefault(userId: string, agentId: string): Promise<string | undefined>;  // most recent
}
```

**Task 17:** Implement `ConversationRegistryProvider` in `database.ts`.

**Task 18:** Update `ConversationStoreProvider` to support `conversation_id`:
- `append()` accepts optional `conversationId`
- `load()` can load by `conversationId` instead of `sessionId`
- New turns written with both `session_id` and `conversation_id`

**Task 19:** Update `processCompletion` to:
1. On DM sessions: look up or create a conversation for the user
2. Store `conversation_id` on all turns
3. When loading history, prefer `conversation_id` if set
4. Add a mechanism for users to select a conversation (e.g., agent recognizes "continue <name>" or exposes a tool)

### Conversation Selection Flow

```
User sends message in new channel DM
  ↓
Is there an active conversation for this user? (most recently updated)
  ↓ yes              ↓ no
  Resume it          Create new conversation
  (load by           (generate name, return
   conversation_id)   new conversation_id)
```

Configurable per-agent: `conversation_resume: "last" | "new" | "ask"` (default: `"last"`).

---

## Phase 5: Cross-Channel Identity Linking

> **Status:** Design outline. Flesh out into bite-sized tasks before implementing.

### Goal

Let users prove they're the same person across channels and merge their identities.

### Mechanism: Link Tokens

1. User sends `/link` (or tells the agent "link my accounts") in channel A
2. Agent generates a short-lived token (6-char alphanumeric, 10-minute TTL)
3. Agent replies: "Your link code is `ABC123`. Enter this code in your other channel within 10 minutes."
4. User goes to channel B and sends: "link ABC123"
5. Agent validates the token, calls `users.link(existingUserId, providerB, providerUserIdB)`
6. Agent confirms: "Your accounts are now linked."

### Schema

```sql
-- Ephemeral — can use in-memory Map with TTL, or a table:
CREATE TABLE link_tokens (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,         -- who initiated the link
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
```

### Tasks (to be expanded)

**Task 20:** Add link token storage (in-memory Map with TTL cleanup, no need for DB table).

**Task 21:** Add IPC actions: `user_link_initiate` (generates token) and `user_link_complete` (validates token and links).

**Task 22:** Add IPC schemas to `ipc-schemas.ts`:
```typescript
export const UserLinkInitiateSchema = ipcAction('user_link_initiate', {});
export const UserLinkCompleteSchema = ipcAction('user_link_complete', {
  token: z.string().length(6),
});
```

**Task 23:** Register IPC handlers in `src/host/ipc-handler.ts`:
- `user_link_initiate`: generate token, store with userId + TTL, return token
- `user_link_complete`: validate token, look up initiator's userId, call `users.link()`, merge data (identity files, admin entries), return success

**Task 24:** Add agent tool (`link_accounts`) that triggers the IPC actions. The agent can offer this proactively when it detects a new user who mentions using another channel.

**Task 25:** Data merge on link:
- Identity files: copy from secondary user's path to primary user's path
- Memory entries: update `user_id` on all entries from secondary → primary
- Admin file: if secondary was admin, ensure primary is too
- Conversations: re-assign secondary's conversations to primary
- Delete secondary user record after merge

---

## Key Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Canonical ID format | UUID | Stable, no channel-specific semantics, collision-free |
| Auto-creation | On first message | No explicit registration step — frictionless |
| Linking approach | Explicit token exchange | Users must prove ownership of both identities |
| Conversation model | Named, portable, owned by user | Supports multi-topic and cross-channel continuation |
| Migration strategy | Lazy (on first access) | No bulk migration needed, backward-compatible |
| Session model | Keep as-is (address-based) | Sessions are channel endpoints; conversations transcend channels |
| Admin backward compat | Check both canonical + provider IDs | Existing admin files keep working |

## Files Touched (Summary)

| File | Phase | Change |
|------|-------|--------|
| `src/providers/storage/migrations.ts` | 1 | Add users + user_identities tables |
| `src/providers/storage/types.ts` | 1 | Add User, UserIdentity, UserStoreProvider types |
| `src/providers/storage/database.ts` | 1 | Implement createUserStore |
| `src/host/server-channels.ts` | 2 | Resolve sender → canonical userId |
| `src/host/server.ts` | 2 | Resolve HTTP user → canonical userId, async isAdmin |
| `src/host/server-completions.ts` | 2, 3 | Identity fallback, workspace prefix migration, providerUserId in stdin |
| `src/host/memory-recall.ts` | 2 | Verify (no change expected) |
| `tests/providers/storage/user-store.test.ts` | 1 | Full UserStore test suite |
| `tests/host/unified-user-identity.test.ts` | 2 | Integration tests |
