---
name: ax-persistence
description: Use when modifying data persistence — conversation history (SQLite), message queue, or SQLite wrapper utilities in conversation-store.ts, db.ts, or utils/sqlite.ts
---

## Overview

AX persists data in two SQLite databases under `~/.ax/data/`. `ConversationStore` holds conversation history per session. `MessageQueue` tracks inbound messages through the scan/process/complete lifecycle. Both use the runtime-agnostic SQLite wrapper in `utils/sqlite.ts`.

## Key Files

| File | Responsibility |
|---|---|
| `src/conversation-store.ts` | Conversation history CRUD (append, load, prune, count, clear) |
| `src/db.ts` | Message queue with status-based lifecycle (pending/processing/done/error) |
| `src/utils/sqlite.ts` | Runtime-agnostic SQLite adapter: bun:sqlite, node:sqlite (22.5+), better-sqlite3 |

## ConversationStore

- **DB**: `~/.ax/data/conversations.db`
- **Table**: `turns` (id INTEGER PK, session_id TEXT, role TEXT, sender TEXT, content TEXT, created_at INTEGER)
- **Index**: `idx_turns_session` on (session_id, id)
- **Interface**: `StoredTurn` -- id, session_id, role, sender, content, created_at

| Method | Signature | Notes |
|---|---|---|
| `append` | `(sessionId, role, content, sender?)` | Inserts a turn |
| `load` | `(sessionId, maxTurns?)` | Returns last N turns oldest-first; omit maxTurns for all |
| `prune` | `(sessionId, keep)` | Deletes all but last `keep` turns |
| `count` | `(sessionId)` | Returns turn count for session |
| `clear` | `(sessionId)` | Deletes all turns for session |
| `close` | `()` | Closes the database connection |

Retention: controlled by `config.history.max_turns` (default 50) and `config.history.thread_context_turns` (default 5).

## Message Queue

- **DB**: `~/.ax/data/messages.db`
- **Table**: `messages` (id TEXT PK [UUID], session_id, channel, sender, content, status, created_at, processed_at)
- **Index**: `idx_messages_status` on (status)
- **Statuses**: pending -> processing -> done | error

| Method | Signature | Notes |
|---|---|---|
| `enqueue` | `({sessionId, channel, sender, content})` | Returns UUID; status = pending |
| `dequeue` | `()` | FIFO by created_at; atomically sets status = processing |
| `dequeueById` | `(id)` | Dequeue specific message by UUID; preferred over FIFO |
| `complete` | `(id)` | Sets status = done |
| `fail` | `(id)` | Sets status = error |
| `pending` | `()` | Returns count of pending messages |
| `close` | `()` | Closes the database connection |

## SQLite Wrapper (`utils/sqlite.ts`)

- **Priority**: bun:sqlite -> node:sqlite (22.5+) -> better-sqlite3
- **Interfaces**: `SQLiteDatabase` (exec, prepare, close), `SQLiteStatement` (run, get, all)
- **PRAGMAs set automatically**: `journal_mode = WAL`, `foreign_keys = ON`
- Uses `createRequire` for runtime detection (Bun global check)

## Common Tasks

**Adding a new persistent store:**
1. Create `src/my-store.ts` with a class wrapping `openDatabase(dataFile('my-store.db'))`
2. Add `migrate()` in constructor with `CREATE TABLE IF NOT EXISTS` + indexes
3. Export typed interface for rows
4. Call `mkdirSync(dataDir(), { recursive: true })` in the constructor or rely on `dataFile()` (the data dir must exist)
5. Add `close()` method and wire it into server shutdown

## Gotchas

- **Always `mkdirSync` before opening SQLite**: The `~/.ax/data/` directory may not exist on first run. Call `mkdirSync(dataDir(), { recursive: true })` or ensure the caller does.
- **Clean WAL/SHM in tests**: SQLite WAL mode creates `-wal` and `-shm` sidecar files. Test cleanup must remove all three: `db`, `db-wal`, `db-shm`.
- **Dequeue by ID, not FIFO**: The server uses `dequeueById(messageId)` to avoid session ID mismatches from stale messages. FIFO `dequeue()` exists but is not used in the main request path.
- **Close store on shutdown**: Both stores expose `close()`. Wire into server shutdown to avoid SQLite lock contention in tests and graceful exits.
- **`node:sqlite` uses `DatabaseSync`**: The Node.js built-in is synchronous (`DatabaseSync`), matching better-sqlite3's sync API. Bun's `Database` is also sync.
