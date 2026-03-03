// tests/providers/memory/memoryfs/llm-helpers.test.ts
import { describe, it, expect, vi } from 'vitest';
import { collectLLMText, llmComplete } from '../../../../src/providers/memory/memoryfs/llm-helpers.js';
import type { LLMProvider, ChatChunk } from '../../../../src/providers/llm/types.js';

/** Create an async iterable from an array of chunks. */
async function* chunksFrom(chunks: ChatChunk[]): AsyncIterable<ChatChunk> {
  for (const c of chunks) yield c;
}

describe('collectLLMText', () => {
  it('collects text chunks into a single string', async () => {
    const stream = chunksFrom([
      { type: 'text', content: 'Hello' },
      { type: 'text', content: ' world' },
      { type: 'done' },
    ]);
    expect(await collectLLMText(stream)).toBe('Hello world');
  });

  it('ignores non-text chunks', async () => {
    const stream = chunksFrom([
      { type: 'thinking', content: 'hmm' },
      { type: 'text', content: 'answer' },
      { type: 'tool_use', toolCall: { id: '1', name: 'foo', args: {} } },
      { type: 'done' },
    ]);
    expect(await collectLLMText(stream)).toBe('answer');
  });

  it('returns empty string for no text chunks', async () => {
    const stream = chunksFrom([{ type: 'done' }]);
    expect(await collectLLMText(stream)).toBe('');
  });

  it('skips text chunks with undefined content', async () => {
    const stream = chunksFrom([
      { type: 'text', content: 'a' },
      { type: 'text', content: undefined },
      { type: 'text', content: 'b' },
    ]);
    expect(await collectLLMText(stream)).toBe('ab');
  });
});

describe('llmComplete', () => {
  function mockLLM(response: string): LLMProvider {
    return {
      name: 'mock',
      chat: vi.fn().mockReturnValue(chunksFrom([
        { type: 'text', content: response },
        { type: 'done' },
      ])),
      models: vi.fn().mockResolvedValue(['fast']),
    };
  }

  it('returns collected text from LLM chat', async () => {
    const llm = mockLLM('test response');
    const result = await llmComplete(llm, 'test prompt');
    expect(result).toBe('test response');
  });

  it('passes correct default params to chat', async () => {
    const llm = mockLLM('ok');
    await llmComplete(llm, 'my prompt');
    expect(llm.chat).toHaveBeenCalledWith({
      model: 'fast',
      messages: [{ role: 'user', content: 'my prompt' }],
      maxTokens: 2000,
      taskType: 'fast',
    });
  });

  it('passes custom model and maxTokens', async () => {
    const llm = mockLLM('ok');
    await llmComplete(llm, 'prompt', { model: 'gpt-4', maxTokens: 500, taskType: 'summary' });
    expect(llm.chat).toHaveBeenCalledWith({
      model: 'gpt-4',
      messages: [{ role: 'user', content: 'prompt' }],
      maxTokens: 500,
      taskType: 'summary',
    });
  });
});
