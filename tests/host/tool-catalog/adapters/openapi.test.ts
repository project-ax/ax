import { describe, test, expect, beforeAll } from 'vitest';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import type { OpenAPIV3 } from 'openapi-types';
import { buildOpenApiCatalogTools } from '../../../../src/host/tool-catalog/adapters/openapi.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = resolve(__dirname, '../../../fixtures/openapi/petstore-minimal.json');

describe('buildOpenApiCatalogTools', () => {
  let petstore: OpenAPIV3.Document;

  beforeAll(async () => {
    const raw = await readFile(FIXTURE_PATH, 'utf8');
    petstore = JSON.parse(raw) as OpenAPIV3.Document;
  });

  test('builds one catalog tool per operation with a valid operationId', () => {
    const tools = buildOpenApiCatalogTools({
      skill: 'petstore',
      spec: petstore,
      baseUrl: 'https://petstore.test',
    });
    expect(tools).toHaveLength(4);
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([
      'api_petstore_create_pet',
      'api_petstore_delete_pet',
      'api_petstore_get_pet_by_id',
      'api_petstore_list_pets',
    ]);
  });

  test('derives inputSchema from parameters and requestBody; preserves method+path; keeps original operationId', () => {
    const tools = buildOpenApiCatalogTools({
      skill: 'petstore',
      spec: petstore,
      baseUrl: 'https://petstore.test',
    });

    const listPets = tools.find((t) => t.name === 'api_petstore_list_pets')!;
    expect(listPets.schema).toMatchObject({
      type: 'object',
      properties: { limit: { type: 'integer', maximum: 100, format: 'int32' } },
    });
    expect((listPets.schema as { required?: string[] }).required ?? []).not.toContain('limit');
    expect(listPets.dispatch).toMatchObject({
      kind: 'openapi',
      method: 'GET',
      path: '/pets',
      operationId: 'listPets',
      baseUrl: 'https://petstore.test',
      params: [{ name: 'limit', in: 'query' }],
    });

    const createPet = tools.find((t) => t.name === 'api_petstore_create_pet')!;
    const createSchema = createPet.schema as { properties?: Record<string, unknown>; required?: string[] };
    expect(createSchema.properties).toHaveProperty('body');
    expect(createSchema.required).toContain('body');
    expect(createPet.dispatch).toMatchObject({
      kind: 'openapi',
      method: 'POST',
      path: '/pets',
      operationId: 'createPet',
    });

    const getPet = tools.find((t) => t.name === 'api_petstore_get_pet_by_id')!;
    const getSchema = getPet.schema as { properties?: Record<string, unknown>; required?: string[] };
    expect(getSchema.properties).toHaveProperty('id');
    expect(getSchema.required).toContain('id');
    // Path preserves template braces.
    expect(getPet.dispatch).toMatchObject({
      kind: 'openapi',
      method: 'GET',
      path: '/pets/{id}',
      // Original operationId (camelCase) — NOT the snake_case tool-name suffix.
      operationId: 'getPetByID',
      params: [{ name: 'id', in: 'path' }],
    });

    // createPet has no params (body-only) — `params` must still be an empty
    // array so the dispatcher can iterate without guard conditions.
    expect((createPet.dispatch as { params: unknown[] }).params).toEqual([]);
  });

  test('populates params with correct in: value for path/query/header locations; skips cookie', () => {
    const spec: OpenAPIV3.Document = {
      openapi: '3.0.3',
      info: { title: 't', version: '1' },
      paths: {
        '/x/{id}': {
          get: {
            operationId: 'mixedParams',
            parameters: [
              { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
              { name: 'limit', in: 'query', schema: { type: 'integer' } },
              { name: 'X-Request-ID', in: 'header', schema: { type: 'string' } },
              // Cookie should be dropped — it hits the warn branch in buildInputSchema
              // and is filtered out of `dispatch.params` as well.
              { name: 'session', in: 'cookie', schema: { type: 'string' } },
            ],
            responses: { '200': { description: 'ok' } },
          },
        },
      },
    };
    const tools = buildOpenApiCatalogTools({
      skill: 's',
      spec,
      baseUrl: 'https://example.test',
    });
    expect(tools).toHaveLength(1);
    const params = (tools[0].dispatch as { params: Array<{ name: string; in: string }> }).params;
    // Order matches spec declaration — path, query, header. Cookie dropped.
    expect(params).toEqual([
      { name: 'id', in: 'path' },
      { name: 'limit', in: 'query' },
      { name: 'X-Request-ID', in: 'header' },
    ]);
  });

  test('populates credential + authScheme when auth block present; undefined otherwise', () => {
    const withAuth = buildOpenApiCatalogTools({
      skill: 'petstore',
      spec: petstore,
      baseUrl: 'https://petstore.test',
      auth: { scheme: 'bearer', credential: 'PETSTORE_TOKEN' },
    });
    const anyWithAuth = withAuth[0];
    expect(anyWithAuth.dispatch).toMatchObject({
      kind: 'openapi',
      credential: 'PETSTORE_TOKEN',
      authScheme: 'bearer',
    });

    const withoutAuth = buildOpenApiCatalogTools({
      skill: 'petstore',
      spec: petstore,
      baseUrl: 'https://petstore.test',
    });
    const disp = withoutAuth[0].dispatch as { credential?: string; authScheme?: string };
    expect(disp.credential).toBeUndefined();
    expect(disp.authScheme).toBeUndefined();
  });

  test('applies include filter against operationId (bare name, not catalog-prefixed)', () => {
    const tools = buildOpenApiCatalogTools({
      skill: 'petstore',
      spec: petstore,
      baseUrl: 'https://petstore.test',
      include: ['*Pet', '*PetByID'],
    });
    // createPet, deletePet, getPetByID match. listPets does not.
    expect(tools.map((t) => t.name).sort()).toEqual([
      'api_petstore_create_pet',
      'api_petstore_delete_pet',
      'api_petstore_get_pet_by_id',
    ]);
  });

  test('exclude filter is applied after include', () => {
    const tools = buildOpenApiCatalogTools({
      skill: 'petstore',
      spec: petstore,
      baseUrl: 'https://petstore.test',
      exclude: ['deletePet'],
    });
    expect(tools.map((t) => t.name)).not.toContain('api_petstore_delete_pet');
    expect(tools).toHaveLength(3);
  });

  test('skips operations without an operationId', () => {
    const spec: OpenAPIV3.Document = {
      openapi: '3.0.3',
      info: { title: 't', version: '1' },
      paths: {
        '/anonymous': {
          get: {
            // no operationId
            responses: { '200': { description: 'ok' } },
          },
        },
        '/named': {
          get: {
            operationId: 'doThing',
            responses: { '200': { description: 'ok' } },
          },
        },
      },
    };
    const tools = buildOpenApiCatalogTools({
      skill: 'x',
      spec,
      baseUrl: 'https://example.test',
    });
    expect(tools.map((t) => t.name)).toEqual(['api_x_do_thing']);
  });

  test('rejects OpenAPI v2 (swagger: "2.0") with a descriptive error', () => {
    const v2 = { swagger: '2.0', info: { title: 't', version: '1' }, paths: {} };
    expect(() =>
      buildOpenApiCatalogTools({
        skill: 'x',
        // Deliberate shape mismatch — adapter is meant to reject before using the document.
        spec: v2 as unknown as OpenAPIV3.Document,
        baseUrl: 'https://example.test',
      }),
    ).toThrow(/v2|Swagger|3\./i);
  });

  test('camelCase → snake_case conversion: listPets, getPetByID, UserV2_create', () => {
    const spec: OpenAPIV3.Document = {
      openapi: '3.0.3',
      info: { title: 't', version: '1' },
      paths: {
        '/a': { get: { operationId: 'listPets', responses: { '200': { description: 'ok' } } } },
        '/b': { get: { operationId: 'getPetByID', responses: { '200': { description: 'ok' } } } },
        '/c': { get: { operationId: 'UserV2_create', responses: { '200': { description: 'ok' } } } },
      },
    };
    const tools = buildOpenApiCatalogTools({
      skill: 's',
      spec,
      baseUrl: 'https://example.test',
    });
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(['api_s_get_pet_by_id', 'api_s_list_pets', 'api_s_user_v2_create']);
  });
});
