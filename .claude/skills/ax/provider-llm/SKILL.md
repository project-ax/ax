---
name: ax-provider-llm
description: Use when modifying LLM providers — Anthropic, OpenAI, multi-model router, traced wrapper, or mock provider in src/providers/llm/
---

## Overview

LLM providers implement streaming chat completions with tool use and advanced features (thinking/reasoning, vision) via the `LLMProvider` interface. Each provider exports a `create(config: Config)` factory and is registered in the static allowlist at `src/host/provider-map.ts`. Requests include optional task-type hints (`default`, `fast`, `thinking`, `coding`) for router-based model selection.

## Interface

```typescript
// src/providers/llm/types.ts
type ResolveImageFile = (fileId: string) => Promise<{ data: Buffer; mimeType: string } | null>;

interface ChatRequest {
  model: string;
  messages: Message[];
  tools?: ToolDef[];
  maxTokens?: number;
  stream?: boolean;
  taskType?: LLMTaskType;      // Task type hint for router model selection
  sessionId?: string;           // Tracing backends (e.g. Langfuse session grouping)
  resolveImageFile?: ResolveImageFile; // Resolves image fileId references to binary data
}

interface ChatChunk {
  type: 'text' | 'thinking' | 'tool_use' | 'done';
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
| Anthropic | `src/providers/llm/anthropic.ts` | Production provider using `@anthropic-ai/sdk`; OAuth-aware with proxy stub fallback; supports vision and thinking |
| OpenAI | `src/providers/llm/openai.ts` | OpenAI-compatible provider for OpenAI, Groq, OpenRouter, Fireworks, DeepInfra; supports reasoning/thinking and tool use |
| Router | `src/providers/llm/router.ts` | Multi-model router dispatching based on task type; per-provider cooldown and fallback chains |
| Traced | `src/providers/llm/traced.ts` | OpenTelemetry-instrumented wrapper; decorates any LLMProvider with span tracking |
| Mock | `src/providers/llm/mock.ts` | Canned responses for testing; keyword-matched replies, fixed usage stats |

## Anthropic Provider

- Reads `ANTHROPIC_API_KEY` and `CLAUDE_CODE_OAUTH_TOKEN` from env.
- If OAuth token is set without an API key, returns a stub -- agents route LLM calls through the credential-injecting proxy.
- Streams via `client.messages.stream()` (SSE). Yields `text` and `thinking` chunks on `content_block_delta`, `tool_use` chunks on `content_block_stop`, and a final `done` chunk with usage.
- **Vision support:** ContentBlocks with `type: 'image_data'` (inline base64) or `type: 'image'` (file reference) are resolved via `resolveImageFile` callback and sent as base64 images to the API.
- **Thinking events:** Yields `{ type: 'thinking', content }` chunks from `thinking` deltas.
- **Delta casting:** Casts `event.delta` through `unknown` to extract both `text` and `thinking` properties safely.
- Default model: `claude-sonnet-4-20250514`. Default max tokens: 4096.

## OpenAI Provider

- Reads `OPENAI_API_KEY` (or `GROQ_API_KEY`, `OPENROUTER_API_KEY`, `FIREWORKS_API_KEY`, `DEEPINFRA_API_KEY` for compatible providers).
- Supports OpenAI-compatible providers via base URL resolution from `src/utils/openai-compat.ts` (shared `DEFAULT_BASE_URLS`, `envKey()`, `resolveBaseUrl()` helpers).
- **Thinking events:** Extracts `reasoning_content` or `reasoning` from delta and yields as `{ type: 'thinking', content }` chunks.
- **Delta casting:** Casts delta through `unknown` to safely access non-standard fields.
- Accumulates tool call deltas by index and yields tool_use chunks on stream finish.

## LLM Router

- **Location:** `src/providers/llm/router.ts`
- **Task types:** `'default'`, `'fast'`, `'thinking'`, `'coding'` (from `LLM_TASK_TYPES` in `src/types.ts`).
- **Config:** `config.models` keyed by task type; each value is an array of compound `provider/model` IDs.
- **Parsing:** Uses `parseCompoundId()` from `src/providers/router-utils.ts` to split on first `/`.
- **Dispatch:** Resolves `req.taskType` to candidate chain (or defaults to 'default').
- **Fallback loop:** Tries candidates in order, skipping cooled-down providers. Exponential backoff (30s-5m) on retryable errors; permanent errors (4xx, auth) skip-to-next.
- **Cooldown tracking:** In-memory per-provider state; resets on success or restart.

## Traced Provider Wrapper

- **Location:** `src/providers/llm/traced.ts`
- Decorates any LLMProvider with OpenTelemetry instrumentation.
- Each `chat()` call creates a `gen_ai.chat` span with attributes for model, max_tokens, session ID, and tool metadata.
- Logs input messages as span events, accumulates output, emits `gen_ai.assistant.message` and `gen_ai.tool.call` events.
- Records token usage in span attributes. No-op overhead when tracer is not registered.

## Router Utilities

- **Location:** `src/providers/router-utils.ts`
- `parseCompoundId(id: string): ModelCandidate` -- splits compound IDs on first `/`.
- Extracted from llm/router.ts to avoid circular imports (image/router.ts also needs this).

## Shared Provider Types

- **Location:** `src/providers/shared-types.ts`
- Re-export hub for types used across multiple provider categories (channel, memory, audit).
- Prevents cross-provider directory imports.

## Mock Provider

- Canned strings based on keyword matching (`hello`, `remember`, default greeting).
- Always yields exactly two chunks: one `text`, one `done`.

## Common Tasks: Adding a New LLM Provider

1. Create `src/providers/llm/<name>.ts` exporting `create(config: Config): Promise<LLMProvider>`.
2. Implement `chat()` as an `async *` generator yielding `ChatChunk` objects (`text` -> `thinking` -> `tool_use` -> `done`).
3. Implement `models()` returning supported model IDs.
4. Add the entry to the static allowlist in `src/host/provider-map.ts`.
5. Add tests in `tests/providers/llm/<name>.test.ts`.
6. Use `safePath()` if the provider reads any files from config-derived paths.

## Common Tasks: Adding Image/Thinking Support

- **Image support:** Accept `resolveImageFile` from `ChatRequest`. Check `message.content` for `type: 'image'` or `type: 'image_data'` blocks. Resolve file references via callback. Convert to provider-native format.
- **Thinking support:** Check deltas for `thinking` or `reasoning_content` properties. Cast delta through `unknown` first. Yield `{ type: 'thinking', content }` chunks.

## Gotchas

- **Streaming contract:** `chat()` returns `AsyncIterable<ChatChunk>`, not a Promise. Always implement as `async *chat()`.
- **Task type defaults:** If `req.taskType` is unset, router falls back to `'default'`. Ensure `config.models.default` always exists.
- **Credentials stay host-side:** API keys never enter agent containers. Agents use proxy or IPC.
- **Provider map is a static allowlist:** No dynamic imports from config values (SC-SEC-002).
- **Final `done` chunk is required:** Always yield a `done` chunk with `usage` as the last item.
- **Thinking chunks are optional:** Not all models support thinking; consumers gracefully handle missing thinking events.
- **Delta casting for non-standard fields:** Always cast delta through `unknown` when accessing `thinking`, `reasoning_content`, etc.
- **Router cooldown is in-memory:** Resets on server restart.
