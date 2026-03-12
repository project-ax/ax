/**
 * Session-scoped sandbox pool.
 *
 * Sandboxes persist for the session duration (keyed by persistentSessionId).
 * On each sandbox turn:
 *   - Check pool for existing session sandbox -> reuse
 *   - If none exists -> spawn new, add to pool
 *   - Idle sandboxes killed after timeout (default 5 minutes)
 */

import type { SandboxProcess } from '../providers/sandbox/types.js';
import { getLogger } from '../logger.js';

const logger = getLogger().child({ component: 'sandbox-pool' });

export interface PooledSandbox {
  sessionId: string;
  process: SandboxProcess;
  workspace: string;
  lastUsedAt: number;
  idleTimeoutMs: number;
}

const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

export class SandboxPool {
  private pool = new Map<string, PooledSandbox>();
  private cleanupInterval: ReturnType<typeof setInterval> | undefined;

  constructor(private idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS) {
    this.cleanupInterval = setInterval(() => this.evictIdle(), 30_000);
  }

  /** Get an existing sandbox for a session, or undefined if none exists. */
  get(sessionId: string): PooledSandbox | undefined {
    const entry = this.pool.get(sessionId);
    if (entry) {
      entry.lastUsedAt = Date.now();
      return entry;
    }
    return undefined;
  }

  /** Add a new sandbox to the pool. */
  add(sessionId: string, process: SandboxProcess, workspace: string): PooledSandbox {
    const entry: PooledSandbox = {
      sessionId,
      process,
      workspace,
      lastUsedAt: Date.now(),
      idleTimeoutMs: this.idleTimeoutMs,
    };
    this.pool.set(sessionId, entry);
    logger.debug('sandbox_pool_add', { sessionId, poolSize: this.pool.size });
    return entry;
  }

  /** Remove and kill a sandbox for a session. */
  async remove(sessionId: string): Promise<void> {
    const entry = this.pool.get(sessionId);
    if (entry) {
      this.pool.delete(sessionId);
      try {
        entry.process.kill();
      } catch { /* best effort */ }
      logger.debug('sandbox_pool_remove', { sessionId, poolSize: this.pool.size });
    }
  }

  /** Evict idle sandboxes. */
  private evictIdle(): void {
    const now = Date.now();
    for (const [sessionId, entry] of this.pool) {
      if (now - entry.lastUsedAt > entry.idleTimeoutMs) {
        logger.debug('sandbox_pool_evict', { sessionId, idleMs: now - entry.lastUsedAt });
        this.pool.delete(sessionId);
        try { entry.process.kill(); } catch { /* best effort */ }
      }
    }
  }

  /** Get current pool size. */
  get size(): number {
    return this.pool.size;
  }

  /** Shut down the pool — kill all sandboxes, clear interval. */
  async shutdown(): Promise<void> {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = undefined;
    }
    for (const [sessionId] of this.pool) {
      await this.remove(sessionId);
    }
  }
}
