import { describe, test, expect } from 'vitest';
import { resolve } from 'node:path';

describe('workspace release uses provisioned baselines', () => {
  test('release reads hash snapshot from /tmp/.ax-hashes.json', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(resolve('src/agent/workspace-cli.ts'), 'utf-8');
    expect(source).toContain('/tmp/.ax-hashes.json');
  });

  test('release does not always use empty baselines', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(resolve('src/agent/workspace-cli.ts'), 'utf-8');
    // The release function should read from hash snapshot, not just use empty Map()
    const releaseSection = source.slice(source.indexOf('async function release'));
    expect(releaseSection).toContain('hashSnapshot');
  });
});
