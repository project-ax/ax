---
name: ax-runners
description: Use when modifying agent runner implementations — pi-session (pi-coding-agent), claude-code (Agent SDK), LLM transport selection, MCP tool wiring, or stream handling in src/agent/runners/
---

## Overview

AX supports multiple agent runners that execute inside the sandbox. Each runner wires up LLM communication, tool registration, and output streaming differently. The entry point `runner.ts` dispatches to the appropriate runner based on config. All runners share common infrastructure: IPC client, identity loading, prompt building, and stream utilities.

## Key Files

| File | Responsibility | Key Exports |
|---|---|---|
| `src/agent/runner.ts` | Entry point, stdin parse, dispatch | `run()`, `runPiCore()`, `parseStdinPayload()`, `AgentConfig` |
| `src/agent/runners/pi-session.ts` | pi-coding-agent runner (history-aware, dual LLM transport) | `runPiSession()` |
| `src/agent/runners/claude-code.ts` | Claude Agent SDK runner (TCP bridge, MCP tools) | `runClaudeCode()` |
| `src/agent/mcp-server.ts` | MCP tool registry for claude-code | `createIPCMcpServer()` |
| `src/agent/tcp-bridge.ts` | HTTP-to-Unix-socket forwarder | `startTCPBridge()`, `TCPBridge` |
| `src/agent/stream-utils.ts` | Message conversion, stream events, helpers | `convertPiMessages()`, `emitStreamEvents()`, `createSocketFetch()`, `createLazyAnthropicClient()` |
| `src/agent/ipc-transport.ts` | IPC-based LLM streaming adapter | (pi-ai streamFn interface) |

## Runner Dispatch

`runner.ts` parses CLI args and stdin JSON, then dispatches:

| `config.agent` | Runner | LLM Framework |
|---|---|---|
| `pi-agent-core` | `runPiCore()` (inline in runner.ts) | pi-agent-core Agent |
| `pi-coding-agent` | `runPiSession()` | pi-coding-agent Session |
| `claude-code` | `runClaudeCode()` | Claude Agent SDK `query()` |

## pi-session Runner

**Architecture**: Flexible LLM transport + pi-coding-agent session with history.

**LLM Transport Selection** (in order of preference):
1. **Proxy socket** — Direct Anthropic SDK over Unix socket (lower latency, no IPC overhead)
2. **IPC fallback** — Route through `ipc_client.call({action: 'llm_call'})` if proxy unavailable

**Key flow:**
1. Connect IPC client to host Unix socket
2. Create LLM stream function (proxy preferred, IPC fallback)
3. Load identity files, build system prompt via `PromptBuilder`
4. Create IPC tools (memory, web, audit, skills, scheduler, identity/user write)
5. Load + compact conversation history from stdin (75% context window threshold)
6. Create `AgentSession` with tools, history, custom system prompt
7. Call `session.sendMessage(userMessage)` and stream text to stdout
8. Subscribe to events: text_delta → stdout, tool calls → logged

**Tools**: Defined as pi-ai `ToolDefinition` objects using TypeBox schemas in `ipc-tools.ts`.

**History compaction**: If history exceeds 75% of context window, older messages are dropped while preserving the most recent turns.

## claude-code Runner

**Architecture**: TCP bridge + IPC MCP server + Agent SDK query.

**Key flow:**
1. Start TCP bridge (`startTCPBridge(proxySocket)`) — localhost:PORT → Unix socket proxy
2. Connect IPC client for MCP tool access
3. Create IPC MCP server (`createIPCMcpServer(client)`) exposing tools via MCP protocol
4. Build system prompt via `PromptBuilder`
5. Call `query()` from Claude Agent SDK with:
   - `systemPrompt`: built prompt
   - `maxTurns: 20`
   - `ANTHROPIC_BASE_URL`: `http://127.0.0.1:${bridge.port}` (TCP bridge → proxy)
   - `disallowedTools`: `['WebFetch', 'WebSearch', 'Skill']` (use AX's IPC versions)
   - `mcpServers`: the IPC MCP server
6. Stream text blocks to stdout

**TCP Bridge** (`tcp-bridge.ts`): Creates an HTTP server on localhost:0 (random port) that forwards all requests to the credential-injecting Unix socket proxy using undici's Agent. Strips encoding headers (fetch auto-decompresses). No credential logic — just a dumb forwarder.

**MCP Server** (`mcp-server.ts`): Uses `createSdkMcpServer()` from the Agent SDK to expose IPC tools as MCP tools. Tools use Zod v4 schemas (NOT TypeBox). Includes: memory_*, web_*, audit_query, identity_write, user_write, scheduler_*.

## Stream Utilities

`stream-utils.ts` provides shared helpers used by both runners:

- **`convertPiMessages(messages)`** — pi-ai format → IPC/Anthropic API format. Handles user, assistant, toolResult roles. Empty content gets safe fallbacks (Anthropic API rejects empty strings).
- **`emitStreamEvents(stream, msg, text, toolCalls, stopReason)`** — Emits standard pi-ai events (start, text_delta, toolcall_*, done) from a completed assistant message.
- **`createSocketFetch(socketPath)`** — Returns a `fetch` function routing through a Unix socket via undici.
- **`createLazyAnthropicClient(proxySocket)`** — Lazy-initialized Anthropic SDK client that connects via proxy socket. Uses `apiKey: 'ax-proxy'` (host injects real key).
- **`loadContext(workspace)`** — Reads CONTEXT.md or returns `''`.
- **`loadSkills(skillsDir)`** — Reads .md files from skills directory or returns `[]`.

## Common Tasks

**Adding a tool available to both runners:**
1. Add to `src/agent/ipc-tools.ts` (pi-agent-core/pi-session — TypeBox schemas)
2. Add to `src/agent/mcp-server.ts` (claude-code — Zod v4 schemas)
3. Add Zod schema in `src/ipc-schemas.ts` with `.strict()`
4. Add handler in `src/host/ipc-server.ts`
5. Update tool count assertion in `tests/sandbox-isolation.test.ts`

**Adding a new runner type:**
1. Create `src/agent/runners/<name>.ts` exporting an async function
2. Add dispatch case in `runner.ts`
3. Wire up IPC client, prompt builder, and tool registration
4. Add the agent type to `AgentType` in `src/types.ts`
5. Add to onboarding prompts in `src/onboarding/prompts.ts`

## Gotchas

- **Dual tool registration is mandatory**: Tools MUST exist in BOTH `ipc-tools.ts` AND `mcp-server.ts`. Missing one means that runner variant has no access.
- **TypeBox vs Zod**: pi-session tools use TypeBox (`@sinclair/typebox`), MCP server uses Zod v4. Don't mix them.
- **Proxy vs IPC transport**: pi-session prefers proxy (lower latency). claude-code always uses TCP bridge → proxy. IPC fallback adds serialization overhead.
- **IPC timeout**: Configurable via `AX_LLM_TIMEOUT_MS` env var, defaults to 10 minutes. Long-running agent loops can hit this.
- **`createLazyAnthropicClient` uses `apiKey: 'ax-proxy'`**: This is a dummy value — the host proxy injects the real key. Never pass real keys to the agent.
- **`convertPiMessages` uses `'.'` for empty content**: Anthropic API rejects empty strings. The fallback dot prevents validation errors.
- **TCP bridge strips encoding headers**: `transfer-encoding`, `content-encoding`, `content-length` are removed because fetch auto-decompresses. Don't add them back.
- **MCP server `stripTaint()`**: Removes `taint` fields from IPC responses before returning to Agent SDK, since the SDK doesn't understand AX taint tags.
- **claude-code disallows WebFetch/WebSearch/Skill**: These are replaced by AX's IPC-routed equivalents to ensure taint tracking and SSRF protection.
