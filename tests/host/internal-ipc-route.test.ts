// tests/host/internal-ipc-route.test.ts — Tests for /internal/ipc HTTP route.

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { initLogger } from '../../src/logger.js';

initLogger({ level: 'silent', file: false });

// Simulate the activeTokens registry and /internal/ipc route handler
// extracted from host-process.ts for unit testing.

interface IPCContext {
  sessionId: string;
  agentId: string;
  userId: string;
}

type ActiveTokenEntry = {
  handleIPC: (raw: string, ctx: IPCContext) => Promise<string>;
  ctx: IPCContext;
};

function createTestServer(activeTokens: Map<string, ActiveTokenEntry>): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      const url = req.url ?? '/';

      if (url === '/internal/ipc' && req.method === 'POST') {
        const token = req.headers.authorization?.replace('Bearer ', '');
        const entry = token ? activeTokens.get(token) : undefined;
        if (!entry) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'invalid token' }));
          return;
        }

        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        const body = Buffer.concat(chunks).toString();

        const result = await entry.handleIPC(body, entry.ctx);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(result);
        return;
      }

      res.writeHead(404);
      res.end();
    });

    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as any).port;
      resolve({ server, port });
    });
  });
}

describe('/internal/ipc route', () => {
  let server: Server;
  let port: number;
  const activeTokens = new Map<string, ActiveTokenEntry>();

  beforeEach(async () => {
    activeTokens.clear();
    const result = await createTestServer(activeTokens);
    server = result.server;
    port = result.port;
  });

  afterEach(() => {
    server.close();
  });

  test('returns 401 for missing token', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/internal/ipc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'memory_read' }),
    });

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe('invalid token');
  });

  test('returns 401 for invalid token', async () => {
    activeTokens.set('valid-token', {
      handleIPC: async () => '{"ok":true}',
      ctx: { sessionId: 's1', agentId: 'main', userId: 'u1' },
    });

    const res = await fetch(`http://127.0.0.1:${port}/internal/ipc`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer wrong-token',
      },
      body: JSON.stringify({ action: 'memory_read' }),
    });

    expect(res.status).toBe(401);
  });

  test('dispatches to handleIPC with bound context', async () => {
    const handleIPC = vi.fn().mockResolvedValue('{"memories":[]}');
    const ctx = { sessionId: 'sess-abc', agentId: 'main', userId: 'user-1' };
    activeTokens.set('turn-token-123', { handleIPC, ctx });

    const res = await fetch(`http://127.0.0.1:${port}/internal/ipc`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer turn-token-123',
      },
      body: JSON.stringify({ action: 'memory_read', key: 'foo' }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ memories: [] });

    // Verify handleIPC was called with the bound ctx (not agent-supplied values)
    expect(handleIPC).toHaveBeenCalledOnce();
    const [rawBody, passedCtx] = handleIPC.mock.calls[0];
    expect(JSON.parse(rawBody).action).toBe('memory_read');
    expect(passedCtx).toEqual(ctx);
  });

  test('returns JSON response from handler', async () => {
    activeTokens.set('tok', {
      handleIPC: async () => JSON.stringify({ ok: true, data: [1, 2, 3] }),
      ctx: { sessionId: 's', agentId: 'main', userId: 'u' },
    });

    const res = await fetch(`http://127.0.0.1:${port}/internal/ipc`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer tok',
      },
      body: JSON.stringify({ action: 'test' }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json');
    const body = await res.json();
    expect(body).toEqual({ ok: true, data: [1, 2, 3] });
  });

  // Regression: some script-side callers post plain `{action, tool, args}`
  // without stamping `_sessionId` on the body. The handler therefore falls
  // back to `entry.ctx.sessionId`. If the turn rewrote the `:_:` placeholder
  // in sessionId AFTER registering the token (see `rewriteSessionPlaceholder`
  // in server-completions.ts), the token's ctx still held the pre-rewrite form
  // and `catalogMap.get(sessionId)` returned undefined → "unknown tool"
  // despite the catalog being populated. Fix: wire `updateTurnCtx` from
  // server.ts through CompletionDeps and call it right after the rewrite so
  // entry.ctx stays in sync.
  test('mutating entry.ctx is visible to subsequent unstamped requests', async () => {
    const captured: IPCContext[] = [];
    const handleIPC = vi.fn().mockImplementation(async (_raw: string, ctx: IPCContext) => {
      captured.push({ ...ctx });
      return '{"ok":true}';
    });

    // Simulate server.ts at turn-start: register token with ORIGINAL sessionId
    // (still contains `:_:` placeholder — agentId not yet resolved).
    const entry: ActiveTokenEntry = {
      handleIPC,
      ctx: { sessionId: 'http:dm:_:alice:t1', agentId: 'main', userId: 'alice' },
    };
    activeTokens.set('tok', entry);

    // Request 1 — pre-rewrite. Handler sees the ORIGINAL sessionId.
    await fetch(`http://127.0.0.1:${port}/internal/ipc`, {
      method: 'POST',
      headers: { 'Authorization': 'Bearer tok', 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'call_tool', tool: 'mcp_linear_get_team', args: {} }),
    });
    expect(captured[0].sessionId).toBe('http:dm:_:alice:t1');

    // Simulate processCompletion: rewrite placeholder then invoke the
    // updateTurnCtx callback that server.ts wires. This is the exact
    // mutation server.ts performs — if this pattern ever drifts, the
    // integration breaks silently.
    const updateTurnCtx = (updates: { sessionId?: string; agentId?: string }) => {
      const e = activeTokens.get('tok');
      if (!e) return;
      e.ctx = {
        ...e.ctx,
        ...(updates.sessionId !== undefined ? { sessionId: updates.sessionId } : {}),
        ...(updates.agentId !== undefined ? { agentId: updates.agentId } : {}),
      };
    };
    updateTurnCtx({ sessionId: 'http:dm:agent-abc:alice:t1', agentId: 'agent-abc' });

    // Request 2 — post-rewrite, same token, still no `_sessionId` stamp.
    // Handler MUST see the REWRITTEN sessionId so per-turn map lookups
    // (catalogMap, workspaceMap) resolve.
    await fetch(`http://127.0.0.1:${port}/internal/ipc`, {
      method: 'POST',
      headers: { 'Authorization': 'Bearer tok', 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'call_tool', tool: 'mcp_linear_get_team', args: {} }),
    });
    expect(captured[1].sessionId).toBe('http:dm:agent-abc:alice:t1');
    expect(captured[1].agentId).toBe('agent-abc');
  });

  test('cleans up token on turn completion', async () => {
    activeTokens.set('temp-tok', {
      handleIPC: async () => '{"ok":true}',
      ctx: { sessionId: 's', agentId: 'main', userId: 'u' },
    });

    // First request succeeds
    const res1 = await fetch(`http://127.0.0.1:${port}/internal/ipc`, {
      method: 'POST',
      headers: { 'Authorization': 'Bearer temp-tok', 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(res1.status).toBe(200);

    // Simulate turn completion
    activeTokens.delete('temp-tok');

    // Second request with same token fails
    const res2 = await fetch(`http://127.0.0.1:${port}/internal/ipc`, {
      method: 'POST',
      headers: { 'Authorization': 'Bearer temp-tok', 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(res2.status).toBe(401);
  });
});
