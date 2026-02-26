import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FileStore } from '../../src/file-store.js';

describe('FileStore', () => {
  let store: FileStore;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ax-filestore-'));
    store = await FileStore.create(join(tmpDir, 'files.db'));
  });

  afterEach(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('register and lookup a file', () => {
    store.register('generated-abc.png', 'main', 'user1', 'image/png');
    const entry = store.lookup('generated-abc.png');
    expect(entry).toBeDefined();
    expect(entry!.fileId).toBe('generated-abc.png');
    expect(entry!.agentName).toBe('main');
    expect(entry!.userId).toBe('user1');
    expect(entry!.mimeType).toBe('image/png');
  });

  test('lookup returns undefined for unknown fileId', () => {
    const entry = store.lookup('nonexistent.png');
    expect(entry).toBeUndefined();
  });

  test('register with subdirectory fileId', () => {
    store.register('files/chart-001.png', 'main', 'vinay@example.com', 'image/png');
    const entry = store.lookup('files/chart-001.png');
    expect(entry).toBeDefined();
    expect(entry!.agentName).toBe('main');
    expect(entry!.userId).toBe('vinay@example.com');
  });

  test('register overwrites existing entry for same fileId', () => {
    store.register('img.png', 'agent1', 'user1', 'image/png');
    store.register('img.png', 'agent2', 'user2', 'image/jpeg');
    const entry = store.lookup('img.png');
    expect(entry!.agentName).toBe('agent2');
    expect(entry!.userId).toBe('user2');
    expect(entry!.mimeType).toBe('image/jpeg');
  });
});
