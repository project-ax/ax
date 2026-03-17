---
name: ax-provider-development
description: Use as a step-by-step guide when adding a new provider implementation or an entirely new provider category to AX
---

## Overview

This is a walkthrough for adding providers to AX. Every provider follows the same contract pattern: a TypeScript interface, a `create(config)` export, a static allowlist entry, and co-located tests. Follow these steps in order.

## Adding an Implementation to an Existing Category

Example: adding a `redis` implementation to the `memory` provider category.

### Step 1: Implement the provider

Create `src/providers/memory/redis.ts`:

```typescript
import type { Config } from '../../types.js';
import type { MemoryProvider, MemoryEntry } from './types.js';
import { safePath } from '../../utils/safe-path.js';  // if doing file ops

export function create(config: Config): MemoryProvider {
  // Initialize provider state
  return {
    async write(entry) { /* ... */ },
    async query(q) { /* ... */ },
    async read(id) { /* ... */ },
    async delete(id) { /* ... */ },
    async list(scope, limit) { /* ... */ },
  };
}
```

**Rules:**
- Export `create(config: Config)` — this is the contract
- Return an object satisfying the category's interface from `types.ts`
- Use `safePath()` for ANY file path constructed from input
- Never access credentials directly — they come through config or host injection

### Step 2: Add to the static allowlist

Edit `src/host/provider-map.ts`:

```typescript
memory: {
  file: '../providers/memory/file.js',
  sqlite: '../providers/memory/sqlite.js',
  memu: '../providers/memory/memu.js',
  redis: '../providers/memory/redis.js',    // ← Add this
},
```

**SC-SEC-002**: This is mandatory. Without it, the provider cannot be loaded.

### Step 3: Write tests

Create `tests/providers/memory/redis.test.ts`:

```typescript
import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { create } from '../../../src/providers/memory/redis.js';

describe('MemoryProvider/redis', () => {
  test('create returns valid provider', () => {
    const provider = create(mockConfig);
    expect(provider.write).toBeInstanceOf(Function);
    expect(provider.query).toBeInstanceOf(Function);
    // ... test all interface methods
  });

  test('write and query round-trip', async () => {
    const provider = create(mockConfig);
    await provider.write({ scope: 'test', content: 'hello' });
    const results = await provider.query({ scope: 'test', query: 'hello' });
    expect(results).toHaveLength(1);
  });
});
```

### Step 4: Update config schema (if new config fields needed)

Edit `src/types.ts` to add any new config fields the provider needs.

## Adding an Entirely New Provider Category

Example: adding a `notifications` provider category.

### Step 1: Define the interface

Create `src/providers/notifications/types.ts`:

```typescript
export interface NotificationProvider {
  send(opts: { channel: string; message: string }): Promise<void>;
  list(channel: string): Promise<Notification[]>;
}

export interface Notification {
  id: string;
  channel: string;
  message: string;
  timestamp: number;
}
```

### Step 2: Create at least one implementation

Create `src/providers/notifications/console.ts`:

```typescript
import type { Config } from '../../types.js';
import type { NotificationProvider } from './types.js';

export function create(config: Config): NotificationProvider {
  return {
    async send(opts) { console.log(`[${opts.channel}] ${opts.message}`); },
    async list() { return []; },
  };
}
```

### Step 3: Add to provider-map.ts

```typescript
notifications: {
  console: '../providers/notifications/console.js',
},
```

### Step 4: Update Config and ProviderRegistry types

Edit `src/types.ts`:

```typescript
// In Config.providers:
notifications: string;

// In ProviderRegistry:
notifications: NotificationProvider;
```

### Step 5: Update registry loading

Edit `src/host/registry.ts` in `loadProviders()`:

```typescript
notifications: await loadProvider('notifications', config.providers.notifications, config),
```

### Step 6: Wire into IPC (if agent needs access)

1. Add Zod schema in `src/ipc-schemas.ts` with `.strict()`
2. Add handler in `src/host/ipc-server.ts`
3. Add tool in `src/agent/ipc-tools.ts` (TypeBox schema)
4. Add tool in `src/agent/mcp-server.ts` (Zod v4 schema)
5. Update tool count in `tests/sandbox-isolation.test.ts`

### Step 7: Add to onboarding

1. Add to `PROFILE_DEFAULTS` in `src/onboarding/prompts.ts`
2. Add to `PROVIDER_CHOICES` in prompts.ts
3. Update wizard generation in `wizard.ts`

### Step 8: Write tests

Create `tests/providers/notifications/console.test.ts`.

## Checklist

Use this checklist every time you add a provider:

- [ ] Implementation file exports `create(config: Config)`
- [ ] Uses `safePath()` for all file path construction from input
- [ ] Entry added to `PROVIDER_MAP` in `provider-map.ts`
- [ ] Test file created in mirror directory under `tests/`
- [ ] (If new category) Interface in `types.ts`, Config + ProviderRegistry updated
- [ ] (If new category) Registry loading added
- [ ] (If agent-accessible) IPC schema, handler, tools in BOTH ipc-tools.ts AND mcp-server.ts
- [ ] (If agent-accessible) Tool count assertion updated in `sandbox-isolation.test.ts`
- [ ] (If user-selectable) Added to onboarding prompts and profile defaults

## Current Provider Categories

When developing a new provider, be aware of all existing categories in the provider map:

| Category | Implementations | Notes |
|-----------|----------------|-------|
| llm | anthropic, openai, openrouter, groq, deepinfra, router, mock | Multi-model router available |
| image | openai, openrouter, groq, gemini, router, mock | |
| memory | cortex | Embedding-based with SummaryStore |
| scanner | patterns, guardian | Input/output security scanning |
| channel | slack | Session addressing |
| web | none, fetch, tavily | Proxied HTTP with taint tagging |
| browser | none, container | Sandboxed Playwright |
| credentials | plaintext, keychain | OS keychain for secure storage |
| skills | database | Git-backed proposals |
| audit | database | JSONL/DB audit logs |
| sandbox | subprocess, docker, apple, k8s | Agent isolation (see note below) |
| scheduler | none, plainjob | Cron/heartbeat |
| screener | static, none | Skill content screening |
| database | sqlite, postgresql | Shared connection factory |
| storage | database | Message queue, sessions, docs |
| eventbus | inprocess, nats | Pub/sub for completion events |
| workspace | none, local, gcs | Persistent file workspaces (recent addition) |

**Sandbox providers**: The sandbox category has been simplified. Old Linux-specific providers (seatbelt, nsjail, bwrap) have been removed. The current set is: `subprocess` (no isolation, dev use), `docker` (container isolation), `apple` (Apple Container on macOS), and `k8s` (Kubernetes pods with NATS IPC). In k8s mode, IPC runs over NATS instead of Unix sockets.

**Workspace provider** (`src/providers/workspace/`): A recent addition that manages persistent file workspaces for agent sessions. Three scopes (agent, user, session) with mount/commit/cleanup lifecycle. Backends: `none` (no-op), `local` (filesystem), `gcs` (Google Cloud Storage). Loaded in `registry.ts` as part of the standard provider chain.

## Gotchas

- **Static allowlist is mandatory (SC-SEC-002)**: Forgetting the `provider-map.ts` entry causes a runtime throw, not a compile error. Always add it.
- **`create()` validated at runtime**: `registry.ts` checks that the module exports a `create` function. Missing it silently fails until startup.
- **Co-located types**: Each category owns its interface in `types.ts`. Don't put provider interfaces in the shared `src/types.ts`.
- **Channels are arrays**: `config.providers.channels` is `string[]`, loaded as `ChannelProvider[]`. Other categories are single strings.
- **Dual tool registration**: IPC tools must exist in BOTH `ipc-tools.ts` (TypeBox) AND `mcp-server.ts` (Zod). Missing one breaks that runner variant.
- **TypeBox for tools, Zod for IPC**: Don't mix. Tool parameters use `Type.Object(...)` from TypeBox. IPC schemas use `z.strictObject(...)` from Zod.
- **`safePath()` is security-critical**: Any file-based provider that skips `safePath()` is a path traversal vulnerability. This is enforced by code review.
- **Test isolation**: Providers using SQLite or files need isolated temp directories per test. See `ax-testing` skill for patterns.
- **Workspace is part of the loading chain**: The workspace provider is loaded in `registry.ts` alongside all other providers. If adding a new category, follow the same pattern (loaded after database, before the return statement).
