import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { create } from '../../../src/providers/workspace/local.js';
import type { WorkspaceProvider } from '../../../src/providers/workspace/types.js';
import type { Config } from '../../../src/types.js';

// ═══════════════════════════════════════════════════════
// Test Helpers
// ═══════════════════════════════════════════════════════

let testDir: string;
let provider: WorkspaceProvider;

function makeConfig(overrides?: Record<string, unknown>): Config {
  return {
    workspace: {
      basePath: testDir,
      ...overrides,
    },
    agent_name: 'test-agent',
  } as unknown as Config;
}

// ═══════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════

describe('workspace/local provider', () => {
  beforeEach(async () => {
    testDir = join(tmpdir(), `ax-workspace-local-${randomUUID()}`);
    mkdirSync(testDir, { recursive: true });
    provider = await create(makeConfig());
  });

  afterEach(() => {
    try { rmSync(testDir, { recursive: true }); } catch { /* cleanup best-effort */ }
  });

  // ── Mount ──

  describe('mount', () => {
    test('creates directory structure at basePath/scope/id/', async () => {
      const result = await provider.mount('session-1', ['agent']);
      const agentPath = result.paths.agent;

      expect(agentPath).toBeTruthy();
      expect(existsSync(agentPath!)).toBe(true);
      // Path should contain the scope and agent name
      expect(agentPath!).toContain('agent');
      expect(agentPath!).toContain('test-agent');
    });

    test('returns correct paths for all scopes', async () => {
      const result = await provider.mount('session-1', ['agent', 'user', 'session']);

      expect(result.paths.agent).toBeTruthy();
      expect(result.paths.session).toBeTruthy();
      // All paths should exist
      expect(existsSync(result.paths.agent!)).toBe(true);
      expect(existsSync(result.paths.session!)).toBe(true);
    });

    test('idempotent — mounting same scope twice works', async () => {
      const r1 = await provider.mount('session-1', ['agent']);
      const r2 = await provider.mount('session-1', ['agent']);

      // Second mount returns empty paths (already mounted, skipped by orchestrator)
      // But the scope should still be tracked
      const mounts = provider.activeMounts('session-1');
      expect(mounts).toContain('agent');
    });

    test('uses safePath — path traversal segments are sanitized', async () => {
      // The provider should sanitize dangerous path segments
      // through safePath when constructing directories.
      // This test verifies the provider doesn't crash with unusual
      // but safe agent names (safePath sanitizes them).
      const unsafeConfig = makeConfig();
      (unsafeConfig as unknown as Record<string, unknown>).agent_name = '../../../etc';
      const unsafeProvider = await create(unsafeConfig);

      const result = await unsafeProvider.mount('session-1', ['agent']);
      const agentPath = result.paths.agent;

      // safePath should have sanitized the traversal attempt
      expect(agentPath).toBeTruthy();
      expect(agentPath!).not.toContain('..');
      // The created path should still be within testDir
      expect(agentPath!.startsWith(testDir)).toBe(true);
    });

    test('session scope uses sessionId as directory name', async () => {
      const result = await provider.mount('my-session-123', ['session']);
      const sessionPath = result.paths.session;
      expect(sessionPath).toBeTruthy();
      expect(sessionPath!).toContain('my-session-123');
    });
  });

  // ── Diff ──

  describe('diff (via commit)', () => {
    test('detects added files', async () => {
      const result = await provider.mount('s1', ['agent']);
      const agentPath = result.paths.agent!;

      // Write a new file into the mounted directory
      writeFileSync(join(agentPath, 'new-file.txt'), 'hello world');

      const commitResult = await provider.commit('s1');
      const scope = commitResult.scopes.agent!;

      expect(scope.status).toBe('committed');
      expect(scope.filesChanged).toBe(1);
    });

    test('detects modified files', async () => {
      const result = await provider.mount('s1', ['agent']);
      const agentPath = result.paths.agent!;

      // Create an initial file, then re-mount to snapshot it
      writeFileSync(join(agentPath, 'existing.txt'), 'original content');

      // We need a fresh provider to snapshot the initial state
      const provider2 = await create(makeConfig());
      await provider2.mount('s1', ['agent']);

      // Now modify the file
      writeFileSync(join(agentPath, 'existing.txt'), 'modified content');

      const commitResult = await provider2.commit('s1');
      const scope = commitResult.scopes.agent!;

      expect(scope.status).toBe('committed');
      expect(scope.filesChanged).toBe(1);
    });

    test('detects deleted files', async () => {
      const result = await provider.mount('s1', ['agent']);
      const agentPath = result.paths.agent!;

      // Create a file, re-mount to snapshot it, then delete
      writeFileSync(join(agentPath, 'to-delete.txt'), 'will be deleted');

      const provider2 = await create(makeConfig());
      await provider2.mount('s1', ['agent']);

      unlinkSync(join(agentPath, 'to-delete.txt'));

      const commitResult = await provider2.commit('s1');
      const scope = commitResult.scopes.agent!;

      expect(scope.status).toBe('committed');
      expect(scope.filesChanged).toBe(1);
    });

    test('returns empty when no changes', async () => {
      await provider.mount('s1', ['agent']);

      // No files written — nothing changed
      const commitResult = await provider.commit('s1');
      const scope = commitResult.scopes.agent!;

      expect(scope.status).toBe('empty');
      expect(scope.filesChanged).toBe(0);
    });

    test('detects multiple change types in one commit', async () => {
      const result = await provider.mount('s1', ['agent']);
      const agentPath = result.paths.agent!;

      // Set up initial state
      writeFileSync(join(agentPath, 'keep.txt'), 'will modify');
      writeFileSync(join(agentPath, 'remove.txt'), 'will delete');

      // Re-mount to capture snapshot
      const provider2 = await create(makeConfig());
      await provider2.mount('s1', ['agent']);

      // Make changes: modify, delete, add
      writeFileSync(join(agentPath, 'keep.txt'), 'modified');
      unlinkSync(join(agentPath, 'remove.txt'));
      writeFileSync(join(agentPath, 'brand-new.txt'), 'added');

      const commitResult = await provider2.commit('s1');
      const scope = commitResult.scopes.agent!;

      expect(scope.status).toBe('committed');
      expect(scope.filesChanged).toBe(3); // 1 modified + 1 deleted + 1 added
    });
  });

  // ── Commit persistence ──

  describe('commit persistence', () => {
    test('persists approved changes to disk', async () => {
      const result = await provider.mount('s1', ['agent']);
      const agentPath = result.paths.agent!;

      writeFileSync(join(agentPath, 'persisted.txt'), 'this persists');
      await provider.commit('s1');

      // Verify the file still exists on disk
      expect(existsSync(join(agentPath, 'persisted.txt'))).toBe(true);
      expect(readFileSync(join(agentPath, 'persisted.txt'), 'utf-8')).toBe('this persists');
    });

    test('re-snapshots after commit — subsequent diff shows no changes', async () => {
      const result = await provider.mount('s1', ['agent']);
      const agentPath = result.paths.agent!;

      writeFileSync(join(agentPath, 'file.txt'), 'content');
      const first = await provider.commit('s1');
      expect(first.scopes.agent!.status).toBe('committed');

      // Second commit with no new changes should be empty
      const second = await provider.commit('s1');
      expect(second.scopes.agent!.status).toBe('empty');
    });

    test('nested directory structure is handled correctly', async () => {
      const result = await provider.mount('s1', ['agent']);
      const agentPath = result.paths.agent!;

      // Create nested structure
      const nestedDir = join(agentPath, 'src', 'utils');
      mkdirSync(nestedDir, { recursive: true });
      writeFileSync(join(nestedDir, 'helper.ts'), 'export function help() {}');

      const commitResult = await provider.commit('s1');
      const scope = commitResult.scopes.agent!;

      expect(scope.status).toBe('committed');
      expect(scope.filesChanged).toBe(1);

      // Verify nested file persists
      expect(readFileSync(join(nestedDir, 'helper.ts'), 'utf-8')).toBe('export function help() {}');
    });
  });

  // ── Full lifecycle ──

  describe('full lifecycle', () => {
    test('mount -> write files -> commit -> verify persisted', async () => {
      // 1. Mount
      const result = await provider.mount('s1', ['agent']);
      const agentPath = result.paths.agent!;

      // 2. Write files
      writeFileSync(join(agentPath, 'README.md'), '# My Project');
      writeFileSync(join(agentPath, 'index.ts'), 'console.log("hello")');

      // 3. Commit
      const commitResult = await provider.commit('s1');
      expect(commitResult.scopes.agent!.status).toBe('committed');
      expect(commitResult.scopes.agent!.filesChanged).toBe(2);

      // 4. Verify persisted
      expect(readFileSync(join(agentPath, 'README.md'), 'utf-8')).toBe('# My Project');
      expect(readFileSync(join(agentPath, 'index.ts'), 'utf-8')).toBe('console.log("hello")');
    });

    test('mount -> write -> commit -> mount again -> files present from previous commit', async () => {
      // First session: write and commit
      const r1 = await provider.mount('s1', ['agent']);
      const agentPath = r1.paths.agent!;

      writeFileSync(join(agentPath, 'persistent.txt'), 'survives across sessions');
      await provider.commit('s1');
      await provider.cleanup('s1');

      // Second session: mount again and check files are there
      const provider2 = await create(makeConfig());
      const r2 = await provider2.mount('s2', ['agent']);
      const agentPath2 = r2.paths.agent!;

      // Same agent scope -> same directory -> files persist
      expect(agentPath2).toBe(agentPath);
      expect(readFileSync(join(agentPath2, 'persistent.txt'), 'utf-8')).toBe('survives across sessions');
    });

    test('session scope is independent from agent scope', async () => {
      const result = await provider.mount('s1', ['agent', 'session']);
      const agentPath = result.paths.agent!;
      const sessionPath = result.paths.session!;

      expect(agentPath).not.toBe(sessionPath);

      // Write different files to each scope
      writeFileSync(join(agentPath, 'agent-file.txt'), 'agent data');
      writeFileSync(join(sessionPath, 'session-file.txt'), 'session data');

      const commitResult = await provider.commit('s1');
      expect(commitResult.scopes.agent!.filesChanged).toBe(1);
      expect(commitResult.scopes.session!.filesChanged).toBe(1);

      // Files should be in their respective directories
      expect(existsSync(join(agentPath, 'agent-file.txt'))).toBe(true);
      expect(existsSync(join(sessionPath, 'session-file.txt'))).toBe(true);
      expect(existsSync(join(agentPath, 'session-file.txt'))).toBe(false);
    });

    test('incremental commits work correctly', async () => {
      const result = await provider.mount('s1', ['agent']);
      const agentPath = result.paths.agent!;

      // First commit
      writeFileSync(join(agentPath, 'v1.txt'), 'version 1');
      const c1 = await provider.commit('s1');
      expect(c1.scopes.agent!.filesChanged).toBe(1);

      // Second commit — only new file should show
      writeFileSync(join(agentPath, 'v2.txt'), 'version 2');
      const c2 = await provider.commit('s1');
      expect(c2.scopes.agent!.filesChanged).toBe(1);

      // Both files should exist
      expect(readFileSync(join(agentPath, 'v1.txt'), 'utf-8')).toBe('version 1');
      expect(readFileSync(join(agentPath, 'v2.txt'), 'utf-8')).toBe('version 2');
    });

    test('commit with no mounted scopes returns empty result', async () => {
      const result = await provider.commit('nonexistent');
      expect(result.scopes).toEqual({});
    });
  });
});
