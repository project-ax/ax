/**
 * Mock MCP server handler for Task 4.4 e2e.
 *
 * Minimal JSON-RPC 2.0 HTTP handler that speaks MCP at
 * `POST /mcp/linear`. Advertises three tools (`get_team`, `list_cycles`,
 * `list_issues`) whose responses chain via their return values — so the
 * agent LLM can drive a 3-turn flow where each call's output is the next
 * call's input.
 *
 * Not a real MCP server: no session state, no capabilities negotiation
 * beyond the bare minimum the `@modelcontextprotocol/sdk` client needs
 * for `initialize` + `tools/list` + `tools/call`. Dependency-free by
 * design — we're testing our wiring, not the MCP library.
 *
 * Exposes `getMcpStats()` so the test can verify each tool got hit
 * exactly once (the core evidence that all three call_tool invocations
 * actually landed on the server, not short-circuited by the mock
 * OpenRouter).
 */

import type { IncomingMessage, ServerResponse } from 'node:http';

/** Per-method call counters, reset by `resetMcp`. */
let stats = {
  get_team: 0,
  list_cycles: 0,
  list_issues: 0,
  initialize: 0,
  'tools/list': 0,
};

export function resetMcp(): void {
  stats = {
    get_team: 0,
    list_cycles: 0,
    list_issues: 0,
    initialize: 0,
    'tools/list': 0,
  };
}

export function getMcpStats(): typeof stats {
  return { ...stats };
}

/** Main router for `/mcp/*` paths. */
export function handleMcp(req: IncomingMessage, res: ServerResponse): void {
  const url = req.url ?? '';

  // GET /mcp/_stats — test hook for asserting tool hit counts.
  if (url === '/mcp/_stats' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(getMcpStats()));
    return;
  }

  // POST /mcp/_reset — test hook for clearing counters between runs.
  if (url === '/mcp/_reset' && req.method === 'POST') {
    resetMcp();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ reset: true }));
    return;
  }

  // POST /mcp/linear — the MCP endpoint the skill frontmatter points at.
  if (url.startsWith('/mcp/linear') && req.method === 'POST') {
    handleJsonRpc(req, res);
    return;
  }

  // GET /mcp/linear — the MCP Streamable HTTP client starts with a GET to
  // check for server-initiated SSE stream support. We don't advertise one;
  // responding 405 signals "not supported, continue with POST-only" per the
  // MCP SDK's fallback behavior.
  if (url.startsWith('/mcp/linear') && req.method === 'GET') {
    res.writeHead(405, { 'Content-Type': 'application/json', 'Allow': 'POST' });
    res.end(JSON.stringify({ error: 'Method Not Allowed' }));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found', path: url }));
}

function handleJsonRpc(req: IncomingMessage, res: ServerResponse): void {
  const chunks: Buffer[] = [];
  req.on('data', (c: Buffer) => chunks.push(c));
  // Without an error listener, an aborted request (client timeout mid-stream)
  // would emit 'error' on the request object with no handler and crash the
  // entire mock-server process — taking the whole test run down with it.
  req.on('error', () => {
    if (!res.writableEnded) { res.writeHead(400); res.end(); }
  });
  req.on('end', () => {
    let body: { jsonrpc?: string; id?: number | string; method?: string; params?: Record<string, unknown> };
    try {
      body = JSON.parse(Buffer.concat(chunks).toString());
    } catch {
      // JSON-RPC parse error — no id known.
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }));
      return;
    }

    const id = body.id ?? null;
    const method = body.method;
    const params = body.params ?? {};

    // Notifications (no id) — return 202 Accepted with no body per JSON-RPC spec.
    // `notifications/initialized` is the one the MCP SDK sends.
    if (id === null) {
      if (typeof method === 'string' && method.startsWith('notifications/')) {
        res.writeHead(202);
        res.end();
        return;
      }
      // Fallthrough: malformed request.
      res.writeHead(400);
      res.end();
      return;
    }

    const sendResult = (result: unknown): void => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id, result }));
    };
    const sendError = (code: number, message: string): void => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }));
    };

    switch (method) {
      case 'initialize': {
        stats.initialize += 1;
        sendResult({
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'mock-linear-mcp', version: '0.0.1' },
        });
        return;
      }
      case 'tools/list': {
        stats['tools/list'] += 1;
        sendResult({
          tools: [
            {
              name: 'get_team',
              description: 'Get the product team metadata (id, name).',
              inputSchema: { type: 'object', properties: {}, additionalProperties: false },
            },
            {
              name: 'list_cycles',
              description: 'List cycles for a team. Requires team_id.',
              inputSchema: {
                type: 'object',
                properties: { team_id: { type: 'string' } },
                required: ['team_id'],
                additionalProperties: false,
              },
            },
            {
              name: 'list_issues',
              description: 'List issues in a cycle. Requires cycle_id.',
              inputSchema: {
                type: 'object',
                properties: { cycle_id: { type: 'string' } },
                required: ['cycle_id'],
                additionalProperties: false,
              },
            },
          ],
        });
        return;
      }
      case 'tools/call': {
        const name = typeof params.name === 'string' ? params.name : '';
        const args = (params.arguments ?? {}) as Record<string, unknown>;
        if (name === 'get_team') {
          stats.get_team += 1;
          sendResult({
            content: [{
              type: 'text',
              text: JSON.stringify({ team_id: 'team_product', name: 'Product' }),
            }],
          });
          return;
        }
        if (name === 'list_cycles') {
          stats.list_cycles += 1;
          // Note: we intentionally do NOT echo team_id here. The scripted
          // mock OpenRouter matches on substrings of the tool-result content;
          // echoing team_id would leak `team_product` into the list_cycles
          // response and confuse the `matchToolResult` dispatch in
          // `linear-flow.ts`. The stats counter (+1 per hit) is the
          // authoritative chain-correctness signal.
          sendResult({
            content: [{
              type: 'text',
              text: JSON.stringify({
                cycle_id: 'cycle_99',
                name: 'Cycle 14',
                current: true,
              }),
            }],
          });
          return;
        }
        if (name === 'list_issues') {
          stats.list_issues += 1;
          sendResult({
            content: [{
              type: 'text',
              text: JSON.stringify({
                issues: [
                  { id: 'ISS-1', title: 'Ship Task 4.4' },
                  { id: 'ISS-2', title: 'Sync docs' },
                ],
              }),
            }],
          });
          return;
        }
        sendError(-32602, `unknown tool: ${name}`);
        return;
      }
      default:
        sendError(-32601, `method not found: ${method ?? '<none>'}`);
    }
  });
}
