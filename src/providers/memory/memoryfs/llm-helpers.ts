// src/providers/memory/memoryfs/llm-helpers.ts — Streaming response collector + simple LLM call wrapper
import type { LLMProvider, ChatChunk } from '../../llm/types.js';

/** Collect all text chunks from a streaming LLM response. */
export async function collectLLMText(stream: AsyncIterable<ChatChunk>): Promise<string> {
  const parts: string[] = [];
  for await (const chunk of stream) {
    if (chunk.type === 'text' && chunk.content) parts.push(chunk.content);
  }
  return parts.join('');
}

/** Make a simple text prompt -> text response LLM call. */
export async function llmComplete(
  llm: LLMProvider,
  prompt: string,
  opts?: { model?: string; maxTokens?: number; taskType?: string },
): Promise<string> {
  const stream = llm.chat({
    model: opts?.model ?? 'fast',
    messages: [{ role: 'user', content: prompt }],
    maxTokens: opts?.maxTokens ?? 2000,
    taskType: (opts?.taskType ?? 'fast') as any,
  });
  return collectLLMText(stream);
}
