import { describe, test, expect } from 'vitest';
import { TOOL_CATALOG, TOOL_NAMES, getToolParamKeys, filterTools } from '../../src/agent/tool-catalog.js';
import type { ToolFilterContext, ToolCategory } from '../../src/agent/tool-catalog.js';

describe('tool-catalog', () => {
  test('exports exactly 15 tools (13 original + describe_tools + call_tool; execute_script removed in Task 11)', () => {
    expect(TOOL_CATALOG.length).toBe(15);
  });

  test('TOOL_NAMES matches TOOL_CATALOG names', () => {
    expect(TOOL_NAMES).toEqual(TOOL_CATALOG.map(s => s.name));
  });

  test('all tool names are unique', () => {
    const unique = new Set(TOOL_NAMES);
    expect(unique.size).toBe(TOOL_NAMES.length);
  });

  test('every tool has name, label, description, and parameters', () => {
    for (const spec of TOOL_CATALOG) {
      expect(spec.name).toBeTruthy();
      expect(spec.label).toBeTruthy();
      expect(spec.description).toBeTruthy();
      expect(spec.parameters).toBeDefined();
    }
  });

  test('no tools have injectUserId (identity tool removed)', () => {
    const withInject = TOOL_CATALOG.filter(s => s.injectUserId);
    expect(withInject.length).toBe(0);
  });

  test('getToolParamKeys returns correct keys for memory (union)', () => {
    const keys = getToolParamKeys('memory');
    expect(keys.sort()).toEqual(['content', 'id', 'limit', 'query', 'scope', 'tags']);
  });

  test('getToolParamKeys returns correct keys for web (union)', () => {
    const keys = getToolParamKeys('web');
    expect(keys.sort()).toEqual(['headers', 'maxResults', 'method', 'query', 'timeoutMs', 'url']);
  });

  test('getToolParamKeys returns correct keys for audit (singleton, direct object)', () => {
    const keys = getToolParamKeys('audit');
    expect(keys.sort()).toEqual(['action', 'limit', 'sessionId']);
  });

  test('getToolParamKeys throws for unknown tool', () => {
    expect(() => getToolParamKeys('nonexistent')).toThrow('Unknown tool: nonexistent');
  });

  test('contains all expected tool names', () => {
    const expected = [
      'memory', 'web', 'scheduler',
      'save_artifact',
      'audit', 'agent',
      'bash', 'read_file', 'write_file', 'edit_file',
      // Skill authoring — dedicated tool with structured args + validator.
      'skill_write',
      'grep', 'glob',
      // Tool-dispatch meta-tools (Task 3.5) — indirect mode only; filterTools
      // hides them in direct mode.
      'describe_tools', 'call_tool',
      // execute_script removed in Task 11 — replaced by tool CLI shims.
    ];
    expect(TOOL_NAMES).toEqual(expected);
  });

  test('save_artifact tool exists with singleton action', () => {
    const spec = TOOL_CATALOG.find(s => s.name === 'save_artifact');
    expect(spec).toBeDefined();
    expect(spec!.singletonAction).toBe('save_artifact');
    expect(spec!.category).toBe('workspace');
  });

  test('skill tool has been removed from catalog', () => {
    const skillTool = TOOL_CATALOG.find(t => t.name === 'skill');
    expect(skillTool).toBeUndefined();
  });

  test('request_credential tool has been removed from catalog', () => {
    expect(TOOL_CATALOG.find(t => t.name === 'request_credential')).toBeUndefined();
  });

  test('scheduler tool has correct param keys (union of all members)', () => {
    const keys = getToolParamKeys('scheduler');
    expect(keys.sort()).toEqual(['datetime', 'id', 'maxTokenBudget', 'prompt', 'schedule']);
  });

  test('every tool has a valid category', () => {
    const validCategories: ToolCategory[] = [
      'memory', 'web', 'audit',
      'scheduler', 'delegation',
      'workspace', 'sandbox',
    ];
    for (const spec of TOOL_CATALOG) {
      expect(validCategories, `"${spec.name}" has invalid category "${spec.category}"`).toContain(spec.category);
    }
  });

  test('execute_script is NOT in the catalog (Tasks 11 + 12 — replaced by tool CLI shims)', () => {
    // Catalog entry removed in Task 11; handler + preamble + spill protocol
    // removed in Task 12. The LLM now dispatches via the `tool` CLI shims.
    expect(TOOL_NAMES).not.toContain('execute_script');
    expect(TOOL_CATALOG.find(s => s.name === 'execute_script')).toBeUndefined();
  });

  test('every category has at least one tool', () => {
    const categories: ToolCategory[] = [
      'memory', 'web', 'audit',
      'scheduler', 'delegation',
      'workspace', 'sandbox',
    ];
    for (const cat of categories) {
      const tools = TOOL_CATALOG.filter(s => s.category === cat);
      expect(tools.length, `category "${cat}" has no tools`).toBeGreaterThan(0);
    }
  });
});

// ── filterTools ────────────────────────────────────────────────────────

describe('filterTools', () => {
  const ALL_FLAGS: ToolFilterContext = {
    hasHeartbeat: true,
  };

  const NO_FLAGS: ToolFilterContext = {
    hasHeartbeat: false,
  };

  test('all flags true returns full catalog', () => {
    const result = filterTools(ALL_FLAGS);
    expect(result.length).toBe(TOOL_CATALOG.length);
  });

  test('all flags false returns only always-on categories', () => {
    const result = filterTools(NO_FLAGS);
    // All tools are always-on now (governance removed)
    expect(result.length).toBe(TOOL_CATALOG.length);
  });

  test('scheduler tool is always present regardless of hasHeartbeat', () => {
    const result = filterTools(NO_FLAGS);
    const names = result.map(s => s.name);
    expect(names).toContain('scheduler');
  });

  test('skill tool is not in catalog', () => {
    const result = filterTools(NO_FLAGS);
    expect(result.find(s => s.name === 'skill')).toBeUndefined();
  });

  test('core tools are always present regardless of flags', () => {
    const result = filterTools(NO_FLAGS);
    const names = result.map(s => s.name);
    expect(names).toContain('memory');
    expect(names).toContain('web');
    expect(names).toContain('audit');
    expect(names).toContain('agent');
  });

  // ── tool-dispatch mode filtering (Task 3.5) ──────────────────────────

  test('indirect mode (default) exposes describe_tools + call_tool', () => {
    const result = filterTools({ hasHeartbeat: true, toolDispatchMode: 'indirect' });
    const names = result.map(s => s.name);
    expect(names).toContain('describe_tools');
    expect(names).toContain('call_tool');
  });

  test('omitted toolDispatchMode defaults to indirect', () => {
    const result = filterTools({ hasHeartbeat: true });
    const names = result.map(s => s.name);
    expect(names).toContain('describe_tools');
    expect(names).toContain('call_tool');
  });

  test('direct mode hides describe_tools + call_tool', () => {
    const result = filterTools({ hasHeartbeat: true, toolDispatchMode: 'direct' });
    const names = result.map(s => s.name);
    expect(names).not.toContain('describe_tools');
    expect(names).not.toContain('call_tool');
    // Other tools survive the filter
    expect(names).toContain('memory');
    expect(names).toContain('bash');
  });

  test('direct mode still includes all non-meta tools (catalog minus describe_tools + call_tool)', () => {
    const result = filterTools({ hasHeartbeat: true, toolDispatchMode: 'direct' });
    expect(result.length).toBe(TOOL_CATALOG.length - 2);
  });
});
