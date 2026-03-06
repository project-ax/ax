import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { maybeSummarizeHistory, type SummarizationConfig, SUMMARIZATION_DEFAULTS } from '../../src/host/history-summarizer.js';
import type { LLMProvider, ChatChunk, ChatRequest } from '../../src/providers/llm/types.js';
import type { ConversationStoreProvider } from '../../src/providers/storage/types.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createKyselyDb } from '../../src/utils/database.js';
import { runMigrations } from '../../src/utils/migrator.js';
import { storageMigrations } from '../../src/providers/storage/migrations.js';
import { create as createStorage } from '../../src/providers/storage/database.js';
import type { Config } from '../../src/types.js';
import type { Kysely } from 'kysely';

function createMockLLM(summaryText: string): LLMProvider {
  return {
    name: 'mock',
    async *chat(_req: ChatRequest): AsyncIterable<ChatChunk> {
      yield { type: 'text', content: summaryText };
      yield { type: 'done', usage: { inputTokens: 100, outputTokens: 50 } };
    },
    async models() { return ['mock-model']; },
  };
}

function createFailingLLM(): LLMProvider {
  return {
    name: 'failing-mock',
    async *chat(_req: ChatRequest): AsyncIterable<ChatChunk> {
      throw new Error('LLM unavailable');
    },
    async models() { return []; },
  };
}

const silentLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  child: () => silentLogger,
} as any;

describe('maybeSummarizeHistory', () => {
  let tmpDir: string;
  let db: Kysely<any>;
  let store: ConversationStoreProvider;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ax-summarizer-test-'));
    db = createKyselyDb({ type: 'sqlite', path: join(tmpDir, 'test.db') });
    const database = { db, type: 'sqlite' as const, vectorsAvailable: false, async close() { await db.destroy(); } };
    const storage = await createStorage({} as Config, undefined, { database });
    store = storage.conversations;
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await db.destroy();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  const enabledConfig: SummarizationConfig = {
    enabled: true,
    threshold: 10,
    keepRecent: 4,
  };

  it('does nothing when disabled', async () => {
    for (let i = 0; i < 20; i++) {
      await store.append('sess1', 'user', `msg${i}`);
    }
    const llm = createMockLLM('should not be called');
    const result = await maybeSummarizeHistory(
      'sess1', store, llm, { ...enabledConfig, enabled: false }, silentLogger,
    );
    expect(result).toBe(false);
    expect(await store.count('sess1')).toBe(20);
  });

  it('does nothing when below threshold', async () => {
    for (let i = 0; i < 5; i++) {
      await store.append('sess1', 'user', `msg${i}`);
    }
    const llm = createMockLLM('should not be called');
    const result = await maybeSummarizeHistory(
      'sess1', store, llm, enabledConfig, silentLogger,
    );
    expect(result).toBe(false);
    expect(await store.count('sess1')).toBe(5);
  });

  it('summarizes older turns when above threshold', async () => {
    for (let i = 0; i < 15; i++) {
      await store.append('sess1', i % 2 === 0 ? 'user' : 'assistant', `msg${i}`);
    }
    const llm = createMockLLM('Key decisions: chose React over Vue. Action: deploy by Friday.');

    const result = await maybeSummarizeHistory(
      'sess1', store, llm, enabledConfig, silentLogger,
    );

    expect(result).toBe(true);

    const turns = await store.load('sess1');
    // 11 old turns summarized → 2 summary turns + 4 recent = 6
    expect(turns).toHaveLength(6);
    expect(turns[0].is_summary).toBe(1);
    expect(turns[0].content).toContain('Key decisions');
    expect(turns[0].content).toContain('11 earlier messages');
    expect(turns[1].is_summary).toBe(1);
    expect(turns[1].role).toBe('assistant');

    // Recent turns preserved
    expect(turns[2].content).toBe('msg11');
    expect(turns[5].content).toBe('msg14');
  });

  it('handles LLM failure gracefully', async () => {
    for (let i = 0; i < 15; i++) {
      await store.append('sess1', 'user', `msg${i}`);
    }
    const llm = createFailingLLM();

    const result = await maybeSummarizeHistory(
      'sess1', store, llm, enabledConfig, silentLogger,
    );

    expect(result).toBe(false);
    // All turns should still be there (no data loss)
    expect(await store.count('sess1')).toBe(15);
    expect(silentLogger.warn).toHaveBeenCalledWith(
      'history_summarize_failed',
      expect.objectContaining({ error: 'LLM unavailable' }),
    );
  });

  it('handles empty LLM response gracefully', async () => {
    for (let i = 0; i < 15; i++) {
      await store.append('sess1', 'user', `msg${i}`);
    }
    const llm = createMockLLM('');

    const result = await maybeSummarizeHistory(
      'sess1', store, llm, enabledConfig, silentLogger,
    );

    expect(result).toBe(false);
    expect(await store.count('sess1')).toBe(15);
  });

  it('skips when too few older turns (<4)', async () => {
    // 6 total with keepRecent=4 → only 2 older turns, not worth summarizing
    for (let i = 0; i < 12; i++) {
      await store.append('sess1', 'user', `msg${i}`);
    }
    const llm = createMockLLM('summary');

    const result = await maybeSummarizeHistory(
      'sess1', store, llm, { ...enabledConfig, threshold: 10, keepRecent: 10 }, silentLogger,
    );

    expect(result).toBe(false);
  });

  it('supports recursive summarization across multiple rounds', async () => {
    // Round 1: 15 turns, summarize older ones
    for (let i = 0; i < 15; i++) {
      await store.append('sess1', i % 2 === 0 ? 'user' : 'assistant', `round1-msg${i}`);
    }

    const llm1 = createMockLLM('Round 1 summary: discussed architecture and picked TypeScript.');
    await maybeSummarizeHistory('sess1', store, llm1, enabledConfig, silentLogger);

    const afterRound1 = await store.count('sess1');
    expect(afterRound1).toBe(6); // 2 summary + 4 recent

    // Round 2: add more turns, trigger another summarization
    for (let i = 0; i < 15; i++) {
      await store.append('sess1', i % 2 === 0 ? 'user' : 'assistant', `round2-msg${i}`);
    }
    expect(await store.count('sess1')).toBe(21);

    const llm2 = createMockLLM('Round 2 summary: built on prior architecture decisions, implemented auth.');
    await maybeSummarizeHistory('sess1', store, llm2, enabledConfig, silentLogger);

    const afterRound2 = await store.load('sess1');
    expect(afterRound2).toHaveLength(6); // 2 new summary + 4 recent
    expect(afterRound2[0].is_summary).toBe(1);
    expect(afterRound2[0].content).toContain('Round 2 summary');
  });

  it('sends correct prompt to LLM', async () => {
    let capturedRequest: ChatRequest | null = null;
    const llm: LLMProvider = {
      name: 'capture-mock',
      async *chat(req: ChatRequest): AsyncIterable<ChatChunk> {
        capturedRequest = req;
        yield { type: 'text', content: 'A summary.' };
        yield { type: 'done', usage: { inputTokens: 10, outputTokens: 5 } };
      },
      async models() { return ['mock']; },
    };

    await store.append('sess1', 'user', 'What is TypeScript?', 'alice');
    await store.append('sess1', 'assistant', 'TypeScript is a typed superset of JavaScript.');
    for (let i = 0; i < 15; i++) {
      await store.append('sess1', 'user', `follow-up-${i}`);
    }

    await maybeSummarizeHistory('sess1', store, llm, enabledConfig, silentLogger);

    expect(capturedRequest).not.toBeNull();
    expect(capturedRequest!.taskType).toBe('fast');
    expect(capturedRequest!.messages).toHaveLength(2);
    expect(capturedRequest!.messages[0].role).toBe('system');
    expect((capturedRequest!.messages[0].content as string)).toContain('summarizer');
    expect((capturedRequest!.messages[1].content as string)).toContain('What is TypeScript?');
    expect((capturedRequest!.messages[1].content as string)).toContain('User [alice]');
  });

  it('logs start and completion', async () => {
    for (let i = 0; i < 15; i++) {
      await store.append('sess1', 'user', `msg${i}`);
    }
    const llm = createMockLLM('Summary of the conversation.');

    await maybeSummarizeHistory('sess1', store, llm, enabledConfig, silentLogger);

    expect(silentLogger.info).toHaveBeenCalledWith(
      'history_summarize_start',
      expect.objectContaining({
        sessionId: 'sess1',
        totalTurns: 15,
      }),
    );
    expect(silentLogger.info).toHaveBeenCalledWith(
      'history_summarize_done',
      expect.objectContaining({
        sessionId: 'sess1',
        summarizedTurns: 11,
      }),
    );
  });
});
