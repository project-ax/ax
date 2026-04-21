// tests/host/ipc-handlers/describe-tools.test.ts
//
// Unit tests for the `describe_tools` IPC handler (Task 3.3 of the
// tool-dispatch-unification plan).
//
// What we're guarding:
// 1. Known names round-trip with {name, summary, schema}.
// 2. Unknown names come back in `unknown` (not mixed into `tools`).
// 3. Returned schemas ARE augmented with `_select` — projection is live
//    (Task 4.2). `call-tool.ts` applies jq after dispatch.
// 4. The handler does NOT mutate the cached CatalogTool — critical,
//    because the same array is re-read by every subsequent turn at the
//    same (agentId, userId, HEAD-sha).
// 5. The factory works with both a direct `catalog` (unit-test form) and
//    a `resolveCatalog(ctx)` closure (real-server wiring).

import { describe, it, expect } from 'vitest';
import {
  createDescribeToolsHandler,
  catalogReaderFromTools,
} from '../../../src/host/ipc-handlers/describe-tools.js';
import { ToolCatalog } from '../../../src/host/tool-catalog/registry.js';
import type { CatalogTool } from '../../../src/types/catalog.js';
import type { IPCContext } from '../../../src/host/ipc-server.js';

function makeTool(overrides: Partial<CatalogTool> = {}): CatalogTool {
  return {
    name: 'mcp_linear_x',
    skill: 'linear',
    summary: 'X',
    schema: { type: 'object', properties: { a: { type: 'string' } } },
    dispatch: { kind: 'mcp', server: 'linear', toolName: 'x' },
    ...overrides,
  } as CatalogTool;
}

const ctx: IPCContext = { sessionId: 's1', agentId: 'main', userId: 'alice' };

describe('describe_tools handler', () => {
  it('returns full schemas for named tools (direct catalog form)', async () => {
    const catalog = new ToolCatalog();
    catalog.register(makeTool());

    const handler = createDescribeToolsHandler({ catalog });
    const result = await handler({ names: ['mcp_linear_x'] }, ctx);

    expect(result.unknown).toEqual([]);
    expect(result.tools).toHaveLength(1);
    expect(result.tools[0]).toEqual({
      name: 'mcp_linear_x',
      summary: 'X',
      schema: expect.objectContaining({ type: 'object' }),
    });
  });

  it('returns an error block for unknown names', async () => {
    const handler = createDescribeToolsHandler({ catalog: new ToolCatalog() });
    const result = await handler({ names: ['mcp_nope_x'] }, ctx);

    expect(result.tools).toEqual([]);
    expect(result.unknown).toEqual(['mcp_nope_x']);
  });

  it('augments returned schemas with the _select jq projection knob', async () => {
    const catalog = new ToolCatalog();
    catalog.register(makeTool());

    const handler = createDescribeToolsHandler({ catalog });
    const result = await handler({ names: ['mcp_linear_x'] }, ctx);

    const schema = result.tools[0].schema as { properties: Record<string, unknown> };
    expect(schema.properties).toMatchObject({
      _select: { type: 'string' },
    });
    // Original property must still be there (pass-through, not stripped).
    expect(schema.properties).toHaveProperty('a');
  });

  it('does NOT mutate the stored catalog schema when augmenting', async () => {
    const tool = makeTool();
    const originalPropsRef = tool.schema.properties;
    const catalog = new ToolCatalog();
    catalog.register(tool);

    const handler = createDescribeToolsHandler({ catalog });
    await handler({ names: ['mcp_linear_x'] }, ctx);

    // The cached tool's schema must still be identity-preserved so that
    // subsequent turns hitting the same (agentId, userId, HEAD-sha) cache
    // entry see the exact stored shape. Augmentation must be non-destructive.
    const stored = catalog.get('mcp_linear_x');
    expect(stored?.schema.properties).toBe(originalPropsRef);
    expect((stored?.schema.properties as Record<string, unknown>)._select).toBeUndefined();
  });

  it('splits known and unknown names across a single request', async () => {
    const catalog = new ToolCatalog();
    catalog.register(makeTool({ name: 'mcp_linear_a', summary: 'A' }));
    catalog.register(makeTool({ name: 'mcp_linear_b', summary: 'B', dispatch: { kind: 'mcp', server: 'linear', toolName: 'b' } }));

    const handler = createDescribeToolsHandler({ catalog });
    const result = await handler(
      { names: ['mcp_linear_a', 'mcp_nope_x', 'mcp_linear_b'] },
      ctx,
    );

    expect(result.tools.map(t => t.name)).toEqual(['mcp_linear_a', 'mcp_linear_b']);
    expect(result.unknown).toEqual(['mcp_nope_x']);
  });

  it('resolves catalog via resolveCatalog(ctx) closure (real-server wiring form)', async () => {
    const tool = makeTool();
    const reader = catalogReaderFromTools([tool]);

    const receivedContexts: IPCContext[] = [];
    const handler = createDescribeToolsHandler({
      resolveCatalog: (c) => {
        receivedContexts.push(c);
        return reader;
      },
    });

    const result = await handler({ names: ['mcp_linear_x'] }, ctx);
    expect(result.tools).toHaveLength(1);
    expect(receivedContexts).toEqual([ctx]);
  });

  it('returns every name as unknown when no catalog is available for this turn', async () => {
    const handler = createDescribeToolsHandler({
      resolveCatalog: () => undefined,
    });

    const result = await handler({ names: ['mcp_linear_x', 'mcp_linear_y'] }, ctx);
    expect(result.tools).toEqual([]);
    expect(result.unknown).toEqual(['mcp_linear_x', 'mcp_linear_y']);
  });

  it('throws at factory time if neither `catalog` nor `resolveCatalog` is provided', () => {
    expect(() => createDescribeToolsHandler({} as any)).toThrow(/catalog/);
  });

  // ── Directory mode (empty names) ───────────────────────────────────
  // Agents that don't know their tool names need a cheap "what do I have?"
  // path. `describe_tools([])` returns every catalog entry (name + summary,
  // no schema) so one round-trip replaces the name-guessing thrash.

  it('returns every catalog tool (name + summary, no schema) when names is empty', async () => {
    const catalog = new ToolCatalog();
    catalog.register(makeTool({ name: 'mcp_linear_a', summary: 'A tool' }));
    catalog.register(makeTool({
      name: 'mcp_linear_b', summary: 'B tool',
      dispatch: { kind: 'mcp', server: 'linear', toolName: 'b' },
    }));

    const handler = createDescribeToolsHandler({ catalog });
    const result = await handler({ names: [] }, ctx);

    expect(result.unknown).toEqual([]);
    expect(result.tools).toHaveLength(2);
    expect(result.tools.map(t => t.name)).toEqual(['mcp_linear_a', 'mcp_linear_b']);
    expect(result.tools.map(t => t.summary)).toEqual(['A tool', 'B tool']);
    // Directory mode omits the schema to save bytes — agents fetch schemas
    // in a second call after narrowing.
    for (const t of result.tools) {
      expect(t.schema).toEqual({});
    }
  });

  it('returns empty tools + empty unknown when directory mode hits an empty catalog', async () => {
    const handler = createDescribeToolsHandler({ catalog: new ToolCatalog() });
    const result = await handler({ names: [] }, ctx);
    expect(result).toEqual({ tools: [], unknown: [] });
  });

  it('directory mode via resolveCatalog closure', async () => {
    const reader = catalogReaderFromTools([makeTool()]);
    const handler = createDescribeToolsHandler({ resolveCatalog: () => reader });
    const result = await handler({ names: [] }, ctx);
    expect(result.tools).toHaveLength(1);
    expect(result.tools[0].schema).toEqual({});
  });
});
