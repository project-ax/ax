// src/agent/workspace-release.ts — Agent-side workspace file release for k8s pods.
//
// Delegates the heavy work (diff, gzip, HTTP upload) to workspace-cli.ts
// running as a subprocess. The agent runner only coordinates: it spawns the
// sidecar, reads back the staging_key, and sends a small NATS IPC reference.
//
// Flow:
//   1. workspace-cli.ts release → diffs scopes, gzips changes, uploads to host
//   2. workspace-cli.ts outputs staging_key to stdout
//   3. This module sends workspace_release IPC with the staging_key via NATS

import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import type { IIPCClient } from './runner.js';
import { getLogger } from '../logger.js';

const logger = getLogger().child({ component: 'workspace-release' });

/** Timeout for the workspace-cli.ts release subprocess (2 minutes). */
const RELEASE_TIMEOUT_MS = 120_000;

/**
 * Release workspace changes to the host via the workspace-cli.ts sidecar.
 *
 * Spawns `workspace-cli.ts release` as a subprocess which handles the
 * filesystem-heavy work: diffing workspace scopes, creating a gzipped JSON
 * payload, and uploading to the host's staging endpoint. Returns the staging
 * key from the upload, then sends a workspace_release IPC message via NATS
 * so the host can process the staged changes.
 */
export async function releaseWorkspaceScopes(
  hostUrl: string,
  client: IIPCClient,
  scopes?: string,
): Promise<void> {
  // Resolve the workspace-cli.js path — in production it's compiled to dist/
  const cliPath = join(__dirname, 'workspace-cli.js');

  const args = ['release', '--host-url', hostUrl];
  if (scopes) {
    args.push('--scopes', scopes);
  }

  logger.info('workspace_release_start', { hostUrl, cliPath });

  let stagingKey: string;
  try {
    // nosemgrep: javascript.lang.security.detect-child-process — workspace-cli.js is internal
    const stdout = execFileSync('node', [cliPath, ...args], {
      timeout: RELEASE_TIMEOUT_MS,
      maxBuffer: 1024, // staging_key is small
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    stagingKey = stdout.trim();
  } catch (err: unknown) {
    const error = err as { stderr?: string; message: string };
    const stderr = error.stderr ?? '';
    // Log sidecar stderr for diagnostics
    if (stderr) {
      for (const line of stderr.split('\n').filter(l => l.trim())) {
        logger.debug('workspace_cli_stderr', { line });
      }
    }
    throw new Error(`workspace-cli release failed: ${error.message}`);
  }

  if (!stagingKey) {
    logger.debug('workspace_release_empty');
    return;
  }

  logger.info('workspace_release_staged', { stagingKey });

  // Notify host via NATS IPC with just the staging key
  await client.call({ action: 'workspace_release', staging_key: stagingKey });

  logger.info('workspace_release_complete', { stagingKey });
}
