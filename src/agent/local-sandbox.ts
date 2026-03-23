/**
 * Agent-side local sandbox execution — runs tools inside the agent's own
 * container with host audit gate.
 *
 * Protocol per tool call:
 * 1. sandbox_approve → host audits, returns {approved: true/false}
 * 2. Execute locally (only if approved)
 * 3. sandbox_result → host logs outcome (best-effort)
 */
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { IIPCClient } from './runner.js';
import { safePath } from '../utils/safe-path.js';

export interface LocalSandboxOptions {
  client: IIPCClient;
  workspace: string;
  timeoutMs?: number;
}

export function createLocalSandbox(opts: LocalSandboxOptions) {
  const { client, workspace, timeoutMs = 120_000 } = opts;

  function safeWorkspacePath(relativePath: string): string {
    const segments = relativePath.split(/[/\\]/).filter(Boolean);
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
        const child = spawn('sh', ['-c', command], {
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
          const output = [stdout, stderr].filter(Boolean).join('\n') || (killed ? 'Command timed out' : 'Command failed');
          const exitCode = code ?? (killed ? 124 : 1);
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
  };
}
