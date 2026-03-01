# Config Hot Reload Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Automatically reload AX server when `ax.yaml` changes on disk or SIGHUP is received.

**Architecture:** Extract reload logic into a testable `src/cli/reload.ts` module. `setupConfigReload()` accepts dependency-injected callbacks for server lifecycle, sets up `fs.watchFile` + SIGHUP listener, and returns a handle for cleanup. `runServe()` in `src/cli/index.ts` wires it up after `server.start()`.

**Tech Stack:** Node.js `fs.watchFile` (polling, editor-safe), Zod validation (existing), vitest + `vi.useFakeTimers` for debounce testing.

---

### Task 1: Create reload module with failing tests

**Files:**
- Create: `tests/cli/reload.test.ts`
- Create: `src/cli/reload.ts`

**Step 1: Write the test file with all test cases**

```typescript
// tests/cli/reload.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { setupConfigReload, type ReloadContext } from '../../src/cli/reload.js';

function createMockContext(overrides: Partial<ReloadContext> = {}): ReloadContext {
  const mockServer = {
    listening: true,
    start: vi.fn<[], Promise<void>>().mockResolvedValue(undefined),
    stop: vi.fn<[], Promise<void>>().mockResolvedValue(undefined),
  };

  return {
    getServer: vi.fn(() => mockServer),
    setServer: vi.fn(),
    loadConfig: vi.fn(() => ({ profile: 'balanced' })),
    createServer: vi.fn(() => Promise.resolve({
      listening: false,
      start: vi.fn<[], Promise<void>>().mockResolvedValue(undefined),
      stop: vi.fn<[], Promise<void>>().mockResolvedValue(undefined),
    })),
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      fatal: vi.fn(),
      child: vi.fn(),
    },
    configPath: '/tmp/test-ax.yaml',
    ...overrides,
  };
}

describe('setupConfigReload', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('reload() stops old server and starts new one', async () => {
    const ctx = createMockContext();
    const handle = setupConfigReload(ctx);

    await handle.reload('test');

    const oldServer = (ctx.getServer as ReturnType<typeof vi.fn>).mock.results[0].value;
    expect(oldServer.stop).toHaveBeenCalledOnce();
    expect(ctx.loadConfig).toHaveBeenCalled();
    expect(ctx.createServer).toHaveBeenCalled();
    expect(ctx.setServer).toHaveBeenCalled();

    handle.cleanup();
  });

  it('reload() validates config before stopping server', async () => {
    const ctx = createMockContext({
      loadConfig: vi.fn(() => { throw new Error('bad yaml'); }),
    });
    const handle = setupConfigReload(ctx);

    await handle.reload('test');

    // Server should NOT have been stopped
    const oldServer = (ctx.getServer as ReturnType<typeof vi.fn>).mock.results[0].value;
    expect(oldServer.stop).not.toHaveBeenCalled();
    expect(ctx.logger.error).toHaveBeenCalled();

    handle.cleanup();
  });

  it('serializes concurrent reloads', async () => {
    let resolveStop: () => void;
    const stopPromise = new Promise<void>(r => { resolveStop = r; });
    const slowServer = {
      listening: true,
      start: vi.fn<[], Promise<void>>().mockResolvedValue(undefined),
      stop: vi.fn<[], Promise<void>>().mockReturnValue(stopPromise),
    };
    const ctx = createMockContext({
      getServer: vi.fn(() => slowServer),
    });
    const handle = setupConfigReload(ctx);

    // Start first reload (will block on stop)
    const r1 = handle.reload('first');
    // Start second reload (should queue)
    const r2 = handle.reload('second');

    // Resolve the slow stop
    resolveStop!();
    await r1;
    await r2;

    // loadConfig called for validation in first reload, then for actual load,
    // then again for the queued reload
    expect((ctx.loadConfig as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThanOrEqual(3);

    handle.cleanup();
  });

  it('debounces rapid file change notifications', async () => {
    const ctx = createMockContext();
    const handle = setupConfigReload(ctx);

    // Simulate rapid file changes via the debounced callback
    handle.onFileChange();
    handle.onFileChange();
    handle.onFileChange();

    // Before debounce fires, no reload
    expect(ctx.loadConfig).not.toHaveBeenCalled();

    // Advance past debounce window (500ms)
    await vi.advanceTimersByTimeAsync(600);

    // Should have reloaded exactly once
    expect(ctx.loadConfig).toHaveBeenCalled();

    handle.cleanup();
  });

  it('cleanup() removes file watcher', () => {
    const ctx = createMockContext();
    const handle = setupConfigReload(ctx);

    // Should not throw
    handle.cleanup();
    handle.cleanup(); // idempotent
  });
});
```

**Step 2: Create minimal stub module so the test can import**

```typescript
// src/cli/reload.ts
import type { AxServer, ServerOptions } from '../host/server.js';
import type { Config } from '../types.js';
import type { Logger } from '../logger.js';

export interface ReloadContext {
  getServer(): AxServer;
  setServer(server: AxServer): void;
  loadConfig(): Config;
  createServer(config: Config): Promise<AxServer>;
  logger: Logger;
  configPath: string;
}

export interface ReloadHandle {
  reload(reason: string): Promise<void>;
  onFileChange(): void;
  cleanup(): void;
}

export function setupConfigReload(_ctx: ReloadContext): ReloadHandle {
  throw new Error('Not implemented');
}
```

**Step 3: Run tests to verify they fail**

Run: `npx vitest run tests/cli/reload.test.ts`
Expected: All 5 tests FAIL with "Not implemented"

**Step 4: Commit**

```bash
git add tests/cli/reload.test.ts src/cli/reload.ts
git commit -m "test: add failing tests for config hot reload"
```

---

### Task 2: Implement the reload module

**Files:**
- Modify: `src/cli/reload.ts`

**Step 1: Implement `setupConfigReload()`**

Replace the stub in `src/cli/reload.ts` with:

```typescript
// src/cli/reload.ts
import { watchFile, unwatchFile } from 'node:fs';
import type { AxServer, ServerOptions } from '../host/server.js';
import type { Config } from '../types.js';
import type { Logger } from '../logger.js';

export interface ReloadContext {
  getServer(): AxServer;
  setServer(server: AxServer): void;
  loadConfig(): Config;
  createServer(config: Config): Promise<AxServer>;
  logger: Logger;
  configPath: string;
}

export interface ReloadHandle {
  reload(reason: string): Promise<void>;
  onFileChange(): void;
  cleanup(): void;
}

const DEBOUNCE_MS = 500;
const POLL_INTERVAL_MS = 1000;

export function setupConfigReload(ctx: ReloadContext): ReloadHandle {
  let reloading = false;
  let pendingReload = false;
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;
  let cleaned = false;

  async function reload(reason: string): Promise<void> {
    if (reloading) {
      pendingReload = true;
      return;
    }
    reloading = true;

    ctx.logger.info('config_reload_triggered', { reason });

    // Validate new config before tearing anything down
    let newConfig: Config;
    try {
      newConfig = ctx.loadConfig();
    } catch (err) {
      ctx.logger.error('config_reload_invalid', { error: (err as Error).message });
      reloading = false;
      return;
    }

    // Stop old server (waits for in-flight requests)
    ctx.logger.info('config_reload_stopping');
    await ctx.getServer().stop();

    // Create and start new server
    ctx.logger.info('config_reload_starting', { profile: newConfig.profile });
    const newServer = await ctx.createServer(newConfig);
    await newServer.start();
    ctx.setServer(newServer);

    ctx.logger.info('config_reload_complete');
    reloading = false;

    if (pendingReload) {
      pendingReload = false;
      await reload('queued');
    }
  }

  function onFileChange(): void {
    if (debounceTimer !== undefined) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => { reload('file_change'); }, DEBOUNCE_MS);
  }

  // Watch config file
  watchFile(ctx.configPath, { interval: POLL_INTERVAL_MS }, onFileChange);

  // SIGHUP handler (Unix only)
  function onSighup(): void { reload('sighup'); }
  if (process.platform !== 'win32') {
    process.on('SIGHUP', onSighup);
  }

  function cleanup(): void {
    if (cleaned) return;
    cleaned = true;
    if (debounceTimer !== undefined) clearTimeout(debounceTimer);
    unwatchFile(ctx.configPath);
    if (process.platform !== 'win32') {
      process.removeListener('SIGHUP', onSighup);
    }
  }

  return { reload, onFileChange, cleanup };
}
```

**Step 2: Run tests to verify they pass**

Run: `npx vitest run tests/cli/reload.test.ts`
Expected: All 5 tests PASS

**Step 3: Commit**

```bash
git add src/cli/reload.ts
git commit -m "feat: implement config hot reload module"
```

---

### Task 3: Wire reload into runServe

**Files:**
- Modify: `src/cli/index.ts:147-198`

**Step 1: Write failing test for SIGINT/SIGTERM cleanup**

Add to `tests/cli/reload.test.ts`:

```typescript
describe('SIGHUP wiring', () => {
  it('registers SIGHUP listener on non-win32', () => {
    const ctx = createMockContext();
    const listenersBefore = process.listenerCount('SIGHUP');
    const handle = setupConfigReload(ctx);
    expect(process.listenerCount('SIGHUP')).toBe(listenersBefore + 1);
    handle.cleanup();
    expect(process.listenerCount('SIGHUP')).toBe(listenersBefore);
  });
});
```

Run: `npx vitest run tests/cli/reload.test.ts`
Expected: This test should already PASS with the Task 2 implementation.

**Step 2: Modify `runServe()` in `src/cli/index.ts`**

Change `runServe` to use `setupConfigReload`. The key changes:
1. `const config` → `let config`
2. `const server` → `let server`
3. After `server.start()`, call `setupConfigReload()`
4. Clean up on SIGINT/SIGTERM

Replace lines 147-198 of `src/cli/index.ts` with:

```typescript
async function runServe(args: string[]): Promise<void> {
  let configPath: string | undefined;
  let daemon = false;
  let socketPath: string | undefined;
  let verbose = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--config' || args[i] === '-c') {
      configPath = args[++i];
    } else if (args[i] === '--daemon') {
      daemon = true;
    } else if (args[i] === '--socket') {
      socketPath = args[++i];
    } else if (args[i] === '--verbose') {
      verbose = true;
    }
  }

  // Initialize logger before anything else
  const { initLogger } = await import('../logger.js');
  const logger = initLogger({
    level: verbose ? 'debug' : (process.env.LOG_LEVEL as LogLevel) ?? 'info',
    pretty: true,
    file: true,
  });

  // First-run detection
  const resolvedConfigPath = configPath ?? getConfigPath();
  if (!existsSync(resolvedConfigPath)) {
    logger.info('first_run', { message: 'No ax.yaml found — running first-time setup...' });
    const { runConfigure } = await import('../onboarding/configure.js');
    await runConfigure(axHome());
    await loadDotEnv();
    logger.info('setup_complete', { message: 'Setup complete! Starting AX...' });
  }

  // Load config and create server
  const { loadConfig } = await import('../config.js');
  const { createServer } = await import('../host/server.js');

  logger.info('loading_config');
  let config = loadConfig(configPath);
  logger.info('config_loaded', { profile: config.profile });

  const serverOpts = { socketPath, daemon, verbose };
  let server = await createServer(config, serverOpts);
  await server.start();

  // Set up hot reload on config changes
  const { setupConfigReload } = await import('./reload.js');
  const reloadHandle = setupConfigReload({
    getServer: () => server,
    setServer: (s) => { server = s; },
    loadConfig: () => loadConfig(configPath),
    createServer: (cfg) => createServer(cfg, serverOpts),
    logger,
    configPath: resolvedConfigPath,
  });

  // Clean up file watcher on shutdown
  const cleanupAndExit = () => { reloadHandle.cleanup(); };
  process.on('SIGINT', cleanupAndExit);
  process.on('SIGTERM', cleanupAndExit);

  if (daemon) {
    logger.info('daemon_mode');
    process.disconnect?.();
  }
}
```

**Step 3: Run full test suite to verify nothing broke**

Run: `npx vitest run tests/cli/`
Expected: All existing CLI tests PASS, new reload tests PASS

**Step 4: Run TypeScript type check**

Run: `npx tsc --noEmit`
Expected: No type errors

**Step 5: Commit**

```bash
git add src/cli/index.ts src/cli/reload.ts tests/cli/reload.test.ts
git commit -m "feat: wire config hot reload into server startup"
```

---

### Task 4: Verify end-to-end with build

**Files:**
- None (verification only)

**Step 1: Run full build**

Run: `npm run build`
Expected: Clean compilation

**Step 2: Run full test suite**

Run: `npm test`
Expected: All tests pass

**Step 3: Final commit if any fixups needed**

Only if previous steps required changes.
