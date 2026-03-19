# Filesystem-Based Skills & User-Scoped Binaries

**Date:** 2026-03-18
**Status:** Draft

## Summary

Replace the database-backed skill store and IPC skill tools with a filesystem-based approach. Skills become plain markdown files in workspace directories, binaries are installed directly in the sandbox pod, and the host screens everything at workspace release time before persisting to GCS. This enables user-scoped skills (only visible to the installing user) with minimal new infrastructure.

## Motivation

- Users need to install skills via DM or web chat that are only available to them (not other users)
- The current architecture requires a complex IPC tool surface (`skill_read`, `skill_list`, `skill_propose`, `skill_import`, `skill_install` with two-phase inspect/execute) and a database-backed `SkillStoreProvider`
- Skills are fundamentally just files — storing them in a database and proxying access through IPC adds complexity without clear benefit
- Binary installation currently runs on the host (with command allowlisting, environment scrubbing, concurrency control) but these controls were designed for host-side execution; in-sandbox execution is already blast-radius-contained

## Design

### Filesystem Layout

Skills and binaries live in the existing workspace scopes, which already persist to GCS and are provisioned into pods at startup:

```
/workspace/
├── agent/                    # agent-scoped (shared, read-only for non-admin)
│   ├── skills/               # agent-level skills (.md files, subdirs with SKILL.md)
│   ├── bin/                  # agent-level binaries
│   └── identity/             # (existing) SOUL.md, IDENTITY.md
├── user/                     # user-scoped (private, read-write)
│   ├── skills/               # user-level skills
│   └── bin/                  # user-level binaries
└── scratch/                  # session workspace (existing)
```

**PATH:** Prepend `user/bin:agent/bin` to the agent's PATH during pod setup (in `canonical-paths.ts` / `canonicalEnv()`). User bin takes precedence over agent bin, matching the existing user-shadows-agent pattern.

**Skill discovery:** `loadSkills()` is called twice at startup — once for `agent/skills/`, once for `user/skills/`. Results merged with user taking precedence (same name = user wins). Replaces the stdin payload approach.

**Scoping:** Admin users can write to `agent/skills/` and `agent/bin/` (shared). Regular users can only write to `user/skills/` and `user/bin/` (private). Matches the existing workspace permission model.

### What Gets Removed

**Database storage:** `SkillStoreProvider` interface and `database.ts` implementation deleted. The `skills` DocumentStore collection is abandoned (no migration needed).

**IPC tools removed:**

| Tool | Replacement |
|------|-------------|
| `skill_read` | Agent reads files directly from `*/skills/` |
| `skill_list` | Agent reads `user/skills/` and `agent/skills/` directories |
| `skill_propose` | Agent writes `.md` file directly to `user/skills/` |
| `skill_import` | Agent fetches from ClawHub via web proxy, writes to `user/skills/` |
| `skill_install` (both phases) | Agent runs install commands directly in sandbox |
| `skill_install_status` | No longer needed |

**IPC tools kept:**
- `skill_search` — searches ClawHub/private registries (requires host-side API keys)

**Host-side code removed:**
- `src/host/ipc-handlers/skills.ts` — gutted to just `skill_search` + `audit_query`
- `src/utils/install-validator.ts` — command allowlisting no longer needed (sandbox-contained)
- `src/providers/skills/` — entire directory deleted
- Skill-related entries in `src/host/provider-map.ts` and `ProviderRegistry`

**Agent-side changes:**
- `tool-catalog.ts` — skill action map reduced to just `search`
- `mcp-server.ts` — skill MCP tools reduced
- Stdin payload no longer includes `skills` array
- `agent-setup.ts` — reads from filesystem instead of stdin payload

### Skill Lifecycle

**Creating a skill:** Agent writes a `.md` file directly to `user/skills/my-skill.md` (or a subdirectory `user/skills/deploy/SKILL.md`). Available to the agent on the next session after workspace release. Within the current session, the agent already has the content in context.

**Importing from ClawHub:**
1. Agent calls `skill_search` to find skills (host-side, uses API keys)
2. Agent fetches the skill content via web proxy (HTTP GET, domain-approved, audited)
3. Agent writes the `.md` file to `user/skills/`
4. If the skill declares binary dependencies in frontmatter, agent runs install commands directly (e.g., `npm install -g`, `pip install`)
5. Agent moves/copies the resulting binary to `user/bin/`

**Installing binaries:** Agent runs package manager commands or downloads binaries directly — all through the HTTP proxy (which enforces domain approval, SSRF protection, canary scanning, and full audit logging). No command allowlisting needed since execution is sandbox-contained. Binary ends up in `user/bin/` (which is in PATH).

### Runner Changes

**Skill discovery at startup:**
- `loadSkills()` in `stream-utils.ts` called for both `agent/skills/` and `user/skills/`
- Results merged: user skills shadow agent skills with the same name
- Summaries injected into system prompt as today (name + description table)
- Full content: agent reads the file directly (no IPC round-trip)

**pi-coding-agent runner:**
- No longer receives skills via stdin payload
- `agent-setup.ts` calls `loadSkills()` on workspace directories instead of mapping `config.skills`
- The `skill` tool in the tool catalog reduced to just `search`
- Agent uses its native file read/write tools for all other skill operations

**claude-code runner:**
- Already disallows the `Skill` tool — becomes a non-issue since almost nothing left in it
- Skills discovered from the filesystem at prompt build time
- Claude Code's native `Read`/`Write`/`Bash` tools handle skill creation, import, and binary installation
- `skill_search` exposed via MCP server for ClawHub discovery

**Prompt module (`skills.ts`):**
- "Creating Skills" section updated: tells agent to write files to `user/skills/` instead of using `skill({ type: "propose" })`
- "Missing Dependencies" section updated: tells agent to install directly instead of two-phase install flow
- `skill({ type: "read" })` guidance replaced with "read the file at `user/skills/<name>.md`"

### Host-Side Release Screening

**When:** During workspace release, after receiving `staging.tar.gz`, before GCS commit.

**Skill content screening:**
1. Scan diff for new/modified `*.md` files under `*/skills/`
2. Parse with `parseAgentSkill()`, run screener provider (`screenExtended`)
3. If rejected: strip from GCS commit, log to audit with reasons

**Binary screening:**
1. Scan diff for new/modified files under `*/bin/`
2. Size limit check (configurable, e.g., 100MB default)
3. Query `providers.audit.query({ action: 'proxy_request', sessionId })` to get all URLs accessed during the session
4. Validate that binary downloads came from approved domains
5. If no provenance match or size exceeded: strip from GCS commit, log to audit

**Rejected files** don't persist to GCS — they worked in the current (sandbox-contained) session but won't reach future sessions.

## Security Analysis

### Same-session safety

A skill created mid-session cannot enter the system prompt within the same session:
- **Subprocess:** system prompt built once at session start
- **K8s/NATS:** each turn could be a new pod, but provisions from GCS (which hasn't been updated yet)

Within the same turn, the agent already has skill content in its context window (it wrote/fetched it). Creating a file doesn't grant additional capabilities.

### Binary installation in sandbox

The current `install-validator.ts` controls (command prefix allowlist, privilege escalation blocking, shell operator blocking, environment scrubbing, concurrency semaphore) were designed for host-side execution. In-sandbox execution is already blast-radius-contained — the agent can run arbitrary commands regardless.

### Persistence protection

The host-side release screening is the checkpoint that prevents malicious skills/binaries from persisting:
- Skill content screened before GCS write
- Binary provenance validated via proxy audit log
- Rejected files stripped from GCS commit

### Proxy as network boundary

All downloads go through the host's HTTP proxy, which enforces:
- Domain approval gate (host can approve/deny)
- SSRF protection (blocks private IPs, cloud metadata endpoints)
- Canary token scanning (exfiltration prevention)
- Full audit logging (method, URL, bytes, status)

## Future Enhancements

- Hash-based binary allowlist from ClawHub (known-good binaries)
- Signature verification for binaries
- Mid-session prompt rebuilding with screening checkpoint
- Periodic re-scanning of persisted skills/binaries in GCS
