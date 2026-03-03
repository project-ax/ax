# Fix List: MemoryFS v2

**Generated from:** acceptance test results (2026-03-03)
**Updated:** 2026-03-03 (re-run after applying FIX-1, FIX-2)
**Updated:** 2026-03-03 (all embedding tests now PASS)
**Total issues:** 5 (Critical: 0, Major: 0, Minor: 2, Fixed: 3) + 2 config bugs found in BT-8 re-run

## Fixed

### FIX-1: LLM summary output wrapped in markdown code fences — FIXED
**Test:** IT-4
**Root cause:** Incorrect — LLM output not post-processed
**Fix applied:**
1. Added `stripCodeFences()` helper to `src/providers/memory/memoryfs/prompts.ts`
2. Updated `buildSummaryPrompt` and `buildSummaryPromptWithRefs` to instruct "Do NOT wrap in code fences"
3. `updateCategorySummary()` in `provider.ts` now calls `stripCodeFences(raw)` before writing
4. Added 5 unit tests for `stripCodeFences` + 1 test for prompt instruction
**Re-run result:** IT-4 now PASS — all 10 summary files have clean memU format

### FIX-2: LLM extraction produces different phrasings defeating content-hash dedup — PARTIALLY FIXED
**Test:** BT-2, IT-1
**Root cause:** Design flaw — content-hash dedup assumes identical text, but LLM extraction rephrased
**Fix applied:** Updated extraction prompt in `extractor.ts` to produce canonical, minimal, deterministic phrasings with examples of correct form
**Re-run result:**
- Memorize extraction dedup: **WORKING** — same fact produces same canonical text across conversations, reinforcement_count incremented correctly
- Agent explicit `write()` dedup: **NOT FIXED** — agent LLM produces different phrasings when calling the write tool directly
- Cross-conversation type inconsistency: **NOT FIXED** — LLM assigns different `memoryType` (knowledge vs profile) for same fact, causing different hashes despite identical text

### FIX-3: Slack App log level causes debug spam in ax.log — FIXED (previous run)
**Test:** N/A (discovered during test setup)
**Fix applied:** Changed Slack Bolt `App` and `boltLogger.getLevel()` from `LogLevel.DEBUG` to `LogLevel.INFO`
**Status:** Already committed in 2c44106

### FIX-6: Content hash includes memoryType prefix, causing false negatives on dedup — FIXED
**Test:** BT-2, IT-1
**Root cause:** Design flaw — `computeContentHash` uses `sha256("{type}:{normalized}")[:16]`, so identical text with different types produces different hashes
**Location:** `src/providers/memory/memoryfs/content-hash.ts:computeContentHash`
**Fix applied:** Removed `memoryType` from the hash input. Hash is now `sha256(normalized_content)[:16]` — type-agnostic, so the same fact deduplicates regardless of which memory type the LLM assigns.
**Files changed:** `content-hash.ts` (removed type param), `provider.ts` + `extractor.ts` (updated call sites), `content-hash.test.ts` (updated assertions)
**Re-run result:** BT-2 now PASS — 1 item with reinforcement_count=2 after two identical messages (was 2 items with different types before fix)

## Minor

### FIX-4: query() does not reinforce accessed items (plan deviation)
**Test:** ST-16-old (DEV-1)
**Root cause:** Incomplete — plan specifies read-path reinforcement but implementation omits it
**Location:** `src/providers/memory/memoryfs/provider.ts:query()` (lines 177-253)
**What's wrong:** The plan's data flow specifies "Reinforce accessed items → return" in the read path. The implementation does not call `store.reinforce()` on items returned by query.
**What to fix:** After ranking and slicing results, add: `for (const { item } of ranked) store.reinforce(item.id);`
**Estimated scope:** 1 file

### FIX-5: Explicit write() uses reinforcement_count=10 instead of plan's 1
**Test:** IT-3 (DEV-2)
**Root cause:** Incorrect — hardcoded value differs from plan
**Location:** `src/providers/memory/memoryfs/provider.ts:write()` (around line 155)
**What's wrong:** The plan specifies `reinforcementCount: 1` for new items via `write()`. The implementation uses `reinforcementCount: 10`.
**What to fix:** This may be intentional (explicit "remember this" should be more salient than auto-extracted facts). If so, document the deviation. If not, change to 1.
**Estimated scope:** 1 file (or just documentation)

## Suggested Fix Order

1. ~~**FIX-6** — Type-prefix hash dedup false negatives.~~ FIXED
2. **FIX-4** — Read-path reinforcement. Simple addition, improves salience accuracy.
3. **FIX-5** — Document or adjust write() reinforcement count.

## All Embedding Tests Now PASS (2026-03-03)

Previously skipped tests now pass with DeepInfra embeddings (Qwen/Qwen3-Embedding-0.6B):
- **BT-9:** Memory recall injects recalled context into new sessions via embedding strategy
- **IT-7:** Cross-session semantic recall works (Rust/Actix-web + AWS/ECS facts recalled)
- **IT-8:** Backfill runs on restart, directly-inserted items get embedded and become searchable

**Observation (shared with BT-8):** `findSimilar()` has no distance threshold — unrelated queries still return nearest neighbors from a small corpus. Not a bug with larger corpora, but consider adding a configurable minimum similarity cutoff for precision.

## Previously Tested (2026-03-03 BT-8 re-run)

### BT-8: Embedding generated on write and queryable — PASS
**Prerequisites resolved:**
- sqlite-vec now available
- Embedding client refactored to use shared `openai-compat.ts` (includes `deepinfra` base URL)
- Embedding model name case-sensitivity fixed in `fixtures/ax.yaml`

**Observation: No distance threshold in embedding search**
`findSimilar()` returns top-k results with no minimum similarity threshold. With a small corpus, unrelated queries still return items. Consider adding a configurable distance cutoff to improve precision.
