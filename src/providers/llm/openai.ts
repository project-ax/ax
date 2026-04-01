import OpenAI from 'openai';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import type { LLMProvider, ChatRequest, ChatChunk } from './types.js';
import type { Config, ContentBlock, Message } from '../../types.js';
import { getLogger } from '../../logger.js';
import { envKey, envBaseUrl, resolveBaseUrl } from '../../utils/openai-compat.js';

const logger = getLogger().child({ component: 'openai-compat' });

// ───────────────────────────────────────────────────────
// Message format translation (AX -> OpenAI)
// ───────────────────────────────────────────────────────

/** Convert AX Message to one or more OpenAI ChatCompletionMessageParams.
 *  A single AX Message with multiple tool_result blocks expands to multiple
 *  OpenAI tool messages (one per result). Use with flatMap(). */
function toOpenAIMessages(msg: Message): ChatCompletionMessageParam[] {
  // String content — pass through directly
  if (typeof msg.content === 'string') {
    if (msg.role === 'system') {
      return [{ role: 'system', content: msg.content }];
    }
    if (msg.role === 'assistant') {
      return [{ role: 'assistant', content: msg.content }];
    }
    return [{ role: 'user', content: msg.content }];
  }

  // ContentBlock[] — need to inspect block types
  const blocks = msg.content as ContentBlock[];

  // tool_result blocks -> individual OpenAI tool messages
  const toolResults = blocks.filter(b => b.type === 'tool_result');
  if (toolResults.length > 0) {
    return toolResults.map(b => {
      const tr = b as Extract<ContentBlock, { type: 'tool_result' }>;
      return {
        role: 'tool' as const,
        tool_call_id: tr.tool_use_id,
        content: tr.content || '[no output]',
      };
    });
  }

  // tool_use blocks -> OpenAI assistant message with tool_calls
  const toolUses = blocks.filter(b => b.type === 'tool_use');
  if (toolUses.length > 0) {
    const textParts = blocks
      .filter(b => b.type === 'text')
      .map(b => (b as Extract<ContentBlock, { type: 'text' }>).text)
      .join('');

    return [{
      role: 'assistant',
      content: textParts || null,
      tool_calls: toolUses.map(b => {
        const tu = b as Extract<ContentBlock, { type: 'tool_use' }>;
        return {
          id: tu.id,
          type: 'function' as const,
          function: {
            name: tu.name,
            arguments: JSON.stringify(tu.input),
          },
        };
      }),
    }];
  }

  // Check for media blocks (image_data, file_data) — build multipart content for user messages
  const hasMedia = blocks.some(b => b.type === 'image_data' || b.type === 'file_data');

  if (hasMedia && msg.role === 'user') {
    const parts: Array<{ type: string; [k: string]: unknown }> = [];
    for (const b of blocks) {
      if (b.type === 'text') {
        parts.push({ type: 'text', text: (b as Extract<ContentBlock, { type: 'text' }>).text });
      } else if (b.type === 'image_data') {
        const ib = b as Extract<ContentBlock, { type: 'image_data' }>;
        parts.push({
          type: 'image_url',
          image_url: { url: `data:${ib.mimeType};base64,${ib.data}` },
        });
      } else if (b.type === 'file_data') {
        const fb = b as Extract<ContentBlock, { type: 'file_data' }>;
        // Use OpenAI file content part for PDFs and documents
        parts.push({
          type: 'file',
          file: {
            file_data: `data:${fb.mimeType};base64,${fb.data}`,
            filename: fb.filename,
          },
        });
      }
    }
    return [{ role: 'user', content: parts } as any];
  }

  // Plain text ContentBlock[] — join text parts
  const text = blocks
    .filter(b => b.type === 'text')
    .map(b => (b as Extract<ContentBlock, { type: 'text' }>).text)
    .join('');

  if (msg.role === 'assistant') {
    return [{ role: 'assistant', content: text || '.' }];
  }
  if (msg.role === 'system') {
    return [{ role: 'system', content: text || '.' }];
  }
  return [{ role: 'user', content: text || '.' }];
}

// ───────────────────────────────────────────────────────
// Provider factory
// ───────────────────────────────────────────────────────

export async function create(config: Config, providerName?: string): Promise<LLMProvider> {
  const name = providerName || 'openai';
  const apiKeyEnv = envKey(name);
  const apiKey = process.env[apiKeyEnv];

  // No API key — return a stub that defers the error to chat() so the
  // server can still start. Same pattern as anthropic.ts.
  if (!apiKey) {
    return {
      name,
      async *chat(): AsyncIterable<ChatChunk> {
        throw new Error(
          `${apiKeyEnv} environment variable is required.\n` +
          `Set it with: export ${apiKeyEnv}=your-api-key`,
        );
      },
      async models() { return []; },
    };
  }

  const baseURL = resolveBaseUrl(name);

  logger.debug('create', { provider: name, baseURL });

  const client = new OpenAI({ apiKey, baseURL });

  return {
    name,

    async *chat(req: ChatRequest): AsyncIterable<ChatChunk> {
      const messages = req.messages.flatMap(toOpenAIMessages);

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
        toolNames: tools?.map(t => t.function.name),
        messageCount: messages.length,
      });

      const stream = await client.chat.completions.create({
        model: req.model,
        max_tokens: maxTokens,
        messages,
        stream: true,
        stream_options: { include_usage: true },
        ...(tools?.length ? { tools, tool_choice: 'auto' as const } : {}),
      });

      // Accumulate tool call deltas. OpenAI streams tool calls incrementally:
      // each delta has an index, and optionally an id/name (first delta) or
      // argument fragments (subsequent deltas).
      const toolCalls: Map<number, { id: string; name: string; args: string }> = new Map();
      let chunkCount = 0;
      let usage: { inputTokens: number; outputTokens: number } | undefined;

      for await (const chunk of stream) {
        // Usage arrives on the final chunk (when stream_options.include_usage is set)
        if (chunk.usage) {
          usage = {
            inputTokens: chunk.usage.prompt_tokens,
            outputTokens: chunk.usage.completion_tokens,
          };
        }

        const choice = chunk.choices?.[0];
        if (!choice) continue;

        const delta = choice.delta;

        // Reasoning/thinking content (OpenAI o-series, DeepSeek R1, etc.)
        // Some providers use 'reasoning_content', others embed it differently.
        const deltaAny = delta as unknown as Record<string, unknown>;
        const reasoning = deltaAny.reasoning_content ?? deltaAny.reasoning;
        if (typeof reasoning === 'string' && reasoning) {
          yield { type: 'thinking' as const, content: reasoning };
        }

        // Text content
        if (delta.content) {
          chunkCount++;
          yield { type: 'text', content: delta.content };
        }

        // Tool call deltas
        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index;
            if (!toolCalls.has(idx)) {
              toolCalls.set(idx, { id: '', name: '', args: '' });
            }
            const acc = toolCalls.get(idx)!;
            if (tc.id) acc.id = tc.id;
            if (tc.function?.name) acc.name = tc.function.name;
            if (tc.function?.arguments) acc.args += tc.function.arguments;
          }
        }

        // Log every finish_reason to catch non-standard values from providers
        if (choice.finish_reason) {
          logger.debug('finish_reason', {
            provider: name,
            finishReason: choice.finish_reason,
            pendingToolCalls: toolCalls.size,
            pendingToolNames: [...toolCalls.values()].map(tc => tc.name).filter(Boolean),
          });
        }

        // When the stream signals any finish_reason, yield accumulated tool calls.
        // Different providers use different values (OpenAI: "tool_calls"/"stop",
        // Gemini: "STOP", Anthropic: "end_turn"/"tool_use"), so accept any non-null value.
        if (choice.finish_reason && toolCalls.size > 0) {
          for (const [, tc] of toolCalls) {
            if (tc.id && tc.name) {
              let parsedArgs: Record<string, unknown> = {};
              try {
                parsedArgs = JSON.parse(tc.args || '{}');
              } catch {
                logger.warn('tool_call_parse_error', { name: tc.name, args: tc.args });
              }
              logger.debug('tool_use_yield', { toolName: tc.name, toolId: tc.id });
              yield {
                type: 'tool_use',
                toolCall: {
                  id: tc.id,
                  name: tc.name,
                  args: parsedArgs,
                },
              };
            }
          }
          toolCalls.clear();
        }
      }

      // Warn if tool calls were accumulated but never yielded (non-standard finish_reason)
      if (toolCalls.size > 0) {
        logger.warn('tool_calls_dropped', {
          provider: name,
          count: toolCalls.size,
          toolNames: [...toolCalls.values()].map(tc => tc.name).filter(Boolean),
          hint: 'Tool calls accumulated but finish_reason did not match "tool_calls" or "stop"',
        });
      }

      logger.debug('chat_done', {
        provider: name,
        textChunks: chunkCount,
        inputTokens: usage?.inputTokens,
        outputTokens: usage?.outputTokens,
      });

      yield {
        type: 'done',
        usage,
      };
    },

    async models(): Promise<string[]> {
      try {
        const list = await client.models.list();
        const ids: string[] = [];
        for await (const model of list) {
          ids.push(model.id);
        }
        return ids.sort();
      } catch (err) {
        logger.warn('models_list_failed', { error: String(err) });
        return [];
      }
    },
  };
}
