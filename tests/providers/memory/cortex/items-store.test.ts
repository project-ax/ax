// tests/providers/memory/cortex/items-store.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ItemsStore } from '../../../../src/providers/memory/cortex/items-store.js';
import { createKyselyDb } from '../../../../src/utils/database.js';
import { runMigrations } from '../../../../src/utils/migrator.js';
import { memoryMigrations } from '../../../../src/providers/memory/cortex/migrations.js';
import type { CortexItem } from '../../../../src/providers/memory/cortex/types.js';
import type { Kysely } from 'kysely';

describe('ItemsStore', () => {
  let store: ItemsStore;
  let testDir: string;
  let db: Kysely<any>;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'memfs-test-'));
    db = createKyselyDb({ type: 'sqlite', path: join(testDir, '_store.db') });
    const result = await runMigrations(db, memoryMigrations('sqlite'));
    if (result.error) throw result.error;
    store = new ItemsStore(db);
  });

  afterEach(async () => {
    await store.close();
    await db.destroy();
    await rm(testDir, { recursive: true, force: true });
  });

  const sampleItem: Omit<CortexItem, 'id'> = {
    content: 'Prefers TypeScript over JavaScript',
    memoryType: 'profile',
    category: 'preferences',
    contentHash: 'a1b2c3d4e5f6g7h8',
    confidence: 0.95,
    reinforcementCount: 1,
    lastReinforcedAt: '2026-03-01T00:00:00Z',
    createdAt: '2026-03-01T00:00:00Z',
    updatedAt: '2026-03-01T00:00:00Z',
    scope: 'default',
  };

  it('inserts and reads an item', async () => {
    const id = await store.insert(sampleItem);
    const item = await store.getById(id);
    expect(item).not.toBeNull();
    expect(item!.content).toBe('Prefers TypeScript over JavaScript');
    expect(item!.memoryType).toBe('profile');
    expect(item!.reinforcementCount).toBe(1);
  });

  it('finds item by content hash within scope', async () => {
    await store.insert(sampleItem);
    const found = await store.findByHash('a1b2c3d4e5f6g7h8', 'default');
    expect(found).not.toBeNull();
    expect(found!.content).toBe(sampleItem.content);
  });

  it('returns null for hash in different scope', async () => {
    await store.insert(sampleItem);
    const found = await store.findByHash('a1b2c3d4e5f6g7h8', 'other-scope');
    expect(found).toBeNull();
  });

  it('reinforces existing item (increments count + updates timestamp)', async () => {
    const id = await store.insert(sampleItem);
    await store.reinforce(id);
    const item = await store.getById(id);
    expect(item!.reinforcementCount).toBe(2);
    expect(item!.lastReinforcedAt).not.toBe('2026-03-01T00:00:00Z');
  });

  it('lists items by category', async () => {
    await store.insert(sampleItem);
    await store.insert({ ...sampleItem, content: 'Uses vim', contentHash: 'bbbbbbbbbbbbbbbb' });
    await store.insert({ ...sampleItem, content: 'Runs on GKE', category: 'knowledge', contentHash: 'cccccccccccccccc' });
    const prefs = await store.listByCategory('preferences', 'default');
    expect(prefs).toHaveLength(2);
  });

  it('lists items by scope with limit', async () => {
    for (let i = 0; i < 20; i++) {
      await store.insert({ ...sampleItem, content: `Fact ${i}`, contentHash: `hash_${i.toString().padStart(12, '0')}` });
    }
    const limited = await store.listByScope('default', 5);
    expect(limited).toHaveLength(5);
  });

  it('deletes an item', async () => {
    const id = await store.insert(sampleItem);
    await store.deleteById(id);
    expect(await store.getById(id)).toBeNull();
  });

  it('searches content with LIKE', async () => {
    await store.insert(sampleItem);
    await store.insert({ ...sampleItem, content: 'Uses vim keybindings', contentHash: 'dddddddddddddddd' });
    const results = await store.searchContent('TypeScript', 'default');
    expect(results).toHaveLength(1);
    expect(results[0].content).toContain('TypeScript');
  });

  it('scopes queries by agentId when provided', async () => {
    await store.insert({ ...sampleItem, agentId: 'agent_1' });
    await store.insert({ ...sampleItem, content: 'Other agent fact', contentHash: 'eeeeeeeeeeeeeeee', agentId: 'agent_2' });
    const results = await store.listByScope('default', 50, 'agent_1');
    expect(results).toHaveLength(1);
  });

  it('getAllForCategory returns all items for summary generation', async () => {
    await store.insert(sampleItem);
    await store.insert({ ...sampleItem, content: 'Uses vim', contentHash: 'ffffffffffffffff' });
    const items = await store.getAllForCategory('preferences', 'default');
    expect(items).toHaveLength(2);
  });

  it('listAllScopes returns all distinct scopes', async () => {
    await store.insert({ ...sampleItem, scope: 'project-a' });
    await store.insert({ ...sampleItem, scope: 'project-b', contentHash: 'gggggggggggggggg' });
    await store.insert({ ...sampleItem, scope: 'project-a', contentHash: 'hhhhhhhhhhhhhhhh' });
    const scopes = await store.listAllScopes();
    expect(scopes.sort()).toEqual(['project-a', 'project-b']);
  });

  it('listAllScopes returns empty for empty store', async () => {
    expect(await store.listAllScopes()).toEqual([]);
  });

  // ── userId scoping ──

  it('findByHash isolates by userId', async () => {
    await store.insert({ ...sampleItem, userId: 'alice' });
    await store.insert({ ...sampleItem, content: 'Same hash different user', contentHash: 'a1b2c3d4e5f6g7h8', userId: 'bob' });

    const aliceItem = await store.findByHash('a1b2c3d4e5f6g7h8', 'default', undefined, 'alice');
    expect(aliceItem).not.toBeNull();
    expect(aliceItem!.userId).toBe('alice');

    const bobItem = await store.findByHash('a1b2c3d4e5f6g7h8', 'default', undefined, 'bob');
    expect(bobItem).not.toBeNull();
    expect(bobItem!.userId).toBe('bob');
  });

  it('findByHash with no userId matches only NULL userId items', async () => {
    await store.insert({ ...sampleItem, userId: 'alice' });
    await store.insert({ ...sampleItem, contentHash: 'shared_hash_12345' }); // no userId = shared

    const shared = await store.findByHash('shared_hash_12345', 'default');
    expect(shared).not.toBeNull();

    const userScoped = await store.findByHash('a1b2c3d4e5f6g7h8', 'default');
    expect(userScoped).toBeNull(); // userId='alice' does not match NULL
  });

  it('listByScope with userId returns own + shared items', async () => {
    await store.insert({ ...sampleItem, userId: 'alice' });
    await store.insert({ ...sampleItem, content: 'Shared fact', contentHash: 'shared_hash_12345' }); // shared
    await store.insert({ ...sampleItem, content: 'Bob fact', contentHash: 'bob_hash_12345678', userId: 'bob' });

    const aliceView = await store.listByScope('default', 50, undefined, 'alice');
    expect(aliceView).toHaveLength(2); // alice's own + shared
    const contents = aliceView.map(i => i.content);
    expect(contents).toContain('Prefers TypeScript over JavaScript'); // alice's
    expect(contents).toContain('Shared fact'); // shared
  });

  it('listByScope without userId returns all items (no user filter)', async () => {
    await store.insert({ ...sampleItem, userId: 'alice' });
    await store.insert({ ...sampleItem, content: 'Shared fact', contentHash: 'shared_hash_12345' });
    await store.insert({ ...sampleItem, content: 'Bob fact', contentHash: 'bob_hash_12345678', userId: 'bob' });

    const allView = await store.listByScope('default', 50);
    expect(allView).toHaveLength(3); // all items
  });

  it('searchContent with userId returns own + shared', async () => {
    await store.insert({ ...sampleItem, content: 'Alice likes TypeScript', userId: 'alice' });
    await store.insert({ ...sampleItem, content: 'TypeScript is shared knowledge', contentHash: 'shared_ts_123456' }); // shared
    await store.insert({ ...sampleItem, content: 'Bob uses TypeScript too', contentHash: 'bob_ts_12345678', userId: 'bob' });

    const aliceResults = await store.searchContent('TypeScript', 'default', 50, 'alice');
    expect(aliceResults).toHaveLength(2); // alice's + shared
    const contents = aliceResults.map(i => i.content);
    expect(contents).toContain('Alice likes TypeScript');
    expect(contents).toContain('TypeScript is shared knowledge');
    expect(contents).not.toContain('Bob uses TypeScript too');
  });

  it('listByCategory with userId returns own + shared', async () => {
    await store.insert({ ...sampleItem, userId: 'alice' });
    await store.insert({ ...sampleItem, content: 'Shared preference', contentHash: 'shared_pref_12345' }); // shared
    await store.insert({ ...sampleItem, content: 'Bob preference', contentHash: 'bob_pref_12345678', userId: 'bob' });

    const alicePrefs = await store.listByCategory('preferences', 'default', undefined, 'alice');
    expect(alicePrefs).toHaveLength(2); // alice's + shared
  });

  it('stores and retrieves userId field', async () => {
    const id = await store.insert({ ...sampleItem, userId: 'alice' });
    const item = await store.getById(id);
    expect(item!.userId).toBe('alice');
  });

  it('stores undefined userId as null', async () => {
    const id = await store.insert({ ...sampleItem });
    const item = await store.getById(id);
    expect(item!.userId).toBeUndefined();
  });

  // ── Wildcard scope ──

  it('listByScope with wildcard scope returns items from all scopes', async () => {
    await store.insert({ ...sampleItem, scope: 'project-a' });
    await store.insert({ ...sampleItem, scope: 'project-b', contentHash: 'bbbbbbbbbbbbbbbb' });
    await store.insert({ ...sampleItem, scope: 'default', contentHash: 'cccccccccccccccc' });

    const all = await store.listByScope('*', 50);
    expect(all).toHaveLength(3);
  });

  it('searchContent with wildcard scope searches across all scopes', async () => {
    await store.insert({ ...sampleItem, content: 'TypeScript in project A', scope: 'project-a' });
    await store.insert({ ...sampleItem, content: 'TypeScript in project B', scope: 'project-b', contentHash: 'bbbbbbbbbbbbbbbb' });
    await store.insert({ ...sampleItem, content: 'Uses vim', scope: 'default', contentHash: 'cccccccccccccccc' });

    const results = await store.searchContent('TypeScript', '*');
    expect(results).toHaveLength(2);
  });

  it('listByScope wildcard scope still filters by userId', async () => {
    await store.insert({ ...sampleItem, scope: 'project-a', userId: 'alice' });
    await store.insert({ ...sampleItem, scope: 'project-b', contentHash: 'bbbbbbbbbbbbbbbb', userId: 'bob' });
    await store.insert({ ...sampleItem, scope: 'default', contentHash: 'cccccccccccccccc' }); // shared

    const aliceView = await store.listByScope('*', 50, undefined, 'alice');
    expect(aliceView).toHaveLength(2); // alice's + shared
  });
});
