# Web Admin UI & CLI Chat Removal

## Direction

AX is an enterprise cloud product. The primary interfaces are:
- **Channels** (Slack, etc.) for agent interaction
- **Web admin UI** for setup, monitoring, and management
- **HTTP API** (OpenAI-compatible) for programmatic access
- **`ax send`** for scripting/CI

CLI chat (`ax chat`) is removed. The Ink/React TUI was a dev convenience
that doesn't fit the enterprise deployment model.

## Phase 1: Remove CLI Chat + Add Admin API Skeleton

### Step 1: Remove `ax chat`

**Files to delete:**
- `src/cli/chat.ts`
- `src/cli/components/App.tsx`
- `src/cli/components/MessageList.tsx`
- `src/cli/components/InputBox.tsx`
- `src/cli/components/StatusBar.tsx`
- `src/cli/components/ThinkingIndicator.tsx`
- `src/cli/components/Message.tsx`
- `tests/cli/chat.test.ts`
- `tests/cli/components/App.test.tsx`
- `tests/cli/components/MessageList.test.tsx`
- `tests/cli/components/InputBox.test.tsx`
- `tests/cli/components/ThinkingIndicator.test.tsx`
- `tests/cli/components/Message.test.tsx`

**Files to modify:**
- `src/cli/index.ts` — Remove chat command from router, help text
- `tests/cli/index.test.ts` — Remove chat routing test
- `src/onboarding/configure.ts` — Update "What's next" box (no more `ax chat`)
- `src/cli/index.ts` — Update startup banner (no more "run: ax chat")
- `docs/web/index.html` — Update Get Started section
- `README.md` — Update Quick Start
- `package.json` — Remove `chat` script, remove `ink`/`react`/`ink-text-input` deps

**Update startup banner to:**
```
  🦀  AX is running

  Socket:  ~/.ax/ax.sock
  Admin:   http://127.0.0.1:8080/admin
  Profile: balanced

  → Press Ctrl+C to stop
```

**Update post-setup box to:**
```
  ┌──────────────────────────────────────────────┐
  │  What's next:                                │
  │                                              │
  │    ax serve       Start the server           │
  │                                              │
  │  Admin dashboard opens automatically at      │
  │  http://127.0.0.1:8080/admin                 │
  └──────────────────────────────────────────────┘
```

### Step 2: Add admin API endpoints

**New file:** `src/host/server-admin.ts`

Admin API routes served under `/admin/api/`:

```
GET  /admin/api/status          → Server health, uptime, profile, agent count
GET  /admin/api/agents          → List all agents with state, session, activity
GET  /admin/api/agents/:id      → Single agent detail + delegation tree
POST /admin/api/agents/:id/kill → Terminate an agent
GET  /admin/api/audit           → Query audit log (?action=&since=&until=&limit=)
GET  /admin/api/sessions        → List sessions grouped by user
GET  /admin/api/config          → Current config (credentials redacted)
GET  /admin/api/events          → SSE stream (reuse existing /v1/events logic)
```

**Authentication:** Bearer token required on all `/admin/*` routes.
- Token configured in `ax.yaml` under `admin.token` or generated on first run
- Timing-safe comparison via `timingSafeEqual()`
- Rate-limited auth failures (reuse webhook rate limiter pattern)

**Wire into server.ts:**
```typescript
// In handleRequest(), before the default 404:
if (pathname.startsWith('/admin/')) {
  await handleAdmin(req, res, pathname, { orchestrator, providers, config, eventBus });
  return;
}
```

### Step 3: Add admin web UI (static SPA)

**New directory:** `src/admin-ui/`

Minimal, zero-dependency frontend (vanilla HTML/CSS/JS — same approach as
`docs/web/`). No React, no build step, no bundler. Served as static files
from the AX process.

**Pages:**
1. **Dashboard** (`/admin`) — Agent count, server status, recent events feed
2. **Agents** (`/admin/agents`) — Table of all agents with state, controls
3. **Audit** (`/admin/audit`) — Searchable audit log with filters
4. **Config** (`/admin/config`) — Read-only config view (edit via ax.yaml)
5. **Setup** (`/admin/setup`) — Web-based onboarding wizard (replaces CLI wizard as primary)

**Static file serving:** New handler in `src/host/server-admin.ts`:
```typescript
// GET /admin → serve index.html
// GET /admin/styles.css → serve styles.css
// etc.
```

Files are bundled with the package (read from `src/admin-ui/` at dev time,
from dist at runtime).

### Step 4: Config changes

**Modified:** `src/config.ts`, `src/types.ts`

```typescript
admin?: {
  enabled: boolean;     // default: true
  token?: string;       // bearer token; auto-generated if not set
  port?: number;        // default: same as main server (TCP required)
};
```

When admin UI is enabled and no `--port` is specified, automatically listen
on TCP port 8080 in addition to the Unix socket.

### Step 5: Web-based onboarding

**New:** `src/admin-ui/setup.html` + `src/host/server-admin.ts` setup endpoints

```
GET  /admin/api/setup/status    → { configured: boolean, profile?: string }
POST /admin/api/setup/configure → Accept onboarding answers, write config
```

On first run (no `ax.yaml`):
1. Server starts with minimal defaults
2. Opens browser to `http://127.0.0.1:8080/admin/setup`
3. Web wizard collects: profile, agent type, auth, model, channels
4. POSTs to `/admin/api/setup/configure`
5. Server hot-reloads config
6. Redirects to dashboard

The CLI `ax configure` still works for headless/SSH setups.

## Phase 2 (Follow-up)

- Credential management UI (add/rotate API keys)
- Conversation viewer (browse chat history by session)
- Real-time event timeline with filtering
- Multi-agent deployment management
- K8s deployment manifests + Helm chart

## Implementation Order

1. Remove CLI chat (delete files, update references)
2. Add admin API skeleton (`server-admin.ts`)
3. Add bearer token auth
4. Build admin UI pages (dashboard, agents, audit)
5. Add web-based onboarding
6. Tests for all of the above
7. Update docs, README, website

## Dependencies to Remove

After removing CLI chat:
- `ink` (React terminal UI framework)
- `react` (used only by Ink components)
- `ink-text-input` (chat input component)
- `@types/react` (if present)

These are substantial dependencies — removing them shrinks the install
footprint and removes the React dependency entirely.
