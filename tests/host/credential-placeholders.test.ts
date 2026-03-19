import { describe, test, expect } from 'vitest';

describe('credential-placeholders', () => {
  test('generates unique placeholder for a credential', async () => {
    const { CredentialPlaceholderMap } = await import('../../src/host/credential-placeholders.js');
    const map = new CredentialPlaceholderMap();
    const ph = map.register('LINEAR_API_KEY', 'lin_api_real_key_123');
    expect(ph).toMatch(/^ax-cred:[a-f0-9]+$/);
  });

  test('replaces placeholders in a string', async () => {
    const { CredentialPlaceholderMap } = await import('../../src/host/credential-placeholders.js');
    const map = new CredentialPlaceholderMap();
    const ph = map.register('LINEAR_API_KEY', 'lin_api_real_key_123');
    const input = `Authorization: Bearer ${ph}`;
    const result = map.replaceAll(input);
    expect(result).toBe('Authorization: Bearer lin_api_real_key_123');
  });

  test('replaces placeholders in a Buffer', async () => {
    const { CredentialPlaceholderMap } = await import('../../src/host/credential-placeholders.js');
    const map = new CredentialPlaceholderMap();
    const ph = map.register('LINEAR_API_KEY', 'lin_api_real_key_123');
    const input = Buffer.from(`{"token":"${ph}"}`);
    const result = map.replaceAllBuffer(input);
    expect(result.toString()).toBe('{"token":"lin_api_real_key_123"}');
  });

  test('handles multiple placeholders', async () => {
    const { CredentialPlaceholderMap } = await import('../../src/host/credential-placeholders.js');
    const map = new CredentialPlaceholderMap();
    const ph1 = map.register('LINEAR_API_KEY', 'lin_key');
    const ph2 = map.register('GITHUB_TOKEN', 'ghp_token');
    const input = `linear=${ph1}&github=${ph2}`;
    const result = map.replaceAll(input);
    expect(result).toBe('linear=lin_key&github=ghp_token');
  });

  test('returns env map of name→placeholder', async () => {
    const { CredentialPlaceholderMap } = await import('../../src/host/credential-placeholders.js');
    const map = new CredentialPlaceholderMap();
    const ph = map.register('LINEAR_API_KEY', 'lin_key');
    const envMap = map.toEnvMap();
    expect(envMap).toEqual({ LINEAR_API_KEY: ph });
  });

  test('hasPlaceholders returns false when no placeholders in string', async () => {
    const { CredentialPlaceholderMap } = await import('../../src/host/credential-placeholders.js');
    const map = new CredentialPlaceholderMap();
    map.register('LINEAR_API_KEY', 'lin_key');
    expect(map.hasPlaceholders('no creds here')).toBe(false);
  });

  test('hasPlaceholders returns true when placeholder present', async () => {
    const { CredentialPlaceholderMap } = await import('../../src/host/credential-placeholders.js');
    const map = new CredentialPlaceholderMap();
    const ph = map.register('LINEAR_API_KEY', 'lin_key');
    expect(map.hasPlaceholders(`Bearer ${ph}`)).toBe(true);
  });
});

describe('SharedCredentialRegistry', () => {
  test('replaces placeholders from multiple sessions', async () => {
    const { CredentialPlaceholderMap, SharedCredentialRegistry } = await import('../../src/host/credential-placeholders.js');
    const registry = new SharedCredentialRegistry();

    const map1 = new CredentialPlaceholderMap();
    const ph1 = map1.register('LINEAR_KEY', 'lin_real');
    registry.register('sess-1', map1);

    const map2 = new CredentialPlaceholderMap();
    const ph2 = map2.register('GITHUB_TOKEN', 'ghp_real');
    registry.register('sess-2', map2);

    // Should replace placeholders from both sessions
    const input = `linear=${ph1}&github=${ph2}`;
    expect(registry.replaceAll(input)).toBe('linear=lin_real&github=ghp_real');
    expect(registry.hasPlaceholders(input)).toBe(true);
  });

  test('deregister removes a session', async () => {
    const { CredentialPlaceholderMap, SharedCredentialRegistry } = await import('../../src/host/credential-placeholders.js');
    const registry = new SharedCredentialRegistry();

    const map = new CredentialPlaceholderMap();
    const ph = map.register('KEY', 'secret');
    registry.register('sess-1', map);

    expect(registry.hasPlaceholders(`val=${ph}`)).toBe(true);

    registry.deregister('sess-1');
    expect(registry.hasPlaceholders(`val=${ph}`)).toBe(false);
    expect(registry.replaceAll(`val=${ph}`)).toBe(`val=${ph}`); // no replacement
  });

  test('replaceAllBuffer works across sessions', async () => {
    const { CredentialPlaceholderMap, SharedCredentialRegistry } = await import('../../src/host/credential-placeholders.js');
    const registry = new SharedCredentialRegistry();

    const map = new CredentialPlaceholderMap();
    const ph = map.register('TOKEN', 'real_token');
    registry.register('sess-1', map);

    const buf = Buffer.from(`Authorization: ${ph}`);
    const result = registry.replaceAllBuffer(buf);
    expect(result.toString()).toBe('Authorization: real_token');
  });
});
