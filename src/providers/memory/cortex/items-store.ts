// src/providers/memory/cortex/items-store.ts — Kysely-backed CRUD for Cortex items
import { randomUUID } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import type { CortexItem } from './types.js';

/** Wildcard sentinel — means "all scopes", not a SQL pattern. */
export const SCOPE_WILDCARD = '*';

/** True when scope requires an exact-match SQL filter (not wildcard/empty). */
function isExactScope(scope: string): boolean {
  return !!scope && scope !== SCOPE_WILDCARD;
}

export class ItemsStore {
  constructor(private db: Kysely<any>) {}

  async insert(item: Omit<CortexItem, 'id'>): Promise<string> {
    const id = randomUUID();
    await this.db.insertInto('items')
      .values({
        id,
        content: item.content,
        memory_type: item.memoryType,
        category: item.category,
        content_hash: item.contentHash,
        source: item.source ?? null,
        confidence: item.confidence,
        reinforcement_count: item.reinforcementCount,
        last_reinforced_at: item.lastReinforcedAt,
        created_at: item.createdAt,
        updated_at: item.updatedAt,
        scope: item.scope,
        agent_id: item.agentId ?? null,
        user_id: item.userId ?? null,
        taint: item.taint ?? null,
        extra: item.extra ?? null,
      })
      .execute();
    return id;
  }

  async getById(id: string): Promise<CortexItem | null> {
    const row = await this.db.selectFrom('items')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    return row ? this.rowToItem(row as Record<string, unknown>) : null;
  }

  async findByHash(contentHash: string, scope: string, agentId?: string, userId?: string): Promise<CortexItem | null> {
    let query = this.db.selectFrom('items')
      .selectAll()
      .where('content_hash', '=', contentHash)
      .where('scope', '=', scope);

    if (agentId) {
      query = query.where('agent_id', '=', agentId);
    } else {
      query = query.where('agent_id', 'is', null);
    }

    if (userId) {
      query = query.where('user_id', '=', userId);
    } else {
      query = query.where('user_id', 'is', null);
    }

    const row = await query.executeTakeFirst();
    return row ? this.rowToItem(row as Record<string, unknown>) : null;
  }

  async reinforce(id: string): Promise<void> {
    const now = new Date().toISOString();
    await this.db.updateTable('items')
      .set({
        reinforcement_count: sql`reinforcement_count + 1` as any,
        last_reinforced_at: now,
        updated_at: now,
      })
      .where('id', '=', id)
      .execute();
  }

  async listByCategory(category: string, scope: string, limit?: number, userId?: string): Promise<CortexItem[]> {
    let query = this.db.selectFrom('items')
      .selectAll()
      .where('category', '=', category);

    if (isExactScope(scope)) {
      query = query.where('scope', '=', scope);
    }

    if (userId) {
      query = query.where(eb =>
        eb.or([eb('user_id', '=', userId), eb('user_id', 'is', null)]));
    }

    query = query.orderBy('created_at', 'desc');

    if (limit) {
      query = query.limit(limit);
    }

    const rows = await query.execute();
    return rows.map(r => this.rowToItem(r as Record<string, unknown>));
  }

  async listByScope(scope: string, limit?: number, agentId?: string, userId?: string): Promise<CortexItem[]> {
    let query = this.db.selectFrom('items')
      .selectAll();

    if (isExactScope(scope)) {
      query = query.where('scope', '=', scope);
    }

    if (agentId) {
      query = query.where('agent_id', '=', agentId);
    }

    if (userId) {
      query = query.where(eb =>
        eb.or([eb('user_id', '=', userId), eb('user_id', 'is', null)]));
    }

    query = query.orderBy('created_at', 'desc');

    if (limit) {
      query = query.limit(limit);
    }

    const rows = await query.execute();
    return rows.map(r => this.rowToItem(r as Record<string, unknown>));
  }

  async getAllForCategory(category: string, scope: string): Promise<CortexItem[]> {
    let query = this.db.selectFrom('items')
      .selectAll()
      .where('category', '=', category);

    if (isExactScope(scope)) {
      query = query.where('scope', '=', scope);
    }

    const rows = await query.orderBy('created_at', 'asc')
      .execute();
    return rows.map(r => this.rowToItem(r as Record<string, unknown>));
  }

  async searchContent(query: string, scope: string, limit = 50, userId?: string): Promise<CortexItem[]> {
    let q = this.db.selectFrom('items')
      .selectAll();

    if (isExactScope(scope)) {
      q = q.where('scope', '=', scope);
    }

    // Split into individual terms for OR matching.
    // Supports both "foo OR bar" (from extractQueryTerms) and "foo bar" (space-separated).
    const terms = query.includes(' OR ')
      ? query.split(' OR ').map(t => t.trim()).filter(Boolean)
      : query.split(/\s+/).filter(Boolean);
    if (terms.length > 1) {
      q = q.where(eb =>
        eb.or(terms.map(term => eb('content', 'like', `%${term}%`))));
    } else {
      q = q.where('content', 'like', `%${query}%`);
    }

    if (userId) {
      q = q.where(eb =>
        eb.or([eb('user_id', '=', userId), eb('user_id', 'is', null)]));
    }

    q = q.orderBy('created_at', 'desc').limit(limit);
    const rows = await q.execute();
    return rows.map(r => this.rowToItem(r as Record<string, unknown>));
  }

  async getByIds(ids: string[]): Promise<CortexItem[]> {
    if (ids.length === 0) return [];
    const rows = await this.db.selectFrom('items')
      .selectAll()
      .where('id', 'in', ids)
      .execute();
    return rows.map(r => this.rowToItem(r as Record<string, unknown>));
  }

  async listIdsByScope(scope: string): Promise<string[]> {
    let query = this.db.selectFrom('items')
      .select('id');

    if (isExactScope(scope)) {
      query = query.where('scope', '=', scope);
    }

    const rows = await query.execute();
    return rows.map(r => r.id as string);
  }

  async listAllScopes(): Promise<string[]> {
    const rows = await this.db.selectFrom('items')
      .select('scope')
      .distinct()
      .execute();
    return rows.map(r => r.scope as string);
  }

  async deleteById(id: string): Promise<void> {
    await this.db.deleteFrom('items')
      .where('id', '=', id)
      .execute();
  }

  async close(): Promise<void> {
    // No-op when using shared DatabaseProvider.
    // Only meaningful for standalone usage.
  }

  private rowToItem(row: Record<string, unknown>): CortexItem {
    return {
      id: row.id as string,
      content: row.content as string,
      memoryType: row.memory_type as CortexItem['memoryType'],
      category: row.category as string,
      contentHash: row.content_hash as string,
      source: (row.source as string) || undefined,
      confidence: row.confidence as number,
      reinforcementCount: row.reinforcement_count as number,
      lastReinforcedAt: row.last_reinforced_at as string,
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string,
      scope: row.scope as string,
      agentId: (row.agent_id as string) || undefined,
      userId: (row.user_id as string) || undefined,
      taint: (row.taint as string) || undefined,
      extra: (row.extra as string) || undefined,
    };
  }
}
