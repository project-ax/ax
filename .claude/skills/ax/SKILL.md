---
name: ax
description: AX project architecture and coding skills - use sub-skills for specific subsystems (agent, host, cli, providers, etc.)
---

## AX Project Skills

This is the parent skill group for all AX project-specific architecture and coding skills. Use the appropriate sub-skill for the subsystem you're working on.

- **Core**: ax-agent, ax-host, ax-cli, ax-config, ax-ipc, ax-runners, ax-utils
- **Providers**: ax-provider-audit, ax-provider-channel, ax-provider-credentials, ax-provider-database, ax-provider-development, ax-provider-eventbus, ax-provider-llm, ax-provider-memory, ax-provider-sandbox, ax-provider-scheduler, ax-provider-skills, ax-provider-storage, ax-provider-system, ax-provider-web
- **Cross-cutting**: ax-security, ax-testing, ax-logging-errors, ax-persistence, ax-prompt-builder, ax-onboarding
- **UI**: ax-admin-dashboard-ui

## Architecture at a Glance

AX uses a **provider contract pattern**. The trusted host process (`src/host/`) orchestrates sandboxed agent processes (`src/agent/`) via IPC, with a plugin system (`src/plugins/`) for extensibility. Every subsystem is a TypeScript interface with pluggable implementations, loaded from a static allowlist in `src/host/provider-map.ts` (SC-SEC-002).

### Sandbox Model

Agent isolation uses a unified container model with three sandbox providers:

| Provider | Platform | IPC Transport | Notes |
|----------|----------|---------------|-------|
| `docker` | Any | Unix socket | Container isolation via Docker |
| `apple` | macOS | Unix socket (reverse bridge) | Apple Container framework |
| `k8s` | Kubernetes | **HTTP** (IPC + work dispatch) | Session-long pods with HTTP-based IPC |

Old Linux-specific sandbox providers (seatbelt, nsjail, bwrap) and the subprocess dev fallback have been removed. The k8s provider uses HTTP for all communication — IPC (`HttpIPCClient` → `POST /internal/ipc`) and work dispatch (`GET /internal/work`). Session-long pods are managed by `SessionPodManager` and reused across turns. Pods cannot share a filesystem with the host.

**Outbound HTTP via Web Proxy**: Agents can optionally make outbound HTTP/HTTPS requests (npm install, pip install, curl, git clone) through a controlled forward proxy on the host. Opt-in via `config.web_proxy` (disabled by default). Containers keep `--network=none` — agents reach the proxy via a TCP bridge over a mounted Unix socket. The proxy enforces private IP blocking (SSRF), canary token scanning, and audit logging. K8s pods connect directly via a k8s Service (`ax-web-proxy`).

### HTTP in k8s Deployments

In k8s mode, all communication uses HTTP:
- **IPC**: `src/agent/http-ipc-client.ts` → `POST /internal/ipc` route on host (`src/host/server-k8s.ts`)
- **LLM proxy**: `src/host/llm-proxy-core.ts` → `/internal/llm-proxy` HTTP route
- **Work dispatch**: Host queues work via `SessionPodManager.queueWork()`; pods fetch via `GET /internal/work`
- **Event bus**: `src/providers/eventbus/postgres.ts` (PostgreSQL-backed pub/sub for events)

**HTTP for all payloads**: IPC requests use HTTP POST to `/internal/ipc`. Work dispatch uses `SessionPodManager` (in-process queue). NetworkPolicy allows sandbox pods egress to host on port 8080. Workspace persistence uses git-based providers (git-http for k8s, git-local for local dev).

### MCP Fast Path (In-Process Agent)

The MCP fast path (`src/host/inprocess.ts`) runs the LLM orchestration loop directly in the host process — no pods, no IPC, no proxy, no GCS sync. Used for lightweight tool-calling tasks via MCP providers (database-backed). Key files: `inprocess.ts` (LLM loop), `tool-router.ts` (tool routing with per-turn limits), `sandbox-manager.ts` (cross-turn sandbox escalation). See `src/providers/mcp/` for the `McpProvider` interface: `listTools()`, `callTool()`, `credentialStatus()`, `storeCredential()`. Implementations: `none` (no-op), `database` (per-agent HTTP/SSE MCP servers stored in DB with circuit breakers). Unified MCP routing via `McpConnectionManager` (`src/plugins/mcp-manager.ts`).

### MCP Connection Manager

`src/plugins/` now contains only the MCP connection manager — the per-agent registry that discovers tools and routes calls across all configured MCP servers. Skills and MCP servers reach it through the git-native skill flow (`.ax/skills/<name>/SKILL.md` → reconciler → admin approval → `mcp-applier.ts` → `McpConnectionManager.addServer()`).

Key files:
- `src/plugins/mcp-manager.ts` — `McpConnectionManager`: unified MCP tool discovery and routing across skill-declared, database-backed, and default providers
- `src/plugins/mcp-client.ts` — HTTP client for querying remote MCP servers
- `src/plugins/startup.ts` — Bootstrap MCP servers from the database + config at startup

There is no longer a legacy `install/uninstall/list_cowork` IPC surface or `ax plugin`/`ax mcp` CLI. Third-party provider plugins (for LLM/memory/channel etc.) are still managed with `ax provider add|remove|list|verify`.

### Unified Tool Catalog + Indirect Dispatch

Session-scoped catalog built from each agent's active skill snapshot at turn start, shipped to the agent as a compact one-liner listing in the system prompt. Agents dispatch via two meta-tools rather than having every MCP/OpenAPI tool wired up as a first-class SDK tool.

- `src/types/catalog.ts` — `CatalogTool` shape (discriminated union of `mcp` / `openapi` dispatch kinds) + Zod validator.
- `src/host/tool-catalog/` — registry, MCP adapter, OpenAPI adapter, jq-based `_select` projection, per-session cache keyed on (agentId, HEAD-sha).
- `src/host/skills/catalog-population.ts` — iterates `frontmatter.mcpServers[]` + `frontmatter.openapi[]` from the skill snapshot, builds the catalog. Emits `Diagnostic` entries for populate failures + wide-surface advisories.
- `src/host/ipc-handlers/describe-tools.ts` — schema lookup by catalog name (`describe_tools([])` lists the whole directory).
- `src/host/ipc-handlers/call-tool.ts` — single dispatcher: MCP via `callToolOnServer`, OpenAPI via `makeDefaultOpenApiDispatcher` (path/query/header/body routing, 4 auth schemes, URL rewrites, response parsing, `_select` projection, auto-spill on large responses).
- `src/host/diagnostics.ts` — per-turn ring-buffered collector; emitted as named SSE events (`event: diagnostic`) at end-of-turn so chat UI renders a banner.

Skills declare REST APIs via `openapi[]` frontmatter (spec URL or workspace path + baseUrl + optional auth + include/exclude globs); the adapter emits one `CatalogTool` per operation with inputSchema derived from params + requestBody. MCP servers remain the first-class integration for vendors that publish one. Previous codegen pipeline (`src/host/toolgen/`, `tool_batch` IPC, `execute_script` + `ax.callTool`) was fully removed in the Phase 6 migration; the catalog + meta-tools replace that surface.

### Provider Categories

There are 15 provider categories in the static allowlist (`src/host/provider-map.ts`): llm, memory, channel, web_fetch, web_extract, web_search, credentials, audit, sandbox, scheduler, database, storage, eventbus, workspace, mcp, auth. Credentials is database-only. Workspace has `git-http` and `git-local` implementations. The `mcp` category has `none` and `database` implementations.
