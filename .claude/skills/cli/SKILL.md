---
name: ax-cli
description: Use when modifying CLI commands — chat, send, bootstrap, or adding new CLI commands in src/cli/
---

## Overview

The CLI subsystem provides the user-facing command interface for AX. Entry point is `src/cli/index.ts` which routes commands via `routeCommand()`. Commands communicate with the AX server over a Unix socket using the OpenAI-compatible API. The chat command uses Ink (React-based terminal UI); send is a one-shot HTTP client.

## Key Files

| File | Responsibility |
|---|---|
| `src/cli/index.ts` | Command router, `main()` entry point, `runServe()`, help text |
| `src/cli/chat.ts` | Interactive chat client (Ink/React TUI), persistent sessions |
| `src/cli/send.ts` | One-shot message sender, streaming + JSON output |
| `src/cli/bootstrap.ts` | Agent identity reset (deletes SOUL.md/IDENTITY.md, copies templates) |
| `src/cli/components/App.ts` | Ink React component for the chat UI |

## Commands

| Command | Handler | Description |
|---|---|---|
| `ax serve` (default) | `runServe(args)` | Start HTTP server on Unix socket; first-run triggers `configure` |
| `ax chat` | `runChat(args)` | Interactive Ink TUI; persistent session via ConversationStore |
| `ax send <msg>` | `runSend(args)` | One-shot message; ephemeral by default (no session persistence) |
| `ax configure` | `runConfigure(axHome)` | First-time setup wizard (onboarding) |
| `ax bootstrap [agent]` | `runBootstrap(args)` | Reset agent identity; prompts confirmation if SOUL.md exists |

## Chat Command (`chat.ts`)

- **Session**: Persistent. Default session ID: `main:cli:default` (via `composeSessionId`)
- **Custom session**: `--session <name>` composes `main:cli:<name>`; if name contains `:`, passed through as-is
- **Transport**: Unix socket fetch via `undici.Agent({ connect: { socketPath } })`
- **UI**: Ink React app (`App` component) with streaming support
- **Default socket**: `~/.ax/ax.sock`

## Send Command (`send.ts`)

- **Session**: Ephemeral by default (no `session_id` in request body)
- **With `--session`**: Uses same composition rules as chat
- **Input**: Positional arg or `--stdin` / `-` for piped input
- **Output modes**: Streaming SSE (default), `--no-stream` (full response), `--json` (raw OpenAI JSON)
- **SSE parsing**: Reads `data:` lines, extracts `choices[0].delta.content` until `[DONE]`

## Session IDs

Format: colon-separated segments with minimum 3 parts.

| Pattern | Example | Use case |
|---|---|---|
| `<agent>:<source>:<name>` | `main:cli:default` | Default CLI chat |
| `<agent>:<source>:<name>` | `main:cli:work` | Named CLI session |
| `<agent>:<channel>:<scope>:<id>` | `main:slack:dm:U12345` | Slack DM |
| UUID (legacy) | `550e8400-...` | Pre-session-ID format |

Colon-separated IDs map to nested directories: `main:cli:default` -> `~/.ax/data/workspaces/main/cli/default/`

## Bootstrap (`bootstrap.ts`)

- **Evolvable files deleted**: `SOUL.md`, `IDENTITY.md`
- **Templates copied**: `BOOTSTRAP.md`, `USER_BOOTSTRAP.md` from `./templates/`
- **Preserved across reset**: Per-user `USER.md` files, admins file
- Default agent name: `main`

## Common Tasks

**Adding a new CLI command:**
1. Add handler signature to `CommandHandlers` interface in `index.ts`
2. Add case in `routeCommand()` switch
3. Add to `knownCommands` Set in `main()`
4. Create `src/cli/mycommand.ts` with `runMyCommand(args)` export
5. Add dynamic import in `main()` command handlers
6. Update `showHelp()` text

## Gotchas

- **Session IDs use colons mapped to nested dirs**: `main:cli:default` becomes `data/workspaces/main/cli/default/`. Don't use filesystem separators in session IDs.
- **Legacy UUID sessions still work**: `isValidSessionId()` accepts both UUID and colon format. UUID sessions use flat directories under `workspaces/`.
- **`loadDotEnv()` called at CLI entry**: `main()` calls `loadDotEnv()` before routing. Individual commands do not re-load.
- **First-run detection in serve**: If `ax.yaml` does not exist, `runServe` automatically triggers `runConfigure` before starting the server.
- **Ink requires React**: `chat.ts` imports React and Ink. The send command is plain Node.js with no UI framework.
