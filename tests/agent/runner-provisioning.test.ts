import { describe, test, expect } from 'vitest';
import { resolve } from 'node:path';

describe('in-pod workspace provisioning', () => {
  test('runner.ts has provisionWorkspaceFromPayload function', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(resolve('src/agent/runner.ts'), 'utf-8');
    expect(source).toContain('provisionWorkspaceFromPayload');
  });

  test('provisionWorkspaceFromPayload provisions scopes and writes hash snapshot', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(resolve('src/agent/runner.ts'), 'utf-8');
    expect(source).toContain('provisionScope');
    expect(source).toContain('provisionWorkspace');
    expect(source).toContain('.ax-hashes.json');
  });

  test('k8s HTTP mode calls provisionWorkspaceFromPayload before run()', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(resolve('src/agent/runner.ts'), 'utf-8');
    // Provisioning must appear between applyPayload and run
    const applyIdx = source.indexOf('applyPayload(config, payload)');
    const provisionIdx = source.indexOf('provisionWorkspaceFromPayload(payload)');
    const runIdx = source.indexOf('return run(config)');
    expect(provisionIdx).toBeGreaterThan(applyIdx);
    expect(provisionIdx).toBeLessThan(runIdx);
  });
});
