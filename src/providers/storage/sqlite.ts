// src/providers/storage/sqlite.ts — SQLite StorageProvider implementation
//
// Wraps the existing MessageQueue, ConversationStore, and SessionStore
// classes, plus a documents table for key-value storage.

import { mkdirSync } from 'node:fs';
import { openDatabase } from '../../utils/sqlite.js';
import type { SQLiteDatabase } from '../../utils/sqlite.js';
import { dataDir, dataFile } from '../../paths.js';
import { createKyselyDb } from '../../utils/database.js';
import { runMigrations } from '../../utils/migrator.js';
import { documentsMigrations } from '../../migrations/documents.js';
import { MessageQueue } from '../../db.js';
import { ConversationStore } from '../../conversation-store.js';
import { SessionStore } from '../../session-store.js';
import type { Config } from '../../types.js';
import type { StorageProvider, DocumentStore } from './types.js';

/**
 * Create a DocumentStore backed by a SQLite database.
 */
async function createDocumentStore(dbPath: string): Promise<{ store: DocumentStore; close: () => void }> {
  // Run migrations via Kysely (following existing pattern)
  const kyselyDb = createKyselyDb({ type: 'sqlite', path: dbPath });
  try {
    const result = await runMigrations(kyselyDb, documentsMigrations);
    if (result.error) throw result.error;
  } finally {
    await kyselyDb.destroy();
  }

  // Open a direct SQLite connection for runtime operations
  const db: SQLiteDatabase = openDatabase(dbPath);

  const store: DocumentStore = {
    async get(collection: string, key: string): Promise<string | undefined> {
      const row = db.prepare(
        'SELECT content FROM documents WHERE collection = ? AND key = ?'
      ).get(collection, key) as { content: string } | undefined;
      return row?.content;
    },

    async put(collection: string, key: string, content: string): Promise<void> {
      db.prepare(
        `INSERT OR REPLACE INTO documents (collection, key, content, updated_at)
         VALUES (?, ?, ?, datetime('now'))`
      ).run(collection, key, content);
    },

    async delete(collection: string, key: string): Promise<boolean> {
      // SQLite's better-sqlite3 .run() returns { changes }, but our adapter
      // doesn't expose it. Use a SELECT-then-DELETE approach.
      const exists = db.prepare(
        'SELECT 1 FROM documents WHERE collection = ? AND key = ?'
      ).get(collection, key);
      if (!exists) return false;
      db.prepare(
        'DELETE FROM documents WHERE collection = ? AND key = ?'
      ).run(collection, key);
      return true;
    },

    async list(collection: string): Promise<string[]> {
      const rows = db.prepare(
        'SELECT key FROM documents WHERE collection = ? ORDER BY key'
      ).all(collection) as Array<{ key: string }>;
      return rows.map(r => r.key);
    },
  };

  return {
    store,
    close: () => db.close(),
  };
}

/**
 * Create a SQLite-backed StorageProvider.
 *
 * Follows the standard provider contract: export a `create(config)` function.
 */
export async function create(_config: Config): Promise<StorageProvider> {
  mkdirSync(dataDir(), { recursive: true });

  // Create the three existing stores using their standard factory methods
  const messageQueue = await MessageQueue.create(dataFile('messages.db'));
  const conversationStore = await ConversationStore.create();
  const sessionStore = await SessionStore.create();

  // Create the document store
  const { store: documentStore, close: closeDocuments } = await createDocumentStore(
    dataFile('documents.db')
  );

  return {
    get messages() { return messageQueue; },
    get conversations() { return conversationStore; },
    get sessions() { return sessionStore; },
    get documents() { return documentStore; },

    close(): void {
      messageQueue.close();
      conversationStore.close();
      sessionStore.close();
      closeDocuments();
    },
  };
}
