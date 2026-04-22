import { minimatch } from 'minimatch';
import type { CatalogTool } from '../types.js';
import { toSnakeCase } from '../name-utils.js';

interface McpToolInput {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface BuildMcpCatalogToolsInput {
  skill: string;
  server: string;
  tools: McpToolInput[];
  include?: string[];
  exclude?: string[];
}

/**
 * Filters against the BARE MCP tool name (`t.name`), NOT the catalog-
 * prefixed name — skill authors write `include: ['list_*']` to match
 * `list_teams`, not `mcp_<skill>_list_teams`. Matches the OpenAPI adapter's
 * convention.
 */
export function buildMcpCatalogTools(input: BuildMcpCatalogToolsInput): CatalogTool[] {
  const filtered = input.tools.filter(t => {
    if (input.include?.length && !input.include.some(g => minimatch(t.name, g))) return false;
    if (input.exclude?.length && input.exclude.some(g => minimatch(t.name, g))) return false;
    return true;
  });

  // Sanitize skill + tool name so the catalog entry satisfies the schema
  // regex `^(mcp|api)_[a-z0-9_]+$` AND the Anthropic provider's 64-char
  // function-name limit. Real-world examples that break without this:
  //   - skill `google-workspace-slides` → hyphens rejected
  //   - MCP tool `presentations.pages.listAll` → dots + camelCase rejected
  // The `dispatch.toolName` keeps the ORIGINAL name — that's what the MCP
  // server knows; only the catalog-facing name is sanitized.
  const skillSnake = toSnakeCase(input.skill);

  return filtered.map(t => ({
    name: `mcp_${skillSnake}_${toSnakeCase(t.name)}`,
    skill: input.skill,
    summary: t.description ?? t.name,
    schema: t.inputSchema ?? { type: 'object' },
    dispatch: { kind: 'mcp' as const, server: input.server, toolName: t.name },
  }));
}
