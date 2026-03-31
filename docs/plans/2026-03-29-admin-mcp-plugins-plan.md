# Admin UI: MCP Servers & Plugins — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Restructure the admin Agents page into a full-page-per-agent layout with vertical sub-nav, add a Plugins section per-agent, and add a top-level Connectors page for managing shared MCP servers.

**Architecture:** The Agents page transforms from a list+detail panel with horizontal tabs into a full-page layout: agent selector dropdown at top, vertical sub-nav on left (grouped: Agent, Tools, Data), content area on right. MCP servers become global resources managed via a new top-level "Connectors" page. Backend gets new global MCP endpoints (`/admin/api/mcp-servers`) alongside existing per-agent ones.

**Tech Stack:** React 19, Vite, Tailwind CSS 4, Lucide React icons, existing `useApi` hook, existing `apiFetch` wrapper.

**Design doc:** `docs/plans/2026-03-29-admin-mcp-plugins-design.md`

---

### Task 1: Backend — Add Global MCP Server CRUD Functions

**Files:**
- Modify: `src/providers/mcp/database.ts`

**Step 1: Add global CRUD functions**

Add these functions after the existing per-agent CRUD helpers (around line 364):

```typescript
// ---------------------------------------------------------------------------
// Global MCP Server CRUD (agent-independent)
// ---------------------------------------------------------------------------

export async function listAllMcpServers(db: Kysely<any>): Promise<McpServerRow[]> {
  return db
    .selectFrom('mcp_servers')
    .selectAll()
    .orderBy('name')
    .execute() as Promise<McpServerRow[]>;
}

export async function addGlobalMcpServer(
  db: Kysely<any>,
  name: string,
  url: string,
  headers?: Record<string, string>,
): Promise<McpServerRow> {
  const id = randomUUID();
  const now = new Date().toISOString();
  await db
    .insertInto('mcp_servers')
    .values({
      id,
      agent_id: '__global__',
      name,
      url,
      headers: headers ? JSON.stringify(headers) : null,
      enabled: 1,
      created_at: now,
      updated_at: now,
    })
    .execute();
  return { id, agent_id: '__global__', name, url, headers: headers ? JSON.stringify(headers) : null, enabled: 1, created_at: now, updated_at: now };
}

export async function removeGlobalMcpServer(db: Kysely<any>, name: string): Promise<boolean> {
  const result = await db
    .deleteFrom('mcp_servers')
    .where('agent_id', '=', '__global__')
    .where('name', '=', name)
    .executeTakeFirst();
  return (result?.numDeletedRows ?? 0n) > 0n;
}

export async function updateGlobalMcpServer(
  db: Kysely<any>,
  name: string,
  updates: { url?: string; headers?: Record<string, string>; enabled?: boolean },
): Promise<boolean> {
  const set: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (updates.url !== undefined) set.url = updates.url;
  if (updates.headers !== undefined) set.headers = JSON.stringify(updates.headers);
  if (updates.enabled !== undefined) set.enabled = updates.enabled ? 1 : 0;

  const result = await db
    .updateTable('mcp_servers')
    .set(set)
    .where('agent_id', '=', '__global__')
    .where('name', '=', name)
    .executeTakeFirst();
  return (result?.numUpdatedRows ?? 0n) > 0n;
}

export async function testGlobalMcpServer(
  db: Kysely<any>,
  name: string,
  credentials: CredentialProvider,
): Promise<{ ok: boolean; tools?: McpToolSchema[]; error?: string }> {
  const rows = await db
    .selectFrom('mcp_servers')
    .selectAll()
    .where('agent_id', '=', '__global__')
    .where('name', '=', name)
    .execute() as McpServerRow[];

  if (rows.length === 0) return { ok: false, error: `Server "${name}" not found` };
  const server = rows[0];

  try {
    const headers = await resolveHeaders(server.headers, credentials);
    const result = await jsonRpcCall(server.url, 'tools/list', {}, headers) as { tools?: McpToolSchema[] };
    return { ok: true, tools: result?.tools ?? [] };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}
```

**Step 2: Verify build**

Run: `npm run build`
Expected: Clean compilation

**Step 3: Commit**

```
feat(mcp): add global MCP server CRUD functions
```

---

### Task 2: Backend — Add Global MCP Admin API Endpoints

**Files:**
- Modify: `src/host/server-admin.ts`

**Step 1: Add global MCP endpoints**

Add these routes in `handleAdminAPI` before the existing `// ── MCP Server Management ──` section (around line 472):

```typescript
  // ── Global MCP Server Management ──

  // GET /admin/api/mcp-servers
  if (pathname === '/admin/api/mcp-servers' && method === 'GET') {
    if (!providers.database) { sendError(res, 500, 'Database not configured'); return; }
    const { listAllMcpServers } = await import('../providers/mcp/database.js');
    const servers = await listAllMcpServers(providers.database.db);
    sendJSON(res, servers);
    return;
  }

  // POST /admin/api/mcp-servers
  if (pathname === '/admin/api/mcp-servers' && method === 'POST') {
    if (!providers.database) { sendError(res, 500, 'Database not configured'); return; }
    try {
      const body = JSON.parse(await readBody(req));
      const { name, url, headers } = body;
      if (!name || !url) { sendError(res, 400, 'Missing required fields: name, url'); return; }
      const { addGlobalMcpServer } = await import('../providers/mcp/database.js');
      const server = await addGlobalMcpServer(providers.database.db, name, url, headers);
      sendJSON(res, server, 201);
    } catch (err) {
      sendError(res, 400, `Invalid request: ${(err as Error).message}`);
    }
    return;
  }

  // PUT /admin/api/mcp-servers/:name
  const globalMcpMatch = pathname.match(/^\/admin\/api\/mcp-servers\/([^/]+)$/);
  if (globalMcpMatch && method === 'PUT') {
    const name = decodeURIComponent(globalMcpMatch[1]);
    if (!providers.database) { sendError(res, 500, 'Database not configured'); return; }
    try {
      const body = JSON.parse(await readBody(req));
      const { updateGlobalMcpServer } = await import('../providers/mcp/database.js');
      const updated = await updateGlobalMcpServer(providers.database.db, name, body);
      if (!updated) { sendError(res, 404, 'MCP server not found'); return; }
      sendJSON(res, { ok: true });
    } catch (err) {
      sendError(res, 400, `Invalid request: ${(err as Error).message}`);
    }
    return;
  }

  // DELETE /admin/api/mcp-servers/:name
  if (globalMcpMatch && method === 'DELETE') {
    const name = decodeURIComponent(globalMcpMatch[1]);
    if (!providers.database) { sendError(res, 500, 'Database not configured'); return; }
    const { removeGlobalMcpServer } = await import('../providers/mcp/database.js');
    const removed = await removeGlobalMcpServer(providers.database.db, name);
    if (!removed) { sendError(res, 404, 'MCP server not found'); return; }
    sendJSON(res, { ok: true });
    return;
  }

  // POST /admin/api/mcp-servers/:name/test
  const globalMcpTestMatch = pathname.match(/^\/admin\/api\/mcp-servers\/([^/]+)\/test$/);
  if (globalMcpTestMatch && method === 'POST') {
    const name = decodeURIComponent(globalMcpTestMatch[1]);
    if (!providers.database) { sendError(res, 500, 'Database not configured'); return; }
    if (!providers.credentials) { sendError(res, 500, 'Credentials provider not configured'); return; }
    const { testGlobalMcpServer } = await import('../providers/mcp/database.js');
    const result = await testGlobalMcpServer(providers.database.db, name, providers.credentials);
    sendJSON(res, result);
    return;
  }
```

**Important:** These must be placed BEFORE the per-agent MCP routes since `/admin/api/mcp-servers` would otherwise match the agent pattern regex.

**Step 2: Verify build**

Run: `npm run build`
Expected: Clean compilation

**Step 3: Commit**

```
feat(admin): add global MCP server management API endpoints
```

---

### Task 3: Frontend — Add Types and API Methods

**Files:**
- Modify: `ui/admin/src/lib/types.ts`
- Modify: `ui/admin/src/lib/api.ts`

**Step 1: Add types to `types.ts`**

Add at the end of the file:

```typescript
/** MCP server record. */
export interface McpServer {
  id: string;
  agent_id: string;
  name: string;
  url: string;
  headers: string | null;
  enabled: number;
  created_at: string;
  updated_at: string;
}

/** Installed plugin record from admin API. */
export interface InstalledPlugin {
  name: string;
  version: string;
  description: string;
  source: string;
  skills: number;
  commands: number;
  mcpServers: string[];
  installedAt: string;
}

/** MCP server test result. */
export interface McpTestResult {
  ok: boolean;
  tools?: Array<{ name: string; description?: string }>;
  error?: string;
}
```

**Step 2: Add API methods to `api.ts`**

Add the import for new types, then add methods to the `api` object:

```typescript
// Add to imports:
import type { ..., McpServer, InstalledPlugin, McpTestResult } from './types';

// Add to api object:

  // ── Global MCP Servers ──

  /** List all global MCP servers. */
  mcpServers(): Promise<McpServer[]> {
    return apiFetch<McpServer[]>('/mcp-servers');
  },

  /** Add a global MCP server. */
  addMcpServer(data: { name: string; url: string; headers?: Record<string, string> }): Promise<McpServer> {
    return apiFetch<McpServer>('/mcp-servers', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  },

  /** Update a global MCP server. */
  updateMcpServer(name: string, data: { url?: string; headers?: Record<string, string>; enabled?: boolean }): Promise<{ ok: boolean }> {
    return apiFetch<{ ok: boolean }>(`/mcp-servers/${encodeURIComponent(name)}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    });
  },

  /** Remove a global MCP server. */
  removeMcpServer(name: string): Promise<{ ok: boolean }> {
    return apiFetch<{ ok: boolean }>(`/mcp-servers/${encodeURIComponent(name)}`, {
      method: 'DELETE',
    });
  },

  /** Test a global MCP server's connectivity. */
  testMcpServer(name: string): Promise<McpTestResult> {
    return apiFetch<McpTestResult>(`/mcp-servers/${encodeURIComponent(name)}/test`, {
      method: 'POST',
    });
  },

  // ── Agent Plugins ──

  /** List installed plugins for an agent. */
  agentPlugins(id: string): Promise<InstalledPlugin[]> {
    return apiFetch<InstalledPlugin[]>(`/agents/${encodeURIComponent(id)}/plugins`);
  },

  /** Install a plugin for an agent. */
  installPlugin(id: string, source: string): Promise<{ installed: boolean; pluginName?: string; error?: string }> {
    return apiFetch(`/agents/${encodeURIComponent(id)}/plugins`, {
      method: 'POST',
      body: JSON.stringify({ source }),
    });
  },

  /** Uninstall a plugin from an agent. */
  uninstallPlugin(id: string, name: string): Promise<{ ok: boolean }> {
    return apiFetch<{ ok: boolean }>(`/agents/${encodeURIComponent(id)}/plugins/${encodeURIComponent(name)}`, {
      method: 'DELETE',
    });
  },
```

**Step 3: Verify admin build**

Run: `cd ui/admin && npx tsc --noEmit`
Expected: No type errors

**Step 4: Commit**

```
feat(admin-ui): add MCP server and plugin types and API methods
```

---

### Task 4: Frontend — Create Connectors Page

**Files:**
- Create: `ui/admin/src/components/pages/connectors-page.tsx`
- Modify: `ui/admin/src/App.tsx`

**Step 1: Create ConnectorsPage component**

Create `ui/admin/src/components/pages/connectors-page.tsx` — this is the top-level page for global MCP server management.

The component should implement:
- Page header with title "Connectors" and "Add Server" button
- Inline add/edit form with name, URL, and key-value headers inputs
- Table of servers with status badges, test/edit/remove actions
- Empty state with Globe icon
- Test flow with inline spinner and result display
- Confirm-before-delete pattern (click → "Confirm?" for 3s)
- Credential placeholder highlighting (`{TOKEN}` → amber text)

Use existing design system: `.card`, `.btn-primary`, `.btn-secondary`, `.btn-danger`, `.badge-*`, `.input`, `.skeleton` classes. Lucide icons at `size={14}` with `strokeWidth={1.8}`. Follow the `animate-fade-in-up` pattern.

**Step 2: Add Connectors to sidebar nav in App.tsx**

```typescript
// Add Globe import
import { Shield, Activity, Users, FileText, Settings, LogOut, Hexagon, ChevronRight, Globe } from 'lucide-react';

// Update Page type
type Page = 'overview' | 'agents' | 'connectors' | 'security' | 'logs' | 'settings';

// Update NAV_ITEMS — insert after agents
{ id: 'connectors', label: 'Connectors', icon: Globe },

// Add to page rendering
{activePage === 'connectors' && <ConnectorsPage />}

// Add import
import ConnectorsPage from './components/pages/connectors-page';
```

**Step 3: Verify build**

Run: `cd ui/admin && npm run build`
Expected: Clean build

**Step 4: Commit**

```
feat(admin-ui): add Connectors page for global MCP server management
```

---

### Task 5: Frontend — Restructure Agents Page Layout

**Files:**
- Modify: `ui/admin/src/components/pages/agents-page.tsx`

**Step 1: Restructure the agents page**

Transform the current list+detail layout into:
1. **Agent selector dropdown** at the top — full-width bar with status dot, agent name, type badge, kill button. Dropdown to switch agents.
2. **Vertical sub-nav** (180px left) with grouped sections:
   - AGENT: Overview, Identity
   - TOOLS: Skills, Plugins
   - DATA: Workspace, Memory
3. **Content area** (remaining width) renders the active section.

Keep the existing tab content components (`InfoTab`, `IdentityTab`, `SkillsTab`, `WorkspaceTab`, `MemoryTab`) — they just render in the new layout instead of within a card's tab bar.

When no agents exist, show the current empty state. When agents exist but none selected, auto-select the first one.

Key styling (from design doc):
- Agent selector: `bg-card/80 border-b border-border/30`, status dot, `font-semibold` name, `badge-zinc` type
- Sub-nav: `w-[180px] border-r border-border/30`, sticky positioning
- Group headers: `text-[10px] uppercase tracking-widest text-muted-foreground px-3 pt-4 pb-1`
- Nav items: `text-[13px] font-medium px-3 py-1.5 rounded-md`
- Active item: `text-amber bg-amber/5 border-l-2 border-amber`
- Hover: `text-foreground bg-foreground/[0.03]`
- Icons: Activity, User, Sparkles, Puzzle, FolderOpen, Brain at `size={14}`

**Step 2: Verify build**

Run: `cd ui/admin && npm run build`
Expected: Clean build

**Step 3: Commit**

```
refactor(admin-ui): restructure Agents page with agent selector and vertical sub-nav
```

---

### Task 6: Frontend — Add Plugins Section to Agent Page

**Files:**
- Modify: `ui/admin/src/components/pages/agents-page.tsx`

**Step 1: Add PluginsSection component**

Add within agents-page.tsx (alongside the existing tab content components):

The component should implement:
- Header with "Plugins" title and "Install Plugin" button
- Inline install form (text input + Install/Cancel buttons)
- Plugin cards in `grid-cols-1 lg:grid-cols-2` layout
- Each card: name, version badge, description, stat badges (skills/commands/MCP), source, installed date, uninstall button
- Empty state with Package icon
- Loading/error states using existing `TabSkeleton`/`TabError` helpers
- Install progress with spinner
- Uninstall confirm pattern

**Step 2: Wire PluginsSection into sub-nav**

Add `'plugins'` to the section type and render `<PluginsSection agentId={selectedAgent.id} />` when active.

**Step 3: Verify build**

Run: `cd ui/admin && npm run build`
Expected: Clean build

**Step 4: Commit**

```
feat(admin-ui): add Plugins section to agent detail view
```

---

### Task 7: Build Verification and Polish

**Step 1: Full build**

Run: `npm run build && cd ui/admin && npm run build`
Expected: Both backend and admin UI compile cleanly

**Step 2: Visual review**

Verify in browser:
- Sidebar shows new "Connectors" item between Agents and Security
- Agents page has agent selector dropdown, vertical sub-nav, full-page sections
- Connectors page shows MCP server list with add/edit/test/remove flows
- Agent Plugins section shows plugin cards with install/uninstall flows
- All styling matches the design system (dark theme, glassmorphism, amber accents)

**Step 3: Commit any polish fixes**

---

## File Summary

| File | Action | Description |
|------|--------|-------------|
| `src/providers/mcp/database.ts` | Modify | Add global MCP CRUD functions |
| `src/host/server-admin.ts` | Modify | Add global MCP API endpoints |
| `ui/admin/src/lib/types.ts` | Modify | Add McpServer, InstalledPlugin, McpTestResult types |
| `ui/admin/src/lib/api.ts` | Modify | Add MCP and plugin API methods |
| `ui/admin/src/components/pages/connectors-page.tsx` | Create | Global MCP server management page |
| `ui/admin/src/components/pages/agents-page.tsx` | Modify | Restructure to full-page layout, add plugins |
| `ui/admin/src/App.tsx` | Modify | Add Connectors to sidebar navigation |
