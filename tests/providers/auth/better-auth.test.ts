import { describe, test, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Config } from '../../../src/types.js';

describe('auth/better-auth', () => {
  // Set AX_HOME to a temp dir so dataDir()/dataFile() don't collide with real data
  beforeEach(() => {
    process.env.AX_HOME = mkdtempSync(join(tmpdir(), 'ax-better-auth-test-'));
  });

  test('create throws when better_auth config is missing', async () => {
    const config = { admin: { enabled: true, port: 9090 } } as Config;
    const { create } = await import('../../../src/providers/auth/better-auth.js');
    await expect(create(config)).rejects.toThrow('better-auth provider requires auth.better_auth config');
  });

  test('authenticate returns null when no cookie header present', async () => {
    const config = {
      admin: { enabled: true, port: 9090 },
      auth: { better_auth: { google: { client_id: 'test', client_secret: 'test' } } },
    } as unknown as Config;
    const { create } = await import('../../../src/providers/auth/better-auth.js');
    const provider = await create(config);
    const req = { headers: {} } as unknown as IncomingMessage;
    const result = await provider.authenticate(req);
    expect(result).toBeNull();
  });

  test('handleRequest returns false for non-auth routes', async () => {
    const config = {
      admin: { enabled: true, port: 9090 },
      auth: { better_auth: { google: { client_id: 'test', client_secret: 'test' } } },
    } as unknown as Config;
    const { create } = await import('../../../src/providers/auth/better-auth.js');
    const provider = await create(config);
    const req = { url: '/admin/api/status', headers: {} } as unknown as IncomingMessage;
    const res = {} as unknown as ServerResponse;
    const handled = await provider.handleRequest!(req, res);
    expect(handled).toBe(false);
  });
});
