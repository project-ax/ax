// tests/host/ipc-handlers/call-tool.test.ts
//
// Unit tests for the `call_tool` IPC handler (Task 3.4 of the
// tool-dispatch-unification plan).
//
// What we're guarding:
// 1. MCP dispatch: looks up by catalog, calls mcpProvider with the server +
//    tool name from `dispatch`, returns `{result}`.
// 2. Unknown tool: structured error, no provider call.
// 3. MCP provider throws: structured error, original message preserved.
// 4. `_select` stripped from args before dispatch — projection runs after.
// 5. `resolveCatalog(ctx)` closure works the same as a direct `catalog`.
// 6. Factory guards on missing deps.

import { describe, it, expect, vi } from 'vitest';
import { createCallToolHandler, parseMcpTextResult, pickClosestNames, type CallToolOpenApiDispatcher } from '../../../src/host/ipc-handlers/call-tool.js';
import { ToolCatalog } from '../../../src/host/tool-catalog/registry.js';
import { catalogReaderFromTools } from '../../../src/host/ipc-handlers/describe-tools.js';
import type { CatalogTool } from '../../../src/types/catalog.js';
import type { IPCContext } from '../../../src/host/ipc-server.js';
import { initLogger } from '../../../src/logger.js';

initLogger({ file: false, level: 'silent' });

function makeTool(overrides: Partial<CatalogTool> = {}): CatalogTool {
  return {
    name: 'mcp_linear_list_issues',
    skill: 'linear',
    summary: 's',
    schema: { type: 'object' },
    dispatch: { kind: 'mcp', server: 'linear', toolName: 'list_issues' },
    ...overrides,
  } as CatalogTool;
}

/**
 * Throwing stub for `openApiProvider` — MCP-focused tests never dispatch
 * an openapi tool, so the stub should never fire. If a regression routes
 * an MCP tool through the openapi branch, this surfaces loudly instead
 * of silently succeeding with stale data.
 */
const unusedOpenApiProvider: CallToolOpenApiDispatcher = {
  dispatchOperation: async () => {
    throw new Error(
      'openApiProvider.dispatchOperation called from an MCP-only test — did the dispatch kind change?',
    );
  },
};

const ctx: IPCContext = { sessionId: 's1', agentId: 'main', userId: 'alice' };

describe('call_tool handler', () => {
  it('dispatches MCP tool by catalog lookup', async () => {
    const mcpProvider = {
      callToolOnServer: vi.fn().mockResolvedValue({ issues: [{ id: 1 }] }),
    };
    const catalog = new ToolCatalog();
    catalog.register(makeTool());

    const handler = createCallToolHandler({ catalog, mcpProvider, openApiProvider: unusedOpenApiProvider });
    const result = await handler(
      { tool: 'mcp_linear_list_issues', args: { team: 'p' } },
      ctx,
    );

    expect(mcpProvider.callToolOnServer).toHaveBeenCalledWith({
      server: 'linear',
      tool: 'list_issues',
      skillName: 'linear',
      args: { team: 'p' },
      ctx: { agentId: 'main', userId: 'alice' },
    });
    expect(result).toEqual({ result: { issues: [{ id: 1 }] } });
  });

  it('threads skillName from the catalog entry through to the MCP dispatcher (cross-skill isolation)', async () => {
    // Regression for PR #185 review issue #2 — the dispatcher receives
    // the declaring skill so the credential resolver can filter by
    // `(skillName, envName)` instead of envName alone. Without this,
    // two skills both using `API_KEY` can resolve each other's creds.
    const mcpProvider = {
      callToolOnServer: vi.fn().mockResolvedValue({ ok: true }),
    };
    const catalog = new ToolCatalog();
    // Tool's catalog skill is 'skill-a', NOT matching the tool name
    // prefix — confirms the dispatcher reads `tool.skill`, not a name
    // heuristic.
    catalog.register(
      makeTool({ name: 'mcp_shared_list_things', skill: 'skill-a' }),
    );

    const handler = createCallToolHandler({ catalog, mcpProvider, openApiProvider: unusedOpenApiProvider });
    await handler({ tool: 'mcp_shared_list_things', args: {} }, ctx);

    expect(mcpProvider.callToolOnServer.mock.calls[0][0].skillName).toBe('skill-a');
  });

  it('threads per-request userId through to the dispatcher (no captured default)', async () => {
    const mcpProvider = {
      callToolOnServer: vi.fn().mockResolvedValue({ ok: true }),
    };
    const catalog = new ToolCatalog();
    catalog.register(makeTool());
    const handler = createCallToolHandler({ catalog, mcpProvider, openApiProvider: unusedOpenApiProvider });

    // First call — userId = alice
    await handler(
      { tool: 'mcp_linear_list_issues', args: {} },
      { sessionId: 's1', agentId: 'main', userId: 'alice' },
    );
    // Second call — different user on the same host
    await handler(
      { tool: 'mcp_linear_list_issues', args: {} },
      { sessionId: 's2', agentId: 'main', userId: 'bob' },
    );

    expect(mcpProvider.callToolOnServer.mock.calls[0][0].ctx).toEqual({
      agentId: 'main',
      userId: 'alice',
    });
    expect(mcpProvider.callToolOnServer.mock.calls[1][0].ctx).toEqual({
      agentId: 'main',
      userId: 'bob',
    });
  });

  it('passes empty-string userId when ctx has none (matches tool-batch convention)', async () => {
    const mcpProvider = {
      callToolOnServer: vi.fn().mockResolvedValue({ ok: true }),
    };
    const catalog = new ToolCatalog();
    catalog.register(makeTool());
    const handler = createCallToolHandler({ catalog, mcpProvider, openApiProvider: unusedOpenApiProvider });

    await handler(
      { tool: 'mcp_linear_list_issues', args: {} },
      { sessionId: 's1', agentId: 'main' }, // no userId
    );

    expect(mcpProvider.callToolOnServer.mock.calls[0][0].ctx).toEqual({
      agentId: 'main',
      userId: '',
    });
  });

  it('returns structured error for unknown tool', async () => {
    const mcpProvider = { callToolOnServer: vi.fn() };
    const handler = createCallToolHandler({ catalog: new ToolCatalog(), mcpProvider, openApiProvider: unusedOpenApiProvider });
    const result = await handler({ tool: 'mcp_bogus', args: {} });

    expect(result).toMatchObject({ kind: 'unknown_tool' });
    expect((result as { error: string }).error).toMatch(/unknown tool/i);
    expect(mcpProvider.callToolOnServer).not.toHaveBeenCalled();
  });

  it('returns structured error when MCP provider throws', async () => {
    const mcpProvider = {
      callToolOnServer: vi.fn().mockRejectedValue(new Error('timeout')),
    };
    const catalog = new ToolCatalog();
    catalog.register(makeTool({ name: 'mcp_linear_x', dispatch: { kind: 'mcp', server: 'linear', toolName: 'x' } }));

    const handler = createCallToolHandler({ catalog, mcpProvider, openApiProvider: unusedOpenApiProvider });
    const result = await handler({ tool: 'mcp_linear_x', args: {} });

    expect(result).toMatchObject({ kind: 'dispatch_failed' });
    expect((result as { error: string }).error).toMatch(/timeout/);
  });

  it('strips `_select` from args before dispatching — projection runs after', async () => {
    const mcpProvider = {
      callToolOnServer: vi.fn().mockResolvedValue({ ok: true }),
    };
    const catalog = new ToolCatalog();
    catalog.register(makeTool());

    const handler = createCallToolHandler({ catalog, mcpProvider, openApiProvider: unusedOpenApiProvider });
    await handler({
      tool: 'mcp_linear_list_issues',
      args: { team: 'p', _select: '.team' },
    });

    const callArg = mcpProvider.callToolOnServer.mock.calls[0][0];
    expect(callArg.args).toEqual({ team: 'p' });
    expect(callArg.args).not.toHaveProperty('_select');
  });

  it('applies _select projection to successful MCP result', async () => {
    const mcpProvider = {
      callToolOnServer: vi.fn().mockResolvedValue({ issues: [{ id: 1, title: 't1' }, { id: 2, title: 't2' }] }),
    };
    const catalog = new ToolCatalog();
    catalog.register(makeTool());

    const handler = createCallToolHandler({ catalog, mcpProvider, openApiProvider: unusedOpenApiProvider });
    const result = await handler({
      tool: 'mcp_linear_list_issues',
      args: { _select: '.issues | length' },
    });

    expect(result).toEqual({ result: 2 });
    // Dispatch arguments MUST NOT include _select (still stripped before the server call).
    expect(mcpProvider.callToolOnServer.mock.calls[0][0].args).not.toHaveProperty('_select');
  });

  it('returns select_failed on malformed _select', async () => {
    const mcpProvider = { callToolOnServer: vi.fn().mockResolvedValue({}) };
    const catalog = new ToolCatalog();
    catalog.register(makeTool());

    const handler = createCallToolHandler({ catalog, mcpProvider, openApiProvider: unusedOpenApiProvider });
    const result = await handler({
      tool: 'mcp_linear_list_issues',
      args: { _select: '.[' },
    });

    expect(result).toMatchObject({ kind: 'select_failed' });
    expect((result as { error: string }).error).toMatch(/_select/i);
  });

  it('skips projection when _select is empty/not a string', async () => {
    const mcpProvider = {
      callToolOnServer: vi.fn().mockResolvedValue({ a: 1 }),
    };
    const catalog = new ToolCatalog();
    catalog.register(makeTool());

    const handler = createCallToolHandler({ catalog, mcpProvider, openApiProvider: unusedOpenApiProvider });
    // empty string, number, object — all ignored
    for (const bad of ['', 123, { nested: true }]) {
      const result = await handler({
        tool: 'mcp_linear_list_issues',
        args: { _select: bad as never },
      });
      expect(result).toEqual({ result: { a: 1 } });
    }
  });

  it('resolves catalog via resolveCatalog(ctx) closure (real-server wiring form)', async () => {
    const tool = makeTool();
    const reader = catalogReaderFromTools([tool]);
    const mcpProvider = {
      callToolOnServer: vi.fn().mockResolvedValue({ items: [] }),
    };

    const receivedContexts: IPCContext[] = [];
    const handler = createCallToolHandler({
      resolveCatalog: (c) => {
        receivedContexts.push(c);
        return reader;
      },
      mcpProvider,
      openApiProvider: unusedOpenApiProvider,
    });

    const result = await handler({ tool: 'mcp_linear_list_issues', args: {} }, ctx);
    expect(result).toEqual({ result: { items: [] } });
    expect(receivedContexts).toEqual([ctx]);
  });

  it('returns unknown_tool when no catalog is registered for the current turn', async () => {
    const mcpProvider = { callToolOnServer: vi.fn() };
    const handler = createCallToolHandler({
      resolveCatalog: () => undefined,
      mcpProvider,
      openApiProvider: unusedOpenApiProvider,
    });

    const result = await handler({ tool: 'mcp_linear_list_issues', args: {} }, ctx);
    expect(result).toMatchObject({ kind: 'unknown_tool' });
    expect(mcpProvider.callToolOnServer).not.toHaveBeenCalled();
  });

  it('routes openapi dispatch kinds through openApiProvider (Task 7.4)', async () => {
    const mcpProvider = { callToolOnServer: vi.fn() };
    const openApiProvider = {
      dispatchOperation: vi.fn().mockResolvedValue({ id: '5', name: 'Rex' }),
    };
    const catalog = new ToolCatalog();
    catalog.register({
      name: 'api_foo_bar',
      skill: 'foo',
      summary: 's',
      schema: { type: 'object' },
      dispatch: {
        kind: 'openapi',
        baseUrl: 'https://example.com',
        method: 'GET',
        path: '/x/{id}',
        operationId: 'getX',
        params: [{ name: 'id', in: 'path' }],
      },
    } as CatalogTool);

    const handler = createCallToolHandler({ catalog, mcpProvider, openApiProvider });
    const result = await handler({ tool: 'api_foo_bar', args: { id: '5' } }, ctx);

    expect(result).toEqual({ result: { id: '5', name: 'Rex' } });
    expect(mcpProvider.callToolOnServer).not.toHaveBeenCalled();
    expect(openApiProvider.dispatchOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        baseUrl: 'https://example.com',
        method: 'GET',
        path: '/x/{id}',
        operationId: 'getX',
        // skillName threads from `tool.skill` so the dispatcher's
        // credential resolver can filter by `(skillName, envName)` —
        // PR #185 review issue #2.
        skillName: 'foo',
        params: [{ name: 'id', in: 'path' }],
        args: { id: '5' },
        ctx: { agentId: 'main', userId: 'alice' },
      }),
    );
  });

  it('throws at factory time if neither `catalog` nor `resolveCatalog` is provided', () => {
    const mcpProvider = { callToolOnServer: vi.fn() };
    expect(() =>
      createCallToolHandler({ mcpProvider, openApiProvider: unusedOpenApiProvider } as never),
    ).toThrow(/catalog/);
  });

  it('throws at factory time if `mcpProvider` is missing', () => {
    expect(() =>
      createCallToolHandler({
        catalog: new ToolCatalog(),
        openApiProvider: unusedOpenApiProvider,
      } as never),
    ).toThrow(/mcpProvider/);
  });

  it('throws at factory time if `openApiProvider` is missing', () => {
    const mcpProvider = { callToolOnServer: vi.fn() };
    expect(() =>
      createCallToolHandler({ catalog: new ToolCatalog(), mcpProvider } as never),
    ).toThrow(/openApiProvider/);
  });

  it('coerces non-Error thrown values to a string (no info loss)', async () => {
    const mcpProvider = {
      callToolOnServer: vi.fn().mockRejectedValue({ code: 'ETIMEDOUT', detail: 'x' }),
    };
    const catalog = new ToolCatalog();
    catalog.register(makeTool());

    const handler = createCallToolHandler({ catalog, mcpProvider, openApiProvider: unusedOpenApiProvider });
    const result = await handler({ tool: 'mcp_linear_list_issues', args: {} });

    expect(result).toMatchObject({ kind: 'dispatch_failed' });
    expect((result as { error: string }).error).toMatch(/ETIMEDOUT/);
  });

  // ── Task 4.3: Auto-spill on oversized responses ────────────────────────
  //
  // When the stringified post-projection result exceeds `spillThresholdBytes`,
  // the handler returns `{truncated: true, full, preview}` instead of the
  // normal `{result}` envelope. The agent-side stub in
  // `src/agent/tools/describe-tools.ts` is responsible for writing `full`
  // to a spill file — the host stays filesystem-free.

  it('returns _truncated envelope when response exceeds threshold', async () => {
    const big = { data: 'x'.repeat(30_000) };
    const mcpProvider = { callToolOnServer: vi.fn().mockResolvedValue(big) };
    const catalog = new ToolCatalog();
    catalog.register(makeTool());

    const handler = createCallToolHandler({
      catalog,
      mcpProvider,
      openApiProvider: unusedOpenApiProvider,
      spillThresholdBytes: 20_480,
    });
    const result = await handler({ tool: 'mcp_linear_list_issues', args: {} });

    expect(result).toMatchObject({ truncated: true });
    expect((result as { full: unknown }).full).toEqual(big);
    expect(typeof (result as { preview: unknown }).preview).toBe('string');
    // Should NOT be the plain {result} envelope
    expect(result).not.toHaveProperty('result');
  });

  it('returns {result} envelope when response is under threshold', async () => {
    const small = { a: 1, b: 2 };
    const mcpProvider = { callToolOnServer: vi.fn().mockResolvedValue(small) };
    const catalog = new ToolCatalog();
    catalog.register(makeTool());

    const handler = createCallToolHandler({
      catalog,
      mcpProvider,
      openApiProvider: unusedOpenApiProvider,
      spillThresholdBytes: 20_480,
    });
    const result = await handler({ tool: 'mcp_linear_list_issues', args: {} });

    expect(result).toEqual({ result: small });
    expect(result).not.toHaveProperty('truncated');
  });

  it('defaults threshold to DEFAULT_TOOL_DISPATCH_SPILL_THRESHOLD_BYTES (20480) when not passed', async () => {
    // 21KB > 20480, so with the default threshold we expect truncation even
    // though the caller did NOT pass spillThresholdBytes.
    const big = { data: 'y'.repeat(21_000) };
    const mcpProvider = { callToolOnServer: vi.fn().mockResolvedValue(big) };
    const catalog = new ToolCatalog();
    catalog.register(makeTool());

    const handler = createCallToolHandler({ catalog, mcpProvider, openApiProvider: unusedOpenApiProvider });
    const result = await handler({ tool: 'mcp_linear_list_issues', args: {} });

    expect(result).toMatchObject({ truncated: true });
    expect((result as { full: unknown }).full).toEqual(big);
  });

  it('projection that shrinks a large response below threshold does NOT trigger truncation', async () => {
    // Raw response > threshold, but `.id` extracts a tiny scalar.
    // Spill check must run AFTER projection — otherwise we'd spill a 1-char string.
    const bigArray = Array.from({ length: 1000 }, (_, i) => ({
      id: i,
      payload: 'z'.repeat(50),
    }));
    const mcpProvider = {
      callToolOnServer: vi.fn().mockResolvedValue(bigArray),
    };
    const catalog = new ToolCatalog();
    catalog.register(makeTool());

    const handler = createCallToolHandler({
      catalog,
      mcpProvider,
      openApiProvider: unusedOpenApiProvider,
      spillThresholdBytes: 20_480,
    });
    const result = await handler({
      tool: 'mcp_linear_list_issues',
      args: { _select: '. | length' }, // scalar: 1000
    });

    expect(result).toEqual({ result: 1000 });
    expect(result).not.toHaveProperty('truncated');
  });

  it('includes a preview prefix of the stringified full response', async () => {
    const big = { marker: 'findme', pad: 'x'.repeat(30_000) };
    const mcpProvider = { callToolOnServer: vi.fn().mockResolvedValue(big) };
    const catalog = new ToolCatalog();
    catalog.register(makeTool());

    const handler = createCallToolHandler({
      catalog,
      mcpProvider,
      openApiProvider: unusedOpenApiProvider,
      spillThresholdBytes: 20_480,
    });
    const result = await handler({ tool: 'mcp_linear_list_issues', args: {} });

    expect(result).toMatchObject({ truncated: true });
    const preview = (result as { preview: string }).preview;
    expect(preview).toContain('findme');
    // Preview is bounded — shouldn't carry the full 30KB payload
    expect(preview.length).toBeLessThan(1000);
  });

  // ── parseMcpTextResult ───────────────────────────────────────────────
  // The real-server dispatcher adapter unwraps MCP text content through
  // this helper — turning JSON-encoded strings into real values so the
  // agent's `ax.callTool` returns objects/arrays, not strings. Regression
  // guards the Linear thrash: `teams.find()` failing because the dispatcher
  // returned a string, and jq `_select` failing with "Cannot iterate over
  // string" on `{"issues":[...]}`.

  describe('parseMcpTextResult', () => {
    it('parses a JSON-encoded object string into the object', () => {
      const result = parseMcpTextResult('{"teams":[{"id":"t1"}]}');
      expect(result).toEqual({ teams: [{ id: 't1' }] });
    });

    it('parses a JSON-encoded array string into the array', () => {
      const result = parseMcpTextResult('[{"id":"t1"},{"id":"t2"}]');
      expect(result).toEqual([{ id: 't1' }, { id: 't2' }]);
    });

    it('parses primitives (numbers, booleans, null)', () => {
      expect(parseMcpTextResult('42')).toBe(42);
      expect(parseMcpTextResult('true')).toBe(true);
      expect(parseMcpTextResult('null')).toBe(null);
    });

    it('returns the raw string when it is not valid JSON', () => {
      // Plain-text MCP responses (status messages, single-line replies).
      expect(parseMcpTextResult('OK — deleted 3 records')).toBe(
        'OK — deleted 3 records',
      );
      expect(parseMcpTextResult('')).toBe('');
    });

    it('passes through non-string inputs unchanged', () => {
      // `callToolOnServer` can theoretically return non-string content if
      // a future MCP server returns structured content blocks directly.
      expect(parseMcpTextResult({ already: 'parsed' })).toEqual({ already: 'parsed' });
      expect(parseMcpTextResult([1, 2, 3])).toEqual([1, 2, 3]);
      expect(parseMcpTextResult(null)).toBe(null);
      expect(parseMcpTextResult(undefined)).toBe(undefined);
    });

    it('returns a JSON-looking-but-invalid string unchanged', () => {
      // A plain message that happens to start with `{` — must not crash
      // or coerce to anything weird, just return the string.
      expect(parseMcpTextResult('{invalid json')).toBe('{invalid json');
    });
  });

  // ── Unknown-tool hint ────────────────────────────────────────────────
  // Regression: when an agent guesses `mcp_linear_get_team` and the catalog
  // has `mcp_linear_list_teams`, the error message should point at the
  // near match AND suggest `describeTool([])` rather than stopping at
  // "unknown tool: X".

  describe('unknown tool error hint', () => {
    it('surfaces close-match suggestions and the describeTool([]) pivot', async () => {
      const catalog = new ToolCatalog();
      catalog.register(makeTool({ name: 'mcp_linear_list_teams', skill: 'linear' }));
      catalog.register(makeTool({ name: 'mcp_linear_list_issues', skill: 'linear' }));
      catalog.register(makeTool({ name: 'mcp_github_list_repos', skill: 'github', dispatch: { kind: 'mcp', server: 'github', toolName: 'list_repos' } }));

      const mcpProvider = { callToolOnServer: vi.fn() };
      const handler = createCallToolHandler({ catalog, mcpProvider, openApiProvider: unusedOpenApiProvider });
      const result = await handler({ tool: 'mcp_linear_get_team', args: {} });

      expect(result).toMatchObject({ kind: 'unknown_tool' });
      const err = (result as { error: string }).error;
      expect(err).toContain('mcp_linear_list_teams');
      // GitHub tool is in a different skill — should NOT surface as a
      // suggestion over the same-skill candidates.
      expect(err).not.toContain('mcp_github_list_repos');
      expect(err).toContain('ax.describeTool([])');
    });

    it('falls back to the generic describeTool([]) nudge when nothing overlaps', async () => {
      const catalog = new ToolCatalog();
      catalog.register(makeTool({ name: 'mcp_slack_post_message', skill: 'slack', dispatch: { kind: 'mcp', server: 'slack', toolName: 'post_message' } }));

      const handler = createCallToolHandler({ catalog, mcpProvider: { callToolOnServer: vi.fn() }, openApiProvider: unusedOpenApiProvider });
      const result = await handler({ tool: 'completely_unrelated_xyz', args: {} });
      const err = (result as { error: string }).error;
      expect(err).toContain('ax.describeTool([])');
      // No "Did you mean" when nothing matches.
      expect(err).not.toContain('Did you mean');
    });

    it('says catalog is empty when no tools are registered', async () => {
      const handler = createCallToolHandler({
        catalog: new ToolCatalog(),
        mcpProvider: { callToolOnServer: vi.fn() },
        openApiProvider: unusedOpenApiProvider,
      });
      const result = await handler({ tool: 'anything', args: {} });
      expect((result as { error: string }).error).toContain('catalog is empty');
    });
  });

  // ── pickClosestNames ──────────────────────────────────────────────────

  describe('pickClosestNames', () => {
    it('ranks same-skill matches above cross-skill matches', () => {
      const names = [
        'mcp_linear_list_teams',
        'mcp_linear_list_issues',
        'mcp_github_list_teams',
      ];
      const suggestions = pickClosestNames('mcp_linear_get_team', names);
      // Same skill (linear) + same noun (team) should win.
      expect(suggestions[0]).toBe('mcp_linear_list_teams');
      // GitHub also has "list" and "teams" but different skill prefix.
      expect(suggestions).not.toContain('mcp_github_list_teams');
    });

    it('returns an empty array when no candidates share any tokens', () => {
      expect(pickClosestNames('completely_unrelated', ['mcp_slack_post_message'])).toEqual([]);
    });

    it('caps the number of suggestions at `limit`', () => {
      const names = [
        'mcp_linear_list_teams',
        'mcp_linear_list_issues',
        'mcp_linear_list_cycles',
        'mcp_linear_list_projects',
        'mcp_linear_list_users',
      ];
      expect(pickClosestNames('mcp_linear_list_foo', names, 2)).toHaveLength(2);
    });

    it('returns [] for empty candidate list', () => {
      expect(pickClosestNames('x', [])).toEqual([]);
    });
  });
});
