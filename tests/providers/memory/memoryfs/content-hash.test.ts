import { describe, it, expect } from 'vitest';
import { computeContentHash, buildRefId } from '../../../../src/providers/memory/memoryfs/content-hash.js';

describe('computeContentHash', () => {
  it('produces deterministic 16-char hex hash', () => {
    const hash = computeContentHash('Prefers TypeScript', 'profile');
    expect(hash).toHaveLength(16);
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
    expect(computeContentHash('Prefers TypeScript', 'profile')).toBe(hash);
  });

  it('includes memory type in hash (same text, different type = different hash)', () => {
    const a = computeContentHash('The API uses REST', 'knowledge');
    const b = computeContentHash('The API uses REST', 'profile');
    expect(a).not.toBe(b);
  });

  it('normalizes whitespace', () => {
    const a = computeContentHash('  Prefers   TypeScript  ', 'profile');
    const b = computeContentHash('Prefers TypeScript', 'profile');
    expect(a).toBe(b);
  });

  it('normalizes case', () => {
    const a = computeContentHash('PREFERS TYPESCRIPT', 'profile');
    const b = computeContentHash('prefers typescript', 'profile');
    expect(a).toBe(b);
  });

  it('different content produces different hash', () => {
    const a = computeContentHash('Prefers TypeScript', 'profile');
    const b = computeContentHash('Prefers JavaScript', 'profile');
    expect(a).not.toBe(b);
  });
});

describe('buildRefId', () => {
  it('returns first 6 chars of content hash', () => {
    const hash = computeContentHash('Prefers TypeScript', 'profile');
    const ref = buildRefId(hash);
    expect(ref).toBe(hash.slice(0, 6));
    expect(ref).toHaveLength(6);
  });
});
