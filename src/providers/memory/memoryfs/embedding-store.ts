/**
 * EmbeddingStore — Vector store backed by sqlite-vec's vec0 virtual table.
 *
 * Uses @dao-xyz/sqlite3-vec to auto-load the sqlite-vec extension into
 * better-sqlite3. Stores embedding vectors alongside item IDs and supports
 * nearest-neighbor similarity search.
 *
 * Separate from ItemsStore — operates on its own database file (_vec.db)
 * to avoid extension compatibility issues with the existing SQLite adapter.
 */

import { createDatabase, type Database, type Statement } from '@dao-xyz/sqlite3-vec';
import { getLogger } from '../../../logger.js';

const logger = getLogger().child({ component: 'embedding-store' });

export interface SimilarityResult {
  itemId: string;
  distance: number;
}

export class EmbeddingStore {
  private db: Database | null = null;
  private readonly dbPath: string;
  readonly dimensions: number;
  private _ready: Promise<void>;

  constructor(dbPath: string, dimensions: number) {
    this.dbPath = dbPath;
    this.dimensions = dimensions;
    this._ready = this.init();
  }

  private async init(): Promise<void> {
    this.db = await createDatabase({ database: this.dbPath });
    this.db.open();

    // Metadata table for scope filtering + tracking which items have embeddings
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS embedding_meta (
        item_id    TEXT PRIMARY KEY,
        scope      TEXT NOT NULL,
        created_at TEXT NOT NULL
      )
    `);
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_emeta_scope ON embedding_meta(scope)');

    // vec0 virtual table for vector similarity search
    this.db.exec(
      `CREATE VIRTUAL TABLE IF NOT EXISTS item_embeddings USING vec0(embedding float[${this.dimensions}])`,
    );

    // Mapping table: vec0 rowid -> item_id (vec0 uses integer rowids internally)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS embedding_rowmap (
        rowid   INTEGER PRIMARY KEY,
        item_id TEXT NOT NULL UNIQUE
      )
    `);
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_rowmap_item ON embedding_rowmap(item_id)');

    logger.debug('init', { dbPath: this.dbPath, dimensions: this.dimensions });
  }

  /** Wait for initialization to complete. */
  async ready(): Promise<void> {
    await this._ready;
  }

  /** Insert or update an embedding for the given item. */
  async upsert(itemId: string, scope: string, embedding: Float32Array): Promise<void> {
    await this._ready;
    const db = this.db!;

    // Check if item already has an embedding
    const existingStmt = await db.prepare(
      'SELECT rowid FROM embedding_rowmap WHERE item_id = ?',
    );
    const existing = existingStmt.get([itemId]) as { rowid: number } | undefined;

    if (existing) {
      // Update existing embedding
      const updateStmt = await db.prepare(
        'UPDATE item_embeddings SET embedding = ? WHERE rowid = ?',
      );
      updateStmt.run([embedding, existing.rowid]);
    } else {
      // Insert new embedding — vec0 auto-assigns rowid
      const insertVecStmt = await db.prepare(
        'INSERT INTO item_embeddings(embedding) VALUES (?)',
      );
      insertVecStmt.run([embedding]);

      // Get the auto-assigned rowid
      const lastRowStmt = await db.prepare('SELECT last_insert_rowid() as rid');
      const lastRow = lastRowStmt.get() as { rid: number };

      // Map rowid -> item_id
      const mapStmt = await db.prepare(
        'INSERT INTO embedding_rowmap(rowid, item_id) VALUES (?, ?)',
      );
      mapStmt.run([lastRow.rid, itemId]);
    }

    // Upsert metadata
    const metaStmt = await db.prepare(
      `INSERT INTO embedding_meta(item_id, scope, created_at)
       VALUES (?, ?, ?)
       ON CONFLICT(item_id) DO UPDATE SET scope = excluded.scope`,
    );
    metaStmt.run([itemId, scope, new Date().toISOString()]);
  }

  /**
   * Find items most similar to the query vector.
   * Returns results ordered by ascending distance (closest first).
   */
  async findSimilar(
    query: Float32Array,
    limit: number,
    scope?: string,
  ): Promise<SimilarityResult[]> {
    await this._ready;
    const db = this.db!;

    if (scope && scope !== '*') {
      // Scope-filtered query: get candidate rowids from meta, then vector search
      // vec0 WHERE clause supports rowid IN (...) for pre-filtering
      const scopeStmt = await db.prepare(
        'SELECT r.rowid FROM embedding_meta m JOIN embedding_rowmap r ON r.item_id = m.item_id WHERE m.scope = ?',
      );
      const scopeRows = scopeStmt.all([scope]) as Array<{ rowid: number }>;

      if (scopeRows.length === 0) return [];

      // For small result sets, do vector search on all then filter
      // For larger sets, we'd want to pre-filter but vec0 doesn't support arbitrary WHERE
      // Simple approach: search broadly, then filter by scope
      const searchStmt = await db.prepare(
        `SELECT rowid, distance FROM item_embeddings WHERE embedding MATCH ? ORDER BY distance LIMIT ?`,
      );
      const results = searchStmt.all([query, limit * 3]) as Array<{ rowid: number; distance: number }>;

      const scopeRowSet = new Set(scopeRows.map(r => r.rowid));
      const filtered = results.filter(r => scopeRowSet.has(r.rowid));

      // Map rowids to item IDs
      const output: SimilarityResult[] = [];
      for (const row of filtered.slice(0, limit)) {
        const mapStmt = await db.prepare('SELECT item_id FROM embedding_rowmap WHERE rowid = ?');
        const mapped = mapStmt.get([row.rowid]) as { item_id: string } | undefined;
        if (mapped) {
          output.push({ itemId: mapped.item_id, distance: row.distance });
        }
      }
      return output;
    }

    // Unscoped: straight vector search
    const searchStmt = await db.prepare(
      `SELECT rowid, distance FROM item_embeddings WHERE embedding MATCH ? ORDER BY distance LIMIT ?`,
    );
    const results = searchStmt.all([query, limit]) as Array<{ rowid: number; distance: number }>;

    const output: SimilarityResult[] = [];
    for (const row of results) {
      const mapStmt = await db.prepare('SELECT item_id FROM embedding_rowmap WHERE rowid = ?');
      const mapped = mapStmt.get([row.rowid]) as { item_id: string } | undefined;
      if (mapped) {
        output.push({ itemId: mapped.item_id, distance: row.distance });
      }
    }
    return output;
  }

  /** Check if an item has an embedding stored. */
  async hasEmbedding(itemId: string): Promise<boolean> {
    await this._ready;
    const stmt = await this.db!.prepare('SELECT 1 FROM embedding_meta WHERE item_id = ?');
    return stmt.get([itemId]) !== undefined;
  }

  /** Delete embedding for a given item. */
  async delete(itemId: string): Promise<void> {
    await this._ready;
    const db = this.db!;

    // Find the rowid for this item
    const mapStmt = await db.prepare('SELECT rowid FROM embedding_rowmap WHERE item_id = ?');
    const mapped = mapStmt.get([itemId]) as { rowid: number } | undefined;

    if (mapped) {
      const delVecStmt = await db.prepare('DELETE FROM item_embeddings WHERE rowid = ?');
      delVecStmt.run([mapped.rowid]);
      const delMapStmt = await db.prepare('DELETE FROM embedding_rowmap WHERE item_id = ?');
      delMapStmt.run([itemId]);
    }

    const delMetaStmt = await db.prepare('DELETE FROM embedding_meta WHERE item_id = ?');
    delMetaStmt.run([itemId]);
  }

  /**
   * List item IDs that exist in a given set but have no embedding yet.
   * Used for backfill.
   */
  async listUnembedded(allItemIds: string[]): Promise<string[]> {
    await this._ready;
    if (allItemIds.length === 0) return [];

    const embedded = new Set<string>();
    // Batch check in groups to avoid huge SQL queries
    const batchSize = 100;
    for (let i = 0; i < allItemIds.length; i += batchSize) {
      const batch = allItemIds.slice(i, i + batchSize);
      const placeholders = batch.map(() => '?').join(',');
      const stmt = await this.db!.prepare(
        `SELECT item_id FROM embedding_meta WHERE item_id IN (${placeholders})`,
      );
      const rows = stmt.all(batch) as Array<{ item_id: string }>;
      for (const row of rows) embedded.add(row.item_id);
    }

    return allItemIds.filter(id => !embedded.has(id));
  }

  /** Close the database connection. */
  async close(): Promise<void> {
    await this._ready;
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }
}
