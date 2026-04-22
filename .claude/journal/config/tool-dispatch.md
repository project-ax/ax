# Tool Dispatch Config

Config surface for the tool-dispatch-unification plan — `tool_dispatch.mode` + `spill_threshold_bytes`.

## [2026-04-19 18:38] — Make tool_dispatch non-optional on Config interface

**Task:** Code-quality review on f926f3d3 flagged that `tool_dispatch?` was typed optional while `admin`/`history`/`sandbox`/`scheduler` — all using the same `.optional().default(...)` Zod pattern — are typed non-optional. The jsdoc "always populated" note was papering over a type mismatch that would force Tasks 3.3/3.4/3.5 to write `cfg.tool_dispatch!.mode`.
**What I did:** Dropped both `?` markers on `tool_dispatch` and `spill_threshold_bytes` in `src/types.ts`. Removed the now-redundant jsdoc note. Cleaned up the four `cfg.tool_dispatch!.` non-null assertions in the test file so it doesn't become a bad example for downstream tasks.
**Files touched:**
- Modified: `src/types.ts` (field + nested field now required; jsdoc trimmed)
- Modified: `tests/config-tool-dispatch.test.ts` (dropped 4 `!` non-null assertions)
**Outcome:** Success. 34/34 config tests green. `tsc --noEmit` clean. No existing consumers (verified by grep) so no downstream breakage.
**Notes:** Brings `tool_dispatch` in line with the established pattern for Zod-defaulted Config fields.

## [2026-04-19 18:33] — Add tool_dispatch config shape (Task 3.1)

**Task:** First task of Phase 3 in the tool-dispatch-unification plan — add a `tool_dispatch` config block with a `mode` of `direct` | `indirect` (default `indirect`) and a `spill_threshold_bytes` field (default 20480).
**What I did:** Added `tool_dispatch?: { mode; spill_threshold_bytes? }` to `Config` interface. Added matching `z.strictObject` to `ConfigSchema` in `src/config.ts` with `.optional().default({...})` pattern matching the existing `admin`/`history` blocks. Exported `DEFAULT_TOOL_DISPATCH_SPILL_THRESHOLD_BYTES = 20480` constant so downstream Phase 3 tasks (3.3 describe_tools handler, 3.4 call_tool handler, 3.5 agent tools) can reuse it instead of re-hardcoding the number. Wrote 8-test file `tests/config-tool-dispatch.test.ts` covering defaults, explicit modes, invalid modes, strict-mode rejection of unknown fields, and rejection of non-positive thresholds.
**Files touched:**
- Modified: `src/types.ts` (+9 lines — `tool_dispatch?` on Config interface with jsdoc)
- Modified: `src/config.ts` (+12 lines — constant + Zod schema entry)
- Created: `tests/config-tool-dispatch.test.ts` (100 lines, 8 tests)
**Outcome:** Success. New tests 8/8 green. Existing `tests/config.test.ts` + `tests/config-history.test.ts` still 26/26 green. Full host test suite still 1207/1236 (29 unrelated macOS Unix-socket path-too-long failures, same as baseline). `tsc --noEmit` clean.
**Notes:**
- **Parallel-path state:** config is defined and defaults are populated, but nothing reads it yet. Tasks 3.3/3.4/3.5 will consume `cfg.tool_dispatch.mode` to decide dispatch routing, and 3.4 will use `spill_threshold_bytes` for result-size spillover.
- **Test-signature deviation:** the plan specified `loadConfig({})` with an inline object, but the real `loadConfig(path?: string)` reads a YAML file. I matched the existing `withTempConfig` helper pattern from `tests/config.test.ts` instead — strictly a test-shape adaptation, same semantics.
- **Zod strict mode:** because `ConfigSchema` is `z.strictObject`, `tool_dispatch` had to be declared in the schema or every future ax.yaml with the field set would be rejected. The nested schema is also strict — unknown keys inside `tool_dispatch` throw (test covers).
- The Config interface still marks `tool_dispatch` optional (`?`), but after `loadConfig()` it is always populated — callers can non-null-assert safely (`cfg.tool_dispatch!.mode`).
