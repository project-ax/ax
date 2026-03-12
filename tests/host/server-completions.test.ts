import { describe, test, expect } from 'vitest';
import { loadIdentityFromDB, loadSkillsFromDB } from '../../src/host/server-completions.js';
import type { DocumentStore } from '../../src/providers/storage/types.js';

/** Create an in-memory DocumentStore for testing. */
function createMockDocumentStore(data: Record<string, Record<string, string>> = {}): DocumentStore {
  const store = new Map<string, Map<string, string>>();
  for (const [collection, entries] of Object.entries(data)) {
    const collMap = new Map<string, string>();
    for (const [key, value] of Object.entries(entries)) {
      collMap.set(key, value);
    }
    store.set(collection, collMap);
  }

  return {
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
  };
}

describe('loadIdentityFromDB', () => {
  test('loads all identity files for an agent', async () => {
    const docs = createMockDocumentStore({
      identity: {
        'main/SOUL.md': '# Soul content',
        'main/IDENTITY.md': '# Identity content',
        'main/AGENTS.md': '# Agents content',
        'main/HEARTBEAT.md': '# Heartbeat content',
        'main/BOOTSTRAP.md': '# Bootstrap content',
        'main/USER_BOOTSTRAP.md': '# User Bootstrap content',
      },
    });

    const result = await loadIdentityFromDB(docs, 'main', 'alice');
    expect(result.soul).toBe('# Soul content');
    expect(result.identity).toBe('# Identity content');
    expect(result.agents).toBe('# Agents content');
    expect(result.heartbeat).toBe('# Heartbeat content');
    expect(result.bootstrap).toBe('# Bootstrap content');
    expect(result.userBootstrap).toBe('# User Bootstrap content');
  });

  test('loads user-specific USER.md', async () => {
    const docs = createMockDocumentStore({
      identity: {
        'main/users/alice/USER.md': '# Alice prefs',
      },
    });

    const result = await loadIdentityFromDB(docs, 'main', 'alice');
    expect(result.user).toBe('# Alice prefs');
  });

  test('returns empty partial when no files exist', async () => {
    const docs = createMockDocumentStore({});
    const result = await loadIdentityFromDB(docs, 'main', 'alice');
    expect(Object.keys(result).length).toBe(0);
  });

  test('only loads files for the correct agent', async () => {
    const docs = createMockDocumentStore({
      identity: {
        'other-agent/SOUL.md': '# Other soul',
        'main/SOUL.md': '# Main soul',
      },
    });

    const result = await loadIdentityFromDB(docs, 'main', 'alice');
    expect(result.soul).toBe('# Main soul');
  });
});

describe('loadSkillsFromDB', () => {
  test('loads agent-level skills', async () => {
    const docs = createMockDocumentStore({
      skills: {
        'main/deploy.md': '# Deploy\nDeploy the application.',
        'main/coding.md': '# Coding\nCode review guidelines.',
      },
    });

    const skills = await loadSkillsFromDB(docs, 'main', 'alice');
    expect(skills).toHaveLength(2);
    const names = skills.map(s => s.name);
    expect(names).toContain('Deploy');
    expect(names).toContain('Coding');
  });

  test('user skills shadow agent skills by relative path', async () => {
    const docs = createMockDocumentStore({
      skills: {
        'main/deploy.md': '# Deploy\nAgent version.',
        'main/users/alice/deploy.md': '# Deploy Custom\nAlice version.',
      },
    });

    const skills = await loadSkillsFromDB(docs, 'main', 'alice');
    expect(skills).toHaveLength(1);
    expect(skills[0].name).toBe('Deploy Custom');
    expect(skills[0].description).toBe('Alice version.');
  });

  test('returns empty array when no skills exist', async () => {
    const docs = createMockDocumentStore({});
    const skills = await loadSkillsFromDB(docs, 'main', 'alice');
    expect(skills).toEqual([]);
  });

  test('excludes skills from other agents', async () => {
    const docs = createMockDocumentStore({
      skills: {
        'other/deploy.md': '# Other Deploy\nNot for main.',
        'main/coding.md': '# Coding\nMain coding.',
      },
    });

    const skills = await loadSkillsFromDB(docs, 'main', 'alice');
    expect(skills).toHaveLength(1);
    expect(skills[0].name).toBe('Coding');
  });

  test('supports subdirectory-style keys', async () => {
    const docs = createMockDocumentStore({
      skills: {
        'main/ops/deploy.md': '# Deploy Ops\nOps deploy skill.',
        'main/coding/python.md': '# Python Style\nPython coding guidelines.',
      },
    });

    const skills = await loadSkillsFromDB(docs, 'main', 'alice');
    expect(skills).toHaveLength(2);
    const paths = skills.map(s => s.path);
    expect(paths).toContain('ops/deploy.md');
    expect(paths).toContain('coding/python.md');
  });

  test('extracts description from first non-heading paragraph', async () => {
    const docs = createMockDocumentStore({
      skills: {
        'main/test.md': '# Test Skill\n\nThis is the description.\n\n## Details\nMore info.',
      },
    });

    const skills = await loadSkillsFromDB(docs, 'main', 'alice');
    expect(skills[0].description).toBe('This is the description.');
  });

  test('falls back to "No description" when no paragraph exists', async () => {
    const docs = createMockDocumentStore({
      skills: {
        'main/empty.md': '# Empty Skill',
      },
    });

    const skills = await loadSkillsFromDB(docs, 'main', 'alice');
    expect(skills[0].description).toBe('No description');
  });
});
