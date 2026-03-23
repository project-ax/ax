## [2026-03-22 16:30] — Fix agent_response timeout race in k8s NATS mode

**Task:** Debug and fix the skill install + Linear API teams query sequence on the kind-ax cluster
**What I did:**
1. Diagnosed that `agentResponsePromise` timer started BEFORE `processCompletion` ran, causing timeout before sandbox spawn
2. Root cause: Guardian scanner LLM classification call took ~5 minutes, eating into the 3-minute agent_response timeout
3. Fix: Deferred timer start to AFTER work is published via NATS, so pre-processing (scanner, workspace mount, CA gen) doesn't eat the timeout budget
4. Added `startAgentResponseTimer` callback to `CompletionDeps`, called in `processCompletion` after `publishWork`
5. Verified MITM credential replacement works end-to-end (skill install → credential provide → Linear API call)
**Files touched:**
- `src/host/server-k8s.ts` — Deferred timer to callback, removed upfront setTimeout
- `src/host/server-completions.ts` — Added `startAgentResponseTimer` to CompletionDeps, call after publishWork
- `src/host/credential-placeholders.ts` — Temporary debug logging (removed)
**Outcome:** Success. Full sequence works: install skill → provide credential → list Linear teams (3 teams returned)
**Notes:** The guardian scanner with `llmAvailable: true` was the main bottleneck — its LLM classification call takes variable time. The previous timer started 180s before sandbox spawn, but processCompletion setup (including the scanner) can take minutes.
