---
name: ax-provider-memory
description: Use when modifying memory/knowledge storage providers — file, SQLite+FTS5, memU knowledge graph, or MemoryFS v2 (embedding-based) in src/providers/memory/
---

## Overview

Memory providers store and retrieve scoped knowledge entries with optional full-text search and tag filtering. Advanced providers support proactive hints and conversation-level memorization via the `memorize()` hook.

## Interface

Defined in `src/providers/memory/types.ts`:

| Type | Purpose |
|------|---------|
| `MemoryEntry` | Core record: `id`, `scope`, `content`, `tags`, `taint`, `createdAt` |
| `MemoryQuery` | Search params: `scope`, `query` (text match), `limit`, `tags` (all must match) |
| `ConversationTurn` | `role` (user/assistant), `content`, optional `sender` |
| `ProactiveHint` | Emitted hint: `source`, `kind`, `reason`, `suggestedPrompt`, `confidence`, `scope` |
| `MemoryProvider` | Contract: `write`, `query`, `read`, `delete`, `list`, optional `memorize`, `onProactiveHint` |

## Implementations

| Name | File | Storage | Search |
|------|------|---------|--------|
| file | `src/providers/memory/file.ts` | JSON files under `data/memory/{scope}/` | Substring (`content.includes(query)`) |
| sqlite | `src/providers/memory/sqlite.ts` | SQLite DB at `data/memory.db` | FTS5 via `entries_fts` virtual table |
| memu | `src/providers/memory/memu.ts` | In-memory `Map<string, MemoryEntry>` | Substring match; knowledge graph extraction |
| memoryfs | `src/providers/memory/memoryfs/` | SQLite items store + vector embeddings | Semantic search via sqlite-vec embeddings |

All providers export `create(config: Config): Promise<MemoryProvider>`.

## SQLite Provider

- Creates `entries` table + `idx_entries_scope` index + `entries_fts` FTS5 virtual table
- FTS5 table is **standalone** with `entry_id` + `content` columns -- NOT content-synced with triggers
- Write/delete manually sync both `entries` and `entries_fts` tables
- Uses WAL mode via `openDatabase()` utility
- Calls `mkdirSync(dataDir(), { recursive: true })` before opening the database

## memU Provider

- Knowledge comes from `memorize(conversation)`, not `write()` -- `write()` and `delete()` are no-ops
- `extractFacts()` uses regex heuristics to find: explicit memory requests, preferences, action items
- Caps extraction at `MAX_FACTS_PER_CONVERSATION` (20)
- Emits `ProactiveHint` with `kind: 'pending_task'` for action items via `onProactiveHint()` handler
- Backs store with in-memory Map (production would use PostgreSQL knowledge graph)

## MemoryFS v2 Provider

Advanced embedding-based memory system in `src/providers/memory/memoryfs/`:

- **`provider.ts`** -- Main provider wiring, `create(config)` factory
- **`items-store.ts`** -- SQLite-backed item storage with CRUD operations
- **`embedding-store.ts`** -- Vector DB using sqlite-vec for semantic search; graceful degradation when unavailable
- **`extractor.ts`** -- LLM-powered content extraction from conversations
- **`summary-io.ts`** -- Category summary file management
- **`llm-helpers.ts`** -- LLM prompt execution utilities
- **`salience.ts`** -- Salience scoring using memU formula (reinforcement count, recency, relevance)
- **`content-hash.ts`** -- Content hashing for deduplication
- **`prompts.ts`** -- LLM prompt templates for extraction and summarization
- **`types.ts`** -- MemoryFS-specific types

Key features:
- **Semantic search:** Queries use vector embeddings (via `src/utils/embedding-client.ts`) for similarity matching
- **LLM extraction:** Conversations analyzed by LLM to extract structured knowledge items
- **Deduplication:** Content hashing prevents storing duplicate entries
- **Salience scoring:** Items ranked by reinforcement count, recency, and query relevance
- **Graceful degradation:** Falls back when sqlite-vec or embedding API is unavailable

## Common Tasks

**Adding a new memory provider:**
1. Create `src/providers/memory/<name>.ts` exporting `create(config: Config): Promise<MemoryProvider>`
2. Implement all 5 required methods: `write`, `query`, `read`, `delete`, `list`
3. Optionally implement `memorize` and `onProactiveHint`
4. Register in `src/host/provider-map.ts` static allowlist (SC-SEC-002)
5. Add tests at `tests/providers/memory/<name>.test.ts`
6. Use `safePath()` for any file path construction from input

## Gotchas

- **FTS5:** Use standalone tables with manual `entry_id` column. Content-synced triggers cause SQL errors on DELETE because the trigger fires after the row is gone.
- **SQLite init:** Always `mkdirSync` the data directory before `openDatabase()`. Tests that clean up DB files can remove the directory, breaking subsequent tests.
- **WAL cleanup in tests:** Delete `-wal` and `-shm` files alongside the `.db` file in test teardown.
- **File provider:** Uses `safePath()` for all path construction -- never build paths from user input directly.
- **memU write/delete:** Both are no-ops. Knowledge lifecycle is managed entirely through `memorize()`.
