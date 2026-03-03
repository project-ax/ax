---
name: ax-testing
description: Use when writing or debugging tests — test structure, fixtures, mocking patterns, common assertions, and gotchas for the vitest/bun test suite in tests/
---

## Overview

AX uses vitest for Node.js and bun's native test runner as alternatives. Tests mirror the `src/` directory structure exactly. The project's bug fix policy requires that every bug fix includes a regression test. Test isolation is critical -- especially for SQLite databases and process-level state.

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
      modules/         # Per-module tests (identity, security, delegation, etc.)
      builder.test.ts  # PromptBuilder integration
    runners/           # Runner-specific tests
      claude-code.test.ts
      pi-session.test.ts
    runner.test.ts
    ipc-client.test.ts
    ipc-transport.test.ts
    local-tools.test.ts
    ipc-tools.test.ts
    mcp-server.test.ts
    tool-catalog.test.ts
    tool-catalog-sync.test.ts
  host/
    server.test.ts
    router.test.ts
    ipc-server.test.ts
    taint-budget.test.ts
    proxy.test.ts
    registry.test.ts
    event-bus.test.ts              # Streaming event bus
    event-bus-sse.test.ts          # SSE event streaming
    plugin-host.test.ts            # Plugin lifecycle
    plugin-lock.test.ts            # Plugin integrity
    plugin-manifest.test.ts        # Plugin capability schema
    plugin-provider-map.test.ts    # Plugin provider registration
    delegation-hardening.test.ts   # Subagent delegation edge cases
    server-files.test.ts           # File upload/download
    server-multimodal.test.ts      # Image pipeline
    server-completions-images.test.ts
    ipc-handlers/
      image.test.ts                # Image generation handler
      llm-events.test.ts           # LLM streaming events
  providers/
    llm/               # Per-provider tests (anthropic, openai, router, traced)
    image/             # Image provider tests (router, openrouter)
    memory/
    scanner/
    channel/
    web/
    browser/
    credentials/
    skills/
    screener/          # Static screener tests
    audit/
    sandbox/
    scheduler/
  provider-sdk/        # Provider SDK harness and interface tests
  clawhub/             # Registry client tests
  cli/
  onboarding/
  integration/         # End-to-end and smoke tests
  e2e/
    scenarios/
      delegation-stress.test.ts    # Delegation depth/concurrency stress tests
  acceptance/              # Feature acceptance tests (live LLM)
    fixtures/              # Shared test fixtures
    memoryfs-v2/           # MemoryFS v2 acceptance tests
    plainjob-scheduler/    # PlainJob scheduler acceptance tests
    llm-webhook-transforms/ # Webhook transform acceptance tests
    skills-install/        # Skills installation acceptance tests
  migrations/              # Database migration tests
  sandbox-isolation.test.ts  # Tool count assertions
  ipc-fuzz.test.ts
  conversation-store.test.ts
  conversation-store-structured.test.ts  # ContentBlock[] serialization
  conversation-store-summary.test.ts     # History summarization tests
  config.test.ts
  config-history.test.ts                 # History config validation
  job-store.test.ts                      # Scheduler job persistence
  session-store.test.ts                  # Session/channel tracking
```

## Test Patterns

### Factory Helpers

Create `makeXxx()` helpers for commonly-used test objects:

```typescript
function makeContext(overrides: Partial<PromptContext> = {}): PromptContext {
  return {
    agentType: 'pi-coding-agent',
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

**Critical**: Each test must use an isolated `AX_HOME` directory:

```typescript
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

### Mock Providers

Use stub/mock providers for tests:
```typescript
import { disabledProvider } from '../../src/utils/disabled-provider.js';
const mockWeb = disabledProvider<WebProvider>();
```

For LLM tests, use the `mock` provider that returns fixed responses.

## Tool Count Assertion

`tests/sandbox-isolation.test.ts` asserts the exact number of tools registered for each runner. **Security invariant** -- catches accidentally exposed tools. Update the expected count when adding new IPC tools.

## New Test Categories

Since the skills were created, several new test categories have been added:

- **Event bus tests**: `event-bus.test.ts`, `event-bus-sse.test.ts` -- test streaming observability
- **Plugin tests**: `plugin-host.test.ts`, `plugin-lock.test.ts`, `plugin-manifest.test.ts` -- test plugin lifecycle and integrity
- **Delegation stress tests**: `delegation-stress.test.ts` -- test depth/concurrency limits and zombie prevention
- **Image pipeline tests**: `server-multimodal.test.ts`, `server-completions-images.test.ts`, image handler tests
- **Provider SDK tests**: `provider-sdk/harness.test.ts`, `interfaces.test.ts`
- **Screener tests**: `providers/screener/static.test.ts` -- 5-layer static analysis
- **Tool catalog sync tests**: `tool-catalog-sync.test.ts` -- verifies ipc-tools.ts and mcp-server.ts stay in sync
- **Acceptance tests**: `tests/acceptance/` -- feature-level tests against live AX server with real LLM calls. Covers MemoryFS v2, plainjob scheduler, webhook transforms, and skills installation
- **History/memory tests**: `conversation-store-summary.test.ts`, `config-history.test.ts` -- conversation summarization and memory recall
- **Persistence tests**: `job-store.test.ts`, `session-store.test.ts` -- scheduler jobs and session tracking

## Common Tasks

**Writing a test for a bug fix:**
1. Create test file matching the source path
2. Write the test FIRST -- reproduce the bug with a failing assertion
3. Fix the bug
4. Verify the test passes

**Testing a new prompt module:**
1. Create `tests/agent/prompt/modules/<name>.test.ts`
2. Test `shouldInclude()` with various contexts (bootstrap mode, empty content, etc.)
3. Test `render()` output contains expected sections
4. Test `renderMinimal()` if implemented

**Testing a new provider:**
1. Create `tests/providers/<category>/<name>.test.ts`
2. Test `create(config)` returns a valid provider instance
3. Test each interface method
4. Test error handling and security constraints

## Gotchas

- **SQLite lock contention**: Tests sharing `AX_HOME` will deadlock. Always isolate. #1 source of flaky tests.
- **Tool count assertion**: Adding a tool without updating `sandbox-isolation.test.ts` fails CI.
- **Cleanup afterEach**: Always clean up temp dirs and reset env vars.
- **Vitest and Bun differences**: Both supported. Test with `npm test` as primary.
- **Don't mock what you don't own**: Prefer `mock` provider implementations over mocking interfaces.
- **Integration tests are slow**: Tests in `tests/integration/` spawn real processes. Use `--bail` to fail fast.
- **Conversation store tests need cleanup**: Tests inserting turns should call `store.clear()` in cleanup.
- **Parallel CI robustness**: Integration smoke tests must handle timing variations. Use retry loops and generous timeouts for process spawning.
- **Tool catalog sync test**: Validates that ipc-tools.ts and mcp-server.ts expose the same tools. Fails if you add a tool to one but not the other.
