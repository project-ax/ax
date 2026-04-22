import { describe, test, expect } from 'vitest';
import { buildMcpCatalogTools } from '../../../../src/host/tool-catalog/adapters/mcp.js';

describe('buildMcpCatalogTools', () => {
  test('maps MCP tools to CatalogTool entries', () => {
    const mcpTools = [
      { name: 'list_issues', description: 'List issues in a cycle', inputSchema: { type: 'object', properties: { team: { type: 'string' } } } },
      { name: 'get_team', description: 'Find a team by name', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
    ];
    const result = buildMcpCatalogTools({ skill: 'linear', server: 'linear', tools: mcpTools });
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({
      name: 'mcp_linear_list_issues',
      skill: 'linear',
      summary: 'List issues in a cycle',
      dispatch: { kind: 'mcp', server: 'linear', toolName: 'list_issues' },
    });
  });

  test('applies include glob filter', () => {
    const mcpTools = [
      { name: 'list_issues', inputSchema: { type: 'object' } },
      { name: 'delete_issue', inputSchema: { type: 'object' } },
    ];
    const result = buildMcpCatalogTools({ skill: 'linear', server: 'linear', tools: mcpTools, include: ['list_*'] });
    expect(result.map(r => r.name)).toEqual(['mcp_linear_list_issues']);
  });

  test('falls back to name when description is missing', () => {
    const mcpTools = [{ name: 'ping', inputSchema: { type: 'object' } }];
    const result = buildMcpCatalogTools({ skill: 'demo', server: 'demo', tools: mcpTools });
    expect(result[0].summary).toBe('ping');
  });

  // REGRESSION: CodeRabbit PR #185 flagged that real-world skill names
  // (hyphens) and MCP tool names (dots, camelCase) fail the catalog schema
  // regex `^(mcp|api)_[a-z0-9_]+$` at register time. The adapter now
  // sanitizes both via the shared `toSnakeCase` helper. `dispatch.toolName`
  // keeps the ORIGINAL — that's what the MCP server actually knows.
  test('sanitizes hyphenated skill names', () => {
    const mcpTools = [{ name: 'list_issues', inputSchema: { type: 'object' } }];
    const result = buildMcpCatalogTools({ skill: 'google-workspace-slides', server: 'gws', tools: mcpTools });
    expect(result[0].name).toBe('mcp_google_workspace_slides_list_issues');
    expect(result[0].skill).toBe('google-workspace-slides');
  });

  test('sanitizes tool names with dots (dotted MCP method style)', () => {
    const mcpTools = [{ name: 'presentations.pages.listAll', inputSchema: { type: 'object' } }];
    const result = buildMcpCatalogTools({ skill: 'slides', server: 'slides', tools: mcpTools });
    expect(result[0].name).toBe('mcp_slides_presentations_pages_list_all');
    // Dispatch keeps the original so the MCP server gets the real method name.
    expect(result[0].dispatch).toMatchObject({ toolName: 'presentations.pages.listAll' });
  });

  test('sanitizes camelCase tool names into snake_case', () => {
    const mcpTools = [{ name: 'getIssueByID', inputSchema: { type: 'object' } }];
    const result = buildMcpCatalogTools({ skill: 'linear', server: 'linear', tools: mcpTools });
    expect(result[0].name).toBe('mcp_linear_get_issue_by_id');
    expect(result[0].dispatch).toMatchObject({ toolName: 'getIssueByID' });
  });

  test('filters apply against the BARE tool name, not the catalog-prefixed name', () => {
    // Skill author writes `include: ['list_*']` expecting to match
    // `list_issues`, not `mcp_linear_mcp_list_issues`. Filter pre-dates
    // sanitization and must stay on the pre-sanitized bare name.
    const mcpTools = [
      { name: 'list_issues', inputSchema: { type: 'object' } },
      { name: 'getTeam', inputSchema: { type: 'object' } },
    ];
    const result = buildMcpCatalogTools({
      skill: 'linear-mcp',
      server: 'linear',
      tools: mcpTools,
      include: ['list_*'],
    });
    expect(result.map(r => r.name)).toEqual(['mcp_linear_mcp_list_issues']);
  });
});
