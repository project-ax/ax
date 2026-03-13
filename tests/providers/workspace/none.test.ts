import { describe, test, expect } from 'vitest';
import { create } from '../../../src/providers/workspace/none.js';
import type { WorkspaceProvider } from '../../../src/providers/workspace/types.js';
import type { Config } from '../../../src/types.js';

const config = {} as Config;

describe('workspace/none provider', () => {
  let provider: WorkspaceProvider;

  test('mount returns empty paths', async () => {
    provider = await create(config);
    const result = await provider.mount('session-1', ['agent', 'user', 'session']);
    expect(result.paths).toEqual({});
  });

  test('commit returns empty scopes with no data', async () => {
    provider = await create(config);
    const result = await provider.commit('session-1');
    expect(result.scopes).toEqual({});
  });

  test('cleanup completes without error', async () => {
    provider = await create(config);
    await expect(provider.cleanup('session-1')).resolves.toBeUndefined();
  });

  test('activeMounts returns empty array', async () => {
    provider = await create(config);
    const mounts = provider.activeMounts('session-1');
    expect(mounts).toEqual([]);
  });

  test('multiple sessions do not interfere', async () => {
    provider = await create(config);

    // Mount on two sessions
    await provider.mount('session-A', ['agent']);
    await provider.mount('session-B', ['session']);

    // Both still return empty — none provider is a no-op
    expect(provider.activeMounts('session-A')).toEqual([]);
    expect(provider.activeMounts('session-B')).toEqual([]);

    const commitA = await provider.commit('session-A');
    const commitB = await provider.commit('session-B');
    expect(commitA.scopes).toEqual({});
    expect(commitB.scopes).toEqual({});

    // Cleaning up one doesn't affect the other
    await provider.cleanup('session-A');
    expect(provider.activeMounts('session-B')).toEqual([]);
  });

  test('mount with empty scopes array returns empty paths', async () => {
    provider = await create(config);
    const result = await provider.mount('session-1', []);
    expect(result.paths).toEqual({});
  });

  test('repeated mount calls are idempotent', async () => {
    provider = await create(config);
    const r1 = await provider.mount('session-1', ['agent']);
    const r2 = await provider.mount('session-1', ['agent']);
    expect(r1.paths).toEqual({});
    expect(r2.paths).toEqual({});
  });
});
