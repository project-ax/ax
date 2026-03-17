#!/usr/bin/env npx tsx
/**
 * Test harness — run AX host with HTTP IPC transport.
 *
 * Like run-nats-local.ts but uses HTTP for IPC instead of NATS request/reply.
 * The agent uses HttpIPCClient to POST IPC requests to /internal/ipc.
 * NATS is still used for work delivery (sandbox.work queue group).
 *
 * Prerequisites:
 *   1. Local nats-server running: `nats-server`
 *   2. AX built: `npm run build`
 *
 * Usage:
 *   npx tsx tests/providers/sandbox/run-http-local.ts
 *
 * Debug agent process:
 *   AX_DEBUG_AGENT=1 npx tsx tests/providers/sandbox/run-http-local.ts
 *
 * Test with curl:
 *   curl -X POST http://localhost:8080/v1/chat/completions \
 *     -H "Content-Type: application/json" \
 *     -d '{"model":"default","messages":[{"role":"user","content":"hello"}]}'
 */

import { createServer as createHttpServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { loadConfig } from '../../../src/config.js';
import { loadProviders } from '../../../src/host/registry.js';
import { createIPCHandler, createIPCServer, type IPCContext } from '../../../src/host/ipc-server.js';
import { processCompletion, type CompletionDeps } from '../../../src/host/server-completions.js';
import { sendError, readBody } from '../../../src/host/server-http.js';
import { createRouter } from '../../../src/host/router.js';
import { TaintBudget, thresholdForProfile } from '../../../src/host/taint-budget.js';
import { dataDir, agentDir as agentDirPath, agentIdentityDir, agentIdentityFilesDir } from '../../../src/paths.js';
import { initLogger, getLogger } from '../../../src/logger.js';
import { FileStore } from '../../../src/file-store.js';
import { natsConnectOptions } from '../../../src/utils/nats.js';
import { create as createNATSSubprocess } from './nats-subprocess.js';

const logger = getLogger().child({ component: 'run-http-local' });

/**
 * Token registry: maps per-turn tokens to their bound IPC handler + context.
 * Same pattern as host-process.ts activeTokens.
 */
const activeTokens = new Map<string, {
  handleIPC: (raw: string, ctx: IPCContext) => Promise<string>;
  ctx: IPCContext;
}>();

/** Max staging upload size (50MB). */
const MAX_STAGING_BYTES = 50 * 1024 * 1024;

/** In-memory staging store for workspace uploads (same as host-process.ts). */
const stagingStore = new Map<string, { data: Buffer; createdAt: number }>();

async function main() {
  const port = parseInt(process.env.PORT ?? '8080', 10);

  initLogger({ level: (process.env.LOG_LEVEL as 'debug' | 'info' | 'warn' | 'error') ?? 'debug' });

  const config = loadConfig();

  // Create sandbox with HTTP IPC transport
  const sandbox = await createNATSSubprocess(config, { ipcTransport: 'http' });
  const providers = await loadProviders(config, { providerOverrides: { sandbox } });

  // NATS connection for work publishing
  const natsModule = await import('nats');
  const nc = await natsModule.connect(natsConnectOptions('host'));
  console.log('[run-http-local] NATS connected');

  // IPC + storage setup
  mkdirSync(dataDir(), { recursive: true });
  const db = providers.storage.messages;
  const conversationStore = providers.storage.conversations;
  const taintBudget = new TaintBudget({ threshold: thresholdForProfile(config.profile) });
  const router = createRouter(providers, db, { taintBudget });

  const ipcSocketDir = mkdtempSync(join(tmpdir(), 'ax-http-'));
  const ipcSocketPath = join(ipcSocketDir, 'proxy.sock');
  const sessionCanaries = new Map<string, string>();
  const workspaceMap = new Map<string, string>();
  const defaultUserId = process.env.USER ?? 'default';

  const agentName = 'main';
  const identityFilesDir = agentIdentityFilesDir(agentName);
  mkdirSync(agentDirPath(agentName), { recursive: true });
  mkdirSync(agentIdentityDir(agentName), { recursive: true });
  mkdirSync(identityFilesDir, { recursive: true });

  const fileStore = await FileStore.create(providers.database);

  const handleIPC = createIPCHandler(providers, {
    taintBudget,
    agentDir: identityFilesDir,
    agentName,
    profile: config.profile,
    configModel: config.models?.default?.[0],
    workspaceMap,
  });

  // IPC server (Unix socket fallback — not used in HTTP mode, but processCompletion expects it)
  await createIPCServer(ipcSocketPath, handleIPC, {
    sessionId: 'server',
    agentId: 'system',
    userId: defaultUserId,
  });

  const completionDeps: CompletionDeps = {
    config,
    providers,
    db,
    conversationStore,
    router,
    taintBudget,
    sessionCanaries,
    ipcSocketPath,
    ipcSocketDir,
    logger,
    verbose: true,
    fileStore,
    workspaceMap,
  };

  // ── HTTP Server ──

  const httpServer = createHttpServer(async (req: IncomingMessage, res: ServerResponse) => {
    // CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = req.url ?? '/';

    // ── Health check ──
    if (url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
      return;
    }

    // ── IPC over HTTP (agent → host) ──
    if (url === '/internal/ipc' && req.method === 'POST') {
      const token = req.headers.authorization?.replace('Bearer ', '');
      const entry = token ? activeTokens.get(token) : undefined;
      if (!entry) {
        console.log(`[run-http-local] /internal/ipc: invalid token (${token?.slice(0, 8)}...)`);
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid token' }));
        return;
      }
      try {
        const body = await readBody(req, 1_048_576);
        const parsed = JSON.parse(body);
        console.log(`[run-http-local] /internal/ipc: action=${parsed.action}`);
        const result = await entry.handleIPC(body, entry.ctx);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(result);
      } catch (err) {
        console.error('[run-http-local] IPC error:', err);
        if (!res.headersSent) sendError(res, 500, 'IPC request failed');
      }
      return;
    }

    // ── LLM proxy over HTTP (agent → Anthropic API via host) ──
    // claude-code runner sets ANTHROPIC_BASE_URL to ${AX_HOST_URL}/internal/llm-proxy
    // and uses the per-turn token as ANTHROPIC_API_KEY (x-api-key header).
    if (url.startsWith('/internal/llm-proxy/') && req.method === 'POST') {
      const token = req.headers['x-api-key'] as string;
      const entry = token ? activeTokens.get(token) : undefined;
      if (!entry) {
        console.log(`[run-http-local] /internal/llm-proxy: invalid token (${token?.slice(0, 8)}...)`);
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid token' }));
        return;
      }
      try {
        const targetPath = url.replace('/internal/llm-proxy', '');
        const body = await readBody(req, 10_485_760); // 10MB
        console.log(`[run-http-local] /internal/llm-proxy: ${targetPath} (${body.length} bytes)`);
        const { forwardLLMRequest } = await import('../../../src/host/llm-proxy-core.js');
        await forwardLLMRequest({
          targetPath,
          body,
          incomingHeaders: req.headers,
          res,
        });
      } catch (err) {
        console.error('[run-http-local] LLM proxy error:', err);
        if (!res.headersSent) sendError(res, 502, 'LLM proxy request failed');
      }
      return;
    }

    // ── Direct workspace release from agent (k8s HTTP mode) ──
    // Agent POSTs gzipped changes with bearer token auth.
    if (url === '/internal/workspace/release' && req.method === 'POST') {
      const token = req.headers.authorization?.replace('Bearer ', '');
      const entry = token ? activeTokens.get(token) : undefined;
      if (!entry) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid token' }));
        return;
      }
      try {
        const chunks: Buffer[] = [];
        let totalSize = 0;
        for await (const chunk of req) {
          totalSize += (chunk as Buffer).length;
          if (totalSize > MAX_STAGING_BYTES) {
            sendError(res, 413, 'Payload too large');
            return;
          }
          chunks.push(chunk as Buffer);
        }
        const compressed = Buffer.concat(chunks);
        const json = gunzipSync(compressed).toString('utf-8');
        const payload = JSON.parse(json) as { changes: Array<{ scope: string; path: string; type: string; content_base64?: string; size: number }> };
        const changes = (payload.changes ?? []).map((c: any) => ({
          scope: c.scope as 'agent' | 'user' | 'session',
          path: c.path,
          type: c.type as 'added' | 'modified' | 'deleted',
          content: c.content_base64 ? Buffer.from(c.content_base64, 'base64') : undefined,
          size: c.size,
        }));

        if (providers.workspace?.setRemoteChanges) {
          providers.workspace.setRemoteChanges(entry.ctx.sessionId, changes);
        }

        console.log(`[run-http-local] /internal/workspace/release: ${changes.length} changes`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, changeCount: changes.length }));
      } catch (err) {
        console.error('[run-http-local] Workspace release error:', err);
        if (!res.headersSent) sendError(res, 500, 'Workspace release failed');
      }
      return;
    }

    // ── Workspace staging upload (legacy path) ──
    // Agent uploads gzipped data, gets back staging_key for later IPC workspace_release.
    if (url === '/internal/workspace-staging' && req.method === 'POST') {
      try {
        const chunks: Buffer[] = [];
        let totalSize = 0;
        for await (const chunk of req) {
          totalSize += (chunk as Buffer).length;
          if (totalSize > MAX_STAGING_BYTES) {
            sendError(res, 413, 'Staging payload too large');
            return;
          }
          chunks.push(chunk as Buffer);
        }
        const body = Buffer.concat(chunks);
        if (body.length === 0) {
          sendError(res, 400, 'Empty staging payload');
          return;
        }
        const key = randomUUID();
        stagingStore.set(key, { data: body, createdAt: Date.now() });
        console.log(`[run-http-local] /internal/workspace-staging: key=${key} (${body.length} bytes)`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ staging_key: key }));
      } catch (err) {
        console.error('[run-http-local] Workspace staging error:', err);
        if (!res.headersSent) sendError(res, 500, 'Staging upload failed');
      }
      return;
    }

    // ── Chat completions (simplified — non-streaming only) ──
    if (url === '/v1/chat/completions' && req.method === 'POST') {
      try {
        const body = await readBody(req, 1_048_576);
        const chatReq = JSON.parse(body);
        const messages = chatReq.messages ?? [];
        const lastMsg = messages[messages.length - 1];
        const content = lastMsg?.content ?? '';
        const requestId = randomUUID().slice(0, 8);
        const sessionId = chatReq.session_id ?? `test-${requestId}`;
        const turnToken = randomUUID();

        console.log(`[run-http-local] /v1/chat/completions: requestId=${requestId}, sessionId=${sessionId}`);

        // Set up agent_response interceptor
        let agentResponseResolve: ((content: string) => void) | undefined;
        let agentResponseReject: ((err: Error) => void) | undefined;
        const agentResponsePromise = new Promise<string>((resolve, reject) => {
          agentResponseResolve = resolve;
          agentResponseReject = reject;
        });

        // Safety timeout
        const timeoutMs = ((config.sandbox.timeout_sec ?? 600) + 60) * 1000;
        const timer = setTimeout(() => {
          agentResponseReject?.(new Error('agent_response timeout'));
        }, timeoutMs);
        if (timer.unref) timer.unref();
        agentResponsePromise.catch(() => {}); // prevent unhandled rejection

        // Wrap handleIPC to intercept workspace_release and agent_response
        const wrappedHandleIPC = async (raw: string, ctx: IPCContext): Promise<string> => {
          try {
            const parsed = JSON.parse(raw);

            // Intercept workspace_release: look up staged changes by key
            if (parsed.action === 'workspace_release') {
              const stagingKey = parsed.staging_key as string;
              const staged = stagingStore.get(stagingKey);
              if (!staged) {
                console.log(`[run-http-local] workspace_release: staging_key not found (${stagingKey})`);
                return JSON.stringify({ ok: false, error: 'staging_key not found' });
              }
              stagingStore.delete(stagingKey);
              const json = gunzipSync(staged.data).toString('utf-8');
              const payload = JSON.parse(json) as { changes: Array<{ scope: string; path: string; type: string; content_base64?: string; size: number }> };
              const changes = (payload.changes ?? []).map((c: any) => ({
                scope: c.scope as 'agent' | 'user' | 'session',
                path: c.path,
                type: c.type as 'added' | 'modified' | 'deleted',
                content: c.content_base64 ? Buffer.from(c.content_base64, 'base64') : undefined,
                size: c.size,
              }));
              if (providers.workspace?.setRemoteChanges) {
                providers.workspace.setRemoteChanges(sessionId, changes);
              }
              console.log(`[run-http-local] workspace_release: ${changes.length} changes from staging`);
              return JSON.stringify({ ok: true });
            }

            if (parsed.action === 'agent_response') {
              console.log(`[run-http-local] agent_response received (${(parsed.content ?? '').length} bytes)`);
              agentResponseResolve?.(parsed.content ?? '');
              return JSON.stringify({ ok: true });
            }
          } catch {
            // Not JSON — fall through
          }
          return handleIPC(raw, ctx);
        };

        // Register token for this turn
        activeTokens.set(turnToken, {
          handleIPC: wrappedHandleIPC,
          ctx: { sessionId, agentId: 'main', userId: defaultUserId },
        });
        console.log(`[run-http-local] Token registered: ${turnToken.slice(0, 8)}...`);

        // NATS work publisher — retry until agent has subscribed
        const publishWork = async (_podName: string | undefined, payload: string): Promise<string> => {
          const maxRetries = 30;
          for (let i = 0; i < maxRetries; i++) {
            try {
              console.log(`[run-http-local] Publishing work via NATS sandbox.work (attempt ${i + 1}, ${payload.length} bytes)`);
              const reply = await nc.request('sandbox.work', new TextEncoder().encode(payload), { timeout: 2000 });
              const { podName: claimedPod } = JSON.parse(new TextDecoder().decode(reply.data));
              console.log(`[run-http-local] Work claimed by: ${claimedPod}`);
              return claimedPod;
            } catch {
              console.log(`[run-http-local] No NATS subscriber yet, retrying in 1s...`);
              await new Promise(r => setTimeout(r, 1000));
            }
          }
          throw new Error('Failed to deliver work — no NATS subscriber after 30 retries');
        };

        const turnDeps: CompletionDeps = {
          ...completionDeps,
          extraSandboxEnv: {
            AX_IPC_TOKEN: turnToken,
            AX_IPC_REQUEST_ID: requestId,
            AX_HOST_URL: `http://localhost:${port}`,
          },
          agentResponsePromise,
          publishWork,
        };

        try {
          const result = await processCompletion(
            turnDeps, content, requestId, messages, sessionId, undefined, defaultUserId,
          );

          console.log(`[run-http-local] Completion done: ${result.responseContent.length} bytes`);

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            id: `chatcmpl-${requestId}`,
            object: 'chat.completion',
            created: Math.floor(Date.now() / 1000),
            model: 'default',
            choices: [{
              index: 0,
              message: { role: 'assistant', content: result.responseContent },
              finish_reason: result.finishReason === 'stop' ? 'stop' : 'content_filter',
            }],
          }));
        } finally {
          clearTimeout(timer);
          activeTokens.delete(turnToken);
        }
      } catch (err) {
        console.error('[run-http-local] Completion error:', err);
        if (!res.headersSent) sendError(res, 500, 'Completion failed');
      }
      return;
    }

    sendError(res, 404, 'Not found');
  });

  httpServer.listen(port, () => {
    console.log(`[run-http-local] AX listening on http://localhost:${port}`);
    console.log('[run-http-local] IPC transport: HTTP (HttpIPCClient)');
    console.log('[run-http-local] Work delivery: NATS (sandbox.work queue group)');
    console.log('[run-http-local] Routes: /internal/ipc, /internal/llm-proxy/*, /internal/workspace/release, /internal/workspace-staging');
    console.log('[run-http-local]');
    console.log('[run-http-local] Test with:');
    console.log(`[run-http-local]   curl -X POST http://localhost:${port}/v1/chat/completions \\`);
    console.log('[run-http-local]     -H "Content-Type: application/json" \\');
    console.log('[run-http-local]     -d \'{"model":"default","messages":[{"role":"user","content":"hello"}]}\'');
  });

  // Graceful shutdown
  const shutdown = async () => {
    console.log('[run-http-local] Shutting down...');
    httpServer.close();
    await nc.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('[run-http-local] Fatal:', err);
  process.exit(1);
});
