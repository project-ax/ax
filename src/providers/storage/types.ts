// src/providers/storage/types.ts — StorageProvider interface
//
// Abstracts the three existing SQLite stores (messages, conversations,
// sessions) plus a key-value document store behind a single provider
// interface. Phase 1 uses SQLite; Phase 2 will add a PostgreSQL
// implementation for k8s deployments.

import type { MessageQueue } from '../../db.js';
import type { ConversationStore } from '../../conversation-store.js';
import type { SessionStore } from '../../session-store.js';

/**
 * Key-value document storage for identity files, skills, config, etc.
 *
 * Documents are organized by collection (e.g. 'identity', 'skills', 'config')
 * and keyed by a unique string within each collection.
 *
 * Phase 1 (SQLite): backed by a `documents` table.
 * Phase 2 (PostgreSQL): backed by a PostgreSQL table or JSONB.
 */
export interface DocumentStore {
  /** Retrieve a document by collection and key. Returns undefined if not found. */
  get(collection: string, key: string): Promise<string | undefined>;

  /** Store or update a document. */
  put(collection: string, key: string, content: string): Promise<void>;

  /** Delete a document. Returns true if the document existed. */
  delete(collection: string, key: string): Promise<boolean>;

  /** List all keys in a collection. */
  list(collection: string): Promise<string[]>;
}

/**
 * StorageProvider — unified access to all persistent storage.
 *
 * Wraps the existing MessageQueue, ConversationStore, and SessionStore
 * behind a single provider interface, plus a key-value document store
 * for Phase 2 use.
 */
export interface StorageProvider {
  /** Message queue (enqueue/dequeue/complete/fail/pending). */
  readonly messages: MessageQueue;

  /** Conversation history store (append/load/prune/count/clear). */
  readonly conversations: ConversationStore;

  /** Session tracking store (trackSession/getLastChannelSession). */
  readonly sessions: SessionStore;

  /** Key-value document store (identity files, skills, config). */
  readonly documents: DocumentStore;

  /** Close all underlying database connections. */
  close(): void;
}
