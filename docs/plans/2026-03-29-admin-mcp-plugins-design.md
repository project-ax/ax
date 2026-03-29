# Admin UI: MCP Servers & Plugins Management

**Date:** 2026-03-29
**Status:** Approved

## Summary

Restructure the admin dashboard's Agents page from a list+tabs layout to a full-page-per-agent view with a vertical sub-nav, add a Plugins section per-agent, and add a new top-level "Connectors" page for managing shared MCP servers.

## Architecture

### Sidebar Navigation (Updated)

```
Overview      (Activity icon)
Agents        (Users icon)      — full-page per agent
Connectors    (Globe icon)      — NEW: global MCP server management
Security      (Shield icon)
Logs          (FileText icon)
Settings      (Settings icon)
```

### Agent Page Restructure

The current Agents page (list + detail panel with horizontal tabs) becomes:

1. **Agent selector dropdown** — Full-width bar at top with status dot, agent name, type badge, and kill button. Dropdown lists all agents for quick switching.
2. **Vertical sub-nav** — 180px left column with grouped section links.
3. **Content area** — Full remaining width for the active section.

### Agent Sub-Nav Groups

```
AGENT
  Overview    (Activity icon)  — existing Info tab content
  Identity    (User icon)      — existing Identity tab content

TOOLS
  Skills      (Sparkles icon)  — existing Skills tab content
  Plugins     (Puzzle icon)    — NEW

DATA
  Workspace   (FolderOpen icon) — existing Workspace tab content
  Memory      (Brain icon)      — existing Memory tab content
```

### Agent Selector

- Full-width bar: `bg-card/80 border-b border-border/30`
- Status dot (emerald pulse = running, muted = stopped)
- Agent name `font-semibold`, type as `badge-zinc`
- Dropdown shows all agents with status indicators
- Kill button flush right as `btn-danger` small
- Switching agents preserves the active section

### Sub-Nav Styling

- Width: `w-[180px]`, `border-r border-border/30`, sticky
- Group headers: `text-[10px] uppercase tracking-widest text-muted-foreground px-3 pt-4 pb-1`
- Items: `text-[13px] font-medium px-3 py-1.5 rounded-md`
- Active: `text-amber bg-amber/5 border-l-2 border-amber`
- Hover: `text-foreground bg-foreground/[0.03]`

## Plugins Section (Per-Agent)

### Layout

Header bar with title + "Install Plugin" primary button. Card grid below (`grid-cols-1 lg:grid-cols-2`).

### Install Flow

Inline form (not modal) with:
- Text input: placeholder `github:owner/repo, local path, or URL`
- "Install" + "Cancel" buttons
- Spinner with "Installing…" during installation
- Success/error feedback inline

### Plugin Card

```
┌──────────────────────────────────────────┐
│  📦 plugin-name              v1.2.0      │
│  Short description of what it does       │
│                                          │
│  [2 skills] [1 cmd] [1 MCP]             │
│                                          │
│  Source: github:acme/plugin              │
│  Installed: 2 days ago                   │
│                                          │
│                          [Uninstall]      │
└──────────────────────────────────────────┘
```

- Name: `font-semibold text-[14px]`, version: `badge-zinc`
- Stats: `badge-blue` (skills), `badge-yellow` (commands), `badge-green` (MCP)
- Source: `font-mono text-[11px] text-muted-foreground`
- Relative timestamps
- Uninstall: `btn-danger` small, click → "Confirm?" for 3s

### Empty State

Centered Package icon, "No plugins installed", install button below.

## Connectors Page (Top-Level, Global MCP Servers)

MCP servers are shared resources, not scoped per-agent. The Connectors page manages them globally.

### Layout

Page header: "Connectors" title, muted description "Manage shared MCP tool servers available to all agents." "Add Server" primary button on the right.

Table/list of servers below.

### Add/Edit Form

Inline form above table (add) or replacing row (edit):
- Name input
- URL input
- Headers: key-value pairs with add/remove, credential placeholders (`{TOKEN}`) highlighted in `text-amber font-mono`
- "Test & Save" button: tests connectivity first, shows result, offers "Save Anyway" on failure
- "Cancel" button

### Server List

Table-style rows:
- Status dot + name (`font-medium`) + URL (`font-mono text-[12px] text-muted-foreground`, truncated)
- Status badge: `badge-green` "Connected", `badge-zinc` "Untested", `badge-red` "Failed"
- Plugin-sourced servers show `badge-yellow` "via plugin-name" — not editable/removable from this view
- Action buttons: Test, Edit, Remove (small `btn-secondary`, Remove uses `btn-danger` with confirm)
- Testing shows inline spinner replacing status badge

### Empty State

Globe icon, "No MCP servers configured", add button below.

## Backend API Changes

### New Global MCP Server Endpoints (replace per-agent ones)
- `GET /admin/api/mcp-servers` — List all MCP servers
- `POST /admin/api/mcp-servers` — Add server `{name, url, headers?}`
- `PUT /admin/api/mcp-servers/:name` — Update server
- `DELETE /admin/api/mcp-servers/:name` — Remove server
- `POST /admin/api/mcp-servers/:name/test` — Test connectivity

### Existing Plugin Endpoints (unchanged, per-agent)
- `GET /admin/api/agents/:id/plugins` — List installed plugins
- `POST /admin/api/agents/:id/plugins` — Install plugin `{source}`
- `DELETE /admin/api/agents/:id/plugins/:name` — Uninstall plugin

## Implementation Plan

### Phase 1: Backend — Global MCP Endpoints
1. Add global MCP server endpoints to `server-admin.ts`
2. Update McpConnectionManager to support agent-independent server storage
3. Keep per-agent endpoints as deprecated aliases (or remove if unused by other code)

### Phase 2: Restructure Agent Page
4. Create `AgentSelector` component (dropdown with agent list)
5. Create `AgentSubNav` component (vertical nav with grouped sections)
6. Refactor `AgentsPage` to use new layout (selector + sub-nav + content)
7. Move existing tab content into section components (Overview, Identity, Skills, Workspace, Memory)

### Phase 3: Add Connectors Page
8. Add global MCP server API methods to `lib/api.ts`
9. Add MCP server types to `lib/types.ts`
10. Create `ConnectorsPage` component
11. Add "Connectors" to sidebar navigation in `App.tsx`

### Phase 4: Add Plugin Management
12. Add plugin API methods to `lib/api.ts`
13. Add plugin types to `lib/types.ts`
14. Create `PluginsSection` page component
15. Wire into agent sub-nav

### Phase 5: Polish
16. Test all flows (install, uninstall, add, edit, remove, test)
17. Empty states and error handling
18. Loading skeletons for each section
