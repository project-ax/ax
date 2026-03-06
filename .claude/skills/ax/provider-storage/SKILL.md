---
name: ax-provider-storage
description: Use when modifying persistent storage — message queues, conversations, sessions, documents, or database/file storage backends in src/providers/storage/
---

## Overview

Unified persistent storage abstraction with four sub-stores: MessageQueue, ConversationStore, SessionStore, and DocumentStore. Two implementations: database-backed (SQLite/PostgreSQL via shared DatabaseProvider) and file-based (local dev). All operations are async.

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

## Implementations

| Provider   | File          | Backend                | Notes                                      |
|------------|---------------|------------------------|--------------------------------------------|
| `file`     | `file.ts`     | Flat files             | JSONL conversations, atomic rename for messages, safePath() for docs |
| `database` | `database.ts` | Shared DatabaseProvider | SQLite or PostgreSQL via Kysely            |

Provider map entries in `src/host/provider-map.ts`:
```
storage: {
  file:     '../providers/storage/file.js',
  database: '../providers/storage/database.js',
}
```

## File Provider Details

- Conversations stored as JSONL files (one line per turn, `\n` separator).
- Message queue uses atomic rename (write to tmp file, then rename to target) to prevent partial reads.
- Document store uses `safePath()` to prevent path traversal in collection/key names.
- Session file encodes colons in sessionIds (`:` → `_`) via safePath.
- Empty session returns `[]`, not an error.

## Database Provider Details

- Requires injected `DatabaseProvider` via `CreateOptions`; throws if missing.
- Migrations in `migrations.ts` — applied during startup.
- PostgreSQL `dequeue()` uses `FOR UPDATE SKIP LOCKED` for concurrent access; SQLite uses simple `LIMIT 1`.
- Document store does `ON CONFLICT` upsert (syntax differs between SQLite and PostgreSQL via sql template).
- `replaceTurnsWithSummary` is transactional (database) vs. manual multi-step (file) — atomicity guarantees differ.

## Common Tasks

**Adding a new sub-store:**
1. Define the interface in `types.ts`.
2. Implement in both `file.ts` and `database.ts`.
3. Add migration in `migrations.ts` for the database tables.
4. Expose on `StorageProvider` interface.
5. Add tests for both implementations.

**Adding a new storage backend:**
1. Create `src/providers/storage/<name>.ts` implementing `StorageProvider`.
2. Export `create(config: Config)`.
3. Add entry to `PROVIDER_MAP` in `src/host/provider-map.ts`.
4. Add tests in `tests/providers/storage/<name>.test.ts`.

## Gotchas

- **Both impls are async**: Even the file-based provider wraps sync operations in promises for interface consistency.
- **Database requires injected DatabaseProvider**: Don't create standalone DB connections — use the shared `DatabaseProvider` from `CreateOptions`.
- **Atomicity differs**: `replaceTurnsWithSummary` is transactional in database mode but multi-step in file mode. Race conditions possible with file backend under concurrent writes.
- **safePath for all document ops**: File provider uses `safePath()` on collection and key names. Path traversal in keys is blocked.
- **JSONL format**: Conversation files use newline-delimited JSON. Don't assume JSON array format.
- **SQLite autoincrement IDs**: After delete+insert, IDs don't respect logical ordering. Don't rely on ID order for conversation turn ordering.
- **Creating a MessageQueueStore in tests**: Requires full storage provider setup, not just the sub-store.
- **Structured content serialization**: Uses JSON detection on load — content can be string or structured object.

## Key Files

- `src/providers/storage/types.ts` — Interface definitions
- `src/providers/storage/file.ts` — File-based implementation
- `src/providers/storage/database.ts` — Database-backed implementation
- `src/providers/storage/migrations.ts` — Database schema migrations
- `tests/providers/storage/database.test.ts`
- `tests/providers/storage/file.test.ts`
