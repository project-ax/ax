---
name: ax-provider-skills
description: Use when modifying skills store providers — readonly file access, git-backed skill proposals with screening & approval gates, AgentSkills format parsing, and manifest generation in src/providers/skills/
---

## Overview

The skills provider manages agent skill definitions (AgentSkills format SKILL.md files). Supports a read-only mode for static skill sets and a git-backed proposal workflow for agent-initiated skill modifications with multi-layer screening and approval gates. Includes AgentSkills format parsing, manifest generation, and ClawHub registry integration for external skill discovery.

## Core Types

### SkillMeta

| Field         | Type   | Required | Notes                       |
|---------------|--------|----------|-----------------------------|
| `name`        | string | yes      | Skill identifier (no `.md`) |
| `description` | string | no       | Human-readable summary      |
| `path`        | string | yes      | Resolved file path          |

### SkillProposal

| Field     | Type   | Required | Notes                          |
|-----------|--------|----------|--------------------------------|
| `skill`   | string | yes      | Target skill name              |
| `content` | string | yes      | Proposed new content (SKILL.md)|
| `reason`  | string | no       | Why the change is needed       |

### ProposalResult

| Field     | Type   | Notes                                          |
|-----------|--------|-------------------------------------------------|
| `id`      | string | Unique proposal ID for approve/reject           |
| `verdict` | enum   | `AUTO_APPROVE`, `NEEDS_REVIEW`, or `REJECT`     |
| `reason`  | string | Explanation of verdict                           |

### SkillStoreProvider

| Method                 | Description                                      |
|------------------------|--------------------------------------------------|
| `list()`               | Return all skill metadata                        |
| `read(name)`           | Return content of a skill by name                |
| `propose(proposal)`    | Submit a skill change; returns ProposalResult     |
| `approve(proposalId)`  | Accept a pending proposal                        |
| `reject(proposalId)`   | Reject a pending proposal                        |
| `revert(commitId)`     | Revert a previously applied change               |
| `log(opts?)`           | Return audit log; filterable by `limit`, `since` |

### SkillScreenerProvider

| Method                                    | Description                            |
|-------------------------------------------|----------------------------------------|
| `screen(content, declaredPermissions?)`   | Returns `ScreeningVerdict` with `allowed` boolean and `reasons` array |
| `screenExtended?(content, ...)?`          | Returns `ExtendedScreeningVerdict` with score, verdict, and detailed reasons |
| `screenBatch?(items)?`                    | Batch screening multiple skills        |

### AgentSkills Format Types

**ParsedAgentSkill** -- Parsed representation of a SKILL.md file:
- `name`, `description?`, `version?`, `license?`, `homepage?`
- `requires` -- `bins` (required host binaries), `env` (required env vars), `anyBins` (alternative binary options), `config` (config keys)
- `install` -- `AgentSkillInstaller[]` (kind: brew/npm/pip/go/cargo/uv, package, bins?, os?)
- `permissions` -- mapped from OpenClaw terms to AX IPC actions
- `body` -- markdown body text
- `codeBlocks` -- extracted code blocks

**GeneratedManifest** -- Auto-generated from ParsedAgentSkill via `manifestGenerator.generateManifest()`:
- Static analysis for host commands, env vars, domains, IPC tools, scripts
- Optional `hashExecutables()` adds SHA-256 to manifest entries

## Implementations

| Provider   | File          | Type      | Read | Write | Screen | Notes                                  |
|------------|---------------|-----------|------|-------|--------|----------------------------------------|
| `readonly` | `readonly.ts` | Store     | yes  | no    | no     | Lists/reads `.md` files from disk      |
| `git`      | `git.ts`      | Store     | yes  | yes   | yes    | Git-backed with proposals & audit log  |
| `none`     | `screener/none.ts` | Screener | --   | --     | yes    | No-op (always approve) for testing     |
| `static`   | `screener/static.ts` | Screener | --   | --     | yes    | 5-layer static analyzer with scoring   |

## Proposal Workflow

1. **Propose**: Agent calls `propose({ skill, content, reason })`
2. **Screen**: Provider runs `screen(content)` or `screenExtended(content)`
3. **Verdict**: `AUTO_APPROVE` -> immediate write & commit; `NEEDS_REVIEW` -> queued; `REJECT` -> blocked
4. **Manual**: Human calls `approve(id)` or `reject(id)` for pending proposals
5. **Revert**: `revert(commitId)` rolls back a previous change

## Static Screener (5 Layers)

| Layer | Type | Patterns |
|-------|------|----------|
| 1. Hard-Reject | BLOCK | exec(), spawn(), eval(), Function(), atob(), fetch() |
| 2. Exfiltration | FLAG (0.4) | URLs with data params, webhook.site, requestbin, ngrok |
| 3. Prompt Injection | FLAG (0.3) | HTML comment directives, zero-width chars, role reassignment |
| 4. External Deps | FLAG (0.2) | CDN scripts, external binary URLs, curl-pipe-to-shell |
| 5. Capability Mismatch | FLAG (0.15) | Undeclared fs.write, process.env, crypto, docker commands |

**Scoring**: Any BLOCK or score >= 0.8 -> REJECT; score >= 0.3 -> REVIEW; score < 0.3 -> APPROVE.

## Skill Format Parsing

`skillFormatParser.parseAgentSkill(raw)` converts SKILL.md into `ParsedAgentSkill`:
- Extracts YAML frontmatter, resolves `metadata.openclaw` (aliases: `clawdbot`, `clawdis`)
- Maps OpenClaw permissions to AX IPC actions (`full-disk-access` -> `workspace_write`, `web-access` -> `web_fetch`, etc.)
- Extracts code blocks and install specs

## ClawHub Registry Client

`src/clawhub/registry-client.ts` -- public skill discovery:
- `search(query)`, `fetchSkill(name)`, `listPopular()`, `listCached()`
- Cache TTL: 1 hour. All paths use `safePath()`.

## Directory Structure

Skills stored at `~/.ax/agents/<agentId>/agent/workspace/skills/`. Git store maintains commit history for revert and audit.

## Common Tasks

- **Add a writable provider**: Implement all `SkillStoreProvider` methods. Use `safePath()`.
- **Add screening logic**: Implement `SkillScreenerProvider.screen()` or `screenExtended()`.
- **Parse a SKILL.md**: Call `parseAgentSkill(raw)` for `ParsedAgentSkill`.
- **Generate a manifest**: Call `generateManifest(parsed)`, optionally `hashExecutables()`.
- **Search ClawHub**: Call `search(query)` or `listPopular()`.

## Gotchas

- **Readonly throws on writes**: Callers must handle.
- **safePath required**: Security invariant (SC-SEC-004) for all path construction.
- **Default directory**: Uses `agentSkillsDir(agentId)` from `src/paths.ts`.
- **Permission mapping**: OpenClaw names auto-mapped to AX IPC action names.
- **Hard-reject is non-negotiable**: Enforced regardless of declared permissions.
- **Score clamping**: Extended screening score clamped to [0, 1].
