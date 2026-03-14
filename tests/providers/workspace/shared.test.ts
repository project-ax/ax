import { describe, test, expect, vi, beforeEach } from 'vitest';
import { createOrchestrator } from '../../../src/providers/workspace/shared.js';
import type { WorkspaceProvider, WorkspaceBackend, FileChange } from '../../../src/providers/workspace/types.js';
import type { ScannerProvider, ScanResult } from '../../../src/providers/scanner/types.js';

// ═══════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════

function textChange(path: string, content: string, type: 'added' | 'modified' = 'added'): FileChange {
  const buf = Buffer.from(content, 'utf-8');
  return { path, type, content: buf, size: buf.length };
}

function deleteChange(path: string): FileChange {
  return { path, type: 'deleted', size: 0 };
}

function binaryChange(path: string, size = 100): FileChange {
  // Buffer with null bytes to trigger binary detection
  const buf = Buffer.alloc(size);
  buf[0] = 0x89; // PNG-like header
  buf[1] = 0x00; // null byte
  return { path, type: 'added', content: buf, size: buf.length };
}

function createMockScanner(overrides?: Partial<ScannerProvider>): ScannerProvider {
  return {
    scanInput: vi.fn(async () => ({ verdict: 'PASS' as const })),
    scanOutput: vi.fn(async () => ({ verdict: 'PASS' as const })),
    canaryToken: vi.fn(() => 'CANARY-mock'),
    checkCanary: vi.fn(() => false),
    ...overrides,
  };
}

function createMockBackend(overrides?: Partial<WorkspaceBackend>): WorkspaceBackend {
  return {
    mount: vi.fn(async (scope, id) => `/workspace/${scope}/${id}`),
    diff: vi.fn(async () => []),
    commit: vi.fn(async () => {}),
    ...overrides,
  };
}

const AGENT_ID = 'test-agent';

// ═══════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════

describe('workspace/shared orchestrator', () => {
  let scanner: ScannerProvider;
  let backend: WorkspaceBackend;

  beforeEach(() => {
    scanner = createMockScanner();
    backend = createMockBackend();
  });

  // ── Scope tracking ──

  describe('scope tracking', () => {
    test('activeMounts returns correct scopes after mount', async () => {
      const provider = createOrchestrator({ backend, scanner, config: {}, agentId: AGENT_ID });

      await provider.mount('s1', ['agent', 'session']);
      const mounts = provider.activeMounts('s1');
      expect(mounts).toContain('agent');
      expect(mounts).toContain('session');
      expect(mounts).toHaveLength(2);
    });

    test('scopes accumulate across multiple mount calls (additive)', async () => {
      const provider = createOrchestrator({ backend, scanner, config: {}, agentId: AGENT_ID });

      await provider.mount('s1', ['session']);
      await provider.mount('s1', ['agent']);

      const mounts = provider.activeMounts('s1');
      expect(mounts).toContain('session');
      expect(mounts).toContain('agent');
      expect(mounts).toHaveLength(2);
    });

    test('already-mounted scope is not re-mounted on backend', async () => {
      const provider = createOrchestrator({ backend, scanner, config: {}, agentId: AGENT_ID });

      await provider.mount('s1', ['agent']);
      await provider.mount('s1', ['agent', 'session']);

      // Backend should be called once for agent and once for session (not twice for agent)
      expect(backend.mount).toHaveBeenCalledTimes(2);
    });

    test('mount with userId resolves user scope to userId instead of sessionId', async () => {
      const provider = createOrchestrator({ backend, scanner, config: {}, agentId: AGENT_ID });

      await provider.mount('s1', ['user'], { userId: 'alice' });

      // Backend should be called with scope='user', id='alice' (not 's1')
      expect(backend.mount).toHaveBeenCalledWith('user', 'alice');
    });

    test('mount without userId resolves user scope to sessionId', async () => {
      const provider = createOrchestrator({ backend, scanner, config: {}, agentId: AGENT_ID });

      await provider.mount('s1', ['user']);

      // Without userId, should fall back to sessionId
      expect(backend.mount).toHaveBeenCalledWith('user', 's1');
    });

    test('mount with userId resolves agent scope to agentId (not userId)', async () => {
      const provider = createOrchestrator({ backend, scanner, config: {}, agentId: AGENT_ID });

      await provider.mount('s1', ['agent'], { userId: 'alice' });

      // Agent scope uses agentId, not userId
      expect(backend.mount).toHaveBeenCalledWith('agent', AGENT_ID);
    });

    test('different sessions are independent', async () => {
      const provider = createOrchestrator({ backend, scanner, config: {}, agentId: AGENT_ID });

      await provider.mount('s1', ['agent']);
      await provider.mount('s2', ['session']);

      expect(provider.activeMounts('s1')).toEqual(['agent']);
      expect(provider.activeMounts('s2')).toEqual(['session']);
    });

    test('activeMounts returns empty for unknown session', () => {
      const provider = createOrchestrator({ backend, scanner, config: {}, agentId: AGENT_ID });
      expect(provider.activeMounts('unknown')).toEqual([]);
    });
  });

  // ── Commit pipeline: structural checks ──

  describe('commit pipeline — structural checks', () => {
    test('files exceeding maxFileSize are rejected', async () => {
      const largeContent = Buffer.alloc(200, 'x'); // 200 bytes
      const changes: FileChange[] = [
        { path: 'big.txt', type: 'added', content: largeContent, size: largeContent.length },
      ];

      backend = createMockBackend({ diff: vi.fn(async () => changes) });
      const provider = createOrchestrator({
        backend, scanner, config: { maxFileSize: 100 }, agentId: AGENT_ID,
      });

      await provider.mount('s1', ['agent']);
      const result = await provider.commit('s1');

      const scope = result.scopes.agent!;
      expect(scope.status).toBe('rejected');
      expect(scope.filesChanged).toBe(0);
      expect(scope.rejections).toHaveLength(1);
      expect(scope.rejections![0].path).toBe('big.txt');
      expect(scope.rejections![0].reason).toContain('file size');
    });

    test('commits exceeding maxFiles count are rejected', async () => {
      const changes = Array.from({ length: 5 }, (_, i) => textChange(`file${i}.txt`, 'content'));

      backend = createMockBackend({ diff: vi.fn(async () => changes) });
      const provider = createOrchestrator({
        backend, scanner, config: { maxFiles: 3 }, agentId: AGENT_ID,
      });

      await provider.mount('s1', ['agent']);
      const result = await provider.commit('s1');

      const scope = result.scopes.agent!;
      // First 3 should pass, remaining 2 rejected for count
      expect(scope.filesChanged).toBe(3);
      expect(scope.rejections).toHaveLength(2);
      expect(scope.rejections!.every(r => r.reason.includes('file count'))).toBe(true);
    });

    test('commits exceeding maxCommitSize are rejected', async () => {
      const changes = [
        textChange('a.txt', 'x'.repeat(60)),
        textChange('b.txt', 'y'.repeat(60)),
      ];

      backend = createMockBackend({ diff: vi.fn(async () => changes) });
      const provider = createOrchestrator({
        backend, scanner, config: { maxCommitSize: 100 }, agentId: AGENT_ID,
      });

      await provider.mount('s1', ['agent']);
      const result = await provider.commit('s1');

      const scope = result.scopes.agent!;
      // First file fits (60 < 100), second pushes over (120 > 100)
      expect(scope.filesChanged).toBe(1);
      expect(scope.rejections).toHaveLength(1);
      expect(scope.rejections![0].path).toBe('b.txt');
      expect(scope.rejections![0].reason).toContain('commit size');
    });

    test('ignore patterns filter out matching files', async () => {
      const changes = [
        textChange('.git/config', 'git config data'),
        textChange('node_modules/lodash/index.js', 'module.exports'),
        textChange('app.log', 'log entries'),
        textChange('src/main.ts', 'console.log("hello")'),
      ];

      backend = createMockBackend({ diff: vi.fn(async () => changes) });
      const provider = createOrchestrator({
        backend, scanner, config: {}, agentId: AGENT_ID,
      });

      await provider.mount('s1', ['agent']);
      const result = await provider.commit('s1');

      const scope = result.scopes.agent!;
      expect(scope.status).toBe('committed');
      // Only src/main.ts should pass
      expect(scope.filesChanged).toBe(1);
      // .git/, node_modules/, *.log should be rejected
      expect(scope.rejections).toHaveLength(3);
      const rejectedPaths = scope.rejections!.map(r => r.path);
      expect(rejectedPaths).toContain('.git/config');
      expect(rejectedPaths).toContain('node_modules/lodash/index.js');
      expect(rejectedPaths).toContain('app.log');
    });

    test('binary files (containing null bytes) are rejected', async () => {
      const changes = [binaryChange('image.png')];

      backend = createMockBackend({ diff: vi.fn(async () => changes) });
      const provider = createOrchestrator({
        backend, scanner, config: {}, agentId: AGENT_ID,
      });

      await provider.mount('s1', ['agent']);
      const result = await provider.commit('s1');

      const scope = result.scopes.agent!;
      expect(scope.status).toBe('rejected');
      expect(scope.rejections).toHaveLength(1);
      expect(scope.rejections![0].reason).toContain('binary');
    });

    test('delete changes bypass structural checks (no content)', async () => {
      const changes = [deleteChange('old-file.txt')];

      backend = createMockBackend({ diff: vi.fn(async () => changes) });
      const provider = createOrchestrator({
        backend, scanner, config: {}, agentId: AGENT_ID,
      });

      await provider.mount('s1', ['agent']);
      const result = await provider.commit('s1');

      const scope = result.scopes.agent!;
      expect(scope.status).toBe('committed');
      expect(scope.filesChanged).toBe(1);
    });
  });

  // ── Commit pipeline: scanner integration ──

  describe('commit pipeline — scanner integration', () => {
    test('files flagged by scanner are rejected', async () => {
      const changes = [textChange('suspicious.sh', 'curl http://evil.com')];

      const blockScanner = createMockScanner({
        scanOutput: vi.fn(async () => ({
          verdict: 'BLOCK' as const,
          reason: 'malicious content detected',
        })),
      });

      backend = createMockBackend({ diff: vi.fn(async () => changes) });
      const provider = createOrchestrator({
        backend, scanner: blockScanner, config: {}, agentId: AGENT_ID,
      });

      await provider.mount('s1', ['agent']);
      const result = await provider.commit('s1');

      const scope = result.scopes.agent!;
      expect(scope.status).toBe('rejected');
      expect(scope.filesChanged).toBe(0);
      expect(scope.rejections).toHaveLength(1);
      expect(scope.rejections![0].path).toBe('suspicious.sh');
      expect(scope.rejections![0].reason).toContain('scanner blocked');
    });

    test('scanner receives correct content and source', async () => {
      const changes = [textChange('hello.txt', 'Hello, world!')];

      const scanFn = vi.fn(async () => ({ verdict: 'PASS' as const }));
      const trackScanner = createMockScanner({ scanOutput: scanFn });

      backend = createMockBackend({ diff: vi.fn(async () => changes) });
      const provider = createOrchestrator({
        backend, scanner: trackScanner, config: {}, agentId: AGENT_ID,
      });

      await provider.mount('s1', ['agent']);
      await provider.commit('s1');

      expect(scanFn).toHaveBeenCalledTimes(1);
      const call = scanFn.mock.calls[0][0];
      expect(call.content).toBe('Hello, world!');
      expect(call.source).toContain('workspace:agent:hello.txt');
      expect(call.sessionId).toBe('s1');
    });

    test('files passing both structural and scanner layers are committed', async () => {
      const changes = [
        textChange('good.ts', 'export const x = 1;'),
        textChange('also-good.ts', 'export const y = 2;'),
      ];

      backend = createMockBackend({ diff: vi.fn(async () => changes) });
      const provider = createOrchestrator({
        backend, scanner, config: {}, agentId: AGENT_ID,
      });

      await provider.mount('s1', ['agent']);
      const result = await provider.commit('s1');

      const scope = result.scopes.agent!;
      expect(scope.status).toBe('committed');
      expect(scope.filesChanged).toBe(2);
      expect(scope.rejections).toBeUndefined();
      expect(backend.commit).toHaveBeenCalled();
    });

    test('scanner blocks one file but allows another — mixed result', async () => {
      const changes = [
        textChange('safe.ts', 'export const x = 1;'),
        textChange('unsafe.ts', 'stealing your data'),
      ];

      let callCount = 0;
      const selectiveScanner = createMockScanner({
        scanOutput: vi.fn(async (target) => {
          callCount++;
          if (target.content.includes('stealing')) {
            return { verdict: 'BLOCK' as const, reason: 'data exfiltration' };
          }
          return { verdict: 'PASS' as const };
        }),
      });

      backend = createMockBackend({ diff: vi.fn(async () => changes) });
      const provider = createOrchestrator({
        backend, scanner: selectiveScanner, config: {}, agentId: AGENT_ID,
      });

      await provider.mount('s1', ['agent']);
      const result = await provider.commit('s1');

      const scope = result.scopes.agent!;
      expect(scope.status).toBe('committed');
      expect(scope.filesChanged).toBe(1);
      expect(scope.rejections).toHaveLength(1);
      expect(scope.rejections![0].path).toBe('unsafe.ts');
    });

    test('delete changes skip scanner (no content to scan)', async () => {
      const changes = [deleteChange('removed.txt')];

      const scanFn = vi.fn(async () => ({ verdict: 'PASS' as const }));
      const trackScanner = createMockScanner({ scanOutput: scanFn });

      backend = createMockBackend({ diff: vi.fn(async () => changes) });
      const provider = createOrchestrator({
        backend, scanner: trackScanner, config: {}, agentId: AGENT_ID,
      });

      await provider.mount('s1', ['agent']);
      await provider.commit('s1');

      expect(scanFn).not.toHaveBeenCalled();
    });
  });

  // ── Commit results ──

  describe('commit results', () => {
    test('empty changeset returns status empty', async () => {
      backend = createMockBackend({ diff: vi.fn(async () => []) });
      const provider = createOrchestrator({
        backend, scanner, config: {}, agentId: AGENT_ID,
      });

      await provider.mount('s1', ['agent']);
      const result = await provider.commit('s1');

      const scope = result.scopes.agent!;
      expect(scope.status).toBe('empty');
      expect(scope.filesChanged).toBe(0);
      expect(scope.bytesChanged).toBe(0);
    });

    test('committed result reports correct file and byte counts', async () => {
      const content1 = 'hello'; // 5 bytes
      const content2 = 'world!'; // 6 bytes
      const changes = [
        textChange('a.txt', content1),
        textChange('b.txt', content2),
      ];

      backend = createMockBackend({ diff: vi.fn(async () => changes) });
      const provider = createOrchestrator({
        backend, scanner, config: {}, agentId: AGENT_ID,
      });

      await provider.mount('s1', ['agent']);
      const result = await provider.commit('s1');

      const scope = result.scopes.agent!;
      expect(scope.status).toBe('committed');
      expect(scope.filesChanged).toBe(2);
      expect(scope.bytesChanged).toBe(5 + 6);
    });

    test('all-rejected changeset returns status rejected with reasons', async () => {
      const changes = [binaryChange('image.bin'), binaryChange('video.bin')];

      backend = createMockBackend({ diff: vi.fn(async () => changes) });
      const provider = createOrchestrator({
        backend, scanner, config: {}, agentId: AGENT_ID,
      });

      await provider.mount('s1', ['agent']);
      const result = await provider.commit('s1');

      const scope = result.scopes.agent!;
      expect(scope.status).toBe('rejected');
      expect(scope.filesChanged).toBe(0);
      expect(scope.rejections).toHaveLength(2);
      for (const r of scope.rejections!) {
        expect(r.path).toBeTruthy();
        expect(r.reason).toBeTruthy();
      }
    });

    test('no mounted scopes returns empty commit result', async () => {
      const provider = createOrchestrator({
        backend, scanner, config: {}, agentId: AGENT_ID,
      });

      // commit without mounting anything
      const result = await provider.commit('s1');
      expect(result.scopes).toEqual({});
    });

    test('multiple scopes produce independent results', async () => {
      let diffCallCount = 0;
      backend = createMockBackend({
        diff: vi.fn(async (scope) => {
          diffCallCount++;
          if (scope === 'agent') {
            return [textChange('agent-file.ts', 'code')];
          }
          return []; // session scope has no changes
        }),
      });

      const provider = createOrchestrator({
        backend, scanner, config: {}, agentId: AGENT_ID,
      });

      await provider.mount('s1', ['agent', 'session']);
      const result = await provider.commit('s1');

      expect(result.scopes.agent!.status).toBe('committed');
      expect(result.scopes.agent!.filesChanged).toBe(1);
      expect(result.scopes.session!.status).toBe('empty');
    });
  });

  // ── Commit uses remembered userId ──

  describe('commit uses userId from mount', () => {
    test('commit resolves user scope with the userId provided during mount', async () => {
      const changes = [textChange('prefs.txt', 'dark mode')];
      backend = createMockBackend({ diff: vi.fn(async () => changes) });
      const provider = createOrchestrator({
        backend, scanner, config: {}, agentId: AGENT_ID,
      });

      // Mount with userId='alice'
      await provider.mount('s1', ['agent', 'user'], { userId: 'alice' });

      // Commit should use 'alice' (not 's1') for the user scope
      await provider.commit('s1');

      // backend.diff should be called with ('user', 'alice')
      expect(backend.diff).toHaveBeenCalledWith('user', 'alice');
      // backend.commit should be called with ('user', 'alice', ...)
      expect(backend.commit).toHaveBeenCalledWith('user', 'alice', expect.any(Array));
    });

    test('commit without userId falls back to sessionId for user scope', async () => {
      const changes = [textChange('prefs.txt', 'dark mode')];
      backend = createMockBackend({ diff: vi.fn(async () => changes) });
      const provider = createOrchestrator({
        backend, scanner, config: {}, agentId: AGENT_ID,
      });

      // Mount without userId
      await provider.mount('s1', ['user']);
      await provider.commit('s1');

      expect(backend.diff).toHaveBeenCalledWith('user', 's1');
    });

    test('cleanup removes remembered userId', async () => {
      const changes = [textChange('file.txt', 'data')];
      backend = createMockBackend({ diff: vi.fn(async () => changes) });
      const provider = createOrchestrator({
        backend, scanner, config: {}, agentId: AGENT_ID,
      });

      await provider.mount('s1', ['user'], { userId: 'alice' });
      await provider.cleanup('s1');

      // Re-mount without userId after cleanup — should not use old 'alice'
      await provider.mount('s1', ['user']);
      await provider.commit('s1');

      // The last diff call should use 's1' (sessionId fallback), not 'alice'
      const diffCalls = (backend.diff as any).mock.calls;
      const lastCall = diffCalls[diffCalls.length - 1];
      expect(lastCall).toEqual(['user', 's1']);
    });
  });

  // ── Cleanup ──

  describe('cleanup', () => {
    test('session scope tracking is removed after cleanup', async () => {
      const provider = createOrchestrator({
        backend, scanner, config: {}, agentId: AGENT_ID,
      });

      await provider.mount('s1', ['agent', 'session']);
      expect(provider.activeMounts('s1')).toHaveLength(2);

      await provider.cleanup('s1');
      expect(provider.activeMounts('s1')).toEqual([]);
    });

    test('cleanup of one session does not affect other sessions', async () => {
      const provider = createOrchestrator({
        backend, scanner, config: {}, agentId: AGENT_ID,
      });

      await provider.mount('s1', ['agent']);
      await provider.mount('s2', ['session']);

      await provider.cleanup('s1');

      expect(provider.activeMounts('s1')).toEqual([]);
      expect(provider.activeMounts('s2')).toEqual(['session']);
    });

    test('cleanup of non-existent session does not throw', async () => {
      const provider = createOrchestrator({
        backend, scanner, config: {}, agentId: AGENT_ID,
      });

      await expect(provider.cleanup('nonexistent')).resolves.toBeUndefined();
    });

    test('commit after cleanup returns empty result', async () => {
      backend = createMockBackend({
        diff: vi.fn(async () => [textChange('file.ts', 'code')]),
      });

      const provider = createOrchestrator({
        backend, scanner, config: {}, agentId: AGENT_ID,
      });

      await provider.mount('s1', ['agent']);
      await provider.cleanup('s1');

      const result = await provider.commit('s1');
      expect(result.scopes).toEqual({});
    });
  });

  // ── Config defaults ──

  describe('config defaults', () => {
    test('uses default limits when config is empty', async () => {
      // Create a file that would fail with very low limits but pass with defaults
      const changes = [textChange('normal.ts', 'x'.repeat(1000))];

      backend = createMockBackend({ diff: vi.fn(async () => changes) });
      const provider = createOrchestrator({
        backend, scanner, config: {}, agentId: AGENT_ID,
      });

      await provider.mount('s1', ['agent']);
      const result = await provider.commit('s1');

      expect(result.scopes.agent!.status).toBe('committed');
    });

    test('custom ignore patterns override defaults', async () => {
      // node_modules/ is in default ignore patterns
      // if we override with empty array, it should pass
      const changes = [textChange('node_modules/lodash/index.js', 'code')];

      backend = createMockBackend({ diff: vi.fn(async () => changes) });
      const provider = createOrchestrator({
        backend, scanner, config: { ignorePatterns: [] }, agentId: AGENT_ID,
      });

      await provider.mount('s1', ['agent']);
      const result = await provider.commit('s1');

      expect(result.scopes.agent!.status).toBe('committed');
      expect(result.scopes.agent!.filesChanged).toBe(1);
    });
  });
});
