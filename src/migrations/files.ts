import { sql, type Kysely } from 'kysely';
import type { MigrationSet } from '../utils/migrator.js';

export const filesMigrations: MigrationSet = {
  files_001_initial: {
    async up(db: Kysely<any>) {
      await db.schema
        .createTable('files')
        .ifNotExists()
        .addColumn('file_id', 'text', col => col.primaryKey())
        .addColumn('agent_name', 'text', col => col.notNull())
        .addColumn('user_id', 'text', col => col.notNull())
        .addColumn('mime_type', 'text', col => col.notNull())
        .addColumn('created_at', 'text', col =>
          col.notNull().defaultTo(sql`(datetime('now'))`),
        )
        .execute();
    },
    async down(db: Kysely<any>) {
      await db.schema.dropTable('files').execute();
    },
  },
};
