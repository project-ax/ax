---
name: ax-utils
description: Use when working with path validation (safePath), SQLite adapter selection, or disabled provider stubs in src/utils/
---

## Overview

The utilities module provides three critical cross-cutting concerns: path traversal defense (`safePath`), a runtime-agnostic SQLite adapter, and a stub provider factory for disabled subsystems. These are used throughout the codebase and are security-critical.

## Key Files

| File | Responsibility | Key Exports |
|---|---|---|
| `src/utils/safe-path.ts` | Path traversal defense (SC-SEC-004) | `safePath()`, `assertWithinBase()` |
| `src/utils/sqlite.ts` | Runtime-agnostic SQLite wrapper | `openDatabase()`, `SQLiteDatabase`, `SQLiteStatement` |
| `src/utils/disabled-provider.ts` | Stub provider factory | `disabledProvider<T>()` |

## safePath (SC-SEC-004)

**Mandatory for ALL file-based providers.** Every file operation that constructs a path from external input MUST go through `safePath()`.

### API

```typescript
function safePath(baseDir: string, ...segments: string[]): string
```

**Sanitization pipeline:**
1. Remove forward and backward slashes from each segment
2. Strip null bytes
3. Remove `..` path components
4. Strip colons (prevents Windows drive letter injection)
5. Remove leading/trailing dots
6. Join segments with `path.join(baseDir, ...sanitized)`
7. Resolve to absolute path
8. Verify the resolved path starts with `baseDir` (containment check)
9. Throw on escape attempts

### assertWithinBase

```typescript
function assertWithinBase(baseDir: string, targetPath: string): void
```

Validates an already-resolved path is within `baseDir`. Useful for checking paths from external sources that aren't constructed by `safePath()`.

### Usage

```typescript
import { safePath } from '../utils/safe-path.js';

// In a provider or tool
const filePath = safePath(workspace, userProvidedFilename);
const content = readFileSync(filePath, 'utf-8');

// NEVER do this:
const bad = join(workspace, userProvidedFilename); // Path traversal!
```

## SQLite Adapter

### Runtime Detection

`openDatabase()` tries three SQLite implementations in order:

1. **`bun:sqlite`** — Native Bun SQLite (fastest, used in `bun test`)
2. **`node:sqlite`** — Node.js built-in (requires Node.js 22.5+)
3. **`better-sqlite3`** — npm package fallback

### API

```typescript
function openDatabase(path: string): SQLiteDatabase

interface SQLiteDatabase {
  prepare(sql: string): SQLiteStatement;
  exec(sql: string): void;
  close(): void;
}

interface SQLiteStatement {
  run(...params: unknown[]): { changes: number };
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}
```

### Default PRAGMAs

Every opened database gets:
- `PRAGMA journal_mode = WAL` — Write-ahead logging for concurrent reads
- `PRAGMA foreign_keys = ON` — Enforce referential integrity

### Usage

```typescript
import { openDatabase } from '../utils/sqlite.js';

const db = openDatabase(join(dataDir, 'conversations.db'));
db.exec('CREATE TABLE IF NOT EXISTS turns (...)');
const stmt = db.prepare('SELECT * FROM turns WHERE session_id = ?');
const rows = stmt.all(sessionId);
db.close();
```

## Disabled Provider

### Factory

```typescript
function disabledProvider<T>(): T
```

Returns a `Proxy` that throws `"Provider disabled"` on any property access or method call. Used for `none` provider implementations (e.g., `web/none`, `browser/none`).

### Usage

```typescript
import { disabledProvider } from '../utils/disabled-provider.js';
import type { WebProvider } from './types.js';

export function create(): WebProvider {
  return disabledProvider<WebProvider>();
}
```

Calling any method on the returned object throws immediately, preventing accidental use of disabled providers.

## Common Tasks

**Adding a new sanitization rule to safePath:**
1. Add the sanitization step to the pipeline in `safe-path.ts`
2. Add test cases in `tests/utils/safe-path.test.ts` covering the new attack vector
3. Verify existing tests still pass (don't break legitimate paths)

**Supporting a new SQLite runtime:**
1. Add a detection attempt in the try chain in `sqlite.ts`
2. Ensure it implements the `SQLiteDatabase`/`SQLiteStatement` interface
3. Test with both `npm test` and `bun test`

## Gotchas

- **`safePath()` is NOT optional**: Every file-based provider, local tool, and identity file operation MUST use it. This is a security invariant — skipping it is a path traversal vulnerability.
- **SQLite WAL mode requires cleanup in tests**: WAL creates `-wal` and `-shm` sidecar files. Test cleanup must remove the entire directory, not just the `.db` file.
- **Runtime detection order matters**: `bun:sqlite` is tried first. If running under Bun, it always wins. Under Node.js, `node:sqlite` is preferred over `better-sqlite3`.
- **Disabled provider throws on ANY access**: Even property reads throw. Don't try to check if a provider is disabled by reading a property — it will throw.
- **`safePath` strips more than you'd expect**: Colons, leading dots, trailing dots are all stripped. This can surprise when dealing with legitimate filenames containing these characters.
- **SQLite `close()` is important**: Always close databases in cleanup, especially in tests. Open handles prevent directory deletion on some platforms.
