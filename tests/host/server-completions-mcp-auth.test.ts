/**
 * Tests `resolveMcpAuthHeaders` — the callback that `server-completions.ts`
 * feeds into `mcpManager.discoverAllTools` so MCP servers declared by skills
 * can be authenticated at tool-discovery time using skill-scoped credentials.
 */
import { describe, test, expect, afterEach } from 'vitest';
import { resolveMcpAuthHeaders, fingerprintCred } from '../../src/host/server-completions.js';
import { initLogger } from '../../src/logger.js';

initLogger({ file: false, level: 'silent' });
import type {
  SkillCredStore,
  SkillCredRow,
} from '../../src/host/skills/skill-cred-store.js';

function storeWith(rows: SkillCredRow[]): SkillCredStore {
  return {
    async put() {},
    async get() { return null; },
    async listForAgent() { return rows; },
    async listEnvNames() { return new Set(rows.map(r => r.envName)); },
  };
}

const savedEnv = { ...process.env };
afterEach(() => {
  // Restore any env keys we mutated during a test so state doesn't leak.
  for (const k of Object.keys(process.env)) {
    if (!(k in savedEnv)) delete process.env[k];
  }
  for (const k of Object.keys(savedEnv)) {
    process.env[k] = savedEnv[k];
  }
});

describe('resolveMcpAuthHeaders', () => {
  test('returns Bearer header from a matching skill-scoped credential', async () => {
    const store = storeWith([
      {
        skillName: 'linear',
        envName: 'LINEAR_API_KEY',
        userId: 'u1',
        value: 'sk-linear-user',
      },
    ]);
    const headers = await resolveMcpAuthHeaders({
      serverName: 'linear',
      skillName: 'linear',
      agentId: 'pi',
      userId: 'u1',
      skillCredStore: store,
    });
    expect(headers).toEqual({ Authorization: 'Bearer sk-linear-user' });
  });

  test('prefers the user-scoped row over the agent-scope sentinel', async () => {
    const store = storeWith([
      { skillName: 'linear', envName: 'LINEAR_API_KEY', userId: '',   value: 'shared' },
      { skillName: 'linear', envName: 'LINEAR_API_KEY', userId: 'u1', value: 'user-only' },
    ]);
    const headers = await resolveMcpAuthHeaders({
      serverName: 'linear',
      skillName: 'linear',
      agentId: 'pi',
      userId: 'u1',
      skillCredStore: store,
    });
    expect(headers).toEqual({ Authorization: 'Bearer user-only' });
  });

  test('falls back to agent-scope sentinel when no user-scoped row matches', async () => {
    const store = storeWith([
      { skillName: 'linear', envName: 'LINEAR_API_KEY', userId: '', value: 'shared' },
    ]);
    const headers = await resolveMcpAuthHeaders({
      serverName: 'linear',
      skillName: 'linear',
      agentId: 'pi',
      userId: 'u1',
      skillCredStore: store,
    });
    expect(headers).toEqual({ Authorization: 'Bearer shared' });
  });

  test('normalises server name hyphens to underscores for env lookup', async () => {
    const store = storeWith([
      { skillName: 'gh', envName: 'GITHUB_MCP_API_KEY', userId: '', value: 'gh-key' },
    ]);
    const headers = await resolveMcpAuthHeaders({
      serverName: 'github-mcp',
      skillName: 'gh',
      agentId: 'pi',
      userId: 'u1',
      skillCredStore: store,
    });
    expect(headers).toEqual({ Authorization: 'Bearer gh-key' });
  });

  test('tries _ACCESS_TOKEN / _OAUTH_TOKEN / _TOKEN when _API_KEY is absent', async () => {
    const store = storeWith([
      { skillName: 'slack', envName: 'SLACK_OAUTH_TOKEN', userId: '', value: 'xoxb-123' },
    ]);
    delete process.env['SLACK_API_KEY'];
    delete process.env['SLACK_ACCESS_TOKEN'];
    const headers = await resolveMcpAuthHeaders({
      serverName: 'slack',
      skillName: 'slack',
      agentId: 'pi',
      userId: 'u1',
      skillCredStore: store,
    });
    expect(headers).toEqual({ Authorization: 'Bearer xoxb-123' });
  });

  test('isolates credentials across skills: skill-A row does NOT resolve for skill-B', async () => {
    // Regression for PR #185 review issue #2 — two skills both using
    // `LINEAR_API_KEY` (e.g. `linear` and `linear-copy`) must not share
    // credentials. Skill B's request against skill A's stored row
    // should fall through to process.env (or undefined), not borrow.
    const store = storeWith([
      { skillName: 'linear', envName: 'LINEAR_API_KEY', userId: '', value: 'skill-a-only' },
    ]);
    delete process.env['LINEAR_API_KEY'];
    delete process.env['LINEAR_ACCESS_TOKEN'];
    delete process.env['LINEAR_OAUTH_TOKEN'];
    delete process.env['LINEAR_TOKEN'];
    const headers = await resolveMcpAuthHeaders({
      serverName: 'linear',
      skillName: 'linear-copy',
      agentId: 'pi',
      userId: 'u1',
      skillCredStore: store,
    });
    expect(headers).toBeUndefined();
  });

  test('isolates credentials across users: another user\'s row does NOT resolve for Bob', async () => {
    // Regression for PR #185 review issue #4 — with no agent-scope row
    // and no row for Bob, Alice's user-scoped value must NOT leak via a
    // `matching[0]` fallback.
    const store = storeWith([
      { skillName: 'linear', envName: 'LINEAR_API_KEY', userId: 'alice', value: 'alice-secret' },
    ]);
    delete process.env['LINEAR_API_KEY'];
    delete process.env['LINEAR_ACCESS_TOKEN'];
    delete process.env['LINEAR_OAUTH_TOKEN'];
    delete process.env['LINEAR_TOKEN'];
    const headers = await resolveMcpAuthHeaders({
      serverName: 'linear',
      skillName: 'linear',
      agentId: 'pi',
      userId: 'bob',
      skillCredStore: store,
    });
    expect(headers).toBeUndefined();
  });

  test('returns undefined when no rows match and process.env is empty', async () => {
    const store = storeWith([]);
    delete process.env['LINEAR_API_KEY'];
    delete process.env['LINEAR_ACCESS_TOKEN'];
    delete process.env['LINEAR_OAUTH_TOKEN'];
    delete process.env['LINEAR_TOKEN'];
    const headers = await resolveMcpAuthHeaders({
      serverName: 'linear',
      skillName: 'linear',
      agentId: 'pi',
      userId: 'u1',
      skillCredStore: store,
    });
    expect(headers).toBeUndefined();
  });

  test('uses process.env as last-resort fallback when no skill_credentials row exists', async () => {
    const store = storeWith([]);
    delete process.env['LINEAR_API_KEY'];
    process.env['LINEAR_ACCESS_TOKEN'] = 'from-env';
    const headers = await resolveMcpAuthHeaders({
      serverName: 'linear',
      skillName: 'linear',
      agentId: 'pi',
      userId: 'u1',
      skillCredStore: store,
    });
    expect(headers).toEqual({ Authorization: 'Bearer from-env' });
  });

  test('skill_credentials row wins over process.env when both are present', async () => {
    const store = storeWith([
      { skillName: 'linear', envName: 'LINEAR_API_KEY', userId: '', value: 'from-store' },
    ]);
    process.env['LINEAR_API_KEY'] = 'from-env';
    const headers = await resolveMcpAuthHeaders({
      serverName: 'linear',
      skillName: 'linear',
      agentId: 'pi',
      userId: 'u1',
      skillCredStore: store,
    });
    expect(headers).toEqual({ Authorization: 'Bearer from-store' });
  });
});

// ── Credential fingerprinting ──────────────────────────────────────────
//
// Fingerprints are logged alongside every resolution so ops can tell which
// stored row was selected without seeing any plaintext. These tests guard
// the two invariants that matter: no secret portion ever leaks, and two
// distinct values never collide in practice. (Log shape itself is manually
// verified via the `skill_cred_resolved` entries — child-logger isolation
// makes spy-based capture clunkier than the fix is worth.)

describe('fingerprintCred', () => {
  test('same value → same fingerprint (idempotent)', () => {
    expect(fingerprintCred('abc-123')).toBe(fingerprintCred('abc-123'));
  });

  test('different values → different fingerprints', () => {
    expect(fingerprintCred('value-A')).not.toBe(fingerprintCred('value-B'));
    expect(fingerprintCred('super-secret-token')).not.toBe(fingerprintCred('other-secret-token'));
  });

  test('never returns any portion of the plaintext', () => {
    const secret = 'super-secret-api-key-value';
    const fp = fingerprintCred(secret);
    // Every 3+ char window of the plaintext must be absent from the fingerprint.
    for (let i = 0; i + 3 <= secret.length; i++) {
      expect(fp).not.toContain(secret.slice(i, i + 3));
    }
  });

  test('returns exactly 8 hex characters for non-empty values', () => {
    expect(fingerprintCred('anything')).toMatch(/^[0-9a-f]{8}$/);
    expect(fingerprintCred('xoxb-1234567890')).toMatch(/^[0-9a-f]{8}$/);
  });

  test('returns the sentinel `<empty>` for the empty string so log consumers can distinguish it from a real fingerprint', () => {
    expect(fingerprintCred('')).toBe('<empty>');
  });
});
