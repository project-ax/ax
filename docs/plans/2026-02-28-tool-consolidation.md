# Tool Consolidation: Merge Category Tools into Single Tools with Type Discriminator

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Consolidate 28 separate IPC tools into ~10 consolidated tools, each using a `type` discriminator param to select the operation.

**Architecture:** Each tool category (memory, scheduler, skills, workspace, governance, web, identity) becomes a single tool with a `type` field that discriminates the operation. The IPC layer continues to use flat action names internally — the consolidation happens at the agent-facing tool layer only. IPC schemas and host-side handlers remain unchanged; a thin adapter in `tool-catalog.ts` maps `{tool: "memory", type: "write", ...}` to the existing `{action: "memory_write", ...}` IPC call.

**Tech Stack:** TypeBox (tool schemas), Zod (MCP schemas), vitest (tests)

---

## Consolidation Map

| New Tool Name | Type Values | Old Tool Names |
|---|---|---|
| `memory` | `write`, `query`, `read`, `delete`, `list` | `memory_write`, `memory_query`, `memory_read`, `memory_delete`, `memory_list` |
| `web` | `fetch`, `search` | `web_fetch`, `web_search` |
| `identity` | `write`, `user_write` | `identity_write`, `user_write` |
| `scheduler` | `add_cron`, `run_at`, `remove`, `list` | `scheduler_add_cron`, `scheduler_run_at`, `scheduler_remove_cron`, `scheduler_list_jobs` |
| `skill` | `list`, `read`, `propose`, `import`, `search` | `skill_list`, `skill_read`, `skill_propose`, `skill_import`, `skill_search` |
| `workspace` | `write`, `read`, `list`, `write_file` | `workspace_write`, `workspace_read`, `workspace_list`, `workspace_write_file` |
| `governance` | `propose`, `list_proposals`, `list_agents` | `identity_propose`, `proposal_list`, `agent_registry_list` |
| `audit` | _(singleton, no type needed)_ | `audit_query` |
| `delegate` | _(singleton, no type needed)_ | `agent_delegate` |
| `image` | _(singleton, no type needed)_ | `image_generate` |

**Singletons** (`audit`, `delegate`, `image`) stay as-is since there's only one operation each. They get renamed for consistency: `audit_query` -> `audit`, `agent_delegate` -> `delegate`, `image_generate` -> `image`.

## Design Decisions

### 1. IPC layer unchanged
The host-side IPC schemas (`ipc-schemas.ts`) and handlers (`src/host/ipc-handlers/*.ts`) keep their flat `memory_write`, `memory_query` etc. action names. This avoids a risky refactor across the trust boundary. The mapping happens in the agent-side tool execution layer.

### 2. TypeBox discriminated unions for tool schemas
Each consolidated tool uses `Type.Union()` with `Type.Literal()` discriminators:

```typescript
const MemoryTool = {
  name: 'memory',
  label: 'Memory',
  description: 'Store, search, read, delete, and list memory entries.',
  parameters: Type.Union([
    Type.Object({
      type: Type.Literal('write'),
      scope: Type.String(),
      content: Type.String(),
      tags: Type.Optional(Type.Array(Type.String())),
    }),
    Type.Object({
      type: Type.Literal('query'),
      scope: Type.String(),
      query: Type.Optional(Type.String()),
      limit: Type.Optional(Type.Number()),
      tags: Type.Optional(Type.Array(Type.String())),
    }),
    // ... etc
  ]),
  category: 'memory',
};
```

### 3. IPC action name mapping
The execute function maps `type` to the old IPC action name:

```typescript
async execute(_id: string, params: { type: string; [k: string]: unknown }) {
  const { type, ...rest } = params;
  const action = `${spec.category}_${type}`; // e.g. "memory" + "write" -> "memory_write"
  return ipcCall(action, rest);
}
```

For non-uniform mappings (e.g. `scheduler.remove` -> `scheduler_remove_cron`), use an explicit lookup table.

### 4. MCP server Zod schemas mirror TypeBox
The MCP server (`mcp-server.ts`) uses Zod discriminated unions matching the TypeBox schemas.

---

## Tasks

### Task 1: Update `tool-catalog.ts` — Consolidated Tool Definitions

**Files:**
- Modify: `src/agent/tool-catalog.ts`

**Step 1: Write the failing test**

In `tests/agent/tool-catalog.test.ts`, update the count and name expectations:

```typescript
// Replace the existing count test
test('exports exactly 10 tools', () => {
  expect(TOOL_CATALOG.length).toBe(10);
});

// Replace the existing name list test
test('contains all expected tool names', () => {
  const expected = [
    'memory', 'web', 'audit', 'identity', 'scheduler',
    'skill', 'delegate', 'image', 'workspace', 'governance',
  ];
  expect(TOOL_NAMES).toEqual(expected);
});

// New: verify each multi-op tool has a `type` discriminator
test('multi-op tools have type discriminator in every union member', () => {
  const multiOp = TOOL_CATALOG.filter(t =>
    ['memory', 'web', 'identity', 'scheduler', 'skill', 'workspace', 'governance'].includes(t.name)
  );
  for (const spec of multiOp) {
    const schema = spec.parameters as any;
    // TypeBox Union stores members in anyOf
    expect(schema.anyOf, `${spec.name} should be a Union`).toBeDefined();
    for (const member of schema.anyOf) {
      expect(member.properties.type, `${spec.name} union member missing 'type' field`).toBeDefined();
    }
  }
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/agent/tool-catalog.test.ts`
Expected: FAIL — count is 28, names are old format

**Step 3: Rewrite `TOOL_CATALOG` with consolidated tools**

Replace the entire `TOOL_CATALOG` array in `src/agent/tool-catalog.ts`. Key changes:

1. Replace `ToolCategory` type — now matches tool names exactly
2. Add `ACTION_MAP` for type-to-IPC-action mapping (handles irregular names)
3. Replace 28 `ToolSpec` entries with 10 consolidated entries using `Type.Union()`
4. Keep `ToolSpec` interface, add optional `actionMap` field
5. Keep `filterTools()`, `normalizeOrigin()`, `normalizeIdentityFile()` unchanged
6. Keep `getToolParamKeys()` — update to handle union schemas
7. Update `ToolFilterContext` — filter by tool name instead of category

The `actionMap` on each `ToolSpec` maps the `type` value to the flat IPC action name:

```typescript
{
  name: 'memory',
  // ...
  actionMap: {
    write: 'memory_write',
    query: 'memory_query',
    read: 'memory_read',
    delete: 'memory_delete',
    list: 'memory_list',
  },
}
```

For singletons (`audit`, `delegate`, `image`), `actionMap` is omitted and the tool name itself maps to the IPC action via a `singletonAction` field:

```typescript
{
  name: 'audit',
  singletonAction: 'audit_query',
  // ...
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/agent/tool-catalog.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/agent/tool-catalog.ts tests/agent/tool-catalog.test.ts
git commit -m "refactor: consolidate tool catalog into 10 tools with type discriminators"
```

---

### Task 2: Update `ipc-tools.ts` — Execute with Type Dispatch

**Files:**
- Modify: `src/agent/ipc-tools.ts`

**Step 1: Write the failing test**

Create `tests/agent/ipc-tools.test.ts`:

```typescript
import { describe, test, expect, vi } from 'vitest';
import { createIPCTools } from '../../src/agent/ipc-tools.js';
import type { IPCClient } from '../../src/agent/ipc-client.js';

function mockClient() {
  return { call: vi.fn().mockResolvedValue({ ok: true }), connect: vi.fn(), disconnect: vi.fn() } as unknown as IPCClient;
}

describe('ipc-tools dispatch', () => {
  test('memory tool with type=write calls IPC action memory_write', async () => {
    const client = mockClient();
    const tools = createIPCTools(client);
    const memoryTool = tools.find(t => t.name === 'memory');
    expect(memoryTool).toBeDefined();
    await memoryTool!.execute('id', { type: 'write', scope: 'test', content: 'hello' });
    expect(client.call).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'memory_write', scope: 'test', content: 'hello' }),
      undefined,
    );
  });

  test('audit singleton tool calls IPC action audit_query', async () => {
    const client = mockClient();
    const tools = createIPCTools(client);
    const auditTool = tools.find(t => t.name === 'audit');
    expect(auditTool).toBeDefined();
    await auditTool!.execute('id', { limit: 10 });
    expect(client.call).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'audit_query', limit: 10 }),
      undefined,
    );
  });

  test('user_write type injects userId', async () => {
    const client = mockClient();
    const tools = createIPCTools(client, { userId: 'u123' });
    const identityTool = tools.find(t => t.name === 'identity');
    expect(identityTool).toBeDefined();
    await identityTool!.execute('id', { type: 'user_write', content: 'x', reason: 'y', origin: 'user_request' });
    expect(client.call).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'user_write', userId: 'u123' }),
      undefined,
    );
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/agent/ipc-tools.test.ts`
Expected: FAIL — no `memory` tool, still has `memory_write`

**Step 3: Update `createIPCTools` to dispatch via `actionMap`/`singletonAction`**

In `src/agent/ipc-tools.ts`, update the `.map()` to:
1. For multi-op tools: extract `type` from params, look up IPC action in `spec.actionMap`
2. For singletons: use `spec.singletonAction` as the IPC action
3. Handle `injectUserId` for specific types (e.g. `identity` tool with `type: 'user_write'`)

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/agent/ipc-tools.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/agent/ipc-tools.ts tests/agent/ipc-tools.test.ts
git commit -m "refactor: update ipc-tools to dispatch consolidated tools via type field"
```

---

### Task 3: Update `mcp-server.ts` — Zod Discriminated Unions

**Files:**
- Modify: `src/agent/mcp-server.ts`

**Step 1: Write the failing test**

The existing sync test in `tests/agent/tool-catalog-sync.test.ts` already verifies MCP tool names match the catalog. It should fail after Task 1 changes.

Run: `npx vitest run tests/agent/tool-catalog-sync.test.ts`
Expected: FAIL — MCP still has 28 tools, catalog has 10

**Step 2: Rewrite MCP tool definitions using Zod discriminated unions**

Replace the 28 individual `tool()` calls with 10 consolidated tools. Each multi-op tool uses `z.discriminatedUnion('type', [...])`:

```typescript
tool('memory', 'Store, search, read, delete, and list memory entries.', {
  type: z.enum(['write', 'query', 'read', 'delete', 'list']),
  // Common optional fields
  scope: z.string().optional(),
  id: z.string().optional(),
  content: z.string().optional(),
  query: z.string().optional(),
  limit: z.number().optional(),
  tags: z.array(z.string()).optional(),
}, (args) => {
  const { type, ...rest } = args;
  const action = `memory_${type}`;
  return ipcCall(action, rest);
}),
```

Note: The MCP `tool()` helper from Agent SDK doesn't support Zod discriminated unions natively, so we use a flat schema with `type` as an enum and optional fields. The TypeBox catalog (used by pi-session) uses proper unions.

**Step 3: Update the sync test assertions**

In `tests/agent/tool-catalog-sync.test.ts`, update:
- Tool name match test to expect 10 names
- Parameter key match test to handle union schemas (check `type` field is present)

**Step 4: Run sync tests**

Run: `npx vitest run tests/agent/tool-catalog-sync.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/agent/mcp-server.ts tests/agent/tool-catalog-sync.test.ts
git commit -m "refactor: update MCP server to consolidated tool definitions"
```

---

### Task 4: Update `pi-session.ts` — Tool Definition Generation

**Files:**
- Modify: `src/agent/runners/pi-session.ts`

**Step 1: Verify the test fails**

The pi-session runner uses `createIPCToolDefinitions()` which derives from `TOOL_CATALOG`. After Task 1, this function needs to handle the new schema format.

Run: `npx vitest run tests/agent/`
Expected: FAIL in pi-session related tests if any exist, or type errors in build

**Step 2: Update `createIPCToolDefinitions` in pi-session.ts**

The function at line 227 maps catalog specs to `ToolDefinition[]`. Update the `execute` function to:
1. Extract `type` from params for multi-op tools
2. Look up IPC action from `spec.actionMap[type]` or use `spec.singletonAction`
3. Handle normalization (origin, identity file) based on the resolved action name

**Step 3: Build and run tests**

Run: `npm run build && npx vitest run tests/agent/`
Expected: PASS

**Step 4: Commit**

```bash
git add src/agent/runners/pi-session.ts
git commit -m "refactor: update pi-session tool definitions for consolidated tools"
```

---

### Task 5: Update Prompt Modules — New Tool Names

**Files:**
- Modify: `src/agent/prompt/modules/memory-recall.ts` — `memory_query` -> `memory` with `type: "query"`, etc.
- Modify: `src/agent/prompt/modules/skills.ts` — `skill_read` -> `skill` with `type: "read"`, etc.
- Modify: `src/agent/prompt/modules/heartbeat.ts` — `scheduler_add_cron` -> `scheduler` with `type: "add_cron"`, etc.
- Modify: `src/agent/prompt/modules/delegation.ts` — `agent_delegate` -> `delegate`
- Modify: `src/agent/prompt/modules/runtime.ts` — `workspace_write` -> `workspace`, `identity_propose` -> `governance`, etc.
- Modify: `src/agent/prompt/modules/identity.ts` — `identity_write` -> `identity` with `type: "write"`, etc.

**Step 1: Update the sync test expectations**

In `tests/agent/tool-catalog-sync.test.ts`, update the prompt sync tests to look for new tool names:

```typescript
test('every scheduler type in catalog is documented in HeartbeatModule', () => {
  // Now looks for "scheduler" tool name + type values
  const mod = new HeartbeatModule();
  const rendered = mod.render(ctx).join('\n');
  expect(rendered).toContain('scheduler');
  for (const type of ['add_cron', 'run_at', 'remove', 'list']) {
    expect(rendered).toContain(type);
  }
});
```

**Step 2: Run to verify failure**

Run: `npx vitest run tests/agent/tool-catalog-sync.test.ts`
Expected: FAIL — prompt modules still reference old names

**Step 3: Update each prompt module**

For each module, replace references like:
- `memory_query(...)` -> `memory({ type: "query", ... })`
- `scheduler_add_cron(...)` -> `scheduler({ type: "add_cron", ... })`

Keep the human-readable documentation style. Example for heartbeat module:

Before: `Use \`scheduler_add_cron\` to schedule recurring tasks.`
After: `Use \`scheduler({ type: "add_cron", ... })\` to schedule recurring tasks.`

**Step 4: Run tests**

Run: `npx vitest run tests/agent/tool-catalog-sync.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/agent/prompt/modules/*.ts tests/agent/tool-catalog-sync.test.ts
git commit -m "refactor: update prompt modules to reference consolidated tool names"
```

---

### Task 6: Update Remaining Tests

**Files:**
- Modify: `tests/agent/tool-catalog.test.ts` — comprehensive updates
- Modify: `tests/agent/tool-catalog-sync.test.ts` — already partially done in earlier tasks

**Step 1: Review and fix all test assertions**

Sweep through all test files for old tool name references:

```bash
grep -r "memory_write\|memory_query\|scheduler_add_cron\|skill_list\|workspace_write\|audit_query\|agent_delegate\|image_generate" tests/
```

Update each reference. The IPC schema tests (`tests/host/`) and handler tests should NOT change — they still use flat action names.

**Step 2: Run full test suite**

Run: `npx vitest run`
Expected: ALL PASS

**Step 3: Commit**

```bash
git add tests/
git commit -m "test: update all tests for consolidated tool names"
```

---

### Task 7: Build Verification and Final Cleanup

**Step 1: Full build**

Run: `npm run build`
Expected: No TypeScript errors

**Step 2: Full test suite**

Run: `npm test`
Expected: ALL PASS

**Step 3: Remove any dead code**

Check for unused exports, old tool name constants, etc. Clean up.

**Step 4: Final commit**

```bash
git add -A
git commit -m "chore: cleanup dead code from tool consolidation"
```

---

## What Does NOT Change

These files are intentionally left alone:

- **`src/ipc-schemas.ts`** — IPC action names stay flat (`memory_write`, etc.)
- **`src/host/ipc-server.ts`** — Handler dispatch stays flat
- **`src/host/ipc-handlers/*.ts`** — All handler implementations unchanged
- **`src/agent/local-tools.ts`** — Local tools (bash, read_file, etc.) are separate from IPC tools
- **Host-side tests** — `tests/host/` tests validate IPC actions, not agent-facing tool names

## Risk Mitigation

1. **IPC layer untouched** — biggest risk avoided. Host-side dispatch is unchanged.
2. **Backward compat period** — if needed, `tool-catalog.ts` could export both old and new formats during migration. Not planned unless issues arise.
3. **Sync tests catch drift** — the existing `tool-catalog-sync.test.ts` pattern ensures catalog, MCP server, prompt modules, and IPC schemas stay aligned.
