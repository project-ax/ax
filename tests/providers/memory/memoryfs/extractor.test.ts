// tests/providers/memory/memoryfs/extractor.test.ts
import { describe, it, expect, vi } from 'vitest';
import { extractByRegex, extractByLLM } from '../../../../src/providers/memory/memoryfs/extractor.js';
import type { ConversationTurn } from '../../../../src/providers/memory/types.js';
import type { LLMProvider, ChatChunk } from '../../../../src/providers/llm/types.js';

/** Create an async iterable from an array of chunks. */
async function* chunksFrom(chunks: ChatChunk[]): AsyncIterable<ChatChunk> {
  for (const c of chunks) yield c;
}

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

function failingLLM(): LLMProvider {
  return {
    name: 'mock',
    chat: vi.fn().mockReturnValue(chunksFrom([
      { type: 'text', content: 'not valid json at all' },
      { type: 'done' },
    ])),
    models: vi.fn().mockResolvedValue([]),
  };
}

describe('extractByRegex', () => {
  it('extracts explicit memory requests as profile type', () => {
    const turns: ConversationTurn[] = [
      { role: 'user', content: 'Remember that I prefer TypeScript over JavaScript' },
    ];
    const items = extractByRegex(turns, 'default');
    expect(items).toHaveLength(1);
    expect(items[0].content).toBe('I prefer TypeScript over JavaScript');
    expect(items[0].memoryType).toBe('profile');
    expect(items[0].confidence).toBe(0.95);
  });

  it('extracts preferences as profile type', () => {
    const turns: ConversationTurn[] = [
      { role: 'user', content: 'I always use vim keybindings in my editor' },
    ];
    const items = extractByRegex(turns, 'default');
    expect(items).toHaveLength(1);
    expect(items[0].memoryType).toBe('profile');
    expect(items[0].confidence).toBe(0.7);
  });

  it('extracts action items as behavior type', () => {
    const turns: ConversationTurn[] = [
      { role: 'user', content: 'TODO: run the migration script before deploying' },
    ];
    const items = extractByRegex(turns, 'default');
    expect(items).toHaveLength(1);
    expect(items[0].memoryType).toBe('behavior');
    expect(items[0].confidence).toBe(0.8);
  });

  it('ignores assistant turns', () => {
    const turns: ConversationTurn[] = [
      { role: 'assistant', content: 'Remember that I am an AI assistant' },
    ];
    const items = extractByRegex(turns, 'default');
    expect(items).toHaveLength(0);
  });

  it('caps extraction at 20 items per conversation', () => {
    const turns: ConversationTurn[] = Array.from({ length: 30 }, (_, i) => ({
      role: 'user' as const,
      content: `Remember that fact number ${i} is important`,
    }));
    const items = extractByRegex(turns, 'default');
    expect(items.length).toBeLessThanOrEqual(20);
  });

  it('populates contentHash, scope, and timestamps', () => {
    const turns: ConversationTurn[] = [
      { role: 'user', content: 'Remember that the API key rotates weekly' },
    ];
    const items = extractByRegex(turns, 'my-scope');
    expect(items[0].contentHash).toMatch(/^[0-9a-f]{16}$/);
    expect(items[0].scope).toBe('my-scope');
    expect(items[0].createdAt).toBeTruthy();
  });
});

describe('extractByLLM', () => {
  it('extracts structured items from valid LLM JSON response', async () => {
    const llmResponse = JSON.stringify([
      { content: 'User prefers TypeScript', memoryType: 'profile', category: 'preferences' },
      { content: 'Works at Acme Corp', memoryType: 'knowledge', category: 'work_life' },
    ]);
    const llm = mockLLM(llmResponse);
    const turns: ConversationTurn[] = [
      { role: 'user', content: 'I prefer TypeScript and I work at Acme Corp' },
    ];
    const items = await extractByLLM(turns, 'default', llm);
    expect(items).toHaveLength(2);
    expect(items[0].content).toBe('User prefers TypeScript');
    expect(items[0].memoryType).toBe('profile');
    expect(items[0].category).toBe('preferences');
    expect(items[0].confidence).toBe(0.85);
    expect(items[0].scope).toBe('default');
    expect(items[0].contentHash).toMatch(/^[0-9a-f]{16}$/);
    expect(items[1].content).toBe('Works at Acme Corp');
    expect(items[1].memoryType).toBe('knowledge');
    expect(items[1].category).toBe('work_life');
  });

  it('returns empty array when LLM returns []', async () => {
    const llm = mockLLM('[]');
    const turns: ConversationTurn[] = [
      { role: 'user', content: 'What time is it?' },
    ];
    const items = await extractByLLM(turns, 'default', llm);
    expect(items).toHaveLength(0);
  });

  it('handles LLM response wrapped in markdown fences', async () => {
    const llm = mockLLM('```json\n[{"content": "Likes coffee", "memoryType": "profile", "category": "preferences"}]\n```');
    const turns: ConversationTurn[] = [
      { role: 'user', content: 'I like coffee' },
    ];
    const items = await extractByLLM(turns, 'default', llm);
    expect(items).toHaveLength(1);
    expect(items[0].content).toBe('Likes coffee');
  });

  it('throws when LLM returns non-JSON text', async () => {
    const llm = failingLLM();
    const turns: ConversationTurn[] = [
      { role: 'user', content: 'Hello there' },
    ];
    await expect(extractByLLM(turns, 'default', llm)).rejects.toThrow('LLM extraction returned no JSON array');
  });

  it('falls back to default memoryType for invalid values', async () => {
    const llm = mockLLM(JSON.stringify([
      { content: 'Something', memoryType: 'invalid_type', category: 'knowledge' },
    ]));
    const turns: ConversationTurn[] = [
      { role: 'user', content: 'test' },
    ];
    const items = await extractByLLM(turns, 'default', llm);
    expect(items).toHaveLength(1);
    expect(items[0].memoryType).toBe('knowledge');
  });

  it('falls back to default category for invalid values', async () => {
    const llm = mockLLM(JSON.stringify([
      { content: 'Something', memoryType: 'profile', category: 'bogus_category' },
    ]));
    const turns: ConversationTurn[] = [
      { role: 'user', content: 'test' },
    ];
    const items = await extractByLLM(turns, 'default', llm);
    expect(items).toHaveLength(1);
    expect(items[0].category).toBe('personal_info'); // default for 'profile'
  });

  it('filters out malformed items in the array', async () => {
    const llm = mockLLM(JSON.stringify([
      { content: 'Valid item', memoryType: 'profile', category: 'preferences' },
      { noContent: true },
      'not an object',
      null,
    ]));
    const turns: ConversationTurn[] = [
      { role: 'user', content: 'test' },
    ];
    const items = await extractByLLM(turns, 'default', llm);
    expect(items).toHaveLength(1);
    expect(items[0].content).toBe('Valid item');
  });
});
