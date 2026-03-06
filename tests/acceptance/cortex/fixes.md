# Fix List: Cortex Memory Provider

**Generated from:** acceptance test results (2026-03-06)
**Total issues:** 5 (Critical: 1, Major: 2, Minor: 2)

## Critical

### FIX-1: Migration ordering bug — DbSummaryStore initDefaults() before migrations
**Test:** K8s deployment (crash-loop on startup)
**Environment:** K8s only
**Root cause:** Incorrect — initialization called before table exists
**Location:** `src/providers/memory/cortex/provider.ts:125-135`
**What's wrong:** `summaryStore.initDefaults()` was called before `runMigrations()`, so DbSummaryStore tried to INSERT into `cortex_summaries` before the table existed. Caused crash-loop in PostgreSQL deployments.
**What to fix:** Already fixed by k8s agent — moved migrations before summary store creation.
**Status:** FIXED (in working tree, uncommitted)

## Major

### FIX-2: DeepInfra embedding API key missing from k8s secrets
**Test:** BT-8, BT-9, BT-12, IT-7, IT-8 (all degraded/skipped in k8s)
**Environment:** K8s only
**Root cause:** Integration gap — k8s init doesn't provision embedding API key
**Location:** `src/cli/k8s-init.ts`, `tests/acceptance/fixtures/kind-values.yaml`
**What's wrong:** The `ax k8s init` command provisions the LLM provider API key but not the embedding provider key (DEEPINFRA_API_KEY). The kind-values.yaml references it in `apiCredentials.envVars` but the actual secret doesn't contain a valid value.
**What to fix:** Either: (a) add `--embedding-api-key` flag to `k8s init`, or (b) ensure the acceptance test skill passes DEEPINFRA_API_KEY from `.env.test` into the k8s secret during setup.
**Estimated scope:** 1-2 files
**Status:** DEFERRED — Requires `ax k8s init` CLI command (not yet implemented; see docs/plans/2026-03-06-k8s-presets-and-init-design.md)

### FIX-3: Taint not exposed in agent memory tool schema
**Test:** BT-6 (partial in k8s)
**Environment:** Both
**Root cause:** Incomplete — tool schema missing taint parameter
**Location:** `src/agent/tool-catalog.ts` or memory tool definition
**What's wrong:** The `memory_write` tool doesn't expose a `taint` parameter, so users can't set taint tags via the tool. Taint is only system-managed (set during memorize from conversation context).
**What to fix:** Evaluate whether taint should be user-settable via tools. If yes, add optional `taint` parameter to memory_write tool schema. If no (security decision), document this as intentional and update the test expectation.
**Estimated scope:** 1 file
**Status:** RESOLVED (intentional) — Taint is system-managed for security. The host-side `memory_write` IPC handler does not inject taint from tool params; taint is only set during `memorize()` from conversation context. Allowing agents to set their own trust tags would undermine the taint-tracking security model. The `write()` method on MemoryProvider accepts taint for internal/host-side use only.

## Minor

### FIX-4: query() does not reinforce accessed items (plan deviation DEV-1/DEV-4)
**Test:** ST-16-old, noted in both local and k8s results
**Environment:** Both
**Root cause:** Incomplete — plan feature not implemented
**Location:** `src/providers/memory/cortex/provider.ts` — `query()` and `read()` functions
**What's wrong:** The plan specifies that reading/querying items should increment their reinforcement count (boosting salience for frequently accessed items). Neither `query()` nor `read()` calls `store.reinforce()`.
**What to fix:** Add `store.reinforce(id)` calls in query/read paths after returning results. Consider making this async/non-blocking to avoid slowing reads. Alternatively, document as intentional deviation if read-path reinforcement was deliberately omitted.
**Estimated scope:** 1 file
**Status:** FIXED — Added fire-and-forget `store.reinforce()` calls in both read() and query() (embedding + keyword paths). Tests added in provider.test.ts verifying salience boost from repeated access.

### FIX-5: Explicit write() uses reinforcementCount=10 (plan deviation DEV-2)
**Test:** IT-3 (noted in both environments)
**Environment:** Both
**Root cause:** Incorrect — plan says initial reinforcement should be 1
**Location:** `src/providers/memory/cortex/provider.ts` — `write()` function
**What's wrong:** Explicit `write()` calls set `reinforcementCount: 10`, giving them 10x the salience weight of memorize-extracted items. The plan specifies initial count of 1.
**What to fix:** Evaluate whether this is intentional (explicit writes are "more important") or a bug. If intentional, document it. If not, change to `reinforcementCount: 1`.
**Estimated scope:** 1 file
**Status:** FIXED — Changed to `reinforcementCount: 1` per plan spec. With read-path reinforcement now implemented (FIX-4), frequently accessed items naturally gain salience over time without an artificial initial boost.

## Suggested Fix Order

1. **FIX-1** — Already fixed, just needs commit. Blocks k8s deployments.
2. **FIX-2** — Embedding API key provisioning. Unblocks 5 k8s tests and cross-session recall.
3. **FIX-3** — Taint exposure decision. Design question more than code fix.
4. **FIX-4** — Read-path reinforcement. Low risk, improves salience accuracy over time.
5. **FIX-5** — Write reinforcement count. May be intentional, needs design decision.
