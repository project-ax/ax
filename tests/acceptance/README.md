# Acceptance Tests

Manual acceptance tests that validate AX features against their original design plans using a real running server with real LLM calls.

These are different from the unit tests (`tests/`) and E2E tests (`tests/e2e/`) which use mocked LLMs and in-memory harnesses. Acceptance tests catch the gaps between what a plan specified and what was actually built.

## How to run

Use the `acceptance-test` Claude Code skill. It will walk you through selecting a feature, designing tests, executing them, and producing a fix list.

## Directory structure

```
tests/acceptance/
  <feature-name>/
    test-plan.md      # Test cases designed from the plan's acceptance criteria
    results.md        # Execution results with evidence
    fixes.md          # Prioritized list of issues to fix
```

Each feature gets its own subdirectory. Test plans are reusable — you can re-run them after fixing issues to verify the fixes.

## Test categories

- **Structural (ST-*)**: Verify code shape, file existence, interface contracts. Fast and deterministic.
- **Behavioral (BT-*)**: Verify feature works via chat interaction with the live server. Non-deterministic but tests real behavior.
- **Integration (IT-*)**: Verify multi-step flows, state persistence, cross-component interaction. Uses session persistence.

## Tips

Start with structural tests. If the code isn't wired up correctly, behavioral tests will obviously fail too. Check the audit log (`~/.ax/data/audit.jsonl`) for ground truth on what the server actually did during a request.
