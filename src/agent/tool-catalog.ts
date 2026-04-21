/**
 * Shared IPC tool catalog — single source of truth for tool metadata.
 *
 * TypeBox consumers (ipc-tools.ts, pi-session.ts) derive their tool arrays
 * from this catalog. The Zod consumer (mcp-server.ts) imports descriptions
 * via getToolDescription() and defines only Zod schemas + execution logic.
 *
 * Tools are consolidated: each entry may represent multiple IPC actions
 * selected via a `type` discriminator parameter. The actionMap / singletonAction
 * fields tell the execute layer which IPC action to dispatch.
 */

import { Type, type TSchema } from '@sinclair/typebox';

export type ToolCategory =
  | 'memory' | 'web' | 'audit'
  | 'scheduler' | 'delegation'
  | 'workspace' | 'sandbox';

export interface ToolSpec {
  name: string;
  label: string;
  description: string;
  parameters: TSchema;
  category: ToolCategory;
  /** When true, execute() must inject userId into IPC call params. */
  injectUserId?: boolean;
  /** Custom IPC call timeout in ms. Tools that spawn subprocesses (agent_delegate)
   *  or call slow external APIs need longer than the 30s default. */
  timeoutMs?: number;
  /** Maps type discriminator values to IPC action names. Present on multi-op tools. */
  actionMap?: Record<string, string>;
  /** IPC action name for singleton tools (no type param). */
  singletonAction?: string;
}

export const TOOL_CATALOG: readonly ToolSpec[] = [
  // ── Memory ──
  {
    name: 'memory',
    label: 'Memory',
    description:
      'Store, search, read, delete, and list memory entries.\n\nUse `type` to select:\n' +
      '- write: Store a memory entry with scope, content, and optional tags\n' +
      '- query: Search entries by scope and optional query string\n' +
      '- read: Read a specific entry by ID\n' +
      '- delete: Delete an entry by ID\n' +
      '- list: List entries in a scope',
    parameters: Type.Union([
      Type.Object({
        type: Type.Literal('write'),
        scope: Type.String(),
        content: Type.String(),
        tags: Type.Optional(Type.Array(Type.String())),
      }),
      Type.Object({
        type: Type.Literal('query'),
        scope: Type.String(),
        query: Type.Optional(Type.String()),
        limit: Type.Optional(Type.Number()),
        tags: Type.Optional(Type.Array(Type.String())),
      }),
      Type.Object({
        type: Type.Literal('read'),
        id: Type.String(),
      }),
      Type.Object({
        type: Type.Literal('delete'),
        id: Type.String(),
      }),
      Type.Object({
        type: Type.Literal('list'),
        scope: Type.String(),
        limit: Type.Optional(Type.Number()),
      }),
    ]),
    category: 'memory',
    actionMap: {
      write: 'memory_write',
      query: 'memory_query',
      read: 'memory_read',
      delete: 'memory_delete',
      list: 'memory_list',
    },
  },

  // ── Web ──
  {
    name: 'web',
    label: 'Web',
    description:
      'Access the web. Pick ONE type:\n\n' +
      'type="search": Find information when you do NOT have a URL. Requires `query` (plain text, NOT a URL). Returns a list of relevant URLs and snippets.\n' +
      'type="extract": Read a webpage when you HAVE a URL and want the text content. Requires `url`. Returns cleaned readable text (like reader mode). Best for articles, docs, blog posts.\n' +
      'type="fetch": Make a raw HTTP request when you HAVE a URL and need the exact response (HTML, JSON, headers). Requires `url`. Best for APIs and machine-readable data.\n\n' +
      'RULES:\n' +
      '- If you have a URL and want to read it → use "extract" (not "search")\n' +
      '- If you need to find something and have no URL → use "search"\n' +
      '- If you need raw JSON/HTML or custom headers → use "fetch"\n' +
      '- NEVER put a URL in the `query` field. URLs go in `url` only.',
    parameters: Type.Union([
      Type.Object({
        type: Type.Literal('fetch'),
        url: Type.String({ description: 'The full URL to fetch (e.g. "https://api.example.com/data"). Required for type="fetch".' }),
        method: Type.Optional(Type.Union([Type.Literal('GET'), Type.Literal('HEAD')])),
        headers: Type.Optional(Type.Record(Type.String(), Type.String())),
        timeoutMs: Type.Optional(Type.Number()),
      }),
      Type.Object({
        type: Type.Literal('extract'),
        url: Type.String({ description: 'The full URL of the webpage to extract text from (e.g. "https://example.com/article"). Required for type="extract".' }),
      }),
      Type.Object({
        type: Type.Literal('search'),
        query: Type.String({ description: 'Search query in plain text (e.g. "how to parse JSON in Python"). Must NOT be a URL. Required for type="search".' }),
        maxResults: Type.Optional(Type.Number({ description: 'Maximum number of search results to return (default: 5)' })),
      }),
    ]),
    category: 'web',
    actionMap: {
      fetch: 'web_fetch',
      extract: 'web_extract',
      search: 'web_search',
    },
  },

  // ── Scheduler ──
  {
    name: 'scheduler',
    label: 'Scheduler',
    description:
      'Schedule recurring and one-shot tasks.\n\nUse `type` to select:\n' +
      '- add_cron: Schedule a recurring task using a 5-field cron expression\n' +
      '- run_at: Schedule a one-shot task at a specific date/time\n' +
      '- remove: Remove a previously scheduled cron job by its ID\n' +
      '- list: List all currently scheduled cron jobs',
    parameters: Type.Union([
      Type.Object({
        type: Type.Literal('add_cron'),
        schedule: Type.String({ description: 'Cron expression, e.g. "0 9 * * 1" for 9am every Monday' }),
        prompt: Type.String({ description: 'The instruction/prompt to execute on each trigger' }),
        maxTokenBudget: Type.Optional(Type.Number({ description: 'Optional max token budget per execution' })),
      }),
      Type.Object({
        type: Type.Literal('run_at'),
        datetime: Type.String({ description: 'ISO 8601 datetime in local time (no Z suffix), e.g. "2026-02-21T19:30:00". Use the current time from your system prompt to compute relative times.' }),
        prompt: Type.String({ description: 'The instruction/prompt to execute' }),
        maxTokenBudget: Type.Optional(Type.Number({ description: 'Optional max token budget for execution' })),
      }),
      Type.Object({
        type: Type.Literal('remove'),
        id: Type.String({ description: 'The job ID to remove' }),
      }),
      Type.Object({
        type: Type.Literal('list'),
      }),
    ]),
    category: 'scheduler',
    actionMap: {
      add_cron: 'scheduler_add_cron',
      run_at: 'scheduler_run_at',
      remove: 'scheduler_remove_cron',
      list: 'scheduler_list_jobs',
    },
  },

  // ── Workspace ──
  {
    name: 'save_artifact',
    label: 'Save Artifact',
    description:
      'Save a file as a downloadable artifact for the user. Use this when the user asks you to create, generate, or save a file they can download (documents, reports, poems, code files, etc.). Files saved here are immediately available for download in the chat UI.',
    parameters: Type.Object({
      tier: Type.String({ description: '"agent", "user", or "session"' }),
      path: Type.String({ description: 'Filename with extension (e.g. "report.md", "poem.txt")' }),
      content: Type.String({ description: 'File content to write' }),
    }),
    category: 'workspace',
    singletonAction: 'save_artifact',
  },


  // ── Audit (singleton) ──
  {
    name: 'audit',
    label: 'Query Audit Log',
    description: 'Query the audit log with filters.',
    parameters: Type.Object({
      action: Type.Optional(Type.String()),
      sessionId: Type.Optional(Type.String()),
      limit: Type.Optional(Type.Number()),
    }),
    category: 'audit',
    singletonAction: 'audit_query',
  },

  // ── Agent ──
  {
    name: 'agent',
    label: 'Agent',
    description:
      'Delegate tasks to sub-agents and collect results.\n\nUse `type` to select:\n' +
      '- delegate: Launch a sub-agent in its own sandbox (blocks by default, or fire-and-forget with wait: false)\n' +
      '- collect: Collect results from fire-and-forget delegates launched with wait: false',
    parameters: Type.Union([
      Type.Object({
        type: Type.Literal('delegate'),
        task: Type.String({ description: 'The task description for the sub-agent' }),
        context: Type.Optional(Type.String({ description: 'Background context the sub-agent should know' })),
        runner: Type.Optional(Type.String({ description: '"pi-coding-agent" or "claude-code"' })),
        model: Type.Optional(Type.String({ description: 'Model ID override for the sub-agent (e.g. "claude-sonnet-4-5-20250929")' })),
        maxTokens: Type.Optional(Type.Number({ description: 'Max tokens for the sub-agent response' })),
        timeoutSec: Type.Optional(Type.Number({ description: 'Timeout in seconds (5-600)' })),
        wait: Type.Optional(Type.Boolean({ description: 'If false, launch in background and return immediately with a handleId. Default: true (blocking).' })),
        resourceTier: Type.Optional(Type.String({ description: '"default" (1 vCPU, 256MB) or "heavy" (4 vCPU, 2GB) — request more resources for intensive tasks' })),
      }),
      Type.Object({
        type: Type.Literal('collect'),
        handleIds: Type.Array(Type.String({ description: 'Handle IDs returned by delegate with wait: false' })),
        timeoutMs: Type.Optional(Type.Number({ description: 'Timeout in milliseconds (default: 300000 = 5 min)' })),
      }),
    ]),
    category: 'delegation',
    timeoutMs: 600_000,
    actionMap: {
      delegate: 'agent_delegate',
      collect: 'agent_collect',
    },
  },


  // ── Sandbox (singleton tools for bash/file ops) ──
  {
    name: 'bash',
    label: 'Run Command',
    description: 'Execute a bash command in the workspace directory.',
    parameters: Type.Object({
      command: Type.String({ description: 'The bash command to execute' }),
    }),
    category: 'sandbox',
    timeoutMs: 180_000,
    singletonAction: 'sandbox_bash',
  },
  {
    name: 'read_file',
    label: 'Read File',
    description: 'Read the contents of a file in the workspace.',
    parameters: Type.Object({
      path: Type.String({ description: 'Relative path to the file' }),
    }),
    category: 'sandbox',
    singletonAction: 'sandbox_read_file',
  },
  {
    name: 'write_file',
    label: 'Write File',
    description: 'Write content to a file in the workspace. Files written to artifacts/ (e.g. "artifacts/poem.md") are automatically uploaded and made available for download in the chat UI.',
    parameters: Type.Object({
      path: Type.String({ description: 'Relative path to the file. Use "artifacts/" prefix for downloadable files.' }),
      content: Type.String({ description: 'Content to write' }),
    }),
    category: 'sandbox',
    singletonAction: 'sandbox_write_file',
  },
  {
    name: 'edit_file',
    label: 'Edit File',
    description: 'Replace a string in a file.',
    parameters: Type.Object({
      path: Type.String({ description: 'Relative path to the file' }),
      old_string: Type.String({ description: 'Text to find' }),
      new_string: Type.String({ description: 'Replacement text' }),
    }),
    category: 'sandbox',
    singletonAction: 'sandbox_edit_file',
  },
  {
    // `skill_write` — the ONLY authoring path for .ax/skills/<name>/SKILL.md.
    // write_file and edit_file refuse SKILL.md paths and point here. Direct
    // file tools still work for everything else under .ax/skills/ (scripts,
    // reference docs, deletes).
    name: 'skill_write',
    label: 'Create or Update Skill',
    description:
      'Create or update a skill at `.ax/skills/<name>/SKILL.md`. Use this ' +
      'instead of write_file when authoring a skill — it takes structured ' +
      'frontmatter fields and runs the host Zod validator, so mistakes (missing ' +
      'description, `authType: apiKey` instead of `api_key`, nested credential ' +
      'objects, etc.) come back as actionable errors that name the offending ' +
      'field AND show what you actually wrote, instead of the skill silently ' +
      'landing in the repo as invalid.\n\n' +
      'Replaces the file atomically. To update an existing skill, read the old ' +
      'SKILL.md first with `read_file`, then call skill_write with the full new ' +
      'spec — partial frontmatter edits are not supported.',
    parameters: Type.Object({
      name: Type.String({
        description:
          'Skill directory name. Must match [a-zA-Z0-9][a-zA-Z0-9._-]* and ' +
          'will be used as the `<name>` segment in `.ax/skills/<name>/SKILL.md`. ' +
          'Must equal the `name` field in the frontmatter the host parses.',
      }),
      description: Type.String({
        minLength: 1,
        maxLength: 2000,
        description:
          'Required. When and why to use this skill — concrete trigger ' +
          'phrases the next-turn agent will read. Do not leave this empty.',
      }),
      source: Type.Optional(Type.Object({
        url: Type.String({ description: 'Provenance URL' }),
        version: Type.Optional(Type.String()),
      })),
      credentials: Type.Optional(Type.Array(Type.Object({
        envName: Type.String({
          description:
            'SCREAMING_SNAKE_CASE env var name (e.g. "LINEAR_API_KEY"). ' +
            'Regex: ^[A-Z][A-Z0-9_]{1,63}$',
        }),
        authType: Type.Union([Type.Literal('api_key'), Type.Literal('oauth')], {
          description:
            'EXACTLY "api_key" or "oauth" — snake_case literals. Not ' +
            '"apiKey", not "API_KEY", not "bearer". These are the only two values.',
        }),
        scope: Type.Optional(Type.Union([Type.Literal('user'), Type.Literal('agent')], {
          description: '"user" (per-user credential, default) or "agent" (shared across users of this agent).',
        })),
        oauth: Type.Optional(Type.Object({
          provider: Type.String(),
          clientId: Type.String(),
          authorizationUrl: Type.String({ description: 'Must start with https://' }),
          tokenUrl: Type.String({ description: 'Must start with https://' }),
          scopes: Type.Optional(Type.Array(Type.String())),
        }, { description: 'Required ONLY when authType is "oauth".' })),
      }), {
        description:
          'Credentials this skill needs. Each entry defines an env var name ' +
          'and its auth mechanism. Omit this field entirely when the skill has no secrets.',
      })),
      mcpServers: Type.Optional(Type.Array(Type.Object({
        name: Type.String({ description: 'Arbitrary short name for the server entry.' }),
        url: Type.String({ description: 'Must start with https://' }),
        credential: Type.Optional(Type.String({
          description:
            'BARE envName STRING — a reference to an entry in credentials[] above. ' +
            'NOT a nested {envName, authType, scope} object. Example: "LINEAR_API_KEY".',
        })),
        transport: Type.Optional(Type.Union([Type.Literal('http'), Type.Literal('sse')], {
          description: 'Transport. Inferred from URL path if omitted (/sse → sse, else http).',
        })),
      }), {
        description:
          'Remote MCP server endpoints. Omit entirely if the service has no MCP — ' +
          'do not invent a fake entry to "hold" a credential.',
      })),
      domains: Type.Optional(Type.Array(Type.String(), {
        description:
          'Additional hostnames the skill needs the proxy to allow. Plain hostnames only — ' +
          'no scheme, no path. Leading wildcards like "*.foo.com" allowed.',
      })),
      body: Type.String({
        description:
          'Markdown body of the SKILL.md (everything after the YAML frontmatter). ' +
          'Should include "## When to use", "## When pending", and "## How to use" sections.',
      }),
    }),
    category: 'workspace',
    singletonAction: 'skill_write',
  },
  {
    name: 'grep',
    label: 'Search File Contents',
    description:
      'Search file contents using regex patterns. Returns matching lines with context.\n\n' +
      'Use this instead of running grep/rg via bash — it limits output to protect your context window.\n\n' +
      'Parameters:\n' +
      '- pattern: Regex pattern to search for (required)\n' +
      '- path: Directory to search in, relative to workspace (default: ".")\n' +
      '- glob: File filter pattern, e.g. "*.ts", "*.{js,jsx}" (optional)\n' +
      '- max_results: Maximum matching lines to return (default: 100)\n' +
      '- include_line_numbers: Show line numbers (default: true)\n' +
      '- context_lines: Lines of context around each match (default: 0)',
    parameters: Type.Object({
      pattern: Type.String({ description: 'Regex pattern to search for' }),
      path: Type.Optional(Type.String({ description: 'Directory to search in, relative to workspace (default: ".")' })),
      glob: Type.Optional(Type.String({ description: 'File filter pattern, e.g. "*.ts", "*.{js,jsx}"' })),
      max_results: Type.Optional(Type.Number({ description: 'Maximum matching lines to return (default: 100)' })),
      include_line_numbers: Type.Optional(Type.Boolean({ description: 'Show line numbers (default: true)' })),
      context_lines: Type.Optional(Type.Number({ description: 'Lines of context around each match (default: 0)' })),
    }),
    category: 'sandbox',
    singletonAction: 'sandbox_grep',
  },
  {
    name: 'glob',
    label: 'Find Files',
    description:
      'Find files by name or path pattern. Returns matching file paths.\n\n' +
      'Use this instead of running find/ls via bash — it limits output to protect your context window.\n\n' +
      'Parameters:\n' +
      '- pattern: Glob pattern, e.g. "**/*.ts", "src/**/*.test.*" (required)\n' +
      '- path: Base directory, relative to workspace (default: ".")\n' +
      '- max_results: Maximum files to return (default: 100)',
    parameters: Type.Object({
      pattern: Type.String({ description: 'Glob pattern, e.g. "**/*.ts", "src/**/*.test.*"' }),
      path: Type.Optional(Type.String({ description: 'Base directory, relative to workspace (default: ".")' })),
      max_results: Type.Optional(Type.Number({ description: 'Maximum files to return (default: 100)' })),
    }),
    category: 'sandbox',
    singletonAction: 'sandbox_glob',
  },

  // ── Tool-dispatch meta-tools (indirect mode only) ──
  // `describe_tools` + `call_tool` are the unified tool-dispatch meta-tools
  // introduced in Phase 3 of the tool-dispatch-unification work. They are
  // filtered out of the catalog in `direct` mode (see filterTools).
  //
  // Both are structural pass-throughs — the agent forwards args to the host
  // via IPC, and the host consults the per-turn catalog (built from active
  // skills) to resolve the dispatch.
  {
    name: 'describe_tools',
    label: 'Describe Tools',
    description:
      "Look up catalog tools. Two modes:\n\n" +
      "• `names: []` (empty array) — DIRECTORY MODE: returns every catalog tool " +
      "(name + summary, no schema). Use this when you don't know the tool name " +
      "yet — one call and you have the full list, no name-guessing.\n\n" +
      "• `names: ['mcp_foo_bar', ...]` — SCHEMA MODE: returns full JSON schemas " +
      "for the named tools. Call this after the directory mode narrowed you to " +
      "the 1-3 tools you'll actually use.\n\n" +
      "Always returns `{tools: [{name, summary, schema}], unknown: [names_not_found]}`. " +
      "In schema mode, every returned schema includes an optional `_select` (jq " +
      "projection) property injected by the host — pair it with `call_tool` to " +
      "keep the response in your context small.",
    parameters: Type.Object({
      names: Type.Array(Type.String(), {
        description:
          'Pass [] to list every catalog tool (directory mode), or an array of ' +
          'tool names to fetch full schemas for those tools (schema mode).',
      }),
    }),
    category: 'delegation',
    singletonAction: 'describe_tools',
  },
  {
    name: 'call_tool',
    label: 'Call Tool',
    description:
      "Invoke a catalog tool by name with structured arguments. Use after " +
      "optionally consulting `describe_tools` for the schema. Pass a jq " +
      "filter via `args._select` to project the response server-side — " +
      "useful for keeping your context small. Returns " +
      "`{result}` on success or `{error, kind}` on failure " +
      "(`unknown_tool` | `unsupported_dispatch` | `dispatch_failed` | `select_failed`).",
    parameters: Type.Object({
      tool: Type.String({ description: 'The catalog tool name to invoke.' }),
      args: Type.Record(Type.String(), Type.Unknown(), {
        description: 'Structured arguments matching the tool schema.',
      }),
    }),
    category: 'delegation',
    singletonAction: 'call_tool',
  },

  // ── execute_script REMOVED (Tasks 11 + 12) ──
  // Retired in favor of the `tool` CLI shim model
  // (`mcp_linear_get_team --query=Product | jq -r .id` from the `bash` tool).
  // Task 11 removed the catalog entry; Task 12 deleted the handler, preamble,
  // and /tmp/ax-results spill protocol.
] as const;

/** All tool names, derived from the catalog. */
export const TOOL_NAMES: string[] = TOOL_CATALOG.map(s => s.name);

/** Look up a tool's description by name. Single source of truth for both TypeBox and Zod consumers. */
export function getToolDescription(name: string): string {
  const spec = TOOL_CATALOG.find(s => s.name === name);
  if (!spec) throw new Error(`Unknown tool: ${name}`);
  return spec.description;
}

/** Extract parameter key names for a given tool (for sync tests). */
export function getToolParamKeys(name: string): string[] {
  const spec = TOOL_CATALOG.find(s => s.name === name);
  if (!spec) throw new Error(`Unknown tool: ${name}`);
  const schema = spec.parameters as any;
  if (schema.anyOf) {
    // Union: collect all keys from all members, excluding 'type'
    const keys = new Set<string>();
    for (const member of schema.anyOf) {
      for (const key of Object.keys(member.properties ?? {})) {
        if (key !== 'type') keys.add(key);
      }
    }
    return [...keys];
  }
  return Object.keys(schema.properties ?? {});
}

// ── Context-aware tool filtering ──────────────────────────────────────
//
// Runners pass a ToolFilterContext derived from the same data the prompt
// builder uses. Categories excluded here match prompt modules excluded by
// their shouldInclude() — e.g., no governance config → no governance tools.

export interface ToolFilterContext {
  /** identityFiles.heartbeat is non-empty (used by prompt modules, not tool filtering) */
  hasHeartbeat: boolean;
  /** Tool-dispatch mode. `indirect` (default) exposes describe_tools + call_tool;
   *  `direct` filters them out (catalog tools are registered individually instead). */
  toolDispatchMode?: 'direct' | 'indirect';
}

/** Tool names that are only relevant in `indirect` tool-dispatch mode. */
const INDIRECT_ONLY_TOOLS = new Set(['describe_tools', 'call_tool']);

/**
 * Filter the catalog to tools relevant to the current session.
 *
 * In `direct` dispatch mode, the meta-tools `describe_tools` and `call_tool`
 * are hidden — the agent is expected to receive individual catalog tools as
 * first-class `tools[]` entries instead (Task 5.1). In `indirect` mode (the
 * default), both meta-tools are exposed so the LLM can discover schemas and
 * dispatch by name.
 */
export function filterTools(ctx: ToolFilterContext): readonly ToolSpec[] {
  const mode = ctx.toolDispatchMode ?? 'indirect';
  if (mode === 'indirect') return TOOL_CATALOG;
  return TOOL_CATALOG.filter(spec => !INDIRECT_ONLY_TOOLS.has(spec.name));
}

