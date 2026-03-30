/**
 * Generates typed TypeScript stubs from MCP tool schemas.
 *
 * Output structure:
 *   /tools/_runtime.ts          — Proxy-based batch transport over IPC
 *   /tools/<server>/index.ts    — Barrel re-exports for a server's tools
 *   /tools/<server>/<tool>.ts   — One file per tool with typed wrapper function
 *
 * The generated runtime uses JavaScript Proxy to let agents write
 * natural-looking code while secretly building a call graph:
 *
 *   const teams = linear.getTeams({});              // proxy, not awaited
 *   const issues = linear.getIssues({ teamId: teams[0].id }); // tracks dep
 *   const [t, i] = await Promise.all([teams, issues]);        // one IPC call
 *
 * Zero external dependencies — just the IPC socket that's already there.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { safePath } from '../../utils/safe-path.js';
import { compile } from 'json-schema-to-typescript';
import type { McpToolSchema } from '../../providers/mcp/types.js';
import { getLogger } from '../../logger.js';

const logger = getLogger().child({ component: 'tool-codegen' });

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ToolStubGroup {
  /** MCP server name (e.g. 'linear', 'github'). */
  server: string;
  /** Tools belonging to this server. */
  tools: McpToolSchema[];
}

export interface CodegenOptions {
  /** Base output directory (e.g. '/workspace/tools'). */
  outputDir: string;
  /** Grouped tools to generate stubs for. */
  groups: ToolStubGroup[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Convert MCP tool name to a valid TS identifier in camelCase. */
function toMethodName(name: string): string {
  return name
    .replace(/[^a-zA-Z0-9_]/g, '_')
    .replace(/_([a-z])/g, (_, c) => c.toUpperCase());
}

/**
 * Convert a JSON Schema to an inline TypeScript type string.
 *
 * Uses json-schema-to-typescript for full JSON Schema support (anyOf, oneOf,
 * $ref, enum, nullable, additionalProperties, etc.), then extracts just the
 * interface body as an inline type.
 */
async function jsonSchemaToTS(schema: Record<string, unknown>): Promise<string> {
  if (!schema || typeof schema !== 'object') return 'Record<string, unknown>';
  // Ensure it's typed as object for the compiler
  const normalized = schema.type ? schema : { type: 'object', ...schema };
  try {
    const compiled = await compile(normalized as any, 'Params', {
      bannerComment: '',
      additionalProperties: false,
    });
    // Extract the interface body: everything between the first { and last }
    const match = compiled.match(/\{([\s\S]*)\}/);
    if (match) {
      return `{${match[1]}}`;
    }
  } catch {
    // Fall through to default
  }
  return 'Record<string, unknown>';
}

// ---------------------------------------------------------------------------
// Runtime template — proxy-based batch over IPC, zero dependencies
// ---------------------------------------------------------------------------

function generateRuntime(): string {
  // NOTE: the backslash-n in string literals below are literal characters
  // in the generated file, not escape sequences in this template.
  return `/**
 * Tool runtime — auto-generated, do not edit.
 *
 * Proxy-based batching over IPC. Write normal-looking code:
 *   const teams = getTeams({});
 *   const issues = getIssues({ teamId: teams[0].id });
 *   const [t, i] = await Promise.all([teams, issues]); // one round trip
 *
 * Zero external dependencies. Supports both Unix socket and HTTP IPC.
 */

// ── Minimal IPC client (auto-detects transport) ──

const hostUrl = process.env.AX_HOST_URL;
const useHttp = !!hostUrl;

// ── HTTP IPC (k8s mode) ──

async function httpIpcCall(action: string, params: Record<string, unknown>): Promise<any> {
  const token = process.env.AX_IPC_TOKEN;
  const res = await fetch(\`\${hostUrl}/internal/ipc\`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { 'Authorization': \`Bearer \${token}\` } : {}),
    },
    body: JSON.stringify({ action, ...params }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(\`IPC HTTP \${res.status}: \${await res.text()}\`);
  return res.json();
}

// ── Socket IPC (local/subprocess mode) ──

import { connect } from 'node:net';
const socketPath = process.env.AX_IPC_SOCKET ?? '';
let msgId = 0;
let ipcSocket: import('node:net').Socket;
let ipcBuffer = Buffer.alloc(0);
const pending = new Map<string, { resolve: (v: any) => void; reject: (e: Error) => void }>();

function ensureConnected(): Promise<void> {
  if (ipcSocket) return Promise.resolve();
  return new Promise((resolve, reject) => {
    ipcSocket = connect(socketPath, () => resolve());
    ipcSocket.on('error', reject);
    ipcSocket.on('data', (chunk: Buffer) => {
      ipcBuffer = Buffer.concat([ipcBuffer, chunk]);
      while (ipcBuffer.length >= 4) {
        const len = ipcBuffer.readUInt32BE(0);
        if (ipcBuffer.length < 4 + len) break;
        const msg = JSON.parse(ipcBuffer.subarray(4, 4 + len).toString('utf8'));
        ipcBuffer = ipcBuffer.subarray(4 + len);
        if (msg._heartbeat) continue;
        const p = pending.get(msg._msgId);
        if (p) { pending.delete(msg._msgId); p.resolve(msg); }
      }
    });
  });
}

async function socketIpcCall(action: string, params: Record<string, unknown>): Promise<any> {
  await ensureConnected();
  const id = String(++msgId);
  const payload = Buffer.from(JSON.stringify({ action, ...params, _msgId: id }), 'utf8');
  const hdr = Buffer.alloc(4);
  hdr.writeUInt32BE(payload.length, 0);
  ipcSocket.write(Buffer.concat([hdr, payload]));
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    setTimeout(() => { pending.delete(id); reject(new Error('IPC timeout')); }, 60_000);
  });
}

async function ipcCall(action: string, params: Record<string, unknown>): Promise<any> {
  return useHttp ? httpIpcCall(action, params) : socketIpcCall(action, params);
}

// ── Proxy-based call graph ──

const REF = Symbol('ref');

type PendingCall = { tool: string; args: Record<string, unknown> };
let pendingCalls: PendingCall[] = [];
let flushPromise: Promise<unknown[]> | null = null;

function scheduleFlush(): Promise<unknown[]> {
  if (!flushPromise) {
    flushPromise = new Promise<unknown[]>((resolve, reject) => {
      setTimeout(async () => {
        const calls = pendingCalls;
        pendingCalls = [];
        flushPromise = null;
        try {
          const resp = await ipcCall('tool_batch', { calls });
          resolve(resp.results ?? []);
        } catch (e) { reject(e); }
      }, 0);
    });
  }
  return flushPromise;
}

function createRef(callId: number, path: string): any {
  const marker = { [REF]: true, callId, path };
  return new Proxy(marker as any, {
    get(target, prop) {
      if (prop === REF) return true;
      if (prop === 'callId') return target.callId;
      if (prop === 'path') return target.path;
      if (prop === 'then' || prop === Symbol.toPrimitive || prop === Symbol.toStringTag) return undefined;
      const seg = typeof prop === 'string' && /^\\d+$/.test(prop) ? \`[\${prop}]\` : \`.\${String(prop)}\`;
      return createRef(callId, target.path + seg);
    }
  });
}

function serializeArgs(value: any): any {
  if (value && value[REF]) return { __batchRef: value.callId, path: value.path };
  if (Array.isArray(value)) return value.map(serializeArgs);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = serializeArgs(v);
    return out;
  }
  return value;
}

/**
 * Register a tool call. Returns a thenable proxy:
 * - await it → flushes batch, returns result
 * - access properties → creates __batchRef for pipelining
 */
export function callTool(tool: string, args: Record<string, unknown>): any {
  const callId = pendingCalls.length;
  pendingCalls.push({ tool, args: serializeArgs(args) });
  const flush = scheduleFlush();

  return new Proxy({}, {
    get(_, prop) {
      if (prop === 'then') {
        return (resolve: any, reject: any) => {
          flush.then((results: any) => {
            const r = results[callId];
            if (r && typeof r === 'object' && 'ok' in r && !r.ok) reject(new Error(r.error));
            else resolve(r);
          }).catch(reject);
        };
      }
      if (prop === Symbol.toPrimitive || prop === Symbol.toStringTag) return undefined;
      const seg = typeof prop === 'string' && /^\\d+$/.test(prop) ? \`[\${prop}]\` : \`.\${String(prop)}\`;
      return createRef(callId, seg);
    }
  });
}

// Cleanup
process.on('exit', () => { if (!useHttp && ipcSocket) ipcSocket.destroy(); });
`;
}

// ---------------------------------------------------------------------------
// Per-tool stub
// ---------------------------------------------------------------------------

async function generateToolStub(
  server: string,
  tool: McpToolSchema,
  methodName: string,
): Promise<string> {
  const paramsType = tool.inputSchema
    ? await jsonSchemaToTS(tool.inputSchema)
    : 'Record<string, unknown>';
  const rpcMethod = tool.name;

  const lines = [
    `/**`,
    ` * ${tool.description?.split('\n')[0] ?? tool.name}`,
    ` *`,
    ` * MCP server: ${server}`,
    ` * MCP tool:   ${tool.name}`,
    ` *`,
    ` * CLI: node --experimental-strip-types ${methodName}.ts '{"param":"value"}'`,
    ` */`,
    `import { callTool } from '../_runtime.ts';`,
    ``,
    `export function ${methodName}(params: ${paramsType}) {`,
    `  return callTool(${JSON.stringify(rpcMethod)}, params);`,
    `}`,
    ``,
    `// CLI entrypoint — run this file directly with JSON args`,
    `if (process.argv[1]?.endsWith('${methodName}.ts')) {`,
    `  try { const r = await ${methodName}(process.argv[2] ? JSON.parse(process.argv[2]) : {}); console.log(JSON.stringify(r, null, 2)); }`,
    `  catch (e: any) { console.error(e.message ?? e); process.exit(1); }`,
    `}`,
  ];

  return lines.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// Barrel exports
// ---------------------------------------------------------------------------

function generateBarrel(
  tools: Array<{ fileName: string; methodName: string; description?: string; paramKeys?: string[] }>,
): string {
  return tools.map(({ fileName, methodName, description, paramKeys }) => {
    const desc = description ? ` // ${description}` : '';
    const params = paramKeys?.length ? ` — params: ${paramKeys.join(', ')}` : '';
    return `export { ${methodName} } from './${fileName}.ts';${desc}${params}`;
  }).join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface GeneratedStubs {
  files: string[];
  toolCount: number;
}

export async function generateToolStubs(opts: CodegenOptions): Promise<GeneratedStubs> {
  const { outputDir, groups } = opts;
  const files: string[] = [];
  let toolCount = 0;

  const runtimePath = safePath(outputDir, '_runtime.ts');
  mkdirSync(dirname(runtimePath), { recursive: true });
  writeFileSync(runtimePath, generateRuntime(), 'utf8');
  files.push(runtimePath);

  for (const group of groups) {
    const serverDir = safePath(outputDir, group.server);
    mkdirSync(serverDir, { recursive: true });

    const barrelEntries: Array<{ fileName: string; methodName: string; description?: string; paramKeys?: string[] }> = [];
    const seenNames = new Map<string, string>();

    for (const tool of group.tools) {
      const methodName = toMethodName(tool.name);
      const prior = seenNames.get(methodName);
      if (prior) {
        throw new Error(
          `Tool name collision in server "${group.server}": "${prior}" and "${tool.name}" both sanitize to "${methodName}"`,
        );
      }
      seenNames.set(methodName, tool.name);
      const filePath = join(serverDir, `${methodName}.ts`);
      writeFileSync(filePath, await generateToolStub(group.server, tool, methodName), 'utf8');
      files.push(filePath);
      const paramKeys = tool.inputSchema?.properties
        ? Object.keys(tool.inputSchema.properties as Record<string, unknown>)
        : undefined;
      barrelEntries.push({
        fileName: methodName,
        methodName,
        description: tool.description?.split('\n')[0]?.slice(0, 80),
        paramKeys,
      });
      toolCount++;
    }

    const barrelPath = join(serverDir, 'index.ts');
    writeFileSync(barrelPath, generateBarrel(barrelEntries), 'utf8');
    files.push(barrelPath);
  }

  logger.info('tool_stubs_generated', { outputDir, toolCount, fileCount: files.length });
  return { files, toolCount };
}

// ---------------------------------------------------------------------------
// CLI generation — replaces TypeScript stubs with one executable per MCP server
// ---------------------------------------------------------------------------

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

/**
 * Group flat MCP tool schemas by server name.
 *
 * Uses the `server` field on each tool when available (set by discoverAllTools).
 * Falls back to inferring from tool names in 'serverName_toolName' or
 * 'serverName/toolName' form. Tools without a server go in a 'default' group.
 */
export function groupToolsByServer(tools: McpToolSchema[]): ToolStubGroup[] {
  const map = new Map<string, McpToolSchema[]>();

  for (const tool of tools) {
    if (tool.server) {
      // Server is known — use the tool name as-is (no stripping)
      if (!map.has(tool.server)) map.set(tool.server, []);
      map.get(tool.server)!.push({ ...tool, server: undefined });
    } else {
      // Legacy fallback: infer server from tool name prefix
      const indices = [tool.name.indexOf('_'), tool.name.indexOf('/')]
        .filter(i => i > 0);
      const sepIdx = indices.length > 0 ? Math.min(...indices) : -1;
      const server = sepIdx > 0 ? tool.name.slice(0, sepIdx) : 'default';
      const localName = sepIdx > 0 ? tool.name.slice(sepIdx + 1) : tool.name;
      if (!map.has(server)) map.set(server, []);
      map.get(server)!.push({ ...tool, name: localName, server: undefined });
    }
  }

  return [...map.entries()].map(([server, serverTools]) => ({
    server,
    tools: serverTools,
  }));
}
