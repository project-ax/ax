// src/providers/memory/memoryfs/extractor.ts — Regex-based memory extraction (fast path)
import type { ConversationTurn } from '../types.js';
import type { MemoryFSItem, MemoryType } from './types.js';
import { computeContentHash } from './content-hash.js';

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
