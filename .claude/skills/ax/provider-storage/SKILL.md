---
name: ax-provider-storage
description: Use when modifying persistent storage — message queues, conversations, sessions, documents, or database storage backends in src/providers/storage/
---

## Overview

Unified persistent storage abstraction with four sub-stores: MessageQueue, ConversationStore, SessionStore, and DocumentStore. Single implementation: database-backed (SQLite/PostgreSQL via shared DatabaseProvider). All operations are async.

The DocumentStore is also the source of truth for identity files and skills — they are stored in the 'identity' and 'skills' collections respectively, and sent to agents via stdin payload (no filesystem mounting needed).

## Interface (`src/providers/storage/types.ts`)

### StorageProvider

| Field           | Type                       | Notes                          |
|-----------------|----------------------------|--------------------------------|
| `messages`      | `MessageQueueStore`        | Enqueue/dequeue message queue  |
| `conversations` | `ConversationStoreProvider`| Conversation history           |
| `sessions`      | `SessionStoreProvider`     | Session tracking               |
| `documents`     | `DocumentStore`            | Key-value document store       |
| `close()`       | `void`                     | Tear down connections          |

### MessageQueueStore

| Method           | Description                              |
|------------------|------------------------------------------|
| `enqueue(msg)`   | Add message to queue; returns ID         |
| `dequeue()`      | Pop next pending message (or null)       |
| `dequeueById(id)`| Pop specific message by ID               |
| `complete(id)`   | Mark message as completed                |
| `fail(id)`       | Mark message as failed                   |
| `pending()`      | Count of pending messages                |

### ConversationStoreProvider

| Method                                        | Description                                    |
|-----------------------------------------------|------------------------------------------------|
| `append(sessionId, role, content, sender?)`   | Add a turn to conversation                     |
| `load(sessionId, maxTurns?)`                  | Load conversation history                      |
| `prune(sessionId, keep)`                      | Keep only the last N turns                     |
| `count(sessionId)`                            | Number of turns in session                     |
| `clear(sessionId)`                            | Delete all turns                               |
| `loadOlderTurns(sessionId, keepRecent)`       | Load turns older than keepRecent               |
| `replaceTurnsWithSummary(sessionId, maxIdToReplace, summaryContent)` | Replace old turns with summary |

### SessionStoreProvider

| Method                          | Description                              |
|---------------------------------|------------------------------------------|
| `trackSession(agentId, session)`| Record a session address                 |
| `getLastChannelSession(agentId)`| Get most recent session for an agent     |

### DocumentStore

| Method                     | Description                              |
|----------------------------|------------------------------------------|
| `get(collection, key)`    | Retrieve document content                |
| `put(collection, key, content)` | Store/upsert document               |
| `delete(collection, key)` | Delete document; returns boolean         |
| `list(collection)`        | List all keys in collection              |

#### Identity & Skills Collections

Identity files are stored in the `identity` collection:
- Agent-level: `key = '<agentId>/<filename>'` (e.g. `main/SOUL.md`)
- Per-user: `key = '<agentId>/users/<userId>/USER.md'`

Skills are stored in the `skills` collection:
- Agent-level: `key = '<agentId>/<relativePath>'` (e.g. `main/deploy.md`, `main/ops/checklist.md`)
- User-level (shadows agent): `key = '<agentId>/users/<userId>/<relativePath>'`

## Implementation

| Provider   | File          | Backend                | Notes                                      |
|------------|---------------|------------------------|--------------------------------------------|
| `database` | `database.ts` | Shared DatabaseProvider | SQLite or PostgreSQL via Kysely            |

Provider map entry in `src/host/provider-map.ts`:
```
storage: {
  database: '../providers/storage/database.js',
}
```

## Database Provider Details

- Requires injected `DatabaseProvider` via `CreateOptions`; throws if missing.
- Migrations in `migrations.ts` — applied during startup.
- PostgreSQL `dequeue()` uses `FOR UPDATE SKIP LOCKED` for concurrent access; SQLite uses simple `LIMIT 1`.
- Document store does `ON CONFLICT` upsert (syntax differs between SQLite and PostgreSQL via sql template).
- `replaceTurnsWithSummary` is transactional.

## Migration (`src/host/storage-migration.ts`)

On first boot after upgrade, `runStorageMigration()` imports existing filesystem identity files and skills into the DocumentStore. The migration is gated by a `migrated_storage_v1` flag. After migration, filesystem files become inert (not deleted, just ignored).

## Common Tasks

**Adding a new sub-store:**
1. Define the interface in `types.ts`.
2. Implement in `database.ts`.
3. Add migration in `migrations.ts` for the database tables.
4. Expose on `StorageProvider` interface.
5. Add tests.

## Gotchas

- **All operations are async**: Wraps sync operations in promises for interface consistency.
- **Database requires injected DatabaseProvider**: Don't create standalone DB connections — use the shared `DatabaseProvider` from `CreateOptions`.
- **safePath for all document ops**: Document keys can include `/` for subdirectory nesting — the DB treats them as opaque strings.
- **SQLite autoincrement IDs**: After delete+insert, IDs don't respect logical ordering. Don't rely on ID order for conversation turn ordering.
- **Creating a MessageQueueStore in tests**: Requires full storage provider setup, not just the sub-store.
- **Structured content serialization**: Uses JSON detection on load — content can be string or structured object.
- **Identity/skills are DB-backed**: IPC handlers dual-write to both filesystem and DB. The DB is the source of truth for the stdin payload.

## Key Files

- `src/providers/storage/types.ts` — Interface definitions
- `src/providers/storage/database.ts` — Database-backed implementation
- `src/providers/storage/migrations.ts` — Database schema migrations
- `src/host/storage-migration.ts` — Filesystem → DB migration
- `src/host/server-completions.ts` — `loadIdentityFromDB()`, `loadSkillsFromDB()`
- `tests/providers/storage/database.test.ts`
