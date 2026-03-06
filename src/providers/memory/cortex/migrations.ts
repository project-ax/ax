// src/providers/memory/cortex/migrations.ts — Dialect-aware memory migrations
import type { Kysely } from 'kysely';
import type { MigrationSet } from '../../../utils/migrator.js';

export function memoryMigrations(_dbType: 'sqlite' | 'postgresql'): MigrationSet {
  return {
    memory_001_items: {
      async up(db: Kysely<any>) {
        await db.schema
          .createTable('items')
          .ifNotExists()
          .addColumn('id', 'text', col => col.primaryKey())
          .addColumn('content', 'text', col => col.notNull())
          .addColumn('memory_type', 'text', col => col.notNull())
          .addColumn('category', 'text', col => col.notNull())
          .addColumn('content_hash', 'text', col => col.notNull())
          .addColumn('source', 'text')
          .addColumn('confidence', 'real', col => col.defaultTo(0.5))
          .addColumn('reinforcement_count', 'integer', col => col.defaultTo(1))
          .addColumn('last_reinforced_at', 'text')
          .addColumn('created_at', 'text', col => col.notNull())
          .addColumn('updated_at', 'text', col => col.notNull())
          .addColumn('scope', 'text', col => col.notNull().defaultTo('default'))
          .addColumn('agent_id', 'text')
          .addColumn('user_id', 'text')
          .addColumn('taint', 'text')
          .addColumn('extra', 'text')
          .execute();

        await db.schema.createIndex('idx_items_scope').ifNotExists()
          .on('items').column('scope').execute();
        await db.schema.createIndex('idx_items_category').ifNotExists()
          .on('items').columns(['category', 'scope']).execute();
        await db.schema.createIndex('idx_items_hash').ifNotExists()
          .on('items').columns(['content_hash', 'scope']).execute();
        await db.schema.createIndex('idx_items_agent').ifNotExists()
          .on('items').columns(['agent_id', 'scope']).execute();
        await db.schema.createIndex('idx_items_user').ifNotExists()
          .on('items').columns(['user_id', 'scope']).execute();
      },
      async down(db: Kysely<any>) {
        await db.schema.dropTable('items').ifExists().execute();
      },
    },

    memory_002_summaries: {
      async up(db: Kysely<any>) {
        await db.schema
          .createTable('cortex_summaries')
          .ifNotExists()
          .addColumn('category', 'text', col => col.notNull())
          .addColumn('user_id', 'text', col => col.notNull().defaultTo('__shared__'))
          .addColumn('content', 'text', col => col.notNull())
          .addColumn('updated_at', 'text', col => col.notNull())
          .execute();

        await db.schema.createIndex('idx_summaries_pk').ifNotExists()
          .on('cortex_summaries').columns(['category', 'user_id']).unique().execute();
      },
      async down(db: Kysely<any>) {
        await db.schema.dropTable('cortex_summaries').ifExists().execute();
      },
    },
  };
}
