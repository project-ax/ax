/**
 * Tests for tool stub generation.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { generateToolStubs, groupToolsByServer, generateCLI, mcpToolToCLICommand } from '../../../src/host/capnweb/codegen.js';
import type { McpToolSchema } from '../../../src/providers/mcp/types.js';
import { initLogger } from '../../../src/logger.js';

initLogger({ file: false, level: 'silent' });

describe('groupToolsByServer', () => {
  it('should group by underscore prefix and strip prefix from name', () => {
    const groups = groupToolsByServer([
      { name: 'linear_getIssues', description: '', inputSchema: {} },
      { name: 'linear_getTeams', description: '', inputSchema: {} },
      { name: 'github_getRepo', description: '', inputSchema: {} },
    ]);
    expect(groups).toHaveLength(2);
    const linear = groups.find(g => g.server === 'linear')!;
    expect(linear.tools).toHaveLength(2);
    expect(linear.tools.map(t => t.name)).toEqual(['getIssues', 'getTeams']);
    expect(groups.find(g => g.server === 'github')?.tools[0].name).toBe('getRepo');
  });

  it('should group by slash prefix and strip prefix from name', () => {
    const groups = groupToolsByServer([
      { name: 'linear/getIssues', description: '', inputSchema: {} },
      { name: 'linear/getTeams', description: '', inputSchema: {} },
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].server).toBe('linear');
    expect(groups[0].tools.map(t => t.name)).toEqual(['getIssues', 'getTeams']);
  });

  it('should put unprefixed tools in default without stripping', () => {
    const groups = groupToolsByServer([
      { name: 'search', description: '', inputSchema: {} },
    ]);
    expect(groups[0].server).toBe('default');
    expect(groups[0].tools[0].name).toBe('search');
  });
});

describe('generateToolStubs', () => {
  let tempDir: string;

  beforeEach(() => { tempDir = mkdtempSync(join(tmpdir(), 'ax-codegen-')); });
  afterEach(() => { rmSync(tempDir, { recursive: true, force: true }); });

  it('should generate proxy-based _runtime.ts with zero deps', async () => {
    const outputDir = join(tempDir, 'tools');
    await generateToolStubs({ outputDir, groups: [] });

    const runtime = readFileSync(join(outputDir, '_runtime.ts'), 'utf8');
    expect(runtime).toContain('callTool');
    expect(runtime).toContain('AX_IPC_SOCKET');
    expect(runtime).toContain('tool_batch');
    expect(runtime).toContain('Proxy');
    expect(runtime).toContain('__batchRef');
    expect(runtime).not.toContain('capnweb');
  });

  it('should generate per-server tool files with proper types', async () => {
    const outputDir = join(tempDir, 'tools');
    const result = await generateToolStubs({
      outputDir,
      groups: [
        {
          server: 'linear',
          tools: [
            {
              name: 'getIssues',
              description: 'Get Linear issues',
              inputSchema: {
                type: 'object',
                properties: { teamId: { type: 'string' }, limit: { type: 'number' } },
                required: ['teamId'],
              },
            },
            { name: 'getTeams', description: 'Get teams', inputSchema: {} },
          ],
        },
        {
          server: 'github',
          tools: [{
            name: 'getRepository',
            description: 'Get repo',
            inputSchema: {
              type: 'object',
              properties: { owner: { type: 'string' }, name: { type: 'string' } },
              required: ['owner', 'name'],
            },
          }],
        },
      ],
    });

    expect(existsSync(join(outputDir, '_runtime.ts'))).toBe(true);
    expect(existsSync(join(outputDir, 'linear', 'getIssues.ts'))).toBe(true);
    expect(existsSync(join(outputDir, 'linear', 'getTeams.ts'))).toBe(true);
    expect(existsSync(join(outputDir, 'linear', 'index.ts'))).toBe(true);
    expect(existsSync(join(outputDir, 'github', 'getRepository.ts'))).toBe(true);

    const stub = readFileSync(join(outputDir, 'linear', 'getIssues.ts'), 'utf8');
    expect(stub).toContain('export function getIssues');
    expect(stub).toContain('teamId: string');
    expect(stub).toContain('limit?: number');
    expect(stub).toContain('callTool');

    const barrel = readFileSync(join(outputDir, 'linear', 'index.ts'), 'utf8');
    expect(barrel).toContain("export { getIssues }");
    expect(barrel).toContain("export { getTeams }");

    expect(result.toolCount).toBe(3);
  });

  it('should handle complex schemas via json-schema-to-typescript', async () => {
    const outputDir = join(tempDir, 'tools');
    await generateToolStubs({
      outputDir,
      groups: [{
        server: 'api',
        tools: [{
          name: 'create',
          description: 'Create',
          inputSchema: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              tags: { type: 'array', items: { type: 'string' } },
              status: { type: 'string', enum: ['open', 'closed'] },
              nested: { type: 'object', properties: { deep: { type: 'boolean' } } },
            },
            required: ['name'],
          },
        }],
      }],
    });

    const content = readFileSync(join(outputDir, 'api', 'create.ts'), 'utf8');
    expect(content).toContain('name: string');
    expect(content).toContain('tags?:');
    expect(content).toContain('string[]');
    expect(content).toContain('deep?:');
    // json-schema-to-typescript generates enum types
    expect(content).toMatch(/status\?:.*"open"|"closed"/s);
  });

  it('should sanitize names to valid identifiers', async () => {
    const outputDir = join(tempDir, 'tools');
    await generateToolStubs({
      outputDir,
      groups: [{
        server: 'test',
        tools: [{ name: 'get-items', description: '', inputSchema: {} }],
      }],
    });

    expect(existsSync(join(outputDir, 'test', 'getItems.ts'))).toBe(true);
    const content = readFileSync(join(outputDir, 'test', 'getItems.ts'), 'utf8');
    expect(content).toContain('export function getItems');
  });
});

describe('mcpToolToCLICommand', () => {
  it('parses list_issues → list issues', () => {
    expect(mcpToolToCLICommand('list_issues')).toEqual({ verb: 'list', noun: 'issues' });
  });
  it('parses get_team → get team', () => {
    expect(mcpToolToCLICommand('get_team')).toEqual({ verb: 'get', noun: 'team' });
  });
  it('parses save_customer_need → save customer-need', () => {
    expect(mcpToolToCLICommand('save_customer_need')).toEqual({ verb: 'save', noun: 'customer-need' });
  });
  it('parses search_documentation → search documentation', () => {
    expect(mcpToolToCLICommand('search_documentation')).toEqual({ verb: 'search', noun: 'documentation' });
  });
  it('parses extract_images → extract images', () => {
    expect(mcpToolToCLICommand('extract_images')).toEqual({ verb: 'extract', noun: 'images' });
  });
  it('parses get_authenticated_user → get authenticated-user', () => {
    expect(mcpToolToCLICommand('get_authenticated_user')).toEqual({ verb: 'get', noun: 'authenticated-user' });
  });
});

describe('generateCLI', () => {
  it('generates a valid JS file with shebang', () => {
    const result = generateCLI('linear', [
      { name: 'list_issues', description: 'List issues', inputSchema: { type: 'object', properties: { team: { type: 'string' }, limit: { type: 'number' } } } },
      { name: 'get_issue', description: 'Get issue by ID', inputSchema: { type: 'object', properties: { id: { type: 'string' } } } },
    ]);
    expect(result).toMatch(/^#!\/usr\/bin\/env node\n/);
    expect(result).toContain("'list issues'");
    expect(result).toContain("'get issue'");
    expect(result).toContain('list_issues');
    expect(result).toContain("'team'");
    expect(result).toContain("'limit'");
    expect(result).toContain("'id'");
    // Help output groups
    expect(result).toContain("'Issues'");
  });

  it('includes IPC client using fetch', () => {
    const result = generateCLI('linear', [
      { name: 'list_teams', description: 'List teams', inputSchema: { type: 'object', properties: { limit: { type: 'number' } } } },
    ]);
    expect(result).toContain('AX_HOST_URL');
    expect(result).toContain('AX_IPC_TOKEN');
    expect(result).toContain('/internal/ipc');
    expect(result).toContain('tool_batch');
  });

  it('handles stdin piping', () => {
    const result = generateCLI('linear', [
      { name: 'list_teams', description: 'List teams', inputSchema: { type: 'object', properties: {} } },
    ]);
    expect(result).toContain('stdin');
    expect(result).toContain('JSON.parse');
  });
});
