# Providers: Memory

Memory provider implementations, MemoryFS planning.

## [2026-03-02 16:22] — Add regex extractor with six memory types (Task 6 of 10)

**Task:** Implement regex-based memory extraction from conversation turns. Fast path (no LLM call) that outputs structured MemoryFSItem candidates with the six memory types.
**What I did:** Wrote test file first (TDD) with 6 tests covering explicit memory requests (profile), preferences (profile), action items (behavior), assistant turn filtering, 20-item cap, and field population (contentHash, scope, timestamps). Verified failure, then implemented extractByRegex function with three regex patterns and defaultCategoryForType mapping.
**Files touched:** src/providers/memory/memoryfs/extractor.ts (new), tests/providers/memory/memoryfs/extractor.test.ts (new)
**Outcome:** Success -- all 6 tests pass
**Notes:** Three regex patterns: explicit memory requests (confidence 0.95), preferences (0.7), and TODO/action items (0.8). Preference regex skipped if remember regex already matched to avoid duplicates. Max 20 items per conversation. Returns Omit<MemoryFSItem, 'id'> since IDs are assigned by the store layer.

## [2026-03-02 16:19] — Add salience scoring with memU formula (Task 5 of 10)

**Task:** Implement memU's salience scoring formula: similarity * log(reinforcement + 1) * exp(-0.693 * days / half_life). Pure math, no I/O.
**What I did:** Wrote test file first (TDD) with 7 tests covering positive scores, reinforcement ordering, recency ordering, half-life decay verification, null recency fallback, zero reinforcement edge case, and similarity ordering. Verified failure, then implemented salienceScore function. Had to fix two tests from the task spec that used reinforcementCount: 0 for ratio comparisons — log(0+1) = 0 makes the score 0, producing NaN ratios. Changed to reinforcementCount: 1 and added a dedicated zero-reinforcement test.
**Files touched:** src/providers/memory/memoryfs/salience.ts (new), tests/providers/memory/memoryfs/salience.test.ts (new)
**Outcome:** Success — all 7 tests pass
**Notes:** Formula uses ln(2) = 0.693 for proper half-life decay. Null lastReinforcedAt gets a fixed 0.5 recency factor. Zero reinforcement correctly produces 0 score since log(1) = 0.

## [2026-03-02 16:15] — Add summary file I/O with atomic writes (Task 4 of 10)

**Task:** Implement read/write for category summary .md files with safePath() for path safety and atomic writes via temp-then-rename.
**What I did:** Wrote test file first (TDD) with 9 tests covering round-trip, null for missing, overwrite, listing, underscore exclusion, categoryExists, initDefaultCategories (10 defaults), path traversal sanitization, and atomic write verification. Verified failure, then implemented writeSummary, readSummary, listCategories, categoryExists, initDefaultCategories.
**Files touched:** src/providers/memory/memoryfs/summary-io.ts (new), tests/providers/memory/memoryfs/summary-io.test.ts (new)
**Outcome:** Success — all 9 tests pass
**Notes:** safePath() sanitizes traversal attempts (replaces .. and / with _) rather than throwing, so the path traversal test verifies files stay inside memoryDir rather than expecting an exception. Atomic writes use randomUUID for temp file suffix.

## [2026-03-02 16:12] — Add content hashing with type-scoped dedup and ref IDs (Task 3 of 10)

**Task:** Create deterministic content hashing for deduplication matching memU's compute_content_hash, plus short ref ID builder.
**What I did:** Wrote test file first (TDD) with 6 tests covering determinism, type-scoping, whitespace normalization, case normalization, uniqueness, and ref ID slicing. Verified failure, then implemented computeContentHash (sha256 of "{type}:{normalized}" truncated to 16 hex chars) and buildRefId (first 6 chars).
**Files touched:** src/providers/memory/memoryfs/content-hash.ts (new), tests/providers/memory/memoryfs/content-hash.test.ts (new)
**Outcome:** Success — all 6 tests pass
**Notes:** Pure function module with no I/O. Uses node:crypto createHash. Normalization: lowercase + collapse whitespace + trim.

## [2026-03-02 16:09] — Add SQLite items store (Task 2 of 10)

**Task:** Create the SQLite-backed items store for CRUD on MemoryFSItem rows
**What I did:** Wrote test file first (TDD) with 10 tests covering insert/read, findByHash with scope isolation, reinforce (increment + timestamp), listByCategory, listByScope with limit, deleteById, searchContent with LIKE, agentId scoping, and getAllForCategory. Then implemented ItemsStore class using openDatabase() from src/utils/sqlite.ts with snake_case SQL columns mapped to camelCase MemoryFSItem via rowToItem().
**Files touched:** src/providers/memory/memoryfs/items-store.ts (new), tests/providers/memory/memoryfs/items-store.test.ts (new)
**Outcome:** Success — all 10 tests pass
**Notes:** Uses CREATE TABLE IF NOT EXISTS + 4 indexes (scope, category+scope, hash+scope, agent_id+scope). findByHash uses IS NULL for agent_id when no agentId provided, ensuring scope isolation. reinforce() updates both reinforcement_count and last_reinforced_at atomically.

## [2026-03-02 16:04] — Add MemoryFS v2 core types (Task 1 of 10)

**Task:** Create the core types module for the MemoryFS provider
**What I did:** Created types.ts with six memory types (profile, event, knowledge, behavior, skill, tool), MemoryFSItem interface, MemoryFSConfig interface, RefId type alias, and DEFAULT_CATEGORIES constant. Wrote test file first (TDD), verified failure, then implemented.
**Files touched:** src/providers/memory/memoryfs/types.ts (new), tests/providers/memory/memoryfs/types.test.ts (new)
**Outcome:** Success — all 3 tests pass
**Notes:** LLMProvider imported from ../../llm/types.js. This is the foundation for the remaining 9 tasks in the MemoryFS v2 plan.

## [2026-03-01 19:30] — Create MemoryFS implementation plan

**Task:** Review memory-proposal.md and memory-feedback.md, create a detailed implementation plan
**What I did:** Explored the full codebase to understand provider patterns, existing memory providers, IPC schemas, SQLite utilities, and test conventions. Synthesized both source documents into a 16-task, 5-phase implementation plan covering storage foundation, core memory path, git integration, organization/lifecycle, deep retrieval, proactive intelligence, and integration testing.
**Files touched:** docs/plans/2026-03-01-memoryfs-implementation.md (new)
**Outcome:** Success — plan created, committed, and pushed
**Notes:** Plan follows the writing-plans skill format with TDD steps per task. Incorporated all feedback recommendations: two-phase writes, reconciler, tiered decay (hot/warm/cold), manifest-backed categories, git history worker, fact fingerprinting, idempotency, sensitivity fields.
