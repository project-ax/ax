# Refactoring: Cleanup

General refactoring, stale reference cleanup, path realignment, dependency updates.

## [2026-03-05 13:00] — Fix stale provider references in test files

**Task:** Update all remaining references to removed provider names (sqlite, etc.) in test files
**What I did:** Fixed 6 test files: (1) `tests/config-history.test.ts` — replaced 3 inline YAML `memory: sqlite` with `memory: memoryfs`. (2) `tests/onboarding/wizard.test.ts:63` — changed expected memory provider from `sqlite` to `memoryfs`. (3) `tests/integration/phase2.test.ts:432-438` — replaced import of removed `memory/sqlite.js` with `memory/memoryfs/index.js`, updated assertion from `memorize` being undefined to being a function (memoryfs has memorize). (4) `tests/integration/phase1.test.ts` — updated 4 assertions: memory `sqlite`->`memoryfs`, audit `sqlite`->`file`, removed duplicate `sqlite` check on memory map, changed audit map check from `sqlite` to `database`. (5) `tests/host/provider-map.test.ts:7` — updated resolve path assertion to `memoryfs/index.js`. (6) `tests/host/plugin-provider-map.test.ts:79` — same resolve path update.
**Files touched:** tests/config-history.test.ts, tests/onboarding/wizard.test.ts, tests/integration/phase2.test.ts, tests/integration/phase1.test.ts, tests/host/provider-map.test.ts, tests/host/plugin-provider-map.test.ts
**Outcome:** Success — all stale sqlite/memory provider references in test files updated to match current provider-map.ts
**Notes:** The PROVIDER_MAP now has `memory: { memoryfs }` (no sqlite), `audit: { file, database }` (no sqlite). Tests must match these entries exactly.

## [2026-03-05 12:00] — Update YAML configs for database refactor provider renames

**Task:** Update all YAML configuration files to use new provider names after removing old sqlite/postgresql providers
**What I did:** Applied provider name replacements across 15 YAML files: (1) `memory: sqlite` -> `memory: memoryfs` in 13 files. (2) `audit: sqlite` -> `audit: file` in 6 local configs, `audit: database` in 3 k8s/production configs. (3) `storage: sqlite` -> `storage: file` in 3 local configs. (4) `storage: postgresql` -> `storage: database` + added `database: postgresql` in 4 k8s/production configs. (5) Updated YAML comment in ax-k8s.yaml referencing old provider name.
**Files touched:** ax.yaml, tests/integration/ax-test{,-seatbelt,-pi-coding-agent,-groq,-standard,-power}.yaml, tests/acceptance/fixtures/{ax,ax-k8s,kind-values}.yaml, charts/ax/values.yaml, flux/{staging,production}/helm-release.yaml, tests/acceptance/k8s-agent-compute/kind-values.yaml
**Outcome:** Success — verified no remaining `memory: sqlite`, `audit: sqlite`, `storage: sqlite`, or `storage: postgresql` in any YAML files
**Notes:** flux configs still have `history: sqlite` and `scheduler: sqlite` which are separate provider categories not part of this refactor. Also updated comment in ax-test-standard.yaml that referenced "sqlite audit".

## [2026-03-03 21:45] — Fix PR #60: production dependency bumps (7 packages)

**Task:** Fix Dependabot PR #60 that bumps 7 production dependencies including 3 major version bumps (ink 5→6, marked 11→17, react 18→19)
**What I did:** (1) Merged dependabot branch into working branch. (2) Fixed `AuthStorage` constructor change in pi-agent-core 0.55.4 — now uses `AuthStorage.create()` factory method instead of `new AuthStorage()`. (3) Rewrote `src/cli/utils/markdown.ts` renderer for marked v17 API — all methods now use token objects instead of positional args, `this.parser.parseInline(tokens)` for inline rendering, and `list()` must manually iterate items via `this.listitem()` instead of `this.parser.parse(token.items)`. (4) React 18→19 and Ink 5→6 required zero code changes.
**Files touched:** `src/agent/runners/pi-session.ts`, `src/cli/utils/markdown.ts`, `package.json`, `package-lock.json`
**Outcome:** Success — build clean, all 208 test files pass (2298 tests)
**Notes:** The marked v17 `list()` renderer cannot pass `token.items` to `this.parser.parse()` because the parser doesn't recognize `list_item` tokens. Must iterate items manually and call `this.listitem(item)` for each.

## [2026-03-01 15:50] — Clean up stale scratch tier references

**Task:** Remove stale "scratch" tier references from tool catalog, MCP server, and runtime prompt after upstream PR removed the scratch tier from IPC schemas
**What I did:** (1) Reverted `.filter(t => t.name !== 'write')` in pi-session.ts so local `write` tool is available for ephemeral `/scratch` writes. (2) Updated 4 tier description strings in tool-catalog.ts from `"agent", "user", or "scratch"` to `"agent" or "user"`. (3) Updated 1 tier description in mcp-server.ts similarly. (4) Renamed runtime prompt section from "Workspace Tiers" to "Workspace" and added `/scratch` ephemeral working directory description. (5) Updated test assertions to match new heading.
**Files touched:** `src/agent/runners/pi-session.ts`, `src/agent/tool-catalog.ts`, `src/agent/mcp-server.ts`, `src/agent/prompt/modules/runtime.ts`, `tests/agent/prompt/enterprise-runtime.test.ts`
**Outcome:** Success — build clean, all 2005 tests pass
**Notes:** The mcp-server.ts file had a stale reference not mentioned in the original plan. Always grep broadly for stale references when cleaning up removed features.
