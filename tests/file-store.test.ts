import { describe, test, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FileStore } from '../src/file-store.js';
import { createKyselyDb } from '../src/utils/database.js';
import { runMigrations } from '../src/utils/migrator.js';
import { filesMigrations } from '../src/migrations/files.js';

describe('FileStore', () => {
  let tmpDir: string;
  let store: FileStore;

  afterEach(async () => {
    await store?.close();
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  test('register and lookup with filename', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ax-filestore-'));
    const db = createKyselyDb({ type: 'sqlite', path: join(tmpDir, 'files.db') });
    await runMigrations(db, filesMigrations);
    store = new FileStore(db);

    await store.register('files/abc.pdf', 'main', 'user1', 'application/pdf', 'report.pdf');
    const entry = await store.lookup('files/abc.pdf');

    expect(entry).toBeDefined();
    expect(entry!.filename).toBe('report.pdf');
    expect(entry!.mimeType).toBe('application/pdf');
  });

  test('register without filename defaults to empty string', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ax-filestore-'));
    const db = createKyselyDb({ type: 'sqlite', path: join(tmpDir, 'files.db') });
    await runMigrations(db, filesMigrations);
    store = new FileStore(db);

    await store.register('files/abc.png', 'main', 'user1', 'image/png');
    const entry = await store.lookup('files/abc.png');

    expect(entry).toBeDefined();
    expect(entry!.filename).toBe('');
  });
});
