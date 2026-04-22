/**
 * IPC handlers: sandbox tool operations (sandbox_bash, sandbox_read_file,
 * sandbox_write_file, sandbox_edit_file) and audit gate (sandbox_approve,
 * sandbox_result).
 *
 * In container mode (docker/apple/k8s), the
 * agent executes tools locally inside the container and uses the audit gate
 * for pre-execution approval and post-execution reporting.
 *
 * Every file operation uses safePath() for path containment (SC-SEC-004).
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { dirname, join, relative } from 'node:path';
import { randomUUID } from 'node:crypto';
import { minimatch } from 'minimatch';
import { stringify as stringifyYaml } from 'yaml';
import type { ProviderRegistry } from '../../types.js';
import type { IPCContext } from '../ipc-server.js';
import { safePath } from '../../utils/safe-path.js';
import { getLogger } from '../../logger.js';
import { parseSkillFile } from '../../skills/parser.js';
import {
  frontmattersEqual,
  changedFrontmatterFields,
  isInteractiveSession,
} from '../../skills/frontmatter-diff.js';
import type { GcsFileStorage } from '../gcs-file-storage.js';
import type { FileStore } from '../../file-store.js';

/** `.ax/skills/<name>/SKILL.md` — the only path shape where we run the
 *  frontmatter schema on write. Matches `validate-commit.ts` so both layers
 *  agree on which files are "skill definitions". */
const SKILL_MD_RE = /^\.ax\/skills\/[^/]+\/SKILL\.md$/;

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

/** Pure Node.js grep fallback — regex match on files. */
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

/** Pure Node.js glob fallback — pattern match on file names. */
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

const logger = getLogger().child({ component: 'sandbox-tools' });

/** Extension to MIME type mapping for file uploads. */
const EXT_TO_MIME: Record<string, string> = {
  pdf: 'application/pdf', txt: 'text/plain', csv: 'text/csv', md: 'text/markdown',
  json: 'application/json', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  html: 'text/html', htm: 'text/html', css: 'text/css', js: 'application/javascript',
  ts: 'text/typescript', svg: 'image/svg+xml', xml: 'application/xml', yaml: 'text/yaml', yml: 'text/yaml',
};

/** Upload an artifact to GCS and register it in the file store. Returns fileId if uploaded, undefined otherwise. */
async function uploadArtifactIfNeeded(
  path: string,
  content: string,
  opts: SandboxToolHandlerOptions,
  ctx: IPCContext,
): Promise<string | undefined> {
  const isArtifact = path.split(/[/\\]/).filter(Boolean)[0] === 'artifacts';
  if (!isArtifact || !opts.gcsFileStorage) return undefined;

  const ext = path.split('.').pop() ?? '';
  const fileId = `files/${randomUUID()}.${ext}`;
  const buf = Buffer.from(content, 'utf-8');
  const mimeType = EXT_TO_MIME[ext] ?? 'application/octet-stream';
  const originalFilename = path.split('/').pop() ?? path;

  await opts.gcsFileStorage.upload(fileId, buf, mimeType, originalFilename);
  await opts.fileStore?.register(fileId, ctx.agentId, ctx.userId ?? 'unknown', mimeType, originalFilename);
  opts.onArtifactWritten?.(fileId, mimeType, originalFilename);

  return fileId;
}

export interface SandboxToolHandlerOptions {
  /**
   * Maps sessionId to the workspace directory for that session.
   * Populated by processCompletion() before the agent is spawned,
   * cleaned up after the agent finishes.
   */
  workspaceMap: Map<string, string>;
  /** GCS storage for uploading written files as downloadable artifacts. */
  gcsFileStorage?: GcsFileStorage;
  /** File store for registering file metadata. */
  fileStore?: FileStore;
  /** Agent ID for file store registration. */
  agentId?: string;
  /** Callback invoked when a file is written and uploaded to GCS. */
  onArtifactWritten?: (fileId: string, mimeType: string, filename: string) => void;
}

function resolveWorkspace(opts: SandboxToolHandlerOptions, ctx: IPCContext): string {
  const workspace = opts.workspaceMap.get(ctx.sessionId);
  if (!workspace) {
    throw new Error(`No workspace registered for session "${ctx.sessionId}"`);
  }
  return workspace;
}

/**
 * Resolve a relative path within the workspace using safePath().
 * The path is split on forward/backslashes and each segment is passed
 * individually to safePath() for traversal protection.
 */
function safeWorkspacePath(workspace: string, relativePath: string): string {
  const segments = relativePath.split(/[/\\]/).filter(Boolean);
  return safePath(workspace, ...segments);
}

export function createSandboxToolHandlers(providers: ProviderRegistry, opts: SandboxToolHandlerOptions) {
  return {
    sandbox_bash: async (req: any, ctx: IPCContext) => {
      const workspace = resolveWorkspace(opts, ctx);
      const TIMEOUT_MS = 120_000;
      const MAX_BUFFER = 1024 * 1024;

      return new Promise<{ output: string }>((resolve) => {
        // nosemgrep: javascript.lang.security.detect-child-process — intentional: sandbox tool
        const child = spawn('bash', ['-c', req.command], {
          cwd: workspace,
          stdio: ['pipe', 'pipe', 'pipe'],
          detached: true,
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

        const killGroup = (signal: NodeJS.Signals) => {
          try { process.kill(-child.pid!, signal); } catch { /* already dead */ }
        };

        const timer = setTimeout(() => {
          killed = true;
          killGroup('SIGTERM');
          setTimeout(() => killGroup('SIGKILL'), 5_000);
        }, TIMEOUT_MS);

        child.on('close', async (code) => {
          clearTimeout(timer);
          const exitCode = code ?? (killed ? 124 : 1);
          const output = exitCode === 0
            ? stdout
            : [stdout, stderr].filter(Boolean).join('\n') || (killed ? 'Command timed out' : 'Command failed');

          await providers.audit.log({
            action: 'sandbox_bash',
            sessionId: ctx.sessionId,
            args: { command: req.command.slice(0, 200) },
            result: exitCode === 0 ? 'success' : 'error',
          });
          resolve(exitCode === 0 ? { output } : { output: `Exit code ${exitCode}\n${output}` });
        });

        child.on('error', async (err) => {
          clearTimeout(timer);
          await providers.audit.log({
            action: 'sandbox_bash',
            sessionId: ctx.sessionId,
            args: { command: req.command.slice(0, 200) },
            result: 'error',
          });
          resolve({ output: `Exit code 1\nCommand error: ${err.message}` });
        });
      });
    },

    sandbox_read_file: async (req: any, ctx: IPCContext) => {
      const workspace = resolveWorkspace(opts, ctx);
      try {
        const abs = safeWorkspacePath(workspace, req.path);
        const content = readFileSync(abs, 'utf-8');
        await providers.audit.log({
          action: 'sandbox_read_file',
          sessionId: ctx.sessionId,
          args: { path: req.path },
          result: 'success',
        });
        return { content };
      } catch (err: unknown) {
        await providers.audit.log({
          action: 'sandbox_read_file',
          sessionId: ctx.sessionId,
          args: { path: req.path },
          result: 'error',
        });
        return { error: `Error reading file: ${(err as Error).message}` };
      }
    },

    sandbox_write_file: async (req: any, ctx: IPCContext) => {
      const workspace = resolveWorkspace(opts, ctx);
      try {
        // Route SKILL.md authoring through the dedicated `skill_write`
        // tool so the schema-aware validator fires on every attempt —
        // including bash-heredoc writes that would otherwise slip past
        // inline checks. One path, one validator, one actionable error.
        if (SKILL_MD_RE.test(req.path)) {
          await providers.audit.log({
            action: 'sandbox_write_file',
            sessionId: ctx.sessionId,
            args: { path: req.path, redirected: 'skill_write' },
            result: 'blocked',
          });
          return {
            error:
              `Refusing to write SKILL.md via write_file. Use the \`skill_write\` tool — ` +
              `it takes structured frontmatter fields (name, description, credentials, ` +
              `mcpServers, domains, body) and runs the host's Zod validator with ` +
              `actionable errors. write_file / edit_file / bash can still read, ` +
              `delete, or modify any other file under .ax/skills/.`,
          };
        }

        const abs = safeWorkspacePath(workspace, req.path);
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, req.content, 'utf-8');
        await providers.audit.log({
          action: 'sandbox_write_file',
          sessionId: ctx.sessionId,
          args: { path: req.path, bytes: req.content.length },
          result: 'success',
        });

        // Upload to GCS when writing to artifacts/ so the file is downloadable from the chat UI
        const fileId = await uploadArtifactIfNeeded(req.path, req.content, opts, ctx);

        return { written: true, path: req.path, ...(fileId ? { fileId } : {}) };
      } catch (err: unknown) {
        await providers.audit.log({
          action: 'sandbox_write_file',
          sessionId: ctx.sessionId,
          args: { path: req.path },
          result: 'error',
        });
        return { error: `Error writing file: ${(err as Error).message}` };
      }
    },

    sandbox_edit_file: async (req: any, ctx: IPCContext) => {
      const workspace = resolveWorkspace(opts, ctx);
      try {
        // Route SKILL.md updates through `skill_write` for the same reason
        // write_file does — structured args + single validator. The agent
        // can still `read_file` the SKILL.md first, derive its new values,
        // and call `skill_write` with the full updated spec.
        if (SKILL_MD_RE.test(req.path)) {
          await providers.audit.log({
            action: 'sandbox_edit_file',
            sessionId: ctx.sessionId,
            args: { path: req.path, redirected: 'skill_write' },
            result: 'blocked',
          });
          return {
            error:
              `Refusing to edit SKILL.md via edit_file. Use the \`skill_write\` tool ` +
              `to replace the file with a structured spec — partial string-replace on ` +
              `YAML frontmatter is a ridge of foot-guns. Read the current SKILL.md ` +
              `with \`read_file\` if you need the old values.`,
          };
        }

        const abs = safeWorkspacePath(workspace, req.path);
        const content = readFileSync(abs, 'utf-8');
        if (!content.includes(req.old_string)) {
          return { error: 'old_string not found in file' };
        }
        const updated = content.replace(req.old_string, req.new_string);

        writeFileSync(abs, updated, 'utf-8');
        await providers.audit.log({
          action: 'sandbox_edit_file',
          sessionId: ctx.sessionId,
          args: { path: req.path },
          result: 'success',
        });
        return { edited: true, path: req.path };
      } catch (err: unknown) {
        await providers.audit.log({
          action: 'sandbox_edit_file',
          sessionId: ctx.sessionId,
          args: { path: req.path },
          result: 'error',
        });
        return { error: `Error editing file: ${(err as Error).message}` };
      }
    },

    /**
     * `skill_write` — the single authoring path for `.ax/skills/<name>/SKILL.md`.
     *
     * Takes structured args matching `SkillFrontmatterSchema` + a markdown body,
     * serializes to YAML, re-parses through the host Zod validator (so the
     * written bytes are proven to round-trip), and writes to the workspace.
     * On failure returns the Zod error text — now including the received
     * value for each mismatched field so the agent can diff its own output
     * against the rule.
     *
     * The sandbox_write_file and sandbox_edit_file handlers both refuse
     * SKILL.md paths and point the agent here. All other file operations
     * under `.ax/skills/<name>/` (scripts/, reference docs, deletes) still
     * go through the normal file tools.
     */
    skill_write: async (req: any, ctx: IPCContext) => {
      const workspace = resolveWorkspace(opts, ctx);
      const name: string | undefined = typeof req.name === 'string' ? req.name : undefined;
      if (!name) {
        return { error: 'skill_write requires a string `name` matching .ax/skills/<name>/' };
      }

      // Build the SKILL.md bytes from structured args. Keep the YAML block
      // minimal — omit fields the caller didn't supply so the round-trip
      // parse matches what the catalog reconciler will see. Default values
      // live in the Zod schema, not here, so we don't accidentally diverge.
      // Canonical key order: name → description → source → credentials →
      // mcpServers → openapi → domains. Matches serializeFrontmatter in
      // server-admin-skills-helpers.ts so agent-authored and admin-rewritten
      // files produce identical YAML.
      const frontmatter: Record<string, unknown> = { name };
      if (typeof req.description === 'string') frontmatter.description = req.description;
      if (req.source !== undefined) frontmatter.source = req.source;
      if (Array.isArray(req.credentials) && req.credentials.length > 0) {
        frontmatter.credentials = req.credentials;
      }
      if (Array.isArray(req.mcpServers) && req.mcpServers.length > 0) {
        frontmatter.mcpServers = req.mcpServers;
      }
      if (Array.isArray(req.openapi) && req.openapi.length > 0) {
        frontmatter.openapi = req.openapi;
      }
      if (Array.isArray(req.domains) && req.domains.length > 0) {
        frontmatter.domains = req.domains;
      }

      const body: string = typeof req.body === 'string' ? req.body : '';
      const yamlBlock = stringifyYaml(frontmatter, { lineWidth: 0 });
      const content = `---\n${yamlBlock}---\n\n${body}`;

      // Validate by round-tripping through the same parser used at commit
      // time. This is the authoritative check — if it passes here, the
      // sidecar and the admin reconciler will both accept the file.
      const parsed = parseSkillFile(content);
      if (!parsed.ok) {
        await providers.audit.log({
          action: 'skill_write',
          sessionId: ctx.sessionId,
          args: { name, error: parsed.error },
          result: 'error',
        });
        return {
          error:
            `SKILL.md validation failed for \`${name}\`:\n  ${parsed.error}\n\n` +
            `The file was NOT written. Reread the error, correct the ` +
            `offending field(s) in your next skill_write call, and retry. ` +
            `Common mistakes: authType must be exactly \`api_key\` or \`oauth\` ` +
            `(snake_case), description must be a non-empty string, ` +
            `mcpServers[].credential is a bare envName string (not a nested object).`,
        };
      }
      if (parsed.frontmatter.name !== name) {
        return {
          error:
            `Refusing to write: frontmatter.name "${parsed.frontmatter.name}" does not ` +
            `match the \`name\` arg "${name}". These must be identical — the host ` +
            `uses \`name\` as the directory segment.`,
        };
      }

      let abs: string;
      try {
        abs = safeWorkspacePath(workspace, `.ax/skills/${name}/SKILL.md`);
      } catch (err: unknown) {
        return { error: `Invalid skill name: ${(err as Error).message}` };
      }

      // Non-interactive turn guard. Heartbeat / cron / channel sessions
      // may call skill_write to "fix" a pending skill — commonly flipping
      // an envName or credential ref and silently breaking admin-approved
      // state. Policy: non-chat sessions CAN create a new skill or update
      // the markdown body, but CAN'T mutate the frontmatter of an
      // existing skill. User-initiated chat (`http:` sessions) is
      // unchanged. Body-only edits pass through because frontmattersEqual
      // ignores the body.
      if (!isInteractiveSession(ctx.sessionId)) {
        try {
          const existing = readFileSync(abs, 'utf-8');
          const existingParsed = parseSkillFile(existing);
          if (existingParsed.ok && !frontmattersEqual(existingParsed.frontmatter, parsed.frontmatter)) {
            const changed = changedFrontmatterFields(existingParsed.frontmatter, parsed.frontmatter);
            await providers.audit.log({
              action: 'skill_write',
              sessionId: ctx.sessionId,
              args: { name, blocked: 'non_interactive_frontmatter_mutation', changed },
              result: 'blocked',
            });
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
          // ENOENT on existing file = this is a creation (not a mutation),
          // which IS allowed. Any other read error (permission, disk)
          // surfaces as a write error below — not silenced, because the
          // next writeFileSync would hit the same underlying cause.
          const e = err as NodeJS.ErrnoException;
          if (e.code !== 'ENOENT') throw err;
        }
      }

      try {
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, content, 'utf-8');
        await providers.audit.log({
          action: 'skill_write',
          sessionId: ctx.sessionId,
          args: { name, bytes: content.length },
          result: 'success',
        });
        return { written: true, path: `.ax/skills/${name}/SKILL.md`, bytes: content.length };
      } catch (err: unknown) {
        await providers.audit.log({
          action: 'skill_write',
          sessionId: ctx.sessionId,
          args: { name },
          result: 'error',
        });
        return { error: `Error writing SKILL.md: ${(err as Error).message}` };
      }
    },

    sandbox_grep: async (req: any, ctx: IPCContext) => {
      const workspace = resolveWorkspace(opts, ctx);
      const maxResults = req.max_results ?? 100;
      const includeLineNumbers = req.include_line_numbers !== false;
      const contextLines = req.context_lines ?? 0;

      // Resolve search path within workspace
      const searchPath = req.path
        ? safeWorkspacePath(workspace, req.path)
        : workspace;

      // Fall back to pure Node.js grep if rg is not installed
      if (!isRgAvailable()) {
        const result = nodeGrep(searchPath, req.pattern, {
          maxResults,
          lineNumbers: includeLineNumbers,
          glob: req.glob,
        });
        await providers.audit.log({
          action: 'sandbox_grep',
          sessionId: ctx.sessionId,
          args: { pattern: req.pattern.slice(0, 200), path: req.path },
          result: 'success',
        });
        return result;
      }

      // Build rg command
      const args: string[] = ['--no-heading', '--color', 'never'];
      if (includeLineNumbers) args.push('-n');
      if (contextLines > 0) args.push('-C', String(contextLines));
      if (req.glob) args.push('--glob', req.glob);
      args.push('--', req.pattern);
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
            if (lineCount >= maxResults) {
              truncated = true;
              return;
            }
            if (line || lineCount > 0) {
              output += (output ? '\n' : '') + line;
              if (line) lineCount++;
            }
          }
        });

        child.on('close', async (code) => {
          await providers.audit.log({
            action: 'sandbox_grep',
            sessionId: ctx.sessionId,
            args: { pattern: req.pattern.slice(0, 200), path: req.path },
            result: code === 0 || code === 1 ? 'success' : 'error',
          });
          // rg exits 1 for "no matches" — that's not an error
          resolve({ matches: output, truncated, count: lineCount });
        });

        child.on('error', async (err) => {
          await providers.audit.log({
            action: 'sandbox_grep',
            sessionId: ctx.sessionId,
            args: { pattern: req.pattern.slice(0, 200) },
            result: 'error',
          });
          resolve({ matches: `Error: ${err.message}`, truncated: false, count: 0 });
        });
      });
    },

    sandbox_glob: async (req: any, ctx: IPCContext) => {
      const workspace = resolveWorkspace(opts, ctx);
      const maxResults = req.max_results ?? 100;

      // Resolve base path within workspace
      const basePath = req.path
        ? safeWorkspacePath(workspace, req.path)
        : workspace;

      // Log the exact paths being searched (visible in stderr)
      logger.info('sandbox_glob_paths', {
        sessionId: ctx.sessionId,
        workspace,
        basePath,
        pattern: req.pattern,
      });

      // Fall back to pure Node.js glob if rg is not installed
      if (!isRgAvailable()) {
        const result = nodeGlob(basePath, req.pattern, maxResults);
        logger.debug('sandbox_glob_nodeglob', {
          pattern: req.pattern,
          path: req.path,
          basePath,
          workspace,
          resultCount: result.count,
          truncated: result.truncated,
        });
        await providers.audit.log({
          action: 'sandbox_glob',
          sessionId: ctx.sessionId,
          args: { pattern: req.pattern, path: req.path },
          result: 'success',
        });
        return result;
      }

      // Use rg --files with glob pattern for fast file listing
      const args: string[] = ['--files', '--glob', req.pattern, '--color', 'never'];
      args.push(basePath);

      logger.debug('sandbox_glob_rg_start', {
        pattern: req.pattern,
        path: req.path,
        basePath,
        workspace,
        rgCommand: `rg ${args.join(' ')}`,
      });

      return new Promise<{ files: string[]; truncated: boolean; count: number }>((resolve) => {
        const child = spawn('rg', args, {
          cwd: workspace,
          stdio: ['pipe', 'pipe', 'pipe'],
        });

        const files: string[] = [];
        let buffer = '';
        let truncated = false;
        let stderrOutput = '';

        child.stdout.on('data', (chunk: Buffer) => {
          if (truncated) return;
          buffer += chunk.toString('utf-8');
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';
          for (const line of lines) {
            if (!line) continue;
            if (files.length >= maxResults) {
              truncated = true;
              return;
            }
            // Return relative paths from workspace root
            files.push(line.startsWith(workspace) ? line.slice(workspace.length + 1) : line);
          }
        });

        child.stderr.on('data', (chunk: Buffer) => {
          stderrOutput += chunk.toString('utf-8');
        });

        child.on('close', async (code) => {
          // Process any remaining buffer content
          if (buffer && !truncated && files.length < maxResults) {
            files.push(buffer.startsWith(workspace) ? buffer.slice(workspace.length + 1) : buffer);
          }
          logger.debug('sandbox_glob_rg_done', {
            pattern: req.pattern,
            path: req.path,
            rgExitCode: code,
            resultCount: files.length,
            truncated,
            stderrLength: stderrOutput.length,
            stderrPreview: stderrOutput.substring(0, 200),
          });
          await providers.audit.log({
            action: 'sandbox_glob',
            sessionId: ctx.sessionId,
            args: { pattern: req.pattern, path: req.path },
            result: code === 0 || code === 1 ? 'success' : 'error',
          });
          resolve({ files, truncated, count: files.length });
        });

        child.on('error', async (err) => {
          logger.error('sandbox_glob_rg_error', {
            pattern: req.pattern,
            path: req.path,
            error: (err as Error).message,
          });
          await providers.audit.log({
            action: 'sandbox_glob',
            sessionId: ctx.sessionId,
            args: { pattern: req.pattern },
            result: 'error',
          });
          resolve({ files: [], truncated: false, count: 0 });
        });
      });
    },

    // ── Sandbox Audit Gate (container-local execution) ──────────

    sandbox_approve: async (req: any, ctx: IPCContext) => {
      await providers.audit.log({
        action: `sandbox_${req.operation}`,
        sessionId: ctx.sessionId,
        args: {
          ...(req.command ? { command: req.command.slice(0, 200) } : {}),
          ...(req.path ? { path: req.path } : {}),
          mode: 'container-local',
        },
        result: 'success',
      });
      logger.debug('sandbox_approve', {
        sessionId: ctx.sessionId,
        operation: req.operation,
        ...(req.command ? { command: req.command.slice(0, 100) } : {}),
        ...(req.path ? { path: req.path } : {}),
      });

      // Upload to GCS in container mode when writing to artifacts/
      let fileId: string | undefined;
      if (req.operation === 'write' && req.content && req.path) {
        fileId = await uploadArtifactIfNeeded(req.path, req.content, opts, ctx);
      }

      return { approved: true, ...(fileId ? { fileId } : {}) };
    },

    sandbox_result: async (req: any, ctx: IPCContext) => {
      await providers.audit.log({
        action: `sandbox_${req.operation}_result`,
        sessionId: ctx.sessionId,
        args: {
          ...(req.command ? { command: req.command.slice(0, 200) } : {}),
          ...(req.path ? { path: req.path } : {}),
          ...(req.exitCode !== undefined ? { exitCode: req.exitCode } : {}),
          ...(req.success !== undefined ? { success: req.success } : {}),
          mode: 'container-local',
        },
        result: (req.exitCode === 0 || req.success) ? 'success' : 'error',
      });
      return { ok: true };
    },

  };
}
