# MemoryFS v2 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace AX's heuristic in-memory `memu` provider with a production-grade, memU-inspired memory system that stores LLM-generated category summaries as markdown files and individual memory items in SQLite.

**Architecture:** Two complementary stores — markdown files for category summaries (the "working memory" agents read) and SQLite for atomic items (the source of truth agents rarely touch directly). Categories are flat `.md` files matching memU's exact format. Items are rows in SQLite with content-hash deduplication and reinforcement counting. Retrieval uses memU's salience formula: `similarity * log(reinforcement + 1) * recency_decay`. Six memory types (profile, event, knowledge, behavior, skill, tool) with per-type extraction prompts.

**Tech Stack:** TypeScript, SQLite (via `src/utils/sqlite.ts` adapter), vitest

---

## Source Documents

- This plan's design rationale: conversation comparing memU (github.com/NevaMind-AI/memU) with AX's v1 plan
- memU source: salience scoring (`src/memu/database/inmemory/vector.py`), category prompts (`src/memu/prompts/category_summary/`), memory types (`src/memu/prompts/memory_type/`), dedup/reinforcement (`src/memu/database/inmemory/repositories/memory_item_repo.py`)
- AX provider contract: `src/providers/memory/types.ts` (`MemoryProvider` interface)
- AX existing memU impl: `src/providers/memory/memu.ts` (regex extraction patterns to reuse)

---

## Design Decisions

### What changed from v1 plan

| v1 (2026-03-01) | v2 (this plan) | Why |
|-----------------|----------------|-----|
| YAML frontmatter per item file | Items in SQLite rows | No `gray-matter` dep, faster queries, atomic updates |
| 4 types (fact, pref, proc, context) | 6 types (profile, event, knowledge, behavior, skill, tool) | AX is general-purpose, not just dev assistant |
| Reconciler (file-DB sync) | No reconciler — files and DB hold different data | Nothing to reconcile |
| Decayer with timer-based tiers | memU salience formula on retrieval | Simpler, more accurate |
| One `.md` file per item | One `.md` file per category (summary only) | Matches memU; items in SQLite |
| `[xN]` inline in markdown | `reinforcement_count` column in SQLite | Proper storage for structured data |
| Background monitor/anticipator | Removed | Over-engineering for Phase 1 |
| Git worker | Removed | No value without user demand |

### Data flow

```
                    WRITE PATH (memorize)
                    =====================
conversation --> Extract --> Dedup/Reinforce --> Categorize --> Write items to SQLite
                                                      |
                                                      v
                                              Update category
                                              summary .md files


                    READ PATH (retrieve)
                    ====================
query --> Search summaries (grep .md files)
              |
              |-- sufficient? --> return summary + [ref:ID] item lookups from SQLite
              |
              +-- not enough? --> Search items (FTS5 / content scan)
                                      |
                                      v
                                  Rank by salience --> Reinforce accessed items --> return
```

### On-disk layout

```
memory/
  personal_info.md          <-- LLM-generated summary (memU format)
  preferences.md
  relationships.md
  activities.md
  goals.md
  experiences.md
  knowledge.md
  opinions.md
  habits.md
  work_life.md
  _store.db                 <-- SQLite: items + FTS5 index
```

### Category file format (matches memU exactly)

```markdown
# preferences
## Editor & Tooling
- The user strongly prefers TypeScript over JavaScript [ref:a1b2c3]
- Uses vim keybindings across all editors [ref:e5f6g7]
## Code Style
- Prefers tabs over spaces
- Likes short, descriptive commit messages
```

When `enable_item_references` is on, bullets include `[ref:ITEM_ID]` citations linking to source items in SQLite. Otherwise, plain bullets.

### Item record (SQLite row)

```sql
CREATE TABLE items (
  id            TEXT PRIMARY KEY,          -- nanoid or UUID
  content       TEXT NOT NULL,             -- the atomic fact
  memory_type   TEXT NOT NULL,             -- profile|event|knowledge|behavior|skill|tool
  category      TEXT NOT NULL,             -- slug matching .md filename
  content_hash  TEXT NOT NULL,             -- sha256("{type}:{normalized}")[:16]
  source        TEXT,                      -- conversation ID or resource ref
  confidence    REAL DEFAULT 0.5,          -- extraction confidence
  reinforcement_count INTEGER DEFAULT 1,   -- incremented on dedup + retrieval
  last_reinforced_at  TEXT,                -- ISO 8601
  created_at    TEXT NOT NULL,             -- ISO 8601
  updated_at    TEXT NOT NULL,             -- ISO 8601
  scope         TEXT NOT NULL DEFAULT 'default',
  agent_id      TEXT,                      -- enterprise scoping
  user_id       TEXT,                      -- multi-user scoping
  taint         TEXT,                      -- JSON TaintTag
  extra         TEXT                       -- JSON for type-specific metadata (when_to_use, etc.)
);
```

---

## Phase 1: Storage Foundation

### Task 1: Types

**Files:**
- Create: `src/providers/memory/memoryfs/types.ts`
- Test: `tests/providers/memory/memoryfs/types.test.ts`

**Context:** Define all MemoryFS types. These are used by every subsequent module. The six memory types match memU's `MemoryType` literal. The config is minimal — just a memory directory path; SQLite DB lives inside it.

**Step 1: Write the failing test**

```typescript
// tests/providers/memory/memoryfs/types.test.ts
import { describe, it, expect } from 'vitest';
import type {
  MemoryFSItem,
  MemoryFSConfig,
  MemoryType,
} from '../../../../src/providers/memory/memoryfs/types.js';
import { MEMORY_TYPES } from '../../../../src/providers/memory/memoryfs/types.js';

describe('MemoryFS types', () => {
  it('MEMORY_TYPES contains all six types', () => {
    expect(MEMORY_TYPES).toEqual([
      'profile', 'event', 'knowledge', 'behavior', 'skill', 'tool',
    ]);
  });

  it('MemoryFSItem has required fields', () => {
    const item: MemoryFSItem = {
      id: 'mem_abc123',
      content: 'Prefers TypeScript over JavaScript',
      memoryType: 'profile',
      category: 'preferences',
      contentHash: 'a1b2c3d4e5f6g7h8',
      confidence: 0.95,
      reinforcementCount: 1,
      lastReinforcedAt: '2026-03-01T00:00:00Z',
      createdAt: '2026-03-01T00:00:00Z',
      updatedAt: '2026-03-01T00:00:00Z',
      scope: 'default',
    };
    expect(item.memoryType).toBe('profile');
    expect(item.reinforcementCount).toBe(1);
  });

  it('MemoryFSConfig has required fields', () => {
    const config: MemoryFSConfig = {
      memoryDir: '/tmp/memory',
      enableItemReferences: false,
      summaryTargetTokens: 400,
      recencyDecayDays: 30,
      defaultMemoryTypes: ['profile', 'event'],
    };
    expect(config.memoryDir).toBe('/tmp/memory');
    expect(config.recencyDecayDays).toBe(30);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/providers/memory/memoryfs/types.test.ts`
Expected: FAIL — module not found

**Step 3: Write the types**

```typescript
// src/providers/memory/memoryfs/types.ts
import type { LLMProvider } from '../../llm/types.js';

/** The six memory types, matching memU's MemoryType literal. */
export const MEMORY_TYPES = [
  'profile',    // Stable user facts, preferences, traits
  'event',      // Specific happenings with time/place context
  'knowledge',  // Domain facts and learned information
  'behavior',   // Behavioral patterns and habits
  'skill',      // Comprehensive skill/procedure profiles
  'tool',       // Tool usage patterns with when_to_use hints
] as const;

export type MemoryType = typeof MEMORY_TYPES[number];

/** A single atomic memory item stored in SQLite. */
export interface MemoryFSItem {
  id: string;
  content: string;
  memoryType: MemoryType;
  category: string;               // slug matching .md filename (e.g. 'preferences')
  contentHash: string;            // sha256("{type}:{normalized}")[:16]
  source?: string;                // conversation ID or resource reference
  confidence: number;             // 0.0-1.0, set at extraction time
  reinforcementCount: number;     // incremented on dedup + retrieval
  lastReinforcedAt: string;       // ISO 8601
  createdAt: string;              // ISO 8601
  updatedAt: string;              // ISO 8601
  scope: string;                  // namespace, default 'default'
  agentId?: string;               // enterprise scoping
  userId?: string;                // multi-user scoping
  taint?: string;                 // JSON-serialized TaintTag
  extra?: string;                 // JSON for type-specific metadata
}

/** Short ref ID for [ref:ID] citations in summaries. */
export type RefId = string; // first 6 hex chars of content hash

/** Configuration for the MemoryFS provider. */
export interface MemoryFSConfig {
  memoryDir: string;              // root directory for .md files and _store.db
  enableItemReferences?: boolean; // default false -- opt-in [ref:ID] in summaries
  summaryTargetTokens?: number;   // default 400
  recencyDecayDays?: number;      // default 30 (half-life for salience scoring)
  defaultMemoryTypes?: MemoryType[]; // default ['profile', 'event']
  llmProvider?: LLMProvider;      // needed for LLM extraction + summary generation
  extractionModel?: string;       // model for extraction (cheapest available)
  summaryModel?: string;          // model for summary generation
}

/** Default categories matching memU's defaults. */
export const DEFAULT_CATEGORIES = [
  'personal_info',
  'preferences',
  'relationships',
  'activities',
  'goals',
  'experiences',
  'knowledge',
  'opinions',
  'habits',
  'work_life',
] as const;
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/providers/memory/memoryfs/types.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/providers/memory/memoryfs/types.ts tests/providers/memory/memoryfs/types.test.ts
git commit -m "feat(memoryfs): add core types with six memory types and config"
```

---

### Task 2: Items Store (SQLite)

**Files:**
- Create: `src/providers/memory/memoryfs/items-store.ts`
- Test: `tests/providers/memory/memoryfs/items-store.test.ts`

**Context:** The items store wraps SQLite for CRUD on `MemoryFSItem` rows. Uses `openDatabase()` from `src/utils/sqlite.ts` (runtime-agnostic adapter supporting bun:sqlite, node:sqlite, better-sqlite3). Creates the table on init. All queries scoped by `scope` (and optionally `agentId`/`userId`).

**Step 1: Write the failing tests**

```typescript
// tests/providers/memory/memoryfs/items-store.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ItemsStore } from '../../../../src/providers/memory/memoryfs/items-store.js';
import type { MemoryFSItem } from '../../../../src/providers/memory/memoryfs/types.js';

describe('ItemsStore', () => {
  let store: ItemsStore;
  let testDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'memfs-test-'));
    store = new ItemsStore(join(testDir, '_store.db'));
  });

  afterEach(async () => {
    store.close();
    await rm(testDir, { recursive: true, force: true });
  });

  const sampleItem: Omit<MemoryFSItem, 'id'> = {
    content: 'Prefers TypeScript over JavaScript',
    memoryType: 'profile',
    category: 'preferences',
    contentHash: 'a1b2c3d4e5f6g7h8',
    confidence: 0.95,
    reinforcementCount: 1,
    lastReinforcedAt: '2026-03-01T00:00:00Z',
    createdAt: '2026-03-01T00:00:00Z',
    updatedAt: '2026-03-01T00:00:00Z',
    scope: 'default',
  };

  it('inserts and reads an item', () => {
    const id = store.insert(sampleItem);
    const item = store.getById(id);
    expect(item).not.toBeNull();
    expect(item!.content).toBe('Prefers TypeScript over JavaScript');
    expect(item!.memoryType).toBe('profile');
    expect(item!.reinforcementCount).toBe(1);
  });

  it('finds item by content hash within scope', () => {
    store.insert(sampleItem);
    const found = store.findByHash('a1b2c3d4e5f6g7h8', 'default');
    expect(found).not.toBeNull();
    expect(found!.content).toBe(sampleItem.content);
  });

  it('returns null for hash in different scope', () => {
    store.insert(sampleItem);
    const found = store.findByHash('a1b2c3d4e5f6g7h8', 'other-scope');
    expect(found).toBeNull();
  });

  it('reinforces existing item (increments count + updates timestamp)', () => {
    const id = store.insert(sampleItem);
    store.reinforce(id);
    const item = store.getById(id);
    expect(item!.reinforcementCount).toBe(2);
    expect(item!.lastReinforcedAt).not.toBe('2026-03-01T00:00:00Z');
  });

  it('lists items by category', () => {
    store.insert(sampleItem);
    store.insert({ ...sampleItem, content: 'Uses vim', contentHash: 'bbbbbbbbbbbbbbbb' });
    store.insert({ ...sampleItem, content: 'Runs on GKE', category: 'knowledge', contentHash: 'cccccccccccccccc' });
    const prefs = store.listByCategory('preferences', 'default');
    expect(prefs).toHaveLength(2);
  });

  it('lists items by scope with limit', () => {
    for (let i = 0; i < 20; i++) {
      store.insert({ ...sampleItem, content: `Fact ${i}`, contentHash: `hash_${i.toString().padStart(12, '0')}` });
    }
    const limited = store.listByScope('default', 5);
    expect(limited).toHaveLength(5);
  });

  it('deletes an item', () => {
    const id = store.insert(sampleItem);
    store.deleteById(id);
    expect(store.getById(id)).toBeNull();
  });

  it('searches content with LIKE', () => {
    store.insert(sampleItem);
    store.insert({ ...sampleItem, content: 'Uses vim keybindings', contentHash: 'dddddddddddddddd' });
    const results = store.searchContent('TypeScript', 'default');
    expect(results).toHaveLength(1);
    expect(results[0].content).toContain('TypeScript');
  });

  it('scopes queries by agentId when provided', () => {
    store.insert({ ...sampleItem, agentId: 'agent_1' });
    store.insert({ ...sampleItem, content: 'Other agent fact', contentHash: 'eeeeeeeeeeeeeeee', agentId: 'agent_2' });
    const results = store.listByScope('default', 50, 'agent_1');
    expect(results).toHaveLength(1);
  });

  it('getAllForCategory returns all items for summary generation', () => {
    store.insert(sampleItem);
    store.insert({ ...sampleItem, content: 'Uses vim', contentHash: 'ffffffffffffffff' });
    const items = store.getAllForCategory('preferences', 'default');
    expect(items).toHaveLength(2);
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/providers/memory/memoryfs/items-store.test.ts`
Expected: FAIL — module not found

**Step 3: Implement ItemsStore**

```typescript
// src/providers/memory/memoryfs/items-store.ts
import { randomUUID } from 'node:crypto';
import { openDatabase, type SQLiteDatabase } from '../../../utils/sqlite.js';
import type { MemoryFSItem } from './types.js';

const CREATE_TABLE = `
  CREATE TABLE IF NOT EXISTS items (
    id                  TEXT PRIMARY KEY,
    content             TEXT NOT NULL,
    memory_type         TEXT NOT NULL,
    category            TEXT NOT NULL,
    content_hash        TEXT NOT NULL,
    source              TEXT,
    confidence          REAL DEFAULT 0.5,
    reinforcement_count INTEGER DEFAULT 1,
    last_reinforced_at  TEXT,
    created_at          TEXT NOT NULL,
    updated_at          TEXT NOT NULL,
    scope               TEXT NOT NULL DEFAULT 'default',
    agent_id            TEXT,
    user_id             TEXT,
    taint               TEXT,
    extra               TEXT
  )
`;

const CREATE_INDEXES = [
  'CREATE INDEX IF NOT EXISTS idx_items_scope ON items(scope)',
  'CREATE INDEX IF NOT EXISTS idx_items_category ON items(category, scope)',
  'CREATE INDEX IF NOT EXISTS idx_items_hash ON items(content_hash, scope)',
  'CREATE INDEX IF NOT EXISTS idx_items_agent ON items(agent_id, scope)',
];

export class ItemsStore {
  private db: SQLiteDatabase;

  constructor(dbPath: string) {
    this.db = openDatabase(dbPath);
    this.db.exec(CREATE_TABLE);
    for (const idx of CREATE_INDEXES) {
      this.db.exec(idx);
    }
  }

  insert(item: Omit<MemoryFSItem, 'id'>): string {
    const id = randomUUID();
    this.db.prepare(`
      INSERT INTO items (id, content, memory_type, category, content_hash, source,
        confidence, reinforcement_count, last_reinforced_at, created_at, updated_at,
        scope, agent_id, user_id, taint, extra)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, item.content, item.memoryType, item.category, item.contentHash,
      item.source ?? null, item.confidence, item.reinforcementCount,
      item.lastReinforcedAt, item.createdAt, item.updatedAt,
      item.scope, item.agentId ?? null, item.userId ?? null,
      item.taint ?? null, item.extra ?? null,
    );
    return id;
  }

  getById(id: string): MemoryFSItem | null {
    const row = this.db.prepare('SELECT * FROM items WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return row ? this.rowToItem(row) : null;
  }

  findByHash(contentHash: string, scope: string, agentId?: string): MemoryFSItem | null {
    const sql = agentId
      ? 'SELECT * FROM items WHERE content_hash = ? AND scope = ? AND agent_id = ?'
      : 'SELECT * FROM items WHERE content_hash = ? AND scope = ? AND agent_id IS NULL';
    const params = agentId ? [contentHash, scope, agentId] : [contentHash, scope];
    const row = this.db.prepare(sql).get(...params) as Record<string, unknown> | undefined;
    return row ? this.rowToItem(row) : null;
  }

  reinforce(id: string): void {
    const now = new Date().toISOString();
    this.db.prepare(`
      UPDATE items SET reinforcement_count = reinforcement_count + 1,
        last_reinforced_at = ?, updated_at = ?
      WHERE id = ?
    `).run(now, now, id);
  }

  listByCategory(category: string, scope: string, limit?: number): MemoryFSItem[] {
    const sql = limit
      ? 'SELECT * FROM items WHERE category = ? AND scope = ? ORDER BY created_at DESC LIMIT ?'
      : 'SELECT * FROM items WHERE category = ? AND scope = ? ORDER BY created_at DESC';
    const params = limit ? [category, scope, limit] : [category, scope];
    const rows = this.db.prepare(sql).all(...params) as Record<string, unknown>[];
    return rows.map(r => this.rowToItem(r));
  }

  listByScope(scope: string, limit?: number, agentId?: string): MemoryFSItem[] {
    let sql = 'SELECT * FROM items WHERE scope = ?';
    const params: unknown[] = [scope];
    if (agentId) {
      sql += ' AND agent_id = ?';
      params.push(agentId);
    }
    sql += ' ORDER BY created_at DESC';
    if (limit) {
      sql += ' LIMIT ?';
      params.push(limit);
    }
    const rows = this.db.prepare(sql).all(...params) as Record<string, unknown>[];
    return rows.map(r => this.rowToItem(r));
  }

  getAllForCategory(category: string, scope: string): MemoryFSItem[] {
    const rows = this.db.prepare(
      'SELECT * FROM items WHERE category = ? AND scope = ? ORDER BY created_at ASC',
    ).all(category, scope) as Record<string, unknown>[];
    return rows.map(r => this.rowToItem(r));
  }

  searchContent(query: string, scope: string, limit = 50): MemoryFSItem[] {
    const rows = this.db.prepare(
      'SELECT * FROM items WHERE scope = ? AND content LIKE ? ORDER BY created_at DESC LIMIT ?',
    ).all(scope, `%${query}%`, limit) as Record<string, unknown>[];
    return rows.map(r => this.rowToItem(r));
  }

  deleteById(id: string): void {
    this.db.prepare('DELETE FROM items WHERE id = ?').run(id);
  }

  close(): void {
    this.db.close();
  }

  private rowToItem(row: Record<string, unknown>): MemoryFSItem {
    return {
      id: row.id as string,
      content: row.content as string,
      memoryType: row.memory_type as MemoryFSItem['memoryType'],
      category: row.category as string,
      contentHash: row.content_hash as string,
      source: (row.source as string) || undefined,
      confidence: row.confidence as number,
      reinforcementCount: row.reinforcement_count as number,
      lastReinforcedAt: row.last_reinforced_at as string,
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string,
      scope: row.scope as string,
      agentId: (row.agent_id as string) || undefined,
      userId: (row.user_id as string) || undefined,
      taint: (row.taint as string) || undefined,
      extra: (row.extra as string) || undefined,
    };
  }
}
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/providers/memory/memoryfs/items-store.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/providers/memory/memoryfs/items-store.ts tests/providers/memory/memoryfs/items-store.test.ts
git commit -m "feat(memoryfs): add SQLite items store with dedup, reinforcement, scoped queries"
```

---

### Task 3: Content Hashing

**Files:**
- Create: `src/providers/memory/memoryfs/content-hash.ts`
- Test: `tests/providers/memory/memoryfs/content-hash.test.ts`

**Context:** Deterministic content hashing for deduplication, matching memU's `compute_content_hash`. Includes memory type in the hash input so the same text under different types produces different hashes.

**Step 1: Write the failing tests**

```typescript
// tests/providers/memory/memoryfs/content-hash.test.ts
import { describe, it, expect } from 'vitest';
import { computeContentHash, buildRefId } from '../../../../src/providers/memory/memoryfs/content-hash.js';

describe('computeContentHash', () => {
  it('produces deterministic 16-char hex hash', () => {
    const hash = computeContentHash('Prefers TypeScript', 'profile');
    expect(hash).toHaveLength(16);
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
    expect(computeContentHash('Prefers TypeScript', 'profile')).toBe(hash);
  });

  it('includes memory type in hash (same text, different type = different hash)', () => {
    const a = computeContentHash('The API uses REST', 'knowledge');
    const b = computeContentHash('The API uses REST', 'profile');
    expect(a).not.toBe(b);
  });

  it('normalizes whitespace', () => {
    const a = computeContentHash('  Prefers   TypeScript  ', 'profile');
    const b = computeContentHash('Prefers TypeScript', 'profile');
    expect(a).toBe(b);
  });

  it('normalizes case', () => {
    const a = computeContentHash('PREFERS TYPESCRIPT', 'profile');
    const b = computeContentHash('prefers typescript', 'profile');
    expect(a).toBe(b);
  });

  it('different content produces different hash', () => {
    const a = computeContentHash('Prefers TypeScript', 'profile');
    const b = computeContentHash('Prefers JavaScript', 'profile');
    expect(a).not.toBe(b);
  });
});

describe('buildRefId', () => {
  it('returns first 6 chars of content hash', () => {
    const hash = computeContentHash('Prefers TypeScript', 'profile');
    const ref = buildRefId(hash);
    expect(ref).toBe(hash.slice(0, 6));
    expect(ref).toHaveLength(6);
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/providers/memory/memoryfs/content-hash.test.ts`
Expected: FAIL — module not found

**Step 3: Implement content-hash**

```typescript
// src/providers/memory/memoryfs/content-hash.ts
import { createHash } from 'node:crypto';
import type { MemoryType, RefId } from './types.js';

/**
 * Compute deterministic content hash for deduplication.
 * Matches memU's compute_content_hash: sha256("{type}:{normalized}")[:16].
 */
export function computeContentHash(content: string, memoryType: MemoryType): string {
  const normalized = content.toLowerCase().split(/\s+/).join(' ').trim();
  const input = `${memoryType}:${normalized}`;
  return createHash('sha256').update(input).digest('hex').slice(0, 16);
}

/**
 * Build short ref ID for [ref:ID] citations in category summaries.
 * Uses first 6 hex chars of content hash.
 */
export function buildRefId(contentHash: string): RefId {
  return contentHash.slice(0, 6);
}
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/providers/memory/memoryfs/content-hash.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/providers/memory/memoryfs/content-hash.ts tests/providers/memory/memoryfs/content-hash.test.ts
git commit -m "feat(memoryfs): add content hashing with type-scoped dedup and ref IDs"
```

---

### Task 4: Summary File I/O

**Files:**
- Create: `src/providers/memory/memoryfs/summary-io.ts`
- Test: `tests/providers/memory/memoryfs/summary-io.test.ts`

**Context:** Read/write category summary `.md` files. Each file contains only the LLM-generated summary (memU format). Uses `safePath()` for all path construction. Atomic writes via temp-then-rename.

**Step 1: Write the failing tests**

```typescript
// tests/providers/memory/memoryfs/summary-io.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  writeSummary,
  readSummary,
  listCategories,
  categoryExists,
  initDefaultCategories,
} from '../../../../src/providers/memory/memoryfs/summary-io.js';

describe('summary-io', () => {
  let memoryDir: string;

  beforeEach(async () => {
    memoryDir = await mkdtemp(join(tmpdir(), 'memfs-summary-'));
  });

  afterEach(async () => {
    await rm(memoryDir, { recursive: true, force: true });
  });

  it('writes and reads a summary round-trip', async () => {
    const content = '# preferences\n## Editor\n- Uses vim\n';
    await writeSummary(memoryDir, 'preferences', content);
    const read = await readSummary(memoryDir, 'preferences');
    expect(read).toBe(content);
  });

  it('returns null for non-existent category', async () => {
    const read = await readSummary(memoryDir, 'nonexistent');
    expect(read).toBeNull();
  });

  it('overwrites existing summary', async () => {
    await writeSummary(memoryDir, 'preferences', 'old content');
    await writeSummary(memoryDir, 'preferences', 'new content');
    const read = await readSummary(memoryDir, 'preferences');
    expect(read).toBe('new content');
  });

  it('lists category slugs from .md files', async () => {
    await writeSummary(memoryDir, 'preferences', 'content');
    await writeSummary(memoryDir, 'knowledge', 'content');
    const cats = await listCategories(memoryDir);
    expect(cats.sort()).toEqual(['knowledge', 'preferences']);
  });

  it('excludes files starting with underscore', async () => {
    await writeSummary(memoryDir, 'preferences', 'content');
    const cats = await listCategories(memoryDir);
    expect(cats).not.toContain('_store');
  });

  it('categoryExists returns true/false correctly', async () => {
    await writeSummary(memoryDir, 'preferences', 'content');
    expect(await categoryExists(memoryDir, 'preferences')).toBe(true);
    expect(await categoryExists(memoryDir, 'nonexistent')).toBe(false);
  });

  it('initDefaultCategories creates empty files for all 10 defaults', async () => {
    await initDefaultCategories(memoryDir);
    const cats = await listCategories(memoryDir);
    expect(cats).toHaveLength(10);
    expect(cats).toContain('preferences');
    expect(cats).toContain('work_life');
    const content = await readSummary(memoryDir, 'preferences');
    expect(content).toContain('# preferences');
  });

  it('rejects path traversal in category name', async () => {
    await expect(writeSummary(memoryDir, '../escape', 'bad')).rejects.toThrow();
    await expect(readSummary(memoryDir, '../../etc/passwd')).rejects.toThrow();
  });

  it('writes atomically (no .tmp files left on success)', async () => {
    await writeSummary(memoryDir, 'preferences', 'content');
    const { readdir } = await import('node:fs/promises');
    const files = await readdir(memoryDir);
    expect(files.every(f => !f.endsWith('.tmp'))).toBe(true);
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/providers/memory/memoryfs/summary-io.test.ts`
Expected: FAIL — module not found

**Step 3: Implement summary-io**

```typescript
// src/providers/memory/memoryfs/summary-io.ts
import { readFile, writeFile, rename, access, readdir, mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { safePath } from '../../../utils/safe-path.js';
import { DEFAULT_CATEGORIES } from './types.js';

/**
 * Write a category summary .md file atomically (temp -> rename).
 */
export async function writeSummary(
  memoryDir: string,
  category: string,
  content: string,
): Promise<void> {
  const filePath = safePath(memoryDir, `${category}.md`);
  await mkdir(memoryDir, { recursive: true });
  const tmpPath = `${filePath}.${randomUUID()}.tmp`;
  await writeFile(tmpPath, content, 'utf-8');
  await rename(tmpPath, filePath);
}

/**
 * Read a category summary. Returns null if file doesn't exist.
 */
export async function readSummary(
  memoryDir: string,
  category: string,
): Promise<string | null> {
  const filePath = safePath(memoryDir, `${category}.md`);
  try {
    return await readFile(filePath, 'utf-8');
  } catch {
    return null;
  }
}

/**
 * List all category slugs (filenames without .md extension).
 * Excludes files starting with underscore (e.g. _store.db).
 */
export async function listCategories(memoryDir: string): Promise<string[]> {
  try {
    const files = await readdir(memoryDir);
    return files
      .filter(f => f.endsWith('.md') && !f.startsWith('_'))
      .map(f => f.replace(/\.md$/, ''));
  } catch {
    return [];
  }
}

/**
 * Check if a category summary file exists.
 */
export async function categoryExists(
  memoryDir: string,
  category: string,
): Promise<boolean> {
  const filePath = safePath(memoryDir, `${category}.md`);
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Create empty summary files for all 10 default categories.
 */
export async function initDefaultCategories(memoryDir: string): Promise<void> {
  await mkdir(memoryDir, { recursive: true });
  for (const cat of DEFAULT_CATEGORIES) {
    const exists = await categoryExists(memoryDir, cat);
    if (!exists) {
      await writeSummary(memoryDir, cat, `# ${cat}\n`);
    }
  }
}
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/providers/memory/memoryfs/summary-io.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/providers/memory/memoryfs/summary-io.ts tests/providers/memory/memoryfs/summary-io.test.ts
git commit -m "feat(memoryfs): add summary file I/O with atomic writes and default categories"
```

---

### Task 5: Salience Scoring

**Files:**
- Create: `src/providers/memory/memoryfs/salience.ts`
- Test: `tests/providers/memory/memoryfs/salience.test.ts`

**Context:** Implements memU's exact salience formula: `similarity * log(reinforcement + 1) * exp(-0.693 * days / half_life)`. Used during retrieval to rank items. Pure math, no I/O.

**Step 1: Write the failing tests**

```typescript
// tests/providers/memory/memoryfs/salience.test.ts
import { describe, it, expect } from 'vitest';
import { salienceScore } from '../../../../src/providers/memory/memoryfs/salience.js';

describe('salienceScore', () => {
  it('returns positive score for valid inputs', () => {
    const score = salienceScore({
      similarity: 0.8,
      reinforcementCount: 5,
      lastReinforcedAt: new Date().toISOString(),
      recencyDecayDays: 30,
    });
    expect(score).toBeGreaterThan(0);
  });

  it('higher reinforcement increases score', () => {
    const now = new Date().toISOString();
    const low = salienceScore({ similarity: 0.8, reinforcementCount: 1, lastReinforcedAt: now, recencyDecayDays: 30 });
    const high = salienceScore({ similarity: 0.8, reinforcementCount: 20, lastReinforcedAt: now, recencyDecayDays: 30 });
    expect(high).toBeGreaterThan(low);
  });

  it('recent items score higher than old items', () => {
    const recent = salienceScore({
      similarity: 0.8,
      reinforcementCount: 3,
      lastReinforcedAt: new Date().toISOString(),
      recencyDecayDays: 30,
    });
    const old = salienceScore({
      similarity: 0.8,
      reinforcementCount: 3,
      lastReinforcedAt: new Date(Date.now() - 90 * 86400000).toISOString(),
      recencyDecayDays: 30,
    });
    expect(recent).toBeGreaterThan(old);
  });

  it('recency factor halves at half-life', () => {
    const now = new Date();
    const atHalfLife = new Date(now.getTime() - 30 * 86400000);
    const fresh = salienceScore({ similarity: 1.0, reinforcementCount: 0, lastReinforcedAt: now.toISOString(), recencyDecayDays: 30 });
    const halfLife = salienceScore({ similarity: 1.0, reinforcementCount: 0, lastReinforcedAt: atHalfLife.toISOString(), recencyDecayDays: 30 });
    expect(halfLife / fresh).toBeCloseTo(0.5, 1);
  });

  it('null lastReinforcedAt gives 0.5 recency factor', () => {
    const withDate = salienceScore({ similarity: 1.0, reinforcementCount: 0, lastReinforcedAt: new Date().toISOString(), recencyDecayDays: 30 });
    const withNull = salienceScore({ similarity: 1.0, reinforcementCount: 0, lastReinforcedAt: null, recencyDecayDays: 30 });
    expect(withNull / withDate).toBeCloseTo(0.5, 1);
  });

  it('higher similarity increases score', () => {
    const now = new Date().toISOString();
    const low = salienceScore({ similarity: 0.3, reinforcementCount: 3, lastReinforcedAt: now, recencyDecayDays: 30 });
    const high = salienceScore({ similarity: 0.9, reinforcementCount: 3, lastReinforcedAt: now, recencyDecayDays: 30 });
    expect(high).toBeGreaterThan(low);
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/providers/memory/memoryfs/salience.test.ts`
Expected: FAIL — module not found

**Step 3: Implement salience scoring**

```typescript
// src/providers/memory/memoryfs/salience.ts

/**
 * memU's salience scoring formula.
 *
 * salience = similarity * log(reinforcementCount + 1) * recencyFactor
 *
 * Where recencyFactor = exp(-0.693 * daysSinceLastReinforced / recencyDecayDays)
 * 0.693 = ln(2), giving proper half-life decay.
 */
export function salienceScore(params: {
  similarity: number;
  reinforcementCount: number;
  lastReinforcedAt: string | null;
  recencyDecayDays: number;
}): number {
  const { similarity, reinforcementCount, lastReinforcedAt, recencyDecayDays } = params;

  // Reinforcement factor: logarithmic to prevent runaway scores
  const reinforcementFactor = Math.log(reinforcementCount + 1);

  // Recency factor: exponential decay with half-life
  let recencyFactor: number;
  if (lastReinforcedAt === null) {
    recencyFactor = 0.5; // Unknown recency gets neutral score
  } else {
    const daysAgo = (Date.now() - new Date(lastReinforcedAt).getTime()) / 86_400_000;
    recencyFactor = Math.exp(-0.693 * daysAgo / recencyDecayDays);
  }

  return similarity * reinforcementFactor * recencyFactor;
}
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/providers/memory/memoryfs/salience.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/providers/memory/memoryfs/salience.ts tests/providers/memory/memoryfs/salience.test.ts
git commit -m "feat(memoryfs): add salience scoring with memU formula"
```

---

## Phase 2: Extraction & Categorization

### Task 6: Regex Extractor

**Files:**
- Create: `src/providers/memory/memoryfs/extractor.ts`
- Test: `tests/providers/memory/memoryfs/extractor.test.ts`

**Context:** Extract memory items from conversation turns using regex heuristics. Adapted from existing `src/providers/memory/memu.ts` patterns but outputs structured `MemoryFSItem` candidates with the six memory types. This is the fast path — no LLM call needed.

**Step 1: Write the failing tests**

```typescript
// tests/providers/memory/memoryfs/extractor.test.ts
import { describe, it, expect } from 'vitest';
import { extractByRegex } from '../../../../src/providers/memory/memoryfs/extractor.js';
import type { ConversationTurn } from '../../../../src/providers/memory/types.js';

describe('extractByRegex', () => {
  it('extracts explicit memory requests as profile type', () => {
    const turns: ConversationTurn[] = [
      { role: 'user', content: 'Remember that I prefer TypeScript over JavaScript' },
    ];
    const items = extractByRegex(turns, 'default');
    expect(items).toHaveLength(1);
    expect(items[0].content).toBe('I prefer TypeScript over JavaScript');
    expect(items[0].memoryType).toBe('profile');
    expect(items[0].confidence).toBe(0.95);
  });

  it('extracts preferences as profile type', () => {
    const turns: ConversationTurn[] = [
      { role: 'user', content: 'I always use vim keybindings in my editor' },
    ];
    const items = extractByRegex(turns, 'default');
    expect(items).toHaveLength(1);
    expect(items[0].memoryType).toBe('profile');
    expect(items[0].confidence).toBe(0.7);
  });

  it('extracts action items as behavior type', () => {
    const turns: ConversationTurn[] = [
      { role: 'user', content: 'TODO: run the migration script before deploying' },
    ];
    const items = extractByRegex(turns, 'default');
    expect(items).toHaveLength(1);
    expect(items[0].memoryType).toBe('behavior');
    expect(items[0].confidence).toBe(0.8);
  });

  it('ignores assistant turns', () => {
    const turns: ConversationTurn[] = [
      { role: 'assistant', content: 'Remember that I am an AI assistant' },
    ];
    const items = extractByRegex(turns, 'default');
    expect(items).toHaveLength(0);
  });

  it('caps extraction at 20 items per conversation', () => {
    const turns: ConversationTurn[] = Array.from({ length: 30 }, (_, i) => ({
      role: 'user' as const,
      content: `Remember that fact number ${i} is important`,
    }));
    const items = extractByRegex(turns, 'default');
    expect(items.length).toBeLessThanOrEqual(20);
  });

  it('populates contentHash, scope, and timestamps', () => {
    const turns: ConversationTurn[] = [
      { role: 'user', content: 'Remember that the API key rotates weekly' },
    ];
    const items = extractByRegex(turns, 'my-scope');
    expect(items[0].contentHash).toMatch(/^[0-9a-f]{16}$/);
    expect(items[0].scope).toBe('my-scope');
    expect(items[0].createdAt).toBeTruthy();
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/providers/memory/memoryfs/extractor.test.ts`
Expected: FAIL — module not found

**Step 3: Implement regex extractor**

```typescript
// src/providers/memory/memoryfs/extractor.ts
import type { ConversationTurn } from '../types.js';
import type { MemoryFSItem, MemoryType } from './types.js';
import { computeContentHash } from './content-hash.js';

const MAX_ITEMS_PER_CONVERSATION = 20;

interface ExtractionCandidate {
  content: string;
  memoryType: MemoryType;
  confidence: number;
}

/**
 * Extract memory items from conversation using regex heuristics.
 * Fast path -- no LLM call. Adapted from existing memu.ts patterns.
 */
export function extractByRegex(
  conversation: ConversationTurn[],
  scope: string,
): Omit<MemoryFSItem, 'id'>[] {
  const candidates: ExtractionCandidate[] = [];

  for (const turn of conversation) {
    if (turn.role !== 'user') continue;
    const text = turn.content;

    // Explicit memory requests: "remember that...", "note that...", "keep in mind..."
    const rememberMatch = text.match(
      /(?:remember|note|keep in mind|don't forget)\s+(?:that\s+)?(.{10,200})/i,
    );
    if (rememberMatch) {
      candidates.push({
        content: rememberMatch[1].trim(),
        memoryType: 'profile',
        confidence: 0.95,
      });
    }

    // Preferences: "I prefer...", "I like...", "I always..."
    const prefMatch = text.match(
      /(?:I\s+(?:prefer|like|always|usually|want|need))\s+(.{5,200})/i,
    );
    if (prefMatch && !rememberMatch) {
      candidates.push({
        content: prefMatch[0].trim(),
        memoryType: 'profile',
        confidence: 0.7,
      });
    }

    // Action items / behavior patterns: "TODO:", "I need to...", "I should..."
    const todoMatch = text.match(
      /(?:TODO:?\s+|I\s+(?:need|should|have)\s+to\s+)(.{5,200})/i,
    );
    if (todoMatch) {
      candidates.push({
        content: todoMatch[1].trim(),
        memoryType: 'behavior',
        confidence: 0.8,
      });
    }
  }

  const now = new Date().toISOString();
  return candidates.slice(0, MAX_ITEMS_PER_CONVERSATION).map(c => ({
    content: c.content,
    memoryType: c.memoryType,
    category: defaultCategoryForType(c.memoryType),
    contentHash: computeContentHash(c.content, c.memoryType),
    confidence: c.confidence,
    reinforcementCount: 1,
    lastReinforcedAt: now,
    createdAt: now,
    updatedAt: now,
    scope,
  }));
}

/** Default category mapping by memory type. */
function defaultCategoryForType(memoryType: MemoryType): string {
  switch (memoryType) {
    case 'profile': return 'personal_info';
    case 'event': return 'experiences';
    case 'knowledge': return 'knowledge';
    case 'behavior': return 'habits';
    case 'skill': return 'knowledge';
    case 'tool': return 'work_life';
  }
}
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/providers/memory/memoryfs/extractor.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/providers/memory/memoryfs/extractor.ts tests/providers/memory/memoryfs/extractor.test.ts
git commit -m "feat(memoryfs): add regex extractor with six memory types"
```

---

### Task 7: Summary Generator Prompts

**Files:**
- Create: `src/providers/memory/memoryfs/prompts.ts`
- Test: `tests/providers/memory/memoryfs/prompts.test.ts`

**Context:** LLM prompt templates for generating and updating category summaries, adapted from memU's `category_summary/category.py` and `category_with_refs.py`. Also includes the category patch prompt for incremental updates via CRUD. These prompts are wired into `memorize()` in a future phase when LLM summary generation is enabled.

**Step 1: Write the failing tests**

```typescript
// tests/providers/memory/memoryfs/prompts.test.ts
import { describe, it, expect } from 'vitest';
import {
  buildSummaryPrompt,
  buildSummaryPromptWithRefs,
  buildPatchPrompt,
  parsePatchResponse,
} from '../../../../src/providers/memory/memoryfs/prompts.js';

describe('buildSummaryPrompt', () => {
  it('includes category name and target length', () => {
    const prompt = buildSummaryPrompt({
      category: 'preferences',
      originalContent: '',
      newItems: ['Prefers TypeScript', 'Uses vim'],
      targetLength: 400,
    });
    expect(prompt).toContain('preferences');
    expect(prompt).toContain('400');
    expect(prompt).toContain('Prefers TypeScript');
    expect(prompt).toContain('Uses vim');
  });

  it('includes original content when provided', () => {
    const prompt = buildSummaryPrompt({
      category: 'preferences',
      originalContent: '# preferences\n## Editor\n- Uses emacs\n',
      newItems: ['Uses vim now'],
      targetLength: 400,
    });
    expect(prompt).toContain('Uses emacs');
    expect(prompt).toContain('Uses vim now');
  });
});

describe('buildSummaryPromptWithRefs', () => {
  it('includes item IDs for ref citations', () => {
    const prompt = buildSummaryPromptWithRefs({
      category: 'preferences',
      originalContent: '',
      newItemsWithIds: [
        { refId: 'a1b2c3', content: 'Prefers TypeScript' },
        { refId: 'd4e5f6', content: 'Uses vim' },
      ],
      targetLength: 400,
    });
    expect(prompt).toContain('[a1b2c3]');
    expect(prompt).toContain('[d4e5f6]');
    expect(prompt).toContain('[ref:');
  });
});

describe('buildPatchPrompt', () => {
  it('formats add operation', () => {
    const prompt = buildPatchPrompt({
      category: 'preferences',
      originalContent: '# preferences\n## Editor\n- Uses vim\n',
      updateContent: 'This memory content is newly added:\nPrefers dark mode',
    });
    expect(prompt).toContain('preferences');
    expect(prompt).toContain('Uses vim');
    expect(prompt).toContain('newly added');
  });
});

describe('parsePatchResponse', () => {
  it('parses need_update true response', () => {
    const result = parsePatchResponse('{"need_update": true, "updated_content": "# preferences\\n## Editor\\n- Uses vim\\n- Prefers dark mode\\n"}');
    expect(result.needUpdate).toBe(true);
    expect(result.updatedContent).toContain('dark mode');
  });

  it('parses need_update false response', () => {
    const result = parsePatchResponse('{"need_update": false, "updated_content": ""}');
    expect(result.needUpdate).toBe(false);
  });

  it('handles malformed JSON gracefully', () => {
    const result = parsePatchResponse('not json');
    expect(result.needUpdate).toBe(false);
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/providers/memory/memoryfs/prompts.test.ts`
Expected: FAIL — module not found

**Step 3: Implement prompts**

```typescript
// src/providers/memory/memoryfs/prompts.ts

/**
 * LLM prompt templates for category summary generation.
 * Adapted from memU's category_summary/category.py and category_with_refs.py.
 */

// -- Summary generation (no refs) --

export function buildSummaryPrompt(params: {
  category: string;
  originalContent: string;
  newItems: string[];
  targetLength: number;
}): string {
  const { category, originalContent, newItems, targetLength } = params;
  const newItemsText = newItems.map(i => `- ${i}`).join('\n');

  return [
    '# Task Objective',
    'You are a User Profile Synchronization Specialist. Merge newly extracted user information items into the existing profile using add and update operations.',
    'No deletion -- only implicit replacement through newer items. Output the updated, complete profile.',
    '',
    '# Workflow',
    '1. Parse the original content: extract categories, preserve wording style and format.',
    '2. Parse new items: mark each as Add or Update. Distinguish stable facts from one-off events.',
    '3. Update: replace outdated entries with newer ones. Add: deduplicate, then insert into correct category.',
    `4. Summarize to target length of ${targetLength} tokens. Use markdown hierarchy. Cluster items by sub-topic.`,
    '5. Output only the updated markdown profile. No explanations, no meta text.',
    '',
    '# Output Format',
    '```markdown',
    `# ${category}`,
    '## <sub-topic>',
    '- User information item',
    '- User information item',
    '## <sub-topic>',
    '- User information item',
    '```',
    '',
    `Critical: Do not exceed ${targetLength} tokens. Merge or omit unimportant information to meet this limit.`,
    '',
    '# Input',
    'Topic:',
    category,
    '',
    'Original content:',
    '<content>',
    originalContent || '(empty -- this is a new category)',
    '</content>',
    '',
    'New memory items:',
    '<item>',
    newItemsText,
    '</item>',
  ].join('\n');
}

// -- Summary generation (with refs) --

export function buildSummaryPromptWithRefs(params: {
  category: string;
  originalContent: string;
  newItemsWithIds: Array<{ refId: string; content: string }>;
  targetLength: number;
}): string {
  const { category, originalContent, newItemsWithIds, targetLength } = params;
  const newItemsText = newItemsWithIds.map(i => `- [${i.refId}] ${i.content}`).join('\n');

  return [
    '# Task Objective',
    'You are a User Profile Synchronization Specialist. Merge newly extracted user information items into the existing profile.',
    'IMPORTANT: Include inline references using [ref:ITEM_ID] format when incorporating information from provided items.',
    '',
    '# Reference Rules',
    '1. Every piece of information from new memory items MUST have a [ref:ITEM_ID] citation',
    '2. Use the exact item ID provided in the input',
    '3. Place references immediately after the relevant statement',
    '4. Multiple sources can be cited: [ref:id1,id2]',
    '5. Existing information without new updates does not need references',
    '',
    '# Workflow',
    '1. Parse original content and new items (note each item\'s ID for [ref:ID] citations).',
    '2. Update existing info with refs. Add new info with refs.',
    `3. Summarize to ${targetLength} tokens. PRESERVE all [ref:ITEM_ID] citations.`,
    '4. Output only the updated markdown profile with inline references.',
    '',
    '# Output Format',
    '```markdown',
    `# ${category}`,
    '## <sub-topic>',
    '- User information item [ref:ITEM_ID]',
    '- User information item [ref:ITEM_ID,ITEM_ID2]',
    '```',
    '',
    `Critical: Do not exceed ${targetLength} tokens. Always include [ref:ITEM_ID] for new items.`,
    '',
    '# Input',
    'Topic:',
    category,
    '',
    'Original content:',
    '<content>',
    originalContent || '(empty -- this is a new category)',
    '</content>',
    '',
    'New memory items with IDs:',
    '<items>',
    newItemsText,
    '</items>',
  ].join('\n');
}

// -- Category patch (incremental CRUD update) --

export function buildPatchPrompt(params: {
  category: string;
  originalContent: string;
  updateContent: string;
}): string {
  const { category, originalContent, updateContent } = params;

  return [
    '# Task Objective',
    'Read an existing user profile and an update, then determine whether the profile needs updating.',
    'If yes, generate the updated profile. If no, indicate that no update is needed.',
    '',
    '# Response Format (JSON):',
    '{"need_update": true/false, "updated_content": "the updated markdown if needed, otherwise empty"}',
    '',
    '# Input',
    'Topic:',
    category,
    '',
    'Original content:',
    '<content>',
    originalContent,
    '</content>',
    '',
    'Update:',
    updateContent,
  ].join('\n');
}

export interface PatchResult {
  needUpdate: boolean;
  updatedContent: string;
}

export function parsePatchResponse(response: string): PatchResult {
  try {
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return { needUpdate: false, updatedContent: '' };
    const parsed = JSON.parse(jsonMatch[0]);
    return {
      needUpdate: Boolean(parsed.need_update),
      updatedContent: String(parsed.updated_content || ''),
    };
  } catch {
    return { needUpdate: false, updatedContent: '' };
  }
}
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/providers/memory/memoryfs/prompts.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/providers/memory/memoryfs/prompts.ts tests/providers/memory/memoryfs/prompts.test.ts
git commit -m "feat(memoryfs): add LLM prompt templates for summary generation and patching"
```

---

## Phase 3: Provider Wiring

### Task 8: MemoryFS Provider

**Files:**
- Create: `src/providers/memory/memoryfs/provider.ts`
- Create: `src/providers/memory/memoryfs/index.ts`
- Test: `tests/providers/memory/memoryfs/provider.test.ts`

**Context:** The provider implements `MemoryProvider` by wiring together the items store, summary I/O, extractor, content hash, and salience scoring. `memorize()` runs the full inline pipeline: extract -> dedup/reinforce -> write to SQLite -> update summary. `query()` searches items, ranks by salience. `write()` also deduplicates.

Refer to existing provider patterns:
- `src/providers/memory/memu.ts` -- factory signature `create(config: Config): Promise<MemoryProvider>`
- `src/providers/memory/sqlite.ts` -- SQLite + `AX_HOME` pattern
- `src/paths.ts` -- `dataFile()` for locating data directories

**Step 1: Write the failing tests**

```typescript
// tests/providers/memory/memoryfs/provider.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { create } from '../../../../src/providers/memory/memoryfs/provider.js';
import type { MemoryProvider, ConversationTurn } from '../../../../src/providers/memory/types.js';
import type { Config } from '../../../../src/types.js';

const config = {} as Config;

describe('memoryfs provider', () => {
  let memory: MemoryProvider;
  let testHome: string;

  beforeEach(async () => {
    testHome = await mkdtemp(join(tmpdir(), `memfs-provider-${randomUUID()}-`));
    process.env.AX_HOME = testHome;
    memory = await create(config);
  });

  afterEach(async () => {
    try { await rm(testHome, { recursive: true, force: true }); } catch {}
    delete process.env.AX_HOME;
  });

  it('write() stores an entry and returns an id', async () => {
    const id = await memory.write({
      scope: 'default',
      content: 'The API uses REST with JWT auth',
    });
    expect(id).toBeTruthy();
    const entry = await memory.read(id);
    expect(entry).not.toBeNull();
    expect(entry!.content).toBe('The API uses REST with JWT auth');
  });

  it('read() returns null for non-existent id', async () => {
    const entry = await memory.read(randomUUID());
    expect(entry).toBeNull();
  });

  it('query() finds entries by text match', async () => {
    await memory.write({ scope: 'default', content: 'Prefers TypeScript over JavaScript' });
    await memory.write({ scope: 'default', content: 'Uses PostgreSQL in production' });
    const results = await memory.query({ scope: 'default', query: 'TypeScript' });
    expect(results).toHaveLength(1);
    expect(results[0].content).toContain('TypeScript');
  });

  it('query() respects scope isolation', async () => {
    await memory.write({ scope: 'project-a', content: 'Uses React' });
    await memory.write({ scope: 'project-b', content: 'Uses Vue' });
    const results = await memory.query({ scope: 'project-a' });
    expect(results).toHaveLength(1);
    expect(results[0].content).toContain('React');
  });

  it('query() respects limit', async () => {
    for (let i = 0; i < 10; i++) {
      await memory.write({ scope: 'default', content: `Fact number ${i}` });
    }
    const results = await memory.query({ scope: 'default', limit: 3 });
    expect(results).toHaveLength(3);
  });

  it('list() returns entries for scope', async () => {
    await memory.write({ scope: 'default', content: 'Fact one' });
    await memory.write({ scope: 'default', content: 'Fact two' });
    const entries = await memory.list('default');
    expect(entries).toHaveLength(2);
  });

  it('delete() removes an entry', async () => {
    const id = await memory.write({ scope: 'default', content: 'To be deleted' });
    await memory.delete(id);
    const entry = await memory.read(id);
    expect(entry).toBeNull();
  });

  it('memorize() extracts facts from conversation', async () => {
    const conversation: ConversationTurn[] = [
      { role: 'user', content: 'Remember that I prefer dark mode in all editors' },
      { role: 'assistant', content: 'Got it, I will remember that.' },
    ];
    await memory.memorize!(conversation);
    const results = await memory.query({ scope: 'default', query: 'dark mode' });
    expect(results.length).toBeGreaterThanOrEqual(1);
  });

  it('memorize() deduplicates and reinforces', async () => {
    const conv1: ConversationTurn[] = [
      { role: 'user', content: 'Remember that I prefer TypeScript' },
    ];
    const conv2: ConversationTurn[] = [
      { role: 'user', content: 'Remember that I prefer TypeScript' },
    ];
    await memory.memorize!(conv1);
    await memory.memorize!(conv2);
    const results = await memory.query({ scope: 'default', query: 'TypeScript' });
    expect(results).toHaveLength(1);
  });

  it('preserves taint tags', async () => {
    const id = await memory.write({
      scope: 'default',
      content: 'External fact',
      taint: { source: 'web', trust: 'external', timestamp: new Date() },
    });
    const entry = await memory.read(id);
    expect(entry!.taint).toBeTruthy();
    expect(entry!.taint!.trust).toBe('external');
  });

  it('filters by agentId', async () => {
    await memory.write({ scope: 'default', content: 'Agent 1 fact', agentId: 'a1' });
    await memory.write({ scope: 'default', content: 'Agent 2 fact', agentId: 'a2' });
    const results = await memory.query({ scope: 'default', agentId: 'a1' });
    expect(results).toHaveLength(1);
    expect(results[0].content).toContain('Agent 1');
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/providers/memory/memoryfs/provider.test.ts`
Expected: FAIL -- module not found

**Step 3: Implement the provider**

```typescript
// src/providers/memory/memoryfs/provider.ts
import { join } from 'node:path';
import type { Config } from '../../../types.js';
import type {
  MemoryProvider, MemoryEntry, MemoryQuery, ConversationTurn,
} from '../types.js';
import { dataFile } from '../../../paths.js';
import { ItemsStore } from './items-store.js';
import { writeSummary, readSummary, initDefaultCategories } from './summary-io.js';
import { extractByRegex } from './extractor.js';
import { computeContentHash } from './content-hash.js';
import { salienceScore } from './salience.js';

export async function create(_config: Config): Promise<MemoryProvider> {
  const memoryDir = join(dataFile(''), 'memory');
  const dbPath = join(memoryDir, '_store.db');

  await initDefaultCategories(memoryDir);
  const store = new ItemsStore(dbPath);

  return {
    async write(entry: MemoryEntry): Promise<string> {
      const now = new Date().toISOString();
      const contentHash = computeContentHash(entry.content, 'knowledge');
      const scope = entry.scope || 'default';

      // Dedup: reinforce if same content exists
      const existing = store.findByHash(contentHash, scope, entry.agentId);
      if (existing) {
        store.reinforce(existing.id);
        return existing.id;
      }

      return store.insert({
        content: entry.content,
        memoryType: 'knowledge',
        category: 'knowledge',
        contentHash,
        confidence: 1.0,
        reinforcementCount: 1,
        lastReinforcedAt: now,
        createdAt: now,
        updatedAt: now,
        scope,
        agentId: entry.agentId,
        taint: entry.taint ? JSON.stringify(entry.taint) : undefined,
      });
    },

    async query(q: MemoryQuery): Promise<MemoryEntry[]> {
      const scope = q.scope || 'default';
      let items = q.query
        ? store.searchContent(q.query, scope, q.limit ?? 50)
        : store.listByScope(scope, q.limit ?? 50, q.agentId);

      if (q.agentId) {
        items = items.filter(i => i.agentId === q.agentId);
      }

      // Rank by salience
      const ranked = items.map(item => ({
        item,
        score: salienceScore({
          similarity: 1.0,
          reinforcementCount: item.reinforcementCount,
          lastReinforcedAt: item.lastReinforcedAt,
          recencyDecayDays: 30,
        }),
      }));
      ranked.sort((a, b) => b.score - a.score);

      // Reinforce accessed items
      for (const { item } of ranked) {
        store.reinforce(item.id);
      }

      return ranked.slice(0, q.limit ?? 50).map(({ item }) => ({
        id: item.id,
        scope: item.scope,
        content: item.content,
        taint: item.taint ? JSON.parse(item.taint) : undefined,
        createdAt: new Date(item.createdAt),
        agentId: item.agentId,
      }));
    },

    async read(id: string): Promise<MemoryEntry | null> {
      const item = store.getById(id);
      if (!item) return null;
      store.reinforce(id);
      return {
        id: item.id,
        scope: item.scope,
        content: item.content,
        taint: item.taint ? JSON.parse(item.taint) : undefined,
        createdAt: new Date(item.createdAt),
        agentId: item.agentId,
      };
    },

    async delete(id: string): Promise<void> {
      store.deleteById(id);
    },

    async list(scope: string, limit?: number): Promise<MemoryEntry[]> {
      const items = store.listByScope(scope, limit ?? 50);
      return items.map(item => ({
        id: item.id,
        scope: item.scope,
        content: item.content,
        taint: item.taint ? JSON.parse(item.taint) : undefined,
        createdAt: new Date(item.createdAt),
        agentId: item.agentId,
      }));
    },

    async memorize(conversation: ConversationTurn[]): Promise<void> {
      if (conversation.length === 0) return;
      const scope = 'default';

      // Step 1: Extract items via regex
      const candidates = extractByRegex(conversation, scope);

      // Step 2: Dedup/reinforce or insert
      const newItemsByCategory = new Map<string, string[]>();
      for (const candidate of candidates) {
        const existing = store.findByHash(candidate.contentHash, scope);
        if (existing) {
          store.reinforce(existing.id);
        } else {
          store.insert(candidate);
          const items = newItemsByCategory.get(candidate.category) || [];
          items.push(candidate.content);
          newItemsByCategory.set(candidate.category, items);
        }
      }

      // Step 3: Update category summaries (Phase 1: append bullets; later: LLM)
      for (const [category, newContents] of newItemsByCategory) {
        const existingSummary = await readSummary(memoryDir, category) || `# ${category}\n`;
        const newBullets = newContents.map(c => `- ${c}`).join('\n');
        const updated = `${existingSummary.trimEnd()}\n${newBullets}\n`;
        await writeSummary(memoryDir, category, updated);
      }
    },
  };
}
```

```typescript
// src/providers/memory/memoryfs/index.ts
export { create } from './provider.js';
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/providers/memory/memoryfs/provider.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/providers/memory/memoryfs/provider.ts src/providers/memory/memoryfs/index.ts tests/providers/memory/memoryfs/provider.test.ts
git commit -m "feat(memoryfs): wire MemoryProvider with inline memorize pipeline and salience ranking"
```

---

### Task 9: Provider Registration

**Files:**
- Modify: `src/host/provider-map.ts` -- add `memoryfs` to memory providers

**Context:** Add `memoryfs` to the static provider allowlist. This is the only file that maps provider names to module paths (SC-SEC-002).

**Step 1: Add memoryfs to provider map**

In `src/host/provider-map.ts`, find the `memory` section and add the new entry:

```typescript
  memory: {
    file:     '../providers/memory/file.js',
    sqlite:   '../providers/memory/sqlite.js',
    memu:     '../providers/memory/memu.js',
    memoryfs: '../providers/memory/memoryfs/index.js',
  },
```

**Step 2: Verify build compiles**

Run: `npm run build`
Expected: No type errors. The `MemoryProviderName` union type now includes `'memoryfs'`.

**Step 3: Commit**

```bash
git add src/host/provider-map.ts
git commit -m "feat(memoryfs): register memoryfs in provider map"
```

---

## Phase 4: Integration Test

### Task 10: Full Lifecycle Integration Test

**Files:**
- Create: `tests/providers/memory/memoryfs/integration.test.ts`

**Context:** End-to-end test exercising the complete pipeline: memorize -> query -> reinforce -> dedup -> delete. Verifies the provider works as a cohesive unit.

**Step 1: Write the integration test**

```typescript
// tests/providers/memory/memoryfs/integration.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { create } from '../../../../src/providers/memory/memoryfs/provider.js';
import type { MemoryProvider, ConversationTurn } from '../../../../src/providers/memory/types.js';
import type { Config } from '../../../../src/types.js';

const config = {} as Config;

describe('MemoryFS integration', () => {
  let memory: MemoryProvider;
  let testHome: string;

  beforeEach(async () => {
    testHome = await mkdtemp(join(tmpdir(), `memfs-integ-${randomUUID()}-`));
    process.env.AX_HOME = testHome;
    memory = await create(config);
  });

  afterEach(async () => {
    try { await rm(testHome, { recursive: true, force: true }); } catch {}
    delete process.env.AX_HOME;
  });

  it('full lifecycle: memorize -> query -> reinforcement', async () => {
    const conversation: ConversationTurn[] = [
      { role: 'user', content: 'Remember that I prefer dark mode in all editors' },
      { role: 'assistant', content: 'Noted!' },
      { role: 'user', content: 'I always run tests before committing' },
    ];
    await memory.memorize!(conversation);

    const darkMode = await memory.query({ scope: 'default', query: 'dark mode' });
    expect(darkMode.length).toBeGreaterThanOrEqual(1);

    const tests = await memory.query({ scope: 'default', query: 'tests' });
    expect(tests.length).toBeGreaterThanOrEqual(1);
  });

  it('dedup: same fact mentioned twice -> one entry reinforced', async () => {
    const conv1: ConversationTurn[] = [
      { role: 'user', content: 'Remember that I use PostgreSQL' },
    ];
    const conv2: ConversationTurn[] = [
      { role: 'user', content: 'Remember that I use PostgreSQL' },
    ];
    await memory.memorize!(conv1);
    await memory.memorize!(conv2);

    const results = await memory.query({ scope: 'default', query: 'PostgreSQL' });
    expect(results).toHaveLength(1);
  });

  it('write + read + delete round-trip', async () => {
    const id = await memory.write({
      scope: 'test-scope',
      content: 'Manual fact about the project',
    });

    const read = await memory.read(id);
    expect(read).not.toBeNull();
    expect(read!.content).toBe('Manual fact about the project');

    await memory.delete(id);
    const deleted = await memory.read(id);
    expect(deleted).toBeNull();
  });

  it('scope isolation', async () => {
    await memory.write({ scope: 'proj-a', content: 'Uses React' });
    await memory.write({ scope: 'proj-b', content: 'Uses Vue' });

    const a = await memory.query({ scope: 'proj-a' });
    expect(a).toHaveLength(1);
    expect(a[0].content).toContain('React');

    const b = await memory.query({ scope: 'proj-b' });
    expect(b).toHaveLength(1);
    expect(b[0].content).toContain('Vue');
  });

  it('summary files are created in memory directory', async () => {
    await memory.memorize!([
      { role: 'user', content: 'Remember that I prefer TypeScript' },
    ]);

    const memoryDir = join(testHome, 'memory');
    const files = await readdir(memoryDir);
    const mdFiles = files.filter(f => f.endsWith('.md'));
    expect(mdFiles.length).toBeGreaterThan(0);
  });
});
```

**Step 2: Run integration tests**

Run: `npx vitest run tests/providers/memory/memoryfs/integration.test.ts`
Expected: PASS

**Step 3: Commit**

```bash
git add tests/providers/memory/memoryfs/integration.test.ts
git commit -m "test(memoryfs): add full lifecycle integration tests"
```

---

## Build Order Summary

```
Phase 1: Storage Foundation
  Task 1:  Types                              <-- start here
  Task 2:  Items Store (SQLite)               <-- depends on Task 1
  Task 3:  Content Hashing                    <-- depends on Task 1
  Task 4:  Summary File I/O                   <-- depends on Task 1
  Task 5:  Salience Scoring                   <-- independent (pure math)

Phase 2: Extraction & Categorization
  Task 6:  Regex Extractor                    <-- depends on Tasks 1, 3
  Task 7:  Summary Prompts                    <-- independent (pure strings)

Phase 3: Provider Wiring
  Task 8:  MemoryFS Provider                  <-- depends on Tasks 2-7
  Task 9:  Provider Registration              <-- depends on Task 8

Phase 4: Integration
  Task 10: Integration Tests                  <-- depends on Task 8
```

---

## Future Work (not in this plan -- build when needed)

| Feature | When to build | How |
|---------|--------------|-----|
| **LLM extraction** | When regex patterns miss too many facts | Add `extractByLLM()` using per-type prompts from memU |
| **LLM summary generation** | When summary quality matters | Wire `buildSummaryPrompt()` into `memorize()` via LLMProvider |
| **FTS5 search index** | When item count makes LIKE scans slow | Add FTS5 virtual table to `_store.db` |
| **Embedding search (sqlite-vec)** | When semantic search is needed | Add `memory_vec` table, use in `query()` |
| **LLM reranker** | When search results need better relevance | Rerank top-N from FTS5 with LLM |
| **Category patch (CRUD)** | When `write()`/`delete()` need to update summaries | Use `buildPatchPrompt()` from Task 7 |
| **Item references** | When traceability is requested | Enable `enableItemReferences`, use `buildSummaryPromptWithRefs()` |
| **Related Files** | When cross-category links are useful | Add `## Related Files` section to summaries |

---

## Security Checklist

- [ ] All file paths use `safePath()` -- no raw `path.join()` with user input
- [ ] Scope isolation: every query scoped by `scope`, no cross-scope leaks
- [ ] Agent isolation: `agentId` filtering in queries
- [ ] No dynamic imports: `memoryfs` added to static `PROVIDER_MAP`
- [ ] Content from extraction gets taint-tagged when source is external
- [ ] SQLite uses WAL mode (via `openDatabase()`)
- [ ] Content hashing is deterministic and type-scoped

---

## Files Summary

### New Files (9 source + 7 test)

| File | Purpose |
|------|---------|
| `src/providers/memory/memoryfs/types.ts` | Types, memory types enum, config, defaults |
| `src/providers/memory/memoryfs/items-store.ts` | SQLite CRUD for memory items |
| `src/providers/memory/memoryfs/content-hash.ts` | Deterministic content hashing + ref IDs |
| `src/providers/memory/memoryfs/summary-io.ts` | Read/write category summary .md files |
| `src/providers/memory/memoryfs/salience.ts` | memU salience scoring formula |
| `src/providers/memory/memoryfs/extractor.ts` | Regex-based fact extraction |
| `src/providers/memory/memoryfs/prompts.ts` | LLM prompt templates for summaries |
| `src/providers/memory/memoryfs/provider.ts` | MemoryProvider implementation |
| `src/providers/memory/memoryfs/index.ts` | Module re-export |

### Modified Files (1)

| File | Change |
|------|--------|
| `src/host/provider-map.ts` | Add `memoryfs` to memory provider allowlist |

### Dependencies

**Zero new dependencies.** Uses only:
- `src/utils/sqlite.ts` (existing SQLite adapter)
- `src/utils/safe-path.ts` (existing path security)
- `src/paths.ts` (existing `dataFile()`)
- `node:crypto` (built-in, for content hashing)
