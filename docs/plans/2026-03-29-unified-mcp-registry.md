# Unified MCP Registry Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Unify the three MCP tool sources (Activepieces provider, database MCP provider, plugin McpConnectionManager) into a single per-agent registry that handles tool discovery and routing for all sources.

**Architecture:** McpConnectionManager becomes the single registry for all MCP servers. Each server entry gets a `source` tag and optional headers/credentials config. On startup, servers from the DB (`mcp_servers` table) and installed plugins are loaded into the manager. Tool discovery and routing go through the manager exclusively. The Activepieces provider remains as an optional legacy source that registers its tools in the manager. The `McpProvider` interface (`providers.mcp`) is deprecated in favor of the manager.

**Tech Stack:** TypeScript, @modelcontextprotocol/sdk, Kysely, vitest

---

## Current State (Three Sources)

| Source | Protocol | Where registered | Tool routing |
|--------|----------|-----------------|-------------|
| Activepieces | Custom REST (`/api/v1/mcp/tools/call`) | `providers.mcp` singleton | `providers.mcp.callTool()` |
| DB MCP servers | JSON-RPC (raw fetch) | `providers.mcp` (database provider) | `providers.mcp.callTool()` via `server__tool` prefix |
| Plugin MCP servers | Standard MCP (SDK) | `McpConnectionManager` | `callToolOnServer()` via tool→URL map |

## Target State (Single Registry)

```
McpConnectionManager (single registry, per-agent)
  ├── source: 'database'      → headers from DB, callToolOnServer()
  ├── source: 'plugin:sales'  → callToolOnServer()
  ├── source: 'plugin:legal'  → callToolOnServer()
  └── source: 'activepieces'  → providers.mcp.callTool() (legacy)
```

All tool discovery and routing goes through the manager. `providers.mcp` becomes optional — only loaded for Activepieces backward compat.

---

## Task 1: Extend McpConnectionManager with Source Tags and Headers

Add source tagging and optional headers/credentials to managed servers.

**Files:**
- Modify: `src/plugins/mcp-manager.ts`
- Modify: `src/plugins/types.ts`
- Test: `tests/plugins/mcp-manager.test.ts`

**Step 1: Write the failing tests**

```typescript
// Add to tests/plugins/mcp-manager.test.ts:

it('tracks source on registered servers', () => {
  manager.addServer('pi', { name: 'slack', type: 'http', url: 'https://mcp.slack.com/mcp' }, { source: 'plugin:sales' });
  manager.addServer('pi', { name: 'hubspot', type: 'http', url: 'https://hub.example.com' }, { source: 'database' });
  const servers = manager.listServersWithMeta('pi');
  expect(servers.find(s => s.name === 'slack')?.source).toBe('plugin:sales');
  expect(servers.find(s => s.name === 'hubspot')?.source).toBe('database');
});

it('stores headers for database-sourced servers', () => {
  manager.addServer('pi', {
    name: 'linear',
    type: 'http',
    url: 'https://linear.example.com',
  }, { source: 'database', headers: { Authorization: 'Bearer {LINEAR_API_KEY}' } });
  const meta = manager.getServerMeta('pi', 'linear');
  expect(meta?.headers).toEqual({ Authorization: 'Bearer {LINEAR_API_KEY}' });
});

it('removeServersBySource removes all servers from a source', () => {
  manager.addServer('pi', { name: 'a', type: 'http', url: 'https://a.com' }, { source: 'database' });
  manager.addServer('pi', { name: 'b', type: 'http', url: 'https://b.com' }, { source: 'database' });
  manager.addServer('pi', { name: 'c', type: 'http', url: 'https://c.com' }, { source: 'plugin:sales' });
  manager.removeServersBySource('pi', 'database');
  expect(manager.listServers('pi')).toHaveLength(1);
  expect(manager.listServers('pi')[0].name).toBe('c');
});
```

**Step 2: Run tests to verify they fail**

Run: `npm test -- --run tests/plugins/mcp-manager.test.ts`
Expected: FAIL

**Step 3: Implement**

Update `McpConnectionManager`:

- Change `addServer` signature: `addServer(agentId, server, opts?: { source?: string; pluginName?: string; headers?: Record<string, string> })`
- Keep backward compat: old `addServer(agentId, server, pluginName)` still works
- Add `ManagedServer.source` and `ManagedServer.headers` fields
- Add `listServersWithMeta(agentId)` returning source + headers
- Add `getServerMeta(agentId, name)` returning `{ source, headers }` or undefined
- Add `removeServersBySource(agentId, source)` for bulk removal by source tag
- Keep existing `removeServersByPlugin` as alias for `removeServersBySource(agentId, 'plugin:' + pluginName)`

**Step 4: Run tests to verify they pass**

Run: `npm test -- --run tests/plugins/mcp-manager.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git commit -m "feat: add source tags and headers to McpConnectionManager"
```

---

## Task 2: Unified Tool Call Dispatch

Add a unified `callTool` method to McpConnectionManager that routes based on source type.

**Files:**
- Modify: `src/plugins/mcp-manager.ts`
- Modify: `src/plugins/mcp-client.ts` — add header support to `callToolOnServer`
- Test: `tests/plugins/mcp-manager.test.ts`

**Step 1: Write the failing test**

```typescript
it('callTool routes to the correct server URL', async () => {
  manager.addServer('pi', { name: 'linear', type: 'http', url: 'https://linear.example.com' }, { source: 'database' });
  manager.registerTools('pi', 'https://linear.example.com', ['linear__getIssues']);
  // We can't test a real call, but we can verify resolution
  const url = manager.getToolServerUrl('pi', 'linear__getIssues');
  expect(url).toBe('https://linear.example.com');
});
```

**Step 2: Update `mcp-client.ts` to support custom headers**

Add optional `headers` param to `callToolOnServer` and `listToolsFromServer`:

```typescript
export async function listToolsFromServer(url: string, opts?: { headers?: Record<string, string> }): Promise<McpToolSchema[]>
export async function callToolOnServer(url: string, toolName: string, args: Record<string, unknown>, opts?: { headers?: Record<string, string> }): Promise<...>
```

The headers get passed through `StreamableHTTPClientTransport`'s `requestInit` option:

```typescript
const transport = new StreamableHTTPClientTransport(new URL(url), {
  requestInit: opts?.headers ? { headers: opts.headers } : undefined,
});
```

**Step 3: Run tests**

Run: `npm test -- --run tests/plugins/mcp-manager.test.ts`
Expected: PASS

**Step 4: Commit**

```bash
git commit -m "feat: add header support to MCP client for database-sourced servers"
```

---

## Task 3: Load Database MCP Servers into Manager on Startup

On server startup, read `mcp_servers` table and register each server in the McpConnectionManager.

**Files:**
- Modify: `src/plugins/startup.ts` — add `loadDatabaseMcpServers()`
- Modify: `src/host/server-init.ts` — call on startup
- Test: `tests/plugins/startup.test.ts`

**Step 1: Write the failing test**

```typescript
describe('loadDatabaseMcpServers', () => {
  it('registers DB servers in the manager', async () => {
    // Mock a Kysely DB with mcp_servers rows
    // Call loadDatabaseMcpServers
    // Verify manager.listServers() includes them with source: 'database'
  });
});
```

**Step 2: Implement in `src/plugins/startup.ts`**

```typescript
import type { DatabaseProvider } from '../providers/database/types.js';

export async function loadDatabaseMcpServers(
  database: DatabaseProvider | undefined,
  mcpManager: McpConnectionManager,
): Promise<void> {
  if (!database) return;
  try {
    const rows = await database.db
      .selectFrom('mcp_servers')
      .selectAll()
      .where('enabled', '=', 1)
      .execute();

    for (const row of rows) {
      mcpManager.addServer(row.agent_id, {
        name: row.name,
        type: 'http',
        url: row.url,
      }, {
        source: 'database',
        headers: row.headers ? JSON.parse(row.headers) : undefined,
      });
    }
  } catch {
    // mcp_servers table may not exist yet — skip silently
  }
}
```

**Step 3: Wire into `server-init.ts`**

After creating the McpConnectionManager and calling `reloadPluginMcpServers`, also call `loadDatabaseMcpServers`.

**Step 4: Run tests**

Run: `npm test -- --run`
Expected: PASS

**Step 5: Commit**

```bash
git commit -m "feat: load database MCP servers into unified manager on startup"
```

---

## Task 4: Unified Tool Discovery

Replace the split discovery paths (global `providers.mcp.listTools()` + plugin `listToolsFromServer()`) with a single manager-based discovery.

**Files:**
- Modify: `src/plugins/mcp-manager.ts` — add `discoverAllTools(agentId)` method
- Modify: `src/host/server-completions.ts` — use manager for all tool discovery
- Modify: `src/host/inprocess.ts` — use manager for all tool discovery

**Step 1: Add `discoverAllTools` to manager**

```typescript
import { listToolsFromServer } from './mcp-client.js';
import type { McpToolSchema } from '../providers/mcp/types.js';

async discoverAllTools(agentId: string, opts?: { resolveHeaders?: (headers: Record<string, string>) => Promise<Record<string, string>> }): Promise<McpToolSchema[]> {
  const allTools: McpToolSchema[] = [];
  const agentServers = this.servers.get(agentId);
  if (!agentServers) return allTools;

  for (const [, server] of agentServers) {
    try {
      // Resolve credential placeholders in headers if needed
      const resolvedHeaders = server.headers && opts?.resolveHeaders
        ? await opts.resolveHeaders(server.headers)
        : server.headers;

      const tools = await listToolsFromServer(server.url, resolvedHeaders ? { headers: resolvedHeaders } : undefined);
      // Register tool→server mapping for later routing
      this.registerTools(agentId, server.url, tools.map(t => t.name));
      allTools.push(...tools);
    } catch {
      // One server failing doesn't affect others
    }
  }
  return allTools;
}
```

**Step 2: Update `server-completions.ts`**

Replace the current split logic (global MCP + plugin) with:

```typescript
// All MCP tool discovery through unified manager
if (deps.mcpManager) {
  const resolveHeaders = deps.providers.credentials
    ? (h: Record<string, string>) => resolveHeaderPlaceholders(h, deps.providers.credentials)
    : undefined;
  const mcpTools = await deps.mcpManager.discoverAllTools(agentName, { resolveHeaders });
  if (mcpTools.length > 0) {
    toolStubsPayload = await prepareToolStubs({ documents, agentName, tools: mcpTools });
  }
}
```

Remove the old `providers.mcp.listTools()` call and the separate plugin server query.

**Step 3: Update `inprocess.ts`**

Same pattern — use `deps.mcpManager.discoverAllTools()` instead of the split discovery.

**Step 4: Run tests**

Run: `npm test -- --run`
Expected: PASS

**Step 5: Commit**

```bash
git commit -m "feat: unified MCP tool discovery through McpConnectionManager"
```

---

## Task 5: Unified Tool Routing

Update the tool router to use the manager for ALL MCP tool routing, not just plugin tools.

**Files:**
- Modify: `src/host/tool-router.ts` — simplify to use manager exclusively
- Modify: `src/host/ipc-handlers/tool-batch.ts` — same
- Modify: `src/host/server-init.ts` — simplify toolBatchProvider setup
- Test: update existing tool router tests

**Step 1: Simplify tool router**

Current: checks `resolvePluginServer` for plugin tools → falls back to `providers.mcp.callTool()`.

After: checks `resolveServer(agentId, toolName)` for ALL tools → calls `callToolOnServer(url, toolName, args, { headers })`.

The manager's `getToolServerUrl` already handles this — it was populated by `discoverAllTools` for all sources. The router just needs to:
1. Resolve URL from manager
2. Get server metadata (headers) from manager
3. Resolve credential placeholders in headers
4. Call `callToolOnServer(url, toolName, args, { headers })`

Remove `PluginMcpCallTool` type and `pluginMcpCallTool` callback — everything goes through the same path.

**Step 2: Update server-init.ts**

Simplify `toolBatchProvider` — no longer needs separate `resolvePluginServer` vs `getProvider` split. Everything goes through the manager.

**Step 3: Run tests**

Run: `npm test -- --run`
Expected: PASS (update tests that mock the old split routing)

**Step 4: Commit**

```bash
git commit -m "feat: unified MCP tool routing through manager"
```

---

## Task 6: Admin API for Cowork Plugins

Add admin endpoints for listing, installing, and removing Cowork plugins per agent.

**Files:**
- Modify: `src/host/server-admin.ts` — add plugin endpoints
- Test: `tests/host/server-admin.test.ts` (if exists) or manual verification

**Step 1: Add endpoints to `handleAdminAPI`**

```typescript
// GET /admin/api/agents/:id/plugins — list installed plugins
// POST /admin/api/agents/:id/plugins — install plugin (body: { source })
// DELETE /admin/api/agents/:id/plugins/:name — uninstall plugin
```

These delegate to `listPlugins`, `installPlugin`, `uninstallPlugin` from `src/plugins/`.

The admin handler needs `McpConnectionManager` in its deps — add it to `AdminDeps`.

**Step 2: Sync DB MCP changes to manager**

When a server is added/removed via the admin API (`POST/DELETE /admin/api/agents/:id/mcp-servers`), also update the McpConnectionManager so changes take effect immediately (no restart).

Add after the DB write:
```typescript
// Sync to in-memory manager
if (deps.mcpManager) {
  deps.mcpManager.addServer(agentId, { name, type: 'http', url }, { source: 'database', headers });
}
```

**Step 3: Run tests**

Run: `npm test -- --run`
Expected: PASS

**Step 4: Commit**

```bash
git commit -m "feat: admin API endpoints for Cowork plugins and DB-MCP sync"
```

---

## Task 7: Deprecate `providers.mcp` Singleton

Mark the `providers.mcp` field as deprecated. Keep it working for Activepieces backward compat but route through the manager.

**Files:**
- Modify: `src/host/registry.ts` — load Activepieces tools into manager at startup
- Modify: `src/types.ts` — mark `mcp` as `@deprecated` in ProviderRegistry

**Step 1: At startup, if `providers.mcp` exists (Activepieces), discover its tools and register them**

```typescript
// In registry.ts or server-init.ts, after loadProviders:
if (providers.mcp && mcpManager) {
  const tools = await providers.mcp.listTools();
  for (const tool of tools) {
    // Register in manager with source: 'activepieces'
    // Activepieces tools still route through providers.mcp.callTool()
  }
}
```

For Activepieces tool calls, the manager resolves `source: 'activepieces'` and delegates to `providers.mcp.callTool()` instead of `callToolOnServer()`.

**Step 2: Add `@deprecated` JSDoc to `mcp` in ProviderRegistry**

```typescript
/** @deprecated Use McpConnectionManager for MCP tool discovery and routing. */
mcp?: McpProvider;
```

**Step 3: Run tests**

Run: `npm test -- --run`
Expected: PASS

**Step 4: Commit**

```bash
git commit -m "refactor: deprecate providers.mcp, route Activepieces through manager"
```

---

## Summary

| Task | What changes |
|------|-------------|
| 1. Source tags + headers | McpConnectionManager gets source, headers fields |
| 2. Unified call dispatch | mcp-client.ts supports custom headers |
| 3. DB servers in manager | Startup loads mcp_servers table into manager |
| 4. Unified discovery | Single `discoverAllTools()` replaces split paths |
| 5. Unified routing | Tool router uses manager exclusively, removes split logic |
| 6. Admin API | Plugin management + DB-MCP sync to manager |
| 7. Deprecate singleton | Activepieces registers in manager, `providers.mcp` marked deprecated |

After this, there's ONE place to ask "what MCP tools does agent X have?" and ONE routing path for calling them. Adding a new provider type later is just a new `source` tag.
