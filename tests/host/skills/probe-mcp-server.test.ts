// tests/host/skills/probe-mcp-server.test.ts
//
// Unit tests for the probe helper. Guards:
//  1. ok=true path carries the tool count back so the UI can show "N tools".
//  2. ok=false path captures the MCP client's error string — the admin relies
//     on this to distinguish 401 (creds) from 404 (URL) from transport errors.
//  3. Headers and transport are forwarded verbatim to connectAndListTools.
//  4. url_rewrites applies before the fetch — so the e2e mock harness can
//     steer a skill's `https://mcp.linear.app/mcp` URL at the mock server
//     without the admin editing the frontmatter.
//  5. One flaky server doesn't poison the others; results keep input order.

import { describe, test, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../src/plugins/mcp-client.js', () => ({
  connectAndListTools: vi.fn(),
}));

const { probeMcpServer, probeMcpServers } = await import('../../../src/host/skills/probe-mcp-server.js');
const { connectAndListTools } = await import('../../../src/plugins/mcp-client.js');
const mockConnectAndListTools = vi.mocked(connectAndListTools);

describe('probeMcpServer', () => {
  beforeEach(() => {
    mockConnectAndListTools.mockReset();
  });

  test('returns ok:true with tool count on success', async () => {
    mockConnectAndListTools.mockResolvedValue([
      { name: 'a', description: '', inputSchema: {} },
      { name: 'b', description: '', inputSchema: {} },
    ]);
    const result = await probeMcpServer({
      name: 'linear',
      url: 'https://mcp.linear.app/mcp',
      transport: 'http',
      headers: { Authorization: 'Bearer t' },
    });
    expect(result).toEqual({ name: 'linear', ok: true, toolCount: 2 });
  });

  test('returns ok:false with error message on MCP client failure', async () => {
    mockConnectAndListTools.mockRejectedValue(new Error('SSE error: Non-200 status code (401)'));
    const result = await probeMcpServer({
      name: 'linear',
      url: 'https://mcp.linear.app/sse',
      transport: 'sse',
    });
    expect(result).toEqual({
      name: 'linear',
      ok: false,
      error: 'SSE error: Non-200 status code (401)',
    });
  });

  test('forwards headers + transport verbatim to connectAndListTools', async () => {
    mockConnectAndListTools.mockResolvedValue([]);
    await probeMcpServer({
      name: 's',
      url: 'https://example.com/mcp',
      transport: 'sse',
      headers: { Authorization: 'Bearer x', 'X-Foo': 'y' },
    });
    expect(mockConnectAndListTools).toHaveBeenCalledWith('https://example.com/mcp', {
      headers: { Authorization: 'Bearer x', 'X-Foo': 'y' },
      transport: 'sse',
    });
  });

  test('omits headers key when input has none (no empty object)', async () => {
    mockConnectAndListTools.mockResolvedValue([]);
    await probeMcpServer({
      name: 's',
      url: 'https://example.com/mcp',
      transport: 'http',
    });
    expect(mockConnectAndListTools).toHaveBeenCalledWith('https://example.com/mcp', {
      transport: 'http',
    });
  });

  test('applies url_rewrites before the fetch', async () => {
    mockConnectAndListTools.mockResolvedValue([]);
    await probeMcpServer(
      { name: 's', url: 'https://mcp.linear.app/mcp', transport: 'http' },
      { urlRewrites: { 'mcp.linear.app': 'http://127.0.0.1:9100' } },
    );
    const [calledUrl] = mockConnectAndListTools.mock.calls[0];
    expect(calledUrl).toBe('http://127.0.0.1:9100/mcp');
  });
});

describe('probeMcpServers', () => {
  beforeEach(() => {
    mockConnectAndListTools.mockReset();
  });

  test('runs probes in parallel and preserves input order in results', async () => {
    mockConnectAndListTools
      .mockResolvedValueOnce([{ name: 't1', description: '', inputSchema: {} }])
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce([]);
    const results = await probeMcpServers([
      { name: 'a', url: 'https://a.example/mcp', transport: 'http' },
      { name: 'b', url: 'https://b.example/mcp', transport: 'http' },
      { name: 'c', url: 'https://c.example/sse', transport: 'sse' },
    ]);
    expect(results).toEqual([
      { name: 'a', ok: true, toolCount: 1 },
      { name: 'b', ok: false, error: 'boom' },
      { name: 'c', ok: true, toolCount: 0 },
    ]);
  });
});
