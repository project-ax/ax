import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { create } from '../../../src/providers/storage/sqlite.js';
import { rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import type { StorageProvider } from '../../../src/providers/storage/types.js';
import type { Config } from '../../../src/types.js';

const config = {} as Config;

describe('storage-sqlite', () => {
  let storage: StorageProvider;
  let testHome: string;

  beforeEach(async () => {
    testHome = join(tmpdir(), `ax-storage-test-${randomUUID()}`);
    mkdirSync(testHome, { recursive: true });
    process.env.AX_HOME = testHome;
    storage = await create(config);
  });

  afterEach(() => {
    try { storage.close(); } catch {}
    try { rmSync(testHome, { recursive: true, force: true }); } catch {}
    delete process.env.AX_HOME;
  });

  // ── Provider structure ──

  test('exposes messages, conversations, sessions, documents sub-stores', () => {
    expect(storage.messages).toBeDefined();
    expect(storage.conversations).toBeDefined();
    expect(storage.sessions).toBeDefined();
    expect(storage.documents).toBeDefined();
  });

  // ── MessageQueue wrapper ──

  test('messages: enqueue and dequeue', () => {
    const id = storage.messages.enqueue({
      sessionId: 's1', channel: 'cli', sender: 'user', content: 'hello',
    });
    expect(id).toMatch(/^[a-f0-9-]{36}$/);

    const msg = storage.messages.dequeue();
    expect(msg).not.toBeNull();
    expect(msg!.content).toBe('hello');
    expect(msg!.status).toBe('processing');
  });

  test('messages: pending count', () => {
    expect(storage.messages.pending()).toBe(0);
    storage.messages.enqueue({
      sessionId: 's1', channel: 'cli', sender: 'user', content: 'a',
    });
    expect(storage.messages.pending()).toBe(1);
  });

  // ── ConversationStore wrapper ──

  test('conversations: append and load', () => {
    storage.conversations.append('s1', 'user', 'hello');
    storage.conversations.append('s1', 'assistant', 'hi there');

    const turns = storage.conversations.load('s1');
    expect(turns).toHaveLength(2);
    expect(turns[0].role).toBe('user');
    expect(turns[0].content).toBe('hello');
    expect(turns[1].role).toBe('assistant');
    expect(turns[1].content).toBe('hi there');
  });

  test('conversations: count and clear', () => {
    storage.conversations.append('s1', 'user', 'hello');
    storage.conversations.append('s1', 'assistant', 'hi');
    expect(storage.conversations.count('s1')).toBe(2);

    storage.conversations.clear('s1');
    expect(storage.conversations.count('s1')).toBe(0);
  });

  // ── SessionStore wrapper ──

  test('sessions: track and retrieve', () => {
    const session = {
      provider: 'slack',
      scope: 'channel' as const,
      identifiers: { channel: 'C123', workspace: 'W456' },
    };
    storage.sessions.trackSession('agent-1', session);

    const result = storage.sessions.getLastChannelSession('agent-1');
    expect(result).toEqual(session);
  });

  test('sessions: returns undefined when no session tracked', () => {
    const result = storage.sessions.getLastChannelSession('agent-none');
    expect(result).toBeUndefined();
  });

  // ── DocumentStore ──

  test('documents: put and get', async () => {
    await storage.documents.put('identity', 'SOUL.md', '# Soul\nI am an agent.');
    const content = await storage.documents.get('identity', 'SOUL.md');
    expect(content).toBe('# Soul\nI am an agent.');
  });

  test('documents: get returns undefined for non-existent key', async () => {
    const content = await storage.documents.get('identity', 'NOPE.md');
    expect(content).toBeUndefined();
  });

  test('documents: put overwrites existing document', async () => {
    await storage.documents.put('config', 'settings.json', '{"v":1}');
    await storage.documents.put('config', 'settings.json', '{"v":2}');
    const content = await storage.documents.get('config', 'settings.json');
    expect(content).toBe('{"v":2}');
  });

  test('documents: delete returns true for existing document', async () => {
    await storage.documents.put('skills', 'math.md', '# Math skill');
    const result = await storage.documents.delete('skills', 'math.md');
    expect(result).toBe(true);

    // Verify it's actually gone
    const content = await storage.documents.get('skills', 'math.md');
    expect(content).toBeUndefined();
  });

  test('documents: delete returns false for non-existent document', async () => {
    const result = await storage.documents.delete('skills', 'nope.md');
    expect(result).toBe(false);
  });

  test('documents: list returns keys in a collection', async () => {
    await storage.documents.put('identity', 'SOUL.md', 'soul');
    await storage.documents.put('identity', 'IDENTITY.md', 'identity');
    await storage.documents.put('config', 'settings.json', 'config');

    const identityKeys = await storage.documents.list('identity');
    expect(identityKeys).toEqual(['IDENTITY.md', 'SOUL.md']); // sorted

    const configKeys = await storage.documents.list('config');
    expect(configKeys).toEqual(['settings.json']);
  });

  test('documents: list returns empty array for empty collection', async () => {
    const keys = await storage.documents.list('nonexistent');
    expect(keys).toEqual([]);
  });

  test('documents: collections are isolated', async () => {
    await storage.documents.put('a', 'key1', 'value-a');
    await storage.documents.put('b', 'key1', 'value-b');

    expect(await storage.documents.get('a', 'key1')).toBe('value-a');
    expect(await storage.documents.get('b', 'key1')).toBe('value-b');
  });

  // ── close() ──

  test('close does not throw', () => {
    expect(() => storage.close()).not.toThrow();
  });
});
