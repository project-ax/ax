# Testing: Acceptance

Acceptance test skill and framework for validating features against plan design goals.

## [2026-03-03 11:30] — Add acceptance test skill and tests/acceptance/ directory

**Task:** Create a Claude Code skill that designs, runs, and analyzes acceptance tests for AX features against their original plan documents
**What I did:** Created `.claude/skills/acceptance-test/SKILL.md` — a comprehensive 5-phase skill that walks through feature selection, test design (structural/behavioral/integration), execution against a live server, failure analysis with root cause classification, and fix list generation. Also created `tests/acceptance/README.md` for the test artifact directory.
**Files touched:**
- `.claude/skills/acceptance-test/SKILL.md` (new) — the skill itself
- `tests/acceptance/README.md` (new) — directory README explaining structure
- `.claude/journal/testing/acceptance.md` (new) — this journal entry
- `.claude/journal/testing/index.md` (modified) — added entry reference
**Outcome:** Success. Skill registers automatically and appears in the skills list. Covers all 52 plan files with a feature reference table, provides test templates for 3 categories, includes auto-start server logic, and produces structured output (test-plan.md, results.md, fixes.md).
**Notes:** Key design decisions: (1) Tests are markdown not code because LLM responses are non-deterministic — the agent evaluates with judgment. (2) Two-layer verification: structural ground truth (files, DB, audit) plus behavioral intent checks. (3) Auto-start server with health poll. (4) Test plans saved as artifacts so they can be reviewed before execution and re-run later.
