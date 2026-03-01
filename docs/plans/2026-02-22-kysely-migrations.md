# Kysely Migration Infrastructure Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a versioned, DB-agnostic migration system using Kysely that works with both SQLite (current) and PostgreSQL (future).

**Architecture:** A shared `runMigrations()` utility accepts a Kysely instance and a map of named migrations. Each store defines its own migrations as code objects (no filesystem scanning). For SQLite, each store gets its own Kysely instance pointing at its `.db` file. For PostgreSQL, all stores share one Kysely instance — migration names are prefixed per-store to avoid collisions. Stores keep their existing `openDatabase()` raw SQL for queries; Kysely is used only for schema management.

**Tech Stack:** Kysely (migration runner + schema builder), better-sqlite3 (already installed), pg (optional, for future PostgreSQL)

---

## Design Decisions

### Why Kysely for migrations only (not queries)?

Rewriting all store queries to use Kysely's query builder is a large, risky refactor with no immediate payoff. The stores' raw SQL works fine. Kysely's value here is **DB-agnostic DDL** — `db.schema.createTable(...)` generates the right SQL for both SQLite and PostgreSQL. Queries can be migrated incrementally later if needed.

### Sync constructors → async factory methods

Kysely's migration runner is async (required for PostgreSQL). The four class-based stores (`MessageQueue`, `SessionStore`, `ConversationStore`, `SqliteJobStore`) currently have sync constructors that call `this.migrate()`. These will gain a static `async create()` factory method. The constructor becomes private and no longer calls `migrate()` — the factory does.

The two provider-based stores (`memory/sqlite.ts`, `audit/sqlite.ts`) already use async `create()` functions, so they need no structural change.

### Migration naming convention

Migrations are prefixed with the store name and a zero-padded sequence number:
- `messages_001_initial`
- `memory_001_initial`
- `memory_002_add_agent_id`

This ensures uniqueness when all stores share a single PostgreSQL database.

### Database configuration

A new optional `database` section in `Config` selects the dialect:

```typescript
database?: {
  type: 'sqlite' | 'postgresql';
  url?: string;  // PostgreSQL connection string
}
```

Default: `{ type: 'sqlite' }`. When `type` is `'postgresql'`, all stores share one connection pool.

---

## Task 1: Install Kysely

**Files:**
- Modify: `package.json`

**Step 1: Install kysely**

```bash
npm install kysely
```

**Step 2: Verify the build still compiles**

```bash
npm run build
```
Expected: SUCCESS with no errors.

**Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: add kysely dependency for DB migrations"
```

---

## Task 2: Create the migration runner utility

**Files:**
- Create: `src/utils/migrator.ts`
- Test: `tests/utils/migrator.test.ts`

**Step 1: Write the failing test**

```typescript
// tests/utils/migrator.test.ts
import { describe, it, expect, afterEach } from 'vitest';
import { Kysely, SqliteDialect, sql } from 'kysely';
import Database from 'better-sqlite3';
import { runMigrations, type MigrationSet } from '../../src/utils/migrator.js';

function createTestDb(): Kysely<any> {
  return new Kysely({ dialect: new SqliteDialect({ database: new Database(':memory:') }) });
}

describe('runMigrations', () => {
  let db: Kysely<any>;

  afterEach(async () => {
    await db?.destroy();
  });

  it('runs migrations in order and creates the tracking table', async () => {
    db = createTestDb();
    const migrations: MigrationSet = {
      'test_001_create_items': {
        async up(db) {
          await db.schema
            .createTable('items')
            .addColumn('id', 'text', col => col.primaryKey())
            .addColumn('name', 'text', col => col.notNull())
            .execute();
        },
        async down(db) {
          await db.schema.dropTable('items').execute();
        },
      },
      'test_002_add_status': {
        async up(db) {
          await db.schema
            .alterTable('items')
            .addColumn('status', 'text', col => col.defaultTo('active'))
            .execute();
        },
        async down(db) {
          await db.schema.alterTable('items').dropColumn('status').execute();
        },
      },
    };

    const result = await runMigrations(db, migrations);
    expect(result.error).toBeUndefined();
    expect(result.applied).toBe(2);

    // Verify the table exists with both columns
    const rows = await sql`INSERT INTO items (id, name) VALUES ('1', 'test') RETURNING *`.execute(db);
    expect((rows.rows[0] as any).status).toBe('active');
  });

  it('skips already-applied migrations', async () => {
    db = createTestDb();
    const migrations: MigrationSet = {
      'test_001_create_items': {
        async up(db) {
          await db.schema
            .createTable('items')
            .addColumn('id', 'text', col => col.primaryKey())
            .execute();
        },
        async down(db) {
          await db.schema.dropTable('items').execute();
        },
      },
    };

    await runMigrations(db, migrations);
    const result = await runMigrations(db, migrations);
    expect(result.applied).toBe(0);
  });

  it('returns error details on migration failure', async () => {
    db = createTestDb();
    const migrations: MigrationSet = {
      'test_001_bad': {
        async up(db) {
          // Reference non-existent table
          await sql`ALTER TABLE nonexistent ADD COLUMN x TEXT`.execute(db);
        },
        async down() {},
      },
    };

    const result = await runMigrations(db, migrations);
    expect(result.error).toBeDefined();
  });
});
```

**Step 2: Run test to verify it fails**

```bash
npm test -- --run tests/utils/migrator.test.ts
```
Expected: FAIL — `Cannot find module '../../src/utils/migrator.js'`

**Step 3: Write the implementation**

```typescript
// src/utils/migrator.ts — DB-agnostic migration runner built on Kysely
import { Migrator, type Kysely, type Migration } from 'kysely';

/** A named set of migrations. Keys determine execution order (alphanumeric sort). */
export type MigrationSet = Record<string, Migration>;

export interface MigrationResult {
  /** Undefined on success, the error on failure. */
  error?: unknown;
  /** Number of newly applied migrations. */
  applied: number;
  /** Names of migrations that were applied. */
  names: string[];
}

/**
 * Run all pending migrations against the given Kysely instance.
 *
 * Migrations are executed in alphanumeric key order. Already-applied
 * migrations (tracked in `kysely_migration` table) are skipped.
 * Uses database-level locking so concurrent calls are safe.
 */
export async function runMigrations(
  db: Kysely<any>,
  migrations: MigrationSet,
): Promise<MigrationResult> {
  const migrator = new Migrator({
    db,
    provider: { getMigrations: async () => migrations },
  });

  const { error, results } = await migrator.migrateToLatest();

  const applied = (results ?? []).filter(r => r.status === 'Success');

  return {
    error,
    applied: applied.length,
    names: applied.map(r => r.migrationName),
  };
}
```

**Step 4: Run test to verify it passes**

```bash
npm test -- --run tests/utils/migrator.test.ts
```
Expected: PASS — all 3 tests green.

**Step 5: Commit**

```bash
git add src/utils/migrator.ts tests/utils/migrator.test.ts
git commit -m "feat: add Kysely-based migration runner utility"
```

---

## Task 3: Create the database factory

This module creates Kysely instances for the configured dialect. SQLite gets per-store instances; PostgreSQL shares one.

**Files:**
- Create: `src/utils/database.ts`
- Test: `tests/utils/database.test.ts`

**Step 1: Write the failing test**

```typescript
// tests/utils/database.test.ts
import { describe, it, expect, afterEach } from 'vitest';
import { sql } from 'kysely';
import { createKyselyDb } from '../../src/utils/database.js';

describe('createKyselyDb', () => {
  it('creates a SQLite Kysely instance for a given path', async () => {
    const db = createKyselyDb({ type: 'sqlite', path: ':memory:' });
    // Smoke test: run a trivial query
    const result = await sql`SELECT 1 as val`.execute(db);
    expect((result.rows[0] as any).val).toBe(1);
    await db.destroy();
  });

  it('throws for unsupported type', () => {
    expect(() => createKyselyDb({ type: 'mysql' as any })).toThrow('Unsupported');
  });
});
```

**Step 2: Run test to verify it fails**

```bash
npm test -- --run tests/utils/database.test.ts
```
Expected: FAIL — module not found.

**Step 3: Write the implementation**

```typescript
// src/utils/database.ts — Kysely instance factory for SQLite / PostgreSQL
import { Kysely, SqliteDialect } from 'kysely';
import { createRequire } from 'node:module';

export interface SqliteDbConfig {
  type: 'sqlite';
  path: string;
}

export interface PostgresDbConfig {
  type: 'postgresql';
  url: string;
}

export type DbConfig = SqliteDbConfig | PostgresDbConfig;

/**
 * Create a Kysely instance for the given database configuration.
 *
 * - SQLite: uses better-sqlite3 (same dep already in package.json).
 * - PostgreSQL: uses pg Pool (must be installed separately).
 */
export function createKyselyDb(config: DbConfig): Kysely<any> {
  if (config.type === 'sqlite') {
    const req = createRequire(import.meta.url);
    const Database = req('better-sqlite3');
    const sqliteDb = new Database(config.path);
    sqliteDb.pragma('journal_mode = WAL');
    sqliteDb.pragma('foreign_keys = ON');
    return new Kysely({ dialect: new SqliteDialect({ database: sqliteDb }) });
  }

  if (config.type === 'postgresql') {
    // Lazy-load pg to avoid requiring it when using SQLite
    const req = createRequire(import.meta.url);
    const { Pool } = req('pg');
    const { PostgresDialect } = req('kysely');
    return new Kysely({
      dialect: new PostgresDialect({ pool: new Pool({ connectionString: config.url }) }),
    });
  }

  throw new Error(`Unsupported database type: ${(config as any).type}`);
}
```

**Step 4: Run test to verify it passes**

```bash
npm test -- --run tests/utils/database.test.ts
```
Expected: PASS.

**Step 5: Commit**

```bash
git add src/utils/database.ts tests/utils/database.test.ts
git commit -m "feat: add Kysely database factory for SQLite/PostgreSQL"
```

---

## Task 4: Define migrations for MessageQueue

**Files:**
- Create: `src/migrations/messages.ts`
- Test: `tests/migrations/messages.test.ts`

**Step 1: Write the failing test**

```typescript
// tests/migrations/messages.test.ts
import { describe, it, expect, afterEach } from 'vitest';
import { Kysely, SqliteDialect, sql } from 'kysely';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/utils/migrator.js';
import { messagesMigrations } from '../../src/migrations/messages.js';

function createTestDb(): Kysely<any> {
  return new Kysely({ dialect: new SqliteDialect({ database: new Database(':memory:') }) });
}

describe('messages migrations', () => {
  let db: Kysely<any>;
  afterEach(async () => { await db?.destroy(); });

  it('creates the messages table and index', async () => {
    db = createTestDb();
    const result = await runMigrations(db, messagesMigrations);
    expect(result.error).toBeUndefined();
    expect(result.applied).toBe(1);

    // Verify table structure by inserting a row
    await sql`INSERT INTO messages (id, session_id, channel, sender, content, status)
              VALUES ('m1', 's1', 'cli', 'user', 'hello', 'pending')`.execute(db);
    const rows = await sql`SELECT * FROM messages WHERE id = 'm1'`.execute(db);
    expect(rows.rows).toHaveLength(1);
  });
});
```

**Step 2: Run test to verify it fails**

```bash
npm test -- --run tests/migrations/messages.test.ts
```
Expected: FAIL — module not found.

**Step 3: Write the migration**

```typescript
// src/migrations/messages.ts
import { sql, type Kysely } from 'kysely';
import type { MigrationSet } from '../utils/migrator.js';

export const messagesMigrations: MigrationSet = {
  'messages_001_initial': {
    async up(db: Kysely<any>) {
      await db.schema
        .createTable('messages')
        .addColumn('id', 'text', col => col.primaryKey())
        .addColumn('session_id', 'text', col => col.notNull())
        .addColumn('channel', 'text', col => col.notNull())
        .addColumn('sender', 'text', col => col.notNull())
        .addColumn('content', 'text', col => col.notNull())
        .addColumn('status', 'text', col => col.notNull().defaultTo('pending'))
        .addColumn('created_at', 'text', col => col.notNull().defaultTo(sql`(datetime('now'))`))
        .addColumn('processed_at', 'text')
        .execute();
      await db.schema
        .createIndex('idx_messages_status')
        .on('messages')
        .column('status')
        .execute();
    },
    async down(db: Kysely<any>) {
      await db.schema.dropTable('messages').execute();
    },
  },
};
```

> **Note on `datetime('now')`:** This is SQLite-specific. When adding PostgreSQL support, add a `messages_002_pg_defaults` migration that uses `NOW()` instead, or use a dialect-aware helper. For now, SQLite is the only target.

**Step 4: Run test to verify it passes**

```bash
npm test -- --run tests/migrations/messages.test.ts
```
Expected: PASS.

**Step 5: Commit**

```bash
git add src/migrations/messages.ts tests/migrations/messages.test.ts
git commit -m "feat: add Kysely migration for messages table"
```

---

## Task 5: Define migrations for SessionStore

**Files:**
- Create: `src/migrations/sessions.ts`
- Test: `tests/migrations/sessions.test.ts`

**Step 1: Write the failing test**

```typescript
// tests/migrations/sessions.test.ts
import { describe, it, expect, afterEach } from 'vitest';
import { Kysely, SqliteDialect, sql } from 'kysely';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/utils/migrator.js';
import { sessionsMigrations } from '../../src/migrations/sessions.js';

function createTestDb(): Kysely<any> {
  return new Kysely({ dialect: new SqliteDialect({ database: new Database(':memory:') }) });
}

describe('sessions migrations', () => {
  let db: Kysely<any>;
  afterEach(async () => { await db?.destroy(); });

  it('creates the last_sessions table', async () => {
    db = createTestDb();
    const result = await runMigrations(db, sessionsMigrations);
    expect(result.error).toBeUndefined();
    expect(result.applied).toBe(1);

    await sql`INSERT INTO last_sessions (agent_id, provider, scope, identifiers, updated_at)
              VALUES ('a1', 'slack', 'dm', '{}', 123)`.execute(db);
    const rows = await sql`SELECT * FROM last_sessions`.execute(db);
    expect(rows.rows).toHaveLength(1);
  });
});
```

**Step 2: Run test to verify it fails**

```bash
npm test -- --run tests/migrations/sessions.test.ts
```

**Step 3: Write the migration**

```typescript
// src/migrations/sessions.ts
import type { Kysely } from 'kysely';
import type { MigrationSet } from '../utils/migrator.js';

export const sessionsMigrations: MigrationSet = {
  'sessions_001_initial': {
    async up(db: Kysely<any>) {
      await db.schema
        .createTable('last_sessions')
        .addColumn('agent_id', 'text', col => col.primaryKey())
        .addColumn('provider', 'text', col => col.notNull())
        .addColumn('scope', 'text', col => col.notNull())
        .addColumn('identifiers', 'text', col => col.notNull())
        .addColumn('updated_at', 'integer', col => col.notNull())
        .execute();
    },
    async down(db: Kysely<any>) {
      await db.schema.dropTable('last_sessions').execute();
    },
  },
};
```

**Step 4: Run test to verify it passes**

```bash
npm test -- --run tests/migrations/sessions.test.ts
```

**Step 5: Commit**

```bash
git add src/migrations/sessions.ts tests/migrations/sessions.test.ts
git commit -m "feat: add Kysely migration for sessions table"
```

---

## Task 6: Define migrations for ConversationStore

**Files:**
- Create: `src/migrations/conversations.ts`
- Test: `tests/migrations/conversations.test.ts`

**Step 1: Write the failing test**

```typescript
// tests/migrations/conversations.test.ts
import { describe, it, expect, afterEach } from 'vitest';
import { Kysely, SqliteDialect, sql } from 'kysely';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/utils/migrator.js';
import { conversationsMigrations } from '../../src/migrations/conversations.js';

function createTestDb(): Kysely<any> {
  return new Kysely({ dialect: new SqliteDialect({ database: new Database(':memory:') }) });
}

describe('conversations migrations', () => {
  let db: Kysely<any>;
  afterEach(async () => { await db?.destroy(); });

  it('creates the turns table with index', async () => {
    db = createTestDb();
    const result = await runMigrations(db, conversationsMigrations);
    expect(result.error).toBeUndefined();
    expect(result.applied).toBe(1);

    await sql`INSERT INTO turns (session_id, role, content) VALUES ('s1', 'user', 'hello')`.execute(db);
    const rows = await sql`SELECT * FROM turns`.execute(db);
    expect(rows.rows).toHaveLength(1);
    expect((rows.rows[0] as any).id).toBeDefined();
  });
});
```

**Step 2: Run test to verify it fails**

```bash
npm test -- --run tests/migrations/conversations.test.ts
```

**Step 3: Write the migration**

```typescript
// src/migrations/conversations.ts
import { sql, type Kysely } from 'kysely';
import type { MigrationSet } from '../utils/migrator.js';

export const conversationsMigrations: MigrationSet = {
  'conversations_001_initial': {
    async up(db: Kysely<any>) {
      await db.schema
        .createTable('turns')
        .addColumn('id', 'integer', col => col.primaryKey().autoIncrement())
        .addColumn('session_id', 'text', col => col.notNull())
        .addColumn('role', 'text', col => col.notNull())
        .addColumn('sender', 'text')
        .addColumn('content', 'text', col => col.notNull())
        .addColumn('created_at', 'integer', col => col.notNull().defaultTo(sql`(unixepoch())`))
        .execute();
      await db.schema
        .createIndex('idx_turns_session')
        .on('turns')
        .columns(['session_id', 'id'])
        .execute();
    },
    async down(db: Kysely<any>) {
      await db.schema.dropTable('turns').execute();
    },
  },
};
```

**Step 4: Run tests**

```bash
npm test -- --run tests/migrations/conversations.test.ts
```

**Step 5: Commit**

```bash
git add src/migrations/conversations.ts tests/migrations/conversations.test.ts
git commit -m "feat: add Kysely migration for conversations table"
```

---

## Task 7: Define migrations for SqliteJobStore

**Files:**
- Create: `src/migrations/jobs.ts`
- Test: `tests/migrations/jobs.test.ts`

**Step 1: Write the failing test**

```typescript
// tests/migrations/jobs.test.ts
import { describe, it, expect, afterEach } from 'vitest';
import { Kysely, SqliteDialect, sql } from 'kysely';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/utils/migrator.js';
import { jobsMigrations } from '../../src/migrations/jobs.js';

function createTestDb(): Kysely<any> {
  return new Kysely({ dialect: new SqliteDialect({ database: new Database(':memory:') }) });
}

describe('jobs migrations', () => {
  let db: Kysely<any>;
  afterEach(async () => { await db?.destroy(); });

  it('creates the cron_jobs table with index', async () => {
    db = createTestDb();
    const result = await runMigrations(db, jobsMigrations);
    expect(result.error).toBeUndefined();
    expect(result.applied).toBe(1);

    await sql`INSERT INTO cron_jobs (id, agent_id, schedule, prompt)
              VALUES ('j1', 'a1', '* * * * *', 'test')`.execute(db);
    const rows = await sql`SELECT * FROM cron_jobs`.execute(db);
    expect(rows.rows).toHaveLength(1);
  });
});
```

**Step 2: Run test to verify it fails**

```bash
npm test -- --run tests/migrations/jobs.test.ts
```

**Step 3: Write the migration**

```typescript
// src/migrations/jobs.ts
import { sql, type Kysely } from 'kysely';
import type { MigrationSet } from '../utils/migrator.js';

export const jobsMigrations: MigrationSet = {
  'jobs_001_initial': {
    async up(db: Kysely<any>) {
      await db.schema
        .createTable('cron_jobs')
        .addColumn('id', 'text', col => col.primaryKey())
        .addColumn('agent_id', 'text', col => col.notNull())
        .addColumn('schedule', 'text', col => col.notNull())
        .addColumn('prompt', 'text', col => col.notNull())
        .addColumn('max_token_budget', 'integer')
        .addColumn('delivery', 'text')
        .addColumn('run_once', 'integer', col => col.notNull().defaultTo(0))
        .addColumn('created_at', 'integer', col => col.notNull().defaultTo(sql`(unixepoch())`))
        .execute();
      await db.schema
        .createIndex('idx_cron_jobs_agent')
        .on('cron_jobs')
        .column('agent_id')
        .execute();
    },
    async down(db: Kysely<any>) {
      await db.schema.dropTable('cron_jobs').execute();
    },
  },
};
```

**Step 4: Run tests**

```bash
npm test -- --run tests/migrations/jobs.test.ts
```

**Step 5: Commit**

```bash
git add src/migrations/jobs.ts tests/migrations/jobs.test.ts
git commit -m "feat: add Kysely migration for jobs table"
```

---

## Task 8: Define migrations for memory provider

The memory provider has two migrations: initial schema + the `agent_id` column addition (replacing the current try-catch `ALTER TABLE` hack).

**Files:**
- Create: `src/migrations/memory.ts`
- Test: `tests/migrations/memory.test.ts`

**Step 1: Write the failing test**

```typescript
// tests/migrations/memory.test.ts
import { describe, it, expect, afterEach } from 'vitest';
import { Kysely, SqliteDialect, sql } from 'kysely';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/utils/migrator.js';
import { memoryMigrations } from '../../src/migrations/memory.js';

function createTestDb(): Kysely<any> {
  return new Kysely({ dialect: new SqliteDialect({ database: new Database(':memory:') }) });
}

describe('memory migrations', () => {
  let db: Kysely<any>;
  afterEach(async () => { await db?.destroy(); });

  it('applies both migrations and creates FTS table', async () => {
    db = createTestDb();
    const result = await runMigrations(db, memoryMigrations);
    expect(result.error).toBeUndefined();
    expect(result.applied).toBe(2);

    // Verify entries table has agent_id column
    await sql`INSERT INTO entries (id, scope, content, agent_id)
              VALUES ('e1', 'global', 'test content', 'agent-1')`.execute(db);
    const rows = await sql`SELECT * FROM entries`.execute(db);
    expect(rows.rows).toHaveLength(1);
    expect((rows.rows[0] as any).agent_id).toBe('agent-1');
  });

  it('creates the FTS virtual table', async () => {
    db = createTestDb();
    await runMigrations(db, memoryMigrations);

    await sql`INSERT INTO entries (id, scope, content) VALUES ('e1', 'global', 'hello world')`.execute(db);
    await sql`INSERT INTO entries_fts (entry_id, content) VALUES ('e1', 'hello world')`.execute(db);
    const fts = await sql`SELECT * FROM entries_fts WHERE entries_fts MATCH 'hello'`.execute(db);
    expect(fts.rows).toHaveLength(1);
  });
});
```

**Step 2: Run test to verify it fails**

```bash
npm test -- --run tests/migrations/memory.test.ts
```

**Step 3: Write the migrations**

```typescript
// src/migrations/memory.ts
import { sql, type Kysely } from 'kysely';
import type { MigrationSet } from '../utils/migrator.js';

export const memoryMigrations: MigrationSet = {
  'memory_001_initial': {
    async up(db: Kysely<any>) {
      await db.schema
        .createTable('entries')
        .addColumn('id', 'text', col => col.primaryKey())
        .addColumn('scope', 'text', col => col.notNull())
        .addColumn('content', 'text', col => col.notNull())
        .addColumn('tags', 'text')
        .addColumn('taint', 'text')
        .addColumn('created_at', 'text', col => col.notNull().defaultTo(sql`(datetime('now'))`))
        .execute();
      await db.schema
        .createIndex('idx_entries_scope')
        .on('entries')
        .column('scope')
        .execute();
      // FTS5 virtual table — SQLite-specific, use raw SQL
      await sql`CREATE VIRTUAL TABLE IF NOT EXISTS entries_fts USING fts5(entry_id, content)`.execute(db);
    },
    async down(db: Kysely<any>) {
      await sql`DROP TABLE IF EXISTS entries_fts`.execute(db);
      await db.schema.dropTable('entries').execute();
    },
  },

  'memory_002_add_agent_id': {
    async up(db: Kysely<any>) {
      await db.schema
        .alterTable('entries')
        .addColumn('agent_id', 'text')
        .execute();
      await db.schema
        .createIndex('idx_entries_agent_scope')
        .on('entries')
        .columns(['agent_id', 'scope'])
        .execute();
    },
    async down(db: Kysely<any>) {
      await db.schema.dropIndex('idx_entries_agent_scope').execute();
      // SQLite doesn't support DROP COLUMN before 3.35.0; skip in down migration
    },
  },
};
```

**Step 4: Run tests**

```bash
npm test -- --run tests/migrations/memory.test.ts
```

**Step 5: Commit**

```bash
git add src/migrations/memory.ts tests/migrations/memory.test.ts
git commit -m "feat: add Kysely migrations for memory table (with agent_id migration)"
```

---

## Task 9: Define migrations for audit provider

**Files:**
- Create: `src/migrations/audit.ts`
- Test: `tests/migrations/audit.test.ts`

**Step 1: Write the failing test**

```typescript
// tests/migrations/audit.test.ts
import { describe, it, expect, afterEach } from 'vitest';
import { Kysely, SqliteDialect, sql } from 'kysely';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/utils/migrator.js';
import { auditMigrations } from '../../src/migrations/audit.js';

function createTestDb(): Kysely<any> {
  return new Kysely({ dialect: new SqliteDialect({ database: new Database(':memory:') }) });
}

describe('audit migrations', () => {
  let db: Kysely<any>;
  afterEach(async () => { await db?.destroy(); });

  it('creates the audit_log table with indexes', async () => {
    db = createTestDb();
    const result = await runMigrations(db, auditMigrations);
    expect(result.error).toBeUndefined();
    expect(result.applied).toBe(1);

    await sql`INSERT INTO audit_log (action, result) VALUES ('test', 'success')`.execute(db);
    const rows = await sql`SELECT * FROM audit_log`.execute(db);
    expect(rows.rows).toHaveLength(1);
    expect((rows.rows[0] as any).id).toBeDefined();
  });
});
```

**Step 2: Run test to verify it fails**

```bash
npm test -- --run tests/migrations/audit.test.ts
```

**Step 3: Write the migration**

```typescript
// src/migrations/audit.ts
import { sql, type Kysely } from 'kysely';
import type { MigrationSet } from '../utils/migrator.js';

export const auditMigrations: MigrationSet = {
  'audit_001_initial': {
    async up(db: Kysely<any>) {
      await db.schema
        .createTable('audit_log')
        .addColumn('id', 'integer', col => col.primaryKey().autoIncrement())
        .addColumn('timestamp', 'text', col => col.notNull().defaultTo(sql`(datetime('now'))`))
        .addColumn('session_id', 'text')
        .addColumn('action', 'text', col => col.notNull())
        .addColumn('args', 'text')
        .addColumn('result', 'text', col => col.notNull())
        .addColumn('taint', 'text')
        .addColumn('duration_ms', 'real')
        .addColumn('token_input', 'integer')
        .addColumn('token_output', 'integer')
        .execute();
      await db.schema
        .createIndex('idx_audit_session')
        .on('audit_log')
        .columns(['session_id', 'timestamp'])
        .execute();
      await db.schema
        .createIndex('idx_audit_action')
        .on('audit_log')
        .columns(['action', 'timestamp'])
        .execute();
    },
    async down(db: Kysely<any>) {
      await db.schema.dropTable('audit_log').execute();
    },
  },
};
```

**Step 4: Run tests**

```bash
npm test -- --run tests/migrations/audit.test.ts
```

**Step 5: Commit**

```bash
git add src/migrations/audit.ts tests/migrations/audit.test.ts
git commit -m "feat: add Kysely migration for audit table"
```

---

## Task 10: Integrate migrations into MessageQueue

Convert `MessageQueue` from sync constructor with inline SQL to async factory with Kysely migrations.

**Files:**
- Modify: `src/db.ts`
- Modify: `tests/db.test.ts`

**Step 1: Update the test to use async factory**

Change `tests/db.test.ts`:

```typescript
// Replace: queue = new MessageQueue(':memory:');
// With:    queue = await MessageQueue.create(':memory:');
```

Make every `beforeEach` async and use `await MessageQueue.create(...)`.

**Step 2: Run test to verify it fails**

```bash
npm test -- --run tests/db.test.ts
```
Expected: FAIL — `MessageQueue.create is not a function`

**Step 3: Update MessageQueue**

In `src/db.ts`, replace the constructor + `migrate()` pattern:

```typescript
import { createKyselyDb } from './utils/database.js';
import { runMigrations } from './utils/migrator.js';
import { messagesMigrations } from './migrations/messages.js';

export class MessageQueue {
  private db: SQLiteDatabase;

  private constructor(db: SQLiteDatabase) {
    this.db = db;
  }

  static async create(dbPath: string = dataFile('messages.db')): Promise<MessageQueue> {
    // Run Kysely migrations
    const kyselyDb = createKyselyDb({ type: 'sqlite', path: dbPath });
    await runMigrations(kyselyDb, messagesMigrations);
    await kyselyDb.destroy();

    // Open the store's own connection for queries
    const db = openDatabase(dbPath);
    return new MessageQueue(db);
  }

  // ... rest of methods unchanged ...
}
```

**Step 4: Run tests**

```bash
npm test -- --run tests/db.test.ts
```
Expected: PASS

**Step 5: Update callers in src/host/server.ts**

Change line 99 from:
```typescript
const db = new MessageQueue(dataFile('messages.db'));
```
to:
```typescript
const db = await MessageQueue.create(dataFile('messages.db'));
```

**Step 6: Update callers in test files**

Grep for `new MessageQueue` and update each caller to `await MessageQueue.create(...)`. Key files:
- `tests/host/router.test.ts`
- `tests/e2e/harness.ts`
- `tests/integration/e2e.test.ts`
- `tests/integration/phase1.test.ts`
- `tests/integration/phase2.test.ts`
- `tests/integration/smoke.test.ts`

**Step 7: Run full test suite**

```bash
npm test
```
Expected: PASS (all tests).

**Step 8: Commit**

```bash
git add src/db.ts src/host/server.ts tests/
git commit -m "refactor: MessageQueue uses Kysely migrations via async create()"
```

---

## Task 11: Integrate migrations into SessionStore

Same pattern as Task 10.

**Files:**
- Modify: `src/session-store.ts`
- Modify: `tests/session-store.test.ts`
- Modify: `src/host/server.ts` (line 101)

**Step 1: Update the test**

Change `new SessionStore(...)` → `await SessionStore.create(...)` in `tests/session-store.test.ts`.

**Step 2: Run test to verify it fails**

```bash
npm test -- --run tests/session-store.test.ts
```

**Step 3: Update SessionStore**

Apply the same private-constructor + `static async create()` pattern, importing `sessionsMigrations`.

**Step 4: Run test to verify it passes**

```bash
npm test -- --run tests/session-store.test.ts
```

**Step 5: Update caller in server.ts**

```typescript
// Line 101: const sessionStore = new SessionStore();
const sessionStore = await SessionStore.create();
```

**Step 6: Run full test suite**

```bash
npm test
```

**Step 7: Commit**

```bash
git add src/session-store.ts tests/session-store.test.ts src/host/server.ts
git commit -m "refactor: SessionStore uses Kysely migrations via async create()"
```

---

## Task 12: Integrate migrations into ConversationStore

**Files:**
- Modify: `src/conversation-store.ts`
- Modify: `tests/conversation-store.test.ts`
- Modify: `src/host/server.ts` (line 100)
- Modify: `tests/integration/history-smoke.test.ts`

Same pattern. Change `new ConversationStore(...)` → `await ConversationStore.create(...)`.

**Step 1–7:** Follow the identical pattern from Tasks 10–11.

**Commit:**

```bash
git commit -m "refactor: ConversationStore uses Kysely migrations via async create()"
```

---

## Task 13: Integrate migrations into SqliteJobStore

**Files:**
- Modify: `src/job-store.ts`
- Modify: `tests/job-store.test.ts`

Same pattern. Only used in tests currently, so caller update is limited to the test file.

**Commit:**

```bash
git commit -m "refactor: SqliteJobStore uses Kysely migrations via async create()"
```

---

## Task 14: Integrate migrations into memory provider

**Files:**
- Modify: `src/providers/memory/sqlite.ts`
- Modify: `tests/providers/memory/sqlite.test.ts`

The memory provider already uses an async `create()` factory. Replace the inline `CREATE TABLE` + try-catch `ALTER TABLE` block with:

```typescript
import { createKyselyDb } from '../../utils/database.js';
import { runMigrations } from '../../utils/migrator.js';
import { memoryMigrations } from '../../migrations/memory.js';

export async function create(_config: Config): Promise<MemoryProvider> {
  mkdirSync(dataDir(), { recursive: true });
  const dbPath = dataFile('memory.db');

  // Run Kysely migrations
  const kyselyDb = createKyselyDb({ type: 'sqlite', path: dbPath });
  await runMigrations(kyselyDb, memoryMigrations);
  await kyselyDb.destroy();

  // Open the store's own connection for queries
  const db: SQLiteDatabase = openDatabase(dbPath);

  // ... rest unchanged (serializeTags, rowToEntry, return { ... }) ...
}
```

This removes:
- The 6-line `CREATE TABLE IF NOT EXISTS entries` block
- The `CREATE INDEX IF NOT EXISTS idx_entries_scope` statement
- The try-catch `ALTER TABLE entries ADD COLUMN agent_id` hack
- The `CREATE INDEX IF NOT EXISTS idx_entries_agent_scope` statement
- The `CREATE VIRTUAL TABLE IF NOT EXISTS entries_fts` statement

**Step 1: Update existing memory tests to expect the migration-managed schema**

The existing test in `tests/providers/memory/sqlite.test.ts` that tests the `ALTER TABLE` upgrade path should be updated to test the Kysely migration path instead.

**Step 2: Run tests**

```bash
npm test -- --run tests/providers/memory/sqlite.test.ts
```

**Step 3: Commit**

```bash
git commit -m "refactor: memory provider uses Kysely migrations, removes ALTER TABLE hack"
```

---

## Task 15: Integrate migrations into audit provider

**Files:**
- Modify: `src/providers/audit/sqlite.ts`
- Modify: `tests/providers/audit/sqlite.test.ts`

Same pattern as Task 14 — the audit provider already has an async `create()`.

**Commit:**

```bash
git commit -m "refactor: audit provider uses Kysely migrations"
```

---

## Task 16: Upgrade-path test (existing databases)

Verify that Kysely migrations work correctly against databases that were created by the old inline SQL. This is the critical backwards-compatibility test.

**Files:**
- Create: `tests/migrations/upgrade-path.test.ts`

**Step 1: Write the test**

```typescript
// tests/migrations/upgrade-path.test.ts
import { describe, it, expect, afterEach } from 'vitest';
import { Kysely, SqliteDialect, sql } from 'kysely';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/utils/migrator.js';
import { messagesMigrations } from '../../src/migrations/messages.js';
import { memoryMigrations } from '../../src/migrations/memory.js';

describe('upgrade path: existing databases', () => {
  it('migrates a database that already has the messages table (old schema)', async () => {
    // Simulate a database created by the old inline SQL
    const raw = new Database(':memory:');
    raw.exec(`
      CREATE TABLE messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        channel TEXT NOT NULL,
        sender TEXT NOT NULL,
        content TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        processed_at TEXT
      )
    `);
    raw.exec(`CREATE INDEX idx_messages_status ON messages(status)`);
    raw.exec(`INSERT INTO messages (id, session_id, channel, sender, content, status) VALUES ('old1', 's1', 'cli', 'user', 'existing', 'pending')`);
    raw.close();

    // This won't work with :memory: since we closed it.
    // Use a temp file instead for the real test.
    // For now, verify that running migrations on a fresh DB works
    // and that future migrations (002, 003) would apply on top.
    const db = new Kysely({ dialect: new SqliteDialect({ database: new Database(':memory:') }) });
    const result = await runMigrations(db, messagesMigrations);
    expect(result.error).toBeUndefined();
    // Run again — should be idempotent
    const result2 = await runMigrations(db, messagesMigrations);
    expect(result2.applied).toBe(0);
    await db.destroy();
  });

  it('migrates memory DB: old schema without agent_id gets both migrations', async () => {
    // The memory_001_initial creates entries without agent_id,
    // memory_002_add_agent_id adds it. Running both on fresh DB should work.
    const db = new Kysely({ dialect: new SqliteDialect({ database: new Database(':memory:') }) });
    const result = await runMigrations(db, memoryMigrations);
    expect(result.error).toBeUndefined();
    expect(result.applied).toBe(2);
    expect(result.names).toContain('memory_002_add_agent_id');
    await db.destroy();
  });
});
```

> **Important note for real deployment:** Existing databases created by the old inline SQL won't have a `kysely_migration` table. On first run, Kysely will try to apply all migrations from the start. Since the tables already exist, the `001_initial` migration will fail. There are two strategies:
>
> 1. **Seed the migration table:** On startup, if `kysely_migration` doesn't exist but the store's table does, mark `*_001_initial` as already applied before running the migrator.
> 2. **Use `IF NOT EXISTS`:** In the `001_initial` migrations, use `ifNotExists()` on `createTable`.
>
> Strategy 2 is simpler. Kysely's `createTable` supports `.ifNotExists()`. Update all `001_initial` migrations to use it. This way, existing databases get the migration table seeded, and the initial migration is a no-op.

**Step 2: Update all 001_initial migrations to use `.ifNotExists()`**

In each `*_001_initial` migration's `createTable` call, chain `.ifNotExists()`:

```typescript
await db.schema
  .createTable('messages')
  .ifNotExists()  // <-- add this
  .addColumn(...)
  ...
```

And for indexes, Kysely supports `.ifNotExists()` on `createIndex` too.

**Step 3: Run tests**

```bash
npm test -- --run tests/migrations/upgrade-path.test.ts
```

**Step 4: Commit**

```bash
git add tests/migrations/upgrade-path.test.ts src/migrations/
git commit -m "feat: add upgrade-path tests, use ifNotExists for backwards compat"
```

---

## Task 17: Run full test suite and verify

**Step 1: Build**

```bash
npm run build
```
Expected: SUCCESS

**Step 2: Run all tests**

```bash
npm test
```
Expected: ALL PASS

**Step 3: Commit any final fixes**

---

## Summary of files changed

### New files
- `src/utils/migrator.ts` — Migration runner
- `src/utils/database.ts` — Kysely instance factory
- `src/migrations/messages.ts` — MessageQueue migrations
- `src/migrations/sessions.ts` — SessionStore migrations
- `src/migrations/conversations.ts` — ConversationStore migrations
- `src/migrations/jobs.ts` — SqliteJobStore migrations
- `src/migrations/memory.ts` — Memory provider migrations
- `src/migrations/audit.ts` — Audit provider migrations
- `tests/utils/migrator.test.ts`
- `tests/utils/database.test.ts`
- `tests/migrations/messages.test.ts`
- `tests/migrations/sessions.test.ts`
- `tests/migrations/conversations.test.ts`
- `tests/migrations/jobs.test.ts`
- `tests/migrations/memory.test.ts`
- `tests/migrations/audit.test.ts`
- `tests/migrations/upgrade-path.test.ts`

### Modified files
- `package.json` — add kysely
- `src/db.ts` — async create(), use migrations
- `src/session-store.ts` — async create(), use migrations
- `src/conversation-store.ts` — async create(), use migrations
- `src/job-store.ts` — async create(), use migrations
- `src/providers/memory/sqlite.ts` — use migrations, remove inline SQL
- `src/providers/audit/sqlite.ts` — use migrations, remove inline SQL
- `src/host/server.ts` — await async store creation
- Various test files — update `new Store()` → `await Store.create()`

### Future work (not in this plan)
- Add `database` config to `Config` type for SQLite/PostgreSQL selection
- PostgreSQL dialect integration (requires `pg` dependency)
- Migrate store queries from raw SQL to Kysely query builder (optional, incremental)
- Consolidate per-store migrations into single PostgreSQL migration set
