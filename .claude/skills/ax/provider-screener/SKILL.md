---
name: provider-screener
description: Use when modifying skill content screeners — static analysis, permission validation, or exfiltration detection in src/providers/screener/
---

## Overview

The screener validates skill content before execution using 5-layer static analysis: hard-rejects, exfiltration detection, injection detection, external dependency checks, and undeclared permission flagging. Returns a scored verdict (APPROVE/REVIEW/REJECT) with detailed reasons.

## Interface (`src/providers/screener/types.ts`)

### ScreeningVerdict

| Field     | Type       | Notes                              |
|-----------|------------|------------------------------------|
| `allowed` | `boolean`  | Simple pass/fail                   |
| `reasons` | `string[]` | Human-readable rejection reasons   |

### ExtendedScreeningVerdict

| Field               | Type                              | Notes                                     |
|---------------------|-----------------------------------|-------------------------------------------|
| `verdict`           | `'APPROVE' \| 'REVIEW' \| 'REJECT'` | Scored outcome                         |
| `score`             | `number`                          | 0–1, clamped                              |
| `reasons`           | `ScreeningReason[]`               | Detailed match information                |
| `permissions`       | `string[]`                        | Detected capabilities                     |
| `excessPermissions` | `string[]`                        | Detected but undeclared permissions       |

### SkillScreenerProvider

| Method                                      | Description                                       |
|---------------------------------------------|---------------------------------------------------|
| `screen(content, declaredPermissions?)`      | Simple pass/fail screening                        |
| `screenExtended?(content, declaredPermissions?)` | Full scored verdict with details              |
| `screenBatch?(items)`                        | Batch screening (independent per item)            |

## Implementations

| Provider | File        | Detection Method                    | Notes                              |
|----------|-------------|-------------------------------------|------------------------------------|
| `none`   | `none.ts`   | None                                | Always approves; for testing/trusted envs |
| `static` | `static.ts` | 5-layer regex content analysis      | Score thresholds: ≥0.8→REJECT, ≥0.3→REVIEW, <0.3→APPROVE |

Provider map entries in `src/host/provider-map.ts`:
```
screener: {
  static: '../providers/screener/static.js',
  none:   '../providers/screener/none.js',
}
```

## Static Screener Details

### Five Analysis Layers

1. **Hard-rejects**: `exec`, `spawn`, `eval`, etc. — score 1.0 each, any one triggers REJECT.
2. **Exfiltration patterns**: Cumulative scoring for data extraction attempts.
3. **Injection patterns**: Cumulative scoring for code/prompt injection.
4. **External dependencies**: Flags external imports and network calls.
5. **Undeclared permissions**: Compares detected capabilities vs. declared permissions.

### Scoring

- Hard-reject patterns score 1.0 individually.
- Exfiltration/injection patterns are cumulative — combined score determines verdict.
- Threshold: ≥0.8 → REJECT, ≥0.3 → REVIEW, <0.3 → APPROVE.
- Score is clamped to [0, 1].

### Capability Detection

- Uses simple regex patterns (e.g., `\bfs\b.*\b(write|unlink)`) — not AST parsing.
- Detected capabilities compared against `declaredPermissions` array.
- Excess permissions (detected but undeclared) reported separately.

## Common Tasks

**Adding a new screening pattern:**
1. Add pattern to the appropriate layer in `static.ts`.
2. Assign a score weight and category.
3. Add test cases in `tests/providers/screener/static.test.ts`.

**Adding a new screener implementation:**
1. Create `src/providers/screener/<name>.ts` implementing `SkillScreenerProvider`.
2. Export `create(config: Config)`.
3. Add entry to `PROVIDER_MAP` in `src/host/provider-map.ts`.
4. Add tests in `tests/providers/screener/<name>.test.ts`.

## Gotchas

- **Hard-rejects are absolute**: A single hard-reject pattern (exec, spawn, eval) scores 1.0 and guarantees REJECT regardless of other scores.
- **Regex, not AST**: Capability detection uses simple patterns. False positives are possible on string literals or comments containing flagged keywords.
- **Zero-width chars are injection signals**: U+200B, U+200C, U+200D, UFEFF in content are flagged as injection attempts.
- **screenBatch is independent**: Each item is scored independently — no cross-item analysis.
- **`none` provider always approves**: Only use for testing or explicitly trusted environments.

## Key Files

- `src/providers/screener/types.ts` — Interface definitions (not a standalone file; check for inline types)
- `src/providers/screener/static.ts` — 5-layer static analyzer
- `src/providers/screener/none.ts` — Pass-through implementation
- `tests/providers/screener/static.test.ts`
