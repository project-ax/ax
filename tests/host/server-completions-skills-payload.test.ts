/**
 * Tests the SkillState → SkillSummary projection that feeds the stdin
 * payload's `skills` field for the agent. Asserts the omit-empty shape
 * that the agent's SkillsModule expects.
 */
import { describe, test, expect } from 'vitest';
import { toSkillSummary, filterSnapshotToEnabled } from '../../src/host/server-completions.js';

describe('toSkillSummary', () => {
  test('projects description and pendingReasons when set', () => {
    const out = toSkillSummary({
      name: 'linear',
      kind: 'pending',
      description: 'Linear issues',
      pendingReasons: ['needs LINEAR_TOKEN'],
    });
    expect(out).toEqual({
      name: 'linear',
      kind: 'pending',
      description: 'Linear issues',
      pendingReasons: ['needs LINEAR_TOKEN'],
    });
  });

  test('omits description and pendingReasons when absent on the source', () => {
    const out = toSkillSummary({ name: 'bad', kind: 'invalid', error: 'parse error' });
    expect(out).toEqual({ name: 'bad', kind: 'invalid', description: '' });
    expect(out).not.toHaveProperty('pendingReasons');
    // Error never leaks into the agent-facing summary.
    expect(out).not.toHaveProperty('error');
  });

  test('omits pendingReasons when the array is empty', () => {
    const out = toSkillSummary({
      name: 'weather',
      kind: 'enabled',
      description: 'Weather data',
      pendingReasons: [],
    });
    expect(out).toEqual({
      name: 'weather',
      kind: 'enabled',
      description: 'Weather data',
    });
    expect(out).not.toHaveProperty('pendingReasons');
  });
});

// REGRESSION: CodeRabbit PR #185 issue #5. The per-turn catalog build and
// MCP tool-route discovery both walked `loadSnapshot` unfiltered, so
// pending-kind and invalid-kind skills produced `call_tool` entries that
// were guaranteed to fail at dispatch with 401/403. The filter below now
// gates both call sites on the subset of skills whose derived state is
// `enabled`.
describe('filterSnapshotToEnabled', () => {
  test('keeps only entries whose name is in the enabled set', () => {
    const snapshot = [
      { name: 'linear', ok: true },
      { name: 'weather-pending', ok: true },
      { name: 'bad-frontmatter', ok: false, error: 'parse' },
      { name: 'github', ok: true },
    ];
    const enabled = new Set(['linear', 'github']);
    expect(filterSnapshotToEnabled(snapshot, enabled).map((e) => e.name)).toEqual([
      'linear',
      'github',
    ]);
  });

  test('drops invalid entries (ok: false) even when their name is in the enabled set', () => {
    // Defensive: an invalid skill can't be "enabled" in practice (state
    // derivation gates on a successful frontmatter parse), but the filter
    // doesn't trust the name set alone. Any entry with ok=false is skipped.
    const snapshot = [
      { name: 'linear', ok: true },
      { name: 'broken', ok: false, error: 'parse' },
    ];
    const enabled = new Set(['linear', 'broken']);
    expect(filterSnapshotToEnabled(snapshot, enabled).map((e) => e.name)).toEqual(['linear']);
  });

  test('returns an empty array when the enabled set is empty', () => {
    const snapshot = [
      { name: 'linear', ok: true },
      { name: 'github', ok: true },
    ];
    expect(filterSnapshotToEnabled(snapshot, new Set())).toEqual([]);
  });

  test('accepts entries with a missing ok field (treated as ok)', () => {
    // Test fixtures in existing catalog-population tests omit the `ok`
    // field; the filter treats absent-ok as "valid frontmatter" so those
    // fixtures keep working. Real-world snapshot entries always have ok
    // explicitly set, but the pinning is worth preserving.
    const snapshot = [
      { name: 'linear' },
      { name: 'github', ok: true },
    ];
    const enabled = new Set(['linear', 'github']);
    expect(filterSnapshotToEnabled(snapshot, enabled).map((e) => e.name)).toEqual([
      'linear',
      'github',
    ]);
  });
});
