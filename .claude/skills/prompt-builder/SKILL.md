---
name: ax-prompt-builder
description: Use when modifying or extending the agent prompt system — adding modules, adjusting priority ordering, token budgeting, or bootstrap mode in src/agent/prompt/
---

## Overview

The prompt builder assembles the agent's system prompt from a pipeline of ordered, composable modules. Each module contributes a section (identity, security, skills, etc.) and can be conditionally included or dropped based on context and token budget. The builder handles bootstrap mode (first-run identity discovery) and graceful degradation when context is tight.

## Key Files

| File | Responsibility | Key Exports |
|---|---|---|
| `src/agent/prompt/builder.ts` | Orchestrates modules, builds final prompt | `PromptBuilder`, `PromptResult` |
| `src/agent/prompt/types.ts` | Core interfaces, PromptContext, IdentityFiles | `PromptContext`, `PromptModule`, `IdentityFiles`, `isBootstrapMode()` |
| `src/agent/prompt/base-module.ts` | Abstract base with token estimation | `BasePromptModule` |
| `src/agent/prompt/budget.ts` | Token allocation and module dropping | `allocateModules()` |
| `src/agent/prompt/modules/identity.ts` | SOUL, IDENTITY, USER, bootstrap | `IdentityModule` (priority 0) |
| `src/agent/prompt/modules/injection-defense.ts` | Injection attack recognition, taint display | `InjectionDefenseModule` (priority 5) |
| `src/agent/prompt/modules/security.ts` | Security boundaries and constraints | `SecurityModule` (priority 10) |
| `src/agent/prompt/modules/context.ts` | CONTEXT.md workspace injection | `ContextModule` (priority 60) |
| `src/agent/prompt/modules/skills.ts` | Skill markdown files | `SkillsModule` (priority 70) |
| `src/agent/prompt/modules/heartbeat.ts` | Heartbeat checklist and scheduler tools | `HeartbeatModule` (priority 80) |
| `src/agent/prompt/modules/runtime.ts` | Agent type, sandbox, profile | `RuntimeModule` (priority 90) |

## PromptContext

Every module receives a `PromptContext` with:

```typescript
interface PromptContext {
  agentType: string;          // 'pi-agent-core' | 'pi-coding-agent' | 'claude-code'
  workspace: string;          // Absolute path (sanitized by RuntimeModule)
  sandboxType: string;        // 'nsjail' | 'seatbelt' | 'subprocess' etc.
  profile: string;            // 'paranoid' | 'balanced' | 'yolo'
  taintRatio: number;         // 0.0–1.0
  taintThreshold: number;     // Profile-dependent threshold
  identityFiles: IdentityFiles;
  contextContent: string;     // CONTEXT.md content
  skills: string[];           // Loaded skill markdown strings
  maxTokens: number;          // Context window size
  historyTokens: number;      // Tokens consumed by conversation history
}
```

## Module Lifecycle

Each module extends `BasePromptModule` and implements:

1. **`name`** — Unique identifier (used in metadata)
2. **`priority`** — Sort order (0 = first, 100 = last)
3. **`optional`** — If `true`, budget system can drop it (default `false`)
4. **`shouldInclude(ctx)`** — Return `false` to skip entirely
5. **`render(ctx)`** — Return `string[]` of content lines
6. **`estimateTokens(ctx)`** — Default: `render().join('\n').length / 4`
7. **`renderMinimal(ctx)`** — Optional compressed version for tight budgets

## Module Priority Order

| Priority | Module | Required? | Bootstrap? |
|---|---|---|---|
| 0 | identity | Yes | Yes (shows BOOTSTRAP.md only) |
| 5 | injection-defense | No | Skipped |
| 10 | security | No | Skipped |
| 60 | context | Optional | Included if content exists |
| 70 | skills | Optional | Included if skills exist |
| 80 | heartbeat | Optional | Skipped |
| 90 | runtime | Optional | Skipped |

## Token Budget System

`allocateModules()` in `budget.ts`:

1. Reserve 4096 tokens for output
2. Available = `maxTokens - historyTokens - 4096`
3. Always include required modules (non-optional)
4. Add optional modules by priority until budget exhausted
5. If a module has `renderMinimal()`, try that before dropping entirely
6. Returns list of modules with their render mode (full or minimal)

`PromptBuilder.build(ctx)` returns `PromptResult`:
```typescript
interface PromptResult {
  content: string;        // Joined prompt text
  metadata: {
    moduleCount: number;
    tokenEstimates: Record<string, number>;
    buildTimeMs: number;
  };
}
```

## Bootstrap Mode

Detected by `isBootstrapMode(ctx)`: `identityFiles.soul` is empty AND `identityFiles.bootstrap` is non-empty.

In bootstrap mode:
- IdentityModule renders only BOOTSTRAP.md content
- InjectionDefense, Security, Heartbeat, Runtime modules all skip (`shouldInclude` returns false)
- Context and Skills still render if present
- Goal: guide agent through initial identity discovery before normal operation

## Common Tasks

**Adding a new prompt module:**
1. Create `src/agent/prompt/modules/<name>.ts` extending `BasePromptModule`
2. Set `name`, `priority` (0–100), and optionally `optional = true`
3. Implement `shouldInclude(ctx)` and `render(ctx)`
4. Optionally implement `renderMinimal(ctx)` for budget-constrained fallback
5. Register in `PromptBuilder` constructor in `builder.ts` (add to modules array)
6. Add test in `tests/agent/prompt/modules/<name>.test.ts`

**Modifying module priority:**
Change the `priority` field on the module class. Lower numbers render earlier in the prompt.

**Adding fields to PromptContext:**
1. Add the field to `PromptContext` in `src/agent/prompt/types.ts`
2. Update callers that construct `PromptContext` (in `runner.ts` and `pi-session.ts`)
3. Use the field in your module's `render()` method

## Gotchas

- **Token estimation is approximate**: 1 token ≈ 4 characters. Don't rely on exact counts.
- **Module ordering matters**: Modules at the top of the prompt have more influence on LLM behavior. Identity and security come first intentionally.
- **Bootstrap mode disables most modules**: Don't add critical runtime info to modules that skip in bootstrap mode without considering first-run scenarios.
- **`render()` returns `string[]`, not a single string**: Lines are joined with `\n` by the builder.
- **Workspace path is sanitized**: RuntimeModule strips the host username from paths. Never expose full paths in prompts.
- **`optional` defaults to `false`**: Modules without `optional = true` are never budget-dropped. Be conservative about marking things required.
- **`renderMinimal()` is a soft fallback**: The budget system tries minimal before dropping. If your module has a compressed form, implement it.
