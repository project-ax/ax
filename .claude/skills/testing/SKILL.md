---
name: ax-testing
description: Use when writing or debugging tests — test structure, fixtures, mocking patterns, common assertions, and gotchas for the vitest/bun test suite in tests/
---

## Overview

AX uses vitest for Node.js and bun's native test runner as alternatives. Tests mirror the `src/` directory structure exactly. The project's bug fix policy requires that every bug fix includes a regression test. Test isolation is critical — especially for SQLite databases and process-level state.

## Commands

```bash
npm test              # Run all tests (vitest on Node.js)
bun test              # Run all tests (Bun native runner)
npm run test:fuzz     # Run fuzz tests (vitest --run tests/ipc-fuzz.test.ts)
```

## Directory Structure

Tests mirror `src/` exactly:

```
tests/
  agent/
    prompt/
      modules/         # Per-module tests (identity, security, etc.)
      builder.test.ts  # PromptBuilder integration
    runner.test.ts
    ipc-client.test.ts
    local-tools.test.ts
    ipc-tools.test.ts
    mcp-server.test.ts
    stream-utils.test.ts
    heartbeat-state.test.ts
    identity-loader.test.ts
  host/
    server.test.ts
    router.test.ts
    ipc-server.test.ts
    taint-budget.test.ts
    proxy.test.ts
    registry.test.ts
  providers/
    llm/               # Per-provider tests
    memory/
    scanner/
    channel/
    web/
    browser/
    credentials/
    skills/
    audit/
    sandbox/
    scheduler/
  cli/
    chat.test.ts
    send.test.ts
    bootstrap.test.ts
  onboarding/
    wizard.test.ts
    configure.test.ts
  integration/          # End-to-end and smoke tests
  sandbox-isolation.test.ts  # Tool count assertions
  ipc-fuzz.test.ts     # Fuzz testing
  conversation-store.test.ts
  db.test.ts
  config.test.ts
```

## Test Patterns

### Factory Helpers

Create `makeXxx()` helpers for commonly-used test objects:

```typescript
function makeContext(overrides: Partial<PromptContext> = {}): PromptContext {
  return {
    agentType: 'pi-agent-core',
    workspace: '/tmp/test-ws',
    sandboxType: 'subprocess',
    profile: 'balanced',
    taintRatio: 0,
    taintThreshold: 0.3,
    identityFiles: { agents: '', soul: 'Test soul', identity: '', user: '', bootstrap: '', userBootstrap: '', heartbeat: '' },
    contextContent: '',
    skills: [],
    maxTokens: 200000,
    historyTokens: 0,
    ...overrides,
  };
}
```

### SQLite Test Isolation

**Critical**: Each test must use an isolated `AX_HOME` directory to prevent SQLite lock contention:

```typescript
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

let tmpDir: string;

beforeEach(() => {
  tmpDir = join(tmpdir(), `ax-test-${randomUUID()}`);
  mkdirSync(tmpDir, { recursive: true });
  process.env.AX_HOME = tmpDir;
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.AX_HOME;
});
```

### Onboarding Test Pattern

Tests for the wizard use `runOnboarding()` with programmatic answers:

```typescript
await runOnboarding({
  outputDir: dir,
  answers: {
    profile: 'balanced',
    apiKey: 'sk-test-key-12345',
    channels: ['cli'],
    skipSkills: true,
  },
});
const config = parseYaml(readFileSync(join(dir, 'ax.yaml'), 'utf-8'));
expect(config.profile).toBe('balanced');
```

### Mock Providers

Use stub/mock providers for tests that don't need real implementations:

```typescript
import { disabledProvider } from '../../src/utils/disabled-provider.js';
const mockWeb = disabledProvider<WebProvider>();
```

For LLM tests, use the `mock` provider that returns fixed responses.

## Tool Count Assertion

`tests/sandbox-isolation.test.ts` asserts the exact number of tools registered for each runner. This is a **security invariant** — it catches accidentally exposed tools.

When adding a new IPC tool, you MUST update the expected tool count in this test. The test will fail with a count mismatch otherwise.

## Common Tasks

**Writing a test for a bug fix:**
1. Create test file matching the source path (e.g., `tests/host/router.test.ts` for `src/host/router.ts`)
2. Write the test FIRST — reproduce the bug with a failing assertion
3. Fix the bug
4. Verify the test passes
5. Ensure the test would catch the bug if it regresses

**Testing a new prompt module:**
1. Create `tests/agent/prompt/modules/<name>.test.ts`
2. Test `shouldInclude()` with various contexts (bootstrap mode, empty content, etc.)
3. Test `render()` output contains expected sections
4. Test `renderMinimal()` if implemented
5. Test interaction with budget allocation

**Testing a new provider:**
1. Create `tests/providers/<category>/<name>.test.ts`
2. Test `create(config)` returns a valid provider instance
3. Test each interface method with expected inputs
4. Test error handling (invalid input, network failures)
5. Test security constraints (safePath, taint tagging)

## Gotchas

- **SQLite lock contention**: Tests sharing the same `AX_HOME` will deadlock on WAL locks. Always isolate with `AX_HOME` per test. This is the #1 source of flaky tests.
- **Tool count assertion**: Adding a tool without updating `sandbox-isolation.test.ts` will fail CI. The count is intentionally strict.
- **pi-ai auto-registers providers on import**: Tests importing `@mariozechner/pi-ai` must call `clearApiProviders()` to avoid side effects.
- **Cleanup afterEach**: Always clean up temp directories and reset env vars. Leaked state causes cascading failures.
- **Vitest and Bun differences**: Both are supported. Vitest uses standard `describe/test/expect`. Bun uses the same API but with different internal resolution. Test with `npm test` as the primary.
- **Don't mock what you don't own**: Prefer the `mock` provider implementation over mocking provider interfaces directly. The mock providers exercise the real contract.
- **Integration tests are slow**: Tests in `tests/integration/` spawn real processes. Run them separately or with `--bail` to fail fast.
- **Conversation store tests need prune**: Tests that insert many turns should call `store.prune()` or `store.clear()` in cleanup to avoid disk accumulation.
