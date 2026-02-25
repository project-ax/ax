---
name: ax-provider-llm
description: Use when modifying LLM providers — Anthropic, OpenAI, multi-model router, or mock provider in src/providers/llm/
---

## Overview

LLM providers implement streaming chat completions with tool use via the `LLMProvider` interface. Each provider exports a `create(config: Config)` factory and is registered in the static allowlist at `src/host/provider-map.ts`.

## Interface

```typescript
// src/providers/llm/types.ts
interface ChatRequest {
  model: string;
  messages: Message[];
  tools?: ToolDef[];
  maxTokens?: number;
  stream?: boolean;
}

interface ChatChunk {
  type: 'text' | 'tool_use' | 'done';
  content?: string;
  toolCall?: { id: string; name: string; args: Record<string, unknown> };
  usage?: { inputTokens: number; outputTokens: number };
}

interface LLMProvider {
  name: string;
  chat(req: ChatRequest): AsyncIterable<ChatChunk>;
  models(): Promise<string[]>;
}
```

## Implementations

| Name | File | Description |
|------|------|-------------|
| Anthropic | `src/providers/llm/anthropic.ts` | Production provider using `@anthropic-ai/sdk`; OAuth-aware with proxy stub fallback |
| OpenAI | `src/providers/llm/openai.ts` | Planned; registered in provider-map but not yet implemented |
| Multi | `src/providers/llm/multi.ts` | Planned; model routing and failover; registered in provider-map but not yet implemented |
| Mock | `src/providers/llm/mock.ts` | Canned responses for testing; keyword-matched replies, fixed usage stats |

## Anthropic Provider

- Reads `ANTHROPIC_API_KEY` and `CLAUDE_CODE_OAUTH_TOKEN` from env.
- If OAuth token is set without an API key, returns a stub -- agents route LLM calls through the credential-injecting proxy (`src/host/proxy.ts`) instead.
- Streams via `client.messages.stream()` (SSE). Yields `text` chunks on `content_block_delta`, `tool_use` chunks on `content_block_stop`, and a final `done` chunk with usage.
- System messages are extracted and passed as the `system` parameter; remaining messages are mapped to Anthropic's role format.
- Default model: `claude-sonnet-4-20250514`. Default max tokens: 4096.

## Mock Provider

- Returns canned strings based on keyword matching (`hello`, `remember`).
- Always yields exactly two chunks: one `text`, one `done`.
- No external dependencies -- safe for unit and integration tests.

## Common Tasks: Adding a New LLM Provider

1. Create `src/providers/llm/<name>.ts` exporting `create(config: Config): Promise<LLMProvider>`.
2. Implement `chat()` as an `async *` generator yielding `ChatChunk` objects (`text` -> `tool_use` -> `done`).
3. Implement `models()` returning supported model IDs.
4. Add the entry to the static allowlist in `src/host/provider-map.ts`.
5. Add tests in `tests/providers/llm/<name>.test.ts`.
6. Use `safePath()` if the provider reads any files from config-derived paths.

## Gotchas

- **Streaming contract:** `chat()` returns `AsyncIterable<ChatChunk>`, not a Promise. Always implement as `async *chat()`.
- **Credentials stay host-side:** API keys are never passed into agent containers. Agents use either the credential-injecting proxy (`src/host/proxy.ts` over TCP) or IPC fallback -- never direct SDK calls.
- **Agent LLM calls route through IPC or proxy:** The agent runner (`src/agent/runner.ts`) decides transport. The host-side provider is only used directly for non-agent contexts.
- **Provider map is a static allowlist:** No dynamic imports from config values (SC-SEC-002). Every provider must be explicitly listed.
- **Final `done` chunk is required:** Always yield a `done` chunk with `usage` as the last item -- consumers depend on it to finalize the response.
