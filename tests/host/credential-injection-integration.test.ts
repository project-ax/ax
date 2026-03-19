import { describe, test, expect } from 'vitest';
import { CredentialPlaceholderMap } from '../../src/host/credential-placeholders.js';

describe('credential injection integration', () => {
  test('builds credential map from skill requirements and credential provider', async () => {
    // Simulate what server-completions will do
    const skillRequiredEnv = ['LINEAR_API_KEY', 'GITHUB_TOKEN'];

    // Mock credential provider
    const credentialStore: Record<string, string> = {
      LINEAR_API_KEY: 'lin_api_real_key',
      GITHUB_TOKEN: 'ghp_real_token',
    };
    const mockCredProvider = {
      get: async (key: string) => credentialStore[key] ?? null,
    };

    const map = new CredentialPlaceholderMap();
    for (const envName of skillRequiredEnv) {
      const realValue = await mockCredProvider.get(envName);
      if (realValue) {
        map.register(envName, realValue);
      }
    }

    const envMap = map.toEnvMap();
    expect(Object.keys(envMap)).toEqual(['LINEAR_API_KEY', 'GITHUB_TOKEN']);
    // Env values should be placeholders, not real values
    expect(envMap.LINEAR_API_KEY).toMatch(/^ax-cred:/);
    expect(envMap.GITHUB_TOKEN).toMatch(/^ax-cred:/);
    expect(envMap.LINEAR_API_KEY).not.toBe('lin_api_real_key');

    // But replaceAll should recover the real values
    const replaced = map.replaceAll(`key=${envMap.LINEAR_API_KEY}`);
    expect(replaced).toBe('key=lin_api_real_key');
  });

  test('skips env vars not found in credential provider', async () => {
    const skillRequiredEnv = ['LINEAR_API_KEY', 'MISSING_KEY'];
    const mockCredProvider = {
      get: async (key: string) => key === 'LINEAR_API_KEY' ? 'lin_api_real' : null,
    };

    const map = new CredentialPlaceholderMap();
    for (const envName of skillRequiredEnv) {
      const realValue = await mockCredProvider.get(envName);
      if (realValue) {
        map.register(envName, realValue);
      }
    }

    const envMap = map.toEnvMap();
    expect(Object.keys(envMap)).toEqual(['LINEAR_API_KEY']);
    // MISSING_KEY should not be in the map
    expect(envMap.MISSING_KEY).toBeUndefined();
  });
});
