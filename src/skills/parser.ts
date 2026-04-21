import { parse as parseYaml } from 'yaml';
import { SkillFrontmatterSchema, type SkillFrontmatter } from './frontmatter-schema.js';

export type ParseResult =
  | { ok: true; frontmatter: SkillFrontmatter; body: string }
  | { ok: false; error: string };

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

/**
 * Walk the input object at a Zod issue path and return the value that
 * actually sat at that position. Zod's default `invalid_value` / `invalid_type`
 * messages list valid options but not the offender — "expected one of
 * api_key|oauth" doesn't tell the agent that it wrote "apiKey", so it has
 * to re-derive the mistake from its own output. Surfacing the received
 * value turns "something's wrong" into "change apiKey to api_key".
 */
function pickReceived(root: unknown, path: readonly PropertyKey[]): unknown {
  let cur: unknown = root;
  for (const seg of path) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<PropertyKey, unknown>)[seg];
  }
  return cur;
}

/** Compact, quote-preserving render of a received value for error text. */
function renderReceived(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (typeof value === 'string') return JSON.stringify(value);
  if (value === null || typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  // Objects / arrays — short preview, one line, truncated.
  try {
    const json = JSON.stringify(value);
    return json.length > 120 ? json.slice(0, 117) + '...' : json;
  } catch {
    return typeof value;
  }
}

export function parseSkillFile(content: string): ParseResult {
  const match = content.match(FRONTMATTER_RE);
  if (!match) {
    return { ok: false, error: 'missing or unterminated YAML frontmatter' };
  }
  const [, yamlText, body] = match;

  let raw: unknown;
  try {
    raw = parseYaml(yamlText);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `invalid YAML: ${msg}` };
  }

  const parsed = SkillFrontmatterSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues
        .map((i) => {
          const pathStr = i.path.join('.');
          const received = pickReceived(raw, i.path);
          // Only append "received: X" when it adds signal. For missing fields
          // (received === undefined) Zod's "expected string, received undefined"
          // already carries the info; for enum/regex mismatches on present
          // values, the received form is the actionable piece.
          const suffix = received !== undefined
            ? ` (received: ${renderReceived(received)})`
            : '';
          return `${pathStr}: ${i.message}${suffix}`;
        })
        .join('; '),
    };
  }
  return { ok: true, frontmatter: parsed.data, body };
}
