import type { ContentBlock } from '../types.js';

/**
 * Serialize message content for storage.
 * Strings are stored as-is. ContentBlock arrays are JSON-stringified.
 */
export function serializeContent(content: string | ContentBlock[]): string {
  if (typeof content === 'string') return content;
  // Defense-in-depth: strip image_data blocks (transient, large base64) before
  // persisting. These should already be converted to image file-ref blocks
  // upstream, but guard against accidental leakage.
  const safe = content.filter(b => b.type !== 'image_data');
  return JSON.stringify(safe);
}

/**
 * Deserialize stored content back to string or ContentBlock[].
 * Detects JSON arrays by checking if the string starts with '['.
 */
export function deserializeContent(raw: string): string | ContentBlock[] {
  if (raw.startsWith('[')) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0 && typeof parsed[0]?.type === 'string') {
        return parsed as ContentBlock[];
      }
    } catch {
      // Not valid JSON — return as plain string
    }
  }
  return raw;
}
