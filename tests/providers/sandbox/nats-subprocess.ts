/**
 * nats-subprocess sandbox provider — local k8s debugging.
 *
 * Spawns local child processes with NATS environment, exercising the
 * full k8s code path (NATS/HTTP IPC, workspace release via HTTP staging,
 * work delivery) without needing a real k8s cluster.
 *
 * Usage: See tests/providers/sandbox/run-nats-local.ts (NATS IPC)
 *        See tests/providers/sandbox/run-http-local.ts (HTTP IPC)
 */

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { SandboxProvider, SandboxConfig, SandboxProcess } from '../../../src/providers/sandbox/types.js';
import type { Config } from '../../../src/types.js';
import { exitCodePromise, enforceTimeout, killProcess } from '../../../src/providers/sandbox/utils.js';
import { createCanonicalSymlinks, symlinkEnv } from '../../../src/providers/sandbox/canonical-paths.js';

const DEFAULT_NATS_URL = 'nats://localhost:4222';

export interface NATSSubprocessOptions {
  /** Unused — kept for API compat. HTTP IPC is always used (auto-detected from AX_HOST_URL). */
  ipcTransport?: 'http';
}

export async function create(config: Config, opts?: NATSSubprocessOptions): Promise<SandboxProvider> {
  const natsUrl = process.env.NATS_URL ?? DEFAULT_NATS_URL;
  const hostUrl = process.env.AX_HOST_URL ?? `http://localhost:${process.env.PORT ?? '8080'}`;
  const debugAgent = process.env.AX_DEBUG_AGENT === '1';
  console.log(`[nats-subprocess] NATS: ${natsUrl}, Host: ${hostUrl}, Debug: ${debugAgent}`);

  return {
    workspaceLocation: 'sandbox' as const,
    async spawn(sandboxConfig: SandboxConfig): Promise<SandboxProcess> {
      const podName = `local-nats-${randomUUID().slice(0, 8)}`;

      // Use symlink fallback (same as subprocess provider — can't remap filesystems)
      const { mountRoot, cleanup } = createCanonicalSymlinks(sandboxConfig);
      const sEnv = symlinkEnv(sandboxConfig, mountRoot);

      // Build command — optionally inject --inspect for debugger
      const [cmd, ...args] = sandboxConfig.command;
      const finalArgs = debugAgent ? ['--inspect-brk', ...args] : args;

      // Filter out AX_IPC_SOCKET from symlink env — k8s uses HTTP IPC
      const { AX_IPC_SOCKET: _, ...filteredEnv } = sEnv;

      // nosemgrep: javascript.lang.security.detect-child-process — sandbox provider: spawning is its purpose
      const child = spawn(cmd, finalArgs, {
        cwd: mountRoot,
        env: {
          ...process.env,
          ...filteredEnv,
          NATS_URL: natsUrl,
          POD_NAME: podName,
          // Host URL for workspace staging uploads
          AX_HOST_URL: hostUrl,
          // Don't suppress logs — we want to see them for debugging
          LOG_LEVEL: process.env.LOG_LEVEL ?? 'debug',
          // Per-turn extra env vars (IPC token, request ID, etc.)
          ...sandboxConfig.extraEnv,
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      // Pipe child output to parent for visibility
      child.stdout?.pipe(process.stdout);
      child.stderr?.pipe(process.stderr);

      const exitCode = exitCodePromise(child);
      enforceTimeout(child, sandboxConfig.timeoutSec);

      // Clean up symlinks when the process exits
      exitCode.then(() => cleanup(), () => cleanup());

      console.log(`[nats-subprocess] Spawned pid=${child.pid} podName=${podName}`);

      return {
        pid: child.pid!,
        exitCode,
        stdout: child.stdout!,
        stderr: child.stderr!,
        stdin: child.stdin!,
        kill() { child.kill(); },
        // podName triggers the host's NATS code path
        podName,
      };
    },

    kill: killProcess,

    async isAvailable(): Promise<boolean> {
      return true;
    },
  };
}
