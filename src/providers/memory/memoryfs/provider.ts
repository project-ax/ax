// src/providers/memory/memoryfs/provider.ts — MemoryFS provider wiring
import { join } from 'node:path';
import type { Config } from '../../../types.js';
import type {
  MemoryProvider, MemoryEntry, MemoryQuery, ConversationTurn,
} from '../types.js';
import { dataFile } from '../../../paths.js';
import { ItemsStore } from './items-store.js';
import { writeSummary, readSummary, initDefaultCategories } from './summary-io.js';
import { extractByRegex } from './extractor.js';
import { computeContentHash } from './content-hash.js';
import { salienceScore } from './salience.js';

export async function create(_config: Config): Promise<MemoryProvider> {
  const memoryDir = dataFile('memory');
  const dbPath = join(memoryDir, '_store.db');

  await initDefaultCategories(memoryDir);
  const store = new ItemsStore(dbPath);

  return {
    async write(entry: MemoryEntry): Promise<string> {
      const now = new Date().toISOString();
      const contentHash = computeContentHash(entry.content, 'knowledge');
      const scope = entry.scope || 'default';

      // Dedup: reinforce if same content exists
      const existing = store.findByHash(contentHash, scope, entry.agentId);
      if (existing) {
        store.reinforce(existing.id);
        return existing.id;
      }

      return store.insert({
        content: entry.content,
        memoryType: 'knowledge',
        category: 'knowledge',
        contentHash,
        confidence: 1.0,
        reinforcementCount: 1,
        lastReinforcedAt: now,
        createdAt: now,
        updatedAt: now,
        scope,
        agentId: entry.agentId,
        taint: entry.taint ? JSON.stringify(entry.taint) : undefined,
      });
    },

    async query(q: MemoryQuery): Promise<MemoryEntry[]> {
      const scope = q.scope || 'default';
      let items = q.query
        ? store.searchContent(q.query, scope, q.limit ?? 50)
        : store.listByScope(scope, q.limit ?? 50, q.agentId);

      if (q.agentId && q.query) {
        items = items.filter(i => i.agentId === q.agentId);
      }

      // Rank by salience
      const ranked = items.map(item => ({
        item,
        score: salienceScore({
          similarity: 1.0,
          reinforcementCount: item.reinforcementCount,
          lastReinforcedAt: item.lastReinforcedAt,
          recencyDecayDays: 30,
        }),
      }));
      ranked.sort((a, b) => b.score - a.score);

      return ranked.slice(0, q.limit ?? 50).map(({ item }) => ({
        id: item.id,
        scope: item.scope,
        content: item.content,
        taint: item.taint ? JSON.parse(item.taint) : undefined,
        createdAt: new Date(item.createdAt),
        agentId: item.agentId,
      }));
    },

    async read(id: string): Promise<MemoryEntry | null> {
      const item = store.getById(id);
      if (!item) return null;
      return {
        id: item.id,
        scope: item.scope,
        content: item.content,
        taint: item.taint ? JSON.parse(item.taint) : undefined,
        createdAt: new Date(item.createdAt),
        agentId: item.agentId,
      };
    },

    async delete(id: string): Promise<void> {
      store.deleteById(id);
    },

    async list(scope: string, limit?: number): Promise<MemoryEntry[]> {
      const items = store.listByScope(scope, limit ?? 50);
      return items.map(item => ({
        id: item.id,
        scope: item.scope,
        content: item.content,
        taint: item.taint ? JSON.parse(item.taint) : undefined,
        createdAt: new Date(item.createdAt),
        agentId: item.agentId,
      }));
    },

    async memorize(conversation: ConversationTurn[]): Promise<void> {
      if (conversation.length === 0) return;
      const scope = 'default';

      // Step 1: Extract items via regex
      const candidates = extractByRegex(conversation, scope);

      // Step 2: Dedup/reinforce or insert
      const newItemsByCategory = new Map<string, string[]>();
      for (const candidate of candidates) {
        const existing = store.findByHash(candidate.contentHash, scope);
        if (existing) {
          store.reinforce(existing.id);
        } else {
          store.insert(candidate);
          const items = newItemsByCategory.get(candidate.category) || [];
          items.push(candidate.content);
          newItemsByCategory.set(candidate.category, items);
        }
      }

      // Step 3: Update category summaries (Phase 1: append bullets; later: LLM)
      for (const [category, newContents] of newItemsByCategory) {
        const existingSummary = await readSummary(memoryDir, category) || `# ${category}\n`;
        const newBullets = newContents.map(c => `- ${c}`).join('\n');
        const updated = `${existingSummary.trimEnd()}\n${newBullets}\n`;
        await writeSummary(memoryDir, category, updated);
      }
    },
  };
}
