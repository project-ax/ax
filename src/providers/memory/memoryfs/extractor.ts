// src/providers/memory/memoryfs/extractor.ts — Memory extraction (LLM + regex fallback)
import type { ConversationTurn } from '../types.js';
import type { LLMProvider } from '../../llm/types.js';
import type { MemoryFSItem, MemoryType } from './types.js';
import { MEMORY_TYPES } from './types.js';
import { computeContentHash } from './content-hash.js';
import { llmComplete } from './llm-helpers.js';
import { getLogger } from '../../../logger.js';

const logger = getLogger().child({ component: 'memoryfs-extractor' });

const MAX_ITEMS_PER_CONVERSATION = 20;

interface ExtractionCandidate {
  content: string;
  memoryType: MemoryType;
  confidence: number;
}

/**
 * Extract memory items from conversation using regex heuristics.
 * Fast path -- no LLM call. Adapted from existing memu.ts patterns.
 */
export function extractByRegex(
  conversation: ConversationTurn[],
  scope: string,
): Omit<MemoryFSItem, 'id'>[] {
  const candidates: ExtractionCandidate[] = [];

  for (const turn of conversation) {
    if (turn.role !== 'user') continue;
    const text = turn.content;

    // Explicit memory requests: "remember that...", "note that...", "keep in mind..."
    const rememberMatch = text.match(
      /(?:remember|note|keep in mind|don't forget)\s+(?:that\s+)?(.{10,200})/i,
    );
    if (rememberMatch) {
      candidates.push({
        content: rememberMatch[1].trim(),
        memoryType: 'profile',
        confidence: 0.95,
      });
    }

    // Preferences: "I prefer...", "I like...", "I always..."
    const prefMatch = text.match(
      /(?:I\s+(?:prefer|like|always|usually|want|need))\s+(.{5,200})/i,
    );
    if (prefMatch && !rememberMatch) {
      candidates.push({
        content: prefMatch[0].trim(),
        memoryType: 'profile',
        confidence: 0.7,
      });
    }

    // Action items / behavior patterns: "TODO:", "I need to...", "I should..."
    const todoMatch = text.match(
      /(?:TODO:?\s+|I\s+(?:need|should|have)\s+to\s+)(.{5,200})/i,
    );
    if (todoMatch) {
      candidates.push({
        content: todoMatch[1].trim(),
        memoryType: 'behavior',
        confidence: 0.8,
      });
    }
  }

  const now = new Date().toISOString();
  return candidates.slice(0, MAX_ITEMS_PER_CONVERSATION).map(c => ({
    content: c.content,
    memoryType: c.memoryType,
    category: defaultCategoryForType(c.memoryType),
    contentHash: computeContentHash(c.content, c.memoryType),
    confidence: c.confidence,
    reinforcementCount: 1,
    lastReinforcedAt: now,
    createdAt: now,
    updatedAt: now,
    scope,
  }));
}

const VALID_CATEGORIES = new Set([
  'personal_info', 'preferences', 'relationships', 'activities', 'goals',
  'experiences', 'knowledge', 'opinions', 'habits', 'work_life',
]);

const EXTRACTION_PROMPT = `Extract discrete facts, preferences, and action items from this conversation that should be remembered about the user. For each item:
- content: A concise, self-contained statement (not the raw text — rephrase for clarity)
- memoryType: one of profile, event, knowledge, behavior, skill, tool
- category: one of personal_info, preferences, relationships, activities, goals, experiences, knowledge, opinions, habits, work_life

Only extract information the user explicitly states or clearly implies. Do not infer or speculate.

Respond with ONLY a JSON array: [{"content": "...", "memoryType": "...", "category": "..."}]
If nothing worth remembering, respond with: []`;

/**
 * Extract memory items from conversation using an LLM.
 * Falls back to extractByRegex on LLM failure.
 */
export async function extractByLLM(
  conversation: ConversationTurn[],
  scope: string,
  llm: LLMProvider,
  model?: string,
): Promise<Omit<MemoryFSItem, 'id'>[]> {
  const conversationText = conversation
    .map(t => `${t.role}: ${t.content}`)
    .join('\n');

  const prompt = `${EXTRACTION_PROMPT}\n\nConversation:\n${conversationText}`;

  const raw = await llmComplete(llm, prompt, { model, maxTokens: 2000 });

  // Extract JSON array from response (handle markdown fences)
  const jsonMatch = raw.match(/\[[\s\S]*\]/);
  if (!jsonMatch) {
    throw new Error('LLM extraction returned no JSON array');
  }

  const parsed: unknown = JSON.parse(jsonMatch[0]);
  if (!Array.isArray(parsed)) {
    throw new Error('LLM extraction response is not an array');
  }

  const now = new Date().toISOString();
  const validTypes = new Set<string>(MEMORY_TYPES);

  return parsed
    .filter((item): item is { content: string; memoryType: string; category: string } =>
      typeof item === 'object' && item !== null &&
      typeof (item as any).content === 'string' &&
      typeof (item as any).memoryType === 'string' &&
      typeof (item as any).category === 'string',
    )
    .slice(0, MAX_ITEMS_PER_CONVERSATION)
    .map(item => {
      const memoryType = validTypes.has(item.memoryType)
        ? item.memoryType as MemoryType
        : 'knowledge' as MemoryType;
      const category = VALID_CATEGORIES.has(item.category)
        ? item.category
        : defaultCategoryForType(memoryType);

      return {
        content: item.content,
        memoryType,
        category,
        contentHash: computeContentHash(item.content, memoryType),
        confidence: 0.85,
        reinforcementCount: 1,
        lastReinforcedAt: now,
        createdAt: now,
        updatedAt: now,
        scope,
      };
    });
}

/** Default category mapping by memory type. */
function defaultCategoryForType(memoryType: MemoryType): string {
  switch (memoryType) {
    case 'profile': return 'personal_info';
    case 'event': return 'experiences';
    case 'knowledge': return 'knowledge';
    case 'behavior': return 'habits';
    case 'skill': return 'knowledge';
    case 'tool': return 'work_life';
  }
}
