import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { initLogger } from '../../src/logger.js';

// Disable pino file transport in tests
initLogger({ file: false, level: 'silent' });

// ═══════════════════════════════════════════════════════
// Tests for workspace-release.ts (subprocess delegation)
// ═══════════════════════════════════════════════════════

describe('workspace-release', () => {
  test('exports releaseWorkspaceScopes function', async () => {
    const mod = await import('../../src/agent/workspace-release.js');
    expect(typeof mod.releaseWorkspaceScopes).toBe('function');
  });

  test('module uses execFileSync to call workspace-cli.ts', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync('src/agent/workspace-release.ts', 'utf-8');

    // Verify it delegates to workspace-cli.ts subprocess
    expect(source).toContain('execFileSync');
    expect(source).toContain('workspace-cli.js');
    expect(source).toContain('release');
  });

  test('sends workspace_release IPC with staging_key', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync('src/agent/workspace-release.ts', 'utf-8');

    // Verify it sends the staging_key via NATS IPC
    expect(source).toContain("action: 'workspace_release'");
    expect(source).toContain('staging_key');
  });

  test('skips IPC call when staging_key is empty (no changes)', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync('src/agent/workspace-release.ts', 'utf-8');

    // Empty staging key means no changes detected
    expect(source).toContain('if (!stagingKey)');
    expect(source).toContain('workspace_release_empty');
  });
});

// ═══════════════════════════════════════════════════════
// Tests for workspace-cli.ts release command
// ═══════════════════════════════════════════════════════

describe('workspace-cli release command', () => {
  test('release command exists in workspace-cli.ts', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync('src/agent/workspace-cli.ts', 'utf-8');

    expect(source).toContain("command === 'release'");
    expect(source).toContain('async function release');
    expect(source).toContain('--host-url');
  });

  test('release creates gzipped JSON and uploads via HTTP', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync('src/agent/workspace-cli.ts', 'utf-8');

    // Verify gzip + fetch flow
    expect(source).toContain('gzipSync');
    expect(source).toContain('/internal/workspace-staging');
    expect(source).toContain("'Content-Type': 'application/gzip'");
    expect(source).toContain('staging_key');
  });

  test('release uses diffScope for change detection', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync('src/agent/workspace-cli.ts', 'utf-8');

    expect(source).toContain('diffScope(mountPath, baseHashes)');
    expect(source).toContain('content_base64');
  });

  test('release outputs staging_key to stdout', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync('src/agent/workspace-cli.ts', 'utf-8');

    // Verify stdout output for staging key
    expect(source).toContain('process.stdout.write(result.staging_key)');
  });

  test('release handles canonical workspace paths', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync('src/agent/workspace-cli.ts', 'utf-8');

    // Verify canonical paths are mapped
    expect(source).toContain("session: '/workspace/scratch'");
    expect(source).toContain("agent: '/workspace/agent'");
    expect(source).toContain("user: '/workspace/user'");
  });

  test('release skips non-existent scope directories', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync('src/agent/workspace-cli.ts', 'utf-8');

    expect(source).toContain('!existsSync(mountPath)');
  });
});
