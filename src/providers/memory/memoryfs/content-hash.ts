import { createHash } from 'node:crypto';
import type { MemoryType, RefId } from './types.js';

/**
 * Compute deterministic content hash for deduplication.
 * Matches memU's compute_content_hash: sha256("{type}:{normalized}")[:16].
 */
export function computeContentHash(content: string, memoryType: MemoryType): string {
  const normalized = content.toLowerCase().split(/\s+/).join(' ').trim();
  const input = `${memoryType}:${normalized}`;
  return createHash('sha256').update(input).digest('hex').slice(0, 16);
}

/**
 * Build short ref ID for [ref:ID] citations in category summaries.
 * Uses first 6 hex chars of content hash.
 */
export function buildRefId(contentHash: string): RefId {
  return contentHash.slice(0, 6);
}
