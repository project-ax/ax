import { describe, test, expect, vi, beforeAll } from 'vitest';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import type { OpenAPIV3 } from 'openapi-types';
import { ToolCatalog } from '../../../src/host/tool-catalog/registry.js';
import { populateCatalogFromSkills } from '../../../src/host/skills/catalog-population.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PETSTORE_PATH = resolve(__dirname, '../../fixtures/openapi/petstore-minimal.json');

/** Throwing stub for tests whose skill fixtures don't declare `openapi[]`.
 *  The factory is required on the input type (compile-time guarantee); these
 *  tests never exercise the openapi path, so the stub never fires. */
const unusedFetchOpenApiSpec = async (): Promise<never> => {
  throw new Error('fetchOpenApiSpec should not have been called in this test');
};

describe('populateCatalogFromSkills', () => {
  test('populates catalog from skill snapshot MCP servers', async () => {
    const mcpClient = {
      listTools: vi.fn().mockResolvedValue([
        { name: 'list_issues', description: 'List', inputSchema: { type: 'object' } },
      ]),
    };
    const catalog = new ToolCatalog();
    await populateCatalogFromSkills({
      skills: [{ name: 'linear', frontmatter: { mcpServers: [{ name: 'linear' }] } } as never],
      getMcpClient: () => mcpClient as never,
      fetchOpenApiSpec: unusedFetchOpenApiSpec,
      catalog,
    });
    expect(catalog.list()).toHaveLength(1);
    expect(catalog.get('mcp_linear_list_issues')).toBeDefined();
  });

  test('applies include filter from frontmatter', async () => {
    const mcpClient = {
      listTools: vi.fn().mockResolvedValue([
        { name: 'list_issues', inputSchema: {} },
        { name: 'delete_issue', inputSchema: {} },
      ]),
    };
    const catalog = new ToolCatalog();
    await populateCatalogFromSkills({
      skills: [{ name: 'linear', frontmatter: { mcpServers: [{ name: 'linear', include: ['list_*'] }] } } as never],
      getMcpClient: () => mcpClient as never,
      fetchOpenApiSpec: unusedFetchOpenApiSpec,
      catalog,
    });
    expect(catalog.list().map(t => t.name)).toEqual(['mcp_linear_list_issues']);
  });

  test('applies exclude filter from frontmatter', async () => {
    const mcpClient = {
      listTools: vi.fn().mockResolvedValue([
        { name: 'list_issues', inputSchema: {} },
        { name: 'delete_issue', inputSchema: {} },
      ]),
    };
    const catalog = new ToolCatalog();
    await populateCatalogFromSkills({
      skills: [{ name: 'linear', frontmatter: { mcpServers: [{ name: 'linear', exclude: ['delete_*'] }] } } as never],
      getMcpClient: () => mcpClient as never,
      fetchOpenApiSpec: unusedFetchOpenApiSpec,
      catalog,
    });
    expect(catalog.list().map(t => t.name)).toEqual(['mcp_linear_list_issues']);
  });

  test('skips entries with ok: false and servers where listTools throws', async () => {
    const goodClient = {
      listTools: vi.fn().mockResolvedValue([
        { name: 'ping', inputSchema: {} },
      ]),
    };
    const badClient = {
      listTools: vi.fn().mockRejectedValue(new Error('boom')),
    };
    const catalog = new ToolCatalog();
    await populateCatalogFromSkills({
      skills: [
        { name: 'broken', ok: false, error: 'invalid' } as never,
        {
          name: 'mixed',
          ok: true,
          frontmatter: {
            mcpServers: [
              { name: 'good-server' },
              { name: 'bad-server' },
            ],
          },
        } as never,
      ],
      getMcpClient: (_skill, serverName) => (serverName === 'good-server' ? goodClient : badClient) as never,
      fetchOpenApiSpec: unusedFetchOpenApiSpec,
      catalog,
    });
    // Only the good server contributed tools; bad server's failure is swallowed.
    expect(catalog.list().map(t => t.name)).toEqual(['mcp_mixed_ping']);
  });

  test('populates multiple skills and servers without cross-contamination', async () => {
    const linearClient = {
      listTools: vi.fn().mockResolvedValue([{ name: 'list_issues', inputSchema: {} }]),
    };
    const githubClient = {
      listTools: vi.fn().mockResolvedValue([{ name: 'list_repos', inputSchema: {} }]),
    };
    const catalog = new ToolCatalog();
    await populateCatalogFromSkills({
      skills: [
        { name: 'linear', ok: true, frontmatter: { mcpServers: [{ name: 'linear' }] } } as never,
        { name: 'github', ok: true, frontmatter: { mcpServers: [{ name: 'github' }] } } as never,
      ],
      getMcpClient: (_skill, serverName) => (serverName === 'linear' ? linearClient : githubClient) as never,
      fetchOpenApiSpec: unusedFetchOpenApiSpec,
      catalog,
    });
    expect(catalog.list().map(t => t.name).sort()).toEqual([
      'mcp_github_list_repos',
      'mcp_linear_list_issues',
    ]);
  });

  test('skips entries with no mcpServers declared', async () => {
    const catalog = new ToolCatalog();
    const listTools = vi.fn();
    await populateCatalogFromSkills({
      skills: [
        { name: 'weather', ok: true, frontmatter: { mcpServers: [] } } as never,
      ],
      getMcpClient: () => ({ listTools }) as never,
      fetchOpenApiSpec: unusedFetchOpenApiSpec,
      catalog,
    });
    expect(catalog.list()).toEqual([]);
    expect(listTools).not.toHaveBeenCalled();
  });

  // Regression: a flaky 401 from one MCP server used to silently poison
  // the cache. The builder now reports per-server failures so the cache
  // can skip writes and the next turn retries.
  test('returns serverFailures > 0 when a server\'s listTools throws', async () => {
    const flaky = { listTools: vi.fn().mockRejectedValue(new Error('invalid_token')) };
    const catalog = new ToolCatalog();
    const result = await populateCatalogFromSkills({
      skills: [
        { name: 'linear', ok: true, frontmatter: { mcpServers: [{ name: 'linear' }] } } as never,
      ],
      getMcpClient: () => flaky as never,
      fetchOpenApiSpec: unusedFetchOpenApiSpec,
      catalog,
    });
    expect(result.serverFailures).toBe(1);
    expect(result.toolRegisterFailures).toBe(0);
    expect(catalog.list()).toEqual([]);
  });

  test('returns serverFailures: 0 on clean build (idempotent success signal)', async () => {
    const client = {
      listTools: vi.fn().mockResolvedValue([{ name: 'list_issues', inputSchema: {} }]),
    };
    const catalog = new ToolCatalog();
    const result = await populateCatalogFromSkills({
      skills: [
        { name: 'linear', ok: true, frontmatter: { mcpServers: [{ name: 'linear' }] } } as never,
      ],
      getMcpClient: () => client as never,
      fetchOpenApiSpec: unusedFetchOpenApiSpec,
      catalog,
    });
    expect(result.serverFailures).toBe(0);
    expect(result.toolRegisterFailures).toBe(0);
  });

  test('counts tool-register failures separately from server failures (dupes stay cache-safe)', async () => {
    // Two skills declare servers that advertise the same tool name. The
    // second registration throws — that's a deterministic clash, not a
    // transient failure. Separate counter so callers can keep caching.
    const client = {
      listTools: vi.fn().mockResolvedValue([{ name: 'shared_tool', inputSchema: {} }]),
    };
    const catalog = new ToolCatalog();
    const result = await populateCatalogFromSkills({
      skills: [
        { name: 'a', ok: true, frontmatter: { mcpServers: [{ name: 's' }] } } as never,
        { name: 'a', ok: true, frontmatter: { mcpServers: [{ name: 's' }] } } as never,
      ],
      getMcpClient: () => client as never,
      fetchOpenApiSpec: unusedFetchOpenApiSpec,
      catalog,
    });
    expect(result.serverFailures).toBe(0);
    expect(result.toolRegisterFailures).toBe(1);
    expect(result.openApiSourceFailures).toBe(0);
  });

  // ── OpenAPI wiring ──
  // The adapter is pure (tested separately). This block exercises the
  // orchestrator's openapi loop: iterating frontmatter.openapi[], calling the
  // injected fetchOpenApiSpec factory, handing the dereferenced doc to
  // buildOpenApiCatalogTools, and registering the resulting catalog tools.
  describe('openapi sources', () => {
    let petstore: OpenAPIV3.Document;

    beforeAll(async () => {
      const raw = await readFile(PETSTORE_PATH, 'utf8');
      petstore = JSON.parse(raw) as OpenAPIV3.Document;
    });

    test('populates catalog from skill frontmatter openapi[] sources', async () => {
      const fetchOpenApiSpec = vi.fn().mockResolvedValue(petstore);
      const catalog = new ToolCatalog();
      const result = await populateCatalogFromSkills({
        skills: [
          {
            name: 'petstore',
            ok: true,
            frontmatter: {
              openapi: [{ spec: 'https://petstore.test/openapi.json', baseUrl: 'https://petstore.test' }],
            },
          } as never,
        ],
        getMcpClient: () => ({ listTools: vi.fn() }) as never,
        fetchOpenApiSpec,
        catalog,
      });
      expect(fetchOpenApiSpec).toHaveBeenCalledTimes(1);
      expect(fetchOpenApiSpec).toHaveBeenCalledWith('petstore', expect.objectContaining({
        spec: 'https://petstore.test/openapi.json',
        baseUrl: 'https://petstore.test',
      }));
      expect(result.openApiSourceFailures).toBe(0);
      expect(result.serverFailures).toBe(0);
      expect(result.toolRegisterFailures).toBe(0);
      expect(catalog.list()).toHaveLength(4);
      expect(catalog.list().map(t => t.name).sort()).toEqual([
        'api_petstore_create_pet',
        'api_petstore_delete_pet',
        'api_petstore_get_pet_by_id',
        'api_petstore_list_pets',
      ]);
    });

    test('applies include filter from openapi source', async () => {
      const fetchOpenApiSpec = vi.fn().mockResolvedValue(petstore);
      const catalog = new ToolCatalog();
      await populateCatalogFromSkills({
        skills: [
          {
            name: 'petstore',
            ok: true,
            frontmatter: {
              openapi: [{
                spec: 'https://petstore.test/openapi.json',
                baseUrl: 'https://petstore.test',
                include: ['list*', 'get*'],
              }],
            },
          } as never,
        ],
        getMcpClient: () => ({ listTools: vi.fn() }) as never,
        fetchOpenApiSpec,
        catalog,
      });
      expect(catalog.list().map(t => t.name).sort()).toEqual([
        'api_petstore_get_pet_by_id',
        'api_petstore_list_pets',
      ]);
    });

    test('applies exclude filter from openapi source', async () => {
      const fetchOpenApiSpec = vi.fn().mockResolvedValue(petstore);
      const catalog = new ToolCatalog();
      await populateCatalogFromSkills({
        skills: [
          {
            name: 'petstore',
            ok: true,
            frontmatter: {
              openapi: [{
                spec: 'https://petstore.test/openapi.json',
                baseUrl: 'https://petstore.test',
                exclude: ['delete*'],
              }],
            },
          } as never,
        ],
        getMcpClient: () => ({ listTools: vi.fn() }) as never,
        fetchOpenApiSpec,
        catalog,
      });
      expect(catalog.list().map(t => t.name).sort()).toEqual([
        'api_petstore_create_pet',
        'api_petstore_get_pet_by_id',
        'api_petstore_list_pets',
      ]);
    });

    test('passes auth block through to the adapter dispatch', async () => {
      const fetchOpenApiSpec = vi.fn().mockResolvedValue(petstore);
      const catalog = new ToolCatalog();
      await populateCatalogFromSkills({
        skills: [
          {
            name: 'petstore',
            ok: true,
            frontmatter: {
              openapi: [{
                spec: 'https://petstore.test/openapi.json',
                baseUrl: 'https://petstore.test',
                auth: { scheme: 'bearer', credential: 'PETSTORE_API_KEY' },
              }],
            },
          } as never,
        ],
        getMcpClient: () => ({ listTools: vi.fn() }) as never,
        fetchOpenApiSpec,
        catalog,
      });
      const tool = catalog.get('api_petstore_list_pets')!;
      expect(tool.dispatch).toMatchObject({
        kind: 'openapi',
        authScheme: 'bearer',
        credential: 'PETSTORE_API_KEY',
      });
    });

    test('multiple openapi sources in one skill: all register', async () => {
      // Two sources with disjoint paths → all operations surface.
      const secondSpec = JSON.parse(JSON.stringify(petstore)) as OpenAPIV3.Document;
      // Rename operationIds so the catalog tool names don't collide with
      // the first source. Keep it simple: prefix with "v2".
      for (const pathItem of Object.values(secondSpec.paths ?? {})) {
        if (!pathItem) continue;
        for (const method of ['get', 'post', 'put', 'patch', 'delete'] as const) {
          const op = (pathItem as Record<string, OpenAPIV3.OperationObject | undefined>)[method];
          if (op?.operationId) op.operationId = `v2_${op.operationId}`;
        }
      }
      const fetchOpenApiSpec = vi.fn()
        .mockImplementation((_skill: string, source: { spec: string }) =>
          Promise.resolve(source.spec.includes('v1') ? petstore : secondSpec));
      const catalog = new ToolCatalog();
      const result = await populateCatalogFromSkills({
        skills: [
          {
            name: 'petstore',
            ok: true,
            frontmatter: {
              openapi: [
                { spec: 'https://petstore.test/v1.json', baseUrl: 'https://petstore.test' },
                { spec: 'https://petstore.test/v2.json', baseUrl: 'https://petstore.test/v2' },
              ],
            },
          } as never,
        ],
        getMcpClient: () => ({ listTools: vi.fn() }) as never,
        fetchOpenApiSpec,
        catalog,
      });
      expect(result.openApiSourceFailures).toBe(0);
      expect(catalog.list()).toHaveLength(8); // 4 + 4
    });

    test('one bad openapi source does not poison the rest', async () => {
      // Source A parses fine; source B throws. Catalog should have A's tools
      // and count B as openApiSourceFailures=1.
      const fetchOpenApiSpec = vi.fn()
        .mockImplementation((_skill: string, source: { spec: string }) => {
          if (source.spec.includes('bad')) return Promise.reject(new Error('parse failed'));
          return Promise.resolve(petstore);
        });
      const catalog = new ToolCatalog();
      const result = await populateCatalogFromSkills({
        skills: [
          {
            name: 'petstore',
            ok: true,
            frontmatter: {
              openapi: [
                { spec: 'https://petstore.test/good.json', baseUrl: 'https://petstore.test' },
                { spec: 'https://petstore.test/bad.json', baseUrl: 'https://petstore.test' },
              ],
            },
          } as never,
        ],
        getMcpClient: () => ({ listTools: vi.fn() }) as never,
        fetchOpenApiSpec,
        catalog,
      });
      expect(result.openApiSourceFailures).toBe(1);
      expect(result.serverFailures).toBe(0);
      expect(catalog.list()).toHaveLength(4); // A's tools only
    });

    test('counts toolRegisterFailures across openapi sources (duplicate names)', async () => {
      // Two sources on the same skill produce colliding tool names — second
      // registration fails deterministically.
      const fetchOpenApiSpec = vi.fn().mockResolvedValue(petstore);
      const catalog = new ToolCatalog();
      const result = await populateCatalogFromSkills({
        skills: [
          {
            name: 'petstore',
            ok: true,
            frontmatter: {
              openapi: [
                { spec: 'https://petstore.test/a.json', baseUrl: 'https://petstore.test' },
                { spec: 'https://petstore.test/b.json', baseUrl: 'https://petstore.test' },
              ],
            },
          } as never,
        ],
        getMcpClient: () => ({ listTools: vi.fn() }) as never,
        fetchOpenApiSpec,
        catalog,
      });
      expect(result.openApiSourceFailures).toBe(0);
      expect(result.toolRegisterFailures).toBe(4); // all 4 names collide the second time
      expect(catalog.list()).toHaveLength(4);
    });

    test('MCP + OpenAPI in the same skill: both populate', async () => {
      const mcpClient = {
        listTools: vi.fn().mockResolvedValue([{ name: 'ping', inputSchema: {} }]),
      };
      const fetchOpenApiSpec = vi.fn().mockResolvedValue(petstore);
      const catalog = new ToolCatalog();
      await populateCatalogFromSkills({
        skills: [
          {
            name: 'mixed',
            ok: true,
            frontmatter: {
              mcpServers: [{ name: 'pinger' }],
              openapi: [{ spec: 'https://petstore.test/openapi.json', baseUrl: 'https://petstore.test' }],
            },
          } as never,
        ],
        getMcpClient: () => mcpClient as never,
        fetchOpenApiSpec,
        catalog,
      });
      const names = catalog.list().map(t => t.name).sort();
      expect(names).toEqual([
        'api_mixed_create_pet',
        'api_mixed_delete_pet',
        'api_mixed_get_pet_by_id',
        'api_mixed_list_pets',
        'mcp_mixed_ping',
      ]);
    });

    test('skips openapi sources when skill entry is ok: false', async () => {
      const fetchOpenApiSpec = vi.fn().mockResolvedValue(petstore);
      const catalog = new ToolCatalog();
      await populateCatalogFromSkills({
        skills: [
          { name: 'broken', ok: false, error: 'invalid' } as never,
        ],
        getMcpClient: () => ({ listTools: vi.fn() }) as never,
        fetchOpenApiSpec,
        catalog,
      });
      expect(fetchOpenApiSpec).not.toHaveBeenCalled();
      expect(catalog.list()).toEqual([]);
    });
  });
});
