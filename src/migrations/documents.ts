// src/migrations/documents.ts — migration definitions for the document store
import { sql, type Kysely } from 'kysely';
import type { MigrationSet } from '../utils/migrator.js';

export const documentsMigrations: MigrationSet = {
  documents_001_initial: {
    async up(db: Kysely<any>) {
      // Use raw SQL to get composite PRIMARY KEY and all required columns
      await sql`
        CREATE TABLE IF NOT EXISTS documents (
          collection TEXT NOT NULL,
          key        TEXT NOT NULL,
          content    TEXT NOT NULL,
          data       BLOB,
          updated_at TEXT NOT NULL DEFAULT (datetime('now')),
          PRIMARY KEY (collection, key)
        )
      `.execute(db);
    },
    async down(db: Kysely<any>) {
      await db.schema.dropTable('documents').execute();
    },
  },
};
