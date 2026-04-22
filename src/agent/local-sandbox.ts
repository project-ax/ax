/**
 * Agent-side local sandbox execution — runs tools inside the agent's own
 * container with host audit gate.
 *
 * Protocol per tool call:
 * 1. sandbox_approve → host audits, returns {approved: true/false}
 * 2. Execute locally (only if approved)
 * 3. sandbox_result → host logs outcome (best-effort)
 */
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { minimatch } from 'minimatch';
import { stringify as stringifyYaml } from 'yaml';
import type { IIPCClient } from './runner.js';
import { safePath } from '../utils/safe-path.js';
import { parseSkillFile } from '../skills/parser.js';
import {
  frontmattersEqual,
  changedFrontmatterFields,
  isInteractiveSession,
} from '../skills/frontmatter-diff.js';

/** Check once whether rg is available on this system. */
let _rgAvailable: boolean | undefined;
function isRgAvailable(): boolean {
  if (_rgAvailable === undefined) {
    try {
      const r = spawnSync('rg', ['--version'], { timeout: 5000 });
      _rgAvailable = r.status === 0;
    } catch {
      _rgAvailable = false;
    }
  }
  return _rgAvailable;
}

/** Recursively walk a directory, yielding file paths. */
function* walkDir(dir: string): Generator<string> {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walkDir(full);
    } else if (entry.isFile()) {
      yield full;
    }
  }
}

/** Compile a user-supplied regex with length guard and error handling. */
function safeRegExp(pattern: string, maxLen = 10_000): RegExp {
  if (pattern.length > maxLen) throw new Error(`Pattern too long (${pattern.length} > ${maxLen})`);
  return new RegExp(pattern);
}

/** Pure Node.js grep fallback. */
function nodeGrep(
  searchPath: string,
  pattern: string,
  opts: { maxResults: number; lineNumbers: boolean; glob?: string },
): { matches: string; truncated: boolean; count: number } {
  const re = safeRegExp(pattern);
  let output = '';
  let count = 0;
  let truncated = false;
  for (const filePath of walkDir(searchPath)) {
    if (truncated) break;
    const relPath = relative(searchPath, filePath);
    if (opts.glob && !minimatch(relPath, opts.glob)) continue;
    let content: string;
    try { content = readFileSync(filePath, 'utf-8'); } catch { continue; }
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (re.test(lines[i])) {
        if (count >= opts.maxResults) { truncated = true; break; }
        const prefix = opts.lineNumbers ? `${relPath}:${i + 1}:` : `${relPath}:`;
        output += (output ? '\n' : '') + prefix + lines[i];
        count++;
      }
    }
  }
  return { matches: output, truncated, count };
}

/** Pure Node.js glob fallback. */
function nodeGlob(
  basePath: string,
  pattern: string,
  maxResults: number,
): { files: string[]; truncated: boolean; count: number } {
  const files: string[] = [];
  let truncated = false;
  for (const filePath of walkDir(basePath)) {
    const relPath = relative(basePath, filePath);
    if (minimatch(relPath, pattern, { matchBase: true })) {
      if (files.length >= maxResults) { truncated = true; break; }
      files.push(relPath);
    }
  }
  return { files, truncated, count: files.length };
}

export interface LocalSandboxOptions {
  client: IIPCClient;
  workspace: string;
  timeoutMs?: number;
  /** Inbound session ID for this turn. Used by `writeSkillFile` to gate
   *  frontmatter mutations: only `http:`-prefixed (chat-UI-originated)
   *  sessions can rewrite frontmatter of an existing skill; heartbeat /
   *  cron / channel sessions can still create new skills or edit the
   *  markdown body, but can't break admin-approved state. */
  sessionId?: string;
}

export function createLocalSandbox(opts: LocalSandboxOptions) {
  const { client, workspace, timeoutMs = 120_000, sessionId } = opts;

  function safeWorkspacePath(relativePath: string): string {
    // "." means workspace root — return it directly
    if (relativePath === '.' || relativePath === './') return workspace;
    // Normalize workspace to strip trailing separators for consistent comparison
    const normalizedWs = workspace.replace(/[/\\]+$/, '');
    // Strip workspace prefix if the LLM sent an absolute path rooted in workspace
    let path = relativePath;
    if (path === normalizedWs) {
      return workspace;
    } else if (path.startsWith(normalizedWs + '/') || path.startsWith(normalizedWs + '\\')) {
      path = path.slice(normalizedWs.length + 1);
    }
    const segments = path.split(/[/\\]/).filter(Boolean);
    if (segments.length === 0) return workspace;
    return safePath(workspace, ...segments);
  }

  async function approve(fields: Record<string, unknown>): Promise<{ approved: boolean; reason?: string }> {
    return await client.call({ action: 'sandbox_approve', ...fields }) as any;
  }

  function report(fields: Record<string, unknown>): void {
    client.call({ action: 'sandbox_result', ...fields }).catch(() => {});
  }

  return {
    async bash(command: string): Promise<{ output: string }> {
      const approval = await approve({
        operation: 'bash',
        command,
      });
      if (!approval.approved) {
        return { output: `Denied: ${approval.reason ?? 'denied by host policy'}` };
      }

      const MAX_BUFFER = 1024 * 1024;
      return new Promise<{ output: string }>((resolve) => {
        // nosemgrep: javascript.lang.security.detect-child-process — sandbox tool
        const child = spawn('bash', ['-c', command], {
          cwd: workspace,
          stdio: ['pipe', 'pipe', 'pipe'],
          detached: true,  // own process group so we can kill the entire tree
        });

        let stdout = '';
        let stderr = '';
        let killed = false;

        child.stdout.on('data', (chunk: Buffer) => {
          if (stdout.length < MAX_BUFFER) stdout += chunk.toString('utf-8');
        });
        child.stderr.on('data', (chunk: Buffer) => {
          if (stderr.length < MAX_BUFFER) stderr += chunk.toString('utf-8');
        });

        // Kill the entire process group (sh + children like npm, node, etc.)
        // so pipes close and the 'close' event fires promptly.
        const killGroup = (signal: NodeJS.Signals) => {
          try { process.kill(-child.pid!, signal); } catch { /* already dead */ }
        };

        const timer = setTimeout(() => {
          killed = true;
          killGroup('SIGTERM');
          setTimeout(() => killGroup('SIGKILL'), 5_000);
        }, timeoutMs);

        child.on('close', (code) => {
          clearTimeout(timer);
          const exitCode = code ?? (killed ? 124 : 1);
          const combined = [stdout, stderr].filter(Boolean).join('\n');
          const output = combined || (killed ? 'Command timed out' : exitCode === 0 ? '(no output)' : 'Command failed');
          report({ operation: 'bash', command, output: output.slice(0, 500_000), exitCode });
          resolve(exitCode !== 0 ? { output: `Exit code ${exitCode}\n${output}` } : { output });
        });

        child.on('error', (err) => {
          clearTimeout(timer);
          const output = `Command error: ${err.message}`;
          report({ operation: 'bash', command, output, exitCode: 1 });
          resolve({ output: `Exit code 1\n${output}` });
        });
      });
    },

    async readFile(path: string): Promise<{ content?: string; error?: string }> {
      const approval = await approve({ operation: 'read', path });
      if (!approval.approved) return { error: `Denied: ${approval.reason ?? 'denied by host policy'}` };
      try {
        const content = readFileSync(safeWorkspacePath(path), 'utf-8');
        report({ operation: 'read', path, success: true });
        return { content };
      } catch (err: unknown) {
        const error = `Error reading file: ${(err as Error).message}`;
        report({ operation: 'read', path, success: false, error });
        return { error };
      }
    },

    async writeFile(path: string, content: string): Promise<{ written?: boolean; error?: string; path?: string }> {
      const approval = await approve({ operation: 'write', path, content });
      if (!approval.approved) return { error: `Denied: ${approval.reason ?? 'denied by host policy'}` };
      try {
        const abs = safeWorkspacePath(path);
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, content, 'utf-8');
        report({ operation: 'write', path, success: true });
        return { written: true, path };
      } catch (err: unknown) {
        const error = `Error writing file: ${(err as Error).message}`;
        report({ operation: 'write', path, success: false, error });
        return { error };
      }
    },

    /**
     * Serialize structured skill args to YAML frontmatter + body, validate
     * the round-trip against `SkillFrontmatterSchema`, and write to
     * `.ax/skills/<name>/SKILL.md`. The validator lives in `src/skills/` so
     * this can run inside the sandbox container — in k8s that matters
     * because the git sidecar only sees files that the pod writes to its
     * own /workspace mount, not files the host process writes to its own
     * workspace copy.
     */
    async writeSkillFile(args: {
      name: string;
      description: string;
      source?: { url: string; version?: string };
      credentials?: Array<Record<string, unknown>>;
      mcpServers?: Array<Record<string, unknown>>;
      openapi?: Array<Record<string, unknown>>;
      domains?: string[];
      body: string;
    }): Promise<{ written?: boolean; error?: string; path?: string; bytes?: number }> {
      const path = `.ax/skills/${args.name}/SKILL.md`;

      // Build frontmatter object — omit empty optional arrays so the YAML
      // matches what the agent would hand-write and the reconciler sees a
      // clean shape. Canonical key order matches serializeFrontmatter in
      // server-admin-skills-helpers.ts so agent-authored and
      // admin-rewritten files produce identical YAML.
      const frontmatter: Record<string, unknown> = { name: args.name };
      if (args.description) frontmatter.description = args.description;
      if (args.source !== undefined) frontmatter.source = args.source;
      if (Array.isArray(args.credentials) && args.credentials.length > 0) {
        frontmatter.credentials = args.credentials;
      }
      if (Array.isArray(args.mcpServers) && args.mcpServers.length > 0) {
        frontmatter.mcpServers = args.mcpServers;
      }
      if (Array.isArray(args.openapi) && args.openapi.length > 0) {
        frontmatter.openapi = args.openapi;
      }
      if (Array.isArray(args.domains) && args.domains.length > 0) {
        frontmatter.domains = args.domains;
      }

      const body = typeof args.body === 'string' ? args.body : '';
      const yamlBlock = stringifyYaml(frontmatter, { lineWidth: 0 });
      const content = `---\n${yamlBlock}---\n\n${body}`;

      // Round-trip through the same parser the git sidecar uses at commit
      // time. If it passes here, it will pass there — no split-brain.
      const parsed = parseSkillFile(content);
      if (!parsed.ok) {
        return {
          error:
            `SKILL.md validation failed for \`${args.name}\`:\n  ${parsed.error}\n\n` +
            `The file was NOT written. Reread the error, correct the ` +
            `offending field(s) in your next skill_write call, and retry. ` +
            `Common mistakes: authType must be exactly \`api_key\` or \`oauth\` ` +
            `(snake_case), description must be a non-empty string, ` +
            `mcpServers[].credential is a bare envName string (not a nested object).`,
        };
      }
      if (parsed.frontmatter.name !== args.name) {
        return {
          error:
            `Refusing to write: frontmatter.name "${parsed.frontmatter.name}" does not ` +
            `match the \`name\` arg "${args.name}". These must be identical.`,
        };
      }

      // Non-interactive turn guard. Heartbeat / cron / channel turns
      // must NOT mutate the frontmatter of an existing skill — they
      // commonly flip envName / credential / transport in an attempt to
      // "fix" a pending skill, silently breaking admin-approved state.
      // New skills (no existing file) and body-only edits (identical
      // frontmatter) still pass through.
      if (!isInteractiveSession(sessionId)) {
        const abs = safeWorkspacePath(path);
        try {
          const existingContent = readFileSync(abs, 'utf-8');
          const existingParsed = parseSkillFile(existingContent);
          if (existingParsed.ok && !frontmattersEqual(existingParsed.frontmatter, parsed.frontmatter)) {
            const changed = changedFrontmatterFields(existingParsed.frontmatter, parsed.frontmatter);
            return {
              error:
                `Refusing to mutate SKILL.md frontmatter from a non-interactive session. ` +
                `Heartbeat / cron / channel turns can update the body of a skill but ` +
                `can't change its frontmatter — those fields are admin-approved and ` +
                `rewriting them would flip the skill PENDING and break stored credentials. ` +
                `Changed fields: ${changed.join(', ')}. ` +
                `If you think this needs a real change, surface the problem in the ` +
                `next user turn and let the admin re-approve via the dashboard.`,
            };
          }
        } catch (err: unknown) {
          // ENOENT = first write of a new skill; allowed. Other errors
          // (permission, disk) fall through to the writeFileSync below.
          const e = err as NodeJS.ErrnoException;
          if (e.code !== 'ENOENT') throw err;
        }
      }

      const approval = await approve({ operation: 'write', path, content });
      if (!approval.approved) return { error: `Denied: ${approval.reason ?? 'denied by host policy'}` };

      try {
        const abs = safeWorkspacePath(path);
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, content, 'utf-8');
        report({ operation: 'write', path, success: true });
        return { written: true, path, bytes: content.length };
      } catch (err: unknown) {
        const error = `Error writing SKILL.md: ${(err as Error).message}`;
        report({ operation: 'write', path, success: false, error });
        return { error };
      }
    },

    async editFile(path: string, oldString: string, newString: string): Promise<{ edited?: boolean; error?: string; path?: string }> {
      const approval = await approve({ operation: 'edit', path, old_string: oldString, new_string: newString });
      if (!approval.approved) return { error: `Denied: ${approval.reason ?? 'denied by host policy'}` };
      try {
        const abs = safeWorkspacePath(path);
        const content = readFileSync(abs, 'utf-8');
        if (!content.includes(oldString)) return { error: 'old_string not found in file' };
        writeFileSync(abs, content.replace(oldString, newString), 'utf-8');
        report({ operation: 'edit', path, success: true });
        return { edited: true, path };
      } catch (err: unknown) {
        const error = `Error editing file: ${(err as Error).message}`;
        report({ operation: 'edit', path, success: false, error });
        return { error };
      }
    },

    async grep(pattern: string, opts?: {
      path?: string;
      glob?: string;
      max_results?: number;
      include_line_numbers?: boolean;
      context_lines?: number;
    }): Promise<{ matches: string; truncated: boolean; count: number }> {
      const approval = await approve({ operation: 'grep', path: opts?.path ?? '.' });
      if (!approval.approved) {
        return { matches: `Denied: ${approval.reason ?? 'denied by host policy'}`, truncated: false, count: 0 };
      }

      const maxResults = opts?.max_results ?? 100;
      const includeLineNumbers = opts?.include_line_numbers !== false;
      const contextLines = opts?.context_lines ?? 0;

      const searchPath = opts?.path
        ? safeWorkspacePath(opts.path)
        : workspace;

      // Fall back to pure Node.js grep if rg is not installed
      if (!isRgAvailable()) {
        const result = nodeGrep(searchPath, pattern, {
          maxResults,
          lineNumbers: includeLineNumbers,
          glob: opts?.glob,
        });
        report({ operation: 'grep', path: opts?.path ?? '.', success: true });
        return result;
      }

      const args: string[] = ['--no-heading', '--color', 'never'];
      if (includeLineNumbers) args.push('-n');
      if (contextLines > 0) args.push('-C', String(contextLines));
      if (opts?.glob) args.push('--glob', opts.glob);
      args.push('--', pattern);
      args.push(searchPath);

      return new Promise<{ matches: string; truncated: boolean; count: number }>((resolve) => {
        const child = spawn('rg', args, {
          cwd: workspace,
          stdio: ['pipe', 'pipe', 'pipe'],
        });

        let output = '';
        let lineCount = 0;
        let truncated = false;

        child.stdout.on('data', (chunk: Buffer) => {
          if (truncated) return;
          const text = chunk.toString('utf-8');
          const lines = text.split('\n');
          for (const line of lines) {
            if (lineCount >= maxResults) { truncated = true; return; }
            if (line || lineCount > 0) {
              output += (output ? '\n' : '') + line;
              if (line) lineCount++;
            }
          }
        });

        child.on('close', (code) => {
          const success = code === 0 || code === 1;
          report({ operation: 'grep', path: opts?.path ?? '.', success });
          resolve({ matches: output, truncated, count: lineCount });
        });

        child.on('error', (err) => {
          report({ operation: 'grep', path: opts?.path ?? '.', success: false, error: err.message });
          resolve({ matches: `Error: ${err.message}`, truncated: false, count: 0 });
        });
      });
    },

    async glob(pattern: string, opts?: {
      path?: string;
      max_results?: number;
    }): Promise<{ files: string[]; truncated: boolean; count: number }> {
      const approval = await approve({ operation: 'glob', path: opts?.path ?? '.' });
      if (!approval.approved) {
        return { files: [], truncated: false, count: 0 };
      }

      const maxResults = opts?.max_results ?? 100;
      const basePath = opts?.path
        ? safeWorkspacePath(opts.path)
        : workspace;

      // Fall back to pure Node.js glob if rg is not installed
      if (!isRgAvailable()) {
        const result = nodeGlob(basePath, pattern, maxResults);
        report({ operation: 'glob', path: opts?.path ?? '.', success: true });
        return result;
      }

      const args: string[] = ['--files', '--glob', pattern, '--color', 'never', basePath];

      return new Promise<{ files: string[]; truncated: boolean; count: number }>((resolve) => {
        const child = spawn('rg', args, {
          cwd: workspace,
          stdio: ['pipe', 'pipe', 'pipe'],
        });

        const files: string[] = [];
        let buffer = '';
        let truncated = false;

        child.stdout.on('data', (chunk: Buffer) => {
          if (truncated) return;
          buffer += chunk.toString('utf-8');
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';
          for (const line of lines) {
            if (!line) continue;
            if (files.length >= maxResults) { truncated = true; return; }
            files.push(line.startsWith(workspace) ? line.slice(workspace.length + 1) : line);
          }
        });

        child.on('close', (code) => {
          if (buffer && !truncated && files.length < maxResults) {
            files.push(buffer.startsWith(workspace) ? buffer.slice(workspace.length + 1) : buffer);
          }
          const success = code === 0 || code === 1;
          report({ operation: 'glob', path: opts?.path ?? '.', success });
          resolve({ files, truncated, count: files.length });
        });

        child.on('error', (err) => {
          report({ operation: 'glob', path: opts?.path ?? '.', success: false, error: err.message });
          resolve({ files: [], truncated: false, count: 0 });
        });
      });
    },
  };
}
