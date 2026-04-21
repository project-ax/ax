/**
 * Tests for the agent-side `describe_tools` + `call_tool` stubs.
 *
 * These verify the factory functions proxy correctly via IPC, with the exact
 * action name and payload shape the host-side handlers (Task 3.3 / 3.4)
 * expect. The integration path (TOOL_CATALOG → pi-session / mcp-server) is
 * covered by `tool-catalog-sync.test.ts` and `ipc-tools.test.ts`; this file
 * exercises the isolated factories.
 */

import { describe, test, expect, vi } from 'vitest';
import {
  createDescribeToolsTool,
  createCallToolTool,
} from '../../../src/agent/tools/describe-tools.js';

function makeMockClient(result: Record<string, unknown> = { ok: true }) {
  return {
    call: vi.fn().mockResolvedValue(result),
  };
}

describe('createDescribeToolsTool', () => {
  test('forwards names[] to the describe_tools IPC action', async () => {
    const ipc = makeMockClient({ tools: [], unknown: [] });
    const tool = createDescribeToolsTool(ipc as never);
    await tool.execute({ names: ['mcp_linear_list_issues'] });
    expect(ipc.call).toHaveBeenCalledTimes(1);
    expect(ipc.call).toHaveBeenCalledWith({
      action: 'describe_tools',
      names: ['mcp_linear_list_issues'],
    });
  });

  test('supports multiple names in a single call', async () => {
    const ipc = makeMockClient({ tools: [], unknown: [] });
    const tool = createDescribeToolsTool(ipc as never);
    await tool.execute({ names: ['a', 'b', 'c'] });
    expect(ipc.call).toHaveBeenCalledWith({
      action: 'describe_tools',
      names: ['a', 'b', 'c'],
    });
  });

  test('returns the host response unchanged (pass-through)', async () => {
    const canned = { tools: [{ name: 'x', summary: 's', schema: {} }], unknown: ['y'] };
    const ipc = makeMockClient(canned);
    const tool = createDescribeToolsTool(ipc as never);
    const result = await tool.execute({ names: ['x', 'y'] });
    expect(result).toEqual(canned);
  });

  test('propagates IPC errors to the caller', async () => {
    const ipc = {
      call: vi.fn().mockRejectedValue(new Error('IPC connection lost')),
    };
    const tool = createDescribeToolsTool(ipc as never);
    await expect(tool.execute({ names: ['x'] })).rejects.toThrow('IPC connection lost');
  });

  test('exposes stable tool name', () => {
    const ipc = makeMockClient();
    const tool = createDescribeToolsTool(ipc as never);
    expect(tool.name).toBe('describe_tools');
  });
});

describe('createCallToolTool', () => {
  test('forwards tool + args to the call_tool IPC action', async () => {
    const ipc = makeMockClient({ result: { ok: true } });
    const tool = createCallToolTool(ipc as never);
    await tool.execute({ tool: 'mcp_linear_list_issues', args: { team: 'product' } });
    expect(ipc.call).toHaveBeenCalledTimes(1);
    expect(ipc.call).toHaveBeenCalledWith({
      action: 'call_tool',
      tool: 'mcp_linear_list_issues',
      args: { team: 'product' },
    });
  });

  test('passes through empty args', async () => {
    const ipc = makeMockClient({ result: null });
    const tool = createCallToolTool(ipc as never);
    await tool.execute({ tool: 'mcp_x_ping', args: {} });
    expect(ipc.call).toHaveBeenCalledWith({
      action: 'call_tool',
      tool: 'mcp_x_ping',
      args: {},
    });
  });

  test('forwards the _select projection knob inside args', async () => {
    // _select stripping happens host-side in the call_tool handler; the agent
    // stub must NOT drop it or the projection path (Task 4.2) breaks.
    const ipc = makeMockClient({ result: 42 });
    const tool = createCallToolTool(ipc as never);
    await tool.execute({
      tool: 'mcp_linear_list_issues',
      args: { team: 'p', _select: '.issues[0]' },
    });
    expect(ipc.call).toHaveBeenCalledWith({
      action: 'call_tool',
      tool: 'mcp_linear_list_issues',
      args: { team: 'p', _select: '.issues[0]' },
    });
  });

  test('returns the host response unchanged (pass-through)', async () => {
    const canned = { result: { ok: true, data: [1, 2, 3] } };
    const ipc = makeMockClient(canned);
    const tool = createCallToolTool(ipc as never);
    const result = await tool.execute({ tool: 'x', args: {} });
    expect(result).toEqual(canned);
  });

  test('surfaces structured host errors verbatim', async () => {
    const canned = { error: 'unknown tool: foo', kind: 'unknown_tool' };
    const ipc = makeMockClient(canned);
    const tool = createCallToolTool(ipc as never);
    const result = await tool.execute({ tool: 'foo', args: {} });
    // Errors are returned in the payload — not thrown. This matches the
    // call-tool handler contract (never throw across the IPC boundary).
    expect(result).toEqual(canned);
  });

  test('exposes stable tool name', () => {
    const ipc = makeMockClient();
    const tool = createCallToolTool(ipc as never);
    expect(tool.name).toBe('call_tool');
  });

  // ── Task 4.3: Auto-spill on oversized responses ────────────────────────
  //
  // The host emits a `{truncated: true, full, preview}` envelope when the
  // post-projection response exceeds `spill_threshold_bytes`. The agent
  // stub is responsible for persisting `full` to a sandbox-local spill
  // file and handing the LLM a stub that points at it. Keeps LLM context
  // from ballooning while giving the model a way to fetch the full
  // payload if it really needs it (`bash cat /tmp/tool-<id>.json`).

  test('persists spill file and surfaces stub when host returns truncated envelope', async () => {
    const memFs = new Map<string, string>();
    const ipc = {
      call: vi.fn().mockResolvedValue({
        truncated: true,
        full: { big: 'payload', items: [1, 2, 3] },
        preview: '{"big":"payload","items":[1,2,3]}',
      }),
    };
    const tool = createCallToolTool(ipc as never, {
      fs: {
        async writeFile(path: string, content: string) {
          memFs.set(path, content);
        },
      },
      idGenerator: () => 'abc12345',
    });

    const out = await tool.execute({ tool: 'mcp_x_y', args: {} });

    expect(out._truncated).toBe(true);
    expect(out._path).toBe('/tmp/tool-abc12345.json');
    expect(out.preview).toBe('{"big":"payload","items":[1,2,3]}');
    expect(out).not.toHaveProperty('full'); // full is NOT on the stub — it's on disk
    expect(memFs.get('/tmp/tool-abc12345.json')).toContain('payload');
    // Spilled content is the full object JSON
    const spilled = JSON.parse(memFs.get('/tmp/tool-abc12345.json')!);
    expect(spilled).toEqual({ big: 'payload', items: [1, 2, 3] });
  });

  test('passes through normal {result} envelope unchanged', async () => {
    // No truncation flag → no file write, just forward what the host returned.
    const writeFile = vi.fn();
    const ipc = makeMockClient({ result: { ok: true, n: 42 } });
    const tool = createCallToolTool(ipc as never, {
      fs: { writeFile },
      idGenerator: () => 'should-not-be-used',
    });

    const out = await tool.execute({ tool: 'mcp_x_y', args: {} });

    expect(out).toEqual({ result: { ok: true, n: 42 } });
    expect(writeFile).not.toHaveBeenCalled();
  });

  test('falls back to returning full payload when spill write fails', async () => {
    // Better a big context than losing data. Stub surfaces `_spill_failed`
    // so the agent (and logs) see the underlying reason.
    const ipc = {
      call: vi.fn().mockResolvedValue({
        truncated: true,
        full: { data: 'important' },
        preview: '{"data":"important"}',
      }),
    };
    const tool = createCallToolTool(ipc as never, {
      fs: {
        async writeFile() {
          throw new Error('ENOSPC: no space left on device');
        },
      },
      idGenerator: () => 'deadbeef',
    });

    const out = await tool.execute({ tool: 'mcp_x_y', args: {} });

    expect(out._spill_failed).toBeDefined();
    expect(String(out._spill_failed)).toMatch(/ENOSPC/);
    expect(out.result).toEqual({ data: 'important' });
    expect(out._truncated).toBeUndefined();
  });

  test('spill path uses the generated id', async () => {
    const memFs = new Map<string, string>();
    const ipc = {
      call: vi.fn().mockResolvedValue({
        truncated: true,
        full: { x: 1 },
        preview: '{"x":1}',
      }),
    };
    let counter = 0;
    const tool = createCallToolTool(ipc as never, {
      fs: { async writeFile(p, c) { memFs.set(p, c); } },
      idGenerator: () => `id${++counter}`,
    });

    const first = await tool.execute({ tool: 'mcp_x_y', args: {} });
    const second = await tool.execute({ tool: 'mcp_x_y', args: {} });

    expect(first._path).toBe('/tmp/tool-id1.json');
    expect(second._path).toBe('/tmp/tool-id2.json');
    expect([...memFs.keys()].sort()).toEqual([
      '/tmp/tool-id1.json',
      '/tmp/tool-id2.json',
    ]);
  });

  test('works without explicit fs/idGenerator deps (defaults kick in)', async () => {
    // The factory's optional second arg means unit-test callers can still use
    // the single-arg form for pass-through tests. Verify the original
    // single-arg signature still resolves a plain pass-through.
    const ipc = makeMockClient({ result: { ok: true } });
    const tool = createCallToolTool(ipc as never);
    const out = await tool.execute({ tool: 'mcp_x_y', args: {} });
    expect(out).toEqual({ result: { ok: true } });
  });
});
