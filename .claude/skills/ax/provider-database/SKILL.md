---
name: provider-database
description: Use when modifying the shared database connection factory — SQLite, PostgreSQL, vector extensions, or Kysely instance management in src/providers/database/
---

## Overview

The database provider is a shared connection factory for SQLite or PostgreSQL. Other providers (storage, audit, memory) depend on it rather than managing their own DB connections. One instance per AX process. Consumers run their own migrations against the shared Kysely instance.

## Interface (`src/providers/database/types.ts`)

### DatabaseProvider

| Field/Method       | Type                           | Notes                                      |
|--------------------|--------------------------------|--------------------------------------------|
| `db`               | `Kysely<any>`                  | Shared ORM instance (read-only property)   |
| `type`             | `'sqlite' \| 'postgresql'`    | Which backend is active                    |
| `vectorsAvailable` | `boolean`                      | Whether sqlite-vec or pgvector is loaded   |
| `close()`          | `Promise<void>`                | Shut down the connection pool              |

## Implementations

| Provider     | File          | Backend             | Notes                                      |
|--------------|---------------|---------------------|--------------------------------------------|
| `sqlite`     | `sqlite.ts`   | better-sqlite3      | Local-only, WAL mode + foreign keys on     |
| `postgresql` | `postgres.ts` | pg (node-postgres)  | Multi-pool, handles remote machines        |

Provider map entries in `src/host/provider-map.ts`:
```
database: {
  sqlite:     '../providers/database/sqlite.js',
  postgresql: '../providers/database/postgres.js',
}
```

## SQLite Details

- Uses better-sqlite3 with WAL journal mode and foreign keys enabled by default.
- Optional sqlite-vec extension for vector similarity search.
- Vector extension load failures are logged but don't throw — graceful degradation.

## PostgreSQL Details

- Uses pg (node-postgres) with connection pooling.
- Optional pgvector extension for vector similarity search.
- Handles multiple pools across machines.

## Common Tasks

**Adding a new database backend:**
1. Create `src/providers/database/<name>.ts` implementing `DatabaseProvider`.
2. Export `create(config: Config)`.
3. Add entry to `PROVIDER_MAP` in `src/host/provider-map.ts`.
4. Add tests in `tests/providers/database/<name>.test.ts`.

**Using the database in a new provider:**
1. Accept `DatabaseProvider` via `CreateOptions` in your provider's `create()`.
2. Run your own migrations against `db.db` (the Kysely instance).
3. Never create standalone DB connections — always use the shared instance.

## Gotchas

- **Consumers own their own migrations**: Each provider (storage, audit, memory) runs its own migrations against the shared Kysely instance. There is no centralized migration runner.
- **Vector extension is optional**: `vectorsAvailable` can be false. Always check before using vector operations.
- **SQLite is local-only**: Don't assume network-accessible database when `type === 'sqlite'`.
- **PostgreSQL `dequeue()` uses `FOR UPDATE SKIP LOCKED`**: Concurrency semantics differ between SQLite and PostgreSQL — consumer code must handle both.

## Key Files

- `src/providers/database/types.ts` — Interface definitions
- `src/providers/database/sqlite.ts` — SQLite implementation
- `src/providers/database/postgres.ts` — PostgreSQL implementation
- `tests/providers/database/sqlite.test.ts`
- `tests/providers/database/postgres.test.ts`
