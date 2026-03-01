# Slack Behavior Changes Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make the Slack provider smarter about when and how it responds — eyes emoji on processing, thread participation tracking, and selective reply via LLM.

**Architecture:** Four changes layered across the provider interface (`types.ts`), Slack implementation (`slack.ts`), host server (`server.ts`), and agent prompt system. The ChannelProvider interface gets optional `addReaction`/`removeReaction`/`fetchThreadHistory` methods. The host gates thread messages via ConversationStore and passes a `replyOptional` flag to the agent. A new prompt module instructs the LLM when it may stay silent.

**Tech Stack:** TypeScript, @slack/bolt, vitest, SQLite (ConversationStore)

---

### Task 1: Add `isMention` to InboundMessage and reaction/history methods to ChannelProvider

**Files:**
- Modify: `src/providers/channel/types.ts`
- Test: `tests/providers/channel/types.test.ts`

**Step 1: Write the failing test**

Add to `tests/providers/channel/types.test.ts`:

```typescript
test('InboundMessage supports isMention field', () => {
  const msg: InboundMessage = {
    id: '1',
    session: { provider: 'test', scope: 'channel', identifiers: {} },
    sender: 'U1',
    content: 'hello',
    attachments: [],
    timestamp: new Date(),
    isMention: true,
  };
  expect(msg.isMention).toBe(true);
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/providers/channel/types.test.ts`
Expected: FAIL — `isMention` does not exist on type `InboundMessage`

**Step 3: Implement the type changes**

In `src/providers/channel/types.ts`:

Add to `InboundMessage` interface:
```typescript
  isMention?: boolean;  // true when user explicitly @mentioned the bot
```

Add to `ChannelProvider` interface:
```typescript
  addReaction?(session: SessionAddress, messageId: string, emoji: string): Promise<void>;
  removeReaction?(session: SessionAddress, messageId: string, emoji: string): Promise<void>;
  fetchThreadHistory?(channel: string, threadTs: string, limit?: number): Promise<{sender: string; content: string; ts: string}[]>;
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/providers/channel/types.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/providers/channel/types.ts tests/providers/channel/types.test.ts
git commit -m "feat: add isMention, reaction methods, and fetchThreadHistory to channel types"
```

---

### Task 2: Implement `addReaction` and `removeReaction` in Slack provider

**Files:**
- Modify: `src/providers/channel/slack.ts`
- Modify: `tests/providers/channel/slack.test.ts`

**Step 1: Write the failing tests**

Add mock for reactions API at the top of the test file, inside the `MockApp` class:

```typescript
const mockReactionsAdd = vi.fn().mockResolvedValue({ ok: true });
const mockReactionsRemove = vi.fn().mockResolvedValue({ ok: true });
```

Add to `MockApp.client`:
```typescript
reactions: { add: mockReactionsAdd, remove: mockReactionsRemove },
```

Add test in a new `describe('reactions', ...)` block:

```typescript
describe('reactions', () => {
  test('addReaction calls reactions.add with correct params', async () => {
    process.env.SLACK_BOT_TOKEN = 'xoxb-test';
    process.env.SLACK_APP_TOKEN = 'xapp-test';
    const { create } = await import('../../../src/providers/channel/slack.js');
    const provider = await create(testConfig());

    const session: SessionAddress = {
      provider: 'slack', scope: 'thread',
      identifiers: { channel: 'C01', thread: '1234.5678' },
    };
    await provider.addReaction!(session, '1234.5678', 'eyes');

    expect(mockReactionsAdd).toHaveBeenCalledWith({
      token: 'xoxb-test', channel: 'C01', name: 'eyes', timestamp: '1234.5678',
    });
  });

  test('removeReaction calls reactions.remove and swallows errors', async () => {
    process.env.SLACK_BOT_TOKEN = 'xoxb-test';
    process.env.SLACK_APP_TOKEN = 'xapp-test';
    mockReactionsRemove.mockRejectedValueOnce(new Error('no_reaction'));
    const { create } = await import('../../../src/providers/channel/slack.js');
    const provider = await create(testConfig());

    const session: SessionAddress = {
      provider: 'slack', scope: 'channel',
      identifiers: { channel: 'C01' },
    };
    // Should not throw even when API returns error
    await expect(provider.removeReaction!(session, '1111.2222', 'eyes')).resolves.toBeUndefined();
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/providers/channel/slack.test.ts`
Expected: FAIL — `addReaction` / `removeReaction` not defined on provider

**Step 3: Implement reaction methods**

In `src/providers/channel/slack.ts`, add to the returned object (after `disconnect`):

```typescript
async addReaction(session: SessionAddress, messageId: string, emoji: string): Promise<void> {
  const channel = session.identifiers.channel ?? session.identifiers.peer;
  if (!channel) return;
  await app.client.reactions.add({ token: botToken, channel, name: emoji, timestamp: messageId });
},

async removeReaction(session: SessionAddress, messageId: string, emoji: string): Promise<void> {
  const channel = session.identifiers.channel ?? session.identifiers.peer;
  if (!channel) return;
  await app.client.reactions.remove({ token: botToken, channel, name: emoji, timestamp: messageId }).catch(() => {});
},
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/providers/channel/slack.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/providers/channel/slack.ts tests/providers/channel/slack.test.ts
git commit -m "feat: implement addReaction and removeReaction in Slack provider"
```

---

### Task 3: Implement `fetchThreadHistory` in Slack provider

**Files:**
- Modify: `src/providers/channel/slack.ts`
- Modify: `tests/providers/channel/slack.test.ts`

**Step 1: Write the failing tests**

Add mock at top level:
```typescript
const mockConversationsReplies = vi.fn().mockResolvedValue({ ok: true, messages: [] });
```

Add to `MockApp.client`:
```typescript
conversations: { replies: mockConversationsReplies },
```

Add test in a new `describe('fetchThreadHistory', ...)` block:

```typescript
describe('fetchThreadHistory', () => {
  test('returns messages from conversations.replies', async () => {
    process.env.SLACK_BOT_TOKEN = 'xoxb-test';
    process.env.SLACK_APP_TOKEN = 'xapp-test';
    mockConversationsReplies.mockResolvedValueOnce({
      ok: true,
      messages: [
        { user: 'U1', text: 'first message', ts: '1000.0001' },
        { user: 'U2', text: 'reply', ts: '1000.0002' },
        { user: 'UBOT', text: 'bot reply', ts: '1000.0003' },
      ],
    });
    const { create } = await import('../../../src/providers/channel/slack.js');
    const provider = await create(testConfig());
    await provider.connect();

    const history = await provider.fetchThreadHistory!('C01', '1000.0001', 20);

    expect(mockConversationsReplies).toHaveBeenCalledWith(
      expect.objectContaining({ channel: 'C01', ts: '1000.0001', limit: 20 }),
    );
    expect(history).toEqual([
      { sender: 'U1', content: 'first message', ts: '1000.0001' },
      { sender: 'U2', content: 'reply', ts: '1000.0002' },
      { sender: 'UBOT', content: 'bot reply', ts: '1000.0003' },
    ]);
  });

  test('returns empty array on API error (graceful degradation)', async () => {
    process.env.SLACK_BOT_TOKEN = 'xoxb-test';
    process.env.SLACK_APP_TOKEN = 'xapp-test';
    mockConversationsReplies.mockRejectedValueOnce(new Error('ratelimited'));
    const { create } = await import('../../../src/providers/channel/slack.js');
    const provider = await create(testConfig());
    await provider.connect();

    const history = await provider.fetchThreadHistory!('C01', '1000.0001');
    expect(history).toEqual([]);
  });

  test('filters messages without text or user', async () => {
    process.env.SLACK_BOT_TOKEN = 'xoxb-test';
    process.env.SLACK_APP_TOKEN = 'xapp-test';
    mockConversationsReplies.mockResolvedValueOnce({
      ok: true,
      messages: [
        { user: 'U1', text: 'valid', ts: '1000.0001' },
        { text: 'no user', ts: '1000.0002' },
        { user: 'U2', ts: '1000.0003' },
      ],
    });
    const { create } = await import('../../../src/providers/channel/slack.js');
    const provider = await create(testConfig());
    await provider.connect();

    const history = await provider.fetchThreadHistory!('C01', '1000.0001', 20);
    expect(history).toEqual([
      { sender: 'U1', content: 'valid', ts: '1000.0001' },
    ]);
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/providers/channel/slack.test.ts`
Expected: FAIL — `fetchThreadHistory` not defined

**Step 3: Implement fetchThreadHistory**

In `src/providers/channel/slack.ts`, add to the returned object:

```typescript
async fetchThreadHistory(channel: string, threadTs: string, limit: number = 20): Promise<{sender: string; content: string; ts: string}[]> {
  try {
    const response = await app.client.conversations.replies({
      token: botToken,
      channel,
      ts: threadTs,
      limit,
      inclusive: true,
    }) as { ok: boolean; messages?: Array<{ user?: string; text?: string; ts?: string }> };

    if (!response.messages) return [];

    return response.messages
      .filter((m): m is { user: string; text: string; ts: string } =>
        !!m.user && !!m.text && !!m.ts)
      .map(m => ({ sender: m.user, content: m.text, ts: m.ts }));
  } catch {
    return [];
  }
},
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/providers/channel/slack.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/providers/channel/slack.ts tests/providers/channel/slack.test.ts
git commit -m "feat: implement fetchThreadHistory in Slack provider"
```

---

### Task 4: Pass thread replies through `app.message` and set `isMention`

**Files:**
- Modify: `src/providers/channel/slack.ts`
- Modify: `tests/providers/channel/slack.test.ts`

**Step 1: Write the failing tests**

```typescript
describe('thread reply routing', () => {
  test('app.message passes through thread replies in channels', async () => {
    process.env.SLACK_BOT_TOKEN = 'xoxb-test';
    process.env.SLACK_APP_TOKEN = 'xapp-test';
    const { create } = await import('../../../src/providers/channel/slack.js');
    const provider = await create(testConfig());
    await provider.connect();

    const handler = vi.fn();
    provider.onMessage(handler);

    const messageHandler = eventHandlers.get('message')!;
    await messageHandler({
      message: {
        text: 'a reply in a thread',
        user: 'U123',
        channel: 'C01',
        ts: '2222.3333',
        thread_ts: '1111.2222',
        channel_type: 'channel',
      },
    });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        session: expect.objectContaining({ scope: 'thread' }),
        content: 'a reply in a thread',
        isMention: false,
      }),
    );
  });

  test('app.message still ignores top-level channel messages (no thread_ts)', async () => {
    process.env.SLACK_BOT_TOKEN = 'xoxb-test';
    process.env.SLACK_APP_TOKEN = 'xapp-test';
    const { create } = await import('../../../src/providers/channel/slack.js');
    const provider = await create(testConfig());
    await provider.connect();

    const handler = vi.fn();
    provider.onMessage(handler);

    const messageHandler = eventHandlers.get('message')!;
    await messageHandler({
      message: {
        text: 'top level in channel',
        user: 'U123',
        channel: 'C01',
        ts: '1111.2222',
        channel_type: 'channel',
      },
    });

    expect(handler).not.toHaveBeenCalled();
  });

  test('app_mention sets isMention=true', async () => {
    process.env.SLACK_BOT_TOKEN = 'xoxb-test';
    process.env.SLACK_APP_TOKEN = 'xapp-test';
    const { create } = await import('../../../src/providers/channel/slack.js');
    const provider = await create(testConfig());
    await provider.connect();

    const handler = vi.fn();
    provider.onMessage(handler);

    const mentionHandler = eventHandlers.get('app_mention')!;
    await mentionHandler({
      event: {
        text: '<@UBOT> do something',
        user: 'U123',
        channel: 'C01',
        ts: '1111.2222',
      },
    });

    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ isMention: true }),
    );
  });

  test('DMs have isMention=false', async () => {
    process.env.SLACK_BOT_TOKEN = 'xoxb-test';
    process.env.SLACK_APP_TOKEN = 'xapp-test';
    const { create } = await import('../../../src/providers/channel/slack.js');
    const provider = await create(testConfig());
    await provider.connect();

    const handler = vi.fn();
    provider.onMessage(handler);

    const messageHandler = eventHandlers.get('message')!;
    await messageHandler({
      message: {
        text: 'hello',
        user: 'U123',
        channel: 'D01',
        ts: '1111.2222',
        channel_type: 'im',
      },
    });

    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ isMention: false }),
    );
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/providers/channel/slack.test.ts`
Expected: FAIL — thread replies still filtered out, isMention not set

**Step 3: Implement the changes**

In `src/providers/channel/slack.ts`:

**Modify `app.message` handler (lines 218-237):**

Replace the channel_type filter. The new logic:
- DMs (`im`) and group DMs (`mpim`): always pass through (as before)
- Thread replies (any `channel_type` with `thread_ts`): pass through
- Top-level channel messages (no `thread_ts`, not `im`/`mpim`): drop

```typescript
app.message(async ({ message }) => {
  const msg = message as SlackMessage;
  if (!msg.text || !msg.user) return;
  if (msg.user === botUserId) return;
  if (!messageHandler) return;

  const isDm = msg.channel_type === 'im' || msg.channel_type === 'mpim';
  const isThreadReply = !!msg.thread_ts;

  // Drop top-level channel messages — only app_mention handles those
  if (!isDm && !isThreadReply) return;

  await messageHandler({
    id: msg.ts,
    session: buildSession(msg.user, msg.channel, msg.thread_ts, msg.channel_type),
    sender: msg.user,
    content: msg.text,
    attachments: buildAttachments(msg.files),
    timestamp: new Date(parseFloat(msg.ts) * 1000),
    replyTo: msg.thread_ts,
    raw: message,
    isMention: false,
  });
});
```

**Modify `app_mention` handler (lines 240-262):**

Add `isMention: true` to the InboundMessage:

```typescript
app.event('app_mention', async ({ event }) => {
  if (!event.text || !event.user) return;
  if (event.user === botUserId) return;
  if (!messageHandler) return;

  let text = event.text.trim();
  if (botUserId) {
    text = text.replace(new RegExp(`<@${botUserId}>\\s*`, 'g'), '').trim();
  }
  if (!text) return;

  await messageHandler({
    id: event.ts,
    session: buildSession(event.user, event.channel, event.thread_ts ?? event.ts),
    sender: event.user,
    content: text,
    attachments: buildAttachments((event as any).files),
    timestamp: new Date(parseFloat(event.ts) * 1000),
    replyTo: event.thread_ts,
    raw: event,
    isMention: true,
  });
});
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/providers/channel/slack.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/providers/channel/slack.ts tests/providers/channel/slack.test.ts
git commit -m "feat: pass thread replies through app.message, add isMention flag"
```

---

### Task 5: Host-side eyes emoji, thread gating, and thread backfill

**Files:**
- Modify: `src/host/server.ts`
- Modify: `tests/host/server.test.ts` (if channel tests exist there, otherwise add)

This task modifies the channel message handler in `server.ts` (lines 844-885).

**Step 1: Implement the changes**

In `src/host/server.ts`, replace the channel onMessage handler (lines 846-883):

```typescript
channel.onMessage(async (msg: InboundMessage) => {
  if (!channel.shouldRespond(msg)) {
    logger.debug('channel_message_filtered', { provider: channel.name, sender: msg.sender });
    return;
  }

  // Deduplicate: Slack (and other providers) may deliver the same event
  // multiple times due to socket reconnections or missed acks.
  // Also handles app.message + app_mention overlap for thread messages.
  const dedupeKey = `${channel.name}:${msg.id}`;
  if (isChannelDuplicate(dedupeKey)) {
    logger.debug('channel_message_deduplicated', { provider: channel.name, messageId: msg.id });
    return;
  }

  // Thread gating: only process thread messages if the bot has participated
  // (i.e., was mentioned in the thread at some point, creating a session).
  const sessionId = canonicalize(msg.session);
  if (msg.session.scope === 'thread' && !msg.isMention) {
    const turnCount = conversationStore.count(sessionId);
    if (turnCount === 0) {
      logger.debug('thread_message_gated', { provider: channel.name, sessionId, reason: 'bot_not_in_thread' });
      return;
    }
  }

  // Thread backfill: on first entry into a thread, fetch prior messages
  if (msg.session.scope === 'thread' && msg.isMention && channel.fetchThreadHistory) {
    const turnCount = conversationStore.count(sessionId);
    if (turnCount === 0) {
      const threadChannel = msg.session.identifiers.channel;
      const threadTs = msg.session.identifiers.thread;
      if (threadChannel && threadTs) {
        try {
          const threadMessages = await channel.fetchThreadHistory(threadChannel, threadTs, 20);
          // Prepend thread history as user turns (exclude the current message)
          for (const tm of threadMessages) {
            if (tm.ts === msg.id) continue; // skip current message
            conversationStore.append(sessionId, 'user', tm.content, tm.sender);
          }
          logger.debug('thread_backfill', { sessionId, messagesAdded: threadMessages.length });
        } catch (err) {
          logger.warn('thread_backfill_failed', { sessionId, error: (err as Error).message });
        }
      }
    }
  }

  // Bootstrap gate: only admins can interact while the agent is being set up.
  if (isAgentBootstrapMode(agentDirVal) && !isAdmin(agentDirVal, msg.sender)) {
    logger.info('bootstrap_gate_blocked', { provider: channel.name, sender: msg.sender });
    await channel.send(msg.session, {
      content: 'This agent is still being set up. Only admins can interact during bootstrap.',
    });
    return;
  }

  // Eyes emoji: acknowledge receipt
  if (channel.addReaction) {
    channel.addReaction(msg.session, msg.id, 'eyes').catch(() => {});
  }

  try {
    const result = await router.processInbound(msg);
    if (!result.queued) {
      await channel.send(msg.session, {
        content: `Message blocked: ${result.scanResult.reason ?? 'security scan failed'}`,
      });
      return;
    }
    sessionCanaries.set(result.sessionId, result.canaryToken);

    // Determine if reply is optional (LLM can choose not to respond)
    const replyOptional = !msg.isMention;

    const { responseContent } = await processCompletion(
      msg.content, `ch-${randomUUID().slice(0, 8)}`, [], canonicalize(msg.session),
      { sessionId: result.sessionId, messageId: result.messageId!, canaryToken: result.canaryToken },
      msg.sender,
      replyOptional,
    );

    // If LLM chose not to reply, skip sending
    if (responseContent.trim()) {
      await channel.send(msg.session, { content: responseContent });
    }
  } finally {
    // Remove eyes emoji regardless of outcome
    if (channel.removeReaction) {
      channel.removeReaction(msg.session, msg.id, 'eyes').catch(() => {});
    }
  }
});
```

**Step 2: Update `processCompletion` signature**

In `src/host/server.ts`, add `replyOptional` parameter to `processCompletion` (line 338):

```typescript
async function processCompletion(
  content: string,
  requestId: string,
  clientMessages: { role: string; content: string }[] = [],
  persistentSessionId?: string,
  preProcessed?: { sessionId: string; messageId: string; canaryToken: string },
  userId?: string,
  replyOptional?: boolean,
): Promise<{ responseContent: string; finishReason: 'stop' | 'content_filter' }> {
```

Then in the stdinPayload construction (around line 564), add:

```typescript
const stdinPayload = JSON.stringify({
  history,
  message: content,
  taintRatio: taintState ? taintState.taintedTokens / (taintState.totalTokens || 1) : 0,
  taintThreshold: thresholdForProfile(config.profile),
  profile: config.profile,
  sandboxType: config.providers.sandbox,
  userId: userId ?? process.env.USER ?? 'default',
  replyOptional: replyOptional ?? false,
});
```

**Step 3: Run all tests to verify nothing breaks**

Run: `npx vitest run`
Expected: All existing tests PASS. The new logic is only exercised via channel providers.

**Step 4: Commit**

```bash
git add src/host/server.ts
git commit -m "feat: add eyes emoji, thread gating, thread backfill, and replyOptional to host"
```

---

### Task 6: Add `replyOptional` to agent stdin payload and prompt system

**Files:**
- Modify: `src/agent/runner.ts` (StdinPayload, parseStdinPayload, AgentConfig, run)
- Modify: `src/agent/prompt/types.ts` (PromptContext)
- Create: `src/agent/prompt/modules/reply-gate.ts`
- Modify: `src/agent/prompt/builder.ts` (register new module)
- Create: `tests/agent/prompt/modules/reply-gate.test.ts`
- Modify: `tests/agent/runner.test.ts` (if exists, for parseStdinPayload)

**Step 1: Write the failing test for ReplyGateModule**

Create `tests/agent/prompt/modules/reply-gate.test.ts`:

```typescript
import { describe, test, expect } from 'vitest';
import { ReplyGateModule } from '../../../../src/agent/prompt/modules/reply-gate.js';
import type { PromptContext } from '../../../../src/agent/prompt/types.js';

function makeCtx(overrides: Partial<PromptContext> = {}): PromptContext {
  return {
    agentType: 'pi-agent-core',
    workspace: '/tmp/test',
    skills: [],
    profile: 'balanced',
    sandboxType: 'subprocess',
    taintRatio: 0,
    taintThreshold: 0.3,
    identityFiles: { agents: '', soul: '', identity: '', user: '', bootstrap: '', userBootstrap: '', heartbeat: '' },
    contextContent: '',
    contextWindow: 200000,
    historyTokens: 0,
    replyOptional: false,
    ...overrides,
  };
}

describe('ReplyGateModule', () => {
  const mod = new ReplyGateModule();

  test('not included when replyOptional is false', () => {
    expect(mod.shouldInclude(makeCtx({ replyOptional: false }))).toBe(false);
  });

  test('included when replyOptional is true', () => {
    expect(mod.shouldInclude(makeCtx({ replyOptional: true }))).toBe(true);
  });

  test('render produces guidance text', () => {
    const lines = mod.render(makeCtx({ replyOptional: true }));
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join('\n')).toContain('may choose not to reply');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/agent/prompt/modules/reply-gate.test.ts`
Expected: FAIL — module does not exist

**Step 3: Implement ReplyGateModule**

Add `replyOptional` to `PromptContext` in `src/agent/prompt/types.ts`:

```typescript
  // Reply gating (from host — channel messages where bot may choose silence)
  replyOptional?: boolean;
```

Create `src/agent/prompt/modules/reply-gate.ts`:

```typescript
// src/agent/prompt/modules/reply-gate.ts
import type { PromptContext, PromptModule } from '../types.js';

/**
 * When the host signals that a reply is optional (non-mention messages in DMs,
 * groups, or threads the bot is participating in), this module instructs the
 * agent that it may choose to stay silent.
 */
export class ReplyGateModule implements PromptModule {
  readonly name = 'reply-gate';
  readonly priority = 95;  // near end, after runtime
  readonly optional = true;

  shouldInclude(ctx: PromptContext): boolean {
    return ctx.replyOptional === true;
  }

  render(_ctx: PromptContext): string[] {
    return [
      '<reply-gate>',
      'You may choose not to reply to this message. You were NOT directly @mentioned.',
      'Reply ONLY if:',
      '- The message seems directly addressed to you (by name or role)',
      '- You are asked a question or for help',
      '- The message references something you said earlier',
      '- You have genuinely useful information to contribute',
      '',
      'Stay SILENT (respond with exactly an empty message) if:',
      '- The message is an acknowledgment ("ok", "thanks", "got it")',
      '- It is a side conversation between other people',
      '- The message is clearly directed at someone else',
      '- It is an emotional reaction ("lol", "wow", "nice", emoji-only)',
      '- You would just be echoing or restating what was already said',
      '',
      'When in doubt, stay silent. Only speak when you add real value.',
      'To stay silent, output nothing (empty response).',
      '</reply-gate>',
    ];
  }

  estimateTokens(_ctx: PromptContext): number {
    return 200;
  }
}
```

Register it in `src/agent/prompt/builder.ts`:

```typescript
import { ReplyGateModule } from './modules/reply-gate.js';
```

Add to the modules array:
```typescript
new ReplyGateModule(),          // 95
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/agent/prompt/modules/reply-gate.test.ts`
Expected: PASS

**Step 5: Wire replyOptional through the agent runner**

In `src/agent/runner.ts`:

Add to `StdinPayload` interface (line 518-526):
```typescript
  replyOptional?: boolean;
```

In `parseStdinPayload` (around line 533-560), add to the parsed return:
```typescript
  replyOptional: parsed.replyOptional === true,
```

And to defaults:
```typescript
  replyOptional: false,
```

Add to `AgentConfig` interface:
```typescript
  replyOptional?: boolean;
```

In the main entry (around line 604-610), pass it through:
```typescript
  config.replyOptional = payload.replyOptional;
```

In `run()` function, pass `replyOptional` to `PromptBuilder.build()` context (around line 410):
```typescript
  const promptResult = promptBuilder.build({
    // ... existing fields ...
    replyOptional: config.replyOptional ?? false,
  });
```

**Step 6: Run all tests**

Run: `npx vitest run`
Expected: All tests PASS

**Step 7: Commit**

```bash
git add src/agent/prompt/types.ts src/agent/prompt/modules/reply-gate.ts src/agent/prompt/builder.ts src/agent/runner.ts tests/agent/prompt/modules/reply-gate.test.ts
git commit -m "feat: add ReplyGateModule — LLM can choose not to reply when not @mentioned"
```

---

### Task 7: Add parseStdinPayload test for replyOptional

**Files:**
- Modify: test file that covers `parseStdinPayload` (check `tests/agent/runner.test.ts` or similar)

**Step 1: Find existing test file**

Run: `npx vitest run --reporter=verbose 2>&1 | grep -i parseStdin`
Or search: `grep -r "parseStdinPayload" tests/`

**Step 2: Write the test**

```typescript
test('parseStdinPayload extracts replyOptional', () => {
  const payload = parseStdinPayload(JSON.stringify({
    message: 'hello',
    history: [],
    taintRatio: 0,
    taintThreshold: 0.3,
    profile: 'balanced',
    sandboxType: 'subprocess',
    replyOptional: true,
  }));
  expect(payload.replyOptional).toBe(true);
});

test('parseStdinPayload defaults replyOptional to false', () => {
  const payload = parseStdinPayload(JSON.stringify({
    message: 'hello',
    history: [],
    taintRatio: 0,
    taintThreshold: 0.3,
    profile: 'balanced',
    sandboxType: 'subprocess',
  }));
  expect(payload.replyOptional).toBe(false);
});
```

**Step 3: Run test**

Run: `npx vitest run tests/agent/runner.test.ts`
Expected: PASS (implementation already done in Task 6)

**Step 4: Commit**

```bash
git add tests/agent/runner.test.ts
git commit -m "test: add parseStdinPayload tests for replyOptional field"
```

---

### Task 8: Integration test — full channel message flow with eyes emoji and thread gating

**Files:**
- Create or modify: `tests/host/server-channel.test.ts` (or add to existing `server.test.ts`)

**Step 1: Write integration tests**

This test verifies the full flow: message → eyes emoji → processCompletion → remove emoji → send. Use the existing mock patterns from `server.test.ts`.

Key test cases:
1. **Eyes emoji lifecycle**: message arrives → addReaction('eyes') called → response sent → removeReaction('eyes') called
2. **Thread gating drops unknown threads**: thread message with `isMention: false` and no session history → message dropped
3. **Thread gating allows known threads**: thread message with prior conversation store entries → message processed
4. **Empty response skips send**: when processCompletion returns empty → channel.send NOT called, removeReaction still called
5. **Thread backfill on first mention**: `isMention: true` in thread with count===0 → fetchThreadHistory called, messages stored

These tests require mocking the channel provider, ConversationStore, and processCompletion. Implement using the patterns from the existing `server.test.ts`.

**Step 2: Run tests**

Run: `npx vitest run tests/host/server-channel.test.ts`
Expected: PASS

**Step 3: Commit**

```bash
git add tests/host/server-channel.test.ts
git commit -m "test: integration tests for eyes emoji, thread gating, and backfill"
```

---

### Task 9: Final pass — run full test suite and fix any breakage

**Step 1: Run full test suite**

Run: `npm test`
Expected: All tests pass

**Step 2: Fix any failures**

Common issues to watch for:
- Existing `server.test.ts` channel tests may need `isMention` added to mock messages
- `processCompletion` signature change (added `replyOptional` param) — ensure existing callers pass `undefined` or are unaffected by the optional parameter
- Mock `App` class in slack tests needs `reactions` and `conversations` on `client`

**Step 3: Final commit**

```bash
git add -A
git commit -m "fix: resolve test breakage from slack behavior changes"
```

---

## Summary of Changes

| File | What Changed |
|------|-------------|
| `src/providers/channel/types.ts` | `isMention` on InboundMessage; `addReaction`, `removeReaction`, `fetchThreadHistory` on ChannelProvider |
| `src/providers/channel/slack.ts` | Reaction methods, fetchThreadHistory, thread replies via app.message, isMention flag, dedup |
| `src/host/server.ts` | Eyes emoji wrapping, thread gating, thread backfill, replyOptional param |
| `src/agent/runner.ts` | replyOptional in StdinPayload, AgentConfig, parseStdinPayload |
| `src/agent/prompt/types.ts` | replyOptional on PromptContext |
| `src/agent/prompt/modules/reply-gate.ts` | New module — LLM guidance for optional replies |
| `src/agent/prompt/builder.ts` | Register ReplyGateModule |
| Tests | New tests for all features; updated mocks |
