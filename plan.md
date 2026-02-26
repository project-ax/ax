# Plan: LLM Tool Call Optimization

## Problem Statement

AX currently sends **all 25 IPC tools** on every LLM call regardless of context. Combined with runner-local tools (4 for pi-agent-core, ~25 for pi-coding-agent), this means up to **50 tools per call** — hitting the IPC schema hard limit. Every extra tool consumes input tokens and degrades the model's tool-selection accuracy.

The system also **duplicates tool descriptions** across three layers (TOOL_CATALOG TypeBox → MCP Zod → system prompt prose) without full sync validation, and sends enterprise-only tools (workspace, governance) even when enterprise features are disabled.

## Goals

1. **Context-aware tool filtering** — only send tools relevant to the current session
2. **Description tightening** — reduce token overhead without losing clarity
3. **Enterprise tool gating** — exclude workspace/governance tools when those features are off
4. **Maintain all existing invariants** — sync tests, IPC schemas, MCP parity, security boundaries

## Non-Goals

- Tool consolidation (merging memory_* into one tool) — too risky for model compatibility
- Two-stage LLM routing — premature until tool count exceeds ~40
- Dynamic runtime tool loading — violates SC-SEC-002 static allowlist

---

## Architecture

### New concept: `ToolCategory` and `ToolFilter`

Add a **category tag** to each `ToolSpec` and a **filter function** that selects tools based on `PromptContext`. The filter runs in all three consumers (ipc-tools.ts, pi-session.ts, mcp-server.ts) so the tool list sent to the LLM matches the tools actually available.

```
ToolSpec.category: 'core' | 'memory' | 'web' | 'identity' | 'scheduler' | 'skills' | 'delegation' | 'workspace' | 'governance'
```

Filter rules:
- `core`: always included (memory_query, memory_write, web_fetch, web_search, audit_query)
- `identity`: always included (identity_write, user_write)
- `memory`: always included (memory_read, memory_delete, memory_list)
- `scheduler`: included when heartbeat content exists (`ctx.identityFiles.heartbeat` is non-empty)
- `skills`: included when skills are loaded (`ctx.skills.length > 0`)
- `delegation`: always included (single tool, low overhead)
- `workspace`: included only when `ctx.hasWorkspaceTiers === true`
- `governance`: included only when `ctx.hasGovernance === true`

This aligns tool visibility with the existing prompt module `shouldInclude()` logic — if the HeartbeatModule is excluded, the scheduler tools are also excluded.

---

## Changes by File

### 1. `src/agent/tool-catalog.ts`

**Add `category` field to `ToolSpec`:**

```typescript
export type ToolCategory =
  | 'memory' | 'web' | 'audit' | 'identity'
  | 'scheduler' | 'skills' | 'delegation'
  | 'workspace' | 'governance';

export interface ToolSpec {
  name: string;
  label: string;
  description: string;
  parameters: TSchema;
  injectUserId?: boolean;
  category: ToolCategory;
}
```

Tag each tool in TOOL_CATALOG with its category. No description changes yet.

**Add `filterTools()` function:**

```typescript
export interface ToolFilterContext {
  hasHeartbeat: boolean;       // identityFiles.heartbeat is non-empty
  hasSkills: boolean;          // skills.length > 0
  hasWorkspaceTiers: boolean;  // enterprise workspace tiers enabled
  hasGovernance: boolean;      // enterprise governance enabled
}

export function filterTools(ctx: ToolFilterContext): readonly ToolSpec[] {
  return TOOL_CATALOG.filter(spec => {
    switch (spec.category) {
      case 'scheduler':  return ctx.hasHeartbeat;
      case 'skills':     return ctx.hasSkills;
      case 'workspace':  return ctx.hasWorkspaceTiers;
      case 'governance': return ctx.hasGovernance;
      default:           return true;  // core tools always included
    }
  });
}
```

**Tighten tool descriptions** — trim each to ≤120 chars where possible. The detailed behavioral guidance lives in the prompt modules, not in the tool `description` field. Specific changes:

| Tool | Current desc length | Target |
|------|-------------------|--------|
| `identity_write` | ~270 chars | ~120 chars — remove "Auto-applied in clean sessions..." (that's in IdentityModule) |
| `user_write` | ~200 chars | ~100 chars — remove "Auto-applied in clean..." |
| `skill_propose` | ~270 chars | ~100 chars — remove screening details (that's in SkillsModule) |
| `agent_delegate` | ~220 chars | ~120 chars — remove runner list (that's in DelegationModule) |
| `workspace_write` | ~180 chars | ~80 chars |
| `identity_propose` | ~200 chars | ~100 chars |

Leave short descriptions (<100 chars) untouched.

### 2. `src/agent/ipc-tools.ts`

**Accept a `ToolFilterContext` and use `filterTools()`:**

```typescript
export function createIPCTools(
  client: IPCClient,
  opts?: IPCToolsOptions & { filter?: ToolFilterContext },
): AgentTool[] {
  const catalog = opts?.filter ? filterTools(opts.filter) : TOOL_CATALOG;
  return catalog.map(spec => ({ ... }));
}
```

### 3. `src/agent/runners/pi-session.ts`

**Pass filter context to `createIPCToolDefinitions()`:**

```typescript
function createIPCToolDefinitions(
  client: IPCClient,
  opts?: IPCToolDefsOptions & { filter?: ToolFilterContext },
): ToolDefinition[] {
  const catalog = opts?.filter ? filterTools(opts.filter) : TOOL_CATALOG;
  return catalog.map(spec => ({ ... }));
}
```

Build the filter context from agent config/prompt context in `runPiSession()`.

### 4. `src/agent/mcp-server.ts`

**Accept a `ToolFilterContext` and filter the manually-defined tools:**

The MCP server defines tools manually with Zod schemas. Add a name-based filter:

```typescript
export function createIPCMcpServer(
  client: IPCClient,
  opts?: MCPServerOptions & { filter?: ToolFilterContext },
): McpSdkServerConfigWithInstance {
  const allowedNames = new Set(
    (opts?.filter ? filterTools(opts.filter) : TOOL_CATALOG).map(s => s.name)
  );

  const allTools = [ /* existing tool() definitions */ ];
  const filteredTools = allTools.filter(t => allowedNames.has(t.name));
  // ... pass filteredTools to createSdkMcpServer
}
```

This requires a small refactor: move the `tool()` calls into an array, then filter it, then pass to `createSdkMcpServer`.

### 5. `src/agent/runner.ts` (pi-agent-core)

**Build filter context from AgentConfig and pass to `createIPCTools()`:**

```typescript
const filter: ToolFilterContext = {
  hasHeartbeat: !!identityFiles.heartbeat?.trim(),
  hasSkills: skills.length > 0,
  hasWorkspaceTiers: !!(config.agentWorkspace || config.userWorkspace || config.scratchDir),
  hasGovernance: config.profile === 'paranoid' || config.profile === 'balanced',
};
const ipcTools = createIPCTools(client, { userId: config.userId, filter });
```

This requires loading identity files and skills **before** creating tools — currently done in `buildSystemPrompt()`. Factor out a shared `buildToolFilterContext()` helper.

### 6. `src/agent/runners/claude-code.ts`

**Build filter context and pass to `createIPCMcpServer()`:**

Same pattern — derive ToolFilterContext from the already-loaded prompt context.

### 7. `src/agent/agent-setup.ts`

**Export a helper to build ToolFilterContext from AgentConfig:**

```typescript
export function buildToolFilterContext(config: AgentConfig): ToolFilterContext {
  const identityFiles = loadIdentityFiles({ agentDir: config.agentDir, userId: config.userId });
  const skills = loadSkills(config.skills);
  return {
    hasHeartbeat: !!identityFiles.heartbeat?.trim(),
    hasSkills: skills.length > 0,
    hasWorkspaceTiers: !!(config.agentWorkspace || config.userWorkspace || config.scratchDir),
    hasGovernance: config.profile === 'paranoid' || config.profile === 'balanced',
  };
}
```

Note: this loads identity files twice (once for filter, once for prompt). To avoid this, refactor `buildSystemPrompt()` to also return the filter context and loaded data. The prompt build already loads both — just expose them.

**Preferred approach**: refactor `buildSystemPrompt()` to return `{ systemPrompt, metadata, filterContext }`, deriving the ToolFilterContext from the same loaded data it already has.

### 8. Tests

**`tests/agent/tool-catalog.test.ts`:**
- Update "exports exactly 25 tools" assertion
- Add tests for `filterTools()`:
  - All flags false → excludes scheduler, skills, workspace, governance tools
  - All flags true → returns full catalog
  - Individual flag tests (hasHeartbeat=true includes scheduler, etc.)
- Add test: every tool has a valid `category` value

**`tests/agent/tool-catalog-sync.test.ts`:**
- Update sync tests to account for filtering:
  - MCP sync test: verify filtered tools match (pass full context to get all tools)
  - System prompt sync test: verify that excluded tools are NOT documented in excluded modules (and vice versa) — this is already the case via `shouldInclude()` but worth asserting
- Add test: `filterTools` categories align with prompt module `shouldInclude()` — when a category is excluded, the corresponding prompt module is also excluded

**`tests/agent/ipc-tools.test.ts`:**
- Add test: createIPCTools with filter context returns correct subset
- Add test: createIPCTools without filter returns full catalog (backward compat)

**New test: `tests/agent/tool-filter.test.ts`:**
- Dedicated test file for filterTools and ToolFilterContext
- Tests all combination of flags
- Tests that no tool is "orphaned" (every category has at least one tool)

### 9. `src/agent/mcp-server.ts` — Description sync

**Tighten MCP descriptions to match trimmed TOOL_CATALOG descriptions.** These must stay in sync per the existing sync test (which checks names and parameter keys but not descriptions). After trimming, manually verify each MCP description matches.

---

## Execution Order

1. **Add `category` to ToolSpec and tag all tools** (`tool-catalog.ts`)
2. **Add `filterTools()` and `ToolFilterContext`** (`tool-catalog.ts`)
3. **Tighten descriptions** in TOOL_CATALOG + matching MCP descriptions
4. **Refactor `buildSystemPrompt()`** to also return ToolFilterContext (`agent-setup.ts`)
5. **Wire filtering into ipc-tools.ts** (pi-agent-core consumer)
6. **Wire filtering into pi-session.ts** (pi-coding-agent consumer)
7. **Wire filtering into mcp-server.ts** (claude-code consumer)
8. **Wire filtering into runner.ts and claude-code.ts** (pass context through)
9. **Write tests** — tool-catalog, tool-filter, ipc-tools, sync tests
10. **Run full test suite**, fix any breakage

---

## Impact Analysis

### Token savings (estimated per LLM call)

| Scenario | Before (tools) | After (tools) | Δ tools | Est. token savings |
|----------|:-:|:-:|:-:|:-:|
| No heartbeat, no skills, no enterprise | 25 | 14 | -11 | ~800-1200 tokens |
| With heartbeat, no skills, no enterprise | 25 | 18 | -7 | ~500-800 tokens |
| Full enterprise setup | 25 | 25 | 0 | ~200 (from trimmed descriptions) |

These savings compound: AX makes multiple LLM calls per session (typically 3-15). At 10 calls/session, that's 5,000-12,000 input tokens saved — meaningful for cost and latency.

### Description trimming savings

Trimming 6 verbose descriptions by ~100-170 chars each saves ~600-1000 chars → ~150-250 tokens per call, regardless of filtering.

### Risk assessment

- **Low risk**: Category tags are additive (new field, backward compatible)
- **Low risk**: filterTools is opt-in (callers that don't pass filter get full catalog)
- **Medium risk**: MCP server refactor (moving tools into an array then filtering). Sync test catches regressions.
- **Low risk**: Description trimming — behavioral guidance lives in prompt modules, not tool descriptions

### What could break

- Tests that assert exact tool count (25) — need updating
- Tests that assume all tools are always present — need filter context
- MCP server structure change — sync test validates

---

## Security Considerations

- **No new dynamic imports** — filterTools uses category tags from the static catalog
- **No config-driven tool paths** — respects SC-SEC-002
- **Credentials never exposed** — filter context contains only boolean flags
- **Taint tagging unaffected** — filter happens before tool execution, not during
- **IPC validation unchanged** — Zod schemas still validate at host boundary

---

## Files Modified

| File | Change |
|------|--------|
| `src/agent/tool-catalog.ts` | Add category, filterTools(), tighten descriptions |
| `src/agent/ipc-tools.ts` | Accept filter context |
| `src/agent/mcp-server.ts` | Accept filter context, refactor to filterable array |
| `src/agent/runner.ts` | Pass filter context to createIPCTools |
| `src/agent/runners/pi-session.ts` | Pass filter context to createIPCToolDefinitions |
| `src/agent/runners/claude-code.ts` | Pass filter context to createIPCMcpServer |
| `src/agent/agent-setup.ts` | Return ToolFilterContext from buildSystemPrompt |
| `tests/agent/tool-catalog.test.ts` | Update count, add category/filter tests |
| `tests/agent/tool-catalog-sync.test.ts` | Update for filtering awareness |
| `tests/agent/tool-filter.test.ts` | New: dedicated filter tests |
| `tests/agent/ipc-tools.test.ts` | Add filtered tool creation tests |
