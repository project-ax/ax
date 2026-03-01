# OpenAI-Compatible LLM Provider Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Enable pi-coding-agent to work with OpenAI-compatible LLM providers (Groq, Fireworks, etc.) via the IPC path.

**Architecture:** Add a shared `openai.ts` LLM provider implementation, a `model` config field with `<provider>/<model-id>` convention, and thread the model ID from config through the host→agent pipeline. Provider name passed at creation time determines credentials and base URL.

**Tech Stack:** TypeScript, OpenAI SDK (`openai` npm package), Vitest for testing.

**Design Doc:** `docs/plans/2026-02-20-openai-provider-design.md`

---

### Task 1: Install OpenAI SDK dependency

**Files:**
- Modify: `package.json`

**Step 1: Install the OpenAI SDK**

Run: `npm install openai`

**Step 2: Verify installation**

Run: `node -e "require('openai')"`
Expected: No error

**Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: add openai SDK dependency"
```

---

### Task 2: Add `model` field to Config

**Files:**
- Modify: `src/types.ts:33` (Config interface)
- Modify: `src/config.ts:26-63` (ConfigSchema)
- Test: `tests/config.test.ts` (if exists, otherwise skip)

**Step 1: Write the failing test**

Check if `tests/config.test.ts` exists. If so, add:

```typescript
test('accepts optional model field', () => {
  // Write a minimal valid config YAML with model field, parse it, assert config.model is set
});

test('model field is optional (backward compat)', () => {
  // Write a minimal valid config YAML without model field, parse it, assert config.model is undefined
});
```

If no config test file exists, create `tests/config.test.ts` with these tests.

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/config.test.ts`
Expected: FAIL — `model` not recognized by strict schema

**Step 3: Add `model` to Config type**

In `src/types.ts`, add to the `Config` interface:

```typescript
export interface Config {
  agent?: AgentType;
  model?: string;          // <-- ADD THIS LINE
  max_tokens?: number;
  // ... rest unchanged
```

**Step 4: Add `model` to ConfigSchema**

In `src/config.ts`, add to the `ConfigSchema` z.strictObject:

```typescript
const ConfigSchema = z.strictObject({
  agent: z.enum(AGENT_TYPES).optional().default('pi-agent-core'),
  model: z.string().optional(),   // <-- ADD THIS LINE
  profile: z.enum(PROFILE_NAMES),
  // ... rest unchanged
```

**Step 5: Run test to verify it passes**

Run: `npx vitest run tests/config.test.ts`
Expected: PASS

**Step 6: Commit**

```bash
git add src/types.ts src/config.ts tests/config.test.ts
git commit -m "feat: add optional model field to Config"
```

---

### Task 3: Add `groq` to provider map

**Files:**
- Modify: `src/host/provider-map.ts:13-18` (PROVIDER_MAP.llm)
- Test: existing provider-map tests or inline verification

**Step 1: Write the failing test**

Create or update `tests/host/provider-map.test.ts`:

```typescript
import { resolveProviderPath } from '../../src/host/provider-map.js';

test('resolves groq to openai provider module', () => {
  expect(resolveProviderPath('llm', 'groq')).toBe('../providers/llm/openai.js');
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/host/provider-map.test.ts`
Expected: FAIL — `Unknown llm provider: "groq"`

**Step 3: Add groq entry**

In `src/host/provider-map.ts`, add `groq` to the `llm` section:

```typescript
llm: {
  anthropic: '../providers/llm/anthropic.js',
  openai:    '../providers/llm/openai.js',
  groq:      '../providers/llm/openai.js',
  multi:     '../providers/llm/multi.js',
  mock:      '../providers/llm/mock.js',
},
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/host/provider-map.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/host/provider-map.ts tests/host/provider-map.test.ts
git commit -m "feat: add groq LLM provider to allowlist"
```

---

### Task 4: Pass provider name to create() in registry

**Files:**
- Modify: `src/host/registry.ts:28-39` (loadProvider function)
- Test: `tests/host/registry.test.ts` (if exists)

**Step 1: Write the failing test**

This is a small change — the `loadProvider` function needs to pass the provider `name` as a second argument to `mod.create()`. Since `create()` already accepts it optionally and existing providers ignore it, we can test this by verifying the call signature.

If `tests/host/registry.test.ts` exists, add a test. Otherwise, this change is tested indirectly by the integration test in Task 7.

**Step 2: Modify loadProvider**

In `src/host/registry.ts`, change line 38:

```typescript
// Before:
return mod.create(config);

// After:
return mod.create(config, name);
```

The full function becomes:

```typescript
async function loadProvider(kind: string, name: string, config: Config) {
  const modulePath = resolveProviderPath(kind, name);
  const mod = await import(modulePath);

  if (typeof mod.create !== 'function') {
    throw new Error(
      `Provider ${kind}/${name} (${modulePath}) does not export a create() function`
    );
  }

  return mod.create(config, name);
}
```

**Step 3: Run full test suite to verify no regressions**

Run: `npx vitest run`
Expected: All existing tests PASS (existing providers ignore the second argument)

**Step 4: Commit**

```bash
git add src/host/registry.ts
git commit -m "feat: pass provider name to create() for provider-specific config"
```

---

### Task 5: Create the OpenAI-compatible LLM provider

**Files:**
- Create: `src/providers/llm/openai.ts`
- Create: `tests/providers/llm/openai.test.ts`

**Step 1: Write the failing tests**

Create `tests/providers/llm/openai.test.ts`:

```typescript
import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { create } from '../../../src/providers/llm/openai.js';
import type { Config } from '../../../src/types.js';

const config = {} as Config;

describe('openai LLM provider', () => {
  let savedApiKey: string | undefined;
  let savedBaseUrl: string | undefined;

  beforeEach(() => {
    savedApiKey = process.env.GROQ_API_KEY;
    savedBaseUrl = process.env.GROQ_BASE_URL;
    delete process.env.GROQ_API_KEY;
    delete process.env.GROQ_BASE_URL;
  });

  afterEach(() => {
    if (savedApiKey !== undefined) process.env.GROQ_API_KEY = savedApiKey;
    else delete process.env.GROQ_API_KEY;
    if (savedBaseUrl !== undefined) process.env.GROQ_BASE_URL = savedBaseUrl;
    else delete process.env.GROQ_BASE_URL;
  });

  test('returns provider with correct name', async () => {
    const provider = await create(config, 'groq');
    expect(provider.name).toBe('groq');
  });

  test('stub chat() throws when no API key', async () => {
    const provider = await create(config, 'groq');
    const iter = provider.chat({ model: 'test', messages: [] });
    await expect(iter.next()).rejects.toThrow('GROQ_API_KEY');
  });

  test('defaults to openai when no provider name given', async () => {
    const provider = await create(config);
    expect(provider.name).toBe('openai');
  });

  test('uses default base URL for known providers', async () => {
    process.env.GROQ_API_KEY = 'test-key';
    const provider = await create(config, 'groq');
    expect(provider.name).toBe('groq');
    // Provider created successfully (doesn't throw at creation time)
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/providers/llm/openai.test.ts`
Expected: FAIL — module not found

**Step 3: Implement the OpenAI provider**

Create `src/providers/llm/openai.ts`:

```typescript
import OpenAI from 'openai';
import type { LLMProvider, ChatRequest, ChatChunk } from './types.js';
import type { Config, ContentBlock } from '../../types.js';
import { getLogger } from '../../logger.js';

const logger = getLogger().child({ component: 'openai-compat' });

/** Default base URLs for known OpenAI-compatible providers. */
const DEFAULT_BASE_URLS: Record<string, string> = {
  openai: 'https://api.openai.com/v1',
  groq: 'https://api.groq.com/openai/v1',
  fireworks: 'https://api.fireworks.ai/inference/v1',
};

/**
 * Convert AX Message[] to OpenAI chat completion message format.
 *
 * Handles:
 * - String content (system, user, assistant) → pass through
 * - ContentBlock[] with tool_use → assistant message with tool_calls
 * - ContentBlock[] with tool_result → tool role messages
 */
function toOpenAIMessages(
  messages: ChatRequest['messages'],
): OpenAI.ChatCompletionMessageParam[] {
  const result: OpenAI.ChatCompletionMessageParam[] = [];

  for (const msg of messages) {
    if (typeof msg.content === 'string') {
      result.push({
        role: msg.role as 'system' | 'user' | 'assistant',
        content: msg.content,
      });
      continue;
    }

    // ContentBlock array — may contain text, tool_use, or tool_result blocks
    const blocks = msg.content as ContentBlock[];

    // Collect text blocks
    const textParts = blocks.filter(b => b.type === 'text').map(b => b.text);

    // Collect tool_use blocks → assistant message with tool_calls
    const toolUseBlocks = blocks.filter(b => b.type === 'tool_use');
    if (toolUseBlocks.length > 0) {
      result.push({
        role: 'assistant',
        content: textParts.join('') || null,
        tool_calls: toolUseBlocks.map(b => ({
          id: b.id,
          type: 'function' as const,
          function: {
            name: b.name,
            arguments: JSON.stringify(b.input),
          },
        })),
      });
      continue;
    }

    // Collect tool_result blocks → individual tool messages
    const toolResults = blocks.filter(b => b.type === 'tool_result');
    if (toolResults.length > 0) {
      for (const tr of toolResults) {
        result.push({
          role: 'tool',
          tool_call_id: tr.tool_use_id,
          content: tr.content,
        });
      }
      continue;
    }

    // Plain text blocks → user or assistant message
    if (textParts.length > 0) {
      result.push({
        role: msg.role as 'user' | 'assistant',
        content: textParts.join(''),
      });
    }
  }

  return result;
}

export async function create(config: Config, providerName?: string): Promise<LLMProvider> {
  const name = providerName ?? 'openai';
  const envPrefix = name.toUpperCase();
  const apiKey = process.env[`${envPrefix}_API_KEY`];
  const baseURL = process.env[`${envPrefix}_BASE_URL`] ?? DEFAULT_BASE_URLS[name];

  if (!apiKey) {
    return {
      name,
      async *chat(): AsyncIterable<ChatChunk> {
        throw new Error(
          `${envPrefix}_API_KEY environment variable is required.\n` +
          `Set it with: export ${envPrefix}_API_KEY=...`,
        );
      },
      async models() { return []; },
    };
  }

  const client = new OpenAI({ apiKey, baseURL });

  return {
    name,

    async *chat(req: ChatRequest): AsyncIterable<ChatChunk> {
      const messages = toOpenAIMessages(req.messages);
      const tools = req.tools?.map(t => ({
        type: 'function' as const,
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        },
      }));

      const maxTokens = req.maxTokens ?? 4096;
      logger.debug('chat_start', {
        provider: name,
        model: req.model,
        maxTokens,
        toolCount: tools?.length ?? 0,
        messageCount: messages.length,
      });

      const stream = await client.chat.completions.create({
        model: req.model,
        messages,
        ...(tools?.length ? { tools } : {}),
        max_tokens: maxTokens,
        stream: true,
      });

      // Accumulate tool call deltas (OpenAI streams them incrementally)
      const toolCallAccum = new Map<number, { id: string; name: string; args: string }>();
      let inputTokens = 0;
      let outputTokens = 0;

      for await (const chunk of stream) {
        const choice = chunk.choices[0];
        if (!choice) continue;

        // Text content
        if (choice.delta?.content) {
          yield { type: 'text', content: choice.delta.content };
        }

        // Tool call deltas
        if (choice.delta?.tool_calls) {
          for (const tc of choice.delta.tool_calls) {
            const existing = toolCallAccum.get(tc.index);
            if (!existing) {
              toolCallAccum.set(tc.index, {
                id: tc.id ?? '',
                name: tc.function?.name ?? '',
                args: tc.function?.arguments ?? '',
              });
            } else {
              if (tc.id) existing.id = tc.id;
              if (tc.function?.name) existing.name += tc.function.name;
              if (tc.function?.arguments) existing.args += tc.function.arguments;
            }
          }
        }

        // Usage info (OpenAI sends it on the final chunk)
        if (chunk.usage) {
          inputTokens = chunk.usage.prompt_tokens;
          outputTokens = chunk.usage.completion_tokens;
        }

        // Finish — yield accumulated tool calls, then done
        if (choice.finish_reason) {
          for (const [, tc] of toolCallAccum) {
            let args: Record<string, unknown> = {};
            try { args = JSON.parse(tc.args); } catch { /* malformed args */ }
            yield {
              type: 'tool_use',
              toolCall: { id: tc.id, name: tc.name, args },
            };
          }

          logger.debug('chat_done', {
            provider: name,
            finishReason: choice.finish_reason,
            toolCalls: toolCallAccum.size,
            inputTokens,
            outputTokens,
          });

          yield {
            type: 'done',
            usage: { inputTokens, outputTokens },
          };
        }
      }
    },

    async models(): Promise<string[]> {
      return [];
    },
  };
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/providers/llm/openai.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/providers/llm/openai.ts tests/providers/llm/openai.test.ts
git commit -m "feat: add OpenAI-compatible LLM provider"
```

---

### Task 6: Thread model ID from config to agent runner

This is the plumbing task — model ID needs to flow from `ax.yaml` through the host server to the agent process.

**Files:**
- Modify: `src/agent/runner.ts:63-80` (AgentConfig interface)
- Modify: `src/agent/runner.ts:194-234` (parseArgs function)
- Modify: `src/agent/runners/pi-session.ts:47-75` (createIPCModel, createProxyModel)
- Modify: `src/host/server.ts:518-528` (spawnCommand)

**Step 1: Add `model` to AgentConfig**

In `src/agent/runner.ts`, add to the `AgentConfig` interface (around line 63):

```typescript
export interface AgentConfig {
  agent?: AgentType;
  model?: string;          // <-- ADD: e.g. 'moonshotai/kimi-k2-instruct-0905'
  ipcSocket: string;
  // ... rest unchanged
```

**Step 2: Add `--model` CLI arg parsing**

In `src/agent/runner.ts` `parseArgs()` function (around line 194), add:

```typescript
let model = '';
// ... in the switch:
case '--model': model = args[++i]; break;
// ... in the return:
model: model || undefined,
```

**Step 3: Pass model from server to agent spawn command**

In `src/host/server.ts`, around line 518-528 where `spawnCommand` is built, add the model argument. The model ID needs to come from `config.model` with the provider prefix stripped:

```typescript
// Parse model: strip provider prefix (e.g., 'groq/moonshotai/kimi-k2' → 'moonshotai/kimi-k2')
const modelId = config.model
  ? config.model.includes('/') ? config.model.slice(config.model.indexOf('/') + 1) : config.model
  : undefined;

const spawnCommand = [tsxBin, resolve('src/agent/runner.ts'),
  '--agent', agentType,
  '--ipc-socket', ipcSocketPath,
  '--workspace', workspace,
  '--skills', wsSkillsDir,
  '--max-tokens', String(maxTokens),
  '--agent-dir', agentDirVal,
  ...(modelId ? ['--model', modelId] : []),
  ...(proxySocketPath ? ['--proxy-socket', proxySocketPath] : []),
  ...(opts.verbose ? ['--verbose'] : []),
];
```

**Step 4: Use model ID in pi-session runner**

In `src/agent/runners/pi-session.ts`, modify `createIPCModel` and `createProxyModel` to accept model ID:

```typescript
function createIPCModel(maxTokens?: number, modelId?: string): Model<any> {
  return {
    id: modelId ?? 'claude-sonnet-4-5-20250929',
    name: modelId ? `${modelId} (via IPC)` : 'Claude Sonnet 4.5 (via IPC)',
    // ... rest unchanged
  };
}

function createProxyModel(maxTokens?: number, modelId?: string): Model<any> {
  return {
    id: modelId ?? 'claude-sonnet-4-5-20250929',
    name: modelId ? `${modelId} (via proxy)` : 'Claude Sonnet 4.5 (via proxy)',
    // ... rest unchanged
  };
}
```

Then in `runPiSession()` (around line 447):

```typescript
const activeModel = useProxy
  ? createProxyModel(config.maxTokens, config.model)
  : createIPCModel(config.maxTokens, config.model);
```

**Step 5: Also update runner.ts pi-core path**

In `src/agent/runner.ts`, update `createDefaultModel` similarly:

```typescript
function createDefaultModel(maxTokens?: number, modelId?: string): Model<any> {
  return {
    id: modelId ?? DEFAULT_MODEL_ID,
    name: modelId ?? 'Claude Sonnet 4.5',
    // ... rest unchanged
  };
}
```

And in `runPiCore()` (around line 442):

```typescript
const model = createDefaultModel(config.maxTokens, config.model);
```

**Step 6: Run existing tests to verify no regressions**

Run: `npx vitest run`
Expected: All existing tests PASS (model defaults to claude-sonnet when not set)

**Step 7: Commit**

```bash
git add src/agent/runner.ts src/agent/runners/pi-session.ts src/host/server.ts
git commit -m "feat: thread model ID from config through host to agent runner"
```

---

### Task 7: Integration test — OpenAI provider through IPC

Test the full flow: mock OpenAI HTTP server → OpenAI provider → IPC → pi-session runner.

**Files:**
- Create: `tests/providers/llm/openai-integration.test.ts`

**Step 1: Write the integration test**

```typescript
import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { create } from '../../../src/providers/llm/openai.js';
import type { Config } from '../../../src/types.js';

const config = {} as Config;

/**
 * Create mock OpenAI-compatible API server that returns SSE streaming responses.
 */
function createMockOpenAIServer(port: number): Promise<HttpServer> {
  return new Promise((resolve) => {
    const server = createHttpServer(async (req: IncomingMessage, res: ServerResponse) => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const body = JSON.parse(Buffer.concat(chunks).toString());

      res.writeHead(200, { 'Content-Type': 'text/event-stream' });

      // Simple text response
      res.write(`data: ${JSON.stringify({
        id: 'chatcmpl-test', object: 'chat.completion.chunk',
        choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
      })}\n\n`);

      res.write(`data: ${JSON.stringify({
        id: 'chatcmpl-test', object: 'chat.completion.chunk',
        choices: [{ index: 0, delta: { content: 'Hello from mock!' }, finish_reason: null }],
      })}\n\n`);

      res.write(`data: ${JSON.stringify({
        id: 'chatcmpl-test', object: 'chat.completion.chunk',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      })}\n\n`);

      res.write('data: [DONE]\n\n');
      res.end();
    });
    server.listen(port, () => resolve(server));
  });
}

describe('openai provider integration', () => {
  let server: HttpServer;
  let savedKey: string | undefined;
  let savedUrl: string | undefined;
  const PORT = 18923;

  beforeEach(async () => {
    savedKey = process.env.GROQ_API_KEY;
    savedUrl = process.env.GROQ_BASE_URL;
    process.env.GROQ_API_KEY = 'test-key';
    process.env.GROQ_BASE_URL = `http://localhost:${PORT}/v1`;
    server = await createMockOpenAIServer(PORT);
  });

  afterEach(async () => {
    if (savedKey !== undefined) process.env.GROQ_API_KEY = savedKey;
    else delete process.env.GROQ_API_KEY;
    if (savedUrl !== undefined) process.env.GROQ_BASE_URL = savedUrl;
    else delete process.env.GROQ_BASE_URL;
    await new Promise<void>((r) => server.close(() => r()));
  });

  test('streams text response from mock server', async () => {
    const provider = await create(config, 'groq');
    const chunks = [];
    for await (const chunk of provider.chat({
      model: 'moonshotai/kimi-k2-instruct-0905',
      messages: [{ role: 'user', content: 'hello' }],
    })) {
      chunks.push(chunk);
    }

    expect(chunks.some(c => c.type === 'text' && c.content === 'Hello from mock!')).toBe(true);
    expect(chunks.some(c => c.type === 'done')).toBe(true);
  });
});
```

**Step 2: Run test**

Run: `npx vitest run tests/providers/llm/openai-integration.test.ts`
Expected: PASS

**Step 3: Commit**

```bash
git add tests/providers/llm/openai-integration.test.ts
git commit -m "test: add OpenAI provider integration test with mock server"
```

---

### Task 8: Update ax.yaml and verify full pipeline

**Files:**
- Modify: `ax.yaml`

**Step 1: Run the full test suite**

Run: `npx vitest run`
Expected: All tests PASS

**Step 2: Verify `ax.yaml` can use the new config**

No code test needed — this is a manual verification step. Update `ax.yaml` for testing:

```yaml
agent: pi-coding-agent
model: groq/moonshotai/kimi-k2-instruct-0905
profile: paranoid
providers:
  llm: groq
  # ... rest unchanged
```

**Step 3: Verify config loads**

Run: `node -e "import('./src/config.js').then(m => console.log(JSON.stringify(m.loadConfig(), null, 2)))"`
Expected: Config object with `model: 'groq/moonshotai/kimi-k2-instruct-0905'`

**Step 4: Revert ax.yaml** (don't commit changed config to main)

Revert `ax.yaml` back to `anthropic` defaults — the model/provider change is per-deployment, not a repo default.

**Step 5: Final commit**

```bash
git add -A
git commit -m "feat: OpenAI-compatible LLM provider with model config support

Adds:
- src/providers/llm/openai.ts — shared provider for Groq, Fireworks, etc.
- model field in ax.yaml config (provider/model-id convention)
- Model ID threading from config through host to agent runner
- groq entry in provider allowlist

Usage:
  model: groq/moonshotai/kimi-k2-instruct-0905
  providers.llm: groq
  GROQ_API_KEY=gsk_... npm start"
```

---

## Manual Smoke Test (Post-Implementation)

After all tasks are done, test with real Groq API:

```bash
export GROQ_API_KEY=gsk_...
# Edit ax.yaml: model: groq/moonshotai/kimi-k2-instruct-0905, providers.llm: groq
npm start
# Send a test message and verify the agent responds using Kimi via Groq
```

---

## Summary of Changes

| File | Change |
|------|--------|
| `package.json` | Add `openai` dependency |
| `src/types.ts` | Add `model?: string` to `Config` |
| `src/config.ts` | Add `model` to `ConfigSchema` |
| `src/host/provider-map.ts` | Add `groq` entry |
| `src/host/registry.ts` | Pass provider name to `create()` |
| `src/providers/llm/openai.ts` | **NEW** — OpenAI-compatible provider |
| `src/agent/runner.ts` | Add `model` to `AgentConfig`, `--model` CLI arg, thread to model creation |
| `src/agent/runners/pi-session.ts` | Accept model ID in `createIPCModel`/`createProxyModel` |
| `src/host/server.ts` | Pass model ID (prefix-stripped) to agent spawn command |
| `tests/providers/llm/openai.test.ts` | **NEW** — Unit tests |
| `tests/providers/llm/openai-integration.test.ts` | **NEW** — Integration test |
| `tests/host/provider-map.test.ts` | Test groq resolution |
| `tests/config.test.ts` | Test model field parsing |
