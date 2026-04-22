/**
 * Unit tests for `resolveCredentialValueByEnvName` — the shared skill-
 * credential value lookup that the OpenAPI dispatcher (and anything else
 * resolving an envName → raw value) funnels through.
 *
 * The invariants being pinned here are the three credential-isolation
 * guarantees from the PR #185 review:
 *   - (skillName, envName) filter: skill A's row does NOT resolve for
 *     skill B's request even when both use the same envName.
 *   - (userId) filter: Alice's user-scoped row does NOT resolve for
 *     Bob's request (no silent `matching[0]` fallback).
 *   - agent-scope sentinel fallback still works when no user row matches.
 *   - process.env fallback only fires when NO rows at all match the
 *     `(skillName, envName)` tuple — pre-skill-credentials infra.
 */
import { describe, test, expect, afterEach } from 'vitest';
import { resolveCredentialValueByEnvName } from '../../../src/host/skills/skill-cred-resolver.js';
import type {
  SkillCredStore,
  SkillCredRow,
} from '../../../src/host/skills/skill-cred-store.js';
import { initLogger } from '../../../src/logger.js';

initLogger({ file: false, level: 'silent' });

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
  for (const k of Object.keys(process.env)) {
    if (!(k in savedEnv)) delete process.env[k];
  }
  for (const k of Object.keys(savedEnv)) {
    process.env[k] = savedEnv[k];
  }
});

describe('resolveCredentialValueByEnvName', () => {
  test('returns the user-scoped value when (skillName, envName, userId) all match', async () => {
    const store = storeWith([
      { skillName: 'petstore', envName: 'PETSTORE_KEY', userId: 'alice', value: 'alice-value' },
    ]);
    const value = await resolveCredentialValueByEnvName({
      skillName: 'petstore',
      envName: 'PETSTORE_KEY',
      agentId: 'a',
      userId: 'alice',
      skillCredStore: store,
    });
    expect(value).toBe('alice-value');
  });

  test('prefers the user-scoped row over the agent-scope sentinel', async () => {
    const store = storeWith([
      { skillName: 'petstore', envName: 'PETSTORE_KEY', userId: '',      value: 'shared' },
      { skillName: 'petstore', envName: 'PETSTORE_KEY', userId: 'alice', value: 'alice-value' },
    ]);
    const value = await resolveCredentialValueByEnvName({
      skillName: 'petstore',
      envName: 'PETSTORE_KEY',
      agentId: 'a',
      userId: 'alice',
      skillCredStore: store,
    });
    expect(value).toBe('alice-value');
  });

  test('falls back to the agent-scope sentinel when no user-scoped row matches', async () => {
    const store = storeWith([
      { skillName: 'petstore', envName: 'PETSTORE_KEY', userId: '', value: 'shared' },
    ]);
    const value = await resolveCredentialValueByEnvName({
      skillName: 'petstore',
      envName: 'PETSTORE_KEY',
      agentId: 'a',
      userId: 'alice',
      skillCredStore: store,
    });
    expect(value).toBe('shared');
  });

  test('returns undefined when Alice stored a user-scoped row but Bob is asking (no cross-user leak)', async () => {
    // Regression for PR #185 review issue #4. Without the fix, `matching[0]`
    // would return Alice's row to Bob.
    const store = storeWith([
      { skillName: 'petstore', envName: 'PETSTORE_KEY', userId: 'alice', value: 'alice-only' },
    ]);
    delete process.env['PETSTORE_KEY'];
    const value = await resolveCredentialValueByEnvName({
      skillName: 'petstore',
      envName: 'PETSTORE_KEY',
      agentId: 'a',
      userId: 'bob',
      skillCredStore: store,
    });
    expect(value).toBeUndefined();
  });

  test('isolates credentials across skills even when envName collides', async () => {
    // Regression for PR #185 review issue #2. Skill A and Skill B both use
    // `API_KEY`; Skill B's request must not get Skill A's value.
    const store = storeWith([
      { skillName: 'skill-a', envName: 'API_KEY', userId: '', value: 'a-secret' },
    ]);
    delete process.env['API_KEY'];
    const value = await resolveCredentialValueByEnvName({
      skillName: 'skill-b',
      envName: 'API_KEY',
      agentId: 'a',
      userId: 'alice',
      skillCredStore: store,
    });
    expect(value).toBeUndefined();
  });

  test('falls back to process.env only when no (skillName, envName) rows exist at all', async () => {
    const store = storeWith([]);
    process.env['PETSTORE_KEY'] = 'from-env';
    const value = await resolveCredentialValueByEnvName({
      skillName: 'petstore',
      envName: 'PETSTORE_KEY',
      agentId: 'a',
      userId: 'alice',
      skillCredStore: store,
    });
    expect(value).toBe('from-env');
  });

  test('process.env fallback does NOT fire when a row for a DIFFERENT skill matches the envName', async () => {
    // With the `(skillName, envName)` filter, rows for skill A don't
    // count as "matching" for skill B's request — so the no-rows branch
    // still triggers and process.env can satisfy the lookup.
    const store = storeWith([
      { skillName: 'skill-a', envName: 'SHARED_KEY', userId: '', value: 'a-only' },
    ]);
    process.env['SHARED_KEY'] = 'from-env';
    const value = await resolveCredentialValueByEnvName({
      skillName: 'skill-b',
      envName: 'SHARED_KEY',
      agentId: 'a',
      userId: 'alice',
      skillCredStore: store,
    });
    expect(value).toBe('from-env');
  });

  test('returns undefined when a matching tuple row exists but has empty value (no process.env fallback)', async () => {
    // An empty stored value is a real "user cleared this" signal — do
    // not let process.env sneak in and override it.
    const store = storeWith([
      { skillName: 'petstore', envName: 'PETSTORE_KEY', userId: 'alice', value: '' },
    ]);
    process.env['PETSTORE_KEY'] = 'should-not-be-used';
    const value = await resolveCredentialValueByEnvName({
      skillName: 'petstore',
      envName: 'PETSTORE_KEY',
      agentId: 'a',
      userId: 'alice',
      skillCredStore: store,
    });
    expect(value).toBeUndefined();
  });
});
