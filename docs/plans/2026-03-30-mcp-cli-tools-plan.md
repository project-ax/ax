# MCP CLI Tools Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace TypeScript tool stubs with one executable CLI per MCP server in `agent/bin/`, callable by name (already in PATH).

**Architecture:** The codegen generates a single self-contained JS file per MCP server with `#!/usr/bin/env node` shebang. Each file contains an IPC client (HTTP fetch), a declarative tool registry, and a generic argv parser with `--help`. The host sends these as files in the payload (same transport as current stubs). The agent writes them to `agentWorkspace/bin/` with `chmod +x`.

**Tech Stack:** Plain JavaScript (no TypeScript, no dependencies), Node.js built-in `fetch`.

---

### Task 1: New codegen — `generateCLI()`

Replace the stub generation with a single-file CLI generator.

**Files:**
- Modify: `src/host/capnweb/codegen.ts`

**Step 1: Write the test**

Create a test that verifies CLI generation from MCP tool schemas.

```typescript
// tests/host/capnweb/codegen.test.ts — add to existing test file or create

import { describe, it, expect } from 'vitest';
import { generateCLI, mcpToolToCLICommand } from '../../../src/host/capnweb/codegen.js';

describe('mcpToolToCLICommand', () => {
  it('parses list_issues → list issues', () => {
    expect(mcpToolToCLICommand('list_issues')).toEqual({ verb: 'list', noun: 'issues' });
  });
  it('parses get_team → get team', () => {
    expect(mcpToolToCLICommand('get_team')).toEqual({ verb: 'get', noun: 'team' });
  });
  it('parses save_customer_need → save customer-need', () => {
    expect(mcpToolToCLICommand('save_customer_need')).toEqual({ verb: 'save', noun: 'customer-need' });
  });
  it('parses search_documentation → search documentation', () => {
    expect(mcpToolToCLICommand('search_documentation')).toEqual({ verb: 'search', noun: 'documentation' });
  });
  it('parses extract_images → extract images', () => {
    expect(mcpToolToCLICommand('extract_images')).toEqual({ verb: 'extract', noun: 'images' });
  });
  it('parses get_authenticated_user → get authenticated-user', () => {
    expect(mcpToolToCLICommand('get_authenticated_user')).toEqual({ verb: 'get', noun: 'authenticated-user' });
  });
});

describe('generateCLI', () => {
  it('generates a valid JS file with shebang', () => {
    const result = generateCLI('linear', [
      { name: 'list_issues', description: 'List issues', inputSchema: { type: 'object', properties: { team: { type: 'string' }, limit: { type: 'number' } } } },
      { name: 'get_issue', description: 'Get issue by ID', inputSchema: { type: 'object', properties: { id: { type: 'string' } } } },
    ]);
    expect(result).toMatch(/^#!\/usr\/bin\/env node\n/);
    expect(result).toContain("'list issues'");
    expect(result).toContain("'get issue'");
    expect(result).toContain('list_issues');
    expect(result).toContain('--team');
    expect(result).toContain('--limit');
    expect(result).toContain('--id');
    // Help output groups
    expect(result).toContain("'Issues'");
  });

  it('includes IPC client using fetch', () => {
    const result = generateCLI('linear', [
      { name: 'list_teams', description: 'List teams', inputSchema: { type: 'object', properties: { limit: { type: 'number' } } } },
    ]);
    expect(result).toContain('AX_HOST_URL');
    expect(result).toContain('AX_IPC_TOKEN');
    expect(result).toContain('/internal/ipc');
    expect(result).toContain('tool_batch');
  });

  it('handles stdin piping', () => {
    const result = generateCLI('linear', [
      { name: 'list_teams', description: 'List teams', inputSchema: { type: 'object', properties: {} } },
    ]);
    expect(result).toContain('stdin');
    expect(result).toContain('JSON.parse');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/host/capnweb/codegen.test.ts`
Expected: FAIL — `generateCLI` and `mcpToolToCLICommand` don't exist yet

**Step 3: Implement `mcpToolToCLICommand()` and `generateCLI()`**

In `src/host/capnweb/codegen.ts`, add:

```typescript
/**
 * Parse an MCP tool name into verb + noun for CLI subcommands.
 * list_issues → { verb: 'list', noun: 'issues' }
 * get_authenticated_user → { verb: 'get', noun: 'authenticated-user' }
 */
export function mcpToolToCLICommand(toolName: string): { verb: string; noun: string } {
  const parts = toolName.split('_');
  const verb = parts[0];
  const noun = parts.slice(1).join('-');
  return { verb, noun };
}

/**
 * Infer a group name from the noun (pluralize/singularize to title case).
 * issues → Issues, team → Teams, customer-need → Customer Needs
 */
function inferGroup(noun: string): string {
  const base = noun.replace(/-/g, ' ');
  // Capitalize each word
  const titled = base.replace(/\b\w/g, c => c.toUpperCase());
  // Ensure plural
  if (!titled.endsWith('s') && !titled.endsWith('tion')) return titled + 's';
  return titled;
}

/**
 * Generate a self-contained CLI executable for an MCP server.
 */
export function generateCLI(
  server: string,
  tools: McpToolSchema[],
): string {
  // Build the TOOLS registry
  const toolEntries = tools.map(tool => {
    const { verb, noun } = mcpToolToCLICommand(tool.name);
    const cmd = `${verb} ${noun}`;
    const params = tool.inputSchema?.properties
      ? Object.keys(tool.inputSchema.properties as Record<string, unknown>)
      : [];
    const group = inferGroup(noun);
    const desc = tool.description?.split('\n')[0]?.slice(0, 80) ?? tool.name;
    return `  '${cmd}': { tool: '${tool.name}', desc: '${desc.replace(/'/g, "\\'")}', group: '${group}', params: [${params.map(p => `'${p}'`).join(', ')}] }`;
  });

  return `#!/usr/bin/env node
// Auto-generated CLI for ${server} MCP server. Do not edit.
'use strict';

// ── IPC ──────────────────────────────────────────────
async function ipc(tool, params) {
  const hostUrl = process.env.AX_HOST_URL;
  const token = process.env.AX_IPC_TOKEN;
  if (!hostUrl) { process.stderr.write('Error: AX_HOST_URL not set\\n'); process.exit(1); }
  const res = await fetch(hostUrl + '/internal/ipc', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: JSON.stringify({ action: 'tool_batch', calls: [{ tool, args: params }] }),
    signal: AbortSignal.timeout(120000),
  });
  if (!res.ok) { process.stderr.write('Error: HTTP ' + res.status + ' ' + (await res.text()) + '\\n'); process.exit(1); }
  const data = await res.json();
  const result = data.results?.[0];
  if (result && typeof result === 'object' && 'ok' in result && !result.ok) {
    process.stderr.write('Error: ' + (result.error || 'tool call failed') + '\\n');
    process.exit(1);
  }
  return result;
}

// ── Tools ────────────────────────────────────────────
const TOOLS = {
${toolEntries.join(',\n')}
};

// ── Help ─────────────────────────────────────────────
function showHelp() {
  process.stdout.write('Usage: ${server} <verb> <noun> [--flag value ...]\\n\\n');
  const groups = {};
  for (const [cmd, t] of Object.entries(TOOLS)) {
    if (!groups[t.group]) groups[t.group] = [];
    groups[t.group].push({ cmd, ...t });
  }
  for (const [group, cmds] of Object.entries(groups)) {
    process.stdout.write(group + ':\\n');
    for (const c of cmds) {
      const flags = c.params.length ? ' [--' + c.params.join(', --') + ']' : '';
      process.stdout.write('  ' + c.cmd.padEnd(24) + c.desc + flags + '\\n');
    }
    process.stdout.write('\\n');
  }
}

// ── Argv parser ──────────────────────────────────────
function parseArgs(argv) {
  const params = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      const val = argv[i + 1];
      if (val === undefined || val.startsWith('--')) { params[key] = true; i++; continue; }
      // Try to parse as number/boolean/JSON
      if (val === 'true') params[key] = true;
      else if (val === 'false') params[key] = false;
      else if (/^-?\\d+(\\.\\d+)?$/.test(val)) params[key] = Number(val);
      else params[key] = val;
      i++;
    }
  }
  return params;
}

// ── Stdin ────────────────────────────────────────────
async function readStdin() {
  if (process.stdin.isTTY) return null;
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (!text) return null;
  try { return JSON.parse(text); } catch { return null; }
}

// ── Main ─────────────────────────────────────────────
async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') { showHelp(); return; }

  const verb = args[0];
  const noun = args[1] || '';
  const cmd = verb + ' ' + noun;
  const entry = TOOLS[cmd];
  if (!entry) {
    // Try verb-only match
    const match = Object.keys(TOOLS).find(k => k.startsWith(verb + ' '));
    if (match) { process.stderr.write('Unknown: ' + cmd + '. Did you mean: ' + match + '?\\n'); }
    else { process.stderr.write('Unknown command: ' + cmd + '. Run ${server} --help\\n'); }
    process.exit(1);
  }

  const flagParams = parseArgs(args.slice(2));
  const stdinParams = await readStdin();
  const params = { ...(stdinParams && typeof stdinParams === 'object' && !Array.isArray(stdinParams) ? stdinParams : {}), ...flagParams };

  const result = await ipc(entry.tool, params);

  // Unwrap single-key objects with array values for cleaner piping
  if (result && typeof result === 'object' && !Array.isArray(result)) {
    const keys = Object.keys(result);
    if (keys.length === 1 && Array.isArray(result[keys[0]])) {
      process.stdout.write(JSON.stringify(result[keys[0]], null, 2) + '\\n');
      return;
    }
  }
  process.stdout.write(JSON.stringify(result, null, 2) + '\\n');
}

main().catch(e => { process.stderr.write('Error: ' + (e.message || e) + '\\n'); process.exit(1); });
`;
}
```

Keep the existing `generateToolStubs()`, `groupToolsByServer()`, and `toMethodName()` functions — they're still used by the caching layer. We'll remove them in a later cleanup task.

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/host/capnweb/codegen.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/host/capnweb/codegen.ts tests/host/capnweb/codegen.test.ts
git commit -m "feat(codegen): add generateCLI() for MCP CLI tools"
```

---

### Task 2: Update `generate-and-cache.ts` to produce CLI files

**Files:**
- Modify: `src/host/capnweb/generate-and-cache.ts`

**Step 1: Write the test**

```typescript
// tests/host/capnweb/generate-and-cache.test.ts

import { describe, it, expect } from 'vitest';
import { prepareMcpCLIs } from '../../../src/host/capnweb/generate-and-cache.js';
import type { McpToolSchema } from '../../../src/providers/mcp/types.js';

describe('prepareMcpCLIs', () => {
  it('generates one CLI file per server', async () => {
    const tools: McpToolSchema[] = [
      { name: 'list_issues', description: 'List issues', inputSchema: { type: 'object', properties: { team: { type: 'string' } } }, server: 'linear' },
      { name: 'get_issue', description: 'Get issue', inputSchema: { type: 'object', properties: { id: { type: 'string' } } }, server: 'linear' },
      { name: 'list_repos', description: 'List repos', inputSchema: { type: 'object', properties: {} }, server: 'github' },
    ];
    const result = await prepareMcpCLIs({ agentName: 'test', tools });
    expect(result).toHaveLength(2);
    expect(result!.find(f => f.path === 'linear')).toBeTruthy();
    expect(result!.find(f => f.path === 'github')).toBeTruthy();
    expect(result![0].content).toMatch(/^#!\/usr\/bin\/env node/);
  });

  it('returns null for empty tools', async () => {
    const result = await prepareMcpCLIs({ agentName: 'test', tools: [] });
    expect(result).toBeNull();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/host/capnweb/generate-and-cache.test.ts`
Expected: FAIL — `prepareMcpCLIs` doesn't exist

**Step 3: Add `prepareMcpCLIs()` to `generate-and-cache.ts`**

```typescript
import { generateCLI, groupToolsByServer } from './codegen.js';
import type { McpToolSchema } from '../../providers/mcp/types.js';
import type { ToolStubFile } from '../../providers/storage/tool-stubs.js';

export interface PrepareMcpCLIsOptions {
  agentName: string;
  tools: McpToolSchema[];
  // No documents/caching for now — CLIs are cheap to generate
}

export async function prepareMcpCLIs(
  opts: PrepareMcpCLIsOptions,
): Promise<ToolStubFile[] | null> {
  const { tools } = opts;
  if (tools.length === 0) return null;

  const groups = groupToolsByServer(tools);
  const files: ToolStubFile[] = [];

  for (const group of groups) {
    const content = generateCLI(group.server, group.tools);
    files.push({ path: group.server, content });
  }

  return files.length > 0 ? files : null;
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/host/capnweb/generate-and-cache.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/host/capnweb/generate-and-cache.ts tests/host/capnweb/generate-and-cache.test.ts
git commit -m "feat(codegen): add prepareMcpCLIs() to generate CLI files"
```

---

### Task 3: Update host payload to send CLI files instead of stubs

**Files:**
- Modify: `src/host/server-completions.ts`

**Step 1: Replace `toolStubsPayload` with `mcpCLIsPayload`**

In `processCompletion()`, find the tool stubs section (~line 898) and replace the `prepareToolStubs` call with `prepareMcpCLIs`:

```typescript
// ── Generate MCP CLI tools ──
let mcpCLIsPayload: Array<{ path: string; content: string }> | undefined;
if (deps.mcpManager) {
  try {
    // ... existing resolveHeaders/authForServer setup stays the same ...
    const mcpTools = await deps.mcpManager.discoverAllTools(agentName, { resolveHeaders, authForServer });
    if (mcpTools.length > 0) {
      const { prepareMcpCLIs } = await import('./capnweb/generate-and-cache.js');
      const clis = await prepareMcpCLIs({ agentName, tools: mcpTools });
      if (clis && clis.length > 0) mcpCLIsPayload = clis;
    }
  } catch (err) {
    reqLogger.warn('mcp_cli_generation_failed', { error: (err as Error).message });
  }
}
```

In the `stdinPayload` object, replace `toolStubs: toolStubsPayload` with `mcpCLIs: mcpCLIsPayload`.

Keep the legacy `toolStubs` field alongside for backward compat during rollout — remove in a follow-up.

**Step 2: Commit**

```bash
git add src/host/server-completions.ts
git commit -m "feat(completions): send MCP CLI files in payload"
```

---

### Task 4: Update agent runner to write CLI files to `bin/`

**Files:**
- Modify: `src/agent/runner.ts`

**Step 1: Add `mcpCLIs` to `StdinPayload` interface**

```typescript
/** MCP CLI executables — one file per server, written to agentWorkspace/bin/. */
mcpCLIs?: Array<{ path: string; content: string }>;
```

**Step 2: Parse in `parseStdinPayload()`**

Add alongside the existing `toolStubs` parsing:
```typescript
mcpCLIs: Array.isArray(parsed.mcpCLIs) ? parsed.mcpCLIs : undefined,
```

**Step 3: Write CLI files in `applyPayload()`**

Add after the tool stubs section:

```typescript
// ── Write MCP CLI executables to agentWorkspace/bin/ ──
if (Array.isArray(payload.mcpCLIs) && config.agentWorkspace) {
  const binDir = resolve(config.agentWorkspace, 'bin');
  mkdirSync(binDir, { recursive: true });
  for (const file of payload.mcpCLIs) {
    const filePath = resolve(binDir, file.path);
    if (!filePath.startsWith(binDir + sep) && filePath !== binDir) {
      logger.warn('mcp_cli_path_traversal_blocked', { path: file.path });
      continue;
    }
    writeFileSync(filePath, file.content, { mode: 0o755 });
  }
  logger.info('mcp_clis_written', { count: payload.mcpCLIs.length, dir: binDir });
}
```

**Step 4: Commit**

```bash
git add src/agent/runner.ts
git commit -m "feat(runner): write MCP CLI executables to agent/bin/"
```

---

### Task 5: Update prompt to show CLI tools

**Files:**
- Modify: `src/agent/prompt/types.ts`
- Modify: `src/agent/prompt/modules/runtime.ts`
- Modify: `src/agent/agent-setup.ts`

**Step 1: Add `mcpCLIs` to `PromptContext`**

In `src/agent/prompt/types.ts`, add:
```typescript
/** MCP CLI tool names available in PATH (e.g. ['linear', 'github']). */
mcpCLIs?: string[];
```

**Step 2: Detect CLI tools in `agent-setup.ts`**

Replace `scanToolStubServers()` with a simpler scan of `agentWorkspace/bin/`:

```typescript
function scanMcpCLIs(agentWorkspace?: string): string[] | undefined {
  if (!agentWorkspace) return undefined;
  const binDir = resolve(agentWorkspace, 'bin');
  if (!existsSync(binDir)) return undefined;
  try {
    const entries = readdirSync(binDir).filter(f => {
      try { return statSync(join(binDir, f)).isFile(); } catch { return false; }
    });
    return entries.length > 0 ? entries : undefined;
  } catch { return undefined; }
}
```

In the `promptBuilder.build()` call, replace `hasToolStubs`/`toolStubServers` with:
```typescript
mcpCLIs: scanMcpCLIs(config.agentWorkspace),
```

Keep `hasToolStubs` for backward compat — set it to `false` when `mcpCLIs` is present.

**Step 3: Update prompt rendering**

In `src/agent/prompt/modules/runtime.ts`, replace the `hasToolStubs` block:

```typescript
...(ctx.mcpCLIs?.length ? [
  `  - ./agent/bin/ — MCP tool CLIs (in PATH)`,
  `    Run \`<tool> --help\` for usage. Available: ${ctx.mcpCLIs.join(', ')}`,
] : []),
```

**Step 4: Commit**

```bash
git add src/agent/prompt/types.ts src/agent/prompt/modules/runtime.ts src/agent/agent-setup.ts
git commit -m "feat(prompt): show MCP CLI tools in system prompt"
```

---

### Task 6: End-to-end test against kind cluster

**Step 1: Rebuild and deploy**

```bash
npm run build
docker build -f container/agent/Dockerfile -t ax:latest .
kind load docker-image ax:latest --name ax

# Clear old stubs cache
PW=$(kubectl --context kind-ax get secret ax-postgresql -n ax -o jsonpath='{.data.postgres-password}' | base64 -d)
kubectl exec ax-postgresql-0 -n ax -- env PGPASSWORD="$PW" psql -U postgres -d ax -c "DELETE FROM documents WHERE collection = 'tool-stubs';"

kubectl rollout restart deployment/ax-host -n ax
# Wait for pods, delete old sandboxes
```

**Step 2: Verify CLI files are written**

```bash
SANDBOX=$(kubectl get pods -n ax --no-headers | grep sandbox.*Running | head -1 | awk '{print $1}')
kubectl exec $SANDBOX -n ax -- ls -la /workspace/agent/bin/
kubectl exec $SANDBOX -n ax -- /workspace/agent/bin/linear --help
```

Expected: `linear` executable exists, `--help` shows grouped commands.

**Step 3: Send test request**

```bash
curl -X POST http://localhost:18080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "X-AX-User: testuser" \
  -d '{"model":"default","messages":[{"role":"user","content":"get all linear issues in this cycle"}]}'
```

Expected: ≤5 tool calls, real Linear data in response.

**Step 4: Verify multi-step query**

```bash
curl -X POST http://localhost:18080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "X-AX-User: testuser" \
  -d '{"model":"default","messages":[{"role":"user","content":"list all issues from the last 3 cycles"}]}'
```

Expected: LLM uses `linear list cycles`, then `linear list issues --cycle <id>` for each.

**Step 5: Commit any fixes**

---

### Task 7: Clean up old stub code

Only after e2e tests pass. Remove:
- `generateRuntime()`, `generateToolStub()`, `generateBarrel()` from codegen.ts
- `prepareToolStubs()` from generate-and-cache.ts (keep `prepareMcpCLIs`)
- `toolStubs` from StdinPayload (keep `mcpCLIs`)
- `scanToolStubServers()` from agent-setup.ts
- `hasToolStubs`, `toolStubServers` from PromptContext
- Old tool stubs writing section from `applyPayload()`
- Remove `toolStubs` from server-completions.ts payload

```bash
git commit -m "refactor: remove old TypeScript stub codegen"
```
