// tests/host/server-admin-skills.test.ts
//
// Phase 5 Task 2: GET /admin/api/skills/setup — list pending setup cards grouped by agent.
// Mirrors the fixture patterns from server-admin.test.ts; duplication is intentional for clarity.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createServer as createHttpServer, type Server } from 'node:http';
import { createAdminHandler, _rateLimits, type AdminDeps } from '../../src/host/server-admin.js';
import type { Config } from '../../src/types.js';
import { createSqliteRegistry } from '../../src/host/agent-registry-db.js';
import { createEventBus } from '../../src/host/event-bus.js';
import type { SetupRequest } from '../../src/host/skills/types.js';
import type { SkillStateStore } from '../../src/host/skills/state-store.js';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initLogger } from '../../src/logger.js';

vi.mock('../../src/host/identity-reader.js', () => ({
  readIdentityForAgent: vi.fn(async () => ({ soul: 'Test soul.', identity: 'Test identity.' })),
  loadIdentityFromGit: vi.fn(() => ({})),
  fetchIdentityFromRemote: vi.fn(() => ({ gitDir: '/tmp/mock', identity: {} })),
  IDENTITY_FILE_MAP: [],
}));

initLogger({ file: false, level: 'silent' });

function makeConfig(): Config {
  return {
    agent_name: 'test-agent',
    profile: 'balanced',
    providers: {
      memory: 'cortex',
      security: 'patterns',
      channels: [],
      web: { extract: 'none', search: 'none' },
      credentials: 'database',
      audit: 'database',
      sandbox: 'docker',
      scheduler: 'none',
    },
    sandbox: { timeout_sec: 120, memory_mb: 512 },
    scheduler: {
      active_hours: { start: '07:00', end: '23:00', timezone: 'UTC' },
      max_token_budget: 4096,
      heartbeat_interval_min: 30,
    },
    history: {
      max_turns: 50,
      thread_context_turns: 5,
      summarize: false,
      summarize_threshold: 40,
      summarize_keep_recent: 10,
      memory_recall: false,
      memory_recall_limit: 5,
      memory_recall_scope: '*',
      embedding_model: 'text-embedding-3-small',
      embedding_dimensions: 1536,
    },
    admin: {
      enabled: true,
      token: 'test-secret-token',
      port: 8080,
    },
  } as Config;
}

interface MockDepsOpts {
  registerOther?: boolean;
  registerArchived?: boolean;
  withStateStore?: boolean;
  getSetupQueueImpl?: (agentId: string) => Promise<SetupRequest[]>;
}

async function mockDeps(opts: MockDepsOpts = {}): Promise<AdminDeps> {
  const tmpDir = mkdtempSync(join(tmpdir(), 'ax-admin-skills-test-'));
  const config = makeConfig();
  const registry = await createSqliteRegistry(join(tmpDir, 'registry.db'));
  await registry.register({
    id: 'main', name: 'Main Agent', description: 'Primary agent', status: 'active',
    parentId: null, agentType: 'pi-coding-agent', capabilities: [], createdBy: 'test',
  });
  if (opts.registerOther) {
    await registry.register({
      id: 'other', name: 'Other Agent', description: 'Another agent', status: 'active',
      parentId: null, agentType: 'pi-coding-agent', capabilities: [], createdBy: 'test',
    });
  }
  if (opts.registerArchived) {
    await registry.register({
      id: 'archived', name: 'Archived Agent', description: 'Archived agent', status: 'active',
      parentId: null, agentType: 'pi-coding-agent', capabilities: [], createdBy: 'test',
    });
    await registry.update('archived', { status: 'archived' });
  }

  const deps: AdminDeps = {
    config,
    providers: {
      audit: { log: vi.fn().mockResolvedValue(undefined), query: vi.fn().mockResolvedValue([]) },
    } as unknown as AdminDeps['providers'],
    eventBus: createEventBus(),
    agentRegistry: registry,
    startTime: Date.now() - 60_000,
  };

  if (opts.withStateStore !== false) {
    const getSetupQueue = opts.getSetupQueueImpl
      ? vi.fn().mockImplementation(opts.getSetupQueueImpl)
      : vi.fn().mockResolvedValue([] as SetupRequest[]);
    deps.skillStateStore = {
      getPriorStates: vi.fn().mockResolvedValue(new Map()),
      getStates: vi.fn().mockResolvedValue([]),
      putStates: vi.fn().mockResolvedValue(undefined),
      putSetupQueue: vi.fn().mockResolvedValue(undefined),
      getSetupQueue,
      putStatesAndQueue: vi.fn().mockResolvedValue(undefined),
    } as unknown as SkillStateStore;
  }

  return deps;
}

function startTestServer(
  handler: ReturnType<typeof createAdminHandler>,
): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = createHttpServer(async (req, res) => {
      const url = req.url ?? '/';
      if (url.startsWith('/admin')) {
        await handler(req, res, url.split('?')[0]);
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()!;
      resolve({ server, port: (addr as { port: number }).port });
    });
  });
}

async function fetchAdmin(
  port: number,
  path: string,
  opts: { token?: string; method?: string; body?: unknown } = {},
): Promise<{ status: number; body: unknown }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (opts.token) headers['Authorization'] = `Bearer ${opts.token}`;
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: opts.method ?? 'GET',
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  let body: unknown;
  try { body = await res.json(); } catch { body = null; }
  return { status: res.status, body };
}

const mainCard: SetupRequest = {
  skillName: 'linear',
  description: 'Linear stuff',
  missingCredentials: [
    { envName: 'LINEAR_TOKEN', authType: 'api_key', scope: 'user' },
  ],
  unapprovedDomains: ['api.linear.app'],
  mcpServers: [{ name: 'linear-mcp', url: 'https://mcp.linear.app/sse' }],
};

describe('GET /admin/api/skills/setup', () => {
  let server: Server;
  let port: number;

  beforeEach(() => {
    _rateLimits.clear();
  });

  afterEach(() => {
    server?.close();
  });

  it('returns cards grouped by agent (only agents with non-empty queues)', async () => {
    const deps = await mockDeps({
      registerOther: true,
      getSetupQueueImpl: async (agentId) => {
        if (agentId === 'main') return [mainCard];
        return [];
      },
    });
    const handler = createAdminHandler(deps);
    ({ server, port } = await startTestServer(handler));

    const res = await fetchAdmin(port, '/admin/api/skills/setup', { token: 'test-secret-token' });
    expect(res.status).toBe(200);
    const body = res.body as { agents: Array<{ agentId: string; agentName: string; cards: unknown[] }> };
    expect(Array.isArray(body.agents)).toBe(true);
    expect(body.agents).toHaveLength(1);
    expect(body.agents[0].agentId).toBe('main');
    expect(body.agents[0].agentName).toBe('Main Agent');
    expect(body.agents[0].cards).toEqual([mainCard]);
  });

  it('returns empty agents array when no agent has queue entries', async () => {
    const deps = await mockDeps({
      registerOther: true,
      getSetupQueueImpl: async () => [],
    });
    const handler = createAdminHandler(deps);
    ({ server, port } = await startTestServer(handler));

    const res = await fetchAdmin(port, '/admin/api/skills/setup', { token: 'test-secret-token' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ agents: [] });
  });

  it('returns 503 with "Skills not configured" when skillStateStore is missing', async () => {
    const deps = await mockDeps({ withStateStore: false });
    expect(deps.skillStateStore).toBeUndefined();
    const handler = createAdminHandler(deps);
    ({ server, port } = await startTestServer(handler));

    const res = await fetchAdmin(port, '/admin/api/skills/setup', { token: 'test-secret-token' });
    expect(res.status).toBe(503);
    // sendError() wraps the message in { error: { message, type, code } } — see src/host/server-http.ts.
    const body = res.body as { error: { message: string } };
    expect(body.error.message).toBe('Skills not configured');
  });

  it('excludes archived agents from the result', async () => {
    // Archived agent has a queue entry — it must still be excluded.
    const deps = await mockDeps({
      registerArchived: true,
      getSetupQueueImpl: async (agentId) => {
        if (agentId === 'archived') return [{ ...mainCard, skillName: 'ghost' }];
        return [];
      },
    });
    const handler = createAdminHandler(deps);
    ({ server, port } = await startTestServer(handler));

    const res = await fetchAdmin(port, '/admin/api/skills/setup', { token: 'test-secret-token' });
    expect(res.status).toBe(200);
    const body = res.body as { agents: Array<{ agentId: string }> };
    expect(body.agents.map(a => a.agentId)).not.toContain('archived');
    expect(body.agents).toEqual([]);
  });

  it('preserves card order and all fields verbatim from getSetupQueue', async () => {
    const cards: SetupRequest[] = [
      {
        skillName: 'alpha',
        description: 'First skill',
        missingCredentials: [
          { envName: 'A_TOKEN', authType: 'api_key', scope: 'agent' },
        ],
        unapprovedDomains: ['a.example.com', 'b.example.com'],
        mcpServers: [{ name: 'alpha-mcp', url: 'https://a.example.com/mcp' }],
      },
      {
        skillName: 'beta',
        description: 'Second skill',
        missingCredentials: [
          {
            envName: 'B_OAUTH',
            authType: 'oauth',
            scope: 'user',
            oauth: {
              provider: 'github',
              clientId: 'abc123',
              authorizationUrl: 'https://github.com/login/oauth/authorize',
              tokenUrl: 'https://github.com/login/oauth/access_token',
              scopes: ['repo', 'read:user'],
            },
          },
        ],
        unapprovedDomains: [],
        mcpServers: [],
      },
    ];
    const deps = await mockDeps({
      getSetupQueueImpl: async () => cards,
    });
    const handler = createAdminHandler(deps);
    ({ server, port } = await startTestServer(handler));

    const res = await fetchAdmin(port, '/admin/api/skills/setup', { token: 'test-secret-token' });
    expect(res.status).toBe(200);
    const body = res.body as { agents: Array<{ cards: SetupRequest[] }> };
    expect(body.agents).toHaveLength(1);
    expect(body.agents[0].cards).toEqual(cards);
    // Order preserved
    expect(body.agents[0].cards[0].skillName).toBe('alpha');
    expect(body.agents[0].cards[1].skillName).toBe('beta');
  });
});
