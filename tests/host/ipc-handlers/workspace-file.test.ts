import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createWorkspaceHandlers } from '../../../src/host/ipc-handlers/workspace.js';
import type { IPCContext } from '../../../src/host/ipc-server.js';
import type { ProviderRegistry } from '../../../src/types.js';

// Stub paths.ts to use temp directories
let tmpDir: string;
let agentWsDir: string;
let userWsDir: string;
let scratchWsDir: string;

vi.mock('../../../src/paths.js', () => ({
  agentWorkspaceDir: () => agentWsDir,
  userWorkspaceDir: () => userWsDir,
  scratchDir: () => scratchWsDir,
}));

// Minimal provider stubs
function stubProviders(): ProviderRegistry {
  return {
    audit: { log: vi.fn() },
    scanner: { scanInput: vi.fn().mockResolvedValue({ verdict: 'PASS' }) },
  } as any;
}

describe('workspace_write_file IPC handler', () => {
  let ctx: IPCContext;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ax-ws-file-test-'));
    agentWsDir = join(tmpDir, 'agent-workspace');
    userWsDir = join(tmpDir, 'user-workspace');
    scratchWsDir = join(tmpDir, 'scratch');
    mkdirSync(agentWsDir, { recursive: true });
    mkdirSync(userWsDir, { recursive: true });
    mkdirSync(scratchWsDir, { recursive: true });

    ctx = { sessionId: 'test-session', agentId: 'test-agent', userId: 'testuser' };
  });

  afterEach(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  test('writes binary file to user tier', async () => {
    const providers = stubProviders();
    const handlers = createWorkspaceHandlers(providers, { agentName: 'main', profile: 'balanced' });

    const imageData = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]); // PNG header
    const base64Data = imageData.toString('base64');

    const result = await handlers.workspace_write_file(
      { tier: 'user', path: 'files/test.png', data: base64Data, mimeType: 'image/png' },
      ctx,
    );

    expect(result.written).toBe(true);
    expect(result.size).toBe(imageData.length);

    const content = readFileSync(join(userWsDir, 'files', 'test.png'));
    expect(content).toEqual(imageData);
  });

  test('writes binary file to scratch tier', async () => {
    const providers = stubProviders();
    const handlers = createWorkspaceHandlers(providers, { agentName: 'main', profile: 'balanced' });

    const data = Buffer.from('some binary data');

    const result = await handlers.workspace_write_file(
      { tier: 'scratch', path: 'output.bin', data: data.toString('base64'), mimeType: 'application/octet-stream' },
      ctx,
    );

    expect(result.written).toBe(true);
    const content = readFileSync(join(scratchWsDir, 'output.bin'));
    expect(content).toEqual(data);
  });

  test('queues agent tier writes in paranoid mode', async () => {
    const providers = stubProviders();
    const handlers = createWorkspaceHandlers(providers, { agentName: 'main', profile: 'paranoid' });

    const result = await handlers.workspace_write_file(
      { tier: 'agent', path: 'files/image.png', data: Buffer.from('data').toString('base64'), mimeType: 'image/png' },
      ctx,
    );

    expect(result.queued).toBe(true);
  });

  test('rejects empty data', async () => {
    const providers = stubProviders();
    const handlers = createWorkspaceHandlers(providers, { agentName: 'main', profile: 'balanced' });

    const result = await handlers.workspace_write_file(
      { tier: 'user', path: 'empty.png', data: '', mimeType: 'image/png' },
      ctx,
    );

    expect(result.ok).toBe(false);
    expect(result.error).toContain('Empty');
  });

  test('creates nested directories', async () => {
    const providers = stubProviders();
    const handlers = createWorkspaceHandlers(providers, { agentName: 'main', profile: 'balanced' });

    const data = Buffer.from('nested content');

    const result = await handlers.workspace_write_file(
      { tier: 'user', path: 'deep/nested/file.bin', data: data.toString('base64'), mimeType: 'application/octet-stream' },
      ctx,
    );

    expect(result.written).toBe(true);
    const content = readFileSync(join(userWsDir, 'deep', 'nested', 'file.bin'));
    expect(content).toEqual(data);
  });

  test('audit log is called with file metadata', async () => {
    const providers = stubProviders();
    const handlers = createWorkspaceHandlers(providers, { agentName: 'main', profile: 'balanced' });

    const data = Buffer.from('audit test');

    await handlers.workspace_write_file(
      { tier: 'user', path: 'audited.png', data: data.toString('base64'), mimeType: 'image/png' },
      ctx,
    );

    expect(providers.audit.log).toHaveBeenCalledWith(expect.objectContaining({
      action: 'workspace_write_file',
      args: expect.objectContaining({
        tier: 'user',
        path: 'audited.png',
        bytes: data.length,
        mimeType: 'image/png',
      }),
    }));
  });
});
