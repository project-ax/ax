// src/agent/workspace-release.ts — Agent-side workspace file release for k8s pods.
//
// Delegates the heavy work (diff, gzip, HTTP upload) to workspace-cli.ts
// running as a subprocess. workspace-cli.ts posts directly to
// /internal/workspace/release with auth token — single HTTP round-trip.

import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getLogger } from '../logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const logger = getLogger().child({ component: 'workspace-release' });

/** Timeout for the workspace-cli.ts release subprocess (2 minutes). */
const RELEASE_TIMEOUT_MS = 120_000;

/**
 * Release workspace changes to the host via the workspace-cli.ts sidecar.
 */
export async function releaseWorkspaceScopes(
  hostUrl: string,
  scopes?: string,
): Promise<void> {
  // Resolve the workspace-cli.js path — in production it's compiled to dist/
  const cliPath = join(__dirname, 'workspace-cli.js');

  const args = ['release', '--host-url', hostUrl];
  if (scopes) {
    args.push('--scopes', scopes);
  }

  // Pass the per-turn token so workspace-cli posts directly
  // to /internal/workspace/release — single HTTP round-trip.
  const token = process.env.AX_IPC_TOKEN;
  if (token) {
    args.push('--token', token);
  }

  logger.info('workspace_release_start', { hostUrl, cliPath });

  let result: string;
  try {
    // nosemgrep: javascript.lang.security.detect-child-process — workspace-cli.js is internal
    const stdout = execFileSync('node', [cliPath, ...args], {
      timeout: RELEASE_TIMEOUT_MS,
      maxBuffer: 1024,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    result = stdout.trim();
  } catch (err: unknown) {
    const error = err as { stderr?: string; message: string };
    const stderr = error.stderr ?? '';
    if (stderr) {
      for (const line of stderr.split('\n').filter(l => l.trim())) {
        logger.debug('workspace_cli_stderr', { line });
      }
    }
    throw new Error(`workspace-cli release failed: ${error.message}`);
  }

  if (!result) {
    logger.debug('workspace_release_empty');
    return;
  }

  logger.info('workspace_release_complete', { mode: 'direct' });
}
