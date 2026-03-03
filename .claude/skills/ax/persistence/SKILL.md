---
name: ax-persistence
description: Use when modifying data persistence — conversation history (SQLite), message queue, file store, or SQLite wrapper utilities in conversation-store.ts, file-store.ts, db.ts, or utils/sqlite.ts
---

## Overview

AX persists data in SQLite databases under `~/.ax/data/`. `ConversationStore` holds conversation history per session. `MessageQueue` tracks inbound messages through the scan/process/complete lifecycle. `FileStore` tracks uploaded file metadata. Both use the runtime-agnostic SQLite wrapper in `utils/sqlite.ts`.

## Key Files

| File | Responsibility |
|---|---|
| `src/conversation-store.ts` | Conversation history CRUD (append, load, prune, count, clear) with image_data filtering |
| `src/file-store.ts` | File metadata store (fileId -> agentName, userId, mimeType) |
| `src/db.ts` | Message queue with status-based lifecycle (pending/processing/done/error) |
| `src/utils/sqlite.ts` | Runtime-agnostic SQLite adapter: bun:sqlite, node:sqlite (22.5+), better-sqlite3 |
| `src/migrations/files.ts` | Files table migration |

## ConversationStore

- **DB**: `~/.ax/data/conversations.db`
- **Table**: `turns` (id INTEGER PK, session_id TEXT, role TEXT, sender TEXT, content TEXT, created_at INTEGER)
- **Index**: `idx_turns_session` on (session_id, id)

| Method | Signature | Notes |
|---|---|---|
| `append` | `(sessionId, role, content, sender?)` | Inserts a turn; content can be string or ContentBlock[] |
| `load` | `(sessionId, maxTurns?)` | Returns last N turns oldest-first |
| `prune` | `(sessionId, keep)` | Deletes all but last `keep` turns |
| `count` | `(sessionId)` | Returns turn count for session |
| `clear` | `(sessionId)` | Deletes all turns for session |
| `close` | `()` | Closes the database connection |

**Content serialization**: `serializeContent()` handles both string and `ContentBlock[]` content. Transient `image_data` blocks are **filtered out** before persistence (defense-in-depth -- they must never be stored). Only `text`, `tool_use`, `tool_result`, and `image` (file reference) blocks are persisted.

Retention: controlled by `config.history.max_turns` (default 50) and `config.history.thread_context_turns` (default 5).

## FileStore

- **DB**: `~/.ax/data/files.db`
- **Table**: `files` (file_id TEXT PK, agent_name TEXT, user_id TEXT, mime_type TEXT, created_at INTEGER)
- **Purpose**: Maps fileId to metadata for downloads without query parameters (e.g., `GET /v1/files/<fileId>` resolves agent/user from DB)

| Method | Signature | Notes |
|---|---|---|
| `register` | `(fileId, agentName, userId, mimeType)` | Store file metadata |
| `lookup` | `(fileId)` | Returns metadata or null |
| `close` | `()` | Closes the database connection |

## Message Queue

- **DB**: `~/.ax/data/messages.db`
- **Table**: `messages` (id TEXT PK [UUID], session_id, channel, sender, content, status, created_at, processed_at)
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

## Common Tasks

**Adding a new persistent store:**
1. Create `src/my-store.ts` with a class wrapping `openDatabase(dataFile('my-store.db'))`
2. Add `migrate()` in constructor with `CREATE TABLE IF NOT EXISTS` + indexes
3. Export typed interface for rows
4. Add `close()` method and wire it into server shutdown
5. Consider adding a migration file in `src/migrations/` for complex schemas

## Gotchas

- **Always `mkdirSync` before opening SQLite**: The `~/.ax/data/` directory may not exist on first run.
- **Clean WAL/SHM in tests**: SQLite WAL mode creates `-wal` and `-shm` sidecar files. Remove all three.
- **Dequeue by ID, not FIFO**: The server uses `dequeueById(messageId)` to avoid session ID mismatches.
- **Close store on shutdown**: All stores expose `close()`. Wire into server shutdown.
- **`node:sqlite` uses `DatabaseSync`**: Synchronous API matching better-sqlite3.
- **image_data blocks are transient**: ConversationStore filters them out before persisting. Never store base64 image data in conversation history.
- **ContentBlock[] content**: `append()` accepts both string and structured content. Serialization handles both formats.
