# Slack Provider Behavior Changes — Design

**Date:** 2026-02-21
**Status:** Draft

## Overview

Four behavior changes to the Slack channel provider:

1. **Eyes emoji**: Show `:eyes:` reaction while processing, remove on reply or error
2. **Top-level channel gating**: Never reply in channels unless @mentioned (already handled)
3. **Thread participation**: Only reply in threads where bot was mentioned or started the thread
4. **Selective reply**: In DMs, groups, and active threads, only reply when @mentioned or when the message warrants a response (LLM decides)

## 1. Eyes Emoji Reaction

### Interface Change

Add two optional methods to `ChannelProvider` in `src/providers/channel/types.ts`:

```typescript
addReaction?(session: SessionAddress, messageId: string, emoji: string): Promise<void>;
removeReaction?(session: SessionAddress, messageId: string, emoji: string): Promise<void>;
```

### Slack Implementation

In `src/providers/channel/slack.ts`, implement using Slack's `reactions.add` / `reactions.remove` API:

```typescript
async addReaction(session, messageId, emoji) {
  const channel = session.identifiers.channel ?? session.identifiers.peer;
  await app.client.reactions.add({ token: botToken, channel, name: emoji, timestamp: messageId });
}

async removeReaction(session, messageId, emoji) {
  const channel = session.identifiers.channel ?? session.identifiers.peer;
  await app.client.reactions.remove({ token: botToken, channel, name: emoji, timestamp: messageId }).catch(() => {});
}
```

`removeReaction` swallows errors (reaction may already be gone).

### Host Integration

In `server.ts`, the channel message handler wraps processing:

```
1. shouldRespond check
2. addReaction(session, msg.id, 'eyes')  — fire-and-forget, don't block
3. try { processCompletion + send } finally { removeReaction(session, msg.id, 'eyes') }
```

The `addReaction` call is fire-and-forget (no await blocking the flow). The `removeReaction` is in a `finally` block so it runs on success, empty response, or error.

## 2. Top-Level Channel Gating

**No changes needed.** The `app_mention` event is the only path for channel messages. The `app.message` handler already filters out `channel_type !== 'im' && channel_type !== 'mpim'`. This will be slightly modified for thread support (see section 3) but top-level channel messages remain gated.

## 3. Thread Participation

### Problem

Currently `app.message` drops all non-DM messages, including thread replies. After a bot is mentioned in a thread, subsequent non-mention replies are invisible to the bot.

### Design

**a) Slack provider: let thread replies through `app.message`**

Modify `app.message` to also pass through messages where `thread_ts` is set (thread replies in channels). These get a `scope: 'thread'` session address.

**b) Message deduplication**

Slack can deliver the same message via both `message` and `app_mention` events. Track recently-seen message `ts` values in a bounded Map (60-second TTL, 500-entry max). Skip processing if already seen.

**c) Implicit mention (bot started the thread)**

When a thread reply arrives via `app.message`, check if the thread's parent was posted by the bot. Slack's `message` event includes `parent_user_id` for thread replies. If `parent_user_id === botUserId`, treat as an implicit mention — the bot started this conversation, so replies are directed at it.

**d) Host-side thread gating**

In `server.ts`, for `scope === 'thread'` messages that are NOT explicit @mentions:
- Check `conversationStore.count(sessionId)`
- If 0: the bot has never participated in this thread → drop the message
- If > 0: the bot is active in this thread → process normally

**e) Thread history backfill on first entry**

When the bot first enters a thread (via `app_mention` or implicit mention, with count === 0):
1. Call `fetchThreadHistory(channel, threadTs, limit=20)` on the provider
2. Prepend returned messages into the conversation store as user turns
3. Then process the current message normally

New optional method on `ChannelProvider`:

```typescript
fetchThreadHistory?(channel: string, threadTs: string, limit?: number): Promise<{sender: string; content: string; ts: string}[]>;
```

Slack implementation uses `conversations.replies` with pagination, capped at `limit` messages. Handles 429 (rate limit) gracefully by returning empty array.

### InboundMessage Change

Add an `isMention` field to `InboundMessage`:

```typescript
export interface InboundMessage {
  // ... existing fields ...
  isMention?: boolean;  // true when user explicitly @mentioned the bot
}
```

The Slack provider sets `isMention: true` for messages from `app_mention`. Messages from `app.message` (DMs, group DMs, thread replies) have `isMention: false` or undefined.

## 4. Selective Reply (LLM Decision)

### Mechanism

Add `replyOptional?: boolean` to the stdin payload sent to the agent process:

- **`replyOptional = false`** (must reply): explicit @mentions
- **`replyOptional = true`** (LLM decides): DMs, group chats, thread messages without @mention

### LLM Behavior

When `replyOptional` is true, the agent's system prompt includes guidance:
> "You may choose not to reply if the message doesn't seem directed at you or if you have nothing meaningful to add. Return an empty response to stay silent."

The agent can return an empty string. The host checks: if response is empty, skip `send()` but still remove `:eyes:`.

### Decision Criteria (for the LLM)

The LLM should reply when:
- Directly addressed by name or role
- Asked a question
- The message references something the bot said earlier
- The bot has useful information to contribute

The LLM should stay silent when:
- Acknowledgments ("ok", "thanks", "got it")
- Side conversations between other users (in groups)
- Messages clearly directed at someone else
- Emotional reactions ("lol", "wow", "nice")

## Data Flow Summary

```
Slack event arrives
  ├─ app_mention (channel/thread @mention)
  │   → isMention=true, scope=thread
  │   → always processed
  │   → if first entry (count=0): backfill thread history
  │
  ├─ app.message (DM)
  │   → isMention=false, scope=dm
  │   → processed, replyOptional=true
  │
  ├─ app.message (group DM)
  │   → isMention=false, scope=group
  │   → processed, replyOptional=true
  │
  ├─ app.message (thread reply, bot active)
  │   → isMention=false, scope=thread
  │   → host checks count>0: process, replyOptional=true
  │
  ├─ app.message (thread reply, bot NOT active)
  │   → isMention=false, scope=thread
  │   → host checks count=0: DROP
  │
  └─ app.message (top-level channel, no thread_ts)
      → filtered out in provider (not im/mpim/thread)

For all processed messages:
  1. shouldRespond() — DM policy check
  2. addReaction('eyes') — fire-and-forget
  3. processCompletion (with replyOptional flag)
  4. if response empty: skip send
  5. else: send response
  6. finally: removeReaction('eyes')
```

## Files Changed

| File | Change |
|------|--------|
| `src/providers/channel/types.ts` | Add `addReaction`, `removeReaction`, `fetchThreadHistory` optional methods; add `isMention` to `InboundMessage` |
| `src/providers/channel/slack.ts` | Implement reaction methods, thread history fetch, deduplication, implicit mention, pass thread replies through `app.message` |
| `src/host/server.ts` | Eyes emoji wrapping, thread gating via ConversationStore, thread backfill, replyOptional flag in stdin payload |
| `tests/providers/channel/slack.test.ts` | Tests for reactions, dedup, thread replies, implicit mention, fetchThreadHistory |
| `tests/host/server.test.ts` | Tests for thread gating, eyes emoji flow, replyOptional handling |
