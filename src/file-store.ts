import { openDatabase } from './utils/sqlite.js';
import type { SQLiteDatabase } from './utils/sqlite.js';
import { dataFile } from './paths.js';
import { createKyselyDb } from './utils/database.js';
import { runMigrations } from './utils/migrator.js';
import { filesMigrations } from './migrations/files.js';

export interface FileEntry {
  fileId: string;
  agentName: string;
  userId: string;
  mimeType: string;
  createdAt: string;
}

export class FileStore {
  private db: SQLiteDatabase;

  private constructor(db: SQLiteDatabase) {
    this.db = db;
  }

  static async create(dbPath: string = dataFile('files.db')): Promise<FileStore> {
    const kyselyDb = createKyselyDb({ type: 'sqlite', path: dbPath });
    try {
      const result = await runMigrations(kyselyDb, filesMigrations);
      if (result.error) throw result.error;
    } finally {
      await kyselyDb.destroy();
    }
    const db = openDatabase(dbPath);
    return new FileStore(db);
  }

  /** Register a file mapping: fileId → (agentName, userId, mimeType). */
  register(fileId: string, agentName: string, userId: string, mimeType: string): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO files (file_id, agent_name, user_id, mime_type)
      VALUES (?, ?, ?, ?)
    `).run(fileId, agentName, userId, mimeType);
  }

  /** Look up a file by its globally unique fileId. */
  lookup(fileId: string): FileEntry | undefined {
    const row = this.db.prepare(
      'SELECT file_id, agent_name, user_id, mime_type, created_at FROM files WHERE file_id = ?'
    ).get(fileId) as { file_id: string; agent_name: string; user_id: string; mime_type: string; created_at: string } | undefined;
    if (!row) return undefined;
    return {
      fileId: row.file_id,
      agentName: row.agent_name,
      userId: row.user_id,
      mimeType: row.mime_type,
      createdAt: row.created_at,
    };
  }

  close(): void {
    this.db.close();
  }
}
