// tests/host/server-admin-skills-helpers.test.ts
//
// Unit tests for the admin skills helper module. The HTTP integration path
// is covered in server-admin-skills.test.ts; this file pins lower-level
// serializer invariants that the approve flow depends on.

import { describe, it, expect } from 'vitest';
import { serializeFrontmatter } from '../../src/host/server-admin-skills-helpers.js';

describe('serializeFrontmatter', () => {
  it('emits canonical key order with only name + description for a minimal skill', () => {
    const out = serializeFrontmatter({
      name: 'weather',
      description: 'Weather forecasts',
      credentials: [],
      mcpServers: [],
      domains: [],
    });
    expect(Object.keys(out)).toEqual(['name', 'description']);
  });

  it('preserves openapi[] block through the approval rewrite', () => {
    // REGRESSION: a prior version of this helper omitted the `openapi` field
    // entirely, silently dropping it on every approve. An OpenAPI-only skill
    // would end up "enabled" with zero tools in the catalog and no error
    // surface. See fix commit referenced in the function docstring.
    const out = serializeFrontmatter({
      name: 'petstore',
      description: 'Public Swagger petstore demo',
      source: { url: 'https://petstore3.swagger.io/api/v3/openapi.json', version: '1.0.0' },
      credentials: [],
      mcpServers: [],
      openapi: [{
        spec: 'https://petstore3.swagger.io/api/v3/openapi.json',
        baseUrl: 'https://petstore3.swagger.io/api/v3',
        include: ['findPets*', 'getPet*'],
      }],
      domains: ['petstore3.swagger.io'],
    });
    expect(out.openapi).toEqual([{
      spec: 'https://petstore3.swagger.io/api/v3/openapi.json',
      baseUrl: 'https://petstore3.swagger.io/api/v3',
      include: ['findPets*', 'getPet*'],
    }]);
    // Canonical ordering places openapi after mcpServers and before domains.
    expect(Object.keys(out)).toEqual(['name', 'description', 'source', 'openapi', 'domains']);
  });

  it('preserves optional openapi fields (auth, include, exclude) verbatim', () => {
    const out = serializeFrontmatter({
      name: 'api',
      description: 'Example',
      credentials: [],
      mcpServers: [],
      openapi: [{
        spec: 'https://example.com/openapi.json',
        baseUrl: 'https://example.com/v1',
        auth: { scheme: 'bearer', credential: 'EXAMPLE_TOKEN' },
        include: ['list*'],
        exclude: ['deleteAll'],
      }],
      domains: [],
    });
    expect(out.openapi).toEqual([{
      spec: 'https://example.com/openapi.json',
      baseUrl: 'https://example.com/v1',
      auth: { scheme: 'bearer', credential: 'EXAMPLE_TOKEN' },
      include: ['list*'],
      exclude: ['deleteAll'],
    }]);
  });

  it('omits openapi key when the array is empty', () => {
    const out = serializeFrontmatter({
      name: 'weather',
      description: 'Weather forecasts',
      credentials: [],
      mcpServers: [],
      openapi: [],
      domains: [],
    });
    expect(out).not.toHaveProperty('openapi');
  });

  it('omits openapi key when the field is undefined', () => {
    const out = serializeFrontmatter({
      name: 'weather',
      description: 'Weather forecasts',
      credentials: [],
      mcpServers: [],
      domains: [],
    });
    expect(out).not.toHaveProperty('openapi');
  });

  it('co-emits openapi alongside mcpServers for hybrid skills', () => {
    const out = serializeFrontmatter({
      name: 'hybrid',
      description: 'Skill with both MCP and OpenAPI',
      credentials: [],
      mcpServers: [{
        name: 'mcp1',
        url: 'https://mcp.example.com',
        transport: 'http',
      }],
      openapi: [{
        spec: 'https://api.example.com/openapi.json',
        baseUrl: 'https://api.example.com/v1',
      }],
      domains: [],
    });
    expect(out.mcpServers).toBeDefined();
    expect(out.openapi).toBeDefined();
    expect(Object.keys(out)).toEqual(['name', 'description', 'mcpServers', 'openapi']);
  });
});
