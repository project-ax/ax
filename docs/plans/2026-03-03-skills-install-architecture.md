# Skills Import, Installation & Execution — Architecture & Implementation Plan

**Date:** 2026-03-03
**Status:** Draft
**Scope:** Replace structured `kind`/`package` installer taxonomy with raw `run` commands; define the full install lifecycle, host/agent boundary, and IPC commands.

---

## Context

AX skills currently use a structured `kind`/`package` taxonomy for installation (`kind: brew`, `kind: npm`, etc.), requiring AX to understand every package manager. This is unnecessary complexity — once a human approves a command, `run: npm install -g prettier` is simpler and more flexible than `kind: npm` + `package: prettier`. This plan replaces the taxonomy with raw `run` commands and defines the full install lifecycle: what runs where, what IPC commands are needed, and how approval works.

### Design Decisions

- **Agent-initiated install with host approval gate.** The agent can request installation via IPC, but the host always requires user approval before executing any command.
- **Load-time warning for `requires.bins`.** Missing binaries are flagged as warnings when the skill loads, but the skill is not blocked. The agent knows what's missing and can initiate install.

---

## 1. New SKILL.md Install Format

**Old (being replaced):**
```yaml
metadata:
  openclaw:
    install:
      - kind: brew
        formula: steipete/tap/gogcli
        bins: [gog]
      - kind: node
        package: mcporter
        bins: [mcporter]
```

**New:**
```yaml
metadata:
  openclaw:
    install:
      - run: "brew install steipete/tap/gogcli"
        label: "Install gog via Homebrew"
        check: "gog --version"
        os: [macos, linux]
      - run: "npm install -g mcporter"
        label: "Install mcporter via npm"
        check: "mcporter --version"
```

Each step:
- **`run`** (required): Shell command to execute on the host
- **`label`** (optional): Human-readable description for the approval prompt. Defaults to the `run` value
- **`check`** (optional): Command that exits 0 if this step can be skipped (dependency already installed)
- **`os`** (optional): Platform filter — `linux`, `macos`, `windows`

---

## 2. What Runs Where

```
┌──────────────────────────────────────────────────────────────┐
│                    AGENT (sandboxed)                          │
│                                                              │
│  - Reads skill content (skill_read)                          │
│  - Sees requires.bins warnings at load time                  │
│  - Calls skill_install(phase:'inspect') to check status      │
│  - Presents install steps to user for approval               │
│  - Calls skill_install(phase:'execute', stepIndex:N)         │
│  - CANNOT run install commands directly (no network)         │
│                                                              │
└─────────────────────────┬────────────────────────────────────┘
                          │ IPC (Unix socket)
┌─────────────────────────┴────────────────────────────────────┐
│                    HOST (trusted)                             │
│                                                              │
│  - Parses skill install steps from SKILL.md                  │
│  - Runs `check` commands to determine what's needed          │
│  - Executes approved `run` commands (has network, PATH)      │
│  - Persists install state to ~/.ax/data/skill-install-state/ │
│  - Audits every install action                               │
│  - Enforces timeout (5 min default per step)                 │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

**Key principle**: Install commands always run on the host (they need network for `npm install`, `brew install`, etc.). The agent can *request* installation, but the host executes it, and only after user approval through the conversation.

---

## 3. IPC Commands

### New actions

| Action | Purpose |
|--------|---------|
| `skill_install` | Two-phase: `inspect` (check what's needed) or `execute` (run one approved step) |
| `skill_install_status` | Query persisted install state for a skill |

### `skill_install` schema (`src/ipc-schemas.ts`)

```typescript
export const SkillInstallSchema = ipcAction('skill_install', {
  skill: safeString(200),
  phase: z.enum(['inspect', 'execute']),
  stepIndex: z.number().int().min(0).max(50).optional(),  // required for 'execute'
});

export const SkillInstallStatusSchema = ipcAction('skill_install_status', {
  skill: safeString(200),
});
```

### Existing actions (unchanged)

`skill_read`, `skill_list`, `skill_propose`, `skill_search` — no changes.

### Existing action (minor change)

`skill_import` — no schema change, but the manifest it generates uses the new `run`-based format internally.

---

## 4. Install Flow

### Two-phase design: inspect → execute

**Phase 1: Inspect** — agent calls `skill_install({ skill: "gog", phase: "inspect" })`

Host does:
1. Parse skill's install steps
2. Filter by current OS
3. Run each step's `check` command (and `which <bin>` for `requires.bins`)
4. Return step list with statuses: `needed` or `satisfied`

Response:
```json
{
  "skill": "gog",
  "status": "needs_install",
  "binChecks": [{ "bin": "gog", "found": false }],
  "steps": [
    {
      "index": 0,
      "run": "brew install steipete/tap/gogcli",
      "label": "Install gog via Homebrew",
      "status": "needed",
      "checkOutput": "command not found: gog"
    }
  ]
}
```

**Agent presents to user**:
> Skill 'gog' needs a dependency installed:
> 1. **Install gog via Homebrew** — `brew install steipete/tap/gogcli`
>
> Approve?

**Phase 2: Execute** — after user approves, agent calls `skill_install({ skill: "gog", phase: "execute", stepIndex: 0 })`

Host does:
1. Re-run check (defense in depth — may have been installed since inspect)
2. If check passes now → return `already_satisfied`, skip
3. Execute `run` command in subprocess with timeout
4. Run check again to verify success
5. Persist state, audit log
6. Return result with stdout/stderr, exit code, duration

**Why two-phase?** The agent needs to show the user exactly what will run BEFORE it runs. Each `execute` call handles one step. The agent controls the UX — it can present all steps at once or one at a time.

---

## 5. `requires.bins` Checking

**Timing**: Load-time warning (warn but don't block).

When the host builds the skill list for the agent's prompt (via `skill_list`), it checks `requires.bins` with `which`. Missing bins are included in the skill metadata as warnings. The skill still loads — the agent knows what's missing and can initiate install.

The `skill_install` inspect phase does the authoritative check on the host, where the PATH matches the install target.

---

## 6. Type Changes

### `src/providers/skills/types.ts`

**Replace** `AgentSkillInstaller`:

```typescript
// Remove AgentSkillInstaller

// Add:
export interface SkillInstallStep {
  run: string;
  label?: string;
  check?: string;
  os?: string[];
}
```

**Update** `ParsedAgentSkill.install` from `AgentSkillInstaller[]` → `SkillInstallStep[]`

**Update** `GeneratedManifest.install.steps` shape:

```typescript
install: {
  steps: Array<{
    run: string;
    label?: string;
    check?: string;
    os?: string[];
    approval: 'required';
  }>;
};
```

**Add** `SkillInstallState` for persisting install progress:

```typescript
export interface SkillInstallState {
  skillName: string;
  steps: Array<{
    run: string;
    status: 'pending' | 'skipped' | 'completed' | 'failed';
    updatedAt: string;
    output?: string;
    error?: string;
  }>;
  status: 'not_started' | 'in_progress' | 'completed' | 'partial' | 'failed';
  updatedAt: string;
}
```

---

## 7. Parser Changes — `src/utils/skill-format-parser.ts`

Replace `parseInstallSpecs()` with `parseInstallSteps()`. Include backward-compat conversion from old `kind`/`package` format:

```
kind: brew, formula: X   → run: "brew install X"
kind: node, package: X   → run: "npm install -g X"
kind: npm, package: X    → run: "npm install -g X"
kind: pip, package: X    → run: "pip install X"
kind: go, package: X     → run: "go install X@latest"
kind: cargo, package: X  → run: "cargo install X"
kind: uv, package: X     → run: "uv tool install X"
```

If old format had `bins: [foo]`, synthesize `check: "which foo"`.

---

## 8. Manifest Generator Changes — `src/utils/manifest-generator.ts`

Update install steps mapping from `kind`/`package`/`bins` to `run`/`label`/`check`/`os`.

---

## 9. Handler Changes — `src/host/ipc-handlers/skills.ts`

Add `skill_install` and `skill_install_status` to `createSkillsHandlers()`.

- `skill_install` inspect phase: parse skill, filter by OS, run checks, return step statuses
- `skill_install` execute phase: validate step index, re-run check, execute command via `execSync` with timeout, verify with post-check, persist state, audit
- `skill_install_status`: read persisted state from `~/.ax/data/skill-install-state/<skill>.json`

Install state persisted via JSON files (same pattern as other AX state — simple, debuggable).

---

## 10. Tool Catalog Changes — `src/agent/tool-catalog.ts`

Add `install` and `install_status` operations to the existing `skill` tool:

```typescript
Type.Object({
  type: Type.Literal('install'),
  name: Type.String(),
  phase: Type.String({ description: '"inspect" or "execute"' }),
  stepIndex: Type.Optional(Type.Number()),
}),
Type.Object({
  type: Type.Literal('install_status'),
  name: Type.String(),
}),
```

Add to `actionMap`:
```typescript
install: 'skill_install',
install_status: 'skill_install_status',
```

---

## 11. Security

- **Taint budget**: Add `skill_install` to sensitive actions in `src/host/taint-budget.ts`. Tainted sessions can't trigger installs.
- **Screening**: Extend screener to scan `run` fields for `curl | bash`, backtick subshells, `$(...)` patterns. Same hard-reject patterns as skill body.
- **Audit**: Every phase logged — `skill_install_inspect`, `skill_install_execute`, `skill_install_step`, `skill_install_skip`.
- **No agent-constructed commands**: Agent passes skill name + step index, never the command itself. Commands come from parsed SKILL.md on the host side.

---

## 12. Files to Change

| File | Change |
|------|--------|
| `src/providers/skills/types.ts` | Replace `AgentSkillInstaller` → `SkillInstallStep`, add `SkillInstallState`, update `ParsedAgentSkill` and `GeneratedManifest` |
| `src/utils/skill-format-parser.ts` | Replace `parseInstallSpecs` → `parseInstallSteps` with backward-compat |
| `src/utils/manifest-generator.ts` | Update install steps mapping |
| `src/ipc-schemas.ts` | Add `SkillInstallSchema`, `SkillInstallStatusSchema` |
| `src/host/ipc-handlers/skills.ts` | Add `skill_install` and `skill_install_status` handlers |
| `src/agent/tool-catalog.ts` | Add `install` and `install_status` to skill tool |
| `src/host/taint-budget.ts` | Add `skill_install` to sensitive actions |
| `tests/utils/skill-format-parser.test.ts` | Update for new format + backward-compat tests |
| `tests/utils/manifest-generator.test.ts` | Update for new manifest shape |
| `tests/host/ipc-handlers/skills-install.test.ts` | New test file for install handler |

---

## 13. Implementation Order

1. Types (`types.ts`)
2. Parser (`skill-format-parser.ts`) + tests
3. Manifest generator (`manifest-generator.ts`) + tests
4. IPC schemas (`ipc-schemas.ts`)
5. Handler (`skills.ts`) + tests
6. Tool catalog (`tool-catalog.ts`)
7. Taint budget (`taint-budget.ts`)
8. Full test suite pass

---

## 14. Verification

1. `npm test` — all existing tests pass (parser backward-compat ensures no breakage)
2. New parser tests: both old `kind`/`package` format and new `run` format parse correctly
3. New handler tests: inspect returns correct step statuses, execute runs commands and audits
4. Manual test: import a skill with install steps, call `skill_install` inspect, verify output
