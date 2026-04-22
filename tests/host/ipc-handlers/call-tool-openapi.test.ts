// tests/host/ipc-handlers/call-tool-openapi.test.ts
//
// Integration tests for the OpenAPI dispatcher + `call_tool` handler
// branch (Task 7.4 of the tool-dispatch-unification plan). Spins up a
// `node:http` server on an ephemeral port per test, constructs a catalog
// with one openapi tool whose `baseUrl` points at the mock, and asserts
// both the server-side request shape AND the handler's return value.
//
// Coverage matrix:
//   - Happy GET with path param substitution
//   - Happy POST with JSON body + Content-Type header
//   - Query params (primitive + array)
//   - Header params
//   - Mixed path + query + body
//   - bearer / basic / api_key_header / api_key_query auth
//   - Missing path param → dispatch_failed
//   - 4xx and 5xx → dispatch_failed with status in message
//   - Non-JSON 2xx → raw string in {result}
//   - credential+authScheme mismatch → dispatch_failed
//   - URL rewrites applied
//   - `_select` projection applied after OpenAPI dispatch
//   - Auto-spill triggered on large OpenAPI response

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { createCallToolHandler } from '../../../src/host/ipc-handlers/call-tool.js';
import {
  makeDefaultOpenApiDispatcher,
  redactCredentialsFromUrl,
} from '../../../src/host/ipc-handlers/openapi-dispatcher.js';
import { ToolCatalog } from '../../../src/host/tool-catalog/registry.js';
import type { CatalogTool } from '../../../src/types/catalog.js';
import type { IPCContext } from '../../../src/host/ipc-server.js';
import type { SkillCredStore, SkillCredRow } from '../../../src/host/skills/skill-cred-store.js';
import { getLogger, initLogger } from '../../../src/logger.js';

initLogger({ file: false, level: 'silent' });

const ctx: IPCContext = { sessionId: 's1', agentId: 'main', userId: 'alice' };

interface CapturedRequest {
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

/**
 * Minimal in-memory SkillCredStore stub. Production wires a DB-backed
 * one; the dispatcher only calls `listForAgent`, so that's all we need
 * for unit tests. Rows default to empty, so tests can opt-in by passing
 * explicit rows.
 */
function makeCredStore(rows: SkillCredRow[] = []): SkillCredStore {
  return {
    async listForAgent() {
      return rows;
    },
    async put() {
      /* no-op */
    },
    async get() {
      return null;
    },
    async listEnvNames() {
      return new Set();
    },
    async deleteForSkill() {
      /* no-op */
    },
  };
}

interface MockServer {
  baseUrl: string;
  received: CapturedRequest[];
  server: Server;
  setResponse(fn: (req: IncomingMessage, res: ServerResponse) => void): void;
  close(): Promise<void>;
}

async function startMockServer(): Promise<MockServer> {
  const received: CapturedRequest[] = [];
  let responseHandler: (req: IncomingMessage, res: ServerResponse) => void =
    (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    };

  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c as Buffer));
    req.on('end', () => {
      received.push({
        method: req.method ?? '',
        path: req.url ?? '',
        headers: { ...req.headers },
        body: Buffer.concat(chunks).toString('utf8'),
      });
      responseHandler(req, res);
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  return {
    baseUrl,
    received,
    server,
    setResponse(fn) {
      responseHandler = fn;
    },
    async close() {
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
    },
  };
}

/**
 * Build a single-tool catalog + handler. Every openapi-kind test shares
 * this shape; inlining would obscure the per-test dispatch block diffs.
 */
function makeHandler(options: {
  dispatchOverrides?: Partial<Extract<CatalogTool['dispatch'], { kind: 'openapi' }>>;
  baseUrl: string;
  credStore?: SkillCredStore;
  urlRewrites?: Record<string, string>;
}) {
  const tool: CatalogTool = {
    name: 'api_pets_get_pet_by_id',
    skill: 'pets',
    summary: 'get pet',
    schema: { type: 'object' },
    dispatch: {
      kind: 'openapi',
      baseUrl: options.baseUrl,
      method: 'GET',
      path: '/pets/{id}',
      operationId: 'getPetByID',
      params: [{ name: 'id', in: 'path' }],
      ...options.dispatchOverrides,
    },
  } as CatalogTool;

  const catalog = new ToolCatalog();
  catalog.register(tool);

  const openApiProvider = makeDefaultOpenApiDispatcher({
    skillCredStore: options.credStore ?? makeCredStore(),
    urlRewrites: options.urlRewrites,
  });

  const mcpProvider = {
    callToolOnServer: async () => {
      throw new Error('mcp dispatcher should not fire in openapi-only tests');
    },
  };

  return createCallToolHandler({ catalog, mcpProvider, openApiProvider });
}

describe('call_tool OpenAPI dispatch', () => {
  let mock: MockServer;

  beforeEach(async () => {
    mock = await startMockServer();
  });
  afterEach(async () => {
    await mock.close();
  });

  // ── Happy paths ────────────────────────────────────────────────────────

  it('substitutes path params and returns parsed JSON result (happy GET)', async () => {
    mock.setResponse((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: '5', name: 'Rex' }));
    });

    const handler = makeHandler({ baseUrl: mock.baseUrl });
    const result = await handler(
      { tool: 'api_pets_get_pet_by_id', args: { id: '5' } },
      ctx,
    );

    expect(result).toEqual({ result: { id: '5', name: 'Rex' } });
    expect(mock.received).toHaveLength(1);
    expect(mock.received[0].method).toBe('GET');
    expect(mock.received[0].path).toBe('/pets/5');
    // Client should NOT send a body on GET
    expect(mock.received[0].body).toBe('');
  });

  it('URL-encodes path param values with special characters', async () => {
    mock.setResponse((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });

    const handler = makeHandler({ baseUrl: mock.baseUrl });
    await handler(
      { tool: 'api_pets_get_pet_by_id', args: { id: 'with spaces/slash' } },
      ctx,
    );

    expect(mock.received[0].path).toBe('/pets/with%20spaces%2Fslash');
  });

  it('POST with body serializes JSON and sets Content-Type', async () => {
    mock.setResponse((_req, res) => {
      res.writeHead(201, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'new1', name: 'Rex' }));
    });

    const handler = makeHandler({
      baseUrl: mock.baseUrl,
      dispatchOverrides: {
        method: 'POST',
        path: '/pets',
        operationId: 'createPet',
        params: [],
      },
    });
    const result = await handler(
      {
        tool: 'api_pets_get_pet_by_id',
        args: { body: { name: 'Rex' } },
      },
      ctx,
    );

    expect(result).toEqual({ result: { id: 'new1', name: 'Rex' } });
    expect(mock.received[0].method).toBe('POST');
    expect(mock.received[0].path).toBe('/pets');
    expect(mock.received[0].headers['content-type']).toBe('application/json');
    expect(JSON.parse(mock.received[0].body)).toEqual({ name: 'Rex' });
  });

  it('appends primitive query params', async () => {
    mock.setResponse((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('[]');
    });

    const handler = makeHandler({
      baseUrl: mock.baseUrl,
      dispatchOverrides: {
        method: 'GET',
        path: '/pets',
        operationId: 'listPets',
        params: [{ name: 'limit', in: 'query' }],
      },
    });
    await handler(
      { tool: 'api_pets_get_pet_by_id', args: { limit: 10 } },
      ctx,
    );

    expect(mock.received[0].path).toBe('/pets?limit=10');
  });

  it('preserves query params baked into baseUrl and merges new query params onto them', async () => {
    // baseUrl carries a trailing slash AND an existing `?foo=1` query — the
    // URL-construction path must carry `foo=1` through and append `limit=10`
    // on top without corrupting the URL. Regression for the string-pieced
    // `queryPieces.join('&')` path that this test catches when baseUrl's
    // trailing `/` or query layout is non-trivial.
    mock.setResponse((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('[]');
    });

    // Use a hostname rewrite so the baseUrl keeps its real shape (trailing
    // slash + query) but dispatch still hits our ephemeral mock port.
    const handler = makeHandler({
      baseUrl: 'https://api.example.com/v1/?foo=1',
      urlRewrites: { 'api.example.com': mock.baseUrl },
      dispatchOverrides: {
        method: 'GET',
        path: '/pets',
        operationId: 'listPets',
        params: [{ name: 'limit', in: 'query' }],
      },
    });
    await handler(
      { tool: 'api_pets_get_pet_by_id', args: { limit: 10 } },
      ctx,
    );

    // `URLSearchParams` orders preserved-then-appended keys. Foo from the
    // baked-in query first, limit appended second.
    const received = mock.received[0].path;
    expect(received).toContain('foo=1');
    expect(received).toContain('limit=10');
    // Concretely: /v1/pets?foo=1&limit=10
    expect(received).toBe('/v1/pets?foo=1&limit=10');
  });

  it('serializes array query params as repeated name=value pairs', async () => {
    mock.setResponse((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('[]');
    });

    const handler = makeHandler({
      baseUrl: mock.baseUrl,
      dispatchOverrides: {
        method: 'GET',
        path: '/pets',
        operationId: 'listPets',
        params: [{ name: 'tag', in: 'query' }],
      },
    });
    await handler(
      {
        tool: 'api_pets_get_pet_by_id',
        args: { tag: ['cat', 'dog'] },
      },
      ctx,
    );

    expect(mock.received[0].path).toBe('/pets?tag=cat&tag=dog');
  });

  it('sets header params on the request', async () => {
    mock.setResponse((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });

    const handler = makeHandler({
      baseUrl: mock.baseUrl,
      dispatchOverrides: {
        method: 'GET',
        path: '/pets',
        operationId: 'listPets',
        params: [{ name: 'X-Request-ID', in: 'header' }],
      },
    });
    await handler(
      {
        tool: 'api_pets_get_pet_by_id',
        args: { 'X-Request-ID': 'abc-123' },
      },
      ctx,
    );

    expect(mock.received[0].headers['x-request-id']).toBe('abc-123');
  });

  it('rejects header value containing CRLF with a clear error', async () => {
    // LLM-controlled header values must not carry CRLF — Node's undici
    // already rejects with a cryptic "Invalid header value", but a custom
    // fetchImpl might not. Defense-in-depth: the dispatcher validates
    // first with a descriptive message that flows through dispatch_failed.
    const handler = makeHandler({
      baseUrl: mock.baseUrl,
      dispatchOverrides: {
        method: 'GET',
        path: '/pets',
        operationId: 'listPets',
        params: [{ name: 'X-Bad', in: 'header' }],
      },
    });
    const result = await handler(
      {
        tool: 'api_pets_get_pet_by_id',
        args: { 'X-Bad': 'abc\r\nInjected: yes' },
      },
      ctx,
    );

    expect(result).toMatchObject({ kind: 'dispatch_failed' });
    expect((result as { error: string }).error).toMatch(/Invalid header value for X-Bad/);
    expect(mock.received).toHaveLength(0);
  });

  it('rejects header value containing bare LF', async () => {
    const handler = makeHandler({
      baseUrl: mock.baseUrl,
      dispatchOverrides: {
        method: 'GET',
        path: '/pets',
        operationId: 'listPets',
        params: [{ name: 'X-Bad', in: 'header' }],
      },
    });
    const result = await handler(
      {
        tool: 'api_pets_get_pet_by_id',
        args: { 'X-Bad': 'abc\nInjected: yes' },
      },
      ctx,
    );

    expect(result).toMatchObject({ kind: 'dispatch_failed' });
    expect((result as { error: string }).error).toMatch(/Invalid header value/);
  });

  it('rejects header value containing null byte', async () => {
    const handler = makeHandler({
      baseUrl: mock.baseUrl,
      dispatchOverrides: {
        method: 'GET',
        path: '/pets',
        operationId: 'listPets',
        params: [{ name: 'X-Bad', in: 'header' }],
      },
    });
    const result = await handler(
      {
        tool: 'api_pets_get_pet_by_id',
        args: { 'X-Bad': 'abc\x00def' },
      },
      ctx,
    );

    expect(result).toMatchObject({ kind: 'dispatch_failed' });
    expect((result as { error: string }).error).toMatch(/Invalid header value/);
  });

  it('accepts ordinary printable header values without change', async () => {
    // Control: normal values flow through cleanly. Guards that the CRLF
    // filter isn't over-broad.
    mock.setResponse((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
    const handler = makeHandler({
      baseUrl: mock.baseUrl,
      dispatchOverrides: {
        method: 'GET',
        path: '/pets',
        operationId: 'listPets',
        params: [{ name: 'Accept', in: 'header' }],
      },
    });
    const result = await handler(
      {
        tool: 'api_pets_get_pet_by_id',
        args: { Accept: 'application/json' },
      },
      ctx,
    );

    expect(result).toMatchObject({ result: {} });
    expect(mock.received[0].headers['accept']).toBe('application/json');
  });

  it('substitutes repeated path tokens without throwing on duplicate', async () => {
    // Spec can legally have the same `{id}` appear twice in a path (e.g.
    // `/a/{id}/b/{id}`). The substitution must replace every occurrence
    // with the single value from args, not consume the arg after the
    // first replace and then fail "Missing required path parameter: id"
    // on the second.
    mock.setResponse((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });

    const handler = makeHandler({
      baseUrl: mock.baseUrl,
      dispatchOverrides: {
        method: 'GET',
        path: '/a/{id}/b/{id}',
        operationId: 'getDualID',
        params: [{ name: 'id', in: 'path' }],
      },
    });
    const result = await handler(
      { tool: 'api_pets_get_pet_by_id', args: { id: 5 } },
      ctx,
    );

    expect(result).toEqual({ result: { ok: true } });
    expect(mock.received[0].path).toBe('/a/5/b/5');
  });

  it('handles mixed path + query + body + header at once', async () => {
    mock.setResponse((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });

    const handler = makeHandler({
      baseUrl: mock.baseUrl,
      dispatchOverrides: {
        method: 'PATCH',
        path: '/pets/{id}',
        operationId: 'updatePet',
        params: [
          { name: 'id', in: 'path' },
          { name: 'dryRun', in: 'query' },
          { name: 'X-Trace-ID', in: 'header' },
        ],
      },
    });
    await handler(
      {
        tool: 'api_pets_get_pet_by_id',
        args: {
          id: '7',
          dryRun: true,
          'X-Trace-ID': 'trace-1',
          body: { name: 'Updated' },
        },
      },
      ctx,
    );

    const r = mock.received[0];
    expect(r.method).toBe('PATCH');
    expect(r.path).toBe('/pets/7?dryRun=true');
    expect(r.headers['x-trace-id']).toBe('trace-1');
    expect(r.headers['content-type']).toBe('application/json');
    expect(JSON.parse(r.body)).toEqual({ name: 'Updated' });
  });

  // ── Auth schemes ───────────────────────────────────────────────────────

  it('bearer auth resolves credential from skillCredStore and sends Authorization header', async () => {
    mock.setResponse((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });

    const credStore = makeCredStore([
      {
        skillName: 'pets',
        envName: 'PETSTORE_TOKEN',
        userId: 'alice',
        value: 'bearer-secret-xyz',
      },
    ]);
    const handler = makeHandler({
      baseUrl: mock.baseUrl,
      credStore,
      dispatchOverrides: {
        credential: 'PETSTORE_TOKEN',
        authScheme: 'bearer',
      },
    });
    await handler(
      { tool: 'api_pets_get_pet_by_id', args: { id: '1' } },
      ctx,
    );

    expect(mock.received[0].headers['authorization']).toBe('Bearer bearer-secret-xyz');
  });

  it('basic auth forwards the value as-is in Authorization header', async () => {
    mock.setResponse((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });

    const credStore = makeCredStore([
      {
        skillName: 'pets',
        envName: 'PETSTORE_BASIC',
        userId: '', // agent-scope
        // Pre-base64-encoded user:pass per skill-auth design.
        value: 'dXNlcjpwYXNz',
      },
    ]);
    const handler = makeHandler({
      baseUrl: mock.baseUrl,
      credStore,
      dispatchOverrides: {
        credential: 'PETSTORE_BASIC',
        authScheme: 'basic',
      },
    });
    await handler(
      { tool: 'api_pets_get_pet_by_id', args: { id: '1' } },
      ctx,
    );

    expect(mock.received[0].headers['authorization']).toBe('Basic dXNlcjpwYXNz');
  });

  it('api_key_header sends X-API-Key header', async () => {
    mock.setResponse((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });

    const credStore = makeCredStore([
      { skillName: 'pets', envName: 'PETSTORE_KEY', userId: 'alice', value: 'k-123' },
    ]);
    const handler = makeHandler({
      baseUrl: mock.baseUrl,
      credStore,
      dispatchOverrides: {
        credential: 'PETSTORE_KEY',
        authScheme: 'api_key_header',
      },
    });
    await handler(
      { tool: 'api_pets_get_pet_by_id', args: { id: '1' } },
      ctx,
    );

    expect(mock.received[0].headers['x-api-key']).toBe('k-123');
  });

  it('api_key_query appends api_key=<value> to the URL', async () => {
    mock.setResponse((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });

    const credStore = makeCredStore([
      { skillName: 'pets', envName: 'PETSTORE_KEY', userId: 'alice', value: 'k-456' },
    ]);
    const handler = makeHandler({
      baseUrl: mock.baseUrl,
      credStore,
      dispatchOverrides: {
        credential: 'PETSTORE_KEY',
        authScheme: 'api_key_query',
      },
    });
    await handler(
      { tool: 'api_pets_get_pet_by_id', args: { id: '1' } },
      ctx,
    );

    expect(mock.received[0].path).toBe('/pets/1?api_key=k-456');
  });

  it('credential+authScheme mismatch fails at dispatch time', async () => {
    const handler = makeHandler({
      baseUrl: mock.baseUrl,
      dispatchOverrides: {
        // credential set, authScheme NOT set — mismatch
        credential: 'SOME_KEY',
      },
    });
    const result = await handler(
      { tool: 'api_pets_get_pet_by_id', args: { id: '1' } },
      ctx,
    );

    expect(result).toMatchObject({ kind: 'dispatch_failed' });
    expect((result as { error: string }).error).toMatch(/invalid_auth_config/);
    expect(mock.received).toHaveLength(0);
  });

  // ── Error handling ─────────────────────────────────────────────────────

  it('missing path parameter returns dispatch_failed with clear message', async () => {
    const handler = makeHandler({ baseUrl: mock.baseUrl });
    const result = await handler(
      { tool: 'api_pets_get_pet_by_id', args: {} },
      ctx,
    );

    expect(result).toMatchObject({ kind: 'dispatch_failed' });
    expect((result as { error: string }).error).toMatch(/Missing required path parameter: id/);
    expect(mock.received).toHaveLength(0);
  });

  it('4xx response body is surfaced in the error with the status code', async () => {
    mock.setResponse((_req, res) => {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ message: 'invalid token' }));
    });

    const handler = makeHandler({ baseUrl: mock.baseUrl });
    const result = await handler(
      { tool: 'api_pets_get_pet_by_id', args: { id: '1' } },
      ctx,
    );

    expect(result).toMatchObject({ kind: 'dispatch_failed' });
    const err = (result as { error: string }).error;
    expect(err).toMatch(/401/);
    expect(err).toMatch(/invalid token/);
  });

  it('5xx response returns dispatch_failed with status', async () => {
    mock.setResponse((_req, res) => {
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end('internal server error');
    });

    const handler = makeHandler({ baseUrl: mock.baseUrl });
    const result = await handler(
      { tool: 'api_pets_get_pet_by_id', args: { id: '1' } },
      ctx,
    );

    expect(result).toMatchObject({ kind: 'dispatch_failed' });
    expect((result as { error: string }).error).toMatch(/500/);
  });

  it('non-JSON 2xx response returns the raw body string as {result}', async () => {
    mock.setResponse((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok');
    });

    const handler = makeHandler({ baseUrl: mock.baseUrl });
    const result = await handler(
      { tool: 'api_pets_get_pet_by_id', args: { id: '1' } },
      ctx,
    );

    expect(result).toEqual({ result: 'ok' });
  });

  // ── URL rewrites ───────────────────────────────────────────────────────

  it('applies urlRewrites to baseUrl before dispatch', async () => {
    mock.setResponse((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ rewrote: true }));
    });

    // Catalog carries the "real" frontmatter URL; urlRewrites redirects it
    // to the dynamic mock-server port — same pattern as e2e/global-setup.ts.
    const handler = makeHandler({
      baseUrl: 'https://mock-target.test',
      urlRewrites: { 'mock-target.test': mock.baseUrl },
    });
    const result = await handler(
      { tool: 'api_pets_get_pet_by_id', args: { id: '9' } },
      ctx,
    );

    expect(result).toEqual({ result: { rewrote: true } });
    expect(mock.received[0].path).toBe('/pets/9');
  });

  // ── Projection + spill ─────────────────────────────────────────────────

  it('applies _select projection after OpenAPI dispatch', async () => {
    mock.setResponse((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: '5', name: 'Rex', age: 4 }));
    });

    const handler = makeHandler({ baseUrl: mock.baseUrl });
    const result = await handler(
      { tool: 'api_pets_get_pet_by_id', args: { id: '5', _select: '.name' } },
      ctx,
    );

    expect(result).toEqual({ result: 'Rex' });
  });

  it('triggers auto-spill when OpenAPI response exceeds the threshold', async () => {
    const big = { pad: 'x'.repeat(30_000) };
    mock.setResponse((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(big));
    });

    // Build the catalog + dispatcher manually so we can pass spillThresholdBytes.
    const tool: CatalogTool = {
      name: 'api_pets_get_pet_by_id',
      skill: 'pets',
      summary: 'get pet',
      schema: { type: 'object' },
      dispatch: {
        kind: 'openapi',
        baseUrl: mock.baseUrl,
        method: 'GET',
        path: '/pets/{id}',
        operationId: 'getPetByID',
        params: [{ name: 'id', in: 'path' }],
      },
    } as CatalogTool;
    const catalog = new ToolCatalog();
    catalog.register(tool);
    const openApiProvider = makeDefaultOpenApiDispatcher({ skillCredStore: makeCredStore() });
    const mcpProvider = {
      callToolOnServer: async () => {
        throw new Error('should not fire');
      },
    };
    const handler = createCallToolHandler({
      catalog,
      mcpProvider,
      openApiProvider,
      spillThresholdBytes: 20_480,
    });

    const result = await handler(
      { tool: 'api_pets_get_pet_by_id', args: { id: '5' } },
      ctx,
    );

    expect(result).toMatchObject({ truncated: true });
    expect((result as { full: unknown }).full).toEqual(big);
  });
});

// ── Credential-in-URL redaction ────────────────────────────────────────
//
// The `api_key_query` auth scheme is the one scheme where the credential
// value lives in the URL query string instead of a request header.
// Logging the final URL on failure (fetch error or non-2xx status) would
// then spill the credential into structured logs. These tests guard that
// `api_key=<secret>` is replaced with `api_key=***` before the URL
// reaches any log call.

describe('redactCredentialsFromUrl', () => {
  it('redacts api_key query param value', () => {
    const redacted = redactCredentialsFromUrl(
      'https://example.com/pets/1?api_key=sk_live_abc123',
    );
    expect(redacted).toContain('api_key=***');
    expect(redacted).not.toContain('sk_live_abc123');
  });

  it('redacts api_key even when the value contains special characters', () => {
    // URL-encoded secret with `+`, `/`, `=` — must still be redacted by key
    // name, not by value pattern.
    const raw = 'https://example.com/x?api_key=' + encodeURIComponent('a+b/c==');
    const redacted = redactCredentialsFromUrl(raw);
    expect(redacted).toContain('api_key=***');
    expect(redacted).not.toContain('a%2Bb%2Fc%3D%3D');
    expect(redacted).not.toContain('a+b/c==');
  });

  it('leaves non-credential query params intact', () => {
    const redacted = redactCredentialsFromUrl(
      'https://example.com/pets?limit=10&api_key=secret&tag=cat',
    );
    expect(redacted).toContain('limit=10');
    expect(redacted).toContain('tag=cat');
    expect(redacted).toContain('api_key=***');
    expect(redacted).not.toContain('secret');
  });

  it('passes through URLs without any query string', () => {
    // Common case: bearer/basic/api_key_header auth — credential lives in
    // headers (already unlogged), URL is clean.
    const url = 'https://example.com/pets/1';
    expect(redactCredentialsFromUrl(url)).toBe(url);
  });

  it('returns the input unchanged when the URL is unparseable', () => {
    // Defensive: logger should never throw on a malformed URL; it should
    // emit whatever we gave it. Better to log a weird string than crash
    // the warn() call site.
    expect(redactCredentialsFromUrl('not-a-url')).toBe('not-a-url');
  });
});

/**
 * Structured log-capture via `vi.spyOn` on the shared logger. The
 * dispatcher module captures its `logger` at import time as
 * `getLogger().child({component: 'openapi-dispatcher'})`, so we can't
 * swap the underlying pino destination after the fact. Instead, we
 * spy on the `.child()` factory on `getLogger()` — but since the child
 * was already produced, that doesn't help either.
 *
 * What DOES work: the dispatcher's `logger.warn(event, details)` calls
 * land on a wrapped pino child whose methods are live — so we can
 * monkey-patch `warn` on a fresh child (obtained from `getLogger()`)
 * AFTER the dispatcher has cached its own child, because `wrapPino`
 * produces fresh objects each call. To intercept the dispatcher's
 * actual child, we instead rely on the fact that `getLogger()`
 * eventually funnels all children through the singleton pino's
 * destination. The cleanest portable path for this codebase is to
 * spy on the top-level `Logger.warn` via `vi.spyOn(getLogger(), 'warn')`
 * and ALSO spy on the child resolver so we catch child-routed warns.
 *
 * Simpler: since the dispatcher calls `logger.warn(event, details)`,
 * the `details` object is the thing that carries the URL, and the
 * redaction happens BEFORE the call. We assert on what we hand to
 * `logger.warn` — intercepted by mocking `getLogger` at module load
 * via `vi.mock`. To keep the test minimal, we use a scoped
 * `vi.doMock` + dynamic re-import so the dispatcher module picks up
 * our fake logger.
 */
describe('call_tool OpenAPI dispatch — credential not logged on failure', () => {
  let mock: MockServer;
  let warnCalls: Array<{ event: string; details?: Record<string, unknown> }>;

  beforeEach(async () => {
    mock = await startMockServer();
    warnCalls = [];

    // Swap the shared logger's `warn` with a capturing shim via
    // `vi.mock`. The dispatcher imports `getLogger` and calls
    // `.child({...})` at module init — we replace `getLogger` for this
    // suite so the child we hand back funnels every warn into
    // `warnCalls`. The mock is reset in `afterEach`.
    vi.resetModules();
    vi.doMock('../../../src/logger.js', async () => {
      const actual = await vi.importActual<typeof import('../../../src/logger.js')>(
        '../../../src/logger.js',
      );
      const fakeLogger = {
        debug: () => { /* noop */ },
        info: () => { /* noop */ },
        warn: (msg: string, details?: Record<string, unknown>) => {
          warnCalls.push({ event: msg, details });
        },
        error: () => { /* noop */ },
        fatal: () => { /* noop */ },
        child: () => fakeLogger,
      };
      return {
        ...actual,
        getLogger: () => fakeLogger,
      };
    });
  });

  afterEach(async () => {
    await mock.close();
    vi.doUnmock('../../../src/logger.js');
    vi.resetModules();
  });

  it('non-2xx failure with api_key_query does NOT leak the credential in logs', async () => {
    mock.setResponse((_req, res) => {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end('{"message":"invalid token"}');
    });

    // Dynamic import AFTER the vi.doMock call so the dispatcher picks up
    // our fake logger. The other test suites in this file used the
    // statically-imported dispatcher because they don't care about logs.
    const { makeDefaultOpenApiDispatcher: makeDispatcher } = await import(
      '../../../src/host/ipc-handlers/openapi-dispatcher.js'
    );

    const credStore = makeCredStore([
      { skillName: 'pets', envName: 'PETSTORE_KEY', userId: 'alice', value: 'SHOULD_NEVER_APPEAR_IN_LOGS' },
    ]);
    const dispatcher = makeDispatcher({ skillCredStore: credStore });

    await dispatcher.dispatchOperation({
      baseUrl: mock.baseUrl,
      method: 'GET',
      path: '/pets/{id}',
      operationId: 'getPetByID',
      skillName: 'pets',
      credential: 'PETSTORE_KEY',
      authScheme: 'api_key_query',
      params: [{ name: 'id', in: 'path' }],
      args: { id: '1' },
      ctx,
    }).catch(() => { /* dispatch_failed expected — we only care about logs */ });

    // Server saw the real credential (dispatch-path correctness) …
    expect(mock.received[0].path).toContain('api_key=SHOULD_NEVER_APPEAR_IN_LOGS');

    // … but the log details must NOT contain it anywhere.
    const failEvents = warnCalls.filter(c => c.event === 'openapi_dispatch_failed');
    expect(failEvents.length).toBeGreaterThan(0);
    const serialized = JSON.stringify(failEvents);
    expect(serialized).toContain('api_key=***');
    expect(serialized).not.toContain('SHOULD_NEVER_APPEAR_IN_LOGS');
  });

  it('network failure with api_key_query does NOT leak the credential in logs', async () => {
    // Close the mock server before dispatch so fetch throws a connection
    // error — exercises the fetch-catch log branch, not the non-2xx branch.
    const baseUrl = mock.baseUrl;
    await mock.close();

    const { makeDefaultOpenApiDispatcher: makeDispatcher } = await import(
      '../../../src/host/ipc-handlers/openapi-dispatcher.js'
    );
    const credStore = makeCredStore([
      { skillName: 'pets', envName: 'PETSTORE_KEY', userId: 'alice', value: 'NET_FAIL_SECRET_42' },
    ]);
    const dispatcher = makeDispatcher({ skillCredStore: credStore });

    await dispatcher.dispatchOperation({
      baseUrl,
      method: 'GET',
      path: '/pets/{id}',
      operationId: 'getPetByID',
      skillName: 'pets',
      credential: 'PETSTORE_KEY',
      authScheme: 'api_key_query',
      params: [{ name: 'id', in: 'path' }],
      args: { id: '1' },
      ctx,
    }).catch(() => { /* dispatch_failed expected */ });

    const failEvents = warnCalls.filter(c => c.event === 'openapi_dispatch_failed');
    expect(failEvents.length).toBeGreaterThan(0);
    const serialized = JSON.stringify(failEvents);
    expect(serialized).toContain('api_key=***');
    expect(serialized).not.toContain('NET_FAIL_SECRET_42');

    // Restart a no-op mock so the shared afterEach can call mock.close()
    // without double-closing the underlying server.
    mock = await startMockServer();
  });
});
