---
name: ax-agent
description: Use when modifying the sandboxed agent process — runner, IPC client, local/IPC tools, prompt building, or identity loading in src/agent/
---

## Overview

The agent subsystem runs inside a sandboxed process (no network, no credentials). It receives a user message + history via stdin, builds a system prompt from modular components, registers local and IPC tools, then runs an LLM agent loop that streams text output to stdout. All LLM calls and privileged operations route through IPC to the trusted host.

## Key Files

| File | Responsibility | Key Exports |
|---|---|---|
| `src/agent/runner.ts` | Entry point, stdin parse, agent dispatch | `run()`, `runPiCore()`, `parseStdinPayload()`, `AgentConfig` |
| `src/agent/ipc-client.ts` | Length-prefixed Unix socket IPC | `IPCClient` (connect, call, disconnect) |
| `src/agent/ipc-tools.ts` | Tools that proxy to host via IPC | `createIPCTools(client, opts)` |
| `src/agent/local-tools.ts` | Sandbox-local file/bash tools | `createLocalTools(workspace)` |
| `src/agent/identity-loader.ts` | Reads SOUL.md, IDENTITY.md, etc. from agentDir | `loadIdentityFiles(opts)` |
| `src/agent/prompt/builder.ts` | Assembles system prompt from ordered modules | `PromptBuilder`, `PromptResult` |
| `src/agent/prompt/types.ts` | PromptContext, PromptModule interface, IdentityFiles | `PromptContext`, `PromptModule`, `IdentityFiles` |
| `src/agent/runners/pi-session.ts` | pi-coding-agent runner variant | `runPiSession()` |
| `src/agent/runners/claude-code.ts` | Claude Code runner variant | `runClaudeCode()` |
| `src/agent/mcp-server.ts` | MCP tool registry for claude-code runner | (tool registrations) |

## Agent Boot Sequence

1. `runner.ts` parses CLI args (`--ipc-socket`, `--workspace`, `--agent-dir`, etc.)
2. Reads stdin as JSON (`{message, history, taintRatio, profile, ...}`) via `parseStdinPayload()`
3. Dispatches to runner: `runPiCore()`, `runPiSession()`, or `runClaudeCode()`
4. Runner connects `IPCClient` to host Unix socket
5. Loads identity files from `agentDir` via `loadIdentityFiles()`
6. `PromptBuilder.build(ctx)` assembles system prompt from modules
7. Creates local tools (`createLocalTools`) + IPC tools (`createIPCTools`)
8. Optionally compacts history if exceeding 75% of context window
9. Creates pi-agent-core `Agent` with tools, prompt, history, and stream function
10. Calls `agent.prompt(userMessage)` and streams text deltas to stdout

## Tool System

- **Local tools** (`local-tools.ts`): Execute inside sandbox -- `bash`, `read_file`, `write_file`, `edit_file`. All file ops use `safePath()` to enforce workspace containment.
- **IPC tools** (`ipc-tools.ts`): Proxy to host -- `memory_*`, `web_*`, `audit_query`, `identity_write`, `user_write`, `scheduler_*`. Each calls `client.call({action, ...params})`.
- **AgentTool pattern**: `{name, label, description, parameters: Type.Object({...}), execute(id, params)}`. Parameters use TypeBox (`@sinclair/typebox`), NOT Zod.
- **LLM routing**: Via proxy (Anthropic SDK over Unix socket) or IPC fallback. Never direct API calls from the agent.

## Prompt Builder

`PromptBuilder` holds an ordered list of `PromptModule` instances, sorted by `priority` (lower = earlier). Each module implements `shouldInclude(ctx)`, `render(ctx)`, `estimateTokens(ctx)`, and optionally `renderMinimal(ctx)`.

| Module | Priority | Content |
|---|---|---|
| IdentityModule | 0 | SOUL.md, IDENTITY.md, BOOTSTRAP.md, USER.md |
| InjectionDefenseModule | 5 | Prompt injection defenses |
| SecurityModule | 10 | Taint awareness, identity ownership rules |
| ContextModule | 60 | CONTEXT.md from workspace |
| SkillsModule | 70 | Loaded skill definitions |
| HeartbeatModule | 80 | HEARTBEAT.md periodic check schedule |
| RuntimeModule | 90 | Agent type, sandbox type, tool list |

Budget allocation (`budget.ts`) can drop `optional` modules or switch to `renderMinimal` when context is tight.

## Identity

| File | Purpose |
|---|---|
| `SOUL.md` | Core personality, values, voice -- shared across all users |
| `IDENTITY.md` | Self-description, capabilities, evolving self-model |
| `BOOTSTRAP.md` | First-session instructions (shown only when SOUL.md is absent) |
| `USER.md` | Per-user preferences (stored at `agentDir/users/<userId>/USER.md`) |
| `HEARTBEAT.md` | Periodic self-check schedule and health definitions |

`loadIdentityFiles()` reads all from `agentDir`. Returns empty strings for missing files (never throws).

## Common Tasks

**Adding a new local tool:**
1. Add tool object to the array in `src/agent/local-tools.ts`
2. Use `safePath(workspace, path)` for any file access
3. Add test in `tests/agent/local-tools.test.ts`

**Adding a new IPC tool:**
1. Add tool to array in `src/agent/ipc-tools.ts` (pi-agent-core runner)
2. Add matching tool in `src/agent/mcp-server.ts` (claude-code runner)
3. Add Zod schema in `src/ipc-schemas.ts` with `.strict()`
4. Add handler in `src/host/ipc-server.ts`
5. Update tool count in `tests/sandbox-isolation.test.ts`

**Adding a new prompt module:**
1. Create `src/agent/prompt/modules/<name>.ts` implementing `PromptModule`
2. Register in `PromptBuilder` constructor (`src/agent/prompt/builder.ts`)
3. Set `priority` to control ordering (0-100)
4. Add test in `tests/agent/prompt/modules/`

## Gotchas

- **Dual tool registration**: IPC tools MUST be registered in BOTH `ipc-tools.ts` AND `mcp-server.ts`. Missing one means that runner type has no access to the tool.
- **pi-ai auto-registers providers on import**: Always call `clearApiProviders()` after importing `@mariozechner/pi-ai` in sandbox code.
- **LLM calls never go direct**: All LLM calls route through either the proxy (Anthropic SDK over Unix socket) or IPC. The agent has no API keys.
- **TypeBox for tool params, Zod for IPC schemas**: Don't mix them. Tools use `Type.Object(...)`, IPC uses `z.strictObject(...)`.
- **`safePath()` is mandatory**: Every local tool file operation must go through `safePath()` to prevent workspace escape.
- **Strict IPC schemas reject unknown fields**: Adding a field to an IPC call without updating the Zod schema silently fails (`{ok: false}`).
- **Identity loader never throws**: Missing files return `''`. Check content length, not for exceptions.
