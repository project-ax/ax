---
name: ax-provider-skills
description: Use when modifying skills store providers — readonly file access, git-backed proposal-review-commit workflow in src/providers/skills/
---

## Overview

The skills provider manages agent skill definitions (Markdown files). Supports a read-only mode for static skill sets and a proposal workflow for agent-initiated skill modifications with screening and approval gates.

## Interface

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
| `content` | string | yes      | Proposed new content            |
| `reason`  | string | no       | Why the change is needed       |

### ProposalResult

| Field     | Type   | Notes                                          |
|-----------|--------|-------------------------------------------------|
| `id`      | string | Unique proposal ID for approve/reject           |
| `verdict` | enum   | `AUTO_APPROVE`, `NEEDS_REVIEW`, or `REJECT`     |
| `reason`  | string | Explanation of verdict                           |

### SkillLogEntry

| Field       | Type   | Notes                                        |
|-------------|--------|----------------------------------------------|
| `id`        | string | Entry ID                                     |
| `skill`     | string | Skill name                                   |
| `action`    | enum   | `propose`, `approve`, `reject`, `revert`     |
| `timestamp` | Date   | When the action occurred                     |
| `reason`    | string | Optional context                             |

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

## Implementations

| Provider   | File          | Read | Write | Screen | Notes                                  |
|------------|---------------|------|-------|--------|----------------------------------------|
| `readonly` | `readonly.ts` | yes  | no    | no     | Lists/reads `.md` files from disk      |

## Proposal Workflow

1. Agent calls `propose({ skill, content, reason })`
2. Screener runs `screen(content, permissions)` -- returns `ScreeningVerdict`
3. Based on verdict: `AUTO_APPROVE` applies immediately, `NEEDS_REVIEW` queues for human, `REJECT` blocks with reason
4. Human calls `approve(id)` or `reject(id)` for pending proposals
5. `revert(commitId)` rolls back a previously applied change

## Common Tasks

- **Add a writable provider**: implement all `SkillStoreProvider` methods (readonly throws on `propose`/`approve`/`reject`/`revert`). Use `safePath()` for all file operations.
- **Add screening logic**: implement `SkillScreenerProvider.screen()`. Return `{ allowed: false, reasons: [...] }` to block dangerous content.
- **Query change history**: use `log({ since, limit })` to retrieve `SkillLogEntry` records.

## Gotchas

- **Readonly throws on writes**: `readonly.ts` throws `Error` on `propose()`, `approve()`, `reject()`, and `revert()`. Callers must handle this.
- **safePath required**: `readonly.ts` uses `safePath()` for all path construction -- any new provider must do the same (security invariant).
- **Default directory**: readonly provider hardcodes `skills/` as the skills directory, not configurable via config.
