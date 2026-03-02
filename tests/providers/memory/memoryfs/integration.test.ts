// tests/providers/memory/memoryfs/integration.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { create } from '../../../../src/providers/memory/memoryfs/provider.js';
import type { MemoryProvider, ConversationTurn } from '../../../../src/providers/memory/types.js';
import type { Config } from '../../../../src/types.js';

const config = {} as Config;

describe('MemoryFS integration', () => {
  let memory: MemoryProvider;
  let testHome: string;

  beforeEach(async () => {
    testHome = await mkdtemp(join(tmpdir(), `memfs-integ-${randomUUID()}-`));
    process.env.AX_HOME = testHome;
    memory = await create(config);
  });

  afterEach(async () => {
    try { await rm(testHome, { recursive: true, force: true }); } catch {}
    delete process.env.AX_HOME;
  });

  it('full lifecycle: memorize -> query -> reinforcement', async () => {
    const conversation: ConversationTurn[] = [
      { role: 'user', content: 'Remember that I prefer dark mode in all editors' },
      { role: 'assistant', content: 'Noted!' },
      { role: 'user', content: 'I always run tests before committing' },
    ];
    await memory.memorize!(conversation);

    const darkMode = await memory.query({ scope: 'default', query: 'dark mode' });
    expect(darkMode.length).toBeGreaterThanOrEqual(1);

    const tests = await memory.query({ scope: 'default', query: 'tests' });
    expect(tests.length).toBeGreaterThanOrEqual(1);
  });

  it('dedup: same fact mentioned twice -> one entry reinforced', async () => {
    const conv1: ConversationTurn[] = [
      { role: 'user', content: 'Remember that I use PostgreSQL' },
    ];
    const conv2: ConversationTurn[] = [
      { role: 'user', content: 'Remember that I use PostgreSQL' },
    ];
    await memory.memorize!(conv1);
    await memory.memorize!(conv2);

    const results = await memory.query({ scope: 'default', query: 'PostgreSQL' });
    expect(results).toHaveLength(1);
  });

  it('write + read + delete round-trip', async () => {
    const id = await memory.write({
      scope: 'test-scope',
      content: 'Manual fact about the project',
    });

    const read = await memory.read(id);
    expect(read).not.toBeNull();
    expect(read!.content).toBe('Manual fact about the project');

    await memory.delete(id);
    const deleted = await memory.read(id);
    expect(deleted).toBeNull();
  });

  it('scope isolation', async () => {
    await memory.write({ scope: 'proj-a', content: 'Uses React' });
    await memory.write({ scope: 'proj-b', content: 'Uses Vue' });

    const a = await memory.query({ scope: 'proj-a' });
    expect(a).toHaveLength(1);
    expect(a[0].content).toContain('React');

    const b = await memory.query({ scope: 'proj-b' });
    expect(b).toHaveLength(1);
    expect(b[0].content).toContain('Vue');
  });

  it('summary files are created in memory directory', async () => {
    await memory.memorize!([
      { role: 'user', content: 'Remember that I prefer TypeScript' },
    ]);

    const memoryDir = join(testHome, 'data', 'memory');
    const files = await readdir(memoryDir);
    const mdFiles = files.filter(f => f.endsWith('.md'));
    expect(mdFiles.length).toBeGreaterThan(0);
  });
});
