// src/agent/nats-ipc-client.ts — NATS-based IPC client for k8s sandbox pods.
//
// Drop-in replacement for IPCClient when running inside a k8s pod.
// Uses NATS request/reply on ipc.request.{sessionId} instead of Unix sockets.
// Selected by AX_IPC_TRANSPORT=nats env var in runner.ts.

import { getLogger } from '../logger.js';

const logger = getLogger().child({ component: 'nats-ipc-client' });

const DEFAULT_TIMEOUT_MS = 30_000;

export interface NATSIPCClientOptions {
  sessionId: string;
  natsUrl?: string;
  timeoutMs?: number;
  requestId?: string;
  userId?: string;
  sessionScope?: string;
}

export class NATSIPCClient {
  private sessionId: string;
  private natsUrl: string;
  private timeoutMs: number;
  private requestId?: string;
  private userId?: string;
  private sessionScope?: string;
  private nc: any = null;
  private subject: string;

  constructor(opts: NATSIPCClientOptions) {
    this.sessionId = opts.sessionId;
    this.natsUrl = opts.natsUrl ?? process.env.NATS_URL ?? 'nats://localhost:4222';
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.requestId = opts.requestId;
    this.userId = opts.userId;
    this.sessionScope = opts.sessionScope;
    this.subject = `ipc.request.${this.sessionId}`;
  }

  setContext(ctx: { sessionId?: string; requestId?: string; userId?: string; sessionScope?: string }): void {
    if (ctx.sessionId !== undefined) {
      this.sessionId = ctx.sessionId;
      this.subject = `ipc.request.${this.sessionId}`;
    }
    if (ctx.requestId !== undefined) this.requestId = ctx.requestId;
    if (ctx.userId !== undefined) this.userId = ctx.userId;
    if (ctx.sessionScope !== undefined) this.sessionScope = ctx.sessionScope;
  }

  async connect(): Promise<void> {
    if (this.nc) return;
    const natsModule = await import('nats');
    this.nc = await natsModule.connect({
      servers: this.natsUrl,
      name: `ax-ipc-${this.sessionId}`,
      reconnect: true,
      maxReconnectAttempts: -1,
      reconnectTimeWait: 1000,
    });
    logger.info('nats_connected', { sessionId: this.sessionId, subject: this.subject });
  }

  async call(request: Record<string, unknown>, callTimeoutMs?: number): Promise<Record<string, unknown>> {
    if (!this.nc) await this.connect();

    const enriched = {
      ...request,
      _sessionId: this.sessionId,
      ...(this.requestId ? { _requestId: this.requestId } : {}),
      ...(this.userId ? { _userId: this.userId } : {}),
      ...(this.sessionScope ? { _sessionScope: this.sessionScope } : {}),
    };

    const payload = new TextEncoder().encode(JSON.stringify(enriched));
    const effectiveTimeout = callTimeoutMs ?? this.timeoutMs;

    logger.debug('call_start', {
      action: request.action,
      subject: this.subject,
      timeoutMs: effectiveTimeout,
    });

    const response = await this.nc.request(this.subject, payload, {
      timeout: effectiveTimeout,
    });

    const result = JSON.parse(new TextDecoder().decode(response.data));
    logger.debug('call_done', { action: request.action });
    return result;
  }

  async disconnect(): Promise<void> {
    if (this.nc) {
      await this.nc.drain();
      this.nc = null;
    }
  }
}
