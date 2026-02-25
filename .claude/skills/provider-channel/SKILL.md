---
name: ax-provider-channel
description: Use when modifying message channel providers — Slack integration, session addressing, or adding new channels (Discord, Telegram) in src/providers/channel/
---

## Overview

Channel providers handle message ingress/egress between external platforms and the AX host, using session addressing to maintain separate conversations across DM, channel, thread, and group scopes. Each implements `ChannelProvider` from `src/providers/channel/types.ts` and exports `create(config)`.

## Interface

**SessionAddress** -- `provider` (platform name), `scope` (`dm|channel|thread|group`), `identifiers` (`{ workspace?, channel?, thread?, peer? }`), `parent?` (links threads to channels). `canonicalize()` serializes to a colon-delimited map key.

**Messages** -- `InboundMessage`: `id`, `session`, `sender`, `content`, `attachments`, `timestamp`. `OutboundMessage`: `content`, `attachments?`, `replyTo?`.

**ChannelProvider** methods:

| Method             | Purpose                       |
|--------------------|-------------------------------|
| `connect()`        | Establish platform connection |
| `onMessage()`      | Register inbound handler      |
| `shouldRespond()`  | Access control gate           |
| `send()`           | Send outbound message         |
| `disconnect()`     | Tear down connection          |

**ChannelAccessConfig** -- DM policy (`open`/`allowlist`/`disabled`), mention gating, attachment filtering. Set in `ax.yaml` under `channel_config.<name>`.

## Slack Implementation

- `@slack/bolt` + `SocketModeReceiver`, dynamically imported. Requires `SLACK_BOT_TOKEN` + `SLACK_APP_TOKEN`.
- `app.message()` handles DMs/group DMs; `app.event('app_mention')` handles channels. Prevents duplicates.
- Strips `<@BOT_ID>` from text. Chunks long messages at newlines (4000 char limit).
- 30s health-check with exponential backoff reconnection for socket-mode failures.

## Session Addressing

| Scope     | Identifiers             | Notes                                  |
|-----------|-------------------------|----------------------------------------|
| `dm`      | `{ peer }`              | One session per user                   |
| `channel` | `{ channel }`           | Shared across all users                |
| `thread`  | `{ channel, thread }`   | Own session; `parent` links to channel |
| `group`   | `{ channel }`           | Multi-party DM, scoped per group       |

## Adding a New Channel Provider

1. Create `src/providers/channel/<name>.ts` implementing `ChannelProvider`.
2. Export `create(config: Config): Promise<ChannelProvider>`.
3. Add `(channel, <name>)` to `PROVIDER_MAP` in `src/host/provider-map.ts`.
4. Map platform events to `SessionAddress` scopes in a `buildSession()` helper.
5. Implement `shouldRespond()` with `ChannelAccessConfig`.
6. Add `channel_config.<name>` to the Zod `ConfigSchema`.
7. Add tests in `tests/providers/channel/<name>.test.ts`.

## Gotchas

- **No `peer` in channel/thread keys.** Fragments shared conversations into per-user sessions.
- **Workspace ID unnecessary.** Bot tokens are already workspace-scoped.
- **Group DMs need special handling.** Slack `channel_type: 'mpim'`; scope as `group`, not `channel`.
- **Bolt dual-fires for @mentions.** Guard `app.message()` to DMs only or get duplicates.
- **Socket-mode reconnect silently dies.** Use external health-check loop with backoff.
- **Event deduplication required.** Track in-flight message IDs in a `Set`.
- **`channel_config` needs both TS type and Zod schema.** `strictObject` rejects unknown keys.
