## [2026-04-20 07:10] — Frontmatter schema check at commit time

**Task:** Fix silent-success on broken SKILL.md frontmatter. User reported agent saying "skill has been configured" when the frontmatter had Zod errors that only surfaced on the admin Skills tab — terrible UX.

**What I did:** Extended `validateCommit(diff, files?)` to parse frontmatter for `.ax/skills/*/SKILL.md` paths via the existing `parseSkillFile()` helper. Extended `ValidateCommitSchema` IPC with an optional `files: [{path, content}]` (up to 50 × 128KB). Extended `git-sidecar` to collect staged SKILL.md contents via `git show :<path>` and forward them. On rejection, sidecar writes a structured error block to stderr and propagates a `skillValidationError` field in `CommitResult` for runners to surface.

**Files touched:** src/host/validate-commit.ts, src/ipc-schemas.ts, src/host/ipc-server.ts, src/agent/git-sidecar.ts, tests/host/validate-commit.test.ts (+8 tests).

**Outcome:** Success. 20/20 validate-commit tests pass, 224/224 in the focus batch, full suite has same 34 pre-existing failures (macOS socket path + sandbox-isolation test).

**Notes:** The agent-side LLM still doesn't see `skillValidationError` until the runner wires it into turn results — that's a separate architectural PR. This fix gets us: (1) errors caught at commit time, not load time; (2) structured stderr block in pod logs; (3) reason field plumbed through to runner. Enough for users to diagnose from logs and for a follow-up to surface it to the LLM.
EOF3

ls -la .claude/journal/host/validate-commit.md 2>&1 | head -2
## [2026-04-20 07:20] — Inline SKILL.md validation in write_file + edit_file

**Task:** Continuation of commit-time validation — now reject invalid SKILL.md at WRITE time so the LLM sees the error in its immediate tool result and can fix on the same turn.

**What I did:** Added `SKILL_MD_RE` + `parseSkillFile` check to `sandbox_write_file` and `sandbox_edit_file` in `src/host/ipc-handlers/sandbox-tools.ts`. Write-time: check content before writing, return `{error: "..."}` and do NOT write if schema fails. Edit-time: compute the post-edit content, check, return error without writing if post-edit content is invalid.

**Files touched:** src/host/ipc-handlers/sandbox-tools.ts, tests/host/ipc-handlers/sandbox-tools.test.ts (+7 tests).

**Outcome:** Success. 65/65 focused tests pass. Full suite: 2828 pass (+7 from prior), 34 pre-existing failures unchanged.

**Notes:** This is the UX fix the user asked for — "agent automatically realizes there is an error in its front matter and fix it". Now the LLM's `write_file` tool result includes the schema error. Defense-in-depth with the commit-time check — three layers: inline (write/edit), commit (validate_commit), load-time (skill loader). Each layer catches things the previous one missed (bash-shell-writes bypass inline; file moves bypass commit; dynamic generation bypasses both).
