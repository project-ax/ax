# Workflow

### Parallel subagents can reset the git branch and lose all work
**Date:** 2026-03-12
**Context:** Dispatched 3 parallel subagents to implement different phases of a storage architecture simplification. One agent reset the branch, destroying all committed work from the other agents.
**Lesson:** When dispatching multiple subagents that work on the same repo, either use git worktrees for isolation or dispatch them sequentially. A single comprehensive agent is safer than parallel agents for tightly-coupled changes in the same repo.
**Tags:** subagents, git, parallel, branch-reset

### npm 11.x requires complete lock file entries for ALL declared optional dependencies
**Date:** 2026-03-04
**Context:** CI (Node 24 / npm 11.x) failed on every PR with "Missing: sqlite-vec-linux-arm64@ from lock file". The upstream `sqlite-vec@0.1.6` declares `sqlite-vec-linux-arm64@0.1.6` as an optional dependency, but that version was never published to npm. Simply removing the broken stub worked on npm 10.x but not npm 11.x.
**Lesson:** npm 11.x cross-references every package's declared optionalDependencies against the lock file entries, even for non-matching platforms. If an optional dependency was never published, you need BOTH: (1) an `overrides` entry in package.json to map the non-existent version to an available one, and (2) a complete lock file entry with version/resolved/integrity. Just removing a broken stub is insufficient — npm 11.x will still look for the package because the parent declares it. Always test lock file fixes against the same npm version CI uses.
**Tags:** npm, npm-11, package-lock, optional-dependencies, overrides, ci, sqlite-vec

### Explicit `permissions` in GitHub Actions replaces ALL defaults — always include `contents: read`
**Date:** 2026-02-25
**Context:** GitHub Pages workflow had `permissions: { pages: write, id-token: write }` but `actions/checkout` silently failed because `contents: read` was missing
**Lesson:** When setting `permissions` at the workflow or job level in GitHub Actions, you override ALL default token permissions. Only the permissions you list are granted. `actions/checkout` needs `contents: read` to clone the repo. Always include it when using explicit permissions. The checkout step may fail silently or produce cryptic errors without it.
**Tags:** github-actions, permissions, pages, checkout, ci
