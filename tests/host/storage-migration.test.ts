import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { initLogger } from '../../src/logger.js';
import { runStorageMigration } from '../../src/host/storage-migration.js';
import type { DocumentStore } from '../../src/providers/storage/types.js';

// Silence logger
initLogger({ file: false, level: 'silent' });

/** Create an in-memory DocumentStore for testing. */
function createMockDocumentStore(): DocumentStore & { dump(): Record<string, Record<string, string>> } {
  const store = new Map<string, Map<string, string>>();

  const ds: DocumentStore & { dump(): Record<string, Record<string, string>> } = {
    async get(collection: string, key: string) {
      return store.get(collection)?.get(key);
    },
    async put(collection: string, key: string, content: string) {
      if (!store.has(collection)) store.set(collection, new Map());
      store.get(collection)!.set(key, content);
    },
    async delete(collection: string, key: string) {
      const existed = store.get(collection)?.has(key) ?? false;
      store.get(collection)?.delete(key);
      return existed;
    },
    async list(collection: string) {
      return Array.from(store.get(collection)?.keys() ?? []).sort();
    },
    dump() {
      const result: Record<string, Record<string, string>> = {};
      for (const [collection, entries] of store) {
        result[collection] = Object.fromEntries(entries);
      }
      return result;
    },
  };
  return ds;
}

describe('runStorageMigration', () => {
  let tmpDir: string;
  let originalAxHome: string | undefined;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `ax-migration-test-${randomUUID().slice(0, 8)}`);
    mkdirSync(tmpDir, { recursive: true });
    originalAxHome = process.env.AX_HOME;
    process.env.AX_HOME = tmpDir;
  });

  afterEach(() => {
    if (originalAxHome !== undefined) {
      process.env.AX_HOME = originalAxHome;
    } else {
      delete process.env.AX_HOME;
    }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('migrates identity files from filesystem to DB', async () => {
    // Set up filesystem structure
    const identityDir = join(tmpDir, 'agents', 'main', 'agent', 'identity');
    mkdirSync(identityDir, { recursive: true });
    writeFileSync(join(identityDir, 'SOUL.md'), '# Soul');
    writeFileSync(join(identityDir, 'IDENTITY.md'), '# Identity');
    writeFileSync(join(identityDir, 'AGENTS.md'), '# Agents');

    const docs = createMockDocumentStore();
    await runStorageMigration(docs, ['main']);

    expect(await docs.get('identity', 'main/SOUL.md')).toBe('# Soul');
    expect(await docs.get('identity', 'main/IDENTITY.md')).toBe('# Identity');
    expect(await docs.get('identity', 'main/AGENTS.md')).toBe('# Agents');
  });

  test('migrates agent skills from filesystem to DB', async () => {
    const skillsDir = join(tmpDir, 'agents', 'main', 'agent', 'skills');
    mkdirSync(skillsDir, { recursive: true });
    writeFileSync(join(skillsDir, 'deploy.md'), '# Deploy\nDeploy instructions.');

    // Subdirectory skill
    const subDir = join(skillsDir, 'ops');
    mkdirSync(subDir, { recursive: true });
    writeFileSync(join(subDir, 'checklist.md'), '# Ops Checklist\nChecklist content.');

    const docs = createMockDocumentStore();
    await runStorageMigration(docs, ['main']);

    expect(await docs.get('skills', 'main/deploy.md')).toBe('# Deploy\nDeploy instructions.');
    expect(await docs.get('skills', 'main/ops/checklist.md')).toBe('# Ops Checklist\nChecklist content.');
  });

  test('migrates per-user files', async () => {
    const userDir = join(tmpDir, 'agents', 'main', 'users', 'alice');
    mkdirSync(userDir, { recursive: true });
    writeFileSync(join(userDir, 'USER.md'), '# Alice prefs');

    const userSkillsDir = join(userDir, 'skills');
    mkdirSync(userSkillsDir, { recursive: true });
    writeFileSync(join(userSkillsDir, 'custom.md'), '# Custom\nAlice custom skill.');

    const docs = createMockDocumentStore();
    await runStorageMigration(docs, ['main']);

    expect(await docs.get('identity', 'main/users/alice/USER.md')).toBe('# Alice prefs');
    expect(await docs.get('skills', 'main/users/alice/custom.md')).toBe('# Custom\nAlice custom skill.');
  });

  test('sets migration flag after completion', async () => {
    const docs = createMockDocumentStore();
    await runStorageMigration(docs, ['main']);

    const flag = await docs.get('migration_flags', 'migrated_storage_v1');
    expect(flag).toBeDefined();
  });

  test('skips migration if already migrated', async () => {
    const identityDir = join(tmpDir, 'agents', 'main', 'agent', 'identity');
    mkdirSync(identityDir, { recursive: true });
    writeFileSync(join(identityDir, 'SOUL.md'), '# Soul');

    const docs = createMockDocumentStore();
    // Set migration flag before running
    await docs.put('migration_flags', 'migrated_storage_v1', '2026-01-01');

    await runStorageMigration(docs, ['main']);

    // SOUL.md should NOT be imported since migration was skipped
    expect(await docs.get('identity', 'main/SOUL.md')).toBeUndefined();
  });

  test('handles missing directories gracefully', async () => {
    const docs = createMockDocumentStore();
    // No directories created — should not throw
    await runStorageMigration(docs, ['main']);
    const flag = await docs.get('migration_flags', 'migrated_storage_v1');
    expect(flag).toBeDefined();
  });
});
