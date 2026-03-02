// tests/providers/memory/memoryfs/extractor.test.ts
import { describe, it, expect } from 'vitest';
import { extractByRegex } from '../../../../src/providers/memory/memoryfs/extractor.js';
import type { ConversationTurn } from '../../../../src/providers/memory/types.js';

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
